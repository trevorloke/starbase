// The A/B winner: when a test's wait ends, compare A and B by the chosen
// measure (opened or clicked, of delivered) and pick the better one — a tie
// (the same whole percent, or a group that reached no one) sends A and says
// so — then send its subject to everyone held back.
//
// The sends never hold the campaign's write lock: each step is its own short
// write through runAction (system actor), so door knocks and calls go on
// while the rest go out.
//   1. decide    'testing' → 'decided', winner and the numbers it was picked
//                on (blast.ab_winner). Once: a decided test is never decided
//                again.
//   2. claim     up to 10 held rows 'queued' → 'sending', committed before the
//                email service is called (blast.ab_rest). A subscriber who
//                left the list since is taken off the send, never emailed.
//   3. send      each claimed row, outside any transaction, with its
//                idempotency key (send.js sendKey).
//   4. record    each answer in its own write; a row someone else settled
//                meanwhile is left alone.
//   5. finish    the send's status and counts — also on a retry that had
//                nothing left to send, when the send still says otherwise
//                (a run that stopped after its last email: send.js
//                settleBlast).
// One run sends at most 200 (STARBASE_AB_SEND_PER_RUN), then leaves the
// next run queued, so other background work (receipts, ladders) isn't kept
// waiting behind a big list.
// A retry (a deploy, a dropped connection) carries on with the rows still
// 'queued': a 'sending' or 'sent' row is never emailed again by itself.
// Without email connected nothing is claimed: the rest stay saved
// (released, not held) and go out on Send now.
import { runAction } from '../../lib/events.js';
import { emailConfigured, sendEmail } from '../../lib/notify.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import {
  NO_PROVIDER, WINNER_JOB, composeBlast, decide, findLinks, groupStats, newToken, outcomeOf,
  recordOutcome, saveLinks, sendKey, settleBlast, subjectFor,
} from './send.js';
import { loadAttachments } from './attach.js';

const BATCH = 10;
const perRun = () => Number(process.env.STARBASE_AB_SEND_PER_RUN) || 200;

export const pickWinner = async (db, job) => {
  const { blast_id: blastId, base = '' } = job.payload || {};
  const workspaceId = job.workspace_id;
  const act = (action, fn) => runAction(db, { workspaceId, actorId: null, action }, fn);

  // 1. Decide.
  const { result: blast } = await act('blast.ab_winner', async (tx, emit) => {
    const b = (await tx.query(
      'select * from blasts where id = $1 and workspace_id = $2 for update',
      [blastId, workspaceId],
    )).rows[0];
    if (!b) return null;
    if (b.ab_status === 'decided') return b; // a retry: carry on with what's left
    if (b.ab_status !== 'testing') return null;
    const groups = await groupStats(tx, workspaceId, blastId);
    const { winner, tie } = decide(groups, b.ab_metric);
    const result = { metric: b.ab_metric, tie, a: groups.a, b: groups.b };
    await tx.query(
      `update blasts set ab_status = 'decided', ab_winner = $3, ab_decided_at = now(), ab_result = $4
       where id = $1 and workspace_id = $2`,
      [blastId, workspaceId, winner, JSON.stringify(result)],
    );
    await saveLinks(tx, workspaceId, blastId, findLinks(b.body));
    emit('blast', blastId, 'update', { ab_winner: winner, ...result });
    return { ...b, ab_status: 'decided', ab_winner: winner, decidedNow: true };
  });
  if (!blast) return;

  const ws = (await db.query('select name from workspaces where id = $1', [workspaceId])).rows[0];
  const ctx = { workspaceId, workspace: { name: ws?.name || '' }, publicUrl: base };
  const links = findLinks(blast.body);
  const attachments = await loadAttachments(db, workspaceId, { blastId });
  const unsubFor = (r) => (r.subscriptionId ? `${base}/u/${r.subscriptionId}` : blast.kind === 'eblast' ? `${base}/bu/${r.id}` : null);
  const subject = subjectFor(blast, 'rest');
  const run = { claimed: 0, sent: 0, failed: 0, unsure: 0, skipped: 0, note: null };
  let more = false;

  // 2–4. Claim a few, send them, record each answer; again until none are left.
  while (emailConfigured()) {
    if (run.claimed >= perRun()) { more = true; break; }
    const { result: claim } = await act('blast.ab_rest', async (tx, emit) => {
      const rows = (await tx.query(
        `select id, email, token, send_tries from blast_recipients
         where blast_id = $1 and workspace_id = $2 and ab_group = 'rest' and status = 'queued'
         order by created_at, id limit $3 for update skip locked`,
        [blastId, workspaceId, Math.min(BATCH, perRun() - run.claimed)],
      )).rows;
      const go = [];
      let gone = 0;
      for (const r of rows) {
        let subscriptionId = null;
        if (blast.kind === 'newsletter') {
          const sub = (await tx.query(
            'select id, status from subscriptions where workspace_id = $1 and email = $2',
            [workspaceId, String(r.email).toLowerCase()],
          )).rows[0];
          if (!sub || sub.status !== 'subscribed') {
            await tx.query('delete from blast_recipients where id = $1 and workspace_id = $2', [r.id, workspaceId]);
            gone += 1;
            continue;
          }
          subscriptionId = sub.id;
        }
        const token = r.token || newToken();
        await tx.query(
          `update blast_recipients set status = 'sending', sending_at = now(), token = $3, send_asked_at = null
           where id = $1 and workspace_id = $2`,
          [r.id, workspaceId, token],
        );
        go.push({ ...r, token, subscriptionId });
      }
      if (go.length || gone) emit('blast', blastId, 'update', { sending: go.length, unsubscribed: gone });
      return { go, gone, empty: rows.length === 0 };
    });
    run.skipped += claim.gone;
    if (claim.empty) break;
    for (const r of claim.go) {
      run.claimed += 1;
      const res = await sendEmail({
        to: r.email,
        subject,
        ...composeBlast(ctx, { kind: blast.kind, body: blast.body, unsubscribeUrl: unsubFor(r), token: r.token, links, attachments }),
        idempotencyKey: sendKey(blastId, r),
      });
      const { status } = outcomeOf(res);
      if (status === 'sent') run.sent += 1;
      else if (status === 'failed') run.failed += 1;
      else if (status === 'sending') run.unsure += 1;
      if (!run.note && res.detail) run.note = res.detail;
      await act('blast.ab_rest', async (tx, emit) => {
        const n = await recordOutcome(tx, workspaceId, r.id, res, { from: 'sending' });
        if (n.affectedRows) emit('blast_recipient', r.id, 'update', { blast_id: blastId, status });
      });
    }
  }

  // 5. Finish: the whole send's status and counts. A retry that found
  // nothing to do writes nothing — unless the send still says otherwise
  // (the last run stopped after its last email, before this write).
  const quiet = !blast.decidedNow && run.claimed === 0 && run.skipped === 0 && !more;
  await act('blast.ab_rest', async (tx, emit) => {
    // The rest of a big list: the next run, right away.
    if (more) await enqueueJob(tx, { workspaceId, kind: WINNER_JOB, payload: { blast_id: blastId, base } });
    const note = (counts) => run.note || (!emailConfigured() && counts.queued > 0 ? NO_PROVIDER : null);
    const s = await settleBlast(tx, workspaceId, blastId, { note, quiet });
    if (!s?.wrote) return;
    emit('blast', blastId, 'update', {
      ab_winner: blast.ab_winner, rest: run.claimed, sent: run.sent, failed: run.failed,
      unsure: run.unsure, unsubscribed: run.skipped, status: s.status, ...(more ? { more: true } : {}),
    });
  });
  if (more) runJobsSoon();
};
