'use strict';

const path = require('node:path');
const express = require('express');
const { rotasPublicas } = require('./routes/publico');
const { rotasAuth } = require('./routes/auth');
const { rotasCliente } = require('./routes/cliente');
const { rotasAdmin } = require('./routes/admin');
const { cabecalhosSeguranca, exigirCsrf, semCache } = require('./seguranca');
const { carregarSessao, exigirCliente, exigirAdmin } = require('./sessoes');
const { ErroApi } = require('./util');

const PASTA_PUBLICA = path.join(__dirname, '..', 'public');

function criarApp(db, opcoes = {}) {
  const app = express();
  app.locals.opcoes = { cookieSeguro: false, urlPublica: null, limites: {}, ...opcoes };
  app.disable('x-powered-by');
  if (opcoes.trustProxy) app.set('trust proxy', opcoes.trustProxy);

  app.use(cabecalhosSeguranca);
  app.use(express.json({ limit: '20kb' }));
  app.use(carregarSessao(db));

  app.use('/api/auth', exigirCsrf, rotasAuth(db));
  app.use('/api/me', semCache, exigirCsrf, exigirCliente, rotasCliente(db));
  app.use('/api/admin', semCache, exigirCsrf, exigirAdmin, rotasAdmin(db));
  app.use('/api', rotasPublicas(db));
  app.use('/api', (req, res, next) => next(new ErroApi(404, 'Recurso não encontrado.')));

  // Áreas novas servidas pelo mesmo servidor do site.
  app.get('/admin/configuracoes', (req, res) => res.sendFile(path.join(PASTA_PUBLICA, 'admin', 'index.html')));
  app.use(express.static(PASTA_PUBLICA, { extensions: ['html'], index: 'index.html', dotfiles: 'deny' }));

  // eslint-disable-next-line no-unused-vars
  app.use((erro, req, res, next) => {
    if (erro instanceof ErroApi) {
      return res.status(erro.status).json({ erro: erro.message, ...(erro.campos ? { campos: erro.campos } : {}), ...(erro.extra ?? {}) });
    }
    if (erro.type === 'entity.parse.failed') return res.status(400).json({ erro: 'Pedido com formato inválido.' });
    if (erro.type === 'entity.too.large') return res.status(413).json({ erro: 'Pedido demasiado grande.' });
    if (/UNIQUE constraint failed/.test(erro.message)) return res.status(409).json({ erro: 'Já existe um registo com estes dados.' });
    console.error(erro);
    return res.status(500).json({ erro: 'Ocorreu um erro inesperado. Tente novamente.' });
  });

  return app;
}

module.exports = { criarApp };
