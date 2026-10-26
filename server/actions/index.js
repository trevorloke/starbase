// The Action registry — the only write path. Each action declares its name,
// the roles allowed to invoke it, a zod input contract, and a transactional
// handler that performs typed table writes and emits events. A few also
// have an `after` step — async (db, ctx, result) => ({ result, lastSeq? }) —
// run once the handler has committed, for work that must not hold the
// campaign lock (sending email); each of its writes is a runAction of its
// own. The palette, buttons, and the public API all call the same registry
// via POST /api/actions/:name; there is no other way to mutate campaign data.
import { civic, streetOf } from '../lib/address.js';
import { z } from 'zod';
import { zodFor } from '@starbase/shared/registry';
import { newId } from '../lib/events.js';
import { logGift, voidGift, restoreGift } from '../lib/gifts.js';
import { FIELD_ACTIONS, personFieldExtensions } from './field.js';
import { ORGANIZE_ACTIONS } from './organize.js';
import { httpError } from './util.js';
import { extActions } from '../ext.js';
export { httpError };

const MONEY_ROLES = ['manager', 'treasurer', 'staff'];
const PEOPLE_ROLES = ['manager', 'treasurer', 'staff'];
const FILING_ROLES = ['manager', 'treasurer'];

const personInput = z.object({
  kind: z.enum(['person', 'org']).default('person'),
  name: z.string().trim().min(1).max(300),
  email: z.string().email().max(320).nullish(),
  phone: z.string().max(40).nullish(),
  address: z.string().max(1000).nullish(),
  house_number: z.string().max(20).nullish(),
  ...personFieldExtensions,
});

const rowToPerson = (r) => ({
  id: r.id, kind: r.kind, name: r.name, email: r.email,
  phone: r.phone, address: r.address, house_number: r.house_number, unit: r.unit, city: r.city, postal: r.postal,
  lat: r.lat, lng: r.lng,
  tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : (r.tags || []),
  socials: typeof r.socials === 'string' ? JSON.parse(r.socials) : (r.socials || {}),
});

export const ACTIONS = {
  'person.create': {
    roles: PEOPLE_ROLES,
    // id: optional, made on the phone (the offline outbox) so a person added
    // with no signal can be knocked before they reach the server, and a
    // replay after a lost response is the same person, never a second one.
    input: personInput.extend({ id: z.uuid().nullish() }),
    handler: async (tx, ctx, { id: clientId, ...input }, emit) => {
      if (clientId) {
        const cur = (await tx.query('select * from persons where id = $1', [clientId])).rows[0];
        if (cur && cur.workspace_id !== ctx.workspaceId) throw httpError(409, 'that id is already taken');
        if (cur) return { person: rowToPerson(cur), duplicate: true };
      }
      const id = clientId || newId();
      // The house number and the street, however they came (lib/address.js).
      Object.assign(input, civic(input));
      await tx.query(
        `insert into persons (id, workspace_id, kind, name, email, phone, address, house_number, unit, city, postal, lat, lng, tags, socials)
         values ($1, $2, $3, $4, $5, $6, $7, $15, $8, $9, $10, $11, $12, $13, $14)`,
        [id, ctx.workspaceId, input.kind, input.name, input.email || null,
         input.phone || null, input.address || null, input.unit || null,
         input.city || null, input.postal || null, input.lat ?? null, input.lng ?? null,
         JSON.stringify(input.tags || []), JSON.stringify(input.socials || {}), input.house_number],
      );
      const payload = { id, ...input };
      emit('person', id, 'create', payload);
      return { person: payload };
    },
  },

  'person.update': {
    roles: PEOPLE_ROLES,
    input: personInput.partial().extend({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const { id, ...patch } = input;
      const cur = (await tx.query(
        'select * from persons where id = $1 and workspace_id = $2 and deleted_at is null',
        [id, ctx.workspaceId],
      )).rows[0];
      if (!cur) throw httpError(404, 'person not found');
      const next = { ...rowToPerson(cur), ...patch };
      // A new street or house number: the two parts settle together (a new
      // street keeps the house number only if the patch says so).
      if ('address' in patch || 'house_number' in patch) {
        // A new number alone goes onto the street as it was, not onto the old line.
        const street = 'address' in patch ? patch.address : streetOf(cur.house_number, cur.address);
        Object.assign(next, civic({ house_number: 'house_number' in patch ? patch.house_number : ('address' in patch ? null : cur.house_number), address: street }));
      }
      // A changed address makes the old pin wrong: drop it (the person lands in
      // the map's "place" list) unless the same patch supplies new coordinates.
      const addrChanged = (('address' in patch || 'house_number' in patch) && (next.address || null) !== (cur.address || null))
        || ('unit' in patch && (patch.unit || null) !== (cur.unit || null));
      if (addrChanged && !('lat' in patch) && !('lng' in patch)) { next.lat = null; next.lng = null; }
      await tx.query(
        `update persons set kind = $3, name = $4, email = $5, phone = $6, address = $7,
           unit = $8, city = $9, postal = $10, lat = $11, lng = $12, tags = $13, socials = $14, house_number = $15,
           updated_at = now()
         where id = $1 and workspace_id = $2`,
        [id, ctx.workspaceId, next.kind, next.name, next.email || null,
         next.phone || null, next.address || null, next.unit || null,
         next.city || null, next.postal || null, next.lat ?? null, next.lng ?? null,
         JSON.stringify(next.tags || []), JSON.stringify(next.socials || {}), next.house_number || null],
      );
      emit('person', id, 'update', { ...patch, ...(('address' in patch || 'house_number' in patch) ? { address: next.address, house_number: next.house_number } : {}) });
      return { person: next };
    },
  },

  'gift.log': {
    roles: MONEY_ROLES,
    input: zodFor('gift'),
    handler: (tx, ctx, input, emit) => logGift(tx, ctx.workspace, input, emit),
  },

  // A void is an event, never a delete: the gift leaves every total but stays
  // in the books, and restore brings it back. Both keep the gift's pledge in
  // step in the same transaction (a voided gift reopens a one-time pledge; a
  // restored one closes it again) — see lib/gifts.js. Answers { id, pledge }
  // (pledge: the pledge it changed, or null); restore adds flagged/flag_reason.
  'gift.void': {
    roles: MONEY_ROLES,
    input: z.object({ id: z.uuid() }),
    handler: (tx, ctx, input, emit) => voidGift(tx, ctx.workspaceId, input.id, emit),
  },

  'gift.restore': {
    roles: MONEY_ROLES,
    input: z.object({ id: z.uuid() }),
    handler: (tx, ctx, input, emit) => restoreGift(tx, ctx.workspace, input.id, emit),
  },

  'filing.create': {
    roles: FILING_ROLES,
    input: zodFor('filing'),
    handler: async (tx, ctx, input, emit) => {
      const id = newId();
      await tx.query(
        `insert into filings (id, workspace_id, name, due_date, status, note)
         values ($1, $2, $3, $4, $5, $6)`,
        [id, ctx.workspaceId, input.name, input.due_date, input.status, input.note || null],
      );
      const payload = { id, ...input };
      emit('filing', id, 'create', payload);
      return { filing: payload };
    },
  },

  'filing.update': {
    roles: FILING_ROLES,
    input: zodFor('filing').partial().extend({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const { id, ...patch } = input;
      const cur = (await tx.query(
        'select name, due_date, status, note from filings where id = $1 and workspace_id = $2 and deleted_at is null',
        [id, ctx.workspaceId],
      )).rows[0];
      if (!cur) throw httpError(404, 'filing not found');
      const next = {
        name: patch.name ?? cur.name,
        due_date: patch.due_date ?? isoDate(cur.due_date),
        status: patch.status ?? cur.status,
        note: patch.note ?? cur.note,
      };
      await tx.query(
        `update filings set name = $3, due_date = $4, status = $5, note = $6, updated_at = now()
         where id = $1 and workspace_id = $2`,
        [id, ctx.workspaceId, next.name, next.due_date, next.status, next.note || null],
      );
      emit('filing', id, 'update', patch);
      return { filing: { id, ...next } };
    },
  },

  ...FIELD_ACTIONS,
  ...ORGANIZE_ACTIONS,
  ...extActions(),
};

const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
