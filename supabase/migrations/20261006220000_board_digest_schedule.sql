-- The Monday summary email (board-digest), at 8:50am New York time.
--
-- pg_cron runs in UTC. 12:50 UTC is 8:50am in New York in summer (EDT) and
-- 13:50 UTC is 8:50am in winter (EST). The job runs at both, and the function
-- sends only on the call that lands at 8 o'clock in New York, so it goes once
-- a week at the same local time all year.
--
-- It presents the scheduler's token from Vault (donations_reconcile_token,
-- 20261006191000_reconcile_token.sql): the same proof donations-reconcile
-- takes that a call came from this database's own schedule.
--
-- cron.schedule replaces a job of the same name, so re-running is safe.

select cron.schedule(
  'board-digest-summer',
  '50 12 * * 1',
  $job$
  select net.http_post(
    url     := 'https://ihgwhglatsbhngbsezuj.supabase.co/functions/v1/board-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-schedule-token', (select decrypted_secret
                             from vault.decrypted_secrets
                            where name = 'donations_reconcile_token')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
  $job$
);

select cron.schedule(
  'board-digest-winter',
  '50 13 * * 1',
  $job$
  select net.http_post(
    url     := 'https://ihgwhglatsbhngbsezuj.supabase.co/functions/v1/board-digest',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-schedule-token', (select decrypted_secret
                             from vault.decrypted_secrets
                            where name = 'donations_reconcile_token')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
  $job$
);
