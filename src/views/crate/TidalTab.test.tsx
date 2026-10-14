/* ============================================================
   TidalTab.test.tsx — aba Tidal do Crate (spec 2026-10-14): busca com
   espera de 500 ms, descarte de resposta atrasada, link segue o
   fluxo de sempre, prévia com o acervo desmarcado e pedido só com
   as faixas marcadas.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor, screen } from "@solidjs/testing-library";
import type { TidalSearch, TidalTrack, TidalPreview, Track } from "../../tauri";

vi.mock("../../tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../tauri")>();
  return {
    ...actual,
    crateTidalSearch: vi.fn(),
    crateTidalArtist: vi.fn(),
    crateTidalPreview: vi.fn(),
    crateTidalCover: vi.fn(async () => "data:image/jpeg;base64,AA=="),
    crateTidalEnqueue: vi.fn(async () => "job-link"),
    crateTidalEnqueueSelection: vi.fn(async () => "job-sel"),
    libGetTracks: vi.fn(async () => [] as Track[]),
  };
});

import * as api from "../../tauri";
import TidalTab from "./TidalTab";

const mocks = vi.mocked(api);

function faixa(id: number, titulo: string, artista = "Orochi"): TidalTrack {
  return {
    id, titulo, artistas: [artista], album: "Celebridade", album_id: 1, ano: 2020, duracao_s: 180,
    hires: false, capa: null, url: `https://tidal.com/browse/track/${id}`,
  };
}

function busca(q: string, faixas: TidalTrack[]): TidalSearch {
  return { q, top: null, faixas, albuns: [], artistas: [], playlists: [] };
}

function libTrack(title: string, artist: string): Track {
  return {
    id: title, title, artist_name: artist, album_title: null, album_cover_path: null, album_year: null,
    duration_ms: 0, path: "", lrc_path: null,
  };
}

function renderTab() {
  return render(() => (
    <TidalTab jobs={[]} pastas={["Rap & Hip-Hop"]} load="loaded" loadError={null} refresh={() => {}} tokenMissing={false} />
  ));
}

function field() {
  return screen.getByLabelText("Buscar na Tidal ou colar link") as HTMLInputElement;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("kv-crate-tidal-dest", "Rap & Hip-Hop");
  vi.clearAllMocks();
  mocks.libGetTracks.mockResolvedValue([]);
  mocks.crateTidalCover.mockResolvedValue("data:image/jpeg;base64,AA==");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TidalTab", () => {
  it("estado vazio explica o campo único", () => {
    renderTab();
    expect(screen.getByText(/Cole um link da Tidal ou busque por faixa/)).toBeTruthy();
  });

  it("busca 500 ms depois da última tecla, uma vez só", async () => {
    vi.useFakeTimers();
    mocks.crateTidalSearch.mockResolvedValue(busca("orochi", [faixa(1, "Mitsubishi")]));
    renderTab();
    fireEvent.input(field(), { target: { value: "oro" } });
    vi.advanceTimersByTime(300);
    fireEvent.input(field(), { target: { value: "orochi" } });
    vi.advanceTimersByTime(499);
    expect(mocks.crateTidalSearch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mocks.crateTidalSearch).toHaveBeenCalledTimes(1);
    expect(mocks.crateTidalSearch).toHaveBeenCalledWith("orochi");
    vi.useRealTimers();
    await waitFor(() => expect(screen.getByText("Mitsubishi")).toBeTruthy());
  });

  it("descarta a resposta atrasada de uma busca antiga", async () => {
    let soltaAntiga!: (v: TidalSearch) => void;
    mocks.crateTidalSearch
      .mockImplementationOnce(() => new Promise((res) => { soltaAntiga = res; }))
      .mockResolvedValueOnce(busca("orochi", [faixa(2, "Nova")]));
    renderTab();
    fireEvent.input(field(), { target: { value: "oro" } });
    fireEvent.submit(field().form!);
    fireEvent.input(field(), { target: { value: "orochi" } });
    fireEvent.submit(field().form!);
    await waitFor(() => expect(screen.getByText("Nova")).toBeTruthy());
    soltaAntiga(busca("oro", [faixa(3, "Antiga")]));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText("Antiga")).toBeNull();
    expect(screen.getByText("Nova")).toBeTruthy();
  });

  it("link da Tidal não busca: Baixar enfileira o link", async () => {
    renderTab();
    fireEvent.input(field(), { target: { value: "https://tidal.com/browse/mix/abc123" } });
    fireEvent.submit(field().form!);
    await waitFor(() => expect(mocks.crateTidalEnqueue).toHaveBeenCalledWith("https://tidal.com/browse/mix/abc123", "Rap & Hip-Hop"));
    expect(mocks.crateTidalSearch).not.toHaveBeenCalled();
  });

  it("prévia desmarca o que está no acervo e pede só as marcadas", async () => {
    mocks.libGetTracks.mockResolvedValue([libTrack("Mitsubishi", "Orochi")]);
    mocks.crateTidalSearch.mockResolvedValue(busca("orochi", [faixa(1, "Mitsubishi")]));
    const previa: TidalPreview = {
      tipo: "radio", titulo: "Rádio de Mitsubishi", ref: "radio-faixa:1", duracao_s: 540,
      faixas: [faixa(1, "Mitsubishi"), faixa(2, "Balão"), faixa(3, "Amor de Fim de Noite")],
    };
    mocks.crateTidalPreview.mockResolvedValue(previa);
    renderTab();
    fireEvent.input(field(), { target: { value: "orochi" } });
    fireEvent.submit(field().form!);
    await waitFor(() => expect(screen.getByText("Mitsubishi")).toBeTruthy());
    fireEvent.click(screen.getByText("Rádio"));
    await waitFor(() => expect(mocks.crateTidalPreview).toHaveBeenCalledWith("radio-faixa:1"));
    await waitFor(() => expect(screen.getByText("Balão")).toBeTruthy());
    const boxes = () => [...document.querySelectorAll<HTMLInputElement>(".tdl-row--pick input[type=checkbox]")];
    await waitFor(() => expect(boxes().map((b) => b.checked)).toEqual([false, true, true]));
    expect(screen.getByText("2 de 3")).toBeTruthy();
    fireEvent.click(boxes()[2]); // desmarca "Amor de Fim de Noite"
    fireEvent.click(screen.getByRole("button", { name: /Baixar 1/ }));
    await waitFor(() =>
      expect(mocks.crateTidalEnqueueSelection).toHaveBeenCalledWith([2], "Rádio de Mitsubishi", "radio-faixa:1", "Rap & Hip-Hop"),
    );
  });
});
