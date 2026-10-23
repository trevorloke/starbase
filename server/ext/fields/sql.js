// Profile field tables. Idempotent: run at every boot after the core schema
// (under test:pg every test file boots against the same database).
//
//   person_fields        one per field the campaign tracks: its name, kind
//                        (kinds.js), choices (Pick one), the order on the
//                        profile, whether volunteers see it (off unless a
//                        manager turns it on), and retired_at — a field taken
//                        off stops showing but keeps every value
//   person_field_values  one row per person per field: the value as stored
//                        (kinds.js), who set it and when. Its history is the
//                        event log (every change carries what it was).
//
// Why a table of values and not a jsonb column on persons: a value is a row
// of its own with who and when; "filled in for 12 people" and "Language at
// home: Punjabi" are indexed lookups; a field taken off or changed to Text
// touches its own rows only, never every person; and a person's core row
// (and its events) stays exactly as it was.
//
// sample marks what the sample campaign made, so clearing it removes exactly
// that (a value you change stops being sample).
export const sql = `
create table if not exists person_fields (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('text', 'yesno', 'choice', 'number', 'date')),
  choices jsonb not null default '[]',
  volunteers boolean not null default false,
  position int not null default 0,
  retired_at timestamptz,
  sample boolean not null default false,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists person_fields_ws_idx on person_fields (workspace_id, position);

create table if not exists person_field_values (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  field_id uuid not null references person_fields(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  value jsonb not null,
  sample boolean not null default false,
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (field_id, person_id)
);
create index if not exists person_field_values_find_idx on person_field_values (workspace_id, field_id, value);
create index if not exists person_field_values_person_idx on person_field_values (workspace_id, person_id);
`;
