-- What a donor told us, kept with the gift.
--
-- A gift row held a name and an email and nothing else, so the Board Center
-- could not say how to reach a donor beyond that, and a donor's own words --
-- "in memory of my brother" -- had nowhere to go. donate.html now asks for an
-- optional phone number and an optional note, and Stripe Checkout collects a
-- full mailing address, which the webhook copies here.
--
-- Donor-level giving stays finance-only. These columns sit on a table whose
-- only read policy is has_role('finance'), so nobody else's browser is ever
-- sent them.
--
-- Additive and idempotent.

alter table public.donations
  add column if not exists donor_phone   text,
  add column if not exists donor_address jsonb,
  add column if not exists donor_note    text;

comment on column public.donations.donor_phone is
  'Optional, typed on donate.html. Never sent to Stripe.';
comment on column public.donations.donor_address is
  'Billing address from Stripe Checkout -- line1, line2, city, state, postal_code, country -- holding only the parts Stripe returned.';
comment on column public.donations.donor_note is
  'Optional note the donor wrote on donate.html, up to 500 characters. Kept here only: free text can name somebody we serve, so it never goes to Stripe.';
