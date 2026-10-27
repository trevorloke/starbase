// Offline outbox for field work. Field volunteers lose signal mid-block; a
// knock, a new door, a pin, a sign request or a shift sign-up must never be
// lost or recorded twice.
//
//   queueAction(name, input, meta?)
//                      → { queued: false, result, client_id } when the server took it,
//                        { queued: true, signedOut?, client_id } when it's saved to send later.
//                      Throws the server's refusal (a 4xx) like action() does.
//   logContact(input, meta?)  the same for contact.log (the door card, walk
//                      list, Calls and profile all knock through it).
//   flushOutbox()      → replays waiting items in order (safe to call anytime).
//   useOutbox()        → { pending, refused, flushing, lastError, items, flush }.
//   dismissItem(cid) / retryItem(cid)   a refused item: drop it, or send it again.
//   undoQueued(cid)    a sign request or a "Count me in" still on the phone:
//                      take it back.
//   clearOutbox()      → discard this sign-in's items (sign-out on a shared phone).
//   holdNote(send)     → a card with a note typed but not sent yet (the door
//                        card, a profile) holds its send here; sendHeldNotes()
//                        sends them all — sign-out does, before it flushes, so a
//                        note goes out under whoever typed it.
//   closeOutbox()      → signed out on purpose: nothing more is saved here
//                        (a card closing as the screen goes leaves nothing
//                        behind) until someone signs in again.
//   setOutboxOwner(me) → whose items these are (Shell): each item belongs to
//                        the sign-in that saved it and is only shown to and
//                        sent by that sign-in — never as someone else's.
//   applyOutbox(doors) → the map's /api/map/doors payload with what's still on
//                        the phone laid over it (new people, pins, signs, ratings).
//   onOutboxSent(fn)   → told about each item once the server has it
//                        ({ name, input, meta, result, later }; later: sent from
//                        the phone after the tap, not while the screen waited).
//
// Two tabs on one computer share one outbox: every change starts from what's
// stored now (never this tab's older list, which would drop the other tab's
// items), a tab hears the other's changes ('storage'), and only one tab sends
// at a time (navigator.locks, where the browser has it — a second send is
// harmless anyway: every item dedupes, or reads "already" as done).
//
// One FIFO queue — order matters: a person added offline, then knocked, must
// reach the server in that order — so a new item goes behind anything still
// waiting, even with signal. Every item carries a client-made id the server
// dedupes on (contact.log, sign.place and person.tag: client_id;
// person.create: id), so a replay after a dropped response is recorded
// exactly once; shift.join /
// shift.leave answer a replay with "already on it" / "not on it" and
// sign.cancel with "not found", which the replay reads as done. Only network
// failures queue — a 4xx on the first try is returned as an error, because
// replaying it would fail the same way forever. A 4xx on a replay is kept
// (refused, with the server's reason) until someone dismisses or retries it:
// never silently dropped. A knock, pin or sign on someone added here whose
// adding was refused isn't sent at all — it's kept as refused, "Not saved —
// this person wasn't added" — and Try again on the person brings it along.
//   refusedText(item)  → a refused item's reason, in plain words.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { SIGN_KINDS } from '@starbase/shared/canvass';
import { action, ApiError } from './api.js';

// The writes a phone may do with no signal (the door card, walk list, Calls,
// the map's pins and Shifts). person.addAtDoor: a new housemate at a door
// already on the list (every role; the server copies the door's address).
// relationship.add: someone you know, on My people (its link and person ids
// are made on the phone, so a replay is the same link).
// person.tag: tags put on or taken off on a profile at the desk (desk roles;
// the server dedupes it on client_id, server/ext/deskoffline).
export const FIELD_ACTIONS = ['contact.log', 'person.create', 'person.addAtDoor', 'person.locate', 'sign.place', 'sign.cancel', 'shift.join', 'shift.leave', 'relationship.add', 'person.tag', 'person.details'];
// Keyed by a client_id the server dedupes on.
const CLIENT_KEYED = ['contact.log', 'sign.place', 'person.tag'];
// The writes that add a person, on an id made here.
export const NEW_PERSON = ['person.create', 'person.addAtDoor'];
// What can be taken back while it waits: a sign request (its cancel is
// sign.cancel) and "Count me in" (shift.leave).
const UNDOABLE = ['sign.place', 'shift.join'];
// The person an item is about (a knock, a pin, a sign request).
const personOf = (it) => (it.name === 'person.locate' || it.name === 'person.tag' ? it.input?.id : it.input?.person_id) || null;
// Kept on an item about someone this phone added, whose adding was refused.
const NOT_ADDED = { status: 400, code: 'not_added', message: 'Not saved — this person wasn’t added' };

const KEY = 'starbase:outbox:v2';
const V1_KEY = 'starbase:outbox:v1'; // knocks only (before this outbox)
const listeners = new Set();
const sentListeners = new Set();
let flushing = null; // the running flush (a promise), or null
let owner = null;    // "workspace:user" of whoever is signed in (setOutboxOwner)
let lastError = null;
let signedOutNow = false;
// Signed out on purpose (closeOutbox), and the sign-in it was closed under.
let closed = false;
let closedFor = null;
let ownerMe = null;
// What the server answered for items sent by a flush, by client id, so a
// caller who queued behind others (or a later Undo) can still read it.
const results = new Map();
const keep = (cid, result) => {
  results.set(cid, result);
  while (results.size > 100) results.delete(results.keys().next().value);
};

export const newClientId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));

const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const fromV1 = (k) => {
  const { queued_at: at, ...input } = k;
  const cid = input.client_id || newClientId();
  return { cid, name: 'contact.log', input: { ...input, client_id: cid }, meta: {}, at: at || new Date().toISOString(), tries: 0, state: 'pending' };
};
const read = () => {
  const ls = storage();
  if (!ls) return [];
  try {
    const items = JSON.parse(ls.getItem(KEY) || '[]');
    const old = JSON.parse(ls.getItem(V1_KEY) || '[]');
    const list = Array.isArray(items) ? items.filter((i) => i && i.cid && i.name) : [];
    if (Array.isArray(old) && old.length) {
      const have = new Set(list.map((i) => i.cid));
      for (const k of old) if (k?.person_id && !have.has(k.client_id)) list.push(fromV1(k));
      ls.setItem(KEY, JSON.stringify(list));
      ls.removeItem(V1_KEY);
    }
    return list;
  } catch { return []; }
};
let memory = read();
// The stored list is this tab's own (its last save worked): changes start
// from it. Storage blocked or full: from this tab's memory.
let stored = true;
const valid = (list) => (Array.isArray(list) ? list.filter((i) => i && i.cid && i.name) : null);
const latest = () => {
  const ls = storage();
  if (!ls || !stored) return memory;
  try { return valid(JSON.parse(ls.getItem(KEY) || '[]')) || memory; } catch { return memory; }
};
// An item is this sign-in's when it says so (older items, saved before items
// had owners, count as whoever is signed in).
const mine = (i) => !owner || !i.owner || i.owner === owner;
let visible = memory;
let snap = null;
const makeSnap = () => {
  visible = memory.filter(mine);
  const pending = visible.filter((i) => i.state === 'pending').length;
  snap = {
    pending,
    refused: visible.length - pending,
    flushing: Boolean(flushing),
    lastError,
    signedOut: signedOutNow,
    items: visible,
    flush: flushOutbox,
  };
};
makeSnap();
const changed = () => { makeSnap(); listeners.forEach((fn) => fn()); };
const write = (items) => {
  memory = items;
  try {
    const ls = storage();
    if (ls) ls.setItem(KEY, JSON.stringify(items));
    stored = Boolean(ls);
  } catch { stored = false; /* storage full: keep in memory */ }
  changed();
};
// Every change is made to what's stored now (another tab may have added to it).
const change = (fn) => write(fn(latest()));
const add = (item) => change((list) => [...list, item]);
const update = (cid, patch) => change((list) => list.map((i) => (i.cid === cid ? { ...i, ...patch } : i)));
const remove = (cid) => change((list) => list.filter((i) => i.cid !== cid));
const find = (cid) => memory.find((i) => i.cid === cid) || null;

// Another tab saved, sent or dismissed something: show what's stored now.
// What it sent of this sign-in's is told to onSentElsewhere (Shell reloads
// the screens it changed, as for a send from here).
const elsewhere = new Set();
export function onSentElsewhere(fn) {
  elsewhere.add(fn);
  return () => elsewhere.delete(fn);
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    if (e.storageArea && e.storageArea !== storage()) return;
    const before = memory;
    stored = true;
    memory = latest();
    const gone = before.filter((i) => mine(i) && i.state === 'pending' && !memory.some((n) => n.cid === i.cid)).length;
    changed();
    if (gone) elsewhere.forEach((fn) => { try { fn(gone); } catch { /* a listener's bug is not the outbox's */ } });
  });
}

const isNetworkFailure = (err) => !(err instanceof ApiError) || err.status >= 500 || err.status === 0;
// A lapsed sign-in is not a bad item: keep it and send after signing in.
const isSignedOut = (err) => err instanceof ApiError && err.status === 401;
const offlineNow = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export const pendingCount = () => visible.filter((i) => i.state === 'pending').length;
// Everything not on the server yet, refused included (sign-out asks about these).
export const unsentCount = () => visible.length;

// Called while the shell renders, so screens drawn after it read the right
// items at once; anything already listening is told just after the render.
export function setOutboxOwner(me) {
  const next = me?.user?.id && me?.workspace?.id ? `${me.workspace.id}:${me.user.id}` : null;
  // A new sign-in opens it again (a last render of the screen being left,
  // with the same sign-in it was closed under, doesn't).
  if (closed && next && me !== closedFor) closed = false;
  ownerMe = me;
  if (next === owner) return;
  owner = next;
  lastError = null;
  signedOutNow = false;
  makeSnap();
  queueMicrotask(() => listeners.forEach((fn) => fn()));
}

// Sign-out on a shared phone: the next person must not send these as theirs.
export function clearOutbox() {
  lastError = null;
  signedOutNow = false;
  results.clear();
  change((list) => list.filter((i) => !mine(i)));
}

// Signed out on purpose: from now until the next sign-in nothing is saved
// as theirs — a note sent as its card closes on the way to Sign in would
// otherwise wait on this computer for them (sign-out sent the held ones first).
export function closeOutbox() {
  closed = true;
  closedFor = ownerMe;
}

// Notes typed on a card and not sent yet: each card holds its send here, and
// sign-out sends them before it flushes, under whoever typed them.
const heldNotes = new Set();
export function holdNote(send) {
  heldNotes.add(send);
  return () => { heldNotes.delete(send); };
}
export async function sendHeldNotes() {
  await Promise.all([...heldNotes].map(async (send) => {
    try { await send(); } catch { /* the card says what went wrong */ }
  }));
}

// The id the server dedupes on, made here so a replay is the same write.
const withClientId = (name, input) => {
  if (NEW_PERSON.includes(name)) return input.id ? input : { ...input, id: newClientId() };
  if (CLIENT_KEYED.includes(name)) return input.client_id ? input : { ...input, client_id: newClientId() };
  return input;
};
const cidOf = (name, input) => (NEW_PERSON.includes(name) ? input.id
  : CLIENT_KEYED.includes(name) ? input.client_id : newClientId());

// A replay of something the server already did answers "already": that IS done.
const alreadyDone = (name, err) => err instanceof ApiError && (
  (name === 'shift.join' && err.status === 409 && /already on this shift/i.test(err.message))
  || (name === 'shift.leave' && err.status === 404 && /not on this shift/i.test(err.message))
  || (name === 'sign.cancel' && err.status === 404));

// A knock says when it was tapped: a candidate taken off the list since
// is counted from the tap, however long it waited here (ext/scale).
const bodyOf = (item) => (item.name === 'contact.log' && item.at && !item.input.client_at
  ? { ...item.input, client_at: item.at } : item.input);

async function send(item, { replay }) {
  try {
    return await action(item.name, bodyOf(item));
  } catch (err) {
    if (replay && alreadyDone(item.name, err)) return { already: true };
    throw err;
  }
}

const told = (item, result, later = false) => {
  for (const fn of sentListeners) {
    try { fn({ name: item.name, input: item.input, meta: item.meta, result, later }); } catch { /* a listener's bug is not the outbox's */ }
  }
};
export function onOutboxSent(fn) {
  sentListeners.add(fn);
  return () => sentListeners.delete(fn);
}

// meta: { who } — the name the sheet shows ("Knock · Maya Chen · 2:14 pm");
// person.locate also keeps { person } so the pin still shows after a reload,
// and person.addAtDoor { door: { address, unit, lat, lng } } — where the
// server will put them — so the map and walk list show them meanwhile.
export async function queueAction(name, input, meta = {}) {
  if (!FIELD_ACTIONS.includes(name)) throw new Error(`${name} can't be saved offline`);
  if (closed) throw new ApiError(401, 'Signed out');
  const body = withClientId(name, input);
  const item = { cid: cidOf(name, body), name, input: body, meta, at: new Date().toISOString(), tries: 0, state: 'pending', owner };
  if (offlineNow()) {
    add(item);
    return { queued: true, client_id: item.cid };
  }
  // Something is still waiting: go behind it (order matters), then see
  // whether this flush got it through.
  if (pendingCount() > 0) {
    add(item);
    await flushOutbox();
    const left = find(item.cid);
    if (!left) {
      const result = results.get(item.cid);
      results.delete(item.cid);
      return { queued: false, result, client_id: item.cid };
    }
    if (left.state === 'refused') {
      // Refused on its first try: the screen says so in place, as for a direct send.
      remove(item.cid);
      throw new ApiError(left.error?.status || 400, left.error?.message || 'refused');
    }
    return { queued: true, signedOut: signedOutNow, client_id: item.cid };
  }
  try {
    const result = await send(item, { replay: false });
    told(item, result);
    return { queued: false, result, client_id: item.cid };
  } catch (err) {
    if (!isNetworkFailure(err) && !isSignedOut(err)) throw err;
    // It may have reached the server (the answer got lost): tries says so.
    add({ ...item, tries: 1 });
    return { queued: true, signedOut: isSignedOut(err), client_id: item.cid };
  }
}

export const logContact = (input, meta = {}) => queueAction('contact.log', input, meta);

async function runFlush() {
  let sent = 0;
  lastError = null;
  signedOutNow = false;
  memory = latest(); // another tab may have sent some while this one waited its turn
  changed();
  for (;;) {
    const next = memory.find((i) => i.state === 'pending' && mine(i));
    if (!next) break;
    // About someone added here whose adding was refused: the server would
    // only say "not found". Kept, never sent (a sign taken back just goes).
    const pid = personOf(next);
    if (pid && memory.some((i) => i.cid === pid && NEW_PERSON.includes(i.name) && i.state === 'refused')) {
      if (next.undo && UNDOABLE.includes(next.name)) remove(next.cid);
      else update(next.cid, { state: 'refused', error: NOT_ADDED });
      continue;
    }
    update(next.cid, { tries: (next.tries || 0) + 1 });
    try {
      let done = next;
      let result = await send(next, { replay: true });
      // A sign request or a "Count me in" taken back (Undo / Take back) after
      // it may already have gone — even while it was on its way just now: it
      // lands, then its cancel (sign.cancel / shift.leave) goes straight after.
      const undone = find(next.cid)?.undo;
      const follow = undone && next.name === 'sign.place' && result?.sign?.id ? { name: 'sign.cancel', input: { id: result.sign.id } }
        : undone && next.name === 'shift.join' ? { name: 'shift.leave', input: { shift_id: next.input.shift_id } }
          : null;
      if (follow) {
        told(next, result, true);
        done = { ...next, ...follow, undo: false, tries: 1 };
        update(next.cid, done);
        result = await send(done, { replay: true });
      }
      keep(next.cid, result);
      remove(next.cid);
      told(done, result, true);
      sent += 1;
    } catch (err) {
      if (isNetworkFailure(err)) { lastError = 'Still offline — will retry'; break; }
      if (isSignedOut(err)) { lastError = 'Sign in again to send what’s saved'; signedOutNow = true; break; }
      // Taken back, and the server said no to it anyway: nothing to keep.
      if (find(next.cid)?.undo && UNDOABLE.includes(find(next.cid).name)) { remove(next.cid); continue; }
      // Refused: kept, with the server's reason, until dismissed or retried.
      update(next.cid, { state: 'refused', error: { status: err.status, message: err.message || 'refused' } });
    }
  }
  return { sent, left: pendingCount() };
}

// One tab sends at a time (the others wait their turn, then find it done).
const oneTabAtATime = (fn) => {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return fn();
  let ran = false;
  try {
    return locks.request('starbase-outbox', () => { ran = true; return fn(); })
      .catch((err) => { if (ran) throw err; return fn(); });
  } catch { return fn(); }
};

export function flushOutbox() {
  if (flushing) return flushing;
  if (pendingCount() === 0) return Promise.resolve({ sent: 0, left: 0 });
  flushing = oneTabAtATime(runFlush).finally(() => { flushing = null; changed(); });
  changed();
  return flushing;
}

export function dismissItem(cid) {
  remove(cid);
}

export function retryItem(cid) {
  const it = find(cid);
  if (!it) return Promise.resolve({ sent: 0, left: pendingCount() });
  // Trying a refused new person again brings what was kept back with them.
  const along = NEW_PERSON.includes(it.name)
    ? (i) => i.state === 'refused' && i.error?.code === NOT_ADDED.code && personOf(i) === cid
    : () => false;
  change((list) => list.map((i) => (i.cid === cid || along(i) ? { ...i, state: 'pending', error: null } : i)));
  return offlineNow() ? Promise.resolve({ sent: 0, left: pendingCount() }) : flushOutbox();
}

// Take back a sign request or a "Count me in" saved on this phone:
//   'removed' — it never left the phone; now it never will.
//   'queued'  — it may have reached the server, so its cancel follows it.
//   { sent }  — it already went (sent's result has the sign): cancel that one.
//   null      — nothing to take back.
export function undoQueued(cid) {
  const it = find(cid);
  if (!it) {
    const sentResult = results.get(cid);
    return sentResult ? { sent: sentResult } : null;
  }
  if (!UNDOABLE.includes(it.name) || it.undo) return it.undo ? 'queued' : null;
  // tries counts every send that may have reached the server; a refused one
  // never did.
  if (!it.tries || it.state === 'refused') {
    remove(cid);
    return 'removed';
  }
  update(cid, { undo: true, state: 'pending', error: null });
  return 'queued';
}

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const snapshot = () => snap;

export function useOutbox() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// Mount once (Shell): flush on reconnect, on focus, and every 30s while
// pending — sooner (3s, 6s, 12s…) while the signal is coming and going.
export function useOutboxAutoFlush(onFlushed) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let soon = null;
    let delay = 3000;
    const go = async () => {
      clearTimeout(soon);
      if (!pendingCount() || offlineNow()) return;
      const r = await flushOutbox();
      if (r.sent && onFlushed) onFlushed(r);
      setTick((t) => t + 1);
      if (r.left > 0 && !offlineNow() && delay < 30000) { soon = setTimeout(go, delay); delay *= 2; } else delay = 3000;
    };
    const reconnect = () => { delay = 3000; go(); };
    window.addEventListener('online', reconnect);
    window.addEventListener('focus', go);
    const id = setInterval(go, 30000);
    // Sent by another tab: the screens here reload what it changed too.
    const offElsewhere = onSentElsewhere(() => { if (onFlushed) onFlushed({ sent: 0, left: pendingCount() }); setTick((t) => t + 1); });
    go();
    return () => {
      offElsewhere();
      clearTimeout(soon);
      window.removeEventListener('online', reconnect);
      window.removeEventListener('focus', go);
      clearInterval(id);
    };
  }, [onFlushed]);
  return tick;
}

// ── What the sheet says about an item ──
// A refused item's reason: the server's, as a sentence — but never its
// "… in this workspace", and a knock on someone it doesn't have says so
// plainly (they may have been removed meanwhile).
export function refusedText(item) {
  const e = item?.error || {};
  if (e.code === NOT_ADDED.code) return NOT_ADDED.message;
  const said = String(e.message || '').trim();
  if (/^person not found\b/i.test(said)) return 'Not saved — this person isn’t on the list';
  // Never the server's field path ("person.email: Invalid email address").
  const t = said.replace(/^[a-z_][\w.]*: /i, '').replace(/\s+in this workspace\b/gi, '');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Refused';
}

const SIGN_WORD = Object.fromEntries(SIGN_KINDS.map((s) => [s.code, s.label]));
// "Tag · Media", "Tag off · VIP", "Tags · Media, Host" — tags in words, as
// People shows them ("donor-prospect" → "Donor prospect"; "VIP" stays).
const tagSay = (t) => {
  const v = String(t ?? '').trim();
  if (!v || v === v.toUpperCase()) return v;
  const w = v.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const tagChangeText = (i) => {
  const add = (i.add || []).map(tagSay);
  const off = (i.remove || []).map(tagSay);
  const parts = [];
  if (add.length) parts.push(`${add.length > 1 ? 'Tags' : 'Tag'} · ${add.join(', ')}`);
  if (off.length) parts.push(`${off.length > 1 ? 'Tags off' : 'Tag off'} · ${off.join(', ')}`);
  return parts.join(' · ') || 'Tags';
};
const CHANNEL_WORD = { door: 'Knock', phone: 'Call', text: 'Text', in_person: 'Talk' };
// "2:14 pm" today, "Oct 18" before that — the phone's own clock.
export const clockText = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (d.toDateString() !== new Date().toDateString()) {
    return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  }
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};
// "Knock · Maya Chen · 2:14 pm", "New person · Ana Souza · 2:16 pm".
// nameOf(personId) fills in a name the item didn't keep.
export function itemText(item, nameOf = () => '') {
  const i = item.input || {};
  const who = item.meta?.who || (i.person_id ? nameOf(i.person_id) : '') || (item.name === 'person.locate' || item.name === 'person.tag' ? nameOf(i.id) : '');
  let what;
  switch (item.name) {
    case 'contact.log':
      what = i.rating || i.outcome !== 'contacted' || !i.note ? (CHANNEL_WORD[i.channel] || 'Knock') : 'Note';
      break;
    case 'person.create':
    case 'person.addAtDoor': what = 'New person'; break;
    case 'person.locate': what = 'Pin'; break;
    case 'sign.place': what = item.undo ? `${SIGN_WORD[i.kind] || 'Sign'} · undo` : (SIGN_WORD[i.kind] || 'Sign'); break;
    case 'sign.cancel': what = 'Sign undo'; break;
    case 'shift.join': what = item.undo ? 'Count me in · undo' : 'Count me in'; break;
    case 'shift.leave': what = 'Can’t make it'; break;
    case 'relationship.add': what = 'Someone you know'; break;
    case 'person.tag': what = tagChangeText(i); break;
    default: what = 'Saved';
  }
  const name = NEW_PERSON.includes(item.name) ? i.name : item.name === 'relationship.add' ? i.person?.name || who : who;
  return [what, name, clockText(item.at)].filter(Boolean).join(' · ');
}

// ── Laid over what the screens loaded ──

// The latest knock still waiting, per person — the walk list's overlay after
// a reload: { rating, outcome, at, queued: true }.
export function pendingKnocks(items = visible) {
  const out = {};
  for (const it of items) {
    if (it.state !== 'pending' || it.name !== 'contact.log' || it.input?.channel !== 'door' || !it.input.person_id) continue;
    const pid = it.input.person_id;
    out[pid] = { rating: it.input.rating || out[pid]?.rating || null, outcome: it.input.outcome, at: it.at, queued: true };
  }
  return out;
}

// What a new-person item says about them: its input, plus (person.addAtDoor)
// the door it was added at.
const newPersonOf = (it) => (it.name === 'person.addAtDoor' ? { ...(it.meta?.door || {}), ...it.input } : it.input || {});
const isNewPerson = (it) => NEW_PERSON.includes(it.name);

// A person added on this phone, in the shape the map and walk list use.
const pendingPerson = (it) => {
  const i = newPersonOf(it);
  return {
    id: i.id,
    name: i.name,
    phone: i.phone ?? null,
    email: null,
    address: i.address ?? null,
    unit: i.unit ?? null,
    lat: Number(i.lat),
    lng: Number(i.lng),
    rating: null,
    rated_at: null,
    tags: [],
    pending: true,
  };
};

// Same ray-casting test the server uses for walk lists (server/lib/geo.js).
function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i].map(Number);
    const [yj, xj] = ring[j].map(Number);
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// People added on this phone (not sent yet) whose pin is inside a turf.
export function pendingPeopleIn(ring, items = visible) {
  if (!Array.isArray(ring) || ring.length < 3) return [];
  return items
    .filter((it) => it.state === 'pending' && isNewPerson(it) && newPersonOf(it).lat != null && newPersonOf(it).lng != null)
    .map(pendingPerson)
    .filter((p) => inRing(p.lat, p.lng, ring));
}

// The map's doors payload ({ persons, signs, unlocated }) with this phone's
// unsent work on top: new people (pending: true), dropped pins, sign
// requests (pending: true) and their undos, and ratings.
export function applyOutbox(data, items = visible) {
  if (!data) return data;
  const waiting = items.filter((i) => i.state === 'pending');
  if (!waiting.length) return data;
  let persons = [...(data.persons || [])];
  let signs = [...(data.signs || [])];
  let unlocated = data.unlocated || 0;
  for (const it of waiting) {
    const i = it.input || {};
    if (isNewPerson(it)) {
      const np = newPersonOf(it);
      if (np.lat != null && np.lng != null && !persons.some((p) => p.id === np.id)) persons.push(pendingPerson(it));
    } else if (it.name === 'person.locate') {
      const at = persons.findIndex((p) => p.id === i.id);
      if (at >= 0) persons[at] = { ...persons[at], lat: i.lat, lng: i.lng };
      else if (it.meta?.person) {
        const p = it.meta.person;
        persons.push({
          id: i.id, name: p.name, phone: p.phone ?? null, email: p.email ?? null, address: p.address ?? null,
          unit: p.unit ?? null, lat: i.lat, lng: i.lng, rating: p.rating ?? null, rated_at: p.rated_at ?? null, tags: p.tags || [],
        });
        if (p.address) unlocated = Math.max(0, unlocated - 1);
      }
    } else if (it.name === 'sign.place' && !it.undo) {
      signs.push({
        id: `pending:${it.cid}`, cid: it.cid, person_id: i.person_id || null, address: i.address || null,
        lat: i.lat ?? null, lng: i.lng ?? null, kind: i.kind, status: i.status || 'requested', pending: true,
      });
    } else if (it.name === 'sign.cancel') {
      signs = signs.filter((s) => s.id !== i.id);
    } else if (it.name === 'contact.log' && i.rating) {
      persons = persons.map((p) => (p.id === i.person_id ? { ...p, rating: i.rating, rated_at: it.at } : p));
    }
  }
  return { ...data, persons, signs, unlocated };
}

// ── A profile with what's still on this device laid over it ──
// The desk's safe writes with no signal (pages/Person.jsx): a contact or
// rating (with its note) and tags. pendingAbout(items, id) counts them;
// applyOutboxToProfile(data) is GET /api/persons/:id as the server will
// have it once they're sent — the rating, the tags, and each contact at the
// top of the history marked pending ("Not sent yet").
const aboutPerson = (it, id) => it.state === 'pending' && (
  (it.name === 'contact.log' && it.input?.person_id === id) || (it.name === 'person.tag' && it.input?.id === id));
export const pendingAbout = (items = visible, id) => (id ? items.filter((it) => aboutPerson(it, id)).length : 0);
export function applyOutboxToProfile(data, items = visible) {
  const id = data?.person?.id;
  const mine = id ? items.filter((it) => aboutPerson(it, id)) : [];
  if (!mine.length) return data;
  const person = { ...data.person };
  const contacts = [...(data.contacts || [])];
  for (const it of mine) {
    const i = it.input || {};
    if (it.name === 'contact.log') {
      contacts.unshift({
        id: `pending:${it.cid}`, channel: i.channel, outcome: i.outcome, rating: i.rating || null,
        note: i.note || null, created_at: it.at, by_name: null, pending: true,
      });
      if (i.rating) { person.rating = i.rating; person.rated_at = it.at; }
    } else {
      const off = new Set(i.remove || []);
      const tags = (Array.isArray(person.tags) ? person.tags : []).filter((t) => !off.has(t));
      for (const t of i.add || []) if (!tags.includes(t)) tags.push(t);
      person.tags = tags;
    }
  }
  return { ...data, person, contacts };
}
