// A/B subject lines with open and click tracking (server/ext/abtests):
// per-recipient tokens, the HTML part's pixel and tracked links, the click
// redirect that only goes where the send said, the untracked unsubscribe
// link, A/B group sizes, the winner job, and the not-connected path. Also:
// the winner job never emails anyone twice when a write fails mid-send, never
// holds the campaign lock while it sends, and gives up on a hung provider;
// opens and clicks are written without the lock and logged by a job; a tie
// says so; clicks from mail scanners aren't counted.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runDueJobs } from '../lib/jobs.js';

const tag = Math.random().toString(36).slice(2, 8);
let db;

before(async () => {
  db = await freshDb();
});

// Stand in for the email provider: RESEND_API_KEY set and fetch answered
// here, both restored after. `fail` picks addresses the provider rejects;
// `delay` (ms) slows each answer; `hang` picks addresses it never answers
// (until the request gives up). Like Resend, a repeated Idempotency-Key is
// answered but not sent again (`dropped` counts those).
const withEmail = async (fn, { fail = () => false, delay = 0, hang = () => false } = {}) => {
  const sent = [];
  const keys = new Set();
  sent.dropped = 0;
  const realFetch = globalThis.fetch;
  const hadKey = Object.hasOwn(process.env, 'RESEND_API_KEY');
  const oldKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      const msg = JSON.parse(init.body);
      if (hang(msg.to[0])) {
        // (AbortSignal.timeout doesn't keep the test process alive; this does.)
        const alive = setTimeout(() => {}, 10_000);
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => { clearTimeout(alive); reject(init.signal.reason); }));
      }
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (fail(msg.to[0], msg)) return new Response('mailbox unavailable', { status: 500 });
      const key = init.headers['Idempotency-Key'];
      msg.key = key;
      if (key && keys.has(key)) { sent.dropped += 1; return new Response(JSON.stringify({ id: 'msg' }), { status: 200 }); }
      if (key) keys.add(key);
      sent.push(msg);
      return new Response(JSON.stringify({ id: 'msg' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = realFetch;
    if (hadKey) process.env.RESEND_API_KEY = oldKey; else delete process.env.RESEND_API_KEY;
  }
};

// No provider, and fetch must not be called at all.
const withoutEmail = async (fn) => {
  const realFetch = globalThis.fetch;
  const hadKey = Object.hasOwn(process.env, 'RESEND_API_KEY');
  const oldKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) calls += 1;
    return realFetch(url, init);
  };
  try {
    return await fn(() => calls);
  } finally {
    globalThis.fetch = realFetch;
    if (hadKey) process.env.RESEND_API_KEY = oldKey;
  }
};

// A reader's browser (a click from a mail scanner isn't counted).
const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const pub = (path, ua = BROWSER) => app.request(path, { redirect: 'manual', headers: ua ? { 'user-agent': ua } : {} });
// A click within 15 seconds of the email going out is a scanner's: age a send.
const aged = (blastId) => db.query(`update blast_recipients set sent_at = sent_at - interval '1 minute' where blast_id = $1 and sent_at is not null`, [blastId]);
// First opens and clicks reach the event log through the log job.
const logged = (ws) => runDueJobs(db, { workspaceId: ws });

const tokenOf = (msg) => (msg.html.match(/\/o\/([A-Za-z0-9_-]{24})\.gif/) || [])[1];
const linkOf = (msg, n) => {
  const m = msg.html.match(new RegExp(`href="([^"]*/c/[A-Za-z0-9_-]{24}/${n})"`));
  return m ? m[1] : null;
};
const pathOf = (url) => new URL(url, 'http://local').pathname;

const workspace = async (name, n, { media = 0 } = {}) => {
  const c = new Client();
  const r = await c.signup({ workspaceName: `${name} ${tag}`, email: `ab.${name.toLowerCase().replace(/\W+/g, '')}.${tag}@example.org` });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  for (let i = 0; i < n; i += 1) {
    const s = await c.action('subscription.add', { email: `reader${i}.${tag}@example.org`, name: `Reader ${i}` });
    assert.equal(s.status, 200);
  }
  for (let i = 0; i < media; i += 1) {
    await c.createPerson(`Desk ${i}`, { email: `desk${i}.${tag}@news.example`, tags: ['media'] });
  }
  return { c, ws: r.json.workspace.id, slug: r.json.workspace.slug };
};

const rows = async (blastId) => (await db.query(
  `select email, status, token, ab_group, opens, clicks, first_open_at, first_click_at
   from blast_recipients where blast_id = $1 order by email`, [blastId],
)).rows;
const events = async (c, action) => (await c.get('/api/events?since=0&limit=5000')).json.events.filter((e) => e.action === action);
const statsFor = async (c, id) => (await c.get('/api/blasts/stats')).json.stats.find((s) => s.id === id);
// Another run of a send's winner job (a retry), due now.
const enqueueAgain = (ws, blastId) => db.query(
  `insert into jobs (id, workspace_id, kind, run_at, payload) values (gen_random_uuid(), $1, 'abtests.winner', now(), $2)`,
  [ws, JSON.stringify({ blast_id: blastId, base: '' })],
);
const dueNow = (ws) => db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'abtests.winner' and status = 'pending'`, [ws]);

const BODY = 'Hello neighbours.\n\nRead the plan: https://imaginesurrey.example/plan.\nRSVP (https://imaginesurrey.example/rsvp?x=1) today!';

let T; // the tracked newsletter from the first test, reused below
test('every recipient gets its own token; the HTML part has a pixel and tracked links; the text part is unchanged', async () => {
  const { c, ws } = await workspace('Tracked', 3);
  await withEmail(async (sent) => {
    const r = await c.action('blast.send', { kind: 'newsletter', subject: 'Tracked news', body: BODY });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.blast.status, 'sent');
    assert.deepEqual(r.json.counts, { total: 3, sent: 3, failed: 0, queued: 0 });
    assert.equal(r.json.blast.ab, undefined, 'no test on a plain send');
    assert.equal(sent.length, 3);
    const subs = (await c.get('/api/subscriptions')).json.subscriptions;
    const tokens = sent.map(tokenOf);
    assert.ok(tokens.every(Boolean), 'each email has an open pixel');
    assert.equal(new Set(tokens).size, 3, 'tokens are unique per recipient');
    for (const m of sent) {
      assert.match(m.text, /^Hello neighbours\./, 'plain text part as before');
      assert.doesNotMatch(m.text, /\/c\/|\/o\//, 'the text part is not tracked');
      const sub = subs.find((s) => s.email === m.to[0]);
      assert.ok(m.text.includes(`/u/${sub.id}`));
      assert.match(m.html, /Hello neighbours\./);
      // Unsubscribe: the recipient's own /u/ link, never rewritten.
      assert.ok(m.html.includes(`/u/${sub.id}"`), 'html carries the own unsubscribe link');
      const t = tokenOf(m);
      assert.ok(linkOf(m, 1).endsWith(`/c/${t}/1`), 'link 1 rewritten');
      assert.ok(linkOf(m, 2).endsWith(`/c/${t}/2`), 'link 2 rewritten');
      assert.equal(linkOf(m, 3), null, 'only the two message links are tracked');
      assert.doesNotMatch(m.html, /href="https:\/\/imaginesurrey\.example/, 'no raw message links left');
      assert.ok(m.html.includes('>https://imaginesurrey.example/plan</a>.'), 'a sentence full stop stays out of the link');
    }
    const stored = (await db.query('select n, url from blast_links where blast_id = $1 order by n', [r.json.blast.id])).rows;
    assert.deepEqual(stored, [
      { n: 1, url: 'https://imaginesurrey.example/plan' },
      { n: 2, url: 'https://imaginesurrey.example/rsvp?x=1' },
    ]);
    const saved = await rows(r.json.blast.id);
    assert.deepEqual(saved.map((x) => x.token).sort(), [...tokens].sort(), 'tokens stored on the rows');
    assert.ok(sent.every((m) => m.key && m.key.startsWith(`blast-${r.json.blast.id}-`)), 'each email has an idempotency key');
    assert.equal(new Set(sent.map((m) => m.key)).size, 3);
    assert.ok(sent.every((m) => m.html.includes('We count opens and clicks.')), 'the tracked part says so');
    assert.ok(sent.every((m) => !m.text.includes('count opens')), 'the untracked text part makes no such claim');
    await aged(r.json.blast.id);
    T = { c, ws, id: r.json.blast.id, sent: [...sent], subs };
  });
});

test('the pixel records an open once: one event, later opens only counted', async () => {
  const { c, id, sent } = T;
  const tok = tokenOf(sent[0]);
  const first = await pub(`/o/${tok}.gif`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/gif');
  assert.match(first.headers.get('cache-control'), /no-store/);
  const gif = Buffer.from(await first.arrayBuffer());
  assert.equal(gif.subarray(0, 6).toString(), 'GIF89a');
  assert.deepEqual([gif.readUInt16LE(6), gif.readUInt16LE(8)], [1, 1], 'a 1×1 gif');
  await pub(`/o/${tok}.gif`);
  let row = (await rows(id)).find((x) => x.token === tok);
  assert.equal(row.opens, 1, 'a reload within 30 seconds is the same open');
  // Later opens are counted on the row.
  const firstAt = row.first_open_at;
  await db.query(`update blast_recipients set last_open_at = now() - interval '1 minute' where token = $1`, [tok]);
  await pub(`/o/${tok}.gif`);
  await db.query(`update blast_recipients set last_open_at = now() - interval '1 minute' where token = $1`, [tok]);
  await pub(`/o/${tok}.gif`);
  row = (await rows(id)).find((x) => x.token === tok);
  assert.equal(row.opens, 3);
  assert.equal(String(row.first_open_at), String(firstAt), 'the first open stays the first');
  assert.equal((await events(c, 'public.open')).length, 0, 'the hit itself writes no event (no campaign lock)');
  await logged(T.ws);
  const opens = await events(c, 'public.open');
  assert.equal(opens.length, 1, 'only the first open is an event');
  assert.equal(opens[0].actor_id, null);
  assert.equal(opens[0].payload.blast_id, id);
  assert.equal(JSON.stringify(opens[0].payload).includes('@'), false, 'no email in the event');

  // Nonsense tokens still get a gif and record nothing.
  assert.equal((await pub('/o/AAAAAAAAAAAAAAAAAAAAAAAA.gif')).status, 200);
  assert.equal((await pub('/o/not-a-token.gif')).status, 200);
  await logged(T.ws);
  assert.equal((await events(c, 'public.open')).length, 1, 'logged once, however often the job runs');

  const s = await statsFor(c, id);
  assert.deepEqual({ delivered: s.delivered, opened: s.opened, clicked: s.clicked }, { delivered: 3, opened: 1, clicked: 0 });
  assert.equal(s.ab, null);
});

test('a click redirects only to the link stored for that send, and counts once as an event', async () => {
  const { c, id, sent } = T;
  const m = sent[1];
  const tok = tokenOf(m);
  const res = await pub(pathOf(linkOf(m, 2)));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://imaginesurrey.example/rsvp?x=1');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  // Anything added to the address is ignored: no open redirect.
  await db.query(`update blast_recipients set last_click_at = now() - interval '1 minute' where token = $1`, [tok]);
  const sneaky = await pub(`/c/${tok}/1?url=https://evil.example/&to=https://evil.example/`);
  assert.equal(sneaky.headers.get('location'), 'https://imaginesurrey.example/plan');
  for (const bad of [`/c/${tok}/3`, `/c/${tok}/0`, `/c/${tok}/1e0`, `/c/${tok}/-1`, '/c/AAAAAAAAAAAAAAAAAAAAAAAA/1', `/c/${tok.slice(1)}x/1`, '/c/https:%2F%2Fevil.example/1']) {
    const r = await pub(bad);
    assert.equal(r.status, 404, bad);
    assert.equal(r.headers.get('location'), null, `${bad} never redirects`);
  }
  // Another send's token can't reach this send's links (links are per send).
  const row = (await rows(id)).find((x) => x.token === tok);
  assert.equal(row.clicks, 2);
  await logged(T.ws);
  const clicks = await events(c, 'public.click');
  assert.equal(clicks.length, 1, 'only the first click is an event');
  assert.equal(clicks[0].payload.clicked, 2);
  const s = await statsFor(c, id);
  assert.deepEqual({ delivered: s.delivered, opened: s.opened, clicked: s.clicked }, { delivered: 3, opened: 2, clicked: 1 },
    'a click counts as an open');
});

test('the unsubscribe link is never tracked and still works', async () => {
  const { c, id, sent, subs } = T;
  const m = sent[2];
  const sub = subs.find((s) => s.email === m.to[0]);
  const href = (m.html.match(/href="([^"]*\/u\/[0-9a-f-]{36})"/) || [])[1];
  assert.ok(href, 'unsubscribe link in the HTML');
  assert.ok(!href.includes('/c/'), 'not rewritten');
  // The mail app's own Unsubscribe button points at the same link (one-click POST).
  assert.equal(m.headers?.['List-Unsubscribe'], `<${href}>`);
  assert.equal(m.headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const before = (await rows(id)).find((x) => x.email === m.to[0]);
  // Opening the link (a mail scanner does) only asks.
  const ask = await pub(pathOf(href));
  assert.equal(ask.status, 200);
  assert.match(await ask.text(), /<button type="submit">Unsubscribe<\/button>/);
  assert.equal((await c.get('/api/subscriptions')).json.subscriptions.find((s) => s.id === sub.id).status, 'subscribed', 'opening it unsubscribes no one');
  const res = await app.request(pathOf(href), { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Unsubscribed\./);
  const after = (await rows(id)).find((x) => x.email === m.to[0]);
  assert.equal(after.clicks, before.clicks, 'no click recorded');
  assert.equal(after.opens, before.opens);
  const now = (await c.get('/api/subscriptions')).json.subscriptions.find((s) => s.id === sub.id);
  assert.equal(now.status, 'unsubscribed');
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
});

test('A/B: 20% each to A and B now, the rest held; Send now never reaches the held ones', async () => {
  const { c, ws } = await workspace('Split', 60);
  await withEmail(async (sent) => {
    const r = await c.action('blast.send', {
      kind: 'newsletter', subject: 'Subject A here', body: 'Read https://imaginesurrey.example/a',
      ab: { subject_b: 'Subject B here', pct: 20, wait_hours: 4, metric: 'opens' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.counts, { total: 60, sent: 24, failed: 0, queued: 36 });
    assert.equal(r.json.blast.status, 'queued', 'not everyone has it yet');
    assert.equal(r.json.blast.ab.status, 'testing');
    const wait = new Date(r.json.blast.ab.decide_at).getTime() - Date.now();
    assert.ok(wait > 3.9 * 3600e3 && wait <= 4 * 3600e3, `winner picked in 4 hours (${wait})`);
    assert.equal(sent.length, 24);
    assert.equal(sent.filter((m) => m.subject === 'Subject A here').length, 12);
    assert.equal(sent.filter((m) => m.subject === 'Subject B here').length, 12);
    const saved = await rows(r.json.blast.id);
    const by = (g) => saved.filter((x) => x.ab_group === g);
    assert.equal(by('a').length, 12);
    assert.equal(by('b').length, 12);
    assert.equal(by('rest').length, 36);
    assert.ok(by('rest').every((x) => x.status === 'queued'), 'the rest are held');
    assert.ok([...by('a'), ...by('b')].every((x) => x.status === 'sent'));
    assert.equal(new Set(saved.map((x) => x.token)).size, 60, 'every row has its own token');

    const again = await c.action('blast.resend', { id: r.json.blast.id });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.resent, { sent: 0, failed: 0, skipped: 0 });
    assert.equal(sent.length, 24, 'held rows are never sent before the winner');
    // A held row's token records nothing (it was never sent).
    assert.equal((await pub(`/o/${by('rest')[0].token}.gif`)).status, 200);
    assert.equal((await rows(r.json.blast.id)).find((x) => x.token === by('rest')[0].token).opens, 0);

    const s = await statsFor(c, r.json.blast.id);
    assert.equal(s.ab.status, 'testing');
    assert.deepEqual(s.ab.rest, { total: 36, sent: 0, failed: 0, held: 36, going: 0 });
    assert.equal(s.ab.result, null, 'no result before the winner');
    assert.deepEqual(s.ab.a, { total: 12, delivered: 12, opened: 0, clicked: 0 });

    // Logged as asked (the send and its test), then as it went.
    const [ev, done] = (await events(c, 'blast.send')).filter((e) => e.entity_id === r.json.blast.id);
    assert.equal(ev.op, 'create');
    assert.deepEqual(ev.payload.ab, { subject_b: 'Subject B here', pct: 20, wait_hours: 4, metric: 'opens', status: 'testing' });
    assert.deepEqual(done.payload, { sent: 24, failed: 0, unsubscribed: 0, status: 'queued' });
    const jobs = (await db.query(`select status, payload from jobs where workspace_id = $1 and kind = 'abtests.winner'`, [ws])).rows;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].payload.blast_id, r.json.blast.id);
  });
  for (const [pct, size] of [[10, 6], [30, 18]]) {
    await withEmail(async (sent) => {
      const r = await c.action('blast.send', {
        kind: 'newsletter', subject: `A ${pct}`, body: 'Hi https://imaginesurrey.example/hi', ab: { subject_b: `B ${pct}`, pct, wait_hours: 1, metric: 'clicks' },
      });
      assert.equal(sent.length, size * 2, `${pct}%: ${size} each`);
      assert.deepEqual(r.json.counts, { total: 60, sent: size * 2, failed: 0, queued: 60 - size * 2 });
    });
  }
});

test('the winner is picked when the wait ends and sent once to everyone else', async () => {
  const { c, ws } = await workspace('Winner', 50);
  await withEmail(async (sent) => {
    const r = await c.action('blast.send', {
      kind: 'newsletter', subject: 'Plain subject', body: 'See https://imaginesurrey.example/x',
      ab: { subject_b: 'Better subject', pct: 10, wait_hours: 1, metric: 'opens' },
    });
    const id = r.json.blast.id;
    assert.equal(sent.length, 10);
    // B opens better: 3 of 5 vs 1 of 5.
    const a = sent.filter((m) => m.subject === 'Plain subject');
    const b = sent.filter((m) => m.subject === 'Better subject');
    await pub(`/o/${tokenOf(a[0])}.gif`);
    for (const m of b.slice(0, 3)) await pub(`/o/${tokenOf(m)}.gif`);
    const live = await statsFor(c, id);
    assert.deepEqual([live.ab.a.opened, live.ab.b.opened, live.ab.a.delivered], [1, 3, 5]);

    // Not due yet: nothing happens.
    await runDueJobs(db, { workspaceId: ws });
    assert.equal(sent.length, 10);
    await dueNow(ws);
    const ran = await runDueJobs(db, { workspaceId: ws });
    assert.deepEqual(ran, { ran: 1, failed: 0 });
    assert.equal(sent.length, 50);
    const rest = sent.slice(10);
    assert.ok(rest.every((m) => m.subject === 'Better subject'), 'the rest get the winner');
    const to = sent.map((m) => m.to[0]);
    assert.equal(new Set(to).size, 50, 'everyone exactly once');
    assert.ok(rest.every((m) => tokenOf(m)), 'the rest are tracked too');

    const blasts = (await c.get('/api/blasts')).json.blasts;
    const row = blasts.find((x) => x.id === id);
    assert.equal(row.status, 'sent');
    assert.equal(row.sent_count, 50);
    assert.ok(row.sent_at);
    const s = await statsFor(c, id);
    assert.equal(s.ab.status, 'decided');
    assert.equal(s.ab.winner, 'b');
    assert.ok(s.ab.decided_at);
    assert.deepEqual(s.ab.rest, { total: 40, sent: 40, failed: 0, held: 0, going: 0 });
    assert.deepEqual(s.ab.result, {
      metric: 'opens', tie: false, a: { delivered: 5, opened: 1, clicked: 0 }, b: { delivered: 5, opened: 3, clicked: 0 },
    }, 'the numbers the winner was picked on');
    assert.ok(rest.every((m) => m.key), 'the rest carry idempotency keys too');
    const ev = await events(c, 'blast.ab_winner');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].actor_id, null);
    assert.equal(ev[0].payload.ab_winner, 'b');
    assert.equal(ev[0].payload.tie, false);
    assert.deepEqual(ev[0].payload.b, { delivered: 5, opened: 3, clicked: 0 });
    // Each step is its own short write: claims, one per answer, the finish.
    const restEv = await events(c, 'blast.ab_rest');
    assert.equal(restEv.filter((e) => e.entity_type === 'blast_recipient').length, 40, 'each answer recorded on its own');
    assert.ok(restEv.every((e) => e.actor_id === null && !JSON.stringify(e.payload).includes('@')));
    const fin = restEv.at(-1);
    assert.equal(fin.payload.sent, 40);
    assert.equal(fin.payload.status, 'sent');

    // The job never runs twice; Send now has nothing left to send.
    await db.query(`update jobs set status = 'pending', run_at = now() where workspace_id = $1 and kind = 'abtests.winner'`, [ws]);
    await runDueJobs(db, { workspaceId: ws });
    assert.equal(sent.length, 50, 'a decided test is never sent again');
    assert.equal((await events(c, 'blast.ab_winner')).length, 1, 'and logs nothing');
    assert.equal((await events(c, 'blast.ab_rest')).length, restEv.length);
    const again = await c.action('blast.resend', { id });
    assert.deepEqual(again.json.resent, { sent: 0, failed: 0, skipped: 0 });
    assert.equal(sent.length, 50);
  });
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
});

test('a tie goes to A; winner by clicks; someone who unsubscribed while held is left off', async () => {
  const { c, ws } = await workspace('Tie', 50);
  await withEmail(async (sent) => {
    const r = await c.action('blast.send', {
      kind: 'newsletter', subject: 'Tie A', body: 'Go https://imaginesurrey.example/go',
      ab: { subject_b: 'Tie B', pct: 10, wait_hours: 2, metric: 'clicks' },
    });
    const id = r.json.blast.id;
    // B opens more, but by clicks they tie (one each) → A.
    const a = sent.filter((m) => m.subject === 'Tie A');
    const b = sent.filter((m) => m.subject === 'Tie B');
    for (const m of b) await pub(`/o/${tokenOf(m)}.gif`);
    await aged(id);
    await pub(pathOf(linkOf(a[0], 1)));
    await pub(pathOf(linkOf(b[0], 1)));
    // One held reader leaves the list before the winner goes out.
    const held = (await rows(id)).find((x) => x.ab_group === 'rest');
    const sub = (await c.get('/api/subscriptions')).json.subscriptions.find((s) => s.email === held.email);
    await c.action('subscription.remove', { id: sub.id });

    await dueNow(ws);
    await runDueJobs(db, { workspaceId: ws });
    const s = await statsFor(c, id);
    assert.equal(s.ab.winner, 'a', 'a tie goes to A');
    assert.equal(s.ab.result.tie, true, 'and says it was a tie');
    assert.deepEqual([s.ab.result.a.clicked, s.ab.result.b.clicked, s.ab.result.b.opened], [1, 1, 5]);
    assert.equal(sent.length, 49);
    assert.ok(sent.slice(10).every((m) => m.subject === 'Tie A'));
    assert.ok(!sent.some((m) => m.to[0] === held.email), 'the unsubscribed reader is never emailed');
    const blast = (await c.get('/api/blasts')).json.blasts.find((x) => x.id === id);
    assert.equal(blast.status, 'sent');
    assert.equal(blast.audience_count, 49);
  });
});

test('not connected: the whole A/B send is saved, nothing sends, and the test starts only on Send now', async () => {
  const { c, ws } = await workspace('Saved', 50);
  const r = await withoutEmail(async (calls) => {
    const res = await c.action('blast.send', {
      kind: 'newsletter', subject: 'Saved A', body: 'Hi https://imaginesurrey.example/s',
      ab: { subject_b: 'Saved B', pct: 20, wait_hours: 12, metric: 'opens' },
    });
    assert.equal(calls(), 0, 'nothing is sent');
    return res;
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.blast.status, 'queued');
  assert.deepEqual(r.json.counts, { total: 50, sent: 0, failed: 0, queued: 50 });
  assert.match(r.json.blast.provider_note, /no email provider/);
  assert.equal(r.json.blast.ab.status, 'saved');
  assert.equal(r.json.blast.ab.decide_at, null, 'no winner time until it starts');
  const id = r.json.blast.id;
  assert.equal((await db.query(`select count(*)::int as n from jobs where workspace_id = $1`, [ws])).rows[0].n, 0, 'no job scheduled');
  // Its tokens record nothing: nobody has the email.
  const tok = (await rows(id))[0].token;
  await pub(`/o/${tok}.gif`);
  assert.equal((await rows(id)).find((x) => x.token === tok).opens, 0);

  await withoutEmail(async () => {
    const refused = await c.action('blast.resend', { id });
    assert.equal(refused.status, 409, 'Send now refused while not connected');
  });
  assert.equal((await statsFor(c, id)).ab.status, 'saved');

  await withEmail(async (sent) => {
    const go = await c.action('blast.resend', { id });
    assert.equal(go.status, 200, JSON.stringify(go.json));
    assert.deepEqual(go.json.resent, { sent: 20, failed: 0, skipped: 0 }, 'only A and B go out');
    assert.equal(go.json.blast.ab.status, 'testing');
    const wait = new Date(go.json.blast.ab.decide_at).getTime() - Date.now();
    assert.ok(wait > 11.9 * 3600e3 && wait <= 12 * 3600e3, 'the wait starts on Send now');
    assert.equal(sent.length, 20);
    assert.deepEqual(sent.map((m) => m.subject).sort(), [...Array(10).fill('Saved A'), ...Array(10).fill('Saved B')]);
    const ev = (await events(c, 'blast.resend')).at(-1);
    assert.equal(ev.payload.ab, 'testing');

    const twice = await c.action('blast.resend', { id });
    assert.deepEqual(twice.json.resent, { sent: 0, failed: 0, skipped: 0 });
    assert.equal((await db.query(`select count(*)::int as n from jobs where workspace_id = $1 and kind = 'abtests.winner'`, [ws])).rows[0].n, 1, 'one winner job');

    await dueNow(ws);
    await runDueJobs(db, { workspaceId: ws });
    assert.equal(sent.length, 50);
    assert.equal(new Set(sent.map((m) => m.to[0])).size, 50);
  });
});

test('the winner goes out while email is disconnected: the rest stay saved, then Send now sends them the winner', async () => {
  const { c, ws } = await workspace('Unplugged', 50);
  let id;
  await withEmail(async () => {
    const r = await c.action('blast.send', {
      kind: 'newsletter', subject: 'Unplugged A', body: 'Hi', ab: { subject_b: 'Unplugged B', pct: 10, wait_hours: 1, metric: 'opens' },
    });
    id = r.json.blast.id;
  });
  await withoutEmail(async (calls) => {
    await dueNow(ws);
    await runDueJobs(db, { workspaceId: ws });
    assert.equal(calls(), 0);
  });
  const s = await statsFor(c, id);
  assert.equal(s.ab.status, 'decided');
  assert.equal(s.ab.winner, 'a');
  assert.deepEqual(s.ab.rest, { total: 40, sent: 0, failed: 0, held: 0, going: 0 }, 'released, not held');
  assert.equal(s.ab.result.tie, true, 'no opens either side: a tie');
  const listed = (await c.get('/api/blasts')).json.blasts.find((x) => x.id === id);
  assert.match(listed.provider_note, /no email provider/);
  await withEmail(async (sent) => {
    const go = await c.action('blast.resend', { id });
    assert.deepEqual(go.json.resent, { sent: 40, failed: 0, skipped: 0 });
    assert.ok(sent.every((m) => m.subject === 'Unplugged A'));
    assert.equal(go.json.blast.status, 'sent');
  });
});

test('small lists send normally: A/B needs at least 50', async () => {
  const { c } = await workspace('Small', 49, { media: 2 });
  await withEmail(async (sent) => {
    const r = await c.action('blast.send', {
      kind: 'newsletter', subject: 'Small A', body: 'Hi', ab: { subject_b: 'Small B', pct: 30, wait_hours: 1, metric: 'opens' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.ab_skipped, 'A/B needs at least 50');
    assert.equal(r.json.blast.ab, undefined);
    assert.equal(r.json.blast.status, 'sent');
    assert.equal(sent.length, 49);
    assert.ok(sent.every((m) => m.subject === 'Small A'));
    assert.equal((await statsFor(c, r.json.blast.id)).ab, null);
    sent.length = 0;
    const press = await c.action('blast.send', {
      kind: 'press', subject: 'Release A', body: 'FOR IMMEDIATE RELEASE https://imaginesurrey.example/news',
      ab: { subject_b: 'Release B', pct: 10, wait_hours: 1, metric: 'clicks' },
    });
    assert.equal(press.json.ab_skipped, 'A/B needs at least 50');
    assert.equal(sent.length, 2);
    for (const m of sent) {
      assert.ok(tokenOf(m), 'press is tracked too');
      assert.ok(linkOf(m, 1));
      assert.doesNotMatch(m.html, /\/u\//, 'press carries no unsubscribe link');
      assert.match(m.text, /FOR IMMEDIATE RELEASE/);
    }
  });
});

test('A/B input is checked; stats are desk-only and carry no emails or tokens', async () => {
  const { c, ws } = await workspace('Checks', 50);
  const same = await c.action('blast.send', { kind: 'newsletter', subject: 'Same', body: 'x', ab: { subject_b: 'Same', pct: 10, wait_hours: 1, metric: 'opens' } });
  assert.equal(same.status, 400);
  for (const ab of [
    { subject_b: 'B', pct: 15, wait_hours: 1, metric: 'opens' },
    { subject_b: 'B', pct: 10, wait_hours: 3, metric: 'opens' },
    { subject_b: 'B', pct: 10, wait_hours: 1, metric: 'replies' },
    { subject_b: '', pct: 10, wait_hours: 1, metric: 'opens' },
  ]) {
    assert.equal((await c.action('blast.send', { kind: 'newsletter', subject: 'A', body: 'x', ab })).status, 400, JSON.stringify(ab));
  }
  let id;
  await withEmail(async () => {
    id = (await c.action('blast.send', { kind: 'newsletter', subject: 'Desk A', body: 'x', ab: { subject_b: 'Desk B', pct: 10, wait_hours: 1, metric: 'opens' } })).json.blast.id;
  });
  const stats = await c.get('/api/blasts/stats');
  assert.equal(stats.status, 200);
  const raw = JSON.stringify(stats.json);
  assert.doesNotMatch(raw, /@/, 'no email addresses');
  for (const r of await rows(id)) assert.ok(!raw.includes(r.token), 'no tokens');
  assert.deepEqual(stats.json.ab, { min: 50, pcts: [10, 20, 30], waits: [1, 2, 4, 12, 24] });

  // A volunteer gets neither the stats nor the sends.
  const inv = await c.action('member.invite', { email: `vol.${tag}@example.org`, role: 'volunteer' });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const v = new Client();
  const joined = await v.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vol', password: 'knock-knock-2026' });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  assert.equal((await v.get('/api/blasts/stats')).status, 403);
  assert.equal((await v.get('/api/blasts')).status, 403);
  assert.equal((await v.action('blast.send', { kind: 'newsletter', subject: 'x', body: 'y' })).status, 403);

  // Another campaign can't see this one's stats.
  const other = new Client();
  await other.signup({ workspaceName: `Other ${tag}`, email: `ab.other.${tag}@example.org` });
  assert.deepEqual((await other.get('/api/blasts/stats')).json.stats, []);
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
  assert.ok(ws);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ab10 = (name, extra = {}) => ({
  kind: 'newsletter', subject: `${name} A`, body: 'Read https://imaginesurrey.example/plan',
  ab: { subject_b: `${name} B`, pct: 10, wait_hours: 1, metric: 'opens', ...extra },
});

test('a write that fails mid-send: the retry carries on, nobody is emailed twice, and Try again reaches the unsure ones once', async () => {
  const { c, ws } = await workspace('Crash', 50);
  await withEmail(async (sent) => {
    const r = await c.action('blast.send', ab10('Crash'));
    const id = r.json.blast.id;
    assert.equal(sent.length, 10);
    // The third answer's write fails (a deploy, a dropped connection).
    let writes = 0;
    const flaky = {
      ...db,
      transaction: (fn) => db.transaction((tx) => fn({
        query: (sql, params) => {
          if (/update blast_recipients set status = \$3/.test(sql) && ++writes === 3) throw new Error('connection dropped');
          return tx.query(sql, params);
        },
      })),
    };
    await dueNow(ws);
    assert.deepEqual(await runDueJobs(flaky, { workspaceId: ws }), { ran: 0, failed: 1 });
    assert.equal(sent.length, 13, 'three of the rest went before the write failed');
    let rest = (await rows(id)).filter((x) => x.ab_group === 'rest');
    assert.equal(rest.filter((x) => x.status === 'sent').length, 2);
    assert.equal(rest.filter((x) => x.status === 'sending').length, 8, 'the claimed few: one answered, not recorded; seven not tried');

    // The job's retry: the rows still queued go out; 'sending' ones are left alone.
    await db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'abtests.winner' and status = 'pending'`, [ws]);
    assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 1, failed: 0 });
    assert.equal(sent.length, 43);
    assert.equal(new Set(sent.map((m) => m.to[0])).size, 43, 'nobody twice');
    assert.equal((await events(c, 'blast.ab_winner')).length, 1, 'decided once');
    let listed = (await c.get('/api/blasts')).json.blasts.find((x) => x.id === id);
    assert.deepEqual([listed.status, listed.sent_count, listed.sending_count, listed.retry_count], ['queued', 42, 8, 0],
      'eight not sure; Try again waits until they are ten minutes old');
    rest = (await rows(id)).filter((x) => x.ab_group === 'rest');
    assert.equal(rest.filter((x) => x.status === 'sending').length, 8);

    // Ten minutes on: Try again sends them with the same keys — the one the
    // service already took is dropped there, the seven go out.
    await db.query(`update blast_recipients set sending_at = now() - interval '11 minutes' where blast_id = $1 and status = 'sending'`, [id]);
    listed = (await c.get('/api/blasts')).json.blasts.find((x) => x.id === id);
    assert.equal(listed.retry_count, 8);
    const again = await c.action('blast.resend', { id });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(sent.dropped, 1, 'the one that went is not sent again');
    assert.equal(sent.length, 50);
    assert.equal(new Set(sent.map((m) => m.to[0])).size, 50, 'everyone exactly once');
    assert.deepEqual(again.json.counts, { total: 50, sent: 50, failed: 0, queued: 0 });
    assert.equal(again.json.blast.status, 'sent');
  });
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
});

test('the winner\'s last write is lost after everyone got it: the retry brings the send up to date, once', async () => {
  const { c, ws } = await workspace('Lost winner finish', 50);
  await withEmail(async (sent) => {
    const id = (await c.action('blast.send', ab10('Lost finish'))).json.blast.id;
    // The finish write fails (the last answer is already written down).
    const flaky = {
      ...db,
      transaction: (fn) => db.transaction((tx) => fn({
        query: (sql, params) => {
          if (/update blasts set status = \$3/.test(sql)) throw new Error('connection dropped');
          return tx.query(sql, params);
        },
      })),
    };
    await dueNow(ws);
    assert.deepEqual(await runDueJobs(flaky, { workspaceId: ws }), { ran: 0, failed: 1 });
    assert.equal(sent.length, 50, 'everyone has it');
    let listed = (await c.get('/api/blasts')).json.blasts.find((x) => x.id === id);
    assert.deepEqual([listed.status, listed.sent_count, listed.sent_at], ['queued', 50, null], 'the send still says otherwise');

    // The retry claims nothing, and still finishes the send.
    await dueNow(ws);
    assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 1, failed: 0 });
    assert.equal(sent.length, 50, 'nobody emailed again');
    listed = (await c.get('/api/blasts')).json.blasts.find((x) => x.id === id);
    assert.equal(listed.status, 'sent');
    assert.ok(listed.sent_at, 'sent when the last one went');
    const finishes = (await events(c, 'blast.ab_rest')).filter((e) => e.entity_type === 'blast' && e.payload.status);
    assert.deepEqual(finishes.map((e) => [e.payload.rest, e.payload.status]), [[0, 'sent']]);
    const exp = (await c.get('/api/export')).json;
    assert.equal(exp.blasts.find((x) => x.id === id).status, 'sent', 'the export says the same');
    // Settled: another run writes nothing.
    const before = (await c.get('/api/events?since=0&limit=5000')).json.events.length;
    await enqueueAgain(ws, id);
    assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 1, failed: 0 });
    assert.equal((await c.get('/api/events?since=0&limit=5000')).json.events.length, before);
  });
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
});

test('the winner goes out without holding the campaign lock: a door knock mid-send is not kept waiting', async () => {
  const { c, ws } = await workspace('Busy', 50);
  const p = await c.createPerson('Kim Door', { phone: '604-555-0142' });
  await withEmail(async (sent) => {
    await c.action('blast.send', ab10('Busy'));
    await dueNow(ws);
    const job = runDueJobs(db, { workspaceId: ws });
    while (sent.length < 15) await sleep(5);
    const t0 = Date.now();
    const knock = await c.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating: '1' });
    const took = Date.now() - t0;
    const during = sent.length;
    assert.equal(knock.status, 200, JSON.stringify(knock.json));
    assert.ok(during < 50, `the knock went through while the rest were still going out (${during} sent)`);
    assert.ok(took < 800, `the knock took ${took} ms`);
    assert.deepEqual(await job, { ran: 1, failed: 0 });
    assert.equal(sent.length, 50);
  }, { delay: 40 });
});

test('a provider that never answers is given up on: not sure it went, and the send moves on', async () => {
  process.env.STARBASE_EMAIL_TIMEOUT_MS = '100';
  let hangTo = null;
  try {
    const { c, ws } = await workspace('Hung', 50);
    await withEmail(async (sent) => {
      const r = await c.action('blast.send', ab10('Hung'));
      const id = r.json.blast.id;
      hangTo = (await rows(id)).find((x) => x.ab_group === 'rest').email;
      await dueNow(ws);
      const t0 = Date.now();
      assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 1, failed: 0 });
      assert.ok(Date.now() - t0 < 5000, 'not held up');
      assert.equal(sent.length, 49);
      assert.equal((await rows(id)).find((x) => x.email === hangTo).status, 'sending', 'not sure it went');
      const listed = (await c.get('/api/blasts')).json.blasts.find((x) => x.id === id);
      assert.deepEqual([listed.status, listed.sent_count, listed.failed_count, listed.sending_count], ['queued', 49, 0, 1]);
      assert.equal((await events(c, 'blast.ab_rest')).at(-1).payload.unsure, 1);

      // A plain send too: the one it never heard back about is 'sending', not failed.
      const { c: c2 } = await workspace('Hung plain', 3);
      hangTo = `reader1.${tag}@example.org`;
      const plain = await c2.action('blast.send', { kind: 'newsletter', subject: 'Plain', body: 'Hi' });
      assert.deepEqual(plain.json.counts, { total: 3, sent: 2, failed: 0, queued: 0, sending: 1 });
    }, { hang: (to) => to === hangTo });
  } finally {
    delete process.env.STARBASE_EMAIL_TIMEOUT_MS;
  }
});

test('a group that reached no one is a tie: A goes out and it says so; winner by clicks needs a link', async () => {
  const { c, ws } = await workspace('Reach', 50);
  const noLink = await c.action('blast.send', { ...ab10('Reach', { metric: 'clicks' }), body: 'No links in this one.' });
  assert.equal(noLink.status, 400);
  assert.match(noLink.json.error, /link/);
  let failA = true;
  await withEmail(async (sent) => {
    const r = await c.action('blast.send', ab10('Reach'));
    const id = r.json.blast.id;
    assert.equal(sent.length, 5, 'only B reached anyone');
    for (const m of sent.slice(0, 2)) await pub(`/o/${tokenOf(m)}.gif`);
    failA = false;
    await dueNow(ws);
    await runDueJobs(db, { workspaceId: ws });
    const s = await statsFor(c, id);
    assert.equal(s.ab.winner, 'a');
    assert.equal(s.ab.result.tie, true, 'A reached no one: no winner to call');
    assert.deepEqual([s.ab.result.a.delivered, s.ab.result.b.opened], [0, 2]);
    assert.ok(sent.slice(5).every((m) => m.subject === 'Reach A'));
  }, { fail: (to, msg) => failA && msg.subject === 'Reach A' });
});

test('clicks from mail scanners still go to the link but are not counted', async () => {
  const { c, ws } = await workspace('Scan', 2);
  await withEmail(async (sent) => {
    const r = await c.action('blast.send', { kind: 'newsletter', subject: 'Scanned', body: 'See https://imaginesurrey.example/scan' });
    const id = r.json.blast.id;
    const tok = tokenOf(sent[0]);
    const path = pathOf(linkOf(sent[0], 1));
    const clicks = async () => (await rows(id)).find((x) => x.token === tok).clicks;
    // Seconds after it went out: a scanner checking the link.
    const early = await pub(path);
    assert.equal(early.status, 302);
    assert.equal(early.headers.get('location'), 'https://imaginesurrey.example/scan');
    assert.equal(await clicks(), 0, 'within 15 seconds of delivery: not counted');
    await aged(id);
    for (const ua of ['', 'python-requests/2.31.0', 'Mozilla/5.0 (compatible; Barracuda Sentinel)', 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)']) {
      const res = await pub(path, ua);
      assert.equal(res.status, 302, ua);
      assert.equal(res.headers.get('location'), 'https://imaginesurrey.example/scan', ua);
    }
    assert.equal(await clicks(), 0, 'scanners are not readers');
    await pub(path);
    assert.equal(await clicks(), 1, 'a reader’s browser counts');
    await logged(ws);
    assert.equal((await events(c, 'public.click')).length, 1);
    assert.equal((await statsFor(c, id)).clicked, 1);
  });
});

test('the signup page says opens and clicks are counted', async () => {
  const { slug } = await workspace('Notice', 0);
  const page = await pub(`/n/${slug}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /We count opens and clicks in our emails\./);
});

test('a big list goes out a few hundred per run; meanwhile the rest are "going", not "not sent"', async () => {
  process.env.STARBASE_AB_SEND_PER_RUN = '15';
  try {
    const { c, ws } = await workspace('Chunks', 50);
    await withEmail(async (sent) => {
      const r = await c.action('blast.send', ab10('Chunks'));
      const id = r.json.blast.id;
      await dueNow(ws);
      assert.deepEqual(await runDueJobs(db, { workspaceId: ws }), { ran: 1, failed: 0 });
      assert.equal(sent.length, 10 + 15, 'one run sends at most 15 here');
      let s = await statsFor(c, id);
      assert.equal(s.ab.status, 'decided');
      assert.equal(s.ab.rest.going, 25, 'the other 25 are on their way');
      const pending = (await db.query(`select count(*)::int as n from jobs where workspace_id = $1 and kind = 'abtests.winner' and status = 'pending'`, [ws])).rows[0].n;
      assert.equal(pending, 1, 'the next run is queued');
      for (let i = 0; i < 3; i += 1) await runDueJobs(db, { workspaceId: ws });
      assert.equal(sent.length, 50);
      assert.equal(new Set(sent.map((m) => m.to[0])).size, 50);
      s = await statsFor(c, id);
      assert.equal(s.ab.rest.going, 0);
      assert.deepEqual(s.ab.rest, { total: 40, sent: 40, failed: 0, held: 0, going: 0 });
      assert.equal((await c.get('/api/blasts')).json.blasts.find((x) => x.id === id).status, 'sent');
      assert.equal((await events(c, 'blast.ab_winner')).length, 1);
    });
  } finally {
    delete process.env.STARBASE_AB_SEND_PER_RUN;
  }
});
