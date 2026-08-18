# Plano: paridade Android ↔ Desktop no Rustify Player

**Data:** 2026-08-15
**Base:** `docs/contexto/15082026-diff-mobile-vs-desktop.md` (200 itens de gap verificados)
**Método:** 10 planejadores (Opus, effort high), um por epic, lendo o código real das âncoras;
2 críticos independentes (Opus, effort xhigh) verificaram cada fase contra o código.
Resultado da crítica: **1 bloqueador, 30 graves, 20 ajustes** — todos incorporados abaixo.

**Escopo total:** 60 fases, ~330h de sessão após as recotações da crítica (294h eram a
estimativa original dos planejadores; quatro fases estavam subdimensionadas e foram
recotadas). Não é para ser feito de uma vez — a ordem abaixo existe para que cada onda
entregue valor observável no aparelho.

---

## Fase 0 — o que precisa acontecer antes de qualquer epic (~6h)

Estes quatro itens não pertencem a nenhum epic e travam vários. São o preço de entrada.

### 0.1 — `withController` descarta invokes na falha (BLOQUEIA A, B, C, H)

`AudioPlugin.kt:273-281`: quando o `MediaController` ainda não está conectado, `withController`
apenas **enfileira** a closure. Se a conexão falhar (`AudioPlugin.kt:263-267`) ou a Activity for
destruída (`releaseController()`, `AudioPlugin.kt:283-289`), a fila `pending` é limpa e o
`invoke` **nunca é resolvido nem rejeitado** — a promise do JS pendura para sempre.

Hoje isso é invisível porque os commands existentes são fire-and-forget. No minuto em que
existir `get_queue` (que a UI **aguarda**), vira o boot pendurado de novo — o mesmo bug que
custou uma sessão em 14/08 e foi mitigado com `bootCall`.

**Correção:** `pending` passa a guardar o `Invoke` junto da closure; no catch da falha de
conexão e em `releaseController()`, chamar `invoke.reject("controller indisponivel")`.
Sem isso, todo command novo do plugin nasce com o mesmo defeito latente.

### 0.2 — Um único command de diagnóstico

Três epics criaram três commands quase idênticos no mesmo arquivo: `lib_status` (F1),
`lib_state` (J3) e `lib_manifest_info` (H1). **Dono: F fase 1.** Um `lib_status` com campos
opcionais; J acrescenta `storage`, H acrescenta `schema`/`generated_at`/`with_lufs`, D
acrescenta a lista de `unresolved`.

### 0.3 — Donos dos primitivos compartilhados

| Primitivo | Dono | Quem consome |
|---|---|---|
| `<Sheet>` (bottom-sheet + scrim + arraste) | **F fase 4** | H1 (track info), A5 (ações de fila), I5 (criar station) |
| Busca com scoring (`src/mobile/search.ts`) | **F fase 5** | I3 fica só com o bloco "Ações" |
| Barras do sistema (`MainActivity.kt` `enableEdgeToEdge`) | **G fase 2** | F3 declara dependência |

Sem isso, as fases se sobrescrevem em merge — foi o achado mais repetido da crítica.

### 0.4 — A decisão de autenticação é UMA só

Os epics C, D e J tomaram decisões contraditórias sobre a porta 19878. Ver "Decisões" abaixo.

---

## A ordem: quatro ondas

### Onda 1 — "o app não te trai" (A + B + F, ~85h)

Ataca o gargalo estrutural e a falha mais visível. Ao fim dela o S24 tem fila real e
manipulável, a música não para sozinha, e o app responde ao toque como um app Android.

Ordem interna: `0.1` → `A1` (leitura da fila) → `F4` (sheet) → `A2` (enfileirar) →
`B1-B2` (autoplay/top-up) → `A3-A5` → `F1-F3, F5-F7`.

Por que primeiro: 19 gaps de 5 dimensões estão travados em `A1`, e "a música parou no
bolso" é a única falha do inventário que torna o app inutilizável em uso real.

### Onda 2 — "o motor aprende com o celular" (C + E, ~65h)

Like com sync, taste que não envelhece, histórico e play_count locais. Fecha o loop de
aprendizado que hoje está aberto: o S24 é onde a escuta acontece e é o único lugar onde
o feedback não tem efeito.

Depende da Onda 1: like precisa da sheet (F4) e da notificação; o histórico precisa do
snapshot de fila (A1) para não duplicar evento.

**Adendo (decisão do CEO, 2026-08-18): temas YAML no Android entram na Onda 2** (~7h).
O parser (`yaml_key_to_css_prop`/`yaml_to_css_vars`) e o checker WCAG
(`ensure_bg_ink_contrast`) saem de `desktop.rs` para módulo cross-target
(`serde_yaml` é Rust puro, compila pra Android sem nada); os YAML chegam por
`<MUSIC_ROOT>/.rustify/themes/` no mesmo export do manifest; e uma camada de
tradução (~30 mapeamentos) verte o vocabulário do desktop (`--bg-ink`,
`--primary`, `--surface-*`) para os tokens do mobile (`--s-*`, `--accent`,
`--t1..t4`), com fallback para token que o tema não define. **O esquema escuro
atual É o default e não muda** — tema é opt-in por cima dele; o item 3 das
decisões (tema claro dedicado) morre como item separado: um tema claro vira só
mais um YAML que o checker valida.

### Onda 3 — "os dados chegam sozinhos" (D + J, ~90h)

OTA dos artefatos de inteligência (6MB, não os 13GB de áudio), export automatizado por
timer na VM, e o endurecimento da porta 19878 + distribuição assinada.

Por que depois: é a onda que mais mexe em infraestrutura viva (receptor de sync em
produção, identidade do dispositivo, assinatura do APK). Fazê-la antes das ondas 1-2
significa mexer no encanamento enquanto o produto ainda não justifica.

### Onda 4 — "parece meu app" (G + H + I, ~90h)

Tweaks, temas, light/dark, normalização de loudness, EQ próprio, navegação e descoberta.
É a onda de identidade — a que o CEO mais vai sentir e a que menos quebra se atrasar.

---

## Decisões que precisam do seu OK

Tomei sozinho tudo que era técnico. Estas cinco não são.

### 1. Autenticação na porta 19878 — **minha posição: fail-closed, já**

Os planejadores divergiram: o epic C recomendou "nada agora" (o que vaza são ids de faixas
dentro da sua própria tailnet); D e J recomendaram token obrigatório.

**Discordo do C, e o argumento dele erra o alvo:** a 19878 não é um endpoint de leitura, é
o **único write-path aberto no sinal de produção**. Qualquer host da tailnet pode fazer
upsert em `play_events` sem token nenhum hoje — envenenar o motor de recomendação é mais
grave que ler ids. E ela vai passar a servir a biblioteca inteira (epic D).

Custo de fechar: o token é gerado no desktop e distribuído pelo mesmo `export_manifest.py`
que já faz `ssh cmr-auto` no passo de deploy. Uma linha no script.

**Risco que assumo:** entre o desktop virar fail-closed e o APK novo com token, o sync fica
401. Por isso a virada acontece **dentro da fase 8 do epic D** (que já edita o
`mobile_sync.rs`), não antes — corrigindo a sequência que a crítica pegou.

### 2. Autoplay ligado por padrão em qualquer fila — **DECIDIDO (CEO, 2026-08-17)**

Ligado por padrão em qualquer fila, com duas exceções: **playlist** (coleção curada
com começo e fim — termina) e **station** (já tem o modo de continuação dela, o pool
próprio). Implementado e validado no S24 pelo caminho real do store em 2026-08-18:
playlist=off, álbum=radio, shuffle=radio, station=station.

### 3. Tema claro dedicado — **DECIDIDO (CEO, 2026-08-18): não**

O esquema escuro atual é o esquema do app. A porta que fica aberta é a dos temas
YAML na Onda 2 (ver adendo lá): com o checker WCAG validando cada par, um tema
claro futuro vira só mais um YAML — sem as ~7h de paleta curada dedicada.

### 4. APK assinado de release — **minha posição: sim, logo após J5**

Trocar de debug para release **exige desinstalar**, o que hoje mataria o `device.json`
(bifurcando a série da régua) e o journal não sincado. A fase J5 move os dois para
`/sdcard/Music/.rustify/`, tornando a reinstalação inofensiva. Fazer nessa ordem custa zero;
adiar empurra a mesma troca para quando o journal estiver maior.

### 5. Orientação: travar portrait — **decidi, aviso**

O app roda em landscape hoje com layout desenhado para 360dp — e ninguém previu isso.
Travar `screenOrientation=portrait` é honesto e custa uma linha; fingir suporte custa um
reflow inteiro do Now Playing. As safe-areas laterais entram de qualquer forma (notch
lateral aparece também com teclado).

---

## O que fica de fora, e por quê

- **Crate no celular** — `slskd-client` é desktop-only por Cargo e o slskd vive na cmr-auto.
  O caminho viável (controle remoto por HTTP na tailnet) é XL e depende da decisão de auth.
- **Busca semântica por texto offline** — sem embedder no aparelho. O substituto honesto
  (substring nos 1.328 sidecars `.lrc`) entra no epic I.
- **Port do `audio-engine`** — GStreamer/PipeWire é desktop-only. O EQ do Android é
  reimplementação num `AudioProcessor` do Media3, não porte.
- **Updater in-app** — o `ureq` do build Android é compilado **sem TLS**; o app não fala
  https com o GitHub.
- **Widget / quick tile / Android Auto** — exigem ler estado sem subir a WebView (segunda
  fonte de verdade do que toca) e superfície nova de ataque.
- **WorkManager para o sync** — o payload canônico é montado em Rust com teste byte a byte
  contra o builder do desktop; postar do Kotlin duplicaria o contrato sem teste.
- **Drag-and-drop na fila** — custa horas no WebView e quebra fácil; "promover para a
  próxima" cobre 90% da intenção. O desktop nem reordena.

---

## Epic A — Fila mutavel e estado de sessao no Android

**Onda 1** · 5 fases · 22h estimadas pelo planejador

> A fila real vive no ExoPlayer e o plugin Kotlin so sabe SUBSTITUIR ela inteira (setQueue) e nao sabe LER ela — por isso a UI mantem um espelho em localStorage que mente depois de um restart, e 15 gaps de 5 dimensoes travam no mesmo ponto. A estrategia e atacar o gargalo na ordem em que ele desbloqueia: primeiro leitura (get_queue devolvendo o snapshot que vira a unica verdade da UI e mata o espelho), depois mutacao incremental (addMediaItems/removeMediaItem/moveMediaItem, ja existentes no ExoPlayer, expostos como commands que DEVOLVEM o snapshot novo — o indice nunca e calculado no JS), e so entao os modos de sessao (shuffle/repeat) e a retomada apos morte do processo. Junto com a primeira mutacao entra a proveniencia POR ITEM (QueueMeta deixa de ser escalar por fila), porque no minuto em que existir add-next a fila fica heterogenea e todo play_event passa a mentir silenciosamente pro motor v3.


### A1 — Leitura nativa da fila: a tela mostra o que toca · ~3h

**Entrega:** A tela Queue passa a mostrar a fila REAL do servico (com secao de ja tocadas e tempo restante), sobrevive a reinicio do WebView com o servico tocando, e o estado degradado "Fila indisponivel" deixa de existir. O botao next no fim da fila da feedback em vez de ser no-op mudo.

**Critério de pronto:** No S24: toco uma pasta de 20 faixas, pulo 3, recarrego a WebView com o servico tocando — a tela Queue mostra as 3 ja tocadas, a atual e as 16 a seguir com "16 a seguir · 58:12 restantes", e o indice bate com o que sai do alto-falante.

**Gaps cobertos:** `plugin-queue-read`, `queue-read-plugin`, `queue-read-reorder`, `lib-fila-manipulacao`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — novo @Command getQueue(invoke) que resolve DENTRO do withController (o snapshot precisa ser lido depois da conexao); helper privado queueSnapshotToJs(c: MediaController): JSObject iterando c.getMediaItemAt(i).mediaId e c.currentMediaItemIndex
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/QueueMeta.kt — expor metaFor(trackId): Triple(origin, contextId, durationMs) alem dos getters escalares atuais (na fase 1 ainda devolve o escalar da fila; a virada per-item e a fase 2, mas o WIRE ja nasce per-item para nao mudar depois)
- src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs — structs QueueEntry e QueueSnapshot (serde rename_all camelCase)
- src-tauri/crates/tauri-plugin-rustify-audio/src/mobile.rs — pub async fn get_queue(&self) -> crate::Result<QueueSnapshot> chamando self.call("getQueue", EmptyArgs {})
- src-tauri/crates/tauri-plugin-rustify-audio/src/desktop.rs — stub get_queue devolvendo Err(Error::UnsupportedPlatform)
- src-tauri/crates/tauri-plugin-rustify-audio/src/commands.rs — command novo (async fn, AppHandle<R>)
- src-tauri/crates/tauri-plugin-rustify-audio/src/lib.rs — commands::get_queue no generate_handler!
- src-tauri/crates/tauri-plugin-rustify-audio/build.rs — "get_queue" no array COMMANDS (gera permissions/autogenerated/commands/get_queue.toml)
- src-tauri/crates/tauri-plugin-rustify-audio/permissions/default.toml — adicionar "allow-get-queue" (o default.toml e MANUAL; sem isso o command e negado pela capability mobile.json)
- src-tauri/crates/tauri-plugin-rustify-audio/README.md — linha na tabela do contrato IPC
- docs/android/ipc-contrato-v0.md — secao Player
- src/mobile/types.ts — interfaces QueueEntry e QueueSnapshot
- src/mobile/ipc.ts — export const playerGetQueue = () => invoke<QueueSnapshot>(cmd("get_queue"))
- src/mobile/queueModel.ts (NOVO) — funcoes puras: resolveQueue(snapshot, byId): {items: (Track|null)[], index}, splitQueue(items, index): {past, current, upcoming}, remainingMs(items, index, positionMs)
- src/mobile/queueModel.test.ts (NOVO) — vitest das funcoes puras
- src/mobile/store.ts — REMOVER QUEUE_KEY/persistQueue/rehydrateQueue (linhas 19, 102-130 e as chamadas em playList/bootStore: duas verdades morrem aqui); adicionar syncQueue() que chama playerGetQueue e preenche o signal queue() + queueEntries(); chamar syncQueue no boot (dentro do bootCall), no visibilitychange/focus e depois de todo track_changed; queueOrigin() passa a derivar da entry corrente; next() consulta o snapshot e mostra toast "Fim da fila" quando index e o ultimo
- src/mobile/screens/Queue.tsx — secao "Ja tocadas" (past), subtitulo com "N a seguir · MM:SS restantes", remover o empty-state "Fila indisponivel"
- src/mobile/screens/Library.tsx — linha Fila em Colecoes passa a mostrar a contagem real do snapshot

**Contratos novos:**

- `Kotlin: @Command fun getQueue(invoke: Invoke) — resolve dentro de withController { c -> invoke.resolve(queueSnapshotToJs(c)) }`
- `Rust: #[tauri::command] pub(crate) async fn get_queue<R: Runtime>(app: AppHandle<R>) -> crate::Result<QueueSnapshot>`
- Rust: pub struct QueueEntry { pub track_id: String, pub origin: String, pub context_id: Option<String>, pub duration_ms: i64 } / pub struct QueueSnapshot { pub items: Vec<QueueEntry>, pub index: i32 }
- `Wire JSON: { "items": [{ "trackId": "...", "origin": "station", "contextId": "mix-1", "durationMs": 214000 }], "index": 3 } — trackId String SEMPRE (u64 > 2^53)`
- `TS: playerGetQueue(): Promise<QueueSnapshot>`
- `Permissao: rustify-audio:allow-get-queue (entra em permissions/default.toml)`
- `Chave localStorage REMOVIDA: kv-mobile-queue (nao ha substituta — a fila e lida do servico)`

**Testes:**

- vitest: src/mobile/queueModel.test.ts — resolveQueue com id ausente do manifest (deve devolver null naquela posicao, nao quebrar a lista), splitQueue com index=-1 e index=ultimo, remainingMs descontando a posicao corrente
- cargo test -p tauri-plugin-rustify-audio: round-trip serde de QueueSnapshot garantindo as chaves camelCase exatas do wire (pega quebra de contrato sem precisar de aparelho)
- npm run typecheck + npm test (gates do projeto)
- Smoke S24 (CDP, tecnica do scratchpad 13/08): tocar uma pasta, entao no console do WebView localStorage.clear(); location.reload() — a tela Queue deve reaparecer completa e com o indice certo, provando que nao depende mais do espelho
- Smoke S24: com a fila na ultima faixa, tocar next — toast "Fim da fila" e nada quebra

### A2 — Enfileirar sem destruir a fila + proveniencia por item · ~6h

**Entrega:** Long-press em qualquer faixa abre um action sheet com "Tocar em seguida" e "Adicionar ao fim": a faixa entra na fila viva sem interromper o que toca. Cada item da fila carrega sua PROPRIA origem, entao uma faixa enfileirada a mao dentro de uma station loga origin=manual no journal em vez de mentir station.

**Critério de pronto:** No S24: com uma station tocando, long-press numa faixa da Library, "Tocar em seguida" — a musica corrente NAO e interrompida, a faixa aparece na posicao seguinte da tela Queue, e quando ela toca o journal registra origin=manual enquanto as vizinhas ficam station.

**Depende de:** fase 1

**Gaps cobertos:** `queue-enqueue-next-end`, `enqueue-commands`, `queue-source-provenance-fidelity`, `lib-fila-manipulacao`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/QueueMeta.kt — REESCRITA: de escalar (origin/contextId por fila) para ConcurrentHashMap<String, ItemMeta> (origin, contextId, durationMs) por trackId; API replaceAll(entries), put(trackId, meta), metaFor(trackId): ItemMeta com fallback origin="unknown"; documentar no cabecalho que trackId repetido na mesma fila e last-write-wins (aceito)
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt — adoptCurrent (linhas 206-219) passa a ler QueueMeta.metaFor(trackId) em vez de QueueMeta.origin/contextId escalares; nada mais muda (o congelamento em campos proprios continua sendo a defesa contra setQueue concorrente)
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — QueueItemArg ganha origin: String? e contextId: String? (override por item, default = o da fila); setQueue passa a montar o mapa per-item; novo @Command addItems(invoke) usando c.addMediaItems(insertAt, items) e resolvendo o QueueSnapshot novo dentro do lambda
- src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs — QueueItem ganha origin: Option<String> e context_id: Option<String>; nova struct AddItemsRequest { items, origin, context_id, insert_at: Option<u32> }
- src-tauri/crates/tauri-plugin-rustify-audio/src/mobile.rs, desktop.rs, commands.rs, lib.rs, build.rs, permissions/default.toml — registrar add_items (mesmo ritual da fase 1)
- src-tauri/crates/tauri-plugin-rustify-audio/README.md e docs/android/ipc-contrato-v0.md — contrato de addItems + origem por item
- src/mobile/ipc.ts — playerAddItems(args) e toQueueItem ganha parametro opcional de origin
- src/mobile/sheet.ts (NOVO) — signal global do action sheet: openTrackSheet(track, ctx?) / closeSheet() (evita tocar nas 9 telas para plugar o long-press)
- src/mobile/components/ActionSheet.tsx (NOVO) — bottom sheet do handoff, acoes por props; monta uma vez no MobileApp
- src/mobile/components/TrackRow.tsx — long-press (pointerdown com timer 450ms, cancelado em pointermove > 8px, pointercancel e scroll) chamando openTrackSheet; suprimir o click que vem depois do long-press
- src/mobile/MobileApp.tsx — montar <ActionSheet /> ao lado do <NowPlaying />
- src/mobile/styles/app.css — classes .sheet/.sheet__item (e, de brinde, :active nos botoes de linha, hoje inexistente porque tokens.css zera o tap-highlight)
- src/mobile/store.ts — enqueueNext(track) e enqueueEnd(track) chamando playerAddItems com origin "manual" e aplicando o snapshot devolvido; toast de confirmacao
- src/mobile/queueModel.ts — insertAtFor(snapshot, mode: "next"|"end"): number (funcao pura, testada)

**Contratos novos:**

- `Kotlin: @Command fun addItems(invoke: Invoke) — args { items: Array<QueueItemArg>, origin: String, contextId: String?, insertAt: Int? (null = fim) }; resolve QueueSnapshot`
- Rust: #[tauri::command] pub(crate) async fn add_items<R: Runtime>(app: AppHandle<R>, items: Vec<QueueItem>, origin: String, context_id: Option<String>, insert_at: Option<u32>) -> crate::Result<QueueSnapshot>
- `Rust: QueueItem { ..., pub origin: Option<String>, pub context_id: Option<String> } — override por item; None herda o da fila`
- `TS: playerAddItems(args: { items: QueueItem[]; origin: Origin; contextId?: string | null; insertAt?: number | null }): Promise<QueueSnapshot>`
- `TS: openTrackSheet(track: Track, ctx?: { queueIndex?: number }): void (src/mobile/sheet.ts)`
- `Permissao: rustify-audio:allow-add-items`
- `Semantica de sinal: item enfileirado a mao dentro de station loga origin=manual (peso cheio no v3). SIGNAL_SCHEMA NAO muda — o vocabulario de origins e o mesmo, so a atribuicao ficou correta.`

**Testes:**

- cargo test -p tauri-plugin-rustify-audio: serde de AddItemsRequest e QueueItem com origin por item (camelCase)
- vitest: insertAtFor com index=-1 (fila vazia), index no meio e mode=end
- Spike OBRIGATORIO antes de escrever a UI (30 min, gasto dentro da fase): validar no S24 que c.addMediaItems entrega o item COM uri ao service (o caminho MediaController->MediaSession pode exigir override de MediaSession.Callback.onAddMediaItems). Sinal de falha: a faixa enfileirada pula na hora e o journal ganha um track_ended com end_position 0
- Smoke S24 de proveniencia (o teste que importa): tocar uma station, enfileirar uma faixa por long-press, deixar a station avancar ate ela; entao adb shell run-as dev.cmr.rustifyplayer cat files/play_events.jsonl — as faixas da station com origin station e a enfileirada com origin manual

### A3 — Remover, limpar e promover item da fila · ~3h

**Entrega:** Na tela Queue: long-press numa linha oferece "Tocar em seguida" (promove sem drag) e "Remover da fila"; o cabecalho ganha "Limpar" que descarta o resto mantendo a faixa corrente tocando (sem rewind).

**Critério de pronto:** No S24: com uma station de 40 faixas tocando ha 1min30, toco "Limpar" — a fila cai para 1 item, a musica continua exatamente de onde estava, e o journal nao registra evento nenhum ate ela terminar.

**Depende de:** fase 2

**Gaps cobertos:** `queue-clear`, `queue-remove-reorder`, `queue-read-reorder`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — @Command removeAt (c.removeMediaItem(index)), @Command moveItem (c.moveMediaItem(from, to)), @Command clearQueue (keepCurrent: remove [0, cur) e (cur, count) — NUNCA setMediaItems, que reinicia a posicao em 0L); os tres resolvem QueueSnapshot dentro do withController
- src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs — RemoveAtRequest { index }, MoveItemRequest { from, to }, ClearQueueRequest { keep_current }
- src-tauri/crates/tauri-plugin-rustify-audio/src/mobile.rs, desktop.rs, commands.rs, lib.rs, build.rs, permissions/default.toml — registrar os tres
- src-tauri/crates/tauri-plugin-rustify-audio/README.md e docs/android/ipc-contrato-v0.md
- src/mobile/ipc.ts — playerRemoveAt, playerMoveItem, playerClearQueue
- src/mobile/store.ts — removeFromQueue(index), promoteInQueue(index), clearQueue() aplicando o snapshot devolvido
- src/mobile/screens/Queue.tsx — botao Limpar no ViewHead, long-press nas linhas de "A seguir" abrindo o sheet com as acoes de fila (ctx.queueIndex)
- src/mobile/sheet.ts — acoes condicionais quando ctx.queueIndex esta presente

**Contratos novos:**

- `Kotlin: @Command fun removeAt(invoke) args { index: Int } -> QueueSnapshot`
- `Kotlin: @Command fun moveItem(invoke) args { from: Int, to: Int } -> QueueSnapshot`
- `Kotlin: @Command fun clearQueue(invoke) args { keepCurrent: Boolean } -> QueueSnapshot`
- Rust: async fn remove_at<R>(app: AppHandle<R>, index: u32) -> Result<QueueSnapshot>; async fn move_item<R>(app: AppHandle<R>, from: u32, to: u32) -> Result<QueueSnapshot>; async fn clear_queue<R>(app: AppHandle<R>, keep_current: bool) -> Result<QueueSnapshot>
- `Permissoes: allow-remove-at, allow-move-item, allow-clear-queue`
- `Regra dura documentada no codigo: limpar fila NUNCA passa por setMediaItems (o startPositionMs 0L reinicia a faixa corrente)`

**Testes:**

- vitest: queueModel — indice alvo de promoteInQueue (mover i para index+1) para i acima e abaixo do corrente
- cargo test: serde dos tres requests
- Smoke S24: remover a proxima faixa e conferir que a atual segue tocando sem glitch; limpar a fila no meio de uma faixa e conferir no cronometro que NAO houve rewind; conferir que o journal nao ganhou nenhum track_skipped por causa das mutacoes

### A4 — Shuffle e repeat como MODO (nao como ato de partida) · ~4h

**Entrega:** Os dois botoes voltam a fileira de controles do Now Playing (como no handoff): shuffle embaralha a cauda da fila viva (ordem visivel = ordem tocada) e fica ligado para as filas seguintes; repeat cicla off/all/one e repeat-one loga origin=repeat, o sinal positivo pleno que o celular nunca produziu.

**Critério de pronto:** No S24: no meio da faixa 4 de um album, toco shuffle — a musica nao pisca, a fila a seguir vira outra ordem visivel na tela Queue, e o icone fica marcado; ligo repeat-one, a faixa se repete e o journal mostra origin=repeat.

**Depende de:** fase 1, fase 3

**Gaps cobertos:** `shuffle-mode`, `repeat-modes`, `shuffle-repeat-controls`, `shuffle-repeat-persistidos`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — @Command setRepeatMode (mapeia "off"|"all"|"one" para Player.REPEAT_MODE_*), @Command shuffleTail (embaralha os itens depois do indice corrente com moveMediaItem em lote, atomico no service; seed opcional para teste); ambos resolvem QueueSnapshot
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt — em handleTransition/adoptCurrent: quando reason == MEDIA_ITEM_TRANSITION_REASON_REPEAT e activePlayer.repeatMode == REPEAT_MODE_ONE, a faixa adotada recebe origin "repeat" (override do metaFor). O flush continua track_ended (fim natural), igual ao desktop
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/QueueMeta.kt — nada muda (o override e local ao adopt)
- src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs — QueueSnapshot ganha repeat_mode: String (o modo vive no ExoPlayer; a UI le dele, nao de cache)
- src-tauri/crates/tauri-plugin-rustify-audio/src/mobile.rs, desktop.rs, commands.rs, lib.rs, build.rs, permissions/default.toml
- src-tauri/crates/tauri-plugin-rustify-audio/README.md e docs/android/ipc-contrato-v0.md — incluir origin "repeat" no vocabulario do journal mobile
- src/mobile/modes.ts (NOVO) — signal + persistencia do shuffle em localStorage kv-mobile-modes (o repeat NAO e persistido aqui: fonte unica e o player, restaurado na fase 5)
- src/mobile/store.ts — playList aplica shuffled() quando modes.shuffle esta ligado (substitui o shuffleList one-shot como caminho de shuffle); toggleShuffle() chama playerShuffleTail quando liga; cycleRepeat() chama playerSetRepeatMode
- src/mobile/components/NowPlaying.tsx — dois botoes na .ctrls (aria-pressed no shuffle, data-repeat-mode no repeat, icone repeatOne), e atualizar o comentario do cabecalho (linhas 11-12) que hoje declara a ausencia
- src/mobile/icons.tsx — icones shuffle, repeat, repeatOne (bundle local; nada de CDN)
- src/mobile/screens/Queue.tsx — botao shuffle no head (o handoff desenhou ali)
- src/mobile/styles/app.css — estado ligado dos botoes de transporte

**Contratos novos:**

- `Kotlin: @Command fun setRepeatMode(invoke) args { mode: String } ("off"|"all"|"one") -> QueueSnapshot`
- `Kotlin: @Command fun shuffleTail(invoke) args { seed: Long? } -> QueueSnapshot`
- `Rust: async fn set_repeat_mode<R>(app: AppHandle<R>, mode: String) -> Result<QueueSnapshot>; async fn shuffle_tail<R>(app: AppHandle<R>, seed: Option<i64>) -> Result<QueueSnapshot>`
- `Wire: QueueSnapshot ganha "repeatMode": "off"|"all"|"one"`
- `Chave localStorage: kv-mobile-modes = { "shuffle": boolean }`
- `Origin novo no journal mobile: "repeat" (ja e vocabulario do desktop e do derive_behavioral_signals; SIGNAL_SCHEMA NAO sobe)`
- `Permissoes: allow-set-repeat-mode, allow-shuffle-tail`
- `DECISAO TECNICA REGISTRADA: NAO usar Player.setShuffleModeEnabled — ele reordena a ordem de reproducao sem mexer na lista, e a tela mostraria uma ordem e o alto-falante outra.`

**Testes:**

- vitest: modes.ts — persistencia e leitura do flag; queueModel — shuffleTailOrder(items, index, seed) determinística com seed fixo (a mesma permutacao que o Kotlin usa; a funcao pura documenta a semantica)
- cargo test: serde de QueueSnapshot com repeatMode
- Smoke S24 de sinal (o que importa): ligar repeat-one numa faixa curta, deixar repetir 2x, e conferir no play_events.jsonl duas linhas track_ended com origin=repeat
- Smoke S24: ligar shuffle no meio de um album — a faixa corrente NAO reinicia e a lista de "A seguir" aparece embaralhada na tela

### A5 — Retomada de sessao apos o sistema matar o app · ~6h

**Entrega:** Abrir o app depois de o Android ter matado o processo restaura fila, indice, posicao exata e repeat — PAUSADO — e a Home ganha o cartao "Continue listening" que retoma com um toque. A proveniencia da fila volta junto (o journal para de carimbar unknown apos restart).

**Critério de pronto:** No S24: mato o app no meio de uma faixa de station, reabro, e a Home mostra "Continue listening — <faixa>" com a fila inteira restaurada; um toque retoma em 1:30 e o proximo play_event sai com origin=station.

**Depende de:** fase 1, fase 2, fase 4

**Gaps cobertos:** `session-resume-position`, `resume-sessao`, `restore-queue-source`, `home-continue-listening`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/SessionStore.kt (NOVO) — escreve filesDir/session.json (tmp + rename atomico) com a fila (trackId+origin+contextId+durationMs por item), indice, positionMs, repeatMode e savedAt; read() para o command
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt — chamar SessionStore.write em adoptCurrent, na pausa (EVENT_IS_PLAYING_CHANGED false), no onDestroy e no ticker com throttle de 10s (NAO a cada 500ms — I/O)
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — @Command getSessionSnapshot; SetQueueArgs ganha startPositionMs: Long = 0L e setQueue passa a usa-lo em c.setMediaItems(items, startIndex, startPositionMs) (hoje 0L fixo na linha 148)
- src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs — SessionSnapshot { items: Vec<QueueEntry>, index, position_ms, repeat_mode, saved_at }; SetQueueRequest ganha start_position_ms: i64 (default 0)
- src-tauri/crates/tauri-plugin-rustify-audio/src/mobile.rs, desktop.rs, commands.rs, lib.rs, build.rs, permissions/default.toml — registrar get_session_snapshot
- src-tauri/crates/tauri-plugin-rustify-audio/README.md e docs/android/ipc-contrato-v0.md
- src/mobile/ipc.ts — playerGetSessionSnapshot; playerSetQueue ganha startPositionMs
- src/mobile/queueModel.ts — shouldRestore(state: PlaybackState, snap: SessionSnapshot | null): boolean (so restaura com state.trackId == null; funcao pura e testada, e a defesa contra ressuscitar por cima de playback vivo)
- src/mobile/store.ts — em bootStore, depois do syncState: se shouldRestore, resolver os ids via byId/libGetTracksByIds e chamar playerSetQueue com playNow:false, startIndex e startPositionMs e origin por item vindos do snapshot; senao syncQueue normal
- src/mobile/screens/Home.tsx — primeiro cartao da .qs-row vira contextual: com faixa carregada mostra titulo + "retomar" e chama toggle(); sem faixa, segue Shuffle all (o handoff previa tres cartoes)

**Contratos novos:**

- `Kotlin: @Command fun getSessionSnapshot(invoke) -> SessionSnapshot | null`
- `Kotlin: SetQueueArgs { ..., var startPositionMs: Long = 0L }`
- `Rust: async fn get_session_snapshot<R>(app: AppHandle<R>) -> Result<Option<SessionSnapshot>>; SetQueueRequest { ..., pub start_position_ms: i64 }`
- `Wire: { "items": [QueueEntry], "index": 3, "positionMs": 92310, "repeatMode": "off", "savedAt": 1755200000 }`
- `Arquivo novo no aparelho: /data/data/dev.cmr.rustifyplayer/files/session.json (ao lado do play_events.jsonl; NAO no dataDir raiz, que e do device.json)`
- `Permissao: allow-get-session-snapshot`
- `REGRA: o restore so acontece com o servico sem faixa (get_state.trackId == null) — senao o setMediaItems flusharia um track_skipped fantasma e cortaria a musica viva.`

**Testes:**

- vitest: shouldRestore para os quatro casos (servico tocando / servico com faixa pausada / servico vazio com snapshot / servico vazio sem snapshot)
- cargo test: serde de SessionSnapshot e de SetQueueRequest com start_position_ms
- Smoke S24 (o teste da fase): tocar 1min30 de uma faixa dentro de uma station, matar o app (adb shell am force-stop dev.cmr.rustifyplayer), reabrir — a faixa volta pausada em 1:30 com a fila inteira; dar play e conferir no journal que o evento seguinte sai com origin=station (nao unknown)
- Smoke S24 negativo: com o app tocando em background, reabrir a activity — NADA e restaurado por cima e o journal nao ganha track_skipped

**Cortado deste epic:**

- save-queue-as-playlist — cortado inteiro. O cetico confirmou que o DESKTOP tambem nao cria playlist (src/views/Playlists.tsx:5-8 diz explicitamente que playlist e pasta do disco e que nao ha criacao): nao ha paridade a perseguir, e escrever pasta no aparelho divergiria do acervo canonico da cmr-auto ate o proximo sync sobrescrever. Se voltar, o caminho honesto e mandar a intencao pelo canal de sync e materializar no desktop — outro epic.
- prev-restart-track — cortado. E decisao deliberada e documentada no codigo (AudioPlugin.kt:186-187); o idioma dos 3s falta nos DOIS lados e criaria um gesto que o journal nao sabe registrar.
- Reordenar por arrastar (parte de queue-remove-reorder e queue-read-reorder) — cortado, substituido por "Tocar em seguida" na linha da fila (fase 3). Custo de DnD em WebView e alto e o valor e o mesmo.
- Shuffle em escopo 'open' virando radio (metade de shuffle-mode) — cortado deste epic: depende de autoplay local no aparelho, que e do epic de inteligencia. O shuffle mobile fica com a semantica 'curated' sempre, que e a que o usuario espera de um album ou pasta.
- Autoplay no fim da fila (achado extra: next e no-op silencioso) — cortado como feature, mantido como feedback (toast). Implementar continuacao aqui seria construir metade do motor no epic errado.
- Semantica replay-vs-skip no skipToIndex (achado extra) — cortado. O desktop tem o MESMO comportamento no backend (flush_play_event marca track_skipped em qualquer troca manual, desktop.rs:98) e o v3 pondera por fracao ouvida: um replay de faixa quase inteira entra com peso positivo mesmo rotulado skipped. Nao ha bug a corrigir, ha uma metrica bem calibrada.

**Riscos:**

- addMediaItems pode chegar ao AudioService sem a uri (o caminho MediaController->MediaSession pode exigir override de MediaSession.Callback.onAddMediaItems, ao contrario do setMediaItems que ja funciona). Sinal antecipado: a faixa enfileirada pula instantaneamente e o journal ganha um track_ended com end_position_ms 0 — ou uma IllegalArgumentException no logcat. Mitigacao: spike de 30 min ANTES da UI da fase 2; se confirmado, override onAddMediaItems devolvendo os itens recebidos.
- Divergencia entre espelho e fila nativa durante mutacao concorrente com auto-advance (a faixa vira enquanto o insert acontece). Sinal antecipado: 'Tocando agora' duplicado na tela ou skipToIndex tocando a faixa errada. Mitigacao estrutural ja embutida: TODO mutador devolve QueueSnapshot e o store aplica so o que voltou — o JS nunca calcula indice.
- Command novo sincrono deadlockando a main thread (regra dura do projeto). Sinal antecipado: o app congela no primeiro invoke do command novo, sem log. Mitigacao: checklist de revisao — todo command e async fn com AppHandle<R>, e todo @Command Kotlin que le estado resolve DENTRO do withController.
- Restore da fase 5 ressuscitando por cima de playback vivo: corta a musica e escreve track_skipped fantasma. Sinal antecipado: abrir o app com musica tocando pausa/reinicia a faixa; linha nova no journal com end_position_ms proximo de zero. Mitigacao: shouldRestore exige get_state.trackId == null, com teste unitario dos quatro casos.
- SessionStore escrevendo a cada tick de 500ms vira I/O constante e desgaste de flash. Sinal antecipado: log de writes no logcat em rajada, jank na barra de progresso. Mitigacao: throttle de 10s + escrita nos eventos de ciclo (adopt, pause, onDestroy), tmp+rename.
- APIs de Media3 usadas fora da 1.10.1 (replaceMediaItems e afins mudaram de assinatura entre versoes). Sinal antecipado: erro de compilacao Kotlin no cargo tauri android build. Mitigacao: usar apenas addMediaItems/removeMediaItem/moveMediaItem/setRepeatMode, todos estaveis na 1.10.1; NAO subir a 1.11 (arrasta kotlin-stdlib 2.2 e quebra com o KGP 1.9.25).
- Esquecer permissions/default.toml ao adicionar command: o build passa e o command e negado em runtime. Sinal antecipado: 'not allowed' no console do WebView e a tela ficando vazia sem erro visivel. Mitigacao: o ritual de 6 arquivos (Kotlin, models, mobile.rs, desktop.rs, commands.rs+lib.rs+build.rs, default.toml) esta escrito em cada fase — conferir o default.toml e o ultimo passo antes de compilar.
- Esquecer o bun run build antes do cargo tauri android build: o frontend fica embutido velho no .so e a fase parece nao ter funcionado (mordeu em 13/08). Sinal antecipado: a UI nova simplesmente nao aparece no APK recem-instalado. Mitigacao: build manual do frontend e parte do comando de release de toda fase.

**Decisões do CEO neste epic:**

- **Shuffle no Android: reordenar a cauda da fila (ordem visivel = ordem tocada) ou usar o setShuffleModeEnabled nativo do ExoPlayer?**  
  Recomendação: **Reordenar a cauda.** — O modo nativo e mais barato mas embaralha so a ORDEM DE REPRODUCAO: a tela Queue mostraria uma ordem e o alto-falante tocaria outra — mentira de UI num app cujo problema atual e justamente a tela mentir.
- **Faixa enfileirada a mao dentro de uma station deve logar origin=manual no celular, sabendo que o DESKTOP hoje loga station nesse mesmo caso (contOrigin e por fila, nao por item)?**  
  Recomendação: **Sim — proveniencia por item no mobile e abrir issue para o desktop.** — Alinhar por baixo significa escolher deliberadamente alimentar o motor v3 com origem errada; a divergencia dura ate o desktop ser corrigido, o sinal errado duraria para sempre.
- **Retomada de sessao no celular deve expirar como no desktop (snapshot morre em 6h)?**  
  Recomendação: **Sem expiracao.** — O celular fica dias fechado e a retomada volta PAUSADA (custo de estar errado e um cartao ignorado na Home); expirar transforma o caso de uso mais comum — voltar no dia seguinte — em nada.
- **Reordenar a fila por arrastar (o handoff desenhou a alca em screens.js:98) entra neste epic?**  
  Recomendação: **Cortar o drag.** — DnD dentro de scroll no WebView Android custa horas e quebra facil, enquanto "promover para a proxima" cobre 90% da intencao real com uma chamada de moveMediaItem — e o desktop nem reordena.
- **O action sheet de long-press nasce minimo (fila + radio da faixa) ou ja como menu completo (like, ir para album/artista, info)?**  
  Recomendação: **Minimo e generico.** — Like depende do epic de sinal e navegacao depende do epic de telas; o componente e a infra compartilhada — entregar o esqueleto agora evita que dois epics inventem sheets diferentes.

---

## Epic B — Continuidade: a musica nunca para (Android)

**Onda 1** · 5 fases · 34h estimadas pelo planejador

> O motor de continuidade ja existe no aparelho (mobile_intel: cosine + rank_pool + weighted_pick; stations.json; taste.json) e esta parado porque falta o CAMINHO, nao o algoritmo: a fila so pode ser SUBSTITUIDA (AudioPlugin.setQueue) e quem decidiria o proximo lote e o JS, que o Android suspende. A estrategia e virar o eixo: dar ao plugin Kotlin mutacao incremental de fila (append/truncate/read + origin POR FAIXA) e mover a decisao de "proxima faixa" para uma thread Rust no processo do app (mesmo padrao ja provado do mobile_sync worker), que le o estado do player, consulta a MobileLibrary e empurra o lote — funcionando com a tela apagada. So depois disso vale melhorar a qualidade do pool (pool duplo, negatives, cap por artista, fallback sem vetor) e fechar o vocabulario de origins para a regua diaria enxergar o S24 com a mesma semantica do desktop.


### B1 — Mutacao incremental de fila no plugin (fundacao) + fila legivel na UI · ~6h

**Entrega:** A tela Fila para de mentir: depois do app reiniciar com o service tocando, ela mostra a fila REAL do ExoPlayer (hoje mostra 'Fila indisponivel' ou o espelho stale do localStorage). E o plugin passa a aceitar append/truncate sem reiniciar a faixa corrente — pre-requisito compartilhado de todo o resto do epic.

**Critério de pronto:** No S24: (a) reabrir o app com o service tocando mostra a fila real na aba Fila; (b) append de 2 itens via console do WebView aumenta a fila sem glitch audivel nem reinicio da faixa; (c) truncate corta a cauda sem parar o som.

**Gaps cobertos:** `autoplay-topup-fila (parte plugin: append_queue)`, `station-session-reaction (parte plugin: truncate_queue)`, `extra: plugin nao expoe mutacao incremental de fila (addMediaItems/removeMediaItem) — setQueue e o unico caminho`, `extra: playNow=false ja existe no contrato e nenhum caller usa`, `origin-fila-vs-faixa (parte plugin: origin por faixa no QueueMeta)`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — 4 commands novos (appendQueue, truncateQueue, getQueue, setRepeatMode) + InvokeArgs; setQueue passa a alimentar o mapa por-faixa do QueueMeta
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/QueueMeta.kt — de (origin,contextId) global para mapa trackId->(origin,contextId,durationMs) com fallback global; set() limpa, append() acrescenta sem limpar; poda acima de 500 entradas
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/PlaybackBus.kt — PlaybackSnapshot ganha count:Int; snapshotOf preenche com player.mediaItemCount
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt — adoptCurrent le QueueMeta.originFor(trackId)/contextFor(trackId) em vez dos campos globais
- src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs — AppendQueueRequest, TruncateQueueRequest, RepeatModeRequest, QueueSnapshot; PlaybackState ganha count:i32
- src-tauri/crates/tauri-plugin-rustify-audio/src/commands.rs — 4 commands async fn com AppHandle<R> (regra dura)
- src-tauri/crates/tauri-plugin-rustify-audio/src/mobile.rs — 4 metodos no RustifyAudio (call/call_unit para appendQueue/truncateQueue/getQueue/setRepeatMode)
- src-tauri/crates/tauri-plugin-rustify-audio/src/lib.rs — registrar os 4 no generate_handler!
- src-tauri/crates/tauri-plugin-rustify-audio/build.rs — COMMANDS ganha append_queue, truncate_queue, get_queue, set_repeat_mode (gera os .toml de permissao)
- src-tauri/crates/tauri-plugin-rustify-audio/permissions/default.toml — allow-append-queue, allow-truncate-queue, allow-get-queue, allow-set-repeat-mode
- src-tauri/crates/tauri-plugin-rustify-audio/README.md — tabela de commands e semantica de origin por faixa (o README E o contrato)
- src/mobile/types.ts — PlaybackState.count; QueueSnapshot
- src/mobile/ipc.ts — playerAppendQueue, playerTruncateQueue, playerGetQueue, playerSetRepeatMode
- src/mobile/store.ts — reconcileQueue(): quando pb.count difere do espelho, le get_queue e remonta a fila via libGetTracksByIds; chamado no boot, em track_changed e no visibilitychange
- src/mobile/screens/Queue.tsx — remover o fallback 'Fila indisponivel' baseado em espelho vazio (a fila agora e legivel)

**Contratos novos:**

- `Kotlin @Command fun appendQueue(invoke) — args { items: QueueItemArg[], origin: String, contextId: String? } -> null; usa c.addMediaItems(items) (nunca setMediaItems) e QueueMeta.append(...)`
- `Kotlin @Command fun truncateQueue(invoke) — args { fromIndex: Int } -> null; c.removeMediaItems(fromIndex.coerceIn(0,count), count) — no-op se fromIndex >= count`
- `Kotlin @Command fun getQueue(invoke) -> { trackIds: String[], index: Int }`
- `Kotlin @Command fun setRepeatMode(invoke) — args { mode: 'off'|'one'|'all' } -> null`
- `Rust: pub(crate) async fn append_queue<R: Runtime>(app: AppHandle<R>, items: Vec<QueueItem>, origin: String, context_id: Option<String>) -> crate::Result<()>`
- `Rust: pub(crate) async fn truncate_queue<R: Runtime>(app: AppHandle<R>, from_index: u32) -> crate::Result<()>`
- `Rust: pub(crate) async fn get_queue<R: Runtime>(app: AppHandle<R>) -> crate::Result<QueueSnapshot>  // { track_ids: Vec<String>, index: i32 }`
- `Rust: pub(crate) async fn set_repeat_mode<R: Runtime>(app: AppHandle<R>, mode: String) -> crate::Result<()>`
- `PlaybackState (wire): ganha count:i32 — quantidade de itens na fila nativa; 0 quando vazia`
- `QueueMeta (Kotlin): originFor(trackId): String e contextFor(trackId): String? com fallback para o origin/contextId do ultimo set_queue`

**Testes:**

- cargo test (host): serde round-trip de AppendQueueRequest/QueueSnapshot com track_id > 2^53 como String (regra dura dos ids u64)
- npm run typecheck + vitest: reconcileQueue remonta o espelho a partir de {trackIds,index} e preserva a faixa corrente quando ids desconhecidos aparecem
- Smoke S24 (CDP no WebView, padrao do repo: localabstract webview_devtools_remote_<pid>, suppress_origin): com uma faixa tocando, chamar playerAppendQueue com 2 itens e confirmar por playerGetState que count subiu 2, positionMs NAO zerou e trackId nao mudou
- Smoke S24: playerTruncateQueue(index+1) remove a cauda sem interromper a faixa corrente
- Smoke S24: matar o app pelo recents com o service tocando, reabrir, abrir a Fila — lista real (nao 'Fila indisponivel')

### B2 — Tender de continuidade no Rust: autoplay no fim da fila e top-up antes de secar, com o WebView dormindo · ~10h

**Entrega:** A musica nao para mais. Fila de 3 faixas com a tela apagada no bolso: quando faltam 2 posicoes, o aparelho decide e anexa a proxima sozinho — station usa lote de 6 do proprio pool, qualquer outra fila vira radio semeado pela faixa que acabou de tocar. As continuacoes saem carimbadas com origin 'autoplay'/'station' por FAIXA, nao pela fila.

**Critério de pronto:** No S24, com a tela apagada e o app em background: uma fila curta continua tocando indefinidamente, e os eventos gerados depois do fim da fila original chegam ao desktop (regua diaria) com origin 'autoplay' e device_id s24. Nenhum evento novo com origin 'shuffle'.

**Depende de:** 1

**Gaps cobertos:** `autoplay-end-of-queue`, `autoplay-fim-de-fila`, `autoplay-topup-fila`, `wake-webview-topup`, `station-topup`, `gapless-preload (na medida real: elimina o gap de roundtrip mantendo lookahead >= 2; gapless de amostra fica CORTADO, ver cortes)`, `extra: 'Next' no fim da fila e no-op silencioso no Android`, `origin-fila-vs-faixa (parte mobile: fim do origin 'shuffle' no wire)`, `origin-autoplay-mobile (parte autoplay)`

**Arquivos:**

- src-tauri/src/mobile_library.rs — mover para ca o estado Tauri: pub struct LibraryState(pub Mutex<MobileLibrary>) (hoje e `struct Library` privado em mobile.rs e a thread do tender nao alcanca)
- src-tauri/src/mobile_continuity.rs — NOVO: ContinuityState (Mutex<Continuity>) + funcoes puras de decisao + modulo `tender` (thread, cfg android)
- src-tauri/src/mobile.rs — app.manage(ContinuityState::default()); spawn do tender no setup; commands continuity_arm / continuity_set_enabled / continuity_status; lib_autoplay_next novo; generate_handler! atualizado
- src-tauri/src/lib.rs — declarar pub(crate) mod mobile_continuity (cross-target com allow(dead_code) fora do Android, para os testes puros rodarem no host)
- src/mobile/ipc.ts — continuityArm, continuitySetEnabled, continuityStatus, libAutoplayNext
- src/mobile/store.ts — playList arma a continuidade apos o set_queue; shuffleAll passa a armar radio e logar 'autoplay'; playSimilar arma radio; listener do evento rustify://queue-changed chama reconcileQueue()
- src/mobile/types.ts — Origin perde 'shuffle' e ganha 'autoplay' e 'repeat'
- src/mobile/derive.ts — originLabel/originSrc para 'autoplay' (radio) e 'repeat'
- src/mobile/screens/Settings.tsx — toggle 'Continuar tocando' (kv-mobile-continuity) chamando continuitySetEnabled

**Contratos novos:**

- Rust app command: #[tauri::command] fn continuity_arm(state: State<ContinuityState>, mode: String, station_id: Option<String>, seed_track_id: Option<String>, context_id: Option<String>, queue_ids: Vec<String>) — mode = 'radio' | 'station' | 'off'
- `Rust app command: #[tauri::command] fn continuity_set_enabled(state: State<ContinuityState>, enabled: bool)`
- Rust app command: #[tauri::command] fn continuity_status(state: State<ContinuityState>) -> ContinuityStatus { mode, context_id, seen: usize, negatives: usize, last_topup_at: i64, last_error: Option<String> }
- Rust app command: #[tauri::command] fn lib_autoplay_next(lib: State<LibraryState>, track_id: String, exclude_ids: Vec<String>, limit: Option<usize>) -> Vec<Track> — mesmo nome/forma do desktop (desktop.rs:468)
- `Funcao pura testavel: pub fn needs_topup(status: &str, is_playing: bool, index: i32, count: i32, slack: i32) -> bool — true se status=='ended', ou is_playing && index >= count - slack`
- `Contexto de rodada (convencao unica, espelha startRadioSession do desktop): station -> `station:<station_id>:<epoch_ms>`; radio -> `radio:<seed_track_id>:<epoch_ms>``
- `Evento Tauri Rust->JS: `rustify://queue-changed` com payload { reason: 'topup' | 'truncate', count: i32 }`
- `localStorage `kv-mobile-continuity` = 'on' | 'off' (default 'on'); cadencia do tender = 20s, so quando isPlaying ou status=='ended'; lookahead radio = 2 itens, lote de station = 6 (espelha o desktop)`

**Testes:**

- cargo test (host): needs_topup cobre fim de fila (ended), folga exata (index == count-2), fila parada (nao topa) e count 0
- cargo test (host): Continuity::next_batch escolhe station_batch quando mode=station e autoplay_next quando mode=radio; seen_ids acumulam e entram como exclude no lote seguinte
- cargo test (host): seed do radio = ultima faixa adotada, nao a primeira da fila (regressao do lookahead envelhecido que o desktop documenta em doAutoplay)
- vitest: playList arma continuity com o mode certo por origin (station->station, album_seq/manual/playlist->radio, respeitando o toggle off)
- Smoke S24 (o teste que define a fase): tocar um album de 3 faixas, apagar a tela, bolso, 20 minutos — o som continua; `adb shell run-as dev.cmr.rustifyplayer tail logs/rustify-player.log` mostra os ciclos do tender; o journal tem eventos com origin 'autoplay'
- Smoke S24: com a tela apagada, botao next da notificacao perto do fim da fila avanca (nao e mais no-op)

### B3 — Reacao ao skip dentro da sessao: truncar a cauda, penalizar o rejeitado, re-pedir lote · ~6h

**Entrega:** Pular duas faixas seguidas numa station (ou no radio) muda o rumo na hora: a cauda ainda nao tocada e descartada, o que foi largado cedo vira negativo de sessao e o lote seguinte se afasta dele. Funciona tambem quando o skip vem da notificacao/fone com a tela apagada.

**Critério de pronto:** No S24: numa station, tres skips cedo seguidos mudam visivelmente o que vem a seguir (a cauda antiga sumiu da aba Fila e o lote novo chegou em menos de 20s), e o mesmo acontece quando os skips vem da notificacao com a tela apagada.

**Depende de:** 1, 2

**Gaps cobertos:** `station-session-reaction`, `station-session-negatives`, `extra: skip por indice PARA TRAS (replay) alimentava reacao negativa de sessao`

**Arquivos:**

- src-tauri/src/mobile_continuity.rs — cursor proprio de journal (last_seen_seq) lido por drain_events(cursor) READ-ONLY a cada ciclo; classificacao de skip cedo; truncate + top-up imediato
- src-tauri/src/mobile_intel.rs — rank_pool(pool, taste, vectors, session_negatives: &[u64]) (parametro novo; negativos de sessao penalizam, os do taste seguem excluindo)
- src-tauri/src/mobile_library.rs — station_batch e similar_tracks recebem session_negatives e repassam ao rank_pool
- src-tauri/src/mobile.rs — lib_station_next ganha session_negative_ids: Vec<String> (converge com a assinatura do desktop, desktop.rs:3838); command continuity_note_skip
- src/mobile/ipc.ts — libStationNext ganha sessionNegativeIds (o binding existia sem caller desde CMR-190; passa a ter caller e assinatura completa); continuityNoteSkip
- src/mobile/store.ts — skipToIndex distingue avanco (idx > pb.index, e skip de sessao) de replay (idx <= pb.index, nao reporta); next() reporta skip ao Rust

**Contratos novos:**

- Rust app command: #[tauri::command] fn continuity_note_skip(state: State<ContinuityState>, track_id: String, position_ms: i64, duration_ms: i64) — usado pelo skip feito DENTRO do app; o skip com o app dormindo entra pelo journal
- `Funcao pura: pub fn is_early_skip(end_position_ms: u64, duration_ms: u64) -> bool — ratio < 0.35, mesmo limiar do desktop (src/store/radioSession.ts SESSION_REJECT_RATIO); duration 0 => false`
- `Rust: fn rank_pool(pool: &[u64], taste: &Taste, vectors: Option<&VectorIndex>, session_negatives: &[u64]) -> Vec<u64> (assinatura ampliada; chamadas existentes passam &[])`
- `Rust: fn lib_station_next(lib, station_id: String, exclude_ids: Vec<String>, session_negative_ids: Vec<String>, limit: Option<usize>) -> Vec<Track>`
- `Cap de negativos de sessao = 15, mais recente primeiro (espelha SKIPPED_CAP do desktop)`

**Testes:**

- cargo test (host): is_early_skip nos limites (0.34 sim, 0.35 nao, duration 0 nao)
- cargo test (host): rank_pool com session_negatives rebaixa candidato proximo do rejeitado sem exclui-lo, e o cap de 15 descarta o mais antigo
- cargo test (host): o cursor do journal nao regride e evento ja visto nao vira negativo duas vezes
- vitest: skipToIndex para tras nao chama continuity_note_skip; para frente chama
- Smoke S24: iniciar station, pular 3 faixas cedo em sequencia — a fila encolhe (a cauda some na aba Fila) e o lote novo chega; conferir por continuity_status que negatives > 0
- Smoke S24: pular pela notificacao com a tela apagada e verificar no log que o tender leu o skip pelo journal

### B4 — Qualidade do que e escolhido: pool duplo, negatives do gosto, cap por artista, exclude de recentes e fallback sem vetor · ~8h

**Entrega:** O radio do aparelho deixa de ser 'mais do mesmo artista/album': o candidato vem da uniao entre a vizinhanca da faixa e o gosto global, sem os negatives, com no maximo 2 faixas por artista e sem repetir o que ja tocou nos ultimos dias. E faixa sem vetor passa a ter radio (hoje devolve lista vazia com um toast que sugere erro de configuracao).

**Critério de pronto:** No S24: radio de faixa com 10 candidatos tem no maximo 2 por artista, nao repete nada tocado no mesmo dia, e faixa sem vetor abre radio por artista/pasta em vez de mostrar 'Sem vetores no aparelho'.

**Depende de:** 2

**Gaps cobertos:** `autoplay-qualidade-pool-duplo (metade portavel; re-rank de vibe fica cortado)`, `cobertura-vetores-parcial`, `exclude-recently-played`, `extra: cap de 2 por artista ausente no ranking mobile`, `extra: radio da faixa mobile ignora os negatives do gosto (similar_tracks passa HashSet::new())`

**Arquivos:**

- src-tauri/src/mobile_intel.rs — cap_per_artist puro; autoplay_pool (uniao seed-pool + taste-pool, dedup preservando o melhor rank, negatives do taste como exclusao, weighted_pick_prefix r=0.7 no topo)
- src-tauri/src/mobile_library.rs — similar_tracks passa negatives do taste + exclude de recentes; autoplay_next em camadas (1: autoplay_pool; 2: mesmo artista/mesma pasta; 3: shuffle da biblioteca menos recentes); cap_per_artist alimentado por Track.artist_name
- src-tauri/src/mobile_continuity.rs — anel de recentes persistido (<data_dir>/recents.json), cap 300 e TTL 7 dias; alimentado pelas faixas adotadas (journal) e pelos lotes entregues
- src/mobile/store.ts — playSimilar com toast honesto ('sem vetor para esta faixa — usando artista/album') so quando cair pra camada 2/3
- docs/android/ipc-contrato-v0.md — documentar lib_autoplay_next e as camadas de fallback

**Contratos novos:**

- `Rust: pub fn cap_per_artist(ranked: Vec<u64>, artist_of: impl Fn(u64) -> Option<String>, max: usize) -> Vec<u64> — preserva ordem, empurra o excedente pro fim em vez de descartar`
- `Rust: pub fn autoplay_pool(seed: u64, taste: &Taste, vectors: &VectorIndex, exclude: &HashSet<u64>, fetch: usize) -> Vec<u64>`
- `Rust: pub fn similar_tracks(&self, id: &str, k: usize, exclude: &[String]) -> Vec<Track> (parametro exclude novo)`
- `Arquivo <data_dir>/recents.json: {"ids":[{"id":"<u64 como string>","at":<epoch_s>}]} — cap 300, TTL 7 dias, poda na escrita`
- `Constantes tunaveis no topo de mobile_intel.rs: MAX_PER_ARTIST=2, POOL_FETCH=60, PICK_RATIO=0.7 (espelham desktop.rs)`

**Testes:**

- cargo test (host): cap_per_artist com 6 faixas do mesmo artista devolve 2 no topo e o resto na cauda, sem perder ninguem
- cargo test (host): autoplay_pool nao devolve negatives do taste, deduplica entre os dois pools e mantem o melhor rank de cada id
- cargo test (host): autoplay_next cai pra camada 2 quando o seed nao tem linha no vectors.bin e pra camada 3 quando nem artista nem pasta rendem candidato — nunca devolve vazio com biblioteca nao-vazia
- cargo test (host): recents respeitam TTL e cap (entrada de 8 dias sai; a 301a expulsa a mais antiga)
- Smoke S24: abrir radio de uma faixa e conferir que nas 10 primeiras nenhum artista aparece 3x
- Smoke S24: escolher uma faixa recem-chegada (sem linha no vectors.bin) e abrir o radio — toca, com o toast explicando o modo degradado

### B5 — Fechamento do vocabulario de origins: repeat, context_id canonico e verificacao na regua · ~4h

**Entrega:** O S24 passa a emitir todos os origins que o motor de sinal conhece — inclusive 'repeat' (repeat-one real, com o evento continuando a sair a cada repeticao) — e os context_id do aparelho param de inventar namespace ('similar:<id>' vira 'radio:<seed>:<ts>'). A regua diaria passa a comparar device a device sem vies.

**Critério de pronto:** A regua do dia seguinte mostra, no breakdown por device, o s24 com origins autoplay, station e repeat presentes e nenhum evento novo com origin 'shuffle' ou context_id 'similar:*'.

**Depende de:** 2

**Gaps cobertos:** `origin-autoplay-mobile (parte repeat)`, `context-id-similar`, `origin-fila-vs-faixa (fechamento e verificacao)`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt — no handleTransition, reason == MEDIA_ITEM_TRANSITION_REASON_REPEAT carimba origin 'repeat' no flush (segue sendo track_ended; a repeticao NAO pode engolir o flush)
- src-tauri/crates/tauri-plugin-rustify-audio/README.md — semantica de 'repeat' no journal
- src/mobile/screens/NowPlaying.tsx — botao repeat (off/one/all) chamando playerSetRepeatMode; persistido em kv-mobile-repeat; atualizar o comentario do topo que declara a ausencia
- src/mobile/store.ts — playSimilar usa context_id 'radio:<track_id>:<ts>' e origin 'autoplay'
- docs/contexto/13082026-rustify-android-v0.md — atualizar a secao de origins do v0 (documentacao viva)

**Contratos novos:**

- `Journal: origin 'repeat' passa a existir vindo do s24 (ja e vocabulario do desktop, PlayerBar.tsx:130 — NAO exige bump de SIGNAL_SCHEMA)`
- `localStorage kv-mobile-repeat = 'off'|'one'|'all'`
- `Convencao de context_id do aparelho: 'station:<id>:<ts>' e 'radio:<seed>:<ts>' — o namespace 'similar:' e aposentado (sem migracao retroativa, padrao context_id do repo)`

**Testes:**

- Smoke S24: repeat-one numa faixa curta por 3 voltas gera 3 linhas track_ended com origin 'repeat' no journal
- Smoke S24: repeat-all no fim da fila volta pra primeira sem o tender injetar autoplay por cima (com repeat all o count nunca fica atras do index)
- Verificacao de 24h: aguardar a regua (scripts/metrics/autoplay_regua.py, timer diario 09:00) e confirmar no breakdown por device que s24 emite autoplay/station/repeat e zero 'shuffle'

**Cortado deste epic:**

- gapless-preload — corte da parte 'gapless de verdade'. A fila nativa do ExoPlayer ja pre-prepara o proximo item; gapless de amostra depende do container (Opus/Ogg no aparelho) e nao e switch no Media3 1.10.1 (que esta fixo por causa do KGP 1.9.25). O buraco que o usuario realmente ouve e o roundtrip no fim da fila, e a fase 2 elimina mantendo lookahead >= 2. Prometer gapless real seria vender o que a plataforma nao da.
- pool-station-congelado — corte por ser em grande parte problema aparente: o export escreve manifest.json, vectors.bin, taste.json e stations.json no MESMO run (export_manifest.py main, linhas 515-528). Faixa nova nao tem vetor nem manifest ate o proximo export, entao gerar pool de station no aparelho nao a faz aparecer. O fix real e a cadencia/automacao do export — pertence ao epic biblioteca/export, onde resolve os quatro artefatos de uma vez.
- Re-rank hibrido por vibe (parte do autoplay-qualidade-pool-duplo) — corte por dependencia externa dura: energy/valence/mood_tags nao estao no export. Portar a estrutura sem os dados seria codigo morto com risco de ruido no ranking.
- Botao de shuffle no mobile — corte de escopo: nao e continuidade. O comportamento util do shuffle do desktop em escopo aberto (virar radio) ja e entregue pela fase 2 via shuffleAll; um toggle de shuffle sobre a fila nativa exigiria setShuffleModeEnabled + reordenacao, sem retorno neste epic.
- Station default gerada no aparelho ('Your Mix' local, achado dos ceticos) — corte: e gap de stations/biblioteca. Sem stations.json o aparelho ja tem radio de faixa e autoplay depois da fase 2, que cobrem 'nao tenho o que tocar'.
- wake-webview-topup como item proprio — nao e gap entregavel, e a decisao de arquitetura da fase 2. Absorvido, sem linha propria.
- Correcao parcial do achado 'replay vira sinal negativo' — corte da metade errada: o journal grava track_skipped para a faixa ABANDONADA, o que esta correto (o desktop faz igual). O unico defeito real e a REACAO de sessao disparar em pulo para tras, e so isso e corrigido (fase 3).

**Riscos:**

- O tender e uma thread Rust no processo do app: se o Android congelar o processo em Doze apesar do foreground service de midia, o top-up para e a musica acaba no fim da fila. SINAL ANTECIPADO: no smoke de 20 minutos com a tela apagada, o log mostra os ciclos do tender cessando enquanto o audio continua. PLANO B (~4h a mais): mover o gatilho para o Kotlin — o AudioService ja recebe onEvents e sabe hasNextMediaItem, emitiria 'queue_low' e o Rust responderia. Antes de adotar, spike OBRIGATORIO: confirmar se um Channel criado no Rust (tauri::ipc::Channel::new) recebe trigger() do plugin Kotlin sem JS no caminho — isso NAO esta verificado, e por isso nao e o caminho da fase 2.
- block_on de command do plugin dentro do tender: run_mobile_plugin_async despacha pro main looper; main thread ocupada => ciclo pendurado e, no limite, ANR. SINAL: duracao crescente dos ciclos no log, ou ANR do sistema. MITIGACAO ja no plano: timeout por ciclo, pular o ciclo em vez de insistir, e nunca segurar o Mutex da MobileLibrary durante um block_on.
- addMediaItems durante a reproducao pode causar hiccup ou deslocar o indice corrente em alguma versao do Media3. SINAL: no smoke da fase 1, positionMs zera ou o trackId muda ao appendar. MITIGACAO: append SEMPRE no fim da lista (nunca antes do indice corrente) e teste explicito de nao-regressao antes de a fase 2 depender disso.
- Corrida entre o tender e o mobile_sync no journal: o sync ackA (compacta) a cada 60s; se ackar antes do tender ler, skips com a tela apagada nao viram negativo de sessao. SINAL: continuity_status com negatives sempre 0 apesar de skips ja sincados. IMPACTO: perde reatividade de sessao, nunca dado (o sinal de longo prazo ja subiu). MITIGACAO se doer: anel em memoria das ultimas N transicoes no Kotlin, independente do journal (~30 linhas).
- Mapa de origin por faixa no QueueMeta cresce sem limite em sessao longa de radio, e faixa repetida na mesma fila compartilha entrada. SINAL: memoria do processo subindo em sessao de horas. MITIGACAO no plano: poda acima de 500 entradas e documentacao explicita do caso de id duplicado.
- Espelho da fila no JS diverge da fila nativa depois de N top-ups — a aba Fila volta a mentir, agora por excesso. SINAL: pb.count != queue().length persistindo apos track_changed. MITIGACAO: reconcileQueue disparado por rustify://queue-changed, track_changed e visibilitychange (fases 1 e 2).
- Cap por artista sem re-rank de vibe pode trocar repeticao por incoerencia (variedade sem clima). SINAL: percepcao do CEO em 3 faixas — exatamente o horizonte em que o problema aparece. MITIGACAO: MAX_PER_ARTIST e const no topo de mobile_intel.rs; subir para 3 e uma linha e um APK.
- Esquecer o `bun run build` antes do `cargo tauri android build` embute o dist velho no .so e a fase parece nao ter mudado nada (mordeu em 13/08). SINAL: UI identica apos instalar o APK novo. MITIGACAO: build manual do frontend em TODA rodada de smoke, como manda o CLAUDE.md.

**Decisões do CEO neste epic:**

- **O origin 'shuffle' do mobile esta fora do vocabulario do sinal v3 e entra com peso CHEIO no saldo (nem passivo, nem excluido). Como corrigir?**  
  Recomendação: **Mapear no mobile (opcao 1)** — A opcao 1 e semanticamente honesta (sequencia escolhida pela maquina = o radio do desktop), custa zero no backend e nao cria descontinuidade na regua; a opcao 2 muda o peso de dados JA gravados e obriga bump de schema em tres lugares.
- **Autoplay infinito deve valer para QUALQUER fila (inclusive album e faixa avulsa), como no desktop, ou so para station/radio?**  
  Recomendação: **Sempre ligado, com toggle (opcao 1)** — O gap mais visivel e o som acabar no bolso, e manter paridade com o desktop e barato — mas o default e decisao de produto: 'album acaba e comeca outra coisa' surpreende parte dos usuarios.
- **Vale segurar a fase 4 ate o export carregar energy/valence/mood_tags (re-rank de vibe), ou entregar o autoplay local sem coerencia de vibe agora?**  
  Recomendação: **Entregar agora (opcao 1)** — O defeito percebido hoje no celular e repeticao de artista/album, que o cap por artista + pool duplo atacam diretamente; a vibe melhora coerencia mas depende de epic externo e nao bloqueia o valor principal deste.
- **O botao de repeat entra por este epic (fase 5, ~20 linhas em NowPlaying.tsx) ou fica com o epic de telas?**  
  Recomendação: **Entra aqui (opcao 1)** — Command sem botao nao gera nenhum evento 'repeat' e o gap de medicao continua aberto ate o outro epic rodar; o custo de conflito e um arquivo, resolvivel avisando o dono de telas.

---

## Epic F — Micro-interações: o que faz o Rustify Android parecer um app

**Onda 1** · 7 fases · 34h estimadas pelo planejador

> O mobile já tem as telas certas e o playback certo; o que falta é o app RESPONDER — hoje ele é mudo (zero háptico, zero estado pressionado), mente sobre falhas ("Acervo vazio" cobre permissão negada, manifest ausente e arquivo quebrado), tem um único gesto por faixa (tocar) e uma busca que não acha o que o desktop acha. A estratégia é atacar em três frentes empilháveis: (1) HONESTIDADE — renderizar o erro que já está no store e fazer o backend devolver a causa real, sem gesto novo nenhum; (2) CONTRATO NATIVO — uma única passada no plugin Kotlin que entrega erro de playback, resposta honesta do transporte e o comando de háptico, porque cada rebuild do Kotlin custa caro e não vale fatiar; (3) GESTO — sheet como primitivo estrutural, long-press na linha, alvos de 44px e restauração de scroll. As fases 5-7 (busca com scoring, navegação, player fino) são puro TS testável e podem ser reordenadas.


### F1 — Honestidade: causa real do erro, estados vazios distintos e toast com fila · ~4h

**Entrega:** O usuário passa a ver POR QUE o acervo não carregou (permissão negada / manifest ausente / manifest não bate com os arquivos / falha de IPC), com um botão de ação em cada caso, em vez do genérico "Acervo vazio · Sincronize o acervo". Toasts deixam de se sobrescrever, são anunciados por leitor de tela e distinguem erro de informação. A tela Queue passa a mostrar tempo restante da fila.

**Critério de pronto:** No S24, com o manifest renomeado, a Home mostra a causa correta e um botão que funciona; com o manifest de volta e um rescan, três toasts disparados em sequência aparecem um após o outro (nenhum sumindo) e o TalkBack anuncia o toast.

**Gaps cobertos:** `erro-carga-invisivel`, `estados-vazios-erro`, `lib-estados-vazios-diagnostico`, `toast-acessibilidade`, `empty-queue-feedback (parte: tempo restante e contagem)`, `extra-cetico: Folder engole erro de IPC (Folder.tsx:21)`

**Arquivos:**

- src-tauri/src/mobile_library.rs — nova struct pública LibStatus (snake_case, como Track); campo status em MobileLibrary preenchido no load(); função pura derive_cause(...); probe de leitura do root ANTES do read do manifest (hoje o read_dir do walk_music engole EACCES com `else { continue }`, linha ~129, e permissão negada vira 'manifest ausente')
- src-tauri/src/mobile.rs — command lib_status + registro no generate_handler! (passa de 11 para 12 commands)
- src/mobile/types.ts — interface LibStatus
- src/mobile/ipc.ts — libStatus
- src/mobile/toast.ts — NOVO: fila FIFO pura de toasts (coalesce de mensagem idêntica consecutiva; TTL 1600ms info / 2600ms erro)
- src/mobile/store.ts — showToast passa a aceitar kind; o signal toast muda de string para objeto; novo signal libStatus carregado no bootStore (best-effort, após loadLibrary) e revalidado no rescan()
- src/mobile/components/ui.tsx — novo componente ErrorState (título + hint + ação)
- src/mobile/screens/Home.tsx — o ramo único de fallback (linhas 48-57) vira três ramos derivados de libError()/libStatus().cause
- src/mobile/screens/Library.tsx — mesmo tratamento no fallback de libReady() (linha 48)
- src/mobile/screens/Folder.tsx — createResource (linha 21) ganha catch e estado de erro (hoje falha de IPC vira 'Pasta vazia')
- src/mobile/screens/Queue.tsx — sub do ViewHead com 'N a seguir · X restantes · origem Y' usando fmtTotal
- src/mobile/MobileApp.tsx — toast com role="status", aria-live="polite" e attr:data-kind (linhas 133-139)
- src/mobile/styles/app.css — .toast[data-kind="error"] (borda/acento próprios), a partir da regra existente em :516

**Contratos novos:**

- Rust: pub struct LibStatus { pub cause: String, pub manifest_tracks: usize, pub audio_files: usize, pub resolved: usize, pub unresolved: usize, pub has_vectors: bool, pub has_taste: bool, pub stations: usize, pub music_root: String } — campos snake_case (o TS mobile consome Track em snake_case; NÃO usar rename_all camelCase aqui)
- `Rust: #[tauri::command] fn lib_status(lib: State<Library>) -> LibStatus`
- Rust puro e testável: fn derive_cause(root_readable: bool, manifest_ok: bool, manifest_tracks: usize, audio_files: usize, resolved: usize) -> &'static str, domínio fechado: "ok" | "no_permission" | "no_manifest" | "manifest_unreadable" | "no_audio" | "none_resolved"
- `TS: export const libStatus = () => invoke<LibStatus>("lib_status")`
- `TS: showToast(msg: string, kind: "info" | "error" = "info"): void e toast(): { id: number; msg: string; kind: "info" | "error" } | null (o único leitor hoje é MobileApp.tsx:133)`

**Testes:**

- cargo test em src-tauri/src/mobile_library.rs: tabela de casos de derive_cause (root ilegível => no_permission; root ok + manifest ausente => no_manifest; manifest com 1746 e 0 áudios => no_audio; 1746 manifest + 1700 áudios + 0 resolvidos => none_resolved)
- vitest src/mobile/toast.test.ts: fila serializa 3 mensagens sem perder nenhuma; mensagem idêntica consecutiva não duplica; erro tem TTL maior que info
- npm run typecheck + npm test (gates do projeto)
- Smoke S24: adb shell mv do manifest.json para .bak e abrir o app => 'Acervo sem manifest' com ação 'Re-scan'; revogar MANAGE_EXTERNAL_STORAGE via appops e abrir => 'Sem acesso ao armazenamento'

### F2 — Contrato nativo: erro de playback, transporte honesto e háptico · ~5h

**Entrega:** Faixa cujo arquivo sumiu do cartão (o caso NORMAL, porque o acervo é sincronizado por fora) para de matar a fila em silêncio: o app pula para a próxima, avisa qual faixa falhou e para depois de 3 falhas seguidas em vez de varrer a fila. O botão 'próxima' no fim da fila passa a dizer 'Fim da fila' em vez de não fazer nada. E o aparelho passa a vibrar em play/pause, seek e troca de faixa.

**Critério de pronto:** No S24: faixa com arquivo ausente pula sozinha e diz o nome; o journal não ganha evento nenhum por causa disso; 'próxima' no fim da fila responde por escrito; play/pause vibra.

**Depende de:** fase 1

**Gaps cobertos:** `missing-corrupt-file`, `empty-queue-feedback (parte: feedback de falha de next/previous)`, `haptics (trilho nativo + primeiros pontos de uso)`, `extra-cetico: 'Next' no fim da fila é no-op silencioso (AudioPlugin.kt:177-181)`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt — onPlayerError (hoje só Log.e, linha ~145) passa a incrementar consecutiveErrors, marcar curFailed, emitir PlaybackBus.emitError e avançar se consecutiveErrors < 3 && hasNextMediaItem(); o contador zera quando uma faixa de fato toca (ramo EVENT_IS_PLAYING_CHANGED); flushCurrent NÃO appenda no EventJournal quando curFailed (hoje o skip forçado por erro grava 'track_skipped' com posição 0 = sinal negativo para faixa que nunca tocou)
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/PlaybackBus.kt — Sink ganha onPlaybackError; objeto ganha emitError
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — next/previous resolvem DENTRO do lambda de withController com { moved }; novo @Command haptic com @InvokeArg HapticArgs; implementa Sink.onPlaybackError disparando trigger("playback_error", ...)
- src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs — TransportResult, HapticRequest
- src-tauri/crates/tauri-plugin-rustify-audio/src/mobile.rs — next/previous mudam de call_unit para call::<TransportResult>; nova haptic
- src-tauri/crates/tauri-plugin-rustify-audio/src/desktop.rs — stubs equivalentes devolvendo Error::UnsupportedPlatform
- src-tauri/crates/tauri-plugin-rustify-audio/src/commands.rs — assinaturas de next/previous mudam; novo command haptic (async fn com AppHandle<R>, regra dura do projeto)
- src-tauri/crates/tauri-plugin-rustify-audio/src/lib.rs — commands::haptic no generate_handler!
- src-tauri/crates/tauri-plugin-rustify-audio/build.rs — "haptic" no array COMMANDS (gera permissions/autogenerated/commands/haptic.toml)
- src-tauri/crates/tauri-plugin-rustify-audio/permissions/default.toml — "allow-haptic"
- src-tauri/crates/tauri-plugin-rustify-audio/README.md — o README é o contrato do crate: documentar playback_error, o novo retorno de next/previous e haptic
- src/mobile/haptics.ts — NOVO: wrapper fire-and-forget com throttle de 40ms e chave localStorage kv-mobile-haptics
- src/mobile/ipc.ts — playerNext/playerPrevious com retorno tipado, playerHaptic, onPlaybackError
- src/mobile/types.ts — PlaybackError, HapticKind
- src/mobile/store.ts — next()/previous() (linhas 262-276, hoje só console.warn) emitem toast quando !moved; listener de playback_error registrado no bootStore junto dos outros três
- docs/android/ipc-contrato-v0.md — atualizar (o contrato já está desatualizado; não agravar)

**Contratos novos:**

- `Kotlin: @Command fun next(invoke: Invoke) e previous resolvem JSObject{ "moved": Boolean } — previous devolve moved=false quando só reinicia a faixa (seekTo(0))`
- Kotlin: @InvokeArg class HapticArgs { var kind: String = "tick" }; @Command fun haptic(invoke: Invoke) chamando activity.window.decorView.performHapticFeedback(c, FLAG_IGNORE_VIEW_SETTING), mapa tick=CLOCK_TICK, select=VIRTUAL_KEY, longpress=LONG_PRESS, confirm=CONFIRM, reject=REJECT — CONFIRM/REJECT exigem API 30 e o projeto tem minSdk 24: guardar com Build.VERSION.SDK_INT e cair em VIRTUAL_KEY
- `Kotlin: evento `playback_error` com payload { trackId: String|null, code: Int, message: String, willSkip: Boolean }`
- `Kotlin: private const val MAX_CONSECUTIVE_ERRORS = 3 em AudioService`
- `Rust: pub struct TransportResult { pub moved: bool }; pub async fn next(&self) -> crate::Result<TransportResult>; pub async fn haptic(&self, kind: String) -> crate::Result<()>`
- `Rust: #[tauri::command] pub(crate) async fn haptic<R: Runtime>(app: AppHandle<R>, kind: String) -> crate::Result<()>`
- `TS: playerNext(): Promise<{ moved: boolean }>, playerHaptic(kind: HapticKind): Promise<void>, onPlaybackError(cb): Promise<() => void>`
- `TS: haptic(kind: HapticKind): void — não devolve promise e nunca é aguardado no caminho de UI`

**Testes:**

- vitest src/mobile/haptics.test.ts: throttle de 40ms colapsa rajada; flag off no localStorage não chama IPC
- vitest src/mobile/transport.test.ts: função pura transportMessage(moved, dir) => 'Fim da fila' / 'Início da fila' / null
- cargo check --manifest-path src-tauri/Cargo.toml (o Kotlin não tem infra de teste no repo — a validação é smoke)
- Smoke S24 roteirizado (docs/android/manual-qa-microinteracoes.md, novo): renomear um .opus do cartão com adb e tocar a pasta que o contém => pula a faixa com toast nomeando-a; renomear 4 arquivos seguidos => o player para com toast agregado e NÃO varre a fila; conferir com adb shell run-as ... tail files/play_events.jsonl que nenhuma linha nasceu das faixas que falharam; apertar 'próxima' na última faixa => toast 'Fim da fila'

### F3 — Tato: alvos de 44px, estado pressionado e foco, háptico completo, barras do sistema · ~4h

**Entrega:** Nenhum botão do app fica abaixo de 44px de área tocável (hoje há alvos de 30px), todo toque tem confirmação visual (o realce nativo do Android está desligado desde tokens.css:88 e nada o substituiu) e tátil, e as barras de status/navegação do Android param de brigar com o ink adaptativo da capa.

**Critério de pronto:** No S24: o play do card de Stations (o menor alvo do app) é acertado no primeiro toque com o polegar em movimento; todo botão escurece ao ser pressionado; a barra de status some visualmente dentro do fundo do app.

**Depende de:** fase 2

**Gaps cobertos:** `alvos-tateis`, `haptics (mapa completo)`, `extra-cetico: zero estilo de :focus-visible / :active em src/mobile/styles`, `extra-cetico: barras de sistema do Android não acompanham o ink/tema`

**Arquivos:**

- src/mobile/styles/tokens.css — --tap-min: 44px; .iconbtn { position: relative } + .iconbtn::after { content:""; position:absolute; inset:-4px } (36+8 = 44, sobre a regra de :350-353); bloco novo de :active e :focus-visible para .iconbtn/.trk/.chip/.tab/.selbtn/.seg button/.qs/.alb/.rowitem/.shapebtn; guarda @media (prefers-reduced-motion: reduce) apenas para os transforms que eu introduzo
- src/mobile/styles/app.css — .iconbtn.sm::after { inset:-7px } (30+14 = 44, sobre :841-844); .trk ganha -webkit-touch-callout: none e user-select: none (prepara o long-press da fase 4)
- src/mobile/components/NowPlaying.tsx — gap inline da fileira do cabeçalho de 6px para 8px (linha 132): com 6 alvos de 44px a aritmética é 6×44 + 5×8 = 304dp em 360dp, então cabe sem sobreposição; háptico no fab de play/pause (linha 241), no onSeekUp (linha 100) e na troca de shape/renderer (linhas 133-150)
- src/mobile/screens/Stations.tsx — o play do card usa .iconbtn.sm (30px, o menor alvo do app, linhas 68-76): ganha a expansão sem mudar o desenho
- src/mobile/screens/Settings.tsx — nova linha 'Feedback tátil' usando o .seg existente (Sim/Não); o .tog do handoff foi cortado do porte e não vale ressuscitar por um knob
- src/mobile/components/Dock.tsx — haptic('select') no swipe horizontal do mini (linhas 47-61, hoje troca de faixa em silêncio)
- src/mobile/store.ts — haptic('reject') quando showToast recebe kind 'error'; haptic('confirm') no fim do rescan (linha 309)
- src-tauri/gen/android/app/src/main/res/values/themes.xml — statusBarColor e navigationBarColor transparentes, windowLightStatusBar=false, enforceNavigationBarContrast=false (arquivo é versionado no git, apesar de viver em gen/)

**Contratos novos:**

- `CSS token --tap-min: 44px, com comentário em tokens.css registrando que 48dp da diretriz Android exigiria redesenhar o cabeçalho do Now Playing e que 44 é a decisão`
- `localStorage kv-mobile-haptics = "on" | "off" (default on)`
- Mapa de háptico congelado: play/pause, seek release, troca de shape/renderer e swipe do mini = tick/select; long-press = longpress; toast de erro = reject; rescan concluído = confirm; troca de aba = NENHUM (ruído)

**Testes:**

- vitest: função pura hapticFor(action) com tabela congelada — evita alguém plugar háptico em autoplay
- Smoke S24: tocar os 6 botões do cabeçalho do NP em sequência rápida com o polegar e conferir que nenhum abre o vizinho; navegação com teclado Bluetooth mostra o anel de foco
- Inspeção visual: com a capa trocando o ink, as barras do sistema deixam de mostrar faixa de cor divergente no topo e no rodapé

### F4 — Sheet primitivo + long-press na linha de faixa + Track info + meta navegável no Now Playing · ~7h

**Entrega:** Segurar qualquer linha de faixa, em qualquer tela, abre uma bottom-sheet com as ações secundárias — o gesto canônico do Android, hoje inteiramente ausente. E no Now Playing o artista e o álbum viram navegáveis. O botão voltar do Android fecha a sheet em vez de sair da tela.

**Critério de pronto:** No S24: segurar qualquer faixa em qualquer uma das telas com lista abre a sheet com 6 ações vivas; 'Ir para o artista' a partir do Now Playing leva à tela do artista com o NP fechado e o voltar devolvendo à tela de origem, não ao NP.

**Depende de:** fase 3

**Gaps cobertos:** `sheet-primitive`, `track-context-menu`, `lib-sem-menu-contexto`, `np-track-info (sheet e campos disponíveis; specs técnicas ficam com o epic H)`, `np-meta-navegavel`

**Arquivos:**

- src/mobile/sheet.ts — NOVO: estado da sheet + integração com o botão voltar por sentinela de history (pushState com state marcado + listener de popstate). Deliberadamente NÃO é rota de hash: o Now Playing é a rota /np e uma rota /sheet fecharia o NP por baixo (isNpOpen em nav.ts:47); a sentinela mantém o NP aberto e o voltar funcionando
- src/mobile/components/Sheet.tsx — NOVO: scrim + panel + grab, fechando por clique no scrim, arraste do grab para baixo e voltar do Android; padding-bottom com env(safe-area-inset-bottom) (o app já usa viewport-fit=cover, MobileApp.tsx:150-154)
- src/mobile/lib/longPress.ts — NOVO (diretório novo): createLongPress com cancelamento por movimento e por scroll do container
- src/mobile/styles/app.css — restaurar .sheet / .sheet .scrim / .panel / .grab / .kv do handoff (docs/design-refs/design_handoff_mobile/app.css:95-104); o cabeçalho de app.css:8-10 lista essas regras como cortadas e precisa ser corrigido junto (também mente sobre .lyrics e .stcard, que já voltaram)
- src/mobile/components/TrackRow.tsx — o <button> da linha 26 ganha handlers de long-press e onContextMenu com preventDefault (o menu nativo de seleção de texto do WebView compete com o gesto); props novas context e onLongPress
- src/mobile/screens/Folder.tsx, Album.tsx, Artist.tsx, Search.tsx, Queue.tsx, Library.tsx — passar context ao TrackRow onde a lista já está em mãos
- src/mobile/components/NowPlaying.tsx — título e a linha 'artista · álbum' (linhas 194-200) viram botões; botão 'Track info' na fileira do cabeçalho assume a vaga do rádio, que passa para a sheet
- src/mobile/nav.ts — navigateFromNp(path, param?) usando window.location.replace para trocar a entrada /np em vez de empilhar (senão o voltar devolve o usuário ao NP e a pilha fica esquisita)

**Contratos novos:**

- `TS: export type SheetSpec = { kind: "track"; track: Track; context?: { list: Track[]; index: number } } | { kind: "info"; track: Track }`
- `TS: sheet(): SheetSpec | null; openSheet(spec: SheetSpec): void; closeSheet(): void`
- TS: sentinela de histórico history.pushState({ rustifySheet: true }, ""); o handler de popstate fecha a sheet quando event.state?.rustifySheet não está mais presente. nav.ts continua ouvindo só hashchange — os dois mecanismos não se cruzam
- `TS: createLongPress(opts: { delay?: number; tolerance?: number; onFire: (e: PointerEvent) => void }): { handlers; consumedClick(): boolean } — delay 450ms, tolerance 10px`
- `Itens da sheet de faixa na v1 (nada morto): Tocar agora · Tocar a partir daqui (só com context, embaralhando o resto) · Rádio da faixa · Ir para o álbum · Ir para o artista · Track info`
- Campos da sheet Track info (o que existe no manifest hoje): Título, Artista, Álbum, Ano, Faixa nº, Gênero, Duração, Playlist (pasta de 1º nível), Arquivo (basename), Letra (sincronizada / sem tempo / ausente), track_id em mono

**Testes:**

- vitest src/mobile/lib/longPress.test.ts (fake timers): dispara em 450ms; NÃO dispara com pointermove de 12px; NÃO dispara se o container rolar; o click subsequente é suprimido
- vitest src/mobile/sheet.test.ts (jsdom): openSheet empilha uma entrada; popstate fecha; hashchange de navegação normal não fecha por engano
- vitest de componente com @solidjs/testing-library (já em devDependencies): TrackRow com long-press abre a sheet com a faixa certa
- Smoke S24: rolar 300 faixas na Library dando flings e confirmar que a sheet nunca abre sozinha; segurar uma linha => vibra e abre; voltar fecha a sheet e mantém a lista na posição; abrir a sheet de dentro do Now Playing e conferir que o NP continua aberto atrás

### F5 — Busca: paridade de scoring com o desktop, pastas com conteúdo e a barra que funciona · ~5h

**Entrega:** Buscar 'amari' no celular passa a achar a faixa que o desktop acha, e o resultado mais relevante aparece em primeiro em vez de na posição 40. Buscar 'Blues' passa a mostrar as faixas dentro da pasta, não só o nome dela. E a barra ganha o X para limpar, debounce e a contagem honesta do que foi cortado.

**Critério de pronto:** No S24: 'amari' acha a faixa de título estilizado; 'Blues' mostra a pasta COM quatro faixas de preview; digitar rápido não trava a barra; o X limpa o campo em um toque.

**Depende de:** fase 1

**Gaps cobertos:** `lib-busca-scoring`, `lib-busca-pastas-conteudo`, `search-parity (debounce, limpar campo, limpar recentes)`, `extra-cetico: nenhum corte de lista é sinalizado (derive.ts:129 e Search.tsx:62-70)`, `extra-cetico: Search sem seção 'Top result' do handoff`

**Arquivos:**

- src/mobile/search.ts — NOVO: porte fiel de src-tauri/crates/library-indexer/src/query.rs (squish :334, field_score :341-356, match_score :368-406, pesos W_TITLE=1000 / W_ARTIST=500 / W_ALBUM=300 nas linhas 303-305). Reusa normalize() de derive.ts:47 em vez de duplicar
- src/mobile/derive.ts — searchTracks (linhas 118-133) vira wrapper fino sobre search.ts, mantendo a assinatura para não quebrar os dois call sites
- src/mobile/derive.test.ts — atualizar os casos de searchTracks que mudam de ordem
- src/mobile/search.test.ts — NOVO
- src/mobile/screens/Search.tsx — debounce de 140ms entre o input (linha 92) e os memos (linhas 60-70, hoje síncronos a cada tecla sobre 1746 faixas + álbuns + artistas + pastas); botão X de 44px no .searchfield; 'Limpar' no cabeçalho de Buscas recentes (bloco :112-133); bloco 'Melhor resultado'; linha 'mostrando N de M' quando houver corte; a seção Pastas (:140-165) passa a renderizar até 4 faixas de preview por pasta
- src/mobile/styles/app.css — .searchfield ganha o botão de limpar; estilo do bloco de melhor resultado

**Contratos novos:**

- `TS: squish(s: string): string`
- `TS: fieldScore(needle: string, field: string): number — camadas 4 exato / 3 prefixo do campo / 2 prefixo de palavra / 1 substring`
- `TS: matchScore(needle: string, title: string, artist: string, album: string): number — AND por token com melhor campo por token, e fallback comprimido a metade do peso com needle mínima de 3 chars`
- `TS: searchTracksScored(tracks: Track[], query: string, limit = 120): { hits: Track[]; total: number } — total é o número real de faixas com score > 0, para a linha 'mostrando N de M'`
- TS: searchFoldersScored(folders: Folder[], tracksByFolder: (name: string) => Track[], query: string, preview = 4): Array<{ folder: Folder; tracks: Track[]; score: number }> — casa o nome da pasta E o conteúdo, espelhando search_playlists (query.rs:865-892)

**Testes:**

- vitest src/mobile/search.test.ts com os MESMOS casos do desktop: squish('a m a r i') === squish('amari'); 'kendrick humble' casa artista em um campo e título em outro; título vence artista que vence álbum; prefixo vence substring; needle de 2 chars não aciona o fallback comprimido
- vitest: searchFoldersScored devolve as faixas da pasta 'Blues' mesmo quando a query só casa uma faixa de dentro
- Benchmark leve no próprio teste: 2000 faixas sintéticas, matchScore em toda a lista abaixo de 30ms (orçamento de um keystroke com debounce de 140ms)
- Smoke S24: digitar 'amari' devolve a faixa; digitar 'the' não engasga a digitação e mostra 'mostrando 120 de N'

### F6 — Navegação: scroll restaurado no voltar, puxar para atualizar e skeletons · ~5h

**Entrega:** Rolar 400 faixas, abrir uma e voltar deixa de jogar o usuário no topo — o atrito de navegação mais irritante do app. Puxar para baixo em qualquer tela re-indexa o acervo (o fluxo real depois de sincronizar músicas novas termina hoje numa caça ao botão em Settings). E as listas param de 'pular' ao carregar o próximo lote.

**Critério de pronto:** No S24: ida e volta Library => Álbum => voltar preserva a posição do scroll numa lista de 1746 itens; puxar para baixo na Home dispara o re-scan e não dispara sem querer ao rolar.

**Depende de:** fase 1, fase 3

**Gaps cobertos:** `scroll-restore`, `pull-to-refresh`, `skeleton-loading`

**Arquivos:**

- src/mobile/scrollMemory.ts — NOVO: mapa rota => { top, limit }, com chave derivada de path+param
- src/mobile/MobileApp.tsx — o createEffect das linhas 115-118 (que zera scrollTop a CADA baseRoute, inclusive quando a mudança veio do back() de nav.ts:59) passa a salvar a posição da rota que sai e restaurar a da que entra, com dois requestAnimationFrame; toque na aba JÁ ativa rola para o topo (a válvula de escape)
- src/mobile/components/ui.tsx — LazyList (linhas 66-95) ganha memoryKey e inicializa o limit a partir da memória (sem isso o offset salvo aponta além do conteúdo montado — o risco apontado no gap); novos Skeleton e useDelayedFlag(200ms)
- src/mobile/lib/pullToRefresh.ts — NOVO: gesto sobre o .view com limiar de 90px, só quando scrollTop === 0, travado enquanto rescanning()
- src/mobile/styles/app.css — indicador de pull (rubber band) e animação do skeleton, com @media (prefers-reduced-motion: reduce) desligando o shimmer; o .view (linha 24) já tem overscroll-behavior-y: contain, que é pré-requisito do gesto
- src/mobile/screens/Home.tsx e src/mobile/screens/Folder.tsx — trocar 'Carregando biblioteca…' (Home.tsx:51) e 'carregando…' (Folder.tsx:32) por skeletons atrasados

**Contratos novos:**

- `TS: scrollKey(route: Route): string; rememberScroll(key: string, top: number, limit: number): void; recallScroll(key: string): { top: number; limit: number } | null`
- `TS: LazyList ganha a prop opcional memoryKey?: string`
- `TS: createPullToRefresh(opts: { el: HTMLElement; threshold?: number; canPull: () => boolean; onRefresh: () => Promise<unknown> }): () => void (devolve o cleanup)`
- `TS: <Skeleton kind="row" | "card" count={n} /> e useDelayedFlag(active: () => boolean, ms = 200): () => boolean`

**Testes:**

- vitest src/mobile/scrollMemory.test.ts: chave por rota+param; álbum diferente não herda a posição do anterior
- vitest src/mobile/lib/pullToRefresh.test.ts (jsdom, eventos sintéticos): não dispara com scrollTop > 0; não dispara com 60px; dispara com 100px; não redispara enquanto a promise não resolve
- vitest: useDelayedFlag não acende antes de 200ms (evita o flash em lista já em cache)
- Smoke S24: rolar até o fim da Library, abrir um álbum, voltar => volta na mesma posição e com a mesma quantidade de itens montados; puxar na Home => indicador e toast de re-indexação; medir o congelamento entre o release do gesto e o próximo frame

### F7 — Player fino: seek de precisão, letra com gradiente de atenção, shape/renderer para trás · ~4h

**Entrega:** Achar um ponto específico numa faixa de 8 minutos deixa de ser impossível: ±15s e scrub de precisão arrastando para baixo. A letra ganha o gradiente de três níveis do desktop e diz se é sincronizada. E dá para VOLTAR um shape sem dar 23 toques.

**Critério de pronto:** No S24: dá para posicionar a faixa num segundo escolhido usando o scrub de precisão; a letra mostra três níveis de atenção e diz se é sincronizada; segurar a pílula de shape volta para o anterior.

**Depende de:** fase 3

**Gaps cobertos:** `seek-precision-ui`, `lyrics-linha-vizinha`, `shape-renderer-atalhos`

**Arquivos:**

- src/mobile/lib/scrub.ts — NOVO: função pura de razão de scrub com fator de precisão vertical
- src/mobile/components/NowPlaying.tsx — dois botões ±15s na fileira .ctrls (linha 237: fica prev · −15 · play · +15 · next, cinco alvos de 44px); onSeekMove (linha 96) passa a usar scrubRatio com o deslocamento vertical; rótulo do fator (×1 / ×⅛) e tempo em mono durante o arraste; a linha da letra (linha 208, hoje só data-on binário) ganha data-near quando |i − ativa| === 1; cabeçalho do card de letra com 'Letra · sincronizada' + selo mono aligned/unsynced (o isSynced já existe na linha 46 e hoje só muda o comportamento de scroll); long-press nas pílulas de shape/renderer chama useShape.prev()/useRenderer.prev() (existem em src/mobile/bg/spectrum.ts:64 e :77 e nunca foram chamados)
- src/mobile/styles/app.css — três níveis de opacidade para .lrail p a partir da regra existente em :885; estilo do rótulo do card de letra; estilo dos botões ±15
- src/mobile/screens/Settings.tsx — ‹ › ao redor de renderer e shape (linhas 49 e 52, que hoje só avançam)

**Contratos novos:**

- `TS: scrubRatio(startRatio: number, dxPx: number, widthPx: number, dyPx: number): number — fator = 1 / (1 + |dy| / 60), com piso de 1/8; puro e testável`
- `TS: scrubFactorLabel(dyPx: number): string para o rótulo`
- `Atributo de DOM: data-near nas linhas de letra (o desktop usa a classe is-near em src/views/NowPlaying.tsx:367-373; no mobile o padrão do porte é attr:data-*)`

**Testes:**

- vitest src/mobile/lib/scrub.test.ts: dy=0 reproduz o comportamento atual (1px = largura/duração); dy=180 divide o passo por ~4; o resultado é sempre clampado em [0,1]
- vitest de componente: com letra sincronizada, exatamente uma linha tem data-on e duas têm data-near; com t=0 em tudo, nenhuma tem data-on e o rótulo diz unsynced
- Smoke S24: numa faixa de 8 minutos, arrastar o dedo para baixo e conseguir parar num segundo específico; ±15s responde com háptico; segurar a pílula de shape volta um

**Cortado deste epic:**

- lyrics-transicao-scroll — o easing JÁ existe e é idêntico ao desktop (app.css:871 'transition: transform 0.6s var(--ease)' contra extractor-lab.css:840) e o caso unsynced já é tratado (data-static + overflow-y). O único resto é pausar o auto-scroll quando o usuário rola manualmente, que o desktop também não faz. Custo real do corte: zero.
- search-parity, parte semântica/mood — restrição dura: não há embedder no aparelho. E o cético verificou que libSemanticSearch e libMoodSearch (src/tauri.ts:167 e :178) não têm NENHUM consumidor no desktop: são bindings mortos. Prometer isso no mobile seria inventar paridade com algo que não existe.
- search-parity, chip 'Lyrics' — busca por letra é honesta e viável offline, mas exige (a) lyrics_text no FIELDS do export (scripts/android/export_manifest.py:51-55, epic D) ou (b) um índice invertido dos 1328 sidecars .lrc no aparelho, porque ler 1328 arquivos por keystroke não é opção. Custo real: ~3h que dependem de trabalho de outro epic.
- np-track-info, bloco de specs técnicas (kHz, bits, codec, canais) — o dado vem do Format do Media3 e o campo pertence ao PlaybackState do plugin, que é escopo do epic H (tech-info-pill) e do epic D (lib-metadados-tecnicos). Entrego a sheet e o botão; o bloco 'Áudio' entra depois, sem retrabalho de layout.
- empty-queue-feedback, contagem de faixas não tocadas NO DOCK — o mini já carrega capa, duas linhas de texto, o VU e dois botões numa faixa de 64px. Um número a mais degrada justamente o alvo tátil que a fase 3 está consertando. A contagem e o tempo restante vão para a tela Queue, onde há espaço.
- 48dp estritos nos alvos táteis — inatingível sem redesenhar o cabeçalho do Now Playing (6 alvos numa linha de 360dp: 6×48 + 5×8 = 328dp cabe no limite, mas com zero margem lateral e quebrando a densidade do handoff). Entrego 44px (a diretriz da Apple) via expansão de área com ::after, mantendo o desenho intacto.
- Achado extra 'replay-vs-skip no skipToIndex' (store.ts:289 / AudioService.kt:195-199: tocar de novo algo já ouvido vira sinal negativo) — é um bug REAL e caro, mas muda o que o journal emite, ou seja, a semântica do sinal. Pertence ao epic A (fila) em conjunto com o C (sinal), e ali sim justifica bump de SIGNAL_SCHEMA. Fora do meu escopo por disciplina, não por custo.

**Riscos:**

- Long-press competindo com o scroll: a sheet abre durante um fling em lista de 1746 itens e o app fica inutilizável. Sinal antecipado — no smoke da fase 4, rolar a Library com flings sucessivos e ver a sheet piscar. Mitigação já no plano: delay 450ms, tolerância de 10px, cancelamento por evento de scroll do container e preventDefault no contextmenu (o menu nativo de seleção do WebView é o segundo competidor).
- invoke que nunca resolve no boot frio: next/previous da fase 2 passam a resolver DENTRO do lambda de withController — se o MediaController não conectar, a promise fica pendurada. É exatamente a classe de falha que custou a sessão de 14/08 (o bootCall com timeout+retry de store.ts:331-351 nasceu disso). Sinal antecipado: botão de próxima parece morto logo após um boot frio. Mitigação: reusar a corrida com timeout (1.5s) nos dois transportes, caindo em silêncio no timeout.
- Cascata de skip por erro de playback: com um acervo dessincronizado, dezenas de faixas quebradas viram um avanço em loop que varre a fila em segundos. Sinal antecipado: durante o smoke, uma pasta com 4 arquivos renomeados avança mais de 3 vezes. Mitigação: MAX_CONSECUTIVE_ERRORS = 3 com reset no primeiro isPlaying real.
- Expansão de área tocável roubando o toque do vizinho: seis botões de 36px com ::after de inset -4 numa linha com gap 6px se sobrepõem em 2px de cada lado. Sinal antecipado: tocar 'Fila' e abrir 'Fechar' no S24. Mitigação no plano: o gap sobe para 8px ANTES da expansão, e a aritmética (6×44 + 5×8 = 304dp em 360dp) fica documentada no CSS.
- Restauração de scroll apontando para o vazio: o LazyList monta 60 itens por vez, então restaurar scrollTop=8000 numa lista com 60 linhas montadas resulta em pulo para o fim do conteúdo existente. Sinal antecipado: voltar de um álbum e cair no meio do nada em vez da posição original. Mitigação: a memória guarda top E limit, e o LazyList inicializa o limit antes do restore (dois rAF).
- Pull-to-refresh disparado sem querer e congelando a UI: o rescan é síncrono e segura o Mutex da biblioteca. Sinal antecipado: medir o intervalo entre o release do gesto e o próximo frame no smoke; acima de 400ms o gesto é recuado. Mitigação adicional: trava enquanto rescanning() e limiar de 90px.
- Rebuild do frontend esquecido: não há beforeBuildCommand no tauri.conf.json — sem `bun run build` manual antes do `cargo tauri android build`, o APK sai com o dist velho e a conclusão vira 'a mudança não funcionou' (mordeu em 13/08). Sinal antecipado: a UI no aparelho não muda apesar do APK novo. Mitigação: o roteiro de smoke de cada fase começa pelo bun run build.
- Toast virando ruído: com a fila de mensagens da fase 1 e o háptico da fase 3, três faixas quebradas em sequência produzem 8 segundos de toast e três vibrações de rejeição. Sinal antecipado: o smoke da fase 2 com 4 arquivos renomeados. Mitigação: coalescer mensagem idêntica consecutiva e emitir um único toast agregado ('3 faixas indisponíveis') quando o contador de erros estourar.

**Decisões do CEO neste epic:**

- **A sheet de faixa (fase 4) entra agora com 6 ações vivas, ou espera os epics A (enfileirar) e C (like) para nascer completa?**  
  Recomendação: **Entregar agora reduzida.** — A sheet é o pré-requisito ESTRUTURAL de A e C (os dois precisam de onde pendurar a ação); segurar inverte a dependência e custa uma segunda passada de ~1h depois, contra semanas sem o gesto canônico do Android.
- **Háptico via command novo no plugin Kotlin (performHapticFeedback) ou via navigator.vibrate no WebView?**  
  Recomendação: **Command no plugin.** — Custa +1 command e um rebuild do Kotlin que a fase 2 já faz de qualquer jeito, e evita adicionar permissão ao manifest de um app que hoje pede só três.
- **A fase 2 para de gravar no EventJournal o 'track_skipped' fantasma de uma faixa cujo arquivo não existe. Isso obriga a bumpar SIGNAL_SCHEMA de 3 para 4?**  
  Recomendação: **Não bumpar.** — Sob a definição do v3 (peso contínuo pela proporção escutada) um skip com posição 0 de uma faixa que nunca produziu áudio já era ruído, não sinal — bumpar arrasta quatro arquivos e a régua por uma correção que só remove lixo.
- **A fase 1 adiciona o 12º command ao mobile.rs (lib_status) só para diagnosticar a causa do acervo vazio. Aceita?**  
  Recomendação: **Sim.** — Sem o backend a UI não tem como saber a diferença entre as três causas mais prováveis de um install limpo, e essa é literalmente a primeira tela que o usuário vê quando algo dá errado.
- **O pull-to-refresh (fase 6) dispara um lib_rescan hoje SÍNCRONO (walk de ~3k arquivos na main thread, segurando o Mutex da biblioteca). Entrego assim ou gateio no epic D?**  
  Recomendação: **Entregar agora e medir; se o congelamento passar de 400ms no S24, recuo o gesto para a fase de D.** — O botão em Settings já dispara o mesmo trabalho síncrono hoje — o gesto não cria o problema, só o torna mais fácil de acionar; e a medição é 10 minutos de smoke contra semanas de espera.

---

## Epic C — Loop de gosto fechado (like + sync bidirecional)

**Onda 2** · 7 fases · 34h estimadas pelo planejador

> O canal celular→desktop ja existe e funciona (journal fsync + uuid + POST /sync/events + upsert idempotente); o que falta e a volta e um segundo tipo de escrita. A estrategia e nao inventar canal novo: o like vira um log append-only proprio no Kotlin (mesmo padrao do EventJournal, porque like e ESTADO e precisa sobreviver a compactacao) que sobe por uma segunda rota no MESMO receptor, e o gosto volta por um GET no MESMO receptor derivado AO VIVO pelo desktop — o que mata de uma vez o stale, o decay congelado e a terceira copia da matematica do sinal v3 que hoje vive em Python. Antes de qualquer rede, duas correcoes locais de custo quase zero (usar o `weight` que ja e exportado e ignorado, e expirar negatives por decay com o relogio do aparelho) entregam metade do valor do epic sem tocar em protocolo nenhum.


### C1 — Gosto que pesa e envelhece (100% local, sem rede) · ~3h

**Entrega:** No S24 a station e o rail 'Based on your favorites' passam a respeitar a INTENSIDADE do gosto (faixa ouvida 40x puxa mais que a de 1,5 escuta) e uma faixa banida por um skip unico antigo volta a ser oferecida, porque o decay de 14 dias passa a ser reaplicado com o relogio do aparelho. Settings ganha a primeira linha honesta sobre o motor: quando o gosto foi gerado.

**Critério de pronto:** No S24, Settings mostra 'Gosto: gerado ha N dias · P positives · M de T negatives ativos' com numeros reais do taste.json instalado, e M < T (ha negatives ja expirados). Numa station cujo pool continha faixa banida por skip antigo, ela reaparece no lote.

**Gaps cobertos:** `weight-ignorado-no-rank`, `decay-taste-no-aparelho`, `taste-snapshot-stale`

**Arquivos:**

- src-tauri/src/mobile_intel.rs — TasteEntry deixa de descartar o weight (#[allow(dead_code)] some); Taste vira {positives: Vec<TasteTrack>, negatives: Vec<TasteTrack>, generated_at}; entram as consts espelhadas do v3; rank_pool passa a receber `now` e a ponderar; nova effective_negatives() com decay
- src-tauri/src/mobile_library.rs — Manifest e StationsFile ganham `generated_at` (serde default 0); MobileLibrary guarda os tres generated_at e o `unresolved` (hoje so vira log em :269-271); station_batch/taste_positive_tracks repassam `now`; novo intel_status()
- src-tauri/src/mobile.rs — command lib_intel_status; helper unix_now() ao lado de shuffle_seed()
- src/mobile/types.ts — interface IntelStatus (snake_case, como Track)
- src/mobile/ipc.ts — libIntelStatus()
- src/mobile/screens/Settings.tsx — no painel Library, linha 'Gosto' com idade + positives + negatives ativos (o painel Sinal completo e a fase 5)

**Contratos novos:**

- `pub struct TasteTrack { pub id: u64, pub weight: Option<f64> }`
- `pub struct Taste { pub positives: Vec<TasteTrack>, pub negatives: Vec<TasteTrack>, pub generated_at: i64 }  // 0 = snapshot legado sem o campo`
- `pub fn rank_pool(pool: &[u64], taste: &Taste, vectors: Option<&VectorIndex>, now: i64) -> Vec<u64>`
- `pub fn effective_negatives(taste: &Taste, now: i64) -> std::collections::HashSet<u64>`
- const HALF_LIFE_DAYS: f64 = 14.0; const NEGATIVE_NET_THRESHOLD: f64 = -0.30; const MIN_WEIGHT_SCALE: f32 = 0.35  // espelho de qdrant_client.rs, mesma nota de fonte-da-verdade que o export_manifest.py ja carrega
- `score(t) = max_p(cos(t,p) * wnorm(p)) - 0.5 * max_n(cos(t,n)); wnorm(p) = clamp(w_p / w_max, 0.35, 1.0); weight None => 1.0 (like explicito e exportado com weight null)`
- `negative ativo <=> weight * 0.5^((now - generated_at)/14d) <= -0.30; weight None em negative => nunca expira`
- `#[tauri::command] fn lib_intel_status(lib: State<Library>) -> IntelStatus`
- IntelStatus { taste_generated_at, stations_generated_at, manifest_generated_at, tracks, unresolved, with_vector, with_lrc, positives, negatives_total, negatives_active } (i64/usize, snake_case no wire)

**Testes:**

- cargo test mobile_intel::tests::rank_pool_pondera_por_peso — candidato com cos menor mas peso 4x vence o vizinho de peso 1
- cargo test rank_pool_weight_null_vale_peso_maximo — like explicito nao e rebaixado
- cargo test negative_marginal_expira_por_decay — net -0.31 com generated_at de 30 dias volta ao pool
- cargo test negative_recorrente_sobrevive_decay — net -3.0 com 30 dias segue excluido
- cargo test taste_parse_le_generated_at_e_weight (estende o taste_parse_ids_string existente)
- cargo test rank_pool_sem_vetores_preserva_ordem — teste existente deve continuar verde com a assinatura nova
- npm run typecheck

### C2 — Like no aparelho (durável, offline, sem sync ainda) · ~6h

**Entrega:** O coracao existe: no Now Playing e na fileira de acoes do Album (como no handoff). Curtir funciona sem rede, sobrevive a force-stop e reboot, e o estado e escrito pelo SERVICE (Kotlin) — o mesmo dono que ja grava o journal com o WebView dormindo, o que e pre-requisito do coracao na notificacao.

**Critério de pronto:** No S24: coracao no Now Playing e no Album, com estado correto ao trocar de faixa; curtir com o aviao ligado funciona; apos force-stop e reboot os likes continuam la. O comentario 'sem coracao (nao ha trilho de like)' nao existe mais no codigo.

**Gaps cobertos:** `like-trilho`, `lib-sem-like`, `likes-inexistentes-mobile`, `likes-sem-trilho`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/LikeStore.kt — NOVO; espelha EventJournal.kt (lock, ensureSeq, fsync por escrita, prefs de marca d'agua) com regra de compactacao diferente
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — 5 @Command novos + @InvokeArg ToggleLikeArgs/IsLikedArgs/DrainLikesArgs/AckLikesArgs
- src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs — LikeEvent e DrainLikesResponse
- src-tauri/crates/tauri-plugin-rustify-audio/src/mobile.rs — 5 metodos async no RustifyAudio
- src-tauri/crates/tauri-plugin-rustify-audio/src/desktop.rs — stubs UnsupportedPlatform, no mesmo formato dos existentes
- src-tauri/crates/tauri-plugin-rustify-audio/src/commands.rs — 5 commands async com AppHandle<R> (REGRA DURA)
- src-tauri/crates/tauri-plugin-rustify-audio/src/lib.rs — generate_handler ganha os 5
- src-tauri/crates/tauri-plugin-rustify-audio/permissions/default.toml + permissions/autogenerated/commands/*.toml — allow-toggle-like, allow-is-liked, allow-liked-ids, allow-drain-likes, allow-ack-likes
- src-tauri/src/mobile.rs — lib_toggle_like / lib_is_liked / lib_list_liked (ASYNC, AppHandle), somados ao invoke_handler
- src/mobile/icons.tsx — heart e heartFilled (SVG do handoff, data.js:28); o comentario de cabecalho que lista 'heart' entre os cortados sai
- src/mobile/ipc.ts — libToggleLike/libIsLiked/libListLiked
- src/mobile/store.ts — signal likedIds (Set<string>), isLiked(id), toggleLike(track) otimista com rollback; boot carrega libListLiked; favorites() passa a unir likes locais + taste snapshot
- src/mobile/components/NowPlaying.tsx — botao coracao no header (ao lado de letra/radio/fila) e o comentario de cabecalho 'sem coracao (nao ha trilho de like)' e removido
- src/mobile/screens/Album.tsx — coracao na div.actions (paridade com design_handoff_mobile/screens.js:33)
- src-tauri/crates/tauri-plugin-rustify-audio/README.md — tabela de commands e secao LikeStore
- docs/android/ipc-contrato-v0.md — likes saem da lista 'o que NAO existe'

**Contratos novos:**

- Kotlin: object LikeStore { fun toggle(ctx, trackId): Boolean; fun setLiked(ctx, trackId, liked, at): Boolean; fun isLiked(ctx, trackId): Boolean; fun likedIds(ctx): List<String>; fun drain(ctx, afterSeq): DrainResult; fun ack(ctx, uptoSeq) }
- `arquivo filesDir/likes.jsonl, uma linha por toggle: {"seq":N,"uuid":"...","track_id":"...","liked":true,"at":<unix>}; fsync por escrita; prefs 'rustify_audio_likes' (last_seq, ack_seq)`
- `COMPACTACAO (difere do journal): mantem SEMPRE a ultima linha de cada track_id, mesmo ja ackada — ela e o estado; descarta so as linhas superadas. Teto natural = 1 linha por faixa do acervo`
- `Plugin (camelCase): toggleLike{trackId}->bool | isLiked{trackId}->bool | likedIds{}->string[] | drainLikes{afterSeq}->{events,lastSeq} | ackLikes{uptoSeq}->null`
- Rust plugin: pub async fn toggle_like(&self, track_id: String) -> crate::Result<bool>; pub async fn is_liked(&self, track_id: String) -> crate::Result<bool>; pub async fn liked_ids(&self) -> crate::Result<Vec<String>>; pub async fn drain_likes(&self, after_seq: i64) -> crate::Result<DrainLikesResponse>; pub async fn ack_likes(&self, upto_seq: i64) -> crate::Result<()>
- `pub struct LikeEvent { seq: i64, uuid: String, track_id: String, liked: bool, at: i64 } (snake_case, como PlayEvent)`
- `App: #[tauri::command] async fn lib_toggle_like(app: tauri::AppHandle, track_id: String) -> Result<bool, String> — MESMO nome do desktop (desktop.rs:728) por paridade`
- `REGRA DE IMPLEMENTACAO: nenhum MutexGuard de State<Library> pode atravessar um .await; resolver ids no plugin primeiro, travar a Library depois (lib_list_liked)`
- `JS: libToggleLike(trackId): Promise<boolean>; store.toggleLike(t: Track): void (otimista, reverte em erro)`

**Testes:**

- cargo check --target aarch64-linux-android (o gate real do plugin; nao ha infra de teste instrumentado Android no projeto — nao inventar uma aqui)
- npm run typecheck
- SMOKE S24 (roteirizado): curtir 3 faixas -> adb shell run-as dev.cmr.rustifyplayer cat files/likes.jsonl mostra 3 linhas; force-stop + reabrir -> os 3 coracoes continuam acesos; curtir/descurtir a mesma faixa 20x -> apos o ack a faixa tem 1 linha so
- SMOKE: curtir com o app em background (via Album) e conferir que o estado bate ao voltar

### C3 — Like sobe pro desktop (segunda rota no mesmo receptor) · ~4h

**Entrega:** O like dado no onibus chega ao Qdrant da cmr-auto em ate 60s, com liked_device='s24', e passa a alimentar os positives do sinal v3 no proximo autoplay do desktop. Descurtir tambem propaga. Reconciliacao last-write-wins por timestamp do evento.

**Critério de pronto:** Curtir uma faixa no S24 acende o coracao dessa faixa no app desktop em ate 60s; descurtir apaga. Depois de um ciclo, adb mostra likes.jsonl compactado e o Qdrant tem liked_at + liked_device='s24' no enrichment.

**Depende de:** fase 2

**Gaps cobertos:** `likes-inexistentes-mobile`, `sync-bidirecional`, `sync-worker-bidirecional`

**Arquivos:**

- src-tauri/src/sync_receiver.rs — nova rota ("POST", "/sync/likes") no match de :102, reusando o mesmo parse de body/content-length
- src-tauri/crates/library-indexer/src/query.rs — like_decision() pura + apply_synced_like(); toggle_like() (:530) passa a gravar unliked_at no clear e unliked_at:null no set
- src-tauri/crates/library-indexer/src/lib.rs — re-export de apply_synced_like (o receptor so tem QdrantClient, nao o IndexerHandle)
- src-tauri/crates/library-indexer/src/qdrant_client.rs — 'unliked_at' entra na lista de indices de payload dos enrichments (:629 e :1524)
- src-tauri/src/mobile_sync.rs — endpoint() vira base_url(); sync_once passa a fazer tambem o ciclo de likes (drain_likes -> POST -> ack_likes)
- src-tauri/crates/tauri-plugin-rustify-audio/README.md e docs/android/ipc-contrato-v0.md — rota e formato

**Contratos novos:**

- `POST /sync/likes  body {"likes":[{"uuid":"...","track_id":"12755931536157556","liked":true,"at":1786600000,"device_id":"s24"}]}  ->  {"accepted":N,"rejected":M}`
- `rejeicao: sem device_id | track_id nao-u64 | at <= 0 | at mais de 300s no futuro (guarda contra relogio torto do aparelho)`
- `pub enum LikeWrite { Set { at: i64 }, Clear { at: i64 }, Skip }`
- `pub fn like_decision(liked_at: Option<i64>, unliked_at: Option<i64>, incoming_liked: bool, incoming_at: i64) -> LikeWrite  // PURA, e onde mora o LWW`
- `pub fn apply_synced_like(client: &QdrantClient, track_id: u64, liked: bool, at: i64, device: &str) -> Result<bool, IndexerError>`
- `enrichment ganha unliked_at: i64|null — sem ele o LWW nao tem referencia depois de um unlike no desktop e um like antigo re-entregue ressuscitaria`
- `sync.json do aparelho ganha "base": "http://100.102.249.9:19878"; a chave legada "endpoint" continua aceita (o sufixo /sync/events e removido)`

**Testes:**

- cargo test like_decision_* — 5 casos: primeiro like; unlike mais novo limpa; unlike mais velho ignorado; like re-entregue e no-op; at no futuro rejeitado
- cargo test post_de_likes_conta_aceitos_e_rejeitados — no molde do post_de_lote_conta_aceitos_e_rejeitados existente (fake_qdrant)
- cargo test toggle_like_grava_unliked_at
- SMOKE E2E: curtir no S24 com o desktop aberto; em <=60s conferir no desktop (coracao da PlayerBar ao abrir a faixa, ou ipc_execute_command lib_is_liked pelo bridge MCP via tunel :9223)

### C4 — O desktop devolve o gosto (GET /sync/taste) e a réplica Python morre · ~5h

**Entrega:** O celular deixa de depender de um humano rodando export_manifest.py para ter gosto atualizado: puxa taste fresco sozinho (boot + a cada 6h + botao em Settings), derivado AO VIVO pelo desktop com o mesmo codigo do autoplay. Like dado no desktop chega ao rail de favoritos do S24; skip dado no S24 volta reprecificado no snapshot.

**Critério de pronto:** Dar like numa faixa NO DESKTOP, apertar 'Atualizar gosto' em Settings no S24: a faixa aparece no rail 'Based on your favorites' e a linha Gosto passa a dizer 'gerado ha 0 dias' — sem ninguem rodar export_manifest.py nem adb push.

**Depende de:** fase 1, fase 3

**Gaps cobertos:** `sync-bidirecional`, `taste-snapshot-stale`, `sync-worker-bidirecional`, `likes-inexistentes-mobile`

**Arquivos:**

- src-tauri/crates/library-indexer/src/qdrant_client.rs — derive_behavioral_signals (:1849) vira wrapper de derive_behavioral_signals_scored; behavioral_signals (:1440ish) ganha irmao behavioral_signals_scored
- src-tauri/src/sync_receiver.rs — nova rota ("GET", "/sync/taste")
- src-tauri/src/mobile_sync.rs — pull_taste() com escrita atomica (tmp + rename) e cadencia propria
- src-tauri/src/mobile_library.rs — MobileLibrary::reload_intel(&mut self) (re-le os 3 artefatos sem re-walk do acervo); load_intel prefere o taste do data dir quando mais novo que o do Music root
- src-tauri/src/mobile.rs — pub(crate) reload_intel(app) + command lib_pull_taste; emissao do evento rustify:intel-updated
- src/mobile/store.ts — listener do evento chama loadIntel(); acao pullTaste()
- src/mobile/screens/Settings.tsx — botao 'Atualizar gosto' na linha Gosto
- scripts/android/export_manifest.py — build_taste passa a fazer GET no receptor; saem ~80 linhas de replica (derive_behavioral_signals, recent_likes, scroll_play_events e as 13 constantes do sinal)
- CLAUDE.md — o ritual do export muda (o taste nao e mais derivado la)

**Contratos novos:**

- GET /sync/taste -> {"schema":1,"generated_at":<unix>,"signal_schema":3,"positives":[{"track_id":"<u64 como string>","weight":<f64|null>}],"negatives":[{"track_id":"...","weight":<f64>}]} — BYTE-COMPATIVEL com o taste.json que o export escreve hoje (o parser mobile nao muda)
- `pub(crate) fn derive_behavioral_signals_scored(pos: &[Value], neg: &[Value], liked: &[u64], now: i64) -> (Vec<(u64, Option<f64>)>, Vec<(u64, f64)>)  // None = like explicito, sem saldo derivado`
- `pub(crate) fn derive_behavioral_signals(...) -> (Vec<u64>, Vec<u64>)  // assinatura PUBLICA intacta, agora so descarta os pesos`
- `impl QdrantClient { pub fn behavioral_signals_scored(&self) -> Result<(Vec<(u64,Option<f64>)>, Vec<(u64,f64)>), IndexerError> }`
- `impl MobileLibrary { pub fn reload_intel(&mut self) }`
- `#[tauri::command] async fn lib_pull_taste(app: tauri::AppHandle) -> Result<i64, String>  // devolve o generated_at novo`
- `evento Tauri 'rustify:intel-updated' (payload vazio)`
- `const TASTE_PULL_INTERVAL: Duration = Duration::from_secs(6*3600); pull tambem no PRIMEIRO ciclo do worker`
- `escrita em <MUSIC_ROOT>/.rustify/taste.json.tmp + rename; se o Music root recusar escrita, fallback <data_dir>/taste.json (load_intel usa o mais novo dos dois)`

**Testes:**

- cargo test — TODOS os testes existentes de derive_behavioral_signals devem passar sem alteracao (e a prova de que o wrapper nao mudou semantica)
- cargo test scored_devolve_pesos_na_mesma_ordem_dos_ids
- cargo test like_explicito_sai_com_weight_none
- cargo test get_taste_devolve_shape_do_export (fake_qdrant, compara chaves e tipos)
- diff de sanidade manual: rodar o export_manifest.py novo e o antigo no mesmo Qdrant e comparar os conjuntos de positives/negatives antes de apagar a replica
- npm run typecheck

### C5 — Observabilidade do sinal e worker de sync adulto · ~4h

**Entrega:** O usuario passa a ver, no proprio aparelho, se o loop esta vivo: quantos eventos estao presos, quando foi o ultimo sync bem-sucedido, a idade do gosto e a cobertura real (vetor, letra, faixas do manifest sem arquivo). O worker deixa de dormir antes do primeiro ciclo, ganha backoff fora da tailnet e um flush ao ir para background. A regua diaria passa a gritar quando um dispositivo fica em silencio.

**Critério de pronto:** Painel Sinal no S24 mostrando, com dado real: eventos pendentes, ultimo sync, idade do gosto, positives, negatives ativos de total, faixas com vetor, faixas com letra e faixas do manifest sem arquivo local. Com a tailnet fora, o numero de pendentes cresce e o backoff aparece; ao voltar, o painel confirma o envio.

**Depende de:** fase 1, fase 3, fase 4

**Gaps cobertos:** `regua-cobertura-mobile`, `sync-worker-bidirecional`, `taste-snapshot-stale`, `aversion-negatives-visiveis`

**Arquivos:**

- src-tauri/src/mobile_sync.rs — SyncState compartilhado (Mutex); sync_once ANTES do primeiro sleep (hoje o loop dorme primeiro, :103-105); backoff 60s -> 15min em falha, reset no sucesso; pub(crate) fn sync_now(app)
- src-tauri/src/mobile.rs — app.manage(SyncState::default()); commands lib_sync_status e lib_sync_now
- src/mobile/types.ts + ipc.ts — SyncStatus, libSyncStatus, libSyncNow
- src/mobile/screens/Settings.tsx — painel 'Sinal' (absorve a linha Gosto da fase 1)
- src/mobile/store.ts — visibilitychange com document.hidden dispara lib_sync_now (hoje so ha o caminho de volta, :381-384); polling de 5s do status enquanto a tela Settings estiver aberta
- scripts/metrics/autoplay_regua.py — bloco por dispositivo ganha 'dias desde o ultimo evento' e ALERTA quando um device com historico fica >3 dias mudo

**Contratos novos:**

- `pub(crate) struct SyncState(pub std::sync::Mutex<SyncStatus>)`
- `SyncStatus { last_attempt_at: i64, last_ok_at: i64, last_error: Option<String>, events_pending: usize, likes_pending: usize, events_sent_total: u64, last_taste_pull_at: i64, backoff_secs: u64 }`
- `#[tauri::command] async fn lib_sync_status(app: tauri::AppHandle) -> SyncStatus  // pendencias vem de drain_events/drain_likes a partir do seq ackado, SEM ack`
- `#[tauri::command] async fn lib_sync_now(app: tauri::AppHandle) -> SyncStatus`
- `fn next_backoff(current: u64, ok: bool) -> u64  // pura: 60 -> 120 -> ... -> 900; ok reseta pra 60`
- `regua: linha 'ALERTA: <device> sem eventos ha N dias (ultimo em <data>)' no regua-latest.md quando N > 3 e o device ja tinha >=20 eventos`

**Testes:**

- cargo test next_backoff_cresce_e_reseta
- cargo test sync_status_conta_pendencias_sem_ackar
- npm run typecheck
- SMOKE S24: modo aviao, tocar 3 faixas, abrir Settings -> 'N eventos pendentes' cresce e o ultimo sync fica velho; desligar o aviao e apertar 'Sincronizar agora' -> zera
- rodar python3 scripts/metrics/autoplay_regua.py e conferir o bloco de dispositivos no docs/metrics/regua-latest.md

### C6 — Like na notificação e no lockscreen · ~4h

**Entrega:** Curtir sem desbloquear o aparelho: botao de coracao na notificacao de midia, com o icone refletindo o estado da faixa corrente. O service ja e o dono do LikeStore desde a fase 2, entao o gesto funciona com o WebView suspenso e sobe no proximo ciclo de sync como qualquer outro like.

**Critério de pronto:** Com o S24 bloqueado, o coracao aparece na notificacao de midia, alterna ao toque, reflete o estado por faixa e o like resultante chega ao desktop no ciclo seguinte.

**Depende de:** fase 2, fase 3

**Gaps cobertos:** `notification-controls`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt — MediaSession.Builder (:94-98) ganha setCallback + setCustomLayout; onConnect libera o SessionCommand; onCustomCommand alterna o like; adoptCurrent (:206) atualiza o layout ao trocar de faixa
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/res/drawable/ic_heart.xml e ic_heart_filled.xml — NOVOS (vector drawables)
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/PlaybackBus.kt — canal para o evento like_changed
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — repasse do evento
- src/mobile/ipc.ts — onLikeChanged
- src/mobile/store.ts — listener atualiza likedIds
- src-tauri/crates/tauri-plugin-rustify-audio/README.md — o custom command e o evento

**Contratos novos:**

- `SessionCommand("dev.cmr.rustify.LIKE", Bundle.EMPTY) liberado em MediaSession.Callback.onConnect via ConnectionResult.accept(sessionCommands, playerCommands)`
- `CommandButton com ic_heart / ic_heart_filled + setSessionCommand(LIKE), publicado por session.setCustomLayout(listOf(button)) no onCreate e re-publicado em adoptCurrent e apos cada toggle`
- `evento do plugin 'like_changed' com payload { trackId: string, liked: boolean }`
- `onCustomCommand -> LikeStore.toggle(applicationContext, curTrackId) (o mesmo campo congelado que o journal usa; nunca o QueueMeta vivo)`

**Testes:**

- cargo check --target aarch64-linux-android
- npm run typecheck
- SMOKE S24 (unico caminho real): tela bloqueada, tocar o coracao na notificacao -> icone preenche; abrir o app -> coracao aceso na mesma faixa; adb shell run-as ... cat files/likes.jsonl mostra a linha nova
- SMOKE: trocar de faixa com a tela bloqueada e conferir que o icone acompanha o estado da faixa nova

### C7 — Saldo local realimenta o ranking (CONDICIONAL — decidir depois da fase 4 rodar) · ~8h

**Entrega:** O feedback dado no aparelho tem efeito IMEDIATO e sem rede: a faixa pulada tres vezes numa station para de ser oferecida no lote seguinte, mesmo em modo aviao. E o unico caso que o pull de 6h nao cobre. Junto vem a consolidacao definitiva da matematica do v3 num crate unico compartilhado desktop+mobile.

**Critério de pronto:** Com o aparelho em modo aviao, pular a mesma faixa tres vezes numa station faz ela sumir do lote seguinte, e a regua do dia seguinte no desktop mostra positives/negatives identicos aos de antes do refactor do signal-core.

**Depende de:** fase 1, fase 4

**Gaps cobertos:** `taste-derivado-so-de-eventos-sincados`

**Arquivos:**

- src-tauri/crates/signal-core/Cargo.toml e src/lib.rs — NOVO crate sem deps alem de serde_json: as consts do v3 + a derivacao pura
- src-tauri/crates/library-indexer/src/qdrant_client.rs — remove a copia da derivacao e delega ao signal-core (mantendo a assinatura publica e os testes)
- src-tauri/crates/library-indexer/Cargo.toml e src-tauri/Cargo.toml — signal-core como dependencia cross-target (compila no Android)
- src-tauri/src/mobile_signal.rs — NOVO: recent_events.jsonl (append com dedup por uuid, poda por generated_at/21d) e derivacao local
- src-tauri/src/mobile_sync.rs — sync_once passa a: drenar -> APPENDAR no local (mesmo offline) -> POST -> ack
- src-tauri/src/mobile_intel.rs — merge_taste(snapshot, delta, now)
- src-tauri/src/mobile_library.rs — station_batch/taste_positive_tracks/similar_tracks passam a usar o taste EFETIVO (merge) e o exclude de negatives cobre tambem o radio da faixa
- src-tauri/src/mobile.rs — lib_play_station e lib_station_next viram async e drenam o journal para o agregado local antes de rankear

**Contratos novos:**

- crate signal-core: pub const HALF_LIFE_DAYS/POSITIVE_MIN_LISTEN_PCT/POSITIVE_RAMP_SPAN/NEGATIVE_WEIGHT_FLOOR/QUALIFY_FLOOR/NEGATIVE_NET_THRESHOLD/FULL_ATTENTION_MS/PASSIVE_ORIGINS/PASSIVE_WEIGHT/MAX_*
- `pub struct Signals { pub positives: Vec<(u64, Option<f64>)>, pub negatives: Vec<(u64, f64)> }`
- `pub fn derive_scored(pos: &[serde_json::Value], neg: &[serde_json::Value], liked: &[u64], now: i64) -> Signals`
- `<data_dir>/recent_events.jsonl: a linha do journal + listen_pct calculado; dedup por uuid (drain sem ack repete de proposito); poda started_at < max(taste.generated_at, now - 21d)`
- `pub fn merge_taste(snapshot: &Taste, delta: &signal_core::Signals, now: i64) -> Taste  // net(t) = snapshot_net(t)*decay + delta_net(t); positives = net>0; negatives = net <= -0.30`
- `#[tauri::command] async fn lib_station_next(app, station_id: String, exclude_ids: Vec<String>, limit: Option<usize>) -> Vec<Track>`

**Testes:**

- mover os testes de derivacao existentes para o signal-core (e a prova de que o refactor nao mudou nada)
- cargo test merge_soma_saldos_e_reaplica_threshold
- cargo test skip_local_derruba_faixa_positiva_do_snapshot
- cargo test like_do_snapshot_nao_e_apagado_por_um_skip_isolado
- cargo test recent_events_dedup_por_uuid e poda_descarta_evento_ja_no_snapshot
- REGRESSAO DESKTOP: rodar scripts/metrics/autoplay_regua.py com o binario antes e depois do refactor e comparar positives/negatives — divergencia = falha
- SMOKE S24 em MODO AVIAO: pular a mesma faixa 3x numa station e pedir o proximo lote

**Cortado deste epic:**

- station-stats — cortado inteiro. Nenhuma tela mobile mostra played ou last_played_at, e o dado ja e derivavel no desktop dos play_events sincados (context_id = id da station, origin = station). Criar protocolo de sync para um contador que ninguem le e custo sem receita; se um dia a ordenacao de stations por uso importar, e uma consulta no desktop, nao um campo no fio.
- notification-controls, parte shuffle/repeat — cortado. O player mobile nao tem shuffle nem repeat (nao existe command no plugin para nenhum dos dois); botao na notificacao sem trilho e botao morto, e o trilho pertence ao epic de playback. Entrego so o like. Seek na notificacao ja vem de graca do MediaSession — nao e trabalho.
- aversion-negatives-visiveis — cortada a UI de inspecao/edicao. O proprio cetico marcou OVERSTATED: o desktop tambem nao tem (CMR-179 deferido), logo nao e gap mobile-vs-desktop. Fica so o numero no painel Sinal ('M de T negatives ativos'), que sai de graca porque a fase 1 ja calcula os dois.
- Tela dedicada de Curtidas no mobile — cortada deste epic. O command lib_list_liked entra (custa quase nada e alimenta o rail 'Based on your favorites'); a tela e escopo do epic de telas. Nota: libListLiked no desktop e binding morto hoje, entao a tela nao tem precedente para copiar.
- Heartbeat dedicado do aparelho para a regua — cortado. Quando a tailnet cai, o heartbeat tambem nao chega; ele reportaria a falha so depois de ela acabar. O alarme certo e o silencio por device, calculado no desktop com dado que a regua JA tem (max(timestamp) por device_id) — cinco linhas em vez de uma colecao nova, uma rota nova e um formato novo.
- Aplicar decay tambem sobre os positives no aparelho — cortado por ser matematicamente inerte: decay uniforme sobre todos os pesos nao muda ordem nenhuma. Decay local so tem efeito real na expiracao de negatives, que e o que a fase 1 faz.

**Riscos:**

- Media3 1.10.1 + One UI: o custom layout pode nao aparecer na gaveta de notificacao da Samsung (o painel de midia do One UI e proprio e limita botoes custom). SINAL ANTECIPADO: o build compila, o session aceita o comando, mas a notificacao no S24 continua com prev/play/next. Mitigacao: validar na PRIMEIRA hora da fase 6, antes de escrever o resto; se cair, a fase 2 ja entregou o like dentro do app e a fase 6 vira um corte, nao um retrabalho.
- MutexGuard de State<Library> atravessando .await nos commands novos (lib_toggle_like, lib_list_liked, lib_station_next async). SINAL ANTECIPADO: erro de compilacao 'future cannot be sent between threads safely' — ou, pior, se alguem contornar com block_on, o app trava ao curtir. Mitigacao: regra escrita no plano (resolver no plugin primeiro, travar a Library depois) e revisao especifica desses tres commands.
- LWW de like com relogio do aparelho desalinhado: um unlike do celular com timestamp adiantado apaga um like recente do desktop. SINAL ANTECIPADO: like some sozinho no desktop pouco depois de um ciclo de sync. Mitigacao: rejeitar evento com at mais de 300s no futuro e nunca inferir timestamp no receptor — so o do evento.
- Escrita em /storage/emulated/0/Music/.rustify/taste.json a partir do processo do app pode falhar mesmo com MANAGE_EXTERNAL_STORAGE (SAF, volume montado read-only apos sync). SINAL ANTECIPADO: pull devolve 200 e a idade do gosto em Settings nao muda. Mitigacao ja no contrato: fallback para <data_dir>/taste.json com load_intel preferindo o mais novo.
- Refactor do signal-core (fase 7) mexe no hot path do autoplay desktop e uma divergencia sutil passaria despercebida. SINAL ANTECIPADO: a regua do dia seguinte com contagem de positives/negatives ou skip-rate fora do padrao. Mitigacao: os testes existentes migram junto (assinatura publica intacta) e comparacao explicita antes/depois no mesmo Qdrant como criterio de pronto.
- Colisao de merge em AudioService.kt / AudioPlugin.kt / Settings.tsx com os epics de playback e de telas. SINAL ANTECIPADO: dois worktrees editando o MediaSession.Builder ou o mesmo bloco de setpanel. Mitigacao: worktree por epic (regra do projeto) e sequenciar quem entra primeiro nesses tres arquivos.
- Fases 3 a 5 so funcionam com o app DESKTOP novo instalado na cmr-auto, e essa instalacao e manual. SINAL ANTECIPADO: sync do celular devolvendo 404 em /sync/likes ou /sync/taste com o APK correto. Mitigacao: o painel Sinal (fase 5) mostra o erro literal; e o bump de versao antes do release.sh e obrigatorio, senao o .deb da versao anterior e sobrescrito por um binario diferente com o mesmo nome.

**Decisões do CEO neste epic:**

- **Matar a replica Python da derivacao de gosto (build_taste do export_manifest.py) em favor do GET /sync/taste servido pelo desktop?**  
  Recomendação: **Cortar a replica.** — Hoje a matematica do v3 vive em dois lugares e a fase 7 traria um terceiro; cortar a Python e (na fase 7) extrair o signal-core deixa UMA implementacao — o custo e o export passar a exigir o app desktop no ar, o que ele ja exige indiretamente (usa ssh para a cmr-auto para stations e capas).
- **Como o rank ponderado deve tratar o weight null, que e exatamente como o like explicito e exportado?**  
  Recomendação: **Peso maximo.** — Like e o unico sinal explicito do usuario; qualquer politica que nao seja topo rebaixa justamente o que voce marcou a mao em favor do que o algoritmo inferiu.
- **Agora que o receptor passa a DEVOLVER dados (GET /sync/taste), colocar autenticacao na porta 19878?**  
  Recomendação: **Nada agora, com o gatilho escrito na spec: primeiro dispositivo nao-pessoal na tailnet, ou receptor fora dela.** — O que vaza sao ids de faixas do proprio dono dentro da tailnet dele; o token, por outro lado, quebra um sync que funciona assim que os dois lados sairem de sincronia — mesmo racional do JWT RESERVADO ja registrado no CLAUDE.md.
- **Cadencia do pull de gosto no aparelho.**  
  Recomendação: **Boot + 6h + botao.** — taste.json tem poucos KB, entao 60s nao machuca mas tambem nao entrega nada perceptivel; so o botao devolve ao humano o problema que o epic existe para tirar dele.
- **A fase 7 (saldo local derivado do journal, 8h, a unica L do epic) entra agora ou depois de medir?**  
  Recomendação: **Adiar e medir.** — Com gosto fresco a cada 6h, o unico caso que sobra e o modo aviao e a janela de ate 6h — se a regua mostrar que o skip-rate do station no s24 nao melhorou apos a fase 4, a fase 7 se justifica sozinha; se melhorou, sao 8h e um crate novo por um caso de borda.

---

## Epic E — Histórico e play_count locais no S24

**Onda 2** · 4 fases · 15.5h estimadas pelo planejador

> O dado já existe e é destruído: o EventJournal do service grava cada transição de faixa com fsync, e o `ack_events` do worker de sync compacta o arquivo assim que o desktop confirma o POST. A estratégia é interceptar os eventos ANTES do ack, no lado Rust do app (nenhuma linha de Kotlin/Media3 muda), materializando um log próprio append-only em `<data_dir>/history.jsonl` — daí saem a tela History, o rail "Tocadas recentemente" e o play_count local. O contador global (o que o desktop acumulou) entra por um segundo trilho, barato: dois campos novos no manifest exportado, somados ao local na hora de exibir.


### E1 — Trilho de histórico local (journal → history.jsonl → tela History) · ~5h

**Entrega:** O usuário abre Library → Coleções → Histórico e vê as faixas que tocou no aparelho, mais recente primeiro, com "há X min/h/d". Tocar uma linha toca a partir dela. Sobrevive a fechar o app, a matar o processo e ao sync com o desktop.

**Critério de pronto:** No S24: Library → Coleções → Histórico lista as faixas tocadas na sessão, ordem decrescente, com "há X" na coluna da direita; tocar uma linha inicia a reprodução a partir dela; a lista sobrevive a force-stop + reabertura E a um ciclo de sync bem-sucedido com o desktop.

**Gaps cobertos:** `lib-sem-historico`, `historico-play-count-mobile`, `screen-history`

**Arquivos:**

- src-tauri/src/mobile_history.rs — NOVO. Módulo cross-target (std+serde apenas, como mobile_intel/mobile_library): tipos, parsing/serialização de linha, fold puro e o store de arquivo. Ponte com o plugin fica em `#[cfg(target_os = "android")]`.
- src-tauri/src/lib.rs — registrar `pub(crate) mod mobile_history;` no bloco cross-platform com o mesmo `#[cfg_attr(not(target_os = "android"), allow(dead_code))]` dos vizinhos (linhas 11-19), para os testes puros rodarem no host.
- src-tauri/src/mobile_sync.rs — `JournalEvent` ganha o campo `seq` (o plugin já o envia; a struct atual o descarta). `sync_once` recebe `&HistoryStore` e ingere os eventos drenados ANTES do POST e, portanto, antes do `ack_events` da linha 155. `worker::spawn` constrói o store a partir do `data_dir` que já resolve na linha 91.
- src-tauri/src/mobile.rs — command novo `lib_list_history` (async, AppHandle + State) e ingestão no `setup` (linhas 134-142), antes de o worker subir; entrada no `generate_handler!` (linha 143).
- src-tauri/src/mobile_library.rs — `Track` (linha 49) ganha `play_count: u32` e `last_played: Option<i64>` (default 0/None nesta fase); método `history_tracks(&self, stats: &[HistoryStat], limit: usize) -> Vec<Track>` resolvendo id→Track e carimbando os dois campos.
- src/mobile/types.ts — `Track` ganha `play_count: number` e `last_played: number | null`.
- src/mobile/ipc.ts — `libListHistory` no bloco de biblioteca.
- src/mobile/derive.ts — `fmtAgo(ts)` pt-BR (pura, coberta por vitest). NÃO reusar `relTime` de src/lib/format.ts: ele é hardcoded em inglês ("min ago") e o resto da UI mobile é pt-BR.
- src/mobile/derive.test.ts — casos de fmtAgo.
- src/mobile/store.ts — signal `history` + `loadHistory()`; chamada no fim de `bootStore()` e sempre que `pb.trackId` MUDA dentro de `applyState` (nunca no tick de position, que roda 2x/s).
- src/mobile/screens/History.tsx — NOVO (porte de S.history do handoff, sem os chips nesta fase).
- src/mobile/MobileApp.tsx — `case "/history"` no `screen()` (linhas 54-76).
- src/mobile/nav.ts — `/history` mapeado para a aba `/library` em `activeTab()` (linhas 64-71).
- src/mobile/screens/Library.tsx — linha "Histórico" na seção Coleções (linhas 118-127) e correção do cabeçalho do arquivo, que hoje declara History fora de escopo (linhas 6-8).

**Contratos novos:**

- Rust: `pub struct HistoryEntry { pub uuid: String, pub seq: i64, pub track_id: String, pub played_at: i64, pub end_position_ms: i64, pub duration_ms: i64, pub event_type: String, pub origin: String }`
- `Rust: `pub struct HistoryStat { pub track_id: String, pub last_played: i64, pub play_count: u32 }``
- Rust: `pub fn fold_history(entries: &[HistoryEntry]) -> Vec<HistoryStat>` — dedupe por `uuid`, conta só o que passa em `counts_as_play`, agrupa por track_id, ordena por `last_played` desc. Faixas DISTINTAS, igual ao desktop (list_history escaneia enrichments por last_played, não um log de plays).
- Rust: `pub fn counts_as_play(e: &HistoryEntry) -> bool` — `end_position_ms >= MIN_LISTEN_MS (20_000)` OU `end_position_ms as f64 / duration_ms as f64 >= MIN_LISTEN_PCT (0.25)`. Consts públicas no topo do módulo.
- Rust: `pub struct HistoryStore { path: PathBuf, state_path: PathBuf }` com `new(data_dir: &Path)`, `ingested_seq(&self) -> i64`, `append(&self, entries: &[HistoryEntry]) -> Result<usize, String>` (filtra `seq <= ingested_seq`, appenda, grava watermark, compacta), `read(&self) -> Vec<HistoryEntry>`, `stats(&self) -> Vec<HistoryStat>`.
- Rust: `impl HistoryEntry { pub fn from_journal(ev: &crate::mobile_sync::JournalEvent) -> Self }` — `played_at = if started_at > 0 { started_at } else { timestamp }` (paridade com o desktop, que carimba no INÍCIO do play via record_play).
- Rust (android): `pub(crate) async fn ingest_from_journal(app: &tauri::AppHandle, store: &HistoryStore) -> Result<usize, String>` — `app.rustify_audio().drain_events(store.ingested_seq()).await`, mapeia e appenda. NÃO chama `ack_events`: o ack é exclusivo do worker de sync.
- Rust: `#[tauri::command] async fn lib_list_history(app: tauri::AppHandle, lib: State<'_, Library>, limit: Option<usize>) -> Result<Vec<Track>, String>` — ingere (await), SÓ DEPOIS trava o Mutex da Library, resolve e devolve `limit.unwrap_or(200)` tracks. O `MutexGuard` nunca atravessa um `.await`.
- Arquivos: `<app_data_dir>/history.jsonl` (uma linha JSON por evento, append-only, fsync no fechamento do append) e `<app_data_dir>/history_state.json` = `{"ingested_seq": <i64>}`. Retenção: `KEEP_ENTRIES = 2000`, compactação quando passar de `COMPACT_AT = 2400` (reescreve o tail em .tmp + rename atômico, mesmo padrão do EventJournal.compact).
- `TS: `export const libListHistory = (limit?: number) => invoke<Track[]>("lib_list_history", { limit });``
- `TS: `Track.play_count: number`, `Track.last_played: number | null`.`
- `Rota: `#/history` (hash router existente; o botão voltar do Android já funciona de graça).`

**Testes:**

- cargo test (host): `fold_history` dedupe por uuid quando o mesmo evento é ingerido duas vezes (POST falhou, journal re-drenado).
- cargo test: `fold_history` ordena por last_played desc e conta N plays da mesma faixa numa entrada só.
- cargo test: `counts_as_play` — skip aos 3s NÃO conta; skit de 25s conta; faixa de 200s ouvida até 60s (30%) conta.
- cargo test: `HistoryStore::append` filtra `seq <= ingested_seq` (idempotência do re-drain) e avança o watermark.
- cargo test: compactação preserva exatamente as KEEP_ENTRIES últimas linhas e o arquivo continua parseável.
- cargo test: `HistoryEntry::from_journal` usa `started_at` e cai em `timestamp` quando `started_at == 0`.
- vitest: `fmtAgo` (agora / há 12 min / há 3 h / há 2 d / null → "—").
- npm run typecheck.
- Smoke S24: tocar 3 faixas deixando cada uma passar de 30s, matar o app (`adb shell am force-stop dev.cmr.rustifyplayer`), reabrir, abrir /history.
- Smoke S24 do risco central: com o app desktop LIGADO (receptor de sync de pé), esperar um ciclo de 60s, confirmar `mobile-sync: lote entregue` no log e verificar que /history CONTINUA mostrando as faixas — é a prova de que o ack não destrói o histórico.

### E2 — Home: rail "Tocadas recentemente" + contagem local e filtro por período · ~2.5h

**Entrega:** A Home deixa de ser cega ao que acabou de tocar: rail com as 8 últimas e link "Ver histórico →". Na tela History, chips de período (Hoje / Semana / Mês / Tudo) e a contagem local por faixa ("3×") na segunda linha.

**Critério de pronto:** No S24: depois de tocar uma faixa, ela aparece no topo do rail da Home em até um retorno à tela; a mesma faixa tocada 3 vezes aparece UMA linha com "3×" na segunda linha; o chip "Hoje" esconde o que é de ontem.

**Depende de:** 1

**Gaps cobertos:** `lib-sem-historico`, `home-rails-recomendacao`

**Arquivos:**

- src/mobile/screens/Home.tsx — rail novo entre os quick starts e "Based on your favorites", usando `SecHead` com `link` (já suporta) e `TrackRow` com `right={fmtAgo(t.last_played)}`; corrigir o cabeçalho do arquivo (linhas 6-10), que declara "Recently played segue fora".
- src/mobile/screens/History.tsx — chiprow de período (mesmo padrão de FACETS em Library.tsx:37-45) e `sub` do ViewHead com "N faixas ouvidas neste aparelho".
- src/mobile/derive.ts — `filterByPeriod(tracks, period)` pura.
- src/mobile/derive.test.ts — casos de filterByPeriod nas bordas (meia-noite de hoje, 7 dias, 30 dias).
- src/mobile/components/TrackRow.tsx — nenhuma mudança estrutural; o `sub` composto ("artista · 3×") é montado na History/Home e passado pela prop `sub` que já existe.

**Contratos novos:**

- `TS: `export type HistoryPeriod = "today" | "week" | "month" | "all";``
- `TS: `export function filterByPeriod(tracks: Track[], period: HistoryPeriod, now?: number): Track[]` — corta por `last_played`; `today` é a partir da meia-noite local, não 24h.`
- `Sem chave de localStorage: o período volta ao default "Tudo" a cada entrada (estado efêmero de tela, não preferência).`

**Testes:**

- vitest: filterByPeriod nas quatro faixas de tempo, incluindo track com last_played null (some de todos menos "all").
- npm run typecheck.
- Smoke S24: Home mostra o rail depois de tocar; "Ver histórico" navega; os chips reduzem a lista e "Tudo" a restaura.

### E3 — play_count e last_played do desktop no manifest, somados ao local · ~3h

**Entrega:** O aparelho passa a saber quantas vezes cada faixa foi tocada NO TOTAL (desktop + celular), não só desde que o APK foi instalado. O histórico do aparelho continua sendo só do aparelho; o contador é somado.

**Critério de pronto:** No S24, com manifest schema 2 instalado: a tela History mostra, para uma faixa que o desktop já tocou 12 vezes e o celular 1, a contagem 13; e o APK continua funcionando (biblioteca completa, sem tela vazia) se o manifest instalado ainda for o schema 1.

**Depende de:** 1

**Gaps cobertos:** `lib-sem-play-count`

**Arquivos:**

- scripts/android/export_manifest.py — `fetch_play_stats(base_url) -> dict[int, dict]` novo (scroll em `track_enrichments` com `{"should": [{"key":"play_count","range":{"gt":0}}, {"key":"last_played","range":{"gt":0}}]}`, `with_payload: {"include": ["play_count","last_played"]}`, limit 10000 — mesmo padrão de `recent_likes`, linhas 211-224); `build_manifest(points, stats)` carimba os dois campos por track_id; `"schema": 2`; `main()` passa o dict novo.
- src-tauri/src/mobile_library.rs — `ManifestTrack` ganha `#[serde(default)] play_count: u32` e `#[serde(default)] last_played: Option<i64>` (o default é OBRIGATÓRIO: manifest schema 1 no aparelho não pode quebrar a biblioteca inteira); `Track` recebe os valores no load; `merge_local_stats(tracks: &mut [Track], stats: &[HistoryStat])`.
- src-tauri/src/mobile.rs — `lib_list_history` e `lib_get_tracks_by_ids` passam a devolver o valor somado; `lib_list_tracks` devolve só o exportado (não vale varrer o histórico para 1746 faixas a cada chamada).
- docs/android/ipc-contrato-v0.md — registrar os dois campos novos no Track e a semântica de soma.

**Contratos novos:**

- `manifest.json: `"schema": 2`; cada track ganha `"play_count": <int>` e `"last_played": <int|null>` (segundos unix). Campos AUSENTES em manifest antigo = 0/null por serde default.`
- Rust: `pub fn merge_local_stats(tracks: &mut [Track], stats: &[HistoryStat])` — `play_count = exportado + local`; `last_played = max(exportado, local)`. Não há dupla contagem: o sync do S24 só grava `play_events` no Qdrant (sync_receiver.rs), e `record_play` — quem incrementa o enrichment — é desktop-only. Os dois contadores são disjuntos por construção.
- `Semântica exposta na UI: o número é "total conhecido", congelado no export para a parte do desktop.`

**Testes:**

- cargo test: `merge_local_stats` soma contadores e escolhe o maior last_played; track sem stat local fica intacta.
- cargo test: manifest sem os campos novos (fixture schema 1) carrega sem erro e produz play_count 0.
- python: rodar `export_manifest.py --out-dir /tmp/rustify-export` (túnel 16333) e conferir com jq que N tracks têm play_count > 0 e que o total bate com um count no Qdrant.
- Smoke S24: após push do manifest novo + `lib_rescan`, uma faixa muito tocada no desktop mostra contagem alta e uma nunca tocada mostra ausência de contagem.

### E4 — Rails de recomendação da Home (Mais tocadas / Descobrir / Parecidas com o que você toca) · ~5h

**Entrega:** A Home passa a ter as três camadas do desktop, calculadas no aparelho: "Mais tocadas" (contador somado), "Descobrir" (nunca tocadas, rankeadas por afinidade) e "Parecidas com o que você toca" (multi-seed sobre vectors.bin, com cap de 2 por artista).

**Critério de pronto:** No S24 a Home mostra os três rails com conteúdo plausível e distinto entre si; sem `vectors.bin` no aparelho, "Parecidas" some e os outros dois continuam de pé (sem tela quebrada, sem lista vazia renderizada).

**Depende de:** 1, 3

**Gaps cobertos:** `home-rails-recomendacao`

**Arquivos:**

- src-tauri/src/mobile_intel.rs — `multi_seed_rank` novo, ao lado de `rank_pool` (linha 214), reusando `VectorIndex::cos`.
- src-tauri/src/mobile_library.rs — `Recommendations` + `recommendations(&self, stats: &[HistoryStat], limit: usize)`; helper `cap_per_artist` (o `crate::rerank::cap_per_artist` do desktop vive no library-indexer, que NÃO compila no Android — é reimplementação de ~15 linhas, não port).
- src-tauri/src/mobile.rs — `lib_recommendations` (async, ingere o journal antes de calcular) no handler.
- src/mobile/ipc.ts — `libRecommendations`.
- src/mobile/types.ts — `Recommendations`.
- src/mobile/store.ts — signal `recs` + `loadRecs()`, chamada no boot junto de `loadIntel()` e no refresh de histórico.
- src/mobile/screens/Home.tsx — três rails novos, cada um dentro de `<Show when={...length}>` (sem vectors.bin ou sem gosto, a seção some em vez de renderizar vazio — padrão já usado em stations/favorites).

**Contratos novos:**

- Rust: `pub fn multi_seed_rank(seeds: &[u64], candidates: &[u64], vectors: &VectorIndex, exclude: &HashSet<u64>) -> Vec<(u64, f32)>` — score = MAX cosseno contra os seeds (best_score, mesma escolha do desktop em query.rs:598-604, que evita o colapso de centroide), ordem decrescente; candidato sem vetor fica fora.
- `Rust: `pub struct Recommendations { pub most_played: Vec<Track>, pub based_on_top: Vec<Track>, pub discover: Vec<Track> }` — espelha `library_indexer::Recommendations` (query.rs:565).`
- Rust: `pub fn recommendations(&self, stats: &[HistoryStat], limit: usize) -> Recommendations`. most_played = play_count total > 0, desc, top `limit`, sem cap por artista (paridade com o desktop). based_on_top = seeds (taste.positives[..10] ∪ top 5 de most_played) → multi_seed_rank sobre o acervo resolvido, excluindo seeds e `taste.negatives`, cap 2/artista, top `limit`. discover = play_count total == 0 e sem histórico local, rankeadas pelo mesmo multi_seed_rank (fallback: ordem do manifest embaralhada por `shuffle_seed()` quando não há vetor/gosto), cap 2/artista.
- `Rust: `#[tauri::command] async fn lib_recommendations(app: tauri::AppHandle, lib: State<'_, Library>, limit: Option<usize>) -> Result<Recommendations, String>` (default limit 10).`
- `TS: `export const libRecommendations = (limit?: number) => invoke<Recommendations>("lib_recommendations", { limit });``

**Testes:**

- cargo test: `multi_seed_rank` — a faixa idêntica a um seed pontua ~1.0 e lidera; `exclude` remove o seed do resultado; candidato sem vetor não aparece.
- cargo test: `cap_per_artist` limita a 2 e preserva a ordem relativa; faixa com artist_name null não é agrupada com as outras (bucket próprio, não um "" compartilhado).
- cargo test: `recommendations` — discover não contém nada com play_count > 0 nem com histórico local; based_on_top não contém seed nem negative.
- npm run typecheck; vitest (sem regressão).
- Smoke S24: os três rails aparecem; "Descobrir" só traz faixa que o usuário não reconhece de ter tocado; tocar uma faixa do rail "Mais tocadas" e verificar, no ciclo seguinte, que ela subiu.

**Cortado deste epic:**

- lib-sem-historico — CORTADO: a tela mostrar o LOG cru (uma linha por play, a mesma faixa repetida 5x seguidas). O desktop entrega faixas DISTINTAS ordenadas por last_played (query.rs:522-533) e é o que faz sentido numa lista de bolso; o log cru fica no arquivo, disponível para quem precisar depois.
- lib-sem-play-count — CORTADO: badge de contagem em TODA linha de faixa (Library, Álbum, Artista, Busca). Custo real: merge do histórico em cada lista (incluindo a de 1746 faixas, a cada render) e poluição visual da linha. Fica só onde informa: tela History e rail "Mais tocadas".
- screen-history — CORTADO: qualquer mudança no plugin Kotlin/EventJournal (command novo de histórico, segundo arquivo escrito pelo service). A ingestão em Rust entrega o mesmo resultado sem tocar em Media3, que é a parte do sistema onde um erro custa uma sessão de debug no aparelho.
- screen-history — CORTADO: menu de contexto / long-press na linha do histórico ("rádio daqui", "ir ao álbum"). É o gap de long-press do epic de telas; a linha do histórico herda o que aquele epic entregar.
- historico-play-count-mobile — CORTADO: sincronizar o histórico de volta para o desktop, ou o desktop mandar histórico para o celular. Unidirecional continua unidirecional neste epic.
- home-rails-recomendacao — CORTADO: re-rank por vibe no `based_on_top` e continuidade de cap por artista entre lotes (resolve_artist_counts do desktop). O primeiro depende de enrichments que o manifest não exporta (outro epic); o segundo só importa em fila contínua, e estes rails são listas curtas de Home.

**Riscos:**

- MATA A FASE 1: ingerir DEPOIS do ack. Se a chamada de ingestão em `sync_once` ficar abaixo do `ack_events` (mobile_sync.rs:155), todo evento já sincado some do journal antes de virar histórico. Sinal antecipado: histórico esvazia logo após aparecer `mobile-sync: lote entregue` no log; se o desktop estiver desligado, o histórico funciona "perfeitamente" — justamente o padrão que denuncia o bug. Trava: o smoke com o desktop LIGADO está no critério de pronto da fase 1.
- MATA A FASE 1: `MutexGuard` da Library atravessando um `.await` no command async. O compilador deixa passar, mas o command engasga sob concorrência com o worker. Sinal antecipado: /history fica em branco ou pendurado quando aberto perto do minuto do ciclo de sync. Regra: `ingest(...).await` primeiro, lock depois, guard dropado antes de retornar.
- MATA A FASE 3: manifest schema 2 sem `#[serde(default)]` nos campos novos. O aparelho tem manifest schema 1 no cartão; um `Manifest` que exija os campos derruba TODA a biblioteca (load() cai no ramo de erro e devolve biblioteca vazia). Sinal antecipado: o APK novo mostra "Acervo vazio" e o log traz `manifest ausente/ilegível`. Teste de fixture schema 1 é obrigatório antes do build.
- DEGRADA A FASE 1: o primeiro ingest depois de dias sem sync (desktop desligado) processa um journal grande dentro do command. Sinal antecipado: abrir /history trava por segundos no S24. Mitigação já embutida: filtro por `seq > ingested_seq` (não relê o que já entrou) e ingestão também no `setup`, então o pior caso cai no boot, não no toque.
- PROCESSO: esquecer `bun run build` antes do `cargo tauri android build --debug`. Sinal antecipado: o APK instala e a UI é a antiga (nenhuma tela History). Regra dura do CLAUDE.md — não há beforeBuildCommand no tauri.conf.json.
- SILENCIOSO: relógio do celular. `played_at` vem de `System.currentTimeMillis()` no service; ajuste de fuso/hora produz "há -3 h" ou ordenação estranha. Sinal antecipado: entrada no futuro no topo da lista. Mitigação barata: `fmtAgo` trata diff negativo como "agora".

**Decisões do CEO neste epic:**

- **O que conta como "tocada" no histórico e no play_count do aparelho?**  
  Recomendação: **Só o que passou de 20s OU 25% (consts MIN_LISTEN_MS / MIN_LISTEN_PCT em mobile_history.rs, mudáveis numa linha)** — O desktop inclui skip instantâneo por acidente de implementação (record_play roda no início e não tem como voltar atrás); no celular o dado chega no FIM do play, então dá para acertar de graça — e um histórico poluído por 4 segundos de faixa errada é pior que a paridade.
- **O número de plays mostrado no aparelho é o total (desktop + celular) ou só o local?**  
  Recomendação: **Somado** — Sem somar, quase todo o acervo aparece com 0 e o rail "Mais tocadas" fica inútil por semanas; a parte do desktop congela na data do export, o que é impreciso mas nunca enganoso (só subconta), e as duas fontes são disjuntas por construção.
- **A tela History deve mostrar também o que foi tocado NO DESKTOP (via last_played exportado)?**  
  Recomendação: **Só este aparelho** — O unificado exigiria export frequente do manifest para não mentir sobre "ontem", e a pergunta que o usuário faz no celular é "o que eu estava ouvindo aqui"; o dado do desktop já entra onde importa (contador e rail de mais tocadas).
- **As escutas do celular devem passar a incrementar o play_count global no desktop (record_play a partir dos eventos sincados)?**  
  Recomendação: **Sim, mas em outro epic (fica fora deste)** — É ~1,5h no receptor desktop, mas mexe no write-path do sinal em produção (hoje o receptor só faz upsert idempotente em play_events; incrementar enrichment é escrita não-idempotente sob re-envio) — merece o cuidado de quem estiver com o epic de sinal/plataforma na mão.
- **Retenção e limpeza do histórico local**  
  Recomendação: **Cap de 2000 plays, sem UI de limpeza** — 2000 plays são meses de uso em ~240KB e o arquivo é privado do app; botão de limpar é superfície e código para um problema que ainda não existe — se aparecer, entra depois em 30 minutos.

---

## Epic D — Pipeline de dados desktop-&gt;celular: do cabo semanal ao artefato que chega sozinho

**Onda 3** · 8 fases · 40h estimadas pelo planejador

> O celular e um consumidor cego de quatro arquivos que so um humano com cabo USB consegue atualizar, e esses arquivos mentem por omissao: o manifest descarta o proprio cabecalho, joga fora disc_number, colapsa capa por PASTA (61 faixas com capa errada hoje, medido no Qdrant) e nao carrega NENHUMA anotacao de vibe — enquanto 826 de 1746 faixas (47%) nao tem sequer `dominant_color` no campo que o export le, porque a cor migrou pra `dominant_color_v3`/`dominant_palette_v4` em track_enrichments e o script ficou no legado. A estrategia e atacar em duas frentes que se pagam sozinhas: primeiro enriquecer e honestificar o manifest (cabecalho, capa por album, vibe, paleta, diagnostico visivel no aparelho), porque e barato e cada item ja tem o dado pronto do outro lado; depois trocar o cabo por um pull HTTP autenticado na tailnet SO PARA OS ARTEFATOS (6MB: manifest+vectors+taste+stations+capas), deixando os 13GB de audio no rail de adb que ja funciona — porque o que apodrece diariamente e a inteligencia (taste e stations mudam todo dia), nao o acervo (muda por leva do Crate).


### D1 — O aparelho passa a dizer o que sabe (frescor, resolucao, artefatos) + disc_number · ~4h

**Entrega:** O usuario abre Settings no S24 e ve de quando e o acervo que esta olhando, quantas faixas do manifest nao tem arquivo no cartao, quantos arquivos de audio existem no cartao que o manifest desconhece, e se vetores/taste/stations estao la. Album de 2 discos passa a tocar na ordem certa.

**Critério de pronto:** No S24: Settings mostra 'exportado ha Xd · 1746 faixas · schema 1 · cmr-auto' e tiles RESOLVIDAS/SEM ARQUIVO/ORFAOS/VETORES/STATIONS com numeros reais; renomear um .opus do cartao e dar Re-scan faz SEM ARQUIVO virar 1 e ORFAOS virar 1; um album de 2 discos lista o disco 1 completo antes do 2.

**Gaps cobertos:** `lib-manifest-freshness`, `lib-unresolved-invisivel`, `artefatos-ausentes-ux`, `lib-disc-number-descartado`, `extra: audio no cartao ausente do manifest e invisivel e nao contado`

**Arquivos:**

- src-tauri/src/mobile_library.rs — struct Manifest (linha 24) ganha schema/generated_at/source_device/music_root, todos #[serde(default)]; MobileLibrary guarda header + unresolved (hoje morre num tracing::warn na linha 269) + orphan_audio + lrc_files; propagar disc_number (hoje #[allow(dead_code)] na linha 38) pro Track; metodo stats() novo
- src-tauri/src/mobile.rs — command lib_stats + registro no generate_handler! (hoje 11 handlers, linhas 143-155)
- src/mobile/types.ts — interfaces LibraryStats e ArtifactStatus; Track.disc_number
- src/mobile/ipc.ts — libStats()
- src/mobile/store.ts — signal stats, carregado no boot (fora do caminho critico do bootCall) e apos rescan() (linha 302)
- src/mobile/screens/Settings.tsx — linha de frescor no head do painel Library + tiles novos + aviso quando artefato ausente (hoje so 4 tiles derivados de memoria, linhas 25-30)
- src/mobile/derive.ts — tracksOfAlbum (linha 106) ordena por (disc, track); fmtAgo(unix)
- src/mobile/derive.test.ts — casos novos

**Contratos novos:**

- `Rust: #[tauri::command] fn lib_stats(lib: State<Library>) -> LibraryStats`
- Rust: pub struct LibraryStats { schema: i64, generated_at: i64, source_device: String, music_root: String, manifest_tracks: usize, resolved: usize, unresolved: usize, orphan_audio: usize, lrc_files: usize, vectors: usize, taste_positives: usize, taste_negatives: usize, stations: usize, stations_dead: usize, artifacts: Vec<ArtifactStatus> }
- `Rust: pub struct ArtifactStatus { name: String, present: bool, size_bytes: u64, mtime: i64 }  // name em {manifest.json, vectors.bin, taste.json, stations.json}`
- `Rust: Track ganha pub disc_number: Option<i64> (None quando <= 0, mesmo padrao do track_number)`
- `TS: export const libStats = () => invoke<LibraryStats>("lib_stats")`
- `TS: fmtAgo(ts: number): string — "agora" | "ha 3 h" | "ha 3 dias" | "—" quando ts <= 0`

**Testes:**

- cargo test (host): manifest v1 SEM cabecalho parseia com schema=0/generated_at=0 e nao esvazia a biblioteca
- cargo test (host): stats() num tempdir com 3 faixas no manifest, 2 arquivos presentes e 1 arquivo extra no disco -> resolved=2, unresolved=1, orphan_audio=1
- vitest: tracksOfAlbum com (disc 2, faixa 1) antes de (disc 1, faixa 9) devolve o disco 1 inteiro primeiro
- vitest: fmtAgo em 0, agora e 3 dias atras
- smoke S24: Settings conferido contra o export conhecido (1746 faixas, 0 unresolved em 13/08)

### D2 — Manifest v2 parte 1: capa por ALBUM (nao por pasta) + thumb de 256px · ~5h

**Entrega:** Faixa solta baixada pelo Crate numa pasta de playlist passa a mostrar a propria capa em vez de herdar a primeira da pasta (61 faixas erradas hoje, medido); listas e grids passam a carregar um JPEG de ~20KB em vez do original (media de 400KB por capa no cache do desktop: 350MB/873 arquivos).

**Critério de pronto:** No S24, 3 das 61 faixas que hoje herdam capa de vizinho mostram a propria (na lista de Faixas e no NowPlaying); grid de Albuns rola sem stutter perceptivel; `adb shell du -sh /sdcard/Music/.rustify/covers` na casa de dezenas de MB e nenhum cover.jpg novo escrito por pasta pelo export.

**Depende de:** 1

**Gaps cobertos:** `lib-capa-por-pasta`, `cover-multiplas-por-album`, `cover-quality-cache`, `lib-covers-nao-cacheadas`

**Arquivos:**

- scripts/android/export_manifest.py — build_manifest (linha 124) emite "cover"/"cover_thumb" por faixa, derivados do cover_path do payload (covers/<sha>.webp -> <sha>.jpg), que ja e por ALBUM (pipeline.rs:631-639 usa hash de album|artista); deploy_covers (linhas 433-486, hoje dir_cover.setdefault por diretorio) vira deploy_cover_set: converte as 564 capas DISTINTAS pra {STAGING}/.rustify/covers/<sha>.jpg e <sha>@256.jpg, idempotente, e para de escrever cover.jpg por pasta
- src-tauri/src/mobile_library.rs — resolucao de capa: manifest.cover -> <MUSIC_ROOT>/.rustify/covers/<nome> quando existe; fallback pro mapa por diretorio atual (linhas 247-250); Track ganha album_cover_thumb_path
- src/mobile/types.ts — Track.album_cover_thumb_path
- src/mobile/components/Cover.tsx — prop thumb?: boolean, com fallback pro full
- src/mobile/screens/Library.tsx, src/mobile/screens/Search.tsx, src/mobile/components/TrackRow.tsx — passam thumb em lista/grid (hero de Album/Artist e NowPlaying seguem no full)

**Contratos novos:**

- `manifest.json (schema 2, aditivo): cada track ganha "cover": "<sha>.jpg"|null e "cover_thumb": "<sha>@256.jpg"|null, relativos a <MUSIC_ROOT>/.rustify/covers/`
- Layout novo no cartao: /storage/emulated/0/Music/.rustify/covers/<sha>.jpg e <sha>@256.jpg (walk_music ignora dirs que comecam com '.', mobile_library.rs:135 — esses arquivos nao poluem o indice por pasta; o assetProtocol do Android ja cobre /storage/emulated/0/Music/** via tauri.android.conf.json)
- `Rust: Track ganha pub album_cover_thumb_path: Option<String>`
- `TS: <Cover thumb /> usa album_cover_thumb_path quando presente`

**Testes:**

- cargo test (host): manifest v2 com cover presente em .rustify/covers -> album_cover_path aponta pra la; arquivo ausente -> cai no cover.jpg do diretorio; manifest v1 -> comportamento atual intacto
- vitest: Cover com thumb=true e thumb null cai no full sem quebrar
- smoke S24: pasta 'Rap & Hip-Hop' (14 capas distintas no mesmo diretorio, medido) mostra capa diferente por faixa

### D3 — Manifest v2 parte 2: vibe, cor v3 e paleta — com backfill da paleta no desktop · ~7h

**Entrega:** O aparelho passa a receber energy/valence/moods/activities/liked_at/play_count/lufs por faixa e a PALETA da capa (ate 3 familias). O ink adaptativo deixa de faltar em 26% do acervo (448 faixas hoje sem cor nenhuma, medido) e o fundo passa a respirar entre as cores da capa, como no desktop.

**Critério de pronto:** No S24: uma faixa hoje sem ink (das 448 sem cor) passa a ter; com Ink cycle ligado o fundo alterna entre as familias da capa e volta sempre pra dominante; Settings mostra 'vibe 1746/1746 · paleta ~1650/1746'; o export imprime a cobertura e ela nao regride entre execucoes.

**Depende de:** 1

**Gaps cobertos:** `enrichments-vibe-nao-exportados`, `lib-sem-mood-filtros-exportados (metade de DADO; a UI de filtro fica no epic de telas)`, `ink-cycle-palette`

**Arquivos:**

- src-tauri/src/desktop.rs — extrair de get_track_palette (linha 1400) uma fn palette_for(lib, &client, tid) -> Vec<String>; spawn_palette_backfill(handle) chamado no setup, varrendo tracks com cover_path e sem dominant_palette_v4 (975 hoje), throttle ~5/s, log a cada 100
- scripts/android/export_manifest.py — fetch_enrichments(base_url) nova (scroll de track_enrichments com energy/valence/mood_tags/activity_tags/dominant_palette_v4/dominant_color_v3/liked_at/play_count); build_manifest funde por track_id e bump "schema": 2; dominant_color deixa de sair do payload legado de rustify_tracks (826 vazios) e vira palette[0] -> dominant_color_v3 -> legado; imprime cobertura
- src-tauri/src/mobile_library.rs — ManifestTrack e Track ganham os campos, todos #[serde(default)]
- src/mobile/types.ts — Track ganha energy/valence/moods/activities/palette/liked_at/play_count/lufs
- src/mobile/adaptiveColor.ts — applyAdaptivePalette(palette) + ciclo de ink com pausa por visibilitychange (hoje so applyAdaptiveColor(dominant), linha 43)
- src/mobile/MobileApp.tsx — passa a paleta da faixa corrente em vez de dominant_color
- src/mobile/screens/Settings.tsx — knob 'Ink cycle' no painel Appearance + tile de cobertura de vibe/paleta

**Contratos novos:**

- manifest.json (schema 2, aditivo) por track: "energy": f64|null, "valence": f64|null, "moods": [str], "activities": [str], "palette": ["#rrggbb", ...] (ate 3, item 0 = dominante), "dominant_color": "#rrggbb"|null, "liked_at": i64|null, "play_count": i64, "lufs": f64|null
- Rust: Track ganha pub energy: Option<f64>, pub valence: Option<f64>, pub moods: Vec<String>, pub activities: Vec<String>, pub palette: Vec<String>, pub liked_at: Option<i64>, pub play_count: i64, pub lufs: Option<f64>
- `TS: applyAdaptivePalette(palette: string[] | null): void — substitui applyAdaptiveColor no call site`
- `TS: nextInkIndex(i: number, len: number): number — funcao pura do ciclo (wrap volta a 0)`
- `localStorage: kv-mobile-inkcycle = "on" | "off" (default on)`
- CSS var ja existente e ociosa: --bg-ink-morph (spectrum.ts:179 ja le) recebe o tau longo ANTES da troca de cor, igual ao desktop; PROIBIDO transition de custom property no :root (regra dura do projeto)

**Testes:**

- cargo test (host): manifest v2 completo e manifest v1 sem nenhum campo novo produzem o mesmo Track exceto defaults
- vitest: nextInkIndex faz wrap pra 0; o ciclo para com document.hidden e retoma no visibilitychange
- cargo test (desktop): palette_for devolve a paleta cacheada sem recomputar quando dominant_palette_v4 existe
- smoke desktop: app na cmr-auto com o backfill fechando (975 -> 0 pendentes) sem travar a UI
- smoke S24: faixa com 2+ familias troca a cor do fundo aos ~40s e volta pra dominante; 10 min de tela apagada sem o app subir em Battery usage

### D4 — Aliases de mood sem a terceira replica: o pool sai do parser canonico em Rust · ~3h

**Entrega:** Station de mood criada no desktop com query em alias ('relaxar', 'pesado', 'road trip', 'alta energia') deixa de chegar morta ao celular; station legitimamente vazia passa a dizer POR QUE esta vazia.

**Critério de pronto:** Criar no desktop uma station de mood com a query 'relaxar dirigindo', rodar o export, e ela chegar ao S24 com pool > 0 e tocar; station com query de lixo mostra 'query sem clima reconhecido' em vez de 'sem candidatas no acervo'.

**Gaps cobertos:** `stations-mood-vocabulario-truncado`

**Arquivos:**

- src-tauri/crates/library-indexer/src/bin/mood_parse.rs — bin novo chamando MoodFilters::parse (qdrant_client.rs:108+, com bigrams e aliases PT/EN) e imprimindo JSON
- scripts/android/export_manifest.py — mood_pool (linhas 378-398) chama o bin em vez de replicar MOOD_VOCAB/ACTIVITY_VOCAB (linhas 75-84); aplica genre/energy_min/energy_max/valence_min/valence_max; vocabularios locais viram fallback com WARNING; stations ganham pool_reason
- scripts/android/test_export_manifest.py — arquivo de teste novo pras funcoes puras do script (hoje nao ha teste nenhum)
- src-tauri/src/mobile_intel.rs — StationDef e StationMeta ganham pool_reason
- src/mobile/types.ts — StationMeta.pool_reason
- src/mobile/screens/Stations.tsx — mostra o motivo quando pool_size == 0 (hoje so '<n> candidatas', linha 64)

**Contratos novos:**

- `CLI: cargo run -q -p library-indexer --bin mood_parse -- "<query>" -> {"mood_tags":[..],"activity_tags":[..],"genre":null|"..","energy_min":null|f32,"energy_max":..,"valence_min":..,"valence_max":..}`
- `stations.json: cada station ganha "pool_reason": "ok" | "query_sem_tokens" | "sem_faixas_anotadas" | "parser_indisponivel"`
- `Rust: StationMeta ganha pub pool_reason: String`

**Testes:**

- cargo test (host): mood_parse resolve 'relaxar' -> activity chill, 'pesado' -> mood aggressive, 'road trip' -> activity driving, 'alta energia' -> energy_min 0.7
- python: test_export_manifest.py cobre mood_pool com parser fake (alias, query sem token, query sem faixas)
- smoke S24: station de alias criada no desktop aparece com contagem > 0 apos o export

### D5 — Letra que so existe fora do sidecar chega ao aparelho · ~2h

**Entrega:** Faixa cuja letra vive nas tags do arquivo ou no payload lyrics_text (lrclib plain) passa a ter letra no S24; hoje ela aparece sem o botao de letra e sem explicacao. 504 faixas sem lrc_path sao as candidatas (medido).

**Critério de pronto:** No S24, de 3 faixas hoje sem botao de letra, pelo menos 2 passam a mostrar a letra em modo unsynced (sem auto-scroll, sem linha ativa) e nenhuma faixa com letra sincronizada regride pra plain.

**Depende de:** 1

**Gaps cobertos:** `extra (biblioteca): letra no celular vem SO do sidecar .lrc — embedded_lyrics e lyrics_text nao viajam`

**Arquivos:**

- scripts/android/export_manifest.py — FIELDS (linha 51) ganha embedded_lyrics/lyrics_text/lrc_path; build_lyrics(points) novo escreve lyrics.json apenas pras faixas SEM lrc_path; deploy_artifacts (linha 489) passa a subir 5 arquivos
- src-tauri/src/mobile_library.rs — load_intel (linhas 161-196) carrega .rustify/lyrics.json num HashMap<u64,String>, opcional como os demais artefatos
- src-tauri/src/mobile.rs — lib_get_lyrics (linhas 93-111) ganha o fallback: sidecar -> mapa -> vazio
- src/mobile/screens/Settings.tsx — tile LETRAS 'N sidecar · M texto'

**Contratos novos:**

- `lyrics.json: {"schema":1,"generated_at":<unix>,"tracks":{"<track_id>":{"text":"...","source":"tags"|"lrclib"}}} — track_id STRING, como nos demais artefatos`
- Rust: lib_get_lyrics mantem a assinatura -> Vec<LyricLine>; o texto plain passa por mobile_lyrics::parse_lrc e sai com t=0 (a UI ja trata: isSynced em NowPlaying.tsx:46 desliga auto-scroll e rotula unsynced)
- `REGRA DURA respeitada: nada disso e gravado em embedded_lyrics do desktop nem vira sidecar .lrc — e artefato separado, so leitura`

**Testes:**

- cargo test (host): lib_get_lyrics resolve na ordem sidecar > lyrics.json > vazio (tempdir com as tres situacoes)
- smoke S24: faixa sem .lrc passa a mostrar o botao de letra e o card renderiza rolavel em modo unsynced

### D6 — Carga da biblioteca sai da main thread; re-scan para de congelar o app · ~4h

**Entrega:** A UI pinta imediatamente no boot e preenche sozinha quando a biblioteca fica pronta; Re-scan (e, depois, o pull de artefatos) nao congela a navegacao.

**Critério de pronto:** No S24 o app pinta a Home em ~300ms mesmo com o cartao frio, com 'carregando acervo…' no lugar das listas, e as listas aparecem sozinhas; durante o Re-scan da pra navegar entre Library/Search/Settings sem travar e o toast so aparece no fim.

**Gaps cobertos:** `lib-carga-sincrona-boot`, `rescan-nao-incremental`

**Arquivos:**

- src-tauri/src/mobile.rs — Library passa a guardar Arc<RwLock<MobileLibrary>> + AtomicBool ready; setup (linhas 134-142, hoje com MobileLibrary::load() sincrono no comentario 'v0 aceita o load sincrono') registra biblioteca vazia e spawna a thread; lib_rescan (linhas 114-120) vira async e spawna; ambos emitem o evento de pronto
- src-tauri/src/mobile_library.rs — construtor MobileLibrary::empty() extraido do caminho de erro que ja monta a estrutura vazia inline (linhas 212-219)
- src/mobile/store.ts — listener do evento refaz loadLibrary/loadIntel/stats; rescan() (linha 302) deixa de esperar o retorno; libReady dirigido pelo evento
- src/mobile/screens/Settings.tsx e src/mobile/screens/Library.tsx — estado 'carregando' vindo de LibraryStats.loading

**Contratos novos:**

- `Rust: #[tauri::command] async fn lib_rescan(app: tauri::AppHandle, lib: State<'_, Library>) -> Result<(), String>  // NAO devolve mais a contagem (hoje -> usize); ela chega pelo evento`
- `Evento Tauri: "rustify://library-ready" com payload { tracks: usize, unresolved: usize, elapsed_ms: u64 }`
- `Rust: LibraryStats ganha pub loading: bool`
- `TS: rescan() nao resolve mais com contagem; o toast e disparado pelo listener`

**Testes:**

- cargo test (host): MobileLibrary::empty() responde folders()/all_tracks()/stats() sem panic
- cargo test (host): lib_stats com loading=true nao bloqueia (read do RwLock enquanto a thread so escreve no final)
- smoke S24: cronometrar do tap ate a primeira pintura; navegar entre abas durante um Re-scan

### D7 — O rail vira infraestrutura: versionado, autenticado e servido pela tailnet · ~8h

**Entrega:** O desktop passa a SERVIR os artefatos por HTTP autenticado na tailnet (mesma porta 19878 do sync de eventos), o export passa a rodar sozinho todo dia na VM com log de delta ('+12 faixas, -3'), e os scripts que hoje so existem no home da cmr-auto entram no repo. Entrega no rail, nao na tela — o payoff no aparelho e a fase 8.

**Critério de pronto:** Da VM: curl -H 'Authorization: Bearer <token>' http://100.102.249.9:19878/sync/artifacts/index lista manifest/vectors/taste/stations/lyrics + capas com mtime do dia; sem header devolve 401; o timer roda 03:00 e o log mostra a linha de delta.

**Depende de:** 2, 3

**Gaps cobertos:** `transferencia-acervo-fora-do-repo`, `lib-sync-incremental`, `sync-inverso-manual (metade desktop)`, `extra (plataforma): sync receiver sem autenticacao nenhuma`, `extra (plataforma): android:allowBackup default true leva device.json e journal pro backup do Google`

**Arquivos:**

- scripts/android/phone_sync_encode.py — copia versionada de ~/phone_sync_encode.py da cmr-auto (FLAC->Opus 192k, capas re-embutidas por mutagen, fallback -ac 2 pra 5.1)
- scripts/android/phone_push.sh — copia versionada de ~/phone_push_retry.sh (adb push --sync com retry e limpeza do parcial)
- scripts/android/sync_all.sh — orquestrador encode -> export --deploy -> push, com --dry-run
- scripts/android/export_daily.sh — garante o tunel SSH 16333 (idempotente) e roda o export com --deploy --delta
- docs/android/rail-de-acervo.md — contrato de sanitizacao de nome (quem renomeia e a camada de storage do Android, NAO os scripts) e sua relacao com canon_stem (mobile_library.rs:87)
- scripts/android/export_manifest.py — flag --delta: compara com manifest.prev.json no out-dir, imprime '+N -M' e grava delta.json
- src-tauri/src/sync_receiver.rs — Bearer obrigatorio em todas as rotas (handle, linhas 102-151); GET /sync/artifacts/index e GET /sync/artifacts/<name>; diretorio servido configuravel
- src-tauri/gen/android/app/src/main/AndroidManifest.xml — android:allowBackup="false" no <application> (linha 12)

**Contratos novos:**

- HTTP (desktop, bind so no IP tailscale, como hoje): GET /sync/artifacts/index -> {"generated_at":<unix>,"files":[{"name":"manifest.json","size":N,"mtime":N}, ...],"covers":[{"name":"<sha>@256.jpg","size":N,"mtime":N}, ...]}
- `HTTP: GET /sync/artifacts/<name> e GET /sync/artifacts/covers/<name> -> bytes (whitelist: nome sem '/' e sem '..', extensoes json|bin|jpg)`
- `HTTP: Authorization: Bearer <token> obrigatorio em TODAS as rotas, inclusive no POST /sync/events; 401 sem header. Token em <data_dir>/sync_token (32 hex, gerado no primeiro boot, 0600)`
- `Env: RUSTIFY_SYNC_ARTIFACTS_DIR (default ~/.cache/phone-sync/Music/.rustify — onde o deploy_artifacts ja escreve)`
- `Arquivo: <out-dir>/delta.json = {"generated_at":N,"added":["<track_id>"],"removed":["<track_id>"]}`
- `systemd user na VM (fora do repo, documentado como a regua): rustify-export.timer diario 03:00 -> export_daily.sh`

**Testes:**

- cargo test (host): 401 sem Bearer e 200 com; /sync/artifacts/index lista os arquivos de um tempdir; '../etc/passwd' rejeitado; o teste existente post_de_lote_conta_aceitos_e_rejeitados passa a mandar o header e continua verde
- python: test_export_manifest.py cobre o delta (manifest.prev ausente -> delta vazio, nunca 'tudo novo'; adicao e remocao)
- bash: sync_all.sh --dry-run lista as 3 etapas e falha claro se ffmpeg/adb/tunel faltarem
- fidelidade: diff dos scripts versionados contra os da cmr-auto vazio (a menos do header de origem)

### D8 — OTA no aparelho: puxar os artefatos sem cabo + enxergar o sync · ~7h

**Entrega:** O usuario aperta 'Atualizar do desktop' no S24 (ou volta pro app e e avisado de que ha acervo novo) e a inteligencia inteira — manifest, vetores, gosto, stations, letras, capas — se atualiza em segundos pela tailnet, sem cabo, sem VM, sem adb. E passa a ver o estado do sync de eventos, hoje invisivel.

**Critério de pronto:** No S24 com o desktop ligado na tailnet: 'Atualizar do desktop' baixa os artefatos em menos de ~10s, a Home mostra a station criada no desktop minutos antes e o toast diz '+N faixas, -M'; o painel Sync mostra 'ultima atualizacao agora · 0 eventos pendentes'; tocar 2 faixas e mandar o app pro background sobe os eventos na hora (a regua do dia seguinte mostra s24 sem buraco).

**Depende de:** 6, 7

**Gaps cobertos:** `sync-inverso-manual (metade device)`, `lib-no-fs-watcher (substituido pelo auto-check no resume)`, `extra (plataforma): frontend nao tem NENHUM caminho pra observar o sync`, `extra (plataforma): worker dorme 60s ANTES do primeiro ciclo e nao ha flush ao ir pro background`

**Arquivos:**

- src-tauri/src/mobile_sync.rs — plan_downloads pura (testavel no host) + modulo de pull no worker android; sync_once passa a rodar ANTES do primeiro sleep (hoje loop { sleep; sync_once }, linhas 103-108); endpoint() (linha 78) passa a ler token e base sem path
- src-tauri/src/mobile.rs — commands sync_pull, sync_status e sync_flush + registro no handler
- src/mobile/ipc.ts — syncPull/syncStatus/syncFlush
- src/mobile/store.ts — acao de pull; visibilitychange (hoje so re-sincroniza estado, linhas 381-384) passa a chamar sync_flush ao esconder e o auto-check do index ao voltar, com gate de 1h
- src/mobile/screens/Settings.tsx — painel Sync: botao 'Atualizar do desktop', ultima atualizacao, eventos pendentes, endpoint
- docs/android/ipc-contrato-v0.md — commands novos

**Contratos novos:**

- Rust: #[tauri::command] async fn sync_pull(app: tauri::AppHandle) -> Result<PullReport, String>  // baixa em <MUSIC_ROOT>/.rustify/.incoming/<name> e faz rename atomico; ao final dispara o caminho assincrono de reload da fase 6
- `Rust: pub struct PullReport { downloaded: usize, skipped: usize, bytes: u64, covers: usize, tracks_added: usize, tracks_removed: usize }`
- `Rust: #[tauri::command] fn sync_status(app: tauri::AppHandle) -> SyncStatus { pending_events: usize, last_ack_seq: u64, last_post_at: i64, last_pull_at: i64, endpoint: String, has_token: bool }`
- `Rust: #[tauri::command] async fn sync_flush(app: tauri::AppHandle) -> Result<usize, String>`
- `Rust: pub(crate) fn plan_downloads(local: &[(String, u64, i64)], remote: &RemoteIndex) -> Vec<String>  // baixa o que difere em (size, mtime); pura, testada no host`
- sync.json (data dir do app): {"endpoint":"http://100.102.249.9:19878","token":"<hex>"} — endpoint sem path (/sync/events e /sync/artifacts saem do mesmo base); parser tolerante ao formato antigo com o path completo
- `localStorage: kv-mobile-lastcheck = <unix> (gate de 1h do auto-check)`
- `NOTA de arquitetura: todo HTTP e feito no Rust com ureq (sem TLS, tailnet e o canal) — a CSP do WebView NAO ganha host novo`

**Testes:**

- cargo test (host): plan_downloads baixa o que mudou de tamanho, o que mudou de mtime, e nada quando iguais; nome com '/' ou '..' vindo do index e descartado
- cargo test (host): payload_mobile_identico_ao_do_desktop e signal_schema_espelha_o_canonico continuam verdes (nada aqui muda semantica de sinal — SIGNAL_SCHEMA segue 3)
- vitest: o gate de 1h do auto-check nao dispara duas vezes seguidas
- smoke S24: criar station no desktop, puxar e ver aparecer; com o desktop desligado, o botao falha com mensagem e a biblioteca atual continua intacta

**Cortado deste epic:**

- lib-no-indexer-manifest-only (XL) — CORTADO por inteiro. Indexar tags no aparelho produziria faixas SEM o track_id canonico (hash do path absoluto da cmr-auto), que e o que sustenta o sync de play_events e o casamento com vectors.bin/taste/stations. Ganhariamos autonomia local e perderiamos o motor. O sintoma real (dado novo demora a chegar) e resolvido pelas fases 7-8.
- lib-no-fs-watcher (M) — CORTADO como watcher. FileObserver em /sdcard sob scoped storage e caro e furado, e o watcher do desktop so olha .flac (watch.rs:6) enquanto o acervo do S24 e .opus — nao e copy-paste. Substituido pelo auto-check barato no resume da fase 8 (GET de ~2KB comparando generated_at).
- lib-metadados-tecnicos (XS, ja OVERSTATED pelo cetico) — CORTADO. sample_rate/bit_depth/channels/replaygain descrevem o FLAC da cmr-auto, nao o Opus 192k do cartao: exportar direto MENTE. Nao ha DSP, tela Signal nem normalizacao no Android que os consuma. Unica excecao mantida: lufs_integrated viaja por custo ~zero, declaradamente sem consumidor nesta fase.
- OTA de audio (13GB) — CORTADO deste epic (decisao 1). O cabo continua sendo o rail de audio; foreground service, doze e horas de download nao se pagam contra um adb push que ja funciona uma vez por leva.
- Geracao de thumbnails NO APARELHO — CORTADA. Gastaria CPU e armazenamento do celular pra refazer o que o export faz uma vez pras 564 capas distintas.
- Terceira replica do parser de mood em Python — CORTADA (fase 4 substitui por bin Rust chamando MoodFilters::parse). Nao vale 'melhorar' a replica: cada divergencia e silenciosa por construcao, como o proprio aviso impresso pelo script admite.
- Filtro/chips de mood na UI mobile — FORA deste epic (epic de telas). Aqui entra so o dado; construir a UI aqui duplicaria trabalho com quem esta desenhando as telas a partir do handoff.

**Riscos:**

- Manifest v2 com campo NAO-opcional derruba a biblioteca inteira no S24 — o load e all-or-nothing (mobile_library.rs:205-221 devolve biblioteca vazia em qualquer erro de parse). Sinal antecipado: Settings mostrando 0 faixas e a linha 'manifest ausente/ilegivel' em `adb shell run-as dev.cmr.rustifyplayer tail logs/rustify-player.log`. Mitigacao dura: todo campo novo com #[serde(default)] e teste de parse com fixture v1 em toda fase que toca o schema.
- Deploy das 564 capas x 2 tamanhos por ffmpeg via SSH falha parcialmente sem ninguem ver — hoje o job so imprime um resumo. Sinal antecipado: a linha 'covers: N convertidas, M falhas' com M > 0. Mitigacao: sync_all.sh aborta o push com failed > 0 e o tile de artefatos da fase 1 mostra a contagem de capas presentes.
- Ciclo de ink queimando bateria com a tela apagada (setInterval sobrevivendo ao background do WebView). Sinal antecipado: o app aparecendo em Battery usage do S24 depois de uma noite; medir com 10 min de tela apagada antes de liberar. Mitigacao: clearInterval no visibilitychange, coberto por teste e por smoke.
- Token dessincronizado entre desktop e celular faz o sync de eventos parar em 401 EM SILENCIO — hoje o worker so faz tracing::debug no ciclo que falha (mobile_sync.rs:105-107). Sinal antecipado: sync_status com pending_events crescendo e last_post_at velho; a regua diaria perdendo o device s24 no breakdown. Mitigacao: painel Sync da fase 8 + toast quando pending > 200.
- Pull rodando enquanto commands lib_* seguram o lock da biblioteca -> ANR no Android. Sinal antecipado: o app congelar ao apertar 'Atualizar do desktop'. Mitigacao estrutural: a fase 6 e pre-requisito declarado da 8, e o download escreve em .incoming com rename atomico, segurando o lock so no swap.
- Backfill de paleta no boot do desktop competindo com indexer e Qdrant (975 decodes de webp + writes de enrichment). Sinal antecipado: UI do desktop lenta nos primeiros minutos apos abrir. Mitigacao: throttle 5/s, so faixas com cover_path e log de progresso a cada 100 pra dar pra abortar.
- Delta do export divergir (manifest.prev.json perdido) e reportar 'todas as faixas entraram'. Sinal antecipado: delta.json com added > 500. Mitigacao de projeto: o delta e SO relatorio — o download real e decidido por (size, mtime) por arquivo; delta ausente vira lista vazia, nunca 'tudo novo'.
- Mudanca de semantica de origins/sinais entrando de carona: nada aqui muda o significado dos eventos, entao SIGNAL_SCHEMA segue 3. Sinal de violacao: signal_schema_espelha_o_canonico ou payload_mobile_identico_ao_do_desktop quebrando — nesse caso e bump obrigatorio do schema, nao conserto do teste.

**Decisões do CEO neste epic:**

- **O OTA cobre so os artefatos de inteligencia (6MB) ou tambem o audio (13GB)?**  
  Recomendação: **So artefatos** — O que apodrece diariamente e a inteligencia (taste e stations mudam todo dia mesmo sem faixa nova); audio muda por leva — 6MB de download resolve a maior parte da defasagem por uma fracao minuscula do custo, e audio OTA arrasta foreground service, doze, cota de dados e horas de transferencia.
- **O export passa a rodar sozinho todo dia na VM por systemd timer, ou continua manual?**  
  Recomendação: **Timer diario** — Sem export automatico, o OTA so entrega um snapshot velho mais rapido; com timer, o gosto e as stations do celular ficam no maximo 24h atras do desktop sem ninguem lembrar de nada.
- **O Bearer no POST /sync/events vira obrigatorio de imediato (flag day com o APK novo) ou tem janela de compatibilidade?**  
  Recomendação: **Obrigatorio ja** — A mesma porta passa a servir a biblioteca inteira e ja e o unico write-path aberto no sinal de producao (hoje qualquer host da tailnet faz upsert no Qdrant sem token); a janela so importaria se voce nao instalasse o APK novo no mesmo dia.
- **Rodar backfill de dominant_palette_v4 no boot do desktop (975 faixas sem paleta, 448 sem cor nenhuma) ou seguir com o calculo lazy no primeiro play?**  
  Recomendação: **Backfill em background** — No celular o ink e por faixa tocada e nao ha como calcular la; lazy significa que a faixa so ganha cor no aparelho depois de ser tocada no desktop E de um export novo — 26% do acervo ficaria sem ink por tempo indeterminado.
- **Manifest v2 e aditivo (parser tolerante nos dois lados) ou flag day de schema?**  
  Recomendação: **Aditivo** — O load do mobile e all-or-nothing (falha de parse = biblioteca VAZIA, mobile_library.rs:205-221); flag day transforma qualquer descompasso de ordem entre export e instalacao do APK em 'o app perdeu minha musica'.
- **O export para de escrever cover.jpg por pasta (economiza espaco no cartao) ou mantem os dois layouts numa transicao?**  
  Recomendação: **Para de escrever** — Manter os dois dobra espaco e cria duas verdades de capa; o fallback por diretorio continua no codigo para manifest v1 e para pastas que ja trazem arte propria — nao ha regressao real.
- **Ink cycle no mobile entra ligado por padrao?**  
  Recomendação: **Ligado** — E um dos efeitos mais perceptiveis do desktop e metade da infra ja esta pronta e ociosa no aparelho (spectrum.ts ja le --bg-ink-morph); o unico risco e bateria, e a pausa por visibilitychange elimina ele.

---

## Epic J — Plataforma Android: operação, segurança e distribuição

**Onda 3** · 6 fases · 27h estimadas pelo planejador

> O celular é a única máquina onde ninguém está olhando, e hoje ele é opaco em três eixos que se reforçam: não dá pra saber qual build roda nem se o boot completou; o sync é um loop cego de 60s que dorme antes do primeiro ciclo, sem backoff, sem teto de fila e sem nenhuma superfície de leitura; e a única porta aberta do desktop (o receptor de play_events) aceita qualquer POST da tailnet sem token. A estratégia é ganhar observabilidade primeiro (versão/commit na tela, log no logcat, marcador de boot), usar essa observabilidade pra consertar o motor de sync (acorda sob demanda, backoff por relógio absoluto, lotes com ack correto, painel no Settings), e só então mexer no que exige reinstalação limpa — identidade que sobrevive ao uninstall, token no canal e APK assinado com script de release.


### J1 — Instrumentação: saber qual build roda e se o boot completou · ~3h

**Entrega:** No S24, Settings passa a mostrar versão + commit + device_id + signal_schema do APK instalado (mata a falha clássica do bun run build esquecido, que hoje só se descobre por sintoma); o log do Rust é lido por adb logcat sem run-as; um panic ou um boot que não fecha deixa rastro persistido e o próximo boot avisa; e nenhum texto da UI ou da doc mente sobre o que existe.

**Critério de pronto:** Settings do S24 mostra a versão e o commit exatos do APK instalado (conferíveis contra git rev-parse na VM), adb logcat exibe as linhas do Rust sem run-as, e um boot interrompido à força aparece como aviso na abertura seguinte.

**Gaps cobertos:** `versao-app-invisivel`, `logs-diagnostico`, `crash-reporting`, `settings-hint-stale`, `contrato-ipc-desatualizado`

**Arquivos:**

- src-tauri/build.rs — adicionar println!("cargo:rerun-if-env-changed=RUSTIFY_BUILD_COMMIT") antes de tauri_build::build(), senão o commit fica congelado no primeiro build
- src-tauri/src/mobile_diag.rs (NOVO) — marcador de boot (boot.json), hook de panic e BuildInfo; funções puras testáveis no host
- src-tauri/src/lib.rs — declarar pub(crate) mod mobile_diag com o mesmo cfg_attr(not(android), allow(dead_code)) dos outros módulos mobile
- src-tauri/src/mobile.rs — no setup(): instalar panic hook, marcar boot_start, registrar app_diagnostics e app_boot_ok no generate_handler. MEDIR antes de mexer no tauri_plugin_log (linhas 124-129): os DEFAULT_LOG_TARGETS do plugin 2.8.0 já incluem Stdout, que no Android mapeia para android_logger::log (logcat) — se a medição confirmar, o gap é de documentação e não de código; se não confirmar, declarar .targets([Target::new(TargetKind::Stdout), Target::new(TargetKind::LogDir{file_name:None})]) e, com storage concedido, um TargetKind::Folder em /storage/emulated/0/Music/.rustify/logs (só depois de um probe de escrita — o plugin cria o diretório no build do logger e uma falha ali é no caminho de boot)
- src/mobile/types.ts — interface Diagnostics
- src/mobile/ipc.ts — appDiagnostics() e appBootOk()
- src/mobile/store.ts — chamar appBootOk() no fim de bootStore() (é o sinal de que a WebView completou, não só o processo)
- src/mobile/screens/Settings.tsx — painel About (linhas 125-141) passa a listar Version/Commit/Device/Schema vindos do command; corrigir o hint do Beat sync (linhas 60-64), que ainda afirma relógio sintético depois do CMR-192
- docs/android/ipc-contrato-v0.md — corrigir o bloco 'O que NÃO existe' (beat sync real existe desde d2db593; letras entraram em 14/08) e documentar app_diagnostics/app_boot_ok
- CLAUDE.md — corrigir ou confirmar a linha 'Log Rust NAO roteia pro logcat' conforme a medição, e ajustar o comando de leitura de log documentado

**Contratos novos:**

- `App: #[tauri::command] fn app_diagnostics(app: tauri::AppHandle) -> Diagnostics (síncrono: só lê dois arquivos pequenos, não chama o plugin)`
- `App: #[tauri::command] fn app_boot_ok(app: tauri::AppHandle)`
- `JSON Diagnostics (snake_case, como os lib_*): { app_version: String, build_commit: String, device_id: String, signal_schema: i64, previous_boot_incomplete: bool, log_path: String }`
- `Arquivo <data_dir>/boot.json: {"started_at": i64, "finished_at": i64|null, "app_version": String} — started_at sem finished_at no boot seguinte = boot anterior não completou`
- `Rust: mobile_diag::mark_boot_start(dir: &Path, version: &str) -> bool (devolve se o boot anterior ficou incompleto); mark_boot_ok(dir: &Path); install_panic_hook(dir: PathBuf)`
- `Build: option_env!("RUSTIFY_BUILD_COMMIT").unwrap_or("local") — a versão continua vindo de package_info() (autoridade: tauri.conf.json, 0.2.73 hoje; o Cargo.toml em 0.2.13 NÃO é a fonte)`

**Testes:**

- cargo test (host) — mark_boot_start/mark_boot_ok: ciclo completo devolve false; ciclo interrompido devolve true no boot seguinte; boot.json corrompido não entra em panic e é recriado (mesmo padrão dos testes de device_identity)
- vitest — Settings renderiza versão e commit a partir de um mock de appDiagnostics e mostra o aviso quando previous_boot_incomplete é true
- npm run typecheck + cargo test do workspace
- Smoke S24: adb logcat mostrando as linhas de boot do Rust; matar o processo no meio do boot (adb shell am force-stop durante o splash) e confirmar o aviso no boot seguinte

### J2 — Sync que se comporta fora de casa e que dá pra ver · ~6h

**Entrega:** Tocar uma faixa e o evento sobe em segundos (hoje o worker dorme 60s ANTES do primeiro ciclo); fora da tailnet as tentativas espaçam até 15 min em vez de 60 batidas de rádio por hora; o journal sobe em lotes de 500 com ack só do que o receptor confirmou; e o Settings ganha um painel Sync com pendentes, tamanho do journal, último sucesso, último erro, próxima tentativa e botão 'Sincronizar agora' (que é também o caminho consciente antes de reinstalar o app).

**Critério de pronto:** No S24: o primeiro play de uma sessão fria chega ao Qdrant da cmr-auto em menos de 15s (hoje até 60s, ou nunca se o app fechar antes); com o wifi desligado o painel mostra o intervalo dobrando até 15 min e o log para de tentar a cada minuto; o botão 'Sincronizar agora' zera os pendentes com o desktop aberto.

**Depende de:** 1

**Gaps cobertos:** `sync-sem-tailnet`, `journal-crescimento`, `journal-nao-sincado-no-uninstall`

**Arquivos:**

- src-tauri/src/mobile_sync.rs — reescrita do mod worker: SyncHandle com Arc<Mutex<SyncStatus>> + Condvar, primeiro ciclo IMEDIATO (hoje o sleep vem antes, linha 104), espera por wait_timeout até um alvo ABSOLUTO recalculado a cada acordar, backoff exponencial, lotes e teto; sync_once passa a receber &SyncHandle e a atualizar o status em cada transição; build_synced_payload NÃO muda (o teste de contrato byte a byte com o desktop é intocável)
- src-tauri/src/mobile.rs — app.manage(SyncHandle) devolvido por worker::spawn; commands sync_status e sync_now no generate_handler
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/EventJournal.kt — fun stats(ctx): Stats (pending = linhas com seq > ackedSeq, bytes = file.length(), lastSeq, ackedSeq), reusando lock e ensureSeq
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — @Command fun journalStats(invoke: Invoke)
- src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs — struct JournalStats
- src-tauri/crates/tauri-plugin-rustify-audio/src/mobile.rs e src/desktop.rs — journal_stats na API (mobile chama "journalStats"; desktop devolve Error::UnsupportedPlatform, como os demais)
- src-tauri/crates/tauri-plugin-rustify-audio/src/commands.rs — command journal_stats (async fn com AppHandle<R>: regra dura do plugin, State síncrono deadlocka)
- src-tauri/crates/tauri-plugin-rustify-audio/src/lib.rs e build.rs — commands::journal_stats no generate_handler e "journal_stats" no array COMMANDS (o helper gera permissions/autogenerated/commands/journal_stats.toml)
- src-tauri/crates/tauri-plugin-rustify-audio/permissions/default.toml — adicionar "allow-journal-stats"
- src-tauri/crates/tauri-plugin-rustify-audio/README.md — linha nova na tabela de contrato IPC
- src/mobile/ipc.ts + types.ts — syncStatus(), syncNow(), interface SyncStatus
- src/mobile/screens/Settings.tsx — painel Sync novo entre Library e About, com poll de 5s enquanto a tela está visível

**Contratos novos:**

- `Kotlin: @Command fun journalStats(invoke: Invoke) -> resolve({"pending":Long,"lastSeq":Long,"ackedSeq":Long,"bytes":Long})`
- Rust plugin: pub async fn journal_stats(&self) -> crate::Result<JournalStats>; #[serde(rename_all="camelCase")] pub struct JournalStats { pub pending: i64, pub last_seq: i64, pub acked_seq: i64, pub bytes: i64 }
- `Rust plugin command: #[tauri::command] pub(crate) async fn journal_stats<R: Runtime>(app: AppHandle<R>) -> crate::Result<JournalStats>`
- `App: #[tauri::command] fn sync_status(state: State<SyncHandle>) -> SyncStatus`
- `App: #[tauri::command] fn sync_now(state: State<SyncHandle>) — apenas sinaliza o Condvar e retorna; NUNCA faz IO na thread do command (o POST é bloqueante e o drain usa block_on)`
- `JSON SyncStatus: { pending: u64, journal_bytes: u64, last_ok_at: Option<i64>, last_error: Option<String>, consecutive_failures: u32, next_attempt_at: i64, sent_total: u64, endpoint: String }`
- `Rust puro: fn next_delay(consecutive_failures: u32) -> Duration — 0 falhas = 60s; n falhas = 60s * 2^(n-1) com teto de 900s`
- `Consts em mobile_sync.rs: BATCH_MAX: usize = 500; BASE_DELAY = 60s; MAX_DELAY = 900s; JOURNAL_WARN_BYTES = 8 * 1024 * 1024`

**Testes:**

- cargo test (host) — next_delay: 0→60, 1→60, 2→120, 5→900, 50→900 sem overflow
- cargo test (host) — lotes: 1200 eventos viram 3 POSTs e o ack de cada lote é o MAIOR seq DAQUELE lote entregue, nunca drained.last_seq (o bug que perde evento em silêncio)
- cargo test (host) — payload_mobile_identico_ao_do_desktop e signal_schema_espelha_o_canonico continuam passando sem edição
- vitest — painel Sync renderiza pendentes/erro/próxima tentativa de um mock e o botão dispara syncNow uma única vez
- Smoke S24: tocar 1 faixa → pendentes 0 em menos de 15s; desligar o wifi → erro visível e 'próxima tentativa' crescendo; religar → 'Sincronizar agora' zera

### J3 — Permissão de storage in-app e estado vazio que não mente · ~5h

**Entrega:** Install limpo sem cabo passa a funcionar: em vez de biblioteca vazia sem explicação, a tela diz que falta 'Acesso a todos os arquivos', abre a tela do sistema num toque e, ao voltar, re-escaneia sozinha. Notificação de mídia negada ganha caminho de reparo em vez de sumir em silêncio. E a UI passa a distinguir três estados hoje colapsados: sem permissão, sem manifest e acervo vazio de verdade.

**Critério de pronto:** Com a permissão revogada, o app ensina o caminho em vez de mostrar zero faixas; concedendo pela própria UI e voltando, as 1746 faixas aparecem sozinhas. Com a notificação negada, Settings mostra 'negada' e o botão abre as notificações do app no sistema.

**Depende de:** 1

**Gaps cobertos:** `permissao-storage-adb`, `notificacao-permissao-ux`, `testes-mobile`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — bloco 'system' com hasAllFilesAccess, openAllFilesAccessSettings, notificationPermissionState e openAppNotificationSettings (o plugin já detém a Activity; criar um segundo módulo Gradle para 4 commands não se paga — decisão técnica minha, documentada no README do crate)
- src-tauri/crates/tauri-plugin-rustify-audio/src/{models.rs,mobile.rs,desktop.rs,commands.rs,lib.rs,build.rs}, permissions/default.toml e README.md — os 4 commands na API, todos async fn com AppHandle<R>
- src-tauri/src/mobile_library.rs — fn storage_state() derivado do read_dir REAL de MUSIC_ROOT (ErrorKind::PermissionDenied vs Ok) mais presença do manifest; expor unresolved e audio_files, que hoje só existem no tracing::info das linhas 224-230 e no warn da 269
- src-tauri/src/mobile.rs — command lib_state
- src/mobile/store.ts — signal libState; bootStore separa 'sem permissão' de 'sem manifest' de 'vazio' (hoje libError não distingue); no visibilitychange, se estava denied, re-checar e chamar rescan()
- src/mobile/screens/Library.tsx e Home.tsx — estado vazio com o botão que abre a tela do sistema
- src/mobile/screens/Settings.tsx — linhas 'Acesso a todos os arquivos' e 'Notificação de mídia' com estado e botão de reparo
- src/mobile/store.test.ts (NOVO) — harness com vi.mock de ./ipc; é a rede de segurança que faltava (dois bugs de boot já passaram por aqui, o próprio comentário das linhas 326-330 documenta um)

**Contratos novos:**

- `Kotlin: hasAllFilesAccess -> {"granted":Boolean} (Environment.isExternalStorageManager() em API>=30; abaixo disso checkSelfPermission(READ_EXTERNAL_STORAGE))`
- Kotlin: openAllFilesAccessSettings -> null (Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:"+packageName)) com FLAG_ACTIVITY_NEW_TASK; fallback para ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION em ActivityNotFoundException)
- `Kotlin: notificationPermissionState -> {"state":"granted"|"denied"|"prompt"} (reusa getPermissionState(ALIAS_POST_NOTIFICATIONS), o mesmo alias já declarado no @TauriPlugin)`
- `Kotlin: openAppNotificationSettings -> null (ACTION_APP_NOTIFICATION_SETTINGS com EXTRA_APP_PACKAGE)`
- `App: #[tauri::command] fn lib_state(lib: State<Library>) -> LibState`
- `JSON LibState: { storage: "granted"|"denied", manifest_present: bool, tracks: usize, unresolved: usize, audio_files: usize }`

**Testes:**

- cargo test (host) — storage_state com diretório inexistente e com diretório sem manifest (as duas branches, sem tocar em Android)
- vitest src/mobile/store.test.ts — applyState faz merge por chave PRESENTE (um tick só de position NÃO zera index/trackId: o bug real); rehydrateQueue ignora ids que sumiram e espelho corrompido não derruba o boot; bootCall re-invoca no timeout e desiste na 3a; libState denied vira empty state, não erro
- Smoke S24: adb shell appops set dev.cmr.rustifyplayer MANAGE_EXTERNAL_STORAGE deny → abrir → card explicativo → botão abre a tela do sistema → conceder → voltar → biblioteca aparece SEM reinstalar e SEM reabrir

### J4 — Sync sobrevive ao ciclo de vida do Android · ~3h

**Entrega:** Parar a música ou mandar o app pro background passa a subir na hora o que foi ouvido, em vez de esperar o próximo boot que sobreviva 60s. Escuta com tela apagada deixa de virar atraso invisível na régua e no motor.

**Critério de pronto:** Tocar duas faixas com a tela apagada, pausar e sair do app: em menos de 30s os dois eventos estão no Qdrant da cmr-auto, conferível pelo painel Sync na volta e pela régua do dia seguinte.

**Depende de:** 2

**Gaps cobertos:** `doze-bateria`

**Arquivos:**

- src-tauri/src/mobile_sync.rs — intervalo adaptativo: com pendentes > 0 o alvo é 20s; sem pendentes, 120s (menos rádio no idle); o backoff da fase 2 vence quando há falha. Os pendentes vêm de journal_stats (barato), não de um drain completo
- src/mobile/store.ts — além do visibilitychange que já existe (linhas 381-383), chamar syncNow() na transição para document.hidden e no pagehide: é a janela em que o processo ainda está vivo e o command só levanta uma flag
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — command openBatteryOptimizationSettings (ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS; NÃO usar ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
- src/mobile/screens/Settings.tsx — botão opcional 'Ignorar otimização de bateria' com hint explicando que é o que mantém o processo vivo entre faixas
- docs/android/ipc-contrato-v0.md — seção descrevendo quando o sync roda (periódico adaptativo, background, botão manual)

**Contratos novos:**

- `Rust puro: fn poll_interval(pending: u64, consecutive_failures: u32) -> Duration — falhas > 0 vence com next_delay(); pending > 0 = 20s; senão 120s`
- `Kotlin: openBatteryOptimizationSettings -> null`
- Refinamento OPCIONAL, só se o smoke mostrar buraco: acordar o worker por evento do plugin usando o register_listener já existente com um tauri::ipc::Channel construído no Rust — a assinatura exata de Channel::new deve ser conferida em docs.rs/tauri/2.11.0 ANTES de codar; não está no caminho crítico desta fase

**Testes:**

- cargo test (host) — poll_interval: (0,0)=120s, (3,0)=20s, (3,2)=120s (backoff vence pendentes), (0,5)=900s
- vitest — store dispara syncNow uma vez por transição para hidden, e não a cada evento de visibilitychange
- Smoke S24: tocar 2 faixas, pausar, apertar home, esperar 5s, reabrir → painel Sync com pendentes 0 e last_ok_at recente

### J5 — Identidade que sobrevive à reinstalação e canal de sinal fechado · ~5h

**Entrega:** Reinstalar o app (obrigatório na troca debug→release da fase 6) deixa de bifurcar a série histórica da régua: o device_id vive fora do sandbox e é migrado do antigo. O backup do Google para de carregar identidade e journal para outro aparelho. E a única porta aberta do desktop passa a exigir token: um POST sem credencial devolve 401 em vez de escrever no sinal que alimenta o motor.

**Critério de pronto:** Desinstalar e reinstalar o APK mantém device_id = s24 no painel About e a régua do dia seguinte não cria device novo; um curl de qualquer host da tailnet sem o header recebe 401.

**Depende de:** 2, 3

**Gaps cobertos:** `device-id-fragilidade`, `sync-sem-tailnet`

**Arquivos:**

- src-tauri/src/device_identity.rs — load_or_create passa a receber ordem de busca: /storage/emulated/0/Music/.rustify/device.json (preferido) → migração do <data_dir>/device.json existente → criação do hostname (a semente Android por getprop ro.product.model das linhas 45-53 continua); com storage negado NÃO cria arquivo — devolve id pending
- src-tauri/src/mobile_sync.rs — ler sync.json de .rustify/ (preferido) com fallback no data_dir (hoje só data_dir, linhas 78-84); header X-Rustify-Sync-Token; recusar endpoint fora das faixas privadas antes de qualquer POST; 401 vira mensagem específica no SyncStatus; segurar o sync enquanto o device_id estiver pending
- src-tauri/src/sync_receiver.rs — start(client, token) e validação do header ANTES de parsear o body (401); log do device_id aceito
- src-tauri/src/desktop.rs — no setup, gerar <data_dir>/sync_token (32 bytes hex, 0600) se ausente e passar para sync_receiver::start; logar o token no boot para o export pegá-lo
- scripts/android/export_manifest.py — escrever .rustify/sync.json {endpoint, token} no mesmo passo que já leva manifest/vectors/taste/stations
- src-tauri/gen/android/app/src/main/AndroidManifest.xml — android:allowBackup="false" no <application> (hoje ausente, default true)
- CLAUDE.md e docs/android/ipc-contrato-v0.md — onde vive cada arquivo e o procedimento quando o token muda

**Contratos novos:**

- `JSON /storage/emulated/0/Music/.rustify/sync.json: {"endpoint":"http://100.102.249.9:19878/sync/events","token":"<hex32>"}; override de dev continua em <data_dir>/sync.json`
- `HTTP: POST /sync/events exige X-Rustify-Sync-Token; ausente ou diferente → 401 {"error":"unauthorized"}. GET /sync/health segue público (é o probe de tailnet)`
- `Rust puro: fn endpoint_allowed(url: &str) -> bool — aceita apenas loopback, 10/8, 172.16/12, 192.168/16 e 100.64/10 (CGNAT da tailnet); qualquer outro host é recusado com erro no SyncStatus`
- `Arquivo desktop <data_dir>/sync_token: uma linha hex, permissão 0600`

**Testes:**

- cargo test (host) — endpoint_allowed: aceita 100.102.249.9 e 127.0.0.1; recusa 8.8.8.8, hostname público e IP público em porta alta
- cargo test (host) — device_identity: arquivo em .rustify vence; migração copia o id do data_dir em vez de criar outro; storage negado não escreve arquivo e devolve pending
- cargo test (host) — estender post_de_lote_conta_aceitos_e_rejeitados (sync_receiver.rs) com 401 sem header, 401 com header errado e 200 com header certo
- Smoke: desinstalar/reinstalar o APK e confirmar device_id idêntico no About; da VM, curl POST sem token → 401 e nada gravado no Qdrant

### J6 — Distribuição: APK assinado, reprodutível e publicado · ~5h

**Entrega:** Atualizar o celular deixa de ser um ritual manual de três máquinas: um comando na VM builda, assina, publica na tag rolling e imprime a linha de install. O APK sai só com arm64 (menor e mais rápido de buildar) e carimba o commit que o Settings da fase 1 mostra.

**Critério de pronto:** ./scripts/release-android.sh na VM produz e publica rustify-player_<versão>_arm64.apk assinado; a cmr-auto instala com uma linha; o Settings do S24 mostra a versão e o commit exatos, e o device_id continua s24 depois da reinstalação.

**Depende de:** 1, 5

**Gaps cobertos:** `distribuicao-apk`, `tamanho-apk-abi`

**Arquivos:**

- scripts/release-android.sh (NOVO) — espelha scripts/release.sh: lê a versão de tauri.conf.json, FALHA CEDO se o keystore não existir, exporta RUSTIFY_BUILD_COMMIT, roda bun run build (obrigatório: sem ele o .so embute o dist velho — gotcha já documentado), cargo tauri android build --release, valida com apksigner verify, publica na tag dev com nome VERSIONADO e imprime a linha do adb
- src-tauri/gen/android/app/build.gradle.kts — signingConfigs.create("release") lendo keystore.properties FORA do repo (path por env RUSTIFY_ANDROID_KEYSTORE_PROPS); buildTypes.release usa o signingConfig e vai com isMinifyEnabled = false no primeiro release; defaultConfig.ndk.abiFilters = listOf("arm64-v8a")
- .gitignore — keystore.properties e *.jks fora do repo, explicitamente
- CLAUDE.md — seção Android: trocar o passo manual (bun run build + cargo tauri android build --debug + scp + adb) pelo script; manter o aviso do bun run build e substituir a instrução de appops (a fase 3 tornou a permissão in-app)
- docs/android/ipc-contrato-v0.md — nota de distribuição e o pré-flight de sincronizar antes de trocar a assinatura

**Contratos novos:**

- `scripts/release-android.sh: env RUSTIFY_ANDROID_KEYSTORE_PROPS (default ~/.secrets/rustify-android-keystore.properties) e RUSTIFY_BUILD_COMMIT (default git rev-parse --short HEAD)`
- `Asset publicado na tag dev: rustify-player_${VERSION}_arm64.apk — nome versionado porque a tag acumula (baixar com '*.apk' puxaria a coleção inteira, mesmo gotcha do .deb)`
- `keystore.properties: storeFile / storePassword / keyAlias / keyPassword`
- `versionCode/versionName seguem vindo de tauri.properties (gerado de tauri.conf.json) — o script NÃO bumpa versão, igual ao release.sh do desktop`

**Testes:**

- Rodar o script com keystore ausente e confirmar que falha ANTES de compilar (segundos, não minutos)
- apksigner verify reprovando um APK não assinado e aprovando o gerado
- Smoke S24: adb install -r do release por cima do release anterior (sem uninstall) e Settings mostrando versão + commit novos. A primeira troca debug→release exige uninstall e só acontece depois de 'Sincronizar agora' com pendentes = 0

**Cortado deste epic:**

- integracao-sistema-android — L inteiro cortado: widget/tile pedem uma leitura de estado paralela à WebView (segunda fonte de verdade) e Auto pede exported=true + MediaBrowser; a paridade que importa (notificação, lockscreen, botões de fone) já existe pelo MediaSession, e o próprio briefing reconhece isso.
- distribuicao-apk (parte updater) — check/install in-app cai: sem TLS no ureq do Android o app não fala com o GitHub e instalar APK exige REQUEST_INSTALL_PACKAGES. Fica o que resolve o problema real: script de release assinado + versão/commit visíveis na tela.
- logs-diagnostico (parte visor in-app) — nenhuma tela de log. Fica o roteamento pro logcat (que a medição pode revelar já existente, virando correção de doc no CLAUDE.md) e, com storage concedido, cópia do log em /sdcard/Music/.rustify/logs para puxar sem run-as. Tela de log é UI cara para um usuário que tem adb.
- doze-bateria (parte WorkManager) — cortado em favor de intervalo adaptativo + flush no ciclo de vida; ver decisão do CEO. Mantém a fronteira do payload canônico em Rust.
- tamanho-apk-abi — deixa de ser item próprio e vira três linhas dentro da fase 6 (abiFilters arm64-v8a). O ganho que se paga é tempo de build, não tamanho de download; splits/AAB não entram (não há loja).
- crash-reporting (parte telemetria) — nenhum reporter externo: só panic hook gravando no log e marcador de boot persistido, como o próprio gap recomenda.

**Riscos:**

- Fase 2 — ack acima do que foi entregue perde evento em SILÊNCIO (o journal compacta e o dado some). Sinal antecipado: pendentes caem no painel sem 'accepted' correspondente no log do receptor. Mitigação: ack sempre com o maior seq DAQUELE lote confirmado com 200, nunca com drained.last_seq; teste dedicado.
- Fase 2 — o loop é thread nativa: sob doze o Android congela a thread e sleep acumulado mente sobre quanto tempo passou. Sinal antecipado: next_attempt_at no passado e ciclos em rajada ao acordar. Mitigação: alvo por relógio absoluto recalculado a cada acordar, não soma de sleeps.
- Fase 3 — Environment.isExternalStorageManager() pode divergir do acesso real em OneUI. Sinal antecipado: card de 'falta permissão' com a biblioteca cheia. Mitigação: o estado da UI vem do read_dir REAL em Rust; o Kotlin só abre a tela do sistema.
- Fase 3 — o retorno da tela do sistema não recria a Activity de forma garantida. Sinal antecipado: usuário concede, volta e a biblioteca segue vazia até matar o app. Mitigação: re-checagem no visibilitychange (gancho já existente no store) com rescan automático e o botão manual como rede.
- Fase 5 — trocar o local do device.json antes de a permissão de storage existir cria identidade nova no momento errado, exatamente o dano que a fase quer evitar. Sinal antecipado: device_id diferente de s24 no About logo após conceder. Mitigação: com storage negado o id fica pending em memória e o sync SEGURA os eventos em vez de carimbá-los errado.
- Fase 5 — export desatualizado depois do fail-closed deixa o S24 em 401 eterno. Sinal antecipado: pendentes crescendo com erro 401 no painel. Mitigação: mensagem específica ('token ausente ou inválido — rode o export') e o desktop logando o token no boot.
- Fase 6 — keystore perdida é irreversível: nunca mais se instala update por cima. Sinal antecipado: nenhum, o dano aparece meses depois. Mitigação: keystore em ~/.secrets com backup verificado ANTES do primeiro release assinado e o script falhando cedo se não achar o arquivo.
- Fase 6 — o buildType release do gradle gerado já vem com isMinifyEnabled = true: o R8 pode comer a reflexão do Jackson do tauri-android e do plugin. Sinal antecipado: APK instala e abre em tela branca, ou todo invoke falha. Mitigação: primeiro release com minify DESLIGADO; ligar depois, isolado, com proguard rules e smoke completo.
- Transversal — todas as fases editam src-tauri/gen/android, que é versionado (40 arquivos no git): rodar cargo tauri android init sobrescreveria manifest, gradle e MainActivity. Sinal antecipado: git status mostrando reversão dessas mudanças. Mitigação: nunca rodar init; qualquer regeneração exige diff manual.
- Transversal — cinco das seis fases mexem no plugin Kotlin, e cada command novo tem cinco pontos de registro (Kotlin, models.rs, mobile.rs/desktop.rs, commands.rs, lib.rs + build.rs + default.toml). Sinal antecipado: invoke falhando com 'not allowed by capability' ou 'unknown command' no aparelho. Mitigação: checklist no README do crate e um smoke por command logo após o install.

**Decisões do CEO neste epic:**

- **Mover o sync para WorkManager (Kotlin) para sobreviver à morte do processo?**  
  Recomendação: **Manter o worker Rust; cortar WorkManager.** — O payload canônico é montado em Rust com teste byte a byte contra o builder do desktop; postar do Kotlin duplicaria esse contrato sem teste, e o ganho real são minutos de latência num app que passa a flushar ao pausar e ao ir pro background.
- **Updater in-app no Android (verificar e instalar versão nova pelo próprio app)?**  
  Recomendação: **Cortar.** — O ureq do build Android é compilado SEM TLS por decisão (rustls exigiria clang do NDK), então o app nem fala https com o GitHub; e instalar APK exigiria REQUEST_INSTALL_PACKAGES mais intent de instalação — muito custo para um parque de um aparelho com adb na mesma casa.
- **O receptor de sync passa a exigir token de forma fail-closed já na primeira versão?**  
  Recomendação: **Fail-closed.** — São duas máquinas e um único passo de export para entregar o token; a graça mantém aberta por semanas a única porta de escrita no sinal que alimenta o motor de recomendação.
- **Onde passam a viver device.json e o token do sync no celular?**  
  Recomendação: **device.json e token em /sdcard/Music/.rustify/; o journal de eventos permanece no sandbox privado.** — Identidade e credencial de tailnet precisam sobreviver à reinstalação obrigatória da troca de assinatura; o journal não ganha nada saindo do sandbox — para ele o remédio é o botão 'Sincronizar agora' antes de reinstalar.
- **Trocar agora para APK assinado de release, aceitando uma reinstalação limpa coordenada?**  
  Recomendação: **Assinar agora, logo depois da fase 5.** — A fase 5 é exatamente o que torna a reinstalação inofensiva (identidade fora do sandbox + flush consciente); adiar empurra a mesma troca para quando o journal estiver maior e a série da régua mais longa.
- **Integração de sistema (widget de home, quick settings tile, Android Auto, atalhos dinâmicos)?**  
  Recomendação: **Cortar; reavaliar só se o uso no carro virar rotina.** — Widget e tile exigem ler estado sem subir a WebView (uma segunda fonte de verdade do que toca) e o Auto exige exported=true mais catálogo navegável — superfície nova de ataque e de bug contra conveniência, num aparelho que já tem notificação de mídia e tela de bloqueio funcionando.

---

## Epic G — Customizacao no Android: store unico de Tweaks, escala/densidade, ink sob controle, light/dark e temas exportados

**Onda 4** · 6 fases · 34h estimadas pelo planejador

> O aparelho nao tem hub de customizacao, mas o subsolo esta melhor do que o epic sugere: o motor do fundo JA le as cinco vars de reatividade e as tres de beat (spectrum.ts:176-188), o CSS mobile e quase 100% token-driven (so 3 rgba() literais em app.css e 6 em tokens.css) e o vocabulario dos temas YAML (6 surfaces / 3 niveis de texto / accent / dividers / signals) mapeia praticamente 1:1 nos tokens mobile (--s-lowest..--s-highest / --t1..t4 / --accent / --div-* / --ok|warn|err). Logo a estrategia nao e "portar o Tweaks", e: (1) criar UM store com schema, migracao das 5 chaves soltas, dirty-flag e reset (kv-mobile-tweaks, com o gate _loaded que o desktop aprendeu na marra) e pendurar cada knob nele; (2) expor primeiro o que ja e lido pelo motor (custo quase zero, retorno imediato) e o off-switch do rAF (bateria, eixo onde o mobile PRECISA do que o desktop nao precisa); (3) so entao gastar em segunda paleta (light) e em temas — e temas entram como JSON RESOLVIDO exportado e validado pelo validate.py que ja existe, nunca como parser YAML no aparelho.


### G1 — Store unico kv-mobile-tweaks + tela /tweaks + reatividade do bg + off-switch · ~7h

**Entrega:** O usuario abre Tweaks no S24 e controla de verdade o fundo: bass/mid/treble/smoothing/speed em sliders continuos, beat sync separado em modo (off/speed/pulse) + profundidade continua 0..1, e um interruptor 'Fundo animado' que PARA o rAF (bateria). Tudo persiste num store unico com 'Redefinir tudo', e as preferencias antigas (shape, renderer, beat, letra) migram sem perda.

**Critério de pronto:** No S24, apos instalar o APK: (1) a aba Settings tem 'Tweaks' e a tela abre; (2) mexer em Bass/Speed muda o fundo na hora com a musica tocando; (3) 'Fundo animado: Off' apaga o canvas e ele NAO volta a desenhar (confirmar com `adb shell dumpsys gfxinfo dev.cmr.rustifyplayer` parando de acumular frames); (4) matar e reabrir o app mantem todos os valores; (5) o shape/renderer escolhidos ANTES da atualizacao continuam selecionados depois (migracao provada no aparelho, nao so no teste).

**Gaps cobertos:** `bg-reactivity-knobs`, `beat-depth-continuo`, `tweaks-panel-inexistente`, `tweaks-panel (parcial: o hub passa a existir)`, `bg-off-switch`, `reduced-motion (parte do rAF)`

**Arquivos:**

- src/mobile/store/tweaks.ts (CRIAR) — schema MobileTweaks, DEFAULTS, load/save em kv-mobile-tweaks, migracao das chaves soltas, applyMobileTweaks() DOM-only, gate _loaded, updateTweak/resetTweaks/isDirty/clearDirty
- src/mobile/store/tweaks.test.ts (CRIAR) — vitest jsdom: defaults, migracao das 5 chaves, gate _loaded nao salva DEFAULTS por cima do persistido, reset, vars escritas no <html>
- src/mobile/screens/Tweaks.tsx (CRIAR) — tela da rota /tweaks com secoes (Fundo / Beat / Bateria); reusa .setpanel/.setrow ja portados em app.css:556-614
- src/mobile/components/controls.tsx (CRIAR) — <Slider>, <Seg>, <Toggle> tateis (alvo >= 44px; o .range do handoff tem thumb de 14px, insuficiente pra dedo)
- src/mobile/MobileApp.tsx (EDITAR) — case '/tweaks' no switch de screen() (:54-76); chamar loadTweaks() em mountMobile ANTES do render() (:157-162), no lugar de applyBeatMode()
- src/mobile/screens/Settings.tsx (EDITAR) — linha 'Tweaks →' no painel Appearance; REMOVER o Beat sync de 4 rotulos (:57-75) e o hint mentiroso 'no Android o pulso vem de um relogio sintetico' (falso desde d2db593)
- src/mobile/bg/spectrum.ts (EDITAR) — shape/renderer passam a ler/escrever no store (hoje persistem sozinhos em :22-23); gating real do rAF em frame() (:158-161 hoje so faz early-return e continua agendando)
- src/mobile/bg/beatSetting.ts (EDITAR/ESVAZIAR) — deixa de ser fonte de estado; sobra so o mapa de migracao dos 4 rotulos, consumido por tweaks.ts
- src/mobile/styles/app.css (EDITAR) — portar .range e .tog do handoff (docs/design-refs/design_handoff_mobile/app.css:131-138, hoje ausentes no mobile) com alvo tatil corrigido

**Contratos novos:**

- `localStorage key: 'kv-mobile-tweaks' — JSON { ...MobileTweaks, __dirty: string[] }`
- export interface MobileTweaks { bgEnabled: boolean; bgBassGain: number; bgMidGain: number; bgTrebleGain: number; bgSmoothing: number; bgSpeed: number; bgBeatMode: "off"|"speed"|"pulse"; bgBeatDepth: number; shape: number; renderer: number; lyricsVisible: boolean }
- `export const tweaks: Accessor<MobileTweaks>`
- `export function updateTweak<K extends keyof MobileTweaks>(k: K, v: MobileTweaks[K]): void`
- `export function resetTweaks(): void`
- `export function loadTweaks(): void  // chamado em mountMobile ANTES de render()`
- export function applyMobileTweaks(s?: MobileTweaks): void  // DOM-only, escreve as MESMAS vars que spectrum.ts ja le: --bg-bass-gain, --bg-mid-gain, --bg-treble-gain, --bg-smoothing, --bg-speed, --bg-beat-sync, --bg-beat-mode, --bg-beat-depth
- `export function shouldAnimate(enabled: boolean, hidden: boolean, reduceMotion: boolean): boolean  // funcao PURA, testavel, usada por frame() pra decidir se re-agenda o rAF`
- `export function setBgEnabled(on: boolean): void  // em bg/spectrum.ts: para/reinicia o loop e limpa o canvas uma vez`
- `Mapa de migracao (beat): 'rustify-beat-mobile' rotulo -> par (modo, depth): Off->("off",0.55) | Subtle->("speed",0.30) | Default->("speed",0.55) | Pulse->("pulse",0.85)`
- Mapa de migracao (resto): 'rustify-shape-mobile'->shape, 'rustify-renderer-mobile'->renderer, 'kv-mobile-lyrics' ("on"/"off")->lyricsVisible; chaves antigas sao LIDAS uma vez e deixadas no lugar (nao apagar: rollback de APK)

**Testes:**

- vitest src/mobile/store/tweaks.test.ts: (a) sem nada persistido -> DEFAULTS; (b) com as 5 chaves antigas -> valores migrados corretos, inclusive Pulse->(pulse,0.85); (c) save() nao roda antes de loadTweaks (regressao do clobber module-level, docs project_solid_module_effect_boot_clobber); (d) applyMobileTweaks escreve as 8 vars com os valores formatados; (e) resetTweaks volta tudo e limpa __dirty
- vitest do shouldAnimate: matriz (enabled, hidden, reduceMotion) -> bool
- npm run typecheck + npx vitest run (gates do projeto)
- Smoke manual no S24: com musica tocando, Bass=0 -> o fundo para de responder ao grave; Speed=0 -> o campo congela; beat mode=pulse com depth 0.20 -> pulso sutil (impossivel hoje, o preset forca 0.85)

### G2 — Escala, densidade, tipografia, safe-areas laterais, feedback de toque e barras do sistema · ~6h

**Entrega:** Acessibilidade real na tela pequena: escala do conteudo 85-125%, densidade normal/compact (mais linhas por scroll nas 1746 faixas), UI inteira em mono, escolha entre as 3 familias JA bundladas. Em landscape o conteudo para de passar por baixo do notch lateral, todo botao passa a confirmar o toque, e os icones da barra de status deixam de sumir quando o sistema esta em light.

**Critério de pronto:** No S24: Scale 125% aumenta as listas e o NowPlaying sem mover o dock e sem quebrar o seek; Compact mostra pelo menos 2 linhas a mais na Library na mesma tela; Type=Mono troca a UI inteira; girar pra landscape nao esconde texto na lateral; qualquer botao pressionado muda de aparencia enquanto o dedo esta nele; com o Android em tema claro os icones do topo continuam legiveis.

**Depende de:** 1

**Gaps cobertos:** `tweak-scale`, `tweak-density`, `tweak-type-mono`, `tweak-fonts (reduzido as familias bundladas)`, `safe-area-parcial`, `achado ceticos/visual: zero estilo de foco/pressionado (tokens.css:88 zera o tap-highlight e nada o substitui)`, `achado ceticos/visual: barras do sistema dessincronizadas (parte estatica)`

**Arquivos:**

- src/mobile/store/tweaks.ts (EDITAR) — campos scale, density, type, fontUI; applyMobileTweaks passa a escrever --ui-scale, html.dataset.density, html.dataset.type, --font
- src/mobile/screens/Tweaks.tsx (EDITAR) — secoes Layout e Tipografia
- src/mobile/styles/tokens.css (EDITAR) — adicionar --safe-l/--safe-r (env(safe-area-inset-left/right); hoje so :80-81 tem top/bottom), --ui-scale, e os tokens de densidade (--row-pad, --sec-gap, --list-gap)
- src/mobile/styles/app.css (EDITAR) — consumir os tokens de densidade em .trk (:219-228 padding 9px), .sec, .viewhead, .grid; regras [data-density="compact"] e [data-type="mono"]; :active/:focus-visible em .iconbtn/.selbtn/.seg button/.tab/.shapebtn; padding lateral com var(--safe-l/--safe-r) no .device e no .np .inner (:355)
- src-tauri/gen/android/app/src/main/java/dev/cmr/rustifyplayer/MainActivity.kt (EDITAR) — enableEdgeToEdge() sem argumento usa SystemBarStyle.auto, que segue o uiMode do SISTEMA: com o aparelho em light e o app preto, os icones da status bar ficam escuros sobre fundo escuro. Trocar por SystemBarStyle.dark(Color.TRANSPARENT) nas duas barras enquanto o app for dark-only

**Contratos novos:**

- `MobileTweaks += { scale: number /*0.85..1.25 step .05*/; density: "normal"|"compact"; type: "body"|"mono"; fontUI: "inter"|"fraunces"|"system" }`
- CSS: --ui-scale aplicada como `zoom` SOMENTE em .view (o container rolavel) e em .np .lyrics — NUNCA no <html>. Motivo tecnico: .device usa height:100dvh e o dock/NowPlaying sao chrome de posicao fixa com env(safe-area); zoom no root escala a geometria e empurra o dock pra fora da tela, alem de deslocar o getBoundingClientRect do seek (NowPlaying.tsx:85-89). O desktop pode usar html.style.zoom (tweaks.ts:212) porque nao tem chrome preso ao viewport do aparelho.
- `CSS: --safe-l: env(safe-area-inset-left, 0px); --safe-r: env(safe-area-inset-right, 0px)`
- `CSS: :root[data-density="compact"] redefine --row-pad/--sec-gap; nenhuma altura de linha volta a ser px literal em app.css`
- `Kotlin: enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))`

**Testes:**

- vitest tweaks.test.ts += aplicacao de scale/density/type (data attrs e var no elemento certo)
- Smoke S24 obrigatorio em 3 escalas (0.85 / 1.0 / 1.25) x 3 telas (Library com lista longa, NowPlaying com letra, Queue): o dock nao pode sair da tela, o seek tem que acertar o ponto tocado, a letra nao pode cortar
- Smoke S24 em landscape: com o aparelho deitado, o texto do NowPlaying e da Library nao encosta na curvatura lateral
- Smoke S24 com o sistema em tema claro: icones da status bar visiveis sobre o app escuro

### G3 — Ink e accent sob controle do usuario (toggles, cor manual, piso WCAG) · ~3h

**Entrega:** A cor que a capa impoe ao app inteiro deixa de ser obrigatoria: dois toggles (Adaptive ink / Adaptive accent) e um seletor de cor manual com precedencia explicita usuario > capa > tema > default, cada override com o botao de voltar ao automatico. E nenhum caminho de ink pode nascer invisivel: o piso de 3:1 do desktop passa a existir tambem no aparelho.

**Critério de pronto:** No S24: com uma capa berrante, desligar 'Adaptive ink' devolve o fundo ao cinza do tema na proxima faixa e o accent dos chips volta ao rosa do tokens.css; escolher uma cor no seletor trava o fundo nela entre faixas diferentes; o botao de reset devolve o controle a capa; escolher deliberadamente um cinza quase igual ao fundo NAO deixa o fundo sumir (a linha continua visivel).

**Depende de:** 1

**Gaps cobertos:** `tweak-adaptive-toggles`, `tweak-bg-ink-color`, `wcag-ink-enforcement`, `dirty-flag-reset (a mecanica, aplicada a bgInk)`

**Arquivos:**

- src/mobile/adaptiveColor.ts (EDITAR) — applyAdaptiveColor(:43) passa a receber o estado dos toggles e o override do usuario; aplica ensureInkContrast(ink, canvas, 3.0) de src/lib/color.ts DEPOIS do deriveInk (rede de seguranca que hoje falta); themeBase() (:27-32) perde o cache estatico (vai precisar dele dinamico na fase 5)
- src/mobile/MobileApp.tsx (EDITAR) — o createEffect de :121-123 passa a ler o store em vez de chamar incondicionalmente
- src/mobile/store/tweaks.ts (EDITAR) — adaptiveInk, adaptiveAccent, bgInk + THEME_GOVERNED = ['bgInk'] e a persistencia de __dirty
- src/mobile/screens/Tweaks.tsx (EDITAR) — secao Cor: dois Seg (Album/Off) + <input type="color"> + botao de reset inline
- src/mobile/adaptiveColor.test.ts (CRIAR) — testes da funcao pura de resolucao

**Contratos novos:**

- `MobileTweaks += { adaptiveInk: boolean /*default true*/; adaptiveAccent: boolean /*default true*/; bgInk: string /*hex, default "#f0f0f0" = o --bg-ink-rgb atual do tokens.css:51*/ }`
- export function resolveMobileInk(s: MobileTweaks, dirty: boolean, coverDominant: string|null, canvasHex: string): string  // FUNCAO PURA em adaptiveColor.ts: dirty ? bgInk : (adaptiveInk && cover ? deriveInk(cover, canvas) : default), sempre passando por ensureInkContrast(_, canvas, 3.0)
- `export function applyAdaptiveColor(dominant: string|null|undefined, s: MobileTweaks, dirty: boolean): void  // assinatura muda: hoje e applyAdaptiveColor(dominant) e ignora qualquer preferencia`
- `kv-mobile-tweaks.__dirty passa a conter 'bgInk' quando o usuario toca no seletor`

**Testes:**

- vitest adaptiveColor.test.ts: (a) sem dirty e com capa -> cor derivada da capa; (b) com dirty -> a cor do usuario, intocada se ja contrasta; (c) usuario escolhe #0d0d0d sobre canvas #0c0c0c -> o APLICADO e levantado ate 3:1 mas o valor GUARDADO no knob continua #0d0d0d (mesma semantica do desktop, tweaks.ts:388); (d) adaptiveInk=false -> ink do tema, capa ignorada; (e) capa acromatica -> accent do tema permanece
- Smoke S24 com uma capa saturada (ex.: qualquer faixa com dominante forte) e outra acromatica

### G4 — Card de letra: vidro e tamanho controlaveis · ~3h

**Entrega:** A legibilidade da letra sobre o fundo animado passa a ser do usuario: um slider unico de 'vidro' (opacidade + brilho, com o modo solido) e tres tamanhos (S/M/L) para quanto da tela a letra ocupa. O equivalente mobile do card arrastavel do desktop — controle de FEATURE, nao de INTERACAO.

**Critério de pronto:** No S24, com a letra aberta: o slider muda a legibilidade em tempo real sem engasgo; L faz a letra ocupar visivelmente mais tela que S; o estado sobrevive a fechar e reabrir o Now Playing e a reiniciar o app.

**Depende de:** 1

**Gaps cobertos:** `tweak-lyrics-glass`, `lyrics-card-geometria`

**Arquivos:**

- src/mobile/styles/app.css (EDITAR) — .np .lyrics (:859-866) ganha background rgba com --lyrics-bg-alpha e filter brightness(--lyrics-bg-brightness); regras [data-lyr-size="s"|"m"|"l"] mudando o flex/max-height do bloco e o tamanho de .lrail p (:876)
- src/mobile/components/NowPlaying.tsx (EDITAR) — o .np (:120-126) ganha attr:data-lyr-size; lyrOn/LYR_KEY (:26,:33-38) sai do localStorage solto e passa a ler tweaks().lyricsVisible
- src/mobile/store/tweaks.ts (EDITAR) — lyricsGlass, lyricsSize; applyLyricsGlass espelhando a derivacao do desktop (tweaks.ts:279-288)

**Contratos novos:**

- MobileTweaks += { lyricsGlass: number /*0..1, default 0.55 — no mobile o default fica NO LADO SOLIDO, decisao tecnica: backdrop-filter em WebView Android e caro e o desktop so precisa dele por gosto*/; lyricsSize: "s"|"m"|"l" /*default m*/ }
- export function applyLyricsGlass(s: MobileTweaks): void  // --lyrics-bg-alpha = 0.04 + g*0.61; --lyrics-bg-brightness = 0.92 - g*0.40; html.dataset.lyricsSolid = g >= 0.85 ? 'on' : 'off' — MESMOS numeros do desktop, pra que o mesmo valor de knob produza o mesmo look nos dois apps
- `NUNCA introduzir backdrop-filter no .np .lyrics: o card do mobile nasce solido; o slider mexe em alpha e brilho apenas`

**Testes:**

- vitest: applyLyricsGlass em 0 / 0.5 / 0.9 -> as tres vars e o data attr corretos
- Smoke S24 com uma faixa que tenha .lrc sincronizado: arrastar o slider com a letra aberta e a musica tocando, medindo fps pelo mesmo caminho CDP do smoke de audio (nao pode cair abaixo de ~50fps durante o arrasto)

### G5 — Light / Dark / Auto de verdade (segunda paleta) + reduced motion · ~8h

**Entrega:** O app deixa de ser o unico do aparelho que ignora o tema do sistema: Auto (default) segue o Android, Light e Dark forcam. A paleta clara e curada e VALIDADA por teste automatico de contraste, os tres rgba() escuros hardcoded viram tokens, o ink adaptativo passa a derivar contra o canvas claro e as barras do sistema acompanham. Junto vem o respeito a prefers-reduced-motion.

**Critério de pronto:** No S24: com o app em Auto, trocar o tema do Android muda o app na hora; em Light nenhuma tela tem texto ilegivel, o mini-player continua distinguivel do fundo e a letra continua legivel; forcar Dark com o sistema em light mantem o app escuro E os icones da barra de status legiveis; o teste de contraste das duas paletas passa no `npx vitest run`.

**Depende de:** 1, 3

**Gaps cobertos:** `light-dark-mode`, `theme-yaml-mobile (a metade Light/Dark/Auto)`, `reduced-motion`, `achado ceticos/visual: barras do sistema (parte dinamica)`

**Arquivos:**

- src/mobile/styles/tokens.css (EDITAR) — o bloco :root atual (:15-82) permanece INTOCADO como paleta dark (risco zero de regressao); nasce um bloco :root[data-theme="light"] com os mesmos 30 tokens; --veil-rgb e --shadow-rgb entram como tokens novos
- src/mobile/styles/app.css (EDITAR) — os 3 literais escuros viram token: :347 rgba(5,5,5,...) -> rgba(var(--veil-rgb), ...); :384 box-shadow -> rgba(var(--shadow-rgb), .6); :436 rgba(128,144,120,.4) -> derivado de --ok. Os dois #000 de :865 sao mask-image (alpha, agnosticos) e ficam
- src/mobile/store/tweaks.ts (EDITAR) — themeMode + resolucao do modo efetivo via matchMedia('(prefers-color-scheme: dark)') com listener; escreve html.dataset.theme SEMPRE resolvido ('light'|'dark'), nunca 'auto'
- src/mobile/MobileApp.tsx (EDITAR) — aplicar o modo em mountMobile antes do render (evita flash claro/escuro no boot)
- src/mobile/adaptiveColor.ts (EDITAR) — themeBase() le o canvas a cada aplicacao (o cache de :27-32 congelaria o canvas dark). deriveInk/deriveAccent ja tratam canvas claro (inkDerive.ts:33 e :51 ramificam por themeL<0.5) — nada a portar
- src/mobile/styles/tokens.test.ts (CRIAR) — le tokens.css por fs e valida os pares de contraste das DUAS paletas com relLuminance/contrastRatio de src/lib/color.ts
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt + src/commands.rs + src/mobile.rs + README.md (EDITAR) — command novo pra polaridade das barras (ver decisao do CEO)

**Contratos novos:**

- `MobileTweaks += { themeMode: "light"|"dark"|"auto" /*default auto*/ }`
- DOM: <html data-theme="light"|"dark"> SEMPRE resolvido pelo JS. Deliberadamente NAO usamos @media(prefers-color-scheme) no CSS: com o modo resolvido em JS existe um unico bloco de tokens claros e a polaridade das barras do sistema deriva da MESMA fonte
- Kotlin @Command: `fun setBarStyle(invoke: Invoke)` com @InvokeArg { var lightIcons: Boolean }, chamando WindowInsetsControllerCompat(activity.window, activity.window.decorView).isAppearanceLightStatusBars/isAppearanceLightNavigationBars na main thread (o AudioPlugin ja recebe `activity`, AudioPlugin.kt:82)
- Rust: `#[tauri::command] pub(crate) async fn set_bar_style<R: Runtime>(app: AppHandle<R>, light_icons: bool) -> crate::Result<()>` — async + AppHandle<R>, regra dura do plugin (commands.rs:10-16). Os commands lib_* de mobile.rs NAO seguem essa regra (sao sincronos com State) porque nao passam por run_mobile_plugin; nao confundir os dois trilhos
- `CSS: @media (prefers-reduced-motion: reduce) em app.css zerando transicoes; o mesmo sinal alimenta shouldAnimate() da fase 1 (o rAF PARA, nao so as transicoes)`

**Testes:**

- vitest tokens.test.ts: para cada paleta, --t1/--t2/--t3 contra --s-base e --s-c com pisos 4.5 / 4.5 / 3.0; --accent contra --s-base >= 3.0; --on-accent contra --accent >= 4.5 (o buraco historico do Uvinha no desktop). Falha = build vermelho, nao inspecao visual
- vitest tweaks.test.ts += resolucao do modo efetivo (auto+sistema dark -> data-theme=dark; forcar light vence o sistema)
- Smoke S24: alternar o tema do Android com o app aberto (Auto tem que virar na hora, sem reiniciar); os tres modos em Home/Library/NowPlaying/Tweaks; capa saturada em modo claro (o ink nao pode sumir no branco)

### G6 — Temas do desktop no aparelho, exportados resolvidos (sem YAML no celular) · ~7h

**Entrega:** Os 12+ temas curados pelo theme-maker aparecem num picker no aparelho. O YAML nunca sai da cmr-auto: um script novo resolve, VALIDA (mesmo checker WCAG do backend) e mapeia pros tokens mobile, e o resultado viaja como quinto artefato de .rustify/, junto do manifest.

**Critério de pronto:** No S24: o picker lista os temas que existem na cmr-auto; escolher um muda superfícies, texto, accent e a cor do fundo animado de uma vez; 'Sem tema' devolve o tokens.css; a escolha sobrevive ao restart; nenhum tema entrega texto ilegivel (garantido no export, verificado por amostragem nas 4 telas principais).

**Depende de:** 1, 3, 5

**Gaps cobertos:** `themes-yaml`, `theme-yaml-mobile (a metade do YAML custom)`, `dirty-flag-reset (completa: agora ha tema disputando com o knob)`, `tweak-glow (so aqui passa a ter sentido; ver cortes)`

**Arquivos:**

- scripts/android/export_themes.py (CRIAR) — le os YAML via ssh cmr-auto (~/.local/share/rustify-player/themes/*.yaml, o mesmo diretorio do themes_dir() em desktop.rs:816), reaproveita LEGACY/parse de scripts/themes/validate.py (que ja replica yaml_key_to_css_prop + bridge + os pares WCAG), aplica o mapa desktop->mobile e emite themes.json. Sai com codigo 1 se qualquer tema reprovar — a validacao acontece no EXPORT, nao no aparelho
- scripts/android/export_manifest.py (EDITAR) — deploy_artifacts (:489-496) passa a levar 5 artefatos
- src-tauri/src/mobile_library.rs (EDITAR) — constante THEMES_REL = ".rustify/themes.json" ao lado das outras (:19-22) e carga tolerante a ausencia, no mesmo padrao do load_intel (:159-194)
- src-tauri/src/mobile.rs (EDITAR) — command lib_list_themes + registro no generate_handler (:143-155, hoje 11 commands)
- src/mobile/ipc.ts (EDITAR) — libListThemes()
- src/mobile/store/tweaks.ts (EDITAR) — themeFile + applyMobileTheme (escreve os tokens como inline vars no <html>) + snapshot themeVar() pro restauro do accent (removeProperty cairia nos defaults do tokens.css, mesmo erro que o desktop documenta em tweaks.ts:318-322)
- src/mobile/screens/Tweaks.tsx (EDITAR) — picker com 'Sem tema' sempre presente

**Contratos novos:**

- Artefato: <MUSIC_ROOT>/.rustify/themes.json = { "schema": 1, "themes": [ { "file": "really-dark.yaml", "name": "Really Dark", "mode": "dark"|"light", "tokens": { "--s-lowest": "#…", "--s-base": …, "--s-low": …, "--s-c": …, "--s-high": …, "--s-highest": …, "--t1": …, "--t2": …, "--t3": …, "--t4": …, "--accent": …, "--accent-c": …, "--on-accent": …, "--on-accent-c": …, "--div-subtle": …, "--div-prom": …, "--outline": …, "--ok": …, "--warn": …, "--err": …, "--bg-ink-rgb": "r, g, b" } } ] }
- Mapa desktop->mobile (o achado que torna isto barato — as duas escalas de surface tem o MESMO tamanho): --surface-lowest->--s-lowest, --surface->--s-base, --surface-container-low->--s-low, --surface-container->--s-c, --surface-container-high->--s-high, --surface-container-highest->--s-highest, --on-surface->--t1, --on-surface-variant->--t2, --on-surface-mute->--t3, --outline-variant->--outline (e --t4 derivado de --t3), --primary->--accent, --primary-container->--accent-c, --on-primary->--on-accent, --on-primary-container->--on-accent-c, --divider->--div-subtle, --divider-hi->--div-prom, --sig-ok/warn/err->--ok/--warn/--err, --bg-ink->--bg-ink-rgb
- Rust: `#[tauri::command] fn lib_list_themes(lib: State<Library>) -> Vec<MobileTheme>` — SINCRONO com State, igual aos outros lib_* (mobile.rs:26-42); a regra async+AppHandle vale so pros commands do plugin Kotlin
- `MobileTweaks += { themeFile: string|null }; THEME_GOVERNED passa a ser ['bgInk','lyricsGlass'] com o botao de reset ativo`

**Testes:**

- python3 scripts/android/export_themes.py --dry-run contra os YAML reais: 0 reprovacoes (pre-condicao de deploy, mesma regra do validate.py hoje)
- Teste do mapa em Python: cada token mobile obrigatorio presente na saida de todos os temas; falta = erro, nao warning
- cargo test do parse tolerante (themes.json ausente/corrompido -> vec vazio, sem panic; mesmo contrato do load_intel)
- Smoke S24 com 2 temas de identidade oposta + 'Sem tema'

**Cortado deste epic:**

- themes-yaml (parser no aparelho) — cortar o parser YAML, o watch_theme/hot-reload e o list_themes que le diretorio. O aparelho recebe JSON RESOLVIDO e validado no export. Custo evitado: portar serde_yaml + yaml_key_to_css_prop + bridge_legacy_to_extractor_lab + ensure_bg_ink_contrast pro alvo Android (dias), com o agravante de que a validacao WCAG no aparelho seria uma SEGUNDA implementacao da mesma matematica pra manter em sincronia.
- tweak-fonts — cortar o seletor de N familias e qualquer nocao de list_system_fonts (que nao faz sentido no Android). Sobra escolher entre as TRES ja bundladas (Inter/Fraunces/JetBrains Mono, MobileApp.tsx:19-27). Nao adicionar familia nova: cada uma custa KB no APK pra um ganho que o usuario ve uma vez.
- tweak-glow — cortar ate a fase 6. Nao existe --glow em tokens.css nem consumidor nenhum no CSS mobile; expor o slider hoje seria criar a var, inventar consumidores (halos que o design mobile nao tem) e entregar um knob decorativo. Depois dos temas ele vira o que e no desktop: um override theme-governed.
- dirty-flag-reset (inferencia retroativa) — cortar a parte que o desktop precisou (tweaks.ts:494-503 infere __dirty de estados salvos por versoes antigas). O schema mobile nasce agora com __dirty explicito; nao ha estado legado pra inferir. Manter so markDirty/clearDirty.
- lyrics-card-geometria (drag e resize) — cortar literalmente. Arrastar e redimensionar caixa com o dedo em 360dp e antipadrao; o equivalente de FEATURE e o knob S/M/L da fase 4. Junto cai o --lyrics-blur proporcional e a classe is-interacting (que existe no desktop so pra salvar o backdrop-filter durante o arrasto — sem arrasto e sem blur, nao ha o que salvar).
- landscape-tablet — cortar o reflow responsivo (ver decisao do CEO): travar portrait. Fica so a parte barata e real, as safe-areas laterais.
- bgInkCycle (ciclo de paleta) — nao esta na lista de gaps e nao entra: exige dominant_palette_v4 no manifest, que o export nao carrega. Registrar como pedido ao epic de biblioteca, nao implementar aqui.
- Knobs sem trilho no Android: eqSpectrumOverlay, loudnessNorm/loudnessTarget, sidebar, volume. Nao existem EQ, DSP nem controle de volume por app no plugin Kotlin — renderiza-los seria desenhar botao morto, exatamente o que o cabecalho de Settings.tsx:9-13 acertou em evitar.

**Riscos:**

- ZOOM QUEBRA A GEOMETRIA DO SHELL (fase 2). Sinal antecipado: com scale 1.25 o dock some da tela ou a barra de progresso do NowPlaying erra o ponto tocado (getBoundingClientRect sob zoom). Mitigacao ja embutida no plano: --ui-scale aplicada como zoom SO no .view e no bloco de letra, nunca no <html> — o chrome (dock, mini, overlay do NowPlaying) fica em 1.0. Se ainda assim escapar, reduzir o range para 0.9..1.15 antes de expor.
- MIGRACAO DAS 5 CHAVES SOLTAS APAGA AS PREFERENCIAS (fase 1). Sinal antecipado: depois do primeiro APK com o store, shape e renderer voltam ao default a cada boot. Causa conhecida e documentada no repo: createEffect module-level roda sincrono no import e salva DEFAULTS por cima do persistido antes do load. Mitigacao: gate _loaded (espelho de tweaks.ts:515) + teste dedicado que falha se save() rodar antes de loadTweaks() + NAO apagar as chaves antigas (permite rollback de APK sem perda).
- OFF-SWITCH DO FUNDO NAO ECONOMIZA NADA (fase 1). Sinal antecipado: com 'Fundo animado: Off' o `adb shell dumpsys gfxinfo dev.cmr.rustifyplayer` continua acumulando frames. Causa provavel: o early-return de spectrum.ts:158-161 foi mantido em vez do cancelamento real do rAF. Mitigacao: shouldAnimate() decide se RE-AGENDA (nao se desenha), com teste unitario da matriz.
- PALETA CLARA REVELA CONTRASTES QUE O DESIGN ASSUMIA ESCUROS (fase 5). Sinal antecipado: no primeiro APK claro, a letra sobre o card ou o mini-player somem. Mitigacao: o teste tokens.test.ts roda a MESMA matematica WCAG de src/lib/color.ts sobre as duas paletas e falha o build — o problema aparece no `vitest run`, nao no aparelho. Sinal tardio (pior): o ink adaptativo sumindo no branco, porque themeBase() cacheia o canvas escuro — por isso o cache cai na fase 3.
- MAPA DESKTOP->MOBILE PRODUZ TEMAS CHAPADOS (fase 6). Sinal antecipado: no primeiro tema exportado, cards e fundo ficam indistinguiveis (as 6 surfaces colapsaram) ou o accent some. Mitigacao: exportar DOIS temas de identidade oposta antes de escrever o picker, e manter 'Sem tema' sempre no topo da lista como saida garantida.
- REGRESSAO DE FPS AO ANIMAR COR (transversal). Sinal antecipado: 'mudanca de cores cai fps' — exatamente o incidente de 2026-07-17 no desktop. Mitigacao: regra dura ja no plano — nenhuma custom property de cor recebe transition no :root; a suavidade continua sendo o lerp por frame que o spectrum.ts:195-199 ja faz. Vale tambem pra troca de TEMA (fase 6) e de MODO (fase 5): os tokens saltam.
- APK COM UI VELHA (todas as fases). Sinal antecipado: 'a tela nao mudou' depois de instalar. Causa: nao ha beforeBuildCommand no tauri.conf.json — `bun run build` e MANUAL e obrigatorio antes de `cargo tauri android build --debug`. Mordeu em 13/08; cada fase termina com esse par de comandos, nunca so o cargo.

**Decisões do CEO neste epic:**

- **Tema claro de verdade (segunda paleta curada) ou assumir dark-only para sempre e cortar a fase 5?**  
  Recomendação: **Fazer a paleta clara.** — A regua do epic supoe 'revisar o app.css inteiro', mas o CSS mobile tem apenas 3 rgba() escuros literais e 2 #000 de mask — a paleta e um segundo bloco de 30 tokens com teste automatico de contraste, nao uma auditoria; e o custo de nao ter e permanente (o app fica preto ao meio-dia enquanto o resto do aparelho esta claro).
- **Landscape: travar portrait no manifest ou fazer o NowPlaying reflowar?**  
  Recomendação: **Travar portrait, e entregar as safe-areas laterais mesmo assim (fase 2) porque o notch lateral tambem aparece com o teclado e em telas dobraveis.** — Fingir suporte a landscape com layout de 360dp de largura e pior que assumir portrait; o unico consumidor de landscape hoje seria o proprio usuario segurando o telefone deitado, e o custo honesto do reflow (~4h) nao cabe antes de light/dark e temas.
- **Polaridade das barras do sistema quando o usuario FORCA um modo contra o sistema (fase 5): aceitar o desencontro ou criar o command Kotlin?**  
  Recomendação: **Command no plugin de audio existente.** — O AudioPlugin ja recebe `activity` (AudioPlugin.kt:82) e ja tem a infra de @Command/@InvokeArg; um crate novo custa 6x mais pelo mesmo efeito, e barra de status ilegivel aparece em TODA tela — nao e detalhe cosmetico isolado.
- **Onde mora o hub de Tweaks no mobile: rota propria /tweaks ou uma secao dentro de Settings?**  
  Recomendação: **Rota propria com as duas entradas.** — Sao ~18 controles ao fim da fase 6; empilhados no Settings afogam a raiz do acervo e o re-scan, e overlay flutuante em 360dp de largura briga com o gesto de voltar do Android (que o hash router usa de graca, nav.ts:1-10).
- **A fase 6 (temas exportados) vale ~7h depois que light/dark ja existir?**  
  Recomendação: **Fazer, mas por ultimo — e cortar sem dor se o orcamento apertar.** — O mapeamento 1:1 entre as duas escalas de surface e o validate.py ja pronto tornam o custo menor do que parece, mas o retorno e 'o celular parece o desktop', que e desejo de identidade, nao de uso; light/dark resolve o problema funcional sozinho.

---

## Epic H — Áudio no S24: normalização de loudness, EQ próprio e info técnica honesta

**Onda 4** · 6 fases · 27.5h estimadas pelo planejador

> Nada da cadeia DSP do desktop é portável: audio-engine é desktop-only por Cargo (PipeWire/GStreamer/LV2) e o Android só tem o pipeline do ExoPlayer. Mas o precedente já está no repo: SpectrumTap.kt é um AudioProcessor que roda no DefaultAudioSink e faz FFT em tempo real sem permissão nenhuma — o mesmo lugar aceita ganho, biquads e limiter. A estratégia é um único processador próprio (DspKernel puro + RustifyDsp wrapper), alimentado por dados que já existem no Qdrant e hoje não viajam (lufs_integrated, sample_rate, bit_depth): primeiro o trilho de dados e a info técnica, depois a normalização (o ganho por faixa é o incômodo diário no fone), depois o EQ com a tela Signal do handoff, e por fim os itens baratos e mobile-first (volume in-app, sleep timer, retomada no bluetooth). Rejeitado android.media.audiofx: 5 bandas, efeito global de sessão, no-op em vários fabricantes — UI prometendo o que o aparelho não entrega.


### H1 — Manifest v2 + info técnica real da faixa · ~4h

**Entrega:** O usuário abre o Now Playing, toca no botão de info e vê o que está tocando DE VERDADE: codec, sample rate, canais, kbps médio, tamanho, e a especificação da FONTE no desktop (FLAC 16/44.1) ao lado — é como ele detecta transcode ruim. Sem nenhum processamento de áudio ainda.

**Critério de pronto:** No S24, com manifest v2 deployado: o sheet do Now Playing mostra OPUS · 48 kHz · Stereo · ~192 kbps · tamanho, e a linha "Fonte: FLAC 16/44.1 · -9.4 LUFS"; Settings mostra "manifest v2 · 1746 faixas · 1746 com LUFS". Com o manifest v1 antigo no aparelho, o app abre normal e o sheet mostra só o que dá (sem linha de fonte) — nada quebra.

**Gaps cobertos:** `tech-info-pill`, `formats-support`

**Arquivos:**

- scripts/android/export_manifest.py — FIELDS += lufs_integrated, sample_rate, bit_depth, channels; build_manifest emite "schema": 2 e por track os campos lufs, src_sample_rate, src_bit_depth, src_channels
- src-tauri/src/mobile_library.rs — Manifest ganha `#[serde(default)] schema: i64`; ManifestTrack ganha os 4 campos novos com `#[serde(default)]` (manifest v1 continua carregando); Track ganha lufs/src_sample_rate/src_bit_depth/src_channels/file_size_bytes/codec (codec derivado da extensão no walk, file_size_bytes de DirEntry::metadata); load() guarda schema + contagens
- src-tauri/src/mobile.rs — command novo lib_manifest_info; registrar no generate_handler!
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/PlaybackBus.kt — PlaybackSnapshot ganha codec/sampleRate/channels/bitrate; snapshotOf lê o Format selecionado via currentTracks, guardado por isCommandAvailable(Player.COMMAND_GET_TRACKS)
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — snapshotToJs emite os 4 campos novos (JSONObject.NULL no codec ausente, -1 em bitrate desconhecido)
- src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs — PlaybackState ganha os 4 campos com #[serde(default)]
- src/mobile/types.ts — Track e PlaybackState com os campos novos; interface ManifestInfo
- src/mobile/ipc.ts — libManifestInfo()
- src/mobile/store.ts — applyState faz merge por chave presente dos 4 campos novos (não zerar no tick de position)
- src/mobile/components/TrackInfoSheet.tsx — NOVO, porte do sheet do handoff (.sheet/.kv)
- src/mobile/components/NowPlaying.tsx — botão de info no nphead abrindo o sheet; remover o comentário de linha 9-10 que declara a ausência
- src/mobile/styles/app.css — portar .sheet/.kv do handoff (app.css:94-104) e tirar da lista de [v0] omitidos
- src/mobile/screens/Settings.tsx — painel Library ganha linha "Manifest" (schema, geradas em, faixas com LUFS/vetor/letra)
- docs/android/ipc-contrato-v0.md e src-tauri/crates/tauri-plugin-rustify-audio/README.md — contrato do snapshot e do manifest v2

**Contratos novos:**

- `manifest.json v2: {"schema":2, tracks:[{..., "lufs": -9.4|null, "src_sample_rate": 44100, "src_bit_depth": 16, "src_channels": 2}]}`
- Rust: #[tauri::command] fn lib_manifest_info(lib: State<Library>) -> ManifestInfo { schema: i64, generated_at: i64, track_count: usize, unresolved: usize, with_lufs: usize, with_vector: usize, with_lrc: usize }
- `Kotlin: data class PlaybackSnapshot(..., val codec: String?, val sampleRate: Int, val channels: Int, val bitrate: Int)`
- `TS: interface PlaybackState { ...; codec: string | null; sampleRate: number; channels: number; bitrate: number }`
- `TS: Track ganha lufs: number|null; src_sample_rate/src_bit_depth/src_channels: number|null; file_size_bytes: number; codec: string|null`

**Testes:**

- cargo test: mobile_library parseia manifest v2 completo, manifest v1 sem os campos (todos None, sem panic) e manifest com lufs=null; codec derivado da extensão (.opus/.m4a/.flac) e kbps médio a partir de file_size_bytes+duration_ms
- vitest src/mobile/trackInfo.test.ts: formatação das linhas do sheet (48 kHz, Stereo, 192 kbps, 5.4 MB) e o caso bitrate=-1 (cai no calculado, rotulado "médio")
- npm run typecheck
- smoke S24: tocar 1 faixa opus e 1 mp3 (se houver), conferir o sheet contra `ffprobe` do mesmo arquivo na cmr-auto

### H2 — Normalização de loudness (processador próprio + ganho por faixa) · ~6h

**Entrega:** Fila heterogênea (station, rádio, shuffle) para de pular de volume entre faixas. Toggle e alvo LUFS em Settings; ligado por padrão em -14 LUFS.

**Critério de pronto:** No S24: com o toggle ligado, tocar uma station de 6 faixas heterogêneas sem encostar no volume do sistema — nenhum degrau incômodo; desligando o toggle, o degrau volta na hora. dsp_get_state devolve active=true, formatSupported=true e appliedGainDb batendo com (alvo − LUFS da faixa). Sem manifest v2 (lufs ausente), nada quebra: ganho 0 dB e Settings avisa "rode o export".

**Depende de:** 1

**Gaps cobertos:** `dsp-loudness-norm`, `loudness-norm-mobile`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/DspKernel.kt — NOVO, Kotlin PURO (zero import android.*): gainFromLufs(lufs, target) com clamp assimétrico, rampa exponencial de ganho, limiter peak com lookahead de 5 ms e teto configurável, process(ShortArray, frames, channels)
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/RustifyDsp.kt — NOVO, BaseAudioProcessor que embrulha o DspKernel (mesmo molde do SpectrumTap: onConfigure devolve NOT_SET fora de ENCODING_PCM_16BIT) + `object DspBus` com a config @Volatile e o ponteiro pro processador vivo
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt — setAudioProcessors(arrayOf(RustifyDsp(), SpectrumTap())) nessa ordem (o espectro passa a refletir o que se ouve); adoptCurrent empurra QueueMeta.lufsFor(trackId) pro DspBus
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/QueueMeta.kt — mapa lufs por trackId; set() ganha o 4o parâmetro
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — QueueItemArg ganha `var lufs: Float? = null`; commands dspSetConfig e dspGetState
- src-tauri/crates/tauri-plugin-rustify-audio/src/models.rs — QueueItem ganha lufs: Option<f32>; structs DspConfig, DspBand, DspState
- src-tauri/crates/tauri-plugin-rustify-audio/src/commands.rs e src/mobile.rs — dsp_set_config / dsp_get_state (async fn com AppHandle<R>, regra dura do plugin)
- src-tauri/crates/tauri-plugin-rustify-audio/src/lib.rs, build.rs, permissions/default.toml — registrar os 2 commands (COMMANDS + allow-dsp-set-config/allow-dsp-get-state)
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/test/java/DspKernelTest.kt — NOVO (junit já está declarado no build.gradle.kts do plugin)
- src/mobile/dsp.ts — NOVO, store local do DSP com persistência em localStorage `kv-mobile-dsp`, debounce de 80 ms e push via dspSetConfig
- src/mobile/ipc.ts — dspSetConfig(config)/dspGetState(); toQueueItem passa lufs: t.lufs
- src/mobile/screens/Settings.tsx — painel Playback com "Normalizar volume entre faixas" (.tog) + alvo LUFS (.range), texto do handoff; tirar "normalização de loudness" da lista de cortes do cabeçalho
- src/mobile/styles/app.css — portar .tog e .range do handoff (app.css:131-140)
- src/mobile/MobileApp.tsx (ou store.bootStore) — push da config salva no boot, com o mesmo retry do bootCall

**Contratos novos:**

- `Kotlin: @Command fun dspSetConfig(invoke: Invoke) / @Command fun dspGetState(invoke: Invoke)`
- `Rust: pub(crate) async fn dsp_set_config<R: Runtime>(app: AppHandle<R>, config: DspConfig) -> crate::Result<()>`
- `Rust: pub(crate) async fn dsp_get_state<R: Runtime>(app: AppHandle<R>) -> crate::Result<DspState>`
- `DspConfig (camelCase no wire): { enabled: bool, preampDb: f32, bands: Vec<DspBand>, normEnabled: bool, normTargetLufs: f32, limiterEnabled: bool, limiterCeilingDb: f32, bassShelfDb: f32 }`
- `DspBand: { freq: f32, gainDb: f32, q: f32 }`
- `DspState: { active: bool, formatSupported: bool, sampleRate: i32, appliedGainDb: f32, limiterActive: bool }`
- `TS: dspSetConfig = (config: DspConfig) => invoke(cmd("dsp_set_config"), { config })  // o wrapper Rust recebe UM campo `config`, diferente do set_queue que é achatado`
- `QueueItem ganha lufs?: number | null (Kotlin QueueItemArg.lufs: Float?)`
- `localStorage `kv-mobile-dsp` = JSON do DspConfig`

**Testes:**

- gradle unit test (novo alvo real): cd src-tauri/gen/android && ./gradlew :tauri-plugin-rustify-audio:testDebugUnitTest — gainFromLufs(-9.4, -14) = -4.6; clamp inferior/superior; lufs ausente = 0 dB; NaN = 0 dB; limiter nunca deixa amostra passar do teto (varredura de senóide a +12 dB); ganho 0 dB é identidade bit a bit; rampa é monotônica e chega ao alvo em <= 200 ms a 48 kHz
- cargo test: serde roundtrip de DspConfig/QueueItem com e sem lufs
- vitest src/mobile/dsp.test.ts: defaults, clamp do alvo (-20..-6), roundtrip do localStorage, payload exato mandado ao IPC e coalescência do debounce
- medição-gate na cmr-auto (antes de codar): ffmpeg -af ebur128 em 20 .opus do staging vs lufs_integrated do Qdrant — se |delta| mediano > 1 LU, o LUFS tem de ser medido no arquivo do celular (ver decisão do CEO)
- smoke S24: fila com uma faixa de master moderno e uma de 2005, medir com app de SPL/ouvido; logcat sem AudioTrack underrun

### H3 — Equalizador de 10 bandas + tela Signal · ~10h

**Entrega:** Rota /signal (a partir de Settings, como no handoff): card da cadeia com estado por estágio, 10 sliders verticais (32 Hz a 16 kHz), preamp, bypass mestre e a seção Output com o que dá para medir de verdade. É a entrega que muda o som no fone.

**Critério de pronto:** No S24, com fone: puxar o slider de 63 Hz para +6 dB muda o som imediatamente e sem estalo; bypass mestre devolve o som original; a config sobrevive ao fechar e reabrir o app e ao reboot; Settings mostra "EQ · LIM" na linha do Signal; nenhum underrun no logcat em 10 minutos de reprodução contínua.

**Depende de:** 2

**Gaps cobertos:** `dsp-eq`, `screen-signal`, `dsp-limiter-bass`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/DspKernel.kt — biquads peaking (RBJ cookbook) por banda e por canal, low-shelf do bass em 90 Hz, preamp; recálculo de coeficientes só em setConfig/onConfigure, nunca por buffer
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/test/java/DspKernelTest.kt — testes de resposta dos filtros
- src/mobile/dsp.ts — bandas no store (freq/gainDb/q), presets locais mínimos (Flat, Fone, Grave+, Voz) como constantes
- src/mobile/screens/Signal.tsx — NOVO, porte de S.signal do handoff (screens.js:132-136)
- src/mobile/MobileApp.tsx — case "/signal" no screen()
- src/mobile/nav.ts — /signal conta como aba /settings em activeTab()
- src/mobile/screens/Settings.tsx — linha "Signal · DSP chain" com o resumo (EQ · LIM · BASS / BYPASS / DSP OFF) navegando pra /signal; tirar "tela Signal/EQ" da lista de cortes
- src/mobile/components/NowPlaying.tsx — resumo da cadeia como chip no sheet de info (equivalente do dspSummary do PlayerBar desktop)
- src/mobile/styles/app.css — estilos dos sliders verticais e do card de cadeia do handoff

**Contratos novos:**

- `Nenhum command novo: a config inteira já viaja no dspSetConfig da fase 2 (decisão deliberada — o desktop tem ~40 commands dsp_*, aqui é um só, idempotente, igual ao applyFullDspState)`
- `localStorage `kv-mobile-dsp` passa a carregar bands[] preenchido (10 entradas, q fixo 1.1)`

**Testes:**

- gradle unit test: banda em +6 dB a 1 kHz eleva a energia de uma senóide de 1 kHz em ~6 dB e deixa 100 Hz dentro de 0.5 dB; todas as bandas em 0 dB = identidade; preamp -6 dB reduz 6 dB
- vitest: store de bandas (clamp -12..+12), presets aplicam a curva certa, payload do IPC contém as 10 bandas
- npm run typecheck
- smoke S24 com fone: varredura ouvida por banda (grave/médio/agudo) + verificar CPU no logcat/Perfetto; conferir que o SpectrumTap (fundo) reage à mudança de EQ, provando a ordem da cadeia

### H4 — Volume in-app e mute · ~3h

**Entrega:** Slider de volume fino do app (somado ao do sistema) no Now Playing e em Settings, com mute de um toque e persistência de preferência entre sessões.

**Critério de pronto:** No S24: slider do app em 50% com volume do sistema no máximo soa nitidamente mais baixo; mute silencia em um toque e volta ao valor anterior; reabrir o app mantém 50%.

**Depende de:** 2

**Gaps cobertos:** `volume-in-app`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — @InvokeArg VolumeArgs + @Command setVolume (withController { it.volume = v.coerceIn(0f,1f) })
- src-tauri/crates/tauri-plugin-rustify-audio/src/{models.rs,commands.rs,mobile.rs,lib.rs,build.rs,permissions/default.toml} — set_volume
- src/mobile/ipc.ts — playerSetVolume(volume)
- src/mobile/store.ts — changeVolume(v) como FONTE ÚNICA (store + localStorage + IPC), applyPersistedVolume() no bootStore, toggleMute()
- src/mobile/components/NowPlaying.tsx — slider + botão de mute
- src/mobile/screens/Settings.tsx — linha Volume do handoff; tirar "volume" da lista de cortes

**Contratos novos:**

- `Kotlin: @Command fun setVolume(invoke: Invoke) — { volume: Float 0..1 }`
- `Rust: pub(crate) async fn set_volume<R: Runtime>(app: AppHandle<R>, volume: f32) -> crate::Result<()>`
- `localStorage `kv-mobile-volume` (número 0..1) e `kv-mobile-muted` ("1"/ausente) — espelho do kv-volume do desktop, com prefixo mobile`

**Testes:**

- vitest src/mobile/volume.test.ts: changeVolume persiste e chama o IPC uma vez; mute guarda o valor anterior e restaura; boot restaura o valor salvo (mesmo padrão do player.volume.test.ts do desktop)
- npm run typecheck
- smoke S24: mexer no slider do app não mexe no volume do sistema; matar e reabrir o app mantém o valor; a normalização continua correta (o ganho vive no processador, não no player.volume)

### H5 — Sleep timer · ~2.5h

**Entrega:** Dormir ouvindo: 15/30/45/60 min ou "fim da faixa", com fade-out de 20 s, contagem regressiva visível e cancelamento. Funciona com a tela apagada.

**Critério de pronto:** No S24 com a tela apagada, timer de 2 min pausa a música com fade suave no minuto 2; a notificação de mídia continua viva e o botão play retoma; cancelar o timer no meio mantém a música tocando.

**Depende de:** 2

**Gaps cobertos:** `sleep-timer`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt — `object SleepTimer` (deadline @Volatile) consumido pelo tick de 500 ms que JÁ existe (linhas 239-258): fade via DspKernel e pause no zero; sleepRemainingMs entra no snapshot
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/PlaybackBus.kt — PlaybackSnapshot ganha sleepRemainingMs: Long
- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt — @Command setSleepTimer + campo novo no snapshotToJs
- src-tauri/crates/tauri-plugin-rustify-audio/src/{models.rs,commands.rs,mobile.rs,lib.rs,build.rs,permissions/default.toml}
- src/mobile/ipc.ts, src/mobile/types.ts, src/mobile/store.ts — sleepRemainingMs no espelho
- src/mobile/components/NowPlaying.tsx — botão de timer + contagem regressiva

**Contratos novos:**

- `Kotlin: @Command fun setSleepTimer(invoke: Invoke) — { minutes: Int (0 = cancelar), untilTrackEnd: Boolean, fadeSeconds: Int = 20 }`
- `Rust: pub(crate) async fn set_sleep_timer<R: Runtime>(app: AppHandle<R>, minutes: u32, until_track_end: bool, fade_seconds: u32) -> crate::Result<()>`
- `PlaybackState ganha sleepRemainingMs: i64 (0 = desarmado)`

**Testes:**

- gradle unit test: curva de fade (ganho 1.0 → 0 em fadeSeconds, monotônica)
- vitest: formatação da contagem regressiva e o caso desarmado
- smoke S24 (o único que prova a feature): armar 2 min, apagar a tela, confirmar pausa com fade e que o app NÃO some da notificação antes da hora

### H6 — Retomada ao reconectar fone/bluetooth · ~2h

**Entrega:** Voltar pro carro ou plugar o fone retoma a música que o becoming-noisy pausou — com guarda estrita pra nunca tocar sozinho fora desse caso.

**Critério de pronto:** No S24 com fone BT: desconectar pausa, reconectar em menos de 30 min retoma de onde parou; conectar o fone com o app aberto e nunca tendo tocado não inicia nada; toggle desligado restaura o comportamento atual.

**Gaps cobertos:** `headphone-bluetooth-detail`

**Arquivos:**

- src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt — registrar AudioDeviceCallback; marcar pausedByNoisyAt/pausedByNoisyDeviceType quando o pause vier do becoming-noisy; retomar só se (a) o dispositivo adicionado for A2DP/WIRED_HEADPHONES, (b) o pause tiver < 30 min, (c) nada tiver tocado nesse meio-tempo e (d) o toggle estiver ligado
- src/mobile/screens/Settings.tsx — toggle "Retomar ao reconectar o fone" (default ligado) persistido em `kv-mobile-resume-on-connect` e empurrado dentro do DspConfig? NÃO — command próprio, ver contratos
- src-tauri/crates/tauri-plugin-rustify-audio/{android/.../AudioPlugin.kt,src/models.rs,src/commands.rs,src/mobile.rs,src/lib.rs,build.rs,permissions/default.toml} — set_resume_on_connect

**Contratos novos:**

- `Kotlin: @Command fun setResumeOnConnect(invoke: Invoke) — { enabled: Boolean }`
- `Rust: pub(crate) async fn set_resume_on_connect<R: Runtime>(app: AppHandle<R>, enabled: bool) -> crate::Result<()>`
- `localStorage `kv-mobile-resume-on-connect``

**Testes:**

- Não há teste automatizado honesto aqui: é comportamento de dispositivo. Smoke S24 obrigatório com fone BT REAL (não emulador): tocar, desligar o fone (pausa), religar (retoma); repetir com o app em background e com 40 min de espera (NÃO deve retomar); ligar o fone com o app parado desde o boot (NÃO deve retomar); receber uma ligação com fone conectado (não pode retomar por cima)

**Cortado deste epic:**

- speed-pitch — não é gap (não existe nos dois lados) e ninguém pediu; ExoPlayer daria de graça, mas abre superfície de UI e mexe na relação posição/duração que o journal usa. Custo real de cortar: zero.
- dsp-limiter-bass (parte 'Bass Enhancer de verdade') — o estágio de harmônicos do Calf não é portável nem barato de acertar de ouvido; entra como low-shelf de 90 Hz na fase 3. O limiter, esse, fica (é o que torna seguro o ganho positivo).
- dsp-eq (os ~40 commands dsp_* do desktop) — no celular não se edita tipo de filtro, slope, filter mode, solo/mute por banda, oversampling nem dither. Fica peaking fixo com Q 1.1, preamp e bypass mestre. Cortar isso é o que faz a fase 3 caber em 10h em vez de 30h.
- screen-signal (import/export de preset EasyEffects) — src/store/dsp-presets.ts é acoplado ao store desktop e ao IPC do GStreamer; no Android não há trilho de arquivo pra preset. Entram 4 presets locais em constante.
- screen-signal (linha 'Crossfeed' do card do handoff) — não existe nem no desktop; desenhar um estágio morto no card seria botão morto, exatamente o que o Settings mobile evitou até aqui.
- screen-signal (linha 'Buffer' da seção Output do handoff) — o ExoPlayer não expõe tamanho de buffer de forma honesta; a seção mostra só sample rate, canais e encoding reais do sink.
- formats-support — nada a fazer: o walk mobile já aceita 7 extensões e o ExoPlayer decodifica todas. O que faltava era EXIBIR, e isso é a fase 1.

**Riscos:**

- Saída do sink não ser PCM 16-bit (float output ligado por algum caminho): o processador devolve NOT_SET e vira passthrough silencioso — EQ e normalização deixam de existir sem erro nenhum. Sinal antecipado: dsp_get_state devolve formatSupported=false, e o fundo com beat sync (SpectrumTap, que tem o mesmo fallback) para de reagir. Mitigação: a tela Signal mostra o estado real, não o desejado.
- Latência do AudioTrack faz o ganho novo pegar 0,3-0,7 s depois na transição AUTOMÁTICA (no skip o sink é esvaziado e a troca é imediata): degrau audível no comecinho da faixa seguinte numa fila de rádio. Sinal antecipado: no smoke da fase 2, ouvir a passagem entre uma faixa alta e uma baixa em auto-advance. Mitigação: rampa de 150 ms; se ficar audível, avaliar antecipar o ganho pelo tempo restante da faixa corrente.
- Custo de CPU do kernel na thread de áudio causando underrun (crackle): 10 biquads x 2 canais + limiter com lookahead é barato, mas erro de alocação por buffer mata. Sinal antecipado: 'AudioTrack underrun' no logcat e chiado no S24 com EQ ligado. Regra: zero alocação dentro de process(), buffers pré-alocados no onConfigure.
- Processamento do fabricante por cima (SoundAlive/Dolby da Samsung): a curva ouvida não bate com os sliders e o usuário conclui que o EQ está quebrado. Sinal antecipado: varredura por banda no fone soando deslocada. Mitigação: documentar na tela e comparar com o efeito do sistema desligado.
- O usuário não roda o export e fica com manifest v1: normalização silenciosamente desligada e a tela prometendo o que não acontece. Sinal antecipado: a linha 'manifest v1' em Settings e with_lufs=0. Já é o critério de pronto da fase 1.
- Conflito de merge em Settings.tsx/NowPlaying.tsx com os epics de telas e visual, que reescrevem os mesmos arquivos. Sinal antecipado: dois epics em execução simultânea sem worktree. Mitigação: sequenciar ou isolar.
- Esquecer o `bun run build` antes do `cargo tauri android build` — o APK sai com o dist velho e a UI 'não muda' (já mordeu em 13/08). Sinal antecipado: o Settings novo não aparece mas o log Rust mostra o command novo respondendo.

**Decisões do CEO neste epic:**

- **Ganho positivo de normalização (faixa antiga baixa sobe até +12 dB, protegida por limiter) ou atenuar-somente (nunca sobe, tudo desce até a faixa mais alta)?**  
  Recomendação: **Ganho bidirecional com limiter** — Atenuar-somente ancora a biblioteca inteira na faixa mais alta e deixa o acervo antigo baixo demais no fone na rua; o limiter que torna o boost seguro é ~80 linhas do mesmo kernel e vira knob de UI depois.
- **De onde vem o LUFS: reaproveitar o lufs_integrated medido no FLAC do desktop (de graça no manifest) ou medir o .opus do celular no staging?**  
  Recomendação: **Reusar o do FLAC, com um gate de medição de 20 faixas antes de codar a fase 2** — Transcode Opus 192k preserva loudness percebida; se a medição de amostra mostrar delta mediano acima de 1 LU eu inverto a decisão sem custo (só muda a origem do campo, não o contrato).
- **Quantas bandas de EQ: 10 (layout do handoff, 32 Hz a 16 kHz) ou 16 (paridade exata com o desktop, 25 Hz a 20 kHz)?**  
  Recomendação: **10 bandas** — Em 6,4 cm de largura útil, 16 sliders viram alvo de 3 px e ninguém acerta a banda certa; o kernel é genérico em N, então virar 16 depois é mudar uma constante — e curva de 10 bandas é reamostrável se um dia quisermos compartilhar preset com o desktop.
- **Bass Enhancer: reimplementar o de verdade (geração de harmônicos psicoacústica, como o Calf do desktop) ou entregar um low-shelf de 90 Hz com um knob?**  
  Recomendação: **Low-shelf** — Em fone pequeno o ganho perceptível vem quase todo do shelf; o gerador de harmônicos custa mais que o EQ inteiro e é o estágio com maior chance de soar pior que o original.
- **Retomar a reprodução ao reconectar fone/bluetooth (fase 6) ou não mexer em foco de áudio?**  
  Recomendação: **Implementar com a guarda** — É o incômodo real do carro e a guarda cobre o modo de falha que importa (tocar sozinho); o custo é 2h e o toggle é a saída de emergência se der ruim.
- **Ordem: normalização (fase 2) antes do EQ (fase 3), ou EQ primeiro?**  
  Recomendação: **Loudness primeiro** — O processador nasce na fase 2 de qualquer jeito (o EQ só acrescenta biquads a ele) e o pulo de volume entre faixas incomoda todo dia, enquanto o EQ é ajuste que se faz uma vez.

---

## Epic I — Epic I — Navegacao e descoberta no S24: ordenar, filtrar, fixar, achar e semear

**Onda 4** · 6 fases · 26h estimadas pelo planejador

> O nucleo nao e falta de tela: e que o acervo no celular so pode ser percorrido de um jeito — ordem fixa em toda lista, zero filtro, zero memoria de escolha, Stations num beco sem entrada e busca que so casa substring de titulo. A estrategia e atacar por camadas de custo crescente: primeiro o que e puro frontend sobre dado que JA esta no aparelho (ordem, filtro, pins, mosaico, busca com acoes), depois o que exige leitura nova em Rust local (busca na letra dos sidecars .lrc, station por centroide de vetores), e cortar de saida tudo que depende de trilho remoto ou de dado que o export ainda nao manda (Crate, mood, semantica de texto). Nenhuma fase inventa origin novo — o motor de sinal fica intocado.


### I1 — Ordem, filtro e alcance · ~4h

**Entrega:** O usuario escolhe a ordem de cada lista (incluindo 'adicionadas recentemente'), filtra a lista de Faixas pela pasta de origem, volta pra Library e encontra a faceta onde deixou, chega em Stations pela propria Library (hoje so ha caminho se o card da Home aparecer) e nao perde a posicao de rolagem ao voltar de um album.

**Critério de pronto:** No S24: (a) na faceta Faixas o seletor 'Recentes' poe no topo a ultima leva baixada, conferida contra ls -lt do staging na cmr-auto; (b) escolher 'Artistas', sair da aba e voltar mantem 'Artistas'; (c) a linha Stations aparece em Colecoes MESMO com stations() vazio e leva a tela com a mensagem de export; (d) descer ~300 faixas na Library, abrir um album e voltar mantem a posicao de rolagem; (e) com o manifest antigo (sem indexed_at) o app nao quebra e a opcao 'Recentes' simplesmente nao aparece.

**Gaps cobertos:** `lib-sem-ordenacao`, `lib-generos-ausentes (so a metade FILTRO; a aba Generos esta cortada)`, `genres-facet (idem)`, `extra-ceticos/telas: Stations quase inalcancavel na navegacao`, `extra-ceticos/telas: sem ordenacao ou filtro em qualquer lista mobile`, `extra-ceticos/biblioteca: nao existe nocao de 'adicionado recentemente' no celular`, `extra-ceticos/visual: scroll position nao restaurada ao voltar`, `extra-ceticos/telas: Folder mobile engole erro de IPC (vazio mascarando falha)`

**Arquivos:**

- scripts/android/export_manifest.py — FIELDS ganha 'indexed_at' e 'mtime' (ambos JA existem no payload de rustify_tracks, gravados em crates/library-indexer/src/pipeline.rs:701); build_manifest emite 'indexed_at': to_int(pl.get('indexed_at')) or to_int(pl.get('mtime')) or None
- src-tauri/src/mobile_library.rs — ManifestTrack e Track ganham indexed_at: Option<i64> (#[serde(default)] no ManifestTrack pra manifest antigo nao quebrar o parse)
- src/mobile/types.ts — Track.indexed_at: number | null
- src/mobile/derive.ts — funcoes puras novas: sortTracks/sortFolders/sortAlbums/sortArtists, filterTracksByGenre, genreOptions, hasRecency
- src/mobile/derive.test.ts — casos das novas puras
- src/mobile/screens/Library.tsx — faceta persistida (substitui createSignal<Facet>('folders') de Library.tsx:29), barra de ordenacao por faceta, chiprow de filtro na faceta Faixas, linha 'Stations' na secao Colecoes (hoje so tem Fila, Library.tsx:118-127)
- src/mobile/screens/Folder.tsx — data.error renderizado como erro real em vez de cair no Empty 'Pasta vazia' (Folder.tsx:21 e :39)
- src/mobile/MobileApp.tsx — Map de scrollTop por chave de rota; o createEffect de MobileApp.tsx:115-118 passa a restaurar em vez de zerar sempre
- src/mobile/styles/app.css — .sortbar (reaproveita o visual de .chip/.chiprow ja existentes em :61-79)

**Contratos novos:**

- `manifest.json (por faixa): "indexed_at": <int unix seconds> | null — campo OPCIONAL, schema do manifest continua 1`
- `Rust: pub indexed_at: Option<i64> em mobile_library::Track e em ManifestTrack`
- `TS: interface Track { ...; indexed_at: number | null }`
- `TS: export type SortMode = "manifest" | "name" | "title" | "recent" | "duration" | "count"`
- `TS: export function sortTracks(list: Track[], mode: SortMode): Track[] — puro, nao muta, faixa com indexed_at null vai pro fim em 'recent'`
- `TS: export function filterTracksByGenre(list: Track[], genre: string | null): Track[] — comparacao por normalize()`
- `TS: export function genreOptions(list: Track[]): Array<{ name: string; count: number }> — ordenado por count desc, empate por nome pt-BR`
- `localStorage kv-mobile-facet: "folders" | "albums" | "artists" | "tracks"`
- `localStorage kv-mobile-sort: JSON {"folders":SortMode,"albums":SortMode,"artists":SortMode,"tracks":SortMode}`

**Testes:**

- vitest (src/mobile/derive.test.ts): sortTracks 'recent' poe indexed_at null no fim e e estavel; sortTracks 'duration'/'title' nao mutam a entrada; filterTracksByGenre insensivel a acento e caixa; genreOptions com contagem correta e faixa sem genre ignorada
- cargo test (mobile_library): manifest sem o campo indexed_at desserializa com None; manifest com o campo desserializa o valor
- npm run typecheck + npm test + cargo test antes do commit
- Smoke S24 (roteiro): rodar export_manifest.py --deploy, phone_push_retry.sh, lib_rescan; conferir que a leva mais recente do staging (ls -lt na cmr-auto) aparece no topo com o seletor 'Recentes'

### I2 — Identidade das pastas: mosaico 2x2 e pins · ~3h

**Entrega:** Pastas param de ser linhas identicas: cada uma mostra ate 4 capas distintas do proprio conteudo e as fixadas sobem pra uma secao no topo que sobrevive a matar o app.

**Critério de pronto:** No S24: cada card da faceta Pastas mostra ate 4 capas distintas daquela pasta (nao a capa da primeira faixa repetida); fixar uma pasta a move pra secao 'Fixadas' no topo e isso sobrevive a force-stop + reabrir; pasta sem capa nenhuma continua com o tom deterministico, sem buraco branco.

**Depende de:** fase 1 (mesmo arquivo Library.tsx; evita conflito de edicao)

**Gaps cobertos:** `lib-mosaico-capas`, `lib-sem-pins`, `playlists-screen (o valor — mosaico + pin — entregue dentro da faceta Pastas; a tela dedicada esta cortada)`

**Arquivos:**

- src-tauri/src/mobile_library.rs — struct Folder (hoje {name, track_count} em :65-69) ganha cover_paths; folders() (:280-285) coleta ate 4 capas DISTINTAS na ordem do manifest a partir dos indices da pasta
- src/mobile/types.ts — Folder.cover_paths: string[]
- src/mobile/components/Cover.tsx — novo export CoverMosaic (grid 2x2, cai pro <Cover seed> quando ha 0 capas, preenche com o tom quando ha 1-3)
- src/mobile/pins.ts (novo) — porte do padrao de src/store/pins.ts com chave propria
- src/mobile/pins.test.ts (novo)
- src/mobile/screens/Library.tsx — secao 'Fixadas' no topo da faceta Pastas + botao de pin no canto de cada linha (Library.tsx:48-64)
- src/mobile/screens/Folder.tsx — hero usa CoverMosaic em vez da capa da PRIMEIRA faixa (Folder.tsx:28) e ganha toggle de pin
- src/mobile/screens/Home.tsx — rail de Pastas (Home.tsx:93-111) usa mosaico e lista as fixadas primeiro
- src/mobile/styles/app.css — .mosaic (grid 2x2 herdando a caixa de .cov/.art)

**Contratos novos:**

- `Rust: pub struct Folder { pub name: String, pub track_count: usize, pub cover_paths: Vec<String> } — no maximo 4, paths ABSOLUTOS do aparelho, sem repeticao`
- `TS: interface Folder { name: string; track_count: number; cover_paths: string[] }`
- `localStorage kv-mobile-pins: string[] (nomes de pasta; a ordem do array E a ordem de exibicao)`
- `TS (src/mobile/pins.ts): pins(): string[]; isPinned(name: string): boolean; togglePin(name: string): void`

**Testes:**

- cargo test (mobile_library): pasta com 6 faixas de 3 capas distintas devolve 3 paths sem repeticao; pasta com 10 capas distintas devolve exatamente 4; pasta sem cover.jpg devolve vec vazio
- vitest (pins.test.ts): toggle adiciona/remove, ordem de fixacao preservada, localStorage corrompido cai pra lista vazia sem lancar
- Smoke S24: rolar a faceta Pastas com todas as pastas do acervo e observar engasgo de scroll (gatilho do risco 2)

### I3 — Busca que responde: debounce, melhor resultado e acoes · ~4h

**Entrega:** A busca para de travar a digitacao, tem X pra limpar, diz quantos resultados existem alem dos que mostra, destaca o melhor acerto e traz acoes (Shuffle all, Abrir fila, Stations, Radio desta faixa) misturadas aos resultados — a camada de comandos da paleta do desktop, no formato que o celular comporta.

**Critério de pronto:** No S24: digitar uma query de 3 letras que casa centenas de faixas nao trava a digitacao; o X limpa o campo e volta pras buscas recentes; o cabecalho do bloco Faixas diz 'mostrando 120 de 412'; 'Melhor resultado' aparece no topo com o acerto obvio; tocar a acao 'Shuffle all' comeca a tocar sem sair da busca.

**Depende de:** fase 1

**Gaps cobertos:** `command-palette (a camada de ACOES; o overlay global com atalho de teclado esta cortado — o mobile ja tem aba dedicada no dock)`, `extra-ceticos/telas: Search mobile sem 'Top result'`, `extra-ceticos/telas: busca nao e disparavel de fora da aba`, `extra-ceticos/biblioteca: nenhum corte de lista e sinalizado (120 faixas / 30 albuns em silencio)`, `extra-ceticos/biblioteca: albumKey sem guarda pra artista vazio e deriveArtists descartando faixa sem artist_name`

**Arquivos:**

- src/mobile/derive.ts — searchTracks passa a devolver { items, total } (uma passada, sem varrer duas vezes); nova topResult(); albumKey/deriveArtists ganham bucket explicito '(sem artista)' em vez de colapsar/descartar (derive.ts:55-57 e :86)
- src/mobile/derive.test.ts — total real vs limite, topResult por exato > prefixo > substring, bucket sem artista
- src/mobile/screens/Search.tsx — sinal debounced (150ms, mesmo numero do CommandPalette.tsx:249-252), botao de limpar no campo, botao de limpar recentes, secao 'Melhor resultado', rodape 'mostrando N de M' por bloco, bloco 'Acoes'
- src/mobile/screens/Home.tsx — botao de busca no header (ao lado de Fila/Ajustes, Home.tsx:36-45) navegando pra /search
- src/mobile/styles/app.css — .actionrow e .fieldclear

**Contratos novos:**

- `TS (BREAKING, callers em Search.tsx): export function searchTracks(tracks: Track[], query: string, limit?: number): { items: Track[]; total: number }`
- TS: export function topResult(q: string, ctx: { tracks: Track[]; albums: DerivedAlbum[]; artists: DerivedArtist[]; folders: Folder[] }): { kind: "track"|"album"|"artist"|"folder"; label: string; ref: string } | null
- `IDs estaveis das acoes (usados em teste e telemetria futura): "shuffle-all", "open-queue", "open-stations", "radio-track", "search-lyrics" (esta ultima so habilita na fase 4)`
- `Nenhuma chave nova de localStorage: kv-mobile-recent-searches (Search.tsx:31) ganha apenas a acao de limpar`

**Testes:**

- vitest: searchTracks devolve total > items.length quando estoura o limite; topResult prefere casamento exato de titulo a substring de album; faixa sem artist_name aparece no bucket '(sem artista)' em deriveArtists e nao some
- Smoke S24: digitar 'the' letra a letra e observar o cursor (nao pode engasgar); conferir 'mostrando 120 de N' com N > 120
- npm run typecheck (pega todos os callers da assinatura quebrada) + npm test

### I4 — Busca na letra (sidecars .lrc, local e offline) · ~5h

**Entrega:** Buscar por um verso e achar a faixa. Roda inteiramente no aparelho sobre os 1328 sidecars .lrc que ja estao la — sem embedder, sem rede, sem mudar o pipeline de export.

**Critério de pronto:** No S24: com o chip 'Letra' ativo, buscar 'chuva' devolve as faixas cujo .lrc contem a palavra, cada linha mostrando o verso; a primeira busca apos o boot responde em menos de 1s e, se o indice ainda nao ficou pronto, a tela diz 'indexando letras...' em vez de devolver vazio; Settings mostra 'letras indexadas: 1328 de 1746'.

**Depende de:** fase 3

**Gaps cobertos:** `busca-semantica-letra (a metade portavel: full-text local nos sidecars)`, `lib-sem-busca-semantica (parcial; a parte semantica de texto esta cortada por restricao dura)`

**Arquivos:**

- src-tauri/src/mobile_lyrics.rs — normalize_search(&str) -> String (NFD sem acento, minusculo, pontuacao colapsada), struct LyricsIndex com build(entries: Vec<(String, PathBuf)>) e search(&self, q: &str, limit: usize) -> Vec<LyricHit>; testes puros no host
- src-tauri/src/mobile.rs — struct LyricsState(Arc<RwLock<LyricsIndex>>) gerenciado no setup(); construcao em std::thread::spawn APOS o Library::load (nunca dentro do command); commands lib_search_lyrics e lib_lyrics_status; lib_rescan (:115-120) dispara reconstrucao
- src/mobile/types.ts — LyricHit e LyricsStatus
- src/mobile/ipc.ts — libSearchLyrics, libLyricsStatus
- src/mobile/screens/Search.tsx — chip 'Letra' no SCOPES (o que o handoff previa, screens.js S.search) com trecho do verso na linha e estado 'indexando letras...'
- src/mobile/screens/Settings.tsx — linha de cobertura de letra ao lado das contagens de entidades

**Contratos novos:**

- `Rust: #[derive(Clone, Serialize)] pub struct LyricHit { pub track_id: String, pub snippet: String, pub t: f64 }`
- `Rust: #[derive(Clone, Serialize)] pub struct LyricsStatus { pub ready: bool, pub indexed: usize, pub total: usize }`
- `Rust: #[tauri::command] fn lib_search_lyrics(state: State<LyricsState>, query: String, limit: Option<usize>) -> Vec<LyricHit> — nunca segura o lock durante o build (o build monta fora e faz swap)`
- `Rust: #[tauri::command] fn lib_lyrics_status(state: State<LyricsState>) -> LyricsStatus`
- `TS: libSearchLyrics(query: string, limit?: number): Promise<LyricHit[]>; libLyricsStatus(): Promise<LyricsStatus>`
- Nota de arquitetura: sao commands do APP (mobile.rs), nao do plugin Kotlin — a regra dura 'async fn com AppHandle' vale pro plugin; aqui o padrao existente e State sincrono e ele e mantido, trocando Mutex por RwLock pra leitura concorrente

**Testes:**

- cargo test (mobile_lyrics): normalize_search remove acento e pontuacao; search casa trecho no meio da linha; limite respeitado; uma faixa aparece uma vez (primeira ocorrencia) com o snippet certo; indice vazio devolve vec vazio sem panicar
- cargo test (mobile.rs, se couber sem State): status ready=false antes do build
- Smoke S24: buscar um verso conhecido com o chip Letra e cronometrar a PRIMEIRA busca depois do boot

### I5 — Station a partir do que esta tocando (seed local, criar e apagar) · ~7h

**Entrega:** Criar radio no aparelho: a partir da faixa tocando, do artista ou da pasta. A station criada fica salva no celular, aparece na tela Stations com selo 'local', e pode ser apagada — sem depender do desktop e sem ser sobrescrita pelo proximo export.

**Critério de pronto:** No S24: 'Nova station desta faixa' cria uma station que aparece em Stations com selo 'local'; toca-la monta 40 faixas com no maximo 2 do mesmo artista e nenhuma que esta nos negatives do taste.json; apagar exige segundo toque em ate 4s e some da lista; force-stop + reabrir mantem a station; um novo export do desktop (que reescreve stations.json) nao apaga a local; a tela de Artista tem 'Station' funcionando e continua sem 'Play'.

**Gaps cobertos:** `stations-criacao-delete-mobile (parte seed; mood cortado)`, `stations-create-delete (parte seed + delete; live card e mood sheet cortados)`, `artist-station`, `lib-artista-sem-play (so a parte Station; Play sequencial e decisao do CEO, recomendacao e nao fazer)`, `extra-ceticos/inteligencia: radio da faixa ignora os negatives do gosto (similar_tracks passa HashSet::new() em mobile_library.rs:312)`, `extra-ceticos/inteligencia: cap de 2 por artista ausente no ranking mobile`

**Arquivos:**

- src-tauri/src/mobile_intel.rs — pub fn centroid(ids, &VectorIndex) -> Option<Vec<f32>>; VectorIndex::similar_to_vec(&self, q: &[f32], k, exclude) -> Vec<(u64,f32)>; testes puros
- src-tauri/src/mobile_library.rs — seed_station_pool(&self, seed_ids, cap) (centroide + exclui taste.negatives + so resolvidas + cap por artista); similar_tracks (:309-317) passa a excluir negatives e aplicar o mesmo cap
- src-tauri/src/mobile_stations_local.rs (NOVO) — load/save atomico (tmp + rename) de stations-local.json no app data dir, add/remove
- src-tauri/src/lib.rs — registrar o modulo novo junto dos demais mobile_* (cfg_attr de dead_code como os vizinhos)
- src-tauri/src/mobile.rs — commands lib_seed_station, lib_create_station, lib_delete_station; stations_meta passa a concatenar exportadas + locais
- src/mobile/types.ts — StationMeta.source
- src/mobile/ipc.ts — libSeedStation, libCreateStation, libDeleteStation
- src/mobile/store.ts — createStationFrom(seedIds, name), deleteStation(id), reload de stations apos mutacao (loadIntel ja existe em :48-56)
- src/mobile/screens/Stations.tsx — selo de origem no card, lixeira SO nas locais, confirmacao armada guardando o ID e desarmando em 4s (mesmo padrao de src/views/Stations.tsx:181-196)
- src/mobile/screens/Artist.tsx — botao 'Station' ao lado do Shuffle (Artist.tsx:42-47)
- src/mobile/components/NowPlaying.tsx — acao 'Nova station desta faixa'
- src/mobile/screens/Folder.tsx — botao 'Station' na fileira de acoes

**Contratos novos:**

- `Rust: #[tauri::command] fn lib_seed_station(lib: State<Library>, seed_track_ids: Vec<String>, limit: Option<usize>) -> Vec<Track> — fila efemera, sem persistir`
- Rust: #[tauri::command] fn lib_create_station(lib: State<Library>, app: AppHandle, name: String, seed_track_ids: Vec<String>) -> Result<StationMeta, String> — computa o pool (cap 150) e grava; erro em string quando ha menos de 3 seeds COM vetor
- `Rust: #[tauri::command] fn lib_delete_station(app: AppHandle, id: String) -> Result<bool, String> — recusa id sem prefixo "local:" (as exportadas sao espelho read-only do desktop)`
- Arquivo <app_data_dir>/stations-local.json (mesmo diretorio raiz de device.json, NAO em Music/): {"schema":1,"stations":[{"id":"local:<uuid>","name":"...","kind":"seed","icon":"","tone":"","desc":"","seed_track_ids":["..."],"pool":["..."],"created_at":<unix>}]}
- `Rust/TS: StationMeta ganha source: "desktop" | "local"`
- `Playback: origin continua sendo "station" e o context_id da station local e o proprio id ("local:<uuid>") — NENHUM origin novo, NENHUM bump de SIGNAL_SCHEMA`

**Testes:**

- cargo test (mobile_intel): centroide de dois vetores opostos tem norma ~0 e nao explode; similar_to_vec respeita exclude e ordena por cosine
- cargo test (mobile_library): seed_station_pool nao devolve id que esta em taste.negatives; no maximo 2 faixas por artista; so devolve ids resolvidos
- cargo test (mobile_stations_local): round-trip em tempdir; arquivo corrompido cai pra lista vazia sem panicar; delete de id sem prefixo local: e recusado
- Smoke S24: criar station da faixa tocando, matar o app, reabrir e ver a station; rodar export_manifest.py --deploy de novo e confirmar que a local continua la

### I6 — Atalhos do sistema (App Shortcuts) · ~3h

**Entrega:** Long-press no icone do Rustify oferece 'Shuffle all', 'Stations' e 'Buscar' — o app abre ja no destino, sem passar pela Home.

**Critério de pronto:** No S24: long-press no icone mostra 3 atalhos; 'Shuffle all' abre o app ja tocando em ordem aleatoria; 'Stations' abre direto na tela de stations; um build limpo seguido de reinstalacao mantem os atalhos.

**Depende de:** fase 1 (rota /stations alcancavel e coerente)

**Gaps cobertos:** `deep-links (so App Shortcuts; o intent VIEW/BROWSABLE esta cortado)`

**Arquivos:**

- src-tauri/gen/android/app/src/main/res/xml/shortcuts.xml (NOVO) — 3 shortcuts estaticos com extra de rota
- src-tauri/gen/android/app/src/main/AndroidManifest.xml — meta-data android.app.shortcuts na MainActivity (o arquivo E versionado: git ls-files confirma)
- src-tauri/gen/android/app/src/main/java/dev/cmr/rustifyplayer/MainActivity.kt — onCreate/onNewIntent grava a rota pedida num arquivo do dataDir raiz (mesmo precedente do device.json)
- src-tauri/src/mobile.rs — command app_take_pending_route (le e APAGA)
- src/mobile/ipc.ts — appTakePendingRoute
- src/mobile/MobileApp.tsx — mountMobile consome a rota pendente antes do bootRoute; a acao 'shuffle' e disparada apos o libReady
- CLAUDE.md — nota curta sobre gen/android versionado e o risco de regeneracao apagar o meta-data

**Contratos novos:**

- `Intent extra: "dev.cmr.rustifyplayer.ROUTE" (String) com valores "shuffle" | "/stations" | "/search"`
- `Arquivo /data/data/dev.cmr.rustifyplayer/pending_route (dataDir RAIZ, nao files/ — igual ao device.json), UTF-8, apagado na leitura`
- `Rust: #[tauri::command] fn app_take_pending_route() -> Option<String>`
- `TS: appTakePendingRoute(): Promise<string | null>`

**Testes:**

- cargo test: take devolve o conteudo e remove o arquivo; arquivo ausente devolve None; conteudo fora do conjunto conhecido devolve None (nao navega pra rota arbitraria)
- Smoke S24: adb shell am start -n dev.cmr.rustifyplayer/.MainActivity --es dev.cmr.rustifyplayer.ROUTE /stations; depois long-press no icone e usar os 3 atalhos
- Verificacao de regeneracao: apos um cargo tauri android build limpo, git status em src-tauri/gen/android deve estar limpo e grep 'android.app.shortcuts' no AndroidManifest deve casar

**Cortado deste epic:**

- screen-crate — estrutural, nao de UI: slskd vive na cmr-auto e slskd-client e target-gated desktop-only; exigiria endpoint HTTP novo + decisao de auth no sync_receiver (epic J). XL que nao pertence a navegacao. Alem disso o 'Crate' do handoff (screens.js S.crate) e triagem LOCAL do acervo, nao busca Soulseek — citar o handoff como spec dessa tela e erro do finder.
- genres-facet / lib-generos-ausentes (a ABA Generos) — genre e o primeiro componente do path (scan.rs), exatamente a faceta Pastas que o mobile ja tem; a aba duplicaria a navegacao 1:1. Sobrevive so como FILTRO na lista de Faixas (fase 1).
- lib-sem-busca-semantica (a metade semantica de texto) — restricao dura: sem embedder no aparelho, texto->vetor nao roda offline. Fazer online via tailnet seria feature de trilho remoto, nao paridade offline.
- Busca por mood e criacao de mood station — bloqueadas em enrichments-vibe-nao-exportados (epic D). Entregar hoje seria um filtro que esconde faixas sem aviso, porque a cobertura de vibe e manual (CMR-178) e reabre a cada leva do Crate.
- playlists-screen (a TELA dedicada) — o valor real (mosaico 2x2 + pin) e entregue na fase 2 dentro da faceta Pastas; um quinto destino num shell de 4 abas e churn de navegacao, nao ganho.
- Stations live card + scatter viz — dependem de sessao de station rastreada (epic A/B); sem isso o card seria decorativo.
- deep-links intent VIEW/BROWSABLE — nao existe produtor de link rustify:// (o 'deep link' do desktop e navegacao interna por hash). Ficam so os App Shortcuts, que sao o valor de verdade no Android.
- lib-artista-sem-play (o botao Play sequencial) — exige origin novo e bump de SIGNAL_SCHEMA; decisao do CEO acima, recomendacao e nao fazer.
- 'Tocar a seguir' em album/artista/pasta — depende de mutacao incremental de fila no plugin Kotlin (epic A); prometer aqui seria planejar contra API que nao existe.
- Paleta de comandos como OVERLAY global com atalho de invocacao — no celular a aba Search ja e o destino; o que importa da paleta e a camada de ACOES, e essa entra na fase 3.

**Riscos:**

- Fase 1: manifest antigo (sem indexed_at) no aparelho — o seletor 'Recentes' some sem explicacao e parece bug. Sinal antecipado: apos instalar o APK, a opcao nao aparece; conferir com `adb shell run-as ... ` ou grep 'indexed_at' no manifest.json do S24. Mitigacao ja no plano: campo opcional + opcao escondida quando nenhuma faixa tem data.
- Fase 2: mosaico = 4 decodificacoes de imagem por card; a faceta Pastas com dezenas de pastas pode engasgar o scroll no WebView. Sinal antecipado: rolagem travada na faceta Pastas durante o smoke. Mitigacao de bolso: manter mosaico so no hero da pasta e nos cards fixados, card comum volta a 1 capa.
- Fase 4: se o indice de letra for construido dentro do command (ou segurando o lock), a primeira busca congela o campo de texto. Sinal antecipado: >500ms entre tecla e resultado na primeira busca pos-boot. Mitigacao contratual: build em thread propria no setup, swap sob RwLock, command devolve ready=false enquanto isso.
- Fase 5: cobertura MERT parcial — artista cujas faixas nao tem vetor gera centroide pobre e station vazia/decepcionante (o risco que o cetico levantou sobre semear por uma faixa so). Sinal antecipado: pool < 10 no momento da criacao. Mitigacao: recusar criacao com menos de 3 seeds COM vetor e explicar no toast, em vez de criar station morta.
- Fase 5: escrita concorrente em stations-local.json entre o command e um rescan/worker — arquivo truncado e stations locais somem no boot. Sinal antecipado: station criada nao aparece apos reabrir. Mitigacao: escrita atomica (tmp + rename) e estado sob lock, mesmo padrao do resto do modulo.
- Fase 6: cargo tauri android build regenerar gen/android e apagar shortcuts.xml / o meta-data do AndroidManifest. Sinal antecipado: git status sujo em src-tauri/gen/android apos um build limpo, ou o atalho sumindo do long-press. Mitigacao: os arquivos sao versionados (git ls-files confirma) e o smoke inclui grep pos-build.
- Transversal (o mais provavel de todos): esquecer o `bun run build` MANUAL antes do `cargo tauri android build --debug` e concluir que a fase nao funcionou. Sinal antecipado: APK novo instalado e a UI identica a anterior. Nao ha beforeBuildCommand no tauri.conf.json — o frontend e embutido no .so pelo generate_context.
- Transversal: fase 3 muda a assinatura de searchTracks (retorno vira objeto). Sinal antecipado: npm run typecheck vermelho — e por isso que o gate roda antes do commit; o risco real e commitar sem rodar o gate.

**Decisões do CEO neste epic:**

- **Botao 'Play' (discografia em sequencia) na tela de Artista — vale inventar o origin artist_seq?**  
  Recomendação: **Manter so Shuffle + Station** — O bump de schema arrasta qdrant_client.rs, o export, a regua e a doc de proveniencia por um botao que a Station cobre melhor (300 faixas em sequencia e pior UX que radio do artista); reusar 'playlist' seria mentir pro motor, que ja usa esse nome pra pasta.
- **Onde vivem as stations criadas no celular enquanto nao existe sync bidirecional?**  
  Recomendação: **Arquivo proprio no app data dir** — Destrava hoje o gesto mais natural do celular sem risco de ser sobrescrito pelo export; gravar em Music/.rustify/ misturaria estado do app com um espelho que o rail de sync gerencia, e esperar o epic C adia a feature por um canal que nem foi decidido.
- **Como rotular o filtro da lista de Faixas — 'Genero' (nome do campo) ou 'Pasta' (o que o dado e)?**  
  Recomendação: **Rotular 'Pasta'** — genre no acervo e o primeiro componente do path (scan.rs), identico a faceta Pastas — chamar de genero em cima de tags reconhecidamente sujas venderia uma precisao que o dado nao tem, e expor dois eixos identicos duplicaria a navegacao.
- **Quem entrega a mudanca de 3 linhas no export_manifest.py que faz 'Recentes' existir — este epic ou o epic D (pipeline)?**  
  Recomendação: **Este epic entrega o codigo; epic D opera** — Sem o campo, a fase 1 entrega um seletor sem dado; e derivar mtime no aparelho seria a data do SYNC, nao da aquisicao — mediria a coisa errada.
- **Busca na letra: comecar so com os sidecars .lrc do aparelho (1328/1746) ou esperar o export de lyrics_text?**  
  Recomendação: **Sidecars agora** — 76% de cobertura sem tocar o pipeline e sem novo artefato; quando o lyrics_text vier pelo epic D, a cobertura sobe sozinha sem mudar UI nem contrato do command.
- **Crate (busca/download Soulseek) no celular — entra neste epic?**  
  Recomendação: **Cortar** — Nao e falta de tela: slskd-client e desktop-only por Cargo e o slskd vive na cmr-auto — exigiria endpoint HTTP novo e, antes disso, decidir autenticacao no receptor de sync (epic J); e XL fora do tema de navegacao.
---

# Anexo: crítica adversarial (o que foi corrigido)


## Veredito

Os quatro planos batem com o codigo real na maior parte das ancoras que checei (AudioPlugin.kt:148 startPosition fixo, QueueMeta escalar, JournalEvent sem seq, Manifest sem cabecalho, disc_number com allow(dead_code), TasteEntry.weight descartado, rank_pool/similar_tracks com HashSet::new(), cover_path por album em pipeline.rs:631-639, dominant_color migrado pra track_enrichments, MoodFilters exportado em lib.rs:33, insert_synced_event sem record_play, relTime em ingles). Nao encontrei API inventada nem violacao das regras duras do CLAUDE.md: ninguem propoe compilar na cmr-auto, portar crate desktop-only, animar custom property no :root (o Epic D fase 3 usa --bg-ink-morph, que spectrum.ts:179 ja le, e o canvas faz o lerp), CDN de fonte ou bind 0.0.0.0; SIGNAL_SCHEMA fica em 3 nos quatro (correto, o vocabulario de origins nao muda). O que nao sobrevive: (1) uma falha comum a A e B — todo command novo resolve dentro do withController, e o caminho de falha de conexao descarta o Invoke sem resolve nem reject (AudioPlugin.kt:263-267, 283-289), o que pendura a promise do JS e, no Epic B, a thread do tender; (2) o Epic B assume que appendar apos STATE_ENDED retoma o playback, sem nenhum passo de retomada no contrato, e so testa 'tela apagada' (Activity viva), nao 'app fora dos recentes', que e onde o plugin solta o controller; (3) o Epic C fase 3 nao tem de onde tirar o after_seq do drain de likes, porque a compactacao do LikeStore, ao contrario do EventJournal, preserva o ackado; (4) o Epic E cria uma contradicao com a propria decisao do CEO ao somar last_played na tela de historico. Estimativas: A fase 1 (3h), C fase 2 (6h) e D fase 7 (8h) estao claramente abaixo do custo real de um command novo end-to-end mais ciclo de APK; o resto e defensavel. Criterios de pronto sao majoritariamente observaveis no aparelho — as excecoes sao B fase 5 e a verificacao de 24h via regua. Por fim, ha quatro decisoes que os epics tomam em direcoes opostas e precisam ir ao CEO juntas, nao separadas: auth na porta 19878 (C diz nada, D diz Bearer obrigatorio ja), o shape de get_queue (A x B), a assinatura de rank_pool (B x C) e o bump do manifest para schema 2 (D x E). Ordem de execucao que respeita as dependencias reais: A fase 1 (com a correcao do withController) antes de tudo no plugin, D fase 6 antes de qualquer coisa que carregue biblioteca em background, e C fase 2 so depois de definido quem e dono do MediaSession.Builder.


## Veredito

A precisão das âncoras é alta nos quatro planos — conferi dezenas de file:line (query.rs:303-406, spectrum.ts:176-188, tweaks.ts:515, inkDerive.ts:33/51, color.ts:111, pipeline.rs:688-701, export_manifest.py:51-55/489-496, AudioPlugin.kt, EventJournal.kt, mobile_sync.rs:104/155) e praticamente todas batem. Os planos NÃO foram escritos de memória. O que não sobrevive ao código é de três tipos.

(1) Um BLOQUEADOR real: Epic I fase 5 cria stations locais que aparecem na lista e devolvem fila vazia, porque `station_batch` só enxerga `MobileLibrary.stations`, populado exclusivamente por `.rustify/stations.json`.

(2) Cinco colisões entre epics que ninguém nomeou por inteiro e que se destroem em merge: três commands de diagnóstico concorrentes (F `lib_status` / J `lib_state` / H `lib_manifest_info`); duas sheets (F fase 4 primitivo vs H fase 1 TrackInfoSheet, ambas restaurando `.sheet`/`.kv` e ambas mexendo no `.nphead`); duas reescritas incompatíveis de `searchTracks` (F fase 5 `{hits,total}` vs I fase 3 `{items,total}`, mais debounce/X/Top-result duplicados em Search.tsx); duas restaurações de scroll (F fase 6 vs I fase 1, com I se contradizendo entre `dependencias_externas` e o critério de pronto); e duas correções das barras do sistema (F fase 3 via themes.xml — que é no-op — vs G fase 2 via MainActivity, que é a certa).

(3) Quatro erros de física/CSS que só aparecem no aparelho: `filter: brightness` em G fase 4 escurecendo o texto da letra (o desktop usa isso dentro de `backdrop-filter`); a paleta clara de G fase 5 deixando `.mini` e os 16 `--tone-*` pretos; o `document.hidden` no gate de re-agendamento do rAF em G fase 1 congelando o fundo para sempre; e a aritmética de alvos táteis de F (fase 3 ignora que dois dos seis alvos são pílulas de texto e que o eyebrow divide a linha; fase 7 estoura `.ctrls` em 24dp).

Estimativas: só uma é claramente fantasia — H fase 2 em 6h (dois arquivos Kotlin novos com limiter, sete pontos de registro no crate, primeiro teste Gradle do módulo, gate de medição ffmpeg e ciclo de APK): 10-14h. Em contrapartida J fase 1 está superestimada, porque o log Rust JÁ roteia pro logcat (tauri-plugin-log 2.8.0 lib.rs:588-589 + DEFAULT_LOG_TARGETS, e mobile.rs nunca chama `.targets()`) — o CLAUDE.md é que está stale.

Critérios de pronto: majoritariamente observáveis e bem escritos (o de G fase 1 com `dumpsys gfxinfo` e o de J fase 5 com curl 401 são exemplares). As exceções são G fase 2 (promete NowPlaying escalando quando o contrato só aplica zoom a `.view`), I fase 6 (só funciona em boot frio) e I fase 5 (impossível pelo BLOQUEADOR acima).

Nenhum plano viola restrição dura do CLAUDE.md: ninguém compila na cmr-auto, ninguém porta crate desktop-only, ninguém anima custom property no `:root`, ninguém reabre bind 0.0.0.0, ninguém mexe em SIGNAL_SCHEMA sem justificar, todos lembram do `bun run build` manual, e todos os commands novos do plugin Kotlin respeitam `async fn` + `AppHandle<R>` (F, G fase 5, H, J) enquanto os commands do app em mobile.rs mantêm corretamente o padrão síncrono com `State` (I fase 4, G fase 6) — a distinção entre os dois trilhos está explícita nos planos de G e I, o que é acerto raro.


## BLOQUEADOR


### I · 5 — Station a partir do que está tocando

**Problema:** A station local aparece na lista mas NÃO toca. `lib_play_station`/`lib_station_next` (src-tauri/src/mobile.rs:63-82) chamam `MobileLibrary::station_batch`, que resolve a station em `self.stations` (src-tauri/src/mobile_library.rs:333 `self.stations.iter().find(|s| s.meta.id == station_id)`), e esse vetor é populado EXCLUSIVAMENTE por `load_intel` a partir de `.rustify/stations.json` (mobile_library.rs:185-194). O plano só promete que `stations_meta` (mobile_library.rs:319-321) concatena exportadas + locais. Resultado: criar a station funciona, o card aparece com selo 'local', e tocar devolve vec vazio → toast 'Station sem faixas no acervo' (src/mobile/store.ts:224). O critério de pronto ('toca-la monta 40 faixas com no máximo 2 do mesmo artista') não é alcançável como escrito.

**Correção:** As stations locais têm de entrar em `MobileLibrary.stations` (não só em `stations_meta`): carregar `stations-local.json` dentro de `MobileLibrary::load()` junto de `load_intel` (mobile_library.rs:276) e re-injetar após `lib_create_station`/`lib_delete_station` — lembrando que `lib_rescan` (mobile.rs:115-120) SUBSTITUI a MobileLibrary inteira, então a carga do arquivo local precisa estar dentro do `load()`, não num passo lateral. Alternativa: `station_batch` receber um segundo pool consultável.


## GRAVE


### A · 1 (e herdado por 2, 3, 4, 5)

**Problema:** Todo command novo resolve DENTRO do withController. Quando o MediaController ainda nao esta conectado, withController so ENFILEIRA a closure (AudioPlugin.kt:273-281) e, se a conexao falhar, o catch faz `controllerFuture = null; pending.clear()` (AudioPlugin.kt:263-267) — a closure e descartada e o `invoke` NUNCA e resolvido nem rejeitado. `releaseController()` (AudioPlugin.kt:283-289), chamado no onDestroy da Activity, faz o mesmo. Um invoke perdido = future de `run_mobile_plugin_async` que nunca completa: a promise do JS nunca liquida e, no caminho Rust (mobile_sync.rs:120 usa block_on), a thread pendura pra sempre. O `getState` atual foge disso de proposito, lendo o controller possivelmente nulo (AudioPlugin.kt:205-207).

**Correção:** Mudar `pending` de `ArrayDeque<(MediaController) -> Unit>` (AudioPlugin.kt:87) para guardar tambem o Invoke, e no catch de AudioPlugin.kt:263-267 e em releaseController() chamar `invoke.reject("controller indisponivel", ...)` (Invoke.kt tem reject). Alternativa para os READ-only (get_queue): copiar o padrao do getState (AudioPlugin.kt:205-207) e devolver snapshot vazio com index -1 quando `controller == null`. Isso precisa entrar no contrato de TODOS os commands das fases 1-5, nao so no get_queue.


### A · 2

**Problema:** `insertAtFor(snapshot, mode)` calcula o indice de insercao no JS e manda `insertAt` pro Kotlin — exatamente o que a propria secao de riscos diz ter sido projetado fora ('TODO mutador devolve QueueSnapshot e o store aplica so o que voltou — o JS nunca calcula indice'). Entre ler o snapshot e o addItems chegar ao service, o auto-advance pode ter virado a faixa (a fila e nativa, avanca sem JS), e o 'Tocar em seguida' cai atras da faixa errada.

**Correção:** O wire deve levar `mode: "next"|"end"` em vez de `insertAt`, e o Kotlin resolve contra `c.currentMediaItemIndex` DENTRO do withController — mesmo padrao de coercao server-side que o skipToIndex ja usa (AudioPlugin.kt:197-202). `insertAtFor` some de src/mobile/queueModel.ts.


### A · 4

**Problema:** O plano promete um vitest de `shuffleTailOrder(items, index, seed)` que produz 'a mesma permutacao que o Kotlin usa'. Sao dois RNGs independentes (Kotlin no shuffleTail, TS na funcao pura) sem nenhuma implementacao compartilhada — o teste nao pode sustentar essa igualdade, e a funcao TS nao tem consumidor (a ordem nova volta no QueueSnapshot que o store aplica).

**Correção:** Cortar `shuffleTailOrder` de src/mobile/queueModel.ts e o teste correspondente; testar determinismo por seed no lado Kotlin (ou aceitar nao-determinismo e testar so a invariante 'mesmo conjunto, prefixo intocado'). Se quiser paridade real, o precedente do repo e replicar a matematica com teste de vetor fixo, como weighted_pick_prefix em mobile_intel.rs:248-285 fez com o desktop.


### A · 1

**Problema:** Estimativa de 3h e fantasia. A fase inclui: command Kotlin novo + o ritual de 7 arquivos do plugin (models.rs, mobile.rs, desktop.rs, commands.rs, lib.rs generate_handler, build.rs COMMANDS, permissions/default.toml) + modulo novo queueModel.ts com testes + a REMOCAO do espelho de fila do store (store.ts:19, 104-130, 194, 371, alem de current() em :75-87 e queueOrigin) + duas telas + `bun run build` + `cargo tauri android build` + install + smoke CDP no S24. A propria fase 3, com 3 commands e quase nenhuma UI, tambem esta cotada em 3h — as duas nao podem custar o mesmo.

**Correção:** Recotar a fase 1 em 5-7h (ou fatiar: 1a = get_queue + snapshot na tela, 1b = morte do espelho em store.ts:104-130). O ciclo build+install+smoke sozinho ja consome ~30-40min por iteracao e a fase 1 vai ter mais de uma.


### B · 2

**Problema:** O gatilho `needs_topup(status == "ended")` assume que anexar itens com o player em STATE_ENDED faz a musica voltar sozinha. O contrato de `appendQueue` resolve `null` e nao tem nenhum passo de retomada; o AudioService, ao entrar em STATE_ENDED, ja flushou o evento e zerou curTrackId (AudioService.kt:166-172). Em ExoPlayer, adicionar itens depois do fim da fila mantem a posicao no fim do ultimo item — sem `seekTo(novoIndice, 0)` + `play()`/`prepare()` o append e silencioso e a fase falha justamente no caso que ela existe para resolver.

**Correção:** Ou o appendQueue passa a receber `resumeIfEnded: Boolean` e, quando `c.playbackState == Player.STATE_ENDED`, faz `c.seekTo(indiceDoPrimeiroNovo, 0L); c.play()` dentro do withController (AudioPlugin.kt:140-152 e o molde), ou o tender nunca deixa chegar em ENDED (lookahead >= 2 como unico caminho) e o ramo ENDED vira erro logado. Spike de 20 min no S24 antes de escrever o tender: appendar com a fila terminada e ver se sai som.


### B · 2

**Problema:** O tender fala com o player por commands do plugin, e o plugin e escopado na Activity: `AudioPlugin.onDestroy` (AudioPlugin.kt:94-104) chama `releaseController()` (AudioPlugin.kt:283-289), que solta o MediaController e limpa a fila `pending`. Tirar o app dos recentes com o servico tocando (caso comum de uso no bolso) destroi a Activity mas mantem o processo e o foreground service — dai em diante todo withController tenta re-bindar usando o Context da Activity morta. O smoke da fase so cobre 'tela apagada', que mantem a Activity viva (stopped), entao o modo que quebra nao e testado.

**Correção:** Incluir no smoke da fase 2 o caso 'swipe do app nos recentes com o servico tocando' e, se o bridge cair, mover o gatilho pro Kotlin (o AudioService ja recebe onEvents e sabe hasNextMediaItem — AudioService.kt:149-184), que e o plano B ja escrito nos riscos. Hoje o plano trata isso so como risco de Doze, que e outro problema.


### B · 2

**Problema:** A mitigacao 'timeout por ciclo, pular o ciclo em vez de insistir' nao e implementavel como escrita: `run_mobile_plugin_async` nao tem timeout e, no caminho de falha de conexao do controller, o invoke e descartado sem resolve nem reject (AudioPlugin.kt:263-267) — o `block_on` do tender fica pendurado indefinidamente, e nao ha ciclo seguinte para 'pular'.

**Correção:** Ou envolver cada chamada em `tauri::async_runtime::block_on(async { tokio::time::timeout(dur, fut).await })` (o runtime do Tauri e tokio, o timeout precisa ser explicito), ou corrigir o Kotlin para rejeitar os invokes pendentes na falha (mesma correcao do achado do Epic A fase 1). O plano precisa escolher uma das duas no contrato, nao deixar como 'mitigacao'.


### B · 2

**Problema:** Remover 'shuffle' do type Origin (types.ts:34) quebra dois gates do projeto e tres telas que a lista de arquivos nao cita: derive.test.ts:126 (`expect(originLabel("shuffle")).toBe("shuffle")`) e :134 (`originSrc("shuffle")`) fazem `npm test` falhar; e `shuffleList` (store.ts:215) e chamado sem contexto nenhum em Album.tsx:55, Artist.tsx:43 e Folder.tsx:45 — a decisao 'shuffle de uma lista mantem o origin da lista' exige mudar a assinatura de shuffleList e os tres call sites.

**Correção:** Acrescentar a lista de arquivos: src/mobile/derive.test.ts (linhas 126 e 134), src/mobile/screens/Album.tsx:55, Artist.tsx:43, Folder.tsx:45, e mudar `shuffleList(list, origin, contextId)` em store.ts:215. Sem isso a fase nao passa no `npm test` que o proprio plano lista como gate.


### C · 3

**Problema:** O ciclo de likes (`drain_likes(after_seq)` -> POST -> `ack_likes(upto_seq)`) nao tem de onde tirar o `after_seq`. A compactacao do LikeStore, por design declarado, MANTEM a ultima linha de cada track_id mesmo ja ackada — o oposto do EventJournal, cujo `ack` apaga o consumido (EventJournal.kt:148-192) e por isso permite que o worker chame `drain_events(0)` (mobile_sync.rs:120). Copiando o padrao existente, o implementador passa 0 e o aparelho re-POSTa a tabela inteira de likes a cada 60s para sempre.

**Correção:** Acrescentar ao contrato do plugin um `likesAckedSeq()` (espelhando `EventJournal.ackedSeq`, EventJournal.kt:156) ou fazer `drainLikes` sem argumento usar a marca d'agua do prefs, e o worker (mobile_sync.rs:113-158) passar a le-la. Registrar explicitamente que aqui NAO vale o `drain(0)` do sync de eventos.


### C · 6

**Problema:** A fase adiciona `setCallback` a `MediaSession.Builder` (AudioService.kt:94-98) com um `onConnect` que devolve `ConnectionResult.accept(sessionCommands, playerCommands)`. Essa mesma sessao serve o MediaController do proprio app (AudioPlugin.kt:250-253) — montar o ConnectionResult do zero, sem partir dos defaults, derruba os player commands e quebra setMediaItems/play/pause de todo o app, nao so a notificacao.

**Correção:** Especificar `ConnectionResult.AcceptedResultBuilder(session)` (que parte dos comandos default) e apenas ADICIONAR o SessionCommand "dev.cmr.rustify.LIKE" ao conjunto — nunca `accept()` com listas montadas a mao. E fazer disso o primeiro item do spike de uma hora que a fase ja preve.


### C · 2

**Problema:** 6h e subdimensionado e o gate escolhido nao pega o erro tipico. A fase entrega LikeStore.kt (clone do EventJournal com regra de compactacao diferente), 5 @Command Kotlin, 5 metodos no RustifyAudio, 5 stubs em desktop.rs, 5 commands, 5 entradas de permissao (autogenerated + default.toml), 3 commands do app, icones, store com otimista+rollback, 2 superficies de UI, README e doc. Alem disso, `cargo check --target aarch64-linux-android` esta listado como 'o gate real do plugin' — ele NAO compila Kotlin: erro em LikeStore.kt/AudioPlugin.kt so aparece no `cargo tauri android build`.

**Correção:** Recotar em 9-12h e trocar o gate por `bun run build && cd src-tauri && cargo tauri android build --debug` (o unico caminho que roda o Gradle/Kotlin), mantendo o cargo check como pre-verificacao barata do lado Rust.


### C · 3, 4

**Problema:** A decisao do CEO recomendada aqui ('nada de auth agora na 19878') contradiz diretamente o Epic D fase 7, que torna Bearer OBRIGATORIO em todas as rotas do mesmo receptor (sync_receiver.rs:102-151), inclusive no POST /sync/events existente. Se o D entrar primeiro, POST /sync/likes e GET /sync/taste nascem 401 e as fases 3, 4 e 5 daqui param sem sintoma claro no aparelho.

**Correção:** As duas decisoes precisam virar UMA, levada ao CEO junto. Se a resposta for Bearer, o contrato aqui ja nasce com `Authorization: Bearer` nas duas rotas novas e o painel Sinal (fase 5) mostra 401 como erro literal; se for 'nada agora', o Epic D fase 7 perde a metade de auth.


### D · 7 e 8

**Problema:** A fase 7 torna o Bearer obrigatorio em TODAS as rotas do receptor, inclusive no POST /sync/events que o APK em producao hoje faz sem header (mobile_sync.rs:140-145), mas o suporte a token no aparelho so chega na fase 8. Entre uma e outra o sync do S24 fica 401 e o criterio de pronto da fase 7 so testa curl da VM — nada no aparelho denuncia. Some-se a contradicao com a decisao do Epic C ('nada de auth agora').

**Correção:** Mover a virada do Bearer para dentro da fase 8 (que ja edita mobile_sync.rs:78 endpoint()/token e entrega o painel Sync), deixando a fase 7 servir /sync/artifacts com auth e o /sync/events em compatibilidade. E resolver a decisao de auth uma unica vez com o Epic C.


### D · 7

**Problema:** 8h e subdimensionado para: versionar tres scripts que hoje so existem no home da cmr-auto (encode com ffmpeg/mutagen, push com retry, orquestrador), --delta com manifest.prev, Bearer em todas as rotas do sync_receiver, DUAS rotas HTTP novas com whitelist e defesa de path traversal no parser HTTP artesanal (sync_receiver.rs:76-152), timer systemd na VM, allowBackup=false, mais os testes de cada um.

**Correção:** Recotar em 12-14h ou fatiar: 7a = versionar scripts + --delta (sem tocar no receptor), 7b = auth + /sync/artifacts. A fatia 7a nao depende das fases 2 e 3 e poderia entrar bem antes.


### E · 2 (agravado pela 3)

**Problema:** A decisao do CEO fixa 'a tela History mostra so o que foi tocado NESTE aparelho', mas a fase 3 faz `lib_list_history` devolver os valores somados, com `last_played = max(exportado, local)`. A tela ordena e rotula por `last_played` (fmtAgo) e a fase 2 filtra por periodo com o mesmo campo: uma faixa tocada no desktop ha 5 minutos e no celular na semana passada aparece como 'ha 5 min' e entra no chip 'Hoje'. O historico passa a mentir exatamente o que a decisao mandou evitar.

**Correção:** Separar os campos: manter `Track.last_played` como o LOCAL (vindo de HistoryStat) e expor o do desktop noutro campo (ex.: `last_played_desktop`), somando apenas `play_count`. `merge_local_stats` (fase 3) nao pode escrever max() no campo que a tela History consome.


### E · 1

**Problema:** `HistoryStore` (`{ path, state_path }`, metodos `&self`) nao tem lock, mas e escrito por DUAS threads: a do worker de sync (mobile_sync.rs:113 sync_once, thread 'mobile-sync') e a do command async `lib_list_history`, que tambem ingere. O watermark (`history_state.json`) e read-modify-write e a compactacao reescreve o arquivo em tmp+rename enquanto a outra thread pode estar appendando — o EventJournal, que resolveu o mesmo problema, serializa tudo em `synchronized(lock)` (EventJournal.kt:29, 80, 119, 149).

**Correção:** Dar interior mutability ao HistoryStore (`Mutex<()>` de arquivo, ou guardar o proprio store atras de `Mutex` no State) e serializar append/compact/watermark. O dedupe por uuid no `fold_history` mascara o sintoma de linha duplicada, mas nao protege a compactacao concorrente.


### F · 7 — Player fino (±15s)

**Problema:** Os dois botões ±15s não cabem na fileira `.ctrls`. Os números reais: src/mobile/styles/app.css:486-491 tem `gap: 26px`; :493-495 `.np .ctrls .iconbtn` já é 44×44 (não 30px, como a fase 3 supõe); :502-504 `.np .fab` é 60×60; e `.np .inner` (app.css:355) tem 22px de padding lateral → 316dp úteis em 360dp. Com cinco alvos: 44×4 + 60 + 26×4 = 340dp > 316dp. Flex vai encolher os iconbtn abaixo dos 44px que a fase 3 acabou de garantir, ou estourar a linha.

**Correção:** Reduzir `gap` de 26px para ≤14px em app.css:490 DENTRO da fase 7 (44×4 + 60 + 14×4 = 292dp cabe), e corrigir a afirmação da fase 3 de que `.ctrls` tem alvos pequenos — o menor alvo do app é mesmo `.iconbtn.sm` (app.css:841-844, 30px) em Stations.tsx:68-76.


### F · 3 — Tato (alvos de 44px)

**Problema:** A aritmética que sustenta a mitigação do risco declarado ('6×44 + 5×8 = 304dp em 360dp') é fantasia em dois pontos. (a) Dois dos seis alvos do cabeçalho são `.shapebtn` — pílulas de TEXTO com largura variável pelo nome do shape/renderer (app.css:749-758: mono 10px + padding 5px 10px + borda), não quadrados de 44px; 'contour'/'columns' passam fácil de 60px cada. (b) A fileira não tem 360dp: `.np .nphead` é `justify-content: space-between` (app.css:364-370) e divide a linha com o eyebrow 'Now playing' (NowPlaying.tsx:131), dentro de `.np .inner` com 22px de padding (app.css:355) → sobram ~235dp para os seis alvos. A linha já está apertada HOJE; expandir área com ::after de inset -4 e subir o gap para 8px sobrepõe alvos vizinhos.

**Correção:** Medir antes de prometer: ou o cabeçalho perde elementos (a fase 4 já move o rádio pra sheet — mover shape/renderer para a sheet também), ou os `.shapebtn` viram ícone de 44px. Documentar a conta com as larguras reais dos dois pills, não com 44px cada.


### F · 4 — Sheet primitivo + long-press

**Problema:** A sentinela de history reabre a sheet no voltar, quebrando o próprio critério de pronto ('voltar devolvendo à tela de origem, não ao NP'). `openSheet` empilha `history.pushState({rustifySheet:true})`; quando o usuário toca 'Ir para o artista', `nav.navigate` seta `window.location.hash` (src/mobile/nav.ts:49-53), o que EMPILHA outra entrada POR CIMA da sentinela. O `history.back()` de `nav.back()` (nav.ts:59-61) volta então para a entrada da sentinela — cujo `event.state.rustifySheet` continua presente — e o handler de popstate proposto reabre a sheet em vez de devolver à tela de origem. A sentinela também sobrevive a `navigateFromNp` via `location.replace`, que substitui a entrada do /np mas não a da sheet.

**Correção:** Consumir a sentinela antes de navegar: `closeSheet()` deve chamar `history.back()` e só disparar a navegação depois do popstate correspondente (ou usar um contador de profundidade em vez de um flag booleano). Testar exatamente o caminho sheet → 'Ir para o artista' → voltar no vitest de sheet.test.ts, que hoje só cobre openSheet/popstate/hashchange isolados.


### G · 4 — Card de letra (vidro)

**Problema:** `filter: brightness(var(--lyrics-bg-brightness))` em `.np .lyrics` escurece o TEXTO da letra, não o fundo — é o oposto de um knob de legibilidade. No desktop essa var vive só dentro de `backdrop-filter` (src/styles/extractor-lab.css:765-771: `backdrop-filter: blur(...) saturate(160%) brightness(var(--lyrics-bg-brightness, 0.820))`), que afeta o que está ATRÁS do elemento. O plano proíbe backdrop-filter no mobile ('o card do mobile nasce solido') e mesmo assim mantém os mesmos números (0.92 − g×0.40 → 0.52 no extremo), o que com `filter` reduz o brilho da letra pela metade.

**Correção:** Ou dropar a metade brightness do knob (sobra só `--lyrics-bg-alpha` em `background: rgba(...)`, que é suficiente e barato), ou aplicar o brilho numa camada separada — um `::before` posicionado com o fundo, deixando o texto fora do `filter`. Em qualquer caso, corrigir o contrato que promete 'MESMOS numeros do desktop, pra que o mesmo valor de knob produza o mesmo look': com `filter` no elemento o look NÃO é o mesmo.


### G · 5 — Light/Dark/Auto

**Problema:** A lista de arquivos não cobre o que o próprio critério de pronto promete. (a) `src/mobile/styles/tokens.css:324-332` tem `.mini { background: rgba(22, 22, 22, 0.92) }` — literal escuro numa REGRA, não em `:root`; o plano só redefine tokens dentro de `:root[data-theme="light"]`, então o mini-player continua preto no tema claro, contrariando 'o mini-player continua distinguivel do fundo'. (b) 'os mesmos 30 tokens' subconta: o `:root` de tokens.css:15-82 tem ~64 custom properties, das quais 16 são `--tone-*` (tokens.css:61-76), todas quase-pretas e usadas como fundo de TODO placeholder de capa (Cover.tsx:32-35) — em light mode as capas ausentes viram quadrados pretos.

**Correção:** Incluir em fase 5: tokenizar `.mini` (tokens.css:330) como `rgba(var(--mini-bg-rgb), .92)`; e enumerar a paleta clara sobre as ~41 props de COR reais (21 de superfície/texto/sinal + 16 tones + --bg-ink-rgb + --sh-card/--sh-hover), não sobre 30. O tokens.test.ts proposto deve varrer também os pares tone/tone-b.


### G · 1 — Store único + off-switch do rAF

**Problema:** Passar `document.hidden` para `shouldAnimate()` e usá-lo na decisão de RE-AGENDAR congela o fundo para sempre depois do primeiro background. Hoje `frame()` agenda o próximo rAF na PRIMEIRA linha (src/mobile/bg/spectrum.ts:159) e só depois faz early-return em `document.hidden` (:160) — exatamente para o loop sobreviver ao WebView suspenso. Se o cancelamento passar a ser real, nada re-arma o loop na volta: não há listener de visibilitychange no spectrum, e o rAF cancelado não ressuscita sozinho. Sintoma no S24: sair do app e voltar deixa o fundo estático até matar o processo.

**Correção:** Tirar `hidden` do gate de re-agendamento (o rAF já é estrangulado pelo browser quando oculto — o early-return atual basta), deixando `shouldAnimate` só com `enabled` e `reduceMotion`; ou, se mantiver `hidden`, adicionar um `document.addEventListener('visibilitychange')` dentro de `mountSpectrum` que re-arma o rAF, e cobrir isso no teste da matriz.


### H · 1 — Manifest v2 + info técnica

**Problema:** Os 4 campos técnicos novos vão ser zerados 2× por segundo. `snapshotToJs` (AudioPlugin.kt:313-324) emite SEMPRE todas as chaves (é o padrão deliberado do arquivo: `JSONObject.NULL` em vez de omitir, comentário nas linhas 317-319), e o plano manda emitir `JSONObject.NULL` no codec e `-1` no bitrate. O merge de `applyState` (src/mobile/store.ts:137-149) é 'por chave PRESENTE' — e a chave estará presente. Como o tick de `position` (AudioService.kt:240-259, 500ms) usa o mesmo `snapshotOf`, cada tick sobrescreve codec/sampleRate/channels/bitrate bons por null/-1 assim que o MediaController não tiver `COMMAND_GET_TRACKS` naquele instante. O sheet pisca ou fica vazio.

**Correção:** Duas saídas: (a) só emitir os 4 campos nos eventos `track_changed` e no `get_state`, mantendo o tick de `position` enxuto; ou (b) fazer o merge de store.ts ignorar `null`/`-1` especificamente para esses 4 campos, com teste. Escolher uma e escrevê-la no contrato — hoje o plano afirma que 'merge por chave presente' resolve, e não resolve.


### H · 2 — Normalização de loudness

**Problema:** 6h é fantasia para o escopo listado. A fase cria dois arquivos Kotlin do zero (DspKernel com ganho, rampa exponencial e limiter com lookahead de 5ms; RustifyDsp como BaseAudioProcessor), edita AudioService/QueueMeta/AudioPlugin, atravessa SETE pontos de registro no crate Rust (models/commands/mobile/desktop/lib/build.rs/permissions/default.toml + README), cria o primeiro teste unitário Gradle do módulo, cria src/mobile/dsp.ts + testes, mexe em Settings, porta `.tog`/`.range`, faz push no boot com retry, roda um gate de medição ffmpeg em 20 arquivos na cmr-auto e ainda faz smoke no aparelho — com o ciclo `bun run build` + `cargo tauri android build` + adb no meio. Some-se que `./gradlew :tauri-plugin-rustify-audio:testDebugUnitTest` só roda depois de um build tauri completo, porque `src-tauri/gen/android/tauri.settings.gradle` e `app/tauri.build.gradle.kts` são GERADOS e gitignorados (gen/android/.gitignore, app/.gitignore) e o `apply(from = "tauri.build.gradle.kts")` de app/build.gradle.kts:70 falha sem eles.

**Correção:** Reestimar em 10-14h ou fatiar: (2a) processador + ganho por faixa + commands, (2b) limiter + UI + gate de medição. E documentar no plano que o alvo Gradle exige um `cargo tauri android build` prévio para gerar os arquivos de settings.


### H · 1 — Sheet de track info

**Problema:** Colisão direta com Epic F fase 4: as duas fases criam a mesma coisa. H cria `src/mobile/components/TrackInfoSheet.tsx` e porta `.sheet`/`.kv` de docs/design-refs/design_handoff_mobile/app.css:95-104 para src/mobile/styles/app.css (que hoje lista essas regras como cortadas no cabeçalho, linhas 8-10); F fase 4 cria `src/mobile/sheet.ts` + `src/mobile/components/Sheet.tsx` com estado, scrim, arraste e integração com o botão voltar, e restaura o MESMO bloco de CSS. As duas também adicionam botão no `.nphead` de NowPlaying.tsx:130-179. Merge conflict garantido e duas sheets divergentes (a de H sem back-button, a de F sem os campos técnicos).

**Correção:** H fase 1 deve consumir o `<Sheet>` de F fase 4 (dependência explícita) e entregar só o CONTEÚDO (`kind: "info"`, já previsto no `SheetSpec` de F) + o command `lib_manifest_info`. Se H precisar rodar antes de F, então H entrega o primitivo e F consome — mas alguém tem de ser o dono, e o plano de H hoje nem cita o de F.


### F · 1 — Honestidade (lib_status)

**Problema:** Três epics criam três commands quase idênticos no mesmo arquivo. F fase 1: `lib_status -> LibStatus { cause, manifest_tracks, audio_files, resolved, unresolved, has_vectors, has_taste, stations, music_root }`. J fase 3: `lib_state -> LibState { storage, manifest_present, tracks, unresolved, audio_files }`. H fase 1: `lib_manifest_info -> ManifestInfo { schema, generated_at, track_count, unresolved, with_lufs, with_vector, with_lrc }`. Os três derivam do mesmo `MobileLibrary::load()` (mobile_library.rs:202-278), os três precisam do mesmo probe de permissão do root, e os três entram no mesmo `generate_handler!` (mobile.rs:143-155). F já coordena com o Epic D sobre este command ('F cria a struct, D estende'), mas não vê J nem H.

**Correção:** Um único `lib_status` com campos opcionais, dono = Epic F fase 1 (é a fase mais cedo e a que define `derive_cause`). J fase 3 acrescenta `storage: granted|denied`; H fase 1 acrescenta `schema`/`generated_at`/`with_lufs`/`with_vector`/`with_lrc`; D acrescenta a lista de unresolved. Fixar isso no plano antes de qualquer um começar — não é conflito de merge, é três contratos públicos concorrentes.


### J · 5 — Identidade + token

**Problema:** O token fail-closed não tem caminho de distribuição definido. O plano gera `<data_dir>/sync_token` no setup do DESKTOP (src-tauri/src/desktop.rs, receptor em :2758 `sync_receiver::start(...)`), ou seja, em `~/.local/share/dev.cmr.rustifyplayer/` na CMR-AUTO; e manda `scripts/android/export_manifest.py` escrever `.rustify/sync.json {endpoint, token}` — mas o script roda na VM (docstring do próprio script, linhas 22-30) e nada no plano diz de onde ele lê o token. A única pista é 'o desktop logando o token no boot', que é passo manual. Com o 401 fail-closed decidido, o primeiro ciclo depois da fase 5 é lockout garantido — exatamente o risco que o plano lista sem fechar.

**Correção:** Especificar a leitura no script: ele já faz `subprocess.run(["ssh", CMR_AUTO, ...])` no caminho de deploy (export_manifest.py, deploy_artifacts ~:489-496 e o job de capas logo acima), então `ssh cmr-auto cat ~/.local/share/dev.cmr.rustifyplayer/sync_token` cabe no mesmo passo, com falha dura se o arquivo não existir (o desktop novo ainda não subiu). E amarrar a ordem no plano: release do desktop → boot (gera o token) → export com token → APK novo.


### I · 6 — App Shortcuts

**Problema:** O atalho só funciona em boot FRIO. `mountMobile` (src/mobile/MobileApp.tsx:145-172) roda uma vez, e é ali que o plano consome a rota pendente ('mountMobile consome a rota pendente antes do bootRoute'). A Activity é `launchMode="singleTask"` (src-tauri/gen/android/app/src/main/AndroidManifest.xml:19): com o app vivo em background — o estado NORMAL de um player de música com foreground service — o atalho entra por `onNewIntent`, a Activity é reaproveitada, o WebView não remonta e o arquivo `pending_route` fica no disco sem leitor. O critério ('Stations abre direto na tela de stations') falha no caso mais comum.

**Correção:** Consumir a rota também no retorno ao primeiro plano: o gancho já existe em src/mobile/store.ts:381-384 (`visibilitychange` + `focus`, que hoje só chamam `syncState`). Chamar `appTakePendingRoute()` ali e navegar se vier algo. Incluir no smoke: `am start` com o app JÁ aberto em background, não só depois de force-stop.


### I · 3 — Busca com ações

**Problema:** Colisão de contrato com Epic F fase 5, no mesmo arquivo e com assinaturas incompatíveis. I fase 3: `searchTracks(tracks, query, limit): { items, total }` (BREAKING, declarado assim). F fase 5: `searchTracksScored(...): { hits, total }` em src/mobile/search.ts, com `searchTracks` mantido como wrapper de assinatura ATUAL (`Track[]`, src/mobile/derive.ts:118-133). As duas fases ainda adicionam, cada uma por si, debounce no input (Search.tsx:92), botão X no `.searchfield` (Search.tsx:84-100), 'Melhor resultado'/'Top result' e a linha 'mostrando N de M' — e ambas reclamam do corte silencioso em derive.ts:129 e do `.slice(0, 30)` em Search.tsx:62-70.

**Correção:** Um dono só. Recomendação: F fase 5 (é quem traz o scoring real portado de query.rs:334-406, que é o valor de verdade) fica com derive/search.ts e a barra; I fase 3 fica só com o bloco 'Ações' (shuffle-all/open-queue/open-stations/radio-track) e com o `deriveArtists`/`albumKey` sem artista (derive.ts:55-57, :86). Sem isso, os dois PRs se destroem em derive.ts + Search.tsx.


### F · 3 — Barras do sistema

**Problema:** Editar `src-tauri/gen/android/app/src/main/res/values/themes.xml` não resolve nada: `MainActivity.onCreate` chama `enableEdgeToEdge()` sem argumentos (src-tauri/gen/android/app/src/main/java/dev/cmr/rustifyplayer/MainActivity.kt:8), o que sobrescreve `statusBarColor`/`navigationBarColor` em runtime e — pior — usa `SystemBarStyle.auto`, que decide a polaridade dos ÍCONES pelo uiMode do SISTEMA (o tema é `Theme.MaterialComponents.DayNight`, themes.xml:3). Com o Android em claro e o app preto, os ícones ficam escuros sobre fundo escuro; `windowLightStatusBar=false` no XML é ignorado. Além disso é trabalho duplicado com Epic G fase 2, que já propõe a correção certa.

**Correção:** Trocar por `enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))` em MainActivity.kt:8 — que é exatamente o que Epic G fase 2 especifica. Remover o item de F fase 3 e declarar dependência de G, ou assumir o item e G remove o dele.


## AJUSTE


### A · 1 e 4

**Problema:** Colisao de contrato com o Epic B, nao declarada em dependencias_externas (que so cita inteligencia/like/export). O Epic B fase 1 define o MESMO command `getQueue`/`get_queue` com outro shape (`{trackIds: String[], index}` contra o `QueueSnapshot` com origin/contextId/durationMs por item), a MESMA entrada `allow-get-queue` em permissions/default.toml, e o Epic B fase 5 entrega `setRepeatMode` + origin 'repeat' no mesmo bloco do AudioService (handleTransition, AudioPlugin.kt/AudioService.kt:187-204) que a fase 4 daqui reescreve.

**Correção:** Nomear o Epic B em dependencias_externas e fixar quem e dono de: (a) o shape de get_queue (o desta fase e superset — deveria vencer), (b) set_repeat_mode + origin 'repeat' (esta fase 4 ou a fase 5 do B, nao os dois). Sem isso os dois epics vao editar build.rs:4-18 e permissions/default.toml:9-23 em worktrees separados com conflito garantido.


### B · 5

**Problema:** Path errado: `src/mobile/screens/NowPlaying.tsx` nao existe. O overlay vive em `src/mobile/components/NowPlaying.tsx` (o comentario de cabecalho que declara a ausencia de shuffle/repeat esta nas linhas 11-12 desse arquivo).

**Correção:** Trocar o path na lista de arquivos da fase 5 para src/mobile/components/NowPlaying.tsx:11-12 (o Epic A fase 4 acertou o caminho).


### B · 5

**Problema:** O criterio de pronto e 'a regua do dia seguinte' — nao e observavel no fim da sessao, depende do timer diario 09:00 na VM e de o app desktop estar aberto na cmr-auto para o sync chegar. Alem disso o bloco por dispositivo da regua so e impresso com 2+ devices (autoplay_regua.py:300).

**Correção:** Promover o gate imediato ja listado nos testes (`adb shell run-as dev.cmr.rustifyplayer cat files/play_events.jsonl` mostrando origin=repeat nas 3 voltas) a criterio de pronto, e manter a regua como verificacao pos-release de 24h.


### B · 3

**Problema:** A nova assinatura `rank_pool(pool, taste, vectors, session_negatives)` colide com o Epic C fase 1, que muda a MESMA funcao (mobile_intel.rs:214) para `rank_pool(pool, taste, vectors, now)` e ainda troca o tipo de `Taste` (de `Vec<u64>` para `Vec<TasteTrack>` com peso). Quem entrar segundo reescreve o corpo inteiro e os testes de mobile_intel.rs:357-369.

**Correção:** Nomear o Epic C em dependencias_externas e definir a assinatura final de uma vez: `rank_pool(pool, &Taste, Option<&VectorIndex>, now: i64, session_negatives: &[u64])`. Os dois epics passam a implementar contra ela.


### B · 4

**Problema:** `cap_per_artist` alimentado por `Track.artist_name`, que e `Option<String>` (mobile_library.rs:52). Sem tratamento, todas as faixas sem artista caem no mesmo balde e o cap de 2 corta um acervo inteiro de metadados sujos (o CLAUDE.md documenta faixas com artist = URL do ripper).

**Correção:** Especificar no contrato de `cap_per_artist` que `None` nao agrupa (cada faixa sem artista e seu proprio balde), com teste — o Epic E fase 4 ja escreveu exatamente esse caso de teste e este deveria copiar.


### C · 1

**Problema:** `MIN_WEIGHT_SCALE = 0.35` e apresentado como 'espelho de qdrant_client.rs, mesma nota de fonte-da-verdade que o export_manifest.py ja carrega'. Nao existe essa constante em qdrant_client.rs — o conjunto espelhado e o de export_manifest.py:63-76 (HALF_LIFE_DAYS, POSITIVE_MIN_LISTEN_PCT, QUALIFY_FLOOR, NEGATIVE_NET_THRESHOLD, ...). O piso de 0.35 na normalizacao de peso e invencao nova do mobile.

**Correção:** Documentar MIN_WEIGHT_SCALE no topo de mobile_intel.rs como decisao LOCAL do ranking mobile, sem fonte no desktop — senao a proxima sessao vai 're-sincronizar' com um arquivo que nunca teve esse numero.


### C · 4

**Problema:** Cortar `build_taste` do export deixa `build_stations` sem entrada: hoje `main()` usa o retorno dele para os negativos (`taste, _, negative_ids = build_taste(...)` e `build_stations(args.qdrant, negative_ids)`, export_manifest.py:493-499), que vao para o `recommend` de cada seed (seed_pool). A lista de arquivos nao menciona esse re-fio.

**Correção:** Explicitar que `main()` passa a extrair os negativos do JSON devolvido pelo GET /sync/taste e alimentar `build_stations` com eles; se o GET falhar, `build_stations` roda com lista vazia (pool pior, nao quebra).


### D · 6

**Problema:** A carga assincrona faz o app pintar com biblioteca VAZIA, e a Home decide o estado vazio por `libReady() && tracks().length > 0` (Home.tsx:48-58): com libReady verdadeiro e zero faixas, o usuario ve 'Acervo vazio — Nenhuma faixa em /storage/emulated/0/Music' por um segundo a cada boot. A lista de arquivos cita Library.tsx e Settings.tsx, nao Home.tsx.

**Correção:** Incluir src/mobile/screens/Home.tsx:48-58 na fase (o fallback tem que olhar `stats().loading` antes de decidir 'Acervo vazio'), e o mesmo para o mini player/Dock se ele depender de tracks().


### D · 5

**Problema:** Colocar `embedded_lyrics` no FIELDS (export_manifest.py:51-56) faz o scroll PRINCIPAL de 1746 pontos carregar 1-4KB de LRC por faixa. O proprio codebase exclui esse campo dos scrolls em massa exatamente por isso (qdrant_client.rs:870-873: 'Tudo menos embedded_lyrics (LRC completo, ~1-4 KB/faixa)').

**Correção:** Buscar as letras num scroll separado dentro de `build_lyrics`, com `with_payload: {include: ["embedded_lyrics","lyrics_text","lrc_path"]}` e so para os ids sem lrc_path — deixando FIELDS como esta.


### D · 2 e 3

**Problema:** Reivindicar `"schema": 2` para o manifest colide com o Epic E fase 3, que bumpa o MESMO campo para 2 com outro conteudo (play_count/last_played). O numero deixa de identificar coisa alguma, e o tile de diagnostico da fase 1 ('schema 1') passa a mentir dependendo de qual epic rodou o export por ultimo.

**Correção:** Como tudo e aditivo com `#[serde(default)]`, ou os dois epics combinam um unico bump (schema 2 = capa por album + vibe + paleta + play_count) ou nenhum bumpa e o campo `schema` fica so como carimbo do exportador. Nomear o Epic E em dependencias_externas (hoje ele nao aparece).


### D · 1

**Problema:** `fmtAgo(unix)` em src/mobile/derive.ts e a MESMA funcao que o Epic E fase 1 cria em src/mobile/derive.ts (e testa em derive.test.ts). Dois epics criando a mesma helper no mesmo arquivo = conflito de merge garantido em worktrees separados.

**Correção:** Atribuir fmtAgo a um dono (o Epic E fase 1 e o que a usa em lista) e este consumir; ou trocar por reuso explicito com nota cruzada. Vale a mesma nota para src/mobile/screens/Settings.tsx, tocado pelas fases 1, 3 e 8 daqui e pelas fases 1, 2 e 5 do Epic C.


### E · 1

**Problema:** A linha 'Historico' em Coleções (Library.tsx:118-127) precisa de um icone, e src/mobile/icons.tsx nao tem `history` — o objeto exporta home, search, library, settings, disc, note, person, folder, play, pause, next, prev, shuffle, queue, back, chev, down, lyrics, radio, sparkle, e o cabecalho do arquivo declara que os icones das telas cortadas ficaram de fora de proposito. O handoff tem `I.history` (data.js).

**Correção:** Incluir src/mobile/icons.tsx na fase 1 (portar `history` do handoff e tirar a mencao dele do comentario de cabecalho, icons.tsx:9-12), como o Epic C fase 2 fez com heart.


### E · 3

**Problema:** O bump para `"schema": 2` colide com o Epic D (fases 2 e 3), que bumpa o mesmo campo com outro conteudo, e dependencias_externas so cita o gap `lib-sync-incremental` — nao o epic de dados que esta reescrevendo build_manifest inteiro (export_manifest.py:124-159) no mesmo periodo.

**Correção:** Nomear o Epic D em dependencias_externas e combinar um bump unico; os campos daqui (play_count/last_played com serde default) sao aditivos e nao exigem numero proprio.


### G · 2 — Escala e densidade

**Problema:** O critério de pronto ('Scale 125% aumenta as listas e o NowPlaying') não bate com o contrato ('--ui-scale aplicada como zoom SOMENTE em .view e em .np .lyrics'). O `<NowPlaying>` não está dentro de `.view`: é irmão de `.shell` dentro de `.device` (src/mobile/MobileApp.tsx:126-132). Com zoom só no `.view`, a capa de 214px, o título, os tempos e os controles do NP não escalam — só o bloco de letra. Um usuário que ligou escala por acessibilidade continua com a tela de reprodução no tamanho antigo.

**Correção:** Ou estender o zoom a `.np .inner` (app.css:349-356) e revalidar o seek, que lê `getBoundingClientRect` em NowPlaying.tsx:85-89 — dentro do subtree com zoom os dois lados da conta são coerentes, mas precisa de smoke — ou corrigir o critério para 'aumenta as listas e a letra'.


### J · 6 — APK assinado

**Problema:** O plano acerta o `isMinifyEnabled = true` (src-tauri/gen/android/app/build.gradle.kts:40) mas não menciona a outra diferença debug→release do mesmo arquivo: `manifestPlaceholders["usesCleartextTraffic"]` é `"true"` no debug (:29) e `"false"` no defaultConfig (:20), então o APK assinado sai com `android:usesCleartextTraffic="false"` (AndroidManifest.xml:16). O sync do S24 é HTTP puro para `http://100.102.249.9:19878` (src-tauri/src/mobile_sync.rs:73). ureq é socket nativo e provavelmente escapa da NetworkSecurityPolicy, mas 'provavelmente' não é critério de pronto — e é justamente a fase que o CEO aprovou para trocar a assinatura.

**Correção:** Adicionar ao smoke da fase 6 a verificação explícita: instalar o release, tocar uma faixa e conferir `pending = 0` no painel Sync da fase 2. Se falhar, a saída é `manifestPlaceholders["usesCleartextTraffic"] = "true"` no buildType release, ou um `network_security_config` liberando 100.64.0.0/10.


### J · 1 — Instrumentação

**Problema:** A hipótese do plano se confirma no código, e isso encolhe a fase: tauri-plugin-log 2.8.0 mapeia `TargetKind::Stdout | TargetKind::Stderr` para `android_logger::log` quando `target_os = "android"` (lib.rs:588-589 do crate no registry), `DEFAULT_LOG_TARGETS` já inclui `Target::new(TargetKind::Stdout)` (lib.rs:50), e src-tauri/src/mobile.rs:124-129 nunca chama `.targets()` — logo os defaults valem e o log JÁ vai pro logcat. Como `tracing` é compilado com feature `log` (src-tauri/Cargo.toml:32) e o Android não linka tracing-subscriber (:92 é desktop-only), os `tracing::warn!` de mobile_library/mobile_sync viram records do facade e chegam lá.

**Correção:** O item 'logs-diagnostico' colapsa em correção de doc: a linha do CLAUDE.md ('Log Rust NAO roteia pro logcat — ler via adb shell run-as ...') está stale e deve ser substituída por `adb logcat --pid=$(adb shell pidof dev.cmr.rustifyplayer)`. A fase 1 fica só com BuildInfo + marcador de boot + panic hook; reestimar de 3h para ~2h e usar o saldo na fase 2.


### I · 1 — Ordem, filtro e alcance

**Problema:** Contradição interna e trabalho duplicado no scroll. O bloco `dependencias_externas` diz textualmente que a restauração de scroll (MobileApp.tsx:115-118) 'NÃO são deste epic e não os assumo', mas a fase 1 lista esse arquivo em `arquivos` e o item (d) do critério de pronto depende dele. Pior: Epic F fase 6 planeja a mesma coisa com contrato mais completo (`scrollMemory.ts` guardando top E limit, `LazyList` com `memoryKey`) — e sem a parte do limit a restauração falha justamente na lista de 1746 faixas, porque `LazyList` reinicia `limit` para 60 sempre que `props.items.length` muda (src/mobile/components/ui.tsx:75-78), de modo que um `scrollTop` de 8000px cai no fim do conteúdo montado. O mesmo vale para o achado 'Folder engole erro de IPC' (Folder.tsx:21/:39), que I fase 1 e F fase 1 reclamam para si.

**Correção:** Escolher o dono do scroll (recomendação: F fase 6, que tem o `memoryKey`) e remover o item + o critério (d) da fase 1 de I, ou importar o contrato de F. Idem para o erro do Folder.


### F · 3 — Estado pressionado e foco

**Problema:** A premissa 'zero estilo de :focus-visible / :active em src/mobile/styles' é falsa para `:active`: existem três regras hoje — `.trk:active` (src/mobile/styles/app.css:98-100), `.rowitem:active` (:205-207) e `.shapebtn:active` (:759-762), todas com `background: var(--s-high)` ou mudança de cor. Só `:focus-visible` é realmente zero. Epic G fase 2 repete a mesma afirmação errada. Consequência prática: metade do trabalho da fase é redundante nas linhas de faixa e de item, que são as superfícies mais tocadas do app.

**Correção:** Reescopar a fase para o que falta de verdade — `.iconbtn` (tokens.css:350-359), `.chip` (app.css:61-75), `.tab` (tokens.css:373-391), `.seg button` (app.css:~588), `.qs` (tokens.css:194-208), `.alb` (tokens.css:280-288) — e o bloco `:focus-visible` global. E alinhar com G fase 2, que planeja o mesmo bloco.


### G · 4 e 1 — defaults e migração

**Problema:** Dois números do contrato não fecham com o código. (a) fase 4 declara default `lyricsGlass: 0.55` justificando 'no mobile o default fica NO LADO SOLIDO', mas o limiar de sólido é 0.85 (src/store/tweaks.ts:283 `SOLID_THRESHOLD`), e 0.55 produz alpha 0.376 / `lyricsSolid = off` — ou seja, o default proposto é MAIS translúcido que o do desktop (0.25 → alpha 0.19) apenas em grau, não em categoria. (b) fase 1 mapeia beat 'Off' → `("off", 0.55)`, enquanto hoje Off escreve `--bg-beat-depth: 0` (src/mobile/bg/beatSetting.ts:14). Só é inócuo se `--bg-beat-sync` for de fato escrito como 0 — e o spectrum lê `beatSync > 0.5` (src/mobile/bg/spectrum.ts:204 e :220) com default 1 (:127), e HOJE ninguém escreve essa var.

**Correção:** (a) Ou subir o default para ≥0.85 se a intenção é sólido, ou corrigir a prosa. (b) Fixar no contrato o mapeamento numérico explícito, espelhando o desktop (tweaks.ts: `--bg-beat-sync` = 0 quando mode 'off'; `--bg-beat-mode` = 0/1/2) e cobrir no teste de applyMobileTweaks, senão 'Off' vira 'speed com depth 0.55'.


### F · 2 — Contrato nativo

**Problema:** 'o Kotlin não tem infra de teste no repo — a validação é smoke' está errado: `testImplementation("junit:junit:4.13.2")` já está declarado em src-tauri/crates/tauri-plugin-rustify-audio/android/build.gradle.kts:48, e o módulo Gradle se chama `:tauri-plugin-rustify-audio` (src-tauri/gen/android/tauri.settings.gradle). A lógica que a fase introduz (contador `consecutiveErrors` com reset em EVENT_IS_PLAYING_CHANGED e teto MAX_CONSECUTIVE_ERRORS=3, mais a supressão do flush quando `curFailed`) é a parte cara de acertar e é testável na JVM se sair de AudioService para uma classe pura.

**Correção:** Extrair a máquina de estados de erro para uma classe sem `import android.*` (mesmo molde que Epic H propõe para DspKernel) e adicionar `android/src/test/java/…Test.kt`. Custa ~30min e cobre o risco 'cascata de skip' que a própria fase lista, hoje verificado só renomeando arquivos no cartão.
