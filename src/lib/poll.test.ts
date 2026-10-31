/* ============================================================
   poll.test.ts — poll que dorme com a janela oculta (A49).
   ============================================================ */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pollWhileVisible } from "./poll";

let hidden = false;

function setHidden(v: boolean) {
  hidden = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pollWhileVisible", () => {
  it("dispara no intervalo enquanto a janela está à vista", () => {
    const fn = vi.fn();
    const stop = pollWhileVisible(fn, 1000);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });

  it("com a janela oculta não dispara; ao voltar, dispara na hora", () => {
    const fn = vi.fn();
    const stop = pollWhileVisible(fn, 1000);
    setHidden(true);
    vi.advanceTimersByTime(10_000);
    expect(fn).not.toHaveBeenCalled();
    setHidden(false);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
  });

  it("parado, não dispara nem ao voltar a janela", () => {
    const fn = vi.fn();
    const stop = pollWhileVisible(fn, 1000);
    stop();
    setHidden(true);
    setHidden(false);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});
