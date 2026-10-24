'use strict';

const { auditar, notificar } = require('./auditoria');
const { lerConfig, percentagemDoPrazo } = require('./config');
const { ErroApi, agora, hoje, somarDias, paraCentavos, validador } = require('./util');

const ESTADOS_PEDIDO = {
  pendente_analise: 'Pendente de análise',
  em_analise: 'Em análise',
  aprovado: 'Aprovado',
  rejeitado: 'Rejeitado',
  cancelado: 'Cancelado',
};
const ESTADOS_CREDITO = {
  aguarda_desembolso: 'Aprovado — aguarda desembolso',
  activo: 'Activo',
  liquidado: 'Liquidado',
  cancelado: 'Cancelado',
};
const TRANSICOES = {
  pendente_analise: ['em_analise', 'aprovado', 'rejeitado', 'cancelado'],
  em_analise: ['aprovado', 'rejeitado', 'cancelado'],
};
const METODOS = ['numerario', 'mpesa', 'emola', 'mkesh', 'transferencia', 'outro'];
const VALOR_MAXIMO_TECNICO = 1e9; // limite de sanidade, não uma regra comercial
const JANELA_DUPLICADOS_MIN = 10;

// Formato do site: 3.450 MT (ponto nos milhares, vírgula nas casas decimais).
function mt(centavos) {
  const inteiro = String(Math.floor(centavos / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const resto = centavos % 100;
  return `${inteiro}${resto ? `,${String(resto).padStart(2, '0')}` : ''} MT`;
}
const dataPt = (iso) => iso.slice(0, 10).split('-').reverse().join('/');
const encargo = (montanteCentavos, percentagem) => Math.round((montanteCentavos * percentagem) / 100);

// ===== Pedidos =====

function validarCondicoes(v, cfg, valor, prazoDias) {
  const valorOk = v.numero('valor', valor, { rotulo: 'O valor', min: cfg.valorMinimo, max: VALOR_MAXIMO_TECNICO });
  if (valorOk !== null && Math.abs(valorOk * 100 - Math.round(valorOk * 100)) > 1e-6) v.erro('valor', 'O valor tem demasiadas casas decimais.');
  const prazo = v.numero('prazoDias', prazoDias, { rotulo: 'O prazo', inteiro: true, min: 1 });
  const percentagem = prazo === null ? undefined : percentagemDoPrazo(cfg, prazo);
  if (prazo !== null && percentagem === undefined) {
    v.erro('prazoDias', `Escolha um dos prazos disponíveis: ${cfg.prazos.map((p) => `${p.dias} dias`).join(', ')}.`);
  }
  return { valor: valorOk, prazo, percentagem };
}

// Cria um pedido com estado inicial «Pendente de análise». A percentagem vem
// sempre da configuração do servidor, nunca do navegador. Um pedido igual
// submetido pouco antes (duplo clique, reenvio) devolve o pedido já existente.
function criarPedido(db, req, dados) {
  const cfg = lerConfig(db);
  const v = validador();
  const { valor, prazo, percentagem } = validarCondicoes(v, cfg, dados.valor, dados.prazoDias);
  const finalidade = v.textoLongo('finalidade', dados.finalidade, { rotulo: 'A finalidade', max: 300 });
  const informacoes = v.textoLongo('informacoes', dados.informacoes, { rotulo: 'As informações adicionais', max: 2000 });
  const chave = dados.chaveIdempotencia ?? null;
  if (chave !== null && (typeof chave !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(chave))) {
    v.erro('chaveIdempotencia', 'Identificador de submissão inválido.');
  }
  v.verificar();

  if (dados.clienteId && chave) {
    const existente = db.prepare('SELECT * FROM pedidos WHERE cliente_id = ? AND chave_idempotencia = ?').get(dados.clienteId, chave);
    if (existente) return { pedido: existente, duplicado: true };
  }
  const limite = new Date(Date.now() - JANELA_DUPLICADOS_MIN * 60000).toISOString();
  const recente = db.prepare(`
    SELECT * FROM pedidos
     WHERE telefone = ? AND valor = ? AND prazo_dias = ? AND estado = 'pendente_analise' AND criado_em > ?
       AND cliente_id IS ?
     ORDER BY id DESC LIMIT 1`).get(dados.telefone, valor, prazo, limite, dados.clienteId ?? null);
  if (recente) return { pedido: recente, duplicado: true };

  const t = agora();
  const r = db.prepare(`
    INSERT INTO pedidos (nome, telefone, valor, prazo_dias, criado_em, cliente_id, percentagem, finalidade, informacoes,
                         estado, origem, submetido_por, chave_idempotencia, actualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente_analise', ?, ?, ?, ?)`)
    .run(dados.nome, dados.telefone, valor, prazo, t, dados.clienteId ?? null, percentagem, finalidade, informacoes,
      dados.origem, req.utilizador?.id ?? null, chave, t);
  const id = Number(r.lastInsertRowid);
  db.prepare("UPDATE pedidos SET referencia = 'APG-' || substr(criado_em, 1, 4) || '-' || printf('%06d', id) WHERE id = ?").run(id);
  db.prepare(`INSERT INTO pedido_historico (pedido_id, estado_anterior, estado_novo, autor_id, autor_papel, criado_em)
              VALUES (?, NULL, 'pendente_analise', ?, ?, ?)`)
    .run(id, req.utilizador?.id ?? null, req.utilizador ? req.utilizador.papel : 'sistema', t);
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
  auditar(db, req, 'pedido.submetido', 'pedido', id, { referencia: pedido.referencia, valor, prazo, origem: dados.origem });
  if (dados.clienteId) {
    notificar(db, dados.clienteId, `Pedido ${pedido.referencia} recebido`,
      `Recebemos o seu pedido de ${mt(paraCentavos(valor))} por ${prazo} dias. Estado: Pendente de análise.`);
  }
  return { pedido, duplicado: false };
}

function mudarEstado(db, req, pedido, novo, { nota = null } = {}) {
  if (!(TRANSICOES[pedido.estado] ?? []).includes(novo)) {
    throw new ErroApi(409, `Não é possível passar um pedido «${ESTADOS_PEDIDO[pedido.estado]}» para «${ESTADOS_PEDIDO[novo]}».`);
  }
  const t = agora();
  const decisao = ['aprovado', 'rejeitado', 'cancelado'].includes(novo);
  db.prepare(`UPDATE pedidos SET estado = ?, actualizado_em = ?,
                     decidido_por = CASE WHEN ? THEN ? ELSE decidido_por END,
                     decidido_em  = CASE WHEN ? THEN ? ELSE decidido_em END,
                     motivo_decisao = CASE WHEN ? THEN ? ELSE motivo_decisao END
               WHERE id = ? AND estado = ?`)
    .run(novo, t, decisao ? 1 : 0, req.utilizador.id, decisao ? 1 : 0, t, decisao ? 1 : 0, nota, pedido.id, pedido.estado);
  db.prepare(`INSERT INTO pedido_historico (pedido_id, estado_anterior, estado_novo, nota, autor_id, autor_papel, criado_em)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(pedido.id, pedido.estado, novo, nota, req.utilizador.id, req.utilizador.papel, t);
}

function acrescentarObservacao(db, req, pedidoId, texto) {
  if (!texto) return;
  const linha = `[${agora().slice(0, 16).replace('T', ' ')} · ${req.utilizador.nome}] ${texto}`;
  db.prepare(`UPDATE pedidos SET observacoes_internas = CASE WHEN observacoes_internas IS NULL THEN ? ELSE observacoes_internas || char(10) || ? END
               WHERE id = ?`).run(linha, linha, pedidoId);
}

function lerPedidoParaDecisao(db, req, pedidoId) {
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
  if (!pedido) throw new ErroApi(404, 'Pedido não encontrado.');
  // Defesa adicional: contas de administrador não têm perfil de cliente (CHECK na
  // tabela utilizadores), mas a regra fica explícita aqui.
  if (req.utilizador.clienteId && req.utilizador.clienteId === pedido.cliente_id) {
    throw new ErroApi(403, 'Não pode decidir um pedido seu.');
  }
  return pedido;
}

function aprovarPedido(db, req, pedidoId, dados) {
  const pedido = lerPedidoParaDecisao(db, req, pedidoId);
  if (!pedido.cliente_id) throw new ErroApi(409, 'Associe primeiro este pedido a um cliente.');
  if (!TRANSICOES[pedido.estado]?.includes('aprovado')) {
    throw new ErroApi(409, `Este pedido já está «${ESTADOS_PEDIDO[pedido.estado]}».`);
  }
  const cfg = lerConfig(db);
  const v = validador();
  const { valor, prazo, percentagem } = validarCondicoes(v, cfg, dados.montante ?? pedido.valor, dados.prazoDias ?? pedido.prazo_dias);
  const n = v.numero('numeroPrestacoes', dados.numeroPrestacoes ?? 1, { rotulo: 'O número de prestações', inteiro: true, min: 1, max: 12 });
  if (n !== null && prazo !== null && n > prazo) v.erro('numeroPrestacoes', 'Mais prestações do que dias de prazo.');
  const motivo = v.textoLongo('motivo', dados.motivo, { rotulo: 'A mensagem ao cliente', max: 500 });
  const observacoes = v.textoLongo('observacoes', dados.observacoes, { rotulo: 'As observações internas', max: 2000 });
  v.verificar();

  const montante = paraCentavos(valor);
  const enc = encargo(montante, percentagem);
  mudarEstado(db, req, pedido, 'aprovado', { nota: motivo });
  acrescentarObservacao(db, req, pedido.id, observacoes);
  const t = agora();
  const r = db.prepare(`
    INSERT INTO creditos (pedido_id, cliente_id, montante_centavos, percentagem, prazo_dias, encargo_centavos, total_centavos,
                          numero_prestacoes, estado, aprovado_por, aprovado_em, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aguarda_desembolso', ?, ?, ?)`)
    .run(pedido.id, pedido.cliente_id, montante, percentagem, prazo, enc, montante + enc, n, req.utilizador.id, t, t);
  const creditoId = Number(r.lastInsertRowid);
  db.prepare("UPDATE creditos SET referencia = 'CR-' || substr(criado_em, 1, 4) || '-' || printf('%06d', id) WHERE id = ?").run(creditoId);

  auditar(db, req, 'pedido.aprovado', 'pedido', pedido.id, {
    creditoId, montanteCentavos: montante, prazoDias: prazo, percentagem, numeroPrestacoes: n,
  });
  notificar(db, pedido.cliente_id, `Pedido ${pedido.referencia} aprovado`,
    `A APG aprovou ${mt(montante)} por ${prazo} dias (encargo de ${percentagem}%). Total a reembolsar: ${mt(montante + enc)}. `
    + 'O crédito fica activo depois de a APG registar o desembolso.'
    + (motivo ? ` Nota da APG: ${motivo}` : ''));
  return creditoId;
}

function rejeitarPedido(db, req, pedidoId, dados) {
  const pedido = lerPedidoParaDecisao(db, req, pedidoId);
  const v = validador();
  const motivo = v.texto('motivo', dados.motivo, { rotulo: 'O motivo', min: 3, max: 500 });
  const observacoes = v.textoLongo('observacoes', dados.observacoes, { rotulo: 'As observações internas', max: 2000 });
  v.verificar();
  mudarEstado(db, req, pedido, 'rejeitado', { nota: motivo });
  acrescentarObservacao(db, req, pedido.id, observacoes);
  auditar(db, req, 'pedido.rejeitado', 'pedido', pedido.id, { motivo });
  if (pedido.cliente_id) {
    notificar(db, pedido.cliente_id, `Pedido ${pedido.referencia} não aprovado`, `A APG não aprovou este pedido. Motivo: ${motivo}`);
  }
}

function colocarEmAnalise(db, req, pedidoId, dados) {
  const pedido = lerPedidoParaDecisao(db, req, pedidoId);
  const v = validador();
  const nota = v.textoLongo('nota', dados.nota, { rotulo: 'A nota ao cliente', max: 500 });
  v.verificar();
  mudarEstado(db, req, pedido, 'em_analise', { nota });
  auditar(db, req, 'pedido.em_analise', 'pedido', pedido.id);
  if (pedido.cliente_id) {
    notificar(db, pedido.cliente_id, `Pedido ${pedido.referencia} em análise`,
      'A APG está a analisar o seu pedido.' + (nota ? ` ${nota}` : ''));
  }
}

function cancelarPedido(db, req, pedido, motivo) {
  mudarEstado(db, req, pedido, 'cancelado', { nota: motivo });
  auditar(db, req, 'pedido.cancelado', 'pedido', pedido.id, { motivo });
  if (pedido.cliente_id && req.utilizador.papel === 'admin') {
    notificar(db, pedido.cliente_id, `Pedido ${pedido.referencia} cancelado`, `O pedido foi cancelado pela APG. ${motivo ?? ''}`.trim());
  }
}

// ===== Créditos =====

function lerCredito(db, creditoId) {
  const c = db.prepare('SELECT * FROM creditos WHERE id = ?').get(creditoId);
  if (!c) throw new ErroApi(404, 'Crédito não encontrado.');
  return c;
}

function registarDesembolso(db, req, creditoId, dados) {
  const c = lerCredito(db, creditoId);
  if (c.estado !== 'aguarda_desembolso') throw new ErroApi(409, `Este crédito está «${ESTADOS_CREDITO[c.estado]}».`);
  const v = validador();
  const data = v.data('data', dados.data, { rotulo: 'A data do desembolso' });
  if (data && data > hoje()) v.erro('data', 'A data do desembolso não pode ser futura.');
  if (data && data < c.aprovado_em.slice(0, 10)) v.erro('data', 'A data do desembolso é anterior à aprovação.');
  const metodo = v.opcao('metodo', dados.metodo, METODOS, { rotulo: 'O método' });
  const referencia = v.textoLongo('referencia', dados.referencia, { rotulo: 'A referência', max: 120 });
  if (dados.contratoAssinado !== true) v.erro('contratoAssinado', 'Confirme que o contrato foi assinado.');
  if (dados.identidadeVerificada !== true) v.erro('identidadeVerificada', 'Confirme que a identidade do cliente foi verificada.');
  v.verificar();

  const condicoes = { contratoAssinado: true, identidadeVerificada: true, confirmadoPor: req.utilizador.id, confirmadoEm: agora() };
  db.prepare(`UPDATE creditos SET estado = 'activo', desembolsado_em = ?, desembolso_registado_por = ?, desembolso_metodo = ?,
                     desembolso_referencia = ?, condicoes_activacao = ?
               WHERE id = ? AND estado = 'aguarda_desembolso'`)
    .run(data, req.utilizador.id, metodo, referencia, JSON.stringify(condicoes), c.id);

  // Prestações iguais, com o arredondamento na última; vencimentos distribuídos pelo prazo.
  const base = Math.floor(c.total_centavos / c.numero_prestacoes);
  const inserir = db.prepare('INSERT INTO prestacoes (credito_id, numero, valor_centavos, vencimento) VALUES (?, ?, ?, ?)');
  for (let i = 1; i <= c.numero_prestacoes; i += 1) {
    const valor = i === c.numero_prestacoes ? c.total_centavos - base * (c.numero_prestacoes - 1) : base;
    inserir.run(c.id, i, valor, somarDias(data, Math.round((c.prazo_dias * i) / c.numero_prestacoes)));
  }
  auditar(db, req, 'credito.desembolsado', 'credito', c.id, { data, metodo, referencia });
  const primeiro = somarDias(data, Math.round(c.prazo_dias / c.numero_prestacoes));
  notificar(db, c.cliente_id, `Crédito ${c.referencia} activo`,
    `A APG registou o desembolso de ${mt(c.montante_centavos)} em ${dataPt(data)}. Total a reembolsar: ${mt(c.total_centavos)}`
    + ` em ${c.numero_prestacoes} prestação(ões). Primeiro vencimento: ${dataPt(primeiro)}.`);
}

function cancelarCredito(db, req, creditoId, dados) {
  const c = lerCredito(db, creditoId);
  if (c.estado !== 'aguarda_desembolso') throw new ErroApi(409, 'Só é possível cancelar um crédito antes do desembolso.');
  const v = validador();
  const motivo = v.texto('motivo', dados.motivo, { rotulo: 'O motivo', min: 3, max: 500 });
  v.verificar();
  db.prepare("UPDATE creditos SET estado = 'cancelado', cancelado_em = ?, motivo_cancelamento = ? WHERE id = ?").run(agora(), motivo, c.id);
  auditar(db, req, 'credito.cancelado', 'credito', c.id, { motivo });
  notificar(db, c.cliente_id, `Crédito ${c.referencia} cancelado`, `O crédito foi cancelado antes do desembolso. Motivo: ${motivo}`);
}

const somaPaga = (db, creditoId) => db.prepare(
  'SELECT COALESCE(SUM(valor_centavos), 0) AS s FROM pagamentos WHERE credito_id = ? AND anulado_em IS NULL',
).get(creditoId).s;

// Recalcula as prestações a partir de todos os pagamentos válidos (por ordem de
// data), para que um pagamento ou uma anulação deixem sempre o crédito coerente.
function recalcularCredito(db, creditoId) {
  const c = lerCredito(db, creditoId);
  const pagamentos = db.prepare(`SELECT valor_centavos, data_pagamento FROM pagamentos
                                  WHERE credito_id = ? AND anulado_em IS NULL ORDER BY data_pagamento, id`).all(creditoId);
  const prestacoes = db.prepare('SELECT * FROM prestacoes WHERE credito_id = ? ORDER BY numero').all(creditoId);
  const actualizar = db.prepare('UPDATE prestacoes SET pago_centavos = ?, estado = ?, paga_em = ? WHERE id = ?');

  let acumuladoDevido = 0;
  let restante = pagamentos.reduce((s, p) => s + p.valor_centavos, 0);
  for (const p of prestacoes) {
    acumuladoDevido += p.valor_centavos;
    const pago = Math.min(restante, p.valor_centavos);
    restante -= pago;
    let pagaEm = null;
    if (pago === p.valor_centavos) {
      let acumulado = 0;
      for (const pg of pagamentos) {
        acumulado += pg.valor_centavos;
        if (acumulado >= acumuladoDevido) { pagaEm = pg.data_pagamento; break; }
      }
    }
    actualizar.run(pago, pago === p.valor_centavos ? 'paga' : pago > 0 ? 'parcial' : 'por_pagar', pagaEm, p.id);
  }

  const total = pagamentos.reduce((s, p) => s + p.valor_centavos, 0);
  if (total >= c.total_centavos && c.estado === 'activo') {
    db.prepare("UPDATE creditos SET estado = 'liquidado', liquidado_em = ? WHERE id = ?").run(pagamentos.at(-1).data_pagamento, c.id);
  } else if (total < c.total_centavos && c.estado === 'liquidado') {
    db.prepare("UPDATE creditos SET estado = 'activo', liquidado_em = NULL WHERE id = ?").run(c.id);
  }
}

function registarPagamento(db, req, creditoId, dados) {
  const c = lerCredito(db, creditoId);
  if (c.estado !== 'activo') throw new ErroApi(409, `Só é possível registar pagamentos num crédito activo (este está «${ESTADOS_CREDITO[c.estado]}»).`);
  const saldo = c.total_centavos - somaPaga(db, c.id);
  const v = validador();
  const valor = v.numero('valor', dados.valor, { rotulo: 'O valor', min: 0.01, max: VALOR_MAXIMO_TECNICO });
  const centavos = valor === null ? null : paraCentavos(valor);
  if (centavos !== null && centavos > saldo) v.erro('valor', `O valor excede o saldo pendente (${mt(saldo)}).`);
  const data = v.data('data', dados.data, { rotulo: 'A data do pagamento' });
  if (data && data > hoje()) v.erro('data', 'A data do pagamento não pode ser futura.');
  if (data && data < c.desembolsado_em) v.erro('data', 'A data do pagamento é anterior ao desembolso.');
  const metodo = v.opcao('metodo', dados.metodo, METODOS, { rotulo: 'O método' });
  const referencia = v.textoLongo('referencia', dados.referencia, { rotulo: 'A referência', max: 120 });
  const observacoes = v.textoLongo('observacoes', dados.observacoes, { rotulo: 'As observações', max: 500 });
  v.verificar();

  const r = db.prepare(`INSERT INTO pagamentos (credito_id, valor_centavos, data_pagamento, metodo, referencia_externa, observacoes,
                                                registado_por, registado_em)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(c.id, centavos, data, metodo, referencia, observacoes, req.utilizador.id, agora());
  const pagamentoId = Number(r.lastInsertRowid);
  recalcularCredito(db, c.id);
  const novoSaldo = saldo - centavos;
  auditar(db, req, 'pagamento.registado', 'credito', c.id, { pagamentoId, valorCentavos: centavos, data, metodo, referencia });
  notificar(db, c.cliente_id, `Pagamento confirmado — ${c.referencia}`,
    `A APG confirmou o pagamento de ${mt(centavos)} em ${dataPt(data)}. `
    + (novoSaldo === 0 ? 'O crédito está totalmente liquidado. Obrigado!' : `Saldo pendente: ${mt(novoSaldo)}.`));
  return pagamentoId;
}

function anularPagamento(db, req, pagamentoId, dados) {
  const p = db.prepare('SELECT * FROM pagamentos WHERE id = ?').get(pagamentoId);
  if (!p) throw new ErroApi(404, 'Pagamento não encontrado.');
  if (p.anulado_em) throw new ErroApi(409, 'Este pagamento já foi anulado.');
  const v = validador();
  const motivo = v.texto('motivo', dados.motivo, { rotulo: 'O motivo', min: 3, max: 500 });
  v.verificar();
  db.prepare('UPDATE pagamentos SET anulado_em = ?, anulado_por = ?, motivo_anulacao = ? WHERE id = ?')
    .run(agora(), req.utilizador.id, motivo, p.id);
  recalcularCredito(db, p.credito_id);
  const c = lerCredito(db, p.credito_id);
  auditar(db, req, 'pagamento.anulado', 'credito', c.id, { pagamentoId: p.id, valorCentavos: p.valor_centavos, motivo });
  notificar(db, c.cliente_id, `Correcção de pagamento — ${c.referencia}`,
    `O registo de pagamento de ${mt(p.valor_centavos)} de ${dataPt(p.data_pagamento)} foi anulado pela APG. Motivo: ${motivo}`);
}

// Vista de um crédito com prestações, pagamentos e saldo. `interno` acrescenta
// os dados só visíveis à administração.
function detalheCredito(db, c, { interno = false } = {}) {
  const hj = hoje();
  const pedido = db.prepare('SELECT referencia FROM pedidos WHERE id = ?').get(c.pedido_id);
  const prestacoes = db.prepare('SELECT * FROM prestacoes WHERE credito_id = ? ORDER BY numero').all(c.id).map((p) => ({
    numero: p.numero,
    valorCentavos: p.valor_centavos,
    pagoCentavos: p.pago_centavos,
    emFaltaCentavos: p.valor_centavos - p.pago_centavos,
    vencimento: p.vencimento,
    estado: p.estado,
    emAtraso: p.estado !== 'paga' && p.vencimento < hj,
    pagaEm: p.paga_em,
  }));
  const pagamentos = db.prepare(`
    SELECT p.*, u.nome AS registado_por_nome FROM pagamentos p JOIN utilizadores u ON u.id = p.registado_por
     WHERE p.credito_id = ? ${interno ? '' : 'AND p.anulado_em IS NULL'} ORDER BY p.data_pagamento DESC, p.id DESC`)
    .all(c.id).map((p) => ({
      id: p.id,
      valorCentavos: p.valor_centavos,
      dataPagamento: p.data_pagamento,
      metodo: p.metodo,
      referencia: p.referencia_externa,
      ...(interno ? {
        observacoes: p.observacoes, registadoPor: p.registado_por_nome, registadoEm: p.registado_em,
        anuladoEm: p.anulado_em, motivoAnulacao: p.motivo_anulacao,
      } : {}),
    }));
  const pago = somaPaga(db, c.id);
  const emAberto = c.estado === 'activo';
  const proxima = prestacoes.find((p) => p.estado !== 'paga');
  return {
    id: c.id,
    referencia: c.referencia,
    pedidoReferencia: pedido?.referencia,
    estado: c.estado,
    estadoRotulo: ESTADOS_CREDITO[c.estado],
    montanteCentavos: c.montante_centavos,
    percentagem: c.percentagem,
    prazoDias: c.prazo_dias,
    encargoCentavos: c.encargo_centavos,
    totalCentavos: c.total_centavos,
    numeroPrestacoes: c.numero_prestacoes,
    aprovadoEm: c.aprovado_em,
    desembolsadoEm: c.desembolsado_em,
    liquidadoEm: c.liquidado_em,
    pagoCentavos: pago,
    saldoCentavos: emAberto ? c.total_centavos - pago : 0,
    emAtraso: emAberto && prestacoes.some((p) => p.emAtraso),
    proximoVencimento: emAberto && proxima ? { vencimento: proxima.vencimento, emFaltaCentavos: proxima.emFaltaCentavos } : null,
    prestacoes,
    pagamentos,
    ...(interno ? {
      clienteId: c.cliente_id,
      desembolsoMetodo: c.desembolso_metodo,
      desembolsoReferencia: c.desembolso_referencia,
      condicoesActivacao: c.condicoes_activacao ? JSON.parse(c.condicoes_activacao) : null,
      canceladoEm: c.cancelado_em,
      motivoCancelamento: c.motivo_cancelamento,
    } : {}),
  };
}

function historicoPedido(db, pedidoId, { interno = false } = {}) {
  return db.prepare(`SELECT h.*, u.nome AS autor_nome FROM pedido_historico h LEFT JOIN utilizadores u ON u.id = h.autor_id
                      WHERE h.pedido_id = ? ORDER BY h.id`).all(pedidoId).map((h) => ({
    estadoAnterior: h.estado_anterior,
    estadoNovo: h.estado_novo,
    estadoRotulo: ESTADOS_PEDIDO[h.estado_novo],
    nota: h.nota,
    autor: h.autor_papel === 'admin' ? (interno ? h.autor_nome : 'APG') : h.autor_papel === 'cliente' ? 'Cliente' : 'Sistema',
    criadoEm: h.criado_em,
  }));
}

function vistaPedido(db, p, { interno = false } = {}) {
  const valorCentavos = paraCentavos(p.valor);
  const credito = db.prepare('SELECT id, referencia, estado FROM creditos WHERE pedido_id = ?').get(p.id);
  return {
    id: p.id,
    referencia: p.referencia,
    valorCentavos,
    prazoDias: p.prazo_dias,
    percentagem: p.percentagem,
    totalEstimadoCentavos: p.percentagem == null ? null : valorCentavos + encargo(valorCentavos, p.percentagem),
    finalidade: p.finalidade,
    informacoes: p.informacoes,
    estado: p.estado,
    estadoRotulo: ESTADOS_PEDIDO[p.estado],
    origem: p.origem,
    criadoEm: p.criado_em,
    decididoEm: p.decidido_em,
    motivoDecisao: p.motivo_decisao,
    credito: credito ? { id: credito.id, referencia: credito.referencia, estado: credito.estado, estadoRotulo: ESTADOS_CREDITO[credito.estado] } : null,
    historico: historicoPedido(db, p.id, { interno }),
    ...(interno ? {
      clienteId: p.cliente_id,
      nome: p.nome,
      telefone: p.telefone,
      observacoesInternas: p.observacoes_internas,
      decididoPor: p.decidido_por
        ? db.prepare('SELECT nome FROM utilizadores WHERE id = ?').get(p.decidido_por)?.nome : null,
    } : {}),
  };
}

module.exports = {
  ESTADOS_PEDIDO, ESTADOS_CREDITO, METODOS,
  criarPedido, aprovarPedido, rejeitarPedido, colocarEmAnalise, cancelarPedido,
  registarDesembolso, cancelarCredito, registarPagamento, anularPagamento, recalcularCredito,
  detalheCredito, vistaPedido, historicoPedido, lerCredito,
};
