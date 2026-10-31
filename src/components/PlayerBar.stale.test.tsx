/* ============================================================
   PlayerBar.stale.test.tsx — A40: fim e posição atrasados.

   O engine estampa `track_id` em TrackEnded/Position. Um evento que
   chega depois de o player já ter pedido a próxima (fim tardio de
   uma faixa pulada, posição da anterior) não pode avançar a fila de
   novo nem mexer na posição da faixa atual.
   ============================================================ */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { PlayerBar } from "./PlayerBar";
import { player, setPlayer, setQueue } from "../store/player";
import { resetRadioSession } from "../store/radioSession";
import type { Track } from "../tauri";

const h = vi.hoisted(() => ({
  playerStateCb: null as null | ((p: unknown) => Promise<void> | void),
}));

vi.mock("../tauri", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../tauri")>();
  return {
    ...orig,
    onPlayerState: async (cb: (p: unknown) => void) => {
      h.playerStateCb = cb;
      return () => {};
    },
    onMprisCommand: async () => () => {},
    playerPlay: vi.fn(async () => {}),
    playerPause: vi.fn(async () => {}),
    playerResume: vi.fn(async () => {}),
    playerEnqueueNext: vi.fn(async () => {}),
    playerLoadPaused: vi.fn(async () => {}),
    persistLoadState: vi.fn(async () => null),
    persistSaveState: vi.fn(async () => {}),
    libRecordPlay: vi.fn(async () => {}),
    libIsLiked: vi.fn(async () => false),
    libAutoplayNext: vi.fn(async () => []),
    libStationNext: vi.fn(async () => []),
    libGetTracksByIds: vi.fn(async () => []),
    libTrackProfile: vi.fn(async () => null),
    libTrackFamiliarity: vi.fn(async () => null),
    getState: vi.fn(async () => ({ current_library_track: null, is_playing: false })),
  };
});

function track(id: string): Track {
  return {
    id, title: `t${id}`, artist_name: null, album_title: null,
    album_cover_path: null, album_year: null, duration_ms: 180_000,
    path: `/${id}`, lrc_path: null,
  } as Track;
}

async function mount() {
  render(() => <PlayerBar />);
  await vi.waitFor(() => {
    if (!h.playerStateCb) throw new Error("listener ainda não registrado");
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setQueue([], 0);
  setPlayer({ currentTrack: null, repeatMode: "off", positionSecs: 0, durationSecs: 0 });
  resetRadioSession();
  h.playerStateCb = null;
});

describe("eventos do player de outra faixa são descartados (A40)", () => {
  it("fim atrasado da faixa anterior não avança a fila", async () => {
    const [a, b, c] = [track("st-a"), track("st-b"), track("st-c")];
    setQueue([a, b, c], 1, "curated");
    setPlayer({ currentTrack: b });
    await mount();
    await h.playerStateCb!({ TrackEnded: null, track_id: a.id });
    expect(player.queueIndex).toBe(1);
    expect(player.currentTrack?.id).toBe(b.id);
  });

  it("fim da faixa atual avança, com ou sem track_id", async () => {
    const [a, b, c] = [track("sf-a"), track("sf-b"), track("sf-c")];
    setQueue([a, b, c], 0, "curated");
    setPlayer({ currentTrack: a });
    await mount();
    await h.playerStateCb!({ TrackEnded: null, track_id: a.id });
    await vi.waitFor(() => expect(player.currentTrack?.id).toBe(b.id));
    await h.playerStateCb!({ TrackEnded: null });
    await vi.waitFor(() => expect(player.currentTrack?.id).toBe(c.id));
  });

  it("posição de outra faixa não mexe no tempo da atual", async () => {
    const [a, b] = [track("sp-a"), track("sp-b")];
    setQueue([a, b], 1, "curated");
    setPlayer({ currentTrack: b, positionSecs: 3, durationSecs: 180 });
    await mount();
    await h.playerStateCb!({ Position: { samples_played: 44_100 * 120, sample_rate: 44_100 }, track_id: a.id });
    expect(player.positionSecs).toBe(3);
    await h.playerStateCb!({ Position: { samples_played: 44_100 * 7, sample_rate: 44_100 }, track_id: b.id });
    expect(Math.round(player.positionSecs)).toBe(7);
  });
});
