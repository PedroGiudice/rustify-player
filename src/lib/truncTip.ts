// src/lib/truncTip.ts — texto cortado por reticências ganha o title com o
// texto inteiro (A37, varredura de 31/10).
//
// "(Remastered 2011) [Deluxe Edition]" virava "…" e o hover não mostrava
// nada. O title só entra quando o texto de fato não cabe (scrollWidth >
// clientWidth), medido na hora do pointerenter/focus da linha ou do card:
// nada roda por quadro nem no render de milhares de linhas.
//
// Uso: marcar o elemento que corta com `data-trunc` e pôr
// `onPointerEnter={truncTipEvent}` (e `onFocus`) no contêiner.

const MARK = "data-trunc";

function apply(el: HTMLElement) {
  if (el.scrollWidth > el.clientWidth) {
    const text = (el.textContent ?? "").trim();
    if (text && el.title !== text) el.title = text;
  } else if (el.hasAttribute("title")) {
    el.removeAttribute("title");
  }
}

export function truncTipWithin(root: HTMLElement) {
  if (root.hasAttribute(MARK)) apply(root);
  root.querySelectorAll<HTMLElement>(`[${MARK}]`).forEach(apply);
}

export function truncTipEvent(e: Event) {
  const el = e.currentTarget;
  if (el instanceof HTMLElement) truncTipWithin(el);
}
