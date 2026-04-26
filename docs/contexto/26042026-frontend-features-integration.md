# Contexto: Frontend Features Integration (Stations, Like, Search + Polish)

**Data:** 2026-04-26
**Sessao:** main (frontend session)
**Duracao:** ~2h

---

## O que foi feito

### 1. Stations View (Mood Radios)
Nova view `#/stations` com grid responsivo de cards. Cada station tem `accent_color` do backend aplicada via CSS custom property `--station-color`. Cards usam `color-mix` a 12% da accent (translucido, nao gradiente pesado), borda esquerda 3px colorida, play button creme (`--on-surface`). Dois modos: lista (card grid) e detalhe (track table com back button). Shuffle on play button click.

### 2. Like / Favorites
Icone de chama pixel art (vetorizado de `firemusic.jpg`, 12x15 grid) no SVG sprite. Toggle no player-bar ao lado do track meta. Estado sincronizado via `lib_is_liked()` on track change e `lib_toggle_like()` on click. "Liked Songs" entry especial no topo da view `/playlists` com `lib_list_liked()`.

### 3. Global Search Bar
Componente `search-bar.js` montado no titlebar (substituiu "Kinetic Vault" texto). 4 modos contextuais por rota: global (IPC `lib_search`), playlist (IPC `lib_search_playlists`), filter (client-side `search-filter` event), none (hidden). Ctrl+K shortcut, Esc fecha, debounce 250ms. Removidos inputs de search locais de tracks/albums/artists views.

### 4. Tweaks Enhancements
- 4 novas accent colors: Gold (#d4a054), Teal (#4a9e8e), Violet (#9b7fc0), Coral (#d47070). Todas AA compliant.
- Zoom slider (85%-125%, CSS `zoom` no `<html>`, persistido)
- Font picker: 2 selects (UI Font + Display Font) populados via `list_system_fonts` Tauri command (`fc-list`)
- Segmented buttons com `flex-wrap` pra acomodar mais opcoes

### 5. Accessibility / Polish
- `--on-surface-mute` bumpado de #66635d (3.15 ratio, FAIL AA) para #85827b (4.93, PASS AA)
- Search dropdown alinhado a esquerda (era centrado)

### 6. Performance / Bug Fixes
- **Transport lock**: `isTransitioning` flag impede race condition ao spammar next/prev. Lock seta em `playTrack()`, libera em `TrackStarted` event, com safety timeout de 3s.
- **Cover auto-advance**: `updateTrackMeta()` funcao nova que atualiza cover + like state no gapless auto-advance (TrackEnded handler). Antes so atualizava titulo/artista.

### 7. Iconify Decision
Usuario decidiu usar Iconify como fonte de icones novos daqui pra frente (hibrido: sprite existente fica, novos vem do Iconify como SVG baixado). Memorizado no cogmem.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/js/views/stations.js` | Criado | View completa, 204 linhas |
| `src/js/components/search-bar.js` | Criado | Componente global, 313 linhas |
| `src/js/components/player-bar.js` | Modificado | +like button, +transition lock, +updateTrackMeta |
| `src/js/components/tweaks.js` | Modificado | +zoom, +font picker, +4 cores, async renderPanel |
| `src/js/components/sidebar.js` | Modificado | +Stations nav item |
| `src/js/router.js` | Modificado | +/stations route |
| `src/js/views/playlists.js` | Modificado | +Liked Songs entry, +openLiked() |
| `src/js/views/tracks.js` | Modificado | -local search, +search-filter listener |
| `src/js/views/albums.js` | Modificado | -local search, +search-filter listener |
| `src/js/views/artists.js` | Modificado | -local search, +search-filter listener |
| `src/index.html` | Modificado | titlebar center → mount point |
| `src/main.js` | Modificado | +mountSearchBar import/call |
| `src/styles/tokens.css` | Modificado | +4 accent themes, mute color bump |
| `src/styles/components.css` | Modificado | +station, +like, +search, +font select CSS |
| `src/assets/icons.svg` | Modificado | +radio, +flame, +search symbols |
| `src-tauri/src/lib.rs` | Modificado | +list_system_fonts command |

## Commits desta sessao (20 commits)

```
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
e698f55 feat(like): add flame like toggle to player bar
3606f75 feat(icons): add pixel art flame icon for like/favorites
988c75a feat(stations): register route and add sidebar nav item
23460bd feat(stations): create stations view with card grid and detail mode
58f88c2 feat(css): add station card styles with accent color support
6c29768 feat(icons): add radio icon for stations view
efe25bb docs: spec for stations, like, search frontend features
```

## Decisoes tomadas

- **Stations layout**: cards horizontais com accent_color translucida (12% via color-mix), nao gradiente pesado. Validado pelo usuario apos primeira iteracao.
- **Like icon = chama pixel art**: vetorizada de imagem fornecida pelo usuario (firemusic.jpg). Nao coracao generico.
- **Search global no titlebar**: substitui inputs locais por view. Contexto muda por rota automaticamente.
- **Iconify hibrido**: icones existentes no sprite ficam. Novos vem do Iconify (download SVG). Sem runtime JS.
- **Zoom via CSS zoom**: mais simples que scale transform. Range 85-125%.
- **Fontes via fc-list**: Tauri command lista fontes do sistema. Selects no tweaks panel.
- **Transport lock**: flag booleana simples em vez de queue complexa. Safety timeout 3s.

## Pendencias identificadas

1. **Station cards sem covers** (media) -- backend tem `cover_path` mas geralmente null. Futuro: gerar covers com IA ou usar album art da station.
2. **Like em track rows** (media) -- spec previa flame icon em track table rows, nao so player bar. Nao implementado nesta sessao.
3. **Search dropdown pode melhorar** (baixa) -- click em artist/album no dropdown navega mas nao toca. Click em track toca. Poderia ter hover preview.
4. **Tweaks panel scrolling** (baixa) -- com 9 cores + 2 font selects + sliders, o panel pode ficar longo. Pode precisar de scroll interno.
5. **Performance geral** (baixa) -- usuario reportou leve latencia visual. Transport lock resolve o caso principal (spam next/prev). Monitorar se ha outros.
