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
  feature:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  lead:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  subhead:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  title-lg:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.005em"
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
  title-sm:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
  secondary:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  meta:
    fontFamily: "Instrument Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.3
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
  s24-stat:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  s24-lead:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  s24-body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  s24-label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.08em"
  s24-data:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "11px"
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
  # Tokens de espaço por papel (`--space-*` no `:root`, A48 de 31/10/2026).
  # O modo compacto (`html[data-density="compact"]`) troca só estes valores:
  # gutter 24, top 16, head-end 12, end 32, block 20, block-tight 12, tab-x 12.
  gutter: "40px"
  top: "28px"
  head-end: "18px"
  end: "56px"
  block: "36px"
  block-tight: "18px"
  tab-x: "14px"
components:
  button-primary:
    backgroundColor: "{colors.carbon-1}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    size: "36px"
  button-primary-hover:
    backgroundColor: "{colors.carbon-2}"
    textColor: "{colors.paper}"
  button-labeled-primary:
    backgroundColor: "{colors.carbon-1}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "30px"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.carbon-2}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "30px"
  button-secondary-hover:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.carbon-1}"
  button-small:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.carbon-2}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "26px"
  button-large:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.carbon-2}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "36px"
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
  empty-state:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.carbon-5}"
    rounded: "{rounded.xl}"
    padding: "72px 40px"
  empty-state-error:
    backgroundColor: "{colors.err-bg}"
    textColor: "{colors.carbon-4}"
    rounded: "{rounded.xl}"
  toast:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.carbon-2}"
    rounded: "{rounded.lg}"
    padding: "6px 6px 6px 14px"
    typography: "{typography.title-sm}"
  lib-hero-cover:
    rounded: "{rounded.2xl}"
    size: "176px"
  tidal-poster:
    rounded: "{rounded.xl}"
    size: "120px"
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
  âmbar = qualidade lossy na pílula de formato, bench baixo, ponte MCP
  conectada (alguém de fora pode mexer na tela); rosa = like ligado
  (coração) e erro. Cada um é um trio ring/bg/fg.
- **Pontos de estado** (31/10/2026): o halo é só do aviso; verde "tudo certo"
  e ponto neutro (faixa não medida, `--fg-6`) não brilham. No Crate o âmbar
  tem papel: "na fila" e "baixando" são espera normal, em tinta neutra; âmbar
  é "travou" ou "pede ação". O painel Recursos é neutro, com âmbar e rosa só
  como sinal (não segue o acento da capa).
- **Véu** (`--scrim-rgb` 0,0,0, a 0,32 na paleta ⌘K e na gaveta): escurece em
  qualquer tema; o literal antigo (o carbono 1) clareava o fundo no Really
  Dark.

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
O acento da capa mira 5,2:1 contra o canvas e o paper (não contra o ink do
tema) e 4,5:1 sobre a própria lavagem de 12 %; capa com croma OKLCH < 0,02 é
acromática e deixa o acento do tema. Os sinais ok/aviso/erro se medem onde
moram: sobre soft, faint e o próprio `-bg` (rgba composto sobre o paper). O
checker do tema (`load_theme`, `theme_contrast_checks`) e o `validate.py`
reprovam o que falha e avisam quando dois sinais colapsam (ΔE OKLab < 5).

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
Escala por papel em tokens no `:root` (A45, B32, 31/10/2026): cada token é um
degrau e um papel; tamanho fora da escala é dívida, não licença.

- **Display** (600, `clamp(48px, 5.4vw, 76px)`, 0.98, −0.025em): só o título
  da faixa no Now Playing, com `text-wrap: balance`. Única palavra grande do
  app.
- **Feature** (`--fs-feature` 28, 600, 1.1, −0.02em): título do destaque na
  Stations, da playlist e do `LibHero` (Álbum, Artista, Playlist).
- **Headline** (`--fs-headline` 22, 600, 1.2, −0.015em): h1 de cada vista.
- **Lead** (`--fs-lead` 18): título de cartão e do hero-tile, artista no Now
  Playing, valor de estatística, linha da letra, título da prévia da Tidal.
- **Subhead** (`--fs-subhead` 15): título de painel, nome da marca, campo da
  paleta ⌘K.
- **Title-lg** (`--fs-title-lg` 14, 600): título de painel e de estado vazio.
- **Title** (`--fs-title` 13,5, 600): título de item (linha, card, resultado),
  título da barra do player, campo de busca.
- **Body** (`--fs-body` 13): texto corrente, aba (600), dica.
- **Title-sm** (`--fs-title-sm` 12,5): título compacto (gaveta da fila, mini
  player, toast).
- **Secondary** (`--fs-small` 12, carbono 5): artista, álbum, subtítulo, chip,
  botão.
- **Meta** (`--fs-meta` 11,5): dado de linha e secundário compacto (duração,
  estatística, subtítulo da gaveta).
- **Label** (`--fs-label` 11, `--label-weight` 700, `--label-tracking`
  +0,06em, caixa-alta, carbono 5, sans): receita ÚNICA de rótulo; toda regra
  de rótulo aponta para esses tokens. Caixa-alta em mono só no dado (selo de
  origem, nome do renderer).
- **Data** (mono 11 = `--fs-label`, tabular): tempo da barra, duração, hora
  relativa, selo de formato, selo de proveniência (11/600). Todo mono leva
  `tabular-nums`.

### Hierarchy (S24)
Escala própria em `src/mobile/styles/tokens.css` (A63, 31/10/2026), com piso
de 11 px em tudo que se lê (tabbar, eyebrow, rótulos, selo de origem, tags,
mono de meta; eram 8,5-10,5).

- **Display** (`--fs-display` 28, Fraunces 600, 1.1, −0.02em): h1 de cada aba.
- **Title** (`--fs-title` 23, Fraunces 600, 1.14, −0.02em): título da faixa
  no Now Playing.
- **Stat** (`--fs-stat` 19, Inter 600): valor de estatística.
- **Lead** (`--fs-lead` 17, Inter 600): título de cartão de atalho e de seção
  de destaque.
- **Body** (`--fs-body` 13,5, Inter 500): título da faixa na lista.
- **Meta** (`--fs-meta` 11,5): artista e secundário, em `--t3`.
- **Label** (`--fs-label` 11, Inter 700, +0.08em, caixa-alta, `--t3`):
  eyebrow, aba da tabbar e selo de origem.
- **Data** (JetBrains Mono 11, tabular): subtítulo do cabeçalho, duração,
  tempos do seek.
- `--t4` só em glifo e chevron (3:1 basta para não-texto); texto, por menor
  que seja, vai em `--t3` ou acima.

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
o zoom 1,1 do dono), via `--fs-label` (11 px) nos rótulos pequenos, no desktop
e no S24. Abaixo disso só o Hz do fader, que é dívida, não licença.

## Layout

**Desktop** é uma grade fixa de três faixas: barra de título de 32 px
(`--titlebar-h`) atravessando a largura, barra lateral de 220 px
(`--sidebar-w`; 56 px no modo só-ícones do Tweaks) à esquerda, barra do player
de 72 px (`--playerbar-h`) embaixo, e a vista no miolo. O modo cinema zera as
três e deixa só o Now Playing. Dentro da vista, o espaço vem dos tokens de
papel: cabeçalho com `--space-top` 28 / `--space-gutter` 40 /
`--space-head-end` 18 e borda inferior de 1 px, corpo com `--space-top` /
`--space-gutter` / `--space-end` 56, blocos separados por `--space-block` 36
(`--space-block-tight` 18 no apertado), aba com `--space-tab-x` 14 de lado e
alinhada ao gutter. A Home empilha hero-grid (`1.8fr 1fr 1fr`, gap 10 px),
seção de linhas e grade de cards (`minmax(176px, 1fr)`, gap `22px 16px`). O
Now Playing é a exceção: capa de 200 px e título lado a lado em
`auto minmax(0,1fr)` com gap 28 px, card de letra flutuante arrastável, e um
ponto de quebra que vale (760 px reduz a capa para 160 px). A
resolução real do dono é 1920x1080 com zoom 1,15 na UI, o que dá um canvas de
1857x1048: medir sempre aí.

**Containers, não viewport.** A barra do player (container `pb`, cortes em
1500/1300/1100 px), o lado esquerdo dela (`pbl`, 340/260) e o Crate
(`crate`, 1050/760) quebram pela largura DELES, que muda com a barra lateral
e o zoom do Tweaks, coisas que a viewport não vê.

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
útil do S24 é 316 px. Todo alvo de toque tem `--tap-min` 44 px (onde a linha
não cresce, o alvo cresce por margem negativa ou `::after`); a folha de ações
é quase opaca e sem desfoque (`--s-sheet`, rgba(12,12,12,0.96)); o S24 usa os
tokens de movimento do desktop (`--ease-out`, `--ease-in`, `--dur-*`,
`--dur-press` no toque que afunda) e tem o próprio "reduzir movimento"
(`src/mobile/motion.ts`). No Now Playing, Curtir fica à direita do título e a
qualidade medida tem linha própria.

**Ritmo**: o espaço de tela é dos tokens `--space-*`; o modo compacto troca
os sete (24/16/12/32/20/12/12) e as regras que os usam encolhem juntas,
inclusive o Crate. Dentro de componente o código segue os degraus 4/6/8/10/12/
14/16: padding interno de card 14–18 px, gap entre texto e meta 2–6 px, gap
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
- **Degraus (A47, 31/10/2026):** `--btn-h-sm` 26 (ação dentro de painel denso:
  Signal, Tweaks), `--btn-h` 30 (linha e painel: Crate, Settings),
  `--btn-h-lg` 36 em pílula (ação de cabeçalho: Álbum, Artista, Playlist, Now
  Playing). Ao lado de campo de 40 px o botão acompanha o campo.
- **Pele única dos rotulados:** fundo paper, borda `--line-2`, texto carbono 2
  em 600; hover fundo soft, borda carbono 8, texto carbono 1.
- **Primário rotulado:** fundo carbono 1, texto paper; hover carbono 2. Um
  primário por linha: na lista do Crate a ação principal (`crate-btn--lead`)
  fica secundária em repouso e só vira preta na linha em foco (teclado ou
  foco dentro). Um preto por vez, não trinta.
- **Play (transporte):** círculo pleno de 36 px, fundo carbono 1, ícone em
  paper, traço do ícone em 2,5 px para pesar como ícone cheio; hover carbono 2
  e `scale(1.04)`.
- **Quiet / icon:** 28 px, transparente, ícone carbono 5; hover texto carbono
  1 sobre soft. Ligado (`aria-pressed`) = `--blue-fg` (acento); like ligado =
  `--rose-fg`. Ligado tem de ser distinto de hover.
- **Disabled:** `--disabled-opacity` 0,45, sem hover nem cursor de ação.
- **Destrutivo arma e confirma:** o primeiro clique troca o rótulo ("Redefinir
  tudo" vira a confirmação) e só o segundo age; o que dá para desfazer usa o
  toast com Desfazer em vez de confirmação.
- **Focus:** `--focus-outline` (2 px sólido `--blue-ring`, offset 2 px) para
  teclado; `--ring-focus` (box-shadow 0 0 0 2px) em campos.
- **Transições:** `background`/`color`/`border-color` em `--dur-base` (150 ms)
  com `--ease-out` (`cubic-bezier(0.16, 1, 0.3, 1)`, desacelera de verdade);
  toda transição do CSS declara a curva (sem curva o navegador usa `ease`).
  Toque afunda chip (0,96), item de navegação (0,98) e hero-tile (0,995) via
  `:active` em `--dur-press` (80 ms), e todo botão rotulado afunda (Crate,
  seleção, toast, Tweaks, cabeçalho de biblioteca; na barra só letra, fila e
  mudo); nunca animar play/pause, anterior, próxima nem seek. Curtir pulsa uma vez (1 → 1,22 → 1 em 240 ms), só ao
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
  Componente que sai com animação passa por `createPresence`
  (`lib/motion.ts`, atributo `data-leaving`): diálogo Mover e SelectionBar
  saem em `--dur-med` com `--ease-in`. Exceção de progresso: a barra da busca
  do Crate anda em 800 ms linear (é tempo, não gesto).
  Tema troca as durações em `motion.fast/base/med/screen/enter/press/stagger`.

### Chips
- **Style:** pílula, fundo paper, borda `--line-2`, texto carbono 4 em 12/500,
  padding `5px 11px`; hover texto carbono 1 e borda carbono 8.
- **State:** selecionado inverte (fundo carbono 1, texto paper). No Crate, chip
  com ícone de 11 px e altura 24 px; `aria-expanded` = fundo faint.
- **Selo técnico** (`.badge-fmt`, `.pb-src`): mono 11 px (`--fs-label`),
  caixa-alta no de proveniência (11/600, +0,06em), borda 1 px, raio 4 px;
  station/rádio pegam o acento.

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
  rótulo de seção na receita de rótulo (11/700, +0,06em, carbono 5); item `7px 12px`, 13.5/500
  carbono 3, ícone Lucide 16 px a 0,85 de opacidade; hover soft + carbono 1;
  ativo faint + 600. Rodapé com borda superior: Signal, Settings, Tweaks e,
  abaixo do Tweaks, a pílula âmbar "Ponte conectada" (`.bridge-chip`, 24 px,
  11/600, ícone `plug` 12 px): só monta com a ponte MCP ligada E cliente
  conectado, e abre o Tweaks ao clicar. O modo só-ícones esconde rótulos e
  mantém os atalhos.
- **Tabs (Library, Crate):** 13/600 SEMPRE (o peso não muda com o
  estado, a largura não pula); inativa carbono 5, ativa carbono 1 com
  sublinhado de 2 px que abre do centro; padding lateral `--space-tab-x` e a
  primeira aba alinhada ao gutter da vista. Setas trocam de aba
  (`lib/tabKeys.ts`); contagem em mono 11.
- **Titlebar:** 32 px, paper, 12 px de texto, semáforo de três pontos à
  esquerda.
- **Tabbar (S24):** 56 px, `--s-low`, borda superior; aba 11 px
  (`--fs-label`) com ícone de 21 px, inativa `--t3` (o `--t4` fica no ícone),
  ativa `--accent`.

### Player bar (componente-assinatura do desktop)
Container de largura `pb` (o grid mora em `.playerbar__grid`), 72 px, paper com
borda superior. Colunas `minmax(0,1fr) 1.2fr minmax(430px,1fr)`: a esquerda
cede primeiro, com reticências. Cortes por prioridade pela largura da barra:
< 1500 px sai o medidor (piso da direita 384), < 1300 a pílula perde o resumo
do DSP (328), < 1100 o volume vai a 72 px (272).
- **Esquerda** (container `pbl`): capa 44 px (raio 8), título 13,5/600, selo
  único + artista 12 carbono 5, coração e menu. O selo só existe no rádio e
  diz o grau ("rádio · 1ª escuta", "rádio · descoberta", "rádio"), em mono
  11/600; álbum e fila solta não têm selo. < 340 px o selo fica com a
  primeira palavra, < 260 sai (o motivo segue no `title` da linha).
- **Centro:** transporte (shuffle, anterior, play 36 px, próxima, repeat)
  sobre o seek numa caixa de 14 px (com ou sem perfil; trocar de faixa não
  muda a altura), tempos em mono 11 tabular com `min-width: 7ch` (H:MM:SS).
  Trilho do seek sem perfil e do volume em carbono 7 (`--fg-7`), 3 px.
- **Direita:** medidor L/R, pílula técnica "FLAC 24/96 · EQ · LIM" (mono 11,
  borda 1 px, raio 8), fila, mudo e volume. A pílula é LEITURA, não botão:
  sem hover nem cursor, `role="img"` com o resumo no rótulo; o ponto verde
  não tem halo, o âmbar (lossy por dentro) tem, e faixa não medida fica com
  ponto neutro. Letra só pelo Now Playing. O "+N" de enfileirar aparece
  acima do botão da fila (não tapa o mudo).
- **Medidor:** oculto sem faixa; trilho `--line-2`, clip marcado em
  `--rose-ring`.

O S24 tem o mini player de 56 px (capa 38 px, 12.5/500) e o Now Playing em
folha deslizante.

### Gaveta da fila e menu da faixa
A linha editável (`.qedit`) tem gutters de 24 px nos dois lados, onde ficam a
alça de arrastar e o botão de tirar; a linha da que toca usa os mesmos gutters
para as capas caírem na mesma coluna. O hover realça a linha inteira. O menu
de contexto da faixa é paper com `--radius-lg` e `--shadow-hover`, navegável
por setas; o coração ligado em `--rose-fg`.

### Estado de tela (EmptyState)
`components/EmptyState.tsx` (`.empty-block`, `data-tone`): três caras para
três situações. **Vazio** = moldura tracejada `--line-2`, raio 12, paper,
ícone carbono 7, título `--fs-title-lg` 600, texto 13 carbono 5 (máx. 52ch) e
ações. **Erro** = banner rosa (borda sólida, rosa a 10 % sobre o paper), ícone
`--rose-fg` e saída ([Tentar de novo]); erro de leitura nunca se disfarça de
lista vazia. **Carregando** = só o texto, sem moldura. Aparece por opacidade
em `--dur-med`.

### Toast
Canto direito, acima da barra do player (`bottom: playerbar + 14px`), z 120,
paper com borda `--line-2`, `--radius-lg`, `--shadow-hover`; entra em
`--dur-enter`, fica 6 s; texto `--fs-title-sm` carbono 2 e uma ação
(Desfazer, Tentar de novo) em 600, também pelo Ctrl+Z. Falha de ação usa a
fórmula "Não consegui…" (`lib/failNotice.ts`).

### Cabeçalho de biblioteca (LibHero)
Álbum, Artista e Playlist: capa de 176 px (140 no compacto, raio 14; redonda
para artista), kicker em rótulo, título em Feature 28, slot `facts` com a
escuta viva e a qualidade medida (`.lib-hero__q`) e as ações em `--btn-h-lg`.

### Campos e controles novos
- **FilterField:** filtro de grade (Álbuns, Artistas) com a pele do filtro da
  Playlists (`.coll-search`); Esc limpa; mostra "12 de 340" com filtro ativo.
- **FolderPicker** (`views/crate/FolderPicker.tsx`): seletor único de pasta do
  Crate inteiro.
- **Switch** (`role="switch"` + `aria-checked`, nome por `aria-labelledby`):
  interruptor do Settings e do Signal; desligado continua visível.
- **Card com `.card__open`:** o card inteiro é um botão que ABRE (o anel de
  foco cobre o card); o play do hover é outro botão e toca.

### Tidal (Crate)
Prévia de álbum, playlist e rádio com cartaz de 120 px (`--radius-xl`) e
título em `--fs-lead`; artista com foto; seleção em massa por arrastar nas
caixas ou Shift+clique.

### Tweaks (painel de customização)
Flutuante, 280 px, fixo a 16 px da borda direita e acima da barra do player,
paper com borda `--line-2`, raio 12 px e `--shadow-hover`. Cabeçalho `12px 14px`
com título 13/600 e fechar de 22 px; corpo com linhas de knob separadas por
12 px: rótulo 11/600 caixa-alta +0.06em carbono 3 com valor atual à direita
(11/400 carbono 5), controle abaixo (segmented, select, range ou color), dica de
uma linha 11 px carbono 5. Seções Fundo, Áudio, Aparência e Controle remoto
com âncoras, títulos na receita de rótulo; knob que depende de outro diz
"Depende de …"; o avançado (Relevo) fica recolhido. É a referência canônica para todo knob de preferência: antes de criar UI nova ou
YAML para um ajuste, ele entra aqui. Última seção, "Controle remoto": o
interruptor da ponte MCP (padrão Off) com a linha viva de estado (ponto âmbar
quando alguém de fora pode agir).

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
- **Do** desenhar componente novo com os estados vazio, carregando e erro
  (`EmptyState` com `tone`; leitura por `settle`/`peek` de `lib/loaded.ts`,
  nunca `catch` que devolve lista vazia) e com atalho de teclado no desktop.
- **Do** devolver o foco ao fechar overlay (`lib/focusReturn.ts`) e avisar
  falha de ação com `failNotice` ("Não consegui…" + [Tentar de novo]).
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
