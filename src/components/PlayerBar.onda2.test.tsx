/* ============================================================
   PlayerBar.onda2.test.tsx — onda 2 da varredura de 31/10 na barra.

   - aria-expanded do botão da fila segue a gaveta.
   - B5: tocar, curtir e embaralhar que falham avisam pelo store/toast
     ("Não consegui…") com [Tentar de novo], em vez de só escrever no
     console. Tocar que falha não registra play.
   ============================================================ */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../tauri", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../tauri")>();
  return {
    ...orig,
    onPlayerState: async () => () => {},
    onMprisCommand: async () => () => {},
    playerPlay: vi.fn(async () => {}),
    playerPause: vi.fn(async () => {}),
    playerResume: vi.fn(async () => {}),
    playerSeek: vi.fn(async () => {}),
    playerEnqueueNext: vi.fn(async () => {}),
    persistLoadState: vi.fn(async () => null),
    persistSaveState: vi.fn(async () => {}),
    libRecordPlay: vi.fn(async () => {}),
    libIsLiked: vi.fn(async () => false),
    libToggleLike: vi.fn(async () => true),
    libAutoplayNext: vi.fn(async () => []),
    libTrackFamiliarity: vi.fn(async () => null),
    libTrackProfile: vi.fn(async () => null),
    libGetLyrics: vi.fn(async () => []),
    libListHistory: vi.fn(async () => []),
    libShuffle: vi.fn(async () => []),
  };
});

vi.mock("./waveMask", () => ({ makeWaveMask: vi.fn(() => "data:image/png;base64,AA") }));

import { PlayerBar, playTrack } from "./PlayerBar";
import { QueueDrawer } from "./QueueDrawer";
import { player, setPlayer, setQueue } from "../store/player";
import { resetRadioSession } from "../store/radioSession";
import { toast, dismissToast, runToastAction } from "../store/toast";
import { playerPlay, libRecordPlay, libToggleLike, libAutoplayNext } from "../tauri";
import type { Track } from "../tauri";

const T = (id: string) => ({
  id, title: `Faixa ${id}`, artist_name: "Artista", album_title: "Disco",
  album_cover_path: null, album_year: null, duration_ms: 180_000, path: `/${id}`, lrc_path: null,
} as Track);

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { window.location.hash = "#/home"; });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  dismissToast();
  setQueue([], 0);
  setPlayer({ currentTrack: null, shuffle: false, isTransitioning: false, queueScope: "open" });
  resetRadioSession();
});

describe("botão da fila", () => {
  it("aria-expanded acompanha a gaveta aberta ou fechada", async () => {
    const { container } = render(() => <><PlayerBar /><QueueDrawer /></>);
    const btn = container.querySelector("#pb-queue")!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("aviso de falha (B5)", () => {
  it("tocar que falha avisa, não registra play e tenta de novo pelo aviso", async () => {
    vi.mocked(playerPlay).mockRejectedValueOnce(new Error("arquivo sumiu"));
    const t = T("a");
    setQueue([t], 0);
    await playTrack(t);
    await vi.waitFor(() => expect(toast()?.message).toMatch(/^Não consegui tocar/));
    expect(toast()?.action?.label).toBe("Tentar de novo");
    expect(vi.mocked(libRecordPlay)).not.toHaveBeenCalled();
    expect(player.isTransitioning).toBe(false);

    runToastAction();
    await vi.waitFor(() => expect(vi.mocked(playerPlay)).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(vi.mocked(libRecordPlay)).toHaveBeenCalledWith("a"));
  });

  it("curtir que falha avisa e tenta de novo pelo aviso", async () => {
    vi.mocked(libToggleLike).mockRejectedValueOnce(new Error("qdrant fora"));
    setQueue([T("b")], 0);
    setPlayer({ currentTrack: T("b") });
    const { container } = render(() => <PlayerBar />);
    fireEvent.click(container.querySelector("#pb-like")!);
    await vi.waitFor(() => expect(toast()?.message).toMatch(/^Não consegui curtir/));
    runToastAction();
    await vi.waitFor(() => expect(player.isLiked).toBe(true));
  });

  it("embaralhar que falha avisa e não deixa o botão aceso", async () => {
    vi.mocked(libAutoplayNext).mockRejectedValueOnce(new Error("motor fora"));
    setQueue([T("c")], 0);
    setPlayer({ currentTrack: T("c") });
    const { container } = render(() => <PlayerBar />);
    fireEvent.click(container.querySelector("#pb-shuffle")!);
    await vi.waitFor(() => expect(toast()?.message).toMatch(/^Não consegui embaralhar/));
    expect(player.shuffle).toBe(false);
    await flush();
  });
});
