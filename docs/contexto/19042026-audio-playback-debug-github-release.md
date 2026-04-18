# Contexto: Audio playback debug + GitHub release workflow + views finalizadas

**Data:** 2026-04-19
**Sessao:** `fix-playback-race-condition`
**Duracao:** ~3h (apos sessao anterior 18/04 de ~8h)

---

## O que foi feito

### 1. Views restantes wiradas (drop-in do Google Stitch)

Substituidos 4 stubs do frontend por views funcionais usando shape real do
library-indexer (`artist_name`/`album_title`/`genre_name`/`track_number`/
`duration_ms` — nao os `artist`/`album`/`genre`/`track_no`/`duration_secs`
que o Stitch assumiu errado).

- `tracks.js` — lista completa (limit 5000), search client-side em
  title/artist/album, double-click toca, right-click enqueue-next, XSS
  escape em innerHTML e atributos
- `playlists.js`, `history.js` — empty-state com `.empty-state` nativa +
  badge "Coming soon" (features nao implementadas no backend)
- `settings.js` — stats via `lib_snapshot` + counts de `lib_list_albums/
  artists/genres`, volume slider (0-1), status pill de embeddings

### 2. CSS card-grid + home-actions

Artists/Albums renderizavam como texto cru (prints do usuario confirmaram).
Adicionadas classes em `components.css` usando so tokens:
`.card-grid`, `.card`, `.card__cover`, `.card__cover--initials`,
`.card__label`, `.card__sub`, `.home-section`, `.home-actions`,
`.home-action*`. Tambem `.search-input`, `.badge--soon`, `.settings-*`,
`.stats-grid`, `.stat-card`, `.status-pill` pras views acima.

### 3. Branch `fix-playback-race-condition` (Gemini + correcoes)

Usuario acionou Gemini em paralelo; Gemini commitou 488da91 ("gemini shit")
com mudancas em 14 arquivos. Triagem do que veio:

**Bom:**
- `play_on_load` no engine (engine.rs + types.rs) — corrige race Load+Play
  enviados em sequencia pelo Tauri. Engine agora defere o Play se chegar
  durante Loading, e transiciona direto pra Playing quando prep completa
- StateUpdate com `#[derive(Serialize, Deserialize)]` + thread spawn em
  `lib.rs` que consome `engine.subscribe()` e emite `player-state` via
  Tauri event. Frontend `player-bar.js` consome via `listen("player-state")`
- `tauri-plugin-fs` + `assetProtocol.scope` pra covers via `convertFileSrc`
- Player-bar reativo: `playTrack(track)` helper, UI updates, tech badge
  (parcialmente quebrada — ver pendencias)

**Ruim / corrigido:**
- cpal `pipewire/pulse/default` preference — no-op no sistema de teste
  (caia em "Default Audio Device"), mas revertido por seguranca
- `cover_path` como String em field `Option<PathBuf>` — nao compilava.
  Revertido pra `Some(lib.cache_dir.join(rel))` (PathBuf)
- Cover path resolution faltando em `lib_search` e `lib_get_track`.
  Adicionado

### 4. Fix critico: sample rate do cpal stream

Bug identificado a partir de sintomas do usuario (96k tocando em meia
velocidade, 44.1 acelerada, volume altissimo):

`configure_system` em `cpal_backend.rs` abria a stream em
`supported.config().sample_rate` (device default = 48kHz no PipeWire),
ignorando a rate do arquivo. Engine escrevia samples em source rate na
stream de 48kHz → DAC consumia em 48kHz → pitch/velocidade shiftava.

Fix: `stream_config.sample_rate = format.sample_rate`. ALSA plugin →
PipeWire resampleia internamente ou muda clock do grafo.

**Status:** usuario reportou que apos pull do .deb os sintomas **continuam**.
Nao verificado se pull efetivamente pegou a .deb do commit f1af547. Log
em run anterior mostrou `sr=44100 ch=2 src_ch=2` correto, sugerindo que
o fix deveria atuar. Investigacao incompleta.

### 5. GitHub remote + rolling release

- Repo criado: https://github.com/PedroGiudice/rustify-player (privado)
- `scripts/release.sh`: builda .deb na VM (rapido — ~25s em 16 vCPU EPYC)
  e publica/atualiza release `dev` via `gh release upload --clobber`
- Comando unico na cmr-auto pra pegar o .deb novo:
  ```bash
  gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
  sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb
  ```
- `CLAUDE.md` no root do repo com regra: sempre rodar `scripts/release.sh`
  apos mudancas que compilam

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/js/views/tracks.js` | Reescrito | list+search+dblclick+contextmenu, shape real |
| `src/js/views/playlists.js` | Reescrito | empty-state + badge "Coming soon" |
| `src/js/views/history.js` | Reescrito | idem |
| `src/js/views/settings.js` | Reescrito | snapshot+counts+volume slider+status pill |
| `src/js/views/home.js` | Modificado (Gemini) | `playTrack()` helper em vez de invoke direto |
| `src/js/views/library.js` | Modificado (Gemini) | idem |
| `src/js/views/albums.js` | Modificado (Gemini) | idem + cover async via convertFileSrc |
| `src/js/components/player-bar.js` | Reescrito (Gemini) | listen+updatePosition+playTrack+updateTechInfo |
| `src/styles/components.css` | Expandido | +card-grid+home+settings-*+search+status-pill (~350 linhas) |
| `src-tauri/src/lib.rs` | Modificado | Library{handle,cache_dir}, emit thread, cover paths, tracing |
| `src-tauri/Cargo.toml` | Modificado | +tauri-plugin-fs, +tracing-subscriber |
| `src-tauri/capabilities/default.json` | Modificado | +fs:allow-read com scope cache |
| `src-tauri/tauri.conf.json` | Modificado | +assetProtocol.scope |
| `src-tauri/crates/audio-engine/src/engine.rs` | Modificado | play_on_load logic |
| `src-tauri/crates/audio-engine/src/types.rs` | Modificado | Loading{play_on_load}, StateUpdate: Serialize |
| `src-tauri/crates/audio-engine/src/output/cpal_backend.rs` | Modificado | stream_config.sample_rate = format.sample_rate |
| `scripts/release.sh` | Criado | build .deb + gh release upload |
| `CLAUDE.md` | Criado | regra do release workflow |
| `new-screens/` | Removido | pasta temp com output da Stitch |

## Commits desta sessao

```
4b6b4df docs: CLAUDE.md com regra de release obrigatoria
045508f chore: release.sh — build .deb na VM + publica como rolling release "dev"
f1af547 fix(audio-engine): request source sample rate when opening cpal stream
eaf4dc1 fix(audio/frontend): revert cpal pipewire preference, resolve cover paths consistently
488da91 gemini shit  (Gemini, nao desta sessao mas processado aqui)
22cfa41 feat(frontend): tracks/playlists/history/settings views wiradas
```

## Decisoes tomadas

- **EasyEffects sera integrado por CLI (`easyeffects -l NAME`)**, nao D-Bus.
  Motivo: D-Bus do EasyEffects na versao instalada so expoe `org.gtk.Actions`
  com actions limitadas (preferences, about, quit, reset — sem LoadPreset).
  CLI funciona: `-p` lista presets, `-l` carrega, `-b` bypass.
  Descartado: D-Bus — API nao existe nessa versao.

- **Escopo MVP do controle EasyEffects: preset picker apenas.**
  Motivo: aligninamento com usuario ("1" = preset picker). Bypass/gain/EQ
  ficam pra depois.
  Descartado: niveis 2 e 3 (enable/disable+gain, full EQ bands).

- **Rolling release `dev` em vez de CI/CD.**
  Motivo: alinhamento com usuario ("script local óbvio"). Setup 2min vs
  30min de GH Actions pra Tauri com cache.
  Descartado: GH Actions — over-engineering pra single-dev.

- **`cpal::SampleRate` e type alias pra u32** (nao tuple struct como
  em versoes antigas). Assignment direto `stream_config.sample_rate = u32`.

- **`OutputMode::System` e o unico modo relevante** (pre-sessao, confirmado).
  Bit-perfect fica de lado pra nao bypassar EasyEffects/EQ do usuario.

## Metricas

| Metrica | Valor |
|---------|-------|
| Build release | ~28s (16 vCPU EPYC) |
| .deb size | 7.4MB |
| Presets EasyEffects na cmr-auto | 18 (todos output, 0 input) |
| Preset atual (GSettings) | `'600 rap dac no bass'` |

## Pendencias identificadas

1. **Audio playback ainda quebrado** (critica)
   Usuario reportou que, apos `gh release download` + `dpkg -i`, pitch/
   velocidade/volume ainda errados. O fix de sample rate esta commitado
   (f1af547) e no .deb da release `dev`. Investigar: (a) confirmar que
   release.sh uploadou o .deb certo (check timestamp do artefato na
   release vs commit time), (b) pedir ao usuario tracing log do app
   rodando (`rustify-player 2>&1 | grep configured`) pra ver o sr=X real,
   (c) se sr negociado != source, problema e cpal-to-ALSA; se sr negociado
   == source mas audio continua ruim, problema e outro.

2. **Tech badge mostra `undefinedbit / 44.1kHz`** (alta)
   `TrackInfo` nao tem campo `bit_depth`. `player-bar.js` faz
   `${info.bit_depth}bit / ${info.sample_rate/1000}kHz` e bit_depth e undefined.
   Fix: adicionar `pub bit_depth: Option<u16>` em `TrackInfo` (types.rs),
   popular em `decoder.rs` a partir de
   `codec_params.bits_per_sample`. Ajustar player-bar.js pra condicionalmente
   mostrar bit_depth.

3. **Controle de EasyEffects via preset picker** (alta — ja combinado)
   Novo modulo `src-tauri/src/easyeffects.rs`:
   - `list_presets() -> Vec<String>` via `easyeffects -p`, parse de
     "Output Presets: A,B,C,..."
   - `current_preset() -> Option<String>` via
     `gsettings get com.github.wwmm.easyeffects last-used-output-preset`
   - `load_preset(name) -> Result<()>` via `easyeffects -l NAME`
   Tauri commands: `ee_list_presets`, `ee_current_preset`, `ee_load_preset`.
   Settings UI: secao "Audio FX" com dropdown, onchange invoca ee_load_preset.

4. **2x cliques pra tocar** (media)
   Usuario reportou que ainda precisa clicar 2x no track. `play_on_load`
   esta no codigo (engine.rs + types.rs). Debugar: primeiro click envia
   Load+Play → se Play chega durante Loading, seta play_on_load=true → quando
   prep completa, install_current transiciona direto pra Playing. Se nao
   funciona: verificar se o Play esta mesmo chegando (talvez playTrack()
   em player-bar.js tenha bug antes do invoke("player_play")).

5. **Volume ridiculamente alto** (alta — pode ser correlato ao item 1)
   Separar de pitch/velocidade: testar com volume slider em 0.1 e ver se
   proporcional. Se ainda altissimo em 0.1, talvez problema de channel
   interleaving ou double-apply de gain. Se proporcional, entao e so
   volume default alto demais (engine inicia com volume=1.0 em engine.rs:142).

6. **Duration nao mostra total correto** (baixa)
   `TrackInfo.duration: Option<Duration>` deve estar populado. Mas o
   player-bar faz `info.duration.secs` que assume struct `{secs, nanos}`.
   Verificar serde serialization de `std::time::Duration` (default = struct
   com secs/nanos, ok) e se `total_frames` no FLAC header esta sendo usado
   em decoder.rs pra computar duration.

7. **View Home sem cover art** (baixa)
   Cards de Albums/Artists usam iniciais placeholder. Covers existem em
   `~/.cache/rustify-player/cover_*.webp`. Albums ja usa `convertFileSrc`
   (Gemini implementou). Artists ainda nao — poderia mostrar cover do
   album mais recente do artista, por ex.

8. **Tracks view: duration mostra `—`** (baixa)
   `library-indexer/src/metadata.rs` nao calcula `duration_ms` ao scan.
   Fix: ler `time_base` e `n_frames` do FLAC e computar. Pendencia carryover
   da sessao anterior.
