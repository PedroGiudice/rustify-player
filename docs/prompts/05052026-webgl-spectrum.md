# Retomada: Fix Spectrum Sync (WebGL build pronto)

## Contexto rápido

O spectrum visualizer foi migrado pra WebGL2 (GPU rendering) e o data delivery voltou pra emit com subscribe guard. Tudo funciona visualmente mas o **spectrum está ~1 segundo adiantado ao áudio**. O emitter usa `live_running_time_ns()` que lê o pipeline clock diretamente e só emite quando `frame_ts <= clock_position`, mas mesmo assim o visual antecipa o áudio.

A causa provável: o campo `running-time` da mensagem spectrum do GStreamer é o timestamp de quando o buffer **entrou** no spectrum element, não quando o áudio **sai** do sink. A diferença é a latência acumulada entre spectrum element e speaker (sink buffer + PipeWire quantum).

## Arquivos principais

- `src-tauri/crates/audio-engine/src/engine.rs` — SharedMetrics com pipeline_clock, live_running_time_ns()
- `src-tauri/crates/audio-engine/src/output/gstreamer_backend.rs` — running_time_ns(), pipeline_clock(), sink_latency_ms()
- `src-tauri/crates/audio-engine/src/output/spectrum.rs` — parse_message() extrai running-time da msg
- `src-tauri/src/lib.rs:1933` — spectrum-emitter thread com lógica de sync
- `src/components/SpectrumBackground.tsx` — WebGL2 renderer
- `docs/contexto/05052026-webgl-spectrum.md` — contexto completo

## Próximos passos (por prioridade)

### 1. Fix sync: compensar latência do sink
**Onde:** `src-tauri/src/lib.rs`, emitter thread (linha ~1945)
**O que:** Em vez de `ts <= now_ns`, usar `ts <= now_ns - sink_latency_ns`. O `sink_latency_ms` já está no SharedMetrics (populado no cmd_play). Subtrair do clock pra atrasar a emissão pelo tempo que o sink leva pra reproduzir.
**Por que:** O spectrum element vê o áudio ANTES do sink. A diferença temporal é exatamente a latência do sink.
**Verificar:** Tocar música com kick drum proeminente (trance/EDM), verificar visualmente se o pico do spectrum coincide com o transiente audível.

Alternativa se sink_latency não resolver: adicionar logging `tracing::debug!` com `frame_ts_ms`, `clock_ms`, `diff_ms` pra medir o gap real e calibrar um offset fixo.

### 2. Testar estabilidade do WebGL
**Onde:** cmr-auto, app rodando
**O que:** Navegar rapidamente entre views, trocar tracks, ficar 5+ min no Now Playing
**Por que:** Confirmar que WebGL eliminou o freeze e white screen
**Verificar:** Sem force quit, sem tela branca, UI responsiva

### 3. Limpar dead code
**Onde:** `src-tauri/src/lib.rs:66` — `SpectrumConfig::regroup()`
**O que:** Deletar método não usado
**Por que:** Warning de compilação
**Verificar:** `cargo check` sem warnings

## Como verificar

```bash
cargo check --manifest-path src-tauri/Cargo.toml  # sem errors
npx vite build --mode development                  # sem errors
./scripts/release.sh                               # build + publish
# Na cmr-auto:
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.2.1_amd64.deb
```

<session_metadata>
branch: main
last_commit: fb38f51
pending_issue: spectrum 1s ahead of audio
sink_latency_ms_location: SharedMetrics.sink_latency_ms (AtomicU64)
</session_metadata>
