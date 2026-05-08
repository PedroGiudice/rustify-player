import { createSignal, For, Show, onMount } from "solid-js";
import { getSpectrumConfig, setSpectrumConfig, listSpectrumPresets, loadSpectrumPreset } from "../tauri";
import type { SpectrumRange, SpectrumPresetInfo, SpectrumVisualConfig } from "../tauri";

const PRESETS: Record<string, SpectrumRange[]> = {
  "Full Range": [
    { label: "Sub-bass", from_hz: 20, to_hz: 60, gain: 1.0 },
    { label: "Bass", from_hz: 60, to_hz: 250, gain: 1.0 },
    { label: "Low-mid", from_hz: 250, to_hz: 500, gain: 1.0 },
    { label: "Mid", from_hz: 500, to_hz: 2000, gain: 1.0 },
    { label: "Upper-mid", from_hz: 2000, to_hz: 4000, gain: 1.0 },
    { label: "Presence", from_hz: 4000, to_hz: 8000, gain: 1.0 },
    { label: "Brilliance", from_hz: 8000, to_hz: 20000, gain: 1.0 },
  ],
  "Bass Focus": [
    { label: "Sub-bass", from_hz: 20, to_hz: 60, gain: 2.0 },
    { label: "Bass", from_hz: 60, to_hz: 150, gain: 1.8 },
    { label: "Kick", from_hz: 150, to_hz: 300, gain: 1.5 },
    { label: "Low-mid", from_hz: 300, to_hz: 800, gain: 0.5 },
    { label: "Rest", from_hz: 800, to_hz: 20000, gain: 0.2 },
  ],
  "Vocal Range": [
    { label: "Low vocal", from_hz: 80, to_hz: 300, gain: 0.5 },
    { label: "Chest", from_hz: 300, to_hz: 1000, gain: 1.5 },
    { label: "Presence", from_hz: 1000, to_hz: 4000, gain: 2.0 },
    { label: "Sibilance", from_hz: 4000, to_hz: 8000, gain: 1.2 },
    { label: "Air", from_hz: 8000, to_hz: 16000, gain: 0.3 },
  ],
  "Treble Detail": [
    { label: "Foundation", from_hz: 20, to_hz: 500, gain: 0.2 },
    { label: "Mid", from_hz: 500, to_hz: 2000, gain: 0.5 },
    { label: "Upper-mid", from_hz: 2000, to_hz: 4000, gain: 1.5 },
    { label: "Presence", from_hz: 4000, to_hz: 8000, gain: 1.8 },
    { label: "Brilliance", from_hz: 8000, to_hz: 14000, gain: 2.0 },
    { label: "Air", from_hz: 14000, to_hz: 20000, gain: 1.5 },
  ],
};

interface Props {
  open: boolean;
  onClose: () => void;
  onConfigChange?: (cfg: SpectrumVisualConfig) => void;
}

export default function SpectrumRangesPanel(props: Props) {
  const [ranges, setRanges] = createSignal<SpectrumRange[]>([]);
  const [activePreset, setActivePreset] = createSignal("Full Range");
  const [savedRanges, setSavedRanges] = createSignal<SpectrumRange[]>([]);
  const [visualPresets, setVisualPresets] = createSignal<SpectrumPresetInfo[]>([]);
  const [activeVisualPreset, setActiveVisualPreset] = createSignal(
    localStorage.getItem("rustify-spectrum-preset") || "default.yaml"
  );

  onMount(async () => {
    try {
      const cfg = await getSpectrumConfig();
      setRanges(cfg.ranges);
      setSavedRanges(structuredClone(cfg.ranges));
      detectPreset(cfg.ranges);
    } catch {
      setRanges(structuredClone(PRESETS["Full Range"]));
      setSavedRanges(structuredClone(PRESETS["Full Range"]));
    }

    // Load visual presets list
    try {
      const presets = await listSpectrumPresets();
      setVisualPresets(presets);
    } catch {
      // No presets available — section will be hidden
    }
  });

  async function selectVisualPreset(filename: string) {
    try {
      const cfg = await loadSpectrumPreset(filename);
      setActiveVisualPreset(filename);
      localStorage.setItem("rustify-spectrum-preset", filename);
      props.onConfigChange?.(cfg);
    } catch (e) {
      console.warn("[spectrum] failed to load preset:", e);
    }
  }

  function detectPreset(r: SpectrumRange[]) {
    for (const [name, preset] of Object.entries(PRESETS)) {
      if (r.length !== preset.length) continue;
      const match = r.every((range, i) =>
        range.label === preset[i].label &&
        range.from_hz === preset[i].from_hz &&
        range.to_hz === preset[i].to_hz &&
        Math.abs(range.gain - preset[i].gain) < 0.01
      );
      if (match) { setActivePreset(name); return; }
    }
    setActivePreset("Custom");
  }

  function applyPreset(name: string) {
    const preset = PRESETS[name];
    if (!preset) return;
    setRanges(structuredClone(preset));
    setActivePreset(name);
  }

  function updateRange(idx: number, field: keyof SpectrumRange, value: string | number) {
    setRanges(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
    setActivePreset("Custom");
  }

  function deleteRange(idx: number) {
    if (ranges().length <= 1) return;
    setRanges(prev => prev.filter((_, i) => i !== idx));
    setActivePreset("Custom");
  }

  function addRange() {
    const last = ranges()[ranges().length - 1];
    setRanges(prev => [...prev, {
      label: "New",
      from_hz: last?.to_hz ?? 1000,
      to_hz: Math.min((last?.to_hz ?? 1000) + 2000, 20000),
      gain: 1.0,
    }]);
    setActivePreset("Custom");
  }

  async function apply() {
    const r = ranges();
    await setSpectrumConfig(r);
    setSavedRanges(structuredClone(r));
  }

  function reset() {
    setRanges(structuredClone(savedRanges()));
    detectPreset(savedRanges());
  }

  return (
    <div class={`spectrum-panel${props.open ? "" : " is-hidden"}`}>
      <header class="spectrum-panel__header">
        <h2 class="spectrum-panel__title">Spectrum Ranges</h2>
        <button class="spectrum-panel__close-btn" onClick={props.onClose}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      <Show when={visualPresets().length > 0}>
        <div class="spectrum-panel__section">
          <span class="spectrum-panel__label">Visual Preset</span>
          <div class="spectrum-panel__chips">
            <For each={visualPresets()}>
              {(preset) => (
                <button
                  class={`chip${activeVisualPreset() === preset.filename ? " chip--active" : ""}`}
                  onClick={() => selectVisualPreset(preset.filename)}
                >
                  {preset.name}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

      <div class="spectrum-panel__section">
        <span class="spectrum-panel__label">Frequency Ranges</span>
        <div class="spectrum-panel__chips">
          <For each={[...Object.keys(PRESETS), "Custom"]}>
            {(name) => (
              <button
                class={`chip${activePreset() === name ? " chip--active" : ""}`}
                onClick={() => name !== "Custom" && applyPreset(name)}
                disabled={name === "Custom"}
              >
                {name}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="spectrum-panel__ranges">
        <For each={ranges()}>
          {(range, i) => (
            <div class="spectrum-range-item">
              <input
                class="spectrum-range-item__label"
                value={range.label}
                onChange={(e) => updateRange(i(), "label", e.currentTarget.value)}
              />
              <div class="spectrum-range-item__freq">
                <input
                  class="spectrum-range-item__input"
                  type="number"
                  value={range.from_hz}
                  onChange={(e) => updateRange(i(), "from_hz", Number(e.currentTarget.value))}
                />
                <span class="spectrum-range-item__sep">–</span>
                <input
                  class="spectrum-range-item__input"
                  type="number"
                  value={range.to_hz}
                  onChange={(e) => updateRange(i(), "to_hz", Number(e.currentTarget.value))}
                />
                <span class="spectrum-range-item__unit">Hz</span>
              </div>
              <div class="spectrum-range-item__gain">
                <input
                  class="spectrum-range-item__slider"
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={range.gain}
                  onInput={(e) => updateRange(i(), "gain", Number(e.currentTarget.value))}
                />
                <span class="spectrum-range-item__gain-val">{range.gain.toFixed(1)}</span>
              </div>
              <Show when={ranges().length > 1}>
                <button class="spectrum-range-item__del" onClick={() => deleteRange(i())}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>

      <button class="spectrum-panel__add" onClick={addRange}>+ Add Range</button>

      <footer class="spectrum-panel__footer">
        <button class="btn btn--ghost" onClick={reset}>Reset</button>
        <button class="btn btn--primary" onClick={apply}>Apply</button>
      </footer>
    </div>
  );
}
