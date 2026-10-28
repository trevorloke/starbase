// The promise tracker: seeded once as first published, scored by dated
// updates with the record behind each score, read by the public site as
// JSON without row ids. Managers and staff edit; treasurers and volunteers
// are refused.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';

const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.tracker.${tag}@example.org`;
let mgr;
let treas;
let slug;

const joinAs = async (role, name) => {
  const inv = await mgr.action('member.invite', { email: mail(name), role });
  const cl = new Client();
  await cl.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'tracker-pass-2026' });
  return cl;
};
const pubGet = async (path) => {
  const res = await app.request(path, { headers: { origin: 'https://imaginesurrey.test' } });
  return { status: res.status, json: await res.json(), headers: res.headers };
};

before(async () => {
  await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Imagine Surrey', email: mail('manager'), jurisdiction: 'bc-municipal' });
  slug = r.json.workspace.slug;
  treas = await joinAs('treasurer', 'Tess');
});

test('seed once: the 26 promises with their delivery tests and the announcements; a second seed is refused', async () => {
  const empty = (await mgr.get('/api/tracker')).json;
  assert.equal(empty.total, 0);
  const s = await mgr.action('tracker.seed', {});
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal(s.json.promises, 26);
  assert.equal(s.json.announcements, 8);
  const t = (await mgr.get('/api/tracker')).json;
  assert.equal(t.total, 26);
  assert.equal(t.promises[0].number, 1);
  assert.match(t.promises[0].title, /0% property tax/);
  assert.ok(t.promises[0].test.kept, 'the delivery test came with it');
  assert.ok(t.promises[0].sources.length >= 1);
  assert.equal(t.counts.not_started, 26);
  assert.equal(t.announcements[0].date, '2026-10-17');
  assert.equal((await mgr.action('tracker.seed', {})).status, 409);
});

test('scoring: a dated update with a status changes the promise; one without keeps it; deleting an update leaves the score', async () => {
  const t = (await mgr.get('/api/tracker')).json;
  const p1 = t.promises.find((p) => p.number === 1);
  const u = await mgr.action('tracker.update.add', { promise_id: p1.id, date: '2027-05-15', status: 'partly_kept', note: 'Property tax 0%, parcel tax up', url: 'https://surrey.ca/budget' });
  assert.equal(u.status, 200, JSON.stringify(u.json));
  assert.equal(u.json.promise_status, 'partly_kept');
  const note = await mgr.action('tracker.update.add', { promise_id: p1.id, date: '2027-06-01', note: 'Council debate continues' });
  assert.equal(note.status, 200);
  const after = (await mgr.get('/api/tracker')).json;
  const p = after.promises.find((x) => x.number === 1);
  assert.equal(p.status, 'partly_kept');
  assert.equal(String(p.status_changed_at).slice(0, 10), '2027-05-15');
  assert.deepEqual(p.updates.map((x) => x.date), ['2027-06-01', '2027-05-15'], 'newest first');
  assert.equal(after.counts.partly_kept, 1);
  assert.equal((await mgr.action('tracker.update.delete', { id: note.json.update.id })).status, 200);
  assert.equal((await mgr.get('/api/tracker')).json.promises.find((x) => x.number === 1).updates.length, 1);
  assert.equal((await mgr.action('tracker.update.add', { promise_id: p1.id, date: 'soon', note: 'x' })).status, 400);
  assert.equal((await mgr.action('tracker.update.add', { promise_id: p1.id, date: '2027-01-01', note: 'x', url: 'javascript:alert(1)' })).status, 400);
});

test('promises and announcements: added, edited, numbered once; roles hold', async () => {
  const dup = await mgr.action('tracker.promise.save', { number: 1, title: 'Another number one' });
  assert.equal(dup.status, 400);
  const add = await mgr.action('tracker.promise.save', { number: 27, title: 'A new promise', area: 'Transit', sources: [{ label: 'Release', url: 'https://example.org/r' }] });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const edit = await mgr.action('tracker.promise.save', { id: add.json.promise.id, number: 27, title: 'A new promise, reworded', area: 'Transit', status: 'in_progress' });
  assert.equal(edit.status, 200);
  const t = (await mgr.get('/api/tracker')).json;
  const p27 = t.promises.find((p) => p.number === 27);
  assert.equal(p27.title, 'A new promise, reworded');
  assert.equal(p27.status, 'in_progress');
  assert.ok(p27.status_changed_at);
  const a = await mgr.action('tracker.announcement.save', { date: '2026-11-02', date_label: 'Nov 2, 2026', title: 'Inaugural meeting', commitments: 'Auditor engaged', sources: [] });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal((await mgr.get('/api/tracker')).json.announcements[0].title, 'Inaugural meeting', 'newest first');
  assert.equal((await mgr.action('tracker.announcement.delete', { id: a.json.announcement.id })).status, 200);
  assert.equal((await mgr.action('tracker.promise.delete', { id: add.json.promise.id })).status, 200);
  assert.equal((await mgr.get('/api/tracker')).json.total, 26);
  assert.equal((await treas.get('/api/tracker')).status, 403);
  assert.equal((await treas.action('tracker.update.add', { promise_id: t.promises[0].id, date: '2027-01-01', note: 'x' })).status, 403);
});

test('the public site reads the tracker as JSON, CORS-open, without row ids', async () => {
  const r = await pubGet(`/api/public/${slug}/site/tracker`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.ok(r.headers.get('etag'));
  assert.equal(r.json.total, 26);
  assert.equal(r.json.counts.partly_kept, 1);
  const p1 = r.json.promises.find((p) => p.number === 1);
  assert.equal(p1.id, undefined);
  assert.equal(p1.updates[0].id, undefined);
  assert.equal(p1.updates[0].note, 'Property tax 0%, parcel tax up');
  assert.equal(r.json.announcements.length, 8);
  assert.equal(r.json.announcements[0].id, undefined);
  assert.equal((await pubGet('/api/public/nobody/site/tracker')).status, 404);
});
