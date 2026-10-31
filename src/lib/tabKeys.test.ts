import { describe, it, expect, vi } from "vitest";
import { nextTabKey, tabKeyHandler } from "./tabKeys";

const KEYS = ["tracks", "albums", "artists"] as const;

describe("nextTabKey — padrão de abas do WAI-ARIA (A36)", () => {
  it("setas andam uma aba e dão a volta nas pontas", () => {
    expect(nextTabKey(KEYS, "tracks", "ArrowRight")).toBe("albums");
    expect(nextTabKey(KEYS, "artists", "ArrowRight")).toBe("tracks");
    expect(nextTabKey(KEYS, "tracks", "ArrowLeft")).toBe("artists");
    expect(nextTabKey(KEYS, "albums", "ArrowLeft")).toBe("tracks");
  });

  it("Home e End vão para a primeira e a última", () => {
    expect(nextTabKey(KEYS, "albums", "Home")).toBe("tracks");
    expect(nextTabKey(KEYS, "albums", "End")).toBe("artists");
  });

  it("outra tecla não é das abas", () => {
    expect(nextTabKey(KEYS, "albums", "Enter")).toBeNull();
    expect(nextTabKey(KEYS, "albums", "ArrowDown")).toBeNull();
  });
});

describe("tabKeyHandler", () => {
  it("seleciona a aba nova, leva o foco para ela e segura a tecla", () => {
    const tab = document.createElement("button");
    tab.id = "t-albums";
    document.body.append(tab);
    const select = vi.fn();
    const onKey = tabKeyHandler(KEYS, () => "tracks", select, (k) => `t-${k}`);
    const e = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
    onKey(e);
    expect(select).toHaveBeenCalledWith("albums");
    expect(document.activeElement).toBe(tab);
    expect(e.defaultPrevented).toBe(true);
    tab.remove();
  });

  it("com modificador, deixa a tecla passar (atalhos do app)", () => {
    const select = vi.fn();
    const onKey = tabKeyHandler(KEYS, () => "tracks", select, (k) => `t-${k}`);
    onKey(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true }));
    expect(select).not.toHaveBeenCalled();
  });
});
