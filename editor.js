/* Ajuste visual — editor injetado em qualquer página.
   Ctrl+Shift+E liga/desliga. Clique para escolher um elemento e arraste para mover.
   As mudanças são só na tela; "Copiar alterações" gera um texto para um agente aplicar no código. */
(() => {
  if (window.top !== window || window.__ajusteVisual) return;
  window.__ajusteVisual = true;

  const alteracoes = new Map(); // elemento -> estado
  const desfazer = [];
  let ligado = false;
  let selecionado = null;
  let candidatos = [];
  let arrasto = null;
  let animacoesParadas = false;
  let host, raiz, caixaHover, caixaSel, painel, estiloAnim;

  /* ---------- descrição dos elementos ---------- */
  const nomeArquivo = (url) => {
    try { return decodeURIComponent(new URL(url, location.href).pathname.split('/').pop()); } catch { return url; }
  };
  const textoCurto = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const fundoImagem = (el) => {
    const m = getComputedStyle(el).backgroundImage.match(/url\(["']?([^"')]+)/);
    return m ? nomeArquivo(m[1]) : '';
  };
  // Imagens adicionadas pelo editor vêm como data: URL; o nome do arquivo fica no atributo.
  const arquivoDe = (el) => el.dataset?.ajusteNovo
    ?? (el.tagName === 'IMG' ? nomeArquivo(el.currentSrc || el.src) : fundoImagem(el));
  function seletor(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const partes = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id) { partes.unshift(`#${CSS.escape(n.id)}`); break; }
      let parte = n.tagName.toLowerCase();
      const classes = [...n.classList].filter((c) => !/^astro-|^data-/.test(c)).slice(0, 2);
      if (classes.length) parte += classes.map((c) => `.${CSS.escape(c)}`).join('');
      const irmaos = n.parentElement ? [...n.parentElement.children].filter((i) => i.tagName === n.tagName) : [];
      if (irmaos.length > 1) parte += `:nth-of-type(${irmaos.indexOf(n) + 1})`;
      partes.unshift(parte);
      const s = partes.join(' > ');
      try { if (document.querySelectorAll(s).length === 1) return s; } catch { /* segue subindo */ }
    }
    return partes.join(' > ');
  }
  function descrever(el) {
    let d = el.tagName.toLowerCase();
    if (el.id) d += `#${el.id}`;
    const classes = [...el.classList].slice(0, 3);
    if (classes.length) d += `.${classes.join('.')}`;
    const arquivo = arquivoDe(el);
    if (arquivo) return `${d}  [${arquivo}]`;
    const t = textoCurto(el);
    return t ? `${d}  "${t}"` : d;
  }

  /* ---------- estado de cada elemento alterado ---------- */
  const num = (v, padrao = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : padrao; };
  function estado(el) {
    if (!alteracoes.has(el)) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      alteracoes.set(el, {
        dx: 0, dy: 0, rot: 0, removido: false, espelhado: false, novo: null,
        largura: null, altura: null, opacidade: null,
        orig: {
          estiloInline: el.getAttribute('style'),
          translate: cs.translate,
          rotate: num(cs.rotate),
          scale: cs.scale,
          largura: r.width, altura: r.height,
          larguraCss: el.offsetWidth || r.width,
          alturaCss: el.offsetHeight || r.height,
          opacidade: num(cs.opacity, 1),
          x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY),
        },
      });
    }
    return alteracoes.get(el);
  }
  const copia = (s) => ({ dx: s.dx, dy: s.dy, rot: s.rot, largura: s.largura, altura: s.altura, opacidade: s.opacidade, removido: s.removido, espelhado: s.espelhado });
  function guardarDesfazer(el) {
    const s = estado(el);
    desfazer.push({ el, antes: copia(s) });
    if (desfazer.length > 200) desfazer.shift();
  }
  function aplicar(el) {
    const s = estado(el);
    const [tx = '0px', ty = '0px'] = s.orig.translate === 'none' ? [] : s.orig.translate.split(' ');
    el.style.setProperty('translate', `calc(${tx} + ${s.dx}px) calc(${ty} + ${s.dy}px)`, 'important');
    el.style.setProperty('rotate', `${s.orig.rotate + s.rot}deg`, 'important');
    if (s.largura != null) {
      el.style.setProperty('width', `${s.largura}px`, 'important');
      el.style.setProperty('max-width', 'none', 'important');
      if (el.tagName === 'IMG' && s.altura == null) el.style.setProperty('height', 'auto', 'important');
    }
    if (s.altura != null) el.style.setProperty('height', `${s.altura}px`, 'important');
    if (s.opacidade != null) el.style.setProperty('opacity', String(s.opacidade), 'important');
    // Espelhar usa a propriedade scale, que se soma ao transform que a página já tenha.
    const [sx = '1', sy = sx] = s.orig.scale === 'none' ? [] : s.orig.scale.split(' ');
    el.style.setProperty('scale', `${s.espelhado ? -num(sx, 1) : num(sx, 1)} ${num(sy, 1)}`, 'important');
    // Remover só esconde na tela; desfazer ou "Restaurar este" traz de volta.
    if (s.removido) el.style.setProperty('display', 'none', 'important');
    else if (el.style.getPropertyPriority('display') === 'important' && el.style.display === 'none') el.style.removeProperty('display');
    atualizarPainel();
  }
  function restaurar(el) {
    const s = alteracoes.get(el);
    if (!s) return;
    // Imagem adicionada pelo editor: restaurar é tirar de vez.
    if (s.novo) { el.remove(); alteracoes.delete(el); if (selecionado === el) selecionado = null; return; }
    if (s.orig.estiloInline == null) el.removeAttribute('style'); else el.setAttribute('style', s.orig.estiloInline);
    alteracoes.delete(el);
  }
  const mudou = (s) => s.novo || s.removido || s.espelhado || s.dx || s.dy || s.rot || s.largura != null || s.altura != null || s.opacidade != null;
  function espelhar(el) {
    if (!el) return;
    guardarDesfazer(el);
    const s = estado(el);
    s.espelhado = !s.espelhado;
    aplicar(el);
  }

  /* "+ Imagem": entra na mesma camada do elemento escolhido (ex.: junto das gravuras de fundo),
     no meio da tela, com a largura dele; sem nada escolhido, vai solta na página. */
  async function escolherArquivo() {
    if (window.__ajusteEscolherImagem) return window.__ajusteEscolherImagem();
    return new Promise((ok) => {
      const entrada = document.createElement('input');
      entrada.type = 'file';
      entrada.accept = 'image/*';
      entrada.onchange = () => {
        const f = entrada.files?.[0];
        ok(f ? { caminho: f.name, nome: f.name, url: URL.createObjectURL(f) } : null);
      };
      entrada.click();
    });
  }
  async function adicionarImagem() {
    const arquivo = await escolherArquivo().catch(() => null);
    if (!arquivo) return;
    const referencia = selecionado && !grande(selecionado) && selecionado.isConnected ? selecionado : null;
    const pai = referencia?.parentElement ?? document.body;
    const img = new Image();
    img.src = arquivo.url;
    img.alt = '';
    img.setAttribute('data-ajuste-novo', arquivo.nome);
    const largura = Math.round(referencia ? Math.min(referencia.offsetWidth || 240, 600) : 240);
    const cs = referencia ? getComputedStyle(referencia) : null;
    Object.assign(img.style, {
      position: 'absolute', display: 'block', width: `${largura}px`, height: 'auto', maxWidth: 'none',
      zIndex: cs?.zIndex && cs.zIndex !== 'auto' ? cs.zIndex : '', opacity: cs ? cs.opacity : '1', pointerEvents: 'none',
    });
    // Coloca primeiro e mede a referência de posição (o ancestral posicionado), para centralizar na tela.
    pai.appendChild(img);
    if (!img.complete) await new Promise((ok) => { img.onload = ok; img.onerror = ok; });
    const base = (img.offsetParent ?? document.documentElement).getBoundingClientRect();
    const left = Math.round(innerWidth / 2 - base.left - largura / 2);
    const top = Math.round(innerHeight / 2 - base.top - img.offsetHeight / 2);
    Object.assign(img.style, { left: `${left}px`, top: `${top}px` });
    const s = estado(img);
    s.novo = {
      nome: arquivo.nome, caminho: arquivo.caminho, left, top, largura,
      pai: seletor(pai), referencia: referencia ? descrever(referencia) : null,
      base: img.offsetParent ? seletor(img.offsetParent) : 'a página',
    };
    selecionar(img);
    aplicar(img);
    avisar(`Imagem adicionada: ${arquivo.nome}. Arraste, redimensione ou gire à vontade.`);
  }
  function remover(el) {
    if (!el) return;
    guardarDesfazer(el);
    estado(el).removido = true;
    aplicar(el);
    avisar('Removido da tela. Ctrl+Z ou "Restaurar este" traz de volta.');
  }

  /* ---------- escolha do elemento ---------- */
  const dentroDaUi = (e) => e.composedPath().includes(host);
  /* Elementos sob o ponto: primeiro os que recebem clique (de cima para baixo), depois os
     "escondidos" (pointer-events: none ou atrás de outros), do menor para o maior. */
  let fundo = [];
  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
  /* Seções, main e outros blocos que ocupam mais de meia tela ficam por último: clicar
     no "vazio" de uma seção pega o que está embaixo, e não a seção inteira. */
  const grande = (el) => area(el) > innerWidth * innerHeight * 0.5;
  const dentro = (el, x, y) => { const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
  function elementosNoPonto(x, y) {
    const topo = document.elementsFromPoint(x, y).filter((el) => el !== host && el !== document.documentElement && el !== document.body);
    const resto = [...document.body.querySelectorAll('*')].filter((el) => {
      if (el === host || topo.includes(el)) return false;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || !dentro(el, x, y)) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    }).sort((a, b) => area(a) - area(b));
    fundo = resto.filter((el) => !grande(el));
    const todos = [...topo, ...resto];
    return [...todos.filter((el) => !grande(el)), ...todos.filter(grande)].slice(0, 25);
  }
  function selecionar(el) {
    selecionado = el;
    atualizarPainel();
  }

  /* ---------- interface ---------- */
  function criarUi() {
    host = document.createElement('div');
    host.setAttribute('data-ajuste-visual', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    raiz = host.attachShadow({ mode: 'open' });
    raiz.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font: 12px/1.4 system-ui, sans-serif; }
        .caixa { position: fixed; pointer-events: none; display: none; }
        .hover { outline: 1px dashed #2b7fff; background: rgba(43,127,255,.06); }
        .sel { outline: 2px solid #ff5a1f; background: rgba(255,90,31,.05); }
        .alca { pointer-events: auto; position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; background: #ff5a1f; border: 2px solid #fff; border-radius: 3px; }
        .alca[data-a="nw"] { left: 0; top: 0; cursor: nwse-resize; }
        .alca[data-a="n"]  { left: 50%; top: 0; cursor: ns-resize; }
        .alca[data-a="ne"] { left: 100%; top: 0; cursor: nesw-resize; }
        .alca[data-a="e"]  { left: 100%; top: 50%; cursor: ew-resize; }
        .alca[data-a="se"] { left: 100%; top: 100%; cursor: nwse-resize; }
        .alca[data-a="s"]  { left: 50%; top: 100%; cursor: ns-resize; }
        .alca[data-a="sw"] { left: 0; top: 100%; cursor: nesw-resize; }
        .alca[data-a="w"]  { left: 0; top: 50%; cursor: ew-resize; }
        .painel { position: fixed; right: 12px; bottom: 12px; width: 300px; max-height: 80vh; display: flex; flex-direction: column; pointer-events: auto;
          background: #1d1d1f; color: #f2f2f2; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.35); padding: 8px 10px; }
        .corpo { overflow: auto; min-height: 0; }
        .painel.min .corpo { display: none; }
        .topo { display: flex; align-items: center; gap: 6px; font-weight: 600; cursor: move; user-select: none; padding-bottom: 4px; }
        .topo span { flex: 1; }
        .topo button { padding: 2px 8px; }
        .dica { display: none; color: #a0a0a5; margin: 4px 0; }
        .painel.ajuda .dica { display: block; }
        .info { background: #2a2a2d; border-radius: 6px; padding: 5px 8px; margin: 4px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .info b { color: #ffb08a; font-weight: 600; }
        .info small { display: block; color: #a0a0a5; }
        .lista { margin: 2px 0; padding: 0; list-style: none; max-height: 132px; overflow: auto; }
        .lista li { padding: 2px 6px; border-radius: 4px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .lista li .g { color: #7d7d84; }
        .lista li:hover { background: #333; }
        .lista li.on { background: #ff5a1f33; color: #ffb08a; }
        button { background: #3a3a3d; color: #fff; border: 0; border-radius: 6px; padding: 5px 9px; cursor: pointer; }
        button:hover { background: #4a4a4e; }
        button.forte { background: #ff5a1f; }
        .botoes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .aviso { color: #8fe3a5; margin-top: 6px; min-height: 1em; word-break: break-all; }
        h4 { margin: 8px 0 2px; font-weight: 600; color: #c9c9cf; }
        .ui { display: none; }
        :host(.on) .ui { display: block; }
        .pilula { position: fixed; left: 12px; bottom: 12px; pointer-events: auto; padding: 8px 14px; border-radius: 999px;
          background: #1d1d1f; color: #fff; font-weight: 600; box-shadow: 0 6px 18px rgba(0,0,0,.3); }
        :host(.on) .pilula { background: #ff5a1f; }
      </style>
      <button class="pilula" data-acao="alternar" title="Ctrl+Shift+E">✎ Ajuste visual</button>
      <div class="ui">
      <div class="caixa hover"></div>
      <div class="caixa sel">${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((a) => `<div class="alca" data-a="${a}"></div>`).join('')}</div>
      <div class="painel">
        <div class="topo" title="Arraste para mover o painel"><span>⠿ Ajuste visual</span><button data-acao="ajuda" title="Atalhos">?</button><button data-acao="min" title="Recolher">–</button></div>
        <div class="corpo">
          <div class="dica">Clique num elemento e arraste. Alt+clique: pega o que está escondido atrás (repita para ir mais fundo). Alças laranja: tamanho (lados: só largura ou altura; cantos: os dois, Shift solta a proporção). Ctrl+rodinha: tamanho · Shift+rodinha: girar · Alt+rodinha: opacidade · setas: 1px (Shift 10px) · [ e ]: elemento de trás/da frente · Ctrl+Z: desfazer · Delete: remover · H: espelhar · + Imagem: adiciona uma imagem de uma pasta na camada do elemento escolhido · Esc: soltar · Ctrl+Shift+E: desligar.</div>
          <div class="info sel-info">Nenhum elemento escolhido.</div>
          <h4>Elementos neste ponto</h4>
          <ul class="lista candidatos"></ul>
          <h4>Alterados (<span class="total">0</span>)</h4>
          <ul class="lista alterados"></ul>
          <div class="botoes">
            <button class="forte" data-acao="copiar">Copiar alterações</button>
            <button data-acao="desfazer">Desfazer</button>
            <button data-acao="imagem" title="Escolher uma imagem de uma pasta e colocar na página">+ Imagem</button>
            <button data-acao="espelhar" title="H">Espelhar</button>
            <button data-acao="remover" title="Delete">Remover</button>
            <button data-acao="restaurar">Restaurar este</button>
            <button data-acao="limpar">Limpar tudo</button>
            <button data-acao="anim">Parar animações</button>
          </div>
          <div class="aviso"></div>
        </div>
      </div>
      </div>`;
    document.documentElement.appendChild(host);
    caixaHover = raiz.querySelector('.hover');
    caixaSel = raiz.querySelector('.sel');
    painel = raiz.querySelector('.painel');

    raiz.addEventListener('click', (e) => {
      const acao = e.target.closest?.('[data-acao]')?.dataset.acao;
      if (acao === 'alternar') alternar();
      if (acao === 'min') { painel.classList.toggle('min'); guardarPainel(); }
      if (acao === 'ajuda') { painel.classList.toggle('ajuda'); guardarPainel(); }
      if (acao === 'copiar') copiar();
      if (acao === 'desfazer') voltar();
      if (acao === 'restaurar' && selecionado) { restaurar(selecionado); atualizarPainel(); }
      if (acao === 'remover') remover(selecionado);
      if (acao === 'espelhar') espelhar(selecionado);
      if (acao === 'imagem') adicionarImagem();
      if (acao === 'limpar') { [...alteracoes.keys()].forEach(restaurar); desfazer.length = 0; atualizarPainel(); }
      if (acao === 'anim') alternarAnimacoes(e.target);
      const item = e.target.closest?.('li[data-i]');
      if (item) {
        const lista = item.parentElement.classList.contains('alterados') ? [...alteracoes.keys()] : candidatos;
        selecionar(lista[Number(item.dataset.i)]);
        selecionado?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
    caixaSel.addEventListener('pointerdown', (e) => {
      if (e.target.dataset?.a) iniciarArrasto(e, e.target.dataset.a);
    });

    // Painel arrastável pelo título; posição e estado ficam guardados neste site.
    const topo = raiz.querySelector('.topo');
    topo.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = painel.getBoundingClientRect();
      const inicio = { x: e.clientX - r.left, y: e.clientY - r.top };
      const mover = (ev) => {
        const left = Math.min(Math.max(0, ev.clientX - inicio.x), innerWidth - 60);
        const top = Math.min(Math.max(0, ev.clientY - inicio.y), innerHeight - 30);
        Object.assign(painel.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
      };
      const soltar = () => { removeEventListener('pointermove', mover, true); removeEventListener('pointerup', soltar, true); guardarPainel(); };
      addEventListener('pointermove', mover, true);
      addEventListener('pointerup', soltar, true);
    });
    try {
      const salvo = JSON.parse(localStorage.getItem('ajusteVisualPainel') || 'null');
      if (salvo?.left) Object.assign(painel.style, { left: salvo.left, top: salvo.top, right: 'auto', bottom: 'auto' });
      painel.classList.toggle('min', !!salvo?.min);
      painel.classList.toggle('ajuda', !!salvo?.ajuda);
    } catch { /* sem armazenamento: painel no lugar padrão */ }
  }

  function guardarPainel() {
    try {
      localStorage.setItem('ajusteVisualPainel', JSON.stringify({
        left: painel.style.left, top: painel.style.top,
        min: painel.classList.contains('min'), ajuda: painel.classList.contains('ajuda'),
      }));
    } catch { /* sem armazenamento: só não lembra a posição */ }
  }

  function alternarAnimacoes(botao) {
    animacoesParadas = !animacoesParadas;
    if (animacoesParadas) {
      estiloAnim = document.createElement('style');
      estiloAnim.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
      document.head.appendChild(estiloAnim);
    } else estiloAnim?.remove();
    botao.textContent = animacoesParadas ? 'Voltar animações' : 'Parar animações';
  }

  function posicionar(caixa, el) {
    if (!el || !el.isConnected) { caixa.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(caixa.style, { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  let ultimoHover = null;
  function laco() {
    if (!ligado) return;
    posicionar(caixaHover, arrasto ? null : ultimoHover !== selecionado ? ultimoHover : null);
    posicionar(caixaSel, selecionado);
    requestAnimationFrame(laco);
  }

  /* Nome curto para o painel: arquivo da imagem, #id ou a primeira classe, mais um pedaço
     de texto quando ajuda a reconhecer (ex.: título de um card). O nome completo fica no title. */
  const html = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  function rotulo(el) {
    const tag = el.tagName.toLowerCase();
    const nome = el.id ? `#${el.id}` : el.classList[0] ? `${tag}.${el.classList[0]}` : tag;
    const arquivo = arquivoDe(el);
    if (arquivo) return { nome: arquivo.replace(/\.(webp|png|jpe?g|svg|gif|avif)$/i, ''), extra: tag };
    const t = textoCurto(el);
    return { nome, extra: t && !grande(el) ? t.slice(0, 28) : grande(el) ? 'bloco grande' : '' };
  }
  const lista = (els) => els.map((el, i) => {
    const r = rotulo(el);
    return `<li data-i="${i}" class="${el === selecionado ? 'on' : ''}" title="${html(descrever(el) + '\n' + seletor(el))}">${html(r.nome)}${r.extra ? ` <span class="g">· ${html(r.extra)}</span>` : ''}</li>`;
  }).join('');

  function atualizarPainel() {
    if (!raiz) return;
    const info = raiz.querySelector('.sel-info');
    if (selecionado) {
      const s = alteracoes.get(selecionado);
      const r = selecionado.getBoundingClientRect();
      const n = rotulo(selecionado);
      info.title = descrever(selecionado);
      info.innerHTML = `<b>${html(n.nome)}</b>${n.extra ? ` <span>· ${html(n.extra)}</span>` : ''}` +
        `<small>${Math.round(r.width)}×${Math.round(r.height)}px` +
        (s?.removido ? ' · removido' : '') +
        (s && mudou(s) && !s.removido ? ` · moveu ${s.dx}, ${s.dy}px` + (s.rot ? ` · girou ${s.rot}°` : '') + (s.opacidade != null ? ` · opac. ${s.opacidade}` : '') : '') + '</small>';
    } else info.textContent = 'Nenhum elemento escolhido.';
    raiz.querySelector('.candidatos').innerHTML = lista(candidatos);
    // Mostra só o que de fato mudou (escolher um elemento sem mexer não conta).
    if (!arrasto) for (const [el, s] of alteracoes) if (!mudou(s)) restaurar(el);
    const alterados = [...alteracoes.keys()];
    raiz.querySelector('.alterados').innerHTML = lista(alterados);
    raiz.querySelector('.total').textContent = String([...alteracoes.values()].filter(mudou).length);
  }
  const avisar = (texto) => { raiz.querySelector('.aviso').textContent = texto; };

  /* ---------- arrastar, redimensionar ---------- */
  function iniciarArrasto(e, modo) {
    if (!selecionado) return;
    e.preventDefault();
    e.stopPropagation();
    const el = selecionado;
    guardarDesfazer(el);
    const s = estado(el);
    const r = el.getBoundingClientRect();
    arrasto = { el, modo, x: e.clientX, y: e.clientY, dx: s.dx, dy: s.dy,
      largura: s.largura ?? s.orig.larguraCss, altura: s.altura ?? (el.offsetHeight || r.height), proporcao: r.height / r.width };
    try { caixaSel.setPointerCapture(e.pointerId); } catch { /* segue sem captura */ }
  }
  window.addEventListener('pointermove', (e) => {
    if (!ligado) return;
    if (arrasto) {
      const s = estado(arrasto.el);
      const mx = Math.round(e.clientX - arrasto.x), my = Math.round(e.clientY - arrasto.y);
      const a = arrasto.modo;
      if (a === 'mover') { s.dx = arrasto.dx + mx; s.dy = arrasto.dy + my; }
      else {
        // Lado puxado cresce; o lado oposto fica parado (compensa com o deslocamento).
        const horizontal = a.includes('e') ? mx : a.includes('w') ? -mx : 0;
        const vertical = a.includes('s') ? my : a.includes('n') ? -my : 0;
        let largura = arrasto.largura + horizontal;
        let altura = arrasto.altura + vertical;
        const canto = a.length === 2;
        // Imagem pelo canto mantém a proporção (Shift solta).
        if (canto && arrasto.el.tagName === 'IMG' && !e.shiftKey) altura = largura * arrasto.proporcao;
        largura = Math.max(4, Math.round(largura));
        altura = Math.max(4, Math.round(altura));
        if (horizontal) s.largura = largura;
        if (vertical || (canto && arrasto.el.tagName === 'IMG')) s.altura = altura;
        if (a.includes('w')) s.dx = arrasto.dx + (arrasto.largura - largura);
        if (a.includes('n')) s.dy = arrasto.dy + (arrasto.altura - altura);
      }
      aplicar(arrasto.el);
      return;
    }
    if (dentroDaUi(e)) { ultimoHover = null; return; }
    const sob = document.elementsFromPoint(e.clientX, e.clientY).filter((el) => el !== host && el !== document.documentElement && el !== document.body);
    ultimoHover = sob.find((el) => !grande(el)) ?? null;
  }, true);
  window.addEventListener('pointerup', () => {
    if (!arrasto) return;
    arrasto = null;
    atualizarPainel();
  }, true);

  /* Bloqueia cliques da página enquanto o editor está ligado e escolhe o elemento. */
  let altAnterior = null;
  const bloquear = (e) => {
    if (!ligado || dentroDaUi(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerup', 'contextmenu', 'auxclick'].forEach((t) => window.addEventListener(t, bloquear, true));
  window.addEventListener('pointerdown', (e) => {
    if (!ligado || dentroDaUi(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Clicar dentro do elemento já escolhido arrasta ele mesmo, mesmo que esteja atrás de outro
    // (ex.: gravura de fundo escolhida pela lista ou com Alt+clique).
    if (!e.altKey && selecionado && !grande(selecionado) && dentro(selecionado, e.clientX, e.clientY)) {
      iniciarArrasto(e, 'mover');
      return;
    }
    candidatos = elementosNoPonto(e.clientX, e.clientY);
    // Alt+clique: pega o que fica escondido no ponto (ex.: decoração de fundo atrás dos cards).
    // Repetir o Alt+clique no mesmo lugar passa para a próxima camada.
    let escolhido = candidatos[0];
    if (e.altKey && fundo.length) {
      const mesmoPonto = altAnterior && Math.hypot(e.clientX - altAnterior.x, e.clientY - altAnterior.y) < 6;
      const i = mesmoPonto ? (altAnterior.i + 1) % fundo.length : 0;
      altAnterior = { x: e.clientX, y: e.clientY, i };
      escolhido = fundo[i];
    }
    selecionar(escolhido ?? null);
    if (escolhido) iniciarArrasto(e, 'mover');
  }, true);

  /* ---------- rodinha e teclado ---------- */
  window.addEventListener('wheel', (e) => {
    if (!ligado || !selecionado || !(e.ctrlKey || e.shiftKey || e.altKey)) return;
    e.preventDefault();
    const el = selecionado;
    guardarDesfazer(el);
    const s = estado(el);
    const passo = (e.deltaY || e.deltaX) > 0 ? -1 : 1;
    if (e.ctrlKey) {
      const atual = s.largura ?? s.orig.larguraCss;
      s.largura = Math.max(4, Math.round(atual * (1 + passo * 0.05)));
    } else if (e.shiftKey) s.rot += passo * 2;
    else if (e.altKey) s.opacidade = Math.min(1, Math.max(0, Math.round(((s.opacidade ?? s.orig.opacidade) + passo * 0.02) * 100) / 100));
    aplicar(el);
  }, { capture: true, passive: false });

  function voltar() {
    const passo = desfazer.pop();
    if (!passo) return;
    Object.assign(estado(passo.el), passo.antes);
    aplicar(passo.el);
    selecionar(passo.el);
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyE') { e.preventDefault(); alternar(); return; }
    if (!ligado) return;
    const alvo = e.composedPath()[0];
    if (alvo instanceof HTMLElement && (alvo.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(alvo.tagName))) return;
    if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); voltar(); return; }
    if (e.key === 'Escape') { selecionar(null); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selecionado) { e.preventDefault(); remover(selecionado); return; }
    if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.altKey && selecionado) { e.preventDefault(); espelhar(selecionado); return; }
    if ((e.key === '[' || e.key === ']') && candidatos.length) {
      const i = candidatos.indexOf(selecionado);
      selecionar(candidatos[(i + (e.key === ']' ? -1 : 1) + candidatos.length) % candidatos.length]);
      e.preventDefault();
      return;
    }
    const setas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (selecionado && setas[e.key]) {
      e.preventDefault();
      const passo = e.shiftKey ? 10 : 1;
      guardarDesfazer(selecionado);
      const s = estado(selecionado);
      s.dx += setas[e.key][0] * passo;
      s.dy += setas[e.key][1] * passo;
      aplicar(selecionado);
    }
  }, true);

  function alternar() {
    ligado = !ligado;
    if (!host) criarUi();
    host.classList.toggle('on', ligado);
    raiz.querySelector('.pilula').textContent = ligado ? '✕ Desligar ajuste' : '✎ Ajuste visual';
    document.documentElement.style.cursor = ligado ? 'crosshair' : '';
    if (ligado) { atualizarPainel(); requestAnimationFrame(laco); }
  }

  /* O botão fica sempre na página; sites que trocam o documento (ex.: navegação sem recarregar)
     podem tirá-lo, então ele é recolocado quando some. */
  const garantirUi = () => {
    if (!document.documentElement) return;
    if (!host) criarUi();
    else if (!host.isConnected) document.documentElement.appendChild(host);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', garantirUi);
  else garantirUi();
  setInterval(garantirUi, 1000);

  /* ---------- texto das alterações ---------- */
  function relatorio() {
    // Imagem nova que depois foi removida não entra no texto.
    const itens = [...alteracoes.entries()].filter(([, s]) => mudou(s) && !(s.novo && s.removido));
    const linhas = [
      'Ajuste visual — alterações feitas na tela',
      `Página: ${location.href}`,
      `Tela: ${innerWidth}×${innerHeight}px · ${new Date().toLocaleString('pt-BR')}`,
      'Aplique no código-fonte que gera estes elementos. Os valores são relativos à posição original, nesta largura de tela.',
      '',
    ];
    itens.forEach(([el, s], i) => {
      const o = s.orig;
      if (s.novo) {
        // Imagem nova: valores finais (não deltas), sem rotação no left/top.
        const n = s.novo;
        const largura = s.largura ?? n.largura;
        const extras = [
          s.rot ? `rotação ${s.rot}°` : '',
          s.opacidade != null ? `opacidade ${s.opacidade}` : o.opacidade !== 1 ? `opacidade ${o.opacidade}` : '',
          s.espelhado ? 'espelhada na horizontal' : '',
        ].filter(Boolean);
        linhas.push(
          `${i + 1}. ADICIONAR imagem nova  [${n.nome}]`,
          `   arquivo: ${n.caminho}`,
          `   colocar dentro de: ${n.pai}` + (n.referencia ? ` (mesma camada de ${n.referencia})` : ''),
          `   posição absoluta em relação a ${n.base}: left ${n.left + s.dx}px, top ${n.top + s.dy}px`,
          `   largura: ${largura}px` + (s.altura != null ? ` · altura ${s.altura}px` : ' · altura automática') + (extras.length ? ` · ${extras.join(' · ')}` : ''),
          '',
        );
        return;
      }
      const partes = [];
      if (s.dx || s.dy) {
        const h = s.dx ? `${Math.abs(s.dx)}px para a ${s.dx > 0 ? 'direita' : 'esquerda'}` : '';
        const v = s.dy ? `${Math.abs(s.dy)}px para ${s.dy > 0 ? 'baixo' : 'cima'}` : '';
        partes.push(`   mover: ${[h, v].filter(Boolean).join(', ')}`);
      }
      if (s.largura != null) partes.push(`   largura: ${Math.round(o.larguraCss)}px → ${s.largura}px (${s.largura - Math.round(o.larguraCss) >= 0 ? '+' : ''}${s.largura - Math.round(o.larguraCss)}px)`);
      if (s.altura != null) partes.push(`   altura: ${Math.round(o.alturaCss)}px → ${s.altura}px (${s.altura - Math.round(o.alturaCss) >= 0 ? '+' : ''}${s.altura - Math.round(o.alturaCss)}px)`);
      if (s.rot) partes.push(`   girar: ${s.rot > 0 ? '+' : ''}${s.rot}° a mais que a rotação atual (${s.rot > 0 ? 'sentido horário' : 'anti-horário'})`);
      if (s.opacidade != null) partes.push(`   opacidade: ${o.opacidade} → ${s.opacidade}`);
      if (s.espelhado) partes.push('   espelhar: inverter na horizontal');
      // Removido vale mais que qualquer outro ajuste no mesmo elemento.
      if (s.removido) partes.splice(0, partes.length, '   remover: tirar este elemento da página');
      linhas.push(
        `${i + 1}. ${descrever(el)}`,
        `   seletor: ${seletor(el)}`,
        `   posição original na página: x ${o.x}px, y ${o.y}px · tamanho ${Math.round(o.largura)}×${Math.round(o.altura)}px`,
        ...partes,
        '',
      );
    });
    if (!itens.length) linhas.push('(nenhuma alteração)');
    return linhas.join('\n');
  }
  async function copiar() {
    const texto = relatorio();
    try {
      if (window.__ajusteSalvar) {
        const arquivo = await window.__ajusteSalvar(texto);
        avisar(`Copiado. Também salvo em ${arquivo}`);
      } else {
        await navigator.clipboard.writeText(texto);
        avisar('Copiado para a área de transferência.');
      }
    } catch (erro) {
      console.log(texto);
      avisar(`Não consegui copiar (${erro.message}). O texto está no console (F12).`);
    }
  }
})();
