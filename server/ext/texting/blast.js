// A text blast: one text to everyone on a list, through the campaign's
// Twilio number, by the same rules as a text from the Calls card — no
// opted-out number, no do-not-text or do-not-contact, inside quiet hours,
// the campaign named, "Reply STOP to opt out" on each — and filed in the
// Inbox like any text: a conversation per person, started by whoever sent
// the blast, so replies (and STOP) land where the desk reads them.
//
// Runs in the send path's phases (ext/abtests send.js deliver): claim a
// few rows 'sending' and commit; send each outside any transaction; record
// each answer. Outside quiet hours the run stops at once and says when
// sending opens (heldUntil): the send job comes back then. A number that
// opted out since the tap is left unsent and marked failed with why.
import { runAction, newId } from '../../lib/events.js';
import { textConfigured } from '../../lib/notify.js';
import { sendSms, publicBase } from './twilio.js';
import { settingsFor, quietState, isOptedOut, applyOptOut, tzOf } from './store.js';
import { withFooter, localMinutes, now as clock } from './rules.js';
import { askedRow, outcomeOf, recordOutcome, NO_TEXT_PROVIDER, DELIVER_ACTION } from '../abtests/send.js';

const BATCH = 10;

// When today's (or tomorrow's) window opens, as a Date — for the send job.
const opensAt = (quiet, workspace) => {
  const tz = tzOf(workspace);
  const t = clock();
  const minutesNow = localMinutes(t, tz);
  // Minutes until the window opens: later today, or tomorrow's start.
  const until = minutesNow < quiet.from * 60 ? quiet.from * 60 - minutesNow : 24 * 60 - minutesNow + quiet.from * 60;
  return new Date(t.getTime() + Math.max(until, 1) * 60_000);
};

export const deliverTexts = async (db, ctx, blast, { actorId = null, budgetMs = Infinity, max = Infinity } = {}) => {
  const workspaceId = ctx.workspaceId;
  const act = (fn) => runAction(db, { workspaceId, actorId, action: DELIVER_ACTION }, fn);
  const run = { sent: 0, failed: 0, skipped: 0, unsure: 0, claimed: 0, note: null, more: false, heldUntil: null };
  const t0 = Date.now();
  const base = publicBase();
  for (;;) {
    if (!textConfigured()) { run.note = NO_TEXT_PROVIDER; break; }
    const quiet = quietState(await settingsFor(db, workspaceId), ctx.workspace);
    if (quiet.now) {
      run.note = `Quiet hours — sending opens at ${quiet.opens}`;
      run.more = true;
      run.heldUntil = opensAt(quiet, ctx.workspace);
      break;
    }
    if (run.claimed >= max || Date.now() - t0 >= budgetMs) {
      run.more = (await db.query(
        `select 1 from blast_recipients where blast_id = $1 and workspace_id = $2 and ${askedRow()} limit 1`, [blast.id, workspaceId],
      )).rows.length > 0;
      break;
    }
    const { result: go } = await act(async (tx, emit) => {
      const rows = (await tx.query(
        `select id, phone, person_id, name, send_tries from blast_recipients
         where blast_id = $1 and workspace_id = $2 and ${askedRow()}
         order by created_at, id limit $3 for update skip locked`,
        [blast.id, workspaceId, Math.min(BATCH, max - run.claimed)],
      )).rows;
      const out = [];
      for (const r of rows) {
        // Opted out since the tap (STOP, or the desk's tag): never texted.
        const tags = r.person_id ? (await tx.query('select tags from persons where id = $1', [r.person_id])).rows[0]?.tags : null;
        const list = typeof tags === 'string' ? JSON.parse(tags) : (tags || []);
        if (list.includes('do-not-text') || list.includes('do-not-contact') || await isOptedOut(tx, workspaceId, r.phone)) {
          await tx.query(`update blast_recipients set status = 'failed', send_asked_at = null, send_tries = send_tries + 1 where id = $1 and workspace_id = $2`, [r.id, workspaceId]);
          emit('blast_recipient', r.id, 'update', { blast_id: blast.id, status: 'failed', reason: 'opted out' });
          run.failed += 1;
          continue;
        }
        // The conversation this text is filed in: the sender's with this person, else a new one.
        let conv = r.person_id ? (await tx.query(
          `select id from texting_conversations where workspace_id = $1 and person_id = $2 and started_by is not distinct from $3 and phone = $4 order by created_at limit 1`,
          [workspaceId, r.person_id, actorId, r.phone],
        )).rows[0] : null;
        if (!conv) {
          conv = { id: newId() };
          await tx.query(
            'insert into texting_conversations (id, workspace_id, person_id, phone, started_by) values ($1, $2, $3, $4, $5)',
            [conv.id, workspaceId, r.person_id || null, r.phone, actorId],
          );
          emit('texting_conversation', conv.id, 'create', { person_id: r.person_id || null, phone: r.phone, started_by: actorId, blast_id: blast.id });
        }
        const first = !(await tx.query(`select 1 from texting_messages where conversation_id = $1 and direction = 'out' limit 1`, [conv.id])).rows[0];
        await tx.query(
          `update blast_recipients set status = 'sending', sending_at = now(), send_asked_at = null where id = $1 and workspace_id = $2`,
          [r.id, workspaceId],
        );
        out.push({ ...r, conversation_id: conv.id, first });
      }
      if (out.length) emit('blast', blast.id, 'update', { sending: out.length });
      return { rows: out, empty: rows.length === 0 };
    });
    if (go.empty) break;
    for (const r of go.rows) {
      run.claimed += 1;
      const body = withFooter(blast.body);
      const msgId = newId();
      const res = await sendSms({ to: r.phone, body, statusCallback: base ? `${base}/api/public/twilio/sms-status/${msgId}` : undefined });
      const answer = res.ok ? { sent: true, status: 'sent' } : { sent: false, status: 'failed', detail: res.detail };
      const { status } = outcomeOf(answer);
      if (status === 'sent') run.sent += 1; else run.failed += 1;
      if (!run.note && answer.detail) run.note = answer.detail;
      await act(async (tx, emit) => {
        await tx.query(
          `insert into texting_messages (id, workspace_id, conversation_id, direction, phone, body, status, first, provider_sid, error, sent_by)
           values ($1, $2, $3, 'out', $4, $5, $6, $7, $8, $9, $10)`,
          [msgId, workspaceId, r.conversation_id, r.phone, body, status === 'sent' ? 'sent' : 'failed', r.first, res.sid || null, res.ok ? null : res.detail, actorId],
        );
        await tx.query('update texting_conversations set last_at = now() where id = $1 and workspace_id = $2', [r.conversation_id, workspaceId]);
        emit('texting_message', msgId, 'create', { conversation_id: r.conversation_id, direction: 'out', status: status === 'sent' ? 'sent' : 'failed', first: r.first, blast_id: blast.id });
        if (!res.ok && res.code === 21610) await applyOptOut(tx, emit, workspaceId, r.phone, { out: true, keyword: 'carrier' });
        const n = await recordOutcome(tx, workspaceId, r.id, answer, { from: 'sending' });
        if (n.affectedRows) emit('blast_recipient', r.id, 'update', { blast_id: blast.id, status });
      });
    }
  }
  return run;
};
