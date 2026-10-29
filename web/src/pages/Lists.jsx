// Lists — saved filters and hand-picked lists of people: an audience for an
// email or text blast, a CSV, a report.
//   /lists           every list with how many it names, and how many can be
//                    emailed or texted · New list
//   /lists/new       a new one: a saved filter (tag, rating, role, has — the
//                    count updates as you pick) or a hand-picked list; People's
//                    "Save as a list" arrives here with the filter filled in
//   /lists/:id       its people, search, Add people (hand-picked), Remove,
//                    Edit the filter, Download CSV, Email this list, Text this list
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { VOLUNTEER_ROLES } from '@starbase/shared/canvass';
import { apiGet } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { useScale } from '../components/RatingButtons.jsx';
import { useAction, ratingBands } from './People.jsx';
import './shifts.css';
import './lists.css';

const FILTER_KEYS = ['q', 'tag', 'rating', 'role', 'has', 'field'];
const HAS = [['', 'Anyone'], ['email', 'An email address'], ['phone', 'A phone number'], ['location', 'A pin on the map']];
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
const qs = (f) => new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([k, v]) => v && FILTER_KEYS.includes(k)))).toString();
const cleanFilter = (f) => Object.fromEntries(Object.entries(f || {}).filter(([k, v]) => v && FILTER_KEYS.includes(k)));

const Counts = ({ counts, kind }) => counts && (
  <span className="ls-counts">
    <strong className="mono">{counts.total}</strong> {plural(counts.total, 'person', 'people')}
    <span> · {counts.with_email} by email · {counts.with_phone} by text</span>
    {kind === 'filter' && <span className="muted"> · matches today</span>}
  </span>
);

// The filter fields: the same choices as People's own filter.
function FilterFields({ value, onChange }) {
  const scale = useScale();
  const tags = useQuery({ queryKey: ['lists', 'tags'], queryFn: () => apiGet('/lists/tags') });
  const set = (k) => (v) => onChange({ ...value, [k]: v || '' });
  return (
    <div className="ls-filter">
      <div className="field">
        <label htmlFor="ls-tag">Tag <span className="muted">(or several, with commas)</span></label>
        <input id="ls-tag" className="input" list="ls-tags" value={value.tag || ''} onChange={(e) => set('tag')(e.target.value)} placeholder="member, volunteer…" />
        <datalist id="ls-tags">{(tags.data?.tags ?? []).map((t) => <option key={t.tag} value={t.tag}>{t.n}</option>)}</datalist>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ls-rating">Rating</label>
          <select id="ls-rating" className="input" value={value.rating || ''} onChange={(e) => set('rating')(e.target.value)}>
            <option value="">Any</option>
            {ratingBands(scale).map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ls-role">Volunteer role</label>
          <select id="ls-role" className="input" value={value.role || ''} onChange={(e) => set('role')(e.target.value)}>
            <option value="">Any</option>
            {VOLUNTEER_ROLES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ls-has">Has</label>
          <select id="ls-has" className="input" value={value.has || ''} onChange={(e) => set('has')(e.target.value)}>
            {HAS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="ls-q">Words <span className="muted">(name, street, phone, email)</span></label>
        <input id="ls-q" className="input" value={value.q || ''} onChange={(e) => set('q')(e.target.value)} />
      </div>
    </div>
  );
}

function usePreview(filter, on) {
  const key = qs(filter);
  return useQuery({ queryKey: ['lists', 'preview', key], queryFn: () => apiGet(`/lists/preview?${key}`), enabled: on });
}

// Add people to a hand-picked list: search, tap to add.
function AddPeople({ listId, onAdded }) {
  const [q, setQ] = useState('');
  const found = useQuery({ queryKey: ['persons', 'ls-search', q], queryFn: () => apiGet(`/persons?q=${encodeURIComponent(q.trim())}&limit=20`), enabled: q.trim().length >= 2 });
  const act = useAction(() => onAdded(), { needsSignal: true });
  return (
    <div className="ls-add">
      <div className="field">
        <label htmlFor="ls-add-q">Add people</label>
        <input id="ls-add-q" className="input" type="search" placeholder="Type a name" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {act.error && <p className="error">{act.error}</p>}
      {q.trim().length >= 2 && (
        <ul className="ops-rows ls-found">
          {(found.data?.persons ?? []).map((p) => (
            <li key={p.id} className="ops-item">
              <div className="ops-row ops-row--static">
                <span className="ops-row__main"><span className="ops-row__name">{p.name}</span><span className="ops-row__sub">{p.email && <span>{p.email}</span>}{p.phone && <span>{p.phone}</span>}</span></span>
                <button type="button" className="btn btn-quiet ops-tap" disabled={act.busy} onClick={() => act.run('list.add', { id: listId, person_ids: [p.id] })}>Add</button>
              </div>
            </li>
          ))}
          {found.isSuccess && !found.data.persons.length && <li className="ops-empty">No one by that name.</li>}
        </ul>
      )}
    </div>
  );
}

function NewList() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fromPeople = cleanFilter(Object.fromEntries(params));
  const [name, setName] = useState('');
  const [kind, setKind] = useState('filter');
  const [filter, setFilter] = useState(fromPeople);
  const preview = usePreview(filter, kind === 'filter');
  const act = useAction(null, { needsSignal: true });
  const submit = async (e) => {
    e.preventDefault();
    const res = await act.run('list.create', { name: name.trim(), kind, ...(kind === 'filter' ? { filter: cleanFilter(filter) } : {}) });
    if (res) navigate(`/lists/${res.list.id}`, { replace: true });
  };
  return (
    <form className="ops-page ls-page" onSubmit={submit}>
      <Link className="ops-back" to="/lists">← Lists</Link>
      <div className="ops-head"><h1>New list</h1></div>
      <div className="field">
        <label htmlFor="ls-name">Name</label>
        <input id="ls-name" className="input" required maxLength={120} value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Members in Newton" />
      </div>
      <div className="ls-kinds" role="radiogroup" aria-label="Kind of list">
        <label className={`ls-kind${kind === 'filter' ? ' is-on' : ''}`}><input type="radio" name="kind" checked={kind === 'filter'} onChange={() => setKind('filter')} /> <span><strong>A saved filter</strong><br /><span className="muted">Whoever matches it, today and as people change.</span></span></label>
        <label className={`ls-kind${kind === 'people' ? ' is-on' : ''}`}><input type="radio" name="kind" checked={kind === 'people'} onChange={() => setKind('people')} /> <span><strong>Hand-picked</strong><br /><span className="muted">The people you put on it.</span></span></label>
      </div>
      {kind === 'filter' && (
        <>
          <FilterFields value={filter} onChange={setFilter} />
          <p className="ls-preview">{preview.data ? <Counts counts={preview.data.counts} kind="filter" /> : 'Counting…'}</p>
        </>
      )}
      {kind === 'people' && <p className="ops-meta">Save it, then add people by name.</p>}
      {act.error && <p className="error" role="alert">{act.error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={act.busy || !name.trim()}>Save list</button>
        <Link className="btn btn-quiet ops-tap" to="/lists">Cancel</Link>
      </div>
    </form>
  );
}

function OneList({ id }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState(null);
  const [asking, setAsking] = useState(false);
  const list = useQuery({ queryKey: ['lists', id, q], queryFn: () => apiGet(`/lists/${id}?q=${encodeURIComponent(q.trim())}&limit=500`) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['lists'] });
  const act = useAction(refresh, { needsSignal: true });
  const l = list.data?.list;
  useEffect(() => { if (l && filter == null) setFilter(l.filter || {}); }, [l, filter]);
  const preview = usePreview(filter || {}, !!(editing && l?.kind === 'filter'));
  if (noSignal(list)) return <NoSignal />;
  if (list.isError) return <p className="error">{list.error.message}</p>;
  if (!l) return <p className="muted">Loading…</p>;
  const people = list.data.people;
  const saveFilter = async () => { if (await act.run('list.update', { id, filter: cleanFilter(filter) })) setEditing(false); };
  const del = async () => { if (await act.run('list.delete', { id })) navigate('/lists'); };
  return (
    <div className="ops-page ls-page">
      <Link className="ops-back" to="/lists">← Lists</Link>
      <div className="ops-head">
        <h1>{l.name}</h1>
        <div className="ops-head__actions">
          <Link className="btn btn-primary ops-tap" to={`/outreach/eblast?list=${id}`}>Email this list</Link>
          <Link className="btn ops-tap" to={`/outreach/texts?list=${id}`}>Text this list</Link>
        </div>
      </div>
      <p className="ls-preview"><Counts counts={list.data.counts} kind={l.kind} /></p>
      <div className="ops-actions ls-tools">
        <a className="btn btn-quiet ops-tap" href={`/api/lists/${id}/export.csv`}>Download CSV</a>
        {l.kind === 'filter' && <button type="button" className="btn btn-quiet ops-tap" onClick={() => setEditing((v) => !v)}>{editing ? 'Close' : 'Edit the filter'}</button>}
        {asking ? (
          <span className="ops-confirm"><span>Delete this list?</span>
            <button type="button" className="btn ops-danger ops-tap" disabled={act.busy} onClick={del}>Yes</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsking(false)}>No</button></span>
        ) : <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsking(true)}>Delete</button>}
      </div>
      {act.error && <p className="error" role="alert">{act.error}</p>}
      {editing && l.kind === 'filter' && filter && (
        <div className="card ls-edit">
          <FilterFields value={filter} onChange={setFilter} />
          <p className="ls-preview">{preview.data ? <Counts counts={preview.data.counts} kind="filter" /> : 'Counting…'}</p>
          <button type="button" className="btn btn-primary ops-tap" disabled={act.busy} onClick={saveFilter}>Save the filter</button>
        </div>
      )}
      {l.kind === 'people' && <AddPeople listId={id} onAdded={refresh} />}
      <input className="input ls-search" type="search" placeholder="Search this list" aria-label="Search this list" value={q} onChange={(e) => setQ(e.target.value)} />
      {!people.length && <p className="ops-empty">{q ? 'No one by that name.' : l.kind === 'people' ? 'No one on this list yet.' : 'No one matches this filter yet.'}</p>}
      <ul className="ops-rows">
        {people.map((p) => (
          <li key={p.id} className="ops-item">
            <div className="ops-row ops-row--static">
              <Link className="ops-row__main ls-link" to={`/people/${p.id}`}>
                <span className="ops-row__name">{p.name}</span>
                <span className="ops-row__sub">{p.email && <span>{p.email}</span>}{p.phone && <span>{p.phone}</span>}{p.city && <span>{p.city}</span>}</span>
              </Link>
              {l.kind === 'people' && <button type="button" className="btn btn-quiet ops-tap" disabled={act.busy} onClick={() => act.run('list.remove', { id, person_ids: [p.id] })}>Remove</button>}
            </div>
          </li>
        ))}
      </ul>
      {list.data.total > people.length && <p className="ops-meta">Showing {people.length} of {list.data.total}. Download the CSV for everyone.</p>}
    </div>
  );
}

function AllLists() {
  const lists = useQuery({ queryKey: ['lists', 'all'], queryFn: () => apiGet('/lists') });
  return (
    <div className="ops-page ls-page">
      <div className="ops-head">
        <h1>Lists</h1>
        <div className="ops-head__actions"><Link className="btn btn-primary ops-tap" to="/lists/new">New list</Link></div>
      </div>
      <p className="ops-meta">A saved filter names whoever matches it today; a hand-picked list, the people you put on it. Either is an audience for an email or text blast, or a CSV.</p>
      {noSignal(lists) && <NoSignal />}
      {lists.isError && !noSignal(lists) && <p className="error">{lists.error.message}</p>}
      {lists.isSuccess && !lists.data.lists.length && <p className="ops-empty">No lists yet. Filter People and tap <em>Save as a list</em>, or start one here.</p>}
      <ul className="ops-rows">
        {(lists.data?.lists ?? []).map((l) => (
          <li key={l.id} className="ops-item">
            <Link className="ops-row" to={`/lists/${l.id}`}>
              <span className="ops-row__main">
                <span className="ops-row__name">{l.name}</span>
                <span className="ops-row__sub"><span>{l.kind === 'filter' ? 'Saved filter' : 'Hand-picked'}</span><span>{l.counts.total} {plural(l.counts.total, 'person', 'people')}</span><span>{l.counts.with_email} by email</span><span>{l.counts.with_phone} by text</span></span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Lists() {
  const { id } = useParams();
  if (id === 'new') return <NewList />;
  return id ? <OneList key={id} id={id} /> : <AllLists />;
}
