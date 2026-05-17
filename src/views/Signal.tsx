/* ============================================================
   views/Signal.tsx — DSP chain (Parametric EQ + Limiter + Bass).
   Porta integral do src/js/views/signal.js (vanilla legacy) pra
   Solid + store/dsp.ts. Layout pixel-a-pixel do handoff HTML.
   ============================================================ */

import { createResource, createSignal, For, onMount, Show } from "solid-js";
import {
  dsp,
  toggleBypass,
  toggleEq,
  toggleLimiter,
  toggleBass,
  setActiveBand,
  setEqBandGain,
  setEqBandType,
  setEqBandMode,
  setEqBandFreq,
  setEqBandQ,
  setEqBandSlope,
  setEqBandSolo,
  setEqBandMute,
  setEqMode,
  setEqGain,
  setLimiterMode,
  setLimiterOvs,
  setLimiterDither,
  setLimiterBoost,
  setLimiterThreshold,
  setLimiterKnee,
  setLimiterLookahead,
  setLimiterAttack,
  setLimiterRelease,
  setLimiterScPreamp,
  setLimiterStereoLink,
  setLimiterGain,
  setLimiterAlr,
  setLimiterAlrAttack,
  setLimiterAlrRelease,
  setBassAmount,
  setBassDrive,
  setBassBlend,
  setBassFreq,
  setBassFloor,
  setBassFloorActive,
  setBassListen,
  setBassLevels,
  applyFullDspState,
  FILTER_TYPES,
  FILTER_MODES,
  SLOPES,
  LIMITER_MODES,
  LIMITER_OVS,
  LIMITER_DITHER,
} from "../store/dsp";
import { normGetState, normSetEnabled } from "../tauri";
import { ParamRow } from "../components/dsp/ParamRow";
import { Fader } from "../components/dsp/Fader";
import { EqCanvas } from "../components/dsp/EqCanvas";
import {
  loadPresets,
  savePresets,
  getActivePresetName,
  setActivePresetName,
  snapshotCurrentDsp,
  applyPresetToStore,
  parseEasyEffects,
  toEasyEffects,
  type DspPreset,
} from "../store/dsp-presets";
import { resetToFlat } from "../store/dsp";

const ENGINE_MODES = ["IIR", "FIR", "FFT", "SPM"] as const;

// Roadmap cards — visual only, sem backend.
interface RoadmapCard {
  icon: string;
  title: string;
  sub: string;
  desc: string;
}

const ROADMAP_DYN: RoadmapCard[] = [
  {
    icon: "lucide:layers",
    title: "Multiband compressor",
    sub: "LSP × 8 · Modern",
    desc: "8 freq bands with independent attack/release. Present in user's EasyEffects presets. Would slot between EQ and Limiter.",
  },
  {
    icon: "lucide:trending-down",
    title: "Compressor",
    sub: "LSP · single band",
    desc: "Single-band downward compressor with sidechain. Lighter than MB-Comp when you only need glue.",
  },
  {
    icon: "lucide:gauge",
    title: "Maximizer",
    sub: "Calf · loudness",
    desc: "Brick-wall maximizer pushing perceived loudness. Tends to fight Limiter — pick one.",
  },
  {
    icon: "lucide:fence",
    title: "Gate",
    sub: "LSP · expander",
    desc: "Closes below threshold. Mostly useful for live recordings with hum & hiss floor.",
  },
];

const ROADMAP_SPACE: RoadmapCard[] = [
  {
    icon: "lucide:headphones",
    title: "Crossfeed",
    sub: "bs2b · Meier",
    desc: "Reduces hard L/R separation on headphones. Subtle, hi-fi-adjacent. Stock GStreamer plugin.",
  },
  {
    icon: "lucide:radio-tower",
    title: "Convolver",
    sub: "zita · IR loader",
    desc: "Loads impulse responses for room/headphone correction or speaker emulation.",
  },
  {
    icon: "lucide:speaker",
    title: "Stereo tools",
    sub: "LSP · M/S width",
    desc: "Mid/Side decomposition, width control, balance, stereo image rotation.",
  },
  {
    icon: "lucide:volume-2",
    title: "Loudness",
    sub: "ISO 226 · Fletcher-Munson",
    desc: "Equal-loudness curve compensation at low listening levels. Different stage from ReplayGain.",
  },
];

// "Flat" e sempre o primeiro chip — reseta pra bands default sem precisar de preset salvo.
const FLAT_PRESET = "Flat";

export default function Signal() {
  // Replay-gain normalize ainda vem do backend via cmd separado.
  const [normEnabled, { mutate: setNormState }] = createResource(async () => {
    try { return await normGetState(); } catch { return false; }
  });

  async function toggleNorm() {
    const next = !normEnabled();
    setNormState(next);
    try { await normSetEnabled(next); } catch {}
  }

  // Sincronizacao backend no mount.
  onMount(() => { applyFullDspState(); });

  // Presets reais (localStorage). Sempre exibe "Flat" como primeiro chip.
  const [presets, setPresets] = createSignal<DspPreset[]>(loadPresets());
  const [activePreset, setActivePreset] = createSignal<string>(getActivePresetName() || FLAT_PRESET);

  function refreshPresets() {
    setPresets(loadPresets());
  }

  function handlePresetClick(name: string) {
    setActivePreset(name);
    setActivePresetName(name);
    if (name === FLAT_PRESET) {
      resetToFlat();
      return;
    }
    const p = presets().find((x) => x.name === name);
    if (p) applyPresetToStore(p);
  }

  function handleSave() {
    const current = activePreset();
    const suggestion = current && current !== FLAT_PRESET ? current : "";
    const name = window.prompt("Nome do preset:", suggestion);
    if (!name) return;
    const list = loadPresets().filter((p) => p.name !== name);
    list.push(snapshotCurrentDsp(name));
    savePresets(list);
    setActivePresetName(name);
    setActivePreset(name);
    refreshPresets();
  }

  function handleRename() {
    const cur = activePreset();
    if (!cur || cur === FLAT_PRESET) return;
    const newName = window.prompt(`Renomear "${cur}" para:`, cur);
    if (!newName || newName === cur) return;
    const list = loadPresets().map((p) => (p.name === cur ? { ...p, name: newName } : p));
    savePresets(list);
    setActivePresetName(newName);
    setActivePreset(newName);
    refreshPresets();
  }

  function handleDelete() {
    const cur = activePreset();
    if (!cur || cur === FLAT_PRESET) return;
    if (!window.confirm(`Apagar preset "${cur}"?`)) return;
    savePresets(loadPresets().filter((p) => p.name !== cur));
    setActivePresetName(FLAT_PRESET);
    setActivePreset(FLAT_PRESET);
    refreshPresets();
  }

  function handleImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const name = file.name.replace(/\.json$/i, "");
        const preset = parseEasyEffects(json, name);
        const list = loadPresets().filter((p) => p.name !== name);
        list.push(preset);
        savePresets(list);
        setActivePresetName(name);
        setActivePreset(name);
        refreshPresets();
        applyPresetToStore(preset);
      } catch (e) {
        console.error("[signal] import falhou:", e);
        window.alert("Import falhou — JSON invalido ou formato nao reconhecido.");
      }
    };
    input.click();
  }

  function handleExport() {
    const snap = snapshotCurrentDsp(activePreset() || "rustify-export");
    const json = toEasyEffects({ eq: snap.eq, limiter: snap.limiter, bass: snap.bass_enhancer });
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${snap.name || "rustify-preset"}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Signal</h1>
          <p class="view__head-hint">DSP chain — Parametric EQ · Limiter · Bass Enhancer</p>
        </div>
        <div class="view__stats">
          <span><b>{dsp.bypass ? "Bypassed" : "Active"}</b></span>
          <span>chain <b>{[dsp.eq.enabled, dsp.limiter.enabled, dsp.bass.enabled].filter(Boolean).length}</b>/3 stages</span>
          <span>bit-perfect except DSP</span>
        </div>
      </header>

      <div class="sig">

        {/* ── Master bypass bar ── */}
        <div class="sig-master-bar">
          <div class="sig-master-bar__meta">
            <h3 class="sig-master-bar__title">Master bypass</h3>
            <span class="sig-master-bar__sub">
              Routes raw stream around the entire chain · <b>{dsp.bypass ? "on" : "off"}</b> currently
            </span>
          </div>
          <button
            class="tog"
            aria-pressed={dsp.bypass ? "true" : "false"}
            onClick={toggleBypass}
            title="Toggle master bypass"
          />
        </div>

        {/* ── Stat tiles ── */}
        <div class="sig-stat-row">
          <StatTile
            label="EQ"
            on={dsp.eq.enabled && !dsp.bypass}
            value={`${dsp.eq.bands.length} bands`}
            sub={`${FILTER_MODES[dsp.eq.bands[dsp.activeBand]?.filterMode ?? 6]} · ${ENGINE_MODES[dsp.eq.mode]} mode`}
          />
          <StatTile
            label="Limiter"
            on={dsp.limiter.enabled && !dsp.bypass}
            value={dsp.limiter.enabled ? `${dsp.limiter.threshold.toFixed(1)} dB` : "off"}
            sub={`${LIMITER_MODES[dsp.limiter.mode]} · lookahead ${dsp.limiter.lookahead.toFixed(1)} ms`}
          />
          <StatTile
            label="Bass"
            on={dsp.bass.enabled && !dsp.bypass}
            value={dsp.bass.enabled ? `${dsp.bass.amount.toFixed(1)} dB` : "off"}
            sub={`scope ${dsp.bass.freq} Hz · floor ${dsp.bass.floor} Hz`}
          />
          <StatTile
            label="Normalize"
            on={!!normEnabled() && !dsp.bypass}
            value={normEnabled() ? "−18 LUFS" : "off"}
            sub="ReplayGain · track"
          />
        </div>

        {/* ── Chain flow ── */}
        <div class="sig-chain">
          <span class="sig-chain__node">Source</span>
          <span class="sig-chain__arrow">→</span>
          <span class="sig-chain__node">Decode</span>
          <span class="sig-chain__arrow">→</span>
          <span class="sig-chain__node">audioconvert</span>
          <span class="sig-chain__arrow">→</span>
          <span class="sig-chain__node" data-on={dsp.eq.enabled && !dsp.bypass ? "true" : "false"}>
            <span class="dot" />LSP Para EQ × 16
          </span>
          <span class="sig-chain__arrow">→</span>
          <span class="sig-chain__node" data-on={!!normEnabled() && !dsp.bypass ? "true" : "false"}>
            <span class="dot" />norm_gain
          </span>
          <span class="sig-chain__arrow">→</span>
          <span class="sig-chain__node" data-on={dsp.limiter.enabled && !dsp.bypass ? "true" : "false"}>
            <span class="dot" />LSP Limiter
          </span>
          <span class="sig-chain__arrow">→</span>
          <span class="sig-chain__node" data-on={dsp.bass.enabled && !dsp.bypass ? "true" : "false"}>
            <span class="dot" />Calf Bass Enh.
          </span>
          <span class="sig-chain__arrow">→</span>
          <span class="sig-chain__node">PipeWire</span>
        </div>

        {/* ── Presets ── */}
        <div class="sig-presets">
          <div class="sig-preset-chips">
            <span class="sig-preset-chips__label">Presets</span>
            <button
              class="sig-pre"
              aria-pressed={activePreset() === FLAT_PRESET ? "true" : undefined}
              onClick={() => handlePresetClick(FLAT_PRESET)}
              title="Reseta todas as bandas pra 0 dB"
            >
              {FLAT_PRESET}
            </button>
            <For each={presets()}>{(p) => (
              <button
                class="sig-pre"
                aria-pressed={activePreset() === p.name ? "true" : undefined}
                onClick={() => handlePresetClick(p.name)}
                title={`Aplica preset "${p.name}"`}
              >
                {p.name}
              </button>
            )}</For>
            <Show when={presets().length === 0}>
              <span class="sig-preset-chips__empty">
                Nenhum preset salvo — use Save ou Import .json
              </span>
            </Show>
          </div>
          <div class="sig-preset-actions">
            <button class="sig-pbtn" onClick={handleSave} title="Salva estado atual como novo preset">
              {/* @ts-ignore */}
              <iconify-icon icon="lucide:save" noobserver />Save
            </button>
            <button
              class="sig-pbtn"
              onClick={handleRename}
              disabled={!activePreset() || activePreset() === FLAT_PRESET}
              title="Renomeia preset selecionado"
            >
              {/* @ts-ignore */}
              <iconify-icon icon="lucide:pencil" noobserver />Rename
            </button>
            <button
              class="sig-pbtn"
              onClick={handleDelete}
              disabled={!activePreset() || activePreset() === FLAT_PRESET}
              title="Apaga preset selecionado"
            >
              {/* @ts-ignore */}
              <iconify-icon icon="lucide:trash-2" noobserver />Delete
            </button>
            <button class="sig-pbtn" onClick={handleImport} title="Importa preset EasyEffects (.json)">
              {/* @ts-ignore */}
              <iconify-icon icon="lucide:upload" noobserver />Import .json
            </button>
            <button class="sig-pbtn" onClick={handleExport} title="Exporta estado atual como JSON EasyEffects">
              {/* @ts-ignore */}
              <iconify-icon icon="lucide:download" noobserver />Export
            </button>
          </div>
        </div>

        {/* ── Parametric EQ panel ── */}
        <div class="sig-panel">
          <div class="sig-panel__head">
            <h3 class="sig-panel__title">Parametric Equalizer</h3>
            <span class="sig-panel__badge">LSP × 16 · Stereo</span>
            <span class="sig-panel__meta">
              mode <b>{ENGINE_MODES[dsp.eq.mode]}</b> · gain <b>{dsp.eq.input_gain.toFixed(1)}</b> / <b>{dsp.eq.output_gain.toFixed(1)}</b> dB
            </span>
            <button
              class="tog tog--blue"
              aria-pressed={dsp.eq.enabled ? "true" : "false"}
              onClick={toggleEq}
              title="Toggle EQ"
              style={{ "margin-left": "10px" }}
            />
          </div>
          <div class="sig-panel__body">

            <EqCanvas bands={dsp.eq.bands} activeBand={dsp.activeBand} />
            <div class="eq-xaxis">
              <span>20</span><span>50</span><span>100</span><span>200</span><span>500</span>
              <span>1k</span><span>2k</span><span>5k</span><span>10k</span><span>20k</span>
            </div>

            <div class="faders">
              <For each={dsp.eq.bands}>{(band, i) => (
                <Fader
                  bandIdx={i()}
                  freq={band.freq}
                  gainDb={band.gain_db}
                  active={dsp.activeBand === i()}
                  onActivate={() => setActiveBand(i())}
                  onChange={(db) => setEqBandGain(i(), db)}
                />
              )}</For>
            </div>

            <BandDetail />

            {/* EQ footer: engine mode + I/O gain */}
            <div class="eq-footer">
              <div>
                <div class="mode-group__label">Engine mode</div>
                <div class="mode-group">
                  <For each={ENGINE_MODES}>{(name, i) => (
                    <button
                      aria-pressed={dsp.eq.mode === i() ? "true" : undefined}
                      onClick={() => setEqMode(i())}
                    >
                      {name}
                    </button>
                  )}</For>
                </div>
              </div>
              <div class="eq-gains">
                <ParamRow
                  label="Input gain"
                  value={dsp.eq.input_gain}
                  min={-12}
                  max={12}
                  unit="dB"
                  onInput={(v) => setEqGain(v, dsp.eq.output_gain)}
                />
                <ParamRow
                  label="Output gain"
                  value={dsp.eq.output_gain}
                  min={-12}
                  max={12}
                  unit="dB"
                  onInput={(v) => setEqGain(dsp.eq.input_gain, v)}
                />
              </div>
            </div>

          </div>
        </div>

        {/* ── Limiter panel ── */}
        <div class="sig-panel">
          <div class="sig-panel__head">
            <h3 class="sig-panel__title">Limiter</h3>
            <span class="sig-panel__badge">LSP · Stereo</span>
            <span class="sig-panel__meta">
              threshold <b>{dsp.limiter.threshold.toFixed(1)}</b> dB · stereo-link <b>{dsp.limiter.stereo_link.toFixed(0)}</b>%
            </span>
            <button
              class="tog tog--blue"
              aria-pressed={dsp.limiter.enabled ? "true" : "false"}
              onClick={toggleLimiter}
              title="Toggle Limiter"
              style={{ "margin-left": "10px" }}
            />
          </div>
          <div class="sig-panel__body">

            <div class="lim-selects">
              <Select
                label="Mode"
                options={LIMITER_MODES}
                value={dsp.limiter.mode}
                onChange={setLimiterMode}
              />
              <Select
                label="Oversampling"
                options={LIMITER_OVS}
                value={dsp.limiter.ovs}
                onChange={setLimiterOvs}
              />
              <Select
                label="Dither"
                options={LIMITER_DITHER}
                value={dsp.limiter.dither}
                onChange={setLimiterDither}
              />
              <div class="lim-boost">
                <span class="lim-boost__label">Boost</span>
                <button
                  class="tog"
                  aria-pressed={dsp.limiter.boost ? "true" : "false"}
                  onClick={() => setLimiterBoost(!dsp.limiter.boost)}
                  title="Toggle boost"
                />
              </div>
            </div>

            <div class="params">
              <ParamRow label="Threshold" value={dsp.limiter.threshold} min={-60} max={0} unit="dB" decimals={1} onInput={setLimiterThreshold} />
              <ParamRow label="Knee" value={dsp.limiter.knee} min={0} max={12} unit="dB" decimals={1} onInput={setLimiterKnee} />
              <ParamRow label="Lookahead" value={dsp.limiter.lookahead} min={0} max={20} unit="ms" decimals={1} onInput={setLimiterLookahead} />
              <ParamRow label="Attack" value={dsp.limiter.attack} min={0.1} max={20} unit="ms" decimals={1} onInput={setLimiterAttack} />
              <ParamRow label="Release" value={dsp.limiter.release} min={0.1} max={20} unit="ms" decimals={1} onInput={setLimiterRelease} />
              <ParamRow label="SC PreAmp" value={dsp.limiter.sc_preamp} min={-10} max={10} unit="dB" decimals={1} onInput={setLimiterScPreamp} />
              <ParamRow label="Stereo link" value={dsp.limiter.stereo_link} min={0} max={100} unit="%" decimals={0} onInput={setLimiterStereoLink} />
              <ParamRow label="Input gain" value={dsp.limiter.input_gain} min={-12} max={12} unit="dB" decimals={1} onInput={(v) => setLimiterGain(v, dsp.limiter.output_gain)} />
              <ParamRow label="Output gain" value={dsp.limiter.output_gain} min={-12} max={12} unit="dB" decimals={1} onInput={(v) => setLimiterGain(dsp.limiter.input_gain, v)} />
            </div>

            <div class="alr">
              <div class="alr__head">
                <span class="alr__title">Auto-leveling release</span>
                <span class="alr__hint">stabilizes attack-release sensitivity over time</span>
                <button
                  class="tog"
                  aria-pressed={dsp.limiter.alr ? "true" : "false"}
                  onClick={() => setLimiterAlr(!dsp.limiter.alr)}
                  title="Toggle ALR"
                  style={{ "margin-left": "auto" }}
                />
              </div>
              <div class="params">
                <ParamRow label="ALR attack" value={dsp.limiter.alr_attack} min={0.1} max={200} unit="ms" decimals={1} onInput={setLimiterAlrAttack} />
                <ParamRow label="ALR release" value={dsp.limiter.alr_release} min={1} max={1000} unit="ms" decimals={0} onInput={setLimiterAlrRelease} />
              </div>
            </div>

          </div>
        </div>

        {/* ── Bass Enhancer panel ── */}
        <div class="sig-panel">
          <div class="sig-panel__head">
            <h3 class="sig-panel__title">Bass Enhancer</h3>
            <span class="sig-panel__badge">Calf</span>
            <span class="sig-panel__meta">
              amount <b>{dsp.bass.amount.toFixed(1)}</b> dB · scope <b>{dsp.bass.freq}</b> Hz
            </span>
            <button
              class="tog"
              aria-pressed={dsp.bass.enabled ? "true" : "false"}
              onClick={toggleBass}
              title="Toggle Bass Enhancer"
              style={{ "margin-left": "10px" }}
            />
          </div>
          <div class="sig-panel__body">

            <div class="bass-toggles">
              <div class="bass-toggle">
                <span class="bass-toggle__label">Listen</span>
                <button
                  class="tog"
                  aria-pressed={dsp.bass.listen ? "true" : "false"}
                  onClick={() => setBassListen(!dsp.bass.listen)}
                  title="Listen to bass-only signal"
                />
              </div>
              <div class="bass-toggle">
                <span class="bass-toggle__label">Floor</span>
                <button
                  class="tog"
                  aria-pressed={dsp.bass.floor_active ? "true" : "false"}
                  onClick={() => setBassFloorActive(!dsp.bass.floor_active)}
                  title="Enable floor filter"
                />
              </div>
            </div>

            <div class="params">
              <ParamRow label="Amount" value={dsp.bass.amount} min={0} max={12} unit="dB" decimals={1} onInput={setBassAmount} />
              <ParamRow label="Harmonics" value={dsp.bass.drive} min={0} max={10} unit="" decimals={1} onInput={setBassDrive} />
              <ParamRow label="Blend" value={dsp.bass.blend} min={-1} max={1} unit="" decimals={2} onInput={setBassBlend} />
              <ParamRow label="Scope" value={dsp.bass.freq} min={20} max={500} unit="Hz" decimals={0} onInput={setBassFreq} />
              <ParamRow label="Floor" value={dsp.bass.floor} min={20} max={200} unit="Hz" decimals={0} onInput={setBassFloor} />
              <ParamRow label="Input gain" value={dsp.bass.input_gain} min={-12} max={12} unit="dB" decimals={1} onInput={(v) => setBassLevels(v, dsp.bass.output_gain)} />
              <ParamRow label="Output gain" value={dsp.bass.output_gain} min={-12} max={12} unit="dB" decimals={1} onInput={(v) => setBassLevels(dsp.bass.input_gain, v)} />
            </div>

          </div>
        </div>

        {/* ── Roadmap panel (visual only, sem backend) ── */}
        <div class="sig-panel">
          <div class="sig-panel__head">
            <h3 class="sig-panel__title">Roadmap</h3>
            <span class="sig-panel__badge">not wired</span>
            <span class="sig-panel__meta">
              design sketches for future GStreamer / LV2 stages — none of these live in dsp.rs today
            </span>
          </div>
          <div class="sig-panel__body">

            <div class="sig-subhead">
              <span class="sig-subhead__title">Dynamics &amp; level</span>
              <span class="sig-subhead__hint">candidates from EasyEffects preset imports</span>
            </div>
            <div class="plug-rack" style={{ "margin-bottom": "18px" }}>
              <For each={ROADMAP_DYN}>{(card) => <RoadmapCardEl card={card} />}</For>
            </div>

            <div class="sig-subhead">
              <span class="sig-subhead__title">Spatial &amp; tonal</span>
              <span class="sig-subhead__hint">headphone-focused candidates</span>
            </div>
            <div class="plug-rack" style={{ "margin-bottom": "18px" }}>
              <For each={ROADMAP_SPACE}>{(card) => <RoadmapCardEl card={card} />}</For>
            </div>

          </div>
        </div>

      </div>
    </article>
  );
}

// ── Sub-componentes ───────────────────────────────────────────

function StatTile(props: { label: string; value: string; sub: string; on: boolean }) {
  return (
    <div class="sig-stat" data-on={props.on ? "true" : "false"}>
      <div class="sig-stat__head">
        <span class="sig-stat__label">{props.label}</span>
        <span class="sig-stat__dot" />
      </div>
      <span class="sig-stat__value">{props.value}</span>
      <span class="sig-stat__sub">{props.sub}</span>
    </div>
  );
}

function Select<T extends readonly string[]>(props: {
  label: string;
  options: T;
  value: number;
  onChange: (idx: number) => void;
}) {
  return (
    <label class="select-control">
      <span class="select-control__label">{props.label}</span>
      <select
        value={props.value}
        onChange={(e) => props.onChange(Number((e.currentTarget as HTMLSelectElement).value))}
      >
        <For each={props.options}>{(opt, i) => (
          <option value={i()}>{opt}</option>
        )}</For>
      </select>
    </label>
  );
}

function BandDetail() {
  const band = () => dsp.eq.bands[dsp.activeBand];

  function onFreqInput(e: Event) {
    const raw = parseFloat((e.currentTarget as HTMLInputElement).value);
    if (!isNaN(raw)) setEqBandFreq(dsp.activeBand, raw);
  }

  function onQInput(e: Event) {
    const raw = parseFloat((e.currentTarget as HTMLInputElement).value);
    if (!isNaN(raw)) setEqBandQ(dsp.activeBand, raw);
  }

  return (
    <div class="band-detail">
      <div class="band-detail__ctx">
        <span class="band-detail__title">Band {String(dsp.activeBand + 1).padStart(2, "0")}</span>
        <span class="band-detail__ctx-row">
          <input
            class="band-detail__freq"
            type="number"
            min={10}
            max={24000}
            step={1}
            value={band().freq}
            onChange={onFreqInput}
            onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
            title="Frequencia central (Hz). LSP Para EQ aceita 10..24000."
          />
          <span class="band-detail__unit"> Hz</span>
          {" · "}{FILTER_TYPES[band().type]} · {FILTER_MODES[band().filterMode]}
        </span>
      </div>
      <div class="band-detail__ctrls">
        <Select
          label="Type"
          options={FILTER_TYPES}
          value={band().type}
          onChange={(v) => setEqBandType(dsp.activeBand, v)}
        />
        <Select
          label="Mode"
          options={FILTER_MODES}
          value={band().filterMode}
          onChange={(v) => setEqBandMode(dsp.activeBand, v)}
        />
        <Select
          label="Slope"
          options={SLOPES}
          value={band().slope}
          onChange={(v) => setEqBandSlope(dsp.activeBand, v)}
        />
        <label class="band-detail__q">
          Q:
          <input
            class="band-detail__q-input"
            type="number"
            min={0.1}
            max={36}
            step={0.1}
            value={band().q}
            onChange={onQInput}
            onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
            title="Fator de qualidade (largura do filtro). 0.1 = bem largo, 36 = quase ressonante."
          />
        </label>
      </div>
      <div class="band-detail__toggles">
        <button
          class="sm-toggle"
          data-kind="solo"
          data-on={band().solo ? "true" : undefined}
          onClick={() => setEqBandSolo(dsp.activeBand, !band().solo)}
          title="Solo"
        >
          S
        </button>
        <button
          class="sm-toggle"
          data-kind="mute"
          data-on={band().mute ? "true" : undefined}
          onClick={() => setEqBandMute(dsp.activeBand, !band().mute)}
          title="Mute"
        >
          M
        </button>
      </div>
    </div>
  );
}

function RoadmapCardEl(props: { card: RoadmapCard }) {
  // TODO: backend support pending — toggle e visual only.
  const [on, setOn] = createSignal(false);
  return (
    <div class="plug-card" data-on={on() ? "true" : "false"}>
      <button class="plug-card__add" title="Add to chain (not wired)" onClick={() => setOn(!on())}>
        {/* @ts-ignore */}
        <iconify-icon icon="lucide:plus" noobserver />
      </button>
      <div class="plug-card__head">
        <span class="plug-card__icon">
          {/* @ts-ignore */}
          <iconify-icon icon={props.card.icon} noobserver />
        </span>
        <div class="plug-card__title-wrap">
          <h4 class="plug-card__title">{props.card.title}</h4>
          <span class="plug-card__sub">{props.card.sub}</span>
        </div>
      </div>
      <p class="plug-card__desc">{props.card.desc}</p>
      <div class="plug-card__footer">
        <span class="plug-card__stat">{on() ? "in chain · last stage" : "not in chain"}</span>
        <button
          class="tog"
          aria-pressed={on() ? "true" : "false"}
          onClick={() => setOn(!on())}
          title="Toggle (visual only)"
        />
      </div>
    </div>
  );
}
