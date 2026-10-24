-- 001 — Tabelas que o site público já usa (Fase 2):
-- /api/config, /api/visita, /api/interacao e /api/pedidos.
-- Mantêm o contrato que o HTML actual envia e espera.

CREATE TABLE IF NOT EXISTS config (
  chave          TEXT PRIMARY KEY,
  valor          TEXT NOT NULL,                 -- JSON
  actualizado_em TEXT NOT NULL
);

INSERT OR IGNORE INTO config (chave, valor, actualizado_em) VALUES
  ('valorMinimo', '3000', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('prazos', '[{"dias":7,"percentagem":15},{"dias":15,"percentagem":25},{"dias":30,"percentagem":30}]',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Uma visita por sessão por dia (a deduplicação é feita aqui, não no navegador).
CREATE TABLE IF NOT EXISTS visitas (
  id        INTEGER PRIMARY KEY,
  sessao_id TEXT NOT NULL,
  pagina    TEXT NOT NULL,
  dia       TEXT NOT NULL,                      -- AAAA-MM-DD
  criado_em TEXT NOT NULL,
  UNIQUE (sessao_id, dia)
);

CREATE TABLE IF NOT EXISTS interacoes (
  id        INTEGER PRIMARY KEY,
  tipo      TEXT NOT NULL CHECK (tipo IN ('pedido_iniciado', 'simulacao', 'pedido_enviado')),
  sessao_id TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interacoes_tipo ON interacoes (tipo, criado_em);

-- Pedidos enviados pelo modal «Solicitar crédito» do site público.
CREATE TABLE IF NOT EXISTS pedidos (
  id         INTEGER PRIMARY KEY,
  nome       TEXT NOT NULL,
  telefone   TEXT NOT NULL,
  valor      REAL NOT NULL,                     -- MT
  prazo_dias INTEGER NOT NULL,
  criado_em  TEXT NOT NULL
);
