/* ============================================================
   views/Tweaks.tsx — Painel flutuante de Tweaks (Solid).

   Substitui o legacy `src/js/components/tweaks.js` que sofria de
   render destrutivo (innerHTML) no input handler do slider — bug
   conhecido em docs/bugs/17052026-tweaks-font-slider-freeze.md.

   Aqui:
   - Sliders sao source-of-truth controlado por signals
   - O label "valor %" e um `<span>` derivado, atualiza sem refazer DOM
   - Apply + persist roda via createEffect no store/tweaks.ts
   - Painel monta uma vez via <Portal>; visibilidade via classList
   ============================================================ */

import { For, Show, createResource, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import {
  tweaks,
  tweaksOpen,
  setTweaksOpen,
  updateTweak,
  resetTweaks,
  listSystemFonts,
  isDirty,
  clearDirty,
  type TweaksState,
} from "../store/tweaks";

// ── Subcomponentes locais ────────────────────────────────────

function Segmented<K extends keyof TweaksState>(props: {
  label: string;
  key: K;
  options: Array<[TweaksState[K], string]>;
}) {
  return (
    <div class="tweaks__row">
      <span class="tweaks__label">{props.label}</span>
      <div class="segmented">
        <For each={props.options}>
          {([val, text]) => (
            <button
              class="segmented__btn"
              classList={{ "is-active": tweaks()[props.key] === val }}
              onClick={() => updateTweak(props.key, val)}
            >
              {text}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

function FontSelect(props: {
  label: string;
  key: "fontUI" | "fontMono";
  fonts: string[];
}) {
  return (
    <div class="tweaks__row">
      <span class="tweaks__label">{props.label}</span>
      <select
        class="tweaks__select"
        value={tweaks()[props.key]}
        onChange={(e) => updateTweak(props.key, e.currentTarget.value)}
      >
        <option value="">Default</option>
        <For each={props.fonts}>
          {(f) => <option value={f}>{f}</option>}
        </For>
      </select>
    </div>
  );
}

function NumberSlider(props: {
  label: string;
  key:
    | "scale"
    | "glow"
    | "lyricsGlass"
    | "bgBassGain"
    | "bgMidGain"
    | "bgTrebleGain"
    | "bgSmoothing"
    | "bgSpeed"
    | "loudnessTarget";
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  /** Knob regido pelo tema: mostra "↺ tema" quando o usuário sobrescreveu. */
  themeGoverned?: boolean;
}) {
  return (
    <div class="tweaks__row">
      <span class="tweaks__label">
        {props.label} <span class="tweaks__val">{props.format(tweaks()[props.key])}</span>
        <Show when={props.themeGoverned && isDirty(props.key)}>
          <button
            class="tweaks__reset"
            title="Voltar a seguir o tema"
            onClick={() => clearDirty(props.key)}
          >
            ↺ tema
          </button>
        </Show>
      </span>
      <input
        type="range"
        class="settings-range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={tweaks()[props.key]}
        // input = arrasto em tempo real; o store reage e aplica.
        // Sem re-render do painel, sem perder pointer capture.
        onInput={(e) => updateTweak(props.key, parseFloat(e.currentTarget.value))}
      />
    </div>
  );
}

// ── Painel ────────────────────────────────────────────────────

export function Tweaks() {
  const [fonts] = createResource(async () => await listSystemFonts());

  onMount(() => {
    const onToggle = () => setTweaksOpen(!tweaksOpen());
    window.addEventListener("toggle-tweaks", onToggle);
    onCleanup(() => window.removeEventListener("toggle-tweaks", onToggle));
  });

  return (
    <Portal mount={document.body}>
      <aside
        class="tweaks"
        classList={{ "is-visible": tweaksOpen() }}
        aria-label="Tweaks"
      >
        <div class="tweaks__header">
          <span class="tweaks__title">Tweaks</span>
          <button
            class="tweaks__close"
            aria-label="Fechar"
            onClick={() => setTweaksOpen(false)}
          >
            &times;
          </button>
        </div>
        <div class="tweaks__body">
          <div class="tweaks__divider"><span>Layout</span></div>
          <Segmented
            label="Density"
            key="density"
            options={[["normal", "Normal"], ["compact", "Compact"]]}
          />
          <Segmented
            label="Sidebar"
            key="sidebar"
            options={[["icons", "Icons"], ["labels", "Labels"]]}
          />

          <div class="tweaks__divider"><span>Tipografia</span></div>
          <Segmented
            label="Type"
            key="type"
            options={[["body", "Sans"], ["mono", "Mono"]]}
          />
          <Show when={!fonts.loading}>
            <FontSelect label="UI Font" key="fontUI" fonts={fonts() ?? []} />
            <FontSelect label="Mono Font" key="fontMono" fonts={fonts() ?? []} />
          </Show>

          <div class="tweaks__divider"><span>Escala e Efeitos</span></div>
          <NumberSlider
            label="Scale"
            key="scale"
            min={0.85}
            max={1.25}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <NumberSlider
            label="Glow"
            key="glow"
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
            themeGoverned
          />
          <NumberSlider
            label="Lyrics glass"
            key="lyricsGlass"
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            themeGoverned
          />

          <div class="tweaks__row">
            <span class="tweaks__label">
              Bg ink <span class="tweaks__val">{tweaks().bgInk}</span>
              <Show when={isDirty("bgInk")}>
                <button
                  class="tweaks__reset"
                  title="Voltar a seguir o tema / capa"
                  onClick={() => clearDirty("bgInk")}
                >
                  ↺ tema
                </button>
              </Show>
            </span>
            <input
              type="color"
              class="tweaks__color"
              value={tweaks().bgInk}
              onInput={(e) => updateTweak("bgInk", e.currentTarget.value)}
            />
          </div>
          <Segmented
            label="Adaptive ink"
            key="adaptiveInk"
            options={[[true, "Album"], [false, "Off"]]}
          />
          <Segmented
            label="Ink cycle"
            key="bgInkCycle"
            options={[[true, "Alterna"], [false, "Fixa"]]}
          />
          <div class="tweaks__hint">Bg alterna entre as cores dominantes da capa (~40s)</div>
          <Segmented
            label="Adaptive accent"
            key="adaptiveAccent"
            options={[[true, "Album"], [false, "Off"]]}
          />
          <Segmented
            label="EQ spectrum"
            key="eqSpectrumOverlay"
            options={[[true, "On"], [false, "Off"]]}
          />

          <div class="tweaks__divider"><span>Bg reactivity</span></div>
          <NumberSlider
            label="Bass"
            key="bgBassGain"
            min={0}
            max={2}
            step={0.05}
            format={(v) => v.toFixed(2)}
          />
          <NumberSlider
            label="Mid"
            key="bgMidGain"
            min={0}
            max={2}
            step={0.05}
            format={(v) => v.toFixed(2)}
          />
          <NumberSlider
            label="Treble"
            key="bgTrebleGain"
            min={0}
            max={2}
            step={0.05}
            format={(v) => v.toFixed(2)}
          />
          <NumberSlider
            label="Smoothing"
            key="bgSmoothing"
            min={0}
            max={1}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <NumberSlider
            label="Speed"
            key="bgSpeed"
            min={0}
            max={2}
            step={0.05}
            format={(v) => `${v.toFixed(2)}x`}
          />
          <Segmented
            label="Beat sync"
            key="bgBeatDepth"
            options={[[0, "Off"], [0.3, "Subtle"], [0.55, "Default"], [0.85, "Pulse"]]}
          />
          <div class="tweaks__hint">Pulso do kick na amplitude, travado no tempo da música</div>

          <div class="tweaks__divider"><span>Loudness</span></div>
          <Segmented
            label="Normalização"
            key="loudnessNorm"
            options={[[true, "On"], [false, "Off"]]}
          />
          <NumberSlider
            label="Target"
            key="loudnessTarget"
            min={-20}
            max={-6}
            step={0.5}
            format={(v) => `${v.toFixed(1)} LUFS`}
          />

          <button class="tweaks__reset" onClick={() => resetTweaks()}>
            Redefinir tudo
          </button>
        </div>
      </aside>
    </Portal>
  );
}
