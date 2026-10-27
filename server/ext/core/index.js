// Core field fixes that need their own action.
//
//   person.addAtDoor  "+ Person at this door" on the walk list and the door
//                     card, for every role. A new housemate at a door that is
//                     already on the list: name and phone only — the address,
//                     unit, city, postal code and pin are the door's (copied
//                     from someone already there), so nobody types them. A
//                     volunteer may add only at a door inside a turf they walk
//                     (the walk list's doors); the desk anywhere. It goes
//                     through the offline outbox: the id is made on the phone,
//                     and a replay is the same person, never a second one.
//
// person.create stays desk-only: it takes email, tags and any address, which
// volunteers never set.
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { pointInPolygon } from '../../lib/geo.js';
import { httpError } from '../../actions/util.js';

const ALL_ROLES = ['manager', 'treasurer', 'staff', 'volunteer'];
const parseJ = (v, fb) => (typeof v === 'string' ? JSON.parse(v) : (v ?? fb));

// What the door shows for a person — nothing a volunteer may not see.
const doorPerson = (r) => ({
  id: r.id, name: r.name, phone: r.phone ?? null,
  address: r.address ?? null, unit: r.unit ?? null, lat: r.lat, lng: r.lng, tags: [],
});

const inMyTurf = async (tx, ctx, lat, lng) => {
  const turfs = (await tx.query(
    `select t.polygon from turfs t join turf_members m on m.turf_id = t.id and m.user_id = $2
     where t.workspace_id = $1 and t.deleted_at is null`,
    [ctx.workspaceId, ctx.user.id],
  )).rows;
  return turfs.some((t) => {
    const ring = parseJ(t.polygon, []);
    return Array.isArray(ring) && ring.length >= 3
      && pointInPolygon(Number(lat), Number(lng), ring.map(([a, b]) => [Number(a), Number(b)]));
  });
};

export const actions = {
  // The basics, fixed where you meet them — the door card, the Calls card,
  // the profile: a name, a phone, an email. Any role. A volunteer may add an
  // email where there is none (they never see the one on file, so they
  // can't be asked to change it — and never learn it); the desk may change any.
  'person.details': {
    roles: ALL_ROLES,
    input: z.object({
      person_id: z.uuid(),
      name: z.string().trim().min(1).max(300).optional(),
      phone: z.string().trim().max(40).nullish(),
      email: z.union([z.string().trim().email().max(320), z.literal('')]).nullish(),
    }).refine((v) => v.name !== undefined || v.phone !== undefined || v.email !== undefined, 'nothing to change'),
    handler: async (tx, ctx, input, emit) => {
      const cur = (await tx.query(
        'select * from persons where id = $1 and workspace_id = $2 and deleted_at is null', [input.person_id, ctx.workspaceId],
      )).rows[0];
      if (!cur) throw httpError(404, 'person not found');
      const patch = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.phone !== undefined) patch.phone = input.phone || null;
      if (input.email !== undefined) {
        const email = input.email ? input.email.toLowerCase() : null;
        // Always 409 while one is on file — even for the same email — so a
        // guess at it is never confirmed (see relationships.test.js).
        if (ctx.role === 'volunteer') {
          if (cur.email) throw httpError(409, 'an email is on file — the office can change it');
          if (!email) throw httpError(400, 'add an email');
        }
        patch.email = email;
      }
      if (!Object.keys(patch).length) throw httpError(400, 'nothing to change');
      const next = { ...cur, ...patch };
      await tx.query(
        'update persons set name = $3, phone = $4, email = $5, updated_at = now() where id = $1 and workspace_id = $2',
        [cur.id, ctx.workspaceId, next.name, next.phone, next.email],
      );
      emit('person', cur.id, 'update', patch);
      // What the caller gets back: a volunteer never reads another's email
      // (lib/viewer.js), only that it is on file.
      const out = { id: cur.id, name: next.name, phone: next.phone, email: ctx.role === 'volunteer' && !('email' in patch) ? null : next.email };
      return { person: out, changed: Object.keys(patch) };
    },
  },

  'person.addAtDoor': {
    roles: ALL_ROLES,
    input: z.object({
      // Made on the phone (the offline outbox), so a person added with no
      // signal can be knocked at once, and a replay is the same person.
      id: z.uuid().nullish(),
      // Someone already at this door: the new person takes its address and pin.
      housemate_id: z.uuid(),
      name: z.string().trim().min(1).max(300),
      phone: z.string().trim().max(40).nullish(),
    }),
    handler: async (tx, ctx, { id: clientId, housemate_id: housemateId, name, phone }, emit) => {
      if (clientId) {
        const cur = (await tx.query('select * from persons where id = $1', [clientId])).rows[0];
        if (cur && cur.workspace_id !== ctx.workspaceId) throw httpError(409, 'that id is already taken');
        if (cur) return { person: doorPerson(cur), duplicate: true };
      }
      const home = (await tx.query(
        `select address, house_number, unit, city, postal, lat, lng from persons
         where id = $1 and workspace_id = $2 and deleted_at is null`,
        [housemateId, ctx.workspaceId],
      )).rows[0];
      if (!home) throw httpError(404, 'that door is gone — refresh the list');
      if (home.lat == null || home.lng == null) throw httpError(400, 'that door has no pin yet');
      if (ctx.role === 'volunteer' && !(await inMyTurf(tx, ctx, home.lat, home.lng))) {
        throw httpError(403, 'that door isn’t in your turf');
      }
      const id = clientId || newId();
      const person = {
        id, kind: 'person', name, phone: phone || null,
        address: home.address || null, house_number: home.house_number || null, unit: home.unit || null, city: home.city || null,
        postal: home.postal || null, lat: home.lat, lng: home.lng,
      };
      await tx.query(
        `insert into persons (id, workspace_id, kind, name, phone, address, house_number, unit, city, postal, lat, lng, tags, socials)
         values ($1, $2, 'person', $3, $4, $5, $11, $6, $7, $8, $9, $10, '[]', '{}')`,
        [id, ctx.workspaceId, name, person.phone, person.address, person.unit, person.city, person.postal, person.lat, person.lng, person.house_number],
      );
      emit('person', id, 'create', { ...person, tags: [], at_door_of: housemateId });
      return { person: doorPerson(person) };
    },
  },
};
