# Pesquisa: design gráfico, interface e produto de player (11/10/2026)

Base de evidência do bloco "Design gráfico e interface" e "Produto: o player"
do output style `.claude/output-styles/rustify-cto.md`. Três pesquisas web
paralelas (UI de players, ofício gráfico de UI, produto de players), cada
afirmação com fonte. O estilo resume; este documento guarda as fontes e os
números.

Legenda de origem: **[oficial]** diretriz de design system, norma ou
documentação de fabricante; **[produto]** post do fabricante sem força de
diretriz; **[dado]** pesquisa ou medição publicada; **[autor]** livro ou
designer reconhecido; **[reviewer]** crítica ou imprensa; **[eng. reversa]**
análise de terceiros não confirmada pelo fabricante; **[comunidade]** blog de
baixa autoridade.

## Leitura contra o Rustify (verificado no código em 11/10)

- Desktop usa Instrument Sans com **só o eixo de peso 400–700** no subset
  embarcado (`src/assets/fonts/instrument-sans-*.woff2`, conferido com
  fontTools); o eixo de largura 75–100 da fonte original não veio. `tnum`
  existe na fonte.
- Mobile usa **Inter + Fraunces**, decisão do handoff
  (`docs/design-refs/design_handoff_mobile/`, porte em
  `src/mobile/styles/tokens.css`), com superfícies por tom (`--s-lowest` …
  `--s-highest`). Inter aparece na lista "evite" da Anthropic, mas é decisão
  de handoff: baseline.
- Desktop não tem tokens de espaçamento no `:root` do `extractor-lab.css`;
  tem raio (`--radius-*`), sombra (`--shadow-*`, rgba 0,04–0,06), vidro e
  movimento (`--dur-fast/base/med` = 120/150/180 ms, `--ease-out` =
  `cubic-bezier(0.4,0,0.2,1)`), tematizáveis pelo YAML.
- Ícones: coleção Lucide inteira + um único Phosphor (`ph:heart-fill`).
- `prefers-reduced-motion` só cobre dois detalhes no CSS e o `StationViz`; o
  fundo animado não o lê. O fundo para com `Speed = 0` no Tweaks.
- Canvas do fundo WebGL é preto puro por decisão do CEO (20/09). As fontes
  divergem sobre preto puro (abaixo); a decisão do projeto prevalece.

## 1. Diretrizes oficiais para player e mídia

- **[oficial] Apple, controles de áudio**: "Avoid repurposing audio
  controls"; controle próprio só para comandos que o sistema não oferece; usar
  o volume do sistema.
  https://developer.apple.com/design/human-interface-guidelines/playing-audio
- **[oficial] Apple CarPlay**: "Display the Now Playing screen when audio is
  ready to play. Don't delay playback until descriptive information completes
  loading."
  https://developer.apple.com/design/human-interface-guidelines/carplay
- **[oficial] Apple, carregamento**: "Show something as soon as possible";
  indicador determinado quando a duração é conhecida.
  https://developer.apple.com/design/human-interface-guidelines/loading
- **[oficial] Apple, movimento**: "Add motion purposefully, supporting the
  experience without overshadowing it"; "Make motion optional".
  https://developer.apple.com/design/human-interface-guidelines/motion
- **[oficial] Android, controles de mídia**: slot 1 é play, pause ou spinner
  no buffering; slots 2 e 3, anterior e próxima; compacto mostra 3 slots; sem
  duração, a barra não mostra progresso.
  https://developer.android.com/media/implement/surfaces/mobile
- **[oficial] Media3 1.11**: slots `topControls`, `centerControls`,
  `bottomControls`, `errorOverlay`; `MiniController` com Dynamic Color.
  https://android-developers.googleblog.com/2026/08/media3-1-11-whats-new.html
- **[oficial, legado] Material 1, scrims**: 20–40% para scrim escuro, só na
  área do texto. https://m1.material.io/style/imagery.html

## 2. Cor derivada da capa

- **[oficial] Material 3, cor por conteúdo**: quantiza a imagem, escolhe a
  cor-fonte, distribui tons pelos papéis; cita app de música.
  https://m3.material.io/styles/color/dynamic/content-based-source
- **[oficial, código] Score**: descarta chroma < 5 e matizes com < 1% da
  imagem; nota = 70% proporção + distância ao chroma-alvo 48; separa matizes
  de 90° até 15°; fallback fixo.
  https://github.com/material-foundation/material-color-utilities/blob/main/typescript/score/score.ts
- **[oficial, código] Cores "detestadas"**: matiz 90–111, chroma > 16, tom <
  65 (amarelo-esverdeado escuro); corrige subindo o tom para 70.
  https://github.com/material-foundation/material-color-utilities/blob/main/typescript/dislike/dislike_analyzer.ts
- **[oficial] HCT**: diferença de tom 40 garante ≥ 3:1; 50 garante ≥ 4,5:1.
  https://github.com/material-foundation/material-color-utilities/blob/main/typescript/hct/hct.ts
- **[oficial] Variantes de esquema**: tonal spot (padrão, pouca saturação),
  fidelity (preserva saturação); três níveis de contraste.
  https://m3.material.io/styles/color/choosing-a-scheme
- **[oficial] Palette API**: cada swatch dá cor de título e de corpo; título
  exige menos contraste.
  https://developer.android.com/develop/ui/views/graphics/palette-colors
- **[oficial] MusicKit Artwork**: `backgroundColor` + quatro cores de texto
  pré-calculadas, todas anuláveis (exige fallback).
  https://developer.apple.com/documentation/musickit/artwork
- **[eng. reversa] Spotify**: `colorRaw`/`colorDark`/`colorLight` com flag
  `isFallback`. https://spicetify.app/docs/development/api-wrapper/methods/graphql
- **[eng. reversa] Fundo do Apple Music (web)**: 4 cópias da capa (25–125%),
  supersaturação, torção, blur Kawase; guiado pelo tempo, não pelo áudio.
  https://www.aadishv.dev/music
- **[produto] Plexamp UltraBlur**: capas têm texto e bordas, blur simples
  falha; extrai cores-chave e renderiza "como vidro fumê"; as mesmas cores
  dão opacidade das camadas e paleta dos visualizadores.
  https://medium.com/plexlabs/plexamp-v3-9af3b10063b4 ·
  https://medium.com/plexlabs/introducing-plexamp-9493a658847a

## 3. Players de referência

- **Apple Music [produto]**: letras "dance to the rhythm of the vocals";
  dueto em lados opostos; vocais de fundo separados; ajuste "Animated Art".
  https://www.apple.com/newsroom/2022/12/apple-introduces-apple-music-sing/
- **Plexamp**: 11 visualizadores com cor da capa [produto]; seek sobre forma
  de onda de loudness EBU R128 [comunidade]
  https://forums.plex.tv/t/plexamp-not-showing-waveform-in-seek-bar-even-though-sonic-analysis-is-enabled-and-working/829320
- **Roon [produto]**: inspiração em museu ("airy, neutral environment") e
  revistas de música ("bold typography"); Focus por intérprete, produtor,
  selo. https://blog.roonlabs.net/introducing-roon-1-8/ · tipos (Grifo, Noto
  Sans, Lato) [reviewer] https://fontsinuse.com/uses/38585/roon-music-player-redesign
- **Marvis Pro [reviewer]**: 30 seções configuráveis; crítica: "very plain…
  only color coming from music artwork"; paisagem espremida em vez de
  reorganizada.
  https://www.macstories.net/reviews/marvis-review-the-ultra-customizable-apple-music-client/ ·
  https://barrowclift.me/articles/fourth-annual-ios-music-player-showcase/12
- **Doppler [reviewer]**: álbum e artista no centro; cor da tela segue a capa
  sobre fundo "not-quite-black".
  https://barrowclift.me/articles/fourth-annual-ios-music-player-showcase/9
- **foobar2000**: painéis e divisores, agrupamento próprio de playlists.
  https://wiki.hydrogenaudio.org/index.php?title=Foobar2000%3AComponents%2FColumns_UI_%28foo_ui_columns%29
- **Winamp**: skins como "iconic moment in internet art history".
  https://jordaneldredge.com/winamp-skin-musuem/
- **Swinsian [produto]**: grade de capas, navegador por colunas, inspetor;
  rápido com bibliotecas enormes. https://swinsian.com/
- **Sonos [reviewer], contraexemplo**: o redesign de 2024 tirou edição de
  fila, busca local, timer e acessibilidade.
  https://rogerwong.me/2025/02/when-the-music-stopped-inside-the-sonos-app-disaster
- **Tidal [imprensa]**: redesign 2026 perdeu o indicador "Playing from" e
  gerou reclamação.
  https://piunikaweb.com/2026/05/06/tidal-ios-music-player-redesign-rolling-out/
- **Poweramp [imprensa]**: seek em onda; deslizar a capa troca de faixa;
  tocar nela abre a fila.
  https://www.androidpolice.com/2018/08/13/poweramp-v3-beta-shows-off-complete-redesign-classic-music-player/

## 4. Padrões de interação

- **Fila [oficial]**: Apple "Playing Next" com AutoPlay, arrastar para
  reordenar, deslizar para remover https://support.apple.com/en-us/109336 ;
  Spotify Autoplay desligável https://support.spotify.com/us/article/autoplay/
- **Biblioteca grande [dado, NN/g]**: lista mostra mais itens por tela; grade
  de imagem só onde a diferença visual importa.
  https://www.nngroup.com/articles/image-vs-list-mobile-navigation/
- **Atalhos [oficial]**: Espaço toca/pausa; setas trocam de faixa.
  https://support.apple.com/guide/music/keyboard-shortcuts-mus1019/mac
- **Letras [eng. reversa]**: linha ativa maior, passadas atenuadas com blur,
  mola, revelação palavra a palavra.
  https://dev.to/vimu_kale_4b5058f002ff8b1/how-apple-music-maps-audio-to-lyrics-the-engineering-behind-real-time-lyric-sync-4fin ·
  implementação aberta (60 fps exige CPU ≥ 3 GHz)
  https://github.com/Steve-xmh/applemusic-like-lyrics
- Estados vazio e erro: não há diretriz específica de player além do
  `errorOverlay` do Media3 e do HIG de carregamento.

## 5. Visualizadores e fundos

- **[oficial] MilkDrop**: bass/mid/treb com "1=normal" (relativos à média da
  música); `_att` amortecidos no tempo; "Keep presets fast".
  https://milkdrop.org/resources/preset-authoring
- **[doc] MilkDrop 2**: fusão entre presets de ~2,7 s; cortes secos
  desligados por padrão.
  https://github.com/jecassis/foo_vis_milk2/wiki/MilkDrop-2-Visualisation
- **[oficial] Apple, acessibilidade**: com Reduce Motion, reduzir animação
  automática e repetitiva; não animar blur; respeitar "Dim Flashing Lights".
  https://developer.apple.com/design/human-interface-guidelines/accessibility

## 6. Acessibilidade e legibilidade

- **[oficial] WCAG 1.4.3**: 4,5:1 texto, 3:1 texto grande; falha F83 = texto
  sobre imagem sem contraste (medir sobre o fundo real).
  https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- **[oficial] WCAG 1.4.11**: 3:1 para componentes (seek, thumb, foco); em
  fundo complexo, mede-se o ponto de menor contraste.
  https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- **[oficial] WCAG 2.2.2 (nível A)**: movimento automático > 5 s ao lado de
  outro conteúdo precisa de pausar, parar ou esconder.
  https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
- **[oficial] WCAG 2.3.1**: no máximo 3 flashes por segundo.
  https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html
- **[autor] APCA** (não normativo; saiu do rascunho do WCAG 3 em 07/2023):
  Lc 90 preferido para corpo, 75 mínimo, 60 outros textos, 45 títulos, 30
  placeholder, 15 não-texto; WCAG 2 superestima contraste de cores escuras.
  https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html ·
  status: https://adrianroselli.com/2026/04/wcag3-contrast-as-of-april-2026.html
- **[oficial] prefers-reduced-motion**: GNOME "Reduced animation", Android
  "Remove animations".
  https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
  · WebKitGTK 2.54 segue o ajuste dedicado do GNOME 50
  https://webkitgtk.org/2026/09/16/webkitgtk-2.54-highlights.html (não se
  achou qual ajuste o 2.52 da cmr-auto segue).

## 7. Ofício gráfico de interface

### Hierarquia, espaço, grid

- **[autor] Refactoring UI**: ênfase por desênfase; hierarquia por cor e peso
  antes de tamanho; comece com espaço demais; sistema fechado de espaçamento;
  "rótulos são o último recurso".
  https://medium.com/refactoring-ui/7-practical-tips-for-cheating-at-design-40c736799886 ·
  https://refactoringui.com/previews/labels-are-a-last-resort
- **[oficial, NN/g]** no máximo 3 tamanhos e 3 variações de contraste; teste
  do olho semicerrado. https://www.nngroup.com/articles/visual-hierarchy-ux-definition/
  · proximidade agrupa https://www.nngroup.com/articles/gestalt-proximity/
- **Conflito: escala modular** — razão fixa (Tim Brown, Every Layout 1,5)
  versus valores escolhidos à mão para UI (Refactoring UI).
  https://alistapart.com/article/more-meaningful-typography/ ·
  https://every-layout.dev/rudiments/modular-scale/
- **[autor] Medida de linha**: 45–75 caracteres, 66 ideal (Bringhurst)
  http://webtypography.net/2.1.2 ; 60ch (Every Layout).

### Tipografia

- **Instrument Sans** (Rodrigo Fuenzalida, direção Jordan Egstad): variável,
  peso 400–700, largura 75–100, itálico, ss01–ss12, algarismos tabulares, OFL.
  https://github.com/Instrument/instrument-sans
- **[oficial] Apple**: evite pesos leves; macOS 13 pt padrão, 10 pt mínimo;
  minimize famílias.
  https://developer.apple.com/design/human-interface-guidelines/typography
- **[autor] Butterick**: corpo 15–25 px na tela, entrelinha 120–145%, caixa-alta
  com +5–12% de espaçamento. https://practicaltypography.com/summary-of-key-rules.html
- **[autor]** entrelinha inversa ao tamanho (~1 em título grande, 1,5 em
  texto). https://refactoringui.com/previews/line-height-is-proportional
- **[oficial] Apple WWDC20**: tracking definido por tamanho; texto menor pede
  mais espaço. https://developer.apple.com/videos/play/wwdc2020/10175/
- **[oficial] Escala M3** (tamanho/entrelinha, tracking px): bodyLarge 16/24
  +0,5; bodyMedium 14/20 +0,25; labelLarge 14/20 peso 500 +0,1; titleLarge
  22/28 0; displayLarge 57/64 −0,25.
  https://api.flutter.dev/flutter/material/TextTheme-class.html
- **[oficial] MDN**: `font-variant-numeric: tabular-nums` alinha algarismos.
  https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant-numeric

### Cor em UI escura

- **[autor] OKLCH** em vez de HSL (luminosidade do HSL varia por matiz).
  https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl · Oklab
  corrige o azul que puxa para roxo https://bottosson.github.io/posts/oklab/
- **[autor] Stripe**: escala em Lab onde 5 níveis de distância garantem 4,5:1
  e 4 níveis garantem 3:1. https://stripe.com/blog/accessible-color-systems
- **[oficial] M3 escuro**: surface tom 6; containers 4/10/12/17/22; primary
  tom 80, on-primary 20; elevação por tom, sem overlay.
  https://github.com/material-components/material-components-android/blob/master/docs/theming/Color.md
- **[oficial] Apple dark mode**: fundos base recuam, elevated avançam; 4,5:1
  mínimo, 7:1 recomendado; mídia imersiva pode ser só escura.
  https://developer.apple.com/design/human-interface-guidelines/dark-mode
- **Conflito: preto puro** — Material 2 recomenda #121212 (branco sobre preto
  "sangra") https://codelabs.developers.google.com/codelabs/design-material-darktheme
  ; Refactoring UI acha preto real artificial; o iOS usa #000 no escuro
  [comunidade]; a skill da Anthropic lista "quase-preto tingido" como sinal de
  UI gerada. Sem consenso; o projeto decidiu preto puro no canvas do fundo.
- **[autor] Paleta**: 8–10 cinzas e 5–10 tons por cor definidos de antemão;
  acento com parcimônia. https://refactoringui.com/previews/building-your-color-palette
- Ferramenta: Harmonizer (OKLCH + APCA) https://github.com/evilmartians/harmonizer

### Movimento

- **[oficial] M3**: short 50–200 ms, medium 250–400, long 450–600; standard
  `(0.2,0,0,1)`, entrada `(0.05,0.7,0.1,1)`, saída `(0.3,0,0.8,0.15)`;
  duração cresce com área/percurso.
  https://github.com/material-components/material-components-android/blob/master/docs/theming/Motion.md
- **[oficial] Material 1**: desktop 150–200 ms; acima de 400 ms parece lento.
  https://m1.material.io/motion/duration-easing.html
- **[oficial] Carbon**: 70/110/150/240/400/700 ms; productive
  `(0.2,0,0.38,0.9)`, expressive `(0.4,0.14,0.3,1)`.
  https://carbondesignsystem.com/elements/motion/overview/
- **[NN/g]** 100–500 ms; ~100 ms feedback; 500 ms arrasta; ease-out na
  entrada. https://www.nngroup.com/articles/animation-duration/
- **[oficial] Apple**: evitar animação em interação frequente; animação
  cancelável. (HIG motion, acima)
- **[oficial] Coreografia M3**: container transform, shared axis, fade
  through. https://m3.material.io/styles/motion/transitions/transition-patterns
- **[autor] Val Head**: movimento reduzido não é movimento removido.
  https://valhead.com/2017/06/23/reduced-motion-query/

### Ícones

- **[oficial] Lucide**: grade 24×24, traço 2 px centrado, terminais
  arredondados, ≥ 2 px entre elementos.
  https://lucide.dev/contribute/icon-design-guide
- **[oficial] Phosphor**: 6 pesos, desenho em 16×16.
  https://github.com/phosphor-icons/homepage
- **[autor]** não ampliar ícone desenhado para tamanho pequeno.
- Casar traço de ícone com peso do texto: sem fonte oficial (heurística de
  comunidade https://www.ui-skills.com/playbook/match-icon-stroke-weight).

### UI genérica de IA

- **[oficial] Anthropic**: sem direção, o modelo cai no centro da
  distribuição ("convergência distribucional").
  https://claude.com/blog/improving-frontend-design-through-skills — o post
  pede pesos extremos (100/200 contra 800/900), inviável na Instrument Sans
  400–700 e contrário à Apple.
- **[oficial] Skill `frontend-design`**: ancorar a estética no assunto do
  produto; plano antes do código (4–6 cores nomeadas, papéis tipográficos,
  layout em esboço); "gaste a ousadia em um lugar só"; criticar por
  screenshot; "tire um acessório antes de sair". Sinais de UI gerada:
  quase-preto com um acento ácido, kit de cards SaaS (mesmo raio e sombra em
  tudo), sobretítulo em caixa-alta espaçada, "A · B · C", mono em dado
  pequeno, "→" em botão, palavra destacada no título. Briefing que fixa
  direção vence a lista.
  https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md
- **[comunidade]** gradiente roxo vem do indigo-500 padrão do Tailwind.
  https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website

### Crítica

- **[NN/g]** escopo e objetivo antes da crítica; perguntas ligadas ao
  objetivo. https://www.nngroup.com/articles/design-critiques/
- **[autor] Connor e Irizarry**: qual o objetivo, que elementos se relacionam
  com ele, são eficazes, por quê. https://www.goodreads.com/en/book/show/32049560
- **[NN/g] crítica na era da IA**: julgar, avaliar, iterar com critério
  objetivo. https://www.nngroup.com/articles/ai-era-critique/

## 8. Produto de player

### O que faz um player de acervo próprio ser amado

- **Plexamp**: loudness, gapless real, Sweet Fades, offline [produto]
  https://apps.apple.com/us/app/plexamp/id1500797510 ; relançamento 09/2026
  removeu o Sonic Sage por não ser "consistente ou útil o bastante" e priorizou
  offline e app desktop em Tauri [secundária]
  https://thedesk.net/2026/09/plexamp-new-app-desktop-windows-mac-linux/
- **Roon [produto]**: metadados e créditos cruzados; descoberta como
  "redescobrir favoritos"; banir artista/álbum/faixa/compositor.
  https://roon.app/en/ · https://blog.roonlabs.net/how-to-customize-music-discovery/
- **foobar2000 [produto]**: sem telemetria, gapless, ReplayGain, atalhos.
  https://www.foobar2000.org/
- **Doppler [produto]**: "No converting. No configuration. Just press play."
  https://brushedtype.co/doppler/

### Modos de escuta

- **[dado] Freeman et al., CHI 2023**: três modos — fundo, curadoria,
  descoberta. https://doi.org/10.1145/3544548.3581492
- **[dado] Spotify**: o sinal de satisfação muda com a intenção.
  https://research.atspotify.com/2021/07/user-intents-and-satisfaction-with-slate-recommendations
- Plexamp Guest DJ insere faixas parecidas sem abandonar o álbum
  [secundária] https://blog.lon.tv/2023/02/02/new-plexamp-features-guest-dj-and-nfc-tags/
- Spotify DJ: um toque muda gênero/humor [produto]
  https://newsroom.spotify.com/2023-02-22/spotify-debuts-a-new-ai-dj-right-in-your-pocket/
- Pandora Modes: o usuário escolhe o "algoritmo" da estação [secundária]
  https://www.engadget.com/2019-03-19-pandora-modes-stations-feature.html
- **[dado] Spotify**: sessão = faixas separadas por < 20 min de inatividade.
  https://research.atspotify.com/contextual-and-sequential-user-embeddings-for-music-recommendation/

### Recomendação

- **[dado]** explicação aumenta confiança e perdão ao erro
  https://arxiv.org/abs/2201.10528 ; BaRT otimiza item e explicação
  https://research.atspotify.com/publications/explore-exploit-explain-personalizing-explainable-recommendations-with-bandits
- **[produto] Deezer Flow Tuner**: liga/desliga gêneros, apaga da fila;
  motivação: evitar "rage-skip".
  https://en.deezercommunity.com/product-updates/introducing-flow-tuner-your-music-your-rules-81502
- **[produto] Pandora**: thumbs down vale só para a estação.
  https://help.pandora.com/s/article/Thumbs-1519949305945?language=en_US
- **[dado] Mei et al., UMAP 2024**: dislike explícito reduz ~60% do treino e
  sobe ~6% de acurácia; negativos demais trazem falsos negativos.
  https://arxiv.org/abs/2406.04488
- **[dado] Garcia-Gathright et al., SIGIR 2018**: skip muda de sentido em
  escuta de fundo; satisfação inequívoca = salvar, abrir artista, ouvir de
  novo; "uma grande recomendação" basta.
  https://research.atspotify.com/2018/07/understanding-and-evaluating-user-satisfaction-with-music-discovery
- **[dado] Anderson et al., WWW 2020**: escuta algorítmica é menos diversa, e
  diversidade se associa a retenção.
  https://research.atspotify.com/2020/12/algorithmic-effects-on-the-diversity-of-consumption-on-spotify
- **[dado] Schedl et al.**: queixa frequente = faixas consecutivas parecidas
  demais. https://arxiv.org/abs/1710.03208
- **[produto] Spotify shuffle 2025**: "The math is right, but the feeling is
  wrong." https://techcrunch.com/2025/11/13/spotify-adds-a-new-less-repetitive-shuffle-plus-audiobook-recaps/

### Métricas

- **[dado] Lamere/Echo Nest**: 24,14% das faixas puladas nos primeiros 5 s,
  48,6% antes do fim; mais skip no mobile (51,1%) que no desktop (40,1%).
  https://musicmachinery.com/2014/05/02/the-skip/
- **[dado] Meggetto et al., CIKM 2021**: quatro tipos de sessão (listener,
  listen-then-skip, skip-then-listen, skipper). https://strathprints.strath.ac.uk/78436/
- **[dado] Donier 2020**: perfil de skip é característica estável da faixa.
  https://arxiv.org/abs/2005.06987
- **[produto] Spotify**: latência clique-ao-som (mediana, p90, p99) e stutter
  por faixa. https://engineering.atspotify.com/2018/08/smoother-streaming-with-bbr

### Engenharia que vira produto

- **[dado] NN/g**: 0,1 s instantâneo, 1 s mantém o fluxo, 10 s limite da
  atenção. https://www.nngroup.com/articles/response-times-3-important-limits/
  · RAIL: input em 100 ms, quadro em 16 ms https://web.dev/articles/rail
- Gapless essencial em álbum conceitual, eletrônico, ao vivo.
  https://wiki.hydrogenaudio.org/index.php?title=Gapless_playback
- **[autor] Ink & Switch, local-first**: "No spinners", "The network is
  optional". https://www.inkandswitch.com/essay/local-first/
- MPRIS https://specifications.freedesktop.org/mpris/latest/ ; MediaSession,
  retomada após reboot
  https://developer.android.com/media/media3/session/background-playback ;
  pausar quando o fone desconecta https://developer.android.com/media/platform/output

### Software para um dono

- **Robin Sloan**: "four daily active users, with zero churn"; sem redesign
  repentino. https://www.robinsloan.com/notes/home-cooked-app/
- **Clay Shirky**: recusar escala, generalidade e completude como virtudes.
  https://gwern.net/doc/technology/2004-03-30-shirky-situatedsoftware.html
- **Adam Waxman**: construir a partir da frustração; aposentar sem remorso;
  cuidado com construir como lazer. https://www.ajwaxman.com/writing/software-for-one
- Heurística de valor: frequência × tempo economizado.
  https://www.explainxkcd.com/wiki/index.php/1205:_Is_It_Worth_the_Time

## Lacunas registradas

- Não há diretriz oficial de Now Playing no Material 3 nem de estados vazio e
  erro específicos de player.
- Sem fonte oficial para casar traço de ícone com peso de texto, nem para
  quando usar mono em UI.
- Preto puro sem consenso entre as fontes.
- Posts da Plex (Medium) e páginas do m3.material.io não renderizaram; o
  conteúdo veio de trechos de busca, confirmado pelo código-fonte quando
  possível.
