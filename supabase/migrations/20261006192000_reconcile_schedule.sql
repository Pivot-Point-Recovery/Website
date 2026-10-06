-- Reconcile gifts against Stripe every 15 minutes.
--
-- The webhook stays the live path. This is the net under it: a gift still
-- `pending` ten minutes after checkout is looked up on Stripe and settled the
-- way the webhook would have settled it. A lost delivery now costs a quarter
-- of an hour, not weeks.
--
-- The function decides what a late find means (see donations-reconcile):
-- a gift found within three days is receipted as normal; an older one is
-- recorded, and staff get one email asking them to send its receipt.
--
-- cron.schedule replaces a job of the same name, so re-running this does not
-- add a second.

select cron.schedule(
  'donations-reconcile',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url     := 'https://ihgwhglatsbhngbsezuj.supabase.co/functions/v1/donations-reconcile',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-reconcile-token', (select decrypted_secret
                              from vault.decrypted_secrets
                             where name = 'donations_reconcile_token')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
  $job$
);
