'use strict';

const express = require('express');
const { transaccao } = require('../db');
const { auditar } = require('../auditoria');
const { lerConfig } = require('../config');
const {
  ESTADOS_PEDIDO, criarPedido, cancelarPedido, detalheCredito, vistaPedido,
} = require('../creditos');
const { hashPalavraPasse, verificarPalavraPasse, validarPalavraPasse } = require('../seguranca');
const { ErroApi, agora, validador, idParam } = require('../util');

// Área pessoal do cliente. Todas as consultas filtram pelo cliente da sessão
// (req.utilizador.clienteId, lido da base de dados): nenhum identificador de
// cliente enviado pelo navegador é usado. Um registo de outro cliente responde 404.
function rotasCliente(db) {
  const r = express.Router();
  const clienteDe = (req) => req.utilizador.clienteId;

  function perfil(clienteId) {
    const c = db.prepare('SELECT * FROM clientes WHERE id = ?').get(clienteId);
    const u = db.prepare('SELECT criado_em, ultimo_acesso FROM utilizadores WHERE cliente_id = ?').get(clienteId);
    return {
      nomeCompleto: c.nome_completo,
      telefone: c.telefone,
      email: c.email,
      dataNascimento: c.data_nascimento,
      morada: c.morada,
      documentoTipo: c.documento_tipo,
      documentoNumero: c.documento_numero ? `•••${c.documento_numero.slice(-3)}` : null,
      telefoneVerificado: Boolean(c.telefone_verificado),
      clienteDesde: c.criado_em,
      contaCriadaEm: u?.criado_em,
    };
  }

  function operacoes(clienteId, pedidos, creditos) {
    const lista = [];
    for (const p of pedidos) {
      for (const h of p.historico) {
        lista.push({
          data: h.criadoEm,
          tipo: 'pedido',
          descricao: h.estadoAnterior ? `Pedido ${p.referencia}: ${h.estadoRotulo}` : `Pedido ${p.referencia} submetido`,
          nota: h.nota,
        });
      }
    }
    for (const c of creditos) {
      if (c.desembolsadoEm) {
        lista.push({ data: c.desembolsadoEm, tipo: 'desembolso', descricao: `Desembolso do crédito ${c.referencia}`, valorCentavos: c.montanteCentavos });
      }
      for (const pg of c.pagamentos) {
        lista.push({ data: pg.dataPagamento, tipo: 'pagamento', descricao: `Pagamento confirmado — ${c.referencia}`, valorCentavos: pg.valorCentavos });
      }
      if (c.liquidadoEm) lista.push({ data: c.liquidadoEm, tipo: 'liquidacao', descricao: `Crédito ${c.referencia} liquidado` });
    }
    return lista.sort((a, b) => (a.data < b.data ? 1 : -1)).slice(0, 100);
  }

  r.get('/painel', (req, res) => {
    const id = clienteDe(req);
    const pedidos = db.prepare('SELECT * FROM pedidos WHERE cliente_id = ? ORDER BY id DESC').all(id).map((p) => vistaPedido(db, p));
    const creditos = db.prepare('SELECT * FROM creditos WHERE cliente_id = ? ORDER BY id DESC').all(id).map((c) => detalheCredito(db, c));
    const contratados = creditos.filter((c) => ['activo', 'liquidado'].includes(c.estado));
    const activos = creditos.filter((c) => c.estado === 'activo');
    const prestacoesAbertas = activos.flatMap((c) => c.prestacoes.filter((p) => p.estado !== 'paga').map((p) => ({ ...p, credito: c.referencia })));
    const proxima = prestacoesAbertas.sort((a, b) => (a.vencimento < b.vencimento ? -1 : 1))[0] ?? null;
    const notificacoes = db.prepare('SELECT id, titulo, mensagem, lida_em, criado_em FROM notificacoes WHERE cliente_id = ? ORDER BY id DESC LIMIT 30')
      .all(id).map((n) => ({ id: n.id, titulo: n.titulo, mensagem: n.mensagem, lida: Boolean(n.lida_em), criadoEm: n.criado_em }));

    res.json({
      perfil: perfil(id),
      resumo: {
        pedidosEmCurso: pedidos.filter((p) => ['pendente_analise', 'em_analise'].includes(p.estado)).length,
        creditosActivos: activos.length,
        creditosAguardandoDesembolso: creditos.filter((c) => c.estado === 'aguarda_desembolso').length,
        totalContratadoCentavos: contratados.reduce((s, c) => s + c.montanteCentavos, 0),
        totalAReembolsarCentavos: contratados.reduce((s, c) => s + c.totalCentavos, 0),
        totalPagoCentavos: contratados.reduce((s, c) => s + c.pagoCentavos, 0),
        saldoPendenteCentavos: activos.reduce((s, c) => s + c.saldoCentavos, 0),
        prestacoesPagas: contratados.reduce((s, c) => s + c.prestacoes.filter((p) => p.estado === 'paga').length, 0),
        prestacoesPorPagar: prestacoesAbertas.length,
        prestacoesEmAtraso: prestacoesAbertas.filter((p) => p.emAtraso).length,
        proximaPrestacao: proxima && {
          credito: proxima.credito, vencimento: proxima.vencimento, emFaltaCentavos: proxima.emFaltaCentavos, emAtraso: proxima.emAtraso,
        },
      },
      notificacoes,
      notificacoesPorLer: db.prepare('SELECT COUNT(*) AS n FROM notificacoes WHERE cliente_id = ? AND lida_em IS NULL').get(id).n,
      pedidos,
      creditos,
      operacoes: operacoes(id, pedidos, creditos),
      condicoes: lerConfig(db),
      estados: ESTADOS_PEDIDO,
    });
  });

  r.get('/pedidos/:id', (req, res) => {
    const p = db.prepare('SELECT * FROM pedidos WHERE id = ? AND cliente_id = ?').get(idParam(req.params.id), clienteDe(req));
    if (!p) throw new ErroApi(404, 'Pedido não encontrado.');
    res.json(vistaPedido(db, p));
  });

  // Só os campos do pedido são lidos; estado, cliente, percentagem ou decisão
  // enviados pelo navegador são ignorados.
  r.post('/pedidos', (req, res) => {
    const b = req.body ?? {};
    const id = clienteDe(req);
    const { pedido, duplicado } = transaccao(db, () => {
      const c = db.prepare('SELECT nome_completo, telefone FROM clientes WHERE id = ?').get(id);
      return criarPedido(db, req, {
        nome: c.nome_completo,
        telefone: c.telefone,
        valor: b.valor,
        prazoDias: b.prazoDias,
        finalidade: b.finalidade,
        informacoes: b.informacoes,
        chaveIdempotencia: b.chaveIdempotencia,
        clienteId: id,
        origem: 'painel_cliente',
      });
    });
    res.status(duplicado ? 200 : 201).json({ duplicado, pedido: vistaPedido(db, pedido) });
  });

  r.post('/pedidos/:id/cancelar', (req, res) => {
    const pedidoId = idParam(req.params.id);
    transaccao(db, () => {
      const p = db.prepare('SELECT * FROM pedidos WHERE id = ? AND cliente_id = ?').get(pedidoId, clienteDe(req));
      if (!p) throw new ErroApi(404, 'Pedido não encontrado.');
      if (p.estado !== 'pendente_analise') throw new ErroApi(409, 'Só pode cancelar pedidos que ainda estão pendentes de análise.');
      cancelarPedido(db, req, p, 'Cancelado pelo cliente.');
    });
    res.json({ ok: true });
  });

  r.get('/creditos/:id', (req, res) => {
    const c = db.prepare('SELECT * FROM creditos WHERE id = ? AND cliente_id = ?').get(idParam(req.params.id), clienteDe(req));
    if (!c) throw new ErroApi(404, 'Crédito não encontrado.');
    res.json(detalheCredito(db, c));
  });

  r.post('/notificacoes/lidas', (req, res) => {
    db.prepare('UPDATE notificacoes SET lida_em = ? WHERE cliente_id = ? AND lida_em IS NULL').run(agora(), clienteDe(req));
    res.json({ ok: true });
  });

  r.post('/palavra-passe', (req, res) => {
    const { actual, nova } = req.body ?? {};
    const v = validador();
    validarPalavraPasse(v, 'nova', nova);
    v.verificar();
    const u = db.prepare('SELECT id, palavra_passe_hash FROM utilizadores WHERE id = ?').get(req.utilizador.id);
    if (!verificarPalavraPasse(String(actual ?? ''), u.palavra_passe_hash)) {
      throw new ErroApi(400, 'A palavra-passe actual não está correcta.', { actual: 'Palavra-passe incorrecta.' });
    }
    db.prepare('UPDATE utilizadores SET palavra_passe_hash = ? WHERE id = ?').run(hashPalavraPasse(nova), u.id);
    // Termina as outras sessões abertas desta conta.
    db.prepare('DELETE FROM sessoes WHERE utilizador_id = ? AND token_hash <> ?').run(u.id, req.sessaoHash);
    auditar(db, req, 'conta.palavra_passe_alterada', 'utilizador', u.id);
    res.json({ ok: true });
  });

  return r;
}

module.exports = { rotasCliente };
