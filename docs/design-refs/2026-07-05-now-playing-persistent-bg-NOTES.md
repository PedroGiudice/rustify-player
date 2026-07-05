# Ref: Now Playing Persistent Background Preview (claude.ai/design)

**Fonte:** projeto claude.ai "rustify-player"
(`c5cabb56-e85e-4944-a8af-65fbe978188b`), arquivo
`Now Playing Persistent Background Preview.html`, puxado via DesignSync em
2026-07-05. O usuário está adicionando mais renderings ao design system —
o pacote completo virá com pickup prompt próprio. Este arquivo registra a
leitura do primeiro rendering pra não re-derivar depois.

## O que o preview especifica

1. **Background global persistente** — `.app-bg` com canvas único no App
   shell, `data-mode="focused"` (Now Playing: opacity 1, sem filter) vs
   `"ambient"` (demais views: opacity 0.80, `blur(8px) saturate(0.9)`),
   transição 420ms. Canvas NUNCA remonta entre rotas (HUD "mounts: 1").
   *Estado no repo:* o bg global e o modo focused/ambient JÁ existem
   (App.tsx `.app-bg`); o preview confirma a arquitetura.

2. **5 renderizadores** consumindo o MESMO campo escalar `shape(u,v,t)`:
   `mesh` (o atual), `columns` (linhas verticais), `weave` (mesh+columns
   a 0.8x amp, alpha 0.10), `dots` (grade 66x44, raio/alpha por
   intensidade), `contour` (34 bandas topográficas com stroke/alpha
   proporcionais ao pico da banda). Troca de render não remonta o canvas.
   *Delta:* renderers novos — hoje o repo só tem o mesh.

3. **+5 shapes novas** (família radial/propagante): `sonar` (anel que
   expande e desbota), `pond` (duas gotas interferindo), `whirlpool`,
   `shock` (anel fino em loop), `radar` (feixe girando). Somam-se às 13
   existentes (cordillera, nebula, horizon, twin peaks, vortex, ember,
   wavefront, aurora, ripple, dunes, lattice, comet, tide).

4. **Navegação de viz na NowPlaying** — canto inferior direito, dois pares
   prev/next com nome (`render · <b>mesh</b>` / `shape · <b>cordillera</b>`),
   persistência em localStorage, atalhos `[`/`]` (shape) e `,`/`.` (render).

5. **Sem FFT no preview** — amplitude modulada só por "breath". O preview
   isola a arquitetura de persistência; a reatividade por banda do repo
   (bgBassGain etc.) continua válida e se aplica por cima.

6. Ink fixo `23, 23, 23` no preview — no repo isso é `--bg-ink-rgb`
   (adaptive ink por capa, v0.2.37+). Integração direta: os renderers
   novos leem a var como o mesh faz hoje.

## Plano quando o pacote completo chegar

Mapear cada renderer/shape pro `SpectrumCanvas.tsx`/`shapes.ts` reais,
UI de navegação na NowPlaying (o repo tem shape-idx em
`rustify-shape-idx`; falta renderer), e conferir contra os demais
renderings que o usuário adicionar ao design system.
