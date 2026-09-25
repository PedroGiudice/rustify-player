/* ============================================================
   LibraryCatalog.test.tsx — A navegação por álbuns e artistas não
   pode cortar o acervo em silêncio.

   O backend (query.rs list_albums/list_artists) ordena por nome e
   trunca no `limit`. O mock abaixo replica essa semântica e o default
   dos wrappers (500 quando o limit é omitido; `null` = tudo), então o
   acervo de teste passa do corte e um álbum/artista "do fim do
   alfabeto" só aparece se a view pedir o acervo inteiro ou filtrar no
   backend.
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

const { ALBUMS, ARTISTS, routeState } = vi.hoisted(() => {
  const pad = (n: number) => String(n).padStart(3, "0");
  const albums = Array.from({ length: 640 }, (_, i) => ({
    title: `Album ${pad(i)}`,
    artist_name: `Artist ${pad(i % 320)}`,
    cover_path: `/covers/${pad(i)}.webp`,
    year: 2000 + (i % 20),
    track_count: 10,
  }));
  // Fim do alfabeto: cai depois de qualquer corte em 300 ou 500.
  albums.push({ title: "Zulu", artist_name: "Zeta", cover_path: "/covers/zulu.webp", year: 1999, track_count: 7 });
  const artists = Array.from({ length: 560 }, (_, i) => ({
    name: `Artist ${pad(i)}`,
    track_count: 5,
    album_count: 1,
  }));
  artists.push({ name: "Zeta", track_count: 7, album_count: 1 });
  return { ALBUMS: albums, ARTISTS: artists, routeState: { path: "/albums", param: undefined as string | undefined } };
});

function applyLimit<T>(list: T[], limit: number | null | undefined, dflt: number): T[] {
  const l = limit === undefined ? dflt : limit;
  return l == null ? list : list.slice(0, l);
}
const byTitle = (a: { title: string }, b: { title: string }) => a.title.toLowerCase().localeCompare(b.title.toLowerCase());

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ current_track: null, current_library_track: null, is_playing: false }),
  getTrackColor: vi.fn().mockResolvedValue(""),
  libGetAlbums: vi.fn(async (opts?: { artist?: string; limit?: number | null }) => {
    let list = [...ALBUMS].sort(byTitle);
    if (opts?.artist) list = list.filter((a) => a.artist_name === opts.artist);
    return applyLimit(list, opts?.limit, 500);
  }),
  libGetAlbumsByArtist: vi.fn(async (artist: string, limit?: number | null) =>
    applyLimit([...ALBUMS].sort(byTitle).filter((a) => a.artist_name === artist), limit, 100)),
  libGetArtists: vi.fn(async (opts?: { limit?: number | null }) =>
    applyLimit([...ARTISTS].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())), opts?.limit, 500)),
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
  route: () => ({ path: routeState.path, param: routeState.param }),
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { play: "play" },
}));

import Albums from "./Albums";
import Artists from "./Artists";
import ArtistView from "./Artist";
import AlbumView from "./Album";

afterEach(() => {
  cleanup();
});

describe("acervo inteiro na navegação por álbuns e artistas", () => {
  it("a grade de álbuns mostra todos os álbuns, inclusive os do fim do alfabeto", async () => {
    routeState.path = "/albums";
    const { container } = render(() => <Albums />);
    await vi.waitFor(() => expect(container.querySelectorAll(".card").length).toBe(ALBUMS.length));
    const titles = Array.from(container.querySelectorAll(".card__title")).map((e) => e.textContent);
    expect(titles).toContain("Zulu");
  });

  it("a grade de artistas mostra todos os artistas", async () => {
    routeState.path = "/artists";
    const { container } = render(() => <Artists />);
    await vi.waitFor(() => expect(container.querySelectorAll(".card").length).toBe(ARTISTS.length));
  });

  it("a página do artista lista o álbum dele mesmo fora do corte alfabético", async () => {
    routeState.path = "/artist";
    routeState.param = encodeURIComponent("Zeta");
    const { container } = render(() => <ArtistView />);
    await vi.waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".card__title")).map((e) => e.textContent);
      expect(titles).toEqual(["Zulu"]);
    });
    expect(container.querySelector(".view__head-hint")?.textContent).toBe("1 albums");
  });

  it("a página de um álbum do fim do alfabeto mostra capa e artista", async () => {
    routeState.path = "/album";
    routeState.param = encodeURIComponent("Zulu");
    const { container } = render(() => <AlbumView />);
    await vi.waitFor(() => {
      expect(container.querySelector(".view__head img")?.getAttribute("src")).toBe("/covers/zulu.webp");
    });
    expect(container.querySelector(".view__head-hint")?.textContent).toContain("Zeta");
  });
});
