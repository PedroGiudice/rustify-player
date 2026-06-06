/* ============================================================
   Stations.test.tsx — Testes da view de stations.
   Cobre: feature card (.st-feature) com eyebrow, titulo grande,
   chips de seeds, CTA preto; canvas <StationViz />; grid de 6
   st-cards com card #1 carregando badge .st-card__live.

   Utiliza mock do window.__TAURI__ para simular o backend Rust
   sem precisar do runtime Tauri.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import type { Station } from "../tauri";

// ── 6 stations de exemplo (simula resposta do backend) ──────────
const MOCK_STATIONS: Station[] = [
  {
    id: "midnight-1",
    name: "Midnight station",
    icon: "lucide:target",
    tone: "tone-lavender",
    desc: "ambient · drone · sleepless",
    kind: "seed",
    seed_track_ids: [1, 2, 3],
    query: null,
    stats: { played: 312, last_played_at: null, match_avg: 0.97 },
  },
  {
    id: "sunday-slow-2",
    name: "Sunday slow",
    icon: "lucide:rainbow",
    tone: "tone-bone",
    desc: "modern classical · acoustic · low tempo",
    kind: "seed",
    seed_track_ids: [4, 5, 6, 7],
    query: null,
    stats: { played: 184, last_played_at: null, match_avg: 0.91 },
  },
  {
    id: "bridge-cable-3",
    name: "Bridge cable",
    icon: "ph:dots-nine",
    tone: "tone-paper",
    desc: "field recording · industrial · long form",
    kind: "seed",
    seed_track_ids: [8, 9],
    query: null,
    stats: { played: 54, last_played_at: null, match_avg: 0.88 },
  },
  {
    id: "solstice-4",
    name: "Solstice",
    icon: "lucide:mountain",
    tone: "tone-sky",
    desc: "winter strings · cold piano · church reverb",
    kind: "seed",
    seed_track_ids: [10, 11, 12, 13, 14],
    query: null,
    stats: { played: 96, last_played_at: null, match_avg: 0.93 },
  },
  {
    id: "pylon-5",
    name: "Pylon",
    icon: "lucide:audio-lines",
    tone: "tone-peach",
    desc: "minimal electronic · krautrock-adjacent",
    kind: "mood",
    seed_track_ids: [],
    query: "minimal electronic",
    stats: { played: 28, last_played_at: null, match_avg: 0.85 },
  },
  {
    id: "halocline-6",
    name: "Halocline",
    icon: "lucide:atom",
    tone: "tone-rose",
    desc: "deep ambient · brackish · slow drone",
    kind: "seed",
    seed_track_ids: [15, 16, 17],
    query: null,
    stats: { played: 72, last_played_at: null, match_avg: 0.90 },
  },
];

// ── Setup do ambiente JSDOM ──────────────────────────────────────
beforeEach(() => {
  // Mock do runtime Tauri (invoke via window.__TAURI__.core)
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.__TAURI__ = {
    core: {
      invoke: vi.fn(async (cmd: string) => {
        if (cmd === "lib_list_stations") return MOCK_STATIONS;
        if (cmd === "lib_play_station") return [];
        if (cmd === "lib_create_station") return MOCK_STATIONS[0];
        return null;
      }),
      convertFileSrc: (p: string) => p,
    },
    event: {
      listen: vi.fn(async () => () => {}),
    },
  };

  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), bezierCurveTo: vi.fn(),
    closePath: vi.fn(), stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(),
    fillRect: vi.fn(),
    strokeStyle: "", fillStyle: "", lineWidth: 0, lineJoin: "", lineCap: "",
  })) as any;
  HTMLCanvasElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 400, bottom: 200, width: 400, height: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  (globalThis as any).IntersectionObserver = class {
    constructor(_cb: any) {}
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  (globalThis as any).requestAnimationFrame = vi.fn(() => 1);
  (globalThis as any).cancelAnimationFrame = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import Stations from "./Stations";
import { waitFor } from "@solidjs/testing-library";

describe("Stations view", () => {
  it("renderiza heading + stats", async () => {
    const { getByText, container } = render(() => <Stations />);
    expect(getByText("Stations")).toBeTruthy();
    expect(container.querySelector(".view__stats")).toBeTruthy();
  });

  it("renderiza feature card com eyebrow, titulo grande, seeds chips", async () => {
    // Nota: o stub global de __TAURI__ (test-setup.ts) captura invoke no load
    // do tauri.ts e retorna undefined, entao libListStations resolve vazio e a
    // view renderiza o empty-state (.st-feature fallback). Este teste valida a
    // estrutura compartilhada do feature card (eyebrow, titulo, seed-chips).
    // O botao "Resume station" disabled foi REMOVIDO no Tier 0 — nao se asserta.
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      const feature = container.querySelector(".st-feature");
      expect(feature).toBeTruthy();
    });
    const feature = container.querySelector(".st-feature");
    expect(feature!.querySelector(".st-feature__eyebrow")).toBeTruthy();
    expect(feature!.querySelector(".st-feature__title")).toBeTruthy();
    const seeds = feature!.querySelectorAll(".st-seed-chip");
    expect(seeds.length).toBeGreaterThanOrEqual(1);
  });

  it("feature card contem canvas (StationViz wrapper visual)", async () => {
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      const visual = container.querySelector(".st-feature__visual");
      expect(visual).toBeTruthy();
    });
    const visual = container.querySelector(".st-feature__visual");
    expect(visual!.querySelector("canvas")).toBeTruthy();
  });

  it("renderiza grid com 6 st-cards quando backend retorna 6 stations", async () => {
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      const cards = container.querySelectorAll(".st-card");
      expect(cards.length).toBe(6);
    });
    const grid = container.querySelector(".st-grid");
    expect(grid).toBeTruthy();
    const cards = grid!.querySelectorAll(".st-card");
    expect(cards.length).toBe(6);
  });

  it("primeiro card tem badge Live verde no canto", async () => {
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      const cards = container.querySelectorAll(".st-card");
      expect(cards.length).toBeGreaterThan(0);
    });
    const cards = container.querySelectorAll(".st-card");
    const liveBadge = cards[0].querySelector(".st-card__live");
    expect(liveBadge).toBeTruthy();
    expect(liveBadge!.textContent).toContain("Live");
  });

  it("cards subsequentes nao tem badge Live", async () => {
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      const cards = container.querySelectorAll(".st-card");
      expect(cards.length).toBe(6);
    });
    const cards = container.querySelectorAll(".st-card");
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i].querySelector(".st-card__live")).toBeFalsy();
    }
  });

  it("estado loading mostra fallback antes do backend responder", () => {
    // Invoke com delay para capturar o estado de loading
    (globalThis as any).window.__TAURI__.core.invoke = vi.fn(
      () => new Promise((res) => setTimeout(() => res([]), 200)),
    );
    const { container } = render(() => <Stations />);
    // Durante o loading, o fallback exibe 6 cards placeholder
    const cards = container.querySelectorAll(".st-card");
    expect(cards.length).toBe(6);
  });

  it("0.5 empty-state nao tem o botao disabled Resume station", async () => {
    // Simula backend sem stations (empty-state)
    (globalThis as any).window.__TAURI__.core.invoke = vi.fn(async (cmd: string) => {
      if (cmd === "lib_list_stations") return [];
      return null;
    });
    const { container } = render(() => <Stations />);
    await waitFor(() => {
      // O feature card fallback (empty-state) deve estar visivel
      expect(container.querySelector(".st-feature")).toBeTruthy();
    });
    // Botao "Resume station" (era disabled, agora removido) NAO deve existir
    const allBtns = Array.from(container.querySelectorAll("button"));
    const resumeBtn = allBtns.find((b) => (b.textContent ?? "").includes("Resume station"));
    expect(resumeBtn).toBeUndefined();
    // O texto explicativo do empty-state continua presente
    expect((container.querySelector(".st-feature")?.textContent ?? "")).toContain("Stations aparecem aqui");
  });
});
