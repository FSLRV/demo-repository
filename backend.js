/* Browser adapter: GitHub Pages serves files; Supabase enforces data access. */
(() => {
  'use strict';
  const config = window.MR1_CONFIG || {};
  const ready = Boolean(config.supabaseUrl && config.supabasePublishableKey);
  let instance;
  function client() {
    if (!ready) throw problem(503, 'A conexão da loja com o Supabase ainda está sendo configurada.', 'supabase_not_configured');
    if (!window.SupabaseSDK?.createClient) throw problem(503, 'Recarregue a página para carregar a conexão da loja.', 'sdk_unavailable');
    if (!instance) {
      instance = window.SupabaseSDK.createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
      });
      instance.auth.onAuthStateChange(() => setTimeout(() => document.dispatchEvent(new CustomEvent('mr1:auth-changed')), 0));
    }
    return instance;
  }
  function problem(status, message, code) { return Object.assign(new Error(message), { status, code }); }
  function check(result) {
    if (!result.error) return result.data;
    const error = result.error;
    if (error.code === '42501') throw problem(403, 'Sua conta não tem permissão para esta operação.', 'permission_denied');
    if (error.code === '23505') throw problem(409, 'Este cadastro já existe. Recarregue as informações e tente novamente.', 'duplicate');
    if (error.code === '23503') throw problem(409, 'A peça não está mais disponível.', 'product_not_found');
    if (error.code === '23514' || error.code === '22023') throw problem(422, 'Revise os dados informados antes de salvar.', 'invalid_data');
    if (['42P01', 'PGRST205', 'PGRST202'].includes(error.code)) throw problem(503, 'A configuração do banco da loja ainda não foi concluída.', 'schema_not_ready');
    if (error.status === 429) throw problem(429, 'Muitas tentativas. Aguarde alguns minutos antes de tentar novamente.', 'rate_limited');
    if (/invalid login credentials/i.test(error.message || '')) throw problem(401, 'E-mail ou senha inválidos.', 'invalid_credentials');
    if (/email not confirmed/i.test(error.message || '')) throw problem(401, 'Confirme seu e-mail antes de entrar na conta.', 'email_not_confirmed');
    if (/password/i.test(error.message || '')) throw problem(422, 'Use uma senha de pelo menos 12 caracteres.', 'invalid_password');
    throw problem(503, 'Não foi possível concluir a operação na loja. Tente novamente em instantes.', 'supabase_error');
  }
  async function user(required = false) {
    const sdk = client();
    const session = check(await sdk.auth.getSession());
    if (!session.session) {
      if (required) throw problem(401, 'Entre na sua conta para continuar.', 'authentication_required');
      return null;
    }
    const result = await sdk.auth.getUser();
    if (result.error || !result.data.user) throw problem(401, 'Sua sessão expirou. Entre novamente.', 'authentication_required');
    return result.data.user;
  }
  async function isAdmin() {
    if (!await user()) return false;
    return check(await client().rpc('mr1_is_admin')) === true;
  }
  async function requireAdmin() {
    const account = await user(true);
    if (!await isAdmin()) throw problem(403, 'Sua conta não tem acesso à administração da loja.', 'administrator_required');
    return account;
  }
  async function session(admin = false) {
    if (!ready) return { authenticated: false, adminConfigured: false, requiresSupabase: true };
    const account = await user();
    if (!account || (admin && !await isAdmin())) return { authenticated: false, adminConfigured: true };
    const profile = check(await client().from('mr1_profiles').select('display_name').eq('user_id', account.id).maybeSingle());
    return { authenticated: true, adminConfigured: true, id: account.id, email: account.email, name: profile?.display_name || account.user_metadata?.name || 'Cliente', csrfToken: 'supabase-bearer-session' };
  }
  function product(row) {
    return { id: row.id, name: row.name, category: row.category, price: Number(row.price), oldPrice: row.old_price === null ? null : Number(row.old_price), image: row.image,
      sizes: row.sizes, stock: row.stock, color: row.color, badge: row.badge, description: row.description,
      weight: row.weight, width: row.width, height: row.height, length: row.length, measurementsConfirmed: row.measurements_confirmed };
  }
  function productInput(value) {
    return { name: value.name, category: value.category, price: value.price, old_price: value.oldPrice ?? null, image: value.image, sizes: value.sizes,
      stock: value.stock, color: value.color || '#142B49', badge: value.badge || '', description: value.description || '',
      weight: value.weight, width: value.width, height: value.height, length: value.length, measurements_confirmed: value.measurementsConfirmed === true };
  }
  function order(row, details = false) {
    return { id: row.id, status: row.status, created: Math.floor(Date.parse(row.created_at) / 1000), subtotal: row.subtotal_cents / 100,
      shipping: row.shipping_cents / 100, total: row.total_cents / 100,
      items: (row.items || []).map((item) => ({ ...item, unitPrice: item.unitPrice / 100 })),
      ...(details ? { customer: row.customer, shippingService: row.shipping_service } : {}) };
  }
  async function fallback(file) {
    const response = await fetch(new URL(file, document.baseURI), { cache: 'no-cache' });
    if (!response.ok) throw problem(503, 'Não foi possível carregar a coleção.', 'catalog_unavailable');
    return response.json();
  }
  async function upload(value) {
    const account = await requireAdmin();
    const match = typeof value.dataUrl === 'string' && value.dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!match || value.dataUrl.length > 2_800_000) throw problem(422, 'Use uma imagem JPG, PNG ou WebP de até 2 MB.', 'invalid_upload');
    let bytes;
    try { bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0)); } catch { throw problem(422, 'Arquivo de imagem inválido.', 'invalid_upload'); }
    const type = match[1];
    const magic = type === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : type === 'png' ? [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)
      : String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
    if (!magic || bytes.length < 12 || bytes.length > 2_000_000) throw problem(422, 'A foto não corresponde ao formato informado ou excede 2 MB.', 'invalid_upload');
    const filename = `${account.id}/${crypto.randomUUID()}.${type === 'jpeg' ? 'jpg' : type}`;
    check(await client().storage.from('mr1-media').upload(filename, new Blob([bytes], { type: 'image/' + type }), { contentType: 'image/' + type, cacheControl: '3600', upsert: false }));
    return { url: client().storage.from('mr1-media').getPublicUrl(filename).data.publicUrl };
  }
  async function route(path, method, body, signal, headers) {
    const url = new URL(path, location.href);
    const pathname = url.pathname;
    if (pathname === '/api/config') return { database: { provider: 'supabase', configured: ready }, preview: !ready,
      payment: { provider: 'unconfigured', configured: false }, shipping: { provider: 'unconfigured', configured: false, origin: '05879450' },
      publicUrlConfigured: location.protocol === 'https:', checkoutReady: false };
    if (pathname === '/api/products' && method === 'GET') {
      if (!ready) return fallback('data/catalog.json');
      return { products: check(await client().from('mr1_products').select('*').order('sort_order').order('created_at').abortSignal(signal || new AbortController().signal)).map(product) };
    }
    if (pathname === '/api/site/settings' && method === 'GET') {
      if (!ready) return fallback('data/site-settings.json');
      const row = check(await client().from('mr1_site_settings').select('data').eq('id', 'default').single());
      return { settings: row.data };
    }
    if (pathname === '/api/site/settings' && method === 'PUT') {
      await requireAdmin();
      return { settings: check(await client().rpc('mr1_update_site_settings', { patch: body })) };
    }
    if (pathname === '/api/session') return session(true);
    if (pathname === '/api/account/session') return session(false);
    if (pathname === '/api/login' && method === 'POST') {
      check(await client().auth.signInWithPassword({ email: String(body.email || '').trim(), password: body.password || '' }));
      await requireAdmin();
      return session(true);
    }
    if (pathname === '/api/account/login' && method === 'POST') {
      check(await client().auth.signInWithPassword({ email: String(body.email || '').trim(), password: body.password || '' }));
      return session(false);
    }
    if (pathname === '/api/account/register' && method === 'POST') {
      if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.length > 100 || typeof body.password !== 'string' || body.password.length < 12) throw problem(422, 'Informe seu nome e uma senha de pelo menos 12 caracteres.', 'invalid_account');
      const data = check(await client().auth.signUp({ email: String(body.email || '').trim(), password: body.password,
        options: { data: { name: body.name.trim() }, emailRedirectTo: new URL('./', document.baseURI).href } }));
      return data.session ? session(false) : { authenticated: false, confirmationRequired: true };
    }
    if (['/api/logout', '/api/account/logout'].includes(pathname) && method === 'POST') {
      check(await client().auth.signOut());
      return { authenticated: false };
    }
    if (pathname === '/api/products' && method === 'POST') {
      await requireAdmin();
      return { product: product(check(await client().from('mr1_products').insert(productInput(body)).select('*').single())) };
    }
    const item = pathname.match(/^\/api\/products\/([a-zA-Z0-9_-]{1,80})$/);
    if (item && ['PUT', 'DELETE'].includes(method)) {
      await requireAdmin();
      if (method === 'DELETE') { check(await client().from('mr1_products').delete().eq('id', item[1])); return { deleted: true }; }
      return { product: product(check(await client().from('mr1_products').update(productInput(body)).eq('id', item[1]).select('*').single())) };
    }
    if (pathname === '/api/uploads' && method === 'POST') return upload(body);
    if (pathname === '/api/account/favorites' && method === 'GET') {
      const account = await user(true);
      const rows = check(await client().from('mr1_favorites').select('product:mr1_products(*)').eq('user_id', account.id).order('created_at', { ascending: false }));
      return { products: rows.filter((r) => r.product).map((r) => product(r.product)) };
    }
    const favorite = pathname.match(/^\/api\/account\/favorites\/([a-zA-Z0-9_-]{1,80})$/);
    if (favorite && ['PUT', 'DELETE'].includes(method)) {
      const account = await user(true);
      if (method === 'PUT') check(await client().from('mr1_favorites').upsert({ user_id: account.id, product_id: favorite[1] }, { onConflict: 'user_id,product_id', ignoreDuplicates: true }));
      else check(await client().from('mr1_favorites').delete().eq('user_id', account.id).eq('product_id', favorite[1]));
      return { favorited: method === 'PUT', productId: favorite[1] };
    }
    if (pathname === '/api/account/orders' && method === 'GET') {
      const account = await user(true);
      const rows = check(await client().from('mr1_orders').select('id,status,created_at,subtotal_cents,shipping_cents,total_cents,items').eq('customer_id', account.id).order('created_at', { ascending: false }).limit(100));
      return { orders: rows.map((row) => order(row)) };
    }
    if (pathname === '/api/admin/orders' && method === 'GET') {
      await requireAdmin();
      const rows = check(await client().from('mr1_orders').select('id,status,created_at,subtotal_cents,shipping_cents,total_cents,items').order('created_at', { ascending: false }).limit(100));
      return { orders: rows.map((row) => order(row)) };
    }
    const details = pathname.match(/^\/api\/(admin\/orders|account\/orders)\/([0-9a-f-]{32,36})$/);
    if (details && method === 'GET') {
      if (details[1] === 'admin/orders') await requireAdmin(); else await user(true);
      const row = check(await client().from('mr1_orders').select('*').eq('id', details[2]).maybeSingle());
      if (!row) throw problem(404, 'Pedido não encontrado.', 'order_not_found');
      return { order: order(row, true) };
    }
    if (pathname === '/api/shipping') throw problem(503, 'O frete online ainda não foi ativado pela loja. Nenhum valor fictício será cobrado.', 'shipping_not_configured');
    if (pathname === '/api/checkout') throw problem(503, 'O pagamento ainda não foi ativado pela loja. Não houve cobrança.', 'payment_not_configured');
    if (/^\/api\/orders\//.test(pathname)) throw problem(401, 'Entre na sua conta para consultar este pedido.', 'authentication_required');
    throw problem(404, 'Recurso não encontrado.', 'not_found');
  }
  async function request(path, options = {}) {
    try {
      const method = (options.method || 'GET').toUpperCase();
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body || {};
      const data = await route(path, method, body, options.signal, options.headers || {});
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      return new Response(JSON.stringify({ error: error.status ? error.message : 'Não foi possível acessar a loja. Tente novamente.', code: error.code || 'connection_error' }), { status: error.status || 503, headers: { 'Content-Type': 'application/json' } });
    }
  }
  window.MR1Backend = Object.freeze({ fetch: request, configured: ready });
})();
