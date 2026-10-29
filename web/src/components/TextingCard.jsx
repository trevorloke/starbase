// Texting and calling on the Calls card, through the campaign's Twilio number.
//
//   <TextingCallButton person me channel onSent onNext>{the phone's own sms:/tel: link}</…>
//       Text mode, Twilio connected — one of:
//         · they opted out → "<name> opted out of texts"
//         · someone else at the campaign is texting this number → "Already
//           texting with the campaign" (the desk gets Open, to that thread),
//           no Send: one campaign conversation per number
//         · your conversation with them → its last texts and a blank reply
//           (no first-text wording, no STOP line)
//         · otherwise the first text: the campaign's template with their
//           first name, editable, and the line the server adds ("Reply STOP
//           to opt out"); it must name the campaign
//       Send is the server's, one tap, one person; then "✓ Sent to <name>"
//       and one quiet "Next →" (onSent / onNext — the Calls screen moves on
//       and leaves them out of the Text list until they reply).
//       Phone mode, calls connected: "Call <name>" rings your own phone first
//       and connects you from the campaign's number. The first tap with no
//       number saved opens "Your phone" (focused, "Add your number first");
//       it's kept after the first call. Who else sees it is behind a tap.
//       No signal: the text card with Send off — never the phone's own
//       Messages while Twilio is on (the status is kept on the phone:
//       TextingStatus.js). A call needs no data, so Call is the phone's own
//       dialler (the children's tel: link), said in one line: "No signal —
//       this calls from your own number" (a campaign call already ringing
//       keeps its status line).
//       Twilio not connected: the children (today's sms: / tel: link) and, in
//       Text mode, one line — "Texts open on your phone" (volunteers) or
//       "Texting isn't connected · Connect" (the desk: <TextingOff />, the
//       words Shifts and the Links tab use).
//   <TextingRepliesLink me />   Calls' quiet "New replies · N" ("New texts" for
//                            the desk), else "Inbox" (its back link says "← Calls")
//   <TextingPersonLink personId />   a profile's "Texts" row (desk)
//   <TextingOff className />  the desk's "Texting isn't connected · Connect"
//   noTexts(person)          true when they must not be texted
//
// Nothing here says Sent unless the server says Twilio took it.
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action, ApiError, NoSignalError } from '../api.js';
import { isDesk } from '../Shell.jsx';
import { useTextingStatus, statusOffline, textingOn, useTextingPerson, useOnline } from './TextingStatus.js';
import { fillTemplate } from './TextingWords.js';
import './texting-card.css';

export { fillTemplate };
export { useTextingStatus, statusOffline, textingOn, useTextQueue, useTextingPerson, callsCard } from './TextingStatus.js';

export const NO_TEXT_TAGS = ['do-not-text', 'do-not-contact'];
export const noTexts = (p) => Array.isArray(p?.tags) && p.tags.some((t) => NO_TEXT_TAGS.includes(t));
export const FOOTER = 'Reply STOP to opt out';
// Where texting gets connected (the Links tab's "Email & texting").
export const CONNECT_TO = '/outreach/links?connect=1';
export function TextingOff({ className = 'tx-line' }) {
  return <p className={className}>Texting isn’t connected · <Link to={CONNECT_TO}>Connect</Link></p>;
}
const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';
export const namesCampaign = (body, campaign) => String(body || '').toLowerCase().includes(String(campaign || '').trim().toLowerCase());
const endsWithFooter = (body) => /reply stop to opt out\.?\s*$/i.test(String(body || ''));
export const clock = (ts) => {
  const d = new Date(ts || Date.now());
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
};
// "12:08 a.m." today, "Oct 21" before.
export const whenShort = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(d);
  return d.toLocaleDateString('en-CA', d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
};
const minutes = (s) => (s == null ? '' : s < 60 ? `${s} sec` : `${Math.round(s / 60)} min`);
// No answer at all: "No signal — not sent" offline; with signal the answer may
// have been lost on its way back, so it says only that (api.js).
const errorText = (e) => (e instanceof ApiError || e instanceof NoSignalError ? e.message : 'No signal — not sent');
// "Quiet hours — sending opens at 9 am" (the server's own words for when).
const quietLine = (quiet, what = 'sending opens') => `Quiet hours — ${what} at ${quiet?.opens || quiet?.label || 'the allowed hours'}`;

function TxIcon({ name }) {
  return (
    <svg className="pp-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {name === 'phone'
        ? <path d="M6.5 3.5h3l1.6 4.3-2.1 1.4a10.5 10.5 0 0 0 5.8 5.8l1.4-2.1 4.3 1.6v3a2 2 0 0 1-2.1 2A15.5 15.5 0 0 1 4.5 5.6a2 2 0 0 1 2-2.1z" />
        : <path d="M4 5h16v11H10l-5 4v-4H4z" />}
    </svg>
  );
}

// Your conversation's last texts, oldest first: "Sent · 12:08 a.m." / "Lena · 12:10 a.m.".
function Recent({ recent, fn }) {
  if (!recent?.length) return null;
  return (
    <ol className="tx-recent" aria-label="Last texts">
      {recent.map((m, i) => (
        <li key={i} className={`tx-recent__msg tx-recent__msg--${m.direction}`}>
          <span className="tx-recent__who">{m.direction === 'in' ? fn : 'Sent'} · {whenShort(m.created_at)}</span>
          <span className="tx-recent__body">{m.body}</span>
        </li>
      ))}
    </ol>
  );
}

// ── Text mode: write, then Send ──
function SendBox({ person, me, status, offline, onSent, onNext }) {
  const qc = useQueryClient();
  const id = useId();
  const fn = first(person.name);
  const card = useTextingPerson(person.id);
  const info = card.data;
  const conv = info?.conversation || null;
  // A follow-up in your own conversation: blank, no first-text wording.
  const replying = Boolean(conv && info && !info.first);
  const [typed, setTyped] = useState(null); // null until they type
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);   // the text the server sent
  const [error, setError] = useState(null);
  const body = typed ?? (replying ? '' : fillTemplate(status.template, { person, me, campaign: status.campaign }));

  if (info?.opted_out || info?.no_contact || noTexts(person)) {
    return <p className="tx-line tx-line--block" role="note">{fn} opted out of texts</p>;
  }
  if (done) {
    return (
      <div className="tx-done" role="status">
        <span>✓ Sent to {fn} · {clock(done.at)}</span>
        {onNext
          ? <button type="button" className="tx-quiet tx-next" onClick={onNext}>Next →</button>
          : <Link className="tx-quiet" to={`/inbox/${done.conversation_id}`}>Open</Link>}
      </div>
    );
  }
  if (info?.in_touch) {
    return (
      <div className="tx-send">
        <p className="tx-line tx-line--block" role="note">Already texting with the campaign</p>
        {info.in_touch_id && <Link className="tx-quiet tx-quiet--block" to={`/inbox/${info.in_touch_id}`}>Open</Link>}
        {onNext && <button type="button" className="tx-quiet tx-quiet--block tx-next" onClick={onNext}>Next →</button>}
      </div>
    );
  }
  const isFirst = info ? info.first : true;
  const missing = isFirst && !namesCampaign(body, status.campaign);
  const quiet = Boolean(status.quiet?.now);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = replying
        ? await action('text.reply', { conversation_id: conv.id, body })
        : await action('text.send', { person_id: person.id, body });
      if (r.sent) {
        setDone({ at: r.message.created_at, conversation_id: r.conversation_id });
        onSent?.(person);
      } else setError(`Not sent — ${r.message?.error || 'Twilio refused it'}`);
      qc.invalidateQueries({ queryKey: ['texting'] });
      qc.invalidateQueries({ queryKey: ['brief'] }); // Today's "texts this week"
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError) qc.invalidateQueries({ queryKey: ['texting', 'person', person.id] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tx-send">
      {replying && <Recent recent={conv.recent} fn={fn} />}
      <div className="tx-msg">
        <label className="pp-sr" htmlFor={id}>{replying ? `Reply to ${fn}` : `Message to ${fn}`}</label>
        <textarea id={id} className="tx-body" rows={replying ? 3 : 4} maxLength={1000} value={body}
          placeholder={replying ? 'Write a reply' : undefined}
          onChange={(e) => { setTyped(e.target.value); setError(null); }} />
        {isFirst && !endsWithFooter(body) && <p className="tx-foot" title="Added to every first text">{FOOTER}</p>}
      </div>
      {missing && <p className="tx-line tx-line--warn">Say it’s {status.campaign} in the first text</p>}
      {offline
        ? <p className="tx-line">Texts send with signal</p>
        : quiet && <p className="tx-line">{quietLine(status.quiet)}</p>}
      <button type="button" className="btn cl-call tx-go" disabled={busy || card.isLoading || offline || quiet || missing || !body.trim()} onClick={send}>
        <TxIcon name="text" /> {busy ? 'Sending…' : `Send to ${fn}`}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      {conv && !error && <Link className="tx-quiet tx-quiet--block" to={`/inbox/${conv.id}`}>All texts</Link>}
    </div>
  );
}

// ── Phone mode: ring my phone, then connect ──
const LIVE = new Set(['calling_you', 'connecting']);
const callWords = (call, fn) => {
  switch (call?.status) {
    case 'calling_you': return 'Calling your phone… answer and press 1 to connect';
    case 'connecting': return `Connecting you to ${fn}…`;
    case 'talked': return `Call ended · ${minutes(call.talk_s)}`;
    case 'no_answer': return `${fn} didn’t pick up`;
    case 'missed': return 'Not connected · try again';
    case 'ended': return 'Call ended';
    case 'failed': return 'Call didn’t go through';
    default: return '';
  }
};

const OWN_NUMBER = 'No signal — this calls from your own number';

function CampaignCall({ person, status, offline, children }) {
  const qc = useQueryClient();
  const id = useId();
  const fn = first(person.name);
  const inputRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [asked, setAsked] = useState(0); // taps on Call with no number yet
  const [who, setWho] = useState(false);
  const [phone, setPhone] = useState('');
  const [callId, setCallId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const call = useQuery({
    queryKey: ['texting', 'call', callId],
    queryFn: () => apiGet(`/texting/calls/${callId}`),
    enabled: Boolean(callId),
    refetchInterval: (q) => (LIVE.has(q.state.data?.call?.status ?? 'calling_you') ? 2000 : false),
  });
  const now = call.data?.call || (callId ? { status: 'calling_you' } : null);
  const live = LIVE.has(now?.status);
  const needPhone = !status.myPhone || editing;
  const quiet = Boolean(status.quiet?.now);
  // Ask for your own number on the first tap, not before.
  const showBox = needPhone && (editing || asked > 0) && !live;
  useEffect(() => { if (asked) inputRef.current?.focus(); }, [asked]);

  const start = async () => {
    if (needPhone && !phone.trim()) { setError(null); setAsked((n) => n + 1); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await action('call.start', { person_id: person.id, my_phone: needPhone ? phone : undefined });
      if (needPhone) { setEditing(false); qc.invalidateQueries({ queryKey: ['texting', 'status'] }); }
      if (r.call.status === 'failed') setError(`Call didn’t go through${r.call.error ? ` — ${r.call.error}` : ''}`);
      else setCallId(r.call.id);
    } catch (e) {
      setError(errorText(e).replace('not sent', 'no call'));
    } finally {
      setBusy(false);
    }
  };

  // No signal: the phone's own dialler, said plainly — no "Your phone" box.
  if (offline && !live && children) {
    return (
      <>
        {children}
        <p className="tx-line tx-line--under">{OWN_NUMBER}</p>
      </>
    );
  }

  return (
    <div className="tx-call">
      {showBox && (
        <div className="tx-myphone">
          <label className="tx-label" htmlFor={id}>Your phone</label>
          <input id={id} ref={inputRef} className="input tx-input" type="tel" inputMode="tel" autoComplete="tel" maxLength={40}
            value={phone} onChange={(e) => setPhone(e.target.value)} />
          {asked > 0 && !phone.trim() && <p className="tx-line tx-line--warn" role="alert">Add your number first</p>}
          <p className="tx-line">We ring you first · they see the campaign’s number</p>
          {who
            ? <p className="tx-line">Managers can see this number.</p>
            : <button type="button" className="tx-quiet" onClick={() => setWho(true)}>Who sees it</button>}
        </div>
      )}
      {offline
        ? <p className="tx-line">Calls need signal</p>
        : quiet && <p className="tx-line">{quietLine(status.quiet, 'calls open')}</p>}
      {live ? (
        <p className="tx-live" role="status" aria-live="polite">{callWords(now, fn)}</p>
      ) : (
        <button type="button" className="btn cl-call" disabled={busy || offline || quiet} onClick={start}>
          <TxIcon name="phone" /> {busy ? 'Calling…' : now ? `Call ${fn} again` : `Call ${fn}`}
        </button>
      )}
      {now && !live && <p className="tx-line tx-line--block" role="status">{callWords(now, fn)}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {status.myPhone && !needPhone && !live && (
        <button type="button" className="tx-quiet tx-quiet--block" onClick={() => { setEditing(true); setPhone(''); setAsked(0); }}>
          Change my number
        </button>
      )}
    </div>
  );
}

export function TextingCallButton({ person, me, channel, onSent, onNext, children }) {
  const status = useTextingStatus(me);
  const s = status.data;
  const on = textingOn(status);
  const online = useOnline();
  const offline = !online || statusOffline(status);
  if (channel === 'text') {
    if (on.sms) return <SendBox person={person} me={me} status={s} offline={offline} onSent={onSent} onNext={onNext} />;
    if (on.sms === false) {
      return (
        <>
          {children}
          {isDesk(me) ? <TextingOff className="tx-line tx-line--under" /> : <p className="tx-line tx-line--under">Texts open on your phone</p>}
        </>
      );
    }
    // Not known yet: never guess the phone's own Messages.
    return offline ? <p className="tx-line tx-line--block" role="note">Texts need signal</p> : null;
  }
  if (on.voice) return <CampaignCall person={person} status={s} offline={offline}>{children}</CampaignCall>;
  if (on.voice === false) return children;
  // Not known yet (no signal, nothing kept): a call from their own phone still works.
  if (offline && children) {
    return (
      <>
        {children}
        <p className="tx-line tx-line--under">{OWN_NUMBER}</p>
      </>
    );
  }
  return offline ? <p className="tx-line tx-line--block" role="note">Calls need signal</p> : null;
}

// Calls' quiet link to the Inbox: "New replies · 2" when there are, else
// "Inbox". The desk's count also holds texts from numbers nobody texted
// first, so it says "New texts".
export function TextingRepliesLink({ me }) {
  const s = useTextingStatus(me).data;
  const location = useLocation();
  const desk = isDesk(me);
  if (!s || !(s.conversations || s.unread || (desk && s.sms))) return null;
  const state = { from: { to: `${location.pathname}${location.search}`, label: 'Calls' } };
  return s.unread > 0 ? (
    <Link className="tx-replies is-new" to="/inbox" state={state}>{desk ? 'New texts' : 'New replies'} · <span className="mono">{s.unread}</span></Link>
  ) : (
    <Link className="tx-replies" to="/inbox" state={state}>Inbox</Link>
  );
}

export function TextingPersonLink({ personId }) {
  const q = useQuery({
    queryKey: ['texting', 'personConversations', personId],
    queryFn: () => apiGet(`/texting/people/${personId}/conversations`),
  });
  const list = q.data?.conversations || [];
  if (!list.length) return null;
  const to = list.length === 1 ? `/inbox/${list[0].id}` : `/inbox?person=${personId}`;
  const count = list.reduce((n, c) => n + (c.messages || 0), 0);
  // Their texts' Inbox comes back to them ("← Harjit").
  const state = list.length === 1 ? undefined : { from: { to: `/people/${personId}`, label: first(list[0].person_name) || 'Back' } };
  return (
    <section className="pf-sec">
      <Link className="tx-pflink" to={to} state={state}>
        <span className="pf-sec__title">Texts</span>
        <span className="pf-sec__count">{count}</span>
      </Link>
    </section>
  );
}
