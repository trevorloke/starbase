// Background jobs and core hooks: jobs scheduled inside an action commit
// with it, run once when due, retry with backoff, and park as failed; the
// events hook sees every write and may add events to the same chain.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { runAction, verifyChain, newId } from '../lib/events.js';
import { registerJob, enqueueJob, runDueJobs, cancelJobs } from '../lib/jobs.js';
import { onHook } from '../lib/hooks.js';

let db, ws;
const tag = Math.random().toString(36).slice(2, 8);
const ran = [];

before(async () => {
  db = await freshDb();
  const c = new Client();
  const r = await c.signup({ workspaceName: 'Jobs WS', email: `jobs+${tag}@example.org` });
  ws = r.json.workspace.id;
  registerJob(`test.write.${tag}`, async (d, job) => {
    await runAction(d, { workspaceId: job.workspace_id, actorId: null, action: 'test.job' }, async (tx, emit) => {
      emit('test', newId(), 'create', { n: job.payload.n });
    });
    ran.push(job.payload.n);
  });
  let tries = 0;
  registerJob(`test.flaky.${tag}`, async () => { tries += 1; if (tries < 2) throw new Error('flaky once'); });
  registerJob(`test.broken.${tag}`, async () => { throw new Error('always broken'); });
});

const jobRow = async (id) => (await db.query('select * from jobs where id = $1', [id])).rows[0];

test('a job scheduled in an action commits with it and runs once when due', async () => {
  let id;
  await runAction(db, { workspaceId: ws, actorId: null, action: 'test.schedule' }, async (tx, emit) => {
    id = await enqueueJob(tx, { workspaceId: ws, kind: `test.write.${tag}`, payload: { n: 1 } });
    emit('test', newId(), 'create', {});
  });
  const later = await runAction(db, { workspaceId: ws, actorId: null, action: 'test.schedule' }, async (tx) => (
    enqueueJob(tx, { workspaceId: ws, kind: `test.write.${tag}`, runAt: new Date(Date.now() + 3600_000).toISOString(), payload: { n: 2 } })
  ));
  await runDueJobs(db, { workspaceId: ws });
  assert.deepEqual(ran, [1], 'only the due job ran');
  assert.equal((await jobRow(id)).status, 'done');
  assert.equal((await jobRow(later.result)).status, 'pending');
  await runDueJobs(db, { workspaceId: ws });
  assert.deepEqual(ran, [1], 'a done job never runs twice');
  assert.equal((await verifyChain(db, ws)).ok, true, 'the job wrote through the event log');
});

test('a rolled-back action schedules nothing; keys make scheduling idempotent', async () => {
  await assert.rejects(runAction(db, { workspaceId: ws, actorId: null, action: 'test.schedule' }, async (tx) => {
    await enqueueJob(tx, { workspaceId: ws, kind: `test.write.${tag}`, payload: { n: 99 } });
    throw new Error('nope');
  }));
  await runDueJobs(db, { workspaceId: ws });
  assert.ok(!ran.includes(99));
  const k = `once-${tag}`;
  const a = await runAction(db, { workspaceId: ws, actorId: null, action: 'test.schedule' }, (tx) => enqueueJob(tx, { workspaceId: ws, kind: `test.write.${tag}`, key: k, payload: { n: 3 } }));
  const b = await runAction(db, { workspaceId: ws, actorId: null, action: 'test.schedule' }, (tx) => enqueueJob(tx, { workspaceId: ws, kind: `test.write.${tag}`, key: k, payload: { n: 3 } }));
  assert.ok(a.result);
  assert.equal(b.result, null, 'same key → not scheduled again');
});

test('failures retry with backoff, then park as failed with the error', async () => {
  const flaky = await runAction(db, { workspaceId: ws, actorId: null, action: 'x' }, (tx) => enqueueJob(tx, { workspaceId: ws, kind: `test.flaky.${tag}` }));
  await runDueJobs(db, { workspaceId: ws });
  let row = await jobRow(flaky.result);
  assert.equal(row.status, 'pending');
  assert.match(row.last_error, /flaky once/);
  assert.ok(new Date(row.run_at) > new Date(), 'retry is pushed into the future');
  await db.query('update jobs set run_at = now() where id = $1', [flaky.result]);
  await runDueJobs(db, { workspaceId: ws });
  assert.equal((await jobRow(flaky.result)).status, 'done');

  const broken = await runAction(db, { workspaceId: ws, actorId: null, action: 'x' }, (tx) => enqueueJob(tx, { workspaceId: ws, kind: `test.broken.${tag}` }));
  for (let i = 0; i < 5; i++) {
    await db.query('update jobs set run_at = now() where id = $1', [broken.result]);
    await runDueJobs(db, { workspaceId: ws });
  }
  row = await jobRow(broken.result);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 5);
  assert.match(row.last_error, /always broken/);
});

test('pending jobs can be cancelled by payload', async () => {
  const j = await runAction(db, { workspaceId: ws, actorId: null, action: 'x' }, (tx) => enqueueJob(tx, {
    workspaceId: ws, kind: `test.write.${tag}`, runAt: new Date(Date.now() + 3600_000).toISOString(), payload: { n: 4, run: 'r1' },
  }));
  const n = await runAction(db, { workspaceId: ws, actorId: null, action: 'x' }, (tx) => cancelJobs(tx, { workspaceId: ws, kind: `test.write.${tag}`, where: { run: 'r1' } }));
  assert.equal(n.result, 1);
  assert.equal((await jobRow(j.result)).status, 'cancelled');
});

test('the events hook sees each write and can add to the same chain', async () => {
  const seen = [];
  onHook('events', async (tx, meta, events) => {
    if (meta.workspaceId !== ws || meta.action !== `hooked.${tag}`) return;
    seen.push(...events.map((e) => e.entityType));
    meta.emit('hook_echo', newId(), 'create', { from: meta.action });
  });
  await runAction(db, { workspaceId: ws, actorId: null, action: `hooked.${tag}` }, async (tx, emit) => {
    emit('thing', newId(), 'create', { a: 1 });
  });
  assert.deepEqual(seen, ['thing']);
  const last = (await db.query('select entity_type from events where workspace_id = $1 order by seq desc limit 2', [ws])).rows.map((r) => r.entity_type);
  assert.deepEqual(last, ['hook_echo', 'thing']);
  assert.equal((await verifyChain(db, ws)).ok, true);
});
