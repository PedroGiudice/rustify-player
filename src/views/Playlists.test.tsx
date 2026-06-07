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
  libListFolders: vi.fn().mockResolvedValue(mockFolders),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

import Playlists from "./Playlists";

afterEach(() => {
  cleanup();
});

describe("Playlists view", () => {
  it("renderiza heading e subtitle", () => {
    const { getByText } = render(() => <Playlists />);
    expect(getByText("Playlists")).toBeTruthy();
  });

  it("renderiza toolbar com search input e 2 botoes (sem Recently played)", () => {
    const { container, getByPlaceholderText } = render(() => <Playlists />);
    expect(container.querySelector(".coll-toolbar")).toBeTruthy();
    expect(getByPlaceholderText("Filter playlists…")).toBeTruthy();
    const buttons = container.querySelectorAll(".coll-toolbar .sig-pbtn");
    expect(buttons.length).toBe(2);
    const labels = Array.from(buttons).map((b) => b.textContent ?? "");
    expect(labels.some((t) => t.includes("New playlist"))).toBe(true);
    expect(labels.some((t) => t.includes("New smart playlist"))).toBe(true);
    // item 1.4: o botao zumbi "Recently played" foi removido
    expect(labels.some((t) => t.includes("Recently played"))).toBe(false);
  });

  it("renderiza Smart playlists table com 6 heads e 3 rows preview", () => {
    const { container } = render(() => <Playlists />);
    const smartTbl = container.querySelector(".smart-tbl");
    expect(smartTbl).toBeTruthy();
    const heads = smartTbl!.querySelectorAll(".smart-tbl__head");
    expect(heads.length).toBe(6);
    const rows = smartTbl!.querySelectorAll(".smart-tbl__row");
    expect(rows.length).toBe(3);
    const firstRule = smartTbl!.querySelector(".smart-tbl__rule");
    expect(firstRule).toBeTruthy();
    expect(firstRule!.textContent!.length).toBeGreaterThan(0);
  });

  it("renderiza All playlists section com card pl-card--new dashed", () => {
    const { container } = render(() => <Playlists />);
    const allHeads = Array.from(container.querySelectorAll(".section__title")).filter(
      (h) => (h.textContent ?? "").toLowerCase().startsWith("all playlists")
    );
    expect(allHeads.length).toBe(1);
    const allGrid = allHeads[0].closest("section")?.querySelector(".pl-grid");
    expect(allGrid).toBeTruthy();
    const cards = allGrid!.querySelectorAll(".pl-card");
    // O primeiro card e sempre o "new playlist" dashed
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(cards[0].classList.contains("pl-card--new")).toBe(true);
    expect(cards[0].textContent).toContain("New playlist");
  });
});

describe("Playlists — Sort by name", () => {
  function getCardNames(container: HTMLElement) {
    return Array.from(
      container.querySelectorAll(".pl-grid .pl-card:not(.pl-card--new) .pl-card__title"),
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
      const cards = container.querySelectorAll(".pl-grid .pl-card:not(.pl-card--new)");
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
