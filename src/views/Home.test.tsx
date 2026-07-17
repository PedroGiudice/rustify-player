/* ============================================================
   Home.test.tsx — Testa que o botao card__play no grid de albums
   monta a fila e toca a primeira track.

   CoverArt e renderizado REAL (sem mock): o .card__play e children
   dele. O teste de stopPropagation usa um ancestral Solid-delegado
   (nao listener nativo) pra refletir o event delegation do Solid.
   ============================================================ */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

// vi.mock factories sao hoisted; variaveis usadas dentro vem de vi.hoisted.
const { mockTracks, mockSnap, mockAlbums, mockSetQueue, mockPlayTrack } = vi.hoisted(() => ({
  mockTracks: [
    { id: "10", title: "Song 1", artist_name: "Band", album_title: "Great Album", album_cover_path: null, album_year: 2023, duration_ms: 240000, path: "/s1.flac", lrc_path: null },
  ],
  mockSnap: { tracks_total: 50, albums_total: 5, artists_total: 3, embeddings_done: 40, embeddings_pending: 10, embeddings_failed: 0 },
  mockAlbums: [
    { title: "Great Album", artist_name: "Band", cover_path: null, year: 2023, track_count: 1 },
  ],
  mockSetQueue: vi.fn(),
  mockPlayTrack: vi.fn(),
}));

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ current_track: null, current_library_track: null, is_playing: false }),
  getTrackColor: vi.fn().mockResolvedValue(""),
  libSnapshot: vi.fn().mockResolvedValue(mockSnap),
  libListHistory: vi.fn().mockResolvedValue([]),
  libGetAlbums: vi.fn().mockResolvedValue(mockAlbums),
  libRecommendations: vi.fn().mockResolvedValue({ most_played: [], based_on_top: [], discover: [] }),
  libShuffle: vi.fn().mockResolvedValue([]),
  libGetTracksByAlbum: vi.fn().mockResolvedValue(mockTracks),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

vi.mock("../store/player", () => ({
  setQueue: (...args: any[]) => mockSetQueue(...args),
  player: { currentTrack: null, positionSecs: 0, durationSecs: 0, isPlaying: false },
}));

vi.mock("../components/PlayerBar", () => ({
  playTrack: (...args: any[]) => mockPlayTrack(...args),
}));

vi.mock("../router", () => ({
  navigate: vi.fn(),
  route: () => ({ path: "/" }),
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { play: "play", shuffle: "shuffle", settings: "settings" },
}));

vi.mock("../components/TrackRowList", () => ({
  TrackRowList: () => <div class="track-row-mock" />,
}));

vi.mock("../lib/format", () => ({
  fmtDur: (ms: number) => `${Math.round(ms / 60000)}m`,
  relTime: () => "just now",
}));

beforeEach(() => {
  mockSetQueue.mockClear();
  mockPlayTrack.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import Home from "./Home";
import * as tauri from "../tauri";

describe("Home — botao card__play no grid de albums", () => {
  it("clicar no card__play chama setQueue com as tracks do album e toca a primeira", async () => {
    const { container } = render(() => <Home />);

    await vi.waitFor(() => {
      expect(container.querySelector(".card__play")).toBeTruthy();
    });

    const btn = container.querySelector(".card__play") as HTMLButtonElement;
    fireEvent.click(btn);

    await vi.waitFor(() => mockSetQueue.mock.calls.length > 0);

    expect(tauri.libGetTracksByAlbum).toHaveBeenCalledWith("Great Album");
    expect(mockSetQueue).toHaveBeenCalledWith(mockTracks, 0, "curated", { kind: "album", name: "Great Album" });
    expect(mockPlayTrack).toHaveBeenCalledWith(mockTracks[0]);
  });

  it("e.stopPropagation() impede que o click borbulhe (delegacao Solid) ate um ancestral", async () => {
    const ancestorSpy = vi.fn();
    const { container } = render(() => (
      <div onClick={ancestorSpy}>
        <Home />
      </div>
    ));

    await vi.waitFor(() => {
      expect(container.querySelector(".card__play")).toBeTruthy();
    });

    const btn = container.querySelector(".card__play") as HTMLButtonElement;
    fireEvent.click(btn);

    expect(ancestorSpy).not.toHaveBeenCalled();
  });
});
