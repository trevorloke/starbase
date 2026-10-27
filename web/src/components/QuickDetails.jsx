// The basics, fixed where you meet someone: a quiet "Fix details" under
// the phone on the door card, the Calls card and the profile opens a name,
// a phone and an email; Save goes through the offline outbox (person.details),
// so it works with no signal and sends later. A volunteer may add an email
// only where there is none (they never see one that is on file; trying
// says "On file" and that is all it says).
import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queueAction } from '../offline.js';
import { queuedText } from './queued.js';
import './quick-details.css';

const isVol = (me) => me?.role === 'volunteer';

export default function QuickDetails({ person, me, onSaved, toast, label = 'Fix details', autoOpen = false }) {
  const [open, setOpen] = useState(autoOpen);
  const [f, setF] = useState(() => ({ name: person.name || '', phone: person.phone || '', email: person.email || '' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const queryClient = useQueryClient();
  const id = useId();
  const vol = isVol(me);
  // A volunteer never learns an email is on file until they try to add one
  // (the server answers 409); then the card says so and stops asking.
  const [emailOnFile, setEmailOnFile] = useState(false);
  const reset = () => setF({ name: person.name || '', phone: person.phone || '', email: person.email || '' });
  const changed = f.name.trim() !== (person.name || '') || f.phone.trim() !== (person.phone || '') || (!emailOnFile && f.email.trim() !== (person.email || ''));

  const save = async (e) => {
    e.preventDefault();
    const input = { person_id: person.id };
    if (f.name.trim() && f.name.trim() !== person.name) input.name = f.name.trim();
    if (f.phone.trim() !== (person.phone || '')) input.phone = f.phone.trim();
    if (!emailOnFile && f.email.trim() !== (person.email || '')) input.email = f.email.trim();
    if (Object.keys(input).length === 1) { setOpen(false); return; }
    setBusy(true); setError(null);
    try {
      const r = await queueAction('person.details', input, { who: f.name.trim() || person.name });
      const next = { ...person, ...(input.name ? { name: input.name } : {}), ...('phone' in input ? { phone: input.phone || null } : {}), ...('email' in input ? { email: input.email || null } : {}) };
      queryClient.setQueryData(['person', person.id], (d) => (d?.person ? { ...d, person: { ...d.person, ...next } } : d));
      onSaved?.(next, r);
      toast?.(r?.queued ? `${queuedText(r, 'person.details')}` : `Saved ${next.name.split(' ')[0]}’s details`);
      setOpen(false);
    } catch (err) {
      if (vol && /on file/.test(err?.message || '')) { setEmailOnFile(true); setF((x) => ({ ...x, email: '' })); }
      setError(err?.message || 'Not saved — try again');
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-quiet qd-open" onClick={() => { reset(); setOpen(true); }}>
        {label}{!person.phone && !person.email ? ' · add a phone or email' : ''}
      </button>
    );
  }
  return (
    <form className="qd" onSubmit={save} aria-label={`Details for ${person.name}`}>
      <div className="qd__row">
        <label htmlFor={`${id}-n`} className="qd__label">Name</label>
        <input id={`${id}-n`} className="input" value={f.name} maxLength={300} autoComplete="off" onChange={(e) => setF({ ...f, name: e.target.value })} />
      </div>
      <div className="qd__row">
        <label htmlFor={`${id}-p`} className="qd__label">Phone</label>
        <input id={`${id}-p`} className="input mono" type="tel" inputMode="tel" value={f.phone} maxLength={40} placeholder="604-555-0100" autoComplete="off" autoFocus={!person.phone}
          onChange={(e) => setF({ ...f, phone: e.target.value })} />
      </div>
      <div className="qd__row">
        <label htmlFor={`${id}-e`} className="qd__label">Email</label>
        {emailOnFile
          ? <span className="muted qd__onfile">On file — the office can change it</span>
          : <input id={`${id}-e`} className="input" type="email" inputMode="email" value={f.email} maxLength={320} placeholder="name@example.com" autoComplete="off"
            onChange={(e) => setF({ ...f, email: e.target.value })} />}
      </div>
      {error && <p className="error qd__error" role="alert">{error}</p>}
      <div className="qd__acts">
        <button type="submit" className="btn btn-primary" disabled={busy || !changed || !f.name.trim()}>Save</button>
        <button type="button" className="btn btn-quiet" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
      </div>
    </form>
  );
}
