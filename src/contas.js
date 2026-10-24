'use strict';

const { hashPalavraPasse, verificarPalavraPasse, gerarToken, hashToken } = require('./seguranca');
const { ErroApi, agora, normalizarTelefone, normalizarEmail } = require('./util');

const MAX_TENTATIVAS = 5;
const BLOQUEIO_MINUTOS = 15;
const VALIDADE_HORAS = { activacao: 72, redefinicao: 24 };

// Usada apenas pelo script de linha de comandos: a web nunca cria administradores.
function criarAdministrador(db, { nome, email, telefone, palavraPasse }) {
  const tel = telefone ? normalizarTelefone(telefone) : null;
  const mail = email ? normalizarEmail(email) : null;
  if (!nome || (!tel && !mail)) throw new Error('Indique o nome e um telefone ou email válido.');
  const r = db.prepare(`INSERT INTO utilizadores (nome, telefone, email, palavra_passe_hash, papel, estado, criado_em)
                        VALUES (?, ?, ?, ?, 'admin', 'activo', ?)`)
    .run(nome, tel, mail, hashPalavraPasse(palavraPasse), agora());
  return Number(r.lastInsertRowid);
}

// Procura a conta pelo telefone ou email e verifica a palavra-passe, com bloqueio
// temporário após tentativas falhadas. A mensagem de erro é sempre a mesma.
function autenticar(db, identificador, palavraPasse) {
  const tel = normalizarTelefone(identificador);
  const mail = tel ? null : normalizarEmail(identificador);
  const u = tel || mail
    ? db.prepare(`SELECT * FROM utilizadores WHERE ${tel ? 'telefone' : 'email'} = ?`).get(tel || mail)
    : undefined;

  const valida = verificarPalavraPasse(String(palavraPasse ?? ''), u?.palavra_passe_hash);
  const falha = new ErroApi(401, 'Telefone/email ou palavra-passe incorrectos.');
  if (!u) throw falha;
  if (u.bloqueado_ate && u.bloqueado_ate > agora()) {
    throw new ErroApi(429, 'Conta temporariamente bloqueada após várias tentativas. Tente mais tarde.');
  }
  if (!valida) {
    const tentativas = u.tentativas_falhadas + 1;
    const bloqueio = tentativas >= MAX_TENTATIVAS
      ? new Date(Date.now() + BLOQUEIO_MINUTOS * 60000).toISOString() : null;
    db.prepare('UPDATE utilizadores SET tentativas_falhadas = ?, bloqueado_ate = ? WHERE id = ?')
      .run(bloqueio ? 0 : tentativas, bloqueio, u.id);
    throw falha;
  }
  if (u.estado !== 'activo') {
    throw new ErroApi(403, 'Esta conta não está activa. Contacte a APG.');
  }
  db.prepare('UPDATE utilizadores SET tentativas_falhadas = 0, bloqueado_ate = NULL WHERE id = ?').run(u.id);
  return u;
}

// Gera um link de uso único (activação de conta criada pela APG ou redefinição
// de palavra-passe). Os links anteriores ainda não usados deixam de ser válidos.
function emitirToken(db, utilizadorId, tipo, criadoPor) {
  db.prepare('DELETE FROM tokens_conta WHERE utilizador_id = ? AND usado_em IS NULL').run(utilizadorId);
  const token = gerarToken();
  const expira = new Date(Date.now() + VALIDADE_HORAS[tipo] * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO tokens_conta (utilizador_id, tipo, token_hash, expira_em, criado_por, criado_em)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(utilizadorId, tipo, hashToken(token), expira, criadoPor, agora());
  return { token, expira };
}

function lerTokenValido(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const t = db.prepare(`SELECT t.*, u.nome, u.estado AS estado_conta, u.cliente_id
                          FROM tokens_conta t JOIN utilizadores u ON u.id = t.utilizador_id
                         WHERE t.token_hash = ?`).get(hashToken(token));
  if (!t || t.usado_em || t.expira_em <= agora() || t.estado_conta === 'bloqueado') return null;
  return t;
}

module.exports = { criarAdministrador, autenticar, emitirToken, lerTokenValido };
