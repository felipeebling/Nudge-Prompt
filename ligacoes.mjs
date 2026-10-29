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
  // Uma janela de arquivos por vez: cliques repetidos enquanto ela está aberta não abrem outras.
  let janelaAberta = null;
  await contexto.exposeBinding('__ajusteEscolherImagem', async () => {
    if (janelaAberta) return null;
    const inicial = lerConfig().ultimaPasta ?? join(process.env.USERPROFILE ?? pasta, 'Documents');
    // A janela de arquivos nascia atrás do Chrome: um dono oculto que nunca aparecia não a trazia
    // para a frente. Agora o dono é mostrado (invisível, 1px, sempre no topo) e ativado antes.
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      "$dono = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; StartPosition = 'CenterScreen'; Width = 1; Height = 1; Opacity = 0; FormBorderStyle = 'None' }",
      '$dono.Show(); $dono.Activate()',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      "$d.Title = 'Escolha a imagem para adicionar'",
      "$d.Filter = 'Imagens|*.webp;*.png;*.jpg;*.jpeg;*.gif;*.svg;*.avif|Todos os arquivos|*.*'",
      `$d.InitialDirectory = '${inicial.replace(/'/g, "''")}'`,
      "if ($d.ShowDialog($dono) -eq 'OK') { $d.FileName }",
      '$dono.Close()',
    ].join('; ');
    janelaAberta = new Promise((ok) => {
      let resposta = '';
      const ps = spawn('powershell', ['-STA', '-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] });
      ps.stdout.on('data', (d) => { resposta += d; });
      ps.on('close', () => ok(resposta.trim()));
    });
    const caminho = await janelaAberta.finally(() => { janelaAberta = null; });
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

  /* Moldura de tela: /__ajuste-tela no mesmo endereço do site (para o editor no quadro alcançar o
     painel na moldura) mostra a página num quadro com a largura pedida e deixa a coluna da direita
     para o painel. Os botões Celular, Tablet e Notebook do editor abrem esta moldura. */
  await contexto.route('**/__ajuste-tela?*', (rota) => {
    const pedido = new URL(rota.request().url());
    const largura = Math.min(Math.max(Number(pedido.searchParams.get('largura')) || 390, 200), 4000);
    // Só caminhos do próprio site: a moldura não abre outro endereço.
    const pagina = pedido.searchParams.get('pagina') ?? '/';
    const caminho = pagina.startsWith('/') && !pagina.startsWith('//') ? pagina : '/';
    const atributo = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    rota.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Ajuste visual · tela</title>
<style>
  html, body { margin: 0; height: 100%; background: #2a2a2d; overflow: hidden; font: 12px system-ui, sans-serif; }
  .palco { position: absolute; inset: 0 336px 0 0; overflow: auto; display: flex; justify-content: center; padding: 28px 24px 16px; box-sizing: border-box; }
  iframe { flex: none; border: 0; background: #fff; height: 100%; border-radius: 6px; box-shadow: 0 10px 40px rgba(0, 0, 0, .45); }
  .rotulo { position: absolute; top: 8px; left: 0; right: 336px; text-align: center; color: #a0a0a5; }
</style></head><body>
<div class="rotulo">${largura}px</div>
<div class="palco"><iframe src="${atributo(caminho)}" style="width: ${largura}px"></iframe></div>
</body></html>`,
    });
  });

  // Prints de antes e depois, na pasta prints/. O nome vem da página: só aceita o formato que o editor gera.
  // Na moldura, o print é do quadro (a parte da página que aparece nele).
  await contexto.exposeBinding('__ajusteFoto', async ({ page, frame }, nome) => {
    if (!/^[\w-]+\.jpg$/.test(nome)) return null;
    const destino = join(saida, 'prints', nome);
    mkdirSync(dirname(destino), { recursive: true });
    const opcoes = { path: destino, type: 'jpeg', quality: 75, animations: 'disabled' };
    if (frame && frame !== page.mainFrame()) await (await frame.frameElement()).screenshot(opcoes);
    else await page.screenshot({ ...opcoes, fullPage: true });
    return destino;
  });

  await contexto.addInitScript({ content: readFileSync(join(pasta, 'editor.js'), 'utf8') });
}
