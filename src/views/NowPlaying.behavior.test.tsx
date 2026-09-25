/* ============================================================
   NowPlaying.behavior.test.tsx — comportamento do Now Playing com
   stores REATIVOS (o NowPlaying.test.tsx usa um Proxy estático, que
   não deixa trocar de faixa nem mexer no motor do fundo).
   Achados da auditoria de UI de 25/09/2026.
   ============================================================ */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@solidjs/testing-library";
import { Suspense } from "solid-js";
import type { LyricLine } from "../tauri";

const h = vi.hoisted(() => ({
  libGetLyrics: vi.fn(),
  navigate: vi.fn(),
  setTweaksOpen: vi.fn(),
  shapePrev: vi.fn(),
  rendererPrev: vi.fn(),
}));

vi.mock("../store/player", async () => {
  const { createStore } = await import("solid-js/store");
  const [player, setPlayer] = createStore<any>({
    currentTrack: null,
    positionSecs: 0,
    techInfo: { format: "—", bitDepth: null, sampleRate: null, channels: null },
  });
  return { player, __setPlayer: setPlayer };
});

vi.mock("../store/tweaks", async () => {
  const { createSignal } = await import("solid-js");
  const [tweaks, setTweaks] = createSignal<any>({ lyricsVisible: true, bgEngine: "2d" });
  return { tweaks, __setTweaks: setTweaks, setTweaksOpen: h.setTweaksOpen };
});

vi.mock("../store/dsp", () => ({
  dsp: { bypass: true, eq: { enabled: false }, limiter: { enabled: false }, bass: { enabled: false } },
}));

vi.mock("../store/contextMenu", () => ({
  openTrackMenu: vi.fn(),
  trackMenu: () => null,
  closeTrackMenu: vi.fn(),
}));

vi.mock("../tauri", () => ({
  libGetLyrics: (id: string) => h.libGetLyrics(id),
  coverUrl: (p: string | null) => p ?? "",
}));

vi.mock("../router", () => ({ navigate: h.navigate }));

vi.mock("../components/CoverArt", () => ({
  CoverArt: (props: any) => <div class="cover-art">{props.children}</div>,
}));

vi.mock("../components/Icon", () => ({
  Icon: () => <span />,
  ICONS: { settings: "settings", more: "more", expand: "expand", shrink: "shrink", chevronLeft: "cl", chevronRight: "cr" },
}));

vi.mock("../components/SpectrumCanvas", () => ({
  useShape: () => ({ prev: h.shapePrev, next: vi.fn(), name: () => "wave" }),
  useRenderer: () => ({ prev: h.rendererPrev, next: vi.fn(), name: () => "mesh" }),
}));

import * as playerMod from "../store/player";
import * as tweaksMod from "../store/tweaks";
import { resetGlStatus, setGlStatus } from "../gl/meta";
import { glassSurface, lyricsInk, LYRICS_DESIGN_INK } from "../lib/lyricsInk";
import NowPlaying from "./NowPlaying";

const setPlayer = (playerMod as any).__setPlayer as (...args: any[]) => void;
const setTweaks = (tweaksMod as any).__setTweaks as (v: any) => void;

function track(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Faixa ${id}`,
    artist_name: `Artista ${id}`,
    album_title: `Álbum ${id}`,
    album_cover_path: null,
    album_year: null,
    duration_ms: 200000,
    path: `/${id}.flac`,
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  localStorage.clear();
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  setPlayer({ currentTrack: null, positionSecs: 0 });
  h.libGetLyrics.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NowPlaying — troca de faixa (np-1)", () => {
  it("não derruba a view para o fallback do Suspense enquanto a letra nova carrega", async () => {
    const pendingB = deferred<LyricLine[]>();
    h.libGetLyrics.mockImplementation((id: string) =>
      id === "A" ? Promise.resolve([{ t: 1, line: "letra de A" }]) : pendingB.promise,
    );
    setPlayer({ currentTrack: track("A") });

    const { container, queryByTestId } = render(() => (
      <Suspense fallback={<p data-testid="fallback">Loading…</p>}>
        <NowPlaying />
      </Suspense>
    ));
    await waitFor(() => expect(container.textContent).toContain("letra de A"));

    setPlayer("currentTrack", track("B"));
    await Promise.resolve();

    expect(queryByTestId("fallback")).toBeNull();
    expect(container.querySelector(".np__title")?.textContent).toBe("Faixa B");

    pendingB.resolve([{ t: 1, line: "letra de B" }]);
    await waitFor(() => expect(container.textContent).toContain("letra de B"));
    expect(queryByTestId("fallback")).toBeNull();
  });
});

describe("NowPlaying — linhas da letra (np-4, nowplaying-v2)", () => {
  async function renderWith(lines: LyricLine[]) {
    h.libGetLyrics.mockResolvedValue(lines);
    setPlayer({ currentTrack: track("A") });
    const r = render(() => <NowPlaying />);
    await waitFor(() => expect(r.container.querySelectorAll(".np__lyric").length).toBe(lines.length));
    return r;
  }

  it("letra sem sincronismo não destaca a primeira linha como próxima", async () => {
    const { container } = await renderWith([
      { t: 0, line: "um" },
      { t: 0, line: "dois" },
      { t: 0, line: "três" },
    ]);
    expect(container.querySelector(".np__lyric.is-near")).toBeNull();
    expect(container.querySelector(".np__lyric.is-active")).toBeNull();
    expect(container.querySelector(".np__lyrics-viewport.is-unsynced")).not.toBeNull();
  });

  it("marca cabeçalhos de seção ([Chorus]) com classe própria", async () => {
    const { container } = await renderWith([
      { t: 1, line: "[Chorus]", header: true },
      { t: 2, line: "verso" },
    ]);
    const lines = container.querySelectorAll(".np__lyric");
    expect(lines[0].classList.contains("is-header")).toBe(true);
    expect(lines[1].classList.contains("is-header")).toBe(false);
  });

  it("linha vazia do LRC (interlúdio) aparece como reticências, não como parágrafo vazio", async () => {
    setPlayer("positionSecs", 5);
    const { container } = await renderWith([
      { t: 1, line: "antes" },
      { t: 4, line: "" },
      { t: 9, line: "depois" },
    ]);
    const lines = container.querySelectorAll(".np__lyric");
    expect(lines[1].textContent).toBe("…");
    expect(lines[1].classList.contains("is-active")).toBe(true);
  });
});

describe("NowPlaying — artista e álbum (np-10, shell-v1, biblioteca-v2)", () => {
  it("são botões alcançáveis por teclado que levam à página da entidade", () => {
    h.libGetLyrics.mockResolvedValue([]);
    setPlayer({ currentTrack: track("A", { artist_name: "Sade & Co", album_title: "Love Deluxe" }) });
    const { container } = render(() => <NowPlaying />);

    const artist = container.querySelector(".np__artist") as HTMLElement;
    const album = container.querySelector(".np__album") as HTMLElement;
    expect(artist.tagName).toBe("BUTTON");
    expect(album.tagName).toBe("BUTTON");

    artist.click();
    expect(h.navigate).toHaveBeenLastCalledWith(`/artist/${encodeURIComponent("Sade & Co")}`);
    album.click();
    expect(h.navigate).toHaveBeenLastCalledWith(`/album/${encodeURIComponent("Love Deluxe")}`);
  });

  it("sem faixa não oferece link nenhum", () => {
    setPlayer({ currentTrack: null });
    const { container } = render(() => <NowPlaying />);
    expect(container.querySelector("button.np__artist")).toBeNull();
    expect(container.querySelector("button.np__album")).toBeNull();
  });
});

describe("NowPlaying — seletores do fundo 2D (np-6)", () => {
  afterEach(() => {
    setTweaks({ lyricsVisible: true, bgEngine: "2d" });
    resetGlStatus();
  });

  it("somem, e os atalhos [ ] , . param, quando o fundo é WebGL", () => {
    setTweaks({ lyricsVisible: false, bgEngine: "webgl" });
    setGlStatus({ ok: true, renderer: "x", error: "", fps: 60 });
    const { container } = render(() => <NowPlaying />);
    expect(container.querySelector(".np__viz-nav")).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "[" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "," }));
    expect(h.shapePrev).not.toHaveBeenCalled();
    expect(h.rendererPrev).not.toHaveBeenCalled();
  });

  it("voltam quando o WebGL falhou e o 2D reassumiu", () => {
    setTweaks({ lyricsVisible: false, bgEngine: "webgl" });
    setGlStatus({ ok: false, renderer: "", error: "sem contexto", fps: 0 });
    const { container } = render(() => <NowPlaying />);
    expect(container.querySelector(".np__viz-nav")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "[" }));
    expect(h.shapePrev).toHaveBeenCalledTimes(1);
  });

  it("aparecem e respondem no fundo 2D", () => {
    setTweaks({ lyricsVisible: false, bgEngine: "2d" });
    const { container } = render(() => <NowPlaying />);
    expect(container.querySelector(".np__viz-nav")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "," }));
    expect(h.rendererPrev).toHaveBeenCalledTimes(1);
  });
});

describe("NowPlaying — card de letras acompanha o tamanho do .np (np-9)", () => {
  it("reposiciona o card quando o .np encolhe sem resize da janela", async () => {
    const observers: Array<{ cb: ResizeObserverCallback; targets: Element[] }> = [];
    (globalThis as any).ResizeObserver = class {
      private o: { cb: ResizeObserverCallback; targets: Element[] };
      constructor(cb: ResizeObserverCallback) {
        this.o = { cb, targets: [] };
        observers.push(this.o);
      }
      observe(el: Element) { this.o.targets.push(el); }
      disconnect() { this.o.targets = []; }
    };
    let npW = 1200;
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const w = this.classList.contains("np") ? npW : 0;
        const hgt = this.classList.contains("np") ? 800 : 0;
        return { width: w, height: hgt, top: 0, left: 0, right: w, bottom: hgt, x: 0, y: 0, toJSON() {} } as DOMRect;
      });
    localStorage.setItem("rustify-lyrics-card", JSON.stringify({ x: 700, y: 32, w: 380, h: 460 }));
    h.libGetLyrics.mockResolvedValue([{ t: 1, line: "linha" }]);
    setPlayer({ currentTrack: track("A") });

    const { container } = render(() => <NowPlaying />);
    await waitFor(() => expect(container.querySelector(".np__lyrics-card")).not.toBeNull());
    const card = () => container.querySelector(".np__lyrics-card") as HTMLElement;
    expect(card().style.left).toBe("700px");

    // Sai do cinema / sidebar vira ícones: o .np encolhe, a janela não.
    npW = 900;
    const np = container.querySelector(".np")!;
    for (const o of observers) {
      if (o.targets.includes(np)) o.cb([], {} as ResizeObserver);
    }
    expect(card().style.left).toBe(`${900 - 380}px`);
    rect.mockRestore();
  });
});

describe("NowPlaying — contraste do card de letras (np-2, ds-18)", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--bg-canvas");
    setTweaks({ lyricsVisible: true, bgEngine: "2d" });
    resetGlStatus();
  });

  async function cardFg1(): Promise<string> {
    h.libGetLyrics.mockResolvedValue([{ t: 1, line: "linha" }]);
    setPlayer({ currentTrack: track("A") });
    const { container } = render(() => <NowPlaying />);
    let v = "";
    await waitFor(() => {
      const card = container.querySelector(".np__lyrics-card") as HTMLElement | null;
      v = card?.style.getPropertyValue("--fg-1") ?? "";
      expect(v).not.toBe("");
    });
    return v;
  }

  it("fundo 2D sobre tema claro: texto derivado do vidro, não a escala clara fixa", async () => {
    document.documentElement.style.setProperty("--bg-canvas", "#fafafa");
    const expected = lyricsInk(glassSurface({ backdrop: { r: 250, g: 250, b: 250 }, alpha: 0.193, brightness: 0.82 }));
    expect(await cardFg1()).toBe(expected["--fg-1"]);
    expect(expected["--fg-1"]).not.toBe(LYRICS_DESIGN_INK["--fg-1"]);
  });

  it("fundo WebGL (preto fixo): o vidro é escuro mesmo com tema claro", async () => {
    document.documentElement.style.setProperty("--bg-canvas", "#fafafa");
    setTweaks({ lyricsVisible: true, bgEngine: "webgl" });
    setGlStatus({ ok: true, renderer: "x", error: "", fps: 60 });
    expect(await cardFg1()).toBe(LYRICS_DESIGN_INK["--fg-1"]);
  });

  // Integração cfg-15 x np-2: a escrita das vars do vidro passou para um
  // rAF do store de Tweaks, e a medição daqui roda num rAF próprio. A ordem
  // entre os dois depende da ordem dos observadores do signal (que o Solid
  // embaralha a cada re-execução): ao soltar o slider, o card ficava com a
  // escala do passo anterior. O store avisa depois de escrever; o card
  // re-mede nesse aviso, sem depender do signal.
  it("re-mede quando o store avisa que aplicou as vars (rustify:tweaks-applied)", async () => {
    const root = document.documentElement;
    root.style.setProperty("--bg-canvas", "#fafafa");
    try {
      const first = await cardFg1();
      root.style.setProperty("--lyrics-bg-alpha", "0.650");
      root.style.setProperty("--lyrics-bg-brightness", "0.520");
      const expected = lyricsInk(glassSurface({ backdrop: { r: 250, g: 250, b: 250 }, alpha: 0.65, brightness: 0.52 }));
      expect(expected["--fg-1"]).not.toBe(first);
      window.dispatchEvent(new Event("rustify:tweaks-applied"));
      await waitFor(() => {
        const card = document.querySelector(".np__lyrics-card") as HTMLElement;
        expect(card.style.getPropertyValue("--fg-1")).toBe(expected["--fg-1"]);
      });
    } finally {
      root.style.removeProperty("--lyrics-bg-alpha");
      root.style.removeProperty("--lyrics-bg-brightness");
    }
  });
});

// nowplaying-v4 / cfg-10 (integração): o listener próprio do Now Playing
// ignorava só input e textarea. Com foco num <select> (fonte do Tweaks,
// tema do Settings), a busca por letra do select disparava F (cinema) e
// [ ] , . (fundo). Mesmo filtro do App e da fila: isTypingContext.
describe("NowPlaying — atalhos com foco num <select> (nowplaying-v4)", () => {
  afterEach(() => setTweaks({ lyricsVisible: true, bgEngine: "2d" }));

  it("F e [ vindos de um <select> não mudam o cinema nem o fundo", () => {
    setTweaks({ lyricsVisible: false, bgEngine: "2d" });
    render(() => <NowPlaying />);
    const sel = document.createElement("select");
    document.body.appendChild(sel);
    const cinema = vi.fn();
    window.addEventListener("rustify:cinema", cinema);
    try {
      sel.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      sel.dispatchEvent(new KeyboardEvent("keydown", { key: "[", bubbles: true }));
      expect(cinema).not.toHaveBeenCalled();
      expect(h.shapePrev).not.toHaveBeenCalled();
      // Controle: fora do select os atalhos continuam valendo.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "[" }));
      expect(h.shapePrev).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("rustify:cinema", cinema);
      sel.remove();
    }
  });
});

describe("NowPlaying — botão de ajustes do fundo (np-7)", () => {
  it("abre o Tweaks e rola até a seção Fundo", async () => {
    // Painel de Tweaks mínimo: o NowPlaying só depende do marcador da seção.
    const body = document.createElement("div");
    body.className = "tweaks__body";
    const sec = document.createElement("div");
    sec.setAttribute("data-tweaks-section", "fundo");
    body.appendChild(sec);
    document.body.appendChild(body);
    let scrollTop = 40;
    Object.defineProperty(body, "scrollTop", { get: () => scrollTop, set: (v) => { scrollTop = v; } });
    body.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    sec.getBoundingClientRect = () => ({ top: 520 }) as DOMRect;

    const { container } = render(() => <NowPlaying />);
    const btn = container.querySelector('button[title="Spectrum settings"]') as HTMLButtonElement;
    btn.click();
    expect(h.setTweaksOpen).toHaveBeenCalledWith(true);

    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(scrollTop).toBe(40 + 420);
    body.remove();
  });
});
