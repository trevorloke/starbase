// Members — the organization's roll, fed by the website's join form. Who is
// a member, until when, who may vote at member meetings, who still owes the
// fee (it's a pledge on Donations until it's paid). A row opens the
// person; Cancel and Mark active are the desk's hand on a membership.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { useAction } from './People.jsx';
import './shifts.css';
import './members.css';

const FILTERS = [['', 'Current'], ['expired', 'Expired'], ['cancelled', 'Cancelled'], ['all', 'All']];
const WORD = { active: 'Member', pending_payment: 'Fee owing', expired: 'Expired', cancelled: 'Cancelled' };
const CHIP = { active: 'chip chip-ok', pending_payment: 'chip chip-warn', expired: 'chip ops-chip-muted', cancelled: 'chip ops-chip-muted' };
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

// The chip on a profile: "Member · until Oct 28, 2027" (desk only).
export function MemberChip({ personId, desk }) {
  const q = useQuery({ queryKey: ['membership', personId], queryFn: () => apiGet(`/membership?person=${personId}`), enabled: !!desk && !!personId });
  const m = q.data?.members?.find((x) => x.status === 'active') || q.data?.members?.find((x) => x.status === 'pending_payment');
  if (!m) return null;
  return (
    <Link className={`${CHIP[m.status]} mb-chip`} to="/members" title={m.voting_eligible ? 'May vote at member meetings' : 'Lives outside Surrey: no vote at member meetings'}>
      {WORD[m.status]}{m.status === 'active' && m.expires_at ? ` · until ${fmtDay(m.expires_at)}` : ''}
    </Link>
  );
}

export default function Members() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['membership', 'list', filter, q],
    queryFn: () => apiGet(`/membership?status=${filter}&q=${encodeURIComponent(q.trim())}`),
  });
  const act = useAction(() => queryClient.invalidateQueries({ queryKey: ['membership'] }), { needsSignal: true });
  const counts = list.data?.counts;
  const members = list.data?.members ?? [];
  const [asking, setAsking] = useState(null);
  const set = async (m, status) => { setAsking(null); await act.run('member.set', { id: m.id, status }); };

  return (
    <div className="ops-page">
      <div className="ops-head"><h1>Members</h1></div>
      {counts && (
        <div className="mb-counts" role="list" aria-label="Counts">
          <span role="listitem"><strong className="mono">{counts.active}</strong> {plural(counts.active, 'member')}</span>
          <span role="listitem"><strong className="mono">{counts.voting}</strong> voting</span>
          {counts.pending_payment > 0 && <span role="listitem"><strong className="mono">{counts.pending_payment}</strong> fee owing</span>}
          {counts.expired > 0 && <span role="listitem"><strong className="mono">{counts.expired}</strong> expired</span>}
        </div>
      )}
      <div className="mb-tools">
        <div className="mb-filters" role="group" aria-label="Show">
          {FILTERS.map(([k, l]) => (
            <button key={k} type="button" className={`chip mb-filter${filter === k ? ' is-on' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <input className="input mb-search" type="search" placeholder="Name or email" aria-label="Search members" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {noSignal(list) && <NoSignal />}
      {list.isError && !noSignal(list) && <p className="error" role="alert">{list.error.message}</p>}
      {act.error && <p className="error" role="alert">{act.error}</p>}
      {list.isSuccess && !members.length && <p className="ops-empty">{q ? 'No one by that name.' : 'No members yet — the website’s join form fills this in.'}</p>}
      <ul className="ops-rows">
        {members.map((m) => (
          <li key={m.id} className="ops-item">
            <div className="ops-row ops-row--static ops-row--wrap">
              <Link className="ops-row__main mb-link" to={`/people/${m.person_id}`}>
                <span className="ops-row__name">{m.name}</span>
                <span className="ops-row__sub">
                  {m.details?.neighbourhood && <span>{m.details.neighbourhood}</span>}
                  {m.email && <span>{m.email}</span>}
                  {m.status === 'active' && m.expires_at && <span>until {fmtDay(m.expires_at)}</span>}
                  {m.status === 'active' && !m.voting_eligible && <span>no vote (outside Surrey)</span>}
                  {m.status === 'pending_payment' && <span>joined {fmtDay(m.created_at)}</span>}
                </span>
              </Link>
              <span className="ops-row__end mb-end">
                <span className={CHIP[m.status]}>{WORD[m.status]}</span>
                {asking === m.id ? (
                  <span className="ops-confirm">
                    <span>Cancel this membership?</span>
                    <button type="button" className="btn ops-danger ops-tap" disabled={act.busy} onClick={() => set(m, 'cancelled')}>Yes</button>
                    <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAsking(null)}>No</button>
                  </span>
                ) : m.status === 'active' || m.status === 'pending_payment' ? (
                  <button type="button" className="btn btn-quiet ops-tap" disabled={act.busy} onClick={() => setAsking(m.id)}>Cancel</button>
                ) : (
                  <button type="button" className="btn btn-quiet ops-tap" disabled={act.busy} onClick={() => set(m, 'active')}>Mark active</button>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
