/* Browser tests exercise the actual bundled Supabase SDK with controlled REST
   responses. PostgreSQL/RLS are independently tested against a real local DB. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve('_site');
const fixtureURL = 'https://tsrhrqwwunjyyujepppn.supabase.co';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
const mime = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png','.ttf':'font/ttf','.json':'application/json' };

function account(email) {
  const admin = email === 'owner@example.test';
  return { id:admin ? '33333333-3333-4333-8333-333333333333' : '11111111-1111-4111-8111-111111111111', email,
    aud:'authenticated', role:'authenticated', app_metadata:{provider:'email'}, user_metadata:{name:admin?'Gestor':'Cliente'}, identities:[], created_at:new Date().toISOString() };
}
function token(user) {
  return Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ ...user, sub:user.id, exp:Math.floor(Date.now()/1000)+3600 })).toString('base64url') + '.fixture';
}
function fromToken(header) {
  try { return JSON.parse(Buffer.from(header.split(' ')[1].split('.')[1], 'base64url')); } catch { return null; }
}

async function mockSupabase(context) {
  const products = JSON.parse(await fs.readFile('data/catalog.json','utf8')).products.map((p,n)=>({ ...p,old_price:p.oldPrice,measurements_confirmed:p.measurementsConfirmed,sort_order:n,created_at:new Date().toISOString() }));
  let settings = JSON.parse(await fs.readFile('data/site-settings.json','utf8')).settings;
  const favorites = new Set();
  let uploads = 0, orderWrites = 0;
  await context.route('**/config.js', r=>r.fulfill({contentType:'text/javascript',body:`window.MR1_CONFIG={supabaseUrl:${JSON.stringify(fixtureURL)},supabasePublishableKey:'sb_publishable_fixture'};`}));
  await context.route(fixtureURL+'/**', async route=>{
    const request=route.request(), url=new URL(request.url()), method=request.method();
    const actor=fromToken(request.headers().authorization || '');
    let body={}; try {body=request.postDataJSON() || {};}catch{}
    const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(url.pathname==='/auth/v1/signup') return json({user:account(body.email),session:null});
    if(url.pathname==='/auth/v1/token') {
      if(body.password!=='Fixture-password-123') return json({message:'Invalid login credentials',error_code:'invalid_credentials'},400);
      const user=account(body.email);return json({access_token:token(user),refresh_token:'fixture-refresh',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,token_type:'bearer',user});
    }
    if(url.pathname==='/auth/v1/user') return actor ? json(account(actor.email)) : json({message:'No session'},401);
    if(url.pathname==='/auth/v1/logout') return route.fulfill({status:204});
    if(url.pathname.endsWith('/rpc/mr1_is_admin')) return json(actor?.email==='owner@example.test');
    if(url.pathname.endsWith('/rpc/mr1_update_site_settings')) {
      if(actor?.email!=='owner@example.test') return json({code:'42501'},403);
      settings={...settings,...body.patch};return json(settings);
    }
    if(url.pathname==='/rest/v1/mr1_profiles') return json([{display_name:actor?.user_metadata?.name || 'Cliente'}]);
    if(url.pathname==='/rest/v1/mr1_site_settings') return json({data:settings});
    if(url.pathname==='/rest/v1/mr1_products') {
      const id=url.searchParams.get('id')?.replace(/^eq\./,'');
      if(method==='PATCH') {
        assert.equal(actor?.email,'owner@example.test');Object.assign(products.find(p=>p.id===id),body);
        return json(products.find(p=>p.id===id));
      }
      if(method==='POST') {const p={...body,id:'new-piece',sort_order:100};products.push(p);return json(p);}
      if(method==='DELETE') {products.splice(products.findIndex(p=>p.id===id),1);return route.fulfill({status:204});}
      return json(products);
    }
    if(url.pathname==='/rest/v1/mr1_favorites') {
      if(!actor)return json({code:'42501'},403);
      if(method==='POST'){assert.equal(body.user_id,actor.id);favorites.add(body.product_id);return json(null,201);}
      if(method==='DELETE'){favorites.delete(url.searchParams.get('product_id').replace(/^eq\./,''));return route.fulfill({status:204});}
      return json(products.filter(p=>favorites.has(p.id)).map(product=>({product})));
    }
    if(url.pathname==='/rest/v1/mr1_orders') {
      if(method!=='GET'){orderWrites++;return json({code:'42501'},403);}
      return json([]);
    }
    if(url.pathname.startsWith('/storage/v1/object/public/'))return route.fulfill({contentType:'image/png',body:png});
    if(url.pathname.startsWith('/storage/v1/object/')){assert.equal(actor?.email,'owner@example.test');uploads++;return json({Key:url.pathname.split('/object/')[1]});}
    throw Error('Endpoint inesperado: '+url.pathname);
  });
  return {products,favorites,get settings(){return settings},get uploads(){return uploads},get orderWrites(){return orderWrites}};
}

(async()=>{
  const server=http.createServer(async(req,res)=>{
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/demo-repository\//,'/');
    const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
    if(!file.startsWith(root+path.sep)){res.writeHead(404).end();return;}
    try {const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(data);} catch {res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const address=`http://127.0.0.1:${server.address().port}/demo-repository/`;
  const executable=process.env.BROWSER_BIN || (await fs.access('/usr/bin/chromium').then(()=>'/usr/bin/chromium').catch(()=>undefined));
  const browser=await chromium.launch({executablePath:executable,headless:true,args:['--no-sandbox']});
  try {
    for(const width of [1440,390]) {
      const context=await browser.newContext({viewport:{width,height:950}});
      const fixture=await mockSupabase(context);
      const page=await context.newPage();const errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.goto(address,{waitUntil:'networkidle'});
      await page.locator('.product-card').first().waitFor();assert.equal(await page.locator('.product-card').count(),6);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
      await page.locator('.favorite-button').first().click();
      await page.locator('[data-account-mode="register"]').click();
      await page.locator('#customer-name').fill('Cliente novo');await page.locator('#customer-email').fill('new@example.test');
      await page.locator('#customer-password').fill('Fixture-password-123');await page.locator('#customer-password-confirm').fill('Fixture-password-123');
      await page.locator('#customer-auth-form button[type=submit]').click();
      await page.waitForFunction(()=>document.querySelector('#account-message')?.textContent.includes('Confirme'));
      await page.locator('#customer-email').fill('client@example.test');await page.locator('#customer-password').fill('Fixture-password-123');
      await page.locator('#customer-auth-form button[type=submit]').click();
      await page.locator('.account-favorite').first().waitFor();assert.ok(fixture.favorites.has('tee-essential'));
      await page.locator('[data-account-tab="orders"]').click();await page.locator('.account-empty').waitFor();
      assert.match(await page.locator('#account-view').innerText(),/ainda não tem pedidos/);
      await page.locator('[data-account-tab="profile"]').click();await page.locator('[data-account-logout]').click();
      await page.locator('#customer-auth-form').waitFor();await page.locator('#account-close').click();
      await page.locator('.product-image-button').first().click();await page.locator('[data-size="M"]').click();await page.locator('[data-add-product]').click();
      await page.locator('#shipping-cep').fill('05879450');await page.locator('#shipping-form button').click();
      await page.waitForFunction(()=>document.querySelector('#shipping-result')?.textContent.includes('ainda não foi ativado'));
      assert.equal(await page.locator('.shipping-option').count(),0);assert.equal(fixture.orderWrites,0);
      await page.locator('#cart-close').click();await page.locator('#admin-button').click();
      await page.locator('#admin-email').fill('owner@example.test');await page.locator('#admin-password').fill('Fixture-password-123');
      await page.locator('#admin-auth-form button[type=submit]').click();await page.locator('#admin-workspace').waitFor();
      await page.locator('#site-settings-form input[name=brandName]').waitFor();
      await page.waitForFunction(()=>document.querySelector('#site-settings-form input[name=brandName]')?.value==='MR1 streetwear');
      await page.locator('#site-settings-form input[name=brandName]').fill('MR1 Teste');
      await page.locator('[data-color-hex="primaryColor"]').fill('#203040');
      await page.locator('#site-settings-form input[name=logoUrlFile]').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:png});
      await page.locator('#site-editor-save').click();
      await page.waitForFunction(()=>document.querySelector('#site-editor-feedback')?.textContent.includes('Pronto!'));
      assert.equal(fixture.settings.brandName,'MR1 Teste');assert.equal(fixture.settings.primaryColor,'#203040');assert.equal(fixture.uploads,1);
      assert.ok(fixture.settings.logoUrl.startsWith(fixtureURL+'/storage/v1/object/public/mr1-media/'));
      assert.equal(await page.title(),'MR1 Teste');
      assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()),'#203040');
      await page.locator('[data-admin-edit="tee-essential"]').click();await page.locator('#admin-form input[name=price]').fill('129.90');await page.locator('#admin-save').click();
      await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('Peça salva'));
      assert.equal(fixture.products[0].price,129.9);
      assert.deepEqual(errors,[]);
      await page.locator('#admin-close').click();await page.reload({waitUntil:'networkidle'});
      await page.waitForFunction(()=>document.title==='MR1 Teste');
      assert.equal(await page.locator('.product-card').count(),6);
      console.log(`PASS UI ${width}px: SDK Supabase, cadastro/confirmação, login, favoritos, carrinho, frete bloqueado, editor, upload e persistência.`);
      await context.close();
    }
  } finally {await browser.close();await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
