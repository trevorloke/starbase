// Who is on a list, and who of them can be reached. One WHERE for a saved
// filter (lib/audience.js personsWhere) or the members of a hand-picked
// list, then the reach: 'email' keeps people with an address who may be
// emailed (not do-not-email, not do-not-contact, not unsubscribed from the
// newsletter list), one row per address; 'phone' keeps people with a number
// that can be texted (not do-not-text, not do-not-contact, not opted out),
// one row per number.
import { personsWhere } from '../../lib/audience.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const parseJ = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };

export const loadList = async (db, ws, id) => {
  if (!UUID.test(String(id || ''))) return null;
  const row = (await db.query('select * from lists where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws])).rows[0];
  return row ? { ...row, filter: parseJ(row.filter, {}) } : null;
};

// The WHERE (alias p) and params for a list, or for a filter on its own.
export const whereFor = async (db, ctx, { list = null, filter = null }) => {
  if (list && list.kind === 'people') {
    return {
      where: 'p.workspace_id = $1 and p.deleted_at is null and exists (select 1 from list_members m where m.list_id = $2 and m.person_id = p.id)',
      params: [ctx.workspaceId, list.id],
    };
  }
  const { where, params } = await personsWhere(db, ctx, list ? list.filter : (filter || {}));
  params[3] = 100000;
  return { where, params };
};

const REACH = {
  email: `and p.email is not null and trim(p.email) <> ''
    and not (p.tags @> '"do-not-email"'::jsonb) and not (p.tags @> '"do-not-contact"'::jsonb)
    and not exists (select 1 from subscriptions s where s.workspace_id = p.workspace_id and s.email = lower(p.email) and s.status = 'unsubscribed')`,
  phone: `and p.phone is not null and trim(p.phone) <> ''
    and not (p.tags @> '"do-not-text"'::jsonb) and not (p.tags @> '"do-not-contact"'::jsonb)`,
};

// Everyone a list names (the people rows), or only those with the reach.
export const peopleOf = async (db, ctx, { list = null, filter = null, reach = null, limit = 100000, offset = 0, q = '' }) => {
  const w = await whereFor(db, ctx, { list, filter });
  let where = w.where;
  const params = [...w.params];
  if (q) { params.push(`%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`); where += ` and (p.name ilike $${params.length} or p.email ilike $${params.length} or p.phone ilike $${params.length})`; }
  if (reach) where += ` ${REACH[reach]}`;
  params.push(limit, offset);
  const { rows } = await db.query(
    `select p.id, p.name, p.email, p.phone, p.address, p.unit, p.city, p.postal, p.rating, p.tags, p.created_at, count(*) over()::int as total
     from persons p where ${where} order by lower(p.name), p.id limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return { people: rows.map((r) => ({ ...r, tags: parseJ(r.tags, []) })), total: rows[0]?.total ?? 0 };
};

// How many a list names, and how many of them can be emailed or texted.
export const countsOf = async (db, ctx, { list = null, filter = null }) => {
  const { where, params } = await whereFor(db, ctx, { list, filter });
  const r = (await db.query(
    `select count(*)::int as total,
       (count(distinct lower(p.email)) filter (where true ${REACH.email}))::int as with_email,
       (count(distinct p.phone) filter (where true ${REACH.phone}))::int as with_phone
     from persons p where ${where}`, params,
  )).rows[0];
  return { total: r.total, with_email: r.with_email, with_phone: r.with_phone };
};

// The recipients of a send: one per address or number, the first person
// (by name) to carry it. Texts also leave out numbers that replied STOP.
export const recipientsOf = async (db, ctx, { list = null, filter = null, reach }) => {
  const { where, params } = await whereFor(db, ctx, { list, filter });
  const { rows } = await db.query(
    `select distinct on (${reach === 'email' ? 'lower(p.email)' : 'p.phone'}) p.id, p.name, p.email, p.phone
     from persons p where ${where} ${REACH[reach]}
     ${reach === 'phone' ? `and not exists (select 1 from texting_optouts o where o.workspace_id = p.workspace_id and o.opted_out
        and right(regexp_replace(o.phone, '\\D', '', 'g'), 10) = right(regexp_replace(regexp_replace(coalesce(p.phone, ''), '\\s*(ext\\.?|x|#).*$', '', 'i'), '\\D', '', 'g'), 10))` : ''}
     order by ${reach === 'email' ? 'lower(p.email)' : 'p.phone'}, lower(p.name), p.id`,
    params,
  );
  return rows;
};

// An audience as a send names it: { list_id } or { filter }.
export const audienceOf = async (db, ctx, audience) => {
  if (audience?.list_id) {
    const list = await loadList(db, ctx.workspaceId, audience.list_id);
    if (!list) return null;
    return { list, filter: null, name: list.name };
  }
  return { list: null, filter: audience?.filter || {}, name: null };
};
