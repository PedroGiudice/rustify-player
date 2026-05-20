# Contexto: TweaksPanel como hub, glass lyrics, redesign playlist, EQ real

**Data:** 2026-05-17
**Sessao:** main (25 commits ahead da origin)
**Duracao:** sessao longa, multi-fase
**Versao final:** v0.2.22

---

## O que foi feito

### 1. Migracao do painel Tweaks pro Solid

`src/js/components/tweaks.js` (legacy) refazia `panelEl.innerHTML` no handler
`input` do slider de Scale a cada movimento — destruindo o proprio `<input>`
mid-drag, WebKitGTK perdia pointer capture, loop saturava, UI travava.

Nova arquitetura:
- `src/store/tweaks.ts` — schema + persistencia + `applyTweaks` (aplica no
  `<html>` via dataset/style). Tipos: `Density | Sidebar | TypeMode`.
- `src/views/Tweaks.tsx` — Portal overlay reativo com `<NumberSlider>`,
  `<Segmented>`, `<FontSelect>`. Sliders sao source-of-truth (signals); label
  e `<span>` derivado. Sem `innerHTML` destrutivo.
- `App.tsx` monta `<Tweaks/>`; `main.js` deixa de importar o JS antigo;
  legacy deletado.

Migracao de schema preservada: aceita campos antigos `zoom`/`fontScale` e
sidebar `collapsed`/`expanded`. Mesma chave `kv-tweaks` em localStorage.

### 2. Glass lyrics ajustavel

Caixa flutuante de lyrics no NowPlaying era branco opaco em fundo paper claro
(virava cinza-medio). Refatorado:

- CSS: `background: rgba(15, 17, 16, var(--lyrics-bg-alpha))` +
  `backdrop-filter: blur(var(--lyrics-blur)) saturate(160%)
  brightness(var(--lyrics-bg-brightness))`. Sem borda. `--fg-*` sobrescritos
  localmente pra texto legivel em fundo escuro.
- Blur dinamico via `--lyrics-blur` inline calc no JSX:
  `clamp(10, (w+h) * 0.025, 32)px`. Caixa maior = blur maior.
- Slider "Lyrics glass" no Tweaks (0..1) que mapeia em alpha (0.04..0.30) +
  brightness (0.92..0.65) proporcionalmente. Default 0.25.
- Durante drag/resize, classe `.is-interacting` zera o backdrop-filter e
  troca pra background solido sutil — sem isso WebKit travava recalculando
  blur+brightness por cima do spectrum animado a cada mousemove.
- rAF throttle em `startDrag`/`startResize` (NowPlaying.tsx). Mousemove
  120fps -> 60fps sincronizado com vsync.

### 3. Pagina da playlist redesenhada

Era um Album.tsx clone com hero pequeno (120px), tracklist sem cover por
linha, texto vazando das celulas. Refeito:

- Hero 180x180 mosaico 2x2 de capas distintas (mesma logica visual dos cards
  na lista de playlists). Kicker mono `Playlist · Folder`, h1 38px
  tracking-tight, stats com duracao total formatada (h/min).
- Botoes Pin/Play pill-shaped, estado `is-on` (preto invertido) quando pinado.
- Tracklist com nova variante `.tracks--with-cover` (6 colunas: idx | cover
  44px | title | album | genre | length). Cover por linha 32x32 com
  `album_cover_path`, fallback `disc-3`.
- Ellipsis em title/cell pra texto longo nao vazar.

`.tracks` puro (5 cols) continua usado em Album/Tracks/History/etc —
variante e opt-in.

### 4. Pinned playlists reais + click navega

- `src/store/pins.ts` — signal + localStorage `kv-pinned-playlists`.
- Botao circular top-left do card (.pl-card__pin), `opacity: 0` por default,
  `1` no hover ou quando pinado. `e.stopPropagation()` pra nao navegar.
- Click no card navega `/playlist/<encodeURIComponent(name)>` (em vez de
  tocar a folder direto). Pagina abre com tracklist completa.
- Pinned section filtra `folders().filter(f => isPinned(f.name))` —
  substituiu o placeholder "primeiros 3 folders".

### 5. Shuffle adaptive por escopo

`setQueue` tem default scope `"open"`. `toggleShuffle` ja respeitava
`queueScope`:
- `"curated"` -> embaralha a propria queue (mantem contexto)
- `"open"` -> entra em radio mode (descarta queue, repopula com
  `[current, ...autoplayNext()]`)

Bug: nenhuma das views de unidade coerente passava `"curated"`. Shuffle
dentro de playlist virava radio do escopo global.

Corrigido em: `views/Playlist.tsx`, `Album.tsx`, `Albums.tsx`, `Artist.tsx`,
`Home.tsx` (playAlbum). Mantidas como `"open"`: History, Tracks,
CommandPalette, QueueDrawer, Home.playRow.

### 6. EQ curve real (peaking response)

`components/dsp/EqCanvas.tsx` so ligava dots de gain via spline Bezier —
ignorava `Q` e `mute`. Combinado com `DB_RANGE=36` do store, gains de ±2.5dB
viravam ~7% da altura util. Visual "quebrado", quase invisivel.

Refatorado:
- Amostra 256 pontos em log-freq (20Hz..20kHz). Em cada ponto, soma a
  resposta peaking de TODAS as bandas usando aproximacao Lorentziana:
  `peakingDb(f) = gain / (1 + (2 * log2(f/f0) / bwOct)^2)` onde
  `bwOct = 2*asinh(1/2Q)/ln(2)`. Usa freq+gain+Q+mute corretamente.
- `DB_VIS_RANGE = 18` (display only). Store mantem ±36 pro range de controle.
  Curva 2x mais expressiva.
- Dots agora caem na curva resultante — bandas proximas que se somam
  empurram o ponto.
- `.eq-yaxis` renderizado no JSX (CSS ja existia mas nunca foi wirado).
  Marcas `+18 / +9 / 0 / -9 / -18` dB.
- `createEffect` rastreia `b.freq/gain_db/q/mute` de cada banda pra
  disparar redraw em qualquer mudanca reativa.

### 7. Spectrum congela sem audio

`SpectrumCanvas.tsx` tinha 4 fontes time-driven (breath, fakeKick, fakeEnergy,
drift) que pulsavam mesmo `!isPlaying`.

Agora frame() observa `player.isPlaying`:
- `!isPlaying`: desenha 1 frame estatico (kick=0, energy=0, breath=1,
  drift=0; so shape function) e libera raf.
- `createEffect` reativa o loop quando volta a tocar; cancela imediato +
  desenha estatico ao pausar.

### 8. RES button funcional (CSS portado)

Clique no botao RES do titlebar removia o `hidden` mas o overlay
renderizava em `position: static, width: 1280, top: 800, left: 0` —
fora da viewport.

Causa: regras CSS de `.resources` viviam em `styles/components.css`, mas o
bundle so importa `styles/extractor-lab.css` (main.tsx + index.html).
components.css ficou orfao no bundle desde o redesign Editorial HiFi.

Fix:
- Bloco completo `.resources / .res-*` portado pra extractor-lab.css.
- `mountResources()` agora idempotente (panelEl guard + keydown one-shot).
- Import + chamada redundante em `main.js` removida (Titlebar.tsx ja monta).

### 9. Outras correcoes UI

- **Grid de tracks**: `.tracks` tinha 6 cols (`36px 1fr 180px 120px 80px
  70px`) mas todas as views renderizam 5 cells. Com `display:contents` nas
  rows, slot vazio empurrava cada row uma coluna pra direita. Cortado pra
  `36px 1fr 180px 120px 70px`.
- **Sidebar colapsada**: regra `html[data-sidebar="icons"]` escondia
  `.sidebar__label/.brand__word/.nav-item__kbd` mas o `<span>{item.label}</span>`
  dentro do `.nav-item` ficava sem classe — texto sobrava na sidebar de 56px.
  Adicionada regra `.nav-item > span:not(.nav-item__kbd) { display: none }`.
- **Logo Cassette**: `src/assets/logo-cassette.png` substitui
  `lucide:flask-conical` como brand mark da sidebar.
- **Bg ink color picker**: campo `bgInk` (hex) no store/tweaks. Color picker
  no Tweaks. `SpectrumCanvas` le `--bg-ink-rgb` via getComputedStyle no
  mesmo intervalo do sync/BPM (~3x/s).

### 10. TweaksPanel como hub (decisao arquitetural)

User insight: "tweakspannel e Rei". Consolidado como referencia em
`CLAUDE.md` (secao "TweaksPanel e o hub de customizacao"). Antes de propor
YAML ou UI dedicada pra um knob, avaliar Tweaks primeiro. So escalar quando
o caso precisar de preset salvavel, share entre instalacoes, ou hot-reload
externo.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `CLAUDE.md` | Modificado | secao TweaksPanel hub |
| `src-tauri/tauri.conf.json` | Modificado | bumps de versao (0.2.13 -> 0.2.22) |
| `src/App.tsx` | Modificado | usa novo `<Tweaks/>` Solid |
| `src/main.js` | Modificado | sem mountResources/mountTweaks |
| `src/router.tsx` | Modificado | rota `/playlist` |
| `src/store/tweaks.ts` | Criado | store Solid + applyTweaks |
| `src/store/pins.ts` | Criado | pins persistidos em localStorage |
| `src/views/Tweaks.tsx` | Criado | painel Solid via Portal |
| `src/views/Playlist.tsx` | Criado | pagina por playlist (hero + tracklist) |
| `src/views/Playlists.tsx` | Modificado | navigate + pins reais |
| `src/views/NowPlaying.tsx` | Modificado | drag rAF throttle + interacting |
| `src/views/Album.tsx` | Modificado | scope curated |
| `src/views/Albums.tsx` | Modificado | scope curated |
| `src/views/Artist.tsx` | Modificado | scope curated |
| `src/views/Home.tsx` | Modificado | scope curated em playAlbum |
| `src/components/Sidebar.tsx` | Modificado | logo Cassette |
| `src/components/SpectrumCanvas.tsx` | Modificado | isPlaying check + --bg-ink |
| `src/components/dsp/EqCanvas.tsx` | Modificado | curva peaking real + eixo Y |
| `src/js/components/resources.js` | Modificado | idempotente |
| `src/js/components/tweaks.js` | Deletado | substituido pelo Solid |
| `src/styles/extractor-lab.css` | Modificado | +320 linhas: .resources, .pl-hero-*, .tracks--with-cover, .tweaks__color, glass lyrics, sidebar icons-mode fix |
| `src/assets/logo-cassette.png` | Criado | copia de docs/Cassette _ Paper Outline.png |
| `docs/bugs/17052026-tweaks-font-slider-freeze.md` | Criado | bug doc do freeze inicial |

Untracked (intencional, nao commitados):

- `docs/Cassette _ Paper Outline.png` — fonte do logo, ja copiado pra assets
- `docs/rustify-player-new-telas/` e zip — handoff de telas
- `.zed/` — config local do editor

## Commits desta sessao

```
5093946 docs(claude): TweaksPanel como hub canonico de customizacao
2fd44e2 chore(release): v0.2.22
07ac92e feat(tweaks): cor das linhas do bg ajustavel via color picker
46eb28e chore(release): v0.2.21
986566a feat(playlist): redesign do detalhe (hero mosaico, tracklist com cover)
045dc65 chore(release): v0.2.20
f01754c fix(lyrics-box): drag/resize sem travar — rAF throttle + glass off
cb1c2ff chore(release): v0.2.19
2b5fc3a feat(sidebar): troca lucide:flask-conical pelo logo real do app
74e9056 feat(tweaks): slider 'Lyrics glass' controla translucidez do box
30d70f6 chore(release): v0.2.18
25f4587 fix(signal): curva real de resposta do EQ + eixo Y + uso de Q
f00d93d chore(release): v0.2.17
39590d4 fix(shuffle): respeita escopo curado em playlist/album/artist
74626af chore(release): v0.2.16
f5f3419 fix(ui): grid de tracks (5 cols) + labels da sidebar colapsada
0349ebc chore(release): v0.2.15
ad3e2c1 fix(now-playing): glass lyrics translucida real (era painel opaco)
13c61aa chore(release): v0.2.14
bfecca0 fix(resources): porta CSS .resources pro bundle real + idempotente
539b260 feat(playlists): pagina por playlist + pins persistidos reais
3d919dc fix(spectrum): congela canvas quando nao ha audio tocando
c23e87e feat(now-playing): glass dark sem borda + blur dinamico nas lyrics
216be9e fix(tweaks): migra painel pro Solid, elimina freeze do slider
297388f fix(playlists): click no card toca a folder inteira como queue
```

Branch `main` esta **25 commits ahead da origin/main**. Tag `dev` foi
empurrada pelo release.sh; commits ainda nao foram pushed.

## Decisoes tomadas

- **TweaksPanel como hub canonico** — antes de propor YAML/UI nova pra um
  knob, avaliar Tweaks primeiro. Descartado: criar PaperBgConfig YAML
  dedicado quando user pediu "ajustar cor do bg" — apenas 1 input.
- **Migrar tweaks JS legacy pro Solid** — eliminou freeze do slider de raiz.
  Descartado: patch incremental no renderPanel destrutivo (mantinha o
  antipattern).
- **Glass real via backdrop-filter brightness** — em vez de subir o alpha
  do background. User flagged "muito opaco" varias vezes; alpha 0.42
  cobria; brightness(0.78) escurece o que esta atras sem virar painel.
  Slider 0..1 ja mapeia ambos.
- **Suspender backdrop-filter durante drag/resize** — recalcular blur +
  saturate + brightness por cima do spectrum animado matava o WebKit.
  Classe `.is-interacting` zera o filter ate o mouseup.
- **EQ Lorentziana em vez de spline de dots** — refletir resposta REAL do
  filtro (usa Q). Descartado: continuar conectando dots — visualmente
  enganoso e ignorava metade do estado das bandas.
- **Scope curated vs open** — playlist/album sao unidades coerentes,
  shuffle deve embaralhar a propria lista. Listagens genericas
  (history/library/search) viram radio.

## Pendencias identificadas

1. **Push pra origin/main** (alta) — 25 commits locais. `git push origin main`
   quando estiver OK com o estado atual.
2. **Untracked nao decididos** (baixa) — `docs/Cassette _ Paper Outline.png`
   (a fonte do logo) e `docs/rustify-player-new-telas/` (handoff de telas
   futuras). Decidir se commita ou ignora.
3. **Outras views podem usar .tracks--with-cover** (baixa) — Tracks.tsx
   (library) e History.tsx so usam grid 5 cols. Adicionar cover por linha
   poderia ser consistente com Playlist. Verificar UX antes — Album.tsx
   propositalmente nao usa (covers iguais em todas as linhas seria visual
   ruido).
4. **EQ tem 16 bandas mas eixo X mostra so 10 decade labels** (baixa) — nao
   eh bug, mas vale considerar se as 16 freqs reais deveriam aparecer
   abaixo dos faders pra alinhamento visual com a curva.
5. **Tema dark herdado nao usado** (informativa) — `src/styles/tokens.css`
   define DARK theme mas so `extractor-lab.css` esta importado (LIGHT). O
   resto do app esta light/paper. Confirmar que isso eh intencional ou se
   ha plano de unificar.

## Metricas

| Metrica | Valor |
|---------|-------|
| Releases publicados nesta sessao | 9 (v0.2.13 inclusive nao, comecou em v0.2.14) |
| Commits | 25 |
| Arquivos modificados | 17 |
| Arquivos criados | 6 |
| Arquivos deletados | 1 |
| Linhas CSS adicionadas | ~320 |
