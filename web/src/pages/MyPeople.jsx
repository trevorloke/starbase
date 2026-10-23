// My people — the people you know (/my-people, every role; Today's "My
// people · 6" row and Calls' quiet link open it). One yellow "Add someone":
// name, phone and/or email, how you know them (a note under More details) —
// someone already on the list is linked, not added twice. It goes through
// the offline outbox, so with no signal it's saved on the phone and sent once.
// Each row is the person, how you know them (the kind and its note) and their
// rating chip — a rating saved on the phone and not sent yet shows, marked
// "Offline" / "Not sent", even after a reload; a tap opens it in place to
// reach them: Phone · Text · In person, the Calls card (Call / Text — the
// campaign's number when connected, else the phone's own), the rating
// buttons and the calls questions. One tap logs the contact (contact.log,
// through the outbox) with the way you really talked: a phone call, a text,
// or "In person". Remove? Yes · No in place (it needs signal, and says so).
// The server sends only your own people, through the volunteer rule.
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import RatingButtons, { RatingChip, focusRating, ratingText, useScale } from '../components/RatingButtons.jsx';
import SurveyQuestions, { answersTail, useSurvey } from '../components/SurveyQuestions.jsx';
import { TextingCallButton, noTexts } from '../components/TextingCard.jsx';
import { KINDS, MINE_KEY, linkWords, useMyPeople } from '../components/RelationshipsBits.jsx';
import { NeedsSignal, NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { showingCopy } from '../components/OfflineCache.js';
import { queuedChip, queuedText } from '../components/queued.js';
import { newClientId, onOutboxSent, queueAction, useOutbox } from '../offline.js';
import { Icon, firstName, invalidatePersonData, isDnc, smsHref, telHref, textBody, useAction } from './People.jsx';
import './shifts.css';
import './people.css';
import './relationships.css';

const WAYS = { phone: 'Phone', text: 'Text', in_person: 'In person' };
const NO_ANSWER = { phone: 'No answer', text: 'No reply' };

// Looks like an email (the server checks it properly): "typo@" is caught here,
// before it's saved on the phone and refused later.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

// A server refusal in plain words: "person: add a phone…" → "Add a phone…".
const say = (msg) => {
  const s = String(msg || '').replace(/^[a-z_.]+: /i, '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Not saved';
};

function BackLink() {
  const from = useLocation().state?.from;
  return <Link className="ops-back" to={from?.to || '/'}>← {from?.label || 'Today'}</Link>;
}

function AddForm({ onClose, onAdded }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: '', phone: '', email: '', note: '' });
  const [kind, setKind] = useState(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const kindId = useId();
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    const name = form.name.trim();
    const phone = form.phone.trim();
    const email = form.email.trim();
    if (!name) { setError('Add their name'); return; }
    if (!phone && !email) { setError('Add a phone or an email'); return; }
    if (email && !EMAIL_RE.test(email)) { setError('Check the email'); return; }
    if (!kind) { setError('Pick how you know them'); return; }
    setBusy(true);
    setError(null);
    try {
      // Made here, so a replay from the outbox is the same link and person.
      const input = {
        id: newClientId(),
        person: { id: newClientId(), name, phone: phone || undefined, email: email || undefined },
        kind,
        note: form.note.trim() || undefined,
      };
      const res = await queueAction('relationship.add', input, { who: name });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: MINE_KEY }),
        queryClient.invalidateQueries({ queryKey: ['brief'] }),
      ]);
      onAdded(res, name, input.id);
      onClose();
    } catch (err) {
      setError(say(err.message));
      setBusy(false);
    }
  };

  return (
    <form className="card ops-form rel-form" onSubmit={submit} aria-label="Add someone you know" noValidate>
      <div className="field">
        <label htmlFor="rel-name">Name</label>
        <input id="rel-name" className="input" autoFocus maxLength={300} autoComplete="off" value={form.name} onChange={set('name')} />
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="rel-phone">Phone</label>
          <input id="rel-phone" className="input mono" type="tel" inputMode="tel" maxLength={40} autoComplete="off" value={form.phone} onChange={set('phone')} />
        </div>
        <div className="field">
          <label htmlFor="rel-email">Email</label>
          <input id="rel-email" className="input" type="email" maxLength={320} autoComplete="off" value={form.email} onChange={set('email')} />
        </div>
      </div>
      <div className="field">
        <span className="rel-label" id={kindId}>How you know them</span>
        <div className="rel-kinds" role="group" aria-labelledby={kindId}>
          {KINDS.map((k) => (
            <button key={k.code} type="button" className="rel-kind" aria-pressed={kind === k.code} onClick={() => setKind(k.code)}>
              {k.label}
            </button>
          ))}
        </div>
      </div>
      <button type="button" className="disclose disclose--inline rel-moredetails" aria-expanded={more} onClick={() => setMore((v) => !v)}>
        More details
      </button>
      {more && (
        <div className="field">
          <label htmlFor="rel-note">Note</label>
          <input id="rel-note" className="input" maxLength={200} autoComplete="off" placeholder="Book club" value={form.note} onChange={set('note')} />
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy}>{busy ? 'Adding…' : 'Add'}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

// One person, opened: how you talked, the Calls card, the rating buttons.
function Reach({ link, me, onClose }) {
  const p = link.person;
  const scale = useScale();
  const queryClient = useQueryClient();
  const refresh = () => invalidatePersonData(queryClient);
  const act = useAction(refresh);
  // Remove goes straight to the server: off with no signal, and said so.
  const rm = useAction(refresh, { needsSignal: true });
  const online = useOnline();
  const dnc = isDnc(p);
  const ways = [p.phone && 'phone', p.phone && !noTexts(p) && 'text', 'in_person'].filter(Boolean);
  const [way, setWay] = useState(ways[0]);
  const [picked, setPicked] = useState(null);
  const [said, setSaid] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const cardRef = useRef(null);
  const howId = useId();
  const survey = useSurvey({ context: 'calls', personId: p.id });
  const outbox = useOutbox();
  // Saved on the phone: the line turns to "✓ Sent" once the outbox empties.
  useEffect(() => {
    if (!said?.queued || outbox.pending > 0 || outbox.flushing) return;
    setSaid(outbox.lastError ? { text: outbox.lastError, queued: false } : { text: `✓ Sent · ${said.what}`, what: said.what, queued: false });
  }, [said, outbox.pending, outbox.flushing, outbox.lastError]);

  const log = async (outcome, rating) => {
    const answers = outcome === 'contacted' ? survey.take() : [];
    const visitOf = survey.visitOf(way);
    const res = await act.run('contact.log', {
      person_id: p.id, channel: way, outcome, rating: rating || undefined,
      answers: answers.length ? answers : undefined, visit_of: visitOf,
    }, { who: p.name });
    if (!res) { survey.restore(answers); return; }
    survey.logged(res, { channel: way, outcome, rating, answers, visitOf });
    if (rating) setPicked(rating);
    const did = rating ? `Rated ${ratingText(scale, rating)}` : outcome === 'contacted' ? 'Talked' : NO_ANSWER[way];
    const what = `${WAYS[way]} · ${did}${answersTail(answers, res.result)}`;
    setSaid({ text: res.queued ? `${queuedText(res)} · ${what}` : `✓ ${what}`, what, queued: Boolean(res.queued) });
  };
  const change = () => { setSaid(null); focusRating(cardRef.current); };
  const remove = async () => {
    const res = await rm.run('relationship.remove', { id: link.id });
    if (res) onClose();
  };
  const first = firstName(p.name);

  return (
    <div className="ops-body rel-reach" ref={cardRef}>
      {dnc ? (
        <p><span className="chip chip-danger">Do not contact</span></p>
      ) : (
        <>
          {ways.length > 1 ? (
            <div className="rel-how">
              <span className="rel-label" id={howId}>How you talked</span>
              <div className="cl-toggle" role="group" aria-labelledby={howId}>
                {ways.map((w) => (
                  <button key={w} type="button" aria-pressed={way === w} onClick={() => { setWay(w); setSaid(null); }}>{WAYS[w]}</button>
                ))}
              </div>
            </div>
          ) : (
            <span className="rel-label">In person</span>
          )}
          {way !== 'in_person' && (
            <TextingCallButton person={p} me={me} channel={way === 'text' ? 'text' : 'phone'} onSent={() => {}} onNext={onClose}>
              {way === 'text' ? (
                <a className="btn cl-call" href={smsHref(p.phone, textBody(p, me))}><Icon name="text" size={22} /> Text {first}</a>
              ) : (
                <a className="btn cl-call" href={telHref(p.phone)}><Icon name="phone" size={22} /> Call {first}</a>
              )}
            </TextingCallButton>
          )}
          <RatingButtons value={picked} onPick={(code) => log('contacted', code)} disabled={act.busy} />
          {way !== 'in_person' && (
            <div className="cl-outcomes rel-outcomes">
              <button type="button" className="cl-out" disabled={act.busy} onClick={() => log('no_answer')}>{NO_ANSWER[way]}</button>
            </div>
          )}
          <SurveyQuestions survey={survey} disabled={act.busy} onSave={() => log('contacted')} />
          {act.error ? <p className="error" role="alert">{act.error}</p> : said && (
            <div className="pf-status-row">
              <p className="pf-status" role="status">{said.text}</p>
              <button type="button" className="btn btn-quiet pp-btn" onClick={change}>Change</button>
            </div>
          )}
        </>
      )}
      <div className="rel-foot">
        <Link className="btn btn-quiet ops-tap" to={`/people/${p.id}`} state={{ from: { to: '/my-people', label: 'My people' } }}>Profile</Link>
        {confirm ? (
          <span className="ops-confirm">
            <span>Remove?</span>
            <button type="button" className="btn ops-tap" disabled={rm.busy} onClick={remove}>Yes</button>
            <button type="button" className="btn btn-quiet ops-tap" onClick={() => { setConfirm(false); rm.clearError(); }}>No</button>
          </span>
        ) : (
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => { rm.clearError(); setConfirm(true); }}>Remove</button>
        )}
      </div>
      {confirm && (!online ? <NeedsSignal>Removing needs signal</NeedsSignal> : rm.error && <p className="error" role="alert">{rm.error}</p>)}
    </div>
  );
}

export default function MyPeople() {
  const { me } = useOutletContext() ?? {};
  const [params, setParams] = useSearchParams();
  const adding = params.get('add') === '1';
  const q = useMyPeople(me);
  const outbox = useOutbox();
  const [open, setOpen] = useState(null);
  const [note, setNote] = useState(null);
  const people = q.data?.people ?? [];
  const ids = new Set(people.map((x) => x.id));
  // Added on this phone and not on the server yet (or refused: the strip says why).
  const waiting = outbox.items.filter((i) => i.name === 'relationship.add' && i.input?.person && !ids.has(i.input.id));
  // A rating saved on this phone and not sent yet: on the row, marked so.
  const queuedRating = {};
  for (const i of outbox.items) {
    if (i.state === 'pending' && i.name === 'contact.log' && i.input?.person_id && i.input.rating) queuedRating[i.input.person_id] = i.input.rating;
  }
  const offline = noSignal(q);
  const copy = showingCopy(q);
  const location = useLocation();

  const addedText = (r, name) => (r?.duplicate ? `${r.person?.name || name} is one of your people already` : `✓ Added ${r?.person?.name || name}`);
  const onAdded = (res, name, linkId) => {
    if (res.queued) { setNote({ text: `${name} · ${queuedText(res)}`, wait: true, cid: res.client_id, linkId, name }); return; }
    const r = res.result || {};
    setNote({ text: addedText(r, name) });
    if (r.relationship?.id) setOpen(r.relationship.id);
  };
  // "Quinn · Saved offline" stays true: "✓ Added Quinn" once it's sent; gone
  // once it's refused (the row's "Not saved" says so) or taken off the phone.
  useEffect(() => onOutboxSent(({ name, input, result }) => {
    if (name !== 'relationship.add') return;
    setNote((n) => (n?.wait && n.linkId === input?.id ? { text: addedText(result, n.name) } : n));
  }), []);
  useEffect(() => {
    if (!note?.wait) return;
    const it = outbox.items.find((i) => i.cid === note.cid);
    if (!it || it.state === 'refused') setNote((n) => (n === note ? null : n));
  }, [note, outbox.items]);

  return (
    <div className="ops-page rel-page">
      <BackLink />
      <div className="ops-head">
        <h1>My people</h1>
        {!adding && (
          <button type="button" className="btn btn-primary ops-tap" onClick={() => { setNote(null); setParams({ add: '1' }, { state: location.state }); }}>
            Add someone
          </button>
        )}
      </div>

      {adding && <AddForm onClose={() => setParams({}, { state: location.state })} onAdded={onAdded} />}
      {note && <p className={`ops-done${note.wait ? ' ops-done--wait' : ''}`} role="status">{note.text}</p>}
      {copy && <p className="ops-copy"><span className="chip obx-copy">Offline copy</span></p>}

      {offline ? <NoSignal /> : q.isPending ? <p className="muted">Loading…</p> : q.isError && !q.data ? (
        <p className="error" role="alert">{q.error.message}</p>
      ) : people.length === 0 && waiting.length === 0 ? (
        !adding && <p className="ops-empty">Add the people you know — friends, family, neighbours.</p>
      ) : (
        <ul className="ops-rows">
          {waiting.map((i) => (
            <li key={i.cid} className="ops-item">
              <div className="ops-row ops-row--static">
                <span className="ops-row__main">
                  <span className="ops-row__name">{i.input.person.name}</span>
                  <span className="ops-row__sub"><span className="rel-note">{linkWords(i.input)}</span></span>
                </span>
                <span className="ops-row__end">
                  <span className={`chip ${i.state === 'refused' ? 'chip-danger' : 'chip-warn'}`}>{i.state === 'refused' ? 'Not saved' : queuedChip(true)}</span>
                </span>
              </div>
            </li>
          ))}
          {people.map((link) => {
            const isOpen = open === link.id;
            const p = link.person;
            return (
              <li key={link.id} className="ops-item" data-open={isOpen || undefined}>
                <button type="button" className="ops-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : link.id)}>
                  <span className="ops-row__main">
                    <span className="ops-row__name">{p.name}</span>
                    <span className="ops-row__sub">
                      <span className="rel-note">{linkWords(link)}{p.phone ? ' ·' : ''}</span>{p.phone ? <span className="rel-phone">{p.phone}</span> : null}
                    </span>
                  </span>
                  <span className="ops-row__end">
                    <RatingChip code={queuedRating[p.id] || p.rating} who />
                    {queuedRating[p.id] && <span className="chip chip-warn">{queuedChip(true)}</span>}
                  </span>
                </button>
                {isOpen && <Reach link={link} me={me} onClose={() => setOpen(null)} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
