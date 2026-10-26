// GET /dashboard?period=today|7d|30d|all   managers: the campaign's field work
// in one read, for Today's dashboard.
//
//   overview     contacts today and in the period and in all: how many, by
//                channel, people reached, support (ratings in the support
//                band), who was out
//   series       contacts per day (per week when the period is "all") by
//                outcome — the stacked bar
//   teams        each team's contacts in the period, by outcome, with how
//                many of its members were out; "No team" for everyone else
//   people       everyone who has logged a contact or is sharing a location:
//                their teams, contacts in the period, when they were last
//                heard from, where — the live position while they share it
//                (field.ping, "out now" when it is minutes old), else their
//                last contact's door — and today's trail
//   pins         the period's contacts on the map (the person's door)
//   recent       the last twenty contacts, who and where
//   turfs        the turfs, for the map's outlines
// Days are the workspace's (settings.tz, Vancouver by default).
import { Hono } from 'hono';
import { bandOf } from '../../../shared/scale.js';

export const api = new Hono();
export const OUTCOMES = ['contacted', 'no_answer', 'refused', 'moved', 'inaccessible'];
export const PERIODS = ['today', '7d', '30d', 'all'];
const OUT_NOW_MS = 10 * 60_000;     // a position this fresh is "out now"
const TRAIL_MAX = 400;              // points per person on the map

const SINCE = {
  today: "date_trunc('day', now() at time zone $1::text) at time zone $1::text",
  '7d': "(date_trunc('day', now() at time zone $1::text) - interval '6 days') at time zone $1::text",
  '30d': "(date_trunc('day', now() at time zone $1::text) - interval '29 days') at time zone $1::text",
  all: 'null::timestamptz',
};
const DAYS = { today: 1, '7d': 7, '30d': 30 };

const blank = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
const localDay = (d, tz) => {
  // YYYY-MM-DD of a moment in the workspace's zone.
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Contacts since a moment (null: ever): how many, by channel, people reached,
// how many canvassers, and ratings in the support band.
const counts = async (db, ws, since) => {
  const r = (await db.query(
    `select count(*)::int as contacts,
            count(*) filter (where channel = 'door')::int as doors,
            count(*) filter (where channel = 'phone')::int as calls,
            count(*) filter (where channel = 'text')::int as texts,
            count(distinct person_id)::int as people,
            count(distinct created_by)::int as who
       from contacts where workspace_id = $1 and ($2::timestamptz is null or created_at >= $2::timestamptz)`,
    [ws, since],
  )).rows[0];
  const byRating = (await db.query(
    `select rating, count(*)::int as n from contacts where workspace_id = $1 and rating is not null
       and ($2::timestamptz is null or created_at >= $2::timestamptz) group by rating`,
    [ws, since],
  )).rows;
  const support = byRating.filter((x) => bandOf(x.rating) === 'support').reduce((a, x) => a + x.n, 0);
  return { ...r, support };
};
const sinceOf = async (db, period, tz) => {
  if (period === 'all') return null;
  const v = (await db.query(`select ${SINCE[period]} as since`, [tz])).rows[0].since;
  return new Date(v).toISOString();
};

api.get('/dashboard', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role !== 'manager') return c.json({ error: 'managers only' }, 403);
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const tz = ctx.workspace.settings?.tz || 'America/Vancouver';
  const period = PERIODS.includes(c.req.query('period')) ? c.req.query('period') : '30d';
  const since = await sinceOf(db, period, tz);
  const startOfToday = await sinceOf(db, 'today', tz);
  const inPeriod = '($2::timestamptz is null or c.created_at >= $2::timestamptz)';
  const P = [ws, since];

  const overview = {
    today: await counts(db, ws, startOfToday),
    period: await counts(db, ws, since),
    all: await counts(db, ws, null),
  };

  // The stacked bar: a row per day (or week) and outcome.
  const weekly = period === 'all';
  const bucket = weekly ? "to_char(date_trunc('week', c.created_at at time zone $3::text), 'YYYY-MM-DD')" : "to_char(c.created_at at time zone $3::text, 'YYYY-MM-DD')";
  const cells = (await db.query(
    `select ${bucket} as day, c.outcome, count(*)::int as n from contacts c
      where c.workspace_id = $1 and ${inPeriod} group by 1, 2 order by 1`, [...P, tz],
  )).rows;
  const byDay = new Map();
  for (const r of cells) {
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, ...blank() });
    if (OUTCOMES.includes(r.outcome)) byDay.get(r.day)[r.outcome] += r.n;
  }
  const todayYmd = localDay(new Date(), tz);
  let series;
  if (weekly) {
    series = [...byDay.values()];
    if (series.length) {
      // Every week from the first to this one, empty weeks included.
      const out = []; const last = series[series.length - 1].day;
      for (let d = series[0].day; d <= last || out.length === 0; d = addDays(d, 7)) {
        out.push(byDay.get(d) || { day: d, ...blank() });
        if (out.length > 260) break;
      }
      series = out;
    }
  } else {
    const n = DAYS[period];
    series = Array.from({ length: n }, (_, i) => {
      const d = addDays(todayYmd, i - (n - 1));
      return byDay.get(d) || { day: d, ...blank() };
    });
  }

  // Teams: contacts in the period by the members of each team.
  const teams = (await db.query(
    'select id, name, lead_user_id from teams where workspace_id = $1 and deleted_at is null order by lower(name)', [ws],
  )).rows;
  const teamMembers = (await db.query('select team_id, user_id from team_members where workspace_id = $1', [ws])).rows;
  const perUser = (await db.query(
    `select c.created_by as user_id, c.outcome, count(*)::int as n, max(c.created_at) as last_at
       from contacts c where c.workspace_id = $1 and ${inPeriod} group by 1, 2`, P,
  )).rows;
  const userOutcomes = new Map();
  for (const r of perUser) {
    if (!userOutcomes.has(r.user_id)) userOutcomes.set(r.user_id, { ...blank(), contacts: 0, last_at: null });
    const u = userOutcomes.get(r.user_id);
    if (OUTCOMES.includes(r.outcome)) u[r.outcome] += r.n;
    u.contacts += r.n;
    if (!u.last_at || new Date(r.last_at) > new Date(u.last_at)) u.last_at = r.last_at;
  }
  const positions = (await db.query('select user_id, lat, lng, accuracy, at from field_positions where workspace_id = $1', [ws])).rows;
  const posByUser = new Map(positions.map((p) => [p.user_id, p]));
  const outNow = (p) => !!p && Date.now() - new Date(p.at).getTime() < OUT_NOW_MS;
  const teamRows = (t) => {
    const members = teamMembers.filter((m) => m.team_id === t.id).map((m) => m.user_id);
    const sum = { ...blank(), contacts: 0, out: 0 };
    for (const uid of members) {
      const u = userOutcomes.get(uid);
      if (u) { for (const o of OUTCOMES) sum[o] += u[o]; sum.contacts += u.contacts; }
      if (outNow(posByUser.get(uid))) sum.out += 1;
    }
    return { id: t.id, name: t.name, lead_user_id: t.lead_user_id, members: members.length, ...sum };
  };
  const teamsOut = teams.map(teamRows);
  const onATeam = new Set(teamMembers.map((m) => m.user_id));
  const loose = { ...blank(), contacts: 0, out: 0, members: 0 };
  for (const [uid, u] of userOutcomes) if (!onATeam.has(uid)) { for (const o of OUTCOMES) loose[o] += u[o]; loose.contacts += u.contacts; loose.members += 1; }
  for (const p of positions) if (!onATeam.has(p.user_id) && outNow(p)) loose.out += 1;
  if (loose.contacts || loose.out) teamsOut.push({ id: null, name: 'No team', lead_user_id: null, ...loose });

  // People: anyone who logged a contact ever, or is sharing a location.
  const users = (await db.query(
    `select u.id, u.name, m.role from memberships m join users u on u.id = m.user_id where m.workspace_id = $1 order by lower(u.name)`, [ws],
  )).rows;
  const ever = (await db.query(
    `select c.created_by as user_id, count(*)::int as n, max(c.created_at) as last_at from contacts c where c.workspace_id = $1 group by 1`, [ws],
  )).rows;
  const everBy = new Map(ever.map((r) => [r.user_id, r]));
  const lastDoor = (await db.query(
    `select distinct on (c.created_by) c.created_by as user_id, p.lat, p.lng, c.created_at as at
       from contacts c join persons p on p.id = c.person_id
      where c.workspace_id = $1 and p.lat is not null and p.lng is not null
      order by c.created_by, c.created_at desc`, [ws],
  )).rows;
  const lastDoorBy = new Map(lastDoor.map((r) => [r.user_id, r]));
  const trails = (await db.query(
    'select user_id, lat, lng, at from field_tracks where workspace_id = $1 and at >= $2::timestamptz order by user_id, at', [ws, startOfToday],
  )).rows;
  const trailBy = new Map();
  for (const t of trails) {
    if (!trailBy.has(t.user_id)) trailBy.set(t.user_id, []);
    const arr = trailBy.get(t.user_id);
    if (arr.length < TRAIL_MAX) arr.push([t.lat, t.lng, t.at]);
  }
  const teamNames = (uid) => teamMembers.filter((m) => m.user_id === uid).map((m) => teams.find((t) => t.id === m.team_id)?.name).filter(Boolean);
  const people = users
    .filter((u) => everBy.has(u.id) || posByUser.has(u.id))
    .map((u) => {
      const pos = posByUser.get(u.id) || null;
      const door = lastDoorBy.get(u.id) || null;
      const period_ = userOutcomes.get(u.id) || { ...blank(), contacts: 0, last_at: null };
      const live = outNow(pos);
      const where = pos ? { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, at: pos.at, from: 'position' }
        : door ? { lat: door.lat, lng: door.lng, accuracy: null, at: door.at, from: 'contact' } : null;
      const seen = [pos?.at, everBy.get(u.id)?.last_at].filter(Boolean).map((x) => new Date(x).getTime());
      return {
        id: u.id, name: u.name, role: u.role, teams: teamNames(u.id),
        contacts: period_.contacts, by_outcome: Object.fromEntries(OUTCOMES.map((o) => [o, period_[o]])),
        contacts_all: everBy.get(u.id)?.n || 0,
        last_seen_at: seen.length ? new Date(Math.max(...seen)).toISOString() : null,
        sharing: !!pos, out_now: live, where, trail: trailBy.get(u.id) || [],
      };
    })
    .sort((a, b) => (b.out_now - a.out_now) || (new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0)));

  const pins = (await db.query(
    `select c.id, c.person_id, c.created_by as user_id, c.outcome, c.channel, c.created_at as at, p.lat, p.lng
       from contacts c join persons p on p.id = c.person_id
      where c.workspace_id = $1 and ${inPeriod} and p.lat is not null and p.lng is not null
      order by c.created_at desc limit 2000`, P,
  )).rows;
  const recent = (await db.query(
    `select c.id, c.person_id, p.name as person, c.created_by as user_id, u.name as who, c.channel, c.outcome, c.rating, c.created_at as at
       from contacts c join persons p on p.id = c.person_id left join users u on u.id = c.created_by
      where c.workspace_id = $1 order by c.created_at desc limit 20`, [ws],
  )).rows;
  const turfs = (await db.query(
    'select id, name, polygon, color from turfs where workspace_id = $1 and deleted_at is null', [ws],
  )).rows.map((t) => ({ ...t, polygon: typeof t.polygon === 'string' ? JSON.parse(t.polygon) : t.polygon }));

  return c.json({
    period, tz, since, today: todayYmd, granularity: weekly ? 'week' : 'day', outcomes: OUTCOMES,
    overview, series, teams: teamsOut, people, pins, recent, turfs,
    out_now: people.filter((p) => p.out_now).length,
  });
});
