/* ============================================================
   PlayerBar.signal.test.tsx — coleta de sinal do autoplay.

   O behavioral_signals do backend deriva gosto de origin +
   listen_pct dos play_events; estes testes travam o lado
   frontend do contrato:
   - contOrigin mapeia radio→autoplay e playlist→playlist
     (continuações de radio eram logadas como album_seq, que o
     backend EXCLUI dos positives — o motor ficava cego pros
     próprios acertos);
   - repeat one/all funcionam de verdade no TrackEnded (o
     comando cycle_repeat nunca existiu no backend);
   - libRecordPlay roda UMA vez por play (era início+fim:
     play_count dobrado em toda escuta completa);
   - track skipada entra nas exclusões do autoplay (não volta
     como sugestão 2 posições depois);
   - pb-next no fim da fila dispara autoplay (paridade MPRIS).
   ============================================================ */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { PlayerBar, contOrigin } from "./PlayerBar";
import {
  player, setPlayer, setQueue, advanceQueue, rememberRecent, recentlyPlayed,
} from "../store/player";
import { resetRadioSession } from "../store/radioSession";
import {
  libRecordPlay, libAutoplayNext, playerPlay, playerEnqueueNext,
  persistSaveState, persistLoadState, libGetTracksByIds,
} from "../tauri";
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

async function emitTrackEnded() {
  await h.playerStateCb!({ TrackEnded: {} });
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

describe("contOrigin — origem real das continuações de fila", () => {
  it("fila radio mapeia pra 'autoplay' (avanço natural E skip)", () => {
    setQueue([track("r1")], 0, "open", { kind: "radio" });
    expect(contOrigin("album_seq")).toBe("autoplay");
    expect(contOrigin("queue")).toBe("autoplay");
  });

  it("fila playlist mapeia pra 'playlist'", () => {
    setQueue([track("p1")], 0, "curated", { kind: "playlist", name: "Rap" });
    expect(contOrigin("album_seq")).toBe("playlist");
    expect(contOrigin("queue")).toBe("playlist");
  });

  it("station segue 'station'; álbum e fila solta preservam o default", () => {
    setQueue([track("s1")], 0, "curated", { kind: "station", name: "Neon" });
    expect(contOrigin("album_seq")).toBe("station");
    cleanup();
    setQueue([track("a1")], 0, "curated", { kind: "album", name: "Disco" });
    expect(contOrigin("album_seq")).toBe("album_seq");
    expect(contOrigin("queue")).toBe("queue");
    setQueue([track("a2")], 0);
    expect(contOrigin("album_seq")).toBe("album_seq");
  });
});

describe("TrackEnded — repeat real e record único", () => {
  it("repeat one re-toca a mesma track com origin 'repeat', sem avançar a fila", async () => {
    const t1 = track("one-1");
    const t2 = track("one-2");
    setQueue([t1, t2], 0);
    setPlayer({ currentTrack: t1, repeatMode: "one" });
    await mountAndWait();
    await emitTrackEnded();
    expect(vi.mocked(playerPlay)).toHaveBeenCalledTimes(1);
    const [path, origin] = vi.mocked(playerPlay).mock.calls[0];
    expect(path).toBe(t1.path);
    expect(origin).toBe("repeat");
    expect(player.queueIndex).toBe(0);
  });

  it("repeat all no fim da fila volta pra primeira track", async () => {
    const t1 = track("all-1");
    const t2 = track("all-2");
    setQueue([t1, t2], 1);
    setPlayer({ currentTrack: t2, repeatMode: "all" });
    await mountAndWait();
    await emitTrackEnded();
    expect(player.queueIndex).toBe(0);
    expect(vi.mocked(playerPlay).mock.calls[0][0]).toBe(t1.path);
  });

  it("avanço natural registra play UMA vez (da track nova, não da encerrada)", async () => {
    const t1 = track("rec-1");
    const t2 = track("rec-2");
    setQueue([t1, t2], 0);
    setPlayer({ currentTrack: t1 });
    await mountAndWait();
    await emitTrackEnded();
    expect(vi.mocked(libRecordPlay)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(libRecordPlay)).toHaveBeenCalledWith(t2.id);
  });

  it("fim da fila sem repeat dispara autoplay e marca a fila como radio", async () => {
    const t1 = track("ap-1");
    const t9 = track("ap-9");
    vi.mocked(libAutoplayNext).mockResolvedValueOnce([t9]);
    setQueue([t1], 0);
    setPlayer({ currentTrack: t1 });
    await mountAndWait();
    await emitTrackEnded();
    expect(vi.mocked(libAutoplayNext)).toHaveBeenCalledTimes(1);
    expect(player.queueSource?.kind).toBe("radio");
    const call = vi.mocked(playerPlay).mock.calls.at(-1)!;
    expect(call[0]).toBe(t9.path);
    expect(call[1]).toBe("autoplay");
  });
});

describe("skips alimentam as exclusões do autoplay", () => {
  it("track skipada via pb-next entra no excludeIds do próximo autoplay", async () => {
    const t1 = track("ex-1");
    const t2 = track("ex-2");
    setQueue([t1, t2], 0);
    setPlayer({ currentTrack: t1 });
    const { container } = await mountAndWait();
    fireEvent.click(container.querySelector("#pb-next")!);
    await Promise.resolve();
    // T2 termina no fim da fila → autoplay; a skipada T1 não pode voltar.
    await emitTrackEnded();
    expect(vi.mocked(libAutoplayNext)).toHaveBeenCalledTimes(1);
    const excludeIds = vi.mocked(libAutoplayNext).mock.calls[0][1] as string[];
    expect(excludeIds).toContain(t1.id);
    expect(excludeIds).toContain(t2.id);
  });
});

describe("pb-next no fim da fila", () => {
  it("dispara autoplay em vez de morrer (paridade com MPRIS next)", async () => {
    const t1 = track("nx-1");
    setQueue([t1], 0);
    setPlayer({ currentTrack: t1 });
    const { container } = await mountAndWait();
    fireEvent.click(container.querySelector("#pb-next")!);
    await vi.waitFor(() => {
      expect(vi.mocked(libAutoplayNext)).toHaveBeenCalledTimes(1);
    });
  });
});

describe("rememberRecent — FIFO com refresh de posição", () => {
  it("re-tocar uma track refresca a posição no FIFO (não é evictada logo depois)", () => {
    rememberRecent("fifo-A");
    for (let i = 0; i < 29; i++) rememberRecent(`fifo-x${i}`);
    // A volta a tocar: precisa virar a entrada MAIS recente, não continuar
    // como a mais antiga (Set.add de membro existente é no-op de posição).
    rememberRecent("fifo-A");
    rememberRecent("fifo-y");
    rememberRecent("fifo-z");
    expect(recentlyPlayed()).toContain("fifo-A");
  });

  it("qualquer troca de track via setters da fila registra a corrente (choke point)", () => {
    const t1 = track("choke-1");
    setQueue([t1], 0);
    setPlayer({ currentTrack: t1 });
    // Clique numa track qualquer da biblioteca = setQueue + playTrack —
    // a que estava tocando entra na exclusão sem call-site manual.
    setQueue([track("choke-2")], 0);
    expect(recentlyPlayed()).toContain("choke-1");
    // advanceQueue idem.
    const t3 = track("choke-3");
    const t4 = track("choke-4");
    setQueue([t3, t4], 0);
    setPlayer({ currentTrack: t3 });
    advanceQueue();
    expect(recentlyPlayed()).toContain("choke-3");
  });
});

describe("prefetchRadio só roda em fila radio", () => {
  it("álbum embaralhado perto do fim NÃO vira radio nem loga autoplay", async () => {
    const t1 = track("alb-1");
    const t2 = track("alb-2");
    const t3 = track("alb-3");
    setQueue([t1, t2, t3], 0, "curated", { kind: "album", name: "Disco" });
    setPlayer({ currentTrack: t1, shuffle: true });
    await mountAndWait();
    await emitTrackEnded();
    // Avançou pra t2 (idx 1 >= len-2): no HEAD o prefetchRadio dispararia
    // e re-estamparia a fila do álbum como {kind:"radio"}.
    expect(vi.mocked(libAutoplayNext)).not.toHaveBeenCalled();
    expect(player.queueSource?.kind).toBe("album");
  });

  it("fila radio com shuffle segue com top-up", async () => {
    const t1 = track("rdo-1");
    const t2 = track("rdo-2");
    setQueue([t1, t2], 0, "open", { kind: "radio" });
    setPlayer({ currentTrack: t1, shuffle: true });
    await mountAndWait();
    await emitTrackEnded();
    await vi.waitFor(() => {
      expect(vi.mocked(libAutoplayNext)).toHaveBeenCalledTimes(1);
    });
    expect(player.queueSource?.kind).toBe("radio");
  });
});

describe("repeat re-alinha o preload gapless do engine", () => {
  it("ligar repeat one no meio da track re-enfileira a própria track", async () => {
    const t1 = track("rq-1");
    const t2 = track("rq-2");
    setQueue([t1, t2], 0);
    setPlayer({ currentTrack: t1, repeatMode: "off" });
    const { container } = await mountAndWait();
    const btn = container.querySelector("#pb-repeat")!;
    fireEvent.click(btn); // off -> all
    fireEvent.click(btn); // all -> one
    const calls = vi.mocked(playerEnqueueNext).mock.calls;
    expect(calls.at(-1)?.[0]).toBe(t1.path);
  });
});

describe("queueSource persiste entre sessões", () => {
  it("saveSession grava a proveniência da fila", async () => {
    const t1 = track("ps-1");
    setQueue([t1], 0, "open", { kind: "radio" });
    setPlayer({ currentTrack: t1 });
    await mountAndWait();
    fireEvent(window, new Event("beforeunload"));
    await vi.waitFor(() => {
      expect(vi.mocked(persistSaveState)).toHaveBeenCalled();
    });
    const saved = vi.mocked(persistSaveState).mock.calls.at(-1)![0];
    expect(saved.queue_scope).toBe("open");
    expect(saved.queue_source_kind).toBe("radio");
  });

  it("restoreSession re-arma a proveniência — radio não vira 'solta' no restart", async () => {
    const t1 = track("rs-1");
    vi.mocked(persistLoadState).mockResolvedValueOnce({
      track_id: t1.id!, position_ms: 1000, queue_ids: [t1.id!], queue_index: 0,
      shuffle: true, repeat_mode: "off", recently_played: [], saved_at: 0,
      queue_scope: "open", queue_source_kind: "radio", queue_source_name: null,
    });
    vi.mocked(libGetTracksByIds).mockResolvedValueOnce([t1]);
    await mountAndWait();
    await vi.waitFor(() => {
      expect(player.queueSource?.kind).toBe("radio");
    });
  });
});
