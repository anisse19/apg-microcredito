'use strict';

const { agora } = require('./util');

// Regista uma operação relevante. A tabela é só de acréscimo (triggers na migração 002).
function auditar(db, req, accao, entidade, entidadeId, detalhes) {
  db.prepare(`INSERT INTO auditoria (utilizador_id, papel, accao, entidade, entidade_id, detalhes, ip, criado_em)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      req?.utilizador?.id ?? null,
      req?.utilizador?.papel ?? 'publico',
      accao,
      entidade,
      entidadeId ?? null,
      detalhes ? JSON.stringify(detalhes) : null,
      req?.ip ?? null,
      agora(),
    );
}

function notificar(db, clienteId, titulo, mensagem) {
  db.prepare('INSERT INTO notificacoes (cliente_id, titulo, mensagem, criado_em) VALUES (?, ?, ?, ?)')
    .run(clienteId, titulo, mensagem, agora());
}

module.exports = { auditar, notificar };
