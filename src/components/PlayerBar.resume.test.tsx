/* ============================================================
   PlayerBar.resume.test.tsx — "Resume on launch" tem efeito (cfg-1).

   O toggle do Settings gravava uma chave que ninguém lia: o
   PlayerBar chamava restoreSession() incondicionalmente, e a
   sessão voltava mesmo com o Resume desligado. Contrato: com a
   preferência desligada, o boot não restaura fila, posição,
   shuffle nem repeat.

   Revisão da fase 0 (25/09): a primeira correção pulava a leitura
   do snapshot inteira e levava junto a exclusão de recentes do
   autoplay/rádio, que é do motor e não da sessão — o primeiro
   autoplay depois de abrir o app podia repetir o que tocou na
   sessão anterior. A exclusão é restaurada sempre.
   ============================================================ */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

const persistLoadState = vi.hoisted(() => vi.fn());
const libGetTracksByIds = vi.hoisted(() => vi.fn());
const playerLoadPaused = vi.hoisted(() => vi.fn());

vi.mock("../tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri")>();
  return { ...actual, persistLoadState, libGetTracksByIds, playerLoadPaused };
});

import { PlayerBar } from "./PlayerBar";
import { setResumeOnLaunch, recentlyPlayed, player } from "../store/player";

function snapshot(recent: string[]) {
  return {
    track_id: "t1",
    position_ms: 42_000,
    queue_ids: ["t1", "t2"],
    queue_index: 0,
    shuffle: true,
    repeat_mode: "all",
    recently_played: recent,
    saved_at: 0,
    queue_scope: "open",
    queue_source_kind: null,
    queue_source_name: null,
  };
}

beforeEach(() => {
  localStorage.clear();
  persistLoadState.mockReset();
  persistLoadState.mockResolvedValue(null);
  libGetTracksByIds.mockReset();
  libGetTracksByIds.mockResolvedValue([
    { id: "t1", path: "/a.flac", duration_ms: 200_000 },
    { id: "t2", path: "/b.flac", duration_ms: 180_000 },
  ]);
  playerLoadPaused.mockReset();
  playerLoadPaused.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  setResumeOnLaunch(true);
});

// setupAsync encadeia alguns awaits (listeners de IPC) antes de chegar
// ao restoreSession; drenar a fila de microtasks algumas vezes basta.
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("PlayerBar: Resume on launch", () => {
  it("ligado (default) restaura a sessão persistida no mount", async () => {
    render(() => <PlayerBar />);
    await vi.waitFor(() => expect(persistLoadState).toHaveBeenCalledTimes(1));
  });

  it("desligado não restaura a fila nem carrega a faixa", async () => {
    setResumeOnLaunch(false);
    persistLoadState.mockResolvedValue(snapshot(["r-off-1"]));
    const queueBefore = player.queue.length;
    render(() => <PlayerBar />);
    await settle();
    expect(libGetTracksByIds).not.toHaveBeenCalled();
    expect(playerLoadPaused).not.toHaveBeenCalled();
    expect(player.queue.length).toBe(queueBefore);
  });

  it("desligado ainda repovoa a exclusão de recentes do autoplay", async () => {
    setResumeOnLaunch(false);
    persistLoadState.mockResolvedValue(snapshot(["r-off-a", "r-off-b"]));
    render(() => <PlayerBar />);
    await vi.waitFor(() => expect(recentlyPlayed()).toEqual(
      expect.arrayContaining(["r-off-a", "r-off-b"]),
    ));
  });

  it("ligado repovoa a exclusão mesmo quando a fila salva está vazia", async () => {
    persistLoadState.mockResolvedValue({ ...snapshot(["r-on-a"]), queue_ids: [], track_id: null });
    render(() => <PlayerBar />);
    await vi.waitFor(() => expect(recentlyPlayed()).toContain("r-on-a"));
  });
});
