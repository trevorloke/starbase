// The promise tracker: the governing party's promises, each scored in
// public against delivery, with the record behind every score and a log of
// announcements. Edited in the website admin; read by the site as JSON.
export const sql = `
create table if not exists tracker_promises (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  number int not null,
  title text not null,
  specifics text not null default '',
  area text not null default '',
  sources jsonb not null default '[]',
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'kept', 'partly_kept', 'broken')),
  test_kept text,
  test_partly text,
  test_broken text,
  test_record text,
  status_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, number)
);

create table if not exists tracker_updates (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  promise_id uuid not null references tracker_promises(id) on delete cascade,
  date date not null,
  status text check (status in ('not_started', 'in_progress', 'kept', 'partly_kept', 'broken')),
  note text not null,
  url text,
  created_at timestamptz not null default now()
);
create index if not exists tracker_updates_promise_idx on tracker_updates (workspace_id, promise_id, date);

create table if not exists tracker_announcements (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  date date not null,
  date_label text not null default '',
  title text not null,
  commitments text not null default '',
  sources jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index if not exists tracker_announcements_ws_idx on tracker_announcements (workspace_id, date desc);
`;
