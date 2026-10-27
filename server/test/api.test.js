// API surface: auth flow, tenancy isolation, role gates, pagination,
// brief composition, and the full-fidelity export.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let a, b; // two tenants

before(async () => {
  await freshDb();
  a = new Client();
  b = new Client();
  await a.signup({ workspaceName: 'Tenant A' });
  await b.signup({ workspaceName: 'Tenant B' });
});

test('signup → me → logout → 401', async () => {
  const c = new Client();
  const s = await c.signup({ workspaceName: 'Ephemeral' });
  assert.equal(s.status, 201);
  assert.equal(s.json.role, 'manager');
  const me = await c.get('/api/auth/me');
  assert.equal(me.json.workspace.name, 'Ephemeral');
  await c.post('/api/auth/logout');
  c.cookie = '';
  const denied = await c.get('/api/brief');
  assert.equal(denied.status, 401);
});

test('login works and wrong password is rejected without leaking existence', async () => {
  const c = new Client();
  const email = 'login-test@example.org';
  await c.signup({ email, workspaceName: 'Login WS' });
  const fresh = new Client();
  const bad = await fresh.post('/api/auth/login', { email, password: 'wrong-password' });
  assert.equal(bad.status, 401);
  const unknown = await fresh.post('/api/auth/login', { email: 'nobody@example.org', password: 'x' });
  assert.equal(unknown.status, 401);
  assert.equal(bad.json.error, unknown.json.error, 'same error either way');
  const good = await fresh.post('/api/auth/login', { email, password: 'northshore2026' });
  assert.equal(good.status, 200);
});

test('tenants cannot see each other: persons, records, events, profile', async () => {
  const pa = await a.createPerson('Only In A');
  await a.action('gift.log', { person_id: pa.id, amount_cents: 5000, date: '2025-02-02' });

  const persons = await b.get('/api/persons?q=Only');
  assert.equal(persons.json.persons.length, 0);
  const gifts = await b.get('/api/records/gift');
  assert.equal(gifts.json.records.length, 0);
  const events = await b.get('/api/events?since=0');
  assert.ok(events.json.events.every((e) => e.payload?.name !== 'Only In A'));
  const profile = await b.get(`/api/persons/${pa.id}`);
  assert.equal(profile.status, 404);
  const crossGift = await b.action('gift.log', { person_id: pa.id, amount_cents: 100, date: '2025-02-02' });
  assert.equal(crossGift.status, 400, "cannot attach a gift to another tenant's person");
});

test('records pagination pages cleanly with no overlap', async () => {
  const c = new Client();
  await c.signup({ workspaceName: 'Pager' });
  const p = await c.createPerson('Bulk Donor');
  for (let i = 0; i < 7; i++) {
    await c.action('gift.log', { person_id: p.id, amount_cents: 100 + i, date: '2025-01-0' + (i + 1) });
  }
  const page1 = await c.get('/api/records/gift?limit=3');
  assert.equal(page1.json.records.length, 3);
  assert.ok(page1.json.next);
  const page2 = await c.get(`/api/records/gift?limit=3&cursor=${encodeURIComponent(page1.json.next)}`);
  assert.equal(page2.json.records.length, 3);
  const page3 = await c.get(`/api/records/gift?limit=3&cursor=${encodeURIComponent(page2.json.next)}`);
  assert.equal(page3.json.records.length, 1);
  const ids = [...page1.json.records, ...page2.json.records, ...page3.json.records].map((r) => r.id);
  assert.equal(new Set(ids).size, 7, 'no overlaps, nothing missed');
});

test('brief composes money, flags, activation', async () => {
  const c = new Client();
  await c.signup({ workspaceName: 'Brief WS' });
  const brief0 = await c.get('/api/brief');
  assert.equal(brief0.json.activation.complete, false);
  assert.equal(brief0.json.money.totalCents, 0);

  const donor = await c.createPerson('Grand Donor');
  await c.action('gift.log', { person_id: donor.id, amount_cents: 200000, date: '2025-04-01' });

  const brief = await c.get('/api/brief');
  assert.equal(brief.json.money.totalCents, 200000);
  assert.equal(brief.json.flagged.length, 1, 'over-cap gift surfaces on Today');
  assert.equal(brief.json.activation.complete, true);
});

test('export carries everything: persons, records, and the event log', async () => {
  const ex = await a.get('/api/export');
  assert.equal(ex.status, 200);
  assert.equal(ex.json.format, 'starbase-export');
  assert.ok(ex.json.persons.length >= 1);
  assert.ok(ex.json.gifts.length >= 1);
  assert.ok(ex.json.events.length >= 2);
  assert.ok(ex.json.events.every((e) => e.hash), 'events export with their chain hashes');
});

test('an unknown action is 404', async () => {
  const c = new Client();
  await c.signup({ workspaceName: 'Unknown Action WS' });
  const unknown = await c.action('nope.nothing', {});
  assert.equal(unknown.status, 404);
});

test('brief: each flagged gift carries the donor’s year total and the cap (desk only)', async () => {
  const c = new Client();
  await c.signup({ workspaceName: 'Cap Numbers WS', jurisdiction: 'bc-municipal' });
  const donor = await c.createPerson('Capped Donor');
  const year = 2026; // a year with its own seeded limit: $1,429.70
  await c.action('gift.log', { person_id: donor.id, amount_cents: 50000, date: `${year - 1}-06-01` }); // other year: not counted
  await c.action('gift.log', { person_id: donor.id, amount_cents: 100000, date: `${year}-01-15` });
  const over = await c.action('gift.log', { person_id: donor.id, amount_cents: 50000, date: `${year}-02-01` });
  assert.equal(over.json.gift.flagged, true);

  let flagged = (await c.get('/api/brief')).json.flagged;
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, over.json.gift.id);
  assert.equal(flagged[0].total_cents, 150000, 'this year only');
  assert.equal(flagged[0].cap_cents, 142970, 'the bc-municipal cap the engine used');
  assert.equal(flagged[0].person_id, donor.id);
  assert.match(flagged[0].flag_reason, /\$1500\.00 for 2026 — over the \$1429\.70 limit \(Elections BC 2026/, 'the legal wording is unchanged');

  // A second crossing: both rows carry the donor's total as it stands now.
  const again = await c.action('gift.log', { person_id: donor.id, amount_cents: 10000, date: `${year}-03-01` });
  flagged = (await c.get('/api/brief')).json.flagged;
  assert.equal(flagged.length, 2);
  assert.ok(flagged.every((f) => f.total_cents === 160000 && f.cap_cents === 142970));
  // Voiding a gift takes it out of the total.
  await c.action('gift.void', { id: again.json.gift.id });
  flagged = (await c.get('/api/brief')).json.flagged;
  assert.deepEqual(flagged.map((f) => [f.total_cents, f.cap_cents]), [[150000, 142970]]);

  // A workspace override cap is the one reported.
  const { getDb } = await import('../db/client.js');
  const me = (await c.get('/api/auth/me')).json;
  await (await getDb()).query(
    `update workspaces set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{capCents}', '100000'::jsonb) where id = $1`,
    [me.workspace.id],
  );
  assert.equal((await c.get('/api/brief')).json.flagged[0].cap_cents, 100000);
});
