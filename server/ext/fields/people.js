// Where profile fields meet the rest of the people tools (lib/hooks.js):
//
//   personsWhere   GET /persons?field=<field id>:<value> — People (and the
//                  Call / Text lists it opens) narrowed to one field's value,
//                  ":*" for "filled in". Text matches in any case; the value
//                  is read like any other (yes · no, a choice in any case).
//                  A volunteer's list never matches on a field volunteers
//                  can't see — the result itself would tell them who has it.
//   importRows     POST /data/import: a row's `fields` ({ "<field name or
//                  id>": "<cell>" }, names in any case) are checked like a
//                  profile save — a cell that doesn't fit refuses the row,
//                  with its row number, like a bad email. A person on file
//                  gets only the fields still blank (an import never
//                  overwrites); a new person gets them all. A cell for a
//                  field taken off is passed over (nothing to fill).
//   sampleLoaded   the Imagine Surrey sample's three fields and a few values
//   sampleCleared  removes exactly those; a sample field you filled in for
//                  your own people stays (no longer sample), and says so.
import { newId } from '../../lib/events.js';
import { FIELDS_MAX, nameKey, parseValue, valueError } from './kinds.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const personsWhere = async (db, ctx, query, w) => {
  const raw = String(query?.field ?? '').trim();
  if (!raw) return;
  const at = raw.indexOf(':');
  const id = at < 0 ? raw : raw.slice(0, at);
  const want = at < 0 ? '*' : raw.slice(at + 1);
  const none = () => { w.where += ' and false'; };
  if (!UUID_RE.test(id)) return none();
  const f = (await db.query(
    'select * from person_fields where id = $1 and workspace_id = $2 and retired_at is null', [id, ctx.workspaceId],
  )).rows[0];
  if (!f || (ctx.role === 'volunteer' && !f.volunteers)) return none();
  // Every param pushed must be used: check the value before pushing any.
  const p = want === '*' ? null : parseValue(f, want);
  if (p && (p.error || p.empty)) return none();
  w.params.push(f.id);
  const fid = `$${w.params.length}`;
  let match = '';
  if (p) {
    if (f.kind === 'text') {
      w.params.push(String(p.value).toLowerCase());
      match = ` and lower(v.value #>> '{}') = $${w.params.length}`;
    } else {
      w.params.push(JSON.stringify(p.value));
      match = ` and v.value = $${w.params.length}::jsonb`;
    }
  }
  w.where += ` and exists (select 1 from person_field_values v
    where v.workspace_id = p.workspace_id and v.person_id = p.id and v.field_id = ${fid}${match})`;
  return undefined;
};

export const importRows = async (db, ctx, extras) => {
  const ws = ctx.workspaceId;
  const all = (await db.query('select * from person_fields where workspace_id = $1', [ws])).rows;
  const fields = all.filter((f) => !f.retired_at);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const byName = new Map(fields.map((f) => [nameKey(f.name), f]));
  // A field taken off (perhaps while this import was being set up) has
  // nothing to fill: its cells are passed over, the row still comes in.
  const offIds = new Set(all.filter((f) => f.retired_at).map((f) => f.id));
  const offNames = new Set(all.filter((f) => f.retired_at).map((f) => nameKey(f.name)));
  // Blanks only: what is already filled in, person|field — read a person at a
  // time, when a row first brings them a value (never the whole workspace).
  const filled = new Set();
  const read = new Set();
  const readFilled = async (tx, personId) => {
    if (read.has(personId)) return;
    read.add(personId);
    for (const r of (await tx.query(
      'select field_id from person_field_values where workspace_id = $1 and person_id = $2', [ws, personId],
    )).rows) filled.add(`${personId}|${r.field_id}`);
  };
  extras.push({
    // → { value: [{ f, value }] } | { error } (the row is refused).
    check(raw) {
      const given = raw?.fields;
      if (given === undefined || given === null) return { value: [] };
      if (typeof given !== 'object' || Array.isArray(given)) return { error: 'fields: not readable' };
      const out = [];
      for (const [key, cell] of Object.entries(given)) {
        const f = byId.get(key) || byName.get(nameKey(key));
        if (!f && (offIds.has(key) || offNames.has(nameKey(key)))) continue;
        // Never an id on screen: one that names no field here is a field since removed.
        if (!f && UUID_RE.test(key)) return { error: 'a profile field in this import was removed — set its column to Don’t import' };
        if (!f) return { error: `there’s no field called “${String(key).slice(0, 60)}”` };
        if (out.some((o) => o.f.id === f.id)) return { error: `“${f.name}” is in two columns` };
        const p = parseValue(f, typeof cell === 'number' || typeof cell === 'boolean' || cell === null ? cell : String(cell ?? ''));
        if (p.error) return { error: valueError(f, p.error) };
        if (!p.empty) out.push({ f, value: p.value });
      }
      return { value: out };
    },
    // → the names of the fields it filled (or would, in the dry run).
    async apply(tx, personId, values, { write }, emit) {
      const names = [];
      if (values?.length) await readFilled(tx, personId);
      for (const { f, value } of values || []) {
        const key = `${personId}|${f.id}`;
        if (filled.has(key)) continue;
        filled.add(key);
        if (write) {
          const id = newId();
          const row = (await tx.query(
            `insert into person_field_values (id, workspace_id, field_id, person_id, value, updated_by)
             values ($1, $2, $3, $4, $5, $6) on conflict (field_id, person_id) do nothing returning id`,
            [id, ws, f.id, personId, JSON.stringify(value), ctx.user?.id || null],
          )).rows[0];
          if (!row) continue; // filled in meanwhile: theirs stays
          emit('person_field_value', id, 'create', { id, field_id: f.id, person_id: personId, value, source: 'import' });
        }
        names.push(f.name);
      }
      return names;
    },
  });
};

// ── The sample campaign ──
// Fictional people from lib/sample.js, by name.
export const SAMPLE_FIELDS = [
  {
    name: 'Language at home',
    kind: 'choice',
    choices: ['English', 'Punjabi', 'Mandarin', 'Tagalog', 'Hindi', 'Other'],
    volunteers: true,
    values: {
      'Harjit Gill': 'Punjabi', 'Simran Gill': 'Punjabi', 'Gurpreet Sandhu': 'Punjabi', 'Manpreet Dhaliwal': 'Punjabi',
      'Mei Lin': 'Mandarin', 'Maya Chen': 'English', 'Isabel Cruz': 'Tagalog', 'Ravi Shankar': 'Hindi', 'Tom Riley': 'English',
    },
  },
  {
    name: 'Strata council member',
    kind: 'yesno',
    volunteers: false,
    values: { 'Jasmine Wong': true, 'Sofia Petrova': true, 'Hannah Lee': false },
  },
  {
    name: 'Union local',
    kind: 'text',
    volunteers: false,
    values: { 'Kwame Mensah': 'CUPE 402', 'Owen Price': 'UFCW 1518' },
  },
];

// Imagine Surrey's standard fields: one for every column of the campaign's
// list that the core person record has no home for. Named exactly as the
// list's columns, so the import maps them by name with no thought. Made
// when the campaign is set up (workspaceCreated) and by field.standard
// (Profile fields → Add the standard fields) for a campaign set up before
// they existed; a field of the same name already there is left as it is.
export const STANDARD_FIELDS = [
  { name: 'Home phone', kind: 'text', volunteers: true },
  { name: 'Province', kind: 'text', volunteers: false },
  { name: 'House notes', kind: 'text', volunteers: true },
  { name: 'Building notes', kind: 'text', volunteers: true },
  { name: 'Access type', kind: 'text', volunteers: true },
  { name: 'Dwelling type', kind: 'text', volunteers: true },
  { name: 'Interaction status', kind: 'text', volunteers: false },
  { name: 'Interaction date', kind: 'date', volunteers: false },
  { name: 'Organizer', kind: 'text', volunteers: false },
  { name: 'Email opt-in', kind: 'yesno', volunteers: false },
  { name: 'SMS opt-in', kind: 'yesno', volunteers: false },
  { name: 'Sign', kind: 'yesno', volunteers: true },
  { name: 'Support', kind: 'number', volunteers: false },
  { name: 'Voted', kind: 'yesno', volunteers: false },
];

// → the fields added ({ id, name, kind }); none when every one is there.
export const addStandardFields = async (tx, ctx, emit) => {
  const ws = ctx.workspaceId;
  const live = (await tx.query('select * from person_fields where workspace_id = $1 and retired_at is null', [ws])).rows;
  let top = live.reduce((m, f) => Math.max(m, f.position), -1);
  let count = live.length;
  const added = [];
  for (const s of STANDARD_FIELDS) {
    if (live.some((x) => nameKey(x.name) === nameKey(s.name))) continue;
    if (count >= FIELDS_MAX) break;
    top += 1; count += 1;
    const f = { id: newId(), name: s.name, kind: s.kind, choices: [], volunteers: s.volunteers, position: top };
    await tx.query(
      `insert into person_fields (id, workspace_id, name, kind, choices, volunteers, position, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [f.id, ws, f.name, f.kind, '[]', f.volunteers, f.position, ctx.user?.id || null],
    );
    emit('person_field', f.id, 'create', { ...f, standard: true });
    added.push({ id: f.id, name: f.name, kind: f.kind });
  }
  return added;
};
export const workspaceCreated = (tx, ctx, { emit }) => addStandardFields(tx, ctx, emit);

export const sampleLoaded = async (tx, ctx, { people, emit }) => {
  const ws = ctx.workspaceId;
  const live = (await tx.query(
    'select * from person_fields where workspace_id = $1 and retired_at is null', [ws],
  )).rows;
  let top = live.reduce((m, f) => Math.max(m, f.position), -1);
  let count = live.length;
  for (const s of SAMPLE_FIELDS) {
    // A field of yours with the same name: the sample's values go on it when
    // it is the same kind (and has the choice); otherwise it is left alone.
    let f = live.find((x) => nameKey(x.name) === nameKey(s.name));
    if (f && f.kind !== s.kind) continue;
    if (!f) {
      if (count >= FIELDS_MAX) continue;
      top += 1;
      count += 1;
      f = { id: newId(), name: s.name, kind: s.kind, choices: s.choices || [], volunteers: s.volunteers, position: top };
      await tx.query(
        `insert into person_fields (id, workspace_id, name, kind, choices, volunteers, position, sample, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
        [f.id, ws, f.name, f.kind, JSON.stringify(f.choices), f.volunteers, f.position, ctx.user?.id || null],
      );
      emit('person_field', f.id, 'create', { ...f, sample: true });
    }
    for (const [who, raw] of Object.entries(s.values)) {
      const personId = people[who];
      const p = parseValue(f, raw);
      if (!personId || p.error || p.empty) continue;
      const id = newId();
      const row = (await tx.query(
        `insert into person_field_values (id, workspace_id, field_id, person_id, value, sample, updated_by)
         values ($1, $2, $3, $4, $5, true, $6) on conflict (field_id, person_id) do nothing returning id`,
        [id, ws, f.id, personId, JSON.stringify(p.value), ctx.user?.id || null],
      )).rows[0];
      if (row) emit('person_field_value', id, 'create', { id, field_id: f.id, person_id: personId, value: p.value, sample: true });
    }
  }
};

// Just before the sample's people go (routes/data.js): every value the
// sample made goes, each with a void event — on the people who stay and on
// those about to be removed alike, so none vanishes by cascade off the books.
// A value you set on a sample person is yours (sample = false) and keeps
// that person (clearSample counts it as one of your records), so what is
// left is yours, on people who stay. Then the sample's fields
// with nothing left go; one you filled in stays, and the message says so.
export const sampleCleared = async (tx, ctx, { emit, said }) => {
  const ws = ctx.workspaceId;
  const vals = (await tx.query(
    'delete from person_field_values where workspace_id = $1 and sample returning id, field_id, person_id', [ws],
  )).rows;
  for (const v of vals) emit('person_field_value', v.id, 'void', { field_id: v.field_id, person_id: v.person_id, sample: true });
  const fields = (await tx.query(
    `select f.id, f.name, (select count(*)::int from person_field_values v where v.field_id = f.id) as n
     from person_fields f where f.workspace_id = $1 and f.sample order by f.position`, [ws],
  )).rows;
  for (const f of fields) {
    if (f.n === 0) {
      await tx.query('delete from person_fields where id = $1 and workspace_id = $2', [f.id, ws]);
      emit('person_field', f.id, 'void', { name: f.name, sample: true });
    } else {
      await tx.query('update person_fields set sample = false, updated_at = now() where id = $1 and workspace_id = $2', [f.id, ws]);
      emit('person_field', f.id, 'update', { sample: false, kept: f.n });
      said.push(`Kept the field “${f.name}”: you filled it in for ${plural(f.n, 'person', 'people')}.`);
    }
  }
};
