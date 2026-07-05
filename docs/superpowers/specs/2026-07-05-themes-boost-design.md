# Themes Boost — mais params, superfícies novas e theme-maker

**Data:** 2026-07-05
**Status:** aprovado (full-auto autorizado pelo usuário, decisões estéticas delegadas)

## Problema

Os temas YAML controlam só o vocabulário legado (surfaces/text/accent/signal/
typography/effects). O CSS consome muito mais do que isso, e parte do visual é
hardcoded em componentes — invisível pro sistema de temas:

- **Halos de foco/hover cravados** em `rgba(59,130,246,…)` (azul Tailwind) e
  `rgba(16,185,129,…)` (verde) em ~7 pontos — tema troca o accent, halo não segue.
- **Glass panels com branco fixo** (`rgba(255,255,255,0.78–0.9)`) — claros até
  em tema dark.
- **Tones** (`--tone-{mint,sky,peach,rose,lavender,butter,bone,paper}-{bg,border}`,
  16 vars consumidas pelo CSS e aceitas pelo parser) — nenhum tema os define;
  cards de tone ficam nos pastéis light default sempre.
- **Radius/shadows/motion** — tokens existem, temas não os usam; sombras de
  componentes ignoram os tokens `--shadow-*`.
- `#fff` sobre accent em vez de `--on-primary`; sem `::selection`.

## Decisões

1. **Schema estruturado (camada 1)** — seções novas no YAML, mesma família das
   existentes. Camada 2 (tokens crus) permanece como escape hatch.
2. **Derivar em vez de parametrizar** onde possível: halos = `color-mix` sobre os
   rings semânticos + um único `--halo-alpha`. Sem N params redundantes.
3. **Precedência do ink**: usuário (knob tocado, dirty-flag) > capa do álbum
   (adaptive ink ligado) > tema (`background.ink`) > default CSS. `lyricsGlass`
   segue o mesmo modelo sem a camada de capa. Knob ganha "reset pro tema"
   (limpa a flag).
4. **Zero mudança visual no default**: os tokens novos nascem com os valores
   atuais do CSS; temas que não declaram as seções novas ficam idênticos.
5. Subagente **theme-maker** industrializa a criação de temas.

## Schema YAML novo (camada 1, aliases adicionados ao parser)

```yaml
tones:                    # pastéis dos cards; 8 nomes fixos
  mint:     { bg: "#…", border: "#…" }
  sky:      { bg: "#…", border: "#…" }
  # peach, rose, lavender, butter, bone, paper idem
glass:
  tint: "23, 23, 23"      # triplet RGB (vai pra rgba(var(--glass-tint), var(--glass-alpha)))
  alpha: 0.85
  blur: "20px"
radius:
  xs: "4px"               # xs, sm, md, lg, xl, 2xl, pill, full — todos opcionais
shadows:
  card: "0 1px 2px rgba(0,0,0,0.18)"   # card, hover, hairline, compact
motion:
  fast: "120ms"           # --dur-fast/base/med
  base: "180ms"
  med: "260ms"
  ease: "cubic-bezier(.2,.8,.2,1)"     # --ease-out
background:
  ink: "#171717"          # default do bg animado (Tweaks sobrescreve se dirty)
effects:
  halo: 0.12              # --halo-alpha (intensidade dos anéis de foco/hover)
typography:
  mono: '"JetBrains Mono", …'   # volta a funcionar (des-gambiarra mono-legacy)
```

Mapeamentos (`yaml_key_to_css_prop`): `tones-<nome>-bg|border` → `--tone-<nome>-*`,
`glass-tint|alpha|blur` → `--glass-*`, `radius-<k>` → `--radius-<k>`,
`shadows-<k>` → `--shadow-<k>`, `motion-fast|base|med` → `--dur-*`,
`motion-ease` → `--ease-out`, `background-ink` → `--bg-ink` (+ derivação do
triplet `--bg-ink-rgb` no apply do frontend), `effects-halo` → `--halo-alpha`,
`typography-mono` → `--font-mono` (mantendo `mono-legacy` por compat).

## CSS (extractor-lab.css)

- Tokens novos no `:root` com defaults = visual atual: `--glass-tint: 255,255,255`,
  `--glass-alpha: 0.85`, `--glass-blur: 20px`, `--halo-alpha: 0.12`.
  (dark base `[data-theme=dark]` define glass-tint escuro equivalente.)
- Halos: `rgba(59,130,246,X)` → `color-mix(in srgb, var(--blue-ring) calc(var(--halo-alpha)*100%), transparent)`
  (equivalente pros verdes com `--green-ring`). WebKitGTK 2.52 suporta color-mix.
- Glass: `rgba(255,255,255,0.85)` etc → `rgba(var(--glass-tint), var(--glass-alpha))`
  + `backdrop-filter: blur(var(--glass-blur))` onde já há blur.
- Sombras soltas de componentes migram pros tokens `--shadow-*` existentes
  (mapeando por papel: card/hover/hairline/compact). Sombras de contexto único
  que não casam com token ficam como estão (sem inventar token por sombra).
- `#fff`/`#ffffff` sobre accent → `var(--on-primary)`.
- `::selection { background: color-mix(in srgb, var(--primary) 30%, transparent) }`.
- Overlays/scrims escuros (`rgba(0,0,0,…)` de hero-tile/modal) ficam — escurecer
  por cima de conteúdo é neutro de tema (decisão: não parametrizar; YAGNI).

## Validação (load_theme)

Pares novos de contraste: `fg-1` sobre cada `--tone-<nome>-bg` **declarado pelo
tema** (só os presentes — temas sem tones não ganham checks novos). Threshold
AA 4.5 igual aos demais. `scripts/themes/validate.py` (novo, promovido do
scratchpad) replica o checker completo e roda offline — usado pelo theme-maker
e pra CI manual.

## Tweaks (precedência)

`kv-tweaks` ganha `dirty: string[]` (nomes dos campos tocados pelo usuário).
`applyTweaks` só seta `--bg-ink[-rgb]` e `--lyrics-bg-alpha` se o campo estiver
em `dirty`. Setter dos knobs adiciona à lista; botão "reset pro tema" remove e
limpa a inline var (tema volta a valer). Migração: estado salvo existente ganha
`dirty` com os campos cujo valor difere do DEFAULTS (preserva comportamento de
quem já customizou).

## 12 YAML existentes

Cada tema ganha as seções novas com valores derivados da própria paleta
(decisão estética delegada): tones = pastéis re-ancorados na luminância do
canvas do tema (dark → tones escuros dessaturados com borda 1 degrau acima),
glass = paper do tema em triplet com alpha atual, ink = canvas, halo = 0.12,
radius/shadows/motion = defaults do design system (declarados explícitos só
onde o tema pede personalidade: Neon → motion mais rápido e halo mais forte;
Copper → sombras mais quentes… a critério do implementador). Validação
obrigatória: `validate.py` zero reprovações.

## Adaptive ink (cor da capa no Now Playing)

O bg animado e as linhas do spectrum já herdam `--bg-ink-rgb`; o backend já tem
`get_track_color` (enrichment `dominant_color` no Qdrant + fallback computa da
capa cacheada e persiste). Falta só o elo:

- `src/lib/adaptiveInk.ts`: `deriveInk(hex, themeInkHex)` — converte pra HSL,
  clampa L na faixa do tema (dark: 0.10–0.32; light: 0.55–0.85, detectado pela
  luminância do ink do tema) e aplica saturação mínima 0.15. Protege contra a
  cor média lamacenta de capas multicoloridas.
- Hook no player store: `createEffect` sobre a track corrente → `getTrackColor`
  → `deriveInk` → interpola `--bg-ink[-rgb]` (lerp JS ~600ms; o canvas lê a var
  por frame). Track sem capa/cor → volta pro ink do tema.
- Tweak novo `adaptiveInk: boolean`, **default ON** (segmented Off/Album no
  painel Tweaks, seção do background).
- Se a cor média decepcionar esteticamente, upgrade futuro do extractor
  (`dominant_color`) pra k-means no Rust — a fiação não muda.

## Subagente theme-maker

`.claude/agents/theme-maker.md` (formato `rules/agent-format.md`):
- **Input**: descrição verbal, paleta (hex/coolors) ou imagem de referência.
- **Fluxo**: deriva paleta completa (MCP coolors: harmonização/contraste/tonal) →
  monta YAML no schema novo → `scripts/themes/validate.py` (reprova → itera
  internamente) → crítica visual (MCP design-critique) → escreve **arquivo novo**
  em `~/.local/share/rustify-player/themes/` na cmr-auto via scp (nunca
  sobrescreve tema existente sem ordem explícita) → usuário escolhe no picker;
  iteração por feedback verbal edita o mesmo arquivo (hot-reload).
- **Tools**: Read, Write, Edit, Bash + `mcp__coolors__*`, `mcp__design-critique-mcp__*`.
- **Não faz**: release, mudanças de código, WebSearch.

## Fora de escopo

- Scrims escuros parametrizados; herança/composição de temas; editor visual de
  temas no app; light themes novos (usuário pode pedir ao theme-maker depois).

## Riscos

- `color-mix` em WebKitGTK: suportado desde WebKit ~2022; validar no app real
  (cmr-auto, WebKitGTK 2.52.3) antes do release final.
- Migração dirty-flag: erro aqui silencia customização existente do usuário —
  coberto por teste unitário da migração.
- Sombras migradas mudam pixel em casos raros: aceito (full-auto estético).

## Sequência de implementação

1. `scripts/themes/validate.py` (base de verificação)
2. Parser Rust (aliases + checks tone) + `cargo check` + testes Rust
3. CSS (tokens + migração hardcoded)
4. Tweaks dirty-flag + typecheck + testes TS
5. Upgrade dos 12 YAML + validate.py + deploy cmr-auto
6. theme-maker agent
7. Docs (CLAUDE.md) + commits + release.sh + dpkg -i (usuário) + verificação
   via MCP no app real
