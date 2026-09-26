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

   REAÇÃO RELATIVA À FAIXA (26/09, calibração do Relevo): além das
   bandas absolutas, o sinal expõe swell / pulse / midLift — quanto
   a banda está ACIMA da média recente da PRÓPRIA música (princípio
   do MilkDrop: bass relativo a bass_att). Motivo, medido no sinal
   real gravado no app (src/gl/__fixtures__/fft-real-2609.json): em
   música de grave forte o raw.low nunca cai abaixo de ~0,43 e o
   envelope absoluto fica preso no alto — o terreno inflava de vez e
   parava de respirar. Relativo, o que move é a VARIAÇÃO: a música
   alta não fica permanentemente alta.
     - média e dispersão de longo prazo (AVG_TAU/DEV_TAU) por banda;
     - lift = (envelope − média) / (SPAN · dispersão), 0..1;
     - o GANHO do Tweaks multiplica o LIFT, não o raw: normalização
       relativa cancela ganho aplicado no raw (g·S / g·A = S/A) e o
       knob viraria placebo;
     - stream parado (fresh=false): as saídas decaem a zero e as
       médias CONGELAM — na volta, o nível de sempre não vira
       transiente gigante;
     - partida: o tau das médias cresce com o tempo de stream vivo
       (min(AVG_TAU, idade)), ou seja, no começo a média é a média
       ACUMULADA das amostras vistas, não uma EMA semeada por uma
       amostra só. Semear pela 1ª amostra falhou no sinal real: ela
       era 0,70 num trecho que vive em 0,25-0,45 e a faixa passou 6 s
       inteiros "abaixo da média", sem reagir.
   low/mid/high/beat/clock seguem idênticos: as outras cenas os usam.

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

  /* ---- reação relativa à faixa (0..1, já com gain/depth) ---- */
  /** Graves acima da média recente da música: ondulação lenta. */
  swell: number;
  /** Transiente do kick acima da média: pulso curto. Já escalado por
      beatDepth; zero com beat-sync off. */
  pulse: number;
  /** Médios acima da média recente. */
  midLift: number;
  /** Nível absoluto lento dos graves (0..1). Só pode somar pouco
      (ver gl/reliefReaction.ts); decai a zero com o stream parado. */
  level: number;

  /* ---- estado interno da reação relativa ---- */
  /** Envelopes dos raws SEM ganho (o ganho entra no lift). */
  lowEnv: number;
  midEnv: number;
  /** Médias e dispersões (desvio absoluto médio) de longo prazo. */
  lowAvg: number;
  lowDev: number;
  midAvg: number;
  midDev: number;
  /** Segundos de stream vivo já vistos pelas médias (satura em
      REL_AVG_TAU): no começo a média é praticamente a acumulada. */
  relAge: number;
}

export function createGlSignal(): GlSignal {
  return {
    low: 0, mid: 0, high: 0, beat: 0, clock: 0,
    swell: 0, pulse: 0, midLift: 0, level: 0,
    lowEnv: 0, midEnv: 0, lowAvg: 0, lowDev: 0, midAvg: 0, midDev: 0,
    relAge: 0,
  };
}

/* ---------- constantes da reação relativa ----------
   Calibradas contra o sinal real (replay em reliefReaction.test.ts,
   que trava as metas por faixa). */

/** Tau (s) da média de longo prazo: ~2-3 compassos de 4/4 a 90-150
    BPM. Mais curto, o swell some antes de ser visto (a média alcança
    a subida); mais longo, a troca de faixa leva meio minuto para
    reassentar. */
export const REL_AVG_TAU = 6;
/** Tau (s) da dispersão (desvio absoluto médio em torno da média). */
export const REL_DEV_TAU = 6;
/** Piso do tau efetivo na partida (s): ~2 eventos de FFT a 62 Hz. */
const REL_AGE_MIN = 0.03;
/** Piso da dispersão: faixa de grave quase constante (drone) teria
    dispersão ~0 e o menor tremor viraria lift cheio. 0,04 ≈ o
    tremor típico do raw.low (sqrt(mag)·4 quantizado) em sustentação. */
export const REL_DEV_FLOOR = 0.04;
/** Dispersões acima da média para o lift chegar a 1. */
export const SWELL_SPAN = 2.5;
export const MID_SPAN = 2.5;
/** Pulso: o raw.low precisa passar média + PULSE_GATE·dispersão para
    contar como kick, e chega a 1 em + (GATE + SPAN)·dispersão. O gate
    tira o "zumbido" do grave sustentado (que fica em torno da média)
    e deixa só a cabeça do bumbo. */
export const PULSE_GATE = 0.5;
export const PULSE_SPAN = 2.0;
/** Ataque e soltura (s) do envelope do pulso: ataque quase imediato,
    soltura curta — o pulso tem que acabar antes do próximo kick a
    ~145 BPM (0,41 s) para o terreno respirar entre eles. */
export const PULSE_ATTACK = 0.02;
export const PULSE_RELEASE = 0.14;

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

  stepRelative(s, dt, tau, fresh, raw, cfg, beatOn);

  // Relógio: só o modo speed mexe na derivada.
  const boost = cfg.beatMode === "speed" ? speedBoostGain(cfg.beatDepth) * s.beat : 0;
  s.clock += dt * Math.max(0, cfg.speed) * (1 + boost);
}

const ema = (v: number, target: number, dt: number, tau: number) => v + (target - v) * (1 - Math.exp(-dt / tau));

/** Reação relativa à faixa (swell / pulse / midLift / level). */
function stepRelative(
  s: GlSignal,
  dt: number,
  tau: number,
  fresh: boolean,
  raw: FftBands,
  cfg: GlCfg,
  beatOn: boolean,
): void {
  if (!fresh) {
    // Saídas e envelopes decaem; médias e dispersões congelam.
    s.lowEnv = ema(s.lowEnv, 0, dt, tau);
    s.midEnv = ema(s.midEnv, 0, dt, tau);
    s.swell = ema(s.swell, 0, dt, tau);
    s.midLift = ema(s.midLift, 0, dt, tau);
    s.pulse = ema(s.pulse, 0, dt, PULSE_RELEASE);
    s.level = ema(s.level, 0, dt, tau);
    if (!beatOn) s.pulse = 0;
    return;
  }
  const lo = clamp01(raw.low);
  const mi = clamp01(raw.mid);
  // Tau efetivo = idade (média acumulada) até saturar no tau nominal.
  // Com dt = idade no 1º quadro o peso da 1ª amostra é 1 - e^-1; o
  // piso REL_AGE_MIN evita tau 0 e divisões degeneradas.
  s.relAge = Math.min(REL_AVG_TAU, s.relAge + dt);
  const avgTau = Math.max(REL_AGE_MIN, s.relAge);
  const devTau = Math.max(REL_AGE_MIN, Math.min(REL_DEV_TAU, s.relAge));
  if (s.relAge === dt) {
    // Primeira amostra viva: média nela, dispersão no piso.
    s.lowAvg = lo;
    s.midAvg = mi;
    s.lowDev = REL_DEV_FLOOR;
    s.midDev = REL_DEV_FLOOR;
  }
  s.lowAvg = ema(s.lowAvg, lo, dt, avgTau);
  s.midAvg = ema(s.midAvg, mi, dt, avgTau);
  s.lowDev = ema(s.lowDev, Math.abs(lo - s.lowAvg), dt, devTau);
  s.midDev = ema(s.midDev, Math.abs(mi - s.midAvg), dt, devTau);
  const lowSd = Math.max(REL_DEV_FLOOR, s.lowDev);
  const midSd = Math.max(REL_DEV_FLOOR, s.midDev);

  s.lowEnv = ema(s.lowEnv, lo, dt, tau);
  s.midEnv = ema(s.midEnv, mi, dt, tau);
  const bass = Math.max(0, cfg.bassGain);
  s.swell = clamp01((bass * (s.lowEnv - s.lowAvg)) / (SWELL_SPAN * lowSd));
  s.midLift = clamp01((Math.max(0, cfg.midGain) * (s.midEnv - s.midAvg)) / (MID_SPAN * midSd));
  s.level = ema(s.level, clamp01(bass) * s.lowAvg, dt, tau);

  const kick = beatOn ? clamp01((lo - s.lowAvg - PULSE_GATE * lowSd) / (PULSE_SPAN * lowSd)) : 0;
  const tp = kick * clamp01(cfg.beatDepth);
  s.pulse = ema(s.pulse, tp, dt, tp > s.pulse ? PULSE_ATTACK : PULSE_RELEASE);
  if (!beatOn) s.pulse = 0;
}
