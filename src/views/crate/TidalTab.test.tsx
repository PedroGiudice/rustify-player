/* ============================================================
   TidalTab.test.tsx — aba Tidal do Crate (spec 2026-10-14): busca com
   espera de 500 ms, descarte de resposta atrasada, link segue o
   fluxo de sempre, prévia com o acervo desmarcado e pedido só com
   as faixas marcadas.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import type { TidalSearch, TidalTrack, TidalPreview, TidalJob, TidalAlbum, TidalArtistPage, Track } from "../../tauri";

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
    crateTidalResend: vi.fn(async () => "job-1"),
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

function renderTab(jobs: TidalJob[] = [], refresh: () => void = () => {}) {
  return render(() => (
    <TidalTab jobs={jobs} pastas={["Rap & Hip-Hop"]} load="loaded" loadError={null} refresh={refresh} tokenMissing={false} />
  ));
}

function job(over: Partial<TidalJob>): TidalJob {
  return {
    id: "20261014-101010", url: "", playlist: "Rap & Hip-Hop", status: "ok", added: "14/10 10:10", resumo: "",
    inicio: null, fim: null, titulo: "Rádio Orochi", origem: "mix:a", n_faixas: 18, ...over,
  };
}

function album(id: number, titulo: string): TidalAlbum {
  return { id, titulo, artista: "Orochi", ano: 2020, n_faixas: 3, duracao_s: 600, hires: false, tipo: "ep", capa: null, url: `https://tidal.com/browse/album/${id}` };
}

/** Abre a prévia de rádio de uma busca com `faixas`. */
async function abrePrevia(faixas: TidalTrack[]) {
  mocks.crateTidalSearch.mockResolvedValue(busca("orochi", [faixa(1, "Mitsubishi")]));
  mocks.crateTidalPreview.mockResolvedValue({
    tipo: "radio", titulo: "Rádio de Mitsubishi", ref: "radio-faixa:1", duracao_s: faixas.length * 180, faixas,
  });
  renderTab();
  fireEvent.input(field(), { target: { value: "orochi" } });
  fireEvent.submit(field().form!);
  await waitFor(() => expect(screen.getByText("Mitsubishi")).toBeTruthy());
  fireEvent.click(screen.getByText("Rádio"));
  await waitFor(() => expect(document.querySelector(".tdl-row--pick")).toBeTruthy());
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

  it("prévia com mais de 200 faixas: padrão marca 200, 'Marcar todas' trava o Baixar e avisa", async () => {
    await abrePrevia(Array.from({ length: 250 }, (_, i) => faixa(i + 1, `Faixa ${i + 1}`)));
    await waitFor(() => expect(screen.getByText("200 de 250")).toBeTruthy());
    expect(screen.getByText(/marcadas as 200 primeiras novas/)).toBeTruthy();
    const baixar = () => screen.getByRole("button", { name: /Baixar/ }) as HTMLButtonElement;
    expect(baixar().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Marcar todas" }));
    expect(screen.getByText("250 de 250")).toBeTruthy();
    expect(screen.getByText("máx. 200 por vez")).toBeTruthy();
    expect(baixar().disabled).toBe(true);
    fireEvent.click(baixar());
    expect(mocks.crateTidalEnqueueSelection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Só as novas" }));
    expect(baixar().disabled).toBe(false);
  });

  it("erro do enfileiramento da seleção aparece dentro do rodapé", async () => {
    mocks.crateTidalEnqueueSelection.mockRejectedValueOnce("fila indisponível (VM fora? http://x)");
    await abrePrevia([faixa(2, "Balão"), faixa(3, "Outra")]);
    await waitFor(() => expect(screen.getByText("2 de 2")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Baixar 2/ }));
    await waitFor(() => expect(document.querySelector(".tdl-foot [role=alert]")?.textContent).toContain("fila indisponível"));
  });

  it("Ctrl+A na prévia marca tudo mesmo sem foco numa caixa, mas não dentro do seletor de pasta", async () => {
    await abrePrevia([faixa(2, "Balão"), faixa(3, "Outra")]);
    await waitFor(() => expect(screen.getByText("2 de 2")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Desmarcar todas" }));
    expect(screen.getByText("0 de 2")).toBeTruthy();
    const selects = document.querySelectorAll<HTMLSelectElement>(".tdl-foot select");
    expect(fireEvent.keyDown(selects[0], { key: "a", ctrlKey: true })).toBe(true); // não foi interceptado
    expect(screen.getByText("0 de 2")).toBeTruthy();
    const page = document.querySelector<HTMLElement>(".tdl-page--preview")!;
    expect(fireEvent.keyDown(page, { key: "a", ctrlKey: true })).toBe(false); // preventDefault
    expect(screen.getByText("2 de 2")).toBeTruthy();
  });

  it("texto que fica curto descarta a resposta em voo e limpa o resultado", async () => {
    let solta!: (v: TidalSearch) => void;
    mocks.crateTidalSearch.mockImplementationOnce(() => new Promise((res) => { solta = res; }));
    renderTab();
    fireEvent.input(field(), { target: { value: "orochi" } });
    fireEvent.submit(field().form!);
    await waitFor(() => expect(screen.getByText("buscando…")).toBeTruthy());
    fireEvent.input(field(), { target: { value: "o" } });
    expect(screen.queryByText("buscando…")).toBeNull();
    solta(busca("orochi", [faixa(9, "Velha")]));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByText("Velha")).toBeNull();
    expect(screen.getByText(/Cole um link da Tidal ou busque/)).toBeTruthy();
  });

  it("Reenviar só aparece em seleção parcial ou que falhou e chama o comando", async () => {
    const refresh = vi.fn();
    renderTab([
      job({ id: "a", status: "parcial", titulo: "Parcial" }),
      job({ id: "b", status: "falhou", titulo: "Falhou" }),
      job({ id: "c", status: "ok", titulo: "Pronta" }),
      job({ id: "d", status: "parcial", titulo: null, n_faixas: null, url: "https://tidal.com/browse/mix/x" }),
    ], refresh);
    const botoes = screen.getAllByRole("button", { name: "Reenviar" });
    expect(botoes).toHaveLength(2); // o link parcial e a seleção pronta ficam sem o botão
    fireEvent.click(botoes[0]);
    await waitFor(() => expect(mocks.crateTidalResend).toHaveBeenCalledTimes(1));
    expect(mocks.crateTidalResend.mock.calls[0][0]).toMatch(/^[ab]$/);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("voltar da prévia mantém a página do artista (sem recarregar nem perder 'Mostrar todos')", async () => {
    const eps = Array.from({ length: 25 }, (_, i) => album(100 + i, `EP ${i + 1}`));
    const pagina: TidalArtistPage = {
      id: 5, nome: "Orochi", foto: null, url: "u", populares: [], albuns: [], eps_singles: eps,
      radio: { mix_id: "abc", n_faixas: 50 },
    };
    mocks.crateTidalSearch.mockResolvedValue({
      ...busca("orochi", []), artistas: [{ id: 5, nome: "Orochi", foto: null, url: "u" }],
    });
    mocks.crateTidalArtist.mockResolvedValue(pagina);
    mocks.crateTidalPreview.mockResolvedValue({ tipo: "radio", titulo: "Rádio de Orochi", ref: "mix:abc", duracao_s: 180, faixas: [faixa(1, "Mitsubishi")] });
    renderTab();
    fireEvent.input(field(), { target: { value: "orochi" } });
    fireEvent.submit(field().form!);
    await waitFor(() => expect(screen.getByText("Artista")).toBeTruthy());
    fireEvent.click(screen.getByText("Artista"));
    await waitFor(() => expect(screen.getByText("EP 20")).toBeTruthy());
    expect(screen.queryByText("EP 25")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Mostrar todos/ }));
    expect(screen.getByText("EP 25")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Rádio do artista/ }));
    await waitFor(() => expect(document.querySelector(".tdl-row--pick")).toBeTruthy());
    fireEvent.click(screen.getAllByTitle("Voltar (Esc)").at(-1)!); // o da prévia (a do artista segue montada, oculta)
    await waitFor(() => expect(screen.queryByText("Mitsubishi")).toBeNull());
    expect(screen.getByText("EP 25")).toBeTruthy();
    expect(mocks.crateTidalArtist).toHaveBeenCalledTimes(1);
  });

  it("fila fora com busca que falhou: um banner só, rosa, sem IP; campo e seletor apagados (A2)", async () => {
    const OFF = "A fila da Tidal na VM não respondeu. Sem ela não dá para baixar.";
    mocks.crateTidalSearch.mockRejectedValue(OFF);
    const [load, setLoad] = createSignal<"loading" | "loaded" | "error">("loaded");
    const refresh = vi.fn();
    render(() => (
      <TidalTab jobs={[]} pastas={["Rap & Hip-Hop"]} load={load()} loadError={load() === "error" ? OFF : null} refresh={refresh} tokenMissing={false} />
    ));
    fireEvent.input(field(), { target: { value: "orochi" } });
    fireEvent.submit(field().form!);
    // Com a lista carregada, o erro da busca aparece (o 503 "Tidal ocupada" não pode sumir).
    await waitFor(() => expect(document.querySelectorAll(".crate-banner")).toHaveLength(1));
    setLoad("error");
    await waitFor(() => expect(field().disabled).toBe(true));
    const banners = document.querySelectorAll(".crate-banner");
    expect(banners).toHaveLength(1);
    expect(banners[0].getAttribute("data-tone")).toBe("rose");
    expect(banners[0].textContent).toContain("não respondeu");
    expect(banners[0].textContent).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect((document.querySelector(".crate-tidal-select") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mocks.crateTidalSearch).toHaveBeenCalledTimes(2); // refaz a última busca junto
  });

  it("busca em andamento marca o campo (barra de progresso) e desmarca ao voltar (A2)", async () => {
    let solta!: (v: TidalSearch) => void;
    mocks.crateTidalSearch.mockImplementationOnce(() => new Promise((res) => { solta = res; }));
    renderTab();
    fireEvent.input(field(), { target: { value: "orochi" } });
    fireEvent.submit(field().form!);
    await waitFor(() => expect(document.querySelector(".tdl-field")!.getAttribute("data-busy")).toBe("true"));
    solta(busca("orochi", [faixa(1, "Mitsubishi")]));
    await waitFor(() => expect(document.querySelector(".tdl-field")!.hasAttribute("data-busy")).toBe(false));
  });
});
