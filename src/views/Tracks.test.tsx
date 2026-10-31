/* ============================================================
   Tracks.test.tsx — aba Faixas: erro não é vazio (A7), a coluna é
   Playlist (A21) e o corte em 5.000 é dito (A39).
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

const { h } = vi.hoisted(() => ({
  h: {
    many: (n: number) => Array.from({ length: n }, (_, i) => ({
      id: String(i), title: `T${i}`, artist_name: "A", album_title: "B", album_cover_path: null,
      album_year: null, duration_ms: 1000, path: `/m/${i}.flac`, lrc_path: null, genre_name: "Rap",
    })),
  },
}));

vi.mock("../tauri", () => ({
  libListGenres: vi.fn(async () => [{ name: "Rap", track_count: 6200 }, { name: "Vazia", track_count: 0 }]),
  libGetTracks: vi.fn(async () => h.many(2)),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));
vi.mock("../store/player", () => ({
  setQueue: vi.fn(),
  player: { currentTrack: null, positionSecs: 0, durationSecs: 0, isPlaying: false },
}));
vi.mock("../components/PlayerBar", () => ({ playTrack: vi.fn() }));
vi.mock("../router", () => ({ navigate: vi.fn(), route: () => ({ path: "/library" }) }));

import Tracks, { TRACKS_LIMIT } from "./Tracks";
import * as tauri from "../tauri";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Tracks", () => {
  it("cabeçalho diz Playlist e o chip geral é Todas", async () => {
    const { container, findByText } = render(() => <Tracks />);
    await findByText("T0");
    const heads = Array.from(container.querySelectorAll(".tracks__head")).map((e) => e.textContent);
    expect(heads).toEqual(["#", "Título", "Álbum", "Playlist", "Duração"]);
    expect(container.querySelector(".chip")!.textContent).toBe("Todas");
    expect(container.querySelector(".tracks")!.getAttribute("role")).toBe("grid");
  });

  it("falha do índice: erro com Tentar de novo, nunca 'nenhuma faixa'", async () => {
    vi.mocked(tauri.libGetTracks).mockRejectedValueOnce(new Error("qdrant fora"));
    const { findByRole, container, findByText } = render(() => <Tracks />);
    const alert = await findByRole("alert");
    expect(container.textContent).not.toMatch(/nenhuma faixa/i);
    fireEvent.click(alert.querySelector("button")!);
    expect(await findByText("T0")).toBeTruthy();
  });

  it("playlist sem faixa diz isso e oferece voltar a todas", async () => {
    vi.mocked(tauri.libGetTracks).mockResolvedValueOnce(h.many(1)).mockResolvedValueOnce([]);
    const { findByText, getByRole } = render(() => <Tracks />);
    await findByText("T0");
    fireEvent.click(getByRole("button", { name: "Rap" }));
    expect(await findByText("Nenhuma faixa nesta playlist.")).toBeTruthy();
  });

  it("acima do teto, monta só o teto e diz quantas há", async () => {
    vi.mocked(tauri.libGetTracks).mockResolvedValueOnce(h.many(2)).mockResolvedValueOnce(h.many(TRACKS_LIMIT + 1));
    const { findByText, getByRole, container } = render(() => <Tracks />);
    await findByText("T0");
    fireEvent.click(getByRole("button", { name: "Rap" }));
    expect(await findByText(/Mostrando as primeiras 5\.000 de 6\.200 faixas/)).toBeTruthy();
    expect(container.querySelectorAll(".tracks__row").length).toBe(TRACKS_LIMIT);
    expect(tauri.libGetTracks).toHaveBeenLastCalledWith({ genre: "Rap", limit: TRACKS_LIMIT + 1 });
  }, 20_000);
});
