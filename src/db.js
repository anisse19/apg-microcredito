'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const PASTA_MIGRACOES = path.join(__dirname, 'migrations');

function abrirBaseDados(ficheiro) {
  if (ficheiro !== ':memory:') fs.mkdirSync(path.dirname(ficheiro), { recursive: true });
  const db = new DatabaseSync(ficheiro);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (ficheiro !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

function listarMigracoes() {
  return fs.readdirSync(PASTA_MIGRACOES)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ versao: parseInt(f, 10), nome: f }));
}

// Aplica, por ordem e cada uma na sua transacção, as migrações ainda não aplicadas.
// `ate` limita a versão máxima (usado nos testes para simular uma base antiga).
function migrar(db, { ate } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migracoes (
    versao     INTEGER PRIMARY KEY,
    nome       TEXT NOT NULL,
    aplicada_em TEXT NOT NULL
  )`);
  const aplicadas = new Set(db.prepare('SELECT versao FROM schema_migracoes').all().map((r) => r.versao));
  const novas = [];
  for (const { versao, nome } of listarMigracoes()) {
    if (aplicadas.has(versao) || (ate && versao > ate)) continue;
    const sql = fs.readFileSync(path.join(PASTA_MIGRACOES, nome), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migracoes (versao, nome, aplicada_em) VALUES (?, ?, ?)')
        .run(versao, nome, new Date().toISOString());
      db.exec('COMMIT');
      novas.push(nome);
    } catch (erro) {
      db.exec('ROLLBACK');
      throw new Error(`Falha na migração ${nome}: ${erro.message}`);
    }
  }
  return novas;
}

function transaccao(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const resultado = fn();
    db.exec('COMMIT');
    return resultado;
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
}

module.exports = { abrirBaseDados, migrar, transaccao };
