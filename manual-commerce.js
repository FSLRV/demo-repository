/* Manual fulfilment: the customer reports a Pix; only an administrator can
   confirm receipt. All transitions and stock reservations run in PostgreSQL. */
(() => {
  'use strict';
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
  const statuses = { awaiting_review: 'Aguardando conferência da loja', awaiting_payment: 'Pix disponível — aguardando pagamento', payment_reported: 'Pagamento informado — aguardando conferência', shipped: 'Enviado', delivered: 'Entregue' };
  function customerMarkup(order) {
    if (!order.manual) return '';
    if (order.status === 'awaiting_review') return '<p class="customer-order-note">A loja vai conferir a disponibilidade e a entrega, e liberar o Pix aqui. O estoque será reservado ao liberar o pagamento. Aguarde a confirmação do valor final.</p>';
    const payable = ['awaiting_payment', 'payment_reported'].includes(order.status);
    const service = order.shippingService;
    const delivery = service?.deliveryDays && order.status !== 'cancelled' ? `<p class="customer-order-note">Entrega: ${escape(service.company || 'MR1')}. Prazo após envio: ${escape(service.deliveryDays)} dia(s) úteis.</p>` : '';
    return `${delivery}${payable && order.pix ? `<section class="pix-payment"><h4>Pix copia e cola</h4><p>Total: <strong>${money(order.total)}</strong>. Confira o valor e o nome do recebedor no seu banco antes de confirmar.</p><label>Código Pix<textarea readonly rows="4" aria-label="Código Pix do pedido">${escape(order.pix)}</textarea></label><button type="button" class="text-button" data-copy-pix>Copiar código Pix</button>${order.status === 'awaiting_payment' ? `<button type="button" class="button button-dark" data-report-pix="${escape(order.id)}">JÁ PAGUEI O PIX ↗</button>` : '<p>Você informou o pagamento. A MR1 está conferindo o recebimento no banco.</p>'}<p class="pix-feedback" role="status"></p></section>` : ''}${order.trackingCode ? `<p class="customer-order-note">Código de rastreio dos Correios: <strong>${escape(order.trackingCode)}</strong>. <a href="https://rastreamento.correios.com.br/" target="_blank" rel="noopener noreferrer">Acompanhar encomenda ↗</a></p>` : ''}`;
  }
  function adminMarkup(order) {
    if (!order.manual) return '';
    const address = order.customer?.address || {};
    const capital = address.state === 'SP' && ['SÃO PAULO', 'SAO PAULO'].includes(String(address.city || '').trim().toUpperCase()) && /^(?:0[1-5]\d{6}|08[0-4]\d{5})$/.test(address.cep || '');
    let markup = '<section class="manual-order-actions"><h3>Atender pedido</h3>';
    if (order.trackingCode) markup += `<p>Rastreio: <strong>${escape(order.trackingCode)}</strong></p>`;
    if (order.status === 'awaiting_review') {
      markup += `<form class="admin-form" data-prepare-order="${escape(order.id)}"><p>Confira o município no <a href="https://buscacepinter.correios.com.br/app/endereco/index.php" target="_blank" rel="noopener noreferrer">Busca CEP dos Correios</a>. Para fora da capital, consulte o valor e o prazo da postagem na agência ou no <a href="https://www.correios.com.br/enviar/precos-e-prazos" target="_blank" rel="noopener noreferrer">calculador dos Correios</a>, usando origem 05879-450 e a embalagem real.</p><div class="form-row"><label>Frete (R$)<input name="freight" type="number" min="${capital ? '0' : '0.01'}" max="10000" step="0.01" required ${capital ? 'value="0" readonly' : ''}></label><label>Prazo após envio (dias úteis)<input name="days" type="number" min="1" max="90" required></label></div><p>Peças: <strong>${money(order.subtotal)}</strong>. Gere no banco um Pix com valor fixo igual às peças mais o frete.</p><label>Pix copia e cola do pedido<textarea name="pix" rows="5" minlength="50" maxlength="2048" required placeholder="Cole o código completo gerado no seu banco"></textarea></label><label class="checkbox-label"><input name="confirmed" type="checkbox" required><span>Conferi o endereço, o frete, o prazo, o recebedor e o valor do Pix.</span></label><button class="button button-dark" type="submit">LIBERAR PIX E RESERVAR PEÇAS ↗</button><p class="manual-feedback" role="status"></p></form>`;
    }
    const choices = [];
    if (['awaiting_payment', 'payment_reported'].includes(order.status)) choices.push(['paid', 'Confirmar recebimento do Pix']);
    if (order.status === 'paid') choices.push(['shipped', 'Registrar postagem nos Correios'], ['delivered', 'Confirmar entrega']);
    if (order.status === 'shipped') choices.push(['delivered', 'Confirmar entrega']);
    if (['awaiting_review', 'awaiting_payment', 'payment_reported'].includes(order.status)) choices.push(['cancelled', 'Cancelar pedido sem pagamento']);
    if (choices.length) markup += `<form class="admin-form" data-manage-order="${escape(order.id)}"><label>Ação<select name="action">${choices.map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>${order.status === 'paid' ? '<label>Código de rastreio (para postagem)<input name="tracking" maxlength="13" placeholder="AA123456789BR"></label>' : ''}<label class="checkbox-label"><input name="confirmed" type="checkbox" required><span>Conferi o pedido. Para confirmar Pix, verifiquei o crédito na conta; para cancelar, confirmei que não há pagamento recebido.</span></label><button class="button button-dark" type="submit">SALVAR ATENDIMENTO ↗</button><p class="manual-feedback" role="status"></p></form>`;
    if (!choices.length) markup += '<p>Atendimento concluído para este status.</p>';
    return markup + '</section>';
  }
  async function post(path, body) {
    const response = await window.MR1Backend.fetch(path, { method: 'POST', body });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Não foi possível atualizar o pedido.');
    return result;
  }
  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-prepare-order], [data-manage-order]');
    if (!form) return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    const id = form.dataset.prepareOrder || form.dataset.manageOrder;
    const field = (name) => form.elements.namedItem(name);
    const feedback = form.querySelector('.manual-feedback');
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true; feedback.textContent = 'Salvando...';
    try {
      if (form.dataset.prepareOrder) {
        await post(`/api/admin/orders/${id}/prepare`, { freightCents: Math.round(Number(field('freight').value) * 100), deliveryDays: Number(field('days').value), pix: field('pix').value.trim(), confirmed: field('confirmed').checked });
      } else {
        await post(`/api/admin/orders/${id}/manage`, { action: field('action').value, tracking: String(field('tracking')?.value || '').trim().toUpperCase(), confirmed: field('confirmed').checked });
      }
      document.dispatchEvent(new CustomEvent('mr1:order-updated', { detail: { id } }));
    } catch (error) { feedback.textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.addEventListener('click', async (event) => {
    const copy = event.target.closest('[data-copy-pix]');
    if (copy) {
      const section = copy.closest('.pix-payment');
      const code = section.querySelector('textarea');
      try { await navigator.clipboard.writeText(code.value); section.querySelector('.pix-feedback').textContent = 'Código copiado. Confira o valor e o recebedor no banco.'; }
      catch { code.focus(); code.select(); section.querySelector('.pix-feedback').textContent = 'Selecione e copie o código acima.'; }
      return;
    }
    const report = event.target.closest('[data-report-pix]');
    if (!report) return;
    report.disabled = true;
    try {
      await post(`/api/account/orders/${report.dataset.reportPix}/report-pix`, {});
      document.dispatchEvent(new CustomEvent('mr1:order-updated', { detail: { id: report.dataset.reportPix } }));
    } catch (error) { report.closest('.pix-payment').querySelector('.pix-feedback').textContent = error.message; }
    finally { report.disabled = false; }
  });
  window.MR1Commerce = Object.freeze({ statuses, customerMarkup, adminMarkup });
})();
