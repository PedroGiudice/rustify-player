import { afterEach, describe, expect, it } from "vitest";
import { calmBgKnobs, scrollBehavior, setReducedMotion } from "./motion";
import { CALM_SPEED } from "../gl/signal";

afterEach(() => setReducedMotion(false));

describe("calmBgKnobs (fundo 2D sob 'Remover animações', A53)", () => {
  it("sem a preferência, os knobs passam intactos", () => {
    expect(calmBgKnobs({ speed: 1, beatSync: 1 }, false)).toEqual({ speed: 1, beatSync: 1 });
  });

  it("com a preferência: relógio a CALM_SPEED e sem batida", () => {
    const k = calmBgKnobs({ speed: 1, beatSync: 1 }, true);
    expect(k.speed).toBeCloseTo(CALM_SPEED);
    expect(k.beatSync).toBe(0);
  });
});

describe("scrollBehavior", () => {
  it("suave por padrão, seco com a preferência", () => {
    expect(scrollBehavior()).toBe("smooth");
    setReducedMotion(true);
    expect(scrollBehavior()).toBe("auto");
  });
});
