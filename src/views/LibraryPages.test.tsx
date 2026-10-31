/* ============================================================
   LibraryPages.test.tsx — páginas de Álbum, Artista e Playlist:
   homônimos (A19), faixas sem álbum (A19), Tocar no cabeçalho (A20),
   colunas por página (A20/A21) e estados de erro (A7).
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const { routeState, h } = vi.hoisted(() => {
  const t = (id: string, title: string, album: string | null, artist = "Queen") => ({
    id, title, artist_name: artist, album_title: album, album_cover_path: null, album_year: null,
    duration_ms: 1000, path: `/m/${id}.flac`, lrc_path: null, genre_name: "Rock",
  });
  return {
    routeState: { path: "/album", param: null as string | null },
    h: {
      t,
      navigate: vi.fn(),
      setQueue: vi.fn(),
      playTrack: vi.fn(),
      openMoveDialog: vi.fn(),
    },
  };
});

vi.mock("../tauri", () => ({
  libGetAlbums: vi.fn(async () => [
    { title: "Greatest Hits", artist_name: "ABBA", cover_path: "/c/abba.webp", year: 1992, track_count: 1 },
    { title: "Greatest Hits", artist_name: "Queen", cover_path: "/c/queen.webp", year: 1981, track_count: 1 },
  ]),
  libGetAlbumsByArtist: vi.fn(async (artist: string) =>
    artist === "Queen" ? [{ title: "Greatest Hits", artist_name: "Queen", cover_path: null, year: 1981, track_count: 1 }] : []),
  libGetTracks: vi.fn(async (o: { album?: string; artist?: string }) =>
    o.artist === "Queen" ? [h.t("q1", "Bohemian Rhapsody", "Greatest Hits")] : [h.t("a1", "Waterloo", "Greatest Hits", "ABBA")]),
  libGetTracksByArtist: vi.fn(async (artist: string) =>
    artist === "Queen"
      ? [h.t("solto", "Demo solta", null), h.t("q1", "Bohemian Rhapsody", "Greatest Hits")]
      : []),
  libListFolderTracks: vi.fn(async () => [h.t("p1", "Faixa", "Disco")]),
  libListFolders: vi.fn(async () => [{ name: "Rock", track_count: 1, cover_path: null, cover_paths: ["/c/1.webp"] }]),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

vi.mock("../store/player", () => ({
  setQueue: (...a: any[]) => h.setQueue(...a),
  player: { currentTrack: null, positionSecs: 0, durationSecs: 0, isPlaying: false },
}));
vi.mock("../components/PlayerBar", () => ({ playTrack: (...a: any[]) => h.playTrack(...a) }));
vi.mock("../store/moveDialog", () => ({
  libraryRevision: () => 0,
  openMoveDialog: (...a: any[]) => h.openMoveDialog(...a),
}));
vi.mock("../router", () => ({
  navigate: (...a: any[]) => h.navigate(...a),
  route: () => routeState,
}));

import AlbumView from "./Album";
import ArtistView from "./Artist";
import PlaylistView from "./Playlist";
import * as tauri from "../tauri";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Álbum — homônimos não se misturam (A19)", () => {
  it("rota com ?artista= abre o álbum desse artista e só as faixas dele", async () => {
    routeState.path = "/album";
    routeState.param = "Greatest%20Hits?artista=Queen";
    const { container, findByText } = render(() => <AlbumView />);
    expect(await findByText("Bohemian Rhapsody")).toBeTruthy();
    expect(container.textContent).not.toContain("Waterloo");
    expect(tauri.libGetTracks).toHaveBeenCalledWith({ album: "Greatest Hits", artist: "Queen", limit: 200 });
    await vi.waitFor(() => expect(container.querySelector(".view__head img")?.getAttribute("src")).toBe("/c/queen.webp"));
  });

  it("sem as colunas Álbum e Playlist, e Tocar toca o álbum", async () => {
    routeState.path = "/album";
    routeState.param = "Greatest%20Hits?artista=Queen";
    const { container, findByText, getByRole } = render(() => <AlbumView />);
    await findByText("Bohemian Rhapsody");
    const heads = Array.from(container.querySelectorAll(".tracks__head")).map((e) => e.textContent);
    expect(heads).toEqual(["#", "Título", "Duração"]);
    fireEvent.click(getByRole("button", { name: "Tocar" }));
    expect(h.setQueue).toHaveBeenCalledWith([expect.objectContaining({ id: "q1" })], 0, "curated", { kind: "album", name: "Greatest Hits" });
  });

  it("falha do índice mostra erro, não um álbum vazio", async () => {
    vi.mocked(tauri.libGetTracks).mockRejectedValueOnce(new Error("fora"));
    routeState.path = "/album";
    routeState.param = "Greatest%20Hits?artista=Queen";
    const { findByRole } = render(() => <AlbumView />);
    expect((await findByRole("alert")).textContent).toContain("Não consegui ler o acervo agora.");
  });
});

describe("Artista — faixas sem álbum e Tocar (A19, A20)", () => {
  it("faixa sem álbum aparece na sua seção; Mover e Tocar contam com ela", async () => {
    routeState.path = "/artist";
    routeState.param = "Queen";
    const { findByText, getByRole } = render(() => <ArtistView />);
    expect(await findByText("Faixas sem álbum")).toBeTruthy();
    expect(await findByText("Demo solta")).toBeTruthy();
    const move = getByRole("button", { name: "Mover para playlist…" }) as HTMLButtonElement;
    expect(move.disabled).toBe(false);
    fireEvent.click(move);
    expect(h.openMoveDialog.mock.calls[0][0]).toHaveLength(2);
    // Tocar: os álbuns primeiro, as soltas no fim.
    fireEvent.click(getByRole("button", { name: "Tocar" }));
    expect(h.setQueue.mock.calls[0][0].map((t: any) => t.id)).toEqual(["q1", "solto"]);
  });

  it("o card do álbum abre pelo nome, com o artista na rota (A18)", async () => {
    routeState.path = "/artist";
    routeState.param = "Queen";
    const { container } = render(() => <ArtistView />);
    await vi.waitFor(() => expect(container.querySelector(".card__open")).toBeTruthy());
    const open = container.querySelector(".card__open") as HTMLButtonElement;
    expect(open.tagName).toBe("BUTTON");
    fireEvent.click(open);
    expect(h.navigate).toHaveBeenCalledWith("/album/Greatest%20Hits?artista=Queen");
  });

  it("artista sem faixa nenhuma diz isso, sem Mover nem Tocar ativos", async () => {
    routeState.path = "/artist";
    routeState.param = "Ninguém";
    const { findByText, getByRole } = render(() => <ArtistView />);
    expect(await findByText("Nenhuma faixa deste artista no acervo.")).toBeTruthy();
    expect((getByRole("button", { name: "Tocar" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Playlist — sem a coluna de playlist (A21) e capa única no hero (A42)", () => {
  it("colunas e mosaico", async () => {
    routeState.path = "/playlist";
    routeState.param = "Rock";
    const { container, findByText } = render(() => <PlaylistView />);
    await findByText("Faixa");
    const heads = Array.from(container.querySelectorAll(".tracks__head")).map((e) => e.textContent);
    expect(heads).toEqual(["#", "", "Título", "Álbum", "Duração"]);
    await vi.waitFor(() => expect(container.querySelectorAll(".pl-hero-cover__quad").length).toBe(1));
    expect(container.querySelector(".pl-hero-cover__quad")!.classList.contains("pl-hero-cover__quad--full")).toBe(true);
  });
});

describe("Cabeçalho único de Álbum, Artista e Playlist (B2)", () => {
  it("Álbum: rótulo com o ano, título h1 e o artista nos números abre a página dele", async () => {
    routeState.path = "/album";
    routeState.param = "Greatest%20Hits?artista=Queen";
    const { container, findByText, getByRole } = render(() => <AlbumView />);
    await findByText("Bohemian Rhapsody");
    const head = container.querySelector(".lib-hero")!;
    await vi.waitFor(() => expect(head.querySelector(".lib-hero__kicker")!.textContent).toBe("Álbum · 1981"));
    expect(getByRole("heading", { level: 1 }).textContent).toBe("Greatest Hits");
    expect(head.querySelector(".lib-hero__stats")!.textContent).toContain("1 faixa");
    fireEvent.click(getByRole("button", { name: "Queen" }));
    expect(h.navigate).toHaveBeenCalledWith("/artist/Queen");
  });

  it("Artista: capa redonda com a capa do álbum dele com mais faixas", async () => {
    vi.mocked(tauri.libGetAlbumsByArtist).mockResolvedValueOnce([
      { title: "Jazz", artist_name: "Queen", cover_path: "/c/jazz.webp", year: 1978, track_count: 3 },
      { title: "A Night at the Opera", artist_name: "Queen", cover_path: "/c/opera.webp", year: 1975, track_count: 12 },
      { title: "Sem capa", artist_name: "Queen", cover_path: null, year: 1980, track_count: 20 },
    ]);
    routeState.path = "/artist";
    routeState.param = "Queen";
    const { container } = render(() => <ArtistView />);
    await vi.waitFor(() => expect(container.querySelector(".lib-hero__cover img.cover__img")?.getAttribute("src")).toBe("/c/opera.webp"));
    expect(container.querySelector(".lib-hero__cover")!.getAttribute("data-round")).toBe("true");
    expect(container.querySelector(".lib-hero__kicker")!.textContent).toBe("Artista");
    expect(container.querySelector(".lib-hero__stats")!.textContent).toContain("3 álbuns");
  });

  it("Playlist: mesmo cabeçalho, Fixar em português e Tocar por último", async () => {
    routeState.path = "/playlist";
    routeState.param = "Rock";
    const { container, findByText } = render(() => <PlaylistView />);
    await findByText("Faixa");
    const head = container.querySelector(".lib-hero")!;
    expect(head.querySelector(".lib-hero__kicker")!.textContent).toBe("Playlist");
    const buttons = Array.from(head.querySelectorAll(".lib-hero__actions button")).map((b) => b.textContent?.trim());
    expect(buttons).toEqual(["Fixar", "Tocar"]);
  });
});
