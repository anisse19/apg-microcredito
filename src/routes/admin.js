'use strict';

const express = require('express');
const { transaccao } = require('../db');
const { auditar, notificar } = require('../auditoria');
const { lerConfig, guardarConfig } = require('../config');
const { emitirToken } = require('../contas');
const {
  ESTADOS_PEDIDO, ESTADOS_CREDITO, METODOS,
  aprovarPedido, rejeitarPedido, colocarEmAnalise, cancelarPedido,
  registarDesembolso, cancelarCredito, registarPagamento, anularPagamento,
  detalheCredito, vistaPedido, lerCredito,
} = require('../creditos');
const { terminarTodasSessoes } = require('../sessoes');
const { ErroApi, agora, hoje, validador, idParam, normalizarTelefone } = require('../util');

// Painel administrativo. Montado atrás de exigirAdmin: o papel é verificado no
// servidor em cada pedido, a partir da sessão.
function rotasAdmin(db) {
  const r = express.Router();
  const emTransaccao = (fn) => (req, res) => res.json(transaccao(db, () => fn(req, res)) ?? { ok: true });

  // ===== Resumo =====
  r.get('/resumo', (req, res) => {
    const contar = (sql, ...p) => db.prepare(sql).get(...p).n;
    const seteDias = new Date(Date.now() - 7 * 86400000).toISOString();
    const porEstado = Object.fromEntries(db.prepare('SELECT estado, COUNT(*) AS n FROM pedidos GROUP BY estado').all().map((l) => [l.estado, l.n]));
    const carteira = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(c.total_centavos), 0) AS total,
             COALESCE(SUM((SELECT COALESCE(SUM(valor_centavos), 0) FROM pagamentos p WHERE p.credito_id = c.id AND p.anulado_em IS NULL)), 0) AS pago
        FROM creditos c WHERE c.estado = 'activo'`).get();
    res.json({
      pedidosPorEstado: porEstado,
      clientes: contar('SELECT COUNT(*) AS n FROM clientes'),
      creditosActivos: carteira.n,
      creditosAguardandoDesembolso: contar("SELECT COUNT(*) AS n FROM creditos WHERE estado = 'aguarda_desembolso'"),
      carteiraTotalCentavos: carteira.total,
      saldoPendenteCentavos: carteira.total - carteira.pago,
      prestacoesEmAtraso: contar(`SELECT COUNT(*) AS n FROM prestacoes p JOIN creditos c ON c.id = p.credito_id
                                   WHERE c.estado = 'activo' AND p.estado <> 'paga' AND p.vencimento < ?`, hoje()),
      recuperacoesPendentes: contar("SELECT COUNT(*) AS n FROM pedidos_recuperacao WHERE estado = 'pendente'"),
      visitas7Dias: contar('SELECT COUNT(*) AS n FROM visitas WHERE criado_em > ?', seteDias),
      interacoes7Dias: Object.fromEntries(db.prepare('SELECT tipo, COUNT(*) AS n FROM interacoes WHERE criado_em > ? GROUP BY tipo')
        .all(seteDias).map((l) => [l.tipo, l.n])),
    });
  });

  // ===== Clientes =====
  function lerDadosCliente(b) {
    const v = validador();
    const dados = {
      nomeCompleto: v.texto('nomeCompleto', b.nomeCompleto, { rotulo: 'O nome completo', min: 5, max: 120 }),
      telefone: v.telefone('telefone', b.telefone),
      email: v.email('email', b.email),
      documentoTipo: v.textoLongo('documentoTipo', b.documentoTipo, { rotulo: 'O tipo de documento', max: 40 }),
      documentoNumero: v.textoLongo('documentoNumero', b.documentoNumero, { rotulo: 'O número do documento', max: 40 }),
      dataNascimento: v.data('dataNascimento', b.dataNascimento, { rotulo: 'A data de nascimento', obrigatorio: false }),
      morada: v.textoLongo('morada', b.morada, { rotulo: 'A morada', max: 300 }),
      notasInternas: v.textoLongo('notasInternas', b.notasInternas, { rotulo: 'As notas internas', max: 2000 }),
    };
    if (dados.documentoNumero && !dados.documentoTipo) v.erro('documentoTipo', 'Indique o tipo de documento.');
    if (dados.dataNascimento && dados.dataNascimento > hoje()) v.erro('dataNascimento', 'A data de nascimento é inválida.');
    v.verificar();
    return dados;
  }

  // Evita perfis financeiros duplicados: telefone, email ou documento já usados.
  function procurarDuplicado(d, ignorarClienteId = 0) {
    const c = db.prepare(`
      SELECT id, nome_completo FROM clientes
       WHERE id <> ? AND (telefone = ? OR (? IS NOT NULL AND email = ?)
             OR (? IS NOT NULL AND documento_tipo = ? AND documento_numero = ?))`)
      .get(ignorarClienteId, d.telefone, d.email, d.email, d.documentoNumero, d.documentoTipo, d.documentoNumero);
    if (c) {
      const e = new ErroApi(409, `Já existe um cliente com estes dados: ${c.nome_completo}. Abra a ficha existente em vez de criar outra.`);
      e.extra = { clienteExistenteId: c.id };
      throw e;
    }
    const u = db.prepare(`SELECT 1 FROM utilizadores WHERE (cliente_id IS NULL OR cliente_id <> ?)
                            AND (telefone = ? OR (? IS NOT NULL AND email = ?))`)
      .get(ignorarClienteId, d.telefone, d.email, d.email);
    if (u) throw new ErroApi(409, 'Este telefone ou email já está associado a outra conta.');
  }

  function resumoConta(clienteId) {
    const u = db.prepare('SELECT id, estado, criado_em, ultimo_acesso FROM utilizadores WHERE cliente_id = ?').get(clienteId);
    if (!u) return null;
    const link = db.prepare('SELECT tipo, expira_em FROM tokens_conta WHERE utilizador_id = ? AND usado_em IS NULL AND expira_em > ? ORDER BY id DESC')
      .get(u.id, agora());
    return {
      utilizadorId: u.id, estado: u.estado, criadoEm: u.criado_em, ultimoAcesso: u.ultimo_acesso,
      linkPendente: link ? { tipo: link.tipo, expiraEm: link.expira_em } : null,
    };
  }

  const vistaCliente = (c) => ({
    id: c.id,
    nomeCompleto: c.nome_completo,
    telefone: c.telefone,
    email: c.email,
    documentoTipo: c.documento_tipo,
    documentoNumero: c.documento_numero,
    dataNascimento: c.data_nascimento,
    morada: c.morada,
    notasInternas: c.notas_internas,
    telefoneVerificado: Boolean(c.telefone_verificado),
    origem: c.origem,
    criadoEm: c.criado_em,
    actualizadoEm: c.actualizado_em,
  });

  r.get('/clientes', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const digitos = q.replace(/\D/g, '');
    const termo = `%${q.replace(/[%_]/g, '')}%`;
    const linhas = db.prepare(`
      SELECT c.*,
             (SELECT estado FROM utilizadores u WHERE u.cliente_id = c.id) AS conta_estado,
             (SELECT COUNT(*) FROM pedidos p WHERE p.cliente_id = c.id) AS n_pedidos,
             (SELECT COUNT(*) FROM creditos k WHERE k.cliente_id = c.id AND k.estado = 'activo') AS n_activos
        FROM clientes c
       WHERE ? = '' OR c.nome_completo LIKE ? OR c.email LIKE ? OR (? <> '' AND c.telefone LIKE ?)
             OR c.documento_numero LIKE ?
             OR EXISTS (SELECT 1 FROM pedidos p WHERE p.cliente_id = c.id AND p.referencia LIKE ?)
       ORDER BY c.nome_completo LIMIT 200`)
      .all(q, termo, termo, digitos, `%${digitos}%`, termo, termo);
    res.json(linhas.map((c) => ({
      ...vistaCliente(c), contaEstado: c.conta_estado, numeroPedidos: c.n_pedidos, creditosActivos: c.n_activos,
    })));
  });

  r.post('/clientes', (req, res) => {
    const d = lerDadosCliente(req.body ?? {});
    const id = transaccao(db, () => {
      procurarDuplicado(d);
      const t = agora();
      const rr = db.prepare(`INSERT INTO clientes (nome_completo, telefone, email, documento_tipo, documento_numero, data_nascimento,
                                                   morada, notas_internas, origem, criado_por, criado_em, actualizado_em)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'administracao', ?, ?, ?)`)
        .run(d.nomeCompleto, d.telefone, d.email, d.documentoTipo, d.documentoNumero, d.dataNascimento, d.morada, d.notasInternas,
          req.utilizador.id, t, t);
      const novo = Number(rr.lastInsertRowid);
      auditar(db, req, 'cliente.criado', 'cliente', novo, { telefone: d.telefone, email: d.email });
      return novo;
    });
    res.status(201).json({ id });
  });

  r.get('/clientes/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(idParam(req.params.id));
    if (!c) throw new ErroApi(404, 'Cliente não encontrado.');
    const pedidos = db.prepare('SELECT * FROM pedidos WHERE cliente_id = ? ORDER BY id DESC').all(c.id);
    const creditos = db.prepare('SELECT * FROM creditos WHERE cliente_id = ? ORDER BY id DESC').all(c.id);
    const conta = resumoConta(c.id);
    const ids = (l) => JSON.stringify(l.map((x) => x.id));
    const historico = db.prepare(`
      SELECT a.*, u.nome AS autor FROM auditoria a LEFT JOIN utilizadores u ON u.id = a.utilizador_id
       WHERE (a.entidade = 'cliente' AND a.entidade_id = ?)
          OR (a.entidade = 'utilizador' AND a.entidade_id = ?)
          OR (a.entidade = 'pedido' AND a.entidade_id IN (SELECT value FROM json_each(?)))
          OR (a.entidade = 'credito' AND a.entidade_id IN (SELECT value FROM json_each(?)))
       ORDER BY a.id DESC LIMIT 200`).all(c.id, conta?.utilizadorId ?? 0, ids(pedidos), ids(creditos));
    res.json({
      cliente: vistaCliente(c),
      conta,
      pedidos: pedidos.map((p) => vistaPedido(db, p, { interno: true })),
      creditos: creditos.map((k) => detalheCredito(db, k, { interno: true })),
      historico: historico.map(vistaAuditoria),
    });
  });

  r.put('/clientes/:id', emTransaccao((req) => {
    const id = idParam(req.params.id);
    const antes = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
    if (!antes) throw new ErroApi(404, 'Cliente não encontrado.');
    const d = lerDadosCliente(req.body ?? {});
    procurarDuplicado(d, id);
    db.prepare(`UPDATE clientes SET nome_completo = ?, telefone = ?, email = ?, documento_tipo = ?, documento_numero = ?,
                       data_nascimento = ?, morada = ?, notas_internas = ?, actualizado_em = ?,
                       telefone_verificado = CASE WHEN telefone = ? THEN telefone_verificado ELSE 0 END
                 WHERE id = ?`)
      .run(d.nomeCompleto, d.telefone, d.email, d.documentoTipo, d.documentoNumero, d.dataNascimento, d.morada, d.notasInternas,
        agora(), d.telefone, id);
    // Os dados de acesso acompanham o cadastro.
    db.prepare('UPDATE utilizadores SET nome = ?, telefone = ?, email = ? WHERE cliente_id = ?').run(d.nomeCompleto, d.telefone, d.email, id);
    const alterados = {};
    const mapa = {
      nome_completo: 'nomeCompleto', telefone: 'telefone', email: 'email', documento_tipo: 'documentoTipo', documento_numero: 'documentoNumero',
      data_nascimento: 'dataNascimento', morada: 'morada', notas_internas: 'notasInternas',
    };
    for (const [coluna, campo] of Object.entries(mapa)) {
      if ((antes[coluna] ?? null) !== (d[campo] ?? null)) alterados[campo] = { antes: antes[coluna], depois: d[campo] };
    }
    auditar(db, req, 'cliente.actualizado', 'cliente', id, alterados);
  }));

  r.post('/clientes/:id/verificar-telefone', emTransaccao((req) => {
    const id = idParam(req.params.id);
    const rr = db.prepare('UPDATE clientes SET telefone_verificado = 1, actualizado_em = ? WHERE id = ?').run(agora(), id);
    if (!rr.changes) throw new ErroApi(404, 'Cliente não encontrado.');
    auditar(db, req, 'cliente.telefone_verificado', 'cliente', id);
  }));

  // Convite (conta nova) ou redefinição de acesso. Devolve um link de uso único
  // para a APG entregar ao cliente por um canal de confiança. O token não fica guardado.
  r.post('/clientes/:id/link-acesso', (req, res) => {
    const resultado = transaccao(db, () => {
      const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(idParam(req.params.id));
      if (!c) throw new ErroApi(404, 'Cliente não encontrado.');
      let u = db.prepare('SELECT * FROM utilizadores WHERE cliente_id = ?').get(c.id);
      if (!u) {
        const ocupado = db.prepare('SELECT 1 FROM utilizadores WHERE telefone = ? OR (? IS NOT NULL AND email = ?)').get(c.telefone, c.email, c.email);
        if (ocupado) throw new ErroApi(409, 'O telefone ou email deste cliente já está associado a outra conta.');
        const rr = db.prepare(`INSERT INTO utilizadores (cliente_id, nome, telefone, email, papel, estado, criado_em)
                               VALUES (?, ?, ?, ?, 'cliente', 'pendente_activacao', ?)`).run(c.id, c.nome_completo, c.telefone, c.email, agora());
        u = db.prepare('SELECT * FROM utilizadores WHERE id = ?').get(Number(rr.lastInsertRowid));
        auditar(db, req, 'conta.convite_criado', 'utilizador', u.id, { clienteId: c.id });
      }
      if (u.estado === 'bloqueado') throw new ErroApi(409, 'A conta está bloqueada. Desbloqueie-a primeiro.');
      const tipo = u.estado === 'pendente_activacao' ? 'activacao' : 'redefinicao';
      const { token, expira } = emitirToken(db, u.id, tipo, req.utilizador.id);
      db.prepare("UPDATE pedidos_recuperacao SET estado = 'tratado', tratado_por = ?, tratado_em = ? WHERE utilizador_id = ? AND estado = 'pendente'")
        .run(req.utilizador.id, agora(), u.id);
      auditar(db, req, tipo === 'activacao' ? 'conta.link_activacao_emitido' : 'conta.link_redefinicao_emitido', 'utilizador', u.id, { expira });
      return { token, expira, tipo };
    });
    const base = req.app.locals.opcoes.urlPublica || `${req.protocol}://${req.get('host')}`;
    res.json({ tipo: resultado.tipo, expiraEm: resultado.expira, link: `${base}/conta/definir#t=${resultado.token}` });
  });

  r.post('/clientes/:id/conta', emTransaccao((req) => {
    const id = idParam(req.params.id);
    const accao = req.body?.accao;
    const u = db.prepare('SELECT * FROM utilizadores WHERE cliente_id = ?').get(id);
    if (!u) throw new ErroApi(404, 'Este cliente ainda não tem conta.');
    if (accao === 'bloquear') {
      db.prepare("UPDATE utilizadores SET estado = 'bloqueado' WHERE id = ?").run(u.id);
      db.prepare('DELETE FROM tokens_conta WHERE utilizador_id = ? AND usado_em IS NULL').run(u.id);
      terminarTodasSessoes(db, u.id);
    } else if (accao === 'desbloquear') {
      db.prepare('UPDATE utilizadores SET estado = ?, tentativas_falhadas = 0, bloqueado_ate = NULL WHERE id = ?')
        .run(u.palavra_passe_hash ? 'activo' : 'pendente_activacao', u.id);
    } else {
      throw new ErroApi(400, 'Acção inválida.');
    }
    auditar(db, req, `conta.${accao === 'bloquear' ? 'bloqueada' : 'desbloqueada'}`, 'utilizador', u.id, { clienteId: id });
  }));

  // ===== Pedidos =====
  r.get('/pedidos', (req, res) => {
    const estado = Object.keys(ESTADOS_PEDIDO).includes(req.query.estado) ? req.query.estado : null;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const termo = `%${q.replace(/[%_]/g, '')}%`;
    const linhas = db.prepare(`
      SELECT p.*, c.nome_completo AS cliente_nome FROM pedidos p LEFT JOIN clientes c ON c.id = p.cliente_id
       WHERE (? IS NULL OR p.estado = ?)
         AND (? = '' OR p.referencia LIKE ? OR p.nome LIKE ? OR p.telefone LIKE ? OR c.nome_completo LIKE ?)
       ORDER BY CASE p.estado WHEN 'pendente_analise' THEN 0 WHEN 'em_analise' THEN 1 ELSE 2 END, p.id DESC
       LIMIT 300`).all(estado, estado, q, termo, termo, termo, termo);
    res.json(linhas.map((p) => ({
      id: p.id,
      referencia: p.referencia,
      nome: p.nome,
      telefone: p.telefone,
      clienteId: p.cliente_id,
      clienteNome: p.cliente_nome,
      valorCentavos: Math.round(p.valor * 100),
      prazoDias: p.prazo_dias,
      estado: p.estado,
      estadoRotulo: ESTADOS_PEDIDO[p.estado],
      origem: p.origem,
      criadoEm: p.criado_em,
    })));
  });

  r.get('/pedidos/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(idParam(req.params.id));
    if (!p) throw new ErroApi(404, 'Pedido não encontrado.');
    const cliente = p.cliente_id ? db.prepare('SELECT * FROM clientes WHERE id = ?').get(p.cliente_id) : null;
    const sugestoes = !p.cliente_id
      ? db.prepare('SELECT * FROM clientes WHERE telefone = ? LIMIT 5').all(normalizarTelefone(p.telefone) ?? p.telefone).map(vistaCliente)
      : [];
    res.json({
      pedido: vistaPedido(db, p, { interno: true }),
      cliente: cliente ? { ...vistaCliente(cliente), conta: resumoConta(cliente.id) } : null,
      sugestoesCliente: sugestoes,
      condicoes: lerConfig(db),
    });
  });

  // Pedidos anónimos do site público têm de ser associados a um cliente antes da decisão.
  r.post('/pedidos/:id/associar', emTransaccao((req) => {
    const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(idParam(req.params.id));
    if (!p) throw new ErroApi(404, 'Pedido não encontrado.');
    if (p.cliente_id) throw new ErroApi(409, 'Este pedido já está associado a um cliente.');
    if (!['pendente_analise', 'em_analise'].includes(p.estado)) throw new ErroApi(409, 'Este pedido já foi decidido.');
    const clienteId = Number(req.body?.clienteId);
    const c = Number.isInteger(clienteId) ? db.prepare('SELECT id FROM clientes WHERE id = ?').get(clienteId) : null;
    if (!c) throw new ErroApi(400, 'Cliente inválido.');
    db.prepare('UPDATE pedidos SET cliente_id = ?, actualizado_em = ? WHERE id = ?').run(c.id, agora(), p.id);
    auditar(db, req, 'pedido.associado', 'pedido', p.id, { clienteId: c.id });
    notificar(db, c.id, `Pedido ${p.referencia} associado à sua conta`,
      `O pedido enviado pelo site (${p.referencia}, ${p.prazo_dias} dias) está agora visível no seu painel.`);
  }));

  r.post('/pedidos/:id/analise', emTransaccao((req) => colocarEmAnalise(db, req, idParam(req.params.id), req.body ?? {})));
  r.post('/pedidos/:id/aprovar', emTransaccao((req) => ({ creditoId: aprovarPedido(db, req, idParam(req.params.id), req.body ?? {}) })));
  r.post('/pedidos/:id/rejeitar', emTransaccao((req) => rejeitarPedido(db, req, idParam(req.params.id), req.body ?? {})));
  r.post('/pedidos/:id/cancelar', emTransaccao((req) => {
    const p = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(idParam(req.params.id));
    if (!p) throw new ErroApi(404, 'Pedido não encontrado.');
    const v = validador();
    const motivo = v.texto('motivo', req.body?.motivo, { rotulo: 'O motivo', min: 3, max: 500 });
    v.verificar();
    cancelarPedido(db, req, p, motivo);
  }));
  r.post('/pedidos/:id/observacoes', emTransaccao((req) => {
    const id = idParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM pedidos WHERE id = ?').get(id)) throw new ErroApi(404, 'Pedido não encontrado.');
    const v = validador();
    const texto = v.texto('texto', req.body?.texto, { rotulo: 'A observação', min: 2, max: 2000 });
    v.verificar();
    const linha = `[${agora().slice(0, 16).replace('T', ' ')} · ${req.utilizador.nome}] ${texto}`;
    db.prepare(`UPDATE pedidos SET observacoes_internas = CASE WHEN observacoes_internas IS NULL THEN ? ELSE observacoes_internas || char(10) || ? END
                 WHERE id = ?`).run(linha, linha, id);
    auditar(db, req, 'pedido.observacao', 'pedido', id);
  }));

  // ===== Créditos =====
  r.get('/creditos', (req, res) => {
    const estado = Object.keys(ESTADOS_CREDITO).includes(req.query.estado) ? req.query.estado : null;
    const linhas = db.prepare(`SELECT k.*, c.nome_completo FROM creditos k JOIN clientes c ON c.id = k.cliente_id
                                WHERE (? IS NULL OR k.estado = ?) ORDER BY k.id DESC LIMIT 300`).all(estado, estado);
    res.json(linhas.map((k) => ({ ...detalheCredito(db, k, { interno: true }), clienteNome: k.nome_completo })));
  });

  r.get('/creditos/:id', (req, res) => {
    const k = lerCredito(db, idParam(req.params.id));
    const c = db.prepare('SELECT id, nome_completo, telefone FROM clientes WHERE id = ?').get(k.cliente_id);
    res.json({ ...detalheCredito(db, k, { interno: true }), cliente: { id: c.id, nomeCompleto: c.nome_completo, telefone: c.telefone }, metodos: METODOS });
  });

  r.post('/creditos/:id/desembolso', emTransaccao((req) => registarDesembolso(db, req, idParam(req.params.id), req.body ?? {})));
  r.post('/creditos/:id/cancelar', emTransaccao((req) => cancelarCredito(db, req, idParam(req.params.id), req.body ?? {})));
  r.post('/creditos/:id/pagamentos', emTransaccao((req) => ({ pagamentoId: registarPagamento(db, req, idParam(req.params.id), req.body ?? {}) })));
  r.post('/pagamentos/:id/anular', emTransaccao((req) => anularPagamento(db, req, idParam(req.params.id), req.body ?? {})));

  // ===== Recuperação de acesso =====
  r.get('/recuperacoes', (req, res) => {
    res.json(db.prepare(`
      SELECT r.id, r.telefone_informado, r.criado_em, c.id AS cliente_id, c.nome_completo
        FROM pedidos_recuperacao r JOIN utilizadores u ON u.id = r.utilizador_id JOIN clientes c ON c.id = u.cliente_id
       WHERE r.estado = 'pendente' ORDER BY r.id`).all().map((l) => ({
      id: l.id, telefone: l.telefone_informado, criadoEm: l.criado_em, clienteId: l.cliente_id, clienteNome: l.nome_completo,
    })));
  });

  r.post('/recuperacoes/:id/descartar', emTransaccao((req) => {
    const id = idParam(req.params.id);
    const rr = db.prepare("UPDATE pedidos_recuperacao SET estado = 'descartado', tratado_por = ?, tratado_em = ? WHERE id = ? AND estado = 'pendente'")
      .run(req.utilizador.id, agora(), id);
    if (!rr.changes) throw new ErroApi(404, 'Pedido de recuperação não encontrado.');
    auditar(db, req, 'conta.recuperacao_descartada', 'pedido_recuperacao', id);
  }));

  // ===== Configurações (simulador e condições comerciais) =====
  r.get('/config', (req, res) => res.json(lerConfig(db)));

  r.put('/config', emTransaccao((req) => {
    const b = req.body ?? {};
    const v = validador();
    const valorMinimo = v.numero('valorMinimo', b.valorMinimo, { rotulo: 'O valor mínimo', min: 1, max: 1e9 });
    const prazos = [];
    if (!Array.isArray(b.prazos) || b.prazos.length < 1 || b.prazos.length > 10) {
      v.erro('prazos', 'Defina entre 1 e 10 prazos.');
    } else {
      b.prazos.forEach((p, i) => {
        const dias = v.numero(`prazos.${i}.dias`, p?.dias, { rotulo: 'Os dias', inteiro: true, min: 1, max: 365 });
        const percentagem = v.numero(`prazos.${i}.percentagem`, p?.percentagem, { rotulo: 'A percentagem', min: 0, max: 100 });
        if (dias !== null && prazos.some((x) => x.dias === dias)) v.erro(`prazos.${i}.dias`, 'Prazo repetido.');
        prazos.push({ dias, percentagem });
      });
    }
    v.verificar();
    prazos.sort((a, b2) => a.dias - b2.dias);
    const antes = lerConfig(db);
    guardarConfig(db, { valorMinimo, prazos });
    auditar(db, req, 'config.actualizada', 'config', null, { antes, depois: { valorMinimo, prazos } });
    return lerConfig(db);
  }));

  // ===== Auditoria =====
  function vistaAuditoria(a) {
    return {
      id: a.id, accao: a.accao, entidade: a.entidade, entidadeId: a.entidade_id, autor: a.autor ?? (a.papel === 'publico' ? 'Público' : null),
      papel: a.papel, detalhes: a.detalhes ? JSON.parse(a.detalhes) : null, ip: a.ip, criadoEm: a.criado_em,
    };
  }

  r.get('/auditoria', (req, res) => {
    const limite = Math.min(Math.max(Number(req.query.limite) || 100, 1), 500);
    const entidade = typeof req.query.entidade === 'string' && req.query.entidade ? req.query.entidade : null;
    res.json(db.prepare(`SELECT a.*, u.nome AS autor FROM auditoria a LEFT JOIN utilizadores u ON u.id = a.utilizador_id
                          WHERE (? IS NULL OR a.entidade = ?) ORDER BY a.id DESC LIMIT ?`).all(entidade, entidade, limite).map(vistaAuditoria));
  });

  return r;
}

module.exports = { rotasAdmin };
