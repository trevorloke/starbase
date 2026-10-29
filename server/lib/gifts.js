// The one way a gift enters the books — desk entry, a confirmed pledge, or a
// Stripe payment. Inserts the gift and runs the entity-keyed cap check inside
// the caller's transaction; the SUM already includes this gift, so the exact
// crossing record is the one flagged.
import { newId } from './events.js';
import { checkCap } from './cap.js';
import { httpError } from '../actions/util.js';
import { DEFAULT_SLATE, slateLabel } from '@starbase/shared/canvass';

export const logGift = async (tx, workspace, input, emit) => {
  const donor = (await tx.query(
    'select id, name from persons where id = $1 and workspace_id = $2 and deleted_at is null',
    [input.person_id, workspace.id],
  )).rows[0];
  if (!donor) throw httpError(400, 'donor not found in this workspace — create the person first');

  const id = newId();
  // pledge_id is set only by pledge.receive (gift.log's input contract has no
  // such field), linking the gift to the pledge it was received for.
  const slate = input.slate || DEFAULT_SLATE;
  await tx.query(
    `insert into gifts (id, workspace_id, person_id, amount_cents, date, method, cadence, note, pledge_id, slate)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, workspace.id, input.person_id, input.amount_cents, input.date,
     input.method || null, input.cadence || 'one-time', input.note || null, input.pledge_id || null, slate],
  );

  const { cap, flagReason } = await flagIfOver(tx, workspace, { id, person_id: input.person_id, date: input.date, donorName: donor.name, slate });
  const payload = { id, ...input, slate, flagged: !!flagReason, flag_reason: flagReason };
  emit('gift', id, 'create', payload);
  return { gift: payload, compliance: cap };
};

const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Run the cap check for a live gift's donor and year; if the donor is over,
// flag this gift with the reason. Shared by a new gift and a restored one.
const flagIfOver = async (tx, workspace, { id, person_id, date, donorName, slate }) => {
  const cap = await checkCap(tx, {
    workspaceId: workspace.id,
    personId: person_id,
    date: isoDay(date),
    jurisdiction: workspace.jurisdiction,
    settings: workspace.settings,
    slate,
  });
  let flagReason = null;
  if (cap.checked && cap.over) {
    // The desk reads the numbers out of this sentence (Money: parseOver).
    flagReason = `${donorName} is at $${(cap.totalCents / 100).toFixed(2)} for ${cap.year} — over the $${(cap.capCents / 100).toFixed(2)} limit on the ${slateLabel(slate).toLowerCase()} slate (${cap.source})`;
    await tx.query(
      'update gifts set flagged = true, flag_reason = $3 where id = $1 and workspace_id = $2',
      [id, workspace.id, flagReason],
    );
  }
  return { cap, flagReason };
};

// ── Voids and restores keep the gift's pledge honest ──
// A one-time pledge closed by a gift opens again when that gift is voided
// (status 'pledged', gift_id null) and closes again when it is restored. A
// monthly pledge stays open throughout; its last_received_on (and gift_id,
// the latest gift) follow the live gifts received for it.

const pledgeOf = async (tx, workspaceId, gift) => (await tx.query(
  `select * from pledges where workspace_id = $1 and (id = $2::uuid or gift_id = $3::uuid)
   order by (id = $2::uuid) desc nulls last limit 1 for update`,
  [workspaceId, gift.pledge_id || null, gift.id],
)).rows[0];

// The latest live gift received for a monthly pledge.
const latestFor = async (tx, workspaceId, pledgeId) => (await tx.query(
  `select id, date from gifts where workspace_id = $1 and pledge_id = $2 and deleted_at is null
   order by date desc, created_at desc limit 1`,
  [workspaceId, pledgeId],
)).rows[0] || null;

const syncMonthly = async (tx, workspaceId, p, emit, why) => {
  const latest = await latestFor(tx, workspaceId, p.id);
  const lastOn = latest ? isoDay(latest.date) : null;
  const giftId = latest ? latest.id : null;
  const curOn = p.last_received_on ? isoDay(p.last_received_on) : null;
  if (lastOn === curOn && giftId === (p.gift_id || null)) return null;
  await tx.query(
    `update pledges set last_received_on = $3, gift_id = $4, updated_at = now() where id = $1 and workspace_id = $2`,
    [p.id, workspaceId, lastOn, giftId],
  );
  const change = { last_received_on: lastOn, gift_id: giftId, ...why };
  emit('pledge', p.id, 'update', change);
  return { id: p.id, status: p.status, cadence: p.cadence, last_received_on: lastOn, gift_id: giftId };
};

// The status a one-time pledge closes with: card payments through Stripe are
// 'paid' (as the webhook files them); everything the treasurer confirmed is
// 'received'.
const closedStatus = (p, gift) => (p.stripe_session_id && gift.method === 'card' ? 'paid' : 'received');

export const voidGift = async (tx, workspaceId, id, emit) => {
  const gift = (await tx.query(
    `update gifts set deleted_at = now() where id = $1 and workspace_id = $2 and deleted_at is null
     returning id, pledge_id, method`,
    [id, workspaceId],
  )).rows[0];
  if (!gift) throw httpError(404, 'gift not found');
  emit('gift', id, 'void', {});

  const p = await pledgeOf(tx, workspaceId, gift);
  if (!p) return { id, pledge: null };
  // Remember the link on the gift itself, so a restore finds the pledge even
  // after the pledge lets go of it.
  if (!gift.pledge_id) {
    await tx.query('update gifts set pledge_id = $3 where id = $1 and workspace_id = $2', [id, workspaceId, p.id]);
  }
  if (p.cadence === 'monthly') {
    return { id, pledge: await syncMonthly(tx, workspaceId, p, emit, { voided_gift: id }) };
  }
  if (p.gift_id !== id || !['received', 'paid'].includes(p.status)) return { id, pledge: null };
  await tx.query(
    `update pledges set status = 'pledged', gift_id = null, updated_at = now() where id = $1 and workspace_id = $2`,
    [p.id, workspaceId],
  );
  emit('pledge', p.id, 'update', { status: 'pledged', gift_id: null, reopened: true, voided_gift: id });
  return { id, pledge: { id: p.id, status: 'pledged', cadence: p.cadence, gift_id: null, reopened: true } };
};

export const restoreGift = async (tx, workspace, id, emit) => {
  const gift = (await tx.query(
    `update gifts set deleted_at = null where id = $1 and workspace_id = $2 and deleted_at is not null
     returning id, person_id, date, method, pledge_id, slate, flagged, flag_reason`,
    [id, workspace.id],
  )).rows[0];
  if (!gift) throw httpError(404, 'gift not found in trash');

  // Back in the books: the donor's year total counts it again, so the cap
  // check runs again — a restore that takes a donor over the limit is flagged
  // like any other crossing gift.
  let flag = null;
  if (!gift.flagged) {
    const donor = (await tx.query('select name from persons where id = $1 and workspace_id = $2', [gift.person_id, workspace.id])).rows[0];
    const { flagReason } = await flagIfOver(tx, workspace, { id, person_id: gift.person_id, date: gift.date, donorName: donor?.name || 'This donor', slate: gift.slate });
    flag = flagReason;
  }
  emit('gift', id, 'restore', flag ? { flagged: true, flag_reason: flag } : {});

  const p = await pledgeOf(tx, workspace.id, gift);
  const out = { id, flagged: !!flag || !!gift.flagged, flag_reason: flag || gift.flag_reason || null, pledge: null };
  if (!p) return out;
  if (p.cadence === 'monthly') {
    const month = isoDay(gift.date).slice(0, 7);
    const twin = (await tx.query(
      `select 1 from gifts where workspace_id = $1 and pledge_id = $2 and id <> $3 and deleted_at is null
         and to_char(date, 'YYYY-MM') = $4 limit 1`,
      [workspace.id, p.id, id, month],
    )).rows[0];
    if (twin) throw httpError(409, `this monthly pledge already has a gift for ${monthName(month)} — void that one first`);
    out.pledge = await syncMonthly(tx, workspace.id, p, emit, { restored_gift: id });
    return out;
  }
  if (p.gift_id && p.gift_id !== id) {
    const other = (await tx.query(
      'select 1 from gifts where id = $1 and workspace_id = $2 and deleted_at is null', [p.gift_id, workspace.id],
    )).rows[0];
    if (other) throw httpError(409, 'this pledge was received again with another gift — void that one first');
  }
  if (p.gift_id === id && ['received', 'paid'].includes(p.status)) return out;
  const status = closedStatus(p, gift);
  await tx.query(
    `update pledges set status = $3, gift_id = $4, updated_at = now() where id = $1 and workspace_id = $2`,
    [p.id, workspace.id, status, id],
  );
  emit('pledge', p.id, 'update', { status, gift_id: id, restored_gift: id });
  out.pledge = { id: p.id, status, cadence: p.cadence, gift_id: id };
  return out;
};

// "2026-10-21" — the calendar day it is at `when` in the campaign's time zone
// (a card payment at 7:30 pm Pacific on Oct 21 is the 21st, not the UTC
// 22nd; Dec 31 evening stays in its own year). Unknown zone → Vancouver.
export const campaignDay = (when, timeZone = 'America/Vancouver') => {
  const d = when instanceof Date ? when : new Date(when);
  const fmt = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  let parts;
  try { parts = fmt(timeZone || 'America/Vancouver'); } catch { parts = fmt('America/Vancouver'); }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

// 'YYYY-MM' → 'October 2026'.
export const monthName = (ym) => new Date(`${ym}-01T00:00:00Z`)
  .toLocaleString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
