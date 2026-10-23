// SurveyQuestions — the active survey's questions wherever someone is rated
// (the map's door card, the walk list, Calls, the profile). One quiet
// disclosure, "Questions · N", closed by default and below the outcomes: the
// rating buttons stay the hero. Choice buttons are 48px.
//
//   const survey = useSurvey({ context: 'door' | 'calls', personId, turfId?, lat?, lng? });
//   <SurveyQuestions survey={survey} onSave={() => log('contacted')} disabled={busy} />
//
// Answers are a draft per person (kept in memory for this sign-in, so closing
// a door card or switching people loses nothing) until the next contact.log
// for that person carries them:
//   const answers = survey.take();          // [{ question_id, value }], draft cleared
//   const visitOf = survey.visitOf(channel);
//   const r = await logContact({ ..., answers: answers.length ? answers : undefined, visit_of: visitOf });
//   survey.logged(r, { channel, outcome, rating, answers, visitOf });
//   on a refusal: survey.restore(answers)
// That is the same outbox as every knock, so answers given with no signal are
// sent once, later. "Save answers" logs a talked contact with just the answers;
// the next tap on that person (a rating, an outcome, more answers) within
// half an hour finishes that same contact (visit_of) — one record per visit.
// The server leaves out an answer whose question changed meanwhile and says
// so (answers_skipped): answersTail / answersSaid word the toast from it.
//
// The questions asked here come from GET /api/surveys/active (questions only)
// and are kept on the phone for a day, so they still show with no signal. A
// survey kept to some turfs shows inside them only: the walk list passes its
// turf, other screens the door's position (checked against the turf outlines).
// Sign-out forgets the copies and the drafts.
//
// PersonAnswers / usePersonAnswers: the profile's "Answers" (desk only).
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import './survey-questions.css';

const TEXT_MAX = 500;
const SCALE = [1, 2, 3, 4, 5];
const YESNO = [{ v: true, label: 'Yes' }, { v: false, label: 'No' }];

export const answersWord = (n) => `${n} ${n === 1 ? 'answer' : 'answers'}`;
// reply: what contact.log answered (none yet when it's saved on the phone).
const leftOut = (reply) => reply?.answers_skipped?.length || 0;
const leftOutText = (n) => `${answersWord(n)} not saved — question changed`;
// What a toast adds for answers that went with a tap: " · 2 answers",
// " · 1 answer · 1 answer not saved — question changed".
export const answersTail = (list, reply) => {
  const skipped = leftOut(reply);
  const kept = (list?.length || 0) - skipped;
  return `${kept > 0 ? ` · ${answersWord(kept)}` : ''}${skipped ? ` · ${leftOutText(skipped)}` : ''}`;
};
// The toast for answers on their own: "2 answers saved".
export const answersSaid = (list, reply) => {
  const skipped = leftOut(reply);
  const kept = (list?.length || 0) - skipped;
  return [kept > 0 ? `${answersWord(kept)} saved` : null, skipped ? leftOutText(skipped) : null].filter(Boolean).join(' · ');
};

// ── The phone's copy of what to ask ──
const CACHE_PREFIX = 'starbase:surveys:v1:';
const CACHE_TTL = 24 * 3600 * 1000;
const cacheKey = (me, name) => (me?.user?.id && me?.workspace?.id ? `${CACHE_PREFIX}${me.workspace.id}:${me.user.id}:${name}` : null);
function readCache(key) {
  if (!key) return undefined;
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    if (!v?.data || !(Date.now() - v.at < CACHE_TTL)) return undefined;
    return v;
  } catch { return undefined; }
}
function writeCache(key, data, at) {
  try { localStorage.setItem(key, JSON.stringify({ at, data })); } catch { /* storage full or blocked */ }
}
function forgetAll() {
  drafts.clear();
  visits.clear();
  bump();
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* storage blocked */ }
}
const watched = new WeakSet();
function useForgetOnSignOut(queryClient) {
  useEffect(() => {
    if (watched.has(queryClient)) return;
    watched.add(queryClient);
    queryClient.getQueryCache().subscribe((e) => {
      const k = e.query.queryKey;
      if (e.type === 'removed' && k.length === 1 && k[0] === 'me') forgetAll();
    });
  }, [queryClient]);
}

// Ray-casting point-in-polygon, rings of [lat, lng] (same as the server's).
const inRing = (lat, lng, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const applies = (s, { turfId, lat, lng }) => {
  if (!s.limited) return true;
  if (turfId && s.turf_ids?.includes(turfId)) return true;
  return lat != null && lng != null && (s.areas || []).some((ring) => inRing(Number(lat), Number(lng), ring));
};

// ── Drafts: person → { question id → value }, for this sign-in ──
const drafts = new Map();
const listeners = new Set();
let version = 0;
const bump = () => { version += 1; listeners.forEach((fn) => fn()); };
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const getVersion = () => version;
const EMPTY = Object.freeze({});
const putDraft = (key, patch) => {
  const next = { ...(drafts.get(key) || {}) };
  for (const [qid, v] of Object.entries(patch)) {
    if (v === undefined) delete next[qid]; else next[qid] = v;
  }
  if (Object.keys(next).length) drafts.set(key, next); else drafts.delete(key);
  bump();
};

// ── Visits: person → the talked knock with no rating yet ("Save answers")
// that their next tap finishes: { cid, channel, at }, for this sign-in ──
const visits = new Map();
const VISIT_MS = 30 * 60 * 1000;

// Is this a whole answer, and what goes to the server for it.
const answerOf = (q, v) => {
  if (v === undefined || v === null) return undefined;
  switch (q.kind) {
    case 'choice': return q.options.includes(v) ? v : undefined;
    case 'choices': {
      const picked = Array.isArray(v) ? q.options.filter((o) => v.includes(o)) : [];
      return picked.length ? picked : undefined;
    }
    case 'yesno': return typeof v === 'boolean' ? v : undefined;
    case 'scale': return SCALE.includes(v) ? v : undefined;
    case 'text': { const t = String(v).trim().slice(0, TEXT_MAX); return t || undefined; }
    default: return undefined;
  }
};

export function useSurvey({ context, personId, turfId = null, lat = null, lng = null }) {
  const queryClient = useQueryClient();
  useForgetOnSignOut(queryClient);
  const me = queryClient.getQueryData(['me']);
  const ck = cacheKey(me, `${context}:${turfId || ''}`);
  const cached = useMemo(() => readCache(ck), [ck]);
  const q = useQuery({
    queryKey: ['surveys-active', context, turfId || null],
    queryFn: () => apiGet(`/surveys/active?context=${context}${turfId ? `&turf=${encodeURIComponent(turfId)}` : ''}`),
    staleTime: 60_000,
    gcTime: 12 * 3600 * 1000,
    // The phone's copy shows at once; with signal, what the desk changed since replaces it.
    refetchOnMount: 'always',
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.at,
  });
  useEffect(() => {
    if (ck && q.status === 'success' && q.data && q.dataUpdatedAt) writeCache(ck, q.data, q.dataUpdatedAt);
  }, [ck, q.status, q.data, q.dataUpdatedAt]);

  const groups = useMemo(
    () => (q.data?.surveys || []).filter((s) => s.questions?.length && applies(s, { turfId, lat, lng })),
    [q.data, turfId, lat, lng],
  );
  const questions = useMemo(() => groups.flatMap((s) => s.questions), [groups]);
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const key = `${me?.user?.id || ''}|${personId || ''}`;
  const draft = (personId && drafts.get(key)) || EMPTY;
  // Only answers to the questions on this screen go with a tap.
  const answers = [];
  for (const question of questions) {
    const value = answerOf(question, draft[question.id]);
    if (value !== undefined) answers.push({ question_id: question.id, value });
  }
  return {
    groups,
    questions,
    draft,
    answers,
    count: answers.length,
    set: (qid, value) => { if (personId) putDraft(key, { [qid]: value }); },
    take: () => {
      if (!personId || !answers.length) return [];
      putDraft(key, Object.fromEntries(answers.map((a) => [a.question_id, undefined])));
      return answers;
    },
    // The client_id of this visit's "Save answers" knock, for the next tap here.
    visitOf: (channel) => {
      const v = personId ? visits.get(key) : null;
      if (!v || v.channel !== channel || Date.now() - v.at > VISIT_MS) return undefined;
      return v.cid;
    },
    // After a tap went (sent or saved on the phone): answers with no rating
    // keep the visit open for its rating; anything else ends it. An answer
    // left out (its question changed) brings the current questions.
    logged: (r, { channel, outcome, rating, answers, visitOf }) => {
      if (!personId || !r) return;
      const reply = r.queued ? null : r.result;
      if (leftOut(reply)) queryClient.invalidateQueries({ queryKey: ['surveys-active'] });
      if (outcome === 'contacted' && !rating && (answers?.length || visitOf)) {
        // Still the first knock unless the server logged this one on its own.
        const cid = visitOf && (!reply || reply.amended) ? visitOf : r.client_id;
        if (cid) visits.set(key, { cid, channel, at: Date.now() });
      } else {
        visits.delete(key);
      }
    },
    // A refused tap: put the answers back (anything typed since stays).
    restore: (list) => {
      if (!personId || !list?.length) return;
      const cur = drafts.get(key) || {};
      putDraft(key, Object.fromEntries(list.filter((a) => cur[a.question_id] === undefined).map((a) => [a.question_id, a.value])));
    },
  };
}

function Question({ q, value, onChange, disabled }) {
  const id = useId();
  if (q.kind === 'text') {
    return (
      <div className="sv-q">
        <label className="sv-q__text" htmlFor={id}>{q.text}</label>
        <input
          id={id} className="input sv-q__input" maxLength={TEXT_MAX} autoComplete="off"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value ? e.target.value : undefined)}
        />
      </div>
    );
  }
  const multi = q.kind === 'choices';
  const choices = q.kind === 'yesno' ? YESNO
    : q.kind === 'scale' ? SCALE.map((n) => ({ v: n, label: String(n) }))
      : q.options.map((o) => ({ v: o, label: o }));
  const isOn = (v) => (multi ? Array.isArray(value) && value.includes(v) : value === v);
  const tap = (v) => {
    if (!multi) { onChange(value === v ? undefined : v); return; }
    const cur = Array.isArray(value) ? value : [];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    onChange(next.length ? next : undefined);
  };
  return (
    <div className="sv-q" role="group" aria-labelledby={id}>
      <p className="sv-q__text" id={id}>
        {q.text}
        {multi && <span className="sv-q__hint"> · any</span>}
        {q.kind === 'scale' && <span className="sv-q__hint"> · 1 low, 5 high</span>}
      </p>
      <div className={`sv-q__opts sv-q__opts--${q.kind}`}>
        {choices.map((c) => (
          <button
            key={String(c.v)} type="button" className={`sv-opt${isOn(c.v) ? ' is-on' : ''}`}
            aria-pressed={isOn(c.v)} disabled={disabled} onClick={() => tap(c.v)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SurveyQuestions({ survey, onSave, disabled = false }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const n = survey.questions.length;
  if (!n) return null;
  const many = survey.groups.length > 1;
  return (
    <div className={`sv-field${open ? ' is-open' : ''}`}>
      <button type="button" className="sv-field__btn disclose" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <span className="sv-field__label">Questions · {n}</span>
        {survey.count > 0 && <span className="sv-field__chip">{survey.count} answered</span>}
      </button>
      {open && (
        <div className="sv-field__body" id={id}>
          {survey.groups.map((g) => (
            <div key={g.id} className="sv-field__group">
              {many && <p className="sv-field__survey">{g.name}</p>}
              {g.questions.map((q) => (
                <Question key={q.id} q={q} value={survey.draft[q.id]} disabled={disabled} onChange={(v) => survey.set(q.id, v)} />
              ))}
            </div>
          ))}
          {survey.count > 0 && (
            <button type="button" className="btn sv-field__save" disabled={disabled} onClick={onSave}>
              Save answers
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── The profile's "Answers" (desk only: the server refuses volunteers) ──
export function usePersonAnswers(personId, enabled) {
  return useQuery({
    queryKey: ['person', personId, 'answers'],
    queryFn: () => apiGet(`/persons/${personId}/answers`),
    enabled: Boolean(personId) && enabled,
    staleTime: 30_000,
  });
}

const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
};

export function PersonAnswers({ query }) {
  const list = query.data?.answers ?? [];
  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) return <p className="error">{query.error.message}</p>;
  if (!list.length) return <p className="muted">No answers yet.</p>;
  return (
    <ul className="sv-answers">
      {list.map((a) => (
        <li key={a.id} className="sv-answers__row">
          <span className="sv-answers__q">{a.question}</span>
          <span className="sv-answers__a">{a.says}</span>
          <span className="sv-answers__when mono">{day(a.at)}</span>
        </li>
      ))}
    </ul>
  );
}
