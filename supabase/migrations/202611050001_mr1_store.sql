-- MR1 tables are namespaced to preserve other applications in this project.
create table if not exists public.mr1_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.mr1_admins enable row level security;
revoke all on public.mr1_admins from anon, authenticated;
grant select on public.mr1_admins to authenticated;
drop policy if exists mr1_admin_self on public.mr1_admins;
create policy mr1_admin_self on public.mr1_admins for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.mr1_is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.mr1_admins where user_id = (select auth.uid())); $$;
revoke all on function public.mr1_is_admin() from public;
grant execute on function public.mr1_is_admin() to authenticated, service_role;

create table if not exists public.mr1_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 100),
  created_at timestamptz not null default now()
);
alter table public.mr1_profiles enable row level security;
revoke all on public.mr1_profiles from anon, authenticated;
grant select, insert, update on public.mr1_profiles to authenticated;
drop policy if exists mr1_profile_owner on public.mr1_profiles;
create policy mr1_profile_owner on public.mr1_profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create or replace function public.mr1_handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.mr1_profiles(user_id, display_name)
  values (new.id, coalesce(nullif(left(trim(new.raw_user_meta_data->>'name'),100),''),'Cliente'))
  on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.mr1_handle_new_user() from public, anon, authenticated;
drop trigger if exists mr1_profile_on_signup on auth.users;
create trigger mr1_profile_on_signup after insert on auth.users for each row execute function public.mr1_handle_new_user();
insert into public.mr1_profiles(user_id,display_name)
select id,coalesce(nullif(left(trim(raw_user_meta_data->>'name'),100),''),'Cliente') from auth.users
on conflict (user_id) do nothing;

create table if not exists public.mr1_products (
  id text primary key default replace(gen_random_uuid()::text,'-','') check (id ~ '^[A-Za-z0-9_-]{1,80}$'),
  name text not null check (char_length(trim(name)) between 1 and 100),
  category text not null check (category in ('camisetas','moletons','calcas','acessorios')),
  price numeric(12,2) not null check (price > 0 and price <= 100000),
  old_price numeric(12,2) check (old_price > price and old_price <= 100000),
  image text not null check (char_length(image) between 1 and 2048),
  sizes text[] not null check (cardinality(sizes) between 1 and 15),
  stock integer not null default 0 check (stock between 0 and 99999),
  color text not null default '#142B49' check (color ~ '^#[A-Fa-f0-9]{6}$'),
  badge text not null default '' check (char_length(badge) <= 30),
  description text not null default '' check (char_length(description) <= 1200),
  weight numeric not null check (weight > 0 and weight <= 100),
  width numeric not null check (width > 0 and width <= 200),
  height numeric not null check (height > 0 and height <= 200),
  length numeric not null check (length > 0 and length <= 200),
  measurements_confirmed boolean not null default false,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);
alter table public.mr1_products enable row level security;
revoke all on public.mr1_products from anon, authenticated;
grant select on public.mr1_products to anon, authenticated;
grant insert, update, delete on public.mr1_products to authenticated;
drop policy if exists mr1_products_public on public.mr1_products;
create policy mr1_products_public on public.mr1_products for select to anon, authenticated using (true);
drop policy if exists mr1_products_admin on public.mr1_products;
create policy mr1_products_admin on public.mr1_products for all to authenticated
  using ((select public.mr1_is_admin())) with check ((select public.mr1_is_admin()));

create table if not exists public.mr1_favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null references public.mr1_products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);
alter table public.mr1_favorites enable row level security;
revoke all on public.mr1_favorites from anon, authenticated;
grant select, insert, delete on public.mr1_favorites to authenticated;
drop policy if exists mr1_favorites_owner on public.mr1_favorites;
create policy mr1_favorites_owner on public.mr1_favorites for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table if not exists public.mr1_orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('creating','pending','payment_pending','payment_in_process','payment_unconfirmed','paid','paid_review','cancelled','expired','rejected','refunded','charged_back')),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) > 0),
  customer jsonb not null check (jsonb_typeof(customer) = 'object'),
  shipping_service jsonb,
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  shipping_cents bigint not null check (shipping_cents >= 0),
  total_cents bigint not null check (total_cents = subtotal_cents + shipping_cents),
  created_at timestamptz not null default now()
);
create index if not exists mr1_order_owner on public.mr1_orders(customer_id, created_at desc);
alter table public.mr1_orders enable row level security;
revoke all on public.mr1_orders from anon, authenticated;
grant select on public.mr1_orders to authenticated;
drop policy if exists mr1_order_read on public.mr1_orders;
create policy mr1_order_read on public.mr1_orders for select to authenticated
  using (customer_id = (select auth.uid()) or (select public.mr1_is_admin()));
-- No browser role can insert orders or change paid status, totals or stock reservations.

create table if not exists public.mr1_site_settings (
  id text primary key default 'default' check (id = 'default'),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now()
);
alter table public.mr1_site_settings enable row level security;
revoke all on public.mr1_site_settings from anon, authenticated;
grant select on public.mr1_site_settings to anon, authenticated;
grant update on public.mr1_site_settings to authenticated;
drop policy if exists mr1_settings_public on public.mr1_site_settings;
create policy mr1_settings_public on public.mr1_site_settings for select to anon, authenticated using (true);
drop policy if exists mr1_settings_admin on public.mr1_site_settings;
create policy mr1_settings_admin on public.mr1_site_settings for update to authenticated
  using ((select public.mr1_is_admin())) with check ((select public.mr1_is_admin()));

create or replace function public.mr1_validate_settings() returns trigger
language plpgsql set search_path = '' as $$
declare field text; value text; allowed text[] := array['brandName','logoUrl','logoLightUrl','heroImage','announcementText','heroEyebrow','heroTitleLine1','heroTitleLine2','heroTitleAccent','heroDescription','heroButtonText','manifestoEyebrow','manifestoTitleLine1','manifestoTitleLine2','manifestoTitleAccent','manifestoText','footerText','contactEmail','instagramUrl','primaryColor','accentColor','backgroundColor'];
begin
  for field,value in select key, v#>>'{}' from jsonb_each(new.data) as e(key,v) loop
    if not (field = any(allowed)) or jsonb_typeof(new.data->field) <> 'string' or char_length(value) > 2048 then
      raise exception 'Invalid store setting' using errcode='22023';
    end if;
    if field in ('primaryColor','accentColor','backgroundColor') and value !~ '^#[A-Fa-f0-9]{6}$' then
      raise exception 'Invalid color' using errcode='22023';
    end if;
    if field in ('logoUrl','logoLightUrl','heroImage') and
      (value !~ '^(assets/[A-Za-z0-9_./-]+\.(svg|png|jpg|jpeg|webp)|https://[^[:space:]<>"''\\]+)$' or value ~ '(^|/)\.\.(/|$)') then
      raise exception 'Invalid image URL' using errcode='22023';
    end if;
    if field in ('brandName','heroTitleLine1','heroButtonText') and char_length(trim(value)) = 0 then
      raise exception 'Required text missing' using errcode='22023';
    end if;
  end loop;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists mr1_settings_validation on public.mr1_site_settings;
create trigger mr1_settings_validation before insert or update on public.mr1_site_settings for each row execute function public.mr1_validate_settings();
revoke all on function public.mr1_validate_settings() from public, anon, authenticated;

create or replace function public.mr1_update_site_settings(patch jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not public.mr1_is_admin() then raise insufficient_privilege; end if;
  if jsonb_typeof(patch) <> 'object' then raise exception 'Invalid settings patch' using errcode='22023'; end if;
  update public.mr1_site_settings set data = data || patch where id = 'default' returning data into result;
  return result;
end;
$$;
revoke all on function public.mr1_update_site_settings(jsonb) from public;
grant execute on function public.mr1_update_site_settings(jsonb) to authenticated, service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('mr1-media','mr1-media',true,2000000,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set file_size_limit=excluded.file_size_limit, allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists mr1_media_read on storage.objects;
create policy mr1_media_read on storage.objects for select to anon, authenticated using (bucket_id='mr1-media');
drop policy if exists mr1_media_upload on storage.objects;
create policy mr1_media_upload on storage.objects for insert to authenticated with check (
  bucket_id='mr1-media' and (select public.mr1_is_admin()) and (storage.foldername(name))[1] = (select auth.uid())::text
  and lower(storage.extension(name)) in ('jpg','png','webp')
);
drop policy if exists mr1_media_delete on storage.objects;
create policy mr1_media_delete on storage.objects for delete to authenticated using (bucket_id='mr1-media' and (select public.mr1_is_admin()));

grant all on public.mr1_products,public.mr1_profiles,public.mr1_favorites,public.mr1_orders,public.mr1_site_settings,public.mr1_admins to service_role;
