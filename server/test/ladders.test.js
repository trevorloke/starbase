// Ladders of engagement: a trigger puts someone on a ladder once, each step
// runs as a job on the hash chain (wait → email → tag → follow-up), email
// steps go only to people who said yes to email (skipping who unsubscribed,
// never asked, has no email, is do-not-contact), wait while email isn't
// connected (without spending retries) and send once it is — once, even when
// the write after the send fails; the unsubscribe link asks before it acts;
// turning a ladder off holds everyone's place and on resumes it. Volunteers
// can read none of it. Engagement levels follow what people did.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runDueJobs } from '../lib/jobs.js';
import { onHook } from '../lib/hooks.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.lad.${tag}@example.org`;
let db, mgr, ws, slug, wsName;

let ipN = 0;
const pub = async (method, path, body) => {
  ipN += 1;
  const form = body instanceof URLSearchParams;
  const res = await app.request(path, {
    method,
    headers: {
      'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      'x-forwarded-for': `10.9.${Math.floor(ipN / 250)}.1, 203.0.113.${ipN % 250}`,
    },
    body: body === undefined ? undefined : (form ? body.toString() : JSON.stringify(body)),
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, json: ct.includes('json') ? await res.json() : null, text: ct.includes('json') ? '' : await res.text() };
};

// Run every due ladder step in this campaign until nothing is left to run now.
const runJobs = async () => {
  let total = 0;
  for (let i = 0; i < 30; i++) {
    const r = await runDueJobs(db, { workspaceId: ws });
    total += r.ran + r.failed;
    if (r.ran + r.failed === 0) break;
  }
  return total;
};
// Time passes: every pending step is due now.
const fastForward = () => db.query(
  "update jobs set run_at = now() - interval '1 second' where workspace_id = $1 and status = 'pending' and kind = 'ladder.step'", [ws],
);

// Email connected (RESEND_API_KEY) with fetch answered here; restored after.
const withEmail = async (fn, { fail = () => false } = {}) => {
  const realFetch = globalThis.fetch;
  const hadKey = Object.hasOwn(process.env, 'RESEND_API_KEY');
  const oldKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com')) {
      const m = JSON.parse(init.body);
      if (fail(m.to[0])) return new Response('provider says no', { status: 500 });
      sent.push({ ...m, key: init.headers?.['Idempotency-Key'] || null });
      return new Response(JSON.stringify({ id: 'msg' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try { return await fn(sent); } finally {
    globalThis.fetch = realFetch;
    if (hadKey) process.env.RESEND_API_KEY = oldKey; else delete process.env.RESEND_API_KEY;
  }
};

const ladder = async (id) => (await mgr.get(`/api/ladders/${id}`)).json;
const runOf = async (ladderId, personId) => (await ladder(ladderId)).people.find((p) => p.person.id === personId);
const personByEmail = async (email) => (await db.query(
  'select id, name, tags from persons where workspace_id = $1 and lower(email) = $2', [ws, email],
)).rows[0];
const create = async (input) => {
  const r = await mgr.action('ladder.create', input);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.ladder;
};
const turnOn = async (id) => {
  const r = await mgr.action('ladder.setActive', { id, active: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
};
const verified = async () => {
  const v = await mgr.get('/api/audit/verify');
  assert.equal(v.json.ok, true, JSON.stringify(v.json));
};

before(async () => {
  db = await freshDb();
  delete process.env.RESEND_API_KEY;
  mgr = new Client();
  wsName = `Ladder Test ${tag}`;
  const r = await mgr.signup({ workspaceName: wsName, email: mail('manager'), jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  ws = r.json.workspace.id;
  slug = r.json.workspace.slug;
});
after(() => { delete process.env.RESEND_API_KEY; });

let thanks; // the petition ladder from the first test
let anaRun;

test('petition signed → on the ladder once → wait → email → tag → follow-up, all on the chain', async () => {
  const pet = await mgr.action('petition.create', { slug: `fix-72-${tag}`, title: 'Fix 72 Ave' });
  assert.equal(pet.status, 200);
  thanks = await create({
    name: 'Thank petition signers',
    trigger: { kind: 'petition', ref: `fix-72-${tag}` },
    steps: [
      { kind: 'wait', n: 1, unit: 'days' },
      { kind: 'email', subject: 'Thanks, {{first_name}}', body: 'Thank you for signing. — {{ campaign }}' },
      { kind: 'tag', tag: 'thanked' },
      { kind: 'followup', text: 'Call {{first_name}} to say thanks' },
    ],
  });
  assert.equal(thanks.active, false, 'a new ladder starts off');

  // Off: a signature puts no one on it.
  const early = await pub('POST', `/p/${slug}/fix-72-${tag}`, new URLSearchParams({ name: 'Early Bird', email: mail('early') }));
  assert.equal(early.status, 200);
  assert.equal((await ladder(thanks.id)).people.length, 0, 'nobody is put on a ladder that is off');

  await turnOn(thanks.id);
  const sign = await pub('POST', `/p/${slug}/fix-72-${tag}`, new URLSearchParams({ name: 'Ana Souza', email: mail('ana'), subscribe: '1' }));
  assert.equal(sign.status, 200);
  const ana = await personByEmail(mail('ana'));
  let run = await runOf(thanks.id, ana.id);
  assert.ok(run, 'the new signer is on the ladder');
  assert.equal(run.status, 'active');
  assert.equal(run.step, 0);
  anaRun = run.id;

  // The enrolment rode the signup's own transaction, as the system.
  const evs = (await mgr.get('/api/events?since=0&limit=1000')).json.events;
  const enrolled = evs.filter((e) => e.entity_type === 'ladder_run' && e.op === 'create' && e.entity_id === run.id);
  assert.equal(enrolled.length, 1);
  assert.equal(enrolled[0].action, 'public.signup');
  assert.equal(enrolled[0].actor_id, null);
  assert.deepEqual([enrolled[0].payload.trigger, enrolled[0].payload.ref], ['petition', `fix-72-${tag}`]);

  // Step 1: wait a day.
  await runJobs();
  run = await runOf(thanks.id, ana.id);
  assert.equal(run.step, 1);
  assert.equal(run.wait, 'time');
  assert.ok(new Date(run.next_at) - Date.now() > 23 * 3600_000, 'waits a day');
  assert.equal(await runJobs(), 0, 'nothing runs before the wait ends');

  await withEmail(async (sent) => {
    await fastForward();
    await runJobs();
    assert.equal(sent.length, 1, 'one email');
    const m = sent[0];
    assert.deepEqual(m.to, [mail('ana')]);
    assert.equal(m.subject, 'Thanks, Ana');
    assert.match(m.text, new RegExp(`^Thank you for signing\\. — ${wsName}`));
    assert.ok(m.text.includes(`Sent by ${wsName}.`), 'says who sent it');
    assert.ok(m.text.trimEnd().endsWith(`/lu/${anaRun}`), 'ends with the reader’s own unsubscribe link');
    // The mail app's own Unsubscribe button: the same link, one-click POST.
    assert.match(m.headers['List-Unsubscribe'], new RegExp(`^<https?://[^>]+/lu/${anaRun}>$`));
    assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    const stepJob = (await db.query(
      `select payload->>'token' as token from jobs where workspace_id = $1 and kind = 'ladder.step'
         and payload->>'run_id' = $2 and payload->>'step' = '1'`, [ws, anaRun],
    )).rows;
    assert.equal(stepJob.length, 1);
    assert.equal(m.key, `ladder-${stepJob[0].token}-1`, 'keyed by the run token and step');
  });

  run = await runOf(thanks.id, ana.id);
  assert.equal(run.status, 'done', 'all four steps ran');
  assert.ok((await personByEmail(mail('ana'))).tags.includes('thanked'));
  const fu = (await mgr.get('/api/ladders/followups')).json;
  assert.equal(fu.open.length, 1);
  assert.equal(fu.open[0].text, 'Call Ana to say thanks');
  assert.equal(fu.open[0].person.id, ana.id);
  assert.equal(fu.open[0].ladder.name, 'Thank petition signers');
  assert.equal((await mgr.get('/api/ladders/followups/count')).json.open, 1);

  const list = (await mgr.get('/api/ladders')).json;
  const row = list.ladders.find((l) => l.id === thanks.id);
  assert.deepEqual([row.inProgress, row.finished, row.active], [0, 1, true]);
  assert.equal(row.trigger.what, 'Fix 72 Ave');
  assert.equal(list.followups, 1);

  // Every step is on the chain as the system.
  const steps = (await mgr.get('/api/events?since=0&limit=1000')).json.events.filter((e) => e.action === 'ladder.step');
  assert.ok(steps.length >= 5, `steps logged: ${steps.length}`);
  assert.ok(steps.every((e) => e.actor_id === null));
  assert.ok(steps.some((e) => e.entity_type === 'person' && e.payload.tags?.includes('thanked')));
  assert.ok(steps.some((e) => e.entity_type === 'ladder_followup' && e.op === 'create'));
  await verified();
});

test('once per ladder — again only when the ladder allows it', async () => {
  const ana = await personByEmail(mail('ana'));
  await pub('POST', `/p/${slug}/fix-72-${tag}`, new URLSearchParams({ name: 'Ana Souza', email: mail('ana') }));
  let runs = (await ladder(thanks.id)).people.filter((p) => p.person.id === ana.id);
  assert.equal(runs.length, 1, 'signing again does not put her back on');

  assert.equal((await mgr.action('ladder.update', { id: thanks.id, reentry: true })).status, 200);
  await pub('POST', `/p/${slug}/fix-72-${tag}`, new URLSearchParams({ name: 'Ana Souza', email: mail('ana') }));
  runs = (await ladder(thanks.id)).people.filter((p) => p.person.id === ana.id);
  assert.equal(runs.length, 2, 'with "again" on and her last run over, she goes through again');
  // Take her off this second run (desk).
  const off = await mgr.action('ladder.stopRun', { id: runs.find((r) => r.status === 'active').id });
  assert.equal(off.status, 200);
  await fastForward();
  await runJobs();
  runs = (await ladder(thanks.id)).people.filter((p) => p.person.id === ana.id);
  assert.ok(runs.every((r) => r.status === 'done'));
  assert.equal((await mgr.get('/api/ladders/followups')).json.open.length, 1, 'taken off: no second follow-up');
  await mgr.action('ladder.update', { id: thanks.id, reentry: false });
});

test('the unsubscribe link asks, then takes them off everywhere; email steps go only to who said yes to email', async () => {
  // Opening the link (a mail scanner does) only asks.
  const ask = await pub('GET', `/lu/${anaRun}`);
  assert.equal(ask.status, 200);
  assert.match(ask.text, new RegExp(`Unsubscribe from ${wsName}\\?`));
  assert.ok(ask.text.includes(`<form method="post" action="/lu/${anaRun}"><button type="submit">Unsubscribe</button></form>`));
  assert.equal((await mgr.get('/api/subscriptions')).json.subscriptions.find((s) => s.email === mail('ana')).status, 'subscribed',
    'opening the link unsubscribes no one');
  // The button (or a mail app's one-click unsubscribe) does it.
  const page = await pub('POST', `/lu/${anaRun}`, new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }));
  assert.equal(page.status, 200);
  assert.match(page.text, /Unsubscribed\./);
  assert.match(page.text, new RegExp(`newsletters or automatic emails from ${wsName}`));
  const again = await pub('POST', `/lu/${anaRun}`, new URLSearchParams());
  assert.equal(again.status, 200, 'a second click is fine');
  assert.match((await pub('GET', `/lu/${anaRun}`)).text, /Unsubscribed\./, 'the link now says so without asking');
  for (const method of ['GET', 'POST']) {
    assert.equal((await pub(method, '/lu/not-a-link', method === 'POST' ? new URLSearchParams() : undefined)).status, 404);
    assert.equal((await pub(method, '/lu/99999999-9999-4999-8999-999999999999', method === 'POST' ? new URLSearchParams() : undefined)).status, 404);
  }
  const subs = (await mgr.get('/api/subscriptions')).json.subscriptions.filter((s) => s.email === mail('ana'));
  assert.deepEqual(subs.map((s) => s.status), ['unsubscribed'], 'on the newsletter list as unsubscribed');
  const unsubEvents = (await mgr.get('/api/events?since=0&limit=1000')).json.events
    .filter((e) => e.action === 'public.unsubscribe' && e.entity_type === 'subscription');
  assert.equal(unsubEvents.length, 1, 'one logged unsubscribe; the second click writes nothing');

  // The newsletter honours it: nobody subscribed → nothing to send to Ana.
  await mgr.action('subscription.add', { email: mail('nlreader') });
  const blast = await mgr.action('blast.send', { kind: 'newsletter', subject: 'Hi', body: 'News' });
  assert.equal(blast.json.counts.total, 1, 'Ana is not on the send');

  const yes = await create({
    name: 'Rated yes',
    trigger: { kind: 'rating' },
    steps: [
      { kind: 'email', subject: 'Glad you are with us', body: 'Hi {{first_name}}' },
      { kind: 'followup', text: 'Thank {{first_name}}' },
      { kind: 'tag', tag: 'yes-ladder' },
    ],
  });
  await turnOn(yes.id);
  const ana = await personByEmail(mail('ana'));
  const ben = await mgr.createPerson('Ben Noemail', { phone: '604-555-0142' });
  const cal = await mgr.createPerson('Cal Private', { email: mail('cal'), tags: ['do-not-contact'] });
  // Dana has an email but never said yes to email; Eli joined the newsletter.
  const dana = await mgr.createPerson('Dana Never', { email: mail('dana') });
  const eli = await mgr.createPerson('Eli Yes', { email: mail('eli') });
  assert.equal((await mgr.action('subscription.add', { email: mail('eli') })).status, 200);
  for (const p of [ana, ben, cal, dana, eli]) {
    assert.equal((await mgr.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating: '1' })).status, 200);
  }
  await withEmail(async (sent) => {
    await runJobs();
    assert.deepEqual(sent.map((m) => m.to[0]), [mail('eli')], 'only the one who said yes to email');
  });
  const reasons = {};
  for (const p of [ana, ben, cal, dana, eli]) {
    const run = await runOf(yes.id, p.id);
    assert.equal(run.status, 'done');
    reasons[p.name] = run.skipped.map((s) => `${s.kind}:${s.reason}`);
  }
  assert.deepEqual(reasons['Ana Souza'], ['email:unsubscribed']);
  assert.deepEqual(reasons['Ben Noemail'], ['email:no_email']);
  assert.deepEqual(reasons['Cal Private'], ['email:do_not_contact', 'followup:do_not_contact']);
  assert.deepEqual(reasons['Dana Never'], ['email:no_consent'], 'a 1 at the door is not a yes to email');
  assert.deepEqual(reasons['Eli Yes'], []);
  const eliLog = (await runOf(yes.id, eli.id)).log.map((e) => `${e.kind}:${e.result}`);
  assert.deepEqual(eliLog.filter((e) => e.startsWith('email:')), ['email:sent'], 'one "Email sent"; "sending" is only shown while it is the latest');
  // The builder counts who an email step can reach.
  assert.equal((await ladder(yes.id)).emailYes,
    (await db.query("select count(*)::int as n from subscriptions where workspace_id = $1 and status = 'subscribed'", [ws])).rows[0].n);
  // The other steps still ran.
  assert.ok((await personByEmail(mail('cal'))).tags.includes('yes-ladder'));
  const open = (await mgr.get('/api/ladders/followups')).json.open.map((f) => f.text);
  assert.ok(open.includes('Thank Ana') && open.includes('Thank Ben'));
  assert.ok(!open.includes('Thank Cal'), 'no follow-up for do-not-contact');
  await mgr.action('ladder.setActive', { id: yes.id, active: false });
  await verified();
});

test('a ladder unsubscribe from someone never on the list: flagged do-not-email, no list row; only their own signup undoes it', async () => {
  const dana = await personByEmail(mail('dana'));
  const runId = (await db.query('select id from ladder_runs where workspace_id = $1 and person_id = $2 limit 1', [ws, dana.id])).rows[0].id;
  const before = (await mgr.get('/api/subscriptions')).json;
  const r = await pub('POST', `/lu/${runId}`, new URLSearchParams());
  assert.equal(r.status, 200);
  assert.match(r.text, /Unsubscribed\./);
  const after = (await mgr.get('/api/subscriptions')).json;
  assert.ok(!after.subscriptions.some((x) => x.email === mail('dana')), 'no newsletter row for her');
  assert.deepEqual([after.subscribed, after.unsubscribed], [before.subscribed, before.unsubscribed], 'the list counts are unchanged');
  assert.ok((await personByEmail(mail('dana'))).tags.includes('do-not-email'));
  assert.match((await pub('GET', `/lu/${runId}`)).text, /Unsubscribed\./, 'the link says so without asking');
  const flagged = (await mgr.get('/api/events?since=0&limit=1000')).json.events
    .filter((e) => e.action === 'public.unsubscribe' && e.entity_type === 'person' && e.entity_id === dana.id);
  assert.equal(flagged.length, 1, 'on the chain as the system');
  assert.equal(flagged[0].actor_id, null);

  // The desk can't put either of them on the list.
  const addDana = await mgr.action('subscription.add', { email: mail('dana') });
  assert.equal(addDana.status, 409);
  assert.equal(addDana.json.error, 'Unsubscribed — only they can rejoin (signup page)');
  const addAna = await mgr.action('subscription.add', { email: mail('ana') });
  assert.equal(addAna.status, 409);
  assert.match(addAna.json.error, /^Unsubscribed on [A-Z][a-z]{2} \d{1,2} — only they can rejoin \(signup page\)$/);
  assert.equal((await mgr.get('/api/subscriptions')).json.subscriptions.find((x) => x.email === mail('ana')).status, 'unsubscribed');

  // An email step skips her as do-not-email.
  const nudge = await create({ name: 'Nudge', trigger: { kind: 'tag', ref: 'nudge' }, steps: [{ kind: 'email', subject: 'S', body: 'B' }] });
  await turnOn(nudge.id);
  await mgr.action('person.update', { id: dana.id, tags: [...(await personByEmail(mail('dana'))).tags, 'nudge'] });
  await withEmail(async (sent) => {
    await runJobs();
    assert.equal(sent.length, 0);
  });
  assert.deepEqual((await runOf(nudge.id, dana.id)).skipped.map((x) => x.reason), ['do_not_email']);
  await mgr.action('ladder.setActive', { id: nudge.id, active: false });

  // Her own signup is the way back on: on the list, and the flag lifted.
  assert.equal((await pub('POST', `/n/${slug}`, new URLSearchParams({ email: mail('dana'), name: 'Dana Never' }))).status, 200);
  assert.ok(!(await personByEmail(mail('dana'))).tags.includes('do-not-email'));
  assert.equal((await mgr.get('/api/subscriptions')).json.subscriptions.find((x) => x.email === mail('dana')).status, 'subscribed');
  await verified();
});

test('a failure after the send never sends it twice: the retry finds "sending", says "not sure it went", moves on', async () => {
  const lad = await create({
    name: 'Hello once',
    trigger: { kind: 'tag', ref: 'hello-once' },
    steps: [{ kind: 'email', subject: 'Ladder hello', body: 'Hi {{first_name}}' }, { kind: 'tag', tag: 'after-hello' }],
  });
  await turnOn(lad.id);
  assert.equal((await mgr.action('subscription.add', { email: mail('dbl') })).status, 200);
  const boom = { on: true };
  let target = null;
  onHook('events', async (_tx, meta, events) => {
    if (boom.on && meta.action === 'ladder.step'
      && events.some((e) => e.entityType === 'ladder_run' && e.payload?.result === 'sent' && e.payload?.person_id === target)) {
      throw new Error('the database went away after the send');
    }
  });
  await withEmail(async (sent) => {
    const p = await mgr.createPerson('Dot Double', { email: mail('dbl'), tags: ['hello-once'] });
    target = p.id;
    await runJobs();
    assert.equal(sent.length, 1, 'the provider got it');
    let run = await runOf(lad.id, p.id);
    assert.deepEqual([run.status, run.step, run.wait], ['active', 0, 'sending'], 'committed before the provider call, so the retry knows');
    for (let i = 0; i < 3; i += 1) { await fastForward(); await runJobs(); }
    assert.equal(sent.length, 1, 'never a second copy');
    run = await runOf(lad.id, p.id);
    assert.equal(run.status, 'done', 'the run moved on');
    assert.deepEqual(run.log.filter((e) => e.kind === 'email').map((e) => e.result), ['unsure']);
    assert.ok((await personByEmail(mail('dbl'))).tags.includes('after-hello'));
  });
  boom.on = false;
  await mgr.action('ladder.setActive', { id: lad.id, active: false });
  await verified();
});

test("email not connected: the run waits, looks again hourly without spending retries, then sends", async () => {
  delete process.env.RESEND_API_KEY;
  const news = await create({
    name: 'Newsletter welcome',
    trigger: { kind: 'newsletter' },
    steps: [{ kind: 'email', subject: 'Welcome', body: 'Welcome to {{campaign}}' }],
  });
  await turnOn(news.id);
  // Joined on the public page, as a new person.
  const join = await pub('POST', `/n/${slug}`, new URLSearchParams({ email: mail('dee'), name: 'Dee Lee' }));
  assert.equal(join.status, 200);
  const dee = await personByEmail(mail('dee'));
  assert.ok(dee);
  await runJobs();
  let run = await runOf(news.id, dee.id);
  assert.equal(run.status, 'active');
  assert.equal(run.wait, 'email', 'waiting — email isn’t connected');
  const listed = (await mgr.get('/api/ladders')).json;
  assert.equal(listed.emailConfigured, false);
  assert.equal(listed.ladders.find((l) => l.id === news.id).waitingEmail, 1);

  const jobs = async () => (await db.query(
    "select status, attempts, last_error, run_at from jobs where workspace_id = $1 and kind = 'ladder.step' and payload->>'run_id' = $2 order by created_at",
    [ws, run.id],
  )).rows;
  let js = await jobs();
  const pending = js.filter((j) => j.status === 'pending');
  assert.equal(pending.length, 1, 'one look scheduled');
  assert.ok(new Date(pending[0].run_at) - Date.now() > 55 * 60_000, 'an hour from now');

  // An hour later, still not connected: still waiting, nothing new logged.
  await fastForward();
  await runJobs();
  run = await runOf(news.id, dee.id);
  assert.equal(run.wait, 'email');
  js = await jobs();
  assert.ok(js.every((j) => j.attempts <= 1 && !j.last_error), 'no retry attempts spent');
  const waits = (await mgr.get('/api/events?since=0&limit=1000')).json.events
    .filter((e) => e.entity_type === 'ladder_run' && e.entity_id === run.id && e.payload.result === 'waiting');
  assert.equal(waits.length, 1, 'the wait is logged once');

  await withEmail(async (sent) => {
    await fastForward();
    await runJobs();
    assert.deepEqual(sent.map((m) => m.to[0]), [mail('dee')]);
    assert.match(sent[0].text, new RegExp(`^Welcome to ${wsName}`));
  });
  run = await runOf(news.id, dee.id);
  assert.equal(run.status, 'done');
  assert.equal(run.wait, null);
  await mgr.action('ladder.setActive', { id: news.id, active: false });
  await verified();
});

test('a provider refusal is tried again hourly, three times, then logged as failed and the run moves on', async () => {
  const lad = await create({
    name: 'Retry',
    trigger: { kind: 'tag', ref: 'retry-me' },
    steps: [{ kind: 'email', subject: 'S', body: 'B' }, { kind: 'tag', tag: 'after-retry' }],
  });
  await turnOn(lad.id);
  assert.equal((await mgr.action('subscription.add', { email: mail('rae') })).status, 200);
  const p = await mgr.createPerson('Rae Retry', { email: mail('rae'), tags: ['retry-me'] });
  await withEmail(async (sent) => {
    await runJobs();
    let run = await runOf(lad.id, p.id);
    assert.equal(run.wait, 'retry');
    await fastForward(); await runJobs();
    await fastForward(); await runJobs();
    run = await runOf(lad.id, p.id);
    assert.equal(run.status, 'done');
    assert.equal(sent.length, 0);
    assert.equal(run.last.kind, 'end');
  }, { fail: () => true });
  const evs = (await mgr.get('/api/events?since=0&limit=1000')).json.events
    .filter((e) => e.entity_type === 'ladder_run' && e.payload.kind === 'email' && e.payload.person_id === p.id);
  assert.deepEqual(evs.filter((e) => e.payload.result === 'failed').map((e) => e.payload.reason), ['will_retry', 'will_retry', 'gave_up']);
  assert.equal(evs.filter((e) => e.payload.result === 'sending').length, 3, 'each try is claimed before the provider call');
  assert.ok((await personByEmail(mail('rae'))).tags.includes('after-retry'));
  await mgr.action('ladder.setActive', { id: lad.id, active: false });
});

test('off holds everyone in place and cancels their steps; on resumes from the same step', async () => {
  const hosts = await create({
    name: 'New hosts',
    trigger: { kind: 'tag', ref: 'host' },
    steps: [{ kind: 'wait', n: 2, unit: 'hours' }, { kind: 'tag', tag: 'host-welcomed' }],
  });
  // Gus was a host before the ladder was on.
  const gus = await mgr.createPerson('Gus Host', { tags: ['host'] });
  await turnOn(hosts.id);
  const eve = await mgr.createPerson('Eve Early');
  assert.equal((await mgr.action('person.update', { id: eve.id, tags: ['host'] })).status, 200);
  assert.equal((await mgr.action('person.update', { id: gus.id, tags: ['host', 'VIP'] })).status, 200);
  assert.ok(await runOf(hosts.id, eve.id), 'got the tag → on the ladder');
  assert.equal(await runOf(hosts.id, gus.id), undefined, 'already had the tag → not "got" it');

  await runJobs();
  let run = await runOf(hosts.id, eve.id);
  assert.equal(run.wait, 'time');
  const until = run.next_at;

  const off = await mgr.action('ladder.setActive', { id: hosts.id, active: false });
  assert.equal(off.json.paused, 1);
  run = await runOf(hosts.id, eve.id);
  assert.equal(run.status, 'paused');
  assert.equal(run.step, 1, 'holds its place');
  const cancelled = (await db.query(
    "select count(*)::int as n from jobs where workspace_id = $1 and kind = 'ladder.step' and status = 'cancelled' and payload->>'ladder_id' = $2",
    [ws, hosts.id],
  )).rows[0].n;
  assert.equal(cancelled, 1, 'its pending step is cancelled');
  await fastForward();
  await runJobs();
  let tags = (await db.query('select tags from persons where id = $1', [eve.id])).rows[0].tags;
  assert.ok(!tags.includes('host-welcomed'), 'nothing runs while off');
  // While off, getting the tag puts no one on.
  const fay = await mgr.createPerson('Fay Later');
  await mgr.action('person.update', { id: fay.id, tags: ['host'] });
  assert.equal(await runOf(hosts.id, fay.id), undefined);

  const on = await mgr.action('ladder.setActive', { id: hosts.id, active: true });
  assert.equal(on.json.resumed, 1);
  run = await runOf(hosts.id, eve.id);
  assert.equal(run.status, 'active');
  assert.equal(run.step, 1);
  assert.equal(new Date(run.next_at).getTime(), new Date(until).getTime(), 'the wait still ends when it would have');
  const pend = (await db.query(
    "select run_at from jobs where workspace_id = $1 and kind = 'ladder.step' and status = 'pending' and payload->>'run_id' = $2",
    [ws, run.id],
  )).rows;
  assert.equal(pend.length, 1);
  assert.ok(Math.abs(new Date(pend[0].run_at) - new Date(until)) < 2000);
  await fastForward();
  await runJobs();
  run = await runOf(hosts.id, eve.id);
  assert.equal(run.status, 'done');
  tags = (await db.query('select tags from persons where id = $1', [eve.id])).rows[0].tags;
  assert.ok(tags.includes('host-welcomed'));
  await mgr.action('ladder.setActive', { id: hosts.id, active: false });
  await verified();
});

test('each trigger: volunteer page, RSVP, first donation only, a 1 or 2 from a volunteer; imports never', async () => {
  const ev = await mgr.action('cevent.create', {
    slug: `town-hall-${tag}`, title: 'Town hall', starts_at: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 16),
  });
  assert.equal(ev.status, 200);
  const mk = async (name, trigger) => {
    const l = await create({ name, trigger, steps: [{ kind: 'tag', tag: `t-${name}` }] });
    await turnOn(l.id);
    return l;
  };
  const vol = await mk('vol', { kind: 'volunteer' });
  const rsvp = await mk('rsvp', { kind: 'rsvp', ref: ev.json.event.id });
  const anyRsvp = await mk('anyrsvp', { kind: 'rsvp' });
  const gift = await mk('gift', { kind: 'donation' });
  const rated = await mk('rated', { kind: 'rating' });
  const tagged = await mk('tagged', { kind: 'tag', ref: 'imported' });

  // Volunteer page: a new person, and an existing one who ticks roles.
  await pub('POST', `/v/${slug}`, new URLSearchParams({ name: 'Vic New', email: mail('vic'), roles: 'phoning' }));
  const vic = await personByEmail(mail('vic'));
  const wes = await mgr.createPerson('Wes Known', { email: mail('wes') });
  await pub('POST', '/api/public/' + slug + '/signup', { kind: 'volunteer', name: 'Wes Known', email: mail('wes'), roles: ['driver'] });
  assert.ok(await runOf(vol.id, vic.id), 'new volunteer from the page');
  assert.ok(await runOf(vol.id, wes.id), 'known person through the website bridge');
  assert.equal((await ladder(vol.id)).people.filter((p) => p.person.id === vic.id).length, 1, 'once');

  // RSVP on the public page.
  await pub('POST', `/e/${slug}/town-hall-${tag}`, new URLSearchParams({ name: 'Rita Rsvp', email: mail('rita') }));
  const rita = await personByEmail(mail('rita'));
  assert.ok(await runOf(rsvp.id, rita.id), 'that event');
  assert.ok(await runOf(anyRsvp.id, rita.id), 'any event');

  // First donation only.
  const don = await mgr.createPerson('Don Donor');
  const today = new Date().toISOString().slice(0, 10);
  await mgr.action('gift.log', { person_id: don.id, amount_cents: 2500, date: today });
  await mgr.action('gift.log', { person_id: don.id, amount_cents: 2500, date: today });
  assert.equal((await ladder(gift.id)).people.filter((p) => p.person.id === don.id).length, 1);
  const old = await mgr.createPerson('Olga Olddonor');
  await mgr.action('ladder.setActive', { id: gift.id, active: false });
  await mgr.action('gift.log', { person_id: old.id, amount_cents: 1000, date: today });
  await mgr.action('ladder.setActive', { id: gift.id, active: true });
  await mgr.action('gift.log', { person_id: old.id, amount_cents: 1000, date: today });
  assert.equal(await runOf(gift.id, old.id), undefined, 'a second gift is not a first donation');

  // A volunteer rates someone 2 at the door: they're put on, and the volunteer's answer says nothing of it.
  const inv = await mgr.action('member.invite', { email: mail('jas'), role: 'volunteer' });
  const v = new Client();
  await v.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Jas Vol', password: 'knock-knock-2026' });
  const door = await mgr.createPerson('Dora Door', { address: '12345 72 Ave' });
  const knock = await v.action('contact.log', { person_id: door.id, channel: 'door', outcome: 'contacted', rating: '2' });
  assert.equal(knock.status, 200);
  assert.ok(!JSON.stringify(knock.json).includes('ladder'), 'nothing about ladders in a volunteer’s answer');
  assert.ok(await runOf(rated.id, door.id));
  const three = await mgr.createPerson('Tre Undecided');
  await v.action('contact.log', { person_id: three.id, channel: 'phone', outcome: 'contacted', rating: '3' });
  assert.equal(await runOf(rated.id, three.id), undefined, 'a 3 is not a yes');
  // A talked knock first ("Save answers"), then the 1 that finishes that same visit: on the ladder too.
  const vee = await mgr.createPerson('Vee Visit', { address: '12390 72 Ave' });
  const first = 'cafe0000-0000-4000-8000-0000000000a1';
  assert.equal((await v.action('contact.log', { person_id: vee.id, channel: 'door', outcome: 'contacted', client_id: first })).status, 200);
  assert.equal(await runOf(rated.id, vee.id), undefined, 'no rating yet');
  const fin = await v.action('contact.log', {
    person_id: vee.id, channel: 'door', outcome: 'contacted', rating: '1', client_id: 'cafe0000-0000-4000-8000-0000000000a2', visit_of: first,
  });
  assert.equal(fin.json.amended, true);
  assert.ok(await runOf(rated.id, vee.id), 'the rating that finished the visit counts');

  // An import with a tag starts nothing.
  const imp = await mgr.post('/api/data/import', { rows: [{ name: 'Ivy Import', email: mail('ivy') }], tag: 'imported' });
  assert.equal(imp.status, 200, JSON.stringify(imp.json));
  const ivy = await personByEmail(mail('ivy'));
  assert.equal(await runOf(tagged.id, ivy.id), undefined, 'imports never start a ladder');

  await runJobs();
  for (const l of [vol, rsvp, anyRsvp, gift, rated, tagged]) await mgr.action('ladder.setActive', { id: l.id, active: false });
  await verified();
});

test('a new signer who ticks "Email me updates" has joined the newsletter too', async () => {
  const news = await create({ name: 'News via petition', trigger: { kind: 'newsletter' }, steps: [{ kind: 'tag', tag: 'nl-welcomed' }] });
  await turnOn(news.id);
  await pub('POST', `/p/${slug}/fix-72-${tag}`, new URLSearchParams({ name: 'Pia Petition', email: mail('pia'), subscribe: '1' }));
  await pub('POST', `/p/${slug}/fix-72-${tag}`, new URLSearchParams({ name: 'Quin Quiet', email: mail('quin') }));
  const pia = await personByEmail(mail('pia'));
  const quin = await personByEmail(mail('quin'));
  assert.ok(await runOf(news.id, pia.id), 'ticked → joined the newsletter');
  assert.equal(await runOf(news.id, quin.id), undefined, 'did not tick → not on it');
  await mgr.action('ladder.setActive', { id: news.id, active: false });
});

test('a tag one ladder adds can start another — never the same one again', async () => {
  const warm = await create({ name: 'Warm', trigger: { kind: 'tag', ref: 'warm' }, steps: [{ kind: 'untag', tag: 'warm' }, { kind: 'tag', tag: 'warmed' }], reentry: true });
  const yes = await create({ name: 'Yes to warm', trigger: { kind: 'rating' }, steps: [{ kind: 'tag', tag: 'warm' }] });
  await turnOn(warm.id);
  await turnOn(yes.id);
  const p = await mgr.createPerson('Sol Chain');
  await mgr.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating: '2' });
  await runJobs();
  const w = await runOf(warm.id, p.id);
  assert.ok(w, 'the Yes ladder’s tag put them on Warm');
  assert.equal(w.status, 'done');
  const evs = (await mgr.get('/api/events?since=0&limit=1000')).json.events
    .filter((e) => e.entity_type === 'ladder_run' && e.op === 'create' && e.payload.ladder_id === warm.id && e.payload.person_id === p.id);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].action, 'ladder.step');
  const tags = (await db.query('select tags from persons where id = $1', [p.id])).rows[0].tags;
  assert.ok(tags.includes('warmed') && !tags.includes('warm'));
  // Tagged warm again by hand: Warm lets people through again.
  await mgr.action('person.update', { id: p.id, tags: [...tags, 'warm'] });
  await runJobs();
  assert.equal((await ladder(warm.id)).people.filter((r) => r.person.id === p.id).length, 2);

  // A ladder that puts back its own trigger tag never loops.
  const loop = await create({ name: 'Loop', trigger: { kind: 'tag', ref: 'loop' }, steps: [{ kind: 'untag', tag: 'loop' }, { kind: 'tag', tag: 'loop' }], reentry: true });
  await turnOn(loop.id);
  const q = await mgr.createPerson('Lou Loop');
  await mgr.action('person.update', { id: q.id, tags: ['loop'] });
  assert.ok(await runJobs() <= 3, 'two steps, no more');
  const loops = (await ladder(loop.id)).people.filter((r) => r.person.id === q.id);
  assert.deepEqual(loops.map((r) => r.status), ['done']);
  for (const l of [warm, yes, loop]) await mgr.action('ladder.setActive', { id: l.id, active: false });
  await verified();
});

test('engagement level follows what people did', async () => {
  const lev = async (id) => (await mgr.get(`/api/persons/${id}/ladders`)).json.level;
  const p = await mgr.createPerson('Lev Climber', { email: mail('lev') });
  assert.equal((await lev(p.id)).code, 'contact');
  await mgr.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating: '1' });
  assert.equal((await lev(p.id)).code, 'supporter');
  await mgr.action('subscription.add', { email: mail('lev') });
  assert.equal((await lev(p.id)).code, 'signer');
  await mgr.action('gift.log', { person_id: p.id, amount_cents: 500, date: new Date().toISOString().slice(0, 10) });
  let l = await lev(p.id);
  assert.deepEqual([l.code, l.label], ['doer', 'Donor']);
  await mgr.action('volunteer.assign', { person_id: p.id, role: 'phoning' });
  assert.equal((await lev(p.id)).label, 'Donor · Volunteer');
  await mgr.action('volunteer.assign', { person_id: p.id, role: 'highrise_captain', detail: 'The Ultra' });
  l = await lev(p.id);
  assert.deepEqual([l.code, l.label], ['leader', 'Leader']);

  const prof = (await mgr.get(`/api/persons/${p.id}/ladders`)).json;
  assert.ok(Array.isArray(prof.runs));
  const levels = (await mgr.get('/api/ladders')).json.levels;
  assert.deepEqual(levels.map((x) => x.code), ['contact', 'supporter', 'signer', 'doer', 'leader']);
  assert.ok(levels.find((x) => x.code === 'leader').n >= 1);
  const total = levels.reduce((s, x) => s + x.n, 0);
  const people = (await db.query('select count(*)::int as n from persons where workspace_id = $1 and deleted_at is null', [ws])).rows[0].n;
  assert.equal(total, people, 'everyone is at exactly one level');
});

test('volunteers can read none of it and change none of it', async () => {
  const inv = await mgr.action('member.invite', { email: mail('vol2'), role: 'volunteer' });
  const v = new Client();
  const j = await v.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Val Vol', password: 'knock-knock-2026' });
  assert.ok(j.status === 200 || j.status === 201, JSON.stringify(j.json));
  const ana = await personByEmail(mail('ana'));
  for (const path of ['/api/ladders', `/api/ladders/${thanks.id}`, '/api/ladders/followups', '/api/ladders/followups/count', `/api/persons/${ana.id}/ladders`]) {
    const r = await v.get(path);
    assert.equal(r.status, 403, path);
    assert.ok(!JSON.stringify(r.json).includes('Thank'), `nothing leaks from ${path}`);
  }
  for (const [name, input] of [
    ['ladder.create', { name: 'x', trigger: { kind: 'rating' } }],
    ['ladder.setActive', { id: thanks.id, active: false }],
    ['ladder.update', { id: thanks.id, name: 'x' }],
    ['ladder.delete', { id: thanks.id }],
  ]) assert.equal((await v.action(name, input)).status, 403, name);
  const fu = (await mgr.get('/api/ladders/followups')).json.open[0];
  assert.equal((await v.action('ladder.followupDone', { id: fu.id })).status, 403);
  assert.ok(!(await v.get('/api/actions')).json.actions.some((a) => a.startsWith('ladder.')));
  // The person a volunteer can open carries nothing of ladders.
  const prof = await v.get(`/api/persons/${ana.id}`);
  assert.equal(prof.status, 200);
  assert.ok(!/ladder|thanked-by|follow/i.test(JSON.stringify(Object.keys(prof.json))));
});

test('follow-ups: done and undone; delete a ladder; another campaign sees nothing', async () => {
  const fu = (await mgr.get('/api/ladders/followups')).json.open[0];
  const before = (await mgr.get('/api/ladders/followups/count')).json.open;
  const done = await mgr.action('ladder.followupDone', { id: fu.id });
  assert.equal(done.json.status, 'done');
  assert.equal((await mgr.get('/api/ladders/followups/count')).json.open, before - 1);
  assert.ok((await mgr.get('/api/ladders/followups')).json.done.some((f) => f.id === fu.id));
  const undo = await mgr.action('ladder.followupDone', { id: fu.id, done: false });
  assert.equal(undo.json.status, 'open');
  assert.equal((await mgr.get('/api/ladders/followups/count')).json.open, before);

  const other = new Client();
  await other.signup({ workspaceName: `Other ${tag}`, email: mail('other') });
  assert.equal((await other.get(`/api/ladders/${thanks.id}`)).status, 404);
  assert.equal((await other.action('ladder.setActive', { id: thanks.id, active: false })).status, 404);
  assert.equal((await other.action('ladder.followupDone', { id: fu.id })).status, 404);
  assert.equal((await other.get('/api/ladders')).json.ladders.length, 0);

  // Refusals: a ladder that does nothing can't go on; a tag trigger needs a tag; another campaign's petition.
  const empty = await create({ name: 'Empty', trigger: { kind: 'newsletter' } });
  assert.equal((await mgr.action('ladder.setActive', { id: empty.id, active: true })).status, 400);
  assert.equal((await mgr.action('ladder.create', { name: 'No tag', trigger: { kind: 'tag' } })).status, 400);
  assert.equal((await other.action('ladder.create', { name: 'X', trigger: { kind: 'petition', ref: `fix-72-${tag}` } })).status, 400);

  const del = await mgr.action('ladder.delete', { id: thanks.id });
  assert.equal(del.status, 200);
  assert.equal((await mgr.get(`/api/ladders/${thanks.id}`)).status, 404);
  assert.ok(!(await mgr.get('/api/ladders')).json.ladders.some((l) => l.id === thanks.id));
  assert.ok((await mgr.get('/api/ladders/followups')).json.open.some((f) => f.id === fu.id), 'its follow-ups stay');
  await verified();
});
