# tauri-plugin-rustify-audio

Camada de playback Android do Rustify Player. A fila e o log de escuta vivem no
Kotlin — são a fonte da verdade enquanto o WebView dorme. Spec:
`docs/superpowers/specs/2026-08-13-android-v0-audio-plugin-design.md`.

```
UI SolidJS ── invoke ──> Plugin Rust (fino) ── JNI ──> AudioPlugin (Kotlin)
                                                          │ MediaController
                                                          ▼
                                            AudioService : MediaSessionService
                                            ExoPlayer + fila nativa + notificação
                                                          │
                                                          ▼
                                            filesDir/play_events.jsonl (append-only)
```

## Registro no app

```rust
// só no Android; o desktop não registra este plugin
tauri::Builder::default()
    .plugin(tauri_plugin_rustify_audio::init())
```

Capability: `"rustify-audio:default"` (libera todos os commands do plugin). Permissões
individuais: `rustify-audio:allow-set-queue`, `allow-play`, `allow-drain-events`, …

O `android/src/main/AndroidManifest.xml` do plugin já declara o `<service>` e as
permissões `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`,
`POST_NOTIFICATIONS` e `WAKE_LOCK` — o manifest merger junta com as do app.

## Contrato IPC

`invoke('plugin:rustify-audio|<command>', args)` — args em camelCase.

| Command | Args | Retorno |
|---|---|---|
| `initialize` | — | `null` (pede POST_NOTIFICATIONS em API 33+) |
| `set_queue` | `items[]`, `startIndex?`, `origin`, `contextId?`, `playNow?` | `null` |
| `play` / `pause` | — | `null` |
| `next` / `previous` | — | `{ moved: bool }` |
| `seek_to` | `positionMs` | `null` |
| `skip_to_index` | `index` | `null` |
| `get_state` | — | `PlaybackState` |
| `get_queue` | — | `QueueSnapshot` |
| `add_items` | `items[]`, `origin`, `contextId?`, `mode` | `QueueSnapshot` |
| `truncate_queue` | `fromIndex` | `QueueSnapshot` |
| `shuffle_upcoming` | — | `QueueSnapshot` |
| `set_repeat_mode` | `mode: 'off'\|'one'\|'all'` | `null` |
| `drain_events` | `afterSeq?` | `{ events: PlayEvent[], lastSeq }` |
| `ack_events` | `uptoSeq` | `null` |
| `set_like` | `trackId`, `liked` | `{ seq }` (linha `like`/`unlike` gravada no journal) |
| `updater_check` | `manifestUrl?` | `{ installed, latest, available, apkUrl, sha256, size, canInstall }` |
| `updater_install` | `url`, `sha256?`, `size?` | `{ status: 'started'\|'needs_permission'\|'busy' }` |

`items[i]`: `{ trackId, uri, title, artist, album, artworkUri?, durationMs }`.

`PlaybackState`: `{ status: 'idle'|'buffering'|'ready'|'ended', index, trackId,
positionMs, durationMs, isPlaying, count }` — `count` é o tamanho da fila
nativa: dá para saber que ela está secando sem lê-la inteira a cada ciclo.

`truncate_queue` descarta a cauda ainda não tocada e **nunca corta a faixa
corrente** (o `fromIndex` é elevado para `currentMediaItemIndex + 1` no Kotlin):
cortar o item que toca pararia o som, que é o oposto da intenção.

`shuffle_upcoming` re-embaralha **só a cauda ainda não tocada** (CMR-218) e
devolve o snapshot novo. Ação one-shot e repetível — não há estado de "shuffle
ligado" nem restauração da ordem. Nunca toca a faixa corrente nem o já tocado;
a cauda é trocada de uma vez por `replaceMediaItems` (atômico frente ao tender
e ao auto-advance). O `QueueMeta` é chaveado por `trackId`, então a origem e o
`contextId` de cada item são preservados na reordenação. Com menos de 2 itens
a seguir é no-op (o snapshot volta igual). Limitação conhecida: o tender decide
o corte do `truncate_queue` a partir de um `get_queue` anterior (dois IPCs); um
shuffle que cai entre os dois reordena a cauda e o corte posicional pode
deslocar uma faixa. Janela de milissegundos, a corrente nunca é cortada —
aceita.

`set_repeat_mode('one')` faz o serviço carimbar `origin: repeat` nas
re-escutas — o sinal v3 trata isso como positivo pleno, e até agora o celular
não emitia esse origin em lugar nenhum.

`QueueSnapshot`: `{ items: QueueEntry[], index }` — `index` `-1` com fila vazia.
`QueueEntry`: `{ trackId, origin, contextId, durationMs }`.

**Origem é por ITEM.** `items[i]` aceita `origin`/`contextId` opcionais que
sobrescrevem os da fila. Enquanto `set_queue` era o único caminho a fila era
homogênea e um escalar bastava; com `add_items` ela fica mista, e uma faixa
posta à mão dentro de uma station é escolha explícita do usuário (peso cheio no
sinal v3), não escuta passiva. Guardar a origem por fila faria o journal mentir
para o motor, silenciosamente. Item com `origin` próprio **não herda o
`contextId` da fila** (`metaMap`): quem sobrescreve a origem manda o contexto
junto — é assim que a linha tocada numa playlist vai (`manual` + pasta no item,
`playlist` na fila para a cauda que o serviço auto-avança).

`add_items` recebe `mode: "next" | "end"` — **nunca um índice**. A posição
concreta é resolvida no Kotlin contra o `currentMediaItemIndex` do player: a
fila é nativa e avança sozinha, então qualquer índice calculado no JS pode
estar velho quando a chamada chega.

`next`/`previous` devolvem `moved: false` quando não há para onde ir (fim ou
começo da fila) — sem isso o botão vira um no-op mudo na interface.

### Resolução dos commands

Todo command resolve **dentro** do lambda do `MediaController`, depois de a
operação acontecer de fato. Operações que chegam antes da conexão ficam na fila
`pending` **com o `Invoke` junto**: se a conexão falhar ou a Activity for
destruída (app tirado dos recentes com o serviço tocando), elas são
**rejeitadas** — nunca descartadas. Descartar deixava a promise do JS pendurada
para sempre, que é a race que pendurou o boot do S24 em 14/08.

`PlayEvent` (chaves **snake_case**, espelhando o payload do desktop):
`{ seq, uuid, event_type: 'track_ended'|'track_skipped'|'like'|'unlike', track_id,
origin, context_id, started_at, timestamp, end_position_ms, duration_ms }`.

`set_like(trackId, liked)` (CMR-220) grava `like`/`unlike` **na mesma linha,
com a mesma forma** — os parsers exigem todos os campos e uma linha inválida
travaria o lote inteiro do sync sem ack. `started_at`/`timestamp` = agora;
`end_position_ms`/`duration_ms` = posição/duração da faixa se ela é a corrente
(controller já conectado), senão `0`/duração do `QueueMeta`; `origin`/`context_id`
vêm **só do próprio item** na fila (faixa fora da fila vai como `manual` sem
contexto — herdar o escalar da fila carimbaria a rodada de outra sessão). Não
usa `withController`: não se sobe o service só para registrar um like. O desktop
faz o last-write-wins por `like_updated_at` em `track_enrichments`.

**`trackId` / `track_id` são String em toda a cadeia.** Os ids do acervo são u64
hash-based; passar por `Number` em JS corrompe qualquer valor acima de 2^53.

**Consumidores Rust (`app.rustify_audio().<cmd>()`) nunca dropam o future sob
timeout.** O `run_mobile_plugin_async` do Tauri resolve a resposta com
`send().unwrap()` num oneshot dentro do callback JNI (`extern "C"`): se o
receiver já morreu, o unwrap panica e o processo aborta. Teto de tempo =
`tauri::async_runtime::spawn(async move { ... })` + `tokio::time::timeout`
sobre o `JoinHandle` (dropar o handle não cancela a task; a resposta tardia é
descartada). Commands novos: `async fn` com `AppHandle<R>` — `State` síncrono
deadlocka a main thread.

## Eventos (best-effort)

```ts
import { addPluginListener } from '@tauri-apps/api/core'
await addPluginListener('rustify-audio', 'state_changed', (s) => { /* PlaybackState */ })
await addPluginListener('rustify-audio', 'track_changed', (s) => {})
await addPluginListener('rustify-audio', 'position', (s) => {})   // tick de 500ms, só tocando
```

Perder esses eventos não perde dado: quem sabe o que foi escutado é o journal.

- `updater_progress` — `{ phase, bytes?, total?, message? }`, `phase` ∈
  `downloading | verifying | installing | confirm_pending | confirming | done | failed`
  (`confirm_pending` = a confirmação chegou com o app invisível; o plugin a
  dispara no `onResume`). Emitido
  pela thread do download e pelo `UpdateInstallReceiver` (status do
  PackageInstaller). Exige `REQUEST_INSTALL_PACKAGES` (manifest do plugin) e o
  toggle "instalar apps desconhecidos" concedido pelo usuário.

## Journal

Uma linha por evento, escrita **pelo service** (transições de faixa) e, para
`like`/`unlike`, **pelo plugin** (`set_like`) — nunca pelo JS — com `fsync`.
Toda linha nasce de `EventJournal.lineOf` (função pura, testada), com os mesmos
10 campos. `seq` é monotônico e persistido; `drain_events(afterSeq)` lê a partir
de um ponto e `ack_events(uptoSeq)` grava a marca d'água e compacta o arquivo.
O `uuid` nasce no Kotlin — é a chave de idempotência do sync (união de conjuntos)
e vira o point id no Qdrant.

Semântica idêntica ao `flush_play_event` do desktop:

- `track_ended` — fim natural (`MEDIA_ITEM_TRANSITION_REASON_AUTO`/`REPEAT`) ou
  `STATE_ENDED` no fim da fila.
- `track_skipped` — troca por seek/next/previous/skipToIndex/nova fila, e
  teardown do service com faixa no ar.
- `like` / `unlike` — gesto do usuário (CMR-220); o anel de recentes e o tender
  ignoram (não é escuta), o desktop roteia para `track_enrichments`.

## Dependências Android

Media3 **1.10.1** — última estável compatível com o Kotlin Gradle Plugin 1.9.25
que o `tauri android init` gera. A 1.11.0 arrasta `kotlin-stdlib:2.2.10`
(metadata `mv=[2,2,0]`), que o compilador 1.9 recusa. Ao subir o projeto Android
para KGP 2.x, dá para ir para a 1.11.0.
