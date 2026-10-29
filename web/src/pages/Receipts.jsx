// Receipts (Money → More → Receipts). One job: see that every gift has its
// receipt, and get them to donors.
//   Rows: donor, receipt number + Sent / Not sent / Sending / Needs address /
//   Not sure / Void / Sample, amount. Tap a row for what happened ("Not sent —
//   email isn't connected", "Waiting — needs address"), Print and Send /
//   Send again (only when the server says it can really go), and "Send void
//   notice" for a voided receipt the donor already got.
//   One yellow "Email 3 receipts" — only while email is connected and some
//   Not sent ones can go; never one already Sending (asks in place: "Email 3
//   receipts? Yes · No"). Email off: the line says so, with Connect. No
//   signal: it's off, "Needs signal — nothing sent"; nothing loaded yet,
//   one line.
//   Settings (?settings=1, managers and treasurers): the financial agent and
//   how to reach them, "Receipt gifts of at least ($)", the footer; the tax line,
//   the disclosure amount and the campaign's dates under More details.
//   More: Settings · Disclosure (over $100) for a period · All receipts —
//   each "Download for a spreadsheet", what the financial agent files
//   (managers and treasurers). Sample gifts are never in them.
import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, action, fmtMoney, dollarsToCents } from '../api.js';
import { NeedsSignal, NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { StatusChip, fmtBig, shortDate, methodWord, sendWord, onItsWay } from '../components/ReceiptsBits.jsx';
import './shifts.css';
import './receipts.css';

const LATEST = 12;
const AGENT_ROLES = ['manager', 'treasurer'];
const receipts = (n) => `${n} ${n === 1 ? 'receipt' : 'receipts'}`;
// The saved amount, shown as it is (0 included); unset → empty.
const centsToField = (c) => (c === null || c === undefined || c === '' ? '' : String(Number(c) / 100));
// Where "Connect" goes: the Links tab, with its More open on Email & texting.
const CONNECT_TO = '/outreach/links?connect=1';
// "This campaign · Jan 1 – Dec 31, 2026" / "2025"
const periodWord = (p) => (p.key === 'campaign' ? `This campaign · ${shortDate(p.from)} – ${shortDate(p.to)}` : p.key);

function SettingsForm({ settings, onSaved, onClose }) {
  const [f, setF] = useState(() => ({
    agent_name: settings.agent_name || '',
    agent_contact: settings.agent_contact || '',
    threshold: centsToField(settings.threshold_cents),
    footer: settings.footer || '',
    notice: settings.notice || '',
    disclosure: centsToField(settings.disclosure_cents),
    period_start: settings.period_start || '',
    period_end: settings.period_end || '',
  }));
  const [more, setMore] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const threshold = f.threshold.trim() === '' ? 0 : dollarsToCents(f.threshold);
    const disclosure = f.disclosure.trim() === '' ? 10000 : dollarsToCents(f.disclosure);
    if (threshold === null || disclosure === null) { setError('Enter dollars, like 25 or 100'); return; }
    if (f.period_start && f.period_end && f.period_end < f.period_start) { setError('The campaign ends before it starts'); return; }
    setBusy(true);
    try {
      await action('receipt.settings', {
        agent_name: f.agent_name, agent_contact: f.agent_contact, footer: f.footer, notice: f.notice,
        threshold_cents: threshold, disclosure_cents: disclosure,
        period_start: f.period_start || null, period_end: f.period_end || null,
      });
      onSaved();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="card ops-form" onSubmit={submit} aria-label="Receipt settings">
      <div className="field">
        <label htmlFor="rc-agent">Financial agent</label>
        <input id="rc-agent" className="input" maxLength={200} autoComplete="off" placeholder="Full name"
          value={f.agent_name} onChange={set('agent_name')} />
      </div>
      <div className="field">
        <label htmlFor="rc-contact">Agent’s email or phone</label>
        <input id="rc-contact" className="input" maxLength={300} autoComplete="off"
          value={f.agent_contact} onChange={set('agent_contact')} />
      </div>
      <div className="field">
        <label htmlFor="rc-threshold">Receipt gifts of at least ($)</label>
        <input id="rc-threshold" className="input mono" inputMode="decimal" aria-describedby="rc-threshold-hint"
          value={f.threshold} onChange={set('threshold')} />
        <span id="rc-threshold-hint" className="ops-meta">0 receipts every gift</span>
      </div>
      <div className="field">
        <label htmlFor="rc-footer">Footer</label>
        <input id="rc-footer" className="input" maxLength={500} value={f.footer} onChange={set('footer')} />
      </div>
      <button type="button" className="ops-more disclose disclose--inline" aria-expanded={more} aria-controls="rc-more"
        onClick={() => setMore((v) => !v)}>
        More details
      </button>
      {more && (
        <div id="rc-more" className="ops-more-body">
          <div className="field">
            <label htmlFor="rc-notice">Tax line</label>
            <input id="rc-notice" className="input" maxLength={300} value={f.notice} onChange={set('notice')} />
          </div>
          <div className="field">
            <label htmlFor="rc-disclosure">Disclose donors over ($)</label>
            <input id="rc-disclosure" className="input mono" inputMode="decimal" placeholder="100"
              value={f.disclosure} onChange={set('disclosure')} />
          </div>
          <div className="form-row">
            <div className="field">
              <label htmlFor="rc-from">Campaign from</label>
              <input id="rc-from" className="input mono" type="date" value={f.period_start} onChange={set('period_start')} />
            </div>
            <div className="field">
              <label htmlFor="rc-to">Campaign to</label>
              <input id="rc-to" className="input mono" type="date" value={f.period_end} onChange={set('period_end')} />
            </div>
          </div>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

function ReceiptRow({ r, open, onToggle, onSend, onSendVoid, busy }) {
  const bodyId = `rc-${r.id}`;
  const canSend = !!r.can_send;
  return (
    <li className="ops-item" data-open={open ? '' : undefined} data-tone={r.void ? 'past' : undefined}>
      <button type="button" className="ops-row" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="ops-row__main">
          <span className="ops-row__name">{r.donor_name}</span>
          <span className="ops-row__sub"><span className="rc-num">{r.number}</span><StatusChip status={r.status} /></span>
        </span>
        <span className="ops-row__end"><span className="ops-row__amt">{fmtMoney(r.amount_cents)}</span></span>
      </button>
      {open && (
        <div className="ops-body" id={bodyId}>
          <p className="rc-status">{r.status.line}</p>
          <p className="ops-meta">{shortDate(r.received_on)} · {methodWord(r.method)}</p>
          <div className="ops-actions">
            <Link className="btn ops-tap" to={`/money/receipts/${r.id}`}>Print</Link>
            {canSend && (
              <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={onSend}>
                {busy ? 'Sending…' : sendWord(r)}
              </button>
            )}
            {r.can_send_void && (
              <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={onSendVoid}>
                {busy ? 'Sending…' : 'Send void notice'}
              </button>
            )}
            {r.person_id && <Link className="btn btn-quiet ops-tap" to={`/people/${r.person_id}`}>Donor</Link>}
          </div>
        </div>
      )}
    </li>
  );
}

export default function Receipts() {
  const { me } = useOutletContext();
  const canManage = AGENT_ROLES.includes(me?.role);
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const showSettings = canManage && params.get('settings') === '1';
  const [openId, setOpenId] = useState(null);
  const [all, setAll] = useState(false);
  const [more, setMore] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(null); // receipt id | 'all'
  const [toast, setToast] = useState(null);
  const [error, setError] = useState(null);
  const timer = useRef(null);

  const q = useQuery({
    queryKey: ['receipts', 'list'],
    queryFn: () => apiGet('/receipts'),
    // While an email is on its way, look again until it has gone (or not).
    refetchInterval: (query) => (query.state.data?.receipts?.some((r) => onItsWay(r.status)) ? 3000 : false),
  });
  const [period, setPeriod] = useState('campaign');
  const online = useOnline();
  const offline = noSignal(q);
  const data = q.data;
  // Cleared sample data leaves its receipts void in the books (the register
  // keeps them); the list doesn't show them.
  const rows = (data?.receipts ?? []).filter((r) => !(r.sample && r.void));
  const emailOn = !!data?.emailConfigured;
  const sendable = data?.counts?.sendable ?? 0;
  const settings = data?.settings;

  const say = (text) => {
    clearTimeout(timer.current);
    setToast(text);
    timer.current = setTimeout(() => setToast(null), 7000);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['receipts'] });

  const sendOne = async (r) => {
    setError(null);
    setBusy(r.id);
    try {
      const res = await action('receipt.send', { id: r.id });
      say(res.email === 'sent' ? `✓ Sent ${r.number} to ${r.donor_name}` : `Not sent — the email failed`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const sendVoid = async (r) => {
    setError(null);
    setBusy(r.id);
    try {
      const res = await action('receipt.sendVoid', { id: r.id });
      say(res.email === 'sent' ? `✓ Void notice sent to ${r.donor_name}` : 'Not sent — the email failed');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const sendAll = async () => {
    setError(null);
    setConfirm(false);
    setBusy('all');
    try {
      const res = await action('receipt.sendAll', {});
      const tried = res.sent + res.failed;
      const rest = res.more ? ' · more to send' : '';
      say((res.failed ? `Sent ${res.sent} of ${tried} — ${res.failed} failed` : `✓ Sent ${res.sent}`) + rest);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const shown = all ? rows : rows.slice(0, LATEST);
  const agentMissing = settings && !settings.agent_name;

  return (
    <div className="ops-page rc-page">
      <Link to="/money" className="ops-back">← Donations</Link>
      <div className="ops-head">
        <h1>Receipts</h1>
        {!showSettings && emailOn && sendable > 0 && !confirm && (
          <button type="button" className="btn btn-primary ops-tap" disabled={busy === 'all' || !online} onClick={() => setConfirm(true)}>
            {busy === 'all' ? 'Sending…' : `Email ${receipts(sendable)}`}
          </button>
        )}
      </div>
      {!online && !showSettings && emailOn && sendable > 0 && <NeedsSignal />}

      {confirm && (
        <div className="ops-confirm rc-confirm" role="group" aria-label="Email the receipts not sent">
          <span>Email {receipts(sendable)}?</span>
          <button type="button" className="btn ops-solid ops-tap" onClick={sendAll} disabled={!online}>Yes</button>
          <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(false)}>No</button>
        </div>
      )}

      {showSettings && settings && (
        <SettingsForm settings={settings} onClose={() => setParams({})}
          onSaved={() => { setParams({}); refresh(); say('✓ Settings saved'); }} />
      )}

      {!showSettings && canManage && agentMissing && (
        <div className="rc-setup">
          <span>Financial agent not set</span>
          <button type="button" className="btn ops-tap" onClick={() => setParams({ settings: '1' })}>Set up</button>
        </div>
      )}
      {data && !emailOn && (
        <p className="ops-meta rc-line">Email isn’t connected — print receipts instead. <Link to={CONNECT_TO}>Connect</Link></p>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      {offline && <NoSignal />}
      {q.isError && !offline && <p className="error">{q.error.message}</p>}
      {q.isPending && !offline && <p className="muted">Loading…</p>}
      {q.isSuccess && rows.length === 0 && (
        <div className="ops-empty-block">
          <p className="ops-empty">No receipts yet.</p>
          <Link className="btn ops-tap" to="/money?new=1">Log a gift</Link>
        </div>
      )}
      {rows.length > 0 && (
        <ul className="ops-rows" id="rc-list">
          {shown.map((r) => (
            <ReceiptRow key={r.id} r={r} open={openId === r.id} busy={busy === r.id}
              onToggle={() => setOpenId((cur) => (cur === r.id ? null : r.id))} onSend={() => sendOne(r)} onSendVoid={() => sendVoid(r)} />
          ))}
        </ul>
      )}
      {rows.length > LATEST && (
        <button type="button" className="ops-more disclose" aria-expanded={all} aria-controls="rc-list"
          onClick={() => setAll((v) => !v)}>
          All receipts · {rows.length}
        </button>
      )}

      {canManage && (
        <div className="ops-foot">
          <button type="button" className="ops-more disclose" aria-expanded={more} aria-controls="rc-more-body"
            onClick={() => setMore((v) => !v)}>
            More
          </button>
          {more && (
            <div id="rc-more-body" className="ops-more-body rc-more">
              <button type="button" className="btn btn-quiet ops-tap" onClick={() => { setMore(false); setParams({ settings: '1' }); }}>
                Settings
              </button>
              <div className="rc-dl" role="group" aria-label={`Disclosure (over ${fmtBig(settings?.disclosure_cents ?? 10000)})`}>
                <span className="ops-donate__label">Disclosure (over {fmtBig(settings?.disclosure_cents ?? 10000)})</span>
                <select className="input rc-period" aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)}>
                  {(data?.periods ?? [{ key: 'campaign', label: 'This campaign' }]).map((p) => (
                    <option key={p.key} value={p.key}>{p.from ? periodWord(p) : p.label}</option>
                  ))}
                </select>
                <a className="btn btn-quiet ops-tap" href={`/api/receipts/disclosure.csv?period=${encodeURIComponent(period)}`} download
                  aria-label="Download the disclosure for a spreadsheet">
                  Download for a spreadsheet
                </a>
              </div>
              <div className="rc-dl" role="group" aria-label="All receipts">
                <span className="ops-donate__label">All receipts</span>
                <a className="btn btn-quiet ops-tap" href="/api/receipts/register.csv" download
                  aria-label="Download all receipts for a spreadsheet">
                  Download for a spreadsheet
                </a>
              </div>
              {data?.sampleLoaded && <p className="ops-meta">Sample gifts are left out.</p>}
            </div>
          )}
        </div>
      )}

      {toast && <div className="toast ops-toast" role="status"><span>{toast}</span></div>}
    </div>
  );
}
