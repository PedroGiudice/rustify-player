import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueuePreload = vi.fn().mockResolvedValue(undefined);
vi.mock("../tauri", () => ({
  setVolume: vi.fn().mockResolvedValue(undefined),
  playerEnqueueNext: (path: string) => enqueuePreload(path),
}));

import { moveUpcoming, removeUpcoming, player, setPlayer } from "./player";
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
