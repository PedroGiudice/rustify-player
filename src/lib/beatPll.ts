/* ============================================================
   beatPll.ts — beat-sync do bg: modo SPEED + modo PULSE (PLL).

   SPEED (default): a energia do kick (low_band_mag expandido pra
   faixa dinâmica real) empurra a DERIVADA do relógio virtual via
   envelope rápido — o movimento acelera no beat, contínuo e
   imediato. É o comportamento clássico da v0.2.52, preferido pelo
   usuário ("mais agressivo, mas melhor", 2026-07-17), agora sobre
   o sinal de ~62 Hz consertado (o emitter colapsava pra ~7 Hz).

   PULSE (experimental): detectar ONSETS do kick (transiente vs
   média móvel) → travar um oscilador em FASE (PLL) → pulso
   "thump" modula AMPLITUDE. Estrutura do PATCH-beat-sync-PLL
   (docs/design-refs/design_handoff_persistent_background/), mas o
   detector foi RECALIBRADO com série real gravada no app
   (2026-07-17, "So It Goes" 105s @ 61.9 Hz): opera sobre o sinal
   EXPANDIDO com ratio 1.4 / floor 0.20 — a melhor variante medida
   (47 onsets/min vs 20 da calibração do lab; lockMean 0.175 vs
   0.113). Em música real com bass sustentado o envelope da low
   band não entrega trem de onsets limpo, então o lock é PARCIAL
   por natureza — o gate (0.4 + 0.6·lock) protege.

   Estado explícito + funções puras: o SpectrumCanvas guarda um
   BeatPll e chama pllStep/beatPulse por frame (~10 ops, zero
   impacto no orçamento 60fps).
   ============================================================ */

// ── Faixa dinâmica real do kick ─────────────────────────────
/** Piso do low_band_mag: abaixo disto é ruído/silêncio. */
export const KICK_FLOOR = 0.1;
/** Teto: onde um kick forte satura (p90 ~0.63, max 0.75-0.82 medidos
    em 2026-07-12 e 2026-07-17 no app real). */
export const KICK_CEIL = 0.6;

/** Remapeia o low_band_mag da faixa dinâmica REAL [FLOOR, CEIL] pra
    [0,1], clampado. Kick fraco/silêncio → 0; kick forte → 1. Usado
    pelo modo speed (energia) e pelo detector de onset (contraste). */
export function expandKick(low: number): number {
  const t = (low - KICK_FLOOR) / (KICK_CEIL - KICK_FLOOR);
  return Math.max(0, Math.min(1, t));
}

// ── Modo speed ──────────────────────────────────────────────
/** Tau (s) do envelope que suaviza o kick antes de modular a
    velocidade. Só refina a transição — o attack/release grosso já
    vem do Rust (pw_capture.rs). */
export const BEAT_TAU = 0.09;

/** Ganho de velocidade do modo speed a partir do depth do Tweaks:
    linear, com depth 0.55 (default) dando ganho 1.0. Recalibrado
    2026-07-19: o 1.5 da v0.2.52 foi ajustado sobre o sinal COLAPSADO
    de 7Hz; com o emitter são (62Hz) o envelope responde 8x mais
    fresco e o mesmo ganho ficou agressivo ("speed forte demais").
    Velocidade = dt·bgSpeed·(1 + gain·env). */
export function speedBoostGain(depth: number): number {
  return depth * (1.0 / 0.55);
}

// ── Onset detection (modo pulse; sobre o sinal EXPANDIDO) ───
/** mag/avg acima disto = candidato a onset. (Lab: 1.6 sobre sim de
    kick seco; recalibrado pra 1.4 sobre o envelope real expandido.) */
export const ONSET_RATIO = 1.4;
/** mag expandida mínima absoluta (ignora ruído de fundo). */
export const ONSET_FLOOR = 0.2;
/** s — refratário entre onsets (evita double-trigger). */
export const ONSET_COOLDOWN = 0.2;
/** s — janela da média móvel do nível. */
export const ONSET_AVG_TAU = 0.35;

// ── PLL ─────────────────────────────────────────────────────
/** Correção proporcional de fase por onset (0..1). */
export const PLL_PHASE_GAIN = 0.5;
/** Correção integral (lenta) do período. */
export const PLL_TEMPO_GAIN = 0.06;
/** s (200 BPM). */
export const PLL_PERIOD_MIN = 0.3;
/** s (50 BPM). */
export const PLL_PERIOD_MAX = 1.2;
/** Suavização da confiança de lock. */
export const PLL_LOCK_RISE = 0.3;
/** s — decay do lock sem onsets. */
export const PLL_LOCK_TAU = 2.5;

// ── Pulso → amplitude ───────────────────────────────────────
/** Profundidade default do pulso (Tweaks: Off/Subtle/Default/Pulse
    → 0 / 0.3 / 0.55 / 0.85 via --bg-beat-depth). */
export const BEAT_DEPTH_DEFAULT = 0.55;
/** Lift sutil de ink density no pulso (0 = desliga). */
export const INK_PULSE = 0.5;

export interface BeatPll {
  /** Média móvel do low_band_mag (nível de referência do detector). */
  avgMag: number;
  /** Timestamp (s, relógio real) do último onset. */
  lastOnsetT: number;
  /** Período estimado da batida (s). */
  period: number;
  /** Fase do oscilador em [0,1) — 0 = na batida. */
  phase: number;
  /** Confiança de lock em [0,1]. */
  locked: number;
}

export function createBeatPll(): BeatPll {
  return { avgMag: 0, lastOnsetT: -1, period: 0.5, phase: 0, locked: 0 };
}

/** Um passo do detector + PLL. `mag` = low_band_mag CRU (a expansão
    pra faixa real acontece aqui dentro); `t` = relógio REAL em segundos
    (performance.now()*0.001 — nunca o clock virtual, senão o lock
    deriva quando bgSpeed != 1); `fresh` = stream de FFT vivo. Muta o
    estado. Retorna true no frame de onset. */
export function pllStep(
  s: BeatPll,
  mag: number,
  t: number,
  dt: number,
  fresh: boolean,
): boolean {
  // Onset detection sobre o kick EXPANDIDO (contraste restaurado — na
  // faixa crua o bass sustentado esmaga o ratio; medido 2026-07-17).
  // Só quando o stream está vivo.
  let onset = false;
  if (fresh) {
    const m = expandKick(mag);
    s.avgMag += (m - s.avgMag) * (1 - Math.exp(-dt / ONSET_AVG_TAU));
    const ratio = m / (s.avgMag + 1e-4);
    onset =
      ratio > ONSET_RATIO && m > ONSET_FLOOR && t - s.lastOnsetT > ONSET_COOLDOWN;
    if (onset) s.lastOnsetT = t;
  }

  // PLL: avança fase; em cada onset corrige fase (rápido) e período (lento).
  s.phase += dt / s.period;
  if (s.phase >= 1) s.phase -= 1;
  if (onset) {
    let e = s.phase;
    if (e > 0.5) e -= 1; // erro assinado p/ batida mais próxima
    s.phase -= e * PLL_PHASE_GAIN;
    if (s.phase < 0) s.phase += 1;
    s.period *= 1 + e * PLL_TEMPO_GAIN;
    s.period = Math.min(PLL_PERIOD_MAX, Math.max(PLL_PERIOD_MIN, s.period));
    s.locked += (Math.max(0, Math.min(1, 1 - Math.abs(e) * 3)) - s.locked) * PLL_LOCK_RISE;
  } else {
    s.locked *= Math.exp(-dt / PLL_LOCK_TAU);
  }
  return onset;
}

/** "Thump": attack linear rápido (4% do período) + decay exponencial.
    ph em [0,1), 0 = na batida. Feel escolhido pro app (o lab tem 3). */
export function pulseShape(ph: number): number {
  return ph < 0.04 ? ph / 0.04 : Math.exp(-(ph - 0.04) * 6.5);
}

/** Reforço do modo pulse sobre o depth compartilhado do Tweaks.
    2026-07-19 ("pulse meio fraco"): com o lock parcial típico (~0.175
    medido em faixa real) o gate antigo (0.4+0.6·lock) cortava o pulso
    pela metade. Um knob só serve os dois modos, então a divergência de
    calibração vive nos coeficientes por modo. */
export const PULSE_GAIN = 1.35;

/** Pulso final pro frame: depth × PULSE_GAIN × shape(fase) × gate de
    lock. O gate (0.55 + 0.45·locked) evita pulsar no escuro sem
    esmagar a resposta enquanto o PLL ainda caça o tempo. */
export function beatPulse(s: BeatPll, depth: number): number {
  if (depth <= 0) return 0;
  return depth * PULSE_GAIN * pulseShape(s.phase) * (0.55 + 0.45 * s.locked);
}
