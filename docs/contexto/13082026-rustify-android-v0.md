# Contexto: Fundação do sync multi-dispositivo + acervo no celular + decisão do Android v0

**Data:** 2026-08-13
**Sessão:** main (madrugada 00h–04h, autônoma a partir das 02h)
**Duração:** ~4h

---

## O que foi feito

### 1. Investigação: por que "buildar pra Android" NÃO é trivial

CEO propôs port Android assumindo trivialidade (premissa dele, correta: escuta
via Bluetooth, sem DAC — engine de áudio é commodity no celular). Verificado
contra código e fontes externas:

- **Tauri sidecar (`externalBin`) não funciona em Android** (issue tauri#9774
  aberto sem resposta; doc oficial desktop-only). O Qdrant sidecar (91MB,
  `binaries/qdrant` no tauri.conf.json) não sobe → motor inteiro sem storage.
- **Qdrant-servidor não existe pra Android** (issue qdrant#2603 fechado sem
  binário). `qdrant-edge` (crate Apache-2.0 do Vasnetsov) existe mas é beta
  de 8 dias — não é fundação. Irrelevante na prática: índice completo = 12MB
  (1746×1024d lyrics + 1746×768d mert, f32), cosine força-bruta = ~3.1 MFLOP
  — Vec<f32> + SQLite resolve.
- **audio-engine é Linux por construção**: `pipewire`/`libspa` deps
  NÃO-opcionais no Cargo.toml do crate; `pw_capture.rs` (spectrum FFT) é
  PipeWire puro; `souvlaki` com `use_zbus` (MPRIS/D-Bus). Nada compila pra
  Android. WebView Android NÃO implementa MediaSession → sem Kotlin nativo o
  áudio para com a tela apagada. Caminho certo: **substituir** por
  Media3/ExoPlayer via plugin (existe `tauri-plugin-native-audio` de
  uvarov-frontend como referência/candidato).
- Acervo: 92GB FLAC, 1758 arquivos — não cabe nos 128GB do S24.

### 2. Decisão de arquitetura: local-first com sync (não cliente/servidor)

Áudio e decisão-de-tocar são planos independentes; o que sincroniza entre
dispositivos é o LOG de eventos, não áudio nem motor remoto. `play_events` é
append-only com UUID por ponto e `derive_behavioral_signals` é função pura →
sync = união de conjuntos (grow-only set), sem conflito. `track_enrichments`
(mutável) = LWW por campo. `rustify_tracks` não sincroniza (derivado do
acervo local; track_id = hash do arquivo).

### 3. Entregue: proveniência de eventos (v0.2.72, publicada)

Escopo aprovado "só captura" (evento não carimbado = dado irrecuperável; sync
sem segundo dispositivo não tem consumidor). Spec:
`docs/superpowers/specs/2026-08-13-event-provenance-design.md`. Resumo
operacional no CLAUDE.md (seção Motor de inteligência). 268 testes passando.

### 4. Acervo completo transferido pro S24 (overnight, autônomo)

Pasta Music do celular zerada a pedido (492 arquivos/5.8G, incl.
UAPPSettings.txt). 92GB não cabiam → decisão ancorada na premissa Bluetooth:
**acervo inteiro em Opus 192k VBR = 13G** (1746 opus + lossy as-is + .lrc +
capas), verificado por contagem+tamanho case-insensitive: 0 ausentes.
Detalhes, gotchas e scripts: memória `project_phone_sync_pipeline.md` (os 3
incidentes: FLAC 5.1 → `-ac 2`; MediaProvider rejeita `: * ? " < > |` e adbd
trava — `adb reconnect offline` revive; case-collisions fundidas pelo FUSE).
Player recomendado ao CEO: Musicolet (lê .lrc). Escuta via Musicolet é
INVISÍVEL pro motor — sem play_events até o app v0 existir.

### 5. Decisão final: Rustify Android v0 em fases (CEO aprovou)

**v0 = tocar + registrar.** Shell Tauri Android + plugin Kotlin
Media3/ExoPlayer + UI SolidJS existente + `play_events` carimbados
(`device_id` do celular) + sync de eventos (fase 2 da spec). SEM motor local
no v0 (autoplay ausente ou shuffle burro). Racional que destravou: régua
sofre de amostra pequena (n=45, skip 100%); Rustify no bolso MULTIPLICA dados
de escuta que validam o motor, em vez de esperar por ele. Motor local = v1.

Frentes separadas: **claude.design porta a UI mobile** (CEO toca esse loop);
**sessão limpa constrói o app** (plugin, storage, sync).

## Estado dos arquivos (commits já pushados)

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/src/device_identity.rs` | Criado | slug hostname → `device.json` imutável; 4 testes |
| `src-tauri/src/lib.rs` | Modificado | mod device_identity; setup passa device_id + `package_info().version` ao IndexerConfig |
| `src-tauri/crates/library-indexer/src/qdrant_client.rs` | Modificado | `Provenance`, `SIGNAL_SCHEMA=3`, `with_provenance`, `stamp_provenance`, `build_play_event_payload` (pura), índices device_id/signal_schema; 3 testes |
| `src-tauri/crates/library-indexer/src/query.rs` | Modificado | toggle_like grava/limpa `liked_device` |
| `src-tauri/crates/library-indexer/src/lib.rs` | Modificado | IndexerConfig.device_id/app_version; export Provenance |
| `scripts/metrics/autoplay_regua.py` | Modificado | `is_pos_v3()` (schema>=3 OU legado por data), breakdown by_device (aparece com 2+) |
| `docs/superpowers/specs/2026-08-13-event-provenance-design.md` | Criado | spec aprovada; fase 2 (sync) esboçada no fim |
| `CLAUDE.md` | Modificado | bloco Proveniência dos eventos |

Na cmr-auto (fora do repo): `~/phone_sync_encode.py`, `~/phone_push_retry.sh`,
staging idempotente `~/.cache/phone-sync/Music` (13G, mantido pra sync
incremental).

## Commits desta sessão

```
786d5af chore: bump 0.2.72
c2a21dc chore(metrics): registro diário da régua (timer 2026-08-13)
beef3c1 feat(events): proveniência — device_id + app_version + signal_schema em todo evento
2ee8641 docs: spec de proveniência de eventos (device_id + app_version + signal_schema)
```

## Decisões tomadas

- **Local-first com sync, não cliente/servidor**: áudio nunca atravessa rede;
  motor replica por dispositivo; log sincroniza. Descartado: motor remoto
  (mata offline) e streaming (mata a premissa do desktop).
- **Android = substituir audio-engine por Media3/ExoPlayer**, não portar.
  Descartado: GStreamer-Android via Cerbero (dor gratuita vs plataforma).
- **device_id legível** (slug hostname), não UUID: régua legível; colisão em
  parque de 3 máquinas não é risco. Arquivo vence hostname (rename não
  bifurca identidade).
- **signal_schema no evento** mata V3_CUTOFF hardcoded; incrementar a const é
  parte do checklist de mudança de semântica.
- **Acervo inteiro em Opus 192k no celular** > subset FLAC: premissa
  Bluetooth do próprio CEO; A2DP re-encoda tudo.
- **v0 sem motor local**: dados primeiro, inteligência depois.

## Métricas

| Métrica | Valor |
|---|---|
| Celular (S24) | 13G música, 15G livres, 3170 arquivos, media scan ok |
| Índice vetorial (se local) | 12MB f32 / 3MB int8 |
| Régua (2026-08-12) | autoplay skip 100% (n=45) — amostra pequena |
| Toolchain Android na VM | SDK + NDK 27.0.12077973 + 4 targets Rust + cargo-tauri; `tauri android init` NÃO rodado |

## Pendências identificadas

1. **(alta) Instalar 0.2.72 na cmr-auto** — CEO ainda não rodou o dpkg; até
   lá NENHUM evento sai carimbado. `V=0.2.72; gh release download -R
   PedroGiudice/rustify-player -p "rustify-player_${V}_amd64.deb" -D /tmp
   --clobber && sudo dpkg -i /tmp/rustify-player_${V}_amd64.deb`
2. **(alta) Construir Rustify Android v0** — sessão dedicada; prompt de
   retomada em `docs/prompts/13082026-rustify-android-v0.md`.
3. **(média) Validar régua com eventos carimbados** — timer diário 09:00
   cobre sozinho após instalação + uso.
4. **(média) UI mobile via claude.design** — frente do CEO, em paralelo;
   resultado converge pro repo depois.
5. **(baixa) Higiene do acervo: duplicatas de case** — `DJ GBR`/`Dj GBR`,
   2× `I Put a Spell on You` (Nina Simone), `MILKY WAY`/`Milky Way`,
   `Where I'm Meant To Be`/`to Be`, covers duplicadas em 6 álbuns. O FUSE do
   Android fundiu; no desktop seguem como faixas distintas no índice.
6. **(baixa) Sidecars .lrc no celular órfãos de player** — Musicolet lê; se
   CEO não instalar nada, ficam inertes.
```
