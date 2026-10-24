'use strict';

// Cria uma conta de administrador. É a única forma de obter permissões
// administrativas: o website nunca cria nem promove administradores.
//
//   npm run criar-admin -- --nome "Nome Apelido" --email admin@apg.co.mz [--telefone 84xxxxxxx]
//
// A palavra-passe é pedida no terminal (ou lida de APG_ADMIN_PALAVRA_PASSE).

const path = require('node:path');
const readline = require('node:readline');
const { parseArgs } = require('node:util');
const { abrirBaseDados, migrar } = require('../src/db');
const { criarAdministrador } = require('../src/contas');
const { validarPalavraPasse } = require('../src/seguranca');
const { validador } = require('../src/util');

function perguntarEscondido(pergunta) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = false;
    rl._writeToOutput = (s) => { if (!rl.stdoutMuted) rl.output.write(s); };
    rl.question(pergunta, (resposta) => { rl.close(); process.stdout.write('\n'); resolve(resposta); });
    rl.stdoutMuted = true;
  });
}

async function principal() {
  const { values } = parseArgs({ options: { nome: { type: 'string' }, email: { type: 'string' }, telefone: { type: 'string' } } });
  if (!values.nome || (!values.email && !values.telefone)) {
    console.error('Uso: npm run criar-admin -- --nome "Nome" --email email@exemplo [--telefone 84xxxxxxx]');
    process.exit(1);
  }
  let palavraPasse = process.env.APG_ADMIN_PALAVRA_PASSE;
  if (!palavraPasse) {
    palavraPasse = await perguntarEscondido('Palavra-passe: ');
    if (palavraPasse !== await perguntarEscondido('Repita a palavra-passe: ')) {
      console.error('As palavras-passe não coincidem.');
      process.exit(1);
    }
  }
  const v = validador();
  validarPalavraPasse(v, 'palavraPasse', palavraPasse);
  if (v.campos.palavraPasse) { console.error(v.campos.palavraPasse); process.exit(1); }

  const db = abrirBaseDados(process.env.APG_BASE_DADOS || path.join(__dirname, '..', 'data', 'apg.sqlite'));
  migrar(db);
  const id = criarAdministrador(db, { ...values, palavraPasse });
  console.log(`Administrador criado (id ${id}).`);
}

principal().catch((e) => { console.error(e.message); process.exit(1); });
