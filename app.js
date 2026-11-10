(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const categories = { camisetas: 'Camisetas', moletons: 'Moletons', calcas: 'Calças', acessorios: 'Acessórios' };
  const providerLabels = {
    payment: { pixmanual: 'Pix copia e cola', mercadopago: 'Mercado Pago', stripe: 'Stripe', pagbank: 'PagBank', pagseguro: 'PagSeguro', asaas: 'Asaas', pagarme: 'Pagar.me' },
    shipping: { melhorenvio: 'Melhor Envio', correios: 'Correios', frenet: 'Frenet', kangu: 'Kangu', jadlog: 'Jadlog', loggi: 'Loggi' }
  };
  const CART_KEY = 'mr1-streetwear.cart.v1';
  const CHECKOUT_KEY = 'mr1-streetwear.checkout.v2';
  const read = (key, fallback, storage = localStorage) => { try { const value = storage.getItem(key); return value === null ? fallback : JSON.parse(value); } catch { return fallback; } };
  let products = [];
  let favoriteIds = new Set();
  let catalogReady = false;
  let catalogError = '';
  let catalogRequest = 0;
  const storedCart = read(CART_KEY, []);
  let cart = Array.isArray(storedCart) ? storedCart.filter((line) => line && typeof line.id === 'string' && typeof line.size === 'string' && Number.isInteger(line.quantity) && line.quantity > 0 && line.quantity <= 999) : [];
  let session = { authenticated: false, adminConfigured: true };
  let config = null;
  let category = 'all';
  let selectedProduct = null;
  let selectedSize = '';
  let shipping = null;
  let shippingQuotes = [];
  let shippingVersion = 0;
  let shippingController;
  let shippingExpiryTimer;
  let checkoutAttempt = read(CHECKOUT_KEY, null, sessionStorage);
  let toastTimer;
  let orderDetailRequest = 0;
  const orderStatuses = { ...window.MR1Commerce.statuses, paid: 'Pago', paid_review: 'Pagamento recebido — revisar estoque', pending: 'Aguardando pagamento', payment_pending: 'Aguardando pagamento', payment_in_process: 'Pagamento em análise', payment_unconfirmed: 'Pagamento em verificação', creating: 'Preparando pagamento', cancelled: 'Cancelado', expired: 'Expirado', rejected: 'Recusado', refunded: 'Estornado', charged_back: 'Pagamento contestado' };
  function providerLabel(kind) {
    const key = String(config?.[kind]?.provider || '').toLowerCase().replace(/[\s_-]/g, '');
    return providerLabels[kind]?.[key] || (kind === 'payment' ? 'Provedor de pagamento' : 'Provedor de frete');
  }

  function safeImage(value) {
    const src = String(value || '').trim();
    if (/^\/?assets\/[a-z0-9._/-]+$/i.test(src) && !src.includes('..')) return src;
    if (/^\/uploads\/[a-z0-9-]+\.(jpg|jpeg|png|webp)$/i.test(src)) return src;
    try { const url = new URL(src); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; }
  }
  function toast(message) {
    const element = $('toast');
    if (!element) return;
    ([...document.querySelectorAll('dialog[open]')].at(-1) || document.body).appendChild(element);
    element.textContent = message;
    element.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('is-visible'), 6000);
  }
  function persistCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); }
    catch { toast('Não foi possível salvar a sacola neste navegador. Ela ficará disponível apenas nesta sessão.'); }
  }
  async function api(path, { method = 'GET', body, signal, headers = {}, authenticated = false } = {}) {
    const requestHeaders = { Accept: 'application/json', ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (authenticated && session.csrfToken) requestHeaders['X-CSRF-Token'] = session.csrfToken;
    let response;
    try {
      response = await window.MR1Backend.fetch(path, { method, credentials: 'same-origin', headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store' });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('Não foi possível acessar a loja. Confira sua conexão e tente novamente.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (authenticated && response.status === 401) { session = { authenticated: false, adminConfigured: true }; renderSession(); }
      const error = new Error(typeof data.error === 'string' ? data.error : 'Não foi possível concluir esta operação. Tente novamente.');
      error.status = response.status;
      error.code = data.code;
      error.orderId = typeof data.orderId === 'string' ? data.orderId : null;
      error.orderToken = typeof data.orderToken === 'string' ? data.orderToken : null;
      throw error;
    }
    return data;
  }
  const productById = (id) => products.find((product) => product.id === id);
  const inCart = (id) => cart.filter((line) => line.id === id).reduce((sum, line) => sum + line.quantity, 0);
  const cartItems = () => cart.map(({ id, size, quantity }) => ({ id, size, quantity }));
  const cartFingerprint = () => JSON.stringify(cartItems());
  const subtotal = () => cart.reduce((sum, line) => sum + Math.round((productById(line.id)?.price || 0) * 100) * line.quantity, 0) / 100;
  function reconcileCart() {
    if (!catalogReady) return;
    const used = new Map();
    const consolidated = new Map();
    cart.forEach((line) => {
      const product = productById(line.id);
      if (!product || !product.sizes.includes(line.size)) return;
      const quantity = Math.max(0, Math.min(line.quantity, product.stock - (used.get(line.id) || 0)));
      if (!quantity) return;
      used.set(line.id, (used.get(line.id) || 0) + quantity);
      const key = line.id + ':' + line.size;
      if (consolidated.has(key)) consolidated.get(key).quantity += quantity;
      else consolidated.set(key, { id: line.id, size: line.size, quantity });
    });
    cart = [...consolidated.values()];
  }
  function invalidateShipping(message = '') {
    shippingVersion++;
    shippingController?.abort();
    clearTimeout(shippingExpiryTimer);
    shipping = null;
    shippingQuotes = [];
    if ($('shipping-result')) $('shipping-result').textContent = message;
    const submit = $('shipping-form')?.querySelector('button');
    if (submit) { submit.disabled = false; submit.textContent = 'Calcular ↗'; }
    checkoutAttempt = null;
    try { sessionStorage.removeItem(CHECKOUT_KEY); } catch { /* Session persistence is optional. */ }
  }
  async function loadProducts({ invalidate = false } = {}) {
    const request = ++catalogRequest;
    try {
      const data = await api('/api/products');
      if (request !== catalogRequest) return;
      if (!Array.isArray(data.products)) throw new Error('O catálogo retornou uma resposta inválida.');
      const previous = JSON.stringify(products);
      products = data.products;
      catalogReady = true;
      catalogError = '';
      const before = cartFingerprint();
      reconcileCart();
      persistCart();
      if ((invalidate || previous !== JSON.stringify(products)) && shippingQuotes.length) invalidateShipping('A coleção foi atualizada. Calcule a entrega novamente.');
      if (before !== cartFingerprint()) { invalidateShipping('A sacola foi ajustada ao estoque disponível. Calcule a entrega novamente.'); toast('A sacola foi atualizada conforme o estoque da loja.'); }
      renderProducts(); renderCart(); renderAdmin();
    } catch (error) {
      if (request !== catalogRequest) return;
      catalogError = error.message;
      catalogReady = false;
      products = [];
      invalidateShipping();
      renderProducts(); renderCart();
      throw error;
    }
  }
  function renderProducts() {
    if (!catalogReady) {
      $('product-count').textContent = catalogError ? 'Catálogo indisponível' : 'Carregando coleção...';
      $('product-grid').innerHTML = catalogError ? `<div class="empty-state"><h3>Não foi possível carregar a coleção.</h3><p>${escape(catalogError)}</p><button class="button button-dark" data-retry-catalog>TENTAR NOVAMENTE</button></div>` : '<div class="empty-state" aria-live="polite">Buscando as peças da MR1...</div>';
      return;
    }
    const search = ($('search-input')?.value || '').trim().toLocaleLowerCase('pt-BR');
    const visible = products.filter((product) => (category === 'all' || (category === 'sale' ? product.oldPrice > product.price : product.category === category)) && (product.name + ' ' + categories[product.category]).toLocaleLowerCase('pt-BR').includes(search));
    if ($('sort-select')?.value === 'price-asc') visible.sort((a, b) => a.price - b.price);
    if ($('sort-select')?.value === 'price-desc') visible.sort((a, b) => b.price - a.price);
    $('product-count').textContent = `${visible.length} ${visible.length === 1 ? 'peça' : 'peças'}`;
    $('product-grid').innerHTML = visible.length ? visible.map((product) => {
      const badge = product.stock === 0 ? 'ESGOTADO' : product.oldPrice ? `−${Math.round((1 - product.price / product.oldPrice) * 100)}%` : product.badge;
      return `<article class="product-card"><div class="product-image-wrap"><button class="product-image-button" data-product="${escape(product.id)}" aria-label="Ver ${escape(product.name)}"><img src="${escape(safeImage(product.image))}" alt="${escape(product.name)}" loading="lazy" width="640" height="800">${badge ? `<span class="product-badge${product.oldPrice ? ' sale-badge sale' : ''}">${escape(badge)}</span>` : ''}<span class="quick-add">${product.stock ? 'ESCOLHER TAMANHO' : 'VER PEÇA'} <span aria-hidden="true">↗</span></span></button><button class="favorite-button${favoriteIds.has(product.id) ? ' is-favorite' : ''}" data-favorite-id="${escape(product.id)}" data-favorite-name="${escape(product.name)}" aria-pressed="${favoriteIds.has(product.id)}" aria-label="Salvar ${escape(product.name)} nos favoritos"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg></button></div><div class="product-info"><p class="product-category">${escape(categories[product.category])} · UNISSEX</p><div class="product-name-row"><h3><button data-product="${escape(product.id)}">${escape(product.name)}</button></h3></div><p class="product-price">${product.oldPrice ? `<del>${money(product.oldPrice)}</del> ` : ''}<strong>${money(product.price)}</strong></p><div class="color-dots" aria-label="Uma cor disponível"><span class="${({ '#142b49': 'color-dot-navy', '#88765b': 'color-dot-khaki', '#f4f7f8': 'color-dot-ice', '#b4b6b5': 'color-dot-gray' })[String(product.color).toLowerCase()] || 'color-dot-black'}"></span></div></div></article>`;
    }).join('') : '<div class="empty-state"><h3>Nenhuma peça por aqui.</h3><p>Experimente outra categoria ou termo de busca.</p><button class="button button-dark" data-clear-filters>Ver todas as peças</button></div>';
    document.querySelectorAll('[data-category]').forEach((button) => { button.classList.toggle('is-active', button.dataset.category === category); button.setAttribute('aria-pressed', String(button.dataset.category === category)); });
  }
  function showDialog(element) {
    if (!element) return;
    if (!element.open) element.showModal();
    if ($('toast')) element.appendChild($('toast'));
  }
  function openProduct(id) {
    const product = productById(id);
    if (!product || !catalogReady) return;
    selectedProduct = id;
    selectedSize = product.sizes.length === 1 ? product.sizes[0] : '';
    $('product-detail').innerHTML = `<div class="product-detail-layout"><img class="detail-image detail-product-image" src="${escape(safeImage(product.image))}" alt="${escape(product.name)}"><div class="detail-info"><p class="eyebrow">MR1 STREETWEAR / ${escape(categories[product.category])}</p><h2 id="product-dialog-title">${escape(product.name)}</h2><p class="product-price">${product.oldPrice ? `<del>${money(product.oldPrice)}</del> ` : ''}<strong>${money(product.price)}</strong></p><p class="product-description">${escape(product.description || 'Uma nova peça para compor o seu estilo.')}</p><p class="size-label">TAMANHO <span id="selected-size">${escape(selectedSize || 'Selecione')}</span></p><div class="detail-sizes">${product.sizes.map((size) => `<button class="size-button${size === selectedSize ? ' is-active' : ''}" data-size="${escape(size)}" aria-pressed="${size === selectedSize}">${escape(size)}</button>`).join('')}</div><label class="quantity-label" for="detail-quantity">Quantidade</label><input id="detail-quantity" type="number" min="1" max="${Math.max(1, product.stock - inCart(id))}" value="1" inputmode="numeric"><button class="button button-dark detail-add" data-add-product="${escape(id)}" ${product.stock === 0 ? 'disabled' : ''}>${product.stock === 0 ? 'ESGOTADO' : 'ADICIONAR À SACOLA'} <span aria-hidden="true">↗</span></button><p class="detail-note">Estoque disponível: ${product.stock} peças no total entre os tamanhos. Consulte a entrega na sacola.</p></div></div>`;
    showDialog($('product-dialog'));
  }
  function addProduct(id) {
    const product = productById(id);
    const quantity = Number($('detail-quantity').value);
    if (!product || !product.sizes.includes(selectedSize)) return toast('Escolha um tamanho para continuar.');
    if (!Number.isInteger(quantity) || quantity < 1) return toast('Informe uma quantidade válida.');
    if (quantity + inCart(id) > product.stock) return toast('Essa quantidade excede o estoque disponível da peça.');
    const line = cart.find((item) => item.id === id && item.size === selectedSize);
    if (line) line.quantity += quantity;
    else cart.push({ id, size: selectedSize, quantity });
    invalidateShipping('Calcule a entrega para esta sacola.'); persistCart(); renderCart();
    $('product-dialog').close(); showDialog($('cart-drawer')); toast(`${product.name} adicionada à sacola.`);
  }
  function renderCart() {
    const count = cart.reduce((sum, line) => sum + line.quantity, 0);
    $('cart-count').textContent = count;
    $('cart-button').setAttribute('aria-label', `Abrir sacola com ${count} ${count === 1 ? 'peça' : 'peças'}`);
    if (!catalogReady) {
      $('cart-items').innerHTML = '<div class="empty-state"><p>O catálogo precisa estar disponível para consultar preços e estoque.</p><button class="button button-dark" data-retry-catalog>TENTAR NOVAMENTE</button></div>';
      $('cart-subtotal').textContent = 'A consultar'; $('cart-total').textContent = 'A consultar'; $('checkout-button').disabled = true; return;
    }
    $('cart-items').innerHTML = cart.length ? cart.map((line, index) => {
      const product = productById(line.id);
      return `<article class="cart-item"><img class="cart-item-image" src="${escape(safeImage(product.image))}" alt="${escape(product.name)}" width="80" height="100"><div class="cart-item-info"><h3>${escape(product.name)}</h3><p>Tamanho ${escape(line.size)}</p><strong>${money(product.price)}</strong><div class="quantity-control"><button data-cart-action="decrease" data-index="${index}" aria-label="Diminuir quantidade de ${escape(product.name)}">−</button><span aria-label="Quantidade">${line.quantity}</span><button data-cart-action="increase" data-index="${index}" aria-label="Aumentar quantidade de ${escape(product.name)}">+</button></div></div><button class="remove-item" data-cart-action="remove" data-index="${index}" aria-label="Remover ${escape(product.name)}">×</button></article>`;
    }).join('') : '<div class="empty-state"><span class="empty-cart-icon" aria-hidden="true">↗</span><h3>Seu próximo look começa aqui.</h3><p>Escolha suas peças favoritas e coloque na sacola.</p><button class="button button-dark" data-continue-shopping>EXPLORAR A COLEÇÃO</button></div>';
    $('cart-subtotal').textContent = money(subtotal());
    $('cart-total').textContent = shipping?.pricePending ? money(subtotal()) + ' + frete' : money(subtotal() + (shipping?.price || 0));
    $('checkout-button').disabled = !cart.length;
    $('checkout-button').textContent = !cart.length ? 'ADICIONE UMA PEÇA' : shipping ? 'ENVIAR PARA ANÁLISE ↗' : 'CONTINUAR PEDIDO ↗';
    const note = document.querySelector('.checkout-note');
    if (note) note.textContent = shipping ? 'A loja confere a entrega e libera o Pix em Minha conta → Meus pedidos.' : 'Calcule e selecione a entrega para continuar.';
  }
  function changeCart(action, index) {
    const line = cart[index];
    if (!line || !catalogReady) return;
    const product = productById(line.id);
    if (action === 'remove' || (action === 'decrease' && line.quantity === 1)) cart.splice(index, 1);
    else if (action === 'decrease') line.quantity--;
    else if (action === 'increase') { if (inCart(line.id) >= product.stock) return toast('Você já adicionou todo o estoque disponível dessa peça.'); line.quantity++; }
    else return;
    invalidateShipping('Sacola atualizada. Calcule a entrega novamente.'); persistCart(); renderCart();
  }
  function quoteExpired(quote) {
    if (!quote?.expiresAt) return false;
    const expiry = Number(quote.expiresAt);
    return Number.isFinite(expiry) && Date.now() >= (expiry > 1e12 ? expiry : expiry * 1000);
  }
  function selectShipping(id) {
    const quote = shippingQuotes.find((item) => String(item.id) === id);
    if (!quote || quoteExpired(quote)) { invalidateShipping('A cotação expirou. Calcule a entrega novamente.'); renderCart(); return; }
    shipping = quote;
    clearTimeout(shippingExpiryTimer);
    const expires = Number(quote.expiresAt);
    if (expires) shippingExpiryTimer = setTimeout(() => { invalidateShipping('A cotação expirou. Calcule a entrega novamente.'); renderCart(); }, Math.max(0, (expires > 1e12 ? expires : expires * 1000) - Date.now()));
    renderCart();
  }
  async function quoteShipping(event) {
    event.preventDefault();
    const cep = $('shipping-cep').value.replace(/\D/g, '');
    if (!cart.length || !catalogReady) return toast('Adicione uma peça antes de calcular a entrega.');
    if (!/^\d{8}$/.test(cep) || /^(\d)\1{7}$/.test(cep)) return toast('Informe um CEP válido com 8 números.');
    invalidateShipping();
    const version = shippingVersion;
    const fingerprint = cartFingerprint();
    shippingController = new AbortController();
    const submit = $('shipping-form').querySelector('button');
    submit.disabled = true; submit.textContent = 'Consultando...';
    $('shipping-result').textContent = 'Consultando opções de entrega...';
    try {
      const data = await api('/api/shipping', { method: 'POST', body: { cep, items: cartItems() }, signal: shippingController.signal });
      if (version !== shippingVersion || fingerprint !== cartFingerprint()) return;
      shippingQuotes = (data.quotes || []).filter((quote) => quote && quote.id && Number.isFinite(Number(quote.price)) && Number(quote.price) >= 0).map((quote) => ({ ...quote, price: Number(quote.price), cep, destination: data.destination }));
      if (!shippingQuotes.length) throw new Error('Nenhuma opção de entrega está disponível para esse CEP.');
      $('shipping-result').innerHTML = `<fieldset class="shipping-options"><legend>Escolha a entrega</legend>${shippingQuotes.map((quote) => `<label class="shipping-option"><input type="radio" name="shipping-option" value="${escape(quote.id)}" data-shipping-option="${escape(quote.id)}"><span><strong>${escape(quote.company || '')} ${escape(quote.name || 'Entrega')}</strong><small>${escape(quote.deliveryLabel || 'Prazo a confirmar pela loja')}</small></span><b>${quote.pricePending ? 'A confirmar' : money(quote.price)}</b></label>`).join('')}</fieldset><p class="shipping-provider-note">${escape(data.destination?.city || '')} / ${escape(data.destination?.state || '')} · Saída de 05879-450. Envie o pedido para receber o valor final e o Pix.</p>`;
    } catch (error) {
      if (error.name === 'AbortError' || version !== shippingVersion) return;
      $('shipping-result').textContent = error.message;
    } finally { if (version === shippingVersion) { submit.disabled = false; submit.textContent = 'Calcular ↗'; } renderCart(); }
  }
  async function openCheckout() {
    if (!cart.length || !catalogReady) return;
    if (!shipping || quoteExpired(shipping)) return toast('Calcule a entrega e selecione uma opção válida antes de continuar.');
    try { config = await api('/api/config'); } catch (error) { return toast(error.message); }
    if (!config.checkoutReady) return toast('O pagamento ainda não foi ativado pela loja. Não houve cobrança nem criação de pedido.');
    const account = await api('/api/account/session');
    if (!account.authenticated) {
      $('cart-drawer').close(); window.MR1Account.open('orders');
      return toast('Entre ou crie sua conta. Depois volte à sacola para enviar o pedido.');
    }
    const form = $('checkout-form');
    const values = { ...shipping.destination, name: account.name, email: account.email, cep: shipping.cep.slice(0, 5) + '-' + shipping.cep.slice(5) };
    for (const [name,value] of Object.entries(values)) { const input = form.elements.namedItem(name); if (input && value) input.value = value; }
    form.elements.namedItem('city').readOnly = true;
    form.elements.namedItem('email').readOnly = true;
    form.elements.namedItem('state').disabled = true;
    if ($('checkout-error')) $('checkout-error').textContent = '';
    showDialog($('checkout-dialog'));
  }
  async function submitCheckout(event) {
    event.preventDefault();
    const form = $('checkout-form');
    if (!form.reportValidity()) return;
    const field = (name) => String(form.elements.namedItem(name)?.value || '').trim();
    if (!shipping || quoteExpired(shipping)) { $('checkout-error').textContent = 'A cotação expirou ou a sacola mudou. Feche esta janela e calcule a entrega novamente.'; return; }
    const payload = { items: cartItems(), quoteId: shipping.id, customer: { name: field('name'), email: field('email'), phone: field('phone'), address: { cep: shipping.cep, street: field('street'), number: field('number'), complement: field('complement'), neighborhood: field('neighborhood'), city: field('city'), state: field('state').toUpperCase() } } };
    const fingerprint = JSON.stringify(payload);
    if (!checkoutAttempt || checkoutAttempt.fingerprint !== fingerprint) checkoutAttempt = { fingerprint, key: crypto.randomUUID(), items: payload.items };
    try { sessionStorage.setItem(CHECKOUT_KEY, JSON.stringify(checkoutAttempt)); } catch { /* In-memory key still prevents repeat submits in this session. */ }
    const button = $('checkout-submit'); button.disabled = true; button.textContent = 'ENVIANDO PEDIDO...'; $('checkout-error').textContent = '';
    try {
      const result = await api('/api/checkout', { method: 'POST', body: payload, headers: { 'Idempotency-Key': checkoutAttempt.key } });
      if (!result.manual || !result.orderId) throw new Error('Não foi possível confirmar o envio do pedido. Tente novamente com a mesma sacola.');
      checkoutAttempt = { ...checkoutAttempt, orderId: result.orderId };
      try { sessionStorage.removeItem(CHECKOUT_KEY); } catch { /* The submitted request remains in the account history. */ }
      cart = []; persistCart(); invalidateShipping(); renderCart();
      $('checkout-dialog').close(); $('cart-drawer').close();
      window.MR1Account.open('orders');
      document.dispatchEvent(new CustomEvent('mr1:order-updated', { detail: { id: result.orderId } }));
      toast('Pedido enviado. Acompanhe a conferência e o Pix em Meus pedidos.');
    } catch (error) {
      $('checkout-error').textContent = error.message;
      if (error.orderId && error.orderToken) {
        checkoutAttempt = { ...checkoutAttempt, orderId: error.orderId, orderToken: error.orderToken };
        try { sessionStorage.setItem(CHECKOUT_KEY, JSON.stringify(checkoutAttempt)); } catch { /* Server status remains available in memory. */ }
        const check = document.createElement('button');
        check.type = 'button'; check.className = 'text-button'; check.dataset.checkPendingOrder = 'true'; check.textContent = 'Consultar este pedido';
        $('checkout-error').append(document.createElement('br'), check);
      }
      if (['quote_expired', 'quote_invalid', 'invalid_quote', 'insufficient_stock', 'stock_unavailable', 'cart_changed', 'product_unavailable', 'invalid_cart'].includes(error.code)) {
        invalidateShipping('A sacola ou a cotação mudou. Calcule a entrega novamente antes de continuar.');
        if (['insufficient_stock', 'stock_unavailable', 'product_unavailable', 'invalid_cart'].includes(error.code)) loadProducts().catch(() => {});
      }
    } finally { button.disabled = false; button.textContent = 'ENVIAR PEDIDO ↗'; renderCart(); }
  }
  function renderSession() {
    if ($('admin-auth-section')) $('admin-auth-section').hidden = Boolean(session.authenticated);
    if ($('admin-workspace')) $('admin-workspace').hidden = !session.authenticated;
    if ($('admin-logout')) $('admin-logout').hidden = !session.authenticated;
    if ($('admin-user')) $('admin-user').textContent = session.authenticated ? session.email || 'Administrador' : '';
    if ($('admin-setup-notice')) {
      $('admin-setup-notice').hidden = session.adminConfigured !== false;
      $('admin-setup-notice').textContent = 'O acesso administrativo ficará disponível após concluir a conexão com o Supabase e autorizar sua conta.';
    }
    if ($('admin-auth-form')) $('admin-auth-form').hidden = session.adminConfigured === false;
    document.dispatchEvent(new CustomEvent('mr1:admin-session', { detail: session }));
    renderAdmin();
  }
  function renderIntegrationStatus() {
    if ($('preview-note') && config) $('preview-note').hidden = !config.preview;
    if (!$('integration-status') || !config) return;
    $('integration-status').innerHTML = `<strong>Como atender pedidos</strong><p>Pix copia e cola: abra um pedido, confira a entrega e cole o Pix com o valor total. Confirme o pagamento somente após conferir o crédito no banco.</p><p>São Paulo capital: entrega grátis. Demais destinos: consulte os Correios e informe valor e prazo antes de liberar o Pix. Após postar na agência, registre o rastreio.</p><small>Os clientes acompanham o atendimento em Minha conta → Meus pedidos. Use “Atualizar pedidos” para consultar novas solicitações.</small>`;
  }
  async function loadSession() { session = await api('/api/session'); renderSession(); }
  async function openAdmin() {
    showDialog($('admin-dialog'));
    $('admin-login-error').textContent = '';
    try { await loadSession(); config = await api('/api/config'); renderIntegrationStatus(); if (session.authenticated) await loadOrders(); }
    catch (error) { $('admin-login-error').textContent = error.message; }
  }
  async function login(event) {
    event.preventDefault();
    const form = $('admin-auth-form');
    if (!form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]'); button.disabled = true; $('admin-login-error').textContent = '';
    try { session = await api('/api/login', { method: 'POST', body: { email: $('admin-email').value.trim(), password: $('admin-password').value } }); $('admin-password').value = ''; renderSession(); await loadOrders(); toast('Acesso autorizado. As alterações são salvas no banco de dados da loja.'); }
    catch (error) { $('admin-password').value = ''; $('admin-login-error').textContent = error.message; }
    finally { button.disabled = false; }
  }
  async function logout() {
    try { await api('/api/logout', { method: 'POST', body: {}, authenticated: true }); session = { authenticated: false, adminConfigured: true }; orderDetailRequest++; $('order-detail-dialog')?.close(); if ($('order-detail-content')) $('order-detail-content').textContent = ''; resetAdmin(); renderSession(); toast('Você saiu do painel.'); }
    catch (error) { toast(error.message); }
  }
  function renderAdmin() {
    if (!$('admin-products') || !session.authenticated) return;
    $('admin-products').innerHTML = products.length ? products.map((product) => `<article class="admin-product"><img src="${escape(safeImage(product.image))}" alt="" width="48" height="60"><div><strong>${escape(product.name)}</strong><p>${money(product.price)} · ${product.stock} em estoque${product.oldPrice ? ' · Em promoção' : ''}</p><p>${product.measurementsConfirmed ? 'Medidas conferidas' : 'Conferir peso e dimensões para habilitar o frete'}</p></div><div class="admin-actions"><button type="button" data-admin-edit="${escape(product.id)}">Editar</button><button type="button" data-admin-delete="${escape(product.id)}" aria-label="Excluir ${escape(product.name)}">Excluir</button></div></article>`).join('') : '<p>Nenhuma peça cadastrada. Adicione a primeira.</p>';
  }
  function resetAdmin() { $('admin-form').reset(); $('admin-form').elements.namedItem('id').value = ''; $('admin-save').textContent = 'SALVAR PEÇA'; }
  function editProduct(id) {
    const product = productById(id); if (!product || !session.authenticated) return;
    const form = $('admin-form'); resetAdmin();
    ['id', 'name', 'category', 'price', 'oldPrice', 'stock', 'weight', 'width', 'height', 'length', 'description'].forEach((key) => { const field = form.elements.namedItem(key); if (field) field.value = product[key] ?? ''; });
    form.elements.namedItem('size').value = product.sizes.join(', ');
    form.elements.namedItem('imageUrl').value = /^https?:\/\//i.test(product.image) ? product.image : '';
    if (form.elements.namedItem('measurementsConfirmed')) form.elements.namedItem('measurementsConfirmed').checked = product.measurementsConfirmed === true;
    $('admin-save').textContent = 'SALVAR ALTERAÇÕES'; form.scrollIntoView({ behavior: 'smooth', block: 'start' }); form.elements.namedItem('name').focus({ preventScroll: true });
  }
  function readPhoto(file) {
    return new Promise((resolve, reject) => {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return reject(new Error('Use uma imagem JPG, PNG ou WebP.'));
      if (file.size > 2000000) return reject(new Error('A foto deve ter até 2 MB.'));
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Não foi possível ler a foto. Tente novamente.')); reader.readAsDataURL(file);
    });
  }
  async function saveProduct(event) {
    event.preventDefault();
    if (!session.authenticated) return toast('Entre no painel para salvar produtos.');
    const form = $('admin-form'); if (!form.reportValidity()) return;
    const field = (name) => form.elements.namedItem(name);
    const existing = productById(field('id').value);
    const submit = $('admin-save'); submit.disabled = true;
    try {
      const price = Number(field('price').value);
      const previous = field('oldPrice').value.trim();
      const oldPrice = previous ? Number(previous) : null;
      if (oldPrice !== null && oldPrice <= price) throw new Error('O preço anterior precisa ser maior que o preço atual da promoção.');
      let image = field('imageUrl').value.trim() || existing?.image || '';
      const file = field('image').files[0];
      if (file) { const uploaded = await api('/api/uploads', { method: 'POST', body: { dataUrl: await readPhoto(file) }, authenticated: true }); image = uploaded.url; }
      if (!safeImage(image)) throw new Error('Escolha uma foto ou informe um endereço de imagem válido.');
      const payload = { name: field('name').value.trim(), category: field('category').value, price, oldPrice, stock: Number(field('stock').value), image, sizes: [...new Set(field('size').value.split(',').map((size) => size.trim()).filter(Boolean))], color: existing?.color || '#142b49', badge: existing?.badge || 'NOVO DROP', description: field('description') ? field('description').value.trim() : existing?.description || 'Uma nova peça para compor o seu estilo.', weight: Number(field('weight')?.value), width: Number(field('width')?.value), height: Number(field('height')?.value), length: Number(field('length')?.value), measurementsConfirmed: field('measurementsConfirmed')?.checked === true };
      await api(existing ? '/api/products/' + encodeURIComponent(existing.id) : '/api/products', { method: existing ? 'PUT' : 'POST', body: payload, authenticated: true });
      resetAdmin(); await loadProducts({ invalidate: true }); toast('Peça salva no catálogo da loja.');
    } catch (error) { toast(error.message); }
    finally { submit.disabled = false; }
  }
  async function deleteProduct(id) {
    const product = productById(id);
    if (!product || !session.authenticated || !window.confirm(`Excluir “${product.name}” do catálogo da loja?`)) return;
    try { await api('/api/products/' + encodeURIComponent(id), { method: 'DELETE', authenticated: true }); resetAdmin(); await loadProducts({ invalidate: true }); toast('Peça removida do catálogo.'); }
    catch (error) { toast(error.message); }
  }
  async function loadOrders() {
    if (!$('admin-orders') || !session.authenticated) return;
    try {
      const data = await api('/api/admin/orders', { authenticated: true });
      $('admin-orders').innerHTML = data.orders?.length ? data.orders.map((order) => `<article class="admin-order"><button type="button" data-order-detail="${escape(order.id || order.orderId)}">Pedido ${escape(String(order.id || order.orderId).slice(0, 8))} ↗</button><span>${escape(orderStatuses[order.status] || 'Em acompanhamento')}</span><b>${money(Number(order.total || order.totalAmount || 0))}${order.shippingPending ? ' + frete a confirmar' : ''}</b></article>`).join('') : '<p>Nenhum pedido recebido.</p>';
    } catch (error) { $('admin-orders').textContent = error.message; }
  }
  async function openOrderDetail(id) {
    if (!session.authenticated || !$('order-detail-dialog')) return;
    const request = ++orderDetailRequest;
    const content = $('order-detail-content');
    content.dataset.orderId = id;
    content.textContent = 'Consultando os dados do pedido...';
    showDialog($('order-detail-dialog'));
    try {
      const data = await api('/api/admin/orders/' + encodeURIComponent(id), { authenticated: true });
      if (request !== orderDetailRequest || !session.authenticated) return;
      const order = data.order;
      const customer = order.customer || {};
      const address = customer.address || {};
      const service = order.shippingService || {};
      const created = Number(order.created);
      const date = created ? new Date(created > 1e12 ? created : created * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
      content.innerHTML = `<div class="order-detail-summary"><p class="eyebrow">PEDIDO ${escape(String(order.id).slice(0, 8))}</p><h3>${escape(orderStatuses[order.status] || 'Em acompanhamento')}</h3><p>${escape(date)}</p></div><section><h3>Cliente</h3><dl class="order-detail-fields"><dt>Nome</dt><dd>${escape(customer.name)}</dd><dt>E-mail</dt><dd>${escape(customer.email)}</dd><dt>Celular</dt><dd>${escape(customer.phone)}</dd></dl></section><section><h3>Entrega</h3><p>${escape(address.street)}, ${escape(address.number)}${address.complement ? ' — ' + escape(address.complement) : ''}<br>${escape(address.neighborhood)} · ${escape(address.city)} / ${escape(address.state)}<br>CEP ${escape(address.cep)}</p><p>${escape(service.company || '')} ${escape(service.name || '')}</p></section><section><h3>Peças</h3><div class="order-detail-items">${(order.items || []).map((item) => `<article><div><strong>${escape(item.name || item.id)}</strong><p>Tamanho ${escape(item.size)} · Quantidade ${escape(item.quantity)}</p></div><b>${money(Number(item.unitPrice || 0) * Number(item.quantity || 0))}</b></article>`).join('')}</div></section><div class="order-detail-totals"><p><span>Subtotal</span><strong>${money(Number(order.subtotal || 0))}</strong></p><p><span>Frete</span><strong>${order.shippingPending ? 'A confirmar' : money(Number(order.shipping || 0))}</strong></p><p><span>Total</span><strong>${money(Number(order.total || 0))}${order.shippingPending ? ' + frete a confirmar' : ''}</strong></p></div>${window.MR1Commerce.adminMarkup(order)}`;
    } catch (error) { if (request === orderDetailRequest) content.textContent = error.message; }
  }
  async function checkOrderReturn() {
    const params = new URLSearchParams(location.search);
    const id = params.get('order');
    const receipt = read('mr1-streetwear.receipt.v1', null, sessionStorage);
    const token = params.get('token') || (receipt?.id === id ? receipt.token : null);
    if (!id || !token) return;
    try { sessionStorage.setItem('mr1-streetwear.receipt.v1', JSON.stringify({ id, token })); } catch { /* The current response can still be checked. */ }
    params.delete('token'); params.delete('status'); history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
    let banner = $('order-status');
    if (!banner) { banner = document.createElement('section'); banner.id = 'order-status'; banner.className = 'order-status'; banner.setAttribute('role', 'status'); document.querySelector('main').prepend(banner); }
    banner.textContent = 'Conferindo o status do pedido com o servidor...';
    try {
      const data = await api('/api/orders/' + encodeURIComponent(id) + '?token=' + encodeURIComponent(token));
      const order = data.order || data;
      if (order.status === 'paid') {
        banner.textContent = `Pagamento confirmado. Pedido ${id.slice(0, 8)} recebido pela MR1.`;
        if (checkoutAttempt?.orderId === id && Array.isArray(checkoutAttempt.items)) {
          checkoutAttempt.items.forEach((purchased) => { const line = cart.find((item) => item.id === purchased.id && item.size === purchased.size); if (line) line.quantity = Math.max(0, line.quantity - purchased.quantity); });
          cart = cart.filter((line) => line.quantity > 0); persistCart(); invalidateShipping(); renderCart();
        }
      } else if (order.status === 'paid_review') banner.textContent = 'O pagamento foi recebido. O pedido aguarda conferência da loja antes da confirmação final.';
      else if (order.status === 'refunded') banner.textContent = 'O pagamento deste pedido foi estornado. Consulte o provedor de pagamento para acompanhar o reembolso.';
      else if (order.status === 'charged_back') banner.textContent = 'O pagamento deste pedido foi contestado. Consulte o provedor de pagamento para acompanhar a situação.';
      else if (['cancelled', 'expired', 'rejected'].includes(order.status)) banner.textContent = 'O pagamento não foi concluído. Confira sua sacola antes de tentar novamente.';
      else banner.textContent = 'Pedido recebido. O pagamento ainda aguarda confirmação do provedor; o retorno para esta página não confirma a cobrança.';
      if (!['paid', 'refunded', 'charged_back', 'cancelled', 'expired', 'rejected'].includes(order.status)) addOrderRefresh(banner);
    } catch (error) { banner.textContent = 'Não foi possível confirmar o status do pedido: ' + error.message; addOrderRefresh(banner); }
  }
  function addOrderRefresh(banner) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.dataset.refreshOrder = 'true'; button.textContent = 'Atualizar status do pedido'; banner.append(document.createTextNode(' '), button);
  }
  async function checkPendingOrder(button) {
    if (!checkoutAttempt?.orderId || !checkoutAttempt.orderToken) return;
    button.disabled = true;
    try {
      const data = await api('/api/orders/' + encodeURIComponent(checkoutAttempt.orderId) + '?token=' + encodeURIComponent(checkoutAttempt.orderToken));
      const order = data.order || data;
      $('checkout-error').textContent = order.status === 'paid' ? 'Pagamento confirmado pelo servidor. Seu pedido foi recebido.' : order.status === 'paid_review' ? 'Pagamento recebido. A loja está conferindo o pedido.' : `Pedido ${checkoutAttempt.orderId.slice(0, 8)}: ${orderStatuses[order.status] || 'Em acompanhamento'}. Não inicie outro pagamento enquanto aguarda a conferência.`;
    } catch (error) { $('checkout-error').textContent = error.message; }
  }
  $('product-grid').addEventListener('click', (event) => { const product = event.target.closest('[data-product]'); if (product) openProduct(product.dataset.product); if (event.target.closest('[data-clear-filters]')) { category = 'all'; $('search-input').value = ''; renderProducts(); } });
  document.addEventListener('click', (event) => {
    const filter = event.target.closest('[data-category], [data-nav-category]'); if (filter) { category = filter.dataset.category || filter.dataset.navCategory; renderProducts(); }
    if (event.target.closest('[data-retry-catalog]')) loadProducts().catch((error) => toast(error.message));
    if (event.target.closest('[data-refresh-order]')) checkOrderReturn();
  });
  $('sort-select').addEventListener('change', renderProducts);
  $('search-input').addEventListener('input', renderProducts);
  $('search-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('catalogo')?.scrollIntoView({ behavior: 'smooth' }); } });
  $('cart-button').addEventListener('click', () => { renderCart(); showDialog($('cart-drawer')); loadProducts().catch((error) => toast(error.message)); });
  $('cart-close').addEventListener('click', () => $('cart-drawer').close());
  $('product-close').addEventListener('click', () => $('product-dialog').close());
  $('product-detail').addEventListener('click', (event) => {
    const size = event.target.closest('[data-size]');
    if (size) { selectedSize = size.dataset.size; $('selected-size').textContent = selectedSize; $('product-detail').querySelectorAll('[data-size]').forEach((button) => { button.classList.toggle('is-active', button.dataset.size === selectedSize); button.setAttribute('aria-pressed', String(button.dataset.size === selectedSize)); }); }
    if (event.target.closest('[data-add-product]')) addProduct(selectedProduct);
  });
  $('cart-items').addEventListener('click', (event) => { const button = event.target.closest('[data-cart-action]'); if (button) changeCart(button.dataset.cartAction, Number(button.dataset.index)); if (event.target.closest('[data-continue-shopping]')) { $('cart-drawer').close(); $('product-grid').scrollIntoView({ behavior: 'smooth' }); } });
  $('shipping-form').addEventListener('submit', quoteShipping);
  $('shipping-cep').addEventListener('input', () => { const digits = $('shipping-cep').value.replace(/\D/g, '').slice(0, 8); $('shipping-cep').value = digits.length > 5 ? digits.slice(0, 5) + '-' + digits.slice(5) : digits; invalidateShipping('Calcule a entrega para o CEP informado.'); renderCart(); });
  $('shipping-result').addEventListener('change', (event) => { if (event.target.matches('[data-shipping-option]')) selectShipping(event.target.dataset.shippingOption); });
  $('admin-create-account')?.addEventListener('click', () => {
    $('admin-dialog').close();
    document.dispatchEvent(new CustomEvent('mr1:open-account', { detail: { tab: 'profile', mode: 'register' } }));
  });
  $('checkout-button').addEventListener('click', () => openCheckout().catch((error) => toast(error.message)));
  $('refresh-admin-orders')?.addEventListener('click', loadOrders);
  document.addEventListener('mr1:order-updated', (event) => {
    loadOrders();
    if ($('order-detail-dialog').open && $('order-detail-content').dataset.orderId === event.detail?.id) openOrderDetail(event.detail.id);
  });
  $('checkout-close')?.addEventListener('click', () => $('checkout-dialog').close());
  $('checkout-form')?.addEventListener('submit', submitCheckout);
  $('checkout-error')?.addEventListener('click', (event) => { const button = event.target.closest('[data-check-pending-order]'); if (button) checkPendingOrder(button); });
  $('admin-button').addEventListener('click', openAdmin);
  $('footer-admin-button')?.addEventListener('click', openAdmin);
  $('admin-close').addEventListener('click', () => $('admin-dialog').close());
  $('admin-auth-form')?.addEventListener('submit', login);
  $('admin-logout')?.addEventListener('click', logout);
  $('admin-orders-refresh')?.addEventListener('click', loadOrders);
  $('admin-orders')?.addEventListener('click', (event) => { const button = event.target.closest('[data-order-detail]'); if (button) openOrderDetail(button.dataset.orderDetail); });
  $('order-detail-close')?.addEventListener('click', () => { orderDetailRequest++; $('order-detail-dialog').close(); });
  $('admin-form').addEventListener('reset', () => { $('admin-form').elements.namedItem('id').value = ''; $('admin-save').textContent = 'SALVAR PEÇA'; });
  $('admin-form').addEventListener('submit', saveProduct);
  $('admin-products').addEventListener('click', (event) => { const edit = event.target.closest('[data-admin-edit]'); if (edit) editProduct(edit.dataset.adminEdit); const remove = event.target.closest('[data-admin-delete]'); if (remove) deleteProduct(remove.dataset.adminDelete); });
  $('newsletter-form')?.addEventListener('submit', (event) => { event.preventDefault(); toast('Este formulário ainda não está conectado. Nenhum e-mail foi enviado ou cadastrado.'); });
  document.querySelectorAll('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => { const bounds = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close(); });
    dialog.addEventListener('close', () => { const remaining = [...document.querySelectorAll('dialog[open]')]; if (!remaining.length) document.body.classList.remove('dialog-open'); if (dialog.contains($('toast'))) (remaining.at(-1) || document.body).appendChild($('toast')); });
    new MutationObserver(() => { if (dialog.open) document.body.classList.add('dialog-open'); }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  });
  document.addEventListener('mr1:open-product', (event) => openProduct(event.detail?.id));
  document.addEventListener('mr1:favorites-updated', (event) => { favoriteIds = new Set(event.detail?.ids || []); });
  document.addEventListener('mr1:auth-changed', () => { loadSession().catch(() => {}); });
  renderProducts(); renderCart(); renderSession();
  Promise.allSettled([loadProducts(), api('/api/config').then((data) => { config = data; renderIntegrationStatus(); }), loadSession()]).then(checkOrderReturn);
})();
