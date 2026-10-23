// Relationships on other screens — who knows whom.
//
//   KINDS, kindWord(code)        Family · Friend · Neighbour · Work · Community · Other
//   useMyPeople(me)              GET /relationships/mine, kept on this phone for a day
//                                (query key ['persons', 'mine']: every write that
//                                changes people refetches it)
//   <MyPeopleLink me />          Calls' quiet "My people · 6" (→ /my-people)
//   usePersonKnows(id, desk)     a profile's Knows (desk only; kept for no
//                                signal like the profile — KeptCopies.js)
//   <KnowsNudge query person />  "Ask Priya Nair — they know each other": one line
//                                on the profile of someone undecided or not rated
//                                (never someone tagged do-not-contact); and "May
//                                be the same person as …" when a volunteer's add
//                                may have doubled someone (same email or name)
//   <PersonKnows person query /> the Knows section: who they know (name, kind ·
//                                note, rating), "Brought in by", "+ Someone they
//                                know" (search the list, then how they know each
//                                other), and Remove? Yes · No in place — both
//                                need signal, and say so
//   linkWords(link)              "Neighbour · Same block": the kind, and the note
// No pronouns are guessed from names: the words never need one.
import { Fragment, useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import { RatingChip } from './RatingButtons.jsx';
import { phoneCopy, useKeepCopy } from './OfflineCache.js';
import { NeedsSignal, NoSignal, noSignal, useOnline } from './NoSignal.jsx';
import '../pages/relationships.css';

export const KINDS = [
  { code: 'family', label: 'Family' },
  { code: 'friend', label: 'Friend' },
  { code: 'neighbour', label: 'Neighbour' },
  { code: 'work', label: 'Work' },
  { code: 'community', label: 'Community' },
  { code: 'other', label: 'Other' },
];
export const kindWord = (code) => KINDS.find((k) => k.code === code)?.label || 'Other';
export const linkWords = (link) => [kindWord(link?.kind), String(link?.note || '').trim()].filter(Boolean).join(' · ');

export const MINE_KEY = ['persons', 'mine'];
const MINE_COPY = 'my-people';

export function useMyPeople(me) {
  const q = useQuery({
    queryKey: MINE_KEY,
    queryFn: () => apiGet('/relationships/mine'),
    // The phone's copy stands in for no signal only: it counts as old, so
    // with signal the server is always asked first (a removal elsewhere).
    ...phoneCopy(me, MINE_COPY),
    initialDataUpdatedAt: 0,
  });
  useKeepCopy(me, MINE_COPY, q);
  return q;
}

export function MyPeopleLink({ me }) {
  const location = useLocation();
  const n = useMyPeople(me).data?.people?.length || 0;
  const label = location.pathname === '/calls' && new URLSearchParams(location.search).get('channel') === 'text' ? 'Texts' : 'Calls';
  return (
    <Link className="rel-link" to="/my-people" state={{ from: { to: `${location.pathname}${location.search}`, label } }}>
      My people{n ? <> · <span className="mono">{n}</span></> : null}
    </Link>
  );
}

// Every query that shows a link or the people at its ends.
const useRefresh = () => {
  const queryClient = useQueryClient();
  return () => Promise.all(['person', 'persons', 'brief'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
};

function useRun() {
  const refresh = useRefresh();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (name, input) => {
    setBusy(true);
    setError(null);
    try {
      const res = await action(name, input);
      await refresh();
      return res;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error };
}

export const usePersonKnows = (id, desk) => useQuery({
  queryKey: ['person', id, 'knows'],
  queryFn: () => apiGet(`/persons/${id}/knows`),
  enabled: Boolean(id) && Boolean(desk),
});

const undecided = (p) => p && (p.rating == null || p.rating === '3');
const dnc = (p) => Array.isArray(p?.tags) && p.tags.includes('do-not-contact');

export function KnowsNudge({ query, person }) {
  const n = query.data?.nudge;
  const same = query.data?.same_as || [];
  const nudge = n && undecided(person) && !dnc(person);
  if (!nudge && !same.length) return null;
  return (
    <>
      {nudge && (
        <p className="rel-nudge">
          Ask <Link to={`/people/${n.id}`}>{n.name}</Link> — they know each other
        </p>
      )}
      {same.length > 0 && (
        <p className="rel-same">
          May be the same person as{' '}
          {same.map((x, i) => (
            <Fragment key={x.id}>{i ? ', ' : ''}<Link to={`/people/${x.id}`}>{x.name}</Link></Fragment>
          ))}
        </p>
      )}
    </>
  );
}

// Adding a link needs signal (it's a desk write, never saved on the device).
const NEEDS = 'Adding someone they know needs signal';

function AddKnown({ person, known, onClose }) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(null);
  const inputId = useId();
  const act = useRun();
  const online = useOnline();
  const term = q.trim();
  const found = useQuery({
    queryKey: ['persons', 'pick', term],
    queryFn: () => apiGet(`/persons?${new URLSearchParams({ q: term, limit: '12' })}`),
    enabled: term.length >= 2,
    staleTime: 30_000,
  });
  const list = (found.data?.persons || []).filter((p) => p.id !== person.id && !known.has(p.id)).slice(0, 6);
  // No signal: the search can't answer and the link can't go — said once, in place.
  const off = !online || (term.length >= 2 && noSignal(found));
  const add = async (kind) => {
    const res = await act.run('relationship.add', { from_id: person.id, person_id: pick.id, kind });
    if (res) onClose();
  };
  if (pick) {
    return (
      <div className="rel-add">
        <p className="rel-add__q">{pick.name} — how do they know each other?</p>
        <div className="rel-kinds" role="group" aria-label="How they know each other">
          {KINDS.map((k) => (
            <button key={k.code} type="button" className="rel-kind" disabled={act.busy || !online} onClick={() => add(k.code)}>{k.label}</button>
          ))}
        </div>
        {!online ? <NeedsSignal className="pf-empty">{NEEDS}</NeedsSignal> : act.error && <p className="error" role="alert">{act.error}</p>}
        <button type="button" className="btn btn-quiet pp-btn" onClick={() => setPick(null)}>Back</button>
      </div>
    );
  }
  return (
    <div className="rel-add">
      <label className="rel-add__q" htmlFor={inputId}>Who do they know?</label>
      <input id={inputId} className="input" type="search" autoFocus autoComplete="off" placeholder="Search by name"
        value={q} onChange={(e) => setQ(e.target.value)} />
      {off ? <NeedsSignal className="pf-empty">{NEEDS}</NeedsSignal> : list.length > 0 && (
        <ul className="rel-picks">
          {list.map((p) => (
            <li key={p.id}>
              <button type="button" className="rel-pick" onClick={() => setPick(p)}>
                <span className="rel-pick__name">{p.name}</span>
                <RatingChip code={p.rating} who />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!off && term.length >= 2 && found.isSuccess && list.length === 0 && <p className="pf-empty">No one matches.</p>}
      <button type="button" className="btn btn-quiet pp-btn" onClick={onClose}>Cancel</button>
    </div>
  );
}

export function PersonKnows({ person, query }) {
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const act = useRun();
  const online = useOnline();
  // No signal and nothing kept: say so, never a "Loading…" that doesn't end.
  if (noSignal(query)) return <NoSignal />;
  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) return <p className="error">{query.error.message}</p>;
  const { knows = [], brought_in_by: by = null } = query.data || {};
  const known = new Set(knows.map((k) => k.person.id));
  const remove = async (id) => {
    const res = await act.run('relationship.remove', { id });
    if (res) setConfirm(null);
  };
  return (
    <>
      {by && <p className="rel-by">Brought in by <Link to={`/people/${by.id}`}>{by.name}</Link></p>}
      {knows.length === 0 && !adding && <p className="pf-empty">No one yet.</p>}
      {knows.length > 0 && (
        <ul className="rel-knows">
          {knows.map((k) => (
            <li key={k.id}>
              <span className="rel-knows__who">
                <Link to={`/people/${k.person.id}`}>{k.person.name}</Link>
                <span className="rel-knows__kind">{linkWords(k)}</span>
              </span>
              <span className="rel-knows__end">
                <RatingChip code={k.person.rating} who />
                {confirm === k.id ? (
                  <span className="ops-confirm rel-confirm">
                    <span>Remove?</span>
                    <button type="button" className="btn pp-btn" disabled={act.busy || !online} onClick={() => remove(k.id)}>Yes</button>
                    <button type="button" className="btn btn-quiet pp-btn" onClick={() => setConfirm(null)}>No</button>
                  </span>
                ) : (
                  <button type="button" className="btn btn-quiet pp-btn" aria-label={`Remove ${k.person.name}`} disabled={!online} onClick={() => setConfirm(k.id)}>Remove</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {online && act.error && <p className="error" role="alert">{act.error}</p>}
      {adding ? (
        <AddKnown person={person} known={known} onClose={() => setAdding(false)} />
      ) : (
        <div className="pf-row-acts">
          <button type="button" className="btn pp-btn" disabled={!online} onClick={() => setAdding(true)}>+ Someone they know</button>
          {!online && <NeedsSignal className="ops-meta rel-needs">Adding and removing need signal</NeedsSignal>}
        </div>
      )}
    </>
  );
}
