/* ============================================================
   PlayerBar.test.tsx — Regressao dos cleanups do onMount.
   Listeners DOM e o save interval devem ser registrados (e seus
   onCleanup armados) SINCRONAMENTE: onCleanup chamado apos um
   await dentro de onMount(async) roda fora do owner e vira no-op,
   vazando listeners/interval no unmount.
   ============================================================ */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { PlayerBar } from "./PlayerBar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PlayerBar lifecycle", () => {
  it("registra listeners/interval no mount", () => {
    const addWin = vi.spyOn(window, "addEventListener");
    const addDoc = vi.spyOn(document, "addEventListener");
    render(() => <PlayerBar />);
    const winEvents = addWin.mock.calls.map((c) => c[0]);
    expect(winEvents).toContain("search-play-track");
    expect(winEvents).toContain("beforeunload");
    expect(addDoc.mock.calls.map((c) => c[0])).toContain("visibilitychange");
  });

  it("unmount remove listeners e cancela o save interval", () => {
    const removeWin = vi.spyOn(window, "removeEventListener");
    const removeDoc = vi.spyOn(document, "removeEventListener");
    const clearSpy = vi.spyOn(window, "clearInterval");
    const { unmount } = render(() => <PlayerBar />);
    unmount();
    const winEvents = removeWin.mock.calls.map((c) => c[0]);
    expect(winEvents).toContain("search-play-track");
    expect(winEvents).toContain("beforeunload");
    expect(removeDoc.mock.calls.map((c) => c[0])).toContain("visibilitychange");
    expect(clearSpy).toHaveBeenCalled();
  });
});
