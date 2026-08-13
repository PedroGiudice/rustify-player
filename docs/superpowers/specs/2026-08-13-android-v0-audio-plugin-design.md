# Android v0 — camada de playback: plugin próprio (decisão + design)

**Data:** 2026-08-13
**Status:** aprovado em sessão (delegação do prompt de retomada: "adotar se cobrir
play/pause/seek/queue/eventos; senão, plugin próprio inspirado nele")
**Contexto:** docs/prompts/13082026-rustify-android-v0.md, passo 2

## Decisão

Escrever **plugin Tauri 2 mobile próprio** (`tauri-plugin-rustify-audio`),
usando `uvarov-frontend/tauri-plugin-native-audio` (MIT/Apache-2.0) como
referência de boilerplate — não adotar, não forkar.

## Por que não adotar o tauri-plugin-native-audio

Avaliação completa em 2026-08-13 (fontes: repo, crates.io v1.0.5, código
Kotlin real):

1. **Single-source por design** (modelo audiobook): sem fila, next/previous,
   volume. Com a tela apagada, ao fim da faixa o playback PARA — o
   auto-advance dependeria do JS, que está suspenso. Para player de música é
   gap estrutural, não incremental: fila nativa muda commands, MediaSession,
   notificação e estado. Sobraria pouco das ~840 linhas de Kotlin.
2. **Sem journal de eventos**: o mecanismo dele é um checkpoint ÚNICO em
   SharedPreferences (só o último estado sobrevive) + `trigger()` pro WebView
   — que está suspenso em background. Nosso requisito central (play_events
   completos por transição de faixa) exige journal append-only no service.
3. **Risco de manutenção**: autor único, autodeclarado AI-generated, ~2
   semanas de vida ativa (02/2026–03/2026), dormente desde então, 0 issues
   (nunca testado por terceiros em público).
4. Não há alternativa melhor no ecossistema (awesome-tauri: é o único
   plugin de playback nativo Android listado).

**O que aproveitar dele**: estrutura de plugin mobile Tauri 2 (`android/` +
`build.rs` + permissions + guest-js), wiring `MediaSessionService` +
`PlayerNotificationManager` + singleton de runtime, tick adaptativo de
posição (25ms foreground / 250ms background, só em playing), request de
`POST_NOTIFICATIONS` no initialize (API 33+), checkpoint em SharedPreferences.

## Arquitetura do plugin próprio (v0)

Princípio: **a fila e o log de escuta vivem no Kotlin** — são a fonte da
verdade enquanto o WebView dorme. O JS/Rust é consumidor.

```
UI SolidJS ── invoke ──> Plugin Rust (thin) ── JNI/commands ──> Kotlin
                                                    │
                                     MediaSessionService (FGS)
                                     ExoPlayer + fila nativa
                                     auto-advance + notificação
                                                    │
                                     journal JSONL append-only
                                     (filesDir, evento por transição)
```

### Lado Kotlin

- `MediaSessionService` + Media3/ExoPlayer, foreground service
  (`FOREGROUND_SERVICE_MEDIA_PLAYBACK`), notificação com controles
  play/pause/next/prev, audio focus, `handleAudioBecomingNoisy`.
- **Fila nativa**: lista de itens `{track_id, uri, title, artist, album,
  artwork_uri, duration_ms}` carregada de uma vez pelo JS
  (`set_queue(items, start_index, origin, context_id)`). Auto-advance no
  `STATE_ENDED` sem depender do JS.
- **Journal de eventos** (a razão de ser do v0): a cada transição o service
  appenda uma linha JSON em `filesDir/play_events.jsonl`:
  `{uuid, event_type: track_ended|track_skipped, track_id, origin,
  context_id?, started_at, timestamp, end_position_ms, duration_ms}`.
  Semântica idêntica ao `flush_play_event` do desktop (skip = troca de faixa
  antes do fim; ended = STATE_ENDED natural). UUID nasce AQUI (idempotência
  do sync fase 2 — união de conjuntos por UUID).
- Eventos ao JS (best-effort, UI viva): state changed, position tick,
  track changed. Perder esses não perde dado — o journal é a verdade.

### Lado Rust/JS

- Plugin Rust fino: registra commands, expõe `drain_events(after_offset)` /
  `ack_events(offset)` lendo o journal (mesmo processo, append-only + offset
  torna a leitura segura).
- O flush pro Qdrant (fase 2) monta o payload com
  `build_play_event_payload`-equivalente + carimbo `device_id`/`app_version`/
  `signal_schema` (mesmo contrato do desktop, qdrant_client.rs) e reutiliza o
  UUID do journal como point id.
- `src/store/player.ts` ganha backend Android atrás da mesma interface usada
  pela UI (a fronteira IPC atual em `src/tauri.ts`).

### Fora do v0 (explícito)

Volume nativo (botões físicos resolvem), shuffle inteligente (JS embaralha
antes do set_queue), gapless, EQ/DSP, MPRIS-equivalente além da notificação
Media3, iOS.

## Permissões (manifest do app)

`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`,
`POST_NOTIFICATIONS`, `WAKE_LOCK`, + acesso ao acervo (decisão do passo 3:
manifest exportado do desktop; `MANAGE_EXTERNAL_STORAGE` vs
`READ_MEDIA_AUDIO` a fechar lá).
