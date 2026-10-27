// Phone banks (ext/banks): a bank from a list of people (only those with a
// phone, never do-not-contact), numbers handed to a caller or split across
// a team, a caller's own list, a logged call crossing the number off,
// skipping, taking numbers back, closing.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let mgr, vic, wen, staff;
let ids = {};
const tokenOf = (url) => url.split('/join/')[1];
const joinAs = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: `${name}.bank@example.org`, role });
  const cl = new Client();
  const r = await cl.post('/api/auth/join', { token: tokenOf(inv.json.joinUrl), name, password: 'bank-pass-2026' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ids[name] = r.json.user.id;
  return cl;
};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', email: 'mgr.bank@example.org', jurisdiction: 'bc-municipal' });
  staff = await joinAs('staff', 'Sam');
  vic = await joinAs('volunteer', 'Vic');
  wen = await joinAs('volunteer', 'Wen');
  ids.people = [];
  for (let i = 0; i < 6; i++) ids.people.push((await mgr.createPerson(`Caller Target ${i}`, { phone: `604-555-01${String(i).padStart(2, '0')}` })).id);
  ids.noPhone = (await mgr.createPerson('No Phone')).id;
  ids.dnc = (await mgr.createPerson('Do Not', { phone: '604-555-0199', tags: ['do-not-contact'] })).id;
});

test('a bank is made from a list: with a phone, never do-not-contact; the desk sees it, volunteers don’t', async () => {
  const r = ok(await mgr.action('bank.create', { name: 'Undecided in Newton', script: 'Hi, this is {you} from Imagine Surrey…', person_ids: [...ids.people, ids.noPhone, ids.dnc, ids.people[0]] }));
  ids.bank = r.bank.id;
  assert.equal(r.added, 6, 'six with a phone, the repeat once');
  assert.equal(r.skipped, 3, 'no phone, do-not-contact, and the repeat');
  assert.deepEqual([r.bank.total, r.bank.assigned, r.bank.done, r.bank.open], [6, 0, 0, 6]);
  assert.equal((await vic.action('bank.create', { name: 'x', person_ids: [] })).status, 403);
  assert.equal((await vic.get('/api/banks')).status, 403);
  assert.equal((await vic.get(`/api/banks/${ids.bank}`)).status, 403);
  const list = ok(await staff.get('/api/banks')).banks;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Undecided in Newton');
  assert.equal(list[0].total, 6);
});

test('numbers are handed to a caller; their list is the people left; a logged call crosses one off', async () => {
  const a = ok(await mgr.action('bank.assign', { id: ids.bank, user_id: ids.Vic, count: 3 }));
  assert.equal(a.handed, 3);
  assert.equal(a.assigned, 3);
  assert.deepEqual(a.given, { [ids.Vic]: 3 });
  assert.equal((await mgr.action('bank.assign', { id: ids.bank })).status, 400, 'a caller or a team');
  const mine = ok(await vic.get('/api/banks/mine')).banks;
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0].total, mine[0].done, mine[0].left], [3, 0, 3]);
  assert.equal(ok(await wen.get('/api/banks/mine')).banks.length, 0, 'nothing handed to Wen yet');
  const list = ok(await vic.get(`/api/banks/${ids.bank}/mine`));
  assert.equal(list.bank.script, 'Hi, this is {you} from Imagine Surrey…');
  assert.equal(list.persons.length, 3);
  assert.equal(list.persons[0].name, 'Caller Target 0', 'in the bank’s order');
  assert.ok(list.persons[0].phone);
  assert.equal(list.persons[0].email, null, 'a volunteer never gets an email that isn’t theirs');
  // A phone call Vic logs crosses the number off; a door knock does not.
  ok(await vic.action('contact.log', { person_id: ids.people[0], channel: 'phone', outcome: 'contacted', rating: '2' }));
  ok(await vic.action('contact.log', { person_id: ids.people[1], channel: 'door', outcome: 'no_answer' }));
  const after = ok(await vic.get(`/api/banks/${ids.bank}/mine`));
  assert.deepEqual(after.persons.map((p) => p.name), ['Caller Target 1', 'Caller Target 2']);
  assert.deepEqual([after.bank.total, after.bank.done], [3, 1]);
  const detail = ok(await mgr.get(`/api/banks/${ids.bank}`));
  const n0 = detail.numbers.find((n) => n.person_id === ids.people[0]);
  assert.equal(n0.outcome, 'contacted'); assert.equal(n0.caller, 'Vic'); assert.ok(n0.done_at);
  assert.deepEqual(detail.bank.callers, [{ user_id: ids.Vic, name: 'Vic', total: 3, done: 1 }]);
  // Someone else's phone call to that number doesn't cross off Vic's.
  ok(await wen.action('contact.log', { person_id: ids.people[1], channel: 'phone', outcome: 'no_answer' }));
  assert.equal(ok(await vic.get(`/api/banks/${ids.bank}/mine`)).persons.length, 2, 'still Vic’s to call');
});

test('skipping a number, taking numbers back, splitting the rest across a team, closing', async () => {
  assert.equal((await wen.action('bank.done', { id: ids.bank, person_id: ids.people[1] })).status, 403, 'not Wen’s number');
  ok(await vic.action('bank.done', { id: ids.bank, person_id: ids.people[1], outcome: 'wrong number' }));
  assert.equal(ok(await vic.get(`/api/banks/${ids.bank}/mine`)).persons.length, 1);
  const rel = ok(await mgr.action('bank.release', { id: ids.bank, user_id: ids.Vic }));
  assert.equal(rel.released, 1, 'the one left, not the two done');
  assert.equal(ok(await vic.get('/api/banks/mine')).banks[0].left, 0);
  // A team of two gets the four open numbers, two each.
  const team = ok(await mgr.action('team.create', { name: 'Phone crew' })).team;
  ok(await mgr.action('team.member.add', { team_id: team.id, user_id: ids.Vic }));
  ok(await mgr.action('team.member.add', { team_id: team.id, user_id: ids.Wen }));
  const split = ok(await mgr.action('bank.assign', { id: ids.bank, team_id: team.id }));
  assert.equal(split.handed, 4);
  assert.equal(split.assigned, 6, 'counting the two already done');
  assert.deepEqual(split.given, { [ids.Vic]: 2, [ids.Wen]: 2 });
  assert.equal(split.open, 0);
  assert.equal(ok(await wen.get('/api/banks/mine')).banks[0].left, 2);
  // More numbers later; closing stops handing out, and the bank leaves callers' lists.
  const more = ok(await mgr.action('bank.add', { id: ids.bank, person_ids: [ids.noPhone, ids.people[5]] }));
  assert.equal(more.added, 0, 'already in, or no phone');
  ok(await mgr.action('bank.update', { id: ids.bank, closed: true }));
  assert.equal((await mgr.action('bank.assign', { id: ids.bank, user_id: ids.Wen })).status, 409);
  assert.equal(ok(await wen.get('/api/banks/mine')).banks.length, 0, 'a closed bank is off the list');
  assert.equal(ok(await mgr.get('/api/banks')).banks[0].closed, true);
  ok(await mgr.action('bank.update', { id: ids.bank, closed: false, name: 'Undecided in Newton (2)' }));
  assert.equal(ok(await wen.get('/api/banks/mine')).banks.length, 1);
  ok(await mgr.action('bank.remove', { id: ids.bank }));
  assert.equal((await mgr.get(`/api/banks/${ids.bank}`)).status, 404);
  assert.equal(ok(await wen.get('/api/banks/mine')).banks.length, 0);
});
