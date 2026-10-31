/* ============================================================
   scenes/risoSkin.ts — a "pele" da Riso (pedido do CEO, 31/10/2026).

   Tocando, a Riso condensava num blob grande: o grave infla as cinco
   manchas (uScale) e recola na hora o pedaço que acabou de se soltar.
   Medido no replay real (fft-real-2609, ajustes do CEO): 35% das
   separações voltavam a fundir em até 2 s; parado, 0%.

   A pele: quando duas manchas deixam de estar no mesmo pedaço, o par
   ganha uma pele que dura alguns segundos. Enquanto ela existe, o campo
   do par deixa de somar (sem a ponte de fusão): as duas manchas se
   encostam como dois círculos, e o shader risca uma costura fina onde
   elas se tocam. A pele some devagar e a fusão volta, para não perder o
   lava lamp.

   Tudo aqui é puro (sem GL): os centros são analíticos, então a CPU sabe
   o campo inteiro e decide a pele por par; o shader só a recebe.
   ============================================================ */

/** Número de manchas e de pares (5 escolhe 2). */
export const RISO_N = 5;
export const RISO_PAIRS = 10;

/** Velocidade das manchas no relógio virtual (t = clock * FLUXO). */
export const RISO_FLUXO = 0.35;
/** Recuo de câmera (31/10, pedido do CEO: "perto demais"): a tela mostra
    2 % a mais do campo. O shader e a grade da CPU usam o mesmo valor. */
export const RISO_ZOOM = 1.02;

/** A pele sobe de 0 a cheia neste tempo (s): ligar de uma vez tira num
    quadro a soma que o vizinho fazia, e as duas manchas encolhem num
    salto. Subindo, elas se arredondam. */
export const SKIN_ATTACK = 2;
/** Pele cheia até este tempo depois da separação (s, tempo real)... */
export const SKIN_HOLD = 6;
/** ...e some até aqui (s). Real, não virtual: o que recola é o grave. */
export const SKIN_LIFE = 12;
/** Grade da CPU que acha os pedaços: células no lado MAIOR da tela (o
    outro segue o aspecto, paisagem ou retrato). ~0,03 da altura por célula
    em paisagem: pega pescoço de 2 % da tela. */
export const GRID_W = 64;
/** A cena acha os pedaços a ~20 quadros/s (0,15 ms em média no JSC,
    0,44 ms por passo), não a cada quadro: o grave muda a escala devagar. */
export const SKIN_STEP_S = 0.05;
/** Abaixo disto a pele já não separa duas células vizinhas: o par volta a
    contar como um pedaço só (a costura mal se vê). */
export const SEAM_CUT = 0.5;

/** Índice do par (i < j) no vetor de 10. */
export function pairIndex(i: number, j: number): number {
  if (i > j) [i, j] = [j, i];
  // 0-1 0, 0-2 1, 0-3 2, 0-4 3, 1-2 4, 1-3 5, 1-4 6, 2-3 7, 2-4 8, 3-4 9
  return i * RISO_N - (i * (i + 1)) / 2 + (j - i - 1);
}

/**
 * Centros e raios das 5 manchas (x, y, r) em `out` (15 floats), nas
 * coordenadas do shader: y em -0,5..0,5, x em -asp/2..asp/2.
 */
export function risoBalls(t: number, asp: number, esc: number, out: Float32Array): Float32Array {
  for (let i = 0; i < RISO_N; i++) {
    out[3 * i] = Math.sin(t * (0.31 + 0.07 * i) + i * 2.1) * 0.4 * asp;
    out[3 * i + 1] = Math.cos(t * (0.23 + 0.05 * i) + i * 1.3) * 0.26;
    out[3 * i + 2] = (0.17 + 0.05 * (i % 3)) * esc;
  }
  return out;
}

/** Contribuição de cada mancha num ponto, em `f` (5). */
export function ballFields(balls: Float32Array, x: number, y: number, f: Float64Array): void {
  for (let i = 0; i < RISO_N; i++) {
    const dx = x - balls[3 * i], dy = y - balls[3 * i + 1], r = balls[3 * i + 2];
    f[i] = (r * r) / Math.max(dx * dx + dy * dy, 1e-4);
  }
}

/**
 * O que a pele cheia tira do par num ponto: min·(min/max)². Onde as duas
 * manchas pesam igual (o pescoço) tira o vizinho inteiro, e ali o par vira
 * a união de dois círculos, sem ponte; onde uma domina, quase nada. Tirar
 * min puro (sem o fator) cortava a soma do vizinho na mancha inteira, e as
 * duas encolhiam num salto ao se separar (replay, 31/10: até 3 pontos da
 * tela em 50 ms parado, contra 0,4 sem pele).
 */
export function skinCut(a: number, b: number): number {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  if (!(hi > 0)) return 0;
  const r = lo / hi;
  return lo * r * r;
}

/**
 * Campo com pele (a mesma conta do shader): a soma de sempre menos, para
 * cada par com pele s, s·skinCut(f_i, f_j); nunca abaixo da maior mancha.
 */
export function skinnedField(f: ArrayLike<number>, skin: ArrayLike<number>): number {
  let sum = 0, mx = 0;
  for (let i = 0; i < RISO_N; i++) {
    sum += f[i];
    if (f[i] > mx) mx = f[i];
  }
  let k = 0;
  for (let i = 0; i < RISO_N; i++)
    for (let j = i + 1; j < RISO_N; j++, k++) {
      if (!(skin[k] > 0)) continue;
      sum -= skin[k] * skinCut(f[i], f[j]);
    }
  return Math.max(sum, mx);
}

/** Teto da pele pela idade (s desde a separação): 1 até SKIN_HOLD, some
    em S até SKIN_LIFE. A subida (SKIN_ATTACK) é aplicada no passo. */
export function skinOfAge(age: number, hold = SKIN_HOLD, life = SKIN_LIFE): number {
  if (!(age < life)) return 0;
  if (age <= hold) return 1;
  const x = (age - hold) / (life - hold);
  return 1 - x * x * (3 - 2 * x);
}

export interface RisoSkin {
  /** Idade da pele de cada par (s); Infinity = sem pele. */
  age: Float64Array;
  /** Pedaço de cada mancha no quadro anterior (-1 = ainda sem quadro). */
  comp: Int32Array;
  /** Força atual da pele por par, 0..1 (o que vai para o shader). */
  skin: Float32Array;
  /** Rascunho da grade (tinta, mancha dominante, rótulo, pilha) e dos
      campos e pedaços do passo. */
  ink: Uint8Array;
  dom: Int8Array;
  lab: Int32Array;
  stack: Int32Array;
  f: Float64Array;
  compNow: Int32Array;
}

const MAX_CELLS = GRID_W * GRID_W;

export function createRisoSkin(): RisoSkin {
  return {
    age: new Float64Array(RISO_PAIRS).fill(Infinity),
    comp: new Int32Array(RISO_N).fill(-1),
    skin: new Float32Array(RISO_PAIRS),
    ink: new Uint8Array(MAX_CELLS),
    dom: new Int8Array(MAX_CELLS),
    lab: new Int32Array(MAX_CELLS),
    stack: new Int32Array(MAX_CELLS),
    f: new Float64Array(RISO_N),
    compNow: new Int32Array(RISO_N),
  };
}

/**
 * Rotula os pedaços de tinta numa grade, como o shader desenha: célula
 * com tinta = campo com pele acima de 1; duas vizinhas de manchas
 * dominantes diferentes não se ligam se a pele do par passa de SEAM_CUT
 * (é a costura). Grava em `out` o rótulo do pedaço de cada mancha (o da
 * célula do seu centro). Devolve quantos pedaços há. Não aloca.
 */
export function labelPieces(
  st: RisoSkin, balls: Float32Array, asp: number, skin: ArrayLike<number>, out: Int32Array,
): number {
  const gw = asp >= 1 ? GRID_W : Math.max(1, Math.round(GRID_W * asp));
  const gh = asp >= 1 ? Math.max(1, Math.round(GRID_W / asp)) : GRID_W;
  const n = gw * gh;
  const { ink, dom, lab, stack, f: fTmp } = st;
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const c = j * gw + i;
      ballFields(balls, ((i + 0.5) / gw - 0.5) * asp * RISO_ZOOM, ((j + 0.5) / gh - 0.5) * RISO_ZOOM, fTmp);
      ink[c] = skinnedField(fTmp, skin) > 1 ? 1 : 0;
      let a = 0;
      for (let q = 1; q < RISO_N; q++) if (fTmp[q] > fTmp[a]) a = q;
      dom[c] = a;
    }
  lab.fill(0, 0, n);
  let pieces = 0;
  for (let c0 = 0; c0 < n; c0++) {
    if (!ink[c0] || lab[c0]) continue;
    lab[c0] = ++pieces;
    let sp = 0;
    stack[sp++] = c0;
    while (sp) {
      const c = stack[--sp];
      const ci = c % gw;
      for (let d = 0; d < 4; d++) {
        let q: number;
        if (d === 0) { if (ci + 1 >= gw) continue; q = c + 1; }
        else if (d === 1) { if (ci === 0) continue; q = c - 1; }
        else if (d === 2) { q = c + gw; if (q >= n) continue; }
        else { q = c - gw; if (q < 0) continue; }
        if (!ink[q] || lab[q]) continue;
        if (dom[q] !== dom[c] && skin[pairIndex(dom[q], dom[c])] > SEAM_CUT) continue;
        lab[q] = pieces;
        stack[sp++] = q;
      }
    }
  }
  for (let b = 0; b < RISO_N; b++) {
    const ci = Math.min(gw - 1, Math.max(0, Math.floor((balls[3 * b] / (asp * RISO_ZOOM) + 0.5) * gw)));
    const cj = Math.min(gh - 1, Math.max(0, Math.floor((balls[3 * b + 1] / RISO_ZOOM + 0.5) * gh)));
    out[b] = lab[cj * gw + ci];
  }
  return pieces;
}

/**
 * Um quadro: envelhece as peles, acha os pedaços (com a pele como está
 * desenhada) e liga a pele dos pares que estavam no mesmo pedaço e
 * deixaram de estar. `dt` em segundos reais. Não aloca.
 *
 * A histerese vem da própria pele: o pescoço que acabou de se romper não
 * se refaz enquanto ela dura, então um pescoço no limiar não pisca.
 */
export function stepRisoSkin(
  st: RisoSkin, balls: Float32Array, asp: number, dt: number, hold = SKIN_HOLD, life = SKIN_LIFE,
): void {
  for (let k = 0; k < RISO_PAIRS; k++) {
    st.age[k] += dt;
    const cap = skinOfAge(st.age[k], hold, life);
    st.skin[k] = st.age[k] < hold ? Math.min(cap, st.skin[k] + dt / SKIN_ATTACK) : Math.min(cap, st.skin[k]);
  }
  const compNow = st.compNow;
  labelPieces(st, balls, asp, st.skin, compNow);
  let k = 0;
  for (let i = 0; i < RISO_N; i++)
    for (let j = i + 1; j < RISO_N; j++, k++) {
      const was = st.comp[i] > 0 && st.comp[i] === st.comp[j];
      // nova separação: a idade zera e a pele sobe a partir de onde estava
      if (was && compNow[i] !== compNow[j]) st.age[k] = 0;
    }
  st.comp.set(compNow);
}
