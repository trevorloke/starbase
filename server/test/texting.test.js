// Texting and calls through the campaign's Twilio number: nothing pretends
// to send without Twilio; webhooks must be signed; the first text names the
// campaign and carries the STOP line; STOP opts out at once and for good
// (START undoes it); quiet hours are the server's; volunteers only ever
// receive their own conversations; a call's token works once and briefly,
// and the person sees the campaign's number. Twilio is a stubbed fetch with
// TWILIO_* set inside these tests and restored after.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { app } from '../index.js';
import { verifyChain } from '../lib/events.js';
import { twilioSignature } from '../ext/texting/twilio.js';
import { _setClockForTest, keywordOf, asksToStop, quietNow, e164 } from '../ext/texting/rules.js';
import { randomUUID } from 'node:crypto';

const tag = Math.random().toString(36).slice(2, 8);
const PUBLIC = 'https://starbase.example';
const TOKEN = `test-token-${tag}`;
const CAMPAIGN_NUMBER = '+16045550100';
const ENV = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'STARBASE_PUBLIC_URL', 'TWILIO_API_BASE', 'TWILIO_VOICE'];
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;

// Every request the app made to "Twilio", and what the stub answers.
const twilio = [];
let reply = null; // (req) => { status, body } — default: accepted
let sidN = 0;
const connect = () => {
  process.env.TWILIO_ACCOUNT_SID = `ACtest${tag}`;
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  process.env.TWILIO_FROM = CAMPAIGN_NUMBER;
  process.env.STARBASE_PUBLIC_URL = PUBLIC;
  delete process.env.TWILIO_API_BASE;
  delete process.env.TWILIO_VOICE;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.twilio.com/')) return realFetch(url, init);
    const form = Object.fromEntries(new URLSearchParams(String(init.body || '')));
    const req = { url: u, kind: u.endsWith('/Calls.json') ? 'call' : 'sms', form, auth: init.headers?.Authorization };
    twilio.push(req);
    const r = reply ? reply(req) : { status: 201, body: { sid: `${req.kind === 'call' ? 'CA' : 'SM'}${tag}${++sidN}`, status: 'queued' } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
};
const disconnect = () => {
  for (const k of ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  globalThis.fetch = realFetch;
};
const texts = () => twilio.filter((r) => r.kind === 'sms');
const calls = () => twilio.filter((r) => r.kind === 'call');

// A signed (or not) form post, as Twilio sends it.
const hook = async (path, fields, { sign = true, token = TOKEN, url = `${PUBLIC}${path}`, signFields = fields } = {}) => {
  const params = new URLSearchParams(fields);
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = twilioSignature(token, url, new URLSearchParams(signFields));
  const res = await app.request(path, { method: 'POST', headers, body: params.toString() });
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
};
let msgN = 0;
const inbound = (from, body, extra = {}) => hook('/api/public/twilio/sms', {
  From: from, To: CAMPAIGN_NUMBER, Body: body, MessageSid: `SMin${tag}${++msgN}`, AccountSid: `ACtest${tag}`, ...extra,
});

// Noon in Surrey (PDT, UTC−7) unless a test says otherwise.
const NOON = new Date('2026-10-22T19:00:00Z');
const at = (iso) => _setClockForTest(() => new Date(iso));

let db, ws, campaign, desk, vol, staff, P;

const joinAs = async (client, role, name = role === 'volunteer' ? 'Val Volunteer' : 'Sam Staff', key = role) => {
  const r = await client.signup({ name, workspaceName: `Temp ${tag}`, email: `${key}+${tag}@texting.example` });
  await db.query('update memberships set workspace_id = $2, role = $3 where user_id = $1', [r.json.user.id, ws, role]);
  await db.query('update sessions set workspace_id = $2 where user_id = $1', [r.json.user.id, ws]);
  return r.json.user;
};

before(async () => {
  db = await freshDb();
  disconnect(); // start with no provider, whatever the shell had
  _setClockForTest(() => NOON);
  desk = new Client();
  const r = await desk.signup({ workspaceName: `Imagine Surrey ${tag}`, email: `desk+${tag}@texting.example`, jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  campaign = r.json.workspace.name;
  vol = new Client();
  await joinAs(vol, 'volunteer');
  staff = new Client();
  await joinAs(staff, 'staff');
  P = {};
  const mk = async (key, name, phone, extra = {}) => { P[key] = await desk.createPerson(name, { phone, ...extra }); };
  await mk('harjit', 'Harjit Example', '604-555-0131', { email: `harjit+${tag}@example.org` });
  await mk('maya', 'Maya Example', '(604) 555-0132');
  await mk('tom', 'Tom Example', '604 555 0133', { email: `tom+${tag}@example.org` });
  await mk('grace', 'Grace Example', '+1 604-555-0134', { email: `grace+${tag}@example.org` });
  await mk('dev', 'Dev Example', '604-555-0135');
  await mk('ana', 'Ana Example', '604-555-0136');
  await mk('lin', 'Lin Example', '604-555-0137');
  await mk('none', 'No Phone Example');
});

after(() => { disconnect(); _setClockForTest(null); });

test('the rules: numbers, keywords', () => {
  assert.equal(e164('604-555-0131'), '+16045550131');
  assert.equal(e164('(604) 555 0131 ext 2'), '+16045550131');
  assert.equal(e164('1 604 555 0131'), '+16045550131');
  assert.equal(e164('555-0131'), null);
  for (const w of ['STOP', 'stop', 'Stop.', ' STOPALL ', 'unsubscribe', 'Cancel', 'END', 'quit!']) assert.equal(keywordOf(w), 'stop', w);
  for (const w of ['START', 'unstop']) assert.equal(keywordOf(w), 'start', w);
  for (const w of ['Stop by the office?', 'yes', 'I will not stop supporting you', '']) assert.equal(keywordOf(w), null, w);
  // Emoji and punctuation don't hide a STOP; a clear request is one too.
  for (const w of ['STOP 🙏', 'Please stop texting me', 'Stop it', 'Don’t text me', 'remove me.']) assert.equal(keywordOf(w), 'stop', w);
  // Not only a keyword, but asks to stop: flagged for a person, not automatic.
  for (const w of ['No thanks, stop', 'Please stop texting me now', 'unsubscribe me from this list']) {
    assert.equal(keywordOf(w), null, w);
    assert.equal(asksToStop(w), true, w);
  }
  for (const w of ['STOP', 'yes', 'Count me in!']) assert.equal(asksToStop(w), false, w);
});

test('quiet hours: one window Monday to Friday, a narrower one on weekends', () => {
  const s = { allow_from: 9, allow_until: 21, weekend_from: 10, weekend_until: 18 };
  const tz = 'America/Vancouver';
  assert.deepEqual(
    [quietNow(s, new Date('2026-10-22T19:00:00Z'), tz).now, quietNow(s, new Date('2026-10-22T19:00:00Z'), tz).label],
    [false, '9 am–9 pm'], 'Thursday noon',
  );
  const satEarly = quietNow(s, new Date('2026-10-24T16:30:00Z'), tz); // Saturday 9:30 am
  assert.equal(satEarly.now, true);
  assert.equal(satEarly.label, '10 am–6 pm');
  assert.equal(satEarly.opens, '10 am');
  assert.equal(quietNow(s, new Date('2026-10-25T00:30:00Z'), tz).now, false, 'Saturday 5:30 pm');
  assert.equal(quietNow(s, new Date('2026-10-25T01:30:00Z'), tz).opens, '10 am tomorrow', 'Saturday 6:30 pm → Sunday');
  assert.equal(quietNow(s, new Date('2026-10-24T05:30:00Z'), tz).opens, '10 am tomorrow', 'Friday 10:30 pm → Saturday');
  assert.equal(quietNow(s, new Date('2026-10-26T05:30:00Z'), tz).opens, '9 am tomorrow', 'Sunday 10:30 pm → Monday');
});

test('without Twilio: the screens are told so and nothing pretends to send', async () => {
  const s = await vol.get('/api/texting/status');
  assert.equal(s.status, 200);
  assert.equal(s.json.sms, false);
  assert.equal(s.json.voice, false);
  const t = await vol.action('text.send', { person_id: P.harjit.id, body: `Hi Harjit, it's Vol with ${campaign}.` });
  assert.equal(t.status, 409);
  assert.equal(t.json.error, 'Texting isn’t connected');
  const c = await vol.action('call.start', { person_id: P.harjit.id, my_phone: '604-555-0170' });
  assert.equal(c.status, 409);
  assert.equal(c.json.error, 'Calling through the campaign isn’t connected');
  // No auth token: no webhook can be verified, so none is accepted.
  const h = await inbound('+16045550131', 'hello');
  assert.equal(h.status, 403);
  assert.equal(twilio.length, 0, 'no provider was called');
  assert.equal((await db.query('select count(*)::int as n from texting_messages where workspace_id = $1', [ws])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from texting_member_phones where workspace_id = $1', [ws])).rows[0].n, 0,
    'a refused call stores nothing');
});

test('the first text names the campaign and ends "Reply STOP to opt out"; later texts do not', async () => {
  connect();
  const s = await desk.get('/api/texting/status');
  assert.equal(s.json.sms, true);
  assert.equal(s.json.voice, true);
  assert.match(s.json.template, /\{\{first_name\}\}/);
  let r = await desk.action('text.send', { person_id: P.harjit.id, body: 'Hi Harjit, can we count on you?' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Say it's .* in the first text/);
  r = await desk.action('text.send', { person_id: P.harjit.id, body: `Hi {{first_name}}, it's Desk with ${campaign}.` });
  assert.equal(r.status, 400, 'an unfilled template is never sent');
  assert.equal(texts().length, 0);
  const card = await desk.get(`/api/texting/people/${P.harjit.id}`);
  assert.equal(card.json.first, true);

  r = await desk.action('text.send', { person_id: P.harjit.id, body: `Hi Harjit, it's Desk with ${campaign}. Can we count on you?` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sent, true);
  assert.equal(r.json.message.first, true);
  const first = texts().at(-1);
  assert.equal(first.form.To, '+16045550131');
  assert.equal(first.form.From, CAMPAIGN_NUMBER, 'from the campaign number');
  assert.ok(first.form.Body.includes(campaign));
  assert.match(first.form.Body, /\nReply STOP to opt out$/);
  assert.equal(first.form.Body, r.json.message.body, 'the screen gets exactly what was sent');
  assert.equal(first.form.StatusCallback, `${PUBLIC}/api/public/twilio/sms-status/${r.json.message.id}`);

  r = await desk.action('text.send', { person_id: P.harjit.id, body: 'Thanks again!' });
  assert.equal(r.status, 200);
  assert.equal(r.json.message.first, false);
  assert.equal(texts().at(-1).form.Body, 'Thanks again!', 'no footer after the first');
  assert.equal((await desk.get(`/api/texting/people/${P.harjit.id}`)).json.first, false);

  // A first text that already ends with the line doesn't get it twice.
  r = await desk.action('text.send', { person_id: P.lin.id, body: `${campaign} here. Reply STOP to opt out` });
  assert.equal(r.status, 200);
  assert.equal((texts().at(-1).form.Body.match(/Reply STOP/g) || []).length, 1);
  r = await desk.action('text.send', { person_id: P.none.id, body: `Hi from ${campaign}` });
  assert.equal(r.status, 400, 'no number, no text');
});

test('webhooks: unsigned, wrongly signed or tampered requests are refused; a signed reply lands once', async () => {
  const before = (await db.query('select count(*)::int as n from texting_messages where workspace_id = $1', [ws])).rows[0].n;
  const fields = { From: '+16045550131', To: CAMPAIGN_NUMBER, Body: 'Yes, count me in', MessageSid: `SMx${tag}`, AccountSid: `ACtest${tag}` };
  assert.equal((await hook('/api/public/twilio/sms', fields, { sign: false })).status, 403, 'unsigned');
  assert.equal((await hook('/api/public/twilio/sms', fields, { token: 'not-the-token' })).status, 403, 'wrong token');
  assert.equal((await hook('/api/public/twilio/sms', fields, { signFields: { ...fields, Body: 'something else' } })).status, 403, 'tampered body');
  assert.equal((await hook('/api/public/twilio/sms', fields, { url: 'https://elsewhere.example/api/public/twilio/sms' })).status, 403, 'signed for another address');
  assert.equal((await db.query('select count(*)::int as n from texting_messages where workspace_id = $1', [ws])).rows[0].n, before);

  const ok = await hook('/api/public/twilio/sms', fields);
  assert.equal(ok.status, 200);
  assert.match(ok.type, /text\/xml/);
  assert.match(ok.text, /<Response><\/Response>/, 'nothing is sent back automatically');
  const again = await hook('/api/public/twilio/sms', fields);
  assert.equal(again.status, 200);
  const rows = (await db.query(`select * from texting_messages where workspace_id = $1 and direction = 'in'`, [ws])).rows;
  assert.equal(rows.length, 1, 'a retried delivery is stored once');
  assert.equal(rows[0].body, 'Yes, count me in');
  const mine = (await desk.get('/api/texting/mine')).json.conversations;
  const conv = mine.find((c) => c.person_id === P.harjit.id);
  assert.equal(conv.unread, true);
  assert.equal(conv.last.direction, 'in');
  assert.equal((await desk.get('/api/texting/status')).json.unread >= 1, true);
  // Delivery reports are signed too.
  const out = (await db.query(`select id, provider_sid from texting_messages where workspace_id = $1 and direction = 'out' order by created_at limit 1`, [ws])).rows[0];
  assert.equal((await hook(`/api/public/twilio/sms-status/${out.id}`, { MessageSid: out.provider_sid, MessageStatus: 'delivered' }, { sign: false })).status, 403);
  assert.equal((await hook(`/api/public/twilio/sms-status/${out.id}`, { MessageSid: out.provider_sid, MessageStatus: 'delivered' })).status, 204);
  assert.equal((await db.query('select status from texting_messages where id = $1', [out.id])).rows[0].status, 'delivered');
});

test('quiet hours are enforced on the server; only managers change them', async () => {
  at('2026-10-23T05:30:00Z'); // 10:30 pm in Surrey
  const n = twilio.length;
  const s = await vol.get('/api/texting/status');
  assert.equal(s.json.quiet.now, true);
  assert.equal(s.json.quiet.label, '9 am–9 pm');
  assert.equal(s.json.quiet.opens, '9 am tomorrow');
  let r = await desk.action('text.send', { person_id: P.harjit.id, body: 'Late one' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Quiet hours — sending opens at 9 am tomorrow/);
  const conv = (await desk.get(`/api/texting/people/${P.harjit.id}`)).json.conversation;
  r = await desk.action('text.reply', { conversation_id: conv.id, body: 'Late reply' });
  assert.equal(r.status, 409, 'replies too');
  r = await desk.action('call.start', { person_id: P.harjit.id, my_phone: '604-555-0171' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Quiet hours — calls open at 9 am tomorrow/);
  at('2026-10-22T15:30:00Z'); // 8:30 am
  r = await desk.action('text.send', { person_id: P.harjit.id, body: 'Early one' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /sending opens at 9 am$/);
  assert.equal(twilio.length, n, 'nothing went to Twilio');

  assert.equal((await vol.action('texting.settings', { allow_until: 24 })).status, 403);
  assert.equal((await staff.action('texting.settings', { allow_until: 24 })).status, 403);
  assert.equal((await desk.action('texting.settings', { allow_from: 22, allow_until: 21 })).status, 400);
  assert.equal((await desk.action('texting.settings', { template: 'Hi {{first_name}}!' })).status, 400, 'the template must name the campaign');
  // A code the Calls card can't fill in would make every first text refused.
  r = await desk.action('texting.settings', { template: 'Hi {first_name}, it’s {{my_name}} with {{campaign}}.' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /^\{first_name\} won’t fill in/);
  assert.equal((await desk.action('texting.settings', { template: 'Hi {{first_name}}, from {{campain}}.' })).status, 400);
  assert.equal((await desk.get('/api/texting/settings')).json.settings.template.includes('Hi {first_name},'), false, 'nothing saved');
  r = await desk.action('texting.settings', { allow_from: 8, allow_until: 23 });
  assert.equal(r.status, 200);
  assert.equal((await desk.action('text.send', { person_id: P.harjit.id, body: 'Early one' })).status, 200, '8:30 am is inside 8 am–11 pm');
  at('2026-10-23T05:30:00Z');
  assert.equal((await desk.action('text.send', { person_id: P.harjit.id, body: 'Late one' })).status, 200, '10:30 pm is inside 8 am–11 pm');
  r = await desk.action('texting.settings', { allow_from: 9, allow_until: 21 });
  assert.equal(r.status, 200);
  assert.equal((await desk.action('text.send', { person_id: P.harjit.id, body: 'Late one' })).status, 409, 'back to 9–9');

  // Weekends: 10 am–6 pm unless a manager changes it.
  at('2026-10-24T16:30:00Z'); // Saturday 9:30 am
  r = await desk.action('text.send', { person_id: P.harjit.id, body: 'Saturday one' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /sending opens at 10 am$/);
  const sat = (await desk.get('/api/texting/status')).json.quiet;
  assert.equal(sat.label, '10 am–6 pm');
  assert.equal(sat.weekdays, '9 am–9 pm');
  assert.equal(sat.weekends, '10 am–6 pm');
  assert.equal((await desk.action('texting.settings', { weekend_from: 18, weekend_until: 10 })).status, 400);
  assert.equal((await desk.action('texting.settings', { weekend_from: 9 })).status, 200);
  assert.equal((await desk.action('text.send', { person_id: P.harjit.id, body: 'Saturday one' })).status, 200, '9:30 am is inside 9 am–6 pm');
  at('2026-10-25T02:00:00Z'); // Saturday 7 pm
  assert.equal((await desk.action('text.send', { person_id: P.harjit.id, body: 'Saturday night' })).status, 409);
  assert.equal((await desk.action('texting.settings', { weekend_from: 10, weekend_until: 18 })).status, 200);
  assert.equal((await desk.get('/api/texting/settings')).json.settings.weekend_from, 10);
  _setClockForTest(() => NOON);
});

test('STOP opts the number out at once and for good; START opts it back in', async () => {
  const send = (body = `Hi Maya, it's Desk with ${campaign}.`) => desk.action('text.send', { person_id: P.maya.id, body });
  assert.equal((await send()).status, 200);
  const n = texts().length;
  assert.equal((await inbound('+16045550132', 'Stop')).status, 200);
  let maya = (await desk.get(`/api/persons/${P.maya.id}`)).json.person;
  assert.ok(maya.tags.includes('do-not-text'), 'tagged do-not-text');
  let r = await send('One more?');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /opted out/i);
  assert.equal(texts().length, n, 'no text went out, and nothing was sent back automatically');
  // Taking the tag off by hand doesn't undo their STOP.
  assert.equal((await desk.action('person.update', { id: P.maya.id, tags: [] })).status, 200);
  r = await send('One more?');
  assert.equal(r.status, 409);
  assert.match(r.json.error, /replied STOP/);
  const conv = (await desk.get(`/api/texting/people/${P.maya.id}`)).json;
  assert.equal(conv.opted_out, true);
  assert.equal((await desk.action('text.reply', { conversation_id: conv.conversation.id, body: 'Sorry!' })).status, 409);
  const thread = (await desk.get(`/api/texting/conversations/${conv.conversation.id}`)).json;
  assert.equal(thread.conversation.opted_out, true);
  assert.equal(thread.messages.at(-1).keyword, 'stop');

  assert.equal((await inbound('+16045550132', 'START')).status, 200);
  assert.equal((await desk.get(`/api/texting/people/${P.maya.id}`)).json.opted_out, false);
  assert.equal((await send('Welcome back')).status, 200);

  for (const word of ['STOPALL', 'unsubscribe', 'Cancel', 'END', 'QUIT']) {
    assert.equal((await inbound('+16045550132', word)).status, 200);
    maya = (await desk.get(`/api/persons/${P.maya.id}`)).json.person;
    assert.ok(maya.tags.includes('do-not-text'), `${word} tags do-not-text`);
    assert.equal((await send('Still there?')).status, 409, `${word} stops texts`);
    assert.equal((await inbound('+16045550132', 'unstop')).status, 200);
    maya = (await desk.get(`/api/persons/${P.maya.id}`)).json.person;
    assert.ok(!maya.tags.includes('do-not-text'), 'UNSTOP takes the tag off');
  }
  assert.equal((await inbound('+16045550132', 'Stop by the office?')).status, 200);
  assert.equal((await send('Sure — 10 am?')).status, 200, 'a sentence with "stop" in it is just a reply');
  // A tag set by the desk is honoured too.
  await desk.action('person.update', { id: P.ana.id, tags: ['do-not-contact'] });
  r = await desk.action('text.send', { person_id: P.ana.id, body: `Hi Ana, ${campaign} here.` });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /do not contact/);
});

test('volunteers only receive the conversations they started — and no emails', async () => {
  let r = await vol.action('text.send', { person_id: P.grace.id, body: `Hi Grace, it's Vol with ${campaign}.` });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const volConv = r.json.conversation_id;
  r = await desk.action('text.send', { person_id: P.tom.id, body: `Hi Tom, it's Desk with ${campaign}.` });
  const deskConv = r.json.conversation_id;

  const mine = await vol.get('/api/texting/mine');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.conversations.map((c) => c.id), [volConv]);
  assert.ok(!JSON.stringify(mine.json).includes('@'), 'no email in a volunteer\'s inbox');
  assert.equal((await vol.get('/api/texting/all')).status, 403);
  assert.equal((await vol.get(`/api/texting/people/${P.tom.id}/conversations`)).status, 403);
  assert.equal((await vol.get('/api/texting/settings')).status, 403);
  assert.equal((await vol.get(`/api/texting/conversations/${deskConv}`)).status, 404);
  assert.equal((await vol.action('text.reply', { conversation_id: deskConv, body: 'hi' })).status, 404);
  assert.equal((await vol.action('text.read', { conversation_id: deskConv })).status, 404);
  const card = await vol.get(`/api/texting/people/${P.tom.id}`);
  assert.equal(card.json.conversation, null, 'the card shows only your own conversation');
  assert.equal(card.json.first, true);
  assert.equal(card.json.in_touch, true, 'the campaign is already texting Tom');
  assert.equal(card.json.in_touch_id, null, 'but which conversation is the desk\'s to know');
  r = await vol.action('text.send', { person_id: P.tom.id, body: `Hi Tom, it's Vol with ${campaign}.` });
  assert.equal(r.status, 409, 'no second introduction from the same campaign number');
  assert.match(r.json.error, /Already texting with the campaign/);
  const thread = await vol.get(`/api/texting/conversations/${volConv}`);
  assert.equal(thread.status, 200);
  assert.ok(!JSON.stringify(thread.json).includes('@'), 'no email in a volunteer\'s thread');

  // The desk sees every conversation and can answer in a volunteer's.
  const all = (await desk.get('/api/texting/all')).json.conversations;
  assert.ok(all.some((c) => c.id === volConv) && all.some((c) => c.id === deskConv));
  assert.equal(all.find((c) => c.id === volConv).started_by_name, 'Val Volunteer');
  assert.equal((await desk.get(`/api/texting/conversations/${volConv}`)).status, 200);
  assert.equal((await staff.get(`/api/texting/all?person=${P.grace.id}`)).json.conversations.length, 1);

  // A reply comes to the volunteer who texted; reading it is logged once.
  await inbound('+16045550134', 'Who is this?');
  let s = (await vol.get('/api/texting/status')).json;
  assert.equal(s.unread, 1);
  assert.equal(s.conversations, 1);
  const seq = async () => (await db.query('select event_seq from workspaces where id = $1', [ws])).rows[0].event_seq;
  const s0 = Number(await seq());
  assert.equal((await vol.action('text.read', { conversation_id: volConv })).json.read, true);
  assert.equal(Number(await seq()), s0 + 1);
  assert.equal((await vol.action('text.read', { conversation_id: volConv })).json.read, false);
  assert.equal(Number(await seq()), s0 + 1, 'nothing new to read, nothing logged');
  s = (await vol.get('/api/texting/status')).json;
  assert.equal(s.unread, 0);
  r = await vol.action('text.reply', { conversation_id: volConv, body: `It's Vol with ${campaign}!` });
  assert.equal(r.status, 200);
  assert.equal(r.json.message.first, false);
});

test('call through the campaign: rings you first, campaign number as caller ID, token single-use and short-lived', async () => {
  let r = await vol.action('call.start', { person_id: P.dev.id });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Add your phone number first/);
  assert.equal((await vol.action('call.start', { person_id: P.dev.id, my_phone: '604-555-0135' })).status, 400, 'not their number');
  r = await vol.action('call.start', { person_id: P.dev.id, my_phone: '604-555-0177' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.call.status, 'calling_you');
  const callId = r.json.call.id;
  const ring = calls().at(-1);
  assert.equal(ring.form.To, '+16045550177', 'rings the caller first');
  assert.equal(ring.form.From, CAMPAIGN_NUMBER);
  assert.match(ring.form.Url, new RegExp(`^${PUBLIC}/api/public/twilio/voice/[0-9a-f]{48}$`));
  assert.equal(ring.form.StatusCallback, `${PUBLIC}/api/public/twilio/voice-status/${callId}`);
  const answerPath = new URL(ring.form.Url).pathname;
  const token = answerPath.split('/').pop();
  const callSid = (await db.query('select provider_sid from texting_calls where id = $1', [callId])).rows[0].provider_sid;
  assert.ok(callSid);
  assert.equal((await vol.action('call.start', { person_id: P.dev.id })).status, 409, 'one call at a time');

  // Nothing secret on the log: no token, not the caller's number.
  const log = JSON.stringify((await db.query('select payload from events where workspace_id = $1', [ws])).rows);
  assert.ok(!log.includes(token), 'the token never enters the log');
  assert.ok(!log.includes('5550177'), 'the caller\'s phone never enters the log');

  assert.equal((await hook(answerPath, { CallSid: callSid }, { sign: false })).status, 403);
  let tw = await hook(answerPath, { CallSid: callSid, CallStatus: 'in-progress' });
  assert.equal(tw.status, 200);
  assert.match(tw.text, /<Gather numDigits="1"/);
  assert.ok(tw.text.includes(`${PUBLIC}${answerPath}/connect`));
  assert.ok(!tw.text.includes('6045550135'), 'no dialling before a key is pressed');
  tw = await hook(`${answerPath}/connect`, { CallSid: callSid });
  assert.doesNotMatch(tw.text, /<Dial/, 'no key, no connection');
  tw = await hook(`${answerPath}/connect`, { CallSid: 'CAsomeoneelse', Digits: '1' });
  assert.doesNotMatch(tw.text, /<Dial/, 'another call cannot use this token');
  tw = await hook(`${answerPath}/connect`, { CallSid: callSid, Digits: '9' });
  assert.doesNotMatch(tw.text, /<Dial/, 'only 1 connects');
  assert.match(tw.text, /<Gather numDigits="1"[^>]*><Say>Press 1 to connect\.<\/Say>/, 'any other key asks again');
  assert.equal((await db.query('select token_used_at from texting_calls where id = $1', [callId])).rows[0].token_used_at, null, 'and the token is not spent');
  tw = await hook(`${answerPath}/connect`, { CallSid: callSid, Digits: '1' });
  assert.match(tw.text, new RegExp(`<Dial callerId="\\${CAMPAIGN_NUMBER}"`), 'the person sees the campaign number');
  assert.match(tw.text, /<Number>\+16045550135<\/Number>/);
  assert.ok(!tw.text.includes('6045550177'), 'never the caller\'s own number');
  assert.equal((await vol.get(`/api/texting/calls/${callId}`)).json.call.status, 'connecting');
  tw = await hook(`${answerPath}/connect`, { CallSid: callSid, Digits: '1' });
  assert.doesNotMatch(tw.text, /<Dial/, 'single use');
  assert.match(tw.text, /<Hangup\/>/);
  tw = await hook(answerPath, { CallSid: callSid });
  assert.doesNotMatch(tw.text, /<Gather/);

  tw = await hook(`/api/public/twilio/voice-dial/${callId}`, { CallSid: callSid, DialCallStatus: 'completed', DialCallDuration: '125' });
  assert.match(tw.text, /<Hangup\/>/);
  assert.equal((await hook(`/api/public/twilio/voice-status/${callId}`, { CallSid: callSid, CallStatus: 'completed', CallDuration: '140' })).status, 204);
  let call = (await vol.get(`/api/texting/calls/${callId}`)).json.call;
  assert.equal(call.status, 'talked');
  assert.equal(call.talk_s, 125);
  assert.equal(call.call_s, 140);
  assert.equal((await staff.get(`/api/texting/calls/${callId}`)).status, 200, 'the desk can look');

  // A second call reuses the stored number; its token goes stale in minutes.
  r = await vol.action('call.start', { person_id: P.dev.id });
  assert.equal(r.status, 200);
  assert.equal(calls().at(-1).form.To, '+16045550177');
  const stale = new URL(calls().at(-1).form.Url).pathname;
  const sid2 = (await db.query('select provider_sid from texting_calls where id = $1', [r.json.call.id])).rows[0].provider_sid;
  await db.query(`update texting_calls set token_expires_at = now() - interval '1 second' where id = $1`, [r.json.call.id]);
  assert.doesNotMatch((await hook(stale, { CallSid: sid2 })).text, /<Gather/, 'expired');
  assert.doesNotMatch((await hook(`${stale}/connect`, { CallSid: sid2, Digits: '1' })).text, /<Dial/, 'expired');
  assert.equal((await hook(`/api/public/twilio/voice-status/${r.json.call.id}`, { CallSid: sid2, CallStatus: 'no-answer', CallDuration: '0' })).status, 204);
  call = (await vol.get(`/api/texting/calls/${r.json.call.id}`)).json.call;
  assert.equal(call.status, 'missed', 'the caller never connected');
  assert.equal((await desk.action('call.start', { person_id: P.dev.id, my_phone: '604-555-0178' })).status, 200);
  const deskCall = (await db.query('select id from texting_calls where workspace_id = $1 and caller_phone = $2', [ws, '+16045550178'])).rows[0].id;
  assert.equal((await vol.get(`/api/texting/calls/${deskCall}`)).status, 404, 'someone else\'s call');

  process.env.TWILIO_VOICE = 'off';
  assert.equal((await vol.action('call.start', { person_id: P.dev.id })).status, 409);
  delete process.env.TWILIO_VOICE;
});

test("a caller's own phone is seen only by them and managers", async () => {
  const s = (await vol.get('/api/texting/status')).json;
  assert.equal(s.myPhone, '604-555-0177');
  assert.equal((await staff.get('/api/texting/status')).json.myPhone, null);
  const st = await staff.get('/api/texting/settings');
  assert.equal(st.status, 200);
  assert.equal(st.json.memberPhones, null, 'staff do not see callers\' phones');
  assert.equal(st.json.canEdit, false);
  const m = await desk.get('/api/texting/settings');
  assert.equal(m.json.canEdit, true);
  assert.ok(m.json.memberPhones.some((p) => p.phone === '604-555-0177'));
  assert.equal(m.json.webhooks.sms, `${PUBLIC}/api/public/twilio/sms`);
  const events = (await staff.get('/api/events?limit=1000')).json.events;
  assert.ok(!JSON.stringify(events).includes('5550177'), 'not in the log staff can read');
});

test('a failed send says so; the carrier opting a number out is recorded', async () => {
  reply = () => ({ status: 500, body: { message: 'Service unavailable' } });
  let r = await desk.action('text.send', { person_id: P.dev.id, body: `Hi Dev, it's Desk with ${campaign}.` });
  assert.equal(r.status, 200);
  assert.equal(r.json.sent, false);
  assert.equal(r.json.message.status, 'failed');
  assert.match(r.json.message.error, /Twilio 500/);
  assert.equal((await desk.get(`/api/texting/people/${P.dev.id}`)).json.first, true, 'still the first text: nothing went out');
  reply = () => ({ status: 400, body: { code: 21610, message: 'Attempt to send to unsubscribed recipient' } });
  r = await desk.action('text.send', { person_id: P.dev.id, body: `Hi Dev, it's Desk with ${campaign}.` });
  assert.equal(r.json.sent, false);
  reply = null;
  const dev = (await desk.get(`/api/persons/${P.dev.id}`)).json.person;
  assert.ok(dev.tags.includes('do-not-text'));
  assert.equal((await desk.action('text.send', { person_id: P.dev.id, body: 'again' })).status, 409);
});

test('one conversation per number: no second introduction, the Text list leaves them out, replies stay put', async () => {
  const lena = await desk.createPerson('Lena Example', { phone: '604-555-0138' });
  let r = await desk.action('text.send', { person_id: lena.id, body: `Hi Lena, it's Desk with ${campaign}.` });
  assert.equal(r.json.sent, true);
  const deskConv = r.json.conversation_id;
  let q = (await desk.get('/api/texting/queue')).json;
  assert.ok(q.away.includes(lena.id), 'texted: out of your Text list until she replies');
  assert.ok(!q.replied.includes(lena.id));
  let card = (await desk.get(`/api/texting/people/${lena.id}`)).json;
  assert.equal(card.conversation.last.direction, 'out');
  assert.equal(card.first, false, 'the next text from the card is a follow-up, not an introduction');

  await inbound('+16045550138', 'Yes I support you!');
  q = (await desk.get('/api/texting/queue')).json;
  assert.ok(q.replied.includes(lena.id) && !q.away.includes(lena.id), 'she replied: first in your list');
  card = (await desk.get(`/api/texting/people/${lena.id}`)).json;
  assert.equal(card.in_touch, false, 'your own conversation is not "someone else"');
  assert.deepEqual(card.conversation.recent.map((m) => m.direction), ['out', 'in']);
  assert.equal(card.conversation.recent[1].body, 'Yes I support you!');
  assert.equal(card.conversation.last.direction, 'in');
  // Rated: back to an ordinary place in the list.
  await desk.action('contact.log', { person_id: lena.id, channel: 'text', outcome: 'contacted', rating: '1' });
  q = (await desk.get('/api/texting/queue')).json;
  assert.ok(!q.replied.includes(lena.id) && !q.away.includes(lena.id));

  // A volunteer: Lena is already texting with the campaign — no content, no thread.
  const volCard = (await vol.get(`/api/texting/people/${lena.id}`)).json;
  assert.equal(volCard.in_touch, true);
  assert.equal(volCard.in_touch_id, null);
  assert.equal(volCard.conversation, null);
  assert.ok(!JSON.stringify(volCard).includes('support you'));
  const vq = (await vol.get('/api/texting/queue')).json;
  assert.ok(vq.away.includes(lena.id) && !vq.replied.includes(lena.id), 'out of their Text list too');
  assert.deepEqual(Object.keys(vq).sort(), ['away', 'replied']);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert.ok([...vq.away, ...vq.replied].every((v) => typeof v === 'string' && UUID.test(v)), 'person ids only');
  assert.ok(!/@|\d{3}-\d{3}-\d{4}|\+1\d{10}|Lena/.test(JSON.stringify(vq)), 'no email, number or name');
  const n = texts().length;
  r = await vol.action('text.send', { person_id: lena.id, body: `Hi Lena, it's Vol with ${campaign}.` });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /Already texting with the campaign/);
  assert.equal(texts().length, n, 'no second introduction went out');
  assert.equal((await staff.get(`/api/texting/people/${lena.id}`)).json.in_touch_id, deskConv, 'the desk sees which thread to answer in');

  // A newer duplicate (made before this rule): her next reply still goes where
  // she last replied — the desk's — never to the newer one.
  const volUser = (await vol.get('/api/auth/me')).json.user;
  const dup = randomUUID();
  await db.query(
    `insert into texting_conversations (id, workspace_id, person_id, phone, started_by, created_at, last_at)
     values ($1, $2, $3, '+16045550138', $4, now(), now())`, [dup, ws, lena.id, volUser.id],
  );
  await db.query(
    `insert into texting_messages (id, workspace_id, conversation_id, direction, phone, body, status, first, sent_by, created_at)
     values ($1, $2, $3, 'out', '+16045550138', 'Hi again', 'sent', true, $4, now() + interval '1 second')`,
    [randomUUID(), ws, dup, volUser.id],
  );
  const volUnread = (await vol.get('/api/texting/status')).json.unread;
  await inbound('+16045550138', 'STOP');
  const stop = (await db.query(
    `select conversation_id from texting_messages where workspace_id = $1 and phone = '+16045550138' and direction = 'in' and body = 'STOP'`, [ws],
  )).rows[0];
  assert.equal(stop.conversation_id, deskConv);
  assert.equal((await vol.get('/api/texting/status')).json.unread, volUnread, 'nothing she says to the desk reaches the volunteer');
  assert.ok(!JSON.stringify((await vol.get(`/api/texting/conversations/${dup}`)).json).includes('STOP'));

  // She never replied: a reply goes to the first conversation that texted her lately.
  const noah = await desk.createPerson('Noah Example', { phone: '604-555-0140' });
  r = await desk.action('text.send', { person_id: noah.id, body: `Hi Noah, it's Desk with ${campaign}.` });
  const noahDesk = r.json.conversation_id;
  const dup2 = randomUUID();
  await db.query(
    `insert into texting_conversations (id, workspace_id, person_id, phone, started_by, created_at, last_at)
     values ($1, $2, $3, '+16045550140', $4, now() + interval '1 second', now() + interval '1 second')`, [dup2, ws, noah.id, volUser.id],
  );
  await db.query(
    `insert into texting_messages (id, workspace_id, conversation_id, direction, phone, body, status, first, sent_by, created_at)
     values ($1, $2, $3, 'out', '+16045550140', 'Hi again', 'sent', true, $4, now() + interval '1 second')`,
    [randomUUID(), ws, dup2, volUser.id],
  );
  await inbound('+16045550140', 'Yes I support you!');
  const yes = (await db.query(
    `select conversation_id from texting_messages where workspace_id = $1 and phone = '+16045550140' and direction = 'in'`, [ws],
  )).rows[0];
  assert.equal(yes.conversation_id, noahDesk);
});

test('one conversation per number holds for replies too: an older thread cannot answer while another is live', async () => {
  const volUser = (await vol.get('/api/auth/me')).json.user;
  // A desk member of its own, so these texts don't count toward anyone else's pace.
  const kai = new Client();
  await joinAs(kai, 'staff', 'Kai Desk', 'kai');
  const ago = async (conv, days) => {
    await db.query(`update texting_conversations set created_at = now() - interval '${days} days', last_at = now() - interval '${days} days' where id = $1`, [conv]);
    await db.query(`update texting_messages set created_at = now() - interval '${days} days' where conversation_id = $1`, [conv]);
  };

  // The desk texted Ola 9 days ago; since then Val texted her and she answered Val.
  const ola = await kai.createPerson('Ola Example', { phone: '604-555-0153' });
  let r = await kai.action('text.send', { person_id: ola.id, body: `Hi Ola, it's Kai with ${campaign}.` });
  const deskOld = r.json.conversation_id;
  await ago(deskOld, 9);
  r = await vol.action('text.send', { person_id: ola.id, body: `Hi Ola, it's Val with ${campaign}.` });
  assert.equal(r.status, 200, 'nine days on, Val may introduce herself');
  const valConv = r.json.conversation_id;
  await inbound('+16045550153', 'Maybe, tell me more');
  let thread = (await kai.get(`/api/texting/conversations/${deskOld}`)).json.conversation;
  assert.equal(thread.in_touch, true, 'the desk\'s old thread says someone else is texting her');
  assert.equal(thread.in_touch_id, valConv, 'and which thread to answer in');
  const n = texts().length;
  r = await kai.action('text.reply', { conversation_id: deskOld, body: 'Would you donate?' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'Already texting with the campaign — answer in that thread');
  assert.equal(texts().length, n, 'nothing went out from the old thread');
  // In Val's thread the desk may answer: her reply comes back where Val sees it.
  assert.equal((await kai.get(`/api/texting/conversations/${valConv}`)).json.conversation.in_touch, false);
  assert.equal((await vol.get(`/api/texting/conversations/${valConv}`)).json.conversation.in_touch, false);
  r = await kai.action('text.reply', { conversation_id: valConv, body: 'Happy to — what would you like to know?' });
  assert.equal(r.status, 200);
  assert.equal(r.json.sent, true);

  // The reverse: Val's thread with Noah is 8 days old and the desk texts him now.
  const noah = await kai.createPerson('Noah Example', { phone: '604-555-0154' });
  r = await vol.action('text.send', { person_id: noah.id, body: `Hi Noah, it's Val with ${campaign}.` });
  const valOld = r.json.conversation_id;
  await ago(valOld, 8);
  r = await kai.action('text.send', { person_id: noah.id, body: `Hi Noah, it's Kai with ${campaign}.` });
  assert.equal(r.status, 200);
  const deskNow = r.json.conversation_id;
  thread = (await vol.get(`/api/texting/conversations/${valOld}`)).json.conversation;
  assert.equal(thread.in_touch, true);
  assert.equal(thread.in_touch_id, null, 'a volunteer never gets the desk\'s thread');
  const m = texts().length;
  r = await vol.action('text.reply', { conversation_id: valOld, body: 'Still with us, Noah?' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'Already texting with the campaign');
  assert.equal(texts().length, m, 'Noah gets no text from Val in between');
  await inbound('+16045550154', 'Yes I will donate $50');
  const answer = (await db.query(
    `select conversation_id from texting_messages where workspace_id = $1 and phone = '+16045550154' and direction = 'in'`, [ws],
  )).rows[0];
  assert.equal(answer.conversation_id, deskNow, 'his answer is the desk\'s');
  const valView = JSON.stringify([
    (await vol.get('/api/texting/mine')).json, (await vol.get(`/api/texting/conversations/${valOld}`)).json,
  ]);
  assert.ok(!valView.includes('$50'), 'nothing he says to the desk reaches the volunteer');

  // A legacy duplicate (both live, made before the rule): only the side his
  // texts are filed in may answer — the other is refused, not stuck both ways.
  const dup = randomUUID();
  await db.query(
    `insert into texting_conversations (id, workspace_id, person_id, phone, started_by, created_at, last_at)
     values ($1, $2, $3, '+16045550154', $4, now(), now())`, [dup, ws, noah.id, volUser.id],
  );
  await db.query(
    `insert into texting_messages (id, workspace_id, conversation_id, direction, phone, body, status, first, sent_by)
     values ($1, $2, $3, 'out', '+16045550154', 'Hi again', 'sent', true, $4)`, [randomUUID(), ws, dup, volUser.id],
  );
  assert.equal((await vol.action('text.reply', { conversation_id: dup, body: 'Hi?' })).status, 409);
  assert.equal((await kai.action('text.reply', { conversation_id: deskNow, body: 'Thank you, Noah!' })).status, 200);

  // One member's own conversations with a shared household number never block each other.
  const ida = await kai.createPerson('Ida Example', { phone: '604-555-0155' });
  const ike = await kai.createPerson('Ike Example', { phone: '604-555-0155' });
  const idaConv = (await kai.action('text.send', { person_id: ida.id, body: `Hi Ida, it's Kai with ${campaign}.` })).json.conversation_id;
  assert.equal((await kai.action('text.send', { person_id: ike.id, body: `Hi Ike, it's Kai with ${campaign}.` })).status, 200);
  assert.equal((await kai.get(`/api/texting/conversations/${idaConv}`)).json.conversation.in_touch, false);
  assert.equal((await kai.action('text.reply', { conversation_id: idaConv, body: 'And you, Ida?' })).status, 200);
});

test('a reply asking to stop is flagged; anyone in the thread opts the number out with one tap', async () => {
  const pete = await desk.createPerson('Pete Example', { phone: '604-555-0145' });
  let r = await vol.action('text.send', { person_id: pete.id, body: `Hi Pete, it's Vol with ${campaign}.` });
  assert.equal(r.json.sent, true);
  const conv = r.json.conversation_id;
  await inbound('+16045550145', 'No thanks, stop');
  let thread = (await vol.get(`/api/texting/conversations/${conv}`)).json;
  assert.equal(thread.messages.at(-1).keyword, 'asks_stop');
  assert.equal(thread.conversation.opted_out, false, 'flagged for a person — not opted out by itself');
  const harjitConv = (await desk.get(`/api/texting/people/${P.harjit.id}`)).json.conversation.id;
  assert.equal((await vol.action('text.optout', { conversation_id: harjitConv })).status, 404, 'not theirs to touch');
  r = await vol.action('text.optout', { conversation_id: conv });
  assert.equal(r.status, 200);
  assert.equal(r.json.opted_out, true);
  thread = (await vol.get(`/api/texting/conversations/${conv}`)).json;
  assert.equal(thread.conversation.opted_out, true);
  assert.ok((await desk.get(`/api/persons/${pete.id}`)).json.person.tags.includes('do-not-text'));
  assert.equal((await vol.action('text.reply', { conversation_id: conv, body: 'Sorry!' })).status, 409);
  r = await staff.action('text.send', { person_id: pete.id, body: `Hi Pete, it's Sam with ${campaign}.` });
  assert.equal(r.status, 409, 'nobody else can start again either');
  assert.match(r.json.error, /opted out/i);
  assert.equal((await vol.action('text.optout', { conversation_id: conv })).json.already, true, 'twice is harmless');
  // "STOP 🙏" is a STOP.
  const sky = await desk.createPerson('Sky Example', { phone: '604-555-0144' });
  r = await vol.action('text.send', { person_id: sky.id, body: `Hi Sky, it's Vol with ${campaign}.` });
  await inbound('+16045550144', 'STOP 🙏');
  assert.ok((await desk.get(`/api/persons/${sky.id}`)).json.person.tags.includes('do-not-text'));
});

test('START takes off only the tag its STOP put on; a do-not-text set by hand stays', async () => {
  const kim = await desk.createPerson('Kim Example', { phone: '604-555-0146' });
  const ray = await desk.createPerson('Ray Example', { phone: '604 555 0146' });
  await desk.action('person.update', { id: ray.id, tags: ['do-not-text'] });
  assert.equal((await desk.action('text.send', { person_id: kim.id, body: `Hi Kim, it's Desk with ${campaign}.` })).json.sent, true);
  await inbound('+16045550146', 'STOP');
  const tags = async (p) => (await desk.get(`/api/persons/${p.id}`)).json.person.tags;
  assert.ok((await tags(kim)).includes('do-not-text'));
  assert.ok((await tags(ray)).includes('do-not-text'));
  await inbound('+16045550146', 'START');
  assert.ok(!(await tags(kim)).includes('do-not-text'), 'their STOP’s tag comes off');
  assert.ok((await tags(ray)).includes('do-not-text'), 'the desk’s own do-not-text stays');
  assert.equal((await desk.action('text.send', { person_id: ray.id, body: 'Hi Ray' })).status, 409);
});

test('shift notices texted from the campaign number follow the texting rules', async () => {
  const sam = await desk.createPerson('Sam Example', { phone: '(604) 555-0147' });
  const quinn = await desk.createPerson('Quinn Example', { phone: '604-555-0148', email: `quinn+${tag}@example.org` });
  assert.equal((await desk.action('text.send', { person_id: quinn.id, body: `Hi Quinn, it's Desk with ${campaign}.` })).json.sent, true);
  await inbound('+16045550148', 'STOP');
  const shift = (await desk.action('shift.create', { title: 'Saturday canvass', starts_at: '2026-10-24T17:00:00.000Z' })).json.shift;
  for (const p of [sam, quinn]) assert.equal((await desk.action('shift.assign', { shift_id: shift.id, person_id: p.id })).status, 200);
  const by = (res) => Object.fromEntries(res.json.notified.map((x) => [x.name, x]));

  at('2026-10-23T06:30:00Z'); // 11:30 pm in Surrey
  const n = texts().length;
  let r = await desk.action('shift.notify', { shift_id: shift.id });
  assert.equal(r.status, 200);
  let got = by(r);
  assert.equal(got['Sam Example'].text, 'quiet');
  assert.match(got['Sam Example'].text_note, /Quiet hours — sending opens at 9 am tomorrow/);
  assert.equal(got['Quinn Example'].text, 'opted_out');
  assert.equal(texts().length, n, 'nothing texted at 11:30 pm, nothing to a number that replied STOP');

  _setClockForTest(() => NOON);
  r = await desk.action('shift.notify', { shift_id: shift.id });
  got = by(r);
  assert.equal(got['Sam Example'].text, 'sent');
  assert.equal(texts().at(-1).form.To, '+16045550147', 'to the E.164 number');
  assert.match(texts().at(-1).form.Body, /^You're scheduled: Saturday canvass/);
  assert.equal(got['Quinn Example'].text, 'opted_out', 'never to an opted-out number');
  assert.equal(texts().length, n + 1);
  const detail = (await desk.get(`/api/shifts/${shift.id}`)).json;
  const row = detail.assignees.find((a) => a.name === 'Quinn Example');
  assert.equal(row.notify_text, 'opted_out', 'the screen reads back what happened');
});

test('a text from a number nobody texted counts as new for the desk, not for a volunteer', async () => {
  const slug = (await db.query('select slug from workspaces where id = $1', [ws])).rows[0].slug;
  process.env.TWILIO_WORKSPACE = slug;
  const before = (await desk.get('/api/texting/status')).json.unread;
  const vBefore = (await vol.get('/api/texting/status')).json.unread;
  try {
    assert.equal((await inbound('+16045550188', 'Who is this?')).status, 200);
  } finally {
    delete process.env.TWILIO_WORKSPACE;
  }
  assert.equal((await desk.get('/api/texting/status')).json.unread, before + 1);
  assert.equal((await vol.get('/api/texting/status')).json.unread, vBefore);
  const conv = (await desk.get('/api/texting/all')).json.conversations.find((c) => c.phone === '604-555-0188');
  assert.ok(conv && conv.unread && !conv.person_id);
});

test('one person tapping Send: a scripted burst is refused', async () => {
  const burst = await desk.createPerson('Burst Example', { phone: '604-555-0149' });
  let refused = null;
  for (let i = 0; i < 25 && !refused; i += 1) {
    const r = await staff.action('text.send', { person_id: burst.id, body: `Hello ${i} from ${campaign}` });
    if (r.status === 429) refused = i;
  }
  assert.equal(refused, 20, 'twenty a minute at most');
});

test('every texting write is on the hash chain and the books verify', async () => {
  const actions = (await db.query('select distinct action from events where workspace_id = $1', [ws])).rows.map((r) => r.action);
  for (const a of ['text.send', 'text.reply', 'text.read', 'text.optout', 'call.start', 'texting.settings', 'twilio.sms_in', 'twilio.sms_status', 'twilio.voice_connect', 'twilio.call_dial', 'twilio.call_status']) {
    assert.ok(actions.includes(a), `${a} is logged`);
  }
  assert.equal((await verifyChain(db, ws)).ok, true);
  const audit = await desk.get('/api/audit/verify');
  assert.equal(audit.json.ok, true);
});
