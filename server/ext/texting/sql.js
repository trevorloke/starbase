// Texting tables. Idempotent DDL, run at boot after the core schema.
//
//   texting_conversations  one per (person, member who started it, number);
//                          started_by null = they texted the campaign first
//                          (desk only)
//   texting_messages       every text in and out, with what the provider said
//   texting_optouts        STOP / START per number — the app never texts an
//                          opted-out number, whatever its tags say; tagged:
//                          the people its STOP tagged do-not-text (START takes
//                          the tag off them only, never one the desk set)
//   texting_reads          when each member last read a conversation (unread)
//   texting_settings       the first-text template and the hours texts may go
//                          (Monday–Friday, and Saturday–Sunday)
//   texting_member_phones  a caller's own phone for "Call through the
//                          campaign" — seen only by them and managers, never
//                          written to the event log
//   texting_calls          click-to-call: a single-use, short-lived token per
//                          call (only its hash is stored) and what happened
export const sql = `
create table if not exists texting_conversations (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,
  phone text not null,
  started_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_at timestamptz not null default now()
);
create index if not exists texting_conv_ws_idx on texting_conversations (workspace_id, last_at desc);
create index if not exists texting_conv_mine_idx on texting_conversations (workspace_id, started_by, last_at desc);
create index if not exists texting_conv_phone_idx on texting_conversations (phone);
create index if not exists texting_conv_person_idx on texting_conversations (workspace_id, person_id);

create table if not exists texting_messages (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  conversation_id uuid not null references texting_conversations(id) on delete cascade,
  direction text not null check (direction in ('out', 'in')),
  phone text not null,
  body text not null,
  status text not null check (status in ('sent', 'delivered', 'undelivered', 'failed', 'received')),
  first boolean not null default false,
  keyword text,
  provider_sid text,
  error text,
  sent_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists texting_msg_conv_idx on texting_messages (conversation_id, created_at);
create index if not exists texting_msg_phone_idx on texting_messages (phone, direction, created_at desc);
create index if not exists texting_conv_ws_phone_idx on texting_conversations (workspace_id, phone, last_at desc);
create index if not exists texting_msg_sender_idx on texting_messages (workspace_id, sent_by, created_at desc);
create unique index if not exists texting_msg_sid_idx on texting_messages (workspace_id, provider_sid) where provider_sid is not null;

create table if not exists texting_optouts (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  phone text not null,
  opted_out boolean not null default true,
  keyword text,
  changed_at timestamptz not null default now(),
  unique (workspace_id, phone)
);
alter table texting_optouts add column if not exists tagged jsonb not null default '[]'::jsonb;

create table if not exists texting_reads (
  conversation_id uuid not null references texting_conversations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists texting_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  template text,
  allow_from int not null default 9 check (allow_from between 0 and 23),
  allow_until int not null default 21 check (allow_until between 1 and 24),
  updated_at timestamptz not null default now()
);
alter table texting_settings add column if not exists weekend_from int not null default 10 check (weekend_from between 0 and 23);
alter table texting_settings add column if not exists weekend_until int not null default 18 check (weekend_until between 1 and 24);

create table if not exists texting_member_phones (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  phone text not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists texting_calls (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  to_phone text not null,
  caller_phone text not null,
  token_hash text not null unique,
  token_expires_at timestamptz not null,
  token_used_at timestamptz,
  provider_sid text,
  status text not null check (status in ('calling_you', 'connecting', 'talked', 'no_answer', 'missed', 'failed', 'ended')),
  talk_s int,
  call_s int,
  error text,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists texting_calls_user_idx on texting_calls (workspace_id, user_id, created_at desc);
`;
