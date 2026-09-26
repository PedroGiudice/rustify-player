/* ============================================================
   gl/fftReplay.ts — sinal REAL gravado no app, para replay.

   A fixture (src/gl/__fixtures__/fft-real-2609.json) é a gravação de
   12 min do evento "audio-fft" no app 0.2.82 da cmr-auto (26/09),
   ~62 eventos/s, várias faixas. Formato compacto:
     v_b64   n x (low, mid, high) em u8 (valor/255), intercalados;
     dt_b64  n x intervalo desde o evento anterior, u8 em ms;
     marks   [índice, título] a cada troca do <h1> da tela — título da
             faixa OU nome de tela ("Playlists", "Rap & Hip-Hop"): o
             nome de tela não é troca de faixa, é continuação.

   Onde o FFT é medido (o que o replay reproduz): o pw_capture.rs abre
   o monitor do sink padrão, DEPOIS de EQ, norm_gain (alvo LUFS),
   limiter, bass e volume do usuário. O nível absoluto do raw muda com
   o alvo LUFS e com o volume — mais um motivo para a reação do Relevo
   ser relativa à média da própria faixa.

   Puro (sem fs, sem DOM além de atob): o vitest e o gl-bench (replay
   no WebKitGTK) usam o mesmo decodificador.
   ============================================================ */

import { createGlSignal, stepGlSignal, type GlCfg, type GlSignal } from "./signal";

/** Cfg de referência do CEO: a que ele usa de fato no Tweaks (26/09).
    As metas da calibração do Relevo valem para ela E para os defaults. */
export const CEO_GL_CFG: GlCfg = {
  bassGain: 0.3,
  midGain: 0.15,
  trebleGain: 0.1,
  smoothing: 1.0,
  speed: 1.0,
  beatMode: "pulse",
  beatDepth: 1.0,
};

export interface FftFixture {
  n: number;
  v_b64: string;
  dt_b64: string;
  marks: [number, string][];
}

export interface FftReplay {
  n: number;
  /** low, mid, high intercalados, 0..1. */
  v: Float32Array;
  /** Intervalo antes de cada evento, em segundos. */
  dt: Float32Array;
  marks: [number, string][];
}

/** Marcas que são nome de tela, não faixa (ver cabeçalho). */
export const SCREEN_MARKS: ReadonlySet<string> = new Set([
  "Playlists",
  "Rap & Hip-Hop",
  "Library",
  "Albums",
  "Artists",
  "Search",
  "Crate",
  "Signal",
  "Settings",
  "Home",
  "Stations",
  "Tweaks",
]);

function b64bytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeFixture(fx: FftFixture): FftReplay {
  const vb = b64bytes(fx.v_b64);
  const db = b64bytes(fx.dt_b64);
  if (vb.length !== 3 * fx.n || db.length !== fx.n) throw new Error("fixture de FFT inconsistente");
  const v = new Float32Array(vb.length);
  for (let i = 0; i < vb.length; i++) v[i] = vb[i] / 255;
  const dt = new Float32Array(fx.n);
  for (let i = 0; i < fx.n; i++) dt[i] = db[i] / 1000;
  return { n: fx.n, v, dt, marks: fx.marks };
}

export interface TrackSpan {
  title: string;
  /** Índices [a, b) dos eventos, um por trecho contínuo da faixa. */
  spans: [number, number][];
  seconds: number;
}

/**
 * Agrupa os eventos por faixa. Nome de tela vira continuação da faixa
 * anterior; trecho contínuo com menos de `minSegS` segundos (pulo
 * rápido de faixa) fica fora; a mesma faixa em trechos separados é
 * juntada. Só entram faixas com pelo menos `minSegS` no total.
 */
export function trackSpans(r: FftReplay, minSegS = 15): TrackSpan[] {
  const tracks = r.marks.filter(([, t]) => !SCREEN_MARKS.has(t));
  const by = new Map<string, TrackSpan>();
  for (let j = 0; j < tracks.length; j++) {
    const a = tracks[j][0];
    const b = j + 1 < tracks.length ? tracks[j + 1][0] : r.n;
    let s = 0;
    for (let i = a; i < b; i++) s += r.dt[i];
    if (s < minSegS) continue;
    const title = tracks[j][1];
    let t = by.get(title);
    if (!t) by.set(title, (t = { title, spans: [], seconds: 0 }));
    t.spans.push([a, b]);
    t.seconds += s;
  }
  return [...by.values()];
}

/** Título da faixa tocando no evento i (a marca de faixa mais recente;
    nome de tela não conta). */
export function titleAt(r: FftReplay, i: number): string {
  let t = "";
  for (const [at, title] of r.marks) {
    if (at > i) break;
    if (!SCREEN_MARKS.has(title)) t = title;
  }
  return t;
}

/**
 * Os `k` instantes em que `score(sinal)` é máximo ao longo do replay,
 * separados por pelo menos `minGapS` segundos (senão os k seriam o
 * mesmo pico). Roda a cadeia do app (stepGlSignal) desde o início com
 * o dt gravado. Devolve índices de evento, do maior para o menor.
 */
export function worstInstants(
  r: FftReplay,
  cfg: GlCfg,
  score: (sig: GlSignal) => number,
  k: number,
  minGapS: number,
): { index: number; score: number; t: number }[] {
  const s = createGlSignal();
  const raw = { low: 0, mid: 0, high: 0 };
  const sc = new Float32Array(r.n);
  const at = new Float32Array(r.n);
  let t = 0;
  for (let i = 0; i < r.n; i++) {
    raw.low = r.v[3 * i];
    raw.mid = r.v[3 * i + 1];
    raw.high = r.v[3 * i + 2];
    stepGlSignal(s, r.dt[i], true, raw, cfg);
    t += r.dt[i];
    sc[i] = score(s);
    at[i] = t;
  }
  const order = Array.from(sc.keys()).sort((a, b) => sc[b] - sc[a]);
  const out: { index: number; score: number; t: number }[] = [];
  for (const i of order) {
    if (out.length >= k) break;
    if (out.some((o) => Math.abs(o.t - at[i]) < minGapS)) continue;
    out.push({ index: i, score: sc[i], t: at[i] });
  }
  return out;
}
