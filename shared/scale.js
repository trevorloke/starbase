// The campaign's own rating scale — one vocabulary for server validation and
// every screen, made from the campaign's words (workspace settings.scale).
//
// Four fixed steps: 1 · 2 · 3 · 4 (support · support · undecided · opposed).
// Ladders, Today's numbers, the People filters and the map's colours count
// on them, so they never change — only their words do ("Strong yes" →
// "Definitely"). Under 4 sits the "Voting for?" list: candidates, each with
// a code made once ("4" + 1–2 capital letters) that keeps its meaning
// forever. Renaming keeps the code; taking someone off the list keeps their
// code readable (old ratings say "Locke (off the list)") but stops offering
// it; a new candidate never gets a code that was ever used. "Not sure" (plain
// 4) always stays. With nothing saved, the scale is the default below —
// exactly the scale the app always had.
//
// Stored in settings.scale (written only by the scale.save action):
//   { v, words: { 1, 2, 3, 4 }, candidates: [{ code, name, off?, off_at? }] }
// Everything here takes the normalized scale (normalizeScale(stored)):
//   { version, steps: [{ code, band, word, label }] ×4,
//     candidates: [{ code, name, label, off, off_at }] }   // every code ever, in list order
// Codes never show on screen: buttons say the words, chips say "4 · Locke".

export const BANDS = ['support', 'undecided', 'opposed'];
const STEP_BAND = { 1: 'support', 2: 'support', 3: 'undecided', 4: 'opposed' };
export const RATING_CODE_RE = /^(?:[1-3]|4(?:[A-Z]{1,2})?)$/;
export const CANDIDATE_CODE_RE = /^4[A-Z]{1,2}$/;
export const UNSURE_WORD = 'Not sure';
export const OFF_WORDS = 'off the list';
// Field rule: a word must fit its button at 390px without being cut off.
export const LIMITS = { word: 12, name: 16, offered: 12, total: 60 };

// The band from the code alone (the steps are fixed): '1'/'2' support, '3'
// undecided, '4…' opposed; anything else null.
export const bandOf = (code) => {
  const c = String(code ?? '');
  if (!RATING_CODE_RE.test(c)) return null;
  return STEP_BAND[c[0]];
};

export const DEFAULT_STEPS = Object.freeze([
  { code: '1', band: 'support',   word: 'Strong yes', label: 'Strong support' },
  { code: '2', band: 'support',   word: 'Lean yes',   label: 'Lean support' },
  { code: '3', band: 'undecided', word: 'Undecided',  label: 'Undecided' },
  { code: '4', band: 'opposed',   word: 'Opposed',    label: 'Opposed — support unknown' },
]);
export const DEFAULT_CANDIDATES = Object.freeze([
  { code: '4D', name: 'McCallum',  label: 'Opposed — Doug McCallum supporter' },
  { code: '4B', name: 'Locke',     label: 'Opposed — Surrey Connect / Brenda Locke' },
  { code: '4F', name: 'Annis',     label: 'Opposed — Surrey First / Linda Annis' },
  { code: '4N', name: 'van Vliet', label: 'Opposed — SurreyNow / Troy van Vliet' },
  { code: '4C', name: 'Randhawa',  label: 'Opposed — Surrey Conservatives / Honveer Randhawa' },
]);
const DEFAULT_BY_CODE = new Map(DEFAULT_CANDIDATES.map((c) => [c.code, c]));

// One line of text: trimmed, inner runs of space as one.
export const cleanWord = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const key = (s) => cleanWord(s).toLowerCase();

// Stored (or already normalized) → the scale every helper takes. Never
// throws: anything unreadable falls back to the default's words, and a
// default candidate a stored list somehow lacks comes back off the list (its
// code may still be on people).
export function normalizeScale(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const words = src.words && typeof src.words === 'object' ? src.words
    : Object.fromEntries((Array.isArray(src.steps) ? src.steps : []).map((s) => [s?.code, s?.word]));
  const steps = DEFAULT_STEPS.map((d) => {
    const w = cleanWord(words[d.code]).slice(0, 40) || d.word;
    const label = w === d.word ? d.label : d.code === '4' ? `${w} — not sure who` : w;
    return { code: d.code, band: d.band, word: w, label };
  });
  const four = steps[3].word;
  const list = Array.isArray(src.candidates) ? src.candidates : DEFAULT_CANDIDATES;
  const seen = new Set();
  const candidates = [];
  const add = (c, forceOff = false) => {
    const code = String(c?.code ?? '');
    if (!CANDIDATE_CODE_RE.test(code) || seen.has(code)) return;
    seen.add(code);
    const d = DEFAULT_BY_CODE.get(code);
    const name = cleanWord(c.name).slice(0, 40) || d?.name || code;
    const off = forceOff || Boolean(c.off);
    candidates.push({
      code,
      name,
      label: d && d.name === name && four === DEFAULT_STEPS[3].word ? d.label : `${four} — ${name}`,
      off,
      off_at: off && c.off_at ? String(c.off_at) : null,
    });
  };
  list.forEach((c) => add(c));
  for (const d of DEFAULT_CANDIDATES) if (!seen.has(d.code)) add(d, true);
  return { version: Number(src.v ?? src.version) || 0, steps, candidates };
}

export const DEFAULT_SCALE = Object.freeze(normalizeScale(null));

// Lookups are per scale object, made once.
const indexes = new WeakMap();
const indexOf = (scale) => {
  let ix = indexes.get(scale);
  if (!ix) {
    ix = new Map();
    for (const s of scale.steps) ix.set(s.code, { code: s.code, short: s.code, band: s.band, label: s.label, word: s.word, name: null, off: false });
    for (const c of scale.candidates) ix.set(c.code, { code: c.code, short: c.code, band: 'opposed', label: c.label, word: c.name, name: c.name, off: c.off, off_at: c.off_at });
    indexes.set(scale, ix);
  }
  return ix;
};

// { code, short, band, label, word, name, off } — or null for no rating / not
// a rating. A candidate code this scale has never had (a hand-edited row)
// still reads as opposed: "Other (off the list)".
export function ratingByCode(scale, code) {
  if (code == null || code === '') return null;
  const c = String(code);
  const sc = scale || DEFAULT_SCALE;
  const hit = indexOf(sc).get(c);
  if (hit) return hit;
  if (!CANDIDATE_CODE_RE.test(c)) return null;
  return { code: c, short: c, band: 'opposed', label: `${sc.steps[3].word} — not on the list`, word: 'Other', name: 'Other', off: true, unknown: true };
}

// The "Voting for?" buttons: the candidates on the list, in order.
export const offeredCandidates = (scale) => scale.candidates.filter((c) => !c.off);
export const retiredCandidates = (scale) => scale.candidates.filter((c) => c.off);
// What a new rating may be: the steps and the candidates on the list.
export const offeredCodes = (scale) => [...scale.steps.map((s) => s.code), ...offeredCandidates(scale).map((c) => c.code)];
// Every code this scale can read (People's band filters reach them all).
export const allCodes = (scale) => [...scale.steps.map((s) => s.code), ...scale.candidates.map((c) => c.code)];
export const codesInBand = (scale, band) => allCodes(scale).filter((c) => bandOf(c) === band);

// ── Words ──
// Who an opposed rating backs: "Locke"; plain 4 → "Not sure"; else ''.
export function ratingWho(scale, code) {
  const r = ratingByCode(scale, code);
  if (!r || r.band !== 'opposed') return '';
  return r.name || UNSURE_WORD;
}
// The words on the button that was tapped: "Strong yes", "Undecided",
// "Opposed", "Locke".
export function ratingSay(scale, code) {
  const r = ratingByCode(scale, code);
  return r ? r.word : '';
}
// " (off the list)" after a rating no longer offered — said wherever an old
// rating shows, so nobody mistakes it for a choice they still have.
export const offTail = (r) => (r?.off ? ` (${OFF_WORDS})` : '');
// One spelling for toasts and history lines, the same as the chip and the
// button: "1 · Strong yes", "4 · Locke", "4 · Opposed", "4 · Locke (off the list)".
export function ratingText(scale, code) {
  const r = ratingByCode(scale, code);
  if (!r) return '';
  return `${r.band === 'opposed' ? '4' : r.short} · ${r.word}${offTail(r)}`;
}

// ── A value from a spreadsheet → a code ──
// "4d", "4 D", "1.0", "Strong yes", "strong support", "Locke", "not sure",
// "Opposed — Surrey Connect / Brenda Locke" (case and spaces don't matter).
// A step's default words always read too (its meaning never changes).
// → { code, off } (off: the candidate was taken off the list) or null.
export function matchRating(scale, value) {
  const raw = cleanWord(value);
  if (!raw) return null;
  const asCode = raw.replace(/\s+/g, '').toUpperCase().replace(/\.0+$/, '');
  const k = key(raw);
  const ix = indexOf(scale);
  let hit = ix.get(asCode) || null;
  if (!hit) {
    if (k === key(UNSURE_WORD)) hit = ix.get('4');
    else {
      const steps = scale.steps.map((s) => ix.get(s.code));
      hit = steps.find((r) => key(r.word) === k || key(r.label) === k)
        || steps.find((r, i) => key(DEFAULT_STEPS[i].word) === k || key(DEFAULT_STEPS[i].label) === k)
        // An offered candidate wins over an old one of the same name.
        || [...offeredCandidates(scale), ...retiredCandidates(scale)].map((c) => ix.get(c.code))
          .find((r) => key(r.name) === k || key(r.label) === k)
        || null;
    }
  }
  return hit ? { code: hit.code, off: hit.off } : null;
}

// ── A new candidate's code ──
// "4" + 1–2 capital letters from the name — the surname's first letter
// first ("Bains" → 4B), then other initials, then the surname's first letter
// with each of its others (4BA, 4BI…), then any letter, then any pair —
// never one in `taken` (every code the scale ever had).
const A_Z = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
export function makeCode(name, taken = []) {
  const used = new Set(taken);
  const words = String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .split(/[^A-Z]+/).filter(Boolean);
  const last = words[words.length - 1] || '';
  const tries = [];
  if (last) tries.push(last[0]);
  for (const w of words) tries.push(w[0]);
  if (words.length > 1) tries.push(words[0][0] + last[0]);
  for (const w of [last, ...words]) for (const ch of w.slice(1)) tries.push(w[0] + ch);
  tries.push(...A_Z);
  for (const a of A_Z) for (const b of A_Z) tries.push(a + b);
  for (const t of tries) {
    const code = `4${t}`;
    if (!used.has(code)) return code;
  }
  return null;
}
