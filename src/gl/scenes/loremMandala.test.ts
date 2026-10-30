/* ============================================================
   loremMandala.test.ts — a parte pura das cenas Lorem e Mandala.

   Lorem: o atlas asêmico é determinístico e todo glifo tem tinta
   dentro da célula; as ondas nascem no kick (borda de subida, uma
   por batida), envelhecem pelo relógio virtual e morrem; a névoa é
   integrada (CMR-267). Mandala: zoom e giro integrados, kick dá
   impulso que amortece.
   ============================================================ */

import { describe, it, expect } from "vitest";
import {
  ATLAS_COLS, ATLAS_H, ATLAS_W, GLYPH_COUNT, GLYPH_H, GLYPH_W, glyphInk, glyphStrokes, makeGlyphAtlas, rng,
} from "../glyphAtlas";
import {
  LOREM_WAVES, WAVE_LIFE, WAVE_SPEED, WAVE_TAU, createLoremState, packLoremWaves, stepLoremWaves,
} from "./lorem";
import { SPIN_KICK, ZOOM_BASE, ZOOM_SWELL, createMandalaMotion, stepMandala } from "./mandala";
import { createGlSignal } from "../signal";

describe("Lorem: atlas asêmico", () => {
  it("é determinístico e tem o tamanho da grade", () => {
    const a = makeGlyphAtlas();
    expect(a.length).toBe(ATLAS_W * ATLAS_H);
    expect(ATLAS_W).toBe(GLYPH_W * ATLAS_COLS);
    expect(Array.from(makeGlyphAtlas())).toEqual(Array.from(a));
    expect(Array.from(makeGlyphAtlas(7))).not.toEqual(Array.from(a));
  });

  it("todo glifo tem tinta, nenhum é um borrão, e os glifos são distintos", () => {
    const a = makeGlyphAtlas();
    const seen = new Set<string>();
    for (let i = 0; i < GLYPH_COUNT; i++) {
      const ink = glyphInk(a, i);
      expect(ink).toBeGreaterThan(0.04);
      expect(ink).toBeLessThan(0.45);
      const col = i % ATLAS_COLS, row = Math.floor(i / ATLAS_COLS);
      const bytes: number[] = [];
      for (let y = 0; y < GLYPH_H; y++) for (let x = 0; x < GLYPH_W; x++) bytes.push(a[(row * GLYPH_H + y) * ATLAS_W + col * GLYPH_W + x]);
      seen.add(bytes.join(","));
    }
    expect(seen.size).toBeGreaterThan(GLYPH_COUNT * 0.8);
  });

  it("traços ficam dentro da célula", () => {
    const rnd = rng(3);
    for (let i = 0; i < 200; i++) {
      for (const s of glyphStrokes(rnd)) {
        if (s.k === "seg") {
          for (const v of [s.x0, s.x1]) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(GLYPH_W);
          for (const v of [s.y0, s.y1]) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(GLYPH_H);
        } else {
          expect(s.cx - s.r).toBeGreaterThanOrEqual(0);
          expect(s.cx + s.r).toBeLessThanOrEqual(GLYPH_W);
        }
      }
    }
  });
});

describe("Lorem: ondas", () => {
  // O kick é detectado no onset (sem depth) e a força vem do pulse; aqui depth 1.
  const sig = (pulse: number, midRel = 0) => ({ ...createGlSignal(), pulse, onset: pulse, midRel });

  it("um kick (borda de subida com histerese) abre UMA onda, com origem dentro da tela", () => {
    const st = createLoremState();
    const seq = [0.1, 0.9];
    let i = 0;
    const rnd = () => seq[i++ % 2];
    stepLoremWaves(st, sig(0.8), 1 / 60, 1.77, rnd);
    stepLoremWaves(st, sig(0.9), 1 / 60, 1.77, rnd);
    stepLoremWaves(st, sig(0.6), 1 / 60, 1.77, rnd);
    const live = st.waves.filter((w) => w.age >= 0);
    expect(live.length).toBe(1);
    expect(Math.abs(live[0].x)).toBeLessThanOrEqual(1.77 * 0.45);
    expect(Math.abs(live[0].y)).toBeLessThanOrEqual(0.45);
    expect(live[0].amp).toBeCloseTo(0.6 + 0.4 * 0.8, 9);
    // rearma abaixo de 0,2 e conta de novo
    stepLoremWaves(st, sig(0.1), 1 / 60, 1.77, rnd);
    stepLoremWaves(st, sig(0.8), 1 / 60, 1.77, rnd);
    expect(st.waves.filter((w) => w.age >= 0).length).toBe(2);
  });

  it("raio cresce com o relógio virtual, amplitude apaga, a onda morre depois de WAVE_LIFE", () => {
    const st = createLoremState();
    stepLoremWaves(st, sig(0.9), 1 / 60, 1.77, () => 0.5);
    const out = new Float32Array(LOREM_WAVES * 4);
    for (let f = 0; f < 60; f++) stepLoremWaves(st, sig(0), 1 / 60, 1.77);
    packLoremWaves(st, out);
    expect(out[2]).toBeCloseTo(WAVE_SPEED * 1, 5);
    expect(out[3]).toBeCloseTo(st.waves[0].amp * Math.exp(-1 / WAVE_TAU), 5);
    for (let f = 0; f < WAVE_LIFE * 60 + 5; f++) stepLoremWaves(st, sig(0), 1 / 60, 1.77);
    packLoremWaves(st, out);
    expect(out[2]).toBe(-1);
    expect(out[3]).toBe(0);
  });

  it("salto de relógio (volta do background) não teleporta: dt é limitado", () => {
    const st = createLoremState();
    stepLoremWaves(st, sig(0.9), 1 / 60, 1.77, () => 0.5);
    stepLoremWaves(st, sig(0), 13, 1.77);
    expect(st.waves[0].age).toBeCloseTo(0.1, 9);
    expect(st.mistX).toBeLessThan(0.01);
  });

  it("com 8 ondas vivas, o 9º kick recicla a mais velha", () => {
    const st = createLoremState();
    for (let k = 0; k < LOREM_WAVES + 1; k++) {
      stepLoremWaves(st, sig(0.9), 1 / 60, 1.77, () => 0.3);
      for (let f = 0; f < 10; f++) stepLoremWaves(st, sig(0), 1 / 60, 1.77);
    }
    const ages = st.waves.map((w) => w.age);
    expect(ages.every((a) => a >= 0)).toBe(true);
    expect(Math.max(...ages)).toBeLessThan((LOREM_WAVES * 11) / 60 + 1e-6);
  });

  it("névoa: médios mudam a VELOCIDADE da deriva; a posição acumula", () => {
    const a = createLoremState();
    const b = createLoremState();
    for (let f = 0; f < 600; f++) stepLoremWaves(a, sig(0, 0), 1 / 60, 1.77);
    for (let f = 0; f < 600; f++) stepLoremWaves(b, sig(0, 1), 1 / 60, 1.77);
    expect(a.mistX).toBeGreaterThan(0);
    expect(b.mistX / a.mistX).toBeCloseTo(1.8, 6);
  });
});

describe("Mandala: movimento", () => {
  it("zoom integra base + grave; não depende do tempo de sessão", () => {
    const m = createMandalaMotion();
    const calm = { ...createGlSignal(), swell: 0 };
    const loud = { ...createGlSignal(), swell: 1 };
    for (let f = 0; f < 36000; f++) stepMandala(m, calm, 1 / 60);
    const z0 = m.zoom;
    stepMandala(m, loud, 1 / 60);
    expect(m.zoom - z0).toBeCloseTo((ZOOM_BASE + ZOOM_SWELL) / 60, 9);
  });

  it("kick dá UM impulso angular que amortece; sem kick o giro para", () => {
    const m = createMandalaMotion();
    stepMandala(m, { ...createGlSignal(), pulse: 1, onset: 1 }, 1 / 60);
    const s0 = m.spin;
    expect(s0).toBeGreaterThan(0);
    expect(s0).toBeLessThanOrEqual(SPIN_KICK);
    stepMandala(m, { ...createGlSignal(), pulse: 1, onset: 1 }, 1 / 60); // mesmo kick, não conta de novo
    expect(m.spin).toBeLessThan(s0);
    for (let f = 0; f < 600; f++) stepMandala(m, createGlSignal(), 1 / 60);
    expect(m.spin).toBeLessThan(1e-4);
    expect(m.rot).toBeGreaterThan(0);
    const r = m.rot;
    stepMandala(m, createGlSignal(), 1 / 60);
    expect(m.rot - r).toBeLessThan(1e-5);
  });
});
