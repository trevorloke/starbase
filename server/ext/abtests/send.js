// The newsletter / press send path, tracked — shared by blast.send and
// blast.resend (actions/field.js), the send job that carries their sends on
// (SEND_JOB) and the A/B winner job (winner.js).
//
// Every recipient row carries a random, unguessable token. Each email goes
// out with the plain-text part it always had plus an HTML part: the same
// words, a 1×1 open pixel (/o/<token>.gif) and every link in the message
// rewritten to /c/<token>/<n>, which redirects only to link n as stored for
// that send (blast_links). The unsubscribe link is never rewritten.
//
// A/B: a send with two subject lines splits its list at random into group A
// and group B (10/20/30% each) and the rest. A and B go out now; the rest
// are held — never sent — until the winner job picks a subject.
//
// Every email carries an idempotency key — the send, the recipient row and
// how many times the service refused it (sendKey) — so a repeat after an
// unknown outcome (a crash, a timeout) is dropped by the service, and a try
// after a plain refusal is a new send. A row the service never answered for
// is 'sending' ("not sure it went"): never sent again by itself; Try again
// reaches it once it is 10 minutes old, with the same key.
import { z } from 'zod';
import { randomBytes, randomInt } from 'node:crypto';
import { emailConfigured, sendEmail, unsubscribeHeaders } from '../../lib/notify.js';
import { enqueueJob, jobRunnerOn, runJobsSoon } from '../../lib/jobs.js';
import { runAction } from '../../lib/events.js';

export const AB_MIN = 50;
export const AB_PCTS = [10, 20, 30];
export const AB_WAITS = [1, 2, 4, 12, 24];
export const AB_METRICS = ['opens', 'clicks'];
export const WINNER_JOB = 'abtests.winner';
export const SEND_JOB = 'abtests.send';
// sendEmail's own words when email isn't connected (the screen keys on them).
export const NO_PROVIDER = 'no email provider configured (set RESEND_API_KEY)';

export const abInput = z.object({
  subject_b: z.string().trim().min(1).max(300),
  pct: z.literal(AB_PCTS),
  wait_hours: z.literal(AB_WAITS),
  metric: z.enum(AB_METRICS),
});

// One rule for a send's status, shared by blast.send, blast.resend, the send
// job and the winner job: everyone sent → 'sent'; everyone failed (or no one
// left on it) → 'failed'; anything else — still saved because email wasn't
// connected, on its way, held for an A/B winner, a mix of sent and failed, or
// not sure — → 'queued'. The status alone can't say "partly sent", so each
// also answers exact counts:
//   counts: { total, sent, failed, queued, sending?, going? }
//   (total = sent + failed + queued + sending; sending only when there are
//   any; going — of those, on their way now (goingRow) — only when there are)
export const blastStatus = ({ total, sent, failed }) =>
  (total > 0 && sent === total ? 'sent' : failed === total ? 'failed' : 'queued');

// A 'sending' row this old never heard back: Try again may reach it (same key).
export const STALE_SENDING = "interval '10 minutes'";
export const retryable = (alias = '') => {
  const a = alias ? `${alias}.` : '';
  return `(${a}status in ('queued', 'failed') or (${a}status = 'sending' and ${a}sending_at < now() - ${STALE_SENDING}))`;
};
// Asked to go now and not claimed yet: the send job's (and the request's) to send.
export const askedRow = (alias = '') => `(${alias ? `${alias}.` : ''}send_asked_at is not null and ${retryable(alias)})`;
// On its way while a send job for the blast is on: asked, or claimed a moment
// ago and with the email service now. Never "not sent", never tried again.
export const goingRow = (alias = '') => {
  const a = alias ? `${alias}.` : '';
  return `(${askedRow(alias)} or (${a}status = 'sending' and ${a}sending_at >= now() - ${STALE_SENDING}))`;
};
// Whether a send job for a blast is waiting or running (SQL; the blast's id
// and workspace as expressions).
export const sendJobOn = (blastId, workspaceId) => `exists (select 1 from jobs j
  where j.workspace_id = ${workspaceId} and j.kind = '${SEND_JOB}' and j.status in ('pending', 'running')
    and j.payload->>'blast_id' = (${blastId})::text)`;

export const blastCounts = async (tx, workspaceId, blastId) => {
  const r = (await tx.query(
    `select count(*)::int as total,
            (count(*) filter (where status = 'sent'))::int as sent,
            (count(*) filter (where status = 'failed'))::int as failed,
            (count(*) filter (where status = 'queued'))::int as queued,
            (count(*) filter (where status = 'sending'))::int as sending,
            (count(*) filter (where ${goingRow()} and ${sendJobOn('$1::uuid', '$2')}))::int as going
     from blast_recipients where blast_id = $1 and workspace_id = $2`,
    [blastId, workspaceId],
  )).rows[0];
  return {
    total: r.total, sent: r.sent, failed: r.failed, queued: r.queued,
    ...(r.sending ? { sending: r.sending } : {}), ...(r.going ? { going: r.going } : {}),
  };
};

// The idempotency key of one email: send, recipient row, refusals so far.
export const sendKey = (blastId, row) => `blast-${blastId}-${row.id}-${Number(row.send_tries) || 0}`;

// What a sendEmail answer means for the row: 'sent'; 'queued' (email isn't
// connected — nothing went); 'failed' (the service said no: the next try is
// a new send); 'sending' (the service never answered — not sure it went).
export const outcomeOf = (res) => {
  if (res.status === 'sent') return { status: 'sent', refused: false };
  if (res.status === 'failed' && res.unknown) return { status: 'sending', refused: false };
  if (res.status === 'failed') return { status: 'failed', refused: true };
  return { status: 'queued', refused: false };
};

// Store one row's answer. A row someone else already settled is left alone.
export const recordOutcome = (tx, workspaceId, rowId, res, { token = null, from = null } = {}) => {
  const o = outcomeOf(res);
  return tx.query(
    `update blast_recipients set status = $3, token = coalesce($4, token),
       sent_at = case when $3 = 'sent' then now() else sent_at end,
       sending_at = case when $3 = 'sending' then now() else sending_at end,
       send_tries = send_tries + case when $5 then 1 else 0 end
     where id = $1 and workspace_id = $2 and ($6::text is null or status = $6)`,
    [rowId, workspaceId, o.status, token, o.refused, from],
  );
};

// Every newsletter identifies the sender and carries the recipient's own
// one-click unsubscribe link (/u/:subscriptionId); press carries the name.
export const blastText = (ctx, kind, body, subscriptionId) => body + (kind === 'newsletter'
  ? `\n\n—\nSent by ${ctx.workspace.name}.\nUnsubscribe: ${ctx.publicUrl || ''}/u/${subscriptionId}`
  : `\n\n—\n${ctx.workspace.name}`);

// 24 url-safe characters, 144 random bits.
export const newToken = () => randomBytes(18).toString('base64url');
export const TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;

// Links are the http(s) addresses typed in the message, in order, once each.
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const MAX_LINKS = 100;
const tidyUrl = (u) => {
  let s = u;
  // A full stop or a closing bracket after an address belongs to the sentence.
  for (;;) {
    const last = s.slice(-1);
    const opens = (ch) => s.split(ch).length - 1;
    if (/[.,;:!?*]/.test(last)) s = s.slice(0, -1);
    else if (last === ')' && opens('(') < opens(')')) s = s.slice(0, -1);
    else if (last === ']' && opens('[') < opens(']')) s = s.slice(0, -1);
    else break;
  }
  return s;
};
const isWebUrl = (s) => {
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
};
export const findLinks = (body) => {
  const out = [];
  for (const m of String(body ?? '').matchAll(URL_RE)) {
    const u = tidyUrl(m[0]);
    if (u.length <= 2000 && isWebUrl(u) && !out.includes(u)) out.push(u);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
};

export const saveLinks = async (tx, workspaceId, blastId, links) => {
  for (const [i, url] of links.entries()) {
    await tx.query(
      `insert into blast_links (workspace_id, blast_id, n, url) values ($1, $2, $3, $4)
       on conflict (blast_id, n) do nothing`,
      [workspaceId, blastId, i + 1, url],
    );
  }
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// The HTML part: the message's own words in paragraphs, its links tracked,
// the footer (unsubscribe untracked), and the open pixel last.
export const blastHtml = (ctx, kind, body, subscriptionId, token, links) => {
  const base = ctx.publicUrl || '';
  const linkify = (line) => {
    let out = '';
    let last = 0;
    for (const m of line.matchAll(URL_RE)) {
      const u = tidyUrl(m[0]);
      const n = links.indexOf(u) + 1;
      out += esc(line.slice(last, m.index));
      out += n > 0
        ? `<a href="${esc(`${base}/c/${token}/${n}`)}" style="color:#6d4aff">${esc(u)}</a>`
        : esc(u);
      last = m.index + u.length;
    }
    return out + esc(line.slice(last));
  };
  const paras = String(body).split(/\n[ \t]*\n/)
    .map((p) => `<p style="margin:0 0 16px">${p.split('\n').map(linkify).join('<br>')}</p>`)
    .join('');
  // This part is the tracked one, so it says so.
  const foot = kind === 'newsletter'
    ? `Sent by ${esc(ctx.workspace.name)}. We count opens and clicks.<br><a href="${esc(`${base}/u/${subscriptionId}`)}" style="color:#5d6481">Unsubscribe</a>`
    : `${esc(ctx.workspace.name)}. We count opens and clicks.`;
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background:#f4f5fa">'
    + '<div style="max-width:600px;margin:0 auto;padding:24px 16px;font:17px/1.55 system-ui,-apple-system,\'Segoe UI\',Roboto,Arial,sans-serif;color:#161a2e">'
    + paras
    + `<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #dde0ec;font-size:14px;color:#5d6481">${foot}</p>`
    + `<img src="${esc(`${base}/o/${token}.gif`)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`
    + '</div></body></html>';
};

export const composeBlast = (ctx, { kind, body, subscriptionId, token, links }) => ({
  text: blastText(ctx, kind, body, subscriptionId),
  html: blastHtml(ctx, kind, body, subscriptionId, token, links),
  // A newsletter's mail-app Unsubscribe button: the same /u link, by POST.
  headers: kind === 'newsletter' && subscriptionId ? unsubscribeHeaders(`${ctx.publicUrl || ''}/u/${subscriptionId}`) : undefined,
});

// Group A gets subject A, group B subject B, the rest the winner's.
export const subjectFor = (blast, group) =>
  (group === 'b' || (group === 'rest' && blast.ab_winner === 'b') ? blast.ab_subject_b : blast.subject);

// n recipients → n groups ('a' | 'b' | 'rest') in random order, pct% each to A and B.
export const abGroups = (n, pct) => {
  const size = Math.floor((n * pct) / 100);
  const g = Array.from({ length: n }, (_, i) => (i < size ? 'a' : i < 2 * size ? 'b' : 'rest'));
  for (let i = n - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [g[i], g[j]] = [g[j], g[i]];
  }
  return g;
};

// Rows still held: the rest of an A/B send, until it has a winner.
export const restReleased = (blast) => !blast.ab_status || !!blast.ab_winner;

export const abOf = (b) => (b?.ab_status ? {
  status: b.ab_status,
  subject_b: b.ab_subject_b,
  pct: b.ab_pct,
  wait_hours: b.ab_wait_hours,
  metric: b.ab_metric,
  decide_at: b.ab_decide_at || null,
  winner: b.ab_winner || null,
  decided_at: b.ab_decided_at || null,
  // What the winner was picked on: { metric, tie, a, b } (each group's
  // delivered / opened / clicked at that moment).
  result: (typeof b.ab_result === 'string' ? JSON.parse(b.ab_result) : b.ab_result) || null,
} : null);

// The winner by the chosen measure (opened or clicked, of delivered). A tie
// — the same whole percent, as the screen shows them, or a group that
// reached no one — sends A, and says it was a tie.
const pctOf = (n, of) => (of > 0 ? Math.round((100 * n) / of) : 0);
export const decide = (groups, metric) => {
  const pick = (g) => (metric === 'clicks' ? g.clicked : g.opened);
  const ra = pctOf(pick(groups.a), groups.a.delivered);
  const rb = pctOf(pick(groups.b), groups.b.delivered);
  if (!groups.a.delivered || !groups.b.delivered || ra === rb) return { winner: 'a', tie: true };
  return { winner: rb > ra ? 'b' : 'a', tie: false };
};

// Send a blast's asked rows (askedRow: a person asked for them to go now) in
// the same phases as the winner job, never holding the campaign lock while
// the email service is called. blast.send and blast.resend (actions/field.js)
// ask for their rows and commit, then send the first few in the request
// (their `after` step, for a few seconds: SEND_INLINE_MS); the send job
// (SEND_JOB, below) sends the rest, a few hundred per run. Ten at a time:
//   1. claim   each asked row → 'sending', no longer asked, committed before
//              the call. A newsletter subscriber who left the list since is
//              taken off the send, never emailed. A row someone else claimed
//              or settled meanwhile is left to them.
//   2. send    each claimed row, outside any transaction, with its key.
//   3. record  each answer in its own write; a row someone else settled
//              meanwhile is left alone.
// A crash leaves the claimed few 'sending' (not sure — Try again sends them
// with the same key once they are ten minutes old) and the rest asked: the
// send job carries on with those by itself. Never no record, never a second
// copy by itself. Each write is on the event log as blast.deliver by the
// person who sent.
// Stops after `max` rows or `budgetMs`; `more` says whether asked rows are
// left. Answers { sent, failed, skipped, unsure, claimed, note, more }.
export const DELIVER_ACTION = 'blast.deliver';
const BATCH = 10;
const anyAsked = async (db, workspaceId, blastId) => (await db.query(
  `select 1 from blast_recipients where blast_id = $1 and workspace_id = $2 and ${askedRow()} limit 1`,
  [blastId, workspaceId],
)).rows.length > 0;
export const deliver = async (db, ctx, blast, { actorId = null, budgetMs = Infinity, max = Infinity } = {}) => {
  const workspaceId = ctx.workspaceId;
  const act = (fn) => runAction(db, { workspaceId, actorId, action: DELIVER_ACTION }, fn);
  const links = findLinks(blast.body);
  const run = { sent: 0, failed: 0, skipped: 0, unsure: 0, claimed: 0, note: null, more: false };
  const t0 = Date.now();
  for (;;) {
    // Email disconnected since the tap: nothing is claimed; the rest stay not sent.
    if (!emailConfigured()) { run.note = NO_PROVIDER; break; }
    if (run.claimed >= max || Date.now() - t0 >= budgetMs) {
      run.more = await anyAsked(db, workspaceId, blast.id);
      break;
    }
    const { result: go } = await act(async (tx, emit) => {
      const rows = (await tx.query(
        `select id, email, token, ab_group, send_tries from blast_recipients
         where blast_id = $1 and workspace_id = $2 and ${askedRow()}
         order by created_at, id limit $3 for update skip locked`,
        [blast.id, workspaceId, Math.min(BATCH, max - run.claimed)],
      )).rows;
      const out = [];
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
        out.push({ ...r, token, subscriptionId });
      }
      if (out.length || gone) emit('blast', blast.id, 'update', { sending: out.length, unsubscribed: gone });
      return { rows: out, gone, empty: rows.length === 0 };
    });
    run.skipped += go.gone;
    if (go.empty) break;
    for (const r of go.rows) {
      run.claimed += 1;
      const res = await sendEmail({
        to: r.email,
        subject: subjectFor(blast, r.ab_group),
        ...composeBlast(ctx, { kind: blast.kind, body: blast.body, subscriptionId: r.subscriptionId, token: r.token, links }),
        idempotencyKey: sendKey(blast.id, r),
      });
      const { status } = outcomeOf(res);
      if (status === 'sent') run.sent += 1;
      else if (status === 'failed') run.failed += 1;
      else if (status === 'sending') run.unsure += 1;
      if (!run.note && res.detail) run.note = res.detail;
      await act(async (tx, emit) => {
        const n = await recordOutcome(tx, workspaceId, r.id, res, { from: 'sending' });
        if (n.affectedRows) emit('blast_recipient', r.id, 'update', { blast_id: blast.id, status });
      });
    }
  }
  return run;
};

// A send's status, counts and note, written from its rows (inside a write).
// The send's time is when its last email went. `quiet` — the run did nothing
// — writes only when the stored row disagrees with its rows (the finish of a
// run that stopped after its last email: everyone has it, the send still
// says otherwise), and keeps the note it has. Answers { blast, counts,
// status, wrote } (null when there is no such send). `note` may be a
// function of the counts.
export const settleBlast = async (tx, workspaceId, blastId, { note = null, quiet = false } = {}) => {
  const cur = (await tx.query('select * from blasts where id = $1 and workspace_id = $2 for update', [blastId, workspaceId])).rows[0];
  if (!cur) return null;
  const counts = await blastCounts(tx, workspaceId, blastId);
  const status = blastStatus(counts);
  if (quiet && cur.status === status && Number(cur.audience_count) === counts.total && (status !== 'sent' || cur.sent_at)) {
    return { blast: cur, counts, status, wrote: false };
  }
  const row = (await tx.query(
    `update blasts set status = $3, provider_note = $4, audience_count = $5,
       sent_at = case when $3 = 'sent'
         then coalesce((select max(r.sent_at) from blast_recipients r where r.blast_id = $1 and r.workspace_id = $2), now())
         else sent_at end
     where id = $1 and workspace_id = $2
     returning *`,
    [blastId, workspaceId, status,
      counts.total === 0 ? 'everyone on this send has unsubscribed'
        : quiet ? cur.provider_note : typeof note === 'function' ? note(counts) : note,
      counts.total],
  )).rows[0];
  return { blast: row, counts, status, wrote: true };
};

// After a run: the whole send's status, counts and note, in one write
// labelled by what the person asked for (blast.send / blast.resend).
// `payload` adds this run's numbers to its event. `done`: nothing asked is
// left — the tap's own job (`jobId`, the one waiting in case the request
// dies) has nothing to do and is cancelled. Not done: that job is due now
// (`jobId`), or the next run is queued (`next`, its payload), and runs
// straight away. Answers { blast (the row), counts, lastSeq }.
export const finishRun = async (db, ctx, {
  actorId = null, action, blastId, note = null, payload = {}, quiet = false, done = true, jobId = null, next = null,
}) => {
  const workspaceId = ctx.workspaceId;
  const { result, lastSeq } = await runAction(db, { workspaceId, actorId, action }, async (tx, emit) => {
    if (jobId) {
      await tx.query(
        done
          ? `update jobs set status = 'cancelled', done_at = now() where id = $1 and workspace_id = $2 and status = 'pending'`
          : `update jobs set run_at = now() where id = $1 and workspace_id = $2 and status = 'pending'`,
        [jobId, workspaceId],
      );
    }
    if (!done && next) await enqueueJob(tx, { workspaceId, kind: SEND_JOB, payload: next });
    const s = await settleBlast(tx, workspaceId, blastId, { note, quiet: quiet && done });
    if (s?.wrote) emit('blast', blastId, 'update', { ...payload, status: s.status, ...(done ? {} : { more: true }) });
    return { blast: s?.blast || null, counts: s?.counts || null };
  });
  if (!done) runJobsSoon();
  return { ...result, lastSeq };
};

// How long a tap's request sends before it hands the rest to the send job
// (STARBASE_SEND_INLINE_MS, default 5 s) — all of it when nothing would run
// that job (no job runner in this process: STARBASE_JOBS=off).
export const inlineMs = () => {
  const v = process.env.STARBASE_SEND_INLINE_MS;
  if (v != null && v !== '' && Number(v) >= 0) return Number(v);
  return jobRunnerOn() ? 5_000 : Infinity;
};
// The tap's send job, queued with the send: it waits long enough for the
// request to finish (its last ten can take 150 s with a hung email service),
// so it only runs when the request hands over or never got to finish.
export const queueSend = (tx, ctx, blastId, action) => enqueueJob(tx, {
  workspaceId: ctx.workspaceId,
  kind: SEND_JOB,
  runAt: new Date(Date.now() + 3 * 60_000).toISOString(),
  payload: { blast_id: blastId, base: ctx.publicUrl || '', actor_id: ctx.user?.id || null, action },
});

// This run's numbers on the summary event: blast.resend says how many it
// tried (resent); both say how each went.
export const runPayload = (action, run, extra = {}) => ({
  ...(action === 'blast.resend' ? { resent: run.claimed } : {}),
  sent: run.sent, failed: run.failed, unsubscribed: run.skipped,
  ...(run.unsure ? { unsure: run.unsure } : {}), ...extra,
});

// The send job: the rest of a tap's send, up to 200 per run
// (STARBASE_SEND_PER_RUN), then the next run straight away — so other
// background work (receipts, ladders) isn't kept waiting behind a big list.
// Its writes are the tapping person's, labelled as theirs (blast.send /
// blast.resend). A run with nothing left to send writes nothing, unless the
// send's status was never brought up to date (settleBlast).
const sendPerRun = () => Number(process.env.STARBASE_SEND_PER_RUN) || 200;
export const runSendJob = async (db, job) => {
  const { blast_id: blastId, base = '', actor_id: actorId = null, action = 'blast.send' } = job.payload || {};
  const workspaceId = job.workspace_id;
  const blast = (await db.query(
    'select id, kind, subject, body, ab_subject_b, ab_winner from blasts where id = $1 and workspace_id = $2',
    [blastId, workspaceId],
  )).rows[0];
  if (!blast) return;
  const ws = (await db.query('select name from workspaces where id = $1', [workspaceId])).rows[0];
  const ctx = { workspaceId, workspace: { name: ws?.name || '' }, publicUrl: base };
  const run = await deliver(db, ctx, blast, { actorId, max: sendPerRun() });
  await finishRun(db, ctx, {
    actorId, action, blastId, note: run.note, payload: runPayload(action, run),
    quiet: run.claimed === 0 && run.skipped === 0, done: !run.more, next: run.more ? job.payload : null,
  });
};

// A new A/B send: store its two subjects and settings. Saved while email
// isn't connected (it starts on Send now); otherwise the test starts now.
export const openTest = async (tx, ctx, blastId, ab, live) => {
  const row = (await tx.query(
    `update blasts set ab_subject_b = $3, ab_pct = $4, ab_wait_hours = $5, ab_metric = $6, ab_status = 'saved'
     where id = $1 and workspace_id = $2 returning *`,
    [blastId, ctx.workspaceId, ab.subject_b, ab.pct, ab.wait_hours, ab.metric],
  )).rows[0];
  return live ? startTest(tx, ctx, blastId) : abOf(row);
};

// A and B are out: the winner is picked when the wait ends (one job per send).
export const startTest = async (tx, ctx, blastId) => {
  const row = (await tx.query(
    `update blasts set ab_status = 'testing', ab_started_at = now(),
       ab_decide_at = now() + make_interval(hours => ab_wait_hours)
     where id = $1 and workspace_id = $2 and ab_status = 'saved' returning *`,
    [blastId, ctx.workspaceId],
  )).rows[0];
  if (!row) return null;
  await enqueueJob(tx, {
    workspaceId: ctx.workspaceId,
    kind: WINNER_JOB,
    runAt: new Date(row.ab_decide_at).toISOString(),
    payload: { blast_id: blastId, base: ctx.publicUrl || '' },
    key: `${WINNER_JOB}:${blastId}`,
  });
  return abOf(row);
};

// Delivered / opened / clicked per test group. A click counts as an open
// (no one clicks a link in an email they haven't opened).
export const groupStats = async (tx, workspaceId, blastId) => {
  const zero = () => ({ delivered: 0, opened: 0, clicked: 0 });
  const out = { a: zero(), b: zero() };
  const { rows } = await tx.query(
    `select ab_group,
            (count(*) filter (where status = 'sent'))::int as delivered,
            (count(*) filter (where status = 'sent' and (first_open_at is not null or first_click_at is not null)))::int as opened,
            (count(*) filter (where status = 'sent' and first_click_at is not null))::int as clicked
     from blast_recipients where blast_id = $1 and workspace_id = $2 and ab_group in ('a', 'b')
     group by ab_group`,
    [blastId, workspaceId],
  );
  for (const r of rows) out[r.ab_group] = { delivered: r.delivered, opened: r.opened, clicked: r.clicked };
  return out;
};
