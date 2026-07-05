/* ============================================================
   player.volume.test.ts — persistência de volume (auditoria).

   O comentário antigo do store prometia restauração via
   persistLoadState que nunca existiu (state.json expira em 6h e
   não tinha campo de volume). Contrato novo: kv-volume no
   localStorage, changeVolume como fonte única de mudança,
   applyPersistedVolume restaura no boot.
   ============================================================ */

import { describe, it, expect, vi, beforeEach } from "vitest";

const setVolumeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../tauri", () => ({
  setVolume: (v: number) => setVolumeMock(v),
}));

import { player, changeVolume, applyPersistedVolume } from "./player";

beforeEach(() => {
  localStorage.clear();
  setVolumeMock.mockClear();
});

describe("changeVolume", () => {
  it("atualiza store, persiste em kv-volume e empurra pro engine", async () => {
    await changeVolume(0.37);
    expect(player.volume).toBeCloseTo(0.37);
    expect(player.isMuted).toBe(false);
    expect(localStorage.getItem("kv-volume")).toBe("0.37");
    expect(setVolumeMock).toHaveBeenCalledWith(0.37);
  });

  it("clampa fora do range 0..1", async () => {
    await changeVolume(1.7);
    expect(player.volume).toBe(1);
    await changeVolume(-0.2);
    expect(player.volume).toBe(0);
  });
});

describe("applyPersistedVolume", () => {
  it("restaura o valor salvo e empurra pro engine", async () => {
    localStorage.setItem("kv-volume", "0.55");
    await applyPersistedVolume();
    expect(player.volume).toBeCloseTo(0.55);
    expect(setVolumeMock).toHaveBeenCalledWith(0.55);
  });

  it("storage corrompido cai pro default 1.0", async () => {
    localStorage.setItem("kv-volume", "banana");
    await applyPersistedVolume();
    expect(player.volume).toBe(1);
  });
});
