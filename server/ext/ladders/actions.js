// ladder.* actions — desk roles only (manager, treasurer, staff). Same
// contract as every action: zod input, a transactional handler, events.
//
//   ladder.create       name + trigger (+ steps); a new ladder starts Off
//   ladder.update       name, trigger, steps, "let people go through again"
//   ladder.setActive    On: people who start it from now on are put on it,
//                       and paused runs pick up at the same step. Off: every
//                       run holds its place and pending steps are cancelled.
//   ladder.delete       gone from the lists; runs end, follow-ups stay
//   ladder.stopRun      take one person off a ladder
//   ladder.followupDone a follow-up done (or, with done: false, not yet)
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { triggerSchema, stepsSchema, runnable, parseJson } from './shape.js';
import { pauseLadder, resumeLadder, endRun, appendLog } from './engine.js';

const DESK = ['manager', 'treasurer', 'staff'];
const uuid = () => z.uuid();
const name = () => z.string().trim().min(1).max(120);

const loadLadder = async (tx, ws, id) => {
  const l = (await tx.query(
    'select * from ladders where id = $1 and workspace_id = $2 and deleted_at is null for update',
    [id, ws],
  )).rows[0];
  if (!l) throw httpError(404, 'ladder not found');
  return l;
};

// A petition or event a trigger names must be this campaign's.
const checkRef = async (tx, ws, trigger) => {
  if (!trigger.ref) return null;
  if (trigger.kind === 'petition') {
    const p = (await tx.query('select slug from petitions where workspace_id = $1 and slug = $2', [ws, trigger.ref])).rows[0];
    if (!p) throw httpError(400, 'that petition is not in this campaign');
  }
  if (trigger.kind === 'rsvp') {
    const e = (await tx.query('select id from campaign_events where workspace_id = $1 and id = $2 and deleted_at is null', [ws, trigger.ref])).rows[0];
    if (!e) throw httpError(400, 'that event is not in this campaign');
  }
  if (trigger.kind === 'tag' || trigger.kind === 'petition' || trigger.kind === 'rsvp') return trigger.ref;
  return null; // the others take no detail
};

const out = (l) => ({
  id: l.id, name: l.name, trigger: { kind: l.trigger_kind, ref: l.trigger_ref || null },
  steps: parseJson(l.steps, []), active: l.active, reentry: l.reentry,
});

export const actions = {
  'ladder.create': {
    roles: DESK,
    input: z.object({
      name: name(),
      trigger: triggerSchema,
      steps: stepsSchema.default([]),
      reentry: z.boolean().default(false),
    }),
    handler: async (tx, ctx, input, emit) => {
      const ref = await checkRef(tx, ctx.workspaceId, input.trigger);
      const id = newId();
      await tx.query(
        `insert into ladders (id, workspace_id, name, trigger_kind, trigger_ref, steps, reentry, public_url, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, ctx.workspaceId, input.name, input.trigger.kind, ref, JSON.stringify(input.steps),
         input.reentry, ctx.publicUrl || null, ctx.user.id],
      );
      const ladder = { id, name: input.name, trigger: { kind: input.trigger.kind, ref }, steps: input.steps, active: false, reentry: input.reentry };
      emit('ladder', id, 'create', ladder);
      return { ladder };
    },
  },

  'ladder.update': {
    roles: DESK,
    input: z.object({
      id: uuid(),
      name: name().nullish(),
      trigger: triggerSchema.nullish(),
      steps: stepsSchema.nullish(),
      reentry: z.boolean().nullish(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadLadder(tx, ctx.workspaceId, input.id);
      const next = { ...cur };
      const patch = {};
      if (input.name) { next.name = input.name; patch.name = input.name; }
      if (input.trigger) {
        next.trigger_kind = input.trigger.kind;
        next.trigger_ref = await checkRef(tx, ctx.workspaceId, input.trigger);
        patch.trigger = { kind: next.trigger_kind, ref: next.trigger_ref };
      }
      if (input.steps) {
        if (cur.active && !runnable(input.steps)) throw httpError(400, 'a ladder that is on needs a step that does something');
        next.steps = input.steps;
        patch.steps = input.steps;
      }
      if (input.reentry != null) { next.reentry = input.reentry; patch.reentry = input.reentry; }
      await tx.query(
        `update ladders set name = $3, trigger_kind = $4, trigger_ref = $5, steps = $6, reentry = $7,
           public_url = coalesce($8, public_url), updated_at = now()
         where id = $1 and workspace_id = $2`,
        [cur.id, ctx.workspaceId, next.name, next.trigger_kind, next.trigger_ref || null,
         JSON.stringify(parseJson(next.steps, [])), next.reentry, ctx.publicUrl || null],
      );
      emit('ladder', cur.id, 'update', patch);
      return { ladder: out(next) };
    },
  },

  'ladder.setActive': {
    roles: DESK,
    input: z.object({ id: uuid(), active: z.boolean() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadLadder(tx, ctx.workspaceId, input.id);
      if (cur.active === input.active) return { ladder: out(cur), paused: 0, resumed: 0 };
      if (input.active && !runnable(parseJson(cur.steps, []))) {
        throw httpError(400, 'add a step first — an email, a tag or a follow-up');
      }
      await tx.query(
        'update ladders set active = $3, public_url = coalesce($4, public_url), updated_at = now() where id = $1 and workspace_id = $2',
        [cur.id, ctx.workspaceId, input.active, ctx.publicUrl || null],
      );
      // The order matters: resuming schedules jobs, pausing cancels them.
      const resumed = input.active ? await resumeLadder(tx, ctx.workspaceId, cur.id) : 0;
      const paused = input.active ? 0 : await pauseLadder(tx, ctx.workspaceId, cur.id);
      emit('ladder', cur.id, 'update', { active: input.active, paused, resumed });
      return { ladder: out({ ...cur, active: input.active }), paused, resumed };
    },
  },

  'ladder.delete': {
    roles: DESK,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadLadder(tx, ctx.workspaceId, input.id);
      await pauseLadder(tx, ctx.workspaceId, cur.id);
      const ended = (await tx.query(
        `update ladder_runs set status = 'done', wait = null, next_at = null, token = null,
           finished_at = coalesce(finished_at, now()), updated_at = now()
         where workspace_id = $1 and ladder_id = $2 and status <> 'done' returning id`,
        [ctx.workspaceId, cur.id],
      )).rows.length;
      await tx.query(
        'update ladders set active = false, deleted_at = now(), updated_at = now() where id = $1 and workspace_id = $2',
        [cur.id, ctx.workspaceId],
      );
      emit('ladder', cur.id, 'void', { name: cur.name, ended });
      return { id: cur.id, ended };
    },
  },

  'ladder.stopRun': {
    roles: DESK,
    input: z.object({ id: uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const run = (await tx.query(
        `select id, workspace_id, ladder_id, person_id, status, step, log from ladder_runs
         where id = $1 and workspace_id = $2 for update`,
        [input.id, ctx.workspaceId],
      )).rows[0];
      if (!run) throw httpError(404, 'not on that ladder');
      if (run.status === 'done') return { id: run.id, status: 'done' };
      await endRun(tx, run);
      await appendLog(tx, run, { step: Number(run.step), kind: 'end', result: 'taken_off' });
      emit('ladder_run', run.id, 'update', { ladder_id: run.ladder_id, person_id: run.person_id, status: 'done', reason: 'taken_off' });
      return { id: run.id, status: 'done' };
    },
  },

  'ladder.followupDone': {
    roles: DESK,
    input: z.object({ id: uuid(), done: z.boolean().default(true) }),
    handler: async (tx, ctx, input, emit) => {
      const row = (await tx.query(
        `update ladder_followups
         set status = $3, done_at = case when $3 = 'done' then now() end, done_by = case when $3 = 'done' then $4::uuid end
         where id = $1 and workspace_id = $2 and status <> $3
         returning id, status`,
        [input.id, ctx.workspaceId, input.done ? 'done' : 'open', ctx.user.id],
      )).rows[0];
      if (!row) {
        const exists = (await tx.query('select status from ladder_followups where id = $1 and workspace_id = $2', [input.id, ctx.workspaceId])).rows[0];
        if (!exists) throw httpError(404, 'follow-up not found');
        return { id: input.id, status: exists.status };
      }
      emit('ladder_followup', row.id, 'update', { status: row.status });
      return { id: row.id, status: row.status };
    },
  },
};
