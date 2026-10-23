// The copies a browser keeps for no signal (web/src/components/OfflineCache.js
// and KeptCopies.js), with stand-in storage and a real query client — no
// server: where each copy lives and when it goes.
//   · a desk's copies make room among themselves only: the map's doors stay;
//   · each app start drops copies over a day old (the rating scale stays), and
//     any kept under another role — all of them when the role changed;
//   · a phone copy is never taken as fresh (asked again on mount);
//   · an answer with money in it stays in the tab whatever role the tab
//     thinks it has; a desk's People lists stay in the tab;
//   · a 502 from the proxy reads as no answer: the kept copy shows.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

class Store {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const local = new Store();
const session = new Store();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600 * 1000;
let OC; let KC; let api; let QueryClient;

before(async () => {
  globalThis.localStorage = local;
  globalThis.sessionStorage = session;
  OC = await import('../../web/src/components/OfflineCache.js');
  KC = await import('../../web/src/components/KeptCopies.js');
  api = await import('../../web/src/api.js');
  ({ QueryClient } = await import('@tanstack/react-query'));
});

const me = (role, user = 'u1', ws = 'w1') => ({ user: { id: user }, workspace: { id: ws }, role });
const put = (store, m, name, data, at = Date.now()) => store.setItem(OC.copyKey(m, name), JSON.stringify({ at, data }));
const has = (store, m, name) => store.getItem(OC.copyKey(m, name)) != null;
const blob = (n) => ({ rows: 'x'.repeat(n) });

test('desk copies make room among themselves: the field’s doors and Calls list are never pushed out', async () => {
  local.clear(); session.clear();
  const m = me('manager');
  put(local, m, 'doors', blob(1_400_000), Date.now() - 3 * 3600e3);
  put(local, m, 'calls:q=&limit=300&has=phone', blob(900_000), Date.now() - 2 * 3600e3);
  put(local, m, 'turfs', blob(50_000), Date.now() - 3600e3);
  const desk = (name, n) => OC.writeCopy(OC.copyKey(m, `q:manager:${name}`), blob(n), Date.now(),
    { tier: 'local', gen: OC.copyGeneration(), group: { scope: OC.copyScope(m), name: 'q:', max: 1_200_000 } });
  desk('persons:q=&limit=300', 500_000); await sleep(900);
  desk('signs', 200_000); await sleep(900);
  desk('texting:inbox:/texting/all', 300_000); await sleep(900);
  assert.ok(has(local, m, 'doors'), 'the map’s doors stay');
  assert.ok(has(local, m, 'calls:q=&limit=300&has=phone'), 'the Calls list stays');
  assert.ok(has(local, m, 'turfs'));
  assert.ok(has(local, m, 'q:manager:texting:inbox:/texting/all'), 'the newest desk copy is kept');
  const total = [...local.m.values()].reduce((n, v) => n + v.length, 0);
  assert.ok(total <= 3_000_000, `all copies within the total (${total})`);
  // A desk copy that can't fit without the field's copies isn't kept at all.
  desk('persons:q=&limit=300&tag=VIP', 900_000); await sleep(900);
  assert.ok(!has(local, m, 'q:manager:persons:q=&limit=300&tag=VIP'));
  assert.ok(has(local, m, 'doors'));
});

test('each app start drops copies over a day old (the scale stays) and anyone else’s', () => {
  local.clear(); session.clear();
  const m = me('staff');
  const other = me('manager', 'u2');
  put(local, m, 'q:staff:persons:q=&limit=300&tag=donor-prospect', { persons: [] }, Date.now() - 3 * DAY);
  put(local, m, 'doors', { persons: [] }, Date.now() - 2 * DAY);
  put(local, m, 'scale', { scale: { steps: [] } }, Date.now() - 5 * DAY);
  put(local, m, 'q:staff:signs', { signs: [] });
  put(session, m, 'q:staff:brief', { money: null }, Date.now() - 2 * DAY);
  put(local, other, 'q:manager:signs', { signs: [] });
  local.setItem('starbase:field:v1:w1:u1:walk:t1', JSON.stringify({ at: Date.now() - 2 * DAY, data: { turf: { name: 'Old' } } }));
  local.setItem('starbase:field:v1:w1:u1:walk:t2', JSON.stringify({ at: Date.now(), data: { turf: { name: 'New' } } }));
  OC.keepOnlyMine(m);
  assert.ok(!has(local, m, 'q:staff:persons:q=&limit=300&tag=donor-prospect'), 'a list three days old goes');
  assert.ok(!has(local, m, 'doors'));
  assert.ok(!has(session, m, 'q:staff:brief'));
  assert.ok(has(local, m, 'scale'), 'the rating scale stays: no one’s details, and an old list beats the default');
  assert.ok(has(local, m, 'q:staff:signs'), 'today’s copy stays');
  assert.ok(!has(local, other, 'q:manager:signs'), 'another sign-in’s copy goes');
  assert.equal(local.getItem('starbase:field:v1:w1:u1:walk:t1'), null, 'an old walk list goes');
  assert.ok(local.getItem('starbase:field:v1:w1:u1:walk:t2'));
});

test('a role change forgets every copy kept under the old role (a staff member made a volunteer)', () => {
  local.clear(); session.clear();
  OC.forgetPhoneCopies();
  const staff = me('staff', 'u3');
  OC.keepOnlyMine(staff);
  put(local, staff, 'q:staff:persons:q=&limit=300', { persons: [{ email: 'someone@example.org', tags: ['donor-prospect'] }] });
  put(local, staff, 'doors', { persons: [{ email: 'someone@example.org' }] });
  put(local, staff, 'calls:q=&limit=300&has=phone', { persons: [{ email: 'someone@example.org' }] });
  OC.keepOnlyMine(staff); // the same sign-in and role again: nothing goes
  assert.ok(has(local, staff, 'doors'));
  const vol = me('volunteer', 'u3');
  OC.keepOnlyMine(vol); // after a reload, the server says volunteer
  assert.ok(!has(local, staff, 'q:staff:persons:q=&limit=300'), 'the desk list goes');
  assert.ok(!has(local, staff, 'doors'), 'the desk-shaped doors go (they hold everyone’s email)');
  assert.ok(!has(local, staff, 'calls:q=&limit=300&has=phone'));
  // A copy under another role's name goes even without the marker (copies from before it).
  local.removeItem('starbase:copy-role:v1');
  OC.forgetPhoneCopies();
  put(local, vol, 'q:staff:signs', { signs: [] });
  put(local, vol, 'q:volunteer:brief', { money: null });
  OC.keepOnlyMine(vol);
  assert.ok(!has(local, vol, 'q:staff:signs'));
  assert.ok(has(local, vol, 'q:volunteer:brief'));
  // Sign-out forgets all of it, the marker too.
  OC.forgetPhoneCopies();
  assert.equal([...local.m.keys()].filter((k) => k.startsWith('starbase:copy')).length, 0);
});

test('a phone copy is never taken as fresh: a query holding only the copy asks the server on mount', () => {
  local.clear();
  const m = me('volunteer');
  put(local, m, 'doors', { persons: [] }, Date.now() - 2000);
  const copy = OC.phoneCopy(m, 'doors');
  assert.deepEqual(copy.initialData(), { persons: [] });
  assert.ok(Date.now() - copy.initialDataUpdatedAt() < 5000, 'its time stays (the strip says when it’s from)');
  assert.equal(copy.refetchOnMount({ state: { dataUpdateCount: 0 } }), 'always');
  assert.equal(copy.refetchOnMount({ state: { dataUpdateCount: 2 } }), true, 'loaded this session: as usual');
});

test('money stays in the tab whatever role the tab thinks it has; a desk’s People lists too; a 502 shows the copy', async () => {
  local.clear(); session.clear();
  OC.forgetPhoneCopies();
  const qc = new QueryClient({ defaultOptions: { queries: { persister: KC.keptPersister, retry: false, networkMode: 'online' } } });
  KC.watchKeptCopies(qc);
  // A volunteer just made treasurer: this tab still says volunteer, the answer carries money.
  const vol = me('volunteer', 'u5');
  qc.setQueryData(['me'], vol);
  await qc.fetchQuery({ queryKey: ['brief'], queryFn: async () => ({ money: { totalCents: 374200 }, flagged: [{ amount_cents: 70000 }] }) });
  await sleep(900);
  assert.ok(has(session, vol, 'q:volunteer:brief'), 'kept for this tab only');
  assert.ok(!has(local, vol, 'q:volunteer:brief'), 'never in the browser’s lasting storage');
  // A volunteer's own Today (no money) stays in this browser, as before.
  qc.removeQueries({ queryKey: ['brief'] });
  await qc.fetchQuery({ queryKey: ['brief'], queryFn: async () => ({ money: null, flagged: [], pledges: null }) });
  await sleep(900);
  assert.ok(has(local, vol, 'q:volunteer:brief'));
  assert.ok(!has(session, vol, 'q:volunteer:brief'), 'the tab copy is replaced, not left beside it');

  // A desk's People list: donor tags — this tab only.
  const staff = me('staff', 'u6');
  qc.clear();
  qc.setQueryData(['me'], staff);
  const list = { persons: [{ id: 'p1', name: 'Kwame Mensah', email: 'kwame.mensah@example.org', tags: ['donor-prospect'] }] };
  await qc.fetchQuery({ queryKey: ['persons', 'list', 'q=&limit=300'], queryFn: async () => list });
  await sleep(900);
  assert.ok(has(session, staff, 'q:staff:persons:q=&limit=300'));
  assert.ok(!has(local, staff, 'q:staff:persons:q=&limit=300'));

  // The server down behind its proxy: the kept list, not "request failed (502)".
  assert.equal(api.noAnswer(new api.ApiError(502, 'request failed (502)')), true);
  assert.equal(api.noAnswer(new api.ApiError(404, 'not found')), false);
  qc.removeQueries({ queryKey: ['persons'] });
  const got = await qc.fetchQuery({ queryKey: ['persons', 'list', 'q=&limit=300'], queryFn: async () => { throw new api.ApiError(502, 'request failed (502)'); } });
  assert.equal(got.persons[0].name, 'Kwame Mensah');
  // …and a search over it with the proxy down is answered from it too.
  const found = await qc.fetchQuery({ queryKey: ['persons', 'list', 'q=kwame&limit=300'], queryFn: async () => { throw new api.ApiError(503, 'request failed (503)'); } });
  assert.equal(found.persons.length, 1);
  // A refusal is still a refusal.
  qc.removeQueries({ queryKey: ['persons'] });
  await assert.rejects(qc.fetchQuery({ queryKey: ['persons', 'list', 'q=&limit=300'], queryFn: async () => { throw new api.ApiError(403, 'not yours'); } }), /not yours/);
  assert.ok(!has(session, staff, 'q:staff:persons:q=&limit=300'), 'refused: the copy goes');
  qc.clear();
});

test('the strip’s time is what the screen draws: only Today and Money draw the brief; every other read is a side read', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../web/src/', import.meta.url));
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(dir, e.name));
      else if (/\.jsx?$/.test(e.name)) files.push(join(dir, e.name));
    }
  };
  await walk(root);
  const reads = [];
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    for (const m of src.matchAll(/use(?:Infinite)?Query\(\{\s*queryKey:\s*\['brief'\][^\n]*/g)) reads.push({ file: f.slice(root.length), line: m[0] });
  }
  assert.ok(reads.length >= 6, `found the brief's reads (${reads.length})`);
  const drawers = new Set(['pages/Today.jsx', 'pages/Money.jsx']);
  const wrong = reads.filter((r) => !drawers.has(r.file) && !/meta:\s*\{\s*side:\s*true\s*\}/.test(r.line));
  assert.deepEqual(wrong.map((r) => r.file), [], 'a screen that only reads a little of the brief marks it meta: { side: true }');
  assert.ok(reads.some((r) => r.file === 'pages/Shifts.jsx'), 'the shift detail’s providers read is among them');
});
