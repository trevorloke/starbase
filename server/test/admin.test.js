// Admin (ext/admin + lib/perms.js): teams — made, filled, led, put on a turf
// in one go, emptied when someone leaves — and permissions: an area taken
// from a role or given to a person changes what they may do and see.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let mgr, staff, treas, vol;
let ids = {};
const tokenOf = (url) => url.split('/join/')[1];
const joinAs = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: `${name}.adm@example.org`, role });
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name, password: 'admin-pass-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ids[name] = r.json.user.id;
  return cl;
};
const areasOf = async (cl) => (await cl.get('/api/auth/me')).json.areas;

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', email: 'mgr.adm@example.org', jurisdiction: 'bc-municipal' });
  staff = await joinAs('staff', 'Sam');
  treas = await joinAs('treasurer', 'Tess');
  vol = await joinAs('volunteer', 'Vic');
});

test('each role starts with its usual areas; a manager has them all', async () => {
  assert.deepEqual(await areasOf(mgr), ['people', 'map', 'shifts', 'money', 'signs', 'outreach', 'website', 'data', 'admin']);
  assert.deepEqual(await areasOf(staff), ['people', 'map', 'shifts', 'money', 'signs', 'outreach', 'website', 'data']);
  assert.deepEqual(await areasOf(treas), ['people', 'map', 'shifts', 'money', 'signs', 'outreach', 'data']);
  assert.deepEqual(await areasOf(vol), []);
  assert.equal((await staff.get('/api/admin/permissions')).status, 403, 'admin is the manager’s');
  assert.equal((await staff.action('team.create', { name: 'x' })).status, 403);
});

test('teams: made, filled, a lead named, everyone on it put on a turf at once; a member who leaves is off it', async () => {
  const t = await mgr.action('team.create', { name: 'Newton crew', lead_user_id: ids.Sam });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  const teamId = t.json.team.id;
  assert.equal((await mgr.action('team.create', { name: 'newton CREW' })).status, 409, 'one name once');
  assert.equal((await mgr.action('team.member.add', { team_id: teamId, user_id: ids.Vic })).json.added, true);
  assert.equal((await mgr.action('team.member.add', { team_id: teamId, user_id: ids.Vic })).json.added, false, 'already on it');
  assert.equal((await mgr.action('team.member.add', { team_id: teamId, user_id: '00000000-0000-4000-8000-000000000000' })).status, 400);
  const list = (await staff.get('/api/teams')).json.teams;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].members.map((m) => m.name).sort(), ['Sam', 'Vic'], 'the lead is on the team');
  assert.equal(list[0].lead_user_id, ids.Sam);
  assert.equal((await vol.get('/api/teams')).status, 403);

  const turf = (await mgr.action('turf.create', { name: 'Newton 1', polygon: [[49.1, -122.8], [49.11, -122.8], [49.11, -122.79]] })).json.turf;
  const put = await mgr.action('turf.assign', { turf_id: turf.id, team_id: teamId });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(put.json.added, 2);
  assert.equal((await mgr.action('turf.assign', { turf_id: turf.id })).status, 400, 'a person or a team');
  const mine = (await vol.get('/api/turfs')).json.turfs;
  assert.ok(mine.some((x) => x.id === turf.id), 'the volunteer now walks it');

  assert.equal((await mgr.action('team.member.remove', { team_id: teamId, user_id: ids.Sam })).json.removed, true);
  assert.equal((await mgr.get('/api/teams')).json.teams[0].lead_user_id, null, 'the lead taken off is no lead');
  // Tess joins, then leaves the campaign: off the team with her.
  await mgr.action('team.member.add', { team_id: teamId, user_id: ids.Tess });
  assert.equal((await mgr.action('member.remove', { user_id: ids.Tess })).status, 200);
  assert.deepEqual((await mgr.get('/api/teams')).json.teams[0].members.map((m) => m.name), ['Vic']);
  assert.equal((await mgr.action('team.delete', { id: teamId })).status, 200);
  assert.deepEqual((await mgr.get('/api/teams')).json.teams, []);
});

test('permissions: an area taken from a role, or given to one person, changes what they may do and read', async () => {
  // Staff lose Money: the tab goes, reads and writes refuse.
  const set = await mgr.action('permission.role.set', { role: 'staff', deny: ['money'] });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.ok(!(await areasOf(staff)).includes('money'));
  assert.equal((await staff.get('/api/pledges')).status, 403);
  const p = await mgr.createPerson('Donor Example');
  assert.equal((await staff.action('gift.log', { person_id: p.id, amount_cents: 1000, date: '2026-10-01', method: 'cash' })).status, 403);
  assert.ok(!(await staff.get('/api/actions')).json.actions.includes('gift.log'), 'the list of what they may do says so too');
  // …but the rest is as it was.
  assert.equal((await staff.action('person.create', { name: 'Still Fine' })).status, 200);

  // Vic, a volunteer, is given Outreach: the writes and the desk-only reads open for that area only.
  assert.equal((await vol.action('cevent.create', { slug: 'vic-night', title: 'Vic night', starts_at: new Date(Date.now() + 86400e3).toISOString() })).status, 403);
  assert.equal((await mgr.action('permission.member.set', { user_id: ids.Vic, grant: ['outreach'] })).status, 200);
  assert.deepEqual(await areasOf(vol), ['outreach']);
  assert.equal((await vol.action('cevent.create', { slug: 'vic-night', title: 'Vic night', starts_at: new Date(Date.now() + 86400e3).toISOString() })).status, 200);
  assert.equal((await vol.get('/api/subscriptions')).status, 200, 'an outreach read');
  assert.equal((await vol.get('/api/pledges')).status, 403, 'money is still not theirs');
  assert.equal((await vol.get('/api/export')).status, 403);

  // A person's own deny beats the role's grant; "as their role" clears it.
  assert.equal((await mgr.action('permission.member.set', { user_id: ids.Sam, deny: ['website'] })).status, 200);
  assert.ok(!(await areasOf(staff)).includes('website'));
  assert.equal((await staff.get('/api/site/overview')).status, 403);
  assert.equal((await mgr.action('permission.member.set', { user_id: ids.Sam, grant: [], deny: [] })).status, 200);
  assert.ok((await areasOf(staff)).includes('website'));

  // The manager's own areas can't be touched; a bad area is refused.
  const me = (await mgr.get('/api/auth/me')).json.user;
  assert.equal((await mgr.action('permission.member.set', { user_id: me.id, deny: ['admin'] })).status, 400);
  assert.equal((await mgr.action('permission.role.set', { role: 'staff', deny: ['everything'] })).status, 400);
  const view = (await mgr.get('/api/admin/permissions')).json;
  assert.deepEqual(view.roles.staff.deny, ['money']);
  assert.deepEqual(view.members.find((m) => m.name === 'Vic').areas, ['outreach']);
  assert.ok(!view.members.find((m) => m.name === 'Sam').areas.includes('money'));
});
