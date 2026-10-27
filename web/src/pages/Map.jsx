// Map — field mode. Houses as pins (one per address + unit), colored by the
// household's strongest signal; tap a pin for the door card. Every pin is a
// 48px tap target. Pins carry no numbers (a rated door has a white dot, the
// color says the band; a household's head-count is a small people badge on
// its corner) — the only number on the map is a group's door count: doors
// that would overlap at the current zoom merge into one white bubble with a
// house and the count — tap it to zoom in. Volunteers open on their own turf
// ("My turf"); on their first visit one slim line under the pill says "Tap a
// house to start" until they open a door or tap its ✕ (remembered per
// browser). The chrome is one row: the "Show: …" filter pill (its sheet:
// which doors, then — desk — the turf outlines switch, walk lists and
// "Draw turf"), then a volunteer's "Walk list" chip, or for desk roles the
// "Draw turf" control and the "Not on map" count chip, and two round
// buttons (Locate me, + Add door). No signal and no doors loaded: one line
// and the walk list kept on the phone. Place mode drops
// people who have an address but no pin, "add door" creates a person at a
// tapped spot, and ?person=<id> deep-links to (and selects) a door. Turfs are
// translucent polygons (the Turfs chip shows/hides them); tap one for its
// sheet (progress, canvassers, walk list), desk roles draw new ones point by
// point, and ?turf=<id> fits the map to (and selects) a turf. ?draw=1 opens
// straight into drawing. Plain Leaflet in a ref'd div; divIcon pins so no
// marker-image paths are involved.
// Offline: the doors are kept on the phone (components/OfflineCache.js) and
// shown with "Offline copy" when there's no signal; what the outbox still
// holds (src/offline.js) is laid over them — a person added here, a dropped
// pin, a sign request, a rating — so it shows at once, marked "Not sent yet".
// Pins go through the outbox too. Tiles come from GET /api/map/config
// (OpenStreetMap unless STARBASE_TILE_* say otherwise); the service worker
// keeps the ones already looked at, so a turf seen with signal still draws.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { apiGet, action } from '../api.js';
import { applyOutbox, queueAction, useOutbox } from '../offline.js';
import { phoneCopy, showingCopy, useKeepCopy } from '../components/OfflineCache.js';
import { queuedText } from '../components/queued.js';
import { bandOf, offTail, ratingByCode } from '@starbase/shared/scale';
import DoorCard, { AddDoorForm, SIGN_LABEL, doorTitle, patchDoors } from '../components/DoorCard.jsx';
import { More, useScale } from '../components/RatingButtons.jsx';
import GeocodeButton from '../components/GeocodeButton.jsx';
import { DEFAULT_TILES, safeAttribution } from '../components/tiles.js';
import { useSharePref } from '../components/ShareLocation.js';
import { cachedWalkLists, useOnline } from './Turfs.jsx';
import './map.css';

const SURREY = [49.1913, -122.849];
// "My turf" (volunteers with a turf) comes first and is where they start:
// their walk list's doors, not the whole city's.
const MINE = { key: 'mine', label: 'My turf' };
// Which doors to show (one at a time). "Yes (1–2)" says what the rating
// buttons say; "Has a sign" is a which-doors choice too (doors with a sign).
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'support', label: 'Yes (1–2)' },
  { key: 'undecided', label: 'Undecided' },
  { key: 'opposed', label: 'Opposed' },
  { key: 'unrated', label: 'Unrated' },
  { key: 'signs', label: 'Has a sign' },
];
const FILTER_LABEL = Object.fromEntries([MINE, ...FILTERS].map((f) => [f.key, f.label]));

const isPhone = () => window.matchMedia('(max-width: 720px)').matches;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const norm = (s) => String(s || '').trim().toLowerCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Leaflet hands back unwrapped longitudes after panning round the world; the
// server's zod schema wants lat ∈ [-90, 90], lng ∈ [-180, 180].
const wrapped = (latlng) => { const ll = L.latLng(latlng).wrap(); return { lat: ll.lat, lng: ll.lng }; };
// person.create is desk-only (manager/treasurer/staff); volunteers can rate,
// log, place pins and request signs, and add a housemate at a door inside a
// turf they walk (person.addAtDoor), but not add new doors.
const CREATE_ROLES = ['manager', 'treasurer', 'staff'];
const isTyping = (el) =>
  el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

// ── Turfs ──
// New turfs cycle through hues that never read as a rating band (no green,
// yellow or red), so a turf outline can't be mistaken for support/opposed.
const TURF_COLORS = ['#2b6cb0', '#7b3fa0', '#b5651d', '#1f7a6d', '#a0306a', '#4c5a8a'];
const MAX_TURF_POINTS = 500; // turf.create: polygon max(500)
const TURFS_PREF = 'starbase:map:turfs';
const EMPTY_LIST = [];
const EMPTY_DRAFT = { points: [], naming: false };
const readTurfsPref = () => { try { return localStorage.getItem(TURFS_PREF) !== '0'; } catch { return true; } };
const writeTurfsPref = (on) => { try { localStorage.setItem(TURFS_PREF, on ? '1' : '0'); } catch { /* storage blocked */ } };
// A volunteer's first-visit hint, once per browser (blocked storage: once per visit).
const HINT_PREF = 'starbase:map:hint-seen';
const readHintSeen = () => { try { return localStorage.getItem(HINT_PREF) === '1'; } catch { return false; } };
const writeHintSeen = () => { try { localStorage.setItem(HINT_PREF, '1'); } catch { /* storage blocked */ } };

const hashIndex = (s, n) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % n; };
const isColor = (c) => typeof c === 'string' && c.length <= 20 && typeof CSS !== 'undefined' && CSS.supports?.('color', c);
const turfColor = (t) => (isColor(t?.color) ? t.color : TURF_COLORS[hashIndex(t?.id || t?.name || '', TURF_COLORS.length)]);
const validRing = (ring) => Array.isArray(ring) && ring.length >= 3
  && ring.every((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])));

// Same ray-casting test the server uses for walk lists (server/lib/geo.js).
function pointInPolygon(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Doors + people inside a ring, from the map's own door model (an estimate
// for a turf that is still being drawn; the server's numbers replace it).
function countInside(doors, ring) {
  let n = 0;
  let people = 0;
  for (const d of doors) {
    if (pointInPolygon(d.lat, d.lng, ring)) { n += 1; people += d.persons.length; }
  }
  return { doors: n, people };
}

// One door per (address + unit); located people without an address group by spot.
const doorKey = (p) =>
  p.address ? `${norm(p.address)}|${norm(p.unit)}` : `@${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;

// Household signal: any opposed → opposed; else any support → support;
// else any undecided → undecided; else unrated.
function householdBand(persons) {
  let support = false;
  let undecided = false;
  for (const p of persons) {
    const band = bandOf(p.rating);
    if (band === 'opposed') return 'opposed';
    if (band === 'support') support = true;
    else if (band === 'undecided') undecided = true;
  }
  return support ? 'support' : undecided ? 'undecided' : 'unrated';
}

function buildDoors(data) {
  const byKey = new Map();
  for (const p of data.persons || []) {
    const key = doorKey(p);
    let door = byKey.get(key);
    if (!door) {
      door = { key, address: p.address, unit: p.unit, lat: Number(p.lat), lng: Number(p.lng), persons: [], signs: [] };
      byKey.set(key, door);
    }
    door.persons.push(p);
  }
  const byPerson = new Map();
  for (const door of byKey.values()) for (const p of door.persons) byPerson.set(p.id, door);
  const orphanSigns = [];
  for (const s of data.signs || []) {
    const door = (s.person_id && byPerson.get(s.person_id)) || (s.address && byKey.get(`${norm(s.address)}|`)) || null;
    if (door) door.signs.push(s);
    else if (s.lat != null && s.lng != null) orphanSigns.push(s);
  }
  const doors = [...byKey.values()];
  for (const door of doors) door.band = householdBand(door.persons);
  spreadStacked(doors);
  return { doors, byPerson, orphanSigns };
}

// Units in one building share a lat/lng, so their pins would stack exactly.
// Fan the extras out on a small sunflower spiral (pixel offsets, unit order)
// so every door stays tappable; the first unit keeps the true spot.
function spreadStacked(doors) {
  const spots = new Map();
  for (const door of doors) {
    door.offset = [0, 0];
    const k = `${door.lat.toFixed(5)},${door.lng.toFixed(5)}`;
    if (!spots.has(k)) spots.set(k, []);
    spots.get(k).push(door);
  }
  for (const group of spots.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(a.unit || '').localeCompare(String(b.unit || ''), undefined, { numeric: true }));
    group.forEach((door, i) => {
      const r = 36 * Math.sqrt(i); // ≥ CLUSTER_PX apart once zoomed all the way in
      const t = i * 2.39996; // golden angle
      door.offset = [Math.round(r * Math.cos(t)), Math.round(r * Math.sin(t))];
    });
  }
}

const EMPTY_MODEL = { doors: [], byPerson: new Map(), orphanSigns: [] };

// ── Pins, count bubbles, sign flags ──
// Every marker is a 48x48 transparent hit box (field rule) around the
// visible glyph. Doors closer than CLUSTER_PX on screen merge into one
// bubble, so a tap always lands on the door it looks like it lands on.
const CLUSTER_PX = 36;
// A volunteer's turf opens as close as its doors allow: just room for the
// edge pins (half a 48px hit box), so neighbours land far enough apart.
const PIN_INSET = 20;
const CLUSTER_OFF_ZOOM = 19; // everything apart (or the tiles' max zoom, if lower)

// The service worker keeps tiles from this provider once they've been seen
// (never fetched ahead — tile servers' rules).
function tellServiceWorker(url) {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
  if (!sw) return;
  const msg = { type: 'starbase:tiles', url };
  sw.controller?.postMessage(msg);
  sw.ready?.then((reg) => reg.active?.postMessage(msg)).catch(() => {});
}
const SIGN_STATUS = { installed: 'Installed', requested: 'Requested', removed: 'Removed' };
const HOUSE_SVG = '<svg viewBox="0 0 12 10" aria-hidden="true"><path d="M6 0 0 5h1.6v5h3.2V7h2.4v3h3.2V5H12z"/></svg>';
const PEOPLE_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="4.6" r="3.1"/><path d="M1.8 15.5c0-3.6 2.8-6.2 6.2-6.2s6.2 2.6 6.2 6.2z"/></svg>';

// "Rosa Delgado (4 · Locke)" for a pin's title (the campaign's scale).
function personTitle(scale, p) {
  const r = ratingByCode(scale, p.rating);
  if (!r) return p.name;
  return `${p.name} (${r.band === 'opposed' && r.code !== '4' ? `4 · ${r.name}${offTail(r)}` : r.short})`;
}

// A door pin; its signs fly as little flags at the top-right, inside the
// same hit box, so tapping a flag opens the door.
function pinIcon(door, selected) {
  const n = door.persons.length;
  const cls = ['map-pin', `map-pin--${door.band}`, n > 1 ? 'map-pin--multi' : '', selected ? 'map-pin--selected' : ''].filter(Boolean).join(' ');
  const household = n > 1 ? `<span class="map-pin__hh">${PEOPLE_SVG}${n}</span>` : '';
  const flags = door.signs.slice(0, 3).map((s, i) =>
    `<i class="map-flag map-flag--${esc(s.status)}" style="left:${34 + i * 10}px;top:-6px"><i class="map-flag__face"></i><i class="map-flag__post"></i></i>`).join('');
  return L.divIcon({
    className: 'map-pin-wrap',
    // No digit on a pin (a "3" would read as 3 doors next to a count bubble):
    // a rated door gets a white dot, the color says the band.
    html: `<div class="${cls}">${door.band === 'unrated' ? '' : '<span class="map-pin__dot"></span>'}${household}</div>${flags}`,
    iconSize: [48, 48],
    iconAnchor: [24 - door.offset[0], 42 - door.offset[1]],
  });
}

// A bubble for several nearby doors: the count, ringed by their bands.
function clusterIcon(doors, offset) {
  const c = { support: 0, undecided: 0, opposed: 0, unrated: 0 };
  for (const d of doors) c[d.band] += 1;
  const pct = (k) => `${((k / doors.length) * 100).toFixed(1)}%`;
  const a = c.support;
  const b = a + c.undecided;
  const o = b + c.opposed;
  return L.divIcon({
    className: 'map-cluster-wrap',
    html: `<div class="map-cluster" style="--a:${pct(a)};--b:${pct(b)};--c:${pct(o)}"><span class="map-cluster__n">${HOUSE_SVG}${doors.length}</span></div>`,
    iconSize: [48, 48],
    iconAnchor: [24 - offset[0], 44 - offset[1]], // bubble where the pin bodies would be
  });
}

// A sign with no door: its own 48px tap target.
function signIcon(status) {
  return L.divIcon({
    className: 'map-sign-wrap',
    html: `<i class="map-flag map-flag--${esc(status)}"><i class="map-flag__face"></i><i class="map-flag__post"></i></i>`,
    iconSize: [48, 48],
    iconAnchor: [24, 34],
  });
}

// Group doors whose pins would sit closer than CLUSTER_PX at this zoom.
// Projection math only (no map instance needed); offsets are the stacked
// units' fan-out, in pixels.
function clusterDoors(doors, zoom, offZoom = CLUSTER_OFF_ZOOM) {
  if (zoom == null) return EMPTY_LIST;
  if (zoom >= offZoom) return doors.map((d) => [d]);
  const R2 = CLUSTER_PX * CLUSTER_PX;
  const cells = new Map();
  const groups = [];
  for (const d of doors) {
    const pt = L.CRS.EPSG3857.latLngToPoint(L.latLng(d.lat, d.lng), zoom);
    const x = pt.x + d.offset[0];
    const y = pt.y + d.offset[1];
    const cx = Math.floor(x / CLUSTER_PX);
    const cy = Math.floor(y / CLUSTER_PX);
    let hit = null;
    for (let i = -1; i <= 1 && !hit; i += 1) {
      for (let j = -1; j <= 1 && !hit; j += 1) {
        for (const g of cells.get(`${cx + i},${cy + j}`) || EMPTY_LIST) {
          if ((g.x - x) ** 2 + (g.y - y) ** 2 < R2) { hit = g; break; }
        }
      }
    }
    if (hit) { hit.doors.push(d); continue; }
    const g = { x, y, doors: [d] };
    groups.push(g);
    const k = `${cx},${cy}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(g);
  }
  return groups.map((g) => g.doors);
}

const meIcon = () => L.divIcon({ className: 'map-me-wrap', html: '<div class="map-me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });

// Pan so a latlng is not hidden under the overlays: the filter strip on top
// and the drawer (right panel on desktop, bottom sheet on phones). Measures
// the real DOM, so it holds whatever the chrome wraps to.
function revealLatLng(map, ll, page) {
  const size = map.getSize();
  const box = map.getContainer().getBoundingClientRect();
  const topEl = page?.querySelector('.map-top');
  const sheet = page?.querySelector('.map-sheet');
  const top = topEl ? Math.max(0, topEl.getBoundingClientRect().bottom - box.top) + 8 : 96;
  let right = size.x;
  let bottom = size.y;
  if (sheet) {
    const r = sheet.getBoundingClientRect();
    if (isPhone()) bottom = Math.min(bottom, r.top - box.top);
    else right = Math.min(right, r.left - box.left);
  }
  if (bottom - top < 80) bottom = top + 80; // tiny viewports: best effort
  const pt = map.latLngToContainerPoint(ll);
  if (pt.x > 24 && pt.x < right - 24 && pt.y > top + 40 && pt.y < bottom - 12) return;
  map.setView(ll, Math.max(map.getZoom(), 16), { animate: false });
  // Put the pin (tip at ll, body ~38px above) in the middle of the free area.
  const cx = right / 2;
  const cy = (top + bottom) / 2 + 19;
  map.panBy([size.x / 2 - cx, size.y / 2 - cy], { animate: false });
}

// Fit a turf into the part of the map the overlays leave free (filter strip
// on top, the sheet on the right on desktop or along the bottom on phones).
// onlyIfHidden: leave the view alone when every corner is already in sight.
// inset: extra pixels on every side (room for the pins at the edges).
function fitTurf(map, ring, page, { onlyIfHidden = false, maxZoom = 17, pad = 0, inset = 0 } = {}) {
  const size = map.getSize();
  const box = map.getContainer().getBoundingClientRect();
  const topEl = page?.querySelector('.map-top');
  const sheet = page?.querySelector('.map-sheet');
  const gap = 16;
  let top = gap;
  let right = gap;
  let bottom = gap;
  if (topEl && topEl.offsetParent !== null) top = Math.max(gap, topEl.getBoundingClientRect().bottom - box.top + 8);
  if (sheet) {
    const r = sheet.getBoundingClientRect();
    if (isPhone()) bottom = Math.max(gap, box.bottom - r.top + 8);
    else right = Math.max(gap, box.right - r.left + 8);
  }
  // Tiny viewports: keep at least a sliver of map to fit into.
  if (size.y - top - bottom < 120) bottom = Math.max(gap, size.y - top - 120);
  if (size.x - right - gap < 120) right = gap;
  if (onlyIfHidden && ring.every((ll) => {
    const pt = map.latLngToContainerPoint(ll);
    return pt.x >= gap && pt.x <= size.x - right && pt.y >= top && pt.y <= size.y - bottom;
  })) return;
  const bounds = pad ? L.latLngBounds(ring).pad(pad) : L.latLngBounds(ring);
  map.fitBounds(bounds, {
    paddingTopLeft: [gap + inset, top + inset],
    paddingBottomRight: [right + inset, bottom + inset],
    maxZoom,
    animate: false,
  });
}

// The first corner of a turf being drawn: a 44px tap target (tap it to close
// the shape once there are 3+ corners) around a visible dot.
const draftStartIcon = (closable) => L.divIcon({
  className: `map-draft-start${closable ? ' is-closable' : ''}`,
  html: '<span class="map-draft-dot"></span>',
  iconSize: [44, 44],
  iconAnchor: [22, 22],
});

function TurfGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="map-glyph">
      <path d="M5 7l8-3 7 6-3 9-11-2z" />
      <circle cx="5" cy="7" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="13" cy="4" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="20" cy="10" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="17" cy="19" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="6" cy="17" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function FilterGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="map-glyph">
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

// A walk list: a list with tick boxes.
function WalkGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="map-glyph">
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11" />
      <circle cx="5.5" cy="18" r="1.6" />
    </svg>
  );
}

function PinGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="map-glyph">
      <path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z" />
      <circle cx="12" cy="10" r="2.2" />
    </svg>
  );
}

function LocateGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </svg>
  );
}

// People with an address but no pin yet. Server search, client filter.
function PlacePicker({ unlocated, onPick, onClose }) {
  const [q, setQ] = useState('');
  const persons = useQuery({
    queryKey: ['persons', 'unlocated', q],
    queryFn: () => apiGet(`/persons?q=${encodeURIComponent(q)}&limit=500`),
    placeholderData: keepPreviousData,
  });
  const rows = (persons.data?.persons ?? []).filter((p) => p.lat == null && p.address);
  const partial = !q && persons.data && rows.length < unlocated;
  return (
    <aside className="map-sheet map-place-picker" aria-label="People not on the map yet">
      <header className="mapsheet-head">
        <h2 className="mapsheet-title">Drop pins by hand · {unlocated}</h2>
        <button type="button" className="btn btn-quiet mapsheet-close" onClick={onClose} aria-label="Close">✕</button>
      </header>
      <div className="field">
        <label htmlFor="place-q" className="fk-sr">Search</label>
        <input
          id="place-q" className="input" type="search" autoFocus placeholder="Search name or street"
          value={q} onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {persons.isError && <p className="error" style={{ padding: '0 16px' }}>{persons.error.message}</p>}
      <ul className="map-place-list">
        {rows.map((p) => (
          <li key={p.id}>
            <button type="button" className="map-place-row" onClick={() => onPick(p)}>
              <span className="map-place-row__name">{p.name}</span>
              <span className="map-place-row__addr muted">{p.unit ? `${p.unit} – ` : ''}{p.address}</span>
            </button>
          </li>
        ))}
        {partial && rows.length > 0 && (
          <li className="muted map-place-empty">{rows.length} of {unlocated} · search for more</li>
        )}
        {persons.isPending && persons.fetchStatus === 'paused' && (
          <li className="muted map-place-empty">Offline — loads with signal</li>
        )}
        {rows.length === 0 && !persons.isPending && (
          <li className="muted map-place-empty">{q ? 'No match' : 'Everyone is on the map'}</li>
        )}
      </ul>
    </aside>
  );
}

function TurfBar({ done, total }) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <span
      className="turf-bar" role="progressbar" aria-label="Doors done"
      aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(done, total)}
    >
      <span className="turf-bar__fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

// The sheet for one turf: progress and the walk list up front; canvassers
// (desk roles assign/remove) and the rest (numbers, delete with an in-place
// confirm, all turfs) one tap away.
function TurfSheet({ turf, me, desk, onClose, onDeleted, toast }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pick, setPick] = useState('');
  const [confirming, setConfirming] = useState(false);
  // A turf nobody walks yet: open the canvassers straight away for desk roles.
  const [whoOpen, setWhoOpen] = useState(() => desk && turf.members.length === 0);
  const [moreOpen, setMoreOpen] = useState(false);
  const membersQ = useQuery({ queryKey: ['members'], queryFn: () => apiGet('/members'), enabled: desk, staleTime: 60_000 });
  const teamsQ = useQuery({ queryKey: ['teams'], queryFn: () => apiGet('/teams'), enabled: desk, staleTime: 60_000 });
  const assigned = new Set(turf.members.map((m) => m.id));
  const options = (membersQ.data?.members ?? []).filter((m) => !assigned.has(m.id));
  // A team with someone not on the turf yet.
  const teams = (teamsQ.data?.teams ?? []).filter((t) => t.members.some((m) => !assigned.has(m.id)));
  const left = Math.max(0, turf.doors - turf.doorsDone);
  const invite = me?.role === 'manager'; // the Team screen is manager-only

  // Assignment changes the turf list and Today's "my turfs".
  const run = async (name, input) => {
    setBusy(true);
    setError(null);
    try {
      await action(name, input);
      await Promise.all(['turfs', 'brief'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      return true;
    } catch (err) {
      setError(err.message || 'Not saved — try again');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const assign = async (e) => {
    e.preventDefault();
    if (!pick) return;
    if (pick.startsWith('team:')) {
      const team = teams.find((t) => `team:${t.id}` === pick);
      if (await run('turf.assign', { turf_id: turf.id, team_id: pick.slice(5) })) {
        setPick('');
        toast(`${team?.name || 'The team'} added`);
      }
      return;
    }
    const who = options.find((m) => m.id === pick);
    if (await run('turf.assign', { turf_id: turf.id, user_id: pick })) {
      setPick('');
      toast(`${who?.name || 'They'} added`);
    }
  };

  const unassign = async (m) => {
    if (await run('turf.unassign', { turf_id: turf.id, user_id: m.id })) toast(`${m.name} removed`);
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await action('turf.delete', { id: turf.id });
      onDeleted(turf); // close the sheet first so the URL never points at a missing turf
      queryClient.removeQueries({ queryKey: ['turf', turf.id] });
      queryClient.setQueryData(['turfs'], (d) => (d ? { ...d, turfs: d.turfs.filter((t) => t.id !== turf.id) } : d));
      for (const key of ['turfs', 'brief']) queryClient.invalidateQueries({ queryKey: [key] });
    } catch (err) {
      setError(err.message || 'Not deleted — try again');
      setBusy(false);
    }
  };

  return (
    <aside className="map-sheet turf-sheet" aria-label={`Turf: ${turf.name}`} style={{ '--turf': turfColor(turf) }}>
      <header className="mapsheet-head">
        <h2 className="mapsheet-title"><i className="turf-swatch" aria-hidden="true" />{turf.name}</h2>
        <button type="button" className="btn btn-quiet mapsheet-close" onClick={onClose} aria-label="Close turf">✕</button>
      </header>

      <div className="turf-sheet__body">
        {/* One phrase everywhere (sheet, walk list, turf list, Today): "1 door left" + the bar. */}
        <div className="turf-progress">
          <span className={`turf-progress__text mono${turf.doors && !left ? ' is-done' : ''}`}>
            {turf.doors === 0 ? 'No doors' : left === 0 ? <>All done <span aria-hidden="true">✓</span></> : <><strong>{left}</strong> {left === 1 ? 'door' : 'doors'} left</>}
          </span>
          <TurfBar done={turf.doorsDone} total={turf.doors} />
        </div>
        <Link className="btn btn-primary turf-act" to={`/turfs/${turf.id}`}>Open walk list</Link>

        {/* Assignment is desk work; a volunteer gets the names under More. */}
        {desk && (
        <More id="turf-who" label={`Canvassers · ${turf.members.length}`} open={whoOpen} onToggle={() => setWhoOpen((o) => !o)}>
          {turf.members.length === 0 ? (
            <p className="muted turf-none">No one yet</p>
          ) : (
            <ul className="turf-members">
              {turf.members.map((m) => (
                <li key={m.id} className="turf-member">
                  <span className="turf-member__name">
                    {m.name}{m.id === me?.user?.id && <span className="muted"> (you)</span>}
                  </span>
                  {desk && (
                    <button
                      type="button" className="btn btn-quiet turf-member__remove" disabled={busy}
                      aria-label={`Take ${m.name} off this turf`} title="Take off this turf"
                      onClick={() => unassign(m)}
                    >
                      ✕
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {/* Nobody left to add: no dead picker, just the line (and the invite). */}
          {membersQ.data && !options.length ? (
            <p className="turf-everyone">
              Everyone is on it
              {invite && <> · <Link className="turf-invite" to="/settings">Invite someone</Link></>}
            </p>
          ) : (
            <>
              <form className="turf-assign" onSubmit={assign}>
                <div className="field">
                  <label htmlFor="turf-assign" className="fk-sr">Add a canvasser</label>
                  <select
                    id="turf-assign" className="input" value={pick} disabled={busy || !options.length}
                    onChange={(e) => setPick(e.target.value)}
                  >
                    <option value="">
                      {/* isPending, not isLoading: offline the fetch is paused, and
                          "everyone is on it" would be a wrong answer. */}
                      {membersQ.isPending
                        ? (membersQ.fetchStatus === 'paused' ? 'Offline' : 'Loading…')
                        : membersQ.isError ? 'Couldn’t load the team' : 'Add a canvasser…'}
                    </option>
                    {options.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.role}</option>)}
                    {teams.length > 0 && (
                      <optgroup label="Teams">
                        {teams.map((t) => <option key={t.id} value={`team:${t.id}`}>{t.name} · {t.members.length} {t.members.length === 1 ? 'person' : 'people'}</option>)}
                      </optgroup>
                    )}
                  </select>
                </div>
                <button type="submit" className="btn turf-act" disabled={busy || !pick}>Add</button>
              </form>
              {/* A new campaign's team is just the manager: the way to more people is right here. */}
              {invite && <Link className="fk-link turf-invite-link" to="/settings">Invite someone</Link>}
            </>
          )}
          {membersQ.isError && <p className="error">{membersQ.error.message}</p>}
        </More>
        )}

        <More id="turf-more" open={moreOpen} onToggle={() => setMoreOpen((o) => !o)}>
          <dl className="turf-stats">
            <div><dt>Left</dt><dd>{left}</dd></div>
            <div><dt>People</dt><dd>{turf.people}</dd></div>
            <div><dt>Rated</dt><dd>{turf.rated}</dd></div>
          </dl>
          {!desk && turf.members.length > 0 && (
            <p className="turf-crew">
              {turf.members.map((m) => (m.id === me?.user?.id ? `${m.name} (you)` : m.name)).join(' · ')}
            </p>
          )}
          {desk && (
            confirming ? (
              <div className="turf-confirm" role="group" aria-label="Confirm delete">
                <p>Delete this turf? Knocks stay.</p>
                <div className="turf-confirm__btns">
                  <button type="button" className="btn turf-act turf-danger" disabled={busy} onClick={remove}>
                    {busy ? 'Deleting…' : 'Yes, delete'}
                  </button>
                  <button type="button" className="btn turf-act" disabled={busy} autoFocus onClick={() => setConfirming(false)}>
                    No
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn btn-quiet turf-act turf-delete" onClick={() => { setConfirming(true); setError(null); }}>
                Delete turf
              </button>
            )
          )}
          <Link className="btn btn-quiet turf-act" to="/turfs">All turfs</Link>
        </More>

        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </aside>
  );
}

// A sign that isn't at a known door: what it is, where, and (desk) the list.
function SignSheet({ sign, desk, onClose }) {
  return (
    <aside className="map-sheet sign-sheet" aria-label="Sign">
      <header className="mapsheet-head">
        <div className="door-head">
          <h2 className="mapsheet-title door-head__name">{SIGN_LABEL[sign.kind] || 'Sign'}</h2>
          {sign.address && <span className="door-head__addr">{sign.address}</span>}
        </div>
        <button type="button" className="btn btn-quiet mapsheet-close" onClick={onClose} aria-label="Close sign">✕</button>
      </header>
      <div className="turf-sheet__body">
        <span className={`chip sign-sheet__chip ${sign.status === 'installed' ? 'chip-ok' : 'chip-warn'}`}>
          {SIGN_STATUS[sign.status] || sign.status}
        </span>
        {desk && <Link className="btn turf-act sign-sheet__act" to="/signs">All signs</Link>}
      </div>
    </aside>
  );
}

// A name to start from, so Save works on the first tap: the street(s) most
// of the doors inside are on ("72 Ave", "72 Ave & 128 St"), else "Turf 3";
// a number is added when another turf already has the name.
function suggestTurfName(doors, ring, taken) {
  const streets = new Map();
  for (const d of doors) {
    if (!d.address || !pointInPolygon(d.lat, d.lng, ring)) continue;
    const street = String(d.address).replace(/^\s*[\d-]+[A-Za-z]?\s+/, '').replace(/,.*$/, '').trim();
    if (street) streets.set(street, (streets.get(street) || 0) + 1);
  }
  const top = [...streets.entries()].sort((a, b) => b[1] - a[1]).map(([st]) => st);
  const used = new Set(taken.map((t) => norm(t)));
  let base = top.length ? top.slice(0, 2).join(' & ') : `Turf ${taken.length + 1}`;
  if (base.length > 120) base = base.slice(0, 120).trim();
  let name = base;
  for (let n = 2; used.has(norm(name)); n += 1) name = `${base} ${n}`;
  return name;
}

// After Finish: name the drawn shape. The draft stays on the map behind it.
function NameTurfForm({ points, doors, takenNames, busy, error, onSave, onBack, onCancel }) {
  const [name, setName] = useState(() => suggestTurfName(doors, points, takenNames));
  const [localError, setLocalError] = useState(null);
  const inside = useMemo(() => countInside(doors, points), [doors, points]);
  const submit = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setLocalError('Add a name'); return; }
    setLocalError(null);
    onSave(n);
  };
  const shown = localError || error;
  return (
    <form className="door-card door-form turf-name-form" onSubmit={submit} aria-label="Name this turf">
      <header className="mapsheet-head">
        <div>
          <h2 className="mapsheet-title">Name this turf</h2>
          <span className="door-head__addr">{plural(inside.doors, 'door', 'doors')} · {plural(inside.people, 'person', 'people')}</span>
        </div>
        <button type="button" className="btn btn-quiet mapsheet-close" onClick={onCancel} disabled={busy} aria-label="Discard this turf">✕</button>
      </header>
      <div className="door-form__body">
        <div className="field">
          <label htmlFor="turf-name" className="fk-sr">Turf name</label>
          {/* Prefilled and selected: Save works at once, typing replaces it. */}
          <input
            id="turf-name" className="input" autoFocus required maxLength={200} autoComplete="off"
            placeholder="e.g. Fleetwood East" value={name} onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
        </div>
        {shown && <p className="error turf-form-error" role="alert">{shown}</p>}
        <div className="door-form__actions">
          <button type="submit" className="btn btn-primary door-act" disabled={busy}>{busy ? 'Saving…' : 'Save turf'}</button>
          <button type="button" className="btn door-act" disabled={busy} onClick={onBack}>Keep drawing</button>
          <button type="button" className="btn btn-quiet door-act" disabled={busy} onClick={onCancel}>Discard</button>
        </div>
      </div>
    </form>
  );
}

// Desk: which tiles took (GET /api/map/config's setup) — "Map tiles:
// OpenStreetMap", "Map tiles: tiles.example", or a setting that didn't:
// "Map tiles: OpenStreetMap — custom address ignored".
const tilesLine = (setup) => {
  if (!setup?.source) return null;
  const ignored = Array.isArray(setup.ignored) ? setup.ignored : [];
  const off = [ignored.includes('url') && 'custom address ignored', ignored.includes('maxZoom') && 'max zoom ignored'].filter(Boolean);
  return `Map tiles: ${setup.source}${off.length ? ` — ${off.join(', ')}` : ''}`;
};

// The filter pill's sheet. "Show" — which doors, one at a time. "On the
// map" (desk) — the turf outlines switch. Then the turf tools (walk lists,
// "Draw turf"); a volunteer's walk list has its own chip on the map. Last,
// for desks, one quiet line naming the map tiles (tilesNote).
function FilterSheet({
  filters, filter, onFilter, counts, showTurfs, onTurfs, turfCount, desk, onDraw, unlocated, onPlace, onClose, tilesNote = null,
  sharing = false, onShare = null,
}) {
  return (
    <>
      <button type="button" className="map-scrim" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div className="map-fsheet" role="dialog" aria-label="Show on the map">
        <header className="map-fsheet__head">
          <h2 className="mapsheet-title" id="map-fsheet-show">Show</h2>
          <button type="button" className="btn btn-quiet mapsheet-close" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="map-fsheet__grid" role="radiogroup" aria-labelledby="map-fsheet-show">
          {filters.map((f, i) => (
            <button
              key={f.key}
              type="button"
              role="radio"
              aria-checked={filter === f.key}
              className={`map-fopt${filter === f.key ? ' is-on' : ''}`}
              data-band={f.key}
              autoFocus={filter === f.key || (i === 0 && !filters.some((x) => x.key === filter))}
              onClick={() => onFilter(f.key)}
            >
              <span className="map-fopt__dot" aria-hidden="true" />
              <span className="map-fopt__label">{f.label}</span>
              <span className="map-fopt__n mono">{counts[f.key] ?? 0}</span>
            </button>
          ))}
        </div>
        {desk && (
          <div className="map-fsheet__layers">
            <h3 className="map-fsheet__sub">On the map</h3>
            <button
              type="button"
              role="switch"
              aria-checked={showTurfs}
              className={`map-fswitch${showTurfs ? ' is-on' : ''}`}
              onClick={() => onTurfs(!showTurfs)}
            >
              <span className="map-fswitch__label">Turfs <span className="mono map-fswitch__n">{turfCount}</span></span>
              <span className="map-fswitch__track" aria-hidden="true"><span className="map-fswitch__knob" /></span>
            </button>
          </div>
        )}
        {onShare && (
          <div className="map-fsheet__layers">
            <h3 className="map-fsheet__sub">You</h3>
            <button
              type="button"
              role="switch"
              aria-checked={sharing}
              className={`map-fswitch${sharing ? ' is-on' : ''}`}
              onClick={() => onShare(!sharing)}
            >
              <span className="map-fswitch__label">Share my location while I’m out</span>
              <span className="map-fswitch__track" aria-hidden="true"><span className="map-fswitch__knob" /></span>
            </button>
            <p className="map-fsheet__note">{sharing
              ? 'Managers see where you are on their dashboard, about once a minute, while this is on. Turn it off when you’re done.'
              : 'Off. Turn it on while you canvass and managers see where you are on their dashboard.'}</p>
          </div>
        )}
        {(desk || unlocated > 0) && (
          <div className="map-fsheet__acts">
            {desk && turfCount > 0 && <Link className="btn map-fsheet__act" to="/turfs">Walk lists</Link>}
            {desk && (
              <button type="button" className="btn map-fsheet__act" onClick={onDraw}><TurfGlyph /> Draw turf</button>
            )}
            {!desk && unlocated > 0 && (
              <button type="button" className="btn map-fsheet__act" onClick={onPlace}>Place {unlocated} on map</button>
            )}
          </div>
        )}
        {desk && tilesNote && <p className="map-fsheet__tiles">{tilesNote}</p>}
      </div>
    </>
  );
}

export default function MapPage() {
  const { me } = useOutletContext();
  const queryClient = useQueryClient();
  const scale = useScale();
  const [params, setParams] = useSearchParams();
  const personParam = params.get('person');
  const turfParam = params.get('turf');
  const drawParam = params.get('draw');

  const pageRef = useRef(null);
  const canvasRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef(null);
  const markersRef = useRef(new Map()); // door key → marker
  const fittedRef = useRef(false);
  const centeredOnRef = useRef(null);  // person id we last revealed
  const selectedKeyRef = useRef(null);
  const prevSelectedRef = useRef(null);
  const onMapClickRef = useRef(null);
  const onLongPressRef = useRef(null);
  const onPinClickRef = useRef(null);
  const onClusterClickRef = useRef(null);
  const onSignClickRef = useRef(null);
  const setParamsRef = useRef(null);
  const onTurfClickRef = useRef(null);
  const onDraftStartRef = useRef(null);
  const onKeyRef = useRef(null);
  const focusedTurfRef = useRef(null); // turf id the map was last fitted to (or tapped)
  const drawShiftRef = useRef(0);      // px the map slid down for the draw strip
  const canCreate = CREATE_ROLES.includes(me?.role);

  const [filterPick, setFilter] = useState(null); // null: the role's default (below)
  const [showTurfs, setShowTurfs] = useState(readTurfsPref);
  const [sharing, setSharing] = useSharePref();
  const [hintSeen, setHintSeen] = useState(readHintSeen);
  const hideHint = useCallback(() => { setHintSeen(true); writeHintSeen(); }, []);
  const [draft, setDraft] = useState(EMPTY_DRAFT); // turf being drawn: [lat, lng] points
  const [turfBusy, setTurfBusy] = useState(false);
  const [turfError, setTurfError] = useState(null);
  const [mode, setMode] = useState(null);       // null | 'place' | 'add' | 'draw'
  const [placing, setPlacing] = useState(null); // person being dropped
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addAt, setAddAt] = useState(null);     // { lat, lng } for a brand-new door
  const [locating, setLocating] = useState(false);
  const [zoom, setZoom] = useState(null);        // drives the count bubbles
  const [signSel, setSignSel] = useState(null);  // an orphan sign's sheet
  const [filterOpen, setFilterOpen] = useState(false);
  const filterBtnRef = useRef(null);
  // Closing the filter sheet hands focus back to the button that opened it.
  const closeFilter = useCallback(() => {
    setFilterOpen(false);
    requestAnimationFrame(() => filterBtnRef.current?.focus({ preventScroll: true }));
  }, []);
  const [unlocOpen, setUnlocOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState(null); // { text, act: { label, onClick } | null }
  const toastTimer = useRef(null);

  // toast(text, act?) — act is an optional { label, onClick } button
  // (the door card's "Change"). toast(null) clears it (the Note field got
  // focus — the toast must not sit on what they're typing).
  const toast = useCallback((text, act = null) => {
    clearTimeout(toastTimer.current);
    if (text == null) { setToastMsg(null); return; }
    setToastMsg({ text, act });
    toastTimer.current = setTimeout(() => setToastMsg(null), act ? 4000 : 3000);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // A pin placed moves a person into (or out of) a turf: its counts and walk list change.
  const refresh = useCallback((personId) => {
    for (const key of ['doors', 'persons', 'signs', 'brief', 'turfs', 'turf']) queryClient.invalidateQueries({ queryKey: [key] });
    if (personId) queryClient.invalidateQueries({ queryKey: ['person', personId] });
  }, [queryClient]);
  const onGeocoded = useCallback(() => {
    for (const key of ['doors', 'brief', 'persons', 'turfs', 'turf']) queryClient.invalidateQueries({ queryKey: [key] });
  }, [queryClient]);

  // ── Data ──
  // The doors last loaded are kept on this phone; what the outbox still holds
  // is laid over them (new people, pins, sign requests, ratings).
  const doorsQ = useQuery({
    queryKey: ['doors'], queryFn: () => apiGet('/map/doors'), placeholderData: keepPreviousData, ...phoneCopy(me, 'doors'),
  });
  useKeepCopy(me, 'doors', doorsQ);
  const outbox = useOutbox();
  const doorsData = useMemo(() => applyOutbox(doorsQ.data, outbox.items), [doorsQ.data, outbox.items]);
  const { doors, byPerson, orphanSigns } = useMemo(() => (doorsData ? buildDoors(doorsData) : EMPTY_MODEL), [doorsData]);
  const unlocated = doorsData?.unlocated ?? 0;
  const doorsCopy = showingCopy(doorsQ);

  // Which tiles to draw (kept on the phone too, so offline asks for the same
  // tiles the service worker kept).
  const tilesQ = useQuery({
    queryKey: ['mapConfig'], queryFn: () => apiGet('/map/config'), staleTime: 10 * 60_000, retry: 1, ...phoneCopy(me, 'mapConfig'),
  });
  useKeepCopy(me, 'mapConfig', tilesQ);
  const tiles = tilesQ.data?.tiles || (tilesQ.isError || tilesQ.fetchStatus === 'paused' ? DEFAULT_TILES : null);
  const offZoom = Math.min(CLUSTER_OFF_ZOOM, tiles?.maxZoom || CLUSTER_OFF_ZOOM);
  const offZoomRef = useRef(offZoom);
  offZoomRef.current = offZoom;

  const selectedDoor = personParam ? byPerson.get(personParam) || null : null;
  const selectedKey = selectedDoor?.key || null;
  // Declared before the marker effects so Leaflet handlers see the current key.
  useEffect(() => { selectedKeyRef.current = selectedKey; }, [selectedKey]);

  // Turfs (volunteers get only the ones assigned to them), kept on the phone
  // too: offline, a volunteer still opens on "My turf".
  const turfsQ = useQuery({ queryKey: ['turfs'], queryFn: () => apiGet('/turfs'), ...phoneCopy(me, 'turfs') });
  useKeepCopy(me, 'turfs', turfsQ);
  const turfs = turfsQ.data?.turfs ?? EMPTY_LIST;
  // A volunteer's own turf outline always shows (the switch is desk-only).
  const turfsOn = canCreate ? showTurfs : true;
  // A volunteer's walk list, one tap from the map.
  const myWalk = !canCreate && turfs.length > 0
    ? (turfs.length === 1 ? { to: `/turfs/${turfs[0].id}`, label: 'Walk list' } : { to: '/turfs', label: 'Walk lists' })
    : null;

  // No signal and no doors in memory: say so, and point at the walk list
  // kept on this phone (it opens offline). A server refusal is not this.
  const online = useOnline();
  const noSignal = !doorsQ.data && (doorsQ.fetchStatus === 'paused' || (doorsQ.isError && (!online || !doorsQ.error?.status)));
  const offlineWalk = useMemo(() => (noSignal ? cachedWalkLists(me)[0] || null : null), [noSignal, me]);

  // A volunteer's own doors: inside any turf they walk (the walk list's doors).
  const mineKeys = useMemo(() => {
    if (canCreate) return null;
    const rings = turfs.filter((t) => validRing(t.polygon)).map((t) => t.polygon.map(([lat, lng]) => [Number(lat), Number(lng)]));
    if (!rings.length) return null;
    return new Set(doors.filter((d) => rings.some((r) => pointInPolygon(d.lat, d.lng, r))).map((d) => d.key));
  }, [canCreate, turfs, doors]);
  const filters = mineKeys?.size ? [MINE, ...FILTERS] : FILTERS;
  // Volunteers start on their turf; everyone else on all doors.
  const filter = filterPick && filters.some((f) => f.key === filterPick) ? filterPick : mineKeys?.size ? 'mine' : 'all';

  const shows = useCallback((d) => (
    filter === 'all' ? true
      : filter === 'mine' ? Boolean(mineKeys?.has(d.key))
        : filter === 'signs' ? d.signs.length > 0
          : d.band === filter), [filter, mineKeys]);
  // The open door always keeps its pin, whatever the filter. (Only a door
  // the filter hides changes the list, so a tap doesn't rebuild every pin.)
  const extraKey = selectedDoor && !shows(selectedDoor) ? selectedDoor.key : null;
  const visible = useMemo(() => doors.filter((d) => d.key === extraKey || shows(d)), [doors, shows, extraKey]);
  // Doors per filter, for the filter sheet (numbers, not sentences).
  const counts = useMemo(() => {
    const c = { all: doors.length, mine: mineKeys?.size || 0, support: 0, undecided: 0, opposed: 0, unrated: 0, signs: 0 };
    for (const d of doors) {
      c[d.band] += 1;
      if (d.signs.length) c.signs += 1;
    }
    return c;
  }, [doors, mineKeys]);

  // Deep link to someone who has no pin yet → offer to place them.
  const wantsMissing = Boolean(personParam && doorsQ.data && !selectedDoor && !doorsQ.isFetching);
  const missingQ = useQuery({
    queryKey: ['person', personParam],
    queryFn: () => apiGet(`/persons/${personParam}`),
    enabled: wantsMissing,
  });
  const missingPerson = wantsMissing ? missingQ.data?.person || null : null;
  const missingGone = wantsMissing && missingQ.isError;

  const turfById = useMemo(() => new Map(turfs.map((t) => [t.id, t])), [turfs]);
  const selectedTurf = turfParam ? turfById.get(turfParam) || null : null;
  const turfMissing = Boolean(turfParam && turfsQ.data && !selectedTurf && !turfsQ.isFetching);

  // Selection lives in the URL: /map?person=<id> or /map?turf=<id> (one at a
  // time). react-router's setter changes identity with every search change,
  // so keep `select` stable via a ref — otherwise every tap would rebuild
  // every marker on the map.
  useLayoutEffect(() => { setParamsRef.current = setParams; });
  const select = useCallback((personId) => {
    setSignSel(null);
    setParamsRef.current(personId ? { person: personId } : {}, { replace: true });
  }, []);
  const selectTurf = useCallback((turfId) => {
    setSignSel(null);
    setParamsRef.current(turfId ? { turf: turfId } : {}, { replace: true });
  }, []);

  const cancelMode = () => { setMode(null); setPlacing(null); setDraft(EMPTY_DRAFT); setTurfError(null); };
  const toggleAdd = () => { setMode((m) => (m === 'add' ? null : 'add')); setPlacing(null); setPickerOpen(false); setFilterOpen(false); setDraft(EMPTY_DRAFT); };
  const startPlacing = (person) => { setPlacing(person); setMode('place'); setPickerOpen(false); setAddAt(null); setDraft(EMPTY_DRAFT); };

  const setTurfsShown = (on) => { setShowTurfs(on); writeTurfsPref(on); };

  // ── Drawing a turf ──
  const startDraw = () => {
    setFilterOpen(false);
    setUnlocOpen(false);
    setMode('draw');
    setPlacing(null);
    setPickerOpen(false);
    setAddAt(null);
    setDraft(EMPTY_DRAFT);
    setTurfError(null);
    if (!showTurfs) setTurfsShown(true); // existing turfs are the reference for the new edge
    select(null);
  };
  const addPoint = (latlng) => {
    if (draft.naming) return;
    if (draft.points.length >= MAX_TURF_POINTS) { toast(`${MAX_TURF_POINTS} points max — tap Finish`); return; }
    const { lat, lng } = wrapped(latlng);
    const pt = [Number(lat.toFixed(6)), Number(lng.toFixed(6))];
    setDraft((d) => {
      const last = d.points[d.points.length - 1];
      if (d.naming || (last && last[0] === pt[0] && last[1] === pt[1])) return d;
      return { ...d, points: [...d.points, pt] };
    });
  };
  const undoPoint = () => setDraft((d) => (d.naming ? d : { ...d, points: d.points.slice(0, -1) }));
  const finishDraw = () => {
    if (draft.points.length < 3) return;
    setTurfError(null);
    setDraft((d) => ({ ...d, naming: true }));
  };
  const backToDrawing = () => { setTurfError(null); setDraft((d) => ({ ...d, naming: false })); };

  const saveTurf = async (name) => {
    const polygon = draft.points;
    const color = TURF_COLORS[turfs.length % TURF_COLORS.length];
    setTurfBusy(true);
    setTurfError(null);
    try {
      const res = await action('turf.create', { name, polygon, color });
      const id = res.turf.id;
      // Show it (and its sheet) now; the refetch brings the server's counts.
      queryClient.cancelQueries({ queryKey: ['turfs'] });
      queryClient.setQueryData(['turfs'], (d) => (d ? {
        ...d,
        turfs: [...d.turfs.filter((t) => t.id !== id), {
          id, name: res.turf.name || name, color, polygon, notes: null, members: [],
          ...countInside(doors, polygon), doorsDone: 0, rated: 0,
        }],
      } : d));
      for (const key of ['turfs', 'brief']) queryClient.invalidateQueries({ queryKey: [key] });
      drawShiftRef.current = 0; // the new turf stays where it was drawn
      cancelMode();
      focusedTurfRef.current = id; // it's already on screen — no refit
      selectTurf(id);
      toast(`Saved ${res.turf.name || name}`);
    } catch (err) {
      setTurfError(err.message || 'Not saved — try again');
    } finally {
      setTurfBusy(false);
    }
  };

  // /map?draw=1 (from the turf list) opens straight into drawing.
  useEffect(() => {
    if (drawParam !== '1') return;
    if (canCreate) startDraw();
    else select(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawParam]);

  const locatePerson = async (person, latlng) => {
    try {
      // Through the outbox: no signal, the pin waits on the phone (and shows).
      const r = await queueAction('person.locate', { id: person.id, lat: latlng.lat, lng: latlng.lng }, {
        who: person.name,
        person: {
          name: person.name, phone: person.phone ?? null, address: person.address ?? null, unit: person.unit ?? null,
          rating: person.rating ?? null, rated_at: person.rated_at ?? null, tags: person.tags || [],
        },
      });
      toast(r.queued ? queuedText(r, 'Pin') : `Placed ${person.name}`);
      // Saved on the phone: the outbox lays the pin over the map until it goes.
      if (r.queued) {
        cancelMode();
        centeredOnRef.current = person.id;
        select(person.id);
        return;
      }
      // Drop the pin now; the refetch below confirms it.
      patchDoors(queryClient, (d) => ({
        ...d,
        // The server counts only people WITH an address as unlocated.
        unlocated: person.address && !d.persons.some((p) => p.id === person.id)
          ? Math.max(0, (d.unlocated || 0) - 1)
          : d.unlocated,
        persons: [
          ...d.persons.filter((p) => p.id !== person.id),
          {
            id: person.id, name: person.name, phone: person.phone ?? null, email: person.email ?? null,
            address: person.address ?? null, unit: person.unit ?? null, lat: latlng.lat, lng: latlng.lng,
            rating: person.rating ?? null, rated_at: person.rated_at ?? null, tags: person.tags || [],
          },
        ],
      }));
      cancelMode();
      centeredOnRef.current = person.id; // they tapped the spot — no need to pan
      refresh(person.id);
      select(person.id);
    } catch (err) {
      toast(err.message || 'Not placed — try again');
    }
  };

  const locateMe = () => {
    const map = mapRef.current;
    if (!map) return;
    if (!navigator.geolocation) { toast('No location on this device'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        // The fix can land after the page unmounted (map.remove()d) — bail.
        if (mapRef.current !== map) return;
        const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
        const layer = layersRef.current?.me;
        if (layer) {
          layer.clearLayers();
          if (pos.coords.accuracy) L.circle(ll, { radius: pos.coords.accuracy, className: 'map-me-ring', interactive: false }).addTo(layer);
          L.marker(ll, { icon: meIcon(), interactive: false, keyboard: false, zIndexOffset: 2000 }).addTo(layer);
        }
        map.setView(ll, Math.max(map.getZoom(), 16));
      },
      (err) => {
        setLocating(false);
        toast(err.code === 1 ? 'Location is blocked' : 'Couldn’t find you');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  };

  // Fresh closures for Leaflet's handlers.
  useEffect(() => {
    onMapClickRef.current = (latlng) => {
      if (mode === 'draw') { addPoint(latlng); return; }
      if (mode === 'place' && placing) { locatePerson(placing, wrapped(latlng)); return; }
      if (mode === 'add') { setAddAt(wrapped(latlng)); setMode(null); return; }
      if (personParam || turfParam || signSel) select(null); // tap on empty map closes the card
    };
    onLongPressRef.current = (latlng) => {
      if (mode === 'draw' || (mode === 'place' && placing)) return;
      if (!canCreate) { toast('Only staff can add doors'); return; }
      setAddAt(wrapped(latlng));
      setMode(null);
      setPickerOpen(false);
    };
    // Pins swallow map clicks, so place mode has to handle them too: tapping
    // an existing door drops the person in that building. (While drawing,
    // pins are click-through — see .is-drawing in map.css.)
    onPinClickRef.current = (door) => {
      if (mode === 'draw') { addPoint(L.latLng(door.lat, door.lng)); return; }
      if (mode === 'place' && placing) { locatePerson(placing, { lat: door.lat, lng: door.lng }); return; }
      if (mode === 'add') setMode(null);
      if (selectedKeyRef.current === door.key) return;
      select(door.persons[0].id);
    };
    // A count bubble: zoom in until its doors come apart (any mode — the
    // person being placed or the new door needs a single pin to land on).
    onClusterClickRef.current = (group) => {
      const map = mapRef.current;
      if (!map) return;
      if (!mode && (personParam || turfParam || signSel)) select(null);
      const b = L.latLngBounds(group.map((d) => [d.lat, d.lng]));
      const z = Math.min(offZoomRef.current, Math.max(map.getZoom() + 2, map.getBoundsZoom(b.pad(0.5))));
      map.setView(b.getCenter(), z, { animate: !reducedMotion() });
    };
    onSignClickRef.current = (sign) => {
      if (mode) { onMapClickRef.current?.(L.latLng(Number(sign.lat), Number(sign.lng))); return; }
      if (personParam || turfParam) select(null);
      setPickerOpen(false);
      setAddAt(null);
      setSignSel(sign);
    };
    // Turf polygons don't bubble to the map, so they mirror its rules: in a
    // mode the tap is a map tap; an open door card closes like on empty map.
    onTurfClickRef.current = (turf, latlng) => {
      if (mode) { onMapClickRef.current?.(latlng); return; }
      if (personParam) { select(null); return; }
      if (pickerOpen || addAt || turfParam === turf.id) return;
      focusedTurfRef.current = turf.id; // they're looking right at it — no refit
      selectTurf(turf.id);
    };
    onDraftStartRef.current = () => { if (draft.points.length >= 3) finishDraw(); };
    // Escape backs out of whatever is open; while drawing, Enter finishes and
    // Backspace / Ctrl+Z takes back the last point.
    onKeyRef.current = (e) => {
      if (mode === 'draw' && !draft.naming && !isTyping(e.target)) {
        if (e.key === 'Enter' && draft.points.length >= 3) { e.preventDefault(); finishDraw(); return; }
        if (e.key === 'Backspace' || (e.key === 'z' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); undoPoint(); return; }
      }
      if (e.key !== 'Escape') return;
      if (filterOpen) closeFilter();
      else if (unlocOpen) setUnlocOpen(false);
      else if (mode === 'draw' && draft.naming) backToDrawing();
      else if (mode) cancelMode();
      else if (pickerOpen) setPickerOpen(false);
      else if (addAt) setAddAt(null);
      else if (personParam || turfParam || signSel) select(null);
    };
  });

  useEffect(() => {
    const onKey = (e) => onKeyRef.current?.(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Measure the app chrome so the map can fill the rest of the viewport.
  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el) return undefined;
    // Ceil the real (fractional) heights: offsetHeight rounds down, which
    // left the sheet and map a fraction of a pixel under the tab bar.
    const h = (sel) => Math.ceil(document.querySelector(sel)?.getBoundingClientRect().height || 0);
    const measure = () => {
      // On desktop the nav is the sidebar beside the map, not above it.
      const side = window.matchMedia('(min-width: 721px)').matches;
      el.style.setProperty('--nav-h', `${side ? 0 : h('.nav')}px`);
      el.style.setProperty('--tabbar-h', `${h('.tabbar')}px`);
      mapRef.current?.invalidateSize();
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // ── Leaflet map ──
  useEffect(() => {
    // zoomSnap 0.25: a turf can fill the screen exactly, so its doors open
    // far enough apart that every 48px pin is its own tap.
    const map = L.map(canvasRef.current, { center: SURREY, zoom: 12, zoomSnap: 0.25, zoomControl: false, attributionControl: false });
    L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    // Tiles: added below once GET /api/map/config (or the phone's copy) says which.
    // Turf polygons sit under everything else; a turf being drawn sits over
    // the other vectors (pins and its corner dots are in the marker pane).
    map.createPane('turfs').style.zIndex = 350;
    map.createPane('turfDraft').style.zIndex = 450;
    const layers = {
      turfs: L.layerGroup().addTo(map),
      draft: L.layerGroup().addTo(map),
      signs: L.layerGroup().addTo(map),
      doors: L.layerGroup().addTo(map),
      me: L.layerGroup().addTo(map),
    };
    map.on('click', (e) => onMapClickRef.current?.(e.latlng));
    map.on('zoomend', () => setZoom(map.getZoom()));
    setZoom(map.getZoom());
    map.on('contextmenu', (e) => { e.originalEvent?.preventDefault?.(); onLongPressRef.current?.(e.latlng); });
    mapRef.current = map;
    layersRef.current = layers;
    const markers = markersRef.current;
    return () => {
      map.remove();
      mapRef.current = null;
      layersRef.current = null;
      markers.clear();
      // A remount (StrictMode, fast refresh) gets a fresh map: fit it again.
      fittedRef.current = false;
      centeredOnRef.current = null;
      prevSelectedRef.current = null;
      focusedTurfRef.current = null;
    };
  }, []);

  // The tile layer, from the map settings. The service worker is told which
  // provider's tiles to keep (the ones already seen, never fetched ahead).
  const tileUrl = tiles?.url;
  const tileMax = tiles?.maxZoom;
  const tileCredit = tiles?.attribution;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !tileUrl) return undefined;
    tellServiceWorker(tileUrl); // first, so the first tiles are kept too
    const layer = L.tileLayer(tileUrl, { maxZoom: tileMax || 19, attribution: safeAttribution(tileCredit) }).addTo(map);
    map.setMaxZoom(tileMax || 19);
    return () => { layer.remove(); };
  }, [tileUrl, tileMax, tileCredit]);

  // Turf polygons. Hidden by the Turfs chip, except a selected turf always shows.
  useEffect(() => {
    const layer = layersRef.current?.turfs;
    if (!layer) return;
    layer.clearLayers();
    const list = (turfsOn ? turfs : turfs.filter((t) => t.id === turfParam))
      .filter((t) => validRing(t.polygon))
      .sort((a, b) => (a.id === turfParam) - (b.id === turfParam)); // selected on top
    for (const t of list) {
      const selected = t.id === turfParam;
      const color = turfColor(t);
      const poly = L.polygon(t.polygon.map(([lat, lng]) => [Number(lat), Number(lng)]), {
        pane: 'turfs',
        color,
        weight: selected ? 4 : 2,
        opacity: 0.95,
        fillColor: color,
        fillOpacity: selected ? 0.16 : 0.07,
        className: `map-turf${selected ? ' map-turf--selected' : ''}`,
        bubblingMouseEvents: false,
      });
      // String tooltip content is set as innerHTML — escape the name.
      poly.bindTooltip(esc(t.name), { sticky: true, direction: 'top', offset: [0, -10], className: 'map-turf-tip' });
      poly.on('click', (e) => onTurfClickRef.current?.(t, e.latlng));
      poly.addTo(layer);
    }
  }, [turfs, turfsOn, turfParam]);

  // The turf being drawn: dashed outline, corner dots, a tappable first corner.
  useEffect(() => {
    const layer = layersRef.current?.draft;
    if (!layer) return;
    layer.clearLayers();
    if (mode !== 'draw') return;
    const pts = draft.points;
    const line = { pane: 'turfDraft', color: '#161a2e', weight: 2.5, dashArray: '6 6', interactive: false };
    if (pts.length >= 3) L.polygon(pts, { ...line, fillColor: '#161a2e', fillOpacity: 0.1 }).addTo(layer);
    else if (pts.length === 2) L.polyline(pts, line).addTo(layer);
    pts.forEach((p, i) => {
      if (i === 0) {
        const closable = pts.length >= 3 && !draft.naming;
        L.marker(p, {
          icon: draftStartIcon(closable),
          interactive: closable,
          keyboard: false,
          title: closable ? 'Close the turf here' : '',
          zIndexOffset: 3000,
        }).on('click', () => onDraftStartRef.current?.()).addTo(layer);
      } else {
        L.circleMarker(p, {
          pane: 'turfDraft', radius: 5, color: '#161a2e', weight: 2, fillColor: '#ffffff', fillOpacity: 1, interactive: false,
        }).addTo(layer);
      }
    });
  }, [mode, draft]);

  // Drawing starts: slide the map down by the strip's height, so what was
  // under it can still take a corner. Cancel slides it back; a saved turf
  // stays where it was drawn.
  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (mode !== 'draw') {
      if (drawShiftRef.current) map.panBy([0, drawShiftRef.current], { animate: false });
      drawShiftRef.current = 0;
      return;
    }
    const bar = pageRef.current?.querySelector('.map-mode--draw');
    if (!bar) return;
    const h = Math.round(bar.getBoundingClientRect().bottom - map.getContainer().getBoundingClientRect().top);
    if (h > 0) { map.panBy([0, -h], { animate: false }); drawShiftRef.current = h; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // A double-tap while drawing is two points, not a zoom.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (mode === 'draw') map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
  }, [mode]);

  // Pins (or count bubbles) for the filtered doors, at this zoom. A selected
  // door inside a bubble is pulled out so its pin always shows.
  const groups = useMemo(() => clusterDoors(visible, zoom, offZoom), [visible, zoom, offZoom]);
  const pulledKey = useMemo(
    () => (selectedKey && groups.some((g) => g.length > 1 && g.some((d) => d.key === selectedKey)) ? selectedKey : null),
    [groups, selectedKey],
  );
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    layers.doors.clearLayers();
    layers.signs.clearLayers();
    markersRef.current.clear();
    const addPin = (door) => {
      const selected = door.key === selectedKeyRef.current;
      const marker = L.marker([door.lat, door.lng], {
        icon: pinIcon(door, selected),
        title: `${doorTitle(door)} — ${door.persons.map((p) => personTitle(scale, p)).join(', ')}`,
        riseOnHover: true,
        zIndexOffset: selected ? 1000 : 0,
      });
      marker.on('click', () => onPinClickRef.current?.(door));
      marker.addTo(layers.doors);
      markersRef.current.set(door.key, marker);
    };
    for (const group of groups) {
      const rest = pulledKey ? group.filter((d) => d.key !== pulledKey) : group;
      if (rest.length !== group.length) addPin(group.find((d) => d.key === pulledKey));
      if (rest.length === 1) addPin(rest[0]);
      else if (rest.length > 1) {
        const seed = rest[0];
        L.marker([seed.lat, seed.lng], {
          icon: clusterIcon(rest, seed.offset),
          title: `${plural(rest.length, 'door', 'doors')} — tap to zoom in`,
          riseOnHover: true,
          zIndexOffset: 200,
        })
          .on('click', () => onClusterClickRef.current?.(rest))
          .addTo(layers.doors);
      }
    }
    if (filter === 'all' || filter === 'signs') {
      for (const s of orphanSigns) {
        L.marker([Number(s.lat), Number(s.lng)], {
          icon: signIcon(s.status),
          title: `${SIGN_LABEL[s.kind] || s.kind} · ${SIGN_STATUS[s.status] || s.status}${s.address ? ` · ${s.address}` : ''}`,
          zIndexOffset: 500,
        })
          .on('click', () => onSignClickRef.current?.(s))
          .addTo(layers.signs);
      }
    }
  }, [groups, pulledKey, orphanSigns, filter, scale]);

  // Highlight the selected pin without rebuilding every marker.
  useEffect(() => {
    const paint = (key, on) => {
      const marker = key ? markersRef.current.get(key) : null;
      if (!marker) return;
      marker.getElement()?.querySelector('.map-pin')?.classList.toggle('map-pin--selected', on);
      marker.setZIndexOffset(on ? 1000 : 0);
    };
    paint(prevSelectedRef.current, false);
    paint(selectedKey, true);
    prevSelectedRef.current = selectedKey;
  }, [selectedKey, groups, pulledKey]);

  const naming = mode === 'draw' && draft.naming;
  const turfSheetOpen = Boolean(selectedTurf && !mode && !pickerOpen && !addAt && !selectedDoor);
  const signSheetOpen = Boolean(signSel && !mode && !pickerOpen && !addAt && !selectedDoor && !turfSheetOpen);
  const hasSheet = Boolean(pickerOpen || addAt || naming || (selectedDoor && !mode) || turfSheetOpen || signSheetOpen);
  const showEmpty = doorsQ.data && doors.length === 0 && !hasSheet && !mode;
  // First visit (volunteers): "Tap a house to start" under the pill, only on
  // the plain map with houses to tap — never over a card, sheet or mode bar.
  // Opening any door counts as having started.
  useEffect(() => { if (selectedKey && !hintSeen) hideHint(); }, [selectedKey, hintSeen, hideHint]);
  const showHint = !canCreate && !hintSeen && !hasSheet && !mode && !filterOpen && !noSignal
    && !personParam && !turfParam && visible.length > 0;

  // Fit a turf: desk roles see the whole shape; a volunteer sees its doors
  // close enough that each is its own pin (the shape runs past the edges).
  const fitTurfView = (map, turf) => {
    if (!canCreate) {
      const ring = turf.polygon.map(([lat, lng]) => [Number(lat), Number(lng)]);
      const inside = doors.filter((d) => pointInPolygon(d.lat, d.lng, ring));
      if (inside.length) { fitTurf(map, inside.map((d) => [d.lat, d.lng]), pageRef.current, { maxZoom: 18, inset: PIN_INSET }); return; }
    }
    fitTurf(map, turf.polygon, pageRef.current);
  };

  // First data: fit the deep-linked turf, else center on the deep-linked
  // door, else (volunteers) fit the doors of their own turf, else fit every door.
  const ownTurf = !canCreate && !personParam && !turfParam;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fittedRef.current) return;
    // Wait to learn the turf shapes (unless offline — then go with the doors).
    if ((turfParam || ownTurf) && turfsQ.isPending && turfsQ.fetchStatus !== 'paused') return;
    if (selectedTurf && validRing(selectedTurf.polygon)) {
      // Volunteers get the turf's doors close up — wait for them (unless offline).
      if (!canCreate && !doorsQ.data && doorsQ.fetchStatus !== 'paused') return;
      fittedRef.current = true;
      focusedTurfRef.current = turfParam;
      fitTurfView(map, selectedTurf);
      return;
    }
    if (!doorsQ.data) return;
    fittedRef.current = true;
    const mine = ownTurf ? turfs.filter((t) => validRing(t.polygon)) : EMPTY_LIST;
    if (selectedDoor) {
      map.setView([selectedDoor.lat, selectedDoor.lng], 17, { animate: false });
      revealLatLng(map, L.latLng(selectedDoor.lat, selectedDoor.lng), pageRef.current);
      centeredOnRef.current = personParam;
    } else if (mine.length) {
      // Their doors, close enough that each is its own pin.
      const rings = mine.map((t) => t.polygon.map(([lat, lng]) => [Number(lat), Number(lng)]));
      const inside = doors.filter((d) => rings.some((r) => pointInPolygon(d.lat, d.lng, r)));
      const pts = inside.length ? inside.map((d) => [d.lat, d.lng]) : rings.flat();
      fitTurf(map, pts, pageRef.current, { maxZoom: 18, inset: inside.length ? PIN_INSET : 0 });
    } else if (doors.length) {
      map.fitBounds(L.latLngBounds(doors.map((d) => [d.lat, d.lng])).pad(0.15), { maxZoom: 16, animate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doorsQ.data, doorsQ.fetchStatus, doors, selectedDoor, personParam, turfParam, turfsQ.isPending, turfsQ.fetchStatus, selectedTurf, ownTurf, turfs]);

  // A new selection that is off-screen or under the drawer → bring it into view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedDoor || centeredOnRef.current === personParam) return;
    centeredOnRef.current = personParam;
    revealLatLng(map, L.latLng(selectedDoor.lat, selectedDoor.lng), pageRef.current);
  }, [personParam, selectedDoor]);

  // A turf selected from outside (a link, a new turf elsewhere) → fit it.
  // Tapped turfs set focusedTurfRef first, so the map holds still for them.
  useEffect(() => {
    if (!turfParam) { focusedTurfRef.current = null; return; }
    const map = mapRef.current;
    if (!map || !fittedRef.current || !selectedTurf || focusedTurfRef.current === turfParam) return;
    focusedTurfRef.current = turfParam;
    if (validRing(selectedTurf.polygon)) fitTurfView(map, selectedTurf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turfParam, selectedTurf]);

  // Naming a new turf: if the sheet covers part of the shape, slide it into
  // view (never zooming in past where they drew it).
  useEffect(() => {
    const map = mapRef.current;
    if (!naming || !map || draft.points.length < 3) return;
    fitTurf(map, draft.points, pageRef.current, { onlyIfHidden: true, maxZoom: map.getZoom() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naming]);

  // Opening a turf's sheet: refresh its counts (doors knocked from the door
  // card or another phone since the list loaded).
  useEffect(() => {
    if (!turfParam) return;
    const state = queryClient.getQueryState(['turfs']);
    if (state?.dataUpdatedAt && Date.now() - state.dataUpdatedAt > 5000) {
      queryClient.invalidateQueries({ queryKey: ['turfs'] });
    }
  }, [turfParam, queryClient]);

  const drawCount = draft.points.length;
  const pageCls = ['map-page', hasSheet && 'has-sheet', mode && 'is-moded', mode === 'draw' && 'is-drawing'].filter(Boolean).join(' ');

  return (
    <div className={pageCls} ref={pageRef}>
      <div className="map-canvas" ref={canvasRef} role="application" aria-label="Canvass map" />

      <div className="map-top">
        {mode === 'draw' ? (
          naming ? null : (
            // A slim strip, only as wide as it needs: the map under it stays
            // tappable, and the map slides down by its height when drawing starts.
            <div className="map-mode map-mode--draw">
              <span role="status" className="map-mode__count">
                {drawCount === 0 ? 'Tap a corner' : <><strong>{drawCount}</strong> {drawCount === 1 ? 'corner' : 'corners'}</>}
              </span>
              <span className="map-mode__btns">
                <button type="button" className="btn" onClick={undoPoint} disabled={!drawCount}>Undo</button>
                <button type="button" className={`btn${drawCount >= 3 ? ' map-mode__go' : ''}`} onClick={finishDraw} disabled={drawCount < 3}>Finish</button>
                <button type="button" className="btn map-mode__x" onClick={cancelMode} aria-label="Cancel drawing" title="Cancel">✕</button>
              </span>
            </div>
          )
        ) : mode === 'place' && placing ? (
          <div className="map-mode" role="status">
            <span>
              Tap where <strong>{placing.name}</strong> lives
              {placing.address ? <span className="map-mode__sub">{placing.unit ? `${placing.unit} – ` : ''}{placing.address}</span> : null}
            </span>
            <button type="button" className="btn" onClick={cancelMode}>Cancel</button>
          </div>
        ) : mode === 'add' ? (
          <div className="map-mode" role="status">
            <span>Tap the new door</span>
            <button type="button" className="btn" onClick={cancelMode}>Cancel</button>
          </div>
        ) : missingPerson ? (
          <div className="map-mode" role="status">
            <span><strong>{missingPerson.name}</strong> isn’t on the map</span>
            <span className="map-mode__btns">
              <button type="button" className="btn" onClick={() => { startPlacing(missingPerson); select(null); }}>Place</button>
              <button type="button" className="btn" onClick={() => select(null)} aria-label="Dismiss">✕</button>
            </span>
          </div>
        ) : missingGone ? (
          <div className="map-mode" role="status">
            <span>Person not found</span>
            <button type="button" className="btn" onClick={() => select(null)} aria-label="Dismiss">✕</button>
          </div>
        ) : turfMissing ? (
          <div className="map-mode" role="status">
            <span>{canCreate ? 'Turf not found' : 'Not your turf — ask your organizer'}</span>
            <button type="button" className="btn" onClick={() => select(null)} aria-label="Dismiss">✕</button>
          </div>
        ) : (
          <div className="map-bar">
            {/* Nothing to filter with no doors loaded (no signal): the card below says so. */}
            {!noSignal && (
              <button
                type="button"
                ref={filterBtnRef}
                className={`map-filter-btn${filter !== 'all' ? ' is-filtered' : ''}`}
                data-band={filter}
                aria-haspopup="dialog"
                aria-expanded={filterOpen}
                aria-label={`Show: ${FILTER_LABEL[filter]}, ${plural(counts[filter] ?? 0, 'door', 'doors')}`}
                onClick={() => { setFilterOpen((o) => !o); setUnlocOpen(false); }}
              >
                <FilterGlyph />
                <span className="map-filter-btn__label"><span className="map-filter-btn__show">Show:</span> {FILTER_LABEL[filter]}</span>
                <span className="map-filter-btn__n mono" aria-live="polite">
                  {doorsQ.isPending ? '…' : counts[filter] ?? 0}
                </span>
              </button>
            )}
            {myWalk && (
              <Link className="map-chip" to={myWalk.to}><WalkGlyph /> {myWalk.label}</Link>
            )}
            {canCreate && (
              <button type="button" className="map-chip" onClick={startDraw} aria-label="Draw a turf">
                <TurfGlyph /> Draw turf
              </button>
            )}
            {canCreate && unlocated > 0 && (
              <div className={`map-unloc${unlocOpen ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="map-unloc__chip"
                  aria-expanded={unlocOpen}
                  aria-label={`${plural(unlocated, 'person', 'people')} not on the map`}
                  onClick={() => { setUnlocOpen((o) => !o); setFilterOpen(false); }}
                >
                  <PinGlyph /> <span className="map-unloc__label">Not on map</span> <span className="map-unloc__n mono">{unlocated}</span>
                </button>
                {unlocOpen && (
                  <span className="map-unloc__btns">
                    <button type="button" className="btn map-unloc__btn" onClick={() => { setPickerOpen(true); setAddAt(null); setUnlocOpen(false); cancelMode(); }}>
                      Drop pins by hand
                    </button>
                    <GeocodeButton compact onDone={onGeocoded} />
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {/* No signal: these are the doors this phone kept, not live ones. */}
        {doorsCopy && !mode && <span className="chip obx-copy map-copy" role="status">Offline copy</span>}
        {showHint && (
          <div className="map-hint" role="status">
            <span className="map-hint__text">Tap a house to start</span>
            <button type="button" className="btn map-hint__x" onClick={hideHint} aria-label="Dismiss" title="Dismiss">✕</button>
          </div>
        )}
      </div>

      {filterOpen && !mode && (
        <FilterSheet
          filters={filters}
          filter={filter}
          onFilter={(key) => { setFilter(key); closeFilter(); }}
          counts={counts}
          showTurfs={showTurfs}
          onTurfs={setTurfsShown}
          turfCount={turfs.length}
          desk={canCreate}
          onDraw={startDraw}
          unlocated={unlocated}
          onPlace={() => { setFilterOpen(false); setPickerOpen(true); setAddAt(null); cancelMode(); }}
          onClose={closeFilter}
          tilesNote={canCreate ? tilesLine(tilesQ.data?.setup) : null}
          sharing={sharing}
          onShare={setSharing}
        />
      )}

      <div className="map-fabs">
        <button type="button" className="map-fab" title="Locate me" aria-label="Locate me" onClick={locateMe} disabled={locating}>
          <LocateGlyph />
        </button>
        {canCreate && mode !== 'draw' && (
          <button
            type="button"
            className={`map-fab map-fab--add${mode === 'add' ? ' is-on' : ''}`}
            title="Add a door (or long-press the map)"
            aria-label="Add a door"
            aria-pressed={mode === 'add'}
            onClick={toggleAdd}
          >
            <span className="map-fab__plus" aria-hidden="true">+</span> Door
          </button>
        )}
      </div>

      {noSignal ? (
        <div className="card map-empty map-offline" role="status">
          <p>{offlineWalk ? 'No signal — your walk list still works' : 'No signal — doors load when you’re back'}</p>
          {offlineWalk && (
            <Link className="btn btn-primary map-empty__btn" to={`/turfs/${offlineWalk.id}`}>Open walk list</Link>
          )}
        </div>
      ) : doorsQ.isError ? (
        <p className="error map-error">{doorsQ.error?.status ? doorsQ.error.message : 'No signal — showing the doors already loaded'}</p>
      ) : turfsQ.isError && !turfsQ.data ? (
        <p className="error map-error">Turfs didn’t load</p>
      ) : null}
      {showEmpty && (
        <div className="card map-empty">
          {unlocated > 0 ? (
            <>
              <p>{plural(unlocated, 'person needs', 'people need')} a pin</p>
              <button type="button" className="btn btn-primary map-empty__btn" onClick={() => { setPickerOpen(true); setAddAt(null); cancelMode(); }}>Place</button>
            </>
          ) : canCreate ? (
            <>
              <p>No doors yet</p>
              <button type="button" className="btn btn-primary map-empty__btn" onClick={toggleAdd}>+ Add door</button>
            </>
          ) : (
            <p>No doors yet — ask your organizer</p>
          )}
        </div>
      )}

      {pickerOpen && <PlacePicker unlocated={unlocated} onPick={startPlacing} onClose={() => setPickerOpen(false)} />}

      {addAt && !pickerOpen && (
        <div className="map-sheet">
          <AddDoorForm
            latlng={addAt}
            toast={toast}
            onCancel={() => setAddAt(null)}
            onDone={(id) => { setAddAt(null); centeredOnRef.current = id; select(id); }}
          />
        </div>
      )}

      {selectedDoor && !pickerOpen && !addAt && !mode && (
        <div className="map-sheet">
          <DoorCard
            key={selectedDoor.key}
            door={selectedDoor}
            selectedId={personParam}
            onSelect={select}
            onClose={() => select(null)}
            toast={toast}
            me={me}
            canCreate={canCreate}
            canAddHere={canCreate || Boolean(mineKeys?.has(selectedDoor.key))}
          />
        </div>
      )}

      {naming && (
        <div className="map-sheet">
          <NameTurfForm
            points={draft.points}
            doors={doors}
            takenNames={turfs.map((t) => t.name)}
            busy={turfBusy}
            error={turfError}
            onSave={saveTurf}
            onBack={backToDrawing}
            onCancel={cancelMode}
          />
        </div>
      )}

      {turfSheetOpen && (
        <TurfSheet
          key={selectedTurf.id}
          turf={selectedTurf}
          me={me}
          desk={canCreate}
          toast={toast}
          onClose={() => select(null)}
          onDeleted={(t) => { select(null); toast(`Deleted ${t.name}`); }}
        />
      )}

      {signSheetOpen && <SignSheet sign={signSel} desk={canCreate} onClose={() => setSignSel(null)} />}

      {toastMsg && (
        <div className="toast map-toast" role="status">
          <span>{toastMsg.text}</span>
          {toastMsg.act && (
            <button
              type="button"
              className="btn map-toast__btn"
              onClick={() => { const { onClick } = toastMsg.act; setToastMsg(null); clearTimeout(toastTimer.current); onClick(); }}
            >
              {toastMsg.act.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
