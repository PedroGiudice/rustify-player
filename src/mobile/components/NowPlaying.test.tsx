/* ============================================================
   NowPlaying.test.tsx — cabeçalho do Now Playing.

   - shape/render só aparecem quando o canvas 2D desenha de fato
     (mobile-2): no WebGL eram controle morto com toast mentindo.
   ============================================================ */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
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
import { setBgEngine } from "../bg/engine";
import { useRenderer, useShape } from "../bg/spectrum";
import { resetGlStatus, setGlStatus } from "../../gl/meta";

afterEach(() => {
  cleanup();
  setBgEngine("2d");
  resetGlStatus();
});

describe("NowPlaying — shape/render (mobile-2)", () => {
  it("motor WebGL montado: sem botões de shape/render", () => {
    setBgEngine("webgl");
    setGlStatus({ ok: true, renderer: "x", error: "", fps: 60 });
    const r = render(() => <NowPlaying />);
    expect(r.queryByText(useRenderer.name())).toBeNull();
    expect(r.queryByText(useShape.name())).toBeNull();
  });

  it("WebGL que falhou (o 2D assumiu): os controles do 2D voltam", () => {
    setBgEngine("webgl");
    setGlStatus({ ok: false, renderer: "", error: "sem contexto", fps: 0 });
    const r = render(() => <NowPlaying />);
    expect(r.queryByText(useRenderer.name())).not.toBeNull();
  });

  it("motor 2D: os controles aparecem", () => {
    setBgEngine("2d");
    const r = render(() => <NowPlaying />);
    expect(r.queryByText(useRenderer.name())).not.toBeNull();
    expect(r.queryByText(useShape.name())).not.toBeNull();
  });
});
