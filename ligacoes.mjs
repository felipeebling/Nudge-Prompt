// Funções do Node que o editor chama pela página (copiar, escolher imagem...), e a injeção do editor.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

const tipos = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' };
const comoDataUrl = (caminho) => {
  const ext = caminho.split('.').pop().toLowerCase();
  return `data:${tipos[ext] ?? 'application/octet-stream'};base64,${readFileSync(caminho).toString('base64')}`;
};

// saida: pasta onde ficam alteracoes.txt e os prints (o teste usa outra para não apagar os seus).
export async function prepararContexto(contexto, pasta, { saida = pasta, copiarParaAreaDeTransferencia = true } = {}) {
  // Copia o texto para a área de transferência do Windows e guarda em alteracoes.txt.
  await contexto.exposeBinding('__ajusteSalvar', async (_origem, texto) => {
    writeFileSync(join(saida, 'alteracoes.txt'), texto, 'utf8');
    if (copiarParaAreaDeTransferencia) {
      await new Promise((ok) => {
        // Lê a entrada como UTF-8; sem isso os acentos chegam trocados na área de transferência.
        const comando = '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())';
        const ps = spawn('powershell', ['-NoProfile', '-Command', comando], { stdio: ['pipe', 'ignore', 'ignore'] });
        ps.on('close', ok);
        ps.stdin.end(texto, 'utf8');
      });
    }
    return join(saida, 'alteracoes.txt');
  });

  // "+ Imagem": abre a janela de arquivos do Windows e devolve o caminho e a imagem para a página.
  const config = join(pasta, 'config.json');
  const lerConfig = () => { try { return JSON.parse(readFileSync(config, 'utf8')); } catch { return {}; } };
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
      let resposta = '';
      const ps = spawn('powershell', ['-STA', '-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
      ps.stdout.on('data', (d) => { resposta += d; });
      ps.on('close', () => ok(resposta.trim()));
    });
    if (!caminho) return null;
    const escolhidas = [...new Set([caminho, ...(lerConfig().imagensEscolhidas ?? [])])].slice(0, 200);
    writeFileSync(config, JSON.stringify({ ...lerConfig(), ultimaPasta: dirname(caminho), imagensEscolhidas: escolhidas }, null, 2));
    return { caminho, nome: caminho.split(/[\\/]/).pop(), url: comoDataUrl(caminho) };
  });
  // Reler uma imagem nova ao recarregar a página. Só entrega arquivos escolhidos antes na janela de
  // arquivos: qualquer site aberto nesta janela pode chamar esta função, e ela não pode virar leitor de disco.
  await contexto.exposeBinding('__ajusteLerImagem', async (_origem, caminho) => {
    if (!(lerConfig().imagensEscolhidas ?? []).includes(caminho) || !existsSync(caminho)) return null;
    return comoDataUrl(caminho);
  });

  // Botões de largura de tela: emula a largura pedida (null volta ao tamanho da janela).
  const sessoes = new WeakMap();
  await contexto.exposeBinding('__ajusteTela', async ({ page }, largura) => {
    if (!sessoes.has(page)) sessoes.set(page, await contexto.newCDPSession(page));
    const cdp = sessoes.get(page);
    if (!largura) await cdp.send('Emulation.clearDeviceMetricsOverride');
    else await cdp.send('Emulation.setDeviceMetricsOverride', { width: largura, height: 0, deviceScaleFactor: 0, mobile: largura < 768 });
  });

  // Prints de antes e depois, na pasta prints/. O nome vem da página: só aceita o formato que o editor gera.
  await contexto.exposeBinding('__ajusteFoto', async ({ page }, nome) => {
    if (!/^[\w-]+\.jpg$/.test(nome)) return null;
    const destino = join(saida, 'prints', nome);
    mkdirSync(dirname(destino), { recursive: true });
    await page.screenshot({ path: destino, fullPage: true, type: 'jpeg', quality: 75, animations: 'disabled' });
    return destino;
  });

  await contexto.addInitScript({ content: readFileSync(join(pasta, 'editor.js'), 'utf8') });
}
