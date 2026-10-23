// Question kinds, answer validation, and the contactLogged hook that stores
// answers given with a door knock or a call.
//
//   choice   one of the options            value: "Transit"
//   choices  one or more of the options    value: ["Transit", "Housing"]
//   yesno    yes or no                     value: true | false
//   scale    1 to 5                        value: 3
//   text     a short answer                value: "Wants a bike lane on 72 Ave"
//
// An answer is stored only if its question is in the caller's workspace and
// the value fits the question. A question from elsewhere refuses the whole
// contact (400). An answer that no longer fits its question (a phone kept the
// questions for a day; the desk changed one meanwhile) is left out on its
// own: the knock and every other answer are kept, and the reply says which
// were left out (answers_skipped) so the screen never says "saved" for them.
// Answers to a question that has since been removed, or a survey since turned
// off or archived, are still kept: the person really said it (a knock saved
// offline can arrive after the desk's edit). Choice labels taken off a
// question stay valid for the same reason (retired_options).
//
// One answer per question per contact: a later tap of the same visit
// (contact.log visit_of — "Save answers", the answer changed, "Save answers"
// again) replaces that contact's earlier answer to the question (an 'update'
// on the hash chain) instead of storing a second one.
import { newId } from '../../lib/events.js';
import { httpError } from '../../actions/util.js';

export const KINDS = ['choice', 'choices', 'yesno', 'scale', 'text'];
export const CHOICE_KINDS = ['choice', 'choices'];
export const TEXT_MAX = 500;
export const OPTION_MAX = 200; // contact.log caps each picked choice at 200
export const OPTIONS_MAX = 20;
export const SCALE = [1, 2, 3, 4, 5];

export const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
const labels = (v) => (Array.isArray(parseJ(v, [])) ? parseJ(v, []) : []);

// The value as it will be stored, or undefined when it doesn't fit.
export const checkValue = (q, value) => {
  const allowed = new Set([...labels(q.options), ...labels(q.retired_options)]);
  switch (q.kind) {
    case 'choice':
      return typeof value === 'string' && allowed.has(value) ? value : undefined;
    case 'choices':
      return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
        && value.every((v) => typeof v === 'string' && allowed.has(v)) ? value : undefined;
    case 'yesno':
      return typeof value === 'boolean' ? value : undefined;
    case 'scale':
      return Number.isInteger(value) && SCALE.includes(value) ? value : undefined;
    case 'text': {
      if (typeof value !== 'string') return undefined;
      const t = value.trim();
      return t && t.length <= TEXT_MAX ? t : undefined;
    }
    default:
      return undefined;
  }
};

// How an answer reads on a screen or in a CSV cell.
// Stored values come back from the database already parsed (jsonb); a text
// answer is a plain string, so it is never JSON.parse'd again.
export const showValue = (kind, v) => {
  if (kind === 'yesno') return v === true ? 'Yes' : v === false ? 'No' : '';
  if (Array.isArray(v)) return v.join(', ');
  return v == null ? '' : String(v);
};

// contactLogged hook (lib/hooks.js): runs inside contact.log's transaction.
export const storeAnswers = async (tx, ctx, { contact, input, reply = {} }, emit) => {
  const answers = Array.isArray(input?.answers) ? input.answers : [];
  if (!answers.length) return;
  const ids = answers.map((a) => a.question_id);
  if (new Set(ids).size !== ids.length) throw httpError(400, 'one answer per question');
  const rows = (await tx.query(
    `select id, survey_id, kind, text, options, retired_options from survey_questions
     where workspace_id = $1 and id in (select (jsonb_array_elements_text($2::jsonb))::uuid)`,
    [ctx.workspaceId, JSON.stringify(ids)],
  )).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const checked = answers.map((a) => {
    const q = byId.get(a.question_id);
    if (!q) throw httpError(400, 'that question is not in this campaign');
    return { q, value: checkValue(q, a.value) };
  });
  const skipped = checked.filter((a) => a.value === undefined);
  reply.answers_saved = checked.length - skipped.length;
  reply.answers_skipped = skipped.map(({ q }) => ({ question_id: q.id, question: q.text }));
  // This contact's answers so far (a later tap of the same visit, visit_of):
  // a new answer to one of those questions replaces it — one answer per
  // question per visit, newest last in each list.
  const prior = new Map();
  for (const r of (await tx.query(
    `select id, question_id, value from survey_responses
     where workspace_id = $1 and contact_id = $2 and question_id in (select (jsonb_array_elements_text($3::jsonb))::uuid)
     order by created_at, id for update`,
    [ctx.workspaceId, contact.id, JSON.stringify(ids)],
  )).rows) {
    if (!prior.has(r.question_id)) prior.set(r.question_id, []);
    prior.get(r.question_id).push(r);
  }
  for (const { q, value } of checked) {
    if (value === undefined) continue;
    const earlier = prior.get(q.id) || [];
    if (earlier.length) {
      const [keep] = earlier.slice(-1);
      await tx.query(
        'update survey_responses set value = $3, created_by = $4 where id = $1 and workspace_id = $2',
        [keep.id, ctx.workspaceId, JSON.stringify(value), ctx.user?.id || null],
      );
      emit('survey_response', keep.id, 'update', { contact_id: contact.id, question_id: q.id, value, was: keep.value });
      // Two answers to one question on one visit (stored before answers were
      // replaced): only the newest stays.
      for (const extra of earlier.slice(0, -1)) {
        await tx.query('delete from survey_responses where id = $1 and workspace_id = $2', [extra.id, ctx.workspaceId]);
        emit('survey_response', extra.id, 'void', { contact_id: contact.id, question_id: q.id, value: extra.value, replaced_by: keep.id });
      }
      continue;
    }
    const id = newId();
    await tx.query(
      `insert into survey_responses (id, workspace_id, survey_id, question_id, contact_id, person_id, value, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, ctx.workspaceId, q.survey_id, q.id, contact.id, input.person_id, JSON.stringify(value), ctx.user?.id || null],
    );
    emit('survey_response', id, 'create', {
      id, contact_id: contact.id, person_id: input.person_id, survey_id: q.survey_id, question_id: q.id, value,
    });
  }
};
