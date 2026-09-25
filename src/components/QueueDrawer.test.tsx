/* ============================================================
   QueueDrawer.test.tsx — gaveta da fila (auditoria de UI 25/09).

   - O atalho Q ignorava só input e textarea e não olhava
     modificadores: com foco num <select>, a busca por letra abria a
     fila, e Ctrl+Q também alternava (shell-13, nowplaying-v4).
   ============================================================ */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

vi.mock("./PlayerBar", () => ({ playTrack: vi.fn(), playQueueUpcoming: vi.fn() }));

import { QueueDrawer } from "./QueueDrawer";

afterEach(() => {
  cleanup();
  document.body.querySelectorAll("[data-test-field]").forEach((el) => el.remove());
});

function pressOn(el: EventTarget, key: string, init: KeyboardEventInit = {}) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

function isOpen(container: HTMLElement): boolean {
  return container.querySelector(".queue-drawer")!.getAttribute("data-open") === "true";
}

describe("atalho Q da fila", () => {
  it("Q fora de campo alterna a gaveta", () => {
    const { container } = render(() => <QueueDrawer />);
    pressOn(document.body, "q");
    expect(isOpen(container)).toBe(true);
    pressOn(document.body, "q");
    expect(isOpen(container)).toBe(false);
  });

  it("Q com foco num <select> não abre a fila", () => {
    const { container } = render(() => <QueueDrawer />);
    const sel = document.createElement("select");
    sel.setAttribute("data-test-field", "");
    document.body.appendChild(sel);
    pressOn(sel, "q");
    expect(isOpen(container)).toBe(false);
  });

  it("Ctrl+Q, Alt+Q e Meta+Q não alternam a fila", () => {
    const { container } = render(() => <QueueDrawer />);
    pressOn(document.body, "q", { ctrlKey: true });
    pressOn(document.body, "q", { altKey: true });
    pressOn(document.body, "q", { metaKey: true });
    expect(isOpen(container)).toBe(false);
  });
});
