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

await invoke('plugin:rustify-audio|play')          // e pause/next/previous
await invoke('plugin:rustify-audio|seek_to', { positionMs })
await invoke('plugin:rustify-audio|skip_to_index', { index })
const st = await invoke('plugin:rustify-audio|get_state')
// { status, index, trackId, positionMs, durationMs, isPlaying }
```

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

Sem `autoplay`/`station` no v0 (não há motor local). O desconto de origem
passiva do behavioral_signals v3 só conhece autoplay/station/playlist —
`shuffle` novo é neutro até decisão em contrário.

## O que NÃO existe no v0 (não desenhar em cima)

Crate (slskd fica na cmr-auto), stations/autoplay, busca semântica, likes
com sync (toggle local ainda sem trilho), EQ/DSP/volume por app (volume =
botões físicos), letras sincronizadas na tela (lrc_path existe — exibição é
fase seguinte), temas YAML.
