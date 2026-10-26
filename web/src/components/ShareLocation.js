// "Share my location while I'm out" — the switch on the map (Map.jsx's
// filter sheet). While it is on, the app (Shell.jsx, whichever screen is
// open) watches the phone's position and tells the server where this person
// is — field.ping, about once a minute or every 25 m — so the managers'
// dashboard shows them on the map, live. Off sends one last ping that takes
// them off it. Opt-in, per phone (localStorage), never on by itself; a ping
// goes straight to the server, never through the outbox (a stale position
// sent later would be wrong, not late).
import { useCallback, useEffect, useState } from 'react';
import { action } from '../api.js';

const PREF = 'starbase:map:share';
const EVENT = 'starbase:share';
const MIN_MS = 60_000;
const MIN_M = 25;

export const readSharePref = () => { try { return localStorage.getItem(PREF) === '1'; } catch { return false; } };
export const writeSharePref = (on) => {
  try { localStorage.setItem(PREF, on ? '1' : '0'); } catch { /* storage blocked */ }
  window.dispatchEvent(new Event(EVENT));
};

// The switch's state, the same on every screen that shows it.
export function useSharePref() {
  const [on, setOn] = useState(readSharePref);
  useEffect(() => {
    const sync = () => setOn(readSharePref());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', sync); };
  }, []);
  const set = useCallback((v) => { writeSharePref(!!v); setOn(!!v); }, []);
  return [on, set];
}

const metres = (a, b) => {
  const dLat = (b.lat - a.lat) * 111_320;
  const dLng = (b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

// Runs in the shell for whoever is signed in. Returns nothing: the switch
// (useSharePref) is the only control.
export function useShareLocation(me) {
  const [on] = useSharePref();
  const signedIn = !!me?.user?.id;
  useEffect(() => {
    if (!on || !signedIn) return undefined;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return undefined;
    let last = null;      // { lat, lng, at } last sent
    let stopped = false;
    const send = (pos) => {
      if (stopped) return;
      const here = { lat: pos.coords.latitude, lng: pos.coords.longitude, at: Date.now() };
      if (last && here.at - last.at < MIN_MS && metres(last, here) < MIN_M) return;
      last = here;
      action('field.ping', { lat: here.lat, lng: here.lng, accuracy: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null })
        .catch(() => { /* no signal, or signed out: the next fix tries again */ });
    };
    const watch = navigator.geolocation.watchPosition(send, (err) => {
      // Blocked outright: the switch goes off rather than pretending.
      if (err?.code === 1) writeSharePref(false);
    }, { enableHighAccuracy: true, maximumAge: 15_000, timeout: 30_000 });
    // A fix a minute even when standing still, so "out now" stays true.
    const tick = setInterval(() => {
      navigator.geolocation.getCurrentPosition(send, () => {}, { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 });
    }, MIN_MS);
    return () => {
      stopped = true;
      navigator.geolocation.clearWatch(watch);
      clearInterval(tick);
    };
  }, [on, signedIn]);

  // Turned off (or signed out while on): one ping that takes them off the map.
  const wasOn = useWasOn(on && signedIn);
  useEffect(() => {
    if (wasOn && !(on && signedIn)) action('field.ping', { off: true }).catch(() => {});
  }, [on, signedIn, wasOn]);
}

function useWasOn(v) {
  const [prev, setPrev] = useState(v);
  useEffect(() => { setPrev(v); }, [v]);
  return prev;
}
