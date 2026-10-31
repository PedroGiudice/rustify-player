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
  // Memória única do Crate (B7); a chave antiga da Tidal ainda é lida.
  localStorage.setItem("kv-crate-dest", "Rap & Hip-Hop");
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

  it("prévia com mais de 200 faixas: marca todas e divide em pedidos de até 200 (B27)", async () => {
    await abrePrevia(Array.from({ length: 250 }, (_, i) => faixa(i + 1, `Faixa ${i + 1}`)));
    await waitFor(() => expect(screen.getByText("250 de 250")).toBeTruthy());
    expect(screen.getByText(/vai em 2 pedidos/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Baixar 250/ }));
    await waitFor(() => expect(mocks.crateTidalEnqueueSelection).toHaveBeenCalledTimes(2));
    const [a, b] = mocks.crateTidalEnqueueSelection.mock.calls;
    expect(a[0]).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(a.slice(1)).toEqual(["Rádio de Mitsubishi (parte 1 de 2)", "radio-faixa:1", "Rap & Hip-Hop"]);
    expect(b[0]).toEqual(Array.from({ length: 50 }, (_, i) => i + 201));
    expect(b[1]).toBe("Rádio de Mitsubishi (parte 2 de 2)");
    // Tudo foi: a prévia fecha e o aviso conta as faixas e os pedidos.
    await waitFor(() => expect(document.querySelector(".tdl-row--pick")).toBeNull());
    expect(screen.getByText(/250 faixas de "Rádio de Mitsubishi" foram para a fila em 2 pedidos/)).toBeTruthy();
  });

  it("lote dividido que falha no meio: o que foi sai da seleção, o resto fica marcado (B27)", async () => {
    mocks.crateTidalEnqueueSelection
      .mockResolvedValueOnce("job-1")
      .mockRejectedValueOnce("fila indisponível");
    await abrePrevia(Array.from({ length: 250 }, (_, i) => faixa(i + 1, `Faixa ${i + 1}`)));
    await waitFor(() => expect(screen.getByText("250 de 250")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Baixar 250/ }));
    await waitFor(() => expect(document.querySelector(".tdl-foot [role=alert]")?.textContent).toContain("1 de 2 pedidos"));
    expect(document.querySelector(".tdl-foot [role=alert]")!.textContent).toContain("fila indisponível");
    expect(screen.getByText("50 de 250")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Baixar 50/ })).toBeTruthy();
  });

  it("Shift+clique marca ou desmarca o intervalo inteiro (B27)", async () => {
    await abrePrevia([1, 2, 3, 4, 5].map((i) => faixa(i, `F${i}`)));
    await waitFor(() => expect(screen.getByText("5 de 5")).toBeTruthy());
    const boxes = () => [...document.querySelectorAll<HTMLInputElement>(".tdl-row--pick input[type=checkbox]")];
    fireEvent.click(boxes()[1]); // desmarca F2: âncora
    fireEvent.click(boxes()[3], { shiftKey: true }); // F4 desmarca, e F3 junto
    expect(boxes().map((b) => b.checked)).toEqual([true, false, false, false, true]);
    expect(screen.getByText("2 de 5")).toBeTruthy();
    fireEvent.click(boxes()[4], { shiftKey: true }); // F5 desmarca a partir da âncora F4
    expect(boxes().map((b) => b.checked)).toEqual([true, false, false, false, false]);
  });

  it("arrastar pela coluna das caixas pinta a seleção com o estado da primeira (B27)", async () => {
    await abrePrevia([1, 2, 3, 4, 5].map((i) => faixa(i, `F${i}`)));
    await waitFor(() => expect(screen.getByText("5 de 5")).toBeTruthy());
    const rows = () => [...document.querySelectorAll<HTMLElement>(".tdl-row--pick")];
    const boxes = () => [...document.querySelectorAll<HTMLInputElement>(".tdl-row--pick input[type=checkbox]")];
    fireEvent.pointerDown(rows()[1].querySelector(".tdl-pick")!, { button: 0, buttons: 1 });
    fireEvent.pointerEnter(rows()[2], { buttons: 1 });
    fireEvent.pointerEnter(rows()[4], { buttons: 1 }); // pulou a 4 no movimento rápido: entra também
    fireEvent.pointerUp(window);
    expect(boxes().map((b) => b.checked)).toEqual([true, false, false, false, false]);
    // Sem botão apertado, passar por cima não pinta.
    fireEvent.pointerEnter(rows()[0], { buttons: 0 });
    expect(boxes()[0].checked).toBe(true);
  });

  it("prévia de álbum: capa em cartaz no cabeçalho, linhas com número em vez da capa repetida (B27)", async () => {
    const alb = { ...album(9, "Celebridade"), tipo: "album", capa: "https://resources.tidal.com/images/x/320x320.jpg" };
    mocks.crateTidalSearch.mockResolvedValue({ ...busca("orochi", []), albuns: [alb] });
    mocks.crateTidalPreview.mockResolvedValue({
      tipo: "album", titulo: "Orochi - Celebridade", ref: "album:9", duracao_s: 360,
      faixas: [faixa(1, "Um"), faixa(2, "Dois")],
    });
    renderTab();
    fireEvent.input(field(), { target: { value: "orochi" } });
    fireEvent.submit(field().form!);
    await waitFor(() => expect(screen.getByText("Celebridade")).toBeTruthy());
    fireEvent.click(screen.getByText("Celebridade"));
    await waitFor(() => expect(document.querySelector(".tdl-row--pick")).toBeTruthy());
    const head = document.querySelector(".tdl-page--preview .tdl-head")!;
    expect(head.querySelector('.tdl-cover[data-size="lg"]')).toBeTruthy();
    expect(mocks.crateTidalCover).toHaveBeenCalledWith(alb.capa);
    expect(document.querySelector(".tdl-row--pick .tdl-cover")).toBeNull();
    expect([...document.querySelectorAll(".tdl-row--pick .tdl-pos")].map((e) => e.textContent)).toEqual(["1", "2"]);
  });

  it("prévia de 200: a capa da linha só é pedida quando a linha chega perto da tela (A49)", async () => {
    const vistos: Element[] = [];
    let avisa!: (entries: { target: Element; isIntersecting: boolean }[]) => void;
    const original = (globalThis as any).IntersectionObserver;
    (globalThis as any).IntersectionObserver = class {
      constructor(cb: typeof avisa) { avisa = cb; }
      observe(el: Element) { vistos.push(el); }
      unobserve() {}
      disconnect() {}
    };
    try {
      const faixas = Array.from({ length: 200 }, (_, i) => ({ ...faixa(i + 10, `F${i}`), capa: `https://resources.tidal.com/images/c${i}/80x80.jpg` }));
      await abrePrevia(faixas);
      const pedidas = () => mocks.crateTidalCover.mock.calls.map((c) => c[0]).filter((u) => u.includes("/images/c"));
      expect(pedidas()).toEqual([]);
      const primeira = document.querySelector(".tdl-row--pick .tdl-cover")!;
      expect(vistos).toContain(primeira);
      avisa([{ target: primeira, isIntersecting: true }]);
      await waitFor(() => expect(pedidas()).toEqual(["https://resources.tidal.com/images/c0/80x80.jpg"]));
    } finally {
      (globalThis as any).IntersectionObserver = original;
    }
  });

  it("página do artista abre com a foto em cartaz (B27)", async () => {
    mocks.crateTidalSearch.mockResolvedValue({
      ...busca("orochi", []), artistas: [{ id: 5, nome: "Orochi", foto: "https://resources.tidal.com/images/f/320x320.jpg", url: "u" }],
    });
    mocks.crateTidalArtist.mockResolvedValue({
      id: 5, nome: "Orochi", foto: "https://resources.tidal.com/images/f/320x320.jpg", url: "u",
      populares: [faixa(1, "Mitsubishi")], albuns: [], eps_singles: [], radio: null,
    });
    renderTab();
    fireEvent.input(field(), { target: { value: "orochi" } });
    fireEvent.submit(field().form!);
    await waitFor(() => expect(screen.getByText("Artista")).toBeTruthy());
    fireEvent.click(screen.getByText("Artista"));
    await waitFor(() => expect(screen.getByText("Mitsubishi")).toBeTruthy());
    const cover = document.querySelector('.tdl-head .tdl-cover[data-size="lg"]')!;
    expect(cover.getAttribute("data-round")).toBe("true");
  });

  it("campo, botão e pasta na ordem da aba Buscar (A36)", () => {
    renderTab();
    const row = document.querySelector(".crate-tidal-form__row")!;
    const kinds = [...row.children].map((el) =>
      el.classList.contains("tdl-field") ? "campo" : el.matches("button[type=submit]") ? "botão" : el.classList.contains("crate-dest") ? "pasta" : el.className,
    );
    expect(kinds).toEqual(["campo", "botão", "pasta"]);
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
    // O seletor de pasta (B7) tem um campo de filtro: lá o Ctrl+A é do campo.
    fireEvent.click(document.querySelector<HTMLElement>(".tdl-foot .crate-dest__btn")!);
    const filtro = document.querySelector<HTMLInputElement>(".tdl-foot .crate-dest__filter")!;
    expect(fireEvent.keyDown(filtro, { key: "a", ctrlKey: true })).toBe(true); // não foi interceptado
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

  it("os jobs não moram mais na aba: só a contagem em andamento e o atalho para a Fila (B6)", async () => {
    const onShowQueue = vi.fn();
    render(() => (
      <TidalTab
        jobs={[job({ id: "a", status: "baixando" }), job({ id: "b", status: "fila" }), job({ id: "c", status: "ok" })]}
        pastas={["Rap & Hip-Hop"]} load="loaded" loadError={null} refresh={() => {}} tokenMissing={false}
        onShowQueue={onShowQueue}
      />
    ));
    expect(screen.queryByText("Fila da VM")).toBeNull();
    expect(screen.getByText(/2 downloads da Tidal/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ver na Fila" }));
    expect(onShowQueue).toHaveBeenCalledTimes(1);
  });

  it("Baixar numa faixa trava a linha: dois cliques não viram dois pedidos, e a pílula do job toma o lugar (A16)", async () => {
    let solta!: (v: string) => void;
    mocks.crateTidalEnqueue.mockImplementationOnce(() => new Promise((res) => { solta = res; }));
    mocks.crateTidalSearch.mockResolvedValue(busca("orochi", [faixa(1, "Mitsubishi")]));
    const [jobs, setJobs] = createSignal<TidalJob[]>([]);
    render(() => (
      <TidalTab jobs={jobs()} pastas={["Rap & Hip-Hop"]} load="loaded" loadError={null} refresh={() => {}} tokenMissing={false} />
    ));
    fireEvent.input(field(), { target: { value: "orochi" } });
    fireEvent.submit(field().form!);
    await waitFor(() => expect(screen.getByText("Mitsubishi")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Baixar/ }));
    const enviando = await screen.findByRole("button", { name: "Enviando…" });
    expect((enviando as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Baixar$/ })).toBeNull();
    solta("job-1");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Enviando…" })).toBeNull());
    expect(mocks.crateTidalEnqueue).toHaveBeenCalledTimes(1);
    setJobs([job({ id: "j1", status: "baixando", url: "https://tidal.com/browse/track/1", titulo: null, n_faixas: null })]);
    const row = screen.getByText("Mitsubishi").closest(".tdl-row") as HTMLElement;
    await waitFor(() => expect(row.querySelector(".crate-pill")?.textContent).toBe("baixando"));
    expect(row.querySelector("button")).toBeNull();
  });

  it("faixa que já está no acervo oferece Tocar, não Baixar (A16)", async () => {
    mocks.libGetTracks.mockResolvedValue([libTrack("Mitsubishi", "Orochi")]);
    mocks.crateTidalSearch.mockResolvedValue(busca("orochi", [faixa(1, "Mitsubishi")]));
    renderTab();
    fireEvent.input(field(), { target: { value: "orochi" } });
    fireEvent.submit(field().form!);
    const row = await waitFor(() => screen.getByText("Mitsubishi").closest(".tdl-row") as HTMLElement);
    await waitFor(() => expect(row.textContent).toContain("no acervo"));
    expect(row.querySelector("button")?.parentElement?.textContent).toContain("Tocar");
    expect(Array.from(row.querySelectorAll("button")).some((b) => b.textContent?.includes("Baixar"))).toBe(false);
  });

  it("acervo que não carrega avisa em vez de marcar tudo como novo (A16)", async () => {
    mocks.libGetTracks.mockRejectedValue("qdrant fora");
    renderTab();
    await waitFor(() => expect(screen.getByText(/Não consegui ler o acervo/)).toBeTruthy());
  });

  it("com a fila fora, o convite de busca some: o banner diz o que falta (A25)", () => {
    render(() => (
      <TidalTab jobs={[]} pastas={[]} load="error" loadError="Não consegui falar com a fila de downloads da Tidal." refresh={() => {}} tokenMissing={false} />
    ));
    expect(screen.queryByText(/Cole um link da Tidal ou busque/)).toBeNull();
    expect(document.querySelectorAll(".crate-banner")).toHaveLength(1);
  });

  it("busca pedida de fora (Buscar na Tidal do Soulseek) preenche o campo e busca já (B28)", async () => {
    mocks.crateTidalSearch.mockResolvedValue(busca("smino anita", [faixa(7, "Anita", "Smino")]));
    const [req, setReq] = createSignal<{ q: string; n: number } | null>(null);
    render(() => (
      <TidalTab jobs={[]} pastas={["Rap & Hip-Hop"]} load="loaded" loadError={null} refresh={() => {}} tokenMissing={false} request={req()} />
    ));
    setReq({ q: "smino anita", n: 1 });
    await waitFor(() => expect(mocks.crateTidalSearch).toHaveBeenCalledWith("smino anita"));
    expect(field().value).toBe("smino anita");
    await waitFor(() => expect(screen.getByText("Anita")).toBeTruthy());
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
    const OFF = "Não consegui falar com a fila de downloads da Tidal. Sem ela não dá para baixar.";
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
    expect(banners[0].textContent).toContain("Não consegui falar com a fila");
    expect(banners[0].textContent).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect((document.querySelector(".crate-dest__btn") as HTMLButtonElement).disabled).toBe(true);
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
