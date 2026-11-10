-- Manual Pix and Correios counter service. Every request is reviewed by the
-- owner before payment; browser-supplied prices and delivery claims are ignored.
alter table public.mr1_orders drop constraint mr1_orders_status_check;
alter table public.mr1_orders add constraint mr1_orders_status_check check (status in
  ('creating','pending','payment_pending','payment_in_process','payment_unconfirmed','paid','paid_review','cancelled','expired','rejected','refunded','charged_back',
   'awaiting_review','awaiting_payment','payment_reported','shipped','delivered'));
alter table public.mr1_orders
  add column manual_flow boolean not null default false,
  add column shipping_pending boolean not null default false,
  add column pix_payload text,
  add column stock_reserved boolean not null default false,
  add column tracking_code text,
  add column request_key uuid,
  add column updated_at timestamptz not null default now();
create unique index mr1_manual_request_key on public.mr1_orders(customer_id,request_key);

-- Validate the Pix BR Code, including CRC and the fixed BRL amount, on the DB.
create function public.mr1_pix_cents(payload text) returns bigint
language plpgsql immutable set search_path = '' as $$
declare i integer := 1; n integer; tag text; value text; fields jsonb := '{}';
  crc integer := 65535; data bytea; j integer; k integer;
begin
  if payload is null or length(payload) not between 50 and 2048 or payload !~ '^[ -~]+$'
     or right(payload,8) !~ '^6304[0-9A-Fa-f]{4}$' then
    raise exception 'Pix inválido. Cole o código completo gerado pelo banco.' using errcode='22023';
  end if;
  while i <= length(payload) loop
    if substring(payload,i,4) !~ '^[0-9]{4}$' then
      raise exception 'Pix inválido.' using errcode='22023';
    end if;
    tag := substring(payload,i,2); n := substring(payload,i+2,2)::integer;
    if i+3+n > length(payload) or fields ? tag then
      raise exception 'Pix inválido.' using errcode='22023';
    end if;
    value := substring(payload,i+4,n); fields := fields || jsonb_build_object(tag,value); i := i+4+n;
  end loop;
  data := convert_to(left(payload,length(payload)-4),'UTF8');
  for j in 0..length(data)-1 loop
    crc := crc # (get_byte(data,j) << 8);
    for k in 1..8 loop
      crc := case when (crc & 32768) <> 0 then ((crc << 1) # 4129) & 65535 else (crc << 1) & 65535 end;
    end loop;
  end loop;
  if upper(right(payload,4)) <> upper(lpad(to_hex(crc),4,'0')) or fields->>'00' is distinct from '01'
     or fields->>'53' is distinct from '986' or fields->>'58' is distinct from 'BR'
     or position('br.gov.bcb.pix' in lower(payload)) = 0 then
    raise exception 'Pix inválido. Confira o código gerado pelo banco.' using errcode='22023';
  end if;
  if coalesce(fields->>'54','') !~ '^[0-9]{1,9}[.][0-9]{2}$' then
    raise exception 'Gere um Pix com valor fixo, igual ao total do pedido com frete.' using errcode='22023';
  end if;
  return ((fields->>'54')::numeric * 100)::bigint;
end;
$$;
revoke all on function public.mr1_pix_cents(text) from public,anon,authenticated;

create function public.mr1_request_order(lines jsonb, details jsonb, request_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); result uuid; line jsonb; p public.mr1_products;
  qty integer; subtotal bigint := 0; snapshot jsonb := '[]'; contact jsonb; address jsonb;
  field text; email text; seen text[] := '{}'; line_key text;
begin
  if actor is null then raise exception 'Entre na sua conta.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtext('mr1-request:'||actor::text));
  select id into result from public.mr1_orders where customer_id=actor and request_key=request_id;
  if found then return jsonb_build_object('orderId',result,'manual',true); end if;
  select u.email into email from auth.users u where u.id=actor and u.email_confirmed_at is not null;
  if email is null then raise exception 'Confirme o e-mail da sua conta.' using errcode='22023'; end if;
  if request_id is null or jsonb_typeof(lines) is distinct from 'array' or jsonb_array_length(lines) not between 1 and 30 then
    raise exception 'Revise as peças da sacola.' using errcode='22023';
  end if;
  if (select count(*) from public.mr1_orders where customer_id=actor and manual_flow and status in ('awaiting_review','awaiting_payment','payment_reported')) >= 10 then
    raise exception 'Você já tem dez pedidos em andamento. Aguarde a loja.' using errcode='22023';
  end if;
  if jsonb_typeof(details) is distinct from 'object' or jsonb_typeof(details->'address') is distinct from 'object' then
    raise exception 'Informe o endereço de entrega.' using errcode='22023';
  end if;
  address := details->'address';
  foreach field in array array['street','number','neighborhood','city','state','cep'] loop
    if jsonb_typeof(address->field) is distinct from 'string' or length(trim(address->>field)) not between 1 and 160 then
      raise exception 'Revise o endereço de entrega.' using errcode='22023';
    end if;
  end loop;
  if address->>'cep' !~ '^[0-9]{8}$' or address->>'cep' ~ '^([0-9])\1{7}$'
     or address->>'state' !~ '^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$'
     or length(coalesce(details->>'name','')) not between 3 and 120
     or regexp_replace(coalesce(details->>'phone',''),'[^0-9]','','g') !~ '^[0-9]{10,13}$'
     or length(coalesce(address->>'complement','')) > 100 then
    raise exception 'Revise seu nome, celular e endereço.' using errcode='22023';
  end if;
  contact := jsonb_build_object('name',trim(details->>'name'),'phone',details->>'phone','email',email,'address',
    jsonb_build_object('street',trim(address->>'street'),'number',trim(address->>'number'),'neighborhood',trim(address->>'neighborhood'),
      'city',trim(address->>'city'),'state',address->>'state','cep',address->>'cep','complement',coalesce(address->>'complement','')));
  for line in select value from jsonb_array_elements(lines) loop
    if jsonb_typeof(line->'quantity') is distinct from 'number' or line->>'quantity' !~ '^[1-9][0-9]{0,2}$' then
      raise exception 'Quantidade inválida.' using errcode='22023';
    end if;
    qty := (line->>'quantity')::integer;
    select * into p from public.mr1_products where id=line->>'id';
    line_key := coalesce(line->>'id','')||':'||coalesce(line->>'size','');
    if not found or not coalesce((line->>'size')=any(p.sizes),false) or p.stock < qty or line_key=any(seen) then
      raise exception 'Peça, tamanho ou estoque indisponível. Atualize a sacola.' using errcode='22023';
    end if;
    seen := array_append(seen,line_key);
    snapshot := snapshot || jsonb_build_array(jsonb_build_object('id',p.id,'name',p.name,'size',line->>'size','quantity',qty,'unitPrice',(p.price*100)::bigint));
    subtotal := subtotal + (p.price*100)::bigint * qty;
  end loop;
  insert into public.mr1_orders(customer_id,status,items,customer,subtotal_cents,shipping_cents,total_cents,manual_flow,shipping_pending,request_key)
    values(actor,'awaiting_review',snapshot,contact,subtotal,0,subtotal,true,true,request_id) returning id into result;
  return jsonb_build_object('orderId',result,'manual',true);
end;
$$;
revoke all on function public.mr1_request_order(jsonb,jsonb,uuid) from public,anon;
grant execute on function public.mr1_request_order(jsonb,jsonb,uuid) to authenticated;

create function public.mr1_prepare_manual_payment(order_id uuid, freight_cents bigint, delivery_days integer, pix text, confirmed boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.mr1_orders; entry record; available_stock integer; capital boolean;
begin
  if not public.mr1_is_admin() then raise exception 'Acesso restrito.' using errcode='42501'; end if;
  select * into o from public.mr1_orders where id=order_id for update;
  if not found or not o.manual_flow or o.status <> 'awaiting_review' then
    raise exception 'O pedido já foi atualizado. Recarregue os detalhes.' using errcode='22023';
  end if;
  capital := upper(trim(o.customer#>>'{address,city}')) in ('SÃO PAULO','SAO PAULO') and o.customer#>>'{address,state}'='SP'
    and (o.customer#>>'{address,cep}' between '01000000' and '05999999' or o.customer#>>'{address,cep}' between '08000000' and '08499999');
  if confirmed is distinct from true or freight_cents is null or freight_cents < 0 or freight_cents > 1000000
     or delivery_days is null or delivery_days not between 1 and 90 or (capital and freight_cents <> 0) or (not capital and freight_cents <= 0) then
    raise exception 'Confira o município e o frete: capital gratuita, demais destinos com valor dos Correios. Informe prazo de 1 a 90 dias úteis.' using errcode='22023';
  end if;
  if public.mr1_pix_cents(pix) <> o.subtotal_cents + freight_cents then
    raise exception 'O valor do Pix precisa ser igual ao total das peças mais o frete.' using errcode='22023';
  end if;
  -- Same lock order for every reservation; each product has stock shared by sizes.
  for entry in select v->>'id' as id,sum((v->>'quantity')::integer)::integer as qty from jsonb_array_elements(o.items) v group by v->>'id' order by v->>'id' loop
    select p.stock into available_stock from public.mr1_products p where p.id=entry.id for update;
    if not found or available_stock < entry.qty then raise exception 'Estoque insuficiente. Confira a coleção antes de liberar o Pix.' using errcode='22023'; end if;
    update public.mr1_products set stock=available_stock-entry.qty where id=entry.id;
  end loop;
  update public.mr1_orders set status='awaiting_payment',shipping_cents=freight_cents,total_cents=subtotal_cents+freight_cents,
    shipping_pending=false,pix_payload=pix,stock_reserved=true,updated_at=now(),
    shipping_service=jsonb_build_object('company',case when capital then 'MR1' else 'Correios' end,
      'name',case when capital then 'Entrega gratuita — São Paulo capital' else 'Postagem na agência' end,'deliveryDays',delivery_days,'capital',capital)
    where id=order_id;
end;
$$;
revoke all on function public.mr1_prepare_manual_payment(uuid,bigint,integer,text,boolean) from public,anon;
grant execute on function public.mr1_prepare_manual_payment(uuid,bigint,integer,text,boolean) to authenticated;

create function public.mr1_report_pix(order_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.mr1_orders set status='payment_reported',updated_at=now()
    where id=order_id and customer_id=auth.uid() and manual_flow and status='awaiting_payment';
  if not found then raise exception 'Pedido indisponível para esta ação.' using errcode='22023'; end if;
end;
$$;
revoke all on function public.mr1_report_pix(uuid) from public,anon;
grant execute on function public.mr1_report_pix(uuid) to authenticated;

create function public.mr1_manage_manual_order(order_id uuid, action text, tracking text default '', confirmed boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare o public.mr1_orders; entry record;
begin
  if not public.mr1_is_admin() then raise exception 'Acesso restrito.' using errcode='42501'; end if;
  select * into o from public.mr1_orders where id=order_id for update;
  if not found or not o.manual_flow or confirmed is distinct from true then
    raise exception 'Confira o pedido e confirme a ação.' using errcode='22023';
  end if;
  if action='paid' and o.status in ('awaiting_payment','payment_reported') and o.stock_reserved then
    update public.mr1_orders set status='paid',updated_at=now() where id=order_id;
  elsif action='shipped' and o.status='paid' and coalesce(tracking,'') ~ '^[A-Z]{2}[0-9]{9}BR$' then
    update public.mr1_orders set status='shipped',tracking_code=tracking,updated_at=now() where id=order_id;
  elsif action='delivered' and o.status in ('paid','shipped') then
    update public.mr1_orders set status='delivered',updated_at=now() where id=order_id;
  elsif action='cancelled' and o.status in ('awaiting_review','awaiting_payment','payment_reported') then
    if o.stock_reserved then
      for entry in select v->>'id' as id,sum((v->>'quantity')::integer)::integer as qty from jsonb_array_elements(o.items) v group by v->>'id' order by v->>'id' loop
        update public.mr1_products set stock=stock+entry.qty where id=entry.id;
      end loop;
    end if;
    update public.mr1_orders set status='cancelled',stock_reserved=false,pix_payload=null,updated_at=now() where id=order_id;
  else raise exception 'Ação incompatível com o status atual. Recarregue o pedido.' using errcode='22023';
  end if;
end;
$$;
revoke all on function public.mr1_manage_manual_order(uuid,text,text,boolean) from public,anon;
grant execute on function public.mr1_manage_manual_order(uuid,text,text,boolean) to authenticated;
