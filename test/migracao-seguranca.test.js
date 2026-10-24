'use strict';

// Migração sobre uma base com dados da Fase 2, recuperação de acesso e limites de tentativas.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBaseDados, migrar } = require('../src/db');
const { iniciarServidor, Navegador, criarAdmin } = require('./ajuda');

describe('Migração', () => {
  it('preserva os dados existentes da Fase 2 e é idempotente', () => {
    const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'apg-teste-'));
    const ficheiro = path.join(pasta, 'fase2.sqlite');
    try {
      const db = abrirBaseDados(ficheiro);
      migrar(db, { ate: 1 });
      db.prepare("INSERT INTO pedidos (nome, telefone, valor, prazo_dias, criado_em) VALUES ('Dina', '841110000', 3000, 7, '2026-05-02T09:00:00Z')").run();
      db.prepare("INSERT INTO pedidos (nome, telefone, valor, prazo_dias, criado_em) VALUES ('Eva', '842220000', 8000, 30, '2026-06-10T15:30:00Z')").run();
      db.prepare("INSERT INTO visitas (sessao_id, pagina, dia, criado_em) VALUES ('s1', '/', '2026-05-02', '2026-05-02T09:00:00Z')").run();
      db.prepare("INSERT INTO interacoes (tipo, sessao_id, criado_em) VALUES ('simulacao', 's1', '2026-05-02T09:01:00Z')").run();
      db.prepare("UPDATE config SET valor = '4000' WHERE chave = 'valorMinimo'").run();
      db.close();

      const db2 = abrirBaseDados(ficheiro);
      assert.deepEqual(migrar(db2), ['002_clientes_creditos.sql']);
      assert.deepEqual(migrar(db2), [], 'segunda execução não faz nada');
      const pedidos = db2.prepare('SELECT nome, telefone, valor, prazo_dias, criado_em, referencia, estado, percentagem FROM pedidos ORDER BY id').all();
      assert.deepEqual(pedidos.map((p) => ({ ...p })), [
        { nome: 'Dina', telefone: '841110000', valor: 3000, prazo_dias: 7, criado_em: '2026-05-02T09:00:00Z', referencia: 'APG-2026-000001', estado: 'pendente_analise', percentagem: 15 },
        { nome: 'Eva', telefone: '842220000', valor: 8000, prazo_dias: 30, criado_em: '2026-06-10T15:30:00Z', referencia: 'APG-2026-000002', estado: 'pendente_analise', percentagem: 30 },
      ]);
      assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM pedido_historico').get().n, 2);
      assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM visitas').get().n, 1);
      assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM interacoes').get().n, 1);
      assert.equal(db2.prepare("SELECT valor FROM config WHERE chave = 'valorMinimo'").get().valor, '4000', 'configuração existente mantida');
      db2.close();
    } finally {
      fs.rmSync(pasta, { recursive: true, force: true });
    }
  });
});

describe('Segurança da conta', () => {
  it('recuperação de acesso: resposta igual exista ou não a conta; link emitido pela APG', async () => {
    const srv = await iniciarServidor();
    try {
      const admin = new Navegador(srv.url);
      await admin.post('/api/auth/entrar', criarAdmin(srv.db));
      const cli = new Navegador(srv.url);
      await cli.post('/api/auth/registar', { nomeCompleto: 'Fátima Cossa', telefone: '845556666', palavraPasse: 'antiga-123', aceitaCondicoes: true });

      const existe = await new Navegador(srv.url).post('/api/auth/recuperar', { telefone: '845556666' });
      const naoExiste = await new Navegador(srv.url).post('/api/auth/recuperar', { telefone: '845550001' });
      assert.equal(existe.status, 202);
      assert.deepEqual(existe.corpo, naoExiste.corpo);

      const pendentes = (await admin.get('/api/admin/recuperacoes')).corpo;
      assert.equal(pendentes.length, 1);
      const link = await admin.post(`/api/admin/clientes/${pendentes[0].clienteId}/link-acesso`);
      assert.equal(link.corpo.tipo, 'redefinicao');
      assert.equal((await admin.get('/api/admin/recuperacoes')).corpo.length, 0, 'pedido marcado como tratado');

      const token = new URL(link.corpo.link).hash.replace('#t=', '');
      assert.equal((await new Navegador(srv.url).post('/api/auth/definir-palavra-passe', { token, palavraPasse: 'nova-pass-456' })).status, 200);
      assert.equal((await cli.get('/api/me/painel')).status, 401, 'sessões antigas terminadas');
      assert.equal((await new Navegador(srv.url).post('/api/auth/entrar', { identificador: '845556666', palavraPasse: 'antiga-123' })).status, 401);
      assert.equal((await new Navegador(srv.url).post('/api/auth/entrar', { identificador: '845556666', palavraPasse: 'nova-pass-456' })).status, 200);
    } finally {
      await srv.fechar();
    }
  });

  it('bloqueia a conta após 5 tentativas falhadas e limita pedidos por IP', async () => {
    const srv = await iniciarServidor({ limites: { entrar: 7, registar: 10000 } });
    try {
      const nav = new Navegador(srv.url);
      await nav.post('/api/auth/registar', { nomeCompleto: 'Gil Matsinhe', telefone: '846667777', palavraPasse: 'certa-123', aceitaCondicoes: true });
      for (let i = 0; i < 5; i += 1) {
        assert.equal((await new Navegador(srv.url).post('/api/auth/entrar', { identificador: '846667777', palavraPasse: 'errada' })).status, 401);
      }
      assert.equal((await new Navegador(srv.url).post('/api/auth/entrar', { identificador: '846667777', palavraPasse: 'certa-123' })).status, 429, 'conta bloqueada temporariamente');
      assert.equal((await new Navegador(srv.url).post('/api/auth/entrar', { identificador: '846667777', palavraPasse: 'certa-123' })).status, 429);
      const r = await new Navegador(srv.url).post('/api/auth/entrar', { identificador: 'x@y.co', palavraPasse: 'z' });
      assert.equal(r.status, 429, 'limite por IP');
      assert.ok(r.headers.get('retry-after'));
    } finally {
      await srv.fechar();
    }
  });

  it('cabeçalhos de segurança nas áreas novas e site público servido sem alterações de comportamento', async () => {
    const srv = await iniciarServidor();
    try {
      const conta = await fetch(`${srv.url}/conta/entrar`);
      assert.equal(conta.status, 200);
      assert.match(conta.headers.get('content-security-policy'), /script-src 'self'/);
      assert.equal(conta.headers.get('x-frame-options'), 'DENY');
      const admin = await fetch(`${srv.url}/admin/configuracoes`);
      assert.equal(admin.status, 200);
      const site = await fetch(`${srv.url}/`);
      const html = await site.text();
      assert.match(html, /id="simAmount" value="3000" min="3000"/);
      assert.match(html, /wa\.me\/258876463030/);
      assert.match(html, /href="\/conta\/entrar"/);
      assert.equal((await fetch(`${srv.url}/../data/apg.sqlite`)).status, 404);
      assert.equal((await fetch(`${srv.url}/api/nao-existe`)).status, 404);
    } finally {
      await srv.fechar();
    }
  });
});
