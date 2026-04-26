# Retomada: Rustify Player — Frontend Polish, Playback Bug, Remaining Features

## Contexto rapido

Sessao de ~3.5h integrou 3 features novas no Rustify Player (Tauri 2.x, vanilla JS, Editorial HiFi design):
- **Stations** (mood radios com accent colors translucidas, grid responsivo, detail view com track table)
- **Like/Favorites** (chama pixel art como icone, toggle no player bar, Liked Songs no topo de playlists)
- **Search global** (titlebar, contextual por rota: global/playlist/filter/none, Ctrl+K, Esc, debounce 250ms)

Alem disso: 9 accent colors (4 novas), font picker via fc-list, zoom slider, contraste AA corrigido, VU bars movidas pra Now Playing, transport lock contra race condition, cover sync no gapless auto-advance, visibility sync quando app volta ao foco.

25 commits em main, 6 releases publicados. Bug intermitente de playback em background identificado mas nao reproduzido em 30 min de monitoramento via Tauri MCP.

## Arquivos principais

- `src/js/components/player-bar.js` -- transporte, like, cover, transition lock, visibility sync
- `src/js/components/search-bar.js` -- search global contextual (313 linhas)
- `src/js/components/tweaks.js` -- accent, density, sidebar, fonts, zoom
- `src/js/views/stations.js` -- stations view completa
- `src/styles/tokens.css` -- design tokens (9 accent themes, contraste corrigido)
- `src/styles/components.css` -- todos os estilos de componentes
- `docs/contexto/26042026-frontend-features-integration.md` -- contexto detalhado desta sessao

## Proximos passos (por prioridade)

### 1. Investigar bug intermitente de playback em background
**Onde:** `src/js/components/player-bar.js`, funcoes `listenEngine()`, `bindVisibilitySync()`
**O que:** Adicionar `console.warn("[player] state event:", payload)` nos handlers de `player-state` para ter trace completo na proxima reproducao. O bug: apos >30 min em background, playback para, UI mostra estado errado, play button nao responde. `visibilitychange` sync pode estar ajudando mas nao eliminou.
**Por que:** Bug de UX critico — app fica inutilizavel ate restart
**Verificar:** Reproduzir: tocar playlist, ir pro Chrome, voltar apos 30+ min. Se bug ocorrer, console logs dao o trace.

### 2. Like icon em track rows
**Onde:** `src/js/views/tracks.js`, `playlists.js`, `stations.js` (funcoes de renderRows)
**O que:** Adicionar coluna de flame icon nas track tables com toggle via `lib_toggle_like`. Reutilizar `.like-btn` CSS.
**Por que:** Spec original previa like em track rows, nao so player bar
**Verificar:** Click na flame numa track row deve toggle liked state + icone muda visualmente

### 3. Search keyboard navigation
**Onde:** `src/js/components/search-bar.js`, funcao de input keydown handler
**O que:** Arrow up/down movem highlight entre items do dropdown, Enter seleciona item focado
**Por que:** Power users esperam navegar resultados sem mouse
**Verificar:** Ctrl+K → digitar → setas → Enter deve selecionar item

### 4. Tweaks panel scroll
**Onde:** `src/styles/components.css`, classe `.tweaks__body`
**O que:** Adicionar `overflow-y: auto; max-height: calc(100vh - 200px)`
**Por que:** Panel fica longo em janelas pequenas com 9 cores + font selects
**Verificar:** Abrir tweaks em janela 800px, tudo acessivel via scroll

### 5. Station cover art
**Onde:** `src/js/views/stations.js` funcao `renderList()`, possivelmente backend
**O que:** Se `cover_path` presente, usar como background-image no card. Fallback: color-mix atual.
**Por que:** Identidade visual mais forte por station
**Verificar:** Stations com cover_path mostram imagem; sem cover_path mantem cor translucida

## Como verificar

```bash
cargo check --manifest-path src-tauri/Cargo.toml  # deve compilar limpo
# No app (cmr-auto):
# 1. Stations: sidebar > Stations > 8 cards coloridos > click > track table > play
# 2. Like: tocar musica > flame no player bar > toggle > Playlists > Liked Songs
# 3. Search: Ctrl+K > "j cole" > dropdown com tracks/albums/artists > click track toca
# 4. Tweaks: sidebar > Tweaks > 9 cores (2 linhas) > font picker > zoom slider
# 5. Background: tocar playlist, ir pro Chrome 5 min, voltar > UI sincronizada
```

<session_metadata>
branch: main
last_commit: 196732a
total_commits_session: 25
files_changed: 21
lines_added: ~2961
lines_removed: ~53
releases_published: 6
open_bug: playback-background-desync (intermitente, nao reproduzido em 30min monitoring)
</session_metadata>
