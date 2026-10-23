// Ladders — the desk's list (Outreach → Ladders). One row per ladder: its
// name, what starts it, "N in progress · N finished", On / Off. One yellow
// "New ladder" (a name and what starts it, then straight to its steps).
// Open follow-ups sit on top as one row; how far people have come
// (Contact → … → Leader) folds away under "How involved people are". Under
// the title, the plain words for what a ladder is (as Outreach's link says).
// No signal: one line, and no New ladder (it would fail).
//   /ladders/:id   the builder (LaddersEdit.jsx)
//   /follow-ups    the follow-up list (LaddersFollowups.jsx)
// Desk only (App.jsx guards it; the server refuses volunteers these reads).
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { CONNECT_TO, LEVEL_HINT, TriggerPicker, countsLine, plural, triggerLine } from '../components/LaddersBits.jsx';
import './shifts.css';
import './ladders.css';

function NewLadder({ options, onClose }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState({ kind: 'petition', ref: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Add a name'); return; }
    if (trigger.kind === 'tag' && !trigger.ref.trim()) { setError('Pick a tag'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await action('ladder.create', {
        name: name.trim(), trigger: { kind: trigger.kind, ref: trigger.ref.trim() || null },
      });
      queryClient.invalidateQueries({ queryKey: ['ladders'] });
      navigate(`/ladders/${res.ladder.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <form className="card ops-form lad-form" onSubmit={submit} aria-label="New ladder">
      <div className="field">
        <label htmlFor="lad-new-name">Name</label>
        <input id="lad-new-name" className="input lad-input" required autoFocus maxLength={120} autoComplete="off"
          placeholder="Thank petition signers" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <TriggerPicker value={trigger} onChange={setTrigger} options={options} idp="lad-new" disabled={busy} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy}>{busy ? 'Saving…' : 'Create ladder'}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

function LadderRow({ l }) {
  return (
    <li className="ops-item">
      <Link className="ops-row" to={`/ladders/${l.id}`}>
        <span className="ops-row__main">
          <span className="ops-row__name">{l.name}</span>
          <span className="ops-row__sub">{triggerLine(l.trigger)}</span>
          <span className="ops-row__sub">{countsLine(l)}</span>
        </span>
        <span className="ops-row__end">
          <span className={`chip ${l.active ? 'chip-ok' : 'ops-chip-muted'}`}>{l.active ? 'On' : 'Off'}</span>
        </span>
      </Link>
    </li>
  );
}

// Contact → Supporter → Signer → Donor or volunteer → Leader, as bars.
export function Levels({ levels }) {
  const max = Math.max(1, ...levels.map((l) => l.n));
  return (
    <ul className="lad-levels" aria-label={LEVEL_HINT}>
      {levels.map((l) => (
        <li key={l.code} className="lad-levels__row">
          <span className="lad-levels__label">{l.label}</span>
          <span className="lad-levels__bar" aria-hidden="true"><span style={{ width: `${(100 * l.n) / max}%` }} /></span>
          <span className="lad-levels__n mono">{l.n}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Ladders() {
  const [params, setParams] = useSearchParams();
  const showNew = params.get('new') === '1';
  const [showLevels, setShowLevels] = useState(false);
  const q = useQuery({ queryKey: ['ladders'], queryFn: () => apiGet('/ladders') });
  const online = useOnline();
  const offline = noSignal(q);
  const d = q.data;
  const ladders = d?.ladders ?? [];
  const followups = Number(d?.followups) || 0;
  const emailWaits = d && !d.emailConfigured && ladders.some((l) => l.active && l.steps.some((s) => s.kind === 'email'));

  return (
    <div className="ops-page lad-page">
      <div className="ops-head">
        <div className="lad-title">
          <h1>Ladders</h1>
          <p className="lad-sub">Automatic emails &amp; follow-ups</p>
        </div>
        {!showNew && online && (
          <button type="button" className="btn btn-primary ops-tap" onClick={() => setParams({ new: '1' })}>New ladder</button>
        )}
      </div>

      {showNew && d && <NewLadder options={d.options} onClose={() => setParams({})} />}

      {offline && <NoSignal />}
      {q.isPending && !offline && <p className="muted">Loading…</p>}
      {q.isError && !offline && <p className="error" role="alert">{q.error.message}</p>}
      {emailWaits && (
        <p className="lad-note" role="status">Email isn’t connected — email steps wait. <Link to={CONNECT_TO}>Connect</Link></p>
      )}
      {followups > 0 && (
        <Link className="lad-fu-link" to="/follow-ups">
          <span><strong className="mono">{followups}</strong> {followups === 1 ? 'follow-up' : 'follow-ups'} to do</span>
          <span className="lad-chev" aria-hidden="true">›</span>
        </Link>
      )}
      {q.isSuccess && ladders.length === 0 && !showNew && <p className="ops-empty">No ladders yet.</p>}
      {ladders.length > 0 && <ul className="ops-rows">{ladders.map((l) => <LadderRow key={l.id} l={l} />)}</ul>}

      {d && (
        <div className="ops-foot">
          <button type="button" className="ops-more disclose" aria-expanded={showLevels} aria-controls="lad-levels"
            onClick={() => setShowLevels((v) => !v)}>
            How involved people are
          </button>
          {showLevels && (
            <div id="lad-levels" className="ops-more-body">
              <Levels levels={d.levels} />
              <p className="lad-hint">{plural(d.levels.reduce((s, l) => s + l.n, 0), 'person', 'people')}, each at the highest level they reached.</p>
            </div>
          )}
          {followups === 0 && <Link className="lad-link-row" to="/follow-ups">Follow-ups <span className="lad-chev" aria-hidden="true">›</span></Link>}
        </div>
      )}
    </div>
  );
}
