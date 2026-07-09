/* ============================================================
   shapes.test.ts — Sanidade numérica dos 23 shapes.

   Cada shape deve retornar número finito (sem NaN) em qualquer
   amostra de (u,v,t), inclusive bordas e t grande — o campo é
   consumido cru pelos renderers a cada frame.
   ============================================================ */

import { describe, it, expect } from "vitest";
import { SHAPES } from "./shapes";

// Ordem canônica do handoff — o índice persiste em localStorage,
// então reordenar quebra a seleção salva do usuário. Os 5 novos
// (família gerativa / Field Explorer, handoff 2026-07-09) entram
// APÓS os 18 existentes pelo mesmo motivo.
const EXPECTED_ORDER = [
  "cordillera", "nebula", "horizon", "twin peaks", "vortex", "ember",
  "wavefront", "aurora", "ripple", "dunes", "lattice", "comet", "tide",
  "sonar", "pond", "whirlpool", "shock", "radar",
  "interference", "spiral", "turbulence", "cells", "warp",
];

const US = [0, 0.25, 0.5, 0.75, 1];
const VS = [0, 0.25, 0.5, 0.75, 1];
const TS = [0, 0.3, 1.7, 12.3, 100, 3600];

describe("SHAPES", () => {
  it("tem 23 shapes na ordem do handoff", () => {
    expect(SHAPES.map((s) => s.name)).toEqual(EXPECTED_ORDER);
  });

  for (const shape of SHAPES) {
    it(`${shape.name}: retorna número finito em toda amostra (u,v,t)`, () => {
      for (const t of TS) {
        for (const v of VS) {
          for (const u of US) {
            const s = shape.fn(u, v, t);
            expect(Number.isFinite(s), `${shape.name}(${u},${v},${t}) = ${s}`).toBe(true);
          }
        }
      }
    });
  }
});
