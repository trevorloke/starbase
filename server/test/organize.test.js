// Turfs + walk lists, events + RSVPs, donations (pledges, Stripe checkout and
// webhooks), and offline-safe contact logging.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { app } from '../index.js';

let mgr, slug, ws;

const pub = async (method, path, body, headers = {}) => {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    redirect: 'manual',
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, json: ct.includes('json') ? await res.json() : null, text: ct.includes('json') ? '' : await res.text(), headers: res.headers };
};

before(async () => {
  await freshDb();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' });
  slug = r.json.workspace.slug;
  ws = r.json.workspace.id;
});

// ── Turfs ──
test('turf: draw, stats, walk list in odd-up / even-back order, assignment scopes volunteers', async () => {
  const lat = 49.1327; const lng = -122.855;
  const mk = (name, address, dLng) => mgr.createPerson(name, { address, lat, lng: lng + dLng });
  const a = await mk('A One', '13213 72 Ave', 0.0000);
  await mk('B Two', '13225 72 Ave', 0.0003);
  await mk('C Three', '13224 72 Ave', 0.0003);
  await mk('D Four', '13212 72 Ave', 0.0000);
  await mgr.createPerson('Far Away', { address: '1 Other Rd', lat: 49.3, lng: -122.5 });
  const t = await mgr.action('turf.create', {
    name: 'Newton block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
  });
  assert.equal(t.status, 200);
  await mgr.action('contact.log', { person_id: a.id, channel: 'door', outcome: 'contacted', rating: '1' });
  const list = (await mgr.get('/api/turfs')).json.turfs;
  const turf = list.find((x) => x.id === t.json.turf.id);
  assert.equal(turf.doors, 4, 'far-away person excluded');
  assert.equal(turf.doorsDone, 1);
  const walk = await mgr.get(`/api/turfs/${turf.id}/walk`);
  assert.deepEqual(walk.json.doors.map((d) => d.address), ['13213 72 Ave', '13225 72 Ave', '13224 72 Ave', '13212 72 Ave'],
    'odd side up, even side back');
  assert.equal(walk.json.doors[0].done, true);
  const bad = await mgr.action('turf.create', { name: 'x', polygon: [[1, 2], [3, 4]] });
  assert.equal(bad.status, 400, 'a turf needs at least 3 points');

  // Volunteer: sees only assigned turfs; walk list of an unassigned turf is refused.
  const inv = await mgr.action('member.invite', { email: 'walker@example.org', role: 'volunteer' });
  const vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Walker', password: 'walker-pass-1' });
  assert.equal((await vol.get('/api/turfs')).json.turfs.length, 0);
  assert.equal((await vol.get(`/api/turfs/${turf.id}/walk`)).status, 403);
  const members = (await mgr.get('/api/members')).json.members;
  const walker = members.find((m) => m.name === 'Walker');
  assert.equal((await mgr.action('turf.assign', { turf_id: turf.id, user_id: walker.id })).status, 200);
  assert.equal((await vol.get('/api/turfs')).json.turfs.length, 1);
  assert.equal((await vol.get(`/api/turfs/${turf.id}/walk`)).status, 200);
  const brief = (await vol.get('/api/brief')).json;
  assert.equal(brief.myTurfs[0].name, 'Newton block');
  assert.equal((await vol.action('turf.create', { name: 'v', polygon: [[0, 0], [0, 1], [1, 1]] })).status, 403);
  assert.equal((await vol.get('/api/members')).status, 403);
});

// ── Events + RSVP ──
test('event: public page, RSVP with guests, capacity enforced, listing counts, bridge rsvp', async () => {
  const starts = new Date(Date.now() + 5 * 86400e3).toISOString();
  const e = await mgr.action('cevent.create', { slug: 'town-hall', title: 'Town hall: Imagine Newton', location: 'Newton Cultural Centre', starts_at: starts, capacity: 4 });
  assert.equal(e.status, 200);
  const dup = await mgr.action('cevent.create', { slug: 'town-hall', title: 'again', starts_at: starts });
  assert.equal(dup.status, 409);
  const page = await pub('GET', `/e/${slug}/town-hall`);
  assert.match(page.text, /Town hall: Imagine Newton/);
  const r1 = await pub('POST', `/e/${slug}/town-hall`, { name: 'Ann Attendee', email: 'ann@example.org', guests: 2 }, { accept: 'application/json' });
  assert.equal(r1.status, 200);
  const full = await pub('POST', `/e/${slug}/town-hall`, { name: 'Too Many', guests: 1 }, { accept: 'application/json' });
  assert.equal(full.status, 409, '3 going + 2 more > capacity 4');
  const one = await pub('POST', '/api/public/' + slug + '/signup', { kind: 'rsvp', event: 'town-hall', name: 'Bridge Guest' });
  assert.equal(one.status, 200, 'website bridge rsvp fills the last seat');
  const events = (await mgr.get('/api/campaign-events')).json.events;
  assert.equal(events[0].going, 4);
  const rsvps = (await mgr.get(`/api/campaign-events/${events[0].id}/rsvps`)).json.rsvps;
  assert.equal(rsvps.length, 2);
  assert.equal((await mgr.action('rsvp.setStatus', { id: rsvps[0].id, status: 'attended' })).status, 200);
  const tagged = (await mgr.get('/api/persons?tag=event:town-hall')).json.persons;
  assert.equal(tagged.length, 2, 'attendees land in People tagged by event');
  assert.ok((await mgr.get('/api/brief')).json.events.some((x) => x.slug === 'town-hall'));
});

test('event: end time and capacity can be cleared; a deleted link is reusable; re-going respects capacity', async () => {
  const starts = new Date(Date.now() + 6 * 86400e3).toISOString();
  const e = (await mgr.action('cevent.create', { slug: 'house-party', title: 'House party', starts_at: starts,
    ends_at: new Date(Date.now() + 6 * 86400e3 + 7200e3).toISOString(), capacity: 2 })).json.event;
  await pub('POST', `/e/${slug}/house-party`, { name: 'G One' }, { accept: 'application/json' });
  const two = await pub('POST', `/e/${slug}/house-party`, { name: 'G Two' }, { accept: 'application/json' });
  assert.equal(two.status, 200);
  const rs = (await mgr.get(`/api/campaign-events/${e.id}/rsvps`)).json.rsvps;
  await mgr.action('rsvp.setStatus', { id: rs[0].id, status: 'cancelled' });
  await pub('POST', `/e/${slug}/house-party`, { name: 'G Three' }, { accept: 'application/json' });
  const back = await mgr.action('rsvp.setStatus', { id: rs[0].id, status: 'going' });
  assert.equal(back.status, 409, 'cancelled → going cannot overfill');
  assert.equal((await mgr.action('cevent.update', { id: e.id, capacity: null, ends_at: null })).status, 200);
  const row = (await mgr.get('/api/campaign-events')).json.events.find((x) => x.id === e.id);
  assert.equal(row.capacity, null);
  assert.equal(row.ends_at, null);
  assert.equal((await mgr.action('rsvp.setStatus', { id: rs[0].id, status: 'going' })).status, 200, 'no cap now');
  assert.equal((await mgr.action('cevent.update', { id: e.id, title: 'House party!' })).status, 200);
  assert.equal((await mgr.get('/api/campaign-events')).json.events.find((x) => x.id === e.id).capacity, null, 'omitted key leaves it');
  assert.equal((await mgr.action('cevent.delete', { id: e.id })).status, 200);
  const reuse = await mgr.action('cevent.create', { slug: 'house-party', title: 'House party 2', starts_at: starts });
  assert.equal(reuse.status, 200, 'a deleted event frees its link');
  assert.equal((await pub('GET', `/e/${slug}/house-party`)).status, 200);
});

// ── Donations ──
const donate = (fields) => pub('POST', `/d/${slug}`, new URLSearchParams(fields).toString(),
  { 'content-type': 'application/x-www-form-urlencoded' });
const eligible = { attest_individual: '1', attest_resident: '1', attest_own_funds: '1' };

test('donate page: attestations required, name + address required, cap refused up front, pledge recorded', async () => {
  const page = await pub('GET', `/d/${slug}`);
  assert.match(page.text, /Canadian citizen or permanent resident/);
  assert.match(page.text, /annual limit is \$1,429\.70/);
  const noAttest = await donate({ amount: '100', name: 'Pat Donor', email: 'pat@example.org', address: '1 Main St' });
  assert.equal(noAttest.status, 400);
  assert.match(noAttest.text, /eligibility/);
  const noAddr = await donate({ amount: '100', name: 'Pat Donor', email: 'pat@example.org', ...eligible });
  assert.equal(noAddr.status, 400);
  const tooBig = await donate({ other: '2000', name: 'Pat Donor', email: 'pat@example.org', address: '1 Main St', ...eligible });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.text, /most one person can give/);
  const ok = await donate({ amount: '250', name: 'Pat Donor', email: 'pat@example.org', address: '1 Main St', ...eligible });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /pledge of <b>\$250<\/b>/);
  const pledges = (await mgr.get('/api/pledges')).json.pledges;
  assert.equal(pledges[0].status, 'pledged');
  assert.equal(pledges[0].amount_cents, 25000);
  assert.equal((await mgr.get('/api/brief')).json.pledges.n, 1);

  // Treasurer confirms → it's a gift, through the cap engine.
  const rec = await mgr.action('pledge.receive', { id: pledges[0].id, method: 'etransfer', date: new Date().toISOString().slice(0, 10) });
  assert.equal(rec.status, 200);
  assert.equal(rec.json.gift.amount_cents, 25000);
  assert.equal((await mgr.action('pledge.receive', { id: pledges[0].id, date: '2026-01-01' })).status, 404, 'only once');

  // Second visit by the same email: the up-front check counts the first gift.
  const over = await donate({ other: '1200', name: 'Pat Donor', email: 'pat@example.org', address: '1 Main St', ...eligible });
  assert.equal(over.status, 400);
  assert.match(over.text, /up to \$1,179\.70 more this year/);
});

const sign = (body, secret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('stripe: checkout redirect, signed webhooks become gifts once, monthly invoices each count, bad signatures refused', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const realFetch = globalThis.fetch;
  const sessions = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://api.stripe.com/v1/checkout/sessions') {
      const params = new URLSearchParams(init.body.toString());
      sessions.push(params);
      return new Response(JSON.stringify({ id: `cs_${sessions.length}`, url: `https://checkout.stripe.test/cs_${sessions.length}` }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    const go = await donate({ amount: '100', name: 'Card Donor', email: 'card@example.org', address: '2 Main St', ...eligible });
    assert.equal(go.status, 303);
    assert.equal(go.headers.get('location'), 'https://checkout.stripe.test/cs_1');
    assert.equal(sessions[0].get('mode'), 'payment');
    assert.equal(sessions[0].get('line_items[0][price_data][currency]'), 'cad');
    assert.equal(sessions[0].get('line_items[0][price_data][unit_amount]'), '10000');
    const pledge = (await mgr.get('/api/pledges')).json.pledges.find((p) => p.email === 'card@example.org');
    assert.equal(pledge.status, 'pending');
    assert.equal(sessions[0].get('metadata[pledge_id]'), pledge.id);

    const evt = (id, type, object) => JSON.stringify({ id, type, created: Math.floor(Date.now() / 1000), data: { object } });
    const paid = evt('evt_1', 'checkout.session.completed', {
      id: 'cs_1', mode: 'payment', payment_status: 'paid', amount_total: 10000, payment_intent: 'pi_1',
      metadata: { pledge_id: pledge.id, workspace_id: ws },
    });
    const forged = await pub('POST', '/api/public/stripe/webhook', paid, { 'stripe-signature': sign(paid, 'whsec_wrong') });
    assert.equal(forged.status, 400);
    const stale = await pub('POST', '/api/public/stripe/webhook', paid, { 'stripe-signature': sign(paid, 'whsec_test', Math.floor(Date.now() / 1000) - 900) });
    assert.equal(stale.status, 400, 'replayed old signature refused');
    const ok = await pub('POST', '/api/public/stripe/webhook', paid, { 'stripe-signature': sign(paid, 'whsec_test') });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.gift_id);
    const again = await pub('POST', '/api/public/stripe/webhook', paid, { 'stripe-signature': sign(paid, 'whsec_test') });
    assert.equal(again.json.duplicate, true, 'a retried delivery applies once');
    const gifts = (await mgr.get('/api/records/gift?limit=200')).json.records.filter((g) => g.person_name === 'Card Donor');
    assert.equal(gifts.length, 1);
    assert.equal(gifts[0].method, 'card');

    // Monthly: subscription session, then each invoice.paid is a gift.
    const goM = await donate({ amount: '25', monthly: '1', name: 'Monthly Card', email: 'monthly@example.org', address: '3 Main St', ...eligible });
    assert.equal(goM.status, 303);
    assert.equal(sessions[1].get('mode'), 'subscription');
    assert.equal(sessions[1].get('line_items[0][price_data][recurring][interval]'), 'month');
    const mp = (await mgr.get('/api/pledges')).json.pledges.find((p) => p.email === 'monthly@example.org');
    const started = evt('evt_2', 'checkout.session.completed', { id: 'cs_2', mode: 'subscription', subscription: 'sub_1', metadata: { pledge_id: mp.id, workspace_id: ws } });
    assert.equal((await pub('POST', '/api/public/stripe/webhook', started, { 'stripe-signature': sign(started, 'whsec_test') })).json.subscription, true);
    for (const [i, id] of [['1', 'evt_3'], ['2', 'evt_4']]) {
      const inv = evt(id, 'invoice.paid', { id: `in_${i}`, amount_paid: 2500, status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
        parent: { subscription_details: { metadata: { pledge_id: mp.id, workspace_id: ws } } } });
      const r = await pub('POST', '/api/public/stripe/webhook', inv, { 'stripe-signature': sign(inv, 'whsec_test') });
      assert.ok(r.json.gift_id, `invoice ${i} → gift`);
    }
    const monthly = (await mgr.get('/api/records/gift?limit=200')).json.records.filter((g) => g.person_name === 'Monthly Card');
    assert.equal(monthly.length, 2);
    assert.ok(monthly.every((g) => g.cadence === 'monthly'));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

// ── Offline-safe knocks ──
test('a knock replayed with the same client_id is recorded once', async () => {
  const p = await mgr.createPerson('Offline Knock');
  const client_id = '0b6c3d8e-1f2a-4c5b-8d9e-0a1b2c3d4e5f';
  const first = await mgr.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating: '2', client_id });
  const replay = await mgr.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating: '2', client_id });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.duplicate, true);
  const prof = (await mgr.get(`/api/persons/${p.id}`)).json;
  assert.equal(prof.contacts.length, 1);
  const db = await getDb();
  const n = (await db.query(`select count(*)::int as n from events where workspace_id = $1 and entity_type = 'contact' and payload->>'client_id' = $2`, [ws, client_id])).rows[0].n;
  assert.equal(n, 1, 'one event for one knock');
});

// ── Pledges and their gifts stay in step ──
// A pledge workspace of its own, so the brief's counts here are only these.
const pledgeDesk = async (name) => {
  const desk = new Client();
  const r = await desk.signup({ workspaceName: name, jurisdiction: 'bc-municipal' });
  return { desk, slug: r.json.workspace.slug, ws: r.json.workspace.id };
};
const pledgeVia = async (wsSlug, fields) => {
  const res = await pub('POST', `/d/${wsSlug}`, new URLSearchParams({ ...eligible, ...fields }).toString(),
    { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.27' });
  assert.equal(res.status, 200, res.text.slice(0, 300));
};
const pledgeRow = async (desk, email) => (await desk.get('/api/pledges')).json.pledges.find((p) => p.email === email);
const dbPledge = async (id) => (await (await getDb()).query(
  'select status, gift_id, last_received_on from pledges where id = $1', [id],
)).rows[0];
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d == null ? null : String(d).slice(0, 10));
const ym = (offset = 0) => {
  const d = new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 15));
  return t.toISOString().slice(0, 10);
};

test('a monthly pledge logs each month’s gift and stays open; the same month twice is refused', async () => {
  const { desk, slug: s2 } = await pledgeDesk('Monthly Pledges');
  await pledgeVia(s2, { amount: '20', monthly: '1', name: 'Mona Monthly', email: 'mona.monthly@example.org', address: '10 Monthly Way' });
  const p = await pledgeRow(desk, 'mona.monthly@example.org');
  assert.equal(p.cadence, 'monthly');
  assert.equal(p.status, 'pledged');

  const thisMonth = ym(0);
  const first = await desk.action('pledge.receive', { id: p.id, method: 'etransfer', date: thisMonth });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.pledge.status, 'pledged', 'a monthly pledge stays open after a month is received');
  assert.equal(first.json.pledge.last_received_on, thisMonth);
  assert.equal(first.json.gift.amount_cents, 2000);
  assert.equal(first.json.gift.cadence, 'monthly');
  let row = await dbPledge(p.id);
  assert.equal(row.status, 'pledged');
  assert.equal(day(row.last_received_on), thisMonth);
  assert.equal(row.gift_id, first.json.gift.id);
  const listed = await pledgeRow(desk, 'mona.monthly@example.org');
  assert.equal(listed.status, 'pledged');
  assert.equal(day(listed.last_received_on), thisMonth, 'GET /api/pledges carries last_received_on');

  const twice = await desk.action('pledge.receive', { id: p.id, method: 'etransfer', date: thisMonth.slice(0, 8) + '01' });
  assert.equal(twice.status, 409, 'one gift per month');
  assert.match(twice.json.error, /already received/);

  const next = await desk.action('pledge.receive', { id: p.id, method: 'cheque', date: ym(1) });
  assert.equal(next.status, 200);
  assert.equal(next.json.pledge.last_received_on, ym(1));
  const earlier = await desk.action('pledge.receive', { id: p.id, method: 'cheque', date: ym(-1) });
  assert.equal(earlier.status, 200, 'a late gift for last month is fine');
  assert.equal(earlier.json.pledge.last_received_on, ym(1), 'last_received_on is the latest month in, not the last one typed');
  assert.equal((await dbPledge(p.id)).gift_id, next.json.gift.id, 'gift_id stays the latest month’s gift');

  const gifts = (await desk.get('/api/records/gift?limit=200')).json.records.filter((g) => g.person_name === 'Mona Monthly');
  assert.equal(gifts.length, 3);
  assert.ok(gifts.every((g) => g.cadence === 'monthly' && g.amount_cents === 2000));

  // Cancelling ends it; nothing more can be received.
  assert.equal((await desk.action('pledge.cancel', { id: p.id })).status, 200);
  assert.equal((await desk.action('pledge.receive', { id: p.id, date: ym(2) })).status, 404);
  assert.equal((await desk.get('/api/audit/verify')).json.ok, true);
});

test('the brief counts a monthly pledge as open only until this month’s gift is in', async () => {
  const { desk, slug: s2 } = await pledgeDesk('Brief Pledges');
  await pledgeVia(s2, { amount: '15', monthly: '1', name: 'Bri Monthly', email: 'bri.monthly@example.org', address: '11 Monthly Way' });
  await pledgeVia(s2, { amount: '40', name: 'Bo Once', email: 'bo.once@example.org', address: '12 Once Way' });
  const before = (await desk.get('/api/brief')).json.pledges;
  assert.equal(before.n, 2);
  assert.equal(before.cents, 5500);
  const m = await pledgeRow(desk, 'bri.monthly@example.org');
  assert.equal((await desk.action('pledge.receive', { id: m.id, date: new Date().toISOString().slice(0, 10) })).status, 200);
  // brief.pledges = open one-time pledges + monthly pledges not yet received
  // this calendar month.
  const after = (await desk.get('/api/brief')).json.pledges;
  assert.equal(after.n, 1, 'this month is in: only the one-time pledge is still waiting');
  assert.equal(after.cents, 4000);
  assert.equal((await pledgeRow(desk, 'bri.monthly@example.org')).status, 'pledged', 'still open for next month');
});

test('voiding a pledge’s gift reopens a one-time pledge; restoring closes it again — logged, chain intact', async () => {
  const { desk, slug: s2, ws: w2 } = await pledgeDesk('Void Pledges');
  await pledgeVia(s2, { amount: '60', name: 'Vic Void', email: 'vic.void@example.org', address: '13 Void Way' });
  const p = await pledgeRow(desk, 'vic.void@example.org');
  const today = new Date().toISOString().slice(0, 10);
  const rec = await desk.action('pledge.receive', { id: p.id, method: 'etransfer', date: today });
  assert.equal(rec.status, 200);
  assert.equal(rec.json.pledge.status, 'received');
  const g1 = rec.json.gift.id;
  assert.equal((await desk.get('/api/brief')).json.pledges.n, 0);

  const v = await desk.action('gift.void', { id: g1 });
  assert.equal(v.status, 200);
  assert.equal(v.json.pledge.id, p.id);
  assert.equal(v.json.pledge.status, 'pledged');
  let row = await pledgeRow(desk, 'vic.void@example.org');
  assert.equal(row.status, 'pledged', 'the money is out of the books, so the pledge is waiting again');
  assert.equal(row.gift_id, null);
  assert.equal((await desk.get('/api/brief')).json.pledges.n, 1);
  // The void and the reopen are one action in the log.
  const db = await getDb();
  const evs = (await db.query(
    `select seq, entity_type, op, payload from events where workspace_id = $1 and action = 'gift.void' order by seq`, [w2],
  )).rows.filter((e) => e.entity_type !== 'receipt'); // a receipt, when that feature is on, is voided with its gift
  assert.deepEqual(evs.map((e) => [e.entity_type, e.op]), [['gift', 'void'], ['pledge', 'update']]);
  assert.equal(evs[1].payload.status, 'pledged');
  assert.equal(evs[1].payload.voided_gift, g1);

  const r = await desk.action('gift.restore', { id: g1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.pledge.status, 'received');
  row = await pledgeRow(desk, 'vic.void@example.org');
  assert.equal(row.status, 'received');
  assert.equal(row.gift_id, g1);
  assert.equal((await desk.get('/api/brief')).json.pledges.n, 0);

  // Void, receive it again with a new gift, then try to restore the old one:
  // that would count the pledge twice, so it is refused until the new one goes.
  assert.equal((await desk.action('gift.void', { id: g1 })).status, 200);
  const again = await desk.action('pledge.receive', { id: p.id, method: 'cheque', date: today });
  assert.equal(again.status, 200, 'a reopened pledge can be received again');
  const g2 = again.json.gift.id;
  const clash = await desk.action('gift.restore', { id: g1 });
  assert.equal(clash.status, 409);
  assert.match(clash.json.error, /another gift/);
  const live = (await desk.get('/api/records/gift?limit=200')).json.records.filter((g) => g.person_name === 'Vic Void');
  assert.deepEqual(live.map((g) => g.id), [g2], 'the refused restore changed nothing');
  assert.equal((await desk.action('gift.void', { id: g2 })).status, 200);
  assert.equal((await desk.action('gift.restore', { id: g1 })).status, 200);
  row = await pledgeRow(desk, 'vic.void@example.org');
  assert.equal(row.status, 'received');
  assert.equal(row.gift_id, g1);

  // A gift with no pledge leaves pledges alone.
  const person = await desk.createPerson('Desk Giver');
  const plain = await desk.action('gift.log', { person_id: person.id, amount_cents: 1000, date: today, method: 'cash' });
  const pv = await desk.action('gift.void', { id: plain.json.gift.id });
  assert.equal(pv.json.pledge, null);
  assert.equal((await desk.get('/api/audit/verify')).json.ok, true);
});

test('voiding a monthly pledge’s gift rolls back last_received_on; the pledge stays open', async () => {
  const { desk, slug: s2 } = await pledgeDesk('Void Monthly');
  await pledgeVia(s2, { amount: '25', monthly: '1', name: 'Max Monthly', email: 'max.monthly@example.org', address: '14 Monthly Way' });
  const p = await pledgeRow(desk, 'max.monthly@example.org');
  const a = await desk.action('pledge.receive', { id: p.id, date: ym(-1) });
  const b = await desk.action('pledge.receive', { id: p.id, date: ym(0) });
  assert.equal(b.json.pledge.last_received_on, ym(0));

  const v = await desk.action('gift.void', { id: b.json.gift.id });
  assert.equal(v.status, 200);
  assert.equal(v.json.pledge.last_received_on, ym(-1));
  let row = await dbPledge(p.id);
  assert.equal(row.status, 'pledged');
  assert.equal(day(row.last_received_on), ym(-1));
  assert.equal(row.gift_id, a.json.gift.id);

  // This month can be received again — once.
  const redo = await desk.action('pledge.receive', { id: p.id, date: ym(0) });
  assert.equal(redo.status, 200, 'the voided month is open again');
  const clash = await desk.action('gift.restore', { id: b.json.gift.id });
  assert.equal(clash.status, 409, 'restoring would make two gifts for one month');
  assert.match(clash.json.error, /already has a gift/);

  assert.equal((await desk.action('gift.void', { id: redo.json.gift.id })).status, 200);
  assert.equal((await desk.action('gift.void', { id: a.json.gift.id })).status, 200);
  row = await dbPledge(p.id);
  assert.equal(row.status, 'pledged');
  assert.equal(row.last_received_on, null, 'nothing received any more');
  assert.equal(row.gift_id, null);
  const back = await desk.action('gift.restore', { id: b.json.gift.id });
  assert.equal(back.status, 200);
  assert.equal(back.json.pledge.last_received_on, ym(0));
  assert.equal(day((await dbPledge(p.id)).last_received_on), ym(0));
  assert.equal((await desk.get('/api/audit/verify')).json.ok, true);
});
