/* ============================================================
   Home.test.tsx — Testa que o botao card__play no grid de albums
   monta a fila e toca a primeira track.

   CoverArt e renderizado REAL (sem mock): o .card__play e children
   dele. O teste de stopPropagation usa um ancestral Solid-delegado
   (nao listener nativo) pra refletir o event delegation do Solid.
   ============================================================ */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

// vi.mock factories sao hoisted; variaveis usadas dentro vem de vi.hoisted.
const { mockTracks, mockSnap, mockAlbums, mockSetQueue, mockPlayTrack, mockPlayer, mockResetRadio, mockNavigate, arrivals } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  arrivals: { n: 0 },
  mockTracks: [
    { id: "10", title: "Song 1", artist_name: "Band", album_title: "Great Album", album_cover_path: null, album_year: 2023, duration_ms: 240000, path: "/s1.flac", lrc_path: null },
  ],
  // Espelha o IndexerSnapshot real (library-indexer/src/types.rs): NAO tem
  // albums_total nem artists_total. O mock antigo inventava os dois campos
  // e escondia que a Home afirmava "12 albums" (o tamanho da prateleira).
  mockSnap: { tracks_total: 50, embeddings_done: 40, embeddings_pending: 10, embeddings_failed: 0, scan_in_progress: false },
  // Acervo maior que a prateleira de 12 da Home.
  mockAlbums: [
    { title: "Great Album", artist_name: "Band", cover_path: null, year: 2023, track_count: 1 },
    ...Array.from({ length: 29 }, (_, i) => ({
      title: `Other ${String(i).padStart(2, "0")}`, artist_name: "Band", cover_path: null, year: 2023, track_count: 3,
    })),
  ],
  mockSetQueue: vi.fn(),
  mockPlayTrack: vi.fn(),
  mockResetRadio: vi.fn(),
  // Objeto mutável: cada teste do card de retomada ajusta o estado.
  mockPlayer: { currentTrack: null as any, positionSecs: 0, durationSecs: 0, isPlaying: false },
}));

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ current_track: null, current_library_track: null, is_playing: false }),
  getTrackColor: vi.fn().mockResolvedValue(""),
  libSnapshot: vi.fn().mockResolvedValue(mockSnap),
  libListHistory: vi.fn().mockResolvedValue([]),
  libGetAlbums: vi.fn().mockResolvedValue(mockAlbums),
  libRecommendations: vi.fn().mockResolvedValue({ most_played: [], based_on_top: [], discover: [] }),
  libShuffle: vi.fn().mockResolvedValue([]),
  libGetTracks: vi.fn().mockResolvedValue(mockTracks),
  libListArrivals: vi.fn().mockResolvedValue([]),
  coverUrl: vi.fn((p: string | null) => p ?? ""),
}));

vi.mock("../store/player", () => ({
  setQueue: (...args: any[]) => mockSetQueue(...args),
  player: mockPlayer,
}));

vi.mock("../store/radioSession", () => ({
  resetRadioSession: (...args: any[]) => mockResetRadio(...args),
}));

vi.mock("../components/PlayerBar", () => ({
  playTrack: (...args: any[]) => mockPlayTrack(...args),
}));

vi.mock("../store/crate", () => ({ newArrivals: () => arrivals.n }));

vi.mock("../router", () => ({
  navigate: (...a: any[]) => mockNavigate(...a),
  route: () => ({ path: "/" }),
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { play: "play", shuffle: "shuffle", settings: "settings" },
}));

vi.mock("../components/TrackRowList", () => ({
  TrackRowList: (p: { track: { title: string }; whenText?: string; onClick: () => void }) => (
    <div class="track-row-mock" data-when={p.whenText} onClick={p.onClick}>{p.track.title}</div>
  ),
}));

vi.mock("../lib/format", async (orig) => ({
  ...(await orig<typeof import("../lib/format")>()),
  fmtDur: (ms: number) => `${Math.round(ms / 60000)}m`,
  relTime: () => "just now",
}));

beforeEach(() => {
  arrivals.n = 0;
  localStorage.clear();
  mockSetQueue.mockClear();
  mockPlayTrack.mockClear();
  mockResetRadio.mockClear();
  Object.assign(mockPlayer, { currentTrack: null, positionSecs: 0, durationSecs: 0, isPlaying: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import Home from "./Home";
import * as tauri from "../tauri";

describe("Home — botao card__play no grid de albums", () => {
  it("clicar no card__play chama setQueue com as tracks do album e toca a primeira", async () => {
    const { container } = render(() => <Home />);

    await vi.waitFor(() => {
      expect(container.querySelector(".card__play")).toBeTruthy();
    });

    const btn = container.querySelector(".card__play") as HTMLButtonElement;
    fireEvent.click(btn);

    await vi.waitFor(() => mockSetQueue.mock.calls.length > 0);

    // Título E artista: dois "Greatest Hits" não viram uma fila só (A19).
    expect(tauri.libGetTracks).toHaveBeenCalledWith({ album: "Great Album", artist: "Band", limit: 200 });
    expect(mockSetQueue).toHaveBeenCalledWith(mockTracks, 0, "curated", { kind: "album", name: "Great Album" });
    expect(mockPlayTrack).toHaveBeenCalledWith(mockTracks[0]);
  });

  it("e.stopPropagation() impede que o click borbulhe (delegacao Solid) ate um ancestral", async () => {
    const ancestorSpy = vi.fn();
    const { container } = render(() => (
      <div onClick={ancestorSpy}>
        <Home />
      </div>
    ));

    await vi.waitFor(() => {
      expect(container.querySelector(".card__play")).toBeTruthy();
    });

    const btn = container.querySelector(".card__play") as HTMLButtonElement;
    fireEvent.click(btn);

    expect(ancestorSpy).not.toHaveBeenCalled();
  });
});

// ds-2: o botão de tocar do card era só um ícone, sem nome acessível.
describe("Home — nome acessível do card__play (ds-2)", () => {
  it("cada card__play diz qual álbum toca", async () => {
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelector(".card__play")).toBeTruthy());
    const btn = container.querySelector(".card__play")!;
    expect(btn.getAttribute("aria-label")).toBe("Tocar Great Album");
  });
});

describe("Home — cabeçalho e prateleira de álbuns", () => {
  it("a contagem de álbuns vem do acervo, não do tamanho da prateleira", async () => {
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelector(".view__stats")).toBeTruthy());
    const stats = container.querySelector(".view__stats")!.textContent ?? "";
    expect(stats).toContain("30 albums");
    expect(tauri.libGetAlbums).toHaveBeenCalledWith({ limit: null });
  });

  it("a prateleira mostra 12 álbuns e não se rotula como favoritos", async () => {
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelectorAll(".card").length).toBe(12));
    const titles = Array.from(container.querySelectorAll(".section__title")).map((h) => h.textContent ?? "");
    expect(titles.some((t) => /favorit/i.test(t))).toBe(false);
  });

  it("sem a listagem de álbuns, a Home não afirma contagem nenhuma", async () => {
    vi.mocked(tauri.libGetAlbums).mockRejectedValueOnce(new Error("indexer fora"));
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelector(".view__stats")).toBeTruthy());
    expect(container.querySelector(".view__stats")!.textContent).not.toMatch(/albums/);
  });
});

// A7: o card de retomada diz o estado real, não "ready to resume".
describe("Home — card de retomada (A7)", () => {
  const cur = { id: "7", title: "Juicy", artist_name: "Biggie", album_title: "Ready To Die", album_cover_path: null, album_year: 1994, duration_ms: 255000, path: "/j.flac", lrc_path: null };

  it("tocando: 'Tocando agora' e posição de duração", async () => {
    Object.assign(mockPlayer, { currentTrack: cur, positionSecs: 112.6, durationSecs: 255, isPlaying: true });
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelector(".hero-tile--feature")).toBeTruthy());
    const tile = container.querySelector(".hero-tile--feature")!;
    expect(tile.querySelector(".hero-tile__eyebrow")!.textContent).toContain("Tocando agora");
    // fmtDur mockado: ms -> minutos arredondados; posição arredondada ao segundo (112 s).
    expect(tile.querySelector(".hero-tile__sub")!.textContent).toBe("2m de 4m");
    expect(tile.textContent).not.toMatch(/resume|continuar/i);
  });

  it("pausada: 'Continuar de onde parou' e 'parou em'", async () => {
    Object.assign(mockPlayer, { currentTrack: cur, positionSecs: 112, durationSecs: 255, isPlaying: false });
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelector(".hero-tile--feature")).toBeTruthy());
    const tile = container.querySelector(".hero-tile--feature")!;
    expect(tile.querySelector(".hero-tile__eyebrow")!.textContent).toContain("Continuar de onde parou");
    expect(tile.querySelector(".hero-tile__sub")!.textContent).toBe("parou em 2m de 4m");
  });

  it("títulos dos cards são h2 (h1 da vista seguido de h2)", async () => {
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelector(".hero-tile__title")).toBeTruthy());
    expect(container.querySelector("h3")).toBeNull();
    expect(container.querySelector("h2.hero-tile__title")).toBeTruthy();
  });

  it("plural: 1 faixa, n faixas", async () => {
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelectorAll(".hero-tile").length).toBe(3));
    const subs = Array.from(container.querySelectorAll(".hero-tile__sub")).map((e) => e.textContent ?? "");
    expect(subs).toContain("50 faixas");
    // Sem recomendação, o terceiro card é o primeiro álbum (1 faixa).
    expect(subs.some((t) => t.endsWith("1 faixa"))).toBe(true);
  });
});

// B5: o terceiro card é a descoberta do dia, a partir das recomendações.
describe("Home — descoberta do dia (B5)", () => {
  const disc = { id: "99", title: "Faixa Nova", artist_name: "Artista X", album_title: "Disco", album_cover_path: "/c.webp", album_year: 2020, duration_ms: 200000, path: "/n.flac", lrc_path: null };

  it("usa discover[0], com capa de fundo e motivo; clique toca e abre rádio", async () => {
    vi.mocked(tauri.libRecommendations).mockResolvedValueOnce({ most_played: [], based_on_top: [], discover: [disc] });
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelector(".hero-tile--discovery")).toBeTruthy());
    const tile = container.querySelector(".hero-tile--discovery") as HTMLButtonElement;
    expect(tile.querySelector(".hero-tile__eyebrow")!.textContent).toBe("Para descobrir");
    expect(tile.querySelector(".hero-tile__title")!.textContent).toBe("Faixa Nova");
    expect(tile.querySelector(".hero-tile__sub")!.textContent).toBe("Artista X · nunca tocada, perto do que você curte");
    expect(tile.classList.contains("hero-tile--has-cover")).toBe(true);
    expect(tile.querySelector(".hero-tile__bg")).toBeTruthy();
    expect(container.textContent).not.toContain("From your library");

    fireEvent.click(tile);
    expect(mockResetRadio).toHaveBeenCalled();
    expect(mockSetQueue).toHaveBeenCalledWith([disc], 0, "open", { kind: "radio" });
    expect(mockPlayTrack).toHaveBeenCalledWith(disc);
  });

  it("sem discover, cai em based_on_top com o motivo dela", async () => {
    vi.mocked(tauri.libRecommendations).mockResolvedValueOnce({ most_played: [], based_on_top: [disc], discover: [] });
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelector(".hero-tile--discovery")).toBeTruthy());
    expect(container.querySelector(".hero-tile--discovery .hero-tile__sub")!.textContent).toBe("Artista X · perto das suas mais tocadas");
  });

  it("sem recomendação nenhuma, mantém o card do acervo", async () => {
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelectorAll(".hero-tile").length).toBe(3));
    expect(container.querySelector(".hero-tile--discovery")).toBeNull();
    expect(container.textContent).toContain("From your library");
  });
});

// Pendência da onda 1: o card da grade da Home abre o álbum, como em Álbuns.
describe("Home — card de álbum abre (B1, A19)", () => {
  it("clicar no nome abre a página do álbum com o artista na rota, sem tocar", async () => {
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelector(".card__open")).toBeTruthy());
    fireEvent.click(container.querySelector(".card__open")!);
    expect(mockNavigate).toHaveBeenCalledWith("/album/Great%20Album?artista=Band");
    expect(mockSetQueue).not.toHaveBeenCalled();
  });
});

// B12: a Home reflete a escuta e as chegadas.
describe("Home — escuta e chegadas (B12)", () => {
  const tr = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, title, artist_name: "Band", album_title: "Great Album", album_cover_path: null, album_year: 2023, duration_ms: 1, path: `/${id}`, lrc_path: null, ...extra,
  });

  it("Mais tocadas mostra quantas vezes; Para descobrir mostra as que o hero não usou", async () => {
    vi.mocked(tauri.libRecommendations).mockResolvedValueOnce({
      most_played: [tr("m1", "Hit", { play_count: 42 })],
      based_on_top: [],
      discover: [tr("d1", "Primeira"), tr("d2", "Segunda")],
    });
    const { container, findByText } = render(() => <Home />);
    const hit = await findByText("Hit");
    expect(hit.getAttribute("data-when")).toBe("42 vezes");
    const disc = container.querySelector('[aria-label="Para descobrir"]')!;
    expect(Array.from(disc.querySelectorAll(".track-row-mock")).map((r) => r.textContent)).toEqual(["Segunda"]);
    fireEvent.click(disc.querySelector(".track-row-mock")!);
    expect(mockSetQueue).toHaveBeenCalledWith([expect.objectContaining({ id: "d2" })], 0, "open", { kind: "radio" });
  });

  it("a prateleira de álbuns começa pelo que tocou por último", async () => {
    vi.mocked(tauri.libListHistory).mockResolvedValueOnce([tr("h1", "x", { album_title: "Other 07" })]);
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelectorAll(".card").length).toBe(12));
    expect(container.querySelector(".card__title")!.textContent).toBe("Other 07");
  });

  it("chegadas do Crate aparecem com atalho para o Crate", async () => {
    arrivals.n = 3;
    const { findByRole } = render(() => <Home />);
    const btn = await findByRole("button", { name: /3 faixas novas chegaram ao acervo/ });
    fireEvent.click(btn);
    expect(mockNavigate).toHaveBeenCalledWith("/crate");
  });

  it("falha do índice avisa no topo e oferece tentar de novo", async () => {
    vi.mocked(tauri.libListHistory).mockRejectedValueOnce(new Error("fora"));
    const { findByRole } = render(() => <Home />);
    expect((await findByRole("alert")).textContent).toContain("Parte da Home não carregou.");
  });
});

// B12 restante: "Chegou esta semana" pelo indexed_at, com marca de já visto.
describe("Home — Chegou esta semana (B12)", () => {
  const ch = (id: string, title: string, indexed_at: number) => ({
    id, title, artist_name: "Band", album_title: "Novo", album_cover_path: null, album_year: 2026, duration_ms: 1, path: `/${id}`, lrc_path: null, indexed_at,
  });
  const shelf = (c: HTMLElement) => c.querySelector('[aria-label="Chegou esta semana"]');
  const rows = (c: HTMLElement) => Array.from(shelf(c)!.querySelectorAll(".track-row-mock")).map((r) => [r.textContent, r.getAttribute("data-when")]);

  let nowSpy: { mockRestore: () => void } | null = null;
  afterEach(() => { nowSpy?.mockRestore(); nowSpy = null; });

  it("pede ao índice o que entrou nos últimos 7 dias e marca as novas desde a última visita", async () => {
    nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
    localStorage.setItem("kv-home-arrivals-seen", "999999000");
    vi.mocked(tauri.libListArrivals).mockResolvedValueOnce([ch("a", "Nova", 999_999_500), ch("b", "Vista", 999_998_000)]);
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(shelf(container)).toBeTruthy());
    expect(tauri.libListArrivals).toHaveBeenCalledWith(1_000_000_000 - 7 * 86_400, expect.any(Number));
    expect(rows(container)).toEqual([["Nova", "nova · just now"], ["Vista", "just now"]]);
    expect(shelf(container)!.textContent).toContain("1 nova");
  });

  it("sair da Home grava a visita: na próxima, as mesmas faixas não aparecem como novas", async () => {
    vi.mocked(tauri.libListArrivals)
      .mockResolvedValueOnce([ch("a", "Nova", 999_999_500)])
      .mockResolvedValueOnce([ch("a", "Nova", 999_999_500)]);
    const first = render(() => <Home />);
    await vi.waitFor(() => expect(shelf(first.container)).toBeTruthy());
    expect(rows(first.container)[0][1]).toBe("nova · just now");
    first.unmount();
    expect(localStorage.getItem("kv-home-arrivals-seen")).toBe("999999500");
    const again = render(() => <Home />);
    await vi.waitFor(() => expect(shelf(again.container)).toBeTruthy());
    expect(rows(again.container)[0][1]).toBe("just now");
  });

  it("Marcar como vistas tira a marca na hora", async () => {
    vi.mocked(tauri.libListArrivals).mockResolvedValueOnce([ch("a", "Nova", 999_999_500)]);
    const { container, getByRole } = render(() => <Home />);
    await vi.waitFor(() => expect(shelf(container)).toBeTruthy());
    fireEvent.click(getByRole("button", { name: "Marcar como vistas" }));
    expect(rows(container)[0][1]).toBe("just now");
    expect(localStorage.getItem("kv-home-arrivals-seen")).toBe("999999500");
  });

  it("clicar numa chegada toca a lista de chegadas a partir dela", async () => {
    const list = [ch("a", "Uma", 3), ch("b", "Outra", 2)];
    vi.mocked(tauri.libListArrivals).mockResolvedValueOnce(list);
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(shelf(container)).toBeTruthy());
    fireEvent.click(shelf(container)!.querySelectorAll(".track-row-mock")[1]);
    expect(mockSetQueue).toHaveBeenCalledWith(list, 1);
    expect(mockPlayTrack).toHaveBeenCalledWith(list[1]);
  });

  it("semana sem chegadas: a seção não aparece", async () => {
    const { container } = render(() => <Home />);
    await vi.waitFor(() => expect(container.querySelector(".hero-grid")).toBeTruthy());
    expect(shelf(container)).toBeNull();
  });
});
