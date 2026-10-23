// Contribution receipts: every gift at or over the threshold gets one in the
// same write, numbered without gaps per campaign per year; a void voids it and
// a restore brings it back; email goes once when connected (and says so when
// it isn't); the donor's link shows that receipt only; the disclosure export
// groups contributors over $100; volunteers get none of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { getDb } from '../db/client.js';
import { runAction } from '../lib/events.js';
import { logGift } from '../lib/gifts.js';
import { onHook } from '../lib/hooks.js';
import { runDueJobs } from '../lib/jobs.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.rc.${tag}@example.org`;
let db, mgr, staff, treas, vol, wsId, slug;

// A desk member of `ws`: sign up elsewhere, then move membership + session in.
const member = async (ws, role, who) => {
  const c = new Client();
  const r = await c.signup({ workspaceName: `Temp ${who} ${tag}`, email: mail(who) });
  await db.query('update memberships set workspace_id = $2, role = $3 where user_id = $1', [r.json.user.id, ws, role]);
  await db.query('update sessions set workspace_id = $2 where user_id = $1', [r.json.user.id, ws]);
  return c;
};

const campaign = async (name) => {
  const c = new Client();
  const r = await c.signup({ workspaceName: name, email: mail(`m${Math.random().toString(36).slice(2, 7)}`), jurisdiction: 'bc-municipal' });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json));
  return { c, ws: r.json.workspace.id, slug: r.json.workspace.slug };
};

// Public requests from their own address (the per-IP limit never trips).
let ipN = 0;
const pub = async (method, path, body, headers = {}) => {
  const form = body instanceof URLSearchParams;
  ipN += 1;
  const res = await app.request(path, {
    method,
    headers: {
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      'x-forwarded-for': `203.0.113.${ipN % 250}`,
      ...headers,
    },
    body: body === undefined ? undefined : (form ? body.toString() : (typeof body === 'string' ? body : JSON.stringify(body))),
    redirect: 'manual',
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, json: ct.includes('json') ? await res.json() : null, text: ct.includes('json') ? '' : await res.text(), headers: res.headers };
};

// The raw body of a desk GET (CSV).
const raw = async (client, path) => {
  const res = await app.request(path, { headers: client.cookie ? { cookie: client.cookie } : {} });
  return { status: res.status, text: await res.text(), headers: res.headers };
};
const parseCsv = (text) => text.trim().split('\r\n').map((line) => {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
});

// Stand in for the email provider: RESEND_API_KEY set and fetch answered
// here (both restored after). `fail` picks addresses the provider refuses.
// Like the real one, a request whose Idempotency-Key it already sent is
// answered as before and not sent again (logged in sent.deduped).
const withEmail = async (fn, { fail = () => false } = {}) => {
  const realFetch = globalThis.fetch;
  const had = Object.hasOwn(process.env, 'RESEND_API_KEY');
  const old = process.env.RESEND_API_KEY;
  const sent = [];
  sent.deduped = [];
  const seen = new Set();
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      const msg = JSON.parse(init.body);
      const key = init.headers?.['Idempotency-Key'] || null;
      if (fail(msg.to[0])) return new Response('mailbox unavailable', { status: 500 });
      if (key && seen.has(key)) {
        sent.deduped.push(key);
        return new Response(JSON.stringify({ id: 'msg' }), { status: 200 });
      }
      if (key) seen.add(key);
      sent.push({ ...msg, key });
      return new Response(JSON.stringify({ id: 'msg' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = realFetch;
    if (had) process.env.RESEND_API_KEY = old; else delete process.env.RESEND_API_KEY;
  }
};

const gift = async (client, person, amount, date = '2026-10-01', extra = {}) => {
  const r = await client.action('gift.log', { person_id: person.id, amount_cents: amount, date, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.gift;
};
const receiptFor = async (client, giftId) => {
  const r = await client.get(`/api/receipts/gift/${giftId}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.receipt;
};
const one = async (client, id) => (await client.get(`/api/receipts/${id}`)).json;
const tokenOf = async (id) => (await db.query('select token from receipts where id = $1', [id])).rows[0].token;
// The automatic email waits out the gift's Undo (a minute): make it due now.
const due = (ws) => db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'receipt.email' and status = 'pending'`, [ws]);
const statusRow = async (id) => (await db.query('select email_status, sent_count from receipts where id = $1', [id])).rows[0];
const verified = async (client) => {
  const v = await client.get('/api/audit/verify');
  assert.equal(v.json.ok, true, JSON.stringify(v.json));
};

before(async () => {
  db = await freshDb();
  delete process.env.RESEND_API_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  ({ c: mgr, ws: wsId, slug } = await campaign(`Receipts ${tag}`));
  staff = await member(wsId, 'staff', 'staff');
  treas = await member(wsId, 'treasurer', 'treas');
  vol = await member(wsId, 'volunteer', 'vol');
  assert.equal((await mgr.action('receipt.settings', { agent_name: 'Jordan Agent', agent_contact: 'agent@example.org' })).status, 200);
});

after(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

test('every gift gets a receipt in its own write; two at once never share or skip a number', async () => {
  const { c, ws } = await campaign(`Numbers ${tag}`);
  const a = await c.createPerson('Ana Number', { address: '100 Main St', city: 'Surrey' });
  const b = await c.createPerson('Ben Number');
  const [g1, g2] = await Promise.all([gift(c, a, 5000), gift(c, b, 7000)]);
  const r1 = await receiptFor(c, g1.id);
  const r2 = await receiptFor(c, g2.id);
  assert.deepEqual([r1.number, r2.number].sort(), ['2026-0001', '2026-0002']);
  // The receipt is on the gift's own action, in the same transaction.
  const ev = (await db.query(
    `select action, entity_type, entity_id, op, payload from events where workspace_id = $1 and entity_type = 'receipt' order by seq`, [ws],
  )).rows;
  assert.deepEqual(ev.map((e) => [e.action, e.op]), [['gift.log', 'create'], ['gift.log', 'create']]);
  assert.deepEqual(ev.map((e) => e.payload.gift_id).sort(), [g1.id, g2.id].sort());
  assert.ok(ev.every((e) => !JSON.stringify(e.payload).includes('token')), 'the donor link never enters the log');

  const more = await Promise.all([3000, 4000, 6000, 8000, 9000].map((n) => gift(c, a, n)));
  const nums = (await Promise.all(more.map((g) => receiptFor(c, g.id)))).map((r) => r.number).sort();
  assert.deepEqual(nums, ['2026-0003', '2026-0004', '2026-0005', '2026-0006', '2026-0007']);

  // A gift that rolls back after its receipt was numbered hands the number back.
  const boom = `test.rollback.${tag}`;
  onHook('events', async (_tx, meta) => { if (meta.action === boom) throw new Error('rolled back on purpose'); });
  const wsRow = (await db.query('select id, jurisdiction, settings from workspaces where id = $1', [ws])).rows[0];
  await assert.rejects(runAction(db, { workspaceId: ws, actorId: null, action: boom },
    (tx, emit) => logGift(tx, wsRow, { person_id: a.id, amount_cents: 1000, date: '2026-10-02' }, emit)));
  const next = await gift(c, b, 1100);
  assert.equal((await receiptFor(c, next.id)).number, '2026-0008', 'no gap where the rolled-back gift was');

  // Numbers run per year of the date received.
  const old = await gift(c, a, 2000, '2025-12-30');
  assert.equal((await receiptFor(c, old.id)).number, '2025-0001');
  const all = (await c.get('/api/receipts')).json.receipts;
  assert.equal(all.length, 9);
  assert.equal(new Set(all.map((r) => r.number)).size, 9, 'no number used twice');
  await verified(c);
});

test('threshold: under it no receipt, at it a receipt; only managers and treasurers set it', async () => {
  const d = await mgr.createPerson('Theo Threshold', { address: '7 Elm St' });
  assert.equal((await staff.action('receipt.settings', { threshold_cents: 2500 })).status, 403);
  assert.equal((await vol.action('receipt.settings', { threshold_cents: 2500 })).status, 403);
  const set = await treas.action('receipt.settings', { threshold_cents: 2500 });
  assert.equal(set.status, 200);
  assert.equal(set.json.settings.agent_name, 'Jordan Agent', 'a partial save keeps the rest');
  const small = await gift(mgr, d, 2499);
  const under = await mgr.get(`/api/receipts/gift/${small.id}`);
  assert.equal(under.json.receipt, null);
  assert.equal(under.json.threshold_cents, 2500);
  const atIt = await gift(mgr, d, 2500);
  assert.ok((await receiptFor(mgr, atIt.id)).number.startsWith('2026-'));
  assert.equal((await mgr.action('receipt.settings', { threshold_cents: 0 })).status, 200);
  const tiny = await gift(mgr, d, 100);
  assert.ok(await receiptFor(mgr, tiny.id), 'default again: every contribution');
  const ev = (await db.query(`select payload from events where workspace_id = $1 and entity_type = 'receipt_settings' order by seq`, [wsId])).rows;
  assert.deepEqual(ev.map((e) => e.payload.threshold_cents).filter((v) => v !== undefined), [2500, 0]);
});

test('a voided gift voids its receipt (number kept, VOID); a restore un-voids it', async () => {
  const d = await mgr.createPerson('Vera Void', { address: '9 Oak St', email: mail('vera') });
  const g = await gift(mgr, d, 4200);
  const r = await receiptFor(mgr, g.id);
  assert.equal(r.void, false);
  assert.equal((await mgr.action('gift.void', { id: g.id })).status, 200);
  const v = await one(mgr, r.id);
  assert.equal(v.receipt.number, r.number, 'the number stays');
  assert.equal(v.receipt.void, true);
  assert.equal(v.receipt.status.word, 'Void');
  assert.equal(v.doc.void, true);
  const page = await pub('GET', `/r/${await tokenOf(r.id)}`);
  assert.match(page.text, /VOID/);
  // A void never frees its number.
  const after = await gift(mgr, d, 1000);
  assert.notEqual((await receiptFor(mgr, after.id)).number, r.number);
  assert.equal((await mgr.action('receipt.send', { id: r.id })).status, 409, 'a void receipt is never sent');

  assert.equal((await mgr.action('gift.restore', { id: g.id })).status, 200);
  const back = await one(mgr, r.id);
  assert.equal(back.receipt.void, false);
  assert.equal(back.receipt.number, r.number);
  const ev = (await db.query(
    `select action, op from events where workspace_id = $1 and entity_type = 'receipt' and entity_id = $2 order by seq`, [wsId, r.id],
  )).rows;
  assert.deepEqual(ev.map((e) => [e.action, e.op]), [['gift.log', 'create'], ['gift.void', 'void'], ['gift.restore', 'restore']]);
  await verified(mgr);
});

const eligible = { attest_individual: '1', attest_resident: '1', attest_own_funds: '1' };
const stripeSign = (body, secret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

test('a pledge marked paid and a Stripe payment both get receipts', async () => {
  // A donor already on file without an address: the pledge's home address is used.
  await mgr.createPerson('Paula Pledge', { email: mail('paula') });
  const ok = await pub('POST', `/d/${slug}`, new URLSearchParams({
    amount: '75', name: 'Paula Pledge', email: mail('paula'), address: '12 Pledge Way, Surrey', ...eligible,
  }));
  assert.equal(ok.status, 200);
  const pledge = (await mgr.get('/api/pledges')).json.pledges.find((p) => p.email === mail('paula'));
  const paid = await treas.action('pledge.receive', { id: pledge.id, method: 'cheque', date: '2026-10-05' });
  assert.equal(paid.status, 200, JSON.stringify(paid.json));
  const r = await receiptFor(mgr, paid.json.gift.id);
  assert.equal(r.amount_cents, 7500);
  assert.equal(r.method, 'cheque');
  const doc = (await one(mgr, r.id)).doc;
  assert.equal(doc.address, '12 Pledge Way, Surrey');
  assert.equal(doc.contributor, 'Paula Pledge');

  process.env.STRIPE_SECRET_KEY = 'sk_test_receipts';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_receipts';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url) === 'https://api.stripe.com/v1/checkout/sessions'
    ? new Response(JSON.stringify({ id: `cs_rc_${tag}`, url: 'https://checkout.stripe.test/rc' }), { status: 200 })
    : realFetch(url, init));
  try {
    const go = await pub('POST', `/d/${slug}`, new URLSearchParams({
      amount: '40', name: 'Carl Card', email: mail('carl'), address: '3 Card St, Surrey', ...eligible,
    }));
    assert.equal(go.status, 303);
    const p = (await mgr.get('/api/pledges')).json.pledges.find((x) => x.email === mail('carl'));
    const body = JSON.stringify({ id: `evt_rc_${tag}`, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), data: { object: {
      id: `cs_rc_${tag}`, mode: 'payment', payment_status: 'paid', amount_total: 4000, payment_intent: 'pi_rc',
      metadata: { pledge_id: p.id, workspace_id: wsId },
    } } });
    const hook = await pub('POST', '/api/public/stripe/webhook', body, { 'stripe-signature': stripeSign(body, 'whsec_receipts') });
    assert.equal(hook.status, 200, JSON.stringify(hook.json));
    const cr = await receiptFor(mgr, hook.json.gift_id);
    assert.equal(cr.amount_cents, 4000);
    assert.equal(cr.method, 'card');
    assert.equal((await one(mgr, cr.id)).doc.address, '3 Card St, Surrey');
    const ev = (await db.query(
      `select action, actor_id from events where workspace_id = $1 and entity_type = 'receipt' and entity_id = $2`, [wsId, cr.id],
    )).rows;
    assert.deepEqual(ev.map((e) => [e.action, e.actor_id]), [['stripe.payment', null]], 'on the payment’s own write, system actor');
    // A webhook delivered twice never makes a second receipt.
    const again = await pub('POST', '/api/public/stripe/webhook', body, { 'stripe-signature': stripeSign(body, 'whsec_receipts') });
    assert.equal(again.json.duplicate, true);
    const n = (await db.query('select count(*)::int as n from receipts where workspace_id = $1 and person_id = $2', [wsId, cr.person_id])).rows[0].n;
    assert.equal(n, 1);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
  await verified(mgr);
});

test('email connected: sent once by itself, Send again sends again; a refusal is retried, then says it failed', async () => {
  const d = await mgr.createPerson('Erin Email', { email: mail('erin'), address: '5 Mail Rd', city: 'Surrey' });
  await withEmail(async (sent) => {
    const g = await gift(mgr, d, 15000);
    let r = await receiptFor(mgr, g.id);
    assert.equal(r.status.word, 'Sending', 'issued while connected: waiting for the job, not claiming sent');
    assert.equal(r.can_send, true, 'a person may still send it now');
    assert.equal(sent.length, 0);
    // Due a minute after the gift (after its Undo), not at once.
    const wait = (await db.query(
      `select extract(epoch from run_at - created_at)::int as s from jobs where workspace_id = $1 and kind = 'receipt.email' and payload->>'receipt_id' = $2`,
      [wsId, r.id],
    )).rows[0].s;
    assert.ok(wait >= 55 && wait <= 65, `due in about a minute (${wait}s)`);
    await runDueJobs(db, { workspaceId: wsId });
    assert.equal(sent.length, 0, 'not before the minute is up');
    await due(wsId);
    await runDueJobs(db, { workspaceId: wsId });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].to, [mail('erin')]);
    assert.equal(sent[0].key, `receipt-${r.id}-1`, 'the provider gets receipt + send count as the idempotency key');
    assert.match(sent[0].subject, new RegExp(`Your receipt ${r.number} from Receipts ${tag}`));
    for (const words of ['Contributor: Erin Email', 'Home address: 5 Mail Rd, Surrey', 'Amount: $150.00', 'Date received: October 1, 2026',
      'Financial agent: Jordan Agent · agent@example.org', 'Contributions to BC municipal election campaigns are not tax-deductible.']) {
      assert.ok(sent[0].text.includes(words), words);
    }
    r = await receiptFor(mgr, g.id);
    assert.equal(r.status.word, 'Sent');
    assert.equal(r.sent_count, 1);
    await runDueJobs(db, { workspaceId: wsId });
    assert.equal(sent.length, 1, 'never twice by itself');
    const again = await staff.action('receipt.send', { id: r.id });
    assert.equal(again.status, 200);
    assert.equal(again.json.email, 'sent');
    assert.equal(sent.length, 2);
    assert.equal(sent[1].key, `receipt-${r.id}-2`);
    assert.equal((await receiptFor(mgr, g.id)).sent_count, 2);
    const ev = (await db.query(
      `select action, op, actor_id, payload from events where workspace_id = $1 and entity_type = 'receipt' and entity_id = $2 order by seq`, [wsId, r.id],
    )).rows;
    assert.deepEqual(ev.map((e) => [e.action, e.op, e.payload.email_status ?? null]),
      [['gift.log', 'create', null], ['receipt.autosend', 'update', 'sending'], ['receipt.autosend', 'update', 'sent'], ['receipt.send', 'update', 'sent']]);
    assert.equal(ev[1].actor_id, null);
    assert.equal(ev[2].actor_id, null);
    assert.equal(ev[3].payload.again, true);
  });

  // The provider refuses: tried three times, then "Not sent — the email failed".
  const f = await mgr.createPerson('Fay Fails', { email: mail('fay'), address: '6 Bounce Rd' });
  await withEmail(async (sent) => {
    const g = await gift(mgr, f, 2000);
    for (let i = 0; i < 3; i += 1) {
      await db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'receipt.email' and status = 'pending'`, [wsId]);
      await runDueJobs(db, { workspaceId: wsId });
    }
    const r = await receiptFor(mgr, g.id);
    assert.equal(r.status.word, 'Not sent');
    assert.equal(r.status.line, 'Not sent — the email failed');
    assert.equal(sent.length, 0);
    const job = (await db.query(`select status, attempts from jobs where workspace_id = $1 and kind = 'receipt.email' and payload->>'receipt_id' = $2`, [wsId, r.id])).rows[0];
    assert.deepEqual([job.status, job.attempts], ['done', 3]);
  }, { fail: (to) => to === mail('fay') });
  await verified(mgr);
});

test('email not connected: nothing pretends to send; no email on file says so; Send all sends what is waiting once connected', async () => {
  delete process.env.RESEND_API_KEY;
  const { c, ws } = await campaign(`Unsent ${tag}`);
  const a = await c.createPerson('Una Unsent', { email: mail('una'), address: '1 Unsent Ave' });
  const b = await c.createPerson('Bo NoEmail', { address: '2 Unsent Ave' });
  const ga = await gift(c, a, 3000);
  const gb = await gift(c, b, 3000);
  const ra = await receiptFor(c, ga.id);
  const rb = await receiptFor(c, gb.id);
  assert.deepEqual([ra.status.word, ra.status.line], ['Not sent', 'Not sent — email isn’t connected']);
  assert.deepEqual([rb.status.word, rb.status.line], ['Not sent', 'No email on file']);
  assert.equal((await db.query('select count(*)::int as n from jobs where workspace_id = $1', [ws])).rows[0].n, 0, 'nothing scheduled to send');
  const send = await c.action('receipt.send', { id: ra.id });
  assert.equal(send.status, 409);
  assert.match(send.json.error, /Email isn’t connected/);
  assert.equal((await c.action('receipt.sendAll', {})).status, 409);
  const list = (await c.get('/api/receipts')).json;
  assert.equal(list.emailConfigured, false);
  assert.equal(list.counts.sendable, 0, 'no Send all while email is off');
  assert.equal(list.counts.unsent, 1);

  await withEmail(async (sent) => {
    assert.equal((await c.get('/api/receipts')).json.counts.sendable, 1);
    assert.equal((await one(c, rb.id)).receipt.status.line, 'No email on file', 'connected or not, no email is no email');
    assert.equal((await c.action('receipt.send', { id: rb.id })).status, 409);
    const all = await c.action('receipt.sendAll', {});
    assert.equal(all.status, 200);
    assert.deepEqual([all.json.sent, all.json.failed], [1, 0]);
    assert.deepEqual(sent.map((m) => m.to[0]), [mail('una')]);
    assert.equal((await c.get('/api/receipts')).json.counts.sendable, 0);
    const again = await c.action('receipt.sendAll', {});
    assert.deepEqual([again.json.sent, sent.length], [0, 1], 'Send all never repeats a sent receipt');
  });
  await verified(c);
});

test('Send all counts only Not sent receipts it can email: one already Sending is left to go by itself; the count is one tap’s worth', async () => {
  const { c, ws } = await campaign(`Send all ${tag}`);
  await withEmail(async (sent) => {
    // Right after a gift from a donor with an email: "Sending" (the automatic
    // email is due in a minute). A donor with no email: "Not sent".
    const a = await c.createPerson('Ari Auto', { email: mail('ari'), address: '1 Auto Ave' });
    const b = await c.createPerson('Bea NoEmail', { address: '2 Auto Ave' });
    const ra = await receiptFor(c, (await gift(c, a, 5000)).id);
    const rb = await receiptFor(c, (await gift(c, b, 5000)).id);
    assert.deepEqual([ra.status.code, ra.status.word], ['queued', 'Sending']);
    assert.deepEqual([rb.status.word, rb.status.line], ['Not sent', 'No email on file']);
    let list = (await c.get('/api/receipts')).json;
    assert.deepEqual([list.counts.sendable, list.counts.unsent], [0, 0], 'nothing for the yellow button: one is Sending, one has no email');
    let all = await c.action('receipt.sendAll', {});
    assert.equal(all.status, 200);
    assert.deepEqual([all.json.tried, all.json.sent, sent.length], [0, 0, 0], 'Send all never sends a Sending receipt early');
    assert.equal((await statusRow(ra.id)).email_status, 'queued', 'still waiting for its own email');

    // A Not sent receipt with an email: the count is 1, and Send all sends that one only.
    const cy = await c.createPerson('Cy Later', { address: '3 Auto Ave' });
    const rc = await receiptFor(c, (await gift(c, cy, 5000)).id);
    assert.equal((await c.action('person.update', { id: cy.id, email: mail('cylater') })).status, 200);
    assert.deepEqual([(await one(c, rc.id)).receipt.status.word, (await one(c, rc.id)).receipt.status.line], ['Not sent', 'Not sent']);
    list = (await c.get('/api/receipts')).json;
    assert.equal(list.counts.sendable, 1);
    all = await c.action('receipt.sendAll', {});
    assert.deepEqual([all.json.tried, all.json.sent], [1, 1]);
    assert.deepEqual(sent.map((m) => m.to[0]), [mail('cylater')]);

    // Ari's goes by itself when it is due — once.
    await db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'receipt.email' and status = 'pending'`, [ws]);
    await runDueJobs(db, { workspaceId: ws });
    assert.deepEqual(sent.map((m) => m.to[0]), [mail('cylater'), mail('ari')]);
    assert.equal((await one(c, ra.id)).receipt.status.word, 'Sent');
    assert.equal((await c.get('/api/receipts')).json.counts.sendable, 0);

    // More waiting than one tap sends: the count is what one tap sends.
    const many = await c.createPerson('Mo Many', { email: mail('mo'), address: '4 Auto Ave' });
    await db.query(
      `insert into receipts (id, workspace_id, gift_id, person_id, series, seq, number, token, donor_name, donor_address,
                             amount_cents, received_on)
       select gen_random_uuid(), $1, gen_random_uuid(), $2, '2026', 1000 + i, '2026-' || (1000 + i), md5(random()::text || i),
              'Mo Many', '4 Auto Ave', 1000, '2026-10-01'
       from generate_series(1, 101) as i`,
      [ws, many.id],
    );
    list = (await c.get('/api/receipts')).json;
    assert.deepEqual([list.counts.unsent, list.counts.sendable], [101, 100], 'the button never says more than one tap sends');
  });
});

test('the donor link shows that one receipt and nothing else', async () => {
  const d = await mgr.createPerson('Lena Link', { address: '44 Link Ave', email: mail('lena') });
  const other = await mgr.createPerson('Otto Other', { address: '55 Other Ave' });
  const g = await gift(mgr, d, 12500, '2026-09-15', { method: 'etransfer' });
  await gift(mgr, other, 9900);
  await gift(mgr, d, 3300);
  const r = await receiptFor(mgr, g.id);
  const view = await one(mgr, r.id);
  assert.match(view.link, /\/r\/[0-9a-f]{48}$/);
  const token = view.link.split('/r/')[1];
  const page = await pub('GET', `/r/${token}`);
  assert.equal(page.status, 200);
  for (const words of [r.number, 'Lena Link', '44 Link Ave', '$125.00', 'September 15, 2026', 'E-transfer', 'Jordan Agent',
    'Contributions to BC municipal election campaigns are not tax-deductible.', `Receipts ${tag}`]) {
    assert.ok(page.text.includes(words), words);
  }
  for (const words of ['Otto Other', '55 Other Ave', '$99.00', '$33.00', mail('lena')]) {
    assert.ok(!page.text.includes(words), `not on the page: ${words}`);
  }
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('x-robots-tag') || '', /noindex/);
  assert.equal((await pub('GET', `/r/${'0'.repeat(48)}`)).status, 404);
  assert.equal((await pub('GET', '/r/not-a-token')).status, 404);
  const logged = (await db.query('select count(*)::int as n from events where workspace_id = $1 and payload::text like $2', [wsId, `%${token}%`])).rows[0].n;
  assert.equal(logged, 0, 'the token is never in the event log');
});

test('disclosure: contributors over $100 for one period (editable), each contribution listed, over-limit marked; the register lists every receipt', async () => {
  const { c, ws } = await campaign(`Disclose ${tag}`);
  const tr = await member(ws, 'treasurer', 'dtreas');
  const st = await member(ws, 'staff', 'dstaff');
  const ann = await c.createPerson('Ann Over', { address: '1 First St', city: 'Surrey', postal: 'V3W 1A1' });
  const bob = await c.createPerson('Bob Exactly', { address: '2 Second St' });
  const cy = await c.createPerson('Cy Single', { address: '3 Third St' });
  const dee = await c.createPerson('Dee Voided', { address: '4 Fourth St' });
  const sam1 = await c.createPerson('Sam Twin', { address: '5 Fifth St' });
  const sam2 = await c.createPerson('Sam Twin', { address: '6 Sixth St' });
  const evil = await c.createPerson('=HYPERLINK("http://x.example")', { address: '7 Seventh St' });
  const rec = await c.createPerson('Rec Three', { address: '8 Eighth St' });
  const olga = await c.createPerson('Olga Overlimit', { address: '9 Ninth St' });
  await gift(c, ann, 6000, '2026-03-01');
  await gift(c, ann, 5000, '2026-04-01');
  await gift(c, bob, 10000, '2026-05-01');
  await gift(c, cy, 15000, '2026-06-01');
  await gift(c, dee, 9000, '2026-07-01');
  const voided = await gift(c, dee, 5000, '2026-07-02');
  assert.equal((await c.action('gift.void', { id: voided.id })).status, 200);
  await gift(c, sam1, 8000, '2026-08-01');
  await gift(c, sam2, 8000, '2026-08-02');
  await gift(c, evil, 20000, '2026-09-01');
  // $20 last year + $90 this year: over $100 only if the years are added up.
  await gift(c, rec, 2000, '2025-11-15');
  await gift(c, rec, 9000, '2026-02-01');
  // Over the contribution limit this year (Money flags it).
  await gift(c, olga, 150000, '2026-02-02');

  const res = await raw(tr, '/api/receipts/disclosure.csv?period=2026');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="disclosure-over-100-2026\.csv"/);
  const rows = parseCsv(res.text);
  assert.deepEqual(rows[0], ['Period', 'Calendar year 2026', '2026-01-01 to 2026-12-31'], 'the period is the first row');
  assert.deepEqual(rows[1], ['Contributor', 'Home address', 'Contributor total', 'Over limit', 'Date received', 'Amount', 'Receipt']);
  const body = rows.slice(2).map((r) => r.slice(0, 6));
  assert.deepEqual(body, [
    ["'=HYPERLINK(\"http://x.example\")", '7 Seventh St', '200.00', 'No', '2026-09-01', '200.00'],
    ['Ann Over', '1 First St, Surrey, V3W 1A1', '110.00', 'No', '2026-03-01', '60.00'],
    ['Ann Over', '1 First St, Surrey, V3W 1A1', '110.00', 'No', '2026-04-01', '50.00'],
    ['Cy Single', '3 Third St', '150.00', 'No', '2026-06-01', '150.00'],
    ['Olga Overlimit', '9 Ninth St', '1500.00', 'Yes', '2026-02-02', '1500.00'],
  ], 'over $100 in 2026 only: exactly $100 is not over, a voided gift does not count, two people with one name never pool, last year never adds in');
  assert.ok(rows.slice(2).every((r) => /^2026-\d{4}$/.test(r[6])), 'each contribution names its receipt');
  const last = parseCsv((await raw(tr, '/api/receipts/disclosure.csv?period=2025')).text);
  assert.deepEqual(last[0], ['Period', 'Calendar year 2025', '2025-01-01 to 2025-12-31']);
  assert.equal(last.length, 2, '2025: nobody over $100 (Rec Three gave $20)');

  // The campaign's own period (the default): set under Settings.
  assert.equal((await tr.action('receipt.settings', { period_start: '2026-07-01', period_end: '2026-05-01' })).status, 400, 'ends before it starts');
  assert.equal((await tr.action('receipt.settings', { period_start: '2026-05-01', period_end: '2026-06-30' })).status, 200);
  const camp = await raw(tr, '/api/receipts/disclosure.csv');
  assert.match(camp.headers.get('content-disposition'), /filename="disclosure-over-100-campaign-2026-05-01-to-2026-06-30\.csv"/);
  const campRows = parseCsv(camp.text);
  assert.deepEqual(campRows[0], ['Period', 'This campaign', '2026-05-01 to 2026-06-30']);
  assert.deepEqual(campRows.slice(2).map((r) => r[0]), ['Cy Single']);
  const listed = (await tr.get('/api/receipts')).json;
  assert.deepEqual(listed.periods.map((p) => [p.key, p.from, p.to]),
    [['campaign', '2026-05-01', '2026-06-30'], ['2026', '2026-01-01', '2026-12-31'], ['2025', '2025-01-01', '2025-12-31']]);
  assert.equal((await tr.action('receipt.settings', { period_start: null, period_end: null })).status, 200);
  const dflt = parseCsv((await raw(tr, '/api/receipts/disclosure.csv')).text)[0];
  assert.deepEqual(dflt.slice(0, 2), ['Period', 'This campaign']);
  assert.match(dflt[2], /^(\d{4})-01-01 to \1-12-31$/, 'unset: this calendar year');

  assert.equal((await tr.action('receipt.settings', { disclosure_cents: 5000 })).status, 200);
  const lower = parseCsv((await raw(c, '/api/receipts/disclosure.csv?period=2026')).text).slice(2).map((r) => r[0]);
  assert.deepEqual([...new Set(lower)], ["'=HYPERLINK(\"http://x.example\")", 'Ann Over', 'Bob Exactly', 'Cy Single', 'Dee Voided', 'Olga Overlimit', 'Rec Three', 'Sam Twin']);
  assert.equal(lower.filter((n) => n === 'Sam Twin').length, 2);

  const reg = parseCsv((await raw(c, '/api/receipts/register.csv')).text);
  assert.deepEqual(reg[0], ['Receipt', 'Status', 'Date received', 'Contributor', 'Home address', 'Amount', 'Method', 'Sent']);
  assert.deepEqual(reg.slice(1).map((r) => r[0]), ['2025-0001', ...Array.from({ length: 11 }, (_, i) => `2026-${String(i + 1).padStart(4, '0')}`)]);
  assert.equal(reg.find((r) => r[5] === '50.00' && r[3] === 'Dee Voided')[1], 'Void');
  assert.equal(reg[2][1], 'Not sent');

  // Staff keep the books but the filing exports are the agent's.
  assert.equal((await raw(st, '/api/receipts/disclosure.csv')).status, 403);
  assert.equal((await raw(st, '/api/receipts/register.csv')).status, 403);
  assert.equal((await st.get('/api/receipts')).status, 200);
  await verified(c);
});

test('the sample campaign never reaches the filing exports', async () => {
  const { c } = await campaign(`SampleFile ${tag}`);
  assert.equal((await c.post('/api/data/sample')).status, 200);
  const real = await c.createPerson('Rhoda Real', { address: '10 Real Rd' });
  const year = new Date().getFullYear();
  await gift(c, real, 25000, `${year}-01-15`);
  const dis = parseCsv((await raw(c, `/api/receipts/disclosure.csv?period=${year}`)).text);
  assert.deepEqual(dis.slice(2).map((r) => [r[0], r[2]]), [['Rhoda Real', '250.00']], 'no sample donor (Arjun Mehta, Charlotte Hughes …) is listed');
  const reg = parseCsv((await raw(c, '/api/receipts/register.csv')).text);
  assert.deepEqual(reg.slice(1).map((r) => r[0]), [`${year}-0001`], 'no SAMPLE receipts in the register');
  const list = (await c.get('/api/receipts')).json;
  assert.equal(list.sampleLoaded, true);
  assert.ok(list.receipts.some((r) => r.sample), 'the screen still shows them, marked Sample');
});

test('volunteers get 403 on every receipts read and write, and no receipt rides on what they can read', async () => {
  const d = await mgr.createPerson('Vic Private', { email: mail('vic'), phone: '604-555-0177', address: '8 Quiet St' });
  const g = await gift(mgr, d, 5000);
  const r = await receiptFor(mgr, g.id);
  for (const path of ['/api/receipts', `/api/receipts/${r.id}`, `/api/receipts/gift/${g.id}`,
    '/api/receipts/disclosure.csv', '/api/receipts/register.csv']) {
    const res = await raw(vol, path);
    assert.equal(res.status, 403, path);
    assert.ok(!res.text.includes(r.number) && !res.text.includes('Vic Private'), `nothing in the refusal: ${path}`);
  }
  assert.equal((await vol.action('receipt.send', { id: r.id })).status, 403);
  assert.equal((await vol.action('receipt.sendAll', {})).status, 403);
  const prof = await vol.get(`/api/persons/${d.id}`);
  assert.equal(prof.status, 200);
  assert.ok(!JSON.stringify(prof.json).includes(r.number), 'no receipt number on the profile they read');
  assert.equal(prof.json.person.email, null);
  const staffList = (await staff.get('/api/receipts')).json;
  assert.equal(staffList.canManage, false);
  assert.ok(staffList.receipts.some((x) => x.id === r.id));
  assert.ok(!JSON.stringify(staffList).includes(await tokenOf(r.id)), 'the list never carries donor links');
});

test('the sample campaign gets SAMPLE receipts, never emailed; clearing voids them; real numbers start at 0001', async () => {
  const { c, ws } = await campaign(`Sample ${tag}`);
  await withEmail(async (sent) => {
    const load = await c.post('/api/data/sample');
    assert.equal(load.status, 200, JSON.stringify(load.json));
    const list = (await c.get('/api/receipts')).json.receipts;
    assert.equal(list.length, load.json.gifts);
    assert.ok(list.every((r) => /^SAMPLE-\d{4}$/.test(r.number) && r.sample && r.status.word === 'Sample'));
    assert.equal((await db.query('select count(*)::int as n from jobs where workspace_id = $1', [ws])).rows[0].n, 0);
    assert.equal((await c.action('receipt.send', { id: list[0].id })).status, 409);
    const all = await c.action('receipt.sendAll', {});
    assert.equal(all.json.sent, 0);
    await runDueJobs(db, { workspaceId: ws });
    assert.equal(sent.length, 0, 'no sample receipt is ever emailed');
  });
  const clear = await c.req('DELETE', '/api/data/sample');
  assert.equal(clear.status, 200, JSON.stringify(clear.json));
  const after = (await c.get('/api/receipts')).json.receipts;
  assert.ok(after.length > 0 && after.every((r) => r.void));
  const p = await c.createPerson('Real Donor');
  const g = await gift(c, p, 2500);
  assert.equal((await receiptFor(c, g.id)).number, '2026-0001');
  await verified(c);
});

test('an unsent receipt follows the donor’s record; a sent one stays as it was sent', async () => {
  const d = await mgr.createPerson('Rhea Rename', { address: '1 Old Rd' });
  const g = await gift(mgr, d, 2200);
  const r = await receiptFor(mgr, g.id);
  assert.equal((await mgr.action('person.update', { id: d.id, name: 'Rhea Renamed', address: '2 New Rd', email: mail('rhea') })).status, 200);
  let doc = (await one(mgr, r.id)).doc;
  assert.deepEqual([doc.contributor, doc.address], ['Rhea Renamed', '2 New Rd']);
  await withEmail(async () => {
    assert.equal((await mgr.action('receipt.send', { id: r.id })).json.email, 'sent');
  });
  assert.equal((await mgr.action('person.update', { id: d.id, address: '3 Later Rd' })).status, 200);
  doc = (await one(mgr, r.id)).doc;
  assert.equal(doc.address, '2 New Rd', 'what the donor got');
  await verified(mgr);
});

test('the automatic email waits out the Undo: a gift undone in that minute never reaches the donor', async () => {
  const d = await mgr.createPerson('Una Undo', { email: mail('undo'), address: '11 Undo Ln' });
  await withEmail(async (sent) => {
    const g = await gift(mgr, d, 4000);
    const r = await receiptFor(mgr, g.id);
    assert.equal(r.status.code, 'queued', 'Money’s toast reads this: "receipt emails in a minute"');
    assert.equal((await mgr.action('gift.void', { id: g.id })).status, 200);
    await due(wsId);
    await runDueJobs(db, { workspaceId: wsId });
    assert.equal(sent.filter((m) => m.to[0] === mail('undo')).length, 0, 'nothing went');
    const v = (await one(mgr, r.id)).receipt;
    assert.deepEqual([v.status.line, v.emailed, v.can_send_void], ['Void — the gift was voided', false, false], 'no void notice to send');
    const job = (await db.query(`select status from jobs where workspace_id = $1 and kind = 'receipt.email' and payload->>'receipt_id' = $2`, [wsId, r.id])).rows[0];
    assert.equal(job.status, 'cancelled');
    assert.equal((await mgr.action('receipt.sendVoid', { id: r.id })).status, 409, 'never emailed: nothing to call back');
  });
  await verified(mgr);
});

test('a failure after the send never sends twice by itself; Send again goes with the same key (one email)', async () => {
  const d = await mgr.createPerson('Rory Retry', { email: mail('rory'), address: '12 Retry Rd' });
  const boom = { on: false };
  onHook('events', async (_tx, meta, events) => {
    if (boom.on && meta.action === 'receipt.autosend' && events.some((e) => e.payload?.email_status === 'sent')) {
      throw new Error('the database went away after the send');
    }
  });
  await withEmail(async (sent) => {
    const g = await gift(mgr, d, 6000);
    const r = await receiptFor(mgr, g.id);
    boom.on = true;
    await due(wsId);
    await runDueJobs(db, { workspaceId: wsId });
    assert.equal(sent.length, 1, 'the provider got it');
    assert.equal((await statusRow(r.id)).email_status, 'sending', 'committed before the provider call, so the retry knows');
    for (let i = 0; i < 3; i += 1) {
      await due(wsId);
      await runDueJobs(db, { workspaceId: wsId });
    }
    assert.equal(sent.length, 1, 'the retry finds "sending" and stops — never a second copy');
    let s1 = (await one(mgr, r.id)).receipt;
    assert.equal(s1.status.word, 'Sending');
    assert.equal(s1.can_send, false, 'no Send while it may still be on its way');
    // Minutes later, still no answer recorded: the screen says so.
    await db.query(`update receipts set updated_at = now() - interval '10 minutes' where id = $1`, [r.id]);
    s1 = (await one(mgr, r.id)).receipt;
    assert.deepEqual([s1.status.code, s1.status.line], ['unsure', 'Not sure it went — check with the donor']);
    assert.equal(s1.can_send, true);
    boom.on = false;
    const again = await mgr.action('receipt.send', { id: r.id });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.deepEqual([sent.length, sent.deduped], [1, [`receipt-${r.id}-1`]], 'same key: the provider sends it once');
    const done = (await one(mgr, r.id)).receipt;
    assert.deepEqual([done.status.word, done.sent_count], ['Sent', 1], 'the screen says what the donor has: one');
  });
  boom.on = false;
  await verified(mgr);
});

test('no home address: the receipt says "Needs address", is held, and goes by itself once the address is on file', async () => {
  const d = await mgr.createPerson('Nia Noaddress', { email: mail('nia'), city: 'Surrey' });
  await withEmail(async (sent) => {
    const g = await gift(mgr, d, 15000);
    let r = await receiptFor(mgr, g.id);
    assert.deepEqual([r.status.code, r.status.word, r.status.line], ['needs_address', 'Needs address', 'Waiting — needs address'],
      'a city alone is no home address');
    assert.equal(r.needs_address, true);
    assert.equal(r.can_send, false);
    assert.equal((await statusRow(r.id)).email_status, 'held');
    assert.equal((await db.query(`select count(*)::int as n from jobs where workspace_id = $1 and payload->>'receipt_id' = $2`, [wsId, r.id])).rows[0].n, 0);
    const needs = (await treas.get('/api/receipts/needs')).json.receipts;
    assert.ok(needs.some((x) => x.id === r.id && x.donor_name === 'Nia Noaddress'), 'Money → Needs you lists it');
    const send = await mgr.action('receipt.send', { id: r.id });
    assert.equal(send.status, 409);
    assert.match(send.json.error, /home address/);
    assert.equal((await mgr.action('receipt.sendAll', {})).status, 200);
    assert.equal(sent.filter((m) => m.to[0] === mail('nia')).length, 0, 'Send all leaves it waiting too');
    assert.equal((await mgr.action('person.update', { id: d.id, address: '9 Late St' })).status, 200);
    r = await receiptFor(mgr, g.id);
    assert.equal(r.status.word, 'Sending', 'queued the moment the address is on file');
    assert.equal(r.needs_address, false);
    await runDueJobs(db, { workspaceId: wsId });
    const got = sent.filter((m) => m.to[0] === mail('nia'));
    assert.equal(got.length, 1);
    assert.ok(got[0].text.includes('Home address: 9 Late St, Surrey'), got[0].text);
    assert.equal((await receiptFor(mgr, g.id)).status.word, 'Sent');
    assert.ok(!(await treas.get('/api/receipts/needs')).json.receipts.some((x) => x.id === r.id));
  });
  assert.equal((await vol.get('/api/receipts/needs')).status, 403);
  await verified(mgr);
});

test('a voided receipt the donor already got: send a void notice (once)', async () => {
  const d = await mgr.createPerson('Vic Voidnotice', { email: mail('vicv'), address: '13 Void Way' });
  await withEmail(async (sent) => {
    const g = await gift(mgr, d, 4000);
    const r = await receiptFor(mgr, g.id);
    await due(wsId);
    await runDueJobs(db, { workspaceId: wsId });
    assert.equal(sent.filter((m) => m.to[0] === mail('vicv')).length, 1);
    assert.equal((await mgr.action('gift.void', { id: g.id })).status, 200);
    let v = (await receiptFor(mgr, g.id));
    assert.deepEqual([v.void, v.emailed, v.can_send_void, v.status.line], [true, true, true, 'Void — the receipt was already emailed']);
    assert.equal((await vol.action('receipt.sendVoid', { id: r.id })).status, 403);
    const res = await staff.action('receipt.sendVoid', { id: r.id });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.email, 'sent');
    const notice = sent.filter((m) => m.to[0] === mail('vicv'))[1];
    assert.equal(notice.subject, `Receipt ${r.number} from Receipts ${tag} is void`);
    assert.ok(notice.text.includes('$40.00 contribution received October 1, 2026 was voided'), notice.text);
    assert.equal(notice.key, `receipt-void-${r.id}-1`);
    v = await receiptFor(mgr, g.id);
    assert.equal(v.can_send_void, false, 'once');
    assert.match(v.status.line, /^Void — void notice sent [A-Z][a-z]+ \d{1,2}, \d{4}$/);
    const ev = (await db.query(`select action, payload from events where workspace_id = $1 and entity_id = $2 and action = 'receipt.sendVoid'`, [wsId, r.id])).rows;
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.void_notice, 'sent');
  });
  // Email off: refused plainly.
  const d2 = await mgr.createPerson('Wes Offline', { email: mail('wes'), address: '14 Off St' });
  let r2;
  await withEmail(async () => {
    const g2 = await gift(mgr, d2, 3000);
    r2 = await receiptFor(mgr, g2.id);
    await due(wsId);
    await runDueJobs(db, { workspaceId: wsId });
    assert.equal((await mgr.action('gift.void', { id: g2.id })).status, 200);
  });
  const off = await mgr.action('receipt.sendVoid', { id: r2.id });
  assert.equal(off.status, 409);
  assert.match(off.json.error, /Email isn’t connected/);
  await verified(mgr);
});

test('card gifts are dated by the campaign’s day, not the UTC day', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_receipts';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_receipts';
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init) => (String(url) === 'https://api.stripe.com/v1/checkout/sessions'
    ? new Response(JSON.stringify({ id: `cs_tz_${tag}_${n}`, url: 'https://checkout.stripe.test/tz' }), { status: 200 })
    : realFetch(url, init));
  const pay = async (who, at) => {
    n += 1;
    const go = await pub('POST', `/d/${slug}`, new URLSearchParams({
      amount: '30', name: who, email: mail(who.toLowerCase().replace(/\W/g, '')), address: '15 Evening Rd, Surrey', ...eligible,
    }));
    assert.equal(go.status, 303);
    const p = (await mgr.get('/api/pledges')).json.pledges.find((x) => x.email === mail(who.toLowerCase().replace(/\W/g, '')));
    const body = JSON.stringify({ id: `evt_tz_${tag}_${n}`, type: 'checkout.session.completed', created: Math.floor(at / 1000), data: { object: {
      id: `cs_tz_${tag}_${n}`, mode: 'payment', payment_status: 'paid', amount_total: 3000, payment_intent: `pi_tz_${n}`, created: Math.floor(at / 1000),
      metadata: { pledge_id: p.id, workspace_id: wsId },
    } } });
    const hook = await pub('POST', '/api/public/stripe/webhook', body, { 'stripe-signature': stripeSign(body, 'whsec_receipts') });
    assert.equal(hook.status, 200, JSON.stringify(hook.json));
    return receiptFor(mgr, hook.json.gift_id);
  };
  try {
    // 7:30 pm Pacific on Oct 21 is 02:30 UTC on Oct 22.
    const evening = await pay('Eve Evening', Date.UTC(2026, 9, 22, 2, 30));
    assert.equal(evening.received_on, '2026-10-21');
    assert.ok((await one(mgr, evening.id)).doc.received_on === '2026-10-21');
    // 7 pm Pacific on Dec 31 stays in 2026's series and limit.
    const nye = await pay('Ned Newyear', Date.UTC(2027, 0, 1, 3, 0));
    assert.equal(nye.received_on, '2026-12-31');
    assert.match(nye.number, /^2026-\d{4}$/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

test('the books still verify across everything in this file', async () => {
  await verified(mgr);
  const kinds = (await db.query(
    `select distinct action from events where workspace_id = $1 and entity_type in ('receipt', 'receipt_settings') order by 1`, [wsId],
  )).rows.map((r) => r.action);
  for (const a of ['gift.log', 'gift.void', 'gift.restore', 'pledge.receive', 'stripe.payment', 'receipt.send', 'receipt.autosend', 'receipt.sendVoid', 'receipt.settings', 'person.update']) {
    assert.ok(kinds.includes(a), a);
  }
});
