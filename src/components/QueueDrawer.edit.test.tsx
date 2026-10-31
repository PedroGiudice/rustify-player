/* ============================================================
   QueueDrawer.edit.test.tsx — fila pelo teclado e pelo ponteiro
   (varredura Impeccable de 31/10: A8, A9, A28, B4).

   - Delete repetido tirava mais de uma; o foco caía no vazio.
   - Fechada, a gaveta roubava o Tab; aberta, não era diálogo.
   - Só a atual: "0 tracks · 0:00 remaining" e nada dizia que o rádio
     continua; clicar na atual recomeçava a música (play a mais).
   - Arrastar enquanto a música troca movia a vizinha.
   - Limpar e tirar ganham Desfazer.
   ============================================================ */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";

vi.mock("./PlayerBar", () => ({ playTrack: vi.fn(), playQueueUpcoming: vi.fn() }));
const navigate = vi.fn();
vi.mock("../router", () => ({ navigate: (p: string) => navigate(p) }));

import { QueueDrawer, QUEUE_EVENT, queueEndNote, queueMeta } from "./QueueDrawer";
import { playTrack } from "./PlayerBar";
import { player, setPlayer, advanceQueue } from "../store/player";
import { toast, dismissToast, runToastAction } from "../store/toast";
import type { Track } from "../tauri";

const mk = (id: string, ms = 60_000): Track => ({
  id, title: id, artist_name: null, album_title: null, album_cover_path: null, album_year: null,
  duration_ms: ms, path: `/m/${id}`, lrc_path: null,
});
const ids = () => player.queue.map((t) => t.id);
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// Animação controlada: a saída da linha só termina quando o teste manda.
let pendingFinish: Array<() => void> = [];
let reduce = false;

beforeEach(() => {
  reduce = false;
  pendingFinish = [];
  (window as any).matchMedia = (q: string) => ({ matches: reduce && q.includes("reduce"), media: q });
  (Element.prototype as any).animate = function () {
    const anim: any = { cancel() {}, onfinish: null };
    pendingFinish.push(() => anim.onfinish?.());
    return anim;
  };
  (Element.prototype as any).getAnimations = () => [];
  const q = ["p", "a", "b", "c", "d"].map((id) => mk(id));
  setPlayer({ queue: q, queueIndex: 1, currentTrack: q[1], repeatMode: "off", queueSource: null });
});

afterEach(() => {
  cleanup();
  dismissToast();
  navigate.mockClear();
  document.body.innerHTML = "";
});

async function openDrawer() {
  const r = render(() => <QueueDrawer />);
  window.dispatchEvent(new CustomEvent(QUEUE_EVENT, { detail: { open: true } }));
  await frame();
  return r;
}
const grips = () => [...document.querySelectorAll<HTMLElement>(".qedit__grip")];
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

describe("gaveta como diálogo (A8)", () => {
  it("fechada fica inert; aberta é diálogo rotulado com foco no fechar", async () => {
    const { container } = render(() => <QueueDrawer />);
    const aside = container.querySelector(".queue-drawer")!;
    expect(aside.hasAttribute("inert")).toBe(true);
    window.dispatchEvent(new CustomEvent(QUEUE_EVENT, { detail: { open: true } }));
    await frame();
    expect(aside.hasAttribute("inert")).toBe(false);
    expect(aside.getAttribute("role")).toBe("dialog");
    expect(aside.getAttribute("aria-label")).toBe("Fila");
    expect(document.activeElement).toBe(container.querySelector(".queue-drawer__close"));
  });

  it("Esc devolve o foco ao botão da fila quando ninguém tinha o foco antes", async () => {
    const btn = document.createElement("button");
    btn.id = "pb-queue";
    document.body.appendChild(btn);
    const { container } = await openDrawer();
    key(window as any, "Escape");
    await frame();
    expect(container.querySelector(".queue-drawer")!.getAttribute("data-open")).toBe("false");
    expect(document.activeElement).toBe(btn);
  });

  it("as linhas só montam na primeira abertura", () => {
    const { container } = render(() => <QueueDrawer />);
    expect(container.querySelectorAll(".qedit").length).toBe(0);
  });
});

describe("tirar pelo teclado (A8)", () => {
  it("Delete com auto-repeat não tira nada; um toque tira uma faixa só", async () => {
    await openDrawer();
    key(grips()[0], "Delete", { repeat: true });
    expect(pendingFinish.length).toBe(0);
    key(grips()[0], "Delete");
    key(grips()[0], "Delete"); // mesma linha ainda saindo: ignorado
    expect(pendingFinish.length).toBe(1);
    pendingFinish[0]();
    expect(ids()).toEqual(["p", "a", "c", "d"]);
  });

  it("depois da saída o foco vai para a alça da linha que ocupou o lugar", async () => {
    await openDrawer();
    grips()[0].focus();
    key(grips()[0], "Delete");
    pendingFinish[0]();
    await frame();
    expect(document.activeElement).toBe(grips()[0]);
    expect(grips()[0].getAttribute("aria-label")).toBe("Mover c na fila");
  });

  it("a música trocou durante a animação: sai a faixa certa", async () => {
    await openDrawer();
    key(grips()[1], "Delete"); // c
    advanceQueue(); // b toca
    pendingFinish[0]();
    expect(ids()).toEqual(["p", "a", "b", "d"]);
  });

  it("tirar mostra aviso com Desfazer, que devolve a faixa", async () => {
    reduce = true;
    await openDrawer();
    key(grips()[1], "Delete");
    expect(ids()).toEqual(["p", "a", "b", "d"]);
    expect(toast()?.message).toBe("Tirou “c” da fila");
    runToastAction();
    expect(ids()).toEqual(["p", "a", "b", "c", "d"]);
  });
});

describe("limpar com Desfazer (B4)", () => {
  it("Limpar tira o 'a seguir', mantém a atual e o Desfazer devolve", async () => {
    const { getByText } = await openDrawer();
    fireEvent.click(getByText("Limpar"));
    expect(ids()).toEqual(["p", "a"]);
    expect(toast()?.message).toBe("Fila limpa · 3 faixas");
    runToastAction();
    expect(ids()).toEqual(["p", "a", "b", "c", "d"]);
  });
});

describe("só a faixa atual (A9)", () => {
  it("cabeçalho e nota dizem o que vem depois", async () => {
    setPlayer("queue", (q) => q.slice(0, 2));
    const { container } = await openDrawer();
    expect(container.querySelector(".queue-drawer__meta")!.textContent).toBe("só esta faixa");
    expect(container.querySelector(".queue-drawer__note")!.textContent).toBe("Depois desta, o rádio escolhe.");
  });

  it("clicar na que toca abre o Now Playing e fecha a gaveta, sem tocar de novo", async () => {
    const { container } = await openDrawer();
    fireEvent.click(container.querySelector(".qedit--now .qrow")!);
    expect(navigate).toHaveBeenCalledWith("/now-playing");
    expect(playTrack).not.toHaveBeenCalled();
    expect(container.querySelector(".queue-drawer")!.getAttribute("data-open")).toBe("false");
  });

  it("textos puros: contagem, total e o que acontece no fim", () => {
    expect(queueMeta([mk("x", 61_900)], true)).toBe("1 faixa a seguir · 1:01");
    expect(queueMeta([], false)).toBe("vazia");
    expect(queueEndNote(false, "all")).toBe("Depois desta, a fila recomeça.");
    expect(queueEndNote(true, "off")).toBe("Fim da lista. O rádio continua depois dela.");
    expect(queueEndNote(false, "one")).toBe("A faixa atual se repete.");
  });
});

describe("arrastar com a música trocando (A28)", () => {
  beforeEach(() => {
    let k = 0;
    // Linhas de 40 px empilhadas; o valor exato só importa para o dropIndex.
    (Element.prototype as any).getBoundingClientRect = function () {
      return { top: (k++ % 10) * 40, height: 40, bottom: 0, left: 0, right: 0, width: 0, x: 0, y: 0 };
    };
  });

  it("ao soltar, a arrastada vai para onde a faixa-alvo está agora", async () => {
    await openDrawer();
    const g = grips()[1]; // c
    fireEvent.pointerDown(g, { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(g, { clientY: 140, pointerId: 1 }); // uma linha abaixo: alvo d
    advanceQueue(); // b toca; "a seguir" = c, d
    fireEvent.pointerUp(g, { clientY: 140, pointerId: 1 });
    expect(ids()).toEqual(["p", "a", "b", "d", "c"]);
  });

  it("a arrastada virou a atual: o gesto aborta, nada muda e nada fica erguido", async () => {
    const { container } = await openDrawer();
    const g = grips()[0]; // b
    fireEvent.pointerDown(g, { button: 0, clientY: 100, pointerId: 1 });
    advanceQueue(); // b toca
    fireEvent.pointerMove(g, { clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(g, { clientY: 180, pointerId: 1 });
    expect(ids()).toEqual(["p", "a", "b", "c", "d"]);
    expect(container.querySelector(".qedit--lifted")).toBeNull();
    expect(container.querySelector(".qlist")?.hasAttribute("data-dragging") ?? false).toBe(false);
  });

  it("janela perde o foco no meio do arraste: cancela", async () => {
    await openDrawer();
    const g = grips()[0];
    fireEvent.pointerDown(g, { button: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(g, { clientY: 180, pointerId: 1 });
    window.dispatchEvent(new Event("blur"));
    fireEvent.pointerUp(g, { clientY: 180, pointerId: 1 });
    expect(ids()).toEqual(["p", "a", "b", "c", "d"]);
  });
});
