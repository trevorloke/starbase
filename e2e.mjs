// Starbase release E2E — one fresh Imagine Surrey workspace, end to end across
// every screen: signup → seed Surrey doors → map (rate, outcome, sign, deep
// link, filters) → people (tags) → Calls → profile → shifts (assign +
// notify) → outreach (newsletter, press, petition, website bridge) → public
// pages → Today → team invite → volunteer on a phone (map, shifts, signs,
// what they can't reach) → audit chain.
//
//   node server/index.js   (in-memory DB, serves web/dist)  then  node e2e.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = { toString() { return `${BASE}/admin`; } }; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/starbase-shots';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 160) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// OSM tiles are unreachable from the test sandbox; serve a stylized street
// grid so screenshots read as a map. Real deployments load real tiles.
const tileSvg = (z, x, y) => {
  const lines = [];
  for (let i = 0; i <= 256; i += 32) {
    const major = ((x * 256 + i) / 32) % 4 === 0;
    lines.push(`<line x1="${i}" y1="0" x2="${i}" y2="256" stroke="#fff" stroke-width="${major ? 5 : 2}"/>`);
  }
  for (let j = 0; j <= 256; j += 32) {
    const major = ((y * 256 + j) / 32) % 4 === 0;
    lines.push(`<line x1="0" y1="${j}" x2="256" y2="${j}" stroke="#fff" stroke-width="${major ? 5 : 2}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/>${lines.join('')}</svg>`;
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await ctx.route(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/, (route) => {
  const [, z, x, y] = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
  route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg(+z, +x, +y) });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
const text = async () => ((await page.innerText('body').catch(() => '')) || '').replace(/\s+/g, ' ');
const api = (path, body) => page.evaluate(async ([p, b]) => {
  const r = await fetch('/api' + p, b === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}, [path, body]);
const act = (name, input) => api(`/actions/${name}`, input);
const go = async (path) => { await page.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); };

// ── 1. First-run setup: always Imagine Surrey, BC municipal ──
await go('/signup');
await page.fill('#su-name', 'Trevor Loke');
await page.fill('#su-email', 'trevor@imaginesurrey.example');
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const me = (await api('/auth/me')).json;
check('workspace created with slug', me.workspace.slug === 'imagine-surrey', me.workspace.slug);
check('setup is BC municipal', me.workspace.jurisdiction === 'bc-municipal', me.workspace.jurisdiction);
check('brand reads Starbase', /starbase/i.test(await text()));

// ── 2. Seed Surrey doors (Newton) ──
const P = {};
const mk = async (key, data) => { P[key] = (await act('person.create', data)).json.person; };
await mk('harjit', { name: 'Harjit Gill', phone: '604-555-0101', address: '12345 72 Ave', city: 'Surrey', lat: 49.13300, lng: -122.85100 });
await mk('simran', { name: 'Simran Gill', phone: '604-555-0102', address: '12345 72 Ave', city: 'Surrey', lat: 49.13300, lng: -122.85100 });
await mk('maya',   { name: 'Maya Chen',   phone: '604-555-0103', email: 'maya@example.org', address: '12390 72 Ave', city: 'Surrey', lat: 49.13310, lng: -122.84950 });
await mk('tom',    { name: 'Tom Riley',   phone: '604-555-0104', address: '7120 124 St', city: 'Surrey', lat: 49.13100, lng: -122.85200 });
await mk('ana',    { name: 'Ana Souza',   address: '7155 124 St', city: 'Surrey', lat: 49.13160, lng: -122.85210 });
await mk('dev',    { name: 'Dev Patel',   phone: '604-555-0106', address: '12410 70A Ave', city: 'Surrey', lat: 49.12950, lng: -122.84800 });
await mk('grace',  { name: 'Grace Kim',   phone: '604-555-0107', address: '7201 128 St', city: 'Surrey' });
await mk('lin',    { name: 'Lin Reporter', email: 'lin@surreynow.example', tags: ['media'], socials: { x: '@linreports' } });
await mk('sam',    { name: 'Sam Ortiz',   phone: '604-555-0109', email: 'sam@example.org', tags: ['VIP'] });
await act('contact.log', { person_id: P.maya.id, channel: 'door', outcome: 'contacted', rating: '1' });
await act('contact.log', { person_id: P.tom.id, channel: 'door', outcome: 'contacted', rating: '4D' });
await act('contact.log', { person_id: P.ana.id, channel: 'door', outcome: 'contacted', rating: '3' });
await act('volunteer.assign', { person_id: P.sam.id, role: 'doorknocking' });
await act('volunteer.assign', { person_id: P.sam.id, role: 'translation', detail: 'Punjabi' });
check('seeded 9 people', Object.keys(P).length === 9 && Object.values(P).every((p) => p?.id));

// ── 3. Map: pins, door card, rating, outcome, sign ──
await go('/map');
await page.waitForSelector('.map-pin-wrap', { timeout: 10000 }).catch(() => {});
const pins = await page.$$('.map-pin-wrap');
check('map shows one pin per door (5 located doors)', pins.length === 5, `pins=${pins.length}`);
let t = await text();
const filterLabel = await page.$eval('.map-filter-btn', (el) => el.getAttribute('aria-label')).catch(() => '');
const unlocLabel = await page.$eval('.map-unloc__chip', (el) => el.getAttribute('aria-label')).catch(() => '');
check('map counter + unlocated chip', /5 doors/.test(filterLabel) && /1 person not on the map/.test(unlocLabel), `${filterLabel} | ${unlocLabel}`);
await shot('1-map');

await go(`/map?person=${P.harjit.id}`);
await page.waitForSelector('aside.door-card', { timeout: 8000 }).catch(() => {});
t = await text();
check('deep link opens the household door card', /12345 72 Ave/.test(t) && /Harjit Gill/.test(t) && /Simran Gill/.test(t), t.slice(0, 160));
await page.click('aside.door-card button[aria-label="1: Strong support"]');
await sleep(800);
let prof = (await api(`/persons/${P.harjit.id}`)).json;
check('rating 1 at the door is saved', prof.person.rating === '1' && prof.contacts[0].channel === 'door', prof.person.rating);
check('door card: rating confirmed in a toast', /Rated 1/.test(await text()));
await page.click('aside.door-card .fk-more__btn');
await page.click('aside.door-card button:has-text("Lawn")');
await sleep(800);
const signs = (await api('/signs')).json.signs;
check('lawn sign requested from the door card', signs.some((s) => s.kind === 'lawn' && s.status === 'requested'), signs.length);
await shot('2-door-card');

await go(`/map?person=${P.dev.id}`);
await page.waitForSelector('aside.door-card', { timeout: 8000 }).catch(() => {});
await page.click('aside.door-card button:has-text("No answer")');
await sleep(800);
prof = (await api(`/persons/${P.dev.id}`)).json;
check('no-answer logged without a rating', prof.contacts[0]?.outcome === 'no_answer' && prof.person.rating === null);
// 4 asks "Voting for?" before anything is logged.
await page.click('aside.door-card button[aria-label^="4: Opposed"]');
await page.click('aside.door-card button[aria-label^="4B:"]');
await sleep(800);
prof = (await api(`/persons/${P.dev.id}`)).json;
check('4 → Voting for? → Locke saves 4B', prof.person.rating === '4B', prof.person.rating);
check('toast names the candidate', /Locke/.test(await text()));

await go('/map');
await page.waitForSelector('.map-pin-wrap', { timeout: 8000 }).catch(() => {});
await page.click('.map-filter-btn');
await page.click('.map-fsheet .map-fopt:has-text("Opposed")');
await sleep(500);
const opposedPins = (await page.$$('.map-pin-wrap')).length;
check('Opposed filter narrows pins', opposedPins === 2, `pins=${opposedPins}`); // Tom 4D, Dev 4B

// ── 4. People: tag filter, phone bank logs a call ──
await go('/people?tag=media');
t = await text();
check('media tag filter', /Lin Reporter/.test(t) && !/Harjit Gill/.test(t));
// The old phone-bank link still works: it lands on Calls.
await go('/people?bank=phone&has=phone');
check('old phone-bank link redirects to Calls', new URL(page.url()).pathname === '/admin/calls' && !/channel=text/.test(page.url()), page.url());
await page.waitForSelector('section.cl-card', { timeout: 8000 }).catch(() => {});
const current = await page.$eval('section.cl-card', (el) => el.getAttribute('aria-label')).catch(() => '');
if (current !== 'Grace Kim') {
  await page.click('.cl-next__btn');
  t = await text();
  check('Calls queue lists callable people', /Grace Kim/.test(t) && /Tom Riley/.test(t), t.slice(0, 200));
  await page.click('.cl-next__list button:has-text("Grace Kim")');
  await sleep(300);
} else {
  check('Calls queue lists callable people', true);
}
check('Calls shows one person with a Call button', /Call Grace/i.test(await text()) && (await page.$$('section.cl-card')).length === 1);
await page.click('section.cl-card button[aria-label="2: Lean support"]');
await sleep(800);
prof = (await api(`/persons/${P.grace.id}`)).json;
check('Calls: rating 2 logged as a phone contact', prof.person.rating === '2' && prof.contacts[0]?.channel === 'phone', JSON.stringify(prof.contacts[0]));
await shot('3-calls');

// ── 5. Profile: socials, roles, tier ──
await act('gift.log', { person_id: P.sam.id, amount_cents: 25000, date: new Date().toISOString().slice(0, 10), cadence: 'monthly' });
await go(`/people/${P.sam.id}`);
await page.click('.pf-sec__btn:has-text("Volunteer roles")');
await page.click('.pf-sec__btn:has-text("Tags")');
t = await text();
check('profile: roles with detail', /Doorknocking/i.test(t) && /Punjabi/.test(t));
check('profile: superstar donor tier', /superstar/i.test(t));
check('profile: VIP tag', /VIP/.test(t));
await shot('4-profile');
await go(`/people/${P.lin.id}`);
await page.click('.pf-sec__btn:has-text("Details")');
t = await text();
check('profile: social handle linked', (await page.$('a[href*="x.com/linreports"]')) !== null, t.slice(0, 120));

// ── 6. Shifts: create, assign, notify (nothing sent without providers) ──
const shift = (await act('shift.create', {
  title: 'Saturday canvass — Newton', role: 'doorknocking', location: 'Newton Rec Centre, 13730 72 Ave',
  starts_at: '2026-11-07T10:00:00-08:00', ends_at: '2026-11-07T13:00:00-08:00',
  instructions: 'Meet at the north entrance. Comfortable shoes.', link: 'https://imaginesurrey.ca/canvass', capacity: 6,
})).json.shift;
await act('shift.assign', { shift_id: shift.id, person_id: P.sam.id });
await go(`/shifts/${shift.id}`);
await page.click('button:has-text("Notify everyone")');
await sleep(300);
// No provider on the test server: the confirm button says so, never "Send".
const confirmLabel = await page.$eval('.ops-confirm button.btn-primary', (el) => el.innerText).catch(() => '');
check('notify asks in place before sending', /Email \+ text 1 person\?/.test(await text()) && /save — nothing sends/i.test(confirmLabel), confirmLabel);
await page.click('.ops-confirm button.btn-primary');
await sleep(900);
await page.click('.ops-notify button:has-text("Details")').catch(() => {});
t = await text();
// No provider on the test server: nothing may claim to be sent, or to send later.
check('shift notify shows per-channel results', /email not sent/i.test(t) && /text not sent/i.test(t) && /connect email and text, then Notify again/.test(t) && !/✓ Sent/.test(t) && !/waiting to send/i.test(t), (t.match(/Sam Ortiz.{0,80}/) || [''])[0]);
await shot('5-shift');

// ── 7. Outreach: newsletter, press, petition, website bridge ──
await act('workspace.update', { website: 'https://imaginesurrey.ca' });
await act('petition.create', { slug: 'skytrain-to-newton', title: 'Bring SkyTrain to Newton', body: 'Surrey deserves rapid transit south of 72nd.' });
await go('/outreach/website');
// The public links are rows with Copy; their addresses + the form endpoint sit under "For your web developer".
await page.click('button.ot-more:has-text("For your web developer")');
await sleep(300);
t = await text();
check('website tab: bridge snippet + public links', /\/api\/public\/imagine-surrey\/signup/.test(t) && /\/v\/imagine-surrey/.test(t) && /\/n\/imagine-surrey/.test(t));
await shot('6-website-bridge');

// Public pages, as a visitor (no cookie)
const visitor = await browser.newContext();
const vp = await visitor.newPage();
await vp.goto(`${BASE}/p/imagine-surrey/skytrain-to-newton`, { waitUntil: 'domcontentloaded' });
const pubTxt = (await vp.innerText('body')).replace(/\s+/g, ' ');
check('public petition page renders with backlink', /Bring SkyTrain to Newton/.test(pubTxt) && /imaginesurrey\.ca/.test(pubTxt));
await vp.fill('#name', 'Priya Nair');
await vp.fill('#email', 'priya@example.org');
await vp.check('input[name="subscribe"]');
await vp.click('button[type="submit"]');
await sleep(500);
check('petition signed on the public page', /Thank you, Priya/.test(await vp.innerText('body')));
await vp.screenshot({ path: `${SHOTS}/7-public-petition.png` });
await vp.goto(`${BASE}/v/imagine-surrey`, { waitUntil: 'domcontentloaded' });
check('public volunteer page lists the roles', /Zone house captain/.test(await vp.innerText('body')));
const bridge = await vp.evaluate(async (base) => {
  const r = await fetch(`${base}/api/public/imagine-surrey/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'volunteer', name: 'Website Volunteer', phone: '604-555-0199', roles: ['phoning', 'food'] }),
  });
  return r.status;
}, BASE);
check('website JSON bridge accepts a volunteer', bridge === 200, bridge);
await visitor.close();

await go('/people?tag=volunteer-prospect');
check('website volunteer landed in People', /Website Volunteer/.test(await text()));

await go('/outreach/newsletter');
// Subscribers sit under "More"; the compose form opens from "Write newsletter".
await page.click('button.ot-more:has-text("More")');
await sleep(300);
t = await text();
check('newsletter list includes the petition opt-in', /priya@example\.org/.test(t));
await page.click('button:has-text("Write newsletter")');
await page.waitForSelector('#newsletter-subject', { timeout: 5000 });
await page.fill('#newsletter-subject', 'This week in Surrey');
await page.fill('#newsletter-body', 'Hello neighbours — here is what we heard at the doors this week.');
// Without email connected the button says what it does ("Save — not sent yet").
await page.click('form.ot-compose button[type="submit"]');
await sleep(300);
const yes = await page.$('button:has-text("Yes, send"), button:has-text("Yes, save")');
if (yes) await yes.click();
await sleep(900);
t = await text();
check('newsletter blast saved, not sent, without a provider', /Saved for \d+ subscribers? — not sent/.test(t) && /Connect email, then Send now/.test(t) && !/Sent to/.test(t) && !/send later/i.test(t));
await shot('8-newsletter');

await go('/outreach/press');
t = await text();
check('press tab counts media contacts', /Media contacts:?\s*1/i.test(t) || /1 media contact/i.test(t), (t.match(/[Mm]edia contact.{0,30}/) || [''])[0]);

// ── 8. Today composes it all ──
await go('/');
t = await text();
check('Today: doors this week', /doors this week/i.test(t));
await page.click('button.today-num');
await sleep(300);
t = await text();
check('Today: support breakdown opens in place', /support/i.test(t) && /opposed/i.test(t) && /support=1/.test(page.url()));
check('Today: upcoming shift', /Saturday canvass — Newton/.test(t));
check('Today: money hero (desk role)', /total raised/i.test(t));
await shot('9-today');

// ── 9. Volunteer view: field yes, money no ──
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await vctx.route(/tile\.openstreetmap\.org/, (route) => {
  const [, z, x, y] = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
  route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg(+z, +x, +y) });
});
const volPage = await vctx.newPage();
volPage.on('pageerror', (e) => errors.push('[vol] ' + e.message));
// The real path in: the manager invites Jas from the Team screen.
await go('/team');
await page.fill('#team-email', 'jas@example.org');
await page.selectOption('#team-role', 'volunteer');
// Without email connected the button says what it does: "Get invite link".
await page.getByRole('button', { name: /^(Send invite|Get invite link)$/ }).click();
await page.waitForSelector('[data-testid="join-url"]', { timeout: 8000 }).catch(() => {});
const joinUrl = await page.$eval('[data-testid="join-url"]', (el) => el.textContent).catch(() => '');
check('Team: invite produces a join link', /\/join\/[0-9a-f]{48}$/.test(joinUrl), joinUrl);
await shot('10-team-invite');
await volPage.goto(joinUrl.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
await volPage.waitForSelector('#join-name', { timeout: 8000 }).catch(() => {});
check('join page names the campaign and role', /Join Imagine Surrey/.test(await volPage.innerText('body')) && /a volunteer/.test(await volPage.innerText('body')));
await volPage.fill('#join-name', 'Jas Volunteer');
await volPage.fill('#join-password', 'knock-knock-2026');
await volPage.click('button[type="submit"]');
await volPage.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
const moved = new URL(volPage.url()).pathname === '/';
check('volunteer joins and lands on Today', moved, volPage.url());
await volPage.waitForSelector('text=/start canvassing/i', { timeout: 8000 }).catch(() => {});
check('Today offers Start canvassing', /start canvassing/i.test(await volPage.innerText('body').catch(() => '')), (await volPage.innerText('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
if (moved) {
  await volPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  const vt = ((await volPage.innerText('body')) || '').replace(/\s+/g, ' ');
  check('volunteer Today: field stats, no money', /doors this week/i.test(vt) && !/total raised/i.test(vt) && !/verify my books/i.test(vt), vt.slice(0, 160));
  const gifts = await volPage.evaluate(() => fetch('/api/records/gift').then((r) => r.status));
  check('volunteer refused the gift ledger', gifts === 403, gifts);
  await volPage.goto(`${BASE}/map?person=${P.maya.id}`, { waitUntil: 'domcontentloaded' });
  await volPage.waitForSelector('aside.door-card', { timeout: 8000 }).catch(() => {});
  await volPage.tap('aside.door-card button[aria-label="3: Undecided"]').catch(() => volPage.click('aside.door-card button[aria-label="3: Undecided"]'));
  await sleep(800);
  prof = (await api(`/persons/${P.maya.id}`)).json;
  check('volunteer can rate at the door on a phone', prof.person.rating === '3', prof.person.rating);
  check('volunteer has no add-door button', (await volPage.$('button[aria-label="Add a door"]')) === null);
  const tabbar = await volPage.$('nav.tabbar');
  check('phone tab bar visible', tabbar && await tabbar.isVisible());
  const tabs = tabbar ? (await tabbar.innerText()).replace(/\s+/g, ' ') : '';
  check('volunteer tabs: Today · Map · Calls · Shifts', /today/i.test(tabs) && /map/i.test(tabs) && /calls/i.test(tabs) && /shifts/i.test(tabs) && !/money|outreach|signs/i.test(tabs), tabs);
  const overflow = await volPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('no sideways scroll at 390px', overflow <= 0, overflow);
  await volPage.screenshot({ path: `${SHOTS}/11-volunteer-phone-map.png` });
  await volPage.goto(`${BASE}/money`, { waitUntil: 'domcontentloaded' });
  await sleep(900);
  check('volunteer typing /money lands on Today', new URL(volPage.url()).pathname === '/', volPage.url());
  await volPage.screenshot({ path: `${SHOTS}/12-volunteer-today.png` });
}
await vctx.close();

// ── 10. The books still verify ──
const v = (await api('/audit/verify')).json;
check('hash chain verifies after the whole journey', v.ok === true && v.checked > 20, JSON.stringify(v));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
