// Person profile. Top: name, rating, donor tier (desk), and Call · Text ·
// Email (desk) · Map. With the campaign's Twilio number connected, Call and
// Text open their card on Calls (the campaign's number, the STOP line, the
// Inbox, quiet hours) — never the phone's own dialler or Messages; Text is
// gone for anyone who opted out of texts. Then the rating card (one tap logs a contact; Call/Text
// set how it is logged, remembered per person for this tab so it survives a
// trip to the dialer). Everything else sits in sections that open on a tap —
// Details (their own note + edit live here), Tags, Roles, Signs, Shifts, Gifts
// and History (open by default). Volunteers see only what a door needs: Details
// (open), the rating card, one "Last contact" line and Signs. Their back link
// returns to wherever they came from (walk list, map, Calls).
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams, useOutletContext, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  VOLUNTEER_ROLES, SOCIAL_PLATFORMS, SUGGESTED_TAGS,
  SIGN_KINDS, SIGN_STATUSES, DONOR_TIERS,
} from '@starbase/shared/canvass';
import { ratingByCode } from '@starbase/shared/scale';
import RatingButtons, { OutcomeButtons, RatingChip, focusRating, ratingSay, ratingText, useScale } from '../components/RatingButtons.jsx';
import SurveyQuestions, { PersonAnswers, answersTail, usePersonAnswers, useSurvey } from '../components/SurveyQuestions.jsx';
import { apiGet, fmtMoney, fmtDate, noAnswer } from '../api.js';
import { EngagementChip, PersonLadders, usePersonLadders } from '../components/LaddersBits.jsx';
import { queuedText, useThisDevice } from '../components/queued.js';
import { PersonFields, filledCount, usePersonFields } from '../components/FieldsBits.jsx';
import { useOutbox, applyOutboxToProfile, pendingAbout, logContact, holdNote } from '../offline.js';
import { useOnline } from '../components/NoSignal.jsx';
import {
  TagEditor, Icon, useAction, fmtWhen, fmtShort, telHref, smsHref, textBody,
  canDesk, invalidatePersonData, isDnc, tagWord, RatingTag, noSignal,
} from './People.jsx';
import './people.css';
import {
  TextingPersonLink, callsCard, noTexts, textingOn, useTextingPerson, useTextingStatus,
} from '../components/TextingCard.jsx';
import { KnowsNudge, PersonKnows, usePersonKnows } from '../components/RelationshipsBits.jsx';

const TIER_LABEL = {
  superstar: DONOR_TIERS.superstar.label,
  star: DONOR_TIERS.star.label,
  monthly: 'Monthly donor',
  'one-time': 'Donor',
};
// Ink, not yellow: the brand yellow is only ever the screen's one primary button.
const TIER_CLASS = { superstar: 'chip pf-tier pf-tier--super', star: 'chip pf-tier', monthly: 'chip chip-ok', 'one-time': 'chip' };

const OUTCOME_LABEL = {
  contacted: 'Talked', no_answer: 'No answer', refused: 'Refused', moved: 'Moved', inaccessible: 'No access',
};
const CHANNEL_LABEL = { door: 'Door', phone: 'Phone', text: 'Text', in_person: 'In person' };
// "Rated 2 · Lean yes", "Rated 4 · Locke" or "No answer" — the field's own words.
const contactWord = (scale, c) => (c.rating ? `Rated ${ratingText(scale, c.rating)}` : OUTCOME_LABEL[c.outcome] || c.outcome);

// How this person is being reached (Door · Phone · Text), per person, kept for
// this tab: a phone may reload the page after the dialer or messages app.
// Until one is picked: Door — except at a desk computer (no dialer), for
// someone with a phone and no door on the map, where it is a phone call.
const CHANNEL_KEY = 'starbase.person.channel';
const readChannels = () => {
  try { return JSON.parse(sessionStorage.getItem(CHANNEL_KEY) || '{}') || {}; } catch { return {}; }
};
const atDeskComputer = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(hover: hover) and (pointer: fine)').matches);
const firstChannel = (person) => (atDeskComputer() && person?.phone && (person.lat == null || person.lng == null) ? 'phone' : 'door');
function useChannel(personId) {
  const [chans, setChans] = useState(readChannels);
  const saved = CHANNEL_LABEL[chans[personId]] ? chans[personId] : null;
  const setChannel = (c) => setChans((m) => {
    const next = { ...m, [personId]: c };
    try { sessionStorage.setItem(CHANNEL_KEY, JSON.stringify(next)); } catch { /* private mode: memory only */ }
    return next;
  });
  return [saved, setChannel];
}
const STATUS_CHIP = {
  assigned: 'chip', confirmed: 'chip chip-ok', declined: 'chip chip-danger', no_show: 'chip chip-danger', completed: 'chip',
  requested: 'chip chip-warn', installed: 'chip chip-ok', removed: 'chip chip-ghost',
};
// The Signs screen's words, for the chip and the switch.
const SIGN_STATUS_WORD = { requested: 'To put up', installed: 'Up', removed: 'Taken down' };
// A request that never went up is taken back (sign.cancel), not "taken down".
const SIGN_CANCEL = 'cancel';
// Most-asked first, like the door card.
const SIGN_ORDER = ['lawn', 'large', 'billboard'];
const SIGN_SHORT = { lawn: 'Lawn', large: 'Large', billboard: 'Billboard' };
const SIGN_BUTTONS = [...SIGN_KINDS].sort((a, b) => SIGN_ORDER.indexOf(a.code) - SIGN_ORDER.indexOf(b.code));

const stripHandle = (h) => String(h || '').trim().replace(/^@/, '');
const isUrl = (h) => /^https?:\/\//i.test(String(h || '').trim());
const SOCIAL_URL = {
  facebook: (h) => `https://facebook.com/${stripHandle(h)}`,
  instagram: (h) => `https://instagram.com/${stripHandle(h)}`,
  x: (h) => `https://x.com/${stripHandle(h)}`,
  tiktok: (h) => `https://tiktok.com/@${stripHandle(h)}`,
  youtube: (h) => `https://youtube.com/@${stripHandle(h)}`,
  linkedin: (h) => `https://linkedin.com/in/${stripHandle(h)}`,
  bluesky: (h) => `https://bsky.app/profile/${stripHandle(h)}`,
  other: (h) => (isUrl(h) ? h.trim() : null),
};
const socialHref = (platform, handle) => (isUrl(handle) ? handle.trim() : SOCIAL_URL[platform]?.(handle) ?? null);
const PLATFORM_LABEL = { x: 'X', tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn', bluesky: 'Bluesky' };
const platformLabel = (p) => PLATFORM_LABEL[p] || p.charAt(0).toUpperCase() + p.slice(1);

// ─────────────────────────────────────────────────────────────────────────────
// A section that opens on a tap. Closed sections aren't rendered at all.
// ─────────────────────────────────────────────────────────────────────────────
function Section({ title, count, open, onToggle, children }) {
  const id = useId();
  return (
    <section className="pf-sec">
      <h2 style={{ margin: 0, fontSize: 'inherit' }}>
        <button type="button" className="pf-sec__btn disclose" aria-expanded={open} aria-controls={id} onClick={onToggle}>
          <span className="pf-sec__title">{title}</span>
          {count != null && count !== '' && <span className="pf-sec__count">{count}</span>}
        </button>
      </h2>
      {open && <div className="pf-sec__body" id={id}>{children}</div>}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Back: to the screen that opened this profile. People and Calls say who they
// are (router state); the door card and walk list just go back in history.
// Desks fall back to People; volunteers, who have no People list, to Today.
// ─────────────────────────────────────────────────────────────────────────────
function BackLink({ desk, className = 'eyebrow pf-back' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from;
  const inApp = location.key !== 'default'; // opened from another Starbase screen
  if (from?.to) {
    return inApp
      ? <button type="button" className={className} onClick={() => navigate(-1)}>← {from.label || 'Back'}</button>
      : <Link to={from.to} className={className}>← {from.label || 'Back'}</Link>;
  }
  if (desk) return <Link to="/people" className={className}>← People</Link>;
  return inApp
    ? <button type="button" className={className} onClick={() => navigate(-1)}>← Back</button>
    : <Link to="/" className={className}>← Today</Link>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Header: name, rating, donor tier, Call · Text · Email · Map
// ─────────────────────────────────────────────────────────────────────────────
function Header({ person, donor, me, desk, onLog, contacted, level }) {
  const texting = useTextingStatus(me);
  // true / false, or null while nobody knows (no signal, nothing kept): then
  // the Calls card, which says so — never a guess at the phone's own apps.
  const on = textingOn(texting);
  const txPerson = useTextingPerson(person.id, Boolean(on.sms && person.phone));
  const canText = Boolean(person.phone) && !noTexts(person) && !txPerson.data?.opted_out;
  const scale = useScale();
  const r = ratingByCode(scale, person.rating);
  const named = r?.band === 'opposed' && r.code !== '4'; // "4 · Locke" says it all
  // The date of the rating only when no contact says it below.
  const when = contacted ? '' : fmtShort(person.rated_at);
  const email = desk && person.email; // volunteers phone and knock; email is desk work
  const tiles = Boolean(person.phone || email);
  const located = person.lat != null && person.lng != null;
  // The donor tier chip already says Donor: the level chip never repeats it
  // ("Donor · Volunteer" → "Volunteer"; just "Donor" → no level chip).
  const tierShown = Boolean(donor?.tier && TIER_LABEL[donor.tier]);
  const shownLevel = level && tierShown && level.code === 'doer'
    ? { ...level, label: level.label.split(' · ').filter((w) => w !== 'Donor').join(' · ') }
    : level;
  return (
    <header className="pf-head">
      <BackLink desk={desk} />
      <h1>
        {person.name}
        {person.kind === 'org' && <> <span className="chip chip-ghost">org</span></>}
      </h1>
      <div className="pf-meta">
        {r && <RatingChip code={person.rating} who />}
        {(!r || !named || when) && (
          <span className="pf-word">
            {r ? <>{!named && ratingSay(scale, person.rating)}{when && <span className="pf-when">{named ? '' : ' · '}{when}</span>}</> : 'Not rated'}
          </span>
        )}
        {isDnc(person) && <span className="chip chip-danger">Do not contact</span>}
        {desk && shownLevel?.label && <EngagementChip level={shownLevel} />}
        {/* donor is null for volunteers (the server hides money from them) */}
        {tierShown && (
          <span className={TIER_CLASS[donor.tier]} title={`${fmtMoney(donor.yearCents)} this year${Number(donor.monthlyCents) ? ` · ${fmtMoney(donor.monthlyCents)}/mo` : ''}`}>
            {TIER_LABEL[donor.tier]}
          </span>
        )}
      </div>
      {(tiles || person.address) && (
        <div className={`pf-acts${tiles ? '' : ' pf-acts--quiet'}`}>
          {person.phone && (on.voice === false ? (
            <a className="btn pf-act" href={telHref(person.phone)} onClick={() => onLog('phone')}>
              <Icon name="phone" /> Call
            </a>
          ) : (
            <Link className="btn pf-act" to={callsCard(person, 'phone')}>
              <Icon name="phone" /> Call
            </Link>
          ))}
          {canText && (on.sms === false ? (
            <a className="btn pf-act" href={smsHref(person.phone, textBody(person, me))} onClick={() => onLog('text')}>
              <Icon name="text" /> Text
            </a>
          ) : (
            <Link className="btn pf-act" to={callsCard(person, 'text')}>
              <Icon name="text" /> Text
            </Link>
          ))}
          {email && (
            <a className="btn pf-act" href={`mailto:${person.email}`}>
              <Icon name="email" /> Email
            </a>
          )}
          {person.address && (
            // Map selects ?person=<id>, and offers to place a pin when there is none
            // (person.locate is open to volunteers too). With no Call or Text
            // it's a quiet link, so the rating card stays the first big thing.
            <Link className={tiles ? 'btn pf-act' : 'btn btn-quiet pp-btn pf-maplink'} to={`/map?person=${person.id}`}
              title={located ? 'On the map' : 'No pin yet — place one on the map'}>
              <Icon name="map" /> {tiles ? 'Map' : located ? 'On the map' : 'Place on map'}
            </Link>
          )}
        </div>
      )}
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rating card: big rating buttons + outcomes → contact.log. The channel is set
// by the Call / Text tiles (else Door); the manual switch sits under the note.
// ─────────────────────────────────────────────────────────────────────────────
function RatingCard({ person, refresh, channel, setChannel, cardRef }) {
  const [note, setNoteState] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  // The note lives in a ref too, so leaving the profile can still send it
  // (as the door card does): a note that goes out with a tap is cleared at
  // once (and put back if it isn't saved), so it's never sent twice.
  const noteRef = useRef('');
  const setNote = (v) => { noteRef.current = v; setNoteState(v); };
  const latest = useRef(null);
  useLayoutEffect(() => { latest.current = { person, channel, refresh }; });
  const sendLeft = () => {
    const text = noteRef.current.trim();
    const ctx = latest.current;
    if (!text || !ctx?.person) return null;
    noteRef.current = '';
    // Through the outbox: with no signal it waits on this device.
    return logContact({ person_id: ctx.person.id, channel: ctx.channel, outcome: 'contacted', note: text }, { who: ctx.person.name })
      .then((r) => { if (!r.queued) ctx.refresh?.(); })
      .catch(() => { /* refused: nothing else to say on a screen that's gone */ });
  };
  // Sign-out sends it first (holdNote), while it's still theirs.
  useEffect(() => holdNote(() => { const sent = sendLeft(); if (sent) { setNoteState(''); setNoteOpen(false); } return sent; }), []);
  useEffect(() => () => { sendLeft(); }, []);
  // { text, what, queued }: the line under the buttons. A knock still in the
  // outbox says so, and the line turns to "✓ Sent" once the outbox empties.
  const [said, setSaid] = useState(null);
  const status = said?.text || '';
  const reachId = useId();
  const act = useAction(refresh);
  const outbox = useOutbox();
  const scale = useScale();
  useEffect(() => {
    if (!said?.queued || outbox.pending > 0 || outbox.flushing) return;
    setSaid(outbox.lastError
      ? { text: outbox.lastError, what: said.what, queued: false }
      : { text: `✓ Sent · ${said.what}`, what: said.what, queued: false });
  }, [said, outbox.pending, outbox.flushing, outbox.lastError]);
  // Contacts are kept as they were logged: "Change" (as on the field toasts)
  // brings you back to the rating row, and the next tap logs the fix.
  const change = () => { setSaid(null); focusRating(cardRef.current); };
  // The active survey's questions (door, or calls when reached by phone/text).
  const survey = useSurvey({ context: channel === 'door' ? 'door' : 'calls', personId: person.id, lat: person.lat, lng: person.lng });

  const log = async (outcome, rating) => {
    const answers = outcome === 'contacted' ? survey.take() : [];
    // After "Save answers" the next tap finishes that same contact.
    const visitOf = survey.visitOf(channel);
    const sentNote = noteRef.current.trim();
    if (sentNote) noteRef.current = '';
    const res = await act.run('contact.log', {
      person_id: person.id, channel, outcome, rating: rating || undefined, note: sentNote || undefined,
      answers: answers.length ? answers : undefined, visit_of: visitOf,
    }, { who: person.name });
    if (!res) { survey.restore(answers); if (sentNote) setNote(note); }
    if (res) {
      survey.logged(res, { channel, outcome, rating, answers, visitOf });
      setNote('');
      setNoteOpen(false);
      // Not reached yet: the door card's words ("Saved on this phone — sends soon").
      const what = `${CHANNEL_LABEL[channel]} · ${contactWord(scale, { rating, outcome })}${answersTail(answers, res.result)}`;
      setSaid({ text: res.queued ? `${queuedText(res)} · ${what}` : `✓ ${what}`, what, queued: Boolean(res.queued) });
    }
  };

  return (
    <section className="card pf-rate" ref={cardRef} aria-label="Rate">
      <RatingButtons value={person.rating} onPick={(code) => log('contacted', code)} disabled={act.busy} />
      <OutcomeButtons onPick={(o) => log(o)} disabled={act.busy} />
      <SurveyQuestions key={`questions-${person.id}`} survey={survey} disabled={act.busy} onSave={() => log('contacted')} />
      <div className="pf-rate__foot">
        {noteOpen ? (
          <div className="field pf-note">
            <label htmlFor="contact-note">Note — saved with your next tap</label>
            <input id="contact-note" className="input" autoFocus maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Wants a lawn sign" />
          </div>
        ) : (
          <button type="button" className="btn btn-quiet pp-btn pf-note-btn" onClick={() => setNoteOpen(true)}>+ Add a note</button>
        )}
        <div className="pf-reach">
          <span className="eyebrow" id={reachId}>Reached by</span>
          <div className="channel-toggle pf-channel" role="group" aria-labelledby={reachId}>
            {['door', 'phone', 'text'].map((c) => (
              <button key={c} type="button" aria-pressed={channel === c} onClick={() => setChannel(c)}>{CHANNEL_LABEL[c]}</button>
            ))}
          </div>
        </div>
      </div>
      {act.error ? <p className="error" role="alert">{act.error}</p> : (
        <div className="pf-status-row">
          <p className="pf-status" role="status">{status}</p>
          {status && <button type="button" className="btn btn-quiet pp-btn pf-change" onClick={change}>Change</button>}
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Details: contact lines, socials, household, and Edit
// ─────────────────────────────────────────────────────────────────────────────
function EditDetailsForm({ person, refresh, onClose }) {
  const [form, setForm] = useState({
    name: person.name || '', kind: person.kind || 'person', phone: person.phone || '', email: person.email || '',
    address: person.address || '', unit: person.unit || '', city: person.city || '', postal: person.postal || '',
  });
  const act = useAction(refresh, { needsSignal: true });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const v = (s) => (s && s.trim() ? s.trim() : null);

  const submit = async (e) => {
    e.preventDefault();
    const res = await act.run('person.update', {
      id: person.id,
      name: form.name.trim(),
      kind: form.kind,
      phone: v(form.phone), email: v(form.email),
      address: v(form.address), unit: v(form.unit), city: v(form.city), postal: v(form.postal),
    });
    if (res) onClose();
  };

  return (
    <form className="inline-form" onSubmit={submit}>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ed-name">Name</label>
          <input id="ed-name" className="input" required maxLength={300} value={form.name} onChange={set('name')} />
        </div>
        <div className="field" style={{ flex: '0 1 150px' }}>
          <label htmlFor="ed-kind">Kind</label>
          <select id="ed-kind" className="input" value={form.kind} onChange={set('kind')}>
            <option value="person">Person</option>
            <option value="org">Organization</option>
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="ed-phone">Phone</label>
          <input id="ed-phone" className="input mono" type="tel" inputMode="tel" maxLength={40} value={form.phone} onChange={set('phone')} />
        </div>
        <div className="field">
          <label htmlFor="ed-email">Email</label>
          <input id="ed-email" className="input" type="email" maxLength={320} value={form.email} onChange={set('email')} />
        </div>
      </div>
      <div className="form-row">
        <div className="field" style={{ flex: '2 1 200px' }}>
          <label htmlFor="ed-address">Street address</label>
          <input id="ed-address" className="input" maxLength={1000} value={form.address} onChange={set('address')} />
        </div>
        <div className="field" style={{ flex: '0 1 90px' }}>
          <label htmlFor="ed-unit">Unit</label>
          <input id="ed-unit" className="input" maxLength={40} value={form.unit} onChange={set('unit')} />
        </div>
        <div className="field">
          <label htmlFor="ed-city">City</label>
          <input id="ed-city" className="input" maxLength={120} value={form.city} onChange={set('city')} />
        </div>
        <div className="field" style={{ flex: '0 1 120px' }}>
          <label htmlFor="ed-postal">Postal</label>
          <input id="ed-postal" className="input mono" maxLength={20} value={form.postal} onChange={set('postal')} />
        </div>
      </div>
      {act.error && <p className="error">{act.error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary pp-btn" disabled={act.busy}>Save</button>
        <button type="button" className="btn btn-quiet pp-btn" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

// The server's socials schema is a partial record keyed ONLY by
// SOCIAL_PLATFORMS (zod rejects any other key with "Unrecognized key"), values
// strings ≤300. Send only known, non-empty keys so one stray legacy key on
// file can't make every save fail.
const cleanSocials = (s) => Object.fromEntries(
  SOCIAL_PLATFORMS
    .filter((p) => typeof s?.[p] === 'string' && s[p].trim())
    .map((p) => [p, s[p].trim().slice(0, 300)]),
);

function Socials({ person, refresh, desk }) {
  const [platform, setPlatform] = useState('instagram');
  const [handle, setHandle] = useState('');
  const [adding, setAdding] = useState(false);
  const act = useAction(refresh, { needsSignal: true });
  const socials = cleanSocials(person.socials);
  const entries = Object.entries(socials);

  const save = async (next) => act.run('person.update', { id: person.id, socials: cleanSocials(next) });
  const add = async (e) => {
    e.preventDefault();
    const h = handle.trim();
    if (!h) return;
    const res = await save({ ...socials, [platform]: h });
    if (res) { setHandle(''); setAdding(false); }
  };
  const remove = (p) => {
    const next = { ...socials };
    delete next[p];
    save(next);
  };

  if (!entries.length && !desk) return null;
  return (
    <>
      <div className="card-head pf-sub">
        <span className="eyebrow">Socials</span>
        {desk && (
          <button type="button" className="btn btn-quiet pp-btn" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Close' : '+ Add'}
          </button>
        )}
      </div>
      {entries.length > 0 && (
        <ul className="contact-lines">
          {entries.map(([p, h]) => {
            const href = socialHref(p, h);
            return (
              <li key={p}>
                <span className="k">{platformLabel(p)}</span>
                <span className="v">
                  {href ? <a href={href} target="_blank" rel="noopener noreferrer">{h}</a> : h}
                </span>
                {desk && (
                  <span className="act">
                    <button type="button" className="chip-x" aria-label={`Remove ${platformLabel(p)}`} disabled={act.busy} onClick={() => remove(p)}>×</button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {desk && adding && (
        <form className="socials-add" onSubmit={add}>
          <div className="field">
            <label htmlFor="soc-platform">Platform</label>
            <select id="soc-platform" className="input" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {SOCIAL_PLATFORMS.map((p) => <option key={p} value={p}>{platformLabel(p)}</option>)}
            </select>
          </div>
          <div className="field wide">
            <label htmlFor="soc-handle">Handle or link</label>
            <input id="soc-handle" className="input" autoFocus maxLength={300} value={handle} onChange={(e) => setHandle(e.target.value)}
              placeholder={platform === 'other' ? 'https://…' : '@handle'} />
          </div>
          <button type="submit" className="btn pp-btn" disabled={act.busy || !handle.trim()}>Save</button>
        </form>
      )}
      {act.error && <p className="error">{act.error}</p>}
    </>
  );
}

function Details({ person, household, refresh, desk, me }) {
  const [editing, setEditing] = useState(false);
  // The number dials from your own phone only when calls through the campaign are off.
  const ownDialler = textingOn(useTextingStatus(me)).voice === false;
  if (desk && editing) return <EditDetailsForm person={person} refresh={refresh} onClose={() => setEditing(false)} />;
  const addr = [
    [person.address, person.unit ? `#${person.unit}` : null].filter(Boolean).join(' '),
    [person.city, person.postal].filter(Boolean).join('  '),
  ].filter(Boolean);
  const none = <span className="muted">—</span>;

  return (
    <>
      <ul className="contact-lines">
        <li>
          <span className="k">Phone</span>
          <span className="v">{person.phone
            ? (ownDialler ? <a className="mono" href={telHref(person.phone)}>{person.phone}</a> : <span className="mono">{person.phone}</span>)
            : none}</span>
        </li>
        {desk && (
          <li>
            <span className="k">Email</span>
            <span className="v">{person.email ? <a href={`mailto:${person.email}`}>{person.email}</a> : none}</span>
          </li>
        )}
        <li>
          <span className="k">Address</span>
          <span className="v addr-lines">{addr.length ? addr.map((l, i) => <div key={i}>{l}</div>) : none}</span>
          {person.address && (
            <span className="act">
              <Link className="btn btn-quiet pp-btn" to={`/map?person=${person.id}`}>
                {person.lat != null && person.lng != null ? 'On map' : 'Place pin'}
              </Link>
            </span>
          )}
        </li>
      </ul>

      {person.note && (
        <div className="pf-their-note">
          <span className="eyebrow">Their note</span>
          <p>{person.note}</p>
        </div>
      )}

      {desk && <Socials person={person} refresh={refresh} desk={desk} />}

      {person.address && (desk || household.length > 0) && (
        <>
          <div className="card-head pf-sub"><span className="eyebrow">Same address</span></div>
          {household.length === 0
            ? <p className="pf-empty">No one else.</p>
            : (
              <ul className="list-plain">
                {household.map((h) => (
                  <li key={h.id}>
                    <Link to={`/people/${h.id}`}>{h.name}</Link>
                    {h.rating && <RatingChip code={h.rating} who />}
                  </li>
                ))}
              </ul>
            )}
        </>
      )}

      {desk && (
        <div className="pf-row-acts">
          <button type="button" className="btn pp-btn" onClick={() => setEditing(true)}>Edit details</button>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tags, roles, signs, shifts, gifts, history
// ─────────────────────────────────────────────────────────────────────────────
function Tags({ person, refresh, desk }) {
  const [editing, setEditing] = useState(false);
  const act = useAction(refresh);
  const tags = Array.isArray(person.tags) ? person.tags : [];
  // Only what changed (person.tag): with no signal it waits on this device
  // and never undoes a tag someone else changed meanwhile.
  const save = (next) => {
    const add = next.filter((t) => !tags.includes(t));
    const remove = tags.filter((t) => !next.includes(t));
    if (add.length || remove.length) act.run('person.tag', { id: person.id, add, remove }, { who: person.name });
  };
  if (desk && editing) {
    return (
      <>
        <TagEditor
          tags={tags}
          suggestions={SUGGESTED_TAGS}
          disabled={act.busy}
          autoFocus
          onChange={save}
        />
        {act.error && <p className="error">{act.error}</p>}
        <div className="pf-row-acts">
          <button type="button" className="btn pp-btn" onClick={() => setEditing(false)}>Done</button>
        </div>
      </>
    );
  }
  return (
    <>
      {tags.length === 0
        ? <p className="pf-empty">No tags.</p>
        : (
          <div className="tag-chips">
            {tags.map((t) => (
              <Link key={t} to={`/people?tag=${encodeURIComponent(t)}`} className="chip pf-chip-link">{tagWord(t)}</Link>
            ))}
          </div>
        )}
      {desk && (
        <div className="pf-row-acts">
          <button type="button" className="btn pp-btn" onClick={() => setEditing(true)}>Edit tags</button>
        </div>
      )}
    </>
  );
}

function Roles({ person, roles, refresh, desk }) {
  const [role, setRole] = useState('');
  const [detail, setDetail] = useState('');
  const act = useAction(refresh, { needsSignal: true });
  const def = VOLUNTEER_ROLES.find((r) => r.code === role);
  const label = (code) => VOLUNTEER_ROLES.find((r) => r.code === code)?.label || code;

  const add = async (e) => {
    e.preventDefault();
    if (!role) return;
    const res = await act.run('volunteer.assign', { person_id: person.id, role, detail: detail.trim() || undefined });
    if (res) { setRole(''); setDetail(''); }
  };

  return (
    <>
      {roles.length === 0
        ? <p className="pf-empty">None yet.</p>
        : (
          <div className="role-chips">
            {roles.map((r) => (
              <span key={r.id} className="chip removable">
                {label(r.role)}{r.detail ? <span className="d"> · {r.detail}</span> : null}
                {desk && (
                  <button type="button" className="chip-x" aria-label={`Remove ${label(r.role)}`} disabled={act.busy}
                    onClick={() => act.run('volunteer.unassign', { id: r.id })}>×</button>
                )}
              </span>
            ))}
          </div>
        )}
      {desk && (
        <form className="role-add" onSubmit={add}>
          <div className="field">
            <label htmlFor="role-pick">Add a role</label>
            <select id="role-pick" className="input" value={role} onChange={(e) => { setRole(e.target.value); setDetail(''); }}>
              <option value="">—</option>
              {VOLUNTEER_ROLES.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </div>
          {def?.detail && (
            <div className="field">
              <label htmlFor="role-detail">{def.detail}</label>
              <input id="role-detail" className="input" maxLength={200} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder={def.detail} />
            </div>
          )}
          <button type="submit" className="btn pp-btn" disabled={!role || act.busy}>Add</button>
        </form>
      )}
      {act.error && <p className="error">{act.error}</p>}
    </>
  );
}

function Signs({ person, signs, refresh, desk }) {
  const act = useAction(refresh, { needsSignal: true });
  // sign.cancel (GET /api/actions, same key as the door card): only then can a
  // request that never went up be taken back from here.
  const actions = useQuery({ queryKey: ['actions'], queryFn: () => apiGet('/actions'), staleTime: 5 * 60_000 });
  const canCancel = Array.isArray(actions.data?.actions) && actions.data.actions.includes('sign.cancel');
  const kindLabel = (k) => SIGN_KINDS.find((s) => s.code === k)?.label || k;
  // A sign goes to an address: with none on file there's nowhere to put it.
  const noAddress = !String(person.address || '').trim();
  const setStatus = (s, v) => (v === SIGN_CANCEL
    ? act.run('sign.cancel', { id: s.id })
    : act.run('sign.update', { id: s.id, status: v }));
  return (
    <>
      {signs.length === 0 && <p className="pf-empty">No signs yet.</p>}
      {signs.map((s) => {
        const cancelable = canCancel && s.status === 'requested';
        const options = cancelable ? ['requested', 'installed', SIGN_CANCEL] : SIGN_STATUSES;
        return (
          <div key={s.id} className="sign-row">
            <span>
              <strong>{kindLabel(s.kind)}</strong>
              {s.note ? <span className="muted"> · {s.note}</span> : null}
            </span>
            <span className="head-actions">
              <span className={STATUS_CHIP[s.status] || 'chip'}>{SIGN_STATUS_WORD[s.status] || s.status}</span>
              <select className="input" aria-label="Sign status" value={s.status} disabled={act.busy}
                onChange={(e) => setStatus(s, e.target.value)}>
                {options.map((st) => (
                  <option key={st} value={st}>{st === SIGN_CANCEL ? 'Cancel request' : SIGN_STATUS_WORD[st] || st}</option>
                ))}
              </select>
            </span>
          </div>
        );
      })}
      <div className="card-head pf-sub"><span className="eyebrow">Request a sign</span></div>
      <div className="pf-row-acts" style={{ marginTop: 0 }}>
        {SIGN_BUTTONS.map((k) => (
          <button key={k.code} type="button" className="btn pp-btn" disabled={act.busy || noAddress} title={k.label}
            onClick={() => act.run('sign.place', { kind: k.code, person_id: person.id })}>
            {SIGN_SHORT[k.code] || k.label}
          </button>
        ))}
      </div>
      {noAddress && (
        <p className="hint" style={{ marginTop: 'var(--s-2)' }}>
          {desk ? 'No address — add one under Details first.' : 'No address on file — ask your organizer.'}
        </p>
      )}
      {act.error && <p className="error">{act.error}</p>}
    </>
  );
}

function Shifts({ shifts }) {
  if (shifts.length === 0) {
    return <p className="pf-empty">None. <Link to="/shifts">See shifts</Link></p>;
  }
  return (
    <ul className="list-plain">
      {shifts.map((s) => (
        <li key={s.assignment_id}>
          <span>
            <Link to={`/shifts/${s.id}`}>{s.title}</Link>
            <br />
            <span className="muted mono" style={{ fontSize: 12 }}>{fmtWhen(s.starts_at)}{s.location ? ` · ${s.location}` : ''}</span>
          </span>
          <span className={STATUS_CHIP[s.status] || 'chip'}>{String(s.status || '').replace('_', ' ')}</span>
        </li>
      ))}
    </ul>
  );
}

function Gifts({ person, gifts, totals }) {
  return (
    <>
      {totals.length > 0 && (
        <div className="chip-row" style={{ margin: '0 0 var(--s-3)' }}>
          {/* total_cents is a sum()::bigint — may arrive as a string; fmtMoney coerces with Number() */}
          {totals.map((t) => (
            <span key={t.year} className="chip">
              {t.year} · <strong className="mono">{fmtMoney(Number(t.total_cents))}</strong>
            </span>
          ))}
        </div>
      )}
      {gifts.length === 0
        ? <p className="pf-empty">No gifts yet.</p>
        : (
          <ul className="pf-gifts">
            {gifts.map((g) => (
              <li key={g.id}>
                <span className="amt">{fmtMoney(g.amount_cents)}</span>
                <span className="when">{fmtDate(g.date)}</span>
                {g.method && <span className="chip">{g.method}</span>}
                {g.cadence === 'monthly'
                  ? <span className="chip chip-ok">monthly</span>
                  : <span className="chip chip-ghost">one-time</span>}
                {g.flagged && <span className="chip chip-warn" title={g.flag_reason || ''}>flagged</span>}
                {g.note && <span className="note">{g.note}</span>}
              </li>
            ))}
          </ul>
        )}
      <div className="pf-row-acts">
        <Link className="btn pp-btn" to={`/money?new=1&person=${person.id}`}>Log a gift</Link>
      </div>
    </>
  );
}

function History({ contacts }) {
  if (contacts.length === 0) return <p className="pf-empty">No contacts yet.</p>;
  return (
    <ul className="timeline">
      {contacts.map((c) => (
        <li key={c.id}>
          <span className="when">{fmtWhen(c.created_at)}</span>
          <span className="what">
            <span className="chip">{CHANNEL_LABEL[c.channel] || c.channel}</span>
            {c.pending && <span className="chip obx-copy ds-pending">Not sent yet</span>}
            {c.rating ? <RatingTag code={c.rating} /> : <span>{OUTCOME_LABEL[c.outcome] || c.outcome}</span>}
            {c.by_name && <span className="by">{c.by_name}</span>}
            {c.note && <span className="note">{c.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────
export default function Person() {
  const { id } = useParams();
  const { me } = useOutletContext() ?? {};
  const desk = canDesk(me);
  const queryClient = useQueryClient();
  const [savedChannel, setChannel] = useChannel(id);
  // Desks open on the history; volunteers on phone + address.
  const [open, setOpen] = useState(() => (desk ? { history: true } : { details: true }));
  const ratingRef = useRef(null);
  const toggle = (key) => () => setOpen((o) => ({ ...o, [key]: !o[key] }));
  const scale = useScale();

  const profile = useQuery({
    queryKey: ['person', id],
    queryFn: () => apiGet(`/persons/${id}`),
  });
  const ladders = usePersonLadders(id, desk); // engagement level + ladders (desk only)
  const answers = usePersonAnswers(id, desk); // survey answers (desk only)
  const fields = usePersonFields(id); // profile fields (a volunteer gets only theirs)
  const knows = usePersonKnows(id, desk); // who they know (desk only)
  // What's saved on this device and not sent yet (a rating, a note, tags) is
  // shown as it will be, and said once under the name.
  const outbox = useOutbox();
  const online = useOnline();
  const device = useThisDevice();

  // Awaited by useAction so controls stay disabled until the profile refetches.
  // Covers the map (['doors']: pins, ratings, unlocated count after an address
  // edit), signs, Today, housemates' profiles, and Outreach's press audience
  // (['blasts'].mediaContacts counts media-tagged people with an email).
  const refresh = () => invalidatePersonData(queryClient);

  // Call / Text at the top: preset the channel, bring the rating card into view.
  const onLog = (ch) => {
    setChannel(ch);
    ratingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (profile.isLoading) return <p className="muted">Loading…</p>;
  // No signal and never opened here: they're there, it just can't load yet.
  if (noSignal(profile)) {
    return (
      <div className="pf-page">
        <BackLink desk={desk} />
        <p className="pp-offline" role="status">No signal — this profile loads when you’re back online.</p>
      </div>
    );
  }
  if (profile.isError || !profile.data?.person) {
    // Only the server saying so means they're gone (a 502 mid-deploy doesn't).
    const gone = profile.error?.status === 404 || (!profile.isError && !profile.data?.person);
    return (
      <div className="pp-empty">
        <p>{gone ? 'No one here — they may have been removed.' : noAnswer(profile.error) ? 'No answer — check your signal' : profile.error.message}</p>
        <BackLink desk={desk} className="btn pp-btn" />
      </div>
    );
  }
  // Volunteers get gifts: [], totals: [], donor: null from the server.
  const {
    person, gifts = [], totals = [], contacts = [], roles = [], signs = [], shifts = [], donor = null, household = [],
  } = applyOutboxToProfile(profile.data, outbox.items);
  const waiting = pendingAbout(outbox.items, person.id);
  const tags = Array.isArray(person.tags) ? person.tags : [];
  const thisYear = totals.find((t) => String(t.year) === String(new Date().getFullYear()));
  const last = contacts[0];
  const channel = savedChannel || firstChannel(person);
  // The header already shows the rating: the line adds when and how.
  const lastWhat = last && (last.rating
    ? (last.rating === person.rating ? '' : ratingText(scale, last.rating))
    : OUTCOME_LABEL[last.outcome] || last.outcome);

  return (
    <div className="pf-page">
      <Header person={person} donor={donor} me={me} desk={desk} onLog={onLog} contacted={contacts.length > 0} level={ladders.data?.level} />
      {waiting > 0 && (
        <p className="ds-waiting" role="status">Saved on {device} — {online ? 'sends soon' : 'sends when you’re back online'}</p>
      )}

      <RatingCard key={person.id} person={person} refresh={refresh} channel={channel} setChannel={setChannel} cardRef={ratingRef} />
      {/* Undecided or not rated: a supporter who knows them (desk). */}
      {desk && <KnowsNudge query={knows} person={person} />}

      {/* Volunteers get one line instead of the full history. */}
      {!desk && last && (
        <p className="pf-last">
          Last contact: {fmtShort(last.created_at)} · {CHANNEL_LABEL[last.channel] || last.channel}{lastWhat ? ` · ${lastWhat}` : ''}
        </p>
      )}

      <div className="pf-sections">
        <Section title="Details" open={!!open.details} onToggle={toggle('details')}>
          <Details person={person} household={household} refresh={refresh} desk={desk} me={me} />
        </Section>
        {/* The campaign's own fields (People → More → Profile fields); with no signal and no copy, it says so. */}
        {(fields.data?.fields?.length > 0 || noSignal(fields)) && (
          <Section title="More details" count={filledCount(fields) || ''} open={!!open.more} onToggle={toggle('more')}>
            <PersonFields key={person.id} query={fields} personId={person.id} />
          </Section>
        )}
        {desk && (
          <Section title="Knows" count={knows.data?.knows?.length || ''} open={!!open.knows} onToggle={toggle('knows')}>
            <PersonKnows person={person} query={knows} />
          </Section>
        )}
        {/* Tags and roles are desk work: volunteers can't change them (person.update / volunteer.* are desk-only). */}
        {desk && (
          <Section title="Tags" count={tags.length || ''} open={!!open.tags} onToggle={toggle('tags')}>
            <Tags person={person} refresh={refresh} desk={desk} />
          </Section>
        )}
        {desk && (
          <Section title="Volunteer roles" count={roles.length || ''} open={!!open.roles} onToggle={toggle('roles')}>
            <Roles person={person} roles={roles} refresh={refresh} desk={desk} />
          </Section>
        )}
        <Section title="Signs" count={signs.length || ''} open={!!open.signs} onToggle={toggle('signs')}>
          <Signs person={person} signs={signs} refresh={refresh} desk={desk} />
        </Section>
        {/* Shifts and the full history are desk views; volunteers have Shifts and the line above. */}
        {desk && (
          <Section title="Shifts" count={shifts.length || ''} open={!!open.shifts} onToggle={toggle('shifts')}>
            <Shifts shifts={shifts} />
          </Section>
        )}
        {desk && (
          <Section title="Gifts" count={thisYear ? fmtMoney(Number(thisYear.total_cents)) : gifts.length || ''}
            open={!!open.gifts} onToggle={toggle('gifts')}>
            <Gifts person={person} gifts={gifts} totals={totals} />
          </Section>
        )}
        {desk && (ladders.data?.runs?.length > 0 || ladders.data?.followups?.length > 0) && (
          <Section title="Ladders" count={ladders.data.runs.filter((r) => r.status !== 'done').length || ''} open={!!open.ladders} onToggle={toggle('ladders')}>
            <PersonLadders data={ladders.data} name={person.name} />
          </Section>
        )}
        {desk && answers.data?.answers?.length > 0 && (
          <Section title="Answers" count={answers.data.answers.length} open={!!open.answers} onToggle={toggle('answers')}>
            <PersonAnswers query={answers} />
          </Section>
        )}
        {desk && (
          <Section title="History" count={contacts.length || ''} open={!!open.history} onToggle={toggle('history')}>
            <History contacts={contacts} />
          </Section>
        )}
        {/* Texts through the campaign's number with this person (desk). */}
        {desk && <TextingPersonLink personId={person.id} />}
      </div>
    </div>
  );
}
