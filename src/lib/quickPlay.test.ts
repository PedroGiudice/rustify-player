/* quickPlay: sortear do acervo que falha avisa (B5) em vez de rejeitar calado. */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../components/PlayerBar", () => ({ playTrack: vi.fn() }));
vi.mock("../tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri")>();
  return { ...actual, libShuffle: vi.fn(async () => []), setVolume: vi.fn(), playerEnqueueNext: vi.fn(async () => {}) };
});

import { shuffleAll } from "./quickPlay";
import { libShuffle } from "../tauri";
import { toast, dismissToast, runToastAction } from "../store/toast";

afterEach(() => { dismissToast(); vi.clearAllMocks(); });

describe("shuffleAll", () => {
  it("falha no sorteio avisa com Tentar de novo, sem rejeitar", async () => {
    vi.mocked(libShuffle).mockRejectedValueOnce(new Error("qdrant fora"));
    await expect(shuffleAll()).resolves.toBeUndefined();
    expect(toast()?.message).toMatch(/^Não consegui sortear/);
    runToastAction();
    await vi.waitFor(() => expect(vi.mocked(libShuffle)).toHaveBeenCalledTimes(2));
  });
});
