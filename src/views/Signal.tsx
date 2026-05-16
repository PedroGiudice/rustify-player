/* ============================================================
   views/Signal.tsx — DSP overview (EQ + Limiter + Bass + Norm).

   This is the redesigned overview surface. The detailed
   per-band EQ editor lives in the existing
   components/SpectrumRangesPanel.tsx — wire it in when ready
   (see <SpectrumRangesPanel /> slot below, currently commented).
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import { dsp, toggleBypass, toggleEq, toggleLimiter, toggleBass } from "../store/dsp";
import { normGetState, normSetEnabled } from "../tauri";
import { Icon, ICONS } from "../components/Icon";

export default function Signal() {
  const [normEnabled, { mutate: setNormState }] = createResource(async () => {
    try { return await normGetState(); } catch { return false; }
  });

  async function toggleNorm() {
    const next = !normEnabled();
    setNormState(next);
    try { await normSetEnabled(next); } catch {}
  }

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Signal</h1>
          <p class="view__head-hint">DSP chain · EQ · Limiter · Bass · Normalization</p>
        </div>
        <div class="view__stats">
          <span><b>{dsp.bypass ? "BYPASSED" : "ACTIVE"}</b></span>
          <span>chain · {[dsp.eq.enabled, dsp.limiter.enabled, dsp.bass.enabled].filter(Boolean).length}/3 stages</span>
        </div>
      </header>

      <div class="view__body">
        {/* Top-level master bypass */}
        <section class="panel">
          <div class="panel__head">
            <div>
              <h3 class="panel__title">Master bypass</h3>
              <p class="panel__hint">Roteia o stream cru, ignorando EQ/Limiter/Bass.</p>
            </div>
            <button
              class="toggle"
              aria-pressed={dsp.bypass ? "true" : "false"}
              onClick={toggleBypass}
            />
          </div>
        </section>

        {/* Stat tiles */}
        <section>
          <div class="section__head">
            <h2 class="section__title">Chain status</h2>
          </div>
          <div class="stat-grid">
            <StatTile label="EQ" value={dsp.eq.enabled ? "ON" : "OFF"} sub={`${dsp.eq.bands.length} bands · mode ${dsp.eq.mode}`} />
            <StatTile label="LIMITER" value={dsp.limiter.enabled ? "ON" : "OFF"} sub={`thr ${dsp.limiter.threshold.toFixed(1)} dB`} />
            <StatTile label="BASS"    value={dsp.bass.enabled ? "ON" : "OFF"}    sub={`${dsp.bass.amount.toFixed(0)}% @ ${dsp.bass.freq} Hz`} />
            <StatTile label="NORMALIZE" value={normEnabled() ? "ON" : "OFF"} sub="ReplayGain track" />
          </div>
        </section>

        {/* Stage toggles */}
        <section class="panel">
          <div class="panel__head">
            <h3 class="panel__title">Stages</h3>
          </div>
          <ToggleRow
            label="Equalizer"
            hint={`${dsp.eq.bands.length}-band parametric EQ`}
            enabled={dsp.eq.enabled}
            onToggle={toggleEq}
          />
          <ToggleRow
            label="Limiter"
            hint="Brick-wall protection antes da saída"
            enabled={dsp.limiter.enabled}
            onToggle={toggleLimiter}
          />
          <ToggleRow
            label="Bass enhancer"
            hint={`Saturação harmônica abaixo de ${dsp.bass.freq} Hz`}
            enabled={dsp.bass.enabled}
            onToggle={toggleBass}
          />
          <ToggleRow
            label="Loudness normalization"
            hint="ReplayGain target −18 LUFS"
            enabled={!!normEnabled()}
            onToggle={toggleNorm}
          />
        </section>

        {/* EQ editor slot — wire to the existing SpectrumRangesPanel */}
        <section class="panel">
          <div class="panel__head">
            <div>
              <h3 class="panel__title">EQ · {dsp.eq.bands.length} bands</h3>
              <p class="panel__hint">Editor de bandas individual.</p>
            </div>
            <span class="mono" style={{ "font-size": "11px", color: "var(--fg-5)" }}>
              mode <b>{dsp.eq.mode}</b> · gain {dsp.eq.input_gain.toFixed(1)}/{dsp.eq.output_gain.toFixed(1)} dB
            </span>
          </div>
          {/*
            <SpectrumRangesPanel />   ← drop the existing per-band editor here
          */}
          <p class="empty-state__hint" style={{ "text-align": "center", padding: "32px" }}>
            Editor de bandas: importe <code class="mono">SpectrumRangesPanel</code> e renderize aqui.
          </p>
        </section>
      </div>
    </article>
  );
}

function StatTile(props: { label: string; value: string; sub: string }) {
  return (
    <div class="stat-tile">
      <span class="stat-tile__label">{props.label}</span>
      <span class="stat-tile__value">{props.value}</span>
      <span class="stat-tile__sub">{props.sub}</span>
    </div>
  );
}

function ToggleRow(props: { label: string; hint?: string; enabled: boolean; onToggle: () => void }) {
  return (
    <div class="toggle-row">
      <div>
        <div class="toggle-row__label">{props.label}</div>
        <Show when={props.hint}><div class="toggle-row__hint">{props.hint}</div></Show>
      </div>
      <button
        class="toggle"
        aria-pressed={props.enabled ? "true" : "false"}
        onClick={props.onToggle}
        type="button"
      />
    </div>
  );
}
