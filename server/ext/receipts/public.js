// /r/:token — the donor's own receipt. No sign-in: the link is the key (192
// random bits, never in the event log). It shows that one receipt and
// nothing else — no other gifts, no campaign data — and is never cached or
// indexed. A void receipt still opens, marked VOID.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { loadSettings, docOf, campaignName, money, longDate, methodWord, agentLine } from './core.js';

export const publicRoutes = new Hono();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const page = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
  :root{--paper:#f4f5fa;--card:#ffffff;--ink:#161a2e;--ink2:#5d6481;--rule:#dde0ec;--mark:#6d4aff;--bad:#d43c3c}
  @media(prefers-color-scheme:dark){:root{--paper:#0d1226;--card:#161c35;--ink:#e8eaf6;--ink2:#9aa1c2;--rule:#2a3254;--mark:#7d5fff;--bad:#e08a8a}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}
  main{max-width:560px;margin:0 auto;padding:28px 16px 56px}
  .camp{font-size:28px;font-weight:800;letter-spacing:-.01em;line-height:1.1;margin:0 0 24px;padding-bottom:12px;border-bottom:4px solid var(--mark);overflow-wrap:anywhere}
  h1{font-size:24px;line-height:1.2;margin:0 0 16px}
  .void{border:3px solid var(--bad);border-radius:12px;color:var(--bad);font:800 22px/1.2 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:.2em;text-align:center;padding:10px;margin:0 0 16px}
  dl{display:grid;grid-template-columns:max-content 1fr;gap:10px 16px;margin:0 0 20px;padding:18px;border:1px solid var(--rule);border-radius:14px;background:var(--card)}
  dt{font:600 12.5px/1.7 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;letter-spacing:.05em;text-transform:uppercase;color:var(--ink2)}
  dd{margin:0;overflow-wrap:anywhere}
  .n{font:700 18px system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-variant-numeric:tabular-nums}
  p{margin:0 0 10px}
  .notice{font-weight:700}
  .muted{color:var(--ink2)}
  button{display:block;width:100%;min-height:56px;margin-top:24px;font:600 17px/1.2 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;background:var(--mark);color:#fff;border:0;padding:16px 22px;border-radius:12px;cursor:pointer}
  @media(max-width:420px){dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:8px}}
  @media print{:root{--paper:#fff;--card:#fff;--ink:#000;--ink2:#333}button{display:none}main{padding:0}}
</style></head><body><main>
${inner}
</main></body></html>`;

const send = (c, status, html) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex');
  c.header('Referrer-Policy', 'no-referrer');
  return c.html(html, status);
};

export const receiptHtml = (doc) => `
<div class="camp">${esc(doc.campaign)}</div>
<h1>Contribution receipt</h1>
${doc.void ? '<div class="void" role="note">VOID</div>' : ''}
${doc.sample ? '<div class="void" role="note">SAMPLE</div>' : ''}
<dl>
  <dt>Receipt</dt><dd class="n">${esc(doc.number)}</dd>
  <dt>Received from</dt><dd>${esc(doc.contributor)}</dd>
  <dt>Home address</dt><dd>${doc.address ? esc(doc.address) : '<span class="muted">Not on file</span>'}</dd>
  <dt>Amount</dt><dd class="n">${esc(money(doc.amount_cents))}</dd>
  <dt>Date received</dt><dd>${esc(longDate(doc.received_on))}</dd>
  <dt>Method</dt><dd>${esc(methodWord(doc.method))}</dd>
</dl>
<p>Financial agent: ${esc(agentLine(doc))}</p>
<p class="notice">${esc(doc.notice)}</p>
${doc.footer ? `<p class="muted">${esc(doc.footer)}</p>` : ''}`;

publicRoutes.get('/r/:token', async (c) => {
  const token = c.req.param('token');
  const db = await getDb();
  const r = /^[0-9a-f]{48}$/.test(token)
    ? (await db.query('select * from receipts where token = $1', [token])).rows[0]
    : null;
  if (!r) return send(c, 404, page('Receipt not found', '<h1>This receipt link isn’t valid.</h1>'));
  const settings = await loadSettings(db, r.workspace_id);
  const doc = docOf(r, settings, await campaignName(db, r.workspace_id));
  return send(c, 200, page(`Receipt ${doc.number} · ${doc.campaign}`,
    `${receiptHtml(doc)}\n<button type="button" onclick="window.print()">Print</button>`));
});
