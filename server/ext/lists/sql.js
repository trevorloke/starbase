// Lists of people. A saved filter (kind 'filter') is People's own query,
// kept — tag, rating band, role, has — and names whoever matches it today.
// A hand-picked list (kind 'people') is the people put on it. Either is an
// audience for an email or text blast, a report, or a CSV.
export const sql = `
create table if not exists lists (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('filter', 'people')),
  filter jsonb not null default '{}',
  note text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists lists_ws_idx on lists (workspace_id) where deleted_at is null;

create table if not exists list_members (
  list_id uuid not null references lists(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (list_id, person_id)
);
create index if not exists list_members_person_idx on list_members (workspace_id, person_id);
`;
