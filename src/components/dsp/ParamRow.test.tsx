/* ============================================================
   ParamRow.test.tsx — Comportamentos essenciais do slider.
   Cobre render, clique no track, drag continuo e clamp.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { ParamRow } from "./ParamRow";

// Auxiliar: cria um PointerEvent valido em jsdom (PointerEvent nao
// existe nativamente, fallback pra MouseEvent com pointerId).
function pointerEvent(type: string, opts: { clientX: number; clientY?: number; pointerId?: number }) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.clientX,
    clientY: opts.clientY ?? 0,
  });
  (ev as any).pointerId = opts.pointerId ?? 1;
  return ev;
}

// Stub do getBoundingClientRect para tracks — jsdom devolve zeros por default.
function stubRect(el: Element, width: number) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: 14, width, height: 14, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

beforeEach(() => {
  // Pointer Capture API nao existe em jsdom — stub no-op em todos os elementos.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false) as any;
});

afterEach(() => {
  cleanup();
});

describe("ParamRow", () => {
  it("renderiza label, valor e unidade", () => {
    const { getByText, container } = render(() => (
      <ParamRow label="Threshold" value={-6} min={-60} max={0} unit="dB" decimals={1} onInput={() => {}} />
    ));
    expect(getByText("Threshold")).toBeTruthy();
    expect(getByText("-6.0")).toBeTruthy();
    expect(getByText("dB")).toBeTruthy();
    expect(container.querySelector(".param-row__fill")).toBeTruthy();
    expect(container.querySelector(".param-row__thumb")).toBeTruthy();
  });

  it("posiciona fill e thumb pela razao (value - min) / (max - min)", () => {
    const { container } = render(() => (
      <ParamRow label="x" value={0} min={-60} max={0} unit="dB" onInput={() => {}} />
    ));
    const fill = container.querySelector<HTMLElement>(".param-row__fill")!;
    const thumb = container.querySelector<HTMLElement>(".param-row__thumb")!;
    // value=0 / max=0 / min=-60 -> 100%
    expect(fill.style.width).toBe("100%");
    expect(thumb.style.left).toBe("100%");
  });

  it("click no track dispara onInput com valor interpolado por lerp(min, max, pct)", () => {
    const onInput = vi.fn();
    const { container } = render(() => (
      <ParamRow label="x" value={0} min={0} max={100} unit="%" onInput={onInput} />
    ));
    const slider = container.querySelector<HTMLElement>(".param-row__slider")!;
    stubRect(slider, 200);
    slider.dispatchEvent(pointerEvent("pointerdown", { clientX: 50 }));
    // 50/200 = 25% -> lerp(0,100,0.25) = 25
    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput.mock.calls[0][0]).toBe(25);
  });

  it("drag dispara onInput a cada pointermove enquanto capturado", () => {
    const onInput = vi.fn();
    const { container } = render(() => (
      <ParamRow label="x" value={0} min={0} max={100} unit="%" onInput={onInput} />
    ));
    const slider = container.querySelector<HTMLElement>(".param-row__slider")!;
    stubRect(slider, 200);
    slider.dispatchEvent(pointerEvent("pointerdown", { clientX: 0 }));
    slider.dispatchEvent(pointerEvent("pointermove", { clientX: 100 }));
    slider.dispatchEvent(pointerEvent("pointermove", { clientX: 150 }));
    // Calls: pointerdown@0 -> 0, move@100 -> 50, move@150 -> 75
    expect(onInput.mock.calls.map((c) => c[0])).toEqual([0, 50, 75]);
  });

  it("clamp respeita min/max quando pointer fora do track", () => {
    const onInput = vi.fn();
    const { container } = render(() => (
      <ParamRow label="x" value={50} min={0} max={100} unit="%" onInput={onInput} />
    ));
    const slider = container.querySelector<HTMLElement>(".param-row__slider")!;
    stubRect(slider, 200);
    slider.dispatchEvent(pointerEvent("pointerdown", { clientX: -50 }));
    slider.dispatchEvent(pointerEvent("pointermove", { clientX: 9999 }));
    expect(onInput.mock.calls[0][0]).toBe(0);
    expect(onInput.mock.calls[1][0]).toBe(100);
  });

  it("para de disparar onInput apos pointerup", () => {
    const onInput = vi.fn();
    const { container } = render(() => (
      <ParamRow label="x" value={0} min={0} max={100} unit="%" onInput={onInput} />
    ));
    const slider = container.querySelector<HTMLElement>(".param-row__slider")!;
    stubRect(slider, 200);
    slider.dispatchEvent(pointerEvent("pointerdown", { clientX: 0 }));
    slider.dispatchEvent(pointerEvent("pointerup", { clientX: 0 }));
    onInput.mockClear();
    slider.dispatchEvent(pointerEvent("pointermove", { clientX: 100 }));
    expect(onInput).not.toHaveBeenCalled();
  });

  it("decimals=0 formata sem casas", () => {
    const { getByText } = render(() => (
      <ParamRow label="x" value={42} min={0} max={100} unit="ms" decimals={0} onInput={() => {}} />
    ));
    expect(getByText("42")).toBeTruthy();
  });
});
