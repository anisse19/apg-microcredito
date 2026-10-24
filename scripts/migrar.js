'use strict';

// Aplica as migrações em falta. Faça uma cópia da base de dados antes de correr em produção.
const path = require('node:path');
const { abrirBaseDados, migrar } = require('../src/db');

const ficheiro = process.env.APG_BASE_DADOS || path.join(__dirname, '..', 'data', 'apg.sqlite');
const novas = migrar(abrirBaseDados(ficheiro));
console.log(novas.length ? `Aplicadas: ${novas.join(', ')}` : 'A base de dados já está actualizada.');
