-- Intake notifications: the queue fills itself, and Steve is on the list.
--
-- The intake form is a Google Form, so its answers stay in Google under 42 CFR
-- Part 2. Until now a completed intake told nobody: Google emails only the
-- editors who have each switched on its per-person setting, and nothing about
-- a submission ever reached this project. The intake-webhook function now adds
-- a reference to intake_queue on every submission and emails the standing
-- notification list, the same as every other form.
--
-- Additive and idempotent, as every migration here is.

-- Whether the website emailed staff about this entry. The other three
-- submission tables carry the same flag for the same reason: "saved" and
-- "somebody was told" are different facts. It is also what makes a
-- re-delivered submission safe -- one whose first email failed is retried, and
-- one whose email went out is not sent twice.
alter table public.intake_queue
  add column if not exists notified boolean not null default false;

comment on column public.intake_queue.notified is
  'True once intake-webhook has emailed staff about this entry. Rows added by hand at /admin stay false: nobody was emailed about them.';

-- Steve, on the table rather than only in the NOTIFICATION_EMAILS secret. He
-- was already being mailed through the secret, but a secret cannot be read
-- back or audited, and the README tells the story of a list that quietly left
-- someone off for months. Listed here, his notifications no longer depend on a
-- value nobody can see. Re-running this only switches him back on.
insert into public.notification_recipients (email, label)
values ('steve@pivotpointrecovery.org', 'Steve — CEO')
on conflict (lower(email)) do update
   set active         = true,
       receives_forms = true;
