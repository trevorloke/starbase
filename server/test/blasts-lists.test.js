// Email blasts and text blasts to a list (ext/lists): an email blast
// reaches everyone on the list who may be emailed, each copy with its own
// unsubscribe link (/bu) that tags the address do-not-email; a text blast
// reaches everyone with a number that can be texted, through the
// campaign's Twilio number, inside quiet hours, "Reply STOP to opt out" on
// each, filed in the Inbox as the sender's conversations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runDueJobs } from '../lib/jobs.js';
import { _setClockForTest } from '../ext/texting/rules.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.bl.${tag}@example.org`;
let db;
let mgr;
let ws;
let list;
const people = {};

const ENV = ['RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'STARBASE_PUBLIC_URL'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const emails = [];
const texts = [];
let sidN = 0;
const stubProviders = () => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.TWILIO_ACCOUNT_SID = `ACtest${tag}`;
  process.env.TWILIO_AUTH_TOKEN = `tok${tag}`;
  process.env.TWILIO_FROM = '+16045550100';
  process.env.STARBASE_PUBLIC_URL = 'https://starbase.example';
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.resend.com/')) { emails.push(JSON.parse(init.body)); return new Response('{"id":"msg"}', { status: 200 }); }
    if (u.startsWith('https://api.twilio.com/')) {
      texts.push(Object.fromEntries(new URLSearchParams(String(init.body || ''))));
      return new Response(JSON.stringify({ sid: `SM${tag}${++sidN}`, status: 'queued' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
};
const NOON = new Date('2026-10-22T19:00:00Z'); // noon in Surrey
const at = (iso) => _setClockForTest(() => new Date(iso));
const pub = async (method, path) => {
  const res = await app.request(path, { method, headers: { 'x-forwarded-for': '203.0.113.9' } });
  return { status: res.status, text: await res.text() };
};
const blastOf = async (id) => (await mgr.get('/api/blasts')).json.blasts.find((b) => b.id === id);

before(async () => {
  db = await freshDb();
  stubProviders();
  _setClockForTest(() => NOON);
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Imagine Surrey', email: mail('manager') });
  ws = r.json.workspace.id;
  const mk = async (name, extra) => { people[name] = await mgr.createPerson(name, extra); };
  await mk('Anne Member', { email: mail('anne'), phone: '604-555-0101', tags: ['member'] });
  await mk('Bob Member', { email: mail('bob'), phone: '604-555-0102', tags: ['member', 'do-not-email'] });
  await mk('Cara Member', { phone: '604-555-0103', tags: ['member', 'do-not-text'] });
  await mk('Dev Member', { email: mail('dev'), phone: '604-555-0104', tags: ['member'] });
  await mk('Eve Other', { email: mail('eve'), phone: '604-555-0105', tags: ['volunteer'] });
  list = (await mgr.action('list.create', { name: 'Members', kind: 'filter', filter: { tag: 'member' } })).json.list;
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  _setClockForTest(null);
});

test('an email blast to a list: everyone who may be emailed, each with their own unsubscribe link; the list is on the send', async () => {
  assert.equal((await mgr.action('blast.send', { kind: 'eblast', subject: '', body: 'Hi', audience: { list_id: list.id } })).status, 400, 'a subject is required');
  const r = await mgr.action('blast.send', { kind: 'eblast', subject: 'Members: the AGM', body: 'See you **Saturday**.', audience: { list_id: list.id } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.blast.audience_count, 2, 'Anne and Dev; Bob is do-not-email; Cara has no address');
  assert.equal(r.json.blast.list_name, 'Members');
  assert.equal(emails.length, 2);
  assert.deepEqual(emails.map((m) => m.to[0]).sort(), [mail('anne'), mail('dev')]);
  const m = emails[0];
  assert.match(m.html, /<strong>Saturday<\/strong>/);
  const link = /href="(https:\/\/starbase\.example\/bu\/[0-9a-f-]{36})"/.exec(m.html)?.[1];
  assert.ok(link, 'the unsubscribe link');
  assert.equal(m.headers['List-Unsubscribe'], `<${link}>`);
  const listed = await blastOf(r.json.blast.id);
  assert.equal(listed.status, 'sent');
  assert.equal(listed.audience.list_name, 'Members');
  assert.deepEqual(listed.audience.filter, { tag: 'member' });
  // The link asks, then does: the address is do-not-email from now on.
  const path = new URL(link).pathname;
  assert.equal((await pub('GET', path)).status, 200);
  const done = await pub('POST', path);
  assert.equal(done.status, 200);
  assert.match(done.text, /Unsubscribed/);
  const who = m.to[0] === mail('anne') ? 'Anne Member' : 'Dev Member';
  const p = (await mgr.get(`/api/persons/${people[who].id}`)).json.person;
  assert.ok(p.tags.includes('do-not-email'));
  // The next blast leaves them out.
  const again = await mgr.action('blast.send', { kind: 'eblast', subject: 'Again', body: 'Hi', audience: { list_id: list.id } });
  assert.equal(again.json.blast.audience_count, 1);
  // By a filter, no list saved.
  const byFilter = await mgr.action('blast.send', { kind: 'eblast', subject: 'Volunteers', body: 'Thanks', audience: { filter: { tag: 'volunteer' } } });
  assert.equal(byFilter.status, 200, JSON.stringify(byFilter.json));
  assert.equal(byFilter.json.blast.audience_count, 1);
  assert.equal((await mgr.action('blast.send', { kind: 'eblast', subject: 'Nobody', body: 'Hi', audience: { filter: { tag: 'nobody-has-this' } } })).status, 400);
  assert.equal((await mgr.action('blast.send', { kind: 'eblast', subject: 'x', body: 'y', audience: { list_id: '00000000-0000-4000-8000-000000000000' } })).status, 404);
});

test('a text blast: the rules, then one text each through the campaign number, filed in the Inbox; opt-outs left out', async () => {
  const bad = (input) => mgr.action('blast.send', { kind: 'text', audience: { list_id: list.id }, ...input });
  assert.equal((await bad({ body: 'Rally Saturday at Holland Park!' })).status, 400, 'must name the campaign');
  assert.equal((await bad({ body: `Imagine Surrey: ${'x'.repeat(1100)}` })).status, 400, 'too long');
  assert.equal((await bad({ body: 'Hi {{first_name}}, Imagine Surrey here' })).status, 400, 'blanks');
  assert.equal((await bad({ body: 'Imagine Surrey rally', subject: 'A', ab: { subject_b: 'B', pct: 10, wait_hours: 1, metric: 'opens' } })).status, 400, 'no A/B on a text');
  // Dev replied STOP earlier.
  await db.query(`insert into texting_optouts (id, workspace_id, phone, opted_out, keyword) values ($1, $2, '+16045550104', true, 'stop')`, [crypto.randomUUID(), ws]);
  const r = await mgr.action('blast.send', { kind: 'text', body: 'Imagine Surrey here: rally Saturday at Holland Park, 2 pm.', audience: { list_id: list.id } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.blast.audience_count, 2, 'Anne and Bob; Cara is do-not-text; Dev replied STOP');
  assert.equal(r.json.blast.subject, 'Imagine Surrey here: rally Saturday at Holland Park, 2 pm.');
  assert.equal(texts.length, 2);
  assert.deepEqual(texts.map((t) => t.To).sort(), ['+16045550101', '+16045550102']);
  assert.equal(texts[0].From, '+16045550100');
  assert.match(texts[0].Body, /Reply STOP to opt out$/);
  assert.match(texts[0].StatusCallback, /\/api\/public\/twilio\/sms-status\//);
  const listed = await blastOf(r.json.blast.id);
  assert.equal(listed.status, 'sent');
  assert.equal(listed.sent_count, 2);
  // In the Inbox: a conversation per person, the sender's, with the text as its first.
  const convs = (await mgr.get('/api/texting/all')).json;
  const mine = (convs.conversations || []).filter((c) => ['Anne Member', 'Bob Member'].includes(c.person_name || c.name));
  assert.equal(mine.length, 2, JSON.stringify(convs).slice(0, 300));
  const msgs = (await db.query('select first, status, body from texting_messages where workspace_id = $1 order by created_at', [ws])).rows;
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every((x) => x.first && x.status === 'sent'));
  assert.equal((await mgr.get('/api/blasts')).json.textConfigured, true);
});

test('quiet hours: a text blast waits, and the send job sends it when texting opens', async () => {
  at('2026-10-23T06:30:00Z'); // 11:30 pm the night before, in Surrey
  const before = texts.length;
  const r = await mgr.action('blast.send', { kind: 'text', body: 'Imagine Surrey: doors open at 9.', audience: { filter: { tag: 'volunteer' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(texts.length, before, 'nothing went');
  const held = await blastOf(r.json.blast.id);
  assert.equal(held.status, 'queued');
  assert.match(held.provider_note, /Quiet hours — sending opens at 9 am/);
  assert.equal(held.going_count, 1, 'on its way once texting opens');
  const job = (await db.query(`select run_at from jobs where workspace_id = $1 and kind = 'abtests.send' and status = 'pending' order by created_at desc limit 1`, [ws])).rows[0];
  assert.ok(job && new Date(job.run_at) > new Date('2026-10-23T06:30:00Z'), 'the send job is due when texting opens');
  // Morning: the job runs and the text goes.
  at('2026-10-23T16:30:00Z'); // 9:30 am
  await db.query(`update jobs set run_at = now() where workspace_id = $1 and kind = 'abtests.send' and status = 'pending'`, [ws]);
  await runDueJobs(db, { workspaceId: ws });
  assert.equal(texts.length, before + 1);
  assert.equal(texts.at(-1).To, '+16045550105');
  assert.equal((await blastOf(r.json.blast.id)).status, 'sent');
});
