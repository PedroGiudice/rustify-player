/* ============================================================
   paintRiso.test.ts — Tinta e Riso (11/10, esboços aprovados no
   Fizzle e portados).

   O que se trava aqui:
     - a reação é RELATIVA à faixa (swell/pulse/midLift), neutra com
       o sinal em repouso e limitada com o sinal fora da faixa;
     - o contador de kicks da Riso conta borda de subida com histerese
       (um kick longo não conta duas vezes);
     - ciclo de vida com GL falso: desenha um triângulo de tela cheia,
       não aloca nada por quadro e o dispose apaga tudo.
   ============================================================ */

import { describe, it, expect } from "vitest";
import { createGlSignal, type GlSignal } from "../signal";
import type { SceneCtx, ScenePalette } from "../scene";
import { makeFakeGl, type FakeGl } from "../__fixtures__/fakeGl";
import { paint, paintReaction } from "./paint";
import { riso, risoReaction, stepKickCount, type KickCount } from "./riso";
import { SCENE_KEYS } from "../meta";
import { SCENES } from "../registry";

const f3 = (r: number, g: number, b: number) => new Float32Array([r, g, b]);
const PAL: ScenePalette = { canvas: f3(0, 0, 0), ink: f3(1, 0, 0), ink2: f3(0, 1, 0), soft: f3(0, 0, 1) };
const sig = (o: Partial<GlSignal> = {}): GlSignal => ({ ...createGlSignal(), clock: 3.2, ...o });

describe("Tinta: reação", () => {
  it("repouso é neutro: sem mexer a mais, sem inchar, relevo e veios no tamanho de base", () => {
    expect(paintReaction(sig())).toEqual({ stir: 1, pump: 0, zoneLow: 0, zoneMid: 0, zoneHigh: 0, sparkle: 0, lift: 1, vein: 1, flash: 0 });
  });

  it("zonas: grave move o escuro, médios o meio, agudos o claro; kick incha tudo, levanta o relevo e acende o reflexo", () => {
    const r = paintReaction(sig({ swell: 1, pulse: 1, midLift: 1, highLift: 1 }));
    expect(r.stir).toBeCloseTo(1.3);
    expect(r.pump).toBeCloseTo(0.12);
    expect(r.zoneLow).toBeCloseTo(0.08);
    expect(r.zoneMid).toBeCloseTo(0.07);
    expect(r.zoneHigh).toBeCloseTo(0.06);
    expect(r.sparkle).toBeCloseTo(1);
    expect(r.lift).toBeCloseTo(2.2);
    expect(r.flash).toBeCloseTo(1);
    expect(r.vein).toBeCloseTo(2);
  });

  it("lê só o relativo: grave absoluto alto e parado não move nada", () => {
    expect(paintReaction(sig({ low: 1, mid: 1, high: 1, beat: 1, level: 1 }))).toEqual({ stir: 1, pump: 0, zoneLow: 0, zoneMid: 0, zoneHigh: 0, sparkle: 0, lift: 1, vein: 1, flash: 0 });
  });

  it("sinal fora de 0..1 é limitado", () => {
    expect(paintReaction(sig({ swell: 5, pulse: -2, midLift: 9, highLift: 3 }))).toEqual(paintReaction(sig({ swell: 1, midLift: 1, highLift: 1 })));
  });
});

describe("Riso: reação e contador de kicks", () => {
  it("repouso é neutro", () => {
    expect(risoReaction(sig())).toEqual({ scale: 1, shift: 0, core: 0 });
  });

  it("graves crescem as manchas, kick desalinha a segunda cor, médios engordam o miolo", () => {
    const r = risoReaction(sig({ swell: 1, pulse: 1, midLift: 1 }));
    expect(r.scale).toBeCloseTo(1.15);
    expect(r.shift).toBeCloseTo(0.035);
    expect(r.core).toBeCloseTo(0.3);
  });

  it("conta a borda de subida do pulso, com histerese", () => {
    let k: KickCount = { n: 0, armed: true };
    // kick longo (fica alto 4 quadros), desce no meio-termo, sobe de novo
    // sem rearmar, desce abaixo do piso, e um segundo kick.
    for (const p of [0, 0.7, 0.9, 0.8, 0.6, 0.4, 0.7, 0.1, 0.0, 0.8, 0.3]) k = stepKickCount(k, p);
    expect(k.n).toBe(2);
  });

  it("o contador dá a volta sem perder precisão no float do uniform", () => {
    let k: KickCount = { n: 999, armed: true };
    k = stepKickCount(k, 1);
    expect(k.n).toBe(0);
  });
});

describe("Tinta e Riso: registro e ciclo de vida", () => {
  const ctxOf = (fake: FakeGl, draws: { n: number }): SceneCtx => ({
    gl: fake.gl,
    caps: { colorBufferFloat: false, maxPointSize: 64 },
    bindOutput: () => {},
    fullscreen: () => {
      draws.n++;
    },
  });
  const creates = (fake: FakeGl) => fake.calls.filter((c) => c[0].startsWith("create")).length;

  it("as duas estão nos dois registros, depois das quatro de antes", () => {
    expect(SCENE_KEYS).toEqual(["dust", "relief", "orbits", "nebula", "paint", "riso"]);
    expect(SCENES.paint).toBe(paint);
    expect(SCENES.riso).toBe(riso);
  });

  for (const def of [paint, riso]) {
    it(`${def.key}: resolução cheia, um triângulo por quadro, sem alocar por quadro, dispose zera`, () => {
      expect(def.maxRows).toBeUndefined();
      const fake = makeFakeGl();
      const draws = { n: 0 };
      const s = def.create(ctxOf(fake, draws));
      s.resize(1857, 1048);
      s.frame(sig({ swell: 0.5, pulse: 0.8, midLift: 0.3 }), PAL, 1 / 60, 1857, 1048);
      const after1 = creates(fake);
      for (let i = 0; i < 30; i++) s.frame(sig({ clock: 3.2 + i / 60, pulse: i % 2 }), PAL, 1 / 60, 1857, 1048);
      expect(creates(fake)).toBe(after1);
      expect(draws.n).toBe(31);
      s.dispose();
      expect([...fake.live]).toEqual([]);
    });
  }
});

describe("Tinta: cada banda mexe só a sua zona", () => {
  it("grave só zoneLow, médios só zoneMid, agudos só zoneHigh", () => {
    const only = (o: Partial<GlSignal>) => {
      const r = paintReaction(sig(o));
      return [r.zoneLow > 0, r.zoneMid > 0, r.zoneHigh > 0];
    };
    expect(only({ swell: 1 })).toEqual([true, false, false]);
    expect(only({ midLift: 1 })).toEqual([false, true, false]);
    expect(only({ highLift: 1 })).toEqual([false, false, true]);
    expect(only({ pulse: 1 })).toEqual([false, false, false]);
  });
});
