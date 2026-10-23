// The event log: gapless per-workspace sequence, verifiable hash chain,
// tamper detection, and all-or-nothing transactions.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { runAction, verifyChain } from '../lib/events.js';

let db, client, ws;

before(async () => {
  db = await freshDb();
  client = new Client();
  const r = await client.signup();
  assert.equal(r.status, 201);
  ws = r.json.workspace.id;
});

test('actions append events with a gapless sequence', async () => {
  const a = await client.createPerson('Bo Lindqvist');
  const b = await client.createPerson('Mira Osei');
  assert.ok(a.id && b.id);
  const ev = await client.get('/api/events?since=0');
  assert.equal(ev.status, 200);
  const seqs = ev.json.events.map((e) => Number(e.seq));
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'sequence must be gapless from 1');
});

test('the hash chain verifies end to end', async () => {
  const v = await client.get('/api/audit/verify');
  assert.equal(v.status, 200);
  assert.equal(v.json.ok, true);
  assert.ok(v.json.checked >= 2);
});

test('tampering with a payload breaks verification at that link', async () => {
  await db.query(
    `update events set payload = '{"name":"Doctored Name"}' where workspace_id = $1 and seq = 1`,
    [ws],
  );
  const v = await verifyChain(db, ws);
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  assert.equal(v.reason, 'payload');
});

test('a failing handler rolls back both table writes and events', async () => {
  const before = (await db.query('select count(*)::int n from persons where workspace_id = $1', [ws])).rows[0].n;
  const seqBefore = (await db.query('select event_seq from workspaces where id = $1', [ws])).rows[0].event_seq;
  await assert.rejects(
    runAction(db, { workspaceId: ws, actorId: null, action: 'test.fail' }, async (tx, emit) => {
      await tx.query(
        `insert into persons (id, workspace_id, name) values ('11111111-1111-1111-1111-111111111111', $1, 'Ghost')`,
        [ws],
      );
      emit('person', '11111111-1111-1111-1111-111111111111', 'create', { name: 'Ghost' });
      throw new Error('boom');
    }),
  );
  const after = (await db.query('select count(*)::int n from persons where workspace_id = $1', [ws])).rows[0].n;
  const seqAfter = (await db.query('select event_seq from workspaces where id = $1', [ws])).rows[0].event_seq;
  assert.equal(after, before, 'person insert must roll back');
  assert.equal(Number(seqAfter), Number(seqBefore), 'sequence must not advance');
  const ghosts = (await db.query(`select count(*)::int n from events where workspace_id = $1 and payload->>'name' = 'Ghost'`, [ws])).rows[0].n;
  assert.equal(ghosts, 0, 'no ghost event');
});
