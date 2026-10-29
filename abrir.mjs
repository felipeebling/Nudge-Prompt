// Ajuste visual: abre uma janela do Chrome (ou Edge) com o editor injetado em todas as páginas.
// Uso: node abrir.mjs [endereço]    (sem endereço, pergunta; padrão http://localhost:4321)
import { chromium } from 'playwright-core';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

// Copia o texto para a área de transferência do Windows e guarda em alteracoes.txt.
await contexto.exposeBinding('__ajusteSalvar', async (_origem, texto) => {
  writeFileSync(join(pasta, 'alteracoes.txt'), texto, 'utf8');
  await new Promise((ok) => {
    // Lê a entrada como UTF-8; sem isso os acentos chegam trocados na área de transferência.
    const comando = '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())';
    const ps = spawn('powershell', ['-NoProfile', '-Command', comando], { stdio: ['pipe', 'ignore', 'ignore'] });
    ps.on('close', ok);
    ps.stdin.end(texto, 'utf8');
  });
  return join(pasta, 'alteracoes.txt');
});
// "+ Imagem": abre a janela de arquivos do Windows e devolve o caminho e a imagem para a página.
const config = join(pasta, 'config.json');
const lerConfig = () => { try { return JSON.parse(readFileSync(config, 'utf8')); } catch { return {}; } };
const tipos = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' };
await contexto.exposeBinding('__ajusteEscolherImagem', async () => {
  const inicial = lerConfig().ultimaPasta ?? join(process.env.USERPROFILE ?? pasta, 'Documents');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    '$dono = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    "$d.Title = 'Escolha a imagem para adicionar'",
    "$d.Filter = 'Imagens|*.webp;*.png;*.jpg;*.jpeg;*.gif;*.svg;*.avif|Todos os arquivos|*.*'",
    `$d.InitialDirectory = '${inicial.replace(/'/g, "''")}'`,
    "if ($d.ShowDialog($dono) -eq 'OK') { $d.FileName }",
  ].join('; ');
  const caminho = await new Promise((ok) => {
    let saida = '';
    const ps = spawn('powershell', ['-STA', '-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    ps.stdout.on('data', (d) => { saida += d; });
    ps.on('close', () => ok(saida.trim()));
  });
  if (!caminho) return null;
  writeFileSync(config, JSON.stringify({ ...lerConfig(), ultimaPasta: dirname(caminho) }, null, 2));
  const ext = caminho.split('.').pop().toLowerCase();
  const dados = readFileSync(caminho).toString('base64');
  return { caminho, nome: caminho.split(/[\\/]/).pop(), url: `data:${tipos[ext] ?? 'application/octet-stream'};base64,${dados}` };
});
await contexto.addInitScript({ content: readFileSync(join(pasta, 'editor.js'), 'utf8') });

const pagina = contexto.pages()[0] ?? await contexto.newPage();
await pagina.goto(endereco).catch((erro) => console.error('Não consegui abrir:', erro.message));
console.log(`Aberto em ${executavel.split('/').pop()}. Na página, aperte Ctrl+Shift+E para ligar o editor.`);
console.log('Feche a janela do navegador para encerrar.');
contexto.on('close', () => process.exit(0));
