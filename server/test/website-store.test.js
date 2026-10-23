// The website's store: prices and stock are always worked out on the server,
// checkout is a Stripe Checkout Session with inline prices (fetch mocked —
// nothing reaches Stripe), the webhook pays an order once however often
// Stripe retries, and without Stripe the store says it opens soon.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.store.${tag}@example.org`;
let mgr, vol, treas, wsId, tee, mug;

let ipN = 0;
const pub = async (method, path, body, headers = {}) => {
  ipN += 1;
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${ipN % 250}`, ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, json: ct.includes('json') ? await res.json() : null, text: ct.includes('json') ? '' : await res.text() };
};
const sign = (body, secret) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
};
const hook = (evt) => {
  const body = JSON.stringify(evt);
  return pub('POST', '/api/public/stripe/webhook', body, { 'stripe-signature': sign(body, 'whsec_store') });
};
const joinAs = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: mail(name), role });
  const cl = new Client();
  const j = await cl.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'store-pass-2026' });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  return cl;
};
const product = async (id) => (await mgr.get(`/api/store/products/${id}`)).json.product;

// Stripe, mocked: every Checkout Session request is kept for the asserts.
const sent = [];
const realFetch = globalThis.fetch;
const mockStripe = () => {
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://api.stripe.com/v1/checkout/sessions') {
      sent.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ id: `cs_store_${tag}_${sent.length}`, url: `https://checkout.stripe.test/s/${sent.length}` }), { status: 200 });
    }
    return realFetch(url, init);
  };
};

before(async () => {
  await freshDb();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Imagine Surrey', email: mail('manager'), jurisdiction: 'bc-municipal' });
  wsId = r.json.workspace.id;
  vol = await joinAs('volunteer', 'vol');
  treas = await joinAs('treasurer', 'treas');
  await mgr.get('/api/site/overview');
  tee = (await mgr.action('store.product.save', {
    name: 'Campaign T-shirt', price_cents: 2500, description: 'Soft **cotton**.', track_stock: true,
    variants: [{ label: 'S', stock: 2 }, { label: 'M', stock: 0 }, { label: 'L', stock: 5 }],
  })).json.product;
  mug = (await mgr.action('store.product.save', { name: 'Mug', price_cents: 1500, track_stock: true, stock: 1 })).json.product;
  await mgr.action('site.settings.save', { shipping: true, shipping_cents: 1200, pickup: true, pickup_note: 'Free · at the office' });
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

test('products: sizes with their own stock; desk-only; the slug comes from the name; volunteers refused', async () => {
  assert.equal(tee.slug, 'campaign-t-shirt');
  assert.deepEqual(tee.variants, [{ label: 'S', stock: 2 }, { label: 'M', stock: 0 }, { label: 'L', stock: 5 }]);
  assert.equal((await mgr.action('store.product.save', { name: 'x', price_cents: 10 })).status, 400, 'at least 50 cents');
  assert.equal((await mgr.action('store.product.save', { name: 'Dup', price_cents: 900, variants: [{ label: 'S' }, { label: 's' }] })).status, 400);
  assert.equal((await vol.get('/api/store/products')).status, 403);
  assert.equal((await vol.action('store.product.save', { name: 'x', price_cents: 1000 })).status, 403);
});

test('Stripe not set up: the store shows its items, checkout says it opens soon, the admin is told what to set', async () => {
  const grid = await pub('GET', '/site/store');
  assert.equal(grid.status, 200);
  assert.match(grid.text, /Campaign T-shirt/);
  assert.match(grid.text, /\$25/);
  const pd = await pub('GET', '/site/store/campaign-t-shirt');
  assert.match(pd.text, /Online store opens soon\./);
  assert.match(pd.text, /<input type="radio" name="variant" value="M" disabled>/, 'a sold-out size can’t be picked');
  assert.match(pd.text, /Soft <strong>cotton<\/strong>\./);
  const co = await pub('POST', '/site/store/checkout', { items: [{ product_id: tee.id, variant: 'L', qty: 1 }], fulfilment: 'pickup' });
  assert.equal(co.status, 503);
  assert.equal(co.json.error, 'Online store opens soon.');
  const ov = (await mgr.get('/api/site/overview')).json;
  assert.deepEqual(ov.stripe, { configured: false, webhook: false });
  assert.equal((await mgr.get('/api/store/orders?status=all')).json.orders.length, 0);
});

test('quote: prices and stock come from the server, never the browser', async () => {
  const q = await pub('POST', '/site/store/quote', { items: [
    { product_id: tee.id, variant: 'L', qty: 2, unit_cents: 1, price: 1 },
    { product_id: tee.id, variant: 'L', qty: 1 },
    { product_id: tee.id, variant: 'M', qty: 1 },
    { product_id: mug.id, variant: 'ignored', qty: 99 },
  ] });
  assert.equal(q.status, 200);
  const l = q.json.lines.find((x) => x.variant === 'L');
  assert.equal(l.qty, 3, 'the same size twice is one line');
  assert.equal(l.unit_cents, 2500);
  assert.equal(l.line_cents, 7500);
  const m = q.json.lines.find((x) => x.product_id === mug.id);
  assert.equal(m.qty, 20, 'at most 20 of a line');
  assert.equal(m.variant, '');
  assert.deepEqual(q.json.problems.map((p) => [p.variant, p.error]), [['M', 'sold out'], ['', 'only 1 left']]);
  assert.deepEqual(q.json.ways.map((w) => [w.code, w.cents]), [['ship', 1200], ['pickup', 0]]);
});

test('checkout: refuses sold-out lines, then opens Stripe Checkout with server prices, shipping and the order’s id', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_store';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_store';
  mockStripe();
  const out = await pub('POST', '/site/store/checkout', { items: [{ product_id: tee.id, variant: 'M', qty: 1 }], fulfilment: 'ship' });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /Campaign T-shirt \(M\): sold out/);
  const tooMany = await pub('POST', '/site/store/checkout', { items: [{ product_id: mug.id, qty: 2 }], fulfilment: 'ship' });
  assert.equal(tooMany.status, 409);
  assert.equal((await pub('POST', '/site/store/checkout', { items: [], fulfilment: 'ship' })).status, 400);
  assert.equal((await pub('POST', '/site/store/checkout', { items: [{ product_id: mug.id, qty: 1 }], fulfilment: 'teleport' })).status, 400);
  assert.equal(sent.length, 0, 'nothing went to Stripe');

  const co = await pub('POST', '/site/store/checkout', {
    items: [{ product_id: tee.id, variant: 'S', qty: 2, unit_cents: 1 }, { product_id: mug.id, qty: 1 }], fulfilment: 'ship', total_cents: 5,
  });
  assert.equal(co.status, 200, JSON.stringify(co.json));
  assert.equal(co.json.url, 'https://checkout.stripe.test/s/1');
  const f = sent[0];
  assert.equal(f.get('mode'), 'payment');
  assert.equal(f.get('line_items[0][price_data][currency]'), 'cad');
  assert.equal(f.get('line_items[0][price_data][unit_amount]'), '2500');
  assert.equal(f.get('line_items[0][price_data][product_data][name]'), 'Campaign T-shirt (S)');
  assert.equal(f.get('line_items[0][quantity]'), '2');
  assert.equal(f.get('line_items[1][price_data][unit_amount]'), '1500');
  assert.equal(f.get('shipping_address_collection[allowed_countries][0]'), 'CA');
  assert.equal(f.get('shipping_options[0][shipping_rate_data][fixed_amount][amount]'), '1200');
  assert.equal(f.get('metadata[store_order]'), co.json.order_id);
  assert.equal(f.get('metadata[workspace_id]'), wsId);
  assert.equal(f.get('payment_intent_data[metadata][store_order]'), co.json.order_id);
  assert.equal(f.get('success_url'), `http://localhost/site/store/thanks?order=${co.json.order_id}`);
  assert.equal(f.get('cancel_url'), 'http://localhost/site/cart');

  const pickup = await pub('POST', '/site/store/checkout', { items: [{ product_id: tee.id, variant: 'L', qty: 1 }], fulfilment: 'pickup' });
  assert.equal(pickup.status, 200);
  assert.equal(sent[1].get('shipping_address_collection[allowed_countries][0]'), null, 'pick-up asks no address');
  assert.equal(sent[1].get('shipping_options[0][shipping_rate_data][type]'), null);

  // Unpaid orders wait under "Not paid"; nothing has left the shelf yet.
  const unpaid = (await mgr.get('/api/store/orders?status=unpaid')).json.orders;
  const o = unpaid.find((x) => x.id === co.json.order_id);
  assert.equal(o.status, 'pending');
  assert.equal(o.total_cents, 2 * 2500 + 1500 + 1200);
  assert.equal((await product(tee.id)).variants[0].stock, 2);
});

test('webhook: paid once (retries and repeat events change nothing), stock comes down, the buyer lands in People', async () => {
  const orderId = (await mgr.get('/api/store/orders?status=unpaid')).json.orders.find((x) => x.fulfilment === 'ship').id;
  const session = {
    id: `cs_store_${tag}_1`, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: 7700, payment_intent: 'pi_store',
    customer_details: { email: mail('Buyer'), name: 'Bea Buyer', phone: '+16045550100' },
    collected_information: { shipping_details: { name: 'Bea Buyer', address: { line1: '1 Main St', city: 'Surrey', state: 'BC', postal_code: 'V3T 1A1', country: 'CA' } } },
    metadata: { store_order: orderId, workspace_id: wsId },
  };
  const evt = { id: `evt_store_${tag}_1`, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), data: { object: session } };
  const unsigned = await pub('POST', '/api/public/stripe/webhook', JSON.stringify(evt), { 'stripe-signature': 't=1,v1=00' });
  assert.equal(unsigned.status, 400, 'an unsigned call is refused');

  const first = await hook(evt);
  assert.equal(first.status, 200);
  assert.equal(first.json.status, 'paid');
  assert.equal((await hook(evt)).json.duplicate, true, 'the same delivery again');
  const again = await hook({ ...evt, id: `evt_store_${tag}_1b` });
  assert.equal(again.json.already, 'paid', 'another event for the same paid order');
  const t = await product(tee.id);
  assert.equal(t.variants.find((v) => v.label === 'S').stock, 0, '2 − 2, once');
  assert.equal(t.variants.find((v) => v.label === 'L').stock, 5);
  assert.equal((await product(mug.id)).stock, 0);

  const order = (await mgr.get('/api/store/orders')).json.orders.find((x) => x.id === orderId);
  assert.equal(order.status, 'paid');
  assert.equal(order.paid_cents, 7700);
  assert.equal(order.buyer_name, 'Bea Buyer');
  assert.equal(order.ship_address.city, 'Surrey');
  assert.ok(order.person_id);
  const people = (await mgr.get('/api/persons?tag=store')).json.persons;
  assert.equal(people.length, 1);
  assert.equal(people[0].email, mail('buyer'));
  assert.match(people[0].address, /1 Main St, Surrey/);

  // Sold out now: the shop says so and checkout refuses it.
  assert.match((await pub('GET', '/site/store')).text, /Sold out/);
  const co = await pub('POST', '/site/store/checkout', { items: [{ product_id: mug.id, qty: 1 }], fulfilment: 'pickup' });
  assert.equal(co.status, 409);
  assert.match(co.json.error, /sold out/);
});

test('webhook: an abandoned checkout cancels its unpaid order; events that aren’t ours are ignored', async () => {
  const orderId = (await mgr.get('/api/store/orders?status=unpaid')).json.orders.find((x) => x.status === 'pending').id;
  const r = await hook({ id: `evt_store_${tag}_x`, type: 'checkout.session.expired', data: { object: { id: 'cs_x', metadata: { store_order: orderId, workspace_id: wsId } } } });
  assert.equal(r.json.expired, true);
  const o = (await mgr.get('/api/store/orders?status=unpaid')).json.orders.find((x) => x.id === orderId);
  assert.equal(o.status, 'cancelled');
  assert.equal((await product(tee.id)).variants.find((v) => v.label === 'L').stock, 5, 'stock untouched');
  const odd = await hook({ id: `evt_store_${tag}_y`, type: 'charge.refunded', data: { object: { id: 'ch', metadata: { store_order: orderId, workspace_id: wsId } } } });
  assert.equal(odd.json.ignored, 'charge.refunded');
});

test('orders: the desk moves them along; a refund can put items back; treasurers read, volunteers can’t', async () => {
  const order = (await mgr.get('/api/store/orders')).json.orders[0];
  assert.equal((await treas.get('/api/store/orders')).json.orders[0].id, order.id);
  assert.equal((await treas.action('store.order.update', { id: order.id, status: 'packed' })).status, 403);
  assert.equal((await vol.get('/api/store/orders')).status, 403);
  assert.equal((await mgr.action('store.order.update', { id: order.id, status: 'packed' })).status, 200);
  assert.equal((await mgr.action('store.order.update', { id: order.id, status: 'pending' })).status, 400);
  const refund = await mgr.action('store.order.update', { id: order.id, status: 'refunded', restock: true });
  assert.equal(refund.status, 200);
  assert.equal(refund.json.restocked, true);
  assert.equal((await product(tee.id)).variants.find((v) => v.label === 'S').stock, 2);
  assert.equal((await product(mug.id)).stock, 1);
  assert.equal((await mgr.action('store.order.update', { id: order.id, status: 'shipped' })).status, 409, 'a refunded order stays refunded');
  const unpaid = (await mgr.get('/api/store/orders?status=unpaid')).json.orders[0];
  assert.equal((await mgr.action('store.order.update', { id: unpaid.id, status: 'shipped' })).status, 409);
});

test('the store’s writes are on the chain under the system actor and the chain verifies', async () => {
  const all = (await mgr.get('/api/events?since=0&limit=2000')).json.events;
  for (const a of ['store.product.save', 'store.checkout', 'store.payment', 'store.expire', 'store.order.update']) {
    assert.ok(all.some((e) => e.action === a), a);
  }
  assert.ok(all.filter((e) => ['store.checkout', 'store.payment', 'store.expire'].includes(e.action)).every((e) => e.actor_id === null));
  assert.ok(all.some((e) => e.action === 'store.payment' && e.entity_type === 'person' && e.payload.tags.includes('store')));
  assert.equal((await mgr.get('/api/audit/verify')).json.ok, true);
});
