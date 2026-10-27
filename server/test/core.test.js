// Core field fixes: a volunteer adds a new housemate at a door in their turf
// (name and phone only — the door's address and pin come with it, through
// the action log, once per phone id); the walk list carries each door's
// signs; the volunteer's brief carries no money-derived first steps; Today's
// texts count texts sent through the app; the export holds every campaign
// table (and no link tokens).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { verifyChain } from '../lib/events.js';

const tag = Math.random().toString(36).slice(2, 8);
const lat = 49.1327; const lng = -122.855;
let db, mgr, vol, volUser, ws, turf, home, far;

before(async () => {
  db = await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Core Field ${tag}`, jurisdiction: 'bc-municipal', email: `core.desk+${tag}@example.org` });
  ws = r.json.workspace.id;
  home = await mgr.createPerson('Maya Example', {
    address: '13213 72 Ave', unit: '2', city: 'Surrey', postal: 'V3W 2N5', lat, lng, phone: '604-555-0101', email: `core.maya+${tag}@example.org`,
  });
  far = await mgr.createPerson('Far Example', { address: '1 Other Rd', lat: 49.3, lng: -122.5 });
  turf = (await mgr.action('turf.create', {
    name: 'Newton block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
  })).json.turf;
  const inv = await mgr.action('member.invite', { email: `core.jas+${tag}@example.org`, role: 'volunteer' });
  vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Jas Example', password: 'walker-pass-1' });
  volUser = (await vol.get('/api/auth/me')).json.user;
  await mgr.action('turf.assign', { turf_id: turf.id, user_id: volUser.id });
});

test('a volunteer adds a housemate at a door in their turf: name and phone; the door comes with them', async () => {
  assert.equal((await vol.action('person.create', { name: 'Not Allowed' })).status, 403, 'person.create stays desk-only');
  assert.ok((await vol.get('/api/actions')).json.actions.includes('person.addAtDoor'));
  const id = randomUUID();
  const r = await vol.action('person.addAtDoor', { id, housemate_id: home.id, name: '  Ravi Example ', phone: '604-555-0102' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.person.id, id, 'the phone’s id');
  assert.equal(r.json.person.name, 'Ravi Example');
  assert.equal(r.json.person.address, '13213 72 Ave');
  assert.equal(r.json.person.unit, '2');
  assert.equal(r.json.person.lat, lat);
  assert.equal(r.json.person.email, undefined, 'no email key at all');
  const row = (await db.query('select * from persons where id = $1', [id])).rows[0];
  assert.equal(row.workspace_id, ws);
  assert.equal(row.city, 'Surrey');
  assert.equal(row.postal, 'V3W 2N5');
  assert.equal(row.lng, lng);
  assert.equal(row.email, null);

  // A replay (the answer got lost): the same person, never a second one.
  const again = await vol.action('person.addAtDoor', { id, housemate_id: home.id, name: 'Ravi Example', phone: '604-555-0102' });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal((await db.query("select count(*)::int as n from persons where workspace_id = $1 and name = 'Ravi Example'", [ws])).rows[0].n, 1);

  // On the walk list at the same door, and on the hash chain.
  const walk = (await vol.get(`/api/turfs/${turf.id}/walk`)).json;
  const door = walk.doors.find((d) => d.address === '13213 72 Ave');
  assert.deepEqual(door.persons.map((p) => p.name).sort(), ['Maya Example', 'Ravi Example']);
  const ev = (await db.query(
    "select action, actor_id, payload from events where workspace_id = $1 and entity_id = $2", [ws, id],
  )).rows;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].action, 'person.addAtDoor');
  assert.equal(ev[0].actor_id, volUser.id);
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('…but not at a door outside their turf, an unknown door, or with an id that is someone else', async () => {
  const out = await vol.action('person.addAtDoor', { housemate_id: far.id, name: 'Out Of Turf' });
  assert.equal(out.status, 403);
  assert.match(out.json.error, /not in your turf|isn’t in your turf/);
  assert.equal((await vol.action('person.addAtDoor', { housemate_id: randomUUID(), name: 'Nobody' })).status, 404);
  assert.equal((await vol.action('person.addAtDoor', { housemate_id: home.id, name: '   ' })).status, 400, 'a name is needed');
  // An id that is already someone (Maya, with an email): nothing written, and
  // the answer carries no email.
  const taken = await vol.action('person.addAtDoor', { id: home.id, housemate_id: home.id, name: 'Imposter' });
  assert.equal(taken.status, 200);
  assert.equal(taken.json.duplicate, true);
  assert.ok(!JSON.stringify(taken.json).includes('core.maya'), 'no one else’s email reaches a volunteer');
  assert.equal((await db.query("select count(*)::int as n from persons where workspace_id = $1 and name = 'Imposter'", [ws])).rows[0].n, 0);
  // The desk may add at any door (they can add anyone anyway).
  const desk = await mgr.action('person.addAtDoor', { housemate_id: far.id, name: 'Desk Added' });
  assert.equal(desk.status, 200);
  assert.equal(desk.json.person.address, '1 Other Rd');
});

test('the walk list carries each door’s signs, so "Wants a sign?" offers only what it lacks', async () => {
  const placed = await vol.action('sign.place', { person_id: home.id, kind: 'lawn', client_id: randomUUID() });
  assert.equal(placed.status, 200);
  let door = (await vol.get(`/api/turfs/${turf.id}/walk`)).json.doors.find((d) => d.address === '13213 72 Ave');
  assert.deepEqual(door.signs, [{ id: placed.json.sign.id, kind: 'lawn', status: 'requested' }]);
  assert.equal((await vol.action('sign.cancel', { id: placed.json.sign.id })).status, 200);
  door = (await vol.get(`/api/turfs/${turf.id}/walk`)).json.doors.find((d) => d.address === '13213 72 Ave');
  assert.deepEqual(door.signs, [], 'a cancelled request is gone');
});

test('the volunteer’s brief has no first steps (one is whether a gift was logged); the desk’s does', async () => {
  await mgr.action('gift.log', { person_id: home.id, amount_cents: 5000, date: '2026-03-01' });
  const v = (await vol.get('/api/brief')).json;
  assert.equal(v.activation, null);
  assert.ok(!JSON.stringify(v).includes('Log your first gift'));
  const d = (await mgr.get('/api/brief')).json;
  assert.equal(d.activation.steps.find((s) => s.key === 'gift').done, true);
});

test('Today’s texts count texts sent through the app; a rating logged after one is not a second text', async () => {
  const mgrUser = (await mgr.get('/api/auth/me')).json.user;
  const before = (await vol.get('/api/brief')).json.field;
  const deskBefore = (await mgr.get('/api/brief')).json.field;
  const conv = async (personId, by) => {
    const id = randomUUID();
    await db.query(
      'insert into texting_conversations (id, workspace_id, person_id, phone, started_by) values ($1, $2, $3, $4, $5)',
      [id, ws, personId, '+16045550101', by],
    );
    return id;
  };
  const msg = (convId, by, status = 'sent', direction = 'out') => db.query(
    `insert into texting_messages (id, workspace_id, conversation_id, direction, phone, body, status, sent_by)
     values ($1, $2, $3, $4, '+16045550101', 'Hi', $5, $6)`,
    [randomUUID(), ws, convId, direction, status, direction === 'out' ? by : null],
  );
  // Jas: three first texts and a reply; one more that Twilio refused.
  const p2 = await mgr.createPerson('Text Two', { phone: '604-555-0103' });
  const p3 = await mgr.createPerson('Text Three', { phone: '604-555-0104' });
  const c1 = await conv(home.id, volUser.id);
  await msg(c1, volUser.id);
  await msg(c1, null, 'received', 'in');
  await msg(c1, volUser.id, 'delivered');
  await msg(await conv(p2.id, volUser.id), volUser.id);
  await msg(await conv(p3.id, volUser.id), volUser.id);
  await msg(c1, volUser.id, 'failed');
  // …and rated Maya after texting her: logged as a text, the same conversation.
  await vol.action('contact.log', { person_id: home.id, channel: 'text', outcome: 'contacted', rating: '1' });
  // The desk: one text through the app.
  await msg(await conv(far.id, mgrUser.id), mgrUser.id);
  // A text from the phone's own Messages, logged by hand: still a text.
  await mgr.action('contact.log', { person_id: p2.id, channel: 'text', outcome: 'contacted' });

  const v = (await vol.get('/api/brief')).json.field;
  assert.equal(v.mine.texts - before.mine.texts, 4, 'You: 3 first texts + 1 reply');
  assert.equal(v.texts - before.texts, 6, 'Team: Jas’s 4, the desk’s 1, and the one logged by hand');
  assert.deepEqual(Object.keys(v.mine).sort(), ['calls', 'doors', 'texts'], 'numbers only');
  const d = (await mgr.get('/api/brief')).json.field;
  assert.equal(d.texts, v.texts);
  assert.equal(d.mine.texts - deskBefore.mine.texts, 2, 'the desk: 1 through the app + 1 logged by hand');
});

test('the export holds every campaign table — receipts, answers, opt-outs, ladders — and no link tokens', async () => {
  await db.query(
    "insert into texting_optouts (id, workspace_id, phone, opted_out, keyword) values ($1, $2, '+16045550109', true, 'stop')",
    [randomUUID(), ws],
  );
  await db.query(
    "insert into texting_member_phones (workspace_id, user_id, phone) values ($1, $2, '+16045550108')",
    [ws, volUser.id],
  );
  await mgr.action('survey.create', { name: 'Doors survey', context: 'door' });
  const ex = await mgr.get('/api/export');
  assert.equal(ex.status, 200);
  const x = ex.json;
  for (const key of [
    'persons', 'events', 'gifts', 'filings', 'contacts', 'signs', 'turfs', 'turf_members', 'shifts', 'shift_assignments',
    'pledges', 'blasts', 'blast_recipients', 'receipts', 'receipt_settings', 'surveys', 'survey_questions',
    'survey_responses', 'texting_optouts', 'texting_conversations', 'texting_messages', 'ladders', 'ladder_runs',
    'ladder_followups',
  ]) assert.ok(Array.isArray(x[key]), key);
  assert.ok(x.receipts.length >= 1, 'the gift’s receipt');
  assert.ok(x.receipts.every((r) => !('token' in r)), 'never the donor’s link');
  assert.ok(x.contacts.some((c) => c.channel === 'text'));
  assert.ok(x.surveys.some((s) => s.name === 'Doors survey'));
  assert.ok(x.texting_optouts.some((o) => o.phone === '+16045550109'));
  for (const key of ['users', 'sessions', 'invites', 'texting_member_phones', 'texting_calls']) {
    assert.equal(x[key], undefined, `${key} stays out`);
  }
  assert.ok(!JSON.stringify(x).includes('+16045550108'), 'a caller’s own phone is not exported');
  assert.equal((await vol.get('/api/export')).status, 403, 'still desk-only');
});

test('the basics, fixed where you meet them: a phone and a name by anyone; an email by a volunteer only where there is none', async () => {
  const p = (await mgr.createPerson('Fix Me', { address: home.address, lat: home.lat, lng: home.lng })).id;
  const r = await vol.action('person.details', { person_id: p, phone: '604-555-0177', name: 'Fixed Name' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.changed.sort(), ['name', 'phone']);
  assert.equal((await vol.action('person.details', { person_id: p })).status, 400, 'nothing to change');
  const e = await vol.action('person.details', { person_id: p, email: 'Fixed@Example.org' });
  assert.equal(e.status, 200, JSON.stringify(e.json));
  assert.equal(e.json.person.email, 'fixed@example.org', 'what they just typed comes back');
  const seen = (await vol.get(`/api/persons/${p}`)).json.person;
  assert.equal(seen.email, null, 'but never read back');
  assert.equal(seen.has_email, undefined, 'and nothing says one is on file');
  assert.equal(seen.phone, '604-555-0177');
  assert.equal(seen.name, 'Fixed Name');
  assert.equal((await vol.action('person.details', { person_id: p, email: 'other@example.org' })).status, 409, 'the office changes an email on file');
  assert.equal((await vol.action('person.details', { person_id: p, email: 'fixed@example.org' })).status, 409, 'the same again too — a guess is never confirmed');
  assert.equal((await vol.action('person.details', { person_id: p, email: 'not-an-email' })).status, 400);
  const m = await mgr.action('person.details', { person_id: p, email: 'office@example.org', phone: '' });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  const desk = (await mgr.get(`/api/persons/${p}`)).json.person;
  assert.equal(desk.email, 'office@example.org');
  assert.equal(desk.phone, null, 'an empty phone clears it');
  const d = await mgr.action('person.details', { person_id: p, email: '' });
  assert.equal(d.status, 200);
  assert.equal((await mgr.get(`/api/persons/${p}`)).json.person.email, null, 'the desk may clear an email');
});
