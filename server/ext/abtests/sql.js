// A/B subject lines + open and click tracking for newsletters and press
// releases. Columns on the core blasts / blast_recipients tables, plus the
// links each send carries (the only places a click may redirect to).
//
// blasts.ab_status: null (no test) · 'saved' (email wasn't connected: nothing
// went out; the test starts on Start test) · 'testing' (A and B sent, the
// rest wait for the winner) · 'decided' (winner picked, the rest sent with it).
// blasts.ab_result: what the winner was picked on — { metric, tie, a, b }
// with each group's { delivered, opened, clicked } at that moment.
// blast_recipients.ab_group: 'a' · 'b' · 'rest' (null on a send with no test).
// A 'rest' row is held — never sent — until the blast has a winner.
//
// blast_recipients.status gains 'sending': handed to the email service, its
// answer not recorded (committed before the call, so a crash or a retry never
// emails that person again by itself). sending_at is when; send_tries counts
// the service's refusals, part of each send's idempotency key (send.js).
// sent_at: when the service took it (a click seconds later is a scanner).
// send_asked_at: a person asked for this row to go now (Send, Send now, Try
// again) and no run has claimed it yet — a send job takes it from here, so
// the rest of a big list, or a send the server stopped in, goes on by itself.
// open_logged_at / click_logged_at: the first open / click is on the event
// log (track.js writes the hit without the campaign lock; a job logs it).
export const sql = `
alter table blasts add column if not exists ab_subject_b text;
alter table blasts add column if not exists ab_pct int;
alter table blasts add column if not exists ab_wait_hours int;
alter table blasts add column if not exists ab_metric text check (ab_metric in ('opens', 'clicks'));
alter table blasts add column if not exists ab_status text check (ab_status in ('saved', 'testing', 'decided'));
alter table blasts add column if not exists ab_started_at timestamptz;
alter table blasts add column if not exists ab_decide_at timestamptz;
alter table blasts add column if not exists ab_winner text check (ab_winner in ('a', 'b'));
alter table blasts add column if not exists ab_decided_at timestamptz;
alter table blasts add column if not exists ab_result jsonb;

alter table blast_recipients add column if not exists token text;
alter table blast_recipients add column if not exists ab_group text check (ab_group in ('a', 'b', 'rest'));
alter table blast_recipients add column if not exists opens int not null default 0;
alter table blast_recipients add column if not exists first_open_at timestamptz;
alter table blast_recipients add column if not exists last_open_at timestamptz;
alter table blast_recipients add column if not exists clicks int not null default 0;
alter table blast_recipients add column if not exists first_click_at timestamptz;
alter table blast_recipients add column if not exists last_click_at timestamptz;
alter table blast_recipients add column if not exists first_click_n int;
alter table blast_recipients add column if not exists sent_at timestamptz;
alter table blast_recipients add column if not exists sending_at timestamptz;
alter table blast_recipients add column if not exists send_tries int not null default 0;
alter table blast_recipients add column if not exists send_asked_at timestamptz;
create index if not exists brecip_asked_idx on blast_recipients (blast_id) where send_asked_at is not null;
create unique index if not exists brecip_token_idx on blast_recipients (token) where token is not null;

-- Rows from before 'sending' existed carry the core check.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'brecip_status_ok') then
    alter table blast_recipients drop constraint if exists blast_recipients_status_check;
    alter table blast_recipients add constraint brecip_status_ok
      check (status in ('queued', 'sending', 'sent', 'failed'));
  end if;
end $$;

-- Opens and clicks recorded before they were logged by the job were logged
-- as they happened: mark them, once, when the columns arrive.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_name = 'blast_recipients' and column_name = 'open_logged_at') then
    alter table blast_recipients add column open_logged_at timestamptz;
    alter table blast_recipients add column click_logged_at timestamptz;
    update blast_recipients set open_logged_at = first_open_at where first_open_at is not null;
    update blast_recipients set click_logged_at = first_click_at where first_click_at is not null;
  end if;
end $$;
create index if not exists brecip_unlogged_idx on blast_recipients (workspace_id)
  where (first_open_at is not null and open_logged_at is null) or (first_click_at is not null and click_logged_at is null);

create table if not exists blast_links (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  blast_id uuid not null references blasts(id) on delete cascade,
  n int not null,
  url text not null,
  primary key (blast_id, n)
);

-- Files that go with a send (attach.js). Uploaded first, on their own
-- (blast_id null, the uploader's), then bound to the send on Send; an
-- upload never bound is swept after a day.
create table if not exists blast_attachments (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  blast_id uuid references blasts(id) on delete cascade,
  filename text not null,
  content_type text not null,
  bytes int not null,
  data bytea not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists blast_attachments_blast_idx on blast_attachments (blast_id);
`;
