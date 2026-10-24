// Place everyone on the map in the background. A whole voter list is
// hundreds of thousands of lookups — hours of work that can't hang on an
// open browser tab — so the desk starts a run and the server works through
// it as a job, a round at a time, until nobody is left:
//
//   POST /api/geocode/start   start (or resume) a run       desk roles
//   POST /api/geocode/stop    stop after the current round  desk roles
//   GET  /api/geocode/status  { state, located, copied, missed, errors,
//                               lastError, remaining, unmatched, jobs }
//
// Each round takes the next people waiting for a pin (oldest first) and
// groups them by address, so a household is one lookup. An address someone
// on file already has a pin for is copied, with no lookup at all. The rest
// go to the geocoder (lib/geocode.js) a few at a time; a round's results are
// written in one action, every person's pin on the event log as before.
//
// A lookup that errors (the service is down or busy) leaves the person
// waiting for the next round; after GEO_MAX_TRIES errors they're set aside
// as 'failed' with the 'nomatch'/'weak' ones, for a pin by hand. Rounds
// where nothing worked back off; five in a row pause the run with the reason
// (Carry on resumes it). A round where every lookup failed spends nobody's
// tries — a short outage must not set good addresses aside. Each job works for at most ROUND_BUDGET_MS and then
// queues the next, so other jobs (ladder emails, A/B winners) keep moving.
//   GEOCODE_CONCURRENCY  lookups at once (default 6)
//   GEOCODE_BACKOFF_MS   wait after a round where nothing worked (default 30 s, × rounds in a row)
import { Hono } from 'hono';
import { runAction } from '../../lib/events.js';
import { enqueueJob, jobRunnerOn, runJobsSoon } from '../../lib/jobs.js';
import { geocodeAddress } from '../../lib/geocode.js';

const KIND = 'geocode.run';
const ROUND = 120;               // people looked at per round
const ROUND_BUDGET_MS = 20_000;  // per job, then the next one is queued
const GEO_MAX_TRIES = 3;
const PAUSE_AFTER = 5;           // rounds in a row where every lookup failed
const DESK = ['manager', 'staff', 'treasurer'];
// Wait after a round where nothing worked, × the rounds in a row (tests: 0).
const backoffMs = () => (process.env.GEOCODE_BACKOFF_MS != null ? Number(process.env.GEOCODE_BACKOFF_MS) : 30_000);

export const sql = `
create table if not exists geocode_runs (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  state text not null default 'idle',           -- idle | running | stopped | paused | done
  started_by uuid,
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  located integer not null default 0,           -- found by a lookup
  copied integer not null default 0,            -- pin copied from someone at the same address
  missed integer not null default 0,            -- no match, too vague, or failed too often
  errors integer not null default 0,
  bad_rounds integer not null default 0,
  last_error text
);
-- The people still waiting for a pin, oldest first: what every round reads.
create index if not exists persons_ws_geopending_idx on persons (workspace_id, created_at)
  where deleted_at is null and address is not null and lat is null;
`;

const PENDING = `workspace_id = $1 and deleted_at is null and address is not null and lat is null
  and coalesce(attrs->'geocode'->>'status', '') not in ('nomatch', 'weak', 'failed')`;

// One household = one lookup: same street address in the same city.
const keyOf = (p) => `${String(p.address).trim().toLowerCase().replace(/\s+/g, ' ')}|${String(p.city || 'surrey').trim().toLowerCase()}`;

const getRun = async (db, workspaceId) =>
  (await db.query('select * from geocode_runs where workspace_id = $1', [workspaceId])).rows[0] || null;

const setRun = (db, workspaceId, fields) => {
  const keys = Object.keys(fields);
  return db.query(
    `update geocode_runs set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where workspace_id = $1`,
    [workspaceId, ...keys.map((k) => fields[k])],
  );
};

// Lookups, `limit` at a time.
const pool = async (items, limit, fn) => {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

// One round. → { done, looked, located, copied, missed, errors, lastError, busy }
export const geocodeRound = async (db, workspaceId, actorId) => {
  const head = (await db.query(
    `select id, address, city, postal from persons where ${PENDING} order by created_at, id limit $2`,
    [workspaceId, ROUND],
  )).rows;
  if (!head.length) return { done: true };

  // Everyone waiting at those addresses (not only the first ROUND), so a
  // household is finished in one go.
  // lower(address) is indexed (persons_ws_addr_idx); imports store addresses trimmed.
  const lowers = [...new Set(head.flatMap((p) => [String(p.address).toLowerCase(), String(p.address).trim().toLowerCase()]))];
  // One address at a time (lateral): given a whole list in one "= any", the
  // planner guesses it matches most rows and reads the whole table.
  const waiting = (await db.query(
    `select x.* from unnest($2::text[]) as k(a) cross join lateral (
       select id, address, unit, city, postal, attrs->'geocode' as geo from persons
       where ${PENDING} and lower(address) = k.a offset 0) as x`,
    [workspaceId, lowers],
  )).rows;
  const groups = new Map();
  for (const p of [...head, ...waiting]) {
    const k = keyOf(p);
    if (!groups.has(k)) groups.set(k, { key: k, first: p, ids: new Set(), tries: 0 });
    const g = groups.get(k);
    g.ids.add(p.id);
    const geo = typeof p.geo === 'string' ? JSON.parse(p.geo) : p.geo;
    g.tries = Math.max(g.tries, Number(geo?.tries) || 0);
  }

  // Already on the map at that address? Copy the pin.
  const known = new Map();
  for (const r of (await db.query(
    `select x.* from unnest($2::text[]) as k(a) cross join lateral (
       select address, city, lat, lng from persons
       where workspace_id = $1 and deleted_at is null and lat is not null and lower(address) = k.a limit 5) as x`,
    [workspaceId, lowers],
  )).rows) if (!known.has(keyOf(r))) known.set(keyOf(r), { lat: r.lat, lng: r.lng });

  const toLook = [...groups.values()].filter((g) => !known.has(g.key));
  const concurrency = Math.min(Math.max(Number(process.env.GEOCODE_CONCURRENCY) || 6, 1), 20);
  // The building, not the unit: one pin per address.
  const found = await pool(toLook, concurrency, (g) => geocodeAddress({ address: g.first.address, city: g.first.city, postal: g.first.postal }));

  let located = 0; let copied = 0; let missed = 0; let errors = 0; let lastError = null; let busy = false;
  const now = new Date().toISOString();
  // Every lookup failed: the service is down or busy, not these addresses —
  // nobody's tries are spent (the run backs off and, if it lasts, pauses).
  const outage = toLook.length > 0 && found.every((r) => r?.error);
  await runAction(db, { workspaceId, actorId, action: 'person.geocode' }, async (tx, emit) => {
    const place = async (g, lat, lng, geo) => {
      const ids = [...g.ids];
      const { rows } = await tx.query(
        `update persons set lat = $3, lng = $4, attrs = jsonb_set(attrs, '{geocode}', $5::jsonb), updated_at = now()
         where workspace_id = $1 and id = any($2::uuid[]) and lat is null returning id`,
        [workspaceId, ids, lat, lng, JSON.stringify(geo)],
      );
      for (const r of rows) emit('person', r.id, 'update', { lat, lng, geocoded: geo.matched || null });
      return rows.length;
    };
    const mark = (g, geo) => tx.query(
      `update persons set attrs = jsonb_set(attrs, '{geocode}', $3::jsonb)
       where workspace_id = $1 and id = any($2::uuid[]) and lat is null`,
      [workspaceId, [...g.ids], JSON.stringify(geo)],
    );
    for (const g of groups.values()) {
      const pin = known.get(g.key);
      if (pin) copied += await place(g, pin.lat, pin.lng, { status: 'ok', at: now, copied: true });
    }
    for (const [i, g] of toLook.entries()) {
      const r = found[i];
      if (r?.error) {
        errors += 1;
        lastError = r.error;
        if (/429|too many/i.test(r.error)) busy = true;
        if (outage) continue;
        const tries = g.tries + 1;
        // Kept waiting for another round, or set aside after too many tries.
        await mark(g, tries >= GEO_MAX_TRIES ? { status: 'failed', at: now, error: r.error, tries } : { status: '', at: now, error: r.error, tries });
        if (tries >= GEO_MAX_TRIES) missed += g.ids.size;
      } else if (r && !r.weak) {
        located += await place(g, r.lat, r.lng, { status: 'ok', at: now, matched: r.matched, score: r.score });
      } else {
        await mark(g, { status: r?.weak ? 'weak' : 'nomatch', at: now, matched: r?.matched || null });
        missed += g.ids.size;
      }
    }
  });
  return { done: false, looked: groups.size, located, copied, missed, errors, lastError, busy };
};

const pendingCount = async (db, workspaceId) =>
  (await db.query(`select count(*)::int as n from persons where ${PENDING}`, [workspaceId])).rows[0].n;

// PGlite runs no autovacuum: a table never analyzed looks empty to the
// planner, which then ignores the indexes (see statsReady in routes/data.js).
const statsReady = async (db) => {
  try {
    const idx = (await db.query(`select reltuples from pg_class where oid = 'persons_ws_addr_idx'::regclass`)).rows[0];
    if (idx && Number(idx.reltuples) <= 0) await db.query('analyze persons');
  } catch { /* only a speed-up */ }
};

// The job: rounds until the budget is spent, then the next job is queued.
export const jobs = {
  [KIND]: async (db, job) => {
    const workspaceId = job.workspace_id;
    await statsReady(db);
    const until = Date.now() + ROUND_BUDGET_MS;
    for (;;) {
      const run = await getRun(db, workspaceId);
      if (!run || run.state !== 'running') return; // stopped (or paused) from the desk
      const r = await geocodeRound(db, workspaceId, run.started_by);
      if (r.done) { await setRun(db, workspaceId, { state: 'done', last_error: null }); return; }
      const progressed = r.located + r.copied + r.missed > 0;
      const bad = progressed ? 0 : run.bad_rounds + 1;
      await db.query(
        `update geocode_runs set located = located + $2, copied = copied + $3, missed = missed + $4, errors = errors + $5,
           bad_rounds = $6, last_error = coalesce($7, last_error), updated_at = now() where workspace_id = $1`,
        [workspaceId, r.located, r.copied, r.missed, r.errors, bad, r.lastError],
      );
      if (bad >= PAUSE_AFTER) { await setRun(db, workspaceId, { state: 'paused' }); return; }
      if (!progressed || r.busy) {
        // Nothing worked (the service is down or busy): wait longer each time.
        const wait = backoffMs() * Math.max(bad, 1);
        await enqueueJob(db, { workspaceId, kind: KIND, runAt: new Date(Date.now() + wait).toISOString() });
        if (!wait) runJobsSoon();
        return;
      }
      if (Date.now() > until) { await enqueueJob(db, { workspaceId, kind: KIND }); runJobsSoon(); return; }
    }
  },
};

export const deskOnlyReads = ['/geocode/status'];

export const api = new Hono();

const deskOnly = (c) => (DESK.includes(c.get('ctx').role) ? null : c.json({ error: 'only campaign staff can place people on the map' }, 403));

const status = async (db, workspaceId) => {
  const run = await getRun(db, workspaceId);
  const unmatched = (await db.query(
    `select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and lat is null
       and attrs->'geocode'->>'status' in ('nomatch', 'weak', 'failed')`,
    [workspaceId],
  )).rows[0].n;
  return {
    state: run?.state || 'idle',
    started_at: run?.started_at || null,
    updated_at: run?.updated_at || null,
    located: run?.located || 0,
    copied: run?.copied || 0,
    missed: run?.missed || 0,
    errors: run?.errors || 0,
    lastError: run?.last_error || null,
    remaining: await pendingCount(db, workspaceId),
    unmatched,
    jobs: jobRunnerOn(),
  };
};

api.get('/geocode/status', async (c) => {
  const denied = deskOnly(c);
  if (denied) return denied;
  return c.json(await status(c.get('db'), c.get('ctx').workspaceId));
});

api.post('/geocode/start', async (c) => {
  const denied = deskOnly(c);
  if (denied) return denied;
  const ctx = c.get('ctx');
  const db = c.get('db');
  if ((process.env.GEOCODER || '').toLowerCase() === 'off') {
    return c.json({ error: 'geocoding is turned off (GEOCODER=off)', off: true }, 409);
  }
  // Without the job runner (STARBASE_JOBS=off) nothing would ever pick the
  // run up: the page falls back to looking up batches itself.
  if (!jobRunnerOn()) return c.json({ error: 'background jobs are off', jobsOff: true }, 409);
  const run = await getRun(db, ctx.workspaceId);
  if (run?.state === 'running') return c.json(await status(db, ctx.workspaceId));
  await db.transaction(async (tx) => {
    // A fresh run counts from zero; Carry on after Stop or a pause keeps counting.
    const fresh = !run || run.state === 'done' || run.state === 'idle';
    await tx.query(
      `insert into geocode_runs (workspace_id, state, started_by, started_at)
       values ($1, 'running', $2, now())
       on conflict (workspace_id) do update set state = 'running', started_by = $2, bad_rounds = 0, last_error = null,
         updated_at = now()${fresh ? ', started_at = now(), located = 0, copied = 0, missed = 0, errors = 0' : ''}`,
      [ctx.workspaceId, ctx.user.id],
    );
    await enqueueJob(tx, { workspaceId: ctx.workspaceId, kind: KIND });
  });
  runJobsSoon();
  return c.json(await status(db, ctx.workspaceId));
});

api.post('/geocode/stop', async (c) => {
  const denied = deskOnly(c);
  if (denied) return denied;
  const ctx = c.get('ctx');
  const db = c.get('db');
  await setRun(db, ctx.workspaceId, { state: 'stopped' }).catch(() => {});
  return c.json(await status(db, ctx.workspaceId));
});
