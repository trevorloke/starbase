// Google Maps as the field map's tiles, through Starbase. Google's Map Tiles
// API hands out tiles against a session, not a plain {z}/{x}/{y} address, so
// the map asks Starbase for /tiles/{z}/{x}/{y}.png (signed in) and Starbase
// fetches each tile from Google with a session it keeps and renews. Tiles
// come back with a day's cache life, and the phone's service worker keeps
// the ones it has drawn for offline canvassing, as with any provider.
//   GOOGLE_MAPS_TILES=1         turn it on
//   GOOGLE_MAPS_SERVER_KEY      a key with the Map Tiles API enabled
//   GOOGLE_MAPS_TILE_TYPE       roadmap (default) | satellite | terrain
// Google's terms ask for its attribution on the map and have their own
// rules on caching and use; the campaign should check them before relying
// on this in the field.
// GOOGLE_MAPS_TILES_URL: a stand-in for Google (tests, local checks) — not for use.
const API = process.env.GOOGLE_MAPS_TILES_URL || 'https://tile.googleapis.com/v1';
export const TILE_PATH = '/tiles/{z}/{x}/{y}.png';
export const MAX_ZOOM = 22;

export const googleTilesOn = (env = process.env) => env.GOOGLE_MAPS_TILES === '1' && Boolean(env.GOOGLE_MAPS_SERVER_KEY);
export const attribution = () => `Map data &copy;${new Date().getFullYear()} Google`;

let session = null; // { token, expiresAt (ms) }
let creating = null;

const mapType = () => (['roadmap', 'satellite', 'terrain'].includes(process.env.GOOGLE_MAPS_TILE_TYPE) ? process.env.GOOGLE_MAPS_TILE_TYPE : 'roadmap');

// A session lasts about two weeks; one request creates it for everyone.
const getSession = async (fresh = false) => {
  if (!fresh && session && Date.now() < session.expiresAt - 60_000) return session.token;
  if (!creating) {
    creating = (async () => {
      const res = await fetch(`${API}/createSession?key=${encodeURIComponent(process.env.GOOGLE_MAPS_SERVER_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapType: mapType(), language: 'en-CA', region: 'CA' }),
      });
      if (!res.ok) throw new Error(`Google Map Tiles session: ${res.status}`);
      const body = await res.json();
      session = { token: body.session, expiresAt: Number(body.expiry) * 1000 || Date.now() + 86_400_000 };
      return session.token;
    })().finally(() => { creating = null; });
  }
  return creating;
};

// → { status, body: ArrayBuffer | null, type } for one tile.
export const fetchTile = async (z, x, y) => {
  const get = async (token) => fetch(`${API}/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(token)}&key=${encodeURIComponent(process.env.GOOGLE_MAPS_SERVER_KEY)}`);
  let res = await get(await getSession());
  // A session Google no longer accepts: make a new one and try once more.
  if (res.status === 400 || res.status === 403 || res.status === 404) {
    res = await get(await getSession(true));
  }
  if (!res.ok) return { status: res.status, body: null, type: null };
  return { status: 200, body: await res.arrayBuffer(), type: res.headers.get('content-type') || 'image/png' };
};

// Tests: forget the session between cases.
export const _resetForTest = () => { session = null; creating = null; };
