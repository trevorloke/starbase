import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// app.css first: page stylesheets (imported by App's pages) must load after
// the shared primitives so single-class page rules can override them.
import './app.css';
import App from './App.jsx';
import { ADMIN_BASE, appMode } from './mode.js';
import { ME_KEY, NoSignalError, noAnswer, savedSignIn } from './api.js';
import { keptPersister, watchKeptCopies } from './components/KeptCopies.js';
import { forgetPhoneCopies, keepOnlyMine } from './components/OfflineCache.js';
import { closeOutbox } from './offline.js';

// Once more after a second — except a 401 / 404, or no signal at all (the
// browser says it's offline): then the screen says so straight away, and
// loads again by itself when the signal is back (below, and KeptCopies.js).
const noSignalNow = (error) => error instanceof NoSignalError && typeof navigator !== 'undefined' && navigator.onLine === false;
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => (error?.status === 401 || error?.status === 404 || noSignalNow(error) ? false : failureCount < 1),
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      // Desk screens keep their last copy and show it with no signal
      // (components/KeptCopies.js). A persister would switch react-query to
      // "offlineFirst"; the field screens are built on "online" (a query
      // with no signal waits, paused), so it's said here.
      persister: keptPersister,
      networkMode: 'online',
    },
  },
});
watchKeptCopies(queryClient);

// ── Opening the app with no signal ──
// The auth gate needs ['me']; with no network that fetch fails and would bounce
// a volunteer to the login screen (which also needs the network), stranding
// any knocks saved on the phone. So remember the signed-in user (name, email,
// workspace, role — no voter data) and, only when the phone is offline at
// startup, seed it so the app opens. Back online, it refetches as usual and a
// dead session still lands on login. Sign-out (queryClient.clear) or a 401
// forgets it — and with it every copy kept for them (the server says the
// sign-in is over, so nothing of theirs stays on this computer). The same
// when the check gets no answer with signal (wifi with no internet, the
// server restarting): the app opens on the remembered sign-in, and asks
// again every 15 s (App.jsx) — no answer is never a sign-out.
const isMeKey = (key) => key.length === 1 && key[0] === 'me';
// Leaving because another tab signed out: this tab's own clear() must not
// forget what that tab saved (it may be the next person's sign-in).
let leaving = false;
const forgetMe = () => { if (leaving) return; try { localStorage.removeItem(ME_KEY); } catch { /* storage blocked */ } };

if (typeof navigator !== 'undefined' && navigator.onLine === false) {
  const saved = savedSignIn();
  if (saved) queryClient.setQueryData(['me'], saved);
  // react-query assumes it starts online and only refetches on an
  // offline→online *change*. Opened with no signal there is no such change,
  // so screens whose fetch failed would stay failed once signal returns.
  // On the first 'online', refetch them, and re-check the sign-in (a dead
  // session then lands on login).
  window.addEventListener('online', () => {
    queryClient.refetchQueries({
      type: 'active',
      predicate: (q) => isMeKey(q.queryKey) || q.state.status === 'error' || q.isStale(),
    });
  }, { once: true });
}

queryClient.getQueryCache().subscribe((event) => {
  if (!isMeKey(event.query.queryKey)) return;
  if (event.type === 'removed') { forgetMe(); return; }
  if (event.type !== 'updated') return;
  const { status, data, error } = event.query.state;
  if (status === 'success' && data?.user?.id) {
    try { localStorage.setItem(ME_KEY, JSON.stringify(data)); } catch { /* storage full or blocked */ }
  } else if (status === 'error' && (error?.status === 401 || error?.status === 403)) {
    forgetMe();
    forgetPhoneCopies();
  } else if (status === 'error' && data === undefined && noAnswer(error)) {
    // Opened with signal but no answer: as who signed in here last. Its time
    // is 0 — not an answer — so RequireAuth keeps asking.
    const saved = savedSignIn();
    if (saved) event.query.setData(saved, { updatedAt: 0 });
  }
});

// Signed out in another tab (or signed in there as someone else): this tab
// drops what it holds — its memory and the copies kept for this tab only —
// and opens again as whoever is signed in now (or on Sign in).
if (typeof window !== 'undefined') {
  let soon = null;
  window.addEventListener('storage', (e) => {
    if (e.key !== ME_KEY && e.key !== null) return;
    clearTimeout(soon);
    // A sign-in elsewhere forgets the old one and saves the new one: read what's there once both are done.
    soon = setTimeout(() => {
      const cur = queryClient.getQueryData(['me']);
      if (!cur?.user?.id || leaving) return;
      const next = savedSignIn();
      if (next && next.user.id === cur.user.id && next.workspace.id === cur.workspace?.id) return;
      leaving = true;
      closeOutbox(); // nothing more is saved here under the sign-in that ended
      queryClient.clear();
      if (next) keepOnlyMine(next); else forgetPhoneCopies();
      window.location.assign(appMode() === 'admin' ? (next ? `${ADMIN_BASE}/` : `${ADMIN_BASE}/login`) : (next ? '/' : '/login'));
    }, 60);
  });
}

// /admin/… is the admin (the desk), everything else the field app (mode.js).
const mode = appMode();
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter basename={mode === 'admin' ? ADMIN_BASE : undefined}>
      <App mode={mode} />
    </BrowserRouter>
  </QueryClientProvider>,
);

// Service worker: app shell + map tiles for the field (public/sw.js). Only in
// production builds — in dev it would cache Vite's modules and fight HMR.
if (import.meta.env.PROD && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* app still works online */ });
  });
}
