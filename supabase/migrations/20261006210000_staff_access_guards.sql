-- Access levels are changed from the Board Center now (Team & access), so the
-- database guards what a mistaken click could do there.
--
-- 1. roles holds only what the policies and the Board Center know:
--    member (everything but giving), finance (Giving), admin (Manage access).
--    is_member() looks at `active`, not at 'member'; has_role() is what reads
--    finance and admin.
-- 2. Somebody active always keeps Manage access. Without one, nobody could
--    invite anyone, reset a password or switch an account back on short of
--    running SQL. Checked once per statement, after it runs, so swapping the
--    role between two people in one go is fine; leaving nobody is not.
--
-- Written to be re-runnable without DROP statements.

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'staff_members_roles_known'
                    and conrelid = 'public.staff_members'::regclass) then
    alter table public.staff_members
      add constraint staff_members_roles_known
      check (cardinality(roles) > 0 and roles <@ array['member', 'finance', 'admin']::text[]);
  end if;
end;
$$;

create or replace function public.staff_keep_an_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.staff_members s where s.active and 'admin' = any (s.roles)
  ) then
    raise exception 'Nothing was changed — at least one active person has to keep Manage access, or nobody could let anyone back in.'
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;

create or replace trigger staff_members_keep_an_admin
  after update or delete on public.staff_members
  for each statement execute function public.staff_keep_an_admin();
