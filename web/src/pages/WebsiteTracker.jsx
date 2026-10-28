// Website → Promise tracker: the governing party's promises, scored in
// public. The list is the scoreboard and every promise; a promise's page
// holds its words, its delivery test and the dated updates that score it.
// Announcements (what the party said, when) sit under the list.
// A new campaign starts empty: "Load the 26 promises" brings in the tracker
// as first published on the website.
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { ConfirmDelete, useSave } from '../components/WebsiteBits.jsx';

export const STATUSES = [
  ['not_started', 'Not started', 'tr-s--none'],
  ['in_progress', 'In progress', 'tr-s--going'],
  ['partly_kept', 'Partly kept', 'tr-s--partly'],
  ['kept', 'Kept', 'tr-s--kept'],
  ['broken', 'Broken', 'tr-s--broken'],
];
const label = (s) => STATUSES.find(([k]) => k === s)?.[1] || s;
const cls = (s) => STATUSES.find(([k]) => k === s)?.[2] || '';
const StatusChip = ({ status }) => <span className={`chip tr-s ${cls(status)}`}>{label(status)}</span>;
const useTracker = () => useQuery({ queryKey: ['tracker'], queryFn: () => apiGet('/tracker') });
const today = () => new Date().toISOString().slice(0, 10);

function SourcesField({ value, onChange }) {
  const rows = value.length ? value : [{ label: '', url: '' }];
  const set = (i, k, v) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <div className="field">
      <span className="ws-label">Sources</span>
      {rows.map((r, i) => (
        <div className="tr-source" key={i}>
          <input className="input" placeholder="What it is (Daily Hive, Apr 13)" maxLength={200} value={r.label} onChange={(e) => set(i, 'label', e.target.value)} />
          <input className="input mono" type="url" placeholder="https://" maxLength={500} value={r.url || ''} onChange={(e) => set(i, 'url', e.target.value)} />
          <button type="button" className="btn btn-quiet" aria-label="Remove source" onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" className="btn btn-quiet ops-tap" onClick={() => onChange([...rows, { label: '', url: '' }])}>+ Source</button>
    </div>
  );
}

function Announcements({ list }) {
  const queryClient = useQueryClient();
  const save = useSave();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ date: today(), date_label: '', title: '', commitments: '' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tracker'] });
  const add = async (e) => {
    e.preventDefault();
    const res = await save.run('tracker.announcement.save', { date: f.date, date_label: f.date_label.trim(), title: f.title.trim(), commitments: f.commitments.trim(), sources: [] });
    if (res) { setF({ date: today(), date_label: '', title: '', commitments: '' }); refresh(); }
  };
  const del = async (id) => { if (await save.run('tracker.announcement.delete', { id })) refresh(); };
  return (
    <section className="tr-ann">
      <button type="button" className="ot-more disclose disclose--inline ws-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Announcements <span className="muted">· {list.length}</span>
      </button>
      {open && (
        <div className="ws-more-body">
          <ul className="ops-rows">
            {list.map((a) => (
              <li key={a.id} className="ops-item">
                <div className="ops-row ops-row--static">
                  <span className="ops-row__main">
                    <span className="ops-row__name">{a.title}</span>
                    <span className="ops-row__sub"><span>{a.date_label || a.date}</span>{a.commitments && <span>{a.commitments}</span>}</span>
                  </span>
                  <span className="ops-row__end"><ConfirmDelete what="this announcement" onYes={() => del(a.id)} busy={save.busy} /></span>
                </div>
              </li>
            ))}
          </ul>
          <form className="card tr-add" onSubmit={add}>
            <h3>Add an announcement</h3>
            <div className="form-row">
              <div className="field ws-narrow-field"><label htmlFor="an-date">Date</label><input id="an-date" className="input mono" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
              <div className="field"><label htmlFor="an-label">How the date reads</label><input id="an-label" className="input" maxLength={80} placeholder="July 28 to 29, 2026" value={f.date_label} onChange={(e) => setF({ ...f, date_label: e.target.value })} /></div>
            </div>
            <div className="field"><label htmlFor="an-title">What happened</label><input id="an-title" className="input" required maxLength={300} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
            <div className="field"><label htmlFor="an-c">What was promised</label><textarea id="an-c" className="input" rows={3} maxLength={4000} value={f.commitments} onChange={(e) => setF({ ...f, commitments: e.target.value })} /></div>
            {save.error && <p className="error" role="alert">{save.error}</p>}
            <button type="submit" className="btn btn-primary ops-tap" disabled={save.busy || !f.title.trim()}>Add</button>
          </form>
        </div>
      )}
    </section>
  );
}

function TrackerList() {
  const q = useTracker();
  const queryClient = useQueryClient();
  const save = useSave();
  const t = q.data;
  const seed = async () => { if (await save.run('tracker.seed', {})) queryClient.invalidateQueries({ queryKey: ['tracker'] }); };
  return (
    <>
      <div className="ws-subhead">
        <h2>Promise tracker</h2>
        <Link className="btn btn-primary ops-tap" to="/website/tracker/new">Add promise</Link>
      </div>
      {noSignal(q) && <NoSignal />}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {t && t.total > 0 && (
        <div className="tr-board" role="list" aria-label="Scoreboard">
          {STATUSES.map(([k, l, c]) => (
            <span key={k} role="listitem" className={`tr-board__n ${c}`}><strong className="mono">{t.counts[k]}</strong> {l}</span>
          ))}
        </div>
      )}
      {t && t.total === 0 && (
        <div className="card tr-empty">
          <p>No promises yet. Start from the tracker as first published — the 26 Safe Surrey Coalition promises with their delivery tests and the announcements log — or add promises one by one.</p>
          {save.error && <p className="error" role="alert">{save.error}</p>}
          <button type="button" className="btn btn-primary ops-tap" disabled={save.busy} onClick={seed}>{save.busy ? 'Loading…' : 'Load the 26 promises'}</button>
        </div>
      )}
      <ul className="ops-rows">
        {(t?.promises ?? []).map((p) => (
          <li key={p.id} className="ops-item">
            <Link className="ops-row" to={`/website/tracker/${p.id}`}>
              <span className="tr-num mono">{p.number}</span>
              <span className="ops-row__main">
                <span className="ops-row__name">{p.title}</span>
                <span className="ops-row__sub">{p.area && <span>{p.area}</span>}<span>{p.updates.length} {p.updates.length === 1 ? 'update' : 'updates'}</span></span>
              </span>
              <span className="ops-row__end"><StatusChip status={p.status} /></span>
            </Link>
          </li>
        ))}
      </ul>
      {t && <Announcements list={t.announcements} />}
    </>
  );
}

function PromiseEditor({ id }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = id === 'new';
  const q = useTracker();
  const cur = q.data?.promises?.find((p) => p.id === id);
  const [f, setF] = useState(null);
  const [u, setU] = useState({ date: today(), status: '', note: '', url: '' });
  const [more, setMore] = useState(false);
  const save = useSave();
  const [upd, setUpd] = useState({ busy: false, error: null });
  useEffect(() => {
    if (isNew) setF({ number: (q.data?.promises?.length || 0) + 1, title: '', area: '', specifics: '', sources: [], status: 'not_started', test: { kept: '', partly: '', broken: '', record: '' } });
    else if (cur) setF({ ...cur, test: { kept: cur.test.kept || '', partly: cur.test.partly || '', broken: cur.test.broken || '', record: cur.test.record || '' } });
  }, [isNew, cur, q.data]);
  if (noSignal(q)) return <NoSignal />;
  if (q.isSuccess && !isNew && !cur) return <p className="ops-empty">This promise is gone. <Link to="/website/tracker">Promise tracker</Link></p>;
  if (!f) return <p className="muted">Loading…</p>;
  const set = (k) => (v) => { save.clearSaved(); setF((x) => ({ ...x, [k]: v })); };
  const setTest = (k) => (v) => { save.clearSaved(); setF((x) => ({ ...x, test: { ...x.test, [k]: v } })); };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tracker'] });

  const submit = async (e) => {
    e.preventDefault();
    const input = {
      number: Number(f.number) || 0, title: f.title.trim(), area: f.area.trim(), specifics: f.specifics.trim(),
      sources: f.sources.filter((s) => s.label.trim()).map((s) => ({ label: s.label.trim(), url: (s.url || '').trim() })),
      status: f.status, test_kept: f.test.kept.trim(), test_partly: f.test.partly.trim(), test_broken: f.test.broken.trim(), test_record: f.test.record.trim(),
    };
    if (!isNew) input.id = id;
    const res = await save.run('tracker.promise.save', input);
    if (res) { refresh(); if (isNew) navigate(`/website/tracker/${res.promise.id}`, { replace: true, state: { saved: true } }); }
  };
  const del = async () => { if (await save.run('tracker.promise.delete', { id })) { refresh(); navigate('/website/tracker'); } };
  const addUpdate = async (e) => {
    e.preventDefault();
    setUpd({ busy: true, error: null });
    try {
      const res = await action('tracker.update.add', { promise_id: id, date: u.date, status: u.status || null, note: u.note.trim(), url: u.url.trim() });
      setU({ date: today(), status: '', note: '', url: '' });
      setF((x) => ({ ...x, status: res.promise_status }));
      refresh();
      setUpd({ busy: false, error: null });
    } catch (err) {
      setUpd({ busy: false, error: err.message });
    }
  };
  const delUpdate = async (uid) => {
    try { await action('tracker.update.delete', { id: uid }); refresh(); } catch (err) { setUpd({ busy: false, error: err.message }); }
  };

  return (
    <>
      <form className="ws-editor" onSubmit={submit}>
        <Link className="ops-back" to="/website/tracker">← Promise tracker</Link>
        <div className="form-row">
          <div className="field ws-narrow-field">
            <label htmlFor="pr-num">Number</label>
            <input id="pr-num" className="input mono" type="number" min={1} max={999} required value={f.number} onChange={(e) => set('number')(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pr-area">Area</label>
            <input id="pr-area" className="input" maxLength={80} placeholder="Taxes, Transit, Policing…" value={f.area} onChange={(e) => set('area')(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="pr-title">The promise</label>
          <input id="pr-title" className="input ws-title-input" required maxLength={300} value={f.title} autoFocus={isNew} onChange={(e) => set('title')(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pr-spec">Specifics</label>
          <textarea id="pr-spec" className="input" rows={3} maxLength={2000} value={f.specifics} onChange={(e) => set('specifics')(e.target.value)} placeholder="Conditions, dates, what was and wasn’t said." />
        </div>
        <div className="field">
          <label htmlFor="pr-status">Status</label>
          <select id="pr-status" className="input" value={f.status} onChange={(e) => set('status')(e.target.value)}>
            {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <span className="ops-meta">Scoring with a dated update below keeps the record; this is the quick way.</span>
        </div>
        <button type="button" className="ot-more disclose disclose--inline ws-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>Delivery test and sources</button>
        {more && (
          <div className="ws-more-body">
            {[['kept', 'Counts as kept'], ['partly', 'Counts as partly kept'], ['broken', 'Counts as broken'], ['record', 'Where to check']].map(([k, l]) => (
              <div className="field" key={k}>
                <label htmlFor={`pr-t-${k}`}>{l}</label>
                <textarea id={`pr-t-${k}`} className="input" rows={2} maxLength={2000} value={f.test[k]} onChange={(e) => setTest(k)(e.target.value)} />
              </div>
            ))}
            <SourcesField value={f.sources} onChange={set('sources')} />
          </div>
        )}
        {save.error && <p className="error" role="alert">{save.error}</p>}
        <div className="ws-save-row">
          <button type="submit" className="btn btn-primary ops-tap" disabled={save.busy || !f.title.trim()}>{save.busy ? 'Saving…' : 'Save'}</button>
          {save.saved && <span className="ops-done" role="status">Saved</span>}
          <span className="spacer" />
          {!isNew && <ConfirmDelete what="this promise" onYes={del} busy={save.busy} />}
        </div>
      </form>
      {!isNew && cur && (
        <section className="tr-updates">
          <h2>Updates <span className="muted">· the record behind the score</span></h2>
          <ul className="ops-rows">
            {cur.updates.map((x) => (
              <li key={x.id} className="ops-item">
                <div className="ops-row ops-row--static">
                  <span className="ops-row__main">
                    <span className="ops-row__name">{x.note}</span>
                    <span className="ops-row__sub"><span className="mono">{x.date}</span>{x.status && <span>→ {label(x.status)}</span>}{x.url && <a href={x.url} target="_blank" rel="noopener">Source ↗</a>}</span>
                  </span>
                  <span className="ops-row__end"><ConfirmDelete what="this update" onYes={() => delUpdate(x.id)} busy={upd.busy} /></span>
                </div>
              </li>
            ))}
          </ul>
          {!cur.updates.length && <p className="ops-empty">No updates yet.</p>}
          <form className="card tr-add" onSubmit={addUpdate}>
            <h3>Add an update</h3>
            <div className="form-row">
              <div className="field ws-narrow-field"><label htmlFor="up-date">Date</label><input id="up-date" className="input mono" type="date" required value={u.date} onChange={(e) => setU({ ...u, date: e.target.value })} /></div>
              <div className="field">
                <label htmlFor="up-status">Score</label>
                <select id="up-status" className="input" value={u.status} onChange={(e) => setU({ ...u, status: e.target.value })}>
                  <option value="">No change</option>
                  {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
            </div>
            <div className="field"><label htmlFor="up-note">What happened</label><textarea id="up-note" className="input" rows={2} required maxLength={2000} value={u.note} onChange={(e) => setU({ ...u, note: e.target.value })} /></div>
            <div className="field"><label htmlFor="up-url">Link to the record</label><input id="up-url" className="input mono" type="url" placeholder="https://" maxLength={500} value={u.url} onChange={(e) => setU({ ...u, url: e.target.value })} /></div>
            {upd.error && <p className="error" role="alert">{upd.error}</p>}
            <button type="submit" className="btn btn-primary ops-tap" disabled={upd.busy || !u.note.trim()}>{upd.busy ? 'Adding…' : 'Add update'}</button>
          </form>
        </section>
      )}
    </>
  );
}

export default function WebsiteTracker({ id }) {
  return id ? <PromiseEditor key={id} id={id} /> : <TrackerList />;
}
