// Counts the screens print, checked against what really happened: doors this
// week are doors (not taps), a walk-list door is done only once knocked, each
// send says how many were sent / failed / still waiting, open pledges leave
// out a monthly pledge already received this month, and a shift says when the
// caller is on it. Emails are unique per run: under test:pg every file shares
// one database and users are global.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { app } from '../index.js';

const uniq = () => Math.random().toString(36).slice(2, 8);

// A second member by the real path (invite → join).
const joinAs = async (mgr, role, name) => {
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${uniq()}@example.org`;
  const inv = await mgr.action('member.invite', { email, role });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  const cl = new Client();
  const j = await cl.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'count-pass-2026' });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  return { client: cl, userId: j.json.user.id, email };
};

before(async () => {
  await freshDb();
});

test('brief: doors this week are distinct doors — a household rated twice and a Change are one door', async () => {
  const mgr = new Client();
  await mgr.signup({ workspaceName: 'Doors Count WS', jurisdiction: 'bc-municipal' });
  const { client: vol } = await joinAs(mgr, 'volunteer', 'Count Walker');
  const lat = 49.1102; const lng = -122.8301;
  const harjit = await mgr.createPerson('Count Harjit', { address: '7001 140 St', lat, lng, phone: '604-555-0120' });
  const simran = await mgr.createPerson('Count Simran', { address: '7001 140 St', lat, lng });
  // The same door typed differently is still the same door.
  const nephew = await mgr.createPerson('Count Nephew', { address: ' 7001 140 st ', lat, lng });
  const upstairs = await mgr.createPerson('Count Upstairs', { address: '7001 140 St', unit: '2', lat, lng });
  const nowhere = await mgr.createPerson('Count No Address', { phone: '604-555-0121' });
  const knock = (who, p, rating, outcome = 'contacted') =>
    who.action('contact.log', { person_id: p.id, channel: 'door', outcome, rating });

  // The volunteer at one door: rates Harjit 2, Simran 3, then Change — Harjit 1.
  const first = await knock(vol, harjit, '2');
  assert.equal(first.status, 200);
  await knock(vol, simran, '3');
  await knock(vol, harjit, '1');
  await knock(vol, nephew, null, 'no_answer');
  let b = (await vol.get('/api/brief')).json.field;
  assert.equal(b.mine.doors, 1, 'four taps at one door: one door');
  assert.equal(b.doors, 1);
  assert.equal(b.week, 4, 'week still counts every contact');

  // Calls and texts count contacts, not people.
  await vol.action('contact.log', { person_id: harjit.id, channel: 'phone', outcome: 'no_answer' });
  await vol.action('contact.log', { person_id: harjit.id, channel: 'phone', outcome: 'contacted', rating: '1' });
  await vol.action('contact.log', { person_id: harjit.id, channel: 'text', outcome: 'contacted' });
  b = (await vol.get('/api/brief')).json.field;
  assert.deepEqual(b.mine, { doors: 1, calls: 2, texts: 1 });
  assert.equal(b.doors, 1, 'a call is not a door');

  // The manager: another unit is another door; someone with no address is
  // their own door; the household the volunteer already knocked is not new.
  await knock(mgr, upstairs, '2');
  await knock(mgr, nowhere, '3');
  await knock(mgr, nowhere, '2');
  await knock(mgr, simran, '3');
  const mf = (await mgr.get('/api/brief')).json.field;
  assert.deepEqual(mf.mine, { doors: 3, calls: 0, texts: 0 });
  assert.equal(mf.doors, 3, 'team: 7001 140 St, unit 2, and the no-address person');
  const vf = (await vol.get('/api/brief')).json.field;
  assert.ok(vf.mine.doors <= vf.doors, 'You never beats Team');

  // The window is the last 7 days, rolling — not since midnight 7 days ago.
  const db = await getDb();
  const ids = async (personId) => (await db.query(
    'select id from contacts where person_id = $1 order by created_at', [personId],
  )).rows.map((r) => r.id);
  const [up] = await ids(upstairs.id);
  await db.query(`update contacts set created_at = now() - interval '6 days 23 hours' where id = $1`, [up]);
  assert.equal((await mgr.get('/api/brief')).json.field.doors, 3, 'six days 23 hours ago: still this week');
  await db.query(`update contacts set created_at = now() - interval '7 days 1 minute' where id = $1`, [up]);
  const after = (await mgr.get('/api/brief')).json.field;
  assert.equal(after.doors, 2, 'seven days and a minute ago: gone');
  assert.equal(after.mine.doors, 2);
  const harjitCalls = (await db.query(
    `select id from contacts where person_id = $1 and channel = 'phone' order by created_at limit 1`, [harjit.id],
  )).rows[0].id;
  await db.query(`update contacts set created_at = now() - interval '7 days 1 minute' where id = $1`, [harjitCalls]);
  assert.equal((await vol.get('/api/brief')).json.field.mine.calls, 1, 'calls share the window');
});

test('walk list: a door is done only once someone there is knocked — a call or text alone leaves it to knock', async () => {
  const mgr = new Client();
  await mgr.signup({ workspaceName: 'Turf Done WS', jurisdiction: 'bc-municipal' });
  const lat = 49.1201; const lng = -122.8402;
  const mk = (name, address, dLng) => mgr.createPerson(name, { address, lat, lng: lng + dLng, phone: '604-555-0130' });
  const knocked = await mk('Done Knocked', '8001 132 St', 0);
  const called = await mk('Done Called', '8003 132 St', 0.0002);
  const texted = await mk('Done Texted', '8005 132 St', 0.0004);
  const hhCalled = await mk('Done House Called', '8007 132 St', 0.0006);
  const hhKnocked = await mk('Done House Knocked', '8007 132 St', 0.0006);
  await mk('Done Untouched', '8009 132 St', 0.0008);
  const t = (await mgr.action('turf.create', {
    name: 'Done block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
  })).json.turf;
  const log = (p, channel, outcome = 'contacted') => mgr.action('contact.log', { person_id: p.id, channel, outcome });
  await log(knocked, 'door', 'no_answer');
  await log(called, 'phone');
  await log(texted, 'text');
  await log(hhCalled, 'phone');
  await log(hhKnocked, 'door');

  const turf = (await mgr.get('/api/turfs')).json.turfs.find((x) => x.id === t.id);
  assert.equal(turf.doors, 5);
  assert.equal(turf.doorsDone, 2, 'the knocked door and the household where one person was knocked');

  const walk = (await mgr.get(`/api/turfs/${t.id}/walk`)).json;
  const done = Object.fromEntries(walk.doors.map((d) => [d.address, d.done]));
  assert.deepEqual(done, {
    '8001 132 St': true, '8003 132 St': false, '8005 132 St': false, '8007 132 St': true, '8009 132 St': false,
  });
  assert.equal(walk.stats.doorsDone, 2);
  const calledRow = walk.doors.find((d) => d.address === '8003 132 St').persons[0];
  assert.ok(calledRow.last_contact_at, 'the call is still there as information');
  assert.equal(calledRow.door_knocked, false);

  // Knocking the phoned door finishes it.
  await log(called, 'door', 'no_answer');
  const again = (await mgr.get(`/api/turfs/${t.id}/walk`)).json;
  assert.equal(again.doors.find((d) => d.address === '8003 132 St').done, true);
  assert.equal(again.stats.doorsDone, 3);
});

// Stand in for the email provider: RESEND_API_KEY set and fetch answered
// here, both restored after. `fail` picks addresses the provider rejects.
const withEmailProvider = async (fn, { fail = () => false } = {}) => {
  const realFetch = globalThis.fetch;
  const hadKey = Object.hasOwn(process.env, 'RESEND_API_KEY');
  const oldKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'test-key';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      const msg = JSON.parse(init.body);
      if (fail(msg.to[0])) return new Response('mailbox unavailable', { status: 500 });
      return new Response(JSON.stringify({ id: 'msg' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (hadKey) process.env.RESEND_API_KEY = oldKey; else delete process.env.RESEND_API_KEY;
  }
};

test('blasts list: each send carries sent / failed / queued counts; a newsletter only counts the still-subscribed as waiting', async () => {
  const w = new Client();
  await w.signup({ workspaceName: 'Blast Counts WS' });
  const tag = uniq();
  const subs = ['ana', 'ben', 'cy'].map((n) => `${n}.${tag}@example.org`);
  for (const email of subs) assert.equal((await w.action('subscription.add', { email })).status, 200);
  await w.createPerson('Count Desk One', { email: `desk1.${tag}@news.example`, tags: ['media'] });
  await w.createPerson('Count Desk Two', { email: `desk2.${tag}@news.example`, tags: ['media'] });
  const row = async (id) => (await w.get('/api/blasts')).json.blasts.find((b) => b.id === id);
  const counts = (b) => [b.sent_count, b.failed_count, b.queued_count];

  // Email not connected: saved, every recipient waiting.
  delete process.env.RESEND_API_KEY;
  const saved = (await w.action('blast.send', { kind: 'newsletter', subject: 'Count saved', body: 'Hello' })).json.blast;
  assert.deepEqual(counts(await row(saved.id)), [0, 0, 3]);
  // Cy unsubscribes: Send now would reach two, so two are waiting.
  const cy = (await w.get('/api/subscriptions')).json.subscriptions.find((s) => s.email === subs[2]);
  await w.action('subscription.remove', { id: cy.id });
  assert.deepEqual(counts(await row(saved.id)), [0, 0, 2]);

  // Press has no list to leave: every saved row waits.
  const press = (await w.action('blast.send', { kind: 'press', subject: 'Count release', body: 'FOR IMMEDIATE RELEASE' })).json.blast;
  assert.deepEqual(counts(await row(press.id)), [0, 0, 2]);

  // Connected, one address rejected: one sent, one failed, none waiting.
  await withEmailProvider(async () => {
    const half = await w.action('blast.send', { kind: 'newsletter', subject: 'Count half', body: 'Hi' });
    assert.equal(half.status, 200, JSON.stringify(half.json));
    const r = await row(half.json.blast.id);
    assert.deepEqual(counts(r), [1, 1, 0]);
    assert.equal(r.audience_count, 2);
    assert.equal(r.retry_count, 1, 'Try again would reach the one that failed');
    // Ben (the failed one) unsubscribes: Try again would reach no one, but
    // the record of what happened stays 1 sent · 1 failed.
    const ben = (await w.get('/api/subscriptions')).json.subscriptions.find((s) => s.email === subs[1]);
    await w.action('subscription.remove', { id: ben.id });
    const after = await row(half.json.blast.id);
    assert.deepEqual([...counts(after), after.retry_count], [1, 1, 0, 0]);
  }, { fail: (to) => to === subs[1] });

  // Another campaign's sends are never in the list.
  const other = new Client();
  await other.signup({ workspaceName: 'Blast Counts Other' });
  assert.deepEqual((await other.get('/api/blasts')).json.blasts, []);
});

// ── Pledges: the brief's open count ──
const pub = async (path, form) => {
  const res = await app.request(path, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(), redirect: 'manual',
  });
  return { status: res.status, text: await res.text() };
};
const eligible = { attest_individual: '1', attest_resident: '1', attest_own_funds: '1' };
const campaignToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });

test('brief: open pledges are one-time pledges not received + monthly pledges not received this month', async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Pledge Count WS', jurisdiction: 'bc-municipal' });
  const slug = r.json.workspace.slug;
  const tag = uniq();
  const give = async (who, amount, monthly) => {
    const res = await pub(`/d/${slug}`, {
      amount, name: who, email: `${who.toLowerCase().replace(/\W+/g, '.')}.${tag}@example.org`, address: '1 Main St',
      ...(monthly ? { monthly: '1' } : {}), ...eligible,
    });
    assert.equal(res.status, 200, res.text.slice(0, 200));
  };
  await give('Once Giver', '100', false);
  await give('Month Giver', '25', true);
  await give('Month Late', '10', true);
  const pledges = (await mgr.get('/api/pledges')).json.pledges;
  const byName = Object.fromEntries(pledges.map((p) => [p.name, p]));
  assert.equal(byName['Month Giver'].cadence, 'monthly');
  assert.ok(pledges.every((p) => 'last_received_on' in p && p.last_received_on === null), 'never received yet');
  const open = async () => (await mgr.get('/api/brief')).json.pledges;
  assert.deepEqual(await open(), { n: 3, cents: 13500 });

  const db = await getDb();
  const setLast = (id, sql) => db.query(`update pledges set last_received_on = ${sql} where id = $1`, [id]);
  // Received this month (campaign time): not open again until next month.
  await setLast(byName['Month Giver'].id, `(now() at time zone 'America/Vancouver')::date`);
  assert.deepEqual(await open(), { n: 2, cents: 11000 });
  // Last received a month ago: this month's gift is still to come.
  await setLast(byName['Month Late'].id, `((now() at time zone 'America/Vancouver')::date - interval '1 month')::date`);
  assert.deepEqual(await open(), { n: 2, cents: 11000 });
  const listed = (await mgr.get('/api/pledges')).json.pledges.find((p) => p.id === byName['Month Giver'].id);
  assert.equal(listed.last_received_on, campaignToday(), 'YYYY-MM-DD');

  // The real path: receive this month's gift for the late monthly pledge.
  const rec = await mgr.action('pledge.receive', { id: byName['Month Late'].id, method: 'etransfer', date: campaignToday() });
  assert.equal(rec.status, 200, JSON.stringify(rec.json));
  assert.deepEqual(await open(), { n: 1, cents: 10000 }, 'only the one-time pledge is open');
  const late = (await mgr.get('/api/pledges')).json.pledges.find((p) => p.id === byName['Month Late'].id);
  assert.equal(late.status, 'pledged', 'a monthly pledge stays open between months');
  assert.equal(late.last_received_on, campaignToday());

  // The one-time pledge received: nothing open.
  await mgr.action('pledge.receive', { id: byName['Once Giver'].id, method: 'cheque', date: campaignToday() });
  assert.deepEqual(await open(), { n: 0, cents: 0 });
});

test('shifts: mine marks the shifts the caller is actively on (by their login email)', async () => {
  const mgr = new Client();
  const s = await mgr.signup({ workspaceName: 'Mine Shift WS', email: `mine.mgr.${uniq()}@example.org` });
  const mgrEmail = s.json.user.email;
  const { client: vol } = await joinAs(mgr, 'volunteer', 'Mine Shifter');
  const mkShift = async (title, days) => (await mgr.action('shift.create', {
    title, starts_at: new Date(Date.now() + days * 86400e3).toISOString(), capacity: 5,
  })).json.shift;
  const a = await mkShift('Mine shift A', 3);
  const b = await mkShift('Mine shift B', 4);
  const cShift = await mkShift('Mine shift C', 5);

  // The volunteer books A themselves; the manager's own record is put on B;
  // someone else (no email) is on C; the manager's record is declined on C.
  assert.equal((await vol.action('shift.join', { shift_id: a.id })).status, 200);
  const mgrSelf = await mgr.createPerson('Mine Manager Self', { email: mgrEmail.toUpperCase() });
  await mgr.action('shift.assign', { shift_id: b.id, person_id: mgrSelf.id });
  const stranger = await mgr.createPerson('Mine Stranger');
  await mgr.action('shift.assign', { shift_id: cShift.id, person_id: stranger.id });
  const declined = (await mgr.action('shift.assign', { shift_id: cShift.id, person_id: mgrSelf.id })).json.assignment;
  await mgr.action('shift.setStatus', { id: declined.id, status: 'declined' });

  const mine = async (cl) => Object.fromEntries((await cl.get('/api/shifts')).json.shifts
    .filter((x) => [a.id, b.id, cShift.id].includes(x.id)).map((x) => [x.title, x.mine]));
  assert.deepEqual(await mine(vol), { 'Mine shift A': true, 'Mine shift B': false, 'Mine shift C': false });
  assert.deepEqual(await mine(mgr), { 'Mine shift A': false, 'Mine shift B': true, 'Mine shift C': false },
    'matched case-insensitively; declined is not on it');
  const briefShifts = (await vol.get('/api/brief')).json.shifts;
  assert.equal(briefShifts.find((x) => x.id === a.id).mine, true, 'the brief marks them too');

  // Leaving the shift: no longer theirs.
  assert.equal((await vol.action('shift.leave', { shift_id: a.id })).status, 200);
  assert.equal((await mine(vol))['Mine shift A'], false);
});
