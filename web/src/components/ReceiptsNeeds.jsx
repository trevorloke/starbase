// Receipts on Money — the pieces Money's own screen uses:
//   AddressRow       Needs you: a receipt with no home address ("Needs
//                    address" chip); tap → Street address · Save address ·
//                    Donor. Its email waits until the address is on file.
//   VoidNoticeAsk    after voiding a gift whose receipt was already emailed:
//                    "Receipt already emailed — send a void notice? Yes · No"
//   receiptNote      what the gift's toast adds: " · receipt emails in a
//                    minute" (the email waits out Undo) or " · receipt needs
//                    address" — read from the server, so it is true.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, action, fmtMoney } from '../api.js';
import { shortDate } from './ReceiptsBits.jsx';

export const receiptOf = async (giftId) => {
  try {
    return (await apiGet(`/receipts/gift/${giftId}`))?.receipt ?? null;
  } catch {
    return null;
  }
};

export const receiptNote = (r) => {
  if (!r || r.void) return '';
  if (r.status?.code === 'queued') return ' · receipt emails in a minute';
  if (r.needs_address) return ' · receipt needs address';
  return '';
};

export function AddressRow({ r, onSaved }) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const bodyId = `na-${r.id.slice(0, 8)}`;

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    if (!address.trim()) { setError('Type the street address'); return; }
    setBusy(true);
    try {
      await action('person.update', { id: r.person_id, address: address.trim().slice(0, 1000) });
      onSaved(`✓ Address saved for ${r.donor_name}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <li className="ops-item">
      <button type="button" className="ops-row" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
        <span className="ops-row__main">
          <span className="ops-row__name">{r.donor_name}</span>
          <span className="ops-row__sub">{shortDate(r.received_on)}<span className="chip chip-warn">Needs address</span></span>
        </span>
        <span className="ops-row__end"><span className="ops-row__amt">{fmtMoney(r.amount_cents)}</span></span>
      </button>
      {open && (
        <form className="ops-body" id={bodyId} onSubmit={save} aria-label={`Home address for ${r.donor_name}`}>
          <p className="ops-meta">Receipt <span className="mono">{r.number}</span> · {r.status?.line}</p>
          <div className="field">
            <label htmlFor={`${bodyId}-addr`}>Street address</label>
            <input id={`${bodyId}-addr`} className="input" maxLength={1000} autoComplete="off"
              value={address} onChange={(e) => setAddress(e.target.value)} />
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="ops-actions">
            <button type="submit" className="btn ops-solid ops-tap" disabled={busy || !r.person_id}>
              {busy ? 'Saving…' : 'Save address'}
            </button>
            {r.person_id && <Link className="btn btn-quiet ops-tap" to={`/people/${r.person_id}`}>Donor</Link>}
          </div>
        </form>
      )}
    </li>
  );
}

export function VoidNoticeAsk({ ask, onDone, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const yes = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await action('receipt.sendVoid', { id: ask.id });
      onDone(res.email === 'sent' ? `✓ Void notice sent to ${ask.name}` : 'Not sent — the email failed');
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="banner rc-voidask" role="group" aria-label="Send a void notice">
      <span>Receipt already emailed — send a void notice?</span>
      <span className="ops-confirm">
        <button type="button" className="btn ops-solid ops-tap" disabled={busy} onClick={yes}>{busy ? 'Sending…' : 'Yes'}</button>
        <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={onClose}>No</button>
      </span>
      {error && <p className="error rc-voidask__err" role="alert">{error}</p>}
    </div>
  );
}
