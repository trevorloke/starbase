// The receipts engine.
//
// Issuing: the events hook sees every write's events before they are
// chained. Every way a gift enters the books — a desk gift (gift.log), a
// pledge marked paid (pledge.receive), a Stripe payment (stripe.payment), the
// sample campaign (sample.load) — goes through lib/gifts.js logGift, which
// emits ('gift', id, 'create'). The receipt is numbered and written in that
// same transaction, so the gift and its receipt commit together or not at
// all, and no core money code changes. ('gift', id, 'void') voids it,
// ('gift', id, 'restore') un-voids it, and ('person', id, 'update') keeps an
// unsent receipt's name and address current.
//
// Sending: a receipt whose donor has an email and a home address, issued
// while email is connected, gets one 'receipt.email' job (keyed by receipt,
// so once) due a minute later — after the gift's Undo. With no address it is
// held ('held') and queued when the address is added. The job works in three
// steps, each write through runAction (system actor) so it is on the hash
// chain: (1) claim — 'queued' → 'sending', committed before the provider is
// called; (2) send, outside any transaction, with an idempotency key of the
// receipt and its send count; (3) record what the provider said. A retry
// finds 'sending' (or 'sent') and leaves it: only a person's Send sends
// again, with the same key, so the donor never gets a second copy by itself.
// A provider refusal is tried again (three tries in all), then the receipt
// says "Not sent — the email failed" and waits for Send again.
import { runAction } from '../../lib/events.js';
import { emailConfigured, sendEmail } from '../../lib/notify.js';
import {
  loadSettings, issueReceipt, voidReceipt, restoreReceipt, refreshForPerson, refreshDonor, donorEmail,
  composeReceipt, sendKey,
} from './core.js';

export const SEND_ACTION = 'receipt.autosend';
const EMAIL_TRIES = 3;

export const onEvents = async (tx, meta, events) => {
  let settings = null;
  const ctx = { workspaceId: meta.workspaceId, emit: meta.emit, sample: meta.action === 'sample.load' };
  for (const ev of events) {
    if (ev.entityType === 'gift') {
      if (ev.op === 'create') {
        settings ??= await loadSettings(tx, meta.workspaceId);
        await issueReceipt(tx, { ...ctx, settings }, { id: ev.entityId, ...ev.payload });
      } else if (ev.op === 'void') {
        await voidReceipt(tx, ctx, ev.entityId);
      } else if (ev.op === 'restore') {
        await restoreReceipt(tx, ctx, ev.entityId);
      }
    } else if (ev.entityType === 'person' && ev.op === 'update') {
      await refreshUnderSavepoint(tx, ctx, ev.entityId);
    }
  }
};

// Person updates ride on door knocks and profile edits: a fault in keeping
// an unsent receipt's name current must never cost one. It runs under a
// savepoint, and its events join the chain only if it all went through.
// (Issuing, voiding and restoring stay strict: a gift and its receipt
// commit together or not at all.)
const refreshUnderSavepoint = async (tx, ctx, personId) => {
  const held = [];
  await tx.query('savepoint receipts_refresh');
  try {
    await refreshForPerson(tx, { ...ctx, emit: (...e) => held.push(e) }, personId);
    await tx.query('release savepoint receipts_refresh');
    for (const e of held) ctx.emit(...e);
  } catch (err) {
    await tx.query('rollback to savepoint receipts_refresh');
    await tx.query('release savepoint receipts_refresh');
    console.error('receipts: keeping a receipt’s donor current skipped —', err.message);
  }
};

// The one automatic email for a receipt.
export const runEmailJob = async (db, job) => {
  const receiptId = job.payload?.receipt_id;
  if (!receiptId) return;
  const base = process.env.STARBASE_PUBLIC_URL || null;
  const ws = job.workspace_id;
  const act = (fn) => runAction(db, { workspaceId: ws, actorId: null, action: SEND_ACTION }, fn);

  // 1. Claim it: 'queued' → 'sending', committed before the provider call.
  const { result: claim } = await act(async (tx, emit) => {
    const meta = { workspaceId: ws, emit };
    const r = (await tx.query('select * from receipts where id = $1 and workspace_id = $2 for update', [receiptId, ws])).rows[0];
    // 'sending' or 'sent' means an earlier try reached the provider: never again by itself.
    if (!r || r.voided_at || r.sample || r.email_status !== 'queued') return { skipped: true };
    const email = await donorEmail(tx, ws, r.person_id);
    if (!email || !emailConfigured()) {
      // Nothing was sent; the receipt says why (No email on file / email
      // isn't connected) and waits for a person to send it.
      await tx.query('update receipts set email_status = null, updated_at = now() where id = $1', [r.id]);
      emit('receipt', r.id, 'update', { number: r.number, email_status: null, reason: email ? 'email not connected' : 'no email on file' });
      return { skipped: true };
    }
    const fresh = await refreshDonor(tx, meta, r);
    if (!fresh.donor_address) {
      // The address went missing: held again until it is on file.
      await tx.query(`update receipts set email_status = 'held', updated_at = now() where id = $1`, [r.id]);
      emit('receipt', r.id, 'update', { number: r.number, email_status: 'held', reason: 'needs address' });
      return { skipped: true };
    }
    await tx.query(`update receipts set email_status = 'sending', updated_at = now() where id = $1`, [r.id]);
    emit('receipt', r.id, 'update', { number: r.number, email_status: 'sending' });
    return { email, number: r.number, key: sendKey(fresh), ...(await composeReceipt(tx, ws, fresh, base)) };
  });
  if (!claim || claim.skipped) return;

  // 2. Send — outside any transaction.
  const res = await sendEmail({ to: claim.email, subject: claim.subject, text: claim.text, idempotencyKey: claim.key });
  const retry = res.status === 'failed' && job.attempts < EMAIL_TRIES;

  // 3. Record what the provider said. If this step fails the job's retry
  // finds 'sending' and stops; the receipt then says "Not sure it went".
  await act(async (tx, emit) => {
    const r = (await tx.query('select * from receipts where id = $1 and workspace_id = $2 for update', [receiptId, ws])).rows[0];
    // A person's Send recorded it meanwhile (same key, so one email): leave it.
    if (!r || r.email_status !== 'sending') return { skipped: true };
    const status = res.status === 'sent' ? 'sent' : res.status === 'failed' ? (retry ? 'queued' : 'failed') : null;
    await tx.query(
      `update receipts set email_status = $2, email_note = $3,
         sent_at = case when $2 = 'sent' then now() else sent_at end,
         sent_count = sent_count + case when $2 = 'sent' then 1 else 0 end, updated_at = now()
       where id = $1`,
      [r.id, status, res.detail || null],
    );
    emit('receipt', r.id, 'update', { number: r.number, emailed: status === 'sent', email_status: status ?? res.status, again: Number(r.sent_count) > 0 });
    return { status };
  });
  // A refusal before the last try: the runner tries again later (the receipt
  // is 'queued' again and says Sending).
  if (retry) throw new Error(res.detail || 'email failed');
};
