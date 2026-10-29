// Reports and exports, for the desk (the data area).
//   GET /reports                 the campaign in numbers: people by rating, tags, cities,
//                                people added by week, contacts by week and channel,
//                                donations by month, members, the newsletter list, sends
//   GET /reports/:name.csv       one of them as a spreadsheet
//   GET /export/:dataset.csv     a whole table as a spreadsheet: people, gifts, pledges,
//                                subscribers, signatures, rsvps, members, orders, contacts, lists
// Volunteers are refused all of it. The full JSON export stays at GET /export.
import { Hono } from 'hono';
import { csvResponse } from '../../lib/csv.js';
import { loadScale } from '../scale/rules.js';

export const api = new Hono();
const DESK = ['manager', 'treasurer', 'staff'];
const refuse = (c) => c.json({ error: 'desk only' }, 403);
const j = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));
const ratingWord = (scale, code) => scale?.steps?.find((s) => s.code === code)?.word || scale?.candidates?.find((x) => x.code === code)?.name || code;

const REPORTS = {
  // People by rating, the campaign's words on each.
  rating: async (db, ws, ctx) => {
    const scale = await loadScale(db, ws).catch(() => null);
    const rows = (await db.query(
      `select coalesce(rating, 'unrated') as code, count(*)::int as n from persons where workspace_id = $1 and deleted_at is null group by 1 order by 1`, [ws],
    )).rows;
    return { head: ['Rating', 'Code', 'People'], rows: rows.map((r) => [r.code === 'unrated' ? 'Not rated' : ratingWord(scale, r.code), r.code, r.n]) };
  },
  tags: async (db, ws) => ({
    head: ['Tag', 'People'],
    rows: (await db.query(
      `select t.tag, count(*)::int as n from persons p, jsonb_array_elements_text(p.tags) t(tag)
       where p.workspace_id = $1 and p.deleted_at is null group by t.tag order by n desc, t.tag limit 100`, [ws],
    )).rows.map((r) => [r.tag, r.n]),
  }),
  cities: async (db, ws) => ({
    head: ['City', 'People'],
    rows: (await db.query(
      `select coalesce(nullif(trim(city), ''), '(no city)') as city, count(*)::int as n from persons
       where workspace_id = $1 and deleted_at is null group by 1 order by n desc limit 30`, [ws],
    )).rows.map((r) => [r.city, r.n]),
  }),
  'people-by-week': async (db, ws) => ({
    head: ['Week of', 'People added'],
    rows: (await db.query(
      `select date_trunc('week', created_at)::date as week, count(*)::int as n from persons
       where workspace_id = $1 and deleted_at is null and created_at > now() - interval '12 weeks' group by 1 order by 1`, [ws],
    )).rows.map((r) => [day(r.week), r.n]),
  }),
  contacts: async (db, ws) => ({
    head: ['Week of', 'Doors', 'Calls', 'Texts', 'Reached', 'No answer', 'Refused'],
    rows: (await db.query(
      `select date_trunc('week', created_at)::date as week,
         (count(*) filter (where channel = 'door'))::int as doors, (count(*) filter (where channel = 'phone'))::int as calls,
         (count(*) filter (where channel = 'text'))::int as texts, (count(*) filter (where outcome = 'contacted'))::int as reached,
         (count(*) filter (where outcome = 'no_answer'))::int as no_answer, (count(*) filter (where outcome = 'refused'))::int as refused
       from contacts where workspace_id = $1 and created_at > now() - interval '8 weeks' group by 1 order by 1`, [ws],
    )).rows.map((r) => [day(r.week), r.doors, r.calls, r.texts, r.reached, r.no_answer, r.refused]),
  }),
  donations: async (db, ws) => ({
    head: ['Month', 'Gifts', 'Donors', 'Total ($)'],
    rows: (await db.query(
      `select to_char(date, 'YYYY-MM') as month, count(*)::int as gifts, count(distinct person_id)::int as donors, (sum(amount_cents) / 100.0)::numeric(12,2) as total
       from gifts where workspace_id = $1 and deleted_at is null and date >= date_trunc('year', current_date) - interval '1 year' group by 1 order by 1`, [ws],
    )).rows.map((r) => [r.month, r.gifts, r.donors, Number(r.total)]),
  }),
  members: async (db, ws) => ({
    head: ['Status', 'Members'],
    rows: (await db.query(
      `select case when status = 'active' and expires_at < now() then 'expired' else status end as status, count(*)::int as n
       from members where workspace_id = $1 group by 1 order by 1`, [ws],
    )).rows.map((r) => [r.status === 'pending_payment' ? 'fee owing' : r.status, r.n]),
  }),
  subscribers: async (db, ws) => ({
    head: ['Month', 'Joined', 'Left'],
    rows: (await db.query(
      `select to_char(created_at, 'YYYY-MM') as month, count(*)::int as joined,
         (count(*) filter (where status = 'unsubscribed'))::int as left_
       from subscriptions where workspace_id = $1 and created_at > now() - interval '12 months' group by 1 order by 1`, [ws],
    )).rows.map((r) => [r.month, r.joined, r.left_]),
  }),
  sends: async (db, ws) => ({
    head: ['Sent', 'Kind', 'Subject', 'To', 'Reached', 'Failed', 'Status'],
    rows: (await db.query(
      `select b.created_at, b.kind, b.subject, b.audience_count, b.status,
         (select count(*) from blast_recipients r where r.blast_id = b.id and r.status = 'sent')::int as sent,
         (select count(*) from blast_recipients r where r.blast_id = b.id and r.status = 'failed')::int as failed
       from blasts b where b.workspace_id = $1 order by b.created_at desc limit 50`, [ws],
    )).rows.map((r) => [r.created_at, r.kind, r.subject, r.audience_count, r.sent, r.failed, r.status]),
  }),
};

const totals = async (db, ws) => {
  const one = async (sql) => (await db.query(sql, [ws])).rows[0];
  const p = await one(`select count(*)::int as total, (count(*) filter (where rating is not null))::int as rated,
    (count(*) filter (where email is not null))::int as with_email, (count(*) filter (where phone is not null))::int as with_phone
    from persons where workspace_id = $1 and deleted_at is null`);
  const c = await one(`select count(*)::int as total, (count(*) filter (where created_at > now() - interval '7 days'))::int as week from contacts where workspace_id = $1`);
  const g = await one(`select count(*)::int as gifts, coalesce(sum(amount_cents), 0)::bigint as cents, count(distinct person_id)::int as donors
    from gifts where workspace_id = $1 and deleted_at is null and date >= date_trunc('year', current_date)`);
  const s = await one(`select (count(*) filter (where status = 'subscribed'))::int as subscribed, (count(*) filter (where status = 'unsubscribed'))::int as unsubscribed from subscriptions where workspace_id = $1`);
  const m = await one(`select (count(*) filter (where status = 'active' and (expires_at is null or expires_at >= now())))::int as active from members where workspace_id = $1`);
  return {
    people: p, contacts: c, donations: { gifts: g.gifts, cents: Number(g.cents), donors: g.donors },
    newsletter: s, members: { active: m.active },
  };
};

api.get('/reports', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db'); const ws = ctx.workspaceId;
  if (!DESK.includes(ctx.role)) return refuse(c);
  const out = { totals: await totals(db, ws), reports: {} };
  for (const [name, fn] of Object.entries(REPORTS)) out.reports[name] = await fn(db, ws, ctx);
  return c.json(out);
});

api.get('/reports/:name', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  if (!DESK.includes(ctx.role)) return refuse(c);
  const name = c.req.param('name').replace(/\.csv$/, '');
  const fn = REPORTS[name];
  if (!fn) return c.json({ error: 'no such report' }, 404);
  const r = await fn(db, ctx.workspaceId, ctx);
  return csvResponse(c, `report-${name}`, r.head, r.rows);
});

// Whole tables, every column a spreadsheet can hold; never a secret token.
const DATASETS = {
  people: { sql: `select p.name, p.email, p.phone, p.address, p.house_number, p.unit, p.city, p.postal, p.rating, p.rated_at, p.tags, p.lat, p.lng, p.kind, p.created_at
    from persons p where p.workspace_id = $1 and p.deleted_at is null order by lower(p.name)`, tags: true },
  gifts: { sql: `select p.name as donor, p.email, g.amount_cents / 100.0 as amount, g.date, g.method, g.cadence, g.note, g.flagged, g.flag_reason, g.created_at
    from gifts g join persons p on p.id = g.person_id where g.workspace_id = $1 and g.deleted_at is null order by g.date desc` },
  pledges: { sql: `select name, email, phone, address, amount_cents / 100.0 as amount, cadence, status, last_received_on, created_at
    from pledges where workspace_id = $1 order by created_at desc` },
  subscribers: { sql: `select email, name, status, source, created_at, unsubscribed_at from subscriptions where workspace_id = $1 order by created_at desc` },
  signatures: { sql: `select t.title as petition, s.name, s.email, s.phone, s.address, s.subscribe, s.created_at
    from petition_signatures s join petitions t on t.id = s.petition_id where s.workspace_id = $1 order by s.created_at desc` },
  rsvps: { sql: `select e.title as event, e.starts_at, r.name, r.email, r.phone, r.guests, r.status, r.created_at
    from event_rsvps r join campaign_events e on e.id = r.event_id where r.workspace_id = $1 order by e.starts_at desc, r.created_at` },
  members: { sql: `select p.name, p.email, p.phone, p.city, p.postal, m.status, m.fee_cents / 100.0 as fee, m.voting_eligible, m.starts_at, m.expires_at, m.details, m.created_at
    from members m join persons p on p.id = m.person_id where m.workspace_id = $1 order by m.created_at desc` },
  orders: { sql: `select created_at, status, fulfilment, buyer_name, email, phone, subtotal_cents / 100.0 as subtotal, shipping_cents / 100.0 as shipping, total_cents / 100.0 as total, items, paid_at
    from store_orders where workspace_id = $1 and status <> 'pending' order by created_at desc` },
  contacts: { sql: `select p.name, c.channel, c.outcome, c.rating, c.note, u.name as by_name, c.created_at
    from contacts c join persons p on p.id = c.person_id left join users u on u.id = c.created_by where c.workspace_id = $1 order by c.created_at desc` },
  lists: { sql: `select l.name as list, l.kind, p.name, p.email, p.phone from list_members m join lists l on l.id = m.list_id join persons p on p.id = m.person_id
    where m.workspace_id = $1 and l.deleted_at is null order by lower(l.name), lower(p.name)` },
};
const cell = (v) => (v && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
api.get('/export/:dataset', async (c) => {
  const ctx = c.get('ctx'); const db = c.get('db');
  if (!DESK.includes(ctx.role)) return refuse(c);
  const name = c.req.param('dataset').replace(/\.csv$/, '');
  const ds = DATASETS[name];
  if (!ds) return c.json({ error: 'no such export' }, 404);
  const { rows } = await db.query(ds.sql, [ctx.workspaceId]);
  const head = rows.length ? Object.keys(rows[0]) : [];
  return csvResponse(c, `starbase-${name}`, head, rows.map((r) => head.map((k) => (k === 'tags' ? j(r[k], []).join('; ') : cell(r[k])))));
});
export const DATASET_NAMES = Object.keys(DATASETS);
export const REPORT_NAMES = Object.keys(REPORTS);
