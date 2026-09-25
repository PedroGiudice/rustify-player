/* ============================================================
   keyboard.test.ts — filtro de digitação dos atalhos globais
   (auditoria de UI 25/09: shell-13, cfg-10, nowplaying-v4).

   Os atalhos de uma letra (N, H, L, Q) ignoravam só input e
   textarea. Com foco num <select> (fonte do Tweaks, tema do
   Settings), a busca por letra do próprio select trocava de tela.
   ============================================================ */

import { describe, it, expect, afterEach } from "vitest";
import { isMacPlatform, modCombo, isTypingContext } from "./keyboard";

afterEach(() => {
  document.body.innerHTML = "";
});

function keyOn(el: Element, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: "n", bubbles: true, ...init });
  Object.defineProperty(ev, "target", { value: el });
  return ev;
}

describe("isTypingContext", () => {
  it("input, textarea e select são contexto de digitação", () => {
    for (const tag of ["input", "textarea", "select"]) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      expect(isTypingContext(keyOn(el))).toBe(true);
    }
  });

  it("elemento editável (contenteditable, inclusive filho) é contexto de digitação", () => {
    const host = document.createElement("div");
    host.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    host.appendChild(child);
    document.body.appendChild(host);
    expect(isTypingContext(keyOn(host))).toBe(true);
    expect(isTypingContext(keyOn(child))).toBe(true);
  });

  it("contenteditable=false não conta", () => {
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "false");
    document.body.appendChild(el);
    expect(isTypingContext(keyOn(el))).toBe(false);
  });

  it("composição de IME em andamento conta, mesmo fora de campo", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    expect(isTypingContext(keyOn(el, { isComposing: true }))).toBe(true);
  });

  it("botão, div comum e body não são contexto de digitação", () => {
    const btn = document.createElement("button");
    const div = document.createElement("div");
    document.body.append(btn, div);
    expect(isTypingContext(keyOn(btn))).toBe(false);
    expect(isTypingContext(keyOn(div))).toBe(false);
    expect(isTypingContext(keyOn(document.body))).toBe(false);
  });
});

// shell-13: as dicas diziam ⌘K e ⌘↵ em qualquer máquina, mas fora do Mac o
// atalho é Ctrl (os listeners aceitam metaKey || ctrlKey). O app roda no
// WebKitGTK (Linux): navigator.platform = "Linux x86_64".
describe("modCombo (dica de atalho por plataforma)", () => {
  it("no Mac usa ⌘ colado na tecla", () => {
    expect(modCombo("K", "MacIntel")).toBe("⌘K");
    expect(modCombo("↵", "MacIntel")).toBe("⌘↵");
  });

  it("fora do Mac usa Ctrl+", () => {
    expect(modCombo("K", "Linux x86_64")).toBe("Ctrl+K");
    expect(modCombo("↵", "Win32")).toBe("Ctrl+↵");
    expect(modCombo("K", "")).toBe("Ctrl+K");
  });

  it("isMacPlatform reconhece Mac, iPhone e iPad", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("iPad")).toBe(true);
    expect(isMacPlatform("iPhone")).toBe(true);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(isMacPlatform("Win32")).toBe(false);
  });

  it("sem argumento, lê a plataforma do navegador", () => {
    expect(modCombo("K")).toBe(isMacPlatform(navigator.platform) ? "⌘K" : "Ctrl+K");
  });
});
