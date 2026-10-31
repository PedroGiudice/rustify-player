/* ============================================================
   LibraryGrids.test.tsx — grades de Álbuns e Artistas: filtro por texto
   e rosto do artista (B3).
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import type { Album, Artist } from "../tauri";
import type { Loaded } from "../lib/loaded";

vi.mock("../tauri", () => ({
  libGetAlbums: vi.fn(),
  libGetArtists: vi.fn(),
  libGetTracks: vi.fn().mockResolvedValue([]),
  coverUrl: (p: string | null) => (p ? `asset://${p}` : null),
}));
vi.mock("../store/player", () => ({ setQueue: vi.fn(), player: { currentTrack: null } }));
vi.mock("../components/PlayerBar", () => ({ playTrack: vi.fn() }));
vi.mock("../router", () => ({ navigate: vi.fn(), route: () => ({ path: "/library" }) }));

import Albums from "./Albums";
import Artists from "./Artists";

afterEach(cleanup);

const album = (title: string, artist: string): Album => ({ title, artist_name: artist, cover_path: null, year: null, track_count: 3 });

describe("Álbuns — filtro por texto (B3)", () => {
  it("filtra por título ou artista sem acento e diz quantos sobraram", () => {
    const list: Loaded<Album[]> = { ok: true, data: [album("Açúcar", "Céu"), album("Greatest Hits", "Queen"), album("Arrival", "ABBA")] };
    const { container, getByRole } = render(() => <Albums list={() => list} />);
    expect(container.querySelectorAll(".card")).toHaveLength(3);
    const input = getByRole("searchbox", { name: "Filtrar álbuns" });
    fireEvent.input(input, { target: { value: "ceu" } });
    expect(Array.from(container.querySelectorAll(".card__title")).map((e) => e.textContent)).toEqual(["Açúcar"]);
    expect(container.querySelector(".lib-filter__status")!.textContent).toBe("1 de 3");
  });

  it("filtro sem resultado oferece limpar; Esc também limpa", () => {
    const list: Loaded<Album[]> = { ok: true, data: [album("Arrival", "ABBA")] };
    const { container, getByRole, getByText } = render(() => <Albums list={() => list} />);
    const input = getByRole("searchbox", { name: "Filtrar álbuns" }) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "nirvana" } });
    expect(getByText('Nenhum álbum com "nirvana".')).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Limpar filtro" }));
    expect(container.querySelectorAll(".card")).toHaveLength(1);
    fireEvent.input(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });
});

describe("Artistas — rosto e filtro (B3)", () => {
  it("o cartão mostra a capa que o backend escolheu; sem capa, o cassete", () => {
    const list: Loaded<Artist[]> = {
      ok: true,
      data: [
        { name: "Queen", track_count: 12, album_count: 2, cover_path: "/c/opera.webp" },
        { name: "Sem Capa", track_count: 1, album_count: 0, cover_path: null },
      ],
    };
    const { container } = render(() => <Artists list={() => list} />);
    const cards = container.querySelectorAll(".card");
    expect(cards[0].querySelector("img.cover__img")?.getAttribute("src")).toBe("asset:///c/opera.webp");
    expect(cards[1].querySelector("img.cover__img")).toBeNull();
    expect(cards[0].querySelector(".card__sub")!.textContent).toBe("2 álbuns · 12 faixas");
  });

  it("filtra pelo nome", () => {
    const list: Loaded<Artist[]> = {
      ok: true,
      data: [
        { name: "Beyoncé", track_count: 1, album_count: 1 },
        { name: "Queen", track_count: 1, album_count: 1 },
      ],
    };
    const { container, getByRole } = render(() => <Artists list={() => list} />);
    fireEvent.input(getByRole("searchbox", { name: "Filtrar artistas" }), { target: { value: "beyonce" } });
    expect(Array.from(container.querySelectorAll(".card__title")).map((e) => e.textContent)).toEqual(["Beyoncé"]);
  });
});
