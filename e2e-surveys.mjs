// Surveys E2E — one fresh in-memory campaign: a desk user builds a survey
// (five kinds, reorder, on/off, turfs), asks it at the map's door card, a
// volunteer on a 390×844 phone answers it on the walk list (online and with
// no signal) and on Calls, the desk reads results (bars, See people, CSV)
// and a profile's Answers, archives it, and the books still verify. Every
// claim on a screen is checked against the API; the new screens are
// measured (visible words, yellow buttons, sideways scroll, 48px targets).
//
//   STARBASE_DATA=memory PORT=4101 node server/index.js &
//   BASE=http://127.0.0.1:4101 SHOTS=/tmp/surveys node e2e-surveys.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:3200';
const SHOTS = process.env.SHOTS || '/tmp/starbase-surveys';
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 200) : ''}`);
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
  page.on('console', (m) => { if (m.type() === 'error' && /key|unique/i.test(m.text())) errors.push(`[${who}] ${m.text()}`); });
  return {
    shot: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: false }),
    full: (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true }),
    text: async () => ((await page.innerText('body').catch(() => '')) || '').replace(/\s+/g, ' '),
    api: (path, body) => page.evaluate(async ([p, b]) => {
      const r = await fetch('/api' + p, b === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
      });
      const raw = await r.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* csv */ }
      return { status: r.status, json, raw };
    }, [path, body]),
    go: async (path) => { await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); },
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
  if (targets) {
    for (const el of document.querySelectorAll(targets)) {
      if (!visible(el)) continue;
      const h = el.getBoundingClientRect().height;
      minTap = minTap == null ? h : Math.min(minTap, h);
    }
  }
  return { words, yellow, overflow, minTap };
}, sel);

// ── 1. A desk user and a small Surrey campaign ──
const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(dctx);
const page = await dctx.newPage();
const D = helpers(page, 'desk');
await D.go('/signup');
await page.fill('#su-name', 'Riley Desk');
await page.fill('#su-email', `riley+${tag}@surveys.example`);
await page.fill('#su-password', 'surrey-forward-2026');
await page.fill('#su-workspace', 'Imagine Surrey');
await page.click('button[type="submit"]');
await page.waitForURL(`${BASE}/`, { timeout: 15000 });
const P = {};
const mk = async (key, data) => { P[key] = (await D.api('/actions/person.create', data)).json.person; };
await mk('harjit', { name: 'Harjit Example', phone: '604-555-0121', email: 'harjit@example.org', address: '12345 72 Ave', city: 'Surrey', lat: 49.1330, lng: -122.8510 });
await mk('maya', { name: 'Maya Example', phone: '604-555-0122', address: '12390 72 Ave', city: 'Surrey', lat: 49.1331, lng: -122.8495 });
await mk('tom', { name: 'Tom Example', phone: '604-555-0123', address: '7120 124 St', city: 'Surrey', lat: 49.1310, lng: -122.8520 });
await mk('grace', { name: 'Grace Example', phone: '604-555-0124', address: '7201 128 St', city: 'Surrey' });
check('seeded 4 people', Object.values(P).every((p) => p?.id));
const turf = (await D.api('/actions/turf.create', {
  name: 'Newton A', polygon: [[49.130, -122.856], [49.136, -122.856], [49.136, -122.846], [49.130, -122.846]],
})).json.turf;
const farTurf = (await D.api('/actions/turf.create', {
  name: 'South Surrey', polygon: [[49.02, -122.80], [49.04, -122.80], [49.04, -122.78], [49.02, -122.78]],
})).json.turf;
check('two turfs drawn', turf?.id && farTurf?.id);

// ── 2. People → More → Surveys; the list ──
await D.go('/people');
await page.click('.pp-menu button:has-text("More")');
const link = await page.$('.pp-menu__panel a[href="/surveys"]');
check('People → More lists Surveys', !!link);
await link.click();
await page.waitForURL(`${BASE}/surveys`);
await sleep(600);
let m = await measure(page);
check('Surveys: empty list, one yellow "New survey"', /No surveys yet/.test(await D.text()) && m.yellow === 1 && /New survey/i.test(await page.innerText('.btn-primary')), JSON.stringify(m));
await D.shot('01-surveys-empty');

// ── 3. New survey → straight to its questions ──
await page.click('button:has-text("New survey")');
await page.fill('#sv-new-name', 'Doorstep issues');
m = await measure(page);
check('new survey form keeps one yellow button', m.yellow === 1, JSON.stringify(m));
await page.click('form[aria-label="New survey"] button:has-text("Both")');
await page.click('button:has-text("Create survey")');
await page.waitForURL(/\/surveys\/[0-9a-f-]{36}\?add=1$/, { timeout: 8000 });
const surveyId = page.url().match(/surveys\/([0-9a-f-]{36})/)[1];
let built = (await D.api(`/surveys/${surveyId}`)).json;
check('survey created: asked at the door and on calls, on', built.survey.name === 'Doorstep issues' && built.survey.context === 'both' && built.survey.active === true, JSON.stringify(built.survey));
await page.waitForSelector('form[aria-label="Add question"]', { timeout: 8000 }).catch(() => {});
check('builder opens on the Add question form', !!(await page.$('form[aria-label="Add question"]')));

const addQuestion = async (text, kind, options = []) => {
  if (!(await page.$('form[aria-label="Add question"]'))) await page.click('.ops-head button:has-text("Add question")');
  const form = 'form[aria-label="Add question"]';
  await page.fill(`${form} input[placeholder="What matters most to you?"]`, text);
  await page.click(`${form} .sv-kind:has-text("${kind}")`);
  for (const [i, o] of options.entries()) {
    const inputs = await page.$$(`${form} .sv-choice input`);
    if (!inputs[i]) await page.click(`${form} button:has-text("+ Add a choice")`);
    await page.fill(`${form} .sv-choice:nth-of-type(${i + 1}) input`, o).catch(async () => {
      const all = await page.$$(`${form} .sv-choice input`);
      await all[i].fill(o);
    });
  }
  await page.click(`${form} button[type="submit"]`);
  await sleep(700);
};
await addQuestion('What matters most to you?', 'One choice', ['Transit', 'Housing', 'Safety']);
await addQuestion('Which would you help with?', 'Several choices', ['Lawn sign', 'Phone calls']);
await addQuestion('How likely are you to vote?', 'Scale 1–5');
await addQuestion('Will you vote early?', 'Yes / no');
await addQuestion('Anything else?', 'Short answer');
built = (await D.api(`/surveys/${surveyId}`)).json;
check('five questions, five kinds, in order', built.questions.map((q) => q.kind).join() === 'choice,choices,scale,yesno,text', built.questions.map((q) => `${q.kind}:${q.text}`).join(' | '));
check('choices saved as typed', JSON.stringify(built.questions[0].options) === '["Transit","Housing","Safety"]', JSON.stringify(built.questions[0].options));
const rows = await page.$$eval('.sv-qlist .ops-row__name', (els) => els.map((e) => e.textContent));
check('builder lists the questions as the API has them', rows.join('|') === built.questions.map((q) => q.text).join('|'), rows.join('|'));

// Reorder: "Will you vote early?" up one.
await page.click('.sv-qlist .ops-row:has-text("Will you vote early?")');
await page.click('.sv-qitem[data-open] button:has-text("Move up")');
await sleep(700);
built = (await D.api(`/surveys/${surveyId}`)).json;
check('Move up reorders on the server', built.questions.map((q) => q.text).indexOf('Will you vote early?') === 2, built.questions.map((q) => q.text).join(' | '));
// Remove asks in place.
await page.click('.sv-qitem[data-open] button:has-text("Remove")');
check('remove asks "Remove this question? Yes · No"', /Remove this question\?/.test(await D.text()));
await page.click('.sv-qitem[data-open] .ops-confirm button:has-text("No")');
m = await measure(page);
check('builder: one yellow button', m.yellow === 1, JSON.stringify(m));
await D.full('02-builder-desktop');

// On / off is the server's.
await page.click('.sv-switch');
await sleep(700);
let s = (await D.api(`/surveys/${surveyId}`)).json.survey;
check('switch off → survey off', s.active === false && (await page.getAttribute('.sv-switch', 'aria-checked')) === 'false');
check('…and its words say so: "Not asking"', (await page.innerText('.sv-switch')).trim() === 'Not asking', await page.innerText('.sv-switch'));
let active = (await D.api('/surveys/active?context=door')).json.surveys;
check('an off survey is not asked in the field', active.length === 0);
await page.click('.sv-switch');
await sleep(700);
s = (await D.api(`/surveys/${surveyId}`)).json.survey;
check('switch on → asking now', s.active === true && (await page.innerText('.sv-switch')).trim() === 'Asking now', await page.innerText('.sv-switch'));

// ── 4. The map's door card: Questions under the outcomes ──
await D.go(`/map?person=${P.harjit.id}`);
await page.waitForSelector('aside.door-card .sv-field', { timeout: 8000 }).catch(() => {});
const order = await page.evaluate(() => {
  const card = document.querySelector('aside.door-card');
  const out = card.querySelector('.fk-outcomes');
  const q = card.querySelector('.sv-field');
  const rb = card.querySelector('.rb');
  return {
    has: !!q,
    after: !!(q && out && (out.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING)),
    heroFirst: !!(q && rb && (rb.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING)),
    label: q?.querySelector('.sv-field__btn')?.innerText,
    open: q?.querySelector('.sv-field__btn')?.getAttribute('aria-expanded'),
  };
});
check('door card: one "Questions · 5", closed, under the outcomes', order.has && order.after && order.heroFirst && /Questions · 5/.test(order.label) && order.open === 'false', JSON.stringify(order));
await page.click('aside.door-card .sv-field__btn');
await page.click('aside.door-card .sv-opt:has-text("Housing")');
await page.click('aside.door-card .sv-q:has-text("Will you vote early?") .sv-opt:has-text("Yes")');
await page.click('aside.door-card .sv-q__opts--scale .sv-opt:has-text("4")');
m = await measure(page, 'aside.door-card .sv-opt, aside.door-card .sv-field__btn, aside.door-card .sv-field__save, aside.door-card .rb-btn');
check('door card: choice buttons ≥ 48px', m.minTap >= 48, JSON.stringify(m));
check('door card: "3 answered" (not "saved") before the tap', /3 answered/i.test(await page.innerText('aside.door-card .sv-field__btn')));
await D.shot('03-door-card-questions');
await page.click('aside.door-card button[aria-label="1: Strong support"]');
await sleep(900);
let t = await D.text();
check('toast: "Rated 1 · Strong yes · 3 answers"', /Rated 1 · Strong yes · 3 answers/.test(t), (t.match(/Rated[^✕]{0,60}/) || [''])[0]);
let ans = (await D.api(`/persons/${P.harjit.id}/answers`)).json.answers;
let prof = (await D.api(`/persons/${P.harjit.id}`)).json;
check('the knock carried exactly those 3 answers', ans.length === 3 && ans.map((a) => a.says).sort().join('|') === '4|Housing|Yes' && prof.person.rating === '1', ans.map((a) => a.says).join('|'));
check('the draft is cleared after the tap', !/answered/i.test(await page.innerText('aside.door-card .sv-field__btn')));
await D.shot('04-door-card-saved');

// ── 5. A volunteer on a phone ──
const invite = (await D.api('/actions/member.invite', { email: `jas+${tag}@surveys.example`, role: 'volunteer' })).json;
check('volunteer invited (a join link, no email claimed)', /\/join\/[0-9a-f]{48}$/.test(invite.joinUrl || ''), invite.email);
const vctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await tiles(vctx);
const vpage = await vctx.newPage();
const V = helpers(vpage, 'vol');
await V.go('/login');
const joined = await V.api('/auth/join', { token: invite.joinUrl.split('/').pop(), name: 'Jas Volunteer', password: 'knock-knock-2026' });
check('volunteer joined', joined.status === 200 && joined.json.role === 'volunteer', joined.status);
const volId = joined.json.user.id;
await D.api('/actions/turf.assign', { turf_id: turf.id, user_id: volId });
// A survey only for South Surrey must not show in Newton.
const south = (await D.api('/actions/survey.create', { name: 'South only', context: 'door', turf_ids: [farTurf.id] })).json.survey;
await D.api('/actions/survey.question.add', { survey_id: south.id, kind: 'yesno', text: 'Ferry worries?' });

const volActive = (await V.api('/surveys/active?context=door')).json;
const keys = new Set(volActive.surveys.flatMap((x) => x.questions.flatMap((q) => Object.keys(q))));
check('volunteer reads questions only (no counts, no answers)', [...keys].sort().join() === 'id,kind,options,text' && !JSON.stringify(volActive).includes('Harjit'), [...keys].join());
for (const path of ['/surveys', `/surveys/${surveyId}`, `/surveys/${surveyId}/results`, `/surveys/${surveyId}/results.csv`, `/persons/${P.harjit.id}/answers`]) {
  const r = await V.api(path);
  check(`volunteer refused ${path.replace(/[0-9a-f-]{36}/g, ':id')}`, r.status === 403, r.status);
}
const vprof = await V.api(`/persons/${P.harjit.id}`);
check("volunteer's profile JSON carries no answers or email", !vprof.raw.includes('Housing') && vprof.json.person.email === null);
await V.go('/surveys');
check('volunteer typing /surveys lands on Today', new URL(vpage.url()).pathname === '/', vpage.url());

// Walk list: answers only → "Save answers".
await V.go(`/turfs/${turf.id}`);
await vpage.waitForSelector('.walk-door', { timeout: 8000 }).catch(() => {});
await vpage.click('.walk-door__head:has-text("12390 72 Ave")');
await sleep(400);
const walkQ = await vpage.$$eval('.walk-panel .sv-field__btn', (els) => els.map((e) => e.innerText));
check('walk list: "Questions · 5" (the South Surrey survey is not asked here)', walkQ.length === 1 && /Questions · 5/.test(walkQ[0]), walkQ.join('|'));
await vpage.click('.walk-panel .sv-field__btn');
await vpage.click('.walk-panel .sv-opt:has-text("Transit")');
await vpage.click('.walk-panel .sv-q:has-text("Which would you help with?") .sv-opt:has-text("Lawn sign")');
await vpage.click('.walk-panel .sv-q:has-text("Which would you help with?") .sv-opt:has-text("Phone calls")');
await vpage.fill('.walk-panel .sv-q__input', 'More buses on 72 Ave');
m = await measure(vpage, '.walk-panel .sv-opt, .walk-panel .sv-q__input, .walk-panel .sv-field__btn, .walk-panel .sv-field__save, .walk-panel .rb-btn');
check('walk list on a phone: no sideways scroll, targets ≥ 48px, ≤ 1 yellow', m.overflow <= 0 && m.minTap >= 48 && m.yellow <= 1, JSON.stringify(m));
await V.shot('05-walk-questions-phone');
await vpage.click('.walk-panel .sv-field__save');
await sleep(900);
t = await V.text();
check('toast: "3 answers saved"', /3 answers saved/.test(t), (t.match(/\d answers? saved/) || [''])[0]);
ans = (await D.api(`/persons/${P.maya.id}/answers`)).json.answers;
prof = (await D.api(`/persons/${P.maya.id}`)).json;
check('Save answers: a talked contact, no rating, 3 answers', ans.length === 3 && prof.contacts[0].outcome === 'contacted' && prof.person.rating === null
  && ans.some((a) => a.says === 'Lawn sign, Phone calls') && ans.some((a) => a.says === 'More buses on 72 Ave'), ans.map((a) => a.says).join('|'));
await V.shot('06-walk-saved-phone');
// Rating Maya after "Save answers" finishes that same knock: one contact for the visit.
await vpage.click('.walk-panel button[aria-label="2: Lean support"]');
await sleep(900);
t = await V.text();
prof = (await D.api(`/persons/${P.maya.id}`)).json;
check('then a rating: "Rated 2" on the same knock — one contact, not two', /Rated 2/.test(t) && prof.contacts.length === 1
  && prof.contacts[0].rating === '2' && prof.person.rating === '2', JSON.stringify(prof.contacts.map((c) => [c.outcome, c.rating])));
check('…and its 3 answers are still on it', (await D.api(`/persons/${P.maya.id}/answers`)).json.answers.length === 3);

// No signal: the answers wait in the outbox with the knock and arrive once.
// (The rating may have moved the list on to this door already.)
if (!(await vpage.$('.walk-door.is-open:has-text("7120 124 St")'))) await vpage.click('.walk-door__head:has-text("7120 124 St")').catch(() => {});
await sleep(400);
if (!(await vpage.$('.walk-panel .sv-field.is-open'))) await vpage.click('.walk-panel .sv-field__btn');
await vctx.setOffline(true);
await sleep(300);
await vpage.click('.walk-panel .sv-opt:has-text("Safety")');
await vpage.click('.walk-panel button[aria-label="3: Undecided"]');
await sleep(700);
t = await V.text();
check('offline: the knock + answers say "Saved offline"', /saved offline/i.test(t), (t.match(/[^.]{0,30}offline[^.]{0,40}/i) || [''])[0]);
check('offline: nothing reached the server yet', (await D.api(`/persons/${P.tom.id}/answers`)).json.answers.length === 0);
await V.shot('07-walk-offline-phone');
await vctx.setOffline(false);
await vpage.evaluate(() => window.dispatchEvent(new Event('online')));
await sleep(2500);
ans = (await D.api(`/persons/${P.tom.id}/answers`)).json.answers;
prof = (await D.api(`/persons/${P.tom.id}`)).json;
check('back online: sent once — rating 3 and the Safety answer', ans.length === 1 && ans[0].says === 'Safety' && prof.person.rating === '3' && prof.contacts.length === 1, `${ans.length} ${prof.person.rating} ${prof.contacts.length}`);

// The map's door card on a phone (a bottom sheet): the same block, closed.
await V.go(`/map?person=${P.harjit.id}`);
await vpage.waitForSelector('aside.door-card .sv-field', { timeout: 8000 }).catch(() => {});
check('phone door card: "Questions · 5", closed', /Questions · 5/.test(await vpage.innerText('aside.door-card .sv-field__btn').catch(() => ''))
  && (await vpage.getAttribute('aside.door-card .sv-field__btn', 'aria-expanded')) === 'false');
await vpage.click('aside.door-card .sv-field__btn');
await vpage.click('aside.door-card .sv-opt:has-text("Transit")');
m = await measure(vpage, 'aside.door-card .sv-opt, aside.door-card .sv-q__input, aside.door-card .sv-field__btn, aside.door-card .sv-field__save');
check('phone door card: no sideways scroll, targets ≥ 48px, no yellow', m.overflow <= 0 && m.minTap >= 48 && m.yellow === 0, JSON.stringify(m));
await vpage.$eval('aside.door-card .sv-field__save', (el) => el.scrollIntoView({ block: 'end' })).catch(() => {});
await V.shot('07b-door-card-phone');
await vpage.click('aside.door-card .sv-opt:has-text("Transit")'); // untap: nothing left to save
check('untapping clears the draft (no Save answers)', !(await vpage.$('aside.door-card .sv-field__save')));

// Calls: the survey is "both", so it's asked on the phone too.
await V.go('/calls');
await vpage.waitForSelector('section.cl-card', { timeout: 8000 }).catch(() => {});
let current = await vpage.$eval('section.cl-card', (el) => el.getAttribute('aria-label')).catch(() => '');
for (let i = 0; i < 4 && current !== 'Grace Example'; i += 1) {
  await vpage.click('section.cl-card .cl-skip');
  await sleep(300);
  current = await vpage.$eval('section.cl-card', (el) => el.getAttribute('aria-label')).catch(() => '');
}
check('Calls: Grace is up', current === 'Grace Example', current);
await vpage.click('section.cl-card .sv-field__btn');
await vpage.click('section.cl-card .sv-q:has-text("Will you vote early?") .sv-opt:has-text("No")');
await V.shot('08-calls-questions-phone');
await vpage.click('section.cl-card button[aria-label="2: Lean support"]');
await sleep(900);
t = await V.text();
check('Calls toast: "Grace · Rated 2 · Lean yes · 1 answer"', /Grace · Rated 2 · Lean yes · 1 answer/.test(t), (t.match(/Grace ·[^✕]{0,60}/) || [''])[0]);
ans = (await D.api(`/persons/${P.grace.id}/answers`)).json.answers;
check('Calls: the answer rode along as a phone contact', ans.length === 1 && ans[0].says === 'No' && ans[0].channel === 'phone', JSON.stringify(ans[0] || {}));

// ── 6. Desk: results, See people, CSV ──
await D.go(`/surveys/${surveyId}/results`);
await page.waitForSelector('.sv-res', { timeout: 8000 }).catch(() => {});
const res = (await D.api(`/surveys/${surveyId}/results`)).json;
const big = await page.innerText('.sv-big').catch(() => '');
check('results: the big number is the server\'s', big.includes(String(res.survey.people)) && res.survey.people === 4, `${big} vs ${res.survey.people}`);
const first = res.questions.find((q) => q.text === 'What matters most to you?');
const shownBars = await page.$$eval('.sv-res[aria-label="What matters most to you?"] .sv-bar', (els) => els.map((e) => e.querySelector('.sv-bar__label').innerText + '=' + e.querySelector('.sv-bar__n').innerText));
const apiBars = first.options.map((o) => `${o.label}=${o.count} · ${o.pct}%`);
check('results: each bar\'s count and % are the server\'s', shownBars.join('|') === apiBars.join('|'), `${shownBars.join('|')} vs ${apiBars.join('|')}`);
check('results: Housing 1 · Transit 1 · Safety 1 of 3', apiBars.join('|') === 'Transit=1 · 33%|Housing=1 · 33%|Safety=1 · 33%', apiBars.join('|'));
await page.click('.sv-res[aria-label="What matters most to you?"] .sv-bar:has-text("Housing") .sv-bar__see');
const people = await page.$$eval('.sv-res[aria-label="What matters most to you?"] .sv-people a', (els) => els.map((e) => e.innerText));
check('See people names who said Housing', people.join() === 'Harjit Example', people.join());
const texts = await page.innerText('.sv-res[aria-label="Anything else?"]');
check('short answers listed', /More buses on 72 Ave/.test(texts) && /Maya Example/.test(texts));
check('results: the 1–5 question says "1 low · 5 high"', /1 low · 5 high/.test(await page.innerText('.sv-res[aria-label="How likely are you to vote?"]')));
m = await measure(page, '.sv-bar__see, .sv-people a');
check('results: "See people" and names ≥ 48px', m.minTap >= 48, JSON.stringify(m));
m = await measure(page);
check('results: no yellow button (nothing to start here)', m.yellow === 0, JSON.stringify(m));
await D.full('09-results-desktop');
const csv = await D.api(`/surveys/${surveyId}/results.csv`);
const lines = csv.raw.trim().split(/\r\n/);
check('CSV: a header + one row per person who answered', csv.status === 200 && lines.length === 1 + res.survey.people && /^Name,Phone,Email,Address,Last answer,What matters most to you\?/.test(lines[0]), `${lines.length} ${lines[0]}`);
await page.click('.ops-foot .ops-more');
const dl = await page.$('a[href$="/results.csv"]');
check('Download for a spreadsheet sits under More', !!dl);

// ── 7. Profile: Answers (desk), none for the volunteer ──
await D.go(`/people/${P.maya.id}`);
await page.click('.pf-sec__btn:has-text("Answers")');
t = await D.text();
const apiMaya = (await D.api(`/persons/${P.maya.id}/answers`)).json.answers;
const count = await page.innerText('.pf-sec__btn:has-text("Answers") .pf-sec__count').catch(() => '');
check('profile: Answers · 3 with each answer', count === String(apiMaya.length) && apiMaya.every((a) => t.includes(a.says)), `${count} vs ${apiMaya.length}`);
await D.shot('10-profile-answers');
await V.go(`/people/${P.maya.id}`);
check('volunteer profile: no Answers section', !(await vpage.$('.pf-sec__btn:has-text("Answers")')));
await vpage.waitForSelector('.pf-rate', { timeout: 8000 }).catch(() => {});
check('volunteer profile: Questions under the rating card', !!(await vpage.$('.pf-rate .sv-field')));
await V.shot('11-volunteer-profile-phone');

// ── 8. Phone measurements of the desk screens ──
const dphone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'America/Vancouver' });
await dphone.addCookies((await dctx.cookies()).map((c) => ({ ...c })));
const ppage = await dphone.newPage();
const PH = helpers(ppage, 'desk-phone');
for (const [path, name] of [['/surveys', '12-list-phone'], [`/surveys/${surveyId}`, '13-builder-phone'], [`/surveys/${surveyId}/results`, '14-results-phone']]) {
  await PH.go(path);
  const mm = await measure(ppage, '.btn, .ops-row, .sv-switch, .ops-seg button, .sv-kind, .disclose');
  check(`${path.replace(/[0-9a-f-]{36}/, ':id')} on a phone: ≤ 1 yellow, no sideways scroll, targets ≥ 44px`, mm.yellow <= 1 && mm.overflow <= 0 && mm.minTap >= 44, JSON.stringify(mm));
  console.log(`      words on ${path.replace(/[0-9a-f-]{36}/, ':id')}: ${mm.words}`);
  await PH.full(name);
}
await PH.go(`/surveys/${surveyId}`);
await ppage.click('.sv-qlist .ops-row:has-text("What matters most to you?")');
await sleep(300);
const mq = await measure(ppage, '.sv-qitem[data-open] .sv-kind, .sv-qitem[data-open] .input, .sv-qitem[data-open] .btn');
check('question editor on a phone: fields ≥ 48px, no sideways scroll', mq.minTap >= 48 && mq.overflow <= 0, JSON.stringify(mq));
check('a question with answers keeps its kind', /· can't change/.test(await ppage.innerText('.sv-qitem[data-open]')));
check('…and says why its words are fixed', (await ppage.innerText('.sv-qitem[data-open] .sv-locked__why')).trim() === "Has answers — words can't change");
check('…and its words: no box to retype them', !(await ppage.$('.sv-qitem[data-open] input[placeholder="What matters most to you?"]'))
  && /What matters most to you\?/.test(await ppage.innerText('.sv-qitem[data-open] .sv-locked')));
const firstQ = built.questions.find((q) => q.text === 'What matters most to you?');
const reword = await PH.api('/actions/survey.question.update', { id: firstQ.id, text: 'What worries you least?' });
check('the server refuses rewording an answered question', reword.status === 409 && /add a new question/.test(reword.json.error), reword.raw);
await PH.full('15-question-editor-phone');
check('one add button in the open question: "Copy as a new question"', !(await ppage.$('.sv-qitem[data-open] button:has-text("Add a new question")'))
  && !!(await ppage.$('.sv-qitem[data-open] button:has-text("Copy as a new question")')));
await ppage.click('.sv-qitem[data-open] button:has-text("Copy as a new question")');
await sleep(300);
const startVal = await ppage.inputValue('form[aria-label="Add question"] input[placeholder="What matters most to you?"]').catch(() => '');
check('"Copy as a new question" starts one from it (one yellow)', startVal === 'What matters most to you?' && (await measure(ppage)).yellow === 1, startVal);
await ppage.click('form[aria-label="Add question"] button:has-text("Cancel")');
await dphone.close();

// ── 9. Archive keeps answers; the field stops asking ──
await D.go(`/surveys/${surveyId}`);
await page.click('.ops-foot .ops-more');
await page.click('.sv-more button:has-text("Archive")');
check('archive asks in place', /Archive\? Answers are kept\./.test(await D.text()));
await page.click('.sv-more .ops-confirm button:has-text("Yes")');
await sleep(800);
s = (await D.api(`/surveys/${surveyId}`)).json.survey;
check('archived and off; answers kept', s.archived && !s.active && s.people === 4, JSON.stringify(s));
check('archived: "Bring back" is the one yellow button', /Bring back/i.test(await page.innerText('.btn-primary').catch(() => '')) && (await measure(page)).yellow === 1);
await D.go(`/map?person=${P.harjit.id}`);
await page.waitForSelector('aside.door-card', { timeout: 8000 }).catch(() => {});
await sleep(600);
check('door card asks nothing once archived', !(await page.$('aside.door-card .sv-field')));
await D.go('/surveys');
await page.click('button.ops-more:has-text("Archived")');
check('list: archived survey folds under "Archived · 1"', /Archived · 1/.test(await D.text()) && /Doorstep issues/.test(await D.text()));
await D.shot('16-list-archived');

// ── 9b. A question changed while a knock waited on the phone ──
const second = (await D.api('/actions/survey.create', { name: 'Second round', context: 'door' })).json.survey;
const pickQ = (await D.api('/actions/survey.question.add', { survey_id: second.id, kind: 'choice', text: 'Pick one', options: ['Housing', 'Transit'] })).json.question;
await D.api('/actions/survey.question.add', { survey_id: second.id, kind: 'choice', text: 'Keep one', options: ['Alpha', 'Beta'] });
await V.go(`/turfs/${turf.id}`);
await vpage.waitForSelector('.walk-door', { timeout: 8000 }).catch(() => {});
await vpage.click('.walk-door__head:has-text("12345 72 Ave")');
await sleep(400);
await vpage.click('.walk-panel .sv-field__btn');
const harjitBefore = (await D.api(`/persons/${P.harjit.id}`)).json.contacts.length;
await vctx.setOffline(true);
await sleep(300);
await vpage.click('.walk-panel .sv-q:has-text("Pick one") .sv-opt:has-text("Housing")');
await vpage.click('.walk-panel .sv-q:has-text("Keep one") .sv-opt:has-text("Alpha")');
await vpage.click('.walk-panel button[aria-label="2: Lean support"]');
await sleep(700);
check('offline knock with 2 answers: "Saved offline"', /saved offline/i.test(await V.text()));
const live = await D.api('/actions/survey.question.update', { id: pickQ.id, kind: 'scale' });
check('the desk cannot change a kind while the survey is asked', live.status === 409 && /Asking now/.test(live.json.error), live.raw);
await D.api('/actions/survey.update', { id: second.id, active: false });
const kindNow = await D.api('/actions/survey.question.update', { id: pickQ.id, kind: 'scale' });
await D.api('/actions/survey.update', { id: second.id, active: true });
check('…turned off, it can (nothing answered yet)', kindNow.status === 200 && kindNow.json.question.kind === 'scale', kindNow.raw);
await vctx.setOffline(false);
await vpage.evaluate(() => window.dispatchEvent(new Event('online')));
await sleep(2500);
prof = (await D.api(`/persons/${P.harjit.id}`)).json;
ans = (await D.api(`/persons/${P.harjit.id}/answers`)).json.answers;
check('replayed: the knock and its rating landed (not refused)', prof.contacts.length === harjitBefore + 1 && prof.person.rating === '2'
  && (await V.api('/surveys/active?context=door')).status === 200 && !(await vpage.$('.offline-strip .is-refused')), `${prof.contacts.length} ${prof.person.rating}`);
check('…with the answer that fits (Alpha), and not the one that does not (Housing)', ans.some((a) => a.says === 'Alpha') && !ans.some((a) => a.question_id === pickQ.id), ans.map((a) => a.says).join('|'));
const strip = await vpage.innerText('.offline-strip').catch(() => '');
check('the strip says which answer was not saved', /Harjit Example · 1 answer not saved — question changed/.test(strip), strip);
await V.shot('17-left-out-phone');
await vpage.click('.offline-strip button:has-text("Dismiss")');
await D.api('/actions/survey.archive', { id: second.id });

// ── 10. The books still verify ──
const v = (await D.api('/audit/verify')).json;
check('hash chain verifies after the whole journey', v.ok === true && v.checked > 30, JSON.stringify(v));
const evs = (await D.api('/events?limit=1000')).json.events;
check('answers are on the event log, written by the knock that carried them',
  evs.filter((e) => e.entity_type === 'survey_response').length === 9 && evs.filter((e) => e.entity_type === 'survey_response').every((e) => e.action === 'contact.log'),
  evs.filter((e) => e.entity_type === 'survey_response').length);
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
