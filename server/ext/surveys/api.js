// Survey reads, mounted under /api (signed in).
//
//   GET /surveys/active?context=door|calls[&turf=<id>]   any role
//       The surveys asked there now, questions only: { surveys: [{ id, name,
//       turf_ids, areas, questions: [{ id, kind, text, options }] }] }. A
//       survey kept to some turfs carries those turfs' outlines (areas, no
//       names or people) so a phone can tell, offline too, whether a door is
//       inside one; with turf= only surveys asked in that turf come back.
//   GET /surveys                    desk: every survey with counts
//   GET /surveys/:id                desk: the builder (questions + turfs to pick)
//   GET /surveys/:id/results        desk: per question, each choice's count,
//                                   % of the people who answered it, and who
//                                   (for follow-up); short answers as a list
//   GET /surveys/:id/results.csv    desk: one row per person, one column per question
//   GET /persons/:id/answers        desk: everything this person answered
//
// Results count each person's latest answer to a question once. Volunteers
// never read results or anyone's answers: these paths are desk-only reads
// (index.js) and each handler checks the role again.
import { Hono } from 'hono';
import { KINDS, CHOICE_KINDS, SCALE, parseJ, showValue } from './answers.js';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDesk = (c) => c.get('ctx').role !== 'volunteer';
const refuse = (c) => c.json({ error: 'volunteers cannot view this' }, 403);
const PEOPLE_MAX = 200;
const TEXT_LIST_MAX = 100;

// Who "answered": people still on the list, with an answer to a question
// still on the survey — the same count on the list, the builder and results.
const ANSWERED_FROM = `from survey_responses r
  join persons p on p.id = r.person_id and p.deleted_at is null
  join survey_questions q on q.id = r.question_id and q.removed_at is null`;

const liveTurfs = async (db, ws) => (await db.query(
  'select id, name, polygon from turfs where workspace_id = $1 and deleted_at is null order by created_at',
  [ws],
)).rows.map((t) => ({ id: t.id, name: t.name, polygon: parseJ(t.polygon, []) }));

const questionsOf = async (db, ws, surveyIds) => (surveyIds.length ? (await db.query(
  `select id, survey_id, position, kind, text, options from survey_questions
   where workspace_id = $1 and removed_at is null
     and survey_id in (select (jsonb_array_elements_text($2::jsonb))::uuid)
   order by position, created_at`,
  [ws, JSON.stringify(surveyIds)],
)).rows.map((q) => ({ ...q, options: parseJ(q.options, []) })) : []);

// ── The field: what to ask here ──
api.get('/surveys/active', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const context = c.req.query('context');
  if (context !== 'door' && context !== 'calls') return c.json({ error: 'context: door or calls' }, 400);
  const turf = c.req.query('turf') || null;
  if (turf && !UUID_RE.test(turf)) return c.json({ error: 'turf not found' }, 404);
  const surveys = (await db.query(
    `select id, name, turf_ids from surveys
     where workspace_id = $1 and archived_at is null and active and context in ($2, 'both')
     order by created_at`,
    [ctx.workspaceId, context],
  )).rows;
  const turfs = new Map((await liveTurfs(db, ctx.workspaceId)).map((t) => [t.id, t]));
  const questions = await questionsOf(db, ctx.workspaceId, surveys.map((s) => s.id));
  const out = [];
  for (const s of surveys) {
    const wanted = parseJ(s.turf_ids, []);
    const ids = wanted.filter((id) => turfs.has(id));
    const limited = wanted.length > 0;
    if (turf && limited && !ids.includes(turf)) continue;
    const qs = questions.filter((q) => q.survey_id === s.id)
      .map((q) => ({ id: q.id, kind: q.kind, text: q.text, options: CHOICE_KINDS.includes(q.kind) ? q.options : [] }));
    if (!qs.length) continue;
    out.push({
      id: s.id,
      name: s.name,
      // A survey kept to turfs that have all been deleted is asked nowhere.
      limited,
      turf_ids: ids,
      areas: limited ? ids.map((id) => turfs.get(id).polygon) : [],
      questions: qs,
    });
  }
  return c.json({ surveys: out });
});

// ── Desk: the list ──
api.get('/surveys', async (c) => {
  if (!isDesk(c)) return refuse(c);
  const ctx = c.get('ctx');
  const rows = (await c.get('db').query(
    `select s.id, s.name, s.context, s.turf_ids, s.active, s.archived_at, s.created_at,
            (select count(*)::int from survey_questions q where q.survey_id = s.id and q.removed_at is null) as questions,
            (select count(distinct r.person_id)::int ${ANSWERED_FROM} where r.survey_id = s.id) as people,
            (select max(r.created_at) from survey_responses r where r.survey_id = s.id) as last_at
     from surveys s where s.workspace_id = $1
     order by s.created_at desc`,
    [ctx.workspaceId],
  )).rows;
  return c.json({
    surveys: rows.map((s) => ({
      id: s.id, name: s.name, context: s.context, turf_ids: parseJ(s.turf_ids, []), active: !!s.active,
      archived: !!s.archived_at, questions: s.questions, people: s.people, last_at: s.last_at, created_at: s.created_at,
    })),
  });
});

const loadSurvey = async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id || '')) return null;
  return (await c.get('db').query(
    'select * from surveys where id = $1 and workspace_id = $2', [id, c.get('ctx').workspaceId],
  )).rows[0] || null;
};
const surveyOut = (s) => ({
  id: s.id, name: s.name, context: s.context, turf_ids: parseJ(s.turf_ids, []), active: !!s.active,
  archived: !!s.archived_at, created_at: s.created_at,
});

// Each person's latest answer to each question of a survey (people still on the list).
const latestAnswers = async (db, ws, surveyId) => (await db.query(
  `select distinct on (r.person_id, r.question_id)
          r.person_id, r.question_id, r.value, r.created_at, p.name, p.phone, p.email, p.address, p.unit
   from survey_responses r join persons p on p.id = r.person_id and p.deleted_at is null
   where r.workspace_id = $1 and r.survey_id = $2
   order by r.person_id, r.question_id, r.created_at desc, r.id desc`,
  [ws, surveyId],
)).rows;

// ── Desk: the builder ──
api.get('/surveys/:id', async (c) => {
  if (!isDesk(c)) return refuse(c);
  const s = await loadSurvey(c);
  if (!s) return c.json({ error: 'not found' }, 404);
  const db = c.get('db');
  const ws = c.get('ctx').workspaceId;
  const questions = await questionsOf(db, ws, [s.id]);
  const counts = new Map((await db.query(
    `select r.question_id, (count(distinct r.person_id) filter (where p.deleted_at is null))::int as n, count(*)::int as total
     from survey_responses r join persons p on p.id = r.person_id
     where r.workspace_id = $1 and r.survey_id = $2 group by r.question_id`,
    [ws, s.id],
  )).rows.map((r) => [r.question_id, r]));
  const people = (await db.query(
    `select count(distinct r.person_id)::int as n ${ANSWERED_FROM} where r.workspace_id = $1 and r.survey_id = $2`,
    [ws, s.id],
  )).rows[0].n;
  const turfs = (await liveTurfs(db, ws)).map(({ id, name }) => ({ id, name }));
  return c.json({
    survey: { ...surveyOut(s), people },
    questions: questions.map((q) => ({
      id: q.id, position: q.position, kind: q.kind, text: q.text, options: q.options,
      answered: counts.get(q.id)?.n || 0,
      // Any answer at all fixes the words and the kind (survey.question.update
      // refuses a change); while the survey is asked the kind is fixed too.
      locked: (counts.get(q.id)?.total || 0) > 0,
    })),
    turfs,
  });
});

// One question's tally: a bar per choice (current choices first, then any
// older label someone picked), each with its people.
const tally = (q, rows) => {
  const answered = rows.length;
  const base = { id: q.id, kind: q.kind, text: q.text, answered };
  if (q.kind === 'text') {
    const sorted = [...rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return {
      ...base,
      answers: sorted.slice(0, TEXT_LIST_MAX).map((r) => ({
        value: String(r.value ?? ''), person: { id: r.person_id, name: r.name }, at: r.created_at,
      })),
      more: Math.max(0, sorted.length - TEXT_LIST_MAX),
    };
  }
  const order = q.kind === 'yesno' ? [true, false] : q.kind === 'scale' ? SCALE : q.options;
  const bars = new Map(order.map((v) => [JSON.stringify(v), { value: v, label: showValue(q.kind, v), people: [] }]));
  for (const r of rows) {
    const picked = q.kind === 'choices' && Array.isArray(r.value) ? r.value : [r.value];
    for (const v of picked) {
      const key = JSON.stringify(v);
      if (!bars.has(key)) bars.set(key, { value: v, label: showValue(q.kind, v), people: [], old: true });
      bars.get(key).people.push({ id: r.person_id, name: r.name });
    }
  }
  return {
    ...base,
    options: [...bars.values()].map((b) => {
      const people = b.people.sort((x, y) => String(x.name).localeCompare(String(y.name)));
      return {
        value: b.value,
        label: b.label,
        old: !!b.old,
        count: people.length,
        pct: answered ? Math.round((people.length / answered) * 100) : 0,
        people: people.slice(0, PEOPLE_MAX),
        more: Math.max(0, people.length - PEOPLE_MAX),
      };
    }),
  };
};

api.get('/surveys/:id/results', async (c) => {
  if (!isDesk(c)) return refuse(c);
  const s = await loadSurvey(c);
  if (!s) return c.json({ error: 'not found' }, 404);
  const db = c.get('db');
  const ws = c.get('ctx').workspaceId;
  const questions = await questionsOf(db, ws, [s.id]);
  const latest = await latestAnswers(db, ws, s.id);
  const shown = new Set(questions.map((q) => q.id));
  const people = new Set(latest.filter((r) => shown.has(r.question_id)).map((r) => r.person_id)).size;
  return c.json({
    survey: { ...surveyOut(s), people },
    questions: questions.map((q) => tally(q, latest.filter((r) => r.question_id === q.id))),
  });
});

// CSV: formulas never run in a spreadsheet (a leading = + - @ is quoted away).
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const fileName = (name) => `survey-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'answers'}.csv`;

api.get('/surveys/:id/results.csv', async (c) => {
  if (!isDesk(c)) return refuse(c);
  const s = await loadSurvey(c);
  if (!s) return c.json({ error: 'not found' }, 404);
  const db = c.get('db');
  const ws = c.get('ctx').workspaceId;
  const questions = await questionsOf(db, ws, [s.id]);
  const latest = await latestAnswers(db, ws, s.id);
  const byPerson = new Map();
  for (const r of latest) {
    if (!questions.some((q) => q.id === r.question_id)) continue;
    if (!byPerson.has(r.person_id)) byPerson.set(r.person_id, { person: r, answers: {}, last: r.created_at });
    const e = byPerson.get(r.person_id);
    e.answers[r.question_id] = r.value;
    if (new Date(r.created_at) > new Date(e.last)) e.last = r.created_at;
  }
  const head = ['Name', 'Phone', 'Email', 'Address', 'Last answer', ...questions.map((q) => q.text)];
  const lines = [head.map(csvCell).join(',')];
  const rows = [...byPerson.values()].sort((a, b) => String(a.person.name).localeCompare(String(b.person.name)));
  for (const { person: p, answers, last } of rows) {
    const address = [p.unit, p.address].filter(Boolean).join(' – ');
    lines.push([
      p.name, p.phone, p.email, address, new Date(last).toISOString().slice(0, 10),
      ...questions.map((q) => (q.id in answers ? showValue(q.kind, answers[q.id]) : '')),
    ].map(csvCell).join(','));
  }
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${fileName(s.name)}"`);
  return c.body(`${lines.join('\r\n')}\r\n`);
});

// ── Desk: one person's answers (profile) ──
api.get('/persons/:id/answers', async (c) => {
  if (!isDesk(c)) return refuse(c);
  const id = c.req.param('id');
  if (!UUID_RE.test(id || '')) return c.json({ error: 'not found' }, 404);
  const rows = (await c.get('db').query(
    `select r.id, r.value, r.created_at, q.id as question_id, q.text as question, q.kind,
            s.id as survey_id, s.name as survey, c.channel, u.name as by_name
     from survey_responses r
     join survey_questions q on q.id = r.question_id
     join surveys s on s.id = r.survey_id
     left join contacts c on c.id = r.contact_id
     left join users u on u.id = r.created_by
     where r.workspace_id = $1 and r.person_id = $2
     order by r.created_at desc, q.position limit 200`,
    [c.get('ctx').workspaceId, id],
  )).rows;
  return c.json({
    answers: rows.map((r) => ({
      id: r.id, question_id: r.question_id, question: r.question, kind: r.kind, survey_id: r.survey_id, survey: r.survey,
      value: r.value, says: showValue(r.kind, r.value), channel: r.channel, by_name: r.by_name, at: r.created_at,
    })),
  });
});

export { KINDS };
