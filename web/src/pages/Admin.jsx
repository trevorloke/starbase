// Settings (managers, in the admin): Members · Teams · Permissions.
//   Members      invite, roles, remove — the Team screen (Team.jsx), as it was
//   Teams        groups of members (a neighbourhood crew, the phone bank):
//                make one, put people on it, name a lead; a team can be put
//                on a turf in one go (Map → turf → Add a canvasser)
//   Permissions  the areas each role has, and one person's own grants and
//                denies on top (lib/perms.js on the server decides)
import { useMemo, useState } from 'react';
import { NavLink, Navigate, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import { NoSignal, noSignal, useOnline, NeedsSignalLine } from '../components/NoSignal.jsx';
import Team from './Team.jsx';
import './outreach.css';
import './website.css';
import './admin.css';

const TABS = [['members', 'Members'], ['teams', 'Teams'], ['permissions', 'Permissions']];
const ROLE_WORD = { manager: 'Manager', treasurer: 'Treasurer', staff: 'Staff', volunteer: 'Volunteer' };

export default function Admin() {
  const { me } = useOutletContext();
  const { tab = 'members' } = useParams();
  if (me.role !== 'manager') return <Navigate to="/" replace />;
  if (!TABS.some(([t]) => t === tab)) return <Navigate to="/settings" replace />;
  return (
    <div className="ws-page">
      <div className="ops-head"><h1>Settings</h1></div>
      <nav className="ws-tabs" aria-label="Settings">
        {TABS.map(([t, label]) => (
          <NavLink key={t} to={t === 'members' ? '/settings' : `/settings/${t}`} end className="ws-tab">{label}</NavLink>
        ))}
      </nav>
      {tab === 'members' && <Team embedded />}
      {tab === 'teams' && <Teams me={me} />}
      {tab === 'permissions' && <Permissions me={me} />}
    </div>
  );
}

// ── Teams ──
function Teams({ me }) {
  const qc = useQueryClient();
  const online = useOnline();
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => apiGet('/teams') });
  const members = useQuery({ queryKey: ['team'], queryFn: () => apiGet('/team') });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (act, input) => {
    setBusy(true); setError(null);
    try {
      await action(act, input);
      await qc.invalidateQueries({ queryKey: ['teams'] });
      return true;
    } catch (e) { setError(e.message); return false; } finally { setBusy(false); }
  };
  const create = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (await run('team.create', { name: name.trim() })) setName('');
  };
  const people = members.data?.members ?? [];
  if (!teams.data) {
    return noSignal(teams) ? <NoSignal /> : teams.isError ? <p className="error">{teams.error.message}</p> : <p className="muted">Loading…</p>;
  }
  return (
    <>
      <form className="ot-invite" onSubmit={create}>
        <label htmlFor="team-name" className="ot-sr">Team name</label>
        <input id="team-name" className="input ot-invite__email" maxLength={80} placeholder="New team, e.g. Newton canvass crew"
          value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn btn-primary ot-btn-tap" disabled={busy || !online || !name.trim()}>Add team</button>
      </form>
      {!online && <NeedsSignalLine>Changing teams needs signal</NeedsSignalLine>}
      {error && <p className="error" role="alert">{error}</p>}
      {teams.data.teams.length === 0 && <p className="muted">No teams yet. A team is a group of members you can put on a turf together.</p>}
      <ul className="ot-list">
        {teams.data.teams.map((t) => (
          <TeamRow key={t.id} team={t} people={people} me={me} online={online} busy={busy} run={run} />
        ))}
      </ul>
    </>
  );
}

function TeamRow({ team, people, me, online, busy, run }) {
  const [pick, setPick] = useState('');
  const [confirming, setConfirming] = useState(false);
  const on = new Set(team.members.map((m) => m.id));
  const options = people.filter((p) => !on.has(p.id));
  const add = async (e) => {
    e.preventDefault();
    if (pick && await run('team.member.add', { team_id: team.id, user_id: pick })) setPick('');
  };
  return (
    <li className="ot-item">
      <div className="ot-row ot-row--static ot-row--wrap">
        <span className="ot-row__main">
          <span className="ot-row__name">{team.name}</span>
          <span className="ot-row__sub">
            {team.members.length} {team.members.length === 1 ? 'person' : 'people'} · {team.lead_user_id ? `Lead: ${team.members.find((m) => m.id === team.lead_user_id)?.name || '—'}` : 'No lead yet'}
          </span>
        </span>
        <span className="ot-actions ot-row__acts">
          {!confirming && (
            <button type="button" className="btn btn-quiet ot-btn-tap" disabled={busy || !online} onClick={() => setConfirming(true)}>Delete</button>
          )}
        </span>
      </div>
      <div className="ot-body">
        {confirming && (
          <div className="ot-confirm ot-confirm-danger" role="group" aria-label={`Delete ${team.name}`}>
            <span>Delete the team {team.name}? Its members stay on the campaign.</span>
            <button type="button" className="btn ot-btn-tap ot-btn-danger" disabled={busy} onClick={() => run('team.delete', { id: team.id })}>Yes, delete</button>
            <button type="button" className="btn btn-quiet ot-btn-tap" disabled={busy} onClick={() => setConfirming(false)}>No</button>
          </div>
        )}
        <ul className="list-plain">
          {team.members.map((m) => (
            <li key={m.id}>
              <span>{m.name} <span className="muted">· {ROLE_WORD[m.role] || m.role}{team.lead_user_id === m.id ? ' · lead' : ''}</span></span>
              <span className="ot-actions">
                {team.lead_user_id !== m.id && (
                  <button type="button" className="btn btn-quiet ot-btn-tap" disabled={busy || !online}
                    onClick={() => run('team.update', { id: team.id, lead_user_id: m.id })}>Make lead</button>
                )}
                <button type="button" className="btn btn-quiet ot-btn-tap" disabled={busy || !online}
                  onClick={() => run('team.member.remove', { team_id: team.id, user_id: m.id })}>Take off</button>
              </span>
            </li>
          ))}
          {team.members.length === 0 && <li className="muted">Nobody on it yet.</li>}
        </ul>
        <form className="turf-assign ot-invite" onSubmit={add}>
          <label htmlFor={`team-add-${team.id}`} className="ot-sr">Add a member to {team.name}</label>
          <select id={`team-add-${team.id}`} className="input ot-invite__email" value={pick} disabled={busy || !online || !options.length}
            onChange={(e) => setPick(e.target.value)}>
            <option value="">{options.length ? 'Add a member…' : 'Everyone is on it'}</option>
            {options.map((p) => <option key={p.id} value={p.id}>{p.name} · {ROLE_WORD[p.role] || p.role}</option>)}
          </select>
          <button type="submit" className="btn ot-btn-tap" disabled={busy || !online || !pick}>Add</button>
        </form>
      </div>
    </li>
  );
}

// ── Permissions ──
function Permissions({ me }) {
  const qc = useQueryClient();
  const online = useOnline();
  const q = useQuery({ queryKey: ['admin-permissions'], queryFn: () => apiGet('/admin/permissions') });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [who, setWho] = useState('');
  const run = async (act, input) => {
    setBusy(true); setError(null);
    try {
      await action(act, input);
      await qc.invalidateQueries({ queryKey: ['admin-permissions'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const d = q.data;
  const member = useMemo(() => d?.members.find((m) => m.id === who) || null, [d, who]);
  if (!d) {
    return noSignal(q) ? <NoSignal /> : q.isError ? <p className="error">{q.error.message}</p> : <p className="muted">Loading…</p>;
  }
  // What a role has now: its base, plus grants, minus denies.
  const roleHas = (role, key) => {
    const r = d.roles[role];
    if (r.deny.includes(key)) return false;
    if (r.grant.includes(key)) return true;
    return r.base.includes(key);
  };
  const toggleRole = (role, key) => {
    const r = d.roles[role];
    const want = !roleHas(role, key);
    const base = r.base.includes(key);
    const grant = r.grant.filter((k) => k !== key); const deny = r.deny.filter((k) => k !== key);
    if (want && !base) grant.push(key);
    if (!want && base) deny.push(key);
    return run('permission.role.set', { role, grant, deny });
  };
  const toggleMember = (m, key) => {
    const want = !m.areas.includes(key);
    const asRole = roleHas(m.role, key);
    const grant = m.grant.filter((k) => k !== key); const deny = m.deny.filter((k) => k !== key);
    if (want && !asRole) grant.push(key);
    if (!want && asRole) deny.push(key);
    return run('permission.member.set', { user_id: m.id, grant, deny });
  };
  return (
    <>
      {!online && <NeedsSignalLine>Changing permissions needs signal</NeedsSignalLine>}
      {error && <p className="error" role="alert">{error}</p>}
      <h2 className="ot-sec-h">By role</h2>
      <p className="muted">Managers have every area. Tick an area to give it to everyone in a role; untick to take it away.</p>
      <div className="adm-scroll">
        <table className="adm-grid">
          <thead>
            <tr><th scope="col">Area</th>{['treasurer', 'staff', 'volunteer'].map((r) => <th key={r} scope="col">{ROLE_WORD[r]}</th>)}</tr>
          </thead>
          <tbody>
            {d.areas.map((a) => (
              <tr key={a.key}>
                <th scope="row"><span>{a.label}</span><span className="muted adm-what">{a.what}</span></th>
                {['treasurer', 'staff', 'volunteer'].map((r) => (
                  <td key={r}>
                    <input type="checkbox" aria-label={`${a.label} for ${ROLE_WORD[r]}`} checked={roleHas(r, a.key)}
                      disabled={busy || !online} onChange={() => toggleRole(r, a.key)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="ot-sec-h">One person</h2>
      <p className="muted">On top of their role: give someone an extra area, or take one away from them alone.</p>
      <div className="field">
        <label htmlFor="adm-who">Member</label>
        <select id="adm-who" className="input" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Choose a member…</option>
          {d.members.filter((m) => m.role !== 'manager').map((m) => <option key={m.id} value={m.id}>{m.name} · {ROLE_WORD[m.role]}</option>)}
        </select>
      </div>
      {member && (
        <ul className="adm-areas" aria-label={`Areas for ${member.name}`}>
          {d.areas.map((a) => {
            const has = member.areas.includes(a.key);
            const asRole = roleHas(member.role, a.key);
            return (
              <li key={a.key}>
                <label className="ot-check">
                  <input type="checkbox" checked={has} disabled={busy || !online} onChange={() => toggleMember(member, a.key)} />
                  <span>{a.label}{has !== asRole ? <span className="chip chip-warn adm-chip">{has ? 'extra' : 'taken away'}</span> : null}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {member && (member.grant.length > 0 || member.deny.length > 0) && (
        <button type="button" className="btn btn-quiet ot-btn-tap" disabled={busy || !online}
          onClick={() => run('permission.member.set', { user_id: member.id, grant: [], deny: [] })}>As their role</button>
      )}
    </>
  );
}
