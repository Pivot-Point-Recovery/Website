-- Events, event RSVPs, and the editor allowlist that makes them no-code.
--
-- Why a table rather than another hand-written HTML page per event: events are
-- the one part of this site that changes on a weekly cadence, and the person
-- who knows when the next one is does not edit HTML. /admin writes here.
--
-- Additive and idempotent throughout, in the same style as the initial schema:
-- IF NOT EXISTS, no DROP, no column type changes. This runs against the live
-- database that already holds real contact and volunteer submissions.

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------- events ---

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.events
  add column if not exists updated_at    timestamptz default now(),
  -- URL identity. /event?slug=open-mic-night
  add column if not exists slug          text,
  add column if not exists title         text,
  -- Short line under the title, e.g. "Share your voice. Inspire change."
  add column if not exists tagline       text,
  add column if not exists summary       text,
  -- Long copy. Plain text or a few paragraphs separated by blank lines; it is
  -- rendered as escaped text, never as HTML, because a non-technical editor
  -- must not be able to inject markup into a public page by accident.
  add column if not exists description   text,
  add column if not exists starts_at     timestamptz,
  add column if not exists ends_at       timestamptz,
  -- Human-authored override for the date/time line. Left null, the page
  -- formats starts_at/ends_at itself; set, it wins. Covers "every third
  -- Thursday" and other things a timestamp cannot say.
  add column if not exists when_text     text,
  add column if not exists location_name text,
  add column if not exists address       text,
  add column if not exists city          text,
  add column if not exists state         text,
  add column if not exists postal_code   text,
  add column if not exists image_url     text,
  add column if not exists cost_text     text,
  -- An event with its own hand-built page (Open Mic Night has one, because a
  -- printed flyer's QR code points at it) links there from the events list
  -- instead of at the generic /event template.
  add column if not exists detail_url    text,
  add column if not exists rsvp_enabled  boolean default true,
  -- Who gets the RSVP notification for THIS event. Per-event so a new event can
  -- be routed to a different organiser without touching code or secrets.
  add column if not exists rsvp_email    text,
  add column if not exists published     boolean default false,
  add column if not exists featured      boolean default false,
  add column if not exists created_by    text,
  add column if not exists updated_by    text;

create unique index if not exists events_slug_key on public.events (lower(slug));
create index if not exists events_starts_at_idx on public.events (starts_at);
create index if not exists events_published_idx on public.events (published) where published;

drop trigger if exists events_touch_updated_at on public.events;
create trigger events_touch_updated_at
  before update on public.events
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------ event RSVPs ---

create table if not exists public.event_rsvps (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.event_rsvps
  add column if not exists event_id      uuid references public.events (id) on delete set null,
  -- Denormalised on purpose: an RSVP has to stay readable and attributable even
  -- if the event row is later renamed or removed.
  add column if not exists event_slug    text,
  add column if not exists event_title   text,
  add column if not exists name          text,
  add column if not exists email         text,
  add column if not exists phone         text,
  add column if not exists party_size    integer default 1,
  -- 'perform' | 'listen' | 'undecided'
  add column if not exists participation text,
  add column if not exists act_type      text[],
  add column if not exists notes         text,
  add column if not exists source        text default 'website',
  add column if not exists status        text default 'new',
  add column if not exists notified      boolean default false,
  add column if not exists user_agent    text;

create index if not exists event_rsvps_created_at_idx on public.event_rsvps (created_at desc);
create index if not exists event_rsvps_event_slug_idx on public.event_rsvps (lower(event_slug));

-- --------------------------------------------------------- who may edit -----

-- The allowlist. Being able to sign in is not the same as being allowed to
-- publish: anyone with an email address can end up in auth.users, and only the
-- addresses listed here can write to public.events.
create table if not exists public.event_editors (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  label      text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists event_editors_email_key
  on public.event_editors (lower(email));

-- Reads the JWT's email claim rather than joining auth.users, so the check
-- costs nothing and works the same from PostgREST and from SQL.
create or replace function public.is_event_editor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.event_editors e
     where e.active
       and lower(e.email) = lower(coalesce(
             nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
             ''))
  );
$$;

-- -------------------------------------------------------------------- RLS ---

alter table public.events        enable row level security;
alter table public.event_rsvps   enable row level security;
alter table public.event_editors enable row level security;

-- Events are the one public-readable table on this project, and only the
-- published rows: a draft is not a soft secret, it is an unannounced date.
revoke all on public.events from anon, authenticated;
grant select on public.events to anon, authenticated;
grant insert, update, delete on public.events to authenticated;

drop policy if exists events_public_read on public.events;
create policy events_public_read on public.events
  for select to anon, authenticated
  using (published);

drop policy if exists events_editor_read on public.events;
create policy events_editor_read on public.events
  for select to authenticated
  using (public.is_event_editor());

drop policy if exists events_editor_insert on public.events;
create policy events_editor_insert on public.events
  for insert to authenticated
  with check (public.is_event_editor());

drop policy if exists events_editor_update on public.events;
create policy events_editor_update on public.events
  for update to authenticated
  using (public.is_event_editor())
  with check (public.is_event_editor());

drop policy if exists events_editor_delete on public.events;
create policy events_editor_delete on public.events
  for delete to authenticated
  using (public.is_event_editor());

-- RSVPs hold attendee PII. Anonymous visitors never touch this table directly:
-- they POST to the public-forms edge function, which validates and writes with
-- the service role. Editors may read the guest list for their own events.
revoke all on public.event_rsvps from anon, authenticated;
grant select on public.event_rsvps to authenticated;

drop policy if exists event_rsvps_editor_read on public.event_rsvps;
create policy event_rsvps_editor_read on public.event_rsvps
  for select to authenticated
  using (public.is_event_editor());

-- The allowlist itself is never client-readable. Adding an editor is a
-- deliberate act performed with the service role or from the SQL editor.
revoke all on public.event_editors from anon, authenticated;

comment on table public.events is
  'Public events, edited at /admin by anyone listed in event_editors. Only published rows are visible to anon.';
comment on column public.events.rsvp_email is
  'Who receives RSVP notifications for this event. Null falls back to the default organiser in the public-forms function.';
comment on column public.events.detail_url is
  'Set when an event has its own hand-built page; the events list links there instead of /event.';
comment on table public.event_editors is
  'Allowlist of email addresses permitted to create and edit events. Signing in is not sufficient.';
