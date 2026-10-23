// Follow-ups — the staff tasks ladders made ("Call Ana to say thanks").
// A big number, then one row each: the task, who and which ladder, Call
// (when there's a phone) and Done. Done says so in a toast with Undo; done
// ones fold away under "Done · N". Back says where it came from ("← Today"
// from Today's "2 follow-ups", else "← Ladders"). Desk only.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { LadBack, fmtWhen } from '../components/LaddersBits.jsx';
import './shifts.css';
import './ladders.css';

const dialable = (phone) => String(phone || '').replace(/\s*(?:ext\.?|x|#).*$/i, '').replace(/[^\d+]/g, '');

function Row({ f, onDone, busy }) {
  const open = f.status === 'open';
  return (
    <li className="ops-item lad-fu" data-tone={open ? undefined : 'past'}>
      <div className="ops-row ops-row--static">
        <span className="ops-row__main">
          <span className="ops-row__name">{f.text}</span>
          <span className="ops-row__sub">
            <Link to={`/people/${f.person.id}`}>{f.person.name}</Link>
            {f.ladder && <span>{f.ladder.name}</span>}
            <span>{fmtWhen(open ? f.created_at : f.done_at)}</span>
          </span>
        </span>
      </div>
      <div className="lad-fu__acts">
        {open && f.person.phone && <a className="btn ops-tap" href={`tel:${dialable(f.person.phone)}`}>Call</a>}
        {open
          ? <button type="button" className="btn ops-solid ops-tap" disabled={busy} onClick={() => onDone(f, true)}>Done</button>
          : <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => onDone(f, false)}>Not done</button>}
      </div>
    </li>
  );
}

export default function LaddersFollowups() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['ladders', 'followups'], queryFn: () => apiGet('/ladders/followups') });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const mark = async (f, done) => {
    setBusy(true);
    setError(null);
    try {
      await action('ladder.followupDone', { id: f.id, done });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ladders'] }),
        queryClient.invalidateQueries({ queryKey: ['person'] }),
      ]);
      clearTimeout(timer.current);
      setToast(done ? { text: `Done · ${f.person.name}`, f } : null);
      if (done) timer.current = setTimeout(() => setToast(null), 7000);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const open = q.data?.open ?? [];
  const done = q.data?.done ?? [];
  return (
    <div className="ops-page lad-page">
      <LadBack />
      <div className="ops-head"><h1>Follow-ups</h1></div>
      {noSignal(q) ? <NoSignal /> : (
        <>
          {q.isPending && <p className="muted">Loading…</p>}
          {q.isError && <p className="error" role="alert">{q.error.message}</p>}
        </>
      )}
      {q.isSuccess && (
        <p className="ops-hero"><span className="n">{open.length}</span><span className="sub">to do</span></p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {q.isSuccess && open.length === 0 && <p className="ops-empty">Nothing to follow up.</p>}
      {open.length > 0 && <ul className="ops-rows">{open.map((f) => <Row key={f.id} f={f} onDone={mark} busy={busy} />)}</ul>}
      {done.length > 0 && (
        <div className="ops-foot">
          <button type="button" className="ops-more disclose" aria-expanded={showDone} aria-controls="lad-fu-done"
            onClick={() => setShowDone((v) => !v)}>
            Done · {done.length}
          </button>
          {showDone && <ul id="lad-fu-done" className="ops-rows ops-more-body">{done.map((f) => <Row key={f.id} f={f} onDone={mark} busy={busy} />)}</ul>}
        </div>
      )}
      {toast && (
        <div className="toast ops-toast" role="status">
          <span>{toast.text}</span>
          <button type="button" className="btn" disabled={busy} onClick={() => mark(toast.f, false)}>Undo</button>
        </div>
      )}
    </div>
  );
}
