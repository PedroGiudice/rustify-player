# Retomada: Crackling Debug + Polish

## Contexto rapido

Migracao do audio backend de cpal para pipewire-rs nativa concluida e validada. Player reproduz audio, covers aparecem, playlists folder-based funcionam, history registra plays, prev/next/seek wirados. Branch main com 8 commits novos apos merge.

Problema aberto principal: **crackling em sample rates altos (96/192kHz)**. Escala com sample rate — 44.1kHz ok, 96kHz leve, 192kHz forte. Nao e do embed worker (testado com `RUSTIFY_EMBED_URL=""`). Nao e mismatch de rate (PipeWire confirma `negotiated rate=96000`). Bug de `install_current` nao reconfigurando stream ao trocar de rate ja foi fixado (`5b41cfc`).

## Arquivos principais

- `src-tauri/crates/audio-engine/src/output/pipewire_backend.rs` — backend PipeWire, process callback (linha ~350), unsafe `as_chunks_mut_layout` (linha ~494)
- `src-tauri/crates/audio-engine/src/engine.rs` — pump loop (linha ~162), PUMP_INTERVAL=5ms, DECODE_SCRATCH=8192
- `src-tauri/crates/audio-engine/src/decoder.rs` — symphonia FLAC decoder
- `docs/contexto/19042026-pipewire-migration-ui-features.md` — contexto detalhado

## Proximos passos (por prioridade)

### 1. Diagnosticar crackling com xrun counter
**Onde:** `pipewire_backend.rs`, process callback (linha ~380)
**O que:** Adicionar log a cada N xruns (ex: a cada 100) pra confirmar se crackling e underrun. Se zero xruns, problema e corrupcao de dados no unsafe.
**Por que:** Sem esse dado, nao sabemos se e throughput (ring buffer esvazia) ou data corruption (unsafe reinterpret errado).
**Verificar:** Tocar 96kHz FLAC 15s com `RUST_LOG=debug`, grep "xrun". Count > 0 = underrun. Count 0 = data bug.

### 2. Se xruns: aumentar pre-buffer antes de Streaming
**Onde:** `pipewire_backend.rs`, apos `stream.connect()` (linha ~434)
**O que:** Antes de reportar boot_tx Ok, esperar ate ring buffer ter pelo menos 200ms de samples. Hoje o stream comeca Streaming imediatamente e o callback puxa de um ring buffer vazio.
**Por que:** Os primeiros callbacks com ring buffer vazio geram silencio que parece crackling.
**Verificar:** Tocar 192kHz, primeiros 2 segundos sem crackling.

### 3. Se data corruption: substituir unsafe por bytemuck
**Onde:** `pipewire_backend.rs`, trait `AsChunksMutLayout` (linha ~494)
**O que:** Adicionar `bytemuck = "1"` ao Cargo.toml, usar `bytemuck::cast_slice_mut` em vez de pointer math manual.
**Por que:** Elimina toda possibilidade de alignment bug no reinterpret u8→f32.
**Verificar:** `cargo test -p audio-engine`, tocar 192kHz sem crackling.

### 4. Investigar 86 embeddings failed
**Onde:** cmr-auto DB, logs do embed worker
**O que:** `sqlite3 ~/.local/share/rustify-player/library.db "SELECT path FROM tracks WHERE embedding_status='failed' LIMIT 10"` — identificar se sao tracks corrompidos.
**Por que:** 663/749 done, 86 falharam. Podem ser tracks sem audio (intros, interludes curtos).
**Verificar:** Re-scan e re-tentar; se mesmo tracks falham, investigar formato.

### 5. Double-click pra tocar
**Onde:** `engine.rs`, `cmd_load` + `cmd_play`
**O que:** Considerar mudar `cmd_load` pra aceitar flag `auto_play: bool` em vez de depender de Load+Play sequenciais.
**Por que:** UX lagada — primeiro click parece nao funcionar.
**Verificar:** Single click toca imediatamente.

### 6. tauri-plugin-media (MPRIS2)
**Onde:** Cargo.toml, src-tauri/src/lib.rs
**O que:** Avaliar `tauri-plugin-media` v0.1.1 pra media keys do teclado.
**Por que:** Play/pause/next via teclas de midia e expectativa basica de um player desktop.
**Verificar:** Tecla play/pause do teclado controla o player.

## Como verificar

```bash
# Build
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -W clippy::all
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml -p audio-engine

# Release
./scripts/release.sh

# Na cmr-auto
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb

# Debug audio
RUST_LOG=debug rustify-player 2>&1 | grep -E "xrun|negotiated|sample_rate|state.changed"
```

<session_metadata>
branch: main
last_commit: 5b41cfc
embeddings: 663 done / 86 failed
tests: 14 passed / 2 ignored
open_bug: crackling at high sample rates
</session_metadata>
