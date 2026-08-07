/* ============================================================
   Crate.test.tsx — Testes da view Crate (busca + download Soulseek).

   Cobre a lista de testes da spec §9 (frontend): linha por
   ResultGroup; owned mostra Tocar e não Baixar; sem suggested_dest
   abre o seletor em vez de baixar; Enter dispara busca e digitar
   não dispara; banner de cooldown + force; evento slsk-jobs
   transiciona a linha pra ready; override de destino na toolbar
   propaga + persiste; poll para no onCleanup.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import type { ResultGroup, SearchSnapshot, DownloadJob, Track, FolderPlaylist } from "../tauri";

vi.mock("../components/PlayerBar", () => ({ playTrack: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(async () => undefined) }));

vi.mock("../tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tauri")>();
  return {
    ...actual,
    slskStatus: vi.fn(async () => ({
      reachable: true,
      logged_in: true,
      network_connected: true,
      message: "conectado",
    })),
    slskSearch: vi.fn(async () => "srch1"),
    slskResults: vi.fn(async () => EMPTY_SNAPSHOT),
    slskCancelSearch: vi.fn(async () => undefined),
    slskDedupProbe: vi.fn(async () => [] as Track[]),
    slskDownload: vi.fn(async () => "job1"),
    slskJobs: vi.fn(async () => [] as DownloadJob[]),
    slskTryOtherSource: vi.fn(async () => "job1"),
    slskCancel: vi.fn(async () => undefined),
    slskClearFinished: vi.fn(async () => 0),
    onSlskJobs: vi.fn(async (_cb: (jobs: DownloadJob[]) => void) => () => {}),
    libListFolders: vi.fn(async () => [] as FolderPlaylist[]),
    libGetTracksByIds: vi.fn(async () => [] as Track[]),
  };
});

import * as tauriApi from "../tauri";
import * as opener from "@tauri-apps/plugin-opener";
import { __resetForTests } from "../store/crate";
import Crate from "./Crate";

const EMPTY_SNAPSHOT: SearchSnapshot = {
  state: "empty",
  elapsed_ms: 100,
  responses_seen: 0,
  groups: [],
  note: null,
};

function candidate(overrides: Partial<import("../tauri").Candidate> = {}): import("../tauri").Candidate {
  return {
    id: "cand1",
    username: "peer_a",
    filename: "VARIETY\\Artist\\Album\\01 - Artist - Sicko Mode.flac",
    directory: "VARIETY\\Artist\\Album",
    size: 30_000_000,
    bit_depth: 16,
    sample_rate: 44_100,
    bit_rate: 900,
    length_secs: 312,
    free_slot: true,
    upload_speed: 800_000,
    queue_length: 0,
    score: 100,
    warn: null,
    ...overrides,
  };
}

function group(overrides: Partial<ResultGroup> = {}): ResultGroup {
  return {
    group_key: "artistsicko mode62",
    display_title: "Sicko Mode",
    display_artist: "Travis Scott",
    album_hint: "ASTROWORLD",
    duration_secs: 312,
    quality_label: "FLAC 16/44",
    owned: null,
    suggested_dest: null,
    best: candidate(),
    alternates: [candidate({ id: "cand2", username: "peer_b" })],
    ...overrides,
  };
}

function snapshot(groups: ResultGroup[], state: SearchSnapshot["state"] = "done"): SearchSnapshot {
  return { state, elapsed_ms: 500, responses_seen: groups.length, groups, note: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tauriApi.slskStatus).mockResolvedValue({
    reachable: true,
    logged_in: true,
    network_connected: true,
    message: "conectado",
  });
  vi.mocked(tauriApi.slskSearch).mockResolvedValue("srch1");
  vi.mocked(tauriApi.slskResults).mockResolvedValue(EMPTY_SNAPSHOT);
  vi.mocked(tauriApi.slskDedupProbe).mockResolvedValue([]);
  vi.mocked(tauriApi.slskJobs).mockResolvedValue([]);
  vi.mocked(tauriApi.onSlskJobs).mockImplementation(async () => () => {});
  vi.mocked(tauriApi.libListFolders).mockResolvedValue([]);
  vi.mocked(opener.revealItemInDir).mockResolvedValue(undefined);
  localStorage.clear();
  __resetForTests();
});

afterEach(() => {
  cleanup();
});

async function searchAndRender(groups: ResultGroup[], query = "sicko mode") {
  vi.mocked(tauriApi.slskResults).mockResolvedValue(snapshot(groups));
  const utils = render(() => <Crate />);
  const input = utils.container.querySelector(".coll-search input") as HTMLInputElement;
  fireEvent.input(input, { target: { value: query } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => {
    expect(utils.container.querySelectorAll(".crate-row").length).toBe(groups.length);
  });
  return utils;
}

describe("Crate — resultados de busca", () => {
  it("renderiza uma linha por ResultGroup, com badge de formato e chip de fontes", async () => {
    const { container } = await searchAndRender([group(), group({ group_key: "k2", display_title: "R.I.P. Screw" })]);
    const rows = container.querySelectorAll(".crate-row");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector(".badge-fmt")?.textContent).toContain("FLAC 16/44");
    expect(rows[0].querySelector(".crate-row__sources")?.textContent).toContain("2 fontes");
  });

  it("linha owned mostra 'no acervo' + Tocar, e não mostra Baixar", async () => {
    const owned = group({
      owned: { track_id: "77", title: "Sicko Mode", artist: "Travis Scott" },
    });
    const { container } = await searchAndRender([owned]);
    const row = container.querySelector(".crate-row")!;
    expect(row.textContent).toContain("no acervo");
    const buttons = Array.from(row.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons.some((t) => t.includes("Tocar"))).toBe(true);
    expect(buttons.some((t) => t.includes("Baixar"))).toBe(false);
  });

  it("linha sem suggested_dest mostra 'escolher' e clicar em Baixar abre o seletor em vez de chamar slskDownload", async () => {
    const g = group({ suggested_dest: null });
    const { container } = await searchAndRender([g]);
    const row = container.querySelector(".crate-row")!;
    expect(row.textContent).toContain("escolher");
    const baixarBtn = Array.from(row.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Baixar"),
    )!;
    fireEvent.click(baixarBtn);
    expect(tauriApi.slskDownload).not.toHaveBeenCalled();
    // o seletor abriu — as opções de pasta (mesmo vazias aqui) ficam visíveis
    expect(row.querySelector(".crate-dest__menu")).toBeTruthy();
  });

  it("linha com suggested_dest chama slskDownload ao clicar Baixar", async () => {
    const g = group({ suggested_dest: "Rap & Hip-Hop" });
    const { container } = await searchAndRender([g]);
    const row = container.querySelector(".crate-row")!;
    const baixarBtn = Array.from(row.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Baixar"),
    )!;
    fireEvent.click(baixarBtn);
    await waitFor(() => {
      expect(tauriApi.slskDownload).toHaveBeenCalledWith("srch1", g.group_key, g.best.id, "Rap & Hip-Hop");
    });
  });
});

describe("Crate — busca nunca dispara on-input", () => {
  it("Enter dispara slskSearch; digitar não dispara", async () => {
    const { container } = render(() => <Crate />);
    const input = container.querySelector(".coll-search input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });
    expect(tauriApi.slskSearch).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(tauriApi.slskSearch).toHaveBeenCalledWith("sicko mode", false);
    });
  });
});

describe("Crate — cooldown", () => {
  it("Err('cooldown:8') mostra banner e '[Buscar mesmo assim]' força reenvio", async () => {
    vi.mocked(tauriApi.slskSearch).mockRejectedValueOnce("cooldown:8");
    const { container, getByText } = render(() => <Crate />);
    const input = container.querySelector(".coll-search input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(container.querySelector(".crate-banner")).toBeTruthy();
    });
    expect(container.querySelector(".crate-banner")!.textContent).toContain("rede Soulseek");
    fireEvent.click(getByText(/Buscar mesmo assim/));
    await waitFor(() => {
      expect(tauriApi.slskSearch).toHaveBeenCalledWith("sicko mode", true);
    });
  });
});

describe("Crate — evento slsk-jobs", () => {
  it("transiciona a linha para ready e habilita ▸ Tocar", async () => {
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(tauriApi.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    const g = group({ suggested_dest: "Rap & Hip-Hop" });
    const { container } = await searchAndRender([g]);
    const row = container.querySelector(".crate-row")!;
    const baixarBtn = Array.from(row.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Baixar"),
    )!;
    fireEvent.click(baixarBtn);
    await waitFor(() => expect(tauriApi.slskDownload).toHaveBeenCalled());
    await waitFor(() => expect(emit).not.toBeNull());

    emit!([
      {
        job_id: "job1",
        username: "peer_a",
        remote_filename: g.best.filename,
        display: "Sicko Mode",
        dest_playlist: "Rap & Hip-Hop",
        state: { kind: "ready", track_id: "999" },
        size: g.best.size,
        alternates: [],
        tried_source_ids: [],
        created_at: 0,
      },
    ]);

    await waitFor(() => {
      expect(container.querySelector(".crate-row")!.getAttribute("data-state")).toBe("ready");
    });
    const buttons = Array.from(row.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons.some((t) => t.includes("Tocar"))).toBe(true);
  });
});

describe("Crate — Abrir pasta (estado manual, plugin-opener)", () => {
  async function downloadIntoManual() {
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(tauriApi.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    const g = group({ suggested_dest: "Rap & Hip-Hop" });
    const utils = await searchAndRender([g]);
    const row = utils.container.querySelector(".crate-row")!;
    const baixarBtn = Array.from(row.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Baixar"),
    )!;
    fireEvent.click(baixarBtn);
    await waitFor(() => expect(tauriApi.slskDownload).toHaveBeenCalled());
    await waitFor(() => expect(emit).not.toBeNull());

    emit!([
      {
        job_id: "job1",
        username: "peer_a",
        remote_filename: g.best.filename,
        display: "Sicko Mode",
        dest_playlist: "Rap & Hip-Hop",
        state: { kind: "manual", path: "/home/cmr-auto/slskd_dados/downloads", why: "basename não bateu" },
        size: g.best.size,
        alternates: [],
        tried_source_ids: [],
        created_at: 0,
      },
    ]);
    await waitFor(() => {
      expect(utils.container.querySelector(".crate-row")!.getAttribute("data-state")).toBe("manual");
    });
    return utils;
  }

  it("clicar em '[Abrir pasta]' chama revealItemInDir com o path do job", async () => {
    const { container } = await downloadIntoManual();
    const row = container.querySelector(".crate-row")!;
    const openBtn = Array.from(row.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Abrir pasta"),
    )!;
    fireEvent.click(openBtn);
    await waitFor(() => {
      expect(opener.revealItemInDir).toHaveBeenCalledWith("/home/cmr-auto/slskd_dados/downloads");
    });
  });

  it("se revealItemInDir falhar, cai no fallback de copiar o caminho pro clipboard", async () => {
    vi.mocked(opener.revealItemInDir).mockRejectedValueOnce(new Error("unsupported"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { container } = await downloadIntoManual();
    const row = container.querySelector(".crate-row")!;
    const openBtn = Array.from(row.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Abrir pasta"),
    )!;
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("/home/cmr-auto/slskd_dados/downloads");
    });
  });
});

describe("Crate — destino: override da toolbar", () => {
  it("propaga para todas as linhas e persiste em kv-crate-dest", async () => {
    vi.mocked(tauriApi.libListFolders).mockResolvedValue([
      { name: "Rap & Hip-Hop", track_count: 10, cover_path: null, cover_paths: [] },
      { name: "Rock", track_count: 5, cover_path: null, cover_paths: [] },
    ]);
    const groups = [group({ group_key: "k1" }), group({ group_key: "k2", display_title: "R.I.P. Screw" })];
    const { container } = await searchAndRender(groups);

    const toolbar = container.querySelector(".crate-toolbar")!;
    const toolbarDestBtn = toolbar.querySelector(".crate-dest__btn") as HTMLButtonElement;
    fireEvent.click(toolbarDestBtn);
    await waitFor(() => {
      expect(toolbar.querySelector(".crate-dest__menu")).toBeTruthy();
    });
    const opt = Array.from(toolbar.querySelectorAll(".crate-dest__opt")).find(
      (b) => (b.textContent ?? "").includes("Rap & Hip-Hop"),
    ) as HTMLButtonElement;
    fireEvent.click(opt);

    await waitFor(() => {
      expect(localStorage.getItem("kv-crate-dest")).toBe("Rap & Hip-Hop");
    });
    const rows = container.querySelectorAll(".crate-row");
    rows.forEach((row) => {
      expect(row.textContent).toContain("Rap & Hip-Hop");
    });
  });
});

describe("Crate — destino: precedência (regressão IM-D1)", () => {
  // Bug: destOverride() era semeado com loadLastDest() no mount, promovendo
  // o nível 3 (último destino usado) a nível 1 (override da toolbar) —
  // suggested_dest (nível 2, artista já no acervo) nunca vencia. Nenhum
  // teste anterior combinava kv-crate-dest preenchido com suggested_dest
  // divergente (o teste de override da toolbar acima SETA o override de
  // propósito, o que mascarava o bug).
  it("kv-crate-dest preenchido não vira override — suggested_dest ainda vence sem toque na toolbar", async () => {
    localStorage.setItem("kv-crate-dest", "Trance");
    const g = group({ group_key: "k1", suggested_dest: "Rap & Hip-Hop" });
    const { container } = await searchAndRender([g]);

    // Toolbar não deve mostrar o kv-crate-dest como se fosse override ativo.
    const toolbarBtn = container.querySelector(".crate-toolbar .crate-dest__btn")!;
    expect(toolbarBtn.textContent).not.toContain("Trance");
    expect(container.querySelector(".crate-toolbar .crate-dest__clear")).toBeFalsy();

    const row = container.querySelector(".crate-row")!;
    const baixarBtn = Array.from(row.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Baixar"),
    )!;
    fireEvent.click(baixarBtn);
    await waitFor(() => {
      expect(tauriApi.slskDownload).toHaveBeenCalledWith("srch1", g.group_key, g.best.id, "Rap & Hip-Hop");
    });
  });

  it("kv-crate-dest preenchido resolve como fallback quando não há suggested_dest", async () => {
    localStorage.setItem("kv-crate-dest", "Trance");
    const g = group({ group_key: "k2", suggested_dest: null });
    const { container } = await searchAndRender([g]);

    const row = container.querySelector(".crate-row")!;
    expect(row.textContent).toContain("Trance");
    const baixarBtn = Array.from(row.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Baixar"),
    )!;
    fireEvent.click(baixarBtn);
    await waitFor(() => {
      expect(tauriApi.slskDownload).toHaveBeenCalledWith("srch1", g.group_key, g.best.id, "Trance");
    });
  });
});

describe("Crate — poll de resultados", () => {
  it("clearInterval é chamado no onCleanup", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(() => <Crate />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
