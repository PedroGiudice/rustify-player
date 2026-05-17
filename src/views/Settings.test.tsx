/* ============================================================
   Settings.test.tsx — Smoke tests da view re-estilizada.

   Cobre as 4 paineis (Appearance, Playback, Library, About) e
   garante que as logicas preservadas continuam funcionando:
   - Update flow (botao Check / Install / Restart)
   - Library stats (TRACKS / ALBUMS / ARTISTS / GENRES tiles ou
     equivalente — preservados em alguma forma)
   - Beat sync segmented persiste em localStorage rustify-mock-sync
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../tauri", () => ({
  libSnapshot: vi.fn().mockResolvedValue({
    tracks_total: 100, albums_total: 10, artists_total: 5,
    embeddings_done: 80, embeddings_pending: 20, embeddings_failed: 0,
  }),
  libGetAlbums: vi.fn().mockResolvedValue([]),
  libGetArtists: vi.fn().mockResolvedValue([]),
  libListGenres: vi.fn().mockResolvedValue([{ track_count: 5 }, { track_count: 0 }]),
  libRescan: vi.fn().mockResolvedValue(undefined),
  setVolume: vi.fn().mockResolvedValue(undefined),
  normGetState: vi.fn().mockResolvedValue(false),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  listThemes: vi.fn().mockResolvedValue([]),
  applyThemeByName: vi.fn().mockResolvedValue([]),
  watchTheme: vi.fn().mockResolvedValue(undefined),
  // onThemeChanged retorna Promise<UnlistenFn>; mock com no-op
  onThemeChanged: vi.fn().mockResolvedValue(() => {}),
  checkForUpdate: vi.fn().mockResolvedValue({ update_available: false, current_version: "0.1.0" }),
  installUpdate: vi.fn().mockResolvedValue(undefined),
  restartApp: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  // Mock Tauri global pra getVersion
  (window as any).__TAURI__ = {
    ...((window as any).__TAURI__ ?? {}),
    app: { getVersion: vi.fn().mockResolvedValue("0.1.0") },
  };
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import Settings from "./Settings";
import * as ipc from "../tauri";

describe("Settings view", () => {
  it("renderiza heading", () => {
    const { getByText } = render(() => <Settings />);
    expect(getByText("Settings")).toBeTruthy();
  });

  it("renderiza 4 paineis principais (Appearance, Playback, Library, About)", () => {
    const { container } = render(() => <Settings />);
    const panels = container.querySelectorAll(".set-panel");
    expect(panels.length).toBe(4);
    const titles = Array.from(container.querySelectorAll(".set-panel__title"))
      .map((t) => (t.textContent ?? "").toLowerCase());
    expect(titles).toContain("appearance");
    expect(titles).toContain("playback");
    expect(titles).toContain("library");
    expect(titles).toContain("about");
  });

  it("Appearance tem segmented theme (Light/Dark/Auto)", () => {
    const { container } = render(() => <Settings />);
    const segs = container.querySelectorAll(".seg");
    // Pelo menos um seg deve conter Light/Dark/Auto
    const themeSeg = Array.from(segs).find((s) => {
      const txt = (s.textContent ?? "").toLowerCase();
      return txt.includes("light") && txt.includes("dark") && txt.includes("auto");
    });
    expect(themeSeg).toBeTruthy();
  });

  it("Appearance tem Beat sync segmented com 4 opcoes e persiste no localStorage", () => {
    const { container } = render(() => <Settings />);
    const segs = container.querySelectorAll(".seg");
    const beatSyncSeg = Array.from(segs).find((s) => {
      const txt = (s.textContent ?? "").toLowerCase();
      return txt.includes("off") && txt.includes("subtle") && txt.includes("pulse");
    });
    expect(beatSyncSeg).toBeTruthy();
    const buttons = beatSyncSeg!.querySelectorAll("button");
    expect(buttons.length).toBe(4);

    // Click Pulse
    const pulseBtn = Array.from(buttons).find((b) => (b.textContent ?? "").toLowerCase() === "pulse")!;
    fireEvent.click(pulseBtn);
    expect(localStorage.getItem("rustify-mock-sync")).toBe("pulse");
  });

  it("Library panel renderiza stats (tracks/albums/artists/genres) preservados", async () => {
    const { findByText } = render(() => <Settings />);
    // Espera dados do createResource carregarem
    expect(await findByText("100")).toBeTruthy(); // tracks_total
  });

  it("Library tem botao Re-scan acionavel", async () => {
    const { container } = render(() => <Settings />);
    // Botao tem classe set-folder-btn--accent e texto Re-scan
    const accentBtns = container.querySelectorAll("button.set-folder-btn--accent");
    const rescanBtn = Array.from(accentBtns).find((b) => (b.textContent ?? "").includes("Re-scan"));
    expect(rescanBtn).toBeTruthy();
    fireEvent.click(rescanBtn as HTMLElement);
    expect(ipc.libRescan).toHaveBeenCalled();
  });

  it("Playback tem crossfade slider, gapless toggle, output device", () => {
    const { container, getByText } = render(() => <Settings />);
    expect(getByText("Crossfade")).toBeTruthy();
    expect(getByText(/Gapless/i)).toBeTruthy();
    expect(getByText(/Output device/i)).toBeTruthy();
    // Slider visivel
    expect(container.querySelector(".set-slider")).toBeTruthy();
  });

  it("About renderiza grid com 6 items mono (Version, Tauri, Backend, Identifier, Branch, License)", () => {
    const { container } = render(() => <Settings />);
    const aboutGrid = container.querySelector(".set-about-grid");
    expect(aboutGrid).toBeTruthy();
    const items = aboutGrid!.querySelectorAll(".set-about-item");
    expect(items.length).toBe(6);
    const labels = Array.from(items).map((i) =>
      (i.querySelector(".set-about-item__label")?.textContent ?? "").toLowerCase()
    );
    expect(labels).toContain("version");
    expect(labels).toContain("tauri");
    expect(labels).toContain("backend");
    expect(labels).toContain("identifier");
    expect(labels).toContain("branch");
    expect(labels).toContain("license");
  });

  it("Update flow: botao Check for updates dispara checkForUpdate", async () => {
    const { container } = render(() => <Settings />);
    // Procura BUTTON cujo textContent == "Check for updates"
    const allBtns = Array.from(container.querySelectorAll("button"));
    const checkBtn = allBtns.find((b) => (b.textContent ?? "").trim() === "Check for updates");
    expect(checkBtn).toBeTruthy();
    fireEvent.click(checkBtn as HTMLElement);
    expect(ipc.checkForUpdate).toHaveBeenCalled();
  });

  // ── Testes da calculadora de contraste (Bug 2) ────────────────

  it("selecionar tema YAML chama applyThemeByName com o filename correto", async () => {
    // Simula listThemes retornando um tema
    vi.mocked(ipc.listThemes).mockResolvedValue([
      { filename: "theme-copper-default.yaml", name: "Copper (Default)", author: "Rustify" },
    ] as any);
    const { findByRole } = render(() => <Settings />);
    // Espera o select carregar
    const select = (await findByRole("combobox")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "theme-copper-default.yaml" } });
    expect(ipc.applyThemeByName).toHaveBeenCalledWith("theme-copper-default.yaml");
  });

  it("calculadora exibe pares de contraste quando applyThemeByName retorna checks", async () => {
    const mockChecks = [
      { pair: "texto/canvas",  ratio: 12.5, pass_aa: true,  pass_aaa: true  },
      { pair: "apagado/paper", ratio: 3.1,  pass_aa: false, pass_aaa: false },
    ];
    vi.mocked(ipc.applyThemeByName).mockResolvedValue(mockChecks as any);
    vi.mocked(ipc.listThemes).mockResolvedValue([
      { filename: "theme-test.yaml", name: "Test", author: "CI" },
    ] as any);

    const { findByRole, findByText } = render(() => <Settings />);
    const select = (await findByRole("combobox")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "theme-test.yaml" } });

    // Aguarda rendering dos pares de contraste
    expect(await findByText("texto/canvas")).toBeTruthy();
    expect(await findByText("apagado/paper")).toBeTruthy();
    // Verifica ratios exibidos
    expect(await findByText("12.50:1")).toBeTruthy();
    expect(await findByText("3.10:1")).toBeTruthy();
    // Badge AAA para o par que passa tudo
    expect(await findByText("AAA")).toBeTruthy();
  });

  it("calculadora exibe legenda WCAG abaixo da tabela", async () => {
    const mockChecks = [
      { pair: "texto/canvas", ratio: 5.0, pass_aa: true, pass_aaa: false },
    ];
    vi.mocked(ipc.applyThemeByName).mockResolvedValue(mockChecks as any);
    vi.mocked(ipc.listThemes).mockResolvedValue([
      { filename: "t.yaml", name: "T", author: "CI" },
    ] as any);

    const { findByRole, findByText } = render(() => <Settings />);
    const select = (await findByRole("combobox")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "t.yaml" } });

    expect(await findByText(/AA = 4\.5:1/)).toBeTruthy();
  });
});
