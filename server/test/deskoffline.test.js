// The desk with no signal, server half: the profile's safe writes replay from
// the outbox exactly once. person.tag dedupes on its client_id (kept in
// client_writes), touches only the tags it names, logs nothing when nothing
// changes, and is desk-only; a note or rating saved offline is a contact.log
// with its own client_id, recorded once.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';

const tag = Math.random().toString(36).slice(2, 8);
let c; let other; let vol; let ws;

const events = async (who, entityId) => (await who.get('/api/events?since=0&limit=5000')).json.events
  .filter((e) => e.action === 'person.tag' && (!entityId || e.entity_id === entityId));
const tagsOf = async (who, id) => (await who.get(`/api/persons/${id}`)).json.person.tags;

before(async () => {
  await freshDb();
  c = new Client();
  const r = await c.signup({ workspaceName: `Desk Offline ${tag}`, email: `deskoff.mgr+${tag}@example.org` });
  assert.equal(r.status, 201);
  ws = r.json.workspace.id;
  other = new Client();
  assert.equal((await other.signup({ workspaceName: `Desk Offline Other ${tag}`, email: `deskoff.other+${tag}@example.org` })).status, 201);
  const inv = await c.action('member.invite', { email: `deskoff.vol+${tag}@example.org`, role: 'volunteer' });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  vol = new Client();
  const token = inv.json.joinUrl.split('/join/')[1];
  const j = await vol.post('/api/auth/join', { token, name: 'Desk Offline Volunteer', password: 'knock-knock-2026' });
  assert.ok(j.status === 200 || j.status === 201, JSON.stringify(j.json));
});

test('person.tag: adds and takes off only the tags it names', async () => {
  const p = await c.createPerson('Tag Person', { tags: ['media', 'VIP'] });
  const r = await c.action('person.tag', { id: p.id, add: ['host'], remove: ['VIP'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.person.tags, ['media', 'host']);
  assert.deepEqual(await tagsOf(c, p.id), ['media', 'host']);
  const evs = await events(c, p.id);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].op, 'update');
  assert.deepEqual(evs[0].payload.tags, ['media', 'host']);
  assert.deepEqual(evs[0].payload.added, ['host']);
  assert.deepEqual(evs[0].payload.removed, ['VIP']);

  // Someone else's change meanwhile (the whole list, as the old editor sent it) stays.
  assert.equal((await c.action('person.update', { id: p.id, tags: ['media', 'host', 'endorser'] })).status, 200);
  assert.equal((await c.action('person.tag', { id: p.id, add: ['volunteer'] })).status, 200);
  assert.deepEqual(await tagsOf(c, p.id), ['media', 'host', 'endorser', 'volunteer']);
});

test('person.tag: a replay of the same client id is recorded once, even after a later change', async () => {
  const p = await c.createPerson('Replay Person', { tags: [] });
  const cid = randomUUID();
  const first = await c.action('person.tag', { id: p.id, add: ['media'], client_id: cid });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.duplicate, undefined);
  assert.deepEqual(first.json.person.tags, ['media']);

  const again = await c.action('person.tag', { id: p.id, add: ['media'], client_id: cid });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.deepEqual(again.json.person.tags, ['media']);

  // The desk takes it off; a late replay of the old add must not put it back.
  assert.equal((await c.action('person.tag', { id: p.id, remove: ['media'], client_id: randomUUID() })).status, 200);
  const late = await c.action('person.tag', { id: p.id, add: ['media'], client_id: cid });
  assert.equal(late.json.duplicate, true);
  assert.deepEqual(await tagsOf(c, p.id), []);
  assert.equal((await events(c, p.id)).length, 2, 'one add, one remove — never the replays');
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
});

test('person.tag: nothing to change logs nothing; a used id is refused for another person', async () => {
  const p = await c.createPerson('Steady Person', { tags: ['media'] });
  const q = await c.createPerson('Other Person', { tags: [] });
  const cid = randomUUID();
  const same = await c.action('person.tag', { id: p.id, add: ['media'], remove: ['not-there'], client_id: cid });
  assert.equal(same.status, 200, JSON.stringify(same.json));
  assert.equal(same.json.unchanged, true);
  assert.equal((await events(c, p.id)).length, 0);
  assert.equal((await c.action('person.tag', { id: p.id, add: ['media'], client_id: cid })).json.duplicate, true);
  const taken = await c.action('person.tag', { id: q.id, add: ['media'], client_id: cid });
  assert.equal(taken.status, 409);
  assert.deepEqual(await tagsOf(c, q.id), []);
  assert.equal((await c.action('person.tag', { id: p.id, add: [], remove: [] })).status, 400);
});

test('person.tag: limits, unknown people, other campaigns, volunteers', async () => {
  const p = await c.createPerson('Many Tags', { tags: Array.from({ length: 49 }, (_, i) => `t${i}`) });
  assert.equal((await c.action('person.tag', { id: p.id, add: ['one-more'] })).status, 200);
  const over = await c.action('person.tag', { id: p.id, add: ['too-many'] });
  assert.equal(over.status, 400);
  assert.match(over.json.error, /50 tags max/);
  assert.equal((await c.action('person.tag', { id: p.id, add: ['x'.repeat(41)] })).status, 400);
  assert.equal((await c.action('person.tag', { id: randomUUID(), add: ['media'] })).status, 404);

  // Client ids are per campaign: the same id elsewhere is a different write.
  const cid = randomUUID();
  const mine = await c.createPerson('Shared Id Mine', { tags: [] });
  const theirs = await other.createPerson('Shared Id Theirs', { tags: [] });
  assert.equal((await c.action('person.tag', { id: mine.id, add: ['media'], client_id: cid })).status, 200);
  const elsewhere = await other.action('person.tag', { id: theirs.id, add: ['media'], client_id: cid });
  assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.json));
  assert.equal(elsewhere.json.duplicate, undefined);
  // …and one campaign can't touch another's people.
  assert.equal((await other.action('person.tag', { id: mine.id, add: ['VIP'] })).status, 404);

  const v = await vol.action('person.tag', { id: mine.id, add: ['VIP'] });
  assert.equal(v.status, 403);
  assert.ok(!(await vol.get('/api/actions')).json.actions.includes('person.tag'));
  assert.ok((await c.get('/api/actions')).json.actions.includes('person.tag'));
});

test('person.tag starts a ladder that starts on that tag — once, not on the replay', async () => {
  const created = await c.action('ladder.create', {
    name: `Hosts ${tag}`, trigger: { kind: 'tag', ref: `host-${tag}` }, steps: [{ kind: 'followup', text: 'Call {{first_name}}' }],
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const ladderId = created.json.ladder.id;
  assert.equal((await c.action('ladder.setActive', { id: ladderId, active: true })).status, 200);
  const p = await c.createPerson('Ladder Person', { tags: [] });
  const cid = randomUUID();
  assert.equal((await c.action('person.tag', { id: p.id, add: [`host-${tag}`], client_id: cid })).status, 200);
  assert.equal((await c.action('person.tag', { id: p.id, add: [`host-${tag}`], client_id: cid })).json.duplicate, true);
  const on = (await c.get(`/api/ladders/${ladderId}`)).json.people.filter((x) => x.person.id === p.id);
  assert.equal(on.length, 1, 'on the ladder once');
});

test('a note saved offline (contact.log, no rating) replays once; client_writes is in the export', async () => {
  const p = await c.createPerson('Note Person', { phone: '604-555-0142' });
  const cid = randomUUID();
  const note = { person_id: p.id, channel: 'phone', outcome: 'contacted', note: 'Wants to host a coffee', client_id: cid };
  assert.equal((await c.action('contact.log', note)).status, 200);
  const again = await c.action('contact.log', note);
  assert.equal(again.json.duplicate, true);
  const prof = (await c.get(`/api/persons/${p.id}`)).json;
  assert.equal(prof.contacts.length, 1);
  assert.equal(prof.contacts[0].note, 'Wants to host a coffee');
  assert.equal(prof.person.rating, null);

  const tagged = await c.createPerson('Export Person', { tags: [] });
  const tcid = randomUUID();
  assert.equal((await c.action('person.tag', { id: tagged.id, add: ['media'], client_id: tcid })).status, 200);
  const exp = (await c.get('/api/export')).json;
  assert.ok(Array.isArray(exp.client_writes));
  assert.ok(exp.client_writes.some((r) => r.client_id === tcid && r.action === 'person.tag' && r.entity_id === tagged.id));
  assert.ok(exp.client_writes.every((r) => r.workspace_id === ws));
  assert.equal((await vol.get('/api/export')).status, 403);
});
