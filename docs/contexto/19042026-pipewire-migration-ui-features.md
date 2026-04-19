# Contexto: Migracao PipeWire + UI Features + Audio Debug

**Data:** 2026-04-19
**Sessao:** main (merge de fix-playback-race-condition + 8 commits diretos)
**Duracao:** ~6 horas (continuacao de sessao de 12h anterior)

---

## O que foi feito

### 1. Migracao cpal → pipewire-rs (concluida)
Backend de output do audio-engine substituido. `cpal_backend.rs` (437 LOC) deletado, `pipewire_backend.rs` (527 LOC) criado. Stream usa AUTOCONNECT + MEDIA_ROLE=Music, rate declarado via AudioInfoRaw. ADR documentado em `docs/adr/001-pipewire-native-backend.md`.

### 2. Remoção de OutputMode/DeviceInfo/Jack
Enum `OutputMode` eliminado (BitPerfect descartado como feature, Jack irrelevante). `PipewireBackend::new()` sem parametros. Tauri commands `SetOutputMode` e `list_output_devices` removidos. Decisao de produto: PipeWire decide routing, usuario usa pavucontrol se quiser redirecionar.

### 3. Tech badge (bit_depth)
`TrackInfo` ganhou campo `bit_depth: Option<u32>`, populado via `codec_params.bits_per_sample` do symphonia. Frontend ja renderiza `24bit / 96kHz`.

### 4. Cover art display (fix)
Causa raiz: CSP nao incluia `asset:` protocol, feature `protocol-asset` faltava no Cargo.toml. Adicionado scope com dotfile pattern pra `.cache` no Linux. Player bar cover com `overflow: hidden` + 3.5rem fixo.

### 5. Playback history
Backend: `record_play(track_id)` e `list_history(limit)` em search.rs. Tauri commands: `lib_record_play`, `lib_list_history`. Frontend: history.js real com formatAgo ("3m ago").

### 6. Folder-based playlists
Playlists derivadas da estrutura de pastas em ~/Music. Backend: `list_folders(music_root)` e `list_folder_tracks(music_root, folder)`. Frontend: lista de folders, drill-down pra tracks, queue integration.

### 7. Player bar funcional
Prev/next com queue management (`setQueue` exportado). Seek bar click-to-seek. Re-scan button em Settings wired a `IndexerCommand::Rescan`.

### 8. Fix de sample rate entre tracks
Bug: `install_current()` nao dropava stream ao mudar de sample rate. 96kHz→44.1kHz reutilizava stream antigo = pitch 2.17x. Fix: checa `format_matches()` e dropa stream se formato difere.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/crates/audio-engine/src/output/pipewire_backend.rs` | Criado | 527 LOC, PipeWire nativo |
| `src-tauri/crates/audio-engine/src/output/cpal_backend.rs` | Deletado | — |
| `src-tauri/crates/audio-engine/src/engine.rs` | Modificado | pump 5ms, scratch 8192, stream reconfigure |
| `src-tauri/crates/audio-engine/src/types.rs` | Modificado | +bit_depth, -OutputMode, -DeviceInfo |
| `src-tauri/crates/audio-engine/src/decoder.rs` | Modificado | +bit_depth extraction |
| `src-tauri/crates/library-indexer/src/search.rs` | Modificado | +record_play, +list_history, +list_folders, +list_folder_tracks |
| `src-tauri/crates/library-indexer/src/lib.rs` | Modificado | +IndexerHandle methods, +FolderPlaylist export |
| `src-tauri/src/lib.rs` | Modificado | +music_root, +8 Tauri commands, cover path resolution |
| `src-tauri/tauri.conf.json` | Modificado | CSP, protocol-asset, deb depends |
| `src/js/components/player-bar.js` | Modificado | prev/next/seek, queue, record_play |
| `src/js/views/playlists.js` | Reescrito | Folder-based playlists real |
| `src/js/views/history.js` | Reescrito | Real history view |
| `src/js/views/settings.js` | Modificado | Re-scan button |
| `src/js/views/tracks.js` | Modificado | setQueue integration |
| `src/js/views/albums.js` | Modificado | Cover loading simplificado |
| `src/styles/components.css` | Modificado | Folder list styles, cover overflow fix |

## Commits desta sessao (8 na main apos merge)

```
5b41cfc fix(audio-engine): reconfigure stream on sample rate change between tracks
620d700 fix(audio-engine): reduce pump interval 20ms→5ms, increase decode scratch 4096→8192
902142c fix(audio-engine,frontend): cover art overflow + ring buffer read simplification
00b115d fix(frontend): CSP connect-src includes 'self' for icons.svg fetch
fdd0ef2 feat(frontend,library-indexer): folder playlists + fix cover art display
18acade feat(frontend): prev/next buttons, seek bar, rescan, queue navigation
296e994 feat(library-indexer,frontend): playback history + record plays
865c7cc fix(audio-engine,frontend): tech badge bit_depth + cover paths + embed URL
```

## Decisoes tomadas

- **BitPerfect removido**: EasyEffects nao e negociavel; bit-perfect = perder EQ. CLI flag `--bit-perfect` tambem removido.
- **Folder playlists em vez de CRUD**: Pastas em ~/Music sao playlists implicitas. Sem migration SQLite, sem tabelas novas. Query-time derivation.
- **Default embed URL hardcoded**: `https://extractlab.cormorant-alpha.ts.net:8448` como fallback quando `RUSTIFY_EMBED_URL` nao esta setada. Evita config manual.
- **PUMP_INTERVAL 5ms**: Reduzido de 20ms pra 4x mais oportunidades de decode. Investigacao de crackling em andamento.
- **Agents opus 4.6**: Usuario prefere opus 4.6 exclusivamente pra sub-agentes. Tool enum so aceita "opus" (nao string customizada).

## Metricas

| Metrica | Valor |
|---------|-------|
| Embeddings done | 663/749 |
| Embeddings failed | 86 |
| Covers extraidas | 121/127 albums |
| LOC pipewire_backend.rs | 527 |
| Tauri commands total | 20 |
| Tests audio-engine | 14 passed, 2 ignored |

## Pendencias identificadas

1. **Crackling em sample rates altos** (alta) — persiste em 96/192kHz mesmo sem embed worker. Nao e xrun confirmado (falta log). Hipoteses: unsafe no `as_chunks_mut_layout`, timing do process callback, ou decode I/O latency.
2. **Double-click pra tocar** (media) — `player_play` envia Load+Play em sequencia. play_on_load funciona mas UX e estranha. Pode ser latencia da UI.
3. **86 embeddings failed** (baixa) — verificar logs do embed worker pra causa. Provavelmente tracks corrompidos ou formato inesperado.
4. **Playlists CRUD** (baixa) — folders cobre 90% do caso. CRUD manual e nice-to-have futuro.
5. **tauri-plugin-media (MPRIS2)** (baixa) — media keys do teclado controlando o player. 15 stars, v0.1.1, parcial. Avaliar quando estabilizar.
