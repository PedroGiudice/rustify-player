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
  `/storage/emulated/0/Music/**` e, por padrão literal à parte,
  `/storage/emulated/0/Music/.rustify/covers/**` — no tauri 2.11 o glob em
  array NÃO casa componente com ponto inicial; ver CLAUDE.md, seção Android).

## Biblioteca (commands do app)

```ts
invoke<Folder[]>('lib_list_folders')            // playlists = pastas 1º nível
invoke<Track[]>('lib_list_folder_tracks', { name })
invoke<Track[]>('lib_list_tracks')              // acervo inteiro (1746)
invoke<Track[]>('lib_get_tracks_by_ids', { ids: string[] })
invoke<Track[]>('lib_recent_plays', { limit? })   // "Recently played" (default 8)
invoke<number>('lib_rescan')                    // após novo sync de acervo
```

`Track` (subset do desktop — mesmo shape de `src/tauri.ts`):
`{ id, title, artist_name, album_title, album_cover_path, album_year,
duration_ms, path, lrc_path, track_number, genre_name, dominant_color,
liked_at, like_updated_at }`
(`dominant_color` = hex `#rrggbb` da capa, enrichment do desktop, `null` sem;
`liked_at`/`like_updated_at` = estado do like semeado pelo manifest, CMR-220 —
epoch em segundos, `null` sem; descurtida no desktop chega como `liked_at: null`
+ `like_updated_at` preenchido. A UI lê o estado EFETIVO por `isLiked()` do
store — manifest x override local `kv-mobile-likes`, o mais novo vence — nunca
`liked_at` cru).

`album_cover_path` (CMR-212): path absoluto já resolvido no Rust
(`resolve_cover`, `mobile_library.rs`), por precedência:

1. `manifest.cover` — `covers/<sha1>.jpg`, relativo a `.rustify/`; UM arquivo
   por álbum-key do desktop (`album_title|artist`, arte embutida primeiro —
   o mesmo `cover_path` do Qdrant, convertido do cache webp pelo `--deploy` do
   `export_manifest.py` em `/storage/emulated/0/Music/.rustify/covers/`).
   Só vale **se o arquivo existir** lá; só o basename do campo é usado.
2. `cover.jpg`/`cover.jpeg`/`cover.png`/`folder.jpg` da pasta da faixa
   (fallback dos tracks sem `cover_path` no desktop e de manifest/export
   antigos — manifest sem `cover` e export sem `covers/` caem aqui).
3. `null`.

A UI não muda: `convertFileSrc(album_cover_path)` como sempre; o Kotlin
recebe `'file://' + album_cover_path` em `artworkUri`.

`lib_recent_plays` (CMR-215): faixas DISTINTAS que **contaram como play**
(`counts_as_play`: fim da escuta ≥ 20s OU ≥ 25% da faixa), da mais recente pra
mais antiga, resolvidas contra o acervo. O anel é lido inteiro, resolvido e só
então cortado em `limit`: o que o manifest não conhece é omitido **sem encolher
a shelf**. É `async`: antes de ler o anel, drena o journal do plugin a partir de
um cursor próprio (só em memória — o `seq` é monotônico por instalação e a
compactação não o reseta; reinstalar/limpar dados zera os dois), best-effort
com teto de 3s e SEM ack (quem compacta é o sync). O drain roda numa task
própria e o teto vale sobre o `JoinHandle` — o future do IPC nunca é dropado
(ver a regra dura em "Player"). Chamar logo depois de `track_changed` já vê a
faixa que acabou de fechar: o service appenda no journal antes de emitir o
evento. O fim da fila NÃO emite `track_changed` — só `state_changed` com
`status: 'ended'`; o store recarrega a shelf também aí, e chamadas concorrentes
(foco + troca + fim) reaproveitam a promise em voo.

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

**Qualidade do lote (B4):** a camada `vector` usa pool DUPLO — vizinhança da
semente ∪ vizinhança do gosto, com a semente entrando no rank como positivo
honorário — em vez da vizinhança pura, que agrupava por timbre e virava "mais
do mesmo álbum" em três faixas. No topo vale o cap de **2 por artista** (o
excedente desce pro fim, nunca é descartado) e ficam de fora as **tocadas dos
últimos 7 dias** (anel `recents.json` no data dir, cap 300, alimentado pelo
journal — worker de sync, tender e `lib_recent_plays`, todos pelo mesmo
`recents_feed_item`; só o que TOCOU entra — linhas `track_ended`/`track_skipped`;
like/unlike, quando entrarem no journal, NÃO viram "tocada" — e lote entregue
que nunca tocou não conta). Se o exclude engolir o acervo inteiro, o último
recurso repete mesmo assim — repetir é melhor que silêncio. O rail
`lib_similar_tracks` continua vizinhança pura (é navegação, não rádio), mas
agora sem os negatives do gosto.

Desde o CMR-215 cada entrada do anel carrega, além de `at` (fim da última
escuta, relógio do TTL do rádio), um `played_at` opcional: início da última
escuta que **contou como play** (≥ 20s ou ≥ 25%; `started_at` da linha, ou
`timestamp` se não houver). É sticky — um skip cedo posterior renova `at` mas
não apaga o play — e é o que a shelf "Recently played" lê (`lib_recent_plays`,
cursor de leitura só em memória). Entradas gravadas antes do campo seguem
válidas pro rádio e ficam fora da shelf. `ids()`/TTL/cap não mudaram.

Play de station: `set_queue(..., origin: 'station', contextId: station.id)` —
o sinal v3 já desconta origem passiva; o evento volta pro desktop via sync.

## Player (plugin rustify-audio)

`invoke('plugin:rustify-audio|<cmd>', args)` — args camelCase.

**Regra dura (lado Rust):** quem chama a API Rust do plugin (`app.rustify_audio()
.<cmd>()`) com teto de tempo NUNCA pode dropar o future sob timeout. O Tauri
resolve o IPC móvel com `send().unwrap()` num oneshot dentro do callback JNI
(`extern "C"`): sem receiver, o unwrap panica e o processo aborta. Padrão:
`tauri::async_runtime::spawn(async move { ... })` e o `tokio::time::timeout`
sobre o `JoinHandle` — dropar o handle não cancela a task; a resposta tardia é
descartada (`lib_recent_plays` e o `call` do tender).

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

// "Embaralhar o restante" (CMR-218): permuta SÓ a cauda depois da corrente e
// devolve o snapshot novo. Sem args — o corte é o índice do próprio player.
const q2 = await invoke('plugin:rustify-audio|shuffle_upcoming')
```

`shuffle_upcoming` é ação **one-shot e repetível** — não há estado de "shuffle
ligado" nem restauração da ordem. Nunca toca a faixa corrente nem o já tocado;
a troca da cauda é atômica no Kotlin (`replaceMediaItems`), então o tender e o
auto-advance não veem fila pela metade. A origem e o `contextId` de cada item
são preservados (meta chaveada por `trackId`) — **não é origin** e não muda o
sinal. Com menos de 2 faixas a seguir é no-op (a UI desabilita o botão via
`canShuffleUpcoming`). A UI **aplica só o snapshot devolvido**, nunca reordena
otimista: uma ordem inventada no JS divergiria da fila nativa.

```ts
// Like/unlike da faixa (CMR-220). Devolve o seq da linha gravada no journal.
const { seq } = await invoke('plugin:rustify-audio|set_like', { trackId, liked: true })
```

`set_like` grava `like`/`unlike` **no mesmo journal e com a mesma forma** da
linha de play_event (10 campos, `EventJournal.lineOf`): os parsers exigem todos
os campos e uma linha inválida travaria o lote inteiro do sync sem ack.
`started_at`/`timestamp` = agora; `end_position_ms`/`duration_ms` = posição e
duração se a faixa é a corrente, senão `0`/duração do `QueueMeta`;
`origin`/`context_id` vêm **só do próprio item** na fila (fora da fila:
`manual`, sem contexto). Não sobe o service (sem `withController`) e **não é
origin** — a fila não muda; anel de recentes e tender ignoram a linha. O sync
leva o payload pelo mesmo builder (proveniência estampada pelo worker) e o
**desktop faz o last-write-wins** por `like_updated_at` em `track_enrichments`.
A UI é otimista (override local, ver `Track` acima) e reverte se o IPC falhar.

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

A exceção da playlist vale para TUDO que refaz a fila a partir dela, não só
para o botão Play. Os cinco caminhos, todos no store (`src/mobile/store.ts`),
armam `off` com a pasta como `contextId` (CMR-211):

| Caminho | Função do store | origin |
|---|---|---|
| Play | `playFolder` | `playlist` |
| Shuffle | `shuffleFolder` | `autoplay` |
| Linha tocada (fila = pasta inteira a partir dela) | `playFolderFrom` | `manual` SÓ na faixa tocada (item); a cauda é `playlist` |
| "Tocar agora" da sheet de uma linha da pasta | `playFolderFrom` | idem: `manual` no item, `playlist` na cauda |
| "Tocar a partir daqui" da sheet | `playFromHere` (`context.playlist`) | `autoplay` |

As telas passam `playlist` só quando a lista É uma playlist (`TrackContext`,
em `types.ts`); álbum, artista, acervo e a shelf de recentes ficam no default
(`radio`, sem contexto). Com o default o tender anexava lotes do acervo inteiro
a 2 posições do fim e a sessão virava "shuffle geral".

Na linha tocada a origem é **por item**: `set_queue` vai com `origin:
'playlist'` na fila e `{ origin: 'manual', contextId: <pasta> }` só no item
`startIndex` (`playList(..., headOrigin)`). Só a faixa que o usuário escolheu
tem peso cheio no sinal v3; o que o Kotlin auto-avança depois dela é escuta
passiva (`playlist`, desconto 0.6) — paridade com o desktop (head `manual` +
continuações `playlist`). A fila inteira como `manual` (comportamento anterior)
dava peso cheio a faixas que ninguém escolheu. Gotcha do `metaMap` do Kotlin:
item com `origin` próprio **não herda o `contextId` da fila** — o contexto vai
explícito no item.

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

## Atualização (plugin rustify-audio — desde v0.2.76)

```ts
const v = await invoke('app_version')                     // "0.2.76" (offline)
const c = await invoke('plugin:rustify-audio|updater_check', { manifestUrl: null })
// { installed, latest, available, apkUrl, sha256, size, canInstall }
// rejeita sem rede / manifest inválido — no boot é silencioso, no botão vira toast
const r = await invoke('plugin:rustify-audio|updater_install',
  { url: c.apkUrl, sha256: c.sha256, size: c.size })
// { status: 'started' | 'needs_permission' | 'busy' }
// needs_permission: o Kotlin já abriu a tela do sistema; re-tocar depois.
// progresso: addPluginListener('rustify-audio', 'updater_progress', ev)
// ev = { phase: 'downloading'|'verifying'|'installing'|'confirm_pending'|'confirming'|'done'|'failed',
//        bytes?, total?, message? }
```

A decisão `available` é do Kotlin (semver contra o `versionName` instalado).
"done" raramente chega: a instalação reinicia o processo.

## Origins (afetam o sinal do motor — usar os nomes EXATOS do desktop)

| Ação do usuário | origin |
|---|---|
| Tocou uma faixa escolhida | `manual` |
| Play numa playlist/pasta | `playlist` |
| Linha tocada numa playlist | `manual` na faixa tocada (por item); a cauda auto-avançada é `playlist` |
| Play num álbum em sequência | `album_seq` |
| Shuffle burro do acervo | `autoplay` (sequência escolhida pela máquina) |
| "Tocar a partir daqui" (faixa segurada + cauda embaralhada) | `autoplay` |
| Play/next de uma station | `station` |
| Fila continuada pelo motor | `autoplay` (tender, epic B) |
| Re-escuta com repeat-one ligado | `repeat` (carimbado pelo serviço) |

O desconto de origem passiva do behavioral_signals v3 conhece
autoplay/station/playlist. **`shuffle` não existe mais como origin** (B5): o
valor estava fora do vocabulário do motor e entrava com peso CHEIO no saldo —
decisão do CEO no plano: mapear no mobile para `autoplay`, sem mexer em dado já
gravado. O tipo `Origin` do frontend não aceita mais o literal.

O tender também respeita o repeat: com `one` ou `all` ligado a fila nunca seca
(o loop é deliberado) e o top-up fica quieto — `repeatMode` chegou ao
`PlaybackState` do plugin para isso.

## O que NÃO existe no mobile (não desenhar em cima)

Crate (slskd fica na cmr-auto), busca semântica
por texto (exigiria embedder no aparelho — similar/stations são vetor→vetor,
offline), EQ/DSP/volume por app (volume = botões físicos), temas YAML.

Já entregue depois da v0: letras (14/08, `lib_get_lyrics` + rail no Now
Playing); beat sync real do bg (14/08, CMR-192 — `SpectrumTap` com FFT do
próprio ExoPlayer, sem `RECORD_AUDIO`); leitura da fila nativa (15/08,
`get_queue`); auto-update (26/08, spec 2026-08-24 — updater_check/updater_install +
Settings > Atualização); shuffle do restante da fila (26/08, CMR-218 —
`shuffle_upcoming` + botão nos controles do Now Playing); like com sync (26/08,
CMR-220 — `set_like` + coração no cabeçalho do Now Playing; estado semeado pelo
manifest, reexportar após release).

Inventário completo do que falta em relação ao desktop, com plano por fase:
`docs/contexto/15082026-diff-mobile-vs-desktop.md` e
`docs/contexto/15082026-plano-paridade-mobile.md`.
