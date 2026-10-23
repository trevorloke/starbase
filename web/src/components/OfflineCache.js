// Phone copies: what a field screen last loaded, kept on this phone so a
// volunteer who loses signal can still see and work it — the map's doors,
// the Calls list, the shifts (list and each one opened), what this sign-in
// may do, and the map's tile settings. (Walk lists keep their own copy in
// pages/Turfs.jsx.)
//
//   const copy = phoneCopy(me, 'doors');            // before useQuery
//   const q = useQuery({ queryKey, queryFn, ...copy });
//   useKeepCopy(me, 'doors', q);                     // after it
//   showingCopy(q)  → the data on screen came from the phone, not the server
//
// Keyed by workspace + user, so another sign-in on a shared phone never reads
// them; a day old at most (shown, and stored: each app start drops older
// ones); each copy ≤ ~1.5 MB and all of them ≤ ~3 MB (oldest out first).
// Sign-out — or a sign-in the server says is over — forgets them all
// (forgetPhoneCopies), and each app start drops anyone else's and anything
// kept under another role (keepOnlyMine: a staff member made a volunteer
// keeps none of what staff saw). Volunteers' copies hold only what the
// server already let them see (forViewer).
//
// A copy is never taken as fresh: with signal the screen asks the server
// first (a knock a moment before a reload is never hidden), and what's
// waiting to be kept is written as the page goes away.
//
// Desk screens keep theirs through the same store (components/KeptCopies.js
// — no per-page code): copyKey / readCopy / writeCopy / removeCopy below,
// in this browser ('local', a day) or, for anything with money in it on a
// desk sign-in, in this tab only ('session' — gone when the tab closes).
// Sign-out forgets both.
import { useEffect } from 'react';

const PREFIX = 'starbase:copy:v1:';
// The walk list's own copies (pages/Turfs.jsx) are forgotten with these.
const FIELD_PREFIX = 'starbase:field:v1:';
const TTL = 24 * 3600 * 1000;
const ENTRY_MAX = 1_500_000; // characters of JSON
const TOTAL_MAX = 3_000_000;

const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const ss = () => { try { return globalThis.sessionStorage || null; } catch { return null; } };
const storeOf = (tier) => (tier === 'session' ? ss() : ls());
const scope = (me) => (me?.user?.id && me?.workspace?.id ? `${me.workspace.id}:${me.user.id}:` : null);
const keyFor = (me, name) => { const s = scope(me); return s ? `${PREFIX}${s}${name}` : null; };

function readEntry(key, store = ls()) {
  if (!store || !key) return null;
  try {
    const v = JSON.parse(store.getItem(key) || 'null');
    if (!v || v.data == null || !(Date.now() - v.at < TTL)) {
      if (v) store.removeItem(key);
      return null;
    }
    return v;
  } catch { return null; }
}

// { initialData, initialDataUpdatedAt, refetchOnMount } for useQuery. Lazy:
// the copy is read only when the query is first made (not on every render —
// the doors can be a megabyte), and gives undefined when there's none. Its
// time stays (the strip says when it's from), but a query holding only the
// phone's copy always asks the server when it mounts; once this session has
// loaded it, as usual.
export function phoneCopy(me, name) {
  const key = keyFor(me, name);
  let v;
  const get = () => { if (v === undefined) v = readEntry(key); return v; };
  return {
    initialData: () => get()?.data,
    initialDataUpdatedAt: () => get()?.at,
    refetchOnMount: (q) => (q.state.dataUpdateCount === 0 ? 'always' : true),
  };
}

const ours = (store = ls()) => {
  const out = [];
  if (!store) return out;
  try {
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k);
    }
  } catch { /* storage blocked */ }
  return out;
};

// When a copy was loaded: its stored text starts {"at":<ms>, (cheap to read
// without parsing a megabyte), else parsed; 0 when unreadable.
const atOf = (raw) => {
  const m = /^\{"at":(\d+)[,}]/.exec(raw || '');
  if (m) return Number(m[1]);
  try { return Number(JSON.parse(raw).at) || 0; } catch { return 0; }
};

// group: { prefix, max } — copies under that prefix (a desk sign-in's) make
// room among themselves only, so they never push the field's copies out:
// the group gets what's left of the total, up to its own max.
function writeEntry(key, data, at, store = ls(), group = null) {
  if (!store || !key) return;
  let text;
  try { text = JSON.stringify({ at, data }); } catch { return; }
  try {
    if (text.length > ENTRY_MAX) { store.removeItem(key); return; } // too big to keep
    // Make room: drop the oldest other copies until this one fits.
    const sized = (list) => list.map((k) => {
      const raw = store.getItem(k) || '';
      return { k, size: raw.length, when: atOf(raw) }; // unreadable: goes first
    }).sort((a, b) => a.when - b.when);
    const room = (list, max) => {
      let total = list.reduce((n, o) => n + o.size, 0) + text.length;
      while (total > max && list.length) {
        const o = list.shift();
        store.removeItem(o.k);
        total -= o.size;
      }
    };
    const others = ours(store).filter((k) => k !== key);
    if (group) {
      const inGroup = others.filter((k) => k.startsWith(group.prefix));
      const outside = others.filter((k) => !k.startsWith(group.prefix)).reduce((n, k) => n + (store.getItem(k) || '').length, 0);
      const max = Math.min(group.max, TOTAL_MAX - outside);
      if (text.length > max) { store.removeItem(key); return; } // no room without the field's copies
      room(sized(inGroup), max);
    } else {
      room(sized(others), TOTAL_MAX);
    }
    store.setItem(key, text);
  } catch {
    try { store.removeItem(key); } catch { /* storage blocked */ }
  }
}

// Copies waiting to be written (key → { t, run }): a moment after they
// settle, or at once when the page goes away (a reload right after a knock
// keeps the knock).
const timers = new Map();
const later = (key, write) => {
  const was = timers.get(key);
  if (was) clearTimeout(was.t);
  const run = () => { timers.delete(key); write(); };
  timers.set(key, { t: setTimeout(run, 800), run });
};
const stopTimers = () => {
  for (const { t } of timers.values()) clearTimeout(t);
  timers.clear();
};
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const { t, run } of [...timers.values()]) { clearTimeout(t); run(); }
  });
}
// Keep q's data on the phone (a moment after it settles — the map refetches
// after every knock), and forget a copy the server now refuses (403/404).
export function useKeepCopy(me, name, q) {
  const key = keyFor(me, name);
  const { status, data, dataUpdatedAt, error } = q;
  useEffect(() => {
    if (!key || status !== 'success' || data == null || !dataUpdatedAt) return;
    later(key, () => writeEntry(key, data, dataUpdatedAt));
  }, [key, status, data, dataUpdatedAt]);
  const code = error?.status;
  useEffect(() => {
    if (key && (code === 403 || code === 404)) { try { ls()?.removeItem(key); } catch { /* blocked */ } }
  }, [key, code]);
}

// The screen is showing the phone's copy: no signal (the phone says so, or the
// fetch is paused), or the server didn't answer.
const offlineNow = () => typeof navigator !== 'undefined' && navigator.onLine === false;
export const showingCopy = (q) => Boolean(q?.data)
  && (offlineNow() || q.fetchStatus === 'paused' || (q.isError && !q.error?.status));

// Bumped at sign-out, so a load that was on its way for the last sign-in is
// never kept for the next (components/KeptCopies.js).
let generation = 0;
// keep: { scope, role, all } — the signed-in person's copies stay, except
// any kept under another role (q:<role>:…, or every one of theirs when
// their role changed: all), and any more than a day old (the campaign's
// rating scale stays: it holds no one's details, and an old list beats the
// default one). No keep: every copy goes.
const forget = (keep) => {
  if (!keep) generation += 1;
  stopTimers();
  for (const store of [ls(), ss()]) {
    if (!store) continue;
    try {
      // Every key first, then remove: removing while scanning can reorder them.
      const all = [];
      for (let i = 0; i < store.length; i += 1) all.push(store.key(i));
      for (const k of all) {
        if (!k || !(k.startsWith(PREFIX) || k.startsWith(FIELD_PREFIX))) continue;
        const rest = k.slice(k.startsWith(PREFIX) ? PREFIX.length : FIELD_PREFIX.length);
        if (keep && !keep.all && rest.startsWith(keep.scope)) {
          const name = rest.slice(keep.scope.length);
          const madeAs = /^q:([a-z]+):/.exec(name)?.[1];
          const old = name !== 'scale' && !(Date.now() - atOf(store.getItem(k)) < TTL);
          if (!old && (!madeAs || madeAs === keep.role)) continue;
        }
        store.removeItem(k);
      }
    } catch { /* storage blocked */ }
  }
};

// Whose copies these are, and the role they were made under ("ws:user:role").
const ROLE_MARK = 'starbase:copy-role:v1';
let checked = null;
// Sign-out: every copy on this phone goes (walk lists too).
export const forgetPhoneCopies = () => {
  checked = null;
  try { ls()?.removeItem(ROLE_MARK); } catch { /* storage blocked */ }
  forget(null);
};
// Signed in (Shell, before any screen reads a copy; once per sign-in and
// role): copies belonging to anyone else on this phone go, so do any more
// than a day old, and — when this person's role changed since theirs were
// kept — all of theirs (the doors and the Calls list a staff member kept
// hold everyone's details; as a volunteer they keep none of that).
export const keepOnlyMine = (me) => {
  const s = scope(me);
  if (!s) return;
  const role = me.role || '';
  const mark = `${s}${role}`;
  if (checked === mark) return;
  checked = mark;
  let was = null;
  try { was = ls()?.getItem(ROLE_MARK) ?? null; } catch { /* storage blocked */ }
  forget({ scope: s, role, all: Boolean(was && was !== mark && was.startsWith(s)) });
  try { ls()?.setItem(ROLE_MARK, mark); } catch { /* storage full or blocked */ }
};

// ── For components/KeptCopies.js (desk screens) ──
// tier: 'local' (this browser, a day) or 'session' (this tab only).
export const copyKey = keyFor;
export const copyScope = scope;
export const copyGeneration = () => generation;
export const readCopy = (key, tier = 'local') => readEntry(key, storeOf(tier));
export const removeCopy = (key, tier = 'local') => { try { storeOf(tier)?.removeItem(key); } catch { /* blocked */ } };
// Written a moment after it loaded (a list refetches after every tap), and
// only while the same sign-in is here (gen: copyGeneration() when it loaded).
export function writeCopy(key, data, at, { tier = 'local', group = null, gen } = {}) {
  if (!key) return;
  later(`${tier}|${key}`, () => {
    if (gen !== undefined && gen !== generation) return;
    writeEntry(key, data, at, storeOf(tier), group ? { prefix: `${PREFIX}${group.scope}${group.name}`, max: group.max } : null);
  });
}
