/* ============================================================
   tauri.motor.test.ts — Contratos de IPC da varredura de 31/10:
   eventos do player com o id da faixa (A40) e os comandos novos do
   motor (B9, B11, B14). Nome e argumentos são EXATAMENTE os do Rust.
   ============================================================ */
import { describe, it, expect, vi, beforeAll } from "vitest";

const invoke = vi.fn().mockResolvedValue([]);
let tauri: typeof import("./tauri");

beforeAll(async () => {
  // tauri.ts desestrutura window.__TAURI__.core no load do módulo.
  (window as any).__TAURI__.core.invoke = invoke;
  vi.resetModules();
  tauri = await import("./tauri");
});

describe("B9: fora do rádio e recusa com escopo", () => {
  const id = "18446744073709551614";

  it("lista sem argumentos", async () => {
    invoke.mockClear();
    await tauri.libRadioExcluded();
    expect(invoke).toHaveBeenCalledWith("lib_radio_excluded");
  });

  it("recusa nunca no rádio e fora desta station", async () => {
    invoke.mockClear();
    await tauri.libRadioRefuse(id, "never");
    expect(invoke).toHaveBeenLastCalledWith("lib_radio_refuse", { trackId: id, scope: "never", stationId: null });
    await tauri.libRadioRefuse(id, "station", "your-mix");
    expect(invoke).toHaveBeenLastCalledWith("lib_radio_refuse", { trackId: id, scope: "station", stationId: "your-mix" });
  });

  it("devolve tudo por padrão e desfaz com o estado anterior", async () => {
    invoke.mockClear();
    await tauri.libRadioReturn(id);
    expect(invoke).toHaveBeenLastCalledWith("lib_radio_return", { trackId: id, scope: null, stationId: null });
    const before = { never_at: 1, off_stations: [], release_skips: 0, released_at: null };
    await tauri.libRadioRestore(id, before);
    expect(invoke).toHaveBeenLastCalledWith("lib_radio_restore", { trackId: id, state: before });
  });
});

describe("B11: escuta viva e qualidade", () => {
  it("álbum leva artista e álbum; artista só o artista", async () => {
    invoke.mockClear();
    await tauri.libListenStats({ artist: "Smino", album: "Luv 4 Rent" });
    expect(invoke).toHaveBeenLastCalledWith("lib_listen_stats", { artist: "Smino", album: "Luv 4 Rent" });
    await tauri.libListenStats({ artist: "Smino" });
    expect(invoke).toHaveBeenLastCalledWith("lib_listen_stats", { artist: "Smino", album: null });
  });
});

describe("A40: evento do player de outra faixa", () => {
  const big = "18446744073709551614";

  it("fim de outra faixa é atrasado", () => {
    expect(tauri.isStalePlayerEvent({ track_id: "111" }, big)).toBe(true);
  });

  it("mesma faixa vale, comparando o texto inteiro (u64 > 2^53)", () => {
    expect(tauri.isStalePlayerEvent({ track_id: big }, big)).toBe(false);
    expect(tauri.isStalePlayerEvent({ track_id: "18446744073709551615" }, big)).toBe(true);
  });

  it("sem id no evento ou sem faixa atual, vale", () => {
    expect(tauri.isStalePlayerEvent({}, big)).toBe(false);
    expect(tauri.isStalePlayerEvent({ track_id: big }, null)).toBe(false);
  });
});
