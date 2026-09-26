/* ============================================================
   gl/reliefReaction.ts — quanto o Relevo reage ao áudio (26/09).

   Vale para TODAS as variantes do Relevo menos a "original", que
   segue a fórmula antiga intacta (referência do CEO). Função pura,
   sem GL: o Relevo calcula aqui, uma vez por quadro, os dois números
   que o vertex shader usa (uniforms uAmp e uWave) — nada disto roda
   por vértice. O replay do sinal real (reliefReaction.test.ts) usa a
   MESMA função, então as metas travadas no teste são as do app.

   UMA FUNÇÃO POR BANDA (o defeito era somar três efeitos que
   saturavam juntos — grave inflava, a batida DERIVADA do mesmo grave
   inflava de novo e a onda de médios de ±6 atravessava a tela):
     graves  -> swell: ondulação lenta da amplitude;
     kick    -> pulse: pulso curto de amplitude;
     médios  -> midLift: a onda transversal, até ±RELIEF_WAVE_MAX;
     agudos  -> nada (a cor das variantes é única).
   Mais um termo pequeno de nível absoluto (level), para a música
   alta ser um pouco mais alta — no máximo ~+10%.

   TETO: F = amplitude / 5,5 passa por joelho suave
     F = 1 + K·tanh(x/K),  K = RELIEF_F_MAX − 1 = 0,5
   que é ≈ 1 + x para x pequeno e nunca chega a 1,5 (sem degrau).
   ============================================================ */

import type { GlSignal } from "./signal";

/** Amplitude de repouso do fbm do Relevo (a mesma do original). */
export const RELIEF_BASE_AMP = 5.5;
/** Teto rígido do fator de amplitude F (assíntota do joelho). */
export const RELIEF_F_MAX = 1.5;
/** Amplitude máxima da onda dos médios, em unidades de mundo (o
    original chega a ±6, que atravessava a tela). */
export const RELIEF_WAVE_MAX = 2.5;

/** Pesos de cada banda no x do joelho (F ≈ 1 + x no trecho linear).
    Calibrados no replay do sinal real: com a cfg de referência do
    CEO e com os defaults, em cada faixa, F p50 <= 1,15, p95 <= 1,40
    e p95 − p5 >= 0,12 (o terreno respira). */
export const RELIEF_SWELL_W = 0.3;
export const RELIEF_PULSE_W = 0.3;
/** Nível absoluto: level = clamp(bassGain)·média dos graves, <= 1, então
    este termo soma no máximo +0,10 em x (e menos que isso em F, pelo
    joelho). Música alta fica um pouco mais alta, nunca presa no teto. */
export const RELIEF_LEVEL_W = 0.1;

const K = RELIEF_F_MAX - 1;

/** Fator de amplitude F (1 = repouso), sempre em [1, RELIEF_F_MAX). */
export function reliefAmpFactor(sig: GlSignal): number {
  const x = Math.max(0, RELIEF_SWELL_W * sig.swell + RELIEF_PULSE_W * sig.pulse + RELIEF_LEVEL_W * sig.level);
  return 1 + K * Math.tanh(x / K);
}

/** Amplitude do fbm (u de mundo) que o VS usa: RELIEF_BASE_AMP · F. */
export function reliefAmp(sig: GlSignal): number {
  return RELIEF_BASE_AMP * reliefAmpFactor(sig);
}

/** Amplitude (u de mundo) da onda transversal dos médios, 0..RELIEF_WAVE_MAX. */
export function reliefWaveAmp(sig: GlSignal): number {
  const m = sig.midLift < 0 ? 0 : sig.midLift > 1 ? 1 : sig.midLift;
  return RELIEF_WAVE_MAX * m;
}

/** F da variante "original" (a reação antiga), espelho de
    (5.5 + 5.0*uLow + 3.0*uBeat) / 5.5 no VS dela. Só para medir e
    comparar (replay, gl-bench): o original não usa esta função. */
export function reliefOriginalFactor(sig: GlSignal): number {
  return (RELIEF_BASE_AMP + 5 * sig.low + 3 * sig.beat) / RELIEF_BASE_AMP;
}
