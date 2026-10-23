// Website → Team: the people on the site's Team page (candidates and team).
// A row per person with their photo and role; the editor has name, role,
// photo, short bio and Published. Social links and the order sit under
// "More details".
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet, initials } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { ConfirmDelete, ImageField, Switch, useSave } from '../components/WebsiteBits.jsx';

export const SOCIALS = [['instagram', 'Instagram'], ['x', 'X'], ['tiktok', 'TikTok'], ['reddit', 'Reddit'], ['facebook', 'Facebook'], ['youtube', 'YouTube']];

function TeamList() {
  const q = useQuery({ queryKey: ['site-team'], queryFn: () => apiGet('/site/team') });
  const team = q.data?.team ?? [];
  return (
    <>
      <div className="ws-subhead">
        <h2>Team</h2>
        <Link className="btn btn-primary ops-tap" to="/website/team/new">Add person</Link>
      </div>
      {noSignal(q) && <NoSignal />}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {q.isSuccess && !team.length && <p className="ops-empty">No one on the team page yet.</p>}
      <ul className="ops-rows">
        {team.map((t) => (
          <li key={t.id} className="ops-item">
            <Link className="ops-row ws-row-img" to={`/website/team/${t.id}`}>
              {t.photo ? <img className="ws-row-thumb is-round" src={`/media/${t.photo}`} alt="" loading="lazy" />
                : <span className="ws-row-thumb is-round ws-initials" aria-hidden="true">{initials(t.name)}</span>}
              <span className="ops-row__main">
                <span className="ops-row__name">{t.name}</span>
                {t.role && <span className="ops-row__sub">{t.role}</span>}
              </span>
              <span className="ops-row__end">
                <span className={`chip ${t.published ? 'chip-ok' : 'ops-chip-muted'}`}>{t.published ? 'Published' : 'Hidden'}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function MemberEditor({ id }) {
  const navigate = useNavigate();
  const isNew = id === 'new';
  const q = useQuery({ queryKey: ['site-team'], queryFn: () => apiGet('/site/team') });
  const cur = q.data?.team?.find((t) => t.id === id);
  const [f, setF] = useState(null);
  const [more, setMore] = useState(false);
  const save = useSave();
  useEffect(() => {
    if (isNew) setF({ name: '', role: '', bio: '', photo: null, socials: {}, position: (q.data?.team?.length || 0) + 1, published: true });
    else if (cur) setF({ ...cur });
  }, [isNew, cur, q.data]);
  if (noSignal(q)) return <NoSignal />;
  if (q.isSuccess && !isNew && !cur) return <p className="ops-empty">This person is gone. <Link to="/website/team">Team</Link></p>;
  if (!f) return <p className="muted">Loading…</p>;
  const set = (k) => (v) => { save.clearSaved(); setF((x) => ({ ...x, [k]: v })); };

  const submit = async (e) => {
    e.preventDefault();
    const input = {
      name: f.name.trim(), role: f.role.trim(), bio: f.bio.trim(), photo: f.photo || null,
      socials: Object.fromEntries(SOCIALS.map(([k]) => [k, (f.socials[k] || '').trim()])), position: Number(f.position) || 0, published: !!f.published,
    };
    if (!isNew) input.id = id;
    const res = await save.run('site.team.save', input);
    if (res && isNew) navigate(`/website/team/${res.member.id}`, { replace: true, state: { saved: true } });
  };
  const del = async () => {
    if (await save.run('site.team.delete', { id })) navigate('/website/team');
  };

  return (
    <form className="ws-editor" onSubmit={submit}>
      <Link className="ops-back" to="/website/team">← Team</Link>
      <div className="form-row">
        <div className="field">
          <label htmlFor="tm-name">Name</label>
          <input id="tm-name" className="input" required maxLength={120} value={f.name} autoFocus={isNew} onChange={(e) => set('name')(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tm-role">Role</label>
          <input id="tm-role" className="input" maxLength={80} value={f.role} onChange={(e) => set('role')(e.target.value)} placeholder="Council candidate" />
        </div>
      </div>
      <ImageField label="Photo" value={f.photo} onChange={set('photo')} />
      <div className="field">
        <label htmlFor="tm-bio">Short bio</label>
        <textarea id="tm-bio" className="input" rows={4} maxLength={1200} value={f.bio} onChange={(e) => set('bio')(e.target.value)} />
      </div>
      <Switch label="Published" checked={!!f.published} onChange={set('published')} />
      <button type="button" className="ot-more disclose disclose--inline ws-more" aria-expanded={more} onClick={() => setMore((v) => !v)}>More details</button>
      {more && (
        <div className="ws-more-body">
          <div className="ws-socials">
            {SOCIALS.map(([k, label]) => (
              <div className="field" key={k}>
                <label htmlFor={`tm-${k}`}>{label}</label>
                <input id={`tm-${k}`} className="input" type="url" inputMode="url" placeholder="https://" value={f.socials[k] || ''}
                  onChange={(e) => set('socials')({ ...f.socials, [k]: e.target.value })} />
              </div>
            ))}
          </div>
          <div className="field ws-narrow-field">
            <label htmlFor="tm-pos">Order</label>
            <input id="tm-pos" className="input mono" inputMode="numeric" value={f.position} onChange={(e) => set('position')(e.target.value.replace(/[^\d]/g, ''))} />
            <span className="ops-meta">Lower comes first.</span>
          </div>
        </div>
      )}
      {save.error && <p className="error" role="alert">{save.error}</p>}
      <div className="ws-save-row">
        <button type="submit" className="btn btn-primary ops-tap" disabled={save.busy || !f.name.trim()}>{save.busy ? 'Saving…' : 'Save'}</button>
        {save.saved && <span className="ops-done" role="status">Saved</span>}
        <span className="spacer" />
        {!isNew && <ConfirmDelete what={f.name || 'this person'} onYes={del} busy={save.busy} />}
      </div>
    </form>
  );
}

export default function WebsiteTeam({ id }) {
  return id ? <MemberEditor key={id} id={id} /> : <TeamList />;
}
