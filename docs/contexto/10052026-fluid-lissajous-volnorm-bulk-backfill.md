# Contexto: Fluid Lissajous + Volume Norm Bulk Backfill + Qdrant Sidecar Fix

**Data:** 2026-05-10
**Branch:** main (mergeado de `feat/volume-normalization`)
**Duracao:** ~6h

---

## O que foi feito

### 1. Volume Normalization — bulk backfill on startup (encerra MVP)

A versao v0.2.3 anterior tinha o gain stage post-EQ pre-Limiter (Posicao B) ja
funcionando, mas o backfill de LUFS era **lazy** (so processava a track tocada,
e o gain calculado so valia pro PROXIMO play da mesma faixa). Resultado real:
1.6% de cobertura na biblioteca de 983 tracks. Usuario nao percebia normalizacao.

Adicionamos bulk backfill no proprio coordinator do `library-indexer`:

```rust
// pipeline.rs — chamado uma vez apos run_scan inicial
fn backfill_missing_lufs(client: &QdrantClient) -> Result<(), IndexerError> {
    let filter = json!({"must": [{"is_empty": {"key": "lufs_integrated"}}]});
    let pending = client.scroll_all_with_filter(filter, &["path"])?;
    // decode FLAC sequencial via loudness::analyze_file → set_payload
}
```

Roda em thread dedicada `library-indexer-lufs-backfill` (libera coordinator).
Sequencial, single-threaded — predictable CPU footprint enquanto app toca.
Idempotente: filtro `is_empty` skip o que ja tem LUFS.

Ja temos confirmacao end-to-end: **983/983 com LUFS, 100% cobertura** apos ~1.5h.

Tambem adicionado `QdrantClient::scroll_all_with_filter()` — scroll paginated
com filter (ja existia o `scroll_all_payloads` sem filter, mas precisavamos
ambos pra outros cenarios futuros).

### 2. Qdrant sidecar health gate

Pos hard-restart do PC, o app crashava com:

```
failed to open library indexer: Embedding("qdrant get collection:
http://localhost:6333/collections/rustify_tracks: Connection refused")
```

`Indexer::open(...).expect(...)` em lib.rs:2131 panica em qualquer race com
o sidecar Qdrant que ainda nao bindou a porta. Adicionamos gate de health
check com timeout 15s antes do `Indexer::open`:

```rust
let probe = library_indexer::QdrantClient::new(&qdrant_url);
let started = std::time::Instant::now();
while !probe.is_healthy() {
    if started.elapsed() > Duration::from_secs(15) { panic!(...); }
    std::thread::sleep(Duration::from_millis(500));
}
```

`is_healthy()` ja existia em qdrant_client.rs:181.

### 3. Fluid Background — refator canonical Lissajous Ghost Cursor

Pivot fundamental no FluidBackground. O approach anterior violava 3 das 6
armadilhas do relatorio Gemini DR (`docs/contexto/09052026-...md`):

| # | Armadilha | Implementacao antiga |
|---|-----------|----------------------|
| 1 | Splats de 1 frame (sem inercia) | `splatCount = max(0, currentLevel - lastBassLevel)` — diferencial |
| 2 | Posicao aleatoria descorrelacionada | Cycle por N emitters da shape image |
| 4 | Dissipacao muito rapida | DENSITY 1.5, VELOCITY 0.3 |

Substituido por **3 ghost cursors** em trajetorias Lissajous, um por banda
perceptual (bass / mid / treble). Cada ghost emite splat **a cada frame**;
audio modula apenas force, radius e color brightness — nunca trigger ou posicao.

```typescript
const GHOSTS: Ghost[] = [
  { band: "bass",   freqA: 0.27, freqB: 0.41, ampX: 0.32, ampY: 0.30, baseRadius: 0.22, baseForce: 700, hueOffset: 0.00 },
  { band: "mid",    freqA: 0.55, freqB: 0.83, ampX: 0.40, ampY: 0.22, baseRadius: 0.14, baseForce: 450, hueOffset: 0.08 },
  { band: "treble", freqA: 0.97, freqB: 1.31, ampX: 0.25, ampY: 0.36, baseRadius: 0.09, baseForce: 280, hueOffset: 0.16 },
];

// frame loop
for (const g of GHOSTS) {
  const x = 0.5 + g.ampX * Math.sin(g.freqA * ghostT + g.phaseA);
  const y = 0.5 + g.ampY * Math.sin(g.freqB * ghostT);
  const tx = g.freqA * g.ampX * Math.cos(g.freqA * ghostT + g.phaseA); // tangent
  const ty = g.freqB * g.ampY * Math.cos(g.freqB * ghostT);
  const eShaped = energy * energy * energy; // ⚠ cubic — alvo de tuning futuro
  const force = g.baseForce * fluidCfg.SPLAT_FORCE / 600 * eShaped;
  const radius = g.baseRadius * fluidCfg.SPLAT_RADIUS / 0.18 * (0.55 + energy * 0.9);
  // ...
}
```

Smoothing exponencial das bandas (emula `AnalyserNode.smoothingTimeConstant`):

```typescript
const BAND_SMOOTH = 0.88;
bandEnergy.bass = bandEnergy.bass * BAND_SMOOTH + rawBass * (1 - BAND_SMOOTH);
```

Removidos: `Emitter` interface, `extractEmitters()`, `NUM_EMITTERS`, todo o
caminho de "splat emite das pontas brilhantes da shape image".

### 4. Fluid stand-alone (drop renderWithBackground)

Diagnostico chave: o que o usuario percebia como "fluid tomando a tela inteira"
era na verdade a **shape image** sendo renderizada como background dimmed 25%
pulsando com bass. O FluidBackground nao usa mais shape como backdrop.

```typescript
// Antes:
if (hasShape && colorTex) engine.renderWithBackground(colorTex);
else engine.render();

// Depois:
engine.render();  // sempre — fluid sobre fundo preto
```

`uploadShapeMask()` continua sendo chamado, e o advection shader ainda usa
mask pra moldar a regiao onde tinta vive (linhas 109-114 do FluidBackground.tsx),
mas com efeito sutil (`maskFactor = 0.7 + mask * 0.3`).

Outros estilos do YAML (`style: "exoskeleton"`) NAO sao afetados — usam
componente diferente.

### 5. Calibragem iterativa do fluid (v1 → v7)

Sete iteracoes via YAML hot-reload (sem rebuild). YAML em
`cmr-auto:~/.local/share/rustify-player/spectrum/default.yaml`. Hot-reload via
`watchSpectrumPreset` em NowPlaying.tsx:62.

| Versao | density_diss | velocity_diss | curl | radius | force | color | Sintoma |
|--------|--------------|---------------|------|--------|-------|-------|---------|
| v1 | 0.5 | 0.15 | 40 | 0.18 | 600 | 0.6 | Saturava (tinta + shape image) |
| v2 | 1.5 | 0.5 | 30 | 0.10 | 400 | 0.04 | Idem |
| v3 | 3.0 | 1.5 | 30 | 0.06 | 150 | 0.003 | Idem (era a shape, nao o fluid) |
| v4 | 2.0 | 4.0 | 15 | 0.04 | 25 | 0.005 | Idem |
| v5 | 5.0 | 8.0 | 5 | 0.005 | 5 | 0.001 | Mostrou que fluid era sutil; shape dominava |
| v6 | 0.3 | 0.6 | 35 | 0.10 | 200 | 0.05 | Pos drop-shape: protagonista, mas rapido |
| **v7 (atual)** | 0.25 | 1.5 | 28 | 0.09 | 80 | 0.06 | OK visualmente |

### 6. Deep research — alternativas modernas

Relatorio Gemini DR (max) salvo em
`/home/opc/deep-research-outputs/2026-05-10-audio-reactive-viz-alternatives.md`
(319 linhas, 13 paradigmas analisados).

**Top 4 ranking:**

| # | Paradigma | Veredicto | Linux/WebGL2 viavel? |
|---|-----------|-----------|----------------------|
| 1 | Volumetric Noise Raymarching | REPLACEMENT | Marginal (16ms+ no WebKitGTK) |
| 2 | SDF Raymarching (Inigo Quilez) | REPLACEMENT | Sim (5-15ms) |
| 3 | MLS-MPM liquid metal | REPLACEMENT | Nao — WebGPU only |
| 4 | Reactive Gaussian Splatting | COMPLEMENT | Nao — WebGPU only |

**Pra cmr-auto (Linux + WebKitGTK):** SDF Raymarching e a unica candidata
"premium 2026" que roda nativa hoje.

### 7. X600 EQ — pivot warm-tilt 4-band

Rejeitado o oratory-style 16-band (estridente, sem grave). Pivot pra **tilt EQ
warm** (filosofia Harman-shifted pra speaker BT pequeno). 4 bandas:

```
band0: 80Hz   Bell      +2.0  Q 1.2   (punch)
band1: 150Hz  Lo-shelf  +6.0  Q 0.7   (bass shelf principal)
band2: 250Hz  Bell      -1.5  Q 1.0   (cut boxiness)
band9: 5000Hz Hi-shelf  -2.5  Q 0.5   (tilt down agudos)
```

(Bandas 3-8 e 10-15 com gain 0, ordenadas por frequencia ascendente — usuario
flagou que estava "porco" na primeira versao com freqs fora de ordem.)

Bass Enhancer ON (amount 0.5, harmonics 0.4), Limiter ON (boost false), preamp -3.

Preset salvo em `cmr-auto:~/Downloads/Soundcore-Motion-X600-warm-tilt.json`.

## Estado dos arquivos

### Backend (Rust)

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/crates/library-indexer/src/qdrant_client.rs` | Mod | +`scroll_all_with_filter()` (paginated filter scroll) |
| `src-tauri/crates/library-indexer/src/pipeline.rs` | Mod | +`backfill_missing_lufs()`, +spawn thread no coordinator_loop |
| `src-tauri/src/lib.rs` | Mod | +health gate Qdrant 15s, defaults fluid_* recalibrados |

### Frontend (SolidJS / TypeScript)

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/components/FluidBackground.tsx` | Mod | -Emitter interface, -extractEmitters, -NUM_EMITTERS, +GHOSTS array, +Lissajous loop em frame(), -renderWithBackground branch |

### Configs externas (cmr-auto)

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `~/.local/share/rustify-player/spectrum/default.yaml` | Mod (v7) | fluid_* params calibrados pra Lissajous protagonista |
| `~/Downloads/Soundcore-Motion-X600-warm-tilt.json` | Novo | Preset EQ X600 warm-tilt 4-band |

### Docs

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `/home/opc/deep-research-outputs/2026-05-10-audio-reactive-viz-alternatives.md` | Novo (319 linhas) | DR comparando 13 paradigmas |
| `docs/contexto/09052026-volume-norm-x600-eq-rtings.md` | Pre-existente (untracked) | Sessao anterior |
| `docs/x600-curves/` | Pre-existente (untracked) | Imagens RTINGS |

## Commits desta sessao

```
44ab02a feat(library-indexer): LUFS analysis via ebur128 + Qdrant payload field    (sessao anterior, mergeado)
a13ed73 feat(audio-engine): norm_gain stage + LUFS-to-gain helpers                 (sessao anterior, mergeado)
89671ae feat(app): IPC + Settings toggle for volume normalization                  (sessao anterior, mergeado)
3910314 feat(library-indexer): bulk LUFS backfill on startup                       (HOJE)
c8d7ba2 fix(app): wait for Qdrant sidecar before opening Indexer                   (HOJE)
b4c2c92 feat(fluid): canonical Lissajous ghost-cursor injection                    (HOJE)
b89244f feat(fluid): drop shape-image background — fluid is the protagonist        (HOJE)
```

Branch ativo: **main** (fast-forward merge de `feat/volume-normalization`
durante a sessao). Worktree volnorm pode ser deletado.

## Decisoes tomadas

- **Bulk backfill no coordinator existente (vs nova thread/IPC/UI)** | Aproveita infra que ja roda. ~40 linhas vs ~200. Zero novo IPC, zero nova UI. | Descartado: botao explicito no Settings + worker dedicado — over-engineering.
- **Sequencial single-thread no backfill** | CPU footprint previsivel. ~10s/track × 967 = ~1.5h fire-and-forget. | Descartado: paralelismo via rayon — dependencia nova, ganho marginal pro caso uso.
- **Pavel-style schema do nosso advection difere do canonico** | Nosso: `decay = 1.0 + dissipation * dt; result = result / decay` (aditivo). Pavel original: `result *= dissipation` (multiplicativo). Valores 0.995-0.998 do relatorio NAO se traduzem 1:1. | Aceito: calibragem empirica iterativa via YAML hot-reload.
- **Drop renderWithBackground no FluidBackground** | Shape image dimmed 25% pulsando dominava visualmente, mascarava o fluid. Fluid e o protagonista. | Descartado: dimming muito menor (5%) — solucao parcial, hibrido confuso. Outros styles (exoskeleton) seguem usando shape via componente proprio.
- **Pivot X600 oratory-style 16-band → warm-tilt 4-band** | Speaker BT pequeno flat ja e "ligeiramente estridente, graves pouco presentes" (confirmado em ear-test). Filosofia Harman-shifted pra warm: lo-shelf agressivo + tilt down agudos. | Descartado: continuar afinando 16 bandas — 4 iteracoes ja mostraram que problema e estrutural (interpretacao da curva RTINGS), nao calibragem.
- **Fluid stand-alone vs migracao SDF Raymarching agora** | Consolidar fluid primeiro. SDF Raymarching seria ~6-10h dev e quebra arquitetura. | Adiado: avaliar migracao apos calibragem fluid estabilizar.

## Metricas

| Metrica | Valor |
|---------|-------|
| Commits HOJE | 4 |
| Releases dev publicadas | 4 (todas tag `dev` atualizada) |
| Iteracoes calibragem fluid | 7 (v1-v7) |
| Cobertura LUFS antes / depois | 1.6% / **100%** |
| Tracks no Qdrant | 983 |
| Tempo bulk backfill real | ~1.5h |
| Linhas adicionadas no fluid refactor | +120 / -124 |
| Subagentes lancados | 1 (deep-researcher max) |
| Relatorios DR salvos | 1 (319 linhas) |

## Pendencias identificadas

1. **Velocidade da tinta acoplada a intensidade do bass** (alta) — usuario quer trajetoria Lissajous **fixa** (visual estavel) e modulacao audio APENAS via radius+brilho, nao via force injetada. Atualmente `force = baseForce * SPLAT_FORCE/600 * eShaped` — eShaped vai a 1.0 com bass forte = tinta voa. **Acao:** desacoplar force de energy, manter constante baixo (~0.05 do baseForce), modular APENAS radius e color via energy.
2. **Curva cubic (`energy^3`) esmaga energias intermediarias** (alta) — pra energy=0.5 (range tipico), eShaped=0.125 (12.5% da forca). Diferenca entre bass-pesada e bass-light fica imperceptivel. **Acao:** trocar pra quadratica `energy * energy` (energy 0.5 → 0.25, 2× mais responsivo).
3. **HueOffsets sutis demais** (media) — bass=0, mid=0.08, treble=0.16. So 16% do circulo cromatico entre extremos — usuario nao consegue identificar visualmente "essa cor e a do bass". **Acao:** spread pra 0, 0.33, 0.66 (cores complementares no circulo).
4. **Fluid mapping na shape image** (media) — usuario quer que fluid "habite" uma silhueta (chama, simbolo da capa). Ja existe `uShapeMask` no advection, mas com efeito sutil (`maskFactor = 0.7 + mask * 0.3`). **Acao:** intensificar pra `0.2 + mask * 0.8` — fluid "preenche" a forma e dissipa rapido fora.
5. **Migracao SDF Raymarching** (baixa) — relatorio aponta como unica alternativa "2026 premium" viavel em WebGL2/WebKitGTK. ~6-10h dev. Adiado pos consolidacao do fluid Lissajous.
6. **X600 EQ ear-test do warm-tilt** (alta) — preset reordenado em `cmr-auto:~/Downloads/Soundcore-Motion-X600-warm-tilt.json`. Aprovado conceptualmente, nao validado em escuta longa.
7. **YAML hot-reload pra EQ** (media) — discussao adiada. Permitiria iterar bandas EQ via `sed` igual fazemos com fluid params. ~1h dev.
8. **Sidecar Qdrant defunct cosmetico** (baixa) — `[qdrant] <defunct>` aparece nos `ps aux` quando o sidecar tenta subir e ja tem outro Qdrant na porta. Inocuo. Limpeza simples seria gracioso shutdown handling.
