// Gera as imagens do README usando o editor na página de exemplo. Uso: node docs/gerar-imagens.mjs
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prepararContexto } from '../ligacoes.mjs';

const docs = dirname(fileURLToPath(import.meta.url));
const pasta = join(docs, '..');
const saida = mkdtempSync(join(tmpdir(), 'nudge-imagens-'));
const executavel = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);

const servidor = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(readFileSync(join(docs, 'exemplo.html')));
}).listen(0);

const navegador = await chromium.launch({ executablePath: executavel, headless: true });
const contexto = await navegador.newContext({ viewport: { width: 1680, height: 900 }, deviceScaleFactor: 1 });
await prepararContexto(contexto, pasta, { saida, copiarParaAreaDeTransferencia: false });
const pagina = await contexto.newPage();
await pagina.goto(`http://localhost:${servidor.address().port}/`);
await pagina.waitForTimeout(500);

let alvo = pagina;
const ui = (seletor) => pagina.locator(`[data-ajuste-visual] ${seletor}`);
const centro = async (seletor) => {
  const r = await alvo.locator(seletor).first().boundingBox();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
async function arrastar(de, dx, dy, soltar = true) {
  await pagina.mouse.move(de.x, de.y);
  await pagina.mouse.down();
  for (let i = 1; i <= 8; i++) await pagina.mouse.move(de.x + (dx * i) / 8, de.y + (dy * i) / 8);
  if (soltar) await pagina.mouse.up();
}

await pagina.keyboard.press('Control+Shift+E');
// O selo desce e vai para a esquerda; o botão ganha outra cor; o título fica menor.
await arrastar(await centro('.selo'), -150, 40);
await pagina.mouse.click(...Object.values(await centro('.botao')));
await ui('details.estilo summary').click();
await ui('input[data-prop="background-color"]').fill('#c4572f');
await pagina.keyboard.press('Enter');
await pagina.mouse.click(...Object.values(await centro('.heroi h1')));
await ui('input[data-prop="font-size"]').fill('56px');
await pagina.keyboard.press('Enter');
await pagina.mouse.click(...Object.values(await centro('.foto')));
await ui('.nota').fill('Trocar o desenho da xícara por uma foto do balcão');
await pagina.keyboard.press('Escape');

// No meio de um arrasto, com a guia de alinhamento à vista.
await arrastar(await centro('.botao'), 0, 24, false);
await pagina.waitForTimeout(200);
await pagina.screenshot({ path: join(docs, 'editor.png') });
await pagina.mouse.up();

await ui('button[data-acao="copiar"]').click();
await pagina.waitForTimeout(500);
writeFileSync(join(docs, 'texto-exemplo.txt'), readFileSync(join(saida, 'alteracoes.txt'), 'utf8'));

// Largura de celular: a página num quadro de 390px e o painel ao lado.
await ui('button[data-tela="390"]').click();
await pagina.waitForURL(/__ajuste-tela/);
await pagina.waitForTimeout(1200);
alvo = pagina.frames().find((f) => f !== pagina.mainFrame());
await pagina.keyboard.press('Control+Shift+E');
await arrastar(await centro('.selo'), -230, -250);
await pagina.waitForTimeout(300);
await pagina.screenshot({ path: join(docs, 'celular.png') });

await navegador.close();
servidor.close();
console.log('imagens em', docs);
