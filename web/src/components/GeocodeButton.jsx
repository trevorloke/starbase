// GeocodeButton — place everyone with an address on the map, a batch at a time.
// Contract: <GeocodeButton onDone={(summary) => …} compact? />
//   Loops POST /api/data/geocode {limit: 25} until nothing is left (or a batch
//   does nothing, or the lookup fails twice running), with live progress and a
//   Stop button. Desk roles only: renders nothing for volunteers.
//   summary = { located, missed, errored, remaining, unmatched, stopped, error }
// compact: one pill-sized button ("Look up addresses") + a short status line,
// beside "Drop pins by hand" in the map's "Not on map" pill. Full: one
// primary button, a progress bar, and a one-line summary; once pins are
// placed, "See the map" takes its place.
import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost } from '../api.js';
import '../pages/import.css';

const DESK = ['manager', 'treasurer', 'staff'];
const BATCH = 25;
const LIVE_REFRESH_MS = 5000; // let the map's pins appear while it runs
const RETRY_WAIT_MS = 3000;
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

function liveText({ located, missed, remaining }, compact) {
  const parts = [`Placed ${fmtN(located)}`];
  if (missed) parts.push(compact ? `${fmtN(missed)} no match` : `${fmtN(missed)} couldn’t be matched`);
  if (remaining != null) parts.push(`${fmtN(remaining)} left`);
  return parts.join(' · ');
}

function Geocoder({ onDone, compact = false }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState('idle'); // idle | running | done
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState(null); // { located, missed, errored, remaining, unmatched }
  const [summary, setSummary] = useState(null);
  const stopRef = useRef(false);

  // Leaving the screen stops the loop (the next batch picks up where it left off).
  useEffect(() => () => { stopRef.current = true; }, []);

  const refresh = (keys) => { for (const queryKey of keys) queryClient.invalidateQueries({ queryKey }); };

  const run = async () => {
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

  const stop = () => { stopRef.current = true; setStopping(true); };

  const running = phase === 'running';
  const s = summary;
  // Another run only helps if lookups are still waiting (stopped, failed, or
  // never run) — and never while the server has lookup turned off.
  const off = Boolean(s?.error?.startsWith('Address lookup is turned off'));
  const canRun = !running && !off && (!s || s.remaining > 0 || s.error);
  const runLabel = compact ? 'Look up addresses' : s?.error ? 'Try again' : s?.stopped ? 'Carry on' : 'Place on map';

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
