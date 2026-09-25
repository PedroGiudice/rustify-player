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

import { For, Show, createEffect, createResource, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { pushEscLayer } from "../lib/escLayers";
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
import {
  glStatus,
  resetGlStatus,
  SCENE_HINTS,
  SCENE_KEYS,
  SCENE_LABELS,
} from "../gl/meta";

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
    | "bgBeatDepth"
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

/** Motor do background. Separado do <Segmented> genérico porque ligar
    o WebGL precisa limpar uma falha anterior — senão o App, que cai pro
    2D quando glStatus.ok === false, nunca deixaria tentar de novo. */
function EngineRow() {
  const options: Array<[TweaksState["bgEngine"], string]> = [["2d", "2D"], ["webgl", "WebGL"]];
  return (
    <div class="tweaks__row">
      <span class="tweaks__label">Motor</span>
      <div class="segmented">
        <For each={options}>
          {([val, text]) => (
            <button
              class="segmented__btn"
              classList={{ "is-active": tweaks().bgEngine === val }}
              onClick={() => {
                if (val === "webgl") resetGlStatus();
                updateTweak("bgEngine", val);
              }}
            >
              {text}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

/** Seleção da cena + o que o motor está entregando de fato (driver e
    fps medidos no app). O fps é o gate da feature: se a cena escolhida
    não sustenta ~30 na máquina, está na cara aqui. */
function GlSection() {
  return (
    <>
      <div class="tweaks__row">
        <span class="tweaks__label">Cena</span>
        <div class="segmented">
          <For each={SCENE_KEYS}>
            {(k) => (
              <button
                class="segmented__btn"
                classList={{ "is-active": tweaks().bgScene === k }}
                onClick={() => updateTweak("bgScene", k)}
              >
                {SCENE_LABELS[k]}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="tweaks__hint">{SCENE_HINTS[tweaks().bgScene]}</div>
      <Show when={glStatus().ok === true}>
        <div class="tweaks__hint">
          {glStatus().renderer} · {glStatus().fps} fps
        </div>
      </Show>
      <Show when={glStatus().ok === false}>
        <div class="tweaks__hint">
          WebGL indisponível ({glStatus().error}) — o fundo 2D assumiu.
        </div>
      </Show>
    </>
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

  // Esc fecha o painel aberto quando ele é a camada de cima (lib/escLayers).
  // Captura no window com stopPropagation roubava o Esc da ⌘K, da fila, do
  // menu de contexto e do input do Fader, que ficam por cima do painel.
  createEffect(() => {
    if (!tweaksOpen()) return;
    onCleanup(pushEscLayer(() => setTweaksOpen(false)));
  });

  return (
    <Portal mount={document.body}>
      <aside
        id="tweaks-panel"
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

          {/* data-tweaks-section: o botão de ajustes do Now Playing abre o
              painel rolado até aqui. */}
          <div class="tweaks__divider" data-tweaks-section="fundo"><span>Fundo</span></div>
          <EngineRow />
          <Show when={tweaks().bgEngine === "webgl"}>
            <GlSection />
          </Show>
          <Show when={tweaks().bgEngine === "2d"}>
            <div class="tweaks__hint">
              Shape e renderer do fundo 2D seguem no Now Playing ([ ] e , .)
            </div>
          </Show>

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
            key="bgBeatMode"
            options={[["off", "Off"], ["speed", "Speed"], ["pulse", "Pulse"]]}
          />
          <div class="tweaks__hint">Speed: kick acelera o movimento · Pulse: pulso de amplitude no tempo</div>
          {/* Slider contínuo (2026-07-19): o pipeline sempre foi contínuo
              (bgBeatDepth); os 3 presets eram só amarra da UI. Ajuste
              fino sem esperar release. 0.55 segue o default calibrado. */}
          <NumberSlider
            label="Beat depth"
            key="bgBeatDepth"
            min={0}
            max={1}
            step={0.05}
            format={(v) => v.toFixed(2)}
          />

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
