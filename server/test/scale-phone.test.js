// The rating scale on the phone and the desk's kept lists — the web modules
// against the real server, in process (a stand-in localStorage, a navigator
// whose signal we switch off, a fetch into the app):
//   - a knock that waited on the phone says when it was tapped, so a
//     candidate taken off the list meanwhile still counts it, however late
//     it arrives (and one tapped a week after they came off doesn't);
//   - the phone's buttons come from the newer of its two copies of the
//     scale (its own, and the one the sign-in carries);
//   - with no signal, a People / Calls filter on a profile field is never
//     answered with the whole kept list: an exact copy, or No signal.
// Unique emails and campaign names (test:pg runs every file on one database).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { app } from '../index.js';
import { normalizeScale } from '@starbase/shared/scale';

const tag = Math.random().toString(36).slice(2, 8);
const DAY = 86400000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mgr; let vol; let ws; let mgrMe; let ob; let kept; let api; let scaleJs;
const net = { cookie: '' };
const nav = { onLine: true };

const storage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
};
const realFetch = globalThis.fetch;
// Installed once the database is up (PGlite looks for a browser when it boots).
const installBrowser = () => {
  globalThis.localStorage = storage();
  globalThis.sessionStorage = storage();
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('/')) return realFetch(url, init);
    if (nav.onLine === false) throw new TypeError('fetch failed');
    return app.request(url, { ...init, headers: { ...(init.headers || {}), cookie: net.cookie } });
  };
};

before(async () => {
  await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Scale phone ${tag}`, email: `scph.mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  ws = r.json.workspace.id;
  mgrMe = { user: { id: r.json.user.id }, workspace: { id: ws }, role: 'manager' };
  const inv = await mgr.action('member.invite', { email: `scph.vol+${tag}@example.org`, role: 'volunteer' });
  vol = new Client();
  const j = await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Phone Volunteer', password: 'knock-knock-2026' });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  assert.equal((await mgr.post('/api/data/sample', {})).status, 200);
  installBrowser();
  ob = await import('../../web/src/offline.js');
  kept = await import('../../web/src/components/KeptCopies.js');
  api = await import('../../web/src/api.js');
  scaleJs = await import('../../web/src/components/scale.js');
});

const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const listOf = (s) => s.candidates.map((c) => ({ code: c.code, name: c.name, off: c.off }));
const outbox = () => JSON.parse(globalThis.localStorage.getItem('starbase:outbox:v2') || '[]');
// Queue a knock with the phone's clock at `at` (it waited on the phone since).
async function knockAt(at, input) {
  const Real = Date;
  globalThis.Date = class extends Real {
    constructor(...a) { super(...(a.length ? a : [at])); }
    static now() { return at; }
  };
  try { return await ob.logContact(input, { who: 'Knock' }); } finally { globalThis.Date = Real; }
}

test('a knock tapped while a candidate was still offered counts, however late it arrives', async () => {
  net.cookie = vol.cookie;
  const persons = ok(await mgr.get('/api/persons?q=&limit=300')).persons;
  const [early, late] = persons.filter((p) => !p.rating).slice(0, 2);
  // The manager takes Locke off the list; as far as the server knows, 8 days ago.
  const s = ok(await mgr.get('/api/scale')).scale;
  ok(await mgr.action('scale.save', { candidates: listOf(s).map((c) => (c.code === '4B' ? { ...c, off: true } : c)) }));
  const db = await getDb();
  const row = (await db.query('select settings from workspaces where id = $1', [ws])).rows[0];
  const settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
  const offAt = Date.now() - 8 * DAY;
  settings.scale.candidates = settings.scale.candidates.map((c) => (c.code === '4B' ? { ...c, off_at: new Date(offAt).toISOString() } : c));
  await db.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify(settings)]);

  // No signal: one knock tapped 9 days ago (Locke still on the phone's
  // buttons, and on the list), one tapped just now (a week after she came off).
  nav.onLine = false;
  assert.equal((await knockAt(offAt - DAY, { person_id: early.id, channel: 'door', outcome: 'contacted', rating: '4B' })).queued, true);
  assert.equal((await knockAt(Date.now(), { person_id: late.id, channel: 'door', outcome: 'contacted', rating: '4B' })).queued, true);
  assert.equal(outbox().length, 2);
  assert.ok(!outbox().some((i) => i.input.client_at), 'the tap time is the outbox’s own, sent with the knock');

  // Back online, more than 7 days after she came off.
  nav.onLine = true;
  const r = await ob.flushOutbox();
  assert.equal(r.sent, 1, 'the knock tapped before she came off went');
  assert.equal(ok(await mgr.get(`/api/persons/${early.id}`)).person.rating, '4B');
  const left = outbox();
  assert.equal(left.length, 1);
  assert.equal(left[0].state, 'refused');
  assert.equal(left[0].input.person_id, late.id);
  assert.equal(ob.refusedText(left[0]), 'Locke is off the list — pick again');
  assert.equal(ok(await mgr.get(`/api/persons/${late.id}`)).person.rating, null, 'the late tap wrote nothing');
  ob.dismissItem(left[0].cid);
  // The log says when it was tapped.
  const ev = (await db.query(
    `select payload from events where workspace_id = $1 and action = 'contact.log' order by seq desc limit 1`, [ws],
  )).rows[0];
  const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
  assert.equal(Date.parse(payload.client_at), offAt - DAY);
});

test('the phone shows the newer of its scale copies', () => {
  const v0 = { scale: normalizeScale(null) };
  const v1 = { scale: { v: 1, words: { 1: 'Definitely' }, candidates: [{ code: '4D', name: 'McCallum' }] } };
  assert.equal(scaleJs.newerScale(v0, v1), v1, 'the sign-in carries a newer one: it wins');
  assert.equal(scaleJs.newerScale(v1, v0), v1, 'an older sign-in copy never wins');
  assert.equal(scaleJs.newerScale(v1, { scale: { ...v1.scale } }), v1, 'a tie keeps the phone’s own');
  assert.equal(scaleJs.newerScale(undefined, v1), v1);
  assert.equal(scaleJs.newerScale(v0, undefined), v0);
  assert.equal(scaleJs.newerScale(undefined, undefined), undefined);
});

test('no signal: a profile-field filter is an exact kept copy or No signal — never the whole list', async () => {
  net.cookie = mgr.cookie;
  const queryClient = {
    getQueryData: (k) => (k[0] === 'me' ? mgrMe : undefined),
    getQueryCache: () => ({ subscribe: () => () => {}, getAll: () => [] }),
    invalidateQueries: () => {},
  };
  kept.watchKeptCopies(queryClient);
  const fields = ok(await mgr.get('/api/fields')).fields;
  const strata = fields.find((f) => f.name === 'Strata council member');
  const lang = fields.find((f) => f.name === 'Language at home');
  const qs = (extra) => new URLSearchParams({ q: '', limit: '300', ...extra }).toString();
  const query = (s) => ({ queryKey: ['persons', 'list', s], state: { data: undefined, dataUpdatedAt: 0 }, options: {}, observers: [] });
  const load = (s) => kept.keptPersister(() => api.apiGet(`/persons?${s}`), {}, query(s));
  const noAnswer = (s) => kept.keptPersister(() => Promise.reject(new TypeError('fetch failed')), {}, query(s));
  // With signal: the whole list, and one field filter, are opened (and kept).
  const all = (await load(qs())).persons;
  const strataYes = (await load(qs({ field: `${strata.id}:yes` }))).persons;
  assert.ok(all.length > 20 && strataYes.length > 0 && strataYes.length < all.length);
  await sleep(1000); // copies are written a moment after they load
  nav.onLine = false;
  try {
    // A field filter never opened here: No signal (the rows don't carry fields).
    await assert.rejects(noAnswer(qs({ field: `${lang.id}:Punjabi` })), 'not the whole list under the chip');
    await assert.rejects(noAnswer(qs({ rating: '1,2', field: `${lang.id}:Punjabi` })));
    await assert.rejects(noAnswer(qs({ has: 'phone', field: `${lang.id}:Punjabi` })), 'Calls asks with has=phone');
    // The one opened online comes back as it was; a search inside it too.
    assert.deepEqual((await noAnswer(qs({ field: `${strata.id}:yes` }))).persons.map((p) => p.id), strataYes.map((p) => p.id));
    const words = strataYes[0].name.split(' ')[0];
    const inside = (await noAnswer(qs({ q: words, field: `${strata.id}:yes` }))).persons;
    assert.ok(inside.length >= 1 && inside.every((p) => strataYes.some((x) => x.id === p.id)));
    // Filters the rows do carry are still answered from the whole list.
    const undecided = (await noAnswer(qs({ rating: '3' }))).persons;
    assert.equal(undecided.length, all.filter((p) => p.rating === '3').length);
  } finally {
    nav.onLine = true;
  }
});
