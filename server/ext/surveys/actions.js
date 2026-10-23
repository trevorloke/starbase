// Survey builder actions (desk roles). Every change is one runAction: table
// writes + events on the hash chain. Archive keeps every answer; removing a
// question hides it from the field and the results but keeps its answers.
//
//   survey.create            { name, context?, turf_ids?, active? }
//   survey.update            { id, name?, context?, turf_ids?, active? }
//   survey.archive           { id, restore? }   restore: true brings it back (off)
//   survey.question.add      { survey_id, kind, text, options? }
//   survey.question.update   { id, text?, kind?, options? }
//                            text and kind only while unanswered (answers keep
//                            the words they were given to); kind only while the
//                            survey is off too (phones keep questions a day)
//   survey.question.reorder  { survey_id, ids }  every question, in the new order
//   survey.question.remove   { id }
import { z } from 'zod';
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';
import { KINDS, CHOICE_KINDS, OPTION_MAX, OPTIONS_MAX, parseJ } from './answers.js';

const DESK_ROLES = ['manager', 'treasurer', 'staff'];
export const CONTEXTS = ['door', 'calls', 'both'];
export const QUESTIONS_MAX = 20;

const name = () => z.string().trim().min(1).max(120);
const turfIds = () => z.array(z.uuid()).max(50);
const questionText = () => z.string().trim().min(1).max(300);
const options = () => z.array(z.string().trim().min(1).max(OPTION_MAX)).max(OPTIONS_MAX);

const loadSurvey = async (tx, ctx, id) => {
  const s = (await tx.query(
    'select * from surveys where id = $1 and workspace_id = $2 for update', [id, ctx.workspaceId],
  )).rows[0];
  if (!s) throw httpError(404, 'survey not found');
  return s;
};
const openSurvey = async (tx, ctx, id) => {
  const s = await loadSurvey(tx, ctx, id);
  if (s.archived_at) throw httpError(409, 'this survey is archived — bring it back first');
  return s;
};
const loadQuestion = async (tx, ctx, id) => {
  const q = (await tx.query(
    'select * from survey_questions where id = $1 and workspace_id = $2 and removed_at is null for update',
    [id, ctx.workspaceId],
  )).rows[0];
  if (!q) throw httpError(404, 'question not found');
  await openSurvey(tx, ctx, q.survey_id);
  return q;
};

const checkTurfs = async (tx, ctx, ids) => {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return [];
  const found = (await tx.query(
    `select id from turfs where workspace_id = $1 and deleted_at is null
       and id in (select (jsonb_array_elements_text($2::jsonb))::uuid)`,
    [ctx.workspaceId, JSON.stringify(uniq)],
  )).rows.map((r) => r.id);
  if (found.length !== uniq.length) throw httpError(400, 'turf not found');
  return uniq;
};

// Choice questions need two or more different choices; the others none.
const cleanOptions = (kind, list) => {
  if (!CHOICE_KINDS.includes(kind)) {
    if (list?.length) throw httpError(400, 'only choice questions have choices');
    return [];
  }
  const out = (list || []).map((s) => s.trim()).filter(Boolean);
  if (out.length < 2) throw httpError(400, 'add at least two choices');
  if (new Set(out.map((s) => s.toLowerCase())).size !== out.length) throw httpError(400, 'two choices are the same');
  return out;
};

const answeredCount = async (tx, ctx, questionId) => (await tx.query(
  'select count(*)::int as n from survey_responses where workspace_id = $1 and question_id = $2',
  [ctx.workspaceId, questionId],
)).rows[0].n;

const surveyOut = (s) => ({
  id: s.id, name: s.name, context: s.context, turf_ids: parseJ(s.turf_ids, []), active: !!s.active,
  archived: !!s.archived_at,
});
const questionOut = (q) => ({
  id: q.id, survey_id: q.survey_id, position: q.position, kind: q.kind, text: q.text, options: parseJ(q.options, []),
});

export const actions = {
  'survey.create': {
    roles: DESK_ROLES,
    input: z.object({
      name: name(),
      context: z.enum(CONTEXTS).default('both'),
      turf_ids: turfIds().default([]),
      active: z.boolean().default(true),
    }),
    handler: async (tx, ctx, input, emit) => {
      const id = newId();
      const turfs = await checkTurfs(tx, ctx, input.turf_ids);
      await tx.query(
        `insert into surveys (id, workspace_id, name, context, turf_ids, active, created_by)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ctx.workspaceId, input.name, input.context, JSON.stringify(turfs), input.active, ctx.user?.id || null],
      );
      const survey = { id, name: input.name, context: input.context, turf_ids: turfs, active: input.active, archived: false };
      emit('survey', id, 'create', survey);
      return { survey };
    },
  },

  'survey.update': {
    roles: DESK_ROLES,
    input: z.object({
      id: z.uuid(),
      name: name().optional(),
      context: z.enum(CONTEXTS).optional(),
      turf_ids: turfIds().optional(),
      active: z.boolean().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const { id, ...patch } = input;
      const cur = await openSurvey(tx, ctx, id);
      if (patch.turf_ids) patch.turf_ids = await checkTurfs(tx, ctx, patch.turf_ids);
      const next = {
        name: patch.name ?? cur.name,
        context: patch.context ?? cur.context,
        turf_ids: patch.turf_ids ?? parseJ(cur.turf_ids, []),
        active: patch.active ?? !!cur.active,
      };
      await tx.query(
        `update surveys set name = $3, context = $4, turf_ids = $5, active = $6, updated_at = now()
         where id = $1 and workspace_id = $2`,
        [id, ctx.workspaceId, next.name, next.context, JSON.stringify(next.turf_ids), next.active],
      );
      emit('survey', id, 'update', patch);
      return { survey: { id, ...next, archived: false } };
    },
  },

  // Archive: off the field and the list, every answer kept. restore brings it
  // back to the list, still off (the desk turns it on again).
  'survey.archive': {
    roles: DESK_ROLES,
    input: z.object({ id: z.uuid(), restore: z.boolean().default(false) }),
    handler: async (tx, ctx, input, emit) => {
      const cur = await loadSurvey(tx, ctx, input.id);
      if (input.restore) {
        await tx.query('update surveys set archived_at = null, updated_at = now() where id = $1 and workspace_id = $2',
          [cur.id, ctx.workspaceId]);
      } else {
        await tx.query(
          'update surveys set archived_at = coalesce(archived_at, now()), active = false, updated_at = now() where id = $1 and workspace_id = $2',
          [cur.id, ctx.workspaceId],
        );
      }
      emit('survey', cur.id, 'update', input.restore ? { archived: false } : { archived: true, active: false });
      return { survey: { ...surveyOut(cur), active: input.restore ? !!cur.active : false, archived: !input.restore } };
    },
  },

  'survey.question.add': {
    roles: DESK_ROLES,
    input: z.object({
      survey_id: z.uuid(),
      kind: z.enum(KINDS),
      text: questionText(),
      options: options().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      await openSurvey(tx, ctx, input.survey_id);
      const opts = cleanOptions(input.kind, input.options);
      const { n, top } = (await tx.query(
        `select count(*)::int as n, coalesce(max(position), -1)::int as top from survey_questions
         where workspace_id = $1 and survey_id = $2 and removed_at is null`,
        [ctx.workspaceId, input.survey_id],
      )).rows[0];
      if (n >= QUESTIONS_MAX) throw httpError(400, `a survey holds up to ${QUESTIONS_MAX} questions`);
      const id = newId();
      await tx.query(
        `insert into survey_questions (id, workspace_id, survey_id, position, kind, text, options)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ctx.workspaceId, input.survey_id, top + 1, input.kind, input.text, JSON.stringify(opts)],
      );
      const question = { id, survey_id: input.survey_id, position: top + 1, kind: input.kind, text: input.text, options: opts };
      emit('survey_question', id, 'create', question);
      return { question };
    },
  },

  'survey.question.update': {
    roles: DESK_ROLES,
    input: z.object({
      id: z.uuid(),
      text: questionText().optional(),
      kind: z.enum(KINDS).optional(),
      options: options().optional(),
    }),
    handler: async (tx, ctx, input, emit) => {
      const { id, ...patch } = input;
      const cur = await loadQuestion(tx, ctx, id);
      const kind = patch.kind ?? cur.kind;
      const text = patch.text ?? cur.text;
      // Rewording an answered question would put its answers under words
      // nobody was asked; a new kind would make them unreadable.
      if ((kind !== cur.kind || text !== cur.text) && await answeredCount(tx, ctx, id) > 0) {
        throw httpError(409, 'this question has answers — add a new question instead');
      }
      // Phones keep the questions for a day, so a survey being asked keeps
      // each question's kind: answers already on their way still fit.
      if (kind !== cur.kind && (await loadSurvey(tx, ctx, cur.survey_id)).active) {
        throw httpError(409, 'turn off Asking now to change the kind — or add a new question');
      }
      const old = parseJ(cur.options, []);
      const opts = patch.options !== undefined || kind !== cur.kind
        ? cleanOptions(kind, patch.options ?? (CHOICE_KINDS.includes(kind) ? old : []))
        : old;
      // Labels taken off stay valid for answers already on their way.
      const retired = [...new Set([...parseJ(cur.retired_options, []), ...old.filter((o) => !opts.includes(o))])]
        .filter((o) => !opts.includes(o));
      await tx.query(
        `update survey_questions set text = $3, kind = $4, options = $5, retired_options = $6, updated_at = now()
         where id = $1 and workspace_id = $2`,
        [id, ctx.workspaceId, text, kind, JSON.stringify(opts), JSON.stringify(retired)],
      );
      emit('survey_question', id, 'update', { ...patch, options: opts });
      return { question: questionOut({ ...cur, text, kind, options: opts }) };
    },
  },

  'survey.question.reorder': {
    roles: DESK_ROLES,
    input: z.object({ survey_id: z.uuid(), ids: z.array(z.uuid()).min(1).max(QUESTIONS_MAX) }),
    handler: async (tx, ctx, input, emit) => {
      await openSurvey(tx, ctx, input.survey_id);
      const cur = (await tx.query(
        'select id from survey_questions where workspace_id = $1 and survey_id = $2 and removed_at is null',
        [ctx.workspaceId, input.survey_id],
      )).rows.map((r) => r.id);
      const same = cur.length === input.ids.length && new Set(input.ids).size === input.ids.length
        && input.ids.every((qid) => cur.includes(qid));
      if (!same) throw httpError(409, 'the questions changed — reload and try again');
      for (const [i, qid] of input.ids.entries()) {
        await tx.query('update survey_questions set position = $3, updated_at = now() where id = $1 and workspace_id = $2',
          [qid, ctx.workspaceId, i]);
      }
      emit('survey', input.survey_id, 'update', { order: input.ids });
      return { order: input.ids };
    },
  },

  'survey.question.remove': {
    roles: DESK_ROLES,
    input: z.object({ id: z.uuid() }),
    handler: async (tx, ctx, input, emit) => {
      const q = await loadQuestion(tx, ctx, input.id);
      await tx.query('update survey_questions set removed_at = now(), updated_at = now() where id = $1 and workspace_id = $2',
        [q.id, ctx.workspaceId]);
      emit('survey_question', q.id, 'void', { survey_id: q.survey_id, text: q.text });
      return { id: q.id, removed: true };
    },
  },
};
