// Starbase core field fixes E2E — a fresh in-memory server, a desk user on a
// laptop and a volunteer on a 390×844 phone:
//   · the walk list door's More: "Wants a sign?" (with Undo on the toast) and
//     "+ Person at this door" (name, phone — the door's address comes with
//     them), online and with no signal, each sent once;
//   · the map's door card offers "+ Person at this door" to a volunteer at a
//     door in their turf, not elsewhere (and the server refuses elsewhere);
//   · the volunteer's brief carries no money-derived first steps;
//   · the export holds every campaign table, with no link tokens;
//   · a newsletter send whose answer is lost (the server went down mid-send)
//     is found on record and shown as it stands, never sent a second time.
// Every claim on screen is checked against the API; the books verify.
//
//   node e2e-core.mjs                           (starts its own server on :4103)
//   BASE=http://127.0.0.1:4198 node e2e-core.mjs   (a fresh server you started)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT) || 4103;
const SHOTS = process.env.SHOTS || '/tmp/claude-0/-home-user-mandate/c88a39fd-f6db-552f-95dc-59176433706d/scratchpad/features/core';
mkdirSync(SHOTS, { recursive: true });

let server = null;
let BASE = process.env.BASE;
if (!BASE) {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(PORT), STARBASE_JOBS: 'off' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 30000);
    server.stdout.on('data', (b) => { if (/starbase on :/.test(String(b))) { clearTimeout(t); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  BASE = `http://127.0.0.1:${PORT}`;
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);

const tileSvg = () => '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/></svg>';
const routeTiles = (c) => c.route(/tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg() }));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];

const helpers = (page, ctx) => ({
  text: async () => ((await page.innerText('body').catch(() => '')) || '').replace(/\s+/g, ' '),
  api: async (path, body) => {
    const r = body === undefined
      ? await ctx.request.get(`${BASE}/api${path}`)
      : await ctx.request.post(`${BASE}/api${path}`, { data: body });
    return { status: r.status(), json: await r.json().catch(() => null) };
  },
  go: async (path) => { await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(1200); },
  shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png` }),
  chip: () => page.$eval('.offline-strip__chip', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => ''),
  toast: () => page.$eval('.walk-toast', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => ''),
  measure: (sel) => page.evaluate((s) => {
    const root = document.querySelector(s) || document.body;
    const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
    const words = (root.innerText || '').split(/\s+/).filter(Boolean).length;
    const yellow = [...document.querySelectorAll('.btn-primary')].filter(vis).length;
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    const small = [...root.querySelectorAll('button, a.btn, input, select, textarea')].filter(vis)
      .map((el) => { const r = el.getBoundingClientRect(); return { t: (el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24), h: Math.round(r.height), w: Math.round(r.width) }; })
      .filter((x) => x.h < 48 || x.w < 44);
    return { words, yellow, overflow, small };
  }, sel),
});

// ════════════════════════════════════════════════════════════════════════════
// Desk: a workspace, doors in a turf, a volunteer
// ════════════════════════════════════════════════════════════════════════════
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await routeTiles(ctx);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const D = helpers(page, ctx);
await D.go('/signup');
await page.fill('#su-name', 'Riley Desk');
await page.fill('#su-email', `desk+${tag}@example.org`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(`${BASE}/`, { timeout: 15000 });

const P = {};
const mk = async (key, data) => { P[key] = (await D.api('/actions/person.create', data)).json.person; };
await mk('maya', { name: 'Maya Chen', phone: '604-555-0103', email: 'maya@example.org', address: '12390 72 Ave', city: 'Surrey', postal: 'V3W 2M9', lat: 49.13310, lng: -122.84950 });
await mk('tom', { name: 'Tom Riley', phone: '604-555-0104', email: 'tom@example.org', address: '7120 124 St', city: 'Surrey', lat: 49.13100, lng: -122.85200 });
await mk('far', { name: 'Far Example', phone: '604-555-0105', address: '15000 Fraser Hwy', city: 'Surrey', lat: 49.1100, lng: -122.7800 });
const turf = (await D.api('/actions/turf.create', {
  name: 'Newton East', polygon: [[49.125, -122.860], [49.140, -122.860], [49.140, -122.838], [49.125, -122.838]],
})).json.turf;
await D.api('/actions/gift.log', { person_id: P.maya.id, amount_cents: 5000, date: '2026-03-01' });
check('seeded two doors in a turf, one outside, and a gift', Object.values(P).every((p) => p?.id) && turf?.id);

const volEmail = `vol+${tag}@example.org`;
const inv = (await D.api('/actions/member.invite', { email: volEmail, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await routeTiles(vctx);
const vp = await vctx.newPage();
vp.on('pageerror', (e) => errors.push('[vol] ' + e.message));
const V = helpers(vp, vctx);
await vp.goto(inv.joinUrl.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
await vp.waitForSelector('#join-name', { timeout: 8000 });
await vp.fill('#join-name', 'Jas Volunteer');
await vp.fill('#join-password', 'knock-knock-2026');
await vp.click('button[type="submit"]');
await vp.waitForURL((u) => !/\/join\//.test(String(u)), { timeout: 15000 }).catch(() => {});
const volId = (await V.api('/auth/me')).json.user.id;
check('volunteer joined and walks the turf', (await D.api('/actions/turf.assign', { turf_id: turf.id, user_id: volId })).status === 200);

// ════════════════════════════════════════════════════════════════════════════
// Volunteer, walk list, with signal
// ════════════════════════════════════════════════════════════════════════════
const openDoor = async (addr) => {
  const head = vp.locator('.walk-door', { hasText: addr }).locator('.walk-door__head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await vp.waitForSelector('.walk-panel', { timeout: 5000 });
  const more = vp.locator('.walk-door.is-open .walk-panel .fk-more__btn');
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  await vp.waitForSelector('.walk-door.is-open .walk-panel .fk-more__body', { timeout: 3000 });
};
const panelText = () => vp.$eval('.walk-door.is-open .walk-panel', (el) => el.innerText.replace(/\s+/g, ' ')).catch(() => '');

await V.go(`/turfs/${turf.id}`);
await vp.waitForSelector('.walk-door', { timeout: 8000 });
await openDoor('12390 72 Ave');
let t = await panelText();
check('walk list door More: "Wants a sign?" and "+ Person at this door"', /Wants a sign\?/i.test(t) && /Lawn sign/i.test(t) && /\+ Person at this door/i.test(t), t.slice(0, 200));
let m = await V.measure('.walk-door.is-open');
check('door More at 390px: ≤1 yellow, no sideways scroll, ≥48px targets', m.yellow <= 1 && m.overflow <= 0 && m.small.length === 0, JSON.stringify(m));
console.log(`      walk list door More: ${m.words} words`);
await V.shot('1-walk-door-more');

await vp.click('.walk-door.is-open button[aria-label="Request a lawn sign"]');
await vp.waitForSelector('.walk-toast button:has-text("Undo")', { timeout: 5000 }).catch(() => {});
t = await V.toast();
const mayaSigns = async () => (await D.api('/signs')).json.signs.filter((s) => s.person_id === P.maya.id);
let ms = await mayaSigns();
check('Lawn sign: "Lawn sign requested" with Undo — and the server has it once', /^Lawn sign requested/i.test(t) && /Undo/i.test(t) && ms.length === 1 && ms[0].kind === 'lawn' && ms[0].status === 'requested', `${t} | ${ms.length}`);
await sleep(600);
t = await panelText();
check('the door shows "Lawn sign · To put up"; no second lawn-sign button', /Lawn sign · To put up/i.test(t) && !(await vp.$('.walk-door.is-open button[aria-label="Request a lawn sign"]')), t.slice(0, 200));
await vp.click('.walk-toast button:has-text("Undo")');
await sleep(800);
t = await V.toast();
ms = await mayaSigns();
check('Undo: "Lawn sign cancelled" — and it is gone from the server', /Lawn sign cancelled/.test(t) && ms.length === 0, `${t} | ${ms.length}`);

await vp.click('.walk-door.is-open button:has-text("+ Person at this door")');
await vp.waitForSelector('form[aria-label="Add a person at this door"]', { timeout: 3000 });
check('the form asks name (phone one tap away), no address', !!(await vp.$('#dp-name')) && !(await vp.$('form[aria-label="Add a person at this door"] [id$="-address"]')));
await vp.fill('#dp-name', 'Ravi Chen');
await vp.click('form[aria-label="Add a person at this door"] button:has-text("Phone")');
await vp.fill('#dp-phone', '604-555-0108');
m = await V.measure('form[aria-label="Add a person at this door"]');
check('add-person form: ≥48px targets', m.small.length === 0, JSON.stringify(m.small));
await V.shot('2-walk-add-person');
await vp.click('form[aria-label="Add a person at this door"] button:has-text("Save person")');
await sleep(1200);
t = await V.text();
const ravi = (await D.api('/persons?q=Ravi%20Chen')).json.persons;
check('"Added Ravi Chen" — once on the server, at Maya’s address and pin', /Added Ravi Chen/.test(t) && ravi.length === 1 && ravi[0].address === '12390 72 Ave' && ravi[0].city === 'Surrey' && ravi[0].postal === 'V3W 2M9' && ravi[0].lat === P.maya.lat && ravi[0].phone === '604-555-0108', JSON.stringify(ravi.map((p) => [p.address, p.lat, p.phone])));
const tabs = await vp.$$eval('.walk-door.is-open .fk-tab', (els) => els.map((e) => ({ name: e.innerText.trim(), on: e.getAttribute('aria-pressed') === 'true' }))).catch(() => []);
check('the door now has Maya · Ravi, and Ravi is picked to rate', tabs.length === 2 && tabs.some((x) => /Ravi Chen/.test(x.name) && x.on), JSON.stringify(tabs));
await vp.click('.walk-door.is-open .walk-panel button[aria-label="1: Strong support"]');
await sleep(1000);
const raviProf = (await D.api(`/persons/${ravi[0]?.id}`)).json;
check('rate Ravi: his knock, once', raviProf.contacts?.length === 1 && raviProf.person.rating === '1');
const ev = (await D.api('/events?since=0&limit=1000')).json.events.filter((e) => e.entity_id === ravi[0]?.id && e.op === 'create');
check('on the log: person.addAtDoor by the volunteer', ev.length === 1 && ev[0].action === 'person.addAtDoor' && ev[0].actor_id === volId, JSON.stringify(ev.map((e) => e.action)));

// ════════════════════════════════════════════════════════════════════════════
// Volunteer, walk list, no signal
// ════════════════════════════════════════════════════════════════════════════
await V.go(`/turfs/${turf.id}`);
await vp.waitForSelector('.walk-door', { timeout: 8000 });
await sleep(800);
await vctx.setOffline(true);
await openDoor('7120 124 St');
await vp.click('.walk-door.is-open button[aria-label="Request a lawn sign"]');
await sleep(500);
t = await V.toast();
check('lawn sign offline: "Lawn sign saved offline" with Undo', /Lawn sign saved offline/i.test(t) && /Undo/i.test(t), t);
check('the door shows "Lawn sign · Not sent yet"', /Lawn sign · Not sent yet/i.test(await panelText()));
await vp.click('.walk-door.is-open button:has-text("+ Person at this door")');
await vp.waitForSelector('form[aria-label="Add a person at this door"]', { timeout: 3000 });
await vp.fill('#dp-name', 'Ana Souza');
await vp.click('form[aria-label="Add a person at this door"] button:has-text("Save person")');
await sleep(800);
t = await V.toast();
check('new housemate offline: "Ana Souza saved offline"', /Ana Souza saved offline/.test(t), t);
const row = await vp.$eval('.walk-door.is-open', (el) => el.innerText.replace(/\s+/g, ' ')).catch(() => '');
check('her door: Tom · Ana, marked not sent', /Tom Riley/.test(row) && /Ana Souza/.test(row) && /Not sent|Offline/i.test(row), row.slice(0, 200));
await vp.click('.walk-door.is-open .walk-panel button[aria-label="2: Lean support"]');
await sleep(500);
check('a knock on her, offline: "Saved offline"', /Saved offline/.test(await V.text()));
check('nothing pretends to send: the server has no Ana', ((await D.api('/persons?q=Ana%20Souza')).json.persons || []).length === 0);
check('chip: 3 saved on this phone', /^3 saved on this phone$/i.test(await V.chip()), await V.chip());
await vp.tap('.offline-strip__chip').catch(() => vp.click('.offline-strip__chip'));
await vp.waitForSelector('.obx-sheet', { timeout: 3000 }).catch(() => {});
const rows = await vp.$$eval('.obx-sheet .obx-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
check('sheet: sign, new person, knock — in plain words, in order', rows.length === 3 && /^Lawn sign · Tom Riley · /.test(rows[0]) && /^New person · Ana Souza · /.test(rows[1]) && /^Knock · Ana Souza · /.test(rows[2]), rows.join(' | '));
await V.shot('3-walk-offline-sheet');
await vp.keyboard.press('Escape').catch(() => {});

await vctx.setOffline(false);
await vp.evaluate(() => window.dispatchEvent(new Event('online')));
for (let i = 0; i < 20 && /saved on this phone/i.test(await V.chip()); i += 1) await sleep(500);
check('back online: everything sent', !(await V.chip()), await V.chip());
const ana = (await D.api('/persons?q=Ana%20Souza')).json.persons;
check('server: Ana once, at Tom’s address and pin, rated 2', ana.length === 1 && ana[0].address === '7120 124 St' && ana[0].lat === P.tom.lat && ana[0].rating === '2', JSON.stringify(ana.map((p) => [p.address, p.rating])));
check('server: her knock once', (await D.api(`/persons/${ana[0]?.id}`)).json.contacts?.length === 1);
const tomSigns = (await D.api('/signs')).json.signs.filter((s) => s.person_id === P.tom.id);
check('server: Tom’s lawn sign once', tomSigns.length === 1 && tomSigns[0].kind === 'lawn');

// ════════════════════════════════════════════════════════════════════════════
// The map's door card, and the server's rule
// ════════════════════════════════════════════════════════════════════════════
await V.go(`/map?person=${P.maya.id}`);
await vp.waitForSelector('aside.door-card', { timeout: 8000 }).catch(() => {});
await vp.click('aside.door-card .fk-more__btn').catch(() => {});
check('map door card in their turf: "+ Person at this door"', !!(await vp.$('aside.door-card button:has-text("+ Person at this door")')));
await V.go(`/map?person=${P.far.id}`);
await vp.waitForSelector('aside.door-card', { timeout: 8000 }).catch(() => {});
await vp.click('aside.door-card .fk-more__btn').catch(() => {});
const farCard = await vp.$eval('aside.door-card', (el) => el.innerText).catch(() => '');
check('a door outside their turf: no "+ Person at this door"', /Far Example/.test(farCard) && !/\+ Person at this door/i.test(farCard), farCard.slice(0, 120));
const refused = await V.api('/actions/person.addAtDoor', { housemate_id: P.far.id, name: 'Out Of Turf' });
check('…and the server refuses it there', refused.status === 403 && /turf/.test(refused.json?.error || ''), JSON.stringify(refused));
check('person.create stays desk-only', (await V.api('/actions/person.create', { name: 'Nope' })).status === 403);

// ════════════════════════════════════════════════════════════════════════════
// Today, the brief, the export
// ════════════════════════════════════════════════════════════════════════════
const vb = (await V.api('/brief')).json;
check('volunteer brief: no first steps (one is about gifts), no money', vb.activation === null && vb.money === null && !JSON.stringify(vb).includes('Log your first gift'));
check('desk brief: first steps still there', (await D.api('/brief')).json.activation?.steps?.some((s) => s.key === 'gift' && s.done));
await V.api('/actions/contact.log', { person_id: P.tom.id, channel: 'text', outcome: 'contacted' });
await V.go('/');
await vp.click('.today-morebox__toggle').catch(() => {});
await sleep(400);
t = await V.text();
check('Today → More: "You 1 · Team 1 text this week" (a text logged by hand)', /You 1 · Team 1 text this week/.test(t), (t.match(/You \d+ · Team \d+ texts? this week/g) || []).join(' | '));
const ex = (await D.api('/export')).json;
const want = ['contacts', 'signs', 'turfs', 'receipts', 'survey_responses', 'texting_optouts', 'ladders', 'ladder_runs'];
check('export: every campaign table, receipts with no token', want.every((k) => Array.isArray(ex?.[k])) && ex.receipts.length >= 1 && ex.receipts.every((r) => !('token' in r)) && !ex.users && !ex.sessions, want.filter((k) => !Array.isArray(ex?.[k])).join(','));
check('the volunteer cannot export', (await V.api('/export')).status === 403);

// ════════════════════════════════════════════════════════════════════════════
// Newsletter: a send whose answer never came back (the server went down
// mid-send) is on record — the screen shows it, never a second copy
// ════════════════════════════════════════════════════════════════════════════
for (const who of ['lost.one', 'lost.two']) await D.api('/actions/subscription.add', { email: `${who}+${tag}@example.org` });
const lostSends = async () => (await D.api('/blasts')).json.blasts.filter((b) => b.subject === 'Lost answer');
await D.go('/outreach/newsletter');
await page.click('button:has-text("Write newsletter")');
await page.waitForSelector('#newsletter-subject', { timeout: 5000 });
await page.fill('#newsletter-subject', 'Lost answer');
await page.fill('#newsletter-body', 'Hello neighbours.');
// The server takes the send; its answer is lost, and so is the first look for it.
let lostGets = 0;
await page.route('**/api/actions/blast.send', async (route) => { await route.fetch(); await route.abort('failed'); });
await page.route('**/api/blasts', (route) => (lostGets++ === 0 ? route.abort('failed') : route.continue()));
await page.click('form.ot-compose button[type="submit"]');
await page.click('button:has-text("Yes, send"), button:has-text("Yes, save")');
await sleep(1200);
check('no answer: the form stays, with the error; the server has the send once', !!(await page.$('#newsletter-subject')) && !!(await page.$('form.ot-compose .error')) && (await lostSends()).length === 1);
// Tapping again first looks for it: found, it is shown as it stands — not sent again.
await page.click('form.ot-compose button[type="submit"]');
await page.click('button:has-text("Yes, send"), button:has-text("Yes, save")');
await sleep(1200);
t = await D.text();
check('the next tap finds it on record: "Saved for 2 subscribers — not sent", no second send', /Saved for 2 subscribers — not sent/.test(t) && !(await page.$('#newsletter-subject')) && (await lostSends()).length === 1, (t.match(/Saved for.{0,60}/) || [''])[0]);
await page.unroute('**/api/actions/blast.send');
await page.unroute('**/api/blasts');

const v = (await D.api('/audit/verify')).json;
check('hash chain verifies', v.ok === true && v.checked > 10, JSON.stringify(v));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
if (server) server.kill();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
