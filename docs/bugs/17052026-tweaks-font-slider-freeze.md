# Bug: slider de font scale no Tweaks trava a UI

**Status:** aberto, não investigado
**Versão:** v0.2.13
**Severidade:** media — bloqueia uso do painel Tweaks
**Reportado em:** 2026-05-17, sessao de polishing pos v0.2.13

## Sintoma

Ao abrir o painel Tweaks (sidebar → Tweaks) e mexer no slider de font scale, o app trava: cliques em outras partes da UI param de responder. Comportamento parece freeze total do frontend (input thread bloqueada).

## Contexto

O controle foi restaurado no commit `5090c4a` (`fix(tweaks): restaura controles density/sidebar/type/glow + corrige fontScale`). O fix aplicado pelo subagente substituiu `html.style.fontSize` por `html.style.zoom` (que afeta tudo no WebKitGTK do Tauri).

Arquivo: `src/js/components/tweaks.js`. Função `applyTweaks` aplica `html.style.zoom = String(state.zoom)` (ou `state.scale` apos a migracao).

## Hipoteses (nao verificadas)

1. **Repaint cascateado por `zoom`**: cada movimento do slider emite `input` event → `setVal` → `applyTweaks` → `renderPanel`. O `renderPanel` reconstroi o painel inteiro via `innerHTML`, o que reseta o input — visualmente o slider salta de volta pro valor antigo e fica num loop. Em paralelo, `zoom` no `<html>` força layout de tudo (sidebar, player bar, view atual). Combinacao pode estar saturando o event loop a ponto de input parar de responder.

2. **`renderPanel` no `input` handler**: o handler de `input` (ou `change`) chama `setVal` que chama `renderPanel`. Re-render destrutivo de painel a cada movimento do slider e antipattern — deveria atualizar so o label do valor, sem refazer o DOM. Esse loop talvez seja o gargalo principal.

3. **Pointer capture perdido**: WebKitGTK pode estar perdendo o pointer capture quando o `innerHTML` do painel e reescrito mid-drag. O slider deixa de receber `pointermove` mas o evento original ainda esta em flight, mantendo a thread ocupada.

## Fix sugerido (nao implementar agora)

- Trocar `renderPanel` no input handler por update incremental: atualizar so o `<span>` do valor numerico, deixar o `<input>` intacto.
- Aplicar `zoom` com debounce (50ms) durante drag, valor final no `change`.
- Considerar usar `requestAnimationFrame` pra coalescer applyTweaks em frames.

## Reproducao

1. Abrir app v0.2.13 ou superior
2. Sidebar → Tweaks (botao bottom-left)
3. Arrastar o slider "Scale" lentamente
4. Tentar clicar em qualquer item da sidebar ou view → nao responde
5. Fechar/reabrir o painel as vezes destrava; as vezes precisa reload

## Workaround

Usar setas do teclado ou clicar nas extremidades do slider em vez de arrastar. Em produção, evitar o controle ate o fix.

## Referencias

- Commit que introduziu: `5090c4a`
- Arquivo: `src/js/components/tweaks.js` linhas ~80-130 (renderPanel + handlers)
- Padrao similar funcionando bem: Settings.tsx Solid (signals reativos, sem re-render destrutivo)
