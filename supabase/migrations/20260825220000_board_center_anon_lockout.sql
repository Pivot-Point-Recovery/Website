-- Take the anon key off the Board Center tables, and correct two seeded titles.
--
-- Its own file because 20260825200000 is already applied, and Supabase tracks
-- migrations by filename: editing an applied one is silently skipped.

-- ------------------------------------------------------- 1. the anon grants

-- Checked against the live project: the anon key gets HTTP 200 and an empty
-- array from staff_members, activity_log, record_notes, intake_queue and
-- board_documents. No rows leak -- RLS is doing its job -- but the 200 rather
-- than a 401 means anon holds a table-level SELECT grant it was never given
-- here. Supabase's default privileges for the public schema hand it out to new
-- tables automatically.
--
-- Nothing is exposed today, and that is exactly why this is worth doing now:
-- the only thing standing between the anon key and the team list is one
-- permissive policy or one `disable row level security` typed in a hurry. The
-- older tables were revoked explicitly for the same reason; these were missed.
revoke all on public.staff_members   from anon;
revoke all on public.activity_log    from anon;
revoke all on public.record_notes    from anon;
revoke all on public.intake_queue    from anon;
revoke all on public.board_documents from anon;

-- Stop the next table added to this schema from inheriting the same grant.
alter default privileges in schema public revoke all on tables from anon;

-- ------------------------------------------------------------- 2. the titles

-- Seeded from a comment in an older migration and from a guess at who was on
-- NOTIFICATION_EMAILS. Both were wrong: Erica is not the executive director,
-- and Steve is the CEO rather than the treasurer. Corrected in the live data
-- directly as well, since this file cannot reach a database that has already
-- run the seed.
update public.staff_members set label = 'Steve — CEO'
 where lower(email) = 'steve@pivotpointrecovery.org'
   and label = 'Steve — Treasurer';

update public.staff_members set label = 'Erica'
 where lower(email) = 'erica@pivotpointrecovery.org'
   and label = 'Erica — Executive Director';

update public.event_editors set label = 'Erica'
 where lower(email) = 'erica@pivotpointrecovery.org'
   and label = 'Erica — Executive Director';
