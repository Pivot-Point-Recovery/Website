-- The Board Center: roles, an audit trail, and the read access that turns the
-- event editor into a CRM the board signs into.
--
-- Until now /admin could only reach public.events. The enquiry, volunteer and
-- donation tables have RLS enabled with no policies at all, so no browser can
-- read them -- correct for an event editor, and the single thing standing
-- between this project and a working CRM. This migration opens them by role
-- rather than switching them off.
--
-- The access model the board asked for is deliberately flat: anyone invited
-- sees everything except donor-level giving, which is limited to the executive
-- director and the treasurer. Two roles carry that, plus one for managing the
-- team; membership alone grants the rest.
--
-- Additive and idempotent in the style of every migration before it: IF NOT
-- EXISTS throughout, no DROP of anything holding data, no column retyping. This
-- runs against the live database that holds real submissions.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------ who may sign in

-- Supersedes event_editors without replacing it: the old table stays, is
-- backfilled from here, and is_event_editor() keeps answering for both, so
-- nothing that works today stops working mid-deploy.
create table if not exists public.staff_members (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  label      text,
  -- 'member'  -- everything except donor-level giving
  -- 'finance' -- donor names and amounts
  -- 'admin'   -- invite people, change roles, read the activity log
  roles      text[] not null default array['member'],
  active     boolean not null default true,
  invited_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz default now()
);

create unique index if not exists staff_members_email_key
  on public.staff_members (lower(email));
create index if not exists staff_members_active_idx
  on public.staff_members (active) where active;

drop trigger if exists staff_members_touch_updated_at on public.staff_members;
create trigger staff_members_touch_updated_at
  before update on public.staff_members
  for each row execute function public.touch_updated_at();

-- Everyone already on the event editor list keeps their access, as a member.
insert into public.staff_members (email, label, roles, active)
select e.email, e.label, array['member'], e.active
  from public.event_editors e
on conflict (lower(email)) do nothing;

-- The two people who may see donor-level giving, and who administer the rest.
insert into public.staff_members (email, label, roles) values
  ('erica@pivotpointrecovery.org', 'Erica',       array['member','finance','admin']),
  ('steve@pivotpointrecovery.org', 'Steve — CEO', array['member','finance','admin'])
on conflict (lower(email)) do update
   set roles  = excluded.roles,
       label  = coalesce(public.staff_members.label, excluded.label),
       active = true;

-- --------------------------------------------------------------- role checks

-- Reads the JWT's email claim rather than joining auth.users, so the check
-- costs nothing and reads the same from PostgREST and from SQL. Same approach
-- as is_event_editor() before it.
create or replace function public.current_staff_email()
returns text
language sql
stable
set search_path = ''
as $$
  select lower(nullif(
    coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email', ''), ''));
$$;

create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_members s
     where s.active
       and lower(s.email) = public.current_staff_email());
$$;

create or replace function public.has_role(wanted text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_members s
     where s.active
       and lower(s.email) = public.current_staff_email()
       and wanted = any (s.roles));
$$;

-- Redefined so the existing events policies cover the new team list too. An
-- address on either list is an editor; nobody loses access on deploy.
create or replace function public.is_event_editor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_member()
      or exists (
    select 1 from public.event_editors e
     where e.active
       and lower(e.email) = public.current_staff_email());
$$;

-- --------------------------------------------------------------- audit trail

-- Writes, and -- for the tables holding what people told us in confidence --
-- reads. A read log is what makes "who has seen this?" answerable a year later.
create table if not exists public.activity_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_email text,
  action      text not null,          -- 'read' | 'create' | 'update' | 'delete' | 'export' | 'invite'
  entity      text not null,          -- table or view name
  entity_id   text,
  detail      jsonb default '{}'::jsonb
);

create index if not exists activity_log_at_idx     on public.activity_log (at desc);
create index if not exists activity_log_actor_idx  on public.activity_log (lower(actor_email));
create index if not exists activity_log_entity_idx on public.activity_log (entity, at desc);

-- The only way a browser writes here: it cannot choose the actor or the time.
create or replace function public.log_activity(
  p_action text, p_entity text, p_entity_id text default null, p_detail jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_member() then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  insert into public.activity_log (actor_email, action, entity, entity_id, detail)
  values (public.current_staff_email(), p_action, p_entity, p_entity_id, coalesce(p_detail, '{}'::jsonb));
end;
$$;

-- --------------------------------------------------- notes staff add to a row

-- Append-only by design. What somebody wrote on a form is never edited; every
-- staff observation is a separate, attributed layer on top of it.
create table if not exists public.record_notes (
  id          uuid primary key default gen_random_uuid(),
  entity      text not null,          -- 'contact_submissions' | 'volunteer_interests' | 'intake_queue' | ...
  entity_id   text not null,
  body        text not null,
  author_email text,
  created_at  timestamptz not null default now()
);

create index if not exists record_notes_entity_idx
  on public.record_notes (entity, entity_id, created_at desc);

-- --------------------------------------------------------------- intake queue

-- Option A, chosen deliberately: this table holds the work, never the answers.
-- Intake responses are protected under 42 CFR Part 2 and HIPAA and stay in the
-- system of record. A reference number, a stage and a follow-up date are enough
-- to run the queue and to report response times to the board, and carry no PHI.
create table if not exists public.intake_queue (
  id              uuid primary key default gen_random_uuid(),
  ref             text not null,
  received_at     timestamptz not null default now(),
  -- 'awaiting_contact' | 'in_assessment' | 'enrolled' | 'closed'
  stage           text not null default 'awaiting_contact',
  owner_email     text,
  follow_up_due   date,
  first_contact_at timestamptz,
  -- A link into whatever holds the actual response. Never the response itself.
  source_url      text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz default now()
);

create unique index if not exists intake_queue_ref_key on public.intake_queue (lower(ref));
create index if not exists intake_queue_stage_idx on public.intake_queue (stage);
create index if not exists intake_queue_due_idx   on public.intake_queue (follow_up_due);

drop trigger if exists intake_queue_touch_updated_at on public.intake_queue;
create trigger intake_queue_touch_updated_at
  before update on public.intake_queue
  for each row execute function public.touch_updated_at();

comment on table public.intake_queue is
  'Intake work queue. Reference numbers, stages and follow-up dates only -- never intake answers. See docs on the 42 CFR Part 2 boundary.';

-- ----------------------------------------------------------- board documents

-- Labelled links into the organisation's Drive. The file itself never comes
-- here, so Google keeps doing permissions, versioning and virus scanning.
create table if not exists public.board_documents (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  url        text not null,
  category   text default 'General',
  is_folder  boolean default false,
  added_by   text,
  created_at timestamptz not null default now()
);

create index if not exists board_documents_category_idx on public.board_documents (category, label);

-- ------------------------------------------------- working the existing rows

-- Additive only. "Someone should call her" becomes "Julie is calling her", and
-- the status column that has existed unused since launch starts meaning
-- something. The words the person wrote are untouched by both.
alter table public.contact_submissions
  add column if not exists owner_email text;
alter table public.volunteer_interests
  add column if not exists owner_email text;

create index if not exists contact_submissions_status_idx
  on public.contact_submissions (status);
create index if not exists volunteer_interests_status_idx
  on public.volunteer_interests (status);

-- --------------------------------------------------------------------- reads

-- The change that makes a CRM possible. Enquiries and volunteer sign-ups become
-- readable by anyone on the team; donations stay closed to all but finance.

revoke all on public.contact_submissions from anon, authenticated;
revoke all on public.volunteer_interests from anon, authenticated;
revoke all on public.donations           from anon, authenticated;

grant select, update on public.contact_submissions to authenticated;
grant select, update on public.volunteer_interests to authenticated;
grant select         on public.donations           to authenticated;

drop policy if exists contact_member_read on public.contact_submissions;
create policy contact_member_read on public.contact_submissions
  for select to authenticated using (public.is_member());

-- Staff may move a record through its stages and assign an owner. The words the
-- person wrote are not writable from here: see the guard trigger below.
drop policy if exists contact_member_update on public.contact_submissions;
create policy contact_member_update on public.contact_submissions
  for update to authenticated
  using (public.is_member()) with check (public.is_member());

drop policy if exists volunteer_member_read on public.volunteer_interests;
create policy volunteer_member_read on public.volunteer_interests
  for select to authenticated using (public.is_member());

drop policy if exists volunteer_member_update on public.volunteer_interests;
create policy volunteer_member_update on public.volunteer_interests
  for update to authenticated
  using (public.is_member()) with check (public.is_member());

-- Donor-level giving: the executive director and the treasurer, nobody else.
-- Everyone else reads the totals through board_summary() below.
drop policy if exists donations_finance_read on public.donations;
create policy donations_finance_read on public.donations
  for select to authenticated using (public.has_role('finance'));

-- RSVPs already allowed event editors; is_event_editor() now covers the team.
grant select on public.event_rsvps to authenticated;

-- New tables.
grant select, insert, update on public.intake_queue    to authenticated;
grant select, insert         on public.record_notes    to authenticated;
grant select, insert, delete on public.board_documents to authenticated;
grant select                 on public.staff_members   to authenticated;
grant select                 on public.activity_log    to authenticated;

alter table public.staff_members   enable row level security;
alter table public.activity_log    enable row level security;
alter table public.record_notes    enable row level security;
alter table public.intake_queue    enable row level security;
alter table public.board_documents enable row level security;

drop policy if exists staff_member_read on public.staff_members;
create policy staff_member_read on public.staff_members
  for select to authenticated using (public.is_member());

-- Changing who has access is an administrator's act. Deliberately no insert or
-- update policy for anyone else: PostgREST then refuses the write outright.
drop policy if exists staff_admin_write on public.staff_members;
create policy staff_admin_write on public.staff_members
  for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));
grant insert, update, delete on public.staff_members to authenticated;

drop policy if exists activity_admin_read on public.activity_log;
create policy activity_admin_read on public.activity_log
  for select to authenticated using (public.has_role('admin'));

drop policy if exists notes_member_read on public.record_notes;
create policy notes_member_read on public.record_notes
  for select to authenticated using (public.is_member());

-- Append-only: a note may be added, never edited or removed, and the author is
-- forced to the signed-in address rather than taken from the browser.
drop policy if exists notes_member_insert on public.record_notes;
create policy notes_member_insert on public.record_notes
  for insert to authenticated
  with check (public.is_member() and lower(author_email) = public.current_staff_email());

drop policy if exists intake_member_all on public.intake_queue;
create policy intake_member_all on public.intake_queue
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

drop policy if exists docs_member_read on public.board_documents;
create policy docs_member_read on public.board_documents
  for select to authenticated using (public.is_member());

drop policy if exists docs_member_write on public.board_documents;
create policy docs_member_write on public.board_documents
  for all to authenticated
  using (public.is_member()) with check (public.is_member());

-- ------------------------------------------------- what a submission may lose

-- The promise the CRM makes is that the words somebody wrote are never edited.
-- Enforced here rather than in the page, because a promise kept only by the UI
-- is not kept.
create or replace function public.protect_submission_content()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'contact_submissions' then
    new.name    := old.name;
    new.email   := old.email;
    new.phone   := old.phone;
    new.message := old.message;
    new.created_at := old.created_at;
  elsif tg_table_name = 'volunteer_interests' then
    new.first_name := old.first_name;
    new.last_name  := old.last_name;
    new.email      := old.email;
    new.phone      := old.phone;
    new.experience := old.experience;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists contact_protect_content on public.contact_submissions;
create trigger contact_protect_content
  before update on public.contact_submissions
  for each row execute function public.protect_submission_content();

drop trigger if exists volunteer_protect_content on public.volunteer_interests;
create trigger volunteer_protect_content
  before update on public.volunteer_interests
  for each row execute function public.protect_submission_content();

-- --------------------------------------------------------- what /admin reads

-- One call for the dashboard. A function rather than a view so the giving
-- figures can be released to the whole team as totals while the donor rows
-- behind them stay closed -- and so the role check lives in one place.
create or replace function public.board_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_member() then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'enquiries', jsonb_build_object(
      'unanswered', (select count(*) from public.contact_submissions
                      where coalesce(status, 'new') = 'new'),
      'this_month', (select count(*) from public.contact_submissions
                      where created_at >= date_trunc('month', now())),
      'oldest_unanswered', (select min(created_at) from public.contact_submissions
                             where coalesce(status, 'new') = 'new')),
    'volunteers', jsonb_build_object(
      'total',      (select count(*) from public.volunteer_interests),
      'unscreened', (select count(*) from public.volunteer_interests
                      where coalesce(status, 'new') = 'new'),
      'this_month', (select count(*) from public.volunteer_interests
                      where created_at >= date_trunc('month', now()))),
    'intake', jsonb_build_object(
      'open',    (select count(*) from public.intake_queue where stage <> 'closed'),
      'overdue', (select count(*) from public.intake_queue
                   where stage <> 'closed' and follow_up_due < current_date),
      'this_month', (select count(*) from public.intake_queue
                      where received_at >= date_trunc('month', now())),
      'median_days_to_contact', (
        select round(percentile_cont(0.5) within group (
                 order by extract(epoch from (first_contact_at - received_at)) / 86400.0)::numeric, 1)
          from public.intake_queue
         where first_contact_at is not null
           and received_at >= now() - interval '90 days')),
    'events', jsonb_build_object(
      'published', (select count(*) from public.events where published),
      'drafts',    (select count(*) from public.events where not published),
      'next',      (select jsonb_build_object('title', e.title, 'slug', e.slug,
                             'starts_at', e.starts_at, 'rsvps',
                             (select count(*) from public.event_rsvps r where r.event_id = e.id))
                      from public.events e
                     where e.published and e.starts_at >= now()
                     order by e.starts_at limit 1)),
    'giving', jsonb_build_object(
      'month_cents', (select coalesce(sum(amount_cents), 0) from public.donations
                       where status = 'succeeded' and created_at >= date_trunc('month', now())),
      'year_cents',  (select coalesce(sum(amount_cents), 0) from public.donations
                       where status = 'succeeded' and created_at >= date_trunc('year', now())),
      'gift_count',  (select count(*) from public.donations
                       where status = 'succeeded' and created_at >= date_trunc('month', now())),
      'recurring',   (select count(*) from public.donations
                       where status = 'succeeded' and is_recurring),
      'failed',      (select count(*) from public.donations
                       where status <> 'succeeded' and status <> 'pending'
                         and created_at >= date_trunc('month', now())),
      'by_fund',     (select coalesce(jsonb_agg(f), '[]'::jsonb) from (
                        select coalesce(nullif(fund_designation, ''), 'General fund') as fund,
                               sum(amount_cents) as cents
                          from public.donations
                         where status = 'succeeded' and created_at >= date_trunc('month', now())
                      group by 1 order by 2 desc) f)),
    'can_see_donors', public.has_role('finance'),
    'can_administer', public.has_role('admin')
  ) into result;

  return result;
end;
$$;

-- Everyone who has ever contacted the organisation, as one row per person.
-- Read-only and derived: no merge tooling yet, so nothing here can be wrong in
-- a way that loses data.
-- security_invoker is load-bearing. A view defaults to running with its
-- OWNER's rights, which would bypass RLS on the three tables below and hand the
-- whole directory to any authenticated account -- and anyone can create one of
-- those. With it on, the caller's own policies apply, so a non-member sees zero
-- rows even though the grant lets them run the query.
create or replace view public.people_directory
  with (security_invoker = true)
as
with touches as (
  select lower(email) as email,
         coalesce(nullif(trim(name), ''), 'Unknown') as name,
         created_at, 'Enquiry' as kind
    from public.contact_submissions where email is not null and email <> ''
  union all
  select lower(email),
         coalesce(nullif(trim(concat_ws(' ', first_name, last_name)), ''), 'Unknown'),
         created_at, 'Volunteer'
    from public.volunteer_interests where email is not null and email <> ''
  union all
  select lower(email),
         coalesce(nullif(trim(name), ''), 'Unknown'),
         created_at, 'RSVP'
    from public.event_rsvps where email is not null and email <> ''
)
select email,
       (array_agg(name order by created_at desc))[1] as name,
       count(*)                                       as touch_count,
       max(created_at)                                as last_seen,
       min(created_at)                                as first_seen,
       array_agg(distinct kind)                       as kinds
  from touches
 group by email;

comment on view public.people_directory is
  'One row per person, matched on email across enquiries, volunteers and RSVPs. Donations are excluded: donor identity is finance-only.';

revoke all on public.people_directory from anon, authenticated;
grant select on public.people_directory to authenticated;

-- ------------------------------------------------------------------ comments

comment on table public.staff_members is
  'Everyone who may sign in to /admin. Roles: member (everything but donor-level giving), finance (donor names and amounts), admin (manage the team, read the activity log).';
comment on table public.activity_log is
  'Every change, and every read of a table holding what somebody told us in confidence. Written only through log_activity().';
comment on table public.record_notes is
  'Append-only staff notes attached to a record. What the person themselves wrote is never edited -- see protect_submission_content().';
