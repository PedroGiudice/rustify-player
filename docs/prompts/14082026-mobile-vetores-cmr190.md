# Retomada: Mobile inteligente — vetores locais (CMR-190) + polimento UX

## Contexto rápido

O Rustify mobile v1 está NO S24: UI Solid do design do CEO, boot frio
validado, playback Media3, biblioteca 1746/1746, sync de play_events
funcionando em produção (`lote entregue sent=2 accepted=2` no log).
A missão agora é a INTELIGÊNCIA no aparelho: similar-tracks, stations e
recommendations sem processo sidecar — mais o polimento que muda a
experiência (capas!). O CEO: "tamo PERTO de deixar isso perfeito. Não
arrega agora."

**Leia antes de agir:**
1. `docs/contexto/14082026-mobile-vetores-cmr190.md` — TODOS os números,
   decisões e âncoras de código da missão vetorial (denso, 2 min).
2. Linear **CMR-190** — arquitetura proposta.
3. `docs/contexto/14082026-android-v0-fechamento-ui-mobile.md` — como
   chegamos aqui (se precisar do histórico).

## Próximos passos (por prioridade)

### 1. Pesquisa Qdrant Edge (gate de decisão — pedido explícito do CEO)
**O que:** WebSearch: status do Qdrant Edge em 2026 — GA? crate Rust
embedded com suporte Android/NDK? licença? benchmark/tamanho?
**Decidir:** Edge SÓ se trouxer API/filtros que realmente usemos; o
baseline brute-force (5,4MB de mert, cosine top-K em microssegundos, zero
dependência) é forte. Registrar a decisão no CMR-190 com fontes.
**Verificar:** decisão escrita no issue antes de qualquer código.

### 2. Export ampliado: um trilho, quatro artefatos
**Onde:** `scripts/android/export_manifest.py` (túnel 16333 pré-requisito).
**O que:** além do manifest, exportar pra `/sdcard/Music/.rustify/`:
- `vectors.bin` — mert f32 por track_id (formato decidido no passo 1);
- `taste.json` — snapshot de gosto (molde: `derive_behavioral_signals` em
  `crates/library-indexer/src/qdrant_client.rs`; positives/negatives com
  pesos);
- `stations.json` — pools precomputados por station (rota incremental:
  pools primeiro, re-rank local depois);
- **`covers/`** — capas por álbum (ver passo 4; mesmo rsync/scp do acervo).
**Por que:** derivação pesada fica no desktop; o celular consome arquivos.
**Verificar:** tamanhos no log do script; manifest antigo sem os artefatos
NÃO pode quebrar o app (tolerar ausência em `mobile_library.rs`).

### 3. App: busca vetorial + stations no aparelho
**Onde:** `src-tauri/src/mobile_library.rs` (load), `src-tauri/src/mobile.rs`
(commands), `docs/android/ipc-contrato-v0.md` (estender contrato),
`src/mobile/` (UI — as telas Stations/"Based on your favorites" JÁ têm spec
visual em `docs/design-refs/design_handoff_mobile/`, foram cortadas do v0
só por falta de trilho).
**O que:** cosine top-K em Rust puro (função pura + testes), commands
`lib_similar_tracks(id, k)` e de stations; play de station loga
`origin: station` (o sinal v3 já desconta; volta pro desktop via sync).
**Verificar:** teste unitário do top-K; no aparelho, similar de uma faixa
conhecida retorna vizinhos plausíveis; evento de station no Qdrant.

### 4. Polimento UX — capas (reporte do CEO, 14/08)
**Fato medido:** `find /sdcard/Music -iname '*.jpg'` → **1 arquivo** no
acervo inteiro. O sync de acervo (transcode Opus) nunca levou capas — a UI
mostra o fallback de tom porque não existe imagem no aparelho. Não é bug
da UI (`Cover.tsx` com convertFileSrc + fallback funciona).
**O que:** exportar capas por álbum no trilho do passo 2 (desktop já as
extrai no cache do indexer), resolver o path local em `mobile_library.rs`
(`album_cover_path` → arquivo em `.rustify/covers/` ou cover.jpg da pasta)
e conferir o assetProtocol scope (`/storage/emulated/0/Music/**` cobre).
**Por que:** "coisas pequenas, simples, mas que mudam a experiência" — CEO.
**Verificar:** screenshot da Home com capas reais nos cards de álbum.
**Colher mais itens:** perguntar ao CEO o que mais incomodou no uso real —
ele é o smoke test vivo da v1.

### 5. Residual da sessão anterior (verificação de 30s)
Primeiro play VIA UI nova ainda não observado quando a sessão fechou:
```bash
ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9
curl -s http://127.0.0.1:16333/collections/play_events/points/count \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"must":[{"key":"device_id","match":{"value":"s24"}}]},"exact":true}'
# > 2 = CEO usou a UI e o ciclo completo (UI→journal→sync→Qdrant) está provado
```
A régua diária também mostra (`docs/metrics/regua-latest.md`, breakdown por
device).

## Restrições

- NÃO relitigar: sem processo Qdrant no aparelho; derivação de sinal no
  desktop; sync por união de conjuntos; IDs string no JS.
- Build: `bun run build` MANUAL antes de `cargo tauri android build --debug`
  (VM sempre); `bun install` na main após merge de worktree; sem pipe
  mascarando exit code de build.
- Invokes de boot novos passam por `bootCall` (store.ts) — race do WebView
  frio documentada.
- Wireless adb: tentar parear (CEO topa), mas ele avisa que despareia — 2
  falhas = volta pro cabo sem insistir.

## Como verificar o ambiente

```bash
cd /home/opc/rustify-player && rtk proxy git status      # main limpa
npm run typecheck && npx vitest run 2>&1 | tail -1       # verde
ssh cmr-auto@100.102.249.9 'adb devices'                 # S24 (cabo) ou adb connect
curl -s -m 3 http://100.102.249.9:19878/sync/health      # receptor desktop de pé
```
