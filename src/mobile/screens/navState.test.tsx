/* ============================================================
   navState.test.tsx — o estado de navegação das telas sobrevive
   ao voltar (mobile-3).

   Voltar de uma subtela recria a tela de base (a rota mudou de
   verdade). Faceta da Library e termo/escopo da Search moravam em
   signals locais e voltavam ao default a cada remontagem; o "Ver
   todos" de Álbuns da Home caía na faceta Pastas.
   ============================================================ */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import type { Track } from "../types";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("../nav", () => ({
  navigate,
  back: vi.fn(),
}));

vi.mock("../store", () => {
  const album = {
    key: "a1",
    title: "Álbum Um",
    artist: "Fulano",
    year: 2020,
    cover: null,
    track_count: 1,
  };
  const t = {
    id: "1",
    title: "Faixa",
    artist_name: "Fulano",
    album_title: "Álbum Um",
    album_cover_path: null,
    album_year: 2020,
    duration_ms: 1000,
    path: "/m/1.opus",
    lrc_path: null,
    track_number: 1,
    genre_name: null,
    dominant_color: null,
    liked_at: null,
    like_updated_at: null,
  } as Track;
  return {
    albums: () => [album],
    artists: () => [{ name: "Fulano", cover: null, album_count: 1, track_count: 1 }],
    folders: () => [{ name: "Rap", track_count: 1 }],
    tracks: () => [t],
    favorites: () => [],
    recents: () => [],
    stations: () => [],
    libReady: () => true,
    libError: () => null,
    reloadLibrary: vi.fn(),
    pb: { trackId: null },
    playTrackFrom: vi.fn(),
    shuffleAll: vi.fn(),
  };
});

import { Library, libraryFacet } from "./Library";
import { Search } from "./Search";
import { Home } from "./Home";

afterEach(() => {
  cleanup();
  navigate.mockClear();
});

const isOn = (el: HTMLElement) => el.hasAttribute("data-on");

describe("Library", () => {
  it("a faceta escolhida sobrevive à remontagem (voltar de um álbum)", () => {
    const first = render(() => <Library />);
    fireEvent.click(first.getByText("Álbuns"));
    first.unmount();
    const again = render(() => <Library />);
    expect(isOn(again.getByText("Álbuns"))).toBe(true);
    expect(isOn(again.getByText("Pastas"))).toBe(false);
  });
});

describe("Search", () => {
  it("termo e escopo sobrevivem à remontagem (voltar de um artista)", () => {
    const first = render(() => <Search />);
    const input = first.getByPlaceholderText(/Faixas, álbuns/) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "fulano" } });
    fireEvent.click(first.getByRole("button", { name: "Artistas" }));
    first.unmount();
    const again = render(() => <Search />);
    expect((again.getByPlaceholderText(/Faixas, álbuns/) as HTMLInputElement).value).toBe("fulano");
    expect(isOn(again.getByRole("button", { name: "Artistas" }))).toBe(true);
  });
});

describe("Home", () => {
  it('"Ver todos" de Álbuns abre a Library na faceta Álbuns', () => {
    const h = render(() => <Home />);
    fireEvent.click(h.getByText(/Ver todos/));
    expect(navigate).toHaveBeenCalledWith("/library");
    expect(libraryFacet()).toBe("albums");
  });

  it('"Ver todas" de Pastas abre a Library na faceta Pastas', () => {
    const h = render(() => <Home />);
    fireEvent.click(h.getByText(/Ver todas/));
    expect(navigate).toHaveBeenCalledWith("/library");
    expect(libraryFacet()).toBe("folders");
  });
});

// A62: com o teclado aberto o campo era cru: "Enter" no lugar da lupa, sem
// limpar e sem nome para o leitor de tela.
describe("Search — campo com o teclado (A62)", () => {
  it("campo de busca nomeado, com a lupa no teclado", () => {
    const r = render(() => <Search />);
    const input = r.getByRole("searchbox", { name: "Buscar no acervo" }) as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("search");
    expect(input.getAttribute("enterkeyhint")).toBe("search");
  });

  it("limpar aparece com termo, apaga e devolve o foco ao campo", () => {
    const r = render(() => <Search />);
    const input = r.getByRole("searchbox", { name: "Buscar no acervo" }) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "algo" } });
    const clear = r.getByRole("button", { name: "Limpar a busca" });
    fireEvent.click(clear);
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(r.queryByRole("button", { name: "Limpar a busca" })).toBeNull();
  });
});
