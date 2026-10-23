// One conversation: every text in and out, oldest first, and a reply box.
// Send is the screen's one yellow button. The server refuses a reply to an
// opted-out number, in quiet hours, or without Twilio — and the screen says
// so before you try. Opening it marks its replies read (for you only).
// A reply that sounds like "stop" without being only STOP ("No thanks,
// stop") is flagged, with "Opt out this number" right above the reply box;
// otherwise that quiet button sits under it. Any role in the thread may tap
// it: the same opt-out as a STOP reply.
// One campaign conversation per number: while someone else's thread with
// this number is the live one (their answers are filed there), this one
// says "Already texting with the campaign" instead of a reply box — the
// desk gets "Open that thread". No signal: it says so, never "not found".
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useParams, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action, ApiError } from '../api.js';
import { isDesk } from '../Shell.jsx';
import { fmtWhen, noSignal } from './People.jsx';
import { FOOTER, namesCampaign, TextingOff } from '../components/TextingCard.jsx';
import { useOnline } from '../components/NoSignal.jsx';
import './people.css';
import '../components/texting-card.css';
import './texting.css';

const OUT_WORD = { sent: 'Sent', delivered: 'Delivered', undelivered: 'Not delivered', failed: 'Not sent' };
const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';

function OptOut({ conv, onDone }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const online = useOnline(); // a conversation kept from before (no signal) is read only
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await action('text.optout', { conversation_id: conv.id });
      // Their do-not-text tag shows on the profile, lists and the map.
      for (const key of ['person', 'persons', 'doors']) qc.invalidateQueries({ queryKey: [key] });
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No signal — not opted out');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="tx-quiet tx-quiet--block tx-optout" disabled={busy || !online} onClick={run}>
        {busy ? 'Opting out…' : 'Opt out this number'}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

function ReplyBox({ data, desk, onSent }) {
  const id = useId();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const online = useOnline();
  const { conversation: conv, quiet, campaign } = data;
  if (!data.sms) return desk ? <TextingOff className="tx-line tx-stop" /> : <p className="tx-line tx-stop">Texts open on your phone</p>;
  if (conv.opted_out || conv.no_texts) return <p className="tx-line tx-stop">Opted out — no more texts</p>;
  if (conv.in_touch) {
    return (
      <>
        <p className="tx-line tx-stop" role="note">
          {desk ? 'Already texting with the campaign — answer in that thread' : 'Already texting with the campaign'}
        </p>
        {conv.in_touch_id && <Link className="btn pp-btn" to={`/inbox/${conv.in_touch_id}`}>Open that thread</Link>}
      </>
    );
  }
  const missing = conv.first && body.trim() && !namesCampaign(body, campaign);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await action('text.reply', { conversation_id: conv.id, body });
      if (r.sent) setBody('');
      else setError(`Not sent — ${r.message?.error || 'Twilio refused it'}`);
      await onSent();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'No signal — not sent');
      if (e instanceof ApiError && e.status === 409) await onSent(); // e.g. someone else's thread is live now
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tx-reply">
      <div className="tx-msg">
        <label className="pp-sr" htmlFor={id}>Reply</label>
        <textarea id={id} className="tx-body" rows={3} maxLength={1000} placeholder="Write a reply"
          value={body} onChange={(e) => { setBody(e.target.value); setError(null); }} />
        {conv.first && <p className="tx-foot">{FOOTER}</p>}
      </div>
      {missing && <p className="tx-line tx-line--warn">Say it’s {campaign} in the first text</p>}
      {quiet?.now && <p className="tx-line">Quiet hours — sending opens at {quiet.opens || quiet.label}</p>}
      {!online && <p className="tx-line">Texts send with signal</p>}
      <button type="button" className="btn btn-primary pp-btn tx-send-btn"
        disabled={busy || quiet?.now || missing || !body.trim() || !online} onClick={send}>
        {busy ? 'Sending…' : 'Send'}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

export default function TextingThread() {
  const { id } = useParams();
  const location = useLocation();
  const { me } = useOutletContext() ?? {};
  const desk = isDesk(me);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['texting', 'thread', id],
    queryFn: () => apiGet(`/texting/conversations/${id}`),
    refetchInterval: 15_000,
  });
  const messages = q.data?.messages ?? [];
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in')?.id || null;
  const readRef = useRef(null);
  const endRef = useRef(null);

  // Read it: only when a reply arrived since the last time (no write otherwise).
  useEffect(() => {
    if (!lastIn || readRef.current === lastIn) return;
    readRef.current = lastIn;
    action('text.read', { conversation_id: id })
      .then((r) => { if (r.read) qc.invalidateQueries({ queryKey: ['texting', 'status'] }); })
      .catch(() => { readRef.current = null; });
  }, [lastIn, id, qc]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [messages.length]);

  // Back to the Inbox as it was opened ("← Calls" / "← Today" there).
  const inboxState = location.state?.inboxFrom ? { from: location.state.inboxFrom } : undefined;
  if (q.isLoading) return <p className="muted">Loading…</p>;
  // No signal and never opened here: it's there, it just can't load yet.
  if (noSignal(q)) {
    return (
      <div className="tx-page">
        <Link className="eyebrow pf-back" to="/inbox" state={inboxState}>← Inbox</Link>
        <p className="pp-offline" role="status">No signal — this conversation loads when you’re back online.</p>
      </div>
    );
  }
  if (q.isError || !q.data?.conversation) {
    return (
      <div className="pp-empty">
        <p>{q.error?.status === 404 || !q.error ? 'No conversation here.' : q.error.message}</p>
        <Link className="btn pp-btn" to="/inbox" state={inboxState}>Inbox</Link>
      </div>
    );
  }
  const conv = q.data.conversation;
  const blocked = conv.opted_out || conv.no_texts;
  const asked = messages.some((m) => m.keyword === 'asks_stop');
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['texting', 'thread', id] }),
    qc.invalidateQueries({ queryKey: ['texting', 'inbox'] }),
    qc.invalidateQueries({ queryKey: ['texting', 'person'] }),
  ]);

  return (
    <div className="tx-page">
      <Link className="eyebrow pf-back" to="/inbox" state={inboxState}>← Inbox</Link>
      <h1 className="tx-who">
        {conv.person_id ? <Link to={`/people/${conv.person_id}`}>{conv.person_name || conv.phone}</Link> : conv.phone}
      </h1>
      <p className="tx-sub mono">
        {conv.phone}
        {desk && conv.started_by_name && !conv.mine ? ` · ${first(conv.started_by_name)}` : ''}
      </p>

      <ol className="tx-thread" aria-label="Texts">
        {messages.map((m) => (
          <li key={m.id} className={`tx-bubble tx-bubble--${m.direction}${m.status === 'failed' || m.status === 'undelivered' ? ' is-bad' : ''}`}>
            <p className="tx-bubble__body">{m.body}</p>
            <span className="tx-bubble__meta">
              {fmtWhen(m.created_at)}
              {m.direction === 'out' && ` · ${OUT_WORD[m.status] || m.status}`}
              {m.direction === 'out' && desk && m.sent_by_name ? ` · ${first(m.sent_by_name)}` : ''}
            </span>
            {m.keyword === 'stop' && <span className="chip chip-danger tx-kw">Opted out</span>}
            {m.keyword === 'asks_stop' && <span className="chip chip-warn tx-kw">Asked to stop?</span>}
            {m.keyword === 'start' && <span className="chip chip-ok tx-kw">Opted back in</span>}
          </li>
        ))}
      </ol>
      <div ref={endRef} />

      {/* Not opted out yet: the one tap that stops every later text. */}
      {!blocked && asked && (
        <div className="tx-asked" role="note">
          <p className="tx-line tx-line--warn">They may be asking to stop</p>
          <OptOut conv={conv} onDone={refresh} />
        </div>
      )}
      <ReplyBox data={q.data} desk={desk} onSent={refresh} />
      {!blocked && !asked && <OptOut conv={conv} onDone={refresh} />}
    </div>
  );
}
