// POST /api/public/:ws/join — the website's membership form, as JSON.
//   { first_name, last_name, email, phone, address, city, postal, neighbourhood,
//     birthdate (YYYY-MM-DD), citizenship ("Citizen" | "Permanent resident" | "Other"),
//     gender, languages: [], student, campus, issue, interest_volunteer,
//     interest_lawn_sign, consent: true, return: { success, cancel } }
//   → { ok, status: "active" }                 no fee, or the fee is paid some other way
//   → { ok, status: "already_member", expires_at }  a membership with more than two months left
//   → { url }                                  the fee: Stripe Checkout (back to `return`)
//   → { ok, status: "pledged", instructions }  the fee, no card payment connected yet
//   → 400 { error, field }
// The person lands in People (tagged member, or member-pending until the
// fee is paid), with what they told us under their details; everyone who
// joins is on the newsletter list (the form asks for consent). The fee is a
// contribution: it is checked against the annual limit and recorded as a
// pledge, and the gift is booked when it is paid (the Stripe webhook) or
// received (Donations → Mark received) — the membership turns active then.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { newId } from '../../lib/events.js';
import { clientIp, makeLimiter } from '../../lib/guard.js';
import { publicAction, upsertPersonTx, subscribeTx } from '../../lib/publicwrites.js';
import { capFor, donorYearTotal } from '../../lib/cap.js';
import { stripeConfigured, createCheckoutSession } from '../../lib/stripe.js';
import { loadSettings } from '../website/content.js';
import { originOf, returnUrl } from '../website/hosts.js';
import {
  NEIGHBOURHOODS, OUTSIDE_SURREY, CAMPUSES, CITIZENSHIP, MIN_MEMBER_AGE, POSTAL_RE, BC_POSTAL_RE,
  normalizePostal, ageOn, addYear, RENEW_WINDOW_DAYS,
} from './rules.js';

export const publicRoutes = new Hono();
const limited = makeLimiter({ windowMs: 600000, max: 30 });

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const yes = (v) => [true, 1, '1', 'true', 'on', 'yes'].includes(v);
const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const dollars = (c2) => `$${(c2 / 100).toLocaleString('en-CA', { minimumFractionDigits: c2 % 100 ? 2 : 0 })}`;
const publicBase = (c) => (process.env.STARBASE_PUBLIC_URL || originOf(c)).replace(/\/$/, '');

const cors = (c) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type');
};
publicRoutes.options('/api/public/:ws/join', (c) => { cors(c); return c.body(null, 204); });

// What the form must say, field by field.
const read = (b) => {
  const v = {
    first_name: str(b.first_name, 80), last_name: str(b.last_name, 80), email: str(b.email, 320).toLowerCase(),
    phone: str(b.phone, 40), address: str(b.address, 200), city: str(b.city, 80), postal: normalizePostal(str(b.postal || b.postal_code, 12)),
    neighbourhood: str(b.neighbourhood, 40), birthdate: str(b.birthdate, 10), citizenship: str(b.citizenship || b.citizenship_status, 40),
    gender: str(b.gender, 20), languages: Array.isArray(b.languages) ? b.languages.map((l) => str(l, 40)).filter(Boolean).slice(0, 20) : [],
    student: yes(b.student), campus: str(b.campus, 40), issue: str(b.issue, 200),
    interest_volunteer: yes(b.interest_volunteer), interest_lawn_sign: yes(b.interest_lawn_sign), consent: yes(b.consent),
  };
  const bad = (field, error) => ({ error, field });
  if (!v.first_name) return bad('first_name', 'Your first name is required.');
  if (!v.last_name) return bad('last_name', 'Your last name is required.');
  if (!emailOk(v.email)) return bad('email', 'Enter a valid email address.');
  if (!v.address) return bad('address', 'Your address is required.');
  if (!v.city) return bad('city', 'Your city is required.');
  if (!POSTAL_RE.test(v.postal)) return bad('postal', 'Enter a postal code like A1A 1A1.');
  if (![...NEIGHBOURHOODS, OUTSIDE_SURREY].includes(v.neighbourhood)) return bad('neighbourhood', 'Choose your neighbourhood.');
  const age = ageOn(v.birthdate);
  if (age === undefined) return bad('birthdate', 'Enter your date of birth.');
  if (age < MIN_MEMBER_AGE) return bad('birthdate', `Members must be ${MIN_MEMBER_AGE} or older.`);
  if (!CITIZENSHIP.includes(v.citizenship)) return bad('citizenship', 'Choose one.');
  if (v.student && v.campus && !CAMPUSES.includes(v.campus)) return bad('campus', 'Choose a campus.');
  if (!v.consent) return bad('consent', 'Please tick the box to continue.');
  return { v };
};

publicRoutes.post('/api/public/:ws/join', async (c) => {
  cors(c);
  c.header('Cache-Control', 'no-store');
  if (limited(clientIp(c))) return c.json({ error: 'too many requests' }, 429);
  const db = await getDb();
  const ws = (await db.query('select id, name, slug, jurisdiction, settings from workspaces where slug = $1', [c.req.param('ws')])).rows[0];
  if (!ws) return c.json({ error: 'unknown workspace' }, 404);
  ws.settings = typeof ws.settings === 'string' ? JSON.parse(ws.settings) : (ws.settings || {});
  const b = await c.req.json().catch(() => ({}));
  const r = read(b);
  if (r.error) return c.json(r, 400);
  const v = r.v;
  const { settings: site } = await loadSettings(db, ws);
  const fee = Number(site.membership_fee_cents) || 0;
  if (fee > 0) {
    if (v.citizenship === 'Other') {
      return c.json({ error: 'Under BC election law we can only take membership fees from Canadian citizens and permanent residents.', field: 'citizenship' }, 400);
    }
    if (!BC_POSTAL_RE.test(v.postal)) return c.json({ error: 'Under BC election law we can only take membership fees from people who live in BC.', field: 'postal' }, 400);
  }

  const name = `${v.first_name} ${v.last_name}`;
  const address = `${v.address}, ${v.city}, ${v.postal}`;
  const votingEligible = v.neighbourhood !== OUTSIDE_SURREY && v.city.toLowerCase() === 'surrey';
  const details = {
    neighbourhood: v.neighbourhood, birthdate: v.birthdate, citizenship: v.citizenship, gender: v.gender || null,
    languages: v.languages, student: v.student, campus: v.student ? v.campus || null : null, issue: v.issue || null,
    interest_volunteer: v.interest_volunteer, interest_lawn_sign: v.interest_lawn_sign,
  };
  const tags = ['member-pending', ...(v.interest_volunteer ? ['volunteer-prospect'] : []), ...(v.interest_lawn_sign ? ['lawn-sign'] : [])];

  // The person, their details and the newsletter, as one write.
  const personId = await publicAction(db, ws, 'public.join', async (tx, emit) => {
    const { id } = await upsertPersonTx(tx, emit, ws, { name, email: v.email, phone: v.phone, address }, tags);
    await tx.query(
      `update persons set phone = coalesce(nullif($3, ''), phone), address = $4, city = $5, postal = $6,
         attrs = coalesce(attrs, '{}'::jsonb) || $7::jsonb, updated_at = now()
       where id = $1 and workspace_id = $2`,
      [id, ws.id, v.phone, address, v.city, v.postal, JSON.stringify({ member: details })],
    );
    emit('person', id, 'update', { address, city: v.city, postal: v.postal, member: details, source: 'join' });
    await subscribeTx(tx, emit, ws, v.email, name, 'membership');
    return id;
  });

  // Already a member with more than two months left: nothing to pay.
  const current = (await db.query(
    `select id, expires_at from members where workspace_id = $1 and person_id = $2 and status = 'active' and expires_at > now()
     order by expires_at desc limit 1`, [ws.id, personId],
  )).rows[0];
  if (current && new Date(current.expires_at).getTime() - Date.now() > RENEW_WINDOW_DAYS * 86400_000) {
    return c.json({ ok: true, status: 'already_member', expires_at: current.expires_at });
  }
  const startsAt = current ? new Date(current.expires_at) : new Date();

  if (fee === 0) {
    const id = await publicAction(db, ws, 'member.join', async (tx, emit) => {
      const mid = newId();
      await tx.query(
        `insert into members (id, workspace_id, person_id, status, fee_cents, voting_eligible, starts_at, expires_at, details)
         values ($1, $2, $3, 'active', 0, $4, $5, $6, $7)`,
        [mid, ws.id, personId, votingEligible, startsAt.toISOString(), addYear(startsAt).toISOString(), JSON.stringify(details)],
      );
      await markMember(tx, emit, ws, personId, true);
      emit('member', mid, 'create', { person_id: personId, status: 'active', fee_cents: 0, voting_eligible: votingEligible, expires_at: addYear(startsAt).toISOString() });
      return mid;
    });
    return c.json({ ok: true, status: 'active', member_id: id, expires_at: addYear(startsAt).toISOString() });
  }

  // The fee is a contribution: within the annual limit, recorded as a pledge.
  const year = new Date().getUTCFullYear();
  const rule = await capFor(db, ws.jurisdiction, year, ws.settings);
  if (rule) {
    const so = await donorYearTotal(db, ws.id, personId, year);
    if (so + fee > rule.capCents) {
      return c.json({ error: `You've reached this year's ${dollars(rule.capCents)} contribution limit, so we can't take a membership fee until January. Thank you!`, field: 'form' }, 400);
    }
  }
  const attest = { individual: true, resident: true, own_funds: true, citizen_or_pr: v.citizenship !== 'Other', membership: true, at: new Date().toISOString(), ip: clientIp(c) };
  const { memberId, pledgeId } = await publicAction(db, ws, 'member.join', async (tx, emit) => {
    const pid = newId();
    const status = stripeConfigured() ? 'pending' : 'pledged';
    await tx.query(
      `insert into pledges (id, workspace_id, person_id, name, email, phone, address, amount_cents, cadence, status, attest)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'one-time', $9, $10)`,
      [pid, ws.id, personId, name, v.email, v.phone || null, address, fee, status, JSON.stringify(attest)],
    );
    emit('pledge', pid, 'create', { person_id: personId, name, email: v.email, amount_cents: fee, cadence: 'one-time', status, attest, source: 'membership' });
    const mid = newId();
    await tx.query(
      `insert into members (id, workspace_id, person_id, status, fee_cents, voting_eligible, pledge_id, details)
       values ($1, $2, $3, 'pending_payment', $4, $5, $6, $7)`,
      [mid, ws.id, personId, fee, votingEligible, pid, JSON.stringify(details)],
    );
    emit('member', mid, 'create', { person_id: personId, status: 'pending_payment', fee_cents: fee, voting_eligible: votingEligible, pledge_id: pid });
    return { memberId: mid, pledgeId: pid };
  });

  if (stripeConfigured()) {
    const base = publicBase(c);
    const ret = b.return && typeof b.return === 'object' ? b.return : {};
    try {
      const session = await createCheckoutSession({
        pledge: { id: pledgeId, amount_cents: fee, cadence: 'one-time', email: v.email },
        workspace: ws,
        successUrl: returnUrl(ret.success, `${base}/d/${ws.slug}/thanks`),
        cancelUrl: returnUrl(ret.cancel, `${base}/d/${ws.slug}`),
      });
      await publicAction(db, ws, 'stripe.checkout', async (tx, emit) => {
        await tx.query('update pledges set stripe_session_id = $3, updated_at = now() where id = $1 and workspace_id = $2', [pledgeId, ws.id, session.id]);
        emit('pledge', pledgeId, 'update', { stripe_session_id: session.id });
      });
      return c.json({ url: session.url, member_id: memberId });
    } catch (e) {
      return c.json({ error: `Card payment isn't available right now (${String(e.message).slice(0, 120)}). Please try again shortly.` }, 502);
    }
  }
  return c.json({
    ok: true, status: 'pledged', member_id: memberId,
    instructions: ws.settings.donateInstructions || 'The campaign will be in touch to complete your membership fee by e-transfer or cheque.',
  });
});

// A person's tags say member or member-pending, never both.
export const markMember = async (tx, emit, ws, personId, active) => {
  const row = (await tx.query('select tags from persons where id = $1 and workspace_id = $2', [personId, ws.id])).rows[0];
  if (!row) return;
  const cur = (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags || []).filter((t) => t !== 'member' && t !== 'member-pending');
  const tags = [...cur, active ? 'member' : 'member-pending'];
  await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [personId, ws.id, JSON.stringify(tags)]);
  emit('person', personId, 'update', { tags, source: 'membership' });
};
