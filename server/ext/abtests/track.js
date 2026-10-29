// Open and click tracking — public, no sign-in, linked from sent email only.
//   GET /o/<token>.gif   the 1×1 open pixel
//   GET /c/<token>/<n>   link n of that send: counts the click, then 302s to
//                        the address stored for that send — never anywhere
//                        else (an unknown token or link number is a 404).
//
// A hit is one write to that recipient's row and never takes the campaign's
// write lock, so a burst of opens can't queue behind a door knock or a send
// (or use up the database's connections waiting). A recipient's first open
// and first click go on the campaign's hash chain a moment later: the hit
// schedules the 'abtests.log' job, which writes them through runAction as the
// system (actor null) — the 'public.open' / 'public.click' events, one per
// recipient. Later ones are counted on the row only.
// A row that was never sent (saved, held for a winner) records nothing, and
// a repeat within 30 seconds is the same open or click (no write at all).
// A click that looks like a mail scanner following links — no browser user
// agent, a known scanner's, or within 15 seconds of the email going out —
// still goes to the link but isn't counted.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { newId, runAction } from '../../lib/events.js';
import { TOKEN_RE } from './send.js';
import { serveMedia } from './media.js';

export const publicRoutes = new Hono();
// A picture in a message's body, for every mail app that opens it.
publicRoutes.get('/media/:id', async (c) => serveMedia(c, await getDb()));
export const LOG_JOB = 'abtests.log';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const NO_STORE = 'no-store, no-cache, must-revalidate, private';

const REPEAT_S = 30;
const SCANNER_S = 15;
const recent = (ts) => !!ts && Date.now() - new Date(ts).getTime() < REPEAT_S * 1000;

// Browsers (and the apps that open links in one) say "Mozilla/…"; scanners
// and scripts often don't, or name themselves.
const SCANNER_UA = /bot\b|bot\/|crawl|spider|scan|preview|headless|python|curl|wget|go-http|java\/|okhttp|libwww|httpclient|axios|node-fetch|undici|proofpoint|mimecast|barracuda|safelinks|urldefense|forcepoint|symantec|trend ?micro|sophos|ironport|zscaler|fireeye/i;
export const looksLikeScanner = (ua) => !ua || !/^Mozilla\//.test(ua) || SCANNER_UA.test(ua);

const recipientBy = async (db, token) => (await db.query(
  'select id, workspace_id, blast_id, status, last_open_at, last_click_at from blast_recipients where token = $1',
  [token],
)).rows[0];

// The first open or click waits for the log job; one pending job per
// campaign is enough (it logs every one not logged yet).
const scheduleLog = (db, workspaceId) => db.query(
  `insert into jobs (id, workspace_id, kind, run_at, payload)
   select $1, $2, $3, now(), '{}'::jsonb
   where not exists (select 1 from jobs where workspace_id = $2 and kind = $3 and status = 'pending')`,
  [newId(), workspaceId, LOG_JOB],
);

const countOpen = async (db, r) => {
  const row = (await db.query(
    `update blast_recipients set opens = opens + 1, last_open_at = now(), first_open_at = coalesce(first_open_at, now())
     where id = $1 and workspace_id = $2 and status = 'sent'
       and (last_open_at is null or last_open_at < now() - make_interval(secs => ${REPEAT_S}))
     returning opens`,
    [r.id, r.workspace_id],
  )).rows[0];
  if (row && Number(row.opens) === 1) await scheduleLog(db, r.workspace_id);
};

const countClick = async (db, r, n) => {
  const row = (await db.query(
    `update blast_recipients set clicks = clicks + 1, last_click_at = now(),
       first_click_at = coalesce(first_click_at, now()), first_click_n = coalesce(first_click_n, $3)
     where id = $1 and workspace_id = $2 and status = 'sent'
       and (last_click_at is null or last_click_at < now() - make_interval(secs => ${REPEAT_S}))
       and (sent_at is null or sent_at < now() - make_interval(secs => ${SCANNER_S}))
     returning clicks`,
    [r.id, r.workspace_id, n],
  )).rows[0];
  if (row && Number(row.clicks) === 1) await scheduleLog(db, r.workspace_id);
};

publicRoutes.get('/o/:file', async (c) => {
  const m = /^([A-Za-z0-9_-]{24})\.gif$/.exec(c.req.param('file') || '');
  if (m) {
    try {
      const db = await getDb();
      const r = await recipientBy(db, m[1]);
      if (r?.status === 'sent' && !recent(r.last_open_at)) await countOpen(db, r);
    } catch (e) {
      console.error('open pixel:', e.message);
    }
  }
  return c.body(GIF, 200, { 'Content-Type': 'image/gif', 'Cache-Control': NO_STORE, Pragma: 'no-cache' });
});

const notFound = (c) => c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link not found</title>
<style>body{margin:0;background:#f4f5fa;color:#161a2e;font:17px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}main{max-width:520px;margin:0 auto;padding:28px 16px}h1{font-size:26px;font-weight:800;margin:0}@media(prefers-color-scheme:dark){body{background:#0d1226;color:#e8eaf6}}</style>
</head><body><main><h1>Link not found.</h1></main></body></html>`, 404, { 'Cache-Control': NO_STORE });

publicRoutes.get('/c/:token/:n', async (c) => {
  const token = c.req.param('token') || '';
  const nRaw = c.req.param('n') || '';
  if (!TOKEN_RE.test(token) || !/^[1-9]\d{0,3}$/.test(nRaw)) return notFound(c);
  const n = Number(nRaw);
  const db = await getDb();
  const row = (await db.query(
    `select r.id, r.workspace_id, r.blast_id, r.status, r.last_click_at, l.url
     from blast_recipients r
     join blast_links l on l.blast_id = r.blast_id and l.workspace_id = r.workspace_id and l.n = $2
     where r.token = $1`,
    [token, n],
  )).rows[0];
  if (!row || !/^https?:\/\//i.test(row.url)) return notFound(c);
  if (row.status === 'sent' && !recent(row.last_click_at) && !looksLikeScanner(c.req.header('user-agent'))) {
    try {
      await countClick(db, row, n);
    } catch (e) {
      console.error('click:', e.message);
    }
  }
  c.header('Cache-Control', NO_STORE);
  // The page they land on never sees the tracking address.
  c.header('Referrer-Policy', 'no-referrer');
  return c.redirect(row.url, 302);
});

// The log job: every first open and first click not on the hash chain yet,
// a few hundred per write, oldest first.
const LOG_BATCH = 500;
const KINDS = [
  { action: 'public.open', first: 'first_open_at', logged: 'open_logged_at', payload: () => ({ opened: true }) },
  { action: 'public.click', first: 'first_click_at', logged: 'click_logged_at', payload: (r) => ({ clicked: r.first_click_n }) },
];
export const logHits = async (db, job) => {
  const workspaceId = job.workspace_id;
  for (const k of KINDS) {
    for (;;) {
      const { result: n } = await runAction(db, { workspaceId, actorId: null, action: k.action }, async (tx, emit) => {
        const rows = (await tx.query(
          `select id, blast_id, first_click_n from blast_recipients
           where workspace_id = $1 and ${k.first} is not null and ${k.logged} is null
           order by ${k.first}, id limit $2`,
          [workspaceId, LOG_BATCH],
        )).rows;
        if (rows.length === 0) return 0;
        for (const r of rows) emit('blast_recipient', r.id, 'update', { blast_id: r.blast_id, ...k.payload(r) });
        await tx.query(
          `update blast_recipients set ${k.logged} = now() where workspace_id = $1 and id = any($2::uuid[])`,
          [workspaceId, rows.map((r) => r.id)],
        );
        return rows.length;
      });
      if (n < LOG_BATCH) break;
    }
  }
};
