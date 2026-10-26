// Dashboard (ext/dashboard): managers see every team's contacts and where
// everyone in the field is; a volunteer's "I'm here" (field.ping) puts them
// on the map while they share it, and off it when they stop.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let mgr, staff, vol, vol2;
let ids = {};
const tokenOf = (url) => url.split('/join/')[1];
const joinAs = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: `${name}.dash@example.org`, role });
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name, password: 'dash-pass-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ids[name] = r.json.user.id;
  return cl;
};

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', email: 'mgr.dash@example.org', jurisdiction: 'bc-municipal' });
  staff = await joinAs('staff', 'Sam');
  vol = await joinAs('volunteer', 'Vic');
  vol2 = await joinAs('volunteer', 'Wen');
});

test('the dashboard is the manager’s', async () => {
  assert.equal((await staff.get('/api/dashboard')).status, 403);
  assert.equal((await vol.get('/api/dashboard')).status, 403);
  const r = await mgr.get('/api/dashboard');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.period, '30d');
  assert.equal(r.json.series.length, 30, 'a bar per day of the last thirty');
  assert.deepEqual(r.json.people, []);
  assert.equal(r.json.overview.all.contacts, 0);
});

test('every team’s contacts, by outcome, and the people behind them', async () => {
  const team = (await mgr.action('team.create', { name: 'Newton crew' })).json.team;
  await mgr.action('team.member.add', { team_id: team.id, user_id: ids.Vic });
  const a = (await mgr.action('person.create', { name: 'Door A', address: '13450 104 Ave', lat: 49.19, lng: -122.85 })).json.person;
  const b = (await mgr.action('person.create', { name: 'Door B', address: '13460 104 Ave', lat: 49.191, lng: -122.851 })).json.person;
  const k1 = await vol.action('contact.log', { person_id: a.id, channel: 'door', outcome: 'contacted', rating: '1' });
  assert.equal(k1.status, 200, JSON.stringify(k1.json));
  await vol.action('contact.log', { person_id: b.id, channel: 'door', outcome: 'no_answer' });
  await vol2.action('contact.log', { person_id: b.id, channel: 'phone', outcome: 'refused', rating: '4' });

  const d = (await mgr.get('/api/dashboard?period=today')).json;
  assert.equal(d.period, 'today');
  assert.equal(d.series.length, 1);
  assert.equal(d.series[0].day, d.today);
  assert.deepEqual([d.series[0].contacted, d.series[0].no_answer, d.series[0].refused], [1, 1, 1]);
  assert.equal(d.overview.today.contacts, 3);
  assert.equal(d.overview.today.doors, 2);
  assert.equal(d.overview.today.calls, 1);
  assert.equal(d.overview.today.people, 2, 'two people reached');
  assert.equal(d.overview.today.support, 1, 'one rating in the support band');
  assert.equal(d.overview.today.who, 2, 'two canvassers');
  assert.equal(d.overview.all.contacts, 3);

  const crew = d.teams.find((t) => t.name === 'Newton crew');
  assert.deepEqual([crew.members, crew.contacts, crew.contacted, crew.no_answer, crew.refused], [1, 2, 1, 1, 0]);
  const none = d.teams.find((t) => t.name === 'No team');
  assert.deepEqual([none.contacts, none.refused], [1, 1], 'Wen is on no team');

  assert.deepEqual(d.people.map((p) => p.name).sort(), ['Vic', 'Wen']);
  const vic = d.people.find((p) => p.name === 'Vic');
  assert.deepEqual(vic.teams, ['Newton crew']);
  assert.equal(vic.contacts, 2);
  assert.equal(vic.out_now, false);
  assert.equal(vic.sharing, false);
  assert.equal(vic.where.from, 'contact', 'last known place: the last door they knocked');
  assert.equal(vic.where.lat, 49.191);
  assert.equal(d.pins.length, 3);
  assert.equal(d.recent.length, 3);
  assert.equal(d.recent[0].who, 'Wen');
  assert.equal(d.recent[0].person, 'Door B');
  assert.equal(d.out_now, 0);
});

test('I’m here: a ping puts a volunteer on the map now; off takes them off it', async () => {
  const p1 = await vol.action('field.ping', { lat: 49.2, lng: -122.86, accuracy: 12 });
  assert.equal(p1.status, 200, JSON.stringify(p1.json));
  assert.equal(p1.json.sharing, true);
  assert.equal(p1.json.trail, true);
  const p2 = await vol.action('field.ping', { lat: 49.20001, lng: -122.86001 });
  assert.equal(p2.json.trail, false, 'a metre on is not a new trail point');
  const p3 = await vol.action('field.ping', { lat: 49.201, lng: -122.86 });
  assert.equal(p3.json.trail, true, 'a hundred metres on is');
  assert.equal((await vol.action('field.ping', { accuracy: 5 })).status, 400, 'lat and lng, or off');
  assert.equal((await vol.action('field.ping', { lat: 91, lng: 0 })).status, 400);

  let d = (await mgr.get('/api/dashboard')).json;
  const vic = d.people.find((p) => p.name === 'Vic');
  assert.equal(vic.sharing, true);
  assert.equal(vic.out_now, true);
  assert.equal(vic.where.from, 'position');
  assert.equal(vic.where.lat, 49.201);
  assert.equal(vic.trail.length, 2);
  assert.equal(d.out_now, 1);
  assert.equal(d.teams.find((t) => t.name === 'Newton crew').out, 1, 'the team has one out');
  assert.equal(d.people[0].name, 'Vic', 'whoever is out now comes first');

  const events = (await mgr.get('/api/events?limit=50')).json;
  const rows = Array.isArray(events) ? events : (events.events || events.rows || []);
  assert.ok(!rows.some((e) => e.action === 'field.ping'), 'a ping is not on the event log');

  const off = await vol.action('field.ping', { off: true });
  assert.equal(off.json.sharing, false);
  d = (await mgr.get('/api/dashboard')).json;
  const vic2 = d.people.find((p) => p.name === 'Vic');
  assert.equal(vic2.sharing, false);
  assert.equal(vic2.out_now, false);
  assert.equal(vic2.where.from, 'contact', 'back to the last door');
  assert.equal(d.out_now, 0);
});

test('a volunteer denied every area may still say where they are; a member who leaves is off the map', async () => {
  await mgr.action('permission.member.set', { user_id: ids.Wen, grant: [], deny: ['people', 'map', 'admin'] });
  const r = await vol2.action('field.ping', { lat: 49.1, lng: -122.8 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await mgr.get('/api/dashboard')).json.out_now, 1);
  const rm = await mgr.action('member.remove', { user_id: ids.Wen });
  assert.equal(rm.status, 200, JSON.stringify(rm.json));
  assert.equal((await mgr.get('/api/dashboard')).json.out_now, 0);
});

test('periods: a week of days, a month of days, all time by the week', async () => {
  assert.equal((await mgr.get('/api/dashboard?period=7d')).json.series.length, 7);
  const all = (await mgr.get('/api/dashboard?period=all')).json;
  assert.equal(all.granularity, 'week');
  assert.ok(all.series.length >= 1);
  assert.equal(all.series.reduce((a, d) => a + d.contacted + d.no_answer + d.refused, 0), 3, 'every contact in one week or another');
  assert.equal((await mgr.get('/api/dashboard?period=bogus')).json.period, '30d');
});
