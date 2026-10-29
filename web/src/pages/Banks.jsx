// Phone banks (ext/banks). The desk: every bank, a new one from the people
// list (a search, a rating, a tag — everyone with a phone who matches), its
// numbers handed to a caller or split across a team, who has what and how
// far they are, numbers taken back, the bank closed. A volunteer here sees
// their own call lists; each opens on Calls (/calls?bank=…), where a logged
// call crosses the number off.
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { codesInBand } from '@starbase/shared/scale';
import { ApiError, action, apiGet } from '../api.js';
import { RatingChip, useScale } from '../components/RatingButtons.jsx';
import './dashboard.css';
import './banks.css';
import '../editor.css';

const DESK = ['manager', 'staff', 'treasurer'];
const plural = (n, w, many = `${w}s`) => (n === 1 ? w : many);
const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const BANDS = [['', 'Any rating'], ['support', 'Support'], ['undecided', 'Undecided'], ['opposed', 'Opposed'], ['unrated', 'Unrated']];

export default function Banks() {
  const { me } = useOutletContext();
  const { id } = useParams();
  const desk = DESK.includes(me?.role);
  if (!desk) return <Mine />;
  if (id === 'new') return <NewBank />;
  if (id) return <Bank id={id} />;
  return <List />;
}

const useSaver = (keys = [['banks']]) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (name, input) => {
    setBusy(true); setError(null);
    try {
      const r = await action(name, input);
      await Promise.all(keys.map((k) => queryClient.invalidateQueries({ queryKey: k })));
      return r;
    } catch (e) { setError(e instanceof ApiError ? e.message : 'No signal — try again'); return null; } finally { setBusy(false); }
  };
  return { run, busy, error };
};

// ── Your call lists (any role) ──
export function Mine({ embedded = false }) {
  const q = useQuery({ queryKey: ['banks', 'mine'], queryFn: () => apiGet('/banks/mine'), staleTime: 15_000 });
  const banks = q.data?.banks || [];
  if (embedded && !banks.length) return null;
  return (
    <div className={embedded ? 'bk-mine bk-mine--embedded' : 'bk'}>
      {!embedded && <div className="page-head"><div><span className="eyebrow">Calls</span><h1>Your call lists</h1></div></div>}
      {embedded && <h2 className="today-h">Your call lists</h2>}
      {q.isError && !q.data && <p className="error">{q.error.message}</p>}
      {!embedded && q.data && !banks.length && <div className="pp-empty"><p>No numbers handed to you right now. <Link to="/calls">Calls</Link> has everyone you may call.</p></div>}
      <ul className="bk-list">
        {banks.map((b) => (
          <li key={b.id}>
            <Link className="bk-row" to={`/calls?bank=${b.id}&channel=phone`}>
              <span className="bk-row__main">
                <span className="bk-row__name">{b.name}</span>
                <span className="bk-row__sub">{b.left ? `${num(b.left)} to call` : 'All done'} · {num(b.done)} of {num(b.total)} done</span>
              </span>
              <span className="bk-bar" aria-hidden="true"><span style={{ width: `${b.total ? Math.round((b.done / b.total) * 100) : 0}%` }} /></span>
              <span className="today-chev" aria-hidden="true">›</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── The desk's list ──
function List() {
  const q = useQuery({ queryKey: ['banks'], queryFn: () => apiGet('/banks'), staleTime: 15_000 });
  if (q.isError && !q.data) return <p className="error" role="alert">{q.error.message}</p>;
  if (!q.data) return <p className="muted">Loading…</p>;
  const banks = q.data.banks;
  return (
    <div className="bk">
      <div className="page-head">
        <div><span className="eyebrow">Calls</span><h1>Phone banks</h1></div>
        <div className="head-actions"><Link className="btn btn-primary" to="/banks/new">New phone bank</Link></div>
      </div>
      <Mine embedded />
      {!banks.length ? (
        <div className="pp-empty"><p>No phone banks yet. Make one from the people you want called, then hand the numbers out.</p></div>
      ) : (
        <ul className="bk-list">
          {banks.map((b) => (
            <li key={b.id}>
              <Link className={`bk-row${b.closed ? ' is-closed' : ''}`} to={`/banks/${b.id}`}>
                <span className="bk-row__main">
                  <span className="bk-row__name">{b.name}{b.closed && <span className="chip">Closed</span>}</span>
                  <span className="bk-row__sub">
                    {num(b.total)} {plural(b.total, 'number')} · {num(b.done)} done · {num(b.open)} not handed out
                    {b.callers.length > 0 && <> · {b.callers.map((c) => `${c.name} ${c.done}/${c.total}`).join(', ')}</>}
                  </span>
                </span>
                <span className="bk-bar" aria-hidden="true"><span style={{ width: `${b.total ? Math.round((b.done / b.total) * 100) : 0}%` }} /></span>
                <span className="today-chev" aria-hidden="true">›</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── A new bank from the people list ──
function NewBank() {
  const navigate = useNavigate();
  const scale = useScale();
  const [name, setName] = useState('');
  const [script, setScript] = useState('');
  const [f, setF] = useState({ q: '', band: '', tag: '' });
  const id = useId();
  const { run, busy, error } = useSaver();
  const qs = useMemo(() => {
    const p = new URLSearchParams({ has: 'phone', limit: '2000' });
    if (f.q.trim()) p.set('q', f.q.trim());
    if (f.tag.trim()) p.set('tag', f.tag.trim());
    if (f.band === 'unrated') p.set('rating', 'unrated');
    else if (f.band) p.set('rating', codesInBand(scale, f.band).join(','));
    return p.toString();
  }, [f, scale]);
  const people = useQuery({ queryKey: ['persons', 'list', qs], queryFn: () => apiGet(`/persons?${qs}`), staleTime: 15_000 });
  const callable = useMemo(() => (people.data?.persons || []).filter((p) => p.phone && !(p.tags || []).includes('do-not-contact')), [people.data]);
  const submit = async (e) => {
    e.preventDefault();
    const r = await run('bank.create', { name, script: script || null, person_ids: callable.map((p) => p.id) });
    if (r) navigate(`/banks/${r.bank.id}`, { replace: true });
  };
  return (
    <div className="bk">
      <p className="lu-back"><Link to="/banks">← Phone banks</Link></p>
      <div className="page-head"><div><span className="eyebrow">Calls</span><h1>New phone bank</h1></div></div>
      <form className="bk-form" onSubmit={submit}>
        <label htmlFor={`${id}-n`} className="ws-label">Name</label>
        <input id={`${id}-n`} className="input" value={name} maxLength={120} required autoFocus placeholder="Undecided in Newton — week of Nov 3" onChange={(e) => setName(e.target.value)} />
        <fieldset className="bk-who">
          <legend className="ws-label">Who to call</legend>
          <div className="bk-who__row">
            <div><label htmlFor={`${id}-b`} className="ws-label">Rating</label>
              <select id={`${id}-b`} className="input" value={f.band} onChange={(e) => setF({ ...f, band: e.target.value })}>{BANDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><label htmlFor={`${id}-t`} className="ws-label">Tag</label>
              <input id={`${id}-t`} className="input" value={f.tag} placeholder="volunteer, newton…" onChange={(e) => setF({ ...f, tag: e.target.value })} /></div>
            <div className="bk-who__grow"><label htmlFor={`${id}-q`} className="ws-label">Search (name, street, phone)</label>
              <input id={`${id}-q`} className="input" value={f.q} placeholder="104 Ave" onChange={(e) => setF({ ...f, q: e.target.value })} /></div>
          </div>
          <p className="bk-count" role="status">
            {people.isFetching && !people.data ? 'Counting…' : <><strong className="mono">{num(callable.length)}</strong> {plural(callable.length, 'person', 'people')} with a phone{callable.length >= 2000 ? ' (the first 2,000)' : ''}{people.data && people.data.persons.length > callable.length ? ` — ${people.data.persons.length - callable.length} do-not-contact left out` : ''}</>}
          </p>
          {callable.length > 0 && (
            <ul className="bk-sample">
              {callable.slice(0, 5).map((p) => <li key={p.id}>{p.name} <span className="muted">· {p.phone}</span> {p.rating && <RatingChip code={p.rating} who brief />}</li>)}
              {callable.length > 5 && <li className="muted">…and {num(callable.length - 5)} more</li>}
            </ul>
          )}
        </fieldset>
        <label htmlFor={`${id}-s`} className="ws-label">Script (what callers see while they call)</label>
        <textarea id={`${id}-s`} className="input bk-script" rows={6} value={script} maxLength={20_000}
          placeholder={'Hi, this is ___ with Imagine Surrey. We’re calling neighbours about the election on…'} onChange={(e) => setScript(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="lu-form__acts">
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !callable.length}>Make the bank with {num(callable.length)} {plural(callable.length, 'number')}</button>
          <Link className="btn btn-quiet" to="/banks">Cancel</Link>
        </div>
      </form>
    </div>
  );
}

// ── One bank: hand out, take back, watch ──
function Bank({ id }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['banks', id], queryFn: () => apiGet(`/banks/${id}`), refetchInterval: 30_000 });
  const members = useQuery({ queryKey: ['members'], queryFn: () => apiGet('/members'), staleTime: 60_000 });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => apiGet('/teams'), staleTime: 60_000 });
  const { run, busy, error } = useSaver([['banks'], ['banks', id]]);
  const [to, setTo] = useState('');       // 'u:<id>' | 't:<id>'
  const [count, setCount] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [editScript, setEditScript] = useState(null);
  const [ask, setAsk] = useState(false);
  const fid = useId();
  useEffect(() => { if (q.data && editScript === null) setEditScript(null); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isError && !q.data) return <div className="bk"><p className="error" role="alert">{q.error.status === 404 ? 'That phone bank isn’t here.' : q.error.message}</p><Link className="btn" to="/banks">Phone banks</Link></div>;
  if (!q.data) return <p className="muted">Loading…</p>;
  const { bank, numbers } = q.data;
  const open = numbers.filter((n) => !n.assigned_to && !n.done_at).length;
  const handOut = async (e) => {
    e.preventDefault();
    if (!to) return;
    const [kind, who] = to.split(':');
    const input = { id, count: count ? Number(count) : undefined };
    if (kind === 'u') input.user_id = who; else input.team_id = who;
    const r = await run('bank.assign', input);
    if (r) setCount('');
  };
  const shown = showAll ? numbers : numbers.slice(0, 40);
  return (
    <div className="bk">
      <p className="lu-back"><Link to="/banks">← Phone banks</Link></p>
      <div className="page-head bk-head">
        <div><span className="eyebrow">Phone bank{bank.closed ? ' · Closed' : ''}</span><h1>{bank.name}</h1></div>
        <div className="head-actions">
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run('bank.update', { id, closed: !bank.closed })}>{bank.closed ? 'Reopen' : 'Close'}</button>
          {ask ? (
            <span className="ops-confirm"><span>Remove the bank?</span>
              <button type="button" className="btn ops-danger" disabled={busy} onClick={async () => { if (await run('bank.remove', { id })) navigate('/banks'); }}>Yes</button>
              <button type="button" className="btn btn-quiet" onClick={() => setAsk(false)}>No</button></span>
          ) : <button type="button" className="btn btn-quiet" onClick={() => setAsk(true)}>Remove</button>}
        </div>
      </div>

      <div className="dash-figs bk-figs" role="list">
        {[['Numbers', bank.total], ['Handed out', bank.assigned], ['Done', bank.done], ['Not handed out', open]].map(([l, n]) => (
          <div className="dash-fig" role="listitem" key={l}><span className="dash-fig__n">{num(n)}</span><span className="dash-fig__label">{l}</span></div>
        ))}
      </div>

      <section className="bk-sec" aria-labelledby={`${fid}-h`}>
        <h2 className="dash-sec__h" id={`${fid}-h`}>Hand out numbers</h2>
        {bank.closed ? <p className="muted">The bank is closed — reopen it to hand out numbers.</p> : open === 0 ? <p className="muted">Every number is handed out or done.</p> : (
          <form className="bk-hand" onSubmit={handOut}>
            <div className="bk-hand__to">
            <label htmlFor={`${fid}-to`} className="ws-label">To</label>
            <select id={`${fid}-to`} className="input" value={to} onChange={(e) => setTo(e.target.value)} required>
              <option value="">Pick a caller or a team…</option>
              {teams.data?.teams?.length > 0 && (
                <optgroup label="Teams (split evenly)">
                  {teams.data.teams.map((t) => <option key={t.id} value={`t:${t.id}`}>{t.name} · {t.members.length}</option>)}
                </optgroup>
              )}
              <optgroup label="People">
                {(members.data?.members || []).map((m) => <option key={m.id} value={`u:${m.id}`}>{m.name} · {m.role}</option>)}
              </optgroup>
            </select>
            </div>
            <div>
            <label htmlFor={`${fid}-c`} className="ws-label">How many</label>
            <input id={`${fid}-c`} className="input bk-hand__n" type="number" min="1" max={open} value={count} placeholder={`all ${num(open)}`} onChange={(e) => setCount(e.target.value)} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || !to}>Hand out</button>
          </form>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {bank.callers.length > 0 && (
        <section className="bk-sec" aria-label="Callers">
          <h2 className="dash-sec__h">Callers</h2>
          <ul className="bk-callers">
            {bank.callers.map((c) => (
              <li key={c.user_id} className="bk-caller">
                <span className="bk-caller__name">{c.name}</span>
                <span className="bk-bar" aria-hidden="true"><span style={{ width: `${c.total ? Math.round((c.done / c.total) * 100) : 0}%` }} /></span>
                <span className="mono bk-caller__n">{c.done} / {c.total}</span>
                {c.done < c.total && <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run('bank.release', { id, user_id: c.user_id })}>Take back {c.total - c.done}</button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="bk-sec" aria-label="Script">
        <div className="dash-sec__head">
          <h2 className="dash-sec__h">Script</h2>
          {editScript === null && <button type="button" className="btn btn-quiet" onClick={() => setEditScript(bank.script || '')}>{bank.script ? 'Edit' : 'Add a script'}</button>}
        </div>
        {editScript !== null ? (
          <form className="bk-form" onSubmit={async (e) => { e.preventDefault(); if (await run('bank.update', { id, script: editScript || null })) setEditScript(null); }}>
            <textarea className="input bk-script" rows={8} value={editScript} maxLength={20_000} onChange={(e) => setEditScript(e.target.value)} />
            <div className="lu-form__acts">
              <button type="submit" className="btn btn-primary" disabled={busy}>Save</button>
              <button type="button" className="btn btn-quiet" onClick={() => setEditScript(null)}>Cancel</button>
            </div>
          </form>
        ) : bank.script ? <pre className="bk-script__read">{bank.script}</pre> : <p className="muted">No script yet — callers see one here and on their call card.</p>}
      </section>

      <section className="bk-sec" aria-label="Numbers">
        <h2 className="dash-sec__h">Numbers</h2>
        <div className="dash-tablewrap">
          <table className="dash-table bk-table">
            <thead><tr><th scope="col">Who</th><th scope="col">Phone</th><th scope="col">Rating</th><th scope="col">Caller</th><th scope="col">Status</th><th scope="col"><span className="pp-sr">Actions</span></th></tr></thead>
            <tbody>
              {shown.map((n) => (
                <tr key={n.person_id} className={n.done_at ? 'is-done' : ''}>
                  <th scope="row"><Link to={`/people/${n.person_id}`}>{n.name}</Link></th>
                  <td className="mono">{n.phone}</td>
                  <td>{n.rating ? <RatingChip code={n.rating} who brief /> : <span className="muted">·</span>}</td>
                  <td>{n.caller || <span className="muted">—</span>}</td>
                  <td>{n.done_at ? <span className="chip chip-ok">{n.outcome || 'done'}</span> : n.assigned_to ? 'to call' : <span className="muted">not handed out</span>}</td>
                  <td className="bk-table__acts">
                    {!n.done_at && n.assigned_to && <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run('bank.release', { id, person_id: n.person_id })}>Take back</button>}
                    {!n.done_at && <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => run('bank.done', { id, person_id: n.person_id, outcome: 'skipped' })}>Skip</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {numbers.length > shown.length && <button type="button" className="btn btn-quiet" onClick={() => setShowAll(true)}>Show all {num(numbers.length)}</button>}
      </section>
    </div>
  );
}
