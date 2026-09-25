/* ============================================================
   playLabels.test.tsx — nome acessível dos botões de tocar só com
   ícone (auditoria de UI 25/09, ds-2): card__play da página do
   artista e o play do cabeçalho do álbum.
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

const { routeState, mockAlbums } = vi.hoisted(() => ({
  routeState: { path: "/artist", param: "Band" as string | null },
  mockAlbums: [
    { title: "Great Album", artist_name: "Band", cover_path: null, year: 2023, track_count: 1 },
  ],
}));

vi.mock("../tauri", () => ({
  libGetAlbumsByArtist: vi.fn().mockResolvedValue(mockAlbums),
  libGetAlbums: vi.fn().mockResolvedValue(mockAlbums),
  libGetTracksByAlbum: vi.fn().mockResolvedValue([]),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

vi.mock("../store/player", () => ({
  setQueue: vi.fn(),
  player: { currentTrack: null, positionSecs: 0, durationSecs: 0, isPlaying: false },
}));

vi.mock("../components/PlayerBar", () => ({ playTrack: vi.fn() }));

vi.mock("../router", () => ({
  navigate: vi.fn(),
  route: () => routeState,
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { play: "play" },
}));

vi.mock("../components/TrackRowTable", () => ({
  TrackRowTable: () => <div />,
}));

import ArtistView from "./Artist";
import AlbumView from "./Album";

afterEach(() => cleanup());

describe("botões de tocar só com ícone têm nome (ds-2)", () => {
  it("card__play na página do artista diz qual álbum toca", async () => {
    routeState.path = "/artist";
    routeState.param = "Band";
    const { container } = render(() => <ArtistView />);
    await vi.waitFor(() => expect(container.querySelector(".card__play")).toBeTruthy());
    expect(container.querySelector(".card__play")!.getAttribute("aria-label")).toBe("Tocar Great Album");
  });

  it("play do cabeçalho do álbum diz o nome do álbum", () => {
    routeState.path = "/album";
    routeState.param = encodeURIComponent("Great Album");
    const { container } = render(() => <AlbumView />);
    const btn = container.querySelector(".view__head .hero-tile__cta")!;
    expect(btn.getAttribute("aria-label")).toBe("Tocar Great Album");
    expect(btn.getAttribute("type")).toBe("button");
  });
});
