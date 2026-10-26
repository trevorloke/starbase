// Data: CSV import (dedupe, merge, dry run), batch geocoding against the BC
// Address Geocoder (mocked), and the Imagine Surrey sample dataset.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { app } from '../index.js';

let mgr, ws;

before(async () => {
  await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
});

const imp = (rows, extra = {}) => mgr.post('/api/data/import', { rows, ...extra });

test('import: dry run previews without writing; real run creates, merges, and reports bad rows', async () => {
  await mgr.createPerson('Existing Email', { email: 'known@example.org' });
  const rows = [
    { first: 'Jas', last: 'Gill', phone: '604-555-0101', address: '13245 72 Ave', tags: 'newton; voter' },
    { name: 'Existing Email', email: 'KNOWN@example.org', phone: '604-555-0102' }, // merge: adds phone
    { name: 'Jas Gill', phone: '(604) 555-0101', email: 'jas@example.org' },      // same file: dedupe by name+phone
    { name: '', email: 'nobody@example.org' },                                    // invalid: no name
    { name: 'Bad Rating', rating: '7' },                                           // invalid: off-scale
    { name: 'Rated Voter', rating: '4d', address: '13300 72 Ave' },               // rating normalized to 4D
  ];
  const dry = await imp(rows, { dryRun: true, tag: 'list-2026' });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.dryRun, true);
  assert.equal(dry.json.created, 2);
  assert.equal(dry.json.merged, 2);
  assert.equal(dry.json.invalid.length, 2);
  assert.equal((await mgr.get('/api/persons?q=Jas')).json.persons.length, 0, 'dry run wrote nothing');

  const real = await imp(rows, { tag: 'list-2026' });
  assert.equal(real.status, 200);
  assert.deepEqual([real.json.created, real.json.merged], [2, 2]);
  assert.match(real.json.invalid[0], /row 4: no name/);
  assert.match(real.json.invalid[1], /row 5: rating “7”/);
  const jas = (await mgr.get('/api/persons?q=Jas Gill')).json.persons;
  assert.equal(jas.length, 1, 'one Jas Gill');
  assert.equal(jas[0].email, 'jas@example.org', 'second row filled the blank email');
  assert.deepEqual(jas[0].tags.sort(), ['list-2026', 'newton', 'voter']);
  const known = (await mgr.get('/api/persons?q=Existing')).json.persons[0];
  assert.equal(known.phone, '604-555-0102', 'merge filled the missing phone');
  const rated = (await mgr.get('/api/persons?q=Rated')).json.persons[0];
  assert.equal(rated.rating, '4D');

  const again = await imp(rows);
  assert.equal(again.json.created, 0, 're-importing the same file creates no duplicates');
  const v = (await mgr.get('/api/audit/verify')).json;
  assert.equal(v.ok, true);
});

test('import refuses oversized batches and volunteers', async () => {
  const big = Array.from({ length: 2001 }, (_, i) => ({ name: `P ${i}` }));
  assert.equal((await imp(big)).status, 400);
  const inv = await mgr.action('member.invite', { email: 'v-import@example.org', role: 'volunteer' });
  const vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'V', password: 'v-import-pass' });
  assert.equal((await vol.post('/api/data/import', { rows: [{ name: 'x' }] })).status, 403);
  assert.equal((await vol.post('/api/data/geocode', {})).status, 403);
  assert.equal((await vol.post('/api/data/sample', {})).status, 403);
});

test('geocode: precise BC matches are placed; vague and unknown are parked; outages retry', async () => {
  const p1 = await mgr.createPerson('Geo Precise', { address: '13450 104 Ave' });
  const p2 = await mgr.createPerson('Geo Vague', { address: 'Somewhere Rd' });
  const p3 = await mgr.createPerson('Geo Outage', { address: '9999 King George Blvd' });
  const realFetch = globalThis.fetch;
  const asked = [];
  let outage = true;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname !== 'geocoder.api.gov.bc.ca') return realFetch(url);
    const q = u.searchParams.get('addressString');
    asked.push(q);
    if (q.startsWith('13450 104 Ave')) {
      return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [-122.8466, 49.1906] },
        properties: { score: 98, matchPrecision: 'CIVIC_NUMBER', fullAddress: '13450 104 Ave, Surrey, BC' } }] }));
    }
    if (q.startsWith('Somewhere Rd')) {
      return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [-122.8, 49.1] },
        properties: { score: 40, matchPrecision: 'LOCALITY', fullAddress: 'Surrey, BC' } }] }));
    }
    if (outage) return new Response('busy', { status: 503 });
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [-122.84, 49.17] },
      properties: { score: 90, matchPrecision: 'CIVIC_NUMBER', fullAddress: '9999 King George Blvd, Surrey, BC' } }] }));
  };
  try {
    const r1 = (await mgr.post('/api/data/geocode', { limit: 50 })).json;
    assert.ok(asked.some((q) => q === '13450 104 Ave, Surrey, BC'), 'Surrey, BC appended when city is missing');
    assert.ok(r1.located >= 1);
    assert.ok(r1.errored >= 1);
    let prof = (await mgr.get(`/api/persons/${p1.id}`)).json.person;
    assert.equal(prof.lat, 49.1906);
    prof = (await mgr.get(`/api/persons/${p2.id}`)).json.person;
    assert.equal(prof.lat, null, 'a locality-level match is not a door');
    assert.equal((await mgr.get(`/api/persons/${p3.id}`)).json.person.lat, null);
    outage = false;
    const r2 = (await mgr.post('/api/data/geocode', { limit: 50 })).json;
    assert.ok(r2.located >= 1, 'outage rows retried on the next batch');
    assert.equal((await mgr.get(`/api/persons/${p3.id}`)).json.person.lat, 49.17);
    assert.ok(r2.unmatched >= 1, 'vague match reported as unmatched, not retried forever');
    const before = asked.filter((q) => q.startsWith('Somewhere')).length;
    await mgr.post('/api/data/geocode', { limit: 50 });
    assert.equal(asked.filter((q) => q.startsWith('Somewhere')).length, before, 'parked rows are not re-asked');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('sample data: loads a full Surrey campaign, safe contacts only, then clears without a trace', async () => {
  const fresh = new Client();
  await fresh.signup({ workspaceName: 'Sample WS', jurisdiction: 'bc-municipal' });
  const load = await fresh.post('/api/data/sample', {});
  assert.equal(load.status, 200);
  assert.ok(load.json.people >= 45);
  assert.equal((await fresh.post('/api/data/sample', {})).status, 409, 'loads once');
  const me = (await fresh.get('/api/auth/me')).json;
  assert.deepEqual(me.workspace.settings.sample, { loaded: true }, 'the browser never gets the sample row ids');

  const doors = (await fresh.get('/api/map/doors')).json;
  assert.ok(doors.persons.length >= 45, 'sample people are on the map');
  const lats = doors.persons.map((p) => p.lat); const lngs = doors.persons.map((p) => p.lng);
  assert.ok(Math.min(...lats) > 49.0 && Math.max(...lats) < 49.22, 'inside Surrey (lat)');
  assert.ok(Math.min(...lngs) > -122.92 && Math.max(...lngs) < -122.68, 'inside Surrey (lng)');
  const all = (await fresh.get('/api/persons?limit=2000')).json.persons;
  assert.ok(all.every((p) => !p.email || /\.example(\.org)?$|@example\.org$/.test(p.email)), 'only reserved example domains');
  assert.ok(all.every((p) => !p.phone || /^604-555-01\d\d$/.test(p.phone)), 'only fictional 555-01xx numbers');

  const brief = (await fresh.get('/api/brief')).json;
  assert.equal(brief.sampleLoaded, true);
  assert.ok(brief.field.week > 10);
  assert.ok(brief.flagged.length >= 1, 'the over-cap sample gift is flagged');
  assert.ok(brief.shifts.length >= 1 && brief.events.length >= 1);
  assert.equal(brief.myTurfs.length, 1);
  const media = (await fresh.get('/api/persons?tag=media')).json.persons;
  assert.equal(media.length, 3);
  const tiers = await Promise.all(['Maya Chen', 'Hannah Lee'].map(async (n) => {
    const p = (await fresh.get(`/api/persons?q=${encodeURIComponent(n)}`)).json.persons[0];
    return (await fresh.get(`/api/persons/${p.id}`)).json.donor.tier;
  }));
  assert.deepEqual(tiers, ['superstar', 'star']);
  const walk = (await fresh.get(`/api/turfs/${brief.myTurfs[0].id}/walk`)).json;
  assert.ok(walk.doors.length >= 7, 'Newton turf holds the Newton block');

  const mine = await fresh.createPerson('Real Person', { email: 'real@example.org' });
  const clear = await fresh.req('DELETE', '/api/data/sample');
  assert.equal(clear.status, 200);
  assert.equal(clear.json.cleared, load.json.people);
  assert.equal(clear.json.kept, 0);
  assert.equal(clear.json.message, `Sample data cleared — ${load.json.people} sample people removed.`);
  const left = (await fresh.get('/api/persons?limit=2000')).json.persons;
  assert.deepEqual(left.map((p) => p.id), [mine.id], 'only real data remains');
  const b2 = (await fresh.get('/api/brief')).json;
  assert.equal(b2.sampleLoaded, false);
  assert.equal(b2.money.totalCents, 0, 'sample money left every total');
  assert.equal(b2.shifts.length + b2.events.length + b2.myTurfs.length, 0);
  assert.equal((await fresh.get('/api/signs')).json.signs.length, 0);
  assert.equal((await fresh.get('/api/records/gift?limit=200')).json.records.length, 0);
  assert.equal((await fresh.get('/api/audit/verify')).json.ok, true);
  const db = await getDb();
  const W = (await fresh.get('/api/auth/me')).json.workspace.id;
  const gifts = (await db.query('select deleted_at from gifts where workspace_id = $1', [W])).rows;
  assert.equal(gifts.length, load.json.gifts, 'sample gifts are voided on the books, not deleted');
  assert.ok(gifts.every((g) => g.deleted_at));
  void ws;
});

test('sample data: each rated person’s rated_at is their sample knock’s time, not the load time', async () => {
  const fresh = new Client();
  const s = await fresh.signup({ workspaceName: 'Sample Times WS', jurisdiction: 'bc-municipal' });
  assert.equal((await fresh.post('/api/data/sample', {})).status, 200);
  const db = await getDb();
  const rows = (await db.query(
    `select p.id, p.name, p.rating, p.rated_at,
            (select max(c.created_at) from contacts c where c.person_id = p.id) as last_contact_at,
            (select count(*)::int from contacts c where c.person_id = p.id) as contacts
     from persons p where p.workspace_id = $1`, [s.json.workspace.id],
  )).rows;
  const rated = rows.filter((r) => r.rating);
  assert.ok(rated.length >= 20, 'plenty of rated sample people');
  for (const r of rated) {
    assert.ok(r.last_contact_at, `${r.name} has a sample contact`);
    assert.equal(new Date(r.rated_at).toISOString(), new Date(r.last_contact_at).toISOString(), `${r.name}: rated when last contacted`);
  }
  assert.ok(rows.filter((r) => !r.rating).every((r) => r.rated_at === null && r.contacts === 0), 'unrated: no time, no contact');
  // Spread across the week, never all "now": profiles show different days.
  assert.ok(new Set(rated.map((r) => new Date(r.rated_at).toISOString().slice(0, 10))).size >= 3);
  // And the profile agrees with itself: "Rated" and "Last contact" are the same moment.
  const p = (await fresh.get(`/api/persons/${rated[0].id}`)).json;
  assert.equal(new Date(p.person.rated_at).toISOString(), new Date(p.contacts[0].created_at).toISOString());
  assert.equal(p.contacts[0].rating, p.person.rating);
});

test('import: a name-only row matches a name-only person of that name; re-importing doubles no one', async () => {
  const bare = await mgr.createPerson('Nadia Bare');
  const reached = await mgr.createPerson('Nadia Bare', { phone: '604-555-0141' }); // same name, has a phone: a different person
  const rows = [
    { name: '  nadia   BARE ' },                                // → the name-only Nadia (case, spaces)
    { name: 'Nadia Bare', city: 'Surrey', tags: 'imported' },   // → the same one: fills city, adds a tag
    { name: 'Omar Only' },                                      // new
    { first: 'Omar', last: 'only' },                            // same file: the Omar just added
    { name: 'Nadia Bare', email: 'nadia.bare@example.org' },    // has an email: not matched by name alone → new
    { name: 'Phone Pat', phone: '604-555-0142' },               // new
  ];
  const dry = (await imp(rows, { dryRun: true })).json;
  assert.deepEqual([dry.created, dry.merged, dry.unchanged], [3, 1, 2]);
  const real = (await imp(rows)).json;
  assert.deepEqual([real.created, real.merged, real.unchanged], [3, 1, 2]);
  assert.equal(real.decisions[0].id, bare.id);
  assert.equal(real.decisions[1].id, bare.id);
  assert.deepEqual(real.decisions[1].fields.sort(), ['city', 'tags']);
  assert.equal(real.decisions[3].id, real.decisions[2].id);
  const nadias = (await mgr.get('/api/persons?q=Nadia Bare')).json.persons;
  assert.equal(nadias.length, 3, 'name-only Nadia, Nadia with a phone, Nadia with an email');
  assert.ok(nadias.some((p) => p.id === reached.id && p.city === null), 'the reachable Nadia was not touched');

  // The file again, twice: nothing new, no one doubled.
  for (let i = 0; i < 2; i += 1) {
    const again = (await imp(rows)).json;
    assert.equal(again.created, 0, 're-import creates no one');
    assert.equal(again.merged, 0);
  }
  assert.equal((await mgr.get('/api/persons?q=Nadia Bare')).json.persons.length, 3);
  assert.equal((await mgr.get('/api/persons?q=Omar')).json.persons.length, 1);

  // The audit's file: a full row, a name-only row, a bad email. Twice.
  const audit = [
    { name: 'Import One', email: 'import.one@example.org', phone: '604-555-0171', address: '7100 128 St' },
    { name: 'Import Two' },
    { name: 'Bad Row', email: 'not-an-email' },
  ];
  const a1 = (await imp(audit)).json;
  assert.deepEqual([a1.created, a1.invalid.length], [2, 1]);
  const a2 = (await imp(audit)).json;
  assert.deepEqual([a2.created, a2.unchanged, a2.invalid.length], [0, 2, 1]);
  assert.equal((await mgr.get('/api/persons?q=Import Two')).json.persons.length, 1);
  // Fixed and imported again: the fixed row comes in once, the rest stay single.
  const fixed = audit.map((r) => (r.name === 'Bad Row' ? { ...r, email: 'bad.row@example.org' } : r));
  const a3 = (await imp(fixed)).json;
  assert.deepEqual([a3.created, a3.unchanged, a3.invalid.length], [1, 2, 0]);
  assert.equal((await mgr.get('/api/audit/verify')).json.ok, true);
});

// ── Clearing the sample: only what it made ──
const today = () => new Date().toISOString().slice(0, 10);
const sampleIds = async (W) => {
  const db = await getDb();
  const st = (await db.query('select settings from workspaces where id = $1', [W])).rows[0].settings;
  return (typeof st === 'string' ? JSON.parse(st) : st).sample;
};
const named = async (client, name) =>
  (await client.get(`/api/persons?q=${encodeURIComponent(name)}&limit=50`)).json.persons.find((p) => p.name === name);
const rowsLeft = async (table, ids) => {
  const db = await getDb();
  return (await db.query(`select id from ${table} where id = any($1::uuid[])`, [ids])).rows.map((r) => r.id);
};

test('sample clear: your gift, sign, knock, booking and RSVP stay — with the sample rows they hang on', async () => {
  const m = new Client();
  const s = await m.signup({ workspaceName: 'Keep Mine WS', jurisdiction: 'bc-municipal' });
  const W = s.json.workspace.id;
  const load = await m.post('/api/data/sample', {});
  assert.equal(load.status, 200);
  const { ids } = await sampleIds(W);
  assert.equal(ids.persons.length, load.json.people, 'every sample person is recorded by id');
  assert.equal(ids.gifts.length, load.json.gifts);
  assert.equal(ids.signs.length, load.json.signs);
  assert.ok(ids.contacts.length >= 20 && ids.roles.length >= 10 && ids.assignments.length === 3);
  assert.ok(ids.subscriptions.length === 5 && ids.shifts.length === 1 && ids.events.length === 1);
  assert.ok(ids.petitions.length === 1 && ids.turfs.length === 1);

  const tom = await named(m, 'Tom Riley');     // sample voter, rated 3 by a sample knock
  const dev = await named(m, 'Dev Patel');
  const rosa = await named(m, 'Rosa Delgado');
  assert.ok(tom.rating && dev.rating && rosa.rating);
  const gift = (await m.action('gift.log', { person_id: tom.id, amount_cents: 15000, date: today(), method: 'cheque', note: 'real cheque' })).json.gift;
  const sign = (await m.action('sign.place', { kind: 'lawn', person_id: dev.id })).json.sign;
  const knock = (await m.action('contact.log', { person_id: rosa.id, channel: 'door', outcome: 'no_answer' })).json.contact;
  const rachel = await m.createPerson('Rachel Real', { email: 'rachel.real@example.org', phone: '604-555-0177' });
  const mine = await m.createPerson('My Own Sample Tag', { tags: ['sample'] }); // yours, whatever its tags say
  const shift = (await m.get('/api/shifts')).json.shifts.find((x) => /sample/.test(x.title));
  const booking = (await m.action('shift.assign', { shift_id: shift.id, person_id: rachel.id })).json.assignment;
  const db = await getDb();
  const ev = (await db.query('select slug from campaign_events where id = $1', [ids.events[0]])).rows[0];
  const rsvp = await app.request(`/e/${s.json.workspace.slug}/${ev.slug}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ name: 'Rita Rsvp', email: 'rita.rsvp@example.org' }),
  });
  assert.equal(rsvp.status, 200);
  const rita = await named(m, 'Rita Rsvp');

  const clear = await m.req('DELETE', '/api/data/sample');
  assert.equal(clear.status, 200);
  const r = clear.json;
  assert.equal(r.keptPeople, 3);
  assert.equal(r.cleared, ids.persons.length - 3);
  assert.equal(r.kept, 5, 'gift, sign, knock, booking, RSVP');
  assert.deepEqual([r.keptShifts, r.keptEvents, r.keptPetitions], [1, 1, 0]);
  assert.equal(r.message, [
    `Sample data cleared — ${ids.persons.length - 3} sample people removed.`,
    'Kept 3 sample people with your own records on them (1 gift, 1 sign, 1 door knock); they’re no longer marked sample.',
    'Kept the shift “Saturday canvass — Newton (sample)”: 1 booking on it is yours.',
    'Kept the event “Town hall: Imagine Newton (sample)”: it has 1 RSVP.',
  ].join(' '));

  // The real gift on a sample voter survives, live; the books hold it alone.
  const gifts = (await m.get('/api/records/gift?limit=200')).json.records;
  assert.deepEqual(gifts.map((g) => g.id), [gift.id]);
  assert.equal(gifts[0].person_name, 'Tom Riley');
  const brief = (await m.get('/api/brief')).json;
  assert.equal(brief.money.totalCents, 15000);
  assert.equal(brief.sampleLoaded, false);
  // Sample gifts: voided on the books (an event each), not deleted.
  const sg = (await db.query('select deleted_at from gifts where id = any($1::uuid[])', [ids.gifts])).rows;
  assert.equal(sg.length, ids.gifts.length);
  assert.ok(sg.every((g) => g.deleted_at));
  const voids = (await db.query(
    `select entity_id from events where workspace_id = $1 and action = 'sample.clear' and entity_type = 'gift' and op = 'void'`, [W],
  )).rows.map((e) => e.entity_id).sort();
  assert.deepEqual(voids, [...ids.gifts].sort());

  // The real booking on the sample shift survives; the shift stays, its sample bookings go.
  assert.equal((await m.get(`/api/persons/${rachel.id}`)).json.shifts.length, 1);
  const on = (await db.query('select id from shift_assignments where shift_id = $1', [shift.id])).rows.map((x) => x.id);
  assert.deepEqual(on, [booking.id]);
  assert.ok((await m.get('/api/shifts')).json.shifts.some((x) => x.id === shift.id));
  // The sign you filed stays; the sample's signs go.
  assert.deepEqual((await m.get('/api/signs')).json.signs.map((x) => x.id), [sign.id]);
  // Kept sample people: unmarked, their sample knocks and made-up ratings gone, yours kept.
  for (const p of [tom, dev, rosa]) {
    const prof = (await m.get(`/api/persons/${p.id}`)).json;
    assert.ok(!prof.person.tags.includes('sample'), `${p.name} is no longer marked sample`);
    assert.equal(prof.person.rating, null, `${p.name}'s sample rating is gone`);
  }
  assert.deepEqual((await m.get(`/api/persons/${rosa.id}`)).json.contacts.map((x) => x.id), [knock.id]);
  // Everyone else the sample made is gone; your people (even one tagged "sample") stay.
  const left = (await m.get('/api/persons?limit=2000')).json.persons.map((p) => p.id).sort();
  assert.deepEqual(left, [tom.id, dev.id, rosa.id, rachel.id, mine.id, rita.id].sort());
  // Every sample-made row is gone, apart from the hosts kept above.
  assert.deepEqual(await rowsLeft('contacts', ids.contacts), []);
  assert.deepEqual(await rowsLeft('volunteer_roles', ids.roles), []);
  assert.deepEqual(await rowsLeft('signs', ids.signs), []);
  assert.deepEqual(await rowsLeft('shift_assignments', ids.assignments), []);
  assert.deepEqual(await rowsLeft('subscriptions', ids.subscriptions), []);
  assert.deepEqual(await rowsLeft('turfs', ids.turfs), []);
  assert.deepEqual(await rowsLeft('petitions', ids.petitions), []);
  assert.deepEqual(await rowsLeft('campaign_events', ids.events), ids.events, 'the event with an RSVP stays');
  const hidden = (await db.query('select id from persons where id = any($1::uuid[]) and deleted_at is null', [ids.persons])).rows.map((x) => x.id).sort();
  assert.deepEqual(hidden, [tom.id, dev.id, rosa.id].sort());
  assert.equal((await m.get('/api/audit/verify')).json.ok, true, 'the books still verify');

  // Load again: the kept event's link is taken, so the new one gets its own.
  const again = await m.post('/api/data/sample', {});
  assert.equal(again.status, 200);
  const ids2 = (await sampleIds(W)).ids;
  const ev2 = (await db.query('select slug from campaign_events where id = $1', [ids2.events[0]])).rows[0];
  assert.equal(ev2.slug, `${ev.slug}-2`);
  const clear2 = (await m.req('DELETE', '/api/data/sample')).json;
  assert.equal(clear2.cleared, ids2.persons.length);
  assert.equal(clear2.kept, 0);
  const left2 = (await m.get('/api/persons?limit=2000')).json.persons.map((p) => p.id).sort();
  assert.deepEqual(left2, left, 'the second clear leaves the same people');
  assert.equal((await m.get('/api/brief')).json.money.totalCents, 15000);
  assert.equal((await m.get('/api/audit/verify')).json.ok, true);
});

test('sample clear: a sample loaded before ids were recorded clears exactly too', async () => {
  const m = new Client();
  const s = await m.signup({ workspaceName: 'Legacy Sample WS', jurisdiction: 'bc-municipal' });
  const W = s.json.workspace.id;
  const load = await m.post('/api/data/sample', {});
  assert.equal(load.status, 200);
  const { ids, loadedAt } = await sampleIds(W);
  // The old shape: only shift, petition, event, turf and sign ids.
  const db = await getDb();
  await db.query(`update workspaces set settings = jsonb_set(settings, '{sample}', $2::jsonb) where id = $1`, [W, JSON.stringify({
    shiftIds: ids.shifts, petitionIds: ids.petitions, eventIds: ids.events, turfIds: ids.turfs, signIds: ids.signs, loadedAt,
  })]);
  const mine = await m.createPerson('Tagged By Me', { tags: ['sample'] });
  const harjit = await named(m, 'Harjit Gill');
  const gift = (await m.action('gift.log', { person_id: harjit.id, amount_cents: 2000, date: today(), method: 'cash' })).json.gift;
  const r = (await m.req('DELETE', '/api/data/sample')).json;
  assert.equal(r.cleared, ids.persons.length - 1);
  assert.equal(r.keptPeople, 1);
  assert.match(r.message, /Kept 1 sample person with your own records on them \(1 gift\)/);
  const left = (await m.get('/api/persons?limit=2000')).json.persons.map((p) => p.id).sort();
  assert.deepEqual(left, [mine.id, harjit.id].sort());
  assert.deepEqual((await m.get('/api/records/gift?limit=200')).json.records.map((g) => g.id), [gift.id]);
  assert.deepEqual(await rowsLeft('contacts', ids.contacts), []);
  assert.deepEqual(await rowsLeft('volunteer_roles', ids.roles), []);
  assert.deepEqual(await rowsLeft('shift_assignments', ids.assignments), []);
  assert.deepEqual(await rowsLeft('subscriptions', ids.subscriptions), []);
  assert.deepEqual(await rowsLeft('signs', ids.signs), []);
  assert.deepEqual(await rowsLeft('shifts', ids.shifts), []);
  const sg = (await db.query('select deleted_at from gifts where id = any($1::uuid[])', [ids.gifts])).rows;
  assert.ok(sg.length === ids.gifts.length && sg.every((g) => g.deleted_at), 'legacy sample gifts voided');
  assert.equal((await m.get('/api/brief')).json.sampleLoaded, false);
  assert.equal((await m.get('/api/audit/verify')).json.ok, true);
});

test('sample: nothing loaded → nothing cleared; load twice at once loads once', async () => {
  const m = new Client();
  await m.signup({ workspaceName: 'Empty Sample WS', jurisdiction: 'bc-municipal' });
  const mine = await m.createPerson('Only Mine', { tags: ['sample'] });
  const none = (await m.req('DELETE', '/api/data/sample')).json;
  assert.deepEqual([none.cleared, none.message], [0, 'No sample data is loaded.']);
  assert.deepEqual((await m.get('/api/persons')).json.persons.map((p) => p.id), [mine.id]);
  const [a, b] = await Promise.all([m.post('/api/data/sample', {}), m.post('/api/data/sample', {})]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal((await m.get('/api/persons?limit=2000')).json.persons.length, (a.json.people || b.json.people) + 1);
});

test('import: social handle columns — set on new people, fill blanks on matches', async () => {
  const first = await imp([{ name: 'Social Importee', email: 'social.importee@example.org', instagram: '@importee', reddit: 'u/Importee' }]);
  assert.equal(first.json.created, 1);
  const found = (await mgr.get('/api/persons?q=social.importee')).json.persons[0];
  assert.deepEqual(found.socials, { instagram: '@importee', reddit: 'u/Importee' });
  // Same person again: a new platform fills in, an existing handle is never overwritten.
  const again = await imp([{ name: 'Social Importee', email: 'social.importee@example.org', instagram: '@someone_else', x: 'importee_x', tiktok: '@importee.tt' }]);
  assert.equal(again.json.merged, 1);
  assert.deepEqual(again.json.decisions[0].fields, ['socials']);
  const after = (await mgr.get(`/api/persons/${found.id}`)).json.person;
  assert.deepEqual(after.socials, { instagram: '@importee', reddit: 'u/Importee', x: 'importee_x', tiktok: '@importee.tt' });
  // Nothing new: unchanged.
  const third = await imp([{ name: 'Social Importee', email: 'social.importee@example.org', x: 'importee_x' }]);
  assert.equal(third.json.unchanged, 1);
});

test('import: the campaign’s list — house number + street, latitude/longitude, 1/0 flags, and the standard fields by name', async () => {
  const fields = (await mgr.get('/api/fields')).json.fields;
  for (const n of ['Home phone', 'Province', 'House notes', 'Building notes', 'Access type', 'Dwelling type', 'Interaction status',
    'Interaction date', 'Organizer', 'Email opt-in', 'SMS opt-in', 'Sign', 'Support', 'Voted']) {
    assert.ok(fields.some((f) => f.name === n), `a new campaign starts with the field “${n}”`);
  }
  const byName = Object.fromEntries(fields.map((f) => [f.name, f.id]));
  const rows = [
    { first: 'Dara', last: 'Import', house_number: '13450', address: '104 Ave', city: 'Surrey', lat: '49.19', lng: '-122.85',
      volunteer: '1', donor: '0', phone: '604-555-0199',
      fields: { 'Home phone': '604-555-0100', Support: '5', 'Interaction date': '10/21/2026', 'Email opt-in': '1', Voted: '0', 'Access type': 'Buzzer', Province: 'BC' } },
    { name: 'Eli Import', house_number: 12, address: '12 72 Ave', lat: 'n/a', lng: '', donor: 'yes', fields: { 'Interaction date': '21 Oct 2026', 'SMS opt-in': 'Y' } },
  ];
  const r = await mgr.post('/api/data/import', { rows });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.invalid, []);
  assert.equal(r.json.created, 2);
  const dara = (await mgr.get('/api/persons?q=Dara%20Import')).json.persons[0];
  assert.equal(dara.address, '13450 104 Ave', 'the number and the street become one address');
  assert.equal(dara.lat, 49.19); assert.equal(dara.lng, -122.85);
  assert.ok(dara.tags.includes('volunteer') && !dara.tags.includes('donor'), '1/0 flags become tags');
  const vals = Object.fromEntries((await mgr.get(`/api/persons/${dara.id}/fields`)).json.fields.map((f) => [f.id, f.value]));
  assert.equal(vals[byName['Home phone']], '604-555-0100');
  assert.equal(vals[byName.Support], 5, 'support 1–5 is its own number, not the rating');
  assert.equal(vals[byName['Interaction date']], '2026-10-21', 'a date as the spreadsheet wrote it');
  assert.equal(vals[byName['Email opt-in']], true);
  assert.equal(vals[byName.Voted], false);
  assert.equal(vals[byName['Access type']], 'Buzzer');
  assert.equal(dara.rating, null);
  const eli = (await mgr.get('/api/persons?q=Eli%20Import')).json.persons[0];
  assert.equal(eli.address, '12 72 Ave', 'a street that has its number keeps it');
  assert.equal(eli.lat, null, 'words are not a pin');
  assert.ok(eli.tags.includes('donor'));
  const ev = Object.fromEntries((await mgr.get(`/api/persons/${eli.id}/fields`)).json.fields.map((f) => [f.id, f.value]));
  assert.equal(ev[byName['Interaction date']], '2026-10-21');
  assert.equal(ev[byName['SMS opt-in']], true);
  // A pin from a later list goes on only where there is none.
  const again = await mgr.post('/api/data/import', { rows: [{ name: 'Eli Import', address: '12 72 Ave', lat: 49.1, lng: -122.8 },
    { name: 'Dara Import', phone: '604-555-0199', lat: '0', lng: '0' }] });
  assert.equal(again.json.merged, 1, JSON.stringify(again.json));
  assert.equal((await mgr.get('/api/persons?q=Eli%20Import')).json.persons[0].lat, 49.1);
  assert.equal((await mgr.get('/api/persons?q=Dara%20Import')).json.persons[0].lat, 49.19, 'a pin on file stays');
  // Adding the standard fields again changes nothing.
  assert.deepEqual((await mgr.action('field.standard', {})).json.added, []);
});
