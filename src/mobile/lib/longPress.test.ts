import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLongPress } from "./longPress";

function pointer(overrides: Partial<PointerEvent> = {}) {
  return {
    pointerId: 1,
    clientX: 100,
    clientY: 200,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as PointerEvent;
}

describe("createLongPress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("dispara depois do delay com o dedo parado", () => {
    const onFire = vi.fn();
    const lp = createLongPress({ onFire });
    lp.handlers.onPointerDown(pointer());
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(450);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("NÃO dispara se o dedo andar além da tolerância (é scroll, não long-press)", () => {
    const onFire = vi.fn();
    const lp = createLongPress({ onFire });
    lp.handlers.onPointerDown(pointer());
    lp.handlers.onPointerMove(pointer({ clientY: 214 })); // 14px > 10px
    vi.advanceTimersByTime(1000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("tolera micro-tremor do dedo dentro da tolerância", () => {
    const onFire = vi.fn();
    const lp = createLongPress({ onFire });
    lp.handlers.onPointerDown(pointer());
    lp.handlers.onPointerMove(pointer({ clientX: 104, clientY: 203 })); // 5px
    vi.advanceTimersByTime(450);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("cancela ao soltar antes do tempo", () => {
    const onFire = vi.fn();
    const lp = createLongPress({ onFire });
    lp.handlers.onPointerDown(pointer());
    vi.advanceTimersByTime(200);
    lp.handlers.onPointerUp(pointer());
    vi.advanceTimersByTime(1000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("cancela em pointercancel (gesto roubado pelo sistema)", () => {
    const onFire = vi.fn();
    const lp = createLongPress({ onFire });
    lp.handlers.onPointerDown(pointer());
    lp.handlers.onPointerCancel();
    vi.advanceTimersByTime(1000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("suprime o click que vem depois do long-press", () => {
    const lp = createLongPress({ onFire: () => {} });
    lp.handlers.onPointerDown(pointer());
    vi.advanceTimersByTime(450);
    expect(lp.consumedClick()).toBe(true);
    // só o primeiro click é engolido
    expect(lp.consumedClick()).toBe(false);
  });

  it("toque curto NÃO consome o click", () => {
    const lp = createLongPress({ onFire: () => {} });
    lp.handlers.onPointerDown(pointer());
    vi.advanceTimersByTime(100);
    lp.handlers.onPointerUp(pointer());
    expect(lp.consumedClick()).toBe(false);
  });

  it("respeita delay e tolerância customizados", () => {
    const onFire = vi.fn();
    const lp = createLongPress({ onFire, delay: 800, tolerance: 30 });
    lp.handlers.onPointerDown(pointer());
    lp.handlers.onPointerMove(pointer({ clientY: 225 })); // 25px < 30px
    vi.advanceTimersByTime(450);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("um segundo pointerdown reinicia a contagem", () => {
    const onFire = vi.fn();
    const lp = createLongPress({ onFire });
    lp.handlers.onPointerDown(pointer());
    vi.advanceTimersByTime(300);
    lp.handlers.onPointerDown(pointer());
    vi.advanceTimersByTime(300);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
