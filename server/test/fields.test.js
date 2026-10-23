// Profile fields: a manager defines them (five kinds, checked names and
// choices, reorder, take off / bring back, a kind change that is converted
// or refused), the desk fills them in (each kind checked), a volunteer reads
// only the filled-in ones marked for volunteers, People filters by one, the
// import fills them by column name with row-numbered errors, the export
// carries both tables, and the sample campaign brings three. test:pg-safe:
// unique emails and names per run, every query scoped to this workspace.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';
import { parseValue } from '../ext/fields/kinds.js';

const tag = Math.random().toString(36).slice(2, 8);
let mgr, staff, vol, other, ws;
const P = {};
const F = {};

const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const join = async (role, label) => {
  const c = new Client();
  const r = await c.signup({ workspaceName: `Temp ${label} ${tag}`, email: `fd-${label}+${tag}@example.org` });
  const db = await getDb();
  await db.query('update memberships set workspace_id = $2, role = $3 where user_id = $1', [r.json.user.id, ws, role]);
  await db.query('update sessions set workspace_id = $2 where user_id = $1', [r.json.user.id, ws]);
  return c;
};
const fieldsOf = async (c, id) => ok(await c.get(`/api/persons/${id}/fields`)).fields;
const valueOf = async (c, personId, fieldId) => (await fieldsOf(c, personId)).find((f) => f.id === fieldId)?.value;
const setValues = (c, personId, values) => c.action('field.values.set', {
  person_id: personId, values: Object.entries(values).map(([k, value]) => ({ field_id: F[k].id, value })),
});
const names = (r) => r.json.persons.map((p) => p.name).sort();

before(async () => {
  await freshDb();
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Fields WS ${tag}`, email: `fd-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ws = r.json.workspace.id;
  staff = await join('staff', 'staff');
  vol = await join('volunteer', 'vol');
  other = new Client();
  await other.signup({ workspaceName: `Other ${tag}`, email: `fd-other+${tag}@example.org` });

  P.ana = await mgr.createPerson('Ana Example', { phone: '604-555-0130', email: 'ana@example.org' });
  P.ben = await mgr.createPerson('Ben Example', { phone: '604-555-0131', email: 'ben@example.org' });
  P.cy = await mgr.createPerson('Cy Example', { phone: '604-555-0132' });
});

test('a manager defines fields: five kinds, checked names and choices; staff and volunteers may not', async () => {
  const add = (input) => mgr.action('field.create', input);
  F.language = ok(await add({ name: '  Language   at home ', kind: 'choice', choices: ['English', 'Punjabi', 'Mandarin'], volunteers: true })).field;
  assert.equal(F.language.name, 'Language at home', 'spaces tidied');
  assert.deepEqual(F.language.choices, ['English', 'Punjabi', 'Mandarin']);
  F.strata = ok(await add({ name: 'Strata council member', kind: 'yesno' })).field;
  assert.equal(F.strata.volunteers, false, 'volunteers can’t see a field unless a manager says so');
  F.union = ok(await add({ name: 'Union local', kind: 'text' })).field;
  F.household = ok(await add({ name: 'Household size', kind: 'number' })).field;
  F.moved = ok(await add({ name: 'Moved in', kind: 'date' })).field;
  assert.deepEqual([F.language, F.strata, F.union, F.household, F.moved].map((f) => f.position), [0, 1, 2, 3, 4]);

  assert.equal((await add({ name: 'language AT home', kind: 'text' })).status, 409, 'names are unique in any case');
  assert.equal((await add({ name: 'Pick', kind: 'choice', choices: ['Only'] })).status, 400, 'Pick one needs two choices');
  assert.equal((await add({ name: 'Dupes', kind: 'choice', choices: ['Yes', 'yes'] })).status, 400, 'choices must differ');
  assert.equal((await add({ name: 'Opts', kind: 'yesno', choices: ['A', 'B'] })).status, 400, 'only Pick one has choices');
  assert.equal((await add({ name: 'Bad', kind: 'colour' })).status, 400);
  assert.equal((await add({ name: '', kind: 'text' })).status, 400);
  assert.equal((await staff.action('field.create', { name: 'Staff made', kind: 'text' })).status, 403, 'defining is a manager’s job');
  assert.equal((await vol.action('field.create', { name: 'Vol made', kind: 'text' })).status, 403);
  assert.equal((await staff.action('field.update', { id: F.union.id, name: 'X' })).status, 403);
  assert.equal((await other.action('field.update', { id: F.union.id, name: 'X' })).status, 404, 'another campaign’s field is not found');

  // Rename and reorder.
  ok(await mgr.action('field.update', { id: F.union.id, name: 'Union local #' }));
  ok(await mgr.action('field.update', { id: F.union.id, name: 'Union local' }));
  const order = [F.strata.id, F.language.id, F.union.id, F.household.id, F.moved.id];
  ok(await mgr.action('field.reorder', { ids: order }));
  const list = ok(await staff.get('/api/fields')).fields;
  assert.deepEqual(list.map((f) => f.id), order, 'the desk reads the list in the new order');
  assert.equal((await mgr.action('field.reorder', { ids: order.slice(1) })).status, 409, 'a partial order is refused');
  ok(await mgr.action('field.reorder', { ids: [F.language.id, F.strata.id, F.union.id, F.household.id, F.moved.id] }));
});

test('the desk fills them in: each kind checked, cleared, a no-change save logs nothing', async () => {
  const r = ok(await setValues(staff, P.ana.id, {
    language: 'punjabi', strata: 'Yes', union: '  CUPE   402 ', household: '1,200', moved: '2024-02-29',
  }));
  assert.equal(r.changed, 5);
  const fields = await fieldsOf(staff, P.ana.id);
  const v = Object.fromEntries(fields.map((f) => [f.name, f.value]));
  assert.deepEqual(v, {
    'Language at home': 'Punjabi', 'Strata council member': true, 'Union local': 'CUPE 402', 'Household size': 1200, 'Moved in': '2024-02-29',
  }, 'stored as each kind stores it: the choice’s own words, a real yes, a number, a day');
  assert.ok(fields.every((f) => f.by_name), 'the desk sees who filled it in');

  // Yes/no reads yes · no · y · n · true · false and real booleans.
  for (const [given, want] of [['no', false], ['Y', true], ['n', false], ['TRUE', true], [true, true], ['false', false]]) {
    ok(await setValues(staff, P.ben.id, { strata: given }));
    assert.equal(await valueOf(staff, P.ben.id, F.strata.id), want, `yes/no reads ${given}`);
  }
  // Each kind refuses what doesn't fit — and one bad value saves nothing.
  const bad = [
    [{ language: 'Klingon' }, /Language at home.*Klingon.*isn’t one of the choices \(English, Punjabi, Mandarin\)/],
    [{ strata: 'maybe' }, /Strata council member.*isn’t yes or no/],
    [{ household: 'three' }, /Household size.*isn’t a number/],
    [{ moved: '2026-02-30' }, /Moved in.*isn’t a date like 2026-10-22/],
    [{ moved: '22/10/2026' }, /isn’t a date/],
    [{ union: 'x'.repeat(501) }, /Union local” is too long/],
    [{ union: 'Fine', household: 'lots' }, /Household size/],
  ];
  for (const [values, re] of bad) {
    const res = await setValues(staff, P.cy.id, values);
    assert.equal(res.status, 400, JSON.stringify(values));
    assert.match(res.json.error, re);
  }
  assert.equal(await valueOf(staff, P.cy.id, F.union.id), null, 'a refused save stored nothing');

  // Spaces only as thousands separators: "1 2 3" or "12 5" is a typo, never 123 or 125.
  for (const typo of ['1 2 3', '12 5', '1 20', '1 2000']) {
    const res = await setValues(staff, P.cy.id, { household: typo });
    assert.equal(res.status, 400, typo);
    assert.match(res.json.error, /“Household size”: “.*” isn’t a number/, typo);
  }
  for (const [given, want] of [['1 200', 1200], ['1 200 000', 1200000], ['-1 200.5', -1200.5], ['1\u00a0200', 1200]]) {
    ok(await setValues(staff, P.cy.id, { household: given }));
    assert.equal(await valueOf(staff, P.cy.id, F.household.id), want, `"${given}" is ${want}`);
  }
  ok(await setValues(staff, P.cy.id, { household: null }));
  // The import reads a cell with the same parser.
  assert.ok(parseValue({ kind: 'number' }, '2 3').error, 'an import cell “2 3” is refused, not 23');

  // Clear: null or "".
  ok(await setValues(staff, P.ana.id, { household: null, moved: '' }));
  assert.equal(await valueOf(staff, P.ana.id, F.household.id), null);
  assert.equal(await valueOf(staff, P.ana.id, F.moved.id), null);

  // A save that changes nothing adds nothing to the books.
  const db = await getDb();
  const seq = async () => Number((await db.query('select event_seq from workspaces where id = $1', [ws])).rows[0].event_seq);
  const before = await seq();
  const same = ok(await setValues(staff, P.ana.id, { language: 'Punjabi', strata: true }));
  assert.equal(same.changed, 0);
  assert.equal(await seq(), before, 'no events for an unchanged save');
  const ev = (await db.query(
    `select op, payload from events where workspace_id = $1 and action = 'field.values.set' and entity_type = 'person_field_value' order by seq`, [ws],
  )).rows;
  assert.ok(ev.some((e) => e.op === 'void' && e.payload.was === 1200), 'a cleared value is a void event that says what it was');
  assert.ok(ev.some((e) => e.op === 'update' && e.payload.was === true && e.payload.value === false), 'a change carries what it was');

  assert.equal((await vol.action('field.values.set', { person_id: P.ana.id, values: [{ field_id: F.union.id, value: 'x' }] })).status, 403,
    'volunteers read, never write');
  assert.equal((await other.action('field.values.set', { person_id: P.ana.id, values: [{ field_id: F.union.id, value: 'x' }] })).status, 404);
  const other2 = ok(await other.action('person.create', { name: 'Elsewhere' })).person;
  assert.equal((await other.action('field.values.set', { person_id: other2.id, values: [{ field_id: F.union.id, value: 'x' }] })).status, 400,
    'a field from another campaign is refused');
});

test('volunteers see only filled-in fields marked for them, words only — and never a hidden field through a filter', async () => {
  ok(await setValues(staff, P.ben.id, { language: 'Mandarin', union: 'UFCW 1518' }));
  const seen = ok(await vol.get(`/api/persons/${P.ben.id}/fields`));
  assert.equal(seen.edit, false);
  assert.deepEqual(seen.fields, [{ id: F.language.id, name: 'Language at home', kind: 'choice', value: 'Mandarin' }],
    'only “Language at home” (marked for volunteers); not strata, not union — and no who or when');
  assert.deepEqual((await fieldsOf(vol, P.cy.id)), [], 'nothing filled in: nothing to see');
  assert.equal((await vol.get('/api/fields')).status, 403, 'the list of every field is the desk’s');
  // One field's name, for a filter chip's words: a volunteer only gets one marked for them.
  assert.deepEqual(ok(await vol.get(`/api/fields/${F.language.id}`)).field, { id: F.language.id, name: 'Language at home', kind: 'choice' });
  assert.equal((await vol.get(`/api/fields/${F.strata.id}`)).status, 404, 'a field volunteers can’t see is not found');
  assert.equal(ok(await staff.get(`/api/fields/${F.strata.id}`)).field.name, 'Strata council member');
  assert.equal((await other.get(`/api/fields/${F.language.id}`)).status, 404, 'another campaign’s field is not found');
  assert.equal((await staff.get('/api/fields/not-a-field')).status, 404);
  const desk = await fieldsOf(staff, P.ben.id);
  assert.equal(desk.length, 5, 'the desk gets every field, empty ones too');

  // Filters: a volunteer's Calls list never matches on what they can't see.
  assert.deepEqual(names(await vol.get(`/api/persons?field=${F.union.id}:${encodeURIComponent('UFCW 1518')}`)), []);
  assert.deepEqual(names(await vol.get(`/api/persons?field=${F.strata.id}:*`)), []);
  assert.deepEqual(names(await vol.get(`/api/persons?field=${F.language.id}:mandarin`)), ['Ben Example'], 'a visible field filters for them too');
  assert.deepEqual(names(await staff.get(`/api/persons?field=${F.union.id}:${encodeURIComponent('ufcw 1518')}`)), ['Ben Example']);

  // Turned on: they see it.
  ok(await mgr.action('field.update', { id: F.union.id, volunteers: true }));
  assert.deepEqual((await fieldsOf(vol, P.ben.id)).map((f) => f.value), ['Mandarin', 'UFCW 1518']);
  ok(await mgr.action('field.update', { id: F.union.id, volunteers: false }));
});

test('People filter: one field’s value, any kind; ":*" is filled in; a bad value matches no one', async () => {
  ok(await setValues(staff, P.cy.id, { language: 'English', strata: 'no', household: 3, moved: '2025-06-01' }));
  ok(await setValues(staff, P.ana.id, { household: 3 }));
  const q = (id, v) => staff.get(`/api/persons?field=${id}${v === undefined ? '' : `:${encodeURIComponent(v)}`}`);
  assert.deepEqual(names(await q(F.language.id, 'Punjabi')), ['Ana Example']);
  assert.deepEqual(names(await q(F.language.id, 'PUNJABI')), ['Ana Example'], 'a choice in any case');
  assert.deepEqual(names(await q(F.strata.id, 'yes')), ['Ana Example']);
  assert.deepEqual(names(await q(F.strata.id, 'No')), ['Ben Example', 'Cy Example']);
  assert.deepEqual(names(await q(F.household.id, '3')), ['Ana Example', 'Cy Example']);
  assert.deepEqual(names(await q(F.moved.id, '2025-06-01')), ['Cy Example']);
  assert.deepEqual(names(await q(F.union.id, '*')), ['Ana Example', 'Ben Example']);
  assert.deepEqual(names(await q(F.union.id)), ['Ana Example', 'Ben Example'], 'no value: filled in');
  assert.deepEqual(names(await q(F.language.id, 'Klingon')), [], 'not a choice: no one');
  assert.deepEqual(names(await q('not-a-field', 'x')), []);
  assert.deepEqual(names(await other.get(`/api/persons?field=${F.language.id}:Punjabi`)), [], 'another campaign’s field matches no one');
  // With the other filters.
  assert.deepEqual(names(await staff.get(`/api/persons?q=ana&field=${F.household.id}:3`)), ['Ana Example']);
  // The desk list carries the common values for the filter sheet.
  const list = ok(await staff.get('/api/fields')).fields;
  const hh = list.find((f) => f.id === F.household.id);
  assert.deepEqual(hh.common, [{ value: 3, n: 2 }]);
  // Text: the most common words, in any case, as one.
  ok(await setValues(staff, P.cy.id, { union: 'cupe 402' }));
  const union = ok(await staff.get('/api/fields')).fields.find((f) => f.id === F.union.id);
  assert.deepEqual(union.common.map((c) => [c.value.toLowerCase(), c.n]), [['cupe 402', 2], ['ufcw 1518', 1]]);
  ok(await setValues(staff, P.cy.id, { union: null }));
  const lang = list.find((f) => f.id === F.language.id);
  assert.equal(lang.filled, 3);
  assert.deepEqual(lang.uses.map((u) => `${u.value}=${u.n}`).sort(), ['English=1', 'Mandarin=1', 'Punjabi=1']);
});

test('a field’s kind: free while empty; with values only Text (each value kept as words) — anything else is refused, with why', async () => {
  const tmp = ok(await mgr.action('field.create', { name: `Spare ${tag}`, kind: 'text' })).field;
  ok(await mgr.action('field.update', { id: tmp.id, kind: 'choice', choices: ['A', 'B'] }), 'empty: any kind');
  ok(await mgr.action('field.update', { id: tmp.id, kind: 'yesno' }), 'and choices drop with the kind');
  const now = ok(await staff.get('/api/fields')).fields.find((f) => f.id === tmp.id);
  assert.deepEqual([now.kind, now.choices], ['yesno', []]);
  ok(await mgr.action('field.retire', { id: tmp.id }));

  const refused = await mgr.action('field.update', { id: F.strata.id, kind: 'number' });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /“Strata council member” is filled in for 3 people — it can only become Text now/);
  assert.equal((await mgr.action('field.update', { id: F.language.id, kind: 'yesno' })).status, 409);

  const conv = ok(await mgr.action('field.update', { id: F.strata.id, kind: 'text' }));
  assert.equal(conv.converted, 3);
  assert.equal(await valueOf(staff, P.ana.id, F.strata.id), 'Yes', 'true became “Yes”');
  assert.equal(await valueOf(staff, P.cy.id, F.strata.id), 'No');
  assert.deepEqual(names(await staff.get(`/api/persons?field=${F.strata.id}:yes`)), ['Ana Example'], 'and still filters, as words');
  const db = await getDb();
  const ev = (await db.query(
    `select payload from events where workspace_id = $1 and entity_type = 'person_field_value' and payload->>'converted' = 'true'`, [ws],
  )).rows;
  assert.equal(ev.length, 3, 'every converted value is on the books with what it was');
  assert.ok(ev.every((e) => typeof e.payload.was === 'boolean'));
  const n2t = ok(await mgr.action('field.update', { id: F.household.id, kind: 'text' }));
  assert.equal(n2t.converted, 2);
  assert.equal(await valueOf(staff, P.cy.id, F.household.id), '3');
});

test('choices: add and reorder; a choice someone has stays', async () => {
  ok(await mgr.action('field.update', { id: F.language.id, choices: ['English', 'Punjabi', 'Mandarin', 'Tagalog', 'Hindi'] }));
  ok(await mgr.action('field.update', { id: F.language.id, choices: ['Punjabi', 'English', 'Mandarin', 'Hindi'] }), 'an unused one can go');
  const kept = await mgr.action('field.update', { id: F.language.id, choices: ['English', 'Mandarin', 'Hindi'] });
  assert.equal(kept.status, 409);
  assert.match(kept.json.error, /“Punjabi” is filled in for 1 person — it stays/);
  const f = ok(await staff.get('/api/fields')).fields.find((x) => x.id === F.language.id);
  assert.deepEqual(f.choices, ['Punjabi', 'English', 'Mandarin', 'Hindi']);
});

test('taking a field off keeps every value: off the profile, filter and import — still in the export; bring it back', async () => {
  const r = ok(await mgr.action('field.retire', { id: F.union.id }));
  assert.equal(r.kept, 2, 'its values stay');
  assert.ok(!(await fieldsOf(staff, P.ben.id)).some((f) => f.id === F.union.id), 'gone from the profile');
  assert.deepEqual(names(await staff.get(`/api/persons?field=${F.union.id}:*`)), [], 'gone from the filter');
  assert.equal((await setValues(staff, P.cy.id, { union: 'x' })).status, 409, 'nothing new goes on it');
  const list = ok(await staff.get('/api/fields')).fields;
  assert.equal(list[list.length - 1].retired, true, 'listed after the fields on the profile');
  assert.equal(list.find((f) => f.id === F.union.id).filled, 2);
  // A column for a field that's off (taken off while the import was set
  // up: the screen sends its id) is passed over — the person still comes in,
  // nothing is filled, and no id is ever put on screen.
  const imp = ok(await staff.post('/api/data/import', {
    rows: [
      { name: 'Dee Example', fields: { 'Union local': 'CUPE 402' } },
      { name: 'Dee Two Example', fields: { [F.union.id]: 'CUPE 402' } },
      { name: 'Cy Example', phone: '604-555-0132', fields: { [F.union.id]: 'CUPE 402' } },
      { name: 'Dee Three Example', fields: { [randomUUID()]: 'x' } },
    ],
    dryRun: true,
  }));
  assert.deepEqual(imp.invalid, ['row 4: a profile field in this import was removed — set its column to Don’t import'],
    'a field that’s gone altogether is named in words, never by its id');
  assert.equal(imp.created, 2, 'the rows with a taken-off field’s cell still come in');
  assert.equal(imp.decisions.find((d) => d.name === 'Cy Example').action, 'unchanged', 'the import doesn’t fill a field that’s off');
  const ex = ok(await mgr.get('/api/export'));
  assert.ok(ex.person_fields.some((f) => f.id === F.union.id && f.retired_at), 'the export has the field, taken off');
  assert.equal(ex.person_field_values.filter((v) => v.field_id === F.union.id).length, 2, 'and its values');

  // A new field may take the name; bringing the old one back then asks for a rename.
  const twin = ok(await mgr.action('field.create', { name: 'Union local', kind: 'yesno' })).field;
  assert.equal((await mgr.action('field.restore', { id: F.union.id })).status, 409);
  ok(await mgr.action('field.retire', { id: twin.id }));
  const back = ok(await mgr.action('field.restore', { id: F.union.id })).field;
  assert.equal(back.retired, false);
  assert.equal(await valueOf(staff, P.ben.id, F.union.id), 'UFCW 1518', 'every value is back with it');
  assert.equal((await staff.action('field.retire', { id: F.union.id })).status, 403);
});

test('import: a column fills a field by its name (any case), checked with row-numbered errors; blanks only; the dry run writes nothing', async () => {
  const rows = [
    { name: 'Ana Example', email: 'ana@example.org', fields: { 'language at home': 'English', 'MOVED IN': '2023-01-15' } },
    { name: 'Fay Example', phone: '604-555-0135', fields: { 'Language at home': 'mandarin', 'Strata council member': 'y', 'Household size': '4' } },
    { name: 'Gus Example', fields: { 'Language at home': 'Klingon' } },
    { name: 'Hal Example', fields: { 'Moved in': '15/01/2023' } },
    { name: 'Ida Example', fields: { 'Shoe size': '9' } },
    { name: 'Jo Example', fields: { [F.union.id]: 'Local 1' } },
  ];
  const dry = ok(await staff.post('/api/data/import', { rows, dryRun: true }));
  assert.deepEqual(dry.invalid, [
    'row 3: “Language at home”: “Klingon” isn’t one of the choices (Punjabi, English, Mandarin, Hindi)',
    'row 4: “Moved in”: “15/01/2023” isn’t a date like 2026-10-22',
    'row 5: there’s no field called “Shoe size”',
  ]);
  assert.deepEqual([dry.created, dry.merged, dry.unchanged], [2, 1, 0]);
  const ana = dry.decisions.find((d) => d.name === 'Ana Example');
  assert.deepEqual(ana.fields, ['Moved in'], 'Ana keeps her language (Punjabi): only the blank is filled');
  const db = await getDb();
  const count = async () => (await db.query('select count(*)::int as n from person_field_values where workspace_id = $1', [ws])).rows[0].n;
  const before = await count();
  assert.equal(before, await count(), 'the dry run wrote nothing');

  const real = ok(await staff.post('/api/data/import', { rows }));
  assert.deepEqual([real.created, real.merged, real.invalid.length], [2, 1, 3]);
  assert.equal(await valueOf(staff, P.ana.id, F.language.id), 'Punjabi', 'never overwritten');
  assert.equal(await valueOf(staff, P.ana.id, F.moved.id), '2023-01-15');
  const fay = (await staff.get('/api/persons?q=Fay%20Example')).json.persons[0];
  const fv = Object.fromEntries((await fieldsOf(staff, fay.id)).map((f) => [f.name, f.value]));
  assert.equal(fv['Language at home'], 'Mandarin', 'stored in the choice’s own words');
  assert.equal(fv['Strata council member'], 'y', 'a Text field now (it was converted), so the cell is kept as typed');
  assert.equal(fv['Household size'], '4');
  const jo = (await staff.get('/api/persons?q=Jo%20Example')).json.persons[0];
  assert.equal(await valueOf(staff, jo.id, F.union.id), 'Local 1', 'a field id works as the key too');
  // The same file again changes nobody.
  const again = ok(await staff.post('/api/data/import', { rows }));
  assert.deepEqual([again.created, again.merged], [0, 0]);
  const ev = (await db.query(
    `select count(*)::int as n from events where workspace_id = $1 and action = 'import.persons' and entity_type = 'person_field_value'`, [ws],
  )).rows[0].n;
  assert.equal(ev, 5, 'each filled value is on the books (Ana 1, Fay 3, Jo 1)');
});

test('export: every field (with its settings) and every value', async () => {
  const ex = ok(await mgr.get('/api/export'));
  const lang = ex.person_fields.find((f) => f.id === F.language.id);
  assert.equal(lang.name, 'Language at home');
  assert.equal(lang.volunteers, true);
  assert.deepEqual(lang.choices, ['Punjabi', 'English', 'Mandarin', 'Hindi']);
  assert.ok(ex.person_field_values.length >= 10);
  assert.ok(ex.person_field_values.every((v) => v.workspace_id === ws), 'this campaign’s rows only');
  assert.equal((await vol.get('/api/export')).status, 403);
  assert.equal((await mgr.get('/api/audit/verify')).json.ok, true, 'the books still verify');
});

test('sample campaign: three fields with values; clearing removes them, and keeps one you filled in', async () => {
  const s = new Client();
  await s.signup({ workspaceName: `Sample Fields ${tag}`, email: `fd-sample+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  ok(await s.post('/api/data/sample', {}));
  const list = ok(await s.get('/api/fields')).fields;
  assert.deepEqual(list.map((f) => [f.name, f.kind, f.volunteers]), [
    ['Language at home', 'choice', true], ['Strata council member', 'yesno', false], ['Union local', 'text', false],
  ]);
  assert.ok(list.every((f) => f.filled >= 2), 'each has a few values');
  const lang = list[0];
  const punjabi = (await s.get(`/api/persons?field=${lang.id}:Punjabi`)).json.persons;
  assert.ok(punjabi.length >= 3 && punjabi.some((p) => p.name === 'Harjit Gill'));

  // A real person of yours gets a value on a sample field: that field stays.
  const mine = await s.createPerson(`Real Person ${tag}`);
  ok(await s.action('field.values.set', { person_id: mine.id, values: [{ field_id: lang.id, value: 'Hindi' }] }));
  // A value you set on a sample person is one of your records, like a knock:
  // it keeps them — a sample donor (Hannah Lee) as well as anyone else.
  const strata = list[1];
  const who = async (name) => (await s.get(`/api/persons?q=${encodeURIComponent(name)}`)).json.persons.find((p) => p.name === name);
  const simran = await who('Simran Gill');
  const hannah = await who('Hannah Lee');
  ok(await s.action('field.values.set', { person_id: simran.id, values: [{ field_id: lang.id, value: 'English' }] }));
  ok(await s.action('field.values.set', { person_id: hannah.id, values: [{ field_id: strata.id, value: true }] }));
  const clear = ok(await s.req('DELETE', '/api/data/sample'));
  assert.match(clear.message, /Kept 2 sample people with your own records on them \(2 profile details\); they’re no longer marked sample\./);
  assert.match(clear.message, /Kept the field “Language at home”: you filled it in for 2 people\. Kept the field “Strata council member”: you filled it in for 1 person\.$/);
  const left = ok(await s.get('/api/fields')).fields;
  assert.deepEqual(left.map((f) => [f.name, f.filled]), [['Language at home', 2], ['Strata council member', 1]], 'the other sample field is gone');
  assert.equal(await valueOf(s, mine.id, lang.id), 'Hindi');
  assert.equal(await valueOf(s, simran.id, lang.id), 'English', 'kept with the person');
  assert.deepEqual((await s.get(`/api/persons?field=${strata.id}:*`)).json.persons.map((p) => p.name), ['Hannah Lee'],
    '“1 filled in” is someone People can find');
  // Every sample value went with a void event — none by cascade, off the books.
  const db = await getDb();
  const W = (await db.query('select workspace_id from persons where id = $1', [mine.id])).rows[0].workspace_id;
  const lost = (await db.query(
    `select e.entity_id from events e
     where e.workspace_id = $1 and e.entity_type = 'person_field_value' and e.op = 'create'
       and not exists (select 1 from person_field_values v where v.id = e.entity_id)
       and not exists (select 1 from events x where x.workspace_id = $1 and x.entity_type = 'person_field_value'
                         and x.entity_id = e.entity_id and x.op = 'void')`, [W],
  )).rows;
  assert.deepEqual(lost, [], 'no value gone without a void event');
  assert.equal((await s.get('/api/audit/verify')).json.ok, true);

  // A second load reuses your same-named field rather than making a twin.
  ok(await s.post('/api/data/sample', {}));
  assert.deepEqual(ok(await s.get('/api/fields')).fields.map((f) => f.name), ['Language at home', 'Strata council member', 'Union local']);
  const c2 = ok(await s.req('DELETE', '/api/data/sample'));
  assert.doesNotMatch(c2.message, /Kept the field/, 'your fields were never sample: nothing to say');
  assert.deepEqual(ok(await s.get('/api/fields')).fields.map((f) => [f.name, f.filled]), [['Language at home', 2], ['Strata council member', 1]]);
});
