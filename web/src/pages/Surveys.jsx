// Surveys — the desk's list (People → More → Surveys, Today → More).
//   /surveys        a row per survey: name, where it's asked, questions,
//                   people who answered, and "Asking" / "Off". One yellow
//                   "New survey" (name + where, then straight to its questions).
//                   Archived surveys fold away under "Archived · N".
//                   No signal: one line, and no New survey (it would fail).
//   /surveys/:id         the builder (SurveysEdit.jsx)
//   /surveys/:id/results the results (SurveysResults.jsx)
// Desk only (App.jsx guards it; the server refuses volunteers these reads).
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import './shifts.css';
import './surveys.css';

export const WHERE = [
  { code: 'door', label: 'At the door' },
  { code: 'calls', label: 'On calls' },
  { code: 'both', label: 'Both' },
];
export const WHERE_SHORT = { door: 'Door', calls: 'Calls', both: 'Door + calls' };
export const KINDS = [
  { code: 'choice', label: 'One choice' },
  { code: 'choices', label: 'Several choices' },
  { code: 'yesno', label: 'Yes / no' },
  { code: 'scale', label: 'Scale 1–5' },
  { code: 'text', label: 'Short answer' },
];
export const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.code, k.label]));
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Everything a survey edit changes: the list, the builder, the field's questions.
export function useSurveyRefresh() {
  const queryClient = useQueryClient();
  return (id) => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['surveys'] }),
    queryClient.invalidateQueries({ queryKey: ['surveys-active'] }),
    id ? queryClient.invalidateQueries({ queryKey: ['survey', id] }) : null,
  ]);
}

// Door · Calls · Both, as one segmented row (pressed = ink).
export function WherePicker({ value, onChange, disabled, labelledBy }) {
  return (
    <div className="ops-seg sv-seg" role="group" aria-labelledby={labelledBy}>
      {WHERE.map((w) => (
        <button key={w.code} type="button" aria-pressed={value === w.code}
          disabled={disabled} onClick={() => onChange(w.code)}>
          {w.label}
        </button>
      ))}
    </div>
  );
}

function NewSurveyForm({ onClose }) {
  const navigate = useNavigate();
  const refresh = useSurveyRefresh();
  const [name, setName] = useState('');
  const [where, setWhere] = useState('both');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Add a name'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await action('survey.create', { name: name.trim(), context: where });
      refresh();
      navigate(`/surveys/${res.survey.id}?add=1`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <form className="card ops-form sv-form" onSubmit={submit} aria-label="New survey">
      <div className="field">
        <label htmlFor="sv-new-name">Name</label>
        <input id="sv-new-name" className="input" required autoFocus maxLength={120} autoComplete="off"
          placeholder="Doorstep issues" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <span className="sv-label" id="sv-new-where">Asked</span>
        <WherePicker value={where} onChange={setWhere} labelledBy="sv-new-where" />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy}>{busy ? 'Saving…' : 'Create survey'}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

function SurveyRow({ s }) {
  return (
    <li className="ops-item">
      <Link className="ops-row sv-row" to={`/surveys/${s.id}`}>
        <span className="ops-row__main">
          <span className="ops-row__name">{s.name}</span>
          {/* Two facts: where it's asked, and how many people answered. */}
          <span className="ops-row__sub">
            {WHERE_SHORT[s.context]}
            {s.turf_ids.length > 0 && <> in {plural(s.turf_ids.length, 'turf')}</>}
            {' · '}{s.people} answered
          </span>
        </span>
        <span className="ops-row__end">
          {s.archived
            ? <span className="chip ops-chip-muted">Archived</span>
            : <span className={`chip ${s.active ? 'chip-ok' : 'ops-chip-muted'}`}>{s.active ? 'Asking' : 'Off'}</span>}
        </span>
      </Link>
    </li>
  );
}

export default function Surveys() {
  const [params, setParams] = useSearchParams();
  const showNew = params.get('new') === '1';
  const [showArchived, setShowArchived] = useState(false);
  const q = useQuery({ queryKey: ['surveys'], queryFn: () => apiGet('/surveys') });
  const online = useOnline();
  const offline = noSignal(q);
  const all = q.data?.surveys ?? [];
  const live = all.filter((s) => !s.archived);
  const archived = all.filter((s) => s.archived);

  return (
    <div className="ops-page sv-page">
      <div className="ops-head">
        <h1>Surveys</h1>
        {!showNew && online && (
          <button type="button" className="btn btn-primary ops-tap" onClick={() => setParams({ new: '1' })}>New survey</button>
        )}
      </div>

      {showNew && <NewSurveyForm onClose={() => setParams({})} />}

      {offline && <NoSignal />}
      {q.isPending && !offline && <p className="muted">Loading…</p>}
      {q.isError && !offline && <p className="error" role="alert">{q.error.message}</p>}
      {q.isSuccess && live.length === 0 && !showNew && <p className="ops-empty">No surveys yet.</p>}
      {live.length > 0 && <ul className="ops-rows">{live.map((s) => <SurveyRow key={s.id} s={s} />)}</ul>}

      {archived.length > 0 && (
        <div className="ops-foot">
          <button type="button" className="ops-more disclose" aria-expanded={showArchived} aria-controls="sv-archived"
            onClick={() => setShowArchived((v) => !v)}>
            Archived · {archived.length}
          </button>
          {showArchived && <ul id="sv-archived" className="ops-rows ops-more-body">{archived.map((s) => <SurveyRow key={s.id} s={s} />)}</ul>}
        </div>
      )}
    </div>
  );
}
