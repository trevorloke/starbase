// Thin fetch layer over the v2 API. Cookie session auth; money is always
// integer cents on the wire and dollars on screen.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function handle(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || `request failed (${res.status})`);
  return body;
}

// fetch() itself failed — no answer at all. Never the browser's "Failed to
// fetch": with the phone offline nothing left it ("No signal — not sent");
// with signal the answer may have been lost on the way back, so it claims
// neither. Not an ApiError, so screens (and the outbox) still read it as
// "no network".
export class NoSignalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoSignalError';
  }
}
// No answer, not a refusal: fetch itself failed, or the server is down
// behind its proxy (502/503 while it restarts or deploys). The outbox keeps
// a tap for later on the same test; screens show their kept copy.
export const noAnswer = (err) => !(err instanceof ApiError) || err.status >= 500 || err.status === 0;

const offlineNow = () => typeof navigator !== 'undefined' && navigator.onLine === false;
export const noSignalWords = (write) => (offlineNow()
  ? (write ? 'No signal — not sent' : 'No signal — this loads when you’re back online')
  : 'No answer — check your signal');
const unreached = (write) => () => { throw new NoSignalError(noSignalWords(write)); };

export const apiGet = (path) =>
  fetch(`/api${path}`, { credentials: 'same-origin' }).catch(unreached(false)).then(handle);

export const apiPost = (path, body) =>
  fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).catch(unreached(true)).then(handle);

// The sign-in this browser remembers (main.jsx keeps it: name, email,
// campaign, role — no voter data), or null. The app opens on it when the
// server can't be reached, so what's kept and saved here stays reachable.
export const ME_KEY = 'starbase:me:v1';
export const savedSignIn = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(ME_KEY) || 'null');
    return saved?.user?.id && saved?.workspace?.id ? saved : null;
  } catch { return null; }
};

// The only write path: POST /api/actions/:name
export const action = (name, input) => apiPost(`/actions/${name}`, input);

// ── Display helpers ──
export const fmtMoney = (cents) =>
  '$' + (Number(cents || 0) / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const fmtDate = (d) => String(d ?? '').slice(0, 10);

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Whole days between today and a YYYY-MM-DD due date (negative = overdue).
export const daysUntil = (due) => {
  const [y, m, day] = fmtDate(due).split('-').map(Number);
  const now = new Date();
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const b = Date.UTC(y, m - 1, day);
  return Math.round((b - a) / 86400000);
};

export const dollarsToCents = (str) => {
  const n = Number.parseFloat(String(str).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
};

export const initials = (name) =>
  String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';
