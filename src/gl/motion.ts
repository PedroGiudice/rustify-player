/* ============================================================
   gl/motion.ts — integração de movimento das cenas, sem GL.

   Regra (CMR-267): o sinal de áudio muda a VELOCIDADE, e a posição
   é integrada aqui na CPU e entra no shader como uniform. Nunca
   `uTime * (a + b*sinal)`: com o sinal oscilando, a velocidade
   aparente vira `v + t·dv/dt` e cresce com o tempo de sessão.

   Puro e sem GL para ser testável e barato de importar.
   ============================================================ */

/** Profundidade do volume da Poeira (u). O shader faz mod(…, DUST_DEPTH). */
export const DUST_DEPTH = 90;
/** Velocidade do fluxo da Poeira (u por segundo de relógio virtual):
    piso parado/silêncio e teto com médios e kick no máximo. A faixa é
    a do shader antigo (3 a 7). */
export const DUST_V_MIN = 3;
export const DUST_V_MAX = 7;

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);

/**
 * Avança o deslocamento da Poeira um quadro.
 *
 * @param dClock  avanço do relógio virtual neste quadro (s) — já traz
 *                bgSpeed e o empurrão do beat-sync. Speed = 0 congela.
 * @param midLift médios acima da média da faixa (0..1): o fluxo corre
 *                mais quando a música abre, não quando ela é alta.
 * @param surge   empurrão do kick (gl/kick.ts stepSurge, 0..1).
 * @returns deslocamento em [0, DUST_DEPTH). O shader aplica o mesmo
 *          mod, então dobrar aqui não muda a imagem e mantém o float32
 *          do uniform preciso em sessões longas.
 */
export function advanceDustTravel(travel: number, dClock: number, midLift: number, surge = 0): number {
  const push = Math.min(1, 0.6 * clamp01(midLift) + 0.55 * clamp01(surge));
  const next = travel + Math.max(0, dClock) * (DUST_V_MIN + (DUST_V_MAX - DUST_V_MIN) * push);
  return next % DUST_DEPTH;
}
