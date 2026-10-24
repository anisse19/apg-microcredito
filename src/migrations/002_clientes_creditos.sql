-- 002 — Contas de cliente, cadastro administrativo, painel do cliente e ciclo
-- do crédito (pedido → decisão → desembolso → prestações → pagamentos).
--
-- Só acrescenta tabelas, colunas, índices e triggers. Os pedidos já existentes
-- ficam intactos; apenas as novas colunas são preenchidas (referência, estado
-- inicial «Pendente de análise» e percentagem do prazo escolhido).
--
-- Valores monetários novos em centavos (INTEGER) para evitar erros de arredondamento.

-- ===== Clientes (perfil financeiro: um por pessoa) =====
CREATE TABLE clientes (
  id                  INTEGER PRIMARY KEY,
  nome_completo       TEXT NOT NULL,
  telefone            TEXT NOT NULL UNIQUE,     -- normalizado: 9 dígitos, sem indicativo
  email               TEXT UNIQUE,              -- em minúsculas
  documento_tipo      TEXT,
  documento_numero    TEXT,
  data_nascimento     TEXT,                     -- AAAA-MM-DD
  morada              TEXT,
  notas_internas      TEXT,                     -- só administração
  telefone_verificado INTEGER NOT NULL DEFAULT 0 CHECK (telefone_verificado IN (0, 1)),
  origem              TEXT NOT NULL CHECK (origem IN ('auto_registo', 'administracao')),
  criado_por          INTEGER REFERENCES utilizadores (id),
  criado_em           TEXT NOT NULL,
  actualizado_em      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_clientes_documento ON clientes (documento_tipo, documento_numero)
  WHERE documento_numero IS NOT NULL;
CREATE INDEX idx_clientes_nome ON clientes (nome_completo);

-- ===== Contas de acesso =====
-- Um cliente tem no máximo uma conta; um administrador nunca tem perfil de cliente.
CREATE TABLE utilizadores (
  id                  INTEGER PRIMARY KEY,
  cliente_id          INTEGER UNIQUE REFERENCES clientes (id),
  nome                TEXT NOT NULL,
  telefone            TEXT UNIQUE,
  email               TEXT UNIQUE,
  palavra_passe_hash  TEXT,
  papel               TEXT NOT NULL DEFAULT 'cliente' CHECK (papel IN ('cliente', 'admin')),
  estado              TEXT NOT NULL DEFAULT 'activo'
                      CHECK (estado IN ('activo', 'pendente_activacao', 'bloqueado')),
  tentativas_falhadas INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate       TEXT,
  criado_em           TEXT NOT NULL,
  ultimo_acesso       TEXT,
  CHECK (telefone IS NOT NULL OR email IS NOT NULL),
  CHECK ((papel = 'cliente' AND cliente_id IS NOT NULL) OR (papel = 'admin' AND cliente_id IS NULL)),
  CHECK (estado <> 'activo' OR palavra_passe_hash IS NOT NULL)
);

-- O papel é fixado na criação: nenhuma conta de cliente pode ser promovida a administrador.
CREATE TRIGGER utilizadores_papel_imutavel BEFORE UPDATE OF papel ON utilizadores
WHEN NEW.papel IS NOT OLD.papel
BEGIN
  SELECT RAISE(ABORT, 'O papel de um utilizador não pode ser alterado');
END;

-- Links de activação (convite) e de redefinição de palavra-passe. Uso único.
CREATE TABLE tokens_conta (
  id            INTEGER PRIMARY KEY,
  utilizador_id INTEGER NOT NULL REFERENCES utilizadores (id),
  tipo          TEXT NOT NULL CHECK (tipo IN ('activacao', 'redefinicao')),
  token_hash    TEXT NOT NULL UNIQUE,           -- SHA-256; o token em claro nunca é guardado
  expira_em     TEXT NOT NULL,
  usado_em      TEXT,
  criado_por    INTEGER REFERENCES utilizadores (id),
  criado_em     TEXT NOT NULL
);
CREATE INDEX idx_tokens_utilizador ON tokens_conta (utilizador_id);

CREATE TABLE sessoes (
  token_hash    TEXT PRIMARY KEY,               -- SHA-256 do cookie
  utilizador_id INTEGER NOT NULL REFERENCES utilizadores (id),
  criado_em     TEXT NOT NULL,
  expira_em     TEXT NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX idx_sessoes_utilizador ON sessoes (utilizador_id);

-- Pedidos de recuperação de acesso: a APG confirma a identidade e envia o link.
CREATE TABLE pedidos_recuperacao (
  id                 INTEGER PRIMARY KEY,
  telefone_informado TEXT NOT NULL,
  utilizador_id      INTEGER NOT NULL REFERENCES utilizadores (id),
  estado             TEXT NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente', 'tratado', 'descartado')),
  criado_em          TEXT NOT NULL,
  tratado_por        INTEGER REFERENCES utilizadores (id),
  tratado_em         TEXT
);

-- ===== Pedidos de crédito (tabela existente, alargada) =====
ALTER TABLE pedidos ADD COLUMN referencia TEXT;
ALTER TABLE pedidos ADD COLUMN cliente_id INTEGER REFERENCES clientes (id);
ALTER TABLE pedidos ADD COLUMN percentagem REAL;
ALTER TABLE pedidos ADD COLUMN finalidade TEXT;
ALTER TABLE pedidos ADD COLUMN informacoes TEXT;
ALTER TABLE pedidos ADD COLUMN estado TEXT NOT NULL DEFAULT 'pendente_analise'
  CHECK (estado IN ('pendente_analise', 'em_analise', 'aprovado', 'rejeitado', 'cancelado'));
ALTER TABLE pedidos ADD COLUMN origem TEXT NOT NULL DEFAULT 'site_publico'
  CHECK (origem IN ('site_publico', 'painel_cliente'));
ALTER TABLE pedidos ADD COLUMN submetido_por INTEGER REFERENCES utilizadores (id);
ALTER TABLE pedidos ADD COLUMN chave_idempotencia TEXT;
ALTER TABLE pedidos ADD COLUMN decidido_por INTEGER REFERENCES utilizadores (id);
ALTER TABLE pedidos ADD COLUMN decidido_em TEXT;
ALTER TABLE pedidos ADD COLUMN motivo_decisao TEXT;          -- visível ao cliente
ALTER TABLE pedidos ADD COLUMN observacoes_internas TEXT;    -- só administração
ALTER TABLE pedidos ADD COLUMN actualizado_em TEXT;

UPDATE pedidos
   SET referencia = 'APG-' || substr(criado_em, 1, 4) || '-' || printf('%06d', id)
 WHERE referencia IS NULL;
UPDATE pedidos SET actualizado_em = criado_em WHERE actualizado_em IS NULL;
UPDATE pedidos
   SET percentagem = (
     SELECT json_extract(p.value, '$.percentagem')
       FROM config c, json_each(c.valor) p
      WHERE c.chave = 'prazos' AND json_extract(p.value, '$.dias') = pedidos.prazo_dias)
 WHERE percentagem IS NULL;

CREATE UNIQUE INDEX idx_pedidos_referencia ON pedidos (referencia);
CREATE UNIQUE INDEX idx_pedidos_idempotencia ON pedidos (cliente_id, chave_idempotencia)
  WHERE chave_idempotencia IS NOT NULL;
CREATE INDEX idx_pedidos_cliente ON pedidos (cliente_id);
CREATE INDEX idx_pedidos_estado ON pedidos (estado, criado_em);

-- Uma decisão registada é definitiva.
CREATE TRIGGER pedidos_decisao_definitiva BEFORE UPDATE OF estado ON pedidos
WHEN OLD.estado IN ('aprovado', 'rejeitado', 'cancelado') AND NEW.estado IS NOT OLD.estado
BEGIN
  SELECT RAISE(ABORT, 'Um pedido já decidido não pode mudar de estado');
END;

CREATE TABLE pedido_historico (
  id              INTEGER PRIMARY KEY,
  pedido_id       INTEGER NOT NULL REFERENCES pedidos (id),
  estado_anterior TEXT,
  estado_novo     TEXT NOT NULL,
  nota            TEXT,                          -- visível ao cliente
  autor_id        INTEGER REFERENCES utilizadores (id),
  autor_papel     TEXT NOT NULL CHECK (autor_papel IN ('cliente', 'admin', 'sistema')),
  criado_em       TEXT NOT NULL
);
CREATE INDEX idx_pedido_historico ON pedido_historico (pedido_id);

INSERT INTO pedido_historico (pedido_id, estado_anterior, estado_novo, autor_papel, criado_em)
  SELECT id, NULL, 'pendente_analise', 'sistema', criado_em FROM pedidos;

-- ===== Créditos =====
-- Nasce com a aprovação («aguarda_desembolso») e só fica «activo» quando o
-- desembolso e as condições de activação são registados pela APG.
CREATE TABLE creditos (
  id                       INTEGER PRIMARY KEY,
  referencia               TEXT UNIQUE,
  pedido_id                INTEGER NOT NULL UNIQUE REFERENCES pedidos (id),
  cliente_id               INTEGER NOT NULL REFERENCES clientes (id),
  montante_centavos        INTEGER NOT NULL CHECK (montante_centavos > 0),
  percentagem              REAL NOT NULL CHECK (percentagem >= 0),
  prazo_dias               INTEGER NOT NULL CHECK (prazo_dias > 0),
  encargo_centavos         INTEGER NOT NULL CHECK (encargo_centavos >= 0),
  total_centavos           INTEGER NOT NULL,
  numero_prestacoes        INTEGER NOT NULL DEFAULT 1 CHECK (numero_prestacoes BETWEEN 1 AND 12),
  estado                   TEXT NOT NULL DEFAULT 'aguarda_desembolso'
                           CHECK (estado IN ('aguarda_desembolso', 'activo', 'liquidado', 'cancelado')),
  aprovado_por             INTEGER NOT NULL REFERENCES utilizadores (id),
  aprovado_em              TEXT NOT NULL,
  desembolsado_em          TEXT,                 -- AAAA-MM-DD
  desembolso_registado_por INTEGER REFERENCES utilizadores (id),
  desembolso_metodo        TEXT,
  desembolso_referencia    TEXT,
  condicoes_activacao      TEXT,                 -- JSON com as condições verificadas
  liquidado_em             TEXT,
  cancelado_em             TEXT,
  motivo_cancelamento      TEXT,
  criado_em                TEXT NOT NULL,
  CHECK (total_centavos = montante_centavos + encargo_centavos),
  CHECK (estado IN ('aguarda_desembolso', 'cancelado') OR desembolsado_em IS NOT NULL)
);
CREATE INDEX idx_creditos_cliente ON creditos (cliente_id);
CREATE INDEX idx_creditos_estado ON creditos (estado);

CREATE TABLE prestacoes (
  id             INTEGER PRIMARY KEY,
  credito_id     INTEGER NOT NULL REFERENCES creditos (id),
  numero         INTEGER NOT NULL,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos > 0),
  vencimento     TEXT NOT NULL,                  -- AAAA-MM-DD
  pago_centavos  INTEGER NOT NULL DEFAULT 0 CHECK (pago_centavos BETWEEN 0 AND valor_centavos),
  estado         TEXT NOT NULL DEFAULT 'por_pagar' CHECK (estado IN ('por_pagar', 'parcial', 'paga')),
  paga_em        TEXT,
  UNIQUE (credito_id, numero)
);

-- Só a administração regista pagamentos; um pagamento registado está confirmado.
CREATE TABLE pagamentos (
  id                 INTEGER PRIMARY KEY,
  credito_id         INTEGER NOT NULL REFERENCES creditos (id),
  valor_centavos     INTEGER NOT NULL CHECK (valor_centavos > 0),
  data_pagamento     TEXT NOT NULL,              -- AAAA-MM-DD
  metodo             TEXT NOT NULL,
  referencia_externa TEXT,
  observacoes        TEXT,
  registado_por      INTEGER NOT NULL REFERENCES utilizadores (id),
  registado_em       TEXT NOT NULL,
  anulado_em         TEXT,
  anulado_por        INTEGER REFERENCES utilizadores (id),
  motivo_anulacao    TEXT
);
CREATE INDEX idx_pagamentos_credito ON pagamentos (credito_id);

-- Pagamentos não se apagam nem se reescrevem: uma correcção é uma anulação registada.
CREATE TRIGGER pagamentos_sem_delete BEFORE DELETE ON pagamentos
BEGIN
  SELECT RAISE(ABORT, 'Pagamentos não podem ser apagados; devem ser anulados');
END;
CREATE TRIGGER pagamentos_imutaveis BEFORE UPDATE ON pagamentos
WHEN OLD.anulado_em IS NOT NULL
  OR NEW.credito_id IS NOT OLD.credito_id
  OR NEW.valor_centavos IS NOT OLD.valor_centavos
  OR NEW.data_pagamento IS NOT OLD.data_pagamento
  OR NEW.metodo IS NOT OLD.metodo
  OR NEW.registado_por IS NOT OLD.registado_por
  OR NEW.registado_em IS NOT OLD.registado_em
BEGIN
  SELECT RAISE(ABORT, 'Um pagamento registado só pode ser anulado');
END;

-- ===== Notificações no painel do cliente =====
CREATE TABLE notificacoes (
  id         INTEGER PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes (id),
  titulo     TEXT NOT NULL,
  mensagem   TEXT NOT NULL,
  lida_em    TEXT,
  criado_em  TEXT NOT NULL
);
CREATE INDEX idx_notificacoes_cliente ON notificacoes (cliente_id, criado_em);

-- ===== Auditoria (só acréscimo) =====
CREATE TABLE auditoria (
  id            INTEGER PRIMARY KEY,
  utilizador_id INTEGER REFERENCES utilizadores (id),
  papel         TEXT,
  accao         TEXT NOT NULL,
  entidade      TEXT NOT NULL,
  entidade_id   INTEGER,
  detalhes      TEXT,                            -- JSON
  ip            TEXT,
  criado_em     TEXT NOT NULL
);
CREATE INDEX idx_auditoria_entidade ON auditoria (entidade, entidade_id);
CREATE INDEX idx_auditoria_data ON auditoria (criado_em);

CREATE TRIGGER auditoria_sem_update BEFORE UPDATE ON auditoria
BEGIN
  SELECT RAISE(ABORT, 'O histórico de auditoria não pode ser alterado');
END;
CREATE TRIGGER auditoria_sem_delete BEFORE DELETE ON auditoria
BEGIN
  SELECT RAISE(ABORT, 'O histórico de auditoria não pode ser apagado');
END;
