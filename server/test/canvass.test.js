// Canvassing: the rating scale, contact logging by volunteers, signs,
// volunteer roles, tags/socials, map doors, person filters, donor tiers.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { RATING_CODES } from '@starbase/shared/canvass';

let c;

before(async () => {
  await freshDb();
  c = new Client();
  const r = await c.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' });
  assert.equal(r.status, 201);
  assert.equal(r.json.workspace.slug, 'imagine-surrey');
  assert.equal(r.json.workspace.jurisdiction, 'bc-municipal');
});

test('every rating code on the scale is accepted; off-scale codes are rejected', async () => {
  const p = await c.createPerson('Rating Tester');
  for (const code of RATING_CODES) {
    const r = await c.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating: code });
    assert.equal(r.status, 200, `rating ${code}`);
  }
  const bad = await c.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating: '5' });
  assert.equal(bad.status, 400);
  const prof = await c.get(`/api/persons/${p.id}`);
  assert.equal(prof.json.person.rating, '4C', 'latest rating sticks on the person');
  assert.equal(prof.json.contacts.length, RATING_CODES.length);
});

test('a no-answer knock logs without touching the rating', async () => {
  const p = await c.createPerson('Not Home');
  await c.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating: '2' });
  const r = await c.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'no_answer' });
  assert.equal(r.status, 200);
  const prof = await c.get(`/api/persons/${p.id}`);
  assert.equal(prof.json.person.rating, '2');
});

test('phone and text contacts carry the same scale', async () => {
  const p = await c.createPerson('Phone Voter', { phone: '604-555-0100' });
  const call = await c.action('contact.log', { person_id: p.id, channel: 'phone', outcome: 'contacted', rating: '4D' });
  const txt = await c.action('contact.log', { person_id: p.id, channel: 'text', outcome: 'contacted', rating: '3' });
  assert.equal(call.status, 200);
  assert.equal(txt.status, 200);
  const feed = await c.get('/api/contacts?limit=5');
  assert.equal(feed.json.contacts[0].channel, 'text');
});

test('tags, socials, and address fields round-trip; tag filter works', async () => {
  const p = await c.createPerson('Media Person', {
    email: 'reporter@example.org', tags: ['media', 'VIP'],
    socials: { x: '@reporter', instagram: 'reporter.ig' },
    address: '10234 King George Blvd', city: 'Surrey', postal: 'V3T 2W6',
  });
  const prof = await c.get(`/api/persons/${p.id}`);
  assert.deepEqual(prof.json.person.tags, ['media', 'VIP']);
  assert.equal(prof.json.person.socials.x, '@reporter');
  assert.equal(prof.json.person.city, 'Surrey');
  const media = await c.get('/api/persons?tag=media');
  assert.ok(media.json.persons.some((x) => x.id === p.id));
  const vip = await c.get('/api/persons?tag=VIP');
  assert.ok(vip.json.persons.some((x) => x.id === p.id));
  const none = await c.get('/api/persons?tag=nope');
  assert.equal(none.json.persons.length, 0);
  const upd = await c.action('person.update', { id: p.id, tags: ['media'] });
  assert.deepEqual(upd.json.person.tags, ['media']);
  const bogus = await c.action('person.update', { id: p.id, socials: { myspace: 'x' } });
  assert.equal(bogus.status, 400, 'unknown platform rejected');
});

test('rating filter: one code, a band (comma list), and unrated', async () => {
  const rate = async (name, code) => {
    const p = await c.createPerson(name);
    if (code) await c.action('contact.log', { person_id: p.id, channel: 'door', outcome: 'contacted', rating: code });
    return p;
  };
  const strong = await rate('Bandfilter Strong', '1');
  const lean = await rate('Bandfilter Lean', '2');
  const undecided = await rate('Bandfilter Undecided', '3');
  const locke = await rate('Bandfilter Locke', '4B');
  const plain4 = await rate('Bandfilter Opposed', '4');
  const none = await rate('Bandfilter Unrated', null);
  const ids = async (rating) => {
    const r = await c.get(`/api/persons?q=Bandfilter&rating=${encodeURIComponent(rating)}`);
    assert.equal(r.status, 200, rating);
    return r.json.persons.map((x) => x.id).sort();
  };
  const sorted = (...ps) => ps.map((p) => p.id).sort();
  assert.deepEqual(await ids('2'), sorted(lean), 'single code still works');
  assert.deepEqual(await ids('4B'), sorted(locke), 'who they vote for');
  assert.deepEqual(await ids('1,2'), sorted(strong, lean), 'support band');
  assert.deepEqual(await ids('4,4D,4B,4F,4N,4C'), sorted(locke, plain4), 'opposed band');
  assert.deepEqual(await ids('unrated'), sorted(none), 'no rating yet');
  assert.deepEqual(await ids('3,unrated'), sorted(undecided, none), 'a band and unrated together');
  assert.deepEqual(await ids(' 1 , ,2 '), sorted(strong, lean), 'spaces and empty pieces are ignored');
  assert.deepEqual(await ids('5'), [], 'off-scale code matches no one');
  assert.deepEqual(await ids(','), [], 'nothing but commas matches no one');
});

test('locating a person puts them on the map; map doors groups household + signs', async () => {
  const a = await c.createPerson('Door A', { address: '12345 72 Ave', unit: null });
  const b = await c.createPerson('Door A Partner', { address: '12345 72 Ave' });
  const before = await c.get('/api/map/doors');
  assert.ok(before.json.unlocated >= 2);
  await c.action('person.locate', { id: a.id, lat: 49.1333, lng: -122.8500 });
  await c.action('person.locate', { id: b.id, lat: 49.1333, lng: -122.8500 });
  await c.action('sign.place', { person_id: a.id, kind: 'lawn' });
  const doors = await c.get('/api/map/doors');
  const located = doors.json.persons.filter((p) => p.address === '12345 72 Ave');
  assert.equal(located.length, 2);
  assert.ok(doors.json.signs.some((s) => s.person_id === a.id && s.kind === 'lawn'));
  const prof = await c.get(`/api/persons/${a.id}`);
  assert.equal(prof.json.household.length, 1, 'household = others at same address');
  assert.equal(prof.json.household[0].name, 'Door A Partner');
  const bad = await c.action('person.locate', { id: a.id, lat: 123, lng: 0 });
  assert.equal(bad.status, 400);
});

test('signs: kinds, status lifecycle, bare-address placement', async () => {
  const p = await c.createPerson('Sign Host', { address: '8000 120 St' });
  const req = await c.action('sign.place', { person_id: p.id, kind: 'billboard' });
  assert.equal(req.json.sign.status, 'requested');
  assert.equal(req.json.sign.address, '8000 120 St', 'address inherited from the person');
  const inst = await c.action('sign.update', { id: req.json.sign.id, status: 'installed' });
  assert.equal(inst.status, 200);
  const bare = await c.action('sign.place', { address: 'Hwy 10 & 152 St (corner)', kind: 'large', status: 'installed' });
  assert.equal(bare.status, 200);
  const neither = await c.action('sign.place', { kind: 'lawn' });
  assert.equal(neither.status, 400);
  const badKind = await c.action('sign.place', { person_id: p.id, kind: 'blimp' });
  assert.equal(badKind.status, 400);
  const list = await c.get('/api/signs');
  assert.ok(list.json.signs.length >= 2);
  assert.ok(list.json.signs.some((s) => s.person_name === 'Sign Host'));
});

test('volunteer roles with detail; role filter; unassign', async () => {
  const p = await c.createPerson('Multi Role');
  const t = await c.action('volunteer.assign', { person_id: p.id, role: 'translation', detail: 'Punjabi' });
  assert.equal(t.status, 200);
  const cc = await c.action('volunteer.assign', { person_id: p.id, role: 'community_committee', detail: 'Newton' });
  assert.equal(cc.status, 200);
  const hr = await c.action('volunteer.assign', { person_id: p.id, role: 'highrise_captain', detail: 'The Hub, 13438 Central Ave' });
  assert.equal(hr.status, 200, 'hi-rise building captain with its building');
  const byRole = await c.get('/api/persons?role=highrise_captain');
  assert.ok(byRole.json.persons.some((x) => x.id === p.id));
  const bad = await c.action('volunteer.assign', { person_id: p.id, role: 'astronaut' });
  assert.equal(bad.status, 400);
  const filt = await c.get('/api/persons?role=translation');
  assert.ok(filt.json.persons.some((x) => x.id === p.id));
  const prof = await c.get(`/api/persons/${p.id}`);
  assert.equal(prof.json.roles.length, 3);
  assert.equal(prof.json.roles.find((r) => r.role === 'translation').detail, 'Punjabi');
  assert.equal(prof.json.roles.find((r) => r.role === 'highrise_captain').detail, 'The Hub, 13438 Central Ave');
  const un = await c.action('volunteer.unassign', { id: t.json.volunteerRole.id });
  assert.equal(un.status, 200);
  const after = await c.get(`/api/persons/${p.id}`);
  assert.equal(after.json.roles.length, 2);
});

test('volunteers can log contacts, place signs, and locate pins — not log gifts', async () => {
  const db = await (await import('../db/client.js')).getDb();
  const me = await c.get('/api/auth/me');
  const vol = new Client();
  await vol.signup({ workspaceName: 'Vol Home' });
  const volMe = await vol.get('/api/auth/me');
  await db.query('update memberships set role = $3 where user_id = $1 and workspace_id = $2',
    [volMe.json.user.id, volMe.json.workspace.id, 'volunteer']);
  await db.query('update memberships set workspace_id = $3 where user_id = $1 and workspace_id = $2',
    [volMe.json.user.id, volMe.json.workspace.id, me.json.workspace.id]);
  await db.query('update sessions set workspace_id = $2 where user_id = $1', [volMe.json.user.id, me.json.workspace.id]);
  const target = await c.createPerson('Knocked By Volunteer');
  const knock = await vol.action('contact.log', { person_id: target.id, channel: 'door', outcome: 'contacted', rating: '1' });
  assert.equal(knock.status, 200);
  const pin = await vol.action('person.locate', { id: target.id, lat: 49.1, lng: -122.8 });
  assert.equal(pin.status, 200);
  const sign = await vol.action('sign.place', { person_id: target.id, kind: 'lawn' });
  assert.equal(sign.status, 200);
  const gift = await vol.action('gift.log', { person_id: target.id, amount_cents: 100, date: '2026-10-01' });
  assert.equal(gift.status, 403);
  const create = await vol.action('person.create', { name: 'Nope' });
  assert.equal(create.status, 403);
});

test('donor tiers derive from gifts: one-time, monthly, star, superstar', async () => {
  const year = new Date().getFullYear();
  const d = (m) => `${year}-${String(m).padStart(2, '0')}-01`;
  const one = await c.createPerson('One Time');
  await c.action('gift.log', { person_id: one.id, amount_cents: 5000, date: d(1) });
  assert.equal((await c.get(`/api/persons/${one.id}`)).json.donor.tier, 'one-time');

  const monthly = await c.createPerson('Monthly Donor');
  const today = new Date().toISOString().slice(0, 10);
  await c.action('gift.log', { person_id: monthly.id, amount_cents: 2500, date: today, cadence: 'monthly' });
  assert.equal((await c.get(`/api/persons/${monthly.id}`)).json.donor.tier, 'monthly');

  const star = await c.createPerson('Star Monthly');
  await c.action('gift.log', { person_id: star.id, amount_cents: 10000, date: today, cadence: 'monthly' });
  assert.equal((await c.get(`/api/persons/${star.id}`)).json.donor.tier, 'star');

  const bigOne = await c.createPerson('Star One Time');
  await c.action('gift.log', { person_id: bigOne.id, amount_cents: 100000, date: d(2) });
  assert.equal((await c.get(`/api/persons/${bigOne.id}`)).json.donor.tier, 'star');

  const superstar = await c.createPerson('Superstar');
  await c.action('gift.log', { person_id: superstar.id, amount_cents: 25000, date: today, cadence: 'monthly' });
  assert.equal((await c.get(`/api/persons/${superstar.id}`)).json.donor.tier, 'superstar');
});

test('brief carries field stats, rating breakdown, signs, provider flags', async () => {
  const b = await c.get('/api/brief');
  assert.ok(b.json.field.week >= 10);
  assert.ok(b.json.field.doors >= 8, 'distinct doors: 13 knocks on Rating Tester are one door');
  assert.ok(b.json.ratings['4C'] >= 1);
  assert.ok(b.json.signs.requested >= 1 || b.json.signs.installed >= 1);
  assert.equal(typeof b.json.providers.email, 'boolean');
  assert.equal(typeof b.json.providers.text, 'boolean');
});

test('changing an address drops the stale pin; supplying new coordinates keeps them', async () => {
  const p = await c.createPerson('Mover', { address: '100 Old St', lat: 49.1, lng: -122.8 });
  const moved = await c.action('person.update', { id: p.id, address: '200 New Ave' });
  assert.equal(moved.status, 200);
  let prof = (await c.get(`/api/persons/${p.id}`)).json.person;
  assert.equal(prof.lat, null, 'old pin cleared');
  assert.equal(prof.address, '200 New Ave');
  await c.action('person.update', { id: p.id, address: '300 Third Rd', lat: 49.2, lng: -122.7 });
  prof = (await c.get(`/api/persons/${p.id}`)).json.person;
  assert.equal(prof.lat, 49.2, 'new coordinates in the same patch are kept');
  await c.action('person.update', { id: p.id, phone: '604-555-0333' });
  prof = (await c.get(`/api/persons/${p.id}`)).json.person;
  assert.equal(prof.lat, 49.2, 'non-address edits leave the pin alone');
});

test('a sign requested at a pinned person inherits the pin, so it shows on the map', async () => {
  const p = await c.createPerson('Pinned Host', { address: '9000 Pin St', lat: 49.15, lng: -122.81 });
  const s = await c.action('sign.place', { person_id: p.id, kind: 'large' });
  assert.equal(s.status, 200);
  const doors = (await c.get('/api/map/doors')).json;
  const sign = doors.signs.find((x) => x.id === s.json.sign.id);
  assert.equal(sign.lat, 49.15);
  assert.equal(sign.lng, -122.81);
});

test('the gift ledger carries donor names (no per-row lookups)', async () => {
  const p = await c.createPerson('Named Donor');
  await c.action('gift.log', { person_id: p.id, amount_cents: 1000, date: '2026-05-01' });
  const page1 = await c.get('/api/records/gift?limit=2');
  assert.equal(page1.status, 200);
  assert.ok(page1.json.records.every((r) => typeof r.person_name === 'string'));
  assert.equal(page1.json.records[0].person_name, 'Named Donor');
  if (page1.json.next) {
    const page2 = await c.get(`/api/records/gift?limit=2&cursor=${encodeURIComponent(page1.json.next)}`);
    assert.equal(page2.status, 200, 'cursor still works with the join');
    const ids = new Set(page1.json.records.map((r) => r.id));
    assert.ok(page2.json.records.every((r) => !ids.has(r.id)), 'no overlap across pages');
  }
});

// A second member by the real path (invite → join). Emails are unique per
// call: under test:pg every file shares one database and users are global.
const joinAs = async (mgr, role, name) => {
  const email = `${name.toLowerCase().replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2, 8)}@example.org`;
  const inv = await mgr.action('member.invite', { email, role });
  assert.equal(inv.status, 200);
  const cl = new Client();
  const j = await cl.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name, password: 'join-pass-2026' });
  assert.equal(j.status, 200);
  return { client: cl, userId: j.json.user.id };
};

test('brief: field.mine is this week’s contacts the caller logged; the team numbers are everyone’s', async () => {
  const mgr = new Client();
  await mgr.signup({ workspaceName: 'Mine WS', jurisdiction: 'bc-municipal' });
  const { client: vol } = await joinAs(mgr, 'volunteer', 'Mine Volunteer');
  const people = [];
  for (let i = 0; i < 4; i++) people.push(await mgr.createPerson(`Mine Door ${i}`, { phone: `604-555-01${60 + i}` }));
  const log = (who, p, channel, rating) => who.action('contact.log', { person_id: p.id, channel, outcome: 'contacted', rating });
  // The volunteer: 3 knocks + 1 call. The manager: 2 knocks + 1 text.
  const volKnocks = [];
  for (const p of people.slice(0, 3)) volKnocks.push((await log(vol, p, 'door', '1')).json.contact.id);
  assert.equal((await log(vol, people[3], 'phone', '2')).status, 200);
  await log(mgr, people[0], 'door', '3');
  await log(mgr, people[3], 'door');
  await log(mgr, people[3], 'text', '2');

  const vf = (await vol.get('/api/brief')).json.field;
  assert.deepEqual(vf.mine, { doors: 3, calls: 1, texts: 0 }, 'the volunteer sees their own');
  // Doors are distinct doors: the volunteer and the manager both knocked
  // Mine Door 0, which is one door for the team.
  assert.deepEqual([vf.doors, vf.calls, vf.texts, vf.week], [4, 1, 1, 7], 'team numbers count everyone');
  const mf = (await mgr.get('/api/brief')).json.field;
  assert.deepEqual(mf.mine, { doors: 2, calls: 0, texts: 1 }, 'the manager sees theirs');
  assert.deepEqual([mf.doors, mf.calls, mf.texts], [4, 1, 1]);

  // Same week boundary as the team count: a knock from last week drops out of both.
  const db = await (await import('../db/client.js')).getDb();
  await db.query(`update contacts set created_at = now() - interval '8 days' where id = $1`, [volKnocks[0]]);
  const vf2 = (await vol.get('/api/brief')).json.field;
  assert.equal(vf2.mine.doors, 2);
  assert.equal(vf2.doors, 4);

  // Another campaign's knocks never count.
  const other = new Client();
  await other.signup({ workspaceName: 'Mine Other WS' });
  const op = await other.createPerson('Elsewhere');
  await other.action('contact.log', { person_id: op.id, channel: 'door', outcome: 'contacted' });
  assert.equal((await vol.get('/api/brief')).json.field.doors, 4);
  assert.deepEqual((await other.get('/api/brief')).json.field.mine, { doors: 1, calls: 0, texts: 0 });
});

test('walk list: door_knocked tells a knocked door from one reached only by phone or text', async () => {
  const mgr = new Client();
  await mgr.signup({ workspaceName: 'Knock WS', jurisdiction: 'bc-municipal' });
  const lat = 49.1102; const lng = -122.8301;
  const mk = (name, address, dLng) => mgr.createPerson(name, { address, lat, lng: lng + dLng, phone: '604-555-0170' });
  const knocked = await mk('Knocked Door', '6001 140 St', 0);
  const called = await mk('Called Only', '6003 140 St', 0.0002);
  const texted = await mk('Texted Only', '6005 140 St', 0.0004);
  const both = await mk('Called Then Knocked', '6007 140 St', 0.0006);
  await mk('Not Yet', '6009 140 St', 0.0008);
  const t = await mgr.action('turf.create', {
    name: 'Knock block', polygon: [[lat + 0.001, lng - 0.001], [lat + 0.001, lng + 0.002], [lat - 0.001, lng + 0.002], [lat - 0.001, lng - 0.001]],
  });
  const log = (p, channel, outcome = 'contacted') => mgr.action('contact.log', { person_id: p.id, channel, outcome });
  await log(knocked, 'door', 'no_answer');
  await log(called, 'phone');
  await log(texted, 'text');
  await log(both, 'phone');
  await log(both, 'door');

  const walk = (await mgr.get(`/api/turfs/${t.json.turf.id}/walk`)).json;
  const byName = Object.fromEntries(walk.doors.flatMap((d) => d.persons).map((p) => [p.name, p]));
  assert.equal(Object.keys(byName).length, 5);
  assert.equal(byName['Knocked Door'].door_knocked, true, 'a no-answer knock is still a knock');
  assert.equal(byName['Called Only'].door_knocked, false);
  assert.equal(byName['Texted Only'].door_knocked, false);
  assert.equal(byName['Called Then Knocked'].door_knocked, true);
  assert.equal(byName['Not Yet'].door_knocked, false);
  assert.equal(byName['Not Yet'].last_contact_at, null, 'never reached: not done either');
  assert.ok(byName['Called Only'].last_contact_at, 'reached by phone still counts as done');
});

test('person list carries their own note (no per-card fetch); nothing else from attrs', async () => {
  const p = await c.createPerson('Noted Person', { phone: '604-555-0180' });
  const db = await (await import('../db/client.js')).getDb();
  await db.query(
    `update persons set attrs = jsonb_set(jsonb_set(coalesce(attrs, '{}'::jsonb), '{note}', to_jsonb($2::text)), '{geocode}', '{"status":"ok"}'::jsonb)
     where id = $1`,
    [p.id, 'Free after 6pm\nAsk about transit'],
  );
  const plain = await c.createPerson('No Note Person', { phone: '604-555-0181' });
  const list = (await c.get('/api/persons?q=Note&has=phone')).json.persons;
  const row = list.find((x) => x.id === p.id);
  assert.equal(row.note, 'Free after 6pm\nAsk about transit');
  assert.equal(list.find((x) => x.id === plain.id).note, null);
  assert.equal(row.attrs, undefined, 'attrs itself is not sent');
  assert.equal(row.geocode, undefined);
  assert.equal((await c.get(`/api/persons/${p.id}`)).json.person.note, row.note, 'same note as the profile');
});
