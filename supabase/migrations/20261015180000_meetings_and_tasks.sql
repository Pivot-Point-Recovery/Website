-- Meetings, their minutes, and the tasks that come out of them.
--
-- Google Meet stopped recording and taking notes for the team in June 2026,
-- when the Workspace account moved from Business Plus to the no-cost Google
-- Workspace for Nonprofits edition: that edition includes neither Meet
-- recordings nor transcripts nor Gemini notes. The Board Center now does the
-- job itself -- record in the browser (or upload a file, or paste a transcript
-- from Meet, Zoom or Tactiq), transcribe, have Claude draft the minutes, and
-- turn the action items into tasks somebody owns.
--
-- Three things live here:
--
--   meetings       one row per meeting: what it was, its recording, transcript
--                  and minutes
--   meeting_tasks  action items, from a meeting or added by hand
--   meeting-audio  a private Storage bucket for the recordings
--
-- What a meeting row may hold is a board or staff business meeting. It is not
-- a place for case reviews: anything that identifies a person we serve is
-- protected under 42 CFR Part 2 and stays out of this database, the same
-- boundary as intake_queue. The Board Center says so before anybody records,
-- and the drafting prompt replaces any participant it hears named with "a
-- participant" and flags the meeting.
--
-- Additive and idempotent, in the style of every migration before it.

-- ------------------------------------------------------------------ meetings

create table if not exists public.meetings (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  -- 'board' | 'committee' | 'staff' | 'other'
  kind              text not null default 'board',
  held_on           date not null,
  attendees         text,

  -- Whoever started the recording ticked "everyone here knows this is being
  -- recorded". Kept with the row so the answer to "did people know?" is not a
  -- matter of memory.
  consent_confirmed boolean not null default false,

  -- The recording, as a path inside the meeting-audio bucket. Never public.
  audio_path        text,
  audio_mime        text,
  audio_bytes       bigint,
  duration_seconds  integer,

  -- 'none' | 'processing' | 'completed' | 'error'
  transcript_status text not null default 'none',
  -- 'recording' (transcribed here) | 'pasted' (from Meet, Zoom, Tactiq...)
  transcript_source text,
  transcript_job_id text,
  -- [{ speaker, text, start, end }] -- start/end in milliseconds
  transcript        jsonb,
  transcript_text   text,
  transcript_error  text,
  -- { "A": "Steve", "B": "Geneva" } -- labels the transcriber gave each voice
  speaker_names     jsonb not null default '{}'::jsonb,

  -- 'none' | 'drafting' | 'draft' | 'approved' | 'error'
  minutes_status    text not null default 'none',
  minutes           jsonb,
  minutes_text      text,
  minutes_error     text,
  -- Action items Claude found, waiting for a person to confirm them as tasks.
  suggested_tasks   jsonb not null default '[]'::jsonb,
  suggestions_handled boolean not null default false,
  -- Claude thought somebody we serve was discussed. Shown on the meeting.
  mentions_participants boolean not null default false,
  -- How many times a draft has been asked for. A second try uses a faster
  -- setting, because the free plan stops a function after 150 seconds.
  draft_attempts    integer not null default 0,
  drafted_at        timestamptz,
  approved_at       timestamptz,
  approved_by       text,

  created_by        text default public.current_staff_email(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'meetings_kind_known' and conrelid = 'public.meetings'::regclass) then
    alter table public.meetings add constraint meetings_kind_known
      check (kind in ('board', 'committee', 'staff', 'other'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'meetings_transcript_status_known' and conrelid = 'public.meetings'::regclass) then
    alter table public.meetings add constraint meetings_transcript_status_known
      check (transcript_status in ('none', 'processing', 'completed', 'error'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'meetings_minutes_status_known' and conrelid = 'public.meetings'::regclass) then
    alter table public.meetings add constraint meetings_minutes_status_known
      check (minutes_status in ('none', 'drafting', 'draft', 'approved', 'error'));
  end if;
end;
$$;

create index if not exists meetings_held_on_idx on public.meetings (held_on desc);

drop trigger if exists meetings_touch_updated_at on public.meetings;
create trigger meetings_touch_updated_at
  before update on public.meetings
  for each row execute function public.touch_updated_at();

comment on table public.meetings is
  'Board and staff meetings: recording, transcript and minutes. Business meetings only -- nothing identifying a person we serve (42 CFR Part 2).';

-- ------------------------------------------------------- what a page may write

-- The transcript and Claude's draft are written by the meeting-minutes
-- function with the service role. The page writes what a person decides: the
-- title, who was there, the names of the voices, edits to the draft, and
-- approval. Enforced here because a rule kept only by the page is not kept.
--
-- Approved minutes are the organization's record of the meeting, so they are
-- frozen: only somebody with Manage access can reopen them. Scoped to the
-- browser's role, like protect_submission_content(), so a deliberate
-- correction from the SQL editor still works.
create or replace function public.meetings_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;

  new.transcript_status := old.transcript_status;
  new.transcript_source := old.transcript_source;
  new.transcript_job_id := old.transcript_job_id;
  new.transcript        := old.transcript;
  new.transcript_text   := old.transcript_text;
  new.transcript_error  := old.transcript_error;
  new.minutes           := old.minutes;
  new.minutes_error     := old.minutes_error;
  new.suggested_tasks   := old.suggested_tasks;
  new.mentions_participants := old.mentions_participants;
  new.draft_attempts    := old.draft_attempts;
  new.drafted_at        := old.drafted_at;
  new.created_by        := old.created_by;
  new.created_at        := old.created_at;

  if old.minutes_status = 'approved' then
    if new.minutes_status = 'approved' then
      -- Frozen: the text and the approval stay exactly as approved.
      new.minutes_text := old.minutes_text;
      new.approved_at  := old.approved_at;
      new.approved_by  := old.approved_by;
    elsif new.minutes_status = 'draft' and public.has_role('admin') then
      new.approved_at := null;
      new.approved_by := null;
    else
      raise exception 'These minutes are approved, so they cannot be changed. Somebody with Manage access can reopen them.'
        using errcode = '42501';
    end if;
  elsif new.minutes_status = 'approved' then
    if old.minutes_status <> 'draft' then
      raise exception 'Only a draft can be approved.' using errcode = 'P0001';
    end if;
    new.approved_at := now();
    new.approved_by := public.current_staff_email();
  elsif new.minutes_status is distinct from old.minutes_status then
    -- drafting / draft / error are the function's to set.
    new.minutes_status := old.minutes_status;
  end if;

  return new;
end;
$$;

drop trigger if exists meetings_guard on public.meetings;
create trigger meetings_guard
  before update on public.meetings
  for each row execute function public.meetings_guard();

-- ------------------------------------------------------------------- tasks

create table if not exists public.meeting_tasks (
  id             uuid primary key default gen_random_uuid(),
  -- A task outlives the meeting it came from: deleting the meeting keeps it.
  meeting_id     uuid references public.meetings (id) on delete set null,
  title          text not null,
  detail         text,
  assignee_email text,
  due_on         date,
  -- 'open' | 'done'
  status         text not null default 'open',
  completed_at   timestamptz,
  completed_by   text,
  -- 'minutes' (confirmed from a meeting's action items) | 'manual'
  source         text not null default 'manual',
  created_by     text default public.current_staff_email(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'meeting_tasks_status_known' and conrelid = 'public.meeting_tasks'::regclass) then
    alter table public.meeting_tasks add constraint meeting_tasks_status_known
      check (status in ('open', 'done'));
  end if;
end;
$$;

create index if not exists meeting_tasks_open_idx
  on public.meeting_tasks (lower(assignee_email), due_on) where status = 'open';
create index if not exists meeting_tasks_meeting_idx on public.meeting_tasks (meeting_id);

drop trigger if exists meeting_tasks_touch_updated_at on public.meeting_tasks;
create trigger meeting_tasks_touch_updated_at
  before update on public.meeting_tasks
  for each row execute function public.touch_updated_at();

-- Who finished it, and when, is recorded by the database rather than taken
-- from the page.
create or replace function public.meeting_tasks_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.completed_at := now();
    new.completed_by := public.current_staff_email();
  elsif new.status = 'open' then
    new.completed_at := null;
    new.completed_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists meeting_tasks_stamp on public.meeting_tasks;
create trigger meeting_tasks_stamp
  before insert or update on public.meeting_tasks
  for each row execute function public.meeting_tasks_stamp();

-- ------------------------------------------------------------------ access

-- The same flat model as the rest of the Board Center: anyone on the team
-- reads and works meetings and tasks. Deleting a meeting whose minutes were
-- approved takes Manage access, because those minutes are the record.
revoke all on public.meetings      from anon;
revoke all on public.meeting_tasks from anon;
grant select, insert, update, delete on public.meetings      to authenticated;
grant select, insert, update, delete on public.meeting_tasks to authenticated;

alter table public.meetings      enable row level security;
alter table public.meeting_tasks enable row level security;

drop policy if exists meetings_member_read on public.meetings;
create policy meetings_member_read on public.meetings
  for select to authenticated using (public.is_member());

drop policy if exists meetings_member_insert on public.meetings;
create policy meetings_member_insert on public.meetings
  for insert to authenticated with check (public.is_member());

drop policy if exists meetings_member_update on public.meetings;
create policy meetings_member_update on public.meetings
  for update to authenticated
  using (public.is_member()) with check (public.is_member());

drop policy if exists meetings_member_delete on public.meetings;
create policy meetings_member_delete on public.meetings
  for delete to authenticated
  using (public.is_member() and (minutes_status <> 'approved' or public.has_role('admin')));

drop policy if exists tasks_member_all on public.meeting_tasks;
create policy tasks_member_all on public.meeting_tasks
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

-- ------------------------------------------------------------- recordings

-- Private. A recording is reached through a signed link that lasts minutes,
-- and only by somebody on the team. 50 MB is the project's default per-file
-- cap and comfortably holds a three-hour meeting at the bitrate /admin
-- records at (about 15 MB an hour).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meeting-audio', 'meeting-audio', false, 52428800,
        array['audio/*', 'video/webm', 'video/mp4', 'video/quicktime'])
on conflict (id) do update
   set public             = false,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists meeting_audio_member_read on storage.objects;
create policy meeting_audio_member_read on storage.objects
  for select to authenticated
  using (bucket_id = 'meeting-audio' and public.is_member());

drop policy if exists meeting_audio_member_insert on storage.objects;
create policy meeting_audio_member_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'meeting-audio' and public.is_member());

drop policy if exists meeting_audio_member_delete on storage.objects;
create policy meeting_audio_member_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'meeting-audio' and public.is_member());
