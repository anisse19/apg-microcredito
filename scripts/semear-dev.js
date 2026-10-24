'use strict';

// Cria dados de demonstração numa base de dados de DESENVOLVIMENTO (data/dev.sqlite).
// Recusa correr sobre qualquer outro ficheiro. Credenciais apenas para teste local:
//   admin:   admin@apg.test / Admin-dev-123
//   cliente: 840000001     / Cliente-dev-123
const fs = require('node:fs');
const path = require('node:path');
const { abrirBaseDados, migrar } = require('../src/db');
const { criarApp } = require('../src/app');
const { criarAdministrador } = require('../src/contas');
const { Navegador, LIMITES_ALTOS } = require('../test/ajuda');
const { hoje } = require('../src/util');

const FICHEIRO = path.join(__dirname, '..', 'data', 'dev.sqlite');

async function principal() {
  for (const sufixo of ['', '-wal', '-shm']) fs.rmSync(FICHEIRO + sufixo, { force: true });
  const db = abrirBaseDados(FICHEIRO);
  migrar(db);
  criarAdministrador(db, { nome: 'Admin Desenvolvimento', email: 'admin@apg.test', palavraPasse: 'Admin-dev-123' });

  const servidor = criarApp(db, { limites: LIMITES_ALTOS }).listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  const url = `http://127.0.0.1:${servidor.address().port}`;
  const admin = new Navegador(url);
  const cliente = new Navegador(url);
  const ok = (r) => { if (r.status >= 400) throw new Error(JSON.stringify(r.corpo)); return r.corpo; };

  ok(await admin.post('/api/auth/entrar', { identificador: 'admin@apg.test', palavraPasse: 'Admin-dev-123' }));
  ok(await cliente.post('/api/auth/registar', {
    nomeCompleto: 'Ana Maria Machava', telefone: '840000001', email: 'ana@apg.test', palavraPasse: 'Cliente-dev-123', aceitaCondicoes: true,
  }));
  const p1 = ok(await cliente.post('/api/me/pedidos', { valor: 5000, prazoDias: 30, finalidade: 'Reforço de stock da banca', chaveIdempotencia: 'semente-0001' })).pedido;
  const credito = ok(await admin.post(`/api/admin/pedidos/${p1.id}/aprovar`, { montante: 5000, prazoDias: 30, numeroPrestacoes: 2, motivo: 'Bem-vinda à APG.' })).creditoId;
  ok(await admin.post(`/api/admin/creditos/${credito}/desembolso`, { data: hoje(), metodo: 'mpesa', referencia: 'MP-DEMO-1', contratoAssinado: true, identidadeVerificada: true }));
  ok(await admin.post(`/api/admin/creditos/${credito}/pagamentos`, { valor: 3250, data: hoje(), metodo: 'mpesa', referencia: 'MP-DEMO-2' }));
  ok(await cliente.post('/api/me/pedidos', { valor: 3000, prazoDias: 7, chaveIdempotencia: 'semente-0002' }));

  ok(await admin.post('/api/admin/clientes', { nomeCompleto: 'Bruno Carlos Sitoe', telefone: '820000002', documentoTipo: 'BI', documentoNumero: '110100000002B' }));
  ok(await new Navegador(url).post('/api/pedidos', { nome: 'Carla Nhantumbo', telefone: '860000003', valor: 4000, prazoDias: 15 }));

  servidor.close();
  db.close();
  console.log(`Dados de demonstração criados em ${FICHEIRO}`);
}

principal().catch((e) => { console.error(e); process.exit(1); });
