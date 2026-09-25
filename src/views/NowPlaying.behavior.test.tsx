/* ============================================================
   NowPlaying.behavior.test.tsx — comportamento do Now Playing com
   stores REATIVOS (o NowPlaying.test.tsx usa um Proxy estático, que
   não deixa trocar de faixa nem mexer no motor do fundo).
   Achados da auditoria de UI de 25/09/2026.
   ============================================================ */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@solidjs/testing-library";
import { Suspense } from "solid-js";
import type { LyricLine } from "../tauri";

const h = vi.hoisted(() => ({
  libGetLyrics: vi.fn(),
  navigate: vi.fn(),
  setTweaksOpen: vi.fn(),
  shapePrev: vi.fn(),
  rendererPrev: vi.fn(),
}));

vi.mock("../store/player", async () => {
  const { createStore } = await import("solid-js/store");
  const [player, setPlayer] = createStore<any>({
    currentTrack: null,
    positionSecs: 0,
    techInfo: { format: "—", bitDepth: null, sampleRate: null, channels: null },
  });
  return { player, __setPlayer: setPlayer };
});

vi.mock("../store/tweaks", async () => {
  const { createSignal } = await import("solid-js");
  const [tweaks, setTweaks] = createSignal<any>({ lyricsVisible: true, bgEngine: "2d" });
  return { tweaks, __setTweaks: setTweaks, setTweaksOpen: h.setTweaksOpen };
});

vi.mock("../store/dsp", () => ({
  dsp: { bypass: true, eq: { enabled: false }, limiter: { enabled: false }, bass: { enabled: false } },
}));

vi.mock("../store/contextMenu", () => ({
  openTrackMenu: vi.fn(),
  trackMenu: () => null,
  closeTrackMenu: vi.fn(),
}));

vi.mock("../tauri", () => ({
  libGetLyrics: (id: string) => h.libGetLyrics(id),
  coverUrl: (p: string | null) => p ?? "",
}));

vi.mock("../router", () => ({ navigate: h.navigate }));

vi.mock("../components/CoverArt", () => ({
  CoverArt: (props: any) => <div class="cover-art">{props.children}</div>,
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { settings: "settings", more: "more", expand: "expand", shrink: "shrink", chevronLeft: "cl", chevronRight: "cr" },
}));

vi.mock("../components/SpectrumCanvas", () => ({
  useShape: () => ({ prev: h.shapePrev, next: vi.fn(), name: () => "wave" }),
  useRenderer: () => ({ prev: h.rendererPrev, next: vi.fn(), name: () => "mesh" }),
}));

import * as playerMod from "../store/player";
import NowPlaying from "./NowPlaying";

const setPlayer = (playerMod as any).__setPlayer as (...args: any[]) => void;

function track(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Faixa ${id}`,
    artist_name: `Artista ${id}`,
    album_title: `Álbum ${id}`,
    album_cover_path: null,
    album_year: null,
    duration_ms: 200000,
    path: `/${id}.flac`,
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  setPlayer({ currentTrack: null, positionSecs: 0 });
  h.libGetLyrics.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NowPlaying — troca de faixa (np-1)", () => {
  it("não derruba a view para o fallback do Suspense enquanto a letra nova carrega", async () => {
    const pendingB = deferred<LyricLine[]>();
    h.libGetLyrics.mockImplementation((id: string) =>
      id === "A" ? Promise.resolve([{ t: 1, line: "letra de A" }]) : pendingB.promise,
    );
    setPlayer({ currentTrack: track("A") });

    const { container, queryByTestId } = render(() => (
      <Suspense fallback={<p data-testid="fallback">Loading…</p>}>
        <NowPlaying />
      </Suspense>
    ));
    await waitFor(() => expect(container.textContent).toContain("letra de A"));

    setPlayer("currentTrack", track("B"));
    await Promise.resolve();

    expect(queryByTestId("fallback")).toBeNull();
    expect(container.querySelector(".np__title")?.textContent).toBe("Faixa B");

    pendingB.resolve([{ t: 1, line: "letra de B" }]);
    await waitFor(() => expect(container.textContent).toContain("letra de B"));
    expect(queryByTestId("fallback")).toBeNull();
  });
});
