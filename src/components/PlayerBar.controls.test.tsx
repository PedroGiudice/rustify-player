/* ============================================================
   PlayerBar.controls.test.tsx — controles da barra (auditoria de
   UI 25/09, frente shell).

   - "More" e o clique direito no título abrem o TrackContextMenu
     Solid (store/contextMenu), não o menu legado de
     src/js/components/context-menu.js, que não tem CSS no build e
     não aparecia na tela (shell-1).
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
import { setPlayer, setQueue } from "../store/player";
import { trackMenu, closeTrackMenu } from "../store/contextMenu";
import type { Track } from "../tauri";

const TRACK = {
  id: "1", title: "Faixa", artist_name: "Artista", album_title: "Disco",
  album_cover_path: null, album_year: null, duration_ms: 200_000, path: "/x", lrc_path: null,
} as Track;

afterEach(() => {
  cleanup();
  closeTrackMenu();
  setQueue([], 0);
  setPlayer({ positionSecs: 0, durationSecs: 0, currentTrack: null });
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
