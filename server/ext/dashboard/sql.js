// Where each person in the field is (field.ping): their latest position,
// and the trail of the last day. Only while they share it (the switch on
// the map); turning it off deletes the position.
export const sql = `
create table if not exists field_positions (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  accuracy double precision,
  at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create table if not exists field_tracks (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  at timestamptz not null default now()
);
create index if not exists field_tracks_ws_user_at_idx on field_tracks (workspace_id, user_id, at);
`;
