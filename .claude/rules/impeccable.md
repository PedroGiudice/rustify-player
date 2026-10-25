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

- Pré-requisito: app aberto na cmr-auto. O script acha a porta da ponte (9223 ou 9224) e
  abre o túnel. Nada aparece na tela do CEO; o detector roda sem overlay.
- A captura vem do comando `debug_capture_webview` (`src-tauri/src/capture.rs`): pixels
  do próprio WebKit, com capas, fonte e fundo animado. As outras três vias falham: o
  screenshot da ponte não existe no Linux, a reconstrução do DOM perde capa e fonte, e o
  print do sistema pega a janela que estiver na frente.
- Na `critique`/`audit`, a avaliação B é `app_eval.sh detect` + `impeccable detect` no
  código; a A olha as capturas. A janela é uma só: as duas avaliações se revezam e
  devolvem a rota em que o app estava.

## Leitura dos achados

- O detector mede tamanho em px de CSS, antes do `zoom` que o Tweaks aplica no `<html>`
  (o JSON traz o zoom): 10,5 px com zoom 1,1 aparecem com ~11,5 px.
- Ponto cego: contraste de texto sobre capa ou sobre o fundo animado. O detector só mede
  texto sobre fundo sólido. Esse caso se mede nos pixels da captura, no pior ponto.
- S24: o WebView do Android tem CDP, então `impeccable detect --cdp` via `adb forward`
  deve funcionar. Ainda não testado.
