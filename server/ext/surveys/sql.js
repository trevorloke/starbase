// Survey tables. Idempotent: run at every boot after the core schema (under
// test:pg every test file boots against the same database).
//
//   surveys            one per survey: name, where it is asked (door · calls ·
//                      both), optionally only inside some turfs, on/off, and
//                      archived_at (archived surveys keep every answer)
//   survey_questions   ordered questions; kind is one of KINDS (answers.js);
//                      options are the choice labels; retired_options keeps
//                      labels taken off a question so a knock saved offline
//                      before the edit still lands; removed_at hides a
//                      question without losing its answers
//   survey_responses   one row per answer, tied to the contact it came with
export const sql = `
create table if not exists surveys (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  context text not null default 'both' check (context in ('door', 'calls', 'both')),
  turf_ids jsonb not null default '[]',
  active boolean not null default true,
  archived_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists surveys_ws_idx on surveys (workspace_id, created_at);

create table if not exists survey_questions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  survey_id uuid not null references surveys(id) on delete cascade,
  position int not null default 0,
  kind text not null check (kind in ('choice', 'choices', 'yesno', 'scale', 'text')),
  text text not null,
  options jsonb not null default '[]',
  retired_options jsonb not null default '[]',
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists survey_questions_survey_idx on survey_questions (workspace_id, survey_id, position);

create table if not exists survey_responses (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  survey_id uuid not null references surveys(id) on delete cascade,
  question_id uuid not null references survey_questions(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  value jsonb not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists survey_responses_survey_idx on survey_responses (workspace_id, survey_id, person_id, question_id, created_at);
create index if not exists survey_responses_person_idx on survey_responses (workspace_id, person_id, created_at);
`;
