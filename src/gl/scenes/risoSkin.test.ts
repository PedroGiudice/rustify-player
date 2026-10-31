/* ============================================================
   risoSkin.test.ts — a pele da Riso (pedido do CEO, 31/10/2026).

   O que se trava aqui:
     - a conta do campo com pele (a mesma do shader): sem pele é a soma
       de sempre; com pele cheia o par vira a união de dois círculos, sem
       a ponte de fusão;
     - a pele nasce quando duas manchas deixam de estar no mesmo pedaço,
       fica cheia SKIN_HOLD s e some até SKIN_LIFE s;
     - no sinal REAL gravado no app (fft-real-2609) com os ajustes do CEO,
       medido numa grade própria (80x45, mais fina que a da cena): tocando,
       nada volta a fundir em até 2 s depois de separar (antes: 35% das
       separações), o tempo num blob só cai, e parado o lava lamp continua
       (separações por minuto e blob único parecidos com os de antes).
   ============================================================ */

import { describe, it, expect } from "vitest";
import fx from "../__fixtures__/fft-real-2609.json";
import { decodeFixture, type FftFixture } from "../fftReplay";
import { createGlSignal, stepGlSignal, type GlCfg } from "../signal";
import { risoReaction } from "./riso";
import {
  ballFields, createRisoSkin, labelPieces, pairIndex, risoBalls, skinCut, skinnedField, skinOfAge, stepRisoSkin,
  RISO_FLUXO, RISO_N, RISO_PAIRS, RISO_ZOOM, SEAM_CUT, SKIN_ATTACK, SKIN_HOLD, SKIN_LIFE, SKIN_STEP_S,
} from "./risoSkin";

describe("Riso: conta do campo com pele", () => {
  it("os 10 pares têm índices distintos de 0 a 9, nos dois sentidos", () => {
    const seen = new Set<number>();
    for (let i = 0; i < RISO_N; i++)
      for (let j = i + 1; j < RISO_N; j++) {
        expect(pairIndex(i, j)).toBe(pairIndex(j, i));
        seen.add(pairIndex(i, j));
      }
    expect([...seen].sort((a, b) => a - b)).toEqual([...Array(RISO_PAIRS).keys()]);
  });

  it("sem pele é a soma; com pele cheia, no pescoço o par vira a união dos dois círculos", () => {
    const neck = [0.6, 0.6, 0.1, 0, 0];
    const none = new Float32Array(RISO_PAIRS);
    expect(skinnedField(neck, none)).toBeCloseTo(1.3);
    const one = new Float32Array(RISO_PAIRS);
    one[pairIndex(0, 1)] = 1;
    // 0,6 + 0,6 viraria ponte de tinta (1,3); com pele, 0,6 + 0,1 (papel)
    expect(skinnedField(neck, one)).toBeCloseTo(0.7);
  });

  it("onde uma mancha domina, a pele quase não tira nada (as manchas não encolhem)", () => {
    expect(skinCut(2, 0.2)).toBeLessThan(0.01 * 0.2 + 1e-9);
    expect(skinCut(0.2, 2)).toBeCloseTo(skinCut(2, 0.2));
    expect(skinCut(0.6, 0.6)).toBeCloseTo(0.6);
  });

  it("nunca fica abaixo da maior mancha (dentro de um círculo é sempre tinta)", () => {
    const all = new Float32Array(RISO_PAIRS).fill(1);
    expect(skinnedField([1.2, 1.2, 1.2, 1.2, 1.2], all)).toBeCloseTo(1.2);
  });

  it("idade: cheia até SKIN_HOLD, some em S, zero em SKIN_LIFE", () => {
    expect(skinOfAge(0)).toBe(1);
    expect(skinOfAge(SKIN_HOLD)).toBe(1);
    expect(skinOfAge((SKIN_HOLD + SKIN_LIFE) / 2)).toBeCloseTo(0.5);
    expect(skinOfAge(SKIN_LIFE)).toBe(0);
    expect(skinOfAge(Infinity)).toBe(0);
    let prev = 1;
    for (let a = 0; a < SKIN_LIFE; a += 0.25) {
      expect(skinOfAge(a)).toBeLessThanOrEqual(prev);
      prev = skinOfAge(a);
    }
  });
});

describe("Riso: a pele nasce na separação", () => {
  it("a grade cabe no rascunho em paisagem e em retrato (o S24 usa o mesmo motor)", () => {
    const b = risoBalls(1.3, 0.46, 1, new Float32Array(15));
    const out = new Int32Array(RISO_N);
    for (const asp of [0.46, 1, 16 / 9, 3]) {
      const st = createRisoSkin();
      labelPieces(st, risoBalls(1.3, asp, 1, b), asp, new Float32Array(RISO_PAIRS), out);
      for (let i = 0; i < RISO_N; i++) expect(out[i], `aspecto ${asp}, mancha ${i}`).toBeGreaterThan(0);
    }
  });

  // Duas manchas grandes que se afastam; as outras três longe, num canto.
  const scene = (gap: number) => {
    const b = new Float32Array(15);
    const put = (i: number, x: number, y: number, r: number) => b.set([x, y, r], 3 * i);
    put(0, -gap / 2, 0, 0.17);
    put(1, gap / 2, 0, 0.17);
    put(2, 0.75, 0.4, 0.05);
    put(3, -0.75, 0.4, 0.05);
    put(4, 0.75, -0.4, 0.05);
    return b;
  };

  it("juntas não há pele; ao se separarem a pele sobe, segura o reencosto e some sozinha", () => {
    const st = createRisoSkin();
    const run = (gap: number, secs: number) => {
      for (let t = 0; t < secs; t += SKIN_STEP_S) stepRisoSkin(st, scene(gap), 16 / 9, SKIN_STEP_S);
    };
    run(0.3, 0.5);
    expect(st.skin[pairIndex(0, 1)]).toBe(0);
    expect(st.comp[0]).toBe(st.comp[1]);
    // separam: a pele sobe em SKIN_ATTACK s, sem saltar
    run(0.6, SKIN_STEP_S);
    expect(st.comp[0]).not.toBe(st.comp[1]);
    run(0.6, SKIN_STEP_S);
    expect(st.skin[pairIndex(0, 1)]).toBeGreaterThan(0);
    expect(st.skin[pairIndex(0, 1)]).toBeLessThan(0.1);
    run(0.6, SKIN_ATTACK);
    expect(st.skin[pairIndex(0, 1)]).toBe(1);
    // as que nunca estiveram juntas não ganham pele
    expect(st.skin[pairIndex(2, 3)]).toBe(0);
    // reencostar com a pele cheia não funde: encostam com costura
    run(0.3, 1);
    expect(st.comp[0]).not.toBe(st.comp[1]);
    // e quando ela some, fundem de novo (o lava lamp volta)
    run(0.3, SKIN_LIFE);
    expect(st.skin[pairIndex(0, 1)]).toBe(0);
    expect(st.comp[0]).toBe(st.comp[1]);
  });
});

/* ---------- replay do sinal real ---------- */

/** Ajustes do Tweaks do CEO lidos no app em 30/10/2026. */
const CEO_3010: GlCfg = {
  bassGain: 0.35, midGain: 0.05, trebleGain: 0.1, smoothing: 1, speed: 0.15, beatMode: "pulse", beatDepth: 0.7,
};
const ASP = 16 / 9;
const MW = 80, MH = 45;
const mInk = new Uint8Array(MW * MH), mDom = new Int8Array(MW * MH), mLab = new Int32Array(MW * MH);
const mStack = new Int32Array(MW * MH), mF = new Float64Array(RISO_N);

/** Pedaços visíveis numa grade própria: tinta = campo com pele > 1; duas
    células de manchas dominantes diferentes com pele > 0,5 ficam
    separadas pela costura. Independe da grade que a cena usa. */
function countPieces(balls: Float32Array, skin: ArrayLike<number>): number {
  const ink = mInk, dom = mDom, lab = mLab, f = mF;
  lab.fill(0);
  for (let j = 0; j < MH; j++)
    for (let i = 0; i < MW; i++) {
      const c = j * MW + i;
      ballFields(balls, ((i + 0.5) / MW - 0.5) * ASP * RISO_ZOOM, ((j + 0.5) / MH - 0.5) * RISO_ZOOM, f);
      ink[c] = skinnedField(f, skin) > 1 ? 1 : 0;
      let a = 0;
      for (let q = 1; q < RISO_N; q++) if (f[q] > f[a]) a = q;
      dom[c] = a;
    }
  let n = 0;
  for (let c0 = 0; c0 < MW * MH; c0++) {
    if (!ink[c0] || lab[c0]) continue;
    lab[c0] = ++n;
    let sp = 0;
    mStack[sp++] = c0;
    while (sp) {
      const c = mStack[--sp];
      const ci = c % MW;
      for (let d = 0; d < 4; d++) {
        const q = d === 0 ? (ci + 1 < MW ? c + 1 : -1) : d === 1 ? (ci > 0 ? c - 1 : -1) : d === 2 ? c + MW : c - MW;
        if (q < 0 || q >= MW * MH || !ink[q] || lab[q]) continue;
        if (dom[q] !== dom[c] && skin[pairIndex(dom[q], dom[c])] > SEAM_CUT) continue;
        lab[q] = n;
        mStack[sp++] = q;
      }
    }
  }
  return n;
}

interface Run { oneBlob: number; splitsPerMin: number; quickRefuse: number; quickShare: number }

/** Replay inteiro; a pele anda a ~20 quadros/s (como na cena), a
    medição a ~5/s. `playing` = escala do grave como no app; parado =
    escala 1 (nada tocando, o relógio segue andando). */
function run(playing: boolean, withSkin: boolean): Run {
  const replay = decodeFixture(fx as unknown as FftFixture);
  const s = createGlSignal();
  const raw = { low: 0, mid: 0, high: 0 };
  const sk = createRisoSkin();
  const zero = new Float32Array(RISO_PAIRS);
  const balls = new Float32Array(15);
  let secs = 0, stepAcc = 0, measAcc = 0, prevN = -1, splits = 0, quick = 0, frames = 0, one = 0;
  const pending: number[] = [];
  for (let i = 0; i < replay.n; i++) {
    raw.low = replay.v[3 * i];
    raw.mid = replay.v[3 * i + 1];
    raw.high = replay.v[3 * i + 2];
    stepGlSignal(s, replay.dt[i], true, raw, CEO_3010);
    secs += replay.dt[i];
    stepAcc += replay.dt[i];
    measAcc += replay.dt[i];
    if (stepAcc < SKIN_STEP_S) continue;
    risoBalls(s.clock * RISO_FLUXO, ASP, playing ? risoReaction(s).scale : 1, balls);
    if (withSkin) stepRisoSkin(sk, balls, ASP, stepAcc);
    stepAcc = 0;
    if (measAcc < 0.2) continue;
    measAcc = 0;
    const n = countPieces(balls, withSkin ? sk.skin : zero);
    frames++;
    if (n <= 1) one++;
    if (prevN >= 0 && n > prevN) for (let k = 0; k < n - prevN; k++) { splits++; pending.push(secs); }
    if (prevN >= 0 && n < prevN)
      for (let k = 0; k < prevN - n; k++) {
        const t0 = pending.shift();
        if (t0 !== undefined && secs - t0 <= 2) quick++;
      }
    while (pending.length && secs - pending[0] > 2) pending.shift();
    prevN = n;
  }
  return {
    oneBlob: one / frames,
    splitsPerMin: (splits / secs) * 60,
    quickRefuse: (quick / secs) * 60,
    quickShare: quick / Math.max(1, splits),
  };
}

describe("Riso: pele no sinal real (fft-real-2609, ajustes do CEO de 30/10)", () => {
  const T = 120_000;
  const before = { playing: run(true, false), still: run(false, false) };
  const after = { playing: run(true, true), still: run(false, true) };

  it("linha de base: tocando, um terço das separações voltava a fundir em até 2 s", () => {
    expect(before.playing.quickShare).toBeGreaterThan(0.25);
    expect(before.still.quickRefuse).toBe(0);
  }, T);

  it("tocando: nada volta a fundir em até 2 s, e o tempo num blob só cai", () => {
    expect(after.playing.quickRefuse).toBeLessThan(0.1);
    expect(after.playing.oneBlob).toBeLessThan(before.playing.oneBlob - 0.03);
  }, T);

  it("parado: o lava lamp continua (separa e funde no mesmo ritmo, sem colar de vez)", () => {
    expect(after.still.splitsPerMin).toBeGreaterThan(before.still.splitsPerMin * 0.8);
    expect(after.still.quickRefuse).toBeLessThan(0.1);
    expect(Math.abs(after.still.oneBlob - before.still.oneBlob)).toBeLessThan(0.05);
  }, T);
});
