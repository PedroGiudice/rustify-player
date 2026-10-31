import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  CALM_GAP_MS, createEnterWindow, createPresence, createSwapKey, cssDurationMs, isCalmChange, nextSwapKey,
} from "./motion";

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

describe("createPresence", () => {
  it("guarda o último valor durante a saída e só então solta", () => {
    vi.useFakeTimers();
    const [src, setSrc] = createSignal<number | null>(null);
    const { p, dispose } = createRoot((dispose) => ({ p: createPresence(src, () => 180), dispose }));
    expect(p.value()).toBeNull();
    setSrc(3);
    expect(p.value()).toBe(3);
    expect(p.leaving()).toBe(false);
    setSrc(null);
    expect(p.value()).toBe(3); // o rótulo da saída não vira "0 faixas"
    expect(p.leaving()).toBe(true);
    vi.advanceTimersByTime(179);
    expect(p.value()).toBe(3);
    vi.advanceTimersByTime(1);
    expect(p.value()).toBeNull();
    expect(p.leaving()).toBe(false);
    dispose();
  });

  it("voltar durante a saída cancela a saída", () => {
    vi.useFakeTimers();
    const [src, setSrc] = createSignal<number | null>(1);
    const { p, dispose } = createRoot((dispose) => ({ p: createPresence(src, () => 180), dispose }));
    setSrc(null);
    vi.advanceTimersByTime(100);
    setSrc(2);
    expect(p.value()).toBe(2);
    expect(p.leaving()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(p.value()).toBe(2);
    dispose();
  });
});

describe("cssDurationMs", () => {
  it("lê s e ms, e cai no padrão quando a var não existe", () => {
    expect(cssDurationMs("--dur-que-nao-existe", 180)).toBe(180);
    document.documentElement.style.setProperty("--dur-x", "0.24s");
    expect(cssDurationMs("--dur-x", 0)).toBe(240);
    document.documentElement.style.setProperty("--dur-x", "150ms");
    expect(cssDurationMs("--dur-x", 0)).toBe(150);
    document.documentElement.style.removeProperty("--dur-x");
  });
});
