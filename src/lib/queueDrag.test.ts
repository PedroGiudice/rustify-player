import { describe, it, expect } from "vitest";
import { dropIndex, shiftFor } from "./queueDrag";

describe("arraste na fila", () => {
  it("o destino anda uma posição a cada meia linha arrastada, preso às bordas", () => {
    expect(dropIndex(2, 0, 48, 6)).toBe(2);
    expect(dropIndex(2, 23, 48, 6)).toBe(2);
    expect(dropIndex(2, 25, 48, 6)).toBe(3);
    expect(dropIndex(2, -73, 48, 6)).toBe(0);
    expect(dropIndex(2, 1000, 48, 6)).toBe(5);
    expect(dropIndex(2, -1000, 48, 6)).toBe(0);
  });
  it("as vizinhas abrem espaço: descendo, quem está entre origem e destino sobe uma linha", () => {
    // arrasta a 1 para a 3: as linhas 2 e 3 sobem
    expect([0, 1, 2, 3, 4].map((i) => shiftFor(i, 1, 3, 48))).toEqual([0, 0, -48, -48, 0]);
    // arrasta a 3 para a 1: as linhas 1 e 2 descem
    expect([0, 1, 2, 3, 4].map((i) => shiftFor(i, 3, 1, 48))).toEqual([0, 48, 48, 0, 0]);
  });
});
