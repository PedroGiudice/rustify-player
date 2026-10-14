import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tauri", () => ({ setVolume: vi.fn().mockResolvedValue(undefined) }));

import { enqueueNextMany, enqueueEndMany, player, setPlayer } from "./player";
import type { Track } from "../tauri";

const mk = (id: string) => ({ id, title: id, path: id } as Track);

beforeEach(() => setPlayer({ queue: ["a", "b", "c"].map(mk), queueIndex: 0 }));

describe("enqueue em lote", () => {
  it("tocar a seguir mantém a ordem recebida logo após a atual", () => {
    enqueueNextMany([mk("x"), mk("y")]);
    expect(player.queue.map((t) => t.id)).toEqual(["a", "x", "y", "b", "c"]);
  });
  it("adicionar à fila vai ao fim; lista vazia não mexe", () => {
    enqueueEndMany([mk("x"), mk("y")]);
    expect(player.queue.map((t) => t.id)).toEqual(["a", "b", "c", "x", "y"]);
    enqueueNextMany([]);
    expect(player.queue).toHaveLength(5);
  });
});
