// Team: invites (new and existing accounts), roles, and token hygiene.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';

let mgr;
const tokenOf = (joinUrl) => joinUrl.split('/join/')[1];

before(async () => {
  await freshDb();
  delete process.env.RESEND_API_KEY;
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' });
});

test('manager invites a volunteer; the invitee joins with a new account in that role', async () => {
  const inv = await mgr.action('member.invite', { email: 'Jas@Example.org', role: 'volunteer' });
  assert.equal(inv.status, 200);
  assert.match(inv.json.joinUrl, /\/join\/[0-9a-f]{48}$/);
  assert.equal(inv.json.email, 'queued', 'emailed when a provider exists; queued otherwise');

  const anon = new Client();
  const look = await anon.get(`/api/auth/invite/${tokenOf(inv.json.joinUrl)}`);
  assert.equal(look.status, 200);
  assert.deepEqual(
    { email: look.json.email, role: look.json.role, ws: look.json.workspaceName, has: look.json.hasAccount },
    { email: 'jas@example.org', role: 'volunteer', ws: 'Imagine Surrey', has: false },
  );

  const joined = await anon.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name: 'Jas Volunteer', password: 'knock-knock-2026' });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.role, 'volunteer');
  assert.equal(joined.json.workspace.name, 'Imagine Surrey');
  assert.equal((await anon.get('/api/records/gift')).status, 403, 'joined as a volunteer, with volunteer limits');
  assert.equal((await anon.get('/api/map/doors')).status, 200);

  const reuse = await new Client().post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name: 'X', password: 'whatever-123' });
  assert.equal(reuse.status, 404, 'an invite works once');

  const relogin = new Client();
  const li = await relogin.post('/api/auth/login', { email: 'jas@example.org', password: 'knock-knock-2026' });
  assert.equal(li.status, 200);
  assert.equal(li.json.workspace.name, 'Imagine Surrey');
});

test('an existing Starbase user joins by proving their password', async () => {
  const other = new Client();
  await other.signup({ email: 'organizer@example.org', password: 'organizer-pass-1', workspaceName: 'Their Own Campaign' });
  const inv = await mgr.action('member.invite', { email: 'organizer@example.org', role: 'staff' });
  const t = tokenOf(inv.json.joinUrl);
  assert.equal((await new Client().get(`/api/auth/invite/${t}`)).json.hasAccount, true);
  const wrong = await new Client().post('/api/auth/join', { token: t, password: 'not-their-password' });
  assert.equal(wrong.status, 401);
  const ok = await new Client().post('/api/auth/join', { token: t, password: 'organizer-pass-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.role, 'staff');
  assert.equal(ok.json.workspace.name, 'Imagine Surrey');
});

test('team list, duplicate invite refused, role change, cannot demote yourself', async () => {
  const team = await mgr.get('/api/team');
  assert.equal(team.status, 200);
  assert.equal(team.json.members.length, 3);
  const jas = team.json.members.find((m) => m.email === 'jas@example.org');
  assert.equal(jas.role, 'volunteer');
  const dup = await mgr.action('member.invite', { email: 'jas@example.org', role: 'staff' });
  assert.equal(dup.status, 409);
  const promote = await mgr.action('member.setRole', { user_id: jas.id, role: 'staff' });
  assert.equal(promote.status, 200);
  const me = (await mgr.get('/api/auth/me')).json.user;
  const self = await mgr.action('member.setRole', { user_id: me.id, role: 'volunteer' });
  assert.equal(self.status, 400);
  const pending = await mgr.action('member.invite', { email: 'later@example.org', role: 'volunteer' });
  assert.equal(pending.status, 200);
  assert.ok((await mgr.get('/api/team')).json.invites.some((i) => i.email === 'later@example.org'));
});

test('removing a member ends their sign-in at once; not yourself; a new invite lets them back in', async () => {
  const inv = await mgr.action('member.invite', { email: 'leaver@example.org', role: 'staff' });
  const leaver = new Client();
  assert.equal((await leaver.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name: 'Lee Leaver', password: 'leaver-pass-1' })).status, 200);
  const id = (await leaver.get('/api/auth/me')).json.user.id;
  assert.equal((await leaver.action('person.create', { name: 'Before Leaving' })).status, 200);
  // A second signed-in device of theirs.
  const phone = new Client();
  assert.equal((await phone.post('/api/auth/login', { email: 'leaver@example.org', password: 'leaver-pass-1' })).status, 200);
  assert.equal((await mgr.action('turf.assign', { turf_id: (await mgr.action('turf.create', { name: 'Leaver turf', polygon: [[49.1, -122.8], [49.11, -122.8], [49.11, -122.79]] })).json.turf.id, user_id: id })).status, 200);

  const db = await getDb();
  const wsId = (await mgr.get('/api/auth/me')).json.workspace.id;
  await db.query('insert into texting_member_phones (workspace_id, user_id, phone) values ($1, $2, $3)', [wsId, id, '+16045550123']);

  const me = (await mgr.get('/api/auth/me')).json.user;
  assert.equal((await mgr.action('member.remove', { user_id: me.id })).status, 400, 'not yourself');
  const gone = await mgr.action('member.remove', { user_id: id });
  assert.equal(gone.status, 200, JSON.stringify(gone.json));
  assert.equal((await mgr.action('member.remove', { user_id: id })).status, 404, 'already gone');

  assert.equal((await leaver.get('/api/auth/me')).status, 401, 'signed out on the computer');
  assert.equal((await phone.get('/api/auth/me')).status, 401, 'and on the phone');
  assert.equal((await leaver.action('person.create', { name: 'After Leaving' })).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { email: 'leaver@example.org', password: 'leaver-pass-1' })).status, 403, 'no campaign to sign in to');
  const team = (await mgr.get('/api/team')).json;
  assert.ok(!team.members.some((m) => m.id === id));
  assert.ok(!(await mgr.get('/api/members')).json.members.some((m) => m.id === id), 'not offered for assignment');
  // What they did stays on the record.
  assert.equal((await mgr.get('/api/persons?q=Before%20Leaving')).json.persons.length, 1);
  assert.equal((await db.query('select count(*)::int as n from turf_members where user_id = $1', [id])).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int as n from texting_member_phones where user_id = $1', [id])).rows[0].n, 0, 'their own phone is forgotten');
  const ev = (await mgr.get('/api/events?since=0&limit=1000')).json.events.find((e) => e.entity_type === 'membership' && e.op === 'void');
  assert.ok(ev, 'the removal is on the log');
  assert.equal(ev.entity_id, id);

  // Back with a new invite, same account.
  const again = await mgr.action('member.invite', { email: 'leaver@example.org', role: 'volunteer' });
  assert.equal(again.status, 200);
  const back = new Client();
  assert.equal((await back.post('/api/auth/join', { token: tokenOf(again.json.joinUrl), password: 'leaver-pass-1' })).status, 200);
  assert.equal((await back.get('/api/auth/me')).json.role, 'volunteer');
  assert.equal((await back.get('/api/auth/me')).json.user.id, id);
});

test('only managers manage the team; tokens never enter the event log; expired invites fail', async () => {
  const inv = await mgr.action('member.invite', { email: 'expiring@example.org', role: 'volunteer' });
  const t = tokenOf(inv.json.joinUrl);
  const events = (await mgr.get('/api/events?since=0&limit=1000')).json.events;
  assert.ok(events.some((e) => e.entity_type === 'invite'));
  assert.ok(!JSON.stringify(events).includes(t), 'raw token absent from the log');

  const db = await getDb();
  await db.query(`update invites set expires_at = now() - interval '1 minute' where email = 'expiring@example.org'`);
  assert.equal((await new Client().get(`/api/auth/invite/${t}`)).status, 404);

  const staffInv = await mgr.action('member.invite', { email: 'staffer@example.org', role: 'staff' });
  const staff = new Client();
  await staff.post('/api/auth/join', { token: tokenOf(staffInv.json.joinUrl), name: 'Staffer', password: 'staffer-pass-1' });
  assert.equal((await staff.get('/api/team')).status, 403);
  assert.equal((await staff.action('member.invite', { email: 'x@example.org', role: 'volunteer' })).status, 403);
});

// Addresses below are unique to this file: under test:pg users are global.
const pendingFor = async (email) => (await mgr.get('/api/team')).json.invites.filter((i) => i.email === email);

test('"New link" really kills the old link: a re-invite expires the pending one', async () => {
  const first = await mgr.action('member.invite', { email: 'Relink.Team@Example.org', role: 'volunteer' });
  assert.equal(first.status, 200);
  const old = tokenOf(first.json.joinUrl);
  assert.equal((await new Client().get(`/api/auth/invite/${old}`)).status, 200);

  const second = await mgr.action('member.invite', { email: 'relink.team@example.org', role: 'staff' });
  assert.equal(second.status, 200);
  const fresh = tokenOf(second.json.joinUrl);
  assert.notEqual(fresh, old);
  assert.equal((await new Client().get(`/api/auth/invite/${old}`)).status, 404, 'old link is dead');
  assert.equal((await new Client().post('/api/auth/join', { token: old, name: 'Old Link', password: 'old-link-pass-1' })).status, 404);
  const look = await new Client().get(`/api/auth/invite/${fresh}`);
  assert.equal(look.status, 200);
  assert.equal(look.json.role, 'staff', 'the new link carries the new role');

  const pending = await pendingFor('relink.team@example.org');
  assert.deepEqual(pending.map((i) => i.id), [second.json.invite.id], 'one live invite per email');
  const ev = (await mgr.get('/api/events?since=0&limit=1000')).json.events;
  const voided = ev.find((e) => e.entity_type === 'invite' && e.op === 'void' && e.entity_id === first.json.invite.id);
  assert.ok(voided, 'the replaced invite is voided in the log');
  assert.equal(voided.payload.replaced_by, second.json.invite.id);
  assert.ok(!JSON.stringify(ev).includes(old) && !JSON.stringify(ev).includes(fresh), 'tokens stay out of the log');

  const joined = await new Client().post('/api/auth/join', { token: fresh, name: 'Relink Staff', password: 'relink-pass-1' });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.role, 'staff');
});

test('Cancel kills the link; cancelling twice is not found', async () => {
  assert.ok((await mgr.get('/api/actions')).json.actions.includes('member.cancelInvite'), 'Team shows Cancel only when offered');
  const inv = await mgr.action('member.invite', { email: 'cancel.team@example.org', role: 'volunteer' });
  const t = tokenOf(inv.json.joinUrl);
  const cancel = await mgr.action('member.cancelInvite', { id: inv.json.invite.id });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.id, inv.json.invite.id);
  assert.equal((await new Client().get(`/api/auth/invite/${t}`)).status, 404);
  assert.equal((await new Client().post('/api/auth/join', { token: t, name: 'Too Late', password: 'too-late-pass-1' })).status, 404);
  assert.deepEqual(await pendingFor('cancel.team@example.org'), [], 'gone from Invited');
  assert.equal((await mgr.action('member.cancelInvite', { id: inv.json.invite.id })).status, 404, 'nothing left to cancel');
  assert.equal((await mgr.action('member.cancelInvite', { id: '99999999-9999-4999-8999-999999999999' })).status, 404);
  const ev = (await mgr.get('/api/events?since=0&limit=1000')).json.events;
  assert.ok(ev.some((e) => e.action === 'member.cancelInvite' && e.op === 'void' && e.entity_id === inv.json.invite.id));
  assert.equal((await mgr.get('/api/audit/verify')).json.ok, true);

  // A cancelled invite can be sent again with a working link.
  const again = await mgr.action('member.invite', { email: 'cancel.team@example.org', role: 'volunteer' });
  assert.equal((await new Client().get(`/api/auth/invite/${tokenOf(again.json.joinUrl)}`)).status, 200);
});

test('only managers cancel invites, and only their own campaign\'s', async () => {
  const target = await mgr.action('member.invite', { email: 'keep.team@example.org', role: 'volunteer' });
  const t = tokenOf(target.json.joinUrl);
  const join = async (email, role, name) => {
    const inv = await mgr.action('member.invite', { email, role });
    const cl = new Client();
    const r = await cl.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name, password: `${role}-pass-2026` });
    assert.equal(r.status, 200);
    return cl;
  };
  const staff = await join('staff.cancel.team@example.org', 'staff', 'Cancel Staff');
  const vol = await join('vol.cancel.team@example.org', 'volunteer', 'Cancel Vol');
  for (const cl of [staff, vol]) {
    assert.equal((await cl.action('member.cancelInvite', { id: target.json.invite.id })).status, 403);
    assert.ok(!(await cl.get('/api/actions')).json.actions.includes('member.cancelInvite'));
  }
  const otherMgr = new Client();
  await otherMgr.signup({ workspaceName: 'Another Campaign' });
  assert.equal((await otherMgr.action('member.cancelInvite', { id: target.json.invite.id })).status, 404, 'another campaign cannot touch it');
  assert.equal((await new Client().get(`/api/auth/invite/${t}`)).status, 200, 'still works');
});

test('joining and creating a campaign are on the hash chain', async () => {
  const boss = new Client();
  const s = await boss.signup({ workspaceName: 'Chain WS', jurisdiction: 'bc-municipal' });
  assert.equal(s.status, 201);
  let ev = (await boss.get('/api/events?limit=50')).json.events || [];
  assert.ok(ev.some((e) => e.action === 'workspace.create' && e.entity_type === 'membership'), 'the founding manager is on the log');
  const inv = await boss.action('member.invite', { email: 'chain.joiner@example.org', role: 'volunteer' });
  const joiner = new Client();
  const j = await joiner.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Chain Joiner', password: 'chain-joiner-2026' });
  assert.equal(j.status, 200);
  ev = (await boss.get('/api/events?limit=50')).json.events || [];
  const join = ev.find((e) => e.action === 'member.join' && e.entity_type === 'membership');
  assert.ok(join, 'the new member is on the log');
  assert.equal(join.payload.role, 'volunteer');
  assert.equal((await boss.get('/api/audit/verify')).json.ok, true);
});
