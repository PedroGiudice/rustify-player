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
  continuityArm: vi.fn(async () => undefined),
  toQueueItem: (t: Track) => ({ trackId: t.id, path: t.path }),
  toQueueItems: (l: Track[]) => l.map((t) => ({ trackId: t.id, path: t.path })),
}));

import * as ipc from "./ipc";
import {
  playFolder,
  playFolderFrom,
  playFromHere,
  playTrackFrom,
  shuffleFolder,
  shuffleList,
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
