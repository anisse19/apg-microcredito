'use strict';

const path = require('node:path');
const { abrirBaseDados, migrar } = require('./src/db');
const { criarApp } = require('./src/app');

const PORTA = Number(process.env.PORT) || 3000;
const BASE_DADOS = process.env.APG_BASE_DADOS || path.join(__dirname, 'data', 'apg.sqlite');
const producao = process.env.NODE_ENV === 'production';

const db = abrirBaseDados(BASE_DADOS);
const novas = migrar(db);
if (novas.length) console.log(`Migrações aplicadas: ${novas.join(', ')}`);

const app = criarApp(db, {
  cookieSeguro: producao,
  urlPublica: process.env.APG_URL_PUBLICA || null,
  trustProxy: process.env.APG_TRUST_PROXY || false,
});

app.listen(PORTA, () => console.log(`APG Microcrédito em http://localhost:${PORTA} (base de dados: ${BASE_DADOS})`));
