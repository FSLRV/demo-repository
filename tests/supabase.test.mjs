import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

const base = process.env.MR1_TEST_DATABASE_URL;
if (!base) throw new Error('Defina MR1_TEST_DATABASE_URL para um PostgreSQL de teste local; este teste cria e remove apenas seu próprio banco temporário.');
const parsed = new URL(base);
if (!['localhost','127.0.0.1','::1','[::1]'].includes(parsed.hostname)) throw new Error('Este teste só aceita banco local de teste.');
const name = 'mr1_rls_' + Date.now();
const owner = new pg.Client({ connectionString:base });
let db;
const alice='11111111-1111-4111-8111-111111111111', bob='22222222-2222-4222-8222-222222222222', admin='33333333-3333-4333-8333-333333333333';
test.before(async () => {
  await owner.connect();
  await owner.query('CREATE DATABASE ' + name);
  parsed.pathname='/' + name;
  db = new pg.Client({ connectionString:parsed.href }); await db.connect();
  await db.query(`
    do $$begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if; end$$;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
    create function storage.extension(text) returns text language sql immutable as $$select regexp_replace($1,'^.*[.]','')$$;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    grant all on storage.objects to anon,authenticated,service_role;
  `);
  for (const file of (await readdir('supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()) await db.query(await readFile('supabase/migrations/'+file,'utf8'));
  await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$4,now(),$5),($2,$6,now(),$5),($3,$7,now(),$5)',[alice,bob,admin,'alice@example.test','{"name":"Fixture"}','bob@example.test','owner@example.test']);
  await db.query('insert into public.mr1_admins(user_id) values($1)',[admin]);
});
test.after(async () => {
  await db?.end();
  await owner.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
  await owner.end();
});

async function asRole(role, id, action) {
  await db.query('begin');
  try {
    await db.query('set local role ' + role);
    await db.query("select set_config('request.jwt.claim.sub',$1,true)",[id || '']);
    const result = await action(db);
    await db.query('commit'); return result;
  } catch (error) { await db.query('rollback'); throw error; }
}
test('Anônimo lê catálogo, mas não altera preços ou configurações', async () => {
  assert.equal((await asRole('anon','',c=>c.query('select * from public.mr1_products'))).rowCount,6);
  await assert.rejects(asRole('anon','',c=>c.query('update public.mr1_products set price=1')),/permission denied/);
  await assert.rejects(asRole('anon','',c=>c.query(`update public.mr1_site_settings set data='{}'`)),/permission denied/);
});
test('Cliente não se promove a administrador e não altera o catálogo', async () => {
  assert.equal((await asRole('authenticated',alice,c=>c.query('select public.mr1_is_admin() as allowed'))).rows[0].allowed,false);
  await assert.rejects(asRole('authenticated',alice,c=>c.query('insert into public.mr1_admins(user_id) values($1)',[alice])),/permission denied/);
  assert.equal((await asRole('authenticated',alice,c=>c.query('update public.mr1_products set price=1'))).rowCount,0);
  await assert.rejects(asRole('authenticated',alice,c=>c.query("select public.mr1_update_site_settings('{\"brandName\":\"Invasão\"}')")),/insufficient_privilege|permission denied/);
});
test('Favoritos pertencem somente ao cliente autenticado', async () => {
  await asRole('authenticated',alice,c=>c.query("insert into public.mr1_favorites(user_id,product_id) values($1,'tee-essential')",[alice]));
  assert.equal((await asRole('authenticated',alice,c=>c.query('select * from public.mr1_favorites'))).rowCount,1);
  assert.equal((await asRole('authenticated',bob,c=>c.query('select * from public.mr1_favorites'))).rowCount,0);
  await assert.rejects(asRole('authenticated',bob,c=>c.query("insert into public.mr1_favorites(user_id,product_id) values($1,'cargo-utility')",[alice])),/row-level security/);
  assert.equal((await asRole('authenticated',bob,c=>c.query('delete from public.mr1_favorites where user_id=$1',[alice]))).rowCount,0);
});
test('Pedidos privados não podem ser fabricados nem marcados como pagos pelo navegador', async () => {
  await db.query("insert into public.mr1_orders(customer_id,status,items,customer,subtotal_cents,shipping_cents,total_cents) values($1,'pending','[{\"id\":\"tee-essential\",\"name\":\"Peça\",\"quantity\":1,\"unitPrice\":14990}]','{}',14990,0,14990)",[alice]);
  assert.equal((await asRole('authenticated',alice,c=>c.query('select * from public.mr1_orders'))).rowCount,1);
  assert.equal((await asRole('authenticated',bob,c=>c.query('select * from public.mr1_orders'))).rowCount,0);
  assert.equal((await asRole('authenticated',admin,c=>c.query('select * from public.mr1_orders'))).rowCount,1);
  await assert.rejects(asRole('authenticated',alice,c=>c.query("update public.mr1_orders set status='paid'")),/permission denied/);
  await assert.rejects(asRole('authenticated',admin,c=>c.query("update public.mr1_orders set status='paid'")),/permission denied/);
  await assert.rejects(asRole('anon','',c=>c.query('select * from public.mr1_orders')),/permission denied/);
});
test('Administrador altera textos e cores; patches parciais preservam campos e bloqueiam CSS inválido', async () => {
  const original = (await db.query("select data from public.mr1_site_settings where id='default'")).rows[0].data;
  await asRole('authenticated',admin,c=>c.query("select public.mr1_update_site_settings('{\"brandName\":\"MR1 Editada\",\"primaryColor\":\"#203040\"}')"));
  const changed = (await db.query("select data from public.mr1_site_settings where id='default'")).rows[0].data;
  assert.equal(changed.brandName,'MR1 Editada'); assert.equal(changed.heroImage,original.heroImage);
  await assert.rejects(asRole('authenticated',admin,c=>c.query("select public.mr1_update_site_settings('{\"primaryColor\":\"red;display:none\"}')")),/Invalid color/);
  await assert.rejects(asRole('authenticated',admin,c=>c.query("select public.mr1_update_site_settings('{\"service_role\":\"no\"}')")),/Invalid store setting/);
});
test('Uploads são permitidos apenas ao administrador em seu diretório', async () => {
  await assert.rejects(asRole('authenticated',alice,c=>c.query("insert into storage.objects(bucket_id,name) values('mr1-media',$1)",[alice+'/file.png'])),/row-level security/);
  await asRole('authenticated',admin,c=>c.query("insert into storage.objects(bucket_id,name) values('mr1-media',$1)",[admin+'/file.png']));
  await assert.rejects(asRole('authenticated',admin,c=>c.query("insert into storage.objects(bucket_id,name) values('mr1-media',$1)",[admin+'/file.svg'])),/row-level security/);
  await assert.rejects(asRole('authenticated',admin,c=>c.query("insert into storage.objects(bucket_id,name) values('mr1-media',$1)",[alice+'/file.png'])),/row-level security/);
});

test('Bootstrap só autoriza o e-mail escolhido após confirmação e não permite reivindicação por clientes', async () => {
  await assert.rejects(asRole('authenticated',alice,c=>c.query('select public.mr1_claim_owner($1)',[alice])),/permission denied/);
  await assert.rejects(asRole('authenticated',alice,c=>c.query('select * from public.mr1_owner_bootstrap')),/permission denied/);
  await db.query('begin');
  try {
    await db.query('delete from public.mr1_admins');
    await db.query("insert into public.mr1_owner_bootstrap(id,email_sha256) values('owner',encode(sha256(convert_to('owner-new@example.test','UTF8')),'hex'))");
    const id='44444444-4444-4444-8444-444444444444';
    await db.query("insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,'owner-new@example.test',null,'{\"role\":\"admin\"}')",[id]);
    assert.equal((await db.query('select count(*)::int as count from public.mr1_admins')).rows[0].count,0);
    assert.equal((await db.query('select public.mr1_claim_owner($1) as claimed',[alice])).rows[0].claimed,false);
    assert.equal((await db.query('select public.mr1_claim_owner($1) as claimed',[id])).rows[0].claimed,false);
    await db.query('update auth.users set email_confirmed_at=now() where id=$1',[id]);
    assert.equal((await db.query('select user_id from public.mr1_admins')).rows[0].user_id,id);
    assert.equal((await db.query('select public.mr1_claim_owner($1) as claimed',[id])).rows[0].claimed,false);
    assert.ok((await db.query("select claimed_at from public.mr1_owner_bootstrap where id='owner'")).rows[0].claimed_at);
  } finally { await db.query('rollback'); }
});
