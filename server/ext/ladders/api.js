// Desk reads for ladders (mounted under /api, signed in). Volunteers are
// refused all of them — here and by deskOnlyReads in index.js.
//
//   GET /ladders                    the list with counts, open follow-ups,
//                                   engagement levels, and the builder's
//                                   pickers (petitions, events, tags)
//   GET /ladders/followups          open follow-ups (+ the last done)
//   GET /ladders/followups/count    { open } for Today
//   GET /ladders/:id                one ladder + who's on it, and where
//   GET /persons/:id/ladders        a person's level and their ladders
import { Hono } from 'hono';
import { emailConfigured } from '../../lib/notify.js';
import { TRIGGERS, parseJson } from './shape.js';
import { levelFor, levelCounts } from './levels.js';

export const api = new Hono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

api.use('/ladders/*', async (c, next) => {
  if (c.get('ctx').role === 'volunteer') return c.json({ error: 'volunteers cannot view this' }, 403);
  await next();
});
api.use('/ladders', async (c, next) => {
  if (c.get('ctx').role === 'volunteer') return c.json({ error: 'volunteers cannot view this' }, 403);
  await next();
});

// What the builder can point a trigger at.
const options = async (db, ws) => ({
  petitions: (await db.query(
    'select slug, title, active from petitions where workspace_id = $1 order by created_at desc limit 100', [ws],
  )).rows,
  events: (await db.query(
    `select id, title, starts_at from campaign_events where workspace_id = $1 and deleted_at is null
     order by starts_at desc limit 100`, [ws],
  )).rows,
  tags: (await db.query(
    `select t, count(*)::int as n from persons p, jsonb_array_elements_text(
       case when jsonb_typeof(p.tags) = 'array' then p.tags else '[]'::jsonb end) as t
     where p.workspace_id = $1 and p.deleted_at is null and t <> 'sample'
     group by t order by n desc, t limit 100`, [ws],
  )).rows.map((r) => r.t),
});

// "Fix 72 Ave", "Town hall", "host": the thing a trigger names, in words.
const triggerWhat = (l, opts) => {
  if (!l.trigger_ref) return null;
  if (l.trigger_kind === 'petition') return opts.petitions.find((p) => p.slug === l.trigger_ref)?.title || l.trigger_ref;
  if (l.trigger_kind === 'rsvp') return opts.events.find((e) => e.id === l.trigger_ref)?.title || 'an event';
  return l.trigger_ref;
};

const ladderOut = (l, opts) => ({
  id: l.id,
  name: l.name,
  trigger: { kind: l.trigger_kind, ref: l.trigger_ref || null, label: TRIGGERS[l.trigger_kind]?.label || l.trigger_kind, what: triggerWhat(l, opts) },
  steps: parseJson(l.steps, []),
  active: l.active,
  reentry: l.reentry,
  created_at: l.created_at,
});

// In progress (on it, paused included) · finished · waiting on email, per ladder.
const runCounts = async (db, ws, ladderId = null) => Object.fromEntries((await db.query(
  `select ladder_id,
     (count(*) filter (where status <> 'done'))::int as in_progress,
     (count(*) filter (where status = 'done'))::int as finished,
     (count(*) filter (where status <> 'done' and wait = 'email'))::int as waiting_email
   from ladder_runs r join persons p on p.id = r.person_id and p.deleted_at is null
   where r.workspace_id = $1 and ($2::uuid is null or r.ladder_id = $2)
   group by ladder_id`,
  [ws, ladderId],
)).rows.map((r) => [r.ladder_id, r]));

api.get('/ladders', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const opts = await options(db, ws);
  const rows = (await db.query(
    'select * from ladders where workspace_id = $1 and deleted_at is null order by created_at', [ws],
  )).rows;
  const counts = await runCounts(db, ws);
  const open = (await db.query(
    "select count(*)::int as n from ladder_followups where workspace_id = $1 and status = 'open'", [ws],
  )).rows[0].n;
  return c.json({
    ladders: rows.map((l) => ({
      ...ladderOut(l, opts),
      inProgress: counts[l.id]?.in_progress || 0,
      finished: counts[l.id]?.finished || 0,
      waitingEmail: counts[l.id]?.waiting_email || 0,
    })),
    followups: open,
    levels: await levelCounts(db, ws),
    emailConfigured: emailConfigured(),
    options: opts,
  });
});

const followupRow = (r) => ({
  id: r.id, text: r.text, status: r.status, created_at: r.created_at, done_at: r.done_at,
  person: { id: r.person_id, name: r.person_name, phone: r.person_phone },
  ladder: r.ladder_id ? { id: r.ladder_id, name: r.ladder_name } : null,
});

api.get('/ladders/followups/count', async (c) => {
  const ctx = c.get('ctx');
  const n = (await c.get('db').query(
    `select count(*)::int as n from ladder_followups f join persons p on p.id = f.person_id
     where f.workspace_id = $1 and f.status = 'open' and p.deleted_at is null`, [ctx.workspaceId],
  )).rows[0].n;
  return c.json({ open: n });
});

api.get('/ladders/followups', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const sel = `select f.*, p.name as person_name, p.phone as person_phone, l.name as ladder_name
    from ladder_followups f join persons p on p.id = f.person_id and p.deleted_at is null
    left join ladders l on l.id = f.ladder_id
    where f.workspace_id = $1`;
  const open = (await db.query(`${sel} and f.status = 'open' order by f.created_at limit 500`, [ctx.workspaceId])).rows;
  const done = (await db.query(`${sel} and f.status = 'done' order by f.done_at desc limit 50`, [ctx.workspaceId])).rows;
  return c.json({ open: open.map(followupRow), done: done.map(followupRow) });
});

// Where a run is, from its row and log: what the screens need to say it.
const runOut = (r, steps) => {
  const log = parseJson(r.log, []);
  return {
    id: r.id,
    status: r.status,
    step: Number(r.step),
    steps: steps.length,
    stepKind: steps[r.step]?.kind || null,
    wait: r.wait || null,
    next_at: r.next_at || null,
    last: log.length ? log[log.length - 1] : null,
    skipped: log.filter((e) => e.result === 'skipped').map((e) => ({ step: e.step, kind: e.kind, reason: e.reason })),
    // What each step did (kind, result, reason, when) — no addresses, no
    // message text. 'Sending' shows only while it's the latest word.
    log: log.filter((e, i) => e.result !== 'sending' || i === log.length - 1).slice(-20).map((e) => ({ step: e.step, kind: e.kind, result: e.result, reason: e.reason || null, tag: e.tag || null, until: e.until || null, at: e.at })),
    started_at: r.started_at,
    finished_at: r.finished_at || null,
  };
};

api.get('/ladders/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const l = (await db.query(
    'select * from ladders where id = $1 and workspace_id = $2 and deleted_at is null', [id, ctx.workspaceId],
  )).rows[0];
  if (!l) return c.json({ error: 'not found' }, 404);
  const opts = await options(db, ctx.workspaceId);
  const ladder = ladderOut(l, opts);
  const runs = (await db.query(
    `select r.*, p.name as person_name from ladder_runs r join persons p on p.id = r.person_id and p.deleted_at is null
     where r.workspace_id = $1 and r.ladder_id = $2
     order by (r.status = 'done'), r.started_at desc limit 500`,
    [ctx.workspaceId, l.id],
  )).rows;
  const counts = (await runCounts(db, ctx.workspaceId, l.id))[l.id];
  // Email steps go only to these: addresses on the list as subscribed.
  const emailYes = (await db.query(
    "select count(*)::int as n from subscriptions where workspace_id = $1 and status = 'subscribed'", [ctx.workspaceId],
  )).rows[0].n;
  return c.json({
    ladder: {
      ...ladder,
      inProgress: counts?.in_progress || 0,
      finished: counts?.finished || 0,
      waitingEmail: counts?.waiting_email || 0,
    },
    people: runs.map((r) => ({ ...runOut(r, ladder.steps), person: { id: r.person_id, name: r.person_name } })),
    emailConfigured: emailConfigured(),
    emailYes,
    options: opts,
  });
});

api.get('/persons/:id/ladders', async (c) => {
  const id = c.req.param('id');
  const ctx = c.get('ctx');
  if (ctx.role === 'volunteer') return c.json({ error: 'volunteers cannot view this' }, 403);
  if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
  const db = c.get('db');
  const level = await levelFor(db, ctx.workspaceId, id);
  if (!level) return c.json({ error: 'not found' }, 404);
  const runs = (await db.query(
    `select r.*, l.name as ladder_name, l.steps as ladder_steps, l.active as ladder_active
     from ladder_runs r join ladders l on l.id = r.ladder_id and l.deleted_at is null
     where r.workspace_id = $1 and r.person_id = $2 order by r.started_at desc limit 50`,
    [ctx.workspaceId, id],
  )).rows;
  const open = (await db.query(
    "select id, text, created_at from ladder_followups where workspace_id = $1 and person_id = $2 and status = 'open' order by created_at",
    [ctx.workspaceId, id],
  )).rows;
  return c.json({
    level,
    runs: runs.map((r) => ({
      ...runOut(r, parseJson(r.ladder_steps, [])),
      ladder: { id: r.ladder_id, name: r.ladder_name, active: r.ladder_active },
    })),
    followups: open,
    emailConfigured: emailConfigured(),
  });
});
