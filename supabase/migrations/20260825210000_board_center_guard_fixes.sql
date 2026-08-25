-- Two corrections to the Board Center guards.
--
-- These belong in their own file rather than as an edit to
-- 20260825200000_board_center_foundation.sql, because that migration is already
-- on main and may already have been applied. Supabase tracks applied migrations
-- by filename, so a change to one that has run is silently skipped -- the fix
-- would look committed and never reach the database.
--
-- Both statements below supersede the earlier definitions whichever order the
-- two files are applied in.

-- ------------------------------------------ 1. what a submission may not lose

-- Two problems with the first version.
--
-- It pinned only name, email, phone and message. But the promise being made is
-- that what somebody submitted is never edited, and `interest`, `city`,
-- `interests` and `availability` are equally things THEY chose -- a dropdown
-- they picked is as much their answer as a sentence they typed.
--
-- And it applied to every role, so a deliberate server-side correction silently
-- did nothing: the outstanding CSV backfill in docs/MIGRATION.md, a fix to a
-- mistyped address somebody has asked us to change, anything run from the SQL
-- editor. The promise is that nothing signed in to /admin can rewrite a
-- submission, not that the row is immutable forever, so the pin is now scoped
-- to the browser-facing role.
create or replace function public.protect_submission_content()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The service role, migrations and the SQL editor are exempt on purpose; see
  -- the note above. Only the role a browser holds is restrained here.
  if current_user <> 'authenticated' then
    return new;
  end if;

  -- Everything the person themselves supplied, pinned to its stored value. The
  -- writable layer is deliberately narrow: status, owner_email, notified.
  -- Add a column here whenever the public forms start collecting one.
  if tg_table_name = 'contact_submissions' then
    new.name       := old.name;
    new.email      := old.email;
    new.phone      := old.phone;
    new.interest   := old.interest;
    new.message    := old.message;
    new.source     := old.source;
    new.user_agent := old.user_agent;
    new.created_at := old.created_at;
  elsif tg_table_name = 'volunteer_interests' then
    new.first_name   := old.first_name;
    new.last_name    := old.last_name;
    new.email        := old.email;
    new.phone        := old.phone;
    new.city         := old.city;
    new.interests    := old.interests;
    new.availability := old.availability;
    new.experience   := old.experience;
    new.source       := old.source;
    new.user_agent   := old.user_agent;
    new.created_at   := old.created_at;
  end if;
  return new;
end;
$$;

comment on function public.protect_submission_content() is
  'Pins every submitted column on update for the authenticated (browser) role, so /admin cannot rewrite what somebody wrote. The service role and migrations are exempt, so a deliberate correction is still possible.';

-- The triggers themselves are unchanged; recreated only so this file stands
-- alone if the foundation migration has not run yet.
drop trigger if exists contact_protect_content on public.contact_submissions;
create trigger contact_protect_content
  before update on public.contact_submissions
  for each row execute function public.protect_submission_content();

drop trigger if exists volunteer_protect_content on public.volunteer_interests;
create trigger volunteer_protect_content
  before update on public.volunteer_interests
  for each row execute function public.protect_submission_content();

-- ------------------------------------- 2. who may remove a board document

-- /admin only offers Remove to administrators, but the first version's `for
-- all` policy let any member delete anyone's link. The page is a courtesy; the
-- database is the authority, so the database has to say administrators too.
drop policy if exists docs_member_write on public.board_documents;

create policy docs_member_insert on public.board_documents
  for insert to authenticated with check (public.is_member());

drop policy if exists docs_admin_delete on public.board_documents;
create policy docs_admin_delete on public.board_documents
  for delete to authenticated using (public.has_role('admin'));
