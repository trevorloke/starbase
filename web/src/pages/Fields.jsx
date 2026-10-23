// Profile fields (managers) — /people/fields, from People → More.
//   Title "Profile fields", one yellow "Add a field" (a name, a kind — Text ·
//   Yes/No · Pick one · Number · Date — its choices, and "Volunteers can see
//   this", off). Then the fields in the order profiles show them: name, kind,
//   how many are filled in, "Volunteers see it". Tap one to rename it, add a
//   choice, change its kind, flip the volunteers switch, move it, or take it
//   off ("Take off? Everything filled in is kept." Yes · No). Its kind is free
//   while nothing is filled in; after that it can only become Text (the line
//   under the kinds says so, and the server refuses anything else). A choice
//   someone has can't be dropped. "Taken off · N" under the list brings one
//   back. Staff and treasurers fill fields in on profiles; this screen is
//   the manager's (the server refuses anyone else's changes too). With no
//   signal it keeps its title and says so; changes are off ("Changing
//   fields needs signal").
import { useId, useRef, useState } from 'react';
import { Link, Navigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action } from '../api.js';
import { NeedsSignalLine, NoSignal, noSignal, useOnline } from '../components/NoSignal.jsx';
import { FIELDS_QUERY, KINDS, KIND_LABEL } from '../components/FieldsBits.jsx';
import './shifts.css';
import './surveys.css';
import './fields.css';

const CHOICES_MAX = 30;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function VolunteersSwitch({ on, onChange, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} className="sv-switch fd-switch" disabled={disabled}
      onClick={() => onChange(!on)}>
      <span className="sv-switch__track" aria-hidden="true"><span className="sv-switch__dot" /></span>
      <span className="sv-switch__label">Volunteers can see this</span>
    </button>
  );
}

// initial: the field as GET /fields has it (editing), or null (adding).
// A choice someone has is decided once, when the form opens: it shows as
// words with its count (no ✕). Every other row — added or unused — stays an
// input with ✕, whatever is typed in it (a twin is caught on Save).
function FieldForm({ initial = null, primary = false, submitLabel, busy, onSubmit, onCancel }) {
  const uid = useId();
  const used = new Map((initial?.uses || []).map((u) => [u.value, u.n]));
  const nextKey = useRef(0);
  const row = (words, kept = false) => ({ words, kept, key: nextKey.current++ });
  const [name, setName] = useState(initial?.name || '');
  const [kind, setKind] = useState(initial?.kind || 'text');
  const [choices, setChoices] = useState(() => (initial?.kind === 'choice'
    ? initial.choices.map((c) => row(c, (used.get(c) || 0) > 0))
    : [row(''), row('')]));
  const [volunteers, setVolunteers] = useState(Boolean(initial?.volunteers));
  const [error, setError] = useState(null);
  const filled = initial?.filled || 0;
  const kindLocked = filled > 0;
  const setChoice = (key, v) => setChoices((list) => list.map((x) => (x.key === key ? { ...x, words: v } : x)));
  const removable = choices.length > 2;

  const submit = async (e) => {
    e.preventDefault();
    const clean = choices.map((c) => c.words.trim()).filter(Boolean);
    if (!name.trim()) { setError('Add a name'); return; }
    if (kind === 'choice' && clean.length < 2) { setError('Add at least two choices'); return; }
    setError(null);
    const input = {};
    if (!initial || name.trim() !== initial.name) input.name = name.trim();
    if (!initial || kind !== initial.kind) input.kind = kind;
    if (kind === 'choice' && (!initial || kind !== initial.kind || !sameList(clean, initial.choices))) input.choices = clean;
    if (!initial ? volunteers : volunteers !== initial.volunteers) input.volunteers = volunteers;
    const err = await onSubmit(input);
    if (err) setError(err);
  };

  // Why the kinds are as they are, in one line.
  const kindLine = !kindLocked ? null
    : kind === initial.kind
      ? `Filled in for ${plural(filled, 'person', 'people')} — ${initial.kind === 'text' ? 'its type stays Text' : 'it can only become Text'}`
      : `Changes ${filled} to text — nothing is lost`;

  return (
    <form className={`sv-qform fd-fform${primary ? ' card' : ''}`} onSubmit={submit} aria-label={submitLabel}>
      <div className="field">
        <label htmlFor={`${uid}-name`}>Name</label>
        <input id={`${uid}-name`} className="input fd-input" required autoFocus={!initial} maxLength={60} autoComplete="off"
          placeholder="Language at home" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <span className="sv-label" id={`${uid}-kind`}>Type</span>
        <div className="sv-kinds" role="group" aria-labelledby={`${uid}-kind`}>
          {KINDS.map((k) => (
            <button key={k.code} type="button" className="sv-kind" aria-pressed={kind === k.code}
              disabled={kindLocked && k.code !== initial.kind && k.code !== 'text'} onClick={() => setKind(k.code)}>
              {k.label}
            </button>
          ))}
        </div>
        {kindLine && <p className="fd-why muted">{kindLine}</p>}
      </div>
      {kind === 'choice' && (
        <div className="field sv-choices">
          <span className="sv-label">Choices</span>
          {choices.map((c, i) => {
            // A choice someone has keeps its words (they're what's on file).
            if (c.kept) {
              return (
                <div className="sv-choice fd-choice--kept" key={c.key}>
                  <span className="fd-choice__words">{c.words}</span>
                  <span className="fd-choice__n mono">{used.get(c.words) || 0} filled in</span>
                </div>
              );
            }
            return (
              <div className="sv-choice" key={c.key}>
                <input className="input" aria-label={`Choice ${i + 1}`} maxLength={80} autoComplete="off"
                  value={c.words} onChange={(e) => setChoice(c.key, e.target.value)} />
                {removable && (
                  <button type="button" className="btn btn-quiet sv-choice__x" aria-label={`Remove choice ${i + 1}`}
                    onClick={() => setChoices((list) => list.filter((x) => x.key !== c.key))}>✕</button>
                )}
              </div>
            );
          })}
          {choices.length < CHOICES_MAX && (
            <button type="button" className="btn btn-quiet ops-tap sv-choice__add" onClick={() => setChoices((list) => [...list, row('')])}>
              + Add a choice
            </button>
          )}
        </div>
      )}
      <VolunteersSwitch on={volunteers} onChange={setVolunteers} disabled={busy} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="ops-actions">
        <button type="submit" className={`btn ops-tap ${primary ? 'btn-primary' : 'ops-solid'}`} disabled={busy}>{submitLabel}</button>
        <button type="button" className="btn btn-quiet ops-tap" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

const rowSub = (f) => [
  KIND_LABEL[f.kind],
  `${f.filled} filled in`,
  f.volunteers ? 'Volunteers see it' : null,
].filter(Boolean).join(' · ');

function FieldRow({ f, index, total, open, busy, onToggle, onSave, onMove, onRetire }) {
  const [confirm, setConfirm] = useState(false);
  const bodyId = `fd-f-${f.id}`;
  return (
    <li className="ops-item fd-item" data-open={open ? '' : undefined}>
      <button type="button" className="ops-row" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="ops-row__main">
          <span className="ops-row__name">{f.name}</span>
          <span className="ops-row__sub">{rowSub(f)}</span>
        </span>
      </button>
      {open && (
        <div className="ops-body" id={bodyId}>
          <FieldForm initial={f} submitLabel="Save" busy={busy} onSubmit={onSave} onCancel={onToggle} />
          <div className="ops-actions sv-qmove">
            <button type="button" className="btn ops-tap" disabled={busy || index === 0} onClick={() => onMove(-1)}>Move up</button>
            <button type="button" className="btn ops-tap" disabled={busy || index === total - 1} onClick={() => onMove(1)}>Move down</button>
            {confirm ? (
              <span className="ops-confirm" role="group" aria-label="Take off this field">
                <span>Take off? Everything filled in is kept.</span>
                <button type="button" className="btn ops-tap sv-danger" disabled={busy} onClick={onRetire}>Yes</button>
                <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(false)}>No</button>
              </span>
            ) : (
              <button type="button" className="btn btn-quiet ops-tap" onClick={() => setConfirm(true)}>Take off</button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function TakenOff({ fields, busy, onRestore }) {
  const [open, setOpen] = useState(false);
  if (!fields.length) return null;
  return (
    <div className="ops-foot">
      <button type="button" className="ops-more disclose" aria-expanded={open} aria-controls="fd-off" onClick={() => setOpen((v) => !v)}>
        Taken off · {fields.length}
      </button>
      {open && (
        <ol id="fd-off" className="ops-rows ops-more-body" aria-label="Taken off">
          {fields.map((f) => (
            <li key={f.id} className="ops-item" data-tone="past">
              <div className="ops-row ops-row--static">
                <span className="ops-row__main">
                  <span className="ops-row__name">{f.name}</span>
                  <span className="ops-row__sub">{KIND_LABEL[f.kind]} · {f.filled} filled in</span>
                </span>
                <span className="ops-row__end">
                  <button type="button" className="btn ops-tap" disabled={busy} onClick={() => onRestore(f)}>Bring back</button>
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function Fields() {
  const { me } = useOutletContext() ?? {};
  const [params, setParams] = useSearchParams();
  const adding = params.get('add') === '1';
  const queryClient = useQueryClient();
  const q = useQuery({ ...FIELDS_QUERY, enabled: me?.role === 'manager' });
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [said, setSaid] = useState(null);
  const online = useOnline();

  if (me?.role !== 'manager') return <Navigate to="/people" replace />;

  // Every change is one action; a refusal shows in place, in the server's words.
  const run = async (name, input, done) => {
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const res = await action(name, input);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['fields'] }),
        queryClient.invalidateQueries({ queryKey: ['person'] }),
      ]);
      if (done) setSaid(done);
      return { res };
    } catch (e) {
      return { error: e.message };
    } finally {
      setBusy(false);
    }
  };
  const inPlace = async (name, input, done) => {
    const r = await run(name, input, done);
    if (r.error) setError(r.error);
    return r;
  };

  const back = <Link to="/people" className="ops-back">← People</Link>;
  // The same head whatever the list's state: where you are, then why it's empty.
  const head = <>{back}<div className="ops-head"><h1>Profile fields</h1></div></>;
  if (noSignal(q)) return <div className="ops-page fd-page">{head}<NoSignal /></div>;
  if (q.isPending) return <div className="ops-page fd-page">{head}<p className="muted">Loading…</p></div>;
  if (q.isError) return <div className="ops-page fd-page">{head}<p className="error" role="alert">{q.error.message}</p></div>;
  // No signal: the list as last loaded here, every change off.
  const locked = busy || !online;
  const all = q.data.fields || [];
  const live = all.filter((f) => !f.retired);
  const off = all.filter((f) => f.retired);

  const add = async (input) => {
    const r = await run('field.create', input, `✓ Added “${input.name}”`);
    if (r.res) setParams({}, { replace: true });
    return r.error;
  };
  const save = (f) => async (input) => {
    if (!Object.keys(input).length) { setOpenId(null); return null; }
    const r = await run('field.update', { id: f.id, ...input }, '✓ Saved');
    if (r.res) setOpenId(null);
    return r.error;
  };
  const move = (i, by) => {
    const ids = live.map((x) => x.id);
    const [moved] = ids.splice(i, 1);
    ids.splice(i + by, 0, moved);
    inPlace('field.reorder', { ids });
  };
  const retire = async (f) => {
    const r = await inPlace('field.retire', { id: f.id }, `✓ Took off “${f.name}” — kept what’s filled in`);
    if (r.res) setOpenId(null);
  };

  return (
    <div className="ops-page fd-page">
      {back}
      <div className="ops-head">
        <h1>Profile fields</h1>
        {!adding && (
          <button type="button" className="btn btn-primary ops-tap" disabled={!online}
            onClick={() => { setOpenId(null); setSaid(null); setParams({ add: '1' }); }}>
            Add a field
          </button>
        )}
      </div>
      {!online && <NeedsSignalLine>Changing fields needs signal</NeedsSignalLine>}

      {said && <p className="ops-done" role="status">{said}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {adding && (
        <FieldForm key={`add-${live.length}`} primary submitLabel="Add field" busy={locked}
          onSubmit={add} onCancel={() => setParams({})} />
      )}

      {live.length === 0 ? (
        !adding && <p className="ops-empty">No fields yet.</p>
      ) : (
        <ol className="ops-rows" aria-label="Fields">
          {live.map((f, i) => (
            <FieldRow
              key={f.id}
              f={f}
              index={i}
              total={live.length}
              open={openId === f.id}
              busy={locked}
              onToggle={() => { setError(null); setOpenId((cur) => (cur === f.id ? null : f.id)); }}
              onSave={save(f)}
              onMove={(by) => move(i, by)}
              onRetire={() => retire(f)}
            />
          ))}
        </ol>
      )}

      <TakenOff fields={off} busy={locked} onRestore={(f) => inPlace('field.restore', { id: f.id }, `✓ “${f.name}” is back`)} />
    </div>
  );
}
