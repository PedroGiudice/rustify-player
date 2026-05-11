# Retomada: Volume Norm, Resume, Autoplay, Updater — pos-0.2.6

## Contexto rapido

Sessao publicou 3 releases consecutivas (0.2.4 → 0.2.6) corrigindo:
volume slider que voltava pra 80%, normalizacao de loudness com path duplo
(RG + LUFS) gerando swings brutais, session resume quebrado por truncamento
de IDs em JS Number, in-app updater que reportava "up to date" pegando o .deb
errado, e autoplay com seed dominante demais + behavioral signals fracos.

**Estado atual:** 11 arquivos modificados no working tree, **nao commitados**.
Release 0.2.6 ja foi publicada (`gh release view dev`) e instalada na cmr-auto.
Usuario vai testar autoplay no uso real e reportar.

**Discussao aberta:** background visual do Now Playing precisa subir de nivel.
O "rustify em chamas" pixel-art funciona mas e limitado. Opcoes (A) SDF text,
(B) SDF logo + fluid, (C) spectrum-only, (D) cover art processual. Sem decisao
final — usuario ainda esta avaliando.

## Arquivos principais

- `docs/contexto/11052026-volume-resume-autoplay-updater.md` — contexto detalhado desta sessao
- `src-tauri/src/lib.rs` — autoplay logic (SEED_WEIGHT, long-tail shuffle)
- `src-tauri/crates/library-indexer/src/qdrant_client.rs` — `behavioral_signals()` refinado
- `src-tauri/crates/audio-engine/src/engine.rs` — `compute_rg_gain` → unity
- `src-tauri/src/persistence.rs` — `PersistedState` IDs como String
- `src/components/PlayerBar.tsx` — save/restoreSession sem Number()
- `src/views/Settings.tsx` — slider volume bound ao store
- `src/tauri.ts` — `PersistedState` interface espelha backend
- `scripts/rustify-update.sh` — sort de assets corrigido
- `src/components/SpectrumBackground_V2.tsx` — pipeline atual do bg do Now Playing (3 passes: clear→shape image→spectrum lines)

## Proximos passos (por prioridade)

### 1. Commitar mudancas em commits descritivos
**Onde:** working tree (11 arquivos modificados)
**O que:** dividir em 5 commits granulares:
  - `feat(settings): bind volume slider to player store`
  - `fix(loudness): kill ReplayGain path, LUFS is canonical`
  - `fix(resume): track IDs as strings end-to-end (Number precision bug)`
  - `fix(updater): sort assets by updatedAt, extract version from filename`
  - `feat(autoplay): rebalance seed weight, expand behavioral signals window`
**Por que:** working tree limpo, historico legivel pra eventual blame futuro
**Verificar:** `git log --oneline -6` mostra os 5 + ultimo "feat(indexer): live fs watcher..."

### 2. Esperar feedback do usuario sobre autoplay no uso real
**Onde:** N/A — observacional
**O que:** ele vai testar e reportar se:
  - (c) "tracks completamente off" diminuiu
  - (d) "mesmas 5-10 tracks" diminuiu
  - "nao aprende" virou aprendizado perceptivel
**Por que:** mudancas algoritmicas nao tem teste; eficacia so se ve no uso
**Verificar:** usuario relata percepcao subjetiva apos 1-2 dias

### 3. Decidir caminho do bg do Now Playing
**Onde:** discussao com usuario; provavel alvo `src/components/SpectrumBackground_V2.tsx`
**O que:** escolher entre (A), (B), (C), (D) ou outra direcao
**Por que:** pendencia aberta, usuario insatisfeito com pixel-art atual
**Verificar:** decisao registrada, plano de implementacao escrito

### 4. (Se aplicavel) Generalizar `analyze_file` para nao-FLAC
**Onde:** `src-tauri/crates/library-indexer/src/loudness.rs:43-66`
**O que:** remover filtro `CODEC_TYPE_FLAC`, deixar symphonia decidir o codec
**Por que:** se importar mp3/m4a no futuro, sem isso vira regressao do swing
**Verificar:** `cargo test -p library-indexer` + manual playback de track nao-FLAC

## Como verificar

```bash
# Working tree sem regressao
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3

# Frontend builda
bun run build 2>&1 | tail -3

# Release atual publicada
gh release view dev -R PedroGiudice/rustify-player --json assets \
  | jq '.assets | sort_by(.updatedAt) | reverse | .[0].name'
# Esperado: "rustify-player_0.2.6_amd64.deb"

# Estado real da cmr-auto (versao instalada)
ssh cmr-auto@100.102.249.9 'dpkg -l | grep rustify-player'
# Esperado: "ii  rustify-player  0.2.6  amd64  Player de musica audiofilo - Tauri shell"

# Distribuicao LUFS / RG na biblioteca (sanity check pos-mudanca)
ssh cmr-auto@100.102.249.9 'curl -sS http://localhost:6333/collections/rustify_tracks/points/scroll \
  -H "Content-Type: application/json" \
  -d "{\"limit\":2000,\"with_payload\":[\"lufs_integrated\",\"rg_track_gain\"],\"with_vector\":false}"' \
  | jq '{total: (.result.points|length), has_lufs: ([.result.points[].payload | select(.lufs_integrated!=null)]|length)}'
# Esperado: total ~1096, has_lufs == total
```

## Restricoes

- **Nao compilar localmente** ate ter certeza que nao havera mais edicoes
  (regra do projeto). Acumular mudancas backend+frontend e rodar `release.sh`
  uma unica vez.
- **Nao commitar sem revisar** — mudancas espalhadas por 11 arquivos, dividir
  em commits coerentes por tema.
- **state.json corrompido na cmr-auto ja foi apagado** — primeira save vai
  nascer com schema novo. Nao precisa fazer migracao.
- **Resume so funciona pra sessoes < 6h** (`MAX_AGE_SECS` em `persistence.rs:20`).
  Comportamento intencional.
