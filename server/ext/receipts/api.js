// Receipts reads (signed in; mounted under /api). Money roles only — and
// volunteers are refused every path here by deskOnlyReads before a handler
// runs, so nothing about receipts ever reaches their browser.
//   GET /receipts                  the list, settings, counts, email on/off, periods
//   GET /receipts/needs            receipts waiting for a home address (Money → Needs you)
//   GET /receipts/gift/:giftId     the receipt line under a gift on Money
//   GET /receipts/:id              one receipt, as printed, + the donor link
//   GET /receipts/disclosure.csv   contributors over the disclosure amount, for
//                                  one period (?period=campaign | 2025) (manager/treasurer)
//   GET /receipts/register.csv     every receipt, in number order (manager/treasurer)
// The sample campaign's gifts never reach the filing exports.
import { Hono } from 'hono';
import { emailConfigured } from '../../lib/notify.js';
import { capFor } from '../../lib/cap.js';
import {
  MONEY_ROLES, AGENT_ROLES, loadSettings, statusOf, docOf, campaignName, linkFor, addressOf, isoDay, methodWord,
  canSendOf, canSendVoidOf, wasEmailed, periodOf, SEND_ALL_MAX, NOT_FOR_SEND_ALL,
} from './core.js';

export const api = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tzOf = (ctx) => ctx.workspace?.settings?.tz || 'America/Vancouver';

const deskOnly = async (c, next) => {
  if (!MONEY_ROLES.includes(c.get('ctx').role)) return c.json({ error: 'volunteers cannot view this' }, 403);
  await next();
};
api.use('/receipts', deskOnly);
api.use('/receipts/*', deskOnly);
// The filing exports: the financial agent's people only.
const agentOnly = (c) => (AGENT_ROLES.includes(c.get('ctx').role) ? null : c.json({ error: 'managers and treasurers only' }, 403));

const ROW = `r.id, r.number, r.series, r.seq, r.gift_id, r.person_id, r.donor_name, r.donor_address, r.amount_cents,
  r.received_on, r.method, r.sample, r.voided_at, r.email_status, r.sent_at, r.sent_count, r.token, r.created_at,
  r.updated_at, r.void_sent_at, r.void_sent_count,
  p.address as p_address, p.unit as p_unit, p.city as p_city, p.postal as p_postal,
  (nullif(trim(p.email), '') is not null) as has_email`;

// The home address a Send would print now: the donor's record, else the
// receipt's own (a donate-page pledge's).
const hasAddressOf = (r) => !!(addressOf({ address: r.p_address, unit: r.p_unit, city: r.p_city, postal: r.p_postal })
  || String(r.donor_address || '').trim());
const live = (r) => !r.voided_at && !r.sample;

const shape = (r, ctx) => {
  const flags = { emailOn: emailConfigured(), hasEmail: !!r.has_email, hasAddress: hasAddressOf(r) };
  return {
    id: r.id,
    number: r.number,
    gift_id: r.gift_id,
    person_id: r.person_id,
    donor_name: r.donor_name,
    amount_cents: Number(r.amount_cents),
    received_on: isoDay(r.received_on),
    method: r.method || null,
    sample: !!r.sample,
    void: !!r.voided_at,
    sent_at: r.sent_at || null,
    sent_count: Number(r.sent_count || 0),
    has_email: !!r.has_email,
    // No home address on this receipt (Money → Needs you, the "Needs address" chip).
    needs_address: live(r) && !String(r.donor_address || '').trim(),
    // The donor may hold it (sent, or with the provider when last heard of).
    emailed: wasEmailed(r),
    void_notice_sent: !!r.void_sent_at,
    can_send: canSendOf(r, flags),
    can_send_void: canSendVoidOf(r, flags) && !r.void_sent_at,
    status: statusOf(r, { emailOn: flags.emailOn, hasEmail: flags.hasEmail, timeZone: tzOf(ctx) }),
  };
};

// The sample campaign's gifts (named when it was loaded); their receipts are
// marked sample too. Neither is ever filed.
const sampleGiftIds = (ctx) => {
  const ids = ctx.workspace?.settings?.sample?.ids?.gifts;
  return Array.isArray(ids) ? ids.filter((v) => UUID_RE.test(String(v))) : [];
};

api.get('/receipts', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const settings = await loadSettings(db, ctx.workspaceId);
  const rows = (await db.query(
    `select ${ROW} from receipts r left join persons p on p.id = r.person_id
     where r.workspace_id = $1 order by r.created_at desc, r.seq desc limit 2000`,
    [ctx.workspaceId],
  )).rows;
  // Not sent yet and ready to go: an email and a home address on file, and
  // not already on its way (one that says Sending is left to go by itself).
  const unsent = rows.filter((r) => live(r) && r.has_email && hasAddressOf(r) && !NOT_FOR_SEND_ALL.includes(r.email_status));
  const years = (await db.query(
    `select distinct extract(year from date)::int as y from gifts
     where workspace_id = $1 and deleted_at is null and not (id = any($2::uuid[])) order by 1 desc`,
    [ctx.workspaceId, sampleGiftIds(ctx)],
  )).rows.map((r) => String(r.y));
  return c.json({
    receipts: rows.map((r) => shape(r, ctx)),
    settings,
    emailConfigured: emailConfigured(),
    canManage: AGENT_ROLES.includes(ctx.role),
    // sendable: what one Send all emails now (its button says this number).
    counts: { total: rows.length, unsent: unsent.length, sendable: emailConfigured() ? Math.min(unsent.length, SEND_ALL_MAX) : 0 },
    // The disclosure's periods: the campaign's, then each calendar year with gifts.
    periods: [periodOf('campaign', settings, tzOf(ctx)), ...years.map((y) => periodOf(y, settings, tzOf(ctx)))],
    sampleLoaded: !!ctx.workspace?.settings?.sample,
  });
});

// Receipts waiting for the donor's home address (live, real, none on file).
api.get('/receipts/needs', async (c) => {
  const ctx = c.get('ctx');
  const db = c.get('db');
  const rows = (await db.query(
    `select ${ROW} from receipts r left join persons p on p.id = r.person_id
     where r.workspace_id = $1 and r.voided_at is null and not r.sample
       and nullif(trim(r.donor_address), '') is null and nullif(trim(p.address), '') is null
     order by r.created_at desc limit 51`,
    [ctx.workspaceId],
  )).rows;
  return c.json({ receipts: rows.slice(0, 50).map((r) => shape(r, ctx)), more: rows.length > 50 });
});

api.get('/receipts/disclosure.csv', async (c) => {
  const no = agentOnly(c);
  if (no) return no;
  const ctx = c.get('ctx');
  const db = c.get('db');
  const settings = await loadSettings(db, ctx.workspaceId);
  const period = periodOf(c.req.query('period') || 'campaign', settings, tzOf(ctx));
  const samples = sampleGiftIds(ctx);
  // Every live gift in the period (voids and the sample campaign excluded),
  // keyed by donor — never by name.
  const rows = (await db.query(
    `select g.id, g.person_id, g.date, g.amount_cents, p.name, p.address, p.unit, p.city, p.postal,
            r.number, r.donor_address
     from gifts g join persons p on p.id = g.person_id
     left join receipts r on r.workspace_id = g.workspace_id and r.gift_id = g.id
     where g.workspace_id = $1 and g.deleted_at is null
       and g.date >= $2::date and g.date <= $3::date
       and not coalesce(r.sample, false) and not (g.id = any($4::uuid[]))
     order by g.date, g.created_at`,
    [ctx.workspaceId, period.from, period.to, samples],
  )).rows;
  const groups = new Map();
  for (const g of rows) {
    const k = g.person_id;
    if (!groups.has(k)) groups.set(k, { id: k, name: g.name, address: addressOf(g), gifts: [], total: 0 });
    const grp = groups.get(k);
    grp.gifts.push(g);
    grp.total += Number(g.amount_cents);
    if (!grp.address && g.donor_address) grp.address = g.donor_address;
  }
  // Contributors A–Z (plain character order, the same on every database),
  // each one's contributions oldest first.
  const key = (grp) => `${String(grp.name || '').toLowerCase()}\u0000${grp.id}`;
  const sorted = [...groups.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .filter((grp) => grp.total > settings.disclosure_cents);
  const over = await overLimit(db, ctx, sorted, samples);
  const lines = [
    ['Period', period.label, `${period.from} to ${period.to}`],
    ['Contributor', 'Home address', 'Contributor total', 'Over limit', 'Date received', 'Amount', 'Receipt'],
  ];
  for (const grp of sorted) {
    for (const g of grp.gifts) {
      lines.push([grp.name, grp.address || '', dollars(grp.total), over.get(grp.id) ?? '', isoDay(g.date), dollars(g.amount_cents), g.number || '']);
    }
  }
  const span = period.key === 'campaign' ? `campaign-${period.from}-to-${period.to}` : period.key;
  return csv(c, `disclosure-over-${Math.round(settings.disclosure_cents / 100)}-${span}.csv`, lines);
});

// "Yes" when a contributor's year total (every live gift that calendar year,
// as Money counts it) is over that year's contribution limit, "No" when not,
// blank when no limit is known for the year.
const overLimit = async (db, ctx, groups, samples) => {
  const out = new Map();
  if (!groups.length) return out;
  const totals = new Map((await db.query(
    `select person_id, extract(year from date)::int as y, sum(amount_cents)::bigint as total from gifts
     where workspace_id = $1 and deleted_at is null and person_id = any($2::uuid[]) and not (id = any($3::uuid[]))
     group by 1, 2`,
    [ctx.workspaceId, groups.map((g) => g.id), samples],
  )).rows.map((r) => [`${r.person_id}|${r.y}`, Number(r.total)]));
  const caps = new Map();
  const capOf = async (y) => {
    if (!caps.has(y)) caps.set(y, await capFor(db, ctx.workspace?.jurisdiction, y, ctx.workspace?.settings || {}));
    return caps.get(y);
  };
  for (const grp of groups) {
    let known = false;
    let isOver = false;
    for (const y of new Set(grp.gifts.map((g) => Number(isoDay(g.date).slice(0, 4))))) {
      const cap = await capOf(y);
      if (!cap) continue;
      known = true;
      if ((totals.get(`${grp.id}|${y}`) || 0) > Number(cap.capCents)) isOver = true;
    }
    out.set(grp.id, isOver ? 'Yes' : known ? 'No' : '');
  }
  return out;
};

api.get('/receipts/register.csv', async (c) => {
  const no = agentOnly(c);
  if (no) return no;
  const ctx = c.get('ctx');
  const db = c.get('db');
  const rows = (await db.query(
    `select ${ROW} from receipts r left join persons p on p.id = r.person_id
     where r.workspace_id = $1 and not r.sample order by r.series, r.seq`,
    [ctx.workspaceId],
  )).rows;
  const lines = [['Receipt', 'Status', 'Date received', 'Contributor', 'Home address', 'Amount', 'Method', 'Sent']];
  for (const r of rows) {
    const s = statusOf(r, { emailOn: emailConfigured(), hasEmail: !!r.has_email, timeZone: tzOf(ctx) });
    lines.push([r.number, s.word, isoDay(r.received_on), r.donor_name, r.donor_address || '', dollars(r.amount_cents),
      methodWord(r.method), r.sent_at ? new Date(r.sent_at).toISOString().slice(0, 10) : '']);
  }
  return csv(c, `receipts-${today()}.csv`, lines);
});

api.get('/receipts/gift/:giftId', async (c) => {
  const ctx = c.get('ctx');
  if (!UUID_RE.test(c.req.param('giftId'))) return c.json({ error: 'not found' }, 404);
  const db = c.get('db');
  const r = (await db.query(
    `select ${ROW} from receipts r left join persons p on p.id = r.person_id
     where r.workspace_id = $1 and r.gift_id = $2`,
    [ctx.workspaceId, c.req.param('giftId')],
  )).rows[0];
  const settings = await loadSettings(db, ctx.workspaceId);
  return c.json({ receipt: r ? shape(r, ctx) : null, threshold_cents: settings.threshold_cents });
});

api.get('/receipts/:id', async (c) => {
  const ctx = c.get('ctx');
  if (!UUID_RE.test(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
  const db = c.get('db');
  const r = (await db.query(
    `select ${ROW} from receipts r left join persons p on p.id = r.person_id
     where r.workspace_id = $1 and r.id = $2`,
    [ctx.workspaceId, c.req.param('id')],
  )).rows[0];
  if (!r) return c.json({ error: 'not found' }, 404);
  const settings = await loadSettings(db, ctx.workspaceId);
  return c.json({
    receipt: shape(r, ctx),
    doc: docOf(r, settings, await campaignName(db, ctx.workspaceId)),
    link: linkFor(ctx.publicUrl, r.token),
    canSend: canSendOf(r, { emailOn: emailConfigured(), hasEmail: !!r.has_email, hasAddress: hasAddressOf(r) }),
    emailConfigured: emailConfigured(),
  });
});

// ── CSV ──
const dollars = (cents) => (Number(cents || 0) / 100).toFixed(2);
const today = () => new Date().toISOString().slice(0, 10);
// A cell a spreadsheet would run as a formula is quoted as text.
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (c, filename, lines) => {
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Cache-Control', 'no-store');
  return c.body(`${lines.map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`);
};
