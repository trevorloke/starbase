// list.create  { name, kind: 'filter' | 'people', filter?, person_ids?, note? }
// list.update  { id, name?, filter?, note? }
// list.delete  { id }
// list.add     { id, person_ids: [] }     a hand-picked list
// list.remove  { id, person_ids: [] }
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { cleanFilter } from '../../lib/audience.js';

const DESK = ['manager', 'treasurer', 'staff'];
const filterInput = () => z.record(z.string().max(40), z.string().max(400)).optional();
const ids = () => z.array(z.uuid()).min(1).max(5000);

const loadMine = async (tx, ws, id) => {
  const row = (await tx.query('select * from lists where id = $1 and workspace_id = $2 and deleted_at is null for update', [id, ws])).rows[0];
  if (!row) throw httpError(404, 'list not found');
  return row;
};
// Only people in this campaign go on a list.
const ownPeople = async (tx, ws, list) => (await tx.query(
  'select id from persons where workspace_id = $1 and deleted_at is null and id = any($2::uuid[])', [ws, list],
)).rows.map((r) => r.id);

export const actions = {
  'list.create': {
    roles: DESK,
    input: z.object({
      name: z.string().trim().min(1).max(120),
      kind: z.enum(['filter', 'people']),
      filter: filterInput(),
      person_ids: z.array(z.uuid()).max(5000).optional(),
      note: z.string().max(2000).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const id = newId();
      const filter = input.kind === 'filter' ? cleanFilter(input.filter || {}) : {};
      await tx.query(
        'insert into lists (id, workspace_id, name, kind, filter, note, created_by) values ($1, $2, $3, $4, $5, $6, $7)',
        [id, ws, input.name, input.kind, JSON.stringify(filter), input.note || null, ctx.user.id],
      );
      let added = 0;
      if (input.kind === 'people' && input.person_ids?.length) {
        for (const pid of await ownPeople(tx, ws, input.person_ids)) {
          await tx.query('insert into list_members (list_id, workspace_id, person_id) values ($1, $2, $3) on conflict do nothing', [id, ws, pid]);
          added += 1;
        }
      }
      emit('list', id, 'create', { name: input.name, kind: input.kind, filter, added });
      return { list: { id, name: input.name, kind: input.kind, filter, note: input.note || null }, added };
    },
  },

  'list.update': {
    roles: DESK,
    input: z.object({ id: z.uuid(), name: z.string().trim().min(1).max(120).optional(), filter: filterInput(), note: z.string().max(2000).nullish() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadMine(tx, ctx.workspaceId, input.id);
      const filter = input.filter !== undefined && cur.kind === 'filter' ? cleanFilter(input.filter) : (typeof cur.filter === 'string' ? JSON.parse(cur.filter) : cur.filter);
      await tx.query(
        'update lists set name = $3, filter = $4, note = $5, updated_at = now() where id = $1 and workspace_id = $2',
        [cur.id, ctx.workspaceId, input.name ?? cur.name, JSON.stringify(filter), input.note === undefined ? cur.note : input.note],
      );
      const out = { id: cur.id, name: input.name ?? cur.name, kind: cur.kind, filter, note: input.note === undefined ? cur.note : input.note };
      emit('list', cur.id, 'update', out);
      return { list: out };
    },
  },

  'list.delete': {
    roles: DESK,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadMine(tx, ctx.workspaceId, input.id);
      await tx.query('update lists set deleted_at = now(), updated_at = now() where id = $1 and workspace_id = $2', [cur.id, ctx.workspaceId]);
      emit('list', cur.id, 'void', {});
      return { id: cur.id };
    },
  },

  'list.add': {
    roles: DESK,
    input: z.object({ id: z.uuid(), person_ids: ids() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadMine(tx, ctx.workspaceId, input.id);
      if (cur.kind !== 'people') throw httpError(400, 'a saved filter names its own people — change the filter instead');
      let added = 0;
      for (const pid of await ownPeople(tx, ctx.workspaceId, input.person_ids)) {
        const r = await tx.query('insert into list_members (list_id, workspace_id, person_id) values ($1, $2, $3) on conflict do nothing', [cur.id, ctx.workspaceId, pid]);
        added += r.affectedRows || 0;
      }
      if (added) emit('list', cur.id, 'update', { added, person_ids: input.person_ids.slice(0, 50) });
      return { added };
    },
  },

  'list.remove': {
    roles: DESK,
    input: z.object({ id: z.uuid(), person_ids: ids() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadMine(tx, ctx.workspaceId, input.id);
      if (cur.kind !== 'people') throw httpError(400, 'a saved filter names its own people — change the filter instead');
      const r = await tx.query('delete from list_members where list_id = $1 and workspace_id = $2 and person_id = any($3::uuid[])', [cur.id, ctx.workspaceId, input.person_ids]);
      const removed = r.affectedRows || 0;
      if (removed) emit('list', cur.id, 'update', { removed, person_ids: input.person_ids.slice(0, 50) });
      return { removed };
    },
  },
};
