// Profile fields on the screens that aren't theirs (the manager's own screen
// is pages/Fields.jsx):
//
//   usePersonFields(id) / <PersonFields key={person.id} query personId />
//       the profile's "More details". The desk fills each field in with the
//       right control — Yes/No and Pick one as 48px tap buttons, Text, Number
//       and Date as inputs — and one Save (a field.values.set action, "✓
//       Saved"). A volunteer gets the filled-in fields a manager marked for
//       volunteers, read-only: the server sends nothing else. With no signal
//       the kept copy shows read-only ("Changing these needs signal"), or
//       the No signal line when nothing is kept. Keyed by person: nothing
//       typed or saved on one profile follows a link to the next.
//   <FieldFilterGroups chip />  People → Filter → More filters: one group per
//       field (Yes · No, its choices, the most common words, Filled in);
//       picks ?field=<id>:<value>, the same chip helper as every filter.
//   <FieldFilterChip value onRemove />  the removable chip for that filter,
//       "Language at home: Punjabi" — a volunteer reads the one field's name
//       (only one marked for them); unknown, "Profile field: Yes".
//   useImportFields() / FIELD_KEY / fieldCell   the import's column choices.
import { useId, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { action, apiGet } from '../api.js';
import { NeedsSignalLine, NoSignal, noSignal, useOnline } from './NoSignal.jsx';
import './survey-questions.css';
import './fields-bits.css';

export const KINDS = [
  { code: 'text', label: 'Text' },
  { code: 'yesno', label: 'Yes/No' },
  { code: 'choice', label: 'Pick one' },
  { code: 'number', label: 'Number' },
  { code: 'date', label: 'Date' },
];
export const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.code, k.label]));
const TEXT_MAX = 500;

// "2024-02-29" → "Feb 29, 2024" (the day as stored, never shifted by a time zone).
export const fmtDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return String(s ?? '');
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    .toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};
// A stored value in words.
export const fieldWords = (kind, v) => {
  if (v === null || v === undefined || v === '') return '';
  if (kind === 'yesno') return v === true ? 'Yes' : v === false ? 'No' : String(v);
  if (kind === 'date') return fmtDay(v);
  if (kind === 'number') return Number(v).toLocaleString('en-CA', { maximumFractionDigits: 6 });
  return String(v);
};

// The desk's list of fields (counts, common values) — also the filter and import's.
export const FIELDS_QUERY = { queryKey: ['fields'], queryFn: () => apiGet('/fields'), staleTime: 30_000 };
export const useFieldsList = (enabled = true) => useQuery({ ...FIELDS_QUERY, enabled, retry: false });

// ── The profile ──
export function usePersonFields(personId) {
  return useQuery({
    queryKey: ['person', personId, 'fields'],
    queryFn: () => apiGet(`/persons/${personId}/fields`),
    enabled: Boolean(personId),
    staleTime: 30_000,
  });
}
export const filledCount = (query) => (query.data?.fields || []).filter((f) => f.value !== null && f.value !== undefined).length;

// What goes in a draft for each stored value (inputs hold strings).
const draftOf = (f) => {
  if (f.value === null || f.value === undefined) return f.kind === 'yesno' || f.kind === 'choice' ? null : '';
  if (f.kind === 'yesno' || f.kind === 'choice') return f.value;
  return String(f.value);
};
const sameDraft = (f, d) => {
  const a = draftOf(f);
  return typeof a === 'string' ? a.trim() === String(d ?? '').trim() : a === d;
};

function Taps({ id, label, options, value, onPick, disabled }) {
  return (
    <div className="sv-q fd-q" role="group" aria-labelledby={id}>
      <p className="sv-q__text fd-q__label" id={id}>{label}</p>
      <div className="sv-q__opts">
        {options.map((o) => (
          <button key={String(o.v)} type="button" className={`sv-opt${value === o.v ? ' is-on' : ''}`}
            aria-pressed={value === o.v} disabled={disabled} onClick={() => onPick(value === o.v ? null : o.v)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function FieldControl({ f, value, onChange, disabled }) {
  const id = useId();
  if (f.kind === 'yesno') {
    return <Taps id={id} label={f.name} value={value} onPick={onChange} disabled={disabled}
      options={[{ v: true, label: 'Yes' }, { v: false, label: 'No' }]} />;
  }
  if (f.kind === 'choice') {
    // A value whose choice was since taken off still shows, picked.
    const choices = f.choices.includes(value) || value == null ? f.choices : [...f.choices, value];
    return <Taps id={id} label={f.name} value={value} onPick={onChange} disabled={disabled}
      options={choices.map((c) => ({ v: c, label: c }))} />;
  }
  const kind = {
    text: { type: 'text', maxLength: TEXT_MAX },
    number: { type: 'text', inputMode: 'decimal' },
    date: { type: 'date' },
  }[f.kind] || { type: 'text' };
  return (
    <div className="sv-q fd-q">
      <label className="sv-q__text fd-q__label" htmlFor={id}>{f.name}</label>
      <input id={id} className="input sv-q__input" autoComplete="off" disabled={disabled} {...kind}
        value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// saved / setSaved live in PersonFields: the form starts fresh from the
// server's values after a save, and "✓ Saved" must outlast that.
// With no signal (online false) it is read-only: what's kept (or typed and
// not saved yet) stays on screen, every control off, and one line says so.
function PersonFieldsForm({ fields, personId, saved, setSaved, online }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => Object.fromEntries(fields.map((f) => [f.id, draftOf(f)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const changed = fields.filter((f) => !sameDraft(f, draft[f.id]));
  const set = (fid, v) => { setSaved(false); setError(null); setDraft((d) => ({ ...d, [fid]: v })); };
  const off = busy || !online;

  const save = async (e) => {
    e.preventDefault();
    if (!changed.length || !online) return;
    setBusy(true);
    setError(null);
    try {
      const res = await action('field.values.set', {
        person_id: personId,
        values: changed.map((f) => {
          const v = draft[f.id];
          return { field_id: f.id, value: typeof v === 'string' ? (v.trim() || null) : v };
        }),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['person', personId, 'fields'] }),
        queryClient.invalidateQueries({ queryKey: ['fields'] }),
        queryClient.invalidateQueries({ queryKey: ['persons'] }),
      ]);
      // Each value as the server stored it ("1,200" is 1200): a save that
      // changed nothing on file still reads as saved, not as waiting.
      const stored = new Map((res?.values || []).map((v) => [v.field_id, v.value]));
      setDraft((d) => {
        const next = { ...d };
        for (const f of fields) if (stored.has(f.id)) next[f.id] = draftOf({ ...f, value: stored.get(f.id) });
        return next;
      });
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="fd-form" onSubmit={save} aria-label="More details">
      {!online && <NeedsSignalLine>Changing these needs signal</NeedsSignalLine>}
      {fields.map((f) => (
        <FieldControl key={f.id} f={f} value={draft[f.id]} disabled={off} onChange={(v) => set(f.id, v)} />
      ))}
      <div className="fd-foot">
        <button type="submit" className="btn fd-save" disabled={off || !changed.length}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <span className="fd-said" role="status">{saved && !changed.length ? '✓ Saved' : ''}</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

export function PersonFields({ query, personId }) {
  const [saved, setSaved] = useState(false);
  const online = useOnline();
  // No signal and nothing kept: say so, never a "Loading…" that doesn't end.
  if (noSignal(query)) return <NoSignal />;
  if (query.isPending) return <p className="muted">Loading…</p>;
  if (query.isError) return <p className="error">{query.error.message}</p>;
  const { fields = [], edit } = query.data || {};
  if (!edit) {
    return (
      <ul className="contact-lines fd-read">
        {fields.map((f) => (
          <li key={f.id}>
            <span className="k">{f.name}</span>
            <span className="v">{fieldWords(f.kind, f.value)}</span>
          </li>
        ))}
      </ul>
    );
  }
  // A fresh form whenever the saved values change (after Save, or another desk's).
  const version = fields.map((f) => `${f.id}=${JSON.stringify(f.value)}`).join('|');
  return <PersonFieldsForm key={version} fields={fields} personId={personId} saved={saved} setSaved={setSaved} online={online} />;
}

// ── People: filter by one field's value ──
const filterOptions = (f) => {
  if (f.kind === 'yesno') return [['yes', 'Yes'], ['no', 'No']];
  if (f.kind === 'choice') return f.choices.map((c) => [c, c]);
  const common = (f.common || []).map((c) => [String(c.value), fieldWords(f.kind, c.value)]);
  if (f.kind === 'date') return [['*', 'Filled in']];
  return f.kind === 'text' ? [...common, ['*', 'Filled in']] : common.length ? common : [['*', 'Filled in']];
};

export function FieldFilterGroups({ chip }) {
  const list = useFieldsList();
  const fields = (list.data?.fields || []).filter((f) => !f.retired);
  if (!fields.length) return null;
  return fields.map((f) => (
    <fieldset key={f.id} className="pp-group">
      <legend className="eyebrow">{f.name}</legend>
      <div className="pp-group__opts">
        {filterOptions(f).map(([v, label]) => chip('field', `${f.id}:${v}`, label))}
      </div>
    </fieldset>
  ));
}

// "Language at home: Punjabi" — or "Profile field: Yes" when the field's
// name can't be read here (no signal, or one volunteers can't see).
const filterId = (value) => {
  const s = String(value || '');
  const at = s.indexOf(':');
  return at < 0 ? s : s.slice(0, at);
};
export const fieldFilterLabel = (value, fields) => {
  const s = String(value || '');
  const at = s.indexOf(':');
  const id = filterId(s);
  const v = at < 0 ? '*' : s.slice(at + 1);
  const f = (fields || []).find((x) => x.id === id);
  if (v === '*') return f ? `${f.name}: Filled in` : 'Profile field: Filled in';
  if (!f) return `Profile field: ${/^(yes|true)$/i.test(v) ? 'Yes' : /^(no|false)$/i.test(v) ? 'No' : v}`;
  const word = f.kind === 'yesno' ? (/^y/i.test(v) ? 'Yes' : 'No') : fieldWords(f.kind, f.kind === 'number' ? Number(v) : v);
  return `${f.name}: ${word}`;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function FieldFilterChip({ value, onRemove, desk = true }) {
  const list = useFieldsList(desk);
  // A volunteer can't read the desk's list: just this one field's name.
  const id = filterId(value);
  const one = useQuery({
    queryKey: ['fields', 'one', id],
    queryFn: () => apiGet(`/fields/${id}`),
    enabled: !desk && UUID_RE.test(id),
    retry: false,
    staleTime: 60_000,
  });
  const label = fieldFilterLabel(value, desk ? list.data?.fields : one.data?.field ? [one.data.field] : []);
  return (
    <button type="button" className="pp-fchip" aria-label={`Remove filter: ${label}`} onClick={onRemove}>
      {label}
      <svg className="pp-icon" viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );
}

// ── Import: the campaign's fields as columns to match ──
export const FIELD_KEY = 'field:';
export function useImportFields() {
  const list = useFieldsList();
  return useMemo(
    () => (list.data?.fields || []).filter((f) => !f.retired).map((f) => ({ key: `${FIELD_KEY}${f.id}`, label: f.name })),
    [list.data],
  );
}
// One CSV cell for a field column → the row the server reads ({ fields: { id: cell } }).
export const fieldCell = (row, key, v) => {
  row.fields = { ...(row.fields || {}), [key.slice(FIELD_KEY.length)]: v };
};
