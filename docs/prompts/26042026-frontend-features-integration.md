# Retomada: Rustify Player — Frontend Polish & Remaining Features

## Contexto rapido

Sessao frontend integrou 3 features novas no Rustify Player (Tauri 2.x, vanilla JS, Editorial HiFi design): **Stations** (mood radios com accent colors), **Like/Favorites** (chama pixel art toggle no player bar + Liked Songs em playlists), e **Search global** (titlebar, contextual por rota, Ctrl+K). Tambem: 9 accent colors, font picker via fc-list, zoom slider, transport lock contra race condition, fix de cover no auto-advance gapless, contraste AA corrigido.

20 commits em main, tudo publicado via release.sh. App funcional na cmr-auto.

## Arquivos principais

- `src/js/components/player-bar.js` -- transporte, like, cover, transition lock
- `src/js/components/search-bar.js` -- search global contextual (313 linhas)
- `src/js/components/tweaks.js` -- accent, density, sidebar, fonts, zoom
- `src/js/views/stations.js` -- stations view completa
- `src/styles/tokens.css` -- design tokens (cores, fontes, spacing)
- `src/styles/components.css` -- todos os estilos de componentes
- `docs/contexto/26042026-frontend-features-integration.md` -- contexto detalhado

## Proximos passos (por prioridade)

### 1. Like icon em track rows
**Onde:** `src/js/views/tracks.js`, `playlists.js`, `stations.js` (funcao renderRows)
**O que:** Adicionar coluna de flame icon nas track tables com toggle on click
**Por que:** Spec original previa like em track rows, nao so player bar
**Verificar:** Clicar flame numa track row deve toggle estado + persistir

### 2. Station cover art
**Onde:** `src/js/views/stations.js` (renderList), backend migration se necessario
**O que:** Exibir cover_path como imagem de fundo no card quando disponivel
**Por que:** Cards com cor solida funcionam, mas imagem daria mais identidade
**Verificar:** Cards com cover_path mostram imagem; sem cover_path mantem color-mix

### 3. Tweaks panel scroll
**Onde:** `src/styles/components.css` (classe `.tweaks__body`)
**O que:** Adicionar `overflow-y: auto; max-height: calc(100vh - 200px)` no body do tweaks
**Por que:** Panel fica longo com 9 cores + font selects + sliders
**Verificar:** Abrir tweaks em janela pequena, tudo acessivel via scroll

### 4. Search UX refinements
**Onde:** `src/js/components/search-bar.js`
**O que:** Keyboard navigation no dropdown (arrow keys), highlight do item selecionado
**Por que:** Power users esperam navegar resultados sem mouse
**Verificar:** Ctrl+K, digitar, setas pra navegar, Enter pra selecionar

## Como verificar

```bash
cargo check --manifest-path src-tauri/Cargo.toml  # deve compilar limpo
# Testar no app:
# 1. Stations: sidebar > Stations > cards coloridos > click card > track table > play
# 2. Like: tocar musica > flame ao lado do titulo > toggle > Playlists > Liked Songs
# 3. Search: Ctrl+K > digitar "j cole" > dropdown com tracks/albums/artists > click
# 4. Tweaks: sidebar > Tweaks > trocar accent/font/zoom > persistido apos restart
```

<session_metadata>
branch: main
last_commit: ca4c93d
total_commits_session: 20
files_changed: 24
lines_added: ~2849
lines_removed: ~43
</session_metadata>
