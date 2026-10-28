// Members: the website's join form lands a person in People (tagged
// member-pending until the fee is paid, member after), on the newsletter
// list, and on the roll; the fee is a contribution — a pledge, checked
// against the limit, booked as a gift when paid (Stripe) or received
// (Donations) — and the membership turns active then. No fee: active at
// once. A member with more than two months left is told so; one inside
// the window renews from when the current membership ends.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.members.${tag}@example.org`;
let db;
let mgr;
let vol;
let slug;
let wsId;

let ipN = 0;
const pub = async (method, path, body, headers = {}) => {
  ipN += 1;
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.${Math.floor(ipN / 250)}.0.1, 198.51.100.${ipN % 250}`, ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, json: ct.includes('json') ? await res.json() : null };
};
const join = (b) => pub('POST', `/api/public/${slug}/join`, b);
const form = (who, extra = {}) => ({
  first_name: who, last_name: 'Member', email: mail(who.toLowerCase()), phone: '604-555-0101',
  address: '12345 72 Ave', city: 'Surrey', postal: 'v3w 2m8', neighbourhood: 'Newton', birthdate: '1990-05-04',
  citizenship: 'Citizen', languages: ['Punjabi', 'English'], student: false, interest_volunteer: true, consent: true, ...extra,
});
const sessions = [];
const realFetch = globalThis.fetch;
const mockStripe = () => {
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://api.stripe.com/v1/checkout/sessions') {
      sessions.push(Object.fromEntries(new URLSearchParams(init.body)));
      return new Response(JSON.stringify({ id: `cs_${tag}_${sessions.length}`, url: `https://checkout.stripe.test/s/${sessions.length}` }), { status: 200 });
    }
    return realFetch(url, init);
  };
};
const sign = (body, secret) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
};
const hook = (evt) => {
  const body = JSON.stringify(evt);
  return pub('POST', '/api/public/stripe/webhook', body, { 'stripe-signature': sign(body, 'whsec_members') });
};
const memberOf = async (email) => (await mgr.get(`/api/membership?status=all&q=${encodeURIComponent(email)}`)).json.members[0];
const personOf = async (email) => (await mgr.get(`/api/persons?q=${encodeURIComponent(email.split('.')[0])}`)).json.persons.find((p) => p.email === email);

before(async () => {
  db = await freshDb();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STARBASE_SITE_ORIGINS = 'https://imaginesurrey.test';
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Imagine Surrey', email: mail('manager'), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  slug = r.json.workspace.slug;
  wsId = r.json.workspace.id;
  await mgr.get('/api/site/overview');
  const inv = await mgr.action('member.invite', { email: mail('vol'), role: 'volunteer' });
  vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic Vol', password: 'members-pass-2026' });
});
after(() => {
  globalThis.fetch = realFetch;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STARBASE_SITE_ORIGINS;
});

test('the form is checked field by field; the site JSON says the fee and the choices', async () => {
  const site = (await pub('GET', `/api/public/${slug}/site`)).json;
  assert.equal(site.membership.fee_cents, 1000, 'the default fee is $10');
  assert.equal(site.membership.min_age, 14);
  assert.ok(site.membership.neighbourhoods.includes('Outside Surrey'));
  assert.equal(site.membership.join, `${site.links.api}/join`);
  const bad = async (extra, field) => {
    const r = await join(form('Bad', extra));
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.field, field, r.json.error);
  };
  await bad({ email: 'nope' }, 'email');
  await bad({ postal: '12345' }, 'postal');
  await bad({ neighbourhood: 'Mars' }, 'neighbourhood');
  await bad({ birthdate: '2020-01-01' }, 'birthdate');
  await bad({ citizenship: 'Other' }, 'citizenship');
  await bad({ postal: 'M5V 1A1' }, 'postal');
  await bad({ consent: false }, 'consent');
  assert.equal((await pub('POST', '/api/public/nobody/join', form('X'))).status, 404);
});

test('a fee, no card payment: the person, the newsletter, a pledge and a pending membership; received in Donations → active', async () => {
  const r = await join(form('Priya'));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 'pledged');
  const p = await personOf(mail('priya'));
  assert.ok(p, 'in People');
  assert.ok(p.tags.includes('member-pending') && p.tags.includes('volunteer-prospect'), JSON.stringify(p.tags));
  assert.equal(p.address, '12345 72 Ave, Surrey, V3W 2M8');
  assert.ok((await mgr.get('/api/subscriptions')).json.subscriptions.some((s) => s.email === mail('priya')));
  const m = await memberOf(mail('priya'));
  assert.equal(m.status, 'pending_payment');
  assert.equal(m.details.neighbourhood, 'Newton');
  assert.deepEqual(m.details.languages, ['Punjabi', 'English']);
  const byPerson = (await mgr.get(`/api/membership?person=${p.id}`)).json.members;
  assert.equal(byPerson.length, 1, 'the profile’s read');
  assert.equal(m.fee_cents, 1000);
  assert.equal(m.voting_eligible, true);
  const pledge = (await mgr.get('/api/pledges')).json.pledges.find((x) => x.id === m.pledge_id);
  assert.equal(pledge.amount_cents, 1000);
  assert.equal(pledge.status, 'pledged');
  // The cheque arrives: the treasurer marks it received.
  const rec = await mgr.action('pledge.receive', { id: pledge.id, date: '2026-10-28', method: 'cheque' });
  assert.equal(rec.status, 200, JSON.stringify(rec.json));
  const active = await memberOf(mail('priya'));
  assert.equal(active.status, 'active');
  assert.ok(active.expires_at && new Date(active.expires_at) > new Date(Date.now() + 360 * 86400_000), 'a year');
  const p2 = await personOf(mail('priya'));
  assert.ok(p2.tags.includes('member') && !p2.tags.includes('member-pending'));
  // On the books as a gift.
  const gifts = (await mgr.get(`/api/persons/${p.id}`)).json.gifts;
  assert.equal(gifts.length, 1);
  assert.equal(gifts[0].amount_cents, 1000);
  // Already a member: told so, nothing more to pay.
  const again = await join(form('Priya'));
  assert.equal(again.json.status, 'already_member');
  assert.ok(again.json.expires_at);
});

test('with Stripe: Checkout back to the site’s own page; the webhook’s payment activates the membership; outside Surrey can join but not vote', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_members';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_members';
  mockStripe();
  const r = await join(form('Omar', { city: 'Delta', postal: 'V4K 1A1', neighbourhood: 'Outside Surrey', return: { success: 'https://imaginesurrey.test/join/welcome', cancel: 'https://imaginesurrey.test/#join' } }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.url, /checkout\.stripe\.test/);
  const s = sessions.at(-1);
  assert.equal(s.success_url, 'https://imaginesurrey.test/join/welcome');
  assert.equal(s.mode, 'payment');
  assert.equal(s['line_items[0][price_data][unit_amount]'], '1000');
  const m = await memberOf(mail('omar'));
  assert.equal(m.status, 'pending_payment');
  assert.equal(m.voting_eligible, false);
  const pledgeId = s['metadata[pledge_id]'];
  assert.equal(pledgeId, m.pledge_id);
  const paid = await hook({
    id: `evt_${tag}_1`, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
    data: { object: { id: s.id || 'cs_x', mode: 'payment', payment_status: 'paid', amount_total: 1000, payment_intent: `pi_${tag}`, metadata: { pledge_id: pledgeId, workspace_id: wsId } } },
  });
  assert.equal(paid.status, 200, JSON.stringify(paid.json));
  assert.ok(paid.json.gift_id, 'the fee is a gift on the books');
  const active = await memberOf(mail('omar'));
  assert.equal(active.status, 'active');
  assert.ok((await personOf(mail('omar'))).tags.includes('member'));
  // Verify the records: the activation is on the chain with the payment.
  const v = await mgr.get('/api/audit/verify');
  assert.equal(v.json.ok, true);
});

test('free membership: active at once; the desk sees the roll and counts, may cancel; volunteers see nothing', async () => {
  await mgr.action('site.settings.save', { membership_fee_cents: 0 });
  const r = await join(form('Fatima', { student: true, campus: 'SFU Surrey' }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 'active');
  const list = (await mgr.get('/api/membership')).json;
  assert.equal(list.counts.active, 3);
  assert.equal(list.counts.voting, 2, 'Omar lives outside Surrey');
  assert.equal(list.counts.pending_payment, 0);
  const f = list.members.find((m) => m.email === mail('fatima'));
  assert.equal(f.details.campus, 'SFU Surrey');
  assert.equal(f.fee_cents, 0);
  const cancel = await mgr.action('member.set', { id: f.id, status: 'cancelled', note: 'Asked to leave' });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.json));
  assert.equal((await memberOf(mail('fatima'))).status, 'cancelled');
  assert.ok(!(await personOf(mail('fatima'))).tags.includes('member'));
  assert.equal((await mgr.get('/api/membership')).json.members.some((m) => m.email === mail('fatima')), false, 'cancelled ones are off the default list');
  assert.equal((await vol.get('/api/membership')).status, 403);
  assert.equal((await vol.action('member.set', { id: f.id, status: 'active' })).status, 403);
  // Back on by hand (a fee paid some other way): active for a year from now.
  const back = await mgr.action('member.set', { id: f.id, status: 'active' });
  assert.equal(back.json.member.status, 'active');
  assert.ok((await personOf(mail('fatima'))).tags.includes('member'));
  // The export carries the roll.
  assert.ok((await mgr.get('/api/export')).json.members.length >= 3);
});
