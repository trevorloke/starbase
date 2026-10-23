// Surveys — a survey builder for the desk, asked at the door and on calls.
//
// The desk builds surveys (name; questions of five kinds; where they're
// asked: door, calls or both; optionally only inside some turfs; on/off;
// archive). Wherever someone is rated, the field shows the active survey's
// questions; the answers ride along with the next contact.log as
// `answers: [{ question_id, value }]` (so they go through the offline outbox
// unchanged) and the contactLogged hook stores them in the same transaction.
//
//   sql.js      tables: surveys, survey_questions, survey_responses
//   answers.js  kinds, answer validation, the contactLogged hook
//   actions.js  survey.* builder actions (desk roles)
//   api.js      GET /api/surveys/active (any role) and the desk-only reads
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
import { storeAnswers } from './answers.js';

export const hooks = { contactLogged: storeAnswers };

// In the full export: the surveys, their questions and every answer.
export const exportTables = ['surveys', 'survey_questions', 'survey_responses'];

// Volunteers read only /surveys/active (questions). Everything else — the
// list, the builder, results, the CSV, a person's answers — is desk-only.
export const deskOnlyReads = [
  '/surveys',
  /^\/api\/surveys\/(?!active$)[^/]+$/,
  '/surveys/:id/results',
  '/surveys/:id/results.csv',
  '/persons/:id/answers',
];
