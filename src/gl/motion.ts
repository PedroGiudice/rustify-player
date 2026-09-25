/* ============================================================
   gl/motion.ts — integração de movimento das cenas, SEM three.

   Regra (CMR-267): o sinal de áudio muda a VELOCIDADE, e a posição
   é integrada aqui na CPU e entra no shader como uniform. Nunca
   `uTime * (a + b*sinal)`: com o sinal oscilando, a velocidade
   aparente vira `v + t·dv/dt` e cresce com o tempo de sessão.

   Puro e sem three para ser testável e barato de importar.
   ============================================================ */

/** Profundidade do volume da Poeira (u). O shader faz mod(…, DUST_DEPTH). */
export const DUST_DEPTH = 90;

/**
 * Avança o deslocamento da Poeira um quadro.
 *
 * @param dClock avanço do relógio virtual neste quadro (s) — já traz
 *               bgSpeed e o empurrão do beat-sync, como o `uTime`
 *               que a cena usava antes.
 * @param mid    envelope dos médios (0..1): 3 u/s parado, 7 u/s no
 *               máximo, a mesma faixa do shader antigo.
 * @returns deslocamento em [0, DUST_DEPTH). O shader aplica o mesmo
 *          mod, então dobrar aqui não muda a imagem e mantém o float32
 *          do uniform preciso em sessões longas.
 */
export function advanceDustTravel(travel: number, dClock: number, mid: number): number {
  const next = travel + Math.max(0, dClock) * (3 + 4 * mid);
  return next % DUST_DEPTH;
}
