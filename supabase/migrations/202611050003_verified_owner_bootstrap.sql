-- The owner supplied the administrative e-mail. Store only its digest and
-- authorize it once, after Supabase Auth verifies that e-mail. This is not a
-- "first visitor becomes admin" flow and clients cannot configure this table.
create table if not exists public.mr1_owner_bootstrap (
  id text primary key check (id = 'owner'),
  email_sha256 text not null check (email_sha256 ~ '^[a-f0-9]{64}$'),
  claimed_at timestamptz
);
alter table public.mr1_owner_bootstrap enable row level security;
revoke all on public.mr1_owner_bootstrap from anon, authenticated;
grant all on public.mr1_owner_bootstrap to service_role;

create or replace function public.mr1_claim_owner(candidate uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare target public.mr1_owner_bootstrap%rowtype; account auth.users%rowtype;
begin
  select * into target from public.mr1_owner_bootstrap where id='owner' for update;
  if not found or target.claimed_at is not null then return false; end if;
  if exists(select 1 from public.mr1_admins) then
    update public.mr1_owner_bootstrap set claimed_at=now() where id='owner';
    return false;
  end if;
  select * into account from auth.users where id=candidate;
  if not found or account.email_confirmed_at is null or account.email is null then return false; end if;
  if encode(sha256(convert_to(lower(trim(account.email)),'UTF8')),'hex') <> target.email_sha256 then return false; end if;
  insert into public.mr1_admins(user_id) values(candidate) on conflict do nothing;
  update public.mr1_owner_bootstrap set claimed_at=now() where id='owner';
  return true;
end;
$$;
revoke all on function public.mr1_claim_owner(uuid) from public, anon, authenticated;
grant execute on function public.mr1_claim_owner(uuid) to service_role;

create or replace function public.mr1_owner_after_confirmation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is not null then perform public.mr1_claim_owner(new.id); end if;
  return new;
end;
$$;
revoke all on function public.mr1_owner_after_confirmation() from public, anon, authenticated;
drop trigger if exists mr1_owner_confirmation on auth.users;
create trigger mr1_owner_confirmation after insert or update of email_confirmed_at,email on auth.users
for each row execute function public.mr1_owner_after_confirmation();
