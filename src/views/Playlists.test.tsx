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
    expect(getByPlaceholderText("Filter playlists…")).toBeTruthy();
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
        (h) => (h.textContent ?? "").toLowerCase().startsWith("all playlists"),
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
      expect(titles).toContain("Pinned");
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
    return links.find((l) => (l.textContent ?? "").includes("Sort")) as HTMLElement;
  }

  it("renderiza o link 'Sort by name' na secao All playlists", async () => {
    const { container } = render(() => <Playlists />);
    await vi.waitFor(() => {
      expect(getSortLink(container)).toBeTruthy();
    });
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
    expect(sortLink.textContent).toContain("↑"); // indicador A→Z ativo

    // Segundo clique: Z→A
    fireEvent.click(sortLink);
    const afterSecondClick = getCardNames(container);
    const sortedZA = [...sortedAZ].reverse();
    expect(afterSecondClick).toEqual(sortedZA);
    expect(sortLink.textContent).toContain("↓"); // indicador Z→A ativo

    // Terceiro clique: volta a sem sort (ordem original)
    fireEvent.click(sortLink);
    const afterThirdClick = getCardNames(container);
    expect(afterThirdClick).toEqual(initialOrder);
  });
});
