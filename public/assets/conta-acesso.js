// Páginas de acesso: registar, entrar, recuperar e definir palavra-passe.
(function () {
  'use strict';

  const { api, aoSubmeter, mostrarErro } = window.APG;
  const pagina = document.body.dataset.pagina;
  const form = document.getElementById('formulario');
  const destino = (u) => (u && u.papel === 'admin' ? '/admin' : '/conta');

  function confirmarPalavraPasse(dados) {
    const confirmacao = document.getElementById('confirmacao');
    if (confirmacao && confirmacao.value !== dados.palavraPasse) {
      const erro = new Error('As palavras-passe não coincidem.');
      erro.campos = {};
      mostrarErro(form, erro);
      confirmacao.closest('.campo').classList.add('com-erro');
      confirmacao.focus();
      return false;
    }
    return true;
  }

  // Quem já tem sessão vai directamente para a sua área.
  if (pagina === 'entrar' || pagina === 'registar') {
    api('/auth/sessao').then((s) => { if (s.autenticado) window.location.replace(destino(s.utilizador)); }).catch(() => {});
  }

  if (pagina === 'registar') {
    aoSubmeter(form, async (dados) => {
      if (!confirmarPalavraPasse(dados)) return;
      const r = await api('/auth/registar', { metodo: 'POST', corpo: dados });
      window.location.href = destino(r.utilizador);
    });
  }

  if (pagina === 'entrar') {
    aoSubmeter(form, async (dados) => {
      const r = await api('/auth/entrar', { metodo: 'POST', corpo: dados });
      window.location.href = destino(r.utilizador);
    });
  }

  if (pagina === 'recuperar') {
    aoSubmeter(form, async (dados) => {
      const r = await api('/auth/recuperar', { metodo: 'POST', corpo: dados });
      const resultado = document.getElementById('resultado');
      resultado.textContent = r.mensagem;
      resultado.hidden = false;
      form.hidden = true;
    });
  }

  if (pagina === 'definir') {
    // O token vem no fragmento (#t=…), que não é enviado ao servidor nem a terceiros.
    // É retirado da barra de endereço assim que é lido.
    const token = new URLSearchParams(window.location.hash.slice(1)).get('t');
    window.history.replaceState(null, '', window.location.pathname);
    const descricao = document.getElementById('descricao');
    const invalido = (mensagem) => {
      descricao.hidden = true;
      const aviso = document.getElementById('invalido');
      aviso.textContent = mensagem;
      aviso.hidden = false;
    };
    if (!token) {
      invalido('Este link está incompleto. Use o link enviado pela APG ou peça um novo.');
      return;
    }
    api('/auth/token', { metodo: 'POST', corpo: { token } }).then((t) => {
      const activacao = t.tipo === 'activacao';
      document.getElementById('titulo').textContent = activacao ? 'Activar a sua conta' : 'Nova palavra-passe';
      descricao.textContent = activacao
        ? `Olá, ${t.nome}. Defina a palavra-passe para activar a sua conta APG.`
        : `Olá, ${t.nome}. Defina uma nova palavra-passe para a sua conta.`;
      form.hidden = false;
      document.getElementById('palavraPasse').focus();
    }).catch((e) => invalido(e.message));

    aoSubmeter(form, async (dados) => {
      if (!confirmarPalavraPasse(dados)) return;
      const r = await api('/auth/definir-palavra-passe', { metodo: 'POST', corpo: { token, palavraPasse: dados.palavraPasse } });
      window.location.href = destino(r.utilizador);
    });
  }
}());
