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
  libGetTracks: vi.fn().mockResolvedValue([]),
  libGetTracksByArtist: vi.fn().mockResolvedValue([]),
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
  ICONS: { play: "play", refresh: "refresh", artists: "artists", albums: "albums", moveTo: "moveTo", alert: "alert" },
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

  // A20: o play do cabeçalho deixou de ser um círculo só com ícone; é o
  // botão "Tocar" com texto, igual ao da Playlist e ao do Artista.
  it("o cabeçalho do álbum e o do artista têm o botão Tocar com texto", async () => {
    for (const [path, param, View] of [["/album", encodeURIComponent("Great Album"), AlbumView], ["/artist", "Band", ArtistView]] as const) {
      routeState.path = path;
      routeState.param = param;
      const { container, unmount } = render(() => <View />);
      const btn = container.querySelector(".view__head .pl-action-btn--primary")!;
      expect(btn.textContent, path).toBe("Tocar");
      expect(btn.getAttribute("type"), path).toBe("button");
      expect(container.querySelector(".hero-tile__cta"), path).toBeNull();
      unmount();
    }
  });
});
