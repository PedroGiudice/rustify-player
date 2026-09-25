/* ============================================================
   LibraryStandalone.test.tsx — Tracks, Albums e Artists servem a
   Library (como aba) e as rotas /tracks, /albums e /artists (vindas
   do "View all →" da Home e dos nomes no Now Playing).

   O unico container que rola e o .view (o .main tem overflow:hidden).
   Aberta direto, a view precisa trazer o proprio <article class="view">;
   como aba, a Library ja fornece o dela e um segundo .view aninhado
   criaria dois scrollers.
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

const { routeState } = vi.hoisted(() => ({ routeState: { path: "/albums" } }));

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ current_track: null, current_library_track: null, is_playing: false }),
  getTrackColor: vi.fn().mockResolvedValue(""),
  libGetAlbums: vi.fn().mockResolvedValue([]),
  libGetArtists: vi.fn().mockResolvedValue([]),
  libListGenres: vi.fn().mockResolvedValue([]),
  libGetTracks: vi.fn().mockResolvedValue([]),
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
  route: () => ({ path: routeState.path }),
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { play: "play" },
}));

import Albums from "./Albums";
import Tracks from "./Tracks";
import Artists from "./Artists";

afterEach(() => {
  cleanup();
});

const CASES = [
  { name: "Albums", path: "/albums", View: Albums, title: "Albums" },
  { name: "Tracks", path: "/tracks", View: Tracks, title: "Tracks" },
  { name: "Artists", path: "/artists", View: Artists, title: "Artists" },
] as const;

describe("views da biblioteca abertas direto", () => {
  for (const c of CASES) {
    it(`${c.path}: cabecalho e corpo dentro de um .view que rola`, () => {
      routeState.path = c.path;
      const { container } = render(() => <c.View />);
      const view = container.querySelector("article.view");
      expect(view, `${c.name} standalone sem .view`).toBeTruthy();
      expect(view!.querySelector(".view__head h1")?.textContent).toBe(c.title);
      expect(view!.querySelector(".view__body")).toBeTruthy();
    });

    it(`${c.name} como aba da Library: sem .view proprio (a Library ja rola)`, () => {
      routeState.path = "/library";
      const { container } = render(() => <c.View />);
      expect(container.querySelector(".view")).toBeNull();
      expect(container.querySelector(".view__head")).toBeNull();
      expect(container.querySelector(".view__body")).toBeTruthy();
    });
  }
});
