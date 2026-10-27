// Starbase A/B subject lines + open/click tracking — browser check.
//
// Starts its own fresh in-memory server with a stand-in email provider
// (fetch to Resend is answered locally and each message written to a
// mailbox file), then, as a desk user: writes an A/B newsletter while email
// isn't connected (Saved — not sent, the plan on the card), connects email,
// Start test (A and B only), opens and clicks from the real tracked emails
// (a scanner's clicks not counted), fast-forwards the wait so the winner job
// runs, and reads the result on the first look (Last sent) and under More
// (Past sends above Subscribers) — every number checked against the API.
// Then the small-list path on Press, a tie, a send the request hands to the
// send job ("Sending · N of 60", a door knock meanwhile not kept waiting),
// the compose screen on a 390×844 phone (one yellow button, no sideways
// scroll, field targets ≥ 48px, word count, the plan under the settings),
// the saved two-subject card on a phone (subject, plan, status; Subject B
// and the date one tap away), and a volunteer on a phone who can't reach any
// of it. Ends with /api/audit/verify.
//
//   npm run build  then  node e2e-abtests.mjs   (PORT, SHOTS optional)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT) || 4104;
const CONTROL = PORT + 10000;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { toString() { return `${BASE}/admin`; } }; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/starbase-abtests';
mkdirSync(SHOTS, { recursive: true });
const MAILBOX = `${SHOTS}/mailbox.jsonl`;
const STUB = `${SHOTS}/provider-stub.mjs`;
rmSync(MAILBOX, { force: true });

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The stand-in email provider + a test-only clock, loaded into the server ──
// /connect sets RESEND_API_KEY (email connected); /due makes pending jobs due
// now (the A/B wait is at least an hour); /age makes every send a minute
// older (a click seconds after delivery is a scanner's); /slow makes each
// email take 120 ms and gives the request no time to send (the send job
// sends), /fast undoes it. All only exist in this check.
const serverDir = fileURLToPath(new URL('./server/', import.meta.url));
writeFileSync(STUB, `
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const real = globalThis.fetch;
let slowMs = 0;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    appendFileSync(${JSON.stringify(MAILBOX)}, init.body + '\\n');
    return new Response(JSON.stringify({ id: 'e2e' }), { status: 200 });
  }
  return real(url, init);
};
createServer(async (req, res) => {
  if (req.url === '/connect') process.env.RESEND_API_KEY = 'e2e-key';
  // A slow email service, and no time in the request: the send job sends.
  if (req.url === '/slow') { slowMs = 120; process.env.STARBASE_SEND_INLINE_MS = '0'; }
  if (req.url === '/fast') { slowMs = 0; delete process.env.STARBASE_SEND_INLINE_MS; }
  if (req.url === '/due' || req.url === '/age') {
    const { getDb } = await import(${JSON.stringify(pathToFileURL(`${serverDir}db/client.js`).href)});
    const db = await getDb();
    if (req.url === '/due') await db.query("update jobs set run_at = now() where status = 'pending'");
    else await db.query("update blast_recipients set sent_at = sent_at - interval '1 minute' where sent_at is not null");
  }
  res.end('ok');
}).listen(${CONTROL}, '127.0.0.1');
`);
const env = { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS_EVERY_MS: '500' };
delete env.RESEND_API_KEY;
delete env.STARBASE_PUBLIC_URL;
const server = spawn(process.execPath, ['--import', pathToFileURL(STUB).href, 'server/index.js'], {
  cwd: fileURLToPath(new URL('.', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
process.on('exit', () => { try { server.kill('SIGTERM'); } catch { /* gone */ } });
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 60; i += 1) {
  if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) break;
  await sleep(250);
}
const control = (path) => fetch(`http://127.0.0.1:${CONTROL}${path}`).then((r) => r.text());
// Newsletters and press releases only (an invite email has no HTML part).
const mailbox = () => (existsSync(MAILBOX) ? readFileSync(MAILBOX, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  .filter((x) => x.html);
const tokenOf = (m) => (m.html.match(/\/o\/([A-Za-z0-9_-]{24})\.gif/) || [])[1];
const linkOf = (m, n) => (m.html.match(new RegExp(`href="([^"]*/c/[A-Za-z0-9_-]{24}/${n})"`)) || [])[1];

// OSM tiles are unreachable from the test sandbox; serve a flat tile.
const tileSvg = () => '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/></svg>';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const tiles = (ctx) => ctx.route(/tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg() }));
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(ctx);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const textOf = async (p) => ((await p.innerText('body').catch(() => '')) || '').replace(/\s+/g, ' ');
const apiOn = (p) => (path, body) => p.evaluate(async ([pp, b]) => {
  const r = await fetch('/api' + pp, b === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  });
  return { status: r.status, json: await r.json().catch(() => null), raw: '' };
}, [path, body]);
const api = apiOn(page);
const act = (name, input) => api(`/actions/${name}`, input);
const go = async (p, path) => { await p.goto(`${p === page ? ADMIN : BASE}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); };
const pct = (n, of) => (of > 0 ? Math.round((100 * n) / of) : 0);
const statOf = async (id) => (await api('/blasts/stats')).json.stats.find((s) => s.id === id);

// Simplicity on a screen: words in the page (not the nav), yellow buttons,
// sideways scroll, and the smallest field / disclosure tap target.
const measure = (p) => p.evaluate(() => {
  const main = document.querySelector('main.page') || document.body;
  const words = (main.innerText || '').split(/\s+/).filter(Boolean).length;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const fields = [...main.querySelectorAll('input:not([type=checkbox]):not([type=radio]), select, textarea, button.disclose')].filter(visible);
  const minTap = fields.length ? Math.min(...fields.map((el) => el.getBoundingClientRect().height)) : null;
  return { words, yellow, overflow: document.documentElement.scrollWidth - window.innerWidth, minTap, fields: fields.length };
});

// ── 1. A desk user and a list of 60 ──
await go(page, '/signup');
await page.fill('#su-name', 'Avery Desk');
await page.fill('#su-email', 'avery@abtests.example');
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
for (let i = 0; i < 60; i += 1) await act('subscription.add', { email: `reader${i}@example.org`, name: `Reader ${i}` });
await act('person.create', { name: 'Lin Reporter', email: 'lin@surreynow.example', tags: ['media'] });
const subs = (await api('/subscriptions')).json.subscribed;
check('60 subscribers on the list', subs === 60, subs);

// ── 2. Write an A/B newsletter while email isn't connected ──
await go(page, '/outreach/newsletter');
await page.click('button:has-text("Write newsletter")');
await page.waitForSelector('#newsletter-subject', { timeout: 5000 });
await page.fill('#newsletter-subject', 'This week in Surrey');
await page.fill('#newsletter-body', 'Hello neighbours.\n\nRead the transit plan: https://imaginesurrey.example/plan.');
let t = await textOf(page);
check('compose: a quiet "Try two subject lines", no Subject B yet', /Try two subject lines/.test(t) && !(await page.$('#newsletter-ab-subject')));
await page.click('button.ab-toggle');
await page.waitForSelector('#newsletter-ab-subject', { timeout: 3000 });
await page.fill('#newsletter-ab-subject', 'Transit plan: what Newton told us');
await page.selectOption('#newsletter-ab-pct', '20');
await page.selectOption('#newsletter-ab-wait', '1');
await page.selectOption('#newsletter-ab-metric', 'opens');
t = await textOf(page);
check('compose: Subject A / Subject B, test group, wait, winner by', /Subject A/i.test(t) && /Subject B/i.test(t) && /Test group/i.test(t) && /Wait/i.test(t) && /Winner by/i.test(t));
const planNow = () => page.$eval('[data-testid="ab-plan-now"]', (el) => el.textContent).catch(() => '');
const plan20 = await planNow();
await page.selectOption('#newsletter-ab-pct', '10');
await page.selectOption('#newsletter-ab-wait', '4');
const plan10 = await planNow();
await page.selectOption('#newsletter-ab-pct', '20');
await page.selectOption('#newsletter-ab-wait', '1');
check('compose: the plan under the settings, as they change', plan20 === 'Two subject lines · A to 12, B to 12, winner to 36 after 1 hour'
  && plan10 === 'Two subject lines · A to 6, B to 6, winner to 48 after 4 hours' && (await planNow()) === plan20, `${plan20} | ${plan10}`);
// Winner by clicks needs something to click.
await page.fill('#newsletter-body', 'Hello neighbours. No links today.');
const clicksOff = await page.$eval('#newsletter-ab-metric option[value="clicks"]', (o) => ({ disabled: o.disabled, text: o.textContent }));
await page.fill('#newsletter-body', 'Hello neighbours.\n\nRead the transit plan: https://imaginesurrey.example/plan.');
const clicksOn = await page.$eval('#newsletter-ab-metric option[value="clicks"]', (o) => o.disabled);
check('compose: "Clicks" needs a link in the message', clicksOff.disabled && /add a link/.test(clicksOff.text) && !clicksOn, JSON.stringify({ clicksOff, clicksOn }));
let m = await measure(page);
check('compose (desk): one yellow button', m.yellow === 1, JSON.stringify(m));
await shot(page, '1-compose-ab-desk');
await page.click('form.ot-compose button[type="submit"]');
await sleep(300);
t = await textOf(page);
check('not connected: the confirm says save, and that nothing is sent', /Save for 60 subscribers\?/.test(t) && /Email isn’t connected — nothing is sent/.test(t), (t.match(/Save for.{0,80}/) || [''])[0]);
await page.click('button:has-text("Yes, save")');
await sleep(1200);
t = await textOf(page);
check('not connected: "Saved — not sent", the plan, and the test waits for Start test',
  /Saved for 60 subscribers — not sent/.test(t) && /Connect email, then Start test/.test(t)
  && t.includes('Two subject lines · A to 12, B to 12, winner to 36 after 1 hour') && !/Testing/.test(t) && !/Sent to/.test(t), t.slice(0, 300));
check('no "A/B" on screen', !/A\/B/.test(t));
const blastId = (await api('/blasts')).json.blasts[0].id;
let st = await statOf(blastId);
let listed = (await api('/blasts')).json.blasts[0];
check('API agrees: saved, 0 sent, test not started', listed.status === 'queued' && listed.sent_count === 0 && st.ab.status === 'saved' && st.ab.decide_at === null, JSON.stringify({ status: listed.status, sent: listed.sent_count, ab: st.ab.status }));
check('nothing reached the email service', mailbox().length === 0, mailbox().length);
await shot(page, '2-saved-not-sent');

// ── 3. Connect email, then Send now starts the test: A and B only ──
await control('/connect');
await go(page, '/outreach/newsletter');
t = await textOf(page);
check('Not sent card: the plan before the tap, and "Start test"',
  t.includes('60 subscribers') && t.includes('Two subject lines · A to 12, B to 12, winner to 36 after 1 hour')
  && /Start test/i.test(t) && !/Send now · 24/i.test(t) && !/A\/B/.test(t), (t.match(/Not sent.{0,200}/) || [''])[0]);
const savedCard = () => page.$eval('section[aria-label="Not sent"] li', (el) => el.innerText.replace(/\s+/g, ' ')).catch(() => '');
const closedCard = await savedCard();
check('saved two-subject card: subject, plan and status — Subject B and the date one tap away',
  closedCard.includes('This week in Surrey') && closedCard.includes('Two subject lines · A to 12') && /not sent/i.test(closedCard)
  && !closedCard.includes('B · Transit plan') && !/saved [A-Z][a-z]{2} \d/.test(closedCard), closedCard);
await page.click('section[aria-label="Not sent"] li button.ot-row');
await sleep(200);
const openCard = await savedCard();
check('saved card opened: Subject B and when it was saved', openCard.includes('B · Transit plan: what Newton told us') && /60 subscribers · saved /.test(openCard), openCard);
await shot(page, '2b-not-sent-plan');
await page.click('button:has-text("Start test")');
await sleep(300);
t = await textOf(page);
check('Send now asks once, with the split', /A to 12, B to 12 now · the winner to 36 after 1 hour\?/.test(t), (t.match(/A to.{0,80}/) || [''])[0]);
await page.click('button:has-text("Yes, send")');
await sleep(1500);
t = await textOf(page);
const sent1 = mailbox();
st = await statOf(blastId);
check('the email service got A and B only: 12 + 12', sent1.length === 24
  && sent1.filter((x) => x.subject === 'This week in Surrey').length === 12
  && sent1.filter((x) => x.subject === 'Transit plan: what Newton told us').length === 12, sent1.length);
check('each email: its own pixel, tracked link, untracked unsubscribe',
  new Set(sent1.map(tokenOf)).size === 24 && sent1.every((x) => linkOf(x, 1) && /\/u\/[0-9a-f-]{36}"/.test(x.html) && !/\/c\/[^"]*\/u\//.test(x.html)));
const decideAt = new Date(st.ab.decide_at);
const wait = decideAt.getTime() - Date.now();
check('API: testing, winner due in 1 hour', st.ab.status === 'testing' && wait > 55 * 60e3 && wait <= 60 * 60e3, JSON.stringify({ status: st.ab.status, wait }));
// The screen's own rule (AbTests.jsx fmtTime): a bare time today, "tomorrow
// <time>" or "<Mon d>, <time>" otherwise — an hour's wait can cross midnight.
// The app's time format: "4:12 a.m.".
const shownTime = await page.evaluate((iso) => {
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t;
  const next = new Date(now);
  next.setDate(now.getDate() + 1);
  if (d.toDateString() === next.toDateString()) return `tomorrow ${t}`;
  return `${d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })}, ${t}`;
}, st.ab.decide_at);
check('result: "Testing · A 0% vs B 0% opened · winner at <time>"',
  t.includes(`Testing · A 0% vs B 0% opened · winner at ${shownTime}`) && /A and B went to 24 of 60 subscribers/.test(t) && !/winner picked/.test(t), (t.match(/Testing.{0,120}/) || [''])[0]);
check('no "not sent" or Try again for the held 36', !/36 not sent/.test(t) && !/Try again/.test(t));
check('the winner time reads like every other time ("a.m." / "p.m.")', /[ap]\.m\./.test(shownTime) && t.includes(shownTime) && !/[ap]\.m\.\./.test(t), shownTime);
await shot(page, '3-testing-result');

// ── 4. Opens and clicks from the real emails ──
const A = sent1.filter((x) => x.subject === 'This week in Surrey');
const B = sent1.filter((x) => x.subject !== 'This week in Surrey');
// A reader's phone browser; a mail scanner names itself (or nothing).
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const hit = (path, opts = {}) => fetch(`${BASE}${path}`, { redirect: 'manual', ...opts, headers: { 'user-agent': BROWSER, ...(opts.headers || {}) } });
for (const x of A.slice(0, 2)) await hit(new URL(`/o/${tokenOf(x)}.gif`, BASE).pathname);
for (const x of B.slice(0, 6)) await hit(`/o/${tokenOf(x)}.gif`);
await hit(`/o/${tokenOf(B[0])}.gif`); // a second open by the same reader
const clickPath = new URL(linkOf(B[1], 1)).pathname;
// Seconds after delivery, and a scanner's user agent: both still redirect, neither counts.
const early = await hit(clickPath);
await control('/age');
const scanner = await hit(clickPath, { headers: { 'user-agent': 'python-requests/2.31.0' } });
const clickRow = async () => (await statOf(blastId)).ab.b.clicked;
check('scanner clicks still redirect but are not counted', early.status === 302 && scanner.status === 302
  && scanner.headers.get('location') === 'https://imaginesurrey.example/plan' && (await clickRow()) === 0, `${early.status} ${scanner.status}`);
const click = await hit(clickPath);
check('a click goes to the stored link (302)', click.status === 302 && click.headers.get('location') === 'https://imaginesurrey.example/plan', `${click.status} ${click.headers.get('location')}`);
const bad = await hit(`/c/${tokenOf(B[1])}/2`);
const evil = await hit(`/c/${tokenOf(B[1])}/1?to=https://evil.example/`);
check('no open redirect: unknown link 404, extra params ignored', bad.status === 404 && !bad.headers.get('location') && evil.headers.get('location') === 'https://imaginesurrey.example/plan');
const pix = await hit('/o/nonsense.gif');
check('the pixel is a gif, never cached', pix.status === 200 && pix.headers.get('content-type') === 'image/gif' && /no-store/.test(pix.headers.get('cache-control')));
st = await statOf(blastId);
check('API: A 2 of 12 opened, B 6 of 12 opened, 1 clicked', st.ab.a.opened === 2 && st.ab.b.opened === 6 && st.ab.b.clicked === 1 && st.ab.a.delivered === 12, JSON.stringify(st.ab));
await go(page, '/outreach/newsletter');
t = await textOf(page);
const live = `Testing · A ${pct(st.ab.a.opened, st.ab.a.delivered)}% vs B ${pct(st.ab.b.opened, st.ab.b.delivered)}% opened · winner at ${shownTime}`;
check('first look: the running test, its rates as the API counts them', t.includes(live) && /B · Transit plan: what Newton told us/.test(t), (t.match(/Testing.{0,140}/) || [''])[0]);
check('first look: "Testing two subject lines"', /Testing two subject lines/i.test(t));
await shot(page, '4-testing-first-look');

// ── 5. The wait ends: the winner job sends B to the other 36 ──
await control('/due');
for (let i = 0; i < 40; i += 1) {
  st = await statOf(blastId);
  if (st.ab.status === 'decided') break;
  await sleep(250);
}
const sent2 = mailbox();
check('winner B picked (50% vs 17%)', st.ab.status === 'decided' && st.ab.winner === 'b', JSON.stringify({ status: st.ab.status, winner: st.ab.winner }));
check('the other 36 got subject B, everyone exactly once', sent2.length === 60
  && sent2.slice(24).every((x) => x.subject === 'Transit plan: what Newton told us')
  && new Set(sent2.map((x) => x.to[0])).size === 60, sent2.length);
listed = (await api('/blasts')).json.blasts.find((b) => b.id === blastId);
check('API: sent to all 60', listed.status === 'sent' && listed.sent_count === 60, JSON.stringify({ s: listed.status, n: listed.sent_count }));
await go(page, '/outreach/newsletter');
t = await textOf(page);
check('first look: no test running any more', !/Testing/.test(t));
// The whole list's numbers, labelled as everyone's (the test line has A and B's).
const statLine = `All 60: opened ${pct(st.opened, st.delivered)}% · clicked ${pct(st.clicked, st.delivered)}%`;
const r = st.ab.result;
const winLine = `Winner B · A ${pct(r.a.opened, r.a.delivered)}% vs B ${pct(r.b.opened, r.b.delivered)}% opened · sent to everyone`;
const lastSent = await page.$eval('section[aria-label="Last sent"]', (el) => el.innerText.replace(/\s+/g, ' ')).catch(() => '');
check(`first look: Last sent — "${winLine}"`, lastSent.includes('This week in Surrey') && lastSent.includes(winLine) && !r.tie, lastSent.slice(0, 200));
check(`first look: Last sent — "${statLine}", as the API counts`, lastSent.includes(statLine) && st.delivered === 60 && st.opened === 8 && st.clicked === 1, JSON.stringify({ d: st.delivered, o: st.opened, c: st.clicked }));
await page.locator('section[aria-label="Last sent"]').screenshot({ path: `${SHOTS}/5-last-sent-first-look.png` });
await page.click('button.ot-more:has-text("More")');
await sleep(400);
t = await textOf(page);
check('past sends: the winner line with the rates it was picked on', t.includes(winLine), (t.match(/Winner.{0,80}/) || [''])[0]);
check(`past sends: "${statLine}" — of delivered`, t.includes(statLine));
const order = await page.evaluate(() => {
  const top = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? null;
  return { past: top('section[aria-label="Past sends"]'), subs: top('section[aria-label="Subscribers"]') };
});
check('under More: Past sends sit above the subscriber list', order.past != null && order.subs != null && order.past < order.subs, JSON.stringify(order));
check('under More: one line on Apple Mail opens', /Apple Mail can open emails by itself, so opens run high\./.test(t));
await page.locator('section[aria-label="Past sends"]').screenshot({ path: `${SHOTS}/5-winner-past-sends.png` });

// ── 6. Small lists: Press with one media contact sends normally ──
await go(page, '/outreach/press');
await page.click('button:has-text("Write press release")');
await page.waitForSelector('#press-subject', { timeout: 5000 });
await page.click('button.ab-toggle');
await sleep(200);
t = await textOf(page);
check('small list: "Two subject lines need 50+ media contacts — this sends with one."', /Two subject lines need 50\+ media contacts — this sends with one\./.test(t) && !(await page.$('#press-ab-subject')) && !/A\/B/.test(t), (t.match(/Two subject.{0,80}/) || [''])[0]);
await shot(page, '6-press-small-list-note');
await page.fill('#press-subject', 'Imagine Surrey unveils transit plan');
await page.fill('#press-body', 'FOR IMMEDIATE RELEASE https://imaginesurrey.example/news');
await page.click('form.ot-compose button[type="submit"]');
await sleep(300);
t = await textOf(page);
check('small list: the confirm is a normal send', /Send to 1 media contact\?/.test(t), (t.match(/Send to.{0,40}/) || [''])[0]);
await page.click('button:has-text("Yes, send")');
await sleep(1200);
t = await textOf(page);
const press = mailbox().slice(60);
check('small list: sent normally, one subject, tracked', /Sent to 1 media contact/.test(t) && press.length === 1 && press[0].subject === 'Imagine Surrey unveils transit plan' && tokenOf(press[0]), press.length);
await shot(page, '6-press-small-list-sent');

// ── 6b. A tie says so: winner by clicks, and nobody clicked ──
const tieSend = await act('blast.send', {
  kind: 'newsletter', subject: 'Tie subject A', body: 'Come out: https://imaginesurrey.example/rally',
  ab: { subject_b: 'Tie subject B', pct: 10, wait_hours: 1, metric: 'clicks' },
});
const tieId = tieSend.json?.blast?.id;
const tieB = mailbox().filter((x) => x.subject === 'Tie subject B');
for (const x of tieB.slice(0, 3)) await hit(`/o/${tokenOf(x)}.gif`); // B opened more — but this test is by clicks
await control('/due');
let tieStat;
for (let i = 0; i < 40; i += 1) {
  tieStat = await statOf(tieId);
  if (tieStat?.ab?.status === 'decided' && !tieStat.ab.rest.going) break;
  await sleep(250);
}
await go(page, '/outreach/newsletter');
const tieLast = await page.$eval('section[aria-label="Last sent"]', (el) => el.innerText.replace(/\s+/g, ' ')).catch(() => '');
check('a tie: "Tie — sent A · A 0% vs B 0% clicked · sent to everyone"', tieStat?.ab?.result?.tie === true && tieStat.ab.winner === 'a'
  && tieLast.includes('Tie — sent A · A 0% vs B 0% clicked · sent to everyone') && !/Winner A/.test(tieLast), tieLast.slice(0, 200));
check('a tie: the rest got subject A', mailbox().filter((x) => x.subject === 'Tie subject A').length === 54, mailbox().filter((x) => x.subject === 'Tie subject A').length);
await page.locator('section[aria-label="Last sent"]').screenshot({ path: `${SHOTS}/6b-tie-last-sent.png` });

// ── 6c. A send the request hands to the send job: "Sending · N of 60" ──
await control('/slow');
await go(page, '/outreach/newsletter');
await page.click('button:has-text("Write newsletter")');
await page.waitForSelector('#newsletter-subject', { timeout: 5000 });
await page.fill('#newsletter-subject', 'Rally on Saturday');
await page.fill('#newsletter-body', 'See you at Holland Park.');
await page.click('form.ot-compose button[type="submit"]');
await sleep(300);
const before6c = mailbox().length;
const tapAt = Date.now();
await page.click('button:has-text("Yes, send")');
await page.waitForSelector('.ot-result', { timeout: 5000 });
const answeredMs = Date.now() - tapAt;
t = await textOf(page);
check('the tap answers at once: "Sending · N of 60 subscribers."', /Sending · \d+ of 60 subscribers\./.test(t) && answeredMs < 3000 && !/Try again/.test(t) && !/not sent/.test(t),
  `${answeredMs} ms · ${(t.match(/Sending.{0,40}/) || [''])[0]}`);
await shot(page, '6c-sending');
const going = (await api('/blasts')).json.blasts.find((b) => b.subject === 'Rally on Saturday');
check('API: on its way, nothing to try again', going.going_count > 0 && going.retry_count === 0 && going.status === 'queued', JSON.stringify({ g: going.going_count, r: going.retry_count }));
const kim = (await act('person.create', { name: 'Kim Door', phone: '604-555-0142' })).json.person;
const k0 = Date.now();
const knock = await act('contact.log', { person_id: kim.id, channel: 'door', outcome: 'contacted', rating: '1' });
const knockMs = Date.now() - k0;
check('a door knock while it sends is not kept waiting', knock.status === 200 && knockMs < 800 && mailbox().length - before6c < 60, `${knockMs} ms, ${mailbox().length - before6c} sent`);
let progress = [];
for (let i = 0; i < 60; i += 1) {
  const m6 = (await textOf(page)).match(/Sending · (\d+) of 60/);
  if (m6) progress.push(Number(m6[1]));
  if (/Sent to 60 subscribers\./.test(await textOf(page))) break;
  await sleep(500);
}
t = await textOf(page);
check('the screen counts up, then "Sent to 60 subscribers."', /Sent to 60 subscribers\./.test(t) && progress.length > 0 && progress.some((n) => n > 0) && mailbox().length - before6c === 60,
  `${progress.join(',')} · ${mailbox().length - before6c}`);
const done6c = (await api('/blasts')).json.blasts.find((b) => b.subject === 'Rally on Saturday');
check('API: sent to all 60, nothing going', done6c.status === 'sent' && done6c.sent_count === 60 && done6c.going_count === 0 && !!done6c.sent_at, JSON.stringify({ s: done6c.status, n: done6c.sent_count }));
await control('/fast');

// ── 7. The compose screen on a phone (desk user) ──
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver',
  storageState: await ctx.storageState(),
});
await tiles(phone);
const pp = await phone.newPage();
pp.on('pageerror', (e) => errors.push('[phone] ' + e.message));
await go(pp, '/outreach/newsletter?new=1');
await pp.waitForSelector('#newsletter-subject', { timeout: 5000 });
const closed = await measure(pp);
await pp.tap('button.ab-toggle');
await sleep(300);
const open = await measure(pp);
check('phone compose: one yellow button, no sideways scroll', closed.yellow === 1 && open.yellow === 1 && closed.overflow <= 0 && open.overflow <= 0, JSON.stringify({ closed, open }));
check('phone compose: field tap targets ≥ 48px', open.minTap >= 48 && closed.minTap >= 48, JSON.stringify({ closed: closed.minTap, open: open.minTap, fields: open.fields }));
console.log(`      words on Write newsletter (phone): ${closed.words} closed → ${open.words} with two subject lines`);
await shot(pp, '7-phone-compose-ab');
await go(pp, '/outreach/newsletter');
await pp.tap('button.ot-more:has-text("More")');
await sleep(400);
const past = await measure(pp);
check('phone past sends: no sideways scroll, one yellow button', past.overflow <= 0 && past.yellow <= 1, JSON.stringify(past));
await pp.locator('section[aria-label="Past sends"]').screenshot({ path: `${SHOTS}/8-phone-past-sends.png` });
await phone.close();

// ── 8. A volunteer on a phone reaches none of it ──
const inv = await act('member.invite', { email: 'jas@example.org', role: 'volunteer' });
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vp = await vctx.newPage();
vp.on('pageerror', (e) => errors.push('[vol] ' + e.message));
await vp.goto(inv.json.joinUrl.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
await vp.waitForSelector('#join-name', { timeout: 8000 });
await vp.fill('#join-name', 'Jas Volunteer');
await vp.fill('#join-password', 'knock-knock-2026');
await vp.click('button[type="submit"]');
await vp.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
check('volunteer joins on a phone', new URL(vp.url()).pathname === '/', vp.url());
await go(vp, '/outreach/newsletter');
check('volunteer typing /outreach lands on Today', new URL(vp.url()).pathname === '/', vp.url());
const vapi = apiOn(vp);
const vStats = await vapi('/blasts/stats');
const vBlasts = await vapi('/blasts');
const vSend = await vapi('/actions/blast.send', { kind: 'newsletter', subject: 'x', body: 'y', ab: { subject_b: 'z', pct: 10, wait_hours: 1, metric: 'opens' } });
check('volunteer refused stats, sends, and sending (403)', vStats.status === 403 && vBlasts.status === 403 && vSend.status === 403, `${vStats.status} ${vBlasts.status} ${vSend.status}`);
const seen = JSON.stringify(await vp.evaluate(async () => {
  const out = {};
  for (const p of ['/auth/me', '/persons?limit=500', '/brief', '/shifts', '/map/doors']) {
    out[p] = await fetch('/api' + p).then((r) => r.text()).catch(() => '');
  }
  return out;
}));
const tokens = mailbox().map(tokenOf);
check('no token or subscriber email in anything a volunteer receives', tokens.every((x) => !seen.includes(x)) && !/reader\d+@example\.org/.test(seen) && !/avery@abtests/.test(seen));
const vm = await measure(vp);
check('volunteer Today at 390px: no sideways scroll', vm.overflow <= 0, vm.overflow);
await shot(vp, '9-volunteer-today');
await vctx.close();

// ── 9. The books ──
// First opens and clicks reach the log by a job (the hit itself takes no lock).
let ev = [];
const count = (a) => ev.filter((e) => e.action === a).length;
for (let i = 0; i < 40; i += 1) {
  ev = (await api('/events?since=0&limit=5000')).json.events;
  if (count('public.open') >= 11) break;
  await sleep(250);
}
check('event log: one open event per reader (8 + 3), one click, two winners', count('public.open') === 11 && count('public.click') === 1 && count('blast.ab_winner') === 2,
  JSON.stringify({ open: count('public.open'), click: count('public.click'), winner: count('blast.ab_winner') }));
check('event log: each of the rest recorded on its own (36 + 48)', ev.filter((e) => e.action === 'blast.ab_rest' && e.entity_type === 'blast_recipient').length === 84);
const v = (await api('/audit/verify')).json;
check('hash chain verifies', v.ok === true && v.checked > 70, JSON.stringify(v));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
server.kill('SIGTERM');
const fails = results.filter((r) => !r).length;
if (fails) console.log(serverLog.slice(-2000));
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
