// Utilitários partilhados pelas áreas de cliente e de administração.
// Todo o conteúdo dinâmico é inserido com textContent (nunca innerHTML).
(function () {
  'use strict';

  const APG = {};

  APG.api = async function (caminho, { metodo = 'GET', corpo } = {}) {
    const resposta = await fetch(`/api${caminho}`, {
      method: metodo,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-APG-Pedido': '1' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    let dados = null;
    if (resposta.status !== 204) {
      try { dados = await resposta.json(); } catch (e) { dados = null; }
    }
    if (!resposta.ok) {
      const erro = new Error((dados && dados.erro) || 'Ocorreu um erro. Tente novamente.');
      erro.status = resposta.status;
      erro.campos = dados && dados.campos;
      erro.dados = dados;
      throw erro;
    }
    return dados;
  };

  // el('div', { class: 'x', text: 'olá', onclick: fn }, filho1, filho2)
  APG.el = function (tag, atributos, ...filhos) {
    const no = document.createElement(tag);
    for (const [chave, valor] of Object.entries(atributos || {})) {
      if (valor === null || valor === undefined || valor === false) continue;
      if (chave === 'text') no.textContent = valor;
      else if (chave === 'class') no.className = valor;
      else if (chave.startsWith('on')) no.addEventListener(chave.slice(2), valor);
      else if (chave === 'dataset') Object.assign(no.dataset, valor);
      else no.setAttribute(chave, valor === true ? '' : valor);
    }
    for (const filho of filhos.flat()) {
      if (filho === null || filho === undefined || filho === false) continue;
      no.append(filho instanceof Node ? filho : document.createTextNode(String(filho)));
    }
    return no;
  };

  APG.limpar = function (no) { while (no.firstChild) no.removeChild(no.firstChild); return no; };

  // Formato do site: 3.450 MT (ponto nos milhares, vírgula nas casas decimais).
  APG.mt = function (centavos) {
    if (centavos === null || centavos === undefined) return '—';
    const negativo = centavos < 0;
    const abs = Math.abs(Math.round(centavos));
    const inteiro = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const resto = abs % 100;
    const decimais = resto ? `,${String(resto).padStart(2, '0')}` : '';
    return `${negativo ? '-' : ''}${inteiro}${decimais} MT`;
  };

  APG.data = function (iso) {
    if (!iso) return '—';
    const [a, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}/${a}`;
  };

  APG.dataHora = function (iso) {
    if (!iso) return '—';
    if (iso.length <= 10) return APG.data(iso);
    const d = new Date(iso);
    return `${d.toLocaleDateString('pt-PT')} ${d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}`;
  };

  APG.estado = function (codigo, rotulo) {
    return APG.el('span', { class: `estado estado-${codigo}`, text: rotulo || codigo });
  };

  APG.METODOS = {
    numerario: 'Numerário', mpesa: 'M-Pesa', emola: 'e-Mola', mkesh: 'mKesh', transferencia: 'Transferência bancária', outro: 'Outro',
  };
  APG.ESTADOS_PRESTACAO = { por_pagar: 'Por pagar', parcial: 'Parcial', paga: 'Paga' };

  // Mesma fórmula do simulador do site: encargo = valor × percentagem do prazo.
  APG.simular = function (valorMt, percentagem) {
    const montante = Math.round(Number(valorMt) * 100);
    const encargo = Math.round((montante * percentagem) / 100);
    return { montante, encargo, total: montante + encargo };
  };

  APG.abrirDialogo = function (dialogo) {
    if (typeof dialogo.showModal === 'function') dialogo.showModal(); else dialogo.setAttribute('open', '');
  };

  APG.uuid = function () {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  };

  let temporizador = null;
  APG.toast = function (mensagem, erro) {
    let t = document.querySelector('.toast');
    if (!t) { t = APG.el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(t); }
    t.textContent = mensagem;
    t.classList.toggle('erro', Boolean(erro));
    t.hidden = false;
    clearTimeout(temporizador);
    temporizador = setTimeout(() => { t.hidden = true; }, 4500);
  };

  // Lê os campos com atributo name. Checkboxes → booleano; números ficam como texto
  // (o servidor valida e converte).
  APG.dadosFormulario = function (form) {
    const dados = {};
    for (const campo of form.querySelectorAll('[name]')) {
      if (campo.type === 'checkbox') dados[campo.name] = campo.checked;
      else if (campo.type === 'radio') { if (campo.checked) dados[campo.name] = campo.value; }
      else dados[campo.name] = campo.value;
    }
    return dados;
  };

  APG.limparErros = function (form) {
    form.querySelectorAll('.erro-campo').forEach((e) => e.remove());
    form.querySelectorAll('.com-erro').forEach((e) => e.classList.remove('com-erro'));
    const aviso = form.querySelector('.aviso-form');
    if (aviso) aviso.remove();
  };

  APG.mostrarErro = function (form, erro) {
    APG.limparErros(form);
    let primeiro = null;
    for (const [nome, mensagem] of Object.entries(erro.campos || {})) {
      const campo = form.querySelector(`[name="${CSS.escape(nome)}"]`);
      const caixa = campo && (campo.closest('.campo') || campo.closest('.campo-check'));
      if (!caixa) continue;
      caixa.classList.add('com-erro');
      caixa.append(APG.el('div', { class: 'erro-campo', text: mensagem }));
      if (!primeiro) primeiro = campo;
    }
    form.prepend(APG.el('div', { class: 'aviso aviso-erro aviso-form', role: 'alert', text: erro.message }));
    if (primeiro) primeiro.focus();
  };

  // Submete um formulário uma única vez de cada vez (evita submissões duplicadas).
  APG.aoSubmeter = function (form, accao) {
    form.addEventListener('submit', async (evento) => {
      evento.preventDefault();
      if (form.dataset.aEnviar === '1') return;
      form.dataset.aEnviar = '1';
      const botoes = form.querySelectorAll('button[type="submit"]');
      botoes.forEach((b) => { b.disabled = true; });
      APG.limparErros(form);
      try {
        await accao(APG.dadosFormulario(form));
      } catch (erro) {
        if (erro.status === 401 && !form.dataset.publico) { window.location.href = '/conta/entrar'; return; }
        APG.mostrarErro(form, erro);
      } finally {
        form.dataset.aEnviar = '';
        botoes.forEach((b) => { b.disabled = false; });
      }
    });
  };

  APG.sair = async function () {
    try { await APG.api('/auth/sair', { metodo: 'POST' }); } catch (e) { /* segue para a página de entrada */ }
    window.location.href = '/conta/entrar';
  };

  window.APG = APG;
}());
