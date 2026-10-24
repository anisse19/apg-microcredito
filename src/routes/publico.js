'use strict';

const express = require('express');
const { transaccao } = require('../db');
const { lerConfig } = require('../config');
const { criarPedido } = require('../creditos');
const { limitarPedidos } = require('../seguranca');
const { ErroApi, agora, hoje, validador } = require('../util');

const MINUTO = 60 * 1000;
const TIPOS_INTERACAO = ['pedido_iniciado', 'simulacao', 'pedido_enviado'];

// Endpoints usados pelo site público (Fase 2). O contrato mantém-se: mesmos
// caminhos, mesmos campos. O site trata todas as falhas em silêncio.
function rotasPublicas(db) {
  const r = express.Router();

  r.get('/config', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(lerConfig(db));
  });

  r.post('/visita', limitarPedidos('visita', { janelaMs: MINUTO, maximo: 60 }), (req, res) => {
    const { sessaoId, pagina } = req.body ?? {};
    if (typeof sessaoId !== 'string' || !sessaoId || sessaoId.length > 100) throw new ErroApi(400, 'Sessão inválida.');
    const pag = typeof pagina === 'string' && pagina ? pagina.slice(0, 200) : '/';
    db.prepare('INSERT OR IGNORE INTO visitas (sessao_id, pagina, dia, criado_em) VALUES (?, ?, ?, ?)')
      .run(sessaoId, pag, hoje(), agora());
    res.status(204).end();
  });

  r.post('/interacao', limitarPedidos('interacao', { janelaMs: MINUTO, maximo: 120 }), (req, res) => {
    const { tipo, sessaoId } = req.body ?? {};
    if (!TIPOS_INTERACAO.includes(tipo)) throw new ErroApi(400, 'Tipo de interacção inválido.');
    const sessao = typeof sessaoId === 'string' ? sessaoId.slice(0, 100) : null;
    db.prepare('INSERT INTO interacoes (tipo, sessao_id, criado_em) VALUES (?, ?, ?)').run(tipo, sessao, agora());
    res.status(204).end();
  });

  // Pedido enviado pelo modal do site. Se o visitante tiver sessão de cliente,
  // o pedido fica associado à sua conta (identificada pelo servidor, não pelo navegador).
  r.post('/pedidos', limitarPedidos('pedidos', { janelaMs: 10 * MINUTO, maximo: 10 }), (req, res) => {
    const b = req.body ?? {};
    const sessaoCliente = req.utilizador?.papel === 'cliente' ? req.utilizador : null;
    const v = validador();
    let nome; let telefone;
    if (sessaoCliente) {
      const c = db.prepare('SELECT nome_completo, telefone FROM clientes WHERE id = ?').get(sessaoCliente.clienteId);
      nome = c.nome_completo;
      telefone = c.telefone;
    } else {
      nome = v.texto('nome', b.nome, { rotulo: 'O nome', min: 2, max: 120 });
      telefone = v.telefone('telefone', b.telefone);
    }
    v.verificar();

    const { pedido, duplicado } = transaccao(db, () => criarPedido(db, req, {
      nome,
      telefone,
      valor: b.valor,
      prazoDias: b.prazoDias,
      clienteId: sessaoCliente?.clienteId ?? null,
      origem: 'site_publico',
    }));
    res.status(duplicado ? 200 : 201).json({ ok: true, referencia: pedido.referencia, estado: pedido.estado });
  });

  return r;
}

module.exports = { rotasPublicas };
