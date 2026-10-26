// Offline field mode — the server half.
//
//   sql   signs.client_id: the offline outbox's key for a sign request, so a
//         request replayed after reconnecting is the same request (sign.place
//         dedupes on it, per workspace). person.create dedupes on a client-made
//         id and contact.log already has its own client_id.
//   api   GET /api/map/config (signed in, every role): which map tiles to draw.
//         Desk roles also get `setup` — where the tiles come from and which
//         STARBASE_TILE_* settings were ignored — so whoever set them sees it
//         on the map (a mistyped value is otherwise only a server-log line).
//
// Map tiles come from OpenStreetMap unless the deployment names its own
// provider (OSM's volunteer servers are not for heavy use — a big team in
// election week should switch):
//   STARBASE_TILE_URL          https://…/{z}/{x}/{y}.png  ({s} optional)
//   STARBASE_TILE_ATTRIBUTION  the provider's credit line (links allowed)
//   STARBASE_TILE_MAX_ZOOM     1–22 (default 19)
// Read on every request, so a restart is all a change needs.
// Google Maps instead (lib/gtiles.js): GOOGLE_MAPS_TILES=1 with a
// GOOGLE_MAPS_SERVER_KEY that has the Map Tiles API enabled. The map then
// draws /tiles/{z}/{x}/{y}.png from Starbase (signed in), which fetches each
// tile from Google; STARBASE_TILE_* is ignored while it's on.
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { getDb } from '../../db/client.js';
import { loadContext, SESSION_COOKIE } from '../../lib/auth.js';
import { googleTilesOn, fetchTile, attribution as googleCredit, TILE_PATH as GOOGLE_PATH, MAX_ZOOM as GOOGLE_MAX } from '../../lib/gtiles.js';

export const sql = `
alter table signs add column if not exists client_id uuid;
create unique index if not exists signs_client_idx on signs (workspace_id, client_id) where client_id is not null;
`;

export const TILE_DEFAULTS = Object.freeze({
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
});

// A tile template the map can use: http(s), with {z}, {x} and {y}.
const validUrl = (v) => {
  const s = String(v || '').trim();
  if (!/^https?:\/\/[^\s/]+\/\S*$/i.test(s) || s.length > 1000) return null;
  if (!['{z}', '{x}', '{y}'].every((p) => s.includes(p))) return null;
  return s;
};

const warned = new Set();
const warnOnce = (msg) => {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`map tiles: ${msg}`);
};

// ignored: which settings were set but can't be used ('url', 'maxZoom').
export const tileConfig = (env = process.env) => {
  const out = { ...TILE_DEFAULTS, ignored: [] };
  if (googleTilesOn(env)) {
    return { url: GOOGLE_PATH, attribution: googleCredit(), maxZoom: GOOGLE_MAX, ignored: [] };
  }
  if (env.GOOGLE_MAPS_TILES === '1') {
    out.ignored.push('google');
    warnOnce('GOOGLE_MAPS_TILES=1 needs GOOGLE_MAPS_SERVER_KEY — using OpenStreetMap');
  }
  if (env.STARBASE_TILE_URL) {
    const url = validUrl(env.STARBASE_TILE_URL);
    if (url) out.url = url;
    else {
      out.ignored.push('url');
      warnOnce('STARBASE_TILE_URL needs http(s) and {z}/{x}/{y} — using OpenStreetMap');
    }
  }
  // A custom provider without its own credit line gets none rather than
  // OpenStreetMap's (that would be a false credit).
  if (env.STARBASE_TILE_ATTRIBUTION != null && env.STARBASE_TILE_ATTRIBUTION !== '') {
    out.attribution = String(env.STARBASE_TILE_ATTRIBUTION).slice(0, 500);
  } else if (!/openstreetmap\.org\//i.test(out.url)) {
    out.attribution = '';
  }
  if (env.STARBASE_TILE_MAX_ZOOM) {
    const z = Number(env.STARBASE_TILE_MAX_ZOOM);
    if (Number.isInteger(z) && z >= 1 && z <= 22) out.maxZoom = z;
    else {
      out.ignored.push('maxZoom');
      warnOnce('STARBASE_TILE_MAX_ZOOM must be a whole number 1–22 — using 19');
    }
  }
  return out;
};

// Where the tiles come from, in a word: "OpenStreetMap", or the provider's
// host ("tiles.example") — never the whole address (it may carry a key).
const hostOf = (url) => { try { return new URL(String(url).replace(/\{s\}/g, 'a')).hostname; } catch { return ''; } };
export const tileSource = (url) => {
  if (url === GOOGLE_PATH) return 'Google Maps';
  if (url === TILE_DEFAULTS.url || /(^|\.)openstreetmap\.org$/i.test(hostOf(url))) return 'OpenStreetMap';
  return hostOf(url) || 'custom';
};

const DESK = ['manager', 'treasurer', 'staff'];
export const api = new Hono();
api.get('/map/config', (c) => {
  const t = tileConfig();
  const out = { tiles: { url: t.url, attribution: t.attribution, maxZoom: t.maxZoom } };
  // Desk roles: what took, so a mistyped setting shows on the map's sheet.
  if (DESK.includes(c.get('ctx')?.role)) {
    out.setup = { source: tileSource(t.url), custom: t.url !== TILE_DEFAULTS.url, ignored: t.ignored, maxZoom: t.maxZoom };
  }
  return c.json(out);
});

// The Google tiles, for anyone signed in (the map sends the session cookie;
// the service worker fetches them with credentials too). A day's cache life:
// the browser and the worker keep what they've drawn.
export const publicRoutes = new Hono();
publicRoutes.get('/tiles/:z/:x/:y', async (c) => {
  if (!googleTilesOn()) return c.text('Not found', 404);
  const ctx = await loadContext(await getDb(), getCookie(c, SESSION_COOKIE)).catch(() => null);
  if (!ctx) return c.text('Sign in to see the map', 401);
  const z = Number(c.req.param('z'));
  const [x, y] = [c.req.param('x'), c.req.param('y').replace(/\.png$/, '')].map(Number);
  const n = 2 ** z;
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > GOOGLE_MAX || x < 0 || y < 0 || x >= n || y >= n) {
    return c.text('No such tile', 400);
  }
  let t;
  try {
    t = await fetchTile(z, x, y);
  } catch (e) {
    console.warn(`map tiles: ${e.message}`);
    return c.text('Map tiles unavailable', 502);
  }
  if (!t.body) return c.text('Map tiles unavailable', t.status === 404 ? 404 : 502);
  c.header('Content-Type', t.type);
  c.header('Cache-Control', 'private, max-age=86400');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(t.body);
});
