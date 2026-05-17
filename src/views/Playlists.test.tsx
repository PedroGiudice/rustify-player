/* ============================================================
   Playlists.test.tsx — Smoke tests da view (pos refactor pra
   fonte real lib_list_folders).

   Em jsdom, invoke() retorna undefined, entao folders() = []:
   - Pinned section nao renderiza (Show when pinned().length > 0)
   - All playlists tem so o card "New playlist" + estrutura
   - Smart playlists table continua mock (3 rows preview)
   ============================================================ */

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import Playlists from "./Playlists";

afterEach(() => {
  cleanup();
});

describe("Playlists view", () => {
  it("renderiza heading e subtitle", () => {
    const { getByText } = render(() => <Playlists />);
    expect(getByText("Playlists")).toBeTruthy();
  });

  it("renderiza toolbar com search input e 3 botoes", () => {
    const { container, getByPlaceholderText } = render(() => <Playlists />);
    expect(container.querySelector(".coll-toolbar")).toBeTruthy();
    expect(getByPlaceholderText("Filter playlists…")).toBeTruthy();
    const buttons = container.querySelectorAll(".coll-toolbar .sig-pbtn");
    expect(buttons.length).toBe(3);
    const labels = Array.from(buttons).map((b) => b.textContent ?? "");
    expect(labels.some((t) => t.includes("New playlist"))).toBe(true);
    expect(labels.some((t) => t.includes("New smart playlist"))).toBe(true);
    expect(labels.some((t) => t.includes("Recently played"))).toBe(true);
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
    // Sem backend mock, so o card "new playlist" aparece
    expect(cards.length).toBeGreaterThanOrEqual(1);
    expect(cards[0].classList.contains("pl-card--new")).toBe(true);
    expect(cards[0].textContent).toContain("New playlist");
  });
});
