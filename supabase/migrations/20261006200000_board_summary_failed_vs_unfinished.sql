-- Board summary: a failed payment is not an abandoned checkout, and "today"
-- is Eastern.
--
-- 'failed' counted every gift that was not succeeded, pending or processing,
-- so a donor who opened Stripe's page and closed it showed on the dashboard
-- as "1 payment failed -- a donor probably meant to give and could not". Now
-- 'failed' is status = 'failed' (a declined card, a monthly charge that did
-- not go through) and 'unfinished' counts expired checkouts on their own. A
-- Board Center that predates this reads 'failed' and ignores 'unfinished'.
--
-- 'overdue' compared follow-up dates with current_date, which is the UTC date:
-- from 8pm Eastern every follow-up due that day counted as overdue.

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
  today        date        := (now() at time zone 'America/New_York')::date;
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
                   where stage <> 'closed' and follow_up_due < today),
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
                       where status = 'failed'
                         and created_at >= month_start),
      'unfinished',  (select count(*) from public.donations
                       where status = 'expired'
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
