import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueuePreload = vi.fn().mockResolvedValue(undefined);
vi.mock("../tauri", () => ({
  setVolume: vi.fn().mockResolvedValue(undefined),
  playerEnqueueNext: (path: string) => enqueuePreload(path),
}));

import { enqueueNext, enqueueEnd, enqueueNextMany, enqueueEndMany, player, queueAck, setPlayer } from "./player";
import type { Track } from "../tauri";

const mk = (id: string) => ({ id, title: id, path: `/m/${id}` } as Track);
const ids = () => player.queue.map((t) => t.id);

beforeEach(() => {
  enqueuePreload.mockClear();
  const q = ["a", "b", "c"].map(mk);
  setPlayer({ queue: q, queueIndex: 0, currentTrack: q[0], repeatMode: "off" });
});

describe("enqueue em lote", () => {
  it("tocar a seguir mantém a ordem recebida logo após a atual", () => {
    enqueueNextMany([mk("x"), mk("y")]);
    expect(ids()).toEqual(["a", "x", "y", "b", "c"]);
  });
  it("adicionar à fila vai ao fim; lista vazia não mexe", () => {
    enqueueEndMany([mk("x"), mk("y")]);
    expect(ids()).toEqual(["a", "b", "c", "x", "y"]);
    enqueueNextMany([]);
    expect(player.queue).toHaveLength(5);
  });
  it("tocar a seguir não reinsere a faixa que está tocando", () => {
    enqueueNextMany([mk("a"), mk("x"), mk("a")]);
    expect(ids()).toEqual(["a", "x", "b", "c"]);
    enqueuePreload.mockClear();
    enqueueNextMany([mk("a")]);
    expect(ids()).toEqual(["a", "x", "b", "c"]);
    expect(enqueuePreload).not.toHaveBeenCalled();
  });
});

describe("a faixa que está tocando não volta para a fila", () => {
  it("adicionar ao fim (lote) deixa a atual de fora", () => {
    enqueueEndMany([mk("a"), mk("x"), mk("a")]);
    expect(ids()).toEqual(["a", "b", "c", "x"]);
    enqueueEndMany([mk("a")]);
    expect(ids()).toEqual(["a", "b", "c", "x"]);
  });
  it("tocar a seguir de uma faixa só: a atual é ignorada, outra entra logo depois", () => {
    enqueuePreload.mockClear();
    enqueueNext(mk("a"));
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(enqueuePreload).not.toHaveBeenCalled();
    enqueueNext(mk("x"));
    expect(ids()).toEqual(["a", "x", "b", "c"]);
  });
});

describe("realinhamento do preload gapless", () => {
  it("tocar a seguir (lote) com a próxima já pré-carregada: re-enfileira a nova primeira", () => {
    enqueueNextMany(["x", "y", "z", "w", "v"].map(mk));
    expect(enqueuePreload).toHaveBeenCalledTimes(1);
    expect(enqueuePreload).toHaveBeenCalledWith("/m/x");
  });
  it("tocar a seguir (uma faixa) também realinha", () => {
    enqueueNext(mk("x"));
    expect(enqueuePreload).toHaveBeenCalledWith("/m/x");
  });
  it("adicionar ao fim com a próxima intacta não toca no preload", () => {
    enqueueEndMany([mk("x")]);
    enqueueEnd(mk("y"));
    expect(enqueuePreload).not.toHaveBeenCalled();
  });
  it("fila no fim, sem repeat: adicionar cria a próxima e pré-carrega", () => {
    setPlayer({ queueIndex: 2, currentTrack: player.queue[2] });
    enqueueEnd(mk("x"));
    expect(enqueuePreload).toHaveBeenCalledWith("/m/x");
  });
  it("fila no fim com repeat-all: a próxima era a primeira (volta ao início); adicionar ao fim passa a ser a nova próxima", () => {
    setPlayer({ queueIndex: 2, currentTrack: player.queue[2], repeatMode: "all" });
    enqueueEndMany([mk("x")]);
    expect(enqueuePreload).toHaveBeenCalledTimes(1);
    expect(enqueuePreload).toHaveBeenCalledWith("/m/x");
    enqueueEndMany([mk("w")]);
    expect(enqueuePreload).toHaveBeenCalledTimes(1);
    enqueueNextMany([mk("y")]);
    expect(enqueuePreload).toHaveBeenLastCalledWith("/m/y");
  });
  it("repeat-one: a próxima é a própria faixa, nada a realinhar", () => {
    setPlayer({ repeatMode: "one" });
    enqueueNextMany([mk("x")]);
    expect(enqueuePreload).not.toHaveBeenCalled();
  });
});

describe("confirmação de enfileirar (queueAck)", () => {
  it("conta o que entrou de fato e muda a cada gesto", () => {
    enqueueNextMany([mk("x"), mk("y")]);
    const first = queueAck();
    expect(first?.n).toBe(2);
    expect(first?.where).toBe("next");
    enqueueEnd(mk("z"));
    expect(queueAck()?.n).toBe(1);
    expect(queueAck()?.where).toBe("end");
    expect(queueAck()!.seq).not.toBe(first!.seq);
  });
  it("a faixa que está tocando não conta; nada entrou = sem confirmação nova", () => {
    enqueueEndMany([mk("a"), mk("x")]);
    expect(queueAck()?.n).toBe(1);
    const before = queueAck()!.seq;
    enqueueNextMany([mk("a")]);
    enqueueNext(mk("a"));
    expect(queueAck()!.seq).toBe(before);
  });
});
