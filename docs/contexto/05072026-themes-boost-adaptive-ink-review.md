# Contexto: Themes Boost + Adaptive Ink + Review (v0.2.37/v0.2.38)

**Data:** 2026-07-05
**Sessão:** main (direto, rolling release)
**Duração:** sessão longa multi-arco (áudio → temas → boost → review → design)

---

## Arco da sessão (5 fases encadeadas)

1. **Distorção de áudio** (resolvida, config-only)
2. **12 temas YAML corrigidos** pra WCAG AA (config-only, deployados)
3. **Themes boost** — schema novo, superfícies CSS, adaptive ink, theme-maker (v0.2.37)
4. **Review 8-finders + fixes + extração de cor v2** (v0.2.38)
5. **Rendering do claude.ai/design** puxado e documentado (implementação FUTURA)

## 1. Distorção de áudio (NÃO era código)

Diagnóstico por medição (pw-record no sinal digital, A/B via IPC): o EQ interno
do app estava com preset "Soundcore-Motion-X600-warm-tilt" (+7.8dB @110Hz),
**preamp ~0 e limiter OFF** → picos +6dBFS → hard clip. Nenhuma release
continha a causa: estado persistido no localStorage, materializado nos restarts
dos dpkg de 27/06. **Correção aplicada: EQ interno OFF (runtime + persistido).**
Usuário confirmou e mandou NÃO restaurar o warm-tilt. O preamp -3dB documentado
em 04/06 sumiu do estado em algum momento — sem histórico pra datar.
Detalhe medido: tracks do acervo têm `rg_track_peak` > 1.0 (masterização
colada no teto) — qualquer boost sem headroom clipa.

## 2. Temas: correção WCAG (pré-boost)

12 YAML em `~/.local/share/rustify-player/themes/` (cmr-auto — temas NÃO vivem
no repo). Bugs corrigidos: `typography.mono` era descartado pelo parser
(gambiarra temporária `mono-legacy`, depois des-gambiarrada no boost);
`really-dark` com surfaces embaralhadas (canvas #b8b8b8 claro); `theme-gray`
com name roubado ("Ice Cream Mint") e 11 pares AA reprovados; `redistributed`
com accent colors (#ae2012) como surfaces. Método: clarear mantendo hue,
validado no checker real do backend (12/12 PASS via MCP no app).

## 3. Themes boost (spec: `docs/superpowers/specs/2026-07-05-themes-boost-design.md`)

### Parser (lib.rs, `yaml_key_to_css_prop`)
Camada 1 ganhou: `glass.tint/alpha/blur`, `background.ink`, `motion.fast/base/
med/ease`, `effects.halo`, `typography.mono`; strip_prefix open-ended
`tones-*`→`--tone-*` e `shadows-*`→`--shadow-*` (QUALQUER nome passa).
`load_theme` checa contraste `fg-1` sobre cada `--tone-*-bg` declarado
(dinâmico). Testes: `schema_boost_mapeia_secoes_novas`,
`typography_mono_e_mono_legacy_mapeiam_font_mono`.

### CSS (extractor-lab.css)
Tokens novos (defaults = visual antigo): `--glass-tint/alpha/blur`,
`--halo-alpha`, `--shadow-knob`. Migrações: halos `rgba(59,130,246,…)`/verde →
`color-mix(in srgb, var(--blue-ring|--green-ring) calc(var(--halo-alpha) *
80–160%), transparent)` (multiplicadores preservam hierarquia relativa);
glass branco fixo → `rgba(var(--glass-tint), var(--glass-alpha)±delta)`;
`#fff` sobre `--fg-1` → `var(--bg-paper)` (conserta dark); `::selection` novo.
**color-mix+calc e rgba(var,calc) VALIDADOS no WebKitGTK real da cmr-auto via
probe MCP** (retornaram alphas exatos).

### Precedência do ink (resolver único em store/tweaks.ts)
`usuário (dirty) > capa (adaptiveInk on, default) > tema (background.ink) >
default`. Dirty-flag persistida em `kv-tweaks.__dirty`; migração one-shot
infere dirty por `valor != DEFAULTS` (rodou correta pro usuário real:
lyricsGlass 0.85 dirty, bgInk limpo). `bgInk`/`lyricsGlass` regidos por tema;
botão "↺ tema" (clearDirty). `applyTheme` (tauri.ts) dispara CustomEvent
`rustify:theme-applied` com `{ink}`; listener em tweaks.ts é **cirúrgico**
(re-asserta só fontes setadas + lyrics dirty + ink — NUNCA applyTweaks inteiro,
ver bug B2 no review). Animação do ink: 4 steps de 150ms (consumidores
SpectrumCanvas/EqCanvas amostram getComputedStyle ~3x/s).

### Adaptive ink (src/lib/adaptiveInk.ts)
`TrackStarted` → effect (prev-guard on/path — tweaks() é signal de objeto
inteiro, sem guard qualquer knob re-dispara) → `getState()` valida
`current_library_track.path === expectedPath` (snapshot pode estar stale com a
faixa ANTERIOR num skip; retry 5x/300ms) → `getTrackColor(id)` →
`deriveInk(hex, themeInkBase())` → `setAdaptiveColor`. Troca de tema mid-track:
listener re-deriva `_lastCoverHex` (ordem de registro garante themeInkBase
atualizado). `deriveInk` v2: saturação `clamp(cover.s*1.6, 0.35, 0.90)`
(acromático s<0.05 fica), luminância ancorada no ink do tema
(dark: `[max(0.10,themeL), min(0.45,themeL+0.24)]`).

### Extração de cor v2 (cover.rs `dominant_color`)
Média-1x1 (lamacenta por construção) → quantização: thumbnail 48x48, buckets
12 hue × 3 sat × 3 light, peso `(0.10+s) * max(0.10, 1-(l-0.5).abs()*1.6)`,
retorna média ponderada do bucket vencedor. Enrichment **versionado**:
`dominant_color_v2` (get_track_color em lib.rs) — valores antigos ignorados,
recalcula lazy no primeiro play por faixa. Testes: vermelho 30% vence cinza
70%; grayscale fica grayscale.

### Subagente theme-maker (`.claude/agents/theme-maker.md`)
Input: descrição/paleta/imagem → deriva via MCP coolors → valida com
`scripts/themes/validate.py` (zero problemas obrigatório) → deploy arquivo
NOVO via scp → hot-reload. Nunca sobrescreve sem ordem; nunca toca código.
**Executou o upgrade dos 12 YAML** (tones dark-aware por hue do nome, glass
do surfaces.base, ink = surfaces.lowest, halo 0.1; Neon: motion 90/140/200ms
+ halo 0.18; Really Dark/Monochrome: sombras fortes). Deployados na cmr-auto.

### validate.py (scripts/themes/validate.py)
Réplica do checker do backend, usada pelo theme-maker e pré-deploy. Alinhado
pós-review: tones/shadows open-ended (espelha strip_prefix), contraste de
QUALQUER `--tone-*-bg`, hex obrigatório em `--bg-ink` (frontend faz hexToRgb).

## 4. Review (8 finders paralelos → 9 bugs corrigidos na v0.2.38)

| # | Bug (confirmado) | Fix |
|---|---|---|
| B2/B3 | Listener theme-applied rodava applyTweaks inteiro → removeProperty(--font-mono) + sobrescrita de --glow matavam o tema no mesmo tick | Listener cirúrgico |
| A2 | Skip A→B: snapshot stale (não-null) aplicava cor da capa de A | Valida path esperado + retry |
| A4/E1/C2 | Qualquer knob re-disparava o effect do ink (burst de IPCs no arrasto) | prev-guard on/path |
| A3 | Tema trocado mid-track não re-derivava a cor adaptive | Listener re-deriva _lastCoverHex |
| C5 | 2 retries insuficientes no gap de boot/resume | retries=5 |
| E3 | rAF 600ms = ~36 writes p/ sampler 3Hz | 4 steps de 150ms |
| C1 | Settings "sem tema": removeAttribute(style) nukeava tweaks + _themeInk stale | dispatch evento ink:null + applyTweaks |
| A5/C3 | validate.py divergia do parser (rejeitava shadows.knob/tone custom válidos) | open-ended + tone loop dinâmico |
| B1 | Fallbacks CSS lyrics (0.10/0.85) ≠ default do slider (0.193/0.820) | Fallbacks alinhados |

Refutados/aceitos: ordem de boot segura (applyThemeByName é async, loadTweaks
sync antes); listener one-shot é barato; load_theme clones desprezíveis.
Zero violações de convenção (IDs u64 ok no caminho novo).
**Tech debt registrado: Linear CMR-112** (7 itens: conversores de cor
triplicados, halo multiplicadores mágicos, THEME_GOVERNED semi-genérico,
lyricsGlass sem canal de tema real, 2 IPCs por troca, botão reset duplicado,
cadeia IPC duplicada no Visualizer).

## 5. Rendering claude.ai/design (implementação FUTURA)

Projeto claude.ai "rustify-player" (`c5cabb56-e85e-4944-a8af-65fbe978188b`,
tipo PROJECT comum — só acessível via URL direta com DesignSync, não aparece
em list_projects). Arquivo puxado: `Now Playing Persistent Background
Preview.html`. Leitura completa em
`docs/design-refs/2026-07-05-now-playing-persistent-bg-NOTES.md`: 5 renderers
(mesh/columns/weave/dots/contour) sobre o mesmo campo escalar, +5 shapes
radiais (sonar/pond/whirlpool/shock/radar), nav de render+shape na NowPlaying
com atalhos `[`/`]`/`,`/`.`. **Usuário está adicionando MAIS renderings ao
design system — pacote completo virá com pickup prompt dele. NÃO implementar
antes disso (risco de retrabalho).** Acesso: `/design-login` + DesignSync
get_file com o projectId acima.

## Estado dos arquivos (commits 200f9c2..53ce2eb)

| Arquivo | Status | Detalhe |
|---|---|---|
| `src-tauri/src/lib.rs` | Modificado | Parser boost + checks tone + enrichment v2 |
| `src-tauri/crates/library-indexer/src/cover.rs` | Modificado | dominant_color v2 + rgb_to_hsl + 2 testes |
| `src-tauri/crates/audio-engine/src/output/dsp.rs` | Modificado | -norm_gain_volume (dead) |
| `src/styles/extractor-lab.css` | Modificado | Tokens glass/halo/knob, color-mix, ::selection, fallbacks lyrics |
| `src/store/tweaks.ts` | Modificado | Dirty-flag, resolver ink, listener cirúrgico, applyLyricsGlass |
| `src/lib/adaptiveInk.ts` | Criado | deriveInk v2 + wiring com guards |
| `src/store/tweaks.test.ts` | Criado | 10 testes (precedência + migração) |
| `src/views/Tweaks.tsx` | Modificado | Segmented adaptiveInk + botões ↺ tema |
| `src/views/Settings.tsx` | Modificado | Fix caminho "sem tema" |
| `src/tauri.ts` | Modificado | applyTheme dispara theme-applied |
| `src/main.tsx` | Modificado | wireAdaptiveInk() |
| `src/store/player.ts` | Modificado | -setScrubbing (dead) |
| `scripts/themes/validate.py` | Criado | Validador réplica, alinhado ao parser |
| `.claude/agents/theme-maker.md` | Criado | Subagente de temas |
| `docs/superpowers/specs/2026-07-05-themes-boost-design.md` | Criado | Spec aprovada (full-auto) |
| `docs/design-refs/2026-07-05-now-playing-persistent-bg-NOTES.md` | Criado | Leitura do rendering |
| 5x `src/views/*.test.tsx` | Modificados | Mocks ../tauri completados |
| `CLAUDE.md` | Modificado | Seção Themes/precedência |
| 12x YAML na cmr-auto | Deployados | WCAG + seções boost (fora do git) |

## Gates verificados

| Gate | Resultado |
|---|---|
| `npm run typecheck` | EXIT 0 |
| `npm test` | 107 passed, 0 unhandled errors |
| `cargo test --workspace` | 140 passed, 5 ignored |
| validate.py nos 12 YAML | 12/12 |
| load_theme via MCP (app real) | 12 temas, 0 AA fails, vars novas presentes |
| color-mix/calc no WebKitGTK 2.52 | Probe MCP: alphas exatos |
| Adaptive ink ao vivo | `--bg-ink-rgb: 91,94,69` (oliva da capa) |

## Decisões

- **Halo derivado, não parametrizado**: color-mix sobre rings + `--halo-alpha`
  único | Descartado: N params de cor de halo (redundantes).
- **Enrichment versionado (v2) em vez de backfill**: recalcula lazy por play |
  Descartado: re-scan em massa (desnecessário, custo alto).
- **Não restaurar warm-tilt**: ordem explícita do usuário pós-distorção.
- **Não implementar renderers do preview ainda**: mais renderings vêm aí.
- **decoder_roundtrip flaky sob `--workspace` paralelo** (contention
  PipeWire) — passa isolado; não é regressão. Não corrigido (baixo custo).
- **Ultracode ligado na sessão** (não persiste entre sessões).

## Pendências (pra próxima sessão)

1. **dpkg v0.2.38 na cmr-auto** (alta) — usuário instalou só a 0.2.37; a
   0.2.38 tem a extração v2 + os 9 fixes. Validar cores pós-install (trocar
   faixas de capa viva; cor recalcula no 1º play por faixa).
2. **Ajuste fino da saturação do ink** (alta) — deriveInk v2 + extração v2
   ainda não foram OUVIDOS/VISTOS juntos pelo usuário; iterar por feedback.
3. **Renderings do design system** (alta, GATED no usuário) — aguardar pickup
   prompt com o pacote completo; implementar renderers/shapes/nav.
4. **Mistério das 1500 músicas** (média) — pergunta ORIGINAL da sessão, nunca
   investigada (foco mudou): soma das tracks das playlists < 1500 arquivos na
   cmr-auto. Provável: arquivos fora de playlist/pasta 1º nível, duplicatas,
   ou tracks não indexadas. Começar por: count no Qdrant (1303 na época) vs
   `find ~/Music -iname '*.flac' | wc -l`.
5. **CMR-112 tech debt** (baixa) — 7 itens no Linear.
6. **Follow-up antigo de DSP** (baixa) — auto-headroom no EQ interno +
   warning boost-sem-limiter (proposto na fase 1, nunca virou código).
