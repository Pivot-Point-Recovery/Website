-- A key for the scheduled reconciler, kept in Vault.
--
-- donations-reconcile answered only to a finance user's session, so it ran
-- when a person remembered to run it -- which was never, while ten paid gifts
-- sat at `pending` for weeks. The schedule in the next migration calls it on
-- its own; this is how it proves it is the schedule.
--
-- The token lives in Vault and is compared inside the database. The edge
-- function never holds a copy, and only the service role can test one.
--
-- Idempotent: an existing token is kept.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'donations_reconcile_token') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'donations_reconcile_token',
      'Lets the pg_cron schedule call the donations-reconcile edge function.');
  end if;
end;
$$;

create or replace function public.reconcile_token_matches(token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(token, '') <> ''
     and exists (select 1
                   from vault.decrypted_secrets
                  where name = 'donations_reconcile_token'
                    and decrypted_secret = token);
$$;

revoke all on function public.reconcile_token_matches(text) from public, anon, authenticated;
grant execute on function public.reconcile_token_matches(text) to service_role;

comment on function public.reconcile_token_matches(text) is
  'True when the token is the scheduled reconciler''s. Callable by the service role only.';
