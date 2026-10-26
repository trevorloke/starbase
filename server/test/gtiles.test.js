// Google Maps as the field map's tiles (lib/gtiles.js + ext/offline):
// /api/map/config points the map at /tiles/…, which Starbase serves from
// Google with a session it keeps. Google is mocked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { _resetForTest } from '../lib/gtiles.js';

let mgr;
const realFetch = globalThis.fetch;
const env = { ...process.env };
const log = [];
let sessionN = 0;
let tileStatus = 200;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' });
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname !== 'tile.googleapis.com') return realFetch(url, init);
    log.push({ path: u.pathname, key: u.searchParams.get('key'), session: u.searchParams.get('session'), body: init?.body });
    if (u.pathname === '/v1/createSession') {
      sessionN += 1;
      return new Response(JSON.stringify({ session: `sess-${sessionN}`, expiry: String(Math.floor(Date.now() / 1000) + 14 * 86400), tileWidth: 256, tileHeight: 256, imageFormat: 'png' }), { status: 200 });
    }
    if (tileStatus !== 200) return new Response('no', { status: tileStatus });
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  };
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of ['GOOGLE_MAPS_TILES', 'GOOGLE_MAPS_SERVER_KEY', 'GOOGLE_MAPS_TILE_TYPE']) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

const get = (path, cookie) => app.request(path, { headers: cookie ? { cookie } : {} });

test('off by default: OpenStreetMap, and /tiles is not a thing', async () => {
  delete process.env.GOOGLE_MAPS_TILES;
  const cfg = await (await get('/api/map/config', mgr.cookie)).json();
  assert.match(cfg.tiles.url, /openstreetmap/);
  assert.equal((await get('/tiles/14/2611/5636.png', mgr.cookie)).status, 404);
  // Turned on without a key: still OpenStreetMap, and the desk is told.
  process.env.GOOGLE_MAPS_TILES = '1';
  delete process.env.GOOGLE_MAPS_SERVER_KEY;
  const noKey = await (await get('/api/map/config', mgr.cookie)).json();
  assert.match(noKey.tiles.url, /openstreetmap/);
  assert.deepEqual(noKey.setup.ignored, ['google']);
});

test('on: the map draws /tiles from Starbase, credited to Google, up to zoom 22', async () => {
  process.env.GOOGLE_MAPS_TILES = '1';
  process.env.GOOGLE_MAPS_SERVER_KEY = 'tiles-key';
  _resetForTest();
  const cfg = await (await get('/api/map/config', mgr.cookie)).json();
  assert.equal(cfg.tiles.url, '/tiles/{z}/{x}/{y}.png');
  assert.match(cfg.tiles.attribution, /Google/);
  assert.equal(cfg.tiles.maxZoom, 22);
  assert.equal(cfg.setup.source, 'Google Maps');
});

test('a tile: signed in only; one Google session shared and reused; bytes, type and a day of cache', async () => {
  log.length = 0;
  assert.equal((await get('/tiles/14/2611/5636.png')).status, 401, 'no cookie');
  const r = await get('/tiles/14/2611/5636.png', mgr.cookie);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal(Buffer.from(await r.arrayBuffer()).compare(PNG), 0);
  const r2 = await get('/tiles/14/2612/5636.png', mgr.cookie);
  assert.equal(r2.status, 200);
  assert.equal(log.filter((l) => l.path === '/v1/createSession').length, 1, 'one session for both tiles');
  assert.equal(JSON.parse(log[0].body).mapType, 'roadmap');
  assert.ok(log.every((l) => l.key === 'tiles-key'));
  const tiles = log.filter((l) => l.path.startsWith('/v1/2dtiles/'));
  assert.deepEqual(tiles.map((l) => l.path), ['/v1/2dtiles/14/2611/5636', '/v1/2dtiles/14/2612/5636']);
  assert.ok(tiles.every((l) => l.session === 'sess-1'));
});

test('bad coordinates are refused; a rejected session is renewed once; Google down is a 502', async () => {
  for (const p of ['/tiles/23/0/0.png', '/tiles/3/9/0.png', '/tiles/a/0/0.png', '/tiles/-1/0/0.png']) {
    assert.equal((await get(p, mgr.cookie)).status, 400, p);
  }
  log.length = 0;
  tileStatus = 403; // Google no longer takes the session
  const r = await get('/tiles/10/160/350.png', mgr.cookie);
  assert.equal(r.status, 502);
  assert.equal(log.filter((l) => l.path === '/v1/createSession').length, 1, 'a new session was tried');
  assert.equal(log.filter((l) => l.path.startsWith('/v1/2dtiles/')).length, 2, 'then the tile once more');
  tileStatus = 200;
  assert.equal((await get('/tiles/10/160/350.png', mgr.cookie)).status, 200, 'the new session works');
});
