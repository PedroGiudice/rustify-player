/* ============================================================
   keyboard.test.ts — filtro de digitação dos atalhos globais
   (auditoria de UI 25/09: shell-13, cfg-10, nowplaying-v4).

   Os atalhos de uma letra (N, H, L, Q) ignoravam só input e
   textarea. Com foco num <select> (fonte do Tweaks, tema do
   Settings), a busca por letra do próprio select trocava de tela.
   ============================================================ */

import { describe, it, expect, afterEach } from "vitest";
import { isTypingContext } from "./keyboard";

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
