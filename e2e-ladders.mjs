// Ladders E2E — one fresh in-memory campaign: a desk user finds Ladders
// under Outreach, builds "Thank petition signers" (pick the petition; steps
// as cards: Tag · Email · Follow-up, one moved up, a Wait), turns it on; a
// visitor signs the petition on the public page; the job runner tags them,
// adds the follow-up and — email not connected — the run says "Waiting —
// email isn't connected" on screen exactly as the server has it. Today's
// "Needs you" has "1 follow-up"; the follow-up is done and undone; the
// profile shows the engagement chip and the Ladders section; off holds the
// run in place and on resumes it. A volunteer on a 390×844 phone rates a
// door 1 (which puts that person on a ladder) and can reach none of it —
// screens, API, or the JSON their browser receives; Dora never said yes to
// email, so the ladder's email skips her ("didn't ask for email"). The
// unsubscribe link asks before it acts; once Ana is off the list the desk
// can't add her back; Dora (never on it) is flagged do-not-email with no list
// row. The builder's email card says who it reaches ("· N people said yes"),
// "+ First name" fills in as "[first name]" (the server keeps {{first_name}}),
// no code shows on the builder, and a {first_name} is flagged. Back links
// say where they go ("← Today" from Today, "← Ladders", "← Ana Souza" from her
// profile). The books still verify. New screens are measured (visible words,
// yellow buttons, sideways scroll, 48px targets).
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4103 STARBASE_JOBS_EVERY_MS=1000 node server/index.js &
//   BASE=http://127.0.0.1:4103 SHOTS=/tmp/ladders node e2e-ladders.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const ADMIN = { toString() { return `${BASE}/admin`; } }; // the desk's pages live in the admin (web/src/mode.js)
const SHOTS = process.env.SHOTS || '/tmp/starbase-ladders';
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
    const major = ((x * 256 + i) / 32) % 4 === 0;
    lines.push(`<line x1="${i}" y1="0" x2="${i}" y2="256" stroke="#fff" stroke-width="${major ? 5 : 2}"/>`);
  }
  for (let j = 0; j <= 256; j += 32) {
    const major = ((y * 256 + j) / 32) % 4 === 0;
    lines.push(`<line x1="0" y1="${j}" x2="256" y2="${j}" stroke="#fff" stroke-width="${major ? 5 : 2}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/>${lines.join('')}</svg>`;
};
const tiles = (ctx) => ctx.route(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/, (route) => {
  const [, z, x, y] = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.png/);
  route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg(+z, +x, +y) });
});

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const helpers = (page, who) => {
  page.on('pageerror', (e) => errors.push(`[${who}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && /key|unique|warning/i.test(m.text())) errors.push(`[${who}] ${m.text()}`); });
  return {
    shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }),
    full: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }),
    text: async () => ((await page.innerText('main.page').catch(() => page.innerText('body').catch(() => ''))) || '').replace(/\s+/g, ' '),
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch('/api' + p, b === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
      });
      const raw = await r.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not json */ }
      return { status: r.status, json, raw };
    }, [path, body]),
    go: async (path) => { await page.goto(`${/vol/.test(who) ? BASE : ADMIN}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); },
  };
};
// Simplicity: words on the screen (not the nav/tab bar), yellow buttons,
// sideways scroll, and the smallest tap target among `sel`.
const measure = (page, sel = null) => page.evaluate((targets) => {
  const main = document.querySelector('main.page') || document.body;
  const words = (main.innerText || '').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const yellow = [...document.querySelectorAll('.btn-primary')].filter(visible).length;
  const overflow = document.documentElement.scrollWidth - window.innerWidth;
  let minTap = null;
  let minWho = '';
  if (targets) {
    for (const el of document.querySelectorAll(targets)) {
      if (!visible(el)) continue;
      const h = el.getBoundingClientRect().height;
      if (minTap == null || h < minTap) { minTap = h; minWho = el.outerHTML.slice(0, 80); }
    }
  }
  return { words, yellow, overflow, minTap, minWho };
}, sel);
const FIELDS = 'main.page input:not([type=checkbox]), main.page select, main.page textarea, main.page button, main.page a.btn';
const simple = async (page, name, sel = FIELDS) => {
  const m = await measure(page, sel);
  check(`${name}: ≤1 yellow, no sideways scroll, targets ≥48px`, m.yellow <= 1 && m.overflow <= 0 && (m.minTap == null || m.minTap >= 47.5),
    `words=${m.words} yellow=${m.yellow} overflow=${m.overflow} minTap=${m.minTap} ${m.minTap < 47.5 ? m.minWho : ''}`);
  return m;
};
const until = async (fn, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(500);
  }
};

// ── 1. Desk: sign up, a petition, a few people ──
const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(desk);
const page = await desk.newPage();
const D = helpers(page, 'desk');
await D.go('/signup');
await page.fill('#su-name', 'Ladder Organizer');
await page.fill('#su-email', `organizer.${tag}@example.org`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.click('button[type="submit"]');
await page.waitForURL(/\/admin\/?$/, { timeout: 15000 });
const me = (await D.api('/auth/me')).json;
const slug = me.workspace.slug;
check('desk signed up', !!slug, slug);
const pet = await D.api('/actions/petition.create', { slug: 'fix-72-ave', title: 'Fix 72 Ave' });
check('petition created', pet.status === 200);
const dora = (await D.api('/actions/person.create', { name: 'Dora Door', phone: '604-555-0161', address: '12345 72 Ave', city: 'Surrey', lat: 49.133, lng: -122.851, email: `dora.${tag}@example.org` })).json.person;

// ── 2. Outreach → Ladders ──
await D.go('/outreach/newsletter');
const link = page.locator('a.lad-link');
check('Outreach has a Ladders row', await link.isVisible().catch(() => false), await D.text().then((t) => t.slice(-120)));
await link.click();
await page.waitForURL(`${ADMIN}/ladders`, { timeout: 8000 }).catch(() => {});
await sleep(600);
let t = await D.text();
check('Ladders opens empty: one line + one button', /No ladders yet\./.test(t) && (await page.locator('.btn-primary:visible').count()) === 1, t.slice(0, 160));
check('Ladders says what it is under the title', /^Ladders Automatic emails & follow-ups/.test(t), t.slice(0, 60));
await D.shot('1-ladders-empty');

// ── 3. New ladder: name + Starts when (the petition) ──
await page.getByRole('button', { name: 'New ladder' }).click();
await page.fill('#lad-new-name', 'Thank petition signers');
await page.selectOption('#lad-new-kind', 'petition');
await page.selectOption('#lad-new-ref', 'fix-72-ave');
check('new-ladder form: one yellow (the header button gives way)', (await page.locator('.btn-primary:visible').count()) === 1);
await D.shot('2-new-ladder');
await page.getByRole('button', { name: 'Create ladder' }).click();
await page.waitForURL(/\/ladders\/[0-9a-f-]{36}$/, { timeout: 8000 }).catch(() => {});
await sleep(700);
const ladderId = page.url().split('/').pop();
let L = (await D.api(`/ladders/${ladderId}`)).json;
check('ladder created off, starting on the petition', L?.ladder?.active === false && L.ladder.trigger.kind === 'petition' && L.ladder.trigger.ref === 'fix-72-ave', JSON.stringify(L?.ladder?.trigger));
t = await D.text();
check('builder says what starts it', /Starts when/i.test(t) && /Signed a petition · Fix 72 Ave/.test(t), t.slice(0, 200));
check('Turn on waits for a step', await page.getByRole('button', { name: 'Turn on' }).isDisabled() && /Add a step, then turn it on\./.test(t));

// ── 4. Steps as cards ──
const addStep = async (label, fill) => {
  await page.getByRole('button', { name: `+ ${label}` }).click();
  await fill();
  await page.getByRole('button', { name: 'Add step' }).click();
  await sleep(700);
};
await addStep('Tag', () => page.getByLabel('Add tag').fill('thanked'));
// Email: a {first_name} is flagged before saving; + First name / + Campaign fill in.
await page.getByRole('button', { name: '+ Email' }).click();
await page.getByLabel('Subject').fill('Thanks, {first_name}');
await page.getByLabel('Message').fill('Thank you for signing for 72 Ave. — ');
await page.getByRole('button', { name: 'Add step' }).click();
await sleep(400);
t = await D.text();
check('a {first_name} is flagged, not saved', /\{first_name\} won’t fill in — use \+ First name/.test(t)
  && !(await D.api(`/ladders/${ladderId}`)).json.ladder.steps.some((x) => x.kind === 'email'), t.slice(t.indexOf('Subject'), t.indexOf('Subject') + 200));
await page.getByLabel('Subject').fill('Thanks, ');
await page.getByRole('button', { name: '+ First name' }).click();
await page.getByLabel('Message').click();
await page.getByLabel('Message').press('End');
await page.getByRole('button', { name: '+ Campaign' }).click();
const filled = [await page.getByLabel('Subject').inputValue(), await page.getByLabel('Message').inputValue()];
check('+ First name / + Campaign fill in at the cursor, as words', filled[0] === 'Thanks, [first name]' && filled[1] === 'Thank you for signing for 72 Ave. — [campaign]', JSON.stringify(filled));
check('no code in the help line', !/\{\{/.test(await page.locator('.lad-new-step .lad-hint').innerText()));
await page.getByRole('button', { name: 'Add step' }).click();
await sleep(700);
await page.getByRole('button', { name: '+ Follow-up' }).click();
const fuHint = await page.getByLabel('Follow-up for staff').getAttribute('placeholder');
check('follow-up placeholder in words, no code', fuHint === 'Call [first name] to say thanks', fuHint);
await page.getByLabel('Follow-up for staff').fill('Call [first name] to say thanks');
await page.getByRole('button', { name: 'Add step' }).click();
await sleep(700);
// Open the follow-up card and move it above the email.
await page.locator('.lad-step .ops-row', { hasText: 'Follow-up · Call' }).click();
await page.getByRole('button', { name: 'Move up' }).click();
await sleep(700);
await addStep('Wait', async () => {
  await page.getByLabel('Wait').fill('1');
  await page.getByRole('button', { name: 'Days' }).click();
});
L = (await D.api(`/ladders/${ladderId}`)).json;
const kinds = L.ladder.steps.map((s) => s.kind).join(',');
check('steps saved in order (follow-up moved up)', kinds === 'tag,followup,email,wait', kinds);
const cards = (await page.locator('.lad-step .lad-step__line').allInnerTexts()).join(' | ');
const em = L.ladder.steps.find((x) => x.kind === 'email');
const fu = L.ladder.steps.find((x) => x.kind === 'followup');
check('the server keeps the codes underneath', em.subject === 'Thanks, {{first_name}}' && em.body === 'Thank you for signing for 72 Ave. — {{campaign}}'
  && fu.text === 'Call {{first_name}} to say thanks', JSON.stringify([em, fu]));
check('cards read as the server has them, in words', cards === 'Tag · thanked | Follow-up · Call [first name] to say thanks | Email · Thanks, [first name] | Wait 1 day', cards);
check('no code on the builder', !/\{\{|\}\}/.test(await D.text()), (await D.text()).match(/.{0,40}\{\{.{0,40}/)?.[0]);
const who = (await page.locator('.lad-step .lad-step__who').allInnerTexts()).map((x) => x.trim());
const saidYes = `${L.emailYes} ${L.emailYes === 1 ? 'person' : 'people'} said yes`;
check('the email card says who it reaches, the number with its noun (= server)', who.length === 1 && who[0] === `Goes only to people who said yes to email · ${saidYes}`, `${who.join(' | ')} vs ${L.emailYes}`);
const back = async () => ({ text: ((await page.locator('.ops-back').first().textContent().catch(() => '')) || '').trim(), href: await page.locator('.ops-back').first().getAttribute('href').catch(() => null) });
let bk = await back();
check('builder back: "← Ladders", like every screen', bk.text === '← Ladders' && bk.href === '/ladders', JSON.stringify(bk));
check('the steps row says "Other steps", the page has one More',
  await page.getByRole('button', { name: 'Other steps' }).isVisible() && (await page.getByRole('button', { name: 'More', exact: true }).count()) === 1);
// Field targets inside an open email editor.
await page.getByRole('button', { name: '+ Email' }).click();
await sleep(300);
await simple(page, 'builder with an email step open (desktop)');
await page.locator('.lad-new-step').getByRole('button', { name: 'Cancel' }).click();
t = await D.text();
check('email not connected is said once', /Email isn’t connected — email steps wait\./.test(t));
await D.full('3-builder-steps');

await page.getByRole('button', { name: 'Turn on' }).click();
await sleep(800);
L = (await D.api(`/ladders/${ladderId}`)).json;
t = await D.text();
const statusChip = (await page.locator('.lad-status .chip').innerText().catch(() => '')).trim();
check('Turn on → On (server and screen)', L.ladder.active === true && /^on$/i.test(statusChip) && !(await page.getByRole('button', { name: 'Turn on' }).count()), `${statusChip} · ${t.slice(0, 120)}`);
check('On is said once (the chip), no extra line', (await page.locator('.ops-done').count()) === 0);

// ── 5. A visitor signs the petition ──
const visitor = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const vp = await visitor.newPage();
vp.on('pageerror', (e) => errors.push(`[visitor] ${e.message}`));
await vp.goto(`${BASE}/p/${slug}/fix-72-ave`, { waitUntil: 'domcontentloaded' });
await vp.fill('#name', 'Ana Souza');
await vp.fill('#email', `ana.${tag}@example.org`);
await vp.check('input[name="subscribe"]'); // she says yes to email
await vp.click('button[type="submit"]');
await vp.waitForSelector('text=/Thank you, Ana/', { timeout: 8000 }).catch(() => {});
check('visitor signed', /Thank you, Ana/.test(await vp.innerText('body')));

// The job runner takes her through Tag and Follow-up; Email waits.
const run = await until(async () => {
  const j = (await D.api(`/ladders/${ladderId}`)).json;
  const r = j?.people?.find((p) => p.person.name === 'Ana Souza');
  return r && r.wait === 'email' ? r : null;
});
check('run reached the email step and waits (email not connected)', run && run.step === 2 && run.status === 'active', JSON.stringify(run || {}).slice(0, 200));
await D.go(`/ladders/${ladderId}`);
t = await D.text();
check('screen: "Waiting — email isn’t connected" for Ana', /Ana Souza Waiting — email isn’t connected/.test(t), t.slice(t.indexOf('People'), t.indexOf('People') + 120));
check('screen: 1 in progress · 0 finished', /1 in progress · 0 finished/.test(t));
await page.locator('.lad-sec .ops-row', { hasText: 'Ana Souza' }).click();
await sleep(300);
const log = (await page.locator('.lad-log li').allInnerTexts()).map((s) => s.replace(/\s+/g, ' '));
check('her row opens on what each step did', log.length === 3 && /^Tag · thanked/.test(log[0]) && /^Follow-up added/.test(log[1]) && /^Email waiting — not connected/.test(log[2]), log.join(' | '));
await D.full('4-builder-people');
const ana = (await D.api(`/persons?q=${encodeURIComponent('Ana Souza')}`)).json.persons[0];
const prof = (await D.api(`/persons/${ana.id}`)).json;
check('the Tag step really tagged her', prof.person.tags.includes('thanked'), prof.person.tags.join(','));

// ── 6. Today → 1 follow-up → done, undone ──
await D.go('/');
t = await D.text();
check('Today Needs you: 1 follow-up', /Needs you.*?\b1 follow-up\b/i.test(t), t.slice(0, 300));
await D.shot('5-today-needs-you');
await page.locator('a.today-row', { hasText: 'follow-up' }).click();
await page.waitForURL(`${ADMIN}/follow-ups`, { timeout: 8000 }).catch(() => {});
await sleep(700);
let FU = (await D.api('/ladders/followups')).json;
t = await D.text();
check('follow-up reads as the server has it', FU.open.length === 1 && FU.open[0].text === 'Call Ana to say thanks' && t.includes('Call Ana to say thanks') && /1 to do/.test(t), t.slice(0, 200));
bk = await back();
check('follow-ups from Today: back says "← Today"', bk.text === '← Today' && bk.href === '/', JSON.stringify(bk));
await simple(page, 'follow-ups (desktop)');
await D.shot('6-follow-ups');
await page.getByRole('button', { name: 'Done' }).click();
await sleep(800);
FU = (await D.api('/ladders/followups')).json;
t = await D.text();
check('Done → done on the server, toast says so', FU.open.length === 0 && FU.done[0]?.status === 'done' && /Done · Ana Souza/.test(await page.innerText('body')) && /0 to do/.test(t));
await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
await sleep(800);
FU = (await D.api('/ladders/followups')).json;
check('Undo → open again', FU.open.length === 1 && /1 to do/.test(await D.text()));

// ── 7. Profile: engagement chip + Ladders section ──
await D.go(`/people/${ana.id}`);
const lev = (await D.api(`/persons/${ana.id}/ladders`)).json;
const chip = await page.locator('.lad-level').innerText().catch(() => '');
check('profile: engagement chip = server level', chip.trim().toLowerCase() === lev.level.label.toLowerCase() && lev.level.code === 'signer', `${chip} vs ${lev.level.label}`);
await page.getByRole('button', { name: /^Ladders/ }).click();
await sleep(300);
t = await D.text();
check('profile: Ladders section says where she is', /Thank petition signers Waiting — email isn’t connected/.test(t) && /Call Ana to say thanks/.test(t), t.slice(t.indexOf('Ladders'), t.indexOf('Ladders') + 160));
await D.shot('7-profile');
await page.locator('.lad-pf-runs a', { hasText: 'Thank petition signers' }).click();
await page.waitForURL(`${ADMIN}/ladders/${ladderId}`, { timeout: 8000 }).catch(() => {});
await sleep(700);
bk = await back();
check('ladder from her profile: back says "← Ana Souza"', bk.text === '← Ana Souza' && bk.href === `/people/${ana.id}`, JSON.stringify(bk));

// ── 8. The list + engagement ──
await D.go('/ladders');
t = await D.text();
const rowText = (await page.locator('.ops-rows .ops-item', { hasText: 'Thank petition signers' }).innerText()).replace(/\s+/g, ' ').trim();
check('list row: trigger, counts, On', /^Thank petition signers Signed a petition · Fix 72 Ave 1 in progress · 0 finished On$/i.test(rowText), rowText);
check('list: follow-ups row and email note', /1 follow-up to do/.test(t) && /Email isn’t connected — email steps wait\./.test(t));
await page.locator('a.lad-fu-link').click();
await page.waitForURL(`${ADMIN}/follow-ups`, { timeout: 8000 }).catch(() => {});
await sleep(500);
bk = await back();
check('follow-ups from Ladders: back says "← Ladders"', bk.text === '← Ladders' && bk.href === '/ladders', JSON.stringify(bk));
await D.go('/ladders');
await page.getByRole('button', { name: 'How involved people are' }).click();
await sleep(300);
const LS = (await D.api('/ladders')).json;
const bars = (await page.locator('.lad-levels__row').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
const want = LS.levels.map((l) => `${l.label} ${l.n}`);
check('engagement bars = server counts', JSON.stringify(bars) === JSON.stringify(want), `${bars.join(' | ')} vs ${want.join(' | ')}`);
await D.full('8-ladders-list');

// ── 9. Off holds her place; On resumes ──
await D.go(`/ladders/${ladderId}`);
await page.getByRole('button', { name: 'Turn off' }).click();
await sleep(800);
let r = (await D.api(`/ladders/${ladderId}`)).json.people[0];
t = await D.text();
check('Off → paused at the same step (server and screen)', r.status === 'paused' && r.step === 2 && /Ana Souza Paused · step 3 of 4/.test(t) && /Off · 1 paused in place/.test(t), t.slice(0, 200));
await page.getByRole('button', { name: 'Turn on' }).click();
await sleep(800);
r = (await D.api(`/ladders/${ladderId}`)).json.people[0];
check('On → active again, same step', r.status === 'active' && r.step === 2 && /On · 1 picked up where they were/.test(await D.text()));
await until(async () => (await D.api(`/ladders/${ladderId}`)).json.people[0].wait === 'email', 8000);

// ── 10. Phone, desk: the new screens measured at 390px ──
await page.setViewportSize({ width: 390, height: 844 });
for (const [path, name] of [['/ladders', 'ladders list (phone)'], [`/ladders/${ladderId}`, 'builder (phone)'], ['/follow-ups', 'follow-ups (phone)']]) {
  await D.go(path);
  const m = await simple(page, name);
  console.log(`      words on ${path}: ${m.words}`);
}
await D.go(`/ladders/${ladderId}`);
await page.getByRole('button', { name: '+ Wait' }).click();
await sleep(300);
await simple(page, 'builder, wait editor open (phone)');
await D.shot('9-builder-phone');
await page.locator('.lad-new-step').getByRole('button', { name: 'Cancel' }).click();
await page.setViewportSize({ width: 1360, height: 900 });

// ── 11. Volunteer on a phone: rates a door 1, sees nothing of ladders ──
const yes = (await D.api('/actions/ladder.create', {
  name: 'Rated yes', trigger: { kind: 'rating' },
  steps: [{ kind: 'tag', tag: 'said-yes' }, { kind: 'email', subject: 'Glad you are with us', body: 'Hi {{first_name}}' }],
})).json.ladder;
await D.api('/actions/ladder.setActive', { id: yes.id, active: true });
const inv = (await D.api('/actions/member.invite', { email: `jas.${tag}@example.org`, role: 'volunteer' })).json;
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vol = await vctx.newPage();
const V = helpers(vol, 'volunteer');
await vol.goto(inv.joinUrl.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
await vol.waitForSelector('#join-name', { timeout: 8000 }).catch(() => {});
await vol.fill('#join-name', 'Jas Volunteer');
await vol.fill('#join-password', 'knock-knock-2026');
await vol.click('button[type="submit"]');
await vol.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
check('volunteer joined', new URL(vol.url()).pathname === '/');
await V.go(`/map?person=${dora.id}`);
await vol.waitForSelector('aside.door-card', { timeout: 8000 }).catch(() => {});
await vol.tap('aside.door-card button[aria-label="1: Strong support"]').catch(() => vol.click('aside.door-card button[aria-label="1: Strong support"]'));
await sleep(900);
const vt = ((await vol.innerText('body')) || '').replace(/\s+/g, ' ');
check('volunteer rated the door; the toast says only that', /Rated 1/.test(vt) && !/ladder|follow-up/i.test(vt), vt.slice(0, 160));
const doraRun = await until(async () => (await D.api(`/ladders/${yes.id}`)).json.people.find((p) => p.person.id === dora.id && p.status === 'done'));
check('…which put Dora on "Rated yes" (desk sees it)', !!doraRun);
check('a 1 at the door is not a yes to email: her email is skipped', doraRun && JSON.stringify(doraRun.skipped) === JSON.stringify([{ step: 1, kind: 'email', reason: 'no_consent' }]), JSON.stringify(doraRun?.skipped));
await D.go(`/ladders/${yes.id}`);
await page.getByRole('button', { name: /^Finished · / }).click().catch(() => {});
await sleep(300);
t = await D.text();
check('desk: "Finished · email skipped (didn’t ask for email)"', /Dora Door Finished · email skipped \(didn’t ask for email\)/.test(t), t.slice(t.indexOf('People'), t.indexOf('People') + 140));
await page.locator('.lad-sec .ops-row', { hasText: 'Dora Door' }).click();
await sleep(300);
const dlog = (await page.locator('.lad-log li').allInnerTexts()).map((x) => x.replace(/\s+/g, ' '));
check('her log: "Email skipped — didn’t ask for email"', dlog.some((x) => /^Email skipped — didn’t ask for email/.test(x)), dlog.join(' | '));
for (const path of ['/ladders', `/ladders/${ladderId}`, '/follow-ups']) {
  await V.go(path);
  check(`volunteer typing ${path} lands on Today`, new URL(vol.url()).pathname === '/', vol.url());
}
const vapi = [];
for (const path of ['/ladders', `/ladders/${ladderId}`, '/ladders/followups', '/ladders/followups/count', `/persons/${ana.id}/ladders`]) {
  const res = await V.api(path);
  vapi.push(`${path}=${res.status}`);
  check(`volunteer API ${path} → 403, nothing in it`, res.status === 403 && !/Thank|Ana|follow/i.test(res.raw), res.raw.slice(0, 100));
}
const created = await V.api('/actions/ladder.create', { name: 'x', trigger: { kind: 'rating' } });
check('volunteer cannot make a ladder', created.status === 403);
const vprof = await V.api(`/persons/${dora.id}`);
check('volunteer’s profile JSON carries nothing of ladders', vprof.status === 200 && !/ladder|said-yes|engagement/i.test(vprof.raw.replace(/"tags":\[[^\]]*\]/, '')), vprof.raw.slice(0, 120));
await V.go(`/people/${dora.id}`);
const vpt = ((await vol.innerText('main.page').catch(() => '')) || '').replace(/\s+/g, ' ');
check('volunteer profile: no engagement chip, no Ladders section', !(await vol.locator('.lad-level').count()) && !/\bLadders\b/.test(vpt), vpt.slice(0, 160));
const overflow = await vol.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('volunteer: no sideways scroll at 390px', overflow <= 0, overflow);
await V.shot('10-volunteer-profile');
await V.go('/');
await V.shot('11-volunteer-today');
check('volunteer Today: no follow-ups row', !/follow-up/i.test(await V.text()));
await vctx.close();

// ── 12. The unsubscribe link in her email works, and is honoured ──
await vp.goto(`${BASE}/lu/${run.id}`, { waitUntil: 'domcontentloaded' });
let ut = await vp.innerText('body');
const stillOn = (await D.api('/subscriptions')).json.subscriptions.find((s) => s.email === `ana.${tag}@example.org`);
check('opening the link only asks: one Unsubscribe button, still subscribed', /Unsubscribe from Imagine Surrey\?/.test(ut)
  && (await vp.locator('button', { hasText: /^Unsubscribe$/i }).count()) === 1 && stillOn?.status === 'subscribed', ut.slice(0, 120));
await vp.screenshot({ path: `${SHOTS}/12a-unsubscribe-ask.png` });
await vp.locator('button', { hasText: /^Unsubscribe$/i }).click();
await vp.waitForSelector('text=/Unsubscribed\./', { timeout: 8000 }).catch(() => {});
ut = await vp.innerText('body');
check('one tap: Unsubscribed, names the campaign', /Unsubscribed\./.test(ut) && /Imagine Surrey/.test(ut), ut.slice(0, 120));
await vp.screenshot({ path: `${SHOTS}/12-unsubscribed.png` });
const subs = (await D.api('/subscriptions')).json.subscriptions.filter((s) => s.email === `ana.${tag}@example.org`);
check('on the newsletter list as unsubscribed', subs.length === 1 && subs[0].status === 'unsubscribed', JSON.stringify(subs));
// Dora was never on the list: no list row, flagged do-not-email.
const doraRunId = (await D.api(`/ladders/${yes.id}`)).json.people.find((p) => p.person.id === dora.id).id;
const pre = (await D.api('/subscriptions')).json;
await vp.goto(`${BASE}/lu/${doraRunId}`, { waitUntil: 'domcontentloaded' });
await vp.locator('button', { hasText: /^Unsubscribe$/i }).click();
await vp.waitForSelector('text=/Unsubscribed\./', { timeout: 8000 }).catch(() => {});
const post = (await D.api('/subscriptions')).json;
const doraNow = (await D.api(`/persons/${dora.id}`)).json.person;
check('never on the list: no list row, flagged do-not-email', post.subscriptions.length === pre.subscriptions.length
  && !post.subscriptions.some((s) => s.email === `dora.${tag}@example.org`) && doraNow.tags.includes('do-not-email'), doraNow.tags.join(','));
await visitor.close();

// The desk sees the list as it is and can't put Ana back.
await D.go('/outreach/newsletter');
await page.click('button.ot-more:has-text("More")');
await sleep(300);
const SL = (await D.api('/subscriptions')).json;
const subsHead = (await page.locator('section[aria-label="Subscribers"] h2').innerText()).replace(/\s+/g, ' ').trim();
check('More: "Subscribers N · 1 unsubscribed" (= server)', subsHead.toLowerCase() === `subscribers ${SL.subscribed} · ${SL.unsubscribed} unsubscribed` && SL.unsubscribed === 1, subsHead);
check('no Re-subscribe anywhere', (await page.getByRole('button', { name: 'Re-subscribe' }).count()) === 0);
await page.fill('#sub-email', `ana.${tag}@example.org`);
await page.locator('form.ot-inline-add').getByRole('button', { name: 'Add' }).click();
await sleep(700);
t = await D.text();
const anaAfter = (await D.api('/subscriptions')).json.subscriptions.find((s) => s.email === `ana.${tag}@example.org`);
check('Add: "Unsubscribed on <date> — only they can rejoin (signup page)", still off', /Unsubscribed on [A-Z][a-z]{2} \d{1,2} — only they can rejoin \(signup page\)/.test(t) && anaAfter.status === 'unsubscribed', anaAfter.status);
await D.shot('12b-subscribers');

// ── 12c. A donor's profile: the level chip never repeats the donor tier ──
const gil = (await D.api('/actions/person.create', { name: 'Gil Giver', email: `gil.${tag}@example.org` })).json.person;
await D.api('/actions/gift.log', { person_id: gil.id, amount_cents: 5000, date: new Date().toISOString().slice(0, 10) });
await D.go(`/people/${gil.id}`);
const metaChips = (await page.locator('.pf-meta .chip').allInnerTexts()).map((x) => x.trim().toLowerCase());
check('donor profile: one Donor chip, not two', metaChips.filter((x) => x === 'donor').length === 1 && !(await page.locator('.pf-meta .lad-level').count()), metaChips.join(' | '));

// ── 13. The books still verify ──
const v = (await D.api('/audit/verify')).json;
check('hash chain verifies (ladder steps included)', v.ok === true && v.checked > 10, JSON.stringify(v));
const ev = (await D.api('/events?since=0&limit=1000')).json.events;
check('ladder steps are on the chain as the system', ev.some((e) => e.action === 'ladder.step' && e.actor_id === null && e.entity_type === 'ladder_followup'));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((x) => !x).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
