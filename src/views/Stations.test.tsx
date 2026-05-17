/* ============================================================
   Stations.test.tsx — Smoke tests da nova view de stations.
   Cobre: feature card (.st-feature) com eyebrow, titulo grande,
   chips de seeds, CTA preto; canvas <StationViz />; grid de 6
   st-cards com card #1 carregando badge .st-card__live.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

beforeEach(() => {
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

describe("Stations view", () => {
  it("renderiza heading + stats", () => {
    const { getByText, container } = render(() => <Stations />);
    expect(getByText("Stations")).toBeTruthy();
    expect(container.querySelector(".view__stats")).toBeTruthy();
  });

  it("renderiza feature card com eyebrow, titulo grande, seeds chips, CTA preto", () => {
    const { container, getByText } = render(() => <Stations />);
    const feature = container.querySelector(".st-feature");
    expect(feature).toBeTruthy();
    expect(feature!.querySelector(".st-feature__eyebrow")).toBeTruthy();
    expect(feature!.querySelector(".st-feature__title")).toBeTruthy();
    const seeds = feature!.querySelectorAll(".st-seed-chip");
    expect(seeds.length).toBeGreaterThanOrEqual(3);
    expect(feature!.querySelector(".st-feature__cta")).toBeTruthy();
    expect(getByText("Resume station")).toBeTruthy();
  });

  it("feature card contem canvas (StationViz wrapper visual)", () => {
    const { container } = render(() => <Stations />);
    // O wrapper .st-feature__visual existe e contem canvas
    const visual = container.querySelector(".st-feature__visual");
    expect(visual).toBeTruthy();
    expect(visual!.querySelector("canvas")).toBeTruthy();
  });

  it("renderiza grid com 6 st-cards", () => {
    const { container } = render(() => <Stations />);
    const grid = container.querySelector(".st-grid");
    expect(grid).toBeTruthy();
    const cards = grid!.querySelectorAll(".st-card");
    expect(cards.length).toBe(6);
  });

  it("primeiro card tem badge Live verde no canto", () => {
    const { container } = render(() => <Stations />);
    const cards = container.querySelectorAll(".st-card");
    const liveBadge = cards[0].querySelector(".st-card__live");
    expect(liveBadge).toBeTruthy();
    expect(liveBadge!.textContent).toContain("Live");
  });

  it("cards subsequentes nao tem badge Live", () => {
    const { container } = render(() => <Stations />);
    const cards = container.querySelectorAll(".st-card");
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i].querySelector(".st-card__live")).toBeFalsy();
    }
  });
});
