// Relationship actions. Every change is one runAction: table writes + events
// on the hash chain.
//
//   relationship.add     { id?, from_id?, person_id? | person: { id?, name, phone?, email? }, kind?, note? }
//       "<from> knows <person>". from is whose people it goes on: the desk
//       names anyone (a profile's "+ Someone they know"); a volunteer's is
//       always their own record (made on their first add, like Count me in).
//       person_id: someone on the list already. person: someone they know,
//       found first by the dedupe rules (match.js) and added new only when
//       nobody matches — then "Brought in by <from>". A new person needs a
//       phone or an email. A volunteer's new person keeps the email they
//       typed in attrs.typed_email; when someone on the list already has that
//       email, the new person doesn't take it (email stays empty, so nothing
//       keyed by email — newsletter consent, ladders' email steps — reaches
//       that address under the name they typed) and attrs.maybe_same_as names
//       that person (or else someone with the same name) for the desk ("May
//       be the same person as …" on both profiles). Nothing in the answer
//       differs either way: the volunteer learns nothing about whose email it
//       is. id is the link's, made on the phone (the offline outbox): a
//       replay is the same link, even after it was removed. The pair either
//       way round is one link: adding it again answers duplicate (and takes
//       a new kind or note).
//   relationship.remove  { id }   taken off (kept on the books, removed_at);
//       a volunteer removes only their own links.
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { forViewer } from '../../lib/viewer.js';
import { httpError } from '../../actions/util.js';
import { findKnown, maybeSame, selfPerson } from './match.js';

const ALL_ROLES = ['manager', 'treasurer', 'staff', 'volunteer'];
export const KINDS = ['family', 'friend', 'neighbour', 'work', 'community', 'other'];

// '' from a form field is no value at all.
const blank = (schema) => z.preprocess((v) => (typeof v === 'string' && !v.trim() ? null : v), schema);

export const PERSON_COLS = 'id, name, email, phone, address, unit, rating, rated_at, tags';
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
// A person as "My people" and the profile's Knows show them — through the
// volunteer rule (no one else's email, no money tags).
export const personOut = (ctx) => {
  const view = forViewer(ctx);
  return (r) => view({
    id: r.id, name: r.name, email: r.email ?? null, phone: r.phone ?? null, address: r.address ?? null,
    unit: r.unit ?? null, rating: r.rating ?? null, rated_at: r.rated_at ?? null, tags: parseJ(r.tags, []),
  });
};
export const linkOut = (r) => ({
  id: r.id, kind: r.kind, note: r.note ?? null, person_a: r.person_a, person_b: r.person_b,
  brought_in: r.brought_in ?? null, created_at: r.created_at ?? null, removed: Boolean(r.removed_at),
});

const livePerson = async (tx, ws, id) => (await tx.query(
  `select ${PERSON_COLS} from persons where id = $1 and workspace_id = $2 and deleted_at is null`, [id, ws],
)).rows[0] || null;

// The other end of a link, seen from `fromId`.
const otherEnd = (r, fromId) => (r.person_a === fromId ? r.person_b : r.person_a);

export const actions = {
  'relationship.add': {
    roles: ALL_ROLES,
    input: z.object({
      id: z.uuid().nullish(),
      from_id: z.uuid().nullish(),
      person_id: z.uuid().nullish(),
      person: z.object({
        id: z.uuid().nullish(),
        name: z.string().trim().min(1).max(300),
        phone: blank(z.string().trim().max(40).nullish()),
        email: blank(z.string().trim().email().max(320).nullish()),
      }).nullish(),
      kind: z.enum(KINDS).nullish(),
      note: blank(z.string().trim().max(200).nullish()),
    })
      .refine((v) => Boolean(v.person_id) !== Boolean(v.person), { message: 'pick someone on the list or add someone new', path: ['person'] })
      .refine((v) => !v.person || v.person.phone || v.person.email, { message: 'add a phone or an email', path: ['person'] }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const vol = ctx.role === 'volunteer';
      const view = personOut(ctx);

      // A replay (the outbox sending again after a lost answer) is the same link.
      if (input.id) {
        const cur = (await tx.query('select * from relationships where id = $1', [input.id])).rows[0];
        if (cur && cur.workspace_id !== ws) throw httpError(409, 'that id is already taken');
        if (cur) {
          const me = vol ? await selfPerson(tx, ctx, emit) : null;
          if (vol && (!me || (cur.person_a !== me.id && cur.person_b !== me.id))) throw httpError(409, 'that id is already taken');
          const fromId = me?.id || cur.from_person || cur.person_a;
          const other = await livePerson(tx, ws, otherEnd(cur, fromId));
          return { relationship: linkOut(cur), person: other ? view(other) : null, duplicate: true };
        }
      }

      // Whose people this goes on.
      let from;
      if (input.from_id && !vol) {
        from = await livePerson(tx, ws, input.from_id);
        if (!from) throw httpError(404, 'person not found');
      } else {
        from = await selfPerson(tx, ctx, emit, { create: true });
        if (!from) throw httpError(400, 'your sign-in has no email');
        if (input.from_id && input.from_id !== from.id) throw httpError(403, 'you can only add to your own people');
      }

      // Who they know: on the list already, or someone new.
      let other = null;
      let created = false;
      let matched = false;
      if (input.person_id) {
        other = await livePerson(tx, ws, input.person_id);
        if (!other) throw httpError(404, 'person not found');
      } else {
        const p = input.person;
        if (p.id) {
          const cur = (await tx.query(`select workspace_id, deleted_at, ${PERSON_COLS} from persons where id = $1`, [p.id])).rows[0];
          if (cur && (cur.workspace_id !== ws || cur.deleted_at)) throw httpError(409, 'that id is already taken');
          other = cur || null;
        }
        if (!other) {
          other = await findKnown(tx, ctx, p, from.id);
          matched = Boolean(other);
        }
        if (!other) {
          const id = p.id || newId();
          let email = p.email ? p.email.toLowerCase() : null;
          const attrs = {};
          if (vol) {
            if (email) attrs.typed_email = email;
            const same = await maybeSame(tx, ctx, p, from.id);
            if (same) attrs.maybe_same_as = same.id;
            if (same?.email) email = null;
          }
          await tx.query(
            `insert into persons (id, workspace_id, kind, name, email, phone, tags, socials, attrs)
             values ($1, $2, 'person', $3, $4, $5, '[]', '{}', $6)`,
            [id, ws, p.name, email, p.phone || null, JSON.stringify(attrs)],
          );
          emit('person', id, 'create', {
            id, kind: 'person', name: p.name, email, phone: p.phone || null, tags: [], brought_in_by: from.id,
            ...(Object.keys(attrs).length ? { attrs } : {}),
          });
          other = { id, name: p.name, email, phone: p.phone || null, address: null, unit: null, rating: null, rated_at: null, tags: [] };
          created = true;
        }
      }
      if (other.id === from.id) throw httpError(400, 'that’s you — add someone you know');

      const { a, b } = (await tx.query('select least($1::uuid, $2::uuid) as a, greatest($1::uuid, $2::uuid) as b', [from.id, other.id])).rows[0];
      const live = (await tx.query(
        'select * from relationships where workspace_id = $1 and person_a = $2 and person_b = $3 and removed_at is null for update',
        [ws, a, b],
      )).rows[0];
      if (live) {
        // The same link: a new kind or note is taken, nothing else changes.
        const patch = {};
        if (input.kind && input.kind !== live.kind) patch.kind = input.kind;
        if (input.note && input.note !== live.note) patch.note = input.note;
        if (Object.keys(patch).length) {
          await tx.query(
            'update relationships set kind = $3, note = $4, updated_at = now() where id = $1 and workspace_id = $2',
            [live.id, ws, patch.kind ?? live.kind, patch.note ?? live.note],
          );
          emit('relationship', live.id, 'update', patch);
        }
        return { relationship: linkOut({ ...live, ...patch }), person: view(other), duplicate: true };
      }

      const id = input.id || newId();
      const row = {
        id, person_a: a, person_b: b, kind: input.kind || 'other', note: input.note || null,
        brought_in: created ? other.id : null, from_person: from.id,
      };
      await tx.query(
        `insert into relationships (id, workspace_id, person_a, person_b, kind, note, brought_in, from_person, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, ws, a, b, row.kind, row.note, row.brought_in, row.from_person, ctx.user?.id || null],
      );
      emit('relationship', id, 'create', {
        id, person_a: a, person_b: b, kind: row.kind, note: row.note, brought_in: row.brought_in, from: from.id,
      });
      return { relationship: linkOut(row), person: view(other), created_person: created, matched };
    },
  },

  'relationship.remove': {
    roles: ALL_ROLES,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const cur = (await tx.query(
        'select * from relationships where id = $1 and workspace_id = $2 for update', [input.id, ws],
      )).rows[0];
      if (!cur) throw httpError(404, 'not found');
      if (ctx.role === 'volunteer') {
        const me = await selfPerson(tx, ctx, emit);
        // Someone else's link is simply not there for them.
        if (!me || (cur.person_a !== me.id && cur.person_b !== me.id)) throw httpError(404, 'not found');
      }
      if (cur.removed_at) return { id: cur.id, removed: true, duplicate: true };
      await tx.query(
        'update relationships set removed_at = now(), removed_by = $3, updated_at = now() where id = $1 and workspace_id = $2',
        [cur.id, ws, ctx.user?.id || null],
      );
      emit('relationship', cur.id, 'void', { person_a: cur.person_a, person_b: cur.person_b });
      return { id: cur.id, removed: true };
    },
  },
};
