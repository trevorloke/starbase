// Profile field reads, mounted under /api (signed in).
//
//   GET /fields               desk: every field — on the profile first (in
//                             order), then taken off — with how many people
//                             have it filled in, each choice's count, and the
//                             most common values of a Text or Number field
//                             (the People filter offers those)
//   GET /fields/:id           any role: one field's name and kind, for the
//                             words on a People / Calls filter chip. A
//                             volunteer only gets a field on the profile
//                             marked "Volunteers can see this" (any other
//                             is not found) — the same names their profiles
//                             already show them.
//   GET /persons/:id/fields   any role: this person's fields and values.
//                             The desk gets every field on the profile (empty
//                             ones too, to fill in); a volunteer only the
//                             filled-in ones a manager marked "Volunteers can
//                             see this", and only their words.
//
// Counts are of every value on record (a person since taken off the list
// included): the same count that keeps a field's kind fixed. /fields is a
// desk-only read (index.js) and the handler checks the role again.
import { Hono } from 'hono';
import { fieldOut } from './actions.js';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMON_MAX = 8;

api.get('/fields', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role === 'volunteer') return c.json({ error: 'volunteers cannot view this' }, 403);
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const fields = (await db.query(
    `select f.*, (select count(*)::int from person_field_values v
                  where v.workspace_id = f.workspace_id and v.field_id = f.id) as filled
     from person_fields f where f.workspace_id = $1
     order by (f.retired_at is not null), f.position, f.created_at`,
    [ws],
  )).rows;
  // Each choice's count (Pick one, Yes/No): a few rows per field.
  const counts = (await db.query(
    `select v.field_id, v.value, count(*)::int as n from person_field_values v
     join person_fields f on f.id = v.field_id and f.kind in ('choice', 'yesno')
     where v.workspace_id = $1 group by v.field_id, v.value`,
    [ws],
  )).rows;
  // What a filter can find (Text, Number): the most common values on people
  // still on the list — text in any case ("punjabi" and "Punjabi" are one).
  const common = (await db.query(
    `select field_id, kind, words, n from (
       select v.field_id, f.kind, min(v.value #>> '{}') as words, count(*)::int as n,
              row_number() over (partition by v.field_id order by count(*) desc, min(v.value #>> '{}')) as r
       from person_field_values v
       join persons p on p.id = v.person_id and p.deleted_at is null
       join person_fields f on f.id = v.field_id and f.kind in ('text', 'number')
       where v.workspace_id = $1
       group by v.field_id, f.kind, case when f.kind = 'text' then lower(v.value #>> '{}') else v.value #>> '{}' end
     ) t where r <= $2 order by field_id, r`,
    [ws, COMMON_MAX],
  )).rows;
  return c.json({
    fields: fields.map((f) => {
      const out = { ...fieldOut(f), filled: f.filled };
      if (f.kind === 'choice' || f.kind === 'yesno') {
        out.uses = counts.filter((r) => r.field_id === f.id).map((r) => ({ value: r.value, n: r.n }));
      }
      if (f.kind === 'text' || f.kind === 'number') {
        out.common = common.filter((r) => r.field_id === f.id)
          .map((r) => ({ value: r.kind === 'number' ? Number(r.words) : r.words, n: r.n }));
      }
      return out;
    }),
  });
});

api.get('/fields/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id || '')) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const f = (await c.get('db').query(
    'select id, name, kind, volunteers, retired_at from person_fields where id = $1 and workspace_id = $2', [id, ctx.workspaceId],
  )).rows[0];
  if (!f || (ctx.role === 'volunteer' && (!f.volunteers || f.retired_at))) return c.json({ error: 'not found' }, 404);
  return c.json({ field: { id: f.id, name: f.name, kind: f.kind } });
});

api.get('/persons/:id/fields', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id || '')) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const person = (await db.query(
    'select id from persons where id = $1 and workspace_id = $2 and deleted_at is null', [id, ctx.workspaceId],
  )).rows[0];
  if (!person) return c.json({ error: 'not found' }, 404);
  const desk = ctx.role !== 'volunteer';
  const rows = (await db.query(
    `select f.*, v.value, v.updated_at as value_at, u.name as by_name
     from person_fields f
     left join person_field_values v on v.field_id = f.id and v.person_id = $2
     left join users u on u.id = v.updated_by
     where f.workspace_id = $1 and f.retired_at is null ${desk ? '' : 'and f.volunteers and v.id is not null'}
     order by f.position, f.created_at`,
    [ctx.workspaceId, person.id],
  )).rows;
  if (!desk) {
    return c.json({
      fields: rows.map((f) => ({ id: f.id, name: f.name, kind: f.kind, value: f.value ?? null })),
      edit: false,
    });
  }
  return c.json({
    fields: rows.map((f) => ({
      ...fieldOut(f), value: f.value ?? null, at: f.value_at || null, by_name: f.by_name || null,
    })),
    edit: true,
  });
});
