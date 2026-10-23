// Filings — the deadline list. Rows: filing name and a due chip
// ("12d left", "due today", "3d overdue"); soonest first, filed ones fold
// away. Tap a row for the due date, the note and "Mark filed". Manager and treasurer add
// (?new=1: name and due date; status and note under "More details") and
// file; staff read; volunteers never see the books.
import { useState } from 'react';
import { Link, Navigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action, fmtDate, todayISO, daysUntil } from '../api.js';
import { NoSignal, noSignal, useOnline, NeedsSignalLine } from '../components/NoSignal.jsx';
import './shifts.css';

const longDate = (value) => {
  const [y, m, d] = fmtDate(value).split('-').map(Number);
  if (!y || !m || !d) return fmtDate(value);
  return new Date(y, m - 1, d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
};

function DueBadge({ filing }) {
  if (filing.status === 'filed') return <span className="chip chip-ok ops-chip-lg">filed</span>;
  const n = daysUntil(filing.due_date);
  if (n < 0) return <span className="chip chip-danger ops-chip-lg">{-n}d overdue</span>;
  if (n === 0) return <span className="chip chip-warn ops-chip-lg">due today</span>;
  return <span className={`chip ops-chip-lg${n <= 14 ? ' chip-warn' : ''}`}>{n}d left</span>;
}

function AddFilingForm({ onDone, onClose }) {
  const [form, setForm] = useState({ name: '', due_date: todayISO(), status: 'upcoming', note: '' });
  const [more, setMore] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!online) return;
    setBusy(true);
    setError(null);
    try {
      await action('filing.create', {
        name: form.name.trim(),
        due_date: form.due_date,
        status: form.status,
        note: form.note.trim() || undefined,
      });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="card ops-form" onSubmit={submit} aria-label="Add filing">
      <div className="field">
        <label htmlFor="nf-name">Filing</label>
        <input id="nf-name" className="input" required autoFocus placeholder="Financing report"
          value={form.name} onChange={set('name')} />
      </div>
      <div className="field">
        <label htmlFor="nf-due">Due</label>
        <input id="nf-due" className="input mono" type="date" required
          value={form.due_date} onChange={set('due_date')} />
      </div>
      <button type="button" className="ops-more disclose disclose--inline" aria-expanded={more} aria-controls="nf-more"
        onClick={() => setMore((v) => !v)}>
        More details
      </button>
      {more && (
        <div id="nf-more" className="ops-more-body">
          <div className="field">
            <label htmlFor="nf-status">Status</label>
            <select id="nf-status" className="input" value={form.status} onChange={set('status')}>
              <option value="upcoming">Upcoming</option>
              <option value="filed">Filed</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="nf-note">Note</label>
            <input id="nf-note" className="input" value={form.note} onChange={set('note')} />
          </div>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy || !online}>{busy ? 'Saving…' : 'Save filing'}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

function FilingRow({ f, open, onToggle, canFile, onFiled, online }) {
  const bodyId = `filing-${f.id}`;
  return (
    <li className="ops-item" data-open={open ? '' : undefined}>
      <button type="button" className="ops-row" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="ops-row__main">
          <span className="ops-row__name">{f.name}</span>
        </span>
        <span className="ops-row__end"><DueBadge filing={f} /></span>
      </button>
      {open && (
        <div className="ops-body" id={bodyId}>
          <p className="mono">Due {longDate(f.due_date)}</p>
          {f.note && <p>{f.note}</p>}
          {canFile && f.status === 'upcoming' && (
            <div className="ops-actions">
              <button type="button" className="btn ops-solid ops-tap" onClick={onFiled} disabled={!online}>Mark filed</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export default function Filings() {
  const { me } = useOutletContext();
  const canFile = me.role === 'manager' || me.role === 'treasurer';
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const showNew = canFile && params.get('new') === '1';
  const [openId, setOpenId] = useState(null);
  const [showFiled, setShowFiled] = useState(false);
  const [error, setError] = useState(null);
  const online = useOnline();

  const filings = useInfiniteQuery({
    queryKey: ['records', 'filing'],
    queryFn: ({ pageParam }) =>
      apiGet(`/records/filing?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: null,
    getNextPageParam: (last) => last.next,
    enabled: me.role !== 'volunteer',
  });
  const rows = (filings.data?.pages ?? []).flatMap((p) => p.records);
  const byDue = (a, b) => fmtDate(a.due_date).localeCompare(fmtDate(b.due_date));
  const upcoming = rows.filter((f) => f.status !== 'filed').sort(byDue);
  const filed = rows.filter((f) => f.status === 'filed').sort((a, b) => byDue(b, a));

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['records', 'filing'] });
    queryClient.invalidateQueries({ queryKey: ['brief'] });
  };

  const markFiled = async (id) => {
    setError(null);
    try {
      await action('filing.update', { id, status: 'filed' });
      setOpenId(null);
      invalidate();
    } catch (e) {
      setError(e.message);
    }
  };

  if (me.role === 'volunteer') return <Navigate to="/" replace />;

  const row = (f) => (
    <FilingRow key={f.id} f={f} open={openId === f.id} canFile={canFile} online={online}
      onToggle={() => setOpenId((cur) => (cur === f.id ? null : f.id))}
      onFiled={() => markFiled(f.id)} />
  );

  return (
    <div className="ops-page">
      <Link to="/money" className="ops-back">← Money</Link>
      <div className="ops-head">
        <h1>Filings</h1>
        {canFile && !showNew && (
          <button type="button" className="btn btn-primary ops-tap" onClick={() => setParams({ new: '1' })} disabled={!online}>
            Add filing
          </button>
        )}
      </div>
      {canFile && !online && <NeedsSignalLine>Adding or filing a deadline needs signal</NeedsSignalLine>}

      {showNew && <AddFilingForm onDone={() => { setParams({}); invalidate(); }} onClose={() => setParams({})} />}

      {error && <p className="error">{error}</p>}
      {noSignal(filings) ? <NoSignal /> : filings.isError && <p className="error">{filings.error.message}</p>}
      {filings.isPending && !noSignal(filings) && <p className="muted">Loading…</p>}
      {filings.isSuccess && rows.length === 0 && <p className="ops-empty">No filings yet.</p>}
      {filings.isSuccess && rows.length > 0 && upcoming.length === 0 && <p className="ops-empty">All filed.</p>}

      {upcoming.length > 0 && <ul className="ops-rows">{upcoming.map(row)}</ul>}

      {filings.hasNextPage && (
        <div className="ops-actions" style={{ marginTop: 'var(--s-3)' }}>
          <button type="button" className="btn ops-tap" disabled={filings.isFetchingNextPage}
            onClick={() => filings.fetchNextPage()}>
            {filings.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}

      {filed.length > 0 && (
        <div className="ops-foot">
          <button type="button" className="ops-more disclose" aria-expanded={showFiled} aria-controls="filed-list"
            onClick={() => setShowFiled((v) => !v)}>
            Filed · {filed.length}
          </button>
          {showFiled && <ul id="filed-list" className="ops-rows ops-more-body">{filed.map(row)}</ul>}
        </div>
      )}
    </div>
  );
}
