// The rating scale's rules on the server: read the campaign's scale, check a
// new rating against it, and apply a manager's edit (codes never change
// meaning). The words and lookups themselves are shared/scale.js.
//
// Which ratings are taken:
//   - on the list (a step, or a candidate on "Voting for?") — always;
//   - a candidate taken off the list — only from a phone's knock (it
//     carries the phone's own key, client_id: every tap on the door card,
//     walk list, Calls and profile goes through the outbox with one) and
//     only when it was tapped within REPLAY_DAYS of them coming off (the
//     outbox sends when it was tapped, client_at; without it, when it
//     arrives). That phone showed the old list when the volunteer tapped
//     it — it may have been offline, or not yet reloaded — and the knock
//     happened, however late it reaches the server. After that, and always
//     from an import, the API without a key, or anything else, only codes
//     on the list;
//   - a code the scale never had — never.
import { normalizeScale, ratingByCode, makeCode, cleanWord, DEFAULT_STEPS, LIMITS, UNSURE_WORD } from '@starbase/shared/scale';
import { httpError } from '../../actions/util.js';

export const REPLAY_DAYS = 7;
const DAY = 86400000;
// The steps' default words and labels ("Undecided", "Strong support"…).
const STEP_WORDS = new Set(DEFAULT_STEPS.flatMap((s) => [s.word, s.label]).map((w) => w.toLowerCase()));

const parseJ = (v, fb) => (typeof v === 'string' ? JSON.parse(v) : (v ?? fb));
export const settingsOf = (row) => parseJ(row?.settings, {}) || {};

// The campaign's scale, read in the caller's transaction (contact.log's
// runAction already holds the campaign's row lock, so it can't change under it).
export const loadScale = async (q, workspaceId) => normalizeScale(settingsOf(
  (await q.query('select settings from workspaces where id = $1', [workspaceId])).rows[0],
).scale);

// null when the rating may be stored; otherwise the reason, in plain words.
// tapped: when the phone's knock was tapped (never later than now) — the
// week is counted to the tap, so a knock that waited days on a phone with
// no signal is still the knock it was.
export function ratingRefusal(scale, code, { fromPhone = false, now = Date.now(), tapped = null } = {}) {
  const r = ratingByCode(scale, code);
  if (!r || r.unknown) return `rating ${code} is not on the scale`;
  if (!r.off) return null;
  const at = Date.parse(r.off_at || '');
  const tap = tapped ? Date.parse(tapped) : NaN;
  const when = Number.isFinite(tap) ? Math.min(Number(now), tap) : Number(now);
  if (fromPhone && Number.isFinite(at) && when - at < REPLAY_DAYS * DAY) return null;
  return `${r.name} is off the list — pick again`;
}

export const checkRating = async (tx, workspaceId, code, opts) => {
  const why = ratingRefusal(await loadScale(tx, workspaceId), code, opts);
  if (why) throw httpError(400, why);
};

// A manager's save → { stored, changes }. input: { words?: { 1..4 },
// candidates?: [{ code?, name, off? }] } in list order. A candidate with a
// code is that candidate (rename, reorder, off, back on); one without is
// new and gets a code no candidate ever had. Anyone the save leaves out
// keeps their place at the end, as they were — a save never drops a code.
export function applyEdit(scale, input, now = new Date()) {
  const bad = (msg) => { throw httpError(400, msg); };
  const words = {};
  const seenWords = new Set([UNSURE_WORD.toLowerCase()]);
  for (const s of scale.steps) {
    const w = cleanWord(input.words?.[s.code] ?? s.word);
    if (!w) bad(`the words for ${s.code} are empty`);
    if (w.length > LIMITS.word) bad(`“${w}” is too long — ${LIMITS.word} letters at most`);
    if (seenWords.has(w.toLowerCase())) bad(`two steps say “${w}”`);
    seenWords.add(w.toLowerCase());
    words[s.code] = w;
  }

  const prevBy = new Map(scale.candidates.map((c) => [c.code, c]));
  const taken = new Set(scale.candidates.map((c) => c.code));
  const seen = new Set();
  const out = [];
  const changes = { added: [], renamed: [], off: [], back: [] };
  const stamp = now.toISOString();
  for (const c of input.candidates ?? scale.candidates) {
    const name = cleanWord(c.name);
    if (!name) bad('a candidate has no name');
    if (name.length > LIMITS.name) bad(`“${name}” is too long — ${LIMITS.name} letters at most`);
    if (c.code) {
      const prev = prevBy.get(c.code);
      if (!prev) bad(`${name} isn’t on this scale — reload and try again`);
      if (seen.has(c.code)) bad(`${name} is listed twice`);
      seen.add(c.code);
      const off = c.off ?? prev.off;
      out.push(off ? { code: c.code, name, off: true, off_at: prev.off ? prev.off_at || stamp : stamp } : { code: c.code, name });
      if (name !== prev.name) changes.renamed.push({ code: c.code, from: prev.name, to: name });
      if (off && !prev.off) changes.off.push(c.code);
      if (!off && prev.off) changes.back.push(c.code);
    } else {
      const code = makeCode(name, taken);
      if (!code) bad('no codes left for a new candidate');
      taken.add(code);
      seen.add(code);
      out.push({ code, name });
      changes.added.push({ code, name });
    }
  }
  for (const c of scale.candidates) {
    if (!seen.has(c.code)) out.push(c.off ? { code: c.code, name: c.name, off: true, off_at: c.off_at } : { code: c.code, name: c.name });
  }

  const offered = out.filter((c) => !c.off);
  if (offered.length > LIMITS.offered) bad(`${LIMITS.offered} candidates at most on the list`);
  if (out.length > LIMITS.total) bad(`${LIMITS.total} candidates at most, counting those off the list`);
  const names = new Map();
  for (const c of offered) {
    const k = c.name.toLowerCase();
    if (seenWords.has(k)) bad(`“${c.name}” is already a step’s words`);
    // A step's default words always read as that step in an import
    // (matchRating), whatever the step says now.
    if (STEP_WORDS.has(k)) bad(`“${c.name}” is a step’s words — pick another name`);
    if (names.has(k)) bad(`two candidates are called ${c.name}`);
    names.set(k, c);
  }
  // One name on the list and off it (two "Bains" in Voting for…, Put back
  // refused) — never made by this save. Checked for every candidate whose
  // name changed here (added or renamed, going on or off the list) and every
  // one put back. Only taking someone off never refuses: a campaign that
  // already holds such a pair can always save.
  const fresh = new Set([...changes.added, ...changes.renamed].map((c) => c.code));
  const back = new Set(changes.back);
  for (const c of out) {
    if (!fresh.has(c.code) && !back.has(c.code)) continue;
    const k = c.name.toLowerCase();
    const o = out.find((x) => x.code !== c.code && (x.off || c.off) && x.name.toLowerCase() === k);
    if (!o) continue;
    // A new name on the list matching someone off it: their old ratings are theirs.
    if (!c.off && fresh.has(c.code)) bad(`${o.name} is off the list — put them back instead`);
    if (!c.off) bad(`another ${c.name} is off the list — rename this one`);
    if (!o.off) bad(`${o.name} is already on the list — pick another name`);
    bad(`another ${o.name} is off the list — pick another name`);
  }
  return { stored: { v: (scale.version || 0) + 1, words, candidates: out }, changes };
}
