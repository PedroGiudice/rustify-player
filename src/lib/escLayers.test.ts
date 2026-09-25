/* ============================================================
   escLayers.test.ts — pilha única dos overlays que fecham com Esc.

   Cada overlay tinha o próprio listener de Esc, em fases e alvos
   diferentes (captura no window, bubble no window, document). A ordem
   de execução seguia a ordem de REGISTRO, não o empilhamento na tela:
   o Tweaks (z 50) fechava antes da ⌘K, da fila e do menu de contexto
   que estavam por cima, e o App saía do cinema no mesmo toque em que
   a fila fechava (revisão da fase 0, 25/09).

   Contrato: o Esc fecha só a camada aberta por último; um controle
   focado que já tratou o Esc (preventDefault) tem precedência; o Esc
   que fecha uma camada sai com defaultPrevented.
   ============================================================ */

import { describe, it, expect, afterEach } from "vitest";
import { pushEscLayer, hasEscLayer } from "./escLayers";

const pops: Array<() => void> = [];
function layer(log: string[], name: string): () => void {
  const pop = pushEscLayer(() => { log.push(name); pop(); });
  pops.push(pop);
  return pop;
}

function esc(target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

afterEach(() => {
  pops.splice(0).forEach((p) => p());
});

describe("escLayers", () => {
  it("fecha só a camada de cima, uma por Esc", () => {
    const log: string[] = [];
    layer(log, "tweaks");
    layer(log, "fila");
    esc();
    expect(log).toEqual(["fila"]);
    esc();
    expect(log).toEqual(["fila", "tweaks"]);
    expect(hasEscLayer()).toBe(false);
  });

  it("o Esc que fecha uma camada sai consumido (defaultPrevented)", () => {
    const log: string[] = [];
    layer(log, "tweaks");
    expect(esc().defaultPrevented).toBe(true);
    // Sem camada, o Esc segue livre para o App (cinema).
    expect(esc().defaultPrevented).toBe(false);
  });

  it("Esc já tratado por um controle focado não fecha camada", () => {
    const log: string[] = [];
    layer(log, "tweaks");
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") e.preventDefault(); });
    try {
      esc(input);
      expect(log).toEqual([]);
      expect(hasEscLayer()).toBe(true);
    } finally {
      input.remove();
    }
  });

  it("remover uma camada do meio preserva a ordem das outras", () => {
    const log: string[] = [];
    layer(log, "a");
    const popB = layer(log, "b");
    layer(log, "c");
    popB();
    esc();
    esc();
    expect(log).toEqual(["c", "a"]);
  });

  it("tecla que não é Esc não fecha nada", () => {
    const log: string[] = [];
    layer(log, "tweaks");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true, cancelable: true }));
    expect(log).toEqual([]);
  });
});
