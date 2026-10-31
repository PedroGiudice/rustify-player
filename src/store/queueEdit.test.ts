import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueuePreload = vi.fn().mockResolvedValue(undefined);
vi.mock("../tauri", () => ({
  setVolume: vi.fn().mockResolvedValue(undefined),
  playerEnqueueNext: (path: string) => enqueuePreload(path),
}));

import {
  moveUpcoming, removeUpcoming, player, setPlayer, advanceQueue, moveUpcomingTrack, removeUpcomingTrack,
  restoreUpcoming, clearUpcoming, restoreCleared,
} from "./player";
import type { Track } from "../tauri";

const mk = (id: string) => ({ id, title: id, path: `/m/${id}` } as Track);
const ids = () => player.queue.map((t) => t.id);

beforeEach(() => {
  enqueuePreload.mockClear();
  const q = ["p", "a", "b", "c", "d"].map(mk);
  // p já tocou; a está tocando; "a seguir" = b, c, d
  setPlayer({ queue: q, queueIndex: 1, currentTrack: q[1], repeatMode: "off" });
});

describe("editar a fila (a seguir)", () => {
  it("move dentro do 'a seguir' sem tocar no que já tocou nem na atual", () => {
    moveUpcoming(2, 0); // d vai para logo depois da atual
    expect(ids()).toEqual(["p", "a", "d", "b", "c"]);
    expect(player.queueIndex).toBe(1);
    expect(player.currentTrack?.id).toBe("a");
  });
  it("mover a próxima refaz o preload gapless", () => {
    moveUpcoming(0, 2); // b deixa de ser a próxima; c passa a ser
    expect(ids()).toEqual(["p", "a", "c", "d", "b"]);
    expect(enqueuePreload).toHaveBeenCalledWith("/m/c");
  });
  it("índice fora do 'a seguir' ou igual não muda nada", () => {
    moveUpcoming(1, 1);
    moveUpcoming(-1, 0);
    moveUpcoming(0, 9);
    expect(ids()).toEqual(["p", "a", "b", "c", "d"]);
  });
  it("tirar da fila remove só aquela posição", () => {
    removeUpcoming(1);
    expect(ids()).toEqual(["p", "a", "b", "d"]);
    removeUpcoming(5);
    expect(ids()).toEqual(["p", "a", "b", "d"]);
  });
});

// A28/B4 (varredura de 31/10): editar pela FAIXA, não pelo índice capturado
// no início do gesto — a música pode trocar no meio (advanceQueue) e o
// índice relativo passa a apontar para a vizinha.
describe("editar a fila pela faixa (A28)", () => {
  const up = (id: string) => player.queue.find((t) => t.id === id)!;

  it("âncora que virou a atual: não há onde soltar, nada muda", () => {
    const dragged = up("d");
    const anchor = up("b");
    advanceQueue(); // b passa a tocar; "a seguir" = c, d
    expect(moveUpcomingTrack(dragged, anchor)).toBe(false);
    expect(ids()).toEqual(["p", "a", "b", "c", "d"]);
  });

  it("com as duas ainda no 'a seguir', a ordem relativa vale depois do avanço", () => {
    setPlayer({ queue: ["p", "a", "b", "c", "d", "e"].map(mk), queueIndex: 1 });
    setPlayer({ currentTrack: player.queue[1] });
    const dragged = up("e");
    const anchor = up("c");
    advanceQueue(); // b toca; "a seguir" = c, d, e
    expect(moveUpcomingTrack(dragged, anchor)).toBe(true);
    expect(ids()).toEqual(["p", "a", "b", "e", "c", "d"]);
  });

  it("faixa que virou a atual não é movida nem tirada", () => {
    const b = up("b");
    advanceQueue();
    expect(moveUpcomingTrack(b, up("d"))).toBe(false);
    expect(removeUpcomingTrack(b)).toBeNull();
    expect(ids()).toEqual(["p", "a", "b", "c", "d"]);
  });

  it("tirar pela faixa e desfazer devolve ao mesmo lugar", () => {
    const tok = removeUpcomingTrack(up("c"))!;
    expect(ids()).toEqual(["p", "a", "b", "d"]);
    restoreUpcoming(tok);
    expect(ids()).toEqual(["p", "a", "b", "c", "d"]);
  });

  it("desfazer depois de a música trocar volta logo depois da vizinha de antes", () => {
    const tok = removeUpcomingTrack(up("d"))!; // vizinha de antes: c
    advanceQueue(); // b toca
    restoreUpcoming(tok);
    expect(ids()).toEqual(["p", "a", "b", "c", "d"]);
  });

  it("desfazer quando a vizinha já tocou volta logo depois da atual", () => {
    const tok = removeUpcomingTrack(up("c"))!; // vizinha: b
    advanceQueue(); // b toca
    advanceQueue(); // d toca; b ficou para trás
    restoreUpcoming(tok);
    expect(ids()).toEqual(["p", "a", "b", "d", "c"]);
  });

  it("tirar a próxima refaz o preload gapless", () => {
    enqueuePreload.mockClear();
    removeUpcomingTrack(up("b"));
    expect(enqueuePreload).toHaveBeenCalledWith("/m/c");
  });
});

describe("limpar a fila (B4)", () => {
  it("tira só o 'a seguir': o que já tocou, a atual e a proveniência ficam", () => {
    setPlayer("queueSource", { kind: "station", name: "Noite" });
    const removed = clearUpcoming();
    expect(removed.map((t) => t.id)).toEqual(["b", "c", "d"]);
    expect(ids()).toEqual(["p", "a"]);
    expect(player.queueIndex).toBe(1);
    expect(player.currentTrack?.id).toBe("a");
    expect(player.queueSource).toEqual({ kind: "station", name: "Noite" });
  });

  it("fila sem 'a seguir' devolve lista vazia e não mexe em nada", () => {
    clearUpcoming();
    expect(clearUpcoming()).toEqual([]);
    expect(ids()).toEqual(["p", "a"]);
  });

  it("desfazer recoloca as faixas logo depois da atual, antes do que entrou depois", () => {
    const removed = clearUpcoming();
    setPlayer("queue", (q) => [...q, mk("x")]);
    restoreCleared(removed);
    expect(ids()).toEqual(["p", "a", "b", "c", "d", "x"]);
  });

  it("desfazer não repete a faixa que passou a tocar", () => {
    const removed = clearUpcoming();
    setPlayer({ queue: [...player.queue, mk("c")], queueIndex: 2 });
    setPlayer({ currentTrack: player.queue[2] });
    restoreCleared(removed);
    expect(ids()).toEqual(["p", "a", "c", "b", "d"]);
  });
});
