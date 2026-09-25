/* ============================================================
   NowPlaying.test.tsx — cabeçalho do Now Playing.

   - cabe na largura útil do S24 (316px) com alvos de 44px: as
     ações secundárias moram na sheet de "Mais opções" (mobile-1);
   - Fila substitui o /np em vez de empilhar (mobile-v3);
   - shape/render só aparecem quando o canvas 2D desenha de fato
     (mobile-2): no WebGL eram controle morto com toast mentindo.
   ============================================================ */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import type { Track } from "../types";

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  navigateFromNp: vi.fn(),
  back: vi.fn(),
  playSimilar: vi.fn(),
  toggleLike: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("../nav", () => ({
  back: h.back,
  isNpOpen: () => true,
  navigate: h.navigate,
  navigateFromNp: h.navigateFromNp,
}));

vi.mock("../ipc", () => ({
  libGetLyrics: vi.fn(async () => []),
  assetSrc: () => null,
}));

vi.mock("../store", () => {
  const track = {
    id: "7",
    title: "Faixa",
    artist_name: "Fulano",
    album_title: "Álbum",
    album_cover_path: null,
    album_year: null,
    duration_ms: 180000,
    path: "/m/7.opus",
    lrc_path: null,
    track_number: null,
    genre_name: null,
    dominant_color: null,
    liked_at: null,
    like_updated_at: null,
  } as Track;
  return {
    current: () => track,
    cycleRepeat: vi.fn(),
    isLiked: () => false,
    next: vi.fn(),
    pb: { positionMs: 0, durationMs: 180000, isPlaying: false, index: 0 },
    playSimilar: h.playSimilar,
    previous: vi.fn(),
    queueContextId: () => null,
    queueEntries: () => [],
    queueOrigin: () => "manual",
    repeat: () => "off",
    seek: vi.fn(),
    showToast: h.showToast,
    shuffleUpcoming: vi.fn(),
    toggle: vi.fn(),
    toggleLike: h.toggleLike,
  };
});

import { NowPlaying } from "./NowPlaying";
import { Sheet } from "./Sheet";
import { closeSheet, initSheetHistory, sheet } from "../sheet";
import { setBgEngine } from "../bg/engine";
import { useRenderer, useShape } from "../bg/spectrum";
import { resetGlStatus, setGlStatus } from "../../gl/meta";

let disposeHistory: (() => void) | undefined;

beforeEach(() => {
  disposeHistory = initSheetHistory();
});

afterEach(async () => {
  if (sheet()) {
    const popped = new Promise((r) => window.addEventListener("popstate", r, { once: true }));
    closeSheet();
    await popped;
  }
  disposeHistory?.();
  cleanup();
  setBgEngine("2d");
  resetGlStatus();
  vi.clearAllMocks();
});

/** NP + a sheet (irmãos, como no MobileApp) com o overflow aberto. */
function openOverflow() {
  const r = render(() => (
    <>
      <NowPlaying />
      <Sheet />
    </>
  ));
  fireEvent.click(r.getByRole("button", { name: "Mais opções" }));
  return r;
}

describe("NowPlaying — cabeçalho cabe no S24 (mobile-1)", () => {
  it("só ações de ícone no cabeçalho: Curtir, Mais opções, Fechar", () => {
    const r = render(() => <NowPlaying />);
    const head = r.container.querySelector(".nphead")!;
    const labels = [...head.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    // Letra só entra quando a faixa tem letra (o mock não tem): 4 alvos no máximo.
    expect(labels).toEqual(["Curtir", "Mais opções", "Fechar"]);
    expect(head.querySelector(".shapebtn")).toBeNull();
  });

  it("Mais opções abre a sheet com Rádio da faixa e Fila", () => {
    const r = openOverflow();
    expect(sheet()?.kind).toBe("np");
    expect(r.getByText("Rádio da faixa")).toBeTruthy();
    expect(r.getByText("Fila")).toBeTruthy();
  });

  it("Rádio da faixa toca o rádio da faixa corrente e fecha a sheet", async () => {
    const r = openOverflow();
    const popped = new Promise((res) => window.addEventListener("popstate", res, { once: true }));
    fireEvent.click(r.getByText("Rádio da faixa"));
    expect(h.playSimilar).toHaveBeenCalledWith(expect.objectContaining({ id: "7" }));
    await popped;
    expect(sheet()).toBeNull();
  });
});

describe("NowPlaying — Fila (mobile-v3)", () => {
  it("abre a fila SUBSTITUINDO o /np, depois de consumir a sentinela da sheet", async () => {
    const r = openOverflow();
    const popped = new Promise((res) => window.addEventListener("popstate", res, { once: true }));
    fireEvent.click(r.getByText("Fila"));
    await popped;
    expect(h.navigateFromNp).toHaveBeenCalledWith("/queue");
    expect(h.navigate).not.toHaveBeenCalled();
  });
});

describe("NowPlaying — shape/render (mobile-2)", () => {
  it("motor WebGL montado: sem shape/render", () => {
    setBgEngine("webgl");
    setGlStatus({ ok: true, renderer: "x", error: "", fps: 60 });
    const r = openOverflow();
    expect(r.queryByText(useRenderer.name())).toBeNull();
    expect(r.queryByText(useShape.name())).toBeNull();
  });

  it("WebGL que falhou (o 2D assumiu): os controles do 2D voltam", () => {
    setBgEngine("webgl");
    setGlStatus({ ok: false, renderer: "", error: "sem contexto", fps: 0 });
    const r = openOverflow();
    expect(r.queryByText(useRenderer.name())).not.toBeNull();
  });

  it("motor 2D: os controles aparecem e trocam o fundo sem fechar a sheet", () => {
    setBgEngine("2d");
    const r = openOverflow();
    const before = useShape.name();
    fireEvent.click(r.getByText(before));
    expect(useShape.name()).not.toBe(before);
    expect(r.queryByText(useShape.name())).not.toBeNull();
    expect(sheet()?.kind).toBe("np");
    useShape.prev();
  });
});
