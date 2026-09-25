/* ============================================================
   PlayerBar.controls.test.tsx — controles da barra (auditoria de
   UI 25/09, frente shell).

   - "More" e o clique direito no título abrem o TrackContextMenu
     Solid (store/contextMenu), não o menu legado de
     src/js/components/context-menu.js, que não tem CSS no build e
     não aparecia na tela (shell-1).
   - Seek e volume são sliders de verdade: role, tabindex, valores
     ARIA e teclado (setas, Home/End, PageUp/PageDown) (shell-2,
     ds-2).
   - O botão de mudo diz o que faz ("Mute"/"Unmute"), expõe
     aria-pressed e passa pelo store em vez de chamar o IPC direto
     (shell-v3).
   ============================================================ */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../tauri", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../tauri")>();
  return {
    ...orig,
    onPlayerState: async () => () => {},
    onMprisCommand: async () => () => {},
    playerPlay: vi.fn(async () => {}),
    playerSeek: vi.fn(async () => {}),
    setVolume: vi.fn(async () => {}),
    persistLoadState: vi.fn(async () => null),
    persistSaveState: vi.fn(async () => {}),
    libIsLiked: vi.fn(async () => false),
    libRecordPlay: vi.fn(async () => {}),
    getState: vi.fn(async () => ({ current_library_track: null, is_playing: false })),
  };
});

import { PlayerBar } from "./PlayerBar";
import { player, setPlayer, setQueue } from "../store/player";
import { playerSeek, setVolume } from "../tauri";
import { trackMenu, closeTrackMenu } from "../store/contextMenu";
import type { Track } from "../tauri";

const TRACK = {
  id: "1", title: "Faixa", artist_name: "Artista", album_title: "Disco",
  album_cover_path: null, album_year: null, duration_ms: 200_000, path: "/x", lrc_path: null,
} as Track;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  closeTrackMenu();
  setQueue([], 0);
  setPlayer({ positionSecs: 0, durationSecs: 0, currentTrack: null, volume: 1, isMuted: false });
  localStorage.clear();
  document.querySelectorAll(".ctx-menu").forEach((el) => el.remove());
});

describe("menu da faixa atual (shell-1)", () => {
  it("o botão More abre o TrackContextMenu com a faixa tocando", () => {
    setQueue([TRACK], 0);
    const { container } = render(() => <PlayerBar />);
    fireEvent.click(container.querySelector("#pb-more")!);
    expect(trackMenu()?.track.id).toBe("1");
    expect(document.querySelector(".ctx-menu")).toBeNull();
  });

  it("o clique direito no título abre o mesmo menu", () => {
    setQueue([TRACK], 0);
    const { container } = render(() => <PlayerBar />);
    fireEvent.contextMenu(container.querySelector(".pb-meta")!);
    expect(trackMenu()?.track.id).toBe("1");
    expect(document.querySelector(".ctx-menu")).toBeNull();
  });
});

describe("seek como slider (shell-2, ds-2)", () => {
  function mountAt(pos: number) {
    setQueue([TRACK], 0);
    setPlayer({ positionSecs: pos, durationSecs: 200 });
    const r = render(() => <PlayerBar />);
    return r.container.querySelector("#pb-progress") as HTMLElement;
  }

  it("expõe role, foco e valores ARIA", () => {
    const seek = mountAt(83);
    expect(seek.getAttribute("role")).toBe("slider");
    expect(seek.getAttribute("tabindex")).toBe("0");
    expect(seek.getAttribute("aria-valuemin")).toBe("0");
    expect(seek.getAttribute("aria-valuemax")).toBe("200");
    expect(seek.getAttribute("aria-valuenow")).toBe("83");
    expect(seek.getAttribute("aria-valuetext")).toBe("1:23 of 3:20");
  });

  it("setas avançam e voltam 5 s e fazem o seek no engine", () => {
    const seek = mountAt(60);
    fireEvent.keyDown(seek, { key: "ArrowRight" });
    expect(player.positionSecs).toBe(65);
    expect(vi.mocked(playerSeek)).toHaveBeenLastCalledWith(65);
    fireEvent.keyDown(seek, { key: "ArrowLeft" });
    fireEvent.keyDown(seek, { key: "ArrowDown" });
    expect(player.positionSecs).toBe(55);
    fireEvent.keyDown(seek, { key: "ArrowUp" });
    expect(player.positionSecs).toBe(60);
  });

  it("PageUp/PageDown andam 30 s, Home/End vão às pontas, sempre dentro da faixa", () => {
    const seek = mountAt(10);
    fireEvent.keyDown(seek, { key: "PageDown" });
    expect(player.positionSecs).toBe(0);
    fireEvent.keyDown(seek, { key: "PageUp" });
    expect(player.positionSecs).toBe(30);
    fireEvent.keyDown(seek, { key: "End" });
    expect(player.positionSecs).toBe(200);
    fireEvent.keyDown(seek, { key: "Home" });
    expect(player.positionSecs).toBe(0);
    expect(vi.mocked(playerSeek)).toHaveBeenLastCalledWith(0);
  });

  it("sem faixa tocando o teclado não faz nada", () => {
    setPlayer({ positionSecs: 0, durationSecs: 0 });
    const { container } = render(() => <PlayerBar />);
    fireEvent.keyDown(container.querySelector("#pb-progress")!, { key: "ArrowRight" });
    expect(vi.mocked(playerSeek)).not.toHaveBeenCalled();
    expect(player.positionSecs).toBe(0);
  });
});

describe("volume como slider (shell-2, ds-2)", () => {
  function mountVol(vol: number, muted = false) {
    setPlayer({ volume: vol, isMuted: muted });
    const r = render(() => <PlayerBar />);
    return r.container.querySelector("#pb-vol-progress") as HTMLElement;
  }

  it("expõe role, foco e valores ARIA em percentual", () => {
    const vol = mountVol(0.7);
    expect(vol.getAttribute("role")).toBe("slider");
    expect(vol.getAttribute("tabindex")).toBe("0");
    expect(vol.getAttribute("aria-valuemin")).toBe("0");
    expect(vol.getAttribute("aria-valuemax")).toBe("100");
    expect(vol.getAttribute("aria-valuenow")).toBe("70");
    expect(vol.getAttribute("aria-valuetext")).toBe("70%");
  });

  it("mudo aparece como 0 e 'muted'", () => {
    const vol = mountVol(0.7, true);
    expect(vol.getAttribute("aria-valuenow")).toBe("0");
    expect(vol.getAttribute("aria-valuetext")).toBe("muted");
  });

  it("setas mudam 5 pontos pelo changeVolume (persiste e chega ao engine)", () => {
    const vol = mountVol(0.5);
    fireEvent.keyDown(vol, { key: "ArrowUp" });
    expect(player.volume).toBeCloseTo(0.55);
    expect(vi.mocked(setVolume)).toHaveBeenLastCalledWith(0.55);
    expect(localStorage.getItem("kv-volume")).toBe("0.55");
    fireEvent.keyDown(vol, { key: "ArrowLeft" });
    fireEvent.keyDown(vol, { key: "ArrowLeft" });
    expect(player.volume).toBeCloseTo(0.45);
  });

  it("PageUp/PageDown andam 20 pontos e Home/End vão a 0 e 100", () => {
    const vol = mountVol(0.5);
    fireEvent.keyDown(vol, { key: "PageUp" });
    expect(player.volume).toBeCloseTo(0.7);
    fireEvent.keyDown(vol, { key: "PageDown" });
    expect(player.volume).toBeCloseTo(0.5);
    fireEvent.keyDown(vol, { key: "End" });
    expect(player.volume).toBe(1);
    fireEvent.keyDown(vol, { key: "Home" });
    expect(player.volume).toBe(0);
  });
});

describe("botão de mudo (shell-v3)", () => {
  it("rótulo e title dizem a ação, e aria-pressed reflete o estado", () => {
    setPlayer({ volume: 0.6, isMuted: false });
    const { container } = render(() => <PlayerBar />);
    const btn = container.querySelector("#pb-vol-btn") as HTMLElement;
    expect(btn.getAttribute("aria-label")).toBe("Mute");
    expect(btn.getAttribute("title")).toBe("Mute");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(player.isMuted).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("Unmute");
    expect(btn.getAttribute("title")).toBe("Unmute");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("mudo zera o engine sem gravar 0 como preferência; desmutar volta ao volume", () => {
    localStorage.setItem("kv-volume", "0.6");
    setPlayer({ volume: 0.6, isMuted: false });
    const { container } = render(() => <PlayerBar />);
    const btn = container.querySelector("#pb-vol-btn") as HTMLElement;
    fireEvent.click(btn);
    expect(vi.mocked(setVolume)).toHaveBeenLastCalledWith(0);
    expect(localStorage.getItem("kv-volume")).toBe("0.6");
    fireEvent.click(btn);
    expect(player.isMuted).toBe(false);
    expect(vi.mocked(setVolume)).toHaveBeenLastCalledWith(0.6);
  });
});
