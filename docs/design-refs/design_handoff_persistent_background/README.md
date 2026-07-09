# Handoff: Persistent Background — shapes × renderers

## Overview

Este pacote descreve o fundo animado do Rustify (as linhas carbon-on-paper que
aparecem esmaecidas em todas as rotas e "cheias" no Now Playing) com duas
características:

1. **Persistência real** — o canvas monta **uma única vez** no shell e nunca
   remonta ao navegar. Só o `data-mode` do wrapper muda (`ambient` ↔ `focused`).
2. **Separação "o quê" × "como"** — o desenho tem duas camadas independentes
   que se multiplicam:
   - **shape** = um campo escalar `fn(u,v,t) → [0,1]` (onde há energia no plano).
     **23** shapes.
   - **renderer** = como pintar esse campo. **5** renderers.
   - 23 × 5 = **115 combinações**, cada uma persistida em localStorage.

## About the Design Files

O arquivo deste bundle — `Now Playing Persistent Background Preview.html` — é
uma **referência de design em HTML**: um protótipo funcional (vanilla JS) que
demonstra o comportamento pretendido (canvas global persistente, dispatch
shape × renderer, os controles e o HUD de reatividade). **Não é para copiar
direto.** A tarefa é **recriar esse comportamento no ambiente do app**
(Rustify é Solid + TypeScript, Tauri) usando os padrões que já existem lá —
`src/shapes.ts`, `src/components/SpectrumCanvas.tsx`, etc. Nenhum arquivo de
produção foi alterado por este handoff; toda a especificação vive aqui.

## Fidelity

**High-fidelity.** Cores, tipografia, densidades de linha e as funções
matemáticas dos shapes/renderers são finais. Todo valor no protótipo é o valor
pretendido (tinta `rgba(23,23,23,·)`, `NLINES=110 / NPOINTS=96`, `amp = h*0.17*
breath`, etc.). Copie os números do HTML sem reinterpretar.

## Arquitetura (a ideia central)

```
CAMPO (o quê)              ESTRATÉGIA (como)           LOOP
────────────              ─────────────────           ────
SHAPES[]                  RENDERERS[]                 rAF único, canvas
  fn(u,v,t) → [0,1]         draw(ctx, …, shapeFn)      global que nunca
  (23 campos)               (5 estratégias)            remonta; calcula
                                                       breath/amp e chama
                                                       RENDERERS[i].draw
```

- **Nenhum renderer sabe qual shape está ativo** — todos só chamam
  `shapeFn(u,v,t)`. Por isso as listas se multiplicam sem custo.
- **Trocar shape OU renderer nunca remonta o canvas** — muda só um índice
  reativo; o próximo frame redesenha.
- Ambos os índices persistem em localStorage. No protótipo:
  `rustify-preview-shape` e `rustify-preview-renderer`. Default de renderer =
  `0` (`mesh`), o desenho original — logo o comportamento antigo é preservado
  por padrão.

## Shapes (23)

Assinatura: `fn: (u, v, t) => number`, `u,v ∈ [0,1]²`, `t` em segundos,
retorno logicamente em `[0,1]`. Código-fonte de cada função: bloco `const
SHAPES = [ … ]` no HTML.

**Originais (7):** `cordillera`, `nebula`, `horizon`, `twin peaks`, `vortex`,
`ember`, `wavefront`.

**Família campo/curtain (4):** `aurora` (cortinas verticais numa banda),
`dunes` (cristas senoidais empilhadas), `lattice` (interferência de grade),
`tide` (banda horizontal varrendo verticalmente).

**Família radial/propagante (7):** `ripple` (anéis concêntricos de um ponto
móvel), `comet` (hotspot com cauda atravessando), `sonar` (anel único que
expande e reseta, desbotando), `pond` (duas gotas interferindo), `whirlpool`
(anéis + rotação angular), `shock` (anel fino e nítido em loop), `radar`
(feixe girando em torno do centro).

## Renderers (5)

Cada renderer recebe `(ctx, w, h, t, shapeFn, amp, breath)` (+ tinta `ink`) e
consome o mesmo campo. Código-fonte: funções `drawMesh/drawColumns/drawWeave/
drawDots/drawContour` e o array `RENDERERS` no HTML.

| name | como pinta | densidade |
|---|---|---|
| `mesh` | linhas horizontais onduladas (o original) — 1 `stroke()` | 110 linhas × 96 seg |
| `columns` | mesmo campo transposto → linhas verticais | 90 col × 110 seg |
| `weave` | mesh + columns sobrepostos, alpha baixo → tecido | ambos a 0.10 alpha |
| `dots` | grade de pontos; raio e alpha ∝ campo | 66 × 44 |
| `contour` | poucas bandas; espessura/alpha ∝ pico → topográfico | 34 bandas |

## Interactions & Behavior

- Dois seletores empilhados no canto inferior-direito do Now Playing (`‹ nome
  ›`): renderer (em cima) e shape (embaixo). Cada um: botão prev, label mono,
  botão next.
- **Teclado:** `[` / `]` = shape anterior/próximo; `,` / `.` = renderer
  anterior/próximo; `H`/`L`/`N` = navegação de rotas. Ignorar quando o foco
  está em input/textarea ou com meta/ctrl/alt.
- Transição de modo do fundo: `opacity 420ms` + `filter 420ms`
  (`cubic-bezier(0.4,0,0.2,1)`). `ambient` = `opacity .80; blur(8px)
  saturate(.9)`. `focused` = `opacity 1; filter none`.
- O canvas pausa o desenho (early-return no rAF) quando `document.hidden` ou
  `!canvas.isConnected` — não cancela o loop.

## State Management

- `shapeIdx` / `renderIdx`: dois índices; no app Solid seriam signals globais
  no módulo do canvas, expostos por hooks tipo `useShape()` / `useRenderer()`.
  Persistem em localStorage.
- `bgMode`: derivado da rota (`/now-playing` → `focused`, senão `ambient`),
  escrito no `data-mode` do wrapper `.app-bg`.
- Tinta: no protótipo é fixa (`"23, 23, 23"`); no app é relida de
  `--bg-ink-rgb` a cada ~30 frames (Tweaks ao vivo).

## Design Tokens

- **Tinta:** `rgba(23,23,23,0.16)` (mesh/columns), `0.10` (weave),
  `0.05…0.37` variável (contour), `rgb(23,23,23)` com alpha `0.10…0.65` (dots).
- **Superfícies:** canvas `#fafafa`, paper `#fff`, hover morno `#f7f6f3`.
- **Linhas/bordas:** hairline `#e5e5e5`.
- **Chip Now Playing:** `--blue-bg #eff6ff` / `--blue-fg #2563eb`, dot
  `#3b82f6` pulsando.
- **Tipografia:** Instrument Sans (UI) + system mono (labels/specs, `tabular-nums`).
- **Amplitude:** `amp = h * 0.17 * breath`, `breath = 0.85 + 0.15·sin(t·0.4)`.
- **Radius:** md `8px`, lg `10px`, xl `12px`, 2xl `14px`, pill `999px`.
- **Motion:** `--dur-base .15s`, `--ease-out cubic-bezier(.4,0,.2,1)`.

## Onde isso encaixa no codebase (referência, não modificado)

| Arquivo existente | Papel |
|---|---|
| `src/shapes.ts` | lista canônica de shapes (hoje 7). Adicionar os 11 novos aqui. |
| `src/components/SpectrumCanvas.tsx` | loop do canvas + `useShape()`. É onde entra o dispatch pro renderer e um `useRenderer()` análogo. |
| `src/App.tsx` | monta `<SpectrumCanvas>` uma vez no wrapper `.app-bg`. |
| `src/views/NowPlaying.tsx` | onde vivem os seletores (hoje só de shape). |
| `src/router.ts` | `bgMode` derivado da rota. |

> Decisão do implementador: extrair os renderers num módulo próprio
> (`renderers.ts`) mantém o `SpectrumCanvas` fino e espelha a organização de
> `shapes.ts`. Cópias paralelas podem existir em `redesign/` — replicar lá se
> ainda for alvo.

## Assets

Nenhum asset binário novo. Ícones são SVG inline (chevrons, stroke 1.5–1.8,
`currentColor`). Instrument Sans via Google Fonts no protótipo; em produção,
usar a fonte já embarcada.

## Files (neste bundle)

- `Now Playing Persistent Background Preview.html` — protótipo funcional com o
  dispatch shape × renderer, os dois seletores, keybindings e o HUD "Reactivity
  Split" (route / bg mode / canvas mounts / frames / renderer / shape). **Fonte
  da verdade** para valores, funções e comportamento.

## Atualização 2026-07-09 — família gerativa (Field Explorer)

O handoff remoto (claude.ai/design, projeto rustify-player) ganhou 5 shapes
novas — família "gerativa / Field Explorer", as vencedoras do batch de
exploração, todas validadas a 60fps: `interference` (dois pontos-fonte,
topografia nervosa), `spiral` (espiral logarítmica), `turbulence` (fbm barato
de 3 oitavas), `cells` (quilt orgânico `|sin·cos|^0.6`), `warp` (domain-warp
de senoides). Implementadas em `src/shapes.ts` na v0.2.48, APÓS as 18
existentes (índice persiste em localStorage — ordem é contrato).

Arquivos adicionais no projeto remoto (não sincronizados aqui por peso):
- `Field Explorer.html` — bancada de validação com HUD de FPS real,
  verts/frame e frame-ms. Teclado: `[ ]` shape · `< >` render · `space`
  pausa · `b` beat-sync.
- `covers/` — 18 renders estáticos 1200×1200 do motor. Ideia de produto
  registrada: cover art gerativa determinística por hash do álbum
  (álbum sem capa → mesma shape sempre).
- Beat-sync: fórmula fechada no README remoto
  (`reactive = 1 + SYNC · ((rmsEnergy − 0.7) + lowBandMag · 0.32)`,
  modula só amplitude/tinta, nunca fase).
