// Ajuste visual: abre uma janela do Chrome (ou Edge) com o editor injetado em todas as páginas.
// Uso: node abrir.mjs [endereço]    (sem endereço, pergunta; padrão http://localhost:4321)
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { prepararContexto } from './ligacoes.mjs';

const pasta = dirname(fileURLToPath(import.meta.url));
const navegadores = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const executavel = navegadores.find(existsSync);
if (!executavel) {
  console.error('Não encontrei o Chrome nem o Edge instalados.');
  process.exit(1);
}

let endereco = process.argv[2];
if (!endereco) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  endereco = (await rl.question('Endereço da página [http://localhost:4321]: ')).trim() || 'http://localhost:4321';
  rl.close();
}
if (!/^[a-z]+:\/\//i.test(endereco)) endereco = `http://${endereco}`;

// Perfil próprio, para não mexer no Chrome do dia a dia; logins feitos aqui ficam guardados.
const perfil = join(pasta, 'perfil');
mkdirSync(perfil, { recursive: true });
const contexto = await chromium.launchPersistentContext(perfil, {
  executablePath: executavel,
  headless: false,
  viewport: null,
  args: ['--start-maximized'],
});
await prepararContexto(contexto, pasta);

// Erros do editor aparecem também nesta janela preta, para dar para mandar ao agente.
const mostrarErros = (p) => p.on('console', (m) => {
  if (m.type() === 'error' && m.text().includes('[Ajuste visual]')) console.error(m.text());
});
contexto.pages().forEach(mostrarErros);
contexto.on('page', mostrarErros);

const pagina = contexto.pages()[0] ?? await contexto.newPage();
await pagina.goto(endereco).catch((erro) => console.error('Não consegui abrir:', erro.message));
console.log(`Aberto em ${executavel.split('/').pop()}. Na página, aperte Ctrl+Shift+E para ligar o editor.`);
console.log('Feche a janela do navegador para encerrar.');
contexto.on('close', () => process.exit(0));
