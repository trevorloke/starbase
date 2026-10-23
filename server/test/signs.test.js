// Signs: a request that never went up can be cancelled (sign.cancel) — it
// leaves every list, map and count, and the log keeps a 'void' event with
// what was cancelled. A sign that went up can't be cancelled, only taken down.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

let c;
const tag = Math.random().toString(36).slice(2, 8);

before(async () => {
  await freshDb();
  c = new Client();
  const r = await c.signup({ workspaceName: 'Sign Crew', email: `signs.mgr+${tag}@example.org` });
  assert.equal(r.status, 201);
});

const signsList = async (who = c) => (await who.get('/api/signs')).json.signs;
const briefSigns = async (who = c) => (await who.get('/api/brief')).json.signs;

test('a requested sign cancels and vanishes from the list, the map and the counts', async () => {
  const host = await c.createPerson('Cancel Host', { address: '7200 132 St', lat: 49.13, lng: -122.85 });
  const keep = await c.action('sign.place', { person_id: host.id, kind: 'large' });
  const req = await c.action('sign.place', { person_id: host.id, kind: 'lawn', note: 'by the driveway' });
  assert.equal(req.status, 200);
  const id = req.json.sign.id;
  assert.equal((await briefSigns()).requested, 2);
  assert.ok((await c.get('/api/map/doors')).json.signs.some((s) => s.id === id));

  const r = await c.action('sign.cancel', { id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.cancelled, true);

  assert.ok(!(await signsList()).some((s) => s.id === id), 'gone from the sign list');
  assert.ok((await signsList()).some((s) => s.id === keep.json.sign.id), 'the other request stays');
  assert.ok(!(await c.get('/api/map/doors')).json.signs.some((s) => s.id === id), 'gone from the map');
  const counts = await briefSigns();
  assert.equal(counts.requested, 1, 'one left to put up');
  assert.equal(counts.removed ?? 0, 0, 'a cancelled request is never counted as taken down');
  const prof = (await c.get(`/api/persons/${host.id}`)).json;
  assert.deepEqual(prof.signs.map((s) => s.kind), ['large'], 'gone from the host’s profile');

  // The log keeps exactly what was cancelled, and the chain still verifies.
  const ev = (await c.get('/api/events?since=0&limit=1000')).json.events
    .filter((e) => e.action === 'sign.cancel');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].entity_type, 'sign');
  assert.equal(ev[0].entity_id, id);
  assert.equal(ev[0].op, 'void');
  assert.equal(ev[0].payload.kind, 'lawn');
  assert.equal(ev[0].payload.status, 'requested');
  assert.equal(ev[0].payload.person_id, host.id);
  assert.equal(ev[0].payload.address, '7200 132 St');
  assert.equal(ev[0].payload.note, 'by the driveway');
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);

  assert.equal((await c.action('sign.cancel', { id })).status, 404, 'already gone');
});

test('a sign that is up — or was taken down — cannot be cancelled', async () => {
  const up = await c.action('sign.place', { address: '15013 101 Ave', kind: 'billboard' });
  assert.equal((await c.action('sign.update', { id: up.json.sign.id, status: 'installed' })).status, 200);
  const refused = await c.action('sign.cancel', { id: up.json.sign.id });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /already up/);
  assert.equal((await signsList()).find((s) => s.id === up.json.sign.id).status, 'installed', 'left as it was');

  assert.equal((await c.action('sign.update', { id: up.json.sign.id, status: 'removed' })).status, 200);
  const down = await c.action('sign.cancel', { id: up.json.sign.id });
  assert.equal(down.status, 409);
  assert.match(down.json.error, /taken down/);
  assert.ok((await signsList()).some((s) => s.id === up.json.sign.id), 'history stays');

  const evs = (await c.get('/api/events?since=0&limit=1000')).json.events.filter((e) => e.action === 'sign.cancel');
  assert.equal(evs.length, 1, 'refused cancels log nothing');
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
});

test('volunteers can cancel a request; another campaign cannot touch it', async () => {
  const inv = await c.action('member.invite', { email: `signs.vol+${tag}@example.org`, role: 'volunteer' });
  assert.equal(inv.status, 200);
  const vol = new Client();
  const joined = await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Sign Vol', password: 'put-it-up-2026' });
  assert.ok(joined.status < 300, JSON.stringify(joined.json));
  assert.ok((await vol.get('/api/actions')).json.actions.includes('sign.cancel'));

  const mine = await vol.action('sign.place', { address: '16013 84 Ave', kind: 'lawn' });
  assert.equal(mine.status, 200);
  const other = new Client();
  await other.signup({ workspaceName: 'Other Signs', email: `signs.other+${tag}@example.org` });
  assert.equal((await other.action('sign.cancel', { id: mine.json.sign.id })).status, 404, 'not theirs to cancel');

  const r = await vol.action('sign.cancel', { id: mine.json.sign.id });
  assert.equal(r.status, 200);
  assert.ok(!(await signsList(vol)).some((s) => s.id === mine.json.sign.id));
  assert.equal((await c.action('sign.cancel', { id: 'not-a-uuid' })).status, 400);
  assert.equal((await c.get('/api/audit/verify')).json.ok, true);
});

test('a sign needs somewhere to go: no address and no pin is refused', async () => {
  const nowhere = await c.createPerson('No Address Yet');
  const r = await c.action('sign.place', { person_id: nowhere.id, kind: 'lawn' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /address/);
  const typed = await c.action('sign.place', { person_id: nowhere.id, kind: 'lawn', address: '13450 104 Ave' });
  assert.equal(typed.status, 200, 'typing the address on the form is enough');
  const pinned = await c.action('sign.place', { kind: 'large', lat: 49.19, lng: -122.84 });
  assert.equal(pinned.status, 400, 'zod still needs a person or an address');
});
