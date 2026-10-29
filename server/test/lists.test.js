// Lists: a saved filter names whoever matches it today; a hand-picked list
// names the people put on it. Each says how many can be emailed or texted
// (do-not-email, do-not-contact, unsubscribed and opted-out numbers left
// out), exports as CSV, and is the desk's — volunteers are refused.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.lists.${tag}@example.org`;
let mgr;
let vol;
let people = {};

before(async () => {
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Imagine Surrey', email: mail('manager') });
  const inv = await mgr.action('member.invite', { email: mail('vol'), role: 'volunteer' });
  vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic Vol', password: 'lists-pass-2026' });
  const mk = async (name, extra) => { people[name] = await mgr.createPerson(name, extra); };
  await mk('Anne Voter', { email: mail('anne'), phone: '604-555-0101', tags: ['member'] });
  await mk('Bob Voter', { email: mail('bob'), phone: '604-555-0102', tags: ['member', 'do-not-email'] });
  await mk('Cara Voter', { phone: '604-555-0103', tags: ['volunteer'] });
  await mk('Dev Voter', { email: mail('dev'), tags: ['member', 'do-not-contact'] });
  await mk('Eve Voter', { email: mail('anne'), phone: '604-555-0101', tags: ['member'] }); // shares Anne's address and number
  await mgr.action('person.rate', { person_id: people['Anne Voter'].id, rating: '1' }).catch(() => {});
});

test('a saved filter: counts by reach, people, CSV; a volunteer is refused', async () => {
  const pv = await mgr.get('/api/lists/preview?tag=member');
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  assert.deepEqual(pv.json.counts, { total: 4, with_email: 1, with_phone: 2 }, 'Bob (do-not-email) and Dev (do-not-contact) can’t be emailed; Dev can’t be texted; Anne and Eve share one address and number');
  const made = await mgr.action('list.create', { name: 'Members', kind: 'filter', filter: { tag: 'member', nonsense: 'x' } });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.deepEqual(made.json.list.filter, { tag: 'member' }, 'only the query keys are kept');
  const id = made.json.list.id;
  const one = await mgr.get(`/api/lists/${id}`);
  assert.equal(one.json.total, 4);
  assert.deepEqual(one.json.people.map((p) => p.name), ['Anne Voter', 'Bob Voter', 'Dev Voter', 'Eve Voter']);
  const reach = await mgr.get(`/api/lists/${id}?reach=phone`);
  assert.deepEqual(reach.json.people.map((p) => p.name), ['Anne Voter', 'Bob Voter', 'Eve Voter']);
  const all = (await mgr.get('/api/lists')).json.lists;
  assert.equal(all[0].counts.total, 4);
  const csv = await app.request(`/api/lists/${id}/export.csv`, { headers: { cookie: mgr.cookie } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.match(text, /^\ufeff?Name,Email,Phone/);
  assert.ok(text.split('\r\n').filter(Boolean).length === 5, 'a header and four rows');
  assert.ok(text.includes('member; do-not-email'));
  assert.equal((await vol.get('/api/lists')).status, 403);
  assert.equal((await vol.action('list.create', { name: 'x', kind: 'filter' })).status, 403);
  // The filter changes what it names.
  await mgr.action('list.update', { id, filter: { tag: 'volunteer' } });
  assert.equal((await mgr.get(`/api/lists/${id}`)).json.total, 1);
});

test('a hand-picked list: add and remove people, only this campaign’s; tags with counts; delete', async () => {
  const made = await mgr.action('list.create', { name: 'Door captains', kind: 'people', person_ids: [people['Cara Voter'].id, '00000000-0000-4000-8000-000000000000'] });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.added, 1, 'a stranger’s id is ignored');
  const id = made.json.list.id;
  const add = await mgr.action('list.add', { id, person_ids: [people['Anne Voter'].id, people['Cara Voter'].id] });
  assert.equal(add.json.added, 1, 'Cara was already on it');
  assert.deepEqual((await mgr.get(`/api/lists/${id}`)).json.people.map((p) => p.name), ['Anne Voter', 'Cara Voter']);
  assert.equal((await mgr.action('list.remove', { id, person_ids: [people['Cara Voter'].id] })).json.removed, 1);
  assert.equal((await mgr.get(`/api/lists/${id}`)).json.total, 1);
  assert.equal((await mgr.action('list.add', { id: (await mgr.get('/api/lists')).json.lists.find((l) => l.kind === 'filter').id, person_ids: [people['Anne Voter'].id] })).status, 400);
  const tags = (await mgr.get('/api/lists/tags')).json.tags;
  assert.equal(tags.find((t) => t.tag === 'member').n, 4);
  assert.equal((await mgr.action('list.delete', { id })).status, 200);
  assert.equal((await mgr.get(`/api/lists/${id}`)).status, 404);
  assert.ok((await mgr.get('/api/export')).json.lists, 'in the export');
});
