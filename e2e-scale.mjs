// Rating scale E2E — one fresh in-memory campaign. A volunteer on a 390×844
// phone opens the map with signal (the default scale), then, with no signal,
// rates Maya "4 → Locke". Meanwhile the manager, at 1360px, opens Rating
// scale from the account menu, changes the words on 1 ("Definitely"),
// renames Annis, adds Bains (moved up) and takes Locke off the list (asked
// in place), checks the preview and saves. The volunteer's knock reaches the
// server afterwards and is kept (the volunteer tapped it while it was
// offered). The phone then shows the new buttons — and still does after a
// reload with no signal; Locke's old ratings read "4 · Locke (off the
// list)" on the profile, People, Today and the filters. SIMPLE checks on
// the new screen at 1360 and 390 (manager) and on the door card at 390
// (volunteer); volunteers never see the screen or its link; sign-out
// forgets the phone's copy; the books verify.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4212 node server/index.js &
//   BASE=http://127.0.0.1:4212 SHOTS=/tmp/scale node e2e-scale.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const SHOTS = process.env.SHOTS || '/tmp/starbase-scale';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

const tileSvg = (z, x, y) => {
  const lines = [];
  for (let i = 0; i <= 256; i += 32) {
    lines.push(`<line x1="${i}" y1="0" x2="${i}" y2="256" stroke="#fff" stroke-width="${((x * 256 + i) / 32) % 4 === 0 ? 5 : 2}"/>`);
    lines.push(`<line x1="0" y1="${i}" x2="256" y2="${i}" stroke="#fff" stroke-width="${((y * 256 + i) / 32) % 4 === 0 ? 5 : 2}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/>${lines.join('')}</svg>`;
};
const tiles = (ctx) => ctx.route(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/, (route) => {
  const [, z, x, y] = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
  route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: tileSvg(+z, +x, +y) });
});

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const helpers = (page, ctx, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /key|unique/i.test(m.text())) errors.push(`[${who}] ${m.text()}`); });
  return {
    shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }),
    full: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }),
    text: async () => ((await page.innerText('body').catch(() => '')) || '').replace(/\s+/g, ' '),
    // Through the context's own cookies, outside the page (works while the page is offline).
    api: async (path, body) => {
      const r = body === undefined
        ? await ctx.request.get(`${BASE}/api${path}`)
        : await ctx.request.post(`${BASE}/api${path}`, { data: body });
      return { status: r.status(), json: await r.json().catch(() => null) };
    },
    go: async (path) => { await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(1000); },
    chip: () => page.$eval('.offline-strip__chip', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => ''),
    swReady: () => page.evaluate(() => navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))),
  };
};
// SIMPLE.md: words on the screen (not the nav/tab bar), yellow buttons,
// sideways scroll, and every button / input under 48px tall (or 44 wide).
const measure = (page, sel = 'main.page') => page.evaluate((s) => {
  const root = document.querySelector(s) || document.body;
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const words = (root.innerText || '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(vis).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  const small = [...root.querySelectorAll('button, a.btn, input, select, textarea')].filter(vis)
    .map((el) => { const r = el.getBoundingClientRect(); return { t: (el.innerText || el.getAttribute('aria-label') || el.placeholder || el.tagName).trim().slice(0, 24), h: Math.round(r.height), w: Math.round(r.width) }; })
    .filter((x) => x.h < 48 || x.w < 44);
  // Words cut off with an ellipsis (a button too narrow for its word).
  const cut = [...root.querySelectorAll('.rb-btn__sub, .rb-who__name')].filter(vis).filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.innerText);
  return { words, yellow, overflow, small, cut };
}, sel);
const buttonsText = (page, scope) => page.evaluate((sc) => {
  const root = document.querySelector(sc);
  if (!root) return null;
  const row = [...root.querySelectorAll('.rb-row .rb-btn')].map((b) => b.innerText.replace(/\s+/g, ' ').trim());
  const who = [...root.querySelectorAll('.rb-who__btn')].map((b) => b.innerText.replace(/\s+/g, ' ').trim());
  return { row, who };
}, scope);

// ════════════════════════════════════════════════════════════════════════════
// 1. The manager and a small Surrey campaign (laptop)
// ════════════════════════════════════════════════════════════════════════════
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(dctx);
const page = await dctx.newPage();
const D = helpers(page, dctx, 'desk');
await D.go('/signup');
await page.fill('#su-name', 'Riley Manager');
await page.fill('#su-email', `riley+${tag}@scale.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(`${BASE}/`, { timeout: 15000 });

const P = {};
const mk = async (key, data) => { P[key] = (await D.api('/actions/person.create', data)).json.person; };
await mk('lena', { name: 'Lena Example', phone: '604-555-0141', address: '12345 72 Ave', city: 'Surrey', lat: 49.1330, lng: -122.8510 });
await mk('maya', { name: 'Maya Example', phone: '604-555-0142', address: '12390 72 Ave', city: 'Surrey', lat: 49.1331, lng: -122.8495 });
await mk('tom', { name: 'Tom Example', phone: '604-555-0143', address: '7120 124 St', city: 'Surrey', lat: 49.1310, lng: -122.8520 });
await mk('ana', { name: 'Ana Example', phone: '604-555-0144', address: '7201 128 St', city: 'Surrey', lat: 49.1320, lng: -122.8480 });
const turf = (await D.api('/actions/turf.create', {
  name: 'Newton A', polygon: [[49.128, -122.856], [49.136, -122.856], [49.136, -122.844], [49.128, -122.844]],
})).json.turf;
check('seeded 4 doors and a turf', Object.values(P).every((p) => p?.id) && turf?.id);
check('Lena rated 4 → Locke before any change', (await D.api('/actions/contact.log', { person_id: P.lena.id, channel: 'door', outcome: 'contacted', rating: '4B' })).status === 200);

const s0 = (await D.api('/scale')).json?.scale;
check('a new campaign has the default scale',
  s0?.steps.map((x) => x.word).join('|') === 'Strong yes|Lean yes|Undecided|Opposed'
  && s0.candidates.map((c) => `${c.code}:${c.name}`).join('|') === '4D:McCallum|4B:Locke|4F:Annis|4N:van Vliet|4C:Randhawa',
  JSON.stringify(s0?.candidates));

// ════════════════════════════════════════════════════════════════════════════
// 2. A volunteer's phone, with signal: the default buttons
// ════════════════════════════════════════════════════════════════════════════
const volEmail = `jas+${tag}@scale.example`;
const inv = (await D.api('/actions/member.invite', { email: volEmail, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vp = await vctx.newPage();
const V = helpers(vp, vctx, 'vol');
await vp.goto(inv.joinUrl.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
await vp.waitForSelector('#join-name', { timeout: 8000 });
await vp.fill('#join-name', 'Jas Volunteer');
await vp.fill('#join-password', 'knock-knock-2026');
await vp.click('button[type="submit"]');
await vp.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
const volId = (await V.api('/auth/me')).json.user.id;
check('volunteer joined and walks Newton A', (await D.api('/actions/turf.assign', { turf_id: turf.id, user_id: volId })).status === 200);
check('volunteers read the scale (their phone needs it)', (await V.api('/scale')).status === 200);
check('…but may not change it', (await V.api('/actions/scale.save', { words: { 1: 'Yes!' } })).status === 403);

await V.go(`/map?person=${P.maya.id}`);
await vp.waitForSelector('aside.door-card .rb-btn', { timeout: 10000 }).catch(() => {});
await V.swReady().catch(() => {});
await V.go(`/map?person=${P.maya.id}`);
await vp.waitForSelector('aside.door-card .rb-btn', { timeout: 10000 }).catch(() => {});
await sleep(1500); // the phone copies are written a moment after they load
let b = await buttonsText(vp, 'aside.door-card');
check('phone, default scale: 1 Strong yes · 2 Lean yes · 3 Undecided · 4 Opposed', b?.row.join(' | ') === '1 Strong yes | 2 Lean yes | 3 Undecided | 4 Opposed', JSON.stringify(b));
const kept0 = await vp.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('starbase:copy:') && k.endsWith(':scale')));
check('the phone keeps the scale with this sign-in’s copies', kept0.length === 1 && kept0[0].includes(`:${volId}:`), kept0.join(' | '));
// The Rating scale screen isn't theirs.
await vp.click('.acct-btn');
check('volunteer’s account menu: no Rating scale', !(await vp.$('.acct-panel a[href="/rating-scale"]')));
await vp.click('.acct-btn');
await V.go('/rating-scale');
check('volunteer typing /rating-scale lands on Today', new URL(vp.url()).pathname === '/', vp.url());

// No signal: Maya says she's voting Locke. Saved on the phone.
await V.go(`/map?person=${P.maya.id}`);
await vp.waitForSelector('aside.door-card .rb-btn', { timeout: 10000 }).catch(() => {});
await vctx.setOffline(true);
await vp.tap('aside.door-card button[aria-label^="4: Opposed"]').catch(() => vp.click('aside.door-card button[aria-label^="4: Opposed"]'));
await vp.tap('aside.door-card button[aria-label^="4B:"]').catch(() => vp.click('aside.door-card button[aria-label^="4B:"]'));
await sleep(500);
let t = await V.text();
check('offline: "Rated 4 · Locke · Saved offline"', /Rated 4 · Locke · Saved offline/.test(t), (t.match(/Rated[^✕]{0,50}/) || [''])[0]);

// ════════════════════════════════════════════════════════════════════════════
// 3. The manager changes the scale (laptop, 1360)
// ════════════════════════════════════════════════════════════════════════════
await D.go('/');
await page.click('.acct-btn');
const link = await page.$('.acct-panel a[href="/rating-scale"]');
check('manager’s account menu: Rating scale, beside Team', !!link && !!(await page.$('.acct-panel a[href="/team"]')));
await link.click();
await page.waitForURL(`${BASE}/rating-scale`);
await page.waitForSelector('.sc-page .rb-btn', { timeout: 8000 }).catch(() => {});
await sleep(500);
let m = await measure(page);
check('Rating scale at 1360: one yellow (Save, off until a change), no sideways scroll', m.yellow === 1 && m.overflow <= 0
  && await page.locator('.sc-save .btn-primary').isDisabled(), JSON.stringify({ y: m.yellow, o: m.overflow, w: m.words }));
console.log(`      words on the screen at 1360: ${m.words}`);
b = await buttonsText(page, '.sc-preview');
check('preview: the buttons volunteers see now, Voting for? open', b?.row.join(' | ') === '1 Strong yes | 2 Lean yes | 3 Undecided | 4 Opposed'
  && b.who.join(' | ') === 'McCallum | Locke | Annis | van Vliet | Randhawa | Not sure', JSON.stringify(b));
await D.shot('01-scale-desk');

// Words on 1; rename Annis; add Bains and move it up; take Locke off.
await page.fill('input[aria-label="Words for 1"]', 'Definitely');
const annis = page.locator('.sc-cand input[value="Annis"]');
await annis.fill('Linda Annis');
await page.fill('.sc-add input', 'Bains');
await page.click('.sc-add button:has-text("Add")');
await page.click('button[aria-label="Move Bains up"]');
check('Not saved yet, said by Save', /Not saved yet/.test(await D.text()) && await page.locator('.sc-save .btn-primary').isEnabled());
const lockeRow = page.locator('.sc-cand', { has: page.locator('input[value="Locke"]') });
await lockeRow.locator('button:has-text("Take off")').click();
t = await page.locator('.sc-confirm').innerText().catch(() => '');
check('take off asks in place: "Take Locke off the list? Yes · No"', /Take Locke off the list\?\s*Yes\s*No/i.test(t.replace(/\s+/g, ' ')), t);
m = await measure(page);
check('…still one yellow button while it asks', m.yellow === 1, m.yellow);
await page.locator('.sc-confirm button:has-text("No")').click();
check('No keeps Locke on the list', (await page.$$('.sc-cand input[value="Locke"]')).length === 1);
await lockeRow.locator('button:has-text("Take off")').click();
await page.locator('.sc-confirm button:has-text("Yes")').click();
t = await D.text();
check('Yes moves Locke under "Off the list" with how many have him, and Put back',
  /Off the list 1/i.test(t) && /Locke 1 rated Put back/i.test(t), (t.match(/Off the list.{0,90}/i) || [''])[0]);
b = await buttonsText(page, '.sc-preview');
check('preview follows: Definitely, Bains up, Linda Annis, no Locke', b?.row[0] === '1 Definitely'
  && b.who.join(' | ') === 'McCallum | Linda Annis | van Vliet | Bains | Randhawa | Not sure', JSON.stringify(b));
check('nothing saved yet', (await D.api('/scale')).json.scale.version === 0);
await D.full('02-scale-desk-edited');
await page.click('.sc-save .btn-primary');
await page.waitForSelector('.sc-save [role="status"]', { timeout: 6000 }).catch(() => {});
check('Save: "✓ Saved"', /✓ Saved/.test(await page.locator('.sc-save').innerText().catch(() => '')));
const s1 = (await D.api('/scale')).json.scale;
const by = Object.fromEntries(s1.candidates.map((c) => [c.code, c]));
check('server: words, rename kept the code, Bains got a new code, Locke off the list',
  s1.steps[0].word === 'Definitely' && by['4F']?.name === 'Linda Annis' && by['4BA']?.name === 'Bains' && by['4BA'].off === false
  && by['4B']?.off === true && s1.candidates.filter((c) => !c.off).map((c) => c.code).join(',') === '4D,4F,4N,4BA,4C',
  JSON.stringify(s1.candidates.map((c) => [c.code, c.name, c.off])));
await D.go('/rating-scale');
await page.waitForSelector('.sc-page .rb-btn', { timeout: 8000 }).catch(() => {});
check('reopened: as saved', await page.inputValue('input[aria-label="Words for 1"]') === 'Definitely'
  && (await page.$$eval('.sc-cand input', (els) => els.map((e) => e.value))).join('|') === 'McCallum|Linda Annis|van Vliet|Bains|Randhawa');

// ── The same screen on a phone (manager) ──
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', storageState: await dctx.storageState() });
await tiles(mctx);
const mp = await mctx.newPage();
const M = helpers(mp, mctx, 'mgr-phone');
await M.go('/rating-scale');
await mp.waitForSelector('.sc-page .rb-btn', { timeout: 8000 }).catch(() => {});
m = await measure(mp);
check('Rating scale at 390: one yellow, no sideways scroll, every control ≥ 48px', m.yellow === 1 && m.overflow <= 0 && m.small.length === 0, JSON.stringify({ y: m.yellow, o: m.overflow, small: m.small }));
check('…and no word cut off on the preview buttons', m.cut.length === 0, m.cut.join(', '));
console.log(`      words on the screen at 390: ${m.words}`);
await M.full('03-scale-phone');
// The longest words the screen takes still read whole on a phone's buttons.
await mp.fill('input[aria-label="Words for 2"]', 'Probably yes'.padEnd(12, 'x').slice(0, 12));
await mp.fill('.sc-add input', 'Abcdefghij Klmnop');
check('a name is held to 16 letters', (await mp.inputValue('.sc-add input')).length === 16);
await mp.click('.sc-add button:has-text("Add")');
m = await measure(mp);
check('longest words at 390: wrapped, never cut off, no sideways scroll', m.cut.length === 0 && m.overflow <= 0, JSON.stringify({ cut: m.cut, o: m.overflow }));
await M.shot('03b-scale-phone-long');
await mctx.close();

// ════════════════════════════════════════════════════════════════════════════
// 4. Back to the volunteer's phone
// ════════════════════════════════════════════════════════════════════════════
await vctx.setOffline(false);
await vp.evaluate(() => window.dispatchEvent(new Event('online')));
for (let i = 0; i < 24 && /saved on this phone/i.test(await V.chip()); i += 1) await sleep(250);
const strip = await vp.innerText('.offline-strip').catch(() => '');
check('back online: the knock goes, "1 sent" (nothing refused)', /✓ 1 sent/i.test(strip) && !/refused/i.test(strip), strip.replace(/\s+/g, ' '));
let maya = (await D.api(`/persons/${P.maya.id}`)).json;
check('server kept the knock made while Locke was on the list: Maya 4B, once', maya.person.rating === '4B'
  && maya.contacts.filter((c) => c.rating === '4B').length === 1, JSON.stringify(maya.contacts.map((c) => c.rating)));
check('a new 4B from the desk is refused now', (await D.api('/actions/contact.log', { person_id: P.tom.id, channel: 'door', outcome: 'contacted', rating: '4B' })).status === 400);

// With signal: the new buttons.
await V.go(`/map?person=${P.tom.id}`);
await vp.waitForSelector('aside.door-card .rb-btn', { timeout: 10000 }).catch(() => {});
await sleep(800);
b = await buttonsText(vp, 'aside.door-card');
check('phone: 1 Definitely · 2 Lean yes · 3 Undecided · 4 Opposed', b?.row.join(' | ') === '1 Definitely | 2 Lean yes | 3 Undecided | 4 Opposed', JSON.stringify(b));
await vp.tap('aside.door-card button[aria-label^="4: Opposed"]').catch(() => vp.click('aside.door-card button[aria-label^="4: Opposed"]'));
await sleep(300);
b = await buttonsText(vp, 'aside.door-card');
check('Voting for? McCallum · Linda Annis · van Vliet · Bains · Randhawa · Not sure (no Locke)',
  b?.who.join(' | ') === 'McCallum | Linda Annis | van Vliet | Bains | Randhawa | Not sure', JSON.stringify(b?.who));
m = await measure(vp, 'aside.door-card');
const rbSmall = await vp.$$eval('aside.door-card .rb-btn, aside.door-card .rb-who__btn', (els) => els.map((e) => e.getBoundingClientRect().height).filter((h) => h < 48));
check('door card at 390: rating buttons ≥ 48px, no sideways scroll, no word cut off', rbSmall.length === 0 && m.overflow <= 0 && m.cut.length === 0, JSON.stringify({ rbSmall, o: m.overflow, cut: m.cut }));
await V.shot('04-vol-new-buttons');
await vp.tap('aside.door-card button[aria-label^="4BA:"]').catch(() => vp.click('aside.door-card button[aria-label^="4BA:"]'));
await sleep(600);
check('tap Bains: "Rated 4 · Bains"', /Rated 4 · Bains/.test(await V.text()));
check('server: Tom 4BA', (await D.api(`/persons/${P.tom.id}`)).json.person.rating === '4BA');

// Old ratings: Maya's 4 reads Locke; her profile says off the list.
await V.go(`/map?person=${P.maya.id}`);
await vp.waitForSelector('aside.door-card .rb-btn', { timeout: 10000 }).catch(() => {});
b = await buttonsText(vp, 'aside.door-card');
check('Maya’s door: 4 shows her old pick, Locke', b?.row[3] === '4 Locke', JSON.stringify(b?.row));
await V.go(`/people/${P.maya.id}`);
await vp.waitForSelector('.pf-meta .rb-chip', { timeout: 8000 }).catch(() => {});
t = await vp.innerText('.pf-meta').catch(() => '');
check('profile: "4 · Locke (off the list)"', /4 · Locke \(off the list\)/.test(t), t);
check('history line: "Rated 4 · Locke (off the list)"', /Locke \(off the list\)/.test(await V.text()));

// No signal, reload: still the campaign's buttons.
await V.go(`/map?person=${P.ana.id}`);
await vp.waitForSelector('aside.door-card .rb-btn', { timeout: 10000 }).catch(() => {});
await sleep(1500);
await vctx.setOffline(true);
await vp.reload({ waitUntil: 'domcontentloaded' });
await vp.waitForSelector('aside.door-card .rb-btn', { timeout: 15000 }).catch(() => {});
await sleep(800);
b = await buttonsText(vp, 'aside.door-card');
check('offline reload: 1 Definitely … (the phone’s copy)', b?.row.join(' | ') === '1 Definitely | 2 Lean yes | 3 Undecided | 4 Opposed', JSON.stringify(b));
await vp.tap('aside.door-card button[aria-label^="4: Opposed"]').catch(() => vp.click('aside.door-card button[aria-label^="4: Opposed"]'));
await sleep(300);
b = await buttonsText(vp, 'aside.door-card');
check('offline reload: Voting for? has Bains and Linda Annis, no Locke', b?.who.join(' | ') === 'McCallum | Linda Annis | van Vliet | Bains | Randhawa | Not sure', JSON.stringify(b?.who));
await V.shot('05-vol-offline-reload');
await vp.tap('aside.door-card button[aria-label^="4F:"]').catch(() => vp.click('aside.door-card button[aria-label^="4F:"]'));
await sleep(500);
check('offline knock: "Rated 4 · Linda Annis · Saved offline"', /Rated 4 · Linda Annis · Saved offline/.test(await V.text()));
await vctx.setOffline(false);
await vp.evaluate(() => window.dispatchEvent(new Event('online')));
for (let i = 0; i < 24 && /saved on this phone/i.test(await V.chip()); i += 1) await sleep(250);
check('sent: Ana 4F', (await D.api(`/persons/${P.ana.id}`)).json.person.rating === '4F');

// ════════════════════════════════════════════════════════════════════════════
// 5. The desk reads old ratings
// ════════════════════════════════════════════════════════════════════════════
await D.go('/people');
await page.waitForSelector('.pp-rtag, .rb-chip', { timeout: 8000 }).catch(() => {});
t = await D.text();
check('People: Lena and Maya "4 · Locke (off the list)", Tom "4 · Bains"', (t.match(/4 · Locke \(off the list\)/g) || []).length === 2 && /4 · Bains/.test(t), (t.match(/4 · [^·]{0,30}/g) || []).join(' | '));
await page.click('.pp-filterbtn');
await page.click('.pp-morefilters');
await page.waitForSelector('.pp-sheet__more', { timeout: 4000 }).catch(() => {});
const whoChips = await page.$$eval('.pp-sheet__more fieldset:first-child .pp-pick', (els) => els.map((e) => e.innerText.trim()));
check('Voting for… filter: the list, then Locke (off the list)', whoChips.join(' | ').toLowerCase() === 'mccallum | linda annis | van vliet | bains | randhawa | locke (off the list)', whoChips.join(' | '));
await page.click('.pp-sheet__more .pp-pick:has-text("Locke")');
await sleep(800);
await page.click('.pp-sheet__head button:has-text("Done")');
await sleep(500);
const UUID_LINK = /^\/people\/[0-9a-f-]{36}$/;
const listed = () => page.$$eval('main.page a[href^="/people/"]', (els) => els.map((e) => e.getAttribute('href'))).then((h) => [...new Set(h.filter((x) => UUID_LINK.test(x)))]);
const rows = await listed();
check('…finds the two people who backed Locke', rows.length === 2 && rows.includes(`/people/${P.lena.id}`) && rows.includes(`/people/${P.maya.id}`), rows.join(' '));
await page.click('.pp-filterbtn');
await page.click('.pp-sheet .pp-pick:text-is("Opposed")');
await sleep(800);
await page.click('.pp-sheet__head button:has-text("Done")');
await sleep(500);
const opposed = (await listed()).length;
check('Opposed band reaches every code, old and new (Lena, Maya, Tom, Ana)', opposed === 4, opposed);
// The same list on the manager's phone: the long chip never pushes the page sideways.
const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', storageState: await dctx.storageState() });
const pp = await pctx.newPage();
const PP = helpers(pp, pctx, 'mgr-phone-2');
await PP.go('/people');
await pp.waitForSelector('.rb-chip', { timeout: 8000 }).catch(() => {});
m = await measure(pp);
check('People at 390 with “4 · Locke (off the list)”: no sideways scroll', m.overflow <= 0 && /Locke \(off the list\)/i.test(await PP.text()), m.overflow);
await PP.go(`/people/${P.lena.id}`);
await pp.waitForSelector('.pf-meta .rb-chip', { timeout: 8000 }).catch(() => {});
m = await measure(pp);
check('Lena’s profile at 390: no sideways scroll', m.overflow <= 0, m.overflow);
await pctx.close();

// Import: the campaign's codes and words, any case; what isn't on the list is named.
await D.go('/people/import');
await page.click('button:has-text("Paste text")');
await page.fill('#imp-paste', [
  'Name,Phone,Support',
  'Rae Example,604-555-0151,definitely',
  'Sol Example,604-555-0152,BAINS',
  'Kit Example,604-555-0153,locke',
  'Ola Example,604-555-0154,7',
  'Ida Example,604-555-0155,4ba',
].join('\n'));
await page.click('button:has-text("Use this text")');
await page.waitForSelector('#imp-col-2', { timeout: 6000 }).catch(() => {});
// 2 of 5 off the scale is too many to guess "Rating" from: pick it.
if (await page.inputValue('#imp-col-2') !== 'rating') await page.selectOption('#imp-col-2', 'rating');
await page.waitForSelector('.imp-map__note.is-warn', { timeout: 6000 }).catch(() => {});
t = await page.innerText('.imp-map__note.is-warn').catch(() => '');
check('import: “2 ratings aren’t on the scale (“locke” (off the list), “7”)”', /2 ratings aren’t on the scale \(“locke” \(off the list\), “7”\) — they come in unrated/.test(t), t);
await page.click('button.disclose:has-text("Preview")').catch(() => {});
await page.waitForSelector('.imp-preview__table', { timeout: 4000 }).catch(() => {});
const chips = await page.$$eval('.imp-preview__table .rb-chip', (els) => els.map((e) => e.innerText.trim().toLowerCase()));
check('…the rest read in the campaign’s words: 1, 4 · Bains, 4 · Bains', chips.join(' | ') === '1 | 4 · bains | 4 · bains', chips.join(' | '));
await D.go('/');
await page.click('button.today-num[aria-controls]').catch(() => {});
await sleep(400);
const variants = await page.$$eval('.today-variants li', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim())).catch(() => []);
check('Today: opposed by candidate still counts Locke', variants.some((v) => /^Locke 2$/.test(v)) && variants.some((v) => /^Bains 1$/.test(v)), variants.join(' | '));

// ════════════════════════════════════════════════════════════════════════════
// 6. Sign-out forgets the phone's copy; the books verify
// ════════════════════════════════════════════════════════════════════════════
await V.go('/');
await vp.click('.acct-btn');
await vp.click('.acct-panel button:has-text("Sign out")');
await vp.waitForURL(`${BASE}/login`, { timeout: 8000 }).catch(() => {});
await sleep(500);
const left = await vp.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('starbase:copy:') || k.startsWith('starbase:me:')));
check('signed out: the scale copy (and the rest) are gone from the phone', left.length === 0, left.join(' | '));
await vctx.close();

const ev = (await D.api('/events?since=0&limit=5000')).json.events.filter((e) => e.action === 'scale.save');
check('the change is on the log, once', ev.length === 1 && ev[0].payload?.changes?.off?.includes('4B'), ev.length);
const v = (await D.api('/audit/verify')).json;
check('hash chain verifies', v.ok === true, JSON.stringify(v));

// ════════════════════════════════════════════════════════════════════════════
// 7. Fix round: a rename that would move people's ratings, names Save would
//    refuse, the phone's newer scale copy, an old "Opposed" link after a new
//    candidate, chips that give way to names at 390, Put back at 12, and a
//    profile-field filter with no signal
// ════════════════════════════════════════════════════════════════════════════
// Lena's door gets a second person (the door card's tabs, below).
const leo = (await D.api('/actions/person.create', { name: 'Leonardo Example', phone: '604-555-0146', address: P.lena.address, city: 'Surrey', lat: P.lena.lat, lng: P.lena.lng })).json.person;
check('Lena’s door gets a second person', !!leo?.id);
// The volunteer signs in again on a fresh phone and opens the map (its copy
// of the scale is the current one).
const v2ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(v2ctx);
const v2 = await v2ctx.newPage();
const V2 = helpers(v2, v2ctx, 'vol-2');
check('volunteer signs in again', (await v2ctx.request.post(`${BASE}/api/auth/login`, { data: { email: volEmail, password: 'knock-knock-2026' } })).ok());
await V2.go(`/map?person=${P.ana.id}`);
await v2.waitForSelector('aside.door-card .rb-btn', { timeout: 10000 }).catch(() => {});
await V2.swReady().catch(() => {});
await sleep(1500);
const sBefore = (await D.api('/scale')).json.scale;
const opposedBefore = sBefore.candidates.map((c) => c.code); // the band's codes before a new candidate
const rows7 = () => page.$$eval('.sc-cand input', (els) => els.map((e) => e.value));
const noteText = () => page.$$eval('.sc-note', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));

// Rating scale (manager, 1360): typing a new name over Bains (Tom is rated Bains).
const nBains = Number((await D.api('/brief')).json.ratings?.['4BA']) || 0;
const saysBains = `${nBains} ${nBains === 1 ? 'person' : 'people'} rated Bains will read Sidhu — someone new?`;
await D.go('/rating-scale');
await page.waitForSelector('.sc-page .rb-btn', { timeout: 8000 }).catch(() => {});
await page.fill('.sc-cand input[value="Bains"]', 'Sidhu');
let notes = await noteText();
check(`typing over Bains says what it does: "${saysBains}"`,
  nBains > 0 && notes.length === 1 && notes[0].toLowerCase() === `${saysBains} Add them instead`.toLowerCase(), notes.join(' | '));
m = await measure(page);
check('…still one yellow button, no sideways scroll', m.yellow === 1 && m.overflow <= 0, JSON.stringify({ y: m.yellow, o: m.overflow }));
await D.shot('07-rename-note');
await page.click('.sc-note button:has-text("Add them instead")');
check('Add them instead: Bains keeps their name, Sidhu is added', (await rows7()).join('|') === 'McCallum|Linda Annis|van Vliet|Bains|Randhawa|Sidhu' && (await noteText()).length === 0, (await rows7()).join('|'));
// Names Save would refuse, said under the row as typed.
await page.fill('.sc-cand input[value="Randhawa"]', 'LOCKE');
notes = await noteText();
check('renamed onto someone off the list: "Locke is off the list — Put back below"', notes.some((n) => /^Locke is off the list — Put back below$/.test(n)), notes.join(' | '));
await page.fill('.sc-cand input[value="LOCKE"]', 'Strong support');
notes = await noteText();
check('a step’s usual words: "“Strong support” is a step’s words — pick another name"', notes.some((n) => /“Strong support” is a step’s words — pick another name/.test(n)), notes.join(' | '));
await page.fill('.sc-cand input[value="Strong support"]', 'Randhawa');
check('…back to Randhawa: no line', (await noteText()).length === 0);
await page.click('.sc-save .btn-primary');
await page.waitForSelector('.sc-save [role="status"]', { timeout: 6000 }).catch(() => {});
const sNew = (await D.api('/scale')).json.scale;
const sidhu = sNew.candidates.find((c) => c.name === 'Sidhu');
check('saved: Bains kept their code, Sidhu is new', sidhu && !opposedBefore.includes(sidhu.code) && sNew.candidates.find((c) => c.code === '4BA')?.name === 'Bains', JSON.stringify(sNew.candidates.map((c) => [c.code, c.name])));

// The phone opens Shifts with signal (no rating buttons there: its own copy
// of the scale stays old, the sign-in's is new), then the map with no signal.
await V2.go('/shifts');
await sleep(1500);
await v2ctx.setOffline(true);
await v2.goto(`${BASE}/map?person=${P.ana.id}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
await v2.waitForSelector('aside.door-card .rb-btn', { timeout: 15000 }).catch(() => {});
await sleep(800);
await v2.tap('aside.door-card button[aria-label^="4: Opposed"]').catch(() => v2.click('aside.door-card button[aria-label^="4: Opposed"]').catch(() => {}));
await sleep(300);
b = await buttonsText(v2, 'aside.door-card');
check('no signal: the map offers Sidhu (the newer of the phone’s two copies)', b?.who.includes('Sidhu'), JSON.stringify(b?.who));
await v2ctx.setOffline(false);
await v2.evaluate(() => window.dispatchEvent(new Event('online')));
await sleep(800);

// An old "Opposed" link (its codes from before Sidhu) still reaches Sidhu's people.
check('Tom is rated Sidhu', (await D.api('/actions/contact.log', { person_id: P.tom.id, channel: 'door', outcome: 'contacted', rating: sidhu.code })).status === 200);
const opposedNow = (await D.api(`/persons?q=&limit=300&rating=${['4', ...sNew.candidates.map((c) => c.code)].join(',')}`)).json.persons;
const oldLink = `rating=${encodeURIComponent(['4', ...opposedBefore].join(','))}`;
await D.go(`/people?${oldLink}`);
await page.waitForSelector('.pp-count', { timeout: 8000 }).catch(() => {});
await sleep(500);
const oldRows = await listed();
check('People with the old Opposed link: every opposed person, Tom (Sidhu) too', oldRows.length === opposedNow.length && oldRows.includes(`/people/${P.tom.id}`)
  && /Opposed/.test(await page.innerText('.pp-chips').catch(() => '')), `${oldRows.length} vs ${opposedNow.length}`);
await page.click('.pp-filterbtn');
const onChips = await page.$$eval('.pp-sheet .pp-pick.on', (els) => els.map((e) => e.innerText.trim().toLowerCase()));
check('…and the sheet shows Opposed on', onChips.join('|') === 'opposed', onChips.join('|'));
await page.click('.pp-sheet__head button:has-text("Done")');
await D.go(`/calls?${oldLink}&channel=phone`);
await sleep(800);
const toCall = opposedNow.filter((p) => p.phone).length;
check(`Calls carried from it: ${toCall} to call (Sidhu’s too)`, new RegExp(`\\b${toCall} to call`).test(await D.text()), (await D.text()).match(/\d+ to call/)?.[0]);

// A long name off the list, at 390: the chip gives way, never the address or the names.
check('manager renames Locke (off the list) "Brenda van Locke"', (await D.api('/actions/scale.save', {
  candidates: sNew.candidates.map((c) => ({ code: c.code, name: c.code === '4B' ? 'Brenda van Locke' : c.name, off: c.off })),
})).status === 200);
await V2.go(`/turfs/${turf.id}`);
await v2.waitForSelector('.walk-door__head', { timeout: 10000 }).catch(() => {});
await sleep(600);
const maya7 = await v2.$$eval('.walk-door__head', (els) => els.map((h) => {
  const a = h.querySelector('.walk-door__addr'); const n = h.querySelector('.walk-door__names'); const c = h.querySelector('.walk-door__chips .rb-chip');
  const head = h.getBoundingClientRect();
  return { addr: a.innerText, addrH: Math.round(a.getBoundingClientRect().height), namesCut: n.scrollWidth > n.clientWidth + 1, names: n.innerText,
    chip: c?.innerText || '', title: c?.title || '', chipRight: c ? Math.round(c.getBoundingClientRect().right) : 0, headRight: Math.round(head.right) };
}).find((r) => /Maya/.test(r.names)));
check('walk list at 390: Maya’s door reads "4 · Brenda van Locke", address on one line, name whole',
  maya7 && /^4 · Brenda van Locke$/.test(maya7.chip) && /off the list/.test(maya7.title) && maya7.addrH <= 30 && !maya7.namesCut && maya7.chipRight <= maya7.headRight,
  JSON.stringify(maya7));
m = await measure(v2);
check('…no sideways scroll on the walk list', m.overflow <= 0, m.overflow);
await V2.shot('07-walk-long');
await V2.go(`/map?person=${P.lena.id}`);
await v2.waitForSelector('aside.door-card .fk-tabs', { timeout: 10000 }).catch(() => {});
await sleep(800);
const tabs7 = await v2.$$eval('aside.door-card .fk-tab', (els) => els.map((e) => {
  const n = e.querySelector('.fk-tab__name'); const c = e.querySelector('.rb-chip');
  return { name: n.innerText, cut: n.scrollWidth > n.clientWidth + 1, chip: c?.innerText || '', right: Math.round(e.getBoundingClientRect().right) };
}));
const strip7 = await v2.$eval('aside.door-card .fk-tabs', (e) => ({ sw: e.scrollWidth, cw: e.clientWidth })).catch(() => null);
check('door card at 390: both names whole, nothing off to the side', tabs7.length === 2 && tabs7.every((t) => !t.cut && t.right <= 390) && strip7 && strip7.sw <= strip7.cw,
  JSON.stringify({ tabs7, strip7 }));
await V2.shot('07-door-tabs');
// People rows at 390 (manager): the name stays on its line.
const p7ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver', storageState: await dctx.storageState() });
const p7 = await p7ctx.newPage();
const P7 = helpers(p7, p7ctx, 'mgr-phone-3');
await P7.go('/people?rating=4B');
await p7.waitForSelector('.pp-row', { timeout: 8000 }).catch(() => {});
const ppRows = await p7.$$eval('.pp-row', (els) => els.map((r) => ({ name: r.querySelector('.pp-row__name').innerText, h: Math.round(r.querySelector('.pp-row__name').getBoundingClientRect().height), chip: Math.round(r.querySelector('.rb-chip').getBoundingClientRect().width), row: Math.round(r.getBoundingClientRect().width) })));
check('People at 390: the long chip gives way, each name on one line', ppRows.length === 2 && ppRows.every((r) => r.h <= 26 && r.chip <= r.row / 2 + 1), JSON.stringify(ppRows));
// Rating scale at 390: twelve on the list — Put back waits.
await P7.go('/rating-scale');
await p7.waitForSelector('.sc-page .rb-btn', { timeout: 8000 }).catch(() => {});
for (const name of ['Aa Example', 'Bb Example', 'Cc Example', 'Dd Example', 'Ee Example', 'Ff Example']) {
  if (await p7.locator('.sc-add input').isDisabled()) break;
  await p7.fill('.sc-add input', name);
  await p7.click('.sc-add button:has-text("Add")');
}
const onCount = (await p7.$$('.sc-cand')).length;
check('twelve on the list: Put back is off, "12 at most on the list — take one off first"', onCount === 12
  && await p7.locator('.sc-gone button:has-text("Put back")').first().isDisabled()
  && /12 at most on the list — take one off first/.test(await p7.innerText('.sc-sec:has(#sc-off)').catch(() => '')), onCount);
m = await measure(p7);
check('…one yellow, no sideways scroll, every control ≥ 48px', m.yellow === 1 && m.overflow <= 0 && m.small.length === 0, JSON.stringify({ y: m.yellow, o: m.overflow, small: m.small }));
await P7.full('07-scale-full-390');
await p7ctx.close();

// A profile-field filter with no signal (desk, 1360): never the whole kept list.
const fld = (await D.api('/actions/field.create', { name: 'Strata council member', kind: 'yesno' })).json.field;
check('a Yes/No field, Lena yes', fld?.id && (await D.api('/actions/field.values.set', { person_id: P.lena.id, values: [{ field_id: fld.id, value: true }] })).status === 200);
await D.go('/people');
await page.waitForSelector('.pp-table, .pp-list', { timeout: 8000 }).catch(() => {});
await sleep(1500); // kept a moment after it loads
await dctx.setOffline(true);
const inApp = (url) => page.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')); }, url);
await inApp(`/people?field=${encodeURIComponent(`${fld.id}:yes`)}`);
await sleep(2500);
t = await D.text();
const offRows = await page.$$eval('.pp-table tbody tr, .pp-list li', (els) => els.length);
check('no signal, People by a field never opened here: "No signal — the list loads…", not everyone', /No signal — the list loads when you’re back online/.test(t) && offRows === 0, `${offRows} rows`);
await inApp(`/calls?field=${encodeURIComponent(`${fld.id}:yes`)}&channel=phone`);
await sleep(2500);
check('…Calls by it too: No signal', /No signal — your list loads when you’re back online/.test(await D.text()) && !/\d+ to call/.test(await D.text()), (await D.text()).slice(0, 160));
await D.shot('07-field-offline');
await dctx.setOffline(false);
await D.go(`/people?field=${encodeURIComponent(`${fld.id}:yes`)}`);
await page.waitForSelector('.pp-count', { timeout: 8000 }).catch(() => {});
check('back online: Lena, the one person it matches', (await listed()).join(' ') === `/people/${P.lena.id}`, (await listed()).join(' '));
await v2ctx.close();
const v7 = (await D.api('/audit/verify')).json;
check('hash chain still verifies', v7.ok === true, JSON.stringify(v7));

// ════════════════════════════════════════════════════════════════════════════
// 8. Fix round 2: a row renamed to a name on the list, then taken off, is
//    refused at Save (said under it, too); Calls never shows "Offline copy"
//    over "No signal"
// ════════════════════════════════════════════════════════════════════════════
const s8 = (await D.api('/scale')).json.scale;
await D.go('/rating-scale');
await page.waitForSelector('.sc-page .rb-btn', { timeout: 8000 }).catch(() => {});
const on8 = await rows7();
const [first8, , third8] = on8;
await page.locator('.sc-cand').nth(2).locator('input').fill(first8);
notes = await noteText();
check(`renamed onto ${first8} (on the list): "${first8} is already on the list"`, notes.includes(`${first8} is already on the list`), notes.join(' | '));
await page.locator('.sc-cand').nth(2).locator('button:has-text("Take off")').click();
await page.click('.sc-confirm button:has-text("Yes")');
notes = await noteText();
const offSec = await page.innerText('.sc-sec:has(#sc-off)').catch(() => '');
check(`…taken off: under Off the list, "${first8} is already on the list — Put back to rename"`,
  notes.includes(`${first8} is already on the list — Put back to rename`) && offSec.includes(`${first8} is already on the list — Put back to rename`), notes.join(' | '));
m = await measure(page);
check('…one yellow button, no sideways scroll', m.yellow === 1 && m.overflow <= 0, JSON.stringify({ y: m.yellow, o: m.overflow }));
await D.shot('08-renamed-off');
await page.click('.sc-save .btn-primary');
await page.waitForSelector('.sc-page > .error', { timeout: 6000 }).catch(() => {});
const err8 = await page.innerText('.sc-page > .error').catch(() => '');
const s8after = (await D.api('/scale')).json.scale;
check(`Save refuses it: "${first8} is already on the list — pick another name", nothing changed`,
  err8 === `${first8} is already on the list — pick another name` && JSON.stringify(s8after.candidates) === JSON.stringify(s8.candidates), err8);
// Put back, the old name typed again: no line, Save is the same list.
await page.click(`.sc-gone:has-text("${first8}") button:has-text("Put back")`);
await page.locator('.sc-cand').last().locator('input').fill(third8);
check('put back and named as before: no line', (await noteText()).length === 0, (await noteText()).join(' | '));
await D.go('/rating-scale');

// Calls (volunteer, 390): loaded with signal, then a filter never opened
// here with no signal — "No signal", and no "Offline copy" over it.
const c8ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
const c8 = await c8ctx.newPage();
const C8 = helpers(c8, c8ctx, 'vol-calls');
check('volunteer signs in on another phone', (await c8ctx.request.post(`${BASE}/api/auth/login`, { data: { email: volEmail, password: 'knock-knock-2026' } })).ok());
await C8.go('/calls?channel=phone');
await c8.waitForSelector('.cl-page', { timeout: 10000 }).catch(() => {});
await sleep(1500); // kept a moment after it loads
await c8ctx.setOffline(true);
const inApp8 = (url) => c8.evaluate((u) => { history.pushState({}, '', u); dispatchEvent(new PopStateEvent('popstate')); }, url);
await inApp8('/calls?channel=phone&rating=3');
await sleep(2500);
t = await C8.text();
const copyChip = await c8.$$eval('.cl-copy', (els) => els.length);
check('no signal, Calls for Undecided (never opened here): "No signal", no "Offline copy" chip',
  /No signal — your list loads when you’re back online/.test(t) && copyChip === 0 && !/\d+ to call/.test(t), `${copyChip} chip · ${t.slice(0, 160)}`);
m = await measure(c8);
check('…no sideways scroll', m.overflow <= 0, m.overflow);
await C8.shot('08-calls-offline-unseen');
await inApp8('/calls?channel=phone');
await sleep(2500);
t = await C8.text();
check('…back to the list it kept: "Offline copy" and the list', (await c8.$$eval('.cl-copy', (els) => els.length)) === 1 && !/No signal — your list loads/.test(t), t.slice(0, 160));
await c8ctx.close();
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
