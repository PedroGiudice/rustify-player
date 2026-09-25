/* ============================================================
   Fader.test.tsx — Comportamentos do fader vertical de EQ.
   Cobre render (freq+gain), click ativa, drag muda gain,
   clamp em -36/+36, double-click abre input numerico inline.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { Fader } from "./Fader";

function pointerEvent(type: string, opts: { clientY: number; pointerId?: number }) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 0,
    clientY: opts.clientY,
  });
  (ev as any).pointerId = opts.pointerId ?? 1;
  return ev;
}

function stubRect(el: Element, height: number, top = 0) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top, right: 14, bottom: top + height, width: 14, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false) as any;
});

afterEach(() => {
  cleanup();
});

describe("Fader", () => {
  it("renderiza freq formatada (Hz vs kHz) e gain", () => {
    const { container } = render(() => (
      <Fader bandIdx={0} freq={63} gainDb={2.5} active={false} onActivate={() => {}} onChange={() => {}} />
    ));
    expect(container.querySelector(".fader__hz")?.textContent).toBe("63");
    expect(container.querySelector(".fader__val")?.textContent).toBe("+2.5");
  });

  it("formata kHz com 1 casa para freq < 10k e 0 casas para >= 10k", () => {
    const { container, unmount } = render(() => (
      <Fader bandIdx={0} freq={1000} gainDb={0} active={false} onActivate={() => {}} onChange={() => {}} />
    ));
    expect(container.querySelector(".fader__hz")?.textContent).toBe("1.0k");
    unmount();
    const r2 = render(() => (
      <Fader bandIdx={0} freq={10000} gainDb={0} active={false} onActivate={() => {}} onChange={() => {}} />
    ));
    expect(r2.container.querySelector(".fader__hz")?.textContent).toBe("10k");
  });

  it("marca data-active=true e expoe gain negativo com sinal", () => {
    const { container } = render(() => (
      <Fader bandIdx={3} freq={250} gainDb={-6} active={true} onActivate={() => {}} onChange={() => {}} />
    ));
    const root = container.querySelector<HTMLElement>(".fader")!;
    expect(root.dataset.active).toBe("true");
    expect(container.querySelector(".fader__val")?.textContent).toBe("-6.0");
  });

  it("click no fader chama onActivate", () => {
    const onActivate = vi.fn();
    const { container } = render(() => (
      <Fader bandIdx={5} freq={400} gainDb={0} active={false} onActivate={onActivate} onChange={() => {}} />
    ));
    const root = container.querySelector<HTMLElement>(".fader")!;
    root.click();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("drag no track chama onChange com valor mapeado (cursor sobe = mais gain)", () => {
    const onChange = vi.fn();
    const { container } = render(() => (
      <Fader bandIdx={0} freq={1000} gainDb={0} active={true} onActivate={() => {}} onChange={onChange} />
    ));
    const track = container.querySelector<HTMLElement>(".fader__track")!;
    stubRect(track, 100, 0);
    track.dispatchEvent(pointerEvent("pointerdown", { clientY: 0 }));
    // clientY=0 -> topo -> +36
    expect(onChange.mock.calls.at(-1)?.[0]).toBeCloseTo(36, 1);
    track.dispatchEvent(pointerEvent("pointermove", { clientY: 50 }));
    // clientY=50 -> centro -> 0
    expect(onChange.mock.calls.at(-1)?.[0]).toBeCloseTo(0, 1);
    track.dispatchEvent(pointerEvent("pointermove", { clientY: 100 }));
    // clientY=100 -> base -> -36
    expect(onChange.mock.calls.at(-1)?.[0]).toBeCloseTo(-36, 1);
  });

  it("clamp respeita -36/+36 quando cursor sai do track", () => {
    const onChange = vi.fn();
    const { container } = render(() => (
      <Fader bandIdx={0} freq={1000} gainDb={0} active={true} onActivate={() => {}} onChange={onChange} />
    ));
    const track = container.querySelector<HTMLElement>(".fader__track")!;
    stubRect(track, 100, 0);
    track.dispatchEvent(pointerEvent("pointerdown", { clientY: -50 }));
    expect(onChange.mock.calls[0][0]).toBe(36);
    track.dispatchEvent(pointerEvent("pointermove", { clientY: 200 }));
    expect(onChange.mock.calls.at(-1)?.[0]).toBe(-36);
  });

  it("double-click no valor abre input numerico inline com gain atual", () => {
    const onChange = vi.fn();
    const { container } = render(() => (
      <Fader bandIdx={0} freq={1000} gainDb={2.5} active={true} onActivate={() => {}} onChange={onChange} />
    ));
    const val = container.querySelector<HTMLElement>(".fader__val")!;
    val.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const input = container.querySelector<HTMLInputElement>("input.fader__input");
    expect(input).toBeTruthy();
    expect(input!.value).toBe("2.5");
    // Commit via Enter -> onChange chamado com valor digitado
    input!.value = "5.5";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onChange).toHaveBeenCalledWith(5.5);
  });

  it("ESC no input cancela sem chamar onChange", () => {
    const onChange = vi.fn();
    const { container } = render(() => (
      <Fader bandIdx={0} freq={1000} gainDb={2} active={true} onActivate={() => {}} onChange={onChange} />
    ));
    const val = container.querySelector<HTMLElement>(".fader__val")!;
    val.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const input = container.querySelector<HTMLInputElement>("input.fader__input")!;
    input.value = "10";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("trilho é um slider focável com valor em dB (estsig-3)", () => {
    const { container } = render(() => (
      <Fader bandIdx={2} freq={63} gainDb={2.5} active={false} onActivate={() => {}} onChange={() => {}} />
    ));
    const track = container.querySelector<HTMLElement>(".fader__track")!;
    expect(track.getAttribute("role")).toBe("slider");
    expect(track.tabIndex).toBe(0);
    expect(track.getAttribute("aria-orientation")).toBe("vertical");
    expect(track.getAttribute("aria-valuemin")).toBe("-36");
    expect(track.getAttribute("aria-valuemax")).toBe("36");
    expect(track.getAttribute("aria-valuenow")).toBe("2.5");
    expect(track.getAttribute("aria-valuetext")).toBe("+2.5 dB");
    expect(track.getAttribute("aria-label")).toContain("63");
  });

  it("setas (Shift = 1 dB), PageUp/PageDown e Home/End mudam o ganho (estsig-3)", () => {
    const onChange = vi.fn();
    const { container } = render(() => (
      <Fader bandIdx={0} freq={1000} gainDb={2.5} active={true} onActivate={() => {}} onChange={onChange} />
    ));
    const track = container.querySelector<HTMLElement>(".fader__track")!;
    const key = (k: string, shiftKey = false) =>
      track.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
    key("ArrowUp");
    key("ArrowDown");
    key("ArrowUp", true);
    key("PageUp");
    key("PageDown");
    key("Home");
    key("End");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([2.6, 2.4, 3.5, 5.5, -0.5, -36, 36]);
  });

  it("foco pelo teclado ativa a banda (estsig-3)", () => {
    const onActivate = vi.fn();
    const { container } = render(() => (
      <Fader bandIdx={4} freq={160} gainDb={0} active={false} onActivate={onActivate} onChange={() => {}} />
    ));
    container.querySelector<HTMLElement>(".fader__track")!.focus();
    expect(onActivate).toHaveBeenCalled();
  });

  it("commit via input clamp em -36/+36", () => {
    const onChange = vi.fn();
    const { container } = render(() => (
      <Fader bandIdx={0} freq={1000} gainDb={0} active={true} onActivate={() => {}} onChange={onChange} />
    ));
    const val = container.querySelector<HTMLElement>(".fader__val")!;
    val.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    const input = container.querySelector<HTMLInputElement>("input.fader__input")!;
    input.value = "100";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onChange).toHaveBeenCalledWith(36);
  });
});
