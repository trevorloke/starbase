// No signal, said the same way on every screen.
//   noSignal(q)    a query with nothing to show because there's no signal:
//                  paused (react-query knew it was offline) or the fetch
//                  itself failed (not an ApiError) — and nothing cached. It
//                  refetches by itself once the phone is back online.
//   <NoSignal />   its one line, in place of a "Loading…" that never ends:
//                  "No signal — this loads when you’re back online."
//   useOnline()    the browser's online / offline, as it changes — for a
//                  send that needs signal (it's off, with <NeedsSignal />).
//   <NeedsSignal /> "Needs signal — nothing sent" (or its own words)
//   <NeedsSignalLine>  a write that's off with no signal, said in one line
//                  under the screen's title ("Adding people needs signal").
// A desk screen this sign-in loaded before shows that copy instead of the
// No signal line (components/KeptCopies.js; the strip says when it's from).
import { useSyncExternalStore } from 'react';
import { ApiError } from '../api.js';
import './desk-offline.css';

export const noSignal = (q) => !q.data && (
  (q.isPending && q.fetchStatus === 'paused') || (q.isError && !(q.error instanceof ApiError))
);

export const NO_SIGNAL_LINE = 'No signal — this loads when you’re back online.';
export function NoSignal({ children = NO_SIGNAL_LINE }) {
  return <p className="no-signal" role="status">{children}</p>;
}

const onlineNow = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const subscribeOnline = (fn) => {
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => { window.removeEventListener('online', fn); window.removeEventListener('offline', fn); };
};
export function useOnline() {
  return useSyncExternalStore(subscribeOnline, onlineNow, () => true);
}

export const NEEDS_SIGNAL = 'Needs signal — nothing sent';
export function NeedsSignal({ className = 'ops-meta', children = NEEDS_SIGNAL }) {
  return <span className={className} role="status">{children}</span>;
}
export function NeedsSignalLine({ children }) {
  return <p className="ds-needs" role="status">{children}</p>;
}
