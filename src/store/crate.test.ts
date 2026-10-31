/* ============================================================
   crate.test.ts — Store do board de downloads do Crate (D1).
   Cobre: boot re-hidrata via slskJobs() + onSlskJobs(); evento
   atualiza jobs() e activeCount(); persistência de kv-crate-dest.

   bootCrateStore() é idempotente por design (singleton — o app
   inteiro compartilha um único board). __resetForTests() existe só
   pra isolar casos de teste; produção nunca chama.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DownloadJob, TidalJob } from "../tauri";

// Mock do módulo tauri ANTES de importar o store (vi.mock é hoisted).
vi.mock("../tauri", () => ({
  slskJobs: vi.fn(async () => []),
  onSlskJobs: vi.fn(async (_cb: (jobs: DownloadJob[]) => void) => () => {}),
  crateTidalJobs: vi.fn(async () => ({ jobs: [], pastas: [] })),
}));

import * as ipc from "../tauri";
import {
  jobs, activeCount, bootCrateStore, loadLastDest, saveLastDest, newArrivalsCount, markArrivalsSeen, __resetForTests,
  tidal, refreshTidal, setCrateViewOpen, setCrateTidalFocus, saveSearchCache, loadSearchCache, SEARCH_CACHE_MS,
} from "./crate";

function tjob(id: string, status: TidalJob["status"], extra: Partial<TidalJob> = {}): TidalJob {
  return { id, url: `https://tidal.com/album/${id}`, playlist: "Jazz", status, added: "31/10 10:00", resumo: "", inicio: null, fim: null, ...extra };
}

function job(id: string, kind: DownloadJob["state"]["kind"], extra: Record<string, unknown> = {}): DownloadJob {
  return {
    job_id: id,
    source: { kind: "soulseek", username: "peer", remote_filename: "Artist - Title.flac", size: 1000 },
    meta: { artist: "", title: "", album: "", year: null, label: null },
    artwork_url: null,
    format_in: null,
    tracks: 1,
    display: "Artist - Title",
    dest_playlist: "Rap & Hip-Hop",
    state: { kind, ...extra } as DownloadJob["state"],
    quality_label: "FLAC 16/44",
    alternates: [],
    tried_source_ids: [],
    created_at: 0,
    attempt: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.slskJobs).mockResolvedValue([]);
  vi.mocked(ipc.onSlskJobs).mockImplementation(async () => () => {});
  vi.mocked(ipc.crateTidalJobs).mockResolvedValue({ jobs: [], pastas: [] });
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

  it("evento com objetos novos reconcilia por job_id: o mesmo job mantém a identidade (a Fila não remonta a linha)", async () => {
    // Cada slsk-jobs chega do IPC como um board inteiro de objetos novos
    // (spec §3.5). Sem reconciliação por chave, o <For> da Fila descartava
    // e recriava todas as linhas a cada evento (crate-1).
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(ipc.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    await bootCrateStore();
    emit!([job("a", "downloading", { pct: 10, bps: 100, eta_s: null }), job("b", "queued")]);
    const before = jobs()[0];
    emit!([job("a", "downloading", { pct: 55, bps: 100, eta_s: null }), job("b", "queued")]);
    expect(jobs()[0]).toBe(before);
    expect(jobs()[0].state).toMatchObject({ kind: "downloading", pct: 55 });
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

describe("newArrivalsCount (B8)", () => {
  it("conta só o que ficou pronto depois do boot e zera ao abrir o Crate", async () => {
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(ipc.slskJobs).mockResolvedValue([job("velho", "ready", { track_id: "1" })]);
    vi.mocked(ipc.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    await bootCrateStore();
    expect(newArrivalsCount()).toBe(0); // pronto antes do boot não é chegada
    emit!([job("velho", "ready", { track_id: "1" }), job("a", "indexing")]);
    expect(newArrivalsCount()).toBe(0);
    emit!([job("velho", "ready", { track_id: "1" }), job("a", "ready", { track_id: "2" })]);
    emit!([job("velho", "ready", { track_id: "1" }), job("a", "ready", { track_id: "2" })]);
    expect(newArrivalsCount()).toBe(1); // o mesmo job não conta duas vezes
    markArrivalsSeen();
    expect(newArrivalsCount()).toBe(0);
    emit!([job("a", "ready", { track_id: "2" }), job("b", "ready", { track_id: "3" })]);
    expect(newArrivalsCount()).toBe(1);
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

describe("Tidal no store (A17)", () => {
  it("activeCount soma os jobs da Tidal na fila ou baixando", async () => {
    vi.mocked(ipc.slskJobs).mockResolvedValue([job("q", "queued")]);
    vi.mocked(ipc.crateTidalJobs).mockResolvedValue({
      jobs: [tjob("1", "fila"), tjob("2", "baixando"), tjob("3", "ok"), tjob("4", "falhou")],
      pastas: ["Jazz"],
    });
    await bootCrateStore();
    await refreshTidal();
    expect(activeCount()).toBe(3);
    expect(tidal.pastas).toEqual(["Jazz"]);
    expect(tidal.load).toBe("loaded");
  });

  it("job que vira ok depois do boot entra nas chegadas com as faixas que chegaram", async () => {
    vi.mocked(ipc.crateTidalJobs).mockResolvedValue({ jobs: [tjob("velho", "ok"), tjob("a", "baixando")], pastas: [] });
    await bootCrateStore();
    await refreshTidal();
    expect(newArrivalsCount()).toBe(0); // pronto antes do boot não é chegada
    vi.mocked(ipc.crateTidalJobs).mockResolvedValue({
      jobs: [tjob("velho", "ok"), tjob("a", "ok", { resumo: "Mix: 12 novas, 3 já no acervo, 0 falhas de 15; 12 na cmr-auto" })],
      pastas: [],
    });
    await refreshTidal();
    await refreshTidal();
    expect(newArrivalsCount()).toBe(12);
    markArrivalsSeen();
    expect(newArrivalsCount()).toBe(0);
  });

  it("job ok sem nenhuma faixa nova não acende o ponto", async () => {
    vi.mocked(ipc.crateTidalJobs).mockResolvedValue({ jobs: [tjob("a", "baixando")], pastas: [] });
    await bootCrateStore();
    await refreshTidal();
    vi.mocked(ipc.crateTidalJobs).mockResolvedValue({
      jobs: [tjob("a", "ok", { resumo: "X: 0 novas, 9 já no acervo, 0 falhas de 9" })],
      pastas: [],
    });
    await refreshTidal();
    expect(newArrivalsCount()).toBe(0);
  });

  it("fila fora marca erro e mantém os jobs que já tinha", async () => {
    vi.mocked(ipc.crateTidalJobs).mockResolvedValue({ jobs: [tjob("a", "fila")], pastas: [] });
    await bootCrateStore();
    await refreshTidal();
    vi.mocked(ipc.crateTidalJobs).mockRejectedValue("Não consegui falar com a fila de downloads da Tidal.");
    await refreshTidal();
    expect(tidal.load).toBe("error");
    expect(tidal.loadError).toBe("Não consegui falar com a fila de downloads da Tidal.");
    expect(tidal.jobs.map((j) => j.id)).toEqual(["a"]);
  });
});

describe("poll da Tidal (A17)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("10 s com o Crate aberto, 60 s fechado", async () => {
    await bootCrateStore();
    await vi.advanceTimersByTimeAsync(0);
    const base = vi.mocked(ipc.crateTidalJobs).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(ipc.crateTidalJobs).mock.calls.length).toBe(base); // fechado: nada em 30 s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(ipc.crateTidalJobs).mock.calls.length).toBe(base + 1);
    setCrateViewOpen(true); // abrir consulta na hora e passa a 10 s
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(ipc.crateTidalJobs).mock.calls.length).toBe(base + 2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.mocked(ipc.crateTidalJobs).mock.calls.length).toBe(base + 4);
    setCrateViewOpen(false);
  });

  it("Crate aberto na aba Buscar sem job da Tidal andando: 60 s; com job andando, 10 s (A49)", async () => {
    await bootCrateStore();
    setCrateViewOpen(true);
    setCrateTidalFocus(false);
    await vi.advanceTimersByTimeAsync(0);
    const base = vi.mocked(ipc.crateTidalJobs).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(ipc.crateTidalJobs).mock.calls.length).toBe(base);
    vi.mocked(ipc.crateTidalJobs).mockResolvedValue({ jobs: [tjob("a", "baixando")], pastas: [] });
    await vi.advanceTimersByTimeAsync(30_000); // consulta lenta vê o job andando
    expect(vi.mocked(ipc.crateTidalJobs).mock.calls.length).toBe(base + 1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.mocked(ipc.crateTidalJobs).mock.calls.length).toBe(base + 3);
    setCrateTidalFocus(true);
    setCrateViewOpen(false);
  });

  it("com a VM fora e o Crate fechado, para de consultar", async () => {
    vi.mocked(ipc.crateTidalJobs).mockRejectedValue("fora");
    await bootCrateStore();
    await vi.advanceTimersByTimeAsync(0);
    const base = vi.mocked(ipc.crateTidalJobs).mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(vi.mocked(ipc.crateTidalJobs).mock.calls.length).toBe(base);
  });
});

describe("busca preservada (B28)", () => {
  it("guarda a busca por 10 min e esquece depois", () => {
    saveSearchCache({ query: "smino anita", savedAt: 1_000 } as Parameters<typeof saveSearchCache>[0]);
    expect(loadSearchCache(1_000 + SEARCH_CACHE_MS - 1)?.query).toBe("smino anita");
    expect(loadSearchCache(1_000 + SEARCH_CACHE_MS + 1)).toBeNull();
  });
});

describe("destino único do Crate (B7)", () => {
  it("cai no destino antigo da aba Tidal quando o do Crate não existe", () => {
    localStorage.setItem("kv-crate-tidal-dest", "Jazz");
    expect(loadLastDest()).toBe("Jazz");
    saveLastDest("Funk Brasileiro");
    expect(loadLastDest()).toBe("Funk Brasileiro");
  });
});
