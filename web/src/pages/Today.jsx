// Today — the first screen, one job per role.
//   Volunteer: one big yellow button — "Start canvassing" (their walk list, or
//     the map), or "Make calls" once every walk list is done (the "All done"
//     turf line still opens the walk list) — then ONE shift line: "Your next
//     shift" only when they're on it, otherwise the next open shift with
//     "5 spots left" (→ that shift, where they join it). Signs waiting to go
//     up get one row (→ Signs to put up), new replies to their texts another
//     ("2 replies" → the Inbox), and a quiet "My people · 6" (→ the people
//     they know). One line of numbers, theirs first:
//     "You 6 · Team 38 doors this week" (brief field.mine: contacts they
//     logged; field: everyone's). Calls and texts in the same shape, a quiet
//     "Signs" row (always — the sign crew's way to /signs and "Add a sign"),
//     other turfs and the upcoming events (with their RSVP pages) sit under
//     "More". With no signal, "Start canvassing" opens the walk list kept on
//     this phone (Turfs.jsx's offline copy), else the turf list.
//   Desk: three big numbers (doors this week · support · total raised). Doors
//     and money are taps to their screens (›); support opens its breakdown in
//     place (+), opposed by candidate ("McCallum 3 · Locke 2"). Then "Needs
//     you" (gifts over the limit, open pledges, filings due, new volunteers
//     from the public form, short shifts, signs to put up, new texts — replies
//     and texts from numbers nobody texted, → the Inbox) — name first, the
//     amount on the right, every row a tap to where it's fixed — then the
//     next shift and event. Getting started shows only the steps not done,
//     and only while the campaign is new. Walk lists, filings, team (managers),
//     providers, "Verify my books", the export and "Clear sample data" sit
//     under a quiet "More" at the bottom.
// A nearly empty campaign gets a one-click sample dataset (managers); a quiet
// "Sample data is loaded" line stays at the top while it's there. Volunteers
// never see money.
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { allCodes, bandOf, ratingByCode } from '@starbase/shared/scale';
import { ApiError, apiGet, apiPost, fmtMoney } from '../api.js';
import { ratingWho, useScale } from '../components/RatingButtons.jsx';
import { useFollowupCount } from '../components/LaddersCount.js';
import { useTextingStatus } from '../components/TextingStatus.js';
import { NeedsSignal, useOnline } from '../components/NoSignal.jsx';
import './today.css';

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
};

const STEP_ROUTES = { person: '/people?new=1', gift: '/money?new=1', filing: '/filings?new=1' };
// Who may do each getting-started step (server/actions/index.js: person.create
// and gift.log are desk roles, filing.create is manager + treasurer only).
const STEP_ROLES = {
  person: ['manager', 'treasurer', 'staff'],
  gift: ['manager', 'treasurer', 'staff'],
  filing: ['manager', 'treasurer'],
};

const plural = (n, word, many = `${word}s`) => (n === 1 ? word : many);
const num = (n) => (Number(n) || 0).toLocaleString('en-CA');
const fmtWhen = (iso) => new Date(iso).toLocaleString('en-CA', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
const DAY = 86_400_000;
const withinDays = (iso, days) => new Date(iso).getTime() - Date.now() < days * DAY;

// Big-number money: whole dollars, compact past $100k so it fits a phone tile.
const fmtBigMoney = (cents) => {
  const d = Math.round((Number(cents) || 0) / 100);
  if (d >= 1_000_000) return `$${(d / 1_000_000).toFixed(d >= 10_000_000 ? 0 : 1)}M`;
  if (d >= 100_000) return `$${Math.round(d / 1000)}k`;
  return `$${d.toLocaleString('en-CA')}`;
};

// api.js has no DELETE helper; same error contract as apiGet/apiPost.
const apiDelete = async (path) => {
  const res = await fetch(`/api${path}`, { method: 'DELETE', credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || `request failed (${res.status})`);
  return body;
};

function useToast() {
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Long enough to read: a long message (the sample clear's) stays longer.
  const show = (text) => {
    clearTimeout(timer.current);
    setMsg(text);
    timer.current = setTimeout(() => setMsg(null), Math.min(20000, 6000 + 50 * String(text || '').length));
  };
  const clear = () => { clearTimeout(timer.current); setMsg(null); };
  return { msg, show, clear };
}

const Chevron = () => <span className="today-chev" aria-hidden="true">›</span>;

// ── Sample data (managers, empty campaign) ──
function SampleCard({ onToast }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [already, setAlready] = useState(false);
  const online = useOnline();

  const load = async () => {
    setBusy(true);
    setError(null);
    setAlready(false);
    try {
      const r = await apiPost('/data/sample');
      await queryClient.invalidateQueries();
      onToast(`Sample data loaded — ${r.people ?? 52} people, ${r.signs ?? 0} signs, ${r.gifts ?? 0} gifts`);
    } catch (e) {
      if (e.status === 409) {
        // The server found sample-tagged people. Refresh; if the brief still
        // doesn't say "loaded", offer the clear right here.
        await queryClient.invalidateQueries();
        setAlready(true);
      } else {
        setError(`Couldn’t load sample data — ${e.message}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card today-sample" aria-label="Sample data">
      <p className="today-sample-lede">Try it with 52 made-up Surrey voters.</p>
      <div className="today-actions">
        <button type="button" className="btn btn-primary today-tap" onClick={load} disabled={busy || !online}>
          {busy ? 'Loading…' : 'Load sample data'}
        </button>
        <Link to="/people/import" className="btn btn-quiet today-tap">Import your list</Link>
      </div>
      {!online && <NeedsSignal>Needs signal</NeedsSignal>}
      {error && <p className="error" role="alert">{error}</p>}
      {already && (
        <>
          <p className="error" role="alert">Sample people are already here. Clear them first.</p>
          <SampleClear onToast={onToast} onCleared={() => setAlready(false)} />
        </>
      )}
    </section>
  );
}

// The quiet line at the top while the sample is in. Clearing it lives under
// "More" (managers).
function SampleLine({ desk }) {
  return <p className="today-sample-line">{desk ? 'Sample data is loaded' : 'Sample data · made-up voters'}</p>;
}

// "Clear sample data" → "Remove all sample data? · Clear it · Keep it", in place.
function SampleClear({ onToast, onCleared }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const online = useOnline();
  // Keep focus where the hand is: on "Keep it" when the question opens, back
  // on the link when it closes.
  const keepRef = useRef(null);
  const openRef = useRef(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
    else if (wasConfirming.current) openRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiDelete('/data/sample');
      await queryClient.invalidateQueries();
      setConfirming(false);
      onCleared?.();
      // The server says exactly what went and what stayed (and why): verbatim.
      const said = typeof r?.message === 'string' && r.message.trim() ? r.message.trim() : null;
      onToast(said || `Sample data cleared${r.cleared ? ` — ${r.cleared} people removed` : ''}`);
    } catch (e) {
      setError(`Couldn’t clear sample data — ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <div className="today-actions today-sample-clear">
        <button type="button" ref={openRef} className="btn today-tap" onClick={() => setConfirming(true)} disabled={!online}>
          Clear sample data
        </button>
        {!online && <NeedsSignal>Needs signal</NeedsSignal>}
      </div>
    );
  }
  return (
    <div className="today-confirm" role="group" aria-label="Clear sample data"
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) setConfirming(false); }}>
      <p>Remove all sample data? Your own records stay.</p>
      <div className="today-actions">
        <button type="button" className="btn today-tap today-danger" onClick={clear} disabled={busy || !online}>
          {busy ? 'Clearing…' : 'Clear it'}
        </button>
        <button type="button" ref={keepRef} className="btn btn-quiet today-tap" onClick={() => setConfirming(false)} disabled={busy}>
          Keep it
        </button>
      </div>
      {!online && <NeedsSignal>Needs signal</NeedsSignal>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

// ── Support picture: bands from the doorstep scale ──
const BANDS = [
  { band: 'support', label: 'Support' },
  { band: 'undecided', label: 'Undecided' },
  { band: 'opposed', label: 'Opposed' },
];

// The campaign's scale (its words and "Voting for?" list): every code it
// has, those off the list too, in list order — then any it doesn't know.
function supportPicture(scale, ratings) {
  const counts = { support: 0, undecided: 0, opposed: 0 };
  const variants = [];
  const codes = allCodes(scale);
  for (const code of [...codes, ...Object.keys(ratings || {}).filter((c) => !codes.includes(c))]) {
    const n = Number(ratings?.[code]) || 0;
    const band = bandOf(code);
    if (!band) continue;
    counts[band] += n;
    if (band === 'opposed' && n > 0) variants.push({ code, label: ratingByCode(scale, code)?.label, who: ratingWho(scale, code), n });
  }
  // Opposed, by who they back: biggest first, "Not sure" (plain 4) last.
  variants.sort((a, b) => (a.code === '4') - (b.code === '4') || b.n - a.n);
  const total = counts.support + counts.undecided + counts.opposed;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return { counts, variants, total, pct };
}

function SupportBar({ pic, size }) {
  const { counts, total, pct } = pic;
  if (!total) return null;
  const summary = BANDS.map((b) => `${b.label} ${counts[b.band]} (${pct(counts[b.band])}%)`).join(', ');
  return (
    <span className={`today-bar${size === 'small' ? ' is-small' : ''}`} role="img" aria-label={summary}>
      {BANDS.filter((b) => counts[b.band] > 0).map((b) => (
        <span key={b.band} data-band={b.band} style={{ flex: `${counts[b.band]} 1 0` }} />
      ))}
    </span>
  );
}

function SupportDetail({ pic, id }) {
  const { counts, variants, total, pct } = pic;
  const showVariants = variants.some((v) => v.code !== '4');
  return (
    <section className="card today-support" id={id} aria-label="Support breakdown">
      {total === 0 ? (
        <p className="today-empty">No ratings yet — every door fills this in.</p>
      ) : (
        <>
          <SupportBar pic={pic} />
          <ul className="today-legend">
            {BANDS.map((b) => (
              <li key={b.band}>
                <span className="sw" data-band={b.band} aria-hidden="true" />
                {b.label} <span className="mono">{num(counts[b.band])}</span>
                <span className="mono pct">{pct(counts[b.band])}%</span>
              </li>
            ))}
          </ul>
          {showVariants && (
            <ul className="today-variants" aria-label="Opposed, by who they vote for">
              {variants.map((v) => (
                <li key={v.code} title={v.label}>{v.who} <span className="mono">{num(v.n)}</span></li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="today-support-foot">
        <span className="mono muted">{num(total)} rated</span>
        <Link to="/map" className="today-more-link">Open the map <Chevron /></Link>
      </div>
    </section>
  );
}

// ── Desk: the three big numbers ──
function Numbers({ b, pic }) {
  const [params, setParams] = useSearchParams();
  const open = params.get('support') === '1';
  const detailId = useId();
  const toggle = () => {
    const next = new URLSearchParams(params);
    if (open) next.delete('support'); else next.set('support', '1');
    setParams(next, { replace: true });
  };
  const doors = Number(b.field?.doors) || 0;
  const supportPct = pic.total ? `${pic.pct(pic.counts.support)}%` : '—';
  return (
    <>
      {/* Same shape as the rows: › goes to a screen, + opens here. */}
      <div className="today-nums">
        <Link to="/map" className="today-num">
          <span className="today-num__n">{num(doors)}</span>
          <span className="today-num__label">Doors this week<span className="today-num__go" aria-hidden="true">›</span></span>
        </Link>
        <button type="button" className="today-num" aria-expanded={open} aria-controls={detailId} onClick={toggle}
          aria-label={pic.total ? `Support ${supportPct} of ${num(pic.total)} rated` : 'Support — no ratings yet'}>
          <span className="today-num__n">{supportPct}</span>
          <SupportBar pic={pic} size="small" />
          <span className="today-num__label">Support<span className="today-num__plus" aria-hidden="true" /></span>
        </button>
        {b.money && (
          <Link to="/money" className="today-num" aria-label={`Total raised ${fmtMoney(b.money.totalCents)}`}>
            <span className="today-num__n">{fmtBigMoney(b.money.totalCents)}</span>
            <span className="today-num__label">Total raised<span className="today-num__go" aria-hidden="true">›</span></span>
          </Link>
        )}
      </div>
      {open && <SupportDetail pic={pic} id={detailId} />}
    </>
  );
}

// ── Desk: Needs you ──
// Every row is a tap to the screen where it's dealt with (no rows that open
// in place). Name first, the amount on the right — as on Money. The only
// reason a gift is flagged is the contribution limit (server/lib/gifts.js),
// so it says so in plain words — the same label as Money.
const OVER_LIMIT = 'Over limit';
// People who signed up on the public volunteer form (/v/…) carry this tag
// until someone follows up (server/routes/public.js).
const PROSPECT_TAG = 'volunteer-prospect';
const PROSPECT_MAX = 100;

function LinkRow({ to, state, main, chip, chipCls = 'chip', end, title }) {
  return (
    <li className="today-need">
      <Link to={to} state={state} className="today-row" title={title}>
        <span className="today-row__main">{main}</span>
        {chip && <span className={chipCls}>{chip}</span>}
        {end && <span className="today-row__end mono">{end}</span>}
        <Chevron />
      </Link>
    </li>
  );
}

// A screen opened from here says so on its back link ("← Today").
const FROM_TODAY = { from: { to: '/', label: 'Today' } };

// "5 spots left" — the same words as the Shifts screen.
const spotsLeft = (n) => `${n} ${plural(n, 'spot')} left`;

function filingChip(n) {
  if (n < 0) return { chip: `${-n}d overdue`, chipCls: 'chip chip-danger' };
  if (n === 0) return { chip: 'Due today', chipCls: 'chip chip-warn' };
  return { chip: `${n}d left`, chipCls: 'chip' };
}

function NeedsYou({ b, me }) {
  // New volunteers from the public form. Under ['persons'], so the People
  // screen's edits (taking the tag off) refresh the count.
  const prospects = useQuery({
    queryKey: ['persons', 'prospects'],
    queryFn: () => apiGet(`/persons?tag=${PROSPECT_TAG}&limit=${PROSPECT_MAX}`),
  });
  const newVols = prospects.data?.persons?.length ?? 0;
  const followups = useFollowupCount(); // ladder follow-ups for staff
  // Texts waiting to be read: replies to yours, and numbers that wrote in.
  const newTexts = Number(useTextingStatus(me).data?.unread) || 0;
  const flagged = b.flagged ?? [];
  const pledges = Number(b.pledges?.n) || 0;
  const filings = (b.filings ?? []).filter((f) => Number(f.days_left) <= 7);
  const shortShifts = (b.shifts ?? [])
    .filter((s) => s.capacity && (Number(s.filled) || 0) < s.capacity && withinDays(s.starts_at, 7))
    .slice(0, 2);
  const signs = Number(b.signs?.requested) || 0;
  const shownFlags = flagged.length > 3 ? flagged.slice(0, 2) : flagged;
  const moreFlags = flagged.length - shownFlags.length;
  const empty = !flagged.length && !pledges && !filings.length && !newVols && !shortShifts.length && !signs && !followups.n && !newTexts;

  return (
    <section className="today-section" aria-labelledby="today-needs-h">
      <h2 className="today-h" id="today-needs-h">Needs you</h2>
      {empty ? (
        // Don't say "All caught up" before the volunteer count is in.
        prospects.isPending || followups.pending ? <p className="today-empty" aria-hidden="true">&nbsp;</p> : <p className="today-empty">All caught up.</p>
      ) : (
        <ul className="today-rows">
          {shownFlags.map((g) => (
            <LinkRow key={g.id} to={`/money?gift=${encodeURIComponent(g.id)}`} title={g.flag_reason || undefined}
              main={g.donor} chip={OVER_LIMIT} chipCls="chip chip-warn" end={fmtMoney(g.amount_cents)} />
          ))}
          {moreFlags > 0 && (
            <LinkRow to="/money" main={<><strong className="mono">{moreFlags}</strong> more {plural(moreFlags, 'gift')}</>}
              chip={OVER_LIMIT} chipCls="chip chip-warn" />
          )}
          {pledges > 0 && (
            <LinkRow to="/money"
              main={<><strong className="mono">{pledges}</strong> open {plural(pledges, 'pledge')}</>}
              end={fmtMoney(b.pledges.cents)} />
          )}
          {filings.map((f) => <LinkRow key={f.id} to="/filings" main={f.name} {...filingChip(Number(f.days_left))} />)}
          {newVols > 0 && (
            <LinkRow to={`/people?tag=${PROSPECT_TAG}`}
              main={<><strong className="mono">{newVols >= PROSPECT_MAX ? `${PROSPECT_MAX}+` : newVols}</strong> new {plural(newVols, 'volunteer')}</>} />
          )}
          {shortShifts.map((s) => {
            const left = s.capacity - (Number(s.filled) || 0);
            return <WhenRow key={s.id} to={`/shifts/${s.id}`} title={s.title} when={s.starts_at} extra={spotsLeft(left)} warn />;
          })}
          {signs > 0 && (
            <LinkRow to="/signs" main={<><strong className="mono">{signs}</strong> {plural(signs, 'sign')} to put up</>} />
          )}
          {followups.n > 0 && (
            <LinkRow to="/follow-ups" state={FROM_TODAY} main={<><strong className="mono">{followups.n}</strong> {plural(followups.n, 'follow-up')}</>} />
          )}
          {newTexts > 0 && (
            <LinkRow to="/inbox" state={FROM_TODAY} main={<><strong className="mono">{newTexts}</strong> new {plural(newTexts, 'text')}</>} />
          )}
        </ul>
      )}
    </section>
  );
}

// ── Coming up: one line each ──
// Two-line row: a small kicker, the title, the time. `fill` is a short plain
// count on the right ("12 going"); `extra` rides on the time line ("5 spots
// left", amber when `warn`) so a long title keeps the full width. Never a
// bare "3/8".
function WhenRow({ to, kicker, title, when, fill, extra, warn }) {
  return (
    <li className="today-need">
      <Link to={to} className="today-row">
        <span className="today-row__main">
          {kicker && <span className="today-row__kicker">{kicker}</span>}
          <span className="today-row__title">{title}</span>
          <span className="today-row__when">
            {fmtWhen(when)}
            {extra && <> · <span className={`today-row__extra${warn ? ' is-warn' : ''}`}>{extra}</span></>}
          </span>
        </span>
        {fill && <span className="today-fill mono">{fill}</span>}
        <Chevron />
      </Link>
    </li>
  );
}

// Desk: the campaign's next shift. Short shifts are already in "Needs you",
// so this is just what and when.
function ShiftRow({ shift }) {
  if (!shift) return <LinkRow to="/shifts?new=1" main={<span className="muted">No shifts planned</span>} chip="Plan one" />;
  return <WhenRow to={`/shifts/${shift.id}`} kicker="Next shift" title={shift.title} when={shift.starts_at} />;
}

function EventRow({ event }) {
  return (
    <WhenRow to="/outreach/events" kicker="Next event" title={event.title} when={event.starts_at}
      fill={`${num(event.going)} going`} />
  );
}

// ── Volunteer: which shifts am I on? ──
// GET /api/shifts marks each shift the caller is on (s.mine: their own
// supporter record, matched by login email, holds an active spot) — the same
// query (and key) as the Shifts screen. Only an older server leaves it out;
// then this falls back to finding their own record by email and reading its
// shifts.
const byStart = (a, b) => new Date(a.starts_at) - new Date(b.starts_at);
function useMyNextShift(me) {
  const shiftsQ = useQuery({ queryKey: ['shifts'], queryFn: () => apiGet('/shifts') });
  const rows = shiftsQ.data?.shifts;
  const marked = Array.isArray(rows) && rows.every((s) => typeof s.mine === 'boolean');
  const legacy = shiftsQ.isError || (shiftsQ.isSuccess && !marked);

  const email = String(me?.user?.email || '').trim().toLowerCase();
  const search = useQuery({
    queryKey: ['persons', 'search', email],
    queryFn: () => apiGet(`/persons?q=${encodeURIComponent(email)}&limit=8`),
    enabled: legacy && !!email,
  });
  const self = (search.data?.persons ?? []).find((p) => String(p.email || '').toLowerCase() === email);
  const person = useQuery({
    queryKey: ['person', self?.id],
    queryFn: () => apiGet(`/persons/${self.id}`),
    enabled: legacy && !!self,
  });

  const now = Date.now();
  const upcoming = (s) => new Date(s.starts_at).getTime() >= now;
  if (!legacy) {
    const next = shiftsQ.isSuccess ? (rows.filter((s) => s.mine && upcoming(s)).sort(byStart)[0] ?? null) : null;
    return { ready: shiftsQ.isSuccess, next };
  }
  const ready = !email || search.isError || (search.isSuccess && (!self || !person.isPending));
  const next = (person.data?.shifts ?? [])
    .filter((a) => a.status !== 'declined' && upcoming(a))
    .sort(byStart)[0] ?? null;
  return { ready, next };
}

// One line: the shift they're booked on — or, if none, the next shift that
// still needs people ("5 spots left" → that shift, where "Join" is). Never
// someone else's shift dressed up as theirs.
function VolunteerShiftRow({ shifts, me }) {
  const { ready, next } = useMyNextShift(me);
  if (!ready) return <li className="today-need today-row--wait" aria-hidden="true" />;
  if (next) {
    return <WhenRow to={`/shifts/${next.id}`} kicker="Your next shift" title={next.title} when={next.starts_at} />;
  }
  const open = shifts.find((s) => !s.capacity || (Number(s.filled) || 0) < s.capacity);
  if (!open) return <LinkRow to="/shifts" main={<span className="muted">No open shifts</span>} />;
  const left = open.capacity ? open.capacity - (Number(open.filled) || 0) : 0;
  return (
    <WhenRow to={`/shifts/${open.id}`} kicker="Open shift" title={open.title} when={open.starts_at}
      extra={left ? spotsLeft(left) : null} />
  );
}

// ── Getting started: only the steps left, only while the campaign is new ──
function GettingStarted({ steps, role, navigate }) {
  return (
    <section className="card today-steps" aria-labelledby="today-steps-h">
      <h2 className="today-h" id="today-steps-h">Getting started</h2>
      <ul className="today-rows">
        {steps.map((s) => {
          const can = (STEP_ROLES[s.key] ?? []).includes(role);
          return (
            <li key={s.key} className="today-step">
              <span>{s.label}</span>
              {can
                ? <button type="button" className="btn today-tap" onClick={() => navigate(STEP_ROUTES[s.key])}>Do it</button>
                : <span className="muted today-step-who">A manager adds this</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Walk lists (doors left from the shared ['turfs'] cache) ──
function useTurfStats(enabled) {
  const turfsQ = useQuery({ queryKey: ['turfs'], queryFn: () => apiGet('/turfs'), enabled });
  return Object.fromEntries((turfsQ.data?.turfs ?? []).map((t) => [t.id, t]));
}
// Every walk list knocked: each has 0 doors left (and there were doors).
const allTurfsDone = (turfs, statsById) => {
  if (!turfs.length) return false;
  const ds = turfs.map((t) => doorsLeft(statsById[t.id]));
  return ds.every((d) => d && d.left === 0) && ds.some((d) => d.doors > 0);
};
const doorsLeft = (stats) => {
  if (!stats) return null;
  const doors = Number(stats.doors) || 0;
  const done = Math.min(doors, Number(stats.doorsDone) || 0);
  return { doors, done, left: doors - done, pct: doors ? Math.round((done / doors) * 100) : 0 };
};
const leftLabel = (d) => {
  if (!d) return null;
  if (d.doors === 0) return 'No doors yet';
  return d.left === 0 ? 'All done' : `${d.left} ${plural(d.left, 'door')} left`;
};

function TurfRows({ turfs, statsById }) {
  return (
    <ul className="today-rows">
      {turfs.map((t) => (
        <LinkRow key={t.id} to={`/turfs/${t.id}`} main={t.name} chip={leftLabel(doorsLeft(statsById[t.id]))} />
      ))}
    </ul>
  );
}

function EventList({ events, wsSlug }) {
  return (
    <ul className="today-rows">
      {events.map((e) => (
        <li key={e.id} className="today-event">
          <span className="today-row__main">
            <span className="today-row__title">{e.title}</span>
            <span className="today-row__when">{fmtWhen(e.starts_at)}{e.location ? ` · ${e.location}` : ''}</span>
          </span>
          <span className="today-fill mono">{num(e.going)} going</span>
          {wsSlug && e.slug && e.public && (
            <a className="today-rsvp" href={`/e/${encodeURIComponent(wsSlug)}/${encodeURIComponent(e.slug)}`}
              target="_blank" rel="noopener noreferrer">
              RSVP page <span aria-hidden="true">↗</span>
              <span className="today-sr"> for {e.title} (opens in a new tab)</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── No signal: the walk list kept on this phone ──
// Turfs.jsx keeps each walk list it loads (key below, one day, wiped on sign
// out) so /turfs/:id opens with no signal. With the brief offline, Today
// reads those keys to send "Start canvassing" to the most recently loaded
// one — never to an empty map. Read only; Turfs.jsx owns the format.
const FIELD_CACHE = 'starbase:field:v1:';
const FIELD_TTL = 24 * 3600 * 1000;
function cachedWalkList(me) {
  if (!me?.user?.id || !me?.workspace?.id) return null;
  const prefix = `${FIELD_CACHE}${me.workspace.id}:${me.user.id}:walk:`;
  let best = null;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      if (!v?.data?.turf || !(Date.now() - v.at < FIELD_TTL)) continue;
      if (!best || v.at > best.at) best = { id: k.slice(prefix.length), at: v.at, name: v.data.turf.name };
    }
  } catch { return null; }
  return best;
}

function NoSignalToday({ me }) {
  const field = me.role === 'volunteer';
  const walk = field ? cachedWalkList(me) : null;
  return (
    <div className={`today${field ? ' today--field' : ''}`}>
      <span className="eyebrow">{greeting()}</span>
      <h1>{me.workspace.name}</h1>
      <p className="today-offline" role="status">
        {walk ? 'No signal — your walk list still works.' : 'No signal — this fills in when you’re back online.'}
      </p>
      {field && (
        <section className="today-go" aria-label="Canvass">
          <Link to={walk ? `/turfs/${walk.id}` : '/turfs'} className="btn btn-primary today-start">
            Start canvassing <span aria-hidden="true">→</span>
          </Link>
          {walk?.name && <p className="today-go__meta"><span className="today-go__turf">{walk.name}</span></p>}
        </section>
      )}
    </div>
  );
}

// Quiet disclosure at the bottom. Its contents aren't rendered until opened.
function More({ children }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="today-morebox">
      <button type="button" className="today-morebox__toggle disclose" aria-expanded={open} aria-controls={id}
        onClick={() => setOpen((v) => !v)}>
        More
      </button>
      {open && <div className="today-morebox__body" id={id}>{children}</div>}
    </section>
  );
}

// "You 6 · Team 38 doors this week": their own count first, then everyone's
// (the brief's field.mine and field). The noun follows the team number.
function MineLine({ you, team, noun, small }) {
  const t = Number(team) || 0;
  return (
    <p className={`today-mine${small ? ' is-small' : ''}`}>
      <span className="today-mine__pair">You <strong className="today-mine__n">{num(you)}</strong></span>
      <span className="today-mine__dot"> · </span>
      <span className="today-mine__pair">Team <strong className="today-mine__n">{num(t)}</strong></span>
      {' '}<span className="today-mine__what">{plural(t, noun)} this week</span>
    </p>
  );
}

// ── Volunteer Today ──
function VolunteerToday({ b, me }) {
  const myTurfs = b.myTurfs ?? [];
  const statsById = useTurfStats(myTurfs.length > 0);
  // Start where there are doors left; otherwise the first turf; else the map.
  // Every walk list done: the one button turns to the phones.
  const done = allTurfsDone(myTurfs, statsById);
  const firstOpen = myTurfs.find((t) => (doorsLeft(statsById[t.id])?.left ?? 1) > 0) ?? myTurfs[0];
  const d = firstOpen ? doorsLeft(statsById[firstOpen.id]) : null;
  const others = done ? myTurfs : myTurfs.filter((t) => t !== firstOpen);
  const events = b.events ?? [];
  const f = b.field ?? {};
  const mine = f.mine ?? {};
  const signs = Number(b.signs?.requested) || 0;
  const replies = Number(useTextingStatus(me).data?.unread) || 0; // replies to their texts

  return (
    <div className="today today--field">
      <span className="eyebrow">{greeting()}</span>
      <h1>{me.workspace.name}</h1>
      {b.sampleLoaded && <SampleLine />}

      {done ? (
        <section className="today-go" aria-label="Calls">
          <Link to="/calls" className="btn btn-primary today-start">
            Make calls <span aria-hidden="true">→</span>
          </Link>
          {/* Still the way back to the walk list: re-check a door, open a profile. */}
          <Link to={myTurfs.length === 1 ? `/turfs/${myTurfs[0].id}` : '/turfs'} className="today-go__meta today-go__link">
            <span className="today-go__turf">{myTurfs.length === 1 ? myTurfs[0].name : `${myTurfs.length} turfs`}</span>
            <span className="today-go__done">— All done <span aria-hidden="true">✓</span></span>
            <Chevron />
          </Link>
        </section>
      ) : (
        <section className="today-go" aria-label="Canvass">
          <Link to={firstOpen ? `/turfs/${firstOpen.id}` : '/map'} className="btn btn-primary today-start">
            Start canvassing <span aria-hidden="true">→</span>
          </Link>
          {firstOpen ? (
            <div className="today-go__meta">
              <span className="today-go__turf">{firstOpen.name}</span>
              {d && <span className="mono">{leftLabel(d)}</span>}
              {d && d.doors > 0 && <span className="today-progress" aria-hidden="true"><span style={{ width: `${d.pct}%` }} /></span>}
            </div>
          ) : (
            <p className="today-go__meta muted">No walk list yet — pick a door on the map.</p>
          )}
        </section>
      )}

      <ul className="today-rows today-next">
        <VolunteerShiftRow shifts={b.shifts ?? []} me={me} />
        {signs > 0 && (
          <LinkRow to="/signs" main={<><strong className="mono">{signs}</strong> {plural(signs, 'sign')} to put up</>} />
        )}
        {replies > 0 && (
          <LinkRow to="/inbox" state={FROM_TODAY} main={<><strong className="mono">{replies}</strong> {plural(replies, 'reply', 'replies')}</>} />
        )}
        {/* The people they know (brief.myPeople), to reach in person, by call or text. */}
        <LinkRow to="/my-people" state={FROM_TODAY}
          main={<>My people{b.myPeople ? <> · <strong className="mono">{b.myPeople}</strong></> : null}</>} />
      </ul>

      <MineLine you={mine.doors} team={f.doors} noun="door" />

      <More>
        <MineLine you={mine.calls} team={f.calls} noun="call" small />
        <MineLine you={mine.texts} team={f.texts} noun="text" small />
        {Number(b.inPerson?.week) > 0 && <MineLine you={b.inPerson.mine} team={b.inPerson.week} noun="in-person talk" small />}
        {/* Always here, signs waiting or not: the sign crew's way to Add a sign. */}
        <ul className="today-rows">
          <LinkRow to="/signs" main="Signs" />
        </ul>
        {others.length > 0 && (
          <>
            <h3 className="today-subh">{done ? 'Your turfs' : 'Your other turfs'}</h3>
            <TurfRows turfs={others} statsById={statsById} />
          </>
        )}
        {events.length > 0 && (
          <>
            <h3 className="today-subh">Events</h3>
            <EventList events={events} wsSlug={me.workspace.slug} />
          </>
        )}
      </More>
    </div>
  );
}

// ── Desk Today ──
function DeskToday({ b, me, toast }) {
  const navigate = useNavigate();
  const [verify, setVerify] = useState(null);
  const isManager = me?.role === 'manager';
  const myTurfs = b.myTurfs ?? [];
  const events = b.events ?? [];
  const peopleTotal = Number(b.people?.total) || 0;
  const offerSample = isManager && !b.sampleLoaded && peopleTotal < 5;
  const scale = useScale();
  const pic = supportPicture(scale, b.ratings);
  const statsById = useTurfStats(myTurfs.length > 0);
  const f = b.field ?? {};

  // Only the steps left; the card goes once only the filing is left, or the
  // campaign has five people (it's past the first day by then).
  const stepsLeft = (b.activation?.steps ?? []).filter((s) => !s.done);
  const showSteps = !b.activation?.complete && peopleTotal < 5 && stepsLeft.some((s) => s.key !== 'filing');

  const onVerify = async () => {
    setVerify({ busy: true });
    try {
      setVerify(await apiGet('/audit/verify'));
    } catch (e) {
      setVerify({ error: e.message });
    }
  };

  return (
    <div className="today">
      <span className="eyebrow">{greeting()}</span>
      <h1>{me.workspace.name}</h1>

      {offerSample && <SampleCard onToast={toast.show} />}
      {b.sampleLoaded && <SampleLine desk />}
      {showSteps && <GettingStarted steps={stepsLeft} role={me?.role} navigate={navigate} />}

      <Numbers b={b} pic={pic} />

      <NeedsYou b={b} me={me} />

      <section className="today-section" aria-labelledby="today-next-h">
        <h2 className="today-h" id="today-next-h">Coming up</h2>
        <ul className="today-rows">
          <ShiftRow shift={(b.shifts ?? [])[0]} />
          {events[0] && <EventRow event={events[0]} />}
        </ul>
      </section>

      <More>
        <p className="today-fieldline mono">
          This week: {num(f.calls)} {plural(Number(f.calls) || 0, 'call')} · {num(f.texts)} {plural(Number(f.texts) || 0, 'text')}
          {Number(b.inPerson?.week) > 0 && <> · {num(b.inPerson.week)} in person</>}
          {b.money && <> · {fmtMoney(b.money.weekCents)} raised</>}
        </p>
        <p className="today-fieldline mono">
          In all: {num(peopleTotal)} people
          {b.money && <> · {num(b.money.gifts)} {plural(b.money.gifts, 'gift')} · {fmtMoney(b.money.totalCents)}</>}
        </p>
        {myTurfs.length > 0 && (
          <>
            <h3 className="today-subh">{myTurfs.length === 1 ? 'Your walk list' : 'Your walk lists'}</h3>
            <TurfRows turfs={myTurfs} statsById={statsById} />
          </>
        )}
        <ul className="today-rows">
          <LinkRow to="/filings" main="Filings" />
          <LinkRow to="/surveys" main="Surveys" />
          {isManager && <LinkRow to="/team" main={<>Team <span className="muted">· invite people</span></>} />}
          {b.providers && (!b.providers.email || !b.providers.text) && (
            <LinkRow to="/outreach/website" main="Connect email & texting" />
          )}
        </ul>
        <div className="today-actions today-morebox__tools">
          <button type="button" className="btn today-tap" onClick={onVerify} disabled={verify?.busy}>Verify my books</button>
          <a className="btn today-tap" href="/api/export">Export all data</a>
        </div>
        {verify?.ok && <p className="mono ok-text" role="status">✓ {verify.checked} entries check out</p>}
        {verify?.ok === false && <p className="error" role="alert">The books don’t check out</p>}
        {verify?.error && <p className="error" role="alert">{verify.error}</p>}
        {b.sampleLoaded && isManager && <SampleClear onToast={toast.show} />}
      </More>
    </div>
  );
}

export default function Today() {
  const { me } = useOutletContext();
  const toast = useToast();
  const brief = useQuery({ queryKey: ['brief'], queryFn: () => apiGet('/brief') });

  // No signal: the query is paused (react-query knew it was offline) or the
  // fetch itself failed (a TypeError, not an ApiError). Either way it refetches
  // by itself once the phone is back online (main.jsx + react-query).
  const noSignal = !brief.data && (
    (brief.isPending && brief.fetchStatus === 'paused')
    || (brief.isError && !(brief.error instanceof ApiError))
  );
  if (noSignal) return <NoSignalToday me={me} />;
  if (brief.isError && !brief.data) {
    return (
      <div className="today">
        <p className="error" role="alert">Couldn’t load Today — {brief.error.message}</p>
        <button type="button" className="btn today-tap" onClick={() => brief.refetch()}>Try again</button>
      </div>
    );
  }
  // isPending, not isLoading: a query paused offline is pending but not
  // fetching, and brief.data would be undefined below.
  if (brief.isPending) return <p className="muted">Loading…</p>;
  const b = brief.data;
  const desk = me?.role !== 'volunteer';

  return (
    <>
      {desk ? <DeskToday b={b} me={me} toast={toast} /> : <VolunteerToday b={b} me={me} />}
      {toast.msg && (
        <div className="toast today-toast" role="status">
          <span>{toast.msg}</span>
          <button type="button" className="btn" onClick={toast.clear}>OK</button>
        </div>
      )}
    </>
  );
}
