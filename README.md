# APG Microcrédito — site, área do cliente e administração

Servidor Node.js (Express 5 + SQLite nativo `node:sqlite`) que serve o site público existente
e acrescenta o auto-registo de clientes, o cadastro administrativo, o painel do cliente e o
ciclo completo do crédito (pedido → decisão → desembolso → prestações → pagamentos).

O site público (`public/index.html`) é o ficheiro original com três acréscimos mínimos:
um link «Entrar» no cabeçalho, o mesmo link no menu móvel e uma verificação de sessão que
o troca por «A minha área». Simulador, textos, WhatsApp e design ficam iguais.

## Como executar

### 1. Pré-requisitos

- **Node.js 22.13 ou superior** (testado na versão 26). Confirme com `node --version`.
  Se não tiver o Node instalado, descarregue-o em <https://nodejs.org> (versão LTS).
- **Git**, para obter o código.

Não é preciso instalar nenhuma base de dados: o projecto usa o SQLite que já vem com o Node,
e a base de dados é um ficheiro criado automaticamente em `data/`.

### 2. Obter o código e instalar as dependências

```bash
git clone https://github.com/anisse19/apg-microcredito.git
cd apg-microcredito
npm install
```

### 3. Experimentar com dados de demonstração (recomendado para começar)

```bash
npm run semear-dev
npm run dev
```

Abra <http://localhost:3000>. O `semear-dev` cria uma base de dados **só de teste**
(`data/dev.sqlite`, apagada e recriada sempre que o comando corre) com estas contas:

| Conta | Entrar em | Telefone / email | Palavra-passe |
|---|---|---|---|
| Administrador | <http://localhost:3000/admin> | `admin@apg.test` | `Admin-dev-123` |
| Cliente | <http://localhost:3000/conta/entrar> | `840000001` | `Cliente-dev-123` |

O `npm run dev` reinicia o servidor sozinho sempre que um ficheiro em `src/` é alterado.
Para parar o servidor, carregue em `Ctrl + C` no terminal.

### 4. Executar com a base de dados real

```bash
npm run criar-admin -- --nome "Nome Apelido" --email admin@apg.co.mz
npm start
```

- O `criar-admin` pede a palavra-passe no terminal (mínimo 8 caracteres, com letras e números).
  É a **única** forma de criar um administrador: o site nunca cria nem promove administradores.
- O `npm start` serve o site em <http://localhost:3000> e usa `data/apg.sqlite`.
  Na primeira execução cria as tabelas; nas seguintes aplica só as migrações que faltam.
- Faça uma cópia de `data/apg.sqlite` antes de actualizar o código em produção.

### 5. Correr os testes

```bash
npm test
```

Os testes usam uma base de dados temporária em memória e nunca tocam em `data/`.

### Configuração (variáveis de ambiente)

| Variável | Para quê | Por omissão |
|---|---|---|
| `PORT` | Porta do servidor | `3000` |
| `APG_BASE_DADOS` | Caminho do ficheiro SQLite | `data/apg.sqlite` |
| `APG_URL_PUBLICA` | Endereço usado nos links de activação/redefinição (ex.: `https://apg.co.mz`) | o endereço do pedido |
| `APG_TRUST_PROXY` | Definir quando o servidor está atrás de um proxy ou balanceador com HTTPS (ex.: `1`) | desligado |
| `NODE_ENV` | `production` torna o cookie de sessão `Secure` (exige HTTPS) | — |

Exemplo em produção:

```bash
NODE_ENV=production PORT=8080 APG_URL_PUBLICA=https://apg.co.mz APG_TRUST_PROXY=1 npm start
```

### Problemas comuns

- **`Cannot find module 'node:sqlite'`** ou erro semelhante: a versão do Node é antiga. Actualize para 22.13 ou superior.
- **`EADDRINUSE`**: a porta 3000 já está ocupada. Use outra, por exemplo `PORT=3001 npm run dev`.
- **Não consigo entrar no `/admin`**: confirme que criou o administrador na mesma base de dados que o servidor usa
  (`npm run dev` usa `data/dev.sqlite`; `npm start` usa `data/apg.sqlite`).
- **Esqueci-me da palavra-passe do administrador**: crie outro administrador com `npm run criar-admin`.

## Páginas

| Caminho | Quem | O quê |
|---|---|---|
| `/` | público | Site original (simulador + pedido por WhatsApp) |
| `/conta/registar`, `/conta/entrar`, `/conta/recuperar` | público | Criar conta, entrar, pedir recuperação |
| `/conta/definir#t=…` | quem recebeu o link | Activar conta criada pela APG / nova palavra-passe |
| `/conta` | cliente | Painel: resumo, pedidos, créditos, prestações, pagamentos, histórico, notificações, perfil |
| `/admin`, `/admin/configuracoes` | administrador | Pedidos, clientes, créditos, recuperações, condições, auditoria |

## API

Endpoints públicos (contrato da Fase 2 mantido): `GET /api/config`, `POST /api/visita`,
`POST /api/interacao`, `POST /api/pedidos`.

- `/api/auth/*`: registar, entrar, sair, sessão, recuperar, token, definir-palavra-passe.
- `/api/me/*` (só cliente; filtra sempre pelo cliente da sessão): painel, pedidos, cancelar, créditos, notificações, palavra-passe.
- `/api/admin/*` (só administrador): resumo, clientes, link-acesso, conta, pedidos (análise/aprovar/rejeitar/cancelar/associar/observações), créditos (desembolso/pagamentos/cancelar), anulação de pagamentos, recuperações, config, auditoria.

As rotas autenticadas que alteram dados exigem o cabeçalho `X-APG-Pedido: 1` (protecção CSRF).

## Base de dados e migrações

`src/migrations/` aplicadas por ordem, cada uma numa transacção, registadas em `schema_migracoes`
(`npm run migrar`, ou automaticamente no arranque):

- **001_fase2_publico.sql**: `config`, `visitas`, `interacoes`, `pedidos` (as tabelas que o site já usava).
- **002_clientes_creditos.sql**: `clientes`, `utilizadores`, `sessoes`, `tokens_conta`, `pedidos_recuperacao`,
  `pedido_historico`, `creditos`, `prestacoes`, `pagamentos`, `notificacoes`, `auditoria`; novas colunas em
  `pedidos`. Só acrescenta tabelas e colunas: os pedidos existentes recebem referência, estado
  «Pendente de análise» e entrada no histórico, sem perder dados.

Regras garantidas também na própria base de dados: o papel de uma conta não pode mudar (nenhum cliente
passa a administrador); um administrador não tem perfil de cliente; uma decisão registada é definitiva;
pagamentos e auditoria não se apagam nem se reescrevem (correcções = anulação registada); valores
monetários novos em centavos.

## Segurança

- Palavras-passe com scrypt; sessões com token aleatório em cookie `HttpOnly`/`SameSite=Lax` (só o hash fica na base).
- Bloqueio temporário após 5 tentativas falhadas; limite de pedidos por IP no registo, entrada, recuperação e pedidos públicos.
- O papel e o cliente vêm sempre da sessão no servidor; campos como `papel`, `clienteId`, `estado` ou `percentagem` enviados pelo navegador são ignorados.
- Links de activação/redefinição de uso único (72 h / 24 h), guardados só como hash e enviados no fragmento do URL.
- CSP estrita nas áreas `/conta` e `/admin` (sem scripts inline; conteúdo dinâmico inserido com `textContent`).

## Testes

```bash
npm test
```

`test/fluxo.test.js` cobre os 11 cenários obrigatórios contra o servidor real, numa base de teste em memória.
`test/migracao-seguranca.test.js` cobre a migração sobre uma base da Fase 2 com dados, a recuperação de
acesso, o bloqueio por tentativas e os cabeçalhos de segurança. Os testes nunca tocam em `data/apg.sqlite`.
