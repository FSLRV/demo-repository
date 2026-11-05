(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const TEXT_FIELDS = [
    ['brandName', 'Nome da loja', 80],
    ['announcementText', 'Aviso no topo da página', 180],
    ['heroEyebrow', 'Chamada da coleção', 80],
    ['heroTitleLine1', 'Título principal — primeira linha', 60],
    ['heroTitleLine2', 'Título principal — segunda linha', 40],
    ['heroTitleAccent', 'Parte destacada do título', 40],
    ['heroDescription', 'Descrição da capa', 400],
    ['heroButtonText', 'Texto do botão da capa', 60],
    ['manifestoEyebrow', 'Chamada sobre a marca', 100],
    ['manifestoTitleLine1', 'Título sobre a marca — primeira linha', 80],
    ['manifestoTitleLine2', 'Título sobre a marca — segunda linha', 80],
    ['manifestoTitleAccent', 'Parte destacada sobre a marca', 40],
    ['manifestoText', 'Texto sobre a marca', 1000],
    ['footerText', 'Texto no rodapé', 200],
  ];
  const IMAGE_FIELDS = [
    ['logoUrl', 'Logotipo principal', 'Usado no cabeçalho e no rodapé. PNG com transparência funciona bem.'],
    ['logoLightUrl', 'Logotipo para fundo escuro', 'Usado na seção sobre a marca. Prefira a versão clara do seu logo.'],
    ['heroImage', 'Foto principal da loja', 'Use uma foto vertical ou uma composição que funcione também no celular.'],
  ];
  const COLOR_FIELDS = [
    ['primaryColor', 'Cor principal', '#142B49'],
    ['accentColor', 'Cor de destaque', '#88765B'],
    ['backgroundColor', 'Cor de fundo', '#F4F7F8'],
  ];
  let settings = null;
  let dirty = false;
  let loading = false;
  let saving = false;
  let requestVersion = 0;

  function safeImage(value) {
    const src = String(value || '').trim();
    if (/^\/?assets\/[a-z0-9._/-]+$/i.test(src) && !src.includes('..')) return src;
    if (/^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp)$/i.test(src)) return src;
    try {
      const url = new URL(src);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* Leave the existing image intact for an invalid response. */ }
    return '';
  }

  async function request(path, options = {}) {
    let response;
    try {
      response = await window.MR1Backend.fetch(path, {
        credentials: 'same-origin', cache: 'no-store', ...options,
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
      });
    } catch {
      throw new Error('Não foi possível acessar a loja. Confira a conexão e tente novamente.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof data.error === 'string' ? data.error : 'Não foi possível concluir a operação. Tente novamente.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function feedback(message, error = false) {
    const node = $('site-editor-feedback');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('is-error', error);
    node.setAttribute('role', error ? 'alert' : 'status');
  }

  function applySettings(value, refreshTheme = false) {
    if (!value || typeof value !== 'object') return;
    document.querySelectorAll('[data-site]').forEach((node) => {
      const field = node.dataset.site;
      if (typeof value[field] === 'string') node.textContent = value[field];
    });
    document.querySelectorAll('[data-site-image]').forEach((node) => {
      const field = node.dataset.siteImage;
      const source = safeImage(value[field]);
      if (source) node.setAttribute('src', source);
      if (typeof value.brandName === 'string') node.setAttribute('alt', field === 'heroImage' ? `Coleção ${value.brandName}` : value.brandName);
    });
    document.querySelectorAll('[data-site-link]').forEach((node) => {
      const field = node.dataset.siteLink;
      const raw = String(value[field] || '').trim();
      let href = '';
      if (field === 'contactEmail' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) href = 'mailto:' + raw;
      if (field === 'instagramUrl') {
        try { const url = new URL(raw); if (url.protocol === 'https:' && !url.username && !url.password) href = url.href; } catch { /* Empty optional link. */ }
      }
      node.hidden = !href;
      if (href) { node.setAttribute('href', href); node.setAttribute('rel', 'noopener noreferrer'); }
      else node.removeAttribute('href');
    });
    if (typeof value.brandName === 'string' && value.brandName.trim()) {
      document.title = value.brandName;
      document.querySelectorAll('[data-site-brand-label]').forEach((node) => node.setAttribute('aria-label', value.brandName + ', início'));
    }
    if (typeof value.heroDescription === 'string') document.querySelector('meta[name="description"]')?.setAttribute('content', value.heroDescription);
    if (/^#[0-9a-f]{6}$/i.test(value.primaryColor || '')) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value.primaryColor);
    window.MR1Theme?.apply(value);
    document.dispatchEvent(new CustomEvent('mr1:site-settings', { detail: value }));
  }

  function buildEditor() {
    const section = $('site-editor-section');
    if (!section) return;
    const textInput = (key, label, max) => `<label>${escape(label)}${['heroDescription', 'manifestoText', 'footerText'].includes(key) ? `<textarea name="${key}" maxlength="${max}" rows="${key === 'manifestoText' ? '4' : '3'}"></textarea>` : `<input name="${key}" type="text" maxlength="${max}">`}</label>`;
    section.innerHTML = `<div class="site-editor-heading"><div><p class="eyebrow">A LOJA COM A SUA CARA</p><h3>Personalizar o site</h3></div><p>Edite os textos, troque imagens e escolha as cores. Depois, salve para atualizar a loja para todos os clientes.</p></div><form id="site-settings-form" class="admin-form site-settings-form"><details open><summary>Identidade e cores</summary><div class="site-editor-fields">${textInput(...TEXT_FIELDS[0])}<div class="site-color-grid">${COLOR_FIELDS.map(([key, label, fallback]) => `<label class="site-color-field">${label}<span><input type="color" name="${key}" value="${fallback}" aria-label="${label}"><input type="text" data-color-hex="${key}" value="${fallback}" pattern="#[0-9a-fA-F]{6}" maxlength="7" aria-label="${label} em hexadecimal"></span></label>`).join('')}</div>${IMAGE_FIELDS.slice(0, 2).map(([key, label, hint]) => `<fieldset class="site-image-field"><legend>${label}</legend><img data-editor-image="${key}" alt="${label} atual" width="160" height="90"><label>Enviar nova imagem<input name="${key}File" type="file" accept="image/png,image/jpeg,image/webp"></label><label>Ou usar endereço da imagem<input name="${key}Url" type="url" maxlength="2000" placeholder="https://..."></label><small>${hint} JPG, PNG ou WebP, até 2 MB. Deixe vazio para manter a imagem atual.</small></fieldset>`).join('')}</div></details><details><summary>Capa e coleção</summary><div class="site-editor-fields">${TEXT_FIELDS.slice(1, 8).map((field) => textInput(...field)).join('')}${IMAGE_FIELDS.slice(2).map(([key, label, hint]) => `<fieldset class="site-image-field"><legend>${label}</legend><img data-editor-image="${key}" alt="Foto principal atual" width="200" height="160"><label>Enviar nova foto<input name="${key}File" type="file" accept="image/png,image/jpeg,image/webp"></label><label>Ou usar endereço da imagem<input name="${key}Url" type="url" maxlength="2000" placeholder="https://..."></label><small>${hint} Máximo de 2 MB. Deixe vazio para manter a foto atual.</small></fieldset>`).join('')}</div></details><details><summary>Sobre a marca e rodapé</summary><div class="site-editor-fields">${TEXT_FIELDS.slice(8).map((field) => textInput(...field)).join('')}<div class="form-row"><label>E-mail de contato<input name="contactEmail" type="email" maxlength="254" placeholder="Opcional"></label><label>Instagram<input name="instagramUrl" type="url" maxlength="2000" placeholder="https://www.instagram.com/sua-marca"></label></div><small>Deixe o contato ou Instagram vazio se não quiser exibir esses links.</small></div></details><p id="site-editor-feedback" class="site-editor-feedback" role="status" aria-live="polite"></p><div class="site-editor-actions"><button type="submit" class="button button-dark" id="site-editor-save">SALVAR ALTERAÇÕES NO SITE <span>↗</span></button><button type="button" class="text-button" id="site-editor-reload">Recarregar informações salvas</button></div></form>`;
    const form = $('site-settings-form');
    form.addEventListener('input', () => { dirty = true; });
    form.addEventListener('change', () => { dirty = true; });
    COLOR_FIELDS.forEach(([key]) => {
      const color = form.elements.namedItem(key);
      const hex = form.querySelector(`[data-color-hex="${key}"]`);
      color.addEventListener('input', () => { hex.value = color.value.toUpperCase(); hex.setCustomValidity(''); });
      hex.addEventListener('input', () => {
        if (/^#[a-f0-9]{6}$/i.test(hex.value)) { color.value = hex.value; hex.setCustomValidity(''); }
        else hex.setCustomValidity('Informe uma cor no formato #142B49.');
      });
    });
    form.addEventListener('submit', save);
    $('site-editor-reload').addEventListener('click', () => {
      if (dirty && !window.confirm('Descartar as alterações ainda não salvas e recarregar o site atual?')) return;
      loadEditor(true);
    });
  }

  function populateForm(value) {
    const form = $('site-settings-form');
    if (!form || !value) return;
    [...TEXT_FIELDS.map(([key]) => key), 'contactEmail', 'instagramUrl'].forEach((key) => {
      const input = form.elements.namedItem(key); if (input) input.value = value[key] || '';
    });
    COLOR_FIELDS.forEach(([key, , fallback]) => {
      const color = /^#[a-f0-9]{6}$/i.test(value[key] || '') ? value[key] : fallback;
      form.elements.namedItem(key).value = color;
      const hex = form.querySelector(`[data-color-hex="${key}"]`); hex.value = color.toUpperCase(); hex.setCustomValidity('');
    });
    IMAGE_FIELDS.forEach(([key]) => {
      const preview = form.querySelector(`[data-editor-image="${key}"]`);
      const source = safeImage(value[key]); if (source) preview.src = source;
      form.elements.namedItem(key + 'Url').value = '';
      form.elements.namedItem(key + 'File').value = '';
    });
    dirty = false;
  }

  async function loadPublic() {
    try {
      const data = await request('/api/site/settings');
      if (!data.settings || typeof data.settings !== 'object') throw new Error('As configurações da loja retornaram uma resposta inválida.');
      settings = data.settings; applySettings(settings);
      if (!dirty && !saving) populateForm(settings);
    } catch {
      // Existing content stays usable when the settings endpoint is temporarily unavailable.
    }
  }

  async function loadEditor(force = false) {
    if (!$('site-settings-form') || loading || saving || (dirty && !force)) return;
    const version = ++requestVersion;
    loading = true; feedback('Carregando as informações da loja...');
    try {
      const session = await request('/api/session');
      if (!session.authenticated) throw new Error('Entre no painel para editar as informações da loja.');
      const data = await request('/api/site/settings');
      if (version !== requestVersion) return;
      settings = data.settings;
      if (!settings || typeof settings !== 'object') throw new Error('Não foi possível carregar as informações da loja.');
      populateForm(settings); applySettings(settings); feedback('');
    } catch (error) { if (version === requestVersion) feedback(error.message, true); }
    finally { loading = false; }
  }

  function readImage(file) {
    return new Promise((resolve, reject) => {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return reject(new Error('Use uma imagem JPG, PNG ou WebP. Para logo com transparência, prefira PNG.'));
      if (file.size > 2_000_000) return reject(new Error('A imagem deve ter até 2 MB. Escolha um arquivo menor.'));
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Não foi possível ler a imagem. Tente novamente.'));
      reader.readAsDataURL(file);
    });
  }

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const form = $('site-settings-form');
    if (!form.reportValidity()) return;
    if (!settings) return feedback('Recarregue as informações antes de salvar.', true);
    saving = true;
    const controls = [...form.elements];
    const disabled = controls.map((node) => node.disabled);
    controls.forEach((node) => { node.disabled = true; });
    feedback('Salvando as informações da loja...');
    try {
      const session = await request('/api/session');
      if (!session.authenticated || !session.csrfToken) throw new Error('Sua sessão expirou. Entre novamente no painel para salvar.');
      const payload = {};
      [...TEXT_FIELDS.map(([key]) => key), 'contactEmail', 'instagramUrl'].forEach((key) => { payload[key] = form.elements.namedItem(key).value.trim(); });
      COLOR_FIELDS.forEach(([key]) => { payload[key] = form.elements.namedItem(key).value.toUpperCase(); });
      // Uploads complete before the single settings update; failures leave the published settings intact.
      for (const [key] of IMAGE_FIELDS) {
        const file = form.elements.namedItem(key + 'File').files[0];
        const url = form.elements.namedItem(key + 'Url').value.trim();
        if (file) {
          const result = await request('/api/uploads', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ dataUrl: await readImage(file) }) });
          if (!safeImage(result.url)) throw new Error('O envio da imagem retornou uma resposta inválida.');
          payload[key] = result.url;
        } else if (url) {
          if (!safeImage(url)) throw new Error('Informe um endereço HTTPS válido para a imagem.');
          payload[key] = url;
        }
      }
      const data = await request('/api/site/settings', { method: 'PUT', headers: { 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(payload) });
      if (!data.settings || typeof data.settings !== 'object') throw new Error('Não foi possível confirmar o salvamento. Recarregue as informações antes de tentar novamente.');
      settings = data.settings; populateForm(settings); applySettings(settings, true);
      feedback('Pronto! As informações foram salvas e o site foi atualizado.');
    } catch (error) { feedback(error.message, true); }
    finally { controls.forEach((node, index) => { node.disabled = disabled[index]; }); saving = false; }
  }

  function setup() {
    buildEditor();
    loadPublic();
    const workspace = $('admin-workspace');
    if (workspace) {
      new MutationObserver(() => {
        if (!workspace.hidden) loadEditor();
        else {
          requestVersion++;
          if (!saving && settings) populateForm(settings);
          feedback('');
        }
      }).observe(workspace, { attributes: true, attributeFilter: ['hidden'] });
      if (!workspace.hidden) loadEditor();
    }
    document.addEventListener('mr1:admin-session', (event) => { if (event.detail?.authenticated) loadEditor(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
})();
