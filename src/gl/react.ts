/* ============================================================
   react.ts — curva única que transforma a reação relativa do som
   (swell / midLift / highLift / *Rel, 0..1 ou -1..1) no quanto o efeito
   de uma cena se mexe.

   É a curva das zonas da Tinta (ZONE_SENS / ZONE_CAP = 4 / 0,8 = 5),
   que o CEO calibrou no olho em 11/10/2026. Antes de 30/10 cada cena usava
   o sinal cru: com os ajustes dele (grave 0,35, médio 0,05, agudo 0,10) a
   Tinta andava e a Lorem ficava parada (brilho em 10% nos momentos
   fortes). Com a mesma curva em todas, o knob significa o mesmo em
   qualquer cena. Sinal pequeno é amplificado ~5x; perto do topo a curva
   achata, então o padrão do app não vive no teto.

   A batida (pulse) NÃO passa por aqui: a força dela é o beat depth.
   ============================================================ */

export const REACT_SENS = 5;
const NORM = Math.tanh(REACT_SENS);

/** 0..1 -> 0..1. Fora do intervalo (ou NaN) cai nos limites. */
export function drive(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  return Math.tanh(REACT_SENS * x) / NORM;
}

/** -1..1 -> -1..1, mesma curva dos dois lados. */
export function driveSigned(r: number): number {
  return r < 0 ? -drive(-r) : drive(r);
}
