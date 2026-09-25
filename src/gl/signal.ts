/* ============================================================
   gl/signal.ts — sinal que alimenta os fundos WebGL.

   Espelha a cadeia do SpectrumCanvas (Canvas 2D), com UMA
   diferença deliberada: as cenas WebGL consomem as TRÊS bandas
   separadas (uLow/uMid/uHigh), não a soma ponderada única. No
   2D o campo escalar é um só e precisa de um escalar; aqui
   graves inflam partículas enquanto médios aceleram a deriva —
   somar antes destruiria justamente isso.

   O que é preservado do 2D, porque é contrato do Tweaks:
     - gains por banda (bgBass/Mid/TrebleGain), aplicados
       ANTES do smoothing, com clamp em 1 (saturar é do domínio);
     - smoothing (bgSmoothing) → tau em ENV_TAU_MIN..MAX;
     - bgSpeed no relógio virtual — só a DERIVADA muda, nunca
       recomputamos t do zero (sem salto de fase);
     - beat-sync: modo SPEED empurra a derivada do relógio; modo
       PULSE não toca no relógio. Nos dois, `beat` sai como
       envelope do kick pras cenas modularem AMPLITUDE.

   Diferença consciente vs 2D no modo pulse: aqui não roda o PLL
   (lib/beatPll.ts). O lock é parcial em música real e o custo de
   carregar a fase travada pra dentro do shader não se paga —
   `beat` é o envelope de kick expandido nos dois modos. Se o
   lock melhorar, este é o ponto de troca.

   Estado explícito + função pura: o componente guarda um
   GlSignal e chama stepGlSignal por frame.
   ============================================================ */

import { expandKick, speedBoostGain, BEAT_TAU } from "../lib/beatPll";

/** Tau (s) do decay dos envelopes por banda — mesmos limites do
    SpectrumCanvas, mapeados por bgSmoothing (0..1). */
const ENV_TAU_MIN = 0.1;
const ENV_TAU_MAX = 0.8;

/** dt máximo por frame (s). Voltar do background congelado daria um
    dt de minutos e um salto de fase; o clamp preserva a continuidade. */
const DT_MAX = 0.1;

export type BeatMode = "off" | "speed" | "pulse";

export interface GlCfg {
  bassGain: number;
  midGain: number;
  trebleGain: number;
  smoothing: number;
  speed: number;
  beatMode: BeatMode;
  beatDepth: number;
}

export const DEFAULT_GL_CFG: GlCfg = {
  bassGain: 1.0,
  midGain: 1.0,
  trebleGain: 0.8,
  smoothing: 0.3,
  speed: 1.0,
  beatMode: "speed",
  beatDepth: 0.55,
};

export interface GlSignal {
  /** Envelopes por banda, 0..1, já com gain e smoothing. */
  low: number;
  mid: number;
  high: number;
  /** Envelope do kick (0..1) — zero com beat-sync off. */
  beat: number;
  /** Relógio virtual da animação, em segundos. Monotônico. */
  clock: number;
}

export function createGlSignal(): GlSignal {
  return { low: 0, mid: 0, high: 0, beat: 0, clock: 0 };
}

export interface FftBands {
  low: number;
  mid: number;
  high: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Avança o sinal um frame.
 *
 * @param fresh  stream de FFT vivo. Falso (pausa, silêncio, stale) →
 *               todos os alvos vão a zero e os envelopes decaem.
 */
export function stepGlSignal(
  s: GlSignal,
  dtRaw: number,
  fresh: boolean,
  raw: FftBands,
  cfg: GlCfg,
): void {
  const dt = Math.max(0, Math.min(DT_MAX, dtRaw));

  const tau = ENV_TAU_MIN + clamp01(cfg.smoothing) * (ENV_TAU_MAX - ENV_TAU_MIN);
  const k = 1 - Math.exp(-dt / tau);

  const tLow = fresh ? clamp01(raw.low * cfg.bassGain) : 0;
  const tMid = fresh ? clamp01(raw.mid * cfg.midGain) : 0;
  const tHigh = fresh ? clamp01(raw.high * cfg.trebleGain) : 0;

  s.low += (tLow - s.low) * k;
  s.mid += (tMid - s.mid) * k;
  s.high += (tHigh - s.high) * k;

  // Beat: envelope rápido sobre o kick expandido pra faixa real.
  const beatOn = cfg.beatMode !== "off";
  const tBeat = fresh && beatOn ? expandKick(raw.low) : 0;
  s.beat += (tBeat - s.beat) * (1 - Math.exp(-dt / BEAT_TAU));
  if (!beatOn) s.beat = 0;

  // Relógio: só o modo speed mexe na derivada.
  const boost = cfg.beatMode === "speed" ? speedBoostGain(cfg.beatDepth) * s.beat : 0;
  s.clock += dt * Math.max(0, cfg.speed) * (1 + boost);
}
