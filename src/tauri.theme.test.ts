/* ============================================================
   tauri.theme.test.ts — ciclo de vida do tema aplicado no <html>.

   - config-v1: trocar do tema A pro B deixava aplicadas as vars que
     A declarava e B não (mistura de temas).
   - Default: limpar o tema remove só as vars DELE, sem apagar o
     style inline inteiro (zoom, vars dos Tweaks e do adaptive ink).
   - config-v3/cfg-14: o hot-reload re-aplica só o tema ATIVO; um
     theme-changed atrasado do tema anterior (ou depois de voltar ao
     Default) não pode ressuscitá-lo.

   O módulo real é importado DEPOIS de trocar o stub de __TAURI__:
   ele desestrutura invoke/listen no top-level.
   ============================================================ */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

type Listener = (e: { payload: unknown }) => void;
const listeners: Record<string, Listener> = {};
const invoke = vi.fn();

let T: typeof import("./tauri");

beforeAll(async () => {
  (window as any).__TAURI__ = {
    core: { invoke, convertFileSrc: (p: string) => p },
    event: {
      listen: vi.fn(async (ev: string, cb: Listener) => {
        listeners[ev] = cb;
        return () => { delete listeners[ev]; };
      }),
    },
  };
  T = await import("./tauri");
});

const html = () => document.documentElement;

beforeEach(() => {
  invoke.mockReset();
  localStorage.clear();
  T.clearThemeVars();
  html().removeAttribute("style");
});

describe("applyTheme", () => {
  it("remove as vars do tema anterior que o novo não declara", () => {
    T.applyTheme({ "--glass-blur": "20px", "--fg-1": "#eeeeee" });
    T.applyTheme({ "--fg-1": "#dddddd" });
    expect(html().style.getPropertyValue("--glass-blur")).toBe("");
    expect(html().style.getPropertyValue("--fg-1")).toBe("#dddddd");
    expect(T.themeVar("--glass-blur")).toBeNull();
  });

  it("não mexe em inline que não veio do tema", () => {
    html().style.setProperty("--bg-ink-morph", "4000ms");
    T.applyTheme({ "--fg-1": "#eeeeee" });
    T.applyTheme({ "--fg-2": "#cccccc" });
    expect(html().style.getPropertyValue("--bg-ink-morph")).toBe("4000ms");
  });
});

describe("clearThemeVars (volta ao Default)", () => {
  it("remove as vars do tema ativo e preserva o resto do style inline", () => {
    html().style.setProperty("--bg-ink-morph", "4000ms");
    T.applyTheme({ "--fg-1": "#eeeeee", "--tone-mint-bg": "#1d2523" });
    T.clearThemeVars();
    expect(html().style.getPropertyValue("--fg-1")).toBe("");
    expect(html().style.getPropertyValue("--tone-mint-bg")).toBe("");
    expect(html().style.getPropertyValue("--bg-ink-morph")).toBe("4000ms");
    expect(T.themeVar("--fg-1")).toBeNull();
  });
});

describe("wireThemeHotReload", () => {
  it("re-aplica quando o arquivo alterado é o tema ativo", async () => {
    await T.wireThemeHotReload();
    localStorage.setItem("rustify-theme", "a.yaml");
    invoke.mockResolvedValue({ vars: { "--fg-1": "#123456" }, contrast: [] });
    listeners["theme-changed"]({ payload: "a.yaml" });
    await vi.waitFor(() => expect(html().style.getPropertyValue("--fg-1")).toBe("#123456"));
    expect(invoke).toHaveBeenCalledWith("load_theme", { filename: "a.yaml" });
  });

  it("ignora theme-changed de um tema que não é mais o ativo", async () => {
    await T.wireThemeHotReload();
    // Default escolhido: não há tema ativo.
    listeners["theme-changed"]({ payload: "a.yaml" });
    localStorage.setItem("rustify-theme", "b.yaml");
    listeners["theme-changed"]({ payload: "a.yaml" });
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem("rustify-theme")).toBe("b.yaml");
  });
});

describe("unwatchTheme", () => {
  it("chama o comando que derruba o watcher do backend", async () => {
    invoke.mockResolvedValue(undefined);
    await T.unwatchTheme();
    expect(invoke).toHaveBeenCalledWith("unwatch_theme");
  });
});
