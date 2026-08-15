# Rustify Android v0 — contrato IPC pra UI mobile

**Data:** 2026-08-13. Fonte da verdade do plugin:
`src-tauri/crates/tauri-plugin-rustify-audio/README.md`. Este doc é o resumo
que a integração da UI (HTML/CSS do claude.design → SolidJS) deve seguir.

## Regras transversais

- **IDs de track são SEMPRE string** (u64 > 2^53 corrompe em `Number`).
- A UI NÃO gerencia avanço de fila: a fila vive no Kotlin (auto-advance com
  tela apagada). A UI *reflete* estado, não o produz.
- Registro de escuta é automático (journal no service + sync worker) — a UI
  não loga nada.
- Capas/arquivos locais: `convertFileSrc(path)` (asset protocol cobre
  `/storage/emulated/0/Music/**`).

## Biblioteca (commands do app)

```ts
invoke<Folder[]>('lib_list_folders')            // playlists = pastas 1º nível
invoke<Track[]>('lib_list_folder_tracks', { name })
invoke<Track[]>('lib_list_tracks')              // acervo inteiro (1746)
invoke<Track[]>('lib_get_tracks_by_ids', { ids: string[] })
invoke<number>('lib_rescan')                    // após novo sync de acervo
```

`Track` (subset do desktop — mesmo shape de `src/tauri.ts`):
`{ id, title, artist_name, album_title, album_cover_path, album_year,
duration_ms, path, lrc_path, track_number, genre_name }`.

`Folder`: `{ name, track_count }`.

## Inteligência local (CMR-190 — desde v1)

Alimentada pelos artefatos de `.rustify/` (export do desktop:
`scripts/android/export_manifest.py`). TODOS opcionais: sem eles os commands
devolvem lista vazia — a UI esconde as seções, nunca quebra.

```ts
invoke<Track[]>('lib_similar_tracks', { id, k? })      // vizinhos mert (default 20)
invoke<StationMeta[]>('lib_list_stations')
invoke<Track[]>('lib_play_station', { id, limit? })    // 1º lote (default 40)
invoke<Track[]>('lib_station_next', {                  // lote incremental
  stationId, excludeIds: string[], limit?,             // default 6
})
invoke<Track[]>('lib_taste_positives')                 // "Based on your favorites"
invoke<LyricLine[]>('lib_get_lyrics', { trackId })     // sidecar .lrc; [] sem letra
```

`LyricLine`: `{ t: number (segundos), line, header }` — mesmo wire do desktop.

`StationMeta`: `{ id, name, icon, tone, desc, kind: 'seed'|'mood', query,
pool_size }`. `pool_size === 0` = station sem candidatos no acervo — mostrar
desabilitada ou esconder.

Play de station: `set_queue(..., origin: 'station', contextId: station.id)` —
o sinal v3 já desconta origem passiva; o evento volta pro desktop via sync.

## Player (plugin rustify-audio)

`invoke('plugin:rustify-audio|<cmd>', args)` — args camelCase.

```ts
await invoke('plugin:rustify-audio|initialize')   // 1x no boot (pede notificação)

await invoke('plugin:rustify-audio|set_queue', {
  items: tracks.map(t => ({
    trackId: t.id,
    uri: 'file://' + t.path,
    title: t.title,
    artist: t.artist_name ?? '',
    album: t.album_title ?? '',
    artworkUri: t.album_cover_path ? 'file://' + t.album_cover_path : null,
    durationMs: t.duration_ms,
  })),
  startIndex: 0,
  origin: 'playlist',        // ver Origins abaixo
  contextId: null,
  playNow: true,
})

await invoke('plugin:rustify-audio|play')          // e pause
await invoke('plugin:rustify-audio|seek_to', { positionMs })
await invoke('plugin:rustify-audio|skip_to_index', { index })
const st = await invoke('plugin:rustify-audio|get_state')
// { status, index, trackId, positionMs, durationMs, isPlaying }

// next/previous devolvem se houve para onde ir — `moved: false` = fim da fila
const { moved } = await invoke('plugin:rustify-audio|next')

// A fila REAL do serviço. A UI não mantém espelho: esta é a verdade.
const q = await invoke('plugin:rustify-audio|get_queue')
// { items: [{ trackId, origin, contextId, durationMs }], index }  (index -1 = vazia)
```

`origin`/`contextId` são **por item** no wire de `get_queue` (hoje o Kotlin
devolve o escalar da fila para todos os itens; o formato já é o definitivo).

Ler a fila é o que sustenta a tela de Queue sobreviver ao WebView reiniciar com
o serviço tocando. O espelho em `localStorage` (`kv-mobile-queue`) **foi
removido** — era uma segunda verdade que divergia exatamente nesse caso.

Eventos (best-effort — perder não perde dado, o journal é a verdade):

```ts
import { addPluginListener } from '@tauri-apps/api/core'
await addPluginListener('rustify-audio', 'state_changed', s => {...})
await addPluginListener('rustify-audio', 'track_changed', s => {...})
await addPluginListener('rustify-audio', 'position', s => {...})  // 500ms, só tocando
```

## Origins (afetam o sinal do motor — usar os nomes EXATOS do desktop)

| Ação do usuário | origin |
|---|---|
| Tocou uma faixa escolhida | `manual` |
| Play numa playlist/pasta | `playlist` |
| Play num álbum em sequência | `album_seq` |
| Shuffle burro do acervo | `shuffle` |
| Play/next de uma station | `station` |
| Fila continuada pelo motor | `autoplay` (ainda sem uso no mobile) |

O desconto de origem passiva do behavioral_signals v3 conhece
autoplay/station/playlist — `shuffle` é neutro até decisão em contrário.

## O que NÃO existe no mobile (não desenhar em cima)

Crate (slskd fica na cmr-auto), autoplay contínuo pós-fila, busca semântica
por texto (exigiria embedder no aparelho — similar/stations são vetor→vetor,
offline), likes com sync (toggle local ainda sem trilho), EQ/DSP/volume por
app (volume = botões físicos), temas YAML.

Já entregue depois da v0: letras (14/08, `lib_get_lyrics` + rail no Now
Playing); beat sync real do bg (14/08, CMR-192 — `SpectrumTap` com FFT do
próprio ExoPlayer, sem `RECORD_AUDIO`); leitura da fila nativa (15/08,
`get_queue`).

Inventário completo do que falta em relação ao desktop, com plano por fase:
`docs/contexto/15082026-diff-mobile-vs-desktop.md` e
`docs/contexto/15082026-plano-paridade-mobile.md`.
