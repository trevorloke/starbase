// Import at scale: each call loads only the people its rows could match
// (by email or name), not the whole list. These prove the dedupe decisions
// are exactly what matching against everyone on file gives — case, spaces
// and punctuation in names, email case, name + phone, name + address,
// name-only, repeats within a chunk and across calls — and that a call
// stays quick with a big list on file.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { getDb } from '../db/client.js';

let mgr, ws;

before(async () => {
  await freshDb();
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' })).json.workspace.id;
});

const imp = (rows, extra = {}) => mgr.post('/api/data/import', { rows, ...extra });

// The rules as they were when every call read everyone on file (the oracle):
// → per clean row, the id of the person it matches, or `new:<n>` for the nth
// person the call adds.
const norm = (s) => String(s ?? '').trim();
const lower = (s) => norm(s).toLowerCase();
const digits = (s) => norm(s).replace(/\D+/g, '');
const nameKey = (s) => lower(s).replace(/\s+/g, ' ');
const nameOnly = (p) => !p.email && !p.phone && !p.address;
const everyone = async (W) => (await (await getDb()).query(
  `select id, name, email, phone, address, unit from persons
   where workspace_id = $1 and deleted_at is null order by created_at, id`, [W],
)).rows;
// write: a real run (a merge's filled blanks count for later rows); the dry run doesn't.
const oracle = (existing, rows, write = true) => {
  const byEmail = new Map(); const byNamePhone = new Map(); const byNameAddr = new Map(); const byName = new Map();
  const index = (p) => {
    if (p.email) byEmail.set(lower(p.email), p);
    if (p.phone) byNamePhone.set(`${nameKey(p.name)}|${digits(p.phone)}`, p);
    if (p.address) byNameAddr.set(`${nameKey(p.name)}|${lower(p.address)}|${lower(p.unit)}`, p);
    const k = nameKey(p.name);
    if (nameOnly(p)) { if (!byName.has(k)) byName.set(k, p); } else if (byName.get(k) === p) byName.delete(k);
  };
  existing.map((p) => ({ ...p })).forEach(index);
  let made = 0;
  return rows.map((raw) => {
    const r = {
      name: norm(raw.name) || [norm(raw.first), norm(raw.last)].filter(Boolean).join(' '),
      email: lower(raw.email) || null, phone: norm(raw.phone) || null,
      address: norm(raw.address) || null, unit: norm(raw.unit) || null,
    };
    const match = (r.email && byEmail.get(r.email))
      || (r.phone && byNamePhone.get(`${nameKey(r.name)}|${digits(r.phone)}`))
      || (r.address && byNameAddr.get(`${nameKey(r.name)}|${lower(r.address)}|${lower(r.unit)}`))
      || (nameOnly(r) && byName.get(nameKey(r.name)));
    if (match) {
      // A merge that fills a blank indexes the person again (now the latest
      // with those keys); these rows carry no tags, city or postal code.
      const fill = ['email', 'phone', 'address', 'unit'].filter((k) => !match[k] && r[k]);
      if (write && fill.length) {
        for (const k of fill) match[k] = r[k];
        index(match);
      }
      return match.id;
    }
    const p = { ...r, id: `new:${made++}` };
    index(p);
    return p.id;
  });
};
// The server's decisions in the same shape.
const decided = (json) => {
  const made = new Map();
  return json.decisions.map((d) => {
    if (d.action === 'created') made.set(d.id, `new:${made.size}`);
    return made.get(d.id) || d.id;
  });
};

// Seeded, so a failure can be replayed.
const rng = (seed) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// Names that collide loosely ("O'Brien" / "OBrien", "Ana  Souza" / "ana souza"),
// emails in any case, phones in any format, addresses with and without units.
const NAMES = ['Ana Souza', 'ana  souza', ' ANA SOUZA ', 'Ana Sousa', "Liam O'Brien", 'Liam OBrien', 'liam o’brien',
  'Harjit Gill', 'harjit gill', 'Harjit-Gill', 'Mei Lin', 'Mei  Lin', 'Meilin', 'José Núñez', 'JOSÉ NÚÑEZ', 'Jose Nunez'];
const EMAILS = ['ana@example.org', 'ANA@Example.org', 'liam@example.org', 'harjit@example.org',
  'Harjit@EXAMPLE.org', 'mei@example.org', 'jose@example.org'];
const PHONES = ['604-555-0101', '(604) 555-0101', '6045550101', '604-555-0102', '604.555.0199'];
const ADDRS = [['13245 72 Ave', null], ['13245 72 AVE', null], ['13245 72 Ave', '4'], ['7100 128 St', null]];
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
// A third name-only; the rest with each of email, phone and address or not.
const person = (r) => {
  const name = pick(r, NAMES);
  if (r() < 0.33) return { name, email: null, phone: null, address: null, unit: null };
  const a = r() < 0.5 ? pick(r, ADDRS) : null;
  return { name, email: r() < 0.4 ? pick(r, EMAILS) : null, phone: r() < 0.5 ? pick(r, PHONES) : null,
    address: a?.[0] ?? null, unit: a?.[1] ?? null };
};

test('import: candidate lookup decides exactly as matching against everyone on file', async () => {
  const db = await getDb();
  const r = rng(20261023);
  // People on file, oldest first — some sharing a created_at (the id breaks the
  // tie), a few deleted, and look-alikes in another campaign that never match.
  const other = new Client();
  const ws2 = (await other.signup({ workspaceName: 'Elsewhere' })).json.workspace.id;
  for (let i = 0; i < 160; i += 1) {
    const p = person(r);
    await db.query(
      `insert into persons (id, workspace_id, name, email, phone, address, unit, created_at, deleted_at)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
      [i % 9 === 0 ? ws2 : ws, p.name, p.email, p.phone, p.address, p.unit,
       new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 2) * 1000).toISOString(), i % 13 === 0 ? new Date().toISOString() : null],
    );
  }

  // Calls of 40 rows (decisions come back for the first 50), dry run then real:
  // each against the oracle reading everyone on file just before it.
  let checked = 0;
  for (let call = 0; call < 8; call += 1) {
    const rows = Array.from({ length: 40 }, () => {
      const p = person(r);
      // Some rows by first + last, as a spreadsheet might have them.
      if (r() < 0.2) { const [first, ...rest] = norm(p.name).split(/\s+/); return { ...p, name: null, first, last: rest.join(' ') }; }
      return p;
    });
    const onFile = await everyone(ws);
    const dry = (await imp(rows, { dryRun: true })).json;
    assert.deepEqual(decided(dry), oracle(onFile, rows, false), `call ${call}: dry run`);
    const want = oracle(onFile, rows);
    const real = (await imp(rows)).json;
    assert.deepEqual(decided(real), want, `call ${call}: import`);
    checked += want.length;
  }
  assert.equal(checked, 320);
  // The oracle reads only this campaign's people on file, so a match on a
  // deleted person or one in the other campaign would have failed above.
  assert.equal((await db.query('select count(*)::int as n from persons where workspace_id = $1', [ws2])).rows[0].n, 18);
});

test('import: each kind of match, by hand', async () => {
  const ana = await mgr.createPerson('Ana  Souza Kim');                                    // name-only
  const anaReach = await mgr.createPerson('Ana Souza Kim', { phone: '604-555-0301' });     // same name, a phone
  const raj = await mgr.createPerson('Raj Patel', { email: 'Raj.Patel@Example.org' });
  const lee = await mgr.createPerson('Lee Wong', { address: '13245 72 Ave', unit: '4' });
  const rows = [
    { name: 'ana souza kim' },                                     // → name-only Ana (case, spaces)
    { name: 'ANA SOUZA  KIM', phone: '(604) 555-0301' },            // → Ana with the phone (name + phone)
    { name: 'Someone Else', email: 'raj.patel@EXAMPLE.org' },      // → Raj (email in any case, any name)
    { name: 'lee  wong', address: '13245 72 AVE', unit: '4' },      // → Lee (name + address + unit)
    { name: 'Lee Wong', address: '13245 72 Ave' },                 // no unit: a different door → new
    { name: 'Ana-Souza Kim' },                                     // loosely the same, but a different name → new
    { name: 'ana-souza kim' },                                     // same file: the one just added
  ];
  const real = (await imp(rows)).json;
  assert.deepEqual(real.decisions.map((d) => d.action), ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'created', 'created', 'unchanged']);
  assert.deepEqual(real.decisions.slice(0, 4).map((d) => d.id), [ana.id, anaReach.id, raj.id, lee.id]);
  assert.equal(real.decisions[6].id, real.decisions[5].id);

  // Across calls: the people one call adds are found by the next.
  const next = (await imp([{ name: 'Lee Wong', address: '13245 72 ave' }, { name: 'ANA-SOUZA KIM' }])).json;
  assert.deepEqual(next.decisions.map((d) => d.id), [real.decisions[4].id, real.decisions[5].id]);
  assert.equal(next.created, 0);
});

test('import: a 1,000-row call with 20,000 people on file stays quick', async () => {
  const db = await getDb();
  await db.query(
    `insert into persons (id, workspace_id, name, email, phone, address, created_at)
     select gen_random_uuid(), $1, 'Voter ' || g, case when g % 3 = 0 then 'voter' || g || '@example.org' end,
            case when g % 3 = 1 then '604-555-' || lpad((g % 10000)::text, 4, '0') end,
            case when g % 2 = 0 then g || ' 72 Ave' end, now() - make_interval(secs => 50000 - g)
     from generate_series(1, 20000) g`, [ws],
  );
  // Half the rows are people on file — in turn by email, name + phone,
  // name + address and name alone — and half are new.
  const rows = Array.from({ length: 1000 }, (_, i) => {
    if (i % 2) return { name: `New Voter ${i}`, address: `${i} 128 St` };
    const kind = (i / 2) % 4;
    const g = 6 * i + [3, 1, 4, 5][kind];
    if (kind === 0) return { name: `Someone ${g}`, email: `VOTER${g}@example.org` };
    if (kind === 1) return { name: `VOTER ${g}`, phone: `(604) 555-${String(g % 10000).padStart(4, '0')}` };
    if (kind === 2) return { name: `voter  ${g}`, address: `${g} 72 AVE` };
    return { name: ` voter ${g} ` };
  });
  const onFile = await everyone(ws);
  const t0 = performance.now();
  const dry = (await imp(rows, { dryRun: true })).json;
  const t1 = performance.now();
  const real = (await imp(rows)).json;
  const t2 = performance.now();
  const want = oracle(onFile, rows);
  assert.deepEqual([dry.created, dry.merged + dry.unchanged], [500, 500]);
  assert.deepEqual([real.created, real.merged + real.unchanged], [500, 500]);
  assert.deepEqual(decided(real), want.slice(0, 50));
  // Generous for slow CI; reading all 20,000 per call is what this guards against.
  assert.ok(t1 - t0 < 4000, `dry run took ${Math.round(t1 - t0)} ms`);
  assert.ok(t2 - t1 < 8000, `import took ${Math.round(t2 - t1)} ms`);
});
