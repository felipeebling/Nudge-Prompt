// Teste automático: abre teste/pagina.html num Chrome invisível, usa o editor como uma pessoa usaria
// e confere o texto gerado. Uso: npm test
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prepararContexto } from '../ligacoes.mjs';

const pasta = join(dirname(fileURLToPath(import.meta.url)), '..');
const saida = mkdtempSync(join(tmpdir(), 'ajuste-teste-'));
const executavel = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

// trocas: simula o agente mudando o código da página entre um recarregamento e outro.
let trocas = [];
const servidor = createServer((req, res) => {
  let html = readFileSync(join(pasta, 'teste', 'pagina.html'), 'utf8');
  for (const [de, para] of trocas) html = html.replace(de, para);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
}).listen(0);
const endereco = `http://localhost:${servidor.address().port}/`;

const navegador = await chromium.launch({ executablePath: executavel, headless: true });
const contexto = await navegador.newContext({ viewport: { width: 1280, height: 800 } });
await prepararContexto(contexto, pasta, { saida, copiarParaAreaDeTransferencia: false });
const pagina = await contexto.newPage();
pagina.on('pageerror', (e) => falhas.push(`erro na página: ${e.message}`));

const falhas = [];
let total = 0;
function conferir(nome, ok, detalhe = '') {
  total++;
  if (!ok) falhas.push(`${nome}${detalhe ? `\n     ${detalhe}` : ''}`);
  console.log(`${ok ? '  ok ' : 'FALHA'}  ${nome}`);
}
// alvo: onde está a página (a própria aba, ou o quadro da moldura de tela).
let alvo = pagina;
const botao = (acao) => pagina.locator(`[data-ajuste-visual] button[data-acao="${acao}"]`);
const centro = async (seletor) => {
  const r = await alvo.locator(seletor).first().boundingBox();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
async function arrastar(de, dx, dy) {
  await pagina.mouse.move(de.x, de.y);
  await pagina.mouse.down();
  await pagina.mouse.move(de.x + dx / 2, de.y + dy / 2, { steps: 3 });
  await pagina.mouse.move(de.x + dx, de.y + dy, { steps: 3 });
  await pagina.mouse.up();
}
async function relatorio() {
  await botao('copiar').click();
  await pagina.waitForTimeout(300);
  return readFileSync(join(saida, 'alteracoes.txt'), 'utf8');
}
const ligar = () => pagina.keyboard.press('Control+Shift+E');

/* ---------- 1. arquivo e linha do código ---------- */
await pagina.goto(endereco);
await ligar();
await arrastar(await centro('.arte-a'), 50, 20);
let texto = await relatorio();
conferir('move a imagem e descreve o deslocamento', texto.includes('mover: 50px para a direita, 20px para baixo'), texto);
conferir('mostra o arquivo e a linha do código (Astro)', texto.includes('código: C:/site/src/components/Artes.astro:7'), texto);
await arrastar(await centro('.arte-b'), -30, 0);
texto = await relatorio();
conferir('sem marca no elemento, usa a do ancestral', /código: C:\/site\/src\/pages\/teste\.astro:20 \(marca do ancestral <main\.palco>\)/.test(texto), texto);

/* ---------- 2. CSS final ---------- */
conferir('CSS final do deslocamento', texto.includes('CSS final: translate: 50px 20px'), texto);
conferir('sugere mexer no left/top de elemento absoluto', texto.includes('some 50px no left e 20px no top'), texto);
conferir('deslocamento em proporção do contêiner', texto.includes('em proporção da largura do contêiner (1280px): deslocamento horizontal 3.9%'), texto);
// .arte-b já tem rotate: 10deg na página; Shift+rodinha gira mais 2°.
await pagina.mouse.move((await centro('.arte-b')).x, (await centro('.arte-b')).y);
await pagina.keyboard.down('Shift');
await pagina.mouse.wheel(0, -100);
await pagina.keyboard.up('Shift');
texto = await relatorio();
conferir('rotação final soma a que a página já tinha', texto.includes('rotate: 12deg'), texto);

/* ---------- 3. reaplicar ao recarregar ---------- */
const caixa = (seletor) => alvo.locator(seletor).first().boundingBox();
const aviso = () => pagina.locator('[data-ajuste-visual] .aviso').textContent();
const recarregar = async () => { await pagina.reload(); await pagina.waitForTimeout(900); };
const igual = (a, b) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
const antesA = await caixa('.arte-a');
await recarregar();
let depoisA = await caixa('.arte-a');
conferir('recarregar reaplica o ajuste', igual(antesA, depoisA), JSON.stringify({ antesA, depoisA }));
conferir('avisa quantas foram reaplicadas', (await aviso()).includes('2 reaplicada(s)'), await aviso());
// O código mudou de outro jeito: não reaplica, avisa e mantém o pedido guardado e no texto.
trocas = [['.arte-a { left: 40px; top: 60px; }', '.arte-a { left: 300px; top: 60px; }']];
await recarregar();
conferir('diferente do esperado: avisa e não reaplica', (await aviso()).includes('diferente(s) do esperado'), await aviso());
await ligar();
conferir('o pedido parado continua no texto', (await relatorio()).includes('atenção: depois de recarregar'));
trocas = [];
await recarregar();
conferir('voltando o código, reaplica o que estava parado', (await aviso()).includes('2 reaplicada(s)'), await aviso());
// O agente aplicou o ajuste da .arte-a no código (left 40 → 90, top 60 → 80).
trocas = [['.arte-a { left: 40px; top: 60px; }', '.arte-a { left: 90px; top: 80px; }']];
await recarregar();
depoisA = await caixa('.arte-a');
conferir('com a mudança já no código, não move de novo', igual(antesA, depoisA), JSON.stringify({ antesA, depoisA }));
conferir('avisa que já está no código', (await aviso()).includes('1 já no código'), await aviso());
trocas = [];
await recarregar();
await ligar();
await botao('limpar').click();
await recarregar();
conferir('"Limpar tudo" também apaga o que estava guardado', !(await aviso()), await aviso());

/* ---------- 4. larguras de tela (moldura com o painel ao lado) ---------- */
const telaBotao = (w) => pagina.locator(`[data-ajuste-visual] button[data-tela="${w}"]`);
const largura = () => alvo.evaluate(() => innerWidth);
await ligar();
await arrastar(await centro('.arte-a'), 50, 20);
const naLargura = await caixa('.arte-a');
await telaBotao(390).click();
await pagina.waitForURL(/__ajuste-tela/);
await pagina.waitForTimeout(1200);
alvo = pagina.frames().find((f) => f !== pagina.mainFrame());
conferir('botão Celular abre a página num quadro de 390px', !!alvo && (await largura()) === 390);
await ligar();
const quadro = await pagina.locator('iframe').boundingBox();
const lado = await pagina.locator('[data-ajuste-visual] .painel').boundingBox();
conferir('o painel fica ao lado do quadro, sem cobrir a página', lado.x >= quadro.x + quadro.width, JSON.stringify({ quadro, lado }));
conferir('na outra largura, o ajuste de 1280px não aparece', (await alvo.evaluate(() => document.querySelector('.arte-a').style.translate)) === '');
await arrastar(await centro('.card h2'), 0, 30);
// ~30px para baixo (as guias podem grudar alguns px adiante).
conferir('arrastar dentro do quadro funciona', /moveu 0, 3\dpx/.test(await pagina.locator('[data-ajuste-visual] .sel-info').innerText()), await pagina.locator('[data-ajuste-visual] .sel-info').innerText());
texto = await relatorio();
conferir('o texto separa os ajustes por largura', texto.includes('=== Tela de 1280px de largura ===') && texto.includes('=== Tela de 390px de largura (a atual) ==='), texto);
await telaBotao(768).click();
await pagina.waitForTimeout(900);
conferir('na moldura, Tablet só muda a largura do quadro', (await largura()) === 768 && (await aviso()).includes('Tela 390px → 768px'), await aviso());
await telaBotao(0).click();
await pagina.waitForURL((u) => !u.href.includes('__ajuste-tela'));
await pagina.waitForTimeout(900);
alvo = pagina;
conferir('Janela volta para a página normal', (await largura()) === 1280);
conferir('voltando, os ajustes daquela largura voltam', igual(naLargura, await caixa('.arte-a')), JSON.stringify([naLargura, await caixa('.arte-a')]));
await ligar();

/* ---------- 5. prints ---------- */
await botao('copiar-prints').click();
await pagina.waitForFunction(() => document.querySelector('[data-ajuste-visual]').shadowRoot.querySelector('.aviso').textContent.startsWith('Copiado'), null, { timeout: 30000 });
texto = readFileSync(join(saida, 'alteracoes.txt'), 'utf8');
const prints = existsSync(join(saida, 'prints')) ? readdirSync(join(saida, 'prints')) : [];
conferir('salva os prints de antes e depois', prints.some((p) => p.endsWith('-antes.jpg')) && prints.some((p) => p.endsWith('-depois.jpg')), prints.join(', '));
conferir('o texto aponta os prints', texto.includes('Prints da página inteira: antes '), texto);
conferir('a interface volta depois dos prints', await pagina.locator('[data-ajuste-visual] .pilula').isVisible());
console.log(`     prints em ${join(saida, 'prints')}`);

/* ---------- 6. texto e estilo ---------- */
await botao('limpar').click();
const h2 = await centro('.card h2');
await pagina.mouse.dblclick(h2.x, h2.y);
await pagina.keyboard.type('Bem-vindo a São Pedro');
await pagina.keyboard.press('Enter');
conferir('duplo clique edita o texto na página', (await pagina.locator('.card h2').innerText()) === 'Bem-vindo a São Pedro');
const campo = (prop) => pagina.locator(`[data-ajuste-visual] input[data-prop="${prop}"]`);
await pagina.locator('[data-ajuste-visual] details.estilo summary').click();
await campo('font-size').fill('34px');
await campo('font-size').press('Enter');
await campo('color').fill('rgb(200, 0, 0)');
await campo('color').press('Enter');
conferir('o campo de estilo muda o elemento', await pagina.locator('.card h2').evaluate((el) => getComputedStyle(el).fontSize === '34px'));
texto = await relatorio();
conferir('o texto mostra o antes e o depois do texto', texto.includes('texto: "Conheça a cidade" → "Bem-vindo a São Pedro"'), texto);
conferir('o texto mostra o estilo alterado', texto.includes('tamanho da fonte: 28px → 34px') && texto.includes('cor do texto: rgb(58, 42, 26) → rgb(200, 0, 0)'), texto);
conferir('o estilo entra no CSS final', texto.includes('font-size: 34px'), texto);
await pagina.keyboard.press('Control+z');
await pagina.keyboard.press('Control+z');
await pagina.keyboard.press('Control+z');
conferir('desfazer volta o estilo e o texto', (await pagina.locator('.card h2').innerText()) === 'Conheça a cidade' &&
  await pagina.locator('.card h2').evaluate((el) => getComputedStyle(el).fontSize === '28px'));

/* ---------- 7. vários elementos ---------- */
await pagina.keyboard.press('Escape');
await pagina.mouse.click((await centro('.arte-a')).x, (await centro('.arte-a')).y);
await pagina.keyboard.down('Shift');
await pagina.mouse.click((await centro('.botao')).x, (await centro('.botao')).y);
await pagina.keyboard.up('Shift');
conferir('Shift+clique põe na seleção', (await pagina.locator('[data-ajuste-visual] .sel-info').innerText()).includes('+ 1 na seleção'));
const antesBotao = await caixa('.botao');
await pagina.keyboard.press('Shift+ArrowDown');
const depoisBotao = await caixa('.botao');
conferir('as setas movem a seleção inteira', Math.round(depoisBotao.y - antesBotao.y) === 10, JSON.stringify([antesBotao, depoisBotao]));
await pagina.locator('[data-ajuste-visual] button[data-alinhar="topo"]').click();
const [ta, tb] = [await caixa('.arte-a'), await caixa('.botao')];
conferir('alinhar em cima iguala o topo', Math.abs(ta.y - tb.y) < 1, JSON.stringify([ta, tb]));

/* ---------- 8. guias e medidas ---------- */
await botao('limpar').click();
await pagina.keyboard.press('Escape');
// Arrasta a .arte-a até quase encostar na borda esquerda do card: deve grudar nela.
const card = await caixa('.card');
const arte = await caixa('.arte-a');
await arrastar(await centro('.arte-a'), Math.round(card.x - arte.x) + 3, 0);
conferir('ao arrastar, gruda na guia mais próxima', Math.abs((await caixa('.arte-a')).x - card.x) < 1, JSON.stringify([await caixa('.arte-a'), card]));
await pagina.mouse.move((await centro('.botao')).x, (await centro('.botao')).y);
await pagina.waitForTimeout(100);
conferir('mostra a medida até o elemento sob o mouse', await pagina.locator('[data-ajuste-visual] .medida').first().isVisible());

/* ---------- 9. notas ---------- */
await pagina.locator('[data-ajuste-visual] .nota').fill('Trocar esta forma por uma foto da praça');
await pagina.keyboard.press('Escape');
await pagina.keyboard.press('Escape');
await pagina.locator('[data-ajuste-visual] .nota').fill('Deixar a página mais clara');
texto = await relatorio();
conferir('a nota do elemento entra no texto', texto.includes('nota: Trocar esta forma por uma foto da praça'), texto);
conferir('a nota geral entra no texto', texto.includes('Nota geral: Deixar a página mais clara'), texto);
await recarregar();
await ligar();
conferir('"Limpar tudo" limpa também as outras larguras', !texto.includes('=== Tela de 390px'), texto);
conferir('a nota geral volta depois de recarregar', (await pagina.locator('[data-ajuste-visual] .nota').inputValue()) === 'Deixar a página mais clara');

/* ---------- elemento que sai da página ---------- */
// O site troca um pedaço da página (recarga parcial, componente que renderiza de novo) depois do ajuste.
await botao('limpar').click();
await pagina.keyboard.press('Escape');
await arrastar(await centro('.botao'), 20, 0);
await pagina.evaluate(() => { const b = document.querySelector('.botao'); b.replaceWith(b.cloneNode(true)); });
texto = await relatorio();
conferir('copiar funciona com um elemento ajustado que saiu da página', texto.includes('mover: 20px para a direita'), await aviso());

/* ---------- camadas: para frente / para trás ---------- */
await botao('limpar').click();
await pagina.keyboard.press('Escape');
await pagina.mouse.click(580, 545);
const zFundo = () => pagina.locator('.fundo-artes').evaluate((el) => getComputedStyle(el).zIndex);
await botao('frente').click();
conferir('"Para frente" sobe a camada do bloco que contém a gravura', (await zFundo()) === '2', await zFundo());
conferir('a gravura continua no mesmo lugar', igual(await caixa('.arte-c'), { x: 500, y: 520 }), JSON.stringify(await caixa('.arte-c')));
texto = await relatorio();
conferir('o texto explica a camada', texto.includes('camada: trazer para a frente de section.faixa, para que img.arte.arte-c') && texto.includes('z-index: 2'), texto);
await botao('frente').click();
conferir('na frente de tudo, avisa e não muda', (await aviso()).includes('Já está na frente') && (await zFundo()) === '2', await aviso());
await pagina.keyboard.press('Control+BracketLeft');
conferir('Ctrl+[ manda para trás', (await zFundo()) === '0', await zFundo());


console.log(`\n${total - falhas.length}/${total} conferências passaram.`);
if (falhas.length) console.log(`\nFalhas:\n- ${falhas.join('\n- ')}`);
await navegador.close();
servidor.close();
process.exit(falhas.length ? 1 : 0);
