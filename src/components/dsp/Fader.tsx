/* ============================================================
   Fader.tsx — Fader vertical de uma banda do EQ.
   Render: <hz> + <track (zero + fill + thumb)> + <val>.
   Range -36..+36 dB, step 0.1. Inversao Y (cursor sobe = mais gain).
   Double-click no valor abre <input type=number> inline com Enter/ESC.
   ============================================================ */

import { Component, createMemo, createSignal, Show, onCleanup } from "solid-js";
import { DB_RANGE } from "../../store/dsp";

export interface FaderProps {
  bandIdx: number;
  freq: number;
  gainDb: number;
  active: boolean;
  onActivate: () => void;
  onChange: (db: number) => void;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// "63" / "1.0k" / "10k" / "20k"
function fmtHz(hz: number): string {
  if (hz < 1000) return String(hz);
  return `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k`;
}

function fmtDb(db: number): string {
  const sign = db > 0 ? "+" : "";
  return `${sign}${db.toFixed(1)}`;
}

// Arredonda pra 0.1 e clamp em [-DB_RANGE, DB_RANGE].
function quantize(db: number): number {
  return clamp(Math.round(db * 10) / 10, -DB_RANGE, DB_RANGE);
}

export const Fader: Component<FaderProps> = (props) => {
  let trackEl!: HTMLDivElement;
  let dragging = false;
  const [editing, setEditing] = createSignal(false);
  let inputEl: HTMLInputElement | undefined;

  // pct = altura do fill em % (0..50). thumbPos = bottom em % (0..100).
  const fillPct = createMemo(() => Math.abs(props.gainDb) / DB_RANGE * 50);
  const thumbPct = createMemo(() => 50 + (props.gainDb / DB_RANGE) * 50);

  function dbFromY(clientY: number): number {
    const rect = trackEl.getBoundingClientRect();
    const relY = rect.height > 0 ? 1 - (clientY - rect.top) / rect.height : 0.5;
    return quantize((clamp(relY, 0, 1) - 0.5) * 2 * DB_RANGE);
  }

  function onTrackPointerDown(e: PointerEvent) {
    try { trackEl.setPointerCapture(e.pointerId); } catch {}
    dragging = true;
    e.preventDefault();
    e.stopPropagation();  // nao quer disparar click do fader (que ativa)
    props.onChange(dbFromY(e.clientY));
  }

  function onTrackPointerMove(e: PointerEvent) {
    if (!dragging) return;
    props.onChange(dbFromY(e.clientY));
  }

  function onTrackPointerUp(e: PointerEvent) {
    dragging = false;
    try { trackEl.releasePointerCapture(e.pointerId); } catch {}
  }

  function commitInput() {
    if (!inputEl) return;
    const raw = parseFloat(inputEl.value);
    if (!isNaN(raw)) {
      props.onChange(quantize(raw));
    }
    setEditing(false);
  }

  function cancelInput() {
    setEditing(false);
  }

  function onValDblClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setEditing(true);
    // foca no proximo tick (input acabou de montar)
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  }

  function onInputKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") { e.preventDefault(); commitInput(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelInput(); }
  }

  onCleanup(() => {
    dragging = false;
  });

  const fillCls = () => `fader__fill ${props.gainDb >= 0 ? "fader__fill--up" : "fader__fill--dn"}`;

  return (
    <div
      class="fader"
      data-active={props.active ? "true" : "false"}
      data-band={props.bandIdx}
      onClick={() => props.onActivate()}
    >
      <span class="fader__hz">{fmtHz(props.freq)}</span>
      <div
        ref={trackEl}
        class="fader__track"
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        onPointerCancel={onTrackPointerUp}
      >
        <div class="fader__zero" />
        <Show when={props.gainDb !== 0}>
          <div class={fillCls()} style={{ height: `${fillPct()}%` }} />
        </Show>
        <div class="fader__thumb" style={{ bottom: `${thumbPct()}%` }} />
      </div>
      <Show
        when={editing()}
        fallback={
          <span class="fader__val" onDblClick={onValDblClick}>
            {fmtDb(props.gainDb)}
          </span>
        }
      >
        <input
          ref={inputEl}
          class="fader__input"
          type="number"
          step="0.1"
          min={-DB_RANGE}
          max={DB_RANGE}
          value={props.gainDb.toFixed(1)}
          onBlur={commitInput}
          onKeyDown={onInputKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
      </Show>
    </div>
  );
};
