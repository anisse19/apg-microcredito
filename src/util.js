'use strict';

class ErroApi extends Error {
  constructor(status, mensagem, campos) {
    super(mensagem);
    this.status = status;
    this.campos = campos;
  }
}

const agora = () => new Date().toISOString();
const hoje = () => new Date().toISOString().slice(0, 10);

function somarDias(dataIso, dias) {
  const d = new Date(`${dataIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Números moçambicanos: móveis 8[2-7]xxxxxxx ou fixos 2xxxxxxx, com ou sem +258.
function normalizarTelefone(valor) {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null;
  let d = String(valor).replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (/^258\d{8,9}$/.test(d)) d = d.slice(3);
  return /^(8[2-7]\d{7}|2[1-9]\d{6})$/.test(d) ? d : null;
}

function normalizarEmail(valor) {
  if (typeof valor !== 'string') return null;
  const e = valor.trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(e) ? e : null;
}

const paraCentavos = (mt) => Math.round(Number(mt) * 100);

// Acumula erros por campo e lança um único 400 com todos eles.
function validador() {
  const campos = {};
  const v = {
    campos,
    erro(campo, mensagem) { if (!campos[campo]) campos[campo] = mensagem; return null; },

    texto(campo, valor, { rotulo = campo, min = 1, max = 200, obrigatorio = true } = {}) {
      if (valor === undefined || valor === null || (typeof valor === 'string' && valor.trim() === '')) {
        return obrigatorio ? v.erro(campo, `${rotulo} é obrigatório.`) : null;
      }
      if (typeof valor !== 'string') return v.erro(campo, `${rotulo} é inválido.`);
      const t = valor.trim().replace(/\s+/g, ' ');
      if (t.length < min) return v.erro(campo, `${rotulo} deve ter pelo menos ${min} caracteres.`);
      if (t.length > max) return v.erro(campo, `${rotulo} deve ter no máximo ${max} caracteres.`);
      return t;
    },

    textoLongo(campo, valor, { rotulo = campo, max = 2000 } = {}) {
      if (valor === undefined || valor === null || valor === '') return null;
      if (typeof valor !== 'string') return v.erro(campo, `${rotulo} é inválido.`);
      const t = valor.trim();
      if (t.length > max) return v.erro(campo, `${rotulo} deve ter no máximo ${max} caracteres.`);
      return t || null;
    },

    telefone(campo, valor, { obrigatorio = true } = {}) {
      if ((valor === undefined || valor === null || valor === '') && !obrigatorio) return null;
      return normalizarTelefone(valor) ?? v.erro(campo, 'Indique um número de telefone moçambicano válido (ex.: 84 123 4567).');
    },

    email(campo, valor, { obrigatorio = false } = {}) {
      if (valor === undefined || valor === null || (typeof valor === 'string' && valor.trim() === '')) {
        return obrigatorio ? v.erro(campo, 'O email é obrigatório.') : null;
      }
      return normalizarEmail(valor) ?? v.erro(campo, 'Indique um email válido.');
    },

    numero(campo, valor, { rotulo = campo, min = -Infinity, max = Infinity, inteiro = false } = {}) {
      const n = typeof valor === 'string' && valor.trim() !== '' ? Number(valor) : valor;
      if (typeof n !== 'number' || !Number.isFinite(n)) return v.erro(campo, `${rotulo} deve ser um número.`);
      if (inteiro && !Number.isInteger(n)) return v.erro(campo, `${rotulo} deve ser um número inteiro.`);
      if (n < min) return v.erro(campo, `${rotulo} deve ser pelo menos ${min}.`);
      if (n > max) return v.erro(campo, `${rotulo} deve ser no máximo ${max}.`);
      return n;
    },

    data(campo, valor, { rotulo = campo, obrigatorio = true } = {}) {
      if (valor === undefined || valor === null || valor === '') {
        return obrigatorio ? v.erro(campo, `${rotulo} é obrigatória.`) : null;
      }
      if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)
        || Number.isNaN(Date.parse(`${valor}T00:00:00Z`))
        || new Date(`${valor}T00:00:00Z`).toISOString().slice(0, 10) !== valor) {
        return v.erro(campo, `${rotulo} é inválida.`);
      }
      return valor;
    },

    opcao(campo, valor, opcoes, { rotulo = campo } = {}) {
      return opcoes.includes(valor) ? valor : v.erro(campo, `${rotulo} é inválido.`);
    },

    verificar() {
      if (Object.keys(campos).length) throw new ErroApi(400, 'Verifique os dados indicados.', campos);
    },
  };
  return v;
}

function idParam(valor) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw new ErroApi(404, 'Registo não encontrado.');
  return n;
}

module.exports = {
  ErroApi, agora, hoje, somarDias, normalizarTelefone, normalizarEmail, paraCentavos, validador, idParam,
};
