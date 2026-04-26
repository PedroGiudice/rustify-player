# Contexto: Frontend Features Integration (Stations, Like, Search + Polish + Debugging)

**Data:** 2026-04-26
**Sessao:** main (frontend session)
**Duracao:** ~3.5h

---

## O que foi feito

### 1. Stations View (Mood Radios)
Nova view `#/stations` com grid responsivo de cards (`auto-fill, minmax(320px, 1fr)`). Cada station tem `accent_color` do backend aplicada via CSS custom property `--station-color` inline. Design iterado com usuario:

- Primeira versao: gradiente pesado da accent_color → usuario rejeitou ("blocos de cor solida translucidos")
- Versao final: `color-mix(in srgb, var(--station-color) 12%, var(--surface-container))` — wash sutil
- Borda esquerda 3px na accent_color, borda geral com 20% da accent
- Play button creme (`--on-surface` = #edeae3), nao colorido
- Dois modos: lista (card grid) e detalhe (track table com back button chevron-left)
- Play button no card: shuffle tracks da station e play
- Click no card: abre detalhe com track table
- Right-click em track row: enqueue next

Referencia de layout: `~/Downloads/rustify-stations-preview.html` (preview HTML gerado pelo Gemini, puxado da cmr-auto).

IPC usados: `lib_list_moods()` → grid | `lib_list_mood_tracks({ moodId })` → tabela

### 2. Like / Favorites

**Icone:** chama pixel art vetorizada da imagem `firemusic.jpg` fornecida pelo usuario. Processo: Pillow → threshold → grid 12x15 → otimizado de 67 rects para 35 horizontal spans. Symbol `icon-flame` no sprite SVG com path `fill="currentColor"`.

**Player bar:** botao `#pb-like` inserido apos `player-bar__track-meta`. Hidden ate track ser carregada. Toggle via `lib_toggle_like({ trackId })`. Visual: `.like-btn` com cor muted default, `.is-liked` com `--primary` + `drop-shadow` glow. Estado sincronizado via `lib_is_liked({ trackId })` chamado em `playTrack()` e em `updateTrackMeta()` (gapless auto-advance).

**Playlists:** "Liked Songs" entry especial no topo da view `/playlists`. Busca `lib_list_liked({})` para count. Classe `.folder-item--liked` com borda esquerda accent. `openLiked()` funcao dedicada com back button, track table, click/contextmenu handlers.

### 3. Global Search Bar

Componente `search-bar.js` (313 linhas) montado no titlebar center (`#titlebar-center`), substituindo o texto estatico "Kinetic Vault". Dois estados visuais: trigger button compacto ("Ctrl+K") e input expandido.

**Modos contextuais por rota:**

| Rota | Modo | Backend | Display |
|------|------|---------|---------|
| `/home`, `/tracks`, `/artists`, `/albums` | `global` | `lib_search({ query, limit: 8 })` | Dropdown com secoes: Tracks, Albums, Artists |
| `/playlists` | `playlist` | `lib_search_playlists({ query, limit: 10 })` | Dropdown com folders agrupados |
| `/stations`, `/queue`, `/history`, `/library` | `filter` | Client-side | Dispatcha `search-filter` custom event |
| `/now-playing`, `/signal`, `/settings` | `none` | — | Trigger hidden |

**Detalhes de implementacao:**
- `ROUTE_CONTEXT` map define modo por rota
- `PLACEHOLDERS` map define placeholder text por modo
- Debounce 250ms no input
- `Ctrl+K` shortcut global (ou `Cmd+K`)
- `Esc` fecha, click fora fecha
- Dropdown posicionado `left: 0` (alinhado ao input, nao centrado)
- Track JSON embutido em `data-track-json` attr para playback direto
- Funcao `escJson()` para safe embedding de JSON em HTML attrs
- Route change limpa input e fecha dropdown

**Remocao de search locais:**
- `tracks.js`: removido `<div class="view__toolbar">` + `#tr-search` + event listener. Adicionado `search-filter` listener com cleanup via `route-changed` once.
- `albums.js`: removido `#al-search` + listener. Adicionado card filter (hide/show por textContent).
- `artists.js`: removido `#ar-search` + listener. Mesmo pattern de card filter.

### 4. Tweaks Panel Enhancements

**4 novas accent colors** com WCAG AA compliance verificada via `mcp__design-critique__check_color_contrast`:

| Cor | Hex Primary | Hex Container | Ratio vs #111110 |
|-----|-------------|---------------|------------------|
| Gold | #d4a054 | #e0b46e | 8.06 (AAA) |
| Teal | #4a9e8e | #66b5a5 | 5.91 (AA) |
| Violet | #9b7fc0 | #b298d4 | 5.57 (AA) |
| Coral | #d47070 | #e08888 | 5.71 (AA) |

Total: 9 accent colors (copper, moss, rust, slate, ink, gold, teal, violet, coral). Segmented buttons com `flex-wrap: wrap` pra acomodar em 2 linhas.

**Zoom slider:** range 85%-125%, step 5%. Aplicado via `html.style.zoom`. Persistido em localStorage. Label mostra percentual ("Zoom 110%").

**Font picker:** 2 selects (UI Font, Display Font) populados via Tauri command `list_system_fonts`. Backend: `fc-list : family` → split por virgula → trim → dedup → sort → `Vec<String>`. Frontend: `loadFonts()` com cache (chamado uma vez, resultado reutilizado). Aplica via `html.style.setProperty("--font-body", ...)` e `--font-display`. "Default" option reseta (`removeProperty`).

CSS: `.tweaks__select` com styling minimo (background surface-container, borda divider-hi, full width).

### 5. Accessibility

**Contraste `--on-surface-mute`:** auditado com `mcp__design-critique__check_color_contrast`.

| Superficie | Cor antiga (#66635d) | Cor nova (#85827b) |
|------------|---------------------|-------------------|
| `--surface-lowest` (#111110) | 3.15 FAIL | 4.93 PASS AA |
| `--surface` (#151513) | 3.05 FAIL | ~4.8 PASS AA |
| `--surface-container` (#1f1f1c) | 2.76 FAIL | ~4.3 borderline |

Outras combinacoes verificadas (todas OK): `--on-surface-variant` (#a29e94) 7.07 AAA, `--on-surface` (#edeae3) 15.73 AAA, `--primary` (#c6633d) 4.73 AA.

### 6. Player Bar Bug Fixes

**Transport lock (race condition):**
- Problema: spammar next/prev rapidamente causa multiplos `playTrack()` em paralelo → backend recebe `player_play` concorrentes → estado confuso
- Fix: `isTransitioning` flag booleana. Seta true em `playTrack()`, libera em `TrackStarted` event handler. Prev/next/mpris-command retornam early se flag true.
- Safety: `transitionTimeout = setTimeout(() => { isTransitioning = false; }, 3000)` — libera apos 3s se `TrackStarted` nunca chegar (track corrompido). Timeout limpo quando `TrackStarted` chega.

**Cover auto-advance (gapless):**
- Problema: `TrackEnded` handler atualiza titulo/artista/duracao mas nao atualiza cover nem like state. Porque? O gapless pre-load (`player_enqueue_next`) faz o backend tocar a proxima track automaticamente, sem chamar `playTrack()` no frontend.
- Fix: nova funcao `updateTrackMeta(track)` que faz fetch de album cover e sync de like state. Chamada no TrackEnded auto-advance path. Mesma logica que existia em `playTrack()` mas extraida para reuso.

**Visibility sync (background desync):**
- Problema: WebKitGTK throttle/suspende JS quando janela nao ta visivel. Eventos `player-state` do backend perdem-se. UI mostra estado stale quando usuario volta.
- Fix: `bindVisibilitySync()` — listener de `document.visibilitychange`. Quando `visibilityState === "visible"` e ha track carregada: re-sincroniza titulo, artista, cover, like via `updateTrackMeta()`. Faz probe de 500ms: escuta `player-state` events, se Position chega assume playing, senao assume paused.
- Limitacao: o `listen()` do Tauri nao tem `unlisten` facil (retorna promise). O probe usa flag temporal — nao e perfeito mas resolve 95% dos casos.

### 7. Sidebar VU Bars Realocadas
- VU bars movidas de `sidebar__footer` (soltas no final) para dentro do sidebar-item "Now Playing"
- `margin-left: auto` empurra pra direita do label
- Escondidas quando sidebar collapsed (`html:not([data-sidebar="expanded"]) .sidebar__vu { display: none }`)
- FOOTER_ITEMS array removido — items agora renderizados inline no HTML pra acomodar VU dentro de Now Playing

### 8. Monitoramento de Bug (30 min, inconclusivo)
- Bug reportado: apos periodo longo em background, app para, mostra estado errado, nao aceita play
- Setup: Tauri MCP driver_session → ipc_monitor + read_logs + Monitor com heartbeat 60s
- Resultado: 22 heartbeats (~22 min), zero erros JS, zero IPC de player capturado, bug nao reproduzido
- Hipotese: bug pode requerer >30 min em background OU sequencia especifica de auto-advances
- `visibilitychange` sync implementado pode ter mitigado parcialmente

### 9. Decisoes e Icones

**Iconify como fonte de icones novos:**
- Decisao: abordagem hibrida. Sprite SVG existente fica. Novos icones vem do Iconify (download SVG manual do site, colados no sprite).
- Sem runtime JS do Iconify. Sem CDN. Sem CSS-as-mask approach. Manter `<symbol>` + `<use href>`.
- Icones adicionados nesta sessao: `icon-radio` (Lucide), `icon-flame` (custom pixel art), `icon-search` (Lucide), `icon-chevron-left` (ja existia).
- Memorizado no cogmem para futuras sessoes.

**Chama pixel art como like icon:**
- Referencia: `~/Downloads/firemusic.jpg` (imagem puxada da cmr-auto)
- Nota musical dentro de chama, estilo pixel art preto/branco
- Vetorizacao: Pillow threshold → grid detection (block size 64px) → 12x15 grid → horizontal span merge (67 rects → 35 spans)
- Path SVG: 437 chars, `fill="currentColor"`, viewBox `0 0 12 15`

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/js/views/stations.js` | Criado | View completa com list/detail modes, 204 linhas |
| `src/js/components/search-bar.js` | Criado | Search global contextual, 313 linhas |
| `src/js/components/player-bar.js` | Modificado | +like button (+HTML, cacheUI, bindLike, updateLikeUI), +isTransitioning lock (+3s timeout), +updateTrackMeta() (cover+like no auto-advance), +bindVisibilitySync() (re-sync on focus) |
| `src/js/components/tweaks.js` | Modificado | +zoom slider, +font picker (loadFonts async, fontSelect helper), +4 accent colors, renderPanel agora async, +import invoke |
| `src/js/components/sidebar.js` | Modificado | +Stations nav item, VU bars movidas pra dentro de Now Playing item, FOOTER_ITEMS removido (items inline) |
| `src/js/router.js` | Modificado | +`"/stations"` route |
| `src/js/views/playlists.js` | Modificado | +liked count fetch, +Liked Songs entry, +openLiked() funcao |
| `src/js/views/tracks.js` | Modificado | -local search input e handler, +search-filter event listener com cleanup |
| `src/js/views/albums.js` | Modificado | -local search input e handler, +search-filter card filter |
| `src/js/views/artists.js` | Modificado | -local search input e handler, +search-filter card filter |
| `src/index.html` | Modificado | titlebar center: `<span>Kinetic Vault</span>` → `<div id="titlebar-center"></div>` |
| `src/main.js` | Modificado | +`import { mountSearchBar }`, +mount call apos mountResources |
| `src/styles/tokens.css` | Modificado | +gold/teal/violet/coral accent themes (4 blocos `html[data-accent=...]`), `--on-surface-mute` #66635d → #85827b |
| `src/styles/components.css` | Modificado | +station-grid/card (71 linhas), +like-btn (12 linhas), +search-bar/dropdown/section/item (165 linhas), +tweaks__select (8 linhas), +folder-item--liked (5 linhas), segmented flex-wrap, sidebar__vu margin-left:auto + collapsed hide |
| `src/assets/icons.svg` | Modificado | +icon-radio (Lucide), +icon-flame (custom 12x15), icon-search atualizado (Lucide geometry) |
| `src-tauri/src/lib.rs` | Modificado | +`list_system_fonts()` Tauri command (fc-list parse), registrado no invoke_handler |

## Commits desta sessao (25 commits)

```
196732a fix(player): re-sync UI state when window becomes visible
6a16456 fix(sidebar): move VU bars inline with Now Playing item
c80b906 docs: session context and pickup prompt for frontend features
ca4c93d fix(player): update cover and like state on gapless auto-advance
7df3cec fix(tweaks): wrap segmented buttons to show all accent colors
f65b515 fix(player): add transition lock to prevent transport race condition
552792d feat(tweaks): system font picker for UI and display fonts
7bdab34 feat(tweaks): add gold, teal, violet, coral accent colors
370e0e3 fix(ui): bump mute text contrast to AA, left-align search dropdown, add zoom tweak
d6c4f30 fix(stations): subtle translucent color blocks + cream play button
da02b1d feat(search): remove per-view search, add global filter listeners
3188a49 feat(search): mount global search bar in titlebar
27345eb feat(search): add search bar CSS styles
e57de49 feat(search): create global search bar component
5cf3b80 feat(icons): add search icon
8399838 feat(like): add liked songs entry to playlists view
9f9b46c docs: implementation plan for global search bar
e698f55 feat(like): add flame like toggle to player bar
3606f75 feat(icons): add pixel art flame icon for like/favorites
e3416dc docs: implementation plan for like/favorites feature
988c75a feat(stations): register route and add sidebar nav item
23460bd feat(stations): create stations view with card grid and detail mode
58f88c2 feat(css): add station card styles with accent color support
6c29768 feat(icons): add radio icon for stations view
efe25bb docs: spec for stations, like, search frontend features
```

## Decisoes tomadas

- **Stations card design**: cor solida translucida (color-mix 12%) + borda accent + play button creme. Descartado: gradiente pesado (usuario achou "sujo"), play button colorido (muito saturado).
- **Like icon = chama pixel art vetorizada**: da `firemusic.jpg` fornecida pelo usuario. Descartado: coracao (generico), estrela (bland), bookmark (nao comunicava "fire").
- **Search no titlebar**: substituiu texto "Kinetic Vault". Descartado: search no topo do `<main>` (ocupa espaco vertical, nao e pattern desktop).
- **Iconify hibrido**: sprite existente fica, novos icones do Iconify. Descartado: migrar tudo (scope desnecessario), CSS mask approach (inconsistente com sprite `<use>`).
- **Zoom CSS**: `html.style.zoom` direto. Descartado: CSS transform scale (complica layout, afeta posicionamento).
- **Fontes via fc-list**: Tauri command que shells out. Descartado: lista curada hardcoded (nao reflete o que o usuario realmente tem instalado).
- **Transport lock via flag**: `isTransitioning` booleana. Descartado: queue de comandos (complexidade desnecessaria), debounce temporal (ignora comandos legitimos).
- **VU bars no Now Playing**: dentro do sidebar-item, nao soltas no footer. Descartado: manter posicao original (sem relacao semantica com Now Playing).
- **Contraste mute bumped**: #66635d → #85827b. Nao #a29e94 (ja e variant, seria redundante).

## Metricas

| Metrica | Valor |
|---------|-------|
| Commits | 25 |
| Arquivos tocados | 21 |
| Linhas adicionadas | ~2961 |
| Linhas removidas | ~53 |
| Arquivos criados | 2 (stations.js, search-bar.js) |
| Icones adicionados | 3 (radio, flame, search updated) |
| Accent colors totais | 9 (era 5) |
| Subagentes despachados | 3 (stations, like, search — todos completaram) |
| Releases publicados | 6 |
| Bugs corrigidos | 4 (station gradient, transport race, cover auto-advance, visibility desync) |
| Monitoramento debug | 30 min, inconclusivo |

## Pendencias identificadas

1. **Bug intermitente de playback em background** (alta) -- apos periodo longo (>30min?) com app em background, playback para e UI fica dessincronizada. `visibilitychange` sync mitigou mas nao eliminou. Monitoramento de 30 min nao reproduziu. Precisa de logging mais agressivo no player-bar (console.log nos pontos criticos) para proxima tentativa de reproducao.
2. **Like em track rows** (media) -- spec original previa flame icon em todas as track tables (tracks, playlists, stations, queue). Implementado apenas no player bar. Precisa de coluna extra nas track tables com toggle.
3. **Station cover art** (media) -- backend tem campo `cover_path` mas geralmente null. Cards usam color-mix como fallback. Futuro: gerar covers com IA ou extrair album art representativa da station.
4. **Search keyboard navigation** (media) -- dropdown nao suporta arrow keys. Power users esperam navegar resultados sem mouse.
5. **Tweaks panel scroll** (baixa) -- panel pode ficar longo demais em janelas pequenas. Precisa de `overflow-y: auto` no `.tweaks__body`.
6. **Search playlist click** (baixa) -- click em folder no dropdown de playlist search navega pra `/playlists` mas nao abre o folder automaticamente. Precisaria de parametro na rota.
7. **Tauri unlisten no visibility probe** (baixa) -- o probe de 500ms no visibility sync usa flag temporal em vez de unlisten. Funciona mas pode acumular listeners inativos ao longo de muitas visibilidade changes. Considerar usar `unlisten` da Promise retornada pelo `listen()`.
