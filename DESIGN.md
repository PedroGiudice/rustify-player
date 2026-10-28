---
name: Rustify Player
description: Player pessoal de acervo lossless. A música é o quadro; a interface é a moldura escura, densa e precisa em volta.
colors:
  # Desktop (`:root` de src/styles/extractor-lab.css). São os valores de REPOUSO:
  # todo tema YAML e a capa do álbum (adaptiveInk/adaptiveAccent) os reescrevem
  # em tempo de execução. Nunca tratar esta lista como paleta fixa.
  canvas: "#fafafa"
  paper: "#ffffff"
  soft: "#f7f6f3"
  sunken: "#fcfcfc"
  tint: "#f5f5f5"
  faint: "#f4f4f4"
  carbon-1: "#171717"
  carbon-2: "#262626"
  carbon-3: "#404040"
  carbon-4: "#525252"
  carbon-5: "#737373"
  carbon-6: "#767676"
  carbon-7: "#b0b0b0"
  carbon-8: "#d4d4d4"
  line-1: "#ececec"
  line-2: "#e5e5e5"
  line-3: "#ebebeb"
  accent-fg: "#2563eb"
  accent-ring: "#3b82f6"
  accent-bg: "#eff6ff"
  ok-fg: "#047857"
  ok-ring: "#10b981"
  ok-bg: "#ecfdf5"
  warn-fg: "#b45309"
  warn-ring: "#f59e0b"
  warn-bg: "#fffbeb"
  err-fg: "#be123c"
  err-ring: "#ef4444"
  err-bg: "#fef2f2"
  gl-canvas: "#000000"
  on-scrim: "#ffffff"
  on-scrim-2: "rgba(255, 255, 255, 0.88)"
  # S24 (src/mobile/styles/tokens.css): tema escuro fixo do handoff mobile.
  s24-surface-lowest: "#050505"
  s24-surface-base: "#0c0c0c"
  s24-surface-low: "#111111"
  s24-surface-container: "#161616"
  s24-surface-high: "#1c1c1c"
  s24-surface-highest: "#242424"
  s24-text-1: "#f0f0f0"
  s24-text-2: "#b8b8b8"
  s24-text-3: "#808080"
  s24-text-4: "#6e6e6e"
  s24-divider: "rgba(255, 255, 255, 0.08)"
  s24-divider-prominent: "rgba(255, 255, 255, 0.16)"
  s24-accent: "#997081"
  s24-accent-container: "#4d3740"
  s24-on-accent: "#0a0a0a"
  s24-ok: "#809078"
  s24-warn: "#908870"
  s24-err: "#8b7575"
typography:
  display:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(48px, 5.4vw, 76px)"
    fontWeight: 600
    lineHeight: 0.98
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  secondary:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "0.06em"
  data:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "normal"
    fontFeature: "tnum"
  s24-display:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  s24-title:
    fontFamily: "Fraunces, Georgia, serif"
    fontSize: "23px"
    fontWeight: 600
    lineHeight: 1.14
    letterSpacing: "-0.02em"
  s24-body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  s24-label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.08em"
  s24-data:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "10.5px"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "0.02em"
    fontFeature: "tnum"
rounded:
  xs: "4px"
  sm: "5px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  2xl: "14px"
  pill: "999px"
spacing:
  # Não há tokens de espaçamento no CSS; esta é a escala que o código REPETE
  # (padding de linha, gap de grade, respiro de tela). Usar estes degraus.
  "1": "4px"
  "2": "6px"
  "3": "8px"
  "4": "10px"
  "5": "12px"
  "6": "14px"
  "7": "16px"
  "8": "18px"
  "9": "24px"
  "10": "28px"
  "11": "40px"
components:
  button-primary:
    backgroundColor: "{colors.carbon-1}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    size: "36px"
  button-primary-hover:
    backgroundColor: "{colors.carbon-2}"
    textColor: "{colors.paper}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.carbon-2}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.carbon-5}"
    rounded: "{rounded.md}"
    size: "28px"
  button-quiet-hover:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.carbon-1}"
  chip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.carbon-4}"
    rounded: "{rounded.pill}"
    padding: "5px 11px"
    typography: "{typography.secondary}"
  chip-active:
    backgroundColor: "{colors.carbon-1}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    padding: "5px 11px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.carbon-3}"
    rounded: "{rounded.md}"
    padding: "7px 12px"
    typography: "{typography.title}"
  nav-item-active:
    backgroundColor: "{colors.faint}"
    textColor: "{colors.carbon-1}"
    rounded: "{rounded.md}"
    padding: "7px 12px"
  track-row:
    backgroundColor: "transparent"
    textColor: "{colors.carbon-1}"
    padding: "10px 12px"
    height: "61px"
  track-row-hover:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.carbon-1}"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.carbon-1}"
    rounded: "{rounded.xl}"
    padding: "16px 18px 14px"
  input-search:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.carbon-1}"
    rounded: "{rounded.lg}"
    padding: "0 12px 0 37px"
    height: "40px"
  segmented:
    backgroundColor: "{colors.tint}"
    textColor: "{colors.carbon-5}"
    rounded: "{rounded.md}"
    padding: "2px"
  segmented-active:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.carbon-1}"
    rounded: "{rounded.sm}"
    padding: "4px 10px"
  tweaks-panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.carbon-1}"
    rounded: "{rounded.xl}"
    width: "280px"
---

# Design System: Rustify Player

## Overview

**Creative North Star: "A Sala de Escuta: moldura quieta, mesa de estúdio"**

O Rustify é a sala de escuta de um dono só. A música é a única coisa iluminada:
capa, som e letra dão a cor e o movimento, e a interface é a moldura escura e
quieta em volta, que recua para deixar o quadro aparecer. Dentro dessa moldura
há uma mesa de estúdio: leituras em mono (kHz, bit, LUFS, FLAC), listas densas
para varrer o acervo, números tabulares e controles que medem em vez de enfeitar.
Os três nomes descrevem o mesmo sistema visto de três distâncias: o quadro, a
sala, a mesa.

O sistema é quieto, denso e preciso. Quieto porque nada na moldura compete com
a capa; a única ousadia permitida por tela é a que o Now Playing já tem (o fundo
animado e a capa). Denso porque o dono passa o dia dentro do app e quer ver
muito por tela: linhas de 61 px, duas linhas de texto por faixa, meta técnica
sempre à vista. Preciso porque todo número que muda usa algarismos tabulares,
toda borda tem 1 px, toda elevação é um degrau de luminância, e cada cor tem um
papel nomeado.

A cor não pertence à interface: pertence ao tema YAML e à capa. O `:root` do
CSS guarda só o repouso; o tema reescreve as escalas, e a faixa tocando
reescreve o ink do fundo e o acento (adaptiveInk/adaptiveAccent). Por isso este
documento descreve papéis e estrutura, com os valores do `:root` como ponto de
partida, nunca como paleta.

Rejeições confirmadas pelo CEO: Nébula com buffer reduzido (borrada), textura
fina repetida no fundo (moiré, retícula), fitas genéricas, rótulo técnico que o
dono não interpreta ("Apple GPU"), animação de custom property no `:root`.

**Key Characteristics:**
- Duas superfícies, uma linguagem: desktop (Instrument Sans, grade com barra
  lateral e barra do player) e S24 (Inter + Fraunces, tabbar e mini player).
- Elevação por luminância, sem sombra estrutural; bordas de 1 px fazem o
  recorte.
- Um acento por tela, derivado da capa quando ela tem cor; a moldura fica
  acromática.
- Número que muda é tabular e em mono; rótulo é o último recurso.
- Fundo animado reativo ao áudio como assinatura, sobre canvas preto puro.
- Controles precisos em repouso, táteis ao toque, invisíveis quando
  secundários.

## Colors

Uma escala acromática de superfícies e tinta, um único acento que vem da capa,
três cores de sinal apagadas e oito tons pastéis para cartões sem capa; tudo
regido por tema.

### Primary
- **Acento da capa** (`--primary`, repouso `--blue-fg` #2563eb / `--blue-ring`
  #3b82f6 / `--blue-bg` #eff6ff): o único acento da interface. No desktop, o
  trio `blue-*` É o acento: o tema YAML espelha `accent.primary` em
  `--primary`, `--blue-fg` e `--blue-ring`, e `--blue-bg` recebe o container.
  Com `adaptiveAccent` ligado (padrão), `--primary` e família
  (`--primary-container`, `--primary-fixed-dim`, `--on-primary`,
  `--on-primary-container`, `--blue-fg/bg/ring`) seguem o matiz da capa da
  faixa tocando. Aparece em: faixa atual na lista (borda de 2 px à esquerda e
  título), botão ligado na barra do player (shuffle, repeat, letra), chip de
  proveniência RÁDIO/STATION, selo NOW PLAYING, anel de foco, linha
  selecionada (`--primary` a 14 % e 55 %), `::selection` (30 %).
- **No S24**, `--accent` #997081 com `--accent-c` #4d3740 e `--on-accent`
  #0a0a0a: aba ativa da tabbar, eyebrow do Now Playing, selo de origem álbum.

### Neutral
- **Canvas** (`--bg-canvas`, repouso #fafafa; Really Dark #050505): o piso da
  tela, visível atrás do fundo animado nas vistas ambientes. É a referência do
  piso de contraste do ink.
- **Paper** (`--bg-paper`, repouso #ffffff; Really Dark #0c0c0c): barra de
  título, barra lateral, barra do player, cabeçalho de vista, cards, chips e
  campos. É a superfície "de trabalho".
- **Soft / Tint / Faint** (`--bg-soft` #f7f6f3, `--bg-tint` #f5f5f5,
  `--bg-faint` #f4f4f4; Really Dark #161616 / #1c1c1c / #242424): os três
  degraus de elevação acima do paper. Soft = hover de linha, tile em destaque,
  card do Crate; Tint = trilho do segmented, fundo de botão secundário, pista
  do fader; Faint = item de navegação ativo, fader ativo.
- **Sunken** (`--bg-sunken` #fcfcfc): degrau abaixo do paper, raro (container
  baixo do tema).
- **Carbono 1–8** (`--fg-1` #171717 … `--fg-8` #d4d4d4; Really Dark #f0f0f0 →
  #404040): a escala de tinta. 1 = título e botão primário (fundo), 2 = texto
  forte secundário, 3 = texto de navegação e corpo, 4 = chips e dados, 5 =
  texto secundário e rótulos (artista, subtítulo, hora), 6 = texto apagado com
  AA garantido sobre paper (4,54:1), 7 = decorativo apenas (placeholder, dim),
  8 = borda de hover. O tema deriva a escala de três entradas
  (`text.primary/secondary/muted`) e pode refinar cada degrau.
- **Linhas 1–3** (`--line-1` #ececec, `--line-2` #e5e5e5, `--line-3` #ebebeb;
  Really Dark `rgba(255,255,255,0.08)`): toda borda de 1 px. Line-2 é a borda
  padrão de card, chip, campo e separador de barras; line-3 separa linhas de
  faixa; line-1 é a mais alta (divider proeminente do tema).
- **Vidro** (`--glass-tint` 255,255,255 / `--glass-alpha` 0.85 /
  `--glass-blur` 8px; Really Dark tint 12,12,12): painéis translúcidos sobre o
  fundo animado (tabela de faixas, card de letra). O tema define o tom; a
  tabela usa `alpha − 0.07` sem backdrop-filter.
- **Tons pastéis** (`--tone-{mint,sky,peach,rose,lavender,butter,bone,paper}-bg/border`):
  fundo e borda de capas sem imagem. No repouso são pastéis claros; o tema
  escuro os re-ancora no canvas (#171c1a …).
- **Sobre scrim** (`--on-scrim` #ffffff, `--on-scrim-2` 88 %): texto sobre capa
  escurecida (hero-tile de retomada e de descoberta). Única cor branca literal
  do sistema, e só sobre scrim preto.
- **Canvas do fundo WebGL** (`GL_CANVAS` #000000): preto puro fixo, não vem do
  tema (decisão do CEO, 20/09/2026).
- **Ink do fundo** (`--bg-ink` / `--bg-ink-rgb`, repouso #171717): a cor das
  linhas e da tinta do fundo animado. Precedência: knob do Tweaks (dirty) >
  capa (adaptiveInk) > tema (`background.ink`) > repouso. Piso de 3:1 contra o
  canvas aplicado nas duas pontas (backend `ensure_bg_ink_contrast`, frontend
  `resolveInk`).

### Tertiary
- **Sinais ok / aviso / erro** (`--green-*` #047857 / #10b981 / #ecfdf5,
  `--amber-*` #b45309 / #f59e0b / #fffbeb, `--rose-*` #be123c / #ef4444 /
  #fef2f2; Really Dark #809078 / #908870 / #8b7575 apagados, com `-bg` a 12 %):
  só estado, nunca decoração. Verde = ponto "rede ok" no Crate, bench ok;
  âmbar = qualidade lossy na pílula de formato, bench baixo; rosa = like
  ligado (coração) e erro. Cada um é um trio ring/bg/fg.

### Named Rules
**A Regra da Moldura Quieta.** A interface é acromática. Cor de verdade só
entra por três portas: a capa (acento e ink), o tema (quem define as escalas)
e o sinal (ok/aviso/erro, apenas em estado). Nenhum componente fixa cor
própria: valor solto onde existe token é defeito.

**A Regra do Acento Único.** Um acento por tela. Capa sem cor de verdade cai
no acento do tema, nunca num acento forçado. Direção dada pelo CEO em
26/10/2026: sem música tocando, o repouso ideal é neutro (preto e branco); a
cor chega com a faixa. O Really Dark ainda declara #997081 como acento de
repouso; alinhar é edição de tema (ver Don'ts).

**A Regra do Piso.** 4,5:1 para texto, 3:1 para texto grande, controles e para
o ink do fundo, medidos no pior ponto do fundo real (capa e fundo animado).
O checker do tema (`load_theme`) e o `validate.py` reprovam o que falha.

## Typography

**Display Font (desktop):** Instrument Sans (fallback ui-sans-serif, system-ui)
**Body Font (desktop):** Instrument Sans
**Data Font (desktop):** `ui-monospace, SF Mono, Menlo, Consolas` (`--font-mono`; o tema pode trocar)
**Display Font (S24):** Fraunces 600 (fallback Georgia)
**Body Font (S24):** Inter 400–700 (fallback system-ui)
**Data Font (S24):** JetBrains Mono 400–500

**Character:** No desktop, uma família só, com um eixo só: Instrument Sans em
400–700 (o subset embarcado em `src/assets/fonts/` não traz o eixo de largura).
Títulos fechados (tracking negativo) e texto pequeno aberto (tracking positivo,
caixa-alta nos rótulos). No S24, o handoff mobile pediu contraste de família:
Fraunces serifada só nos títulos, Inter em tudo que se lê e toca. O mono é a
voz da mesa de estúdio: tempo, duração, kHz, contagem.

O Tweaks permite trocar a família da UI e do mono (knobs `fontUI`/`fontMono`);
isso é ajuste pessoal do dono por instalação (em 26/10/2026 o app roda com
Baumans e Righteous), não parte do sistema. Tela nova nasce com Instrument Sans.

### Hierarchy (desktop)
- **Display** (600, `clamp(48px, 5.4vw, 76px)`, 0.98, −0.025em): só o título
  da faixa no Now Playing, com `text-wrap: balance`. Única palavra grande do
  app.
- **Feature** (600, 28px, 1.1, −0.02em): título do destaque na Stations
  ("Your Mix").
- **Headline** (600, 22px, 1.2, −0.015em): h1 de cada vista ("Home",
  "Stations", "Crate").
- **Title** (600, 13.5–18px, 1.25–1.3, −0.005 a −0.015em): título da faixa na
  linha (13.5), nome da station (14), título do hero-tile (18), item de
  navegação (13.5/500, 600 quando ativo).
- **Body** (400–500, 13–14px, 1.4): texto corrente, campo de busca (13.5/500),
  aba (13/500), dica do cabeçalho (13).
- **Secondary** (400, 11.5–12px, 1.3–1.4, carbono 5): artista, álbum,
  subtítulo de card, texto de chip (12/500).
- **Label** (700, 10–11px, 1.25, +0.06 a +0.08em, caixa-alta, carbono 5):
  título de seção ("RECENTLY PLAYED"), eyebrow do hero-tile (10.5), rótulo de
  knob no Tweaks (11/600), rótulo da barra lateral (10).
- **Data** (mono, 400–650, 10–11.5px, tabular): tempo da barra do player (11),
  duração da linha (11.5), estatísticas do cabeçalho (11.5), hora relativa
  (11), selo de formato "FLAC 24/96" (10), chip de proveniência RÁDIO
  (10/650, +0.07em, caixa-alta), Hz do fader (9.5).

### Hierarchy (S24)
- **Display** (Fraunces 600, 28px, 1.1, −0.02em): h1 de cada aba.
- **Title** (Fraunces 600, 23px, 1.14, −0.02em): título da faixa no Now
  Playing; card de atalho em Inter 600 16px.
- **Body** (Inter 500, 13.5px): título da faixa na lista; artista 11.5 em
  `--t3`; mini player 12.5/500.
- **Label** (Inter 700, 10px, +0.08em, caixa-alta, `--t3`): eyebrow; aba da
  tabbar 9.5px +0.02em.
- **Data** (JetBrains Mono, 10.5–11px, tabular, +0.02em): subtítulo do
  cabeçalho, duração, tempos do seek; selo de origem 8.5px +0.06em caixa-alta.

### Named Rules
**A Regra dos Três Tamanhos.** Por tela, no máximo 3 tamanhos e 2 pesos.
Ênfase primeiro por cor (carbono 1 contra 5) e peso (600 contra 400); tamanho
por último. Muitas vezes basta apagar o entorno.

**A Regra do Número Tabular.** Todo número que muda (tempo, duração,
contagem, nº de faixa, kHz, LUFS) vai em `--font-mono` com `tabular-nums`.
Números não dançam.

**A Regra do Rótulo por Último.** "12 faixas", não "Faixas: 12". Eyebrow em
caixa-alta é o único rótulo aceito, e só acima de um bloco.

**A Regra do Piso de 11.** Texto que se lê fica em 11 px ou mais (12,1 px com
o zoom 1,1 do dono), via `--fs-label` (11 px) nos rótulos pequenos. Abaixo disso só mono decorativo já existente (Hz do
fader, selo de origem do S24), que é dívida, não licença.

## Layout

**Desktop** é uma grade fixa de três faixas: barra de título de 32 px
(`--titlebar-h`) atravessando a largura, barra lateral de 220 px
(`--sidebar-w`; 56 px no modo só-ícones do Tweaks) à esquerda, barra do player
de 72 px (`--playerbar-h`) embaixo, e a vista no miolo. O modo cinema zera as
três e deixa só o Now Playing. Dentro da vista: cabeçalho com `28px 40px 18px`
de respiro e borda inferior de 1 px, corpo com `28px 40px 56px` e blocos
separados por 36 px. A Home empilha hero-grid (`1.8fr 1fr 1fr`, gap 10 px),
seção de linhas e grade de cards (`minmax(176px, 1fr)`, gap `22px 16px`). O
Now Playing é a exceção: capa de 200 px e título lado a lado em
`auto minmax(0,1fr)` com gap 28 px, card de letra flutuante arrastável, e dois
pontos de quebra (1200 px empilha; 760 px reduz a capa para 160 px). A
resolução real do dono é 1920x1080 com zoom 1,15 na UI, o que dá um canvas de
1857x1048: medir sempre aí.

**Densidade**: a linha de faixa tem 61 px e cinco colunas
(`40px 1fr 220px 120px 60px`, gap 14 px, padding `10px 12px`); a tabela de
faixas (`.tracks`) é translúcida sobre o fundo animado. Listas usam
`content-visibility: auto` para rolar milhares de linhas. Biblioteca grande é
lista; grade de capa só onde a capa decide (Álbuns, Playlists).

**S24** é uma coluna com viewport cheia e recortes de segurança (`--safe-t`,
`--safe-b`): cabeçalho `8px 20px 14px`, seções com 20 px laterais e 22 px entre
blocos, grade de álbuns em duas colunas (gap 12), carrossel de atalhos com
`scroll-snap` (cards de 210x112), tabbar de 56 px (`--tabbar-h`) e mini player
de 56 px (`--mini-h`). No Now Playing, capa de 214 px centrada, controles com
alvos de 44 px e botão de play de 60 px, gap `clamp(8px, 5vw, 26px)`; a largura
útil do S24 é 316 px.

**Ritmo**: não há tokens de espaçamento; o código repete 4/6/8/10/12/14/16/18/
24/28/40. Padding interno de card 14–18 px, gap entre texto e meta 2–6 px, gap
entre ícone e texto 10–12 px.

## Elevation & Depth

Sem sombra estrutural. A profundidade é tonal: canvas → paper → soft → tint →
faint são degraus de luminância (no Really Dark, #050505 → #0c0c0c → #161616 →
#1c1c1c → #242424), e cada superfície se recorta da vizinha por uma borda de
1 px em `--line-2`. As sombras existem só como tokens de tema e aparecem em
resposta a estado ou a flutuação: hover de capa em card e playlist
(`--shadow-hover`), painel Tweaks e menus flutuantes (`--shadow-hover`), card
de letra (`--shadow-card`), capa do Now Playing (`--shadow-compact`), thumb do
fader (`--shadow-knob`). No repouso claro são quase invisíveis (alpha 0,04 a
0,06); o tema escuro as reforça (0,5 a 0,6) porque sobre preto profundo a
luminância sozinha não separa o que flutua.

Há uma segunda camada de profundidade, só no desktop: o fundo animado global
(`.app-bg`) fica atrás de tudo com `isolation: isolate`. No Now Playing ele está
em modo `focused` (opacidade 1, sem filtro); nas demais vistas, `ambient`
(opacidade 0,8, `blur(8px) saturate(0.9)`), com transição de 420 ms. Superfícies
translúcidas (vidro) deixam esse fundo vazar: a tabela de faixas sem
backdrop-filter, o card de letra com `blur(var(--glass-blur))`.

### Shadow Vocabulary
- **Hairline** (`0 1px 0 rgba(0,0,0,0.02)`): hover de hero-tile e station card.
- **Card** (`0 1px 4px rgba(0,0,0,0.04)`; Really Dark `0 1px 4px rgba(0,0,0,0.5)`): card de letra em repouso.
- **Compact** (`0 6px 18px rgba(0,0,0,0.05)`): capa do Now Playing.
- **Hover** (`0 8px 24px rgba(0,0,0,0.06)`; Really Dark `0 8px 24px rgba(0,0,0,0.6)`): capa levantada 2 px no hover; painéis flutuantes (Tweaks, menus).
- **Knob** (`0 1px 2px rgba(0,0,0,0.18)`): thumb do fader e do slider.
- **Halo** (`color-mix(in srgb, var(--blue-ring) calc(var(--halo-alpha) * N%), transparent)`, `--halo-alpha` 0,10): anel difuso em volta do ponto do eyebrow e do selo NOW PLAYING; o tema regula a intensidade em `effects.halo`.

### Named Rules
**A Regra da Luminância.** Elevação é um degrau de tom e uma borda de 1 px.
Sombra só em resposta a estado (hover) ou em painel que flutua sobre a vista.

**A Regra do Vidro Barato.** Vidro é tom + alpha (`rgba(var(--glass-tint),
var(--glass-alpha))`). `backdrop-filter` só em painel pequeno e flutuante
(card de letra); nunca em tela cheia sobre o canvas animado, que custa repaint
por quadro no WebKitGTK.

## Shapes

Cantos suavemente arredondados numa escala curta: 4 px (`--radius-xs`, selo de
formato, kbd), 5 px (`--radius-sm`, botão do segmented, fader), 8 px
(`--radius-md`, item de navegação, botão de ícone, capa pequena de 40–44 px),
10 px (`--radius-lg`, campo de busca, mini chip da barra lateral), 12 px
(`--radius-xl`, card, hero-tile, station card, painel Tweaks, tabela de faixas,
card de letra), 14 px (`--radius-2xl`, capa do Now Playing e de playlist) e
pílula (`--radius-pill`, chips, selo NOW PLAYING, trilho de progresso). O raio
cresce com o tamanho do objeto: quanto maior a capa, mais redondo o canto. O
botão de play é o único círculo pleno (36 px no desktop, 60 px no S24), junto
com o CTA de 26–32 px que aparece no hover de card e hero-tile. Bordas são
sempre 1 px sólidas em `--line-2`; a tracejada marca área de soltar (Crate).
Capas são quadradas (`aspect-ratio: 1`) com `object-fit: cover`. O S24 usa a
mesma escala com `--r-sm` em 6 px.

## Components

Doutrina (CEO, 26/10/2026): **precisos em repouso, táteis ao toque, invisíveis
quando secundários.** Em repouso, borda fina, sem relevo, estado por cor e
peso. Na interação, o hover sobe um degrau de tom e o botão primário cresce
4 %. O que é secundário (play do card, thumb do seek, CTA do hero-tile) só
aparece no hover ou no foco de teclado.

### Buttons
- **Shape:** círculo pleno no primário (36 px); demais com 8 px (`--radius-md`).
- **Primary (play/pause, CTA):** fundo carbono 1, ícone em paper (inverso da
  tinta), traço do ícone em 2,5 px para pesar como ícone cheio; hover carbono 2
  e `scale(1.04)`. No Crate, `.crate-btn--primary` segue a mesma inversão
  (texto em `--bg-canvas`).
- **Secondary:** fundo paper, borda `--line-2`, texto carbono 2, padding
  `6px 12px`; hover borda carbono 8.
- **Quiet / icon:** 28 px, transparente, ícone carbono 5; hover texto carbono
  1 sobre soft. Ligado (`aria-pressed`) = `--blue-fg` (acento); like ligado =
  `--rose-fg`. Ligado tem de ser distinto de hover.
- **Disabled:** opacidade 0,45, sem hover.
- **Focus:** `--focus-outline` (2 px sólido `--blue-ring`, offset 2 px) para
  teclado; `--ring-focus` (box-shadow 0 0 0 2px) em campos.
- **Transições:** `background`/`color`/`border-color` em `--dur-base` (150 ms)
  com `--ease-out` (`cubic-bezier(0.16, 1, 0.3, 1)`, desacelera de verdade);
  toda transição do CSS declara a curva (sem curva o navegador usa `ease`).
  Toque afunda chip (0,96), item de navegação (0,98) e hero-tile (0,995) via
  `:active` em `--dur-press` (80 ms); nunca animar play/pause, anterior,
  próxima nem seek. Curtir pulsa uma vez (1 → 1,22 → 1 em 240 ms), só ao
  curtir.
- **Movimento (vocabulário único, 27/10/2026):** só `opacity` e `transform`.
  Vista entra em `--dur-screen` (360 ms, sobe 6 px) em toda rota. Painel
  (Tweaks, fila, paleta, diálogo Mover, card de letra) entra em `--dur-enter`
  (240 ms, `--ease-out`) e sai em `--dur-med` (180 ms, `--ease-in`): sai mais
  rápido do que entra; paleta e Tweaks ficam montados e invisíveis
  (`visibility`) para a saída animar. Troca de faixa anima o CONTEÚDO, nunca o
  controle: capa com crossfade (a anterior por baixo até a nova carregar),
  título/artista e pílula técnica aparecendo em 240 ms (`data-swap`), só se a
  troca anterior foi há 1,5 s ou mais (`lib/motion.ts`); em rajada de pulos,
  corte seco. Faixa atual e seleção acendem a borda de 2 px que toda linha já
  tem (transparente), sem empurrar o conteúdo. Aba ativa abre o sublinhado do
  centro. Estado vazio, erro e aviso aparecem por opacidade (180 ms); capa
  das grades aparece por opacidade quando carrega. Escalonamento só em
  conjunto pequeno e fixo na entrada da vista (hero-tiles, cards de station,
  `--stagger-step` 30 ms, teto de 7 passos); lista de faixas nunca escalona.
  Tema troca as durações em `motion.fast/base/med/screen/enter/press/stagger`.

### Chips
- **Style:** pílula, fundo paper, borda `--line-2`, texto carbono 4 em 12/500,
  padding `5px 11px`; hover texto carbono 1 e borda carbono 8.
- **State:** selecionado inverte (fundo carbono 1, texto paper). No Crate, chip
  com ícone de 11 px e altura 24 px; `aria-expanded` = fundo faint.
- **Selo técnico** (`.badge-fmt`, `.pb-src`): mono 10 px, caixa-alta no de
  proveniência, borda 1 px, raio 4 px; station/rádio pegam o acento.

### Cards / Containers
- **Corner Style:** 12 px (`--radius-xl`); capa interna 14 px.
- **Background:** paper com borda `--line-2`; o tile em destaque usa soft; o
  hero-tile com capa (retomada e descoberta do dia) põe a imagem com
  `blur(2px) brightness(0.75)` e um scrim preto (0,72 → 0,58) que segura
  4,5:1 até sobre capa branca; o texto vai em `--on-scrim` (título) e
  `--on-scrim-2` (eyebrow e sub), alinhado à esquerda.
- **Shadow Strategy:** nenhuma em repouso; capa sobe 2 px com `--shadow-hover`
  em `--dur-med` (180 ms).
- **Internal Padding:** `16px 18px 14px` (hero-tile), `14px 14px 12px` (station
  card), `12px` entre capa e texto no card de álbum.
- **Row (linha de faixa):** 61 px, capa 40 px, título 13.5/600 carbono 1 e
  subtítulo 12 carbono 5, duração em mono à direita; hover soft; faixa atual
  com borda esquerda de 2 px em `--blue-ring` e título em `--blue-fg`; linha
  selecionada com `--primary` a 14 % e borda a 55 %.

### Inputs / Fields
- **Style:** altura 40 px, fundo paper, borda 1 px `--line-2`, raio 10 px,
  texto 13.5/500, ícone de lupa de 16 px à esquerda (carbono 6), atalho `kbd` à
  direita.
- **Focus:** borda carbono 8 + `--ring-focus`.
- **Placeholder:** carbono 6, peso 400.
- **Slider / fader:** trilho de 3 px (progresso) ou 14x110 px (fader do EQ) em
  `--line-2`/tint, preenchimento carbono 3 (0,3 de alpha no fader), thumb de
  10–14 px em carbono 1 com borda de 2 px em paper e `--shadow-knob`; no
  progresso o thumb só aparece no hover/foco e a área de clique tem 16 px.
  Fader ativo troca para `--blue-fg`.
- **Segmented:** trilho tint com borda `--line-2` e raio 8 px; botões
  `4px 10px`, 12/500, carbono 5; ativo = paper, carbono 1, sombra de 0,04.
  Com muitas opções, quebra linha (`--wrap`).
- **Color input** (`.tweaks__color`): swatch com raio pequeno dentro do mesmo
  campo.
- **Select nativo:** `appearance: none`, fundo paper, texto carbono 1, chevron
  Lucide de 14 px em carbono 5 (`.select-shell`); `applyTheme` grava
  `color-scheme` pela luminância do paper, para lista, barras de rolagem e
  caret seguirem o tema.

### Navigation
- **Sidebar (desktop):** paper com borda direita; marca de 22 px e nome 15/600;
  rótulo de seção 10/700 caixa-alta carbono 5; item `7px 12px`, 13.5/500
  carbono 3, ícone Lucide 16 px a 0,85 de opacidade; hover soft + carbono 1;
  ativo faint + 600. Rodapé com borda superior: Signal, Settings, Tweaks. O
  modo só-ícones esconde rótulos e mantém os atalhos.
- **Tabs (Library, Crate):** 13/500 carbono 5, ativo carbono 1/600 com sublinhado
  de 2 px em carbono 1; contagem em mono 10.5.
- **Titlebar:** 32 px, paper, 12 px de texto, semáforo de três pontos à
  esquerda.
- **Tabbar (S24):** 56 px, `--s-low`, borda superior; aba 9.5 px com ícone de
  21 px, inativa `--t4`, ativa `--accent`.

### Player bar (componente-assinatura do desktop)
Grade de três colunas (`minmax(240px,1fr) 1.4fr minmax(240px,1fr)`), 72 px,
paper com borda superior. Esquerda: capa 44 px (raio 8), título 13/600, chip
de proveniência + artista 12 carbono 5, coração e menu. Centro: transporte
(shuffle, anterior, play 36 px, próxima, repeat) sobre o seek de 3 px com
tempos em mono 11 px tabular de cada lado (colunas de 42 px). Direita: pílula
técnica "FLAC 24/96 · EQ · LIM" (mono 10.5, borda 1 px, ponto de estado), botões
de letra, fila e volume (trilho de 3 px). O S24 tem o mini player de 56 px
(capa 38 px, 12.5/500) e o Now Playing em folha deslizante.

### Tweaks (painel de customização)
Flutuante, 280 px, fixo a 16 px da borda direita e acima da barra do player,
paper com borda `--line-2`, raio 12 px e `--shadow-hover`. Cabeçalho `12px 14px`
com título 13/600 e fechar de 22 px; corpo com linhas de knob separadas por
12 px: rótulo 11/600 caixa-alta +0.06em carbono 3 com valor atual à direita
(11/400 carbono 5), controle abaixo (segmented, select, range ou color), dica de
uma linha 11 px carbono 5. Divisores com texto 10/700 entre as seções. É a
referência canônica para todo knob de preferência: antes de criar UI nova ou
YAML para um ajuste, ele entra aqui.

### Fundo animado (assinatura)
Canvas único no shell, dois motores (2D: 18 formas x 5 renderizadores; WebGL2:
cenas Poeira, Relevo, Órbitas, Nébula, Tinta, Riso, Lorem, Mandala), sempre um
só montado. Lê `--bg-ink-rgb`, `--primary` e `--fg-5` para a paleta; canvas
preto puro. Reação relativa à média da faixa, amortecida; nunca mais de 3
flashes por segundo; `Speed = 0` no Tweaks para. No WebGL a troca de cena
dissolve em 1,4 s (a cena que sai avança 6% e some por cima da nova; só
dissolve na versão calma) e o motor nasce do preto ao ligar; o kick é um
gesto que atravessa o espaço (frente de luz na Poeira, onda que desce o
túnel na Órbitas), nunca um clarão da tela inteira. Fora do Now Playing
(modo ambient) o fundo recua: desfoque de 8 px, saturação 0,9 e 80 % do
brilho, em 420 ms no `--ease-out` (na versão calma, só dissolve); no
WebGL quem faz isso é o próprio motor, num buffer a 1/4, nunca filter CSS
sobre o canvas. Critério de aceite: 60 fps
medidos no app a 1857x1048, média ≥ 58 e no máximo 2 % dos quadros acima de
20 ms.

## Do's and Don'ts

### Do:
- **Do** consumir token (`--fg-*`, `--bg-*`, `--line-*`, `--radius-*`,
  `--dur-*`, `--ease-out`) em todo componente; se o token falta, crie no `:root`
  e exponha ao tema (`yaml_key_to_css_prop`), nunca fixe no componente.
- **Do** usar `--blue-fg`/`--blue-ring`/`--blue-bg` (ou `--primary`) para
  "ligado", "atual", "foco" e "station": é o acento que segue tema e capa.
- **Do** `font-variant-numeric: tabular-nums` e `--font-mono` em todo número
  que muda.
- **Do** desenhar componente novo com os estados vazio, carregando e erro, e
  com atalho de teclado no desktop (o Crate vazio é o modelo: ícone de 24 px,
  título 14/600, dica 13 e a sequência de teclas em `kbd`).
- **Do** diferenciar hover de ligado (`aria-pressed` em `--blue-fg`).
- **Do** `prefers-reduced-motion`: versão calma, não tela morta. O bloco único
  no fim do CSS desliga rota, pulsos, VU e escalonamento; gaveta, paleta,
  Tweaks, card de letra e troca de faixa ficam só com opacidade (nada
  desliza); crossfade da capa, estados e linha atual seguem, porque são só
  opacidade e cor. O fundo anda a 1/4 da velocidade sem kick (`bgCalm` em
  `store/tweaks.ts`).
- **Do** medir contraste no pior ponto da captura real (capa e fundo animado),
  porque o detector só mede sobre fundo sólido.
- **Do** verificar a mudança visual na captura do app real
  (`scripts/impeccable/app_eval.sh capture`), não só no código.

### Don't:
- **Don't** declarar `transition` de custom property no `:root` nem animar
  `--bg-ink`/`--primary` por CSS: restyle da árvore inteira por quadro no
  WebKitGTK (medido: 60 → 29 fps). As vars saltam; a suavidade é local
  (`rgbLerp` nos canvases, transition nas propriedades concretas).
- **Don't** introduzir terceira família tipográfica, fonte por CDN, ícone fora
  do Lucide (única exceção: coração cheio do Phosphor) nem ícone pequeno
  ampliado.
- **Don't** usar cor crua (`#3b82f6`, `rgba(59,130,246,…)`, `#fff` sobre
  acento): use `--blue-ring` com `--halo-alpha` e `--on-primary`.
- **Don't** usar sombra para elevar superfície em repouso, nem
  `backdrop-filter` ou `filter` em tela cheia sobre o canvas animado (o
  filter do ambient custava 13 fps na Home; no WebGL ele é passe do motor).
- **Don't** "corrigir" o canvas do WebGL para quase-preto: é #000 por decisão.
- **Don't** empilhar mais de 3 tamanhos e 2 pesos numa tela, nem usar
  sobretítulo espaçado além do eyebrow, mono decorativo em dado que não muda,
  seta "→" em botão, palavra destacada no título ou gradiente roxo.
- **Don't** texto abaixo de 11 px em tela nova: use `--fs-label`. (Os achados
  de 25/10 na Home, "RES" e eyebrows, foram corrigidos na leva de 26/10.)
- **Don't** fixar acento colorido de repouso em tema novo: o repouso ideal é
  neutro e a cor vem da capa (direção do CEO). O Really Dark passou a #d6d6d6
  em 26/10/2026 (CMR-328).
- **Don't** reoferecer o que o CEO descartou: Nébula borrada, texturas finas
  repetidas, fitas.
