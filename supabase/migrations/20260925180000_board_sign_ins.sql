-- The board, on the team list.
--
-- Everyone who sits on the board should be able to open /admin. Elyse, Geneva
-- and Lauren were added from Team & access; Grant was not, and Steve's row
-- predates this file. Listing all five here makes the team reproducible from
-- the migrations alone, and re-running it cannot change anything that has
-- since been edited by hand: an existing row keeps its label and roles and is
-- only switched back on.
--
-- Grant has no pivotpointrecovery.org mailbox; the address below is the one
-- the board's email goes to. Change it here and under Team & access together
-- if that ever changes, because the sign-in is tied to the address.
--
-- Roles: member for the board. Donor-level giving stays with Erica and Steve
-- by the board's decision, so nobody here gets finance, and the treasurer is
-- no exception until the board says otherwise.
insert into public.staff_members (email, label, roles) values
  ('steve@pivotpointrecovery.org',   'Steve — CEO',     array['member','finance','admin']),
  ('elise@pivotpointrecovery.org',   'Elyse — board',   array['member']),
  ('genny@pivotpointrecovery.org',   'Geneva — board',  array['member']),
  ('lauren@pivotpointrecovery.org',  'Lauren — board',  array['member']),
  ('grantsmith.financial@gmail.com', 'Grant — board',   array['member'])
on conflict (lower(email)) do update
   set label  = coalesce(public.staff_members.label, excluded.label),
       active = true;
