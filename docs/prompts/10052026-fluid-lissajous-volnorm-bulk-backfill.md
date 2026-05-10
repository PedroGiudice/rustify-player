# Retomada: Fluid Lissajous Tuning + Pendencias Pos-Volume Norm

## Contexto rapido

Sessao anterior fechou o **MVP do volume normalization** (bulk LUFS backfill
agora cobre 100% da biblioteca de 983 tracks via thread no coordinator do
indexer) e o **fix do Qdrant sidecar** (health gate 15s antes de Indexer::open).

Em paralelo, fez **refator canonico do FluidBackground** (3 ghost cursors em
trajetorias Lissajous, splat continuo a cada frame, audio modula apenas
force/radius/cor — nao mais trigger). Tambem dropou o `renderWithBackground`:
fluid agora roda standalone sobre fundo preto (a shape image dimmed pulsando
era o que dominava visualmente, mascarava o fluid).

Visual atual: aprovado conceitualmente. Calibragem ainda em iteracao
(YAML v7 — `cmr-auto:~/.local/share/rustify-player/spectrum/default.yaml`).
Pendencias claras de pulir: trajetoria desacoplar do bass, curva
de modulacao, hue spread.

## Arquivos principais

### Codigo

- `src/components/FluidBackground.tsx` — Lissajous ghost cursor loop (frame), bandEnergy smoothing, GHOSTS array
- `src-tauri/src/lib.rs:2120-2150` — Qdrant health gate + Indexer::open
- `src-tauri/crates/library-indexer/src/pipeline.rs` — `backfill_missing_lufs`, spawn no coordinator_loop
- `src-tauri/crates/library-indexer/src/qdrant_client.rs` — `scroll_all_with_filter`

### Docs

- `docs/contexto/10052026-fluid-lissajous-volnorm-bulk-backfill.md` — contexto detalhado desta sessao
- `docs/contexto/09052026-volume-norm-x600-eq-rtings.md` — sessao anterior (X600 + volume norm MVP)
- `/home/opc/deep-research-outputs/2026-05-09-fluid-audio-reactive-visualizers.md` — DR canonical fluid (240 linhas)
- `/home/opc/deep-research-outputs/2026-05-10-audio-reactive-viz-alternatives.md` — DR alternativas modernas (319 linhas, ranking 13 paradigmas)

### Externos (cmr-auto)

- `~/.local/share/rustify-player/spectrum/default.yaml` — preset Balanced (style: fluid) com fluid_* v7
- `~/Downloads/Soundcore-Motion-X600-warm-tilt.json` — preset EQ X600 4-band

## Proximos passos (por prioridade)

### 1. Desacoplar velocidade da intensidade do bass (trajetoria fixa)

**Onde:** `src/components/FluidBackground.tsx`, frame loop ~linha 540 (atual)

**O que:** mudar `force` pra constante baixa (NAO modulada por energy):
```typescript
// ANTES (atual):
const force = g.baseForce * fluidCfg.SPLAT_FORCE / 600 * eShaped;
// DEPOIS:
const force = g.baseForce * fluidCfg.SPLAT_FORCE / 600 * 0.05;  // fixed, suave
```
E intensificar modulacao via radius+cor:
```typescript
const radius = g.baseRadius * fluidCfg.SPLAT_RADIUS / 0.18 * (0.3 + energy * 1.5);
color.r *= fluidCfg.COLOR_INTENSITY * (0.2 + energy * 1.6);
```

**Por que:** usuario relatou "velocidade ta relacionada com a intensidade da
batida, nao deveria". Trajetoria visual deve ser estavel; audio deve mudar so
"presenca" (gordura/brilho), nao "movimento".

**Verificar:** apos rebuild, com bass forte a tinta deve ficar mais brilhante
e gorda no path do ghost, NAO voar pra fora dele. Path Lissajous deve ser
visivel como "trilha" mais claramente.

### 2. Curva cubic → quadratica (responsividade do spectrum)

**Onde:** `src/components/FluidBackground.tsx`, mesmo loop

**O que:** trocar `eShaped`:
```typescript
// ANTES: const eShaped = energy * energy * energy;  // cubic — esmaga
// DEPOIS: const eShaped = energy * energy;           // quadratica
```

**Por que:** com cubic, energy=0.5 (range tipico de musica) → eShaped=0.125.
Diferenca entre bass-pesada e bass-light vira imperceptivel. Usuario disse:
"nao sei do alinhamento com o spectrum". Com quadratica, energy=0.5 → 0.25 (2× mais).

**Verificar:** auditivamente — pausar musica, fluid deve ficar quase parado.
Tocar bass-heavy → ghost do bass visivelmente mais carregado que mid/treble.

### 3. HueOffsets espalhados pra cores complementares

**Onde:** `src/components/FluidBackground.tsx`, array `GHOSTS`

**O que:** trocar hueOffsets de `0.00 / 0.08 / 0.16` pra `0.00 / 0.33 / 0.66`.

**Por que:** usuario precisa identificar visualmente qual ghost esta agindo.
Diferencas de 8% no circulo cromatico sao invisiveis; 33% (cores
complementares-triadicas) sao obvias.

**Verificar:** pause uma musica com bass forte e treble fraco — fluid deve
ter cor predominantemente "do ghost bass" (baseHue + 0). Treble-heavy vai
puxar pra cor oposta no circulo.

### 4. Mapping na shape image (fluid molda silhueta)

**Onde:** `src/components/FluidBackground.tsx`, advectionShaderSrc, linhas 109-114

**O que:** intensificar mask factor:
```glsl
// ANTES: float maskFactor = 0.7 + mask * 0.3;  // sutil
// DEPOIS: float maskFactor = 0.2 + mask * 0.8; // agressivo
```

**Por que:** usuario quer fluid "habite" uma silhueta. Shape mask ja existe
mas com efeito sutil. Subindo agressividade, fluid preenche a silhueta da
shape e dissipa rapido fora — sem precisar renderizar a shape como background.

**Verificar:** carregar uma shape com forma reconhecivel (chama, simbolo);
fluid deve ficar "preso" na silhueta brilhante.

### 5. X600 EQ ear-test warm-tilt 4-band

**Onde:** UI do app — Signal view → Importar preset

**O que:** importar `~/Downloads/Soundcore-Motion-X600-warm-tilt.json` e ouvir
com tracks variadas. Reportar sensacao por categoria (bass / vocal / treble /
brilho geral).

**Por que:** preset reordenado e aprovado conceptualmente; nunca validado em
escuta longa.

**Verificar:** auditivamente. Tracks sugeridas: Adele "Hello", Daft Punk
"Doin' It Right", Steely Dan "Aja", Kendrick "DNA".

### 6. (Opcional) YAML hot-reload pra EQ

**Onde:** novo modulo no backend (`audio-engine` ou `app`), watcher
`notify` em arquivo `~/.config/rustify-player/eq-live.yaml`.

**O que:** mesmo padrao do `watchSpectrumPreset`. Quando arquivo muda → parse
→ emite `Command::DspSetEqBands` no engine. Toggle ou env var
`RUSTIFY_EQ_LIVE=1`.

**Por que:** permitiria iterar EQ via `sed`/edit, ciclos de 5s vs 60s pelo
Signal view. Vale a pena se vamos calibrar muito (X600 + outros perfis).
~1h dev.

### 7. (Estrategico) Migracao SDF Raymarching

**Onde:** novo `src/components/SDFBackground.tsx`. Manter FluidBackground
como fallback opt-in via YAML (`style: "fluid"` continua valido).

**O que:** seguir relatorio
`/home/opc/deep-research-outputs/2026-05-10-audio-reactive-viz-alternatives.md`
secao "7. SDF Raymarching". Iniciar com domain warping audio-reativo,
soft min entre primitivas SDF, paleta da capa via vibrant.js.

**Por que:** unico paradigma "2026 premium" viavel em WebGL2 puro
(WebKitGTK Linux nao suporta WebGPU bem). Volumetric Raymarching seria
melhor visualmente mas pesa 16ms+ no Linux. ~6-10h dev.

**Verificar:** ler relatorio antes de comecar; planejar tasks via
`docs/plans/` separado.

## Restricoes / Cuidados

- **NAO remover** `uploadShapeMask()` no FluidBackground — outros styles
  (exoskeleton) usam shape via componente proprio, mas o `uShapeMask` no
  advection ainda da textura ao fluid (mesmo sem renderWithBackground).
- **NAO mexer em `applyFullState`** do EQ Signal view — quebra presets do user.
- **NAO compilar localmente na cmr-auto** — sempre `bash scripts/release.sh`
  na VM.
- **YAML hot-reload pode ser ignorado** se mudar SIM_RESOLUTION ou DYE_RESOLUTION
  (engine WebGL inicializa essas uma vez no setup, nao reagem a hot-reload).
- **Dissipation no nosso esquema NAO segue Pavel canonico** — calibrar empirico
  (ver tabela v1-v7 no doc de contexto).
- **App regressao surpresa** — usuario fez `dpkg -i` so do primeiro release de
  hoje (19:59 — versao volume norm). Releases subsequentes (Lissajous + drop
  shape) compartilham a mesma tag `dev` mas precisam de novo `dpkg -i`. Sempre
  confirmar via `stat -c '%y' /usr/bin/rustify-player` na cmr-auto.

## Como verificar

```bash
# 1. Repo state
cd /home/opc/rustify-player
git log --oneline -8
# Esperado top: b89244f feat(fluid): drop shape-image background...

# 2. Cargo check limpo
cargo check --manifest-path src-tauri/Cargo.toml
# Esperado: Finished `dev` profile

# 3. Frontend build
bun x vite build 2>&1 | tail -3
# Esperado: ✓ built

# 4. Cobertura LUFS na cmr-auto (deve ser 100%)
curl -s http://100.102.249.9:6333/collections/rustify_tracks/points/count \
  -X POST -H 'Content-Type: application/json' \
  -d '{"filter":{"must":[{"is_empty":{"key":"lufs_integrated"}}]},"exact":true}'
# Esperado: {"result":{"count":0},...}

# 5. App rodando + versao instalada
ssh cmr-auto@100.102.249.9 "stat -c '%y' /usr/bin/rustify-player; ps aux | grep rustify | grep -v grep | head"

# 6. Yaml v7 ativo
ssh cmr-auto@100.102.249.9 "tail -10 ~/.local/share/rustify-player/spectrum/default.yaml"
```

<session_metadata>
date: 2026-05-10
branch: main
last_commit: b89244f
release_tag: dev (v0.2.3, multiplas republicacoes)
fluid_yaml_version: v7
fluid_state: ok visualmente, calibragem pendente (3 ajustes prio alta)
deep_research_outputs:
  - 2026-05-09-fluid-audio-reactive-visualizers.md (canonical fluid)
  - 2026-05-10-audio-reactive-viz-alternatives.md (alternativas modernas)
volume_norm_state: 100% cobertura, MVP closed
x600_eq_state: warm-tilt 4-band aprovado conceptual, ear-test pendente
</session_metadata>
