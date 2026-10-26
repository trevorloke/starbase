// Teams (groups of members: a neighbourhood crew, the phone bank, the sign
// crew) and each member's own permissions (lib/perms.js).
export const sql = `
alter table memberships add column if not exists permissions jsonb not null default '{}';

create table if not exists teams (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  note text,
  lead_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists teams_ws_idx on teams (workspace_id) where deleted_at is null;

create table if not exists team_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index if not exists team_members_user_idx on team_members (workspace_id, user_id);
`;
