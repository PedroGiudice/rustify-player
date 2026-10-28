/* ============================================================
   gl/ambient.ts — o modo ambient do fundo WebGL, sem GL.

   Fora do Now Playing o fundo fica atrás da interface: desfocado,
   um pouco menos saturado e mais escuro. Até a 0.2.98 isso era um
   `filter: blur(8px) saturate(0.9)` + `opacity: 0.8` no .app-bg, e o
   WebKitGTK refazia o filtro de tela cheia a cada quadro do canvas
   animado: medido no app real (26/10, 1866x1048, Tinta, item B6 da
   avaliação Impeccable) a Home caía para 46,9 fps com 69 % dos quadros
   acima de 20 ms; a mesma Home com `filter: none` voltava a 60 fps.

   Agora o motor (gl/engine.ts) faz o mesmo efeito dentro do GL, num
   buffer de 1/AMBIENT_SCALE da largura e da altura: desfoque
   gaussiano separável (duas passagens), saturação e ganho no passe de
   composição final. Aqui fica o que não precisa de GL e tem teste:
   a curva da transição focused <-> ambient, o tamanho do buffer e os
   pesos do kernel.

   Os números vêm do CSS que este módulo substitui (extractor-lab.css,
   seção GLOBAL ANIMATED BACKGROUND): 420 ms, --ease-out, blur 8px,
   saturate 0.9, opacity 0.8.
   ============================================================ */

/** Duração da troca de modo (s): o 420 ms do CSS antigo. */
export const AMBIENT_MODE_S = 0.42;
/** Desvio-padrão do desfoque em pixels de tela: o `blur(8px)` do CSS
    (no filtro CSS, o raio É o desvio-padrão da gaussiana). */
export const AMBIENT_BLUR_PX = 8;
/** Saturação no ambient: o `saturate(0.9)`. */
export const AMBIENT_SAT = 0.9;
/** Ganho no ambient: o `opacity: 0.8`, misturado com o preto do canvas
    (GL_CANVAS = #000, decisão de 20/09). */
export const AMBIENT_GAIN = 0.8;
/**
 * Redução do buffer do desfoque, por eixo. Com desvio de 8 px, a
 * gaussiana já zera o que passa de 1/8 ciclo por pixel (atenuação
 * exp(-2π²σ²f²) ≈ 3e-9 nessa frequência), que é exatamente o Nyquist
 * de um buffer a 1/4: nada visível se perde, e o buffer tem 1/16 dos
 * pixels da tela (464x262 a 1857x1048).
 */
export const AMBIENT_SCALE = 4;
/** Pares de amostras lineares por lado no kernel separável: 4 pares =
    até 8 texels de cada lado, 4 desvios a 1/4 (σ ≈ 1,9 texel). */
export const AMBIENT_PAIRS = 4;

/* ---------- tamanho do buffer ---------- */

/** Tamanho do buffer do desfoque: 1/scale da tela por eixo, arredondado
    para cima (a borda nunca fica sem texel), nunca zero. */
export function ambientBufferSize(w: number, h: number, scale = AMBIENT_SCALE): { w: number; h: number } {
  const s = Math.max(1, scale);
  return {
    w: Math.max(1, Math.ceil(Math.max(1, Math.round(w)) / s)),
    h: Math.max(1, Math.ceil(Math.max(1, Math.round(h)) / s)),
  };
}

/**
 * Desvio-padrão do kernel, em texels do buffer reduzido, para que a
 * cadeia inteira dê AMBIENT_BLUR_PX na tela. A redução (caixa de s x s,
 * variância (s²-1)/12 px²) e a ampliação bilinear (tenda de meia-largura
 * s, variância s²/6 px²) já borram um pouco: o kernel entra só com o
 * que falta. A 1/4: sqrt(64 - 1,25 - 2,67)/4 ≈ 1,94 texel.
 */
export function ambientSigma(scale: number, blurPx = AMBIENT_BLUR_PX): number {
  const s = Math.max(1, scale);
  const rest = blurPx * blurPx - (s * s - 1) / 12 - (s * s) / 6;
  return Math.sqrt(Math.max(0, rest)) / s;
}

/* ---------- kernel ---------- */

export interface GaussPairs {
  /** Peso da amostra central. */
  w0: number;
  /** Peso de cada par (um de cada lado). */
  w: [number, number, number, number];
  /** Deslocamento de cada par, em texels: cai entre os dois texels do
      par, e a amostragem linear devolve a soma ponderada dos dois. */
  o: [number, number, number, number];
}

/**
 * Gaussiana discreta de 2·2·AMBIENT_PAIRS + 1 texels em 1 + AMBIENT_PAIRS
 * leituras lineares por lado (o truque de amostragem bilinear: o par de
 * texels i, i+1 vira uma leitura no ponto ponderado entre eles). Pesos
 * normalizados: o desfoque não muda o brilho médio.
 */
export function gaussPairs(sigma: number): GaussPairs {
  const n = 2 * AMBIENT_PAIRS;
  const g = new Array<number>(n + 1);
  const s2 = 2 * Math.max(1e-3, sigma) ** 2;
  for (let i = 0; i <= n; i++) g[i] = Math.exp(-(i * i) / s2);
  let total = g[0];
  for (let i = 1; i <= n; i++) total += 2 * g[i];
  const w: GaussPairs["w"] = [0, 0, 0, 0];
  const o: GaussPairs["o"] = [0, 0, 0, 0];
  for (let k = 0; k < AMBIENT_PAIRS; k++) {
    const i1 = 2 * k + 1;
    const i2 = 2 * k + 2;
    const a = g[i1] / total;
    const b = g[i2] / total;
    w[k] = a + b;
    o[k] = a + b > 0 ? (i1 * a + i2 * b) / (a + b) : i1;
  }
  return { w0: g[0] / total, w, o };
}

/* ---------- transição focused <-> ambient ---------- */

/** cubic-bezier(x1, y1, x2, y2) do CSS: y no instante x (Newton com
    queda para bisseção). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-7) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const v = sx(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

/** --ease-out do app (extractor-lab.css): a curva do CSS antigo. */
export const easeOut = cubicBezier(0.16, 1, 0.3, 1);

export type BgMode = "focused" | "ambient";

/** Estado da troca de modo, integrado por dt na CPU (nunca relógio de
    parede vezes sinal). `value`: 0 = focused, 1 = ambient. */
export interface ModeTween {
  value: number;
  from: number;
  to: number;
  t: number;
  dur: number;
  started: boolean;
}

export function createModeTween(): ModeTween {
  return { value: 0, from: 0, to: 0, t: 0, dur: 0, started: false };
}

/**
 * Avança a troca de modo e devolve o valor (0..1).
 *  - O primeiro passo crava o modo pedido, sem rampa: o app que abre na
 *    Home já nasce desfocado (o motor nasce do preto de qualquer jeito).
 *  - Mudou o alvo no meio: recomeça do valor atual, com a duração
 *    proporcional ao caminho que falta (o encurtamento de reversão das
 *    transições CSS), então ir e voltar rápido não dá salto.
 *  - Curva: --ease-out; na versão calma, linear (só o fade).
 */
export function stepModeTween(s: ModeTween, target: number, dt: number, calm: boolean): number {
  const to = target > 0.5 ? 1 : 0;
  if (!s.started) {
    s.started = true;
    s.value = s.from = s.to = to;
    s.t = s.dur = 0;
    return s.value;
  }
  if (to !== s.to) {
    s.from = s.value;
    s.to = to;
    s.t = 0;
    s.dur = AMBIENT_MODE_S * Math.abs(to - s.from);
  }
  if (dt > 0) s.t += dt;
  const p = s.dur > 0 ? Math.min(1, s.t / s.dur) : 1;
  const e = calm ? p : easeOut(p);
  s.value = p >= 1 ? s.to : s.from + (s.to - s.from) * e;
  return s.value;
}

export interface AmbientLook {
  /** Quanto da imagem desfocada entra no lugar da nítida. */
  mix: number;
  /** Fração do desvio do desfoque (escala dos deslocamentos do kernel). */
  radius: number;
  /** Saturação (1 = intacta). */
  sat: number;
  /** Ganho em direção ao preto (1 = intacto). */
  gain: number;
}

/**
 * Aparência no valor `m` da troca (0 = focused, 1 = ambient). Normal: o
 * desfoque cresce junto da mistura (o foco "solta"). Versão calma: o
 * desfoque já entra inteiro e só a mistura anda, uma dissolução da imagem
 * nítida na desfocada, sem nada se mover.
 */
export function ambientLook(m: number, calm: boolean): AmbientLook {
  const v = m > 0 ? (m < 1 ? m : 1) : 0;
  return {
    mix: v,
    radius: calm ? 1 : v,
    sat: 1 - (1 - AMBIENT_SAT) * v,
    gain: 1 - (1 - AMBIENT_GAIN) * v,
  };
}
