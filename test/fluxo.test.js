'use strict';

// Os 11 cenários obrigatórios (secção 7), executados contra o servidor real
// (HTTP + base de dados SQLite de teste em memória).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidor, Navegador, criarAdmin } = require('./ajuda');
const { hoje } = require('../src/util');

describe('Fluxo de clientes e créditos', () => {
  let srv; let admin; let ana; let bruno; let anonimo;
  const estado = {};

  before(async () => {
    srv = await iniciarServidor();
    const credAdmin = criarAdmin(srv.db);
    admin = new Navegador(srv.url);
    ana = new Navegador(srv.url);
    bruno = new Navegador(srv.url);
    anonimo = new Navegador(srv.url);
    assert.equal((await admin.post('/api/auth/entrar', credAdmin)).status, 200);
  });
  after(() => srv.fechar());

  // ===== 1 =====
  it('1. um cliente cria a sua conta (sem poder escolher o papel)', async () => {
    const r = await ana.post('/api/auth/registar', {
      nomeCompleto: 'Ana Maria Machava', telefone: '+258 84 123 4567', email: 'Ana@Exemplo.co.mz',
      palavraPasse: 'segredo123', aceitaCondicoes: true, papel: 'admin', clienteId: 999,
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.corpo.utilizador, { nome: 'Ana Maria Machava', papel: 'cliente' });
    assert.ok(ana.cookie, 'sessão iniciada');
    const u = srv.db.prepare("SELECT papel, telefone, email FROM utilizadores WHERE telefone = '841234567'").get();
    assert.equal(u.papel, 'cliente');
    assert.equal(u.email, 'ana@exemplo.co.mz');

    const dup = await new Navegador(srv.url).post('/api/auth/registar', {
      nomeCompleto: 'Outra Pessoa', telefone: '841234567', palavraPasse: 'segredo123', aceitaCondicoes: true,
    });
    assert.equal(dup.status, 409, 'telefone duplicado recusado');

    const invalido = await new Navegador(srv.url).post('/api/auth/registar', { nomeCompleto: 'X', telefone: '123', palavraPasse: 'curta' });
    assert.equal(invalido.status, 400);
    assert.ok(invalido.corpo.campos.nomeCompleto && invalido.corpo.campos.telefone && invalido.corpo.campos.palavraPasse && invalido.corpo.campos.aceitaCondicoes);
  });

  // ===== 2 =====
  it('2. a administração regista outro cliente e envia um link de activação', async () => {
    const r = await admin.post('/api/admin/clientes', {
      nomeCompleto: 'Bruno Carlos Sitoe', telefone: '82 765 4321', documentoTipo: 'BI', documentoNumero: '110100123456B',
    });
    assert.equal(r.status, 201);
    estado.brunoId = r.corpo.id;

    const dup = await admin.post('/api/admin/clientes', { nomeCompleto: 'Bruno Duplicado', telefone: '827654321' });
    assert.equal(dup.status, 409);
    assert.equal(dup.corpo.clienteExistenteId, estado.brunoId);

    // O próprio cliente não pode criar um segundo perfil com o mesmo telefone.
    const auto = await new Navegador(srv.url).post('/api/auth/registar', {
      nomeCompleto: 'Bruno Sitoe', telefone: '827654321', palavraPasse: 'segredo123', aceitaCondicoes: true,
    });
    assert.equal(auto.status, 409);

    const link = await admin.post(`/api/admin/clientes/${estado.brunoId}/link-acesso`);
    assert.equal(link.status, 200);
    assert.equal(link.corpo.tipo, 'activacao');
    const token = new URL(link.corpo.link).hash.replace('#t=', '');
    assert.ok(token.length >= 40);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM tokens_conta WHERE token_hash = ?').get(token).n, 0, 'o token em claro não é guardado');

    // Antes de activar, não há sessão possível.
    assert.equal((await bruno.post('/api/auth/entrar', { identificador: '827654321', palavraPasse: 'qualquer123' })).status, 401);

    assert.equal((await bruno.post('/api/auth/token', { token })).corpo.nome, 'Bruno');
    const activar = await bruno.post('/api/auth/definir-palavra-passe', { token, palavraPasse: 'bruno-pass-1' });
    assert.equal(activar.status, 200);
    assert.equal(activar.corpo.utilizador.papel, 'cliente');
    assert.equal((await new Navegador(srv.url).post('/api/auth/definir-palavra-passe', { token, palavraPasse: 'outra-pass-2' })).status, 404, 'link de uso único');

    const pesquisa = await admin.get('/api/admin/clientes?q=Sitoe');
    assert.equal(pesquisa.corpo.length, 1);
    assert.equal(pesquisa.corpo[0].contaEstado, 'activo');
  });

  // ===== 3 =====
  it('3. o cliente entra no seu painel', async () => {
    const errado = await new Navegador(srv.url).post('/api/auth/entrar', { identificador: '841234567', palavraPasse: 'errada999' });
    assert.equal(errado.status, 401);

    const nav = new Navegador(srv.url);
    assert.equal((await nav.post('/api/auth/entrar', { identificador: '84 123 4567', palavraPasse: 'segredo123' })).status, 200);
    const p = await nav.get('/api/me/painel');
    assert.equal(p.status, 200);
    assert.equal(p.corpo.perfil.nomeCompleto, 'Ana Maria Machava');
    assert.equal(p.corpo.resumo.saldoPendenteCentavos, 0);
    assert.equal(p.corpo.pedidos.length, 0);
    assert.ok(p.corpo.notificacoes.some((n) => n.titulo === 'Bem-vindo à APG'));
    assert.equal(p.headers.get('cache-control'), 'no-store');
  });

  // ===== 4 =====
  it('4. o cliente submete um pedido de crédito', async () => {
    const chave = 'teste-chave-0001';
    const r = await ana.post('/api/me/pedidos', {
      valor: 5000, prazoDias: 15, finalidade: 'Stock da banca', chaveIdempotencia: chave,
      percentagem: 0, estado: 'aprovado', clienteId: estado.brunoId,
    });
    assert.equal(r.status, 201);
    const p = r.corpo.pedido;
    assert.match(p.referencia, /^APG-\d{4}-\d{6}$/);
    assert.equal(p.estado, 'pendente_analise');
    assert.equal(p.estadoRotulo, 'Pendente de análise');
    assert.equal(p.percentagem, 25, 'percentagem vem da configuração do servidor');
    assert.equal(p.totalEstimadoCentavos, 625000);
    assert.ok(p.criadoEm);
    estado.pedidoAna = p.id;
    const linha = srv.db.prepare('SELECT cliente_id, origem FROM pedidos WHERE id = ?').get(p.id);
    assert.notEqual(linha.cliente_id, estado.brunoId, 'clienteId do navegador ignorado');
    assert.equal(linha.origem, 'painel_cliente');

    const repetido = await ana.post('/api/me/pedidos', { valor: 5000, prazoDias: 15, chaveIdempotencia: chave });
    assert.equal(repetido.status, 200);
    assert.equal(repetido.corpo.pedido.id, p.id, 'submissão duplicada devolve o mesmo pedido');

    assert.equal((await ana.post('/api/me/pedidos', { valor: 1000, prazoDias: 15 })).status, 400, 'abaixo do mínimo');
    assert.equal((await ana.post('/api/me/pedidos', { valor: 5000, prazoDias: 10 })).status, 400, 'prazo inexistente');
    assert.equal((await ana.post('/api/me/pedidos', { valor: 'abc', prazoDias: 7 })).status, 400);

    const segundo = await ana.post('/api/me/pedidos', { valor: 3000, prazoDias: 7, chaveIdempotencia: 'teste-chave-0002' });
    assert.equal(segundo.status, 201);
    estado.pedidoAna2 = segundo.corpo.pedido.id;
  });

  // ===== 5 =====
  it('5. o pedido aparece no painel administrativo', async () => {
    const lista = await admin.get('/api/admin/pedidos?estado=pendente_analise');
    assert.equal(lista.status, 200);
    const p = lista.corpo.find((x) => x.id === estado.pedidoAna);
    assert.ok(p);
    assert.equal(p.clienteNome, 'Ana Maria Machava');
    const det = await admin.get(`/api/admin/pedidos/${estado.pedidoAna}`);
    assert.equal(det.corpo.pedido.finalidade, 'Stock da banca');
    assert.equal(det.corpo.cliente.telefone, '841234567');
  });

  // ===== 6 =====
  it('6. um administrador autorizado aprova um pedido e rejeita outro', async () => {
    assert.equal((await admin.post(`/api/admin/pedidos/${estado.pedidoAna}/analise`, { nota: 'A verificar documentos.' })).status, 200);
    const ap = await admin.post(`/api/admin/pedidos/${estado.pedidoAna}/aprovar`, {
      montante: 4000, prazoDias: 15, numeroPrestacoes: 2, motivo: 'Aprovado com montante ajustado.', observacoes: 'Rendimento confirmado.',
    });
    assert.equal(ap.status, 200);
    estado.creditoAna = ap.corpo.creditoId;

    const rej = await admin.post(`/api/admin/pedidos/${estado.pedidoAna2}/rejeitar`, { motivo: 'Já tem um crédito aprovado.' });
    assert.equal(rej.status, 200);

    assert.equal((await admin.post(`/api/admin/pedidos/${estado.pedidoAna}/rejeitar`, { motivo: 'mudar de ideias' })).status, 409, 'decisão definitiva');
    assert.throws(() => srv.db.prepare("UPDATE pedidos SET estado = 'rejeitado' WHERE id = ?").run(estado.pedidoAna), /já decidido/);

    const p = srv.db.prepare('SELECT * FROM pedidos WHERE id = ?').get(estado.pedidoAna);
    assert.equal(p.estado, 'aprovado');
    assert.ok(p.decidido_por && p.decidido_em, 'responsável e data registados');
    const c = srv.db.prepare('SELECT * FROM creditos WHERE id = ?').get(estado.creditoAna);
    assert.equal(c.estado, 'aguarda_desembolso', 'aprovação não é desembolso');
    assert.equal(c.montante_centavos, 400000);
    assert.equal(c.total_centavos, 500000);
    assert.equal(c.aprovado_por, p.decidido_por);
  });

  // ===== 7 =====
  it('7. a decisão fica registada e visível ao cliente; o crédito segue até à liquidação', async () => {
    let painel = (await ana.get('/api/me/painel')).corpo;
    const p = painel.pedidos.find((x) => x.id === estado.pedidoAna);
    assert.equal(p.estado, 'aprovado');
    assert.equal(p.motivoDecisao, 'Aprovado com montante ajustado.');
    assert.equal(p.observacoesInternas, undefined, 'observações internas não chegam ao cliente');
    assert.deepEqual(p.historico.map((h) => h.estadoNovo), ['pendente_analise', 'em_analise', 'aprovado']);
    assert.ok(p.historico.every((h) => h.autor !== 'Administrador 1'), 'nome do administrador não é exposto');
    assert.equal(painel.pedidos.find((x) => x.id === estado.pedidoAna2).estado, 'rejeitado');
    assert.ok(painel.notificacoes.some((n) => /aprovado/.test(n.titulo)));
    assert.ok(painel.notificacoes.some((n) => /não aprovado/.test(n.titulo)));
    assert.equal(painel.resumo.creditosAguardandoDesembolso, 1);
    assert.equal(painel.resumo.saldoPendenteCentavos, 0);

    // Activação só com as condições confirmadas.
    assert.equal((await admin.post(`/api/admin/creditos/${estado.creditoAna}/desembolso`, { data: hoje(), metodo: 'mpesa' })).status, 400);
    assert.equal((await admin.post(`/api/admin/creditos/${estado.creditoAna}/pagamentos`, { valor: 100, data: hoje(), metodo: 'mpesa' })).status, 409, 'sem pagamentos antes do desembolso');
    const des = await admin.post(`/api/admin/creditos/${estado.creditoAna}/desembolso`, {
      data: hoje(), metodo: 'mpesa', referencia: 'MP123', contratoAssinado: true, identidadeVerificada: true,
    });
    assert.equal(des.status, 200);

    painel = (await ana.get('/api/me/painel')).corpo;
    let credito = painel.creditos[0];
    assert.equal(credito.estado, 'activo');
    assert.equal(credito.prestacoes.length, 2);
    assert.deepEqual(credito.prestacoes.map((x) => x.valorCentavos), [250000, 250000]);
    assert.equal(painel.resumo.saldoPendenteCentavos, 500000);
    assert.equal(painel.resumo.totalContratadoCentavos, 400000);
    assert.equal(painel.resumo.totalAReembolsarCentavos, 500000);
    assert.equal(painel.resumo.prestacoesPorPagar, 2);

    const pg1 = await admin.post(`/api/admin/creditos/${estado.creditoAna}/pagamentos`, { valor: 3000, data: hoje(), metodo: 'numerario' });
    assert.equal(pg1.status, 200);
    assert.equal((await admin.post(`/api/admin/creditos/${estado.creditoAna}/pagamentos`, { valor: 2500, data: hoje(), metodo: 'mpesa' })).status, 400, 'acima do saldo');

    painel = (await ana.get('/api/me/painel')).corpo;
    credito = painel.creditos[0];
    assert.equal(painel.resumo.saldoPendenteCentavos, 200000);
    assert.equal(painel.resumo.totalPagoCentavos, 300000);
    assert.deepEqual(credito.prestacoes.map((x) => x.estado), ['paga', 'parcial']);
    assert.equal(painel.resumo.prestacoesPagas, 1);
    assert.equal(credito.pagamentos.length, 1);
    assert.ok(painel.operacoes.some((o) => o.tipo === 'pagamento'));
    assert.ok(painel.operacoes.some((o) => o.tipo === 'desembolso'));

    const pg2 = await admin.post(`/api/admin/creditos/${estado.creditoAna}/pagamentos`, { valor: 2000, data: hoje(), metodo: 'mpesa' });
    assert.equal(pg2.status, 200);
    painel = (await ana.get('/api/me/painel')).corpo;
    assert.equal(painel.creditos[0].estado, 'liquidado');
    assert.equal(painel.resumo.saldoPendenteCentavos, 0);

    // Correcção: anular um pagamento reabre o crédito.
    assert.equal((await admin.post(`/api/admin/pagamentos/${pg2.corpo.pagamentoId}/anular`, { motivo: 'Lançado em duplicado' })).status, 200);
    painel = (await ana.get('/api/me/painel')).corpo;
    assert.equal(painel.creditos[0].estado, 'activo');
    assert.equal(painel.resumo.saldoPendenteCentavos, 200000);
    assert.equal(painel.creditos[0].pagamentos.length, 1, 'pagamentos anulados não aparecem como confirmados');
    assert.equal((await admin.post(`/api/admin/creditos/${estado.creditoAna}/pagamentos`, { valor: 2000, data: hoje(), metodo: 'mpesa' })).status, 200);
  });

  // ===== 8 =====
  it('8. um cliente não consegue aprovar o próprio pedido', async () => {
    const r = await ana.post('/api/me/pedidos', { valor: 3500, prazoDias: 30, chaveIdempotencia: 'teste-chave-0003' });
    estado.pedidoAna3 = r.corpo.pedido.id;

    for (const caminho of ['aprovar', 'rejeitar', 'analise']) {
      const t = await ana.post(`/api/admin/pedidos/${estado.pedidoAna3}/${caminho}`, { montante: 3500, prazoDias: 30, motivo: 'eu próprio' });
      assert.equal(t.status, 403, caminho);
    }
    assert.equal((await ana.put(`/api/me/pedidos/${estado.pedidoAna3}`, { estado: 'aprovado' })).status, 404);
    assert.equal((await ana.post(`/api/me/pedidos/${estado.pedidoAna3}`, { estado: 'aprovado' })).status, 404);
    assert.equal((await ana.post('/api/admin/creditos/1/pagamentos', { valor: 100, data: hoje(), metodo: 'mpesa' })).status, 403);
    assert.equal(srv.db.prepare('SELECT estado FROM pedidos WHERE id = ?').get(estado.pedidoAna3).estado, 'pendente_analise');

    // A base de dados também impede promover uma conta de cliente.
    assert.throws(() => srv.db.prepare("UPDATE utilizadores SET papel = 'admin' WHERE telefone = '841234567'").run(), /papel/);
    // O cliente pode cancelar o seu pedido pendente, mas não um decidido.
    assert.equal((await ana.post(`/api/me/pedidos/${estado.pedidoAna3}/cancelar`)).status, 200);
    assert.equal((await ana.post(`/api/me/pedidos/${estado.pedidoAna}/cancelar`)).status, 409);
  });

  // ===== 9 =====
  it('9. um cliente não consegue consultar os dados financeiros de outro cliente', async () => {
    assert.equal((await bruno.get(`/api/me/pedidos/${estado.pedidoAna}`)).status, 404);
    assert.equal((await bruno.get(`/api/me/creditos/${estado.creditoAna}`)).status, 404);
    assert.equal((await bruno.post(`/api/me/pedidos/${estado.pedidoAna2}/cancelar`)).status, 404);
    const p = await bruno.get(`/api/me/painel?clienteId=${srv.db.prepare("SELECT id FROM clientes WHERE telefone = '841234567'").get().id}`);
    assert.equal(p.status, 200);
    assert.equal(p.corpo.perfil.nomeCompleto, 'Bruno Carlos Sitoe');
    assert.equal(p.corpo.pedidos.length, 0);
    assert.equal(p.corpo.creditos.length, 0);
    assert.equal(p.corpo.perfil.documentoNumero, '•••56B', 'documento mascarado');
    assert.equal(p.corpo.perfil.notasInternas, undefined);
    assert.equal((await bruno.get('/api/admin/clientes')).status, 403);
  });

  // ===== 10 =====
  it('10. um utilizador sem permissões não executa operações administrativas', async () => {
    const operacoes = [
      ['GET', '/api/admin/pedidos'], ['GET', '/api/admin/clientes'], ['GET', '/api/admin/resumo'],
      ['POST', '/api/admin/clientes', { nomeCompleto: 'Intruso Teste', telefone: '845550000' }],
      ['PUT', '/api/admin/config', { valorMinimo: 1, prazos: [{ dias: 7, percentagem: 0 }] }],
      ['POST', `/api/admin/pedidos/${estado.pedidoAna}/aprovar`, {}],
      ['POST', `/api/admin/creditos/${estado.creditoAna}/pagamentos`, { valor: 1, data: hoje(), metodo: 'mpesa' }],
      ['POST', `/api/admin/clientes/${estado.brunoId}/link-acesso`],
    ];
    for (const [metodo, caminho, corpo] of operacoes) {
      assert.equal((await anonimo.pedido(metodo, caminho, corpo)).status, 401, `anónimo ${metodo} ${caminho}`);
      assert.equal((await bruno.pedido(metodo, caminho, corpo)).status, 403, `cliente ${metodo} ${caminho}`);
    }
    // Cookie de sessão forjado.
    const falso = new Navegador(srv.url);
    falso.cookie = 'apg_sessao=inventado';
    assert.equal((await falso.get('/api/admin/pedidos')).status, 401);
    // Protecção CSRF: sem o cabeçalho próprio ou com Origin de outro site.
    assert.equal((await admin.post(`/api/admin/clientes/${estado.brunoId}/verificar-telefone`, undefined, { csrf: false })).status, 403);
    assert.equal((await admin.post(`/api/admin/clientes/${estado.brunoId}/verificar-telefone`, undefined, { cabecalhos: { Origin: 'https://site-malicioso.example' } })).status, 403);
    assert.equal((await admin.post(`/api/admin/clientes/${estado.brunoId}/verificar-telefone`)).status, 200);
    // A configuração não mudou.
    assert.equal((await anonimo.get('/api/config')).corpo.valorMinimo, 3000);
  });

  // ===== 11 =====
  it('11. os endpoints do site público, créditos, pagamentos e históricos continuam a funcionar', async () => {
    assert.deepEqual((await anonimo.get('/api/config')).corpo, {
      valorMinimo: 3000, prazos: [{ dias: 7, percentagem: 15 }, { dias: 15, percentagem: 25 }, { dias: 30, percentagem: 30 }],
    });
    assert.equal((await anonimo.post('/api/visita', { sessaoId: 'abc-123', pagina: '/' }, { csrf: false })).status, 204);
    assert.equal((await anonimo.post('/api/visita', { sessaoId: 'abc-123', pagina: '/' }, { csrf: false })).status, 204);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM visitas WHERE sessao_id = 'abc-123'").get().n, 1, '1 visita por sessão por dia');
    for (const tipo of ['pedido_iniciado', 'simulacao', 'pedido_enviado']) {
      assert.equal((await anonimo.post('/api/interacao', { tipo, sessaoId: 'abc-123' }, { csrf: false })).status, 204);
    }
    assert.equal((await anonimo.post('/api/interacao', { tipo: 'outro' }, { csrf: false })).status, 400);

    // Pedido do modal público (mesmo formato que o HTML envia), sem sessão.
    const pub = await anonimo.post('/api/pedidos', { nome: 'Carla Nhantumbo', telefone: '86 111 2222', valor: 3000, prazoDias: 7 }, { csrf: false });
    assert.equal(pub.status, 201);
    assert.equal((await anonimo.post('/api/pedidos', { nome: 'Carla Nhantumbo', telefone: '861112222', valor: 3000, prazoDias: 7 }, { csrf: false })).status, 200, 'reenvio deduplicado');
    assert.equal((await anonimo.post('/api/pedidos', { nome: 'Carla', telefone: '861112222', valor: 100, prazoDias: 7 }, { csrf: false })).status, 400);
    const naLista = (await admin.get('/api/admin/pedidos')).corpo.find((x) => x.referencia === pub.corpo.referencia);
    assert.equal(naLista.clienteId, null);

    // Sem cliente associado não é possível aprovar; depois de associar, sim.
    assert.equal((await admin.post(`/api/admin/pedidos/${naLista.id}/aprovar`, {})).status, 409);
    const carla = await admin.post('/api/admin/clientes', { nomeCompleto: 'Carla Nhantumbo', telefone: '861112222' });
    assert.equal((await admin.post(`/api/admin/pedidos/${naLista.id}/associar`, { clienteId: carla.corpo.id })).status, 200);
    assert.equal((await admin.post(`/api/admin/pedidos/${naLista.id}/aprovar`, {})).status, 200);

    // Pedido do modal público com sessão de cliente: fica na conta do cliente.
    const comSessao = await bruno.post('/api/pedidos', { nome: 'Nome Qualquer', telefone: '849999999', valor: 4000, prazoDias: 30 }, { csrf: false });
    assert.equal(comSessao.status, 201);
    assert.ok((await bruno.get('/api/me/painel')).corpo.pedidos.some((x) => x.referencia === comSessao.corpo.referencia));

    // Alteração das condições pelo administrador reflecte-se no endpoint público.
    const cfg = await admin.put('/api/admin/config', { valorMinimo: 3500, prazos: [{ dias: 7, percentagem: 15 }, { dias: 30, percentagem: 30 }] });
    assert.equal(cfg.status, 200);
    assert.equal((await anonimo.get('/api/config')).corpo.valorMinimo, 3500);

    // Históricos: auditoria e pagamentos não se apagam nem se reescrevem.
    assert.ok(srv.db.prepare("SELECT COUNT(*) AS n FROM auditoria WHERE accao = 'pedido.aprovado'").get().n >= 2);
    assert.throws(() => srv.db.prepare('DELETE FROM auditoria').run(), /não pode ser apagado/);
    assert.throws(() => srv.db.prepare("UPDATE auditoria SET accao = 'x'").run(), /não pode ser alterado/);
    assert.throws(() => srv.db.prepare('DELETE FROM pagamentos').run(), /não podem ser apagados/);
    assert.throws(() => srv.db.prepare('UPDATE pagamentos SET valor_centavos = 1').run(), /só pode ser anulado/);

    const ficha = await admin.get(`/api/admin/clientes/${carla.corpo.id}`);
    assert.ok(ficha.corpo.historico.some((h) => h.accao === 'pedido.aprovado'));
    assert.ok(ficha.corpo.historico.some((h) => h.accao === 'pedido.associado'));
  });
});
