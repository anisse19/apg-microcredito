'use strict';

const { agora } = require('./util');

// Condições comerciais (valor mínimo e prazos/percentagens) geridas no painel administrativo.
function lerConfig(db) {
  const linhas = db.prepare("SELECT chave, valor FROM config WHERE chave IN ('valorMinimo', 'prazos')").all();
  const cfg = Object.fromEntries(linhas.map((l) => [l.chave, JSON.parse(l.valor)]));
  return {
    valorMinimo: Number(cfg.valorMinimo ?? 3000),
    prazos: (cfg.prazos ?? []).map((p) => ({ dias: Number(p.dias), percentagem: Number(p.percentagem) })),
  };
}

function guardarConfig(db, { valorMinimo, prazos }) {
  const gravar = db.prepare(`INSERT INTO config (chave, valor, actualizado_em) VALUES (?, ?, ?)
                             ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor, actualizado_em = excluded.actualizado_em`);
  gravar.run('valorMinimo', JSON.stringify(valorMinimo), agora());
  gravar.run('prazos', JSON.stringify(prazos), agora());
}

const percentagemDoPrazo = (cfg, dias) => cfg.prazos.find((p) => p.dias === dias)?.percentagem;

module.exports = { lerConfig, guardarConfig, percentagemDoPrazo };
