// Rating scale: a campaign's own words and "Voting for?" list. The default
// is exactly the scale the app always had; renaming keeps the code; taking
// someone off the list keeps their old ratings readable and refuses new ones
// (except a phone's knock made while the list still had them); a new
// candidate never reuses a code; only managers change it, everyone reads it;
// the import takes codes and words, any case. Unique emails and campaign
// names throughout (test:pg runs every file on one database).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { RATINGS } from '@starbase/shared/canvass';
import {
  DEFAULT_SCALE, normalizeScale, ratingText, ratingByCode, matchRating, makeCode, offeredCodes, allCodes, bandOf,
} from '@starbase/shared/scale';
import { REPLAY_DAYS, ratingRefusal, applyEdit } from '../ext/scale/rules.js';

const tag = Math.random().toString(36).slice(2, 8);
let mgr, staff, treas, vol, other, ws;
const P = {};

const ok = (r, msg = '') => { assert.equal(r.status, 200, `${msg} ${JSON.stringify(r.json)}`); return r.json; };
const scaleOf = async (who = mgr) => ok(await who.get('/api/scale'), 'GET /api/scale').scale;
const knock = (who, person, rating, extra = {}) => who.action('contact.log', { person_id: person.id, channel: 'door', outcome: 'contacted', rating, ...extra });
// What the editor sends: the words and the list as it stands, with changes.
const listOf = (scale) => scale.candidates.map((c) => ({ code: c.code, name: c.name, off: c.off }));

before(async () => {
  await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Scale WS ${tag}`, email: `sc-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  const db = await getDb();
  const join = async (role) => {
    const c = new Client();
    const s = await c.signup({ workspaceName: `Temp ${role} ${tag}`, email: `sc-${role}+${tag}@example.org` });
    await db.query('update memberships set workspace_id = $2, role = $3 where user_id = $1', [s.json.user.id, ws, role]);
    await db.query('update sessions set workspace_id = $2 where user_id = $1', [s.json.user.id, ws]);
    return c;
  };
  staff = await join('staff');
  treas = await join('treasurer');
  vol = await join('volunteer');
  other = new Client();
  await other.signup({ workspaceName: `Other scale ${tag}`, email: `sc-other+${tag}@example.org` });
  P.locke = await mgr.createPerson('Lena Example', { phone: '604-555-0131', address: '13450 104 Ave' });
  P.maya = await mgr.createPerson('Maya Example', { phone: '604-555-0132', address: '10350 University Dr' });
  P.tom = await mgr.createPerson('Tom Example', { phone: '604-555-0133', address: '13730 72 Ave' });
});

test('the default scale is exactly the one the app always had', async () => {
  const s = await scaleOf();
  const flat = [
    ...s.steps.map((x) => ({ code: x.code, label: x.label, short: x.code, band: x.band })),
    ...s.candidates.map((x) => ({ code: x.code, label: x.label, short: x.code, band: 'opposed' })),
  ];
  assert.deepEqual(flat, RATINGS, 'same codes, labels and bands, in the same order');
  assert.deepEqual(s.steps.map((x) => x.word), ['Strong yes', 'Lean yes', 'Undecided', 'Opposed']);
  assert.deepEqual(s.candidates.map((x) => x.name), ['McCallum', 'Locke', 'Annis', 'van Vliet', 'Randhawa']);
  assert.ok(s.candidates.every((x) => !x.off));
  assert.equal(s.version, 0);
  assert.deepEqual(normalizeScale(null), DEFAULT_SCALE);
  // The words every screen says, unchanged.
  assert.equal(ratingText(s, '1'), '1 · Strong yes');
  assert.equal(ratingText(s, '4B'), '4 · Locke');
  assert.equal(ratingText(s, '4'), '4 · Opposed');
  assert.deepEqual(['1', '2', '3', '4', '4D', '4X'].map(bandOf), ['support', 'support', 'undecided', 'opposed', 'opposed', 'opposed']);
  assert.equal(bandOf('5'), null);
});

test('every signed-in role reads the scale; only managers change it', async () => {
  for (const who of [staff, treas, vol]) {
    assert.equal((await who.get('/api/scale')).status, 200, 'readable by every role (volunteers need it on the phone)');
    const r = await who.action('scale.save', { words: { 1: 'Definitely' } });
    assert.equal(r.status, 403, 'not a manager');
  }
  assert.equal((await new Client().get('/api/scale')).status, 401, 'signed out: no');
  assert.equal((await scaleOf()).steps[0].word, 'Strong yes', 'nothing changed');
});

test('words change; the codes and bands stay', async () => {
  const s = await scaleOf();
  const r = ok(await mgr.action('scale.save', { words: { 1: '  Definitely ', 3: 'Not sure yet' }, candidates: listOf(s) }));
  assert.deepEqual(r.scale.steps.map((x) => [x.code, x.band, x.word]), [
    ['1', 'support', 'Definitely'], ['2', 'support', 'Lean yes'], ['3', 'undecided', 'Not sure yet'], ['4', 'opposed', 'Opposed'],
  ]);
  assert.equal(r.scale.steps[0].label, 'Definitely', 'a changed word is its own label');
  assert.equal(r.scale.steps[1].label, 'Lean support', 'an unchanged one keeps the old label');
  assert.equal(r.scale.version, 1);
  // Volunteers see the same on their next read.
  assert.equal((await scaleOf(vol)).steps[0].word, 'Definitely');
  // Refused: empty, too long, two steps the same, a step called "Not sure".
  for (const words of [{ 2: '   ' }, { 2: 'Very very likely yes' }, { 2: 'Definitely' }, { 4: 'not sure' }]) {
    const bad = await mgr.action('scale.save', { words });
    assert.equal(bad.status, 400, JSON.stringify(words));
  }
  // Only this campaign's.
  assert.equal((await scaleOf(other)).steps[0].word, 'Strong yes');
});

test('renaming keeps the code; adding makes a new one; reorder', async () => {
  ok(await knock(mgr, P.locke, '4B'), 'rated Locke before any change');
  let s = await scaleOf();
  const list = listOf(s).map((c) => (c.code === '4B' ? { ...c, name: 'Brenda Locke' } : c));
  // Bains goes first; the rest keep their order.
  const r = ok(await mgr.action('scale.save', { candidates: [{ name: 'Bains' }, ...list] }));
  s = r.scale;
  assert.deepEqual(r.changes.added, [{ code: '4BA', name: 'Bains' }], '4B is taken: the next code from the name');
  assert.deepEqual(r.changes.renamed, [{ code: '4B', from: 'Locke', to: 'Brenda Locke' }]);
  assert.deepEqual(s.candidates.map((c) => c.code), ['4BA', '4D', '4B', '4F', '4N', '4C']);
  assert.equal(ratingByCode(s, '4B').name, 'Brenda Locke');
  assert.equal(ratingByCode(s, '4B').label, 'Opposed — Brenda Locke');
  assert.equal(ratingByCode(s, '4D').label, 'Opposed — Doug McCallum supporter', 'untouched names keep their label');
  assert.equal(s.steps[0].word, 'Definitely', 'words left out of a save stay as they were');
  // The person rated Locke is still 4B, now read with the new name.
  assert.equal(ok(await mgr.get(`/api/persons/${P.locke.id}`)).person.rating, '4B');
  assert.equal(ratingText(s, '4B'), '4 · Brenda Locke');
  // The new code and the renamed one both take ratings.
  ok(await knock(vol, P.maya, '4BA'), 'new candidate');
  ok(await knock(vol, P.tom, '4B'), 'renamed candidate');
  // A code nobody has, or a candidate listed twice: refused.
  assert.equal((await mgr.action('scale.save', { candidates: [{ code: '4Q', name: 'Nobody' }] })).status, 400);
  assert.equal((await mgr.action('scale.save', { candidates: [{ code: '4D', name: 'A' }, { code: '4D', name: 'B' }] })).status, 400);
  // Two on the list with one name, or a name that is a step's words: refused.
  assert.equal((await mgr.action('scale.save', { candidates: [...listOf(s), { name: 'bains' }] })).status, 400);
  assert.equal((await mgr.action('scale.save', { candidates: [...listOf(s), { name: 'Lean yes' }] })).status, 400);
  assert.equal((await mgr.action('scale.save', { candidates: [...listOf(s), { name: 'Not sure' }] })).status, 400);
  // …and a step's default words or label, even once that step says
  // something else (step 3 says "Not sure yet" now): the import reads
  // "Undecided" as 3 and "Strong support" as 1, never as a candidate.
  for (const name of ['Undecided', 'strong support', 'Strong yes']) {
    const bad = await mgr.action('scale.save', { candidates: [...listOf(s), { name }] });
    assert.equal(bad.status, 400, name);
    assert.match(bad.json.error, /a step’s words/, name);
  }
  const renameToStep = await mgr.action('scale.save', { candidates: listOf(s).map((c) => (c.code === '4D' ? { ...c, name: 'Undecided' } : c)) });
  assert.equal(renameToStep.status, 400, 'a rename too');
  assert.equal(matchRating(s, 'undecided').code, '3', 'what the import does with it');
  // A save that leaves someone out never drops their code.
  const kept = ok(await mgr.action('scale.save', { candidates: [{ code: '4C', name: 'Randhawa' }] })).scale;
  assert.deepEqual(kept.candidates.map((c) => c.code), ['4C', '4BA', '4D', '4B', '4F', '4N']);
  assert.ok(kept.candidates.every((c) => !c.off), 'left out is not taken off');
});

test('taking someone off the list keeps old ratings readable and refuses new ones', async () => {
  let s = await scaleOf();
  const before = ok(await mgr.get('/api/brief')).ratings['4B'];
  const r = ok(await mgr.action('scale.save', { candidates: listOf(s).map((c) => (c.code === '4B' ? { ...c, off: true } : c)) }));
  s = r.scale;
  assert.deepEqual(r.changes.off, ['4B']);
  const locke = s.candidates.find((c) => c.code === '4B');
  assert.equal(locke.off, true);
  assert.ok(Date.parse(locke.off_at) > Date.now() - 60000, 'when it came off');
  assert.ok(!offeredCodes(s).includes('4B') && allCodes(s).includes('4B'), 'not offered, still readable');
  // Old ratings stay, with their name, marked off the list.
  assert.equal(ok(await mgr.get(`/api/persons/${P.locke.id}`)).person.rating, '4B');
  assert.equal(ratingText(s, '4B'), '4 · Brenda Locke (off the list)');
  assert.equal(ok(await mgr.get('/api/brief')).ratings['4B'], before, 'Today still counts them');
  assert.ok(ok(await mgr.get('/api/persons?rating=4B')).persons.some((p) => p.id === P.locke.id), 'People still finds them');
  // A new rating with that code (no phone key: the desk, the API) is refused, in words.
  const bad = await knock(mgr, P.maya, '4B');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Brenda Locke is off the list/);
  assert.equal(ok(await mgr.get(`/api/persons/${P.maya.id}`)).person.rating, '4BA', 'nothing changed');
  // Put back: offered again.
  const back = ok(await mgr.action('scale.save', { candidates: listOf(s).map((c) => (c.code === '4B' ? { ...c, off: false } : c)) }));
  assert.deepEqual(back.changes.back, ['4B']);
  assert.equal(back.scale.candidates.find((c) => c.code === '4B').off_at, null);
  ok(await knock(mgr, P.maya, '4B'), 'back on the list');
  // And off again for the tests below.
  ok(await mgr.action('scale.save', { candidates: listOf(back.scale).map((c) => (c.code === '4B' ? { ...c, off: true } : c)) }));
});

test('a new candidate never reuses a code, even one off the list', async () => {
  const s = await scaleOf();
  const r = ok(await mgr.action('scale.save', { candidates: [...listOf(s), { name: 'Brar' }] }));
  assert.equal(r.changes.added[0].code, '4BR', '4B (off the list) and 4BA are taken');
  assert.equal(makeCode('Locke', allCodes(r.scale)), '4L');
  // The same name as someone off the list: put them back instead.
  const again = await mgr.action('scale.save', { candidates: [...listOf(r.scale), { name: 'brenda locke' }] });
  assert.equal(again.status, 400);
  assert.match(again.json.error, /put them back/);
  // Renaming someone on the list to the name of someone off it: the same.
  const brar = r.scale.candidates.find((c) => c.code === '4BR');
  const renamed = await mgr.action('scale.save', { candidates: listOf(r.scale).map((c) => (c.code === brar.code ? { ...c, name: 'BRENDA LOCKE' } : c)) });
  assert.equal(renamed.status, 400, JSON.stringify(renamed.json));
  assert.match(renamed.json.error, /Brenda Locke is off the list — put them back/);
  assert.equal(ratingByCode(await scaleOf(), '4BR').name, 'Brar', 'nothing changed');
  // …while putting her back, or renaming her on the way back, works.
  const back = ok(await mgr.action('scale.save', { candidates: listOf(r.scale).map((c) => (c.code === '4B' ? { ...c, name: 'B. Locke', off: false } : c)) }));
  assert.deepEqual(back.changes.back, ['4B']);
  ok(await mgr.action('scale.save', { candidates: listOf(back.scale).map((c) => (c.code === '4B' ? { ...c, name: 'Brenda Locke', off: true } : c)) }), 'and off again');
  // Codes are made from any name, never twice.
  const taken = [];
  for (let i = 0; i < 40; i += 1) taken.push(makeCode('Smith', taken));
  assert.equal(new Set(taken).size, 40);
  assert.ok(taken.every((c) => /^4[A-Z]{1,2}$/.test(c)));
});

test('a phone’s knock made before someone came off the list is still taken', async () => {
  // The volunteer tapped Brenda Locke with no signal; it reaches the server
  // after the manager took her off: it carries the phone's key, so it's in.
  const cid = randomUUID();
  const late = ok(await knock(vol, P.tom, '4B', { client_id: cid }), 'replay with a code taken off the list');
  assert.equal(late.contact.rating, '4B');
  assert.equal(ok(await vol.get(`/api/persons/${P.tom.id}`)).person.rating, '4B');
  // The same knock again is the same knock.
  assert.equal(ok(await knock(vol, P.tom, '4B', { client_id: cid })).duplicate, true);
  // A week later the list wins: a phone that old is told to pick again.
  const db = await getDb();
  const row = (await db.query('select settings from workspaces where id = $1', [ws])).rows[0];
  const settings = typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings;
  const old = new Date(Date.now() - (REPLAY_DAYS + 1) * 86400000).toISOString();
  settings.scale.candidates = settings.scale.candidates.map((c) => (c.code === '4B' ? { ...c, off_at: old } : c));
  await db.query('update workspaces set settings = $2 where id = $1', [ws, JSON.stringify(settings)]);
  const stale = await knock(vol, P.maya, '4B', { client_id: randomUUID() });
  assert.equal(stale.status, 400);
  assert.match(stale.json.error, /off the list — pick again/);
  // …but a replay of a knock already in still answers "already".
  assert.equal(ok(await knock(vol, P.tom, '4B', { client_id: cid })).duplicate, true);
  // The phone says when it was tapped: a knock tapped while Brenda Locke was
  // still offered, kept on the phone for over a week, still counts — the
  // week is counted to the tap, not to when it arrives.
  const late8 = await mgr.createPerson('Late Example', { phone: '604-555-0134', address: '13450 104 Ave' });
  const day = 86400000;
  const offAt = Date.parse(old);
  const before = new Date(offAt - day).toISOString();
  const kept = ok(await knock(vol, late8, '4B', { client_id: randomUUID(), client_at: before }), 'tapped the day before she came off');
  assert.equal(kept.contact.rating, '4B');
  assert.equal(ok(await mgr.get(`/api/persons/${late8.id}`)).person.rating, '4B');
  ok(await knock(vol, late8, '4B', { client_id: randomUUID(), client_at: new Date(offAt + 6 * day).toISOString() }), 'tapped 6 days after: that phone still had the old list');
  // Tapped more than a week after she came off, a time from the future, or
  // a time with no phone key: the list wins.
  for (const extra of [
    { client_id: randomUUID(), client_at: new Date(offAt + 7.5 * day).toISOString() },
    { client_id: randomUUID(), client_at: new Date(Date.now() + 30 * day).toISOString() },
    { client_at: before },
  ]) {
    const no = await knock(vol, late8, '4B', extra);
    assert.equal(no.status, 400, JSON.stringify(extra));
    assert.match(no.json.error, /off the list — pick again/);
  }
  assert.equal((await knock(vol, late8, '1', { client_id: randomUUID(), client_at: 'yesterday' })).status, 400, 'not a time');
  // The rule, on its own.
  const s = await scaleOf();
  assert.equal(ratingRefusal(s, '4B', { fromPhone: true }), 'Brenda Locke is off the list — pick again');
  assert.equal(ratingRefusal(s, '4B', { fromPhone: true, now: Date.parse(old) + 1000 }), null);
  assert.equal(ratingRefusal(s, '4B', { fromPhone: true, tapped: new Date(Date.parse(old) + 1000).toISOString() }), null, 'tapped then, arriving now');
  assert.match(ratingRefusal(s, '4B', { fromPhone: false, tapped: old }), /off the list/, 'a tap time alone is not a phone');
  assert.match(ratingRefusal(s, '4B', { fromPhone: true, tapped: 'not a time' }), /off the list/);
  assert.equal(ratingRefusal(s, '4BA', {}), null);
  assert.match(ratingRefusal(s, '4Z', { fromPhone: true }), /not on the scale/);
  // Codes the scale never had are refused at once; anything not a rating too.
  assert.equal((await knock(vol, P.maya, '4Z', { client_id: randomUUID() })).status, 400);
  assert.equal((await knock(vol, P.maya, '5')).status, 400);
});

test('the import takes the campaign’s codes and words, any case, and says what isn’t on it', async () => {
  const s = await scaleOf();
  assert.deepEqual(matchRating(s, 'definitely'), { code: '1', off: false });
  assert.deepEqual(matchRating(s, 'strong support'), { code: '1', off: false }, 'the old label still reads');
  assert.deepEqual(matchRating(s, ' 4 ba '), { code: '4BA', off: false });
  assert.deepEqual(matchRating(s, 'NOT SURE'), { code: '4', off: false });
  assert.deepEqual(matchRating(s, 'brenda locke'), { code: '4B', off: true });
  const r = ok(await mgr.post('/api/data/import', {
    dryRun: true,
    rows: [
      { name: `Imp One ${tag}`, rating: 'DEFINITELY' },
      { name: `Imp Two ${tag}`, rating: 'bains' },
      { name: `Imp Three ${tag}`, rating: '4ba' },
      { name: `Imp Four ${tag}`, rating: 'Brenda Locke' },
      { name: `Imp Five ${tag}`, rating: '7' },
      { name: `Imp Six ${tag}`, rating: 'mccallum' },
    ],
  }));
  assert.equal(r.created, 4);
  assert.deepEqual(r.invalid, ['row 4: rating “Brenda Locke” is off the list', 'row 5: rating “7” is not on the scale']);
  const real = ok(await mgr.post('/api/data/import', { rows: [{ name: `Imp Two ${tag}`, rating: 'Bains' }, { name: `Imp Six ${tag}`, rating: 'McCallum' }] }));
  assert.equal(real.created, 2);
  const found = ok(await mgr.get(`/api/persons?q=${encodeURIComponent(`Imp`)}`)).persons;
  assert.equal(found.find((p) => p.name === `Imp Two ${tag}`).rating, '4BA');
  assert.equal(found.find((p) => p.name === `Imp Six ${tag}`).rating, '4D');
});

test('sample data uses only what the list offers; the log has every change', async () => {
  const r = await mgr.post('/api/data/sample', {});
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const db = await getDb();
  const codes = (await db.query(
    `select distinct rating from persons where workspace_id = $1 and tags @> '["sample"]'::jsonb and rating is not null`, [ws],
  )).rows.map((x) => x.rating);
  assert.ok(codes.length > 3 && !codes.includes('4B'), `no sample rating is off the list: ${codes}`);
  const events = (await db.query(
    `select payload from events where workspace_id = $1 and action = 'scale.save' order by seq`, [ws],
  )).rows.map((e) => (typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload));
  assert.ok(events.length >= 5, 'every save is on the log');
  assert.ok(events.some((e) => e.changes?.added?.some((a) => a.code === '4BA')));
  assert.ok(events.some((e) => e.changes?.off?.includes('4B')));
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('one name is never on the list and off it, whichever way a save gets there', async () => {
  const s = await scaleOf();
  const [a, b] = s.candidates.filter((c) => !c.off);
  const gone = s.candidates.find((c) => c.off);
  const save = (fn) => mgr.action('scale.save', { candidates: listOf(s).map((c) => fn(c) ?? c) });
  // The editor: a row renamed to a name already on the list, then Take off
  // → Yes, then Save. It used to save, and Put back then had no way out.
  const renamedOff = await save((c) => (c.code === b.code ? { ...c, name: a.name.toUpperCase(), off: true } : null));
  assert.equal(renamedOff.status, 400, JSON.stringify(renamedOff.json));
  assert.equal(renamedOff.json.error, `${a.name} is already on the list — pick another name`);
  // Someone off the list renamed (over the API) to a name on it, or to
  // another name off it.
  const offRenamed = await save((c) => (c.code === gone.code ? { ...c, name: a.name.toLowerCase() } : null));
  assert.equal(offRenamed.status, 400, JSON.stringify(offRenamed.json));
  assert.match(offRenamed.json.error, /is already on the list — pick another name/);
  const twoOff = await save((c) => (c.code === b.code ? { ...c, name: gone.name, off: true } : null));
  assert.equal(twoOff.status, 400, JSON.stringify(twoOff.json));
  assert.equal(twoOff.json.error, `another ${gone.name} is off the list — pick another name`);
  assert.deepEqual(listOf(await scaleOf()), listOf(s), 'nothing changed');
  // A rename that clashes with no one, on the way off, still saves — and
  // they come back.
  const away = ok(await save((c) => (c.code === b.code ? { ...c, name: `${b.name} Sr`, off: true } : null)));
  assert.deepEqual(away.changes.off, [b.code]);
  ok(await mgr.action('scale.save', { candidates: listOf(away.scale).map((c) => (c.code === b.code ? { ...c, name: b.name, off: false } : c)) }), 'back');

  // A campaign that already holds such a pair (saved before this rule):
  // other changes still save, and so does taking the one on the list off;
  // putting the other back asks for a new name first.
  const twin = DEFAULT_SCALE.candidates.find((c) => !c.off);
  const pair = normalizeScale({ candidates: [...DEFAULT_SCALE.candidates, { code: '4TW', name: twin.name, off: true, off_at: new Date().toISOString() }] });
  const L = listOf(pair);
  assert.doesNotThrow(() => applyEdit(pair, { words: { 3: 'Unsure' }, candidates: L }));
  const bothOff = normalizeScale(applyEdit(pair, { candidates: L.map((c) => (c.code === twin.code ? { ...c, off: true } : c)) }).stored);
  assert.throws(() => applyEdit(pair, { candidates: L.map((c) => (c.code === '4TW' ? { ...c, off: false } : c)) }), /two candidates are called/);
  assert.throws(() => applyEdit(bothOff, { candidates: listOf(bothOff).map((c) => (c.code === '4TW' ? { ...c, off: false } : c)) }),
    new RegExp(`another ${twin.name} is off the list — rename this one`));
  const fixed = applyEdit(bothOff, { candidates: listOf(bothOff).map((c) => (c.code === '4TW' ? { ...c, name: `${twin.name} Jr`, off: false } : c)) });
  assert.deepEqual(fixed.changes.back, ['4TW']);
});
