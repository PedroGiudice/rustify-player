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
invoke<RadioStart>('lib_radio_start', { id, limit? })  // rádio da faixa — NUNCA vazio
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

`RadioStart`: `{ tracks, layer: 'vector'|'artistFolder'|'library' }`. Só
`lib_radio_start` garante lote não-vazio: `lib_similar_tracks` devolve `[]` para
faixa sem linha no `vectors.bin` (leva nova que ainda não passou pelo MERT), e
antes disso a UI acusava "sem vetores no aparelho" — culpando a configuração por
uma faixa que só era nova. As camadas do fallback são artista → pasta → acervo,
e o `layer` existe para o toast ser honesto sobre o modo degradado. O tender usa
as mesmas camadas: station com pool exaurido vira rádio da faixa corrente em vez
de silêncio.

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

```ts
// Enfileira sem destruir a fila viva. Devolve o snapshot novo.
await invoke('plugin:rustify-audio|add_items', {
  items: [{ ...toQueueItem(t), origin: 'manual', contextId: null }],
  origin: 'manual',
  mode: 'next',   // 'next' = depois da corrente · 'end' = fim da fila
})
```

`origin`/`contextId` são **por item**. Uma faixa enfileirada à mão dentro de
uma station loga `origin: manual` — é escolha explícita do usuário (peso cheio
no sinal v3), não escuta passiva. O desktop ainda carimba por fila nesse caso;
divergência consciente, registrada no plano de paridade.

`add_items` nunca recebe índice: o `mode` é resolvido no Kotlin contra o player.

```ts
// Descarta a cauda (reação a skip numa station). Nunca corta o que toca.
await invoke('plugin:rustify-audio|truncate_queue', { fromIndex })

// off | all | one — 'one' faz o serviço carimbar origin 'repeat'
await invoke('plugin:rustify-audio|set_repeat_mode', { mode: 'one' })
```

`PlaybackState` ganhou `count` (tamanho da fila nativa) — é o gatilho de
"a fila está secando" sem precisar lê-la inteira.

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

## Continuidade (epic B) — a música não para

A UI **arma** o modo; quem decide a próxima faixa é uma thread Rust
(`src-tauri/src/mobile_continuity.rs`), porque o WebView é suspenso com a tela
apagada e não pode ser o dono da decisão.

```ts
// depois do set_queue — o tender só reabastece a fila nova
invoke('continuity_arm', { mode: 'station', stationId, seedTrackId })
invoke('continuity_arm', { mode: 'radio', seedTrackId })   // qualquer outra fila
invoke('continuity_arm', { mode: 'off' })                  // não continuar

invoke('continuity_set_enabled', { enabled })              // toggle do Settings
invoke('continuity_status')                                // diagnóstico

// skip feito DENTRO do app — só por latência (ver abaixo)
invoke('continuity_note_skip', { trackId, positionMs, durationMs })
```

Quem arma o quê (decisão do CEO, 2026-08-17): **ligada por padrão em qualquer
fila**, com duas exceções — a **playlist**, que é coleção curada com começo e
fim e deve terminar (`mode: 'off'`), e a **station**, que já tem o modo de
continuação dela (`mode: 'station'`, pool próprio em vez de rádio semeado).
Faixa avulsa, álbum, shuffle e rádio de faixa continuam.

O tender roda a cada 20s e só age quando a fila **acabou** (`ended`) ou está
**secando** (tocando, a ≤2 posições do fim). Pausa não conta: o usuário pausou
de propósito e reabastecer seria trabalho invisível gastando bateria.

As continuações entram por `add_items(mode: 'end', resumeIfEnded: true)` com
origin **por item**: `station` para station, `autoplay` para o resto. O
`resumeIfEnded` existe porque anexar com o player em `STATE_ENDED` não volta a
tocar sozinho — o item novo ficaria parado depois do fim.

Evento `rustify://queue-changed` avisa a UI para redesenhar a fila. É
best-effort: com o WebView dormindo ele se perde, e o `syncQueue` do resume
cobre.

**Limite conhecido:** o plugin é escopado na Activity. App tirado dos recentes
derruba o `MediaController` e o tender passa a receber erro (não trava — os
invokes são rejeitados desde a correção do `withController`). Tela apagada com
a Activity viva, que é o caso dominante, está coberto.

### Reação ao skip dentro da sessão

Largar uma faixa antes de 35% dela é rejeição (mesmo limiar do desktop). O
tender descarta a cauda ainda não tocada, guarda a faixa como negativo **de
sessão** (some quando a rodada acaba) e pede um lote novo que se afasta dela.

Dois caminhos chegam ao mesmo lugar:

- **App acordado** — `continuity_note_skip` reporta na hora e acorda o tender.
  Existe só por latência; sem ele a fila velha ficaria até 20s na tela.
- **App dormindo** (fone, notificação) — o tender lê o journal do plugin por um
  cursor próprio, a cada ciclo. É o caminho que importa com a tela apagada.

Voltar para a faixa anterior **não** é rejeição. Dentro do app quem filtra é o
`skipReport` do store; pelo journal, o Kotlin marca a linha com `backward: true`
(campo só presente quando verdadeiro; o payload sincado o ignora).

O journal tem dois leitores e só o worker de sync apaga: o ack dele nunca passa
do cursor do tender (`ack_ceiling`), senão uma rejeição em cada seis sumiria em
silêncio — as cadências são 60s contra 20s. Cursor parado há mais de 3 minutos
é tratado como tender morto e o sync solta.

Da cauda, o corte respeita duas coisas: a faixa que toca e o que o usuário
enfileirou à mão. Como o serviço só remove sufixo, o descarte começa depois do
último item que não é do motor — um "tocar em seguida" sobrevive à reação.

## Origins (afetam o sinal do motor — usar os nomes EXATOS do desktop)

| Ação do usuário | origin |
|---|---|
| Tocou uma faixa escolhida | `manual` |
| Play numa playlist/pasta | `playlist` |
| Play num álbum em sequência | `album_seq` |
| Shuffle burro do acervo | `shuffle` |
| Play/next de uma station | `station` |
| Fila continuada pelo motor | `autoplay` (tender, epic B) |
| Re-escuta com repeat-one ligado | `repeat` (carimbado pelo serviço) |

O desconto de origem passiva do behavioral_signals v3 conhece
autoplay/station/playlist — `shuffle` é neutro até decisão em contrário.

## O que NÃO existe no mobile (não desenhar em cima)

Crate (slskd fica na cmr-auto), busca semântica
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
