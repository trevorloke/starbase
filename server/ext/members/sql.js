// Members of the organization (the website's join form). A membership runs
// a year from when it starts; a renewal starts when the current one ends.
// The fee, where there is one, is a contribution under BC law: it goes
// through a pledge like any gift (the donate flow's record), and the
// membership turns active when that pledge is paid or received.
export const sql = `
create table if not exists members (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'active', 'expired', 'cancelled')),
  fee_cents int not null default 0,
  voting_eligible boolean not null default true,
  starts_at timestamptz,
  expires_at timestamptz,
  pledge_id uuid,
  details jsonb not null default '{}',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists members_ws_person_idx on members (workspace_id, person_id);
create index if not exists members_ws_status_idx on members (workspace_id, status, expires_at);
create index if not exists members_pledge_idx on members (pledge_id);
`;
