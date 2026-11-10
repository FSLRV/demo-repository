import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import fixture from './pix-fixture.cjs';

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

const manualDetails = (city='São Paulo', cep='05879450', state='SP') => ({ name:'Cliente de teste', email:'forged@example.test', phone:'11999999999', address:{street:'Rua de teste',number:'123',neighborhood:'Bairro',city,state,cep} });
async function requestOrder(details=manualDetails(), lines=[{id:'tee-essential',size:'M',quantity:1,unitPrice:1}], key=randomUUID()) {
  const result=await asRole('authenticated',alice,c=>c.query('select public.mr1_request_order($1,$2,$3) as result',[JSON.stringify(lines),JSON.stringify(details),key]));
  return result.rows[0].result.orderId;
}
async function prepare(id, freight, amount, actor=admin) {
  return asRole('authenticated',actor,c=>c.query('select public.mr1_prepare_manual_payment($1,$2,5,$3,true)',[id,freight,fixture.pix(amount)]));
}
async function manage(id, action, actor=admin, tracking='') {
  return asRole('authenticated',actor,c=>c.query('select public.mr1_manage_manual_order($1,$2,$3,true)',[id,action,tracking]));
}
async function orderRow(id) { return (await db.query('select * from public.mr1_orders where id=$1',[id])).rows[0]; }

test('Pedido manual usa preços e identidade do banco e é idempotente; não reserva antes da conferência', async () => {
  const stock=(await db.query("select stock from public.mr1_products where id='tee-essential'")).rows[0].stock;
  const key=randomUUID(), id=await requestOrder(undefined,undefined,key);
  assert.equal(await requestOrder(undefined,undefined,key),id);
  const row=await orderRow(id);
  assert.equal(row.subtotal_cents,'14990'); assert.equal(row.customer.email,'alice@example.test');
  assert.equal(row.status,'awaiting_review'); assert.equal(row.shipping_pending,true); assert.equal(row.stock_reserved,false);
  assert.equal((await db.query("select stock from public.mr1_products where id='tee-essential'")).rows[0].stock,stock);
  await assert.rejects(asRole('anon','',c=>c.query('select public.mr1_request_order($1,$2,$3)',['[]','{}',randomUUID()])),/permission denied/);
  await assert.rejects(requestOrder(undefined,[{id:'tee-essential',size:'ZZ',quantity:1}]),/indisponível/);
  await assert.rejects(requestOrder(undefined,[{id:'tee-essential',size:'M',quantity:1},{id:'tee-essential',size:'M',quantity:1}]),/indisponível/);
});

test('Só administrador libera Pix; capital gratuita, total e checksum validados; reserva atômica', async () => {
  const id=await requestOrder();
  await assert.rejects(prepare(id,0,149.9,alice),/Acesso restrito/);
  await assert.rejects(prepare(id,1000,159.9),/capital gratuita/);
  await assert.rejects(prepare(id,0,1),/valor do Pix/);
  const broken=fixture.pix(149.9).slice(0,-4)+'0000';
  await assert.rejects(asRole('authenticated',admin,c=>c.query('select public.mr1_prepare_manual_payment($1,0,5,$2,true)',[id,broken])),/Pix inválido/);
  assert.equal((await orderRow(id)).stock_reserved,false);
  const before=(await db.query("select stock from public.mr1_products where id='tee-essential'")).rows[0].stock;
  await prepare(id,0,149.9);
  assert.equal((await orderRow(id)).status,'awaiting_payment');
  assert.equal((await orderRow(id)).shipping_cents,'0');
  assert.equal((await db.query("select stock from public.mr1_products where id='tee-essential'")).rows[0].stock,before-1);
  await assert.rejects(prepare(id,0,149.9),/já foi atualizado/);
});

test('Correios fora da capital exige frete antes do Pix; aviso do cliente não confirma pagamento', async () => {
  const id=await requestOrder(manualDetails('Osasco','06010000'));
  await assert.rejects(prepare(id,0,149.9),/demais destinos/);
  await prepare(id,2390,173.8);
  const row=await orderRow(id); assert.equal(row.total_cents,'17380'); assert.equal(row.shipping_service.company,'Correios');
  await assert.rejects(asRole('authenticated',bob,c=>c.query('select public.mr1_report_pix($1)',[id])),/indisponível/);
  await asRole('authenticated',alice,c=>c.query('select public.mr1_report_pix($1)',[id]));
  assert.equal((await orderRow(id)).status,'payment_reported');
  await assert.rejects(manage(id,'paid',alice),/Acesso restrito/);
  assert.equal((await asRole('authenticated',bob,c=>c.query('select pix_payload from public.mr1_orders where id=$1',[id]))).rowCount,0);
  await manage(id,'paid'); assert.equal((await orderRow(id)).status,'paid');
  await assert.rejects(manage(id,'cancelled'),/incompatível/);
  await assert.rejects(manage(id,'shipped',admin,'wrong'),/incompatível/);
  await manage(id,'shipped',admin,'AA123456789BR');
  assert.equal((await orderRow(id)).tracking_code,'AA123456789BR');
  await manage(id,'delivered'); assert.equal((await orderRow(id)).status,'delivered');
});

test('Cancelar libera estoque uma única vez; reserva considera quantidades do mesmo produto em vários tamanhos', async () => {
  const before=(await db.query("select stock from public.mr1_products where id='tee-essential'")).rows[0].stock;
  const id=await requestOrder(undefined,[{id:'tee-essential',size:'M',quantity:1},{id:'tee-essential',size:'G',quantity:1}]);
  await prepare(id,0,299.8);
  assert.equal((await db.query("select stock from public.mr1_products where id='tee-essential'")).rows[0].stock,before-2);
  await manage(id,'cancelled');
  assert.equal((await db.query("select stock from public.mr1_products where id='tee-essential'")).rows[0].stock,before);
  assert.equal((await orderRow(id)).pix_payload,null);
  await assert.rejects(manage(id,'cancelled'),/incompatível/);
  assert.equal((await db.query("select stock from public.mr1_products where id='tee-essential'")).rows[0].stock,before);
});

test('Duas liberações simultâneas de Pix não vendem a mesma última peça', async () => {
  await db.query("insert into public.mr1_products(id,name,category,price,image,sizes,stock,weight,width,height,length) values('last-piece','Última peça','camisetas',10,'assets/tee-essential.jpg',array['M'],1,0.3,20,4,30)");
  const lines=[{id:'last-piece',size:'M',quantity:1}];
  const first=await requestOrder(undefined,lines), second=await requestOrder(undefined,lines);
  async function reserve(id) {
    const connection=new pg.Client({connectionString:parsed.href});await connection.connect();
    try {
      await connection.query('begin');await connection.query('set local role authenticated');
      await connection.query("select set_config('request.jwt.claim.sub',$1,true)",[admin]);
      await connection.query('select public.mr1_prepare_manual_payment($1,0,5,$2,true)',[id,fixture.pix(10)]);
      await connection.query('commit');
    } catch(error) {await connection.query('rollback');throw error;}
    finally {await connection.end();}
  }
  const results=await Promise.allSettled([reserve(first),reserve(second)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/Estoque insuficiente/);
  assert.equal((await db.query("select stock from public.mr1_products where id='last-piece'")).rows[0].stock,0);
  const rows=(await db.query('select status from public.mr1_orders where id=any($1::uuid[])',[[first,second]])).rows;
  assert.deepEqual(rows.map(r=>r.status).sort(),['awaiting_payment','awaiting_review']);
});
