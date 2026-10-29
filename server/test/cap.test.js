// The cap engine: entity-keyed (same name ≠ same donor), SQL-summed per
// calendar year, flags the exact crossing gift, and voided gifts free room.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let client;

before(async () => {
  await freshDb();
  client = new Client();
  const r = await client.signup();
  assert.equal(r.status, 201);
});

const gift = (person_id, dollars, date = '2025-03-01') =>
  client.action('gift.log', { person_id, amount_cents: Math.round(dollars * 100), date, method: 'card' });

test('two donors with the same name never pool a cap', async () => {
  const smith1 = await client.createPerson('John Smith', { email: 'john1@example.org' });
  const smith2 = await client.createPerson('John Smith', { email: 'john2@example.org' });
  const a = await gift(smith1.id, 1000);
  const b = await gift(smith2.id, 1000);
  assert.equal(a.json.gift.flagged, false, 'first John Smith under cap');
  assert.equal(b.json.gift.flagged, false, 'second John Smith is a different person — must not pool');
  assert.equal(b.json.compliance.totalCents, 100000);
});

test('the exact crossing gift is flagged with a reason', async () => {
  const donor = await client.createPerson('Priya Nair');
  const first = await gift(donor.id, 900);
  assert.equal(first.json.gift.flagged, false);
  const crossing = await gift(donor.id, 700); // 1600 > 1495.65 (2025 rule)
  assert.equal(crossing.json.gift.flagged, true);
  assert.match(crossing.json.gift.flag_reason, /Priya Nair/);
  assert.match(crossing.json.gift.flag_reason, /over the/);
  assert.equal(crossing.json.compliance.over, true);
});

test('cap years are independent', async () => {
  const donor = await client.createPerson('Yusuf Adan');
  await gift(donor.id, 1400, '2024-06-01');
  const nextYear = await gift(donor.id, 1400, '2025-06-01');
  assert.equal(nextYear.json.gift.flagged, false, 'new calendar year, fresh cap');
});

test('voiding a gift frees cap room; restoring re-counts it', async () => {
  const donor = await client.createPerson('Elena Ruiz');
  const g1 = await gift(donor.id, 1000);
  await gift(donor.id, 400);
  const voided = await client.action('gift.void', { id: g1.json.gift.id });
  assert.equal(voided.status, 200);
  const g3 = await gift(donor.id, 900); // 400 + 900 = 1300 < cap
  assert.equal(g3.json.gift.flagged, false);
  const restored = await client.action('gift.restore', { id: g1.json.gift.id });
  assert.equal(restored.status, 200);
  // 400 + 900 + 1000 = 2300 > cap: the restore is the crossing, so it is flagged.
  assert.equal(restored.json.flagged, true, 'a restore that crosses the limit is flagged like a new gift');
  assert.match(restored.json.flag_reason, /Elena Ruiz/);
  const rows = (await client.get('/api/records/gift?limit=200')).json.records;
  assert.equal(rows.find((g) => g.id === g1.json.gift.id).flagged, true);
  const g4 = await gift(donor.id, 100); // 1000 + 400 + 900 + 100 = 2400 > cap
  assert.equal(g4.json.gift.flagged, true);
});

test('restoring a gift that keeps the donor under the limit is not flagged', async () => {
  const donor = await client.createPerson('Omar Under');
  const g = await gift(donor.id, 300);
  assert.equal((await client.action('gift.void', { id: g.json.gift.id })).status, 200);
  const r = await client.action('gift.restore', { id: g.json.gift.id });
  assert.equal(r.status, 200);
  assert.equal(r.json.flagged, false);
  assert.equal((await client.action('gift.restore', { id: g.json.gift.id })).status, 404, 'only a voided gift can be restored');
  assert.equal((await client.get('/api/audit/verify')).json.ok, true);
});

test('workspace settings.capCents overrides the rule table', async () => {
  const fresh = new Client();
  await fresh.signup({ workspaceName: 'Override Test' });
  const db = await (await import('../db/client.js')).getDb();
  const me = await fresh.get('/api/auth/me');
  await db.query(
    `update workspaces set settings = '{"capCents": 50000}' where id = $1`,
    [me.json.workspace.id],
  );
  const donor = await fresh.createPerson('Sam Low');
  const over = await fresh.action('gift.log',
    { person_id: donor.id, amount_cents: 60000, date: '2025-05-01', method: 'cash' });
  assert.equal(over.json.gift.flagged, true);
  assert.equal(over.json.compliance.capCents, 50000);
});

test('unknown donor id is rejected before any write', async () => {
  const r = await client.action('gift.log', {
    person_id: '99999999-9999-4999-8999-999999999999',
    amount_cents: 100, date: '2025-01-01',
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /donor not found/);
});

// The limit is per slate: the council slate and the school board slate are
// each one limit per contributor, so the maximum to both is two gifts,
// neither over; a gift that names no slate is on the first (council).
test('the limit is per slate', async () => {
  const donor = await client.createPerson('Sasha Superstar');
  const council = await client.action('gift.log', { person_id: donor.id, amount_cents: 149565, date: '2025-06-01', method: 'card' });
  assert.equal(council.json.gift.flagged, false);
  assert.equal(council.json.gift.slate, 'council', 'unnamed means the first slate');
  const board = await client.action('gift.log', { person_id: donor.id, amount_cents: 149565, date: '2025-06-01', method: 'card', slate: 'school_board' });
  assert.equal(board.json.gift.flagged, false, 'the school board slate has its own limit');
  assert.equal(board.json.compliance.totalCents, 149565);
  assert.equal(board.json.compliance.slate, 'school_board');
  const over = await client.action('gift.log', { person_id: donor.id, amount_cents: 100, date: '2025-06-02', method: 'card', slate: 'school_board' });
  assert.equal(over.json.gift.flagged, true);
  assert.match(over.json.gift.flag_reason, /over the \$1495\.65 limit on the school board slate/);
  const nope = await client.action('gift.log', { person_id: donor.id, amount_cents: 100, date: '2025-06-02', slate: 'senate' });
  assert.equal(nope.status, 400, 'only the campaign’s slates');
});
