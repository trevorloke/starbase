// Public pages + website bridge: every public write is on the hash-chained
// event log under the system actor (so "Verify the records" covers it), and
// every public page says only what the server did.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { campaignDay } from '../lib/gifts.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.pub.${tag}@example.org`;
let db;
let mgr, slug, wsId, wsName;

// Each request from its own address, so the per-IP public rate limit never
// trips mid-file.
let ipN = 0;
const pub = async (method, path, body, headers = {}) => {
  const form = body instanceof URLSearchParams;
  ipN += 1;
  const res = await app.request(path, {
    method,
    headers: {
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      'x-forwarded-for': `10.${Math.floor(ipN / 250)}.0.1, 198.51.100.${ipN % 250}`,
      ...headers,
    },
    body: body === undefined ? undefined : (form ? body.toString() : (typeof body === 'string' ? body : JSON.stringify(body))),
    redirect: 'manual',
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, json: ct.includes('json') ? await res.json() : null, text: ct.includes('json') ? '' : await res.text(), headers: res.headers };
};
const JSON_ACCEPT = { accept: 'application/json' };

// Events appended since the last call.
let cursor = 0;
const fresh = async () => {
  const r = await mgr.get(`/api/events?since=${cursor}&limit=1000`);
  assert.equal(r.status, 200);
  cursor = r.json.cursor;
  return r.json.events;
};
const verified = async () => {
  const v = await mgr.get('/api/audit/verify');
  assert.equal(v.json.ok, true, JSON.stringify(v.json));
};
const of = (events, action) => events.filter((e) => e.action === action);

const eligible = { attest_individual: '1', attest_resident: '1', attest_own_funds: '1' };

before(async () => {
  db = await freshDb();
  delete process.env.RESEND_API_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  mgr = new Client();
  wsName = `Public Log ${tag}`;
  const r = await mgr.signup({ workspaceName: wsName, email: mail('manager'), jurisdiction: 'bc-municipal' });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json));
  slug = r.json.workspace.slug;
  wsId = r.json.workspace.id;
  await fresh();
});

after(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

test('newsletter signup (page + bridge) is logged as public.subscribe; the thank-you promises no mail', async () => {
  const form = await pub('POST', `/n/${slug}`, new URLSearchParams({ email: mail('Reader'), name: 'Rita Reader' }));
  assert.equal(form.status, 200);
  assert.match(form.text, /You're on the list\./);
  assert.ok(form.text.includes(`<b>${mail('Reader')}</b>`), 'names the address that was saved');
  assert.doesNotMatch(form.text, /We'll write|You're in\./, 'nothing promises an email while email may not be connected');

  let ev = await fresh();
  const sub = of(ev, 'public.subscribe');
  assert.equal(sub.length, 1);
  assert.equal(sub[0].entity_type, 'subscription');
  assert.equal(sub[0].op, 'create');
  assert.equal(sub[0].actor_id, null, 'system actor');
  assert.deepEqual([sub[0].payload.email, sub[0].payload.status, sub[0].payload.source], [mail('reader'), 'subscribed', 'signup-page']);
  const list = (await mgr.get('/api/subscriptions')).json.subscriptions;
  assert.equal(list.find((s) => s.email === mail('reader')).id, sub[0].entity_id, 'the event names the row');
  assert.ok(of(ev, 'public.signup').some((e) => e.entity_type === 'person' && e.op === 'create'), 'the named reader lands in People');

  // The same address again with nothing new: nothing written, nothing logged.
  const again = await pub('POST', `/n/${slug}`, { email: mail('READER') }, JSON_ACCEPT);
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, { ok: true });
  ev = await fresh();
  assert.equal(of(ev, 'public.subscribe').length, 0);

  const site = await pub('POST', `/api/public/${slug}/signup`, { kind: 'newsletter', email: mail('site') });
  assert.equal(site.status, 200);
  ev = await fresh();
  assert.deepEqual(of(ev, 'public.subscribe').map((e) => [e.entity_type, e.op, e.payload.source]), [['subscription', 'create', 'website']]);

  // Validation is unchanged.
  assert.equal((await pub('POST', `/n/${slug}`, { email: 'not-an-email' })).status, 400);
  assert.equal((await pub('POST', `/api/public/${slug}/signup`, { kind: 'newsletter' })).status, 400);
  assert.equal((await fresh()).length, 0, 'a refused signup writes nothing');
  await verified();
});

test('unsubscribe link is logged as public.unsubscribe; a broken link gets a styled page, never a 500', async () => {
  const s = (await mgr.get('/api/subscriptions')).json.subscriptions.find((x) => x.email === mail('reader'));
  // Opening the link only asks: mail scanners open links by themselves.
  const ask = await pub('GET', `/u/${s.id}`);
  assert.equal(ask.status, 200);
  assert.match(ask.text, new RegExp(`Unsubscribe from ${wsName}\\?`));
  assert.match(ask.text, new RegExp(`<form method="post" action="/u/${s.id}"><button type="submit">Unsubscribe</button></form>`));
  assert.equal((await fresh()).length, 0, 'opening the link writes nothing');
  assert.equal((await mgr.get('/api/subscriptions')).json.subscriptions.find((x) => x.id === s.id).status, 'subscribed');
  const un = await pub('POST', `/u/${s.id}`, new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }));
  assert.equal(un.status, 200);
  assert.match(un.text, /Unsubscribed\./);
  assert.ok(un.text.includes(wsName));
  let ev = await fresh();
  assert.deepEqual(of(ev, 'public.unsubscribe').map((e) => [e.entity_type, e.entity_id, e.op, e.payload.status, e.actor_id]),
    [['subscription', s.id, 'update', 'unsubscribed', null]]);
  assert.equal((await mgr.get('/api/subscriptions')).json.subscriptions.find((x) => x.id === s.id).status, 'unsubscribed');

  // A second click: still true ("Unsubscribed."), nothing new written; the
  // link now says so without asking.
  const twice = await pub('POST', `/u/${s.id}`, new URLSearchParams());
  assert.equal(twice.status, 200);
  assert.match(twice.text, /Unsubscribed\./);
  assert.match((await pub('GET', `/u/${s.id}`)).text, /Unsubscribed\./);
  assert.equal((await fresh()).length, 0);
  // Off the list: the desk can't put them back — only they can.
  const add = await mgr.action('subscription.add', { email: mail('reader') });
  assert.equal(add.status, 409);
  assert.match(add.json.error, /^Unsubscribed on [A-Z][a-z]{2} \d{1,2} — only they can rejoin \(signup page\)$/);
  assert.equal((await mgr.get('/api/subscriptions')).json.subscriptions.find((x) => x.id === s.id).status, 'unsubscribed');
  assert.equal((await fresh()).length, 0, 'a refused add writes nothing');

  for (const bad of ['not-a-uuid', randomUUID(), "1' or '1'='1"]) {
    for (const method of ['GET', 'POST']) {
      const r = await pub(method, `/u/${encodeURIComponent(bad)}`, method === 'POST' ? new URLSearchParams() : undefined);
      assert.equal(r.status, 404, `${method} ${bad}`);
      assert.match(r.text, /This unsubscribe link isn't valid — reply to the email to be removed\./, bad);
    }
    const r = await pub('GET', `/u/${encodeURIComponent(bad)}`);
    assert.equal(r.status, 404, bad);
    assert.match(r.text, /This unsubscribe link isn't valid — reply to the email to be removed\./, bad);
    assert.match(r.text, /<!doctype html>/i, 'the styled page, not plain text');
    assert.match(r.text, /Powered by Starbase/);
  }
  assert.equal((await fresh()).length, 0);

  // Signing up again re-subscribes, and that is logged too.
  await pub('POST', `/n/${slug}`, { email: mail('reader') }, JSON_ACCEPT);
  ev = await fresh();
  assert.deepEqual(of(ev, 'public.subscribe').map((e) => [e.entity_id, e.op, e.payload.status]), [[s.id, 'update', 'subscribed']]);
  await verified();
});

test('petition signatures (page + bridge) are logged as public.sign with the opt-in; a closed petition says so', async () => {
  const p = await mgr.action('petition.create', { slug: 'safe-crossings', title: 'Safe crossings on 72 Ave', body: 'Lights at every school.' });
  assert.equal(p.status, 200);
  await fresh();

  const sign = await pub('POST', `/p/${slug}/safe-crossings`,
    new URLSearchParams({ name: 'Sana Signer', email: mail('Signer'), phone: '604-555-0142', subscribe: '1' }));
  assert.equal(sign.status, 200);
  assert.match(sign.text, /Thank you, Sana\./);
  assert.match(sign.text, /is recorded/);
  let ev = await fresh();
  const signed = of(ev, 'public.sign');
  assert.deepEqual(signed.map((e) => [e.entity_type, e.op]), [['petition_signature', 'create'], ['subscription', 'create']],
    'the signature and its newsletter opt-in commit together');
  assert.equal(signed[0].payload.petition_id, p.json.petition.id);
  assert.equal(signed[0].payload.email, mail('signer'));
  assert.equal(signed[1].payload.source, 'petition:safe-crossings');
  assert.ok(signed.every((e) => e.actor_id === null));
  const sigs = (await mgr.get(`/api/petitions/${p.json.petition.id}/signatures`)).json.signatures;
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].id, signed[0].entity_id);
  assert.ok(of(ev, 'public.signup').length >= 1, 'the signer is tagged in People');

  const bridge = await pub('POST', `/api/public/${slug}/signup`, { kind: 'petition', petition: 'safe-crossings', name: 'Web Signer', subscribe: 'false' });
  assert.equal(bridge.status, 200);
  ev = await fresh();
  assert.deepEqual(of(ev, 'public.sign').map((e) => [e.entity_type, e.payload.subscribe]), [['petition_signature', false]],
    '"false" from a website form is not an opt-in');
  assert.match((await pub('GET', `/p/${slug}/safe-crossings`)).text, /2 signatures/);

  // Closed: the page says so (styled), and nothing more can be signed.
  assert.equal((await mgr.action('petition.update', { id: p.json.petition.id, active: false })).status, 200);
  await fresh();
  const closed = await pub('GET', `/p/${slug}/safe-crossings`);
  assert.equal(closed.status, 410);
  assert.match(closed.text, /This petition is closed\./);
  assert.match(closed.text, /Safe crossings on 72 Ave/);
  assert.ok(closed.text.includes(wsName), 'styled page with the campaign name');
  assert.doesNotMatch(closed.text, /<form/);
  const late = await pub('POST', `/p/${slug}/safe-crossings`, new URLSearchParams({ name: 'Late Signer' }));
  assert.equal(late.status, 410);
  assert.match(late.text, /This petition is closed\./);
  const lateJson = await pub('POST', `/p/${slug}/safe-crossings`, { name: 'Late Signer' }, JSON_ACCEPT);
  assert.equal(lateJson.status, 410);
  assert.match(lateJson.json.error, /closed/);
  const lateSite = await pub('POST', `/api/public/${slug}/signup`, { kind: 'petition', petition: 'safe-crossings', name: 'Late Signer' });
  assert.equal(lateSite.status, 410);
  assert.equal((await mgr.get(`/api/petitions/${p.json.petition.id}/signatures`)).json.signatures.length, 2);
  assert.equal((await fresh()).length, 0, 'a closed petition writes nothing');

  assert.equal((await pub('GET', `/p/${slug}/no-such-petition`)).status, 404);
  assert.equal((await pub('POST', `/api/public/${slug}/signup`, { kind: 'petition', petition: 'nope', name: 'x' })).status, 404);
  await verified();
});

test('RSVPs (page + bridge) are logged as public.rsvp; a full event writes nothing', async () => {
  const starts = new Date(Date.now() + 6 * 86400e3).toISOString();
  const e = await mgr.action('cevent.create', { slug: 'porch-chat', title: 'Porch chat', location: 'Fleetwood Park', starts_at: starts, capacity: 3 });
  assert.equal(e.status, 200);
  await fresh();

  const r1 = await pub('POST', `/e/${slug}/porch-chat`, new URLSearchParams({ name: 'Raj Rsvp', email: mail('raj'), guests: '1' }));
  assert.equal(r1.status, 200);
  assert.match(r1.text, /You're in, Raj\./);
  let ev = await fresh();
  const rs = of(ev, 'public.rsvp');
  assert.deepEqual(rs.map((x) => [x.entity_type, x.op, x.payload.guests, x.payload.status, x.actor_id]), [['rsvp', 'create', 1, 'going', null]]);
  const rsvps = (await mgr.get(`/api/campaign-events/${e.json.event.id}/rsvps`)).json.rsvps;
  assert.equal(rsvps[0].id, rs[0].entity_id);
  assert.equal(rs[0].payload.person_id, rsvps[0].person_id);

  const full = await pub('POST', `/e/${slug}/porch-chat`, { name: 'Too Many', guests: 1 }, JSON_ACCEPT);
  assert.equal(full.status, 409);
  ev = await fresh();
  assert.equal(of(ev, 'public.rsvp').length, 0, 'refused: no RSVP, no event');
  assert.equal(of(ev, 'public.signup').length, 0, 'refused before anyone is added to People');

  const site = await pub('POST', `/api/public/${slug}/signup`, { kind: 'rsvp', event: 'porch-chat', name: 'Last Seat' });
  assert.equal(site.status, 200);
  ev = await fresh();
  assert.equal(of(ev, 'public.rsvp').length, 1);
  assert.equal((await mgr.get('/api/campaign-events')).json.events.find((x) => x.slug === 'porch-chat').going, 3);
  await verified();
});

test('volunteer roles + note (page + bridge) are logged as public.volunteer', async () => {
  const form = new URLSearchParams();
  form.append('name', 'Vera Volunteer'); form.append('email', mail('vera'));
  form.append('roles', 'doorknocking'); form.append('roles', 'translation');
  form.append('detail_translation', 'Punjabi');
  form.append('note', 'Evenings');
  const r = await pub('POST', `/v/${slug}`, form);
  assert.equal(r.status, 200);
  assert.match(r.text, /We'll be in touch about doorknocking and translating\./);
  let ev = await fresh();
  const v = of(ev, 'public.volunteer');
  assert.deepEqual(v.map((e) => [e.entity_type, e.op, e.payload.role ?? null, e.payload.detail ?? null]), [
    ['volunteer_role', 'create', 'doorknocking', null],
    ['volunteer_role', 'create', 'translation', 'Punjabi'],
    ['person', 'update', null, null],
  ]);
  assert.equal(v[2].payload.note, 'Evenings');
  assert.ok(v.every((e) => e.actor_id === null));
  const personId = v[0].payload.person_id;
  const prof = (await mgr.get(`/api/persons/${personId}`)).json;
  assert.deepEqual(prof.roles.map((x) => x.id).sort(), [v[0].entity_id, v[1].entity_id].sort());
  assert.equal(prof.person.note, 'Evenings');

  const site = await pub('POST', `/api/public/${slug}/signup`, { kind: 'volunteer', name: 'Vera Volunteer', email: mail('vera'), roles: ['food'], note: 'Weekends too' });
  assert.equal(site.status, 200);
  ev = await fresh();
  const v2 = of(ev, 'public.volunteer');
  assert.deepEqual(v2.map((e) => [e.entity_type, e.payload.role ?? null]), [['volunteer_role', 'food'], ['person', null]]);
  assert.equal(v2[1].payload.note, 'Evenings\nWeekends too', 'the logged note is the note as saved');

  // Nothing ticked, no note: only the person is written (and logged).
  await pub('POST', `/v/${slug}`, { name: 'Just Name' }, JSON_ACCEPT);
  ev = await fresh();
  assert.equal(of(ev, 'public.volunteer').length, 0);
  assert.equal(of(ev, 'public.signup').length, 1);
  await verified();
});

test('donate page: pledge logged as public.pledge; the law’s words stay; no receipt is promised', async () => {
  const pageRes = await pub('GET', `/d/${slug}`);
  assert.equal(pageRes.status, 200);
  for (const words of [
    'I am an individual (not a business, union, or organization).',
    'I live in British Columbia and am a Canadian citizen or permanent resident.',
    'This contribution is from my own funds and I will not be reimbursed.',
    'Full name', 'Home address',
  ]) assert.ok(pageRes.text.includes(words), words);
  assert.match(pageRes.text, /The annual limit is \$1,429\.70 per contributor to each slate, including monthly gifts\./);
  assert.match(pageRes.text, /<option value="council" selected>City council slate<\/option>/, 'the slate is chosen on the form');
  assert.doesNotMatch(pageRes.text, /receipt/i);

  const donate = (fields) => pub('POST', `/d/${slug}`, new URLSearchParams(fields));
  const noEmail = await donate({ amount: '50', name: 'Dana Donor', address: '1 Main St', email: 'nope', ...eligible });
  assert.equal(noEmail.status, 400);
  assert.match(noEmail.text, /A valid email is required so the campaign can confirm your contribution\./);
  assert.doesNotMatch(noEmail.text, /receipt/i);
  const noAttest = await donate({ amount: '50', name: 'Dana Donor', address: '1 Main St', email: mail('dana') });
  assert.equal(noAttest.status, 400);
  assert.match(noAttest.text, /Please confirm each eligibility statement/);
  assert.equal((await fresh()).length, 0, 'a refused pledge writes nothing');

  const ok = await donate({ amount: '50', monthly: '1', name: 'Dana Donor', email: mail('Dana'), phone: '604-555-0150', address: '1 Main St', ...eligible });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Your monthly pledge of <b>\$50<\/b> is recorded\./);
  const ev = await fresh();
  const pl = of(ev, 'public.pledge');
  assert.equal(pl.length, 1);
  assert.deepEqual([pl[0].entity_type, pl[0].op, pl[0].actor_id], ['pledge', 'create', null]);
  assert.deepEqual([pl[0].payload.amount_cents, pl[0].payload.cadence, pl[0].payload.status, pl[0].payload.email],
    [5000, 'monthly', 'pledged', mail('dana')]);
  assert.deepEqual([pl[0].payload.attest.individual, pl[0].payload.attest.resident, pl[0].payload.attest.own_funds], [true, true, true]);
  const pledges = (await mgr.get('/api/pledges')).json.pledges;
  assert.equal(pledges.find((x) => x.email === mail('dana')).id, pl[0].entity_id);
  assert.ok(of(ev, 'public.signup').some((e) => e.payload.tags?.includes('donor')));
  await verified();
});

const stripeSign = (body, secret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('stripe: checkout link and every payment are logged; the thank-you says Stripe emails the receipt', async () => {
  const thanks = await pub('GET', `/d/${slug}/thanks`);
  assert.equal(thanks.status, 200);
  assert.match(thanks.text, /Stripe emails the payment receipt\./);
  assert.doesNotMatch(thanks.text, /on its way/);

  process.env.STRIPE_SECRET_KEY = 'sk_test_public';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_public';
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://api.stripe.com/v1/checkout/sessions') {
      n += 1;
      return new Response(JSON.stringify({ id: `cs_pub_${tag}_${n}`, url: `https://checkout.stripe.test/${n}` }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    const formPage = await pub('GET', `/d/${slug}`);
    assert.match(formPage.text, /Secure card payment by Stripe\./);
    assert.doesNotMatch(formPage.text, /receipt/i);

    const go = await pub('POST', `/d/${slug}`, new URLSearchParams({ amount: '100', name: 'Carmen Card', email: mail('carmen'), address: '2 Main St', ...eligible }));
    assert.equal(go.status, 303);
    let ev = await fresh();
    const created = of(ev, 'public.pledge');
    assert.equal(created.length, 1);
    assert.equal(created[0].payload.status, 'pending');
    const pledgeId = created[0].entity_id;
    assert.deepEqual(of(ev, 'stripe.checkout').map((e) => [e.entity_type, e.entity_id, e.payload.stripe_session_id, e.actor_id]),
      [['pledge', pledgeId, `cs_pub_${tag}_1`, null]]);

    const body = JSON.stringify({ id: `evt_pub_${tag}_1`, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), data: { object: {
      id: `cs_pub_${tag}_1`, mode: 'payment', payment_status: 'paid', amount_total: 10000, payment_intent: 'pi_pub',
      metadata: { pledge_id: pledgeId, workspace_id: wsId },
    } } });
    const paid = await pub('POST', '/api/public/stripe/webhook', body, { 'stripe-signature': stripeSign(body, 'whsec_public') });
    assert.equal(paid.status, 200);
    assert.ok(paid.json.gift_id);
    ev = await fresh();
    // (A contribution receipt, when that feature is on, rides on the same write.)
    const pay = of(ev, 'stripe.payment').filter((e) => e.entity_type !== 'receipt');
    assert.deepEqual(pay.map((e) => [e.entity_type, e.op]), [['gift', 'create'], ['pledge', 'update']]);
    assert.equal(pay[0].payload.amount_cents, 10000);
    assert.equal(pay[0].payload.pledge_id, pledgeId, 'the gift names its pledge');
    assert.equal(pay[1].payload.gift_id, paid.json.gift_id);

    // Monthly by card: each invoice is a gift, and the pledge records the month in.
    const goM = await pub('POST', `/d/${slug}`, new URLSearchParams({ amount: '25', monthly: '1', name: 'Mo Monthly', email: mail('mo'), address: '3 Main St', ...eligible }));
    assert.equal(goM.status, 303);
    const mId = of(await fresh(), 'public.pledge')[0].entity_id;
    const inv = JSON.stringify({ id: `evt_pub_${tag}_2`, type: 'invoice.paid', created: Math.floor(Date.now() / 1000), data: { object: {
      id: 'in_pub', amount_paid: 2500, status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
      parent: { subscription_details: { metadata: { pledge_id: mId, workspace_id: wsId } } },
    } } });
    const invPaid = await pub('POST', '/api/public/stripe/webhook', inv, { 'stripe-signature': stripeSign(inv, 'whsec_public') });
    assert.ok(invPaid.json.gift_id);
    const mev = of(await fresh(), 'stripe.payment');
    assert.equal(mev[1].payload.gift_id, invPaid.json.gift_id);
    // The campaign's day (Vancouver), not the UTC one: from 5 pm Pacific they differ.
    assert.equal(mev[1].payload.last_received_on, campaignDay(new Date()));
    const mp = (await mgr.get('/api/pledges')).json.pledges.find((x) => x.id === mId);
    assert.equal(mp.status, 'paid');
    assert.ok(mp.last_received_on, 'the pledges list shows when the last card gift came in');

    // Refunds made in Stripe. A partial one is noted; a full one voids the
    // gift as a hand void would: the one-time pledge opens again, the monthly
    // pledge forgets the month. Each delivery applies once.
    const refund = async (id, object) => {
      const b = JSON.stringify({ id, type: 'charge.refunded', created: Math.floor(Date.now() / 1000), data: { object: { object: 'charge', ...object } } });
      return pub('POST', '/api/public/stripe/webhook', b, { 'stripe-signature': stripeSign(b, 'whsec_public') });
    };
    const giftRow = async (id) => (await db.query('select note, deleted_at from gifts where id = $1', [id])).rows[0];
    const part = await refund(`evt_pub_${tag}_r1`, { payment_intent: 'pi_pub', amount: 10000, amount_refunded: 2500, refunded: false });
    assert.equal(part.json.partial, 2500);
    let g = await giftRow(paid.json.gift_id);
    assert.equal(g.deleted_at, null, 'a partial refund keeps the gift');
    assert.equal(g.note, 'Stripe pi_pub · Partly refunded in Stripe ($25)');
    const whole = await refund(`evt_pub_${tag}_r2`, { payment_intent: 'pi_pub', amount: 10000, amount_refunded: 10000, refunded: true });
    assert.equal(whole.json.voided, true, JSON.stringify(whole.json));
    assert.equal(whole.json.pledge.status, 'pledged', 'the one-time pledge is open again');
    g = await giftRow(paid.json.gift_id);
    assert.ok(g.deleted_at, 'the gift left the books');
    assert.equal((await mgr.get('/api/pledges')).json.pledges.find((x) => x.id === pledgeId).status, 'pledged');
    assert.equal((await refund(`evt_pub_${tag}_r2`, { payment_intent: 'pi_pub', amount: 10000, amount_refunded: 10000, refunded: true })).json.duplicate, true);
    assert.equal((await refund(`evt_pub_${tag}_r3`, { payment_intent: 'pi_pub', amount: 10000, amount_refunded: 10000, refunded: true })).json.ignored, 'nothing of ours for this charge', 'a voided gift is not found again');
    const monthly = await refund(`evt_pub_${tag}_r4`, { payment_intent: 'pi_in_pub', invoice: 'in_pub', amount: 2500, amount_refunded: 2500, refunded: true });
    assert.equal(monthly.json.gift_id, invPaid.json.gift_id, 'a monthly gift is found by its invoice');
    assert.equal(monthly.json.pledge.last_received_on, null, 'the month is forgotten');
    const rev = of(await fresh(), 'stripe.refund');
    assert.ok(rev.some((e) => e.entity_type === 'gift' && e.op === 'void' && e.entity_id === paid.json.gift_id));
    assert.ok(rev.every((e) => e.actor_id === null));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
  await verified();
});

// The Superstar Club: the yearly maximum to each slate, two contributions
// in one payment. One pledge per slate, one Checkout Session with a line
// item each, one gift each when it is paid; the limit is per slate, so
// neither is over, and either slate alone is then full. A monthly one
// books two gifts an invoice and closes when Stripe cancels it.
test('slates: one payment to each slate is a pledge, a line item and a gift for each; the limit is per slate; Stripe’s cancellation closes a monthly pledge', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_public';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_public';
  const realFetch = globalThis.fetch;
  const sessions = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://api.stripe.com/v1/checkout/sessions') {
      sessions.push(Object.fromEntries(new URLSearchParams(init.body)));
      return new Response(JSON.stringify({ id: `cs_sl_${tag}_${sessions.length}`, url: `https://checkout.stripe.test/sl/${sessions.length}` }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const hook = async (id, type, object) => {
    const b = JSON.stringify({ id, type, created: Math.floor(Date.now() / 1000), data: { object } });
    return pub('POST', '/api/public/stripe/webhook', b, { 'stripe-signature': stripeSign(b, 'whsec_public') });
  };
  const who = { name: 'Sasha Superstar', email: mail('sasha'), address: '9 Main St', attest: { individual: true, resident: true, own_funds: true } };
  const donate = (body) => pub('POST', `/api/public/${slug}/donate`, JSON.stringify(body), { 'content-type': 'application/json' });
  try {
    const bad = await donate({ ...who, amounts: { council: 142970, senate: 100 } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, 'slate');
    const tooMuch = await donate({ ...who, amounts: { council: 142970, school_board: 142971 } });
    assert.equal(tooMuch.status, 400);
    assert.match(tooMuch.json.error, /The most one person can give this year to the school board slate is \$1,429\.70\./);
    const tooMuchMonthly = await donate({ ...who, monthly: true, amount_cents: 12000 });
    assert.match(tooMuchMonthly.json.error, /a monthly gift can be at most \$119/);

    const go = await donate({ ...who, amounts: { council: 142970, school_board: '1429.70' } });
    assert.equal(go.status, 200, JSON.stringify(go.json));
    assert.equal(go.json.url, 'https://checkout.stripe.test/sl/1');
    let ev = await fresh();
    const made = of(ev, 'public.pledge');
    assert.deepEqual(made.map((e) => [e.payload.slate, e.payload.amount_cents, e.payload.status]), [['council', 142970, 'pending'], ['school_board', 142970, 'pending']]);
    const ids = made.map((e) => e.entity_id);
    const s1 = sessions[0];
    assert.equal(s1.mode, 'payment');
    assert.equal(s1['metadata[pledge_ids]'], ids.join(','));
    assert.equal(s1['metadata[pledge_id]'], ids[0]);
    assert.equal(s1['payment_intent_data[metadata][pledge_ids]'], ids.join(','));
    assert.deepEqual([s1['line_items[0][price_data][unit_amount]'], s1['line_items[1][price_data][unit_amount]']], ['142970', '142970']);
    assert.match(s1['line_items[0][price_data][product_data][name]'], /\(city council slate\)$/);
    assert.match(s1['line_items[1][price_data][product_data][name]'], /\(school board slate\)$/);
    assert.deepEqual(of(ev, 'stripe.checkout').map((e) => e.entity_id).sort(), [...ids].sort(), 'both pledges carry the session');

    const paid = await hook(`evt_sl_${tag}_1`, 'checkout.session.completed', {
      id: `cs_sl_${tag}_1`, mode: 'payment', payment_status: 'paid', amount_total: 285940, payment_intent: 'pi_sl',
      metadata: { pledge_id: ids[0], pledge_ids: ids.join(','), workspace_id: wsId },
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.json));
    assert.equal(paid.json.gift_ids.length, 2);
    assert.equal(paid.json.flagged, false, 'the maximum to each slate is within each slate’s limit');
    ev = await fresh();
    const gifts = of(ev, 'stripe.payment').filter((e) => e.entity_type === 'gift');
    assert.deepEqual(gifts.map((e) => [e.payload.slate, e.payload.amount_cents, e.payload.pledge_id, e.payload.flagged]),
      [['council', 142970, ids[0], false], ['school_board', 142970, ids[1], false]]);
    const rows = (await mgr.get('/api/pledges')).json.pledges.filter((x) => ids.includes(x.id));
    assert.deepEqual(rows.map((r) => [r.slate, r.status]).sort(), [['council', 'paid'], ['school_board', 'paid']]);

    // Either slate alone is full now; the words name the slate.
    const full = await donate({ ...who, amount_cents: 100 });
    assert.match(full.json.error, /reached this year's \$1,429\.70 limit to the city council slate/);
    const fullToo = await donate({ ...who, amount_cents: 100, slate: 'school_board' });
    assert.match(fullToo.json.error, /to the school board slate/);

    // One refund of the one charge voids both gifts.
    const whole = await hook(`evt_sl_${tag}_r`, 'charge.refunded', { object: 'charge', payment_intent: 'pi_sl', amount: 285940, amount_refunded: 285940, refunded: true });
    assert.equal(whole.json.voided, true);
    assert.deepEqual(whole.json.gift_ids.sort(), paid.json.gift_ids.sort());
    const voided = of(await fresh(), 'stripe.refund').filter((e) => e.entity_type === 'gift' && e.op === 'void');
    assert.equal(voided.length, 2);

    // Monthly to each slate: a subscription with two line items; each
    // invoice books a gift for each; cancelled in Stripe, both pledges close.
    const goM = await donate({ ...who, monthly: true, amounts: { council: 11900, school_board: 11900 } });
    assert.equal(goM.status, 200, JSON.stringify(goM.json));
    const mIds = of(await fresh(), 'public.pledge').map((e) => e.entity_id);
    assert.equal(mIds.length, 2);
    assert.equal(sessions[1].mode, 'subscription');
    assert.equal(sessions[1]['subscription_data[metadata][pledge_ids]'], mIds.join(','));
    const meta = { pledge_id: mIds[0], pledge_ids: mIds.join(','), workspace_id: wsId };
    const started = await hook(`evt_sl_${tag}_2`, 'checkout.session.completed', { id: `cs_sl_${tag}_2`, mode: 'subscription', subscription: 'sub_sl', metadata: meta });
    assert.equal(started.json.subscription, true);
    const inv = await hook(`evt_sl_${tag}_3`, 'invoice.paid', {
      id: 'in_sl', amount_paid: 23800, status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
      parent: { subscription_details: { metadata: meta } },
    });
    assert.equal(inv.json.gift_ids.length, 2, JSON.stringify(inv.json));
    const mg = of(await fresh(), 'stripe.payment').filter((e) => e.entity_type === 'gift');
    assert.deepEqual(mg.map((e) => [e.payload.slate, e.payload.amount_cents, e.payload.cadence]), [['council', 11900, 'monthly'], ['school_board', 11900, 'monthly']]);
    let mrows = (await mgr.get('/api/pledges')).json.pledges.filter((x) => mIds.includes(x.id));
    assert.ok(mrows.every((r) => r.status === 'paid' && r.stripe_subscription_id === 'sub_sl'), JSON.stringify(mrows));

    // What the months left will take is spoken for: this month's gift is in,
    // the live subscription pays each month after it, and a one-time gift
    // over what is left is refused — the words say how much is left.
    const monthIndex = Number(campaignDay(new Date()).slice(5, 7)) - 1;
    const left = 142970 - 11900 - 11900 * (11 - monthIndex);
    const okStill = await donate({ ...who, amount_cents: left });
    assert.equal(okStill.status, 200, JSON.stringify(okStill.json));
    const spoken = await donate({ ...who, amount_cents: left + 100 });
    assert.equal(spoken.status, 400, JSON.stringify(spoken.json));
    const words = `$${(left / 100).toLocaleString('en-CA', { minimumFractionDigits: left % 100 ? 2 : 0 })}`;
    assert.equal(spoken.json.error, `Thank you — you can contribute up to ${words} more this year to the city council slate under the annual limit.`);

    const ended = await hook(`evt_sl_${tag}_4`, 'customer.subscription.deleted', { id: 'sub_sl', object: 'subscription', metadata: meta });
    assert.deepEqual(ended.json.cancelled.sort(), [...mIds].sort());
    mrows = (await mgr.get('/api/pledges')).json.pledges.filter((x) => mIds.includes(x.id));
    assert.ok(mrows.every((r) => r.status === 'cancelled'));
    const cancelEv = of(await fresh(), 'stripe.cancel');
    assert.deepEqual(cancelEv.map((e) => [e.entity_type, e.op, e.payload.status, e.payload.source]), [['pledge', 'update', 'cancelled', 'stripe'], ['pledge', 'update', 'cancelled', 'stripe']]);
    assert.equal((await hook(`evt_sl_${tag}_4`, 'customer.subscription.deleted', { id: 'sub_sl', object: 'subscription', metadata: meta })).json.duplicate, true);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
  await verified();
});

test('every public write in this file is on the chain under the system actor, and the chain verifies', async () => {
  const all = (await mgr.get('/api/events?since=0&limit=1000')).json.events;
  const publicActions = new Set(['public.signup', 'public.subscribe', 'public.unsubscribe', 'public.sign', 'public.rsvp',
    'public.volunteer', 'public.pledge', 'stripe.checkout', 'stripe.payment', 'stripe.refund', 'stripe.cancel']);
  const pubEv = all.filter((e) => publicActions.has(e.action));
  assert.deepEqual([...new Set(pubEv.map((e) => e.action))].sort(), [...publicActions].sort(), 'each kind of public write appears');
  assert.ok(pubEv.every((e) => e.actor_id === null));
  await verified();
});
