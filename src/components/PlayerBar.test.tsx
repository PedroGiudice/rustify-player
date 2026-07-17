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
import { setQueue } from "../store/player";
import type { Track } from "../tauri";

const FAKE_TRACK = {
  id: "1", title: "Faixa", artist_name: "Artista", album_title: "Disco",
  album_cover_path: null, album_year: null, duration_ms: 1000, path: "/x", lrc_path: null,
} as Track;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setQueue([], 0); // limpa fila + proveniência entre testes
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

describe("chip de origem da fila (pb-src)", () => {
  it("fila de station mostra 'station' com o nome no tooltip", () => {
    setQueue([FAKE_TRACK], 0, "curated", { kind: "station", name: "Neon" });
    const { container } = render(() => <PlayerBar />);
    const chip = container.querySelector(".pb-src")!;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe("station");
    expect(chip.getAttribute("title")).toBe("Neon");
    expect(chip.getAttribute("data-kind")).toBe("station");
  });

  it("fila avulsa mostra 'solta'", () => {
    setQueue([FAKE_TRACK], 0);
    const { container } = render(() => <PlayerBar />);
    const chip = container.querySelector(".pb-src")!;
    expect(chip.textContent).toBe("solta");
    expect(chip.getAttribute("data-kind")).toBe("solta");
  });

  it("playlist e álbum têm labels próprios", () => {
    setQueue([FAKE_TRACK], 0, "curated", { kind: "playlist", name: "Rap" });
    const { container } = render(() => <PlayerBar />);
    expect(container.querySelector(".pb-src")!.textContent).toBe("playlist");
    cleanup();
    setQueue([FAKE_TRACK], 0, "curated", { kind: "album", name: "Disco" });
    const { container: c2 } = render(() => <PlayerBar />);
    expect(c2.querySelector(".pb-src")!.textContent).toBe("álbum");
  });

  it("sem faixa tocando não há chip", () => {
    setQueue([], 0);
    const { container } = render(() => <PlayerBar />);
    expect(container.querySelector(".pb-src")).toBeNull();
  });
});
