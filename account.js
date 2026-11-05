(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const dialog = $('account-dialog');
  const view = $('account-view');
  if (!dialog || !view) return;

  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number.isFinite(Number(value)) ? Number(value) : 0);
  const statusLabels = {
    creating: 'Preparando pagamento', pending: 'Aguardando pagamento', payment_pending: 'Aguardando pagamento',
    payment_in_process: 'Pagamento em análise', payment_unconfirmed: 'Pagamento em verificação', paid: 'Pagamento confirmado',
    paid_review: 'Pagamento recebido — em conferência', cancelled: 'Cancelado', expired: 'Expirado', rejected: 'Pagamento recusado',
    refunded: 'Pagamento estornado', charged_back: 'Pagamento contestado'
  };
  let customer = { authenticated: false };
  let authMode = 'login';
  let activeTab = 'orders';
  let favorites = [];
  let orders = [];
  let favoritesLoaded = false;
  let ordersLoaded = false;
  let favoritesError = '';
  let ordersError = '';
  let identityVersion = 0;
  let tabRequest = 0;
  let authBusy = false;
  let pendingFavorite = null;
  const favoriteRequests = new Set();

  function safeImage(value) {
    const source = String(value || '').trim();
    if (/^\/?assets\/[a-z0-9._/-]+$/i.test(source) && !source.includes('..')) return source;
    if (/^\/uploads\/[a-f0-9-]+\.(jpg|jpeg|png|webp)$/i.test(source)) return source;
    try { const url = new URL(source); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; }
    catch { return ''; }
  }

  function message(text, error = false) {
    let element = $('account-message');
    if (!element) {
      element = document.createElement('p');
      element.id = 'account-message';
      element.setAttribute('role', 'status');
      dialog.appendChild(element);
    }
    element.textContent = text;
    element.className = error ? 'account-message is-error' : 'account-message';
    element.hidden = !text;
  }

  function emitSession() {
    document.dispatchEvent(new CustomEvent('mr1:customer-session', { detail: {
      authenticated: Boolean(customer.authenticated), name: customer.name || '', email: customer.email || ''
    } }));
    const button = $('account-button');
    if (button) {
      button.classList.toggle('is-signed-in', Boolean(customer.authenticated));
      button.setAttribute('aria-label', customer.authenticated ? `Minha conta, ${customer.name || 'cliente'}` : 'Entrar na minha conta');
      button.setAttribute('title', customer.authenticated ? 'Minha conta' : 'Entrar ou criar conta');
    }
  }

  function emitFavorites() {
    const ids = customer.authenticated ? favorites.map((product) => String(product.id)) : [];
    document.dispatchEvent(new CustomEvent('mr1:favorites-updated', { detail: { ids } }));
    updateFavoriteButtons();
  }

  function updateFavoriteButtons() {
    const ids = new Set(customer.authenticated ? favorites.map((product) => String(product.id)) : []);
    document.querySelectorAll('[data-favorite-id]').forEach((button) => {
      const selected = ids.has(button.dataset.favoriteId);
      const name = button.dataset.favoriteName || 'peça';
      button.classList.toggle('is-favorite', selected);
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', `${selected ? 'Remover' : 'Salvar'} ${name} ${selected ? 'dos' : 'nos'} favoritos`);
      button.disabled = favoriteRequests.has(button.dataset.favoriteId);
    });
  }

  function clearCustomer() {
    identityVersion++;
    tabRequest++;
    customer = { authenticated: false };
    favorites = []; orders = [];
    favoritesLoaded = false; ordersLoaded = false;
    favoritesError = ''; ordersError = '';
    emitSession(); emitFavorites();
  }

  async function api(path, { method = 'GET', body, authenticated = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated && customer.csrfToken) headers['X-CSRF-Token'] = customer.csrfToken;
    let response;
    try { response = await window.MR1Backend.fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new Error('Não foi possível acessar sua conta. Confira sua conexão e tente novamente.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof data.error === 'string' ? data.error : 'Não foi possível concluir a operação. Tente novamente.');
      error.status = response.status; error.code = data.code;
      if (authenticated && response.status === 401) {
        clearCustomer();
        if (dialog.open) renderAuth();
      }
      throw error;
    }
    return data;
  }

  async function loadSession() {
    const version = identityVersion;
    const data = await api('/api/account/session');
    if (version !== identityVersion) return;
    if (data.authenticated) {
      customer = data;
      emitSession();
      await loadFavorites();
    } else clearCustomer();
  }

  async function loadFavorites() {
    if (!customer.authenticated) return;
    const version = identityVersion;
    try {
      const data = await api('/api/account/favorites', { authenticated: true });
      if (version !== identityVersion || !customer.authenticated) return;
      if (!Array.isArray(data.products)) throw new Error('Não foi possível ler seus favoritos. Tente novamente.');
      favorites = data.products;
      favoritesLoaded = true; favoritesError = '';
      emitFavorites();
    } catch (error) {
      if (version !== identityVersion) throw error;
      favoritesError = error.message; favoritesLoaded = true;
      throw error;
    }
  }

  async function loadOrders() {
    if (!customer.authenticated) return;
    const version = identityVersion;
    try {
      const data = await api('/api/account/orders', { authenticated: true });
      if (version !== identityVersion || !customer.authenticated) return;
      if (!Array.isArray(data.orders)) throw new Error('Não foi possível ler seus pedidos. Tente novamente.');
      orders = data.orders;
      ordersLoaded = true; ordersError = '';
    } catch (error) {
      if (version !== identityVersion) throw error;
      ordersError = error.message; ordersLoaded = true;
      throw error;
    }
  }

  function openAccount(tab = null) {
    if (tab) activeTab = tab;
    message('');
    if (!dialog.open) dialog.showModal();
    if (customer.authenticated) loadTab(activeTab);
    else renderAuth();
  }

  function renderAuth() {
    const register = authMode === 'register';
    view.innerHTML = `<section class="account-auth"><div class="account-auth-heading"><p class="eyebrow">SEU ESPAÇO NA MR1</p><h3>${register ? 'Seu estilo começa aqui.' : 'Bom ter você de volta.'}</h3><p>${register ? 'Crie sua conta para guardar favoritos e acompanhar os pedidos feitos enquanto você estiver conectado.' : 'Entre para ver suas peças favoritas e acompanhar seus pedidos.'}</p></div><div class="account-auth-tabs" aria-label="Acesso à conta"><button type="button" data-account-mode="login" class="${register ? '' : 'is-active'}" aria-pressed="${!register}">Entrar</button><button type="button" data-account-mode="register" class="${register ? 'is-active' : ''}" aria-pressed="${register}">Criar conta</button></div><form id="customer-auth-form" class="admin-form account-auth-form">${register ? '<label for="customer-name">Seu nome<input id="customer-name" name="name" autocomplete="name" required minlength="2" maxlength="100" placeholder="Como podemos chamar você?"></label>' : ''}<label for="customer-email">E-mail<input id="customer-email" name="email" type="email" autocomplete="username" required maxlength="254" placeholder="Seu e-mail"></label><label for="customer-password">Senha<input id="customer-password" name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" required ${register ? 'minlength="12"' : ''} maxlength="256" placeholder="${register ? 'Crie uma senha com pelo menos 12 caracteres' : 'Sua senha'}"></label>${register ? '<label for="customer-password-confirm">Confirme sua senha<input id="customer-password-confirm" name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="256" placeholder="Digite novamente a senha"></label>' : ''}<p class="account-auth-error form-error" id="customer-auth-error" role="alert"></p><button type="submit" class="button button-dark" ${authBusy ? 'disabled' : ''}>${authBusy ? 'AGUARDE...' : register ? 'CRIAR MINHA CONTA' : 'ENTRAR NA MINHA CONTA'} <span aria-hidden="true">↗</span></button></form><p class="account-auth-note">${register ? 'Seus favoritos ficam salvos na sua conta para você acessar de outro dispositivo.' : 'Acesso de clientes. Para editar a loja, use “Gerenciar loja” no rodapé.'}</p></section>`;
  }

  function tabHeader() {
    return `<div class="account-welcome"><p>Olá, <strong>${escape(customer.name || 'cliente')}</strong>.</p><span>Seu estilo tem lugar aqui.</span></div><nav class="account-tabs" aria-label="Sua conta"><button type="button" data-account-tab="orders" class="${activeTab === 'orders' ? 'is-active' : ''}" aria-pressed="${activeTab === 'orders'}">Meus pedidos</button><button type="button" data-account-tab="favorites" class="${activeTab === 'favorites' ? 'is-active' : ''}" aria-pressed="${activeTab === 'favorites'}">Favoritos${favorites.length ? ` <span>${favorites.length}</span>` : ''}</button><button type="button" data-account-tab="profile" class="${activeTab === 'profile' ? 'is-active' : ''}" aria-pressed="${activeTab === 'profile'}">Minha conta</button></nav>`;
  }

  function dateLabel(value) {
    const date = new Date(typeof value === 'number' ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(date) : '';
  }

  function renderOrders() {
    if (ordersError) return `<div class="account-empty"><h3>Não foi possível carregar seus pedidos.</h3><p>${escape(ordersError)}</p><button type="button" class="text-button" data-account-retry="orders">Tentar novamente</button></div>`;
    if (!ordersLoaded) return '<p class="account-loading" role="status">Buscando seus pedidos...</p>';
    if (!orders.length) return '<div class="account-empty"><span aria-hidden="true">↗</span><h3>Seu primeiro look está esperando.</h3><p>Os pedidos feitos enquanto você estiver conectado aparecerão aqui. Você ainda não tem pedidos nesta conta.</p><button type="button" class="button button-dark" data-account-explore>EXPLORAR A COLEÇÃO <span aria-hidden="true">↗</span></button></div>';
    return `<div class="customer-orders">${orders.map((order) => `<article class="customer-order"><header><div><small>PEDIDO ${escape(String(order.id || '').slice(0, 8).toUpperCase())}</small><p>${escape(dateLabel(order.created))}</p></div><span class="customer-order-status${order.status === 'paid' ? ' is-paid' : ''}">${escape(statusLabels[order.status] || 'Em acompanhamento')}</span></header><div class="customer-order-total"><span>${Array.isArray(order.items) ? order.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0) : 0} peça(s)</span><strong>${money(order.total)}</strong></div><details><summary>Ver peças e valores</summary><ul>${(Array.isArray(order.items) ? order.items : []).map((item) => `<li><div><strong>${escape(item.name || 'Peça MR1')}</strong><span>Tamanho ${escape(item.size)} · Quantidade ${escape(item.quantity)}</span></div><b>${money(Number(item.unitPrice || 0) * Number(item.quantity || 0))}</b></li>`).join('')}</ul><div class="customer-order-costs"><p><span>Subtotal</span><span>${money(order.subtotal)}</span></p><p><span>Entrega</span><span>${money(order.shipping)}</span></p></div></details>${order.status === 'paid_review' ? '<p class="customer-order-note">O pagamento foi recebido. A loja está conferindo o pedido antes da confirmação final.</p>' : ''}</article>`).join('')}</div><button type="button" class="text-button" data-account-retry="orders">Atualizar meus pedidos</button>`;
  }

  function renderFavorites() {
    if (favoritesError) return `<div class="account-empty"><h3>Não foi possível carregar seus favoritos.</h3><p>${escape(favoritesError)}</p><button type="button" class="text-button" data-account-retry="favorites">Tentar novamente</button></div>`;
    if (!favoritesLoaded) return '<p class="account-loading" role="status">Buscando suas peças favoritas...</p>';
    if (!favorites.length) return '<div class="account-empty"><span aria-hidden="true">♡</span><h3>Guarde o que combina com você.</h3><p>Toque no coração das peças que você gostar. Seus favoritos ficam salvos aqui, mesmo quando você trocar de dispositivo.</p><button type="button" class="button button-dark" data-account-explore>ENCONTRAR MEUS FAVORITOS <span aria-hidden="true">↗</span></button></div>';
    return `<div class="account-favorites">${favorites.map((product) => `<article class="account-favorite"><button type="button" class="account-favorite-photo" data-account-product="${escape(product.id)}" aria-label="Ver ${escape(product.name)}"><img src="${escape(safeImage(product.image))}" alt="${escape(product.name)}" loading="lazy" width="150" height="190"></button><div><h3>${escape(product.name)}</h3><p>${money(product.price)}</p><button type="button" class="text-button" data-account-product="${escape(product.id)}">VER PEÇA ↗</button></div><button type="button" class="account-favorite-remove" data-favorite-id="${escape(product.id)}" data-favorite-name="${escape(product.name)}" aria-label="Remover dos favoritos" aria-pressed="true">×</button></article>`).join('')}</div>`;
  }

  function renderProfile() {
    return `<section class="account-profile"><h3>Sua conta MR1</h3><dl><dt>Nome</dt><dd>${escape(customer.name)}</dd><dt>E-mail</dt><dd>${escape(customer.email)}</dd></dl><p>Seus favoritos e os pedidos feitos durante o login são vinculados a esta conta. Pedidos de visitantes não são associados automaticamente pelo e-mail informado.</p><button type="button" class="button button-dark" data-account-logout>SAIR DA MINHA CONTA <span aria-hidden="true">↗</span></button></section>`;
  }

  function renderAccount() {
    if (!customer.authenticated) { renderAuth(); return; }
    view.innerHTML = tabHeader() + `<section class="account-tab-content" aria-live="polite">${activeTab === 'favorites' ? renderFavorites() : activeTab === 'profile' ? renderProfile() : renderOrders()}</section>`;
    updateFavoriteButtons();
  }

  async function loadTab(tab) {
    if (!customer.authenticated) { renderAuth(); return; }
    activeTab = ['orders', 'favorites', 'profile'].includes(tab) ? tab : 'orders';
    const request = ++tabRequest;
    if (activeTab === 'orders') { ordersLoaded = false; ordersError = ''; }
    if (activeTab === 'favorites') { favoritesLoaded = false; favoritesError = ''; }
    renderAccount();
    try {
      if (activeTab === 'orders') await loadOrders();
      else if (activeTab === 'favorites') await loadFavorites();
    } catch (error) {
      if (!customer.authenticated) message(error.message, true);
    }
    if (request === tabRequest && dialog.open) renderAccount();
  }

  async function submitAuth(event) {
    event.preventDefault();
    const form = event.target;
    if (!form.matches('#customer-auth-form') || authBusy || !form.reportValidity()) return;
    const register = authMode === 'register';
    const field = (name) => form.elements.namedItem(name);
    const errorElement = $('customer-auth-error');
    errorElement.textContent = '';
    if (register && field('password').value !== field('confirmPassword').value) {
      errorElement.textContent = 'As senhas não coincidem. Digite a mesma senha nos dois campos.';
      field('confirmPassword').focus(); return;
    }
    const payload = { email: field('email').value.trim(), password: field('password').value };
    if (register) payload.name = field('name').value.trim();
    authBusy = true;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const data = await api('/api/account/' + (register ? 'register' : 'login'), { method: 'POST', body: payload });
      if (data.confirmationRequired) {
        authBusy = false;
        authMode = 'login'; renderAuth();
        message('Conta solicitada. Confirme o link enviado pelo Supabase ao seu e-mail e depois entre com sua senha.');
        return;
      }
      if (!data.authenticated || !data.csrfToken) throw new Error('O acesso não foi confirmado pelo servidor. Tente entrar novamente.');
      identityVersion++;
      customer = data; favorites = []; orders = []; favoritesLoaded = false; ordersLoaded = false; favoritesError = ''; ordersError = '';
      emitSession(); emitFavorites();
      message(register ? 'Conta criada. Seu espaço na MR1 está pronto.' : 'Você entrou na sua conta.');
      if (pendingFavorite) {
        const id = pendingFavorite; pendingFavorite = null;
        try { await loadFavorites(); await toggleFavorite(id, true); }
        catch (error) { message(error.message, true); }
        activeTab = 'favorites';
      }
      await loadTab(activeTab);
    } catch (error) {
      if (dialog.open && $('customer-auth-error')) $('customer-auth-error').textContent = error.message;
      else message(error.message, true);
    } finally {
      payload.password = '';
      if (field('password')) field('password').value = '';
      if (field('confirmPassword')) field('confirmPassword').value = '';
      authBusy = false;
      if (button.isConnected) button.disabled = false;
    }
  }

  async function logout(button) {
    if (button) button.disabled = true;
    try {
      await api('/api/account/logout', { method: 'POST', body: {}, authenticated: true });
      clearCustomer(); pendingFavorite = null;
      authMode = 'login'; renderAuth(); message('Você saiu da sua conta.');
    } catch (error) { message(error.message, true); }
    finally { if (button?.isConnected) button.disabled = false; }
  }

  async function toggleFavorite(id, forceAdd = false) {
    if (!id || favoriteRequests.has(id)) return;
    if (!customer.authenticated) {
      pendingFavorite = id; authMode = 'login'; openAccount('favorites');
      message('Entre ou crie sua conta para guardar essa peça nos favoritos.');
      return;
    }
    const version = identityVersion;
    favoriteRequests.add(id); updateFavoriteButtons();
    try {
      const exists = favorites.some((product) => String(product.id) === id);
      if (!(exists && forceAdd)) await api('/api/account/favorites/' + encodeURIComponent(id), { method: exists ? 'DELETE' : 'PUT', body: {}, authenticated: true });
      if (version !== identityVersion || !customer.authenticated) return;
      await loadFavorites();
      if (dialog.open && activeTab === 'favorites') renderAccount();
      message(exists && !forceAdd ? 'Peça removida dos favoritos.' : 'Peça salva nos seus favoritos.');
      if (!dialog.open) announceFavorite(exists && !forceAdd ? 'Peça removida dos favoritos.' : 'Peça salva nos favoritos.');
    } catch (error) {
      if (!customer.authenticated) {
        pendingFavorite = id; authMode = 'login'; openAccount('favorites');
      }
      message(error.message, true);
      if (!dialog.open) announceFavorite(error.message);
    } finally { favoriteRequests.delete(id); updateFavoriteButtons(); }
  }

  function announceFavorite(text) {
    let element = $('favorite-message');
    if (!element) { element = document.createElement('p'); element.id = 'favorite-message'; element.className = 'favorite-message'; element.setAttribute('role', 'status'); element.setAttribute('aria-live', 'polite'); document.body.appendChild(element); }
    element.textContent = text;
    element.hidden = false;
    clearTimeout(announceFavorite.timer);
    announceFavorite.timer = setTimeout(() => { element.hidden = true; }, 4000);
  }

  $('account-button')?.addEventListener('click', () => openAccount());
  $('account-close')?.addEventListener('click', () => dialog.close());
  view.addEventListener('submit', submitAuth);
  document.addEventListener('click', (event) => {
    const favorite = event.target.closest('[data-favorite-id]');
    if (favorite) { event.preventDefault(); toggleFavorite(favorite.dataset.favoriteId); return; }
    const open = event.target.closest('[data-open-account]');
    if (open) { event.preventDefault(); openAccount(open.dataset.openAccount || null); }
  });
  view.addEventListener('click', (event) => {
    const mode = event.target.closest('[data-account-mode]');
    if (mode && !authBusy) { authMode = mode.dataset.accountMode === 'register' ? 'register' : 'login'; message(''); renderAuth(); return; }
    const tab = event.target.closest('[data-account-tab]');
    if (tab) { message(''); loadTab(tab.dataset.accountTab); return; }
    const retry = event.target.closest('[data-account-retry]');
    if (retry) { message(''); loadTab(retry.dataset.accountRetry); return; }
    const signout = event.target.closest('[data-account-logout]');
    if (signout) { logout(signout); return; }
    const product = event.target.closest('[data-account-product]');
    if (product) { dialog.close(); document.dispatchEvent(new CustomEvent('mr1:open-product', { detail: { id: product.dataset.accountProduct } })); return; }
    if (event.target.closest('[data-account-explore]')) { dialog.close(); $('catalogo')?.scrollIntoView({ behavior: 'smooth' }); }
  });
  dialog.addEventListener('close', () => {
    authBusy = false;
    view.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ''; });
  });
  document.addEventListener('mr1:open-account', (event) => openAccount(event.detail?.tab));
  const grid = $('product-grid');
  if (grid) new MutationObserver(updateFavoriteButtons).observe(grid, { childList: true, subtree: true });
  window.MR1Account = Object.freeze({
    open: openAccount,
    refresh: () => loadSession(),
    isFavorite: (id) => Boolean(customer.authenticated && favorites.some((product) => String(product.id) === String(id))),
    getSession: () => ({ authenticated: Boolean(customer.authenticated), name: customer.name || '', email: customer.email || '' })
  });
  document.addEventListener('mr1:auth-changed', () => loadSession().catch(() => {}));
  message(''); emitSession();
  loadSession().catch((error) => { if (dialog.open) message(error.message, true); });
})();
