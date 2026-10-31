---
paths:
  - "src/**/*.tsx"
  - "src/**/*.css"
  - "PRODUCT.md"
  - "DESIGN.md"
  - ".impeccable/**"
---

# Impeccable neste repo: avaliar no app real

Contexto do Impeccable: `PRODUCT.md` (produto, confirmado pelo CEO em 25/10/2026),
`DESIGN.md` + `.impeccable/design.json` (sistema visual, gerado pelo `document` em 26/10/2026
a partir do `:root`, dos tokens do S24, do tema `really-dark` e de capturas do app real; North
Star, fonte do desktop e doutrina dos controles confirmados pelo CEO) e `.impeccable/config.json`
(gancho do detector ligado; Instrument Sans, Inter e Fraunces ignorados pelo `overused-font` por
decisão do CEO). Mudou token, componente ou regra: regenerar o sidecar junto com o DESIGN.md.

## Tela renderizada = app da cmr-auto pela ponte

O caminho padrão do Impeccable para app desktop (`detect --cdp`) não existe aqui: Tauri
sobre WebKitGTK não expõe CDP, e a interface não abre num navegador comum (precisa do
`window.__TAURI__`). O que funciona, testado em 25/10/2026 na 0.2.96:

```bash
scripts/impeccable/app_eval.sh capture   # PNG real do WebKitGTK em .impeccable/captures/
scripts/impeccable/app_eval.sh detect    # detector do navegador injetado no app, JSON em .impeccable/captures/
scripts/impeccable/app_eval.sh js 'return location.pathname'
```

- **A ponte tem cadeado (29/10/2026).** O app nasce com a ponte desligada e recusa todo
  comando até o CEO ligar Tweaks > Controle remoto > Ponte MCP; `capture`/`detect`/`js`
  falham com "ponte desligada no app; ligue em Tweaks > Controle remoto". Pedir que ele
  ligue (e desligue depois) é parte da autorização; a sessão nunca liga por ele.
- **O app é do CEO.** Cada rodada pela ponte precisa de autorização escrita dele NA
  sessão que vai rodar, valendo só para aquela rodada (um "app aberto, pode testar" não
  autoriza amostrador em laço nem rodadas de horas depois). Sem autorização: nenhuma
  chamada à ponte, nem leitura "passiva". Incidente de 28/10/2026: uma sessão navegou
  telas, abriu o Tweaks e trocou a cena enquanto ele usava o app; ele parou tudo
  ("o app é MEU"). Avisar no chat não substitui a autorização.
- Com autorização, `capture` e `detect` leem a tela em que o app ESTÁ. Navegar, abrir
  painel, trocar cena ou tema muda o que o CEO vê: só se ele pediu isso explicitamente
  naquela rodada, e o app volta ao estado anterior no fim. O script acha a porta da ponte
  (9223 ou 9224) e abre o túnel; o detector roda sem overlay.
- A captura vem do comando `debug_capture_webview` (`src-tauri/src/capture.rs`): pixels
  do próprio WebKit, com capas, fonte e fundo animado. As outras três vias falham: o
  screenshot da ponte não existe no Linux, a reconstrução do DOM perde capa e fonte, e o
  print do sistema pega a janela que estiver na frente.
- Na `critique`/`audit`, a avaliação B é `app_eval.sh detect` + `impeccable detect` no
  código; a A olha as capturas. A janela é uma só: as duas avaliações se revezam, nas
  mesmas condições de autorização acima.
- **Tocar faixa pela ponte grava escuta de verdade.** Faixa que chega ao fim vira
  `track_ended` no `play_events` (familiaridade, sinal positivo do motor) mesmo com o
  volume do app em 0. Pausar antes do fim e listar no relatório o que foi gravado
  (31/10/2026: 3 eventos de teste). O medidor e o espectro leem o monitor do sink, DEPOIS
  do volume: volume 0 = medidor e fundo parados, não é defeito. Para ver a reação sem som,
  emitir `audio-fft` sintético pelo `window.__TAURI__.event.emit` (com os `level_*`).
- O detector roda por `setTimeout` no `app_eval.mjs` (microtarefa estourava o corte de 5 s
  da ponte no Now Playing). O `:focus`/`:focus-within` não casa com a janela sem foco do
  sistema: alça ou botão "invisível ao focar" num teste remoto não é defeito.

## Leitura dos achados

- O detector mede tamanho em px de CSS, antes do `zoom` que o Tweaks aplica no `<html>`
  (o JSON traz o zoom): 10,5 px com zoom 1,1 aparecem com ~11,5 px.
- Ponto cego: contraste de texto sobre capa ou sobre o fundo animado. O detector só mede
  texto sobre fundo sólido. Esse caso se mede nos pixels da captura, no pior ponto.
- S24: o WebView do Android tem CDP, então `impeccable detect --cdp` via `adb forward`
  deve funcionar. Ainda não testado.
