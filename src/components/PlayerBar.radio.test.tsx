/* ============================================================
   PlayerBar.radio.test.tsx — consciência de sessão do RÁDIO
   (paridade com a station, motivada pela forense de 18/08:
   3 sessões de martelo com 88-96% de skip porque o picker
   seguia a vizinhança da faixa rejeitada e re-servia skipadas).

   Contrato:
   - skip cedo em fila radio → trackId entra em sessionNegativeIds
     do próximo libAutoplayNext e o re-fetch dispara na hora
     (truncando a cauda pré-computada com a vibe velha);
   - a SEMENTE do re-fetch pós-skip é a última faixa ACEITA
     (TrackEnded) da rodada, não a que acabou de ser rejeitada;
   - picks servidos pelo rádio entram no exclude do próximo fetch
     (seenIds de sessão, além do FIFO-30 de recentlyPlayed).
   ============================================================ */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { PlayerBar } from "./PlayerBar";
import { player, setPlayer, setQueue } from "../store/player";
import { resetRadioSession } from "../store/radioSession";
import { libAutoplayNext, playerPlay } from "../tauri";
import type { Track } from "../tauri";

const h = vi.hoisted(() => ({
  playerStateCb: null as null | ((p: unknown) => Promise<void> | void),
  mprisCb: null as null | ((cmd: string) => Promise<void> | void),
}));

vi.mock("../tauri", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../tauri")>();
  return {
    ...orig,
    onPlayerState: async (cb: (p: unknown) => void) => {
      h.playerStateCb = cb;
      return () => {};
    },
    onMprisCommand: async (cb: (cmd: string) => void) => {
      h.mprisCb = cb;
      return () => {};
    },
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

async function mountAndWait() {
  const r = render(() => <PlayerBar />);
  await vi.waitFor(() => {
    if (!h.playerStateCb) throw new Error("player listener ainda não registrado");
  });
  return r;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setQueue([], 0);
  setPlayer({
    currentTrack: null, repeatMode: "off", shuffle: false,
    positionSecs: 0, durationSecs: 0,
  });
  resetRadioSession();
  h.playerStateCb = null;
  h.mprisCb = null;
});

describe("rádio reage a skip como a station (Fase 3 pro autoplay)", () => {
  it("skip cedo trunca a cauda, re-fetcha na hora e manda a skipada em sessionNegativeIds", async () => {
    const t1 = track("rs-1");
    const t2 = track("rs-2");
    const t3 = track("rs-3"); // cauda pré-computada com a vibe da rejeitada
    setQueue([t1, t2, t3], 0, "open", { kind: "radio" });
    setPlayer({ currentTrack: t1, positionSecs: 5, durationSecs: 180 });
    const { container } = await mountAndWait();

    fireEvent.click(container.querySelector("#pb-next")!);
    await vi.waitFor(() => {
      expect(vi.mocked(libAutoplayNext)).toHaveBeenCalled();
    });
    // Cauda velha truncada: fila termina no que está tocando agora (t2).
    expect(player.queue.length).toBe(2);
    const call = vi.mocked(libAutoplayNext).mock.calls.at(-1)!;
    const sessionNegatives = call[2] as string[];
    expect(sessionNegatives).toContain(t1.id);
  });

  it("a semente do re-fetch pós-skip é a última faixa ACEITA, não a skipada", async () => {
    const t1 = track("sd-1");
    const t2 = track("sd-2");
    const t3 = track("sd-3");
    setQueue([t1, t2, t3], 0, "open", { kind: "radio" });
    setPlayer({ currentTrack: t1, positionSecs: 0, durationSecs: 180 });
    const { container } = await mountAndWait();

    // t1 termina por inteiro → aceita; avança pra t2.
    await h.playerStateCb!({ TrackEnded: {} });
    // t2 é rejeitada cedo.
    setPlayer({ positionSecs: 4, durationSecs: 180 });
    fireEvent.click(container.querySelector("#pb-next")!);
    await vi.waitFor(() => {
      expect(vi.mocked(libAutoplayNext)).toHaveBeenCalled();
    });
    const call = vi.mocked(libAutoplayNext).mock.calls.at(-1)!;
    expect(call[0]).toBe(t1.id); // última aceita
    const sessionNegatives = call[2] as string[];
    expect(sessionNegatives).toContain(t2.id);
  });

  it("skip tardio (>35%) não vira negativo de sessão, mas ainda re-fetcha", async () => {
    const t1 = track("lt-1");
    const t2 = track("lt-2");
    const t3 = track("lt-3");
    setQueue([t1, t2, t3], 0, "open", { kind: "radio" });
    setPlayer({ currentTrack: t1, positionSecs: 150, durationSecs: 180 });
    const { container } = await mountAndWait();

    fireEvent.click(container.querySelector("#pb-next")!);
    await vi.waitFor(() => {
      expect(vi.mocked(libAutoplayNext)).toHaveBeenCalled();
    });
    const call = vi.mocked(libAutoplayNext).mock.calls.at(-1)!;
    const sessionNegatives = call[2] as string[];
    expect(sessionNegatives).not.toContain(t1.id);
  });

  it("picks servidos pelo rádio entram no exclude do próximo fetch (seen de sessão)", async () => {
    const t1 = track("sn-1");
    const t9 = track("sn-9");
    vi.mocked(libAutoplayNext).mockResolvedValueOnce([t9]);
    setQueue([t1], 0);
    setPlayer({ currentTrack: t1, positionSecs: 0, durationSecs: 180 });
    await mountAndWait();

    // Fim da fila → autoplay serve t9 (fila vira radio).
    await h.playerStateCb!({ TrackEnded: {} });
    expect(player.queueSource?.kind).toBe("radio");
    // t9 termina → próximo fetch tem que excluir a própria t9.
    await h.playerStateCb!({ TrackEnded: {} });
    await vi.waitFor(() => {
      expect(vi.mocked(libAutoplayNext).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    const call = vi.mocked(libAutoplayNext).mock.calls.at(-1)!;
    const excludeIds = call[1] as string[];
    expect(excludeIds).toContain(t9.id);
  });

  it("skip em fila station NÃO contamina a sessão de rádio (contextos separados)", async () => {
    const s1 = track("st-1");
    const s2 = track("st-2");
    setQueue([s1, s2], 0, "curated", { kind: "station", name: "Neon" });
    setPlayer({ currentTrack: s1, positionSecs: 5, durationSecs: 180 });
    const { container } = await mountAndWait();
    fireEvent.click(container.querySelector("#pb-next")!);
    await Promise.resolve();

    // Troca pra rádio: sessão nova, sem herdar o skip da station.
    const r1 = track("st-r1");
    const r2 = track("st-r2");
    const r3 = track("st-r3");
    setQueue([r1, r2, r3], 0, "open", { kind: "radio" });
    setPlayer({ currentTrack: r1, positionSecs: 5, durationSecs: 180 });
    fireEvent.click(container.querySelector("#pb-next")!);
    await vi.waitFor(() => {
      expect(vi.mocked(libAutoplayNext)).toHaveBeenCalled();
    });
    const call = vi.mocked(libAutoplayNext).mock.calls.at(-1)!;
    const sessionNegatives = call[2] as string[];
    expect(sessionNegatives).toContain(r1.id);
    expect(sessionNegatives).not.toContain(s1.id);
  });
});
