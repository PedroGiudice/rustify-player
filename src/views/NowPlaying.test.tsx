/* ============================================================
   NowPlaying.test.tsx — Testa que o botao "More" abre o menu
   de contexto com a track atual, e fica desabilitado sem track.
   ============================================================ */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const { mockTrack, mockOpenTrackMenu, state } = vi.hoisted(() => ({
  mockTrack: {
    id: "42",
    title: "Test Song",
    artist_name: "Test Artist",
    album_title: "Test Album",
    album_cover_path: null,
    album_year: null,
    duration_ms: 300000,
    path: "/test.flac",
    lrc_path: null,
    play_count: 1,
  },
  mockOpenTrackMenu: vi.fn(),
  // Holder mutavel pra alternar currentTrack entre os testes.
  state: { currentTrack: null as any, isPlaying: false, lyricsVisible: false },
}));

vi.mock("../store/contextMenu", () => ({
  openTrackMenu: (...args: any[]) => mockOpenTrackMenu(...args),
  trackMenu: () => null,
  closeTrackMenu: vi.fn(),
}));

vi.mock("../store/player", () => ({
  player: new Proxy({}, {
    get: (_t, key) => {
      if (key === "currentTrack") return state.currentTrack;
      if (key === "positionSecs") return 0;
      if (key === "durationSecs") return 300;
      if (key === "isPlaying") return state.isPlaying;
      if (key === "techInfo") return { format: "—", bitDepth: null, sampleRate: null, channels: null };
      return undefined;
    },
  }),
}));

vi.mock("../store/dsp", () => ({
  dsp: { bypass: true, eq: { enabled: false }, limiter: { enabled: false }, bass: { enabled: false } },
}));

vi.mock("../store/tweaks", () => ({
  tweaks: () => ({ lyricsVisible: state.lyricsVisible }),
}));

// Letra vem do store único (store/lyrics); o teste controla o estado.
vi.mock("../store/lyrics", async () => {
  const { createSignal } = await import("solid-js");
  const [lyricsState, setLyricsState] = createSignal<any>({ trackId: null, status: "sem", lines: [] });
  return { lyricsState, reloadLyrics: vi.fn(), __setLyrics: setLyricsState };
});

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ current_track: null, current_library_track: null, is_playing: false }),
  getTrackColor: vi.fn().mockResolvedValue(""),
  libGetLyrics: vi.fn().mockResolvedValue([]),
  libListHistory: vi.fn().mockResolvedValue([]),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

vi.mock("../router", () => ({
  navigate: vi.fn(),
}));

vi.mock("../lib/quickPlay", () => ({
  playAlone: vi.fn(),
  shuffleAll: vi.fn(),
}));

vi.mock("../components/CoverArt", () => ({
  CoverArt: (props: any) => <div class="cover-art">{props.children}</div>,
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { settings: "settings", more: "more", expand: "expand", shrink: "shrink", chevronLeft: "cl", chevronRight: "cr" },
}));

vi.mock("../components/SpectrumCanvas", () => ({
  useShape: () => ({ prev: vi.fn(), next: vi.fn(), name: () => "wave" }),
  useRenderer: () => ({ prev: vi.fn(), next: vi.fn(), name: () => "mesh" }),
}));

beforeEach(() => {
  mockOpenTrackMenu.mockClear();
  state.currentTrack = null;
  state.isPlaying = false;
  state.lyricsVisible = false;
  // jsdom não tem ResizeObserver; o NowPlaying observa o .np para
  // reposicionar o card de letras (o WebKitGTK do app tem).
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import NowPlaying from "./NowPlaying";

describe("NowPlaying — botao More", () => {
  it("esta desabilitado quando nao ha track tocando", () => {
    state.currentTrack = null;
    const { container } = render(() => <NowPlaying />);
    const btn = container.querySelector('button[title="More"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  it("chama openTrackMenu com a track atual ao clicar", () => {
    state.currentTrack = mockTrack;
    const { container } = render(() => <NowPlaying />);
    const btn = container.querySelector('button[title="More"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);

    expect(mockOpenTrackMenu).toHaveBeenCalledTimes(1);
    // Primeiro argumento e o MouseEvent, segundo e a track
    expect(mockOpenTrackMenu.mock.calls[0][1]).toEqual(mockTrack);
  });
});

/* A12: o ponto do selo respira só tocando; pausado fica neutro. */
describe("NowPlaying — ponto do selo", () => {
  it("marca o selo como tocando só quando a música toca", () => {
    state.currentTrack = mockTrack;
    state.isPlaying = false;
    const paused = render(() => <NowPlaying />);
    expect(paused.container.querySelector(".np__tag-playing")!.getAttribute("data-playing")).toBe("false");
    cleanup();
    state.isPlaying = true;
    const playing = render(() => <NowPlaying />);
    expect(playing.container.querySelector(".np__tag-playing")!.getAttribute("data-playing")).toBe("true");
  });
});

describe("NowPlaying — letra pelo store único", () => {
  it("não busca a letra por conta própria (o store/lyrics já busca)", async () => {
    const tauri = await import("../tauri");
    state.currentTrack = mockTrack;
    render(() => <NowPlaying />);
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(tauri.libGetLyrics)).not.toHaveBeenCalled();
  });

  it("letra ok aparece no card", async () => {
    const lyr: any = await import("../store/lyrics");
    state.currentTrack = mockTrack;
    state.lyricsVisible = true;
    lyr.__setLyrics({ trackId: "42", status: "ok", lines: [{ t: 1, line: "primeiro verso" }, { t: 4, line: "segundo verso" }] });
    const { container } = render(() => <NowPlaying />);
    expect(container.querySelector(".np__lyrics-card")).toBeTruthy();
    expect(container.textContent).toContain("primeiro verso");
  });

  it("busca que falhou não vira card vazio: diz que falhou e tenta de novo", async () => {
    const lyr: any = await import("../store/lyrics");
    state.currentTrack = mockTrack;
    state.lyricsVisible = true;
    lyr.__setLyrics({ trackId: "42", status: "erro", lines: [] });
    const { container, getByText } = render(() => <NowPlaying />);
    expect(container.querySelector(".np__lyrics-card")).toBeTruthy();
    expect(container.textContent).toContain("Não consegui carregar a letra");
    fireEvent.click(getByText("Tentar de novo"));
    expect(lyr.reloadLyrics).toHaveBeenCalled();
  });

  it("faixa sem letra não monta o card", async () => {
    const lyr: any = await import("../store/lyrics");
    state.currentTrack = mockTrack;
    state.lyricsVisible = true;
    lyr.__setLyrics({ trackId: "42", status: "sem", lines: [] });
    const { container } = render(() => <NowPlaying />);
    expect(container.querySelector(".np__lyrics-card")).toBeNull();
  });
});
