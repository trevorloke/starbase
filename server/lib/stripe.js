// Stripe over plain REST (no SDK): Checkout Sessions for one-time and monthly
// contributions, and webhook signature verification.
//   STRIPE_SECRET_KEY      sk_live_… / sk_test_…  (unset → donations are pledges)
//   STRIPE_WEBHOOK_SECRET  whsec_…                 (required to accept webhooks)
import { createHmac, timingSafeEqual } from 'node:crypto';

export const stripeConfigured = () => !!process.env.STRIPE_SECRET_KEY;

const form = (obj, prefix = '', out = new URLSearchParams()) => {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
};

// A Checkout Session for a pledge: one payment, or a monthly subscription.
// metadata.pledge_id rides on the session, the payment intent and the
// subscription, so every later event finds its pledge.
export const createCheckoutSession = async ({ pledge, workspace, successUrl, cancelUrl }) => {
  const monthly = pledge.cadence === 'monthly';
  const metadata = { pledge_id: pledge.id, workspace_id: workspace.id };
  const body = form({
    mode: monthly ? 'subscription' : 'payment',
    customer_email: pledge.email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata,
    line_items: { 0: {
      quantity: 1,
      price_data: {
        currency: 'cad',
        unit_amount: pledge.amount_cents,
        product_data: { name: `${monthly ? 'Monthly contribution' : 'Contribution'} to ${workspace.name}` },
        ...(monthly ? { recurring: { interval: 'month' } } : {}),
      },
    } },
    ...(monthly ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
  });
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `stripe ${res.status}`);
  return json; // { id, url, … }
};

// Verify a Stripe-Signature header against the raw body (5-minute tolerance).
export const verifyStripeSignature = (rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) => {
  if (!header || !secret) return false;
  const items = header.split(',').map((kv) => kv.trim().split('='));
  const t = items.find(([k]) => k === 't')?.[1];
  const sigs = items.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(nowSec - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
};
