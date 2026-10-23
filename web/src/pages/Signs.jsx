// Signs — every sign, from lawn sign to billboard. One set of words for
// everyone: To put up · Up · Taken down; Lawn sign · Large sign · Billboard.
//   Desk: three big counters (To put up · Up · Taken down) are the status
//   filter. It opens on To put up — the to-do list — when any are waiting;
//   tap the pressed counter again for every sign (?status=all). The kind
//   toggle sits under "More". Both live in the URL (?status=, ?kind=). Rows:
//   address, kind chip, status chip. Tap a row for the supporter, directions,
//   the status switch and the note. A status change says so in a toast with
//   Undo (the row may leave the filtered list).
//   Volunteers (the sign crew): "Signs to put up" — only the signs waiting,
//   the address opens directions, one "Put up ✓" per row (toast + Undo).
//   "Add a sign" and the full list (?all=1) sit under "More"; with nothing
//   left to put up, "Add a sign" is the one button.
//   ?new=1 opens "Add a sign" (at a supporter's address, or any address);
//   ?new=1&person=<id> preselects the supporter. Status and note sit under
//   "More details".
import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SIGN_KINDS, SIGN_STATUSES } from '@starbase/shared/canvass';
import { apiGet, action } from '../api.js';
import { PersonPicker } from './Shifts.jsx';
import { NoSignal, noSignal, useOnline, NeedsSignalLine } from '../components/NoSignal.jsx';
import './shifts.css';

// The registry label carries the size ("Large sign (4×4)"); it rides along as a tooltip.
const kindSize = (code) => SIGN_KINDS.find((k) => k.code === code)?.label ?? code;
// Most common first: lawn signs, then large, then billboards.
const KIND_ORDER = ['lawn', 'large', 'billboard'];
const KINDS = [...SIGN_KINDS].sort((a, b) => KIND_ORDER.indexOf(a.code) - KIND_ORDER.indexOf(b.code));
// The same words in the chip, the toggle and the form.
const KIND_WORD = { lawn: 'Lawn sign', large: 'Large sign', billboard: 'Billboard' };
const kindWord = (code) => KIND_WORD[code] ?? kindSize(code);
// The sign crew's words, everywhere.
const STATUS_LABEL = { requested: 'To put up', installed: 'Up', removed: 'Taken down' };
const statusLabel = (s) => STATUS_LABEL[s] ?? s;
// What a status change says in the toast.
const DONE_WORD = { requested: 'To put up', installed: 'Put up', removed: 'Taken down' };
// The sample dataset tags every note "sample"; Today already says so.
const shownNote = (n) => (n && n.trim().toLowerCase() !== 'sample' ? n : null);
// Directions to where the sign goes (the phone's maps app).
const mapsHref = (s) => {
  if (s.lat != null && s.lng != null) return `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lng}`;
  if (s.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}`;
  return null;
};
// Requested is amber outline, never the yellow of the one primary button.
const STATUS_CHIP = { requested: 'ops-chip-amber', installed: 'chip-ok', removed: 'ops-chip-muted' };
// GET /api/persons/:id 500s on a malformed uuid, so ?person=junk is ignored.
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const where = (s) => s.address || s.person_name || 'this location';

const invalidateSigns = (queryClient, personId) => {
  for (const key of ['signs', 'brief', 'doors']) queryClient.invalidateQueries({ queryKey: [key] });
  if (personId) queryClient.invalidateQueries({ queryKey: ['person', personId] });
};

// ── Note: edit in place, saves on blur / Enter ──
function NoteField({ sign, onSave }) {
  const [value, setValue] = useState(sign.note ?? '');
  const [state, setState] = useState(null); // null | 'saving' | 'saved'
  useEffect(() => { setValue(sign.note ?? ''); }, [sign.note]);
  const id = `sign-note-${sign.id}`;

  const save = async () => {
    if (value === (sign.note ?? '')) return;
    setState('saving');
    const ok = await onSave(value);
    setState(ok ? 'saved' : null);
    if (!ok) setValue(sign.note ?? '');
  };

  return (
    <div className="field">
      <label htmlFor={id}>Note {state === 'saved' && <span className="ok-text" aria-live="polite">✓ saved</span>}</label>
      <input
        id={id}
        className="input ops-note-input"
        placeholder="Add a note"
        value={value}
        onChange={(e) => { setValue(e.target.value); setState(null); }}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
      />
    </div>
  );
}

// ── One sign: a row that opens in place ──
function SignRow({ s, open, onToggle, busy, onUpdate, onCancel }) {
  const bodyId = `sign-${s.id}`;
  const [confirming, setConfirming] = useState(false);
  // A request that never went up is taken back (sign.cancel), not "taken down".
  const choices = s.status === 'requested' && onCancel ? SIGN_STATUSES.filter((st) => st !== 'removed') : SIGN_STATUSES;
  return (
    <li className="ops-item" data-open={open ? '' : undefined}>
      <button type="button" className="ops-row" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="ops-row__main">
          <span className="ops-row__name">{s.address || s.person_name || '—'}</span>
          <span className="ops-row__sub"><span className="chip" title={kindSize(s.kind)}>{kindWord(s.kind)}</span></span>
        </span>
        <span className="ops-row__end">
          <span className={`chip ops-chip-lg ${STATUS_CHIP[s.status] ?? ''}`.trim()}>{statusLabel(s.status)}</span>
        </span>
      </button>
      {open && (
        <div className="ops-body" id={bodyId}>
          {(s.person_id || mapsHref(s)) && (
            <p className="ops-chips">
              {s.person_id && <Link to={`/people/${s.person_id}`}>{s.person_name || 'Supporter'}</Link>}
              {s.person_id && mapsHref(s) && <span aria-hidden="true">·</span>}
              {mapsHref(s) && (
                <a href={mapsHref(s)} target="_blank" rel="noopener noreferrer">Directions</a>
              )}
            </p>
          )}
          <div className="ops-seg" role="group" aria-label={`Status for the sign at ${where(s)}`}>
            {choices.map((st) => (
              <button key={st} type="button" aria-pressed={s.status === st} disabled={busy}
                onClick={() => { if (s.status !== st) onUpdate({ status: st }); }}>
                {statusLabel(st)}
              </button>
            ))}
            {choices !== SIGN_STATUSES && !confirming && (
              <button type="button" disabled={busy} onClick={() => setConfirming(true)}>Cancel request</button>
            )}
          </div>
          {confirming && (
            <p className="ops-confirm" role="group" aria-label="Cancel this request">
              <span>Cancel this request?</span>
              <button type="button" className="btn ops-tap" disabled={busy}
                onClick={async () => { if (await onCancel()) setConfirming(false); }}>Yes, cancel</button>
              <button type="button" className="btn btn-quiet ops-tap" disabled={busy} onClick={() => setConfirming(false)}>No</button>
            </p>
          )}
          <NoteField sign={s} onSave={(note) => onUpdate({ note })} />
        </div>
      )}
    </li>
  );
}

// ── Sign crew: one sign waiting to go up ──
function PutUpRow({ s, busy, onPutUp }) {
  return (
    <li className="ops-item">
      <div className="ops-row ops-row--static">
        <span className="ops-row__main">
          <span className="ops-row__name">
            {mapsHref(s) ? (
              <a className="ops-addr" href={mapsHref(s)} target="_blank" rel="noopener noreferrer"
                aria-label={`Directions to ${where(s)}`}>
                {s.address || s.person_name}
              </a>
            ) : (s.address || s.person_name || '—')}
          </span>
          <span className="ops-row__sub">
            <span className="chip" title={kindSize(s.kind)}>{kindWord(s.kind)}</span>
            {shownNote(s.note) && <span className="ops-row__note">{shownNote(s.note)}</span>}
          </span>
        </span>
        <span className="ops-row__end">
          <button type="button" className="btn ops-solid ops-tap ops-putup" disabled={busy}
            aria-label={`Put up the sign at ${where(s)}`} onClick={onPutUp}>
            Put up ✓
          </button>
        </span>
      </div>
    </li>
  );
}

// ── Add a sign ──
function PlaceSignForm({ presetPersonId, canCreatePerson, onSaved, onClose }) {
  const [kind, setKind] = useState('lawn');
  const [mode, setMode] = useState('person'); // 'person' | 'address'
  const [person, setPerson] = useState(null);
  const [address, setAddress] = useState('');
  const [status, setStatus] = useState('requested');
  const [note, setNote] = useState('');
  const [more, setMore] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const preset = useQuery({
    queryKey: ['person', presetPersonId],
    queryFn: () => apiGet(`/persons/${presetPersonId}`),
    enabled: isUuid(presetPersonId),
  });
  useEffect(() => {
    if (preset.data?.person) setPerson((p) => p ?? preset.data.person);
  }, [preset.data]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const addr = address.trim();
    if (mode === 'person' && !person) { setError('Pick the supporter'); return; }
    if (mode === 'address' && !addr) { setError('Enter the address'); return; }
    setBusy(true);
    try {
      const res = await action('sign.place', {
        kind,
        status,
        person_id: mode === 'person' ? person.id : undefined,
        address: addr || undefined,
        note: note.trim() || undefined,
      });
      onSaved(res.sign, mode === 'person' ? person.id : null);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="card ops-form" onSubmit={submit} aria-label="Add a sign">
      <div className="field">
        <label id="sign-kind-label">Kind</label>
        <div className="ops-seg" role="group" aria-labelledby="sign-kind-label">
          {KINDS.map((k) => (
            <button key={k.code} type="button" aria-pressed={kind === k.code} title={k.label} onClick={() => setKind(k.code)}>
              {kindWord(k.code)}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label id="sign-where-label">Where</label>
        <div className="ops-seg" role="group" aria-labelledby="sign-where-label">
          <button type="button" aria-pressed={mode === 'person'} onClick={() => setMode('person')}>Supporter</button>
          <button type="button" aria-pressed={mode === 'address'} onClick={() => setMode('address')}>Address</button>
        </div>
      </div>

      {mode === 'person' && (
        <div className="field">
          <label htmlFor="sign-person">Supporter</label>
          {person ? (
            <div className="ops-picked">
              <span className="chip ops-chip-lg">{person.name}</span>
              <span className="ops-meta">{person.address || 'No address on file'}</span>
              <button type="button" className="btn btn-quiet ops-tap" onClick={() => setPerson(null)}>Change</button>
            </div>
          ) : (
            <PersonPicker
              id="sign-person"
              placeholder="Supporter’s name"
              meta={(p) => p.address || 'no address'}
              allowCreate={canCreatePerson}
              onPick={(p) => setPerson(p)}
            />
          )}
        </div>
      )}

      {(mode === 'address' || person) && (
        <div className="field">
          <label htmlFor="sign-address">{mode === 'address' ? 'Address' : 'Different address?'}</label>
          <input
            id="sign-address"
            className="input"
            autoComplete="street-address"
            required={mode === 'address'}
            placeholder={mode === 'address' ? '104 Ave & King George Blvd' : person?.address || 'Street address'}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          {mode === 'person' && person && !person.address && !address.trim() && (
            <span className="ops-meta">No address on file — add one here.</span>
          )}
        </div>
      )}

      <button type="button" className="ops-more disclose disclose--inline" aria-expanded={more} aria-controls="sign-more"
        onClick={() => setMore((v) => !v)}>
        More details
      </button>
      {more && (
        <div id="sign-more" className="ops-more-body">
          <div className="field">
            <label htmlFor="sign-status">Status</label>
            <select id="sign-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              {SIGN_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sign-note">Note</label>
            <input id="sign-note" className="input" placeholder="Corner lot, facing the road"
              value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className="btn btn-primary ops-tap" disabled={busy}>{busy ? 'Saving…' : 'Add a sign'}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

// ── The screen ──
export default function Signs() {
  const queryClient = useQueryClient();
  const { me } = useOutletContext() ?? {};
  // person.create is desk-only (403 for volunteers), so they can't add a new person here.
  const canCreatePerson = me?.role !== 'volunteer';
  const [params, setParams] = useSearchParams();
  const showNew = params.get('new') === '1';
  const presetPersonId = params.get('person');
  const kindFilter = params.get('kind');
  const statusParam = params.get('status');
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  // Sign crew: "Put up" toast with Undo; More (Add a sign · All signs) folded.
  const crew = me?.role === 'volunteer' && params.get('all') !== '1';
  const [toast, setToast] = useState(null);
  const [more, setMore] = useState(false);
  // Desk: the kind toggle under "More" starts open when a kind is already set.
  const [kindsOpen, setKindsOpen] = useState(() => !!params.get('kind'));
  const toastTimer = useRef(null);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const signsQ = useQuery({ queryKey: ['signs'], queryFn: () => apiGet('/signs') });
  // No signal: the last copy this sign-in loaded (components/KeptCopies.js),
  // read only — every change here needs signal.
  const online = useOnline();
  const offline = noSignal(signsQ);
  const all = signsQ.data?.signs ?? [];
  const ofKind = all.filter((s) => !kindFilter || s.kind === kindFilter);
  // The counters count within the chosen kind, so they always match the list.
  const byStatus = Object.fromEntries(SIGN_STATUSES.map((s) => [s, 0]));
  for (const s of ofKind) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  // No ?status → Requested (the to-do list) when any wait, else everything.
  const statusFilter = statusParam === 'all'
    ? null
    : (SIGN_STATUSES.includes(statusParam) ? statusParam : (byStatus.requested > 0 ? 'requested' : null));
  const rows = ofKind.filter((s) => !statusFilter || s.status === statusFilter);

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const openForm = () => {
    const next = new URLSearchParams(params);
    next.set('new', '1');
    setParams(next);
  };
  const closeForm = () => {
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('person');
    setParams(next);
  };

  const patchCache = (id, patch) => queryClient.setQueryData(['signs'], (cur) => cur && ({
    ...cur,
    signs: cur.signs.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  }));

  const update = async (sign, patch) => {
    setError(null);
    setBusyId(sign.id);
    patchCache(sign.id, patch);
    try {
      await action('sign.update', { id: sign.id, ...patch });
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusyId(null);
      invalidateSigns(queryClient, sign.person_id);
    }
  };

  const showToast = (t) => {
    clearTimeout(toastTimer.current);
    setToast(t);
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  };
  const onSaved = (sign, personId) => {
    invalidateSigns(queryClient, personId);
    showToast({ text: `✓ ${kindWord(sign.kind)} added${sign.address ? ` · ${sign.address}` : ''}` });
    closeForm();
  };
  // Every status change says what happened and where, with Undo — on a
  // filtered list the row may leave, and it must never look deleted.
  const changeStatus = async (sign, status) => {
    const prev = sign.status;
    const ok = await update(sign, { status });
    if (ok) showToast({ sign, prev, text: `✓ ${DONE_WORD[status] ?? statusLabel(status)} · ${where(sign)}` });
  };
  const putUp = (sign) => changeStatus(sign, 'installed');
  // Taking back a request that never went up: it leaves every list and count.
  const cancelRequest = async (sign) => {
    setError(null);
    setBusyId(sign.id);
    try {
      await action('sign.cancel', { id: sign.id });
      queryClient.setQueryData(['signs'], (cur) => cur && ({ ...cur, signs: cur.signs.filter((x) => x.id !== sign.id) }));
      showToast({ text: `✓ Request cancelled · ${where(sign)}` });
      setOpenId(null);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusyId(null);
      invalidateSigns(queryClient, sign.person_id);
    }
  };
  const actionsQ = useQuery({ queryKey: ['actions'], queryFn: () => apiGet('/actions'), staleTime: Infinity });
  const canCancel = Array.isArray(actionsQ.data?.actions) && actionsQ.data.actions.includes('sign.cancel');
  const undo = async () => {
    const { sign, prev } = toast;
    clearTimeout(toastTimer.current);
    setToast(null);
    await update(sign, { status: prev });
  };
  const toastEl = toast && (
    <div className="toast ops-toast" role="status">
      <span>{toast.text}</span>
      {toast.sign && <button type="button" className="btn ops-tap" onClick={undo}>Undo</button>}
    </div>
  );

  if (crew) {
    const toPutUp = all.filter((s) => s.status === 'requested');
    const empty = signsQ.isSuccess && toPutUp.length === 0;
    return (
      <div className="ops-page">
        <Link to="/" className="ops-back">← Today</Link>
        <div className="ops-head"><h1>Signs to put up</h1></div>

        {showNew && (
          <PlaceSignForm
            key={presetPersonId || 'new'}
            presetPersonId={presetPersonId}
            canCreatePerson={canCreatePerson}
            onSaved={onSaved}
            onClose={closeForm}
          />
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {offline && <NoSignal />}
        {signsQ.isPending && !offline && <p className="muted">Loading…</p>}
        {signsQ.isError && !offline && <p className="error">{signsQ.error.message}</p>}
        {!online && toPutUp.length > 0 && <NeedsSignalLine>Putting signs up needs signal</NeedsSignalLine>}
        {empty && (
          <div className="ops-empty-block">
            <p className="ops-empty">Nothing to put up right now.</p>
            {!showNew && <button type="button" className="btn btn-primary ops-tap" disabled={!online} onClick={openForm}>Add a sign</button>}
          </div>
        )}

        {toPutUp.length > 0 && (
          <ul className="ops-rows">
            {toPutUp.map((s) => (
              <PutUpRow key={s.id} s={s} busy={busyId === s.id || !online} onPutUp={() => putUp(s)} />
            ))}
          </ul>
        )}

        <div className="ops-foot">
          <button type="button" className="ops-more disclose" aria-expanded={more} aria-controls="signs-more"
            onClick={() => setMore((v) => !v)}>
            More
          </button>
          {more && (
            <div id="signs-more" className="ops-more-body ops-actions">
              {!showNew && !empty && <button type="button" className="btn ops-tap" disabled={!online} onClick={openForm}>Add a sign</button>}
              <button type="button" className="btn btn-quiet ops-tap" onClick={() => { const next = new URLSearchParams(params); next.set('all', '1'); setParams(next); }}>
                All signs · {all.length}
              </button>
            </div>
          )}
        </div>

        {toastEl}
      </div>
    );
  }

  return (
    <div className="ops-page">
      {me?.role === 'volunteer' && (
        <Link to="/signs" className="ops-back">← Signs to put up</Link>
      )}
      <div className="ops-head">
        <h1>Signs</h1>
        {!showNew && (
          <button type="button" className="btn btn-primary ops-tap" disabled={!online} onClick={openForm}>Add a sign</button>
        )}
      </div>
      {!online && <NeedsSignalLine>Adding or changing a sign needs signal</NeedsSignalLine>}

      {showNew && (
        <PlaceSignForm
          key={presetPersonId || 'new'}
          presetPersonId={presetPersonId}
          canCreatePerson={canCreatePerson}
          onSaved={onSaved}
          onClose={closeForm}
        />
      )}
      <div className="ops-counters" role="group" aria-label="Show signs by status">
        {SIGN_STATUSES.map((s) => (
          <button key={s} type="button" className="ops-counter" data-status={s} aria-pressed={statusFilter === s}
            onClick={() => setFilter('status', statusFilter === s ? 'all' : s)}>
            <span className="n">{byStatus[s] ?? 0}</span>
            <span className="l">{statusLabel(s)}</span>
          </button>
        ))}
      </div>

      <button type="button" className="ops-more ops-more--tight disclose" aria-expanded={kindsOpen} aria-controls="signs-kinds"
        onClick={() => setKindsOpen((v) => !v)}>
        More{kindFilter ? ` · ${kindWord(kindFilter)}` : ''}
      </button>
      {kindsOpen && (
        <div id="signs-kinds" className="ops-seg ops-filter" role="group" aria-label="Kind of sign">
          <button type="button" aria-pressed={!kindFilter} onClick={() => setFilter('kind', null)}>All</button>
          {KINDS.map((k) => (
            <button key={k.code} type="button" aria-pressed={kindFilter === k.code} title={k.label}
              onClick={() => setFilter('kind', kindFilter === k.code ? null : k.code)}>
              {kindWord(k.code)}
            </button>
          ))}
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {offline && <NoSignal />}
      {signsQ.isPending && !offline && <p className="muted">Loading…</p>}
      {signsQ.isError && !offline && <p className="error">{signsQ.error.message}</p>}

      {signsQ.isSuccess && all.length === 0 && <p className="ops-empty">No signs yet.</p>}
      {signsQ.isSuccess && all.length > 0 && rows.length === 0 && <p className="ops-empty">None here.</p>}

      {rows.length > 0 && (
        <ul className="ops-rows">
          {rows.map((s) => (
            <SignRow
              key={s.id}
              s={s}
              open={openId === s.id}
              onToggle={() => setOpenId((cur) => (cur === s.id ? null : s.id))}
              busy={busyId === s.id || !online}
              onUpdate={(patch) => (patch.status ? changeStatus(s, patch.status) : update(s, patch))}
              onCancel={canCancel ? () => cancelRequest(s) : undefined}
            />
          ))}
        </ul>
      )}
      {toastEl}
    </div>
  );
}
