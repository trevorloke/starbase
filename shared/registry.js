// The schema registry — the one source of truth for every Record type.
// Generates, from a single field definition: SQL DDL (typed columns, not
// blobs), zod validators enforced server-side on every write, and form/column
// hints for the web client. Persons are NOT a record type — they are a
// first-class primitive table that records point at via real foreign keys.
//
// Field types → storage:
//   money   → integer cents          person → uuid FK persons(id)
//   date    → date                   number → numeric
//   select  → text (validated)       text/email/phone → text
// Every record table also gets: id uuid PK, workspace_id FK, created_at,
// updated_at, deleted_at (soft delete), attrs jsonb (long-tail only).

import { z } from 'zod';

export const RECORD_TYPES = {
  gift: {
    label: 'Gift',
    plural: 'Gifts',
    table: 'gifts',
    fields: [
      { key: 'person_id',    label: 'Donor',  type: 'person', required: true },
      { key: 'amount_cents', label: 'Amount', type: 'money',  required: true },
      { key: 'date',         label: 'Date',   type: 'date',   required: true },
      { key: 'method',       label: 'Method', type: 'select',
        options: ['card', 'etransfer', 'cheque', 'cash', 'in-kind'] },
      { key: 'cadence',      label: 'Cadence', type: 'select',
        options: ['one-time', 'monthly'], default: 'one-time' },
      { key: 'note',         label: 'Note',   type: 'text' },
    ],
  },
};

const SQL_TYPES = {
  money:  'integer',
  date:   'date',
  number: 'numeric',
  person: 'uuid references persons(id)',
  select: 'text',
  text:   'text',
  email:  'text',
  phone:  'text',
};

// DDL for one record type. Typed columns from the registry; identical
// standard columns on every record table.
export const ddlFor = (typeKey) => {
  const t = RECORD_TYPES[typeKey];
  const cols = t.fields.map((f) => {
    const notNull = f.required ? ' not null' : '';
    return `  ${f.key} ${SQL_TYPES[f.type]}${notNull}`;
  });
  return `create table if not exists ${t.table} (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
${cols.join(',\n')},
  flagged boolean not null default false,
  flag_reason text,
  attrs jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists ${t.table}_ws_idx on ${t.table} (workspace_id) where deleted_at is null;`;
};

const ZOD_TYPES = {
  money:  () => z.number().int().nonnegative(),
  date:   () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  number: () => z.number(),
  person: () => z.uuid(),
  text:   () => z.string().max(4000),
  email:  () => z.string().email().max(320),
  phone:  () => z.string().max(40),
};

// zod schema for one record type's writable fields.
export const zodFor = (typeKey) => {
  const t = RECORD_TYPES[typeKey];
  const shape = {};
  for (const f of t.fields) {
    let s = f.type === 'select'
      ? z.enum(f.options)
      : ZOD_TYPES[f.type]();
    if (!f.required) s = s.nullish();
    shape[f.key] = s;
  }
  return z.object(shape);
};

export const recordTypeKeys = () => Object.keys(RECORD_TYPES);
