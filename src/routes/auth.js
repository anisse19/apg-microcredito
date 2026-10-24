'use strict';

const express = require('express');
const { transaccao } = require('../db');
const { auditar, notificar } = require('../auditoria');
const { autenticar, lerTokenValido } = require('../contas');
const { hashPalavraPasse, validarPalavraPasse, limitarPedidos } = require('../seguranca');
const { iniciarSessao, terminarSessao, terminarTodasSessoes } = require('../sessoes');
const { ErroApi, agora, validador, normalizarTelefone } = require('../util');

const QUINZE_MIN = 15 * 60 * 1000;

const resumoUtilizador = (u) => ({ nome: u.nome, papel: u.papel });

function rotasAuth(db) {
  const r = express.Router();

  // ===== Auto-registo =====
  // Cria sempre uma conta de cliente: o papel nunca é lido do pedido.
  r.post('/registar', limitarPedidos('registar', { janelaMs: QUINZE_MIN, maximo: 10 }), (req, res) => {
    const b = req.body ?? {};
    const v = validador();
    const nome = v.texto('nomeCompleto', b.nomeCompleto, { rotulo: 'O nome completo', min: 5, max: 120 });
    if (nome && nome.split(' ').length < 2) v.erro('nomeCompleto', 'Indique o nome e o apelido.');
    const telefone = v.telefone('telefone', b.telefone);
    const email = v.email('email', b.email);
    validarPalavraPasse(v, 'palavraPasse', b.palavraPasse);
    if (b.aceitaCondicoes !== true) {
      v.erro('aceitaCondicoes', 'Confirme que compreende que criar conta não significa aprovação de crédito.');
    }
    v.verificar();

    const hash = hashPalavraPasse(b.palavraPasse);
    const duplicado = new ErroApi(409,
      'Já existe um registo com estes dados. Se já tem conta, entre ou recupere o acesso. '
      + 'Se o seu cadastro foi feito pela APG, peça à APG o link de activação.');

    const utilizador = transaccao(db, () => {
      const existe = db.prepare(`
        SELECT 1 FROM clientes WHERE telefone = ? OR (? IS NOT NULL AND email = ?)
        UNION ALL
        SELECT 1 FROM utilizadores WHERE telefone = ? OR (? IS NOT NULL AND email = ?)`)
        .get(telefone, email, email, telefone, email, email);
      if (existe) throw duplicado;

      const t = agora();
      const cliente = db.prepare(`INSERT INTO clientes (nome_completo, telefone, email, origem, criado_em, actualizado_em)
                                  VALUES (?, ?, ?, 'auto_registo', ?, ?)`).run(nome, telefone, email, t, t);
      const clienteId = Number(cliente.lastInsertRowid);
      const u = db.prepare(`INSERT INTO utilizadores (cliente_id, nome, telefone, email, palavra_passe_hash, papel, estado, criado_em)
                            VALUES (?, ?, ?, ?, ?, 'cliente', 'activo', ?)`).run(clienteId, nome, telefone, email, hash, t);
      const conta = { id: Number(u.lastInsertRowid), nome, papel: 'cliente', clienteId };
      req.utilizador = conta;
      auditar(db, req, 'conta.auto_registo', 'cliente', clienteId, { telefone, email });
      notificar(db, clienteId, 'Bem-vindo à APG',
        'A sua conta foi criada. Pode simular e solicitar crédito a partir do seu painel. '
        + 'Criar conta não significa aprovação de crédito: cada pedido é analisado pela APG.');
      return conta;
    });

    iniciarSessao(db, req, res, utilizador);
    res.status(201).json({ utilizador: resumoUtilizador(utilizador) });
  });

  // ===== Sessão =====
  r.post('/entrar', limitarPedidos('entrar', { janelaMs: QUINZE_MIN, maximo: 20 }), (req, res) => {
    const { identificador, palavraPasse } = req.body ?? {};
    if (typeof identificador !== 'string' || typeof palavraPasse !== 'string' || !identificador || !palavraPasse) {
      throw new ErroApi(400, 'Indique o telefone (ou email) e a palavra-passe.');
    }
    const u = autenticar(db, identificador.slice(0, 200), palavraPasse.slice(0, 200));
    iniciarSessao(db, req, res, u);
    req.utilizador = { id: u.id, papel: u.papel };
    auditar(db, req, 'sessao.inicio', 'utilizador', u.id);
    res.json({ utilizador: resumoUtilizador(u) });
  });

  r.post('/sair', (req, res) => {
    if (req.utilizador) auditar(db, req, 'sessao.fim', 'utilizador', req.utilizador.id);
    terminarSessao(db, req, res);
    res.status(204).end();
  });

  r.get('/sessao', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(req.utilizador
      ? { autenticado: true, utilizador: resumoUtilizador(req.utilizador) }
      : { autenticado: false });
  });

  // ===== Recuperação de acesso =====
  // Sem integração de SMS/email: o pedido fica registado para a APG, que confirma
  // a identidade do cliente e lhe entrega um link de redefinição de uso único.
  // A resposta é sempre igual, exista ou não uma conta com esse número.
  r.post('/recuperar', limitarPedidos('recuperar', { janelaMs: QUINZE_MIN, maximo: 5 }), (req, res) => {
    const telefone = normalizarTelefone(req.body?.telefone);
    if (!telefone) throw new ErroApi(400, 'Indique um número de telefone válido.', { telefone: 'Número inválido.' });
    const u = db.prepare("SELECT id FROM utilizadores WHERE telefone = ? AND papel = 'cliente' AND estado = 'activo'").get(telefone);
    if (u) {
      const pendente = db.prepare("SELECT 1 FROM pedidos_recuperacao WHERE utilizador_id = ? AND estado = 'pendente'").get(u.id);
      if (!pendente) {
        const p = db.prepare('INSERT INTO pedidos_recuperacao (telefone_informado, utilizador_id, criado_em) VALUES (?, ?, ?)')
          .run(telefone, u.id, agora());
        auditar(db, req, 'conta.recuperacao_pedida', 'pedido_recuperacao', Number(p.lastInsertRowid));
      }
    }
    res.status(202).json({
      mensagem: 'Se existir uma conta com este número, a APG vai contactá-lo para confirmar a sua identidade '
        + 'e enviar-lhe um link seguro para definir uma nova palavra-passe.',
    });
  });

  // ===== Links de activação / redefinição =====
  r.post('/token', limitarPedidos('token', { janelaMs: QUINZE_MIN, maximo: 30 }), (req, res) => {
    const t = lerTokenValido(db, req.body?.token);
    if (!t) throw new ErroApi(404, 'Este link é inválido ou já expirou. Peça um novo link à APG.');
    res.json({ tipo: t.tipo, nome: t.nome.split(' ')[0] });
  });

  r.post('/definir-palavra-passe', limitarPedidos('token', { janelaMs: QUINZE_MIN, maximo: 30 }), (req, res) => {
    const { token, palavraPasse } = req.body ?? {};
    const v = validador();
    validarPalavraPasse(v, 'palavraPasse', palavraPasse);
    v.verificar();

    const u = transaccao(db, () => {
      const t = lerTokenValido(db, token);
      if (!t) throw new ErroApi(404, 'Este link é inválido ou já expirou. Peça um novo link à APG.');
      db.prepare(`UPDATE utilizadores SET palavra_passe_hash = ?, estado = 'activo', tentativas_falhadas = 0, bloqueado_ate = NULL
                   WHERE id = ?`).run(hashPalavraPasse(palavraPasse), t.utilizador_id);
      db.prepare('UPDATE tokens_conta SET usado_em = ? WHERE id = ?').run(agora(), t.id);
      terminarTodasSessoes(db, t.utilizador_id);
      const conta = db.prepare('SELECT id, nome, papel, cliente_id AS clienteId FROM utilizadores WHERE id = ?').get(t.utilizador_id);
      req.utilizador = conta;
      auditar(db, req, t.tipo === 'activacao' ? 'conta.activada' : 'conta.palavra_passe_redefinida', 'utilizador', conta.id);
      if (t.tipo === 'activacao' && conta.clienteId) {
        notificar(db, conta.clienteId, 'Conta activada', 'A sua conta APG está activa. Já pode acompanhar aqui os seus pedidos e créditos.');
      }
      return conta;
    });

    iniciarSessao(db, req, res, u);
    res.json({ utilizador: resumoUtilizador(u) });
  });

  return r;
}

module.exports = { rotasAuth };
