// Ladders — the words and small pieces every ladder screen shares: what a
// trigger and a step are called, where a person is on a ladder ("Waiting
// until Fri, Oct 24", "Waiting — email isn't connected"), the engagement
// chip, and the profile's Ladders section. Desk only: the server refuses
// volunteers every ladder read.
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import '../pages/ladders.css';

export const TRIGGERS = [
  { kind: 'petition', label: 'Signed a petition', ref: 'petition' },
  { kind: 'newsletter', label: 'Joined the newsletter' },
  { kind: 'volunteer', label: 'Signed up to volunteer' },
  { kind: 'rsvp', label: 'RSVPed to an event', ref: 'event' },
  { kind: 'donation', label: 'First donation' },
  { kind: 'tag', label: 'Got a tag', ref: 'tag' },
  { kind: 'rating', label: 'Rated 1 or 2' },
];
export const triggerLabel = (kind) => TRIGGERS.find((t) => t.kind === kind)?.label || kind;
// "Signed a petition · Fix 72 Ave", "RSVPed to an event · any".
export const triggerLine = (t) => {
  if (!t) return '';
  const label = t.label || triggerLabel(t.kind);
  if (t.what) return `${label} · ${t.what}`;
  if (t.kind === 'petition' || t.kind === 'rsvp') return `${label} · any`;
  return label;
};

export const STEP_KINDS = [
  { kind: 'wait', label: 'Wait' },
  { kind: 'email', label: 'Email' },
  { kind: 'tag', label: 'Tag' },
  { kind: 'followup', label: 'Follow-up' },
  { kind: 'untag', label: 'Remove a tag', more: true },
  { kind: 'stop', label: 'Stop', more: true },
];
// The step button that shows the rest (not "More": the page has its own).
export const OTHER_STEPS = 'Other steps';
export const STEP_WORD = { wait: 'Wait', email: 'Email', tag: 'Tag', untag: 'Remove tag', followup: 'Follow-up', stop: 'Stop' };

// One step as one line ("Email · Thanks, [first name]") and the rest of the
// words a step is shown in: LaddersWords.js (plain JS, tested on the server).
export { plural, stepLine } from './LaddersWords.js';

export const fmtWhen = (ts) => new Date(ts).toLocaleString('en-CA', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

const REASON = {
  no_email: 'no email', unsubscribed: 'unsubscribed', do_not_contact: 'do not contact',
  do_not_email: 'do not email', no_consent: 'didn’t ask for email',
};
const END = { finished: 'Finished', stopped: 'Stopped', taken_off: 'Taken off', person_removed: 'Finished' };

// Where a person is on a ladder, in a few words. Literally what the server
// knows: a waiting email says whether email is connected right now.
export const whereLine = (run, emailConfigured) => {
  if (!run) return '';
  if (run.status === 'done') {
    const end = END[run.last?.kind === 'end' ? run.last.result : 'finished'] || 'Finished';
    const skip = (run.skipped || []).find((s) => s.kind === 'email');
    return skip ? `${end} · email skipped (${REASON[skip.reason] || skip.reason})` : end;
  }
  if (run.status === 'paused') return `Paused · step ${run.step + 1} of ${run.steps}`;
  if (run.wait === 'email') return emailConfigured ? 'Email connected — sends within the hour' : 'Waiting — email isn’t connected';
  if (run.wait === 'retry') return 'Email didn’t go — trying again';
  if (run.wait === 'sending') return 'Sending email';
  if (run.wait === 'time' && run.next_at) return `Waiting until ${fmtWhen(run.next_at)}`;
  return `Step ${Math.min(run.step + 1, run.steps)} of ${run.steps}${run.stepKind ? ` · ${STEP_WORD[run.stepKind]}` : ''}`;
};

// "3 in progress · 12 finished" — while a ladder is off its people are paused.
export const countsLine = (l) => `${l.inProgress} ${l.active ? 'in progress' : 'paused'} · ${l.finished} finished`;

// What one log entry says ("Email sent", "Email skipped — unsubscribed").
export const logLine = (e) => {
  const what = STEP_WORD[e.kind] || '';
  if (e.kind === 'end') return END[e.result] || 'Finished';
  if (e.kind === 'wait') return e.until ? `Waited until ${fmtWhen(e.until)}` : 'Wait';
  if (e.result === 'skipped') return `${what} skipped — ${REASON[e.reason] || e.reason}`;
  if (e.kind === 'email') {
    if (e.result === 'sent') return 'Email sent';
    if (e.result === 'sending') return 'Sending email';
    if (e.result === 'unsure') return 'Email — not sure it went';
    if (e.result === 'waiting') return 'Email waiting — not connected';
    if (e.result === 'failed') return e.reason === 'gave_up' ? 'Email failed' : 'Email didn’t go — trying again';
  }
  if (e.kind === 'tag' || e.kind === 'untag') return `${what} · ${e.tag}`;
  if (e.kind === 'followup') return 'Follow-up added';
  return what;
};

// Where the screens send "Connect" (Outreach's Website tab, Email & texting open).
export const CONNECT_TO = '/outreach/website?connect=1';

// "← Ladders", or back to the screen that opened this one when it said who
// it is (router state, as Results does): Today's "2 follow-ups" → "← Today".
export function LadBack() {
  const from = useLocation().state?.from;
  return from?.to
    ? <Link className="ops-back" to={from.to}>← {from.label || 'Back'}</Link>
    : <Link className="ops-back" to="/ladders">← Ladders</Link>;
}

// ── Starts when: the trigger, and which petition / event / tag ──
export function TriggerPicker({ value, onChange, options, idp, disabled }) {
  const t = TRIGGERS.find((x) => x.kind === value.kind) || TRIGGERS[0];
  const petitions = options?.petitions ?? [];
  const events = options?.events ?? [];
  const tags = options?.tags ?? [];
  return (
    <>
      <div className="field">
        <label htmlFor={`${idp}-kind`}>Starts when</label>
        <select id={`${idp}-kind`} className="input lad-select" value={t.kind} disabled={disabled}
          onChange={(e) => onChange({ kind: e.target.value, ref: '' })}>
          {TRIGGERS.map((x) => <option key={x.kind} value={x.kind}>{x.label}</option>)}
        </select>
      </div>
      {t.ref === 'petition' && (
        <div className="field">
          <label htmlFor={`${idp}-ref`}>Which petition</label>
          <select id={`${idp}-ref`} className="input lad-select" value={value.ref || ''} disabled={disabled}
            onChange={(e) => onChange({ ...value, ref: e.target.value })}>
            <option value="">Any petition</option>
            {petitions.map((p) => <option key={p.slug} value={p.slug}>{p.title}</option>)}
          </select>
        </div>
      )}
      {t.ref === 'event' && (
        <div className="field">
          <label htmlFor={`${idp}-ref`}>Which event</label>
          <select id={`${idp}-ref`} className="input lad-select" value={value.ref || ''} disabled={disabled}
            onChange={(e) => onChange({ ...value, ref: e.target.value })}>
            <option value="">Any event</option>
            {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
          </select>
        </div>
      )}
      {t.ref === 'tag' && (
        <div className="field">
          <label htmlFor={`${idp}-ref`}>Which tag</label>
          <input id={`${idp}-ref`} className="input lad-input" list={`${idp}-tags`} required maxLength={40}
            autoComplete="off" placeholder="host" value={value.ref || ''} disabled={disabled}
            onChange={(e) => onChange({ ...value, ref: e.target.value })} />
          <datalist id={`${idp}-tags`}>{tags.map((x) => <option key={x} value={x} />)}</datalist>
        </div>
      )}
    </>
  );
}

// ── Engagement ──
export const LEVEL_HINT = 'Contact → Supporter → Signer → Donor or volunteer → Leader';
export function EngagementChip({ level }) {
  if (!level) return null;
  return (
    <span className="chip lad-level" data-level={level.code} title={`Level ${level.step} of ${level.of}: ${LEVEL_HINT}`}>
      {level.label}
    </span>
  );
}

// ── The person profile (desk) ──
export const usePersonLadders = (id, desk) => useQuery({
  queryKey: ['person', id, 'ladders'],
  queryFn: () => apiGet(`/persons/${id}/ladders`),
  enabled: Boolean(desk && id),
});

export function PersonLadders({ data, name }) {
  const location = useLocation();
  // A ladder opened from here comes back here ("← Ana Souza").
  const from = { to: `${location.pathname}${location.search}`, label: name || 'Back' };
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const runs = data?.runs ?? [];
  const followups = data?.followups ?? [];
  const done = async (f) => {
    setBusy(true);
    setError(null);
    try {
      await action('ladder.followupDone', { id: f.id });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['person'] }),
        queryClient.invalidateQueries({ queryKey: ['ladders'] }),
      ]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {followups.length > 0 && (
        <ul className="list-plain lad-pf-fu">
          {followups.map((f) => (
            <li key={f.id}>
              <span>{f.text}</span>
              <button type="button" className="btn ops-tap lad-done-btn" disabled={busy} onClick={() => done(f)}>Done</button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {runs.length === 0 ? <p className="pf-empty">On no ladders.</p> : (
        <ul className="list-plain lad-pf-runs">
          {runs.map((r) => (
            <li key={r.id}>
              <Link to={`/ladders/${r.ladder.id}`} state={{ from }}>{r.ladder.name}</Link>
              <span className="lad-where">{r.ladder.active || r.status === 'done' ? whereLine(r, data.emailConfigured) : 'Ladder is off'}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
