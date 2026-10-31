/* SelectionBar: respiro da vista enquanto a barra existe (A41) e foco de
   volta à linha quando a barra some com o foco dentro (A35). */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../tauri", () => ({ setVolume: vi.fn(), playerEnqueueNext: vi.fn() }));

import { SelectionBar } from "./SelectionBar";
import { resetSelection, toggleTrack } from "../store/selection";
import type { Track } from "../tauri";

const mk = (id: string): Track => ({
  id, title: id, artist_name: null, album_title: null, album_cover_path: null, album_year: null,
  duration_ms: 1, path: `/m/${id}`, lrc_path: null,
});
const LIST = ["1", "2"].map(mk);

afterEach(() => { resetSelection(); cleanup(); document.body.innerHTML = ""; });

describe("SelectionBar", () => {
  it("marca o <html> enquanto há seleção, para a vista ganhar respiro embaixo (A41)", () => {
    render(() => <SelectionBar />);
    expect(document.documentElement.hasAttribute("data-selbar")).toBe(false);
    toggleTrack(LIST, "1");
    expect(document.documentElement.hasAttribute("data-selbar")).toBe(true);
    resetSelection();
    expect(document.documentElement.hasAttribute("data-selbar")).toBe(false);
  });

  it("Limpar pelo teclado devolve o foco à linha de onde ele veio", () => {
    const row = document.createElement("div");
    row.tabIndex = 0;
    document.body.appendChild(row);
    const { getByText } = render(() => <SelectionBar />);
    row.focus();
    toggleTrack(LIST, "1");
    const limpar = getByText("Limpar").closest("button")!;
    limpar.focus();
    fireEvent.focusIn(limpar, { relatedTarget: row });
    fireEvent.click(limpar);
    expect(document.activeElement).toBe(row);
  });
});
