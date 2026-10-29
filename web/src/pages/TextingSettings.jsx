// Texting settings (desk; managers change them): the first text's wording
// and the hours texts and campaign calls may go out (campaign time) — one
// window Monday to Friday, another on weekends (default 10 am–6 pm, the
// CRTC's telemarketing hours; the campaign should confirm both with counsel).
// What's connected is said in the words Shifts and the Links tab use ("Not
// connected · Connect"); provider names and addresses sit under "For your
// Twilio setup", and callers' own phones (managers) under their own row.
// The first text shows its fill-ins as words — "[first name]", "[your
// name]", "[campaign]" — put in with the ladder email's "+ First name /
// + Your name / + Campaign" buttons; the codes are stored underneath
// (TextingWords.js), and a {…} that wouldn't fill in is flagged.
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action } from '../api.js';
import { NoSignal, noSignal } from '../components/NoSignal.jsx';
import { CONNECT_TO } from '../components/TextingCard.jsx';
import { FILLS, toCodes, toWords, unfilled } from '../components/TextingWords.js';
import './people.css';
import '../components/texting-card.css';
import './texting.css';

const HOURS = Array.from({ length: 25 }, (_, h) => h);
const hourWord = (h) => (h === 0 || h === 24 ? 'Midnight' : h === 12 ? 'Noon' : h < 12 ? `${h} am` : `${h - 12} pm`);

// Not switched on here: where it gets connected.
const NOT_SET_UP = <>Not connected · <Link to={CONNECT_TO}>Connect</Link></>;

// "Mon–Fri  from 9 am  until 9 pm" — the hours texts and calls may go out.
function HoursRow({ label, fromId, untilId, from, until, onFrom, onUntil, disabled }) {
  return (
    <div className="form-row">
      <div className="field">
        <label htmlFor={fromId}>{label} from</label>
        <select id={fromId} className="input tx-select" value={from} onChange={onFrom} disabled={disabled}>
          {HOURS.slice(0, 24).map((h) => <option key={h} value={h}>{hourWord(h)}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={untilId}>{label} until</label>
        <select id={untilId} className="input tx-select" value={until} onChange={onUntil} disabled={disabled}>
          {HOURS.slice(1).map((h) => <option key={h} value={h}>{hourWord(h)}</option>)}
        </select>
      </div>
    </div>
  );
}

function Disclosure({ title, count, children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="tx-more">
      <button type="button" className="disclose" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <span className="pf-sec__title">{title}</span>
        {count != null && <span className="pf-sec__count">{count}</span>}
      </button>
      {open && <div id={id} className="tx-more__body">{children}</div>}
    </section>
  );
}

export default function TextingSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['texting', 'settings'], queryFn: () => apiGet('/texting/settings') });
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);
  const [error, setError] = useState(null);
  const tplId = useId();
  const tplRef = useRef(null);
  const fromId = useId();
  const untilId = useId();
  const wkFromId = useId();
  const wkUntilId = useId();
  useEffect(() => { if (q.data && !form) setForm({ ...q.data.settings }); }, [q.data, form]);

  if (noSignal(q)) {
    return (
      <div className="tx-page">
        <Link className="eyebrow pf-back" to="/inbox">← Inbox</Link>
        <h1>Texting</h1>
        <NoSignal />
      </div>
    );
  }
  if (q.isLoading || !form) return q.isError ? <p className="error">{q.error.message}</p> : <p className="muted">Loading…</p>;
  const d = q.data;
  const edit = d.canEdit;
  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: Number(e.target.value) })); setSaid(null); setError(null); };
  const changed = ['template', 'allow_from', 'allow_until', 'weekend_from', 'weekend_until'].some((k) => form[k] !== d.settings[k]);
  const stray = unfilled(form.template);
  const setTemplate = (template) => { setForm((f) => ({ ...f, template })); setSaid(null); setError(null); };
  // "+ First name": the fill-in goes where the cursor was.
  const insert = (word) => {
    const el = tplRef.current;
    const val = toWords(form.template);
    const at = typeof el?.selectionStart === 'number' ? el.selectionStart : val.length;
    const end = typeof el?.selectionEnd === 'number' ? el.selectionEnd : at;
    setTemplate(toCodes(val.slice(0, at) + word + val.slice(end)));
    const caret = at + word.length;
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange?.(caret, caret); });
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await action('texting.settings', form);
      await qc.invalidateQueries({ queryKey: ['texting'] });
      setSaid('Saved');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tx-page">
      <Link className="eyebrow pf-back" to="/inbox">← Inbox</Link>
      <h1>Texting</h1>
      <ul className="tx-status">
        <li><span>Texts</span><strong>{d.sms ? `On · ${d.number}` : NOT_SET_UP}</strong></li>
        <li><span>Calls</span><strong>{d.voice ? 'Through the campaign' : NOT_SET_UP}</strong></li>
      </ul>

      <div className="field">
        <label htmlFor={tplId}>First text</label>
        <textarea id={tplId} ref={tplRef} className="input tx-tpl" rows={3} maxLength={600} value={toWords(form.template)}
          onChange={(e) => setTemplate(toCodes(e.target.value))} disabled={!edit} />
        {edit && (
          <div className="tx-tokens" role="group" aria-label="Fill in">
            {FILLS.map((f) => (
              <button key={f.code} type="button" className="btn btn-quiet tx-token"
                onMouseDown={(e) => e.preventDefault()} onClick={() => insert(f.word)}>{f.button}</button>
            ))}
          </div>
        )}
        {stray
          ? <span className="tx-line tx-line--warn" role="alert">{stray}</span>
          : <span className="tx-line">Ends with “Reply STOP to opt out”.</span>}
      </div>
      <p className="tx-label">Hours texts and calls go out</p>
      <HoursRow label="Mon–Fri" fromId={fromId} untilId={untilId} from={form.allow_from} until={form.allow_until}
        onFrom={set('allow_from')} onUntil={set('allow_until')} disabled={!edit} />
      <HoursRow label="Sat–Sun" fromId={wkFromId} untilId={wkUntilId} from={form.weekend_from} until={form.weekend_until}
        onFrom={set('weekend_from')} onUntil={set('weekend_until')} disabled={!edit} />
      {edit ? (
        <div className="tx-save">
          <button type="button" className="btn btn-primary pp-btn" disabled={busy || !changed || Boolean(stray)} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {said && !changed && <span className="tx-line" role="status">✓ {said}</span>}
        </div>
      ) : <p className="tx-line">Managers change these.</p>}
      {error && <p className="error" role="alert">{error}</p>}

      <Disclosure title="For your Twilio setup">
        {!d.sms && <p className="tx-line">Texts: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.</p>}
        {!d.voice && <p className="tx-line">Calls: texts, plus STARBASE_PUBLIC_URL (this site’s web address).</p>}
        <p className="tx-line">Point the number’s incoming messages here:</p>
        <code className="tx-code">{d.webhooks.sms}</code>
      </Disclosure>
      {d.memberPhones && (
        <Disclosure title="Callers’ phones" count={d.memberPhones.length}>
          {d.memberPhones.length === 0 ? <p className="tx-line">None yet.</p> : (
            <ul className="list-plain">
              {d.memberPhones.map((p) => <li key={p.user_id}><span>{p.name}</span><span className="mono">{p.phone}</span></li>)}
            </ul>
          )}
        </Disclosure>
      )}
    </div>
  );
}
