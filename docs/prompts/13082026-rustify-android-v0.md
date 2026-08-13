# Retomada: Rustify Android v0 — tocar + registrar

## Contexto rápido

O Rustify Player (Tauri 2 + SolidJS + workspace Rust) ganha um irmão Android.
Decisão do CEO em 2026-08-13: **v0 = tocar + registrar** — reproduzir o acervo
que JÁ ESTÁ no celular (13G Opus em `/storage/emulated/0/Music`, 1746 faixas,
sincronizado nesta data) e gerar `play_events` carimbados com `device_id`
(infra de proveniência entregue na v0.2.72). SEM motor de inteligência local
no v0 — autoplay ausente ou shuffle simples. Racional: multiplicar os dados de
escuta que validam o motor (régua hoje: n=45, amostra pequena).

O audio-engine desktop NÃO porta (PipeWire/libspa não-opcionais, souvlaki
D-Bus, WebView Android sem MediaSession): a camada de playback é **nova**, em
Kotlin, sobre Media3/ExoPlayer + MediaSessionService (foreground service,
controles de tela de bloqueio, Bluetooth). O Qdrant também não roda em
Android e é dispensável nessa escala — storage local dos eventos em SQLite
(ou JSONL append-only) até o sync. UI: a SolidJS existente entra no shell
Android; em paralelo o CEO itera uma versão mobile da UI com claude.design —
não bloqueia o v0, comece com a UI atual.

Uma frente separada e paralela (NÃO deste escopo): claude.design portando a
UI. Este prompt cobre o APP — shell, plugin de áudio, eventos, sync.

## Arquivos principais

- `docs/contexto/13082026-rustify-android-v0.md` — contexto detalhado da sessão que decidiu isto
- `docs/superpowers/specs/2026-08-13-event-provenance-design.md` — spec da proveniência; seção final esboça a fase 2 (sync = união de conjuntos de play_events, LWW pra enrichments)
- `src-tauri/src/device_identity.rs` — padrão de identidade (slug + device.json imutável); replicar semântica no Android
- `src-tauri/crates/library-indexer/src/qdrant_client.rs` — `Provenance`, `SIGNAL_SCHEMA`, `build_play_event_payload` (pura, portável), `derive_behavioral_signals` (pura — v1, não v0)
- `src-tauri/src/lib.rs` (~linha 100, `flush_play_event`) — semântica dos eventos: track_ended/track_skipped, listen_pct, origin, started_at/timestamp
- `src/` — UI SolidJS; `src/store/player.ts` e `src/tauri.ts` são a fronteira IPC que o Android precisa reimplementar
- `CLAUDE.md` — regras do projeto (release, convenções); seção Motor de inteligência

## Restrições e decisões já tomadas (não relitigar)

- Playback = Media3/ExoPlayer via plugin Kotlin. Avaliar `tauri-plugin-native-audio` (uvarov-frontend) antes de escrever plugin próprio — adotar se cobrir play/pause/seek/queue/eventos; senão, plugin próprio inspirado nele.
- Sem Qdrant no Android. Eventos locais em SQLite/JSONL append-only, mesmo schema de payload do desktop (`build_play_event_payload` é a referência de contrato) + `device_id` do celular.
- `device_id` do S24: slug estável (ex. `s24`), mesmo padrão device.json no data dir do app Android.
- Sync fase 2 = união de conjuntos; transporte a decidir NA SESSÃO (candidatos: endpoint HTTP no app desktop via tailnet — o S24 está na tailnet, 100.84.227.100 —, ou push direto no Qdrant da cmr-auto 127.0.0.1:6333 via túnel/tailscale). Escolher o mais simples que funcione com o celular fora de casa = fila local + flush quando alcançável.
- Áudio local do celular; nenhum streaming. Arquivos em `/storage/emulated/0/Music` (scoped storage: precisa `READ_MEDIA_AUDIO` ou MediaStore API).
- Não tocar no app desktop além do ponto de sync (fase 2 precisa de um receptor).

## Próximos passos (por prioridade)

### 1. Inicializar o projeto Android
**Onde:** raiz do repo (VM já tem SDK + NDK 27.0.12077973 + targets Rust + cargo-tauri; `src-tauri/gen` só tem schemas/)
**O que:** `cargo tauri android init`; confirmar build do shell vazio com a UI atual (`cargo tauri android build --apk` ou dev via `--open` não se aplica — headless: gerar APK debug)
**Por que:** valida toolchain de ponta a ponta antes de qualquer feature
**Verificar:** APK gerado em `src-tauri/gen/android/.../outputs/`; instalar no S24 via `adb install` (celular conectado na cmr-auto — adb via `ssh cmr-auto@100.102.249.9`, scp o APK)

### 2. Spike do plugin de áudio
**Onde:** avaliar `tauri-plugin-native-audio`; decisão documentada em spec curta
**O que:** tocar 1 arquivo opus do /storage/emulated/0/Music com background playback + controles na notificação
**Por que:** é o risco técnico central do v0; tudo mais é conhecido
**Verificar:** áudio continua com tela apagada; controles na tela de bloqueio funcionam

### 3. Biblioteca mínima
**Onde:** novo módulo Rust (ou TS) no app Android
**O que:** scan do Music via MediaStore (pastas de 1º nível = playlists, como no desktop), lista/fila/play na UI SolidJS existente
**Por que:** paridade de navegação com o desktop sem indexer completo
**Verificar:** as 1746 faixas aparecem agrupadas pelas playlists do acervo

### 4. Eventos com proveniência
**Onde:** novo storage local (SQLite via tauri-plugin-sql ou JSONL no data dir)
**O que:** replicar `flush_play_event` (ended/skipped, listen_pct, origin, started_at, timestamp, context_id) + carimbo device_id/app_version/signal_schema
**Por que:** é a razão de ser do v0 — cada escuta vira sinal
**Verificar:** teste unitário do payload contra o contrato de `build_play_event_payload`; eventos persistem entre restarts

### 5. Sync fase 2 (eventos → cmr-auto)
**Onde:** decidir transporte (ver Restrições); receptor no desktop se necessário
**O que:** fila local append-only + flush idempotente (UUID por evento, união de conjuntos); marcar sincronizados
**Por que:** sem isso o perfil bifurca — a régua já lê by_device (aparece sozinho com 2+ devices)
**Verificar:** evento gerado no S24 aparece em `play_events` da cmr-auto com `device_id` do celular; régua mostra breakdown

### 6. Fechamento
**O que:** brainstorming→spec→plano valem para o conjunto (skills superpowers); release/distribuição do APK (sem loja: adb/scp; assinar debug basta pro v0); documentar no CLAUDE.md
**Verificar:** CEO escuta no S24 e a régua da manhã seguinte mostra n crescendo

## Como verificar (smoke do ambiente, antes de começar)

```bash
cd /home/opc/rustify-player
ls $ANDROID_HOME/ndk/          # 27.0.12077973
rustup target list --installed | grep android   # 4 targets
cargo tauri --version
cargo check --manifest-path src-tauri/Cargo.toml   # baseline desktop compila
ssh cmr-auto@100.102.249.9 'adb devices'           # S24 visível (se conectado)
git log --oneline -4           # 786d5af bump 0.2.72 no topo
```

<session_metadata>
branch: main
last_commit: 786d5af
release: v0.2.72 publicada (dpkg na cmr-auto PENDENTE)
phone: SM-S921B via adb na cmr-auto; acervo 13G opus já no celular
</session_metadata>
