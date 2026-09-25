# Fase 0 da UI — entrega da v0.2.81 (25/09/2026)

Pedido do CEO: "corrige o que for direto". Escopo: defeitos objetivos da auditoria (`2026-09-25-auditoria-ui.md`), mais CMR-267 (Poeira acelerando), CMR-268 (EQ voltando a Bell) e o custo da Nébula. Nada de redesenho. Nada que dependa das decisões pendentes: clique nas linhas e nos cards, Fraunces, card de letras, cenas novas de fundo.

Como foi feito: 7 frentes em worktrees isoladas com teste antes da correção → integração em `fix/ui-fase0` → revisão em 3 lentes com 3 céticos por achado → fechamento → crítico de completude → segunda passada em loop até zerar pendências (2 rodadas). Merge em `main` (`9efe98f`), bump e release desktop e APK (`390b889`).

Gates no `main`: typecheck ok; vitest 766 (eram 415); `audio-engine` 32 (eram 29); `rustify-player` 169 (eram 164); `validate.py` 12/12 temas reais da cmr-auto (só avisos, a rampa fg agora é corrigida no load).

## Roteiro de revisão (o que dá pra ver)

**Instalar:** `V=0.2.81; gh release download -R PedroGiudice/rustify-player -p "rustify-player_${V}_amd64.deb" -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_${V}_amd64.deb`. No S24, Settings > Atualização.

**Barra de reprodução**
- `More` e clique direito no título abrem o menu da faixa (antes não aparecia nada).
- Seek e volume funcionam pelo teclado (setas, PageUp/PageDown, Home/End) e a área de clique ficou maior sem mudar o trilho.
- Com a fila aberta, a barra continua clicável na primeira vez.
- Shuffle, repeat, letra e mudo ligados ficam na cor de accent, e o hover deixou de ser igual ao ligado.

**Now Playing e fundo**
- Trocar de faixa não pisca mais "Loading…".
- Letra não sincronizada não destaca a primeira linha por engano.
- Com o motor WebGL, os seletores de shape e renderer somem, porque não tinham efeito.
- "Spectrum settings" abre o Tweaks na seção Fundo.
- Artista e álbum levam à página do artista e do álbum.
- Esc no cinema sai com um toque só.
- **Poeira:** a velocidade fica constante. Deixe tocando mais de 5 minutos: antes, o efeito virava "hiperespaço".
- **Nébula:** renderiza em até 256 linhas e escala. Conferir o fps no Tweaks; antes ela passava do orçamento de um quadro sozinha.

**Biblioteca**
- A tabela de faixas voltou a ter padding, separadores e colunas alinhadas.
- `/albums`, `/tracks` e `/artists` abertas direto rolam.
- A grade de álbuns mostra o acervo inteiro (antes cortava em 300, em ordem alfabética).
- A tela Playlists perdeu o mock de smart playlists e os botões mortos.
- A densidade compacta do Tweaks passou a reduzir espaço de fato.
- Capa quebrada mostra o placeholder em vez de uma caixa vazia.

**Signal e Stations**
- O tipo de filtro do EQ não volta mais a Bell ao mexer no ganho (CMR-268).
- A curva desenhada segue o tipo real de cada banda.
- `Flat` zera o EQ. A curva antiga agora se chama `Padrão`.
- Bypass e estágio desligado aparecem nos painéis.
- Saíram "Live · streaming now", o badge Live e o painel Roadmap.
- Os faders funcionam pelo teclado.

**Crate**
- A lista não recria as linhas a cada 800 ms: o popover não fecha sozinho e o foco não some.
- O Backspace no ⌘K não cancela mais o download.
- O Enter em outro controle não baixa a linha.
- O popover de destino fecha com clique fora e com Esc.
- Erros de busca, rede e download aparecem na tela.

**Settings e Tweaks**
- O seletor Light/Dark/Auto saiu, porque não fazia nada.
- Compact sidebar e Beat sync agora mexem no mesmo estado do Tweaks.
- Resume on launch funciona.
- Trocar de tema não mistura as cores do tema anterior.
- O switch desligado ficou distinto do ligado: a rampa fg dos temas agora é corrigida no load.
- O Tweaks fecha com Esc.
- Arrastar um slider do Tweaks não reescreve mais cerca de 25 variáveis no `:root` a cada quadro.
- Os dados falsos do Settings viraram reais (data dir, vetores, licença).

**Geral**
- Foco de teclado visível no app inteiro.
- As dicas de atalho mostram `Ctrl` no Linux, em vez de `⌘`.

**S24**
- O cabeçalho do Now Playing cabe na tela. Rádio, Fila e fundo foram para "Mais opções".
- Voltar e fechar o Now Playing preservam aba, busca e rolagem.
- A fila abre na faixa atual.
- Falha de carga mostra erro com "Tentar de novo", em vez de "acervo vazio".
- Os botões de shape e render só aparecem com o motor 2D ativo.

## Ficou de fora de propósito

Tudo o que é decisão de produto ou de gosto, com o motivo registrado item a item no apêndice. Entre os principais:
- clique nas linhas e nos cards de álbum;
- Fraunces e escalas tipográficas;
- card de letras encaixado ou flutuante;
- tradução geral da interface;
- rota `/queue`;
- o que colocar no lugar do chip do Now Playing no modo só-ícones;
- botão RES e Ctrl+R;
- cabeçalhos sticky;
- unificar os vocabulários de "sem capa";
- mostrar qual station está no ar, que é funcionalidade nova;
- histórico de abas no Android.

## Ambiente reconstruído nesta sessão

A migração da VM (CMR-256) não levou o ambiente de build. Nesta sessão foram instalados:
- `libgstreamer-plugins-bad1.0-dev`;
- `cargo tauri` 2.11.5;
- JDK 17, Android SDK 36 e NDK 27;
- o target `aarch64-linux-android`;
- a keystore original restaurada do backup da cmr-auto. O certificado confere com o APK da 0.2.80.

Tudo isso está documentado no CLAUDE.md, seção "Ambiente de build da VM".


## Apêndice: correções por frente

### shell (`fix/fase0-shell`)

- **shell-1**: O botão More e o clique direito no título da PlayerBar chamavam showPlayerMenu, do menu legado (src/js/components/context-menu.js), que não tem CSS no build e nunca aparecia. Agora os dois chamam openTrackMenu, o mesmo TrackContextMenu Solid das linhas e do More do Now Playing.  
  Teste: PlayerBar.controls.test.tsx > menu da faixa atual (shell-1): 2 testes, vistos falhando antes
- **shell-2**: Seek e volume viraram role=slider com tabindex=0, aria-valuemin/max/now/valuetext ('1:23 of 3:20', '70%', 'muted') e teclado: setas 5 s / 5 pontos, PageUp/PageDown 30 s / 20 pontos, Home/End. O seek pelo teclado chama playerSeek e o volume passa por changeVolume. Um ::before de 16px aumenta a área de clique sem mudar o trilho de 3px, e o marcador do seek também aparece no foco de teclado. O contraste do trilho (--line-2, 1,26:1) não mudou: é cor de design.  
  Teste: PlayerBar.controls.test.tsx > seek como slider (4) e volume como slider (4); CSS conferido no bundle do vite build
- **ds-2**: Corrigida a parte que cai em arquivos desta frente: sliders de seek e volume (ver shell-2), botão de mudo (ver shell-v3) e o .np-mini da sidebar, que tinha role=button e tabindex mas não respondia ao teclado: Enter e Espaço agora abrem o Now Playing. ParamRow, Fader, cards de álbum e station, pl-card, tablist da Library e aria-label do .card__play e do play do Album ficam com as frentes donas desses arquivos.  
  Teste: Sidebar.test.tsx > chip do now playing por teclado (ds-2), mais os testes de slider e de mudo da PlayerBar
- **shell-v3**: O botão de mudo tinha aria-label 'Volume' (o mesmo do slider), title 'Mute' fixo e nenhum aria-pressed. Agora mostra 'Mute' ou 'Unmute' e expõe aria-pressed. Antes ele chamava o IPC setVolume direto, contra a regra de fonte única do volume; agora usa toggleMute() no store/player.ts, que manda para o store e para o engine sem gravar o zero em kv-volume.  
  Teste: player.volume.test.ts > toggleMute (2, vistos falhando antes); PlayerBar.controls.test.tsx > botão de mudo (2)
- **shell-13**: Só o filtro de digitação. isTypingContext (src/lib/keyboard.ts) ignora input, textarea, select, elemento editável (inclusive filho) e composição de IME. App.tsx (N/H/L) e QueueDrawer.tsx (Q) passam a usá-lo, e o Q deixa de responder com Ctrl, Alt ou Meta. Nenhum atalho novo.  
  Teste: keyboard.test.ts (5), App.shortcuts.test.tsx (4), QueueDrawer.test.tsx > atalho Q (3)
- **cfg-10**: Com foco no select de fonte do Tweaks ou no de tema do Settings, digitar N, H, L ou Q já não troca de tela nem abre a fila. É o mesmo filtro isTypingContext de App e QueueDrawer.  
  Teste: App.shortcuts.test.tsx > 'N, H e L com foco num <select> não navegam'; QueueDrawer.test.tsx > 'Q com foco num <select>'
- **nowplaying-v4**: Corrigidos os listeners do App (n/h/l) e do QueueDrawer (q), que são os que tiravam o usuário do Now Playing a partir do select. O listener próprio do NowPlaying.tsx (f, [, ], vírgula, ponto) tem o mesmo filtro incompleto e não é arquivo desta frente; basta trocar a checagem de tag por isTypingContext.  
  Teste: App.shortcuts.test.tsx e QueueDrawer.test.tsx
- **shell-v4**: O evento rustify:open-queue agora aceita detail { open: boolean }, que força o estado. A ação 'Open queue' da palette manda open: true e não fecha mais uma fila já aberta. Sem detail o evento continua alternando, que é o comportamento do botão Queue da barra.  
  Teste: QueueDrawer.test.tsx > evento de abrir a fila (2); CommandPalette.test.tsx > ação Open queue (1)
- **shell-10**: O .queue-scrim tinha inset:0 e z 90, acima da PlayerBar, e fechava a fila em qualquer clique: pausar ou pular com a fila aberta pedia dois cliques. Véu e gaveta agora vão de --titlebar-h até --playerbar-h e deixam livres a PlayerBar, os botões da janela e a área de arraste. No cinema as duas variáveis valem 0, então lá nada muda.  
  Teste: sem teste automatizado: só CSS de layout, que o jsdom não calcula. Regras conferidas no bundle do vite build
- **shell-8**: As setas agora rolam o item ativo para a área visível (scrollIntoView com block:nearest), só na navegação por teclado. Um Enter com a lista desatualizada (debounce pendente ou busca em andamento) antecipa o debounce, guarda os modificadores e só executa quando chega o resultado da query atual. Antes ele executava o item 0 da busca anterior ou o 'Procurar na rede'. Voltar a digitar descarta o Enter guardado. Estados de carregamento e de erro não entraram, conforme pedido.  
  Teste: CommandPalette.test.tsx > navegação por teclado (shell-8): 3 testes, vistos falhando antes
- **shell-22**: No modo icons o contador de downloads do Crate sumia junto com os rótulos. Agora ele fica visível, no canto do item. O rótulo, que era escondido com display:none e levava junto o nome acessível do link, passa a ser escondido só da tela (clip). Nesse modo cada item ganha title com o rótulo. O .np-mini continua escondido e sem substituto: o que colocar no lugar é decisão de layout.  
  Teste: Sidebar.test.tsx > modo icons (2); a parte de CSS do badge e do rótulo foi conferida no bundle
- **shell-5**: Um :where(:focus-visible) de especificidade zero põe um anel com o accent do tema (--focus-outline, 2px sólido em --blue-ring) em todo foco de teclado do shell: nav, botões da PlayerBar, fechar da fila, sliders e RES. Os .tl-dot, que zeravam o outline, ganham :focus-visible próprio. Quem já zera o outline de propósito (inputs com anel próprio) continua valendo.  
  Teste: sem teste automatizado: estilo de foco, que o jsdom não renderiza. Regras conferidas no bundle
- **ds-1**: --ring-focus passou de rgba(163,163,163,.15), com contraste de 1,13 a 1,24:1, para 0 0 0 2px var(--blue-ring): 3,7:1 no tema padrão, e acompanha tema e accent adaptativo. Isso corrige o anel do select, da busca do Crate, do band-detail e da linha focada do Crate. Ficam com as frentes donas: .card__play com opacity 0 no foco, TrackRowTable com display:contents, .slider e .coll-search input, que zeram o outline sem pôr nada no lugar.  
  Teste: sem teste automatizado: token de CSS. Conferido no bundle
- **shell-7**: Nos botões .pb-btn, o estado ligado (shuffle, repeat, letra, mudo) usa --blue-fg em vez de --fg-1, a mesma cor do hover, e o clique passa a mudar o que aparece na tela. .pb-btn[aria-pressed] entrou na lista do halo, e o halo passou a sair de --blue-ring via color-mix.  
  Teste: sem teste automatizado: só CSS. Conferido no bundle
- **cfg-18**: O halo de estado ativo troca o rgba(37,99,235) fixo por color-mix sobre var(--blue-ring), proporcional ao --glow, como pede a spec themes-boost de 07/2026. Não mexi nos estados selecionados do Settings, que usam fg-1 em vez de --primary: é outra área e decisão de design.  
  Teste: sem teste automatizado: só CSS. Conferido no bundle (não sobrou 37,99,235)
- **ds-11**: Azul fixo do halo migrado para color-mix (ver cfg-18). A classe morta .toggle saiu das listas do halo e do :active, e o comentário do --glow agora explica o default 0 do CSS contra o 0.15 do knob. O box-shadow do .app, que fica fora do viewport, não foi mexido: é inócuo.  
  Teste: sem teste automatizado: só CSS. Conferido no bundle
- **shell-20**: Parte de CSS do HUD de recursos. Os tokens que nunca foram definidos (--space-2 a 5, --text-label-xs, --fw-medium) viraram valores fixos: 8/12/16/20px, 10px e 500, os mesmos do tokens.css legado. --surface, --divider, --on-surface*, --surface-container-high e --surface-container-low ganharam fallback nos tokens do Extractor Lab, e o painel volta a ter fundo e espaçamento no tema padrão. --dur-fast entrou no :root com 0.12s (motion.fast da spec; o tema ainda pode sobrescrever via motion-fast em desktop.rs).  
  Teste: sem teste automatizado: só CSS. Conferido no bundle
- **shell-26**: Só a .pb-src: fonte de 8,5px para 10px, com line-height de 1.5 para 1.25 para o chip manter a altura e não empurrar a linha do artista.  
  Teste: sem teste automatizado: só CSS. Conferido no bundle

Pulados com motivo:
- shell-13 (dicas de atalho): Espaço como play/pause e os símbolos das dicas (⌘K, ⌘↵ numa máquina Linux, H e L sem dica em lugar nenhum) ficaram de fora: o pedido para shell-13 era só o filtro de digitação, sem atalho novo.
- shell-20 (RES e Ctrl+R): Tirar o botão RES da titlebar ou trocar o rótulo é decisão de produto. O Ctrl+R capturado em resources.js (src/js, legado) também impede o reload da webview, então removê-lo tem efeito colateral.
- shell-22 (np-mini): O que colocar no lugar do chip do now playing no modo icons é decisão de layout e gosto.
- shell-8 (carregamento e erro): Fora do escopo pedido: estado de carregamento e mensagem de erro de busca são UI nova.
- shell-2 (contraste do trilho): O --line-2 do trilho contra o paper (1,26:1) é cor de design. O preenchimento já tem contraste alto e o verificador relativizou esse ponto.
- ds-1 / ds-2 (fora do shell): Os arquivos são de outras frentes: .card__play, TrackRowTable com display:contents, .slider, .coll-search, ParamRow, Fader, cards e pl-card sem teclado, tablist da Library, aria-label dos plays de card e de álbum.
- nowplaying-v4 / cfg-10 (listener do NowPlaying.tsx): O arquivo não é desta frente. A correção é trocar a checagem de tag por isTypingContext de src/lib/keyboard.ts, que já está pronto.

### nowplaying (`fix/fase0-nowplaying`)

- **CMR-267**: Poeira: a distância em z passa a ser integrada na CPU (advanceDustTravel em src/gl/motion.ts) e entra no shader pelo uniform uTravel, como a Órbitas faz com zoff. O passo usa o avanço do relógio VIRTUAL, então bgSpeed (0 congela) e o beat-sync continuam valendo. O deslocamento fica dobrado em [0, 90), o mesmo período do mod do shader.  
  Teste: src/gl/motion.test.ts: 10 min de sinal real (médios 0.35 ± 0.15) mantêm a velocidade entre 3 e 7 u/s em todos os quadros, com a mesma média no início e no fim; bgSpeed 0 congela; limites de [0, 90)
- **nebula-perf**: Nébula desenha num WebGLRenderTarget de no máximo 256 linhas, com largura proporcional (455x256 em 1366x768), e um segundo quad escala para a tela com filtro linear e dither IGN no composite. Continua UM WebGLRenderer e UM contexto: SceneBase ganhou render(r), a Nébula sempre devolve o renderer para a tela e o setScene zera o render target. GL_CANVAS preto intocado. Corrigido o comentário do GlBackground que chamava a Nébula de 'a mais barata'.  
  Teste: src/gl/budget.test.ts cobre o tamanho do buffer (teto, proporção, nunca zero). O caminho GL não roda no jsdom: shader e custo não foram verificados no app, e o fps precisa ser conferido no Tweaks após a release
- **np-1**: O resource da letra ganhou initialValue e a view lê .latest, que não suspende. A troca de faixa deixa de derrubar o Now Playing para o fallback 'Loading…' do Suspense do router. Durante o IPC fica a letra anterior.  
  Teste: NowPlaying.behavior.test.tsx: com a letra da faixa B pendente dentro de <Suspense>, o fallback não aparece e o título já mostra B (falhava antes)
- **np-4**: Sem linha ativa (letra não sincronizada) nenhuma linha vira is-near. O viewport .is-unsynced pinta a letra corrida em --fg-2. Linhas com header (ex.: [Chorus]) ganham a classe is-header, com estilo de rótulo igual ao do mobile.  
  Teste: NowPlaying.behavior.test.tsx: letra só com t=0 sem is-near/is-active; header recebe is-header. Regras CSS conferidas no bundle (vite build)
- **nowplaying-v2**: Linha do LRC só com timestamp (interlúdio) aparece como '…' em vez de um <p> vazio, como no mobile.  
  Teste: NowPlaying.behavior.test.tsx: a linha vazia ativa renderiza '…' com is-active
- **np-10**: Artista e álbum viraram <button type=button> que levam a /artist/<nome> e /album/<título> (as mesmas rotas e o mesmo encodeURIComponent do menu de contexto), e agora entram na ordem de Tab. O placeholder '—' continua <p>, sem cursor de link. O hover sublinhado também aparece no :focus-visible.  
  Teste: NowPlaying.behavior.test.tsx: os dois são BUTTON e navegam para a entidade codificada; sem faixa não há botão
- **shell-v1**: Mesmo defeito do np-10 (artista e álbum iam para as listas genéricas), corrigido no mesmo commit.  
  Teste: coberto pelo teste do np-10
- **biblioteca-v2**: Mesmo defeito do np-10, corrigido no mesmo commit.  
  Teste: coberto pelo teste do np-10
- **np-6**: Com o WebGL de fato ativo (mesma condição do App.tsx: bgEngine webgl e glStatus.ok diferente de false), os seletores render/shape somem e os atalhos [ ] , . param. Se o WebGL falhou e o 2D reassumiu, os seletores voltam.  
  Teste: NowPlaying.behavior.test.tsx: três casos (WebGL ativo, WebGL que falhou, 2D), com os atalhos incluídos
- **np-7**: O botão 'Spectrum settings' abre o Tweaks (setTweaksOpen) e, no quadro seguinte, rola o .tweaks__body até a seção Fundo. Única mudança em Tweaks.tsx: data-tweaks-section='fundo' no divisor.  
  Teste: NowPlaying.behavior.test.tsx: o clique chama setTweaksOpen(true) e ajusta o scrollTop pela diferença de posição da seção
- **np-8**: Só a dessincronia: o Esc do App passou a emitir 'rustify:cinema' com detail=false em vez de gravar o estado direto. Assim o NowPlaying, que espelha o cinema pelo evento, acompanha, e deixam de ser precisos dois cliques para voltar.  
  Teste: src/App.cinema.test.tsx: Esc no cinema emite detail=false e volta o data-cinema; Esc fora do cinema não emite nada
- **np-9**: O reclamp do card de letras usa um ResizeObserver no .np em vez do resize da janela. Passa a cobrir o cinema e a sidebar em ícones.  
  Teste: NowPlaying.behavior.test.tsx: o .np encolhe de 1200 para 900 px sem resize da janela e o card vai de 700 para 520 px. NowPlaying.test.tsx ganhou um stub de ResizeObserver porque o jsdom não tem a API
- **np-2**: O texto do card de letras segue a luminância real do vidro (src/lib/lyricsInk.ts, pura). Superfície = backdrop (canvas do tema no 2D, preto no WebGL) x brightness, composta com a tinta no alpha. Superfície escura mantém a escala de desenho e só sobe o tom que falha; superfície clara usa a escala espelhada, escura. Pisos: 4,5:1 para ativa, próxima, letra corrida e rótulo; 3:1 para inativas e metadado. O NowPlaying remede a cada mudança de tweaks, de motor e de tema, e escreve --fg-* inline. O vidro não muda. Resultado no tema claro padrão: ativa 8,2:1, próxima 4,6:1, inativa 3,05:1.  
  Teste: lyricsInk.test.ts (reproduz a superfície da auditoria, pisos, hierarquia, fundo WebGL e glass máximo) + NowPlaying.behavior.test.tsx (o card recebe a escala derivada no 2D claro e a escala de desenho no WebGL)
- **ds-18**: Parte de contraste corrigida no mesmo commit do np-2. As linhas inativas saem de ~2,5:1 e atingem no mínimo 3:1 em qualquer fundo; no fundo escuro só --fg-7 muda.  
  Teste: lyricsInk.test.ts: 'fundo escuro: as linhas inativas saem dos ~2,5:1 da escala fixa'
- **np-21**: Visualizer.tsx removido. Nenhum import nem rota o usava (grep em src, index.html e vite.config). O comentário do SpectrumCanvas que o citava foi ajustado.  
  Teste: sem teste: remoção de código morto; typecheck, vitest e vite build verdes sem o arquivo

Pulados com motivo:
- np-8 (restante): Fora do escopo pedido (só a dessincronia pelo Esc). Ficam para decisão: chrome escondida só com opacity/pointer-events e sem inert (Tab alcança controles invisíveis), atalhos H/L/N navegando dentro do cinema e falta de caminho visível para sair.
- ds-18 (paleta do tema): A queixa estética de que a letra ignora a paleta do tema e da capa (bone quente sobre qualquer accent) é decisão de gosto. Só a parte objetiva de contraste foi corrigida.
- np-2 (alternativa): Não foi aplicada a alternativa de escurecer o vidro para manter texto claro no tema claro. A correção escolhida mantém o vidro e troca a cor do texto, seguindo o diagnóstico da auditoria ('o texto não acompanha a luminância real do vidro'). Qual das duas fica é decisão do CEO.

### biblioteca (`fix/fase0-biblioteca`)

- **lib-1**: As células das linhas da tabela de faixas voltam a receber padding, separador e o flex que alinha '#' e 'Length'. O seletor passou a cobrir `.tracks > .tracks__row > div`, porque o wrapper display:contents não muda a árvore DOM. Título e células de texto continuam block, centralizados por align-content, para manter título/artista empilhados e o ellipsis. A transição foi para as células, e o destaque da faixa atual vem depois do hover com a mesma especificidade, então o hover não o apaga mais.  
  Teste: src/styles/layout-modes.test.ts (injeta o extractor-lab.css real no jsdom: as células das linhas têm padding>0 e display flex, título e célula de texto ficam block) + regras conferidas no bundle via vite build
- **lib-2**: As rotas /albums, /tracks e /artists abertas direto trazem o próprio <article class="view">, o único container que rola, e recuperam o fade-in. Como aba da Library continuam sem, para não aninhar dois scrollers.  
  Teste: src/views/LibraryStandalone.test.tsx (standalone: cabeçalho e corpo dentro de .view; como aba: sem .view próprio)
- **ds-7**: Mesma correção do lib-2 (o .view nas rotas standalone). A aba Genres usava .row (grid de 5 colunas começando em 40px) com um único filho, e o nome truncava na coluna de 40px. Ganhou o modificador .row--static: coluna única, sem pointer nem hover.  
  Teste: src/views/LibraryStandalone.test.tsx + src/views/Library.test.tsx (linhas de gênero com row--static; gênero com 0 faixas fica fora) + regra conferida no bundle
- **lib-3**: Os wrappers libGetAlbums, libGetArtists e libGetAlbumsByArtist aceitam `limit: null`, que pede o acervo inteiro; sem o argumento, o default continua o mesmo. As grades de álbuns (antes 300) e de artistas (antes 500) e a página de álbum pedem tudo. A página de artista filtra no backend com libGetAlbumsByArtist, com a mesma igualdade exata do filtro antigo e sem corte. O CoverArt passou a carregar as capas com loading=lazy e decoding=async, para a grade completa não pedir todas as capas de uma vez. Nenhum command Rust foi necessário: lib_list_albums e lib_list_artists já recebem Option<usize>.  
  Teste: src/views/LibraryCatalog.test.tsx (backend falso com a semântica real de query.rs, que ordena e trunca, e acervo de 641 álbuns e 561 artistas: grade completa, álbum do fim do alfabeto na página do artista, capa e artista no detalhe) + src/tauri.library.test.ts (contrato do invoke: limit null / default preservado) + src/components/CoverArt.test.tsx (lazy)
- **biblioteca-v1**: Library e Home contam álbuns e artistas a partir das listagens completas (o IndexerSnapshot só tem tracks_total). Se a listagem falhar, a Library mostra '—' e a Home omite a contagem: nenhum número inventado. A Home deixou de afirmar '12 albums'. O mock de Home.test.tsx inventava albums_total e artists_total e escondia o defeito; agora espelha a struct real.  
  Teste: src/views/Library.test.tsx (abas e hint com contagem real; falha vira '—') + src/views/Home.test.tsx (30 álbuns no acervo → '30 albums', não 12; falha omite a contagem)
- **lib-14**: Só o rótulo: a prateleira 'Based on your favorites' mostra os 12 primeiros em ordem alfabética e passou a se chamar 'Albums'. A seleção das prateleiras não mudou; a Home agora fatia os 12 primeiros da lista completa.  
  Teste: src/views/Home.test.tsx (prateleira com 12 cards e sem 'favorit' nos títulos de seção)
- **lib-9**: Saíram da tela Playlists: o mock de smart playlists (tabela e contagem '3 smart' no cabeçalho), os botões 'New playlist' e 'New smart playlist', o card tracejado 'New playlist · drag tracks here', o 'Reorder ⇅' e o 'View all rules →'. O CSS órfão (.smart-tbl*, .pl-card--new*) também saiu, e o hint deixou de prometer smart playlists.  
  Teste: src/views/Playlists.test.tsx. Os testes antigos fixavam o mock e os botões mortos; foram reescritos para fixar a ausência: toolbar sem botões, sem .smart-tbl nem 'smart', All playlists só com pastas reais, Pinned sem 'Reorder'
- **lib-26**: Só o filtro: as fixadas agora partem da mesma lista filtrada, e a exclusão de 'All playlists' usa os nomes fixados.  
  Teste: src/views/Playlists.test.tsx (duas fixadas; filtrar 'zoo' deixa só 'Zoo Songs')
- **ds-16**: Capa que falha ao carregar (cache apagado, arquivo corrompido) agora cai no cassete, como capa ausente, em vez de virar caixa vazia. O componente guarda a URL que falhou, e trocar de capa tenta a nova. O comentário da prop size dizia que ela dimensiona; foi corrigido para o comportamento real, sem mudança visual.  
  Teste: src/components/CoverArt.test.tsx (onError → .cover__cassette; nova src depois de falha → img real)
- **lib-12**: Mesma correção do ds-16 no CoverArt: imagem quebrada vira o fallback da marca, não um quadrado cinza.  
  Teste: src/components/CoverArt.test.tsx
- **sistema-v2**: O ícone do CTA do hero com capa passou de var(--fg-1) (quase branco nos temas escuros) para #111 literal, porque o fundo do botão também é #fff literal. Contraste de ~18,9:1.  
  Teste: sem teste automatizado: é cor literal num único seletor, e o jsdom não expande o shorthand com var(). Regra conferida no bundle (`.hero-tile--has-cover .hero-tile__cta{color:#111;background:#fff}`)
- **lib-19**: O bloco de densidade compacta foi reescrito. O padding de .view saiu (ele somava margem e descolava os cabeçalhos full-bleed), junto com os alvos inexistentes .track-table__* e o height duplicado da playerbar, que agora vem só de --playerbar-h. O compacto passa a reduzir espaço de verdade em .view__head, .tabs/.tab, .view__body (menos .crate-body), .section__head, .toolbar, nas células da tabela de faixas (inclusive as netas), em .row e .row.is-current, .card-grid/.pl-grid e .card__cover/.pl-card__cover.  
  Teste: src/styles/layout-modes.test.ts (CSS real no jsdom: .view sem padding nos dois modos; cada alvo tem espaço >0 no normal e menor no compacto) + bloco conferido no bundle
- **cfg-17**: O compacto não descola mais o cabeçalho de nenhuma view e agora alcança o Settings (.set, .set-panel__head, .set-row) e o painel Tweaks (.tweaks__body).  
  Teste: src/styles/layout-modes.test.ts (.set, .set-row, .set-panel__head, .tweaks__body reduzem)
- **estsig-22**: O compacto não soma mais margem ao .sig (Signal) nem ao .coll (Stations/Playlists) e passa a reduzir o padding e o gap de ambos.  
  Teste: src/styles/layout-modes.test.ts (.sig e .coll reduzem)
- **ds-13**: O compacto ficou corrigido pelo mesmo bloco do lib-19. Na sidebar só-ícones, o rótulo do nav-item passou a ser escondido só visualmente (fora do fluxo e recortado), em vez de display:none, que tirava o nome acessível do link. O contador de downloads do Crate continua visível, no canto do ícone.  
  Teste: src/styles/layout-modes.test.ts (getByRole('link', {name}) acha Home e Crate no modo ícones; badge não é display:none; kbd continua escondido)

Pulados com motivo:
- lib-19 (parcial): Cabeçalhos sticky (.tabs, .tracks__head) e o tamanho do herói da Playlist são mudança de UX e visual, não defeito objetivo. O .tracks ainda tem overflow:hidden, que anularia sticky. Fica para o revamp.
- ds-13 (parcial): Tooltip (title) nos links do modo só-ícones exige mexer em src/components/Sidebar.tsx, que é de outra frente (shell). O nome acessível, que era o defeito de acessibilidade, está corrigido só com CSS.
- ds-7 (parcial): O template .row que supõe .row__tech (corrigido inline no TrackRowList) e os cabeçalhos de detalhe divergentes (Album 120px/22px, Artist redondo, Playlist 180px/38px) são consistência de design system e gosto, não defeito objetivo.
- lib-12 / ds-16 (parcial): Unificar os quatro vocabulários de 'sem capa' (cassete, tom pastel com disc-3, disc-3 48px, disc-3 14px), os raios de 4/5/8px e o destino das props tone/glyph é decisão visual. Só a capa quebrada virando caixa vazia foi corrigida.
- lib-26 (parcial): Pela instrução, só o filtro. Contagem repetida no card fixado, ícone de pin ambíguo e o link de ordenação fora da ordem de Tab ficaram de fora.
- lib-14 (parcial): Pela instrução, só o rótulo. Continuam como estão: a seleção das prateleiras, libRecommendations buscado e não usado, os tiles duplicados 'Shuffle all' e o 'ready to resume' que leva ao Now Playing.

### signal (`fix/fase0-signal`)

- **motor-v1**: CMR-268. set_eq_band não escreve mais ft-N="Bell". Agora só grava f/g/q, e o tipo do filtro fica exclusivo de set_eq_filter_type. A decisão foi extraída em eq_band_props (função pura), então o teste não precisa instanciar o LV2. O comentário do try_new, que dizia que o tipo nunca mudava, foi corrigido.  
  Teste: cargo test -p audio-engine --lib: set_eq_band_nao_escreve_o_tipo_do_filtro, set_eq_band_converte_ganho_para_linear, set_eq_band_ignora_banda_fora_do_range
- **estsig-4**: Novo módulo eq-response.ts (puro), que calcula a magnitude RBJ por tipo. É o que o LSP roda no modo APO (DR), conferido no Filter.cpp do lsp-dsp-units: nos filtros de passagem o ganho é linear na faixa passante, e no Bell e nos shelves entra sqrt(ganho). Fora do APO, os passa-altas e passa-baixas cascateiam pelo slope. Off e mute não somam, e com solo só contam as bandas em solo. A escala do gráfico passou a ser dinâmica (18/24/36/48/72) e não conta a queda dos filtros de passagem. A curva fica em cache e só é recalculada quando as bandas ou o sample rate mudam. O efeito de redesenho agora observa type, slope, filterMode e solo, e os rótulos do eixo Y acompanham a escala.  
  Teste: eq-response.test.ts (15 testes: tipos, solo, slope, escala) + EqCanvas.test.tsx: redesenho com mutação fina de store (type/slope/solo/filterMode) e escala +36 para ganho de 30 dB
- **estsig-23**: A grade horizontal agora cai nos valores rotulados (±R e ±R/2). Os rótulos do eixo Y ficam na posição exata da curva (fator 0,9). O eixo X entrou no EqCanvas, com os rótulos em escala log e o mesmo PAD_X do canvas, mais 1 px da borda. Antes eles eram distribuídos com space-between.  
  Teste: EqCanvas.test.tsx: grade nas posições 9.5/50/131/171.5 e left log do '1k' (u=0.5663). CSS de .eq-yaxis e .eq-xaxis conferido no bundle do vite build
- **estsig-5**: resetToFlat agora zera o EQ (Bell, 0 dB, sem solo/mute, I/O 0). A curva colorida antiga virou o chip "Padrão" (resetToDefault). O chip marcado ao abrir a tela é resolvido pela curva (resolveActivePreset): um "Flat" salvo pela versão antiga com a curva colorida passa a marcar "Padrão". Apagar um preset não marca mais "Flat" sem o som mudar.  
  Teste: dsp-presets.test.ts (resetToFlat, resetToDefault, resolveActivePreset) + Signal.test.tsx (clique nos chips Flat e Padrão)
- **motor-v5**: presetNameError e importPresetName. Save e Rename recusam os nomes embutidos (Flat, Padrão), e Rename recusa um nome que já existe. O import de Flat.json vira "Flat (importado)". Salvar com um nome existente continua sobrescrevendo, que é o fluxo de salvar alterações.  
  Teste: dsp-presets.test.ts (validação) + Signal.test.tsx (Save 'Flat' recusado, Rename com colisão recusado)
- **estsig-14**: Removidos o painel Roadmap, os dados ROADMAP_*, o RoadmapCardEl e o CSS .plug-* e .sig-subhead* (mais o seletor morto no :where de halo). O teste que fixava o toggle falso foi trocado por um que garante que a tela não simula estágios.  
  Teste: Signal.test.tsx: 3 painéis; sem .plug-card, 'Roadmap' ou 'in chain'
- **estsig-6**: Cada .sig-panel ganhou data-live (enabled && !bypass). Quando o estágio não processa, o corpo esmaece e o cabeçalho mostra "off" ou "bypassed". O toggle do painel continua sendo o do próprio estágio. Os tiles dizem "off" ou "bypassed", e "chain N/4" passa a contar EQ, norm, Limiter e Bass reais. O master virou "DSP chain" com a mesma polaridade dos estágios: ligado = processando.  
  Teste: Signal.test.tsx: polaridade do master (aria-pressed), data-live e rótulo dos painéis e tiles com bypass e com estágio desligado. CSS .sig-panel[data-live=false] conferido no bundle
- **motor-v2**: set_bypassed não mexe no norm_gain. O tile Normalize e o nó norm_gain deixaram de ficar 'off' sob bypass, e o texto do master não promete mais 'Routes raw stream around the entire chain': agora diz que a normalização é configurada no Tweaks.  
  Teste: Signal.test.tsx: tile e nó da normalização inalterados ao ligar o bypass; texto sem 'entire chain'
- **estsig-3**: O trilho do Fader e o ParamRow viraram role=slider focáveis, com aria-valuenow/min/max e aria-valuetext com unidade. As setas movem pelo passo exibido (Shift ×10 no ParamRow; no fader, Shift = 1 dB), PageUp e PageDown dão o passo largo, e Home e End vão ao mínimo e ao máximo. Focar um fader ativa a banda. O foco fica visível com :focus-visible. O ajuste fino do arrasto por modificador não entrou.  
  Teste: Fader.test.tsx e ParamRow.test.tsx: atributos ARIA, tabindex, sequência de teclas e foco ativando a banda
- **motor-v3**: Causa raiz: o ParamRow emitia o float cru do lerp. Agora todo valor emitido é arredondado às casas exibidas. O tile e o cabeçalho do Bass formatam scope e floor com toFixed(0), o que cobre também o valor cru que já está persistido.  
  Teste: ParamRow.test.tsx (arrasto emite 138, não 137.6) + Signal.test.tsx ('scope 137 Hz · floor 33 Hz' com o valor cru no store)
- **motor-v4**: Regra .fader__input criada: largura da coluna (máx. 48 px), fonte mono 10 px, sem spinners, borda e foco.  
  Teste: sem teste unitário (só CSS; o jsdom não aplica estilo): regra conferida no bundle do vite build
- **estsig-1**: Removidos o eyebrow pulsante 'Live · streaming now' e o selo 'Live' (1º card e placeholders), junto com o CSS .st-card__live. O destaque é a station mais tocada (o backend ordena por played desc) e agora diz 'Most played' quando played > 0. A prop isFirst foi removida.  
  Teste: Stations.test.tsx: nenhum card nem o destaque contêm Live ou 'streaming now' (os testes antigos que fixavam o selo do mock foram trocados)
- **estsig-20**: O CTA usava ph:play-fill, que não está no bundle offline. Passou a usar lucide:play, o mesmo ICONS.play do app.  
  Teste: Stations.test.tsx: iconLoaded(ícone do CTA) === true depois de importar icons-offline
- **estsig-13**: Só a parte objetiva. 'Resume station' iniciava uma sessão nova e virou 'Play station'. O slot de match_avg, que o backend nunca preenche, só aparece quando houver valor (sai o '—' fixo). O contador 'seeded' também contava mood stations e virou 'N stations'.  
  Teste: Stations.test.tsx: CTA 'Play station', card sem '—' com match_avg null e cabeçalho '6 stations'
- **motor-v6**: O contador do cabeçalho lê stations.latest em vez de !stations.loading, então mantém o número durante o refetch (tocar, criar, apagar).  
  Teste: Stations.test.tsx: com o refetch pendente, o cabeçalho segue '6 stations' e depois vai para '5 stations'
- **motor-v7**: Singular: 'seed · 1 track'.  
  Teste: Stations.test.tsx: seed de uma faixa usa singular
- **estsig-2**: O card virou role=button focável, e Enter ou Espaço tocam a station (Enter no botão de apagar continua sendo só dele). 'New from current track' e 'Nova mood station' viraram <button> (eram <a> sem href), este último com aria-expanded. Os chips ganharam aria-pressed, o select e o input ganharam aria-label, e o card e as ações têm foco visível.  
  Teste: Stations.test.tsx: role e tabindex do card, Enter toca, Enter no apagar não toca, ações são BUTTON, aria-pressed dos chips e aria-label dos campos
- **estsig-19**: O botão de apagar aparece quando o card tem foco (:focus-within) e no próprio foco (:focus-visible), não só no hover.  
  Teste: sem teste unitário (só CSS): regra conferida no bundle do vite build
- **estsig-10**: O StationViz guarda as dimensões em cache e só realoca o canvas pelo ResizeObserver, sem getBoundingClientRect nem width/height por frame. Com prefers-reduced-motion desenha um quadro estático e não roda loop. O pulso stPulse também para em reduced motion (CSS).  
  Teste: StationViz.test.tsx: 3 frames sem setter de width nem medição; reduced motion sem requestAnimationFrame

Pulados com motivo:
- estsig-13 (parte de IA/gosto): O feature card duplicando o card nº 1, a desc repetida no hint e no chip de seed, a query aparecendo 3 vezes na mood station e o título do destaque (28px) maior que o h1 (22px) são decisões de arquitetura de informação e escala tipográfica, fora do escopo de defeito objetivo.
- estsig-19 (opacidade em repouso): O botão de apagar continua com opacity 0.35 em repouso e o 'Apagar?' em 10 px mono. Revelar no hover é padrão deliberado do app (.pl-card__pin usa opacity 0), então subir o contraste em repouso é decisão visual. A parte objetiva (invisível ao teclado) foi corrigida.
- estsig-3 (precisão do arrasto): O ajuste fino do arrasto por modificador e o reset por duplo clique no thumb não entraram: exigem decidir como o gesto funciona. O ajuste fino fica coberto pelo teclado (passo de 0,1 dB) e pelo input digitado.
- estsig-1 (indicar a station realmente tocando): Mostrar qual station está no ar (player.queueSource / radioSession.stationId) é funcionalidade nova, não remoção de informação falsa. Fica como sugestão de follow-up.

### crate (`fix/fase0-crate`)

- **crate-1**: O poll de slsk_results só roda enquanto a busca está running (ou antes do primeiro snapshot). O slsk_status saiu do ciclo de 800 ms e ganhou intervalo próprio de 5 s. Grupos da busca e jobs da Fila viraram stores reconciliados por group_key/job_id (reconcile do solid-js/store), então as linhas não são mais recriadas a cada ciclo. Resposta atrasada de busca já substituída é descartada. O mock antigo devolvia sempre o mesmo objeto e mascarava o remount; passou a devolver objeto novo a cada chamada.  
  Teste: Crate.test.tsx 'Crate — poll de resultados' (para no terminal, linha e seletor sobrevivem ao poll, status a cada 5 s, com fake timers) + 'Crate — aba Fila' (linha não recriada); crate.test.ts 'evento com objetos novos reconcilia por job_id'
- **crate-v5**: O painel de fontes guarda a ordem de chegada dos peers e chaveia as linhas pelo id do candidato: o ranking reordenando durante a busca não troca mais o peer sob o 'Usar'. Peer novo entra no fim. O 'Baixar' da linha continua usando o melhor candidato no momento do clique (regra de produto).  
  Teste: Crate.test.tsx 'painel de fontes mantém a ordem de chegada dos peers enquanto o ranking muda'
- **crate-11**: O estado do seletor de destino subiu para um único signal na view (toolbar ou group_key), então só um fica aberto por vez e o estado sobrevive ao poll. Fecha com mousedown fora de .crate-dest e com Esc; o Esc respeita defaultPrevented para não brigar com a ⌘K e devolve o foco ao chip. O chip ganhou aria-haspopup e aria-expanded.  
  Teste: Crate.test.tsx 'Crate — seletor de destino se comporta como popover' (clique fora, Esc, um aberto por vez, aria)
- **crate-2**: O handler de teclado saiu do window e foi para a lista de resultados (div focável, role=group). Teclas vindas de input, botão, select ou link ficam com o próprio controle, e o evento com defaultPrevented é ignorado. O ⌫ só cancela nos estados que mostram [Cancelar] (queued/enqueued/downloading). Clicar na linha foca a lista. A seleção passou a ser pela chave da faixa, porque as linhas reordenam durante a busca. CSS: a lista focável usa --ring-focus no corpo da lista (.crate-list:focus-visible > .crate-list-inner), conferido no bundle.  
  Teste: Crate.test.tsx 'Crate — teclado escopado à lista' (⌫/Enter fora da lista não agem, tecla vinda de botão da linha não aciona, ⌫ não cancela stalled, ⌫ cancela downloading, seleção segue a faixa)
- **crate-4**: ↓ no campo de busca leva o foco para a lista (paridade com a ⌘K) e ↑ na primeira linha volta ao campo. A seleção por teclado rola para a vista com scrollIntoView({block:'nearest'}). Enter numa linha sem destino abre o seletor com foco na primeira pasta, igual ao clique em [Baixar].  
  Teste: Crate.test.tsx '↓ no campo de busca leva o foco para a lista, e a seleção rola para a vista', 'Enter numa linha sem destino abre o seletor', 'com foco na lista: ↓ seleciona a próxima linha e Enter baixa a selecionada'
- **crate-v1**: O Crate observa a rota: /crate/a → /crate/b (a ⌘K 'Procurar na rede' com o Crate aberto) atualiza o campo e refaz a busca. Em src/router.tsx, navigate() re-emite a rota quando o hash já é o mesmo, para 'Procurar' com o mesmo termo também refazer. Views que só leem path/param recalculam para o mesmo valor e não reagem. Com o teclado escopado, o Enter da ⌘K também não dispara mais a linha selecionada.  
  Teste: Crate.test.tsx 'Crate — rota /crate/<busca> reativa (crate-v1)' (termo novo e re-navegação para o mesmo termo) + teste de ⌫/Enter em input externo
- **crate-3**: A escolha feita no chip da linha passou a vencer o destino da toolbar (precedência: linha > toolbar > artista no acervo > último usado), como diz o handoff v1.1 ('herda o destino global até ser trocado na própria linha'). Antes, a escolha era ignorada em silêncio com estilo de override. O title do chip da linha virou 'Destino desta faixa'. Os testes IM-D1 seguem verdes.  
  Teste: Crate.test.tsx 'Crate — destino escolhido na linha: vence o destino da toolbar'
- **crate-6**: Busca recusada por busy (limite de 40/h), por offline ou por erro desconhecido (ex.: timeout do coordinator) mostra aviso em texto simples no banner âmbar existente, com role=alert e [Fechar]. Falhas de baixar, cancelar e trocar fonte também aparecem, nas duas abas. As strings fixas do coordinator (sem acento) viram português na tela. [Trocar fonte] só aparece quando o job tem fonte não tentada (mesma regra do backend), na busca e na Fila. O pacer não mudou.  
  Teste: Crate.test.tsx 'Crate — erros aparecem na tela (crate-6)' (busy, timeout, falha ao baixar + Fechar, Trocar fonte some sem fonte não tentada na busca e na Fila, erro de trocar fonte)
- **crate-8**: Enter no campo durante a busca não faz nada, e o campo fica readOnly e aria-busy enquanto a busca corre (spec §6.1). A busca anterior só é cancelada depois que o backend aceita a nova: antes, uma recusa por cooldown matava a busca em voo. 'Buscando' virou valor derivado (pedido pendente ou snapshot running). O cabeçalho mostra 'Buscando · N respostas' e a .crate-prog existente contra a janela de 25 s (role=progressbar) no lugar de 'Resultados · 0 faixas'. CSS .crate-list-head__lead conferido no bundle.  
  Teste: Crate.test.tsx 'Crate — busca em voo (crate-8)' (Enter durante a busca, recusa pelo pacer não cancela a anterior e aceite cancela, cabeçalho com respostas e barra a 50%)
- **crate-16**: O painel de fontes recebe o job da linha. Com job em voo, 'Usar' fica desabilitado (com title explicando); antes criava um segundo download paralelo, porque o job_id é por peer+arquivo. A fonte servindo ganha a pill 'em uso' e as já tentadas ganham 'tentada'. Com o job terminal (falhou), 'Usar' volta a funcionar. CSS: .crate-btn:disabled (não existia), conferido no bundle.  
  Teste: Crate.test.tsx 'Crate — fontes com download já existente (crate-16)' (em voo: Usar desabilitado, em uso/tentada; falhou: Usar ativo e fonte marcada)
- **crate-v4**: O banner 'Já tem no acervo' só aparece para a faixa do probe cujo título (sem '(feat. …)', '[…]' e ' - sufixo', sem acento e sem caixa) está inteiro, como palavras, no termo buscado. Escolhe essa faixa mesmo que não seja a primeira do probe. Antes, qualquer match por artista ou álbum afirmava posse de outra faixa. Função pura exportada dedupMatch.  
  Teste: Crate.test.tsx 'Crate — banner Já tem no acervo (crate-v4)' (busca por artista/álbum sem banner, título fora da 1ª posição, acento/caixa)

Pulados com motivo:
- crate-4 (parcial): Não fiz foco automático no campo ao abrir a view: com o foco no input, os atalhos globais N/H/L (App.tsx ignora input) deixariam de funcionar, e isso é escolha de produto. Também não mexi nos kbd dentro do campo nem na legenda sem Esc/⌫, que são texto e visual; o ↓ a partir do campo agora funciona.
- crate-11 (parcial): Não fiz o menu abrir para cima nas últimas linhas, o filtro de pastas nem a opção de criar pasta com zero playlists: são decisões de layout e feature, não defeito direto. O escopo pedido (clique fora, Esc, um aberto por vez) está feito.
- crate-16 (parcial): A fonte ORIGINAL de um job que já trocou de peer não é marcada como 'tentada': o board não guarda o id dela (tried_source_ids só recebe as alternativas). Marcar exigiria mudar o backend (board/coordinator).
- crate-v5 (parcial): O 'Baixar' da linha continua usando group.best no momento do clique: 'disponibilidade ganha de qualidade' é regra de produto (spec §4.4), e a linha não exibe o peer. Só o painel de fontes foi estabilizado.
- crate-8 (parcial): O contraste do botão 'Buscando…' desabilitado (opacity .55, ~3.94:1) é tema do crate-10 (contraste), fora desta lista.

### config (`fix/fase0-config`)

- **cfg-1**: Controles do Settings que não faziam nada: o seletor Light/Dark/Auto saiu (gravava body[data-theme], que nenhuma regra CSS lê). Compact sidebar e Beat sync agora mexem no mesmo estado do Tweaks (tweaks.sidebar e tweaks.bgBeatMode, com Off/Speed/Pulse). Resume on launch virou preferência do player store (resumeOnLaunch, na mesma chave antiga, para manter a escolha já salva), e o PlayerBar só chama restoreSession() com ela ligada. Commit e9561a8.  
  Teste: Settings.test.tsx (sem seletor de modo; Beat sync e Compact ligados ao Tweaks; Resume grava a preferência), PlayerBar.resume.test.tsx (com o Resume desligado, persistLoadState não é chamado; conferi que esse teste falha quando tiro a correção) e player.resume.test.ts
- **ds-4**: Mesmo defeito do cfg-1 (seletor Light/Dark/Auto sem efeito), resolvido tirando o seletor. O tema YAML é o modo. Commit e9561a8.  
  Teste: Settings.test.tsx: 'Appearance não tem o seletor Light/Dark/Auto'
- **cfg-2**: Dados falsos exibidos como fato. O cabeçalho mostra o data dir real (~/.local/share/rustify-player). Music folder mostra ~/Music. A linha do qdrant perdeu o 'status ok' fixo e lista os dois vetores reais (mert 768, lyrics 1024). No About, Backend perdeu o 'cpal', a licença passou a MIT (como no Cargo.toml) e o item Branch fixo foi removido. 'PipeWire · default sink' e 'Tauri 2.x' ficaram, porque o verificador confirmou que são verdadeiros. Commit 73e7185.  
  Teste: Settings.test.tsx, bloco 'Settings não exibe dado falso (cfg-2)'. O teste antigo do About exigia o item Branch e foi reescrito
- **cfg-24**: Com o som mudo, o volume do Settings mostra 0, como o PlayerBar. Mexer no slider continua passando por changeVolume(), que desmuta. Commit a2b71de.  
  Teste: Settings.test.tsx: 'volume do Settings respeita o mute'
- **cfg-4**: A regra .status-pill foi portada para extractor-lab.css (seção Settings), usando os tokens --green/--amber/--rose que valem hoje, e ganhou a variante --err (commit 596e859). Depois apaguei components.css, layout.css e base.css (commit 8153c12). Antes confirmei que nenhum import os carrega, nem no desktop, nem no mobile, nem no src/index.html. As classes em uso que só existiam neles eram três: .status-pill (portada); .segmented__btn (já coberta por '.segmented button'); e .ctx-menu/.icon--sm, usadas só pelo menu legado do shell-1, que não portei. Um vite build antes e outro depois da remoção geraram CSS com md5 idêntico.  
  Teste: Testes de classe no Settings.test.tsx. A regra no bundle foi conferida com vite build em pasta temporária (as quatro regras .status-pill* estão no boot-desktop-*.css)
- **config-v6**: O badge de contraste agora separa ok (AA/AAA), warn (AA-large) e err (abaixo de 3:1). O contador 'N falha(s)' conta só falhas reais, e AA-large tem contagem própria ('N só AA-large'). Commit 596e859.  
  Teste: Settings.test.tsx: badge ok/warn/err e os dois casos do contador
- **config-v1**: Ao trocar de tema, applyTheme remove as vars que o tema anterior declarou e o novo não declara. clearThemeVars (o caminho do Default) tira só as vars do tema, e o Settings não apaga mais o style inline inteiro. Commit ea34e71.  
  Teste: tauri.theme.test.ts, que roda o módulo real com __TAURI__ simulado
- **config-v2**: Quando o YAML é inválido ou está ausente, o erro aparece na tela (role=alert) e o select volta ao tema ativo, em vez de mostrar um tema que não foi aplicado. No boot, a falha é registrada no log em vez de ser engolida. Commit ea34e71.  
  Teste: Settings.test.tsx: 'tema que falha ao carregar mostra o erro e o select volta ao tema ativo'
- **config-v3**: Novo comando Rust unwatch_theme (ThemeWatchState::stop_current, que o watch_theme também passou a usar), chamado quando o usuário volta ao Default. O hot-reload (wireThemeHotReload) só reaplica o tema que está ativo, e a calculadora ignora eventos de outro arquivo. Commit ea34e71.  
  Teste: desktop.rs stop_current_derruba_o_watcher_ativo_e_esvazia_o_estado; tauri.theme.test.ts (ignora theme-changed de tema que não é o ativo; unwatchTheme); Settings.test.tsx (Default derruba o watcher)
- **cfg-14**: O listener do hot-reload agora é registrado sempre no boot, e não só quando já havia tema salvo. O Settings abre mostrando o contraste do tema ativo. Ficaram de fora a exibição do autor do tema e o recarregamento da lista sem sair da tela, porque não são defeito. Commit ea34e71.  
  Teste: Settings.test.tsx: 'abre com o diagnóstico de contraste do tema ativo'; tauri.theme.test.ts: 're-aplica quando o arquivo alterado é o tema ativo'
- **sistema-v1**: A ponte de temas (enforce_fg_ramp no load_theme) garante que fg-7 e fg-8 nunca tenham mais contraste com o canvas que o degrau anterior. Quando a rampa está invertida, fg-8 passa a ser dividers.prominent composto sobre o canvas (com o alpha que os YAMLs descartavam) e fg-7 passa a ser 60% do degrau âncora + 40% desse valor. Cada correção sai no log. O validate.py replica as mesmas fórmulas, incluindo o arredondamento, e emite o aviso 'rampa fg invertida' com o valor que o backend vai aplicar. Comparei Rust e Python com um teste temporário, fora do commit: os valores saem idênticos nos 12 temas reais da cmr-auto. 11 temas são corrigidos; o really-dark já estava certo. Os YAML não foram editados. Commit c330629.  
  Teste: desktop.rs: fg_ramp_invertida_e_corrigida_como_no_validate_py, fg_ramp_monotonica_fica_intocada, fg_ramp_nao_mexe_no_fg8_rgba_do_bridge; scripts/themes/test_validate.py com os mesmos números (#65635e e #343432 no caso copper)
- **np-18**: O prefixo 'lyrics-' foi aceito em yaml_key_to_css_prop (desktop.rs) e no validate.py. Quando o Lyrics glass não foi mexido pelo usuário, o store de Tweaks passou a restaurar o --lyrics-* declarado pelo tema, em vez de removê-lo. As cores fixas do card de letras ficaram de fora, porque dependem da decisão do revamp. Commit 3dfa76e.  
  Teste: desktop.rs secao_lyrics_do_yaml_vira_vars_lyrics; test_validate.py test_prefixo_lyrics; tweaks.test.ts 'sem dirty, restaura as vars de lyrics que o tema declarou'
- **config-v4**: Type Mono agora vence a UI Font e a fonte do tema. A função userFontSans() grava var(--font-mono) no inline, tanto no applyTweaks quanto no listener de theme-applied. Commit ab86786.  
  Teste: tweaks.test.ts, bloco 'Type Mono' (dois casos)
- **cfg-9**: O Esc fecha o Tweaks. O listener fica em captura no window e para o evento, então o mesmo toque não sai do cinema mode. O gatilho da sidebar ganhou aria-controls='tweaks-panel' (o aside ganhou esse id) e aria-expanded, e o tooltip desatualizado foi corrigido. Commit f63eb5f.  
  Teste: Tweaks.test.tsx (Esc fecha; o Esc não chega ao handler global; id do painel) e Sidebar.test.tsx (aria-expanded/aria-controls)
- **cfg-15**: O effect global dos Tweaks agenda um único requestAnimationFrame por quadro e grava no localStorage com debounce de 300 ms. flushTweaks() aplica e grava o que estiver pendente e roda no beforeunload. Os caminhos síncronos (loadTweaks, applyTweaks explícito, theme-applied, ink/accent adaptativo) continuam iguais. O efeito em fps não foi medido no app. Commit d9c6dba.  
  Teste: tweaks.test.ts, bloco 'arrasto de slider (cfg-15)': 5 inputs no mesmo quadro geram 1 escrita com o valor final; 1 gravação só depois que o arrasto para; flushTweaks. Os testes antigos que conferiam o DOM logo após updateTweak testavam justamente a escrita síncrona que foi corrigida, e passaram a chamar flushTweaks() antes de conferir

Pulados com motivo:
- cfg-14 (parte): Exibir ThemeInfo.author e recarregar a lista de temas sem sair do Settings não são defeitos. A lista já recarrega a cada vez que a view monta. O resto do cfg-14 foi corrigido.
- cfg-9 (parte): Mover o foco ao abrir o painel e incluí-lo no Command Palette ficaram fora: o pedido desta fase era o Esc e o aria-expanded, e o palette é de outra frente.
- np-18 (parte): Colocar o card de letras no sistema de tokens (cores fixas e --fg-* locais em extractor-lab.css) depende da decisão pendente sobre o card encaixado ou flutuante. Só a ponte de temas foi corrigida.

### mobile (`fix/fase0-mobile`)

- **mobile-v1**: setBaseRoute agora compara por valor (path + param). Abrir e fechar o NP deixa de recriar a tela de base, e o navigateFromNp deixa de remontar duas vezes.  
  Teste: src/mobile/nav.test.ts: 'baseRoute (mobile-v1)', 3 casos (NP abre e fecha, navigateFromNp para a mesma rota, rota diferente ainda notifica)
- **mobile-3**: A faceta da Library e o termo e o escopo da Search passam a viver no módulo da tela. A rolagem da .view fica guardada por entrada do histórico (id em history.state): voltar devolve a posição, e a restauração reaplica a cada quadro enquanto o LazyList ou o IPC da pasta crescem, cedendo ao toque do usuário. Entrada nova continua abrindo no topo. Os links 'Ver todos/todas' da Home abrem a faceta certa (o de Álbuns caía em Pastas).  
  Teste: nav.test.ts ('rolagem por entrada do histórico', 'restoreScroll') e screens/navState.test.tsx (faceta e busca sobrevivem à remontagem; 'Ver todos' de Álbuns e de Pastas)
- **mobile-2**: Criado is2dActive() em bg/engine.ts: motor 2D escolhido, ou WebGL que falhou. É a mesma regra com que o MobileApp decide qual fundo montar. Shape e render só aparecem quando o 2D está desenhando de fato.  
  Teste: src/mobile/bg/engine.test.ts (4 casos) e NowPlaying.test.tsx, bloco 'shape/render (mobile-2)'
- **mobile-v5**: O Settings mostra a linha de render e shape sempre que o 2D está ativo, inclusive no fallback com o WebGL em falha.  
  Teste: src/mobile/screens/Settings.test.tsx (WebGL em falha mostra os controles; WebGL ok esconde; 2D mostra)
- **mobile-v3**: Fila, aberta a partir do NP, usa navigateFromNp (replace): voltar da fila não reabre o Now Playing. Depois do mobile-1, a ação mora na sheet e consome a sentinela antes de navegar (closeSheetThen).  
  Teste: NowPlaying.test.tsx, bloco 'Fila (mobile-v3)'
- **mobile-1**: O cabeçalho do NP fica com Letra (quando há letra), Curtir, Mais opções e Fechar, em alvos de 44px que não encolhem. Isso dá 188px, que cabem nos 316px úteis. Uma margem negativa mantém a altura da linha, e o eyebrow cede com reticências se faltar largura. Rádio da faixa, Fila e render/shape (este só com o 2D ativo) vão para uma sheet de overflow, novo kind 'np' no primitivo de sheet que já existia. Criado o ícone 'more'; a regra .shapebtn ficou sem uso e foi removida.  
  Teste: NowPlaying.test.tsx, bloco 'cabeçalho cabe no S24 (mobile-1)'. A regra .np .npacts .iconbtn (44px, margin -4px 0) foi conferida no CSS do bundle com vite build
- **mobile-6**: A falha do Cover passa a ser guardada por path, não por instância. A capa da faixa seguinte volta a carregar, e a capa que falhou não é re-tentada.  
  Teste: src/mobile/components/Cover.test.tsx
- **mobile-12**: A carga da biblioteca que falha vira libError, e as telas de acervo (Home, Library, Search, Queue, Álbum, Artista) passam pelo LibGate, que mostra o erro com 'Tentar de novo' (reloadLibrary, com o mesmo bootCall do boot). O subtítulo diz 'acervo indisponível' em vez de '0 faixas'. Um rescan bem-sucedido limpa o erro.  
  Teste: store.test.ts, bloco 'reloadLibrary', e screens/loadErrors.test.tsx, bloco 'Home (mobile-12)'
- **mobile-13**: Folder lê data.error antes de data(): o resource em erro deixa de relançar a exceção e derrubar a tela. Aparece um estado de erro com 'Tentar de novo' (refetch), e a meta mostra 'falha ao carregar' em vez de '0 faixas'.  
  Teste: screens/loadErrors.test.tsx, bloco 'Pasta (mobile-13)': IPC falha, aparece o erro, o retry carrega
- **mobile-14**: Corrigida só a parte do falso negativo: Álbum e Artista esperam o acervo pelo LibGate e não dizem mais 'não encontrado' antes da carga nem com ela em falha.  
  Teste: screens/loadErrors.test.tsx, bloco 'Álbum e Artista (mobile-14)'
- **mobile-v4**: A duração do toast passa a crescer com o texto: cerca de 55 ms por caractere, com piso de 1,6 s e teto de 5 s.  
  Teste: store.test.ts, bloco 'showToast (tempo de leitura — mobile-v4)'
- **mobile-4**: Corrigido só o toque morto: tocar a aba ativa na raiz dela sobe a .view ao topo, sem empilhar histórico. Numa sub-rota, a aba continua levando à raiz.  
  Teste: src/mobile/components/Dock.test.tsx, bloco 'tabbar'
- **mobile-5**: Corrigida só a posição de abertura: com histórico, a fila rola até 'Tocando agora' ao montar. Ao voltar para a fila, a restauração de rolagem vence e devolve a posição que o usuário tinha deixado.  
  Teste: src/mobile/screens/Queue.test.tsx
- **mobile-20**: NP fechado recebe inert e aria-hidden. O seek vira role=slider (valuemin, valuemax, valuenow e valuetext), com setas de ±5 s e Home/End. O nav ganha aria-label e as abas ganham aria-current=page. A área de título do mini vira role=button focável que abre o NP por Enter, Espaço ou ativação do leitor de tela; o click que ecoa um gesto de toque é ignorado. A sheet ganha aria-labelledby, e o foco entra no painel ao abrir. O toast passa a ter região role=status persistente.  
  Teste: NowPlaying.test.tsx (acessibilidade), Dock.test.tsx (acessibilidade), components/Sheet.test.tsx, components/Toast.test.tsx

Pulados com motivo:
- mobile-4 (parte): Não mexi no empilhamento de abas no histórico nem em chips fixos. Se o voltar do Android percorre as abas visitadas (YouTube e Instagram fazem assim) ou volta direto para a Home (Material 3) é decisão de produto. Chips fixos no topo da Library seriam mudança de layout, não defeito.
- mobile-5 (parte): Não mexi no toque da linha 'Tocando agora', que é um no-op: o comportamento de clique em linhas de faixa está pendente com o CEO. Também não mexi na opacidade .62 do histórico (contraste 2,58:1), um desbotamento visual deliberado; mudá-la é decisão visual.
- mobile-14 (parte): Não mexi no carregamento só em texto: esqueleto de lista e indicador de progresso no Re-scan e na Atualização são desenho novo, não defeito.
- mobile-20 (parte): O polegar visual do seek durante o arraste é mudança visual; ficou de fora.

### Revisão adversarial da integração

- (correcao, media) Esc do Tweaks em captura engole o Esc da ⌘K, do menu de contexto, da fila e do seletor do Crate — `src/views/Tweaks.tsx:216`
- (correcao, baixa) Com 'Resume on launch' desligado, a exclusão de recentes do autoplay também deixa de ser restaurada — `src/components/PlayerBar.tsx:221`
- (plataforma, baixa) Esc do Tweaks em captura no window engole o Esc de overlays que ficam por cima dele — `src/views/Tweaks.tsx:210`
- (plataforma, baixa) Library faz duas varreduras completas extras no Qdrant, no thread principal, só para exibir duas contagens — `src/views/Library.tsx:24`
- (plataforma, baixa) Regras de :focus-visible duplicadas repetem o anel global com valor fixo — `src/styles/extractor-lab.css:2728`
- (testes-a11y, media) Esc do Tweaks (listener de captura no window) é consumido antes dos overlays que estão por cima e antes do Esc do input do Fader — `src/views/Tweaks.tsx:209`
- (testes-a11y, baixa) Botão de mudo troca o rótulo (Mute/Unmute) e também expõe aria-pressed: o leitor de tela anuncia estado contraditório — `src/components/PlayerBar.tsx:675`
- (testes-a11y, baixa) Card de station virou role=button com aria-label e ficou com o botão de apagar aninhado dentro — `src/views/Stations.tsx:211`
- (testes-a11y, baixa) Mobile: inert só no NP fechado; com o NP aberto, a tela e o dock atrás continuam acessíveis — `src/mobile/MobileApp.tsx:161`
- (testes-a11y, baixa) Mobile: a sheet move o foco para dentro ao abrir, mas não o devolve ao fechar — `src/mobile/components/Sheet.tsx:266`
- (testes-a11y, baixa) Modo cinema esconde a chrome só com opacity; os sliders novos de seek e volume viram paradas de Tab invisíveis — `src/styles/extractor-lab.css:199`
- (testes-a11y, baixa) Esc no cinema com a fila (ou o menu de contexto) aberta fecha o overlay e sai do cinema no mesmo toque — `src/App.tsx:66`
- (testes-a11y, baixa) Foco invisível no slider de volume do Settings: .slider { outline: 0 } vence o :where(:focus-visible) novo — `src/views/Settings.tsx:435`
- (testes-a11y, baixa) Cards de playlist continuam role=button focáveis sem teclado — `src/views/Playlists.tsx:173`
- (testes-a11y, baixa) Tablist da Library sem role=tab nem aria-selected — `src/views/Library.tsx:62`
- (testes-a11y, baixa) Lista do Crate virou widget focável com navegação por setas, sem semântica de seleção — `src/views/Crate.tsx:1262`

Fechamento:
- Esc do Tweaks em captura engole o Esc da ⌘K, do menu de contexto, da fila e do seletor do Crate (Tweaks.tsx:216, média): Commit 67a4acf. Criei src/lib/escLayers.ts, uma pilha única de overlays: a camada aberta por último fecha primeiro, o listener fica em bubble no window e um controle focado que já tratou o Esc (preventDefault) tem precedência. Tweaks, QueueDrawer, TrackContextMenu e o seletor de destino do Crate agora entram na pilha; o Tweaks deixou de usar captura e stopPropagation. Testes novos em escLayers.test.ts e Tweaks.test.tsx, com a fila, a ⌘K e o menu de contexto reais abertos por cima do painel.
- Esc do Tweaks em captura no window engole o Esc de overlays por cima dele (Tweaks.tsx:210, baixa): Mesma correção do 67a4acf: o Tweaks agora é uma camada da pilha e só fecha quando é a camada de cima e ninguém tratou o Esc antes.
- Esc do Tweaks consumido antes dos overlays e do input do Fader (Tweaks.tsx:209, média): Coberto pelo 67a4acf. O Fader já chama preventDefault no próprio Esc, e a pilha respeita defaultPrevented. Com a edição em curso, o Esc cancela a edição, o painel continua aberto e o onChange não é chamado. Teste com o Fader real em Tweaks.test.tsx. De quebra, o Esc no campo de busca do Crate também passou a marcar a tecla como tratada, com teste no Crate.test.tsx.
- Esc no cinema com a fila ou o menu aberto fecha o overlay e sai do cinema no mesmo toque (App.tsx:66): Commit 67a4acf. O App ignora o Esc quando ele já chegou consumido (defaultPrevented) ou quando há alguma camada aberta (hasEscLayer), seja qual for a ordem dos listeners no window. Dois casos novos no App.cinema.test: camada registrada depois do App e controle focado que consome o Esc.
- Com Resume on launch desligado, a exclusão de recentes do autoplay deixava de ser restaurada (PlayerBar.tsx:221): Commit 53c6dc0. O snapshot agora é lido sempre e o rememberRecent(snap.recently_played) roda primeiro, inclusive quando a fila salva está vazia. Só fila, posição, shuffle e repeat dependem do toggle. O PlayerBar.resume.test foi atualizado para esse contrato, com três casos.
- Library fazia duas varreduras completas extras no Qdrant só para exibir contagens (Library.tsx:24): Commit 99d128c. A Library busca libGetAlbums e libGetArtists uma vez e entrega a mesma lista às abas Albums e Artists (prop list opcional). Abertas direto por /albums ou /artists, as views continuam buscando a própria lista. O teste prova uma chamada por listagem. Os comandos Rust não foram marcados como async; isso ficou de fora.
- Tablist da Library sem role=tab nem aria-selected (Library.tsx:62): Commit c6128ab. Cada botão ganhou role=tab, id, aria-selected e aria-controls, e o conteúdo fica num role=tabpanel rotulado pela aba ativa. O wrapper é um bloco simples, sem mudança visual.
- Regras de :focus-visible duplicadas repetiam o anel com valor fixo (extractor-lab.css:2728 e 2092): Commit 201340e. Removi os dois blocos com 2px solid var(--blue-ring) fixo (.fader__track, .param-row__slider, .st-card, .section__action). Nenhum desses controles zera o outline, então o :where(:focus-visible) global passa a valer para eles. Criei src/styles/focus-ring.test.ts, que lê o CSS real e trava qualquer valor fixo em regra de :focus-visible.
- Foco invisível no slider de volume do Settings (Settings.tsx:435): Commit 201340e. Entrou .slider:focus-visible { outline: var(--focus-outline); outline-offset: 2px }, e o input recebeu aria-label="Volume". Teste de CSS e getByRole('slider', {name:'Volume'}) no Settings.test.
- Botão de mudo com rótulo dinâmico e aria-pressed juntos (PlayerBar.tsx:675): Commit 65b4563. Escolhi o padrão de toggle do WAI-ARIA: aria-label fixo "Mute" com aria-pressed refletindo o estado. O title continua dizendo a ação (Mute/Unmute). O PlayerBar.controls.test foi ajustado para exigir essa combinação.
- Card de station com role=button e o botão de apagar aninhado (Stations.tsx:211): Commit 4d9568a. O .st-card perdeu role, tabIndex, aria-label e os handlers. O nome da station virou o <button class="st-card__name st-card__play">, irmão do botão de apagar. O ::after desse botão (inset -1px, border-radius do card) cobre o card inteiro, então o clique em qualquer ponto continua tocando, e leva o anel de foco no contorno do card. O apagar ganhou z-index 1 para ficar acima dessa área. Testes: nenhum controle aninhado em outro, a descrição fica fora do nome do botão e o apagar não dispara o play.
- Cards de playlist role=button sem teclado (Playlists.tsx:173): Commit 7ab2ce3. Os cards fixados e os da lista geral respondem a Enter e Espaço, com preventDefault, como já fazia o np-mini. Os testes cobrem Enter, Espaço sem rolar a página e o card fixado.
- Mobile: com o NP aberto, a tela e o dock atrás continuavam acessíveis (MobileApp.tsx:161): Commit c3524c3. O .shell recebe inert={isNpOpen()} e aria-hidden. Criei src/mobile/MobileApp.test.tsx, que cobre o NP aberto e o fechado.
- Mobile: a sheet não devolvia o foco ao fechar (Sheet.tsx:266): Commit 265ce99. A sheet guarda document.activeElement ao abrir e, ao fechar, devolve o foco a esse elemento se ele ainda estiver no DOM, fora de subárvore [inert], e se o foco ainda estiver dentro da sheet. Dois testes novos no Sheet.test.
- No modo cinema a chrome escondida só com opacity deixava paradas de Tab invisíveis (extractor-lab.css:199): Commit 7c819d0. Junto com o data-cinema, o App aplica toggleAttribute('inert') em :scope > .titlebar, .sidebar e .playerbar. O CSS não mudou. Teste no App.cinema.test com stubs da chrome.
- Lista do Crate focável sem semântica de seleção (Crate.tsx:1262): Commit 5e4670b. A .crate-list aponta a linha selecionada com aria-activedescendant="crate-row-<índice>". Cada .crate-row ganhou id, role=group (não esconde os botões da linha) e aria-labelledby apontando para o título e o artista. Não usei listbox/option porque as linhas têm botões dentro. Teste no Crate.test.

### Segunda passada (pendências do crítico)

**Rodada 1**
- REGRESSÃO pl-card (Playlists.tsx): 35d75fc: mesmo padrão do card de station (4d9568a). O nome virou <button class="pl-card__title pl-card__open"> de abrir, irmão do botão de fixar, e o ::after dele cobre o card inteiro e leva o anel de foco. O card deixou de ser role=button, sem tabIndex e sem openOnKey. O fixar saiu da capa para o nível do card: a capa ganha transform no hover, vira contexto de empilhamento e deixaria o fixar por baixo do ::after. No hover o fixar acompanha o translateY(-2px) da capa. Ordem de Tab: primeiro o nome, depois o fixar.
- cfg-15 (metade que falta): 56455e9: os 8 knobs do fundo (ganhos, smoothing, speed, beat-sync/mode/depth) não são mais escritos no :root, porque nenhum CSS os lê. O SpectrumCanvas lê do store a cada frame via bgKnobs(tweaks()) (função pura exportada); o WebGL já lia o store. As demais vars (fontes, glow, vidro, ink, accent), o zoom e os data attributes só são escritos quando o valor inline muda (writeVar/writeData comparam com o inline, não com cache próprio, porque o applyTheme escreve as mesmas vars). O ink só é re-resolvido quando uma entrada muda (inkKey): sem tema, resolver chamava getComputedStyle a cada quadro. rustify:tweaks-applied só é disparado quando as vars do vidro mudaram. O NowPlaying mede lendo o inline do <html>: as vars do vidro só existem inline, e o --bg-canvas sem tema é lido uma vez por tema e invalidado em rustify:theme-applied. Comentários de SpectrumCanvas, gl/signal, beatPll e Tweaks deixaram de citar as vars removidas. data-bg-engine e data-eq-spectrum foram mantidos, só com escrita diferencial (np-17 fica como está).
- ds-2 / nav (aria-current na Sidebar): 0f78d1a: os links primários, de coleções, Now Playing e do rodapé expõem aria-current="page" quando ativos, junto com a classe .active.
- cfg-9 (gatilho do Tweaks): 95b018d: o botão Tweaks ganha classList active enquanto tweaksOpen(), coerente com o aria-expanded que já existia.
- ds-1 restante (CSS): 0a66004, só em extractor-lab.css. .card__play fica visível em .card:focus-within e em :focus-visible, sem mexer no clique do card. .tracks__row:focus-visible > div desenha o anel nas células por dentro, com box-shadow inset na cor --blue-ring (topo e base em todas, lateral na primeira e na última), porque display:contents não tem caixa. .coll-search:focus-within ganha border --fg-7 e var(--ring-focus). As regras novas foram conferidas no bundle do vite build. Não verificado no app real: se o WebKitGTK dá foco a um elemento display:contents com tabIndex.
- ds-2 restante (aria-label dos plays): 98ec4b1: aria-label "Tocar <álbum>" nos .card__play de Home, Albums e Artist e no play do cabeçalho do Album (que ganhou também type=button).
- shell-8 (erro da busca local): 27a2330: o catch de libSearch devolve failed:true (e registra no console). A lista mostra <div class="palette__error" role="status">Busca local falhou</div> em --rose-fg, sem estado de carregamento novo; o "Procurar na rede" continua disponível.
- lib-26 (Playlists): 24d1d85: "Sort by name" passou de <a> sem href para <button type="button" class="section__action">, e o visual continua o mesmo pelo reset global de button. O card fixado mostra a contagem uma vez só ("Folder · N tracks" com fmtTracks); o .pl-card__meta e o CSS dele, que ficou morto, foram removidos.
- shell-13 (dicas de atalho): e79b706: helper único modCombo(key, platform = navigator.platform) e isMacPlatform em src/lib/keyboard.ts, que dão "⌘K" no Mac e "Ctrl+K" fora dele. Aplicado ao kbd do Search na Sidebar, ao estado vazio do Crate e à dica da faixa e ao rodapé da CommandPalette (Ctrl+↵). Só texto, nenhum atalho novo.
- mobile-5 (contraste do histórico da fila): 818ac28: opacidade do bloco "Já tocadas" subiu de .62 para .85 em src/mobile/screens/Queue.tsx. Contra o --s-base #0c0c0c, --t4 vai a 3,06:1 e --t3 a 3,87:1. .84 é o mínimo exato (3,02:1); .85 dá folga para o arredondamento de 8 bits. Continua esmaecido.
- revisão confirmada: Botão de tocar do card fica visível e "grudado" depois de clicado com o mouse (.card:focus-within)
- revisão confirmada: Anel de foco da linha de faixa nunca aparece: no WebKitGTK um elemento com display:contents não recebe foco
- revisão confirmada: Aviso 'Busca local falhou' com role=status é inserido junto com o texto e não é anunciado
- revisão confirmada: .card:focus-within deixa o play do card visível depois de um clique de mouse no WebKitGTK
- fechado: Botão de tocar do card fica visível e "grudado" depois de clicado com o mouse (.card:focus-within) — achados 1 e 4, mesmo defeito: Commit 1152932. Removido o seletor `.card:focus-within .card__play` de src/styles/extractor-lab.css. Fica só `.card__play:focus-visible { opacity: 1; transform: none; }`, que já cobre o Tab, porque o card não tem outro alvo de foco. No WebKitGTK o clique de mouse também foca o <button> e deixava o play preso no card.
- fechado: Anel de foco da linha de faixa nunca aparece: no WebKitGTK um elemento com display:contents não recebe foco: Commit b240d32. Tirado o `display:contents` inline de src/components/TrackRowTable.tsx. `.tracks__row` passou a ser `display:grid; grid-column:1 / -1; grid-template-columns:subgrid`. Os seletores `.tracks > div` (normal e compacto) viraram `.tracks > div:not(.tracks__row)`, para a linha não receber padding nem borda das células. O anel voltou a ser o outline global (`--focus-outline`) na própria linha, com `outline-offset:-2px`, e saiu o contorno por box-shadow nas células. Sondei o app real na cmr-auto (WebKitGTK) pela ponte MCP: `CSS.supports(subgrid)` é true. A linha com subgrid vira activeElement depois de focus() e a com display:contents não. As células da linha com subgrid caem nas mesmas colunas (left/width) dos cabeçalhos. A sonda foi removida. O que ficou sem verificação visual: a captura de tela da ponte não funciona no Linux, então não vi em pixel o outline da linha pintado por cima do fundo das células; isso se apoia na ordem de pintura do WebKit (o outline do próprio elemento é pintado depois dos filhos). Um efeito colateral direto de a linha ficar focável também foi corrigido: o onKeyDown agora chama preventDefault em Enter e Espaço (antes o Espaço tocava a faixa e também rolava a view).
- fechado: Aviso 'Busca local falhou' com role=status é inserido junto com o texto e não é anunciado: Commit fcdbd5a. Em src/components/CommandPalette.tsx, o `<div class="palette__error" role="status">` fica sempre montado, e só o conteúdo alterna entre "Busca local falhou" e vazio. No CSS entrou `.palette__error:empty { padding: 0; }`. Não usei o `display:none` sugerido porque ele tiraria a região da árvore de acessibilidade, e a falha voltaria a entrar como região nova, que o leitor de tela não anuncia.

**Rodada 2**
- src/components/TrackRowList.tsx:58 — Espaço sem preventDefault na linha focável: onKeyDown agora chama e.preventDefault() antes de props.onClick() no Enter/Espaço, igual ao TrackRowTable.tsx:45 (com o mesmo comentário). O Espaço deixa de rolar o contêiner da view em Home, History, Queue e na gaveta da fila (.row e .qrow). Commit 8ac6b14.
- revisão confirmada: Handler de teclado da linha dispara play em cada auto-repeat de Enter/Espaço, registrando skip imediato e inflando play_count da faixa escolhida
- fechado: Handler de teclado da linha dispara play em cada auto-repeat de Enter/Espaço (src/components/TrackRowList.tsx:60 e src/components/TrackRowTable.tsx:45): Nos dois componentes, o keydown de Enter/Espaço mantém o e.preventDefault() incondicional, para que o Espaço repetido também não role a view, e agora só chama props.onClick() quando !e.repeat. Segurar a tecla toca a faixa uma vez só: não há mais record_play repetido (play_count inflado) nem player_play repetido (track_skipped perto de 0 s da própria faixa escolhida).
