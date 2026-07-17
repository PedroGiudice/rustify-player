/* ============================================================
   beatPll.ts — beat-sync via PLL (phase-locked loop).

   Substitui o beat-boost de velocidade (beatBoost.ts, removido):
   modular a derivada do relógio lia como solavanco, e low_band_mag
   é magnitude contínua — reativa, atrasada, borrada.

   O caminho novo: detectar ONSETS do kick (transiente vs média
   móvel) → travar um oscilador em FASE no tempo da música (PLL:
   correção proporcional de fase + integral lenta de período) →
   sintetizar um pulso limpo da fase ("thump": attack rápido +
   decay exponencial). O pulso modula AMPLITUDE, nunca velocidade
   nem fase do shape. Preditivo, não reativo.

   Números copiados 1:1 do handoff (docs/design-refs/
   design_handoff_persistent_background/PATCH-beat-sync-PLL.md),
   validados na bancada Beat Sync Lab.html do mesmo diretório.

   Estado explícito + funções puras: o SpectrumCanvas guarda um
   BeatPll e chama pllStep/beatPulse por frame (~10 ops, zero
   impacto no orçamento 60fps).
   ============================================================ */

// ── Onset detection ─────────────────────────────────────────
/** mag/avg acima disto = candidato a onset. */
export const ONSET_RATIO = 1.6;
/** mag mínima absoluta (ignora ruído de fundo). */
export const ONSET_FLOOR = 0.25;
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

/** Um passo do detector + PLL. `mag` = low_band_mag cru; `t` = relógio
    REAL em segundos (performance.now()*0.001 — nunca o clock virtual,
    senão o lock deriva quando bgSpeed != 1); `fresh` = stream de FFT
    vivo. Muta o estado. Retorna true no frame de onset. */
export function pllStep(
  s: BeatPll,
  mag: number,
  t: number,
  dt: number,
  fresh: boolean,
): boolean {
  // Onset detection sobre a low band (kick). Só quando o stream está vivo.
  let onset = false;
  if (fresh) {
    s.avgMag += (mag - s.avgMag) * (1 - Math.exp(-dt / ONSET_AVG_TAU));
    const ratio = mag / (s.avgMag + 1e-4);
    onset =
      ratio > ONSET_RATIO && mag > ONSET_FLOOR && t - s.lastOnsetT > ONSET_COOLDOWN;
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

/** Pulso final pro frame: depth × shape(fase) × confiança de lock.
    O fator (0.4 + 0.6·locked) evita pulsar no escuro sem zerar a
    resposta enquanto o PLL ainda está caçando o tempo. */
export function beatPulse(s: BeatPll, depth: number): number {
  if (depth <= 0) return 0;
  return depth * pulseShape(s.phase) * (0.4 + 0.6 * s.locked);
}
