// One survey's builder (/surveys/:id). Title = the survey's name; one yellow
// "Add question". Under it: the on/off switch ("Asking now" / "Not asking"),
// where it's asked (Door · Calls · Both) and "Results · N". The questions in
// the order they're asked; tap one to edit it, move it up or down, or remove
// it ("Remove this question? Yes · No" — its answers are kept). Once someone
// has answered a question its words and kind are fixed ("Has answers — words
// can't change"; "Copy as a new question" starts one from it); while the
// survey is asked its kind is fixed too (phones keep the questions a day).
// Under "More": only in some turfs, rename, archive (answers kept; "Bring
// back" undoes it).
import { useId, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { KINDS, KIND_LABEL, WherePicker, plural, useSurveyRefresh } from './Surveys.jsx';
import './shifts.css';
import './surveys.css';

const CHOICE = ['choice', 'choices'];
const OPTIONS_MAX = 20;

// answered: words and kind fixed (choices can still change). asking: the
// survey is on, so the kind is fixed. onAskNew: start a new question from this one.
function QuestionForm({ initial = null, answered = false, asking = false, submitLabel, primary = false, onSubmit, onCancel, onAskNew, busy }) {
  const uid = useId();
  const [text, setText] = useState(initial?.text || '');
  const [kind, setKind] = useState(initial?.kind || 'choice');
  const [opts, setOpts] = useState(initial?.options?.length ? initial.options : ['', '']);
  const [error, setError] = useState(null);
  const choice = CHOICE.includes(kind);
  const kindFixed = answered || asking;
  // An answered yes/no, 1–5 or short answer has nothing left to edit here.
  const editable = !answered || choice;
  const setOpt = (i, v) => setOpts((o) => o.map((x, j) => (j === i ? v : x)));

  const submit = async (e) => {
    e.preventDefault();
    const clean = opts.map((o) => o.trim()).filter(Boolean);
    if (!text.trim()) { setError('Add the question'); return; }
    if (choice && clean.length < 2) { setError('Add at least two choices'); return; }
    setError(null);
    const err = await onSubmit({ text: text.trim(), kind, options: choice ? clean : undefined });
    if (err) setError(err);
  };

  return (
    <form className={`sv-qform${primary ? ' card' : ''}`} onSubmit={submit} aria-label={submitLabel}>
      <div className="field">
        {answered ? (
          <>
            <span className="sv-label">Question</span>
            <p className="sv-locked">{text}</p>
            <p className="sv-locked__why muted">Has answers — words can't change</p>
          </>
        ) : (
          <>
            <label htmlFor={`${uid}-text`}>Question</label>
            <input id={`${uid}-text`} className="input" required autoFocus maxLength={300} autoComplete="off"
              placeholder="What matters most to you?" value={text} onChange={(e) => setText(e.target.value)} />
          </>
        )}
      </div>
      <div className="field">
        <span className="sv-label" id={`${uid}-kind`}>Answer</span>
        {kindFixed ? (
          <p className="sv-locked">
            {KIND_LABEL[kind]} <span className="muted">· {answered ? "can't change" : 'turn off Asking now to change'}</span>
          </p>
        ) : (
          <div className="sv-kinds" role="group" aria-labelledby={`${uid}-kind`}>
            {KINDS.map((k) => (
              <button key={k.code} type="button" className="sv-kind" aria-pressed={kind === k.code} onClick={() => setKind(k.code)}>
                {k.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {choice && (
        <div className="field sv-choices">
          <span className="sv-label">Choices</span>
          {opts.map((o, i) => (
            <div className="sv-choice" key={i}>
              <input className="input" aria-label={`Choice ${i + 1}`} maxLength={200} autoComplete="off"
                value={o} onChange={(e) => setOpt(i, e.target.value)} />
              {opts.length > 2 && (
                <button type="button" className="btn btn-quiet sv-choice__x" aria-label={`Remove choice ${i + 1}`}
                  onClick={() => setOpts((list) => list.filter((_, j) => j !== i))}>✕</button>
              )}
            </div>
          ))}
          {opts.length < OPTIONS_MAX && (
            <button type="button" className="btn btn-quiet ops-tap sv-choice__add" onClick={() => setOpts((list) => [...list, ''])}>
              + Add a choice
            </button>
          )}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        {editable && <button type="submit" className={`btn ops-tap ${primary ? 'btn-primary' : 'ops-solid'}`} disabled={busy}>{submitLabel}</button>}
        {answered && onAskNew && (
          <button type="button" className="btn ops-tap" disabled={busy} onClick={onAskNew}>Copy as a new question</button>
        )}
        <button type="button" className="btn btn-quiet ops-tap" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function QuestionRow({ q, index, total, open, locked, asking, busy, onToggle, onSave, onAskNew, onMove, onRemove }) {
  const [confirm, setConfirm] = useState(false);
  const bodyId = `sv-q-${q.id}`;
  const sub = [KIND_LABEL[q.kind], q.answered ? `${q.answered} answered` : null].filter(Boolean).join(' · ');
  const head = (
    <>
      <span className="sv-qnum mono" aria-hidden="true">{index + 1}</span>
      <span className="ops-row__main">
        <span className="ops-row__name">{q.text}</span>
        <span className="ops-row__sub">{sub}</span>
      </span>
    </>
  );
  return (
    <li className="ops-item sv-qitem" data-open={open ? '' : undefined}>
      {locked ? <div className="ops-row ops-row--static">{head}</div> : (
        <button type="button" className="ops-row" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>{head}</button>
      )}
      {open && (
        <div className="ops-body" id={bodyId}>
          <QuestionForm initial={q} answered={q.locked} asking={asking} submitLabel="Save" busy={busy}
            onSubmit={onSave} onCancel={onToggle} onAskNew={onAskNew} />
          <div className="ops-actions sv-qmove">
            <button type="button" className="btn ops-tap" disabled={busy || index === 0} onClick={() => onMove(-1)}>Move up</button>
            <button type="button" className="btn ops-tap" disabled={busy || index === total - 1} onClick={() => onMove(1)}>Move down</button>
            {confirm ? (
              <span className="ops-confirm" role="group" aria-label="Remove this question">
                <span>Remove this question?</span>
                <button type="button" className="btn ops-tap sv-danger" disabled={busy} onClick={onRemove}>Yes</button>
                <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(false)}>No</button>
              </span>
            ) : (
              <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(true)}>Remove</button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function MoreBox({ survey, turfs, busy, run }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(survey.name);
  const [confirm, setConfirm] = useState(false);
  const picked = new Set(survey.turf_ids);
  const toggleTurf = (id) => {
    const next = picked.has(id) ? survey.turf_ids.filter((t) => t !== id) : [...survey.turf_ids, id];
    run('survey.update', { id: survey.id, turf_ids: next });
  };
  return (
    <div className="ops-foot">
      <button type="button" className="ops-more disclose" aria-expanded={open} aria-controls="sv-more" onClick={() => setOpen((v) => !v)}>
        More
      </button>
      {open && (
        <div id="sv-more" className="ops-more-body sv-more">
          {turfs.length > 0 && (
            <fieldset className="sv-turfs">
              <legend className="sv-label">Only in these turfs</legend>
              {turfs.map((t) => (
                <label key={t.id} className="sv-turf">
                  <input type="checkbox" checked={picked.has(t.id)} disabled={busy} onChange={() => toggleTurf(t.id)} />
                  <span>{t.name}</span>
                </label>
              ))}
              <p className="sv-turfs__now muted">{picked.size ? `Only in ${plural(picked.size, 'turf')}` : 'Everywhere'}</p>
            </fieldset>
          )}
          <form className="sv-rename" onSubmit={(e) => { e.preventDefault(); if (name.trim() && name.trim() !== survey.name) run('survey.update', { id: survey.id, name: name.trim() }); }}>
            <div className="field">
              <label htmlFor="sv-rename">Name</label>
              <input id="sv-rename" className="input" maxLength={120} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <button type="submit" className="btn ops-tap" disabled={busy || !name.trim() || name.trim() === survey.name}>Rename</button>
          </form>
          {confirm ? (
            <span className="ops-confirm" role="group" aria-label="Archive this survey">
              <span>Archive? Answers are kept.</span>
              <button type="button" className="btn ops-tap sv-danger" disabled={busy} onClick={() => run('survey.archive', { id: survey.id })}>Yes</button>
              <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(false)}>No</button>
            </span>
          ) : (
            <div className="ops-actions">
              <button type="button" className="btn ops-tap" onClick={() => setConfirm(true)}>Archive</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SurveysEdit() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const adding = params.get('add') === '1';
  const refresh = useSurveyRefresh();
  const [openQ, setOpenQ] = useState(null);
  // "Copy as a new question" from an answered one: the add form starts from it.
  const [start, setStart] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const q = useQuery({ queryKey: ['survey', id], queryFn: () => apiGet(`/surveys/${id}`) });

  // Every change is one action; on a refusal the message shows in place.
  const run = async (name, input) => {
    setBusy(true);
    setError(null);
    try {
      const res = await action(name, input);
      await refresh(id);
      return { res };
    } catch (e) {
      setError(e.message);
      return { error: e.message };
    } finally {
      setBusy(false);
    }
  };

  if (noSignal(q)) {
    return (
      <div className="ops-page sv-page">
        <Link to="/surveys" className="ops-back">← Surveys</Link>
        <NoSignal />
      </div>
    );
  }
  if (q.isPending) return <p className="muted">Loading…</p>;
  if (q.isError) {
    return (
      <div className="ops-page sv-page">
        <Link to="/surveys" className="ops-back">← Surveys</Link>
        <p className="error" role="alert">{q.error.status === 404 ? 'Survey not found' : q.error.message}</p>
      </div>
    );
  }
  const { survey, questions, turfs } = q.data;
  const locked = survey.archived;

  const add = async (input) => {
    const r = await run('survey.question.add', { survey_id: id, ...input });
    if (r.res) { setStart(null); setParams({}, { replace: true }); }
    return r.error;
  };
  const askNew = (question) => {
    setOpenQ(null);
    setStart({ text: question.text, kind: question.kind, options: question.options });
    setParams({ add: '1' });
  };
  const save = (question) => async (input) => {
    const patch = { id: question.id };
    if (!question.locked) patch.text = input.text;
    if (!question.locked && !survey.active) patch.kind = input.kind;
    if (input.options) patch.options = input.options;
    const r = await run('survey.question.update', patch);
    if (r.res) setOpenQ(null);
    return r.error;
  };
  const move = (i, by) => {
    const ids = questions.map((x) => x.id);
    const [moved] = ids.splice(i, 1);
    ids.splice(i + by, 0, moved);
    run('survey.question.reorder', { survey_id: id, ids });
  };
  const remove = async (question) => {
    const r = await run('survey.question.remove', { id: question.id });
    if (r.res) setOpenQ(null);
  };

  return (
    <div className="ops-page sv-page">
      <Link to="/surveys" className="ops-back">← Surveys</Link>
      <div className="ops-head">
        <h1>{survey.name}</h1>
        {locked ? (
          <button type="button" className="btn btn-primary ops-tap" disabled={busy} onClick={() => run('survey.archive', { id, restore: true })}>
            Bring back
          </button>
        ) : !adding && (
          <button type="button" className="btn btn-primary ops-tap" onClick={() => { setOpenQ(null); setStart(null); setParams({ add: '1' }); }}>
            Add question
          </button>
        )}
      </div>

      <div className="sv-status">
        {locked ? <span className="chip ops-chip-muted ops-chip-lg">Archived</span> : (
          <button type="button" role="switch" aria-checked={survey.active} className="sv-switch" disabled={busy}
            onClick={() => run('survey.update', { id, active: !survey.active })}>
            <span className="sv-switch__track" aria-hidden="true"><span className="sv-switch__dot" /></span>
            <span className="sv-switch__label">{survey.active ? 'Asking now' : 'Not asking'}</span>
          </button>
        )}
        <Link className="btn ops-tap sv-results-link" to={`/surveys/${id}/results`}>Results · {survey.people}</Link>
      </div>
      {!locked && (
        <div className="field sv-where">
          <span className="sv-label" id="sv-where">Asked</span>
          <WherePicker value={survey.context} disabled={busy} labelledBy="sv-where" onChange={(c) => c !== survey.context && run('survey.update', { id, context: c })} />
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}

      {adding && !locked && (
        <QuestionForm key={`add-${questions.length}-${start?.text || ''}`} initial={start} primary submitLabel="Add question" busy={busy}
          onSubmit={add} onCancel={() => { setStart(null); setParams({}); }} />
      )}

      {questions.length === 0 ? (
        !adding && <p className="ops-empty">No questions yet.</p>
      ) : (
        <ol className="ops-rows sv-qlist" aria-label="Questions">
          {questions.map((question, i) => (
            <QuestionRow
              key={question.id}
              q={question}
              index={i}
              total={questions.length}
              open={openQ === question.id}
              locked={locked}
              asking={survey.active}
              busy={busy}
              onToggle={() => setOpenQ((cur) => (cur === question.id ? null : question.id))}
              onSave={save(question)}
              onAskNew={() => askNew(question)}
              onMove={(by) => move(i, by)}
              onRemove={() => remove(question)}
            />
          ))}
        </ol>
      )}

      {!locked && <MoreBox key={survey.name} survey={survey} turfs={turfs} busy={busy} run={run} />}
    </div>
  );
}
