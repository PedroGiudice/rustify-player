# Contexto: Spectrum WebGL2 — Config Live + AGC + Density

**Data:** 2026-05-05
**Branch:** main
**Commit base:** 294e77c | Uncommitted: +1086 -307 lines across 17 files

---

## O que foi feito

### 1. PipeWire FFT capture funcionando (herdado da sessao anterior)

Sessao anterior implementou captura via PipeWire monitor (`STREAM_CAPTURE_SINK`). Nesta sessao o usuario confirmou: **funciona, sincronizado, problema resolvido**. Zero trabalho adicional no backend de captura.

### 2. Aumento de densidade e resolucao

| Parametro | Antes | Agora |
|-----------|-------|-------|
| Grid | 100x80 (8.000 verts) | 150x120 (18.000 verts) |
| FFT backend | 1024pt (512 bins) | 2048pt (1024 bins) |
| LOG_BANDS frontend | 128 | 256 |
| Log exponent | 2.5 | 1.5 |
| Shader regions | 7 | 9 (escaladas 0-256) |

### 3. Shader totalmente parametrizado via uniforms

Todos os parametros visuais (strength, multipliers, compression, color) eram constantes hardcoded. Agora sao **uniforms** no shader — mudam em runtime sem recompilacao. 18 uniforms tunáveis + textura RG32F pra regioes.

### 4. Sistema de presets YAML + hot-reload

Modelo identico ao sistema de themes:

```
~/.local/share/rustify-player/spectrum/
├── default.yaml
└── bass-heavy.yaml
```

- Backend: `SpectrumVisualConfig` struct, 4 Tauri commands (list/load/save/watch)
- File watcher via `notify` crate com debounce 500ms
- Frontend escuta `spectrum-config-changed` e recarrega o preset
- Editar o YAML externamente atualiza o visualizer em <2s sem restart

### 5. AGC (Automatic Gain Control) por bin

Normalizacao pre-smoothing dos raw FFT bins: cada bin e dividido pela sua media corrente. Resultado: todas as frequencias contribuem igualmente como baseline. Bass boost e vocal boost no shader sao **relativos a essa baseline equalizada**.

```
raw FFT (backend) → AGC normalize per-bin → log binning → smoothing → upload textura
```

Parametros: `AGC_DECAY = 0.985` (~2s adaptacao), `AGC_FLOOR = 3.0` (minimo pra evitar explosao em silencio).

### 6. Decay absoluto anti-congelamento

Smoothing exponencial assintotico nunca chega a zero — adicionado `smoothed[i] -= 0.5` por frame como floor decay. De 255 a 0 em ~8.5s de silencio.

### 7. Shape flame.png editada

Bordas da imagem tinham brightness 0 (preto puro) → linhas mortas. Gerada versao com gradiente radial que adiciona ~15-18% brightness nas bordas, mantendo forma central.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/src/lib.rs` | Mod | +SpectrumVisualConfig, +4 commands (list/load/save/watch), +notify watcher |
| `src-tauri/Cargo.toml` | Mod | +notify workspace dep |
| `src-tauri/crates/audio-engine/src/output/pw_capture.rs` | Criado (sess anterior) + Mod | FFT_SIZE 1024→2048 |
| `src/components/SpectrumBackground.tsx` | Rewrite | Config via props, uniforms, AGC, decay, regions texture |
| `src/tauri.ts` | Mod | +SpectrumVisualConfig interface, +5 IPC bindings |
| `src/views/NowPlaying.tsx` | Mod | +loadSpectrumPreset, +watchSpectrumPreset, +config prop |
| `src/main.tsx` | Mod | +attachConsole() |

## Decisoes tomadas

- **Uniforms vs #define:** Todos tunáveis sao uniforms (zero recompile). Regioes em textura RG32F (evita array hardcoded no shader).
- **AGC antes do smoothing:** Normalizar raw bins antes de qualquer processamento. Se fosse depois, smoothing ja teria achatado a dinamica.
- **256 LOG_BANDS (nao 512/1024):** Sweet spot — 256 bytes de textura, resolucao suficiente, 1:4 ratio com raw bins permite aggregacao util.
- **Log exponent 1.5:** Mais bins nos mids que 1.8/2.5. Mids ficavam sub-representados.
- **notify crate pra file watch:** Ja estava no workspace (library-indexer usa). Evita polling.

## Pendencias identificadas

1. **Mids/highs ainda sub-representados visualmente** (ALTA) — AGC implementado mas nao testado. O build com AGC esta publicado. Se os logs `bass=X mid=X high=X air=X` no console mostrarem valores comparaveis entre bandas, o AGC funciona e o problema e no shader. Se mid/high forem 0, o problema e no binning.
2. **Spectrum config UI nao implementada** (MEDIA) — Os presets carregam de YAML e hot-reload funciona, mas nao ha sliders/painel na UI. O SpectrumRangesPanel existente so mexe em ranges, nao nos parametros visuais.
3. **Shader cache removido** (BAIXA) — A rewrite do SpectrumBackground removeu o OES_get_program_binary caching. Pode ser re-adicionado mas com uniforms dinamicos o beneficio e menor.
4. **Commit pendente** (MEDIA) — Todas as mudancas estao uncommitted. +1086 -307 lines.
5. **Plano de config live** — `~/.claude/plans/generic-skipping-wirth.md` — tasks 1-4 completas (backend, frontend, bindings, presets). Falta UI panel (task nao criada formalmente).
