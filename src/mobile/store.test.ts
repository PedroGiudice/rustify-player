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
  libRescan: vi.fn(async () => 0),
  libListTracks: vi.fn(async () => []),
  libListFolders: vi.fn(async () => []),
  libListStations: vi.fn(async () => []),
  libTastePositives: vi.fn(async () => []),
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
  queueContextId,
  queueEntries,
  queueOrigin,
  recents,
  rescan,
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

  it("só a faixa escolhida é `manual`; a cauda que o Kotlin auto-avança é `playlist` (por item)", async () => {
    // Antes a fila inteira ia como `manual`: as faixas que o serviço avançava
    // sozinho depois da linha tocada entravam no journal com peso cheio no
    // sinal v3, quando são escuta passiva (desconto 0.6 do `playlist`).
    // Paridade com o desktop: head manual + continuações playlist.
    await playFolderFrom(FOLDER, 2, "Rap BR");
    const q = queued();
    expect(q.origin).toBe("playlist");
    expect(q.contextId).toBe("Rap BR");
    const items = q.items as { trackId: string; origin?: string; contextId?: string | null }[];
    expect(items.map((i) => i.origin ?? q.origin)).toEqual([
      "playlist",
      "playlist",
      "manual",
      "playlist",
      "playlist",
    ]);
    // O metaMap do Kotlin NÃO herda o contextId da fila num item com origin
    // próprio (o service faz fallback só na adoção): a pasta vai explícita no
    // item pra get_queue e o itemMeta do like ficarem coerentes.
    expect(items[2]).toMatchObject({ origin: "manual", contextId: "Rap BR" });
    expect(items.map((i) => i.contextId ?? q.contextId)).toEqual(Array(5).fill("Rap BR"));
  });

  it("o snapshot otimista já carrega a origem por item (fila do serviço indisponível mantém)", async () => {
    (ipc.playerGetQueue as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("x"));
    await playFolderFrom(FOLDER, 2, "Rap BR");
    expect(queueEntries().map((e) => e.origin)).toEqual([
      "playlist",
      "playlist",
      "manual",
      "playlist",
      "playlist",
    ]);
    expect(queueEntries().every((e) => e.contextId === "Rap BR")).toBe(true);
    expect(queueOrigin()).toBe("manual");
  });

  it("a fila é a pasta INTEIRA, na ordem, começando no índice tocado", async () => {
    await playFolderFrom(FOLDER, 2, "Rap BR");
    const ids = queued().items.map((i: { trackId: string }) => i.trackId);
    expect(ids).toEqual(["1", "2", "3", "4", "5"]);
    expect(armed().seedTrackId).toBe("3");
  });
});

describe("playTrackFrom (linha tocada fora de playlist: álbum/artista/acervo/busca/shelf — CMR-211)", () => {
  it("head `manual`, cauda `album_seq` (o default do desktop pro avanço natural), sem contexto, continuidade radio", async () => {
    // Antes a lista inteira a partir do índice ia como `manual`: a cauda que o
    // Kotlin auto-avança entrava no journal com peso cheio no sinal v3. No
    // desktop o avanço natural de álbum/lista solta cai no default `album_seq`,
    // que fica FORA dos sinais por design — paridade.
    await playTrackFrom(FOLDER, 2);
    const q = queued();
    expect(q).toMatchObject({ origin: "album_seq", contextId: null, startIndex: 2 });
    expect(armed()).toMatchObject({ mode: "radio", stationId: null, seedTrackId: "3" });
    const items = q.items as { trackId: string; origin?: string; contextId?: string | null }[];
    // Só o item tocado carrega override; o resto herda o escalar da fila.
    expect(items[2]).toMatchObject({ origin: "manual", contextId: null });
    expect(items.filter((_, i) => i !== 2).every((i) => !("origin" in i))).toBe(true);
    expect(items.map((i) => i.origin ?? q.origin)).toEqual([
      "album_seq",
      "album_seq",
      "manual",
      "album_seq",
      "album_seq",
    ]);
  });

  it("o snapshot otimista já carrega a origem por item e o contexto nulo", async () => {
    (ipc.playerGetQueue as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("x"));
    await playTrackFrom(FOLDER, 2);
    expect(queueEntries().map((e) => e.origin)).toEqual([
      "album_seq",
      "album_seq",
      "manual",
      "album_seq",
      "album_seq",
    ]);
    expect(queueEntries().every((e) => e.contextId === null)).toBe(true);
    expect(queueOrigin()).toBe("manual");
    expect(queueContextId()).toBeNull();
  });
});

describe("queueContextId (contexto do item corrente — alimenta o badge)", () => {
  it("linha tocada numa playlist: head manual COM a pasta como contexto", async () => {
    (ipc.playerGetQueue as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("x"));
    await playFolderFrom(FOLDER, 2, "Rap BR");
    expect(queueOrigin()).toBe("manual");
    expect(queueContextId()).toBe("Rap BR");
  });

  it("segue o snapshot do serviço quando ele chega", async () => {
    (ipc.playerGetQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [
        { trackId: "1", origin: "manual", contextId: "Rap BR", durationMs: 1000 },
        { trackId: "2", origin: "playlist", contextId: "Rap BR", durationMs: 2000 },
      ],
      index: 1,
    });
    await playFolderFrom(FOLDER.slice(0, 2), 0, "Rap BR");
    expect(queueOrigin()).toBe("playlist");
    expect(queueContextId()).toBe("Rap BR");
  });

  it("fila vazia: contexto nulo", async () => {
    (ipc.playerGetQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ items: [], index: -1 });
    await playTrackFrom(FOLDER, 0);
    expect(queueContextId()).toBeNull();
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

  it("com o IPC em voo a fila NÃO muda; o snapshot devolvido é a única fonte da ordem nova", async () => {
    (ipc.playerGetQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      snap(["1", "2", "3", "4", "5"], 0),
    );
    await playTrackFrom(FOLDER, 0);
    let resolve!: (v: { items: unknown[]; index: number }) => void;
    (ipc.playerShuffleUpcoming as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((r) => (resolve = r)),
    );
    const inflight = shuffleUpcoming();
    await new Promise((r) => setTimeout(r, 0));
    // Nada de reordenação otimista: uma ordem inventada no JS divergiria da
    // fila nativa até o snapshot chegar.
    expect(ipc.playerShuffleUpcoming).toHaveBeenCalledTimes(1);
    expect(queueEntries().map((e) => e.trackId)).toEqual(["1", "2", "3", "4", "5"]);
    expect(toast()).not.toBe("Restante embaralhado");
    resolve(snap(["1", "5", "3", "2", "4"], 0));
    await inflight;
    expect(queueEntries().map((e) => e.trackId)).toEqual(["1", "5", "3", "2", "4"]);
    expect(toast()).toBe("Restante embaralhado");
  });

  it("falha do IPC: a ordem original nunca mudou, avisa e re-lê a fila do serviço", async () => {
    (ipc.playerGetQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      snap(["1", "2", "3", "4"], 0),
    );
    await playTrackFrom(FOLDER.slice(0, 4), 0);
    let reject!: (e: Error) => void;
    (ipc.playerShuffleUpcoming as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((_, rej) => (reject = rej)),
    );
    (ipc.playerGetQueue as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      snap(["1", "2", "3", "4"], 1),
    );
    const inflight = shuffleUpcoming();
    await new Promise((r) => setTimeout(r, 0));
    expect(queueEntries().map((e) => e.trackId)).toEqual(["1", "2", "3", "4"]);
    reject(new Error("x"));
    await inflight;
    // Sem toast o botão parecia um no-op mudo; e o syncQueue do catch é a
    // única fonte da nova ordem/índice.
    expect(toast()).toBe("Falha ao embaralhar");
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

  it("dois toques rápidos: a falha do 1º NÃO apaga o override do 2º (reverte só se ainda é o dele)", async () => {
    const t = liked(5, null);
    let rejectFirst!: (e: Error) => void;
    (ipc.playerSetLike as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise((_, rej) => (rejectFirst = rej)),
    );
    const first = toggleLike(t); // liked=true, IPC pendurado
    expect(isLiked(t)).toBe(true);
    await toggleLike(t); // liked=false, IPC ok — este é o override vivo
    expect(isLiked(t)).toBe(false);
    rejectFirst(new Error("tarde"));
    await first;
    // Reverter o 1º restauraria "sem override" e apagaria o gesto que o
    // journal já tem: coração e LWW mentiriam.
    expect(isLiked(t)).toBe(false);
    const saved = JSON.parse(localStorage.getItem("kv-mobile-likes") ?? "{}");
    expect(saved["5"]).toMatchObject({ liked: false });
  });
});

describe("poda dos overrides de like ao carregar a biblioteca (manifest novo)", () => {
  const liked = (id: number, at: number | null): Track =>
    ({ ...track(id), liked_at: at, like_updated_at: at }) as Track;

  beforeEach(() => localStorage.removeItem("kv-mobile-likes"));

  it("rescan descarta o override que o manifest já absorveu e o de faixa que sumiu", async () => {
    const a = liked(6, null);
    const b = liked(7, null);
    await toggleLike(a);
    await toggleLike(b);
    const now = Math.floor(Date.now() / 1000);
    const aNoManifest = { ...a, liked_at: now + 5, like_updated_at: now + 5 };
    // Manifest re-exportado: `6` já traz o like (carimbo >= gesto); `7` sumiu.
    (ipc.libListTracks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([aNoManifest]);
    await rescan();
    expect(JSON.parse(localStorage.getItem("kv-mobile-likes") ?? "{}")).toEqual({});
    expect(isLiked(aNoManifest)).toBe(true);
  });

  it("override mais novo que o manifest sobrevive ao rescan", async () => {
    const a = liked(8, null);
    await toggleLike(a);
    (ipc.libListTracks as ReturnType<typeof vi.fn>).mockResolvedValueOnce([a]);
    await rescan();
    const saved = JSON.parse(localStorage.getItem("kv-mobile-likes") ?? "{}");
    expect(saved["8"]).toMatchObject({ liked: true });
    expect(isLiked(a)).toBe(true);
  });
});

describe('loadRecents (shelf "Recently played" — CMR-215)', () => {
  it("chamada durante o voo coalesce com dirty: exatamente 2 idas ao lib_recent_plays", async () => {
    // foco + track_changed + fim de fila chegam juntos: cada um drenaria o
    // journal de novo à toa, MAS a chamada que chega no meio do voo pode ter
    // sido disparada por um evento que a ida em curso não viu (a faixa fechou
    // depois do drain). Ela não se perde: marca dirty e o finally dispara UMA
    // re-execução — não importa quantas chegaram no meio.
    let resolve!: (v: Track[]) => void;
    (ipc.libRecentPlays as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<Track[]>((r) => (resolve = r)),
    );
    (ipc.libRecentPlays as ReturnType<typeof vi.fn>).mockResolvedValueOnce([track(3)]);
    const a = loadRecents();
    const b = loadRecents();
    const c = loadRecents();
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(ipc.libRecentPlays).toHaveBeenCalledTimes(1);
    resolve([track(1), track(2)]);
    await a;
    // A re-execução (segunda ida) é quem manda no estado final.
    await vi.waitFor(() => expect(recents().map((t) => t.id)).toEqual(["3"]));
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc.libRecentPlays).toHaveBeenCalledTimes(2);
  });

  it("sem chamada durante o voo não há re-execução; liquidada, a próxima vai ao backend", async () => {
    await loadRecents();
    expect(ipc.libRecentPlays).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc.libRecentPlays).toHaveBeenCalledTimes(1);
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
