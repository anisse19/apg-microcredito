'use strict';

// Arranca o servidor sobre uma base de dados de teste (em memória por omissão).
// Nunca toca em data/apg.sqlite.
const { abrirBaseDados, migrar } = require('../src/db');
const { criarApp } = require('../src/app');
const { criarAdministrador } = require('../src/contas');

const LIMITES_ALTOS = Object.fromEntries(
  ['registar', 'entrar', 'recuperar', 'token', 'visita', 'interacao', 'pedidos'].map((n) => [n, 10000]),
);

async function iniciarServidor({ ficheiro = ':memory:', db: dbExistente, limites = LIMITES_ALTOS } = {}) {
  const db = dbExistente ?? abrirBaseDados(ficheiro);
  migrar(db);
  const app = criarApp(db, { limites });
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${servidor.address().port}`;
  return { db, url, fechar: () => new Promise((resolve) => servidor.close(resolve)) };
}

// Navegador simulado: guarda o cookie de sessão entre pedidos.
class Navegador {
  constructor(url) { this.url = url; this.cookie = null; }

  async pedido(metodo, caminho, corpo, { csrf = true, cabecalhos = {} } = {}) {
    const headers = { 'Content-Type': 'application/json', ...cabecalhos };
    if (csrf) headers['X-APG-Pedido'] = '1';
    if (this.cookie) headers.Cookie = this.cookie;
    const r = await fetch(`${this.url}${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    for (const c of r.headers.getSetCookie()) {
      const [par] = c.split(';');
      if (!par.startsWith('apg_sessao=')) continue;
      this.cookie = /Max-Age=0/.test(c) ? null : par;
    }
    const texto = await r.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch { json = texto; }
    return { status: r.status, corpo: json, headers: r.headers };
  }

  get(c, o) { return this.pedido('GET', c, undefined, o); }
  post(c, b, o) { return this.pedido('POST', c, b, o); }
  put(c, b, o) { return this.pedido('PUT', c, b, o); }
}

function criarAdmin(db, n = 1) {
  const email = `admin${n}@apg.test`;
  criarAdministrador(db, { nome: `Administrador ${n}`, email, palavraPasse: 'Admin-teste-123' });
  return { identificador: email, palavraPasse: 'Admin-teste-123' };
}

module.exports = { iniciarServidor, Navegador, criarAdmin, LIMITES_ALTOS };
