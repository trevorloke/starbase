// GeocodeButton — place everyone with an address on the map.
// Contract: <GeocodeButton onDone={(summary) => …} compact? />
//   Starts a background run on the server (POST /api/geocode/start —
//   ext/geocoding) and shows its progress (GET /api/geocode/status every few
//   seconds), with Stop. The run carries on with the page closed, and coming
//   back picks its progress up again. Where the server runs no background
//   jobs (STARBASE_JOBS=off), the page looks up batches itself instead:
//   POST /api/data/geocode {limit: 25} until nothing is left (or the lookup
//   fails twice running). Desk roles only: renders nothing for volunteers.
//   summary = { located, missed, errored, remaining, unmatched, stopped, error }
// compact: one pill-sized button ("Look up addresses") + a short status line,
// beside "Drop pins by hand" in the map's "Not on map" pill. Full: one
// primary button, a progress bar, and a one-line summary; once pins are
// placed, "See the map" takes its place.
import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api.js';
import '../pages/import.css';

const DESK = ['manager', 'treasurer', 'staff'];
const BATCH = 25;
const LIVE_REFRESH_MS = 5000; // let the map's pins appear while it runs
const RETRY_WAIT_MS = 3000;
const POLL_MS = 2000;
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const fmtN = (n) => Number(n || 0).toLocaleString('en-CA');
const people = (n) => `${fmtN(n)} ${n === 1 ? 'person' : 'people'}`;

// Everything a new pin changes: pins + unlocated count, Today, lists and
// profiles (has: map pin), and walk lists (located people fall into turfs).
const KEYS = [['doors'], ['brief'], ['persons'], ['person'], ['turfs'], ['turf']];

export default function GeocodeButton(props) {
  const { me } = useOutletContext() ?? {};
  if (!DESK.includes(me?.role)) return null;
  return <Geocoder {...props} />;
}

// "about 3 h 20 min" from people left and people placed per second.
const etaText = (left, perSec) => {
  if (!left || !perSec) return null;
  const mins = Math.max(1, Math.round(left / perSec / 60));
  if (mins < 60) return `about ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round((mins % 60) / 10) * 10;
  return `about ${h} h${m ? ` ${m} min` : ''}`;
};

function liveText({ located, missed, remaining, eta }, compact) {
  const parts = [`Placed ${fmtN(located)}`];
  if (missed) parts.push(compact ? `${fmtN(missed)} no match` : `${fmtN(missed)} couldn’t be matched`);
  if (remaining != null) parts.push(`${fmtN(remaining)} left`);
  if (eta && !compact) parts.push(eta);
  return parts.join(' · ');
}

// The server's run → the summary this button shows when it isn't running.
const summaryOf = (st, startedWith) => ({
  located: st.located + st.copied,
  missed: st.missed,
  errored: st.errors,
  remaining: st.remaining,
  unmatched: st.unmatched,
  stopped: st.state === 'stopped',
  nothingToDo: startedWith === 0,
  error: st.state === 'paused'
    ? `Address lookup isn’t answering${st.lastError ? ` (${st.lastError})` : ''}. Nothing is lost — carry on later.`
    : null,
});

function Geocoder({ onDone, compact = false }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState('idle'); // idle | running | done
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState(null); // { located, missed, errored, remaining, unmatched }
  const [summary, setSummary] = useState(null);
  const stopRef = useRef(false);
  // Background run on the server: polled while it runs.
  const [bg, setBg] = useState(false);
  const startedWith = useRef(null);
  const samples = useRef([]); // [{ t, placed }] for the time-left estimate

  // Leaving the screen stops an in-page loop (the next batch picks up where it
  // left off); a background run carries on without the page.
  useEffect(() => () => { stopRef.current = true; }, []);

  // A run already going (started earlier, or by someone else): show it.
  useEffect(() => {
    let live = true;
    apiGet('/geocode/status').then((st) => {
      if (!live || st.state !== 'running') return;
      startedWith.current = st.remaining;
      setPhase('running');
      setBg(true);
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!bg) return undefined;
    let live = true;
    let lastRefresh = Date.now();
    const tick = async () => {
      let st;
      try { st = await apiGet('/geocode/status'); } catch { return; } // no signal: try again next tick
      if (!live) return;
      const placed = st.located + st.copied + st.missed;
      const now = Date.now();
      samples.current = [...samples.current.filter((x) => now - x.t < 60_000), { t: now, placed }];
      const first = samples.current[0];
      const perSec = now - first.t > 5000 ? (placed - first.placed) / ((now - first.t) / 1000) : 0;
      setProgress({ located: st.located + st.copied, missed: st.missed, errored: st.errors, remaining: st.remaining,
        unmatched: st.unmatched, eta: etaText(st.remaining, perSec) });
      if (now - lastRefresh > LIVE_REFRESH_MS) { lastRefresh = now; refresh([['doors']]); }
      if (st.state !== 'running') {
        const result = summaryOf(st, startedWith.current);
        setBg(false);
        setSummary(result);
        setPhase('done');
        setStopping(false);
        refresh(KEYS);
        onDone?.(result);
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => { live = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bg]);

  const refresh = (keys) => { for (const queryKey of keys) queryClient.invalidateQueries({ queryKey }); };

  // Start (or carry on) the background run; the page loop where there is none.
  const run = async () => {
    setSummary(null);
    setStopping(false);
    let st;
    try {
      st = await apiPost('/geocode/start', {});
    } catch (e) {
      if (e.status === 409 && /turned off/i.test(e.message)) {
        const result = { located: 0, missed: 0, errored: 0, remaining: 0, unmatched: 0, error: 'Address lookup is turned off. Drop pins by hand on the map.' };
        setSummary(result); setPhase('done'); onDone?.(result);
        return;
      }
      if (e.status === 409) { runHere(); return; } // no background jobs on this server
      const result = { located: 0, missed: 0, errored: 0, remaining: 0, unmatched: 0,
        error: e.status === 403 ? 'Only campaign staff can place people on the map.' : e.status ? `Starbase said: ${e.message}.` : 'Couldn’t reach Starbase — check your connection and try again.' };
      setSummary(result); setPhase('done'); onDone?.(result);
      return;
    }
    startedWith.current = st.remaining;
    samples.current = [];
    setProgress({ located: st.located + st.copied, missed: st.missed, errored: st.errors, remaining: st.remaining, unmatched: st.unmatched });
    setPhase('running');
    setBg(true);
  };

  const runHere = async () => {
    stopRef.current = false;
    setStopping(false);
    setSummary(null);
    setPhase('running');
    const tot = { located: 0, missed: 0, errored: 0, remaining: null, unmatched: 0 };
    setProgress({ ...tot });
    let stalls = 0;
    let lastError = null;
    let requestError = null;
    let first = true;
    let nothingToDo = false;
    let lastRefresh = Date.now();

    while (!stopRef.current) {
      let r;
      try {
        r = await apiPost('/data/geocode', { limit: BATCH });
      } catch (e) {
        requestError = e.status === 403
          ? 'Only campaign staff can place people on the map.'
          : e.status === 401 ? 'You’ve been signed out. Sign in again, then try again.'
            : e.status ? `Starbase said: ${e.message}.` : 'Couldn’t reach Starbase — check your connection and try again.';
        break;
      }
      tot.located += r.located || 0;
      tot.missed += r.missed || 0;
      tot.errored += r.errored || 0;
      tot.remaining = r.remaining ?? 0;
      tot.unmatched = r.unmatched ?? 0;
      if (r.lastError) lastError = r.lastError;
      setProgress({ ...tot });

      if (first && r.processed === 0) nothingToDo = true;
      first = false;
      if (tot.remaining === 0 || r.processed === 0) break;

      // A batch where every lookup failed made no progress; twice running, stop.
      const progressed = (r.located || 0) + (r.missed || 0) > 0;
      if (r.errored > 0 && !progressed) {
        stalls += 1;
        if (stalls >= 2 || /turned off/i.test(r.lastError || '')) break;
        // Give a busy (rate-limited) lookup service a moment before the retry; Stop still works.
        for (let t = 0; t < RETRY_WAIT_MS / 250 && !stopRef.current; t += 1) await wait(250);
      } else {
        stalls = 0;
      }
      if (Date.now() - lastRefresh > LIVE_REFRESH_MS) {
        lastRefresh = Date.now();
        refresh([['doors']]);
      }
    }

    const stalled = stalls >= 2 || (stalls > 0 && /turned off/i.test(lastError || ''));
    const stopped = stopRef.current && !stalled && !requestError && tot.remaining !== 0;
    let error = requestError;
    if (!error && stalled) {
      error = /turned off/i.test(lastError || '')
        ? 'Address lookup is turned off. Drop pins by hand on the map.'
        : `Address lookup isn’t answering${lastError ? ` (${lastError})` : ''}. Nothing is lost — try again later.`;
    }
    const result = {
      located: tot.located,
      missed: tot.missed,
      errored: tot.errored,
      remaining: tot.remaining ?? 0,
      unmatched: tot.unmatched,
      stopped,
      nothingToDo,
      error,
    };
    setSummary(result);
    setPhase('done');
    setStopping(false);
    refresh(KEYS);
    onDone?.(result);
  };

  const stop = () => {
    setStopping(true);
    if (bg) { apiPost('/geocode/stop', {}).catch(() => setStopping(false)); return; } // the poll sees it stop
    stopRef.current = true;
  };

  const running = phase === 'running';
  const s = summary;
  // Another run only helps if lookups are still waiting (stopped, failed, or
  // never run) — and never while the server has lookup turned off.
  const off = Boolean(s?.error?.startsWith('Address lookup is turned off'));
  const canRun = !running && !off && (!s || s.remaining > 0 || s.error);
  const runLabel = compact ? 'Look up addresses' : (s?.stopped || (s?.error && s.remaining > 0)) ? 'Carry on' : s?.error ? 'Try again' : 'Place on map';

  // ── Compact: fits inside the map's "Not on map" pill ──
  if (compact) {
    let text = null;
    if (running) text = progress?.remaining == null ? 'Looking up addresses…' : liveText(progress, true);
    else if (s?.error) text = off ? 'Address lookup is off — drop pins by hand' : 'Lookup isn’t answering — try later';
    else if (s?.stopped) text = `Stopped · ${fmtN(s.remaining)} left`;
    else if (s?.nothingToDo) text = s.unmatched ? `${fmtN(s.unmatched)} need a pin by hand` : 'All placed';
    else if (s) text = `Placed ${fmtN(s.located)}${s.unmatched ? ` · ${fmtN(s.unmatched)} need a pin by hand` : ''}`;
    return (
      <span className="geo geo--compact">
        <span className="geo-live" role="status" aria-live="polite" title={s?.error || undefined}>{text}</span>
        {running ? (
          <button type="button" className="btn geo-btn geo-btn--compact" onClick={stop} disabled={stopping}>
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : canRun ? (
          <button
            type="button"
            className="btn geo-btn geo-btn--compact"
            onClick={run}
            title="Look up each address and drop a pin"
          >
            {runLabel}
          </button>
        ) : null}
      </span>
    );
  }

  // ── Full ──
  const total = progress && progress.remaining != null ? progress.located + progress.missed + progress.remaining : 0;
  let text = '';
  if (running) text = progress?.remaining == null ? 'Looking up addresses…' : liveText(progress, false);
  return (
    <div className="geo geo--full">
      {running && (
        <div className="geo-run">
          <div
            className="imp-bar"
            role="progressbar"
            aria-label="Placing people on the map"
            aria-valuemin={0}
            aria-valuemax={total || 1}
            aria-valuenow={progress ? progress.located + progress.missed : 0}
          >
            <div
              className={`imp-bar__fill${total ? '' : ' is-waiting'}`}
              style={{ width: total ? `${Math.round(((progress.located + progress.missed) / total) * 100)}%` : '100%' }}
            />
          </div>
        </div>
      )}
      <p className="geo-live geo-live--full" role="status" aria-live="polite">{text}</p>
      {running && bg && <p className="geo-summary__note">This runs on the server — you can close this page and it keeps going.</p>}

      {s && !running && (
        <div className={`geo-summary${s.error ? ' is-error' : s.stopped ? ' is-paused' : ''}`}>
          {s.error ? (
            <p className="geo-summary__lead">{s.located ? `Placed ${people(s.located)} on the map, then stopped. ` : ''}{s.error}</p>
          ) : s.stopped ? (
            <p className="geo-summary__lead">Stopped · placed {fmtN(s.located)} · {fmtN(s.remaining)} left</p>
          ) : s.nothingToDo ? (
            <p className="geo-summary__lead">Everyone is already placed.</p>
          ) : (
            <p className="geo-summary__lead">Placed {people(s.located)} on the map.</p>
          )}
          {s.unmatched > 0 && !off && (
            <p className="geo-summary__note">
              {people(s.unmatched)} not found — on the map, tap <strong>Not on map</strong> to drop their pins by hand.
            </p>
          )}
        </div>
      )}

      <div className="geo-actions">
        {running ? (
          <button type="button" className="btn imp-tap" onClick={stop} disabled={stopping}>
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : canRun ? (
          <button type="button" className="btn btn-primary imp-tap" onClick={run}>{runLabel}</button>
        ) : s && (s.located > 0 || s.unmatched > 0 || off) ? (
          <Link className="btn imp-tap" to="/map">See the map</Link>
        ) : null}
      </div>
    </div>
  );
}
