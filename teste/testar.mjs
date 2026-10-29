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
const botao = (acao) => pagina.locator(`[data-ajuste-visual] button[data-acao="${acao}"]`);
const centro = async (seletor) => {
  const r = await pagina.locator(seletor).first().boundingBox();
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

/* ---------- 3. reaplicar ao recarregar ---------- */
const caixa = (seletor) => pagina.locator(seletor).first().boundingBox();
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

console.log(`\n${total - falhas.length}/${total} conferências passaram.`);
if (falhas.length) console.log(`\nFalhas:\n- ${falhas.join('\n- ')}`);
await navegador.close();
servidor.close();
process.exit(falhas.length ? 1 : 0);
