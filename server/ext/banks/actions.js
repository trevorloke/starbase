// bank.create   { name, script?, person_ids[] }       desk: a bank from a list of people (those with a phone, not do-not-contact)
// bank.update   { id, name?, script?, closed? }       desk
// bank.remove   { id }                                desk: void (nothing else moves)
// bank.add      { id, person_ids[] }                  desk: more numbers
// bank.assign   { id, user_id | team_id, count? }     desk: hand the next numbers to one caller, or split them across a team
// bank.release  { id, user_id?, person_id? }          desk: take unfinished numbers back (one person's, or one number)
// bank.done     { id, person_id, outcome? }           anyone: cross a number off without a call (wrong number, asked not to call)
import { z } from 'zod';
import { httpError } from '../../actions/util.js';
import { newId } from '../../lib/events.js';

const DESK = ['manager', 'staff', 'treasurer'];
const ALL = ['manager', 'treasurer', 'staff', 'volunteer'];
const uuid = () => z.uuid();
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const NO_CONTACT = 'do-not-contact';
const MAX_NUMBERS = 5000;

const bankOf = async (tx, ws, id) => {
  const b = (await tx.query('select * from call_banks where id = $1 and workspace_id = $2 and deleted_at is null', [id, ws])).rows[0];
  if (!b) throw httpError(404, 'phone bank not found');
  return b;
};
// The people who can be called: on the list, with a phone, not do-not-contact.
const callable = async (tx, ws, ids) => (await tx.query(
  `select id from persons where workspace_id = $1 and id = any($2::uuid[]) and deleted_at is null
     and coalesce(phone, '') <> '' and not (tags @> $3::jsonb)`,
  [ws, ids, JSON.stringify([NO_CONTACT])],
)).rows.map((r) => r.id);
const addNumbers = async (tx, ws, bankId, personIds) => {
  const ok = await callable(tx, ws, [...new Set(personIds)]);
  const start = Number((await tx.query('select coalesce(max(position), 0) as p from call_bank_numbers where bank_id = $1', [bankId])).rows[0].p);
  let added = 0;
  for (let i = 0; i < ok.length; i++) {
    const r = await tx.query(
      'insert into call_bank_numbers (bank_id, workspace_id, person_id, position) values ($1, $2, $3, $4) on conflict do nothing',
      [bankId, ws, ok[i], start + i + 1],
    );
    added += r.affectedRows ?? r.rowCount ?? 0;
  }
  return { added, skipped: personIds.length - ok.length };
};
const counts = async (tx, bankId) => (await tx.query(
  `select count(*)::int as total, count(assigned_to)::int as assigned, count(done_at)::int as done,
          count(*) filter (where assigned_to is null and done_at is null)::int as open
     from call_bank_numbers where bank_id = $1`, [bankId],
)).rows[0];

export const actions = {
  'bank.create': {
    roles: DESK,
    input: z.object({ name: z.string().max(120), script: z.string().max(20_000).nullish(), person_ids: z.array(uuid()).max(MAX_NUMBERS) }),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const name = clean(input.name);
      if (!name) throw httpError(400, 'a phone bank needs a name');
      const id = newId();
      await tx.query('insert into call_banks (id, workspace_id, name, script, created_by) values ($1, $2, $3, $4, $5)', [id, ws, name, input.script || null, ctx.user.id]);
      const { added, skipped } = await addNumbers(tx, ws, id, input.person_ids);
      emit('call_bank', id, 'create', { name, numbers: added });
      return { bank: { id, name, script: input.script || null, ...(await counts(tx, id)) }, added, skipped };
    },
  },
  'bank.update': {
    roles: DESK,
    input: z.object({ id: uuid(), name: z.string().max(120).optional(), script: z.string().max(20_000).nullish(), closed: z.boolean().optional() }),
    handler: async (tx, ctx, input, emit) => {
      const b = await bankOf(tx, ctx.workspaceId, input.id);
      const name = input.name === undefined ? b.name : clean(input.name);
      if (!name) throw httpError(400, 'a phone bank needs a name');
      const script = input.script === undefined ? b.script : (input.script || null);
      const closed = input.closed === undefined ? !!b.closed_at : input.closed;
      await tx.query('update call_banks set name = $2, script = $3, closed_at = case when $4 then coalesce(closed_at, now()) else null end, updated_at = now() where id = $1', [b.id, name, script, closed]);
      emit('call_bank', b.id, 'update', { name, closed });
      return { bank: { id: b.id, name, script, closed } };
    },
  },
  'bank.remove': {
    roles: DESK,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const b = await bankOf(tx, ctx.workspaceId, input.id);
      await tx.query('update call_banks set deleted_at = now(), updated_at = now() where id = $1', [b.id]);
      emit('call_bank', b.id, 'void', {});
      return { removed: true };
    },
  },
  'bank.add': {
    roles: DESK,
    input: z.object({ id: uuid(), person_ids: z.array(uuid()).min(1).max(MAX_NUMBERS) }),
    handler: async (tx, ctx, input, emit) => {
      const b = await bankOf(tx, ctx.workspaceId, input.id);
      const { added, skipped } = await addNumbers(tx, ctx.workspaceId, b.id, input.person_ids);
      emit('call_bank', b.id, 'update', { added });
      return { added, skipped, ...(await counts(tx, b.id)) };
    },
  },
  'bank.assign': {
    roles: DESK,
    input: z.object({ id: uuid(), user_id: uuid().optional(), team_id: uuid().optional(), count: z.number().int().min(1).max(MAX_NUMBERS).optional() })
      .refine((v) => !!v.user_id !== !!v.team_id, 'a caller or a team'),
    handler: async (tx, ctx, input, emit) => {
      const ws = ctx.workspaceId;
      const b = await bankOf(tx, ws, input.id);
      if (b.closed_at) throw httpError(409, 'this phone bank is closed');
      let callers;
      if (input.user_id) {
        const m = (await tx.query('select 1 from memberships where workspace_id = $1 and user_id = $2', [ws, input.user_id])).rows[0];
        if (!m) throw httpError(404, 'that person is not on the campaign');
        callers = [input.user_id];
      } else {
        const t = (await tx.query('select id from teams where id = $1 and workspace_id = $2 and deleted_at is null', [input.team_id, ws])).rows[0];
        if (!t) throw httpError(404, 'team not found');
        callers = (await tx.query('select user_id from team_members where team_id = $1 order by created_at', [input.team_id])).rows.map((r) => r.user_id);
        if (!callers.length) throw httpError(400, 'nobody is on that team yet');
      }
      const open = (await tx.query(
        'select person_id from call_bank_numbers where bank_id = $1 and assigned_to is null and done_at is null order by position', [b.id],
      )).rows.map((r) => r.person_id);
      const take = Math.min(open.length, input.count ?? open.length);
      const given = {};
      for (let i = 0; i < take; i++) {
        const who = callers[i % callers.length];
        await tx.query('update call_bank_numbers set assigned_to = $3, assigned_at = now() where bank_id = $1 and person_id = $2', [b.id, open[i], who]);
        given[who] = (given[who] || 0) + 1;
      }
      emit('call_bank', b.id, 'update', { assigned: take, to: Object.keys(given) });
      return { handed: take, given, ...(await counts(tx, b.id)) };
    },
  },
  'bank.release': {
    roles: DESK,
    input: z.object({ id: uuid(), user_id: uuid().optional(), person_id: uuid().optional() }),
    handler: async (tx, ctx, input, emit) => {
      const b = await bankOf(tx, ctx.workspaceId, input.id);
      const r = await tx.query(
        `update call_bank_numbers set assigned_to = null, assigned_at = null where bank_id = $1 and done_at is null and assigned_to is not null
           and ($2::uuid is null or assigned_to = $2) and ($3::uuid is null or person_id = $3)`,
        [b.id, input.user_id || null, input.person_id || null],
      );
      const released = r.affectedRows ?? r.rowCount ?? 0;
      emit('call_bank', b.id, 'update', { released });
      return { released, ...(await counts(tx, b.id)) };
    },
  },
  'bank.done': {
    roles: ALL,
    input: z.object({ id: uuid(), person_id: uuid(), outcome: z.string().max(40).nullish() }),
    handler: async (tx, ctx, input, emit) => {
      const b = await bankOf(tx, ctx.workspaceId, input.id);
      const n = (await tx.query('select assigned_to, done_at from call_bank_numbers where bank_id = $1 and person_id = $2', [b.id, input.person_id])).rows[0];
      if (!n) throw httpError(404, 'that number is not in this phone bank');
      if (ctx.role === 'volunteer' && n.assigned_to !== ctx.user.id) throw httpError(403, 'that number is not yours');
      if (n.done_at) return { done: true, already: true };
      await tx.query('update call_bank_numbers set done_at = now(), done_by = $3, outcome = $4 where bank_id = $1 and person_id = $2', [b.id, input.person_id, ctx.user.id, clean(input.outcome) || 'skipped']);
      emit('call_bank', b.id, 'update', { done: input.person_id, by: ctx.user.id });
      return { done: true };
    },
  },
};

// A phone call logged by the caller a number was handed to crosses it off
// in every open phone bank it is in (contactLogged hook).
export const crossOff = async (tx, ctx, { contact }) => {
  if (!contact?.person_id || contact.channel !== 'phone') return;
  await tx.query(
    `update call_bank_numbers n set done_at = now(), done_by = $2, outcome = $4
       from call_banks b where b.id = n.bank_id and b.workspace_id = $1 and b.deleted_at is null
        and n.person_id = $3 and n.done_at is null and (n.assigned_to = $2 or n.assigned_to is null)`,
    [ctx.workspaceId, ctx.user.id, contact.person_id, String(contact.outcome || 'contacted')],
  );
};
