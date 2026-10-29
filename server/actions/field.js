// Field + outreach actions: canvassing contacts, signs, volunteer roles,
// shifts with notifications, petitions, newsletter, email blasts, workspace
// settings. Same contract as every action: zod input, transactional handler,
// events emitted for the log.
import { z } from 'zod';
import {
  CHANNELS, OUTCOMES, SIGN_KIND_CODES, SIGN_STATUSES,
  VOLUNTEER_ROLE_CODES, SOCIAL_PLATFORMS, SHIFT_STATUSES,
} from '@starbase/shared/canvass';
import { RATING_CODE_RE } from '@starbase/shared/scale';
// The campaign's own scale (ext/scale): which codes a new rating may use.
import { checkRating } from '../ext/scale/rules.js';
import { createHash, randomBytes } from 'node:crypto';
import { newId } from '../lib/events.js';
import { emailConfigured, sendEmail, sendText, shiftMessage } from '../lib/notify.js';
import { httpError } from './util.js';
import { SEED_PETITIONS } from '../lib/petitions.js';
import { runHooks, hasHook } from '../lib/hooks.js';
// The tracked newsletter/press send path and A/B subject lines.
import {
  AB_MIN, NO_PROVIDER, NO_TEXT_PROVIDER, abInput, abGroups, abOf, blastCounts, composeBlast, deliver, finishRun, findLinks, inlineMs,
  newToken, openTest, queueSend, restReleased, retryable, runPayload, saveLinks, startTest,
} from '../ext/abtests/send.js';
import { ATTACH_COUNT, bindAttachments, loadAttachments } from '../ext/abtests/attach.js';
import { audienceOf, recipientsOf } from '../ext/lists/audience.js';
import { e164, namesCampaign, MAX_BODY as TEXT_MAX } from '../ext/texting/rules.js';
import { textConfigured } from '../lib/notify.js';

const ALL_ROLES = ['manager', 'treasurer', 'staff', 'volunteer'];
const DESK_ROLES = ['manager', 'treasurer', 'staff'];
const MANAGER_ONLY = ['manager'];

const uuid = () => z.uuid();
const isoTs = () => z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'expected ISO timestamp');

const requirePerson = async (tx, workspaceId, id) => {
  const p = (await tx.query(
    'select id, name, email, phone, address, lat, lng from persons where id = $1 and workspace_id = $2 and deleted_at is null',
    [id, workspaceId],
  )).rows[0];
  if (!p) throw httpError(400, 'person not found in this workspace');
  return p;
};

// The signed-in user's own supporter record, matched by login email (oldest
// first). With create, a volunteer who isn't on the list yet is added.
const selfPerson = async (tx, ctx, emit, { create = false } = {}) => {
  const email = String(ctx.user.email || '').trim().toLowerCase();
  const found = (await tx.query(
    `select id, name from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null
     order by created_at limit 1`,
    [ctx.workspaceId, email],
  )).rows[0];
  if (found || !create) return found || null;
  const id = newId();
  const person = { kind: 'person', name: ctx.user.name || email, email, tags: ['volunteer'] };
  await tx.query(
    `insert into persons (id, workspace_id, kind, name, email, tags) values ($1, $2, $3, $4, $5, $6)`,
    [id, ctx.workspaceId, person.kind, person.name, email, JSON.stringify(person.tags)],
  );
  emit('person', id, 'create', { id, ...person });
  return { id, name: person.name };
};

// A send's status rule (blastStatus), its counts (blastCounts) and its
// message (plain text + tracked HTML) live in ext/abtests/send.js, shared
// with the A/B winner job.

// A newsletter / press send in two phases (the A/B winner job's): the
// handler commits the send, its list (the rows to go now asked for) and a
// send job; its `after` step then sends for a few seconds, outside the
// transaction (send.js deliver), and hands whatever is left to that job.
// What the handler hands to `after` sits under this key — a Symbol, so it
// never reaches the reply.
const SEND = Symbol('send');
const blastOut = (b) => ({
  id: b.id, kind: b.kind, subject: b.subject, status: b.status,
  audience_count: b.audience_count, provider_note: b.provider_note, sent_at: b.sent_at,
  ...(b.ab_status ? { ab: abOf(b) } : {}),
});

const ACTIVE_SHIFT_STATUSES = ['assigned', 'confirmed'];
const activeOnShift = async (tx, workspaceId, shiftId) => (await tx.query(
  `select count(*)::int as n from shift_assignments
   where shift_id = $1 and workspace_id = $2 and status in ('assigned', 'confirmed')`,
  [shiftId, workspaceId],
)).rows[0].n;

export const FIELD_ACTIONS = {
  // ── Canvassing ──
  'contact.log': {
    roles: ALL_ROLES, // doorknockers and phoners are volunteers
    input: z.object({
      person_id: uuid(),
      channel: z.enum(CHANNELS),
      outcome: z.enum(OUTCOMES),
      // A code on the campaign's scale (checked in the handler, ext/scale).
      rating: z.string().regex(RATING_CODE_RE, 'not a rating on the scale').nullish(),
      note: z.string().max(2000).nullish(),
      // Offline outbox key: a knock replayed after reconnecting is the same
      // knock, never a second one.
      client_id: uuid().nullish(),
      // When the phone's knock was tapped (the outbox keeps it): the rating
      // scale counts a candidate taken off the list from the tap, not from
      // when the knock arrived (ext/scale/rules.js). Never later than now.
      client_at: isoTs().max(40).nullish(),
      // Survey answers given in the same conversation; a feature module
      // (contactLogged hook) stores them with this contact.
      answers: z.array(z.object({
        question_id: uuid(),
        value: z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200)).max(50)]),
      })).max(50).nullish(),
      // The same visit: the client_id of this caller's earlier talked tap on
      // this person with no rating yet ("Save answers"). That contact gets
      // this tap's outcome, rating and note — one record per visit, not two;
      // a new answer to a question it already has replaces that answer.
      // If it isn't there (refused, someone else's, already rated), this tap
      // is logged on its own as usual.
      visit_of: uuid().nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      await requirePerson(tx, ctx.workspaceId, input.person_id);
      if (input.answers?.length && !hasHook('contactLogged')) throw httpError(400, 'surveys are not available');
      if (input.client_id) {
        const dup = (await tx.query(
          'select id, person_id, channel, outcome, rating, note from contacts where workspace_id = $1 and client_id = $2',
          [ctx.workspaceId, input.client_id],
        )).rows[0];
        if (dup) return { contact: dup, duplicate: true };
      }
      // A rating must be on the campaign's scale; one taken off the list is
      // still taken from a phone's knock for a while (ext/scale/rules.js).
      // Checked where it would be written, after the replay checks: a replay
      // of a knock already in is the same knock, whatever the list says now.
      const rated = () => input.rating && checkRating(tx, ctx.workspaceId, input.rating, {
        fromPhone: Boolean(input.client_id), tapped: input.client_id ? input.client_at : null,
      });
      // A hook (surveys) may add to the reply: answers it had to leave out.
      const reply = {};
      if (input.visit_of && input.visit_of !== input.client_id) {
        const first = (await tx.query(
          `select id, person_id, channel, outcome, rating, note, created_by, merged_client_ids from contacts
           where workspace_id = $1 and client_id = $2 for update`,
          [ctx.workspaceId, input.visit_of],
        )).rows[0];
        const merged = first ? (typeof first.merged_client_ids === 'string' ? JSON.parse(first.merged_client_ids) : first.merged_client_ids || []) : [];
        const mine = first && first.person_id === input.person_id && first.created_by === ctx.user.id && first.channel === input.channel;
        // This tap was already merged into it (a replay): the same tap, once.
        if (mine && input.client_id && merged.includes(input.client_id)) {
          return { contact: { id: first.id, person_id: first.person_id, channel: first.channel, outcome: first.outcome, rating: first.rating, note: first.note }, duplicate: true };
        }
        if (mine && first.outcome === 'contacted' && first.rating == null) {
          await rated();
          const note = [first.note, input.note].filter(Boolean).join('\n') || null;
          await tx.query(
            `update contacts set outcome = $3, rating = $4, note = $5, merged_client_ids = $6 where id = $1 and workspace_id = $2`,
            [first.id, ctx.workspaceId, input.outcome, input.rating || null, note,
             JSON.stringify(input.client_id ? [...merged, input.client_id] : merged)],
          );
          if (input.rating) {
            await tx.query(
              'update persons set rating = $3, rated_at = now(), updated_at = now() where id = $1 and workspace_id = $2',
              [input.person_id, ctx.workspaceId, input.rating],
            );
          }
          const payload = { id: first.id, ...input, note };
          emit('contact', first.id, 'update', payload);
          await runHooks('contactLogged', tx, ctx, { contact: { id: first.id, ...input }, input, reply }, emit);
          return { contact: payload, amended: true, ...reply };
        }
      }
      await rated();
      const id = newId();
      await tx.query(
        `insert into contacts (id, workspace_id, person_id, channel, outcome, rating, note, client_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, ctx.workspaceId, input.person_id, input.channel, input.outcome,
         input.rating || null, input.note || null, input.client_id || null, ctx.user.id],
      );
      if (input.rating) {
        await tx.query(
          'update persons set rating = $3, rated_at = now(), updated_at = now() where id = $1 and workspace_id = $2',
          [input.person_id, ctx.workspaceId, input.rating],
        );
      }
      const payload = { id, ...input };
      emit('contact', id, 'create', payload);
      await runHooks('contactLogged', tx, ctx, { contact: { id, ...input }, input, reply }, emit);
      return { contact: payload, ...reply };
    },
  },

  'person.locate': {
    roles: ALL_ROLES, // pins get placed in the field
    input: z.object({ id: uuid(), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
    handler: async (tx, ctx, input, emit) => {
      await requirePerson(tx, ctx.workspaceId, input.id);
      await tx.query(
        'update persons set lat = $3, lng = $4, updated_at = now() where id = $1 and workspace_id = $2',
        [input.id, ctx.workspaceId, input.lat, input.lng],
      );
      emit('person', input.id, 'update', { lat: input.lat, lng: input.lng });
      return { id: input.id, lat: input.lat, lng: input.lng };
    },
  },

  // ── Signs ──
  'sign.place': {
    roles: ALL_ROLES,
    input: z.object({
      kind: z.enum(SIGN_KIND_CODES),
      status: z.enum(SIGN_STATUSES).default('requested'),
      person_id: uuid().nullish(),
      address: z.string().max(400).nullish(),
      lat: z.number().min(-90).max(90).nullish(),
      lng: z.number().min(-180).max(180).nullish(),
      note: z.string().max(1000).nullish(),
      // Offline outbox key (the column comes from server/ext/offline): a
      // request replayed after reconnecting is the same request, never a
      // second sign.
      client_id: uuid().nullish(),
    }).refine((v) => v.person_id || v.address, { message: 'person_id or address required' }),
    handler: async (tx, ctx, input, emit) => {
      if (input.client_id) {
        const dup = (await tx.query(
          'select id, kind, status, person_id, address from signs where workspace_id = $1 and client_id = $2',
          [ctx.workspaceId, input.client_id],
        )).rows[0];
        if (dup) return { sign: { ...dup, person_id: dup.person_id || null }, duplicate: true };
      }
      let { address, lat, lng } = input;
      if (input.person_id) {
        const p = await requirePerson(tx, ctx.workspaceId, input.person_id);
        address = address || p.address;
        if (lat == null && lng == null && p.lat != null && p.lng != null) { lat = p.lat; lng = p.lng; }
      }
      // A crew needs somewhere to go: an address or a pin.
      if (!String(address || '').trim() && (lat == null || lng == null)) {
        throw httpError(400, 'add an address first — the sign crew needs to know where it goes');
      }
      const id = newId();
      // client_id only when given, so sign.place never needs the column otherwise.
      const withClient = Boolean(input.client_id);
      await tx.query(
        `insert into signs (id, workspace_id, person_id, address, lat, lng, kind, status, note${withClient ? ', client_id' : ''})
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9${withClient ? ', $10' : ''})`,
        [id, ctx.workspaceId, input.person_id || null, address || null, lat ?? null, lng ?? null,
         input.kind, input.status, input.note || null, ...(withClient ? [input.client_id] : [])],
      );
      const payload = { id, kind: input.kind, status: input.status, person_id: input.person_id || null, address };
      emit('sign', id, 'create', { ...payload, client_id: input.client_id || undefined });
      return { sign: payload };
    },
  },

  'sign.update': {
    roles: ALL_ROLES,
    input: z.object({
      id: uuid(),
      status: z.enum(SIGN_STATUSES).nullish(),
      note: z.string().max(1000).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const cur = (await tx.query(
        'select id from signs where id = $1 and workspace_id = $2', [input.id, ctx.workspaceId],
      )).rows[0];
      if (!cur) throw httpError(404, 'sign not found');
      await tx.query(
        `update signs set status = coalesce($3, status), note = coalesce($4, note), updated_at = now()
         where id = $1 and workspace_id = $2`,
        [input.id, ctx.workspaceId, input.status || null, input.note ?? null],
      );
      emit('sign', input.id, 'update', { status: input.status, note: input.note });
      return { id: input.id };
    },
  },

  // Take back a request that never went up (a door-card Undo, a mistaken
  // tap). The request row goes — off every list, map and count — and the log
  // keeps a 'void' event carrying exactly what was cancelled. A sign that has
  // gone up is history, not a request: it is marked taken down instead.
  'sign.cancel': {
    roles: ALL_ROLES,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const s = (await tx.query(
        `select id, person_id, address, lat, lng, kind, status, note, created_at
         from signs where id = $1 and workspace_id = $2 for update`,
        [input.id, ctx.workspaceId],
      )).rows[0];
      if (!s) throw httpError(404, 'sign not found');
      if (s.status !== 'requested') {
        throw httpError(409, s.status === 'installed'
          ? 'that sign is already up — mark it taken down instead'
          : 'that sign was already put up and taken down');
      }
      await tx.query('delete from signs where id = $1 and workspace_id = $2', [s.id, ctx.workspaceId]);
      emit('sign', s.id, 'void', {
        cancelled: true, kind: s.kind, status: s.status, person_id: s.person_id || null,
        address: s.address || null, lat: s.lat ?? null, lng: s.lng ?? null, note: s.note || null,
        requested_at: s.created_at instanceof Date ? s.created_at.toISOString() : s.created_at,
      });
      return { id: s.id, cancelled: true };
    },
  },

  // ── Volunteer roles ──
  'volunteer.assign': {
    roles: DESK_ROLES,
    input: z.object({
      person_id: uuid(),
      role: z.enum(VOLUNTEER_ROLE_CODES),
      detail: z.string().max(200).nullish(), // language, community committee area
    }),
    handler: async (tx, ctx, input, emit) => {
      await requirePerson(tx, ctx.workspaceId, input.person_id);
      const id = newId();
      await tx.query(
        `insert into volunteer_roles (id, workspace_id, person_id, role, detail)
         values ($1, $2, $3, $4, $5)`,
        [id, ctx.workspaceId, input.person_id, input.role, input.detail || null],
      );
      const payload = { id, ...input };
      emit('volunteer_role', id, 'create', payload);
      return { volunteerRole: payload };
    },
  },

  'volunteer.unassign': {
    roles: DESK_ROLES,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const n = await tx.query(
        'delete from volunteer_roles where id = $1 and workspace_id = $2',
        [input.id, ctx.workspaceId],
      );
      if (n.affectedRows === 0) throw httpError(404, 'role assignment not found');
      emit('volunteer_role', input.id, 'void', {});
      return { id: input.id };
    },
  },

  // ── Shifts ──
  'shift.create': {
    roles: DESK_ROLES,
    input: z.object({
      title: z.string().trim().min(1).max(300),
      role: z.enum(VOLUNTEER_ROLE_CODES).nullish(),
      location: z.string().max(400).nullish(),
      starts_at: isoTs(),
      ends_at: isoTs().nullish(),
      instructions: z.string().max(4000).nullish(),
      link: z.string().max(1000).nullish(),
      capacity: z.number().int().positive().nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const id = newId();
      await tx.query(
        `insert into shifts (id, workspace_id, title, role, location, starts_at, ends_at, instructions, link, capacity, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, ctx.workspaceId, input.title, input.role || null, input.location || null,
         input.starts_at, input.ends_at || null, input.instructions || null,
         input.link || null, input.capacity ?? null, ctx.user.id],
      );
      const payload = { id, ...input };
      emit('shift', id, 'create', payload);
      return { shift: payload };
    },
  },

  'shift.assign': {
    roles: DESK_ROLES,
    input: z.object({ shift_id: uuid(), person_id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const shift = (await tx.query(
        'select id, capacity from shifts where id = $1 and workspace_id = $2 and deleted_at is null',
        [input.shift_id, ctx.workspaceId],
      )).rows[0];
      if (!shift) throw httpError(404, 'shift not found');
      await requirePerson(tx, ctx.workspaceId, input.person_id);
      if (shift.capacity && await activeOnShift(tx, ctx.workspaceId, input.shift_id) >= shift.capacity) {
        throw httpError(409, 'shift is at capacity');
      }
      const id = newId();
      try {
        await tx.query(
          `insert into shift_assignments (id, workspace_id, shift_id, person_id)
           values ($1, $2, $3, $4)`,
          [id, ctx.workspaceId, input.shift_id, input.person_id],
        );
      } catch (e) {
        if (String(e.message).includes('shift_assignments_shift_id_person_id_key')) {
          throw httpError(409, 'already assigned to this shift');
        }
        throw e;
      }
      const payload = { id, ...input };
      emit('shift_assignment', id, 'create', payload);
      return { assignment: payload };
    },
  },

  'shift.unassign': {
    roles: DESK_ROLES,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const n = await tx.query(
        'delete from shift_assignments where id = $1 and workspace_id = $2',
        [input.id, ctx.workspaceId],
      );
      if (n.affectedRows === 0) throw httpError(404, 'assignment not found');
      emit('shift_assignment', input.id, 'void', {});
      return { id: input.id };
    },
  },

  // A volunteer books themselves ("Count me in") or drops out ("Can't make
  // it"). They act only on their own record, matched by login email; a
  // newcomer who isn't on the list yet is added as a supporter.
  'shift.join': {
    roles: ALL_ROLES,
    input: z.object({ shift_id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const shift = (await tx.query(
        `select id, capacity, coalesce(ends_at, starts_at) < now() as over
         from shifts where id = $1 and workspace_id = $2 and deleted_at is null for update`,
        [input.shift_id, ctx.workspaceId],
      )).rows[0];
      if (!shift) throw httpError(404, 'shift not found');
      if (shift.over) throw httpError(409, 'that shift is over');
      const me = await selfPerson(tx, ctx, emit, { create: true });
      const cur = (await tx.query(
        'select id, status from shift_assignments where shift_id = $1 and person_id = $2 and workspace_id = $3',
        [shift.id, me.id, ctx.workspaceId],
      )).rows[0];
      if (cur && ACTIVE_SHIFT_STATUSES.includes(cur.status)) throw httpError(409, "you're already on this shift");
      if (shift.capacity && await activeOnShift(tx, ctx.workspaceId, shift.id) >= shift.capacity) {
        throw httpError(409, 'shift is full');
      }
      if (cur) {
        await tx.query("update shift_assignments set status = 'confirmed' where id = $1", [cur.id]);
        emit('shift_assignment', cur.id, 'update', { status: 'confirmed', self: true });
        return { assignment: { id: cur.id, shift_id: shift.id, person_id: me.id, status: 'confirmed' } };
      }
      const id = newId();
      await tx.query(
        `insert into shift_assignments (id, workspace_id, shift_id, person_id, status)
         values ($1, $2, $3, $4, 'confirmed')`,
        [id, ctx.workspaceId, shift.id, me.id],
      );
      const payload = { id, shift_id: shift.id, person_id: me.id, status: 'confirmed', self: true };
      emit('shift_assignment', id, 'create', payload);
      return { assignment: payload };
    },
  },

  'shift.leave': {
    roles: ALL_ROLES,
    input: z.object({ shift_id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const me = await selfPerson(tx, ctx, emit);
      const cur = me && (await tx.query(
        `select id from shift_assignments where shift_id = $1 and person_id = $2 and workspace_id = $3
           and status in ('assigned', 'confirmed')`,
        [input.shift_id, me.id, ctx.workspaceId],
      )).rows[0];
      if (!cur) throw httpError(404, "you're not on this shift");
      // Declined, not deleted: the organizer still sees who dropped out.
      await tx.query("update shift_assignments set status = 'declined' where id = $1", [cur.id]);
      emit('shift_assignment', cur.id, 'update', { status: 'declined', self: true });
      return { id: cur.id, status: 'declined' };
    },
  },

  'shift.setStatus': {
    roles: DESK_ROLES,
    input: z.object({ id: uuid(), status: z.enum(SHIFT_STATUSES) }),
    handler: async (tx, ctx, input, emit) => {
      const cur = (await tx.query(
        `select a.status, a.shift_id, s.capacity from shift_assignments a join shifts s on s.id = a.shift_id
         where a.id = $1 and a.workspace_id = $2`,
        [input.id, ctx.workspaceId],
      )).rows[0];
      if (!cur) throw httpError(404, 'assignment not found');
      const ACTIVE = ACTIVE_SHIFT_STATUSES;
      if (cur.capacity && ACTIVE.includes(input.status) && !ACTIVE.includes(cur.status)
          && await activeOnShift(tx, ctx.workspaceId, cur.shift_id) >= cur.capacity) {
        throw httpError(409, 'shift is at capacity');
      }
      await tx.query(
        'update shift_assignments set status = $3 where id = $1 and workspace_id = $2',
        [input.id, ctx.workspaceId, input.status],
      );
      emit('shift_assignment', input.id, 'update', { status: input.status });
      return { id: input.id, status: input.status };
    },
  },

  // Notify every assignee by email AND text with time, place, instructions,
  // and the shift link. Provider calls happen inside the handler but each
  // result is recorded per-assignee; missing providers record 'queued' (not
  // sent, and nothing sends it later). Every run messages everyone on the
  // shift whatever their last result, so "Notify again" after connecting
  // email/text is how the 'queued' ones are reached. A text the texting rules
  // hold back records why: 'opted_out' (STOP or do-not-text) or 'quiet'
  // (outside the hours texts may go).
  // Each email carries an Idempotency-Key: the shift, the assignment and the
  // round (this shift's notices so far, plus one). The round only moves when
  // a round commits, so Notify again after a crash mid-round is the same
  // round with the same keys, and the email service drops the ones it took;
  // Notify again after a round that went through is a new round.
  'shift.notify': {
    roles: DESK_ROLES,
    input: z.object({ shift_id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const shift = (await tx.query(
        'select * from shifts where id = $1 and workspace_id = $2 and deleted_at is null',
        [input.shift_id, ctx.workspaceId],
      )).rows[0];
      if (!shift) throw httpError(404, 'shift not found');
      const assignees = (await tx.query(
        `select a.id as assignment_id, p.id, p.name, p.email, p.phone
         from shift_assignments a join persons p on p.id = a.person_id
         where a.shift_id = $1 and a.workspace_id = $2 and a.status in ('assigned', 'confirmed')`,
        [input.shift_id, ctx.workspaceId],
      )).rows;

      // Read under the campaign lock runAction holds: two taps can't share a round.
      const round = (await tx.query(
        `select count(*)::int as n from events
         where workspace_id = $1 and entity_type = 'shift' and entity_id = $2 and action = 'shift.notify'`,
        [ctx.workspaceId, shift.id],
      )).rows[0].n + 1;

      const message = shiftMessage(shift, ctx.workspace.name, ctx.workspace.settings?.tz || 'America/Vancouver');
      const results = [];
      for (const a of assignees) {
        const emailRes = a.email
          ? await sendEmail({
            to: a.email, subject: `Your shift: ${shift.title}`, text: message,
            idempotencyKey: `shift-${shift.id}-${a.assignment_id}-${round}`,
          })
          : { status: 'skipped', detail: 'no email on file' };
        // The texting rules (server/ext/texting) apply to notices too: never
        // an opted-out or do-not-text number, never in quiet hours.
        let textRes = { status: 'skipped', detail: 'no phone on file' };
        if (a.phone) {
          const guard = { to: a.phone, status: null, detail: null };
          await runHooks('textOut', tx, ctx, { phone: a.phone, personId: a.id, kind: 'shift' }, guard);
          textRes = guard.status ? { status: guard.status, detail: guard.detail } : await sendText({ to: guard.to, body: message });
        }
        await tx.query(
          `update shift_assignments set notified_at = now(), notify_email = $3, notify_text = $4
           where id = $1 and workspace_id = $2`,
          [a.assignment_id, ctx.workspaceId, emailRes.status, textRes.status],
        );
        results.push({
          person_id: a.id, name: a.name, email: emailRes.status, text: textRes.status,
          ...(['opted_out', 'quiet'].includes(textRes.status) ? { text_note: textRes.detail } : {}),
        });
      }
      emit('shift', shift.id, 'update', { notified: results.length, round });
      return { shift_id: shift.id, notified: results };
    },
  },

  // ── Petitions ──
  // A petition may ask the signer one question (question; the sign page and
  // the website's form show it); each signature keeps the answer.
  'petition.create': {
    roles: DESK_ROLES,
    input: z.object({
      slug: z.string().trim().regex(/^[a-z0-9-]{2,60}$/, 'lowercase letters, digits, dashes'),
      title: z.string().trim().min(1).max(300),
      body: z.string().max(8000).nullish(),
      question: z.string().trim().max(200).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const id = newId();
      try {
        await tx.query(
          'insert into petitions (id, workspace_id, slug, title, body, question) values ($1, $2, $3, $4, $5, $6)',
          [id, ctx.workspaceId, input.slug, input.title, input.body || null, input.question || null],
        );
      } catch (e) {
        if (String(e.message).includes('petitions_workspace_id_slug_key')) {
          throw httpError(409, `a petition with slug '${input.slug}' already exists`);
        }
        throw e;
      }
      const payload = { id, ...input };
      emit('petition', id, 'create', payload);
      return { petition: payload };
    },
  },

  'petition.update': {
    roles: DESK_ROLES,
    input: z.object({
      id: uuid(),
      title: z.string().trim().min(1).max(300).nullish(),
      body: z.string().max(8000).nullish(),
      // '' clears the question; absent leaves it.
      question: z.string().trim().max(200).nullish(),
      active: z.boolean().nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const n = await tx.query(
        `update petitions set title = coalesce($3, title), body = coalesce($4, body),
         question = case when $6::boolean then nullif($5, '') else question end,
         active = coalesce($7, active) where id = $1 and workspace_id = $2`,
        [input.id, ctx.workspaceId, input.title || null, input.body ?? null, input.question ?? null, input.question != null, input.active ?? null],
      );
      if (n.affectedRows === 0) throw httpError(404, 'petition not found');
      emit('petition', input.id, 'update', { title: input.title, active: input.active, ...(input.question != null ? { question: input.question || null } : {}) });
      return { id: input.id };
    },
  },

  // The website's petitions, as it first published them, into a campaign
  // with none (lib/petitions.js): the site signs people up by these slugs.
  'petition.seed': {
    roles: DESK_ROLES,
    input: z.object({}),
    handler: async (tx, ctx, input, emit) => {
      const n = (await tx.query('select count(*)::int as n from petitions where workspace_id = $1', [ctx.workspaceId])).rows[0].n;
      if (n > 0) throw httpError(409, 'this campaign already has petitions — add the rest by hand');
      const made = [];
      for (const pet of SEED_PETITIONS) {
        const id = newId();
        await tx.query(
          'insert into petitions (id, workspace_id, slug, title, body, question) values ($1, $2, $3, $4, $5, $6)',
          [id, ctx.workspaceId, pet.slug, pet.title, pet.body, pet.question],
        );
        emit('petition', id, 'create', { id, ...pet, seeded: true });
        made.push({ id, slug: pet.slug, title: pet.title });
      }
      return { petitions: made };
    },
  },

  // ── Newsletter ──
  'subscription.add': {
    roles: DESK_ROLES,
    input: z.object({
      email: z.string().email().max(320),
      name: z.string().max(300).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const email = input.email.toLowerCase();
      // Someone who left the list — by their own unsubscribe link, a ladder
      // email's, or the desk's Remove — is off-limits to the desk: only they
      // can rejoin, from the signup page.
      const prev = (await tx.query(
        'select status, unsubscribed_at from subscriptions where workspace_id = $1 and email = $2', [ctx.workspaceId, email],
      )).rows[0];
      const optedOut = prev?.status === 'unsubscribed' || (await tx.query(
        `select 1 from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null
           and tags @> '"do-not-email"'::jsonb limit 1`,
        [ctx.workspaceId, email],
      )).rows.length > 0;
      if (optedOut) {
        const tz = ctx.workspace?.settings?.tz || 'America/Vancouver';
        const on = prev?.unsubscribed_at
          ? ` on ${new Date(prev.unsubscribed_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: tz })}`
          : '';
        throw httpError(409, `Unsubscribed${on} — only they can rejoin (signup page)`);
      }
      const id = newId();
      await tx.query(
        `insert into subscriptions (id, workspace_id, email, name, status, source)
         values ($1, $2, $3, $4, 'subscribed', 'manual')
         on conflict (workspace_id, email)
         do update set name = coalesce(excluded.name, subscriptions.name)`,
        [id, ctx.workspaceId, email, input.name || null],
      );
      const row = (await tx.query(
        'select id from subscriptions where workspace_id = $1 and email = $2',
        [ctx.workspaceId, email],
      )).rows[0];
      emit('subscription', row.id, 'create', { email, name: input.name });
      return { id: row.id };
    },
  },

  'subscription.remove': {
    roles: DESK_ROLES,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const n = await tx.query(
        `update subscriptions set status = 'unsubscribed', unsubscribed_at = coalesce(unsubscribed_at, now())
         where id = $1 and workspace_id = $2`,
        [input.id, ctx.workspaceId],
      );
      if (n.affectedRows === 0) throw httpError(404, 'subscription not found');
      emit('subscription', input.id, 'void', {});
      return { id: input.id };
    },
  },

  // ── Email blasts: newsletter → subscribed list; press → media-tagged people ──
  // The send, every recipient row ('queued', each with its own token for the
  // open pixel and its links; the ones to go now asked for) and a send job
  // commit first; then `after` sends them for a few seconds (SEND_INLINE_MS),
  // a few at a time, each claimed 'sending' before its email goes, and hands
  // the rest to the send job — the reply then says they're going ("Sending ·
  // 40 of 340"). A crash or a deploy mid-send leaves a true record: who has
  // it ('sent'), who might ('sending' — not sure; Try again with the same
  // key) and who doesn't yet ('queued' — the send job carries on with them),
  // never no record and never a second copy by itself.
  // Without email connected nothing is sent: the send is saved, and
  // blast.resend sends it once it is.
  // kind: newsletter (the list of subscribers) · press (people tagged media)
  // · eblast (an email to a list or a filter of People: everyone with an
  // address who may be emailed) · text (a text to a list or a filter:
  // everyone with a number that can be texted, through the campaign's
  // Twilio number, inside quiet hours, "Reply STOP to opt out" on each).
  // audience: { list_id } or { filter: { tag, rating, role, has, q } } for
  // eblast and text.
  'blast.send': {
    roles: DESK_ROLES,
    input: z.object({
      kind: z.enum(['newsletter', 'press', 'eblast', 'text']),
      subject: z.string().trim().max(300).default(''),
      body: z.string().trim().min(1).max(50000),
      audience: z.object({
        list_id: z.uuid().optional(),
        filter: z.record(z.string().max(40), z.string().max(400)).optional(),
      }).optional(),
      // Two subject lines: A and B go to two small groups now; the winner
      // goes to everyone else when the wait ends (ext/abtests).
      ab: abInput.nullish(),
      // Files uploaded with blast.attach (ext/abtests/attach.js), to go with every copy.
      attachment_ids: z.array(z.uuid()).max(ATTACH_COUNT).optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const isText = input.kind === 'text';
      const toList = input.kind === 'eblast' || isText;
      if (!isText && !input.subject) throw httpError(400, 'a subject is required');
      if (isText) {
        if (input.ab) throw httpError(400, 'a text has no subject line to test');
        if (input.attachment_ids?.length) throw httpError(400, 'a text carries no files');
        if (input.body.length > TEXT_MAX) throw httpError(400, `a text is ${TEXT_MAX} characters at most`);
        if (!namesCampaign(input.body, ctx.workspace.name)) throw httpError(400, `Say it's ${ctx.workspace.name} in the text`);
        if (/\{\{[^}]*\}\}/.test(input.body)) throw httpError(400, 'Fill in the {{…}} parts first');
      }
      if (input.ab && input.ab.subject_b === input.subject) throw httpError(400, 'subject B is the same as subject A');
      // Winner by clicks needs something to click.
      if (input.ab?.metric === 'clicks' && findLinks(input.body).length === 0) {
        throw httpError(400, 'winner by clicks needs a link in the message');
      }
      let picked = null;
      let audience;
      if (toList) {
        picked = await audienceOf(tx, ctx, input.audience || {});
        if (!picked) throw httpError(404, 'list not found');
        const rows = await recipientsOf(tx, ctx, { list: picked.list, filter: picked.filter, reach: isText ? 'phone' : 'email' });
        audience = isText
          ? rows.map((r) => ({ ...r, phone: e164(r.phone) })).filter((r) => r.phone)
          : rows;
      } else if (input.kind === 'newsletter') {
        audience = (await tx.query(
          `select id, email, name from subscriptions where workspace_id = $1 and status = 'subscribed'`,
          [ctx.workspaceId],
        )).rows;
      } else {
        audience = (await tx.query(
          `select id as person_id, email, name from persons
           where workspace_id = $1 and deleted_at is null and email is not null
             and tags @> '"media"'::jsonb`,
          [ctx.workspaceId],
        )).rows;
      }
      if (audience.length === 0) {
        throw httpError(400, input.kind === 'newsletter' ? 'no subscribed addresses on the newsletter list yet'
          : input.kind === 'press' ? "no people tagged 'media' with an email address yet"
          : isText ? 'no one on this list has a number that can be texted'
          : 'no one on this list has an email address that can be emailed');
      }

      // A test needs a list big enough to tell; a smaller one sends normally.
      const ab = input.ab && audience.length >= AB_MIN ? input.ab : null;
      const groups = ab ? abGroups(audience.length, ab.pct) : [];
      const live = isText ? textConfigured() : emailConfigured();
      const note = live ? null : (isText ? NO_TEXT_PROVIDER : NO_PROVIDER);
      const subject = isText ? (input.subject || input.body.replace(/\s+/g, ' ').slice(0, 80)) : input.subject;

      const id = newId();
      await tx.query(
        `insert into blasts (id, workspace_id, kind, subject, body, status, provider_note, audience_count, created_by, audience, list_id)
         values ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9, $10)`,
        [id, ctx.workspaceId, input.kind, subject, input.body, note, audience.length, ctx.user.id,
          picked ? JSON.stringify({ list_id: picked.list?.id || null, list_name: picked.name, kind: picked.list?.kind || 'filter', filter: picked.list ? picked.list.filter : picked.filter }) : null, picked?.list?.id || null],
      );
      const attachments = await bindAttachments(tx, ctx, id, input.attachment_ids);
      // The rows to go now are asked for. The rest of an A/B send waits for
      // the winner: nothing goes to them now.
      let now = 0;
      for (const [i, r] of audience.entries()) {
        const group = groups[i] || null;
        const asked = live && group !== 'rest';
        await tx.query(
          `insert into blast_recipients (id, workspace_id, blast_id, email, phone, person_id, name, status, token, ab_group, send_asked_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, case when $10 then now() end)`,
          [newId(), ctx.workspaceId, id, isText ? null : r.email, isText ? r.phone : null, r.person_id || (toList ? r.id : null) || null,
            r.name || null, newToken(), group, asked],
        );
        if (asked) now += 1;
      }
      await saveLinks(tx, ctx.workspaceId, id, findLinks(input.body));
      const jobId = now ? await queueSend(tx, ctx, id, 'blast.send') : null;
      // Not connected: the whole test is saved and starts on Send now.
      const test = ab ? await openTest(tx, ctx, id, ab, live) : null;
      emit('blast', id, 'create', {
        kind: input.kind, subject, audience: audience.length, status: 'queued',
        ...(picked ? { list_id: picked.list?.id || null, list_name: picked.name, filter: picked.filter } : {}),
        ...(test ? { ab: { subject_b: ab.subject_b, pct: ab.pct, wait_hours: ab.wait_hours, metric: ab.metric, status: test.status } } : {}),
        ...(attachments.length ? { attachments: attachments.map((a) => a.filename) } : {}),
      });
      return {
        blast: {
          id, kind: input.kind, subject, status: 'queued', audience_count: audience.length, provider_note: note,
          attachments, list_name: picked?.name || null,
          ...(test ? { ab: test } : {}),
        },
        counts: { total: audience.length, sent: 0, failed: 0, queued: audience.length },
        ...(input.ab && !ab ? { ab_skipped: `A/B needs at least ${AB_MIN}` } : {}),
        [SEND]: now ? {
          jobId,
          blast: { id, kind: input.kind, subject, body: input.body, ab_subject_b: ab?.subject_b ?? null, ab_winner: null },
        } : null,
      };
    },
    // Committed: now the emails, for a few seconds; the send job sends the
    // rest. Answers the send as it stands then (counts.going: on their way).
    after: async (db, ctx, result) => {
      const plan = result[SEND];
      if (!plan) return { result };
      const run = await deliver(db, ctx, plan.blast, { actorId: ctx.user.id, budgetMs: inlineMs() });
      const done = await finishRun(db, ctx, {
        actorId: ctx.user.id, action: 'blast.send', blastId: plan.blast.id, note: run.note,
        payload: runPayload('blast.send', run), done: !run.more, jobId: plan.jobId, nextAt: run.heldUntil || null,
      });
      const { status, audience_count: audienceCount, provider_note: providerNote } = done.blast;
      return {
        result: { ...result, blast: { ...result.blast, status, audience_count: audienceCount, provider_note: providerNote }, counts: done.counts },
        lastSeq: done.lastSeq,
      };
    },
  },

  // "Send me a test": the message as it will go, to the person writing it
  // — their own address, no tracking, no list, nothing on record. The
  // files named are their own uploads not yet on a send (they stay for the
  // real send). Refused while email isn't connected.
  'blast.test': {
    roles: DESK_ROLES,
    input: z.object({
      kind: z.enum(['newsletter', 'press', 'eblast']),
      subject: z.string().trim().min(1).max(300),
      body: z.string().trim().min(1).max(50000),
      attachment_ids: z.array(z.uuid()).max(ATTACH_COUNT).optional(),
    }),
    handler: async (tx, ctx, input) => {
      if (!emailConfigured()) throw httpError(409, 'Email isn’t connected — nothing can be sent yet');
      if (!ctx.user?.email) throw httpError(409, 'your sign-in has no email address');
      return { to: ctx.user.email, [SEND]: { ...input } };
    },
    // Committed (nothing was written): now the one email, outside the lock.
    after: async (db, ctx, result) => {
      const plan = result[SEND];
      const attachments = await loadAttachments(db, ctx.workspaceId, { ids: plan.attachment_ids || [], userId: ctx.user.id });
      const res = await sendEmail({
        to: ctx.user.email,
        subject: `[Test] ${plan.subject}`,
        ...composeBlast(ctx, { kind: plan.kind, body: plan.body, unsubscribeUrl: null, token: null, links: [], attachments }),
      });
      return { result: { to: ctx.user.email, sent: res.status === 'sent', detail: res.detail || null } };
    },
  },

  // "Send now": send one saved blast to everyone on it not yet reached — the
  // 'queued' rows (saved while email wasn't connected) and the 'failed' rows
  // (the provider turned them down) — through the same two phases as
  // blast.send (the handler asks for them; `after` claims and sends them for
  // a few seconds, the send job the rest).
  // A 'sent' row is never touched, so no one gets it twice however often it
  // runs. Refused (409) while email isn't connected: nothing pretends to send.
  // A newsletter subscriber who unsubscribed since is taken off the send
  // (never emailed); its status and sent time follow blast.send's rule.
  // An A/B send saved while email wasn't connected starts its test here: A
  // and B go out, the rest stay held until the winner job (ext/abtests).
  // Answers { blast, counts: { total, sent, failed, queued } } for the whole
  // send after this run, plus resent: { sent, failed, skipped } for this run.
  'blast.resend': {
    roles: DESK_ROLES,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const blast = (await tx.query(
        `select id, kind, subject, body, status, provider_note, audience_count, sent_at,
                ab_status, ab_subject_b, ab_pct, ab_wait_hours, ab_metric, ab_decide_at, ab_winner, ab_decided_at
         from blasts where id = $1 and workspace_id = $2`,
        [input.id, ctx.workspaceId],
      )).rows[0];
      if (!blast) throw httpError(404, 'send not found');
      if (!emailConfigured()) throw httpError(409, "email isn't connected yet — connect it, then send");
      // Not reached yet: queued, failed, or 'sending' long enough ago that
      // the service never answered (sent again with the same key, so the
      // service drops it if it did go). Each is asked for now.
      const waiting = (await tx.query(
        `update blast_recipients set send_asked_at = coalesce(send_asked_at, now())
         where blast_id = $1 and workspace_id = $2 and ${retryable()}
           and ($3::boolean or ab_group is distinct from 'rest')
         returning id`,
        [blast.id, ctx.workspaceId, restReleased(blast)],
      )).rows;
      const starting = blast.ab_status === 'saved';
      if (waiting.length === 0 && !starting) {
        return { blast: blastOut(blast), counts: await blastCounts(tx, ctx.workspaceId, blast.id), resent: { sent: 0, failed: 0, skipped: 0 } };
      }
      await saveLinks(tx, ctx.workspaceId, blast.id, findLinks(blast.body));
      // A saved A/B send starts its test now: A and B go out below.
      const test = starting ? await startTest(tx, ctx, blast.id) : null;
      // On the log: who was asked for (and a test that starts).
      emit('blast', blast.id, 'update', { asked: waiting.length, ...(test ? { ab: test.status } : {}) });
      const jobId = waiting.length ? await queueSend(tx, ctx, blast.id, 'blast.resend') : null;
      return { blast: blastOut(blast), [SEND]: { blast, test, jobId } };
    },
    after: async (db, ctx, result) => {
      const plan = result[SEND];
      if (!plan) return { result };
      const run = await deliver(db, ctx, plan.blast, { actorId: ctx.user.id, budgetMs: inlineMs() });
      const done = await finishRun(db, ctx, {
        actorId: ctx.user.id, action: 'blast.resend', blastId: plan.blast.id, note: run.note,
        payload: runPayload('blast.resend', run, plan.test ? { ab: plan.test.status } : {}),
        done: !run.more, jobId: plan.jobId, nextAt: run.heldUntil || null,
      });
      return {
        result: { blast: blastOut(done.blast), counts: done.counts, resent: { sent: run.sent, failed: run.failed, skipped: run.skipped } },
        lastSeq: done.lastSeq,
      };
    },
  },

  // ── Team: invite volunteers and staff; change roles ──
  'member.invite': {
    roles: MANAGER_ONLY,
    input: z.object({
      email: z.string().email().max(320),
      role: z.enum(['manager', 'treasurer', 'staff', 'volunteer']),
    }),
    handler: async (tx, ctx, input, emit) => {
      const email = input.email.toLowerCase();
      const already = (await tx.query(
        `select 1 from memberships m join users u on u.id = m.user_id
         where m.workspace_id = $1 and u.email = $2`,
        [ctx.workspaceId, email],
      )).rows[0];
      if (already) throw httpError(409, `${email} is already on the team`);
      const token = randomBytes(24).toString('hex');
      const id = newId();
      // One live link per email: a new invite ("New link") kills the old one.
      const replaced = (await tx.query(
        `update invites set expires_at = now()
         where workspace_id = $1 and email = $2 and accepted_at is null and expires_at > now()
         returning id`,
        [ctx.workspaceId, email],
      )).rows;
      for (const r of replaced) emit('invite', r.id, 'void', { email, replaced_by: id });
      await tx.query(
        `insert into invites (id, workspace_id, email, role, token_hash, created_by, expires_at)
         values ($1, $2, $3, $4, $5, $6, now() + interval '14 days')`,
        [id, ctx.workspaceId, email, input.role,
         createHash('sha256').update(token).digest('hex'), ctx.user.id],
      );
      const joinUrl = `${ctx.publicUrl || ''}/join/${token}`;
      const mail = await sendEmail({
        to: email,
        subject: `Join ${ctx.workspace.name} on Starbase`,
        text: `${ctx.user.name} invited you to join ${ctx.workspace.name} as ${input.role}.\n\nSet your password and get started: ${joinUrl}\n\nThis link expires in 14 days.`,
      });
      // The token never enters the event log — only who was invited, as what.
      emit('invite', id, 'create', { email, role: input.role });
      return { invite: { id, email, role: input.role }, joinUrl, email: mail.status };
    },
  },

  // Cancel a pending invite: its link stops working at once.
  'member.cancelInvite': {
    roles: MANAGER_ONLY,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const row = (await tx.query(
        `update invites set expires_at = now()
         where id = $1 and workspace_id = $2 and accepted_at is null and expires_at > now()
         returning id, email`,
        [input.id, ctx.workspaceId],
      )).rows[0];
      if (!row) throw httpError(404, 'invite not found');
      emit('invite', row.id, 'void', { email: row.email });
      return { id: row.id };
    },
  },

  'member.setRole': {
    roles: MANAGER_ONLY,
    input: z.object({ user_id: uuid(), role: z.enum(['manager', 'treasurer', 'staff', 'volunteer']) }),
    handler: async (tx, ctx, input, emit) => {
      if (input.user_id === ctx.user.id && input.role !== 'manager') {
        throw httpError(400, 'you cannot remove your own manager role');
      }
      const n = await tx.query(
        'update memberships set role = $3 where user_id = $1 and workspace_id = $2',
        [input.user_id, ctx.workspaceId, input.role],
      );
      if (n.affectedRows === 0) throw httpError(404, 'member not found');
      emit('membership', input.user_id, 'update', { role: input.role });
      return { user_id: input.user_id, role: input.role };
    },
  },

  // Someone who has left the campaign: their membership goes, every session
  // of theirs ends at once (the app signs them out on its next request), and
  // they leave any turfs. What they did stays on the record under their
  // name. A new invite lets them back in with the same account.
  'member.remove': {
    roles: MANAGER_ONLY,
    input: z.object({ user_id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      if (input.user_id === ctx.user.id) throw httpError(400, 'you cannot remove yourself');
      const n = await tx.query(
        'delete from memberships where user_id = $1 and workspace_id = $2',
        [input.user_id, ctx.workspaceId],
      );
      if (n.affectedRows === 0) throw httpError(404, 'member not found');
      await tx.query('delete from sessions where user_id = $1 and workspace_id = $2', [input.user_id, ctx.workspaceId]);
      await tx.query('delete from turf_members where user_id = $1 and workspace_id = $2', [input.user_id, ctx.workspaceId]);
      emit('membership', input.user_id, 'void', {});
      return { user_id: input.user_id };
    },
  },

  // ── Workspace settings (website link for public pages, cap override, …) ──
  'workspace.update': {
    roles: MANAGER_ONLY,
    input: z.object({
      name: z.string().trim().min(1).max(200).nullish(),
      candidate: z.string().max(200).nullish(),
      website: z.string().max(500).nullish(), // e.g. the Imagine Surrey site
      // Shown on the donate page when card payments aren't connected, e.g.
      // "E-transfer to donate@imaginesurrey.ca" or a cheque mailing address.
      donate_instructions: z.string().max(2000).nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const cur = (await tx.query(
        'select settings from workspaces where id = $1', [ctx.workspaceId],
      )).rows[0];
      const settings = typeof cur.settings === 'string' ? JSON.parse(cur.settings) : (cur.settings || {});
      if (input.website !== undefined && input.website !== null) settings.website = input.website;
      if (input.donate_instructions !== undefined && input.donate_instructions !== null) settings.donateInstructions = input.donate_instructions;
      await tx.query(
        `update workspaces set name = coalesce($2, name), candidate = coalesce($3, candidate), settings = $4
         where id = $1`,
        [ctx.workspaceId, input.name || null, input.candidate ?? null, JSON.stringify(settings)],
      );
      emit('workspace', ctx.workspaceId, 'update', { name: input.name, candidate: input.candidate, website: input.website, donate_instructions: input.donate_instructions });
      return { ok: true };
    },
  },
};

const SOCIALS_SHAPE = z.partialRecord(z.enum(SOCIAL_PLATFORMS), z.string().max(300));
export const personFieldExtensions = {
  unit: z.string().max(40).nullish(),
  city: z.string().max(120).nullish(),
  postal: z.string().max(20).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(50).nullish(),
  socials: SOCIALS_SHAPE.nullish(),
};
