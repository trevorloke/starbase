// The workspace API. Reads are cursor-paginated and workspace-scoped; writes
// go exclusively through POST /api/actions/:name. GET /api/events is the
// sync protocol AND the public API — the same endpoint the app uses — and
// GET /api/export is the contractual one-click full-fidelity export.
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { getDb } from '../db/client.js';
import { loadContext, SESSION_COOKIE } from '../lib/auth.js';
import { runAction, verifyChain } from '../lib/events.js';
import { ACTIONS, httpError } from '../actions/index.js';
import { tierFor } from '../lib/tiers.js';
import { emailConfigured, textConfigured } from '../lib/notify.js';
import { RECORD_TYPES } from '@starbase/shared/registry';
import { SOCIAL_PLATFORMS } from '@starbase/shared/canvass';
import dataRoutes from './data.js';
import { pointInPolygon, groupDoors, walkOrder } from '../lib/geo.js';
import { checkCap } from '../lib/cap.js';
import { EXTENSIONS } from '../ext.js';
import { runHooks } from '../lib/hooks.js';
import { forViewer, isMoneyTag, loginEmail } from '../lib/viewer.js';
// Which saved newsletter / press rows Try again would reach (ext/abtests).
import { goingRow, retryable, sendJobOn } from '../ext/abtests/send.js';

// A date column as YYYY-MM-DD (both backends hand back a Date at UTC midnight).
const dateOnly = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

const app = new Hono();

// Auth + context middleware.
app.use('*', async (c, next) => {
  const db = await getDb();
  const ctx = await loadContext(db, getCookie(c, SESSION_COOKIE));
  if (!ctx) return c.json({ error: 'not signed in' }, 401);
  // Public base URL for links in outbound mail (unsubscribe, petitions).
  ctx.publicUrl = (process.env.STARBASE_PUBLIC_URL || new URL(c.req.url).origin).replace(/\/$/, '');
  c.set('db', db);
  c.set('ctx', ctx);
  await next();
});

// '/surveys/:id/results' → /^\/api\/surveys\/[^/]+\/results$/ (a RegExp passes through).
const pathPattern = (p) => (p instanceof RegExp ? p : new RegExp(`^/api${p
  .split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&'))).join('/')}$`));

// Volunteers canvass, phone, and place signs; they never see money, the
// subscriber/signature lists, the raw event log, the campaign-wide contact
// feed (who knocked whom, with notes), or bulk exports.
const DESK_ONLY_READS = [
  /^\/api\/records\//, /^\/api\/export$/, /^\/api\/events$/, /^\/api\/audit\/verify$/,
  /^\/api\/subscriptions$/, /^\/api\/blasts$/, /^\/api\/petitions\/[^/]+\/signatures$/,
  /^\/api\/pledges$/, /^\/api\/campaign-events\/[^/]+\/rsvps$/, /^\/api\/members$/,
  /^\/api\/contacts$/, /^\/api\/shifts\/board$/,
  // Feature modules name their own desk-only reads (paths under /api).
  ...EXTENSIONS.flatMap((e) => (e.deskOnlyReads || []).map(pathPattern)),
];

// What a volunteer's browser may receive about a person (lib/viewer.js):
// phone and address, never anyone else's email, never a money tag. Applied
// to every person row a volunteer reads: /persons, /persons/:id, /map/doors
// and /turfs/:id/walk (and the features' own person rows, "My people").
app.use('*', async (c, next) => {
  if (c.get('ctx').role === 'volunteer' && c.req.method === 'GET'
      && DESK_ONLY_READS.some((re) => re.test(c.req.path))) {
    return c.json({ error: 'volunteers cannot view this' }, 403);
  }
  await next();
});

// Path ids are uuids; anything else is simply not found (not a 500).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badId = (c) => !UUID_RE.test(c.req.param('id') || '');

// ── Actions: the only write path ──
app.post('/actions/:name', async (c) => {
  const name = c.req.param('name');
  const action = ACTIONS[name];
  if (!action) return c.json({ error: `unknown action '${name}'` }, 404);
  const ctx = c.get('ctx');
  if (!action.roles.includes(ctx.role)) {
    return c.json({ error: `role '${ctx.role}' may not perform ${name}` }, 403);
  }
  const parsed = action.input.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return c.json({ error: `${i.path.join('.') || 'input'}: ${i.message}` }, 400);
  }
  try {
    const { result, lastSeq } = await runAction(
      c.get('db'),
      { workspaceId: ctx.workspaceId, actorId: ctx.user.id, action: name },
      (tx, emit) => action.handler(tx, ctx, parsed.data, emit),
    );
    if (!action.after) return c.json({ ...result, seq: lastSeq });
    // Committed: now the work that must never hold the campaign lock (an
    // email send). Its writes are runActions of their own.
    const done = await action.after(c.get('db'), ctx, result);
    return c.json({ ...done.result, seq: done.lastSeq ?? lastSeq });
  } catch (e) {
    if (e.status) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

app.get('/actions', (c) => {
  const ctx = c.get('ctx');
  const names = Object.entries(ACTIONS)
    .filter(([, a]) => a.roles.includes(ctx.role))
    .map(([name]) => name);
  return c.json({ actions: names });
});

// ── Persons: search (picker), filters (tag / rating / role / has), map, profile ──
const parseJson = (v, fallback) => (typeof v === 'string' ? JSON.parse(v) : (v ?? fallback));
const personRow = (r) => ({
  ...r,
  tags: parseJson(r.tags, []),
  socials: parseJson(r.socials, {}),
});

app.get('/persons', async (c) => {
  const ctx = c.get('ctx');
  const vol = ctx.role === 'volunteer';
  const q = (c.req.query('q') || '').trim();
  const tag = (c.req.query('tag') || '').trim();
  const rating = (c.req.query('rating') || '').trim();
  const role = (c.req.query('role') || '').trim();
  const has = (c.req.query('has') || '').trim();       // phone | email | location | a social platform
  const limit = Math.min(Number(c.req.query('limit')) || 25, 2000);
  const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
  const params = [ctx.workspaceId, q, like, limit];
  // A volunteer's search, tag and has=email filters never match on what they
  // may not see — otherwise the result set itself would tell them who has
  // which email, or who is a donor. Their own email still finds their own
  // record (Shifts and Today look themselves up that way).
  if (vol) params.push(loginEmail(ctx));
  const ownEmail = `($5::text <> '' and lower(p.email) = $5::text)`;
  // A social handle matches with or without its @ (or Reddit's u/).
  params.push(`%${q.replace(/^@|^\/?u\//i, '').replace(/[%_\\]/g, (m) => '\\' + m)}%`);
  const handleLike = `$${params.length}`;
  let where = `p.workspace_id = $1 and p.deleted_at is null
       and ($2 = '' or p.name ilike $3 or p.address ilike $3 or p.phone ilike $3
            or (p.email ilike $3${vol ? ` and ${ownEmail}` : ''})
            or exists (select 1 from jsonb_each_text(p.socials) s
                       where regexp_replace(s.value, '^@|^/?u/', '', 'i') ilike ${handleLike}))`;
  if (tag && vol && isMoneyTag(tag)) where += ' and false';
  else if (tag) { params.push(JSON.stringify(tag)); where += ` and p.tags @> $${params.length}::jsonb`; }
  // rating: one code (4B), a comma list for a band (1,2 · 4,4D,4B,4F,4N,4C),
  // and/or "unrated" (no rating yet). A band reaches every code on the
  // campaign's scale, those off the list too (ext/scale: up to 64).
  if (rating) {
    const codes = [...new Set(rating.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 80);
    const ors = [];
    for (const code of codes) {
      if (code === 'unrated') { ors.push('p.rating is null'); continue; }
      params.push(code);
      ors.push(`p.rating = $${params.length}`);
    }
    where += ors.length ? ` and (${ors.join(' or ')})` : ' and false';
  }
  if (role) {
    params.push(role);
    where += ` and exists (select 1 from volunteer_roles v where v.person_id = p.id and v.role = $${params.length})`;
  }
  if (has === 'phone') where += ' and p.phone is not null';
  if (has === 'email') where += vol ? ` and ${ownEmail}` : ' and p.email is not null';
  if (has === 'location') where += ' and p.lat is not null and p.lng is not null';
  if (SOCIAL_PLATFORMS.includes(has)) {
    params.push(has);
    where += ` and coalesce(trim(p.socials ->> $${params.length}), '') <> ''`;
  }
  // Features' own filters (?field= — ext/fields), on the same params.
  const more = { params, where: '' };
  await runHooks('personsWhere', c.get('db'), ctx, c.req.query(), more);
  where += more.where;
  // note: their own words from the volunteer form (attrs.note), so the call
  // card needs no per-person fetch. Nothing else from attrs is exposed.
  const { rows } = await c.get('db').query(
    `select p.id, p.kind, p.name, p.email, p.phone, p.address, p.unit, p.city, p.postal,
            p.lat, p.lng, p.tags, p.socials, p.rating, p.rated_at, p.attrs->>'note' as note
     from persons p where ${where}
     order by lower(p.name) limit $4`,
    params,
  );
  return c.json({ persons: rows.map(personRow).map(forViewer(ctx)) });
});

// Everything a door card needs, keyed by address: persons at that address,
// their ratings, and any signs. Only located persons (lat/lng set).
app.get('/map/doors', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const persons = (await db.query(
    `select id, name, phone, email, address, unit, lat, lng, rating, rated_at, tags
     from persons where workspace_id = $1 and deleted_at is null and lat is not null and lng is not null
     order by lower(address), lower(name) limit 5000`,
    [ctx.workspaceId],
  )).rows.map(personRow).map(forViewer(ctx));
  const signs = (await db.query(
    `select id, person_id, address, lat, lng, kind, status from signs
     where workspace_id = $1 and status <> 'removed'`,
    [ctx.workspaceId],
  )).rows;
  const unlocated = (await db.query(
    `select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and address is not null and lat is null`,
    [ctx.workspaceId],
  )).rows[0].n;
  return c.json({ persons, signs, unlocated });
});

app.get('/persons/:id', async (c) => {
  if (badId(c)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const person = (await db.query(
    `select id, kind, name, email, phone, address, unit, city, postal, lat, lng, tags, socials, rating, rated_at, created_at,
            attrs->>'note' as note
     from persons where id = $1 and workspace_id = $2 and deleted_at is null`,
    [c.req.param('id'), ctx.workspaceId],
  )).rows[0];
  if (!person) return c.json({ error: 'not found' }, 404);
  const gifts = (await db.query(
    `select id, amount_cents, date, method, cadence, note, flagged, flag_reason from gifts
     where workspace_id = $1 and person_id = $2 and deleted_at is null order by date desc limit 200`,
    [ctx.workspaceId, person.id],
  )).rows;
  const totals = (await db.query(
    `select extract(year from date)::int as year, sum(amount_cents)::bigint as total_cents
     from gifts where workspace_id = $1 and person_id = $2 and deleted_at is null
     group by 1 order by 1 desc`,
    [ctx.workspaceId, person.id],
  )).rows;
  const contacts = (await db.query(
    `select c.id, c.channel, c.outcome, c.rating, c.note, c.created_at, u.name as by_name
     from contacts c left join users u on u.id = c.created_by
     where c.workspace_id = $1 and c.person_id = $2 order by c.created_at desc limit 100`,
    [ctx.workspaceId, person.id],
  )).rows;
  const roles = (await db.query(
    'select id, role, detail from volunteer_roles where workspace_id = $1 and person_id = $2 order by role',
    [ctx.workspaceId, person.id],
  )).rows;
  const signs = (await db.query(
    'select id, kind, status, note, created_at from signs where workspace_id = $1 and person_id = $2 order by created_at desc',
    [ctx.workspaceId, person.id],
  )).rows;
  const shifts = (await db.query(
    `select a.id as assignment_id, a.status, s.id, s.title, s.starts_at, s.location
     from shift_assignments a join shifts s on s.id = a.shift_id
     where a.workspace_id = $1 and a.person_id = $2 and s.deleted_at is null order by s.starts_at desc limit 50`,
    [ctx.workspaceId, person.id],
  )).rows;
  const donor = await tierFor(db, ctx.workspaceId, person.id);
  const household = (await db.query(
    `select id, name, rating from persons
     where workspace_id = $1 and deleted_at is null and id <> $2 and address is not null
       and lower(address) = lower($3) and coalesce(unit, '') = coalesce($4, '')`,
    [ctx.workspaceId, person.id, person.address || '', person.unit || null],
  )).rows;
  if (ctx.role === 'volunteer') {
    return c.json({
      person: forViewer(ctx)(personRow(person)), gifts: [], totals: [], contacts, roles, signs, shifts, donor: null, household,
    });
  }
  return c.json({ person: personRow(person), gifts, totals, contacts, roles, signs, shifts, donor, household });
});

app.route('/data', dataRoutes); // import · geocode · sample (desk roles; own guard)

// ── Turfs + walk lists ──
const parseJ = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
// door_knocked: anyone ever knocked on this person's door (a 'door' contact),
// so a walk list can tell a door reached only by phone or text from a knock.
const loadLocated = async (db, ws) => (await db.query(
  `select p.id, p.name, p.email, p.phone, p.address, p.unit, p.lat, p.lng, p.rating, p.tags,
          (select max(c.created_at) from contacts c where c.person_id = p.id) as last_contact_at,
          (select c.outcome from contacts c where c.person_id = p.id order by c.created_at desc limit 1) as last_outcome,
          exists (select 1 from contacts c where c.person_id = p.id and c.channel = 'door') as door_knocked
   from persons p where p.workspace_id = $1 and p.deleted_at is null and p.lat is not null and p.lng is not null`,
  [ws],
)).rows.map((p) => ({ ...p, tags: parseJ(p.tags, []), door_knocked: !!p.door_knocked }));

// A door is done once someone there has been knocked (a 'door' contact, any
// outcome). A call or a text alone never finishes a door: the walk list still
// sends a canvasser there; the phone mark beside it is information only.
const doneDoor = (d) => d.persons.some((p) => p.door_knocked);

const turfStats = (polygon, located) => {
  const inside = located.filter((p) => pointInPolygon(p.lat, p.lng, polygon));
  const doors = groupDoors(inside);
  return {
    doors: doors.length,
    people: inside.length,
    doorsDone: doors.filter(doneDoor).length,
    rated: inside.filter((p) => p.rating).length,
  };
};

app.get('/turfs', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const desk = ctx.role !== 'volunteer';
  const turfs = (await db.query(
    desk
      ? 'select * from turfs where workspace_id = $1 and deleted_at is null order by created_at'
      : `select t.* from turfs t join turf_members m on m.turf_id = t.id and m.user_id = $2
         where t.workspace_id = $1 and t.deleted_at is null order by t.created_at`,
    desk ? [ctx.workspaceId] : [ctx.workspaceId, ctx.user.id],
  )).rows;
  const members = (await db.query(
    `select m.turf_id, u.id, u.name from turf_members m join users u on u.id = m.user_id where m.workspace_id = $1`,
    [ctx.workspaceId],
  )).rows;
  const located = await loadLocated(db, ctx.workspaceId);
  return c.json({
    turfs: turfs.map((t) => {
      const polygon = parseJ(t.polygon, []);
      return {
        id: t.id, name: t.name, color: t.color, notes: t.notes, polygon, created_at: t.created_at,
        members: members.filter((m) => m.turf_id === t.id).map(({ id, name }) => ({ id, name })),
        ...turfStats(polygon, located),
      };
    }),
  });
});

app.get('/turfs/:id/walk', async (c) => {
  if (badId(c)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const t = (await db.query('select * from turfs where id = $1 and workspace_id = $2 and deleted_at is null',
    [c.req.param('id'), ctx.workspaceId])).rows[0];
  if (!t) return c.json({ error: 'not found' }, 404);
  if (ctx.role === 'volunteer') {
    const mine = (await db.query('select 1 from turf_members where turf_id = $1 and user_id = $2', [t.id, ctx.user.id])).rows[0];
    if (!mine) return c.json({ error: 'this turf is not assigned to you' }, 403);
  }
  const polygon = parseJ(t.polygon, []);
  const located = await loadLocated(db, ctx.workspaceId);
  const doors = walkOrder(groupDoors(located.filter((p) => pointInPolygon(p.lat, p.lng, polygon))));
  const view = forViewer(ctx);
  // Each door's signs (requested or up), matched the way the map matches
  // them — by a person there, or by the address of a door with no unit — so
  // "Wants a sign?" never offers a kind the door already has.
  const signs = (await db.query(
    `select id, person_id, address, kind, status from signs where workspace_id = $1 and status <> 'removed'`,
    [ctx.workspaceId],
  )).rows;
  const signsAt = (d) => {
    const ids = new Set(d.persons.map((p) => p.id));
    const addr = !d.unit && d.address ? String(d.address).trim().toLowerCase() : null;
    return signs
      .filter((s) => (s.person_id ? ids.has(s.person_id) : addr && String(s.address || '').trim().toLowerCase() === addr))
      .map(({ id, kind, status }) => ({ id, kind, status }));
  };
  return c.json({
    turf: { id: t.id, name: t.name, color: t.color, notes: t.notes, polygon },
    doors: doors.map((d) => ({ ...d, persons: d.persons.map(view), signs: signsAt(d), done: doneDoor(d) })),
    stats: turfStats(polygon, located),
  });
});

// Team members for assignment pickers (desk roles; /team stays manager-only).
app.get('/members', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select u.id, u.name, m.role from memberships m join users u on u.id = m.user_id
     where m.workspace_id = $1 order by u.name`, [ctx.workspaceId],
  );
  return c.json({ members: rows });
});

// ── Campaign events + RSVPs ──
app.get('/campaign-events', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select e.*,
       coalesce((select sum(1 + r.guests) from event_rsvps r where r.event_id = e.id and r.status <> 'cancelled'), 0)::int as going,
       coalesce((select count(*) from event_rsvps r where r.event_id = e.id and r.status = 'attended'), 0)::int as attended
     from campaign_events e where e.workspace_id = $1 and e.deleted_at is null order by e.starts_at`,
    [ctx.workspaceId],
  );
  return c.json({ events: rows, slug: ctx.workspace.slug });
});

app.get('/campaign-events/:id/rsvps', async (c) => {
  if (badId(c)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select id, person_id, name, email, phone, guests, status, created_at from event_rsvps
     where workspace_id = $1 and event_id = $2 order by created_at`,
    [ctx.workspaceId, c.req.param('id')],
  );
  return c.json({ rsvps: rows });
});

// ── Pledges (money roles) ──
// last_received_on (YYYY-MM-DD or null): the date of the latest gift received
// for a monthly pledge — it stays open between months.
app.get('/pledges', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select id, person_id, name, email, phone, address, amount_cents, cadence, status, gift_id, stripe_session_id, created_at,
            to_char(last_received_on, 'YYYY-MM-DD') as last_received_on
     from pledges where workspace_id = $1 order by created_at desc limit 500`,
    [ctx.workspaceId],
  );
  return c.json({ pledges: rows, slug: ctx.workspace.slug, stripe: !!process.env.STRIPE_SECRET_KEY });
});

// ── Team (managers) ──
app.get('/team', async (c) => {
  const ctx = c.get('ctx');
  if (ctx.role !== 'manager') return c.json({ error: 'managers only' }, 403);
  const db = c.get('db');
  const members = (await db.query(
    `select u.id, u.name, u.email, m.role, m.created_at from memberships m join users u on u.id = m.user_id
     where m.workspace_id = $1 order by m.created_at`,
    [ctx.workspaceId],
  )).rows;
  const invites = (await db.query(
    `select id, email, role, created_at, expires_at from invites
     where workspace_id = $1 and accepted_at is null and expires_at > now() order by created_at desc`,
    [ctx.workspaceId],
  )).rows;
  return c.json({ members, invites });
});

// ── Field reads ──
app.get('/signs', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select s.*, p.name as person_name from signs s left join persons p on p.id = s.person_id
     where s.workspace_id = $1 order by s.status, s.created_at desc limit 1000`,
    [ctx.workspaceId],
  );
  return c.json({ signs: rows });
});

app.get('/contacts', async (c) => {
  const ctx = c.get('ctx');
  const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
  const { rows } = await c.get('db').query(
    `select c.id, c.person_id, p.name as person_name, c.channel, c.outcome, c.rating, c.note, c.created_at, u.name as by_name
     from contacts c join persons p on p.id = c.person_id left join users u on u.id = c.created_by
     where c.workspace_id = $1 order by c.created_at desc limit $2`,
    [ctx.workspaceId, limit],
  );
  return c.json({ contacts: rows });
});

// mine: the caller's own supporter record — the person whose email is their
// login email — is actively on shift s (assigned or confirmed). $2 is that
// email, lower-cased; '' (no email) is never anyone.
const MINE_ON_SHIFT = `exists (
  select 1 from shift_assignments a join persons p on p.id = a.person_id
  where a.shift_id = s.id and a.workspace_id = s.workspace_id and a.status in ('assigned', 'confirmed')
    and p.deleted_at is null and $2::text <> '' and lower(p.email) = $2::text)`;

app.get('/shifts', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select s.*,
            (select count(*)::int from shift_assignments a where a.shift_id = s.id and a.status in ('assigned', 'confirmed')) as filled,
            ${MINE_ON_SHIFT} as mine
     from shifts s where s.workspace_id = $1 and s.deleted_at is null
     order by s.starts_at limit 500`,
    [ctx.workspaceId, loginEmail(ctx)],
  );
  return c.json({ shifts: rows.map((s) => ({ ...s, mine: !!s.mine })) });
});

// The desk's week board: every shift starting in [from, to) with who's on
// it (assigned or confirmed — names only), and the people to drag in:
// anyone holding a volunteer role or signed in as a volunteer (matched by
// email). The client sorts shifts into Morning / Afternoon / Evening
// (shared/dayparts.js). At most 15 days per read.
app.get('/shifts/board', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const from = new Date(c.req.query('from') || '');
  const to = new Date(c.req.query('to') || '');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to - from > 15 * 864e5) {
    return c.json({ error: 'from and to: a week, as timestamps' }, 400);
  }
  const shifts = (await db.query(
    `select s.id, s.title, s.role, s.location, s.starts_at, s.ends_at, s.capacity,
            (select count(*)::int from shift_assignments a where a.shift_id = s.id and a.status in ('assigned', 'confirmed')) as filled
     from shifts s where s.workspace_id = $1 and s.deleted_at is null and s.starts_at >= $2 and s.starts_at < $3
     order by s.starts_at, s.title limit 500`,
    [ctx.workspaceId, from.toISOString(), to.toISOString()],
  )).rows;
  const ids = shifts.map((s) => s.id);
  const assignments = ids.length ? (await db.query(
    `select a.id, a.shift_id, a.person_id, a.status, p.name
     from shift_assignments a join persons p on p.id = a.person_id
     where a.workspace_id = $1 and a.shift_id = any($2::uuid[]) and a.status in ('assigned', 'confirmed')
     order by lower(p.name)`,
    [ctx.workspaceId, ids],
  )).rows : [];
  const people = (await db.query(
    `select p.id, p.name,
            coalesce((select json_agg(distinct v.role) from volunteer_roles v
                      where v.person_id = p.id and v.workspace_id = p.workspace_id), '[]'::json) as roles
     from persons p
     where p.workspace_id = $1 and p.deleted_at is null and (
       exists (select 1 from volunteer_roles v where v.person_id = p.id and v.workspace_id = p.workspace_id)
       or exists (select 1 from memberships m join users u on u.id = m.user_id
                  where m.workspace_id = p.workspace_id and m.role = 'volunteer'
                    and p.email is not null and lower(u.email) = lower(p.email)))
     order by lower(p.name) limit 1000`,
    [ctx.workspaceId],
  )).rows.map((p) => ({ ...p, roles: typeof p.roles === 'string' ? JSON.parse(p.roles) : p.roles }));
  return c.json({ shifts, assignments, people });
});

app.get('/shifts/:id', async (c) => {
  if (badId(c)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const db = c.get('db');
  const shift = (await db.query(
    'select * from shifts where id = $1 and workspace_id = $2 and deleted_at is null',
    [c.req.param('id'), ctx.workspaceId],
  )).rows[0];
  if (!shift) return c.json({ error: 'not found' }, 404);
  const myEmail = String(ctx.user.email || '').toLowerCase();
  const assignees = (await db.query(
    `select a.id as assignment_id, a.status, a.notified_at, a.notify_email, a.notify_text,
            p.id, p.name, p.email, p.phone, (lower(p.email) = $3) as is_me
     from shift_assignments a join persons p on p.id = a.person_id
     where a.shift_id = $1 and a.workspace_id = $2 order by p.name`,
    [shift.id, ctx.workspaceId, myEmail],
  )).rows.map((a) => ({ ...a, is_me: !!a.is_me }));
  // Volunteers see who else is on the shift, not how to reach them.
  if (ctx.role === 'volunteer') {
    return c.json({
      shift,
      assignees: assignees.map((a) => (a.is_me ? a : { ...a, email: null, phone: null, notify_email: null, notify_text: null })),
    });
  }
  return c.json({ shift, assignees });
});

app.get('/petitions', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select p.*, (select count(*)::int from petition_signatures s where s.petition_id = p.id) as signatures
     from petitions p where p.workspace_id = $1 order by p.created_at desc`,
    [ctx.workspaceId],
  );
  return c.json({ petitions: rows, slug: ctx.workspace.slug });
});

app.get('/petitions/:id/signatures', async (c) => {
  if (badId(c)) return c.json({ error: 'not found' }, 404);
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select id, name, email, phone, address, subscribe, created_at from petition_signatures
     where workspace_id = $1 and petition_id = $2 order by created_at desc limit 2000`,
    [ctx.workspaceId, c.req.param('id')],
  );
  return c.json({ signatures: rows });
});

app.get('/subscriptions', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select id, email, name, status, source, created_at, unsubscribed_at from subscriptions
     where workspace_id = $1 order by created_at desc limit 5000`,
    [ctx.workspaceId],
  );
  return c.json({
    subscriptions: rows,
    subscribed: rows.filter((r) => r.status === 'subscribed').length,
    unsubscribed: rows.filter((r) => r.status === 'unsubscribed').length,
    slug: ctx.workspace.slug,
  });
});

// Each send carries its recipients by status, so the screen can say exactly
// how many were sent, failed, and are still waiting. queued_count for a
// newsletter counts only addresses still subscribed — the ones Send now
// would actually email (blast.resend drops the rest); retry_count is the
// same for Try again (failed + queued, still subscribed, plus any the email
// service never answered for in 10 minutes). failed_count stays the plain
// record of what happened; sending_count is "not sure it went". going_count:
// on their way now — a send job is carrying the send on (ext/abtests
// send.js goingRow); those are never "not sent" and not in retry_count.
app.get('/blasts', async (c) => {
  const ctx = c.get('ctx');
  const { rows } = await c.get('db').query(
    `select b.id, b.kind, b.subject, b.status, b.provider_note, b.audience_count, b.sent_at, b.created_at,
            k.sent_count, k.failed_count, k.queued_count, k.retry_count, k.sending_count, k.going_count
     from blasts b
     cross join lateral (select ${sendJobOn('b.id', 'b.workspace_id')} as job_on) j
     cross join lateral (
       select (count(*) filter (where r.status = 'sent'))::int as sent_count,
              (count(*) filter (where r.status = 'failed'))::int as failed_count,
              (count(*) filter (where r.status = 'queued' and l.live))::int as queued_count,
              (count(*) filter (where ${retryable('r')} and l.live and not (j.job_on and ${goingRow('r')})))::int as retry_count,
              (count(*) filter (where r.status = 'sending'))::int as sending_count,
              (count(*) filter (where j.job_on and ${goingRow('r')} and l.live))::int as going_count
       from blast_recipients r
       cross join lateral (
         select (b.kind <> 'newsletter' or exists (
           select 1 from subscriptions s
           where s.workspace_id = b.workspace_id and lower(s.email) = lower(r.email) and s.status = 'subscribed')) as live
       ) l
       where r.workspace_id = b.workspace_id and r.blast_id = b.id
     ) k
     where b.workspace_id = $1 order by b.created_at desc limit 200`,
    [ctx.workspaceId],
  );
  const media = (await c.get('db').query(
    `select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null and email is not null and tags @> '"media"'::jsonb`,
    [ctx.workspaceId],
  )).rows[0].n;
  return c.json({ blasts: rows, mediaContacts: media, emailConfigured: emailConfigured() });
});

// ── Records: generic cursor-paginated reads per registry type ──
app.get('/records/:type', async (c) => {
  const type = c.req.param('type');
  const t = RECORD_TYPES[type];
  if (!t) return c.json({ error: `unknown record type '${type}'` }, 404);
  const ctx = c.get('ctx');
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
  const cursor = c.req.query('cursor') || null; // created_at|id tuple cursor
  const params = [ctx.workspaceId, limit];
  let where = 'workspace_id = $1 and deleted_at is null';
  if (cursor) {
    const [ts, id] = cursor.split('~');
    params.push(ts, id);
    where += ` and (created_at, id) < ($3::timestamptz, $4::uuid)`;
  }
  // Gifts carry the donor's name so the ledger needs no per-row lookups.
  const select = type === 'gift'
    ? `select g.*, p.name as person_name from gifts g left join persons p on p.id = g.person_id
       where ${where.replace(/\b(workspace_id|deleted_at|created_at|id)\b/g, 'g.$1')}
       order by g.created_at desc, g.id desc limit $2`
    : `select * from ${t.table} where ${where} order by created_at desc, id desc limit $2`;
  const { rows } = await c.get('db').query(select, params);
  const next = rows.length === limit
    ? `${new Date(rows[rows.length - 1].created_at).toISOString()}~${rows[rows.length - 1].id}`
    : null;
  return c.json({ records: rows, next });
});

// ── Events: the sync protocol / public API ──
app.get('/events', async (c) => {
  const ctx = c.get('ctx');
  const since = Number(c.req.query('since') || 0);
  const limit = Math.min(Number(c.req.query('limit')) || 200, 1000);
  const { rows } = await c.get('db').query(
    `select seq, action, entity_type, entity_id, op, payload, actor_id, server_ts, hash
     from events where workspace_id = $1 and seq > $2 order by seq limit $3`,
    [ctx.workspaceId, since, limit],
  );
  return c.json({ events: rows, cursor: rows.length ? Number(rows[rows.length - 1].seq) : since });
});

// ── Audit: verify my books ──
app.get('/audit/verify', async (c) => {
  const ctx = c.get('ctx');
  return c.json(await verifyChain(c.get('db'), ctx.workspaceId));
});

// ── Brief: Today, composed server-side ──
app.get('/brief', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const money = (await db.query(
    `select coalesce(sum(amount_cents), 0)::bigint as total,
            coalesce(sum(amount_cents) filter (where date >= current_date - 7), 0)::bigint as week,
            count(*)::int as gifts
     from gifts where workspace_id = $1 and deleted_at is null`, [ws],
  )).rows[0];
  const flagged = (await db.query(
    `select g.id, g.person_id, g.amount_cents, g.date, g.flag_reason, p.name as donor
     from gifts g join persons p on p.id = g.person_id
     where g.workspace_id = $1 and g.deleted_at is null and g.flagged order by g.date desc limit 10`, [ws],
  )).rows;
  // Each flagged gift carries the donor's total for that gift's year (as it
  // stands now, voids excluded) and the cap — from the same engine that
  // flagged it — so the desk shows "$150 over the $1,250 limit" without
  // parsing flag_reason. Null when no cap rule is known for that year.
  if (ctx.role !== 'volunteer') {
    for (const g of flagged) {
      const cap = await checkCap(db, {
        workspaceId: ws, personId: g.person_id, date: dateOnly(g.date),
        jurisdiction: ctx.workspace.jurisdiction, settings: ctx.workspace.settings || {},
      });
      g.total_cents = cap.checked ? Number(cap.totalCents) : null;
      g.cap_cents = cap.checked ? Number(cap.capCents) : null;
    }
  }
  const filings = (await db.query(
    `select id, name, due_date, status, (due_date - current_date)::int as days_left
     from filings where workspace_id = $1 and deleted_at is null and status = 'upcoming'
     order by due_date limit 5`, [ws],
  )).rows;
  const people = (await db.query(
    `select count(*)::int as total from persons where workspace_id = $1 and deleted_at is null`, [ws],
  )).rows[0];
  // Field, over the last 7 days (rolling): doors are DISTINCT doors knocked —
  // a household rated twice, or a rating changed, is still one door; the key
  // is the address + unit (the walk list's grouping), or the person when they
  // have no address. Calls and texts count contacts (texts sent through the
  // app are added by the texting feature's brief hook). mine: the same
  // counts over the contacts the caller logged; week: every contact.
  const field = (await db.query(
    `select count(*)::int as week,
            count(distinct w.door) filter (where w.channel = 'door')::int as doors,
            count(*) filter (where w.channel = 'phone')::int as calls,
            count(*) filter (where w.channel = 'text')::int as texts,
            count(distinct w.door) filter (where w.channel = 'door' and w.created_by = $2)::int as my_doors,
            count(*) filter (where w.channel = 'phone' and w.created_by = $2)::int as my_calls,
            count(*) filter (where w.channel = 'text' and w.created_by = $2)::int as my_texts
     from (
       select c.channel, c.created_by,
              case when nullif(trim(p.address), '') is null then p.id::text
                   else lower(trim(p.address)) || '|' || lower(trim(coalesce(p.unit, ''))) end as door
       from contacts c join persons p on p.id = c.person_id
       where c.workspace_id = $1 and c.created_at >= now() - interval '7 days'
     ) w`, [ws, ctx.user.id],
  )).rows[0];
  const ratings = (await db.query(
    `select rating, count(*)::int as n from persons
     where workspace_id = $1 and deleted_at is null and rating is not null group by rating`, [ws],
  )).rows;
  const shifts = (await db.query(
    `select s.id, s.title, s.starts_at, s.location, s.capacity,
            (select count(*)::int from shift_assignments a where a.shift_id = s.id and a.status in ('assigned', 'confirmed')) as filled,
            ${MINE_ON_SHIFT} as mine
     from shifts s where s.workspace_id = $1 and s.deleted_at is null and s.starts_at >= now()
     order by s.starts_at limit 5`, [ws, loginEmail(ctx)],
  )).rows.map((s) => ({ ...s, mine: !!s.mine }));
  const signs = (await db.query(
    `select status, count(*)::int as n from signs where workspace_id = $1 group by status`, [ws],
  )).rows;
  const events = (await db.query(
    `select e.id, e.slug, e.title, e.starts_at, e.location, e.capacity, e.public,
       coalesce((select sum(1 + r.guests) from event_rsvps r where r.event_id = e.id and r.status <> 'cancelled'), 0)::int as going
     from campaign_events e where e.workspace_id = $1 and e.deleted_at is null and e.starts_at >= now()
     order by e.starts_at limit 3`, [ws],
  )).rows;
  const myTurfs = (await db.query(
    `select t.id, t.name from turfs t join turf_members m on m.turf_id = t.id and m.user_id = $2
     where t.workspace_id = $1 and t.deleted_at is null order by t.created_at`, [ws, ctx.user.id],
  )).rows;
  // Open pledges: one-time pledges not yet received, plus monthly pledges not
  // yet received this calendar month (campaign time) — a monthly pledge stays
  // open between months.
  const openPledges = (await db.query(
    `select count(*)::int as n, coalesce(sum(amount_cents), 0)::int as cents from pledges
     where workspace_id = $1 and status in ('pledged', 'pending')
       and not (cadence = 'monthly' and last_received_on is not null
                and last_received_on >= date_trunc('month', now() at time zone $2::text)::date)`,
    [ws, ctx.workspace.settings?.tz || 'America/Vancouver'],
  )).rows[0];
  const sampleLoaded = !!(ctx.workspace.settings?.sample);
  const desk = ctx.role !== 'volunteer';
  // The desk's first steps. One of them is whether a gift was ever logged,
  // so — like money, filings and pledges — a volunteer never receives it.
  let activation = null;
  if (desk) {
    activation = {
      steps: [
        { key: 'person', label: 'Add your first person', done: people.total > 0 },
        { key: 'gift', label: 'Log your first gift', done: Number(money.gifts) > 0 },
        { key: 'filing', label: 'Add a filing deadline', done: (await db.query(
          'select count(*)::int as n from filings where workspace_id = $1', [ws],
        )).rows[0].n > 0 },
      ],
    };
    activation.complete = activation.steps.every((s) => s.done);
  }
  const body = {
    money: desk ? { totalCents: Number(money.total), weekCents: Number(money.week), gifts: Number(money.gifts) } : null,
    flagged: desk ? flagged : [],
    filings: desk ? filings : [],
    people,
    field: {
      week: field.week, doors: field.doors, calls: field.calls, texts: field.texts,
      mine: { doors: field.my_doors, calls: field.my_calls, texts: field.my_texts },
    },
    ratings: Object.fromEntries(ratings.map((r) => [r.rating, r.n])),
    shifts,
    signs: Object.fromEntries(signs.map((r) => [r.status, r.n])),
    events,
    myTurfs,
    pledges: desk ? openPledges : null,
    sampleLoaded,
    providers: { email: emailConfigured(), text: textConfigured() },
    activation,
    generatedAt: new Date().toISOString(),
  };
  // Features correct the counts they own (texts sent through the app).
  await runHooks('brief', db, ctx, body);
  return c.json(body);
});

// ── Export: contractual open data — everything, one click ──
// Every campaign table, as rows: the core's below, the record types, and
// each feature's own (exportTables). Never sign-ins, sessions or invites, and
// never a link's secret token (omit).
const CORE_EXPORT = [
  'contacts', 'signs', 'volunteer_roles', 'shifts', 'shift_assignments', 'turfs', 'turf_members',
  'petitions', 'petition_signatures', 'subscriptions', 'blasts', { table: 'blast_recipients', omit: ['token'] },
  'campaign_events', 'event_rsvps', 'pledges',
];
const exportSpec = (spec) => (typeof spec === 'string' ? { table: spec, omit: [] } : { omit: [], ...spec });
app.get('/export', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const out = {
    format: 'starbase-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    workspace: ctx.workspace,
    persons: (await db.query('select * from persons where workspace_id = $1', [ws])).rows,
    events: (await db.query('select * from events where workspace_id = $1 order by seq', [ws])).rows,
  };
  for (const t of Object.values(RECORD_TYPES)) {
    out[t.table] = (await db.query(`select * from ${t.table} where workspace_id = $1`, [ws])).rows;
  }
  for (const spec of [...CORE_EXPORT, ...EXTENSIONS.flatMap((e) => e.exportTables || [])]) {
    const { table, omit } = exportSpec(spec);
    const rows = (await db.query(`select * from ${table} where workspace_id = $1`, [ws])).rows;
    out[table] = omit.length
      ? rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !omit.includes(k))))
      : rows;
  }
  c.header('Content-Disposition', 'attachment; filename="starbase-export.json"');
  return c.json(out);
});

// Feature modules' signed-in routes, behind the same auth and volunteer guard.
for (const e of EXTENSIONS) if (e.api) app.route('/', e.api);

export default app;
export { httpError };
