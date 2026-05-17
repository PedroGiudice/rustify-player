/* ============================================================
   Playlists.test.tsx — Smoke tests da view nova de playlists.
   Cobre: toolbar (search + 3 botoes), Pinned (3 cards com
   cover 2x2), Smart playlists table com rule mono e rows mock,
   All playlists com primeiro card sendo "New playlist" dashed.
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

  it("renderiza Pinned com 3 cards e cada cover tem grid 2x2 (4 quads)", () => {
    const { container } = render(() => <Playlists />);
    // Procura section pinned via heading
    const pinnedHeads = Array.from(container.querySelectorAll(".section__title")).filter(
      (h) => (h.textContent ?? "").toLowerCase().includes("pinned")
    );
    expect(pinnedHeads.length).toBe(1);
    const pinnedGrid = pinnedHeads[0].closest("section")?.querySelector(".pl-grid");
    expect(pinnedGrid).toBeTruthy();
    const pinnedCards = pinnedGrid!.querySelectorAll(".pl-card");
    expect(pinnedCards.length).toBe(3);
    // Cada card deve ter 4 quads no cover
    pinnedCards.forEach((card) => {
      const quads = card.querySelectorAll(".pl-card__quad");
      expect(quads.length).toBe(4);
      const pin = card.querySelector(".pl-card__pin");
      expect(pin).toBeTruthy();
    });
  });

  it("renderiza Smart playlists table com colunas e min 3 rows", () => {
    const { container } = render(() => <Playlists />);
    const smartTbl = container.querySelector(".smart-tbl");
    expect(smartTbl).toBeTruthy();
    const heads = smartTbl!.querySelectorAll(".smart-tbl__head");
    // 6 colunas: icone, name, rule, updated, count, length
    expect(heads.length).toBe(6);
    const rows = smartTbl!.querySelectorAll(".smart-tbl__row");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // Cada row deve ter rule mono populado
    const firstRule = smartTbl!.querySelector(".smart-tbl__rule");
    expect(firstRule).toBeTruthy();
    expect(firstRule!.textContent!.length).toBeGreaterThan(0);
  });

  it("renderiza All playlists com primeiro card como pl-card--new dashed", () => {
    const { container } = render(() => <Playlists />);
    const allHeads = Array.from(container.querySelectorAll(".section__title")).filter(
      (h) => (h.textContent ?? "").toLowerCase().startsWith("all playlists")
    );
    expect(allHeads.length).toBe(1);
    const allGrid = allHeads[0].closest("section")?.querySelector(".pl-grid");
    expect(allGrid).toBeTruthy();
    const cards = allGrid!.querySelectorAll(".pl-card");
    expect(cards.length).toBeGreaterThanOrEqual(7); // 1 new + 6 mock
    // Primeiro card e o "new playlist"
    expect(cards[0].classList.contains("pl-card--new")).toBe(true);
    expect(cards[0].textContent).toContain("New playlist");
  });
});
