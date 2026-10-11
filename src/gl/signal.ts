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
  /** Agudos acima da média recente (11/10: zonas da Tinta, as camadas
      claras cintilam com eles). Ganho = Treble do Tweaks. */
  highLift: number;
  /** Desvio COM SINAL de cada banda em relação à média recente, -1..1,
      com o ganho do Tweaks (11/10, zonas da Tinta). Positivo = acima da
      média (o lift correspondente é exatamente a parte positiva);
      negativo = abaixo. Decai a zero com o stream parado. */
  lowRel: number;
  midRel: number;
  highRel: number;
  /** Nível absoluto lento dos graves (0..1). Só pode somar pouco
      (ver gl/reliefReaction.ts); decai a zero com o stream parado. */
  level: number;

  /* ---- estado interno da reação relativa ---- */
  /** Envelopes dos raws SEM ganho (o ganho entra no lift). */
  lowEnv: number;
  midEnv: number;
  highEnv: number;
  /** Médias e dispersões (desvio absoluto médio) de longo prazo. */
  lowAvg: number;
  lowDev: number;
  midAvg: number;
  midDev: number;
  highAvg: number;
  highDev: number;
  /** Segundos de stream vivo já vistos pelas médias (satura em
      REL_AVG_TAU): no começo a média é praticamente a acumulada. */
  relAge: number;
}

export function createGlSignal(): GlSignal {
  return {
    low: 0, mid: 0, high: 0, beat: 0, clock: 0,
    swell: 0, pulse: 0, midLift: 0, highLift: 0, lowRel: 0, midRel: 0, highRel: 0, level: 0,
    lowEnv: 0, midEnv: 0, highEnv: 0, lowAvg: 0, lowDev: 0, midAvg: 0, midDev: 0, highAvg: 0, highDev: 0,
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
export const HIGH_SPAN = 2.5;
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

// NaN cai em 0 (e Infinity no teto): um valor inválido no raw ou num
// knob nunca entra no estado, que é integrado e não se recupera sozinho.
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);
/** -1..1; NaN cai em 0, ±Infinity nos tetos. */
const clampSigned = (v: number) => (v > 0 ? (v < 1 ? v : 1) : v < 0 ? (v > -1 ? v : -1) : 0);
/** Ganho/knob não negativo e finito; o resto vale 0. */
const gain = (v: number) => (v > 0 && v < Infinity ? v : 0);
/** Amostra do FFT finita; o resto vale 0. */
const finite = (v: number) => (Number.isFinite(v) ? v : 0);

/** Soma low+mid abaixo disto = silêncio com o stream vivo (mudo, volume 0,
    gap entre faixas: o FFT é medido depois do volume). Conta como pausa
    para a reação relativa — senão as médias desceriam a zero e a volta do
    som viraria transiente cheio. 5 degraus do raw quantizado em 8 bits. */
export const SILENCE_FLOOR = 0.02;

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
  const dt = dtRaw > 0 ? Math.min(DT_MAX, dtRaw) : 0;
  if (dt === 0) return;
  const rl = finite(raw.low);
  const rm = finite(raw.mid);
  const rh = finite(raw.high);

  const tau = ENV_TAU_MIN + clamp01(cfg.smoothing) * (ENV_TAU_MAX - ENV_TAU_MIN);
  const k = 1 - Math.exp(-dt / tau);

  const tLow = fresh ? clamp01(rl * gain(cfg.bassGain)) : 0;
  const tMid = fresh ? clamp01(rm * gain(cfg.midGain)) : 0;
  const tHigh = fresh ? clamp01(rh * gain(cfg.trebleGain)) : 0;

  s.low += (tLow - s.low) * k;
  s.mid += (tMid - s.mid) * k;
  s.high += (tHigh - s.high) * k;

  // Beat: envelope rápido sobre o kick expandido pra faixa real.
  const beatOn = cfg.beatMode !== "off";
  const tBeat = fresh && beatOn ? clamp01(expandKick(rl)) : 0;
  s.beat += (tBeat - s.beat) * (1 - Math.exp(-dt / BEAT_TAU));
  if (!beatOn) s.beat = 0;

  stepRelative(s, dt, tau, fresh && rl + rm > SILENCE_FLOOR, rl, rm, rh, cfg, beatOn);

  // Relógio: só o modo speed mexe na derivada.
  const boost = cfg.beatMode === "speed" ? speedBoostGain(gain(cfg.beatDepth)) * s.beat : 0;
  s.clock += dt * gain(cfg.speed) * (1 + boost);
}

const ema = (v: number, target: number, dt: number, tau: number) => v + (target - v) * (1 - Math.exp(-dt / tau));

/** Reação relativa à faixa (swell / pulse / midLift / highLift / level). */
function stepRelative(
  s: GlSignal,
  dt: number,
  tau: number,
  live: boolean,
  rawLow: number,
  rawMid: number,
  rawHigh: number,
  cfg: GlCfg,
  beatOn: boolean,
): void {
  if (!live) {
    // Stream parado ou silêncio: saídas e envelopes decaem; médias e
    // dispersões congelam.
    s.lowEnv = ema(s.lowEnv, 0, dt, tau);
    s.midEnv = ema(s.midEnv, 0, dt, tau);
    s.highEnv = ema(s.highEnv, 0, dt, tau);
    s.swell = ema(s.swell, 0, dt, tau);
    s.midLift = ema(s.midLift, 0, dt, tau);
    s.highLift = ema(s.highLift, 0, dt, tau);
    s.lowRel = ema(s.lowRel, 0, dt, tau);
    s.midRel = ema(s.midRel, 0, dt, tau);
    s.highRel = ema(s.highRel, 0, dt, tau);
    s.pulse = ema(s.pulse, 0, dt, PULSE_RELEASE);
    s.level = ema(s.level, 0, dt, tau);
    if (!beatOn) s.pulse = 0;
    return;
  }
  const lo = clamp01(rawLow);
  const mi = clamp01(rawMid);
  const hi = clamp01(rawHigh);
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
    s.highAvg = hi;
    s.lowDev = REL_DEV_FLOOR;
    s.midDev = REL_DEV_FLOOR;
    s.highDev = REL_DEV_FLOOR;
  }
  s.lowAvg = ema(s.lowAvg, lo, dt, avgTau);
  s.midAvg = ema(s.midAvg, mi, dt, avgTau);
  s.highAvg = ema(s.highAvg, hi, dt, avgTau);
  s.lowDev = ema(s.lowDev, Math.abs(lo - s.lowAvg), dt, devTau);
  s.midDev = ema(s.midDev, Math.abs(mi - s.midAvg), dt, devTau);
  s.highDev = ema(s.highDev, Math.abs(hi - s.highAvg), dt, devTau);
  const lowSd = Math.max(REL_DEV_FLOOR, s.lowDev);
  const midSd = Math.max(REL_DEV_FLOOR, s.midDev);
  const highSd = Math.max(REL_DEV_FLOOR, s.highDev);

  s.lowEnv = ema(s.lowEnv, lo, dt, tau);
  s.midEnv = ema(s.midEnv, mi, dt, tau);
  s.highEnv = ema(s.highEnv, hi, dt, tau);
  const bass = gain(cfg.bassGain);
  const lowDelta = (bass * (s.lowEnv - s.lowAvg)) / (SWELL_SPAN * lowSd);
  const midDelta = (gain(cfg.midGain) * (s.midEnv - s.midAvg)) / (MID_SPAN * midSd);
  const highDelta = (gain(cfg.trebleGain) * (s.highEnv - s.highAvg)) / (HIGH_SPAN * highSd);
  s.swell = clamp01(lowDelta);
  s.midLift = clamp01(midDelta);
  s.highLift = clamp01(highDelta);
  s.lowRel = clampSigned(lowDelta);
  s.midRel = clampSigned(midDelta);
  s.highRel = clampSigned(highDelta);
  s.level = ema(s.level, clamp01(bass) * s.lowAvg, dt, tau);

  const kick = beatOn ? clamp01((lo - s.lowAvg - PULSE_GATE * lowSd) / (PULSE_SPAN * lowSd)) : 0;
  const tp = kick * clamp01(cfg.beatDepth);
  s.pulse = ema(s.pulse, tp, dt, tp > s.pulse ? PULSE_ATTACK : PULSE_RELEASE);
  if (!beatOn) s.pulse = 0;
}
