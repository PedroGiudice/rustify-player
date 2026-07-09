# Retomada: context menu (right-click) no resultado da busca

## Contexto rápido

Rustify Player (Tauri 2.x, backend Rust workspace, frontend SolidJS). Na sessão
anterior (2026-06-27) foram resolvidos 4 problemas, todos na v0.2.35 já instalada na
cmr-auto: (1) busca de tracks reescrita client-side (acha títulos estilizados tipo
`a m a r i` via fallback `squish`), (2) 131 faixas ganharam lyrics sincronizadas via
lrclib, (3) ícones Iconify agora bundle offline (não dependem mais de CDN), (4) 12
títulos do The Off-Season limpos.

**Duas pendências abertas:**
- **(A) right-click não abre o menu de contexto** (play next / add to queue / shuffle)
  nos resultados da busca. A busca acha as tracks (palette Cmd+K), mas a linha do
  resultado não responde ao botão direito. Os TrackRow normais (Tracks, Album,
  Playlist) têm esse menu; o `CommandPalette` nunca foi wirado.
- **(B) algumas faixas não tocam** ao dar play — causa desconhecida ("sei lá porque").
  Ex confirmado: **"5% TINT"** (Travis Scott, álbum ASTROWORLD). **Não é só uma faixa** —
  padrão ainda não caracterizado. Issue independente de (A). Ver seção própria abaixo.

## Arquivos principais

- `src/components/CommandPalette.tsx` — palette de busca (Cmd+K). Renderiza items
  track/album/artist/action. Tem `onClick`/`onMouseMove` por item, **falta `onContextMenu`**.
- `src/store/contextMenu.ts` — store singleton. `openTrackMenu(e, track, {list?, onPlay?})`
  faz preventDefault+stopPropagation e seta o estado; `closeTrackMenu()`.
- `src/components/TrackContextMenu.tsx` — renderiza o menu; montado 1x no App (`App.tsx:98`).
- `src/components/TrackRowTable.tsx:40` — padrão de referência:
  `onContextMenu={(e) => openTrackMenu(e, props.track, { list: props.contextList, onPlay: props.onClick })}`
- `docs/contexto/27062026-search-lyrics-icons-fixes.md` — contexto detalhado da sessão.

## Próximos passos (por prioridade)

### 1. Wirar onContextMenu nos items de track do CommandPalette
**Onde:** `src/components/CommandPalette.tsx`, no `<div class="palette__item">` dentro do
`<For each={items()}>` (~linha 248). Import `openTrackMenu` de `../store/contextMenu`.
**O que:** adicionar `onContextMenu` apenas quando `it.kind === "track"`:
`onContextMenu={(e) => it.kind === "track" && openTrackMenu(e, it.track, { list: searchResults()?.tracks ?? null, onPlay: () => runItem(it) })}`.
A `list` (tracks do resultado) habilita o item Shuffle; `onPlay` reusa `runItem`.
**Por que:** o menu (play next/queue/shuffle) é a forma de enfileirar sem trocar o que toca.
**Verificar:** abrir Cmd+K, buscar, right-click numa track → menu aparece com as ações.

### 2. Garantir z-index do menu SOBRE o overlay do palette
**Onde:** `src/styles/extractor-lab.css` — classes `.palette-scrim`/`.palette` vs a do
TrackContextMenu. O palette é overlay com z-index alto; o menu (montado no App, fora do
scrim) pode renderizar ATRÁS.
**O que:** conferir/ajustar o z-index do menu de contexto p/ ficar acima do `.palette-scrim`.
**Por que:** se o menu abre atrás do scrim, fica invisível/inacessível.
**Verificar:** o menu aparece clicável por cima da palette, não atrás.

### 3. Palette não deve fechar ao abrir o menu; fechar ao escolher ação
**Onde:** `CommandPalette.tsx` — handler de click do `.palette-scrim` (fecha no
click fora) e `handleKey` (Esc). `openTrackMenu` já faz `stopPropagation`.
**O que:** confirmar que o right-click não dispara o close do scrim; e que ao clicar
um item do menu (play next/queue) o palette também fecha (chamar `close()` no fluxo,
ou deixar o TrackContextMenu fechar tudo).
**Por que:** UX — abrir o menu não pode fechar a busca; escolher a ação deve fechar ambos.
**Verificar:** right-click mantém a palette aberta; escolher "play next" fecha palette + menu.

### 4. (opcional) Estender a album/artist
**Onde:** mesmos items.
**O que:** decidir se album/artist no resultado também ganham menu (ex: "tocar álbum").
Hoje só track tem `openTrackMenu`. Provavelmente fora de escopo — confirmar com o usuário.

## Segundo issue (independente): algumas faixas não tocam

**Sintoma:** ao dar play em certas faixas, não toca. Não é uma só. Exemplo confirmado
pelo usuário: **"5% TINT"** do Travis Scott (álbum **ASTROWORLD**). Causa desconhecida.

**Ainda não investigado** — a inspeção desta sessão falhou por escaping de path (zsh +
espaços) e foi abortada a pedido do usuário (documentar, não resolver agora). Zero dados
coletados sobre a faixa real ainda.

**Contexto técnico:** o playback é via **GStreamer** (não tag `<audio>` HTML — ver
memória `project_gstreamer_migration`). Backend em `src-tauri/crates/audio-engine/`.
Frontend dispara via `playTrack` (`src/components/PlayerBar.tsx`) → command Tauri → engine.

**Roteiro de diagnóstico (próxima sessão):**
1. **Reproduzir e ler logs**: tocar a faixa que falha e capturar o erro. Console do
   webview (tauri-mcp `read_logs` source=console) + log do app
   (`@tauri-apps/plugin-log`, ver onde grava). O erro do GStreamer (elemento/caps) é a pista.
2. **Inspecionar o arquivo** (cuidado com espaços no path — use heredoc ou variável aspada,
   NÃO interpolar em comando zsh):
   `ffprobe -v error -show_entries stream=codec_name,sample_rate,bits_per_raw_sample,channels`
   + `gst-discoverer-1.0 <arquivo>`. A "5% TINT" está em
   `~/Music/Rap & Hip-Hop/` (achar com `find ~/Music -iname "*tint*"`).
3. **Comparar toca vs não-toca**: codec/sample_rate/bit_depth/channels de uma faixa que
   toca vs uma que não. Hipótese a testar: FLAC 24-bit, sample rate 48k/96k, ou canais != 2.
4. **GStreamer plugins**: `gst-inspect-1.0 | grep -iE "flac|audioconvert|audioresample"` —
   ver se falta plugin pra algum formato. Checar a cadeia DSP do engine
   (`crates/audio-engine/src/output/`) p/ ver se assume sample_rate/format fixo.
5. Caracterizar o PADRÃO (quais faixas falham) antes de corrigir — pode ser um subconjunto
   por formato/origem (ex: rip específico do intake de rap).

**Onde provavelmente está:** `src-tauri/crates/audio-engine/` (decode/output GStreamer) —
suspeita de assumir um formato/sample-rate fixo, ou faltar resample/convert na pipeline.

## Como verificar

```bash
# Validação local (busca/lógica) — roda na VM
cd /home/opc/rustify-player/src-tauri && cargo test -p library-indexer --lib  # 91 pass
cd /home/opc/rustify-player && npm run typecheck                              # 0 erros

# Build + release + install (CLAUDE.md: acumular mudanças, 1 release no fim)
./scripts/release.sh
# instalar na cmr-auto (sudo sem senha + gh disponíveis lá):
ssh cmr-auto@100.102.249.9 'gh release download -R PedroGiudice/rustify-player -p "rustify-player_*_amd64.deb" -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_*_amd64.deb'

# Validação ao vivo do webview (tauri-mcp bridge na cmr-auto:9223):
# driver_session start host=100.102.249.9 port=9223 → webview_execute_js
# (reiniciar o app pega o binário novo: kill <pid> + relançar /usr/bin/rustify-player
#  com DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS do /proc/<pid>/environ)
```

## Restrições

- O app roda na **cmr-auto** (Qdrant sidecar local + FLACs lá), não na VM. Inspeção via
  SSH/tauri-mcp; o usuário instala/testa. SSH precisa de `dangerouslyDisableSandbox` no Bash tool.
- **Validar no ambiente real** antes de afirmar fix (lição da sessão anterior).
- Não compilar/release a cada edição — acumular e rodar `release.sh` uma vez (CLAUDE.md).
- Não mexer em `src/js/` nem `src/main.js`/`src/index.html` (legacy; entry real é
  `index.html` raiz → `src/main.tsx`).
