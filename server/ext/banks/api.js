// GET /banks            desk: every phone bank with its counts and who has what
// GET /banks/mine       anyone: the banks with numbers handed to me, how many are left
// GET /banks/:id        desk: one bank — every number, who has it, done or not
// GET /banks/:id/mine   anyone: my numbers in this bank that are left, as people (the Calls screen's list)
import { Hono } from 'hono';
import { forViewer } from '../../lib/viewer.js';

export const api = new Hono();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const isDesk = (ctx) => ctx.role !== 'volunteer';
const COUNTS = `count(n.person_id)::int as total, count(n.assigned_to)::int as assigned, count(n.done_at)::int as done,
  count(*) filter (where n.assigned_to is null and n.done_at is null)::int as open`;

api.get('/banks', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  if (!isDesk(ctx)) return c.json({ error: 'desk only' }, 403);
  const banks = (await db.query(
    `select b.id, b.name, b.script, b.created_at, b.closed_at, u.name as created_by, ${COUNTS}
       from call_banks b left join users u on u.id = b.created_by left join call_bank_numbers n on n.bank_id = b.id
      where b.workspace_id = $1 and b.deleted_at is null group by b.id, u.name order by b.closed_at nulls first, b.created_at desc`, [ws],
  )).rows;
  const callers = (await db.query(
    `select n.bank_id, n.assigned_to as user_id, u.name, count(*)::int as total, count(n.done_at)::int as done
       from call_bank_numbers n join users u on u.id = n.assigned_to where n.workspace_id = $1 and n.assigned_to is not null
      group by n.bank_id, n.assigned_to, u.name order by lower(u.name)`, [ws],
  )).rows;
  return c.json({ banks: banks.map((b) => ({ ...b, closed: !!b.closed_at, callers: callers.filter((x) => x.bank_id === b.id).map(({ bank_id, ...x }) => x) })) });
});

api.get('/banks/mine', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  const rows = (await db.query(
    `select b.id, b.name, b.script, count(*)::int as total, count(n.done_at)::int as done
       from call_bank_numbers n join call_banks b on b.id = n.bank_id
      where n.workspace_id = $1 and n.assigned_to = $2 and b.deleted_at is null and b.closed_at is null
      group by b.id order by b.created_at desc`, [ctx.workspaceId, ctx.user.id],
  )).rows;
  return c.json({ banks: rows.map((b) => ({ ...b, left: b.total - b.done })) });
});

api.get('/banks/:id', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
  if (!isDesk(ctx)) return c.json({ error: 'desk only' }, 403);
  const b = (await db.query(
    `select b.*, ${COUNTS} from call_banks b left join call_bank_numbers n on n.bank_id = b.id
      where b.id = $1 and b.workspace_id = $2 and b.deleted_at is null group by b.id`, [id, ws],
  )).rows[0];
  if (!b) return c.json({ error: 'not found' }, 404);
  const numbers = (await db.query(
    `select n.person_id, n.position, n.assigned_to, n.assigned_at, n.done_at, n.outcome, u.name as caller,
            p.name, p.phone, p.rating, p.address, p.city
       from call_bank_numbers n join persons p on p.id = n.person_id left join users u on u.id = n.assigned_to
      where n.bank_id = $1 order by n.position`, [id],
  )).rows;
  const callers = [];
  for (const n of numbers) {
    if (!n.assigned_to) continue;
    let cl = callers.find((x) => x.user_id === n.assigned_to);
    if (!cl) { cl = { user_id: n.assigned_to, name: n.caller, total: 0, done: 0 }; callers.push(cl); }
    cl.total += 1; if (n.done_at) cl.done += 1;
  }
  const { deleted_at, ...bank } = b;
  return c.json({ bank: { ...bank, closed: !!b.closed_at, callers: callers.sort((a, z) => a.name.localeCompare(z.name)) }, numbers });
});

api.get('/banks/:id/mine', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  const id = c.req.param('id');
  if (!UUID.test(id)) return c.json({ error: 'not found' }, 404);
  const b = (await db.query('select id, name, script, closed_at from call_banks where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws])).rows[0];
  if (!b) return c.json({ error: 'not found' }, 404);
  const rows = (await db.query(
    `select p.id, p.name, p.email, p.phone, p.address, p.house_number, p.unit, p.city, p.postal, p.lat, p.lng, p.tags, p.socials, p.rating, p.rated_at,
            p.attrs->>'note' as note, n.done_at, n.position
       from call_bank_numbers n join persons p on p.id = n.person_id
      where n.bank_id = $1 and n.assigned_to = $2 and p.deleted_at is null order by n.position`, [id, ctx.user.id],
  )).rows;
  const persons = rows.filter((r) => !r.done_at).map(({ done_at, position, ...p }) => ({ ...p, tags: parseJ(p.tags, []), socials: parseJ(p.socials, {}) })).map(forViewer(ctx));
  return c.json({ bank: { id: b.id, name: b.name, script: b.script, closed: !!b.closed_at, total: rows.length, done: rows.filter((r) => r.done_at).length }, persons });
});
