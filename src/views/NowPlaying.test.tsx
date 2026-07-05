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
  state: { currentTrack: null as any },
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
      if (key === "isPlaying") return false;
      if (key === "techInfo") return { format: "—", bitDepth: null, sampleRate: null, channels: null };
      return undefined;
    },
  }),
}));

vi.mock("../store/dsp", () => ({
  dsp: { bypass: true, eq: { enabled: false }, limiter: { enabled: false }, bass: { enabled: false } },
}));

vi.mock("../store/tweaks", () => ({
  tweaks: () => ({ lyricsVisible: false }),
}));

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ current_track: null, current_library_track: null, is_playing: false }),
  getTrackColor: vi.fn().mockResolvedValue(""),
  libGetLyrics: vi.fn().mockResolvedValue([]),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

vi.mock("../router", () => ({
  navigate: vi.fn(),
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
