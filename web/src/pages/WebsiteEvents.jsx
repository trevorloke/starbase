// Website → Events: the campaign's own events (the same ones Outreach →
// Events runs RSVPs for — one events list, not two). Upcoming first; past
// ones fold away. The editor saves through the event actions (cevent.create
// / cevent.update) and the site's picture through site.event.image.
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { ImageField, MarkdownField, Switch, slugify, useSiteRefresh } from '../components/WebsiteBits.jsx';

const pad = (n) => String(n).padStart(2, '0');
// datetime-local speaks this browser's wall clock; the API wants ISO with an offset.
const toISO = (v) => {
  if (!v) return null;
  const s = v.length === 16 ? `${v}:00` : v.slice(0, 19);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${s}${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
};
const toLocal = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const when = (ts) => new Date(ts).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function EventRow({ e }) {
  return (
    <li className="ops-item">
      <Link className="ops-row ws-row-img" to={`/website/events/${e.id}`}>
        {e.image ? <img className="ws-row-thumb" src={`/media/${e.image}`} alt="" loading="lazy" /> : <span className="ws-row-thumb" aria-hidden="true" />}
        <span className="ops-row__main">
          <span className="ops-row__name">{e.title}</span>
          <span className="ops-row__sub">{when(e.starts_at)} · {e.going} going</span>
        </span>
        <span className="ops-row__end">
          <span className={`chip ${e.public ? 'chip-ok' : 'ops-chip-muted'}`}>{e.public ? 'On the site' : 'Private'}</span>
        </span>
      </Link>
    </li>
  );
}

function EventList() {
  const q = useQuery({ queryKey: ['site-events'], queryFn: () => apiGet('/site/events') });
  const [showPast, setShowPast] = useState(false);
  const now = Date.now();
  const all = q.data?.events ?? [];
  const upcoming = all.filter((e) => new Date(e.ends_at || e.starts_at).getTime() >= now).reverse();
  const past = all.filter((e) => new Date(e.ends_at || e.starts_at).getTime() < now);
  return (
    <>
      <div className="ws-subhead">
        <h2>Events</h2>
        <Link className="btn btn-primary ops-tap" to="/website/events/new">New event</Link>
      </div>
      {noSignal(q) && <NoSignal />}
      {q.isError && !noSignal(q) && <p className="error" role="alert">{q.error.message}</p>}
      {q.isSuccess && !upcoming.length && <p className="ops-empty">No upcoming events.</p>}
      <ul className="ops-rows">{upcoming.map((e) => <EventRow key={e.id} e={e} />)}</ul>
      {past.length > 0 && (
        <div className="ops-foot">
          <button type="button" className="ops-more disclose" aria-expanded={showPast} onClick={() => setShowPast((v) => !v)}>Past · {past.length}</button>
          {showPast && <ul className="ops-rows ops-more-body">{past.map((e) => <EventRow key={e.id} e={e} />)}</ul>}
        </div>
      )}
    </>
  );
}

function EventEditor({ id }) {
  const navigate = useNavigate();
  const refresh = useSiteRefresh();
  const isNew = id === 'new';
  const q = useQuery({ queryKey: ['site-events'], queryFn: () => apiGet('/site/events') });
  const ev = q.data?.events?.find((e) => e.id === id);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const location = useLocation();
  const [saved, setSaved] = useState(Boolean(location.state?.saved));
  const [askDelete, setAskDelete] = useState(false);
  useEffect(() => {
    if (isNew) setF({ title: '', starts: '', ends: '', location: '', description: '', image: null, public: true });
    else if (ev) setF({ title: ev.title, starts: toLocal(ev.starts_at), ends: toLocal(ev.ends_at), location: ev.location || '', description: ev.description || '', image: ev.image, public: ev.public });
  }, [isNew, ev]);
  if (noSignal(q)) return <NoSignal />;
  if (q.isSuccess && !isNew && !ev) return <p className="ops-empty">This event is gone. <Link to="/website/events">Events</Link></p>;
  if (!f) return <p className="muted">Loading…</p>;
  const set = (k) => (v) => { setSaved(false); setF((x) => ({ ...x, [k]: v })); };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const starts = toISO(f.starts);
    if (!starts) { setError('Pick a start date and time.'); return; }
    const ends = f.ends ? toISO(f.ends) : null;
    if (ends && new Date(ends) <= new Date(starts)) { setError('The end has to be after the start.'); return; }
    setBusy(true);
    try {
      let eventId = id;
      const fields = { title: f.title.trim(), description: f.description, location: f.location.trim(), starts_at: starts, public: !!f.public };
      if (isNew) {
        // The RSVP link is made from the title; a taken one gets -2, -3 …
        const base = slugify(f.title).slice(0, 52) || 'event';
        for (let n = 1; n < 20; n += 1) {
          try {
            const res = await action('cevent.create', { ...fields, slug: n === 1 ? base : `${base}-${n}`, ...(ends ? { ends_at: ends } : {}) });
            eventId = res.event.id;
            break;
          } catch (err) {
            if (err.status !== 409) throw err;
          }
        }
      } else {
        await action('cevent.update', { id, ...fields, ends_at: ends });
      }
      if (isNew ? f.image : f.image !== ev.image) await action('site.event.image', { event_id: eventId, image: f.image || null });
      await refresh();
      setSaved(true);
      if (isNew) navigate(`/website/events/${eventId}`, { replace: true, state: { saved: true } });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    try {
      await action('cevent.delete', { id });
      await refresh();
      navigate('/website/events');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="ws-editor" onSubmit={submit}>
      <Link className="ops-back" to="/website/events">← Events</Link>
      <div className="field">
        <label htmlFor="ev-title">Title</label>
        <input id="ev-title" className="input ws-title-input" required maxLength={300} value={f.title} autoFocus={isNew}
          onChange={(e) => set('title')(e.target.value)} placeholder="Town hall" />
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ev-starts">Starts</label>
          <input id="ev-starts" className="input mono" type="datetime-local" required value={f.starts} onChange={(e) => set('starts')(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ev-ends">Ends</label>
          <input id="ev-ends" className="input mono" type="datetime-local" value={f.ends} min={f.starts || undefined} onChange={(e) => set('ends')(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="ev-loc">Place and address</label>
        <input id="ev-loc" className="input" maxLength={400} value={f.location} onChange={(e) => set('location')(e.target.value)} placeholder="Name of the place, street address" />
      </div>
      <MarkdownField id="ev-desc" label="Description" rows={6} value={f.description} onChange={set('description')} />
      <ImageField label="Picture" value={f.image} onChange={set('image')} wide />
      <Switch label="On the website (public RSVP page)" checked={!!f.public} onChange={set('public')} />
      {!isNew && ev && <p className="ops-meta">RSVP page: /e/{q.data.ws_slug}/{ev.slug} · {ev.going} going</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ws-save-row">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy || !f.title.trim() || !f.starts}>{busy ? 'Saving…' : 'Save'}</button>
        {saved && <span className="ops-done" role="status">Saved</span>}
        <span className="spacer" />
        {!isNew && (askDelete ? (
          <span className="ops-confirm"><span>Delete this event?</span>
            <button type="button" className="btn ops-danger ops-tap" disabled={busy} onClick={del}>Yes</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => setAskDelete(false)}>No</button>
          </span>
        ) : <button type="button" className="btn btn-quiet ops-tap ws-del" onClick={() => setAskDelete(true)}>Delete</button>)}
      </div>
    </form>
  );
}

export default function WebsiteEvents({ id }) {
  return id ? <EventEditor key={id} id={id} /> : <EventList />;
}
