// Profile field actions. Every change is one runAction: table writes + events
// on the hash chain. Managers define fields; the desk fills them in.
//
//   field.create      { name, kind, choices?, volunteers? }          managers
//   field.update      { id, name?, kind?, choices?, volunteers? }    managers
//                     kind: any change while nothing is filled in; once a
//                     value exists it can only become Text (every value is
//                     rewritten as its words — nothing is lost); anything
//                     else is refused, because the values on file would no
//                     longer fit (add a new field instead).
//                     choices: add, reorder, or drop an unused one; a
//                     choice someone has stays (it is refused, never
//                     silently emptied).
//   field.reorder     { ids }   every field on the profile, in the new order
//   field.retire      { id }    "Take off": it stops showing on profiles,
//                               filters and imports; every value stays (and
//                               in the export)
//   field.restore     { id }    "Bring back", at the end of the list
//   field.values.set  { person_id, values: [{ field_id, value }] }   desk
//                     value null or "" clears it. Each value is checked
//                     against its field (kinds.js); one that doesn't fit
//                     refuses the whole save, with the field's name.
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import {
  KINDS, NAME_MAX, CHOICE_MAX, CHOICES_MAX, FIELDS_MAX,
  choicesOf, cleanName, nameKey, parseValue, valueError, showValue, sameValue,
} from './kinds.js';

const MANAGERS = ['manager'];
const DESK = ['manager', 'treasurer', 'staff'];

const nameIn = () => z.string().trim().min(1).max(NAME_MAX);
const choicesIn = () => z.array(z.string().trim().min(1).max(CHOICE_MAX)).max(CHOICES_MAX);
const valueIn = () => z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);

export const fieldOut = (f) => ({
  id: f.id, name: f.name, kind: f.kind, choices: choicesOf(f), volunteers: !!f.volunteers,
  position: f.position, retired: !!f.retired_at,
});

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const loadField = async (tx, ctx, id) => {
  const f = (await tx.query(
    'select * from person_fields where id = $1 and workspace_id = $2 for update', [id, ctx.workspaceId],
  )).rows[0];
  if (!f) throw httpError(404, 'field not found');
  return f;
};
const liveField = async (tx, ctx, id) => {
  const f = await loadField(tx, ctx, id);
  if (f.retired_at) throw httpError(409, `“${f.name}” is taken off — bring it back first`);
  return f;
};

// Names (stored trimmed, single-spaced) are unique among the fields on the
// profile, in any case.
const checkName = async (tx, ctx, name, exceptId = null) => {
  const taken = (await tx.query(
    `select name from person_fields where workspace_id = $1 and retired_at is null and ($3::uuid is null or id <> $3)
       and lower(name) = $2 limit 1`,
    [ctx.workspaceId, nameKey(name), exceptId],
  )).rows[0];
  if (taken) throw httpError(409, `there’s already a field called “${taken.name}”`);
};

// Pick one needs two or more different choices; the other kinds none.
const cleanChoices = (kind, list) => {
  if (kind !== 'choice') {
    if (list?.length) throw httpError(400, 'only Pick one fields have choices');
    return [];
  }
  const out = (list || []).map(cleanName).filter(Boolean);
  if (out.length < 2) throw httpError(400, 'add at least two choices');
  if (new Set(out.map(nameKey)).size !== out.length) throw httpError(400, 'two choices are the same');
  return out;
};

// Every value on file for a field, people taken off the list included: they
// are still on record, and a change must fit them too.
const valuesOf = async (tx, ctx, fieldId) => (await tx.query(
  'select id, person_id, value from person_field_values where workspace_id = $1 and field_id = $2 order by created_at, id for update',
  [ctx.workspaceId, fieldId],
)).rows.map((r) => ({ ...r, value: r.value ?? null }));

export const actions = {
  'field.create': {
    roles: MANAGERS,
    input: z.object({
      name: nameIn(),
      kind: z.enum(KINDS),
      choices: choicesIn().optional(),
      volunteers: z.boolean().default(false),
    }),
    handler: async (tx, ctx, input, emit) => {
      const name = cleanName(input.name);
      await checkName(tx, ctx, name);
      const choices = cleanChoices(input.kind, input.choices);
      const { n, top } = (await tx.query(
        `select count(*)::int as n, coalesce(max(position), -1)::int as top from person_fields
         where workspace_id = $1 and retired_at is null`, [ctx.workspaceId],
      )).rows[0];
      if (n >= FIELDS_MAX) throw httpError(400, `a campaign can have up to ${FIELDS_MAX} fields`);
      const id = newId();
      await tx.query(
        `insert into person_fields (id, workspace_id, name, kind, choices, volunteers, position, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.workspaceId, name, input.kind, JSON.stringify(choices), input.volunteers, top + 1, ctx.user?.id || null],
      );
      const field = { id, name, kind: input.kind, choices, volunteers: input.volunteers, position: top + 1, retired: false };
      emit('person_field', id, 'create', field);
      return { field };
    },
  },

  'field.update': {
    roles: MANAGERS,
    input: z.object({
      id: z.uuid(),
      name: nameIn().optional(),
      kind: z.enum(KINDS).optional(),
      choices: choicesIn().optional(),
      volunteers: z.boolean().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await liveField(tx, ctx, input.id);
      const name = input.name !== undefined ? cleanName(input.name) : cur.name;
      if (nameKey(name) !== nameKey(cur.name)) await checkName(tx, ctx, name, cur.id);
      const kind = input.kind ?? cur.kind;
      const was = choicesOf(cur);
      const values = await valuesOf(tx, ctx, cur.id);

      // A new kind: free while nothing is filled in; with values, only Text.
      if (kind !== cur.kind && values.length && kind !== 'text') {
        const people = new Set(values.map((v) => v.person_id)).size;
        throw httpError(409, `“${cur.name}” is filled in for ${plural(people, 'person', 'people')} — it can only become Text now. Add a new field instead.`);
      }
      const choices = cleanChoices(kind, kind === 'choice' ? input.choices ?? (cur.kind === 'choice' ? was : []) : input.choices);
      // A choice someone has stays on the list.
      if (kind === 'choice' && cur.kind === 'choice') {
        const used = new Map();
        for (const v of values) used.set(v.value, (used.get(v.value) || 0) + 1);
        for (const [label, n] of used) {
          if (!choices.includes(label)) {
            throw httpError(409, `“${label}” is filled in for ${plural(n, 'person', 'people')} — it stays`);
          }
        }
      }

      // To Text: each value becomes its words (Yes / No, 2.5) — kept, readable, filterable.
      let converted = 0;
      if (kind !== cur.kind && kind === 'text') {
        for (const v of values) {
          const words = showValue(cur.kind, v.value);
          if (sameValue(words, v.value)) continue;
          await tx.query(
            'update person_field_values set value = $3, updated_at = now() where id = $1 and workspace_id = $2',
            [v.id, ctx.workspaceId, JSON.stringify(words)],
          );
          emit('person_field_value', v.id, 'update', { field_id: cur.id, person_id: v.person_id, value: words, was: v.value, converted: true });
          converted += 1;
        }
      }
      const volunteers = input.volunteers ?? !!cur.volunteers;
      await tx.query(
        `update person_fields set name = $3, kind = $4, choices = $5, volunteers = $6, updated_at = now()
         where id = $1 and workspace_id = $2`,
        [cur.id, ctx.workspaceId, name, kind, JSON.stringify(choices), volunteers],
      );
      const patch = { ...input };
      delete patch.id;
      if (kind !== cur.kind) Object.assign(patch, { was: cur.kind, converted });
      if (kind !== 'choice' && cur.kind === 'choice') patch.choices = [];
      emit('person_field', cur.id, 'update', patch);
      return { field: fieldOut({ ...cur, name, kind, choices, volunteers }), converted };
    },
  },

  'field.reorder': {
    roles: MANAGERS,
    input: z.object({ ids: z.array(z.uuid()).min(1).max(FIELDS_MAX) }),
    handler: async (tx, ctx, input, emit) => {
      const cur = (await tx.query(
        'select id from person_fields where workspace_id = $1 and retired_at is null for update', [ctx.workspaceId],
      )).rows.map((r) => r.id);
      const same = cur.length === input.ids.length && new Set(input.ids).size === input.ids.length
        && input.ids.every((id) => cur.includes(id));
      if (!same) throw httpError(409, 'the fields changed — reload and try again');
      for (const [i, id] of input.ids.entries()) {
        await tx.query('update person_fields set position = $3, updated_at = now() where id = $1 and workspace_id = $2',
          [id, ctx.workspaceId, i]);
      }
      emit('workspace', ctx.workspaceId, 'update', { person_fields_order: input.ids });
      return { order: input.ids };
    },
  },

  // Take off: off every profile, filter and import; every value kept.
  'field.retire': {
    roles: MANAGERS,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const f = await liveField(tx, ctx, input.id);
      await tx.query('update person_fields set retired_at = now(), updated_at = now() where id = $1 and workspace_id = $2',
        [f.id, ctx.workspaceId]);
      const kept = (await tx.query(
        'select count(*)::int as n from person_field_values where workspace_id = $1 and field_id = $2', [ctx.workspaceId, f.id],
      )).rows[0].n;
      emit('person_field', f.id, 'update', { retired: true, name: f.name, values_kept: kept });
      return { field: { ...fieldOut(f), retired: true }, kept };
    },
  },

  'field.restore': {
    roles: MANAGERS,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const f = await loadField(tx, ctx, input.id);
      if (!f.retired_at) return { field: fieldOut(f) };
      await checkName(tx, ctx, f.name, f.id);
      const { n, top } = (await tx.query(
        `select count(*)::int as n, coalesce(max(position), -1)::int as top from person_fields
         where workspace_id = $1 and retired_at is null`, [ctx.workspaceId],
      )).rows[0];
      if (n >= FIELDS_MAX) throw httpError(400, `a campaign can have up to ${FIELDS_MAX} fields`);
      await tx.query(
        'update person_fields set retired_at = null, position = $3, updated_at = now() where id = $1 and workspace_id = $2',
        [f.id, ctx.workspaceId, top + 1],
      );
      emit('person_field', f.id, 'update', { retired: false });
      return { field: fieldOut({ ...f, retired_at: null, position: top + 1 }) };
    },
  },

  'field.values.set': {
    roles: DESK,
    input: z.object({
      person_id: z.uuid(),
      values: z.array(z.object({ field_id: z.uuid(), value: valueIn() })).min(1).max(FIELDS_MAX),
    }),
    handler: async (tx, ctx, input, emit) => {
      const person = (await tx.query(
        'select id from persons where id = $1 and workspace_id = $2 and deleted_at is null', [input.person_id, ctx.workspaceId],
      )).rows[0];
      if (!person) throw httpError(404, 'person not found');
      const ids = input.values.map((v) => v.field_id);
      if (new Set(ids).size !== ids.length) throw httpError(400, 'one value per field');
      const fields = new Map((await tx.query(
        `select * from person_fields where workspace_id = $1 and id in (select (jsonb_array_elements_text($2::jsonb))::uuid)`,
        [ctx.workspaceId, JSON.stringify(ids)],
      )).rows.map((f) => [f.id, f]));
      // Check everything first: one value that doesn't fit saves nothing.
      const checked = input.values.map(({ field_id: fid, value }) => {
        const f = fields.get(fid);
        if (!f) throw httpError(400, 'that field is not in this campaign');
        if (f.retired_at) throw httpError(409, `“${f.name}” is taken off`);
        const p = parseValue(f, value);
        if (p.error) throw httpError(400, valueError(f, p.error));
        return { f, value: p.empty ? null : p.value };
      });
      const prior = new Map((await tx.query(
        `select id, field_id, value from person_field_values
         where workspace_id = $1 and person_id = $2 and field_id in (select (jsonb_array_elements_text($3::jsonb))::uuid)
         for update`,
        [ctx.workspaceId, person.id, JSON.stringify(ids)],
      )).rows.map((r) => [r.field_id, { ...r, value: r.value ?? null }]));
      let changed = 0;
      const out = [];
      for (const { f, value } of checked) {
        const was = prior.get(f.id);
        out.push({ field_id: f.id, value });
        if (sameValue(was?.value ?? null, value)) continue;
        changed += 1;
        if (value === null) {
          await tx.query('delete from person_field_values where id = $1 and workspace_id = $2', [was.id, ctx.workspaceId]);
          emit('person_field_value', was.id, 'void', { field_id: f.id, person_id: person.id, was: was.value });
        } else if (was) {
          await tx.query(
            `update person_field_values set value = $3, sample = false, updated_by = $4, updated_at = now()
             where id = $1 and workspace_id = $2`,
            [was.id, ctx.workspaceId, JSON.stringify(value), ctx.user?.id || null],
          );
          emit('person_field_value', was.id, 'update', { field_id: f.id, person_id: person.id, value, was: was.value });
        } else {
          const id = newId();
          await tx.query(
            `insert into person_field_values (id, workspace_id, field_id, person_id, value, updated_by)
             values ($1, $2, $3, $4, $5, $6)`,
            [id, ctx.workspaceId, f.id, person.id, JSON.stringify(value), ctx.user?.id || null],
          );
          emit('person_field_value', id, 'create', { id, field_id: f.id, person_id: person.id, value });
        }
      }
      return { person_id: person.id, values: out, changed };
    },
  },
};
