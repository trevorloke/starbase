// Background geocoding (ext/geocoding): a run works through everyone waiting
// for a pin on the server, one lookup per household, copying pins already on
// file, and stops, retries and pauses as it should. The BC Address Geocoder
// is mocked; the real job runner does the work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { startJobRunner, stopJobRunner } from '../lib/jobs.js';

let mgr;
let db;
const realFetch = globalThis.fetch;
const asked = [];
let answer = () => null; // (addressString) → Response | null for the default hit

const hit = (lng, lat, full) => new Response(JSON.stringify({ features: [{ geometry: { coordinates: [lng, lat] },
  properties: { score: 97, matchPrecision: 'CIVIC_NUMBER', fullAddress: full } }] }));

before(async () => {
  process.env.GEOCODE_BACKOFF_MS = '0'; // retry rounds at once, not in 30 s steps
  db = await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' });
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.hostname !== 'geocoder.api.gov.bc.ca') return realFetch(url, opts);
    const q = u.searchParams.get('addressString');
    asked.push(q);
    const custom = await answer(q);
    if (custom) return custom;
    const n = Number(q.match(/^\d+/)?.[0] || 0);
    return hit(-122.8 + n / 1e6, 49.1 + n / 1e6, q);
  };
});

after(() => {
  delete process.env.GEOCODE_BACKOFF_MS;
  globalThis.fetch = realFetch;
  stopJobRunner();
});

const waitFor = async (pred, ms = 15000) => {
  const until = Date.now() + ms;
  for (;;) {
    const s = (await mgr.get('/api/geocode/status')).json;
    if (pred(s)) return s;
    if (Date.now() > until) throw new Error(`timed out; last status ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('without the job runner, start says so (the page then looks up batches itself)', async () => {
  const r = await mgr.post('/api/geocode/start', {});
  assert.equal(r.status, 409);
  assert.equal(r.json.jobsOff, true);
});

test('a run places everyone: one lookup per household, pins already on file copied, units share the building', async () => {
  // Someone at 100 Fraser Hwy is already on the map.
  await mgr.createPerson('Pinned Already', { address: '100 Fraser Hwy', lat: 49.2, lng: -122.7 });
  const household = ['Ana Souza', 'Ben Souza', 'Caio Souza'];
  for (const n of household) await mgr.createPerson(n, { address: '13450 104 Ave', city: 'Surrey' });
  await mgr.createPerson('Unit Person', { address: '13450 104 Ave', unit: '305', city: 'Surrey' });
  await mgr.createPerson('Same Street New', { address: '100 Fraser Hwy' });
  for (let i = 0; i < 250; i++) await mgr.createPerson(`Voter ${i}`, { address: `${20000 + i} 72 Ave` });

  startJobRunner(db, { everyMs: 3_600_000 });
  const started = (await mgr.post('/api/geocode/start', {})).json;
  assert.equal(started.state, 'running');
  const s = await waitFor((x) => x.state === 'done');

  assert.equal(s.remaining, 0);
  assert.equal(s.copied, 1, '100 Fraser Hwy copied from the person already there');
  assert.equal(s.located, 250 + 4, 'everyone else found');
  assert.equal(asked.filter((q) => q.startsWith('13450 104 Ave')).length, 1, 'the household and the unit were one lookup');
  assert.equal(asked.filter((q) => q.startsWith('100 Fraser')).length, 0, 'a known address is not looked up');
  assert.ok(!asked.some((q) => q.includes('305')), 'the building is looked up, not the unit');
  const unit = (await mgr.get('/api/persons?q=Unit%20Person')).json.persons[0];
  const ana = (await mgr.get('/api/persons?q=Ana%20Souza')).json.persons[0];
  assert.equal(unit.lat, ana.lat);
  assert.equal((await mgr.get('/api/persons?q=Same%20Street%20New')).json.persons[0].lat, 49.2);
});

test('no match and vague matches are set aside; a lookup that fails while others work spends a try', async () => {
  answer = (q) => {
    if (q.startsWith('1 Nowhere')) return new Response(JSON.stringify({ features: [] }));
    if (q.startsWith('2 Vague')) return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [-122.8, 49.1] },
      properties: { score: 40, matchPrecision: 'LOCALITY', fullAddress: 'Surrey, BC' } }] }));
    if (q.startsWith('3 Broken')) return new Response('boom', { status: 500 });
    return null;
  };
  await mgr.createPerson('No Match', { address: '1 Nowhere St' });
  await mgr.createPerson('Vague', { address: '2 Vague Rd' });
  await mgr.createPerson('Broken', { address: '3 Broken Ave' });
  await mgr.createPerson('Fine', { address: '4 Fine Ave' });
  await mgr.post('/api/geocode/start', {});
  // Once Broken is the only one left, every round fails: that reads as an
  // outage, so it spends no tries and the run pauses with the reason.
  const s = await waitFor((x) => x.state !== 'running');
  assert.equal(s.state, 'paused');
  assert.equal(s.located, 1, 'a fresh run counts from zero');
  assert.equal(s.unmatched, 2, 'no match + vague, for a pin by hand');
  assert.equal(s.remaining, 1, 'Broken still waits');
  assert.match(s.lastError, /500/);
  assert.equal(asked.filter((q) => q.startsWith('1 Nowhere')).length, 1, 'a no-match is not asked again');
  const broken = (await db.query("select attrs->'geocode' as g from persons where name = 'Broken'")).rows[0].g;
  assert.equal(broken.tries, 1, 'only the round where others worked spent a try');

  // Fixed: Carry on finishes it.
  answer = () => null;
  await mgr.post('/api/geocode/start', {});
  const done = await waitFor((x) => x.state === 'done');
  assert.equal(done.remaining, 0);
  assert.equal(done.located, 2, 'Carry on after a pause keeps counting');
});

test('an outage pauses the run without setting anyone aside', async () => {
  answer = () => new Response('busy', { status: 503 });
  for (let i = 0; i < 5; i++) await mgr.createPerson(`Outage ${i}`, { address: `${40000 + i} 64 Ave` });
  await mgr.post('/api/geocode/start', {});
  const s = await waitFor((x) => x.state !== 'running');
  assert.equal(s.state, 'paused');
  assert.match(s.lastError, /503/);
  assert.equal(s.remaining, 5, 'all still waiting');
  const tries = (await db.query("select attrs->'geocode'->>'tries' as t from persons where name like 'Outage %'")).rows;
  assert.ok(tries.every((r) => r.t == null), 'no tries spent in an outage');
  answer = () => null;
  await mgr.post('/api/geocode/start', {});
  assert.equal((await waitFor((x) => x.state === 'done')).remaining, 0);
});

test('stop holds the run; carry on resumes it', async () => {
  for (let i = 0; i < 400; i++) await mgr.createPerson(`Late ${i}`, { address: `${30000 + i} 88 Ave` });
  answer = () => new Promise((r) => setTimeout(() => r(null), 5));
  await mgr.post('/api/geocode/start', {});
  await waitFor((x) => x.located > 0);
  const stopped = (await mgr.post('/api/geocode/stop', {})).json;
  assert.equal(stopped.state, 'stopped');
  await new Promise((r) => setTimeout(r, 300));
  const held = (await mgr.get('/api/geocode/status')).json;
  assert.equal(held.state, 'stopped');
  assert.ok(held.remaining > 0, 'stopped before the end');
  const before = held.located;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await mgr.get('/api/geocode/status')).json.located, before, 'nothing moves while stopped');
  answer = () => null;
  await mgr.post('/api/geocode/start', {});
  const done = await waitFor((x) => x.state === 'done');
  assert.ok(done.located > before, 'carry on keeps counting');
  assert.equal(done.remaining, 0);
});

test('volunteers cannot read or start a run', async () => {
  const inv = await mgr.action('member.invite', { email: 'v-geo@example.org', role: 'volunteer' });
  const vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'V', password: 'v-geo-pass-1' });
  assert.equal((await vol.get('/api/geocode/status')).status, 403);
  assert.equal((await vol.post('/api/geocode/start', {})).status, 403);
  assert.equal((await vol.post('/api/geocode/stop', {})).status, 403);
});
