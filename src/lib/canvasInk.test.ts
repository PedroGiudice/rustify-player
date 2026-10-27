import { describe, it, expect, vi } from "vitest";
import { readCanvasInk, watchCanvasInk } from "./canvasInk";

describe("readCanvasInk", () => {
  it("devolve cor que o canvas entende, ou o fallback quando o token não resolve", () => {
    const ink = readCanvasInk(document.body, {
      a: { token: "--nao-existe", fallback: "#123456" },
    });
    // jsdom não resolve var(): cai no fallback (nunca devolve "var(...)").
    expect(ink.a).not.toContain("var(");
    expect(ink.a.length).toBeGreaterThan(0);
  });

  it("não deixa a sonda no DOM", () => {
    const before = document.body.childElementCount;
    readCanvasInk(document.body, { a: { token: "--fg-1", fallback: "#171717" } });
    expect(document.body.childElementCount).toBe(before);
  });
});

describe("watchCanvasInk", () => {
  it("avisa no tema aplicado e na var inline do <html>; para depois do cleanup", async () => {
    const cb = vi.fn();
    const stop = watchCanvasInk(cb);
    window.dispatchEvent(new CustomEvent("rustify:theme-applied"));
    expect(cb).toHaveBeenCalledTimes(1);
    document.documentElement.style.setProperty("--primary", "#ff0000");
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(new CustomEvent("rustify:theme-applied"));
    document.documentElement.style.setProperty("--primary", "#00ff00");
    await new Promise((r) => setTimeout(r, 0));
    expect(cb).toHaveBeenCalledTimes(2);
    document.documentElement.style.removeProperty("--primary");
  });
});
