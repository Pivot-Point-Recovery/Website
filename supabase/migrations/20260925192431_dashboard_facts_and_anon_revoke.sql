-- Dashboard facts for giving, and stripe_events closed to anon.
--
-- Applied to the live project on 2026-09-25 alongside donations-reconcile, but
-- never committed here -- so a `supabase db push` from this repo would have
-- had no record of it. Copied verbatim from
-- supabase_migrations.schema_migrations so the repo can stand the backend up
-- again on its own. The version in the filename is the one the live project
-- recorded.
--
-- What it adds: board_summary() computes month and year boundaries in
-- America/New_York rather than UTC, and reports gifts still waiting on Stripe
-- (pending_count, pending_cents, oldest_pending) and whether any webhook
-- delivery has ever landed (webhook_seen).

revoke all on public.stripe_events from anon;

create or replace function public.ppr_period_start(unit text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select date_trunc(unit, (now() at time zone 'America/New_York'))
           at time zone 'America/New_York';
$$;

comment on function public.ppr_period_start(text) is
  'Start of the current month/year in America/New_York, as a timestamptz.';

create or replace function public.board_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result       jsonb;
  month_start  timestamptz := public.ppr_period_start('month');
  year_start   timestamptz := public.ppr_period_start('year');
begin
  if not public.is_member() then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'enquiries', jsonb_build_object(
      'unanswered', (select count(*) from public.contact_submissions
                      where coalesce(status, 'new') = 'new'),
      'this_month', (select count(*) from public.contact_submissions
                      where created_at >= month_start),
      'oldest_unanswered', (select min(created_at) from public.contact_submissions
                             where coalesce(status, 'new') = 'new')),
    'volunteers', jsonb_build_object(
      'total',      (select count(*) from public.volunteer_interests),
      'unscreened', (select count(*) from public.volunteer_interests
                      where coalesce(status, 'new') = 'new'),
      'this_month', (select count(*) from public.volunteer_interests
                      where created_at >= month_start)),
    'intake', jsonb_build_object(
      'open',    (select count(*) from public.intake_queue where stage <> 'closed'),
      'overdue', (select count(*) from public.intake_queue
                   where stage <> 'closed' and follow_up_due < current_date),
      'this_month', (select count(*) from public.intake_queue
                      where received_at >= month_start),
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
                             'starts_at', e.starts_at, 'ends_at', e.ends_at,
                             'detail_url', e.detail_url,
                             'started', e.starts_at <= now(),
                             'rsvps',
                             (select count(*) from public.event_rsvps r where r.event_id = e.id))
                      from public.events e
                     where e.published
                       and coalesce(e.ends_at, e.starts_at + interval '1 day') >= now()
                     order by e.starts_at limit 1),
      'recent',    (select jsonb_build_object('title', e.title, 'slug', e.slug,
                             'starts_at', e.starts_at, 'detail_url', e.detail_url,
                             'rsvps',
                             (select count(*) from public.event_rsvps r where r.event_id = e.id))
                      from public.events e
                     where e.published
                       and coalesce(e.ends_at, e.starts_at + interval '1 day') < now()
                     order by e.starts_at desc limit 1)),

    'giving', jsonb_build_object(
      'month_cents', (select coalesce(sum(amount_cents), 0) from public.donations
                       where status = 'succeeded' and created_at >= month_start),
      'year_cents',  (select coalesce(sum(amount_cents), 0) from public.donations
                       where status = 'succeeded' and created_at >= year_start),
      'gift_count',  (select count(*) from public.donations
                       where status = 'succeeded' and created_at >= month_start),
      'year_gift_count', (select count(*) from public.donations
                       where status = 'succeeded' and created_at >= year_start),
      'recurring',   (select count(distinct lower(donor_email)) from public.donations
                       where status = 'succeeded' and is_recurring
                         and donor_email is not null and donor_email <> ''),
      'failed',      (select count(*) from public.donations
                       where status not in ('succeeded', 'pending', 'processing')
                         and created_at >= month_start),
      'pending_cents', (select coalesce(sum(amount_cents), 0) from public.donations
                         where status in ('pending', 'processing') and created_at >= year_start),
      'pending_count', (select count(*) from public.donations
                         where status in ('pending', 'processing') and created_at >= year_start),
      'oldest_pending', (select min(created_at) from public.donations
                          where status in ('pending', 'processing') and created_at >= year_start),
      'webhook_seen', (select exists (select 1 from public.stripe_events)),
      'by_fund',     (select coalesce(jsonb_agg(f), '[]'::jsonb) from (
                        select coalesce(nullif(fund_designation, ''), 'General fund') as fund,
                               sum(amount_cents) as cents
                          from public.donations
                         where status = 'succeeded' and created_at >= month_start
                      group by 1 order by 2 desc) f)),

    'can_see_donors', public.has_role('finance'),
    'can_administer', public.has_role('admin')
  ) into result;

  return result;
end;
$$;
