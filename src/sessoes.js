'use strict';

const { gerarToken, hashToken } = require('./seguranca');
const { ErroApi, agora } = require('./util');

const COOKIE = 'apg_sessao';
const DURACAO_HORAS = { cliente: 24, admin: 8 };

function lerCookie(req, nome) {
  const cabecalho = req.headers.cookie;
  if (!cabecalho) return null;
  for (const parte of cabecalho.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nome) {
      try { return decodeURIComponent(parte.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function definirCookie(req, res, valor, maxAgeSegundos) {
  const seguro = req.app.locals.opcoes.cookieSeguro;
  const partes = [
    `${COOKIE}=${encodeURIComponent(valor)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSegundos}`,
  ];
  if (seguro) partes.push('Secure');
  res.append('Set-Cookie', partes.join('; '));
}

// Cria uma sessão nova (o identificador anterior, se existir, é descartado).
function iniciarSessao(db, req, res, utilizador) {
  const anterior = lerCookie(req, COOKIE);
  if (anterior) db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(hashToken(anterior));
  const token = gerarToken();
  const horas = DURACAO_HORAS[utilizador.papel];
  const expira = new Date(Date.now() + horas * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO sessoes (token_hash, utilizador_id, criado_em, expira_em, ip, user_agent)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(hashToken(token), utilizador.id, agora(), expira, req.ip, String(req.get('user-agent') || '').slice(0, 200));
  db.prepare('UPDATE utilizadores SET ultimo_acesso = ? WHERE id = ?').run(agora(), utilizador.id);
  definirCookie(req, res, token, horas * 3600);
}

function terminarSessao(db, req, res) {
  const token = lerCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(hashToken(token));
  definirCookie(req, res, '', 0);
}

function terminarTodasSessoes(db, utilizadorId) {
  db.prepare('DELETE FROM sessoes WHERE utilizador_id = ?').run(utilizadorId);
}

// Identifica o utilizador a partir do cookie. O papel e o cliente associado vêm
// sempre da base de dados — nunca de dados enviados pelo navegador.
function carregarSessao(db) {
  const procurar = db.prepare(`
    SELECT u.id, u.nome, u.papel, u.cliente_id AS clienteId, u.estado, s.expira_em
      FROM sessoes s JOIN utilizadores u ON u.id = s.utilizador_id
     WHERE s.token_hash = ?`);
  return function sessao(req, res, next) {
    req.utilizador = null;
    req.sessaoHash = null;
    const token = lerCookie(req, COOKIE);
    if (token) {
      const linha = procurar.get(hashToken(token));
      if (linha && linha.expira_em > agora() && linha.estado === 'activo') {
        req.utilizador = { id: linha.id, nome: linha.nome, papel: linha.papel, clienteId: linha.clienteId };
        req.sessaoHash = hashToken(token);
      } else if (linha) {
        db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(hashToken(token));
      }
    }
    next();
  };
}

function exigirCliente(req, res, next) {
  if (!req.utilizador) return next(new ErroApi(401, 'Inicie sessão para continuar.'));
  if (req.utilizador.papel !== 'cliente' || !req.utilizador.clienteId) {
    return next(new ErroApi(403, 'Esta área é reservada a clientes.'));
  }
  return next();
}

function exigirAdmin(req, res, next) {
  if (!req.utilizador) return next(new ErroApi(401, 'Inicie sessão para continuar.'));
  if (req.utilizador.papel !== 'admin') return next(new ErroApi(403, 'Sem permissão para esta operação.'));
  return next();
}

module.exports = {
  carregarSessao, iniciarSessao, terminarSessao, terminarTodasSessoes, exigirCliente, exigirAdmin,
};
