// The five kinds of field, and how a value is checked, stored and shown.
//
//   text     a few words            stored "CUPE 402"
//   yesno    yes or no              stored true | false
//   choice   one of its choices     stored "Punjabi" (the choice's own words)
//   number   a number               stored 3 | 2.5
//   date     a calendar day         stored "2026-10-22"
//
// One parser for every way a value arrives — the profile's Save, a CSV
// import cell, a filter in the address bar — so they can never disagree.
// Yes/no reads yes · no · y · n · true · false (any case) as well as a real
// true/false; a choice matches its words in any case and stores them as the
// field spells them; a number may carry thousands commas or spaces ("1,200",
// "1 200"); a date
// is YYYY-MM-DD and must be a real day. Empty (null, "", spaces) means
// "not filled in" — saving it clears the value.

export const KINDS = ['text', 'yesno', 'choice', 'number', 'date'];
export const KIND_WORD = { text: 'Text', yesno: 'Yes/No', choice: 'Pick one', number: 'Number', date: 'Date' };
export const NAME_MAX = 60;
export const TEXT_MAX = 500;
export const CHOICE_MAX = 80;
export const CHOICES_MAX = 30;
export const FIELDS_MAX = 40;
const NUMBER_MAX = 1e12;

export const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
export const choicesOf = (f) => { const c = parseJ(f?.choices, []); return Array.isArray(c) ? c : []; };
// Names compare trimmed, case-insensitively, with runs of spaces as one.
export const nameKey = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
export const cleanName = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

const YES = new Set(['yes', 'y', 'true']);
const NO = new Set(['no', 'n', 'false']);
const NUMBER_RE = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$|^[-+]?\.\d+$/;
const SPACED_RE = /^[-+]?\d{1,3}(\s\d{3})+(\.\d+)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const quote = (v) => `“${String(v).length > 40 ? `${String(v).slice(0, 40)}…` : String(v)}”`;
const listChoices = (choices) => (choices.length > 6 ? `${choices.slice(0, 6).join(', ')}, …` : choices.join(', '));

export const realDate = (s) => {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};

// → { value } (as stored) | { empty: true } | { error } — the error is the
// value's problem in plain words, without the field's name.
export const parseValue = (field, raw) => {
  if (raw === null || raw === undefined) return { empty: true };
  if (typeof raw === 'object') return { error: 'isn’t a value' };
  const s = typeof raw === 'string' ? raw.trim() : raw;
  if (s === '') return { empty: true };
  switch (field.kind) {
    case 'text': {
      const t = String(s).replace(/\s+/g, ' ');
      return t.length > TEXT_MAX ? { error: `is too long (${TEXT_MAX} characters max)` } : { value: t };
    }
    case 'yesno': {
      if (typeof s === 'boolean') return { value: s };
      const w = String(s).toLowerCase();
      if (YES.has(w)) return { value: true };
      if (NO.has(w)) return { value: false };
      return { error: `${quote(s)} isn’t yes or no` };
    }
    case 'choice': {
      const choices = choicesOf(field);
      const hit = choices.find((c) => nameKey(c) === nameKey(s));
      return hit ? { value: hit } : { error: `${quote(s)} isn’t one of the choices (${listChoices(choices)})` };
    }
    case 'number': {
      if (typeof s === 'number') {
        return Number.isFinite(s) && Math.abs(s) < NUMBER_MAX ? { value: s } : { error: `${quote(s)} isn’t a number` };
      }
      // Spaces only as thousands separators ("1 200", "1 200 000"): "1 2 3"
      // or "12 5" is a typo, never 123 or 125.
      const t = SPACED_RE.test(String(s)) ? String(s).replace(/\s/g, '') : String(s);
      if (!NUMBER_RE.test(t)) return { error: `${quote(s)} isn’t a number` };
      const n = Number(t.replace(/,/g, ''));
      return Number.isFinite(n) && Math.abs(n) < NUMBER_MAX ? { value: n } : { error: `${quote(s)} is too big` };
    }
    case 'date':
      return typeof s === 'string' && realDate(s) ? { value: s } : { error: `${quote(s)} isn’t a date like 2026-10-22` };
    default:
      return { error: 'isn’t a value' };
  }
};

// The same problem with the field's name in front:
//   “Language at home”: “Klingon” isn’t one of the choices (…)
//   “Union local” is too long (500 characters max)
export const valueError = (field, error) => (/^isn?’?t? /.test(error)
  ? `“${field.name}” ${error}`
  : `“${field.name}”: ${error}`);

// A stored value in words: Yes / No, 2.5, 2026-10-22, the text or choice.
export const showValue = (kind, v) => {
  if (v === null || v === undefined) return '';
  if (kind === 'yesno') return v === true ? 'Yes' : v === false ? 'No' : String(v);
  return String(v);
};

// Two stored values are the same value (no event for a save that changes nothing).
export const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
