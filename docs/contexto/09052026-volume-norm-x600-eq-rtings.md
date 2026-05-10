# Contexto: Volume Normalization MVP + X600 Corrective EQ + Backlog DSP/Visual

**Data:** 2026-05-09
**Sessao:** branch `feat/volume-normalization` (worktree `/home/opc/rustify-player-volnorm`)
**Duracao:** ~3h

---

## O que foi feito

### 1. Volume Normalization MVP (implementado, aguardando release)

EBU R128 LUFS-based normalization integrada ao pipeline. Decisao arquitetural chave: **gain stage post-EQ pre-Limiter (Posicao B)** em vez do tradicional pre-DSP.

Pipeline atual: `decode -> EQ -> norm_gain (volume element) -> Limiter -> Bass Enhancer -> out`.

Subagente `rust-developer` implementou em ~13 min. Subagente `general-purpose` posterior limpou worktree isolation violation deixada pelo primeiro (subagente original escreveu no main em vez do worktree designado; cleanup migrou tudo pro `feat/volume-normalization` em 3 commits atomicos).

**Interface IPC adicionada:**

```rust
// audio-engine/src/types.rs
Command::DspSetNormGainDb(f32),
Command::DspSetNormEnabled(bool),

// app lib.rs
#[tauri::command] async fn norm_set_enabled(...)
#[tauri::command] async fn norm_get_state(...)
```

**Funcao pura central:**

```rust
// audio-engine/src/loudness.rs
pub fn lufs_to_gain_db(lufs: f32, target: f32) -> f32 {
    (target - lufs).clamp(-24.0, 24.0)
}
```

Storage: campo `lufs_integrated: Option<f32>` no payload Qdrant da collection `rustify_tracks`. Lazy backfill via worker thread quando track sem LUFS e tocada.

### 2. X600 Corrective EQ Preset (iterado, em validacao)

Preset paramétrico de 16 bandas pra Soundcore Motion X600 com Spatial+BassUp desligados na caixa. Baseado em **curva RTINGS real** (`docs/x600-curves/rtingscurve.webp`, `rtingscurve2.webp`) que o user produziu mid-sessao — corrigiu diagnoses anteriores erradas (DXOMARK textual era impreciso).

Preset final em `cmr-auto:~/Downloads/Soundcore-Motion-X600-corrective.json` no formato EasyEffects (compatible com `applyFullState` do app).

**Filosofia oratory-style:** valores nao arredondados, todas as 16 bandas com trabalho especifico, mais agressivo que conservador. Wider Q (0.5-1.5) na maioria dos boosts pra robustez vs medicao imprecisa.

Ear-test do user revelou: bass insuficiente, hi-hats fortes — iteracoes em curso. **Limiter desligado** por decisao do user durante teste.

### 3. Subagente Worktree Isolation Lessons

Briefing original tinha premissa errada (assumiu SQLite + rusqlite — projeto migrou pra Qdrant-only ha semanas). Subagente passou ~28 min explorando ate eu mandar `SendMessage` corrigindo.

Segunda falha: subagente escreveu no `/home/opc/rustify-player` em vez do worktree designado `/home/opc/rustify-player-volnorm`. Subagente posterior fez git surgery pra migrar mudancas + commitar atomicos.

**Aprendizado:** verificar premissas (storage backend, tooling) antes de briefar; subagentes podem ignorar `isolation: "worktree"` silenciosamente.

### 4. Deep Research Outputs

Dois relatorios Gemini Deep Research salvos em `/home/opc/deep-research-outputs/`:
- `2026-05-09-fluid-audio-reactive-visualizers.md` (242 linhas) — solucao canonica pra fluid sim audio-reactive (Ghost Mouse com Lissajous, smoothing FFT 0.85-0.92, alocacao por banda)
- DSP spatial sound X600 — transcrito direto na conversa, nao salvou em arquivo (parked: nao emular X600 spatial em software, foco em corrective EQ)

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/Cargo.toml` (workspace) | Mod (volnorm) | +`ebur128 = "0.1"` |
| `src-tauri/crates/library-indexer/Cargo.toml` | Mod (volnorm) | +ebur128 dep |
| `src-tauri/crates/library-indexer/src/loudness.rs` | Novo (volnorm) | `analyze_file` symphonia+ebur128 |
| `src-tauri/crates/library-indexer/src/types.rs` | Mod (volnorm) | `Track::lufs_integrated: Option<f32>` |
| `src-tauri/crates/library-indexer/src/query.rs` | Mod (volnorm) | `payload_to_track` le `lufs_integrated` |
| `src-tauri/crates/library-indexer/src/pipeline.rs` | Mod (volnorm) | LUFS no `build_track_payload` (best-effort) |
| `src-tauri/crates/library-indexer/src/lib.rs` | Mod (volnorm) | `IndexerHandle::set_track_lufs` + `pub mod loudness` |
| `src-tauri/crates/audio-engine/src/loudness.rs` | Novo (volnorm) | `gain_db_to_linear`, `lufs_to_gain_db`, 15 testes |
| `src-tauri/crates/audio-engine/src/lib.rs` | Mod (volnorm) | `pub mod loudness` |
| `src-tauri/crates/audio-engine/src/types.rs` | Mod (volnorm) | `Command::DspSetNormGainDb/DspSetNormEnabled` |
| `src-tauri/crates/audio-engine/src/engine.rs` | Mod (volnorm) | Match arms novos |
| `src-tauri/crates/audio-engine/src/output/dsp.rs` | Mod (volnorm) | `norm_gain` element entre EQ e Limiter, `set_norm_*` |
| `src-tauri/src/lib.rs` | Mod (volnorm) | NormState (AtomicBool), IPC commands, worker thread `loudness-backfill`, hook em `TrackStarted` |
| `src/tauri.ts` | Mod (volnorm) | `normGetState`, `normSetEnabled` |
| `src/views/Settings.tsx` | Mod (volnorm) | Checkbox "Normalizar volume entre faixas" |
| `cmr-auto:~/Downloads/Soundcore-Motion-X600-corrective.json` | Novo | Preset EQ 16-band X600 |
| `docs/x600-curves/rtingscurve.webp` | Novo (untracked main) | Curva RTINGS Frequency Response Accuracy |
| `docs/x600-curves/rtingscurve2.webp` | Novo (untracked main) | Curva RTINGS normalizada |
| `sprites-animations/flames-sprites/.../*.{html,css,json,png,jpg}` | Novo (untracked main) | Demo SitePoint (pixel-art retro flame) — backlog visual |
| `/home/opc/deep-research-outputs/2026-05-09-fluid-audio-reactive-visualizers.md` | Novo (fora repo) | Relatorio Gemini DR fluid sim |

## Commits desta sessao

```
44ab02a feat(library-indexer): LUFS analysis via ebur128 + Qdrant payload field
a13ed73 feat(audio-engine): norm_gain stage + LUFS-to-gain helpers
89671ae feat(app): IPC + Settings toggle for volume normalization
```

(Branch: `feat/volume-normalization` em `/home/opc/rustify-player-volnorm`. NAO pushado, NAO mergeado.)

## Decisoes tomadas

- **Posicao B (gain stage post-EQ pre-Limiter)** | Justificativa: evita stacking de gains positivos quando EQ ja boostou. Em jazz-LUFS-baixo: `+6dB norm + +3dB EQ@200Hz = pumping no limiter`. Em B, EQ opera com headroom maximo, gain final ajusta antes do limiter. | Descartado: Pre-DSP (Spotify-style) — funciona mas briga com EQ agressivo do user.
- **Storage em Qdrant payload** | Projeto migrou pra Qdrant-only ha semanas (commits `fc16c53`, `90354da`). Adicionar `lufs_integrated` no payload e atomico via `set_payload`. | Descartado: SQLite — nao existe mais no projeto.
- **`ebur128` crate** | Reference implementation EBU R128 / ITU-R BS.1770-4. Mesma engine de ffmpeg loudnorm, sox, REW. Determinista, ~5-10s/track CPU. | Descartado: ffmpeg subprocess (overhead fork+IPC), GStreamer `level` (forca pipeline temporario).
- **Calf Bass Enhancer mantido** | LSP nao tem equivalente direto. Calf e o teto LV2 open source pra harmonic bass enhancement. MaxxBass (Waves) seria melhor mas pago/nao distribuivel. | Descartado: TAP-plugins Sub-Bass (abandonado 2010, dated), MB Compressor (mais transparente mas sem harmonic richness).
- **Curva X600 oratory-style (agressiva, nao-arredondada)** | User flagou: oratory funciona porque ousa. Conservador soa "errado ate todas as bandas estarem aplicadas". Q wider (0.5-1.5) na maioria — sem medicao precisa do nosso lado, surgical (Q 3-8) e arriscado. | Descartado: incrementos 0.5dB padrao — esteticamente conservador, tecnicamente impreciso.
- **Wider Q em jaggedness 50-150Hz** | Resposta tem peaks/valleys irregulares (vale -12dB em 70Hz, -8dB em 110Hz) — Q 2.5-3.0 cirurgico nas bandas 1, 2, 3. Risco de ringing aceitavel. | Descartado: Q 1.0 wide — nao captura a granularidade.
- **`limiter.boost: false`** (quando reativar) | `boost: true` e auto-makeup gain — briga com headroom do preamp E com normalizacao LUFS futura (loudness output vira imprevisivel). | Aceito que o user desligou completamente o limiter por ora pra ear-test.
- **NAO emular X600 Spatial Audio em software** | Deep research confirmou: metade do efeito vem do driver up-firing fisico rebatendo no teto. Sem array dedicado ou XTC com sweet spot rigido, e impossivel replicar elevacao virtual em par stereo comum. | Descartado: implementar M/S widening como "Spatial Mode" — gerencia mal expectativa de usuario.
- **Fluid sim parked, multi-stem video como direcao futura** | User rejeitou fluid como "player de 2008". Multi-stem video (5 stems pre-gerados, weighted blend FFT-driven via shader) e direcao mais moderna. | Descartado: fluid sim "fixed" via Ghost Mouse (relatorio salvo pra eventual uso legacy/skin opcional).
- **NAO usar sprite-sheet do SitePoint pra like button** | Sprite e pixel-art lo-fi de 2012, soft-glow ambar — nao casa com flame icon atual (pixel-art monocromatico 12x15 `currentColor`). Animar via SVG path swap ou Lottie seria caminho moderno, mas requer arte nova. | Backlog.

## Metricas

| Metrica | Valor |
|---------|-------|
| Commits no `feat/volume-normalization` | 3 |
| Arquivos modificados na feature | 13 |
| Arquivos novos na feature | 2 |
| Testes unitarios novos (loudness) | 15 |
| `cargo check` no volnorm | Limpo (1.36s) |
| Subagentes lancados | 3 (rust-developer, general-purpose, fluid-research-deep) |
| Subagentes que violaram regra | 1 (rust-developer escreveu fora do worktree) |
| Iteracoes do preset X600 | 4 |
| Bandas EQ no preset final X600 | 16 (todas com trabalho) |
| Preamp final X600 | -5 dB |

## Pendencias identificadas

1. **Release dev rodando** (alta) — `bash scripts/release.sh` em background no volnorm worktree (background ID `b0wv61m6h`). Output em `/tmp/claude-1000/.../tasks/b0wv61m6h.output`. Apos terminar, cmr-auto pull com `gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_*_amd64.deb`.
2. **PR do volnorm** (alta) — `git push -u origin feat/volume-normalization` + `gh pr create` quando user testar release.
3. **X600 EQ ear-test e iteracao** (alta) — preset atual em `cmr-auto:~/Downloads/Soundcore-Motion-X600-corrective.json`. Ultimas reclamacoes: bass insuficiente (mesmo com lo-shelf 100Hz +5.5 e bell 90Hz +3.0), hi-hats fortes (mesmo com notch 7800Hz/8500Hz). Curva RTINGS real mostra problema diferente do diagnostico inicial.
4. **LSP Loudness Compensator** (media) — Fletcher-Munson dinamico. Compensa perda perceptual de bass/treble em volume baixo. Top da lista de plugins LSP a adicionar.
5. **LSP MS Encoder/Decoder** (media) — habilita "Spatial Mode Tier 1" como feature opcional (user pode revisitar — decisao foi NAO implementar agora).
6. **LSP MB Compressor** (baixa) — alternativa pro Calf Bass Enhancer (compressao multibanda <150Hz com makeup +3dB). Mais transparente mas sem harmonic richness.
7. **Multi-stem video bg** (media) — alinhado conceitualmente mas nao implementado. 5 stems visuais pre-gerados (CogVideo/AnimateDiff), weighted blend shader FFT-driven. Substitui fluid sim e WebGL spectrum como bg principal.
8. **Fluid sim refactor** (baixa) — relatorio canonico salvo (`/home/opc/deep-research-outputs/2026-05-09-fluid-audio-reactive-visualizers.md`). Implementacao "Ghost Mouse + Lissajous" parked como opcao "skin retro".
9. **Like button animation** (baixa) — flame icon SVG pixel-art (12x15) precisa de N frames adicionais pra animar. Sprite SitePoint nao casa estilisticamente. Backlog ate ter arte nova ou decisao de redesign.
10. **Limiter ON com `boost: false`** (baixa) — quando user reativar limiter, garantir `boost: false` pra nao brigar com normalizacao.
