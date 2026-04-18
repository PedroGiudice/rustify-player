# Retomada: Rustify Player — audio playback debug + EasyEffects + tech badge

## Contexto rapido

Rustify Player (Tauri 2 + vanilla JS + Rust workspace) tem 4 views novas
(tracks/playlists/history/settings) wiradas + CSS card-grid/home-actions
renderizando. Branch `fix-playback-race-condition` tem Gemini-patch triada
+ correcoes (sample rate fix, cover paths consistentes, reverts seletivos).

**GitHub remote:** https://github.com/PedroGiudice/rustify-player (privado).
Rolling release `dev` com .deb publicado via `scripts/release.sh`. CLAUDE.md
no repo impoe que sempre rode release.sh apos commits.

**3 bugs abertos priorizados:**
1. Audio tocando errado (pitch/velocidade/volume). Sample rate fix commitado
   em f1af547, usuario reportou que nao resolveu. Investigar.
2. Tech badge mostra `undefinedbit / 44.1kHz` — falta campo `bit_depth` em
   `TrackInfo`.
3. Integrar controle de EasyEffects (preset picker MVP). Combinado na
   sessao, nao implementado ainda.

## Arquivos principais

- `docs/contexto/19042026-audio-playback-debug-github-release.md` — contexto completo
- `src-tauri/crates/audio-engine/src/output/cpal_backend.rs` — fix de sample rate aqui
- `src-tauri/crates/audio-engine/src/types.rs` — TrackInfo sem bit_depth; PlaybackState com play_on_load
- `src-tauri/crates/audio-engine/src/decoder.rs` — popular bit_depth aqui (symphonia `codec_params.bits_per_sample`)
- `src-tauri/crates/audio-engine/src/engine.rs` — install_current com play_on_load
- `src-tauri/src/lib.rs` — Tauri commands, emit thread pra `player-state`
- `src/js/components/player-bar.js` — listen + updateTechInfo (bug do bit_depth esta aqui)
- `src/js/views/settings.js` — adicionar preset picker aqui
- `scripts/release.sh` — build .deb + gh release upload (SEMPRE rodar apos commit)
- `CLAUDE.md` — regra do release workflow

## Proximos passos (por prioridade)

### 1. Confirmar estado real do audio playback

**Onde:** rodar o app na cmr-auto e coletar log.
**O que:** verificar se o .deb na release `dev` esta com o fix de sample rate
(commit f1af547) e se `configured system output` log mostra `sr=<source_rate>`
batendo com a rate do arquivo tocado.

**Por que:** usuario reportou persistencia dos sintomas apos pull. Investigacao
incompleta — preciso ver o log antes de teorizar mais.

**Verificar:**
```bash
ssh cmr-auto@100.102.249.9 "rustify-player 2>&1 | grep -E 'configured|sample_rate|ch=' | head -10"
# Esperado: sr=44100 pra track 44.1k, sr=96000 pra 96k
# Se sr=48000 sempre: o fix nao esta no .deb. Rebuildar+rerelease.
# Se sr bate com source e audio ainda errado: problema e outro (channels, buffer, volume).
```

### 2. Fix tech badge (bit depth + sample rate + channels)

**Onde:**
- `src-tauri/crates/audio-engine/src/types.rs` linha ~27 (TrackInfo)
- `src-tauri/crates/audio-engine/src/decoder.rs` (popular bit_depth)
- `src/js/components/player-bar.js` linha ~116 (updateTechInfo)

**O que:**
1. Adicionar `pub bit_depth: Option<u16>` em `TrackInfo`.
2. Em `decoder.rs`, popular de
   `format.tracks()[idx].codec_params.bits_per_sample.map(|b| b as u16)`.
3. Em `player-bar.js`, `updateTechInfo(info)`:
   ```js
   const bd = info.bit_depth ? `${info.bit_depth}bit · ` : "";
   ui.techLine.textContent = `${bd}${info.sample_rate/1000}kHz · ${info.channels === 2 ? "stereo" : `${info.channels}ch`}`;
   ui.techBadge.textContent = "FLAC";
   ```

**Por que:** sem isso o display da qualidade fica inutil (mostra
`undefinedbit / 44.1kHz`).

**Verificar:**
```bash
./scripts/release.sh
# Na cmr-auto:
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb
# Tocar uma track e olhar player-bar: esperado "16bit · 44.1kHz · stereo" (ou 24bit/96kHz).
```

### 3. Preset picker do EasyEffects (MVP)

**Onde:** criar `src-tauri/src/easyeffects.rs`; adicionar commands em `lib.rs`;
UI em `src/js/views/settings.js`.

**O que:**
1. Modulo Rust:
   ```rust
   // list via `easyeffects -p`, parse "Output Presets: A,B,C,..."
   pub fn list_output_presets() -> Result<Vec<String>, String>;
   // via gsettings
   pub fn current_preset() -> Option<String>;
   // via `easyeffects -l NAME`
   pub fn load_preset(name: &str) -> Result<(), String>;
   ```
2. Tauri commands `ee_list_presets`, `ee_current_preset`, `ee_load_preset`
   em `lib.rs`.
3. Em `settings.js`, adicionar secao "Audio FX" com `<select>` populado
   por `ee_list_presets`, valor inicial = `ee_current_preset`, onchange
   chama `ee_load_preset`. Se `easyeffects` nao estiver instalado/rodando,
   secao mostra mensagem informativa e fica desabilitada.

**Por que:** alinhamento com usuario — integracao ativa do EQ, nao passiva.
Combinado na sessao, ainda nao implementado.

**Verificar:**
```bash
./scripts/release.sh
# Abrir Settings na cmr-auto, confirmar dropdown com 18 presets.
# Trocar preset e confirmar via:
ssh cmr-auto@100.102.249.9 "gsettings get com.github.wwmm.easyeffects last-used-output-preset"
```

### 4. 2x clicks pra tocar

**Onde:** `src/js/components/player-bar.js` `playTrack()` + `src-tauri/src/lib.rs` `player_play`.

**O que:** instrumentar com console.log no playTrack pra ver se primeira
invocacao chega. Se chega e audio nao toca: problema no engine (play_on_load
nao transicionando). Se NAO chega: problema no frontend (event listener,
data-track-id missing, etc).

**Por que:** UX — click unico deve tocar. play_on_load foi adicionado
justamente pra isso e usuario relata que ainda nao funciona.

**Verificar:** double-click em track na Library, checar logs (console
devtools do webview + tracing do rustify-player).

### 5. Volume altissimo

**Onde:** `engine.rs:142` (init volume=1.0) + `decode_and_push_one` volume apply.

**O que:** depois de confirmar sample rate fix, testar com volume slider
em 10%. Se altissimo: double-apply de gain (volume aplicado 2x) ou channel
interleaving. Se proporcional: so default volume alto.

**Por que:** correlato ao item 1 (pitch errado pode confundir percepcao de
volume), mas se persistir apos fix de rate, vira bug proprio.

### 6. `duration_ms` no library-indexer (carryover)

**Onde:** `src-tauri/crates/library-indexer/src/metadata.rs`.

**O que:** ler `time_base` e `n_frames` do FLAC ao scan, computar
`duration_ms = n_frames * 1000 / sample_rate`.

**Por que:** Tracks view mostra "—" na coluna Duration. Carryover da sessao
anterior.

## Como verificar ambiente

```bash
# 1. Branch ativa
cd /home/opc/rustify-player && git branch --show-current
# -> fix-playback-race-condition

# 2. Build compila
cargo build --manifest-path src-tauri/Cargo.toml --release 2>&1 | tail -1
# -> "Finished `release` profile ..."

# 3. Testes audio-engine passando
cargo test --manifest-path src-tauri/Cargo.toml -p audio-engine --lib 2>&1 | tail -3

# 4. Release workflow funcional
./scripts/release.sh 2>&1 | tail -3
# -> "[release] done"

# 5. cmr-auto alcancavel
ssh cmr-auto@100.102.249.9 "which rustify-player && which easyeffects"
# -> /usr/bin/rustify-player  /usr/bin/easyeffects
```

## Restricoes / cuidados

- **NAO compilar localmente na cmr-auto** — i5 8th gen leva minutos, VM
  leva segundos. Sempre via `scripts/release.sh` + `gh release download`.
- **SEMPRE rodar `scripts/release.sh`** apos commits que afetam o app.
  Regra em CLAUDE.md do repo.
- **NAO mexer em `Content-Encoding`** pro embed service — usar
  `X-Audio-Encoding` pra evitar Tailscale Serve descomprimir (carryover).
- **NAO atualizar transformers alem de 4.38.2** na VM — MERT quebra
  (carryover).
- **`cpal::SampleRate` e type alias pra u32**, nao tuple struct. Assignment
  direto: `stream_config.sample_rate = u32_value`. (Nao usar
  `cpal::SampleRate(x)`.)
- **`OutputMode::System` e o modo default e unico relevante** — NAO default
  pra BitPerfect, bypassa EasyEffects.
- **Branch `fix-playback-race-condition` ainda nao mergeou em main.**
  Continuar commitando ai. PR quando audio + tech badge + preset picker
  estiverem funcionando.
