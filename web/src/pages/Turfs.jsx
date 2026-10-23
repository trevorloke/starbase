// Turfs + walk lists — the canvassing core.
//   /turfs      every turf (volunteers: only the ones assigned to them): a
//               row each, name + doors left; tap one for its walk list.
//   /turfs/:id  THE WALK LIST: turf name, "3 doors left" + a bar, one yellow
//               "Next door". Doors in the server's walk order (street by
//               street, odd side up, even side back — never re-sorted here),
//               one row each; tap a door for the same rating buttons as the
//               map, the outcomes, and "More" (note, call, profile, "Wants a
//               sign?" with Undo on the toast, "+ Person at this door" — a
//               new housemate, name and phone, at the door's address). Like
//               Calls, a tap that settles the door (everyone there rated or
//               answered — always so for one person) closes it and opens the
//               next one; "Change" on the toast reopens it. A note left in
//               the box is sent on its own when the door closes, "Next door"
//               is tapped or the screen is left ("Note saved").
//               Every knock goes through the offline outbox, so a dead zone
//               mid-block loses nothing; the list shows what this phone
//               logged right away. While a door is open and not knocked, the
//               button reads "Skip → <the door after>" (quiet), never the
//               door you're at. Both lists are kept on the phone for a day,
//               so a reload with no signal still opens them ("Offline copy");
//               cachedWalkLists(me) lists those copies for the map and Today.
//               Someone added on this phone (not sent yet) whose pin is in
//               the turf joins the list at once, marked "Not sent yet"; so
//               does a sign request still on the phone.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, ApiError } from '../api.js';
import { logContact, pendingKnocks, pendingPeopleIn, queueAction, undoQueued, useOutbox } from '../offline.js';
import { queuedChip, queuedSaid, queuedText, thisDevice } from '../components/queued.js';
import { useOnline } from '../components/NoSignal.jsx';
import { AddPersonInline, SIGN_LABEL, SignAsk, signCancelOffered } from '../components/DoorCard.jsx';
import RatingButtons, {
  More, OutcomeButtons, OUTCOMES, OUTCOME_LABEL, PersonTabs, RatingChip, focusRating, ratingText, reveal, useScale,
} from '../components/RatingButtons.jsx';
import SurveyQuestions, { answersSaid, answersTail, answersWord, useSurvey } from '../components/SurveyQuestions.jsx';
import './turfs.css';

const DESK_ROLES = ['manager', 'treasurer', 'staff'];
const TURF_COLORS = ['#2b6cb0', '#7b3fa0', '#b5651d', '#1f7a6d', '#a0306a', '#4c5a8a'];
// The door's outcome row: "No answer" (logged for everyone at the door —
// same name as everywhere else) first, then the selected person's refused /
// moved / no access. One person's own "No answer" sits under More when
// several people share the door.
const NOBODY = 'nobody_home';
const DOOR_OUTCOMES = [{ code: NOBODY, label: OUTCOME_LABEL.no_answer }, ...OUTCOMES.filter((o) => o.code !== 'no_answer')];
// Everything a knock changes: this walk list, turf progress, map pins,
// profiles and lists (ratings), the contact feed, Today.
const KNOCK_KEYS = ['turfs', 'doors', 'person', 'persons', 'contacts', 'brief'];

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const norm = (s) => String(s || '').trim().toLowerCase();
const hashIndex = (s, n) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % n; };
const isColor = (c) => typeof c === 'string' && c.length <= 20 && typeof CSS !== 'undefined' && CSS.supports?.('color', c);
// Same fallback as the map, so a turf is the same color on both screens.
const turfColor = (t) => (isColor(t?.color) ? t.color : TURF_COLORS[hashIndex(t?.id || t?.name || '', TURF_COLORS.length)]);
const doorLabel = (d) => (d.address ? (d.unit ? `${d.unit} – ${d.address}` : d.address) : 'Door with no address');
const isDnc = (p) => Array.isArray(p.tags) && p.tags.includes('do-not-contact');
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const dialable = (phone) => String(phone || '').replace(/\s*(?:ext\.?|x|#).*$/i, '').replace(/[^\d+]/g, '');
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ── Offline copy ──
// The walk list and the turf list are kept on this phone, so a reload or a
// restart with no signal still opens them. Keyed by workspace + user (a
// different sign-in on a shared phone never reads them), kept one day, and
// wiped when the app signs out (the ['me'] query is removed by
// queryClient.clear()). forgetFieldCache() is exported for the shell too.
const CACHE_PREFIX = 'starbase:field:v1:';
const CACHE_TTL = 24 * 3600 * 1000;
const cacheKey = (me, name) => (me?.user?.id && me?.workspace?.id ? `${CACHE_PREFIX}${me.workspace.id}:${me.user.id}:${name}` : null);
function readCache(key) {
  if (!key) return undefined;
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    if (!v || !v.data || !(Date.now() - v.at < CACHE_TTL)) {
      if (v) localStorage.removeItem(key);
      return undefined;
    }
    return v;
  } catch { return undefined; }
}
function writeCache(key, data, at) {
  try { localStorage.setItem(key, JSON.stringify({ at, data })); } catch { /* storage full or blocked */ }
}
function dropCache(key) {
  try { if (key) localStorage.removeItem(key); } catch { /* storage blocked */ }
}
// The walk lists kept on this phone for the signed-in user, newest first:
// [{ id, name, at }]. The map (and Today) offer them when there's no signal.
export function cachedWalkLists(me) {
  const base = cacheKey(me, 'walk:');
  if (!base) return [];
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(base) && k.length > base.length) keys.push(k);
    }
  } catch { return []; /* storage blocked */ }
  // readCache drops expired copies, so read after the scan, not during it.
  const out = [];
  for (const k of keys) {
    const v = readCache(k);
    if (v) out.push({ id: k.slice(base.length), name: v.data?.turf?.name || 'Walk list', at: v.at });
  }
  return out.sort((a, b) => b.at - a.at);
}

// The list on screen is the phone's copy: "Offline copy" with no signal,
// "Copy on this phone" ("this device" off a phone) when there's signal but
// the server didn't answer.
const copyChip = (q) => (q.fetchStatus === 'paused' || !onlineNow() ? 'Offline copy' : `Copy on ${thisDevice()}`);

// navigator.onLine as state (the walk list hides its outbox row offline —
// the shell's strip already says it — and the map's no-signal card).
const onlineNow = () => typeof navigator === 'undefined' || navigator.onLine !== false;
export { useOnline };

export function forgetFieldCache() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* storage blocked */ }
}
const watched = new WeakSet();
// Keep a query's data on the phone; forget everything on sign-out.
function usePhoneCopy(queryClient, q, key) {
  useEffect(() => {
    if (watched.has(queryClient)) return;
    watched.add(queryClient);
    queryClient.getQueryCache().subscribe((e) => {
      const k = e.query.queryKey;
      if (e.type === 'removed' && k.length === 1 && k[0] === 'me') forgetFieldCache();
    });
  }, [queryClient]);
  useEffect(() => {
    if (key && q.status === 'success' && q.data && q.dataUpdatedAt) writeCache(key, q.data, q.dataUpdatedAt);
  }, [key, q.status, q.data, q.dataUpdatedAt]);
  const status = q.error?.status;
  useEffect(() => { if (status === 403 || status === 404) dropCache(key); }, [key, status]);
}
// Knocks still in the outbox (e.g. after a reload with no signal) are the
// walk list's per-person overlay: pendingKnocks() in offline.js.

// "3:41 p.m." today, "Oct 18" before that — the canvasser's local clock.
const fmtWhen = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
};

function ProgressBar({ done, total, label = 'Doors done' }) {
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <span
      className="walk-bar" role="progressbar" aria-label={label}
      aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.min(done, total)}
    >
      <span className="walk-bar__fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

// Keep the docked "Next door" bar and the toast above the phone tab bar.
function useTabbarHeight(ref) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const h = Math.ceil(document.querySelector('.tabbar')?.getBoundingClientRect().height || 0);
      el.style.setProperty('--tabbar-h', `${h}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref]);
}

export default function Turfs() {
  const { id } = useParams();
  return id ? <WalkList key={id} id={id} /> : <TurfList />;
}

// ─────────────────────────────────────────────────────────────────────────────
// /turfs
// ─────────────────────────────────────────────────────────────────────────────

function TurfList() {
  const { me } = useOutletContext();
  const desk = DESK_ROLES.includes(me?.role);
  const queryClient = useQueryClient();
  const ck = cacheKey(me, 'turfs');
  const cached = useMemo(() => readCache(ck), [ck]);
  // Always refetch on open: knocks logged from the map's door card don't
  // touch this cache, and progress is the point of the page.
  const q = useQuery({
    queryKey: ['turfs'],
    queryFn: () => apiGet('/turfs'),
    refetchOnMount: 'always',
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.at,
  });
  usePhoneCopy(queryClient, q, ck);
  const turfs = q.data?.turfs ?? [];
  const offlineCopy = Boolean(q.data) && (q.fetchStatus === 'paused' || q.isError || !onlineNow());

  return (
    <div className="turfs-page">
      <header className="page-head turfs-head">
        <h1>{desk ? 'Turfs' : 'My turfs'}</h1>
        {desk && turfs.length > 0 && <Link className="btn turfs-draw" to="/map?draw=1">+ Draw turf</Link>}
      </header>
      {offlineCopy && <p className="walk-stale"><span className="chip">{copyChip(q)}</span></p>}

      {/* Offline with nothing cached, react-query pauses the fetch: isLoading
          stays false, so test isPending and say why nothing is showing. */}
      {q.isPending && (
        <p className="muted" role="status">{q.fetchStatus === 'paused' ? 'Offline — loads with signal' : 'Loading…'}</p>
      )}
      {q.isError && !q.data && (
        <p className="error" role="alert">Couldn’t load turfs — check your signal</p>
      )}

      {q.data && turfs.length === 0 && (
        <div className="turfs-empty">
          {desk ? (
            <>
              <p>No turfs yet</p>
              <Link className="btn btn-primary turfs-act" to="/map?draw=1">Draw a turf</Link>
            </>
          ) : (
            <p>No turf yet — ask your organizer</p>
          )}
        </div>
      )}

      {turfs.length > 0 && (
        <ul className="turfs-list">
          {turfs.map((t) => {
            const left = Math.max(0, t.doors - t.doorsDone);
            return (
              <li key={t.id} className="turfs-item" style={{ '--turf': turfColor(t) }}>
                <Link to={`/turfs/${t.id}`} className="turfs-row">
                  <span className="turfs-row__top">
                    <span className="turfs-row__name">{t.name}</span>
                    <span className={`turfs-row__left mono${left === 0 && t.doors ? ' is-done' : ''}`}>
                      {t.doors === 0 ? 'No doors' : left === 0 ? <>All done <span aria-hidden="true">✓</span></> : `${plural(left, 'door', 'doors')} left`}
                    </span>
                  </span>
                  <ProgressBar done={t.doorsDone} total={t.doors} label={`${t.name}: doors done`} />
                  {desk && t.members.length === 0 && <span className="chip fk-wait turfs-row__flag">No canvassers</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// /turfs/:id — the walk list
// ─────────────────────────────────────────────────────────────────────────────

// A door reached only by phone (a call or a text, never a knock): it counts
// as done, but shows a phone in the circle, not a tick. Needs each person's
// door_knocked (boolean) from the server's walk list; while it's missing,
// every done door ticks.
const reachedByPhoneOnly = (door) => {
  const reached = door.persons.filter((p) => p.last_contact_at);
  return reached.length > 0 && reached.every((p) => p.door_knocked === false);
};

function PhoneGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="walk-glyph">
      <path d="M7 3.5h3l1.4 4-2 1.4a11 11 0 0 0 5.7 5.7l1.4-2 4 1.4v3c0 1-.8 1.8-1.8 1.8A16 16 0 0 1 5.2 5.3c0-1 .8-1.8 1.8-1.8z" />
    </svg>
  );
}

function WalkList({ id }) {
  const { me } = useOutletContext();
  const desk = DESK_ROLES.includes(me?.role);
  const queryClient = useQueryClient();
  const scale = useScale();
  const outbox = useOutbox();
  const online = useOnline();
  const rootRef = useRef(null);
  const nextRef = useRef(null);
  useTabbarHeight(rootRef);
  const ck = cacheKey(me, `walk:${id}`);
  const cached = useMemo(() => readCache(ck), [ck]);

  const q = useQuery({
    queryKey: ['turf', id],
    queryFn: () => apiGet(`/turfs/${id}/walk`),
    // 403 (not your turf) and 404 won't change on a retry.
    retry: (n, err) => !(err?.status >= 400 && err.status < 500) && n < 1,
    // Losing signal mid-block shouldn't drop the list from memory.
    gcTime: 12 * 3600 * 1000,
    // Knocks from the map's door card or another phone: show them on open.
    refetchOnMount: 'always',
    // The copy kept on the phone: opens with no signal, even after a reload.
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.at,
  });
  usePhoneCopy(queryClient, q, ck);

  // What this phone logged since the list loaded, by person id:
  // { rating, outcome, at, queued }. Laid over the server's data so the list
  // reacts at once — and keeps showing knocks still waiting in the outbox.
  const [local, setLocal] = useState(() => pendingKnocks());
  const [notes, setNotes] = useState({});      // person id → unsent note
  const [busy, setBusy] = useState({});        // person id | door key → true
  // Back from a profile opened at a door: that door opens again (Door's
  // Profile link left its key on this list's history entry).
  const location = useLocation();
  const backTo = useRef(location.state?.door ? location.state : null);
  const [openKey, setOpenKey] = useState(null); // the expanded door
  const [picked, setPicked] = useState({});    // door key → selected person id
  const [scrollTo, setScrollTo] = useState(null);
  const [focusPanel, setFocusPanel] = useState(null); // reopened by a toast's "Change"
  const [docked, setDocked] = useState(false); // header's Next door scrolled away
  const [infoOpen, setInfoOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState(null); // { text, tone, act }
  const toastTimer = useRef(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const toast = (text, { tone = 'ok', act = null } = {}) => {
    clearTimeout(toastTimer.current);
    if (!alive.current) return;
    setToastMsg({ text, tone, act });
    toastTimer.current = setTimeout(() => setToastMsg(null), act || tone === 'error' ? 4000 : 3000);
  };
  // The Note field got focus: the toast must not sit on what they type.
  const hideToast = () => { clearTimeout(toastTimer.current); setToastMsg(null); };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['turf', id] });
    for (const key of KNOCK_KEYS) queryClient.invalidateQueries({ queryKey: [key] });
  };

  // Unsent notes, mirrored in a ref: a door closing (or the screen going
  // away) still knows what's in the boxes.
  const notesRef = useRef({});
  const setNote = (pid, v) => {
    notesRef.current = { ...notesRef.current, [pid]: v };
    if (alive.current) setNotes(notesRef.current);
  };

  // The outbox drained (here or from the app shell): refetch, and stop
  // calling anything "not sent yet".
  const prevPending = useRef(outbox.pending);
  const refusedAtStart = useRef(outbox.refused);
  useEffect(() => {
    if (outbox.pending > 0 && prevPending.current === 0) refusedAtStart.current = outbox.refused;
    if (outbox.pending < prevPending.current) {
      refresh();
      if (outbox.pending === 0) {
        // This render's `local` is the latest: the effect runs right after it.
        if (Object.values(local).some((v) => v.queued)) {
          // Something the server refused stays on the phone, unsent: the
          // shell's chip says "1 refused", and nothing here says "Sent".
          if (!outbox.lastError && outbox.refused <= refusedAtStart.current) toast('Sent');
          setLocal((l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, { ...v, queued: false }])));
        }
        refusedAtStart.current = outbox.refused;
      }
    }
    prevPending.current = outbox.pending;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outbox.pending]);

  // People added on this phone (not sent yet) whose pin is in this turf: at
  // their housemates' door, or a door of their own at the end of the list.
  const added = useMemo(() => pendingPeopleIn(q.data?.turf?.polygon, outbox.items), [q.data, outbox.items]);
  // Sign requests (and their Undo) still on the phone, laid over each door.
  const waitingSigns = useMemo(() => {
    const pending = outbox.items.filter((i) => i.state === 'pending');
    return {
      placed: pending.filter((i) => i.name === 'sign.place' && !i.undo && i.input?.person_id),
      cancelled: new Set(pending.filter((i) => i.name === 'sign.cancel').map((i) => i.input?.id)),
    };
  }, [outbox.items]);
  const doors = useMemo(() => {
    const list = (q.data?.doors ?? []).map((d) => ({ ...d, persons: [...d.persons] }));
    const known = new Set(list.flatMap((d) => d.persons.map((p) => p.id)));
    for (const p of added) {
      if (known.has(p.id)) continue;
      const home = p.address && list.find((d) => d.address && norm(d.address) === norm(p.address) && norm(d.unit) === norm(p.unit));
      if (home) home.persons.push(p);
      else list.push({ address: p.address, unit: p.unit, lat: p.lat, lng: p.lng, persons: [p], done: false });
    }
    return list.map((d) => {
      const persons = d.persons.map((p) => {
        const mine = local[p.id];
        return mine
          ? { ...p, rating: mine.rating ?? p.rating, last_outcome: mine.outcome, last_contact_at: mine.at, door_knocked: true, queued: mine.queued }
          : p;
      });
      const ids = new Set(persons.map((p) => p.id));
      const signs = [
        ...(d.signs || []).filter((s) => !waitingSigns.cancelled.has(s.id)),
        ...waitingSigns.placed.filter((i) => ids.has(i.input.person_id))
          .map((i) => ({ id: `pending:${i.cid}`, kind: i.input.kind, status: 'requested', pending: true })),
      ];
      return {
        ...d,
        key: `${norm(d.address)}|${norm(d.unit)}|${d.address ? '' : d.persons[0]?.id}`,
        persons,
        signs,
        done: d.done || persons.some((p) => local[p.id]),
      };
    });
  }, [q.data, local, added, waitingSigns]);

  // The latest list, open door and knocks, for handlers that finish after an
  // await (and for the unmount note flush).
  const doorsRef = useRef(doors);
  const openRef = useRef(openKey);
  const localRef = useRef(local);
  useLayoutEffect(() => { doorsRef.current = doors; openRef.current = openKey; localRef.current = local; });

  const total = doors.length;
  const doneCount = doors.filter((d) => d.done).length;
  const left = total - doneCount;
  const allDone = total > 0 && left === 0;
  const people = doors.reduce((n, d) => n + d.persons.length, 0);
  const rated = doors.reduce((n, d) => n + d.persons.filter((p) => p.rating).length, 0);
  const nextIdx = doors.findIndex((d) => !d.done);
  // Where the button goes: with no door open, the first one not knocked;
  // with one open, the first not-knocked door after it (wrapping round). At
  // an open door nobody has answered yet it says "Skip →" and goes quiet —
  // the rating buttons are the thing to tap there.
  const openIdx = openKey ? doors.findIndex((d) => d.key === openKey) : -1;
  let targetIdx = nextIdx;
  if (openIdx >= 0) {
    targetIdx = -1;
    for (let k = 1; k < total; k += 1) {
      const i = (openIdx + k) % total;
      if (!doors[i].done) { targetIdx = i; break; }
    }
  }
  const target = targetIdx >= 0 ? doors[targetIdx] : null;
  const skipping = Boolean(target) && openIdx >= 0 && !doors[openIdx].done;

  // Dock the button at the bottom (thumb reach) once the header's copy
  // has scrolled off the top — only one of the two shows at a time.
  const hasNext = Boolean(target);
  useEffect(() => {
    const el = nextRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(([e]) => setDocked(!e.isIntersecting && e.boundingClientRect.top < 0));
    io.observe(el);
    return () => io.disconnect();
  }, [hasNext, q.data]);

  // Scroll after the render that opened the next door.
  useEffect(() => {
    if (scrollTo == null) return;
    const el = document.getElementById(`walk-door-${scrollTo}`);
    if (el) {
      el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      el.focus({ preventScroll: true });
    }
    setScrollTo(null);
  }, [scrollTo]);

  useEffect(() => {
    const back = backTo.current;
    if (!back || !doors.length) return;
    backTo.current = null;
    const i = doors.findIndex((d) => d.key === back.door);
    if (i < 0) return;
    setOpenKey(back.door);
    if (back.person) setPicked((m) => ({ ...m, [back.door]: back.person }));
    setScrollTo(i);
  }, [doors]);

  const goNext = () => {
    if (!target) return;
    setOpenKey(target.key);
    setScrollTo(targetIdx);
  };

  // A toast's "Change" after the door closed: reopen it, focus its rating.
  useEffect(() => {
    if (focusPanel == null) return;
    focusRating(document.getElementById(`walk-panel-${focusPanel}`));
    setFocusPanel(null);
  }, [focusPanel]);

  const setBusyKey = (key, on) => setBusy((b) => {
    const n = { ...b };
    if (on) n[key] = true; else delete n[key];
    return n;
  });

  // A note on its own (its door closed, Next door, leaving the screen): a
  // "talked" contact carrying just the note — the same as "Save note".
  const sendNote = async (person, text, multi) => {
    try {
      const r = await logContact({ person_id: person.id, channel: 'door', outcome: 'contacted', note: text }, { who: person.name });
      if (!r.queued) refresh();
      if (!alive.current) return;
      setLocal((l) => ({
        ...l,
        [person.id]: { rating: l[person.id]?.rating || null, outcome: 'contacted', at: new Date().toISOString(), queued: r.queued },
      }));
      const who = multi ? `${firstName(person.name)} · ` : '';
      toast(r.queued ? `${who}${queuedText(r, 'Note')}` : `${who}Note saved`, { tone: r.queued ? 'queued' : 'ok' });
    } catch (err) {
      if (!alive.current) return;
      if (!notesRef.current[person.id]) setNote(person.id, text);
      toast(`Note not saved — ${err.message}`, { tone: 'error' });
    }
  };
  const flushNotes = (persons) => {
    const multi = persons.length > 1;
    for (const p of persons) {
      const text = (notesRef.current[p.id] || '').trim();
      if (!text) continue;
      setNote(p.id, '');
      sendNote(p, text, multi);
    }
  };
  // A door closing — collapsed, another door opened, Next door, or a tap
  // that settled it — sends any note still in its box.
  const prevOpen = useRef(null);
  useEffect(() => {
    const prev = prevOpen.current;
    prevOpen.current = openKey;
    if (!prev || prev === openKey) return;
    const door = doorsRef.current.find((d) => d.key === prev);
    if (door) flushNotes(door.persons);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);
  // Leaving the screen: the same, for every door.
  useEffect(() => () => {
    for (const d of doorsRef.current) flushNotes(d.persons);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After a tap that settles a door: close it and open the next door not
  // knocked yet (wrapping round) — the same rhythm as Calls.
  const advanceFrom = (key) => {
    const list = doorsRef.current;
    const at = list.findIndex((d) => d.key === key);
    for (let k = 1; k < list.length; k += 1) {
      const i = (at + k) % list.length;
      if (!list[i].done) { setOpenKey(list[i].key); setScrollTo(i); return; }
    }
    setOpenKey(null);
  };
  const reopen = (key) => {
    setOpenKey(key);
    setFocusPanel(doorsRef.current.findIndex((d) => d.key === key));
  };

  // One knock for one person, through the outbox. Returns { ok, queued }.
  // door: where it was tapped. A rating or an answer that leaves everyone at
  // the door rated or answered closes the door and opens the next one (the
  // toast's "Change" reopens it); a household with someone still to rate
  // stays open. A note in the box goes with the tap (and is cleared at once,
  // so it can't be sent twice).
  const log = async (person, outcome, rating = null, { quiet = false, batch = false, door = null, answers = null, visitOf = null } = {}) => {
    const note = (notesRef.current[person.id] || '').trim();
    const input = { person_id: person.id, channel: 'door', outcome };
    if (rating) input.rating = rating;
    if (note) { input.note = note; setNote(person.id, ''); }
    if (answers?.length) input.answers = answers; // survey answers (the door's "Questions")
    if (visitOf) input.visit_of = visitOf; // finishes this visit's "Save answers" knock
    setBusyKey(person.id, true);
    try {
      const r = await logContact(input, { who: person.name });
      const before = localRef.current;
      setLocal((l) => ({
        ...l,
        [person.id]: {
          rating: rating || l[person.id]?.rating || null,
          outcome,
          at: new Date().toISOString(),
          queued: r.queued,
        },
      }));
      if (!quiet) {
        const multi = (door?.persons.length || 0) > 1;
        // "Save note" on its own never moves on: they're still at the door.
        const settled = Boolean(door) && (Boolean(rating) || outcome !== 'contacted')
          && door.persons.every((p) => p.id === person.id || p.rating || before[p.id]);
        let act = null;
        if (door) {
          // Append-only: "Change" brings the rating row back; the next tap logs the fix.
          act = settled
            ? { label: 'Change', onClick: () => reopen(door.key) }
            : { label: 'Change', onClick: () => focusRating(document.getElementById(`walk-panel-${doorsRef.current.findIndex((d) => d.key === door.key)}`)) };
          // Only if they're still on this door (they may have opened another meanwhile).
          if (settled && openRef.current === door.key) advanceFrom(door.key);
        }
        const who = multi ? `${firstName(person.name)} · ` : '';
        const what = rating
          ? `Rated ${ratingText(scale, rating)}`
          : outcome === 'contacted' ? 'Note saved' : OUTCOME_LABEL[outcome];
        const said = answers?.length && !rating && !note ? answersSaid(answers, r.result) : `${what}${answersTail(answers, r.result)}`;
        // On the phone: what was saved, then where ("Rated 1 · Strong yes · 3 answers · Saved offline").
        const onPhone = () => queuedSaid(r, rating || outcome !== 'contacted' ? what : note ? 'Note' : null,
          answers?.length ? answersWord(answers.length) : null);
        toast(r.queued ? `${who}${onPhone()}` : `${who}${said}`, { tone: r.queued ? 'queued' : 'ok', act });
      }
      if (!r.queued && !batch) refresh();
      return { ok: true, queued: r.queued, signedOut: r.signedOut, client_id: r.client_id, result: r.result };
    } catch (err) {
      if (note && !notesRef.current[person.id]) setNote(person.id, note);
      toast(`Not saved — ${err.message}`, { tone: 'error' });
      return { ok: false };
    } finally {
      setBusyKey(person.id, false);
    }
  };

  // "No answer" at the door: a no-answer for everyone there, one tap. It
  // settles the door, so on to the next one.
  const nobodyHome = async (door) => {
    setBusyKey(door.key, true);
    let queued = null; // the last queued answer, for its words
    let failed = 0;
    let sent = 0;
    for (const p of door.persons) {
      const r = await log(p, 'no_answer', null, { quiet: true, batch: true });
      if (!r.ok) failed += 1;
      else if (r.queued) queued = r;
      else sent += 1;
    }
    if (sent) refresh(); // once for the door, not once per person
    setBusyKey(door.key, false);
    const change = { label: 'Change', onClick: () => reopen(door.key) };
    if (failed) toast(`${plural(failed, 'knock', 'knocks')} not saved — try again`, { tone: 'error' });
    else {
      toast(queued ? queuedSaid(queued, OUTCOME_LABEL.no_answer) : OUTCOME_LABEL.no_answer, { tone: queued ? 'queued' : 'ok', act: change });
      if (openRef.current === door.key) advanceFrom(door.key);
    }
  };

  // ── "Wants a sign?" and "+ Person at this door" (the door's More) ──
  // The list's copy is patched at once after a send; the refetch follows.
  const patchWalk = (fn) => {
    queryClient.cancelQueries({ queryKey: ['turf', id] });
    queryClient.setQueryData(['turf', id], (d) => (d?.doors ? { ...d, doors: d.doors.map(fn) } : d));
  };
  const signsChanged = () => { refresh(); queryClient.invalidateQueries({ queryKey: ['signs'] }); };
  const atDoor = (door) => (d) => d.persons.some((p) => door.persons.some((x) => x.id === p.id));
  // Through the outbox, like the map's door card. Undo is on the toast, and
  // only where the server can truly take it back (sign.cancel) — never by
  // filing the request as "taken down": it never went up.
  const askSign = async (door, person, kind) => {
    const label = SIGN_LABEL[kind] || 'Sign';
    const busyKey = `sign:${door.key}`;
    setBusyKey(busyKey, true);
    try {
      const r = await queueAction('sign.place', {
        person_id: person.id, kind, lat: door.lat, lng: door.lng, address: door.address || undefined,
      }, { who: person.name });
      if (r.queued) {
        toast(queuedText(r, label), { tone: 'queued', act: { label: 'Undo', onClick: () => undoQueuedSign(r.client_id, kind, person) } });
        return;
      }
      const sign = r.result?.sign;
      const mine = atDoor(door);
      if (sign?.id) {
        patchWalk((d) => (mine(d)
          ? { ...d, signs: [...(d.signs || []).filter((s) => s.id !== sign.id), { id: sign.id, kind: sign.kind, status: sign.status }] }
          : d));
      }
      const canCancel = sign?.id && await signCancelOffered(queryClient);
      toast(`${label} requested`, { act: canCancel ? { label: 'Undo', onClick: () => undoSign(sign, person) } : null });
      signsChanged();
    } catch (err) {
      toast(`Not saved — ${err.message}`, { tone: 'error' });
    } finally {
      setBusyKey(busyKey, false);
    }
  };
  const undoSign = async (sign, person) => {
    const label = SIGN_LABEL[sign.kind] || 'Sign';
    const drop = () => patchWalk((d) => ({ ...d, signs: (d.signs || []).filter((s) => s.id !== sign.id) }));
    try {
      const r = await queueAction('sign.cancel', { id: sign.id }, { who: person?.name });
      if (r.queued) { toast(queuedText(r, 'Undo'), { tone: 'queued' }); return; }
      drop();
      toast(`${label} cancelled`);
      signsChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        drop();
        toast(`${label} already cancelled`);
        signsChanged();
        return;
      }
      toast(`Not undone — ${err.message}`, { tone: 'error' });
    }
  };
  // Undo on a request still on the phone: take it off the phone, or — if it
  // may already have gone — send its cancel after it.
  const undoQueuedSign = (cid, kind, person) => {
    const label = SIGN_LABEL[kind] || 'Sign';
    const u = undoQueued(cid);
    if (u === 'removed') toast(`${label} cancelled`);
    else if (u === 'queued') toast(queuedText({}, 'Undo'), { tone: 'queued' });
    else if (u?.sent?.sign?.id) undoSign(u.sent.sign, person);
    else toast(`${label} already sent`);
  };
  // A new housemate the server has: on the list at once (one still on the
  // phone is laid over it from the outbox).
  const personAdded = (door, person) => {
    if (!person?.id) return;
    const row = {
      id: person.id, name: person.name, phone: person.phone ?? null, email: null,
      address: person.address ?? door.address ?? null, unit: person.unit ?? door.unit ?? null,
      lat: person.lat ?? door.lat, lng: person.lng ?? door.lng, rating: null, rated_at: null, tags: [],
      last_contact_at: null, last_outcome: null, door_knocked: false,
    };
    const mine = atDoor(door);
    patchWalk((d) => (mine(d) ? { ...d, persons: [...d.persons.filter((p) => p.id !== person.id), row] } : d));
  };

  const sendNow = async () => {
    await outbox.flush();
    refresh();
  };

  // A paused fetch (offline, nothing cached) is pending but not loading.
  const paused = q.isPending && q.fetchStatus === 'paused';
  if (q.isPending && !paused) {
    return <div className="walk" ref={rootRef}><p className="muted">Loading…</p></div>;
  }
  // Not yours any more / deleted: say so even over a list cached earlier.
  const gone = q.error?.status === 403 || q.error?.status === 404;
  if (!q.data || gone) {
    const err = q.error;
    return (
      <div className="walk" ref={rootRef}>
        <Link className="btn btn-quiet walk-back" to="/turfs">← Turfs</Link>
        <div className="walk-gone" role="alert">
          <p>
            {err?.status === 403
              ? 'Not your turf — ask your organizer'
              : err?.status === 404
                ? 'Turf not found'
                : paused
                  ? 'Offline — open this list once with signal'
                  : 'Couldn’t load — check your signal'}
          </p>
          {!gone && !paused && (
            <button type="button" className="btn walk-act" onClick={() => q.refetch()}>Try again</button>
          )}
        </div>
      </div>
    );
  }

  const { turf } = q.data;
  const offlineCopy = q.isError || q.fetchStatus === 'paused' || !online;
  const nextLabel = target && (skipping ? (
    <>
      <span className="walk-next__label">Skip</span>
      <span className="walk-next__addr">→ {doorLabel(target)}</span>
    </>
  ) : (
    <>
      <span className="walk-next__label">Next door</span>
      <span className="walk-next__addr">{doorLabel(target)}</span>
    </>
  ));
  const nextCls = `btn walk-next__btn ${skipping ? 'walk-next__btn--skip' : 'btn-primary'}`;
  const nextAria = target ? `${skipping ? 'Skip to' : 'Next door:'} ${doorLabel(target)}` : undefined;

  return (
    <div className={`walk${target ? ' has-next' : ''}${openIdx >= 0 ? ' has-open' : ''}`} ref={rootRef} style={{ '--turf': turfColor(turf) }}>
      <div className="walk-nav">
        <Link className="btn btn-quiet walk-back" to="/turfs">← Turfs</Link>
        <Link className="btn btn-quiet walk-act walk-map" to={`/map?turf=${turf.id}`} aria-label="Map of this turf">Map</Link>
      </div>

      <header className="walk-head">
        <h1 className="walk-title">{turf.name}</h1>
        {/* One phrase everywhere (turf list, map sheet, Today): "3 doors left" + the bar. */}
        {total > 0 && (
          <div className="walk-progress">
            {allDone ? (
              <span className="walk-progress__text walk-progress__done mono" role="status">All done <span aria-hidden="true">✓</span></span>
            ) : (
              <span className="walk-progress__text mono"><strong>{left}</strong> {left === 1 ? 'door' : 'doors'} left</span>
            )}
            <ProgressBar done={doneCount} total={total} />
          </div>
        )}
        {target ? (
          <button type="button" ref={nextRef} className={nextCls} aria-label={nextAria} onClick={goNext}>{nextLabel}</button>
        ) : allDone ? (
          <Link className="walk-calls" to="/calls">Make calls <span aria-hidden="true">→</span></Link>
        ) : null}
        {total > 0 && (
          <More id="walk-info" label={turf.notes ? 'Notes' : 'More'} open={infoOpen} onToggle={() => setInfoOpen((o) => !o)}>
            {turf.notes && <p className="walk-notes">{turf.notes}</p>}
            <dl className="walk-stats">
              <div><dt>Left</dt><dd>{left}</dd></div>
              <div><dt>People</dt><dd>{people}</dd></div>
              <div><dt>Rated</dt><dd>{rated}</dd></div>
            </dl>
          </More>
        )}
      </header>

      {/* Offline the shell's strip already says "1 knock saved": no second
          row here, and no "Send now" that can't send. */}
      {online && outbox.pending > 0 && (
        <div className="walk-outbox" role="status">
          <span className="chip fk-wait">{outbox.pending} not sent yet</span>
          {outbox.lastError && <span className="walk-outbox__err">{outbox.lastError}</span>}
          <button type="button" className="btn walk-act" onClick={sendNow} disabled={outbox.flushing}>
            {outbox.flushing ? 'Sending…' : 'Send now'}
          </button>
        </div>
      )}
      {outbox.pending === 0 && outbox.lastError && <p className="error" role="alert">{outbox.lastError}</p>}
      {offlineCopy && <p className="walk-stale"><span className="chip">{copyChip(q)}</span></p>}

      {total === 0 ? (
        <div className="walk-empty">
          <p>No doors in this turf yet</p>
          {desk ? <Link className="btn walk-act" to={`/map?turf=${turf.id}`}>Check the map</Link> : <p className="muted">Ask your organizer</p>}
        </div>
      ) : (
        <ol className="walk-doors">
          {doors.map((d, i) => (
            <Door
              key={d.key}
              door={d}
              index={i}
              isNext={openIdx < 0 && i === nextIdx}
              open={openKey === d.key}
              onToggle={() => setOpenKey((k) => (k === d.key ? null : d.key))}
              selectedId={picked[d.key]}
              onPick={(pid) => setPicked((m) => ({ ...m, [d.key]: pid }))}
              busy={busy}
              notes={notes}
              setNote={setNote}
              onNoteFocus={hideToast}
              onLog={(p, outcome, rating = null, answers = null, visitOf = null) => log(p, outcome, rating, { door: d, answers, visitOf })}
              onNobodyHome={() => nobodyHome(d)}
              onSign={(p, kind) => askSign(d, p, kind)}
              onAdded={(person) => personAdded(d, person)}
              toast={toast}
            />
          ))}
        </ol>
      )}

      {target && docked && (
        <div className="walk-dock">
          <button type="button" className={nextCls} aria-label={nextAria} onClick={goNext}>{nextLabel}</button>
        </div>
      )}

      {toastMsg && (
        <div className={`toast walk-toast walk-toast--${toastMsg.tone}${docked && target ? ' is-raised' : ''}`} role={toastMsg.tone === 'error' ? 'alert' : 'status'}>
          <span>{toastMsg.text}</span>
          {toastMsg.act && (
            <button
              type="button"
              className="btn walk-toast__btn"
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

function Door({
  door, index, isNext, open, onToggle, selectedId, onPick, busy, notes, setNote, onNoteFocus, onLog, onNobodyHome,
  onSign, onAdded, toast,
}) {
  const [more, setMore] = useState(false);
  const [adding, setAdding] = useState(false);
  const headId = `walk-door-${index}-addr`;
  const panelId = `walk-panel-${index}`;
  const multi = door.persons.length > 1;
  const sel = door.persons.find((p) => p.id === selectedId) || door.persons[0];
  const location = useLocation();
  const navigate = useNavigate();
  // The active survey's questions: answers go with a "talked" tap; a refused tap puts them back.
  const { id: turfId } = useParams();
  const survey = useSurvey({ context: 'door', personId: sel?.id, turfId, lat: door.lat, lng: door.lng });
  // After "Save answers", the next tap on that person finishes the same knock.
  const tap = async (p, outcome, rating = null) => {
    const answers = outcome === 'contacted' ? survey.take() : [];
    const visitOf = survey.visitOf('door');
    const r = await onLog(p, outcome, rating, answers, visitOf);
    if (!r?.ok) { survey.restore(answers); return; }
    survey.logged(r, { channel: 'door', outcome, rating, answers, visitOf });
  };
  const talk = (p, rating = null) => tap(p, 'contacted', rating);
  // Profile: the profile's back link reads `from` ("← Walk list"), and this
  // list's own history entry remembers the door, so coming back opens it again.
  const here = `${location.pathname}${location.search}`;
  const fromHere = { from: { to: here, label: 'Walk list' } };
  const markDoor = () => navigate(here, { replace: true, state: { door: door.key, person: sel?.id } });
  const doorBusy = Boolean(busy[door.key]) || door.persons.some((p) => busy[p.id]);
  const queued = door.persons.some((p) => p.queued);
  // Someone added on this phone the server doesn't have yet.
  const added = door.persons.some((p) => p.pending);
  const rated = door.persons.filter((p) => p.rating);
  const phoneOnly = door.done && reachedByPhoneOnly(door);
  const note = notes[sel?.id] || '';
  const dnc = sel && isDnc(sel);
  const last = sel?.last_contact_at
    ? `${OUTCOME_LABEL[sel.last_outcome] || 'Knocked'} · ${fmtWhen(sel.last_contact_at)}`
    : 'Not knocked yet';
  // Opening a door from its row: bring the whole door (buttons included)
  // into view — clear of the docked Next door bar and the tab bar.
  const toggle = () => {
    const opening = !open;
    onToggle();
    if (!opening) return;
    requestAnimationFrame(() => reveal(document.getElementById(`walk-door-${index}`)));
  };

  return (
    <li
      id={`walk-door-${index}`}
      tabIndex={-1}
      aria-labelledby={headId}
      className={`walk-door${door.done ? ' is-done' : ''}${isNext ? ' is-next' : ''}${open ? ' is-open' : ''}`}
    >
      <h2 className="walk-door__h">
        <button type="button" className="walk-door__head" aria-expanded={open} aria-controls={panelId} onClick={toggle}>
          <span className="walk-check" data-done={door.done ? '' : undefined} data-phone={phoneOnly ? '' : undefined} aria-hidden="true">
            {phoneOnly ? <PhoneGlyph /> : '✓'}
          </span>
          <span className="walk-door__main">
            <span className="walk-door__addr" id={headId}>{doorLabel(door)}</span>
            <span className="walk-door__names">{door.persons.map((p) => p.name).join(' · ')}</span>
          </span>
          {/* One line: a household says "2 rated" (whose is whose is inside). */}
          <span className="walk-door__chips">
            {(queued || added) && <span className="chip fk-wait">{added ? 'Not sent' : queuedChip(true)}</span>}
            {multi
              ? rated.length > 0 && <span className="chip walk-rated">{rated.length} rated</span>
              : rated.map((p) => <RatingChip key={p.id} code={p.rating} who brief />)}
          </span>
          <span className="walk-sr">
            {door.done ? (phoneOnly ? ' — called, not knocked' : ' — done') : ' — not knocked yet'}{isNext ? ', next door' : ''}
          </span>
        </button>
      </h2>

      {open && sel && (
        <div className="walk-panel" id={panelId}>
          <PersonTabs persons={door.persons} value={sel.id} onPick={onPick} />
          {dnc && <p className="walk-dnc"><span className="chip chip-danger">Do not contact</span> Skip {firstName(sel.name)}</p>}
          <RatingButtons key={sel.id} value={sel.rating} disabled={Boolean(busy[sel.id] || busy[door.key])} onPick={(code) => talk(sel, code)} />
          <OutcomeButtons
            items={DOOR_OUTCOMES}
            disabled={doorBusy}
            onPick={(code) => (code === NOBODY ? onNobodyHome() : tap(sel, code))}
          />
          <SurveyQuestions key={`questions-${sel.id}`} survey={survey} disabled={Boolean(busy[sel.id] || busy[door.key])} onSave={() => talk(sel)} />
          <More id={`walk-more-${index}`} open={more} onToggle={() => setMore((m) => !m)}>
            <p className="walk-last mono">
              {multi && <strong>{firstName(sel.name)} · </strong>}{last}
              {sel.queued && <span className="chip fk-wait"> {queuedChip()}</span>}
              {sel.pending && <span className="chip fk-wait"> Not sent yet</span>}
            </p>
            <div className="field walk-note">
              <label htmlFor={`walk-note-${sel.id}`} className="walk-sr">Note</label>
              <textarea
                id={`walk-note-${sel.id}`} className="input" rows={2} maxLength={2000}
                value={note} onChange={(e) => setNote(sel.id, e.target.value)}
                onFocus={onNoteFocus}
                placeholder="Note"
              />
            </div>
            <div className="walk-panel__links">
              {note.trim() && (
                <button type="button" className="btn walk-act" disabled={Boolean(busy[sel.id])} onClick={() => talk(sel)}>
                  Save note
                </button>
              )}
              {multi && (
                <button type="button" className="btn walk-act" disabled={Boolean(busy[sel.id])} onClick={() => tap(sel, 'no_answer')}>
                  No answer · {firstName(sel.name)} only
                </button>
              )}
              {sel.phone && <a className="btn walk-act" href={`tel:${dialable(sel.phone)}`}>Call</a>}
              {!sel.pending && <Link className="btn btn-quiet walk-act" to={`/people/${sel.id}`} state={fromHere} onClick={markDoor}>Profile</Link>}
            </div>
            <SignAsk
              idPrefix={`walk-${index}`}
              signs={door.signs}
              disabled={Boolean(busy[`sign:${door.key}`])}
              onAsk={(kind) => onSign(sel, kind)}
            />
            {door.address && (adding ? (
              <AddPersonInline
                door={door}
                toast={(text) => toast(text)}
                toastQueued={(text) => toast(text, { tone: 'queued' })}
                onCancel={() => setAdding(false)}
                onDone={(pid, person) => { setAdding(false); onAdded(person); onPick(pid); }}
              />
            ) : (
              <button type="button" className="btn walk-act door-add-btn" onClick={() => setAdding(true)}>
                + Person at this door
              </button>
            ))}
          </More>
        </div>
      )}
    </li>
  );
}
