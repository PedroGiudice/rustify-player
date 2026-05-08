# Retomada: Debug PipeWire FFT Capture (zeros no output)

## Contexto rapido

O spectrum visualizer WebGL2 foi migrado de GStreamer spectrum element para PipeWire monitor capture + rustfft. A motivacao: o GStreamer spectrum sempre produzia dados 1.3s adiantados ao audio (buffering interno do playbin, confirmado com logs diagnosticos). Com PW capture, o FFT e feito sobre audio que JA saiu do pipeline — inherentemente sincronizado.

A implementacao compila e o frontend recebe frames (1 frame chegou com `len=512 max=0`). O problema: **magnitudes sao todas zero**. O PW capture stream conecta mas nao recebe audio real. Ultimo fix aplicado (nao testado): remover `target.object` e confiar no `STREAM_CAPTURE_SINK=true` pra auto-conectar ao default sink monitor.

## Arquivos principais

- `src-tauri/crates/audio-engine/src/output/pw_capture.rs` — modulo PipeWire capture + FFT (o core do problema)
- `src-tauri/src/lib.rs:1930` — spectrum-emitter thread (simplificado, render-immediate)
- `src/components/SpectrumBackground.tsx` — frontend (render direto, sem ring buffer)
- `docs/contexto/05052026-pipewire-fft-capture.md` — contexto completo
- `docs/superpowers/plans/2026-05-05-pipewire-fft-capture.md` — plano original

## Proximos passos (por prioridade)

### 1. Diagnosticar por que PW capture produz zeros
**Onde:** `src-tauri/crates/audio-engine/src/output/pw_capture.rs`, funcao `pw_capture_loop`
**O que:** Adicionar `tracing::info!` no process callback pra confirmar: (a) callback e chamado, (b) chunk_size > 0, (c) samples nao sao zero. Tambem verificar na cmr-auto com `pw-top` se o node `rustify-spectrum-capture` esta running e recebendo buffers.
**Por que:** Sem saber onde o pipeline quebra (conexao? formato? callback nunca chamado?), nao ha como corrigir.
**Verificar:**
```bash
# Na cmr-auto, com app rodando:
pw-top  # procurar node "rustify-spectrum-capture" — QUAN e RATE devem ser > 0
pw-cli list-objects | grep -A5 "rustify-spectrum-capture"  # confirmar media.class e links
```

Hipoteses a testar:
- `STREAM_CAPTURE_SINK` sem target pode nao funcionar — talvez precise `target.object` apontando pro ID numerico do sink (nao nome do app)
- Formato F32LE pode nao ser aceito — param_changed callback pode nunca disparar
- O process callback pode estar sendo chamado mas com chunk vazio

### 2. Validar formato negociado via param_changed
**Onde:** `pw_capture.rs:142`, callback `param_changed`
**O que:** O callback ja tem `debug!("PW capture negotiated: rate={} channels={}")` — confirmar que dispara. Se nao dispara, o stream nao negociou formato = nao recebe audio.
**Verificar:** Logs no DevTools (ou LogDir em `~/.local/share/rustify-player/logs/`)

### 3. Alternativa: target por node ID do sink
**Onde:** `pw_capture.rs:116`
**O que:** Em vez de confiar no auto-connect, obter o ID do default sink via `pw-cli info 0` (propriedade `default.audio.sink`) e usar como `target.object`.
**Verificar:** `pw-cli info 0 | grep default.audio.sink`

### 4. Slider de delay (escape valve)
**Onde:** `src/components/SpectrumRangesPanel.tsx` (UI) + `SpectrumBackground.tsx` (aplicacao do offset)
**O que:** Slider +-2000ms que adiciona offset ao timestamp de renderizacao. Salva em localStorage.
**Por que:** Se PW capture funcionar mas com leve offset residual, o usuario calibra manualmente.

## Como verificar

```bash
cargo check --manifest-path src-tauri/Cargo.toml  # sem errors
bun run build                                      # sem errors
./scripts/release.sh                               # build + publish
# Na cmr-auto:
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.2.1_amd64.deb
# Verificar PW node:
pw-top  # "rustify-spectrum-capture" deve aparecer com QUAN/RATE > 0
```

<session_metadata>
branch: main
last_commit: 294e77c (uncommitted changes pending)
blocker: PW capture produces all-zero magnitudes
pw_node_status: connects but silent
frontend_status: receives frames, renders correctly when data != 0
logging: tauri-plugin-log configured (Stdout + Webview + LogDir)
</session_metadata>
