/* Ajuste visual — editor injetado em qualquer página.
   Ctrl+Shift+E liga/desliga. Clique para escolher um elemento e arraste para mover.
   As mudanças são só na tela; "Copiar alterações" gera um texto para um agente aplicar no código. */
(() => {
  /* Moldura de tela (Celular, Tablet, Notebook): a página abre num quadro com a largura escolhida
     dentro de /__ajuste-tela, e o painel fica na moldura, ao lado do quadro. O editor roda no quadro. */
  const ENDERECO_MOLDURA = '/__ajuste-tela';
  if (window.top === window && location.pathname === ENDERECO_MOLDURA) return;
  const moldura = window.top !== window && (() => {
    try { return window.parent === window.top && window.parent.location.pathname === ENDERECO_MOLDURA; } catch { return false; }
  })();
  if ((window.top !== window && !moldura) || window.__ajusteVisual) return;
  window.__ajusteVisual = true;
  // Onde ficam o painel e o botão: na moldura, quando há uma; senão, na própria página.
  const janelaUi = moldura ? window.parent : window;
  const docUi = janelaUi.document;

  const alteracoes = new Map(); // elemento -> estado
  const desfazer = [];
  let ligado = false;
  let selecionado = null;
  const extras = new Set(); // outros elementos escolhidos com Shift+clique, além do selecionado
  let candidatos = [];
  let arrasto = null;
  let animacoesParadas = false;
  // host: as caixas de seleção, na página. hostPainel: o painel e o botão (o mesmo host fora da moldura).
  // raiz procura nos dois, para o resto do código não precisar saber onde cada parte está.
  let host, hostPainel, raiz, caixaHover, caixaSel, painel, estiloAnim;

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
  /* Arquivo (e linha, quando há) do código que gerou o elemento, se o servidor de desenvolvimento
     marcar: Astro (data-astro-source-*), React até a 18 (_debugSource), Vue e Svelte (só o arquivo).
     Sem marca no próprio elemento, sobe pelos ancestrais e diz de qual veio. */
  function origemDireta(n) {
    const astro = n.getAttribute('data-astro-source-file');
    if (astro) {
      const linha = (n.getAttribute('data-astro-source-loc') || '').split(':')[0];
      return linha ? `${astro}:${linha}` : astro;
    }
    const chave = Object.keys(n).find((k) => k.startsWith('__reactFiber$'));
    for (let f = chave ? n[chave] : null; f; f = f.return) {
      if (f._debugSource) return `${f._debugSource.fileName}:${f._debugSource.lineNumber}`;
    }
    return n.__vueParentComponent?.type?.__file || n.__svelte_meta?.loc?.file || '';
  }
  function origemDe(el) {
    for (let n = el, nivel = 0; n && n.nodeType === 1 && nivel < 20; n = n.parentElement, nivel++) {
      const local = origemDireta(n);
      if (local) return nivel ? `${local} (marca do ancestral <${n.tagName.toLowerCase()}${n.classList[0] ? `.${n.classList[0]}` : ''}>)` : local;
    }
    return '';
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
  // Posição e tamanho na página (não na tela), para comparar depois de recarregar.
  const medir = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), largura: Math.round(r.width), altura: Math.round(r.height) };
  };
  /* Posição de layout, sem o transform: as animações da página (parallax com GSAP, por exemplo)
     mudam o transform conforme a rolagem, e a conferência ao recarregar ou trocar de tela não pode
     depender de onde a página estava rolada. Soma a propriedade translate, que é a que o editor usa
     e a que o CSS final sugere; a rotação é conferida à parte, pela propriedade rotate. */
  const deslocamento = (v, tamanho) => {
    let total = 0;
    for (const [, n, u] of v.replace(/-\s+/g, '-').matchAll(/(-?[\d.]+)(px|%)/g)) total += u === '%' ? num(n) * tamanho / 100 : num(n);
    return total;
  };
  const medirLayout = (el) => {
    if (!(el instanceof HTMLElement)) return medir(el);
    let x = 0, y = 0;
    for (let n = el; n; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
    const cs = getComputedStyle(el);
    const [tx = '0px', ty = '0px'] = cs.translate === 'none' ? [] : cs.translate.match(/calc\([^)]*\)|\S+/g);
    return {
      x: Math.round(x + deslocamento(tx, el.offsetWidth)), y: Math.round(y + deslocamento(ty, el.offsetHeight)),
      largura: el.offsetWidth, altura: el.offsetHeight,
    };
  };
  // Lado para onde o elemento aponta na horizontal (-1 = já espelhado pela página), somando transform e scale.
  const sinalHorizontal = (cs) => {
    const m = cs.transform.match(/matrix\(([^,]+)/);
    return Math.sign((m ? num(m[1], 1) : 1) * (cs.scale === 'none' ? 1 : num(cs.scale.split(' ')[0], 1))) || 1;
  };
  // Propriedades que o painel "Estilo" deixa mudar, com o nome que aparece no texto.
  const PROPRIEDADES = [
    ['color', 'cor do texto'], ['background-color', 'cor de fundo'], ['font-size', 'tamanho da fonte'],
    ['font-weight', 'peso da fonte'], ['line-height', 'altura da linha'], ['letter-spacing', 'espaço entre letras'],
    ['padding', 'espaço interno (padding)'], ['margin', 'margem (margin)'], ['border-radius', 'arredondamento'],
    ['z-index', 'camada (z-index)'], ['position', 'posicionamento (position)'],
  ];
  const nomeProp = Object.fromEntries(PROPRIEDADES);
  function estado(el) {
    if (!alteracoes.has(el)) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      alteracoes.set(el, {
        dx: 0, dy: 0, rot: 0, removido: false, espelhado: false, novo: null,
        largura: null, altura: null, opacidade: null, texto: null, estilos: {}, nota: '',
        orig: {
          descricao: descrever(el), seletor: seletor(el),
          estilos: Object.fromEntries(PROPRIEDADES.map(([p]) => [p, cs.getPropertyValue(p)])),
          sinal: sinalHorizontal(cs),
          // Para o CSS final: como a página já posiciona e gira o elemento, e a largura do contêiner.
          posicao: cs.position,
          rotacaoTransform: (() => { const m = cs.transform.match(/matrix\(([^,]+),\s*([^,]+)/); return m ? Math.round(Math.atan2(num(m[2]), num(m[1])) * 180 / Math.PI) : 0; })(),
          larguraPai: Math.round((el.offsetParent ?? el.parentElement ?? document.documentElement).clientWidth),
          estiloInline: el.getAttribute('style'),
          translate: cs.translate,
          rotate: num(cs.rotate),
          scale: cs.scale,
          largura: r.width, altura: r.height,
          larguraCss: el.offsetWidth || r.width,
          alturaCss: el.offsetHeight || r.height,
          opacidade: num(cs.opacity, 1),
          x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY),
          layout: medirLayout(el),
        },
      });
    }
    return alteracoes.get(el);
  }
  const copia = (s) => ({
    dx: s.dx, dy: s.dy, rot: s.rot, largura: s.largura, altura: s.altura, opacidade: s.opacidade, removido: s.removido,
    espelhado: s.espelhado, texto: s.texto, estilos: { ...s.estilos }, nota: s.nota, porque: s.porque,
  });
  // Um passo de desfazer pode ter vários elementos (ex.: mover a seleção inteira).
  function guardarDesfazer(els) {
    const lista = (Array.isArray(els) ? els : [els]).filter(Boolean);
    if (!lista.length) return;
    desfazer.push(lista.map((el) => ({ el, antes: copia(estado(el)) })));
    if (desfazer.length > 200) desfazer.shift();
  }
  // Valor que a página tinha no atributo style para uma propriedade (para devolver ao desfazer um estilo).
  function inlineOriginal(s, prop) {
    if (!s.orig.inline) {
      const tmp = document.createElement('div');
      tmp.setAttribute('style', s.orig.estiloInline ?? '');
      s.orig.inline = Object.fromEntries(PROPRIEDADES.map(([p]) => [p, [tmp.style.getPropertyValue(p), tmp.style.getPropertyPriority(p)]]));
    }
    return s.orig.inline[prop];
  }
  function aplicar(el) {
    const s = estado(el);
    for (const [p] of PROPRIEDADES) {
      if (s.estilos[p] != null) el.style.setProperty(p, s.estilos[p], 'important');
      else if (el.style.getPropertyValue(p) !== inlineOriginal(s, p)[0]) el.style.setProperty(p, ...inlineOriginal(s, p));
    }
    // Texto editado: na edição o texto já está lá; ao desfazer ou reaplicar, troca ou devolve o original.
    if (s.texto != null) {
      s.orig.html ??= el.innerHTML;
      s.orig.texto ??= el.innerText;
      if (el.innerText !== s.texto && editando !== el) el.innerText = s.texto;
    }
    else if (s.orig.html != null && el.innerHTML !== s.orig.html && editando !== el) el.innerHTML = s.orig.html;
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
    agendarGuardar();
  }
  function restaurar(el) {
    const s = alteracoes.get(el);
    if (!s) return;
    agendarGuardar();
    extras.delete(el);
    // Imagem adicionada pelo editor: restaurar é tirar de vez.
    if (s.novo) { el.remove(); alteracoes.delete(el); if (selecionado === el) selecionado = null; return; }
    if (editando === el) terminarTexto();
    if (s.orig.html != null && el.innerHTML !== s.orig.html) el.innerHTML = s.orig.html;
    if (s.orig.estiloInline == null) el.removeAttribute('style'); else el.setAttribute('style', s.orig.estiloInline);
    alteracoes.delete(el);
  }
  const mudou = (s) => s.novo || s.removido || s.espelhado || s.dx || s.dy || s.rot || s.largura != null || s.altura != null ||
    s.opacidade != null || s.texto != null || Object.keys(s.estilos).length || s.nota;
  function espelhar(els) {
    if (!els.length) return;
    guardarDesfazer(els);
    for (const el of els) { estado(el).espelhado = !estado(el).espelhado; aplicar(el); }
  }

  /* Editar texto: duplo clique (ou "Editar texto") no elemento escolhido. Enter ou Esc termina;
     Shift+Enter quebra a linha. No texto sai o antes e o depois. */
  let editando = null;
  let editavelAntes = null;
  function editarTexto(el) {
    if (!el || editando || !textoCurto(el)) { if (el && !textoCurto(el)) avisar('Este elemento não tem texto para editar.'); return; }
    guardarDesfazer(el);
    const s = estado(el);
    s.orig.html ??= el.innerHTML;
    s.orig.texto ??= el.innerText;
    editando = el;
    editavelAntes = el.getAttribute('contenteditable');
    el.setAttribute('contenteditable', 'plaintext-only');
    el.focus();
    const faixa = document.createRange();
    faixa.selectNodeContents(el);
    getSelection().removeAllRanges();
    getSelection().addRange(faixa);
    el.addEventListener('blur', terminarTexto, { once: true });
    avisar('Editando o texto. Enter ou Esc termina; Shift+Enter quebra a linha.');
  }
  function terminarTexto() {
    const el = editando;
    if (!el) return;
    editando = null;
    if (editavelAntes == null) el.removeAttribute('contenteditable'); else el.setAttribute('contenteditable', editavelAntes);
    const s = estado(el);
    const novo = el.innerText;
    s.texto = novo === s.orig.texto ? null : novo;
    aplicar(el);
    avisar(s.texto != null ? 'Texto alterado.' : '');
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
  // Endereço de cada imagem nova (pelo caminho), para recriá-la ao trocar de tela sem ler o arquivo de novo.
  const urlsNovas = new Map();
  async function criarImagem(pai, url, nome, largura, estilo) {
    const img = new Image();
    img.src = url;
    img.alt = '';
    img.setAttribute('data-ajuste-novo', nome);
    Object.assign(img.style, {
      position: 'absolute', display: 'block', width: `${largura}px`, height: 'auto', maxWidth: 'none', pointerEvents: 'none', ...estilo,
    });
    pai.appendChild(img);
    if (!img.complete) await new Promise((ok) => { img.onload = ok; img.onerror = ok; });
    return img;
  }
  async function adicionarImagem() {
    if (window.__ajusteEscolherImagem) avisar('Abrindo a janela de arquivos do Windows…');
    const arquivo = await escolherArquivo().catch(() => null);
    if (!arquivo) { avisar(''); return; }
    urlsNovas.set(arquivo.caminho, arquivo.url);
    const referencia = selecionado && !grande(selecionado) && selecionado.isConnected ? selecionado : null;
    const pai = referencia?.parentElement ?? document.body;
    const largura = Math.round(referencia ? Math.min(referencia.offsetWidth || 240, 600) : 240);
    const cs = referencia ? getComputedStyle(referencia) : null;
    // Coloca primeiro e mede a referência de posição (o ancestral posicionado), para centralizar na tela.
    const img = await criarImagem(pai, arquivo.url, arquivo.nome, largura, {
      zIndex: cs?.zIndex && cs.zIndex !== 'auto' ? cs.zIndex : '', opacity: cs ? cs.opacity : '1',
    });
    const base = (img.offsetParent ?? document.documentElement).getBoundingClientRect();
    const left = Math.round(innerWidth / 2 - base.left - largura / 2);
    const top = Math.round(innerHeight / 2 - base.top - img.offsetHeight / 2);
    Object.assign(img.style, { left: `${left}px`, top: `${top}px` });
    const s = estado(img);
    s.novo = {
      nome: arquivo.nome, caminho: arquivo.caminho, left, top, largura,
      zIndex: img.style.zIndex, opacidade: img.style.opacity,
      pai: seletor(pai), referencia: referencia ? descrever(referencia) : null, codigo: origemDe(referencia ?? pai),
      base: img.offsetParent ? seletor(img.offsetParent) : 'a página',
    };
    selecionar(img);
    aplicar(img);
    avisar(`Imagem adicionada: ${arquivo.nome}. Arraste, redimensione ou gire à vontade.`);
  }
  function remover(els) {
    if (!els.length) return;
    guardarDesfazer(els);
    for (const el of els) { estado(el).removido = true; aplicar(el); }
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
    extras.clear();
    atualizarPainel();
  }
  // Seleção inteira: o escolhido primeiro, depois os do Shift+clique.
  const selecao = () => (selecionado ? [selecionado, ...extras] : []).filter((el) => el.isConnected);
  // Shift+clique põe ou tira um elemento da seleção.
  function alternarNaSelecao(el) {
    if (el === selecionado) { selecionado = [...extras][0] ?? null; extras.delete(selecionado); }
    else if (extras.has(el)) extras.delete(el);
    else if (!selecionado) selecionado = el;
    else extras.add(el);
    atualizarPainel();
  }
  /* Alinhar e distribuir a seleção, tomando como referência a caixa que envolve todos. */
  function alinhar(como) {
    const els = selecao();
    if (els.length < 2) return;
    guardarDesfazer(els);
    const caixas = els.map((el) => ({ el, r: el.getBoundingClientRect() }));
    const esq = Math.min(...caixas.map((c) => c.r.left)), dir = Math.max(...caixas.map((c) => c.r.right));
    const topo = Math.min(...caixas.map((c) => c.r.top)), base = Math.max(...caixas.map((c) => c.r.bottom));
    const mover = (c, x, y) => { const s = estado(c.el); s.dx += Math.round(x); s.dy += Math.round(y); aplicar(c.el); };
    for (const c of caixas) {
      if (como === 'esquerda') mover(c, esq - c.r.left, 0);
      if (como === 'centro') mover(c, (esq + dir) / 2 - (c.r.left + c.r.width / 2), 0);
      if (como === 'direita') mover(c, dir - c.r.right, 0);
      if (como === 'topo') mover(c, 0, topo - c.r.top);
      if (como === 'meio') mover(c, 0, (topo + base) / 2 - (c.r.top + c.r.height / 2));
      if (como === 'base') mover(c, 0, base - c.r.bottom);
    }
    // Distribuir: espaços iguais entre um e outro, mantendo os das pontas no lugar.
    if (como === 'distH' || como === 'distV') {
      const h = como === 'distH';
      const ordem = caixas.sort((a, b) => (h ? a.r.left - b.r.left : a.r.top - b.r.top));
      const tamanho = (c) => (h ? c.r.width : c.r.height);
      const espaco = ((h ? dir - esq : base - topo) - ordem.reduce((t, c) => t + tamanho(c), 0)) / (ordem.length - 1);
      let pos = h ? esq : topo;
      for (const c of ordem) {
        mover(c, h ? pos - c.r.left : 0, h ? 0 : pos - c.r.top);
        pos += tamanho(c) + espaco;
      }
    }
  }

  /* "Para frente" / "Para trás": passa o elemento por cima (ou por baixo) do próximo elemento que se
     sobrepõe a ele. Muitas vezes não adianta mudar a camada do próprio elemento, porque ele está dentro
     de um bloco que fica inteiro atrás do outro (cada bloco com camada própria é um "andar" separado).
     Então a camada vai no ramo certo: o ancestral dele que é irmão do ramo do outro elemento. */
  const camadaDe = (el) => { const z = getComputedStyle(el).zIndex; return z === 'auto' ? 0 : num(z); };
  // Vizinho mais próximo por cima e por baixo, olhando vários pontos do elemento.
  function vizinhosDeCamada(el) {
    const r = el.getBoundingClientRect();
    const antes = el.style.getPropertyValue('pointer-events');
    const prioridade = el.style.getPropertyPriority('pointer-events');
    // Gravuras de fundo costumam ter pointer-events: none e não apareceriam no teste de clique.
    el.style.setProperty('pointer-events', 'auto', 'important');
    const votos = { acima: new Map(), abaixo: new Map() };
    const contar = (mapa, n) => n && mapa.set(n, (mapa.get(n) ?? 0) + 1);
    try {
      for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) {
        const x = r.left + (r.width * i) / 6, y = r.top + (r.height * j) / 6;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        const pilha = document.elementsFromPoint(x, y)
          .filter((n) => n !== host && n !== document.documentElement && n !== document.body && !n.contains(el) && !el.contains(n));
        const todos = document.elementsFromPoint(x, y);
        const k = todos.indexOf(el);
        if (k < 0) continue;
        const acima = pilha.filter((n) => todos.indexOf(n) < k);
        const abaixo = pilha.filter((n) => todos.indexOf(n) > k);
        contar(votos.acima, acima[acima.length - 1]);
        contar(votos.abaixo, abaixo[0]);
      }
    } finally {
      el.style.setProperty('pointer-events', antes, prioridade);
    }
    const mais = (mapa) => [...mapa.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { acima: mais(votos.acima), abaixo: mais(votos.abaixo) };
  }
  // Os dois ramos que se encontram no ancestral comum: o do elemento e o do outro.
  function ramos(el, outro) {
    let a = el;
    while (a.parentElement && !a.parentElement.contains(outro)) a = a.parentElement;
    const comum = a.parentElement;
    let b = outro;
    while (b.parentElement && b.parentElement !== comum) b = b.parentElement;
    return [a, b];
  }
  function mudarCamada(para) {
    const el = selecionado;
    if (!el) return;
    const viz = vizinhosDeCamada(el);
    const outro = para === 'frente' ? viz.acima : viz.abaixo;
    if (!outro) { avisar(para === 'frente' ? 'Já está na frente de tudo o que se sobrepõe a ele.' : 'Já está atrás de tudo o que se sobrepõe a ele.'); return; }
    const [ramo, ramoOutro] = ramos(el, outro);
    const antes = medir(el);
    guardarDesfazer(ramo);
    const s = estado(ramo);
    const z = para === 'frente' ? camadaDe(ramoOutro) + 1 : camadaDe(ramoOutro) - 1;
    s.estilos['z-index'] = String(z);
    // z-index só vale em elemento posicionado; relative não tira o elemento do lugar.
    if (getComputedStyle(ramo).position === 'static') s.estilos.position = 'relative';
    s.porque = `${para === 'frente' ? 'trazer para a frente' : 'mandar para trás'} de ${descrever(ramoOutro)}` +
      (ramo !== el ? `, para que ${descrever(el)} (que está dentro deste) fique ${para === 'frente' ? 'na frente' : 'atrás'}` : '');
    aplicar(ramo);
    // Se o position: relative mexeu no layout (algo dentro dele se posicionava por outro ancestral), desfaz.
    if (!perto(antes, medir(el))) {
      voltar();
      selecionar(el);
      avisar(`Não deu sem tirar coisas do lugar: o bloco ${descrever(ramo)} precisaria mudar de posicionamento. Deixe uma nota para o agente.`);
      return;
    }
    painelDe = undefined;
    selecionar(el);
    avisar(`${para === 'frente' ? 'Na frente' : 'Atrás'} de ${rotulo(ramoOutro).nome}` + (ramo !== el ? ` (camada aplicada no bloco ${rotulo(ramo).nome}, que contém o escolhido)` : '') + '.');
  }

  /* ---------- interface ---------- */
  function criarUi() {
    const novoHost = (doc) => {
      const h = doc.createElement('div');
      h.setAttribute('data-ajuste-visual', '');
      h.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      return h;
    };
    host = novoHost(document);
    const raizes = [host.attachShadow({ mode: 'open' })];
    if (moldura) {
      // Um painel de um quadro anterior (a página recarregou) sai antes de entrar o novo.
      docUi.querySelectorAll('[data-ajuste-visual]').forEach((h) => h.remove());
      hostPainel = novoHost(docUi);
      raizes.push(hostPainel.attachShadow({ mode: 'open' }));
    } else hostPainel = host;
    raiz = {
      querySelector: (s) => raizes.map((r) => r.querySelector(s)).find(Boolean) ?? null,
      querySelectorAll: (s) => raizes.flatMap((r) => [...r.querySelectorAll(s)]),
      addEventListener: (...args) => raizes.forEach((r) => r.addEventListener(...args)),
      contains: (n) => raizes.some((r) => r.contains(n)),
    };
    const estilo = `
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
        .telas { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin: 2px 0 4px; color: #a0a0a5; }
        .telas b { color: #f2f2f2; font-weight: 600; margin-right: 2px; }
        .telas button { padding: 2px 7px; }
        .telas button.on { background: #ff5a1f; }
        .telas button.tem::after { content: ' •'; color: #ffb08a; }
        .extra { outline: 2px dashed #ff5a1f; }
        .guia { position: fixed; pointer-events: none; display: none; background: #ff2d87; }
        .guia.gx { top: 0; width: 1px; height: 100vh; }
        .guia.gy { left: 0; height: 1px; width: 100vw; }
        .medida { position: fixed; pointer-events: none; display: none; background: #ff2d87; }
        .medida span { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: #ff2d87; color: #fff;
          font: 600 11px/16px system-ui, sans-serif; padding: 0 4px; border-radius: 3px; white-space: nowrap; }
        .alinhar { display: none; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
        .alinhar.on { display: flex; }
        .alinhar button { padding: 2px 7px; }
        details { margin: 6px 0 0; }
        summary { cursor: pointer; color: #c9c9cf; font-weight: 600; }
        .estilos { display: grid; grid-template-columns: auto 1fr auto; gap: 3px 6px; align-items: center; margin-top: 4px; }
        .estilos label { color: #a0a0a5; white-space: nowrap; }
        .estilos input[type=text] { width: 100%; min-width: 0; }
        input, textarea { background: #2a2a2d; color: #f2f2f2; border: 1px solid #3a3a3d; border-radius: 4px; padding: 2px 5px; }
        input[type=color] { width: 22px; height: 20px; padding: 0; border: 0; background: none; }
        input.mudou { border-color: #ff5a1f; }
        textarea { width: 100%; min-height: 44px; resize: vertical; margin-top: 4px; }
        .ui { display: none; }
        :host(.on) .ui { display: block; }
        .pilula { position: fixed; left: 12px; bottom: 12px; pointer-events: auto; padding: 8px 14px; border-radius: 999px;
          background: #1d1d1f; color: #fff; font-weight: 600; box-shadow: 0 6px 18px rgba(0,0,0,.3); }
        :host(.on) .pilula { background: #ff5a1f; }
        /* Na moldura de tela, o painel ocupa a coluna da direita, ao lado do quadro. */
        .painel.lado { top: 12px; bottom: 12px; right: 12px; left: auto; max-height: none; }
      </style>`;
    const pilula = '<button class="pilula" data-acao="alternar" title="Ctrl+Shift+E">✎ Ajuste visual</button>';
    const caixas = `
      <div class="caixa hover"></div>
      <div class="caixa sel">${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((a) => `<div class="alca" data-a="${a}"></div>`).join('')}</div>
      <div class="extras"></div>
      <div class="guia gx"></div><div class="guia gy"></div>
      ${'<div class="medida"><span></span></div>'.repeat(4)}`;
    const htmlPainel = `
      <div class="painel${moldura ? ' lado' : ''}">
        <div class="topo" title="Arraste para mover o painel"><span>⠿ Ajuste visual</span><button data-acao="ajuda" title="Atalhos">?</button><button data-acao="min" title="Recolher">–</button></div>
        <div class="corpo">
          <div class="dica">Clique num elemento e arraste. Alt+clique: pega o que está escondido atrás (repita para ir mais fundo). Alças laranja: tamanho (lados: só largura ou altura; cantos: os dois, Shift solta a proporção). Ctrl+rodinha: tamanho · Shift+rodinha: girar · Alt+rodinha: opacidade · setas: 1px (Shift 10px) · [ e ]: elemento de trás/da frente · Shift+clique: escolhe vários (move, alinha e distribui juntos) · duplo clique: edita o texto · Ctrl ao arrastar: solta das guias · Ctrl+Z: desfazer · Delete: remover · H: espelhar · Para frente / Para trás (Ctrl+] / Ctrl+[): passa por cima ou por baixo do elemento que se sobrepõe · + Imagem: adiciona uma imagem de uma pasta na camada do elemento escolhido · Estilo: cor, fonte, espaçamento e camada · Nota: um pedido livre para o agente · Esc: soltar · Ctrl+Shift+E: desligar.</div>
          <div class="telas" title="Mudar a largura da tela. Cada largura guarda os seus próprios ajustes (ponto: tem ajustes guardados).">Tela <b class="agora"></b>
            ${tamanhosDeTela.map(([nome, w]) => `<button data-tela="${w}" title="${w}px">${nome}</button>`).join('')}<button data-tela="0" title="Volta ao tamanho da janela">Janela</button></div>
          <div class="info sel-info">Nenhum elemento escolhido.</div>
          <div class="alinhar" title="Alinha a seleção (Shift+clique escolhe vários)">
            <button data-alinhar="esquerda" title="Alinhar à esquerda">⇤</button><button data-alinhar="centro" title="Centralizar na horizontal">↔</button><button data-alinhar="direita" title="Alinhar à direita">⇥</button>
            <button data-alinhar="topo" title="Alinhar em cima">⤒</button><button data-alinhar="meio" title="Centralizar na vertical">↕</button><button data-alinhar="base" title="Alinhar embaixo">⤓</button>
            <button data-alinhar="distH" title="Distribuir na horizontal (3 ou mais)">⋯</button><button data-alinhar="distV" title="Distribuir na vertical (3 ou mais)">⋮</button>
          </div>
          <details class="estilo"><summary>Estilo</summary><div class="estilos"></div></details>
          <details class="notas" open><summary class="nota-titulo">Nota</summary><textarea class="nota" placeholder="Um pedido livre para o agente (ex.: trocar esta foto)"></textarea></details>
          <h4>Elementos neste ponto</h4>
          <ul class="lista candidatos"></ul>
          <h4>Alterados (<span class="total">0</span>)</h4>
          <ul class="lista alterados"></ul>
          <div class="botoes">
            <button class="forte" data-acao="copiar">Copiar alterações</button>
            <button class="com-node" data-acao="copiar-prints" title="Também salva prints da página inteira, antes e depois, na pasta prints">Copiar com prints</button>
            <button data-acao="desfazer">Desfazer</button>
            <button data-acao="imagem" title="Escolher uma imagem de uma pasta e colocar na página">+ Imagem</button>
            <button data-acao="espelhar" title="H">Espelhar</button>
            <button data-acao="frente" title="Passa por cima do próximo elemento que se sobrepõe a ele (Ctrl+])">Para frente</button>
            <button data-acao="tras" title="Passa por baixo do próximo elemento que se sobrepõe a ele (Ctrl+[)">Para trás</button>
            <button data-acao="texto" title="Duplo clique no elemento faz o mesmo">Editar texto</button>
            <button data-acao="guias" title="Guias de alinhamento ao arrastar (Ctrl solta) e medidas até o elemento sob o mouse">Guias: sim</button>
            <button data-acao="remover" title="Delete">Remover</button>
            <button data-acao="restaurar">Restaurar este</button>
            <button data-acao="limpar">Limpar tudo</button>
            <button data-acao="anim">Parar animações</button>
          </div>
          <div class="aviso"></div>
        </div>
      </div>`;
    if (moldura) {
      raizes[0].innerHTML = `${estilo}<div class="ui">${caixas}</div>`;
      raizes[1].innerHTML = `${estilo}${pilula}<div class="ui">${htmlPainel}</div>`;
      docUi.documentElement.appendChild(hostPainel);
      // O quadro vai embora (recarregou ou trocou de página): o painel dele sai junto.
      addEventListener('pagehide', () => hostPainel.remove());
    } else raizes[0].innerHTML = `${estilo}${pilula}<div class="ui">${caixas}${htmlPainel}</div>`;
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
      if (acao === 'copiar-prints') copiar(true);
      if (acao === 'desfazer') voltar();
      if (acao === 'restaurar' && selecionado) { selecao().forEach(restaurar); painelDe = undefined; atualizarPainel(); }
      if (acao === 'remover') remover(selecao());
      if (acao === 'espelhar') espelhar(selecao());
      if (acao === 'texto') editarTexto(selecionado);
      if (acao === 'frente' || acao === 'tras') mudarCamada(acao === 'frente' ? 'frente' : 'tras');
      if (acao === 'guias') { guiasLigadas = !guiasLigadas; guardarPainel(); atualizarPainel(); }
      const alinhamento = e.target.closest?.('[data-alinhar]')?.dataset.alinhar;
      if (alinhamento) alinhar(alinhamento);
      if (acao === 'imagem') adicionarImagem();
      if (acao === 'limpar') {
        [...alteracoes.keys()].forEach(restaurar);
        parados = [];
        notaGeral = '';
        // Tudo mesmo: os ajustes guardados das outras larguras de tela também.
        guardado = { telas: {} };
        desfazer.length = 0;
        painelDe = undefined;
        atualizarPainel();
        guardar();
      }
      if (acao === 'anim') alternarAnimacoes(e.target);
      const tela = e.target.closest?.('button[data-tela]');
      if (tela) mudarTela(Number(tela.dataset.tela) || null);
      const item = e.target.closest?.('li[data-i]');
      if (item) {
        const lista = item.parentElement.classList.contains('alterados') ? alterados() : candidatos;
        selecionar(lista[Number(item.dataset.i)]);
        selecionado?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
    caixaSel.addEventListener('pointerdown', (e) => {
      if (e.target.dataset?.a) iniciarArrasto(e, e.target.dataset.a);
    });

    // Estilo: cada campo muda a propriedade em toda a seleção; vazio volta ao valor da página.
    raiz.querySelector('.estilos').addEventListener('change', (e) => {
      const campo = e.target.closest('input[type=text][data-prop]');
      if (!campo) return;
      const p = campo.dataset.prop;
      const valor = campo.value.trim();
      const els = selecao();
      guardarDesfazer(els);
      for (const el of els) {
        const s = estado(el);
        if (!valor || valor === s.orig.estilos[p]) delete s.estilos[p]; else s.estilos[p] = valor;
        aplicar(el);
      }
      painelDe = undefined;
      atualizarPainel();
    });
    raiz.querySelector('.estilos').addEventListener('input', (e) => {
      const cor = e.target.closest('input[type=color]');
      if (!cor) return;
      const campo = raiz.querySelector(`input[type=text][data-prop="${cor.dataset.cor}"]`);
      campo.value = cor.value;
      campo.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Nota: do elemento escolhido, ou da página quando nada está escolhido.
    raiz.querySelector('.nota').addEventListener('input', (e) => {
      if (selecionado) estado(selecionado).nota = e.target.value;
      else notaGeral = e.target.value;
      agendarGuardar();
      atualizarListas();
    });

    // Painel arrastável pelo título; posição e estado ficam guardados neste site.
    const topo = raiz.querySelector('.topo');
    topo.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = painel.getBoundingClientRect();
      const inicio = { x: e.clientX - r.left, y: e.clientY - r.top };
      const mover = (ev) => {
        const left = Math.min(Math.max(0, ev.clientX - inicio.x), janelaUi.innerWidth - 60);
        const top = Math.min(Math.max(0, ev.clientY - inicio.y), janelaUi.innerHeight - 30);
        Object.assign(painel.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
      };
      const soltar = () => {
        janelaUi.removeEventListener('pointermove', mover, true);
        janelaUi.removeEventListener('pointerup', soltar, true);
        guardarPainel();
      };
      janelaUi.addEventListener('pointermove', mover, true);
      janelaUi.addEventListener('pointerup', soltar, true);
    });
    try {
      const salvo = JSON.parse(localStorage.getItem('ajusteVisualPainel') || 'null');
      // Na moldura, o painel começa na coluna ao lado do quadro, e não onde estava na página normal.
      if (salvo?.left && !moldura) Object.assign(painel.style, { left: salvo.left, top: salvo.top, right: 'auto', bottom: 'auto' });
      painel.classList.toggle('min', !!salvo?.min);
      painel.classList.toggle('ajuda', !!salvo?.ajuda);
      if (salvo?.guias === false) guiasLigadas = false;
    } catch { /* sem armazenamento: painel no lugar padrão */ }
    encaixarPainel();
    janelaUi.addEventListener('resize', encaixarPainel);
    // Com o foco no painel da moldura, as teclas chegam por ela.
    if (moldura) janelaUi.addEventListener('keydown', teclado, true);
    if (avisoPendente) avisar(avisoPendente);
    atualizarPilula();
    atualizarTelas();
  }

  // A posição guardada é em px: ao abrir numa janela mais estreita (ou trocar para Celular),
  // o painel podia ficar fora da tela. Traz de volta para dentro, com a mesma folga do arraste.
  function encaixarPainel() {
    if (!painel?.style.left) return;
    // Com o editor desligado o painel está oculto e mede 0: usa a largura fixa dele (300px).
    const largura = painel.offsetWidth || 300;
    const altura = Math.min(painel.offsetHeight || 120, 120);
    const left = Math.min(Math.max(0, parseFloat(painel.style.left) || 0), Math.max(0, janelaUi.innerWidth - largura - 8));
    const top = Math.min(Math.max(0, parseFloat(painel.style.top) || 0), Math.max(0, janelaUi.innerHeight - altura));
    Object.assign(painel.style, { left: `${left}px`, top: `${top}px` });
  }

  function guardarPainel() {
    try {
      const salvo = JSON.parse(localStorage.getItem('ajusteVisualPainel') || 'null');
      localStorage.setItem('ajusteVisualPainel', JSON.stringify({
        left: moldura ? salvo?.left : painel.style.left, top: moldura ? salvo?.top : painel.style.top,
        min: painel.classList.contains('min'), ajuda: painel.classList.contains('ajuda'), guias: guiasLigadas,
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
  let guiasLigadas = true;
  function laco() {
    if (!ligado) return;
    const sel = selecao();
    posicionar(caixaHover, arrasto ? null : !sel.includes(ultimoHover) ? ultimoHover : null);
    posicionar(caixaSel, selecionado);
    // Uma caixa tracejada para cada elemento a mais da seleção.
    const caixas = raiz.querySelector('.extras');
    while (caixas.children.length < extras.size) caixas.insertAdjacentHTML('beforeend', '<div class="caixa extra"></div>');
    [...caixas.children].forEach((c, i) => posicionar(c, sel[i + 1] ?? null));
    // Guias de alinhamento durante o arrasto.
    const [gx, gy] = raiz.querySelectorAll('.guia');
    gx.style.display = arrasto?.guiaX != null ? 'block' : 'none';
    gy.style.display = arrasto?.guiaY != null ? 'block' : 'none';
    if (arrasto?.guiaX != null) gx.style.left = `${arrasto.guiaX}px`;
    if (arrasto?.guiaY != null) gy.style.top = `${arrasto.guiaY}px`;
    // Medidas: distância do escolhido até o elemento sob o mouse.
    const segs = guiasLigadas && !arrasto && selecionado && ultimoHover && !sel.includes(ultimoHover)
      ? medidas(selecionado.getBoundingClientRect(), ultimoHover.getBoundingClientRect()) : [];
    raiz.querySelectorAll('.medida').forEach((m, i) => {
      const s = segs[i];
      if (!s) { m.style.display = 'none'; return; }
      Object.assign(m.style, { display: 'block', left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px`, height: `${s.h}px` });
      m.firstChild.textContent = String(s.valor);
    });
    requestAnimationFrame(laco);
  }
  /* Segmentos entre as bordas de A (escolhido) e B: o vão entre eles, ou, se um está sobre o outro,
     a distância entre as bordas do mesmo lado. */
  function medidas(a, b) {
    const segs = [];
    const linha = (de, ate, fixo, horizontal) => {
      const [x1, x2] = [Math.min(de, ate), Math.max(de, ate)];
      if (x2 - x1 < 1) return;
      const valor = Math.round(x2 - x1);
      segs.push(horizontal ? { x: x1, y: fixo, w: x2 - x1, h: 1, valor } : { x: fixo, y: x1, w: 1, h: x2 - x1, valor });
    };
    const meioY = Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom) ? (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2 : a.top + a.height / 2;
    const meioX = Math.max(a.left, b.left) < Math.min(a.right, b.right) ? (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2 : a.left + a.width / 2;
    if (b.left >= a.right) linha(a.right, b.left, meioY, true);
    else if (b.right <= a.left) linha(b.right, a.left, meioY, true);
    else { linha(a.left, b.left, meioY, true); linha(a.right, b.right, meioY, true); }
    if (b.top >= a.bottom) linha(a.bottom, b.top, meioX, false);
    else if (b.bottom <= a.top) linha(b.bottom, a.top, meioX, false);
    else { linha(a.top, b.top, meioX, false); linha(a.bottom, b.bottom, meioX, false); }
    return segs.slice(0, 4);
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
  const comNota = (el) => (alteracoes.get(el)?.nota ? ' 📝' : '');
  const alterados = () => [...alteracoes.entries()].filter(([, s]) => mudou(s)).map(([el]) => el);
  const lista = (els) => els.map((el, i) => {
    const r = rotulo(el);
    const codigo = origemDe(el);
    return `<li data-i="${i}" class="${el === selecionado || extras.has(el) ? 'on' : ''}" title="${html(descrever(el) + '\n' + seletor(el) + (codigo ? `\n${codigo}` : ''))}">${html(r.nome)}${r.extra ? ` <span class="g">· ${html(r.extra)}</span>` : ''}${comNota(el)}</li>`;
  }).join('');

  // Elemento para o qual os campos de estilo e a nota foram preenchidos (só refaz quando muda).
  let painelDe;
  let notaGeral = '';
  const hex = (cor) => {
    const m = cor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? `#${m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : '#000000';
  };
  function atualizarCampos() {
    if (painelDe === selecionado) return;
    painelDe = selecionado;
    const s = selecionado ? alteracoes.get(selecionado) : null;
    const cs = selecionado ? getComputedStyle(selecionado) : null;
    raiz.querySelector('.estilos').innerHTML = selecionado ? PROPRIEDADES.map(([p, nome]) => {
      const valor = s?.estilos[p] ?? cs.getPropertyValue(p);
      const cor = /color/.test(p) ? `<input type="color" data-cor="${p}" value="${hex(valor)}">` : '<span></span>';
      return `<label title="${p}">${html(nome)}</label><input type="text" data-prop="${p}" class="${s?.estilos[p] != null ? 'mudou' : ''}" value="${html(valor)}">${cor}`;
    }).join('') : '<small>Escolha um elemento.</small>';
    raiz.querySelector('.nota').value = selecionado ? s?.nota ?? '' : notaGeral;
    raiz.querySelector('.nota-titulo').textContent = selecionado ? 'Nota sobre este elemento' : 'Nota geral da página';
  }
  function atualizarListas() {
    raiz.querySelector('.candidatos').innerHTML = lista(candidatos);
    raiz.querySelector('.alterados').innerHTML = lista(alterados());
    raiz.querySelector('.total').textContent = String([...alteracoes.values()].filter(mudou).length);
  }
  function atualizarPainel() {
    if (!raiz) return;
    const info = raiz.querySelector('.sel-info');
    const sel = selecao();
    raiz.querySelector('.alinhar').classList.toggle('on', sel.length >= 2);
    raiz.querySelector('[data-acao="guias"]').textContent = `Guias: ${guiasLigadas ? 'sim' : 'não'}`;
    if (selecionado) {
      const s = alteracoes.get(selecionado);
      const r = selecionado.getBoundingClientRect();
      const n = rotulo(selecionado);
      const codigo = origemDe(selecionado);
      info.title = descrever(selecionado) + (codigo ? `\n${codigo}` : '');
      info.innerHTML = `<b>${html(n.nome)}</b>${n.extra ? ` <span>· ${html(n.extra)}</span>` : ''}` +
        `<small>${Math.round(r.width)}×${Math.round(r.height)}px` +
        (s?.removido ? ' · removido' : '') +
        (s && mudou(s) && !s.removido ? ` · moveu ${s.dx}, ${s.dy}px` + (s.rot ? ` · girou ${s.rot}°` : '') + (s.opacidade != null ? ` · opac. ${s.opacidade}` : '') : '') + '</small>' +
        (codigo ? `<small>${html(codigo.split(/[\\/]/).slice(-2).join('/'))}</small>` : '');
      if (sel.length > 1) info.innerHTML += `<small>+ ${sel.length - 1} na seleção (Shift+clique põe ou tira)</small>`;
    } else info.textContent = 'Nenhum elemento escolhido.';
    // Mostra só o que de fato mudou (escolher um elemento sem mexer não conta). A seleção e o texto
    // em edição ficam, mesmo sem mudança ainda (senão o meio de uma ação em grupo perderia elementos).
    if (!arrasto) for (const [el, s] of alteracoes) if (!mudou(s) && el !== editando && !sel.includes(el)) restaurar(el);
    atualizarListas();
    atualizarCampos();
    atualizarTelas();
  }
  // Antes de a interface existir, o aviso espera e aparece quando ela for criada.
  let avisoPendente = '';
  const avisar = (texto) => { if (raiz) raiz.querySelector('.aviso').textContent = texto; else avisoPendente = texto; };
  // Desligado, o botão mostra quantas alterações estão na tela (ex.: reaplicadas depois de recarregar).
  function atualizarPilula() {
    if (!raiz) return;
    const n = [...alteracoes.values()].filter(mudou).length;
    raiz.querySelector('.pilula').textContent = ligado ? '✕ Desligar ajuste' : `✎ Ajuste visual${n ? ` · ${n}` : ''}`;
  }

  /* ---------- arrastar, redimensionar ---------- */
  /* Linhas onde o elemento arrastado gruda: bordas e centros dos elementos visíveis por perto, do
     contêiner e o centro da tela. Medidas uma vez no começo do arrasto. */
  function linhasDeAlinhamento(grupo) {
    const x = [innerWidth / 2], y = [];
    const juntar = (r) => { x.push(r.left, r.left + r.width / 2, r.right); y.push(r.top, r.top + r.height / 2, r.bottom); };
    const pai = selecionado.offsetParent ?? selecionado.parentElement;
    if (pai) juntar(pai.getBoundingClientRect());
    let vistos = 0;
    for (const n of document.body.querySelectorAll('*')) {
      if (vistos > 600) break;
      if (n === host || grupo.some((g) => g === n || g.contains(n) || n.contains(g))) continue;
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < -200 || r.top > innerHeight + 200 || grande(n)) continue;
      vistos++;
      juntar(r);
    }
    return { x, y };
  }
  // O valor do elemento que fica mais perto de uma linha (até 5px) e quanto falta para encostar.
  function grudar(valores, linhas) {
    let melhor = null;
    for (const v of valores) for (const l of linhas) {
      const d = l - v;
      if (Math.abs(d) <= 5 && (!melhor || Math.abs(d) < Math.abs(melhor.d))) melhor = { d, l };
    }
    return melhor;
  }
  function iniciarArrasto(e, modo) {
    if (!selecionado) return;
    e.preventDefault();
    e.stopPropagation();
    const el = selecionado;
    // Mover leva a seleção inteira; mudar o tamanho é só no escolhido.
    const grupo = modo === 'mover' ? selecao() : [el];
    guardarDesfazer(grupo);
    const s = estado(el);
    const r = el.getBoundingClientRect();
    arrasto = { el, modo, x: e.clientX, y: e.clientY, dx: s.dx, dy: s.dy, r0: r,
      grupo: grupo.map((g) => ({ el: g, dx: estado(g).dx, dy: estado(g).dy })),
      linhas: modo === 'mover' && guiasLigadas ? linhasDeAlinhamento(grupo) : null,
      largura: s.largura ?? s.orig.larguraCss, altura: s.altura ?? (el.offsetHeight || r.height), proporcao: r.height / r.width };
    try { caixaSel.setPointerCapture(e.pointerId); } catch { /* segue sem captura */ }
  }
  window.addEventListener('pointermove', (e) => {
    if (!ligado) return;
    if (arrasto) {
      const s = estado(arrasto.el);
      let mx = Math.round(e.clientX - arrasto.x), my = Math.round(e.clientY - arrasto.y);
      const a = arrasto.modo;
      if (a === 'mover') {
        // Gruda nas guias (Ctrl segurado move livre).
        arrasto.guiaX = arrasto.guiaY = null;
        if (arrasto.linhas && !e.ctrlKey) {
          const r = arrasto.r0;
          const gx = grudar([r.left + mx, r.left + r.width / 2 + mx, r.right + mx], arrasto.linhas.x);
          const gy = grudar([r.top + my, r.top + r.height / 2 + my, r.bottom + my], arrasto.linhas.y);
          if (gx) { mx += Math.round(gx.d); arrasto.guiaX = gx.l; }
          if (gy) { my += Math.round(gy.d); arrasto.guiaY = gy.l; }
        }
        for (const g of arrasto.grupo) {
          const sg = estado(g.el);
          sg.dx = g.dx + mx;
          sg.dy = g.dy + my;
          aplicar(g.el);
        }
        return;
      }
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

  /* Bloqueia cliques da página enquanto o editor está ligado e escolhe o elemento.
     O texto em edição continua recebendo cliques (para posicionar o cursor). */
  let altAnterior = null;
  const noTextoEmEdicao = (e) => editando && e.composedPath().includes(editando);
  const bloquear = (e) => {
    if (!ligado || dentroDaUi(e) || noTextoEmEdicao(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  /* Duplo clique no elemento escolhido edita o texto (registrado antes do bloqueio, que corta os outros).
     O arrasto prende o ponteiro na caixa de seleção, então o evento chega pela interface: só o painel
     e o botão ficam de fora. */
  window.addEventListener('dblclick', (e) => {
    const caminho = e.composedPath();
    if (!ligado || caminho.includes(painel) || caminho.includes(raiz?.querySelector('.pilula')) || noTextoEmEdicao(e)) return;
    if (!selecionado || !dentro(selecionado, e.clientX, e.clientY)) return;
    editarTexto(selecionado);
  }, true);
  ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerup', 'contextmenu', 'auxclick'].forEach((t) => window.addEventListener(t, bloquear, true));
  window.addEventListener('pointerdown', (e) => {
    if (!ligado || dentroDaUi(e) || noTextoEmEdicao(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Clicar dentro da seleção arrasta ela, mesmo que esteja atrás de outro elemento
    // (ex.: gravura de fundo escolhida pela lista ou com Alt+clique).
    if (!e.altKey && !e.shiftKey && selecao().some((el) => !grande(el) && dentro(el, e.clientX, e.clientY))) {
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
    // Shift+clique: põe ou tira da seleção, sem arrastar.
    if (e.shiftKey) { if (escolhido) alternarNaSelecao(escolhido); return; }
    selecionar(escolhido ?? null);
    if (escolhido) iniciarArrasto(e, 'mover');
  }, true);

  /* ---------- rodinha e teclado ---------- */
  window.addEventListener('wheel', (e) => {
    if (!ligado || !selecionado || !(e.ctrlKey || e.shiftKey || e.altKey)) return;
    e.preventDefault();
    const els = selecao();
    guardarDesfazer(els);
    const passo = (e.deltaY || e.deltaX) > 0 ? -1 : 1;
    for (const el of els) {
      const s = estado(el);
      if (e.ctrlKey) {
        const atual = s.largura ?? s.orig.larguraCss;
        s.largura = Math.max(4, Math.round(atual * (1 + passo * 0.05)));
      } else if (e.shiftKey) s.rot += passo * 2;
      else if (e.altKey) s.opacidade = Math.min(1, Math.max(0, Math.round(((s.opacidade ?? s.orig.opacidade) + passo * 0.02) * 100) / 100));
      aplicar(el);
    }
  }, { capture: true, passive: false });

  function voltar() {
    const passo = desfazer.pop();
    if (!passo) return;
    for (const { el, antes } of passo) {
      Object.assign(estado(el), antes);
      aplicar(el);
    }
    selecionar(passo[0].el);
    for (const { el } of passo.slice(1)) if (el.isConnected) extras.add(el);
    painelDe = undefined;
    atualizarPainel();
  }

  function teclado(e) {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyE') { e.preventDefault(); alternar(); return; }
    if (!ligado) return;
    // Texto em edição: Enter ou Esc terminam (Shift+Enter quebra a linha).
    if (editando && (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey))) { e.preventDefault(); editando.blur(); return; }
    const alvo = e.composedPath()[0];
    // Num campo do painel, Esc só sai do campo (o próximo Esc solta o elemento).
    if (e.key === 'Escape' && alvo instanceof HTMLElement && /INPUT|TEXTAREA/.test(alvo.tagName) && raiz?.contains(alvo)) { alvo.blur(); return; }
    if (alvo instanceof HTMLElement && (alvo.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(alvo.tagName))) return;
    if (e.ctrlKey && e.code === 'KeyZ') { e.preventDefault(); voltar(); return; }
    if (e.key === 'Escape') { selecionar(null); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selecionado) { e.preventDefault(); remover(selecao()); return; }
    if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.altKey && selecionado) { e.preventDefault(); espelhar(selecao()); return; }
    if ((e.key === '[' || e.key === ']') && e.ctrlKey && selecionado) { e.preventDefault(); mudarCamada(e.key === ']' ? 'frente' : 'tras'); return; }
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
      const els = selecao();
      guardarDesfazer(els);
      for (const el of els) {
        const s = estado(el);
        s.dx += setas[e.key][0] * passo;
        s.dy += setas[e.key][1] * passo;
        aplicar(el);
      }
    }
  }
  window.addEventListener('keydown', teclado, true);

  function alternar() {
    ligado = !ligado;
    if (!host) criarUi();
    host.classList.toggle('on', ligado);
    hostPainel.classList.toggle('on', ligado);
    atualizarPilula();
    document.documentElement.style.cursor = ligado ? 'crosshair' : '';
    if (ligado) { atualizarPainel(); requestAnimationFrame(laco); }
  }

  /* O botão fica sempre na página; sites que trocam o documento (ex.: navegação sem recarregar)
     podem tirá-lo, então ele é recolocado quando some. */
  const garantirUi = () => {
    if (!document.documentElement) return;
    if (!host) criarUi();
    else if (!host.isConnected) document.documentElement.appendChild(host);
    if (moldura && hostPainel && !hostPainel.isConnected) docUi.documentElement.appendChild(hostPainel);
  };

  /* ---------- guardar e reaplicar ao recarregar ----------
     Cada alteração vira um registro guardado no navegador, por página. Ao recarregar (por exemplo,
     quando o agente muda o código e o servidor recarrega), cada registro é conferido:
     - o elemento ainda está como era antes do ajuste → reaplica o ajuste;
     - já está como ficou depois do ajuste → o código já tem a mudança, não reaplica;
     - está diferente dos dois → não mexe e avisa, para você conferir. */
  const chaveGuardada = () => `ajusteVisual:${location.pathname}${location.search}`;
  let telaAtual = innerWidth;
  let guardado = null; // { telas: { [largura]: [registro] } }
  const lerGuardado = () => {
    try { return JSON.parse(localStorage.getItem(chaveGuardada()) || 'null') ?? { telas: {} }; } catch { return { telas: {} }; }
  };
  let reaplicando = false;
  // Até reaplicar o que estava guardado, não grava nada (senão um recarregar rápido apagaria tudo).
  let carregado = false;
  // Registros que não deu para reaplicar (código diferente do esperado, elemento não achado):
  // continuam guardados e no texto, até você limpar.
  let parados = [];
  let agendado = 0;
  function agendarGuardar() {
    if (reaplicando) return;
    clearTimeout(agendado);
    agendado = setTimeout(guardar, 300);
  }
  function guardar() {
    clearTimeout(agendado);
    if (!carregado) return;
    guardado ??= lerGuardado();
    const registros = [...registrosAtuais(), ...parados];
    if (registros.length) guardado.telas[telaAtual] = registros;
    else delete guardado.telas[telaAtual];
    guardado.nota = notaGeral;
    try {
      if (Object.keys(guardado.telas).length || notaGeral) localStorage.setItem(chaveGuardada(), JSON.stringify(guardado));
      else localStorage.removeItem(chaveGuardada());
    } catch { /* sem armazenamento: só não sobrevive ao recarregar */ }
    atualizarPilula();
  }
  function registro(el, s) {
    const { estiloInline, inline, html, ...orig } = s.orig;
    const cs = getComputedStyle(el);
    return {
      orig, valores: copia(s), novo: s.novo, codigo: origemDe(el), final: s.removido ? null : medir(el),
      finalLayout: s.removido ? null : medirLayout(el),
      estilosFinais: Object.fromEntries(Object.keys(s.estilos).map((p) => [p, cs.getPropertyValue(p)])),
    };
  }
  // Imagem nova que depois foi removida não conta.
  const registrosAtuais = () => [...alteracoes.entries()].filter(([, s]) => mudou(s) && !(s.novo && s.removido)).map(([el, s]) => registro(el, s));

  function acharElemento(r) {
    let el = null;
    try { el = document.querySelector(r.orig.seletor); } catch { /* seletor inválido nesta página */ }
    if (el && descrever(el) === r.orig.descricao) return el;
    // O seletor mudou (ex.: entrou um elemento antes); procura um único elemento com a mesma descrição.
    const tag = r.orig.descricao.match(/^[a-z0-9-]+/)?.[0] ?? '*';
    const iguais = [...document.querySelectorAll(tag)].filter((n) => !n.closest('[data-ajuste-visual]') && descrever(n) === r.orig.descricao);
    return iguais.length === 1 ? iguais[0] : null;
  }
  const perto = (a, b) => a && b && Math.abs(a.x - b.x) <= 4 && Math.abs(a.y - b.y) <= 4 && Math.abs(a.largura - b.largura) <= 4 && Math.abs(a.altura - b.altura) <= 4;
  // 'antes' (como era antes do ajuste), 'depois' (já com a mudança no código) ou 'diferente'.
  function conferir(el, r) {
    const v = r.valores;
    const cs = getComputedStyle(el);
    const votos = [];
    if (v.removido) votos.push(cs.display === 'none' ? 'depois' : 'antes');
    else {
      // Registros novos comparam o layout (sem as animações da página); os antigos, a caixa na tela.
      const [agora, antes, depois] = r.orig.layout && r.finalLayout
        ? [medirLayout(el), r.orig.layout, r.finalLayout]
        : [medir(el), r.orig, r.final];
      if (!perto(antes, depois)) votos.push(perto(agora, antes) ? 'antes' : perto(agora, depois) ? 'depois' : 'diferente');
      if (r.orig.layout && v.rot) {
        const giro = num(cs.rotate);
        votos.push(Math.abs(giro - r.orig.rotate) < 0.5 ? 'antes' : Math.abs(giro - (r.orig.rotate + v.rot)) < 0.5 ? 'depois' : 'diferente');
      }
      if (v.opacidade != null && v.opacidade !== r.orig.opacidade) {
        const o = num(cs.opacity, 1);
        votos.push(Math.abs(o - r.orig.opacidade) < 0.01 ? 'antes' : Math.abs(o - v.opacidade) < 0.01 ? 'depois' : 'diferente');
      }
      if (v.espelhado) votos.push(sinalHorizontal(cs) === r.orig.sinal ? 'antes' : 'depois');
      if (v.texto != null) votos.push(el.innerText === v.texto ? 'depois' : el.innerText === r.orig.texto ? 'antes' : 'diferente');
      for (const p of Object.keys(v.estilos ?? {})) {
        const agora = cs.getPropertyValue(p);
        votos.push(agora === r.estilosFinais?.[p] ? 'depois' : agora === r.orig.estilos?.[p] ? 'antes' : 'diferente');
      }
    }
    if (votos.every((x) => x === 'antes')) return 'antes';
    return votos.every((x) => x === 'depois') ? 'depois' : 'diferente';
  }
  async function recriarImagem(r) {
    const n = r.novo;
    // Se a página já tem uma imagem com este arquivo, o código já recebeu a imagem nova.
    if ([...document.images].some((img) => !img.dataset.ajusteNovo && nomeArquivo(img.currentSrc || img.src) === n.nome)) return 'depois';
    const url = urlsNovas.get(n.caminho) ?? await window.__ajusteLerImagem?.(n.caminho).catch(() => null);
    if (!url) return 'sumiu';
    urlsNovas.set(n.caminho, url);
    let pai = null;
    try { pai = document.querySelector(n.pai); } catch { /* fica na página */ }
    const img = await criarImagem(pai ?? document.body, url, n.nome, n.largura, {
      left: `${n.left}px`, top: `${n.top}px`, zIndex: n.zIndex ?? '', opacity: n.opacidade ?? '1',
    });
    const s = estado(img);
    s.novo = n;
    Object.assign(s, r.valores);
    aplicar(img);
    return 'antes';
  }
  async function reaplicar(registros) {
    const conta = { antes: 0, depois: 0, diferente: [], sumiu: [] };
    parados = [];
    const parar = (r, motivo) => { conta[motivo].push(r.orig.descricao); parados.push({ ...r, parado: motivo }); };
    reaplicando = true;
    try {
      for (const r of registros) {
        if (r.novo) {
          const res = await recriarImagem(r);
          if (res === 'sumiu') parar(r, 'sumiu'); else conta[res]++;
          continue;
        }
        const el = acharElemento(r);
        if (!el) {
          // Elemento que era para remover e não existe mais: o código já tirou.
          if (r.valores.removido) conta.depois++; else parar(r, 'sumiu');
          continue;
        }
        const res = conferir(el, r);
        if (res === 'antes') {
          const s = estado(el);
          Object.assign(s, r.valores);
          aplicar(el);
          conta.antes++;
        } else if (res === 'depois') conta.depois++;
        else parar(r, 'diferente');
      }
    } finally {
      reaplicando = false;
      carregado = true;
    }
    guardar();
    return conta;
  }
  function resumoConferencia(conta) {
    const partes = [];
    if (conta.antes) partes.push(`${conta.antes} reaplicada(s)`);
    if (conta.depois) partes.push(`${conta.depois} já no código`);
    if (conta.diferente.length) partes.push(`${conta.diferente.length} diferente(s) do esperado, não reaplicada(s): ${conta.diferente.join('; ')}`);
    if (conta.sumiu.length) partes.push(`${conta.sumiu.length} não encontrada(s): ${conta.sumiu.join('; ')}`);
    return partes.join(' · ');
  }
  async function reaplicarGuardado() {
    // No começo da página a largura ainda pode não ser a final; vale a de agora.
    telaAtual = innerWidth;
    guardado = lerGuardado();
    notaGeral = guardado.nota ?? '';
    painelDe = undefined;
    const registros = guardado.telas[telaAtual] ?? [];
    if (!registros.length) { carregado = true; atualizarPilula(); return; }
    const conta = await reaplicar(registros);
    const resumo = resumoConferencia(conta);
    console.info(`[Ajuste visual] Depois de recarregar: ${resumo}`);
    avisar(`Depois de recarregar: ${resumo}`);
  }
  /* Cada largura de tela tem os seus ajustes: ao mudar a largura (botões do painel ou a janela),
     os da largura anterior saem da tela e ficam guardados, e entram os da nova. */
  async function trocarTela() {
    if (!carregado || reaplicando || arrasto || innerWidth === telaAtual) return;
    const antiga = telaAtual;
    guardar();
    reaplicando = true;
    selecionar(null);
    candidatos = [];
    [...alteracoes.keys()].forEach(restaurar);
    desfazer.length = 0;
    reaplicando = false;
    telaAtual = innerWidth;
    const conta = await reaplicar(guardado?.telas[telaAtual] ?? []);
    const resumo = resumoConferencia(conta);
    avisar(`Tela ${antiga}px → ${telaAtual}px. Os ajustes de ${antiga}px ficaram guardados.${resumo ? ` Desta largura: ${resumo}` : ''}`);
    atualizarTelas();
  }
  let esperaTela = 0;
  addEventListener('resize', () => { clearTimeout(esperaTela); esperaTela = setTimeout(trocarTela, 300); });
  /* Botões de largura: abrem a página na moldura (/__ajuste-tela, servida pela ferramenta), num quadro
     com a largura escolhida e o painel ao lado. Já na moldura, só mudam a largura do quadro; "Janela"
     volta para a página normal. Só existem quando a ferramenta abre a página (precisa do Node). */
  const tamanhosDeTela = [['Celular', 390], ['Tablet', 768], ['Notebook', 1366]];
  function mudarTela(largura) {
    if (!window.__ajusteFoto) return;
    if (moldura) {
      if (!largura) { guardar(); janelaUi.location.href = location.href; return; }
      window.frameElement.style.width = `${largura}px`;
      const rotulo = docUi.querySelector('.rotulo');
      if (rotulo) rotulo.textContent = `${largura}px`;
      return;
    }
    if (!largura) return;
    guardar();
    location.href = `${location.origin}${ENDERECO_MOLDURA}?largura=${largura}&pagina=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
  }
  function atualizarTelas() {
    if (!raiz) return;
    const linha = raiz.querySelector('.telas');
    linha.style.display = window.__ajusteFoto ? '' : 'none';
    raiz.querySelectorAll('.com-node').forEach((b) => { b.style.display = window.__ajusteFoto ? '' : 'none'; });
    const salvas = Object.keys(guardado?.telas ?? {}).map(Number);
    linha.querySelector('.agora').textContent = `${innerWidth}px`;
    linha.querySelectorAll('button[data-tela]').forEach((b) => {
      const w = Number(b.dataset.tela);
      b.classList.toggle('on', w ? innerWidth === w : !tamanhosDeTela.some(([, l]) => l === innerWidth));
      b.classList.toggle('tem', w > 0 && salvas.includes(w) && w !== innerWidth);
    });
  }

  // Espera a página assentar (fontes, imagens) antes de medir e comparar.
  const quandoCarregar = () => setTimeout(reaplicarGuardado, 400);
  if (document.readyState === 'complete') quandoCarregar();
  else addEventListener('load', quandoCarregar, { once: true });
  addEventListener('pagehide', guardar);

  /* ---------- texto das alterações ---------- */
  /* CSS que reproduz na tela o mesmo resultado, somado ao que a página já tem, e as medidas em
     proporção do contêiner (útil quando o código usa % ou vw). */
  const pct = (v, total) => `${Math.round((v / total) * 1000) / 10}%`;
  function cssFinal(o, s) {
    const css = [];
    if (s.dx || s.dy) {
      const [tx = '0px', ty = '0px'] = o.translate === 'none' ? [] : o.translate.split(' ');
      const soma = (base, d) => (/^-?[\d.]+px$/.test(base) ? `${Math.round(num(base) + d)}px` : `calc(${base} + ${d}px)`);
      css.push(`translate: ${soma(tx, s.dx)} ${soma(ty, s.dy)}`);
    }
    if (s.rot) css.push(`rotate: ${o.rotate + s.rot}deg`);
    if (s.largura != null) css.push(`width: ${s.largura}px`);
    if (s.altura != null) css.push(`height: ${s.altura}px`);
    if (s.opacidade != null) css.push(`opacity: ${s.opacidade}`);
    if (s.espelhado) css.push('scale: -1 1');
    for (const [p, valor] of Object.entries(s.estilos ?? {})) css.push(`${p}: ${valor}`);
    if (!css.length) return [];
    const linhas = [`   CSS final: ${css.join('; ')}`];
    if (o.rotacaoTransform && s.rot) linhas.push(`   (a página também gira este elemento ${o.rotacaoTransform}° pelo transform; na tela ele fica em ${o.rotacaoTransform + o.rotate + s.rot}°)`);
    if (o.larguraPai) {
      const prop = [];
      if (s.dx) prop.push(`deslocamento horizontal ${pct(s.dx, o.larguraPai)}`);
      if (s.dy) prop.push(`vertical ${pct(s.dy, o.larguraPai)}`);
      if (s.largura != null) prop.push(`largura ${pct(s.largura, o.larguraPai)}`);
      if (prop.length) linhas.push(`   em proporção da largura do contêiner (${o.larguraPai}px): ${prop.join(' · ')}`);
    }
    if ((s.dx || s.dy) && /absolute|fixed/.test(o.posicao)) {
      linhas.push(`   ou, como é position: ${o.posicao}, some ${s.dx}px no left e ${s.dy}px no top (se estiver preso por right/bottom, subtraia deles)`);
    }
    return linhas;
  }
  function relatorio(prints = []) {
    guardar();
    // Todas as larguras de tela com ajustes; a atual vem do que está na tela agora.
    const telas = { ...(guardado?.telas ?? {}), [telaAtual]: [...registrosAtuais(), ...parados] };
    const larguras = Object.keys(telas).map(Number).filter((w) => telas[w].length).sort((a, b) => b - a);
    const avisoParado = {
      diferente: '   atenção: depois de recarregar, este elemento não estava nem como antes nem como depois do ajuste; confira se ainda vale',
      sumiu: '   atenção: depois de recarregar, não achei este elemento na página; confira se ainda vale',
    };
    const linhas = [
      'Ajuste visual — alterações feitas na tela',
      `Página: ${location.href}`,
      `Tela: ${innerWidth}×${innerHeight}px · ${new Date().toLocaleString('pt-BR')}`,
      larguras.length > 1
        ? `Há ajustes em ${larguras.length} larguras de tela (${larguras.map((w) => `${w}px`).join(', ')}). Aplique cada grupo só na sua faixa de largura (media query); os valores são relativos à posição original naquela largura.`
        : 'Aplique no código-fonte que gera estes elementos. Os valores são relativos à posição original, nesta largura de tela.',
      ...prints,
      ...(notaGeral ? [`Nota geral: ${notaGeral.replace(/\s*\n\s*/g, ' / ')}`] : []),
      '',
    ];
    const escreverItem = ({ orig: o, valores: s, novo, codigo, parado }, i) => {
      const atencao = parado ? [avisoParado[parado]] : [];
      if (novo) {
        // Imagem nova: valores finais (não deltas), sem rotação no left/top.
        const n = novo;
        const largura = s.largura ?? n.largura;
        const extras = [
          s.rot ? `rotação ${s.rot}°` : '',
          s.opacidade != null ? `opacidade ${s.opacidade}` : o.opacidade !== 1 ? `opacidade ${o.opacidade}` : '',
          s.espelhado ? 'espelhada na horizontal' : '',
        ].filter(Boolean);
        linhas.push(
          `${i + 1}. ADICIONAR imagem nova  [${n.nome}]`,
          ...atencao,
          `   arquivo: ${n.caminho}`,
          `   colocar dentro de: ${n.pai}` + (n.referencia ? ` (mesma camada de ${n.referencia})` : ''),
          ...(n.codigo ? [`   código do elemento de referência: ${n.codigo}`] : []),
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
      if (s.texto != null) partes.push(`   texto: ${JSON.stringify(o.texto ?? '')} → ${JSON.stringify(s.texto)}`);
      for (const [p, valor] of Object.entries(s.estilos ?? {})) partes.push(`   ${nomeProp[p] ?? p}: ${o.estilos?.[p] ?? '?'} → ${valor}`);
      if (s.porque && s.estilos?.['z-index'] != null) partes.push(`   camada: ${s.porque}`);
      partes.push(...cssFinal(o, s));
      if (s.nota) partes.push(`   nota: ${s.nota.replace(/\s*\n\s*/g, ' / ')}`);
      // Removido vale mais que qualquer outro ajuste no mesmo elemento.
      if (s.removido) partes.splice(0, partes.length, '   remover: tirar este elemento da página');
      linhas.push(
        `${i + 1}. ${o.descricao}`,
        ...atencao,
        ...(codigo ? [`   código: ${codigo}`] : []),
        `   seletor: ${o.seletor}`,
        `   posição original na página: x ${o.x}px, y ${o.y}px · tamanho ${Math.round(o.largura)}×${Math.round(o.altura)}px`,
        ...partes,
        '',
      );
    };
    let i = 0;
    for (const w of larguras) {
      if (larguras.length > 1) linhas.push(`=== Tela de ${w}px de largura${w === telaAtual ? ' (a atual)' : ''} ===`, '');
      for (const r of telas[w]) escreverItem(r, i++);
    }
    if (!i) linhas.push('(nenhuma alteração)');
    return linhas.join('\n');
  }
  /* Prints da página inteira: "antes" sem os ajustes e "depois" com eles e o número de cada item
     do texto marcado em cima do elemento. A interface do editor fica fora dos dois. */
  async function tirarPrints() {
    if (!window.__ajusteFoto) return [];
    guardar();
    const marca = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-');
    const vivos = [...alteracoes.entries()].filter(([, s]) => mudou(s) && !(s.novo && s.removido));
    // Mesma numeração do texto: as larguras maiores vêm antes da atual.
    const telas = guardado?.telas ?? {};
    let n = Object.keys(telas).map(Number).filter((w) => w > telaAtual).reduce((t, w) => t + telas[w].length, 0);
    const displayDaUi = host.style.display;
    host.style.display = 'none';
    const estilos = vivos.map(([el]) => el.getAttribute('style'));
    const marcas = document.createElement('div');
    try {
      vivos.forEach(([el, s]) => {
        if (s.texto != null && s.orig.html != null) el.innerHTML = s.orig.html;
        if (s.novo) el.style.setProperty('display', 'none', 'important');
        else if (s.orig.estiloInline == null) el.removeAttribute('style');
        else el.setAttribute('style', s.orig.estiloInline);
      });
      const antes = await window.__ajusteFoto(`${marca}-antes.jpg`);
      vivos.forEach(([el, s], i) => {
        if (estilos[i] == null) el.removeAttribute('style'); else el.setAttribute('style', estilos[i]);
        if (s.texto != null) el.innerText = s.texto;
      });
      marcas.style.cssText = 'all:initial;position:absolute;left:0;top:0;z-index:2147483646;pointer-events:none;';
      for (const [el, s] of vivos) {
        n++;
        const r = el.getBoundingClientRect();
        const caixa = s.removido
          ? { x: s.orig.x, y: s.orig.y, w: s.orig.largura, h: s.orig.altura }
          : { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
        const m = document.createElement('div');
        m.style.cssText = `all:initial;position:absolute;left:${caixa.x}px;top:${caixa.y}px;width:${caixa.w}px;height:${caixa.h}px;` +
          `outline:2px ${s.removido ? 'dashed' : 'solid'} #ff5a1f;`;
        m.innerHTML = `<span style="all:initial;position:absolute;left:-2px;top:-2px;transform:translate(-50%,-50%);min-width:22px;height:22px;padding:0 5px;box-sizing:border-box;border-radius:11px;background:#ff5a1f;color:#fff;font:700 13px/22px system-ui,sans-serif;text-align:center;">${n}</span>`;
        marcas.appendChild(m);
      }
      document.documentElement.appendChild(marcas);
      const depois = await window.__ajusteFoto(`${marca}-depois.jpg`);
      return [`Prints ${moldura ? `da tela de ${innerWidth}px (a parte que aparece no quadro)` : "da página inteira"}: antes ${antes} · depois (com o número de cada item) ${depois}`];
    } catch (erro) {
      vivos.forEach(([el], i) => { if (estilos[i] == null) el.removeAttribute('style'); else el.setAttribute('style', estilos[i]); });
      avisar(`Não consegui tirar os prints (${erro.message}).`);
      return [];
    } finally {
      marcas.remove();
      host.style.display = displayDaUi;
    }
  }
  async function copiar(comPrints = false) {
    avisar(comPrints ? 'Tirando os prints e copiando…' : 'Copiando…');
    let texto;
    // Um erro ao montar o texto não pode passar calado: aparece no painel e no console.
    try {
      const prints = comPrints ? await tirarPrints() : [];
      texto = relatorio(prints);
    } catch (erro) {
      console.error(`[Ajuste visual] erro ao montar o texto: ${erro.stack || erro.message}`);
      avisar(`Erro ao montar o texto: ${erro.message}${erro.stack ? ` (${erro.stack.split('\n')[1]?.trim()})` : ''}`);
      return;
    }
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

  // Por último: a interface usa funções e variáveis definidas ao longo do arquivo.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', garantirUi);
  else garantirUi();
  setInterval(garantirUi, 1000);
})();
