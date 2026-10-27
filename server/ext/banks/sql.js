// Phone banks: a named list of numbers to call, each handed to one caller,
// crossed off as the call is logged.
export const sql = `
create table if not exists call_banks (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  script text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  deleted_at timestamptz
);
create index if not exists call_banks_ws_idx on call_banks (workspace_id) where deleted_at is null;

create table if not exists call_bank_numbers (
  bank_id uuid not null references call_banks(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  position int not null default 0,
  assigned_to uuid references users(id) on delete set null,
  assigned_at timestamptz,
  done_at timestamptz,
  done_by uuid references users(id) on delete set null,
  outcome text,
  primary key (bank_id, person_id)
);
create index if not exists call_bank_numbers_assignee_idx on call_bank_numbers (workspace_id, assigned_to) where done_at is null;
`;
