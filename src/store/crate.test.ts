/* ============================================================
   crate.test.ts — Store do board de downloads do Crate (D1).
   Cobre: boot re-hidrata via slskJobs() + onSlskJobs(); evento
   atualiza jobs() e activeCount(); persistência de kv-crate-dest.

   bootCrateStore() é idempotente por design (singleton — o app
   inteiro compartilha um único board). __resetForTests() existe só
   pra isolar casos de teste; produção nunca chama.
   ============================================================ */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DownloadJob } from "../tauri";

// Mock do módulo tauri ANTES de importar o store (vi.mock é hoisted).
vi.mock("../tauri", () => ({
  slskJobs: vi.fn(async () => []),
  onSlskJobs: vi.fn(async (_cb: (jobs: DownloadJob[]) => void) => () => {}),
}));

import * as ipc from "../tauri";
import { jobs, activeCount, bootCrateStore, loadLastDest, saveLastDest, __resetForTests } from "./crate";

function job(id: string, kind: DownloadJob["state"]["kind"], extra: Record<string, unknown> = {}): DownloadJob {
  return {
    job_id: id,
    username: "peer",
    remote_filename: "Artist - Title.flac",
    display: "Artist - Title",
    dest_playlist: "Rap & Hip-Hop",
    state: { kind, ...extra } as DownloadJob["state"],
    size: 1000,
    quality_label: "FLAC 16/44",
    alternates: [],
    tried_source_ids: [],
    created_at: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.slskJobs).mockResolvedValue([]);
  vi.mocked(ipc.onSlskJobs).mockImplementation(async () => () => {});
  localStorage.clear();
  __resetForTests();
});

describe("bootCrateStore", () => {
  it("re-hidrata jobs() com slskJobs() e assina onSlskJobs()", async () => {
    vi.mocked(ipc.slskJobs).mockResolvedValue([job("j1", "downloading", { pct: 10, bps: 100, eta_s: null })]);
    await bootCrateStore();
    expect(jobs().map((j) => j.job_id)).toEqual(["j1"]);
    expect(ipc.onSlskJobs).toHaveBeenCalled();
  });

  it("evento slsk-jobs atualiza jobs() com o board inteiro", async () => {
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(ipc.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    await bootCrateStore();
    expect(emit).not.toBeNull();
    emit!([job("a", "queued"), job("b", "ready", { track_id: "42" })]);
    expect(jobs().map((j) => j.job_id)).toEqual(["a", "b"]);
  });

  it("idempotente: segunda chamada não re-assina nem re-hidrata", async () => {
    await bootCrateStore();
    await bootCrateStore();
    expect(ipc.slskJobs).toHaveBeenCalledTimes(1);
    expect(ipc.onSlskJobs).toHaveBeenCalledTimes(1);
  });
});

describe("activeCount", () => {
  it("conta só estados não-terminais (queued/enqueued/downloading/stalled/processing/indexing)", async () => {
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(ipc.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    await bootCrateStore();
    emit!([
      job("q", "queued"),
      job("e", "enqueued", { queue_position: 3 }),
      job("d", "downloading", { pct: 50, bps: 1000, eta_s: 10 }),
      job("s", "stalled", { since_secs: 130 }),
      job("p", "processing"),
      job("i", "indexing"),
      job("r", "ready", { track_id: "1" }),
      job("f", "failed", { reason: "x", retryable: false }),
      job("c", "canceled"),
    ]);
    expect(activeCount()).toBe(6);
  });

  it("zero jobs -> activeCount 0", async () => {
    await bootCrateStore();
    expect(activeCount()).toBe(0);
  });
});

describe("kv-crate-dest", () => {
  it("loadLastDest retorna null sem valor salvo", () => {
    expect(loadLastDest()).toBeNull();
  });

  it("saveLastDest persiste e loadLastDest lê de volta", () => {
    saveLastDest("Rap & Hip-Hop");
    expect(loadLastDest()).toBe("Rap & Hip-Hop");
    expect(localStorage.getItem("kv-crate-dest")).toBe("Rap & Hip-Hop");
  });
});
