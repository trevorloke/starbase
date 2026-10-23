// The desk with no signal — the server half. Campaign offices and church
// basements lose wifi; the desk keeps reading what it already loaded (the
// web keeps those copies, web/src/components/OfflineCache.js) and a profile
// keeps taking the safe writes, saved in the outbox (web/src/offline.js) and
// sent once when the signal is back: a contact or rating and a note
// (contact.log, deduped on its own client_id) and tags (person.tag, below).
//
//   sql      client_writes: the outbox's client ids for writes that have no
//            key of their own, one row per write per campaign, so a replay
//            after a lost answer (or a second tab sending the same item) is
//            recorded once.
//   actions  person.tag { id, add, remove, client_id } — put tags on one
//            person and/or take them off (desk roles; volunteers never change
//            tags). Unlike person.update's whole tag list it touches only the
//            tags it names, so a change saved with no signal never undoes a
//            tag someone else changed meanwhile. A replay of the same
//            client_id answers { duplicate: true } and changes nothing — even
//            if the tag was taken off again since. Adding a tag that's there
//            already (or taking off one that isn't) changes nothing and logs
//            nothing ({ unchanged: true }). The event is a person update with
//            the new tag list, like any other tag change, so ladders that
//            start on a tag still start.
import { z } from 'zod';
import { httpError } from '../../actions/util.js';

const DESK_ROLES = ['manager', 'treasurer', 'staff'];
// person.update's limits: 40 characters a tag, 50 tags a person.
const TAG_MAX_LEN = 40;
const TAG_MAX = 50;
const parseJ = (v, fb) => (typeof v === 'string' ? JSON.parse(v) : (v ?? fb));

export const sql = `
create table if not exists client_writes (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  client_id uuid not null,
  action text not null,
  entity_id uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, client_id)
);
`;

// What this campaign already did under a client id (runAction holds the
// campaign's lock, so check-then-remember can't race).
const done = async (tx, ws, cid) => (await tx.query(
  'select action, entity_id from client_writes where workspace_id = $1 and client_id = $2',
  [ws, cid],
)).rows[0] || null;
const remember = (tx, ws, cid, action, entityId) => tx.query(
  'insert into client_writes (workspace_id, client_id, action, entity_id) values ($1, $2, $3, $4)',
  [ws, cid, action, entityId],
);

const tagList = z.array(z.string().trim().min(1).max(TAG_MAX_LEN)).max(TAG_MAX).default([]);
const uniq = (list) => [...new Set(list)];

export const actions = {
  'person.tag': {
    roles: DESK_ROLES,
    input: z.object({
      id: z.uuid(),
      add: tagList,
      remove: tagList,
      // Made with the item in the outbox: a replay is the same change.
      client_id: z.uuid().nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const add = uniq(input.add);
      const remove = uniq(input.remove).filter((t) => !add.includes(t));
      if (!add.length && !remove.length) throw httpError(400, 'no tags to change');
      const cur = (await tx.query(
        'select id, tags from persons where id = $1 and workspace_id = $2 and deleted_at is null',
        [input.id, ws],
      )).rows[0];
      if (input.client_id) {
        const seen = await done(tx, ws, input.client_id);
        if (seen && (seen.action !== 'person.tag' || seen.entity_id !== input.id)) throw httpError(409, 'that id is already taken');
        if (seen) return { person: { id: input.id, tags: cur ? parseJ(cur.tags, []) : [] }, duplicate: true };
      }
      if (!cur) throw httpError(404, 'person not found');
      const tags = parseJ(cur.tags, []);
      const next = tags.filter((t) => !remove.includes(t));
      for (const t of add) if (!next.includes(t)) next.push(t);
      if (next.length > TAG_MAX) throw httpError(400, `${TAG_MAX} tags max`);
      const changed = next.length !== tags.length || next.some((t, i) => t !== tags[i]);
      if (changed) {
        await tx.query(
          'update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2',
          [input.id, ws, JSON.stringify(next)],
        );
        emit('person', input.id, 'update', {
          tags: next,
          added: add.filter((t) => !tags.includes(t)),
          removed: remove.filter((t) => tags.includes(t)),
          ...(input.client_id ? { client_id: input.client_id } : {}),
        });
      }
      if (input.client_id) await remember(tx, ws, input.client_id, 'person.tag', input.id);
      return { person: { id: input.id, tags: next }, ...(changed ? {} : { unchanged: true }) };
    },
  },
};

// In the full export (it names which writes came from which tap).
export const exportTables = ['client_writes'];
