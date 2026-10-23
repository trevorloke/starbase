// The Shifts week board: one read (GET /api/shifts/board) for a week's
// shifts, who's on them and the volunteers to drag in; the writes are the
// usual shift.create / shift.assign / shift.unassign. Plus the shared parts
// of the day (shared/dayparts.js) the board sorts shifts by.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import {
  DAY_PARTS, partOf, dayOf, partRange, weekStart, weekBounds, zonedISO,
} from '@starbase/shared/dayparts';

let c;
const uniq = () => Math.random().toString(36).slice(2, 8);

before(async () => {
  await freshDb();
  c = new Client();
  await c.signup({ workspaceName: 'Board WS' });
});

test('parts of the day: morning, afternoon, evening in Vancouver time, DST-safe', () => {
  assert.deepEqual(DAY_PARTS.map((p) => p.code), ['morning', 'afternoon', 'evening']);
  // 6:30pm Pacific on Oct 27 is already Oct 28 in UTC.
  assert.equal(partOf('2026-10-28T01:30:00Z'), 'evening');
  assert.equal(dayOf('2026-10-28T01:30:00Z'), '2026-10-27');
  assert.equal(partOf('2026-10-27T10:00:00-07:00'), 'morning');
  assert.equal(partOf('2026-10-27T12:00:00-07:00'), 'afternoon');
  assert.equal(partOf('2026-10-27T07:00:00-07:00'), 'morning', 'early starts count as morning');
  assert.equal(partOf('2026-10-27T22:00:00-07:00'), 'evening');
  assert.deepEqual(partRange('2026-10-27', 'evening'), {
    starts_at: '2026-10-27T17:00:00-07:00', ends_at: '2026-10-27T21:00:00-07:00',
  });
  // Clocks fall back on Nov 1, 2026: the Monday after is -08:00.
  assert.equal(zonedISO('2026-11-02', 9), '2026-11-02T09:00:00-08:00');
  assert.equal(weekStart('2026-10-23'), '2026-10-19', 'weeks start on Monday');
  assert.equal(weekStart('2026-10-19'), '2026-10-19');
  assert.deepEqual(weekBounds('2026-10-26'), { from: '2026-10-26T00:00:00-07:00', to: '2026-11-02T00:00:00-08:00' });
  assert.equal(partOf('2026-10-27T10:00:00Z', 'Not/AZone'), 'morning', 'unknown zone → Vancouver (3am → morning)');
});

test('board: the week\'s shifts, who is on them, and the volunteers to drag in', async () => {
  const { from, to } = weekBounds('2026-10-26');
  const tue = await c.action('shift.create', { title: 'Canvass — Evening', ...partRange('2026-10-27', 'evening'), capacity: 2 });
  const wed = await c.action('shift.create', { title: 'Phone bank', ...partRange('2026-10-28', 'morning') });
  const next = await c.action('shift.create', { title: 'Next week', ...partRange('2026-11-03', 'morning') });
  assert.equal(tue.status, 200);
  const sam = await c.createPerson('Sam Volunteer', { email: 'sam@example.org', phone: '604-555-0101' });
  const kim = await c.createPerson('Kim Driver');
  await c.createPerson('Not A Volunteer');
  await c.action('volunteer.assign', { person_id: sam.id, role: 'doorknocking' });
  await c.action('volunteer.assign', { person_id: sam.id, role: 'phoning' });
  await c.action('volunteer.assign', { person_id: kim.id, role: 'driver' });

  // Drop Sam on Tuesday evening, move him to Wednesday morning (assign, then
  // unassign the old spot), then take him off.
  const a1 = await c.action('shift.assign', { shift_id: tue.json.shift.id, person_id: sam.id });
  assert.equal(a1.status, 200);
  let board = await c.get(`/api/shifts/board?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  assert.equal(board.status, 200, JSON.stringify(board.json));
  assert.deepEqual(board.json.shifts.map((s) => s.title), ['Canvass — Evening', 'Phone bank'], 'only this week');
  const tueRow = board.json.shifts.find((s) => s.id === tue.json.shift.id);
  assert.equal(tueRow.filled, 1);
  assert.equal(tueRow.capacity, 2);
  assert.equal(partOf(tueRow.starts_at), 'evening');
  assert.deepEqual(board.json.assignments.map((a) => [a.name, a.shift_id, a.id]), [['Sam Volunteer', tue.json.shift.id, a1.json.assignment.id]]);
  assert.equal(board.json.assignments[0].phone, undefined, 'names only on the board');
  const names = board.json.people.map((p) => p.name);
  assert.deepEqual(names, ['Kim Driver', 'Sam Volunteer'], 'people with a volunteer role');
  assert.deepEqual(board.json.people.find((p) => p.name === 'Sam Volunteer').roles.sort(), ['doorknocking', 'phoning']);

  const a2 = await c.action('shift.assign', { shift_id: wed.json.shift.id, person_id: sam.id });
  assert.equal(a2.status, 200);
  assert.equal((await c.action('shift.unassign', { id: a1.json.assignment.id })).status, 200);
  board = await c.get(`/api/shifts/board?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  assert.deepEqual(board.json.assignments.map((a) => a.shift_id), [wed.json.shift.id]);
  assert.equal(board.json.shifts.find((s) => s.id === tue.json.shift.id).filled, 0);

  // A declined spot is not on the board.
  await c.action('shift.setStatus', { id: a2.json.assignment.id, status: 'declined' });
  board = await c.get(`/api/shifts/board?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  assert.equal(board.json.assignments.length, 0);
  assert.ok(next.json.shift.id);
});

test('board: a signed-in volunteer shows in the tray; volunteers cannot read the board', async () => {
  const email = `vol-${uniq()}@example.org`;
  const inv = await c.action('member.invite', { email, role: 'volunteer' });
  const vol = new Client();
  const j = await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Jo Newcomer', password: 'board-pass-2026' });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  await c.createPerson('Jo Newcomer', { email: email.toUpperCase() });
  const { from, to } = weekBounds('2026-10-26');
  const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const board = await c.get(`/api/shifts/board?${q}`);
  assert.ok(board.json.people.some((p) => p.name === 'Jo Newcomer'), 'a volunteer sign-in, matched by email');
  assert.equal((await vol.get(`/api/shifts/board?${q}`)).status, 403);
});

test('board: a bad or too-long range is refused', async () => {
  assert.equal((await c.get('/api/shifts/board')).status, 400);
  assert.equal((await c.get('/api/shifts/board?from=soon&to=later')).status, 400);
  const { from } = weekBounds('2026-10-26');
  const far = weekBounds('2026-12-07').to;
  assert.equal((await c.get(`/api/shifts/board?from=${encodeURIComponent(from)}&to=${encodeURIComponent(far)}`)).status, 400);
});
