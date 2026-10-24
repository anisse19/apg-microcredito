// Painel administrativo. As permissões são verificadas pelo servidor em cada pedido;
// esta página apenas apresenta os dados e envia as decisões.
(function () {
  'use strict';

  const {
    api, el, limpar, mt, data, dataHora, estado, toast, aoSubmeter, abrirDialogo, simular, METODOS, ESTADOS_PRESTACAO,
  } = window.APG;
  const $ = (id) => document.getElementById(id);
  const dialogo = $('dAdmin');
  let reabrir = null; // função que volta a desenhar o diálogo aberto depois de uma acção

  const ROTULOS_ACCAO = {
    'conta.auto_registo': 'Conta criada pelo cliente',
    'conta.convite_criado': 'Conta criada por convite',
    'conta.link_activacao_emitido': 'Link de activação emitido',
    'conta.link_redefinicao_emitido': 'Link de redefinição emitido',
    'conta.activada': 'Conta activada',
    'conta.palavra_passe_redefinida': 'Palavra-passe redefinida',
    'conta.palavra_passe_alterada': 'Palavra-passe alterada',
    'conta.recuperacao_pedida': 'Recuperação de acesso pedida',
    'conta.recuperacao_descartada': 'Recuperação descartada',
    'conta.bloqueada': 'Conta bloqueada',
    'conta.desbloqueada': 'Conta desbloqueada',
    'sessao.inicio': 'Início de sessão',
    'sessao.fim': 'Fim de sessão',
    'cliente.criado': 'Cliente criado pela APG',
    'cliente.actualizado': 'Cadastro actualizado',
    'cliente.telefone_verificado': 'Telefone verificado',
    'pedido.submetido': 'Pedido submetido',
    'pedido.associado': 'Pedido associado a cliente',
    'pedido.em_analise': 'Pedido em análise',
    'pedido.aprovado': 'Pedido aprovado',
    'pedido.rejeitado': 'Pedido rejeitado',
    'pedido.cancelado': 'Pedido cancelado',
    'pedido.observacao': 'Observação interna',
    'credito.desembolsado': 'Desembolso registado',
    'credito.cancelado': 'Crédito cancelado',
    'pagamento.registado': 'Pagamento registado',
    'pagamento.anulado': 'Pagamento anulado',
    'config.actualizada': 'Condições alteradas',
  };

  // ===== Construtores de formulário =====
  function campo(rotulo, atributos, ajuda) {
    const id = `c_${atributos.name}_${Math.random().toString(36).slice(2, 7)}`;
    let entrada;
    if (atributos.tipo === 'textarea') entrada = el('textarea', { id, name: atributos.name, maxlength: atributos.maxlength }, atributos.value || '');
    else if (atributos.tipo === 'select') {
      entrada = el('select', { id, name: atributos.name },
        atributos.opcoes.map(([valor, texto]) => el('option', { value: valor, text: texto, selected: String(valor) === String(atributos.value) })));
    } else {
      entrada = el('input', { id, ...atributos, tipo: null, value: atributos.value ?? '' });
    }
    return el('div', { class: 'campo' }, el('label', { for: id, text: rotulo }), entrada, ajuda && el('p', { class: 'ajuda', text: ajuda }));
  }

  function verificacao(rotulo, nome) {
    return el('label', { class: 'campo-check' }, el('input', { type: 'checkbox', name: nome }), el('span', { text: rotulo }));
  }

  function formulario(titulo, filhos, textoBotao, accao, { classeBotao = 'btn-primary' } = {}) {
    const f = el('form', { novalidate: true, class: 'cartao' }, titulo && el('h3', { text: titulo, class: 'secundario' }), filhos,
      el('div', { class: 'accoes' }, el('button', { type: 'submit', class: `btn ${classeBotao}`, text: textoBotao })));
    aoSubmeter(f, accao);
    return f;
  }

  function abrir(titulo, desenhar) {
    reabrir = async () => {
      const corpo = $('dAdminCorpo');
      try {
        const conteudo = await desenhar();
        $('dAdminTitulo').textContent = typeof titulo === 'function' ? titulo() : titulo;
        limpar(corpo).append(conteudo);
      } catch (e) {
        if (e.status === 401) { window.location.reload(); return; }
        limpar(corpo).append(el('div', { class: 'aviso aviso-erro', text: e.message }));
      }
    };
    limpar($('dAdminCorpo')).append(el('p', { class: 'carregar', text: 'A carregar…' }));
    $('dAdminTitulo').textContent = typeof titulo === 'function' ? '' : titulo;
    if (!dialogo.open) abrirDialogo(dialogo);
    return reabrir();
  }
  $('dAdminFechar').addEventListener('click', () => dialogo.close());
  dialogo.addEventListener('close', () => { reabrir = null; actualizarSeparador(); });

  const depois = (mensagem) => { toast(mensagem); if (reabrir) reabrir(); };

  function tabela(cabecalhos, linhas, vazio) {
    if (!linhas.length) return el('p', { class: 'vazio', text: vazio });
    return el('div', { class: 'tabela-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, cabecalhos.map((c) => (Array.isArray(c) ? el('th', { class: c[1], text: c[0] }) : el('th', { text: c }))))),
      el('tbody', {}, linhas)));
  }

  function linhaClicavel(accao, ...celulas) {
    return el('tr', { class: 'clicavel', tabindex: '0', onclick: accao, onkeydown: (e) => { if (e.key === 'Enter') accao(); } }, celulas);
  }

  function dados(pares) {
    return el('dl', { class: 'dados' }, pares.filter(([, v]) => v !== null && v !== undefined && v !== '')
      .flatMap(([r, v]) => [el('dt', { text: r }), el('dd', {}, v)]));
  }

  // ===== Sessão =====
  async function iniciar() {
    const s = await api('/auth/sessao').catch(() => ({ autenticado: false }));
    $('carregar').hidden = true;
    if (!s.autenticado || s.utilizador.papel !== 'admin') {
      $('entrada').hidden = false;
      $('semPermissao').hidden = !s.autenticado;
      return;
    }
    $('quem').textContent = s.utilizador.nome;
    $('sair').hidden = false;
    $('app').hidden = false;
    const inicial = window.location.pathname.endsWith('/configuracoes') ? 'configuracoes' : (window.location.hash.slice(1) || 'resumo');
    mostrarSeparador(inicial);
  }

  aoSubmeter($('fEntrar'), async (d) => {
    const r = await api('/auth/entrar', { metodo: 'POST', corpo: d });
    if (r.utilizador.papel !== 'admin') {
      await api('/auth/sair', { metodo: 'POST' });
      const erro = new Error('Esta conta não tem permissões administrativas.');
      throw erro;
    }
    window.location.reload();
  });
  $('sair').addEventListener('click', async () => {
    await api('/auth/sair', { metodo: 'POST' }).catch(() => {});
    window.location.href = '/admin';
  });

  // ===== Separadores =====
  let separadorActual = 'resumo';
  const desenhadores = {};

  function mostrarSeparador(nome) {
    if (!desenhadores[nome]) nome = 'resumo';
    separadorActual = nome;
    document.querySelectorAll('[data-sep]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.sep === nome)));
    document.querySelectorAll('[data-painel]').forEach((p) => { p.hidden = p.dataset.painel !== nome; });
    window.history.replaceState(null, '', nome === 'configuracoes' ? '/admin/configuracoes' : `/admin#${nome}`);
    actualizarSeparador();
  }
  function actualizarSeparador() {
    if ($('app').hidden) return;
    desenhadores[separadorActual]().catch((e) => {
      if (e.status === 401 || e.status === 403) window.location.reload(); else toast(e.message, true);
    });
    actualizarContadores();
  }
  document.querySelectorAll('[data-sep]').forEach((b) => b.addEventListener('click', () => mostrarSeparador(b.dataset.sep)));
  window.addEventListener('hashchange', () => { if (!$('app').hidden) mostrarSeparador(window.location.hash.slice(1)); });

  async function actualizarContadores() {
    const r = await api('/admin/resumo').catch(() => null);
    if (!r) return;
    const pendentes = (r.pedidosPorEstado.pendente_analise || 0) + (r.pedidosPorEstado.em_analise || 0);
    $('cPedidos').hidden = !pendentes; $('cPedidos').textContent = pendentes;
    $('cRecuperacoes').hidden = !r.recuperacoesPendentes; $('cRecuperacoes').textContent = r.recuperacoesPendentes;
  }

  // ===== Resumo =====
  desenhadores.resumo = async () => {
    const r = await api('/admin/resumo');
    const ind = (rotulo, valor, sub, destaque) => el('div', { class: `indicador${destaque ? ' destaque' : ''}` },
      el('div', { class: 'rotulo', text: rotulo }), el('div', { class: 'valor', text: valor }), sub && el('div', { class: 'sub', text: sub }));
    limpar($('resumoIndicadores')).append(
      ind('Saldo pendente na carteira', mt(r.saldoPendenteCentavos), `${r.creditosActivos} crédito(s) activo(s)`, true),
      ind('Pedidos por analisar', String((r.pedidosPorEstado.pendente_analise || 0) + (r.pedidosPorEstado.em_analise || 0)),
        `${r.pedidosPorEstado.em_analise || 0} em análise`),
      ind('Aguardam desembolso', String(r.creditosAguardandoDesembolso), 'créditos aprovados'),
      ind('Prestações em atraso', String(r.prestacoesEmAtraso), `${r.clientes} cliente(s) registados`),
    );
    const estados = { pendente_analise: 'Pendente de análise', em_analise: 'Em análise', aprovado: 'Aprovado', rejeitado: 'Rejeitado', cancelado: 'Cancelado' };
    limpar($('resumoEstados')).append(dados(Object.entries(estados).map(([k, v]) => [v, String(r.pedidosPorEstado[k] || 0)])));
    limpar($('resumoSite')).append(dados([
      ['Visitas', String(r.visitas7Dias)],
      ['Simulações', String(r.interacoes7Dias.simulacao || 0)],
      ['Pedidos iniciados', String(r.interacoes7Dias.pedido_iniciado || 0)],
      ['Pedidos enviados', String(r.interacoes7Dias.pedido_enviado || 0)],
    ]));
  };

  // ===== Pedidos =====
  desenhadores.pedidos = async () => {
    const q = encodeURIComponent($('pedidosQ').value.trim());
    const lista = await api(`/admin/pedidos?q=${q}&estado=${encodeURIComponent($('pedidosEstado').value)}`);
    limpar($('pedidosLista')).append(tabela(['Pedido', 'Requerente', ['Valor', 'num'], ['Prazo', 'num'], 'Estado'],
      lista.map((p) => linhaClicavel(() => abrirPedido(p.id),
        el('td', {}, el('strong', { text: p.referencia }), el('div', { class: 'secundario', text: `${dataHora(p.criadoEm)} · ${p.origem === 'painel_cliente' ? 'Painel do cliente' : 'Site público'}` })),
        el('td', {}, p.clienteNome || p.nome, el('div', { class: 'secundario', text: p.clienteId ? p.telefone : `${p.telefone} · sem cliente associado` })),
        el('td', { class: 'num', text: mt(p.valorCentavos) }),
        el('td', { class: 'num', text: `${p.prazoDias} dias` }),
        el('td', {}, estado(p.estado, p.estadoRotulo)))),
      'Nenhum pedido encontrado.'));
  };
  let atraso;
  $('pedidosQ').addEventListener('input', () => { clearTimeout(atraso); atraso = setTimeout(actualizarSeparador, 300); });
  $('pedidosEstado').addEventListener('change', actualizarSeparador);

  function historico(itens) {
    return el('ul', { class: 'linha-tempo' }, itens.map((h) => el('li', {},
      el('div', {}, el('strong', { text: h.estadoRotulo }), ` — ${h.autor}`),
      h.nota && el('div', { text: h.nota }),
      el('div', { class: 'quando', text: dataHora(h.criadoEm) }))));
  }

  function abrirPedido(id) {
    let ref = '';
    return abrir(() => `Pedido ${ref}`, async () => {
      const { pedido: p, cliente, sugestoesCliente, condicoes } = await api(`/admin/pedidos/${id}`);
      ref = p.referencia;
      const emCurso = ['pendente_analise', 'em_analise'].includes(p.estado);
      const caixa = el('div', {});

      caixa.append(el('div', { class: 'colunas' },
        el('div', { class: 'cartao' }, el('h2', { text: 'Dados do pedido' }), dados([
          ['Estado', estado(p.estado, p.estadoRotulo)],
          ['Submetido', `${dataHora(p.criadoEm)} · ${p.origem === 'painel_cliente' ? 'painel do cliente' : 'site público'}`],
          ['Nome indicado', p.nome],
          ['Telefone indicado', p.telefone],
          ['Valor solicitado', mt(p.valorCentavos)],
          ['Prazo', `${p.prazoDias} dias${p.percentagem != null ? ` (+${p.percentagem}%)` : ''}`],
          ['Total estimado', mt(p.totalEstimadoCentavos)],
          ['Finalidade', p.finalidade],
          ['Informações', p.informacoes],
          ['Decisão', p.decididoEm ? `${dataHora(p.decididoEm)} por ${p.decididoPor}` : null],
          ['Mensagem ao cliente', p.motivoDecisao],
          ['Crédito', p.credito ? el('button', { type: 'button', class: 'link-botao', text: `${p.credito.referencia} · ${p.credito.estadoRotulo}`, onclick: () => abrirCredito(p.credito.id) }) : null],
        ])),
        el('div', {},
          el('div', { class: 'cartao' }, el('h2', { text: 'Cliente' }), cliente
            ? el('div', {}, dados([
              ['Nome', cliente.nomeCompleto], ['Telefone', cliente.telefone], ['Email', cliente.email],
              ['Conta', cliente.conta ? cliente.conta.estado.replace('_', ' ') : 'sem conta'],
            ]), el('div', { class: 'accoes' }, el('button', { type: 'button', class: 'btn btn-ghost btn-pequeno', text: 'Abrir ficha', onclick: () => abrirCliente(cliente.id) })))
            : associarCliente(p, sugestoesCliente)),
          el('div', { class: 'cartao' }, el('h2', { text: 'Histórico' }), historico(p.historico)))));

      caixa.append(el('div', { class: 'cartao' }, el('h2', { text: 'Observações internas' }),
        p.observacoesInternas ? el('pre', { class: 'pre', text: p.observacoesInternas }) : el('p', { class: 'vazio', text: 'Sem observações.' }),
        formulario(null, [campo('Nova observação (não visível ao cliente)', { tipo: 'textarea', name: 'texto', maxlength: 2000 })], 'Adicionar observação',
          async (d) => { await api(`/admin/pedidos/${p.id}/observacoes`, { metodo: 'POST', corpo: d }); depois('Observação registada.'); },
          { classeBotao: 'btn-ghost btn-pequeno' })));

      if (emCurso) {
        if (p.estado === 'pendente_analise') {
          caixa.append(formulario('COLOCAR EM ANÁLISE', [campo('Nota ao cliente (opcional)', { name: 'nota', maxlength: 500 })], 'Colocar em análise',
            async (d) => { await api(`/admin/pedidos/${p.id}/analise`, { metodo: 'POST', corpo: d }); depois('Pedido em análise.'); },
            { classeBotao: 'btn-ghost' }));
        }
        caixa.append(formAprovacao(p, condicoes, Boolean(cliente)));
        caixa.append(formulario('REJEITAR', [
          campo('Motivo (visível ao cliente)', { name: 'motivo', maxlength: 500, required: true }),
          campo('Observações internas (opcional)', { tipo: 'textarea', name: 'observacoes', maxlength: 2000 }),
        ], 'Rejeitar pedido', async (d) => {
          if (!window.confirm(`Rejeitar o pedido ${p.referencia}? A decisão é definitiva.`)) return;
          await api(`/admin/pedidos/${p.id}/rejeitar`, { metodo: 'POST', corpo: d });
          depois('Pedido rejeitado.');
        }, { classeBotao: 'btn-perigo' }));
        caixa.append(formulario('CANCELAR', [campo('Motivo', { name: 'motivo', maxlength: 500, required: true }, 'Ex.: pedido duplicado ou desistência comunicada pelo cliente.')],
          'Cancelar pedido', async (d) => {
            if (!window.confirm(`Cancelar o pedido ${p.referencia}?`)) return;
            await api(`/admin/pedidos/${p.id}/cancelar`, { metodo: 'POST', corpo: d });
            depois('Pedido cancelado.');
          }, { classeBotao: 'btn-ghost' }));
      }
      return caixa;
    });
  }

  function formAprovacao(p, condicoes, temCliente) {
    if (!temCliente) {
      return el('div', { class: 'aviso aviso-atencao', text: 'Para aprovar, associe primeiro este pedido a um cliente (ou adicione o cliente).' });
    }
    const prazoAtual = condicoes.prazos.some((x) => x.dias === p.prazoDias) ? p.prazoDias : condicoes.prazos[0].dias;
    const simulacao = el('div', { class: 'resumo-simulacao', 'aria-live': 'polite' });
    const f = formulario('APROVAR', [
      el('div', { class: 'grelha-campos' },
        campo('Montante aprovado (MT)', { name: 'montante', type: 'number', min: condicoes.valorMinimo, step: '1', value: p.valorCentavos / 100, required: true }),
        campo('Prazo', { tipo: 'select', name: 'prazoDias', value: prazoAtual, opcoes: condicoes.prazos.map((x) => [x.dias, `${x.dias} dias (+${x.percentagem}%)`]) }),
        campo('Número de prestações', { name: 'numeroPrestacoes', type: 'number', min: 1, max: 12, step: 1, value: 1, required: true })),
      simulacao,
      campo('Mensagem ao cliente (opcional)', { name: 'motivo', maxlength: 500 }),
      campo('Observações internas (opcional)', { tipo: 'textarea', name: 'observacoes', maxlength: 2000 }),
      el('p', { class: 'texto-suave', text: 'A aprovação cria o crédito no estado «aguarda desembolso». Só fica activo quando o desembolso for registado.' }),
    ], 'Aprovar pedido', async (d) => {
      if (!window.confirm(`Aprovar ${d.montante} MT por ${d.prazoDias} dias? A decisão é definitiva.`)) return;
      await api(`/admin/pedidos/${p.id}/aprovar`, {
        metodo: 'POST', corpo: { ...d, montante: Number(d.montante), prazoDias: Number(d.prazoDias), numeroPrestacoes: Number(d.numeroPrestacoes) },
      });
      depois('Pedido aprovado. Crédito a aguardar desembolso.');
    }, { classeBotao: 'btn-gold' });
    const recalcular = () => {
      const montante = Number(f.querySelector('[name="montante"]').value);
      const prazo = condicoes.prazos.find((x) => String(x.dias) === f.querySelector('[name="prazoDias"]').value);
      limpar(simulacao);
      if (!prazo || !(montante > 0)) return;
      const s = simular(montante, prazo.percentagem);
      simulacao.append('Encargo: ', el('strong', { text: mt(s.encargo) }), ' · Total a reembolsar: ', el('strong', { text: mt(s.total) }));
    };
    f.addEventListener('input', recalcular);
    recalcular();
    return f;
  }

  function associarCliente(p, sugestoes) {
    const resultados = el('div', {});
    const associar = async (clienteId) => {
      try {
        await api(`/admin/pedidos/${p.id}/associar`, { metodo: 'POST', corpo: { clienteId } });
        depois('Pedido associado ao cliente.');
      } catch (e) { toast(e.message, true); }
    };
    const mostrar = (lista) => {
      limpar(resultados).append(lista.length
        ? el('div', { class: 'lista-notas' }, lista.map((c) => el('div', { class: 'nota' },
          el('strong', { text: c.nomeCompleto }), `${c.telefone}${c.email ? ` · ${c.email}` : ''}`,
          el('div', { class: 'accoes' }, el('button', { type: 'button', class: 'btn btn-primary btn-pequeno', text: 'Associar', onclick: () => associar(c.id) })))))
        : el('p', { class: 'vazio', text: 'Nenhum cliente encontrado.' }));
    };
    const pesquisa = el('input', { type: 'search', placeholder: 'Pesquisar cliente…', 'aria-label': 'Pesquisar cliente para associar' });
    let t;
    pesquisa.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => { if (pesquisa.value.trim().length >= 2) mostrar(await api(`/admin/clientes?q=${encodeURIComponent(pesquisa.value.trim())}`)); }, 300);
    });
    mostrar(sugestoes);
    return el('div', {},
      el('div', { class: 'aviso aviso-atencao', text: 'Pedido do site público sem cliente associado.' }),
      sugestoes.length ? el('p', { class: 'texto-suave', text: 'Clientes com o mesmo telefone:' }) : null,
      el('div', { class: 'filtros' }, pesquisa), resultados,
      el('div', { class: 'accoes' }, el('button', {
        type: 'button', class: 'btn btn-gold btn-pequeno', text: 'Adicionar como novo cliente',
        onclick: () => novoCliente({ nomeCompleto: p.nome, telefone: p.telefone }, async (id) => { await associar(id); abrirPedido(p.id); }),
      })));
  }

  // ===== Clientes =====
  desenhadores.clientes = async () => {
    const lista = await api(`/admin/clientes?q=${encodeURIComponent($('clientesQ').value.trim())}`);
    limpar($('clientesLista')).append(tabela(['Cliente', 'Contacto', 'Conta', ['Pedidos', 'num'], ['Créditos activos', 'num']],
      lista.map((c) => linhaClicavel(() => abrirCliente(c.id),
        el('td', {}, el('strong', { text: c.nomeCompleto }), el('div', { class: 'secundario', text: `Desde ${data(c.criadoEm)} · ${c.origem === 'auto_registo' ? 'auto-registo' : 'cadastro APG'}` })),
        el('td', {}, c.telefone, c.email && el('div', { class: 'secundario', text: c.email })),
        el('td', {}, c.contaEstado ? estado(c.contaEstado, { activo: 'Activa', pendente_activacao: 'Por activar', bloqueado: 'Bloqueada' }[c.contaEstado]) : el('span', { class: 'secundario', text: 'Sem conta' })),
        el('td', { class: 'num', text: c.numeroPedidos }),
        el('td', { class: 'num', text: c.creditosActivos }))),
      'Nenhum cliente encontrado.'));
  };
  let atrasoClientes;
  $('clientesQ').addEventListener('input', () => { clearTimeout(atrasoClientes); atrasoClientes = setTimeout(actualizarSeparador, 300); });
  $('adicionarCliente').addEventListener('click', () => novoCliente({}, (id) => abrirCliente(id)));

  function camposCliente(c) {
    return [
      el('div', { class: 'grelha-campos' },
        campo('Nome completo', { name: 'nomeCompleto', value: c.nomeCompleto, maxlength: 120, required: true }),
        campo('Telefone', { name: 'telefone', type: 'tel', value: c.telefone, required: true }),
        campo('Email (opcional)', { name: 'email', type: 'email', value: c.email }),
        campo('Data de nascimento (opcional)', { name: 'dataNascimento', type: 'date', value: c.dataNascimento }),
        campo('Tipo de documento (opcional)', { tipo: 'select', name: 'documentoTipo', value: c.documentoTipo || '', opcoes: [['', '—'], ['BI', 'BI'], ['Passaporte', 'Passaporte'], ['DIRE', 'DIRE'], ['Outro', 'Outro']] }),
        campo('Número do documento (opcional)', { name: 'documentoNumero', value: c.documentoNumero, maxlength: 40 })),
      campo('Morada (opcional)', { name: 'morada', value: c.morada, maxlength: 300 }),
      campo('Notas internas (não visíveis ao cliente)', { tipo: 'textarea', name: 'notasInternas', value: c.notasInternas, maxlength: 2000 }),
    ];
  }

  function novoCliente(predefinidos, depoisDeCriar) {
    return abrir('Adicionar cliente', async () => el('div', {},
      el('p', { class: 'texto-suave', text: 'O sistema verifica telefone, email e documento para evitar perfis duplicados. Depois de criar, pode gerar um link de activação para o cliente definir a sua palavra-passe.' }),
      formulario(null, camposCliente(predefinidos), 'Criar cliente', async (d) => {
        try {
          const r = await api('/admin/clientes', { metodo: 'POST', corpo: d });
          toast('Cliente criado.');
          await depoisDeCriar(r.id);
        } catch (e) {
          if (e.dados && e.dados.clienteExistenteId) {
            e.message = `${e.message}`;
            const id = e.dados.clienteExistenteId;
            setTimeout(() => { if (window.confirm('Abrir a ficha do cliente existente?')) abrirCliente(id); }, 50);
          }
          throw e;
        }
      }, { classeBotao: 'btn-gold' })));
  }

  function abrirCliente(id) {
    let nome = '';
    return abrir(() => nome, async () => {
      const f = await api(`/admin/clientes/${id}`);
      const c = f.cliente;
      nome = c.nomeCompleto;
      const caixa = el('div', {});

      // Conta de acesso
      const linkCaixa = el('div', {});
      const conta = f.conta;
      const accoesConta = el('div', { class: 'accoes' });
      if (!conta || conta.estado !== 'bloqueado') {
        accoesConta.append(el('button', {
          type: 'button', class: 'btn btn-gold btn-pequeno',
          text: !conta || conta.estado === 'pendente_activacao' ? 'Gerar link de activação' : 'Gerar link de redefinição',
          onclick: async (e) => {
            if (conta && conta.estado === 'activo' && !window.confirm('Confirmou a identidade do cliente? O link permite definir uma nova palavra-passe.')) return;
            e.target.disabled = true;
            try {
              const r = await api(`/admin/clientes/${c.id}/link-acesso`, { metodo: 'POST' });
              const entrada = el('input', { readonly: true, value: r.link, 'aria-label': 'Link de acesso' });
              limpar(linkCaixa).append(el('div', { class: 'aviso aviso-ok' },
                `Link de ${r.tipo === 'activacao' ? 'activação' : 'redefinição'} válido até ${dataHora(r.expiraEm)}. Entregue-o apenas ao cliente (por exemplo, por WhatsApp para ${c.telefone}). Não volta a ser mostrado.`,
                el('div', { class: 'link-gerado' }, entrada, el('button', {
                  type: 'button', class: 'btn btn-primary btn-pequeno', text: 'Copiar',
                  onclick: async () => { try { await navigator.clipboard.writeText(r.link); toast('Link copiado.'); } catch (x) { entrada.select(); } },
                }))));
            } catch (erro) { toast(erro.message, true); } finally { e.target.disabled = false; }
          },
        }));
      }
      if (conta) {
        const bloqueada = conta.estado === 'bloqueado';
        accoesConta.append(el('button', {
          type: 'button', class: `btn ${bloqueada ? 'btn-ghost' : 'btn-perigo'} btn-pequeno`, text: bloqueada ? 'Desbloquear conta' : 'Bloquear conta',
          onclick: async () => {
            if (!bloqueada && !window.confirm('Bloquear a conta? O cliente perde o acesso ao painel até ser desbloqueada.')) return;
            try { await api(`/admin/clientes/${c.id}/conta`, { metodo: 'POST', corpo: { accao: bloqueada ? 'desbloquear' : 'bloquear' } }); depois('Conta actualizada.'); } catch (e) { toast(e.message, true); }
          },
        }));
      }
      if (!c.telefoneVerificado) {
        accoesConta.append(el('button', {
          type: 'button', class: 'btn btn-ghost btn-pequeno', text: 'Marcar telefone como verificado',
          onclick: async () => { try { await api(`/admin/clientes/${c.id}/verificar-telefone`, { metodo: 'POST' }); depois('Telefone verificado.'); } catch (e) { toast(e.message, true); } },
        }));
      }

      caixa.append(el('div', { class: 'cartao' }, el('h2', { text: 'Conta de acesso' }),
        dados([
          ['Estado', conta ? estado(conta.estado, { activo: 'Activa', pendente_activacao: 'Por activar', bloqueado: 'Bloqueada' }[conta.estado]) : 'Sem conta — gere um link de activação para convidar o cliente'],
          ['Criada', conta && dataHora(conta.criadoEm)],
          ['Último acesso', conta && conta.ultimoAcesso ? dataHora(conta.ultimoAcesso) : null],
          ['Link pendente', conta && conta.linkPendente ? `${conta.linkPendente.tipo} · expira ${dataHora(conta.linkPendente.expiraEm)}` : null],
          ['Telefone', c.telefoneVerificado ? 'verificado' : 'não verificado'],
        ]), accoesConta, linkCaixa));

      caixa.append(el('div', { class: 'cartao' }, el('h2', { text: 'Pedidos' }), tabela(['Pedido', ['Valor', 'num'], ['Prazo', 'num'], 'Estado'],
        f.pedidos.map((p) => linhaClicavel(() => abrirPedido(p.id),
          el('td', {}, el('strong', { text: p.referencia }), el('div', { class: 'secundario', text: dataHora(p.criadoEm) })),
          el('td', { class: 'num', text: mt(p.valorCentavos) }), el('td', { class: 'num', text: `${p.prazoDias} dias` }),
          el('td', {}, estado(p.estado, p.estadoRotulo)))), 'Sem pedidos.')));

      caixa.append(el('div', { class: 'cartao' }, el('h2', { text: 'Créditos' }), tabela(['Crédito', ['Total', 'num'], ['Pago', 'num'], ['Saldo', 'num'], 'Estado'],
        f.creditos.map((k) => linhaClicavel(() => abrirCredito(k.id),
          el('td', {}, el('strong', { text: k.referencia }), el('div', { class: 'secundario', text: `${mt(k.montanteCentavos)} · ${k.prazoDias} dias` })),
          el('td', { class: 'num', text: mt(k.totalCentavos) }), el('td', { class: 'num', text: mt(k.pagoCentavos) }),
          el('td', { class: 'num', text: mt(k.saldoCentavos) }),
          el('td', {}, estado(k.estado, k.estadoRotulo), k.emAtraso && ' ', k.emAtraso && estado('atraso', 'Em atraso')))), 'Sem créditos.')));

      caixa.append(formulario('DADOS DO CLIENTE', camposCliente(c), 'Guardar alterações', async (d) => {
        await api(`/admin/clientes/${c.id}`, { metodo: 'PUT', corpo: d });
        depois('Cadastro actualizado.');
      }));

      caixa.append(el('div', { class: 'cartao' }, el('h2', { text: 'Histórico' }), listaAuditoria(f.historico)));
      return caixa;
    });
  }

  // ===== Créditos =====
  desenhadores.creditos = async () => {
    const lista = await api(`/admin/creditos?estado=${encodeURIComponent($('creditosEstado').value)}`);
    limpar($('creditosLista')).append(tabela(['Crédito', 'Cliente', ['Total', 'num'], ['Saldo', 'num'], 'Próximo vencimento', 'Estado'],
      lista.map((k) => linhaClicavel(() => abrirCredito(k.id),
        el('td', {}, el('strong', { text: k.referencia }), el('div', { class: 'secundario', text: `${mt(k.montanteCentavos)} · ${k.prazoDias} dias · ${k.pedidoReferencia}` })),
        el('td', { text: k.clienteNome }),
        el('td', { class: 'num', text: mt(k.totalCentavos) }),
        el('td', { class: 'num', text: mt(k.saldoCentavos) }),
        el('td', { text: k.proximoVencimento ? data(k.proximoVencimento.vencimento) : '—' }),
        el('td', {}, estado(k.estado, k.estadoRotulo), k.emAtraso && ' ', k.emAtraso && estado('atraso', 'Em atraso')))),
      'Nenhum crédito encontrado.'));
  };
  $('creditosEstado').addEventListener('change', actualizarSeparador);

  const opcoesMetodo = () => Object.entries(METODOS);
  const hoje = () => new Date().toISOString().slice(0, 10);

  function abrirCredito(id) {
    let ref = '';
    return abrir(() => `Crédito ${ref}`, async () => {
      const k = await api(`/admin/creditos/${id}`);
      ref = k.referencia;
      const caixa = el('div', {});
      caixa.append(el('div', { class: 'cartao' }, el('h2', { text: 'Resumo' }), dados([
        ['Estado', el('span', {}, estado(k.estado, k.estadoRotulo), k.emAtraso && ' ', k.emAtraso && estado('atraso', 'Em atraso'))],
        ['Cliente', el('button', { type: 'button', class: 'link-botao', text: `${k.cliente.nomeCompleto} · ${k.cliente.telefone}`, onclick: () => abrirCliente(k.cliente.id) })],
        ['Pedido', k.pedidoReferencia],
        ['Montante', mt(k.montanteCentavos)],
        ['Condições', `${k.prazoDias} dias · +${k.percentagem}% · ${k.numeroPrestacoes} prestação(ões)`],
        ['Encargo', mt(k.encargoCentavos)],
        ['Total a reembolsar', mt(k.totalCentavos)],
        ['Pago', mt(k.pagoCentavos)],
        ['Saldo pendente', mt(k.saldoCentavos)],
        ['Aprovado', dataHora(k.aprovadoEm)],
        ['Desembolso', k.desembolsadoEm ? `${data(k.desembolsadoEm)} · ${METODOS[k.desembolsoMetodo] || k.desembolsoMetodo}${k.desembolsoReferencia ? ` · ${k.desembolsoReferencia}` : ''}` : null],
        ['Liquidado', k.liquidadoEm ? data(k.liquidadoEm) : null],
        ['Cancelado', k.canceladoEm ? `${dataHora(k.canceladoEm)} — ${k.motivoCancelamento}` : null],
      ])));

      if (k.estado === 'aguarda_desembolso') {
        caixa.append(formulario('REGISTAR DESEMBOLSO (ACTIVA O CRÉDITO)', [
          el('div', { class: 'grelha-campos' },
            campo('Data do desembolso', { name: 'data', type: 'date', value: hoje(), max: hoje(), required: true }),
            campo('Método', { tipo: 'select', name: 'metodo', value: 'mpesa', opcoes: opcoesMetodo() })),
          campo('Referência da operação (opcional)', { name: 'referencia', maxlength: 120 }),
          verificacao('O contrato foi assinado pelo cliente.', 'contratoAssinado'),
          verificacao('A identidade do cliente foi verificada.', 'identidadeVerificada'),
        ], 'Registar desembolso', async (d) => {
          await api(`/admin/creditos/${k.id}/desembolso`, { metodo: 'POST', corpo: d });
          depois('Desembolso registado. Crédito activo.');
        }, { classeBotao: 'btn-gold' }));
        caixa.append(formulario('CANCELAR CRÉDITO', [campo('Motivo', { name: 'motivo', maxlength: 500, required: true })], 'Cancelar crédito', async (d) => {
          if (!window.confirm('Cancelar este crédito antes do desembolso?')) return;
          await api(`/admin/creditos/${k.id}/cancelar`, { metodo: 'POST', corpo: d });
          depois('Crédito cancelado.');
        }, { classeBotao: 'btn-perigo' }));
      }

      if (k.prestacoes.length) {
        caixa.append(el('div', { class: 'cartao' }, el('h2', { text: 'Prestações' }), tabela(['Nº', 'Vencimento', ['Valor', 'num'], ['Pago', 'num'], 'Estado'],
          k.prestacoes.map((p) => el('tr', {}, el('td', { text: p.numero }), el('td', { text: data(p.vencimento) }),
            el('td', { class: 'num', text: mt(p.valorCentavos) }), el('td', { class: 'num', text: mt(p.pagoCentavos) }),
            el('td', {}, p.emAtraso ? estado('atraso', 'Em atraso') : estado(p.estado, ESTADOS_PRESTACAO[p.estado]), p.pagaEm ? ` ${data(p.pagaEm)}` : ''))), '')));
      }

      if (k.estado === 'activo') {
        caixa.append(formulario('REGISTAR PAGAMENTO CONFIRMADO', [
          el('div', { class: 'grelha-campos' },
            campo('Valor (MT)', { name: 'valor', type: 'number', min: 0.01, step: '0.01', value: k.proximoVencimento ? k.proximoVencimento.emFaltaCentavos / 100 : '', required: true }, `Saldo pendente: ${mt(k.saldoCentavos)}`),
            campo('Data do pagamento', { name: 'data', type: 'date', value: hoje(), max: hoje(), required: true }),
            campo('Método', { tipo: 'select', name: 'metodo', value: 'mpesa', opcoes: opcoesMetodo() }),
            campo('Referência (opcional)', { name: 'referencia', maxlength: 120 })),
          campo('Observações (opcional)', { name: 'observacoes', maxlength: 500 }),
        ], 'Registar pagamento', async (d) => {
          await api(`/admin/creditos/${k.id}/pagamentos`, { metodo: 'POST', corpo: { ...d, valor: Number(d.valor) } });
          depois('Pagamento registado.');
        }, { classeBotao: 'btn-gold' }));
      }

      caixa.append(el('div', { class: 'cartao' }, el('h2', { text: 'Pagamentos' }), tabela(['Data', ['Valor', 'num'], 'Método', 'Registo', ''],
        k.pagamentos.map((p) => el('tr', {},
          el('td', { text: data(p.dataPagamento) }),
          el('td', { class: 'num', text: mt(p.valorCentavos) }),
          el('td', {}, METODOS[p.metodo] || p.metodo, p.referencia && el('div', { class: 'secundario', text: p.referencia })),
          el('td', {}, `${p.registadoPor} · ${dataHora(p.registadoEm)}`, p.observacoes && el('div', { class: 'secundario', text: p.observacoes }),
            p.anuladoEm && el('div', {}, estado('cancelado', 'Anulado'), ` ${dataHora(p.anuladoEm)} — ${p.motivoAnulacao}`)),
          el('td', {}, !p.anuladoEm && ['activo', 'liquidado'].includes(k.estado) ? el('button', {
            type: 'button', class: 'btn btn-perigo btn-pequeno', text: 'Anular',
            onclick: async () => {
              const motivo = window.prompt('Motivo da anulação deste pagamento:');
              if (!motivo) return;
              try { await api(`/admin/pagamentos/${p.id}/anular`, { metodo: 'POST', corpo: { motivo } }); depois('Pagamento anulado.'); } catch (e) { toast(e.message, true); }
            },
          }) : null))), 'Sem pagamentos registados.')));
      return caixa;
    });
  }

  // ===== Recuperação de acesso =====
  desenhadores.recuperacoes = async () => {
    const lista = await api('/admin/recuperacoes');
    limpar($('recuperacoesLista')).append(tabela(['Pedido', 'Cliente', ''],
      lista.map((r) => el('tr', {},
        el('td', {}, dataHora(r.criadoEm), el('div', { class: 'secundario', text: r.telefone })),
        el('td', { text: r.clienteNome }),
        el('td', {}, el('div', { class: 'accoes' },
          el('button', { type: 'button', class: 'btn btn-primary btn-pequeno', text: 'Abrir ficha', onclick: () => abrirCliente(r.clienteId) }),
          el('button', {
            type: 'button', class: 'btn btn-ghost btn-pequeno', text: 'Descartar',
            onclick: async () => { try { await api(`/admin/recuperacoes/${r.id}/descartar`, { metodo: 'POST' }); toast('Descartado.'); actualizarSeparador(); } catch (e) { toast(e.message, true); } },
          }))))),
      'Sem pedidos de recuperação pendentes.'));
  };

  // ===== Configurações =====
  function linhaPrazo(p) {
    const linha = el('div', { class: 'linha-prazo' },
      campo('Dias', { name: 'dias', type: 'number', min: 1, max: 365, step: 1, value: p.dias ?? '' }),
      campo('Percentagem (%)', { name: 'percentagem', type: 'number', min: 0, max: 100, step: '0.1', value: p.percentagem ?? '' }),
      el('button', { type: 'button', class: 'btn btn-ghost btn-pequeno', text: 'Remover', 'aria-label': 'Remover prazo', onclick: () => linha.remove() }));
    linha.dataset.prazo = '1';
    return linha;
  }
  desenhadores.configuracoes = async () => {
    const cfg = await api('/admin/config');
    $('cfgMinimo').value = cfg.valorMinimo;
    limpar($('cfgPrazos')).append(...cfg.prazos.map(linhaPrazo));
  };
  $('cfgAdicionar').addEventListener('click', () => $('cfgPrazos').append(linhaPrazo({})));
  const fConfig = $('fConfig');
  fConfig.addEventListener('submit', async (e) => {
    e.preventDefault();
    window.APG.limparErros(fConfig);
    const prazos = [...$('cfgPrazos').querySelectorAll('[data-prazo]')].map((l) => ({
      dias: Number(l.querySelector('[name="dias"]').value), percentagem: Number(l.querySelector('[name="percentagem"]').value),
    }));
    try {
      await api('/admin/config', { metodo: 'PUT', corpo: { valorMinimo: Number($('cfgMinimo').value), prazos } });
      toast('Condições guardadas. O simulador do site já usa os novos valores.');
      actualizarSeparador();
    } catch (erro) { window.APG.mostrarErro(fConfig, erro); }
  });

  // ===== Auditoria =====
  function listaAuditoria(itens) {
    if (!itens.length) return el('p', { class: 'vazio', text: 'Sem registos.' });
    return el('ul', { class: 'linha-tempo' }, itens.map((a) => el('li', {},
      el('div', {}, el('strong', { text: ROTULOS_ACCAO[a.accao] || a.accao }), ` — ${a.autor || 'Sistema'}${a.papel && a.papel !== 'publico' ? ` (${a.papel})` : ''}`),
      el('div', { class: 'secundario', text: `${a.entidade}${a.entidadeId ? ` #${a.entidadeId}` : ''}${a.detalhes ? ` · ${JSON.stringify(a.detalhes)}` : ''}` }),
      el('div', { class: 'quando', text: `${dataHora(a.criadoEm)}${a.ip ? ` · ${a.ip}` : ''}` }))));
  }
  desenhadores.auditoria = async () => {
    const lista = await api(`/admin/auditoria?limite=200&entidade=${encodeURIComponent($('auditoriaEntidade').value)}`);
    limpar($('auditoriaLista')).append(listaAuditoria(lista));
  };
  $('auditoriaEntidade').addEventListener('change', actualizarSeparador);

  iniciar();
}());
