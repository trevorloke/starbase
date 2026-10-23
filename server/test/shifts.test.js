// Shifts: create, assign (capacity, duplicates), status, notify with
// per-assignee email/text results that degrade to 'queued' without providers.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { _setClockForTest } from '../ext/texting/rules.js';

let c;

before(async () => {
  await freshDb();
  delete process.env.RESEND_API_KEY;
  delete process.env.TWILIO_ACCOUNT_SID;
  c = new Client();
  await c.signup({ workspaceName: 'Shift WS' });
});

test('create a shift, assign volunteers, see fill count', async () => {
  const s = await c.action('shift.create', {
    title: 'Saturday canvass — Newton',
    role: 'doorknocking',
    location: 'Newton Rec Centre, 13730 72 Ave',
    starts_at: '2026-11-07T10:00:00-07:00',
    ends_at: '2026-11-07T13:00:00-07:00',
    instructions: 'Wear comfortable shoes. Meet at the north entrance.',
    link: 'https://imaginesurrey.ca/canvass',
    capacity: 2,
  });
  assert.equal(s.status, 200);
  const shift = s.json.shift;
  const a = await c.createPerson('Vol A', { email: 'a@example.org', phone: '604-555-0001' });
  const b = await c.createPerson('Vol B', { phone: '604-555-0002' });
  const d = await c.createPerson('Vol D');
  assert.equal((await c.action('shift.assign', { shift_id: shift.id, person_id: a.id })).status, 200);
  assert.equal((await c.action('shift.assign', { shift_id: shift.id, person_id: b.id })).status, 200);
  const dup = await c.action('shift.assign', { shift_id: shift.id, person_id: a.id });
  assert.equal(dup.status, 409, 'duplicate assignment refused');
  const full = await c.action('shift.assign', { shift_id: shift.id, person_id: d.id });
  assert.equal(full.status, 409, 'capacity enforced');
  const list = await c.get('/api/shifts');
  assert.equal(list.json.shifts[0].filled, 2);
});

test('notify records per-assignee channel outcomes and timestamps', async () => {
  const list = await c.get('/api/shifts');
  const shift = list.json.shifts[0];
  const n = await c.action('shift.notify', { shift_id: shift.id });
  assert.equal(n.status, 200);
  const byName = Object.fromEntries(n.json.notified.map((r) => [r.name, r]));
  assert.equal(byName['Vol A'].email, 'queued', 'has email, no provider → queued');
  assert.equal(byName['Vol A'].text, 'queued', 'has phone, no provider → queued');
  assert.equal(byName['Vol B'].email, 'skipped', 'no email on file');
  assert.equal(byName['Vol B'].text, 'queued');
  const detail = await c.get(`/api/shifts/${shift.id}`);
  assert.ok(detail.json.assignees.every((a) => a.notified_at));
  assert.equal(detail.json.assignees.find((a) => a.name === 'Vol A').notify_email, 'queued');
});

test('declining frees a capacity slot; status changes are recorded', async () => {
  const list = await c.get('/api/shifts');
  const shift = list.json.shifts[0];
  const detail = await c.get(`/api/shifts/${shift.id}`);
  const volB = detail.json.assignees.find((a) => a.name === 'Vol B');
  const dec = await c.action('shift.setStatus', { id: volB.assignment_id, status: 'declined' });
  assert.equal(dec.status, 200);
  const d = await c.createPerson('Vol D2');
  const now = await c.action('shift.assign', { shift_id: shift.id, person_id: d.id });
  assert.equal(now.status, 200, 'slot freed by the decline');
  const un = await c.action('shift.unassign', { id: volB.assignment_id });
  assert.equal(un.status, 200);
});

test('upcoming shifts surface on the brief; person profile lists their shifts', async () => {
  const brief = await c.get('/api/brief');
  assert.ok(brief.json.shifts.length >= 1);
  assert.equal(brief.json.shifts[0].title, 'Saturday canvass — Newton');
  const list = await c.get('/api/shifts');
  const detail = await c.get(`/api/shifts/${list.json.shifts[0].id}`);
  const volA = detail.json.assignees.find((a) => a.name === 'Vol A');
  const prof = await c.get(`/api/persons/${volA.id}`);
  assert.equal(prof.json.shifts.length, 1);
});

test('bad timestamps and unknown shifts are rejected', async () => {
  const bad = await c.action('shift.create', { title: 'x', starts_at: 'next tuesday' });
  assert.equal(bad.status, 400);
  const nope = await c.action('shift.notify', { shift_id: '99999999-9999-4999-8999-999999999999' });
  assert.equal(nope.status, 404);
});

test('a volunteer books and leaves a shift themselves, and sees no one else\'s contact details', async () => {
  // Its own address: under test:pg every file shares one Postgres, and users are global.
  const inv = await c.action('member.invite', { email: 'Jas.Shifts@Example.org', role: 'volunteer' });
  const vol = new Client();
  const joined = await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Jas Volunteer', password: 'knock-knock-2026' });
  assert.equal(joined.status, 200);
  assert.ok((await vol.get('/api/actions')).json.actions.includes('shift.join'));

  const s = (await c.action('shift.create', {
    title: 'Hi-rise lobby — Whalley', role: 'highrise_captain',
    starts_at: '2030-05-04T10:00:00-07:00', ends_at: '2030-05-04T12:00:00-07:00', capacity: 2,
  })).json.shift;
  const other = await c.createPerson('Other Vol', { email: 'other@example.org', phone: '604-555-0110' });
  await c.action('shift.assign', { shift_id: s.id, person_id: other.id });

  const join = await vol.action('shift.join', { shift_id: s.id });
  assert.equal(join.status, 200, JSON.stringify(join.json));
  assert.equal(join.json.assignment.status, 'confirmed');
  const me = await vol.get(`/api/persons/${join.json.assignment.person_id}`);
  assert.equal(me.json.person.email, 'jas.shifts@example.org', 'a newcomer is added to the list by login email');
  assert.equal((await vol.action('shift.join', { shift_id: s.id })).status, 409, 'no double booking');

  const roster = (await vol.get(`/api/shifts/${s.id}`)).json.assignees;
  const mine = roster.find((a) => a.is_me);
  const theirs = roster.find((a) => !a.is_me);
  assert.equal(mine.name, 'Jas Volunteer');
  assert.equal(theirs.name, 'Other Vol');
  assert.equal(theirs.phone, null, 'volunteers do not get other volunteers\' phones');
  assert.equal(theirs.email, null);
  assert.equal((await c.get(`/api/shifts/${s.id}`)).json.assignees.find((a) => a.name === 'Other Vol').phone, '604-555-0110', 'the desk still does');

  const third = await c.createPerson('Third Vol');
  assert.equal((await c.action('shift.assign', { shift_id: s.id, person_id: third.id })).status, 409, 'self-booking counts toward capacity');

  const leave = await vol.action('shift.leave', { shift_id: s.id });
  assert.equal(leave.status, 200);
  assert.equal((await vol.action('shift.leave', { shift_id: s.id })).status, 404, 'already off it');
  assert.equal((await c.action('shift.assign', { shift_id: s.id, person_id: third.id })).status, 200, 'leaving frees the spot');
  assert.equal((await vol.action('shift.join', { shift_id: s.id })).status, 409, 'full again');
  const dropped = (await c.get(`/api/shifts/${s.id}`)).json.assignees.find((a) => a.name === 'Jas Volunteer');
  assert.equal(dropped.status, 'declined', 'the organizer sees who dropped out');

  const past = (await c.action('shift.create', { title: 'Last spring', starts_at: '2020-05-04T10:00:00-07:00' })).json.shift;
  assert.equal((await vol.action('shift.join', { shift_id: past.id })).status, 409, 'past shifts cannot be joined');
  assert.equal((await vol.action('shift.assign', { shift_id: s.id, person_id: third.id })).status, 403, 'volunteers still cannot book other people');
});

test('nothing sends by itself: "Notify again" after connecting reaches the people whose last result was queued', async () => {
  const s = (await c.action('shift.create', {
    title: 'Notify again — Fleetwood', starts_at: '2030-06-01T10:00:00-07:00', location: 'Fleetwood Park',
  })).json.shift;
  const both = await c.createPerson('Notify Both', { email: 'notify.both@example.org', phone: '604-555-0123' });
  const textOnly = await c.createPerson('Notify Text', { phone: '604-555-0124' });
  for (const p of [both, textOnly]) await c.action('shift.assign', { shift_id: s.id, person_id: p.id });

  const ENV = ['RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  const first = await c.action('shift.notify', { shift_id: s.id });
  const byName1 = Object.fromEntries(first.json.notified.map((r) => [r.name, r]));
  assert.deepEqual([byName1['Notify Both'].email, byName1['Notify Both'].text], ['queued', 'queued'], 'not connected: not sent');
  assert.deepEqual([byName1['Notify Text'].email, byName1['Notify Text'].text], ['skipped', 'queued']);

  const emails = [], texts = [];
  const realFetch = globalThis.fetch;
  Object.assign(process.env, {
    RESEND_API_KEY: 'test-key', TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+16045550100',
  });
  // Texts keep to the campaign's hours (server/ext/texting): noon in Surrey.
  _setClockForTest(() => new Date('2026-10-22T19:00:00Z'));
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://api.resend.com/')) { emails.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
    if (u.startsWith('https://api.twilio.com/')) { texts.push(Object.fromEntries(new URLSearchParams(init.body))); return new Response('{}', { status: 201 }); }
    return realFetch(url, init);
  };
  try {
    const again = await c.action('shift.notify', { shift_id: s.id });
    assert.equal(again.status, 200);
    const byName = Object.fromEntries(again.json.notified.map((r) => [r.name, r]));
    assert.deepEqual([byName['Notify Both'].email, byName['Notify Both'].text], ['sent', 'sent']);
    assert.deepEqual([byName['Notify Text'].email, byName['Notify Text'].text], ['skipped', 'sent']);
    assert.deepEqual(emails.map((m) => m.to[0]), ['notify.both@example.org']);
    assert.deepEqual(texts.map((m) => m.To).sort(), ['+16045550123', '+16045550124'], 'to the E.164 number');
    assert.match(emails[0].text, /Notify again — Fleetwood/);
    assert.match(texts[0].Body, /Where: Fleetwood Park/);
  } finally {
    globalThis.fetch = realFetch;
    _setClockForTest(null);
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  const detail = (await c.get(`/api/shifts/${s.id}`)).json.assignees;
  const row = detail.find((a) => a.name === 'Notify Both');
  assert.equal(row.notify_email, 'sent', 'the latest result replaces "queued"');
  assert.equal(row.notify_text, 'sent');
});
