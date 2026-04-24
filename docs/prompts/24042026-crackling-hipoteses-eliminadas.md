# Retomada: Crackling — teste de isolamento da engine

## Contexto rapido

Crackling persiste APENAS no rustify. `pw-play` toca a mesma FLAC limpo atraves da mesma cadeia (graph + EasyEffects + HA01 USB DAC). Hipoteses H1-H7 eliminadas (intersample peaks, EE, volume, xrun, quantum, F32LE/S32LE, SCHED_FIFO). Ultimo build: `cd87138` com SCHED_FIFO desabilitado na pump thread — user confirmou que crackling persistiu.

Divergencia arquitetural vs pw-play: rustify usa **pump thread + rtrb ring + callback consumindo da ring**; pw-play faz **decode-on-demand dentro do callback**. Antes de refatorar 500 linhas, rodar teste de isolamento com o example `play_file` da audio-engine (usa a engine exatamente como o Tauri usa, mas zero webkit/Tauri/MPRIS).

## Arquivos principais

- `docs/contexto/24042026-crackling-hipoteses-eliminadas.md` — contexto completo desta sessao
- `docs/plans/nenhum-tempo-basicamente-duas-compressed-emerson.md` — pipeline doc + diagnostico
- `src-tauri/crates/audio-engine/examples/play_file.rs` — CLI que usa a engine sem Tauri
- `src-tauri/crates/audio-engine/src/output/pipewire_backend.rs` — callback, telemetria, format negotiation
- `src-tauri/crates/audio-engine/src/engine.rs` — pump loop, SCHED_FIFO disabled

## Proximos passos

### 1. Teste de isolamento (play_file standalone)
**Onde:** VM build + cmr-auto execution
**O que:**
```bash
# Na VM
cd /home/opc/rustify-player
cargo build --release --manifest-path src-tauri/Cargo.toml -p audio-engine --example play_file
scp src-tauri/target/release/examples/play_file cmr-auto@100.102.249.9:/tmp/rustify-play_file
# No cmr-auto
RUST_LOG=info /tmp/rustify-play_file <path-para-flac-que-crackla> 2>&1 | tee /tmp/play_file.log
```
**Por que:** isola a audio-engine de tudo que Tauri/webview/IPC adiciona.
**Verificar:** user reporta audivelmente se crackling aparece. Log pode ser puxado via scp de volta.

### 2. Branching decisao

| Resultado | Acao |
|---|---|
| play_file crackla | Culpa confirmada na engine. Abrir branch `refactor/callback-decode-inline`, migrar de pump+ring pra decode-on-demand no process callback do PipeWire. Remove rtrb, remove pump thread. ~300-500 linhas. |
| play_file limpo | Culpa NAO e da engine. Investigar: (a) webkit2gtk CPU pressure no processo, (b) Tauri IPC/MPRIS/D-Bus hooks interferindo na engine thread, (c) scheduler da VM vs cmr-auto. |

## Como verificar ambiente

```bash
cargo check --manifest-path /home/opc/rustify-player/src-tauri/Cargo.toml
# Ultimo commit:
git -C /home/opc/rustify-player log --oneline -1    # cd87138
# Branch:
git -C /home/opc/rustify-player branch --show-current  # main
```

## Restricoes

- **Nao compilar em loop.** Acumular todas as mudancas antes de `release.sh`.
- **Nao comecar refactor da engine antes de ter resultado do play_file.** User explicitamente: "Fazemos em branch separado" — condicional.
- **SCHED_FIFO permanece desabilitado** ate decisao final. Se decidir reabilitar, testar rtprio 5-10 em vez de 50.
- Instalar .deb na cmr-auto via `gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb`.
