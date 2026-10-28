// GET /membership             desk: every membership with the person, status as it stands today, counts
//     ?status=active|pending_payment|expired|cancelled|all   (default: active and pending)
//     ?person=<id>            one person's memberships (the profile)
//     ?q=<words>              name or email
import { Hono } from 'hono';
import { statusNow } from './rules.js';

export const api = new Hono();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESK = ['manager', 'treasurer', 'staff'];

api.get('/membership', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  if (!DESK.includes(ctx.role)) return c.json({ error: 'desk only' }, 403);
  const person = c.req.query('person');
  const q = String(c.req.query('q') || '').trim().toLowerCase();
  const status = String(c.req.query('status') || '').trim();
  const params = [ws];
  let where = 'm.workspace_id = $1 and p.deleted_at is null';
  if (person) {
    if (!UUID.test(person)) return c.json({ members: [], counts: null });
    params.push(person); where += ` and m.person_id = $${params.length}`;
  }
  if (q) { params.push(`%${q}%`); where += ` and (lower(p.name) like $${params.length} or lower(coalesce(p.email, '')) like $${params.length})`; }
  const rows = (await db.query(
    `select m.*, p.name, p.email, p.phone, p.city, p.postal, p.tags
     from members m join persons p on p.id = m.person_id
     where ${where} order by m.created_at desc limit 2000`, params,
  )).rows.map((m) => ({
    id: m.id, person_id: m.person_id, name: m.name, email: m.email, phone: m.phone, city: m.city, postal: m.postal,
    status: statusNow(m), stored_status: m.status, fee_cents: m.fee_cents, voting_eligible: m.voting_eligible,
    starts_at: m.starts_at, expires_at: m.expires_at, pledge_id: m.pledge_id, note: m.note,
    details: typeof m.details === 'string' ? JSON.parse(m.details) : (m.details || {}), created_at: m.created_at,
  }));
  const counts = { active: 0, pending_payment: 0, expired: 0, cancelled: 0, voting: 0 };
  for (const m of rows) { counts[m.status] += 1; if (m.status === 'active' && m.voting_eligible) counts.voting += 1; }
  const keep = status === 'all' ? rows : status ? rows.filter((m) => m.status === status) : rows.filter((m) => ['active', 'pending_payment'].includes(m.status));
  return c.json({ members: keep, counts });
});
