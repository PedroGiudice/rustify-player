# Diff Rustify: app Android vs app Desktop — inventario completo

**Data:** 2026-08-15  
**Metodo:** 6 agentes de inventario (um por dimensao) leram o codigo dos dois lados; 
6 ceticos independentes verificaram cada achado contra o codigo e acrescentaram o que passou. 
164 gaps levantados, 1 derrubado como ja entregue, 37 achados adicionais dos ceticos.  
**Baseline:** desktop 0.2.73 (~100 tauri commands) vs Android v1 pos-`d2db593` (11 commands).

Ja entregue no mobile e NAO listado aqui: vetores MERT locais + cosine, stations precomputadas com re-rank por gosto, 
taste snapshot, letras sincronizadas, capas, beat sync real (FFT do ExoPlayer), ink/accent adaptativos, 
fundo animado (shapes x renderers), fila nativa com auto-advance, journal + sync de eventos.

## Sumario por epic

| Epic | Titulo | Itens | XS | S | M | L | XL |
|---|---|---:|---:|---:|---:|---:|---:|
| **A** | Fila mutavel e estado de sessao | 19 | 3 | 6 | 8 | 2 | 0 |
| **B** | Continuidade: a musica nunca para | 15 | 3 | 4 | 6 | 2 | 0 |
| **C** | Loop de gosto fechado (like + sync bidirecional) | 15 | 2 | 3 | 9 | 1 | 0 |
| **D** | Pipeline de dados desktop->celular | 20 | 4 | 7 | 6 | 1 | 2 |
| **E** | Historico e play_count locais | 5 | 0 | 2 | 3 | 0 | 0 |
| **F** | Micro-interacoes: o que faz parecer um app | 24 | 13 | 9 | 2 | 0 | 0 |
| **G** | Customizacao: Tweaks, temas e light/dark | 23 | 6 | 9 | 6 | 2 | 0 |
| **H** | Audio: DSP, loudness e info tecnica | 11 | 3 | 3 | 2 | 3 | 0 |
| **I** | Navegacao e descoberta | 15 | 3 | 6 | 2 | 3 | 1 |
| **J** | Plataforma: operacao, seguranca e distribuicao | 16 | 7 | 5 | 3 | 1 | 0 |
| | **TOTAL** | **163** | | | | | |


---

## Epic A — Fila mutavel e estado de sessao

O plugin Kotlin so sabe SUBSTITUIR a fila inteira. Sem leitura nem mutacao incremental, 15 gaps de 5 dimensoes ficam bloqueados no mesmo ponto.


### `queue-clear` — Limpar a fila mantendo o que toca · **XS**
*(dimensao: playback)*

- **Desktop:** Botao 'Clear' no QueueDrawer: setQueue([currentTrack], 0) — descarta o resto sem parar a musica.
- **Mobile hoje:** Nao existe. Sem gesto equivalente na tela Queue.
- **Por que importa:** Detalhe pequeno de alto uso: fila com 40 faixas de station que o usuario quer encerrar sem pausar.
- **Risco/restricao:** set_queue com so a faixa corrente reinicia a posicao (setMediaItems(..., 0L) em AudioPlugin.kt:148) — precisaria de removeMediaItems para nao dar rewind.
- **Depende de:** plugin-queue-read
- **Ancoras desktop:** `src/components/QueueDrawer.tsx:78`
- **Ancoras mobile:** `src/mobile/screens/Queue.tsx:59`

### `prev-restart-track` — Botao anterior: reiniciar a faixa vs voltar de fato · **XS**
*(dimensao: playback)*

- **Desktop:** retreatQueue sempre volta uma posicao (mesma semantica do mobile).
- **Mobile hoje:** Paridade por outro caminho, com uma decisao DELIBERADA e documentada: 'previous e sempre faixa anterior; sem o comportamento de reiniciar a atual quando ja passou de N segundos (o journal veria isso como nada)'. No inicio da fila faz seekTo(0).
- **Por que importa:** Nao e gap — e uma escolha consciente pra nao poluir o journal. Registrado pra nao ser 'corrigido' por engano. O detalhe faltante nos DOIS lados e o idioma universal de player (voltar reinicia se passou de ~3s).
- **Risco/restricao:** Se implementar, precisa decidir o que o journal registra num restart — hoje nada, o que e defensavel.
- **Ancoras desktop:** `src/store/player.ts:230`, `src/components/PlayerBar.tsx:517`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt:184`

### `home-continue-listening` — Home mobile sem "Continue listening" (retomar a faixa atual) · **XS**
*(dimensao: telas)*

- **Desktop:** O primeiro hero tile é contextual: se há faixa carregada, vira "retomar" com duração e "ready to resume"; senão vira Shuffle all (src/views/Home.tsx:88-103). Há ainda um terceiro tile "From your library / Surprise me" (:112-135).
- **Mobile hoje:** A qs-row tem no máximo dois cartões fixos: Shuffle all e Stations (src/mobile/screens/Home.tsx:59-74). O handoff previa três (docs/design-refs/design_handoff_mobile/screens.js:13-16).
- **Por que importa:** Abrir o app para continuar o que estava tocando é o caso de uso número um no celular — hoje o caminho é achar o mini player e tocar nele.
- **Risco/restricao:** Depende de o serviço reter estado entre sessões; hoje o espelho da fila é rehidratado do localStorage e o get_state do serviço manda (src/mobile/store.ts:371-372) — se o serviço morreu, o tile precisa cair para "tocar do começo".
- **Ancoras desktop:** `src/views/Home.tsx:88`, `docs/design-refs/design_handoff_mobile/screens.js:13`
- **Ancoras mobile:** `src/mobile/screens/Home.tsx:59`

### `plugin-queue-read` — Leitura da fila nativa (o plugin nao expoe get_queue) · **S**
*(dimensao: playback)*

- **Desktop:** A fila e o proprio player.queue no JS — sempre legivel, com indice, historico (slice antes do indice) e proximas (slice depois).
- **Mobile hoje:** A fila real vive no ExoPlayer e nao ha command de leitura; a UI mantem um ESPELHO em localStorage (kv-mobile-queue) que fica errado sempre que o WebView reinicia com o servico tocando — a tela de Queue chega a mostrar o empty-state 'Fila indisponivel'.
- **Por que importa:** Toda operacao de fila (reordenar, remover, add next, salvar como playlist) e todo estado visual dependem de saber o que esta na fila. E o gargalo estrutural desta dimensao inteira.
- **Risco/restricao:** Command novo no plugin devolvendo mediaId+metadata por indice; barato. Risco e serializar u64 como Number — mediaId ja e String, manter.
- **Ancoras desktop:** `src/store/player.ts:47`, `src/views/Queue.tsx:12`
- **Ancoras mobile:** `src/mobile/screens/Queue.tsx:1`, `src/mobile/store.ts:112`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt:205`

### `repeat-modes` — Repeat off/all/one · **S**
*(dimensao: playback)*

- **Desktop:** cycleRepeat percorre off→all→one; 'one' re-toca a faixa logando origin 'repeat' (sinal positivo pleno), 'all' volta ao inicio no fim da fila, e o preload gapless e re-alinhado no clique para nao tocar um blip da faixa errada.
- **Mobile hoje:** Inexistente — nem UI nem command. Fim da faixa sempre avanca; fim da fila para.
- **Por que importa:** Repeat-one e um sinal de gosto forte (o desktop trata como positivo pleno) e some inteiro no celular; repeat-all e o basico de tocar um album em loop.
- **Risco/restricao:** Barato no ExoPlayer (setRepeatMode). Cuidado com o journal: MEDIA_ITEM_TRANSITION_REASON_REPEAT ja e tratado como track_ended natural (AudioService.kt:196) — mas o origin 'repeat' do desktop nao existe no mobile, entao o sinal sairia rotulado errado se nao ajustar o QueueMeta.
- **Ancoras desktop:** `src/store/player.ts:295`, `src/components/PlayerBar.tsx:129`, `src/components/PlayerBar.tsx:571`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:11`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt:156`

### `queue-source-provenance-fidelity` — Fidelidade da proveniencia de fila nas CONTINUACOES · **S**
*(dimensao: playback)*

- **Desktop:** contOrigin() mapeia a proveniencia da fila pro origin de cada continuacao (station→station, radio→autoplay, playlist→playlist), e contContextId() carrega o contextId da rodada — sem isso o behavioral_signals descartaria as escutas boas.
- **Mobile hoje:** Paridade PARCIAL por outro caminho: o QueueMeta carrega origin+contextId da fila inteira e o service estampa TODA faixa com ele (AudioService.adoptCurrent). Funciona porque a fila mobile e sempre homogenea; mas assim que existir add-next/autoplay a fila fica heterogenea e o origin fica ERRADO pra todo mundo (uma faixa enfileirada manualmente dentro de uma station logaria origin=station).
- **Por que importa:** E uma bomba-relogio de sinal: no dia que o mobile ganhar add-next ou autoplay, os play_events comecam a mentir e o motor v3 aprende errado — silenciosamente.
- **Risco/restricao:** Corrigir depois exige mudar o formato do QueueItem (origin por item) e ninguem vai lembrar. Fazer JUNTO com o primeiro gap que quebre a homogeneidade da fila.
- **Depende de:** queue-enqueue-next-end
- **Ancoras desktop:** `src/components/PlayerBar.tsx:684`, `src/components/PlayerBar.tsx:707`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/QueueMeta.kt:1`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt:206`

### `restore-queue-source` — Restauração de proveniência da fila entre sessões · **S**
*(dimensao: inteligencia)*

- **Desktop:** persist_save_state/persist_load_state guardam queue_source_kind/name e re-armam a proveniência no restore — sem isso a fila volta como 'solta' e as continuações voltam a logar album_seq (que os sinais EXCLUEM).
- **Mobile hoje:** O espelho mobile persiste ids + origin em localStorage e rehidrata, mas nada garante que o origin no QueueMeta do serviço (Kotlin) sobreviva a um kill do processo: o journal usa QueueMeta, não o localStorage do WebView.
- **Por que importa:** É exatamente o bug que o desktop já pagou (CMR-179 lista 'restore de queueSource' como deferido). Se o serviço reiniciar, os eventos seguintes podem sair com origin 'unknown' (default do QueueMeta) — evento com origin fora do vocabulário entra com peso cheio nos sinais.
- **Risco/restricao:** Verificar antes de corrigir: se o AudioService morre, a fila do ExoPlayer também morre (então não haveria evento). O risco real é o caso intermediário — serviço vivo, WebView recriado. Vale um teste antes de escrever código.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:2059 (persist_load_state)`, `src/components/PlayerBar.tsx:205-212 (re-arma queueSource no restore)`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/QueueMeta.kt:16 (origin default 'unknown')`, `src/mobile/store.ts:104-125 (persistQueue/rehydrateQueue — só o espelho da UI)`

### `queue-read-plugin` — Plugin Kotlin nao expoe leitura da fila — espelho pode divergir · **S**
*(dimensao: plataforma)*

- **Desktop:** A fila e do frontend (store/player.ts) e o snapshot persistido e a verdade; qualquer tela le a fila real.
- **Mobile hoje:** store.ts documenta explicitamente que o plugin nao expoe leitura da fila e mantem um ESPELHO local; get_state devolve so status/index/trackId/position/duration.
- **Por que importa:** Se o espelho corromper (localStorage limpo, app atualizado, fila montada por outro caminho), a tela de Queue mostra coisa diferente do que toca — e a retomada de sessao nao tem como reconstruir fielmente.
- **Risco/restricao:** Command novo no plugin DEVE ser async fn com AppHandle<R> (State sincrono deadlocka). Serializar a fila inteira a cada get_state e caro; expor get_queue separado.
- **Ancoras desktop:** `src/store/player.ts:91`, `src/components/PlayerBar.tsx:214`
- **Ancoras mobile:** `src/mobile/store.ts:1`, `src/mobile/store.ts:104`, `src-tauri/crates/tauri-plugin-rustify-audio/src/commands.rs:79`

### `shuffle-repeat-persistidos` — Shuffle e repeat: sem modo persistente no mobile · **S** _[WRONG_ANCHORS]_
*(dimensao: plataforma)*

- **Desktop:** shuffle e repeat_mode ('off'|'all'|'one') sao estado do player, persistidos no state.json e restaurados; repeat-one loga origin 'repeat'.
- **Mobile hoje:** Shuffle e um ato pontual (shuffleList/shuffleAll embaralha a lista antes do set_queue); NowPlaying documenta que shuffle/repeat sairam dos controles por nao haver command no plugin. Nada persiste.
- **Por que importa:** Repeat de album/faixa e shuffle continuo sao expectativa basica de player; alem disso a ausencia de 'repeat' como origin faz o sinal do mobile diferir do desktop.
- **Risco/restricao:** ExoPlayer ja tem shuffleModeEnabled/repeatMode nativos — expor via plugin e barato, mas muda a semantica do journal (auto-advance por repeat precisa carimbar origin correto, senao polui o sinal v3).
- **Depende de:** queue-read-plugin
- **Ancoras desktop:** `src-tauri/src/persistence.rs:47`, `src-tauri/src/persistence.rs:45`, `src/components/PlayerBar.tsx:216`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:11`, `src/mobile/store.ts:215`, `src-tauri/crates/tauri-plugin-rustify-audio/src/commands.rs:23`
- **Veredito do cetico:** Gap real, ancoras desktop erradas: shuffle e repeat_mode sao persistence.rs:42 e :44 (as citadas 45/47 sao recently_played). Restauracao em PlayerBar.tsx:214-216 (setPlayer com shuffle/repeatMode). No mobile confirmado: shuffleList (store.ts:215) so embaralha antes do set_queue; nenhum command de shuffle/repeat no plugin (commands.rs inteiro, 11 commands); nada persiste.

### `queue-enqueue-next-end` — Add next / Add to queue (enfileirar sem trocar o que toca) · **M**
*(dimensao: playback)*

- **Desktop:** TrackContextMenu e CommandPalette enfileiram uma faixa logo depois da atual (enqueueNext) ou no fim (enqueueEnd), sem interromper o playback. Atalhos: Cmd/Ctrl+Enter = play next, Shift+Enter = fim da fila, no ⌘K.
- **Mobile hoje:** Nao existe. O unico caminho para tocar e playList(), que SUBSTITUI a fila inteira (set_queue com a lista nova). Nao ha menu de contexto de faixa no mobile.
- **Por que importa:** E a operacao de fila mais usada no dia-a-dia: ouvir algo e ir montando o que vem depois. Sem ela o celular so sabe 'trocar tudo agora', o que na pratica destroi a fila corrente a cada escolha.
- **Risco/restricao:** Precisa de commands novos no plugin (addItems/insertItem, async fn com AppHandle<R>). Reconciliar o espelho JS com a fila nativa depois do insert e o ponto de erro: sem leitura da fila, o indice do espelho desanda.
- **Depende de:** plugin-queue-read
- **Ancoras desktop:** `src/store/player.ts:209`, `src/store/player.ts:217`, `src/components/TrackContextMenu.tsx:88`, `src/components/TrackContextMenu.tsx:93`, `src/components/CommandPalette.tsx:210`
- **Ancoras mobile:** `src/mobile/store.ts:181`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt:127`, `src/mobile/components/TrackRow.tsx:1`

### `queue-remove-reorder` — Remover item e reordenar a fila · **M** _[OVERSTATED]_
*(dimensao: playback)*

- **Desktop:** A fila e um array reativo; remover/reordenar e mutacao de store (Queue.tsx e a 'full-page queue view ... useful for reorganizing long queues').
- **Mobile hoje:** Nao existe — o proprio comentario da tela admite: 'Sem reordenar: nao ha command para isso (o handle de arrastar do prototipo saiu)'.
- **Por que importa:** Fila longa sem edicao vira lista descartavel: o usuario so pode pular ate chegar no que quer, o que ainda POLUI o sinal (cada pulo vira track_skipped no journal).
- **Risco/restricao:** ExoPlayer tem moveMediaItem/removeMediaItem — o cuidado e o QueueMeta (durations por trackId) e o congelamento da faixa corrente no AudioService nao se perderem no meio da mutacao (AudioService.kt:35).
- **Depende de:** plugin-queue-read
- **Ancoras desktop:** `src/views/Queue.tsx:1`, `src/store/player.ts:209`
- **Ancoras mobile:** `src/mobile/screens/Queue.tsx:10`, `src/mobile/screens/Queue.tsx:63`
- **Veredito do cetico:** O desktop TAMBEM nao remove nem reordena: grep por remove/reorder/drag em src/views/Queue.tsx = 0 ocorrencias; a tela e lista read-only (upcoming linha 12, past linha 13) com clique = playQueueUpcoming. O comentario 'useful for reorganizing long queues' (Queue.tsx:3) e aspiracional, nao codigo. A unica mutacao de fila pela UI e o Clear do QueueDrawer.tsx:82 e o enqueue do menu de contexto. Logo nao ha paridade a alcancar aqui — o que falta no mobile e o mesmo que falta no desktop. Ancora mobile (screens/Queue.tsx:10) esta certa como registro da ausencia.

### `shuffle-mode` — Shuffle como MODO persistente e adaptativo (curated vs open/radio) · **M**
*(dimensao: playback)*

- **Desktop:** Botao shuffle com aria-pressed, persistido na sessao. Em fila 'curated' embaralha a propria fila; em 'open' vira radio (descarta a fila e repopula com [current, ...autoplayNext()]) e sustenta top-up.
- **Mobile hoje:** Paridade parcial por outro caminho: existe shuffleList/shuffleAll, que embaralha UMA VEZ no ato de tocar (origin 'shuffle'). Nao ha estado de shuffle, nao ha botao no NowPlaying (o comentario do arquivo diz: 'shuffle/repeat sairam dos controles: o plugin nao tem command para nenhum dos dois') e nao ha modo radio.
- **Por que importa:** Sem estado, o usuario nao consegue LIGAR shuffle no meio de um album; e sem o modo radio a fila simplesmente acaba.
- **Risco/restricao:** ExoPlayer tem setShuffleModeEnabled nativo, mas ele NAO reordena a lista visivel — o espelho e o journal veriam ordens diferentes. Alternativa (embaralhar e re-setar a fila) reinicia a faixa se nao tomar cuidado.
- **Depende de:** plugin-queue-read
- **Ancoras desktop:** `src/components/PlayerBar.tsx:317`, `src/components/PlayerBar.tsx:506`, `src/store/player.ts:251`
- **Ancoras mobile:** `src/mobile/store.ts:215`, `src/mobile/components/NowPlaying.tsx:237`

### `session-resume-position` — Retomada de sessao (faixa + posicao + fila + modos) apos matar o app · **M**
*(dimensao: playback)*

- **Desktop:** persist_save_state grava a cada 10s e em eventos de ciclo de vida (troca de faixa, pause, seek, beforeunload): track_id, position_ms, fila inteira, indice, shuffle, repeat, recently_played, escopo e proveniencia. No boot restaura tudo e carrega a faixa PAUSADA na posicao exata (player_load_paused).
- **Mobile hoje:** So o espelho de ids da fila + origin em localStorage (kv-mobile-queue). Nao restaura posicao, nem indice, nem estado de reproducao — e se o servico morreu, o app abre mudo com uma fila que nao toca.
- **Por que importa:** No celular o app e morto pelo sistema o tempo todo; retomar de onde parou (podcast-style, faixa longa) e expectativa basica.
- **Risco/restricao:** Precisa de um set_queue com posicao inicial e SEM tocar (playNow=false ja existe, mas o startPositionMs esta fixo em 0L: AudioPlugin.kt:148). Ressuscitar a fila com posicao e barato; o risco e o journal emitir track_skipped fantasma no restore.
- **Depende de:** plugin-queue-read
- **Ancoras desktop:** `src/components/PlayerBar.tsx:232`, `src/components/PlayerBar.tsx:195`, `src-tauri/src/desktop.rs:2064`, `src-tauri/src/desktop.rs:2029`
- **Ancoras mobile:** `src/mobile/store.ts:104`, `src/mobile/store.ts:371`

### `enqueue-commands` — Impossível enfileirar: toda ação de play substitui a fila inteira · **M**
*(dimensao: telas)*

- **Desktop:** enqueueNext/enqueueEnd inserem uma faixa na fila viva sem interromper o que toca (usados em src/components/TrackContextMenu.tsx:86-94 e no palette com Mod+Enter / Shift+Enter, src/components/CommandPalette.tsx:210-211). A fila também aceita clear parcial (src/components/QueueDrawer.tsx:78-86).
- **Mobile hoje:** playList() sempre chama set_queue com a lista inteira e reinicia a reprodução (src/mobile/store.ts:181-209). O plugin Kotlin não expõe nenhum command de append/insert/remove — o contrato tem só set_queue/skip_to_index (src-tauri/crates/tauri-plugin-rustify-audio/README.md:39-46).
- **Por que importa:** "Toca essa depois" é o gesto mais comum de um player de bolso. Hoje qualquer descoberta durante a escuta destrói a fila corrente.
- **Risco/restricao:** A fila canônica é a do ExoPlayer; mexer nela fora da thread do player quebra o auto-advance. E o espelho JS (store.ts:104-130) passa a divergir se o insert não devolver o novo índice.
- **Depende de:** command novo no plugin (add_items/remove_item), async fn com AppHandle<R>
- **Ancoras desktop:** `src/components/TrackContextMenu.tsx:86`, `src/components/CommandPalette.tsx:210`, `src/components/QueueDrawer.tsx:78`
- **Ancoras mobile:** `src/mobile/store.ts:181`, `src/mobile/ipc.ts:45`, `src-tauri/crates/tauri-plugin-rustify-audio/README.md:39`

### `queue-read-reorder` — Fila: sem leitura real, sem reordenar, sem remover, sem limpar, sem histórico da sessão · **M**
*(dimensao: telas)*

- **Desktop:** Fila em dois lugares: drawer lateral com "Up next", total restante e botão Clear (src/components/QueueDrawer.tsx:53-90) e tela cheia com "Now playing" + "Up next" + "já reproduzidos" (src/views/Queue.tsx:10-40). O handoff mobile desenhou a linha da fila COM alça de arrastar (docs/design-refs/design_handoff_mobile/screens.js:98) e botão de shuffle no cabeçalho (:96).
- **Mobile hoje:** A tela mostra um ESPELHO em localStorage do último set_queue (src/mobile/screens/Queue.tsx:1-12, src/mobile/store.ts:104-130). Sem reorder (declarado no cabeçalho, Queue.tsx:10-11), sem remover, sem limpar, sem seção de já tocadas. Se o WebView reiniciar com o serviço tocando, a tela cai no estado "Fila indisponível" (src/mobile/screens/Queue.tsx:46-57).
- **Por que importa:** A fila é o objeto que o usuário mais manipula em trânsito. Hoje ela é read-mostly e mente depois de um restart — exatamente o cenário do celular, que mata o WebView em background.
- **Risco/restricao:** Drag-and-drop dentro de scroll no WebView Android é notoriamente ruim; provavelmente precisa de handle dedicado + auto-scroll manual. E reordenar sem command devolve divergência entre espelho e ExoPlayer.
- **Depende de:** enqueue-commands, command get_queue no plugin
- **Ancoras desktop:** `src/components/QueueDrawer.tsx:53`, `src/views/Queue.tsx:10`, `docs/design-refs/design_handoff_mobile/screens.js:98`
- **Ancoras mobile:** `src/mobile/screens/Queue.tsx:46`, `src/mobile/store.ts:104`, `src/mobile/ipc.ts:58`

### `shuffle-repeat-controls` — Now Playing sem shuffle e sem repeat · **M**
*(dimensao: telas)*

- **Desktop:** Transport com shuffle (aria-pressed) e repeat de 3 estados (off/all/one, ícone repeatOne, re-alinha o preload gapless ao trocar de modo) — src/components/PlayerBar.tsx:503-580. O handoff mobile colocou os dois exatamente na fileira de controles do NP (docs/design-refs/design_handoff_mobile/Rustify Mobile.html:33-37).
- **Mobile hoje:** Só prev / play-pause / next (src/mobile/components/NowPlaying.tsx:237-249). O cabeçalho do arquivo declara o motivo: o plugin não tem command para nenhum dos dois (:11-12). Shuffle existe apenas como ação de partida (shuffleList em src/mobile/store.ts:215), embaralhando a lista ANTES do set_queue — não é um modo.
- **Por que importa:** Repeat-one e shuffle são estado de sessão, não de partida: sem eles não dá pra repetir a faixa em loop nem re-embaralhar sem reconstruir a fila. Além disso o desktop loga origin `repeat` para o sinal — o mobile nunca produz esse evento.
- **Risco/restricao:** ExoPlayer já implementa os dois nativamente — o risco é o espelho da fila no JS (índice) desalinhar quando o shuffle nativo reordena a ordem de reprodução sem mexer no índice das mídias.
- **Depende de:** commands set_shuffle/set_repeat no plugin (ExoPlayer tem shuffleModeEnabled e repeatMode nativos)
- **Ancoras desktop:** `src/components/PlayerBar.tsx:503`, `src/components/PlayerBar.tsx:566`, `docs/design-refs/design_handoff_mobile/Rustify Mobile.html:33`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:237`, `src/mobile/components/NowPlaying.tsx:11`, `src/mobile/store.ts:215`

### `resume-sessao` — Retomada de sessao (posicao + fila + indice) nao existe no mobile · **M**
*(dimensao: plataforma)*

- **Desktop:** persist_save_state/persist_load_state gravam state.json (track_id, position_ms, queue_ids, queue_index, shuffle, repeat, recently_played, queue_scope, queue_source_kind/name) e o PlayerBar restaura a sessao pausada no boot, re-armando proveniencia e excludes de recentes; snapshot expira em 6h.
- **Mobile hoje:** Persiste SO um espelho da fila (ids + origin) em localStorage 'kv-mobile-queue' e re-hidrata para desenhar. Nao ha posicao, indice, nem re-carga no player: ao reabrir depois do processo morrer, nao volta onde parou. persistence.rs e cfg(not(android)).
- **Por que importa:** O caso de uso mobile e justamente sair e voltar: matar o app no meio de um album e perder a faixa e a posicao e a falha mais visivel do dia-a-dia.
- **Risco/restricao:** Restaurar a fila exige re-set_queue no Kotlin com startIndex+seek; se o service ainda esta vivo com a fila antiga, restaurar por cima reseta o playback bom. Precisa checar get_state antes de restaurar e definir janela de expiracao propria (6h do desktop pode ser curta demais pra celular).
- **Depende de:** queue-read-plugin
- **Ancoras desktop:** `src-tauri/src/persistence.rs:20`, `src-tauri/src/desktop.rs:2059`, `src-tauri/src/desktop.rs:2064`, `src-tauri/src/desktop.rs:3281`, `src/components/PlayerBar.tsx:195`, `src/components/PlayerBar.tsx:231`
- **Ancoras mobile:** `src-tauri/src/lib.rs:29`, `src/mobile/store.ts:18`, `src/mobile/store.ts:104`, `src/mobile/store.ts:114`, `src-tauri/src/mobile.rs:139`

### `save-queue-as-playlist` — Salvar a fila como playlist · **L** _[OVERSTATED]_
*(dimensao: playback)*

- **Desktop:** Playlists sao pastas de 1o nivel do acervo, com a tela Playlists.tsx (11.7K) e criacao/edicao no desktop.
- **Mobile hoje:** Nao existe: as 'Folders' mobile sao somente leitura (lib_list_folders/lib_list_folder_tracks); nao ha escrita nenhuma no acervo pelo aparelho.
- **Por que importa:** Uma fila boa montada no celular (station + skips) morre quando acaba. E o momento em que o usuario quer capturar.
- **Risco/restricao:** Playlist = pasta no disco; criar no celular divergiria do acervo canonico da cmr-auto e o proximo sync sobrescreve. O caminho honesto e mandar a intencao pelo sync (como os play_events) e materializar no desktop.
- **Depende de:** plugin-queue-read
- **Ancoras desktop:** `src/views/Playlists.tsx:1`, `src-tauri/src/desktop.rs:625`
- **Ancoras mobile:** `src-tauri/src/mobile.rs:26`, `src-tauri/src/mobile_library.rs:1`
- **Veredito do cetico:** O desktop NAO cria nem edita playlist: src/views/Playlists.tsx:5-8 diz explicitamente que playlists sao folders do disco e que 'nao ha criacao ainda — sem lib_create_smart_playlist ou similar'; a tela so lista/filtra/pina (lib_list_folders, desktop.rs:625). Portanto 'salvar a fila como playlist' nao e um gap desktop->mobile, e uma feature ausente nos dois. A parte correta e que o mobile e read-only sobre o acervo (mobile.rs:26 em diante).

### `lib-fila-manipulacao` — Fila mobile e somente-leitura: sem enfileirar, reordenar ou remover · **L**
*(dimensao: biblioteca)*

- **Desktop:** store/player expoe setQueue/enqueueNext/enqueueEnd/shuffleQueue; a fila e do JS e manipulavel item a item.
- **Mobile hoje:** A fila REAL vive no Kotlin e o plugin nao expoe leitura nem mutacao: a tela Queue desenha um espelho persistido em localStorage e so oferece skip_to_index. O proprio arquivo documenta 'Sem reordenar: nao ha command para isso'.
- **Por que importa:** 'Tocar em seguida' e a acao mais frequente de uso mobile. E o espelho ainda tem um estado degradado real (app reiniciou, servico seguiu tocando -> 'Fila indisponivel'), que so some com leitura nativa da fila.
- **Risco/restricao:** Exige commands NOVOS no plugin Kotlin (get_queue, insert_at, move, remove) — cada um obrigatoriamente `async fn` com AppHandle<R>, sob pena de deadlock da main thread. E preciso decidir quem e a verdade: hoje e o servico, e leitura+mutacao concorrente com auto-advance e onde nascem bugs de indice.
- **Ancoras desktop:** `src/store/player.ts:183`, `src/store/player.ts:251`, `src/components/TrackContextMenu.tsx:136`
- **Ancoras mobile:** `src/mobile/screens/Queue.tsx:10`, `src/mobile/screens/Queue.tsx:49`, `src/mobile/ipc.ts:45`

---

## Epic B — Continuidade: a musica nunca para

Autoplay no fim da fila, top-up de station antes de secar, reacao a skip. Hoje o som acaba e o app nao percebe.


### `cobertura-vetores-parcial` — Faixa sem vetor é invisível pro motor local e não avisa · **XS**
*(dimensao: inteligencia)*

- **Desktop:** Quando o recommend falha ou não cobre, há fallback em camadas (recommend simples → shuffle) — sempre devolve algo.
- **Mobile hoje:** similar_tracks devolve lista VAZIA se a track não tem linha no vectors.bin (ou se vectors.bin não existe), e o store só mostra o toast 'Sem vetores no aparelho — rode o export'. rank_pool sem vetores cai pra ordem do pool, silenciosamente.
- **Por que importa:** Faixa nova do Crate ainda sem MERT no Qdrant simplesmente não tem rádio no celular, com uma mensagem que sugere erro de configuração global. Falta o fallback de shuffle/mesmo artista que o desktop tem.
- **Risco/restricao:** Trivial: fallback local por artista/álbum/pasta + shuffle. O cuidado é não mascarar o problema real de cobertura (o toast atual, apesar de rude, é informativo).
- **Ancoras desktop:** `src-tauri/src/desktop.rs:596-614 (Layer 3: shuffle fallback)`
- **Ancoras mobile:** `src-tauri/src/mobile_library.rs:309-317 (similar_tracks → Vec::new())`, `src/mobile/store.ts:236-241 (toast genérico)`, `src-tauri/src/mobile_intel.rs:217 (rank_pool sem vetores preserva ordem)`

### `exclude-recently-played` — Exclusão do que acabou de tocar (recently played) no ranking · **XS**
*(dimensao: inteligencia)*

- **Desktop:** Toda chamada de autoplay/rádio passa recentlyPlayed() como exclude_ids (filtro duro must_not), e o conjunto é REPOPULADO no restore de sessão para não sugerir na sessão seguinte o que se ouviu na anterior.
- **Mobile hoje:** station_batch aceita exclude, mas o store mobile nunca passa nada em lib_station_next (o command existe e não é chamado em lugar nenhum de src/mobile/); não há memória de 'ouvido recentemente' entre sessões.
- **Por que importa:** Repetição percebida é o defeito nº1 de rádio. No celular, tocar a mesma station duas vezes no mesmo dia tende a devolver o mesmo topo do pool (só o sorteio ponderado r=0.7 dá variedade).
- **Risco/restricao:** Baixo; o parâmetro já existe nas duas pontas. Precisa de um conjunto persistido (localStorage ou arquivo) com TTL, senão cresce e passa a excluir o acervo inteiro.
- **Depende de:** historico-play-count-mobile
- **Ancoras desktop:** `src/components/PlayerBar.tsx:271 (recentlyPlayed() no autoplay)`, `src/components/PlayerBar.tsx:222 (repopula recently no restore)`
- **Ancoras mobile:** `src/mobile/ipc.ts:36 (libStationNext exportado, sem caller)`, `src-tauri/src/mobile_library.rs:326-350 (station_batch com exclude)`, `src/mobile/store.ts:218 (playStation — lote único de 40, sem exclude)`

### `context-id-similar` — context_id do rádio de faixa não tem par no desktop · **XS**
*(dimensao: inteligencia)*

- **Desktop:** context_id de station é o id da station (arquivo persistido), rastreável na análise.
- **Mobile hoje:** playSimilar usa contextId `similar:<track_id>` com origin 'station' — um namespace que NÃO existe no desktop. Os eventos chegam ao Qdrant com um context_id que nenhuma ferramenta de análise reconhece.
- **Por que importa:** Detalhe pequeno que suja a análise: 'station' vira um bucket que mistura stations reais e rádios efêmeros de faixa, e o desktop não consegue reconstruir o que foi ouvido.
- **Risco/restricao:** Nenhum técnico — é convenção. Ou o desktop passa a reconhecer o prefixo (e ganha o mesmo gesto), ou o mobile usa origin 'autoplay' pra rádio de faixa, que é semanticamente mais correto (é sugestão da máquina, não station curada).
- **Ancoras desktop:** `src/components/PlayerBar.tsx:704 (contContextId — id da station)`, `src-tauri/src/desktop.rs:1445 (log_event estampa por cima)`
- **Ancoras mobile:** `src/mobile/store.ts:243 (playList(similar, 0, 'station', `similar:${track.id}`))`

### `gapless-preload` — Preload gapless da proxima faixa · **S**
*(dimensao: playback)*

- **Desktop:** No TrackStarted o frontend ja empurra o path seguinte pro engine (player_enqueue_next → EngineCommand::EnqueueNext), repeat-aware, pra o EOS emendar sem silencio.
- **Mobile hoje:** Paridade PARCIAL por outro caminho: a fila nativa do ExoPlayer prepara o proximo item sozinha, o que cobre o caso comum. Mas nao ha gapless real entre faixas (ExoPlayer so faz gapless de verdade em containers compativeis) e nao ha preload quando a proxima faixa ainda vai ser DECIDIDA (autoplay).
- **Por que importa:** Album ao vivo/DJ set com faixas emendadas soa quebrado, e no cenario radio o gap fica audivel.
- **Risco/restricao:** Gapless verdadeiro no ExoPlayer depende do formato e de setEnableDecoderFallback/skipSilence — nao e um switch. Nao prometer o que o Media3 nao entrega.
- **Depende de:** autoplay-end-of-queue
- **Ancoras desktop:** `src/components/PlayerBar.tsx:105`, `src-tauri/src/desktop.rs:2017`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt:148`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt:73`

### `origin-fila-vs-faixa` — Origin é por FILA no mobile, por FAIXA no desktop · **S**
*(dimensao: inteligencia)*

- **Desktop:** Cada faixa é tocada com um origin resolvido no momento (contOrigin mapeia radio→autoplay, station→station, playlist→playlist; repeat-one loga 'repeat'; player_set_origin permite corrigir em voo). album_seq é deliberadamente excluído dos sinais.
- **Mobile hoje:** QueueMeta guarda um origin ÚNICO para a fila inteira, fixado no set_queue; todo evento daquela fila sai com ele. Não há 'repeat', não há transição para 'autoplay' quando a fila vira rádio, e o shuffle de biblioteca inteira vira origin 'shuffle' — que não é nenhuma das categorias que o v3 conhece (nem passiva, nem excluída).
- **Por que importa:** Origin é o que dá peso ao evento: passivo desconta 0.6, album_seq é ignorado. Um origin fora do vocabulário ('shuffle') entra com peso CHEIO no saldo — o mobile está hoje sobre-pesando escuta passiva de shuffle geral em relação ao desktop.
- **Risco/restricao:** Mexer no vocabulário de origins muda a semântica dos sinais → exige bump de SIGNAL_SCHEMA (hoje 3, espelhado em mobile_sync.rs:24 e export_manifest.py:59). Decidir se 'shuffle' é passivo é decisão de produto do CEO, não técnica.
- **Ancoras desktop:** `src/components/PlayerBar.tsx:684 (contOrigin)`, `src-tauri/src/desktop.rs:1494 (player_set_origin)`, `src-tauri/crates/library-indexer/src/qdrant_client.rs:1889-1895 (PASSIVE_ORIGINS/PASSIVE_WEIGHT)`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/QueueMeta.kt:16-27 (origin único por fila)`, `src/mobile/store.ts:212-216 (playTrackFrom/playFolder/playAlbum/shuffleList/shuffleAll → origins fixos, inclui 'shuffle')`

### `origin-autoplay-mobile` — Origin 'autoplay' e 'repeat' nunca são emitidos pelo S24 · **S**
*(dimensao: inteligencia)*

- **Desktop:** Continuações de rádio logam 'autoplay'; repeat-one loga 'repeat' (sinal positivo pleno e deliberado).
- **Mobile hoje:** Impossível: não há autoplay nem repeat no plugin (NowPlaying mobile: 'shuffle/repeat saíram: o plugin não tem command'). O breakdown por device na régua nunca verá esses origins vindos do s24.
- **Por que importa:** Distorce a medição: comparar skip-rate por origin entre devices fica enviesado, e o CEO usa exatamente esse corte na régua diária.
- **Risco/restricao:** Depende de autoplay e de repeat existirem primeiro; repeat exige command novo no plugin (async fn + AppHandle<R>) mapeando REPEAT_MODE_ONE do ExoPlayer — mas o evento precisa continuar sendo emitido por repetição (auto-advance nativo não pode engolir o flushCurrent).
- **Depende de:** autoplay-fim-de-fila
- **Ancoras desktop:** `src/components/PlayerBar.tsx:128-131 (repeat one → origin 'repeat')`, `src/components/PlayerBar.tsx:279 (playTrack(next,'autoplay'))`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/README.md (contrato de commands — sem repeat/shuffle)`, `docs/metrics/regua-latest.md (breakdown por device)`

### `station-topup` — Station mobile morre no fim do lote: lib_station_next existe e nunca é chamado · **S** _[WRONG_ANCHORS]_
*(dimensao: telas)*

- **Desktop:** A station é uma SESSÃO: o PlayerBar faz top-up incremental perto do fim da fila e logo após um skip cedo, passando excludeIds (já vistas) e sessionNegativeIds (as puladas) para o re-rank — src/tauri.ts:433-447.
- **Mobile hoje:** playStation pede um lote de 40 e acabou (src/mobile/store.ts:220-232). O binding libStationNext está declarado em src/mobile/ipc.ts:35 mas NINGUÉM o chama (verificado por grep em src/mobile/) — ou seja, o trilho está pronto e desligado.
- **Por que importa:** É o gap com maior retorno por linha de código do inventário: rádio que para depois de 40 faixas parece quebrado, e o desktop já provou a mecânica. O command mobile lib_station_next já existe no backend (src-tauri/src/mobile.rs:71-84).
- **Risco/restricao:** Sem command de append, o top-up teria que refazer set_queue com playNow:false e índice atual — dá pra fazer, mas se o índice divergir do serviço a faixa corrente reinicia. Esse é o caminho a testar antes de mexer no Kotlin.
- **Depende de:** enqueue-commands (para anexar sem reiniciar a reprodução)
- **Ancoras desktop:** `src/tauri.ts:433`, `src/components/PlayerBar.tsx:271`
- **Ancoras mobile:** `src/mobile/ipc.ts:35`, `src/mobile/store.ts:220`, `src-tauri/src/mobile.rs:71`
- **Veredito do cetico:** Gap real e pior do que descrito, mas a ancora desktop PlayerBar.tsx:271 esta errada — 271 e doAutoplay (radio por autoplay). O top-up de station e topUpStation em src/components/PlayerBar.tsx:718, chamado em :141 (fim de fila) e :757. tauri.ts:433 esta certo. Confirmei que libStationNext so aparece em src/mobile/ipc.ts:35 e nao e chamado por ninguem. Agravante nao citado: a assinatura mobile e mais pobre — src-tauri/src/mobile.rs:72-77 aceita so (station_id, exclude_ids, limit), sem sessionNegativeIds (tauri.ts:433-445), entao mesmo ligando o trilho o re-rank do aparelho ignoraria as puladas da rodada.

### `station-session-reaction` — Reacao a skip dentro de station (truncar a cauda e re-pedir lote) · **M**
*(dimensao: playback)*

- **Desktop:** reactToStationSkip registra rejeicao se o skip foi cedo, TRUNCA a cauda ainda nao tocada da fila e dispara topUpStation imediatamente — a station reage ao que voce rejeitou dentro da propria sessao.
- **Mobile hoje:** Nao existe. O skip so vira uma linha track_skipped no journal, que so influencia o gosto DEPOIS de sincronizar e re-derivar behavioral_signals no desktop.
- **Por que importa:** E a diferenca entre uma radio que 'te ouve agora' e uma playlist fixa. No celular, que e onde o skip acontece, a reatividade e zero.
- **Risco/restricao:** O lib_station_next mobile aceita excludeIds mas nao skippedIds (assinatura diferente do desktop: mobile.rs:72 vs desktop.rs:3838) — a penalizacao por rejeicao nao tem onde entrar hoje.
- **Depende de:** autoplay-end-of-queue, plugin-queue-read
- **Ancoras desktop:** `src/components/PlayerBar.tsx:747`, `src/components/PlayerBar.tsx:718`, `src-tauri/src/desktop.rs:3838`
- **Ancoras mobile:** `src/mobile/store.ts:262`, `src/mobile/ipc.ts:35`

### `autoplay-fim-de-fila` — Autoplay contínuo quando a fila acaba · **M**
*(dimensao: inteligencia)*

- **Desktop:** Ao terminar a última faixa sem próximo item, o desktop chama doAutoplay(seed) → lib_autoplay_next com lookahead 1 (recalcula a cada faixa), anexa a track à fila, marca queueSource kind=radio e toca com origin 'autoplay'. A música NUNCA para.
- **Mobile hoje:** Nada. A fila nativa Kotlin termina e o player para (ExoPlayer sem próximo item). Não existe command de autoplay no mobile.rs (11 commands: nenhum autoplay_next) nem listener de 'fila quase no fim' no store mobile.
- **Por que importa:** É a diferença entre um player de arquivo e um app de música: no S24 o som simplesmente acaba. O usuário tem que voltar no app e escolher algo. Todo o resto do motor local (vetores, taste, stations) já existe no aparelho e não é usado nesse momento.
- **Risco/restricao:** A fila é NATIVA (Kotlin): o JS não é notificado de forma confiável quando a fila seca com a tela apagada/WebView suspenso. Fazer autoplay no JS só funciona com o app em foreground. O caminho robusto é o plugin pedir mais itens (callback nativo → command async) ou o JS pré-abastecer sempre (ver autoplay-topup-fila).
- **Depende de:** autoplay-topup-fila, origin-autoplay-mobile
- **Ancoras desktop:** `src-tauri/src/desktop.rs:468 (lib_autoplay_next)`, `src/components/PlayerBar.tsx:265 (doAutoplay, lookahead 1)`, `src/components/PlayerBar.tsx:159 (TrackEnded → doAutoplay quando advanceQueue devolve null)`
- **Ancoras mobile:** `src-tauri/src/mobile.rs:140 (generate_handler — sem lib_autoplay_next)`, `src/mobile/store.ts:266 (next(); sem tratamento de fim de fila)`, `src-tauri/src/mobile_library.rs:309 (similar_tracks — base pronta pro autoplay local)`

### `autoplay-topup-fila` — Top-up da fila antes de secar (radio prefetch) · **M**
*(dimensao: inteligencia)*

- **Desktop:** Quando o índice chega às 2 últimas posições de uma fila radio, prefetchRadio(seed) anexa 1 faixa nova, mantendo a fila sempre com lookahead 1 e sem gap de roundtrip no fim.
- **Mobile hoje:** Inexistente. set_queue é one-shot; a fila mobile é fixa desde o play (playList → ipc.playerSetQueue).
- **Por que importa:** Sem top-up, mesmo com autoplay implementado haveria pausa audível/parada no fim. E é o que permite ao motor reagir ao que acabou de tocar (seed sempre atual) em vez de pré-computar 20 faixas envelhecidas.
- **Risco/restricao:** O plugin Kotlin não tem 'append_to_queue' — hoje só set_queue substitui tudo (README do crate é o contrato). Re-setar a fila inteira no meio da reprodução arrisca reinício da faixa corrente/perda de posição. Precisa de command novo (async fn + AppHandle<R>) que faça addMediaItems no ExoPlayer sem tocar no item corrente.
- **Depende de:** autoplay-fim-de-fila
- **Ancoras desktop:** `src/components/PlayerBar.tsx:290 (prefetchRadio)`, `src/components/PlayerBar.tsx:140-152 (gatilho queueIndex >= length-2)`
- **Ancoras mobile:** `src/mobile/store.ts:176 (playList — único caminho de set_queue)`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt:135 (set_queue substitui a fila inteira)`

### `autoplay-qualidade-pool-duplo` — Qualidade do autoplay: pool duplo (seed + gosto) e re-rank híbrido por vibe · **M**
*(dimensao: inteligencia)*

- **Desktop:** lib_autoplay_next monta DOIS pools no Qdrant (vizinhança pura do seed + gosto global com best_score, ambos com negatives e exclude duro), une, re-rankeia pela vibe do seed (energy/valence/mood_tags/genre via get_enrichments_batch), aplica cap de 2 por artista e sorteio ponderado r=0.7 no topo. Tem fallback em 3 camadas (recommend simples → shuffle).
- **Mobile hoje:** O equivalente mais próximo é lib_similar_tracks: cosine brute-force puro contra UM seed, sem negatives, sem gosto global, sem vibe, sem cap por artista, sem sorteio ponderado. Só é usado no 'Rádio da faixa' manual (playSimilar).
- **Por que importa:** Rádio de faixa no celular vira 'mais do mesmo artista/álbum' — MERT puro agrupa por timbre/produção. O desktop resolve exatamente isso com o cap por artista e o re-rank de vibe; a diferença é perceptível em 3 faixas.
- **Risco/restricao:** cap por artista e negatives são baratos e portáveis; o re-rank de vibe NÃO é: energy/valence/mood_tags não estão no manifest exportado (ver gap enrichments-vibe-nao-exportados). Sem eles, portar só metade do algoritmo pode piorar a percepção (variedade sem coerência).
- **Depende de:** enrichments-vibe-nao-exportados, autoplay-fim-de-fila
- **Ancoras desktop:** `src-tauri/src/desktop.rs:500-575 (pool duplo + retry sem negatives)`, `src-tauri/src/desktop.rs:416 (rerank_by_seed_vibe_pools)`, `src-tauri/src/desktop.rs:3419 (weighted_pick_prefix)`
- **Ancoras mobile:** `src-tauri/src/mobile_library.rs:309 (similar_tracks — cosine cru, exclude vazio)`, `src-tauri/src/mobile_intel.rs:214 (rank_pool — existe, mas só é usado por station_batch)`, `src/mobile/store.ts:234 (playSimilar)`

### `station-session-negatives` — Reação ao skip dentro da station (negativos de sessão, Fase 3) · **M**
*(dimensao: inteligencia)*

- **Desktop:** Skip numa station dispara reactToStationSkip e o topup seguinte manda session_negative_ids pro lib_station_next, que os usa como negatives no recommend — a station se AFASTA na hora do que você acabou de rejeitar.
- **Mobile hoje:** lib_station_next mobile aceita só station_id/exclude_ids/limit. Não há conceito de negativo de sessão; skip só remove a faixa da fila. E nem existe top-up de station no mobile (a fila é o lote inicial de 40).
- **Por que importa:** É a micro-interação que faz a station parecer viva: skipar duas faixas seguidas de um mesmo clima muda o rumo. No celular, skipar não muda nada.
- **Risco/restricao:** Baixo tecnicamente (rank_pool já subtrai negatives; basta juntar taste.negatives + sessão). O dificil é o gatilho: o skip acontece no Kotlin (AudioService flushCurrent 'track_skipped'), o JS só descobre pelo evento de troca de faixa e não sabe se foi natural ou skip — o journal sabe, a UI não.
- **Depende de:** autoplay-topup-fila
- **Ancoras desktop:** `src-tauri/src/desktop.rs:3838-3866 (lib_station_next com session_negative_ids + seed_counts)`, `src/components/PlayerBar.tsx:171 (reactToStationSkip no skip)`
- **Ancoras mobile:** `src-tauri/src/mobile.rs:71-84 (lib_station_next sem negativos)`, `src-tauri/src/mobile_intel.rs:214 (rank_pool aceitaria negativos extras trivialmente)`

### `pool-station-congelado` — Pool de station é congelado no export e não vê faixas novas · **M**
*(dimensao: inteligencia)*

- **Desktop:** generate_station_tracks/generate_station_batch consultam o Qdrant a cada play — faixa indexada hoje já pode entrar na station hoje.
- **Mobile hoje:** O pool vem pré-computado em stations.json. Faixa nova sincada pro celular entra na biblioteca (lib_rescan resolve por stem) mas JAMAIS aparece em nenhuma station até o próximo export.
- **Por que importa:** Contraria a expectativa direta: 'baixei, mandei pro celular, e a station não toca'. E o pool_size exibido na UI passa a mentir sobre o acervo real.
- **Risco/restricao:** Gerar pool no aparelho para stations SEED é viável com vectors.bin (é recommend por seed). Para MOOD não é (precisa dos enrichments). Solução híbrida: seed dinâmica local, mood permanece pré-computada — mas aí duas stations se comportam diferente e isso precisa ficar visível.
- **Depende de:** enrichments-vibe-nao-exportados
- **Ancoras desktop:** `src-tauri/src/desktop.rs:3546 (generate_station_tracks ao vivo)`, `src-tauri/src/desktop.rs:3560 (generate_station_batch)`
- **Ancoras mobile:** `scripts/android/export_manifest.py:401-426 (build_stations pré-computa)`, `src-tauri/src/mobile_library.rs:326 (station_batch só filtra o pool exportado)`

### `autoplay-end-of-queue` — Autoplay continuo no fim da fila (a musica nunca acaba) · **L**
*(dimensao: playback)*

- **Desktop:** Quando a fila esgota, doAutoplay() busca lib_autoplay_next com lookahead 1, usando a ultima faixa como seed e excluindo as 30 recentes; a fila vira proveniencia 'radio' e as continuacoes logam origin 'autoplay'. Ha ainda prefetchRadio/topUpStation que abastecem ANTES de secar (2 posicoes de folga) pra nao existir gap.
- **Mobile hoje:** O ExoPlayer chega a STATE_ENDED, o service flusha track_ended e PARA. Nao ha reabastecimento: nem autoplay generico, nem top-up de station (lib_station_next existe no backend e esta exposto no ipc.ts, mas NINGUEM chama).
- **Por que importa:** Para de tocar sozinho no meio do uso — no celular (tela apagada, bolso) e o pior tipo de falha. E o gap mais visivel desta dimensao.
- **Risco/restricao:** O WebView dorme: quem decide o proximo lote precisa acordar. Ou o JS faz top-up preventivo enquanto esta vivo (parcial), ou o lote e calculado no Rust e empurrado pro plugin — mas o motor de station/similar vive em mobile_intel.rs, do lado Rust, entao da pra fazer sem JS.
- **Depende de:** plugin-queue-read, wake-webview-topup
- **Ancoras desktop:** `src/components/PlayerBar.tsx:265`, `src/components/PlayerBar.tsx:140`, `src/components/PlayerBar.tsx:290`, `src-tauri/src/desktop.rs:468`
- **Ancoras mobile:** `src/mobile/store.ts:262`, `src/mobile/ipc.ts:35`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt:167`

### `wake-webview-topup` — Reabastecimento com o WebView suspenso · **L**
*(dimensao: playback)*

- **Desktop:** Nao aplicavel do mesmo jeito (o frontend nunca dorme); o desktop faz todo o orquestramento de fila no JS.
- **Mobile hoje:** Todo o cerebro de fila esta no JS, que o Android suspende. O store so reconcilia quando o app volta ao foco (visibilitychange/focus).
- **Por que importa:** Sem um caminho nativo, qualquer feature de continuidade (autoplay, top-up, radio) so funciona com o app aberto na tela — ou seja, nao funciona.
- **Risco/restricao:** Exige mover a decisao de 'proxima faixa' pro Rust/Kotlin (chamar mobile_intel do service, ou um listener no plugin que pede ao Rust). Muda a arquitetura declarada do v0 ('a fila vive no Kotlin, a UI so reflete').
- **Ancoras desktop:** `src/components/PlayerBar.tsx:255`
- **Ancoras mobile:** `src/mobile/store.ts:379`, `src-tauri/src/mobile_intel.rs:1`, `src-tauri/src/mobile.rs:72`

---

## Epic C — Loop de gosto fechado (like + sync bidirecional)

O celular contribui sinal e nunca recebe de volta. Like nao existe. O taste snapshot congela no dia do export.


### `aversion-negatives-visiveis` — Aversion list / negatives não são visíveis nem editáveis em nenhum dos dois · **XS** _[OVERSTATED]_
*(dimensao: inteligencia)*

- **Desktop:** negatives derivados entram como filtro no recommend, mas não há UI (CMR-179 rastreia 'aversion list' como deferido).
- **Mobile hoje:** taste.negatives é consumido silenciosamente por rank_pool (que EXCLUI, não só penaliza — divergência deliberada do desktop, documentada em mobile_intel.rs:210).
- **Por que importa:** É uma divergência de comportamento real entre plataformas que ninguém consegue observar: no celular a faixa some do pool, no desktop ela só desce. Se o saldo bater negativo por engano (skit, faixa curta), o celular a torna inalcançável por station e não há como saber por quê.
- **Risco/restricao:** Não é bug — é decisão registrada (pool pequeno no aparelho). O gap é de OBSERVABILIDADE: nada na UI mobile diz 'X faixas suprimidas pelo seu gosto'. Baixo risco de implementar, alto valor de confiança.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:512 (negatives no recommend, penalização)`, `src-tauri/crates/library-indexer/src/qdrant_client.rs:1923-1937`
- **Ancoras mobile:** `src-tauri/src/mobile_intel.rs:206-216 (rank_pool exclui negatives)`
- **Veredito do cetico:** Nao e gap mobile-vs-desktop: o proprio item admite que o desktop tambem nao tem UI (CMR-179 deferido) — logo e paridade por ausencia nos dois. O unico fato real e a DIVERGENCIA de semantica, e ela e deliberada e documentada: rank_pool exclui negatives (mobile_intel.rs:209-216) enquanto o desktop os passa como negatives ao recommend (desktop.rs:512).

### `weight-ignorado-no-rank` — Pesos do gosto são ignorados no ranking local · **XS**
*(dimensao: inteligencia)*

- **Desktop:** Positives entram no recommend com strategy best_score e a ORDEM importa (rank por saldo líquido); likes recentes entram como positives extras.
- **Mobile hoje:** rank_pool trata todos os positives como iguais (max cos sobre a lista) e taste_positive_tracks devolve na ordem do snapshot sem nenhum peso; o campo weight é parseado e descartado.
- **Por que importa:** A faixa que você ouviu 40 vezes puxa o mesmo que a que você ouviu uma vez e meia. É meia linha de código para o ranking respeitar a intensidade que o desktop já mediu e exportou.
- **Risco/restricao:** Cuidado: likes explícitos são exportados com weight null (export_manifest.py:275 'like explícito, sem saldo derivado'). Um rank ponderado precisa de política para o null — tratá-lo como 0 rebaixaria justamente os likes.
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/qdrant_client.rs:1909-1921 (rank por net)`, `src-tauri/src/desktop.rs:505-508 (positives ordenados no recommend)`
- **Ancoras mobile:** `src-tauri/src/mobile_intel.rs:105-110 (TasteEntry.weight com #[allow(dead_code)])`, `src-tauri/src/mobile_intel.rs:220-235 (rank_pool: best(&taste.positives) sem peso)`

### `station-stats` — Estatística de station (played, last_played_at) · **S**
*(dimensao: inteligencia)*

- **Desktop:** lib_play_station incrementa stats.played e grava last_played_at no JSON da station, alimentando ordenação/exibição.
- **Mobile hoje:** lib_play_station mobile não escreve nada (comentário explícito: 'stats de played ficam no desktop'), e nenhuma station tocada no celular conta em lugar nenhum — o export a sobrescreve.
- **Por que importa:** Detalhe pequeno com efeito acumulado: a ordenação de stations por uso e o 'ouvida pela última vez há X' nunca refletem o aparelho onde a maior parte da escuta acontece.
- **Risco/restricao:** Dado derivável: os play_events sincados já carregam context_id = station id e origin 'station'. Em vez de sincar stats, o desktop pode recomputá-las do play_events — paridade por outro caminho, mais barata.
- **Depende de:** sync-bidirecional
- **Ancoras desktop:** `src-tauri/src/desktop.rs:3810-3830 (stats.played += 1; write_station)`
- **Ancoras mobile:** `src-tauri/src/mobile.rs:62-70 (lib_play_station sem stats)`

### `regua-cobertura-mobile` — Régua/observabilidade do sinal não cobre o estado do aparelho · **S**
*(dimensao: inteligencia)*

- **Desktop:** A régua diária (systemd timer) mede cobertura MERT/letra/vibe e faz breakdown por device, injetada em toda sessão via hook.
- **Mobile hoje:** Mede os eventos que CHEGAM do s24, mas nada sobre o estado do celular: quantas faixas do manifest têm vetor, quantas têm .lrc, qual a idade dos artefatos, quantos eventos estão presos no journal sem sync.
- **Por que importa:** Se a tailnet cair ou o desktop ficar fechado uma semana, os eventos acumulam no journal e ninguém percebe — a régua só veria 'menos eventos do s24', indistinguível de 'ouviu menos'.
- **Risco/restricao:** Baixo. Um bloco 'Sinal' em Settings (idade do taste, eventos pendentes, último sync OK, % com vetor) é leitura de estado que já existe em memória.
- **Depende de:** taste-snapshot-stale
- **Ancoras desktop:** `scripts/metrics/autoplay_regua.py (cobertura + breakdown por device)`, `docs/metrics/regua-latest.md`
- **Ancoras mobile:** `src-tauri/src/mobile_sync.rs:160-170 (log do lote; sem métrica exposta)`, `src/mobile/screens/Settings.tsx:26-30 (stats só de contagem de faixas)`

### `decay-taste-no-aparelho` — Snapshot de gosto não decai no aparelho · **S**
*(dimensao: inteligencia)*

- **Desktop:** O decay de meia-vida 14d é aplicado no momento da derivação com now corrente — o gosto envelhece continuamente.
- **Mobile hoje:** taste.json congela positives/negatives com o now do export. Passadas 3 semanas sem export, o aparelho aplica um gosto com pesos que o desktop já teria reduzido pela metade, e a lista de negatives continua excluindo faixas cujo skip único já deveria ter expirado.
- **Por que importa:** É o efeito mais insidioso do stale: não é 'faltam dados novos', é 'dados velhos com peso de novo'. Faixas banidas por um skip acidental ficam banidas no celular indefinidamente.
- **Risco/restricao:** O weight JÁ é exportado e o parser mobile o IGNORA (#[allow(dead_code)]). Aplicar decay local sobre generated_at é barato e não precisa de rede — mas exige que o rank use weight, o que hoje não acontece em lugar nenhum.
- **Depende de:** taste-snapshot-stale
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/qdrant_client.rs:1870-1871 (decay por age_days a cada derivação)`, `src-tauri/crates/library-indexer/src/qdrant_client.rs:1923-1924 (skip único expira sozinho)`
- **Ancoras mobile:** `scripts/android/export_manifest.py:290-300 (now fixo no export)`, `src-tauri/src/mobile_intel.rs:130-140 (Taste::parse descarta o weight — campo lido e marcado dead_code)`

### `notification-controls` — Controles ricos na notificacao/lockscreen (like, shuffle, repeat, seek) · **M**
*(dimensao: playback)*

- **Desktop:** MPRIS via souvlaki com metadata completa (set_metadata), estado Playing/Paused/Stopped e comandos Play/Pause/Toggle/Stop/Next/Previous roteados de volta pro frontend, que reage inclusive com skip de sessao de station.
- **Mobile hoje:** Paridade PARCIAL: o MediaSession do Media3 da notificacao, lockscreen, capa e prev/play/next de graca (AudioService com MediaSessionService). Faltam: botao de like na notificacao, toggles de shuffle/repeat, e nao ha customizacao de comandos (setCustomLayout).
- **Por que importa:** No celular a notificacao E a interface na maior parte do tempo. Like na notificacao alimenta o motor de sinal sem abrir o app.
- **Risco/restricao:** setCustomLayout no Media3 1.10 e estavel, mas cada botao custom precisa de um caminho ate o dado (like precisa do trilho de enrichment, que nao existe no mobile).
- **Depende de:** like-trilho
- **Ancoras desktop:** `src-tauri/src/desktop.rs:3136`, `src-tauri/src/desktop.rs:3195`, `src/components/PlayerBar.tsx:165`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt:94`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt:108`

### `like-trilho` — Like da faixa tocando · **M**
*(dimensao: playback)*

- **Desktop:** Botao de coracao na PlayerBar com estado carregado por faixa (lib_is_liked) e toggle (lib_toggle_like), que alimenta os positives do behavioral_signals.
- **Mobile hoje:** Inexistente — o comentario do NowPlaying mobile diz literalmente 'sem coracao (nao ha trilho de like)'. Nenhum command de like em mobile.rs.
- **Por que importa:** Like e o sinal explicito mais forte do motor e o celular e onde a escuta acontece. Hoje toda a intencao explicita do usuario no aparelho e perdida.
- **Risco/restricao:** Nao ha Qdrant no aparelho: o like teria que virar um evento no journal (ou um segundo journal) e subir pelo sync_receiver — que hoje so aceita play_events (src/sync_receiver.rs). Idempotencia por uuid ja e o padrao, da pra reaproveitar.
- **Ancoras desktop:** `src/components/PlayerBar.tsx:396`, `src/components/PlayerBar.tsx:480`, `src-tauri/src/desktop.rs:728`
- **Ancoras mobile:** `src-tauri/src/mobile.rs:143`, `src-tauri/src/mobile_sync.rs:1`

### `lib-sem-like` — Sem like/favorito no celular · **M**
*(dimensao: biblioteca)*

- **Desktop:** `lib_toggle_like`/`lib_is_liked`/`lib_list_liked` com liked_at no enrichment; botao de coracao no PlayerBar (com pre-fetch do estado ao trocar de faixa) e item no menu de contexto.
- **Mobile hoje:** Nao existe: o NowPlaying mobile documenta 'sem coracao (nao ha trilho de like)'. `favorites()` na Home e o taste snapshot exportado, read-only — o usuario nao consegue marcar nada.
- **Por que importa:** Like e o unico sinal EXPLICITO que o motor de gosto consome (positives top-10 vem dos likes). Nao poder curtir no aparelho onde se escuta amputa a melhor fonte de sinal.
- **Risco/restricao:** Like precisa ser um evento sincavel (como play_event) com `liked_device`, senao vira estado local que o proximo export sobrescreve. Sem isso, o usuario curte e o like some no proximo sync — pior que nao ter.
- **Depende de:** lib-sync-incremental
- **Ancoras desktop:** `src-tauri/src/desktop.rs:727`, `src/components/PlayerBar.tsx:399`, `src/components/TrackContextMenu.tsx:144`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:10`, `src/mobile/screens/Home.tsx:76`

### `taste-snapshot-stale` — Taste snapshot no celular fica stale indefinidamente · **M**
*(dimensao: inteligencia)*

- **Desktop:** behavioral_signals() é derivado AO VIVO a cada autoplay/station a partir do play_events do Qdrant — reflete o que foi ouvido há 5 minutos.
- **Mobile hoje:** taste.json é gerado por execução MANUAL de export_manifest.py na VM (+ scp pro staging + adb push + lib_rescan no app). Não há job agendado, nem versão/idade exibida no app, nem refresh automático. Os eventos do S24 sobem a cada 60s pro desktop, mas o gosto derivado deles só volta ao celular quando um humano roda o export.
- **Por que importa:** O loop de aprendizado está aberto no celular: você pode ouvir uma semana no S24 e as stations/favoritos do aparelho continuam refletindo o gosto de 14/08. Pior: o usuário não tem como saber — não há timestamp de 'gerado em' na UI.
- **Risco/restricao:** Automatizar por completo exige pull do celular (o S24 não alcança a VM por HTTP sem TLS? alcança pela tailnet, mesmo canal do sync) OU inverter: o desktop derivar e POSTar. Mínimo viável barato: exibir taste.generated_at/stations.generated_at em Settings e avisar quando > 7 dias.
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/qdrant_client.rs:1849 (derive_behavioral_signals ao vivo)`, `src-tauri/src/desktop.rs:503 (behavioral_signals a cada autoplay)`
- **Ancoras mobile:** `scripts/android/export_manifest.py:281-306 (build_taste; só roda por invocação manual)`, `scripts/android/export_manifest.py:497 (deploy_artifacts via scp)`, `src-tauri/src/mobile_library.rs:161 (load dos artefatos, sem checagem de idade)`, `src/mobile/screens/Settings.tsx:25 (stats da lib — sem 'artefatos gerados em')`

### `likes-inexistentes-mobile` — Like (coração) não existe no mobile — nem UI, nem sync · **M**
*(dimensao: inteligencia)*

- **Desktop:** lib_toggle_like grava liked_at em track_enrichments (com liked_device), lib_is_liked/lib_list_liked leem; likes recentes entram como positives EXTRA no behavioral_signals (até MAX_TOTAL_POSITIVES) e semeiam o rail 'Based on your favorites'.
- **Mobile hoje:** Nenhum command de like no mobile.rs; o NowPlaying mobile declara explicitamente 'sem coração (não há trilho de like)'; o sync só carrega play_events. Likes fluem 100% desktop→celular (via taste.json), nunca celular→desktop.
- **Por que importa:** É o único sinal EXPLÍCITO do usuário e o mais barato de coletar exatamente no momento em que ele sente — fone no ouvido, no celular. Hoje esse gesto se perde. Também impede qualquer tela de 'Curtidas' no aparelho.
- **Risco/restricao:** Like é ESTADO, não evento append-only: precisa de reconciliação (like no celular + unlike no desktop). Sem conexão o estado local diverge. O caminho mais seguro é logar como evento com timestamp ('liked'/'unliked' + device) e deixar o last-write-wins no desktop — reaproveita o canal e a idempotência por UUID que já existem.
- **Depende de:** sync-bidirecional
- **Ancoras desktop:** `src-tauri/src/desktop.rs:728 (lib_toggle_like)`, `src-tauri/src/desktop.rs:733 (lib_list_liked)`, `src-tauri/src/desktop.rs:744 (lib_is_liked)`, `src-tauri/crates/library-indexer/src/query.rs:582 (liked_at semeia based_on_top)`, `src/components/PlayerBar.tsx:399 (toggle no player)`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:10 (decisão registrada: sem coração)`, `src-tauri/src/mobile_sync.rs:31 (JournalEvent — só eventos de playback)`, `src-tauri/src/sync_receiver.rs:135 (insert_synced_event — só play_events)`

### `sync-bidirecional` — Sync é unidirecional (celular → desktop) e só de play_events · **M**
*(dimensao: inteligencia)*

- **Desktop:** O receptor (sync_receiver.rs, bind no IP tailscale :19878) aceita lotes e faz upsert idempotente por UUID no play_events. Não há rota de leitura: o desktop nunca DEVOLVE nada ao celular.
- **Mobile hoje:** O worker mobile só faz POST /sync/events a cada 60s. Não busca taste atualizado, nem likes do desktop, nem stations novas, nem play_count. Todo retorno passa pelo pipeline manual export+adb.
- **Por que importa:** Enquanto o canal for de mão única, todo enriquecimento de volta ao celular custa intervenção humana. Um GET /sync/taste no mesmo receptor (mesmo canal WireGuard, mesmo formato do taste.json) fecharia o loop e resolveria stale, likes e stations de uma vez.
- **Risco/restricao:** ureq no Android é SEM TLS — só funciona dentro da tailnet, e o receptor precisa aceitar GET sem autenticação nenhuma na porta tailnet (hoje é escrita cega também). Aceitável pelo mesmo argumento do bind atual, mas amplia superfície: um GET que devolve gosto é menos inócuo que um POST idempotente.
- **Ancoras desktop:** `src-tauri/src/sync_receiver.rs:22-76 (receptor, só POST)`, `src-tauri/src/sync_receiver.rs:135 (insert_synced_event)`
- **Ancoras mobile:** `src-tauri/src/mobile_sync.rs:96 (worker: sleep 60s → sync_once)`, `src-tauri/src/mobile_sync.rs:140-160 (só POST; sem GET)`

### `like-trilho` — Sem like/coração em nenhum lugar do mobile · **M**
*(dimensao: telas)*

- **Desktop:** Like na PlayerBar com estado persistido (src/components/PlayerBar.tsx:479-489, lib_toggle_like/lib_is_liked em src/tauri.ts:154-155), no menu de contexto sem fechar o menu (src/components/TrackContextMenu.tsx:97-104) e lista de curtidas (lib_list_liked, src/tauri.ts:177). O handoff mobile pôs o coração na fileira de ações do álbum (docs/design-refs/design_handoff_mobile/screens.js:33).
- **Mobile hoje:** Nenhum command de like em src-tauri/src/mobile.rs:143-157 (os 11 são de biblioteca/intel/lyrics). O NowPlaying mobile documenta a ausência (src/mobile/components/NowPlaying.tsx:10).
- **Por que importa:** Like é o único sinal EXPLÍCITO que o motor de gosto consome (top-10 de positives no v3). O S24 já é a máquina onde a música é ouvida — cada like não dado no celular é sinal perdido para o perfil inteiro.
- **Risco/restricao:** Like precisa ser idempotente e sobreviver offline: se for escrito só em localStorage e o app for reinstalado, some. O caminho coerente é um evento no mesmo journal já sincronizado (device_id/liked_device).
- **Depende de:** fila de likes no journal + sync pro desktop (o Qdrant não vive no aparelho)
- **Ancoras desktop:** `src/components/PlayerBar.tsx:479`, `src/components/TrackContextMenu.tsx:97`, `src/tauri.ts:154`
- **Ancoras mobile:** `src-tauri/src/mobile.rs:143`, `src/mobile/components/NowPlaying.tsx:10`, `src/mobile/ipc.ts:37`

### `sync-worker-bidirecional` — Sync worker e unidirecional, cego e sem observabilidade · **M** _[WRONG_ANCHORS]_
*(dimensao: plataforma)*

- **Desktop:** sync_receiver.rs aceita POST /sync/events e GET /sync/health, faz upsert idempotente por UUID e loga aceitos/rejeitados no desktop.
- **Mobile hoje:** mobile_sync::worker dorme 60s em loop, drena o journal, POSTa e acka; nada volta pro aparelho (nem likes, nem play_count, nem taste atualizado). Erro so vai pro tracing::debug — a UI nunca sabe que o sync esta parado.
- **Por que importa:** O celular contribui sinal mas nunca recebe o resultado dele; e o usuario nao tem como saber se ha 300 eventos empilhados porque a tailnet caiu ha uma semana.
- **Risco/restricao:** Expor status exige command novo (o worker e uma thread sem estado compartilhado com o Tauri State). Backoff: hoje re-tenta a cada 60s pra sempre, gastando bateria fora da tailnet.
- **Ancoras desktop:** `src-tauri/src/sync_receiver.rs:9`, `src-tauri/src/sync_receiver.rs:104`, `src-tauri/src/sync_receiver.rs:143`
- **Ancoras mobile:** `src-tauri/src/mobile_sync.rs:98`, `src-tauri/src/mobile_sync.rs:106`, `src-tauri/src/mobile_sync.rs:108`, `src/mobile/screens/Settings.tsx:100`
- **Veredito do cetico:** Gap real (o canal e estritamente celular->desktop; nada volta: likes, play_count, taste), mas as ancoras mobile estao imprecisas: o loop e mobile_sync.rs:103-108 (sleep 104, sync_once 105, tracing::debug 106), o POST e 140-145 e o ack 155. E Settings.tsx:100 e o botao de re-scan, nao sync — o ponto correto e que NAO existe nenhuma linha de sync em src/mobile/screens/Settings.tsx (146 linhas, so Appearance/Library/About). Desktop: sync_receiver.rs:22 start, 103 /sync/health, 104 POST /sync/events, 143 log de aceitos/rejeitados — corretas.

### `likes-sem-trilho` — Like nao existe no mobile (nem local, nem sync) · **M** _[WRONG_ANCHORS]_
*(dimensao: plataforma)*

- **Desktop:** lib_toggle_like / lib_is_liked / lib_list_liked gravam liked_at em track_enrichments e o like alimenta os positives do sinal v3 (top-10); o export de taste ja consome isso.
- **Mobile hoje:** Zero ocorrencias de like em src/mobile/**. O contrato IPC v0 lista 'likes com sync' explicitamente como fora de escopo.
- **Por que importa:** O gesto mais barato de curadoria (curtir a faixa que esta tocando no onibus) esta indisponivel justamente no dispositivo onde a escuta acontece — e o motor perde esse sinal.
- **Risco/restricao:** Like nao e play_event: precisa de canal proprio no sync (o receptor so aceita eventos com o shape do build_play_event_payload) e de estado local pra refletir enquanto offline. Sem sync inverso, like feito no desktop nao aparece no celular — estado divergente visivel.
- **Depende de:** sync-worker-bidirecional
- **Ancoras desktop:** `src-tauri/src/desktop.rs:3281`, `docs/android/ipc-contrato-v0.md:1`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:1`, `src-tauri/src/mobile.rs:139`, `src-tauri/src/mobile_sync.rs:36`
- **Veredito do cetico:** Gap real e confirmado (zero ocorrencia de like em src/mobile/** exceto o comentario de NowPlaying.tsx:10 'sem coracao (nao ha trilho de like)'; contrato IPC:116 lista likes como fora). Ancoras desktop erradas: os commands sao desktop.rs:728 lib_toggle_like, 733 lib_list_liked, 744 lib_is_liked — 3281 e so o generate_handler.

### `taste-derivado-so-de-eventos-sincados` — Gosto do celular ignora o que o próprio celular ouviu desde o último export · **L**
*(dimensao: inteligencia)*

- **Desktop:** Cada evento novo entra no play_events e muda o saldo líquido da track na próxima derivação (decay 14d, piso de atenção 90s, desconto 0.6 para origens passivas).
- **Mobile hoje:** O aparelho NÃO deriva sinal nenhum: mobile_intel só lê taste.json. O journal local é drenado e enviado (mobile_sync), mas nunca alimenta o ranking local. Uma faixa skipada 3x no S24 continua no topo do pool local até o próximo export.
- **Por que importa:** O celular é onde a maior parte da escuta acontece e é o único lugar onde o feedback não tem efeito imediato. Um saldo local (mesmo aproximado, só sobre os eventos ainda no journal) já corrigiria o caso mais irritante: a faixa que você acabou de pular reaparecendo na mesma sessão.
- **Risco/restricao:** Após o ack o journal é compactado — o histórico local desaparece. Derivar localmente exige guardar um agregado próprio (saldo por track) fora do journal, ou não ackar. Duplicar a matemática v3 em Rust mobile é viável (a função é pura), mas cria uma TERCEIRA cópia da lógica (Rust desktop + Python export + Rust mobile) — o risco real é divergência silenciosa.
- **Depende de:** taste-snapshot-stale
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/qdrant_client.rs:1849-1937 (derivação completa)`
- **Ancoras mobile:** `src-tauri/src/mobile_intel.rs:214 (rank_pool consome só Taste do arquivo)`, `src-tauri/src/mobile_sync.rs:120 (drain_events → POST → ack; o payload some do aparelho após o ack)`

---

## Epic D — Pipeline de dados desktop->celular

Um script manual com cabo USB e o unico caminho. Frescor invisivel, sem delta, campos que faltam no manifest.


### `lib-manifest-freshness` — Nenhuma nocao de frescor/versao do manifest na UI · **XS**
*(dimensao: biblioteca)*

- **Desktop:** `lib_snapshot` devolve tracks_total, albums_total, artists_total, embeddings_done/pending e a Library mostra 'embedded / pending' no cabecalho — o usuario ve o estado da indexacao.
- **Mobile hoje:** O manifest tem `schema`, `generated_at`, `source_device`, `track_count` (export_manifest.py:151-158) e o parser DESCARTA tudo: o struct `Manifest` so tem `tracks`. Settings mostra contagens derivadas, nada sobre quando o acervo foi exportado.
- **Por que importa:** O usuario nao tem como saber se esta olhando um acervo de ontem ou de tres semanas atras, nem se o export falhou no meio. Detalhe pequeno, alto valor: uma linha 'exportado ha 3 dias · 1746 faixas · schema 1' resolve.
- **Risco/restricao:** Nenhum. Campos ja existem no JSON; e so desserializar e expor num command.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:615`, `src/views/Library.tsx:41`
- **Ancoras mobile:** `src-tauri/src/mobile_library.rs:24`, `src/mobile/screens/Settings.tsx:78`

### `lib-unresolved-invisivel` — Faixas do manifest sem arquivo local somem em silencio · **XS**
*(dimensao: biblioteca)*

- **Desktop:** O indexer conhece o path real de cada track; arquivo removido sai do indice via watcher/rescan e a UI reflete.
- **Mobile hoje:** `load()` conta `unresolved` e emite um `tracing::warn!` — que nem vai pro logcat (log do Rust so no arquivo). A UI nunca ve esse numero. Faixa que existe no manifest mas nao no cartao simplesmente nao aparece.
- **Por que importa:** Sync parcial (push interrompido, arquivo rejeitado pelo MediaProvider por caractere invalido) vira biblioteca silenciosamente incompleta. E exatamente o modo de falha do pipeline atual, e nao ha alarme nenhum.
- **Risco/restricao:** Nenhum. Devolver `{resolved, unresolved}` no lib_rescan/um command de stats e mostrar como stat tile em Settings.
- **Depende de:** lib-manifest-freshness
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/watch.rs:11`
- **Ancoras mobile:** `src-tauri/src/mobile_library.rs:269`, `src/mobile/screens/Settings.tsx:107`

### `lib-disc-number-descartado` — disc_number chega no manifest e e jogado fora — album multi-disco embaralha · **XS**
*(dimensao: biblioteca)*

- **Desktop:** `Track.disc_number` e campo de primeira classe (metadata.rs le TPOS/DISCNUMBER) e `TrackOrder::AlbumDiscTrack` e a ordenacao default de faixas.
- **Mobile hoje:** O campo vem no manifest mas o struct o marca `#[allow(dead_code)]` e o `Track` do mobile nem o carrega; `tracksOfAlbum` ordena SO por `track_number`. Album de 2 discos intercala faixa 1 do disco 1 com faixa 1 do disco 2.
- **Por que importa:** Qualquer box set/album duplo toca fora de ordem. E o tipo de detalhe que destroi a confianca na tela de album.
- **Risco/restricao:** Nenhum — dado ja transita. So propagar pro Track e ordenar por (disc, track).
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/types.rs:76`, `src-tauri/crates/library-indexer/src/types.rs:125`, `src-tauri/crates/library-indexer/src/metadata.rs:193`
- **Ancoras mobile:** `src-tauri/src/mobile_library.rs:38`, `src/mobile/derive.ts:106`, `src/mobile/screens/Album.tsx:22`

### `lib-metadados-tecnicos` — Metadados tecnicos e tags nao viajam pro celular · **XS** _[OVERSTATED]_
*(dimensao: biblioteca)*

- **Desktop:** Track carrega tags[], sample_rate, bit_depth, channels, replaygain (4 campos) e lufs_integrated — usados por DSP, normalizacao e telas tecnicas.
- **Mobile hoje:** O manifest exporta 11 campos (FIELDS) e nenhum deles e tecnico. O Track mobile tem 12 campos e nenhum formato/qualidade.
- **Por que importa:** Parte e legitimamente desktop-only (DSP nao existe no Android), mas 'Opus 192k, 2ch' na tela de faixa e informacao que o usuario deste acervo quer — o sync pro celular transcodifica, e saber o que se esta ouvindo importa.
- **Risco/restricao:** Os valores do desktop descrevem o FLAC original, nao o Opus que esta no celular — exportar direto MENTE. Ou se le do arquivo local (Media3) ou o sync registra o formato de saida.
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/types.rs:87`, `src-tauri/crates/library-indexer/src/types.rs:89`
- **Ancoras mobile:** `scripts/android/export_manifest.py:51`, `src/mobile/types.ts:12`
- **Veredito do cetico:** Os fatos batem (types.rs:87-101 tem tags[], sample_rate, bit_depth, channels, 4 campos de replaygain e lufs_integrated; FIELDS do export, :51-55, nao leva nenhum; Track mobile tem 12 campos, types.ts:12-26), mas classificar como gap de biblioteca inflaciona: os consumidores desses campos no desktop sao a cadeia DSP/normalizacao e a tela Signal — e no Android o playback e ExoPlayer via plugin, sem DSP proprio, sem tela Signal e sem normalizacao por LUFS. Nao ha nada no mobile que passaria a funcionar exportando esses campos hoje. O unico subitem com valor de UI e `tags[]` (usado como filtro em TrackFilter, types.rs:117), e mesmo esse nao tem tela de destino.

### `lib-covers-nao-cacheadas` — Sem cache/redimensionamento de capa no aparelho · **S** _[OVERSTATED]_
*(dimensao: biblioteca)*

- **Desktop:** cover.rs normaliza e grava capas no cache_dir; os commands devolvem paths absolutos ja resolvidos e a UI serve via media server local.
- **Mobile hoje:** `assetSrc` faz `convertFileSrc` direto no JPEG do cartao; cada card de album/artista carrega a imagem em tamanho original (o `loading=lazy` do desktop nem existe nos grids mobile).
- **Por que importa:** Grid de albuns em WebView carregando dezenas de JPEGs full-size e o candidato numero um a travamento de scroll no aparelho — o LazyList mitiga a contagem, nao o peso por imagem.
- **Risco/restricao:** Gerar thumbs no aparelho custa CPU/armazenamento; alternativa mais barata e o export ja entregar um cover-thumb (ex. 256px) ao lado do cover.jpg.
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/cover.rs:1`, `src/views/Playlists.tsx:82`
- **Ancoras mobile:** `src/mobile/ipc.ts:83`, `src/mobile/components/Cover.tsx:1`, `src/mobile/components/ui.tsx:66`
- **Veredito do cetico:** Metade da afirmacao e falsa. Cover.tsx:38 JA usa loading="lazy" e decoding="async", com fallback por onError — e os grids nao montam tudo de uma vez: LazyList (ui.tsx:66-94) cresce por IntersectionObserver, com chunk 24 em albuns e 40 em artistas (Library.tsx:69 e :87). Logo 'o loading=lazy do desktop nem existe nos grids mobile' esta errado. O que resta de gap real e so o dimensionamento: assetSrc (ipc.ts:83-90) aponta pro JPEG original do cartao e nao ha downscale nem cache de thumbnail — cada card de 72px carrega a capa em resolucao cheia. Desktop confirmado (cover.rs normaliza no cache_dir; Playlists.tsx:81 usa loading=lazy tambem).

### `enrichments-vibe-nao-exportados` — Enrichments de vibe (energy/valence/moods/activity/lufs) não chegam ao aparelho · **S**
*(dimensao: inteligencia)*

- **Desktop:** O desktop lê a collection track_enrichments (energy, valence, mood_tags, activity_tags, genre, play_count, liked_at, lufs_integrated) e usa em: re-rank de autoplay/stations, mood search, Home rails e normalização de loudness.
- **Mobile hoje:** export_manifest.py exporta apenas path/título/artista/álbum/duração/track#/disc#/genre/ano/dominant_color. Nenhum campo de vibe, nenhum play_count, nenhum liked_at, nenhum lufs. mobile_library::Track não tem esses campos.
- **Por que importa:** É a matéria-prima de metade do motor. Sem ela o mobile só consegue similaridade MERT bruta e pool precomputado; qualquer re-rank de coerência, station de mood dinâmica, filtro por energia ou normalização de volume fica impossível offline — e o custo de exportar é ~30 bytes/faixa.
- **Risco/restricao:** Cobertura de vibe é MANUAL no desktop (CLAUDE.md: leva nova do Crate entra sem energy/valence). Exportar campo ausente vira neutro 0.5 no aparelho — precisa de default explícito, senão o re-rank mobile diverge do desktop em silêncio.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:416-470 (vibe_from_enrichment via get_enrichments_batch)`, `src-tauri/crates/library-indexer/src/query.rs:573-604 (recommendations lê enrichments)`
- **Ancoras mobile:** `scripts/android/export_manifest.py:52-57 (FIELDS — só payload de rustify_tracks)`, `scripts/android/export_manifest.py:130-147 (build_manifest)`, `src-tauri/src/mobile_library.rs:49 (struct Track)`

### `stations-mood-vocabulario-truncado` — Stations de mood exportadas perdem os aliases do MoodFilters · **S**
*(dimensao: inteligencia)*

- **Desktop:** MoodFilters::parse aceita aliases e resolve ambiguidade mood/activity; lib_mood_search aplica ainda filtro de genre por cima.
- **Mobile hoje:** mood_pool no export replica só o vocabulário canônico e IMPRIME um aviso quando o token cai fora ('aliases do MoodFilters::parse não são replicados aqui') — a station chega ao celular com pool menor ou VAZIO, e a UI mostra 'sem candidatas no acervo' sem explicar.
- **Por que importa:** Station criada no desktop com uma query que usa alias funciona lá e aparece morta no celular. O estado vazio culpa o acervo, quando o culpado é o parser divergente.
- **Risco/restricao:** Terceira réplica de lógica canônica em Python (junto com derive_behavioral_signals). Cada divergência é silenciosa por construção. Alternativa melhor: o export pedir o pool ao APP desktop (que tem o parser real) em vez de reimplementar.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:318-345 (lib_mood_search + filtro de genre)`, `src-tauri/src/desktop.rs:3560 (generate_station_batch)`
- **Ancoras mobile:** `scripts/android/export_manifest.py:378-399 (mood_pool, vocabulário parcial)`, `src/mobile/screens/Stations.tsx:60-64 ('sem candidatas no acervo')`

### `cover-multiplas-por-album` — Capa por pasta faz faixas de compilação/pastas mistas mostrarem a capa errada · **S** _[WRONG_ANCHORS]_
*(dimensao: visual)*

- **Desktop:** cover_path é per-track no índice.
- **Mobile hoje:** dir_cover.setdefault(rel_dir, cover) — a PRIMEIRA capa vista naquele diretório vale para todas as faixas dele. Em pasta de playlist (nível 1 do acervo) com artistas diferentes, todo mundo herda a mesma arte.
- **Por que importa:** Erro visual óbvio e frequente dado que a organização do acervo é por playlist/pasta, exatamente o caso que colide.
- **Risco/restricao:** Corrigir para per-album real (artista+álbum) multiplica arquivos no aparelho; medir quantas pastas de fato são mistas antes de decidir.
- **Depende de:** cover-quality-cache
- **Ancoras desktop:** `src-tauri/src/desktop.rs:939`
- **Ancoras mobile:** `scripts/android/export_manifest.py:440`, `src/mobile/types.ts:17`
- **Veredito do cetico:** O gap e real: export_manifest.py:444 'dir_cover.setdefault(rel_dir, cover)' (nao 440) — a primeira capa vista no diretorio vale pra todas as faixas dele, e como playlist e pasta de 1o nivel do acervo, pasta mista herda arte unica. Mas a ancora desktop esta errada: desktop.rs:939 e 'struct ThemeInfo'; o per-track correto e desktop.rs:218-219 e :282-283. Ancora mobile complementar: mobile_library.rs:44/62 so carrega o campo, quem colapsa e o script.

### `transferencia-acervo-fora-do-repo` — Pipeline de transcodificacao/transferencia do acervo nao esta no repo · **S**
*(dimensao: plataforma)*

- **Desktop:** Fluxo documentado por memoria (Opus 192k, staging em ~/.cache/phone-sync/Music na cmr-auto, adb push --sync via phone_push_retry.sh) — nenhum desses scripts esta versionado aqui; scripts/ so tem export_manifest.py pro lado Android.
- **Mobile hoje:** Depende inteiramente desses scripts nao versionados; a resolucao manifest->arquivo depende do stem canonico gerado por eles (substituicao de : * ? " < > | por _).
- **Por que importa:** Se a cmr-auto perder o home (ja aconteceu com ~/slskd_dados), o rail de acervo do celular some sem copia no repo — e o contrato de sanitizacao de nome, que o Rust replica, fica sem fonte.
- **Risco/restricao:** Versionar sem testar quebra silenciosa: a canonicalizacao do stem e acoplada aos dois lados; mudar o transcode/rename derruba a resolucao de 1746/1746 sem erro visivel (faixa some da lista).
- **Ancoras desktop:** `scripts/android/export_manifest.py:24`, `scripts/android/export_manifest.py:29`
- **Ancoras mobile:** `src-tauri/src/mobile_library.rs:8`, `src-tauri/src/mobile_library.rs:18`

### `artefatos-ausentes-ux` — Ausencia de artefatos degrada em silencio, sem diagnostico · **S**
*(dimensao: plataforma)*

- **Desktop:** Settings desktop mostra stats reais da biblioteca via libSnapshot e o estado do Qdrant/embeddings; a Signal expoe cobertura.
- **Mobile hoje:** Todos os artefatos (.rustify/vectors.bin, taste.json, stations.json) sao opcionais: sem eles os commands devolvem vazio e as secoes somem. So playSimilar tem toast ('Sem vetores no aparelho'). O Settings mobile nao diz se ha vetores, quantas stations, ou a data do ultimo export.
- **Por que importa:** O usuario ve o app 'perder' Stations/Favoritos e nao tem como saber que faltou rodar o export — indistinguivel de bug.
- **Risco/restricao:** Exige command novo (lib_artifacts_status) e um mtime/versao no export — o export_manifest.py hoje nao carimba data nem versao nos artefatos.
- **Ancoras desktop:** `src/views/Settings.tsx:19`, `src/views/Signal.tsx:1`
- **Ancoras mobile:** `src-tauri/src/mobile_library.rs:75`, `src/mobile/store.ts:50`, `src/mobile/store.ts:242`, `src/mobile/screens/Settings.tsx:88`

### `rescan-nao-incremental` — lib_rescan recarrega tudo sincrono e o boot faz walk bloqueante · **S** _[WRONG_ANCHORS]_
*(dimensao: plataforma)*

- **Desktop:** library-indexer com watcher e ingest incremental (IngestPaths devolve track_id por path); o app nao trava pra reindexar.
- **Mobile hoje:** MobileLibrary::load() roda no setup, sincrono, na main thread (comentario admite: 'v0 aceita o load sincrono'); lib_rescan cria uma biblioteca nova inteira e troca sob Mutex. Nao ha watcher nem incremental.
- **Por que importa:** Com acervo maior (ou cartao lento) o boot pendura antes da UI aparecer, e re-scan bloqueia qualquer command lib_* enquanto roda (Mutex unico).
- **Risco/restricao:** Mover pra thread exige estado 'carregando' no command (hoje qualquer lib_* assume biblioteca pronta) e a UI ja tem libReady — dá pra reaproveitar.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:3271`
- **Ancoras mobile:** `src-tauri/src/mobile.rs:131`, `src-tauri/src/mobile.rs:114`, `src-tauri/src/mobile.rs:19`
- **Veredito do cetico:** Gap real. Ancoras mobile corretas: mobile.rs:115-119 (lib_rescan cria MobileLibrary::load() inteira e troca sob Mutex) e mobile.rs:136-139 (comentario admitindo o load sincrono no setup). O :19 citado nao e desse ponto. Nao ha watcher nem ingest incremental, contra o library-indexer do desktop.

### `lib-no-fs-watcher` — Sem watcher de filesystem no celular · **M**
*(dimensao: biblioteca)*

- **Desktop:** FsWatcher (notify + debounce 2s, colapso Remove>Modified>Created) detecta arquivo novo/alterado/removido no music root e re-indexa sozinho.
- **Mobile hoje:** Nada. So `lib_rescan` manual, disparado por um botao em Settings.
- **Por que importa:** Depois de um `adb push` de acervo novo o app continua mostrando a biblioteca velha ate o usuario lembrar de abrir Settings e apertar Re-scan. Nao ha nem aviso de que o manifest no disco e mais novo que o carregado.
- **Risco/restricao:** FileObserver do Android em /sdcard e caro e furado (scoped storage); o barato e comparar mtime/`generated_at` do manifest no resume do app em vez de watcher real.
- **Depende de:** lib-manifest-freshness
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/watch.rs:11`, `src-tauri/crates/library-indexer/src/watch.rs:45`
- **Ancoras mobile:** `src-tauri/src/mobile.rs:115`, `src/mobile/screens/Settings.tsx:91`

### `lib-capa-por-pasta` — Capa e por PASTA no celular, nao por album/faixa · **M**
*(dimensao: biblioteca)*

- **Desktop:** cover.rs extrai arte embutida e grava no cache; cada Track carrega `album_cover_path` proprio, resolvido pra absoluto em todo command de leitura.
- **Mobile hoje:** `walk_music` indexa `cover.jpg|cover.jpeg|cover.png|folder.jpg` POR DIRETORIO e todas as faixas daquele diretorio herdam a mesma imagem. Pasta com faixas de albuns diferentes (o caso das levas avulsas do Crate) mostra a capa errada em massa.
- **Por que importa:** Capa errada e o erro visual mais visivel que existe num player, e contamina tambem o ink/accent adaptativo (que le dominant_color da faixa, criando incoerencia entre cor de fundo e capa exibida).
- **Risco/restricao:** Consertar de verdade exige exportar cover POR ALBUM (nao por dir) e um mapa track->cover no manifest; hoje o deploy_covers escreve um cover.jpg por diretorio de album do desktop, e o layout de pastas avulsas nao respeita essa premissa.
- **Depende de:** lib-sync-incremental
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/cover.rs:1`, `src-tauri/src/desktop.rs:217`
- **Ancoras mobile:** `src-tauri/src/mobile_library.rs:123`, `src-tauri/src/mobile_library.rs:247`, `scripts/android/export_manifest.py:433`

### `lib-sem-mood-filtros-exportados` — Anotacoes de vibe (energy/valence/moods) nao vao pro manifest · **M**
*(dimensao: biblioteca)*

- **Desktop:** track_enrichments carrega moods/activities/energy/valence, consumidos pelo re-rank e pelo `lib_mood_vocabulary` que alimenta a criacao de mood stations.
- **Mobile hoje:** O export leva vetores mert, taste e pools de station, mas NAO as anotacoes por faixa. O vocabulario canonico esta duplicado no script so pra construir os pools.
- **Por que importa:** Com as anotacoes no aparelho o mobile ganharia filtro por mood, chips de clima e ate criacao local de station — tudo offline, sem embedder.
- **Risco/restricao:** Cobertura de vibe e MANUAL (CMR-178) e reabre a cada leva do Crate — exportar anotacao incompleta produz filtro que esconde faixas sem aviso.
- **Depende de:** lib-sem-busca-semantica
- **Ancoras desktop:** `src-tauri/src/desktop.rs:185`, `src-tauri/src/desktop.rs:318`
- **Ancoras mobile:** `scripts/android/export_manifest.py:75`, `src-tauri/src/mobile_library.rs:20`

### `lib-carga-sincrona-boot` — Carga da biblioteca no boot e sincrona e monolitica · **M**
*(dimensao: biblioteca)*

- **Desktop:** Indexer roda em worker thread propria; a UI recebe snapshot e listas sob demanda, com filtros e limit por command (`lib_list_albums(limit:300)`, `lib_get_artists(limit:500)`).
- **Mobile hoje:** `MobileLibrary::load()` roda dentro do `setup()` (walk de ~3k arquivos + parse do manifest + vectors.bin) e o frontend puxa o acervo INTEIRO via `lib_list_tracks` num invoke so, com timeout+retry de 6s pra contornar a race do WebView frio. Albuns/artistas sao derivados em memoria no JS.
- **Por que importa:** E a origem do bug 'Carregando biblioteca...' eterno ja vivido no S24. Com o acervo crescendo, o payload unico de 1746 tracks (e depois 5k) tende a piorar, e nao ha paginacao nem limite em command nenhum do mobile.
- **Risco/restricao:** Paginar quebra as derivacoes client-side (albums/artists precisam do acervo inteiro). O caminho e mover a derivacao pro Rust e servir listas prontas — o que muda o contrato IPC das telas ja entregues.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:201`, `src-tauri/src/desktop.rs:226`
- **Ancoras mobile:** `src-tauri/src/mobile.rs:136`, `src-tauri/src/mobile.rs:36`, `src/mobile/store.ts:331`

### `ink-cycle-palette` — Ciclo de paleta (bgInkCycle, alternância a cada ~40s) não existe — e o manifest nem exporta a paleta · **M**
*(dimensao: visual)*

- **Desktop:** Com adaptiveInk+bgInkCycle e dominant_palette_v4 com 2+ famílias, o ink alterna entre elas por setInterval, sempre voltando pela dominante; anuncia tau longo via --bg-ink-morph pro lerp do canvas.
- **Mobile hoje:** O manifest exporta apenas dominant_color (um hex, export_manifest.py:145 e types.ts:25). Não há palette, não há timer, não há knob. O canvas mobile JÁ lê --bg-ink-morph (spectrum.ts:179), então metade da infra está pronta e ociosa.
- **Por que importa:** É um dos efeitos mais perceptíveis do desktop — o fundo respira entre as cores da capa. No celular a cor é estática por faixa.
- **Risco/restricao:** Exige mudar o schema do manifest (campo palette) e re-exportar o acervo. Timer de 40s rodando com tela apagada precisa ser pausado por visibilitychange, senão queima bateria.
- **Ancoras desktop:** `src/lib/adaptiveInk.ts:122`, `src/lib/adaptiveInk.ts:158`, `src/views/Tweaks.tsx:232`
- **Ancoras mobile:** `scripts/android/export_manifest.py:145`, `src/mobile/types.ts:25`, `src/mobile/bg/spectrum.ts:179`

### `cover-quality-cache` — Capas: uma cover.jpg por PASTA, sem cache de tamanhos e sem placeholder de carregamento · **M** _[OVERSTATED]_
*(dimensao: visual)*

- **Desktop:** Capa por track via cache do app (cover_path do enrichment, cache webp).
- **Mobile hoje:** export_manifest.py deploya UMA cover.jpg por diretório de álbum (deploy_covers, linha 430+), convertida do cache webp. Cover.tsx faz <img loading=lazy> com fallback por TOM determinístico (toneFor) e onError. Sem srcset/tamanho, sem skeleton entre o layout e o decode — a lista pisca do tom para a imagem.
- **Por que importa:** Capa é o elemento visual dominante das listas. Carregar o mesmo JPEG cheio para um thumbnail de 48px em 1746 linhas é desperdício e causa jank visível no scroll.
- **Risco/restricao:** Gerar thumbs no export multiplica o tempo de deploy e o espaço no /sdcard. Compensa medir antes: o LazyList (chunk 60) já mitiga parte do problema.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:939`
- **Ancoras mobile:** `scripts/android/export_manifest.py:430`, `src/mobile/components/Cover.tsx:37`, `src/mobile/components/ui.tsx:66`
- **Veredito do cetico:** Ancora desktop ERRADA: desktop.rs:939 e 'struct ThemeInfo', nao capa; o per-track e desktop.rs:218-219 / :282-283 (album_cover_path resolvido contra lib.cache_dir). E ha placeholder: Cover.tsx:30-36 pinta o tom deterministico (toneFor) como background do container ANTES do decode, com onError caindo no glifo — nao e 'sem placeholder'. O que de fato falta e o refinamento: nenhum srcset/tamanho por contexto (a mesma cover.jpg serve o tile de 48px e a capa full do NowPlaying) e nenhum fade do tom para a imagem (NowPlaying.tsx:193 / TrackRow), dai o 'pisca'.

### `lib-sync-incremental` — Sync do acervo e full-dump, sem delta nem deteccao de mudanca · **L** _[WRONG_ANCHORS]_
*(dimensao: biblioteca)*

- **Desktop:** Indexacao incremental: entry_for_path/mtime decide o que re-processar; o Crate ingere caminhos pontuais via `IndexerCommand::IngestPaths`.
- **Mobile hoje:** export_manifest.py faz scroll_all do Qdrant e regrava manifest.json + vectors.bin inteiros; a entrega e `adb push --sync` do acervo. Nao ha diff de faixas adicionadas/removidas nem log do que mudou.
- **Por que importa:** Cada leva nova do Crate exige reexportar tudo (vectors.bin e dezenas de MB) e o usuario nao recebe nenhum 'entraram 12 faixas, sairam 3'. Um manifest-delta tornaria o ciclo barato o bastante pra rodar automatico.
- **Risco/restricao:** Delta exige guardar o manifest anterior em algum lugar estavel e reconciliar remocoes no aparelho (arquivo orfao no cartao). Sem cuidado, delta divergente e pior que full-dump.
- **Depende de:** lib-manifest-freshness
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/pipeline.rs:1`, `src-tauri/src/desktop.rs:687`
- **Ancoras mobile:** `scripts/android/export_manifest.py:124`, `scripts/android/export_manifest.py:534`
- **Veredito do cetico:** Gap real, ancora mobile errada. export_manifest.py:534 e o branch `if not args.skip_covers`, nao o dump. As ancoras certas sao main() em export_manifest.py:511-529 (scroll_all + regravacao integral de manifest.json/vectors.bin/taste.json/stations.json) e deploy_artifacts em :489-496 (scp dos 4 arquivos inteiros). Ressalva: deploy_covers (:453-461) JA e idempotente por arquivo (pula cover.jpg existente), entao 'nenhuma nocao de incremental' e forte demais — o que de fato falta e diff de faixas adicionadas/removidas e log do delta. Desktop side confere (pipeline incremental por mtime; IngestPaths pontual).

### `lib-no-indexer-manifest-only` — Mobile nao indexa nada: biblioteca e um manifest exportado a mao · **XL**
*(dimensao: biblioteca)*

- **Desktop:** library-indexer roda dentro do app: scan do music root, leitura de tags, extracao de capa, loudness, embeddings e upsert no Qdrant; `lib_rescan` manda `IndexerCommand::Rescan` pro worker e o app se atualiza sozinho.
- **Mobile hoje:** `MobileLibrary::load()` le `/storage/emulated/0/Music/.rustify/manifest.json` (gerado na VM por export_manifest.py) e casa com os arquivos por stem canonico. Sem manifest = biblioteca vazia. Nenhuma tag e lida no aparelho.
- **Por que importa:** Todo dado novo (faixa baixada pelo Crate, retag, capa nova) so chega ao celular depois de um ciclo manual VM->cmr-auto->adb push. O aparelho e um consumidor cego: nao sabe o que tem no cartao alem do que o manifest disse.
- **Risco/restricao:** Portar o indexer inteiro e inviavel (library-indexer e target-gated desktop, arrasta Qdrant/embed). O caminho realista e um indexer mobile MINIMO (tags via Media3 MetadataRetriever) so pra faixas fora do manifest — mas isso quebra a garantia do track_id canonico (hash do path da cmr-auto), que e o que sustenta o sync de eventos.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:687`, `src-tauri/crates/library-indexer/src/scan.rs:37`, `src-tauri/crates/library-indexer/src/metadata.rs:186`
- **Ancoras mobile:** `src-tauri/src/mobile_library.rs:202`, `src-tauri/src/mobile.rs:115`, `scripts/android/export_manifest.py:124`

### `sync-inverso-manual` — Sync desktop -> celular e 100% manual e fora do app · **XL**
*(dimensao: plataforma)*

- **Desktop:** scripts/android/export_manifest.py roda NA VM, exige tunel SSH pro Qdrant da cmr-auto, gera manifest/vectors/taste/stations + capas, faz --deploy por scp pro staging da cmr-auto; depois um script que nao vive neste repo (~/phone_push_retry.sh, adb push --sync) leva ao S24; e o usuario ainda precisa rodar lib_rescan.
- **Mobile hoje:** O app so LE /storage/emulated/0/Music/.rustify/*. Nao ha nenhum trilho no aparelho pra puxar acervo ou artefatos; sem cabo/adb nada atualiza.
- **Por que importa:** Toda leva nova do Crate deixa o celular defasado e o unico caminho de atualizacao passa por uma pessoa com um cabo USB e tres comandos em duas maquinas. E o gargalo estrutural do produto mobile.
- **Risco/restricao:** Pull por HTTP na tailnet e sem TLS (ureq sem TLS no Android) — aceitavel dentro do WireGuard, mas exige servidor no desktop e cota de disco/tempo pra baixar 1746 faixas Opus. Fazer download em foreground service ou vai morrer no doze.
- **Depende de:** sync-worker-bidirecional, transferencia-acervo-fora-do-repo
- **Ancoras desktop:** `scripts/android/export_manifest.py:1`, `scripts/android/export_manifest.py:29`, `scripts/android/export_manifest.py:503`
- **Ancoras mobile:** `src-tauri/src/mobile_library.rs:19`, `src-tauri/src/mobile_library.rs:21`, `src-tauri/src/mobile.rs:114`

---

## Epic E — Historico e play_count locais

O dado existe no journal e e destruido pelo ack do sync. Nenhuma tela de historico, nenhum contador.


### `lib-sem-play-count` — play_count / last_played nao existem no aparelho · **S**
*(dimensao: biblioteca)*

- **Desktop:** Track carrega play_count:u32 e last_played:Option<i64>; alimentam `lib_recommendations` (most_played / based_on_top / discover) e o texto relativo da History.
- **Mobile hoje:** O manifest nao exporta nenhum dos dois (FIELDS em export_manifest.py:51) e o Track mobile nao os tem. 'Based on your favorites' vem do taste.json, que e outro calculo (saldo comportamental), nao contagem.
- **Por que importa:** Sem contador nao ha 'mais tocadas', nao ha ordenacao por frequencia, nao ha o feedback de 'ja ouvi isso 12 vezes' na linha da faixa — micro-informacao que o desktop tem de graca.
- **Risco/restricao:** Play count exportado congela no momento do export; escutas do celular so voltam depois do round-trip de sync. Mostrar numero desatualizado como se fosse ao vivo confunde — precisa somar o local.
- **Depende de:** lib-sync-incremental
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/types.rs:104`, `src-tauri/src/desktop.rs:752`
- **Ancoras mobile:** `scripts/android/export_manifest.py:51`, `src/mobile/types.ts:12`

### `historico-play-count-mobile` — Histórico de reprodução e play_count no aparelho · **S**
*(dimensao: inteligencia)*

- **Desktop:** lib_record_play incrementa play_count nos enrichments (1x por play, no início) e lib_list_history devolve o histórico ordenado — usado na Home e como escopo 'open' de shuffle.
- **Mobile hoje:** Não existe. O journal registra eventos mas é drenado e apagado após o ack; nenhuma view lê histórico. A Home mobile documenta a ausência ('Recently played segue fora: sem command de histórico no aparelho').
- **Por que importa:** 'O que eu estava ouvindo ontem' é a ação mais frequente num player de celular e hoje só existe voltando na pasta na mão.
- **Risco/restricao:** Reusar o journal como histórico conflita com a compactação pós-ack. Solução limpa: um arquivo próprio append-only de histórico local (ids + timestamp), barato, independente do sync. Não confundir com play_count global (esse é do desktop).
- **Ancoras desktop:** `src-tauri/src/desktop.rs:708 (lib_record_play)`, `src-tauri/src/desktop.rs:713 (lib_list_history)`, `src/components/PlayerBar.tsx:803 (record_play no playTrack)`
- **Ancoras mobile:** `src/mobile/screens/Home.tsx:6-10 (ausência documentada)`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/EventJournal.kt:71-93 (evento existe, mas é fila de sync, não histórico)`

### `lib-sem-historico` — Sem historico de reproducao no aparelho · **M**
*(dimensao: biblioteca)*

- **Desktop:** `lib_record_play` incrementa play_count/last_played; `lib_list_history(200)` alimenta a tela History com tempo relativo por linha, e a Home tem o rail 'Recently played' com link 'View history'.
- **Mobile hoje:** Nao existe. O journal do plugin registra os eventos e os manda pro desktop, mas nada e lido de volta: nao ha tela, nem rail, nem command. O comentario no topo de Home.tsx assume isso explicitamente.
- **Por que importa:** 'O que eu ouvi agora ha pouco' e das funcoes mais usadas de um player de bolso — e ironicamente o celular e onde a escuta acontece. O dado esta la (journal local), so ninguem o le.
- **Risco/restricao:** O journal e compactado pelo ack pos-sync — usa-lo como fonte de historico perde tudo que ja foi sincado. Precisa de um log local separado (append-only, cap por N) ou historico derivado no export do desktop.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:707`, `src-tauri/src/desktop.rs:712`, `src/views/History.tsx:12`, `src/views/Home.tsx:140`
- **Ancoras mobile:** `src/mobile/screens/Home.tsx:8`, `src/mobile/screens/Library.tsx:118`, `src-tauri/src/mobile_sync.rs:20`

### `home-rails-recomendacao` — Rails de recomendação da Home (most played / based on top / discover) · **M**
*(dimensao: inteligencia)*

- **Desktop:** lib_recommendations devolve três listas: most_played (play_count dos enrichments), based_on_top (recommend com seeds = likes + top plays, cap 2/artista) e discover (nunca tocadas). A Home também mostra 'Recently played' (lib_list_history).
- **Mobile hoje:** A Home mobile tem apenas 'Based on your favorites' = taste.positives crus na ordem do snapshot (lib_taste_positives), sem recommend, sem cap por artista, sem discover, sem histórico — o comentário do arquivo lista isso como fora de escopo.
- **Por que importa:** 'Favoritos' mostra o que você JÁ ouve; discover e based_on_top são o que fazem a Home valer a abertura. Discover (nunca tocadas) é trivial no aparelho: manifest ∪ taste ∪ ausência de eventos.
- **Risco/restricao:** most_played e 'recently played' exigem play_count/histórico, que não existem no aparelho (nem exportados, nem locais). based_on_top exige recommend multi-seed — replicável com vectors.bin (max-sim sobre N seeds), mas é código novo.
- **Depende de:** enrichments-vibe-nao-exportados, historico-play-count-mobile
- **Ancoras desktop:** `src-tauri/src/desktop.rs:753 (lib_recommendations)`, `src-tauri/crates/library-indexer/src/query.rs:573-620`, `src/views/Home.tsx:22-27 (rails)`
- **Ancoras mobile:** `src/mobile/screens/Home.tsx:74-92 (só o rail de favoritos)`, `src-tauri/src/mobile_library.rs:355 (taste_positive_tracks)`

### `screen-history` — Tela History (e a seção "Recently played" da Home) não existe no mobile · **M**
*(dimensao: telas)*

- **Desktop:** Rota /history com as últimas 200 faixas tocadas e tempo relativo (views/History.tsx:11-59), alimentada por lib_list_history (src/tauri.ts:160). A Home mostra as 8 mais recentes com link "View history →" (src/views/Home.tsx:140-159). O handoff mobile desenhou a tela com chips de período Today/This week/This month/All (docs/design-refs/design_handoff_mobile/screens.js:91-94).
- **Mobile hoje:** Nenhuma tela e nenhum command. A seção "Coleções" da Library mobile lista só "Fila" (src/mobile/screens/Library.tsx:118-127) e o cabeçalho do arquivo declara que History ficou fora (src/mobile/screens/Library.tsx:6-8). A Home mobile não tem nada de recém-tocado (src/mobile/screens/Home.tsx:8-9).
- **Por que importa:** É o caminho mais usado para "tocar de novo aquilo de ontem". O dado JÁ existe no aparelho: o EventJournal do serviço registra cada play com timestamp, e o manifest tem os metadados — falta só um command que leia o journal e uma tela.
- **Risco/restricao:** O journal é drenado e ackado pelo worker de sync (ack_events); se o ack apagar as linhas, o histórico some. Precisa de leitura separada da fila de sync ou de um índice próprio.
- **Depende de:** command lib_list_history no mobile.rs lendo o EventJournal
- **Ancoras desktop:** `src/views/History.tsx:11`, `src/views/Home.tsx:140`, `src/tauri.ts:160`, `docs/design-refs/design_handoff_mobile/screens.js:91`
- **Ancoras mobile:** `src/mobile/screens/Library.tsx:118`, `src/mobile/screens/Home.tsx:8`, `src-tauri/src/mobile.rs:143`

---

## Epic F — Micro-interacoes: o que faz parecer um app

Long-press, bottom-sheet, haptics, alvos tateis, scroll restore, estados de erro honestos, busca com scoring.


### `empty-queue-feedback` — Estados vazios e feedback de erro do transporte · **XS** _[WRONG_ANCHORS]_
*(dimensao: playback)*

- **Desktop:** Empty states dedicados na fila ('Fila vazia / Toque algo pra comecar'), contagem de faixas e tempo restante no drawer, botao next desabilitado por aria-disabled no fim da fila (mas que ainda cai em autoplay em vez de parecer quebrado).
- **Mobile hoje:** Paridade PARCIAL boa: ha Empty com titulo/hint e um estado especifico honesto ('Fila indisponivel — o app reiniciou e o servico seguiu tocando'). Faltam: tempo restante da fila, contagem de faixas nao tocadas no dock, e feedback quando next/previous falha (hoje so console.warn, sem toast — showToast existe e nao e usado nesses caminhos).
- **Por que importa:** Botao que nao faz nada e nao diz nada e o pior tipo de bug percebido. O toast ja existe: e literalmente nao chamar.
- **Risco/restricao:** Nenhum. E o gap mais barato da lista inteira.
- **Ancoras desktop:** `src/components/QueueDrawer.tsx:18`, `src/components/QueueDrawer.tsx:93`, `src/components/PlayerBar.tsx:547`
- **Ancoras mobile:** `src/mobile/store.ts:262`, `src/mobile/store.ts:270`, `src/mobile/screens/Queue.tsx:46`
- **Veredito do cetico:** Gap real (falta tempo restante, contagem no dock e toast em falha de next/previous — store.ts:262-276 so faz console.warn embora showToast exista em store.ts:96), mas as ancoras desktop estao erradas: o empty-state do drawer esta em QueueDrawer.tsx:94-97 (nao :18, que e import/topo) e a contagem 'N tracks · X remaining' em QueueDrawer.tsx:57 (nao :93); o next com aria-disabled + fallback pra doAutoplay esta em PlayerBar.tsx:549-566 (nao :547).

### `lib-busca-pastas-conteudo` — Busca no mobile nao entra no conteudo das pastas · **XS**
*(dimensao: biblioteca)*

- **Desktop:** `lib_search_playlists` casa o nome da pasta E devolve as tracks de cada pasta encontrada, alimentando resultado agrupado.
- **Mobile hoje:** O escopo 'Pastas' filtra so pelo NOME da pasta (folders() vem sem tracks) e mostra a contagem; nao ha preview de faixas nem match dentro da pasta.
- **Por que importa:** Como pasta = playlist neste acervo, buscar 'Blues' devendo trazer as faixas da playlist e o caso de uso central.
- **Risco/restricao:** Nenhum — o acervo inteiro ja esta em memoria no mobile; e derivacao pura.
- **Depende de:** lib-busca-scoring
- **Ancoras desktop:** `src-tauri/src/desktop.rs:657`, `src-tauri/crates/library-indexer/src/query.rs:865`
- **Ancoras mobile:** `src/mobile/screens/Search.tsx:68`, `src/mobile/screens/Search.tsx:140`

### `lib-estados-vazios-diagnostico` — Estados vazios do mobile nao distinguem as causas reais de falha · **XS**
*(dimensao: biblioteca)*

- **Desktop:** Empty states por tela com mensagem propria ('Sem historico ainda', 'Nenhuma track encontrada'), e o cabecalho da Library expondo pending/embedded como diagnostico.
- **Mobile hoje:** Ha empty states em todas as telas (Home, Library por faceta, Folder, Search, Queue, Stations) — bom trabalho —, mas 'Acervo vazio' cobre tres causas distintas: permissao MANAGE_EXTERNAL_STORAGE negada, manifest ausente e manifest presente sem arquivos resolvidos. `libError` e capturado no store e nunca renderizado.
- **Por que importa:** Numa distribuicao por APK sem loja, a primeira coisa que acontece com install limpo e permissao faltando — e a tela diz pra 'sincronizar o acervo', instrucao errada. Custo de conserto: trivial.
- **Risco/restricao:** Nenhum. Precisa que o backend devolva a causa (enum) em vez de lista vazia silenciosa.
- **Depende de:** lib-unresolved-invisivel
- **Ancoras desktop:** `src/views/History.tsx:37`, `src/views/Tracks.tsx:77`
- **Ancoras mobile:** `src/mobile/screens/Home.tsx:50`, `src/mobile/store.ts:26`, `src-tauri/src/mobile_library.rs:210`

### `np-meta-navegavel` — No Now Playing mobile, artista e álbum não são clicáveis · **XS** _[OVERSTATED]_
*(dimensao: telas)*

- **Desktop:** Título/artista/álbum navegam para as respectivas telas (src/views/NowPlaying.tsx:302-307), e o menu de contexto do NP oferece Go to Album / Go to Artist (src/views/NowPlaying.tsx:265 → src/components/TrackContextMenu.tsx:152-161).
- **Mobile hoje:** Título e a linha "artista · álbum" são texto puro (src/mobile/components/NowPlaying.tsx:194-200), embora a tela de Álbum já tenha o link inverso para o artista (src/mobile/screens/Album.tsx:36-42).
- **Por que importa:** É o gesto de exploração mais barato que existe: ouvir algo bom e ir direto ao álbum. Uma linha de navigate() resolve.
- **Risco/restricao:** Navegar por baixo do overlay do NP: a rota /np é empilhada, então precisa fechar o NP (history.back) antes do navigate, senão a pilha do botão voltar fica esquisita.
- **Ancoras desktop:** `src/views/NowPlaying.tsx:302`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:194`, `src/mobile/screens/Album.tsx:36`
- **Veredito do cetico:** O mobile de fato so tem texto (NowPlaying.tsx:194-200) — gap real. Mas o comportamento desktop esta descrito melhor do que e: NowPlaying.tsx:302-307 navega para as LISTAS ('/artists' e '/albums'), nao para a pagina daquele artista/album; a navegacao especifica so existe via menu de contexto (TrackContextMenu goAlbum/goArtist, ~106-116, renderizados em ~152-160). Ou seja, o alvo a portar e o menu, nao o link do desktop.

### `erro-carga-invisivel` — Erro de carga da biblioteca é engolido: aparece como "Acervo vazio" · **XS**
*(dimensao: telas)*

- **Desktop:** Views mostram estado de carregamento e vazio distintos (src/views/Home.tsx:194-201 "scanning library…"; empty-state com título+hint em src/views/History.tsx:33-40) e o RouterView tem fallback de Suspense (src/router.tsx:73).
- **Mobile hoje:** O store captura e guarda a falha em libError (src/mobile/store.ts:26, :364-367) e o exporta (:28) — mas NENHUMA tela lê o signal (verificado por grep em src/mobile/). Com o boot falhando, a Home cai no ramo "Acervo vazio · Sincronize o acervo" (src/mobile/screens/Home.tsx:51-56), que culpa o usuário por um erro de IPC.
- **Por que importa:** É o pior tipo de falha: o app mente sobre a causa. E foi exatamente esse cenário (boot frio pendurando) que custou uma sessão em 14/08, mitigado com timeout+retry (src/mobile/store.ts:331-351) mas nunca exposto na UI.
- **Risco/restricao:** Nenhum — é renderizar o que já está no store, com botão de "tentar de novo" chamando bootStore/rescan.
- **Ancoras desktop:** `src/views/Home.tsx:194`, `src/router.tsx:73`
- **Ancoras mobile:** `src/mobile/store.ts:26`, `src/mobile/store.ts:364`, `src/mobile/screens/Home.tsx:51`

### `skeleton-loading` — Sem skeletons e sem indicador de carga incremental · **XS**
*(dimensao: telas)*

- **Desktop:** Fallback de rota (src/router.tsx:73), cards fantasma na Stations quando não há dados (src/views/Stations.tsx:535-560, opacity .35 com estrutura completa) e placeholders de seeds (:465-490).
- **Mobile hoje:** Só texto: "Carregando biblioteca…" (src/mobile/screens/Home.tsx:51), "carregando…" na meta da pasta (src/mobile/screens/Folder.tsx:32). O LazyList cresce por sentinela sem nenhum indicador de que há mais vindo (src/mobile/components/ui.tsx:66-94).
- **Por que importa:** Detalhe pequeno de percepção: a lista que "pula" ao carregar o próximo chunk parece bug; skeleton na grade de álbuns esconde o custo das capas.
- **Risco/restricao:** Skeleton mal calibrado piora a sensação (flash em lista já cacheada); só mostrar após ~200ms de espera.
- **Ancoras desktop:** `src/router.tsx:73`, `src/views/Stations.tsx:535`
- **Ancoras mobile:** `src/mobile/components/ui.tsx:66`, `src/mobile/screens/Home.tsx:51`, `src/mobile/screens/Folder.tsx:32`

### `toast-cobertura` — Toasts só em erro: gestos e trocas de faixa não dão feedback · **XS**
*(dimensao: telas)*

- **Desktop:** O protótipo mobile dispara toast em play, next/prev, troca de shape/render e criação/remoção de station (docs/design-refs/design_handoff_mobile/Rustify Mobile.html:68, :94, :102, :145-146).
- **Mobile hoje:** O primitivo existe e funciona (src/mobile/store.ts:93-100, render em src/mobile/MobileApp.tsx:134-140), mas só é usado em falha, station e rádio da faixa (store.ts:188, :224, :244; NowPlaying.tsx:137, :146). O swipe horizontal no mini troca de faixa em silêncio (src/mobile/components/Dock.tsx:47-61).
- **Por que importa:** Gesto sem confirmação parece que não funcionou — e o swipe do mini é justamente o gesto "às cegas", com o celular no bolso ou na mão apoiada.
- **Risco/restricao:** Toast a cada troca de faixa em autoplay viraria spam; só disparar em gesto EXPLÍCITO do usuário.
- **Ancoras desktop:** `docs/design-refs/design_handoff_mobile/Rustify Mobile.html:94`
- **Ancoras mobile:** `src/mobile/components/Dock.tsx:47`, `src/mobile/store.ts:93`

### `alvos-tateis` — Alvos de toque de 36px (e 30px) abaixo do mínimo de 48dp · **XS**
*(dimensao: telas)*

- **Desktop:** No desktop os botões são de mouse (14px de ícone em .pb-btn, src/components/PlayerBar.tsx:479-500) — a métrica não se aplica.
- **Mobile hoje:** .iconbtn tem 36×36px e .iconbtn.sm 30×30px (src/mobile/styles/tokens.css:350-353; src/mobile/styles/app.css:841-844). Só os controles do Now Playing chegam a 44px (src/mobile/styles/app.css:493-496). Esses botões pequenos são os de fila/ajustes na Home (src/mobile/screens/Home.tsx:38-43), a fileira do cabeçalho do NP (src/mobile/components/NowPlaying.tsx:133-178, seis botões lado a lado) e o play do card de station (src/mobile/screens/Stations.tsx:68-76).
- **Por que importa:** Detalhe tátil clássico: seis alvos de 36px na mesma linha, com o polegar em movimento, produzem toque errado. A diretriz do Android é 48dp; a da Apple, 44pt.
- **Risco/restricao:** Aumentar a caixa quebra a densidade do handoff; o caminho é manter o visual e expandir a área tocável (padding + ::after invisível), não o ícone.
- **Ancoras desktop:** `src/components/PlayerBar.tsx:479`
- **Ancoras mobile:** `src/mobile/styles/tokens.css:350`, `src/mobile/styles/app.css:841`, `src/mobile/components/NowPlaying.tsx:133`

### `lyrics-linha-vizinha` — Detalhe fino: destaque da linha VIZINHA (is-near) e rótulo de fonte da letra ausentes · **XS**
*(dimensao: visual)*

- **Desktop:** Cada linha ganha is-active, is-near (|i - ativa| === 1) ou nada — gradiente de atenção de 3 níveis. O cabeçalho do card mostra 'Lyrics · synced' + badge mono 'aligned'/'unsynced'.
- **Mobile hoje:** Só data-on na linha ativa (binário). Não há estado near, não há rótulo de origem/sincronia — o usuário não sabe se a letra é sincronizada até perceber que ela não anda.
- **Por que importa:** É literalmente a categoria de 'small shit makes THE difference' citada no header do adaptiveColor.ts. O near é ~4 linhas de CSS.
- **Risco/restricao:** Nenhum. O mobile já detecta isSynced (NowPlaying.tsx:46) — a informação existe, só não é exibida.
- **Ancoras desktop:** `src/views/NowPlaying.tsx:367`, `src/views/NowPlaying.tsx:353`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:206`, `src/mobile/styles/app.css:885`

### `lyrics-transicao-scroll` — Scroll da letra sem easing declarado e sem tratamento de scroll manual · **XS** _[OVERSTATED]_
*(dimensao: visual)*

- **Desktop:** O rail tem transition: transform 600ms com --ease no CSS (extractor-lab.css:840) e o viewport ganha is-unsynced que o torna rolável.
- **Mobile hoje:** O effect escreve railEl.style.transform direto (NowPlaying.tsx:72). Há data-static pro caso unsynced, mas o easing depende de a regra CSS existir em .lrail — e o salto de linha não tem tratamento de interrupção quando o usuário rola manualmente.
- **Por que importa:** Diferença perceptível de polimento: no desktop a letra desliza, no mobile pode saltar.
- **Risco/restricao:** Verificar a regra real de .lrail em app.css:871 antes de mexer — pode já ter transition e o gap ser só o scroll manual.
- **Ancoras desktop:** `src/styles/extractor-lab.css:840`, `src/styles/extractor-lab.css:819`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:61`, `src/mobile/styles/app.css:871`
- **Veredito do cetico:** O easing EXISTE no mobile e e o mesmo do desktop: app.css:871-872 '.np .lrail { transition: transform 0.6s var(--ease) }' — identico a extractor-lab.css:840 (600ms). O caso unsynced tambem ja e tratado: NowPlaying.tsx:203 data-static + app.css:867-870 overflow-y:auto, equivalente ao is-unsynced de extractor-lab.css:819. Paridade por outro caminho. Sobra apenas o subitem real: no modo synced nao ha tratamento de scroll manual do usuario (nem pausa do auto-scroll nem retomada) — mas o desktop tambem nao tem isso no rail synced, entao ate esse resto e discutivel como gap de paridade.

### `shape-renderer-atalhos` — Sem gesto para trocar shape/renderer (desktop tem [ ] , . e navegação ‹ ›) · **XS**
*(dimensao: visual)*

- **Desktop:** Teclas [ / ] trocam shape e , / . trocam renderer; o NowPlaying tem duas linhas ‹ nome › empilhadas com botões prev/next e clique no nome avança.
- **Mobile hoje:** Só botões que ciclam para FRENTE (useShape.next/useRenderer.next) — no NowPlaying (shapebtn) e no Settings. Não há prev exposto, apesar de useShape.prev existir. Com 23 shapes, voltar uma exige 22 toques.
- **Por que importa:** Micro-interação clássica: o usuário passa do shape que queria e não consegue voltar. prev() já está implementado e não é chamado em lugar nenhum.
- **Risco/restricao:** Nenhum — swipe horizontal no fundo ou long-press para prev. Cuidado só com conflito com o gesto de arrastar-pra-baixo que fecha o NowPlaying (NowPlaying.tsx:110).
- **Ancoras desktop:** `src/views/NowPlaying.tsx:396`, `src/renderers.ts:188`
- **Ancoras mobile:** `src/mobile/bg/spectrum.ts:64`, `src/mobile/components/NowPlaying.tsx:134`, `src/mobile/screens/Settings.tsx:49`

### `toast-acessibilidade` — Toast sem role/aria-live e sem fila · **XS**
*(dimensao: visual)*

- **Desktop:** N/A direto, mas o desktop usa context menus e feedback inline com semântica.
- **Mobile hoje:** O toast é uma <div class=toast> com data-on e timer fixo de 1600ms (store.ts:96); toasts em sequência se sobrescrevem e não há role=status/aria-live — leitor de tela não anuncia.
- **Por que importa:** Toast é o ÚNICO canal de feedback de erro do mobile (falha de rádio, sem vetores, rescan). Perder mensagem ou não anunciá-la deixa o usuário sem diagnóstico.
- **Risco/restricao:** Nenhum.
- **Ancoras mobile:** `src/mobile/store.ts:96`, `src/mobile/MobileApp.tsx:133`

### `estados-vazios-erro` — Estado de erro de biblioteca fica só no console; não há tela de erro · **XS**
*(dimensao: visual)*

- **Desktop:** N/A equivalente direto (o desktop indexa localmente).
- **Mobile hoje:** libError é setado no boot (store.ts:365) e EXPORTADO, mas nenhuma tela o consome — o componente Empty (ui.tsx:55) é genérico e o usuário com manifest ausente/corrompido vê apenas lista vazia. Settings mostra 'Pasta de música: —'.
- **Por que importa:** O modo de falha mais provável do v0 (manifest não exportado / permissão de storage negada) é indistinguível de 'acervo vazio'.
- **Risco/restricao:** Nenhum — o sinal já existe, falta renderizar com ação sugerida ('rode o export' / 'conceda MANAGE_EXTERNAL_STORAGE').
- **Ancoras mobile:** `src/mobile/store.ts:363`, `src/mobile/store.ts:26`, `src/mobile/components/ui.tsx:55`

### `missing-corrupt-file` — Tratamento de arquivo faltando/corrompido · **S** _[OVERSTATED]_
*(dimensao: playback)*

- **Desktop:** O restore reconstroi a fila 'com o que sobreviveu' quando faixas sumiram do indice e desiste limpo se a atual nao existe mais; erros de IPC caem em console.error sem travar a UI.
- **Mobile hoje:** Nao ha tratamento de PlaybackException no AudioService (o listener nao a trata; nao ha onPlayerError visivel no arquivo). Faixa com arquivo removido/renomeado depois do manifest para a fila em silencio, sem feedback e sem pular pra proxima.
- **Por que importa:** O acervo do celular e sincronizado por fora (Opus transcodificado): divergencia com o manifest e o caso NORMAL, nao a excecao.
- **Risco/restricao:** Pular automaticamente pode virar cascata (fila inteira quebrada = avanco em loop). Precisa de contador de falhas consecutivas e de um toast/estado visivel na UI.
- **Ancoras desktop:** `src/components/PlayerBar.tsx:200`, `src/components/PlayerBar.tsx:227`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt:140`, `src-tauri/src/mobile_library.rs:122`
- **Veredito do cetico:** onPlayerError EXISTE: AudioService.kt:145-147 (override fun onPlayerError -> Log.e). O que de fato falta e o tratamento: nao pula pra proxima, nao emite evento pro WebView, nao registra nada no EventJournal e nao ha toast — a fila morre em silencio (a ancora correta e 145, nao 140). Lado desktop confere (PlayerBar.tsx:201-205 reconstroi a fila com o que sobreviveu).

### `seek-precision-ui` — Precisao e affordances do seek (teclado, tempo restante, scrub fino) · **S**
*(dimensao: playback)*

- **Desktop:** Scrub por pointer com isScrubbing suprimindo o tick de posicao, tempos decorrido/total, e o seek so e commitado no pointerup.
- **Mobile hoje:** Paridade por outro caminho no essencial: o NowPlaying mobile tem scrub com pointer capture, estado local de scrub e commit no up — e ate melhor adaptado ao toque. O que falta e granularidade (barra estreita = ~1s por pixel em faixa longa), sem scrub de precisao (arrastar pra baixo pra reduzir a velocidade) e sem +/-15s.
- **Por que importa:** Detalhe pequeno de uso real: achar um ponto especifico numa faixa de 8min no dedo e impossivel na barra de 350px.
- **Risco/restricao:** Nenhum tecnico (seek_to ja existe). E puro trabalho de UI.
- **Ancoras desktop:** `src/components/PlayerBar.tsx:346`, `src/components/PlayerBar.tsx:595`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:91`, `src/mobile/components/NowPlaying.tsx:219`

### `lib-busca-scoring` — Busca mobile e substring pura; desktop tem scoring por campo, prefixo e squish · **S**
*(dimensao: biblioteca)*

- **Desktop:** `match_score` pontua por token (AND) com pesos title/artist/album e camadas exato>prefixo-do-campo>prefixo-de-palavra>substring, mais o fallback `squish` (alfanumerico) que casa titulos estilizados tipo 'a m a r i'.
- **Mobile hoje:** `searchTracks` faz `normalize(...).includes(q)` em title/artist/album, primeiro-que-aparecer, cap 120, sem ordenacao por relevancia nenhuma.
- **Por que importa:** Buscar 'amari' no celular NAO acha a faixa que o desktop acha; e mesmo quando acha, o resultado mais relevante pode estar na posicao 40. As funcoes ja sao puras e testadas no Rust — replicar em TS e barato.
- **Risco/restricao:** Nenhum tecnico. So cuidar do custo: 1746 faixas x tokens por keystroke em WebView de celular pede debounce/memo.
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/query.rs:334`, `src-tauri/crates/library-indexer/src/query.rs:368`, `src-tauri/src/desktop.rs:262`
- **Ancoras mobile:** `src/mobile/derive.ts:118`, `src/mobile/screens/Search.tsx:61`

### `sheet-primitive` — Não existe primitivo de bottom-sheet (scrim + panel + grab) · **S**
*(dimensao: telas)*

- **Desktop:** O handoff mobile define duas sheets no shell — track info e mood station — com scrim clicável, alça (.grab) e painel deslizante (docs/design-refs/design_handoff_mobile/Rustify Mobile.html:41-42), abertas/fechadas por data-open e [data-close] (mesmo arquivo :69-70). No desktop o papel equivalente é feito por Portal (TrackContextMenu) e drawer (src/components/QueueDrawer.tsx:50-52).
- **Mobile hoje:** O CSS mobile registra explicitamente que as regras .sheet/.kv/.moodgrp/.chipwrap/.field foram removidas do porte (src/mobile/styles/app.css:8-10). Nenhum componente de sheet em src/mobile/components/.
- **Por que importa:** É o pré-requisito estrutural de metade das interações que faltam: menu de faixa, track info, criação de station, escolha de destino, confirmações. Sem ele qualquer feature nova vira tela cheia ou não sai.
- **Risco/restricao:** Precisa respeitar env(safe-area-inset-bottom) (o app já usa viewport-fit=cover, MobileApp.tsx:150-154) e fechar no botão voltar do Android — ou seja, deveria empilhar como rota (#/sheet/...) e não como estado solto, senão o voltar sai da tela em vez de fechar a sheet.
- **Ancoras desktop:** `docs/design-refs/design_handoff_mobile/Rustify Mobile.html:41`, `src/components/QueueDrawer.tsx:50`
- **Ancoras mobile:** `src/mobile/styles/app.css:8`, `src/mobile/MobileApp.tsx:126`

### `search-parity` — Busca mobile: sem debounce, sem limpar campo, sem busca por letra, sem semântica/mood · **S** _[OVERSTATED]_
*(dimensao: telas)*

- **Desktop:** Busca do palette é debounced (src/components/CommandPalette.tsx:251) e o backend expõe lib_semantic_search e lib_mood_search (src/tauri.ts:167, :178). O handoff mobile previa o chip "Lyrics" na barra de escopos (docs/design-refs/design_handoff_mobile/screens.js:46).
- **Mobile hoje:** Filtro client-side síncrono a CADA tecla sobre 1746 faixas + álbuns + artistas + pastas (src/mobile/screens/Search.tsx:60-70, :92), sem debounce. Campo sem botão de limpar e a lista de buscas recentes não tem como ser apagada (src/mobile/screens/Search.tsx:112-133). O cabeçalho declara a ausência de busca semântica (:6-7).
- **Por que importa:** São detalhes que decidem a sensação do app: digitar travando e não ter um X para limpar são as duas primeiras coisas que se percebe. A busca por LETRA, ao contrário da semântica, é viável offline — o payload lyrics_text já existe do lado do desktop e pode ir no manifest.
- **Risco/restricao:** Busca semântica por texto está fora por restrição dura (sem embedder no aparelho) — não prometer isso. Só substring em letra é honesto.
- **Depende de:** export de lyrics_text no manifest (scripts/android/export_manifest.py) para o chip Lyrics
- **Ancoras desktop:** `src/components/CommandPalette.tsx:251`, `src/tauri.ts:167`, `docs/design-refs/design_handoff_mobile/screens.js:46`
- **Ancoras mobile:** `src/mobile/screens/Search.tsx:92`, `src/mobile/screens/Search.tsx:60`, `src/mobile/screens/Search.tsx:112`
- **Veredito do cetico:** Confirmado o que e do frontend: busca mobile e sincrona a cada tecla (Search.tsx:60-70 memos + :92 onInput) sobre 1746 faixas, sem debounce, sem botao de limpar, e a lista de recentes (Search.tsx:112-133) nao tem como ser apagada — tudo gap real. Mas 'sem busca semantica/mood' NAO e paridade perdida com o desktop: grep em src/views, src/components e src/store mostra ZERO consumidores de libSemanticSearch (tauri.ts:167) e libMoodSearch (tauri.ts:178) — sao bindings mortos, o desktop tambem so faz filtro client-side. Reclassificar como gap de handoff (chip 'Lyrics', screens.js S.search), nao de paridade.

### `np-track-info` — Now Playing sem "Track info" e sem specs técnicas · **S**
*(dimensao: telas)*

- **Desktop:** Badge de formato sobre a capa e duas linhas de specs (kHz, bit, formato, canais, sink, cadeia DSP) — src/views/NowPlaying.tsx:287-334; tech pill na PlayerBar (src/components/PlayerBar.tsx:625-640). O handoff mobile tinha o botão "Track info" abrindo a sheet de kv (docs/design-refs/design_handoff_mobile/Rustify Mobile.html:29, :41).
- **Mobile hoje:** Não existe; o cabeçalho do NP mobile explica que codec/bitrate não estão no shape de Track (src/mobile/components/NowPlaying.tsx:9-10). A statusbar falsa do protótipo (FLAC · 44.1) também ficou fora por decisão correta (src/mobile/MobileApp.tsx:9-11).
- **Por que importa:** É identidade do produto ("bit-perfect"), e o dado é obtível: o Media3 expõe Format (sampleRate, channelCount, codecs, bitrate) na track selecionada — não precisa vir do manifest.
- **Risco/restricao:** Format do ExoPlayer só fica disponível depois do onTracksChanged; se a UI ler cedo demais mostra "—" e pisca.
- **Depende de:** sheet-primitive, campo format no PlaybackState do plugin
- **Ancoras desktop:** `src/views/NowPlaying.tsx:309`, `src/components/PlayerBar.tsx:625`, `docs/design-refs/design_handoff_mobile/Rustify Mobile.html:29`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:9`, `src/mobile/types.ts:12`

### `scroll-restore` — Voltar de uma sub-tela zera a rolagem da lista · **S**
*(dimensao: telas)*

- **Desktop:** Cada rota é um componente remontado no RouterView (src/router.tsx:70-76); a lista longa de faixas é a mesma da view e o desktop não tem a operação "voltar" (navegação é por sidebar).
- **Mobile hoje:** Um createEffect zera scrollTop a CADA mudança de baseRoute, inclusive quando a mudança veio do botão voltar do Android (src/mobile/MobileApp.tsx:114-119). Rolar 400 faixas, abrir uma, voltar → topo.
- **Por que importa:** É o atrito mais irritante de navegação em celular, e o app tem listas de 1746 itens. O handoff também zerava (Rustify Mobile.html:64), mas lá não havia botão voltar de verdade.
- **Risco/restricao:** Interage com o LazyList: restaurar o scroll exige restaurar também o limite de itens renderizados (src/mobile/components/ui.tsx:72-78), senão o offset salvo aponta para além do conteúdo montado.
- **Ancoras desktop:** `src/router.tsx:70`
- **Ancoras mobile:** `src/mobile/MobileApp.tsx:114`, `src/mobile/nav.ts:59`

### `pull-to-refresh` — Sem pull-to-refresh; re-scan só escondido em Settings · **S** _[OVERSTATED]_
*(dimensao: telas)*

- **Desktop:** Rescan em Settings com label de progresso e botão desabilitado durante a varredura (src/views/Settings.tsx:493-513).
- **Mobile hoje:** Re-scan existe e está correto (src/mobile/screens/Settings.tsx:91-105, src/mobile/store.ts:302-316), mas é o único caminho: depois de sincronizar músicas novas para o aparelho, é preciso ir a Settings. Nenhuma tela responde a puxar-para-atualizar.
- **Por que importa:** Puxar para atualizar é a convenção do Android; o fluxo real (sincronizar acervo pelo script, abrir o app, ver que faltam faixas) termina numa caça ao botão.
- **Risco/restricao:** O gesto compete com o overscroll do WebView; precisa de overscroll-behavior: contain e limiar de distância, senão dispara sem querer no topo da lista.
- **Ancoras desktop:** `src/views/Settings.tsx:493`
- **Ancoras mobile:** `src/mobile/screens/Home.tsx:32`, `src/mobile/screens/Library.tsx:34`, `src/mobile/store.ts:302`
- **Veredito do cetico:** O fato bate: re-scan so em Settings (Settings.tsx:91-105 -> store.ts:302-316, com disabled durante o scan) e nenhuma tela responde a puxar-para-atualizar. Mas isso NAO e gap de paridade com o desktop — o desktop tambem so tem rescan em Settings (views/Settings.tsx:~493-510) e nem watcher aparece no mobile. E gap de idioma de plataforma (Android), legitimo de listar, desde que nao seja creditado ao desktop.

### `haptics` — Zero feedback tátil — categoria inteira ausente · **S**
*(dimensao: visual)*

- **Desktop:** N/A por hardware (é o único eixo onde o MOBILE deveria superar o desktop).
- **Mobile hoje:** grep por vibrate/haptic em src/, src-tauri/src e no plugin Kotlin: nenhuma ocorrência. Play/pause, skip, seek-release, troca de shape/renderer, long-press e o toast não vibram.
- **Por que importa:** Num app de música tocado com o polegar, haptics é o feedback primário — a UI mobile hoje é muda ao toque. É o detalhe fino de maior retorno por linha de código.
- **Risco/restricao:** navigator.vibrate no WebView Android é grosseiro (só duração) e exige permissão VIBRATE no manifest. O bom é HapticFeedbackConstants via o plugin Kotlin — e aí vale a regra dura: command novo DEVE ser async fn com AppHandle<R>.
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:241`, `src/mobile/components/NowPlaying.tsx:100`, `src/mobile/screens/Settings.tsx:49`

### `lib-sem-menu-contexto` — Faixa no mobile so tem uma acao: tocar · **M**
*(dimensao: biblioteca)*

- **Desktop:** Menu de contexto (right-click) em toda linha: Play, Shuffle a partir daqui, Play next, Add to queue, Like/Unlike (sem fechar o menu, feedback imediato), Ir pro album, Ir pro artista — com clamp de viewport e dismiss por Esc/click-fora.
- **Mobile hoje:** `TrackRow` e um `<button>` com um unico onClick. Nao ha long-press, nem sheet, nem 'tocar em seguida', nem 'ir pro artista' a partir da linha.
- **Por que importa:** E o gap de micro-interacao mais caro do mobile: no celular, long-press e o gesto natural e sua ausencia obriga o usuario a voltar telas pra qualquer acao secundaria.
- **Risco/restricao:** Metade dos itens do menu depende de coisas que nao existem no mobile (like, enqueue). Um sheet com itens mortos e pior que sheet nenhum — entregar junto com os trilhos.
- **Depende de:** lib-fila-manipulacao, lib-sem-like
- **Ancoras desktop:** `src/components/TrackContextMenu.tsx:128`, `src/components/TrackRowTable.tsx:40`, `src/components/TrackRowList.tsx:51`
- **Ancoras mobile:** `src/mobile/components/TrackRow.tsx:26`

### `track-context-menu` — Sem long-press / menu de contexto de faixa · **M**
*(dimensao: telas)*

- **Desktop:** Menu de contexto completo com Play, Shuffle (mantém a clicada em [0]), Play Next, Add to Queue, Like/Unlike, Go to Album, Go to Artist, com clamp ao viewport, dismiss por Esc/click-outside e rAF anti-auto-fechamento (src/components/TrackContextMenu.tsx:118-165, :28-67). Disparado por right-click em toda linha de faixa (src/components/TrackRowList.tsx:51, src/components/TrackRowTable.tsx:40), no palette (src/components/CommandPalette.tsx:294) e no Now Playing (src/views/NowPlaying.tsx:265).
- **Mobile hoje:** A linha de faixa só tem onClick que toca (src/mobile/components/TrackRow.tsx:26). Não há long-press, nem menu, nem bottom-sheet de ações em lugar nenhum do app mobile.
- **Por que importa:** É o hub de ações por faixa. Sem ele o mobile não tem "tocar depois", "adicionar à fila", "like" nem "ir para o álbum/artista" a partir de uma lista — todo gesto vira "substituir a fila inteira e tocar agora".
- **Risco/restricao:** Long-press no WebView compete com o menu nativo de seleção de texto e com o scroll; precisa de contextmenu/touch timers com cancelamento por movimento, senão o menu abre durante rolagem.
- **Depende de:** sheet-primitive, enqueue-commands, like-trilho
- **Ancoras desktop:** `src/components/TrackContextMenu.tsx:118`, `src/components/TrackRowList.tsx:51`, `src/components/TrackRowTable.tsx:40`
- **Ancoras mobile:** `src/mobile/components/TrackRow.tsx:26`, `src/mobile/components/ui.tsx:55`

---

## Epic G — Customizacao: Tweaks, temas e light/dark

O hub canonico de customizacao do projeto nao existe no aparelho. Dark-only, fonte fixa, zero knobs.


### `wcag-ink-enforcement` — Enforcement de contraste do ink (piso 3:1) ausente no mobile · **XS** _[OVERSTATED]_
*(dimensao: visual)*

- **Desktop:** Duas camadas com a mesma matemática: backend ensure_bg_ink_contrast corrige --bg-ink < 3:1 na saída do load_theme; frontend resolveInk aplica ensureInkContrast (MIN_INK_CONTRAST = 3.0) cobrindo knob manual, tema e default.
- **Mobile hoje:** applyAdaptiveColor confia inteiramente no deriveInk (que mira 4:1 por conta própria) e escreve o triplet direto. Se deriveInk devolver null, remove a var e cai no default do tokens.css; não há piso aplicado sobre o valor final.
- **Por que importa:** Na prática o mobile fica coberto pelo alvo interno do deriveInk, mas sem a rede de segurança: qualquer novo caminho de ink (tema, knob) entra sem piso e pode nascer invisível.
- **Risco/restricao:** Baixo — ensureInkContrast já é importável de src/lib/color.ts (compartilhado). Só vira crítico junto com o gap themes-yaml.
- **Ancoras desktop:** `src/store/tweaks.ts:369`, `src/store/tweaks.ts:381`, `src/store/tweaks.ts:388`
- **Ancoras mobile:** `src/mobile/adaptiveColor.ts:43`, `src/mobile/adaptiveColor.ts:52`
- **Veredito do cetico:** O mobile NAO 'confia cegamente': ele usa o MESMO modulo compartilhado do desktop — adaptiveColor.ts:20 importa deriveInk de src/lib/inkDerive.ts, onde INK_CONTRAST_TARGET=4.0 (inkDerive.ts:13) e walkLForContrast (inkDerive.ts:38) ja levam a luminancia ate 4:1 contra o canvas. O que de fato falta e so a rede de seguranca final: o piso ensureInkContrast(3.0) que o desktop aplica POR CIMA do resultado em resolveInk (tweaks.ts:369 MIN_INK_CONTRAST, :388) para o caso do walk nao alcancar o alvo, e a camada de backend (ensure_bg_ink_contrast, desktop.rs:1034) que so existe porque ha temas YAML. Ancora mobile off-by-um: applyAdaptiveColor comeca em adaptiveColor.ts:41 e o setProperty do triplet esta em :54-56.

### `tweak-type-mono` — Knob Type (Sans/Mono para a UI inteira) não existe · **XS**
*(dimensao: visual)*

- **Desktop:** Segmented Type escreve html.dataset.type='mono', trocando a UI inteira para a família mono.
- **Mobile hoje:** Mono só aparece em classes pontuais (.mono no hint de pasta em Settings). Nenhum toggle global.
- **Por que importa:** Detalhe estético que o usuário usa; o mobile já tem a JetBrains Mono bundlada — o custo é só o data attr + regras CSS.
- **Risco/restricao:** Mono em tela estreita quebra layouts de título longo; precisa de teste nas listas.
- **Ancoras desktop:** `src/store/tweaks.ts:221`, `src/views/Tweaks.tsx:169`
- **Ancoras mobile:** `src/mobile/screens/Settings.tsx:88`, `src/mobile/styles/tokens.css:40`

### `tweak-adaptive-toggles` — Toggles Adaptive ink / Adaptive accent não existem (comportamento é forçado ON) · **XS**
*(dimensao: visual)*

- **Desktop:** Dois Segmented (Album/Off) governam adaptiveInk e adaptiveAccent; desligados, o ink volta ao tema e o accent é restaurado a partir do snapshot themeVar (removeProperty cairia nos :root, apagando o tema).
- **Mobile hoje:** applyAdaptiveColor é chamado incondicionalmente no createEffect; o 'off' é implícito só quando dominant_color é null (aí removeProperty devolve o tokens.css). Sem knob.
- **Por que importa:** Capa feia/estourada contamina a UI inteira e o usuário não tem como desligar no aparelho.
- **Risco/restricao:** Trivial (guard no createEffect + persistência). Sem tema no mobile, o 'off' cai no tokens.css — semântica levemente diferente do desktop, o que é aceitável.
- **Ancoras desktop:** `src/views/Tweaks.tsx:227`, `src/views/Tweaks.tsx:238`, `src/store/tweaks.ts:344`
- **Ancoras mobile:** `src/mobile/MobileApp.tsx:121`, `src/mobile/adaptiveColor.ts:45`

### `safe-area-parcial` — Safe areas: só top e bottom; laterais (landscape/notch) não são tratadas · **XS**
*(dimensao: visual)*

- **Desktop:** N/A.
- **Mobile hoje:** tokens.css:80-81 define --safe-t e --safe-b a partir de env(safe-area-inset-top/bottom). Não há --safe-l/--safe-r. Em landscape no S24 o notch/curvatura fica na LATERAL e o conteúdo passa por baixo.
- **Por que importa:** O manifest permite rotação (configChanges com orientation|screenSize, sem screenOrientation travado) — logo o app RODA em landscape com layout que não previu inset lateral.
- **Risco/restricao:** Baixo. viewport-fit=cover já está setado (MobileApp.tsx:152), então env() responde — só faltam as duas vars e o consumo no shell.
- **Ancoras mobile:** `src/mobile/styles/tokens.css:80`, `src/mobile/MobileApp.tsx:150`, `src-tauri/gen/android/app/src/main/AndroidManifest.xml:18`

### `reduced-motion` — prefers-reduced-motion ignorado no mobile · **XS**
*(dimensao: visual)*

- **Desktop:** extractor-lab.css:1303 tem bloco @media (prefers-reduced-motion: reduce).
- **Mobile hoje:** Nenhuma ocorrência nos CSS mobile. O fundo animado (rAF contínuo, beat sync, shapes) roda sempre, e não há knob 'desligar fundo' — só trocar de shape/renderer.
- **Por que importa:** Acessibilidade + bateria. Um app cujo elemento visual central é um canvas animado em 60fps deveria ter um 'off'.
- **Risco/restricao:** Além do media query, o ganho real vem de parar o rAF (spectrum.ts:159 só faz early-return quando document.hidden — o loop continua agendando).
- **Ancoras desktop:** `src/styles/extractor-lab.css:1303`
- **Ancoras mobile:** `src/mobile/styles/app.css:1`, `src/mobile/bg/spectrum.ts:158`

### `bg-off-switch` — Não dá para DESLIGAR o fundo animado (nem no desktop existe, mas no celular custa bateria) · **XS**
*(dimensao: visual)*

- **Desktop:** Não há off explícito — o dispatch é sempre shape x renderer.
- **Mobile hoje:** Idem, e o rAF roda enquanto o app está em foreground independentemente de estar tocando (o mock parava quando pausado; com FFT real o canvas segue animando pelo breath/clock).
- **Por que importa:** Único eixo onde o mobile PRECISA de um knob que o desktop não precisa. Bateria é restrição de plataforma, não de paridade.
- **Risco/restricao:** Se o fundo desliga, o --bg-ink-rgb adaptativo perde o consumidor principal; garantir que o accent continue aplicado.
- **Ancoras desktop:** `src/renderers.ts:188`
- **Ancoras mobile:** `src/mobile/bg/spectrum.ts:158`, `src/mobile/MobileApp.tsx:78`

### `tweak-scale` — Knob Scale (zoom global 85–125%) não existe · **S**
*(dimensao: visual)*

- **Desktop:** Slider Scale 0.85..1.25 escreve html.style.zoom, afetando TUDO inclusive px hardcoded; persiste em kv-tweaks e migra do schema antigo (fontScale/zoom).
- **Mobile hoje:** Nada. O viewport é travado com maximum-scale=1.0, user-scalable=no — o usuário não tem nem o pinch-zoom do sistema como escape.
- **Por que importa:** Acessibilidade básica em tela pequena. Hoje o tamanho do texto do app é imutável e o zoom nativo está deliberadamente desligado.
- **Risco/restricao:** html.style.zoom no WebView Android funciona, mas interage mal com env(safe-area-inset-*) e com a geometria do canvas de fundo (ResizeObserver re-dispara). Testar dock/mini-player e o NowPlaying com zoom != 1.
- **Ancoras desktop:** `src/store/tweaks.ts:212`, `src/views/Tweaks.tsx:180`
- **Ancoras mobile:** `src/mobile/MobileApp.tsx:150`, `src/mobile/styles/tokens.css:16`

### `tweak-density` — Knob Density (normal/compact) não existe · **S**
*(dimensao: visual)*

- **Desktop:** Segmented Density escreve html.dataset.density='compact', consumido pelo CSS pra apertar linhas e paddings.
- **Mobile hoje:** Densidade fixa. Nenhum data-density; o único data attr no <html> é data-platform='android'.
- **Por que importa:** Numa lista de 1746 faixas em tela de celular, compact é ganho real de itens por scroll.
- **Risco/restricao:** Exige varrer app.css pra parametrizar as alturas de linha/rows; sem isso o toggle vira botão morto.
- **Ancoras desktop:** `src/store/tweaks.ts:215`, `src/views/Tweaks.tsx:157`
- **Ancoras mobile:** `src/mobile/MobileApp.tsx:155`, `src/mobile/styles/app.css:1`

### `tweak-glow` — Knob Glow (0..1, theme-governed) não existe · **S**
*(dimensao: visual)*

- **Desktop:** Slider Glow, theme-governed: só escreve --glow se dirty; senão restaura themeVar('--glow'). Tem botão '↺ tema' quando sobrescrito.
- **Mobile hoje:** Não existe --glow em tokens.css nem knob.
- **Por que importa:** É o controle de intensidade dos halos/brilhos do design system; sem ele o mobile tem uma única intensidade.
- **Risco/restricao:** Sem tema no mobile, 'theme-governed' perde metade do sentido — vira knob simples.
- **Depende de:** themes-yaml
- **Ancoras desktop:** `src/store/tweaks.ts:226`, `src/views/Tweaks.tsx:188`
- **Ancoras mobile:** `src/mobile/styles/tokens.css:16`

### `tweak-lyrics-glass` — Knob Lyrics glass (alpha+brightness+solid) não existe · **S**
*(dimensao: visual)*

- **Desktop:** Slider único deriva --lyrics-bg-alpha (0.04..0.65) e --lyrics-bg-brightness (0.92..0.52) e, acima de 0.85, seta data-lyrics-solid='on' que DESLIGA o backdrop-filter (look full-solid). Theme-governed com reset.
- **Mobile hoje:** O card de letra tem estilo fixo (.np .lyrics em app.css:859). Não há --lyrics-bg-alpha, nem estado solid, nem knob.
- **Por que importa:** Legibilidade da letra sobre o fundo animado varia muito por capa; o desktop deixa o usuário resolver, o mobile não.
- **Risco/restricao:** backdrop-filter no WebView Android é caro; o modo 'solid' (que desliga o blur) provavelmente deve ser o DEFAULT no mobile, não o extremo.
- **Ancoras desktop:** `src/store/tweaks.ts:279`, `src/store/tweaks.ts:240`, `src/views/Tweaks.tsx:197`, `src/styles/extractor-lab.css:762`
- **Ancoras mobile:** `src/mobile/styles/app.css:859`, `src/mobile/components/NowPlaying.tsx:202`

### `tweak-bg-ink-color` — Color picker manual do Bg ink (com precedência usuário>capa>tema) não existe · **S**
*(dimensao: visual)*

- **Desktop:** <input type=color> escreve bgInk; precedência resolvida em resolveInk: usuário dirty > capa (adaptiveInk) > tema > default. Botão '↺ tema' limpa o dirty e devolve o controle à capa/tema.
- **Mobile hoje:** O ink é SEMPRE a capa (applyAdaptiveColor no createEffect) ou o default do tokens.css. Zero override do usuário e zero dirty-flag.
- **Por que importa:** Quem quer o bg numa cor fixa (ex.: carbono) não tem como travar no celular.
- **Risco/restricao:** <input type=color> no WebView Android abre o picker do sistema — verificar se o Chromium do S24 o suporta; senão precisa de picker próprio (custo sobe pra M).
- **Ancoras desktop:** `src/views/Tweaks.tsx:220`, `src/store/tweaks.ts:381`, `src/store/tweaks.ts:137`
- **Ancoras mobile:** `src/mobile/MobileApp.tsx:121`, `src/mobile/adaptiveColor.ts:43`

### `bg-reactivity-knobs` — Os 5 sliders de Bg reactivity (bass/mid/treble/smoothing/speed) não têm UI no mobile · **S**
*(dimensao: visual)*

- **Desktop:** Tweaks expõe bgBassGain, bgMidGain, bgTrebleGain, bgSmoothing e bgSpeed como sliders; o store escreve as CSS vars e o SpectrumCanvas as lê no frame loop.
- **Mobile hoje:** Paridade PARCIAL invertida: o motor mobile JÁ lê todas as cinco vars (spectrum.ts:177-184) e o tokens.css já declara os defaults, mas NENHUMA tela permite mudá-las. São knobs implementados e inacessíveis.
- **Por que importa:** Custo de expor é quase zero (a leitura já existe) e o retorno é o mesmo ajuste fino do desktop, agora com FFT real do SpectrumTap.
- **Risco/restricao:** Falta um componente de slider mobile (o Settings hoje só tem botões .selbtn e .seg). Precisa ser tátil (alvo >= 44px) e não brigar com o scroll da tela.
- **Ancoras desktop:** `src/views/Tweaks.tsx:250`, `src/views/Tweaks.tsx:282`, `src/store/tweaks.ts:262`
- **Ancoras mobile:** `src/mobile/bg/spectrum.ts:176`, `src/mobile/styles/tokens.css:56`, `src/mobile/screens/Settings.tsx:41`

### `beat-depth-continuo` — Beat depth virou 4 presets no mobile; no desktop é slider contínuo + modo separado · **S**
*(dimensao: visual)*

- **Desktop:** Dois controles independentes: Segmented bgBeatMode (off/speed/pulse) e slider contínuo bgBeatDepth 0..1 step 0.05 (a UI de 3 presets foi deliberadamente removida em 2026-07-19 pra permitir ajuste fino).
- **Mobile hoje:** beatSetting.ts colapsa os dois eixos em 4 rótulos (Off/Subtle/Default/Pulse) com depth fixo por rótulo; 'Pulse' força depth 0.85 — não dá pra ter pulse sutil nem speed forte. O hint da tela ainda diz 'no Android o pulso vem de um relógio sintético', texto DESATUALIZADO desde o beat sync real (d2db593).
- **Por que importa:** Regressão consciente do v0 que hoje contradiz o próprio código (FFT real) e a decisão de produto do desktop. Além disso o texto do hint mente pro usuário.
- **Risco/restricao:** Migração do valor persistido: a chave 'rustify-beat-mobile' guarda rótulo, não par (modo, depth). Precisa de migração como a do desktop (tweaks.ts:472).
- **Depende de:** bg-reactivity-knobs
- **Ancoras desktop:** `src/views/Tweaks.tsx:290`, `src/views/Tweaks.tsx:299`, `src/store/tweaks.ts:74`
- **Ancoras mobile:** `src/mobile/bg/beatSetting.ts:11`, `src/mobile/bg/beatSetting.ts:14`, `src/mobile/screens/Settings.tsx:60`

### `dirty-flag-reset` — Micro-interação '↺ tema' (dirty-flag por knob) não tem equivalente · **S**
*(dimensao: visual)*

- **Desktop:** THEME_GOVERNED = [bgInk, lyricsGlass, glow]; tocar no knob marca dirty, a UI mostra um botão '↺ tema' inline no label, clearDirty devolve o valor ao default E o controle efetivo ao tema/capa. A lista dirty persiste em kv-tweaks.__dirty com inferência para estados salvos por versões antigas.
- **Mobile hoje:** Conceito inexistente — nenhum knob mobile é regido por tema.
- **Por que importa:** É o detalhe fino que separa 'override' de 'valor'. Sem ele, qualquer knob futuro no mobile pisa no tema pra sempre.
- **Risco/restricao:** Só faz sentido depois de existir tema no mobile; implementar antes é over-engineering.
- **Depende de:** themes-yaml, tweaks-panel-inexistente
- **Ancoras desktop:** `src/store/tweaks.ts:137`, `src/store/tweaks.ts:150`, `src/views/Tweaks.tsx:102`, `src/store/tweaks.ts:494`
- **Ancoras mobile:** `src/mobile/screens/Settings.tsx:41`

### `lyrics-card-geometria` — Card de letra: sem tamanho, posição, blur proporcional nem persistência · **S**
*(dimensao: visual)*

- **Desktop:** Card flutuante arrastável (startDrag com throttle por rAF) e redimensionável (MIN 280x220, MAX 800x800), geometria persistida em 'rustify-lyrics-card', reclamp no resize da janela, --lyrics-blur escalando com o tamanho da caixa (10px..32px) e classe is-interacting que DESLIGA o backdrop-filter durante o arrasto pra não matar o WebKit.
- **Mobile hoje:** Geometria fixa por CSS; data-lyr no .np só encolhe a capa. Sem redimensionar, sem mover, sem persistir, sem blur adaptativo.
- **Por que importa:** Arrastar/redimensionar não faz sentido em celular, mas o CONTROLE DE TAMANHO da letra faz — hoje o usuário não escolhe quanto da tela a letra ocupa.
- **Risco/restricao:** Portar drag/resize literal seria erro; o equivalente mobile é um knob de tamanho (S/M/L) ou pinch. Não confundir paridade de FEATURE com paridade de INTERAÇÃO.
- **Ancoras desktop:** `src/views/NowPlaying.tsx:70`, `src/views/NowPlaying.tsx:131`, `src/views/NowPlaying.tsx:350`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:202`, `src/mobile/styles/app.css:859`

### `tweaks-panel` — Painel Tweaks (fonte, zoom, ink, glass, adaptativos) não existe no mobile · **M**
*(dimensao: telas)*

- **Desktop:** Painel flutuante via Portal com fontes, zoom, alpha da letra, cor de ink do bg, adaptiveInk/adaptiveAccent e loudness, persistido em kv-tweaks e aplicado como CSS vars no <html> (src/views/Tweaks.tsx:1-330; src/App.tsx:97; src/components/Sidebar.tsx:172-180).
- **Mobile hoje:** Só três knobs, e dentro de Settings: renderer, shape e Beat sync (src/mobile/screens/Settings.tsx:41-75; src/mobile/bg/beatSetting.ts:29-42). Ink/accent adaptativos existem mas SEM controle — são sempre ON (src/mobile/MobileApp.tsx:121-124, src/mobile/adaptiveColor.ts).
- **Por que importa:** O CLAUDE.md do projeto define o Tweaks como o hub canônico de customização. No mobile, tamanho de fonte é acessibilidade real (tela pequena, leitura em movimento) e não tem nenhum controle.
- **Risco/restricao:** Zoom via CSS var no mobile briga com o layout de largura fixa do handoff (grids de 2 colunas); precisa de teste em 360dp antes de expor.
- **Ancoras desktop:** `src/views/Tweaks.tsx:1`, `src/App.tsx:97`, `src/components/Sidebar.tsx:172`
- **Ancoras mobile:** `src/mobile/screens/Settings.tsx:36`, `src/mobile/adaptiveColor.ts:1`

### `theme-yaml-mobile` — Sem tema (light/dark/auto nem YAML) · **M**
*(dimensao: telas)*

- **Desktop:** Segmented Light/Dark/Auto + tema YAML custom com validação WCAG no backend (src/views/Settings.tsx:305-320). O handoff mobile trouxe as duas linhas (docs/design-refs/design_handoff_mobile/screens.js:103-104).
- **Mobile hoje:** Paleta "really dark" fixa em tokens (src/mobile/styles/tokens.css) — nenhum seletor. Settings declara o corte (src/mobile/screens/Settings.tsx:9-13).
- **Por que importa:** É o único app do usuário que não segue nem o tema do sistema. E o pipeline de temas (theme-maker, validate.py) já existe — o mobile só não consome.
- **Risco/restricao:** O checker WCAG do backend (ensure_bg_ink_contrast) não roda no mobile — tema mal formado entregaria ink invisível, exatamente o bug que o enforcement do desktop existe para evitar.
- **Depende de:** load_theme é desktop-only; no mobile teria que ler o YAML do manifest dir ou embutir os temas no bundle
- **Ancoras desktop:** `src/views/Settings.tsx:305`, `src-tauri/src/lib.rs:1`
- **Ancoras mobile:** `src/mobile/styles/tokens.css:1`, `src/mobile/screens/Settings.tsx:9`

### `tweak-fonts` — Seleção de fonte UI/Mono não existe (e nem poderia usar list_system_fonts) · **M**
*(dimensao: visual)*

- **Desktop:** FontSelect popula com o command list_system_fonts, escreve --font-sans/--font-mono no <html> com stack de fallback, e no caminho 'unset' RESTAURA o que o tema declarou (removeProperty mataria a fonte do tema).
- **Mobile hoje:** Três famílias fixas bundladas via @fontsource (Inter, Fraunces, JetBrains Mono) importadas no MobileApp e declaradas como --font/--display/--mono. Sem seletor, sem command list_system_fonts em mobile.rs.
- **Por que importa:** Tipografia é o knob mais visível do Tweaks. No celular a escolha é zero.
- **Risco/restricao:** list_system_fonts não faz sentido no Android (fontes do sistema não são enumeráveis/utilizáveis do mesmo jeito). O caminho viável é um seletor entre N famílias BUNDLADAS — cada uma custa KB no APK.
- **Ancoras desktop:** `src/views/Tweaks.tsx:56`, `src/store/tweaks.ts:168`, `src/store/tweaks.ts:188`
- **Ancoras mobile:** `src/mobile/MobileApp.tsx:19`, `src/mobile/styles/tokens.css:38`

### `tweaks-panel-inexistente` — Não há painel de Tweaks — nem overlay, nem reset, nem persistência unificada · **M**
*(dimensao: visual)*

- **Desktop:** Painel <Portal> único, aberto pelo evento 'toggle-tweaks', com divisores por seção (Layout/Tipografia/Escala e Efeitos/Bg reactivity/Loudness), botão 'Redefinir tudo' (resetTweaks) e persistência única em kv-tweaks com __dirty.
- **Mobile hoje:** As poucas preferências existentes estão espalhadas em CHAVES SOLTAS de localStorage: rustify-shape-mobile, rustify-renderer-mobile (spectrum.ts:22), rustify-beat-mobile (beatSetting.ts:15), kv-mobile-lyrics (NowPlaying.tsx:26), kv-mobile-queue (store.ts:19). Sem schema, sem migração, sem reset.
- **Por que importa:** Sem um store único não há 'redefinir tudo', não há versionamento de schema e cada knob novo inventa a própria chave — exatamente a dívida que o kv-tweaks do desktop resolveu.
- **Risco/restricao:** Cuidado com a armadilha já documentada: createEffect module-level roda síncrono no import e salva DEFAULTS por cima do persistido — o gate _loaded (tweaks.ts:515) é obrigatório se o padrão for replicado.
- **Ancoras desktop:** `src/views/Tweaks.tsx:138`, `src/views/Tweaks.tsx:323`, `src/store/tweaks.ts:14`, `src/store/tweaks.ts:446`
- **Ancoras mobile:** `src/mobile/bg/spectrum.ts:22`, `src/mobile/bg/beatSetting.ts:15`, `src/mobile/components/NowPlaying.tsx:26`

### `landscape-tablet` — Nenhum layout responsivo: zero media queries de largura/orientação no CSS mobile · **M**
*(dimensao: visual)*

- **Desktop:** O desktop reflowa por natureza (janela redimensionável; NowPlaying reclampa a caixa de letra no resize).
- **Mobile hoje:** grep por @media em src/mobile/styles/*.css retorna NADA além do env(). Layout desenhado para 360x780 (o .device do handoff virou viewport cheia). Em landscape o NowPlaying (capa + letra + controles empilhados verticalmente) não cabe; em tablet/dobrável tudo estica.
- **Por que importa:** Rotacionar o telefone é gesto trivial e o app não tem plano B. O canvas de fundo já corrige aspecto (aspectFn), mas a UI não.
- **Risco/restricao:** Alternativa honesta e barata: TRAVAR portrait no manifest (screenOrientation=portrait) e assumir a decisão, em vez de fingir suporte. Decisão do CEO.
- **Depende de:** safe-area-parcial
- **Ancoras desktop:** `src/views/NowPlaying.tsx:122`
- **Ancoras mobile:** `src/mobile/styles/app.css:1`, `src/mobile/bg/spectrum.ts:151`, `src/mobile/MobileApp.tsx:126`

### `settings-mobile-minima` — Settings mobile e um subconjunto minusculo e sem preferencias persistidas alem do fundo · **M**
*(dimensao: plataforma)*

- **Desktop:** src/views/Settings.tsx (28KB): update flow, stats da biblioteca, volume + normalize, theme picker dinamico, resume on launch, compact sidebar, pastas, fontes do sistema.
- **Mobile hoje:** src/mobile/screens/Settings.tsx (5KB): renderer/shape do fundo, beat sync, raiz do acervo, re-scan, stats e About estatico. O proprio cabecalho lista o que ficou de fora por nao haver command.
- **Por que importa:** Preferencias que o usuario espera (retomar ao abrir, tema, ordenacao) nao tem onde morar; e o Tweaks (hub canonico de customizacao no desktop) nao tem equivalente mobile.
- **Risco/restricao:** Metade dos knobs do desktop depende de backend inexistente no Android (EQ/DSP/volume/temas YAML). Portar so o que tem trilho, senao vira botao morto — o cabecalho atual acertou nisso.
- **Depende de:** resume-sessao
- **Ancoras desktop:** `src/views/Settings.tsx:10`, `src/views/Settings.tsx:184`, `src/views/Tweaks.tsx:1`
- **Ancoras mobile:** `src/mobile/screens/Settings.tsx:1`, `src/mobile/screens/Settings.tsx:6`, `src/mobile/bg/beatSetting.ts:1`

### `themes-yaml` — Sistema de temas YAML inexistente no mobile · **L**
*(dimensao: visual)*

- **Desktop:** list_themes lê ~/.local/share/rustify-player/themes/*.yaml, load_theme parseia o schema (tones/glass/radius/shadows/motion/background.ink/effects.halo) e devolve vars + checks WCAG; watch_theme faz hot-reload por arquivo; Settings tem picker dinâmico com 'sem tema' (clearThemeVars).
- **Mobile hoje:** Tema ÚNICO hardcoded em CSS. tokens.css declara a paleta fixa (--s-base #0c0c0c, --accent #997081 etc). Nenhum command de tema em mobile.rs (11 commands: lib_*). adaptiveColor.ts comenta explicitamente 'o mobile tem tema único'.
- **Por que importa:** Toda a camada de identidade visual customizável do desktop — 12+ temas curados pelo theme-maker — não existe no aparelho. O usuário que montou tema no desktop vê outro app no celular.
- **Risco/restricao:** YAML no aparelho exige um canal de sync (o arquivo vive na cmr-auto). Alternativa barata: exportar os temas resolvidos (vars já computadas) junto do manifest e trocar só CSS vars — evita portar o parser Rust inteiro.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:816`, `src-tauri/src/desktop.rs:946`, `src-tauri/src/desktop.rs:1133`, `src-tauri/src/desktop.rs:1279`, `src-tauri/src/desktop.rs:3264`, `src/views/Settings.tsx:132`
- **Ancoras mobile:** `src-tauri/src/mobile.rs:143`, `src/mobile/styles/tokens.css:16`, `src/mobile/adaptiveColor.ts:23`

### `light-dark-mode` — Modo Light/Dark/Auto não existe; o mobile é dark-only sem respeitar o sistema · **L**
*(dimensao: visual)*

- **Desktop:** Segmented Light/Dark/Auto em Settings escreve body[data-theme], persiste em 'rustify-theme-mode' e reaplica no boot.
- **Mobile hoje:** tokens.css é uma paleta escura fixa em :root. Zero @media (prefers-color-scheme) nos CSS mobile (grep confirmou: só safe-area em tokens.css:80-81). O AndroidManifest declara uiMode em configChanges, ou seja, a troca de tema do sistema chega ao app e é ignorada.
- **Por que importa:** Android troca de tema por horário/sistema; o app fica preto no meio do dia enquanto o resto do aparelho está claro. E o comentário de Settings.tsx:9 assume a decisão como definitiva.
- **Risco/restricao:** Fazer um tema claro DE VERDADE significa revisar contraste de app.css inteiro + o ink adaptativo (deriveInk usa o canvas como referência — com canvas claro o alvo muda de lado). Não é um toggle, é uma segunda paleta.
- **Ancoras desktop:** `src/views/Settings.tsx:100`, `src/views/Settings.tsx:314`, `src/views/Settings.tsx:195`
- **Ancoras mobile:** `src/mobile/styles/tokens.css:16`, `src/mobile/screens/Settings.tsx:9`, `src-tauri/gen/android/app/src/main/AndroidManifest.xml:18`

---

## Epic H — Audio: DSP, loudness e info tecnica

Sem EQ, sem normalizacao de loudness (o campo nem viaja no manifest), sem specs da faixa.


### `speed-pitch` — Velocidade de reproducao · **XS**
*(dimensao: playback)*

- **Desktop:** Nao existe no desktop tambem (nenhum command de speed em desktop.rs).
- **Mobile hoje:** Nao existe.
- **Por que importa:** Paridade ja atingida (ambos nao tem). Registrado porque foi pedido no escopo da dimensao: ExoPlayer da setPlaybackParameters de graca, entao seria mais barato no mobile que no desktop — mas nao e gap de paridade.
- **Risco/restricao:** Nenhum; e feature nova nos dois lados, nao gap.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:1512`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt:156`

### `headphone-bluetooth-detail` — Comportamento com fone/bluetooth e foco de audio · **XS**
*(dimensao: playback)*

- **Desktop:** Nada disso existe no desktop (PipeWire/GStreamer, sem foco de audio nem becoming-noisy).
- **Mobile hoje:** Paridade por outro caminho, e o mobile esta ADIANTE: handleAudioFocus=true (pausa em ligacao/outro app e retoma) e setHandleAudioBecomingNoisy(true) (desplugar o fone pausa). Falta: ducking configuravel, e o comportamento de RECONECTAR bluetooth (Android nao retoma sozinho sem AudioFocus gain).
- **Por que importa:** O basico ja esta certo. O detalhe que morde e voltar do carro/fone e o app nao retomar — hoje depende so do ganho de foco.
- **Risco/restricao:** Mexer em audio focus e classicamente regressivo (retomar demais = tocar sozinho no meio de uma ligacao). Testar no aparelho, nao no emulador.
- **Ancoras desktop:** `src-tauri/crates/audio-engine/src/output/dsp.rs:229`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt:73`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt:77`

### `formats-support` — Formatos suportados · **XS**
*(dimensao: playback)*

- **Desktop:** GStreamer/symphonia no desktop; o acervo canonico e FLAC. O player.ts inclusive carrega um FIXME assumindo FLAC porque o TrackInfo nao expoe o codec.
- **Mobile hoje:** Paridade por outro caminho: o walk mobile aceita opus/ogg/mp3/m4a/aac/flac/wav e o ExoPlayer decodifica todos. O acervo do celular e Opus por design (pipeline de sync).
- **Por que importa:** Nao ha gap real de formato. Registrado por completude — o que falta e EXIBIR o formato (ver tech-info-pill), nao suporta-lo.
- **Risco/restricao:** Nenhum.
- **Ancoras desktop:** `src/store/player.ts:270`
- **Ancoras mobile:** `src-tauri/src/mobile_library.rs:122`

### `volume-in-app` — Volume in-app e persistencia (kv-volume) + mute · **S**
*(dimensao: playback)*

- **Desktop:** Slider de volume na PlayerBar, mute com icone dedicado, fonte unica changeVolume() (store + localStorage kv-volume + IPC) e restauracao no boot com retry — volume e PREFERENCIA de dispositivo, nao estado de sessao.
- **Mobile hoje:** Nao existe volume no app: so o volume do sistema. O Settings mobile lista 'volume' entre o que saiu.
- **Por que importa:** Paridade por outro caminho é DEFENSÁVEL aqui (Android tem volume de midia por hardware/sistema e e o idioma da plataforma). O que falta de fato e o volume RELATIVO — o slider fino do app somado ao do sistema — e o mute rapido.
- **Risco/restricao:** ExoPlayer.setVolume e trivial, mas somar dois estagios de volume confunde o usuario e brigaria com o ganho de normalizacao se ambos usarem player.volume.
- **Ancoras desktop:** `src/store/player.ts:116`, `src/store/player.ts:124`, `src/components/PlayerBar.tsx:371`
- **Ancoras mobile:** `src/mobile/screens/Settings.tsx:9`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt:156`

### `sleep-timer` — Sleep timer · **S**
*(dimensao: playback)*

- **Desktop:** Nao existe no desktop (nenhum trilho encontrado).
- **Mobile hoje:** Nao existe.
- **Por que importa:** Nao e gap de paridade, mas e a feature MAIS especifica de celular desta dimensao (dormir ouvindo) e o unico lado onde faz sentido implementar primeiro. Registrado como oportunidade, nao como divida.
- **Risco/restricao:** Se implementado no JS, o WebView dorme e o timer nao dispara — tem que viver no service (Handler ja existe la).
- **Ancoras desktop:** `src-tauri/src/desktop.rs:1512`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt:239`

### `tech-info-pill` — Info tecnica da faixa tocando (formato, bits, sample rate, cadeia DSP) · **S**
*(dimensao: playback)*

- **Desktop:** Tech pill no PlayerBar mostra formato, bitDepth/sampleRate e o resumo da chain ('EQ · LIM · BASS' / 'BYPASS' / 'DSP OFF'), alimentado por TrackInfo do engine.
- **Mobile hoje:** Inexistente — o comentario do NowPlaying mobile registra: 'sem sheet de track info (codec/bitrate nao existem no shape do Track)'.
- **Por que importa:** Detalhe de nicho mas caro pro CEO: o acervo do celular e Opus 192k transcodificado, e saber que faixa esta em que qualidade e o unico jeito de perceber transcode ruim.
- **Risco/restricao:** Exige expor Format do ExoPlayer (onTracksChanged) no snapshot do plugin, ou ler no manifest. Barato mas mexe no contrato PlaybackState.
- **Ancoras desktop:** `src/store/player.ts:262`, `src/components/PlayerBar.tsx:617`
- **Ancoras mobile:** `src/mobile/components/NowPlaying.tsx:9`, `src/mobile/types.ts:1`

### `dsp-loudness-norm` — Normalizacao de loudness por LUFS (norm_gain per-track) · **M**
*(dimensao: playback)*

- **Desktop:** norm_set_enabled/norm_set_target aplicam ganho por faixa a partir do lufs_integrated medido no index, target runtime (-14 default, clamp -20..-6), re-aplicado na faixa que ja esta tocando; knob no Tweaks com debounce e push no boot.
- **Mobile hoje:** Inexistente. Cada faixa toca no volume que foi masterizada — o pulo entre um FLAC de 2005 e um master moderno e brutal.
- **Por que importa:** Em fila heterogenea (station, radio) e a diferenca entre ouvir sem tocar no volume e ficar corrigindo a cada faixa. E o manifest exportado JA carrega os campos do Qdrant, entao o dado pode vir de graca.
- **Risco/restricao:** Precisa (a) exportar lufs_integrated no manifest e (b) aplicar ganho por item. ExoPlayer nao tem ganho por MediaItem: da pra usar player.volume por faixa (perde headroom, nao clipa se so atenuar) ou um AudioProcessor. Ganho POSITIVO sem limiter clipa — atenuar-somente e a saida segura.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:1950`, `src-tauri/src/desktop.rs:1980`, `src-tauri/crates/audio-engine/src/output/dsp.rs:198`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt:291`, `scripts/android/export_manifest.py:1`

### `loudness-norm-mobile` — Normalização de loudness sem equivalente mobile · **M**
*(dimensao: telas)*

- **Desktop:** Toggle + alvo LUFS no Tweaks/Settings, aplicado via IPC ao engine (src/views/Settings.tsx:456-470; norm_set_enabled/norm_set_target em src/tauri.ts:132-137). O handoff mobile trouxe a linha "Normalizar volume entre faixas · EBU R128 −14 LUFS" (docs/design-refs/design_handoff_mobile/screens.js:113).
- **Mobile hoje:** Ausente; Settings mobile declara o corte (src/mobile/screens/Settings.tsx:9-13).
- **Por que importa:** Fone e rua: pular de uma faixa masterizada alta para uma baixa é o desconforto mais audível. O lufs_integrated por faixa já está indexado no desktop e pode viajar no manifest como ganho pré-computado.
- **Risco/restricao:** Aplicar ganho por faixa no ExoPlayer sem limiter pode clipar em faixas que precisam de ganho positivo; o desktop tem Limiter depois do norm_gain, o Android não teria.
- **Depende de:** campo lufs no manifest + ganho por item no ExoPlayer (volume ou LoudnessEnhancer)
- **Ancoras desktop:** `src/views/Settings.tsx:456`, `src/tauri.ts:132`
- **Ancoras mobile:** `src/mobile/screens/Settings.tsx:9`, `scripts/android/export_manifest.py:1`

### `dsp-eq` — Equalizador parametrico (bandas, tipo de filtro, slope, solo/mute, preamp) · **L**
*(dimensao: playback)*

- **Desktop:** Cadeia GStreamer EQ → norm_gain → Limiter → Bass, com ~40 commands dsp_* (dsp_set_eq_band, filter_type, filter_mode, slope, solo, mute, preamp, oversampling, dither...) e a tela Signal inteira (28.9K) pra dirigir.
- **Mobile hoje:** Zero DSP. O Settings mobile admite explicitamente: 'Sairam ... normalizacao de loudness ... e a tela Signal/EQ'.
- **Por que importa:** Fone no celular e onde EQ mais importa. Hoje o som sai cru.
- **Risco/restricao:** audio-engine e desktop-only (GStreamer). No Android o caminho e outro: android.media.audiofx.Equalizer (global, limitado, 5 bandas) ou um AudioProcessor proprio no DefaultAudioSink — ja existe precedente (SpectrumTap). Nao ha como portar a cadeia GStreamer.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:1562`, `src-tauri/crates/audio-engine/src/output/dsp.rs:229`, `src/views/Signal.tsx:1`
- **Ancoras mobile:** `src/mobile/screens/Settings.tsx:9`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt:59`

### `dsp-limiter-bass` — Limiter e Bass Enhancer · **L**
*(dimensao: playback)*

- **Desktop:** Estagios dedicados na chain com commands proprios (threshold, knee, lookahead, attack/release, link, drive, blend, freq, floor, bypass) e resumo na tech pill do PlayerBar ('EQ · LIM · BASS').
- **Mobile hoje:** Inexistente, e nao ha nem o indicador de cadeia.
- **Por que importa:** Menos critico que EQ/normalizacao no celular, mas o Bass Enhancer e exatamente o que compensa fone pequeno; e o limiter e o que torna seguro qualquer ganho positivo.
- **Risco/restricao:** Mesmo do EQ: reimplementacao, nao porte. android.media.audiofx tem BassBoost/LoudnessEnhancer (qualidade inferior, efeito global de sessao).
- **Depende de:** dsp-eq
- **Ancoras desktop:** `src-tauri/src/desktop.rs:1659`, `src-tauri/src/desktop.rs:1812`, `src/components/PlayerBar.tsx:415`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt:64`

### `screen-signal` — Tela Signal / cadeia DSP não existe no mobile · **L**
*(dimensao: telas)*

- **Desktop:** Rota /signal com EQ paramétrico, Limiter, Bass Enhancer e roadmap (src/views/Signal.tsx:248, :396, :473, :554), resumo da cadeia na PlayerBar (src/components/PlayerBar.tsx:414-422) e no Now Playing (src/views/NowPlaying.tsx:316-333). O handoff mobile desenhou a tela inteira, com link a partir de Settings (docs/design-refs/design_handoff_mobile/screens.js:132-136, :129).
- **Mobile hoje:** Nada. O cabeçalho de Settings lista a tela Signal/EQ entre o que saiu por não ter command (src/mobile/screens/Settings.tsx:9-13).
- **Por que importa:** Fone no celular é onde EQ mais importa. O Android tem android.media.audiofx.Equalizer/LoudnessEnhancer amarráveis ao audioSessionId do ExoPlayer — não é porte do DSP em Rust, é outra implementação com a mesma UI.
- **Risco/restricao:** audio-engine (GStreamer) é desktop-only por Cargo — nada é reaproveitado. O AudioFx do Android varia por fabricante e alguns efeitos são no-op na Samsung; risco de UI que promete o que o aparelho não entrega.
- **Depende de:** commands de DSP no plugin Kotlin
- **Ancoras desktop:** `src/views/Signal.tsx:248`, `src/views/Signal.tsx:396`, `docs/design-refs/design_handoff_mobile/screens.js:132`
- **Ancoras mobile:** `src/mobile/screens/Settings.tsx:9`, `src-tauri/crates/tauri-plugin-rustify-audio/README.md:39`

---

## Epic I — Navegacao e descoberta

Facetas ausentes, Stations quase inalcancavel, sem ordenacao, sem paleta de comandos, Crate inexistente.


### `lib-sem-pins` — Sem pin/favoritar pasta e sem preferencia persistida de faceta · **XS**
*(dimensao: biblioteca)*

- **Desktop:** store/pins persiste pastas fixadas em localStorage; a tela de Playlists tem secao 'Pinned' propria, com toggle no canto do card e ordem por ordem de pin.
- **Mobile hoje:** Nao ha pin. A faceta escolhida na Library (`createSignal<Facet>('folders')`) e efemera — volta pra Pastas a cada entrada na aba. Persistencia local so existe pra buscas recentes e espelho da fila.
- **Por que importa:** Numa lista de dezenas de pastas, fixar as 3 do momento e a diferenca entre dois toques e rolagem. E a faceta que reseta e atrito puro, resolvido com uma chave de localStorage.
- **Risco/restricao:** Nenhum.
- **Ancoras desktop:** `src/views/Playlists.tsx:57`, `src/views/Playlists.tsx:129`
- **Ancoras mobile:** `src/mobile/screens/Library.tsx:29`, `src/mobile/screens/Search.tsx:31`

### `lib-artista-sem-play` — Artista no mobile nao toca discografia em sequencia; album nao tem 'tocar a seguir' · **XS**
*(dimensao: biblioteca)*

- **Desktop:** Album/Playlist tem playAll com scope 'curated' (shuffle respeita a unidade) e o menu de contexto oferece play-next em qualquer item.
- **Mobile hoje:** A tela Artist cortou o botao Play de proposito (documentado: nao ha origin no contrato pra discografia em sequencia) e sobrou so Shuffle. Album e Folder tem Play/Shuffle, mas nenhuma acao secundaria.
- **Por que importa:** O corte foi decisao consciente e correta na epoca, mas o efeito pro usuario e uma tela de artista mais pobre que a de album sem motivo aparente.
- **Risco/restricao:** Resolver exige decidir o origin ('artist_seq'?) no contrato de sinal — mexer nos origins contamina a regua e o SIGNAL_SCHEMA. Nao inventar nome sem passar pela spec de proveniencia.
- **Depende de:** lib-fila-manipulacao
- **Ancoras desktop:** `src/views/Playlist.tsx:63`, `src/views/Albums.tsx:18`
- **Ancoras mobile:** `src/mobile/screens/Artist.tsx:4`, `src/mobile/screens/Artist.tsx:43`

### `artist-station` — Tela de Artista sem "Station" e sem Play sequencial · **XS** _[OVERSTATED]_
*(dimensao: telas)*

- **Desktop:** O handoff mobile pôs Play + Station lado a lado no artista (docs/design-refs/design_handoff_mobile/screens.js:39); o desktop tem "New from current track →" para gerar station a partir do contexto (src/views/Stations.tsx:508).
- **Mobile hoje:** Só Shuffle, com justificativa explícita: tocar a discografia em sequência não tem origin no contrato e inventar um contaminaria o motor de sinal (src/mobile/screens/Artist.tsx:4-10, :42-47). O rádio por similaridade existe, mas só dentro do Now Playing (src/mobile/components/NowPlaying.tsx:162-172 → playSimilar).
- **Por que importa:** A justificativa do Play é sólida e deve continuar valendo; já o botão "Station do artista" não esbarra nela — playSimilar usa origin `station` e já está implementado (src/mobile/store.ts:236-249). É reaproveitamento, não feature nova.
- **Risco/restricao:** playSimilar semeia por UMA faixa; semear por artista pediria média dos vetores das faixas dele — sem isso, a station do artista é só o rádio da primeira faixa, o que decepciona.
- **Ancoras desktop:** `docs/design-refs/design_handoff_mobile/screens.js:39`, `src/views/Stations.tsx:508`
- **Ancoras mobile:** `src/mobile/screens/Artist.tsx:42`, `src/mobile/store.ts:236`
- **Veredito do cetico:** O fato bate (Artist.tsx:42-47 so tem Shuffle; playSimilar so no NowPlaying.tsx:162-172), mas parte e PARIDADE POR OUTRO CAMINHO / decisao deliberada: o cabecalho de Artist.tsx:4-10 explica que 'Play sequencial' foi cortado por falta de origin no contrato de sinal — reintroduzir sem decidir o origin contamina o motor, entao nao e simples backlog de UI. O que resta como gap limpo e o botao 'Station' do artista (handoff screens.js S.artist), ja que o trilho existe (lib_similar_tracks) e so nao esta exposto fora do NP.

### `lib-generos-ausentes` — Genero existe no dado e nao existe na interface · **S** _[OVERSTATED]_
*(dimensao: biblioteca)*

- **Desktop:** `lib_list_genres` alimenta a aba Genres da Library e os chips de filtro da tela Tracks; `lib_list_tracks` aceita filtro por genre/artist/album.
- **Mobile hoje:** `genre_name` chega no Track (manifest exporta) e nenhuma tela le. Nao ha aba Generos nem chip de filtro; as facetas param em Pastas/Albuns/Artistas/Faixas.
- **Por que importa:** No acervo deste projeto a pasta de 1o nivel E o genero — filtrar por genero e a navegacao mais natural que existe, e o dado ja esta no aparelho de graca.
- **Risco/restricao:** Tags de genero do acervo sao reconhecidamente sujas (regra do projeto: classificar por artista). Genero por PASTA e mais confiavel que a tag — e o mobile ja tem as pastas.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:169`, `src/views/Library.tsx:69`, `src/views/Tracks.tsx:45`
- **Ancoras mobile:** `src/mobile/screens/Library.tsx:20`, `src/mobile/types.ts:23`
- **Veredito do cetico:** Gap parcial e a motivacao esta errada. `genre` NAO e tag: e o primeiro componente do path (scan.rs:164, `dir_comps.first()`), ou seja, exatamente a pasta de 1o nivel que o mobile ja expoe como faceta 'Pastas' (mobile_library.rs:242-247 monta folder pelo primeiro segmento de rel_path). Uma aba Generos no mobile duplicaria Pastas 1:1 — nao e gap. O que de fato falta e o FILTRO: os chips por genero na lista de faixas (Tracks.tsx:45-57) e a coluna Genre (Tracks.tsx:63); no mobile a faceta Faixas (Library.tsx:107-116) nao tem filtro nenhum, embora genre_name chegue no Track (types.ts:23). Ancora desktop.rs:169/170 (lib_list_genres) confere.

### `lib-sem-ordenacao` — Nenhuma ordenacao escolhivel em lista alguma · **S**
*(dimensao: biblioteca)*

- **Desktop:** TrackOrder tem AlbumDiscTrack, TitleAsc, RecentlyAdded, LastPlayed, Random; a tela de Playlists tem toggle ciclico de ordem (ordem da API / A-Z / Z-A) e a de Tracks tem colunas.
- **Mobile hoje:** Ordem fixa em tudo: pastas por nome (folders.sort no Rust), albuns e artistas por localeCompare pt-BR, faixas na ordem do manifest (rel_path), album por track_number.
- **Por que importa:** Sem 'adicionadas recentemente' o usuario nao acha a leva que acabou de baixar — que e justamente o que ele quer ouvir. Detalhe de baixo custo, alto uso.
- **Risco/restricao:** 'Recently added' exige um campo de data no manifest que hoje nao existe (nem no payload exportado). Sem ele so da pra oferecer A-Z/Z-A/duracao.
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/types.rs:122`, `src/views/Playlists.tsx:115`
- **Ancoras mobile:** `src/mobile/derive.ts:80`, `src/mobile/derive.ts:101`, `src-tauri/src/mobile_library.rs:273`

### `lib-mosaico-capas` — Pasta/playlist no mobile nao tem mosaico de capas · **S**
*(dimensao: biblioteca)*

- **Desktop:** FolderPlaylist carrega `cover_paths` (ate 4 capas distintas) e a UI monta mosaico 2x2 no card e no hero da playlist, com fallback colorido por tom deterministico.
- **Mobile hoje:** `Folder` so tem name e track_count. O card usa `<Cover seed={f.name}>` (placeholder por tom) e a tela Folder usa a capa da PRIMEIRA faixa.
- **Por que importa:** Identidade visual da playlist e o que faz a lista ser escaneavel de relance. O tom deterministico ja esta portado (toneFor), falta so o dado.
- **Risco/restricao:** Derivavel no aparelho a partir das tracks resolvidas (4 primeiras capas distintas da pasta) — nao precisa mudar o manifest. Custo: 4 imagens por card em grid de celular.
- **Depende de:** lib-capa-por-pasta
- **Ancoras desktop:** `src-tauri/crates/library-indexer/src/query.rs:693`, `src-tauri/src/desktop.rs:630`, `src/views/Playlists.tsx:47`
- **Ancoras mobile:** `src-tauri/src/mobile_library.rs:65`, `src/mobile/screens/Library.tsx:53`

### `genres-facet` — Faceta Gêneros ausente na Library e na Home · **S**
*(dimensao: telas)*

- **Desktop:** Library tem aba Genres e a lista de faixas filtra por chips de gênero (src/views/Library.tsx:13-22; src/views/Tracks.tsx:19-27). O handoff mobile pôs "Genres" nos chips da Library (docs/design-refs/design_handoff_mobile/screens.js:23) e uma chiprow de gêneros na Home (:19).
- **Mobile hoje:** Facetas são Pastas/Álbuns/Artistas/Faixas (src/mobile/screens/Library.tsx:20-26) e o cabeçalho justifica que Genres saiu por não ter tela de destino (:6-8) — apesar de Track já carregar genre_name (src/mobile/types.ts:23).
- **Por que importa:** O dado já está no aparelho; é derivação em memória igual a álbuns/artistas (src/mobile/derive.ts). Barato, e é o corte de humor mais usado num acervo grande.
- **Risco/restricao:** As tags de gênero do acervo são reconhecidamente sujas (regra do projeto: classificar por artista, não por tag) — a faceta pode expor lixo como se fosse verdade.
- **Ancoras desktop:** `src/views/Library.tsx:13`, `src/views/Tracks.tsx:19`, `docs/design-refs/design_handoff_mobile/screens.js:23`
- **Ancoras mobile:** `src/mobile/screens/Library.tsx:20`, `src/mobile/types.ts:23`, `src/mobile/derive.ts:1`

### `playlists-screen` — Sem tela Playlists dedicada, sem mosaico de capas, sem pin/favorito · **S**
*(dimensao: telas)*

- **Desktop:** /playlists com card por pasta e mosaico 2x2 das 4 primeiras capas distintas, pin persistido em localStorage e seção Pinned (src/views/Playlists.tsx:1-40), e /playlist/<nome> com hero grande e tracklist (src/views/Playlist.tsx:1-40). O handoff mobile tinha a tela e o botão + no cabeçalho (docs/design-refs/design_handoff_mobile/screens.js:56-63).
- **Mobile hoje:** Pastas são uma faceta da Library com capa única do primeiro item (src/mobile/screens/Library.tsx:48-64) e a tela de pasta usa a capa da primeira faixa (src/mobile/screens/Folder.tsx:28). Sem pin, sem tela própria, sem contagem agregada no Home além de "Ver todas".
- **Por que importa:** Paridade conceitual existe (pasta = playlist), mas a IDENTIDADE visual não: o mosaico 2x2 é o que faz uma playlist parecer uma playlist, e o pin é o atalho para as 3 que se usa de verdade.
- **Risco/restricao:** lib_list_folders do mobile devolve só name/track_count (src-tauri/src/mobile.rs:26-28) — para o mosaico precisa retornar até 4 cover paths distintos, como o FolderPlaylist do desktop.
- **Ancoras desktop:** `src/views/Playlists.tsx:1`, `src/views/Playlist.tsx:1`, `docs/design-refs/design_handoff_mobile/screens.js:56`
- **Ancoras mobile:** `src/mobile/screens/Library.tsx:48`, `src/mobile/screens/Folder.tsx:28`

### `deep-links` — Sem deep links / atalhos do sistema · **S**
*(dimensao: telas)*

- **Desktop:** Toda tela é endereçável por hash e a navegação interna usa isso (src/router.tsx:40-59); o desktop ainda tem atalhos globais de teclado N/H/L (src/App.tsx:50-64).
- **Mobile hoje:** O AndroidManifest tem apenas MAIN/LAUNCHER, sem intent-filter de VIEW (src-tauri/gen/android/app/src/main/AndroidManifest.xml:23-28). Não há App Shortcuts (long-press no ícone), nem entrada para "tocar station X" de fora do app.
- **Por que importa:** O roteador por hash já existe e aceita parâmetros (src/mobile/nav.ts:22-27) — a ponte para o sistema é o que falta. Atalho de "Shuffle all" no ícone é o tipo de detalhe que faz o app parecer nativo.
- **Risco/restricao:** gen/android é gerado pelo tauri-cli; edições diretas no manifest podem ser sobrescritas — precisa entrar pela configuração do Tauri ou por um manifest de sobreposição versionado.
- **Ancoras desktop:** `src/router.tsx:40`, `src/App.tsx:50`
- **Ancoras mobile:** `src/mobile/nav.ts:22`, `src-tauri/gen/android/app/src/main/AndroidManifest.xml:23`

### `busca-semantica-letra` — Busca semântica por letra e busca por mood · **M**
*(dimensao: inteligencia)*

- **Desktop:** lib_semantic_search embeda a query (BGE-M3 no serviço :3939) e busca no vetor 'lyrics'; lib_mood_search parseia MoodFilters e filtra mood_tags/activity_tags nos enrichments.
- **Mobile hoje:** Só substring normalizada sobre título/artista/álbum/pasta em memória. O chip 'Lyrics' do protótipo foi removido justamente por isso.
- **Por que importa:** 'aquela do verso sobre chuva' é caso de uso real e o acervo já tem letra no aparelho (1328 sidecars .lrc). Uma busca full-text LOCAL sobre os .lrc não é paridade semântica, mas cobre a maior parte do valor sem embedder.
- **Risco/restricao:** Restrição dura: sem embedder no aparelho, busca SEMÂNTICA offline não roda — isso é 'não aplicável'. O gap acionável é o substituto (grep nos sidecars, com índice invertido pra não ler 1300 arquivos por tecla). Mood search precisa dos enrichments exportados.
- **Depende de:** enrichments-vibe-nao-exportados
- **Ancoras desktop:** `src-tauri/src/desktop.rs:291 (lib_semantic_search)`, `src-tauri/src/desktop.rs:318 (lib_mood_search)`
- **Ancoras mobile:** `src/mobile/screens/Search.tsx:1-10 (escopo documentado)`, `src-tauri/src/mobile_lyrics.rs:1 (parser de .lrc já existe)`, `src-tauri/src/mobile_library.rs:49 (Track.lrc_path)`

### `command-palette` — Sem paleta de comandos / ações rápidas · **M**
*(dimensao: telas)*

- **Desktop:** ⌘K global com busca debounced (150ms) segmentada em Tracks/Albums/Artists + ActionItems (Shuffle all, Open queue, Open Signal, Open Settings, "Procurar na rede →" do Crate promovido ao topo quando o acervo não acha), navegação por setas, Enter, Mod+Enter = play next, Shift+Enter = enqueue (src/components/CommandPalette.tsx:103-149, :199-214, :251). Também acessível pelo item Search da sidebar (src/components/Sidebar.tsx:25, :62-69).
- **Mobile hoje:** Só a tela de busca dedicada (src/mobile/screens/Search.tsx:80-110). Não há ações/comandos misturados aos resultados nem atalho de invocação de qualquer lugar do app.
- **Por que importa:** No celular a paleta vira o "faz isso agora" sem navegar: shuffle all, abrir fila, tocar station. Hoje cada ação exige ir até a tela certa.
- **Risco/restricao:** Overlay com input focado no Android sobe o teclado e reflui o layout; sem `interactive-widget` / altura dinâmica a lista de resultados fica atrás do teclado.
- **Depende de:** sheet-primitive
- **Ancoras desktop:** `src/components/CommandPalette.tsx:103`, `src/components/CommandPalette.tsx:199`, `src/components/Sidebar.tsx:25`
- **Ancoras mobile:** `src/mobile/screens/Search.tsx:80`, `src/mobile/components/Dock.tsx:19`

### `lib-sem-busca-semantica` — Busca semantica e por mood nao rodam no aparelho · **L** _[OVERSTATED]_
*(dimensao: biblioteca)*

- **Desktop:** `lib_semantic_search` (vetor de letra via embedder HTTP) e `lib_mood_search` (filtros de mood/activity do vocabulario canonico) alimentam busca por sentido e por clima.
- **Mobile hoje:** Inexistente — o chip 'Lyrics' do handoff foi deliberadamente cortado da tela de busca.
- **Por que importa:** Buscar por 'musica pra dirigir a noite' e o diferencial do produto, e no celular e onde a intencao situacional aparece.
- **Risco/restricao:** Restricao dura: sem embedder no aparelho, texto->vetor nao roda offline. Caminhos viaveis: (a) mood search por FILTRO de payload exportado (mood/activity ja sao tokens, nao precisam de embedding) — isso e S, nao L; (b) semantica de texto so via tailnet, online-only. So o (a) e honesto como paridade.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:290`, `src-tauri/src/desktop.rs:318`
- **Ancoras mobile:** `src/mobile/screens/Search.tsx:4`
- **Veredito do cetico:** Metade do gap e 'nao aplicavel', a outra metade e portavel — e o finder juntou as duas. lib_semantic_search (desktop.rs:291-303) depende de LyricsEmbedClient::embed_text por HTTP: com a restricao dura de nao haver embedder no aparelho, isso e NAO APLICAVEL offline (so funcionaria online via tailnet). Ja lib_mood_search (desktop.rs:318-328) NAO usa embedder nenhum: e filtro de payload em track_enrichments via MoodFilters::parse. Ou seja, busca por clima e perfeitamente portavel — o bloqueio real e o gap seguinte (anotacoes de vibe nao viajam no manifest), nao a ausencia de modelo. Ancora mobile (Search.tsx:4-7) confere: o chip Lyrics foi cortado.

### `stations-criacao-delete-mobile` — Criar/apagar station no aparelho · **L**
*(dimensao: inteligencia)*

- **Desktop:** lib_create_station (seed a partir de faixas escolhidas ou mood por query, com ícone/tom/descrição) e lib_delete_station; a UI Stations.tsx tem sheet de criação.
- **Mobile hoje:** Somente consumo: as stations vêm prontas de stations.json e a tela declara 'sem criação nem delete no aparelho'. Nem o gesto 'iniciar station a partir desta faixa' está exposto como station (só playSimilar, que é fila efêmera).
- **Por que importa:** O momento natural de criar uma station é ouvindo — no celular. Hoje é preciso ir ao desktop, criar, re-exportar e re-sincronizar.
- **Risco/restricao:** Uma station criada no celular precisaria de pool: seed-based dá pra montar local com vectors.bin (recommend por seed ≈ similar), mood-based NÃO (depende de mood_tags no enrichments). E precisaria voltar pro desktop pra não sumir no próximo export (que sobrescreve stations.json).
- **Depende de:** enrichments-vibe-nao-exportados, sync-bidirecional
- **Ancoras desktop:** `src-tauri/src/desktop.rs:3758 (lib_create_station)`, `src-tauri/src/desktop.rs:3798 (lib_delete_station)`, `src/views/Stations.tsx:1`
- **Ancoras mobile:** `src/mobile/screens/Stations.tsx:2-8 (comentário de escopo)`, `src-tauri/src/mobile.rs:56 (lib_list_stations — só leitura)`

### `stations-create-delete` — Stations mobile é somente-leitura: sem criar (mood/seed), sem apagar, sem live card · **L**
*(dimensao: telas)*

- **Desktop:** Tela com feature/live card + scatter viz (src/views/Stations.tsx:430-500), criação por mood/activity com vocabulário do backend (MoodStationCreator, src/views/Stations.tsx:255-259), "New from current track →" (:508) e delete com confirmação armada em dois cliques que se desarma sozinha em 4s, guardando o ID e não um booleano (:181-196). O handoff mobile desenhou tudo: livecard, botão "Nova mood station" e a moodSheet inteira (docs/design-refs/design_handoff_mobile/screens.js:72-89).
- **Mobile hoje:** Lista de cards precomputados vinda do stations.json exportado, sem criação nem delete — o próprio cabeçalho declara isso (src/mobile/screens/Stations.tsx:1-8). O card mostra pool_size e desabilita quando 0 (:42, :63-65).
- **Por que importa:** "Rádio a partir do que estou ouvindo agora" é o gesto natural no celular; hoje só existe o rádio da faixa dentro do NP (playSimilar, src/mobile/store.ts:236). Criar station exige voltar ao desktop.
- **Risco/restricao:** Station criada no aparelho colide com o stations.json exportado (o próximo export sobrescreve). Precisa de arquivo separado para as locais, ou a criação vira só "seed efêmera da sessão".
- **Depende de:** sheet-primitive, persistência local de stations criadas + reconciliação com o export do desktop
- **Ancoras desktop:** `src/views/Stations.tsx:181`, `src/views/Stations.tsx:255`, `docs/design-refs/design_handoff_mobile/screens.js:84`
- **Ancoras mobile:** `src/mobile/screens/Stations.tsx:1`, `src/mobile/store.ts:236`, `src-tauri/src/mobile_intel.rs:1`

### `screen-crate` — Crate (busca + download Soulseek) não existe no mobile · **XL** _[OVERSTATED]_
*(dimensao: telas)*

- **Desktop:** Aba própria com busca na rede, agrupamento de resultados, fila de jobs em voo/terminadas, seletor de destino e guard-rails de pacing (src/views/Crate.tsx:773, :895, :957-974), entrada pelo ⌘K (src/components/CommandPalette.tsx:93-101) e badge de jobs ativos na sidebar (src/components/Sidebar.tsx:95-97). O handoff mobile desenhou a tela Crate e a QUINTA aba do tabbar (docs/design-refs/design_handoff_mobile/screens.js:50-54; Rustify Mobile.html:53).
- **Mobile hoje:** Nada. O tabbar tem 4 abas e o comentário explica que Crate saiu junto com a tela (src/mobile/components/Dock.tsx:8-9, :19-24); a Home também deixou o quick start de fora (src/mobile/screens/Home.tsx:4-6).
- **Por que importa:** É a via de aquisição do acervo. No celular ela não precisa baixar nada localmente: bastaria disparar o job no slskd da cmr-auto pela tailnet e acompanhar o estado — o download continua onde sempre esteve.
- **Risco/restricao:** ureq no Android é SEM TLS e o slskd/Crate vive na cmr-auto: só funciona dentro da tailnet, e o app precisa degradar com clareza quando o WireGuard está fora. Baixar direto no aparelho está fora de questão (layout canônico do acervo + indexação vivem no desktop).
- **Depende de:** endpoint HTTP na cmr-auto (o receptor de sync em src/sync_receiver.rs já é o precedente arquitetural)
- **Ancoras desktop:** `src/views/Crate.tsx:773`, `src/components/CommandPalette.tsx:93`, `src/components/Sidebar.tsx:95`
- **Ancoras mobile:** `src/mobile/components/Dock.tsx:19`, `src/mobile/screens/Home.tsx:4`
- **Veredito do cetico:** A ausencia no mobile e real (Dock.tsx:8-9 e :19-24 com 4 abas; nenhum crate em src/mobile/). Mas duas correcoes: (1) o Crate do HANDOFF nao e o Crate do desktop — S.crate em screens.js e triagem LOCAL do acervo (chips Unsorted/Flagged/Duplicates/No tags/Low bitrate, 'Tag all'/'Move…'), nao busca Soulseek; citar o handoff como spec da tela de download e incorreto; (2) o Crate desktop e estruturalmente nao-portavel (slskd vive na cmr-auto, slskd-client e target-gated desktop-only), entao o item pertence a categoria 'nao aplicavel/depende de trilho remoto', nao a backlog de tela. Ancoras desktop conferidas (Crate.tsx:773 header, :957+ jobs em voo/terminadas; Sidebar.tsx:95-97 badge).

---

## Epic J — Plataforma: operacao, seguranca e distribuicao

Permissao por cabo, sync sem auth, backup do Google bifurcando identidade, APK manual, sem observabilidade.


### `notificacao-permissao-ux` — POST_NOTIFICATIONS pedida no boot sem contexto e sem fallback visivel · **XS**
*(dimensao: plataforma)*

- **Desktop:** Controles de midia via MPRIS/souvlaki, sem permissao de usuario envolvida.
- **Mobile hoje:** AudioPlugin pede POST_NOTIFICATIONS dentro do initialize; a UI chama initialize com bootCall e, se falhar, so faz console.error. Negada a permissao, nao ha mensagem nem caminho de reparo — o usuario perde a notificacao de midia sem saber por que.
- **Por que importa:** Notificacao de midia e o controle principal no celular (tela de bloqueio, fone). Perder isso silenciosamente por um tap errado no primeiro boot e caro.
- **Risco/restricao:** Android 13+ so mostra o dialogo uma vez; depois so via Settings do sistema. Precisa detectar 'denied permanently' e oferecer deep link, senao o botao nao faz nada.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:2377`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt:112`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt:114`, `src/mobile/store.ts:340`

### `versao-app-invisivel` — Versao/commit do app nao aparece na UI mobile (mas e carimbada nos eventos) · **XS** _[WRONG_ANCHORS]_
*(dimensao: plataforma)*

- **Desktop:** release.sh grava 'VERSION · commit' em build-metadata/VERSION que o .deb embarca, e o Settings mostra versao + update flow.
- **Mobile hoje:** O worker de sync usa app.package_info().version pra carimbar app_version nos eventos, mas a tela Settings mostra apenas rotulos fixos (Identifier/Shell/Playback/Interface) — o usuario nao ve versao nenhuma.
- **Por que importa:** Detalhe pequeno com efeito grande: sem versao na tela, nao da pra confirmar que a instalacao pegou o APK novo (falha classica do bun run build esquecido, ja documentada no CLAUDE.md).
- **Risco/restricao:** Nenhum. So exige expor package_info (ou usar @tauri-apps/plugin-os/app) na UI.
- **Ancoras desktop:** `scripts/release.sh:29`, `src/views/Settings.tsx:18`
- **Ancoras mobile:** `src/mobile/screens/Settings.tsx:113`, `src-tauri/src/mobile_sync.rs:99`
- **Veredito do cetico:** Gap real: mobile_sync.rs:100 carimba app.package_info().version nos eventos, mas o painel About (Settings.tsx:120-142) lista so Identifier/Shell/Playback/Interface — nenhuma versao. Ancora Settings.tsx:113 esta errada (e uma linha de stat tile); o bloco correto e 125-141.

### `settings-hint-stale` — Texto do Settings mobile afirma beat sync sintetico depois do CMR-192 · **XS**
*(dimensao: plataforma)*

- **Desktop:** N/A.
- **Mobile hoje:** O hint diz 'No Android o pulso vem de um relogio sintetico — nao ha analise de audio', mas o commit d2db593 entregou beat sync REAL via SpectrumTap (FFT no ExoPlayer).
- **Por que importa:** Doc na UI que mente e pior que ausente — o usuario desliga um recurso achando que e falso.
- **Risco/restricao:** Nenhum.
- **Ancoras mobile:** `src/mobile/screens/Settings.tsx:64`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/SpectrumTap.kt:1`

### `contrato-ipc-desatualizado` — Contrato IPC v0 lista como inexistente o que ja foi entregue · **XS**
*(dimensao: plataforma)*

- **Desktop:** N/A (doc).
- **Mobile hoje:** docs/android/ipc-contrato-v0.md ainda diz que beat sync real nao existe ('o spectrum roda com mockFft') e que autoplay/likes/etc estao fora — parte disso mudou nos commits faca628/d2db593.
- **Por que importa:** Regra de documentacao viva do projeto: doc que engana custou tempo antes. Este e o doc que uma sessao futura vai ler como contrato.
- **Risco/restricao:** Nenhum.
- **Ancoras mobile:** `docs/android/ipc-contrato-v0.md:1`

### `device-id-fragilidade` — device.json vive no dataDir do app: desinstalar bifurca a identidade · **XS** _[WRONG_ANCHORS]_
*(dimensao: plataforma)*

- **Desktop:** device.json no data dir do Linux, semeado pelo hostname, sobrevive a reinstalacao do .deb.
- **Mobile hoje:** Mesmo modulo, mas no Android o dataDir some no uninstall; o id e semeado por getprop ro.product.model. Reinstalar limpo (o unico caminho ao trocar debug->release-signed) cria identidade nova e o breakdown por device da regua bifurca.
- **Por que importa:** A regua diaria segmenta por device_id; perder continuidade quebra a serie historica sem aviso.
- **Risco/restricao:** Colocar o device.json em /sdcard/Music/.rustify/ (junto do manifest) sobrevive ao uninstall mas exige a permissao de storage antes do primeiro sync — ordem de boot importa.
- **Depende de:** distribuicao-apk
- **Ancoras desktop:** `src-tauri/src/device_identity.rs:16`, `src-tauri/src/device_identity.rs:47`
- **Ancoras mobile:** `src-tauri/src/device_identity.rs:55`, `src-tauri/src/mobile_sync.rs:97`
- **Veredito do cetico:** Gap real. Ancoras: device_identity.rs:14-39 load_or_create (path em :15) e o hostname Android em :45-53 (getprop ro.product.model em :47). O :55 citado e a branch NAO-android. O risco descrito (uninstall bifurca identidade, e trocar debug->release exige reinstalacao limpa) procede.

### `journal-nao-sincado-no-uninstall` — Eventos nao sincados morrem no uninstall junto com o journal · **XS**
*(dimensao: plataforma)*

- **Desktop:** Eventos vao direto pro Qdrant; reinstalar o .deb nao perde nada.
- **Mobile hoje:** O journal fica no armazenamento privado do app; qualquer reinstalacao limpa (obrigatoria pra trocar assinatura debug->release) descarta o que ainda nao subiu.
- **Por que importa:** Perda silenciosa de sinal exatamente no momento de atualizar o app — e o usuario nao tem como forcar um sync antes.
- **Risco/restricao:** Botao 'sincar agora' no Settings resolve o caso consciente; mover o journal pra /sdcard resolve o caso esquecido, mas expoe o arquivo a outros apps.
- **Depende de:** sync-worker-bidirecional
- **Ancoras desktop:** `src-tauri/src/desktop.rs:2377`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/EventJournal.kt:1`, `src-tauri/src/mobile_sync.rs:143`

### `tamanho-apk-abi` — APK universal: todas as ABIs num binario so, sem split · **XS** _[OVERSTATED]_
*(dimensao: plataforma)*

- **Desktop:** O .deb e amd64 unico, dimensao nao e problema.
- **Mobile hoje:** O build sai como app-universal-debug.apk (todas as ABIs), instalado por adb. Sem splits nem bundle, o APK carrega .so de arquiteturas que o S24 nunca usa.
- **Por que importa:** Peso de download/instalacao e tempo de push por cabo; irrelevante hoje (adb local), relevante no dia em que houver distribuicao real.
- **Risco/restricao:** Restringir ABI a arm64 acelera build e reduz tamanho, mas quebra emulador x86 se algum dia for usado pra teste.
- **Depende de:** distribuicao-apk
- **Ancoras desktop:** `scripts/release.sh:44`
- **Ancoras mobile:** `src-tauri/gen/android/app/build.gradle.kts:1`
- **Veredito do cetico:** Fato verificado: build.gradle.kts nao tem splits nem abiFilters (grep vazio) e o artefato e app-universal-debug.apk, entao o APK carrega .so de todas as ABIs. Mas o impacto e cosmetico no unico canal existente (adb num aparelho conhecido) — nao ha loja, nao ha download por usuario. Gap real de higiene, prioridade minima; so vira relevante junto com o item de distribuicao/assinatura.

### `sync-sem-tailnet` — Sem tailnet o sync falha em silencio a cada 60s, sem backoff · **S**
*(dimensao: plataforma)*

- **Desktop:** N/A (o desktop e o receptor; se o celular nao chega, so nao chega).
- **Mobile hoje:** sync_once faz POST com timeout de 15s; falha vira tracing::debug e o loop repete em 60s indefinidamente. Sem deteccao de conectividade, sem backoff exponencial, sem retentar imediatamente quando a rede volta.
- **Por que importa:** Fora de casa (a maior parte do uso mobile) sao ~60 tentativas por hora que sempre falham: bateria e radio gastos a toa, e quando a tailnet volta o dado espera ate 60s.
- **Risco/restricao:** O worker e uma thread nativa em loop; sob doze o Android congela a thread e o intervalo real vira imprevisivel — backoff precisa ser por relogio absoluto, nao por sleep acumulado.
- **Ancoras desktop:** `src-tauri/src/sync_receiver.rs:32`
- **Ancoras mobile:** `src-tauri/src/mobile_sync.rs:88`, `src-tauri/src/mobile_sync.rs:104`, `src-tauri/src/mobile_sync.rs:113`

### `journal-crescimento` — Journal sem teto: nada limita o crescimento se o sync nunca acontece · **S** _[WRONG_ANCHORS]_
*(dimensao: plataforma)*

- **Desktop:** Eventos vao direto pro Qdrant no ato (log_event), sem fila em disco.
- **Mobile hoje:** EventJournal JSONL com fsync e a fila; ack_events compacta o consumido. Sem ack (sem tailnet por semanas) o arquivo so cresce e nao ha politica de tamanho maximo nem alerta.
- **Por que importa:** Cenario real: celular fora da tailnet um mes = milhares de linhas e um primeiro POST gigante quando reconectar (timeout de 15s pode nunca fechar, criando deadlock permanente de entrega).
- **Risco/restricao:** drain_events(0) drena TUDO de uma vez — enviar em lotes com limite (ex: 500) e o fix, mas o ack e por last_seq: lotear errado pode ackar evento nao entregue.
- **Depende de:** sync-worker-bidirecional
- **Ancoras desktop:** `src-tauri/src/desktop.rs:2377`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/EventJournal.kt:1`, `src-tauri/src/mobile_sync.rs:143`, `src-tauri/src/mobile_sync.rs:161`
- **Veredito do cetico:** Gap real (nenhuma politica de tamanho maximo; ack so ocorre apos 200 do receptor). Ancora mobile errada: o ack esta em mobile_sync.rs:155 (ack_events(drained.last_seq)), nao em 143/161 (143 = POST, 161 = mod tests). Desktop desktop.rs:2377 nao e log_event — e restart_app; o command log_event esta em desktop.rs:1445.

### `permissao-storage-adb` — MANAGE_EXTERNAL_STORAGE so via adb appops — sem fluxo in-app · **S**
*(dimensao: plataforma)*

- **Desktop:** N/A no desktop (acesso a ~/Music e livre).
- **Mobile hoje:** O manifest declara MANAGE_EXTERNAL_STORAGE, mas a concessao e feita por 'adb shell appops set ... allow' documentado no CLAUDE.md. Sem isso o walk devolve 0 faixas e a UI so mostra biblioteca vazia.
- **Por que importa:** Install limpo sem cabo = app inutil sem mensagem que explique. Falta o intent ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION e um estado vazio que ensine o caminho.
- **Risco/restricao:** MANAGE_EXTERNAL_STORAGE e permissao 'especial' — nao da pra pedir com requestPermissions, exige startActivity pra Settings e re-checagem no retorno (visibilitychange ja existe no store e pode servir de gancho).
- **Ancoras mobile:** `src-tauri/gen/android/app/src/main/AndroidManifest.xml:7`, `src-tauri/src/mobile_library.rs:19`, `src/mobile/store.ts:346`, `src/mobile/screens/Settings.tsx:88`

### `logs-diagnostico` — Log do app nao vai pro logcat e nao ha visor in-app · **S** _[WRONG_ANCHORS]_
*(dimensao: plataforma)*

- **Desktop:** Log em arquivo acessivel na maquina do usuario; o MCP bridge permite ler logs e estado remoto ao vivo.
- **Mobile hoje:** tauri_plugin_log configurado (Info/Debug pro crate), mas o CLAUDE.md registra que o log Rust NAO roteia pro logcat — a leitura e 'adb shell run-as ... tail logs/rustify-player.log'. Console do WebView so via CDP com cabo.
- **Por que importa:** Qualquer bug relatado pelo usuario exige cabo e adb. Sem visor de log ou export do arquivo, o ciclo de diagnostico e lentissimo.
- **Risco/restricao:** Adicionar target logcat ao plugin de log e trivial; expor o arquivo por share intent exige FileProvider (ja declarado no manifest do app) — cuidar pra nao vazar paths/dados sensiveis.
- **Ancoras desktop:** `src-tauri/src/desktop.rs:3324`
- **Ancoras mobile:** `src-tauri/src/mobile.rs:118`, `src/mobile/screens/Settings.tsx:88`
- **Veredito do cetico:** Gap real. Ancora mobile errada: tauri_plugin_log e configurado em mobile.rs:124-129 (nao :118). Sem visor in-app nem roteamento pro logcat; leitura so via adb run-as. Desktop tem log em arquivo local + MCP bridge.

### `crash-reporting` — Sem crash reporting ou deteccao de boot quebrado nos dois lados · **S**
*(dimensao: plataforma)*

- **Desktop:** Nao ha crash reporter no desktop tambem — mas o usuario ve o terminal/journal e o app esta na mesma maquina do dev.
- **Mobile hoje:** Nada. Um panic no Rust ou crash do WebView some sem rastro; ate o boot pendurado de 14/08 so foi diagnosticado via CDP com cabo.
- **Por que importa:** O celular e a unica maquina onde o dev nao esta olhando. Um marcador simples de 'boot completou' persistido ja distinguiria crash de boot lento.
- **Risco/restricao:** Nao introduzir telemetria externa (app pessoal, sem rede confiavel). Fazer local: flag em arquivo + panic hook que grava no log.
- **Depende de:** logs-diagnostico
- **Ancoras desktop:** `src-tauri/src/desktop.rs:2196`
- **Ancoras mobile:** `src/mobile/store.ts:333`, `src/mobile/store.ts:355`

### `doze-bateria` — Doze / otimizacao de bateria nao e tratada — sync e journal podem congelar · **M**
*(dimensao: plataforma)*

- **Desktop:** N/A.
- **Mobile hoje:** Plugin declara FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PLAYBACK e WAKE_LOCK, entao o playback sobrevive; mas a thread mobile-sync e uma thread do processo, nao um WorkManager: com o app em background e o service parado, o Android suspende o processo e o sync some ate a proxima abertura.
- **Por que importa:** Escuta com tela apagada gera eventos que so sobem quando o usuario reabre o app — atraso invisivel na regua e no motor.
- **Risco/restricao:** Mover o sync pra WorkManager Kotlin quebra a fronteira atual (o payload canonico e montado no Rust e tem teste byte-a-byte contra o desktop) — a alternativa e disparar o drain do Rust a partir de um worker Kotlin, mantendo o builder onde esta.
- **Depende de:** sync-worker-bidirecional
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/AndroidManifest.xml:6`, `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/AndroidManifest.xml:9`, `src-tauri/src/mobile_sync.rs:88`

### `distribuicao-apk` — Distribuicao Android e adb manual: sem release script, sem updater, sem assinatura · **M**
*(dimensao: plataforma)*

- **Desktop:** scripts/release.sh: le versao do tauri.conf.json, escreve build-metadata/VERSION com commit, builda .deb e publica na tag rolling 'dev'; o app tem check_for_update/install_update/restart_app e um rustify-update.sh.
- **Mobile hoje:** APK debug-signed construido a mao (bun run build + cargo tauri android build --debug) e instalado via scp+adb install -r. Nao ha script, nem keystore de release, nem canal de update, nem versao visivel alem do About estatico.
- **Por que importa:** Toda atualizacao do celular exige a VM, a cmr-auto e um cabo. E o app nao sabe dizer qual versao roda (o About e texto fixo), o que atrapalha ate diagnosticar bug reportado.
- **Risco/restricao:** Release assinado exige keystore fora do repo e muda o applicationId de assinatura: instalar release por cima do debug exige desinstalar (perde device.json e o journal nao sincado). Tauri updater no Android nao instala APK sozinho — precisa de intent de instalacao e REQUEST_INSTALL_PACKAGES.
- **Ancoras desktop:** `scripts/release.sh:1`, `scripts/release.sh:29`, `src-tauri/src/desktop.rs:2304`, `src-tauri/src/desktop.rs:2358`, `src-tauri/src/desktop.rs:3325`
- **Ancoras mobile:** `src/mobile/screens/Settings.tsx:113`, `src-tauri/src/mobile.rs:139`

### `testes-mobile` — Cobertura de teste do mobile e uma fracao da do desktop · **M**
*(dimensao: plataforma)*

- **Desktop:** 32 arquivos de teste no frontend (views, stores, lib, componentes DSP) + testes Rust em varios crates.
- **Mobile hoje:** Um unico teste de frontend mobile (src/mobile/derive.test.ts) e testes Rust em mobile_intel.rs, mobile_library.rs e mobile_sync.rs. Nenhuma tela mobile tem teste; store.ts (boot, applyState merge por chave presente, rehydrate) nao tem teste apesar de ja ter tido dois bugs de boot.
- **Por que importa:** As regressoes mobile mais caras ate agora (boot pendurado, estado zerado pelo tick de position) sao exatamente o tipo que teste de store pega.
- **Risco/restricao:** Testar o store exige mockar o plugin (addPluginListener/invoke) — o ipc.ts ja centraliza, entao e viavel; risco e teste de UI mobile virar snapshot fragil.
- **Ancoras desktop:** `src/views/Settings.test.tsx:1`, `src/store/tweaks.boot.test.ts:1`, `src/components/PlayerBar.signal.test.tsx:290`
- **Ancoras mobile:** `src/mobile/derive.test.ts:1`, `src/mobile/store.ts:141`, `src/mobile/store.ts:302`

### `integracao-sistema-android` — Zero integracao com o sistema Android alem da notificacao de midia · **L**
*(dimensao: plataforma)*

- **Desktop:** MPRIS via souvlaki (teclas de midia, integracao com o painel do SO), atalhos de teclado, command palette (⌘K), tray/janela.
- **Mobile hoje:** MediaSession do Media3 cobre notificacao, tela de bloqueio e botoes de fone — paridade real nesse ponto. Mas nao ha widget de home screen, atalhos dinamicos (long-press no icone), quick settings tile, nem Android Auto (o service e exported=false, com comentario dizendo que virar true so pra Auto/Assistant).
- **Por que importa:** Sao os pontos de entrada rapidos que fazem um player parecer nativo; hoje toda acao exige abrir o app e esperar o boot da WebView.
- **Risco/restricao:** Widget/tile exigem codigo Kotlin fora do plugin e um caminho de leitura de estado sem subir a WebView. Android Auto exige exported=true + validacao do MediaBrowser (superficie de ataque nova) e catalogo navegavel — nao e so um flag.
- **Ancoras desktop:** `src-tauri/Cargo.toml:1`, `src/components/CommandPalette.tsx:1`
- **Ancoras mobile:** `src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/AndroidManifest.xml:16`, `src-tauri/gen/android/app/src/main/AndroidManifest.xml:17`

---

## Achados adicionais dos ceticos (nao estavam no inventario original)


### playback

- Semantica replay-vs-skip no pulo por indice: o desktop distingue clique 'a frente' (skip de sessao, registra rejeicao) de clique em faixa ja tocada (replay, nao mexe no indice) — src/components/PlayerBar.tsx:766-776 (playQueueUpcoming). No mobile, skipToIndex (src/mobile/store.ts:289) gera transicao com reason != AUTO e o service loga SEMPRE 'track_skipped' (src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/java/AudioService.kt:195-199): tocar de novo algo ja ouvido vira sinal NEGATIVO no journal.
- play_count/last_played nao existe para escuta do celular: o desktop chama libRecordPlay em toda troca de faixa (src/components/PlayerBar.tsx:803) e incrementa track_enrichments (src-tauri/crates/library-indexer/src/query.rs:513-517). O sync do S24 transporta SO play_events (src-tauri/src/sync_receiver.rs:1) e o mobile nao tem command de record_play (src-tauri/src/mobile.rs:143 lista os handlers) — escutas do celular nunca sobem play_count.
- Historico da fila: a tela desktop mostra o que ja passou (past() em src/views/Queue.tsx:13) e permite voltar clicando; a tela mobile so renderiza upcoming (src/mobile/screens/Queue.tsx:21), entao nao ha como voltar mais de uma posicao pela UI.
- 'Next' no fim da fila e no-op silencioso no Android: AudioPlugin.kt:177-181 so age se hasNextMediaItem(); o desktop, no mesmo gesto, cai em doAutoplay em vez de parecer botao quebrado (src/components/PlayerBar.tsx:556-566). Sem feedback nenhum no mobile (store.ts:262 engole).
- O plugin nao expoe nenhuma mutacao incremental de fila (addMediaItems/removeMediaItem/moveMediaItem do ExoPlayer): setQueue e o unico caminho (AudioPlugin.kt:127-154). E o pre-requisito tecnico compartilhado de enqueue-next, clear, remove e reorder — sem ele, os quatro gaps de fila sao o MESMO trabalho de plugin.
- playNow=false ja existe no contrato (src/mobile/ipc.ts:45-51 e SetQueueArgs em AudioPlugin.kt:50) e nenhum caller usa (src/mobile/store.ts:181 sempre manda playNow=true) — o trilho de 'restaurar sessao pausada' e de 'montar fila sem interromper' ja esta pronto e ocioso.
- O manifest exportado para o aparelho nao carrega dados de audio por faixa (lufs_integrated, bit_depth/sample_rate/codec) — scripts/android/export_manifest.py; isso bloqueia simultaneamente a normalizacao de loudness e a tech pill no mobile, alem dos commands que faltam.

### biblioteca

- Letra no celular vem SO do sidecar .lrc: lib_get_lyrics mobile (src-tauri/src/mobile.rs:88-107) le t.lrc_path e nada mais, enquanto o desktop tem segunda fonte — get_lyrics cai em `embedded_lyrics` (tags do arquivo) quando nao ha .lrc (src-tauri/crates/library-indexer/src/query.rs:820-833). Pior: o payload `lyrics_text` (letra plain do lrclib, ~60% do que o lrclib tem, gravada pelo LyricsSink) nem sequer esta em FIELDS do export (scripts/android/export_manifest.py:51-55). Faixa cuja letra vive so nas tags ou so em lyrics_text aparece SEM letra no S24, e a UI esconde o toggle sem explicar.
- Arquivo de audio presente no cartao mas ausente do manifest e invisivel e nao contado: walk_music indexa todo audio (src-tauri/src/mobile_library.rs:118-155) mas so entradas do manifest viram Track (src-tauri/src/mobile_library.rs:236-241) — o inverso do `unresolved`. Nada que o desktop nao conheca toca no celular, e nao ha metrica desse delta (audio.len() so aparece no tracing::info de src-tauri/src/mobile_library.rs:226-230).
- Home mobile nao tem os trilhos de recomendacao do desktop: lib_recommendations (src-tauri/src/desktop.rs:753) entrega tres camadas (most_played / based_on_top / discover) com fallback de shuffle (src-tauri/crates/library-indexer/src/query.rs:598-612) e alimenta os hero tiles da Home desktop (src/views/Home.tsx:120-138). A Home mobile (src/mobile/screens/Home.tsx:59-91) tem apenas Shuffle all, Stations e o rail do taste snapshot — nenhuma nocao de 'mais tocadas' ou 'descobrir'.
- Nenhum corte de lista e sinalizado ao usuario: searchTracks para em 120 sem avisar (src/mobile/derive.ts:129) e albumHits/artistHits/folderHits cortam em 30 (src/mobile/screens/Search.tsx:62-70) sem 'mostrando N de M'. Numa busca ampla ('the') o usuario nao sabe que ha mais resultado; o desktop passa limit explicito por command (src-tauri/src/desktop.rs:263).
- albumKey agrupa por artista normalizado sem guarda pra vazio (src/mobile/derive.ts:55-57): faixa sem artist_name cai no bucket "" e dois albuns homonimos de artistas desconhecidos viram um card so. Vale tambem pra deriveArtists, que descarta a faixa inteira quando artist_name e null (src/mobile/derive.ts:86) — essas faixas somem da faceta Artistas sem nenhum bucket '(sem artista)'.
- Nao existe nocao de 'adicionado recentemente' no celular: o manifest nao exporta added_at/mtime (scripts/android/export_manifest.py:51-55, build_manifest :132-147), entao TrackOrder::RecentlyAdded (src-tauri/crates/library-indexer/src/types.rs:127) e a smart playlist 'Recently added' do desktop (src/views/Playlists.tsx:100) nao tem dado nenhum pra existir no S24 — nem hoje nem depois, sem mudar o export.

### inteligencia

- Cap de 2 por artista ausente no ranking mobile: o desktop aplica cap no re-rank hibrido e mantem continuidade entre lotes via resolve_artist_counts (src-tauri/src/desktop.rs:3838-3860, rerank em :416); mobile_intel::rank_pool (src-tauri/src/mobile_intel.rs:214-242) e mobile_library::station_batch (src-tauri/src/mobile_library.rs:326-351) nao tem nenhuma nocao de artista — uma station mobile pode devolver 6 faixas do mesmo artista.
- Re-rank por vibe ausente tambem nas STATIONS mobile (o finder so citou o autoplay): desktop generate_station_batch (src-tauri/src/desktop.rs:3560) passa por rerank_by_seed_vibe (:460-463); o lote mobile e cosine+gosto puro (src-tauri/src/mobile_library.rs:338-345).
- Sem station default no aparelho: o desktop cria 'Your Mix' quando nao ha station nenhuma (maybe_seed_default_station, src-tauri/src/desktop.rs:3866+, chamado no setup); no mobile, sem stations.json o load_intel devolve vec vazio (src-tauri/src/mobile_library.rs:185-194) e a tela fica vazia sem alternativa gerada localmente.
- Radio da faixa mobile ignora os negatives do gosto: similar_tracks passa exclude vazio (HashSet::new(), src-tauri/src/mobile_library.rs:312), enquanto o desktop passa negatives ao recommend do autoplay (src-tauri/src/desktop.rs:509-512) — a mesma faixa que rank_pool exclui nas stations pode abrir o radio.
- Loudness/LUFS: o desktop normaliza por faixa lendo lufs_integrated do enrichment (cadeia DSP em crates/audio-engine/src/output/dsp.rs, target runtime em src-tauri/src/lib.rs/desktop.rs), e o export nem carrega o campo (FIELDS, scripts/android/export_manifest.py:51-56); o plugin Android nao tem command de normalizacao (crates/tauri-plugin-rustify-audio/android/src/main/java/AudioPlugin.kt).
- Sem snapshot/diagnostico do motor local: o desktop expoe lib_snapshot (src-tauri/src/desktop.rs:619) com estado do indexador; no mobile nao ha command equivalente e Settings so conta entidades (src/mobile/screens/Settings.tsx:25-30) — nao da pra saber quantas faixas tem vetor no vectors.bin nem quantas tem .lrc.

### telas

- Volume: o desktop tem slider de volume na PlayerBar (src/components/PlayerBar.tsx:475 volPct + controle) e em Settings (src/views/Settings.tsx:~450-460), com persistencia propria em localStorage kv-volume via changeVolume (src/store/player.ts). O mobile nao tem NENHUM controle de volume nem mute — grep em src/mobile/ so acha a mencao no comentario de corte (src/mobile/screens/Settings.tsx:11). Paridade parcial pelas teclas fisicas do aparelho, mas sem volume por-app e sem persistencia.
- Stations e quase inalcancavel na navegacao mobile: nao esta no tabbar (src/mobile/components/Dock.tsx:11-16), nao esta em 'Colecoes' da Library (src/mobile/screens/Library.tsx:118-127, que so lista Fila) e o unico acesso e o cartao da Home que so aparece se stations().length > 0 (src/mobile/screens/Home.tsx:67-73). Se o export nao rodou, a tela /stations existe mas nao ha caminho ate a mensagem que explica isso (src/mobile/screens/Stations.tsx:29-36).
- Sem ordenacao ou filtro em qualquer lista mobile: a ordem e fixa e alfabetica no derive (src/mobile/derive.ts:80 albuns, :103 artistas) e Faixas usa a ordem crua do backend (src/mobile/screens/Library.tsx:111). O desktop oferece pelo menos filtro por genero na lista de faixas (src/views/Tracks.tsx:16-24) e ordenacao por recencia nas telas alimentadas por historico (src/views/Home.tsx:24).
- Fila mobile nao mostra tempo restante: o desktop calcula 'X tracks · Y remaining' no drawer (src/components/QueueDrawer.tsx:56-58) e 'N proximos · M ja reproduzidos' na tela cheia (src/views/Queue.tsx:20-22); o mobile mostra so contagem e origem (src/mobile/screens/Queue.tsx:26).
- Folder mobile engole erro de IPC: createResource sem catch em src/mobile/screens/Folder.tsx:21 — se lib_list_folder_tracks falhar, list() fica vazio e a tela renderiza 'Pasta vazia' (Folder.tsx:38), mesmo padrao de erro-mascarado-de-vazio do gap erro-carga-invisivel (e no Album/Artist o mesmo vale por derivacao em memoria).
- O backend mobile de station e menos capaz que o desktop, alem de desligado: src-tauri/src/mobile.rs:72-77 (lib_station_next) nao aceita sessionNegativeIds, presente no contrato desktop (src/tauri.ts:433-445) e usado pelo topUpStation (src/components/PlayerBar.tsx:718) para penalizar candidatos parecidos com o que foi pulado na rodada.
- Nao ha equivalente mobile do Visualizer nem do modo cinema do desktop (src/views/Visualizer.tsx; toggle de cinema em src/App.tsx:57-62). Classifico como paridade por outro caminho parcial: o fundo persistente com shapes/renderers e FFT real (src/mobile/bg/spectrum.ts, MobileApp.tsx:78-110) cobre a funcao ambiente, mas nao ha modo dedicado em tela cheia.
- Search mobile nao tem a secao 'Top result' do handoff (docs/design-refs/design_handoff_mobile/screens.js, S.search) — os resultados saem em blocos por tipo sem destaque do melhor acerto (src/mobile/screens/Search.tsx:140-234), e a busca nao e disparavel de fora da aba (nao ha ponto de entrada a partir de Home/Library).

### visual

- Sem menu de contexto / long-press em faixa: desktop tem TrackContextMenu completo acionado por right-click em toda lista (src/components/TrackContextMenu.tsx:21, src/components/TrackRowList.tsx:51, src/components/TrackRowTable.tsx:40) e tambem no player (src/components/PlayerBar.tsx:454). No mobile grep por contextmenu/longpress em src/mobile retorna zero — TrackRow.tsx (src/mobile/components/TrackRow.tsx) so tem tap = tocar. Nao ha nenhuma via para acoes secundarias (adicionar a fila, ir ao album/artista, like) — o gesto canonico do Android (long-press) esta inteiramente ausente.
- Sem UI de like/coracao: desktop expoe Like/Unlike com icone cheio/vazio em src/components/TrackContextMenu.tsx:145-146 e toggle no player (src/components/PlayerBar.tsx:399-400, libToggleLike). O proprio comentario do mobile assume a ausencia (src/mobile/components/NowPlaying.tsx:10 'sem coracao (nao ha trilho de like)') e mobile.rs:143-155 nao tem command de like. E gap visual E de sinal (liked_at alimenta os positives da v3).
- Zero estilo de foco/estado pressionado declarado: grep por ':focus' e 'focus-visible' em src/mobile/styles/*.css retorna nada, e tokens.css:88 zera o -webkit-tap-highlight-color globalmente. Ou seja, o realce nativo do Android foi desligado e nada o substituiu — botoes (.iconbtn, .selbtn, .seg button, .shapebtn) nao tem :active/:focus-visible proprio. Toque sem confirmacao visual nenhuma, o que agrava o gap de haptics.
- Scroll position nao e restaurada ao voltar: src/mobile/MobileApp.tsx:115-118 zera viewEl.scrollTop em TODA troca de baseRoute, inclusive no back() (src/mobile/nav.ts). Descer 300 faixas na Library, abrir um album e voltar joga o usuario ao topo. E micro-interacao classica de app mobile e nao existe nem como excecao para navegacao para tras.
- Barras de sistema do Android nao acompanham o ink/tema: o app pinta a WebView mas nunca declara statusBarColor/navigationBarColor nem os toca em runtime (src-tauri/gen/android/app/src/main/res/values/themes.xml:3 e so 'Theme.MaterialComponents.DayNight.NoActionBar' vazio; colors.xml sem override). Com --bg-ink/accent trocando por capa (src/mobile/adaptiveColor.ts:41), a moldura do sistema fica dessincronizada do app — o inverso exato do detalhe que o adaptive ink existe para entregar.

### plataforma

- Sync receiver SEM autenticacao nenhuma: src-tauri/src/sync_receiver.rs:104-142 aceita qualquer POST /sync/events de qualquer host da tailnet e faz upsert no Qdrant de producao — nao ha token, nem allowlist de device_id, nem validacao de origem. O perimetro e so o WireGuard. No desktop todo o resto foi fechado em loopback (hardening 2026-07-17); esta e a unica porta aberta e e write-path no sinal que alimenta o motor de recomendacao.
- Trafego em claro habilitado no app Android: src-tauri/gen/android/app/src/main/AndroidManifest.xml:16 usesCleartextTraffic=${usesCleartextTraffic} (true no build debug) e o POST do worker (src-tauri/src/mobile_sync.rs:140) e HTTP puro — ureq sem TLS por decisao. Aceitavel dentro da tailnet, mas nao ha nenhuma trava impedindo o endpoint de sync.json (mobile_sync.rs:79-83, campo 'endpoint' lido de arquivo) apontar pra fora dela.
- android:allowBackup nao e declarado em src-tauri/gen/android/app/src/main/AndroidManifest.xml (default = true): device.json e o journal de eventos entram no backup do Google e podem ser restaurados em OUTRO aparelho, o que duplica/bifurca a proveniencia (device_identity.rs:14 le o device.json restaurado como verdade). E o mesmo risco do gap device-id-fragilidade, mas pelo lado oposto (identidade viaja quando nao deveria).
- O worker de sync dorme ANTES do primeiro ciclo (src-tauri/src/mobile_sync.rs:103-105: loop { sleep(INTERVAL); sync_once(...) }) e nao ha flush em nenhum evento de ciclo de vida (nao existe listener de pause/background em src/mobile/MobileApp.tsx nem no plugin). Sessao curta de escuta com o app fechado em seguida so sobe no proximo boot que sobreviva 60s.
- O frontend mobile nao tem NENHUM caminho pra observar o sync: nao ha comando exposto que devolva tamanho do journal, last_seq ackado ou timestamp do ultimo POST — mobile.rs:143-155 registra so os 11 lib_*, e drain/ack sao consumidos exclusivamente pelo Rust (mobile_sync.rs:120,155). Portanto qualquer UI de diagnostico de sync exige command novo, nao so tela.

---

## Nao aplicavel (fica de fora por decisao ou restricao dura)


### playback

- Cadeia DSP GStreamer (crates/audio-engine/src/output/dsp.rs) — target-gated desktop-only; depende de PipeWire/GStreamer que nao existe no Android. Qualquer EQ/limiter/bass no celular e reimplementacao sobre AudioProcessor do Media3 ou android.media.audiofx, nunca porte.
- MPRIS/souvlaki — protocolo D-Bus de desktop Linux. O equivalente Android (MediaSession) ja esta implementado.
- mcp-bridge (:9223) — automacao de janela/WebView pra QA no desktop; nao ha janela nem caso de uso no aparelho.
- Titlebar/janela/cinema mode (src/components/Titlebar.tsx, App.tsx:40) — atalhos de teclado (n/h/l/Escape, Q pra fila, ⌘K) e gestao de janela nao tem analogo em toque. O mobile ja substituiu por gestos (Dock.tsx:44 — arrastar o mini = prev/next, pra cima = NowPlaying).
- Crate/slskd (download in-app) — vive na cmr-auto por decisao de arquitetura; nao entra no aparelho.
- Qdrant sidecar e lib_autoplay_next server-side — sem processo Qdrant no celular; o equivalente e o motor local em mobile_intel.rs sobre vetores em arquivo.
- Tela Signal (28.9K) como esta — mesmo com DSP no Android, o inspetor de cadeia GStreamer nao tem o que inspecionar; seria outra tela.
- Velocidade de reproducao e sleep timer — nao existem em nenhum dos lados; sao features novas, listadas acima como oportunidades e nao como divida de paridade.

### biblioteca

- Watcher via notify (watch.rs) portado literalmente — scoped storage do Android nao entrega eventos confiaveis em /sdcard e o custo de bateria de um FileObserver recursivo nao se paga; a substituicao correta e checagem de mtime do manifest no resume.
- Pipeline de embeddings/MERT e backfill de letra no ingest (pipeline.rs, embed_client.rs, lyrics_fetch.rs) — sem embedder no aparelho por decisao dura; os artefatos vem prontos via export.
- Qdrant como store da biblioteca (qdrant_client.rs, 2589 linhas) — decidido que nao ha processo Qdrant no aparelho; manifest + arquivo binario cobrem leitura e similaridade.
- Crate/slskd (aquisicao de acervo, Crate.tsx 38KB) — slskd vive na cmr-auto; baixar da rede Soulseek pelo celular esta fora de escopo e a rede pune burst.
- lib_recommendations em tempo real (desktop.rs:752) — depende do Qdrant com play_count vivo; o equivalente mobile e o taste.json exportado, ja entregue.
- Colunas de tabela da tela Tracks (Tracks.tsx:59, 5 colunas com Album/Genre/Length) — layout de tabela nao cabe em 6 polegadas; a linha compacta do mobile e a forma correta.
- Menu de contexto por right-click como GESTO (TrackContextMenu.tsx) — o gesto nao existe no celular; o CONTEUDO do menu, porem, e gap real (lib-sem-menu-contexto).
- Media server local :19876 pra servir capas — no Android o convertFileSrc resolve direto do filesystem.

### inteligencia

- Qdrant sidecar / Recommendations API no aparelho — decisão de arquitetura registrada (CMR-190): vetores em arquivo + brute-force cobre 1746×768d em microssegundos. Rodar Qdrant no S24 seria custo puro.
- Busca semântica por TEXTO offline (lib_semantic_search, desktop.rs:291) — exige embedder BGE-M3 no aparelho; MERT/BGE-M3 são inviáveis no Android por decisão de escopo. O substituto local (grep nos .lrc) está listado como gap, a paridade real não é portável.
- Geração/atualização de vetores MERT — o embedder vive na infra da VM (:8448). O aparelho só consome vectors.bin.
- Backfill de letras via lrclib (library-indexer/src/lyrics_fetch.rs) e o LyricsSink do Crate — o crate library-indexer é target-gated desktop-only e o pipeline pertence ao ingest, não ao playback.
- Tela Signal (src/views/Signal.tsx) — é DSP (EQ/Limiter/Bass), não motor de inteligência, e depende do audio-engine GStreamer que não existe no Android (Media3 tem outro grafo). Fica fora desta dimensão; o único item de sinal que ela exibe (indicador de Normalize) depende de lufs_integrated, coberto no gap de enrichments.
- MCP bridge / driver_session — instrumentação de automação de desktop, sem análogo no aparelho.
- Normalização de loudness por track (NormState, desktop.rs:1950-2012) — depende do lufs_integrated e da cadeia DSP do audio-engine; pertence à dimensão de áudio, mas o dado (lufs) está listado no gap de export de enrichments porque sem ele qualquer futura normalização no Media3 fica bloqueada.
- GC de órfãos / anotação de vibe por LLM (CMR-178) — processo de curadoria server-side, roda na VM/cmr-auto por definição.

### telas

- Titlebar custom (src/components/Titlebar.tsx:1) — existe porque tauri.conf.json usa decorations:false no desktop; o Android desenha a status bar e a barra de gestos, e o app já decidiu não falsificá-las (src/mobile/MobileApp.tsx:9-11).
- Cinema mode / full-screen player (src/App.tsx:38-79, tecla F) — no celular o Now Playing JÁ é overlay de tela cheia sobre o fundo persistente (src/mobile/MobileApp.tsx:132). O toggle "Full-screen player" do handoff (screens.js:107) só faria sentido para esconder o dock; é cosmético, não paridade.
- Atalhos de teclado globais (src/App.tsx:50-64: N/H/L/Esc; src/views/NowPlaying.tsx:236-249: [ ] , . F; Q na gaveta) — sem teclado físico. As funções equivalentes existem como botões: shape/renderer no cabeçalho do NP (src/mobile/components/NowPlaying.tsx:133-150).
- MCP bridge (src-tauri/crates/mcp-bridge) — target-gated desktop-only, é ferramenta de automação/QA da sessão de desenvolvimento, não superfície de usuário.
- Menu de contexto por RIGHT-CLICK como mecanismo (src/components/TrackRowList.tsx:51) — o mecanismo não se porta; o CONTEÚDO do menu se porta via long-press e está listado como gap (track-context-menu).
- Check for updates / instalar update (src/views/Settings.tsx:563-600) — a distribuição do Android v0 é APK debug-signed via adb, sem loja e sem updater (documentado no CLAUDE.md). Renderizar o botão seria botão morto.
- views/Visualizer.tsx — nem está registrada no roteador do desktop (src/router.tsx:12-29 não tem /visualizer): é código órfão. Não portar; e vale marcar para remoção no desktop.
- Indicador de processo qdrant e contagem de embeddings em Settings (src/views/Settings.tsx:520-530) — decisão dura do projeto: não há Qdrant nem embedder no aparelho. O equivalente honesto no mobile é o estado dos artefatos exportados (vectors.bin/stations.json), que hoje só aparece indiretamente quando a lista vem vazia (src/mobile/store.ts:48-56).
- Crate: baixar arquivos NO aparelho (src/views/Crate.tsx staging + layout canônico) — o acervo canônico e a indexação vivem na cmr-auto. Só o CONTROLE remoto do Crate é portável, e está listado como gap (screen-crate).

### visual

- Painel Signal / EQ visual (StatTile 'Normalize', node norm_gain, EqCanvas com overlay de espectro 31 bandas) — a cadeia DSP vive no audio-engine (GStreamer/PipeWire), target-gated desktop-only. Não há EQ no Media3 do plugin, então o knob eqSpectrumOverlay (Tweaks.tsx:243) não tem o que desenhar.
- Knobs de Loudness (loudnessNorm + loudnessTarget LUFS, Tweaks.tsx:308-321) — são a única exceção CSS-var-less do Tweaks e mapeiam para norm_set_enabled/norm_set_target no audio-engine. Sem engine no Android, sem knob. Portar exigiria implementar normalização no ExoPlayer, o que é outra dimensão (áudio), não visual.
- Knob Sidebar (icons/labels, tweaks.ts:218) — o mobile não tem sidebar; a navegação é tabbar+dock (Dock.tsx). Portar o data attr seria desenhar botão para um componente inexistente.
- Theme watcher com hot-reload (watch_theme + evento theme-changed, desktop.rs:1279-1332) — depende de um arquivo YAML sendo editado por processo externo na mesma máquina. No aparelho não há editor nem watcher de FS que faça sentido; se houver temas no mobile, a entrega é por export, não por watch.
- list_system_fonts (desktop.rs, consumido em tweaks.ts:171) — enumerar e usar fontes arbitrárias do sistema Android não é praticável pelo WebView. Um seletor mobile teria que ser sobre famílias bundladas (listado como gap tweak-fonts, com escopo reduzido).
- Drag e resize do card de letra por mouse (NowPlaying.tsx:131, startResize) — interação de ponteiro fino com hover e handle de 8px. O equivalente tátil é outro desenho (presets de tamanho), não um port.
- Atalhos de teclado [ ] , . para shape/renderer — não há teclado. O equivalente (gesto/prev) está listado como gap shape-renderer-atalhos.
- Menu de contexto de faixa (TrackContextMenu.tsx, contextMenu.ts) e CommandPalette (⌘K) — interações de mouse/teclado. O equivalente mobile é long-press + bottom sheet, que é um gap de outra dimensão (navegação/UX), não de customização visual.
- Aba Crate (Crate.tsx, 38KB) e todo o seu estado visual — slskd vive na cmr-auto por decisão de arquitetura.
- Chrome de janela, tray e MCP bridge — sem janela, sem tray; mcp-bridge é target-gated desktop-only.
- Checker WCAG interativo do picker de tema (ContrastCheck exibido em Settings após applyThemeByName, tauri.ts:321) — é ferramenta de curadoria de tema, roda onde os temas são criados (VM/desktop). O validate.py offline continua sendo o gate real.

### plataforma

- Qdrant sidecar (qdrant_process.rs) — decidido que nao ha processo Qdrant no aparelho; vetores em arquivo + busca in-process ja cobrem o uso.
- MCP bridge (:9223) — automacao de dev/driver de UI, sem sentido em celular pessoal; alem disso o bind loopback do desktop e regra de seguranca.
- Media server local (:19876) e get_media_port — o Android le arquivos direto por convertFileSrc/asset protocol; servidor HTTP local seria superficie a toa.
- Gestao de janela/tray/atalhos de teclado (manage_window, sidebar compacta) — nao existe janela nem teclado fisico no fluxo mobile.
- EQ/DSP/limiter/bass e normalizacao de loudness — dependem do audio-engine GStreamer, target-gated desktop-only; ExoPlayer teria que reimplementar a cadeia inteira. Volume no Android e do sistema (botoes fisicos).
- Crate / slskd — vive na cmr-auto por decisao; a rede Soulseek pune burst e o app pessoal no celular nao deve virar cliente P2P.
- Temas YAML com hot-reload (list_themes/load_theme/watch_theme) — o trilho e um diretorio na cmr-auto com validacao WCAG no backend desktop; nao ha caminho de deploy nem editor no aparelho.
- Busca semantica por texto (lib_semantic_search / lib_mood_search) — exige embedder (BGE-M3) no aparelho, inviavel; similar/stations sao vetor-para-vetor e ja rodam offline.
- list_system_fonts / fs_read_text / fs_write_text arbitrarios — knobs de customizacao do desktop sem analogo (e sem seguranca) no Android.
- Updater Tauri completo (check_for_update/install_update/restart_app do .deb) nao porta como esta: no Android a instalacao passa por intent do sistema e REQUEST_INSTALL_PACKAGES — o gap real esta listado como distribuicao-apk, o command desktop em si nao se aplica.

---

## Paridade por outro caminho (mobile resolve diferente, nao e gap)


### playback

- Auto-advance no fim da faixa: o desktop orquestra no JS (advanceQueue no TrackEnded, PlayerBar.tsx:134); o mobile deixa a fila nativa do ExoPlayer avancar sozinha (AudioService.kt:187) — equivalente, e mais robusto com a tela apagada.
- Log de escuta: desktop grava direto no Qdrant via flush_play_event (desktop.rs:98); mobile escreve no EventJournal JSONL com fsync e sincroniza depois (AudioService.kt:221 + mobile_sync.rs). Mesma semantica de track_ended/track_skipped — nao e gap.
- Media session: MPRIS/souvlaki no desktop (desktop.rs:2780) x MediaSessionService do Media3 no mobile (AudioService.kt:94). O mobile ganha lockscreen e capa de graca; o que falta sao os botoes extras (ver gap notification-controls).
- Seek: pointer drag com supressao do tick nos dois lados (PlayerBar.tsx:346 x NowPlaying.tsx:91). O mobile usa pointer capture, adequado ao toque.
- Foco de audio / fone desplugado: o mobile TEM (AudioService.kt:73-77) e o desktop NAO — vantagem do mobile, nao gap.
- Volume: o desktop tem slider proprio persistido (player.ts:116); no Android o volume de midia do sistema e o idioma da plataforma e cobre o caso comum. So o volume relativo/mute rapido fica faltando.
- Formatos: acervo mobile em Opus decodificado pelo ExoPlayer; acervo desktop em FLAC pelo GStreamer. Coberturas diferentes, ambas completas pro respectivo acervo.
- Botao anterior: semantica identica nos dois (sempre volta uma faixa), deliberada no mobile para nao sujar o journal (AudioPlugin.kt:184).

### biblioteca

- Albuns e artistas: o desktop tem commands dedicados (lib_list_albums/lib_list_artists, desktop.rs:226/250) e o mobile deriva do acervo em memoria (src/mobile/derive.ts:59/83). Resultado equivalente para navegacao — NAO e gap, exceto pelo agrupamento de compilacao (gap lib-album-artist-compilacao).
- Busca client-side: o desktop tambem faz busca em memoria (query.rs:429 scroll_all_full + scoring), entao o mobile nao esta 'atras por ser client-side'. O gap real e so o scoring/squish.
- Playlists: o desktop NAO tem CRUD de playlist — 'New playlist'/'New smart playlist' sao botoes mortos com title='Backend pendente' (Playlists.tsx:178) e as smart playlists sao mock (Playlists.tsx:100). Playlist = pasta nos dois lados. Criar/editar/remover playlist nao e gap mobile: e feature inexistente no produto inteiro.
- Ordenacao de faixa dentro da pasta: o desktop ordena via TrackOrder no Qdrant; o mobile usa a ordem do manifest, que e rel_path ordenado (export_manifest.py:148) = disco/faixa na pratica. Equivalente na maioria dos casos.
- Virtualizacao: o desktop renderiza listas inteiras com <For> sem virtualizacao (Tracks.tsx:66); o mobile tem LazyList com IntersectionObserver (ui.tsx:66). Aqui o MOBILE esta a frente.
- Registro de escuta: o desktop chama lib_record_play (PlayerBar.tsx:803); o mobile nao tem esse command, mas o journal do plugin Kotlin + mobile_sync cobrem o mesmo proposito com proveniencia (device_id/app_version/signal_schema). Paridade por outro caminho para o SINAL — nao para play_count local (esse e gap).
- Buscas recentes: o mobile persiste em localStorage (Search.tsx:31); o desktop nao tem equivalente no CommandPalette. Mobile a frente.
- Navegacao/voltar: o mobile usa roteador de hash pra herdar o botao voltar do Android (nav.ts:1-10); o desktop usa router proprio. Equivalente.

### inteligencia

- Similaridade MERT: o desktop usa a Recommendations API do Qdrant; o mobile faz cosine brute-force in-process sobre vectors.bin (mobile_intel.rs:80 VectorIndex::similar). Resultado equivalente para top-K num acervo de 1746 faixas — não é gap, é a mesma coisa sem servidor.
- Sorteio de variedade: weighted_pick_prefix foi PORTADO com a mesma matemática (r=0.7, xorshift*) — desktop.rs:3419 e mobile_intel.rs:243. Paridade real, com teste de determinismo por seed no mobile.
- Cor dominante da capa: o desktop calcula on-demand (get_track_color/get_track_palette, desktop.rs:1365/1401 lendo o arquivo); o mobile recebe dominant_color pronto no manifest (export_manifest.py:146) e deriva ink/accent localmente. Mesmo efeito visual, custo zero no aparelho.
- Proveniência dos eventos: o payload do Android é IDÊNTICO ao do desktop, garantido por teste byte a byte (mobile_sync.rs:196 payload_mobile_identico_ao_do_desktop) e SIGNAL_SCHEMA espelhado com teste (mobile_sync.rs:186). Não há gap de contrato — só de cobertura de origins.
- Derivação de behavioral_signals: o mobile não deriva, mas consome o resultado da MESMA função (replicada em Python no export, export_manifest.py:228-270 com todas as constantes espelhadas). É paridade de resultado com acoplamento frágil, não ausência de sinal.
- Busca textual: ambos fazem busca client-side em memória (desktop também — ver memória project_search_client_side). O mobile não é inferior aqui; a diferença é só a ausência do eixo semântico/mood.
- Letras: o desktop tem vetor de letra no Qdrant + view sincronizada; o mobile lê o sidecar .lrc direto (mobile_lyrics.rs) com a MESMA detecção de unsynced (t=0 em tudo). Paridade de visualização; o gap é só de busca.

### telas

- Botão VOLTAR do Android: o mobile não implementou pilha própria porque não precisa — cada navegação é uma entrada de hash no histórico do WebView (src/mobile/nav.ts:1-10, :49-57) e a WryActivity já encaminha o botão para webView.goBack quando há histórico (src-tauri/gen/android/app/src/main/java/dev/cmr/rustifyplayer/generated/WryActivity.kt:65-75). Inclusive fechar o Now Playing funciona por isso (rota /np empilhada). Paridade — e mais elegante que o desktop, que não tem o conceito.
- Sidebar/dock: o desktop navega por sidebar fixa com seções e chip de now-playing (src/components/Sidebar.tsx:71-181); o mobile usa tabbar de 4 abas + dock com mini player e barra de progresso (src/mobile/components/Dock.tsx:63-135), com mapeamento de sub-rotas para a aba de origem (src/mobile/nav.ts:64-71). Formas diferentes, mesma função. NÃO é gap.
- Queue drawer: o desktop tem gaveta lateral (Q) E tela cheia (src/components/QueueDrawer.tsx:50; src/views/Queue.tsx:10); o mobile tem só a rota /queue, alcançável do Now Playing e da Home (src/mobile/components/NowPlaying.tsx:173-175; src/mobile/screens/Home.tsx:38-40). Uma superfície em vez de duas é a decisão certa em 360dp — paridade, não gap.
- Virtualização de listas: o desktop renderiza a lista inteira (For sobre até 5000 faixas em src/views/Tracks.tsx:23-27); o mobile cresce por sentinela IntersectionObserver (src/mobile/components/ui.tsx:66-94), o que é MELHOR que o desktop. Não inverter isso ao portar telas novas.
- Gestos do mini player: swipe horizontal = prev/next e swipe para cima = abrir o Now Playing (src/mobile/components/Dock.tsx:42-61), arrastar para baixo fecha o NP (src/mobile/components/NowPlaying.tsx:108-117). São exatamente os gestos do handoff (Rustify Mobile.html:105-116) e substituem, com vantagem, os atalhos de teclado do desktop.
- Volume: o desktop tem slider na PlayerBar e em Settings (src/components/PlayerBar.tsx:648-663; src/views/Settings.tsx:443-465) porque o PipeWire é controlado pelo app; no Android os botões físicos e o painel do sistema já controlam o stream de mídia do ExoPlayer. Reimplementar um slider no app seria pior. Só a NORMALIZAÇÃO entre faixas (listada como gap) é conteúdo real.
- Arrastar carrosséis horizontais com o ponteiro: o handoff implementou isso à mão (Rustify Mobile.html:119-126) porque rodava com mouse no desktop; no aparelho o scroll por toque das .qs-row/.chiprow é nativo (src/mobile/screens/Library.tsx:37-45). Paridade sem código.
- Retomada de sessão: o desktop restaura fila e posição do state.json (src/components/PlayerBar.tsx:195-231); no mobile o MediaSessionService sobrevive ao WebView e o boot re-sincroniza via get_state + rehidratação do espelho (src/mobile/store.ts:112-130, :371-372), inclusive ao voltar do background (:379-384). Mecanismo diferente, resultado equivalente — a lacuna aqui não é a retomada, é a LEITURA da fila (coberta no gap queue-read-reorder).
- Letras: o desktop tem card flutuante arrastável e redimensionável com box persistido (src/views/NowPlaying.tsx:70-210); o mobile tem rail sincronizada em tela cheia com o estado [data-lyr] encolhendo a capa (src/mobile/components/NowPlaying.tsx:202-217). Arrastar/redimensionar não faz sentido em 360dp — paridade. Ambos detectam letra não sincronizada pela mesma regra (t=0 em tudo): desktop :55, mobile :46.

### visual

- Shapes x renderers: PARIDADE TOTAL verificada nome a nome — 23 shapes e 5 renderers idênticos nos dois lados (src/shapes.ts vs src/mobile/bg/shapes.ts; src/renderers.ts:188-192 vs src/mobile/bg/renderers.ts:137-141). O mobile ainda ADICIONA correção de aspecto (spectrum.ts:151) que o desktop não tem, porque a tela é estreita. Defaults diferem por decisão de design (desktop mesh; mobile pond+dots, spectrum.ts:28-29) — não é gap.
- Lerp de cor: paridade por implementação própria. O desktop usa src/lib/rgbLerp.ts nos canvases; o mobile faz o mesmo lerp exponencial inline (spectrum.ts:195-199) com o mesmo tau 0.35s, lendo --bg-ink-morph. A REGRA DURA (nunca declarar transition de custom property no :root) é respeitada nos dois: applyAdaptiveColor escreve o valor e sai; o canvas suaviza. Nenhum transition de var em tokens.css.
- Derivação de ink/accent: código LITERALMENTE compartilhado — o mobile importa deriveInk/deriveAccent de src/lib/inkDerive.ts e hexToHsl de src/lib/color.ts (adaptiveColor.ts:20-21). Mesma matemática contrast-driven v3. A diferença é só o conjunto de vars escritas (--accent/--accent-c/--on-accent/--on-accent-c no mobile vs as 8 ACCENT_VARS do desktop em tweaks.ts:338), coerente com dois design systems distintos.
- Persistência de shape/renderer: mesma semântica (índice em localStorage, next/prev, wrap com módulo positivo), chaves diferentes por plataforma (rustify-shape-mobile). Não é gap.
- Toggle de visibilidade da letra: o desktop usa tweaks().lyricsVisible dentro do kv-tweaks; o mobile usa a chave kv-mobile-lyrics com botão no header do NowPlaying que SOME quando não há letra (NowPlaying.tsx:151) — mesmo efeito, e o esconder-quando-inútil é melhor que o desktop. Paridade por outro caminho.
- Detecção de letra unsynced: o mobile replica exatamente a regra do desktop (t=0 em todas as linhas => sem linha ativa, viewport estático) em NowPlaying.tsx:46 e data-static. Paridade real.
- Fontes bundladas: os dois lados proíbem CDN e self-hospedam (desktop Instrument Sans em src/assets/fonts; mobile Inter/Fraunces/JetBrains Mono via @fontsource em MobileApp.tsx:19-27). Paridade de política.
- Lista longa: o desktop usa tabela virtualizada; o mobile usa LazyList com IntersectionObserver e chunk de 60 (ui.tsx:66). Técnicas diferentes, mesmo objetivo. Não é gap.
- Reset de scroll ao trocar de tela: o mobile faz explicitamente (MobileApp.tsx:115); o desktop tem roteamento próprio. Paridade.

### plataforma

- Controles de midia do sistema: o desktop usa MPRIS/souvlaki; o mobile usa MediaSession do Media3 (notificacao, tela de bloqueio, botoes de fone). Caminho diferente, resultado equivalente — nao e gap. src-tauri/crates/tauri-plugin-rustify-audio/android/src/main/AndroidManifest.xml:16
- Avanco de fila: no desktop o frontend decide a proxima faixa; no mobile a fila e nativa no Kotlin com auto-advance com tela apagada (mais robusto que o desktop nesse ponto). src/mobile/store.ts:5
- Resiliencia de boot: o desktop nao precisa de retry de IPC; o mobile tem bootCall com timeout+retry por causa da bridge fria do WebView — protecao especifica da plataforma, nao lacuna. src/mobile/store.ts:302
- Re-sincronizacao de estado ao voltar do background: o mobile escuta visibilitychange/focus e re-le get_state, equivalente funcional de o desktop nunca perder o estado. src/mobile/store.ts:355
- Proveniencia dos eventos: o payload do Android e byte-a-byte identico ao do desktop, com teste de contrato contra build_play_event_payload. Paridade real, nao gap. src-tauri/src/mobile_sync.rs:186
- Persistencia de preferencia de fundo (renderer/shape/beat mode): ambos os lados usam localStorage; o mobile ja replica o padrao do desktop. src/mobile/bg/beatSetting.ts:1
- Derivacao de sinal/gosto: o desktop deriva no Qdrant, o mobile consome taste.json/stations.json precomputados — decisao de arquitetura (CMR-190), nao ausencia de recurso.