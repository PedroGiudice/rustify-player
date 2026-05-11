# Contexto: Volume Norm, Resume, Autoplay, Updater (0.2.4 → 0.2.6)

**Data:** 2026-05-11
**Sessao:** main (3 releases consecutivas)
**Releases publicadas:** 0.2.4, 0.2.5, 0.2.6

---

## O que foi feito

### 1. Settings.tsx — slider de volume bound ao store global

Slider tinha `createSignal(80)` local hardcoded. Voltava pra 80% toda vez que
a view era remontada, ignorando o estado real do player. Agora deriva de
`player.volume` (store) e publica via `setPlayer("volume", vol) + setVolume()`.

### 2. compute_rg_gain — eliminacao do path ReplayGain

Pipeline de loudness tinha **dois caminhos cumulativos**: ReplayGain no master
volume (engine.rs:428) + LUFS norm no DSP bin. RG (ref ~-18 LUFS) e LUFS norm
(target -14 LUFS) so referenciais incompativeis, e 17% da biblioteca tinha RG
tag enquanto 83% nao — comportamento inconsistente.

Como 100% da biblioteca tem `lufs_integrated` no Qdrant, RG virou codigo morto.
`compute_rg_gain` agora retorna `1.0` incondicionalmente. Loudness fica
inteiramente a cargo do `norm_gain` no DSP bin, contra alvo -14 LUFS, clamp ±24 dB.

Distribuicao real da biblioteca (1096 tracks):
- 100% com LUFS, range -33.9 a -1.8 (spread 32 dB)
- 17% com RG, range -14.2 a +5.3

### 3. PersistedState — IDs como String

Resume **nunca funcionou** por bug de precisao de `Number` em JS. Track IDs do
Qdrant sao u64 hashes que frequentemente passam de `Number.MAX_SAFE_INTEGER`
(2^53). Frontend convertia com `Number()` antes de salvar, corrompia (assinatura:
ID termina em zeros), e `libGetTracksByIds` no restore retornava 0 hits.

Mudancas:
- Backend: `PersistedState` campos `track_id`, `queue_ids`, `recently_played` viraram `Option<String>` / `Vec<String>`.
- Frontend: interface `PersistedState` em `tauri.ts` espelha. `PlayerBar.tsx::saveSession`/`restoreSession` removidos todos `Number()` e `String(snap.x)`.
- `state.json` corrompido na cmr-auto foi apagado — primeira save vai nascer com schema novo.

### 4. rustify-update.sh — 3 bugs corrigidos

`check-json` retornava o **primeiro** .deb da lista (`.assets[0]`), que e o
mais **antigo** (0.1.0 de abril). Resultado: app reportava "up to date" mesmo
com versao nova publicada; se forcasse install, baixava o .deb antigo.

Bugs:
1. Linha 62 pegava `.assets[0]` em vez de ordenar por `updatedAt` desc.
2. Linha 72 hardcoda prefixo `0.1.0 · <sha>` em vez de extrair do nome do asset.
3. `cmd_install` usava `gh release download -p '*.deb' | find | head -n 1` — nao deterministico, podia pegar qualquer .deb.

Fix:
- `check-json`: ordena assets por `updatedAt` desc, pega o primeiro, extrai versao do filename via sed `rustify-player_(0.x.y)_amd64.deb`.
- `cmd_install`: resolve nome exato do asset mais recente antes de baixar, passa nome literal pra `gh release download -p`.

### 5. Autoplay — 4 mudancas no algoritmo de recomendacao

Sintomas reportados pelo usuario:
- (a) Repete tracks recentes: raro (exclude_ids OK)
- (b) Mesma vibe/cluster: acontece (esperado por embedding)
- **(c) Tracks completamente off: muito frequente** ← problema principal
- **(d) Mesmas 5-10 tracks: acontece** ← vocabulario estreito
- **"Nao aprende com uso"** ← behavioral_signals fracos

Diagnostico: `SEED_WEIGHT = 20` dominava ~40% do centroide → results presos a
cluster acustico do seed. Caso classico: "Black Friday II → A Tale of 2 Citiez"
(mesma beat).

Mudancas (`lib.rs::lib_autoplay_next` + `qdrant_client.rs::behavioral_signals`):

| Parametro | Antes | Depois |
|-----------|-------|--------|
| `SEED_WEIGHT` | 20 | 4 |
| Positives: scroll window | 100 events | 300 events |
| Positives: `listen_pct` threshold | >= 0.8 | >= 0.9 |
| Positives: filtro qualificador | count >= 1 | count >= 2 OR pct == 1.0 |
| Positives: top distintos | 30 | 25 |
| Positives: peso | 1 + 1 extra se count>=3 | min(count, 5) |
| Negatives: scroll window | 50 events | 200 events |
| Negatives: top distintos | 15 | 30 |
| Recommend fetch | `lim` (5) | 15, shuffle xorshift, truncate(lim) |

Long-tail boost usa Fisher-Yates inline com xorshift PRNG seeded por SystemTime
nanos + track_id. Evitou puxar a crate `rand`.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/views/Settings.tsx` | Modificado | volumePct derivado de player.volume; handleVolumeChange usa setPlayer |
| `src/components/PlayerBar.tsx` | Modificado | save/restoreSession sem Number()/String() |
| `src/tauri.ts` | Modificado | `PersistedState` IDs viraram string |
| `src/store/player.ts` | Sem mudanca | volume init segue 0.78 |
| `src-tauri/src/persistence.rs` | Modificado | track_id/queue_ids/recently_played como String |
| `src-tauri/src/lib.rs` | Modificado | SEED_WEIGHT 4, long-tail shuffle, RECOMMEND_FETCH=15 |
| `src-tauri/crates/audio-engine/src/engine.rs` | Modificado | compute_rg_gain → unity |
| `src-tauri/crates/library-indexer/src/qdrant_client.rs` | Modificado | behavioral_signals refinado |
| `scripts/rustify-update.sh` | Modificado | sort assets desc, extrai versao do filename, install resolve nome exato |
| `src-tauri/Cargo.toml` | Modificado | version 0.2.3 → 0.2.6 |
| `src-tauri/tauri.conf.json` | Modificado | version 0.2.3 → 0.2.6 |
| `src-tauri/Cargo.lock` | Modificado | regenerado por bump de versao |

## Commits desta sessao

Nenhum. Tudo foi feito via release.sh (que builda direto sem commit). Mudancas
estao em working tree, nao commitadas ainda.

## Decisoes tomadas

- **RG morre, LUFS unica fonte**: Como 100% da biblioteca tem LUFS medido,
  manter dois caminhos era complicar sem ganho. | Descartado: usar RG quando LUFS
  ausente — nao acontece na pratica, e mistura referenciais.

- **Clamp LUFS ±24 dB mantido**: Usuario nao quis apertar (proposta era ±12 dB
  com target -16). | Justificativa: "ainda nao avaliei, vamos so com a base".

- **IDs como String end-to-end no PersistedState**: Aceitar quebra de
  compatibilidade do state.json antigo (apagado manualmente). | Descartado:
  serializar u64 como string mas continuar `u64` no tipo Rust com `#[serde(with)]`
  — adiciona complexidade sem ganho, ja que JS Number nao serve mesmo.

- **xorshift inline em vez de crate rand**: Shuffle de 15 elementos nao precisa
  de PRNG forte; manter dep tree pequena. | 11 linhas de codigo vs 1 crate +
  deps transitivas.

- **Branding pixel-art continua, mas e "pobre visualmente"**: Usuario reconheceu
  que o "rustify em chamas" funciona mas e limitado em resolucao e nao reage
  bem ao audio. | Aberta discussao sobre alternativas SDF/procedural; ainda
  nao decidido.

## Metricas

| Metrica | Valor |
|---------|-------|
| Tracks na biblioteca | 1096 |
| Tracks com lufs_integrated | 1096 (100%) |
| Tracks com rg_track_gain | 191 (17.4%) |
| LUFS spread | -33.9 a -1.8 dB |
| Play events totais | 559 |
| Releases publicadas nesta sessao | 0.2.4, 0.2.5, 0.2.6 |
| Build time release | ~52s (release profile) |

## Pendencias identificadas

1. **Background visual do Now Playing** (alta) — usuario quer ir alem do
   "8-bit rustify em chamas". Opcoes discutidas:
   - (A) SDF text mesh da palavra "rustify"
   - (B) SDF logo abstrato + fluid emergence
   - (C) Spectrum como unica camada (sem shape image)
   - (D) Cover art com efeito processual (chromatic aberration, parallax)
   - Tambem mencionado: adicionar segunda imagem por tras da shape image via
     chroma-key (~8 linhas de GLSL no `BG_FRAG_SRC` em
     `src/components/SpectrumBackground_V2.tsx:173-186`).
   Sem decisao final. Usuario inclinado a (A) ou (D) dependendo se branding
   ou musica deve dominar.

2. **LUFS analysis FLAC-only** (baixa) — `library-indexer/src/loudness.rs:43-66`
   so processa FLAC. Hoje irrelevante (biblioteca 100% FLAC), mas se importar
   mp3/m4a/opus no futuro, vai voltar a inconsistencia de loudness. Generalizar
   para qualquer codec Symphonia exige rewrite de `analyze_file`.

3. **Mudancas nao commitadas** (alta) — 11 arquivos modificados no working tree.
   Funcionam (3 releases ja saıram), mas precisam de commits descritivos antes
   de mergear. Sugestao de granularidade:
   - `feat(settings): bind volume slider to player store`
   - `fix(loudness): kill ReplayGain path, LUFS is canonical`
   - `fix(resume): track IDs as strings end-to-end (Number precision bug)`
   - `fix(updater): sort assets by updatedAt, extract version from filename`
   - `feat(autoplay): rebalance seed weight, expand behavioral signals window`

4. **Validar autoplay no uso real** (media) — mudancas de algoritmo nao tem
   teste unitario; eficacia so se ve com 1-2 dias de uso. Usuario vai reportar.

5. **build-metadata/VERSION desatualizado no working tree** (baixa) — release.sh
   regenera no proximo build, mas hoje o arquivo nao reflete 0.2.6. Ignorar
   ate proxima release ou regenerar manualmente.
