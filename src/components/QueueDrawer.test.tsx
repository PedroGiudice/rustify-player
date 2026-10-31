/* ============================================================
   QueueDrawer.test.tsx — gaveta da fila (auditoria de UI 25/09).

   - O atalho Q ignorava só input e textarea e não olhava
     modificadores: com foco num <select>, a busca por letra abria a
     fila, e Ctrl+Q também alternava (shell-13, nowplaying-v4).
   - O evento de abrir aceita detail.open: a ação "Open queue" da
     palette pede abrir e não pode fechar a gaveta já aberta
     (shell-v4). Sem detail, segue alternando (botão da barra).
   ============================================================ */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

vi.mock("./PlayerBar", () => ({ playTrack: vi.fn(), playQueueUpcoming: vi.fn() }));

import { QueueDrawer, QUEUE_EVENT } from "./QueueDrawer";
import { setQueue } from "../store/player";
import type { AutoplayReason, Track } from "../tauri";

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

describe("evento de abrir a fila (shell-v4)", () => {
  it("detail.open=true abre e mantém aberta", () => {
    const { container } = render(() => <QueueDrawer />);
    window.dispatchEvent(new CustomEvent(QUEUE_EVENT, { detail: { open: true } }));
    expect(isOpen(container)).toBe(true);
    window.dispatchEvent(new CustomEvent(QUEUE_EVENT, { detail: { open: true } }));
    expect(isOpen(container)).toBe(true);
  });

  it("sem detail o evento alterna (botão Queue da PlayerBar)", () => {
    const { container } = render(() => <QueueDrawer />);
    window.dispatchEvent(new CustomEvent(QUEUE_EVENT));
    expect(isOpen(container)).toBe(true);
    window.dispatchEvent(new CustomEvent(QUEUE_EVENT));
    expect(isOpen(container)).toBe(false);
  });
});

describe("motivo do rádio sob a faixa (B10)", () => {
  const T = (id: string, title: string, reason?: AutoplayReason) => ({
    id, title, artist_name: "A", album_title: null, album_cover_path: null, album_year: null,
    duration_ms: 1000, path: `/m/${id}`, lrc_path: null, autoplay_reason: reason ?? null,
  }) as Track;

  it("a gaveta mostra o motivo só nas faixas que o rádio escolheu", () => {
    const seed = T("s", "Alright");
    const known = T("k", "Conhecida", { kind: "known", ended: 7, liked: false, pool: "seed", seed_id: "s" });
    const similar = T("p", "Parecida", { kind: "similar", ended: null, liked: null, pool: null, seed_id: "s" });
    setQueue([seed, known, similar, T("m", "Manual")], 0);
    const { container } = render(() => <QueueDrawer />);
    window.dispatchEvent(new CustomEvent(QUEUE_EVENT, { detail: { open: true } }));
    const whys = [...container.querySelectorAll(".qedit__why")].map((e) => e.textContent);
    expect(whys).toEqual(["Conhecida: você ouviu até o fim 7 vezes", "Parecida com “Alright”"]);
    setQueue([], 0);
  });
});
