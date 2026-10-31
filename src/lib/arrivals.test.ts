import { describe, it, expect, afterEach, vi } from "vitest";
import { ARRIVALS_WINDOW_S, arrivalsCutoff, countUnseen, isUnseen, loadArrivalsSeen, saveArrivalsSeen } from "./arrivals";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("chegadas da semana (B12)", () => {
  it("o corte é uma semana antes de agora, em segundos", () => {
    expect(ARRIVALS_WINDOW_S).toBe(7 * 86_400);
    expect(arrivalsCutoff(1_761_900_000_123)).toBe(1_761_900_000 - 7 * 86_400);
  });

  it("nova = gravada depois da última visita; sem visita, tudo é novo; sem data, nada é", () => {
    expect(isUnseen({ indexed_at: 200 }, 100)).toBe(true);
    expect(isUnseen({ indexed_at: 100 }, 100)).toBe(false);
    expect(isUnseen({ indexed_at: 50 }, null)).toBe(true);
    expect(isUnseen({ indexed_at: null }, null)).toBe(false);
    expect(countUnseen([{ indexed_at: 300 }, { indexed_at: 200 }, { indexed_at: 90 }], 100)).toBe(2);
  });

  it("a marca de visto persiste e só anda para a frente", () => {
    expect(loadArrivalsSeen()).toBeNull();
    saveArrivalsSeen(500);
    expect(loadArrivalsSeen()).toBe(500);
    saveArrivalsSeen(400); // visita com lista mais velha não apaga o que já foi visto
    expect(loadArrivalsSeen()).toBe(500);
  });

  it("valor estragado no localStorage vale como nunca visto", () => {
    localStorage.setItem("kv-home-arrivals-seen", "abc");
    expect(loadArrivalsSeen()).toBeNull();
  });

  it("localStorage que lança (janela privada) não derruba nada", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("bloqueado"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("bloqueado"); });
    expect(loadArrivalsSeen()).toBeNull();
    expect(() => saveArrivalsSeen(10)).not.toThrow();
  });
});
