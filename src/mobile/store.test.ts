/* ============================================================
   store.test.ts — contratos de continuidade das ações de play.

   O que se prova aqui é a REGRA (decisão do CEO, 2026-08-17): a
   playlist é coleção curada e TERMINA. Tudo que refaz a fila a
   partir dela — Play, Shuffle, linha tocada, "Tocar agora" e
   "Tocar a partir daqui" da sheet — arma a continuidade do mesmo
   jeito (`off`) e carrega o mesmo contexto. O shuffle e a linha
   tocada armando `radio` sem contexto foram o bug CMR-211
   ("shuffle da playlist vira shuffle geral").
   ============================================================ */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "./types";

vi.mock("./ipc", () => ({
  playerSetQueue: vi.fn(async () => undefined),
  playerGetQueue: vi.fn(async () => ({ items: [], index: 0 })),
  playerShuffleUpcoming: vi.fn(async () => ({ items: [], index: 0 })),
  playerSetLike: vi.fn(async () => ({ seq: 1 })),
  continuityArm: vi.fn(async () => undefined),
  libRecentPlays: vi.fn(async () => []),
  toQueueItem: (t: Track) => ({ trackId: t.id, path: t.path }),
  toQueueItems: (l: Track[]) => l.map((t) => ({ trackId: t.id, path: t.path })),
}));

import * as ipc from "./ipc";
import {
  isLiked,
  loadRecents,
  pb,
  playFolder,
  playFolderFrom,
  playFromHere,
  playTrackFrom,
  queueEntries,
  recents,
  shuffleFolder,
  shuffleList,
  shuffleUpcoming,
  toast,
  toggleLike,
} from "./store";

const track = (id: number): Track =>
  ({ id: String(id), title: `t${id}`, path: `/m/${id}.flac`, duration_ms: 1000 * id }) as Track;

const FOLDER = [track(1), track(2), track(3), track(4), track(5)];

const armed = () => (ipc.continuityArm as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
const queued = () => (ipc.playerSetQueue as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("playFolder (Play da playlist)", () => {
  it("origin playlist, contexto = pasta, continuidade OFF", async () => {
    await playFolder(FOLDER, "Rap BR");
    expect(queued()).toMatchObject({ origin: "playlist", contextId: "Rap BR", startIndex: 0 });
    expect(armed()).toMatchObject({ mode: "off", stationId: null });
  });
});

describe("shuffleFolder (Shuffle da playlist — CMR-211)", () => {
  it("herda a exceção do Play: contexto = pasta e continuidade OFF", async () => {
    await shuffleFolder(FOLDER, "Rap BR");
    expect(queued()).toMatchObject({ contextId: "Rap BR", startIndex: 0 });
    expect(armed()).toMatchObject({ mode: "off", stationId: null });
  });

  it("origin continua `autoplay` (sequência escolhida pela máquina; `shuffle` não existe no motor)", async () => {
    await shuffleFolder(FOLDER, "Rap BR");
    expect(queued().origin).toBe("autoplay");
  });

  it("a fila é uma permutação da pasta — nada de fora, nada faltando", async () => {
    await shuffleFolder(FOLDER, "Rap BR");
    const ids = queued().items.map((i: { trackId: string }) => i.trackId).sort();
    expect(ids).toEqual(FOLDER.map((t) => t.id).sort());
  });

  it("a semente da continuidade é a primeira faixa embaralhada", async () => {
    await shuffleFolder(FOLDER, "Rap BR");
    expect(armed().seedTrackId).toBe(queued().items[0].trackId);
  });
});

describe('playFolderFrom (linha tocada e "Tocar agora" da sheet numa playlist — CMR-211)', () => {
  it("herda a exceção do Play: contexto = pasta e continuidade OFF", async () => {
    await playFolderFrom(FOLDER, 2, "Rap BR");
    expect(queued()).toMatchObject({ contextId: "Rap BR", startIndex: 2 });
    expect(armed()).toMatchObject({ mode: "off", stationId: null });
  });

  it("origin é `manual` (a faixa foi escolhida à mão; nada de origin novo)", async () => {
    await playFolderFrom(FOLDER, 2, "Rap BR");
    expect(queued().origin).toBe("manual");
  });

  it("a fila é a pasta INTEIRA, na ordem, começando no índice tocado", async () => {
    await playFolderFrom(FOLDER, 2, "Rap BR");
    const ids = queued().items.map((i: { trackId: string }) => i.trackId);
    expect(ids).toEqual(["1", "2", "3", "4", "5"]);
    expect(armed().seedTrackId).toBe("3");
  });
});

describe("playTrackFrom (linha tocada fora de playlist: álbum/artista/acervo/shelf)", () => {
  it("mantém o default: origin manual, sem contexto e continuidade radio", async () => {
    await playTrackFrom(FOLDER, 2);
    expect(queued()).toMatchObject({ origin: "manual", contextId: null, startIndex: 2 });
    expect(armed()).toMatchObject({ mode: "radio", stationId: null });
  });
});

describe("shuffleList (álbum/artista/acervo)", () => {
  it("mantém o default: sem contexto e continuidade radio", async () => {
    await shuffleList(FOLDER);
    expect(queued()).toMatchObject({ origin: "autoplay", contextId: null });
    expect(armed()).toMatchObject({ mode: "radio", stationId: null });
  });
});

describe('playFromHere ("Tocar a partir daqui" da sheet — resíduo do CMR-211)', () => {
  it("dentro de uma playlist herda a exceção do Play: contexto = pasta e continuidade OFF", async () => {
    await playFromHere({ list: FOLDER, index: 2, playlist: "Rap BR" });
    expect(queued()).toMatchObject({ contextId: "Rap BR", startIndex: 0 });
    expect(armed()).toMatchObject({ mode: "off", stationId: null });
  });

  it("fora de playlist (álbum/artista/acervo) mantém o default: sem contexto e radio", async () => {
    await playFromHere({ list: FOLDER, index: 2 });
    expect(queued()).toMatchObject({ contextId: null, startIndex: 0 });
    expect(armed()).toMatchObject({ mode: "radio", stationId: null });
  });

  it("origin é `autoplay` nos dois casos (cauda escolhida pela máquina; nada de origin novo)", async () => {
    await playFromHere({ list: FOLDER, index: 2, playlist: "Rap BR" });
    expect(queued().origin).toBe("autoplay");
    await playFromHere({ list: FOLDER, index: 2 });
    expect(queued().origin).toBe("autoplay");
  });

  it("a faixa segurada abre a fila e a cauda é uma permutação do que vinha DEPOIS dela", async () => {
    await playFromHere({ list: FOLDER, index: 2, playlist: "Rap BR" });
    const ids = queued().items.map((i: { trackId: string }) => i.trackId);
    expect(ids[0]).toBe("3");
    expect(ids.slice(1).sort()).toEqual(["4", "5"]);
    expect(armed().seedTrackId).toBe("3");
  });
});

describe('shuffleUpcoming ("Embaralhar o restante" — CMR-218)', () => {
  const snap = (ids: string[], index: number) => ({
    items: ids.map((id) => ({ trackId: id, origin: "manual", contextId: null, durationMs: 1000 })),
    index,
  });

  it("aplica o snapshot DEVOLVIDO pelo serviço — nunca reordena otimista", async () => {
    // fila real: 1..5 tocando a 1 (4 a seguir)
    (ipc.playerGetQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      snap(["1", "2", "3", "4", "5"], 0),
    );
    await playTrackFrom(FOLDER, 0);
    expect(queueEntries().map((e) => e.trackId)).toEqual(["1", "2", "3", "4", "5"]);

    (ipc.playerShuffleUpcoming as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      snap(["1", "4", "2", "5", "3"], 0),
    );
    await shuffleUpcoming();
    expect(ipc.playerShuffleUpcoming).toHaveBeenCalledTimes(1);
    expect(queueEntries().map((e) => e.trackId)).toEqual(["1", "4", "2", "5", "3"]);
    expect(pb.index).toBe(0);
    expect(toast()).toBe("Restante embaralhado");
  });

  it("guard: com menos de 2 faixas a seguir NÃO chama o IPC", async () => {
    // tocando a penúltima: só 1 a seguir
    (ipc.playerGetQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(snap(["1", "2"], 0));
    await playTrackFrom(FOLDER.slice(0, 2), 0);
    await shuffleUpcoming();
    expect(ipc.playerShuffleUpcoming).not.toHaveBeenCalled();
    expect(toast()).toBe("Nada a embaralhar");
    expect(queueEntries().map((e) => e.trackId)).toEqual(["1", "2"]);
  });

  it("falha do IPC re-lê a fila do serviço em vez de inventar ordem", async () => {
    (ipc.playerGetQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      snap(["1", "2", "3", "4"], 0),
    );
    await playTrackFrom(FOLDER.slice(0, 4), 0);
    (ipc.playerShuffleUpcoming as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("x"));
    (ipc.playerGetQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      snap(["1", "2", "3", "4"], 1),
    );
    await shuffleUpcoming();
    // o syncQueue do catch é a única fonte da nova ordem/índice
    expect(ipc.playerGetQueue).toHaveBeenCalledTimes(2);
    expect(queueEntries().map((e) => e.trackId)).toEqual(["1", "2", "3", "4"]);
    expect(pb.index).toBe(1);
  });
});

describe("toggleLike (coração do Now Playing — CMR-220)", () => {
  const liked = (id: number, at: number | null): Track =>
    ({ ...track(id), liked_at: at, like_updated_at: at }) as Track;

  beforeEach(() => localStorage.removeItem("kv-mobile-likes"));

  it("faixa não curtida: chama set_like com liked=true, marca otimista e avisa", async () => {
    const t = liked(1, null);
    expect(isLiked(t)).toBe(false);
    await toggleLike(t);
    expect(ipc.playerSetLike).toHaveBeenCalledWith("1", true);
    expect(isLiked(t)).toBe(true);
    expect(toast()).toBe("Curtida");
  });

  it("faixa curtida no manifest: chama set_like com liked=false (invertido)", async () => {
    const t = liked(2, 100);
    expect(isLiked(t)).toBe(true);
    await toggleLike(t);
    expect(ipc.playerSetLike).toHaveBeenCalledWith("2", false);
    expect(isLiked(t)).toBe(false);
    expect(toast()).toBe("Curtida removida");
  });

  it("falha do IPC reverte o estado otimista e avisa", async () => {
    const t = liked(3, null);
    (ipc.playerSetLike as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("sem plugin"));
    await toggleLike(t);
    expect(isLiked(t)).toBe(false);
    expect(toast()).toBe("Falha ao registrar a curtida");
  });

  it("o override sobrevive em localStorage (kv-mobile-likes)", async () => {
    await toggleLike(liked(4, null));
    const saved = JSON.parse(localStorage.getItem("kv-mobile-likes") ?? "{}");
    expect(saved["4"]).toMatchObject({ liked: true });
    expect(typeof saved["4"].at).toBe("number");
  });
});

describe('loadRecents (shelf "Recently played" — CMR-215)', () => {
  it("coalesce chamadas concorrentes: uma única ida ao lib_recent_plays", async () => {
    // foco + track_changed + fim de fila chegam juntos; cada um drenaria o
    // journal de novo à toa.
    let resolve!: (v: Track[]) => void;
    (ipc.libRecentPlays as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<Track[]>((r) => (resolve = r)),
    );
    const a = loadRecents();
    const b = loadRecents();
    expect(b).toBe(a);
    expect(ipc.libRecentPlays).toHaveBeenCalledTimes(1);
    resolve([track(1), track(2)]);
    await a;
    expect(recents().map((t) => t.id)).toEqual(["1", "2"]);
    // Liquidada: a próxima chamada vai ao backend de novo.
    await loadRecents();
    expect(ipc.libRecentPlays).toHaveBeenCalledTimes(2);
  });

  it("falha do IPC não derruba a shelf nem prende a próxima chamada", async () => {
    (ipc.libRecentPlays as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("sem plugin");
    });
    await loadRecents();
    await loadRecents();
    expect(ipc.libRecentPlays).toHaveBeenCalledTimes(2);
  });
});
