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
import { navigate } from "../router";
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

function dlJob(id: string, state: DownloadJob["state"], extra: Partial<DownloadJob> = {}): DownloadJob {
  return {
    job_id: id,
    username: "peer_a",
    remote_filename: "VARIETY\\Artist\\Album\\01 - Artist - Sicko Mode.flac",
    display: "Sicko Mode",
    dest_playlist: "Rap & Hip-Hop",
    state,
    size: 30_000_000,
    quality_label: "FLAC 16/44",
    alternates: [],
    tried_source_ids: [],
    created_at: 0,
    ...extra,
  };
}

async function searchAndRender(groups: ResultGroup[], query = "sicko mode") {
  // Objeto NOVO a cada chamada, como o IPC real (slsk_results clona o
  // snapshot): devolver sempre o mesmo objeto mascarava o remount das
  // linhas a cada poll (crate-1).
  vi.mocked(tauriApi.slskResults).mockImplementation(async () => snapshot(structuredClone(groups)));
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
    expect(rows[0].querySelector(".crate-badge")?.textContent).toContain("FLAC 16/44");
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

describe("Crate — busca em voo (crate-8)", () => {
  function runningSnapshot(over: Partial<SearchSnapshot> = {}): SearchSnapshot {
    return { ...snapshot([group()], "running"), responses_seen: 7, elapsed_ms: 12_500, ...over };
  }

  async function startSearch() {
    const utils = render(() => <Crate />);
    const input = utils.container.querySelector(".coll-search input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(utils.container.querySelectorAll(".crate-row").length).toBeGreaterThan(0));
    return { ...utils, input };
  }

  it("Enter no campo durante a busca não cancela nem reinicia a busca em voo; o campo fica somente leitura", async () => {
    vi.mocked(tauriApi.slskResults).mockImplementation(async () => runningSnapshot());
    const { input } = await startSearch();
    expect(input.readOnly).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 0));
    expect(tauriApi.slskSearch).toHaveBeenCalledTimes(1);
    expect(tauriApi.slskCancelSearch).not.toHaveBeenCalled();
  });

  it("nova busca recusada pelo pacer não cancela a anterior; aceita, cancela a anterior", async () => {
    vi.mocked(tauriApi.slskResults).mockImplementation(async () => snapshot([group()], "done"));
    vi.mocked(tauriApi.slskSearch).mockResolvedValueOnce("srch1");
    const { input } = await startSearch();
    expect(input.readOnly).toBe(false);

    vi.mocked(tauriApi.slskSearch).mockRejectedValueOnce("cooldown:3");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(tauriApi.slskSearch).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(tauriApi.slskCancelSearch).not.toHaveBeenCalled();

    vi.mocked(tauriApi.slskSearch).mockResolvedValueOnce("srch2");
    // espera o countdown do botão não importa: Enter no campo chama o backend,
    // e é o backend (pacer) quem decide.
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(tauriApi.slskCancelSearch).toHaveBeenCalledWith("srch1"));
  });

  it("durante a busca o cabeçalho mostra respostas e a barra contra a janela de 25 s, não 'Resultados · 0 faixas'", async () => {
    vi.mocked(tauriApi.slskResults).mockImplementation(async () => runningSnapshot({ groups: [] }));
    const { container } = render(() => <Crate />);
    const input = container.querySelector(".coll-search input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(container.querySelector(".crate-list-head")).toBeTruthy());
    await waitFor(() => expect(container.querySelector(".crate-list-head h2")!.textContent).toContain("7"));
    const head = container.querySelector(".crate-list-head")!;
    const text = (head.textContent ?? "").replace(/ /g, " ");
    expect(text).toContain("Buscando");
    expect(text).toContain("7 respostas");
    expect(text).not.toContain("faixas");
    const bar = head.querySelector(".crate-prog i") as HTMLElement;
    expect(bar.style.width).toBe("50%");
  });
});

describe("Crate — cooldown", () => {
  // v1.1: os dois canais são visualmente distintos — min-interval
  // (Err "cooldown:N") vira countdown NO BOTÃO, sem banner; rede fria
  // (Err "cold:N") é a única que abre o banner âmbar.
  it("Err('cooldown:4') vira countdown no botão, sem banner", async () => {
    vi.mocked(tauriApi.slskSearch).mockRejectedValueOnce("cooldown:4");
    const { container } = render(() => <Crate />);
    const input = container.querySelector(".coll-search input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const btn = container.querySelector(".crate-btn-search") as HTMLButtonElement;
    await waitFor(() => {
      expect(btn.getAttribute("data-cooldown")).toBe("true");
    });
    expect(btn.textContent).toContain("4s");
    expect(container.querySelector(".crate-banner")).toBeFalsy();
  });

  it("Err('cold:540') mostra banner e '[Buscar mesmo assim]' força reenvio", async () => {
    vi.mocked(tauriApi.slskSearch).mockRejectedValueOnce("cold:540");
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

describe("Crate — erros aparecem na tela (crate-6)", () => {
  const alertText = (c: HTMLElement) => c.querySelector('[role="alert"]')?.textContent ?? "";

  async function searchWithRejection(err: string) {
    vi.mocked(tauriApi.slskSearch).mockRejectedValueOnce(err);
    const utils = render(() => <Crate />);
    const input = utils.container.querySelector(".coll-search input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(utils.container.querySelector('[role="alert"]')).toBeTruthy());
    return utils;
  }

  it("busca recusada pelo limite horário (busy) explica o limite", async () => {
    const { container } = await searchWithRejection("busy");
    expect(alertText(container)).toContain("40 buscas por hora");
  });

  it("busca que falha por timeout do coordinator mostra o motivo em português", async () => {
    const { container } = await searchWithRejection("coordinator nao respondeu a tempo");
    expect(alertText(container)).toContain("não respondeu a tempo");
  });

  it("falha ao baixar aparece na tela, e Fechar some com o aviso", async () => {
    vi.mocked(tauriApi.slskDownload).mockRejectedValueOnce("destino de playlist invalido");
    const { container, getByText } = await searchAndRender([group({ suggested_dest: "Rap & Hip-Hop" })]);
    const baixar = Array.from(container.querySelectorAll(".crate-row button")).find((b) =>
      (b.textContent ?? "").includes("Baixar"),
    )!;
    fireEvent.click(baixar);
    await waitFor(() => expect(alertText(container)).toContain("Não deu pra baixar"));
    expect(alertText(container)).toContain("nome de playlist inválido");
    fireEvent.click(getByText("Fechar"));
    expect(container.querySelector('[role="alert"]')).toBeFalsy();
  });

  async function searchWithFailedJob(extra: Partial<DownloadJob>) {
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(tauriApi.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    const utils = await searchAndRender([group({ suggested_dest: "Rap & Hip-Hop" })]);
    const baixar = Array.from(utils.container.querySelectorAll(".crate-row button")).find((b) =>
      (b.textContent ?? "").includes("Baixar"),
    )!;
    fireEvent.click(baixar);
    await waitFor(() => expect(emit).not.toBeNull());
    await waitFor(() => expect(tauriApi.slskDownload).toHaveBeenCalled());
    emit!([dlJob("job1", { kind: "failed", reason: "peer recusou", retryable: true }, extra)]);
    await waitFor(() => {
      expect(utils.container.querySelector(".crate-row")!.getAttribute("data-state")).toBe("failed");
    });
    return utils;
  }

  const trocarFonte = (scope: Element) =>
    Array.from(scope.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("Trocar fonte"));

  it("'Trocar fonte' some quando não há fonte não tentada (na busca e na Fila)", async () => {
    const { container, getByText } = await searchWithFailedJob({
      alternates: [candidate({ id: "cand2", username: "peer_b" })],
      tried_source_ids: ["cand2"],
    });
    expect(trocarFonte(container.querySelector(".crate-row")!)).toBeUndefined();
    fireEvent.click(getByText(/^Fila/));
    await waitFor(() => expect(container.querySelector(".crate-job")).toBeTruthy());
    expect(trocarFonte(container.querySelector(".crate-job")!)).toBeUndefined();
  });

  it("'Trocar fonte' com fonte disponível chama o backend e mostra o erro se ele recusar", async () => {
    vi.mocked(tauriApi.slskTryOtherSource).mockRejectedValueOnce(
      "job em estado que nao aceita troca de fonte agora",
    );
    const { container } = await searchWithFailedJob({
      alternates: [candidate({ id: "cand2", username: "peer_b" })],
      tried_source_ids: [],
    });
    const btn = trocarFonte(container.querySelector(".crate-row")!)!;
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(alertText(container)).toContain("Não deu pra trocar a fonte"));
    expect(tauriApi.slskTryOtherSource).toHaveBeenCalledWith("job1");
  });
});

describe("Crate — fontes com download já existente (crate-16)", () => {
  const cand1 = () => candidate({ id: "cand1", username: "peer_a", filename: "A\\01 - Sicko Mode.flac" });
  const cand2 = () => candidate({ id: "cand2", username: "peer_b", filename: "B\\01 - Sicko Mode.flac" });
  const cand3 = () => candidate({ id: "cand3", username: "peer_c", filename: "C\\01 - Sicko Mode.flac" });

  async function withJob(state: DownloadJob["state"], extra: Partial<DownloadJob>) {
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(tauriApi.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    const utils = await searchAndRender([
      group({ suggested_dest: "Rap & Hip-Hop", best: cand1(), alternates: [cand2(), cand3()] }),
    ]);
    const baixar = Array.from(utils.container.querySelectorAll(".crate-row button")).find((b) =>
      (b.textContent ?? "").includes("Baixar"),
    )!;
    fireEvent.click(baixar);
    await waitFor(() => expect(tauriApi.slskDownload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(emit).not.toBeNull());
    emit!([dlJob("job1", state, extra)]);
    await waitFor(() => {
      expect(utils.container.querySelector(".crate-row")!.getAttribute("data-state")).toBe(state.kind);
    });
    fireEvent.click(utils.container.querySelector(".crate-row__sources")!);
    const srcRow = (peer: string) =>
      Array.from(utils.container.querySelectorAll(".crate-src")).find(
        (r) => r.querySelector(".nm")?.textContent === peer,
      )!;
    return { ...utils, srcRow };
  }

  it("com download em andamento, 'Usar' fica desabilitado e as fontes em uso e já tentadas aparecem marcadas", async () => {
    // Trocou de fonte duas vezes: peer_b já tentado, peer_c servindo agora.
    const { container, srcRow } = await withJob(
      { kind: "downloading", pct: 30, bps: 1_000_000, eta_s: 20 },
      {
        username: "peer_c",
        remote_filename: "C\\01 - Sicko Mode.flac",
        alternates: [cand2(), cand3()],
        tried_source_ids: ["cand2", "cand3"],
      },
    );
    const uses = Array.from(container.querySelectorAll(".crate-src .crate-btn")) as HTMLButtonElement[];
    expect(uses.length).toBe(3);
    expect(uses.every((b) => b.disabled)).toBe(true);
    uses.forEach((b) => fireEvent.click(b));
    expect(tauriApi.slskDownload).toHaveBeenCalledTimes(1);

    expect(srcRow("peer_c").textContent).toContain("em uso");
    expect(srcRow("peer_b").textContent).toContain("tentada");
    expect(srcRow("peer_b").textContent).not.toContain("em uso");
  });

  it("com o download terminado em falha, 'Usar' volta a funcionar e a fonte que falhou fica marcada", async () => {
    const { srcRow } = await withJob(
      { kind: "failed", reason: "peer recusou", retryable: true },
      { username: "peer_a", remote_filename: "A\\01 - Sicko Mode.flac", alternates: [cand2(), cand3()] },
    );
    expect(srcRow("peer_a").textContent).toContain("tentada");
    const use = srcRow("peer_b").querySelector(".crate-btn") as HTMLButtonElement;
    expect(use.disabled).toBe(false);
    fireEvent.click(use);
    await waitFor(() => expect(tauriApi.slskDownload).toHaveBeenCalledTimes(2));
    expect(tauriApi.slskDownload).toHaveBeenLastCalledWith("srch1", group().group_key, "cand2", "Rap & Hip-Hop");
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
        quality_label: "FLAC 16/44",
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
        quality_label: "FLAC 16/44",
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

describe("Crate — destino escolhido na linha", () => {
  it("vence o destino da toolbar: o chip mostra a escolha e o download vai para ela", async () => {
    // Handoff v1.1: o chip da linha "herda o destino global até ser trocado
    // na própria linha". Antes a toolbar vencia em silêncio, com o chip
    // pintado de override mas mostrando a pasta da toolbar (crate-3).
    vi.mocked(tauriApi.libListFolders).mockResolvedValue([
      { name: "Rap & Hip-Hop", track_count: 10, cover_path: null, cover_paths: [] },
      { name: "Rock", track_count: 5, cover_path: null, cover_paths: [] },
    ]);
    const g = group({ group_key: "k1" });
    const { container } = await searchAndRender([g]);
    const pick = (scope: Element, name: string) => {
      fireEvent.click(scope.querySelector(".crate-dest__btn")!);
      const opt = Array.from(scope.querySelectorAll(".crate-dest__opt")).find((b) =>
        (b.textContent ?? "").includes(name),
      ) as HTMLButtonElement;
      fireEvent.click(opt);
    };
    await waitFor(() => expect(tauriApi.libListFolders).toHaveBeenCalled());
    pick(container.querySelector(".crate-toolbar")!, "Rap & Hip-Hop");
    const row = container.querySelector(".crate-row")!;
    pick(row, "Rock");

    const chip = row.querySelector(".crate-dest__btn")!;
    expect(chip.textContent).toContain("Rock");
    expect(chip.getAttribute("data-override")).toBe("true");
    const baixar = Array.from(row.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Baixar"),
    )!;
    fireEvent.click(baixar);
    await waitFor(() => {
      expect(tauriApi.slskDownload).toHaveBeenCalledWith("srch1", "k1", g.best.id, "Rock");
    });
  });
});

describe("Crate — seletor de destino se comporta como popover", () => {
  const FOLDERS = [
    { name: "Rap & Hip-Hop", track_count: 10, cover_path: null, cover_paths: [] },
    { name: "Rock", track_count: 5, cover_path: null, cover_paths: [] },
  ];

  async function openRowMenu() {
    vi.mocked(tauriApi.libListFolders).mockResolvedValue(FOLDERS);
    const utils = await searchAndRender([group({ suggested_dest: "Rock" })]);
    const chip = utils.container.querySelector(".crate-row .crate-dest__btn") as HTMLButtonElement;
    expect(chip.getAttribute("aria-haspopup")).toBe("true");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(chip);
    expect(utils.container.querySelector(".crate-row .crate-dest__menu")).toBeTruthy();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    return { ...utils, chip };
  }

  it("clique fora fecha; clique dentro do menu não fecha", async () => {
    const { container } = await openRowMenu();
    fireEvent.mouseDown(container.querySelector(".crate-dest__menu")!);
    expect(container.querySelector(".crate-dest__menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(container.querySelector(".crate-dest__menu")).toBeFalsy();
  });

  it("Esc fecha", async () => {
    const { container } = await openRowMenu();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(container.querySelector(".crate-dest__menu")).toBeFalsy();
  });

  it("um aberto por vez: abrir o da toolbar fecha o da linha", async () => {
    const { container } = await openRowMenu();
    const toolbarChip = container.querySelector(".crate-toolbar .crate-dest__btn") as HTMLButtonElement;
    fireEvent.mouseDown(toolbarChip);
    fireEvent.click(toolbarChip);
    const menus = container.querySelectorAll(".crate-dest__menu");
    expect(menus.length).toBe(1);
    expect(container.querySelector(".crate-toolbar .crate-dest__menu")).toBeTruthy();
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clearInterval é chamado no onCleanup", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(() => <Crate />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  async function searchWithFakeTimers(results: () => SearchSnapshot) {
    vi.useFakeTimers();
    vi.mocked(tauriApi.slskResults).mockImplementation(async () => results());
    const utils = render(() => <Crate />);
    const input = utils.container.querySelector(".coll-search input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "sicko mode" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.advanceTimersByTimeAsync(0);
    return utils;
  }

  it("para de pollar slskResults quando a busca sai de running", async () => {
    const { container } = await searchWithFakeTimers(() => snapshot([group()], "done"));
    expect(container.querySelectorAll(".crate-row").length).toBe(1);
    const calls = vi.mocked(tauriApi.slskResults).mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(vi.mocked(tauriApi.slskResults).mock.calls.length).toBe(calls);
  });

  it("enquanto running, snapshot novo a cada poll não recria a linha nem fecha o seletor de destino", async () => {
    const { container } = await searchWithFakeTimers(() =>
      snapshot([group({ suggested_dest: null })], "running"),
    );
    const wrap = container.querySelector(".crate-row-wrap")!;
    fireEvent.click(wrap.querySelector(".crate-row .crate-dest__btn")!);
    expect(wrap.querySelector(".crate-dest__menu")).toBeTruthy();

    const calls = vi.mocked(tauriApi.slskResults).mock.calls.length;
    await vi.advanceTimersByTimeAsync(2500);
    expect(vi.mocked(tauriApi.slskResults).mock.calls.length).toBeGreaterThan(calls);
    expect(container.querySelector(".crate-row-wrap")).toBe(wrap);
    expect(wrap.querySelector(".crate-dest__menu")).toBeTruthy();
  });

  it("painel de fontes mantém a ordem de chegada dos peers enquanto o ranking muda: o 'Usar' sob o cursor não troca de peer", async () => {
    let tick = 0;
    const a = () => candidate({ id: "cand_a", username: "peer_a" });
    const b = () => candidate({ id: "cand_b", username: "peer_b" });
    const c = () => candidate({ id: "cand_c", username: "peer_c" });
    const { container } = await searchWithFakeTimers(() => {
      // 1º poll: a > b. Depois: c entra no topo e b passa à frente de a.
      const g = tick++ === 0
        ? group({ suggested_dest: "Rap & Hip-Hop", best: a(), alternates: [b()] })
        : group({ suggested_dest: "Rap & Hip-Hop", best: c(), alternates: [b(), a()] });
      return snapshot([g], "running");
    });
    fireEvent.click(container.querySelector(".crate-row__sources")!);
    const peers = () => Array.from(container.querySelectorAll(".crate-src .nm")).map((n) => n.textContent);
    expect(peers()).toEqual(["peer_a", "peer_b"]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(peers()).toEqual(["peer_a", "peer_b", "peer_c"]);

    const firstUse = container.querySelector(".crate-src .crate-btn") as HTMLButtonElement;
    fireEvent.click(firstUse);
    await vi.advanceTimersByTimeAsync(0);
    expect(tauriApi.slskDownload).toHaveBeenCalledWith("srch1", group().group_key, "cand_a", "Rap & Hip-Hop");
  });

  it("slskStatus é consultado a cada 5 s, não a cada ciclo de poll", async () => {
    vi.useFakeTimers();
    render(() => <Crate />);
    await vi.advanceTimersByTimeAsync(0);
    expect(tauriApi.slskStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4500);
    expect(tauriApi.slskStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(tauriApi.slskStatus).toHaveBeenCalledTimes(2);
  });
});

describe("Crate — aba Fila", () => {
  it("evento slsk-jobs com objetos novos atualiza a linha sem recriá-la", async () => {
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(tauriApi.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    const { container, getByText } = render(() => <Crate />);
    await waitFor(() => expect(emit).not.toBeNull());
    emit!([dlJob("j1", { kind: "downloading", pct: 10, bps: 1_000_000, eta_s: null })]);
    fireEvent.click(getByText(/^Fila/));
    const row = await waitFor(() => {
      const el = container.querySelector(".crate-job");
      expect(el).toBeTruthy();
      return el!;
    });

    emit!([dlJob("j1", { kind: "downloading", pct: 60, bps: 1_000_000, eta_s: null })]);
    expect(container.querySelector(".crate-job")).toBe(row);
    expect(row.textContent).toContain("60%");
  });
});

describe("Crate — teclado escopado à lista (crate-2, crate-4)", () => {
  let external: HTMLElement | null = null;

  afterEach(() => {
    external?.remove();
    external = null;
    vi.useRealTimers();
  });

  const list = (c: HTMLElement) => c.querySelector(".crate-list") as HTMLElement;

  async function searchWithJob(state: DownloadJob["state"]) {
    let emit: ((jobs: DownloadJob[]) => void) | null = null;
    vi.mocked(tauriApi.onSlskJobs).mockImplementation(async (cb) => {
      emit = cb;
      return () => {};
    });
    const utils = await searchAndRender([group({ suggested_dest: "Rap & Hip-Hop" })]);
    const baixar = Array.from(utils.container.querySelectorAll(".crate-row button")).find((b) =>
      (b.textContent ?? "").includes("Baixar"),
    )!;
    fireEvent.click(baixar);
    await waitFor(() => expect(tauriApi.slskDownload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(emit).not.toBeNull());
    emit!([dlJob("job1", state)]);
    await waitFor(() => {
      expect(utils.container.querySelector(".crate-row")!.getAttribute("data-state")).toBe(state.kind);
    });
    return utils;
  }

  it("Backspace e Enter com foco fora da lista (ex.: input da ⌘K) não cancelam nem baixam", async () => {
    await searchWithJob({ kind: "downloading", pct: 10, bps: 1_000_000, eta_s: null });
    external = document.createElement("input");
    document.body.appendChild(external);
    external.focus();
    fireEvent.keyDown(external, { key: "Backspace" });
    fireEvent.keyDown(external, { key: "Enter" });
    fireEvent.keyDown(document.body, { key: "Backspace" });
    expect(tauriApi.slskCancel).not.toHaveBeenCalled();
    expect(tauriApi.slskDownload).toHaveBeenCalledTimes(1);
  });

  it("tecla vinda de um botão dentro da lista não aciona a linha selecionada", async () => {
    const { container } = await searchAndRender([group({ suggested_dest: "Rap & Hip-Hop" })]);
    const sourcesBtn = container.querySelector(".crate-row__sources") as HTMLElement;
    fireEvent.keyDown(sourcesBtn, { key: "Enter" });
    expect(tauriApi.slskDownload).not.toHaveBeenCalled();
  });

  it("com foco na lista: ↓ seleciona a próxima linha e Enter baixa a selecionada", async () => {
    const g1 = group({ group_key: "k1", suggested_dest: "Rap & Hip-Hop" });
    const g2 = group({ group_key: "k2", display_title: "R.I.P. Screw", suggested_dest: "Rap & Hip-Hop" });
    const { container } = await searchAndRender([g1, g2]);
    const l = list(container);
    l.focus();
    expect(document.activeElement).toBe(l);
    fireEvent.keyDown(l, { key: "ArrowDown" });
    const wraps = container.querySelectorAll(".crate-row-wrap");
    expect(wraps[1].getAttribute("data-focus")).toBe("true");
    fireEvent.keyDown(l, { key: "Enter" });
    await waitFor(() => {
      expect(tauriApi.slskDownload).toHaveBeenCalledWith("srch1", "k2", g2.best.id, "Rap & Hip-Hop");
    });
  });

  it("Backspace não cancela job travado (stalled), que não oferece Cancelar", async () => {
    const { container } = await searchWithJob({ kind: "stalled", since_secs: 130 });
    fireEvent.keyDown(list(container), { key: "Backspace" });
    expect(tauriApi.slskCancel).not.toHaveBeenCalled();
  });

  it("Backspace com foco na lista cancela o download em andamento da linha selecionada", async () => {
    const { container } = await searchWithJob({ kind: "downloading", pct: 10, bps: 1_000_000, eta_s: null });
    fireEvent.keyDown(list(container), { key: "Backspace" });
    await waitFor(() => expect(tauriApi.slskCancel).toHaveBeenCalledWith("job1"));
  });

  it("↓ no campo de busca leva o foco para a lista, e a seleção rola para a vista", async () => {
    const scroll = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const { container } = await searchAndRender([group({ group_key: "k1" }), group({ group_key: "k2" })]);
      const input = container.querySelector(".coll-search input") as HTMLInputElement;
      input.focus();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(document.activeElement).toBe(list(container));
      fireEvent.keyDown(list(container), { key: "ArrowDown" });
      const wraps = container.querySelectorAll(".crate-row-wrap");
      expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
      expect(scroll.mock.contexts.at(-1)).toBe(wraps[1]);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("Enter numa linha sem destino abre o seletor, igual ao clique em Baixar", async () => {
    const { container } = await searchAndRender([group({ suggested_dest: null })]);
    fireEvent.keyDown(list(container), { key: "Enter" });
    expect(container.querySelector(".crate-row .crate-dest__menu")).toBeTruthy();
    expect(tauriApi.slskDownload).not.toHaveBeenCalled();
  });

  it("a seleção segue a faixa (não a posição) quando a ordem muda durante a busca", async () => {
    vi.useFakeTimers();
    let tick = 0;
    const g1 = () => group({ group_key: "k1", display_title: "Sicko Mode" });
    const g2 = () => group({ group_key: "k2", display_title: "R.I.P. Screw" });
    const g3 = () => group({ group_key: "k3", display_title: "Butterfly Effect" });
    vi.mocked(tauriApi.slskResults).mockImplementation(async () =>
      snapshot(tick++ === 0 ? [g1(), g2()] : [g3(), g1(), g2()], "running"),
    );
    const { container } = render(() => <Crate />);
    const input = container.querySelector(".coll-search input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "travis" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.keyDown(list(container), { key: "ArrowDown" });
    const selectedTitle = () =>
      container.querySelector('.crate-row-wrap[data-focus="true"] .crate-r-title')?.textContent;
    expect(selectedTitle()).toBe("R.I.P. Screw");
    await vi.advanceTimersByTimeAsync(1000);
    expect(container.querySelectorAll(".crate-row").length).toBe(3);
    expect(selectedTitle()).toBe("R.I.P. Screw");
  });
});

describe("Crate — rota /crate/<busca> reativa (crate-v1)", () => {
  afterEach(async () => {
    window.location.hash = "";
    await new Promise((r) => setTimeout(r, 0));
  });

  it("⌘K 'Procurar na rede' com o Crate aberto refaz a busca com o termo novo, e re-navegar para o mesmo termo também", async () => {
    window.location.hash = "#/crate/sicko%20mode";
    await new Promise((r) => setTimeout(r, 0));
    const { container } = render(() => <Crate param="sicko%20mode" />);
    await waitFor(() => expect(tauriApi.slskSearch).toHaveBeenCalledWith("sicko mode", false));

    navigate("/crate/travis%20scott");
    await waitFor(() => expect(tauriApi.slskSearch).toHaveBeenCalledWith("travis scott", false));
    const input = container.querySelector(".coll-search input") as HTMLInputElement;
    expect(input.value).toBe("travis scott");

    vi.mocked(tauriApi.slskSearch).mockClear();
    navigate("/crate/travis%20scott");
    await waitFor(() => expect(tauriApi.slskSearch).toHaveBeenCalledWith("travis scott", false));
  });
});
