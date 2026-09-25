/* ============================================================
   views/Signal.tsx — DSP chain (Parametric EQ + Limiter + Bass).
   Porta integral do src/js/views/signal.js (vanilla legacy) pra
   Solid + store/dsp.ts. Layout pixel-a-pixel do handoff HTML.
   ============================================================ */

import { createSignal, For, onMount, Show } from "solid-js";
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
import { tweaks } from "../store/tweaks";
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
  FLAT_PRESET,
  DEFAULT_PRESET,
  BUILTIN_PRESETS,
  resolveActivePreset,
  presetNameError,
  importPresetName,
  type DspPreset,
} from "../store/dsp-presets";
import { resetToFlat, resetToDefault } from "../store/dsp";

const ENGINE_MODES = ["IIR", "FIR", "FFT", "SPM"] as const;

export default function Signal() {
  // Loudness normalization: fonte unica de verdade e o store de tweaks
  // (tweaks().loudnessNorm / loudnessTarget). A Signal so EXIBE — o
  // controle on/off + target vive no painel Tweaks. Antes a Signal tinha
  // estado IPC proprio (normGetState) que ficava stale ao mexer no Tweaks.

  // Sincronizacao backend no mount.
  onMount(() => { applyFullDspState(); });

  // Presets reais (localStorage). "Flat" e "Padrão" são sempre os primeiros
  // chips (embutidos, sem registro salvo).
  const [presets, setPresets] = createSignal<DspPreset[]>(loadPresets());
  const [activePreset, setActivePreset] = createSignal<string>(
    resolveActivePreset(getActivePresetName(), dsp.eq.bands),
  );

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
    if (name === DEFAULT_PRESET) {
      resetToDefault();
      return;
    }
    const p = presets().find((x) => x.name === name);
    if (p) applyPresetToStore(p);
  }

  function handleSave() {
    const current = activePreset();
    const suggestion = current && !BUILTIN_PRESETS.includes(current) ? current : "";
    const raw = window.prompt("Nome do preset:", suggestion);
    if (!raw?.trim()) return;
    // Salvar com o nome de um preset existente sobrescreve (é o fluxo de
    // "salvar alterações"); só nome vazio ou embutido é recusado.
    const err = presetNameError(raw, []);
    if (err) { window.alert(err); return; }
    const name = raw.trim();
    const list = loadPresets().filter((p) => p.name !== name);
    list.push(snapshotCurrentDsp(name));
    savePresets(list);
    setActivePresetName(name);
    setActivePreset(name);
    refreshPresets();
  }

  function handleRename() {
    const cur = activePreset();
    if (!cur || BUILTIN_PRESETS.includes(cur)) return;
    const raw = window.prompt(`Renomear "${cur}" para:`, cur);
    if (!raw?.trim()) return;
    const err = presetNameError(raw, loadPresets().map((p) => p.name), cur);
    if (err) { window.alert(err); return; }
    const newName = raw.trim();
    if (newName === cur) return;
    const list = loadPresets().map((p) => (p.name === cur ? { ...p, name: newName } : p));
    savePresets(list);
    setActivePresetName(newName);
    setActivePreset(newName);
    refreshPresets();
  }

  function handleDelete() {
    const cur = activePreset();
    if (!cur || BUILTIN_PRESETS.includes(cur)) return;
    if (!window.confirm(`Apagar preset "${cur}"?`)) return;
    savePresets(loadPresets().filter((p) => p.name !== cur));
    // Apagar o registro não muda o que toca: só marca Flat/Padrão se a
    // curva atual for uma delas.
    const next = resolveActivePreset("", dsp.eq.bands);
    setActivePresetName(next);
    setActivePreset(next);
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
        const name = importPresetName(file.name.replace(/\.json$/i, ""));
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

  // Estado real de cada estágio. O master bypass desliga EQ, Limiter e Bass
  // (set_bypassed em dsp.rs), mas NÃO o norm_gain: a normalização só segue
  // o toggle do Tweaks.
  const eqLive = () => dsp.eq.enabled && !dsp.bypass;
  const limLive = () => dsp.limiter.enabled && !dsp.bypass;
  const bassLive = () => dsp.bass.enabled && !dsp.bypass;
  const normLive = () => tweaks().loudnessNorm;
  /** Rótulo de um estágio que não processa: bypass vence o "off" próprio. */
  const offLabel = () => (dsp.bypass ? "bypassed" : "off");

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
          <span>chain <b>{[eqLive(), normLive(), limLive(), bassLive()].filter(Boolean).length}</b>/4 stages</span>
          <span>bit-perfect except DSP</span>
        </div>
      </header>

      <div class="sig">

        {/* ── Master (bypass) bar ──
            Mesma polaridade dos toggles dos estágios: ligado = processando.
            O bypass não alcança a normalização (norm_gain), que é do Tweaks. */}
        <div class="sig-master-bar">
          <div class="sig-master-bar__meta">
            <h3 class="sig-master-bar__title">DSP chain</h3>
            <span class="sig-master-bar__sub">
              EQ · Limiter · Bass <b>{dsp.bypass ? "bypassed" : "processing"}</b> · normalization is set in Tweaks
            </span>
          </div>
          <button
            class="tog"
            aria-pressed={dsp.bypass ? "false" : "true"}
            aria-label="DSP chain (EQ, Limiter, Bass)"
            onClick={toggleBypass}
            title={dsp.bypass ? "Turn EQ, Limiter and Bass back on" : "Bypass EQ, Limiter and Bass"}
          />
        </div>

        {/* ── Stat tiles ── */}
        <div class="sig-stat-row">
          <StatTile
            label="EQ"
            on={eqLive()}
            value={eqLive() ? `${dsp.eq.bands.length} bands` : offLabel()}
            sub={`${FILTER_MODES[dsp.eq.bands[dsp.activeBand]?.filterMode ?? 6]} · ${ENGINE_MODES[dsp.eq.mode]} mode`}
          />
          <StatTile
            label="Limiter"
            on={limLive()}
            value={limLive() ? `${dsp.limiter.threshold.toFixed(1)} dB` : offLabel()}
            sub={`${LIMITER_MODES[dsp.limiter.mode]} · lookahead ${dsp.limiter.lookahead.toFixed(1)} ms`}
          />
          <StatTile
            label="Bass"
            on={bassLive()}
            value={bassLive() ? `${dsp.bass.amount.toFixed(1)} dB` : offLabel()}
            sub={`scope ${dsp.bass.freq.toFixed(0)} Hz · floor ${dsp.bass.floor.toFixed(0)} Hz`}
          />
          <StatTile
            label="Normalize"
            on={normLive()}
            value={normLive() ? `${tweaks().loudnessTarget.toFixed(1)} LUFS` : "off"}
            sub="LUFS · per-track"
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
          <span class="sig-chain__node" data-on={eqLive() ? "true" : "false"}>
            <span class="dot" />LSP Para EQ × 16
          </span>
          <span class="sig-chain__arrow">→</span>
          <span class="sig-chain__node" data-on={normLive() ? "true" : "false"}>
            <span class="dot" />norm_gain
          </span>
          <span class="sig-chain__arrow">→</span>
          <span class="sig-chain__node" data-on={limLive() ? "true" : "false"}>
            <span class="dot" />LSP Limiter
          </span>
          <span class="sig-chain__arrow">→</span>
          <span class="sig-chain__node" data-on={bassLive() ? "true" : "false"}>
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
            <button
              class="sig-pre"
              aria-pressed={activePreset() === DEFAULT_PRESET ? "true" : undefined}
              onClick={() => handlePresetClick(DEFAULT_PRESET)}
              title="Aplica a curva padrão do Rustify"
            >
              {DEFAULT_PRESET}
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
              disabled={!activePreset() || BUILTIN_PRESETS.includes(activePreset())}
              title="Renomeia preset selecionado"
            >
              {/* @ts-ignore */}
              <iconify-icon icon="lucide:pencil" noobserver />Rename
            </button>
            <button
              class="sig-pbtn"
              onClick={handleDelete}
              disabled={!activePreset() || BUILTIN_PRESETS.includes(activePreset())}
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
        <div class="sig-panel" data-live={eqLive() ? "true" : "false"}>
          <div class="sig-panel__head">
            <h3 class="sig-panel__title">Parametric Equalizer</h3>
            <span class="sig-panel__badge">LSP × 16 · Stereo</span>
            <Show when={!eqLive()}><span class="sig-panel__state">{offLabel()}</span></Show>
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
        <div class="sig-panel" data-live={limLive() ? "true" : "false"}>
          <div class="sig-panel__head">
            <h3 class="sig-panel__title">Limiter</h3>
            <span class="sig-panel__badge">LSP · Stereo</span>
            <Show when={!limLive()}><span class="sig-panel__state">{offLabel()}</span></Show>
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
        <div class="sig-panel" data-live={bassLive() ? "true" : "false"}>
          <div class="sig-panel__head">
            <h3 class="sig-panel__title">Bass Enhancer</h3>
            <span class="sig-panel__badge">Calf</span>
            <Show when={!bassLive()}><span class="sig-panel__state">{offLabel()}</span></Show>
            <span class="sig-panel__meta">
              amount <b>{dsp.bass.amount.toFixed(1)}</b> dB · scope <b>{dsp.bass.freq.toFixed(0)}</b> Hz
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
