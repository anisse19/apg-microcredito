'use strict';

const crypto = require('node:crypto');
const { ErroApi } = require('./util');

// ===== Palavras-passe (scrypt) =====
const SCRYPT = { N: 16384, r: 8, p: 1, tamanho: 64 };

function hashPalavraPasse(palavraPasse) {
  const sal = crypto.randomBytes(16);
  const chave = crypto.scryptSync(palavraPasse, sal, SCRYPT.tamanho, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, sal.toString('base64'), chave.toString('base64')].join('$');
}

// Hash descartável usado quando a conta não existe, para que o tempo de resposta
// não revele se um telefone ou email está registado.
const HASH_FICTICIO = hashPalavraPasse(crypto.randomBytes(16).toString('hex'));

function verificarPalavraPasse(palavraPasse, guardado) {
  const partes = String(guardado || HASH_FICTICIO).split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;
  const [, N, r, p, sal, chave] = partes;
  const esperado = Buffer.from(chave, 'base64');
  const obtido = crypto.scryptSync(String(palavraPasse), Buffer.from(sal, 'base64'), esperado.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(esperado, obtido) && Boolean(guardado);
}

function validarPalavraPasse(v, campo, valor) {
  if (typeof valor !== 'string' || valor.length < 8) {
    return v.erro(campo, 'A palavra-passe deve ter pelo menos 8 caracteres.');
  }
  if (valor.length > 128) return v.erro(campo, 'A palavra-passe deve ter no máximo 128 caracteres.');
  if (!/[A-Za-zÀ-ÿ]/.test(valor) || !/\d/.test(valor)) {
    return v.erro(campo, 'A palavra-passe deve combinar letras e números.');
  }
  return valor;
}

// ===== Tokens (sessões, convites, redefinições) =====
const gerarToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// ===== Limite de tentativas por IP (em memória) =====
function limitarPedidos(nome, { janelaMs, maximo }) {
  const contagens = new Map();
  return function limitador(req, res, next) {
    const limite = req.app.locals.opcoes.limites?.[nome] ?? maximo;
    const instante = Date.now();
    const chave = req.ip;
    let entrada = contagens.get(chave);
    if (!entrada || entrada.reinicio <= instante) {
      entrada = { n: 0, reinicio: instante + janelaMs };
      contagens.set(chave, entrada);
      if (contagens.size > 10000) {
        for (const [k, e] of contagens) if (e.reinicio <= instante) contagens.delete(k);
      }
    }
    entrada.n += 1;
    if (entrada.n > limite) {
      res.set('Retry-After', String(Math.ceil((entrada.reinicio - instante) / 1000)));
      return next(new ErroApi(429, 'Demasiadas tentativas. Aguarde alguns minutos e tente novamente.'));
    }
    return next();
  };
}

// ===== Protecção CSRF =====
// As rotas autenticadas que alteram dados exigem um cabeçalho próprio. Um site
// de terceiros não o consegue enviar sem um preflight CORS, que nunca é autorizado.
// O Origin, quando presente, tem de coincidir com o anfitrião.
const CABECALHO_CSRF = 'x-apg-pedido';

function exigirCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get(CABECALHO_CSRF) !== '1') return next(new ErroApi(403, 'Pedido recusado.'));
  const origem = req.get('origin');
  if (origem) {
    let host;
    try { host = new URL(origem).host; } catch { host = null; }
    if (host !== req.get('host')) return next(new ErroApi(403, 'Pedido recusado.'));
  }
  return next();
}

// ===== Cabeçalhos =====
const CSP_AREAS = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function cabecalhosSeguranca(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  // As novas áreas (conta e administração) não usam scripts nem estilos inline.
  if (/^\/(conta|admin)(\/|$)/.test(req.path)) {
    res.set('Content-Security-Policy', CSP_AREAS);
    res.set('Cache-Control', 'no-store');
  }
  next();
}

function semCache(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

module.exports = {
  hashPalavraPasse, verificarPalavraPasse, validarPalavraPasse, gerarToken, hashToken,
  limitarPedidos, exigirCsrf, cabecalhosSeguranca, semCache, CABECALHO_CSRF,
};
