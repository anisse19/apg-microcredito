// Painel do cliente. Todos os valores vêm de /api/me/painel (base de dados).
(function () {
  'use strict';

  const {
    api, el, limpar, mt, data, dataHora, estado, toast, aoSubmeter, simular, abrirDialogo, uuid, METODOS, ESTADOS_PRESTACAO,
  } = window.APG;
  const $ = (id) => document.getElementById(id);
  let painel = null;

  document.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('sair').addEventListener('click', window.APG.sair);

  async function carregar() {
    try {
      painel = await api('/me/painel');
    } catch (e) {
      if (e.status === 401) { window.location.replace('/conta/entrar'); return; }
      if (e.status === 403) { window.location.replace('/admin'); return; }
      $('carregar').textContent = e.message;
      return;
    }
    desenhar();
    $('carregar').hidden = true;
    $('painel').hidden = false;
  }

  function desenhar() {
    const { perfil, resumo } = painel;
    const primeiroNome = perfil.nomeCompleto.split(' ')[0];
    $('quem').textContent = perfil.nomeCompleto;
    $('saudacao').textContent = `Olá, ${primeiroNome}`;

    // ===== Resumo =====
    $('iSaldo').textContent = mt(resumo.saldoPendenteCentavos);
    $('iSaldoSub').textContent = resumo.creditosActivos
      ? `${resumo.creditosActivos} crédito(s) activo(s)` : 'Sem créditos activos';
    if (resumo.proximaPrestacao) {
      $('iProxima').textContent = mt(resumo.proximaPrestacao.emFaltaCentavos);
      $('iProximaSub').textContent = `${resumo.proximaPrestacao.emAtraso ? 'Venceu a' : 'Vence a'} ${data(resumo.proximaPrestacao.vencimento)}`;
    } else {
      $('iProxima').textContent = '—';
      $('iProximaSub').textContent = 'Nenhuma prestação por pagar';
    }
    $('iTotal').textContent = mt(resumo.totalAReembolsarCentavos);
    $('iTotalSub').textContent = `Montante contratado: ${mt(resumo.totalContratadoCentavos)}`;
    $('iPago').textContent = mt(resumo.totalPagoCentavos);
    $('iPagoSub').textContent = `${resumo.prestacoesPagas} prestação(ões) paga(s) · ${resumo.prestacoesPorPagar} por pagar`;
    const atraso = $('alertaAtraso');
    atraso.hidden = !resumo.prestacoesEmAtraso;
    atraso.textContent = resumo.prestacoesEmAtraso
      ? `Tem ${resumo.prestacoesEmAtraso} prestação(ões) com o vencimento ultrapassado. Contacte a APG para regularizar.` : '';

    desenharPedidos();
    desenharCreditos();
    desenharOperacoes();
    desenharNotificacoes();
    desenharPerfil();
  }

  function desenharPedidos() {
    const caixa = limpar($('pedidos'));
    if (!painel.pedidos.length) {
      caixa.append(el('p', { class: 'vazio', text: 'Ainda não submeteu nenhum pedido. Use «Solicitar crédito» para começar.' }));
      return;
    }
    const linhas = painel.pedidos.map((p) => el('tr', { class: 'clicavel', tabindex: '0', onclick: () => abrirPedido(p), onkeydown: (e) => { if (e.key === 'Enter') abrirPedido(p); } },
      el('td', {}, el('strong', { text: p.referencia }), el('div', { class: 'secundario', text: dataHora(p.criadoEm) })),
      el('td', { class: 'num', text: mt(p.valorCentavos) }),
      el('td', { class: 'num', text: `${p.prazoDias} dias` }),
      el('td', {}, estado(p.estado, p.estadoRotulo))));
    caixa.append(el('div', { class: 'tabela-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', { text: 'Pedido' }), el('th', { class: 'num', text: 'Valor' }), el('th', { class: 'num', text: 'Prazo' }), el('th', { text: 'Estado' }))),
      el('tbody', {}, linhas))));
  }

  function abrirPedido(p) {
    $('dDetalheTitulo').textContent = `Pedido ${p.referencia}`;
    const corpo = limpar($('dDetalheCorpo'));
    corpo.append(
      el('dl', { class: 'dados' },
        el('dt', { text: 'Estado' }), el('dd', {}, estado(p.estado, p.estadoRotulo)),
        el('dt', { text: 'Submetido' }), el('dd', { text: dataHora(p.criadoEm) }),
        el('dt', { text: 'Valor solicitado' }), el('dd', { text: mt(p.valorCentavos) }),
        el('dt', { text: 'Prazo' }), el('dd', { text: `${p.prazoDias} dias${p.percentagem != null ? ` (+${p.percentagem}%)` : ''}` }),
        el('dt', { text: 'Total estimado' }), el('dd', { text: mt(p.totalEstimadoCentavos) }),
        p.finalidade && el('dt', { text: 'Finalidade' }), p.finalidade && el('dd', { text: p.finalidade }),
        p.motivoDecisao && el('dt', { text: 'Nota da APG' }), p.motivoDecisao && el('dd', { text: p.motivoDecisao }),
        p.credito && el('dt', { text: 'Crédito' }), p.credito && el('dd', {}, `${p.credito.referencia} · `, estado(p.credito.estado, p.credito.estadoRotulo))),
      el('h3', { class: 'secundario', text: 'HISTÓRICO' }),
      el('ul', { class: 'linha-tempo' }, p.historico.map((h) => el('li', {},
        el('div', {}, el('strong', { text: h.estadoRotulo }), ` — ${h.autor}`),
        h.nota && el('div', { text: h.nota }),
        el('div', { class: 'quando', text: dataHora(h.criadoEm) })))),
    );
    if (p.estado === 'pendente_analise') {
      corpo.append(el('div', { class: 'accoes' }, el('button', {
        type: 'button',
        class: 'btn btn-perigo btn-pequeno',
        text: 'Cancelar pedido',
        onclick: async (e) => {
          if (!window.confirm(`Cancelar o pedido ${p.referencia}?`)) return;
          e.target.disabled = true;
          try {
            await api(`/me/pedidos/${p.id}/cancelar`, { metodo: 'POST' });
            $('dDetalhe').close();
            toast('Pedido cancelado.');
            carregar();
          } catch (erro) { toast(erro.message, true); e.target.disabled = false; }
        },
      })));
    }
    abrirDialogo($('dDetalhe'));
  }

  function desenharCreditos() {
    const caixa = limpar($('creditos'));
    if (!painel.creditos.length) {
      caixa.append(el('p', { class: 'vazio', text: 'Sem créditos. Os créditos aprovados pela APG aparecem aqui.' }));
      return;
    }
    for (const c of painel.creditos) {
      const percentagemPaga = c.totalCentavos ? Math.min(100, Math.round((c.pagoCentavos / c.totalCentavos) * 100)) : 0;
      const barra = el('span');
      barra.style.width = `${percentagemPaga}%`;
      const cartao = el('article', { class: 'credito' },
        el('div', { class: 'credito-topo' },
          el('div', {}, el('h3', { text: `Crédito ${c.referencia}` }),
            el('div', { class: 'secundario', text: c.desembolsadoEm ? `Desembolsado a ${data(c.desembolsadoEm)} · ${c.prazoDias} dias · +${c.percentagem}%` : `Aprovado a ${dataHora(c.aprovadoEm)} · ${c.prazoDias} dias · +${c.percentagem}%` })),
          el('div', {}, estado(c.estado, c.estadoRotulo), c.emAtraso && ' ', c.emAtraso && estado('atraso', 'Em atraso'))),
        el('div', { class: 'credito-numeros' },
          el('div', {}, 'Montante', el('strong', { text: mt(c.montanteCentavos) })),
          el('div', {}, 'Total a reembolsar', el('strong', { text: mt(c.totalCentavos) })),
          el('div', {}, 'Pago', el('strong', { text: mt(c.pagoCentavos) })),
          el('div', {}, 'Saldo pendente', el('strong', { text: mt(c.saldoCentavos) }))),
        c.estado !== 'aguarda_desembolso' && c.estado !== 'cancelado'
          ? el('div', { class: 'barra', role: 'img', 'aria-label': `${percentagemPaga}% reembolsado` }, barra) : null,
        c.estado === 'aguarda_desembolso'
          ? el('p', { class: 'texto-suave', text: 'O crédito fica activo quando a APG registar o desembolso. As prestações e datas de vencimento são definidas nesse momento.' }) : null,
        c.prestacoes.length ? el('details', { open: c.estado === 'activo' },
          el('summary', { text: `Prestações (${c.prestacoes.filter((p) => p.estado === 'paga').length}/${c.prestacoes.length} pagas)` }),
          el('div', { class: 'tabela-wrap' }, el('table', {},
            el('thead', {}, el('tr', {}, el('th', { text: 'Nº' }), el('th', { text: 'Vencimento' }), el('th', { class: 'num', text: 'Valor' }), el('th', { class: 'num', text: 'Pago' }), el('th', { text: 'Estado' }))),
            el('tbody', {}, c.prestacoes.map((p) => el('tr', {},
              el('td', { text: p.numero }),
              el('td', { text: data(p.vencimento) }),
              el('td', { class: 'num', text: mt(p.valorCentavos) }),
              el('td', { class: 'num', text: mt(p.pagoCentavos) }),
              el('td', {}, p.emAtraso ? estado('atraso', 'Em atraso') : estado(p.estado, ESTADOS_PRESTACAO[p.estado])))))))) : null,
        c.pagamentos.length ? el('details', {},
          el('summary', { text: `Pagamentos confirmados (${c.pagamentos.length})` }),
          el('div', { class: 'tabela-wrap' }, el('table', {},
            el('thead', {}, el('tr', {}, el('th', { text: 'Data' }), el('th', { class: 'num', text: 'Valor' }), el('th', { text: 'Método' }), el('th', { text: 'Referência' }))),
            el('tbody', {}, c.pagamentos.map((p) => el('tr', {},
              el('td', { text: data(p.dataPagamento) }),
              el('td', { class: 'num', text: mt(p.valorCentavos) }),
              el('td', { text: METODOS[p.metodo] || p.metodo }),
              el('td', { text: p.referencia || '—' }))))))) : null);
      caixa.append(cartao);
    }
  }

  function desenharOperacoes() {
    const lista = limpar($('operacoes'));
    if (!painel.operacoes.length) { lista.append(el('li', { class: 'vazio', text: 'Sem operações registadas.' })); return; }
    for (const o of painel.operacoes) {
      lista.append(el('li', {},
        el('div', {}, el('strong', { text: o.descricao }), o.valorCentavos ? ` — ${mt(o.valorCentavos)}` : ''),
        o.nota && el('div', { class: 'texto-suave', text: o.nota }),
        el('div', { class: 'quando', text: dataHora(o.data) })));
    }
  }

  function desenharNotificacoes() {
    const caixa = limpar($('notificacoes'));
    $('marcarLidas').hidden = !painel.notificacoesPorLer;
    $('tNotificacoes').textContent = painel.notificacoesPorLer ? `Notificações (${painel.notificacoesPorLer})` : 'Notificações';
    if (!painel.notificacoes.length) { caixa.append(el('p', { class: 'vazio', text: 'Sem notificações.' })); return; }
    for (const n of painel.notificacoes) {
      caixa.append(el('div', { class: `nota${n.lida ? '' : ' por-ler'}` },
        el('strong', { text: n.titulo }), el('span', { text: n.mensagem }), el('div', { class: 'quando', text: dataHora(n.criadoEm) })));
    }
  }

  $('marcarLidas').addEventListener('click', async () => {
    try { await api('/me/notificacoes/lidas', { metodo: 'POST' }); carregar(); } catch (e) { toast(e.message, true); }
  });

  function desenharPerfil() {
    const p = painel.perfil;
    const dl = limpar($('perfil'));
    const linha = (rotulo, valor) => { if (valor) dl.append(el('dt', { text: rotulo }), el('dd', { text: valor })); };
    linha('Nome', p.nomeCompleto);
    linha('Telefone', `${p.telefone}${p.telefoneVerificado ? ' · verificado' : ''}`);
    linha('Email', p.email);
    linha('Data de nascimento', p.dataNascimento && data(p.dataNascimento));
    linha('Morada', p.morada);
    linha('Documento', p.documentoNumero && `${p.documentoTipo || ''} ${p.documentoNumero}`.trim());
    linha('Cliente desde', data(p.clienteDesde));
  }

  // ===== Solicitar crédito =====
  function prazoEscolhido() {
    const r = document.querySelector('input[name="prazoDias"]:checked');
    return r ? painel.condicoes.prazos.find((p) => String(p.dias) === r.value) : null;
  }

  function actualizarSimulacao() {
    const resumo = limpar($('pResumo'));
    const prazo = prazoEscolhido();
    const valor = Number($('pValor').value);
    if (!prazo || !Number.isFinite(valor) || valor < painel.condicoes.valorMinimo) {
      resumo.append(`Indique um valor a partir de ${mt(painel.condicoes.valorMinimo * 100)} e escolha o prazo.`);
      return;
    }
    const s = simular(valor, prazo.percentagem);
    resumo.append('Valor: ', el('strong', { text: mt(s.montante) }), ' · Encargo: ', el('strong', { text: mt(s.encargo) }),
      ' · Total estimado: ', el('strong', { text: mt(s.total) }));
  }

  $('abrirPedido').addEventListener('click', () => {
    const { condicoes } = painel;
    const form = $('fPedido');
    form.reset();
    window.APG.limparErros(form);
    form.hidden = false;
    $('pConfirmacao').hidden = true;
    $('pChave').value = uuid();
    $('pValor').min = condicoes.valorMinimo;
    $('pValor').value = condicoes.valorMinimo;
    $('pValorAjuda').textContent = `Valor mínimo: ${mt(condicoes.valorMinimo * 100)}. Sujeito à análise e aprovação da APG.`;
    const prazos = limpar($('pPrazos'));
    condicoes.prazos.forEach((p, i) => {
      prazos.append(el('label', {},
        el('input', { type: 'radio', name: 'prazoDias', value: String(p.dias), checked: i === 0, onchange: actualizarSimulacao }),
        el('span', {}, el('span', { class: 'dias', text: `${p.dias} dias` }), el('span', { class: 'pct', text: `+${p.percentagem}%` }))));
    });
    actualizarSimulacao();
    abrirDialogo($('dPedido'));
  });
  $('pValor').addEventListener('input', actualizarSimulacao);

  aoSubmeter($('fPedido'), async (dados) => {
    const r = await api('/me/pedidos', { metodo: 'POST', corpo: { ...dados, valor: Number(dados.valor), prazoDias: Number(dados.prazoDias) } });
    $('fPedido').hidden = true;
    $('pConfirmacaoTexto').textContent = r.duplicado
      ? `Este pedido já tinha sido recebido: ${r.pedido.referencia} (${r.pedido.estadoRotulo}).`
      : `Pedido ${r.pedido.referencia} submetido com sucesso. Estado: ${r.pedido.estadoRotulo}. Vai ser informado aqui da decisão da APG.`;
    $('pConfirmacao').hidden = false;
    carregar();
  });

  // ===== Palavra-passe =====
  $('abrirPalavraPasse').addEventListener('click', () => { $('fPalavraPasse').reset(); abrirDialogo($('dPalavraPasse')); });
  aoSubmeter($('fPalavraPasse'), async (dados) => {
    await api('/me/palavra-passe', { metodo: 'POST', corpo: dados });
    $('dPalavraPasse').close();
    toast('Palavra-passe alterada. As outras sessões foram terminadas.');
  });

  carregar();
}());
