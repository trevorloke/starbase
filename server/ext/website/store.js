// The store: prices, stock and orders, always worked out here — the
// browser's cart only names products, sizes and how many. Card payment is
// Stripe Checkout with inline prices (price_data), so nothing has to be set
// up product by product in Stripe; the webhook marks the order paid.
//
//   priceCart        cart lines → server prices, stock checks, totals
//   checkoutParams   the Stripe Checkout Session for an order
//   applyStorePayment  checkout.session.completed → order paid, stock down,
//                      buyer matched into People (tag 'store'); once per order
//   expireStoreOrder checkout.session.expired → the unpaid order is cancelled
import { parseJ } from './content.js';

export const LINE_MAX_QTY = 20;
export const CART_MAX_LINES = 30;
export const ORDER_STATUSES = ['pending', 'paid', 'packed', 'shipped', 'picked_up', 'refunded', 'cancelled'];
// Statuses whose items have come out of stock (paid and after).
export const STOCK_OUT = new Set(['paid', 'packed', 'shipped', 'picked_up']);

export const productRow = (p) => ({
  ...p,
  images: parseJ(p.images, []),
  variants: parseJ(p.variants, []),
});

// How many are left of a product (and size). null: not counted.
export const leftOf = (p, variant) => {
  if (!p.track_stock) return null;
  if (p.variants.length) {
    const v = p.variants.find((x) => x.label === variant);
    return v ? Math.max(0, Number(v.stock) || 0) : 0;
  }
  return Math.max(0, Number(p.stock) || 0);
};

// items: [{ product_id, variant, qty }] → { lines, subtotal_cents, problems }.
// Same product and size twice is one line. Never trusts a price or a count
// from the browser.
export const priceCart = async (db, ws, items) => {
  const merged = new Map();
  for (const it of (Array.isArray(items) ? items : []).slice(0, CART_MAX_LINES)) {
    const id = String(it?.product_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    const variant = typeof it.variant === 'string' ? it.variant.slice(0, 40) : '';
    const qty = Math.floor(Number(it.qty));
    if (!Number.isFinite(qty) || qty < 1) continue;
    const key = `${id}|${variant}`;
    merged.set(key, { product_id: id, variant, qty: Math.min((merged.get(key)?.qty || 0) + qty, LINE_MAX_QTY) });
  }
  const ids = [...new Set([...merged.values()].map((m) => m.product_id))];
  const products = new Map(ids.length ? (await db.query(
    `select * from store_products where workspace_id = $1 and deleted_at is null
       and id in (select (jsonb_array_elements_text($2::jsonb))::uuid)`,
    [ws.id, JSON.stringify(ids)],
  )).rows.map((p) => [p.id, productRow(p)]) : []);
  const lines = [];
  const problems = [];
  for (const m of merged.values()) {
    const p = products.get(m.product_id);
    if (!p || !p.active) { problems.push({ product_id: m.product_id, variant: m.variant, error: 'no longer for sale' }); continue; }
    if (p.variants.length && !p.variants.some((v) => v.label === m.variant)) {
      problems.push({ product_id: p.id, name: p.name, variant: m.variant, error: 'pick a size' });
      continue;
    }
    const variant = p.variants.length ? m.variant : '';
    const left = leftOf(p, variant);
    const line = {
      product_id: p.id, slug: p.slug, name: p.name, variant, qty: m.qty,
      unit_cents: p.price_cents, line_cents: p.price_cents * m.qty, image: p.images[0] || null, left,
    };
    if (left !== null && left < m.qty) {
      problems.push({ product_id: p.id, name: p.name, variant, error: left === 0 ? 'sold out' : `only ${left} left`, left });
    }
    lines.push(line);
  }
  return { lines, subtotal_cents: lines.reduce((a, l) => a + l.line_cents, 0), problems };
};

export const lineName = (l) => (l.variant ? `${l.name} (${l.variant})` : l.name);

// The Checkout Session form fields (lib/stripe.js posts them).
export const checkoutParams = ({ order, ws, settings, successUrl, cancelUrl, imageUrl }) => {
  const metadata = { store_order: order.id, workspace_id: ws.id };
  return {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: order.id,
    metadata,
    payment_intent_data: { metadata, description: `${settings.site_title} store order` },
    phone_number_collection: { enabled: true },
    line_items: order.items.map((l) => ({
      quantity: l.qty,
      price_data: {
        currency: 'cad',
        unit_amount: l.unit_cents,
        product_data: {
          name: lineName(l),
          ...(imageUrl && l.image ? { images: [imageUrl(l.image)] } : {}),
        },
      },
    })),
    ...(order.fulfilment === 'ship' ? {
      shipping_address_collection: { allowed_countries: ['CA'] },
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: 'Shipping',
          fixed_amount: { amount: order.shipping_cents, currency: 'cad' },
        },
      }],
    } : {}),
  };
};

// Take items out of stock (sign -1) or put them back (+1), under the row
// lock. Never below zero; returns the lines that were short (oversold).
export const moveStock = async (tx, wsId, items, sign) => {
  const short = [];
  for (const it of items) {
    const p = (await tx.query(
      'select * from store_products where id = $1 and workspace_id = $2 for update', [it.product_id, wsId],
    )).rows[0];
    if (!p || !p.track_stock) continue;
    const variants = parseJ(p.variants, []);
    if (variants.length) {
      const v = variants.find((x) => x.label === it.variant);
      if (!v) continue;
      const before = Number(v.stock) || 0;
      if (sign < 0 && before < it.qty) short.push(it);
      v.stock = Math.max(0, before + sign * it.qty);
      await tx.query('update store_products set variants = $2, updated_at = now() where id = $1', [p.id, JSON.stringify(variants)]);
    } else {
      const before = Number(p.stock) || 0;
      if (sign < 0 && before < it.qty) short.push(it);
      await tx.query('update store_products set stock = $2, updated_at = now() where id = $1', [p.id, Math.max(0, before + sign * it.qty)]);
    }
  }
  return short;
};

// Stripe changed where a session keeps the shipping address (2024+:
// collected_information.shipping_details); read either.
const shippingOf = (obj) => obj.collected_information?.shipping_details || obj.shipping_details || obj.shipping || null;
const addressLine = (a) => (a ? [a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(', ') : '');

// checkout.session.completed for a store order, inside the webhook's action
// (the caller has already claimed the Stripe event id, so a retry never
// reaches here). The order is paid once: only a pending order moves.
export const applyStorePayment = async (tx, emit, ws, obj, { upsertPersonTx }) => {
  const orderId = obj.metadata?.store_order;
  const order = (await tx.query(
    'select * from store_orders where id = $1 and workspace_id = $2 for update', [orderId, ws.id],
  )).rows[0];
  if (!order) return { ignored: 'unknown order' };
  if (order.status !== 'pending') return { already: order.status };
  if (obj.payment_status !== 'paid') return { ignored: `payment ${obj.payment_status}` };
  const items = parseJ(order.items, []);
  const cust = obj.customer_details || {};
  const ship = shippingOf(obj);
  const name = (ship?.name || cust.name || '').slice(0, 200) || null;
  const email = (cust.email || obj.customer_email || '').toLowerCase().slice(0, 320) || null;
  const phone = (cust.phone || '').slice(0, 40) || null;
  const address = ship?.address || null;
  const paid = Number(obj.amount_total);
  const short = await moveStock(tx, ws.id, items, -1);
  const notes = [];
  if (short.length) notes.push(`Oversold: ${short.map(lineName).join(', ')}`);
  if (Number.isFinite(paid) && paid !== order.total_cents) notes.push(`Stripe charged ${paid} cents, order says ${order.total_cents}`);
  // The buyer in People, matched by email like every public signup.
  let personId = null;
  if (name || email) {
    const person = await upsertPersonTx(tx, emit, ws, {
      name: name || email, email, phone, address: addressLine(address) || null,
    }, ['store']);
    personId = person.id;
  }
  await tx.query(
    `update store_orders set status = 'paid', paid_cents = $3, buyer_name = $4, email = $5, phone = $6,
       ship_address = $7, person_id = $8, payment_intent = $9, note = $10, paid_at = now(), updated_at = now()
     where id = $1 and workspace_id = $2`,
    [order.id, ws.id, Number.isFinite(paid) ? paid : order.total_cents, name, email, phone,
     address ? JSON.stringify({ name: ship?.name || null, ...address }) : null, personId,
     obj.payment_intent || null, notes.join(' · ') || null],
  );
  emit('store_order', order.id, 'update', {
    status: 'paid', paid_cents: Number.isFinite(paid) ? paid : order.total_cents, person_id: personId,
    stripe_session_id: obj.id, items: items.map((l) => ({ product_id: l.product_id, variant: l.variant, qty: l.qty })),
    ...(short.length ? { oversold: short.map((l) => ({ product_id: l.product_id, variant: l.variant, qty: l.qty })) } : {}),
  });
  return { order_id: order.id, status: 'paid', oversold: short.length > 0 };
};

export const expireStoreOrder = async (tx, emit, ws, obj) => {
  const n = await tx.query(
    `update store_orders set status = 'cancelled', note = 'Checkout not finished', updated_at = now()
     where id = $1 and workspace_id = $2 and status = 'pending'`,
    [obj.metadata?.store_order, ws.id],
  );
  if (n.affectedRows > 0) emit('store_order', obj.metadata.store_order, 'update', { status: 'cancelled', reason: 'checkout expired' });
  return { expired: n.affectedRows > 0 };
};
