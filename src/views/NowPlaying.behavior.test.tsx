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

describe("NowPlaying — linhas da letra (np-4, nowplaying-v2)", () => {
  async function renderWith(lines: LyricLine[]) {
    h.libGetLyrics.mockResolvedValue(lines);
    setPlayer({ currentTrack: track("A") });
    const r = render(() => <NowPlaying />);
    await waitFor(() => expect(r.container.querySelectorAll(".np__lyric").length).toBe(lines.length));
    return r;
  }

  it("letra sem sincronismo não destaca a primeira linha como próxima", async () => {
    const { container } = await renderWith([
      { t: 0, line: "um" },
      { t: 0, line: "dois" },
      { t: 0, line: "três" },
    ]);
    expect(container.querySelector(".np__lyric.is-near")).toBeNull();
    expect(container.querySelector(".np__lyric.is-active")).toBeNull();
    expect(container.querySelector(".np__lyrics-viewport.is-unsynced")).not.toBeNull();
  });

  it("marca cabeçalhos de seção ([Chorus]) com classe própria", async () => {
    const { container } = await renderWith([
      { t: 1, line: "[Chorus]", header: true },
      { t: 2, line: "verso" },
    ]);
    const lines = container.querySelectorAll(".np__lyric");
    expect(lines[0].classList.contains("is-header")).toBe(true);
    expect(lines[1].classList.contains("is-header")).toBe(false);
  });

  it("linha vazia do LRC (interlúdio) aparece como reticências, não como parágrafo vazio", async () => {
    setPlayer("positionSecs", 5);
    const { container } = await renderWith([
      { t: 1, line: "antes" },
      { t: 4, line: "" },
      { t: 9, line: "depois" },
    ]);
    const lines = container.querySelectorAll(".np__lyric");
    expect(lines[1].textContent).toBe("…");
    expect(lines[1].classList.contains("is-active")).toBe(true);
  });
});

describe("NowPlaying — artista e álbum (np-10, shell-v1, biblioteca-v2)", () => {
  it("são botões alcançáveis por teclado que levam à página da entidade", () => {
    h.libGetLyrics.mockResolvedValue([]);
    setPlayer({ currentTrack: track("A", { artist_name: "Sade & Co", album_title: "Love Deluxe" }) });
    const { container } = render(() => <NowPlaying />);

    const artist = container.querySelector(".np__artist") as HTMLElement;
    const album = container.querySelector(".np__album") as HTMLElement;
    expect(artist.tagName).toBe("BUTTON");
    expect(album.tagName).toBe("BUTTON");

    artist.click();
    expect(h.navigate).toHaveBeenLastCalledWith(`/artist/${encodeURIComponent("Sade & Co")}`);
    album.click();
    expect(h.navigate).toHaveBeenLastCalledWith(`/album/${encodeURIComponent("Love Deluxe")}`);
  });

  it("sem faixa não oferece link nenhum", () => {
    setPlayer({ currentTrack: null });
    const { container } = render(() => <NowPlaying />);
    expect(container.querySelector("button.np__artist")).toBeNull();
    expect(container.querySelector("button.np__album")).toBeNull();
  });
});
