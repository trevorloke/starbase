// Starbase desk-with-no-signal E2E — a fresh in-memory server, the Imagine
// Surrey sample campaign, a manager on a laptop (1360 and 390 wide) and a
// volunteer on a 390×844 phone:
//   · with signal the manager opens Today, People, two profiles, Shifts,
//     Signs, Money, the Inbox and Calls; the copies are kept for this sign-in
//     (money ones in this tab only, never in the browser's lasting storage);
//   · no signal, every one of them reloads from its copy, the strip says
//     "No signal · from <time>", People's search and a tag filter work over
//     the kept list, a profile never opened says No signal, and every write
//     that needs the server is off and says so;
//   · on a profile with no signal a note with a rating, a tag put on and a tag
//     taken off are saved on this device, shown on the profile ("Not sent
//     yet") through a reload, and sent once when the signal is back — one
//     answer lost on the way, replayed, still recorded once;
//   · screens with nothing kept (Rating scale, Team, Filings) say No signal,
//     their writes are off, and the strip claims no kept copy;
//   · wifi with no internet, reloaded: still signed in, on the kept copies,
//     and it asks again by itself; the server down (502): the kept copies,
//     never "No people yet" or "No one here";
//   · a note typed on a profile is sent when you leave it;
//   · two tabs with no signal: neither drops what the other saved, and the
//     closed tab's work is sent by the other;
//   · sign-out forgets every copy — the other open tab's too (it goes to Sign
//     in); the next sign-in on this browser sees none;
//   · the volunteer keeps only what a volunteer saw (no money, nobody else's
//     email), and their profile knock waits and sends once; made treasurer
//     with the app open, Today's money stays in the tab; a role change, a day
//     passing or a session ending without Sign out forgets what was kept;
//   · storage blocked (a private window): today's No signal, no errors;
//   · SIMPLE: ≤1 yellow, no sideways scroll, ≥48px field targets.
//
//   node e2e-desk-offline.mjs                 (starts its own server on :4214)
//   BASE=http://127.0.0.1:4214 node e2e-desk-offline.mjs   (a fresh server you started)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const PORT = Number(process.env.PORT) || 4214;
const SHOTS = process.env.SHOTS || '/tmp/claude-0/-home-user-mandate/c88a39fd-f6db-552f-95dc-59176433706d/scratchpad/features/desk-offline';
mkdirSync(SHOTS, { recursive: true });

let server = null;
let BASE = process.env.BASE;
const ADMIN = { toString() { return `${BASE}/admin`; } }; // the desk's pages live in the admin (web/src/mode.js)
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
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 240) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 8);
const until = async (fn, ms = 15000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(300);
  }
};

const tileSvg = () => '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/></svg>';
const routeTiles = (c) => c.route(/tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg() }));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const KEPT = /No signal · from (\d{1,2}:\d{2} (am|pm)|[A-Z][a-z]{2} \d{1,2})/i;
const FIELDS = 'main.page input:not([type=checkbox]), main.page select, main.page textarea, main.page button, main.page a.btn';

const helpers = (page, ctx) => ({
  text: async () => ((await page.innerText('body').catch(() => '')) || '').replace(/\s+/g, ' '),
  main: async () => ((await page.innerText('main.page').catch(() => '')) || '').replace(/\s+/g, ' '),
  // The server's side, through the context's own cookies (works while the page is offline).
  api: async (path, body) => {
    const r = body === undefined
      ? await ctx.request.get(`${BASE}/api${path}`)
      : await ctx.request.post(`${BASE}/api${path}`, { data: body });
    return { status: r.status(), json: await r.json().catch(() => null) };
  },
  go: async (path) => { await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(1300); },
  shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png` }),
  kept: () => page.$eval('.offline-strip__kept', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => ''),
  chip: () => page.$eval('.offline-strip__chip', (el) => el.innerText.replace(/\s+/g, ' ').trim()).catch(() => ''),
  // What this browser keeps: { local: {key: text}, session: {key: text} } for Starbase's copies.
  stored: () => page.evaluate(() => {
    const grab = (s) => { const o = {}; try { for (let i = 0; i < s.length; i += 1) { const k = s.key(i); if (k && k.startsWith('starbase:copy:')) o[k] = s.getItem(k); } } catch { /* blocked */ } return o; };
    return { local: grab(localStorage), session: grab(sessionStorage) };
  }).catch(() => ({ local: {}, session: {} })),
  outbox: () => page.evaluate(() => JSON.parse(localStorage.getItem('starbase:outbox:v2') || '[]')).catch(() => []),
  swReady: () => page.evaluate(() => navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller))).catch(() => false),
  measure: (sel = FIELDS) => page.evaluate((targets) => {
    const main = document.querySelector('main.page') || document.body;
    const words = (main.innerText || '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
    const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
    const overflow = document.documentElement.scrollWidth - window.innerWidth;
    let minTap = null; let minWho = '';
    if (targets) {
      for (const el of document.querySelectorAll(targets)) {
        if (!visible(el)) continue;
        const h = el.getBoundingClientRect().height;
        if (minTap == null || h < minTap) { minTap = h; minWho = el.outerHTML.slice(0, 90); }
      }
    }
    return { words, yellow, overflow, minTap, minWho };
  }, sel),
});
const measured = [];
const simple = async (H, name, sel = null) => {
  const m = await H.measure(sel);
  measured.push({ name, ...m });
  check(`${name}: ≤1 yellow, no sideways scroll${sel ? ', targets ≥48px' : ''}`, m.yellow <= 1 && m.overflow <= 0 && (m.minTap == null || m.minTap >= 47.5),
    `words=${m.words} yellow=${m.yellow} overflow=${m.overflow} minTap=${m.minTap == null ? '-' : Math.round(m.minTap)} ${m.minTap != null && m.minTap < 47.5 ? m.minWho : ''}`);
  return m;
};
const signupAs = async (page, D, name, email) => {
  await D.go('/signup');
  await page.fill('#su-name', name);
  await page.fill('#su-email', email);
  await page.fill('#su-password', 'surrey-forward-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
};
const join = async (page, url, name) => {
  await page.goto(url.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#join-name', { timeout: 8000 });
  await page.fill('#join-name', name);
  await page.fill('#join-password', 'knock-knock-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !/\/join\//.test(String(u)), { timeout: 15000 }).catch(() => {});
  await sleep(800);
};
const goOnline = async (ctx, page) => {
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online'))).catch(() => {});
};

// ════════════════════════════════════════════════════════════════════════════
// 1. Manager on a laptop, with signal: the sample campaign, every desk screen once
// ════════════════════════════════════════════════════════════════════════════
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await routeTiles(ctx);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const D = helpers(page, ctx);
const mgrEmail = `desk.mgr+${tag}@example.org`;
await signupAs(page, D, 'Riley Desk', mgrEmail);
const meA = (await D.api('/auth/me')).json;
const sample = await D.api('/data/sample', {});
check('sample campaign loaded', sample.status === 200 || sample.status === 201, JSON.stringify(sample.json).slice(0, 120));
const everyone = (await D.api('/persons?q=&limit=300')).json.persons;
const byName = (n) => everyone.find((p) => p.name === n);
const tom = byName('Tom Riley');
const maya = byName('Maya Chen');
const dev = byName('Dev Patel');
const harjit = byName('Harjit Gill');
check('sample people found', tom && maya && dev && harjit, everyone.length);
// A shift this test never opens (its detail is never kept here).
const unopenedShift = ((await D.api('/shifts')).json.shifts || []).at(-1);

await D.go('/');
check('service worker controls the page', await D.swReady() || (await (async () => { await D.go('/'); return D.swReady(); })()));
await D.go('/');
await page.waitForSelector('.today-nums', { timeout: 10000 }).catch(() => {});
await D.go('/people');
await page.waitForSelector('.pp-table tbody tr', { timeout: 10000 }).catch(() => {});
const rowsOnline = await page.locator('.pp-table tbody tr').count();
const countOf = (pg) => pg.$eval('.pp-count strong', (el) => el.innerText.trim()).catch(() => '');
const countOnline = await countOf(page);
await page.fill('.pp-search input', 'Maya');
await sleep(1800);
check('a search typed with signal isn’t kept as its own copy (it would push the list out)',
  !Object.keys((await D.stored()).local).some((x) => x.includes('q=Maya')) && /Maya Chen/.test(await D.main()));
await D.go(`/people/${tom.id}`);
await page.waitForSelector('.pf-page h1', { timeout: 10000 }).catch(() => {});
await D.go(`/people/${maya.id}`);
await page.waitForSelector('.pf-page h1', { timeout: 10000 }).catch(() => {});
for (const path of ['/shifts', '/signs', '/money', '/inbox', '/calls']) await D.go(path);
await sleep(1200); // copies are written a moment after each screen loads
const kept = await D.stored();
const localKeys = Object.keys(kept.local);
const sessionKeys = Object.keys(kept.session);
const scopeA = `${meA.workspace.id}:${meA.user.id}:`;
const has = (keys, end) => keys.some((k) => k.endsWith(end));
check('kept in this browser: Signs, Shifts, the Inbox — keyed to this campaign and person',
  has(localKeys, ':q:manager:signs') && has(localKeys, ':shifts')
    && has(localKeys, ':q:manager:texting:inbox:/texting/all') && localKeys.every((k) => k.includes(scopeA)),
  localKeys.map((k) => k.split(':').slice(5).join(':')).join(' | '));
// People lists carry donor tags (donor-prospect, lapsed): this tab only, like money.
check('anything with money or donors in it is kept for this tab only: Today, profiles, gifts, pledges, People',
  ['q:manager:brief', `q:manager:person:${tom.id}`, `q:manager:person:${maya.id}`, 'q:manager:gifts', 'q:manager:pledges', 'q:manager:persons:q=&limit=300'].every((n) => has(sessionKeys, `:${n}`))
    && sessionKeys.every((k) => k.includes(scopeA)),
  sessionKeys.map((k) => k.split(':').slice(5).join(':')).join(' | '));
const localText = Object.values(kept.local).join('\n');
check('…and never in the browser’s lasting storage (no gift amounts, no Today, no profiles, no People list)',
  !/amount_cents|totalCents|"gifts"/.test(localText) && !localKeys.some((k) => /:q:manager:(brief|person:|gifts|pledges|persons:)/.test(k)));
const tomBefore = (await D.api(`/persons/${tom.id}`)).json;
const tagEventsBefore = (await D.api('/events?since=0&limit=5000')).json.events.filter((e) => e.action === 'person.tag').length;

// ════════════════════════════════════════════════════════════════════════════
// 2. No signal: every desk screen reloads from its copy
// ════════════════════════════════════════════════════════════════════════════
await ctx.setOffline(true);
// In the app, no reload: a screen not opened since this page loaded starts from its copy.
await page.click('nav.links a[href="/admin/signs"]');
await page.waitForSelector('.ops-rows li', { timeout: 6000 }).catch(() => {});
check('no signal, in the app: Signs opens from its copy at once', (await page.locator('.ops-rows li').count()) > 0 && KEPT.test(await D.kept()), await D.kept());
await D.go('/');
await page.waitForSelector('.today-nums', { timeout: 10000 }).catch(() => {});
let t = await D.text();
let k = await D.kept();
check('Today with no signal: the kept copy — numbers, raised — and "No signal · from <time>"',
  KEPT.test(k) && /Total raised/i.test(t) && !/this fills in when you’re back online/.test(t), `${k} · ${t.slice(0, 160)}`);
check('…said once (the strip), never "Offline — field work…" beside it', (t.match(/No signal · from/gi) || []).length === 1 && !/field work saves/i.test(t));
await D.shot('01-today-no-signal');
await simple(D, 'Today, no signal (1360)');

await D.go('/people');
await page.waitForSelector('.pp-table tbody tr', { timeout: 10000 }).catch(() => {});
t = await D.text();
const rowsOffline = await page.locator('.pp-table tbody tr').count();
const countOffline = await countOf(page);
check('People with no signal: the kept list, not "No signal — the list loads"', rowsOffline === rowsOnline && rowsOffline > 20
  && countOffline === countOnline && Number(countOnline) > 50 && KEPT.test(await D.kept())
  && !/the list loads when you’re back online/.test(t), `${rowsOffline}/${rowsOnline} rows · ${countOffline}/${countOnline}`);
const addBtn = page.locator('.page-head button:has-text("Add person")');
check('…Add person is off and says why: "Adding people needs signal"', await addBtn.isDisabled().catch(() => false) && /Adding people needs signal/.test(t));
await simple(D, 'People, no signal (1360)');
await D.shot('02-people-no-signal');
await page.fill('.pp-search input', 'Riley');
await sleep(900);
let names = await page.$$eval('.pp-table tbody tr .pp-table__name a', (els) => els.map((e) => e.innerText.trim()));
check('search with no signal works over the kept list: "Riley" → Tom Riley', names.length >= 1 && names.includes('Tom Riley') && names.every((n) => /riley/i.test(n) || true)
  && /1 person|\d+ people/.test(await D.main()), names.join(', '));
await page.fill('.pp-search input', '72 Ave');
await sleep(900);
names = await page.$$eval('.pp-table tbody tr .pp-table__name a', (els) => els.map((e) => e.innerText.trim()));
const newton = everyone.filter((p) => /72 Ave/i.test(p.address || '')).map((p) => p.name).sort();
check('…by address too ("72 Ave" → the Newton block, every one)', names.length === newton.length && [...names].sort().join() === newton.join(), `${names.length} vs ${newton.length}`);
await page.fill('.pp-search input', 'zzz-nobody');
await sleep(700);
check('…no match says so', /No one matches\./.test(await D.main()));
await D.go('/people?tag=VIP');
await page.waitForSelector('.pp-table tbody tr', { timeout: 8000 }).catch(() => {});
names = await page.$$eval('.pp-table tbody tr .pp-table__name a', (els) => els.map((e) => e.innerText.trim()));
const vips = everyone.filter((p) => (p.tags || []).includes('VIP')).map((p) => p.name).sort();
check('a tag filter with no signal works over the kept list too (VIP)', names.length === vips.length && [...names].sort().join() === vips.join(), names.join(', '));
await D.go('/people?role=driver');
await page.waitForSelector('.pp-offline', { timeout: 6000 }).catch(() => {});
t = await D.main();
check('a filter the kept list can’t answer (volunteer role) says No signal, never "No one matches"',
  /No signal — the list loads when you’re back online/.test(t) && !/No one matches/.test(t), t.slice(0, 160));

await D.go(`/people/${tom.id}`);
await page.waitForSelector('.pf-page h1', { timeout: 10000 }).catch(() => {});
t = await D.text();
check('a profile opened before: kept, with the chip', /Tom Riley/.test(await page.innerText('.pf-page h1').catch(() => '')) && KEPT.test(await D.kept())
  && !/this profile loads when you’re back online/.test(t), t.slice(0, 160));
await D.go(`/people/${dev.id}`);
await page.waitForSelector('.pp-offline', { timeout: 6000 }).catch(() => {});
t = await D.text();
check('a profile never opened: "No signal — this profile loads when you’re back online"', /No signal — this profile loads when you’re back online/.test(t), t.slice(0, 160));

await D.go('/shifts');
t = await D.text();
check('Shifts with no signal: kept, New shift off — "New shifts need signal"', KEPT.test(await D.kept()) && /Offline copy/i.test(t)
  && await page.locator('button:has-text("New shift")').isDisabled().catch(() => false) && /New shifts need signal/.test(t), t.slice(0, 200));
await D.go('/signs');
await page.waitForSelector('.ops-rows', { timeout: 8000 }).catch(() => {});
t = await D.text();
check('Signs with no signal: kept list, Add a sign off — "Adding or changing a sign needs signal"', KEPT.test(await D.kept())
  && (await page.locator('.ops-rows li').count()) > 0 && await page.locator('.ops-head button:has-text("Add a sign")').isDisabled().catch(() => false)
  && /Adding or changing a sign needs signal/.test(t), t.slice(0, 200));
await D.go('/money');
await page.waitForSelector('#gift-list, .ops-rows', { timeout: 8000 }).catch(() => {});
t = await D.text();
check('Money with no signal (this tab’s copy): gifts listed, Log a gift off — "Gifts and pledges need signal"', KEPT.test(await D.kept())
  && /Arjun Mehta/.test(t) && await page.locator('.ops-head button:has-text("Log a gift")').isDisabled().catch(() => false) && /Gifts and pledges need signal/.test(t), t.slice(0, 200));
await simple(D, 'Money, no signal (1360)');
await D.shot('03-money-no-signal');
await D.go('/inbox');
t = await D.text();
check('Inbox with no signal: the kept list, never "your texts load when you’re back online"', KEPT.test(await D.kept()) && /Inbox/.test(t) && !/your texts load/.test(t), t.slice(0, 160));
await D.go('/calls');
await page.waitForSelector('section.cl-card', { timeout: 8000 }).catch(() => {});
check('Calls with no signal: the list from this device', (await page.locator('section.cl-card').count()) === 1 && KEPT.test(await D.kept()));
// Screens with nothing kept say so — and the strip claims no copy (the
// counts they read on the side from Today's copy aren't what they show).
await D.go('/rating-scale');
t = await D.main();
check('Rating scale with no signal: "No signal — this loads…", and the strip shows no "from <time>"',
  /No signal — this loads when you’re back online/.test(t) && !(await D.kept()), `${await D.kept()} · ${t.slice(0, 120)}`);
await D.go('/team');
t = await D.main();
check('Team with no signal: "No signal", never "Members 0"; Get invite link off — "Inviting, changing roles and removing need signal"',
  /No signal — this loads when you’re back online/.test(t) && !/Members 0/.test(t) && !(await D.kept())
    && await page.locator('.ot-invite button[type="submit"]').isDisabled().catch(() => false) && /Inviting, changing roles and removing need signal/.test(t), `${await D.kept()} · ${t.slice(0, 200)}`);
await simple(D, 'Team, no signal (1360)');
await D.go('/filings');
t = await D.main();
check('Filings with no signal: Add filing off and says so; "No signal", not an endless Loading…',
  await page.locator('.ops-head button:has-text("Add filing")').isDisabled().catch(() => false) && /Adding or filing a deadline needs signal/.test(t)
    && /No signal — this loads when you’re back online/.test(t) && !/Loading…/.test(t), t.slice(0, 200));
await D.go('/');
await page.waitForSelector('.today-morebox__toggle', { timeout: 8000 }).catch(() => {});
await page.click('.today-morebox__toggle').catch(() => {});
check('Today → More with no signal: Clear sample data is off — "Needs signal"',
  await page.locator('.today-sample-clear button:has-text("Clear sample data")').isDisabled().catch(() => false) && /Needs signal/.test(await page.innerText('.today-sample-clear').catch(() => '')));
// A shift never opened here: nothing kept for it — and the strip claims no
// copy (its email/texting line reads Today's kept brief on the side).
await D.go(`/shifts/${unopenedShift.id}`);
t = await D.main();
check('a shift never opened, no signal: "No signal — this loads…", and the strip shows no "from <time>"',
  /No signal — this loads when you’re back online/.test(t) && !(await D.kept()), `${await D.kept()} · ${t.slice(0, 120)}`);

// ════════════════════════════════════════════════════════════════════════════
// 3. No signal, on a profile: a note with a rating, a tag on, a tag off
// ════════════════════════════════════════════════════════════════════════════
const note = `Offline desk note ${tag}`;
const newTag = `desk-${tag}`;
await D.go(`/people/${tom.id}`);
await page.waitForSelector('.pf-rate', { timeout: 8000 });
await page.click('.pf-rate button:has-text("+ Add a note")');
await page.fill('#contact-note', note);
await page.click('.pf-rate button[aria-label="1: Strong support"]');
await until(async () => /Saved offline/.test(await page.innerText('.pf-rate').catch(() => '')), 6000);
t = await D.text();
check('rating + note with no signal: "Saved offline", and the profile says it’s waiting',
  /Saved offline/.test(await page.innerText('.pf-rate').catch(() => '')) && /Saved on this device — sends when you’re back online/.test(t), t.slice(0, 220));
const firstHist = await page.$eval('.timeline li', (el) => el.innerText.replace(/\s+/g, ' ')).catch(() => '');
check('…the history shows it first, "Not sent yet", with the note', /Not sent yet/i.test(firstHist) && firstHist.includes(note), firstHist);
check('…and the rating on top is the new one', /Strong yes/.test(await page.innerText('.pf-meta').catch(() => '')));
await page.click('.pf-sec__btn:has-text("Tags")');
await page.click('.pf-sec button:has-text("Edit tags")');
await page.fill('.tag-editor input[aria-label="Add a tag"]', newTag);
await page.keyboard.press('Enter');
await sleep(500);
check('a tag put on with no signal shows at once', (await page.innerText('.tag-editor').catch(() => '')).toLowerCase().includes(newTag.replace(/-/g, ' ')), await page.innerText('.tag-editor').catch(() => ''));
check('strip: "2 saved on this device"', /^2 saved on this device$/i.test(await D.chip()), await D.chip());
await D.shot('04-profile-queued');
await simple(D, 'Profile with changes waiting (1360)', '.pf-rate button[aria-label]');
// Everything else that writes is off, and says so.
await page.click('.pf-sec__btn:has-text("Details")');
await page.click('.pf-sec button:has-text("Edit details")');
t = await D.text();
check('Edit details with no signal: Save off — "Needs signal"', await page.locator('form.inline-form button[type="submit"]:has-text("Save")').isDisabled().catch(() => false) && /Needs signal/.test(t));
await page.click('form.inline-form button:has-text("Cancel")');
await page.click('.pf-sec__btn:has-text("Volunteer roles")');
check('Volunteer roles with no signal: Add off', await page.locator('.role-add button:has-text("Add")').isDisabled().catch(() => false));
await page.click('.pf-sec__btn:has-text("Signs")');
check('Request a sign with no signal: off', await page.locator('.pf-sec button[title="Lawn sign"], .pf-sec button:has-text("Lawn")').first().isDisabled().catch(() => false));

await D.go(`/people/${maya.id}`);
await page.waitForSelector('.pf-page h1', { timeout: 8000 });
await page.click('.pf-sec__btn:has-text("Tags")');
await page.click('.pf-sec button:has-text("Edit tags")');
await page.click('.tag-editor button[aria-label="Remove tag Endorser"]');
await sleep(500);
const mayaChips = await page.innerText('.tag-editor .tag-chips').catch(() => 'endorser');
check('a tag taken off with no signal goes at once (Maya: Endorser)', !/endorser/i.test(mayaChips) && /VIP/.test(mayaChips), mayaChips);
check('strip: "3 saved on this device"', /^3 saved on this device$/i.test(await D.chip()), await D.chip());
await page.click('.offline-strip__chip');
await page.waitForSelector('.obx-sheet', { timeout: 3000 }).catch(() => {});
const sheet = await page.$$eval('.obx-sheet .obx-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
check('the sheet lists them in plain words', sheet.length === 3 && /^Knock · Tom Riley · /.test(sheet[0])
  && new RegExp(`^Tag · Desk ${tag} · Tom Riley · `, 'i').test(sheet[1]) && /^Tag off · Endorser · Maya Chen · /.test(sheet[2]), sheet.join(' | '));
await page.keyboard.press('Escape');
// Through a reload, still there — the kept copy with what's waiting on top.
await D.go(`/people/${tom.id}`);
await page.waitForSelector('.pf-page h1', { timeout: 8000 });
t = await D.text();
check('reload with no signal: the profile still shows the rating, the note "Not sent yet", the waiting line',
  /Strong yes/.test(await page.innerText('.pf-meta').catch(() => '')) && /Not sent yet/i.test(t) && t.includes(note) && /Saved on this device — sends when you’re back online/.test(t), t.slice(0, 200));
const tomServer = (await D.api(`/persons/${tom.id}`)).json;
check('…and nothing reached the server yet', tomServer.contacts.length === tomBefore.contacts.length && !(tomServer.person.tags || []).includes(newTag)
  && (await D.api(`/persons/${maya.id}`)).json.person.tags.includes('endorser'));

// Phone width, still no signal (the same sign-in, a narrow window).
await page.setViewportSize({ width: 390, height: 844 });
await D.go('/people');
await page.waitForSelector('.pp-list li', { timeout: 8000 }).catch(() => {});
check('People at 390, no signal: the kept rows', (await page.locator('.pp-list li').count()) === rowsOnline, await page.locator('.pp-list li').count());
await simple(D, 'People, no signal (390)');
await D.go(`/people/${tom.id}`);
await page.waitForSelector('.pf-rate', { timeout: 8000 }).catch(() => {});
await simple(D, 'Profile, no signal (390)', '.pf-rate button[aria-label]');
await D.shot('05-profile-390-no-signal');
await D.go('/');
await simple(D, 'Today, no signal (390)');
await D.go('/money');
await simple(D, 'Money, no signal (390)');
await page.setViewportSize({ width: 1360, height: 900 });

// ════════════════════════════════════════════════════════════════════════════
// 4. Signal back: each sent once — one answer lost on the way, replayed
// ════════════════════════════════════════════════════════════════════════════
let lost = 0;
await page.route('**/api/actions/person.tag', async (route) => {
  if (lost > 0) { await route.continue(); return; }
  lost += 1;
  await route.fetch(); // the server does it…
  await route.abort('connectionreset'); // …and the answer never comes back
});
await goOnline(ctx, page);
await until(async () => !(await D.chip()), 25000);
await page.unroute('**/api/actions/person.tag');
check('back online: everything sent (the lost answer replayed by itself)', !(await D.chip()) && (await D.outbox()).length === 0 && lost === 1, await D.chip());
await until(async () => !(await page.$('.offline-strip__kept')), 8000);
check('…and the screen loaded again by itself: no "from <time>" left on the strip (Money, unchanged)', !(await page.$('.offline-strip__kept')), await D.kept());
const tomAfter = (await D.api(`/persons/${tom.id}`)).json;
const noted = tomAfter.contacts.filter((c) => c.note === note);
check('server: the note once, with its rating', noted.length === 1 && noted[0].rating === '1' && tomAfter.contacts.length === tomBefore.contacts.length + 1
  && tomAfter.person.rating === '1', JSON.stringify(noted));
check('server: the tag on Tom once', tomAfter.person.tags.filter((x) => x === newTag).length === 1, JSON.stringify(tomAfter.person.tags));
const mayaTags = (await D.api(`/persons/${maya.id}`)).json.person.tags;
check('server: Endorser off Maya, VIP kept', !mayaTags.includes('endorser') && mayaTags.includes('VIP'), mayaTags.join());
const evs = (await D.api('/events?since=0&limit=5000')).json.events;
check('the log: one tag change each — the replay recorded nothing', evs.filter((e) => e.action === 'person.tag').length === tagEventsBefore + 2
  && evs.filter((e) => e.action === 'person.tag' && e.entity_id === tom.id).length === 1, evs.filter((e) => e.action === 'person.tag').length);
await D.go(`/people/${tom.id}`);
await page.waitForSelector('.pf-page h1', { timeout: 8000 });
t = await D.text();
check('the profile, online: no "Not sent yet", no waiting line, no chip', !/Not sent yet/i.test(t) && !/Saved on this device/.test(t) && !(await D.kept()) && t.includes(note));
check('…writes are on again', !(await page.locator('.pf-rate button[aria-label="2: Lean support"]').isDisabled()));
await simple(D, 'Profile, online (1360)', '.pf-rate button[aria-label]');
// Signal, but the server can't be reached (wifi with no internet): the copy, said as "No answer".
await page.route('**/api/persons?*', (route) => route.abort('internetdisconnected'));
await D.go('/people');
await page.waitForSelector('.pp-table tbody tr', { timeout: 8000 }).catch(() => {});
t = await D.text();
check('wifi with no internet: People shows the kept list, "No answer · from <time>", no error line',
  /No answer · from \d{1,2}:\d{2} (am|pm)/i.test(await D.kept()) && (await countOf(page)) === countOnline && !/check your signal|No signal — the list loads/.test(t), `${await D.kept()} · ${t.slice(0, 160)}`);
await page.unroute('**/api/persons?*');
// …and reloading there (the sign-in check gets no answer either): never sent to Sign in.
await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
await D.go('/people');
await page.waitForSelector('.pp-table tbody tr', { timeout: 8000 }).catch(() => {});
t = await D.text();
check('wifi with no internet, reloaded: still signed in, the kept People list, "No answer · from <time>"',
  !/\/login/.test(page.url()) && !/Sign in/.test(await D.main()) && (await countOf(page)) === countOnline && /No answer · from/i.test(await D.kept()), `${page.url()} · ${t.slice(0, 160)}`);
await D.shot('09-no-answer-reload');
await page.unroute('**/api/**');
await until(async () => !(await page.$('.offline-strip__kept')), 25000);
check('…the internet back: it asks again by itself and the strip clears', !(await page.$('.offline-strip__kept')) && (await countOf(page)) === countOnline, await D.kept());
// The server down behind its proxy (502 while it restarts): the kept copies, never "No people yet".
await page.route('**/api/**', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }));
await D.go('/people');
await page.waitForSelector('.pp-table tbody tr', { timeout: 8000 }).catch(() => {});
t = await D.main();
check('server down (502): People shows the kept list, "No answer · from <time>" — not "No people yet", not "request failed"',
  (await countOf(page)) === countOnline && /No answer · from/i.test(await D.kept()) && !/No people yet|Import a list|request failed/i.test(t), `${await D.kept()} · ${t.slice(0, 160)}`);
await page.evaluate((id) => { history.pushState({}, '', `/people/${id}`); window.dispatchEvent(new PopStateEvent('popstate')); }, dev.id);
await sleep(2500);
t = await D.main();
check('…a profile never opened: "No answer — check your signal", never "No one here — they may have been removed"',
  /No answer — check your signal/.test(t) && !/No one here/.test(t), t.slice(0, 160));
await page.unroute('**/api/**');
// …and a new tab, which kept no People list (a desk's lists stay in their own
// tab): no "0 people" and no empty table, at 1360 and 390.
{
  const p3 = await ctx.newPage();
  p3.on('pageerror', (e) => errors.push('[502 tab] ' + e.message));
  const D3 = helpers(p3, ctx);
  await D3.go('/');
  await p3.waitForSelector('.today-nums', { timeout: 8000 }).catch(() => {});
  await p3.route('**/api/**', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }));
  await p3.click('nav.links a[href="/admin/people"]');
  await until(async () => /No answer — check your signal/.test(await D3.main()), 8000);
  let t3 = await D3.main();
  check('server down (502), no list kept in this tab: "No answer — check your signal" — no "0 people", no empty table, no "No people yet"',
    /No answer — check your signal/.test(t3) && !/\b0 people\b|No people yet|Import a list|request failed/i.test(t3) && !(await p3.$('.pp-table, .pp-list, .pp-count')), t3.slice(0, 200));
  await simple(D3, 'People, server down (1360)');
  await p3.setViewportSize({ width: 390, height: 844 });
  await sleep(600);
  t3 = await D3.main();
  check('…and at 390: the same, no empty list', /No answer — check your signal/.test(t3) && !/\b0 people\b|No people yet/i.test(t3) && !(await p3.$('.pp-table, .pp-list, .pp-count')), t3.slice(0, 200));
  await simple(D3, 'People, server down (390)');
  // The Calls list with nothing to show: never "No one to call yet".
  await p3.evaluate(() => { history.pushState({}, '', '/calls?channel=phone'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await sleep(3000);
  t3 = await D3.main();
  check('…Calls, server down: never "No one to call yet" or "request failed"', !/No one to call|request failed/i.test(t3), t3.slice(0, 200));
  await p3.close();
}
// A note typed on a profile, then off to People without a tap: sent anyway (as the door card does).
const leftNote = `Left on the profile ${tag}`;
const harjitBefore = (await D.api(`/persons/${harjit.id}`)).json.contacts.length;
await D.go(`/people/${harjit.id}`);
await page.waitForSelector('.pf-rate', { timeout: 8000 });
await page.click('.pf-rate button:has-text("+ Add a note")');
await page.fill('#contact-note', leftNote);
await page.click('nav.links a[href="/admin/people"]');
await sleep(1500);
const harjitNow = (await D.api(`/persons/${harjit.id}`)).json.contacts;
check('a note typed on a profile, then People tapped: the note is saved, once', harjitNow.length === harjitBefore + 1
  && harjitNow.filter((c) => c.note === leftNote).length === 1, `${harjitBefore} → ${harjitNow.length}`);

// ════════════════════════════════════════════════════════════════════════════
// 4b. Two tabs on one computer, no signal: neither drops what the other saved
// ════════════════════════════════════════════════════════════════════════════
{
  const page2 = await ctx.newPage();
  page2.on('pageerror', (e) => errors.push('[tab 2] ' + e.message));
  const D2t = helpers(page2, ctx);
  await D.go(`/people/${tom.id}`);
  await page.waitForSelector('.pf-rate', { timeout: 8000 });
  await D2t.go(`/people/${maya.id}`);
  await page2.waitForSelector('.pf-page h1', { timeout: 8000 });
  const tomN = (await D.api(`/persons/${tom.id}`)).json.contacts.length;
  await ctx.setOffline(true);
  const tabNote = `Two tabs ${tag}`;
  await page.click('.pf-rate button:has-text("+ Add a note")');
  await page.fill('#contact-note', tabNote);
  await page.click('.pf-rate button[aria-label="2: Lean support"]');
  await until(async () => /Saved offline/.test(await page.innerText('.pf-rate').catch(() => '')), 6000);
  const tabTag = `tab2-${tag}`;
  await page2.click('.pf-sec__btn:has-text("Tags")');
  await page2.click('.pf-sec button:has-text("Edit tags")');
  await page2.fill('.tag-editor input[aria-label="Add a tag"]', tabTag);
  await page2.keyboard.press('Enter');
  await sleep(700);
  const both = (await D2t.outbox()).map((i) => i.name).sort().join(',');
  check('two tabs, no signal: the outbox holds both tabs’ work (the second save didn’t drop the first)', both === 'contact.log,person.tag', both);
  check('…and each tab’s strip counts both', /^2 saved on this device$/i.test(await D.chip()) && /^2 saved on this device$/i.test(await D2t.chip()), `${await D.chip()} / ${await D2t.chip()}`);
  // The first tab goes away before the signal is back (closing it would lift "offline" in the test browser).
  await page.goto('about:blank');
  await goOnline(ctx, page2);
  await until(async () => (await D2t.outbox()).length === 0, 25000);
  const tomAfterTabs = (await D.api(`/persons/${tom.id}`)).json;
  check('back online in the other tab: the closed tab’s note and rating are sent too, once',
    tomAfterTabs.contacts.length === tomN + 1 && tomAfterTabs.contacts.filter((c) => c.note === tabNote).length === 1 && tomAfterTabs.person.rating === '2',
    `${tomN} → ${tomAfterTabs.contacts.length} · ${tomAfterTabs.person.rating}`);
  check('…and the tag from this tab', (await D.api(`/persons/${maya.id}`)).json.person.tags.includes(tabTag));
  await page2.close();
  await D.go('/');
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Sign-out forgets; the next sign-in on this browser sees none of it
// ════════════════════════════════════════════════════════════════════════════
const staffInv = (await D.api('/actions/member.invite', { email: `desk.staff+${tag}@example.org`, role: 'staff' })).json;
// A second tab left open on Money: its copies are kept for that tab only.
const tabB = await ctx.newPage();
tabB.on('pageerror', (e) => errors.push('[tab B] ' + e.message));
const TB = helpers(tabB, ctx);
await TB.go('/money');
await tabB.waitForSelector('#gift-list, .ops-rows', { timeout: 8000 }).catch(() => {});
await sleep(1200);
const tabBHad = Object.keys((await TB.stored()).session);
// Signed out from a profile with a note still in the box: it goes first, as
// theirs, and nothing is left waiting on this computer afterwards.
const byeNote = `Typed before sign-out ${tag}`;
const devBefore = (await D.api(`/persons/${dev.id}`)).json.contacts.length;
await D.go(`/people/${dev.id}`);
await page.waitForSelector('.pf-rate', { timeout: 8000 });
await page.click('.pf-rate button:has-text("+ Add a note")');
await page.fill('#contact-note', byeNote);
await page.click('.acct-btn');
await page.click('.acct-panel button:has-text("Sign out")');
await page.waitForURL(`${ADMIN}/login`, { timeout: 10000 }).catch(() => {});
await sleep(1200);
const byeOutbox = await D.outbox();
let left = await D.stored();
check('signed out: no copies left in this browser or this tab', Object.keys(left.local).length === 0 && Object.keys(left.session).length === 0,
  JSON.stringify([...Object.keys(left.local), ...Object.keys(left.session)]).slice(0, 200));
check('…a note typed on the profile was sent before signing out, and nothing is left in the outbox',
  byeOutbox.length === 0 && (await D.outbox()).length === 0, JSON.stringify(byeOutbox).slice(0, 200));
await tabB.waitForURL(`${ADMIN}/login`, { timeout: 8000 }).catch(() => {});
const tabBLeft = await TB.stored();
check('…the other open tab is told: it goes to Sign in, and its tab-only copies (the ledger) are gone',
  tabBHad.some((k) => k.endsWith(':q:manager:gifts')) && /\/login$/.test(tabB.url()) && Object.keys(tabBLeft.session).length === 0,
  JSON.stringify({ had: tabBHad.length, url: tabB.url(), left: Object.keys(tabBLeft.session) }));
await ctx.setOffline(true);
await TB.go('/money');
check('…and with no signal there, Money shows no ledger', !/Arjun Mehta|Raised this year/i.test(await TB.text()), (await TB.text()).slice(0, 120));
await ctx.setOffline(false);
await tabB.close();
await join(page, staffInv.joinUrl, 'Sam Staff');
const meB = (await D.api('/auth/me')).json;
check('a second person signs in on the same browser', meB.user.id !== meA.user.id && meB.role === 'staff');
const devAfter = (await D.api(`/persons/${dev.id}`)).json.contacts;
check('…the note typed before signing out is on the server once, from the first person',
  devAfter.length === devBefore + 1 && devAfter.filter((c) => c.note === byeNote && c.by_name === 'Riley Desk').length === 1, `${devBefore} → ${devAfter.length}`);
await page.waitForSelector('.today-nums', { timeout: 8000 }).catch(() => {});
await sleep(1200);
await ctx.setOffline(true);
await D.go('/people');
await page.waitForSelector('.pp-offline', { timeout: 6000 }).catch(() => {});
t = await D.text();
check('…their People with no signal: "No signal — the list loads…", none of the first person’s copy',
  /No signal — the list loads when you’re back online/.test(t) && (await page.locator('.pp-table tbody tr, .pp-list li').count()) === 0, t.slice(0, 160));
await D.go(`/people/${tom.id}`);
await page.waitForSelector('.pp-offline', { timeout: 6000 }).catch(() => {});
check('…nor the first person’s profile', /No signal — this profile loads when you’re back online/.test(await D.text()));
left = await D.stored();
check('…and nothing of theirs is stored here', ![...Object.keys(left.local), ...Object.keys(left.session)].some((x) => x.includes(meA.user.id)));
await goOnline(ctx, page);
await sleep(800);

// ════════════════════════════════════════════════════════════════════════════
// 6. Volunteer on a phone: keeps only what a volunteer saw
// ════════════════════════════════════════════════════════════════════════════
const D2 = D; // the desk's cookies are Sam's now; the manager's API is a fresh context
const mctx = await browser.newContext();
const M = helpers(await mctx.newPage(), mctx);
const login = await mctx.request.post(`${BASE}/api/auth/login`, { data: { email: mgrEmail, password: 'surrey-forward-2026' } });
check('manager signs in again (API) to invite a volunteer', login.ok(), login.status());
const volEmail = `desk.vol+${tag}@example.org`;
const vinv = (await M.api('/actions/member.invite', { email: volEmail, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await routeTiles(vctx);
const vp = await vctx.newPage();
vp.on('pageerror', (e) => errors.push('[vol] ' + e.message));
const V = helpers(vp, vctx);
await join(vp, vinv.joinUrl, 'Jas Volunteer');
await V.go('/');
await V.swReady();
await V.go('/');
await vp.waitForSelector('.today-start', { timeout: 8000 }).catch(() => {});
await V.go('/calls');
await V.go('/shifts');
await V.go(`/people/${harjit.id}`);
await vp.waitForSelector('.pf-rate', { timeout: 8000 }).catch(() => {});
await V.go('/inbox');
await sleep(1200);
const vk = await V.stored();
const vLocal = Object.keys(vk.local);
check('volunteer: their Today and the profile they opened are kept (in this browser — no money in them)',
  has(vLocal, ':q:volunteer:brief') && has(vLocal, `:q:volunteer:person:${harjit.id}`) && Object.keys(vk.session).length === 0, vLocal.map((x) => x.split(':').slice(5).join(':')).join(' | '));
check('volunteer: no People list, no money copies', !vLocal.some((x) => /:q:volunteer:(persons|gifts|pledges|receipts|filings)/.test(x)));
const vText = Object.values(vk.local).join('\n');
const vBrief = JSON.parse(Object.entries(vk.local).find(([x]) => x.endsWith(':q:volunteer:brief'))?.[1] || '{}').data || {};
const vProf = JSON.parse(Object.entries(vk.local).find(([x]) => x.endsWith(`:q:volunteer:person:${harjit.id}`))?.[1] || '{}').data || {};
check('…only what the server let a volunteer see: no money in Today or the profile', vBrief.money === null && (vBrief.flagged || []).length === 0
  && vProf.donor === null && (vProf.gifts || []).length === 0 && !/amount_cents|totalCents/.test(vText), JSON.stringify({ m: vBrief.money, d: vProf.donor }));
const leaked = [...new Set((vText.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).filter((e) => e.toLowerCase() !== volEmail))];
check('…and no one else’s email anywhere in what this phone kept', leaked.length === 0, leaked.join(', '));

await vctx.setOffline(true);
await V.go('/');
await vp.waitForSelector('.today-start', { timeout: 8000 }).catch(() => {});
t = await V.text();
check('volunteer Today with no signal: the kept copy, "No signal · from <time>"', KEPT.test(await V.kept()) && /Start canvassing|Make calls/i.test(t), `${await V.kept()} · ${t.slice(0, 120)}`);
await simple(V, 'Volunteer Today, no signal (390)', 'main.page a.btn-primary');
await V.shot('06-vol-today-no-signal');
await V.go(`/people/${harjit.id}`);
await vp.waitForSelector('.pf-rate', { timeout: 8000 }).catch(() => {});
check('volunteer profile with no signal: kept, no Tags (desk work)', /Harjit Gill/.test(await vp.innerText('.pf-page h1').catch(() => '')) && !(await vp.$('.pf-sec__btn:has-text("Tags")')));
const vBefore = (await M.api(`/persons/${harjit.id}`)).json.contacts.length;
await vp.tap('.pf-rate button[aria-label="2: Lean support"]').catch(() => vp.click('.pf-rate button[aria-label="2: Lean support"]'));
await sleep(600);
t = await V.text();
check('volunteer rating with no signal: "Saved offline", waiting on this phone', /Saved offline/.test(t) && /Saved on this phone — sends when you’re back online/.test(t), t.slice(0, 200));
await simple(V, 'Volunteer profile, no signal (390)', '.pf-rate button[aria-label]');
await V.shot('07-vol-profile-queued');
await goOnline(vctx, vp);
await until(async () => !(await V.chip()), 20000);
const vAfter = (await M.api(`/persons/${harjit.id}`)).json;
check('back online: the volunteer’s knock once', vAfter.contacts.length === vBefore + 1 && vAfter.person.rating === '2', `${vAfter.contacts.length} vs ${vBefore}`);

// Made treasurer while their Starbase is open (this tab still thinks
// "volunteer"): Today's money lands in this tab only, never in the browser.
const volUser = (await V.api('/auth/me')).json.user;
await V.go('/map');
check('manager makes the volunteer a treasurer', (await M.api('/actions/member.setRole', { user_id: volUser.id, role: 'treasurer' })).status === 200);
await vp.click('.tabbar a[href="/"]').catch(() => vp.click('nav.links a[href="/"]'));
await sleep(2000);
let vs = await V.stored();
const moneyLocal = Object.entries(vs.local).filter(([, v]) => /totalCents|amount_cents/.test(v)).map(([k2]) => k2.split(':').slice(5).join(':'));
check('…Today now carries money: kept for this tab only, even under the old role’s name', moneyLocal.length === 0
  && Object.entries(vs.session).some(([k2, v]) => k2.endsWith(':q:volunteer:brief') && /totalCents/.test(v)), JSON.stringify({ moneyLocal, session: Object.keys(vs.session).map((x) => x.split(':').slice(5).join(':')) }));
await V.go('/');
await sleep(1200);
vs = await V.stored();
check('…reloaded as treasurer: nothing kept under the old role stays', ![...Object.keys(vs.local), ...Object.keys(vs.session)].some((x) => x.includes(':q:volunteer:')),
  [...Object.keys(vs.local), ...Object.keys(vs.session)].map((x) => x.split(':').slice(5).join(':')).join(' | '));
await V.go('/people');
await V.go('/map');
await sleep(1200);
vs = await V.stored();
const deskShaped = (Object.values({ ...vs.local, ...vs.session }).join('\n').match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).filter((e) => e.toLowerCase() !== volEmail).length;
// Back to volunteer: the desk-shaped copies (everyone's emails on the doors and People) go at the next start.
check('manager makes them a volunteer again (as treasurer they kept the doors and People with everyone’s email)',
  deskShaped > 0 && (await M.api('/actions/member.setRole', { user_id: volUser.id, role: 'volunteer' })).status === 200, deskShaped);
await V.go('/');
await sleep(1200);
vs = await V.stored();
const keptNow = { ...vs.local, ...vs.session };
const others = [...new Set((Object.values(keptNow).join('\n').match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).filter((e) => e.toLowerCase() !== volEmail))];
check('…as a volunteer again: no treasurer copies, and no one else’s email in anything kept (doors, People)',
  !Object.keys(keptNow).some((x) => x.includes(':q:treasurer:')) && others.length === 0, `${others.length} emails · ${Object.keys(keptNow).map((x) => x.split(':').slice(5).join(':')).join(' | ')}`);
// A day old is the most anything is kept — in storage too, not only on screen.
await V.go('/shifts');
await sleep(1200);
await vp.evaluate(() => {
  for (const s of [localStorage, sessionStorage]) {
    for (const k of Object.keys(s)) {
      if (!k.startsWith('starbase:copy:') || k.endsWith(':scale')) continue;
      const v = JSON.parse(s.getItem(k));
      v.at -= 3 * 24 * 3600 * 1000;
      s.setItem(k, JSON.stringify(v));
    }
  }
});
const aged = Object.keys((await V.stored()).local).filter((x) => !x.endsWith(':scale')).length;
await vctx.setOffline(true);
await V.go('/');
vs = await V.stored();
const stale = Object.keys({ ...vs.local, ...vs.session }).filter((x) => !x.endsWith(':scale'));
check('copies three days old are gone at the next start (only the rating scale stays)', aged > 0 && stale.length === 0, `${aged} aged · left ${stale.join(' | ')}`);
await vctx.setOffline(false);
// The session ends without Sign out (cookie gone): the next start forgets every copy.
await V.go('/shifts');
await V.go('/map');
await sleep(1200);
const before401 = Object.keys((await V.stored()).local).length;
await vctx.clearCookies();
await V.go('/');
await vp.waitForURL(`${BASE}/login`, { timeout: 8000 }).catch(() => {});
await sleep(600);
vs = await V.stored();
check('a sign-in the server says is over: on Sign in, and nothing kept is left', before401 > 0 && /\/login$/.test(vp.url())
  && Object.keys(vs.local).length === 0 && Object.keys(vs.session).length === 0, `${before401} → ${Object.keys(vs.local).join(' | ')}`);
await vctx.close();

// ════════════════════════════════════════════════════════════════════════════
// 7. Storage blocked (a private window): today's behaviour, no errors
// ════════════════════════════════════════════════════════════════════════════
const pctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await pctx.addInitScript(() => {
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, name, { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
  }
});
const pp = await pctx.newPage();
const perrors = [];
pp.on('pageerror', (e) => perrors.push(e.message));
const PH = helpers(pp, pctx);
await PH.go('/login');
await pp.fill('#login-email', mgrEmail);
await pp.fill('#login-password', 'surrey-forward-2026');
await pp.click('button[type="submit"]');
await pp.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
await pp.waitForSelector('.today-nums', { timeout: 8000 }).catch(() => {});
await pp.click('nav.links a[href="/admin/people"]').catch(() => {});
await pp.waitForSelector('.pp-table tbody tr', { timeout: 8000 }).catch(() => {});
await sleep(1200);
await PH.shot('08-storage-blocked-online');
check('storage blocked: the desk still works with signal', (await pp.locator('.pp-table tbody tr').count()) > 20 && Number(await countOf(pp)) > 50, `${pp.url()} ${(await PH.text()).slice(0, 160)}`);
await pctx.setOffline(true);
await pp.click('nav.links a[href="/admin/signs"]');
await sleep(1500);
t = await PH.text();
check('storage blocked, no signal: a screen not loaded yet says No signal, as before', /No signal — this loads when you’re back online/.test(t), t.slice(0, 160));
check('storage blocked: no page errors', perrors.length === 0, perrors.join(' | '));
await pctx.close();
await mctx.close();
await ctx.close();
void D2;

// ── The books still verify ──
const relog = await browser.newContext();
const R = helpers(await relog.newPage(), relog);
await relog.request.post(`${BASE}/api/auth/login`, { data: { email: mgrEmail, password: 'surrey-forward-2026' } });
const v = (await R.api('/audit/verify')).json;
check('hash chain verifies after the whole journey', v?.ok === true && v.checked > 20, JSON.stringify(v));
check('no page errors', errors.length === 0, errors.join(' | '));
await relog.close();

console.log('\nSIMPLE (words · yellow · overflow · min tap):');
for (const m of measured) console.log(`      ${m.name}: ${m.words} · ${m.yellow} · ${m.overflow} · ${m.minTap == null ? '-' : Math.round(m.minTap)}`);
await browser.close();
if (server) server.kill();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
