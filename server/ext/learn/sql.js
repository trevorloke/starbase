// ImagineU — the campaign's training: sections of lessons (a note, a
// document, a video, audio, a picture, contacts, a procedure), the files
// behind them, and who has done which.
export const sql = `
create table if not exists learn_sections (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  note text,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists learn_sections_ws_idx on learn_sections (workspace_id, position) where deleted_at is null;

create table if not exists learn_assets (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  content_type text not null,
  bytes int not null,
  data bytea not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists learn_assets_ws_idx on learn_assets (workspace_id, created_at);

create table if not exists learn_lessons (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  section_id uuid references learn_sections(id) on delete set null,
  title text not null,
  kind text not null check (kind in ('note', 'document', 'video', 'audio', 'picture', 'contacts', 'procedure')),
  body text not null default '',
  link text,
  asset_id uuid references learn_assets(id) on delete set null,
  audience text not null default 'everyone' check (audience in ('everyone', 'desk', 'public')),
  published boolean not null default true,
  position int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists learn_lessons_ws_idx on learn_lessons (workspace_id, section_id, position) where deleted_at is null;

create table if not exists learn_done (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  lesson_id uuid not null references learn_lessons(id) on delete cascade,
  done_at timestamptz not null default now(),
  primary key (workspace_id, user_id, lesson_id)
);
`;
