/* ============================================================
   ParamRow.tsx — Slider horizontal reutilizavel.
   Usado nos paineis Limiter e Bass do Signal.
   Markup: label + track (.param-row__slider > .param-row__track)
   + valor mono. Drag via pointerdown + setPointerCapture, lerp
   sobre rect do slider.
   ============================================================ */

import { Component, createMemo } from "solid-js";

export interface ParamRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  /** Casas decimais no display. Default 1. */
  decimals?: number;
  /** Disparado durante drag continuo e em click no track. */
  onInput: (v: number) => void;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export const ParamRow: Component<ParamRowProps> = (props) => {
  let sliderEl!: HTMLDivElement;
  let dragging = false;

  const decimals = () => props.decimals ?? 1;
  const pct = createMemo(() => {
    const range = props.max - props.min;
    if (range <= 0) return 0;
    return clamp((props.value - props.min) / range, 0, 1) * 100;
  });

  // Converte clientX em valor no range [min, max], com clamp.
  function valueFromX(clientX: number): number {
    const rect = sliderEl.getBoundingClientRect();
    const t = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return lerp(props.min, props.max, clamp(t, 0, 1));
  }

  function onPointerDown(e: PointerEvent) {
    // setPointerCapture garante que pointermove/pointerup cheguem mesmo
    // se o cursor sair do elemento durante o drag.
    try {
      sliderEl.setPointerCapture(e.pointerId);
    } catch {
      // jsdom ou navegador sem suporte — segue via flag interna
    }
    dragging = true;
    e.preventDefault();
    props.onInput(valueFromX(e.clientX));
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    props.onInput(valueFromX(e.clientX));
  }

  function onPointerUp(e: PointerEvent) {
    dragging = false;
    try {
      sliderEl.releasePointerCapture(e.pointerId);
    } catch {
      // captura ja perdida — ignorar
    }
  }

  return (
    <div class="param-row">
      <span class="param-row__label">{props.label}</span>
      <div
        ref={sliderEl}
        class="param-row__slider"
        role="slider"
        aria-label={props.label}
        aria-valuemin={props.min}
        aria-valuemax={props.max}
        aria-valuenow={props.value}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div class="param-row__track">
          <div class="param-row__fill" style={{ width: `${pct()}%` }} />
          <div class="param-row__thumb" style={{ left: `${pct()}%` }} />
        </div>
      </div>
      <span class="param-row__val">
        {props.value.toFixed(decimals())}
        <span class="param-row__unit">{props.unit ? ` ${props.unit}` : ""}</span>
      </span>
    </div>
  );
};
