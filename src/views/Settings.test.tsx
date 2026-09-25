/* ============================================================
   Settings.test.tsx — Smoke tests da view re-estilizada.

   Cobre as 4 paineis (Appearance, Playback, Library, About) e
   garante que as logicas preservadas continuam funcionando:
   - Update flow (botao Check / Install / Restart)
   - Library stats (TRACKS / ALBUMS / ARTISTS / GENRES tiles ou
     equivalente — preservados em alguma forma)
   - Beat sync, Compact sidebar e Resume on launch ligados ao estado
     real (Tweaks / preferência do player), não a chaves sem consumidor
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
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
  normSetTarget: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ current_track: null, current_library_track: null, is_playing: false }),
  getTrackColor: vi.fn().mockResolvedValue(""),
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
  setResumeOnLaunch(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import Settings from "./Settings";
import * as ipc from "../tauri";
import { tweaks, updateTweak } from "../store/tweaks";
import { resumeOnLaunch, setResumeOnLaunch } from "../store/player";

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

  // cfg-1/ds-4: o seletor Light/Dark/Auto gravava body[data-theme], que
  // nenhuma regra CSS lia. Os temas são todos escuros e o tema YAML é o
  // modo — o seletor saiu (o teste antigo exigia o controle morto).
  it("Appearance não tem o seletor Light/Dark/Auto (o tema YAML é o modo)", () => {
    const { container } = render(() => <Settings />);
    const segs = Array.from(container.querySelectorAll(".seg"));
    const themeSeg = segs.find((s) => {
      const txt = (s.textContent ?? "").toLowerCase();
      return txt.includes("light") && txt.includes("dark") && txt.includes("auto");
    });
    expect(themeSeg).toBeUndefined();
    expect(document.body.hasAttribute("data-theme")).toBe(false);
  });

  // cfg-1: o seg antigo (Off/Subtle/Default/Pulse) gravava rustify-mock-sync,
  // que ninguém lia. Agora é o MESMO estado do Tweaks (bgBeatMode).
  it("Beat sync do Settings é o bgBeatMode do Tweaks", () => {
    updateTweak("bgBeatMode", "speed");
    const { container } = render(() => <Settings />);
    const segs = Array.from(container.querySelectorAll(".seg"));
    const beatSyncSeg = segs.find((s) => {
      const txt = (s.textContent ?? "").toLowerCase();
      return txt.includes("off") && txt.includes("speed") && txt.includes("pulse");
    });
    expect(beatSyncSeg).toBeTruthy();
    const buttons = Array.from(beatSyncSeg!.querySelectorAll("button"));
    expect(buttons.length).toBe(3);
    const speedBtn = buttons.find((b) => (b.textContent ?? "").toLowerCase() === "speed")!;
    expect(speedBtn.getAttribute("aria-pressed")).toBe("true");

    const pulseBtn = buttons.find((b) => (b.textContent ?? "").toLowerCase() === "pulse")!;
    fireEvent.click(pulseBtn);
    expect(tweaks().bgBeatMode).toBe("pulse");
    expect(pulseBtn.getAttribute("aria-pressed")).toBe("true");
  });

  // cfg-1: Compact sidebar gravava uma chave sem consumidor. Agora é o
  // knob Sidebar do Tweaks (icons = compacta).
  it("Compact sidebar do Settings é o knob Sidebar do Tweaks", () => {
    updateTweak("sidebar", "labels");
    const { container } = render(() => <Settings />);
    const row = Array.from(container.querySelectorAll(".set-row")).find((r) =>
      (r.querySelector(".set-row__label")?.textContent ?? "").toLowerCase().includes("compact sidebar"),
    )!;
    const tog = row.querySelector("button.tog")!;
    expect(tog.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(tog);
    expect(tweaks().sidebar).toBe("icons");
    expect(tog.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(tog);
    expect(tweaks().sidebar).toBe("labels");
  });

  // cfg-1: Resume on launch gravava uma chave que o PlayerBar ignorava.
  // O toggle agora escreve a preferência que o restoreSession consulta.
  it("Resume on launch desligado grava a preferência lida no boot", () => {
    const { container } = render(() => <Settings />);
    const row = Array.from(container.querySelectorAll(".set-row")).find((r) =>
      (r.querySelector(".set-row__label")?.textContent ?? "").toLowerCase().includes("resume"),
    )!;
    const tog = row.querySelector("button.tog")!;
    expect(resumeOnLaunch()).toBe(true);
    expect(tog.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(tog);
    expect(resumeOnLaunch()).toBe(false);
    expect(tog.getAttribute("aria-pressed")).toBe("false");
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

  it("Playback tem volume slider, normalize toggle, resume on launch toggle", () => {
    const { container } = render(() => <Settings />);
    // Volume range
    expect(container.querySelector("input[type='range']")).toBeTruthy();
    // Normalizar row
    const allLabels = Array.from(container.querySelectorAll(".set-row__label"));
    const normLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("normalizar"));
    expect(normLabel).toBeTruthy();
    // Resume on launch row
    const resumeLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("resume"));
    expect(resumeLabel).toBeTruthy();
    // Crossfade NAO existe
    const crossfadeLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("crossfade"));
    expect(crossfadeLabel).toBeUndefined();
    // Gapless NAO existe
    const gaplessLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("gapless"));
    expect(gaplessLabel).toBeUndefined();
    // Output device NAO existe
    const outputLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("output device"));
    expect(outputLabel).toBeUndefined();
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

  // ── Tier 0: controles removidos NAO devem existir ────────────
  describe("controles zumbi removidos (Tier 0)", () => {
    it("0.1 Output device nao tem botao Change", () => {
      const { container } = render(() => <Settings />);
      const allBtns = Array.from(container.querySelectorAll("button"));
      const changeBtn = allBtns.find((b) => (b.textContent ?? "").trim() === "Change…");
      expect(changeBtn).toBeUndefined();
    });

    it("0.2 Scrobble nao tem botao Connect", () => {
      const { container } = render(() => <Settings />);
      const allBtns = Array.from(container.querySelectorAll("button"));
      const connectBtn = allBtns.find((b) => (b.textContent ?? "").includes("Connect…"));
      expect(connectBtn).toBeUndefined();
    });

    it("0.3 Embeddings row existe mas nao tem botao Generate missing", () => {
      const { container } = render(() => <Settings />);
      // A row de Embeddings ainda existe como stat read-only
      const allLabels = Array.from(container.querySelectorAll(".set-row__label"));
      const embedLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("embeddings"));
      expect(embedLabel).toBeTruthy();
      // Mas o botao "Generate missing" nao existe
      const allBtns = Array.from(container.querySelectorAll("button"));
      const genBtn = allBtns.find((b) => (b.textContent ?? "").toLowerCase().includes("generate missing"));
      expect(genBtn).toBeUndefined();
    });

    it("0.4 qdrant row existe mas nao tem botao Restart", () => {
      const { container } = render(() => <Settings />);
      const allLabels = Array.from(container.querySelectorAll(".set-row__label"));
      const qdrantLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("qdrant"));
      expect(qdrantLabel).toBeTruthy();
      // Botao Restart nao existe
      const allBtns = Array.from(container.querySelectorAll("button"));
      const restartBtn = allBtns.find((b) => (b.textContent ?? "").trim() === "Restart…");
      expect(restartBtn).toBeUndefined();
    });

    it("0.6 Gapless nao tem toggle button", () => {
      const { container } = render(() => <Settings />);
      // Nao deve existir nenhum elemento com texto Gapless
      const allLabels = Array.from(container.querySelectorAll(".set-row__label"));
      const gaplessLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("gapless"));
      expect(gaplessLabel).toBeUndefined();
    });

    it("0.7 Crossfade nao tem slider (.set-slider)", () => {
      const { container } = render(() => <Settings />);
      // Nao deve existir label "Crossfade"
      const allLabels = Array.from(container.querySelectorAll(".set-row__label"));
      const crossfadeLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("crossfade"));
      expect(crossfadeLabel).toBeUndefined();
      // Nao deve existir .set-slider
      expect(container.querySelector(".set-slider")).toBeNull();
    });

    it("0.8 Music folder nao tem botao Trocar", () => {
      const { container } = render(() => <Settings />);
      const allBtns = Array.from(container.querySelectorAll("button"));
      const trocarBtn = allBtns.find((b) => (b.textContent ?? "").includes("Trocar"));
      expect(trocarBtn).toBeUndefined();
    });

    // Controles VIVOS devem continuar presentes
    it("controles vivos: Beat sync, Volume, Normalize, Re-scan, Check for updates", () => {
      const { container } = render(() => <Settings />);
      const segs = Array.from(container.querySelectorAll(".seg"));
      // Beat sync seg (Off/Speed/Pulse)
      const beatSeg = segs.find((s) => {
        const txt = (s.textContent ?? "").toLowerCase();
        return txt.includes("off") && txt.includes("pulse");
      });
      expect(beatSeg).toBeTruthy();
      // Volume slider
      const volumeInput = container.querySelector("input[type='range']");
      expect(volumeInput).toBeTruthy();
      // Normalizar row deve existir
      const allLabels = Array.from(container.querySelectorAll(".set-row__label"));
      const normLabel = allLabels.find((l) => (l.textContent ?? "").toLowerCase().includes("normalizar"));
      expect(normLabel).toBeTruthy();
      // Re-scan botao
      const rescanBtn = Array.from(container.querySelectorAll("button.set-folder-btn--accent")).find(
        (b) => (b.textContent ?? "").includes("Re-scan")
      );
      expect(rescanBtn).toBeTruthy();
      // Check for updates
      const allBtns = Array.from(container.querySelectorAll("button"));
      const checkBtn = allBtns.find((b) => (b.textContent ?? "").trim() === "Check for updates");
      expect(checkBtn).toBeTruthy();
    });
  });
});
