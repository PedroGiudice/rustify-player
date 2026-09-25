/* ============================================================
   Library.test.tsx — Contrato da view Library (abas + cabeçalho).
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const { mockSnap, mockGenres, mockAlbums, mockArtists } = vi.hoisted(() => ({
  mockAlbums: Array.from({ length: 7 }, (_, i) => ({ title: `A${i}`, artist_name: "X", cover_path: null, year: null, track_count: 1 })),
  mockArtists: Array.from({ length: 4 }, (_, i) => ({ name: `R${i}`, track_count: 1, album_count: 1 })),
  mockSnap: { tracks_total: 1757, embeddings_done: 1700, embeddings_pending: 57, embeddings_failed: 0, scan_in_progress: false },
  mockGenres: [
    { name: "Rap nacional contemporâneo", track_count: 42 },
    { name: "Vazio", track_count: 0 },
  ],
}));

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ current_track: null, current_library_track: null, is_playing: false }),
  getTrackColor: vi.fn().mockResolvedValue(""),
  libSnapshot: vi.fn().mockResolvedValue(mockSnap),
  libListGenres: vi.fn().mockResolvedValue(mockGenres),
  libGetAlbums: vi.fn().mockResolvedValue(mockAlbums),
  libGetArtists: vi.fn().mockResolvedValue(mockArtists),
  libGetTracks: vi.fn().mockResolvedValue([]),
  libGetTracksByAlbum: vi.fn().mockResolvedValue([]),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

vi.mock("../store/player", () => ({
  setQueue: vi.fn(),
  player: { currentTrack: null, positionSecs: 0, durationSecs: 0, isPlaying: false },
}));

vi.mock("../components/PlayerBar", () => ({ playTrack: vi.fn() }));

vi.mock("../router", () => ({
  navigate: vi.fn(),
  route: () => ({ path: "/library" }),
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { play: "play" },
}));

import Library from "./Library";
import * as tauri from "../tauri";

afterEach(() => {
  cleanup();
});

describe("Library — aba Genres", () => {
  it("linhas de gênero são informativas e de coluna única (sem o grid de faixa do .row)", async () => {
    const { container, getByText } = render(() => <Library />);
    await vi.waitFor(() => expect(container.querySelector(".tab__count")).toBeTruthy());
    const tab = Array.from(container.querySelectorAll(".tab")).find((b) => b.textContent?.startsWith("Genres"))!;
    fireEvent.click(tab);

    await vi.waitFor(() => expect(getByText("Rap nacional contemporâneo")).toBeTruthy());
    const rows = container.querySelectorAll(".view__body .row");
    expect(rows.length).toBe(1); // gênero com 0 faixas fica fora
    expect(rows[0].classList.contains("row--static")).toBe(true);
  });
});

describe("Library — contagens do cabeçalho e das abas", () => {
  function tabCount(container: HTMLElement, label: string) {
    const tab = Array.from(container.querySelectorAll(".tab")).find((b) => b.textContent?.startsWith(label))!;
    return tab.querySelector(".tab__count")?.textContent;
  }

  it("álbuns e artistas vêm das listagens reais (o snapshot não tem esses totais)", async () => {
    const { container } = render(() => <Library />);
    await vi.waitFor(() => expect(tabCount(container, "Albums")).toBe("7"));
    expect(tabCount(container, "Artists")).toBe("4");
    expect(container.querySelector(".view__head-hint")!.textContent).toContain("7 albums");
    expect(tauri.libGetAlbums).toHaveBeenCalledWith({ limit: null });
    expect(tauri.libGetArtists).toHaveBeenCalledWith({ limit: null });
  });

  it("listagem indisponível vira '—', nunca um número inventado", async () => {
    vi.mocked(tauri.libGetAlbums).mockRejectedValueOnce(new Error("indexer fora"));
    vi.mocked(tauri.libGetArtists).mockRejectedValueOnce(new Error("indexer fora"));
    const { container } = render(() => <Library />);
    await vi.waitFor(() => expect(tabCount(container, "Tracks")).toBe("1,757"));
    expect(tabCount(container, "Albums")).toBe("—");
    expect(tabCount(container, "Artists")).toBe("—");
  });
});

describe("Library — uma varredura por listagem", () => {
  // lib_list_albums/lib_list_artists varrem a coleção inteira do Qdrant.
  // A contagem das abas e a própria aba buscavam a mesma lista duas vezes
  // (revisão da fase 0, 25/09).
  function openTab(container: HTMLElement, label: string) {
    const tab = Array.from(container.querySelectorAll(".tab")).find((b) => b.textContent?.startsWith(label))!;
    fireEvent.click(tab);
  }

  it("a aba Albums reusa a listagem da contagem", async () => {
    vi.mocked(tauri.libGetAlbums).mockClear();
    const { container } = render(() => <Library />);
    await vi.waitFor(() => expect(container.querySelector(".tab__count")).toBeTruthy());
    openTab(container, "Albums");
    await vi.waitFor(() => expect(container.querySelectorAll(".card").length).toBe(7));
    expect(tauri.libGetAlbums).toHaveBeenCalledTimes(1);
  });

  it("a aba Artists reusa a listagem da contagem", async () => {
    vi.mocked(tauri.libGetArtists).mockClear();
    const { container } = render(() => <Library />);
    await vi.waitFor(() => expect(container.querySelector(".tab__count")).toBeTruthy());
    openTab(container, "Artists");
    await vi.waitFor(() => expect(container.querySelectorAll(".card").length).toBe(4));
    expect(tauri.libGetArtists).toHaveBeenCalledTimes(1);
  });
});

describe("Library — semântica das abas", () => {
  it("cada aba é role=tab e só a ativa tem aria-selected=true", async () => {
    const { container } = render(() => <Library />);
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tablist"] > button'));
    expect(tabs.length).toBe(4);
    for (const t of tabs) expect(t.getAttribute("role")).toBe("tab");
    const selected = () => tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent?.split(" ")[0]);
    expect(selected()).toEqual(["Tracks"]);
    fireEvent.click(tabs[3]);
    expect(selected()).toEqual(["Genres"]);
  });

  it("a aba ativa aponta para o painel que ela controla", async () => {
    const { container } = render(() => <Library />);
    const active = container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
    const panel = document.getElementById(active.getAttribute("aria-controls")!);
    expect(panel?.getAttribute("role")).toBe("tabpanel");
  });
});
