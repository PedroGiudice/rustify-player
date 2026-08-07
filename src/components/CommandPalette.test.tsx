/* ============================================================
   CommandPalette.test.tsx — ActionItem do Crate (D3).

   "Procurar "<q>" na rede →" sempre presente com query digitada,
   promovido ao topo quando a busca local não acha nada (spec §4.1).
   run() navega pra /crate/<q> e fecha o palette.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";

vi.mock("../components/PlayerBar", () => ({ playTrack: vi.fn() }));
vi.mock("../tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri")>();
  return {
    ...actual,
    libSearch: vi.fn(async () => ({ tracks: [], albums: [], artists: [] })),
    libShuffle: vi.fn(async () => []),
  };
});

import * as tauriApi from "../tauri";
import { CommandPalette, CMD_PALETTE_EVENT } from "./CommandPalette";

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
});

function openPalette() {
  window.dispatchEvent(new CustomEvent(CMD_PALETTE_EVENT));
}

describe("CommandPalette — ActionItem do Crate", () => {
  it("sem resultados locais, o item 'Procurar na rede' aparece no topo", async () => {
    vi.mocked(tauriApi.libSearch).mockResolvedValue({ tracks: [], albums: [], artists: [] } as any);
    const { container } = render(() => <CommandPalette />);
    openPalette();
    const input = container.querySelector(".palette__input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });

    await waitFor(() => {
      expect(tauriApi.libSearch).toHaveBeenCalledWith("sicko mode", 6);
    });

    await waitFor(() => {
      const first = container.querySelector(".palette__item");
      expect(first?.textContent).toContain('Procurar "sicko mode" na rede');
    });
  });

  it("com resultados locais, o item continua presente (não no topo)", async () => {
    vi.mocked(tauriApi.libSearch).mockResolvedValue({
      tracks: [{ id: "1", title: "Sicko Mode", artist_name: "Travis Scott", album_title: null, album_cover_path: null, album_year: null, duration_ms: 180000, path: "/a.flac", lrc_path: null }],
      albums: [],
      artists: [],
    } as any);
    const { container, getByText } = render(() => <CommandPalette />);
    openPalette();
    const input = container.querySelector(".palette__input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });

    await waitFor(() => {
      expect(tauriApi.libSearch).toHaveBeenCalledWith("sicko mode", 6);
    });
    await waitFor(() => {
      expect(getByText("Sicko Mode")).toBeTruthy();
    });
    const first = container.querySelector(".palette__item");
    expect(first?.textContent).not.toContain("Procurar");
    expect(getByText(/Procurar "sicko mode" na rede/)).toBeTruthy();
  });

  it("rodar o item navega pra /crate/<query> e fecha o palette", async () => {
    vi.mocked(tauriApi.libSearch).mockResolvedValue({ tracks: [], albums: [], artists: [] } as any);
    const { container } = render(() => <CommandPalette />);
    openPalette();
    const input = container.querySelector(".palette__input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });

    await waitFor(() => {
      expect(container.querySelector(".palette__item")?.textContent).toContain("Procurar");
    });
    fireEvent.click(container.querySelector(".palette__item")!);

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/crate/${encodeURIComponent("sicko mode")}`);
    });
    expect(container.querySelector('[data-open="true"]')).toBeFalsy();
  });

  it("sem query digitada, o item não aparece", async () => {
    const { container } = render(() => <CommandPalette />);
    openPalette();
    const items = Array.from(container.querySelectorAll(".palette__item")).map((el) => el.textContent ?? "");
    expect(items.some((t) => t.includes("Procurar"))).toBe(false);
  });
});
