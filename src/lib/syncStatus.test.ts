import { describe, it, expect } from "vitest";
import { syncLine, syncDetail, syncStale, mergeSync } from "./syncStatus";
import type { DeviceSync } from "../tauri";

const NOW = new Date(2026, 9, 31, 12, 0).getTime();
const d = (r: Partial<DeviceSync>): DeviceSync => ({
  device_id: "s24", last_batch_at: Math.floor(NOW / 1000) - 12 * 60, accepted: 36, rejected: 0,
  plays: 34, likes: 2, total_accepted: 900, ...r,
});

describe("sync do celular (B14)", () => {
  it("quando foi", () => {
    expect(syncLine(d({}), NOW)).toBe("S24: último sync há 12 min");
    expect(syncLine(d({ last_batch_at: NOW / 1000 - 20 }), NOW)).toBe("S24: último sync agora");
    expect(syncLine(d({ last_batch_at: NOW / 1000 - 5 * 3600 }), NOW)).toBe("S24: último sync há 5 h");
    expect(syncLine(d({ last_batch_at: NOW / 1000 - 3 * 86_400 }), NOW)).toBe("S24: último sync há 3 dias");
    expect(syncLine(d({ device_id: "desconhecido" }), NOW)).toBe("Aparelho sem nome: último sync há 12 min");
  });

  it("o que veio no último lote", () => {
    expect(syncDetail(d({}))).toBe("34 escutas, 2 curtidas");
    expect(syncDetail(d({ plays: 1, likes: 1 }))).toBe("1 escuta, 1 curtida");
    expect(syncDetail(d({ plays: 0, likes: 0, accepted: 0 }))).toBe("lote vazio");
    expect(syncDetail(d({ rejected: 3 }))).toBe("34 escutas, 2 curtidas · 3 recusados");
  });

  it("âmbar passadas 24 h", () => {
    expect(syncStale(d({}), NOW)).toBe(false);
    expect(syncStale(d({ last_batch_at: NOW / 1000 - 25 * 3600 }), NOW)).toBe(true);
  });

  it("evento novo substitui o do mesmo aparelho e sobe para o topo", () => {
    const velho = d({ device_id: "outro", last_batch_at: 1 });
    const s24 = d({ last_batch_at: 2 });
    const novo = d({ last_batch_at: 3, plays: 5 });
    expect(mergeSync([s24, velho], novo)).toEqual([novo, velho]);
  });
});
