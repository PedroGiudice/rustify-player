import { describe, it, expect } from "vitest";
import { circleStrip, planeGridXZ, surfaceIndices, wireframeIndices } from "./geometry";
import { RELIEF_GRID, RELIEF_SURFACE_GRID } from "./scenes/relief";

describe("planeGridXZ (PlaneGeometry do three deitado com rotateX(-π/2))", () => {
  it("mesma contagem e mesmos cantos da Relevo", () => {
    const { width, height, gx, gy } = RELIEF_GRID;
    const p = planeGridXZ(width, height, gx, gy);
    expect(p.length).toBe((gx + 1) * (gy + 1) * 3);
    // Vértice 0: canto (-75, 0, -55); último: (75, 0, 55).
    expect(Array.from(p.slice(0, 3))).toEqual([-75, 0, -55]);
    expect(Array.from(p.slice(-3))).toEqual([75, 0, 55]);
    // Linha a linha, x crescendo (a ordem que o índice do three assume).
    expect(p[3]).toBeCloseTo(-75 + width / gx, 5);
    expect(p[(gx + 1) * 3 + 2]).toBeCloseTo(-55 + height / gy, 5);
    for (let i = 1; i < p.length; i += 3) expect(p[i]).toBe(0);
  });
});

describe("wireframeIndices (o índice de wireframe do three)", () => {
  it("três arestas por triângulo, dois triângulos por célula", () => {
    const idx = wireframeIndices(2, 1);
    expect(idx.length).toBe(2 * 1 * 2 * 6);
    // Célula 0: a=0, b=3, c=4, d=1 (linha tem gx+1 = 3 vértices).
    // Triângulo (a,b,d) e (b,c,d) -> arestas a-b, b-d, d-a, b-c, c-d, d-b.
    expect(Array.from(idx.slice(0, 12))).toEqual([0, 3, 3, 1, 1, 0, 3, 4, 4, 1, 1, 3]);
  });

  it("diagonal b-d de cada célula está presente, e duas vezes", () => {
    const gx = 4, gy = 3, row = gx + 1;
    const idx = wireframeIndices(gx, gy);
    const edges = new Map<string, number>();
    for (let i = 0; i < idx.length; i += 2) {
      const a = Math.min(idx[i], idx[i + 1]), b = Math.max(idx[i], idx[i + 1]);
      edges.set(`${a}-${b}`, (edges.get(`${a}-${b}`) ?? 0) + 1);
    }
    for (let iy = 0; iy < gy; iy++) {
      for (let ix = 0; ix < gx; ix++) {
        const b = ix + row * (iy + 1), d = ix + 1 + row * iy;
        expect(edges.get(`${Math.min(b, d)}-${Math.max(b, d)}`)).toBe(2);
      }
    }
    // Aresta de borda (linha 0, entre 0 e 1) aparece uma vez só.
    expect(edges.get("0-1")).toBe(1);
  });

  it("Relevo cabe em índice de 16 bits; malha grande usa 32", () => {
    expect(wireframeIndices(RELIEF_GRID.gx, RELIEF_GRID.gy)).toBeInstanceOf(Uint16Array);
    expect(wireframeIndices(300, 300)).toBeInstanceOf(Uint32Array);
  });
});

describe("surfaceIndices (triângulos do Relevo desenhado por pixel)", () => {
  it("dois triângulos por célula, com a divisão do three", () => {
    const idx = surfaceIndices(2, 1);
    expect(idx.length).toBe(2 * 1 * 6);
    // Célula 0: a=0, b=3, c=4, d=1 -> (a,b,d) e (b,c,d).
    expect(Array.from(idx.slice(0, 6))).toEqual([0, 3, 1, 3, 4, 1]);
  });

  it("contagem da malha densa do Relevo e índice de 16 bits", () => {
    const { gx, gy } = RELIEF_SURFACE_GRID;
    const idx = surfaceIndices(gx, gy);
    expect(idx.length).toBe(gx * gy * 6);
    expect((gx + 1) * (gy + 1)).toBeLessThanOrEqual(65535);
    expect(idx).toBeInstanceOf(Uint16Array);
    expect(Array.from(idx).reduce((m, v) => (v > m ? v : m), 0)).toBe((gx + 1) * (gy + 1) - 1);
  });

  it("acima de 65535 vértices usa Uint32 e não trunca índice", () => {
    const idx = surfaceIndices(300, 300);
    expect(idx).toBeInstanceOf(Uint32Array);
    expect(idx[idx.length - 2]).toBe(301 * 301 - 1); // vértice c da última célula
  });

  it("ordem de pintor: linha da grade mais distante (z = -55) primeiro", () => {
    const gx = 6, gy = 5, row = gx + 1;
    const idx = surfaceIndices(gx, gy);
    const z = planeGridXZ(150, 110, gx, gy);
    let lastRow = -1;
    for (let t = 0; t < idx.length; t += 3) {
      const rows = [idx[t], idx[t + 1], idx[t + 2]].map((v) => Math.floor(v / row));
      const cellRow = Math.min(...rows);
      // Todo triângulo fica entre duas linhas vizinhas...
      expect(Math.max(...rows) - cellRow).toBe(1);
      // ...e a linha da célula nunca volta para trás.
      expect(cellRow).toBeGreaterThanOrEqual(lastRow);
      lastRow = cellRow;
    }
    // Primeiro triângulo toca z = -55 (o fundo); o último, z = +55.
    expect(z[idx[0] * 3 + 2]).toBe(-55);
    expect(z[idx[idx.length - 1] * 3 + 2] + z[idx[idx.length - 2] * 3 + 2]).toBeGreaterThan(0);
    expect(lastRow).toBe(gy - 1);
  });
});

describe("circleStrip", () => {
  it("seg+1 pontos no círculo unitário, fechando no primeiro", () => {
    const c = circleStrip(128);
    expect(c.length).toBe(129 * 3);
    expect(c[0]).toBeCloseTo(1, 6);
    expect(c[128 * 3]).toBeCloseTo(1, 6);
    expect(c[128 * 3 + 1]).toBeCloseTo(0, 5);
    for (let i = 0; i < 129; i++) expect(Math.hypot(c[i * 3], c[i * 3 + 1])).toBeCloseTo(1, 6);
  });
});
