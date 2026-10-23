// Finding people: the signed-in person's own record, and whether someone
// typed into "My people" is already on the list.
//
// The same keys as the import's dedupe (routes/data.js): email, then name +
// phone — names compared case-insensitively with runs of spaces as one,
// phones by their digits (the last ten, so "+1 604…" is "604…"). Oldest first.
// The desk matches on the email alone. A volunteer never matches on an email
// the campaign holds — not alone, not with the name: a match (or a miss)
// would tell them whether their guess at someone's email was right, and they
// never see anyone else's. They match on name + phone (a phone they see
// anyway), on name + an email they typed themselves for someone they brought
// in (attrs.typed_email on their own add — never another volunteer's, which
// would tell them what someone else typed), or on their own email (that's
// them).
import { newId } from '../../lib/events.js';
import { loginEmail } from '../../lib/viewer.js';

export const nameKey = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
export const phoneKey = (s) => {
  const d = String(s ?? '').replace(/\D+/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
};
export const emailKey = (s) => String(s ?? '').trim().toLowerCase();

const NAME_SQL = `lower(regexp_replace(trim(name), '\\s+', ' ', 'g'))`;
const PHONE_SQL = `right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10)`;

const first = async (tx, sql, params) => (await tx.query(
  `select id, name, email, phone, address, unit, rating, rated_at, tags from persons
   where workspace_id = $1 and deleted_at is null and ${sql}
   order by created_at, id limit 1`,
  params,
)).rows[0] || null;

// { name, phone?, email? } → the person already on the list, or null.
// fromId: whose people it goes on (a volunteer's own record).
export const findKnown = async (tx, ctx, { name, phone, email }, fromId = null) => {
  const ws = ctx.workspaceId;
  const n = nameKey(name);
  const e = emailKey(email);
  const ph = phoneKey(phone);
  const vol = ctx.role === 'volunteer';
  if (e && (!vol || e === loginEmail(ctx))) {
    const hit = await first(tx, 'lower(email) = $2', [ws, e]);
    if (hit) return hit;
  }
  if (ph.length >= 7) {
    const hit = await first(tx, `${NAME_SQL} = $2 and ${PHONE_SQL} = $3`, [ws, n, ph]);
    if (hit) return hit;
  }
  // Last, someone this volunteer brought in with this name and email (not
  // the record the campaign holds: name + phone finds that one first; not
  // another volunteer's add: right or wrong, their guess finds nothing).
  if (e && vol && fromId) {
    return first(tx, `lower(attrs->>'typed_email') = $2 and ${NAME_SQL} = $3
      and exists (select 1 from relationships r where r.workspace_id = $1 and r.brought_in = persons.id and r.from_person = $4)`,
    [ws, e, n, fromId]);
  }
  return null;
};

// For a volunteer's new person (actions.js): whoever on the list already
// holds the email they typed — the new person doesn't take it — else someone
// with the same name; the oldest, or null. The desk is told "May be the same
// person as …"; the volunteer is told nothing either way.
export const maybeSame = async (tx, ctx, { name, email }, notId) => {
  const e = emailKey(email);
  const pick = (sql, params) => tx.query(
    `select id from persons where workspace_id = $1 and deleted_at is null and id <> $2 and ${sql}
     order by created_at, id limit 1`,
    [ctx.workspaceId, notId, ...params],
  ).then((r) => r.rows[0] || null);
  const holder = e ? await pick('lower(email) = $3', [e]) : null;
  if (holder) return { id: holder.id, email: true };
  const named = await pick(`${NAME_SQL} = $3`, [nameKey(name)]);
  return named ? { id: named.id, email: false } : null;
};

// The signed-in user's own supporter record, matched by login email (oldest
// first) — the same record Shifts' "Count me in" uses. With create, someone
// who isn't on the list yet is added, tagged 'volunteer' whatever their role
// — Count me in's rule (actions/field.js), so the order never matters.
export const selfPerson = async (tx, ctx, emit, { create = false } = {}) => {
  const email = loginEmail(ctx);
  if (!email) return null;
  const found = (await tx.query(
    `select id, name from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null
     order by created_at limit 1`,
    [ctx.workspaceId, email],
  )).rows[0];
  if (found || !create) return found || null;
  const id = newId();
  const tags = ['volunteer'];
  const person = { kind: 'person', name: ctx.user.name || email, email, tags };
  await tx.query(
    'insert into persons (id, workspace_id, kind, name, email, tags) values ($1, $2, $3, $4, $5, $6)',
    [id, ctx.workspaceId, person.kind, person.name, email, JSON.stringify(tags)],
  );
  emit('person', id, 'create', { id, ...person });
  return { id, name: person.name };
};
