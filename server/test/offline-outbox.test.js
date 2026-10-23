// The phone's outbox (web/src/offline.js) against the real server, in
// process: a stand-in localStorage, a navigator whose signal we switch off,
// and a fetch that can lose an answer after the server already did the write.
// Proves one FIFO queue (a person added offline, then knocked, lands in that
// order), exactly-once replays for every field action, "already on it"
// replays read as done, refusals kept with the server's reason (never
// dropped), Dismiss / Try again, and Undo on a sign request still on the phone.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const tag = Math.random().toString(36).slice(2, 8);
let c; let vol; let ob;
const net = { offline: false, loseNext: 0, cookie: '' };

const store = new Map();
const nav = { onLine: true };
// Browser stand-ins, installed only once the database is up (PGlite looks
// for a browser when it boots). Only the app's own /api calls go to the
// in-process server; anything absolute uses the real fetch.
const realFetch = globalThis.fetch;
const installBrowser = () => {
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('/')) return realFetch(url, init);
    if (net.offline || nav.onLine === false) throw new TypeError('fetch failed');
    const res = await app.request(url, { ...init, headers: { ...(init.headers || {}), cookie: net.cookie } });
    if (net.loseNext > 0) { net.loseNext -= 1; throw new TypeError('network connection was lost'); }
    return res;
  };
};

before(async () => {
  await freshDb();
  c = new Client();
  assert.equal((await c.signup({ workspaceName: 'Outbox Field', email: `outbox.mgr+${tag}@example.org` })).status, 201);
  const inv = await c.action('member.invite', { email: `outbox.vol+${tag}@example.org`, role: 'volunteer' });
  vol = new Client();
  const j = await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Outbox Volunteer', password: 'knock-knock-2026' });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  // An old phone still holding a v1 knock: it moves into the new outbox.
  const old = await c.createPerson('Old Knock', { address: '7101 124 St', lat: 49.131, lng: -122.852 });
  installBrowser();
  store.set('starbase:outbox:v1', JSON.stringify([{ person_id: old.id, channel: 'door', outcome: 'no_answer', client_id: '6a1b7e0c-2f43-4e7a-9a59-6c6f2b9d7a10', queued_at: new Date().toISOString() }]));
  net.cookie = c.cookie;
  ob = await import('../../web/src/offline.js');
});

const persons = async (q) => (await c.get(`/api/persons?q=${encodeURIComponent(q)}`)).json.persons;
const contactsOf = async (id) => (await c.get(`/api/persons/${id}`)).json.contacts;

test('a v1 knock left on the phone moves into the outbox and sends once', async () => {
  assert.equal(ob.pendingCount(), 1);
  assert.equal(store.has('starbase:outbox:v1'), false, 'the old key is gone');
  const item = JSON.parse(store.get('starbase:outbox:v2'))[0];
  assert.equal(item.name, 'contact.log');
  assert.equal(item.input.client_id, '6a1b7e0c-2f43-4e7a-9a59-6c6f2b9d7a10');
  const r = await ob.flushOutbox();
  assert.equal(r.sent, 1);
  const [p] = await persons('Old Knock');
  assert.equal((await contactsOf(p.id)).length, 1);
});

test('offline: a new person, then a knock on them, then a sign — sent in order, each once', async () => {
  nav.onLine = false;
  const made = await ob.queueAction('person.create', { name: 'Ana Souza', address: '7155 124 St', lat: 49.1316, lng: -122.8521 }, { who: 'Ana Souza' });
  assert.equal(made.queued, true);
  const id = made.client_id;
  const knock = await ob.logContact({ person_id: id, channel: 'door', outcome: 'contacted', rating: '2' }, { who: 'Ana Souza' });
  assert.equal(knock.queued, true);
  const sign = await ob.queueAction('sign.place', { person_id: id, kind: 'lawn', lat: 49.1316, lng: -122.8521 }, { who: 'Ana Souza' });
  assert.equal(sign.queued, true);
  assert.equal(ob.pendingCount(), 3);

  // The map sees all three before any of them is sent.
  const over = ob.applyOutbox({ persons: [], signs: [], unlocated: 0 });
  assert.equal(over.persons.length, 1);
  assert.equal(over.persons[0].id, id);
  assert.equal(over.persons[0].pending, true);
  assert.equal(over.persons[0].rating, '2', 'the queued rating shows on the pin');
  assert.equal(over.signs.length, 1);
  assert.equal(over.signs[0].pending, true);
  // And the sheet says what each one is, in plain words.
  const words = JSON.parse(store.get('starbase:outbox:v2')).map((i) => ob.itemText(i));
  assert.match(words[0], /^New person · Ana Souza · \d{1,2}:\d{2} (am|pm)$/);
  assert.match(words[1], /^Knock · Ana Souza · /);
  assert.match(words[2], /^Lawn sign · Ana Souza · /);
  assert.equal(ob.pendingPeopleIn([[49.13, -122.86], [49.14, -122.86], [49.14, -122.84], [49.13, -122.84]]).length, 1, 'inside the turf');
  assert.equal(ob.pendingPeopleIn([[49.0, -122.0], [49.01, -122.0], [49.01, -121.99]]).length, 0, 'outside it');

  // Signal back, but the first answer is lost after the server wrote it.
  nav.onLine = true;
  net.loseNext = 1;
  let r = await ob.flushOutbox();
  assert.equal(r.sent, 0, 'the lost answer keeps it on the phone');
  assert.equal(ob.pendingCount(), 3);
  r = await ob.flushOutbox();
  assert.equal(r.sent, 3);
  assert.equal(ob.pendingCount(), 0);

  const found = await persons('Ana Souza');
  assert.equal(found.length, 1, 'one Ana, not two');
  assert.equal(found[0].id, id);
  assert.equal(found[0].rating, '2');
  assert.equal((await contactsOf(id)).length, 1, 'one knock');
  const signs = (await c.get('/api/signs')).json.signs.filter((s) => s.person_id === id);
  assert.equal(signs.length, 1, 'one sign');
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
});

test('with something still waiting, a new item goes behind it even with signal', async () => {
  nav.onLine = false;
  const made = await ob.queueAction('person.create', { name: 'Behind Me', address: '7160 124 St', lat: 49.1317, lng: -122.8522 });
  nav.onLine = true;
  // Knocked straight away with signal: it must not overtake the create.
  const k = await ob.logContact({ person_id: made.client_id, channel: 'door', outcome: 'contacted', rating: '1' });
  assert.equal(k.queued, false, 'sent in the same flush, after the create');
  assert.equal(k.result.contact.person_id, made.client_id);
  assert.equal(ob.pendingCount(), 0);
});

test('a lost answer on a direct send queues it; the replay is the same write', async () => {
  const p = await c.createPerson('Lost Answer', { address: '7170 124 St', lat: 49.1318, lng: -122.8523 });
  net.loseNext = 1;
  const r = await ob.logContact({ person_id: p.id, channel: 'door', outcome: 'contacted', rating: '3' });
  assert.equal(r.queued, true);
  assert.equal((await contactsOf(p.id)).length, 1, 'the server already has it');
  await ob.flushOutbox();
  assert.equal((await contactsOf(p.id)).length, 1, 'and still only once after the replay');

  net.loseNext = 1;
  const pin = await ob.queueAction('person.locate', { id: p.id, lat: 49.2, lng: -122.8 }, { who: p.name });
  assert.equal(pin.queued, true);
  await ob.flushOutbox();
  const evs = (await c.get('/api/events?since=0&limit=5000')).json.events.filter((e) => e.action === 'person.locate' && e.entity_id === p.id);
  assert.equal(evs.length, 2, 'a pin replay moves it to the same spot (no harm)');
  const after = (await c.get(`/api/persons/${p.id}`)).json.person;
  assert.equal(Number(after.lat), 49.2);
});

test('a refusal on replay is kept with the reason; Try again and Dismiss', async () => {
  const p = await c.createPerson('Up Already', { address: '7180 124 St', lat: 49.1319, lng: -122.8524 });
  const placed = await ob.queueAction('sign.place', { person_id: p.id, kind: 'lawn' });
  assert.equal(placed.queued, false);
  const signId = placed.result.sign.id;
  nav.onLine = false;
  const undo = await ob.queueAction('sign.cancel', { id: signId }, { who: p.name });
  assert.equal(undo.queued, true);
  // Meanwhile the crew puts it up.
  assert.equal((await c.action('sign.update', { id: signId, status: 'installed' })).status, 200);
  nav.onLine = true;
  const r = await ob.flushOutbox();
  assert.equal(r.sent, 0);
  const [item] = JSON.parse(store.get('starbase:outbox:v2'));
  assert.equal(item.state, 'refused');
  assert.equal(item.error.status, 409);
  assert.match(item.error.message, /already up/);
  assert.equal(ob.pendingCount(), 0, 'not waiting');
  assert.equal(ob.unsentCount(), 1, 'but still on the phone, never silently dropped');

  // A refused item doesn't hold up the ones after it.
  const q = await c.createPerson('Next In Line', { address: '7190 124 St', lat: 49.132, lng: -122.8525 });
  const k = await ob.logContact({ person_id: q.id, channel: 'door', outcome: 'no_answer' });
  assert.equal(k.queued, false);

  // Try again: refused again (it's still up), reason kept.
  await ob.retryItem(item.cid);
  assert.equal(JSON.parse(store.get('starbase:outbox:v2'))[0].state, 'refused');
  // Taken down → a cancel is refused differently; Dismiss drops it.
  ob.dismissItem(item.cid);
  assert.equal(ob.unsentCount(), 0);
  assert.equal((await c.get('/api/signs')).json.signs.find((s) => s.id === signId).status, 'installed', 'left as it was');
});

test('Undo on a sign request still on the phone', async () => {
  const p = await c.createPerson('Undo Host', { address: '7200 124 St', lat: 49.1321, lng: -122.8526 });
  // Never sent: it just goes.
  nav.onLine = false;
  const a = await ob.queueAction('sign.place', { person_id: p.id, kind: 'large' });
  assert.equal(ob.undoQueued(a.client_id), 'removed');
  assert.equal(ob.unsentCount(), 0);
  // Maybe sent (the answer was lost): its cancel follows it.
  nav.onLine = true;
  net.loseNext = 1;
  const b = await ob.queueAction('sign.place', { person_id: p.id, kind: 'lawn' });
  assert.equal(b.queued, true);
  assert.equal(ob.undoQueued(b.client_id), 'queued');
  await ob.flushOutbox();
  assert.equal(ob.unsentCount(), 0);
  const left = (await c.get('/api/signs')).json.signs.filter((s) => s.person_id === p.id);
  assert.equal(left.length, 0, 'placed once, then cancelled');
  const evs = (await c.get('/api/events?since=0&limit=5000')).json.events;
  assert.equal(evs.filter((e) => e.action === 'sign.place' && e.payload.person_id === p.id).length, 1);
  assert.equal(evs.filter((e) => e.action === 'sign.cancel' && e.payload.person_id === p.id).length, 1);
  // Already sent: Undo hands back the sign to cancel.
  const s = await ob.queueAction('sign.place', { person_id: p.id, kind: 'billboard' });
  assert.equal(s.queued, false);
  assert.equal(ob.undoQueued(s.client_id), null, 'a direct send is the caller’s to cancel');
});

test('a volunteer’s shift sign-up replays as done; a full shift is refused, with the reason', async () => {
  net.cookie = vol.cookie;
  const shift = (await c.action('shift.create', { title: 'Phone bank', starts_at: new Date(Date.now() + 86400_000).toISOString(), capacity: 1 })).json.shift;
  net.loseNext = 1;
  const j = await ob.queueAction('shift.join', { shift_id: shift.id }, { who: 'Phone bank' });
  assert.equal(j.queued, true);
  const r = await ob.flushOutbox();
  assert.equal(r.sent, 1, '"already on this shift" is done, not refused');
  assert.equal(ob.unsentCount(), 0);
  const detail = (await c.get(`/api/shifts/${shift.id}`)).json;
  assert.equal(detail.assignees.filter((a) => a.status === 'confirmed').length, 1);

  net.loseNext = 1;
  assert.equal((await ob.queueAction('shift.leave', { shift_id: shift.id })).queued, true);
  assert.equal((await ob.flushOutbox()).sent, 1, '"not on this shift" is done');

  // Full while offline: refused, kept.
  nav.onLine = false;
  await ob.queueAction('shift.join', { shift_id: shift.id }, { who: 'Phone bank' });
  const other = await c.createPerson('Took The Spot');
  assert.equal((await c.action('shift.assign', { shift_id: shift.id, person_id: other.id })).status, 200);
  nav.onLine = true;
  await ob.flushOutbox();
  const [item] = JSON.parse(store.get('starbase:outbox:v2'));
  assert.equal(item.state, 'refused');
  assert.match(item.error.message, /full/);
  assert.match(ob.itemText(item), /^Count me in · Phone bank · /);

  // Volunteers can't add people: refused on the first try, nothing queued.
  await assert.rejects(ob.queueAction('person.create', { name: 'Not Mine' }), (e) => e.status === 403);
  ob.clearOutbox();
  assert.equal(ob.unsentCount(), 0);
  net.cookie = c.cookie;
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
});

test('Take back on a "Count me in" still on the phone: never sent, or "Can’t make it" follows it', async () => {
  net.cookie = vol.cookie;
  const shift = (await c.action('shift.create', { title: 'Lit drop', starts_at: new Date(Date.now() + 86400_000).toISOString(), capacity: 2 })).json.shift;
  const joins = async () => (await c.get('/api/events?since=0&limit=5000')).json.events
    .filter((e) => e.action === 'shift.join' && e.payload.shift_id === shift.id).length;
  const activeOn = async () => (await c.get(`/api/shifts/${shift.id}`)).json.assignees
    .filter((x) => x.status === 'assigned' || x.status === 'confirmed').length;

  // Never left the phone: it just goes.
  nav.onLine = false;
  const a = await ob.queueAction('shift.join', { shift_id: shift.id }, { who: 'Lit drop' });
  assert.equal(a.queued, true);
  assert.equal(ob.undoQueued(a.client_id), 'removed');
  assert.equal(ob.unsentCount(), 0);
  nav.onLine = true;
  await ob.flushOutbox();
  assert.equal(await joins(), 0, 'nothing reached the server');

  // Maybe sent (the answer was lost): "Can't make it" goes straight after it.
  net.loseNext = 1;
  const b = await ob.queueAction('shift.join', { shift_id: shift.id }, { who: 'Lit drop' });
  assert.equal(b.queued, true);
  assert.equal(ob.undoQueued(b.client_id), 'queued');
  assert.equal(ob.undoQueued(b.client_id), 'queued', 'a second tap changes nothing');
  assert.match(ob.itemText(JSON.parse(store.get('starbase:outbox:v2'))[0]), /^Count me in · undo · Lit drop/);
  assert.equal((await ob.flushOutbox()).sent, 1);
  assert.equal(ob.unsentCount(), 0);
  assert.equal(await joins(), 1, 'joined once (the lost answer)');
  assert.equal(await activeOn(), 0, 'then dropped out');

  // Taken back while it was on its way: it lands, then the leave follows.
  nav.onLine = false;
  const d = await ob.queueAction('shift.join', { shift_id: shift.id }, { who: 'Lit drop' });
  nav.onLine = true;
  const going = ob.flushOutbox(); // in flight now
  assert.equal(ob.undoQueued(d.client_id), 'queued');
  await going;
  assert.equal(ob.unsentCount(), 0);
  assert.equal(await activeOn(), 0);

  // Taken back, and the server refuses the sign-up anyway (full): nothing is kept.
  net.offline = true;
  const e = await ob.queueAction('shift.join', { shift_id: shift.id }, { who: 'Lit drop' });
  assert.equal(e.queued, true);
  for (const name of ['Spot One', 'Spot Two']) {
    const p = await c.createPerson(name);
    assert.equal((await c.action('shift.assign', { shift_id: shift.id, person_id: p.id })).status, 200);
  }
  assert.equal(ob.undoQueued(e.client_id), 'queued');
  net.offline = false;
  await ob.flushOutbox();
  assert.equal(ob.unsentCount(), 0, 'not listed as refused: it was taken back');
  assert.equal(await activeOn(), 2);

  // Already sent: Take back hands back what the server said, for the screen's own "Can't make it".
  const shift2 = (await c.action('shift.create', { title: 'Sign crew', starts_at: new Date(Date.now() + 86400_000).toISOString() })).json.shift;
  net.loseNext = 1;
  const f = await ob.queueAction('shift.join', { shift_id: shift2.id });
  await ob.flushOutbox();
  assert.ok(ob.undoQueued(f.client_id)?.sent, 'sent: the screen sends shift.leave itself');
  net.cookie = c.cookie;
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
});

test('a knock kept on the phone says what was saved, then where — "this phone" only on a phone', async () => {
  const { queuedSaid, queuedText, thisDevice } = await import('../../web/src/components/queued.js');
  nav.onLine = false;
  assert.equal(queuedSaid({ queued: true }, 'Rated 1 · Strong yes', '3 answers'), 'Rated 1 · Strong yes · 3 answers · Saved offline');
  assert.equal(queuedSaid({ queued: true }, null, '2 answers'), '2 answers · Saved offline');
  nav.onLine = true;
  // A laptop at the desk (no touch screen at phone size): "this device".
  assert.equal(thisDevice(), 'this device');
  assert.equal(queuedSaid({ queued: true, signedOut: true }, 'No answer'), 'No answer · Saved on this device — sign in to send');
  assert.equal(queuedText({ queued: true }, 'Lost Answer'), 'Lost Answer saved on this device — sends soon');
  // A phone: a touch screen at phone size.
  const asked = [];
  globalThis.matchMedia = (q) => { asked.push(q); return { matches: /pointer: coarse/.test(q), addEventListener() {}, removeEventListener() {} }; };
  try {
    assert.equal(thisDevice(), 'this phone');
    assert.match(asked[0], /max-width: 720px/);
    assert.equal(queuedSaid({ queued: true, signedOut: true }, 'No answer'), 'No answer · Saved on this phone — sign in to send');
    assert.equal(queuedText({ queued: true }), 'Saved on this phone — sends soon');
  } finally {
    delete globalThis.matchMedia;
  }
});

test('no answer at all: plain words, never "Failed to fetch" — and the outbox still keeps the knock', async () => {
  const { action, apiGet, NoSignalError, ApiError } = await import('../../web/src/api.js');
  nav.onLine = false;
  await assert.rejects(action('shift.notify', { shift_id: '00000000-0000-4000-8000-000000000000' }),
    (e) => e instanceof NoSignalError && !(e instanceof ApiError) && e.message === 'No signal — not sent');
  await assert.rejects(apiGet('/surveys'), (e) => e instanceof NoSignalError && e.message === 'No signal — this loads when you’re back online');
  // Signal, but no answer (it may have reached the server): it claims neither.
  nav.onLine = true;
  net.offline = true;
  await assert.rejects(action('shift.notify', {}), (e) => e instanceof NoSignalError && e.message === 'No answer — check your signal');
  const p = await c.createPerson('No Answer Knock', { address: '7240 124 St', lat: 49.1324, lng: -122.8529 });
  const r = await ob.logContact({ person_id: p.id, channel: 'door', outcome: 'contacted', rating: '2' });
  assert.equal(r.queued, true, 'a network failure keeps it on the phone');
  net.offline = false;
  assert.equal((await ob.flushOutbox()).sent, 1);
  assert.equal((await contactsOf(p.id)).length, 1);
  // A server refusal is still the server's own words.
  await assert.rejects(action('shift.notify', {}), (e) => e instanceof ApiError && e.status === 400);
});

test('signed out: kept on the phone, sent after signing back in', async () => {
  const p = await c.createPerson('After Sign In', { address: '7210 124 St', lat: 49.1322, lng: -122.8527 });
  net.cookie = 'starbase_session=nope';
  const r = await ob.logContact({ person_id: p.id, channel: 'door', outcome: 'contacted', rating: '1' });
  assert.equal(r.queued, true);
  assert.equal(r.signedOut, true);
  const f = await ob.flushOutbox();
  assert.equal(f.sent, 0);
  assert.equal(ob.pendingCount(), 1);
  net.cookie = c.cookie;
  assert.equal((await ob.flushOutbox()).sent, 1);
  assert.equal((await contactsOf(p.id)).length, 1);
  await assert.rejects(ob.queueAction('gift.log', {}), /can't be saved offline/);
});

test('each item belongs to the sign-in that saved it: never sent or shown as someone else’s', async () => {
  const meA = (await c.get('/api/auth/me')).json;
  const meB = (await vol.get('/api/auth/me')).json;
  const p = await c.createPerson('Owned Knock', { address: '7220 124 St', lat: 49.1323, lng: -122.8528 });
  ob.setOutboxOwner(meA);
  nav.onLine = false;
  await ob.logContact({ person_id: p.id, channel: 'door', outcome: 'contacted', rating: '3' }, { who: p.name });
  assert.equal(JSON.parse(store.get('starbase:outbox:v2')).at(-1).owner, `${meA.workspace.id}:${meA.user.id}`);
  nav.onLine = true;

  // The session lapses and the volunteer signs in on this phone.
  ob.setOutboxOwner(meB);
  net.cookie = vol.cookie;
  assert.equal(ob.pendingCount(), 0, 'not theirs to see');
  assert.equal(ob.unsentCount(), 0);
  assert.equal(ob.applyOutbox({ persons: [{ id: p.id, name: p.name, lat: 49.1, lng: -122.8 }], signs: [] }).persons[0].rating, undefined, 'not laid over their map');
  assert.equal((await ob.flushOutbox()).sent, 0, 'not theirs to send');
  ob.clearOutbox(); // they sign out: only their own items go
  assert.equal(JSON.parse(store.get('starbase:outbox:v2')).length, 1, 'the first person’s knock is still on the phone');
  assert.equal((await contactsOf(p.id)).length, 0);

  // The first person signs back in: it goes, as theirs.
  ob.setOutboxOwner(meA);
  net.cookie = c.cookie;
  assert.equal(ob.pendingCount(), 1);
  assert.equal((await ob.flushOutbox()).sent, 1);
  const contacts = await contactsOf(p.id);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].by_name, meA.user.name, 'recorded as the person who knocked');
  ob.setOutboxOwner(null);
});

test('a volunteer, offline: a new housemate at a door in their turf, then a knock — sent once, at the door', async () => {
  const lat = 49.1331; const lng = -122.8531;
  const maya = await c.createPerson('Door Maya', { address: '7230 124 St', city: 'Surrey', lat, lng });
  const turf = (await c.action('turf.create', {
    name: `Outbox turf ${tag}`, polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.001], [lat - 0.001, lng + 0.001], [lat - 0.001, lng - 0.001]],
  })).json.turf;
  const meB = (await vol.get('/api/auth/me')).json;
  assert.equal((await c.action('turf.assign', { turf_id: turf.id, user_id: meB.user.id })).status, 200);
  ob.setOutboxOwner(meB);
  net.cookie = vol.cookie;

  nav.onLine = false;
  const door = { address: '7230 124 St', unit: null, lat, lng };
  const made = await ob.queueAction('person.addAtDoor', { housemate_id: maya.id, name: 'Ravi Housemate', phone: '604-555-0107' }, { who: 'Ravi Housemate', door });
  assert.equal(made.queued, true);
  const id = made.client_id;
  await ob.logContact({ person_id: id, channel: 'door', outcome: 'contacted', rating: '1' }, { who: 'Ravi Housemate' });
  const item = JSON.parse(store.get('starbase:outbox:v2')).find((i) => i.cid === id);
  assert.equal(item.input.id, id, 'the id is made on the phone');
  assert.equal(item.input.address, undefined, 'the server, not the phone, says where they live');
  assert.match(ob.itemText(item), /^New person · Ravi Housemate · /);
  // The walk list and map show them at the door before anything is sent.
  const inTurf = ob.pendingPeopleIn(turf.polygon);
  assert.equal(inTurf.length, 1);
  assert.equal(inTurf[0].address, '7230 124 St');
  assert.equal(inTurf[0].pending, true);
  const over = ob.applyOutbox({ persons: [], signs: [], unlocated: 0 });
  assert.equal(over.persons.find((p) => p.id === id)?.rating, '1');

  // Signal back; the first answer is lost after the server wrote it.
  nav.onLine = true;
  net.loseNext = 1;
  assert.equal((await ob.flushOutbox()).sent, 0);
  assert.equal((await ob.flushOutbox()).sent, 2);
  const found = await persons('Ravi Housemate');
  assert.equal(found.length, 1, 'one Ravi, not two');
  assert.equal(found[0].id, id);
  assert.equal(found[0].address, '7230 124 St');
  assert.equal(found[0].city, 'Surrey');
  assert.equal(found[0].rating, '1');
  assert.equal((await contactsOf(id)).length, 1, 'one knock');
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
  ob.setOutboxOwner(null);
  net.cookie = c.cookie;
});

test('a knock on someone added here whose adding was refused: kept, in plain words; Try again brings it along', async () => {
  const lat = 49.1341; const lng = -122.8541;
  const host = await c.createPerson('Door Priya', { address: '7250 124 St', city: 'Surrey', lat, lng });
  const turf = (await c.action('turf.create', {
    name: `Refused turf ${tag}`, polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.001], [lat - 0.001, lng + 0.001], [lat - 0.001, lng - 0.001]],
  })).json.turf;
  const meB = (await vol.get('/api/auth/me')).json;
  assert.equal((await c.action('turf.assign', { turf_id: turf.id, user_id: meB.user.id })).status, 200);
  ob.setOutboxOwner(meB);
  net.cookie = vol.cookie;

  // Offline at the door: a new housemate, a knock and a pin on them.
  nav.onLine = false;
  const made = await ob.queueAction('person.addAtDoor', { housemate_id: host.id, name: 'Sam Refused' }, { who: 'Sam Refused', door: { address: '7250 124 St', lat, lng } });
  const id = made.client_id;
  await ob.logContact({ person_id: id, channel: 'door', outcome: 'contacted', rating: '2' }, { who: 'Sam Refused' });
  await ob.queueAction('person.locate', { id, lat: lat + 0.0001, lng }, { who: 'Sam Refused' });
  // Meanwhile the desk takes them off the turf.
  assert.equal((await c.action('turf.unassign', { turf_id: turf.id, user_id: meB.user.id })).status, 200);

  nav.onLine = true;
  const evsBefore = (await c.get('/api/events?since=0&limit=5000')).json.events.length;
  assert.equal((await ob.flushOutbox()).sent, 0);
  const items = JSON.parse(store.get('starbase:outbox:v2')).filter((i) => i.cid === id || i.input?.person_id === id || i.input?.id === id);
  assert.equal(items.length, 3, 'all three still on the phone — never dropped');
  assert.ok(items.every((i) => i.state === 'refused'));
  const [person, knock, pin] = items;
  assert.match(ob.refusedText(person), /^That door isn’t in your turf$/);
  assert.equal(ob.refusedText(knock), 'Not saved — this person wasn’t added');
  assert.equal(ob.refusedText(pin), 'Not saved — this person wasn’t added');
  assert.equal(knock.tries, 0, 'the knock never went to the server');
  assert.equal((await c.get('/api/events?since=0&limit=5000')).json.events.length, evsBefore, 'nothing written');
  for (const i of items) assert.doesNotMatch(ob.refusedText(i), /workspace/i);

  // Back on the turf: Try again on the person brings the knock and pin along, in order.
  assert.equal((await c.action('turf.assign', { turf_id: turf.id, user_id: meB.user.id })).status, 200);
  const r = await ob.retryItem(id);
  assert.equal(r.sent, 3);
  assert.equal(ob.unsentCount(), 0);
  const [sam] = await persons('Sam Refused');
  assert.equal(sam.id, id);
  assert.equal(sam.rating, '2');
  assert.equal((await contactsOf(id)).length, 1, 'one knock');
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);

  // The server's own "not found" (someone removed meanwhile) in plain words, never "workspace".
  assert.equal(ob.refusedText({ error: { status: 400, message: 'person not found in this workspace' } }), 'Not saved — this person isn’t on the list');
  assert.equal(ob.refusedText({ error: { status: 400, message: 'donor not found in this workspace — create the person first' } }), 'Donor not found — create the person first');
  assert.equal(ob.refusedText({ error: { status: 409, message: 'Shift is full' } }), 'Shift is full');
  assert.equal(ob.refusedText({}), 'Refused');
  ob.setOutboxOwner(null);
  net.cookie = c.cookie;
});

test('two tabs, one outbox: a save, a send or a dismiss here never drops what another tab saved', async () => {
  ob.setOutboxOwner(null);
  net.cookie = c.cookie;
  const here = await c.createPerson('Tab Here', { address: '7301 124 St', lat: 49.1341, lng: -122.8541 });
  const there = await c.createPerson('Tab There', { address: '7305 124 St', lat: 49.1342, lng: -122.8542 });
  nav.onLine = false;
  await ob.logContact({ person_id: here.id, channel: 'door', outcome: 'contacted', rating: '1' }, { who: here.name });
  // Another tab on this computer saves a knock to the same storage; this tab hasn't heard of it.
  const cid = '0b6f7a52-5d1e-4c39-9d8e-2f5a1c7e4b90';
  const shared = JSON.parse(store.get('starbase:outbox:v2'));
  shared.push({
    cid, name: 'contact.log', meta: { who: there.name }, at: new Date().toISOString(), tries: 0, state: 'pending',
    input: { person_id: there.id, channel: 'door', outcome: 'contacted', rating: '4', client_id: cid },
  });
  store.set('starbase:outbox:v2', JSON.stringify(shared));
  // This tab saves again: the other tab's knock is still stored (never overwritten by this tab's older list).
  await ob.logContact({ person_id: here.id, channel: 'door', outcome: 'contacted', note: 'Second visit' }, { who: here.name });
  let stored = JSON.parse(store.get('starbase:outbox:v2'));
  assert.ok(stored.some((i) => i.cid === cid), 'the other tab’s knock survives this tab’s save');
  assert.equal(stored.filter((i) => i.input?.person_id === here.id).length, 2);
  // A refused item dismissed here keeps the other tab's too.
  const junk = 'c9f0e1d2-3b4a-4c5d-8e6f-7a8b9c0d1e2f';
  stored.push({
    cid: junk, name: 'contact.log', meta: {}, at: new Date().toISOString(), tries: 1, state: 'refused', error: { status: 400, message: 'nope' },
    input: { person_id: there.id, channel: 'door', outcome: 'contacted', client_id: junk },
  });
  store.set('starbase:outbox:v2', JSON.stringify(stored));
  ob.dismissItem(junk);
  stored = JSON.parse(store.get('starbase:outbox:v2'));
  assert.equal(stored.length, 3);
  assert.ok(!stored.some((i) => i.cid === junk));

  // Back online: one flush sends all three — this tab's and the other tab's — each once.
  nav.onLine = true;
  const r = await ob.flushOutbox();
  assert.equal(r.sent, 3);
  assert.equal(r.left, 0);
  assert.equal(JSON.parse(store.get('starbase:outbox:v2')).length, 0);
  assert.equal((await contactsOf(here.id)).length, 2);
  const theirs = await contactsOf(there.id);
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].rating, '4');
  // The other tab sending it too (no lock in that browser) is recorded once.
  assert.equal((await c.action('contact.log', { person_id: there.id, channel: 'door', outcome: 'contacted', rating: '4', client_id: cid })).status, 200);
  assert.equal((await contactsOf(there.id)).length, 1);
});

test('sign-out: a note still in an open card goes first, as theirs; after it nothing is saved here', async () => {
  ob.setOutboxOwner(null);
  net.cookie = c.cookie;
  nav.onLine = true;
  const p = await c.createPerson('Held Note', { address: '7311 124 St', lat: 49.1343, lng: -122.8543 });
  const me = { user: { id: `held-${tag}` }, workspace: { id: `ws-${tag}` } };
  ob.setOutboxOwner(me);
  // A card with a note typed and no tap yet (the door card, a profile).
  let box = 'Wants a lawn sign — call back Tuesday';
  const card = () => {
    const text = box;
    box = '';
    return text ? ob.logContact({ person_id: p.id, channel: 'door', outcome: 'contacted', note: text }, { who: p.name }) : null;
  };
  const off = ob.holdNote(card);
  await ob.sendHeldNotes(); // Sign out, before the flush
  assert.equal(box, '', 'the box is emptied: a later close can’t send it again');
  let cs = await contactsOf(p.id);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].note, 'Wants a lawn sign — call back Tuesday');
  await ob.sendHeldNotes();
  assert.equal((await contactsOf(p.id)).length, 1, 'once');
  off();

  // Signed out: a card closing on the way to Sign in saves nothing here.
  ob.closeOutbox();
  net.cookie = '';
  const before = store.get('starbase:outbox:v2');
  await assert.rejects(ob.logContact({ person_id: p.id, channel: 'door', outcome: 'contacted', note: 'After sign-out' }), (e) => e.status === 401);
  assert.equal(store.get('starbase:outbox:v2'), before, 'nothing stored');
  assert.equal(ob.unsentCount(), 0);
  // A last render of the screen being left (the same sign-in) doesn't open it again…
  ob.setOutboxOwner(me);
  await assert.rejects(ob.logContact({ person_id: p.id, channel: 'door', outcome: 'contacted', note: 'Still signed out' }), (e) => e.status === 401);
  // …the next sign-in does (a fresh answer from the server, even for the same person).
  net.cookie = c.cookie;
  ob.setOutboxOwner({ ...me });
  const r = await ob.logContact({ person_id: p.id, channel: 'door', outcome: 'contacted', note: 'Signed in again' }, { who: p.name });
  assert.equal(r.queued, false);
  cs = await contactsOf(p.id);
  assert.equal(cs.length, 2);
  assert.ok(!cs.some((x) => /sign(ed)? out/i.test(x.note || '') && x.note !== 'Wants a lawn sign — call back Tuesday'));
  ob.setOutboxOwner(null);
});
