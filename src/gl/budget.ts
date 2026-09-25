/* ============================================================
   gl/budget.ts — orçamento de resolução das cenas, SEM three.

   A Nébula desenha 25 ruídos simplex por pixel. Em resolução cheia
   custava 23-24 ms por quadro na cmr-auto (UHD 620, 1366x768), mais
   que um quadro inteiro de 60 fps; o lab v2 mediu 3,6 ms para a mesma
   cena num buffer de 256 linhas escalado com filtro linear
   (docs/design-refs/fundo-lab-v2). O fbm é macio: um terço da
   resolução não perde detalhe visível, e o dither no composite apaga
   o degrau de cor que a escala revelaria.
   ============================================================ */

/** Teto de linhas do buffer da Nébula. */
export const NEBULA_MAX_ROWS = 256;

/** Tamanho do buffer reduzido: no máximo `maxRows` linhas, largura na
    mesma proporção da tela, nunca zero e nunca maior que a tela. */
export function reducedBufferSize(w: number, h: number, maxRows: number): { w: number; h: number } {
  const fw = Math.max(1, Math.round(w));
  const fh = Math.max(1, Math.round(h));
  const rows = Math.min(fh, Math.max(1, Math.round(maxRows)));
  return { w: Math.max(1, Math.round((fw * rows) / fh)), h: rows };
}
