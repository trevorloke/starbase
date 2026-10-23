// Receipts E2E — contribution receipts and the financial agent's exports.
//
// Part 1, email NOT connected (the server at BASE): a treasurer signs up,
// logs a gift on Money with the form and opens it — "Receipt 2026-0001 · Not
// sent", as the server has it. Money → More → Receipts lists every receipt
// (no yellow button while email is off, and it says so, with Connect); "Set
// up" opens the settings (financial agent, contact, footer; "Receipt gifts of
// at least ($)" shows its 0); a row says "Not sent — email
// isn't connected" and Print opens the receipt, which carries everything the
// server's copy does. Printing shows the receipt alone. The donor's own link
// (/r/<token>, no sign-in) shows that receipt and nothing else. Voiding the
// gift voids the receipt (number kept), Undo brings it back; a void receipt
// says VOID on the donor's page. A pledge from the donate page, marked paid,
// gets the next number. A donor with no home address: Log a gift asks for
// it under More details; left blank, the toast says "receipt needs address"
// and Money's Needs you lists it ("Needs address") until the address is
// saved right there. The disclosure (for a period, with an Over limit
// column) lists contributors over $100 and the register lists every
// receipt, each "Download for a spreadsheet". The new screens are measured
// on a phone.
// A volunteer on a 390×844 phone can reach none of it — screens, API, or the
// JSON their browser receives — and the books verify.
//
// Part 2, email connected through a stand-in provider: this script starts a
// second fresh in-memory server (MAIL_PORT) whose fetch to api.resend.com is
// answered locally and logged, never sent; its automatic email waits 4 s
// (STARBASE_RECEIPT_DELAY_S; a minute in real use). A gift to a donor with an
// email says "receipt emails in a minute" and is sent once by itself
// ("Sent"), with an idempotency key; Send again sends again; while one says
// Sending and another has no email there is no yellow button; a Not sent
// receipt with an email shows the one yellow "Email 1 receipt", which asks
// first and sends it. A gift undone right away never reaches the donor.
// Voiding a gift whose receipt went asks "Receipt already emailed — send a
// void notice?", and Yes sends it. What the screen says matches what the
// stand-in provider got.
//
//   STARBASE_OPEN_SIGNUP=1 STARBASE_DATA=memory PORT=4106 node server/index.js &
//   BASE=http://127.0.0.1:4106 SHOTS=/tmp/receipts node e2e-receipts.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3200';
const SHOTS = process.env.SHOTS || '/tmp/starbase-receipts';
const MAIL_PORT = Number(process.env.MAIL_PORT) || Number(new URL(BASE).port || 3200) + 50;
const MAIL_BASE = `http://127.0.0.1:${MAIL_PORT}`;
mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, extra = '') => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + String(extra).slice(0, 220) : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);
const NOTICE = 'Contributions to BC municipal election campaigns are not tax-deductible.';
const longDate = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });

const tileSvg = () => '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7e3d6"/></svg>';
const tiles = (ctx) => ctx.route(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/, (route) =>
  route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg() }));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const helpers = (page, who, base = BASE) => {
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
    go: async (path) => { await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' }); await sleep(900); },
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
const FIELDS = 'main.page input:not([type=checkbox]), main.page select, main.page textarea, main.page button, main.page a.btn, main.page a.rc-giftline';
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
    await sleep(400);
  }
};
const yellowCount = (page) => page.locator('main.page .btn-primary:visible').count();
const signup = async (page, base, { name, email, campaign }) => {
  await page.goto(`${base}/signup`, { waitUntil: 'domcontentloaded' });
  await page.fill('#su-name', name);
  await page.fill('#su-email', email);
  await page.fill('#su-password', 'surrey-forward-2026');
  await page.click('button[type="submit"]');
  await page.waitForURL(`${base}/`, { timeout: 15000 });
};
// Log a gift with Money's own form.
const logGiftOnScreen = async (page, H, { donor, amount, method }) => {
  await H.go('/money?new=1');
  await page.fill('#gift-donor', donor.split(' ')[0]);
  const opt = page.locator('#donor-options li', { hasText: donor });
  await opt.first().waitFor({ timeout: 8000 });
  await opt.first().dispatchEvent('mousedown');
  await page.fill('#gift-amount', String(amount));
  if (method) {
    await page.getByRole('button', { name: 'More details' }).click();
    await page.selectOption('#gift-method', method);
  }
  await page.getByRole('button', { name: 'Save gift' }).click();
  await page.locator('.toast', { hasText: `from ${donor}` }).waitFor({ timeout: 8000 }).catch(() => {});
};
const giftOf = async (H, personId) => (await H.api('/records/gift?limit=200')).json.records.find((g) => g.person_id === personId);

// ══ Part 1 — email not connected ══
const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
await tiles(desk);
const page = await desk.newPage();
const D = helpers(page, 'desk');
await signup(page, BASE, { name: 'Rae Treasurer', email: `treasurer.${tag}@example.org`, campaign: 'Imagine Surrey Receipts' });
const me = (await D.api('/auth/me')).json;
const slug = me.workspace.slug;
check('desk signed up', !!slug, slug);
const ana = (await D.api('/actions/person.create', {
  name: 'Ana Souza', email: `ana.${tag}@example.org`, phone: '604-555-0161', address: '12345 72 Ave', city: 'Surrey', postal: 'V3W 2M1',
})).json.person;
const ben = (await D.api('/actions/person.create', { name: 'Ben Okafor', address: '9 Fraser Hwy', city: 'Surrey' })).json.person;

// ── 1. Money: a gift logged with the form gets its receipt in the same step ──
await logGiftOnScreen(page, D, { donor: 'Ana Souza', amount: 150, method: 'etransfer' });
const giftA = await giftOf(D, ana.id);
check('gift logged from the form', giftA && Number(giftA.amount_cents) === 15000, JSON.stringify(giftA || {}).slice(0, 120));
const rA = (await D.api(`/receipts/gift/${giftA.id}`)).json.receipt;
const year = String(giftA.date).slice(0, 4);
check('it has receipt 0001 for its year', rA && rA.number === `${year}-0001`, rA?.number);
check('server: Not sent — email isn’t connected', rA?.status?.word === 'Not sent' && rA.status.line === 'Not sent — email isn’t connected', JSON.stringify(rA?.status));
await D.go('/money');
await page.locator('#gift-list .ops-row', { hasText: 'Ana Souza' }).click();
const line = (await page.locator('.rc-giftline').innerText({ timeout: 8000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
check('Money gift detail: "Receipt 2026-0001 · Not sent" as the server has it', line === `Receipt ${rA.number} · ${rA.status.word}`, line);
await simple(page, 'Money with a gift open (desktop)');
await D.shot('01-money-gift-receipt-line');

const giftB = (await D.api('/actions/gift.log', { person_id: ben.id, amount_cents: 5000, date: `${year}-10-20`, method: 'cash' })).json.gift;
const rB = (await D.api(`/receipts/gift/${giftB.id}`)).json.receipt;
check('second gift: next number, "No email on file"', rB.number === `${year}-0002` && rB.status.line === 'No email on file', `${rB.number} ${rB.status.line}`);

// ── 2. Money → More → Receipts ──
await page.getByRole('button', { name: 'More', exact: true }).click();
await D.shot('01b-money-more');
await page.getByRole('link', { name: 'Receipts' }).click();
await page.waitForURL(`${BASE}/money/receipts`, { timeout: 8000 }).catch(() => {});
await sleep(700);
let t = await D.text();
let L = (await D.api('/receipts')).json;
const rowTexts = (await page.locator('#rc-list > .ops-item').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim());
const wantRows = L.receipts.map((r) => `${r.donor_name} ${r.number} ${r.status.word} $${(r.amount_cents / 100).toFixed(2)}`);
check('list rows read as the server has them (donor, number, status, amount)', JSON.stringify(rowTexts.map((s) => s.toLowerCase())) === JSON.stringify(wantRows.map((s) => s.toLowerCase())), `${rowTexts.join(' | ')} vs ${wantRows.join(' | ')}`);
check('email off: says so, and no yellow "Send all"', /Email isn’t connected — print receipts instead\./.test(t) && (await yellowCount(page)) === 0 && L.emailConfigured === false, t.slice(0, 200));
check('financial agent not set: one line + Set up', /Financial agent not set/.test(t) && await page.getByRole('button', { name: 'Set up' }).isVisible());
const m1 = await simple(page, 'receipts list (desktop)');
console.log(`      words on /money/receipts: ${m1.words}`);
await D.shot('02-receipts-list');
const connect = page.locator('main.page .rc-line a', { hasText: 'Connect' });
check('email off: the line links to Connect (as Ladders and Outreach do)', (await connect.getAttribute('href').catch(() => null)) === '/outreach/website?connect=1');
await connect.click();
await page.waitForURL(`${BASE}/outreach/website?connect=1`, { timeout: 8000 }).catch(() => {});
await sleep(700);
check('Connect lands on Email & texting: "Email not connected"', /Email not connected/.test(await D.text()), page.url());
await D.go('/money/receipts');

// ── 3. Settings: financial agent, contact, footer ──
await page.getByRole('button', { name: 'Set up' }).click();
const thrLabel = (await page.locator('label[for="rc-threshold"]').innerText().catch(() => '')).trim();
const thrHint = (await page.locator('#rc-threshold-hint').innerText().catch(() => '')).trim();
check('settings: "Receipt gifts of at least ($)" shows the saved 0, helper "0 receipts every gift"',
  /^Receipt gifts of at least \(\$\)$/i.test(thrLabel) && (await page.inputValue('#rc-threshold')) === '0' && thrHint === '0 receipts every gift',
  `${thrLabel} | ${await page.inputValue('#rc-threshold')} | ${thrHint}`);
await page.fill('#rc-agent', 'Jordan Agent');
await page.fill('#rc-contact', `agent.${tag}@example.org · 604-555-0142`);
await page.fill('#rc-footer', 'Thank you for building a better Surrey.');
await page.getByRole('button', { name: 'More details' }).click();
check('settings: tax line and disclosure amount under More details, with the defaults', (await page.inputValue('#rc-notice')) === NOTICE && (await page.inputValue('#rc-disclosure')) === '100');
await simple(page, 'settings form (desktop)');
check('settings form: its one yellow is Save', (await yellowCount(page)) === 1 && await page.locator('main.page .btn-primary', { hasText: 'Save' }).isVisible());
await D.shot('03-settings');
await page.getByRole('button', { name: 'Save' }).click();
await sleep(800);
L = (await D.api('/receipts')).json;
t = await D.text();
check('saved on the server; the toast says so', L.settings.agent_name === 'Jordan Agent' && L.settings.footer === 'Thank you for building a better Surrey.' && /Settings saved/.test(await page.innerText('body')), JSON.stringify(L.settings).slice(0, 160));
check('"Financial agent not set" is gone', !/Financial agent not set/.test(t));

// ── 4. A row, then Print ──
await page.locator('#rc-list .ops-row', { hasText: 'Ana Souza' }).click();
const st = (await page.locator('.rc-status').innerText()).trim();
check('row opens on what happened: "Not sent — email isn’t connected"', st === rA.status.line, st);
check('no Send while email is off', !(await page.locator('#rc-list').getByRole('button', { name: /^Send/ }).count()));
await page.locator('#rc-list').getByRole('link', { name: 'Print' }).click();
await page.waitForURL(`${BASE}/money/receipts/${rA.id}`, { timeout: 8000 }).catch(() => {});
await sleep(800);
const one = (await D.api(`/receipts/${rA.id}`)).json;
t = await D.text();
const wantDoc = [
  'Imagine Surrey Receipts', 'Contribution receipt', rA.number, 'Ana Souza', '12345 72 Ave, Surrey, V3W 2M1', '$150.00',
  longDate(one.doc.received_on), 'E-transfer', `Financial agent: Jordan Agent · agent.${tag}@example.org · 604-555-0142`, NOTICE,
  'Thank you for building a better Surrey.',
];
const missing = wantDoc.filter((w) => !t.includes(w));
check('the receipt carries campaign, agent, donor, address, amount, date, method, number, tax line, footer', missing.length === 0, missing.join(' | '));
check('the screen’s copy matches the server’s', one.doc.contributor === 'Ana Souza' && one.doc.address === '12345 72 Ave, Surrey, V3W 2M1' && one.doc.amount_cents === 15000 && one.doc.method === 'etransfer');
check('status line says it was not sent', t.includes(one.receipt.status.line) && one.receipt.status.line === 'Not sent — email isn’t connected');
check('one yellow: Print; no Send while email is off', (await yellowCount(page)) === 1 && await page.locator('main.page .btn-primary', { hasText: 'Print' }).isVisible()
  && !(await page.getByRole('button', { name: /^Send/ }).count()));
const m2 = await simple(page, 'one receipt (desktop)');
console.log(`      words on /money/receipts/:id: ${m2.words}`);
await D.shot('04-receipt');
await page.emulateMedia({ media: 'print' });
const printed = await page.evaluate(() => {
  const shown = (sel) => { const el = document.querySelector(sel); return !!el && el.getClientRects().length > 0; };
  return { nav: shown('.nav'), tabs: shown('.tabbar'), back: shown('.ops-back'), print: shown('main.page .btn-primary'), more: shown('main.page .disclose'), doc: shown('.rc-doc') };
});
check('printing shows the receipt alone', !printed.nav && !printed.tabs && !printed.back && !printed.print && !printed.more && printed.doc, JSON.stringify(printed));
await D.shot('05-receipt-print');
await page.emulateMedia({ media: 'screen' });
await page.getByRole('button', { name: 'More', exact: true }).click();
check('More: the donor’s link (Copy · Open) and Donor', await page.getByRole('button', { name: 'Copy link' }).isVisible() && await page.getByRole('link', { name: 'Donor', exact: true }).isVisible());

// ── 5. The donor's own link: that receipt and nothing else ──
const visitor = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const vp = await visitor.newPage();
vp.on('pageerror', (e) => errors.push(`[visitor] ${e.message}`));
const donorUrl = one.link.replace(/^https?:\/\/[^/]+/, BASE);
check('donor link is /r/<long random token>', /\/r\/[0-9a-f]{48}$/.test(donorUrl), donorUrl);
const resp = await vp.goto(donorUrl, { waitUntil: 'domcontentloaded' });
let vt = (await vp.innerText('body')).replace(/\s+/g, ' ');
check('donor page: that receipt', resp.status() === 200 && [rA.number, 'Ana Souza', '$150.00', NOTICE, 'Jordan Agent'].every((w) => vt.includes(w)), vt.slice(0, 200));
check('donor page: nothing else (no other donor, no email, no phone)', !['Ben Okafor', '$50.00', `ana.${tag}@example.org`, '604-555-0161', 'Starbase'].some((w) => vt.includes(w)));
check('donor page: never cached, never indexed', resp.headers()['cache-control'] === 'no-store' && /noindex/.test(resp.headers()['x-robots-tag'] || ''));
const vOverflow = await vp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('donor page: no sideways scroll at 390px', vOverflow <= 0, vOverflow);
await vp.screenshot({ path: `${SHOTS}/06-donor-page.png`, fullPage: true });

// ── 6. Void → VOID (number kept); Undo → back ──
await D.go('/money');
await page.locator('#gift-list .ops-row', { hasText: 'Ana Souza' }).click();
await page.locator('#gift-list').getByRole('button', { name: 'Void' }).click();
await page.getByRole('group', { name: 'Void this gift' }).getByRole('button', { name: 'Yes' }).click();
await page.locator('.toast', { hasText: 'Gift voided' }).waitFor({ timeout: 8000 }).catch(() => {});
let vr = (await D.api(`/receipts/${rA.id}`)).json.receipt;
check('void the gift → its receipt is void, number kept', vr.void === true && vr.number === rA.number && vr.status.word === 'Void', JSON.stringify(vr.status));
await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
await sleep(900);
vr = (await D.api(`/receipts/${rA.id}`)).json.receipt;
check('Undo → the receipt is back, same number', vr.void === false && vr.number === rA.number && vr.status.word === 'Not sent');
await D.api('/actions/gift.void', { id: giftB.id });
await D.go('/money/receipts');
const benRow = (await page.locator('#rc-list > .ops-item', { hasText: 'Ben Okafor' }).innerText()).replace(/\s+/g, ' ');
check('list: Ben’s receipt says Void', /Ben Okafor .*-0002 Void/i.test(benRow), benRow);
const benDoc = (await D.api(`/receipts/${rB.id}`)).json;
await vp.goto(benDoc.link.replace(/^https?:\/\/[^/]+/, BASE), { waitUntil: 'domcontentloaded' });
vt = (await vp.innerText('body')).replace(/\s+/g, ' ');
check('donor page of a void receipt says VOID', /VOID/.test(vt) && vt.includes(rB.number), vt.slice(0, 120));

// ── 7. A pledge from the donate page, marked paid, gets the next number ──
await vp.goto(`${BASE}/d/${slug}`, { waitUntil: 'domcontentloaded' });
await vp.fill('#other', '75');
await vp.fill('#name', 'Cara Pledge');
await vp.fill('#email', `cara.${tag}@example.org`);
await vp.fill('#address', '77 Pledge Way, Surrey');
for (const box of await vp.locator('input[name^="attest_"]').all()) await box.check();
await vp.click('button[type="submit"]');
await sleep(900);
check('visitor pledged', /thank/i.test(await vp.innerText('body')));
await D.go('/money');
const pledgeRow = page.locator('.ops-needs .ops-item', { hasText: 'Cara Pledge' });
await pledgeRow.getByRole('button', { name: 'Mark paid' }).click();
await pledgeRow.getByRole('button', { name: /^Mark \$75 paid$/ }).click();
await page.locator('.toast', { hasText: 'Cara Pledge' }).waitFor({ timeout: 8000 }).catch(() => {});
const cara = (await D.api(`/persons?q=${encodeURIComponent('Cara Pledge')}`)).json.persons[0];
const giftC = await giftOf(D, cara.id);
const rC = giftC ? (await D.api(`/receipts/gift/${giftC.id}`)).json.receipt : null;
const docC = rC ? (await D.api(`/receipts/${rC.id}`)).json.doc : null;
check('pledge marked paid → receipt 0003 with the home address from the donate page', rC?.number === `${year}-0003` && rC.amount_cents === 7500 && docC?.address === '77 Pledge Way, Surrey', `${rC?.number} ${docC?.address}`);

// ── 7b. No home address: asked in the form, flagged in Needs you ──
const dev = (await D.api('/actions/person.create', { name: 'Dev Noaddress', city: 'Surrey' })).json.person;
const eli = (await D.api('/actions/person.create', { name: 'Eli Typed' })).json.person;
await D.go('/money?new=1');
await page.fill('#gift-donor', 'Dev');
await page.locator('#donor-options li', { hasText: 'Dev Noaddress' }).first().waitFor({ timeout: 8000 });
await page.locator('#donor-options li', { hasText: 'Dev Noaddress' }).first().dispatchEvent('mousedown');
await page.fill('#gift-amount', '30');
check('Log a gift: no Street address field on the first look', !(await page.locator('#gift-address').isVisible()));
await page.getByRole('button', { name: 'More details' }).click();
check('Log a gift: a donor with no address → "Street address" under More details', await page.locator('#gift-address').isVisible());
await simple(page, 'Log a gift with the address field (desktop)');
await D.shot('06b-gift-form-address');
await page.getByRole('button', { name: 'Save gift' }).click();
const devToast = await page.locator('.toast', { hasText: 'from Dev Noaddress' }).innerText({ timeout: 8000 }).catch(() => '');
check('the toast says the receipt needs an address', /✓ \$30 from Dev Noaddress · receipt needs address/.test(devToast.replace(/\s+/g, ' ')), devToast);
const giftD = await giftOf(D, dev.id);
let rD = (await D.api(`/receipts/gift/${giftD.id}`)).json.receipt;
check('server: "Needs address" — "Waiting — needs address" (a city alone is no address)', rD.needs_address === true && rD.status.word === 'Needs address' && rD.status.line === 'Waiting — needs address', JSON.stringify(rD.status));
await D.go('/money');
const devRow = page.locator('.ops-needs .ops-item', { hasText: 'Dev Noaddress' });
await devRow.waitFor({ timeout: 8000 }).catch(() => {});
check('Money → Needs you: Dev’s receipt with a "Needs address" chip', /Needs address/i.test(await devRow.locator('.chip').innerText().catch(() => '')));
await devRow.locator('.ops-row').click();
await simple(page, 'Money → Needs you, address row open (desktop)');
await D.shot('06c-money-needs-address');
await devRow.getByLabel('Street address').fill('42 Late St');
await devRow.getByRole('button', { name: 'Save address' }).click();
await page.locator('.toast', { hasText: 'Address saved' }).waitFor({ timeout: 8000 }).catch(() => {});
await sleep(700);
rD = (await D.api(`/receipts/gift/${giftD.id}`)).json.receipt;
const docD = (await D.api(`/receipts/${rD.id}`)).json.doc;
check('saved: the receipt has the address and leaves Needs you', docD.address === '42 Late St, Surrey' && rD.needs_address === false
  && !(await page.locator('.ops-needs .ops-item', { hasText: 'Dev Noaddress' }).count()), `${docD.address} ${rD.status.line}`);
// The address typed in the form goes on the donor's record and the receipt.
await D.go('/money?new=1');
await page.fill('#gift-donor', 'Eli');
await page.locator('#donor-options li', { hasText: 'Eli Typed' }).first().waitFor({ timeout: 8000 });
await page.locator('#donor-options li', { hasText: 'Eli Typed' }).first().dispatchEvent('mousedown');
await page.fill('#gift-amount', '20');
await page.getByRole('button', { name: 'More details' }).click();
await page.fill('#gift-address', '7 Typed Ave');
await page.getByRole('button', { name: 'Save gift' }).click();
await page.locator('.toast', { hasText: 'from Eli Typed' }).waitFor({ timeout: 8000 }).catch(() => {});
const giftE = await giftOf(D, eli.id);
const rEli = giftE ? (await D.api(`/receipts/gift/${giftE.id}`)).json.receipt : null;
const eliDoc = rEli ? (await D.api(`/receipts/${rEli.id}`)).json.doc : null;
const eliP = (await D.api(`/persons/${eli.id}`)).json.person;
check('typed in the form: on the donor and on the receipt', eliP.address === '7 Typed Ave' && eliDoc?.address === '7 Typed Ave' && rEli.needs_address === false, `${eliP.address} ${eliDoc?.address}`);

// ── 8. Disclosure (over $100) and the register ──
await D.go('/money/receipts');
await page.getByRole('button', { name: 'More', exact: true }).click();
const disGroup = page.getByRole('group', { name: 'Disclosure (over $100)' });
check('More: Settings · Disclosure (over $100) · All receipts — "Download for a spreadsheet", no "CSV"', await page.getByRole('button', { name: 'Settings' }).isVisible()
  && await disGroup.locator('a[href^="/api/receipts/disclosure.csv"]', { hasText: 'Download for a spreadsheet' }).isVisible()
  && await page.getByRole('group', { name: 'All receipts' }).locator('a[href="/api/receipts/register.csv"]', { hasText: 'Download for a spreadsheet' }).isVisible()
  && !/CSV/.test(await page.locator('#rc-more-body').innerText()));
const periods = await disGroup.locator('select option').allInnerTexts();
check('the disclosure has a period: this campaign first, then calendar years', /^This campaign · Jan 1 – Dec 31$/.test(periods[0] || '') && periods.includes(year), periods.join(' | '));
check('the download link carries the period', (await disGroup.locator('a').getAttribute('href')) === '/api/receipts/disclosure.csv?period=campaign');
await simple(page, 'receipts More (desktop)');
await D.shot('07-receipts-more');
const dis = (await D.api('/receipts/disclosure.csv?period=campaign')).raw.trim().split('\r\n');
check('disclosure: the period first, then Ana ($150, not over the limit) only — Cara $75, Ben (void), Dev $30 are not over $100',
  dis.length === 3 && new RegExp(`^Period,This campaign,${year}-01-01 to ${year}-12-31$`).test(dis[0])
  && dis[1] === 'Contributor,Home address,Contributor total,Over limit,Date received,Amount,Receipt'
  && /^Ana Souza,"12345 72 Ave, Surrey, V3W 2M1",150\.00,No,\d{4}-\d{2}-\d{2},150\.00,\d{4}-0001$/.test(dis[2]), dis.join(' | '));
const reg = (await D.api('/receipts/register.csv')).raw.trim().split('\r\n');
check('register: every receipt in number order, Ben’s Void', reg.length === 6 && reg[1].startsWith(`${year}-0001,Not sent`) && reg[2].startsWith(`${year}-0002,Void`)
  && reg[3].startsWith(`${year}-0003,`) && reg[4].startsWith(`${year}-0004,`) && reg[5].startsWith(`${year}-0005,`), reg.join(' | '));

// ── 9. The new screens on a phone (desk) ──
await page.setViewportSize({ width: 390, height: 844 });
for (const [path, name, shot] of [
  ['/money/receipts', 'receipts list (phone)', '08-receipts-phone'],
  [`/money/receipts/${rA.id}`, 'one receipt (phone)', '09-receipt-phone'],
  ['/money/receipts?settings=1', 'settings (phone)', '10-settings-phone'],
]) {
  await D.go(path);
  const m = await simple(page, name);
  console.log(`      words on ${path} (phone): ${m.words}`);
  await D.full(shot);
}
await D.go('/money/receipts');
await page.getByRole('button', { name: 'More', exact: true }).click();
await simple(page, 'receipts More: period + downloads (phone)');
await D.full('10b-receipts-more-phone');
await D.go('/money');
// The ledger opens on the latest three; Ana's is one tap away under "All gifts".
if (!(await page.locator('#gift-list .ops-row', { hasText: 'Ana Souza' }).count())) await page.getByRole('button', { name: /^All gifts/ }).click();
await page.locator('#gift-list .ops-row', { hasText: 'Ana Souza' }).click();
await page.locator('.rc-giftline').waitFor({ timeout: 8000 }).catch(() => {});
await simple(page, 'Money with a gift open (phone)');
await D.shot('11-money-gift-phone');
await page.locator('.rc-giftline').click();
await page.waitForURL(`${BASE}/money/receipts/${rA.id}`, { timeout: 8000 }).catch(() => {});
check('the gift’s receipt line opens that receipt', new URL(page.url()).pathname === `/money/receipts/${rA.id}`, page.url());
await page.setViewportSize({ width: 1360, height: 900 });

// ── 10. A volunteer on a phone: none of it ──
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
for (const path of ['/money/receipts', `/money/receipts/${rA.id}`, '/money/receipts?settings=1']) {
  await V.go(path);
  check(`volunteer typing ${path} lands on Today`, new URL(vol.url()).pathname === '/', vol.url());
}
for (const path of ['/receipts', '/receipts/needs', `/receipts/${rA.id}`, `/receipts/gift/${giftA.id}`, '/receipts/disclosure.csv', '/receipts/register.csv']) {
  const res = await V.api(path);
  check(`volunteer API ${path} → 403, nothing in it`, res.status === 403 && !/Ana|Souza|-0001|150/.test(res.raw), `${res.status} ${res.raw.slice(0, 80)}`);
}
check('volunteer cannot send or change settings', (await V.api('/actions/receipt.sendAll', {})).status === 403
  && (await V.api('/actions/receipt.send', { id: rA.id })).status === 403
  && (await V.api('/actions/receipt.sendVoid', { id: rB.id })).status === 403
  && (await V.api('/actions/receipt.settings', { threshold_cents: 100 })).status === 403);
const vprof = await V.api(`/persons/${ana.id}`);
check('volunteer’s profile JSON: no receipt, no money, no email', vprof.status === 200 && !vprof.raw.includes(rA.number) && !/receipt|amount_cents/i.test(vprof.raw)
  && vprof.json.gifts.length === 0 && vprof.json.donor === null && vprof.json.person.email === null, vprof.raw.slice(0, 160));
await V.go('/');
const vOver = await vol.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const vToday = (await V.text()).replaceAll('Imagine Surrey Receipts', ''); // the campaign's own name
check('volunteer Today: no receipts, no money, no sideways scroll', !/receipt|\$/i.test(vToday) && vOver <= 0, `${vOver} ${vToday.slice(0, 200)}`);
await V.shot('12-volunteer-today');
await vctx.close();
await visitor.close();

// ── 11. The books verify ──
let v = (await D.api('/audit/verify')).json;
check('hash chain verifies (receipts included)', v.ok === true && v.checked > 10, JSON.stringify(v));
let ev = (await D.api('/events?since=0&limit=1000')).json.events;
check('receipts are on the chain with their gifts', ['gift.log', 'gift.void', 'gift.restore', 'pledge.receive', 'receipt.settings'].every((a) => ev.some((e) => e.action === a && (e.entity_type === 'receipt' || e.entity_type === 'receipt_settings'))));
check('the donor link never enters the log', !ev.some((e) => JSON.stringify(e).includes(one.link.split('/r/')[1])));
await desk.close();

// ══ Part 2 — email connected (stand-in provider, second fresh server) ══
const STUB = `
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    const m = JSON.parse(init.body);
    console.log('RESEND_STUB ' + JSON.stringify({ to: m.to, subject: m.subject, text: m.text, key: init.headers['Idempotency-Key'] || null }));
    return new Response(JSON.stringify({ id: 'stub' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return real(url, init);
};`;
const outbox = [];
const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(STUB)}`, fileURLToPath(new URL('./server/index.js', import.meta.url))], {
  env: { ...process.env, STARBASE_OPEN_SIGNUP: '1', STARBASE_DATA: 'memory', PORT: String(MAIL_PORT), RESEND_API_KEY: 'e2e-stand-in', MAIL_FROM: 'receipts@example.org', STARBASE_JOBS_EVERY_MS: '1000', STARBASE_RECEIPT_DELAY_S: '4', STARBASE_PUBLIC_URL: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const ln = buf.slice(0, i); buf = buf.slice(i + 1);
    if (ln.startsWith('RESEND_STUB ')) outbox.push(JSON.parse(ln.slice(12)));
  }
});
const up = await until(async () => fetch(`${MAIL_BASE}/api/health`).then((r) => r.ok).catch(() => false), 15000);
check('second server (email connected, stand-in provider) is up', !!up, MAIL_BASE);
try {
  const desk2 = await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'America/Vancouver' });
  await tiles(desk2);
  const p2 = await desk2.newPage();
  const M = helpers(p2, 'desk-mail', MAIL_BASE);
  await signup(p2, MAIL_BASE, { name: 'Mo Manager', email: `manager.${tag}@example.org`, campaign: 'Imagine Surrey Mail' });
  await M.api('/actions/receipt.settings', { agent_name: 'Jordan Agent', agent_contact: `agent.${tag}@example.org` });
  const erin = (await M.api('/actions/person.create', { name: 'Erin Email', email: `erin.${tag}@example.org`, address: '5 Mail Rd', city: 'Surrey' })).json.person;
  await logGiftOnScreen(p2, M, { donor: 'Erin Email', amount: 120 });
  const erinToast = (await p2.locator('.toast').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('the toast says the receipt is going: "✓ $120 from Erin Email · receipt emails in a minute · Undo"',
    /✓ \$120 from Erin Email · receipt emails in a minute/.test(erinToast) && /Undo/i.test(erinToast), erinToast);
  await M.shot('12b-toast-receipt-emails');
  const gE = await giftOf(M, erin.id);
  const rE0 = (await M.api(`/receipts/gift/${gE.id}`)).json.receipt;
  check('connected: a fresh receipt says Sending (or Sent), never Sent before it is', ['Sending', 'Sent'].includes(rE0.status.word) && (rE0.status.word === 'Sent') === (outbox.length === 1), `${rE0.status.word} outbox=${outbox.length}`);
  const sentE = await until(async () => {
    const r = (await M.api(`/receipts/gift/${gE.id}`)).json.receipt;
    return r.status.word === 'Sent' ? r : null;
  });
  check('it was sent once by itself, to the donor, with the receipt in it', sentE && outbox.length === 1 && outbox[0].to[0] === `erin.${tag}@example.org`
    && outbox[0].subject === `Your receipt ${sentE.number} from Imagine Surrey Mail` && outbox[0].text.includes(NOTICE) && outbox[0].text.includes('Amount: $120.00')
    && outbox[0].key === `receipt-${sentE.id}-1`,
  JSON.stringify(outbox[0] || {}).slice(0, 200));
  await M.go('/money/receipts');
  let t2 = await M.text();
  check('list: Erin’s row says Sent', /Erin Email .*-0001 Sent \$120\.00/i.test(t2), t2.slice(0, 200));
  check('nothing waiting → no yellow Send all', (await yellowCount(p2)) === 0);
  await sleep(2500);
  check('never twice by itself', outbox.length === 1, outbox.length);

  await p2.locator('#rc-list .ops-row', { hasText: 'Erin Email' }).click();
  await p2.locator('#rc-list').getByRole('link', { name: 'Print' }).click();
  await p2.waitForURL(`${MAIL_BASE}/money/receipts/${sentE.id}`, { timeout: 8000 }).catch(() => {});
  await sleep(700);
  t2 = await M.text();
  check('receipt page: "Sent <date>" and Send again', /Sent [A-Z][a-z]+ \d{1,2}, \d{4}/.test(t2) && await p2.getByRole('button', { name: 'Send again' }).isVisible(), t2.slice(0, 160));
  await p2.getByRole('button', { name: 'Send again' }).click();
  await p2.locator('.toast', { hasText: 'Sent to Erin Email' }).waitFor({ timeout: 8000 }).catch(() => {});
  const again = (await M.api(`/receipts/${sentE.id}`)).json.receipt;
  check('Send again → the provider got a second one; the server counts 2', outbox.length === 2 && again.sent_count === 2 && /Sent to Erin Email/.test(await p2.innerText('body')), `${outbox.length} ${again.sent_count}`);
  await simple(p2, 'one receipt, email connected (desktop)');
  await M.shot('13-receipt-sent');

  // Right after a gift from a donor with an email (Sending), with another
  // donor's receipt Not sent for want of an email: no yellow button — the one
  // Sending goes by itself, the other can't go.
  const cy = (await M.api('/actions/person.create', { name: 'Cy Later', address: '3 Later St', city: 'Surrey' })).json.person;
  const gCy = (await M.api('/actions/gift.log', { person_id: cy.id, amount_cents: 4000, date: String(gE.date).slice(0, 10), method: 'cheque' })).json.gift;
  let rCy = (await M.api(`/receipts/gift/${gCy.id}`)).json.receipt;
  check('no email yet: "No email on file"', rCy.status.line === 'No email on file', rCy.status.line);
  const sal = (await M.api('/actions/person.create', { name: 'Sal Soon', email: `sal.${tag}@example.org`, address: '8 Soon St', city: 'Surrey' })).json.person;
  const gSal = (await M.api('/actions/gift.log', { person_id: sal.id, amount_cents: 2500, date: String(gE.date).slice(0, 10), method: 'cash' })).json.gift;
  await M.go('/money/receipts');
  const salRow = (await p2.locator('#rc-list .ops-row', { hasText: 'Sal Soon' }).innerText().catch(() => '')).replace(/\s+/g, ' ');
  const cyRow = (await p2.locator('#rc-list .ops-row', { hasText: 'Cy Later' }).innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('one Sending, one Not sent with no email → no yellow button', /Sending/i.test(salRow) && /Not sent/i.test(cyRow) && (await yellowCount(p2)) === 0, `${salRow} | ${cyRow}`);
  await M.shot('13b-receipts-sending-no-button');
  const salSent = await until(async () => ((await M.api(`/receipts/gift/${gSal.id}`)).json.receipt.status.word === 'Sent'));
  check('the Sending one went by itself, once', salSent && outbox.filter((m) => m.to[0] === `sal.${tag}@example.org`).length === 1, outbox.length);
  const beforeCy = outbox.length;

  // A Not sent receipt with an email: the one yellow "Email 1 receipt".
  await M.api('/actions/person.update', { id: cy.id, email: `cy.${tag}@example.org` });
  rCy = (await M.api(`/receipts/gift/${gCy.id}`)).json.receipt;
  check('email added: "Not sent"', rCy.status.word === 'Not sent' && rCy.status.line === 'Not sent', rCy.status.line);
  await M.go('/money/receipts');
  check('one yellow: "Email 1 receipt"', (await yellowCount(p2)) === 1 && await p2.getByRole('button', { name: 'Email 1 receipt', exact: true }).isVisible());
  const m3 = await simple(p2, 'receipts list with Send all (desktop)');
  console.log(`      words on /money/receipts (connected): ${m3.words}`);
  await M.shot('14-receipts-send-all');
  await p2.getByRole('button', { name: 'Email 1 receipt', exact: true }).click();
  const ask = (await p2.locator('.rc-confirm').innerText()).replace(/\s+/g, ' ').trim();
  check('asks in place: "Email 1 receipt? Yes · No"', /^Email 1 receipt\? Yes No$/i.test(ask), ask);
  await p2.locator('.rc-confirm').getByRole('button', { name: 'Yes' }).click();
  await p2.locator('.toast', { hasText: 'Sent 1' }).waitFor({ timeout: 8000 }).catch(() => {});
  rCy = (await M.api(`/receipts/gift/${gCy.id}`)).json.receipt;
  check('Yes → Cy’s receipt went (provider and server agree)', outbox.length === beforeCy + 1 && outbox[beforeCy].to[0] === `cy.${tag}@example.org` && rCy.status.word === 'Sent' && /✓ Sent 1/.test(await p2.innerText('body')), `${outbox.length} ${rCy.status.word}`);
  await sleep(600);
  check('nothing left to send → the yellow button is gone', (await yellowCount(p2)) === 0);
  await p2.setViewportSize({ width: 390, height: 844 });
  await M.go(`/money/receipts/${sentE.id}`);
  await simple(p2, 'one receipt, email connected (phone)');
  await M.full('15-receipt-sent-phone');
  await p2.setViewportSize({ width: 1360, height: 900 });

  // A gift undone at once: its receipt email never goes.
  await M.api('/actions/person.create', { name: 'Una Undo', email: `una.${tag}@example.org`, address: '11 Undo Ln', city: 'Surrey' });
  await logGiftOnScreen(p2, M, { donor: 'Una Undo', amount: 45 });
  await p2.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await p2.locator('.toast', { hasText: 'Gift voided' }).waitFor({ timeout: 8000 }).catch(() => {});
  await sleep(7000);
  check('Undo inside the minute → nothing reached the donor, and no void notice is asked', !outbox.some((m) => m.to[0] === `una.${tag}@example.org`)
    && !(await p2.getByRole('group', { name: 'Send a void notice' }).count()), `outbox=${outbox.length}`);

  // Erin's receipt went: voiding her gift asks to send a void notice.
  const before = outbox.length;
  await M.go('/money');
  await p2.locator('#gift-list .ops-row', { hasText: 'Erin Email' }).click();
  await p2.locator('#gift-list').getByRole('button', { name: 'Void' }).click();
  await p2.getByRole('group', { name: 'Void this gift' }).getByRole('button', { name: 'Yes' }).click();
  const askEl = p2.getByRole('group', { name: 'Send a void notice' });
  await askEl.waitFor({ timeout: 8000 }).catch(() => {});
  check('void a gift whose receipt was emailed → "Receipt already emailed — send a void notice? Yes · No"',
    /^Receipt already emailed — send a void notice\? Yes No$/i.test((await askEl.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()));
  await simple(p2, 'Money with the void-notice ask (desktop)');
  await M.shot('16-void-notice-ask');
  await askEl.getByRole('button', { name: 'Yes' }).click();
  await p2.locator('.toast', { hasText: 'Void notice sent' }).waitFor({ timeout: 8000 }).catch(() => {});
  const vn = outbox[before];
  const vr = (await M.api(`/receipts/${sentE.id}`)).json.receipt;
  check('Yes → the donor got "Receipt … is void"; the receipt says so', outbox.length === before + 1 && vn?.to[0] === `erin.${tag}@example.org`
    && vn.subject === `Receipt ${sentE.number} from Imagine Surrey Mail is void` && /was voided/.test(vn.text)
    && /^Void — void notice sent /.test(vr.status.line) && /✓ Void notice sent to Erin Email/.test(await p2.innerText('body')), `${outbox.length} ${vr.status.line}`);
  v = (await M.api('/audit/verify')).json;
  ev = (await M.api('/events?since=0&limit=1000')).json.events;
  check('second server: chain verifies; the automatic send is on it as the system', v.ok === true && ev.some((e) => e.action === 'receipt.autosend' && e.actor_id === null && e.entity_type === 'receipt'), JSON.stringify(v));
  await desk2.close();
} finally {
  child.kill('SIGTERM');
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const fails = results.filter((x) => !x).length;
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails ? 1 : 0);
