import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { CALM_GAP_MS, createEnterWindow, createSwapKey, isCalmChange, nextSwapKey } from "./motion";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("nextSwapKey", () => {
  it("alterna a/b fora de rajada", () => {
    expect(nextSwapKey("off", 0, CALM_GAP_MS)).toBe("a");
    expect(nextSwapKey("a", 0, CALM_GAP_MS)).toBe("b");
    expect(nextSwapKey("b", 0, CALM_GAP_MS + 1)).toBe("a");
  });
  it("dentro da rajada corta seco", () => {
    expect(nextSwapKey("a", 1000, 1000 + CALM_GAP_MS - 1)).toBe("off");
    expect(isCalmChange(1000, 1000 + CALM_GAP_MS - 1)).toBe(false);
  });
});

describe("createSwapKey", () => {
  it("troca calma anima, troca em rajada corta, montagem conta como troca", () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const [id, setId] = createSignal("t1");
    // Efeitos só rodam depois que o createRoot termina: as trocas vêm de fora.
    const { key, dispose } = createRoot((dispose) => ({ key: createSwapKey(id), dispose }));
    expect(key()).toBe("off");

    clock = 500; setId("t2");          // logo depois de montar: corte
    expect(key()).toBe("off");
    clock = 5_000; setId("t3");        // calma
    expect(key()).toBe("a");
    clock = 5_300; setId("t4");        // pulo em rajada
    expect(key()).toBe("off");
    clock = 9_000; setId("t5");        // calma de novo
    expect(key()).toBe("a");
    clock = 12_000; setId("t6");
    expect(key()).toBe("b");
    clock = 20_000; setId("t6");       // mesmo valor: nada muda
    expect(key()).toBe("b");
    dispose();
  });
});

describe("createEnterWindow", () => {
  it("fica aberta só logo depois de montar", () => {
    vi.useFakeTimers();
    createRoot((dispose) => {
      const open = createEnterWindow(600);
      expect(open()).toBe(true);
      vi.advanceTimersByTime(599);
      expect(open()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(open()).toBe(false);
      dispose();
    });
  });
});
