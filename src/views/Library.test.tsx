/* ============================================================
   Library.test.tsx — Contrato da view Library (abas + cabeçalho).
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const { mockSnap, mockGenres, mockAlbums, mockArtists, mockNavigate } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
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
  libListLiked: vi.fn().mockResolvedValue([]),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

vi.mock("../store/player", () => ({
  setQueue: vi.fn(),
  player: { currentTrack: null, positionSecs: 0, durationSecs: 0, isPlaying: false },
}));

vi.mock("../components/PlayerBar", () => ({ playTrack: vi.fn() }));

vi.mock("../router", () => ({
  navigate: (...a: any[]) => mockNavigate(...a),
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

// O campo genre do índice é a pasta de primeiro nível: a aba lista as
// playlists e diz isso (A21).
describe("Library — aba Playlists (o antigo Genres)", () => {
  it("cada linha de playlist abre a playlist (B33), dentro da lista de vidro", async () => {
    const { container, getByText } = render(() => <Library />);
    await vi.waitFor(() => expect(container.querySelector(".tab__count")).toBeTruthy());
    const tab = Array.from(container.querySelectorAll(".tab")).find((b) => b.textContent?.startsWith("Playlists"))!;
    fireEvent.click(tab);

    await vi.waitFor(() => expect(getByText("Rap nacional contemporâneo")).toBeTruthy());
    const rows = container.querySelectorAll(".view__body .row");
    expect(rows.length).toBe(1); // gênero com 0 faixas fica fora
    expect(rows[0].tagName).toBe("BUTTON");
    expect(rows[0].closest(".row-list")).toBeTruthy();
    expect(rows[0].textContent).toContain("42 faixas");
    fireEvent.click(rows[0]);
    expect(mockNavigate).toHaveBeenCalledWith(`/playlist/${encodeURIComponent("Rap nacional contemporâneo")}`);
  });

  it("o cabeçalho conta playlists, não gêneros", async () => {
    const { container } = render(() => <Library />);
    await vi.waitFor(() => expect(container.querySelector(".view__head-hint")!.textContent).toContain("1 playlist"));
    expect(container.textContent).not.toMatch(/genres/i);
  });
});

describe("Library — contagens do cabeçalho e das abas", () => {
  function tabCount(container: HTMLElement, label: string) {
    const tab = Array.from(container.querySelectorAll(".tab")).find((b) => b.textContent?.startsWith(label))!;
    return tab.querySelector(".tab__count")?.textContent;
  }

  it("álbuns e artistas vêm das listagens reais (o snapshot não tem esses totais)", async () => {
    const { container } = render(() => <Library />);
    await vi.waitFor(() => expect(tabCount(container, "Álbuns")).toBe("7"));
    expect(tabCount(container, "Artistas")).toBe("4");
    expect(container.querySelector(".view__head-hint")!.textContent).toContain("7 álbuns");
    expect(tauri.libGetAlbums).toHaveBeenCalledWith({ limit: null });
    expect(tauri.libGetArtists).toHaveBeenCalledWith({ limit: null });
  });

  it("listagem indisponível vira '—', nunca um número inventado", async () => {
    vi.mocked(tauri.libGetAlbums).mockRejectedValueOnce(new Error("indexer fora"));
    vi.mocked(tauri.libGetArtists).mockRejectedValueOnce(new Error("indexer fora"));
    const { container } = render(() => <Library />);
    // Milhar em pt-BR fixo (A44): o toLocaleString() sem idioma dava "1,757".
    await vi.waitFor(() => expect(tabCount(container, "Faixas")).toBe("1.757"));
    expect(tabCount(container, "Álbuns")).toBe("—");
    expect(tabCount(container, "Artistas")).toBe("—");
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

  it("a aba Álbuns reusa a listagem da contagem", async () => {
    vi.mocked(tauri.libGetAlbums).mockClear();
    const { container } = render(() => <Library />);
    await vi.waitFor(() => expect(container.querySelector(".tab__count")).toBeTruthy());
    openTab(container, "Álbuns");
    await vi.waitFor(() => expect(container.querySelectorAll(".card").length).toBe(7));
    expect(tauri.libGetAlbums).toHaveBeenCalledTimes(1);
  });

  it("a aba Artistas reusa a listagem da contagem", async () => {
    vi.mocked(tauri.libGetArtists).mockClear();
    const { container } = render(() => <Library />);
    await vi.waitFor(() => expect(container.querySelector(".tab__count")).toBeTruthy());
    openTab(container, "Artistas");
    await vi.waitFor(() => expect(container.querySelectorAll(".card").length).toBe(4));
    expect(tauri.libGetArtists).toHaveBeenCalledTimes(1);
  });
});

describe("Library — semântica das abas", () => {
  it("cada aba é role=tab e só a ativa tem aria-selected=true", async () => {
    const { container } = render(() => <Library />);
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tablist"] > button'));
    expect(tabs.length).toBe(5);
    for (const t of tabs) expect(t.getAttribute("role")).toBe("tab");
    const selected = () => tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent?.split(" ")[0]);
    expect(selected()).toEqual(["Faixas"]);
    fireEvent.click(tabs[4]);
    expect(selected()).toEqual(["Playlists"]);
  });

  it("a aba ativa aponta para o painel que ela controla", async () => {
    const { container } = render(() => <Library />);
    const active = container.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
    const panel = document.getElementById(active.getAttribute("aria-controls")!);
    expect(panel?.getAttribute("role")).toBe("tabpanel");
  });
});

// A36: a lista de abas é uma parada do Tab e as setas andam entre elas.
describe("Library — teclado das abas (A36)", () => {
  it("só a ativa entra no Tab; seta para a direita seleciona e foca a próxima", async () => {
    const { container } = render(() => <Library />);
    const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    tabs()[0].focus();
    fireEvent.keyDown(tabs()[0], { key: "ArrowRight" });
    expect(tabs()[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs()[1]);
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    fireEvent.keyDown(tabs()[1], { key: "End" });
    expect(tabs()[4].getAttribute("aria-selected")).toBe("true");
  });
});

// B8: a aba Curtidas conta as curtidas e mostra a lista.
describe("Library — aba Curtidas (B8)", () => {
  it("busca as curtidas com teto alto e conta na aba", async () => {
    vi.mocked(tauri.libListLiked).mockResolvedValueOnce([
      { id: "1", title: "Curtida", artist_name: "X", album_title: null, album_cover_path: null, album_year: null, duration_ms: 1, path: "/1", lrc_path: null, liked_at: 5 },
    ]);
    const { container } = render(() => <Library />);
    const likedTab = () => Array.from(container.querySelectorAll(".tab")).find((b) => b.textContent?.startsWith("Curtidas"))!;
    await vi.waitFor(() => expect(likedTab().querySelector(".tab__count")?.textContent).toBe("1"));
    expect(tauri.libListLiked).toHaveBeenCalledWith(1000);
  });
});
