// /lu/:runId — the unsubscribe at the foot of every ladder email.
//   GET   asks: one "Unsubscribe" button (mail scanners open links by
//         themselves, so opening the link never unsubscribes anyone)
//   POST  does it — the button, or a mail app's one-click unsubscribe
//         (the List-Unsubscribe-Post header on every ladder email)
// It uses the newsletter's own list: an address on it is marked
// unsubscribed there, so newsletters and every ladder email stop alike. An
// address that was never on the list gets no list row; the person is
// flagged do-not-email instead (email steps skip them). Either way a later
// signup is the only way back on. A system action, on the hash chain like /u.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { runAction } from '../../lib/events.js';
import { NO_EMAIL_TAG, noEmail, tagsOf } from './shape.js';

export const publicRoutes = new Hono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// The public pages' look (routes/public.js): the campaign name big, one line.
const page = (campaign, title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}${campaign ? ` · ${esc(campaign)}` : ''}</title>
<style>
  :root{--paper:#f8f6ef;--card:#fffdf7;--ink:#171410;--ink2:#5d5749;--rule:#d6d0bf;--mark:#f2c40f}
  @media(prefers-color-scheme:dark){:root{--paper:#15120c;--card:#1d1a13;--ink:#ece7da;--ink2:#a59e8c;--rule:#3a362a;--mark:#d9b60e}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:18px/1.5 Georgia,'Times New Roman',serif}
  main{max-width:520px;margin:0 auto;padding:28px 16px 56px}
  .camp{font-size:30px;font-weight:700;line-height:1.1;margin:0 0 24px;padding-bottom:12px;border-bottom:4px solid var(--mark);overflow-wrap:anywhere}
  h1{font-size:26px;line-height:1.2;margin:0 0 12px}
  .done{border:1px solid var(--rule);border-left:4px solid var(--mark);background:var(--card);padding:18px;margin-top:16px}
  form{margin-top:8px}
  button{display:block;width:100%;min-height:56px;margin-top:24px;font:700 15px/1.2 ui-monospace,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;background:var(--mark);color:#171410;border:0;padding:16px 22px;border-radius:4px;cursor:pointer}
  button:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
  footer{margin-top:40px;border-top:1px solid var(--rule);padding-top:12px;font:13px/1.6 ui-monospace,Menlo,monospace;color:var(--ink2)}
</style></head><body><main>
${campaign ? `<div class="camp">${esc(campaign)}</div>` : ''}
${inner}
<footer>Powered by Starbase</footer>
</main></body></html>`;

const bad = (c) => c.html(page(null, 'Unsubscribe',
  "<h1>This unsubscribe link isn't valid — reply to the email to be removed.</h1>"), 404);

// The run, its person's address, and whether that address is already off.
const load = async (db, id) => {
  if (!UUID.test(id)) return null;
  const row = (await db.query(
    `select r.id, r.workspace_id, p.email, w.name from ladder_runs r
     join persons p on p.id = r.person_id join workspaces w on w.id = r.workspace_id
     where r.id = $1`,
    [id],
  )).rows[0];
  const email = String(row?.email || '').trim().toLowerCase();
  return row && email ? { ...row, email } : null;
};
const isOff = async (db, ws, email) => {
  const sub = (await db.query('select status from subscriptions where workspace_id = $1 and email = $2', [ws, email])).rows[0];
  if (sub) return sub.status === 'unsubscribed';
  const people = (await db.query(
    'select tags from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null', [ws, email],
  )).rows;
  return people.length > 0 && people.every(noEmail);
};
const done = (c, row) => c.html(page(row.name, 'Unsubscribed',
  `<h1>Unsubscribed.</h1><div class="done">You won't receive further newsletters or automatic emails from ${esc(row.name)}.</div>`));

publicRoutes.get('/lu/:id', async (c) => {
  const db = await getDb();
  const row = await load(db, c.req.param('id'));
  if (!row) return bad(c);
  if (await isOff(db, row.workspace_id, row.email)) return done(c, row);
  return c.html(page(row.name, 'Unsubscribe', `<h1>Unsubscribe from ${esc(row.name)}?</h1>
<form method="post" action="/lu/${esc(row.id)}"><button type="submit">Unsubscribe</button></form>`));
});

publicRoutes.post('/lu/:id', async (c) => {
  const db = await getDb();
  const row = await load(db, c.req.param('id'));
  if (!row) return bad(c);
  const ws = row.workspace_id;
  await runAction(db, { workspaceId: ws, actorId: null, action: 'public.unsubscribe' }, async (tx, emit) => {
    const sub = (await tx.query(
      'select id, status from subscriptions where workspace_id = $1 and email = $2', [ws, row.email],
    )).rows[0];
    if (sub) {
      // A second click finds them already off the list: nothing to write.
      if (sub.status === 'unsubscribed') return;
      await tx.query(
        "update subscriptions set status = 'unsubscribed', unsubscribed_at = now() where id = $1 and workspace_id = $2",
        [sub.id, ws],
      );
      emit('subscription', sub.id, 'update', { status: 'unsubscribed', source: 'ladder-unsubscribe' });
      return;
    }
    // Never on the list: flag everyone with this address do-not-email.
    const people = (await tx.query(
      'select id, tags from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null', [ws, row.email],
    )).rows;
    for (const p of people) {
      if (noEmail(p)) continue;
      const tags = [...tagsOf(p), NO_EMAIL_TAG];
      await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2',
        [p.id, ws, JSON.stringify(tags)]);
      emit('person', p.id, 'update', { tags, source: 'ladder-unsubscribe' });
    }
  });
  return done(c, row);
});
