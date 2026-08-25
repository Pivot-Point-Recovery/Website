-- Record who is looking after somebody, and when they were actually spoken to.
--
-- owner_email already existed but could only be set to the signed-in person
-- ("Assign to me"), which is no use when the person who made the call is not
-- the person at the keyboard. And there was nowhere to record that contact had
-- happened at all: intake_queue had first_contact_at, enquiries and volunteers
-- did not, so "Brendan already spoke to Steve" had no home.
--
-- Additive and idempotent, as every migration here is.

alter table public.contact_submissions
  add column if not exists first_contact_at timestamptz;
alter table public.volunteer_interests
  add column if not exists first_contact_at timestamptz;

create index if not exists contact_submissions_owner_idx
  on public.contact_submissions (lower(owner_email));
create index if not exists volunteer_interests_owner_idx
  on public.volunteer_interests (lower(owner_email));
create index if not exists intake_queue_owner_idx
  on public.intake_queue (lower(owner_email));

comment on column public.contact_submissions.first_contact_at is
  'When somebody from the team actually reached this person. Staff-recorded, so it is writable from /admin -- unlike every column the person themselves filled in.';
comment on column public.volunteer_interests.first_contact_at is
  'When somebody from the team actually reached this person.';

-- protect_submission_content() pins the submitted columns by name and leaves
-- everything else writable, so first_contact_at needs no change there. Stated
-- explicitly because it is the kind of thing that looks like an omission.
