// Relationship tables. Idempotent: run at every boot after the core schema
// (under test:pg every test file boots against the same database).
//
//   relationships   one row per "A knows B": undirected, so the pair is kept
//                   in order (person_a < person_b) and a live pair is unique —
//                   adding it again, either way round, is the same link. id
//                   may be made on the phone (the offline outbox): a replay is
//                   the same link. kind is one of KINDS (actions.js); note is
//                   a short line. brought_in names the person this link
//                   brought into the campaign (added new through the other's
//                   circle) — kept when the link is removed, so "Brought in
//                   by" stays true. from_person: whose circle it was added
//                   from. removed_at: taken off (the row stays, so a late
//                   replay of the add is still recognised). The Imagine
//                   Surrey sample's links are recorded by id with the rest
//                   of the sample (routes/data.js), and cleared with it.
//
// contacts.channel also takes 'in_person' — a talk with someone you know,
// away from their door (My people). The core table's check is widened here.
export const sql = `
create table if not exists relationships (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_a uuid not null references persons(id) on delete cascade,
  person_b uuid not null references persons(id) on delete cascade,
  kind text not null default 'other' check (kind in ('family', 'friend', 'neighbour', 'work', 'community', 'other')),
  note text,
  brought_in uuid,
  from_person uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references users(id),
  check (person_a < person_b)
);
create unique index if not exists relationships_pair_idx on relationships (workspace_id, person_a, person_b) where removed_at is null;
create index if not exists relationships_a_idx on relationships (workspace_id, person_a) where removed_at is null;
create index if not exists relationships_b_idx on relationships (workspace_id, person_b) where removed_at is null;
create index if not exists relationships_in_idx on relationships (workspace_id, brought_in) where brought_in is not null;
-- A profile's "May be the same person as …" (actions.js: a volunteer's new
-- person whose email or name someone on the list already has).
create index if not exists persons_same_as_idx on persons (workspace_id, (attrs->>'maybe_same_as')) where attrs ? 'maybe_same_as';

do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'contacts'::regclass and conname = 'contacts_channel_check'
             and pg_get_constraintdef(oid) not like '%in_person%') then
    alter table contacts drop constraint contacts_channel_check;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'contacts'::regclass and conname = 'contacts_channel_check') then
    alter table contacts add constraint contacts_channel_check check (channel in ('door', 'phone', 'text', 'in_person'));
  end if;
end $$;
`;
