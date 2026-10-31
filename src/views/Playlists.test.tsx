/* ============================================================
   Playlists.test.tsx — Smoke tests da view + Sort by name.

   Mockamos lib_list_folders pra ter folders reais e exercitar a
   ordenacao do toggle "Sort by name". pins (localStorage vazio em
   jsdom) e router reais — sem mock desnecessario.
   ============================================================ */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

// Folders de teste em ordem NAO alfabetica, pra distinguir asc/desc/none.
const { mockFolders } = vi.hoisted(() => ({
  mockFolders: [
    { name: "Zoo Songs", track_count: 5, cover_path: null, cover_paths: [] },
    { name: "Alpha Tunes", track_count: 3, cover_path: null, cover_paths: [] },
    { name: "Middle Road", track_count: 8, cover_path: null, cover_paths: [] },
  ],
}));

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ current_track: null, current_library_track: null, is_playing: false }),
  getTrackColor: vi.fn().mockResolvedValue(""),
  libListFolders: vi.fn().mockResolvedValue(mockFolders),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

import Playlists from "./Playlists";
import { pins, unpinPlaylist, pinPlaylist } from "../store/pins";
import * as tauri from "../tauri";

afterEach(() => {
  cleanup();
  for (const n of pins()) unpinPlaylist(n);
});

describe("Playlists view", () => {
  it("renderiza heading e subtitle", () => {
    const { getByText } = render(() => <Playlists />);
    expect(getByText("Playlists")).toBeTruthy();
  });

  // lib-9 (auditoria 25/09): o principio do CEO e "implementar de verdade
  // ou remover limpo". Os testes antigos fixavam o mock de smart playlists
  // e os botoes sem acao; agora fixam a ausencia deles ate existir backend.
  it("toolbar tem so o filtro: sem New playlist / New smart playlist sem acao", () => {
    const { container, getByPlaceholderText } = render(() => <Playlists />);
    expect(container.querySelector(".coll-toolbar")).toBeTruthy();
    expect(getByPlaceholderText("Filtrar playlists…")).toBeTruthy();
    expect(container.querySelectorAll(".coll-toolbar button").length).toBe(0);
    expect(container.textContent).not.toContain("New playlist");
    expect(container.textContent).not.toContain("New smart playlist");
  });

  it("nao renderiza o mock de smart playlists nem o conta no cabecalho", () => {
    const { container } = render(() => <Playlists />);
    expect(container.querySelector(".smart-tbl")).toBeNull();
    expect(container.textContent).not.toMatch(/smart/i);
  });

  it("All playlists so tem playlists reais (sem o card tracejado de criar)", async () => {
    const { container } = render(() => <Playlists />);
    const allHead = () =>
      Array.from(container.querySelectorAll(".section__title")).find(
        (h) => (h.textContent ?? "").toLowerCase().startsWith("todas as playlists"),
      );
    await vi.waitFor(() => {
      const cards = allHead()!.closest("section")!.querySelectorAll(".pl-card");
      expect(cards.length).toBe(mockFolders.length);
    });
    expect(container.querySelector(".pl-card--new")).toBeNull();
  });

  it("secao Pinned nao tem o 'Reorder' sem acao", async () => {
    pinPlaylist("Alpha Tunes");
    const { container } = render(() => <Playlists />);
    await vi.waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".section__title")).map((h) => h.textContent);
      expect(titles).toContain("Fixadas");
    });
    expect(container.textContent).not.toContain("Reorder");
  });
});

describe("Playlists — Sort by name", () => {
  function getCardNames(container: HTMLElement) {
    return Array.from(
      container.querySelectorAll(".pl-grid .pl-card .pl-card__title"),
    ).map((el) => el.textContent ?? "");
  }

  function getSortLink(container: HTMLElement): HTMLElement {
    const links = Array.from(container.querySelectorAll(".section__action"));
    return links.find((l) => (l.textContent ?? "").startsWith("Orde")) as HTMLElement;
  }

  it("renderiza o link 'Sort by name' na secao All playlists", async () => {
    const { container } = render(() => <Playlists />);
    await vi.waitFor(() => {
      expect(getSortLink(container)).toBeTruthy();
    });
  });

  it("o Sort é um <button type=button> (o <a> sem href ficava fora da ordem de Tab)", async () => {
    const { container } = render(() => <Playlists />);
    await vi.waitFor(() => expect(getSortLink(container)).toBeTruthy());
    const sort = getSortLink(container);
    expect(sort.tagName).toBe("BUTTON");
    expect(sort.getAttribute("type")).toBe("button");
  });

  it("cliques sucessivos no Sort alternam entre A→Z, Z→A e ordem original", async () => {
    const { container } = render(() => <Playlists />);

    await vi.waitFor(() => {
      const cards = container.querySelectorAll(".pl-grid .pl-card");
      expect(cards.length).toBeGreaterThanOrEqual(3);
    });

    const sortLink = getSortLink(container);
    expect(sortLink).toBeTruthy();

    // Estado inicial: sem sort (ordem da API)
    const initialOrder = getCardNames(container);

    // Primeiro clique: A→Z
    fireEvent.click(sortLink);
    const afterFirstClick = getCardNames(container);
    const sortedAZ = [...mockFolders].map((f) => f.name).sort((a, b) => a.localeCompare(b));
    expect(afterFirstClick).toEqual(sortedAZ);
    expect(sortLink.textContent).toContain("A–Z"); // indicador A→Z ativo

    // Segundo clique: Z→A
    fireEvent.click(sortLink);
    const afterSecondClick = getCardNames(container);
    const sortedZA = [...sortedAZ].reverse();
    expect(afterSecondClick).toEqual(sortedZA);
    expect(sortLink.textContent).toContain("Z–A"); // indicador Z→A ativo

    // Terceiro clique: volta a sem sort (ordem original)
    fireEvent.click(sortLink);
    const afterThirdClick = getCardNames(container);
    expect(afterThirdClick).toEqual(initialOrder);
  });
});

describe("Playlists — card fixado (lib-26)", () => {
  it("mostra a contagem de faixas uma vez só", async () => {
    pinPlaylist("Middle Road");
    const { getByText } = render(() => <Playlists />);
    await vi.waitFor(() => expect(getByText("Fixadas")).toBeTruthy());
    const card = getByText("Fixadas").closest("section")!.querySelector<HTMLElement>(".pl-card")!;
    const hits = (card.textContent ?? "").match(/8 faixas/g) ?? [];
    expect(hits.length).toBe(1);
  });
});

describe("Playlists — filtro", () => {
  it("o filtro alcança também as fixadas", async () => {
    pinPlaylist("Alpha Tunes");
    pinPlaylist("Zoo Songs");
    const { container, getByPlaceholderText } = render(() => <Playlists />);
    const names = () =>
      Array.from(container.querySelectorAll(".pl-card .pl-card__title")).map((e) => e.textContent ?? "");
    await vi.waitFor(() => expect(names().length).toBe(3));

    fireEvent.input(getByPlaceholderText("Filtrar playlists…"), { target: { value: "zoo" } });
    await vi.waitFor(() => expect(names()).toEqual(["Zoo Songs"]));
  });
});

describe("cards de playlist: teclado (ds-2)", () => {
  // role=button + tabIndex=0 sem onKeyDown: o Tab parava no card, o leitor
  // anunciava "botão", e Enter/Espaço não abriam a playlist (o Espaço ainda
  // rolava a página). Depois o card virou role=button com o fixar aninhado:
  // Enter no fixar subia até o card, navegava e o preventDefault engolia o
  // clique nativo do fixar (regressão da revisão da fase 0). Agora abrir é
  // um <button> próprio (o nome), irmão do fixar — mesmo padrão do card de
  // station.
  async function firstCard(container: HTMLElement, sel: string) {
    await vi.waitFor(() => expect(container.querySelector(sel)).toBeTruthy());
    return container.querySelector<HTMLElement>(sel)!;
  }

  it("abrir é um botão de verdade e leva à playlist do card", async () => {
    window.location.hash = "";
    const { container } = render(() => <Playlists />);
    const card = await firstCard(container, ".pl-grid .pl-card");
    const open = card.querySelector<HTMLElement>(".pl-card__open")!;
    expect(open.tagName).toBe("BUTTON");
    expect(open.getAttribute("type")).toBe("button");
    const name = open.textContent!;
    fireEvent.click(open);
    expect(window.location.hash).toBe(`#/playlist/${encodeURIComponent(name)}`);
  });

  it("nenhum controle fica aninhado em outro: abrir e fixar são irmãos", async () => {
    const { container } = render(() => <Playlists />);
    const card = await firstCard(container, ".pl-grid .pl-card");
    expect(card.getAttribute("role")).toBeNull();
    expect(card.hasAttribute("tabindex")).toBe(false);
    const open = card.querySelector(".pl-card__open")!;
    const pin = card.querySelector(".pl-card__pin")!;
    expect(open.contains(pin)).toBe(false);
    expect(pin.contains(open)).toBe(false);
  });

  it("Enter e Espaço no botão de fixar não navegam nem engolem a ativação do fixar", async () => {
    window.location.hash = "";
    const { container } = render(() => <Playlists />);
    const card = await firstCard(container, ".pl-grid .pl-card");
    const pin = card.querySelector<HTMLElement>(".pl-card__pin")!;
    for (const key of ["Enter", " "]) {
      const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      pin.dispatchEvent(ev);
      // preventDefault no keydown cancelaria o clique nativo do <button>.
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(window.location.hash).toBe("");
    const name = card.querySelector(".pl-card__open")!.textContent!;
    fireEvent.click(pin);
    expect(pins()).toContain(name);
    expect(window.location.hash).toBe("");
  });

  it("card fixado também abre pelo botão", async () => {
    window.location.hash = "";
    pinPlaylist("Middle Road");
    const { getByText } = render(() => <Playlists />);
    await vi.waitFor(() => expect(getByText("Fixadas")).toBeTruthy());
    const pinnedCard = getByText("Fixadas").closest("section")!.querySelector<HTMLElement>(".pl-card")!;
    fireEvent.click(pinnedCard.querySelector(".pl-card__open")!);
    expect(window.location.hash).toBe(`#/playlist/${encodeURIComponent("Middle Road")}`);
  });
});

// A7: "Sem playlists." nunca aparecia ([] é verdadeiro) e falha parecia vazio.
describe("Playlists — carregando, erro, vazio e filtro sem resultado (A7)", () => {
  it("falha do índice mostra erro com Tentar de novo", async () => {
    vi.mocked(tauri.libListFolders).mockRejectedValueOnce(new Error("fora"));
    const { findByRole, container } = render(() => <Playlists />);
    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("Não consegui ler o acervo agora.");
    fireEvent.click(alert.querySelector("button")!);
    await vi.waitFor(() => expect(container.querySelectorAll(".pl-card").length).toBe(mockFolders.length));
  });

  it("sem pasta nenhuma diz como nasce uma playlist", async () => {
    vi.mocked(tauri.libListFolders).mockResolvedValueOnce([]);
    const { findByText } = render(() => <Playlists />);
    expect(await findByText("Nenhuma playlist ainda.")).toBeTruthy();
  });

  it("filtro sem resultado avisa e oferece limpar", async () => {
    const { container, getByPlaceholderText, findByText, getByRole } = render(() => <Playlists />);
    await vi.waitFor(() => expect(container.querySelectorAll(".pl-card").length).toBe(3));
    fireEvent.input(getByPlaceholderText("Filtrar playlists…"), { target: { value: "xyz" } });
    expect(await findByText('Nenhuma playlist com "xyz".')).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Limpar filtro" }));
    await vi.waitFor(() => expect(container.querySelectorAll(".pl-card").length).toBe(3));
  });
});

// A42: pasta com poucas capas não mostra quadrante vazio.
describe("Playlists — mosaico com poucas capas (A42)", () => {
  it("uma capa ocupa o quadro inteiro; sem capa, os tons", async () => {
    vi.mocked(tauri.libListFolders).mockResolvedValueOnce([
      { name: "Uma", track_count: 2, cover_path: "/c/1.webp", cover_paths: ["/c/1.webp"] },
      { name: "Nenhuma", track_count: 2, cover_path: null, cover_paths: [] },
    ]);
    const { container } = render(() => <Playlists />);
    await vi.waitFor(() => expect(container.querySelectorAll(".pl-card").length).toBe(2));
    const [uma, nenhuma] = Array.from(container.querySelectorAll(".pl-card"));
    const quads = uma.querySelectorAll(".pl-card__quad");
    expect(quads.length).toBe(1);
    expect(quads[0].classList.contains("pl-card__quad--full")).toBe(true);
    expect(nenhuma.querySelectorAll(".pl-card__quad--cover").length).toBe(0);
    expect(nenhuma.querySelectorAll(".pl-card__quad").length).toBe(4);
  });
});
