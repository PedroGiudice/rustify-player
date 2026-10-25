# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Duas superfícies, mesma linguagem web: o app desktop (Tauri 2 sobre WebKitGTK, Linux) e o app
Android do S24 (Tauri sobre o WebView do sistema, UI Solid própria em `src/mobile/`). Nenhuma
das duas segue linguagem de design nativa do sistema operacional.

## Users

Um usuário só: o dono do acervo (o CEO do projeto). Escuta no desktop (cmr-auto, monitor
externo 1920x1080 com zoom 1,15 no app) e no celular (Galaxy S24). Não há outros públicos;
nenhuma decisão de produto se justifica por "usuário hipotético".

## Product Purpose

Tocar a coleção própria de música em lossless de verdade (FLAC 16/44,1 ou melhor, medido pelo
conteúdo espectral, não pela etiqueta), com um motor de recomendação local que aprende com a
escuta (autoplay, rádio, stations), e trazer música nova para o acervo sem sair do app (aba
Crate: Soulseek, SoundCloud, Tidal). Sucesso = o dono passa o dia ouvindo pelo Rustify, pula
pouco, curte e volta a ouvir; a régua do autoplay mede isso diariamente.

## Positioning

Player pessoal de um dono só, sobre um acervo que ele mesmo cura e audita. A música (capa, som,
letra) é o assunto; a interface é a moldura escura e quieta em volta. O fundo animado reativo ao
áudio é a assinatura visual do app.

## Operating Context

- Desktop: o app fica aberto o dia todo, muitas vezes tocando em segundo plano; telas de uso
  frequente são Now Playing, biblioteca (Álbuns, Artistas, Faixas, Playlists), Stations, fila,
  Crate e o painel Tweaks.
- Celular: escuta em movimento, sincroniza plays e likes com o desktop pela tailnet.
- Playlist = pasta de primeiro nível em `~/Music`; temas YAML vivem na máquina do usuário.
- O dono avalia o produto com os olhos e os ouvidos no app instalado; aceite visual é o olho
  dele, e direção em aberto vira protótipo antes de entrar no app.

## Capabilities and Constraints

- A reprodução é sagrada: nada interrompe nem atrasa o som; álbum toca gapless.
- Desempenho no WebKitGTK: nunca animar custom property no `:root` (restyle da árvore inteira
  por quadro); critério do fundo animado é 60 fps medidos no app a 1857x1048.
- Sem CDN nem host externo na CSP (fontes e ícones embarcados).
- A interface não roda num navegador comum: depende do IPC do Tauri (`window.__TAURI__`).
- Personalização visual passa pelo painel Tweaks e pelos temas YAML; a cor da capa
  (adaptiveInk/adaptiveAccent) governa ink e acento.
- Idioma da interface: PT-BR em todo texto; os nomes das áreas do app (Crate, Tweaks, Signal,
  Stations) ficam como nomes próprios. Os textos ainda em inglês são dívida, migrada à parte.

## Brand Commitments

- Nome: Rustify Player.
- Desktop usa Instrument Sans (pesos 400–700, sem eixo de largura); S24 usa Inter + Fraunces,
  decisão do handoff mobile. Não entra terceira família.
- Ícones Lucide; única exceção é o coração cheio do Phosphor.
- O canvas do fundo animado é preto puro (decisão de 20/09/2026).

## Evidence on Hand

- Pesquisa de design de produto do player: `docs/design-refs/2026-10-11-pesquisa-design-produto-player.md`.
- Handoffs e labs de fundo: `docs/design-refs/` (fundo persistente, fundo-lab-v2, fundo-fizzle).
- Specs de produto: `docs/superpowers/specs/`; contexto e decisões: `docs/contexto/`.
- Régua do autoplay: `docs/metrics/regua-latest.md`.

## Product Principles

1. Tocar primeiro, metadado depois.
2. Uma ousadia por tela; o resto fica neutro e serve à música.
3. O algoritmo serve ao dono: explica a escolha e aceita negativo com escopo.
4. Recurso vale por frequência de uso vezes fricção removida; o que não se usa sai.
5. Redesign nunca faz menos que a versão anterior.

## Accessibility & Inclusion

WCAG 2.x como piso: 4,5:1 para texto, 3:1 para texto grande e controles, medido no pior ponto
do fundo real (capa e fundo animado). Movimento contínuo precisa de versão calma sob
`prefers-reduced-motion`; nunca mais de 3 flashes por segundo.
