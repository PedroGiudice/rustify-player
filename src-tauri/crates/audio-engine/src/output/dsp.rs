//! DSP filter bin: LV2 plugins wired as a GStreamer audio-filter.
//!
//! Creates a GstBin with:
//!   audioconvert -> LSP Para EQ x16 Stereo -> norm_gain (volume) -> LSP Limiter Stereo
//!     -> Calf Bass Enhancer -> audioconvert
//!
//! The `norm_gain` stage is a stock GStreamer `volume` element used by the
//! loudness normalization feature: per-track gain offset is applied here so
//! the limiter downstream still catches any overshoots and the EQ upstream
//! processes flat audio. When normalization is disabled or the track has
//! no measured LUFS the stage is set to unity (1.0), making it a no-op.
//!
//! The bin is set as the `audio-filter` property on `playbin` inside `gst_play::Play`.
//!
//! # Enum properties
//!
//! LV2 plugins expose enum parameters (filter type, mode) as GLib Enum types
//! with custom `GType`s. Setting them via `set_property("prop", i32_value)`
//! panics because GLib expects the exact enum `GType`, not a plain `i32`.
//!
//! We use [`GObjectExtManualGst::set_property_from_str`] instead, which
//! resolves the string nick (e.g. `"Bell"`) to the correct typed value via
//! `gst_util_set_object_arg`. This is the only safe path for LV2 enum props.
//!
//! # Plugin bypass
//!
//! All three plugins have native bypass/enable properties:
//! - LSP EQ / Limiter: `enabled` (bool, default **false** = passthrough)
//! - Calf Bass Enhancer: `bypass` (bool, default false = active)
//!
//! Global bypass toggles these properties instead of flattening parameters,
//! achieving true signal passthrough with zero processing overhead.

use gstreamer as gst;
use gstreamer::prelude::*;

use crate::error::OutputError;

/// GStreamer element factory names (confirmed via `gst-inspect-1.0`).
const EQ_ELEMENT: &str = "lsp-plug-in-plugins-lv2-para-equalizer-x16-stereo";
const LIMITER_ELEMENT: &str = "lsp-plug-in-plugins-lv2-limiter-stereo";
const BASS_ENHANCER_ELEMENT: &str = "calf-sourceforge-net-plugins-BassEnhancer";

// ---------------------------------------------------------------------------
// Enum nick tables — map numeric IDs (used by the Tauri IPC layer) to the
// GLib enum nick strings expected by `set_property_from_str`.
// ---------------------------------------------------------------------------

/// LSP Para EQ filter types for `ft-N` properties.
const EQ_FILTER_TYPE_NICKS: &[&str] = &[
    "Off",         // 0
    "Bell",        // 1
    "Hi-pass",     // 2
    "Hi-shelf",    // 3
    "Lo-pass",     // 4
    "Lo-shelf",    // 5
    "Notch",       // 6
    "Resonance",   // 7
    "Allpass",     // 8
    "Bandpass",    // 9
    "Ladder-pass", // 10
    "Ladder-rej",  // 11
];

/// LSP Para EQ filter modes for `fm-N` properties.
const EQ_FILTER_MODE_NICKS: &[&str] = &[
    "RLC (BT)", // 0
    "RLC (MT)", // 1
    "BWC (BT)", // 2
    "BWC (MT)", // 3
    "LRX (BT)", // 4
    "LRX (MT)", // 5
    "APO (DR)", // 6
];

/// LSP Para EQ slope values for `s-N` properties.
const EQ_SLOPE_NICKS: &[&str] = &[
    "x1", // 0
    "x2", // 1
    "x3", // 2
    "x4", // 3
];

/// LSP Para EQ operating modes.
const EQ_MODE_NICKS: &[&str] = &[
    "IIR", // 0
    "FIR", // 1
    "FFT", // 2
    "SPM", // 3
];

/// LSP Limiter operating modes.
const LIMITER_MODE_NICKS: &[&str] = &[
    "Herm Thin", // 0
    "Herm Wide", // 1
    "Herm Tail", // 2
    "Herm Duck", // 3
    "Exp Thin",  // 4
    "Exp Wide",  // 5
    "Exp Tail",  // 6
    "Exp Duck",  // 7
];

/// LSP Limiter oversampling modes.
const LIMITER_OVS_NICKS: &[&str] = &[
    "None",             // 0
    "Half x2/16 bit",   // 1
    "Half x2/24 bit",   // 2
    "Half x3/16 bit",   // 3
    "Half x3/24 bit",   // 4
    "Half x4/16 bit",   // 5
    "Half x4/24 bit",   // 6
    "Half x6/16 bit",   // 7
    "Half x6/24 bit",   // 8
    "Half x8/16 bit",   // 9
    "Half x8/24 bit",   // 10
    "Full x2/16 bit",   // 11
    "Full x2/24 bit",   // 12
    "Full x3/16 bit",   // 13
    "Full x3/24 bit",   // 14
    "Full x4/16 bit",   // 15
    "Full x4/24 bit",   // 16
    "Full x6/16 bit",   // 17
    "Full x6/24 bit",   // 18
    "Full x8/16 bit",   // 19
    "Full x8/24 bit",   // 20
];

/// LSP Limiter dithering modes.
const LIMITER_DITHER_NICKS: &[&str] = &[
    "None",  // 0
    "7bit",  // 1
    "8bit",  // 2
    "11bit", // 3
    "12bit", // 4
];

/// Look up the nick string for a numeric enum value.
/// Returns `None` if `value` is out of range.
fn enum_nick(table: &[&'static str], value: i32) -> Option<&'static str> {
    usize::try_from(value)
        .ok()
        .and_then(|idx| table.get(idx).copied())
}

fn safe_db_to_linear(db: f32) -> f32 {
    if db.is_nan() || db.is_infinite() { return 1.0; }
    10.0f32.powf(db.clamp(-60.0, 24.0) / 20.0)
}

/// Wraps the DSP filter bin and provides typed access to plugin properties.
pub(crate) struct DspFilterBin {
    pub bin: gst::Bin,
    eq: gst::Element,
    norm_gain: gst::Element,
    limiter: gst::Element,
    bass_enhancer: gst::Element,
    bypassed: bool,
    eq_was_enabled: bool,
    limiter_was_enabled: bool,
    bass_was_bypassed: bool,
    /// User toggle for normalization. When false, `norm_gain` stays at 1.0
    /// regardless of `norm_gain_db_pending`, behaving as a passthrough.
    norm_enabled: bool,
    /// Most recently requested gain in dB. Cached so we can reapply it
    /// when the user re-enables normalization without needing the caller
    /// to remember the value.
    norm_gain_db_pending: f32,
}

impl DspFilterBin {
    /// Build the filter bin. Returns `None` if any LV2 element is missing
    /// (graceful degradation -- playback works without DSP).
    pub fn try_new() -> Result<Option<Self>, OutputError> {
        // Try creating each element; if any is missing, skip DSP entirely.
        let eq = match gst::ElementFactory::make(EQ_ELEMENT).build() {
            Ok(e) => e,
            Err(_) => {
                tracing::warn!("LV2 element {EQ_ELEMENT} not found; DSP disabled");
                return Ok(None);
            }
        };
        let limiter = match gst::ElementFactory::make(LIMITER_ELEMENT).build() {
            Ok(e) => e,
            Err(_) => {
                tracing::warn!("LV2 element {LIMITER_ELEMENT} not found; DSP disabled");
                return Ok(None);
            }
        };
        let bass_enhancer = match gst::ElementFactory::make(BASS_ENHANCER_ELEMENT).build() {
            Ok(e) => e,
            Err(_) => {
                tracing::warn!("LV2 element {BASS_ENHANCER_ELEMENT} not found; DSP disabled");
                return Ok(None);
            }
        };

        // norm_gain: stock GStreamer `volume` element used as the loudness
        // normalization stage. Sits between EQ and Limiter so EQ sees flat
        // audio and the limiter still catches any overshoots from boosting
        // a quiet master.
        let norm_gain = gst::ElementFactory::make("volume")
            .name("norm_gain")
            .property("volume", 1.0_f64)
            .build()
            .map_err(|e| OutputError::PipewireInit(format!("volume (norm_gain): {e}")))?;

        let convert_in = gst::ElementFactory::make("audioconvert")
            .build()
            .map_err(|e| OutputError::PipewireInit(format!("audioconvert: {e}")))?;
        let capsfilter = gst::ElementFactory::make("capsfilter")
            .property(
                "caps",
                gst::Caps::builder("audio/x-raw")
                    .field("format", "F32LE")
                    .build(),
            )
            .build()
            .map_err(|e| OutputError::PipewireInit(format!("capsfilter: {e}")))?;
        let convert_out = gst::ElementFactory::make("audioconvert")
            .build()
            .map_err(|e| OutputError::PipewireInit(format!("audioconvert: {e}")))?;

        let bin = gst::Bin::new();

        bin.add_many([&convert_in, &capsfilter, &eq, &norm_gain, &limiter, &bass_enhancer, &convert_out])
            .map_err(|e| OutputError::PipewireInit(format!("bin.add_many: {e}")))?;

        gst::Element::link_many([&convert_in, &capsfilter, &eq, &norm_gain, &limiter, &bass_enhancer, &convert_out])
            .map_err(|e| OutputError::PipewireInit(format!("link_many: {e}")))?;

        // Ghost pads so the bin acts as a single filter element.
        let sink_pad = convert_in
            .static_pad("sink")
            .ok_or_else(|| OutputError::PipewireInit("no sink pad on audioconvert".into()))?;
        let src_pad = convert_out
            .static_pad("src")
            .ok_or_else(|| OutputError::PipewireInit("no src pad on audioconvert".into()))?;

        let ghost_sink = gst::GhostPad::with_target(&sink_pad)
            .map_err(|e| OutputError::PipewireInit(format!("ghost sink: {e}")))?;
        let ghost_src = gst::GhostPad::with_target(&src_pad)
            .map_err(|e| OutputError::PipewireInit(format!("ghost src: {e}")))?;

        bin.add_pad(&ghost_sink)
            .map_err(|e| OutputError::PipewireInit(format!("add ghost sink: {e}")))?;
        bin.add_pad(&ghost_src)
            .map_err(|e| OutputError::PipewireInit(format!("add ghost src: {e}")))?;

        // ---- Sane defaults ----
        //
        // LSP plugins have `enabled = false` by default (passthrough). We must
        // explicitly enable them or they will not process audio at all.
        eq.set_property("enabled", true);
        // Limiter starts disabled — the frontend persists DSP state and
        // re-applies on mount via applyFullState(). Starting disabled
        // avoids unwanted gain pumping when the user hasn't configured it.
        limiter.set_property("enabled", false);

        // All EQ bands: Bell filter type, flat gain (0 dB = 1.0 linear).
        // Filter types are set once here and never changed during playback
        // to avoid LV2 buffer reinitialization artifacts.
        for i in 0..16u8 {
            eq.set_property_from_str(&format!("ft-{i}"), "Bell");
            eq.set_property(&format!("g-{i}"), 1.0f32);
        }

        // Bass enhancer bypassed by default.
        bass_enhancer.set_property("bypass", true);

        tracing::info!("DSP filter bin created (EQ + Limiter + Bass Enhancer)");

        Ok(Some(Self {
            bin,
            eq,
            norm_gain,
            limiter,
            bass_enhancer,
            bypassed: false,
            eq_was_enabled: true,
            limiter_was_enabled: false,
            bass_was_bypassed: true,
            norm_enabled: true,
            norm_gain_db_pending: 0.0,
        }))
    }

    // -----------------------------------------------------------------------
    // Loudness normalization (norm_gain stage)
    // -----------------------------------------------------------------------

    /// Apply a gain offset (in dB) to the per-track normalization stage.
    ///
    /// When `norm_enabled` is false the value is cached but not applied;
    /// it will take effect on the next call to
    /// [`Self::set_norm_enabled(true)`]. This lets the caller set gain
    /// for every track unconditionally and keep the toggle as the only
    /// switch.
    pub fn set_norm_gain_db(&mut self, gain_db: f32) {
        self.norm_gain_db_pending = gain_db;
        if self.norm_enabled {
            let linear = f64::from(crate::loudness::gain_db_to_linear(gain_db));
            // GStreamer `volume` element clamps internally to [0, 10], well
            // outside the +/- 24 dB our loudness module already enforces.
            self.norm_gain.set_property("volume", linear);
        }
    }

    /// Enable or disable the normalization stage.
    ///
    /// Disabling forces the stage to unity (passthrough). Enabling
    /// re-applies the most recently requested gain.
    pub fn set_norm_enabled(&mut self, enabled: bool) {
        self.norm_enabled = enabled;
        if enabled {
            let linear = f64::from(crate::loudness::gain_db_to_linear(self.norm_gain_db_pending));
            self.norm_gain.set_property("volume", linear);
        } else {
            self.norm_gain.set_property("volume", 1.0_f64);
        }
    }

    // -----------------------------------------------------------------------
    // Parametric EQ
    // -----------------------------------------------------------------------

    /// Set a single EQ band. `gain` is in dB (converted to linear for the plugin).
    ///
    /// Also ensures filter type is Bell (via set_property_from_str, safe for
    /// GLib enums). Setting Bell→Bell is a no-op for the plugin.
    pub fn set_eq_band(&self, band: u8, freq: f32, gain_db: f32, q: f32) {
        if band >= 16 {
            return;
        }
        let gain_linear = safe_db_to_linear(gain_db);
        self.eq
            .set_property_from_str(&format!("ft-{band}"), "Bell");
        self.eq.set_property(&format!("f-{band}"), freq);
        self.eq.set_property(&format!("g-{band}"), gain_linear);
        self.eq.set_property(&format!("q-{band}"), q);
    }

    /// Set EQ filter type for a band.
    ///
    /// Accepted values: 0=Off, 1=Bell, 2=Hi-pass, 3=Hi-shelf, 4=Lo-pass,
    /// 5=Lo-shelf, 6=Notch, 7=Resonance, 8=Allpass, 9=Bandpass,
    /// 10=Ladder-pass, 11=Ladder-rej.
    ///
    /// Out-of-range values are logged and ignored (no panic).
    pub fn set_eq_filter_type(&self, band: u8, filter_type: i32) {
        if band >= 16 {
            return;
        }
        let Some(nick) = enum_nick(EQ_FILTER_TYPE_NICKS, filter_type) else {
            tracing::warn!(band, filter_type, "invalid EQ filter type; ignoring");
            return;
        };
        self.eq
            .set_property_from_str(&format!("ft-{band}"), nick);
    }

    /// Set EQ filter mode for a band.
    ///
    /// Accepted values: 0=RLC (BT), 1=RLC (MT), 2=BWC (BT), 3=BWC (MT),
    /// 4=LRX (BT), 5=LRX (MT), 6=APO (DR).
    ///
    /// Out-of-range values are logged and ignored (no panic).
    pub fn set_eq_filter_mode(&self, band: u8, mode: i32) {
        if band >= 16 {
            return;
        }
        let Some(nick) = enum_nick(EQ_FILTER_MODE_NICKS, mode) else {
            tracing::warn!(band, mode, "invalid EQ filter mode; ignoring");
            return;
        };
        self.eq
            .set_property_from_str(&format!("fm-{band}"), nick);
    }

    /// Set EQ slope for a band.
    ///
    /// Accepted values: 0=x1, 1=x2, 2=x3, 3=x4.
    ///
    /// Out-of-range values are logged and ignored (no panic).
    pub fn set_eq_slope(&self, band: u8, slope: i32) {
        if band >= 16 {
            return;
        }
        let Some(nick) = enum_nick(EQ_SLOPE_NICKS, slope) else {
            tracing::warn!(band, slope, "invalid EQ slope; ignoring");
            return;
        };
        self.eq
            .set_property_from_str(&format!("s-{band}"), nick);
    }

    /// Set EQ band solo (xs-N property).
    pub fn set_eq_solo(&self, band: u8, solo: bool) {
        if band >= 16 {
            return;
        }
        self.eq.set_property(&format!("xs-{band}"), solo);
    }

    /// Set EQ band mute (xm-N property).
    pub fn set_eq_mute(&self, band: u8, mute: bool) {
        if band >= 16 {
            return;
        }
        self.eq.set_property(&format!("xm-{band}"), mute);
    }

    /// Set EQ global input/output gain in dB (converted to linear for the plugin).
    pub fn set_eq_gain(&self, input: f32, output: f32) {
        let g_in = safe_db_to_linear(input);
        let g_out = safe_db_to_linear(output);
        self.eq.set_property("g-in", g_in);
        self.eq.set_property("g-out", g_out);
    }

    /// Set EQ operating mode.
    ///
    /// Accepted values: 0=IIR, 1=FIR, 2=FFT, 3=SPM.
    /// Out-of-range values are logged and ignored.
    pub fn set_eq_mode(&self, mode: i32) {
        let Some(nick) = enum_nick(EQ_MODE_NICKS, mode) else {
            tracing::warn!(mode, "invalid EQ mode; ignoring");
            return;
        };
        self.eq.set_property_from_str("mode", nick);
    }

    pub fn set_eq_enabled(&mut self, enabled: bool) {
        self.eq_was_enabled = enabled;
        if !self.bypassed {
            self.eq.set_property("enabled", enabled);
        }
    }

    // -----------------------------------------------------------------------
    // Limiter
    // -----------------------------------------------------------------------

    pub fn set_limiter_enabled(&mut self, enabled: bool) {
        self.limiter_was_enabled = enabled;
        if !self.bypassed {
            self.limiter.set_property("enabled", enabled);
        }
    }

    /// Set limiter threshold in dB (linear for the plugin: 10^(dB/20)).
    pub fn set_limiter_threshold(&self, threshold_db: f32) {
        let linear = safe_db_to_linear(threshold_db);
        self.limiter.set_property("th", linear);
    }

    pub fn set_limiter_knee(&self, knee: f32) {
        self.limiter
            .set_property("knee", knee.clamp(0.25119, 3.98107));
    }

    pub fn set_limiter_lookahead(&self, lookahead: f32) {
        self.limiter
            .set_property("lk", lookahead.clamp(0.1, 20.0));
    }

    /// Set limiter operating mode.
    ///
    /// Accepted values: 0=Herm Thin, 1=Herm Wide, 2=Herm Tail, 3=Herm Duck,
    /// 4=Exp Thin, 5=Exp Wide, 6=Exp Tail, 7=Exp Duck.
    /// Out-of-range values are logged and ignored.
    pub fn set_limiter_mode(&self, mode: i32) {
        let Some(nick) = enum_nick(LIMITER_MODE_NICKS, mode) else {
            tracing::warn!(mode, "invalid limiter mode; ignoring");
            return;
        };
        self.limiter.set_property_from_str("mode", nick);
    }

    pub fn set_limiter_gain(&self, input: f32, output: f32) {
        let g_in = safe_db_to_linear(input);
        let g_out = safe_db_to_linear(output);
        self.limiter.set_property("g-in", g_in);
        self.limiter.set_property("g-out", g_out);
    }

    pub fn set_limiter_boost(&self, boost: bool) {
        self.limiter.set_property("boost", boost);
    }

    /// Set limiter attack time in ms (clamped to plugin range 0.25–20).
    pub fn set_limiter_attack(&self, attack: f32) {
        self.limiter
            .set_property("at", attack.clamp(0.25, 20.0));
    }

    /// Set limiter release time in ms (clamped to plugin range 0.25–20).
    pub fn set_limiter_release(&self, release: f32) {
        self.limiter
            .set_property("rt", release.clamp(0.25, 20.0));
    }

    /// Set limiter stereo link percentage (0–100).
    pub fn set_limiter_stereo_link(&self, link: f32) {
        self.limiter
            .set_property("slink", link.clamp(0.0, 100.0));
    }

    /// Set limiter sidechain preamp in dB (converted to linear, plugin range 0–100).
    pub fn set_limiter_sc_preamp(&self, preamp_db: f32) {
        let linear = safe_db_to_linear(preamp_db).clamp(0.0, 100.0);
        self.limiter.set_property("scp", linear);
    }

    /// Set limiter oversampling mode.
    ///
    /// Accepted values: 0=None .. 20=Full x8/24 bit.
    /// Out-of-range values are logged and ignored.
    pub fn set_limiter_oversampling(&self, ovs: i32) {
        let Some(nick) = enum_nick(LIMITER_OVS_NICKS, ovs) else {
            tracing::warn!(ovs, "invalid limiter oversampling; ignoring");
            return;
        };
        self.limiter.set_property_from_str("ovs", nick);
    }

    /// Set limiter dithering mode.
    ///
    /// Accepted values: 0=None, 1=7bit, 2=8bit, 3=11bit, 4=12bit.
    /// Out-of-range values are logged and ignored.
    pub fn set_limiter_dither(&self, dither: i32) {
        let Some(nick) = enum_nick(LIMITER_DITHER_NICKS, dither) else {
            tracing::warn!(dither, "invalid limiter dither; ignoring");
            return;
        };
        self.limiter.set_property_from_str("dith", nick);
    }

    /// Set automatic level regulation (ALR) enabled.
    pub fn set_limiter_alr(&self, alr: bool) {
        self.limiter.set_property("alr", alr);
    }

    /// Set ALR attack time in ms (clamped to plugin range 0.1–200).
    pub fn set_limiter_alr_attack(&self, attack: f32) {
        self.limiter
            .set_property("alr-at", attack.clamp(0.1, 200.0));
    }

    /// Set ALR release time in ms (clamped to plugin range 10–1000).
    pub fn set_limiter_alr_release(&self, release: f32) {
        self.limiter
            .set_property("alr-rt", release.clamp(10.0, 1000.0));
    }

    // -----------------------------------------------------------------------
    // Bass Enhancer
    // -----------------------------------------------------------------------

    pub fn set_bass_amount(&self, amount: f32) {
        self.bass_enhancer.set_property("amount", amount);
    }

    pub fn set_bass_drive(&self, drive: f32) {
        self.bass_enhancer
            .set_property("drive", drive.clamp(0.1, 10.0));
    }

    pub fn set_bass_blend(&self, blend: f32) {
        self.bass_enhancer.set_property("blend", blend);
    }

    pub fn set_bass_freq(&self, freq: f32) {
        self.bass_enhancer.set_property("freq", freq);
    }

    pub fn set_bass_floor(&self, floor: f32) {
        self.bass_enhancer.set_property("floor", floor);
    }

    pub fn set_bass_bypass(&mut self, bypass: bool) {
        self.bass_was_bypassed = bypass;
        if !self.bypassed {
            self.bass_enhancer.set_property("bypass", bypass);
        }
    }

    /// Set bass enhancer input/output gain in dB (converted to linear for the plugin).
    pub fn set_bass_levels(&self, input: f32, output: f32) {
        let g_in = safe_db_to_linear(input);
        let g_out = safe_db_to_linear(output);
        self.bass_enhancer.set_property("level-in", g_in);
        self.bass_enhancer.set_property("level-out", g_out);
    }

    /// Set bass enhancer floor-active toggle.
    pub fn set_bass_floor_active(&self, active: bool) {
        self.bass_enhancer.set_property("floor-active", active);
    }

    /// Set bass enhancer listen mode (solo harmonics signal).
    pub fn set_bass_listen(&self, listen: bool) {
        self.bass_enhancer.set_property("listen", listen);
    }

    // -----------------------------------------------------------------------
    // Global bypass
    // -----------------------------------------------------------------------

    /// Toggle real bypass using native plugin properties.
    ///
    /// - LSP EQ / Limiter: `enabled = false` puts the plugin in passthrough
    ///   mode (zero processing, no latency contribution).
    /// - Calf Bass Enhancer: `bypass = true` does the same.
    ///
    /// When un-bypassing, plugins are re-enabled and the caller should
    /// re-apply their desired DSP settings if they were changed while
    /// bypassed.
    pub fn set_bypassed(&mut self, bypass: bool) {
        self.bypassed = bypass;
        if bypass {
            self.eq.set_property("enabled", false);
            self.limiter.set_property("enabled", false);
            self.bass_enhancer.set_property("bypass", true);
            tracing::debug!("DSP bypassed (plugins in passthrough)");
        } else {
            self.eq.set_property("enabled", self.eq_was_enabled);
            self.limiter.set_property("enabled", self.limiter_was_enabled);
            self.bass_enhancer.set_property("bypass", self.bass_was_bypassed);
            tracing::debug!(
                "DSP un-bypassed (eq={}, limiter={}, bass_bypass={})",
                self.eq_was_enabled, self.limiter_was_enabled, self.bass_was_bypassed
            );
        }
    }

    /// Returns `true` if the DSP chain is currently bypassed.
    #[allow(dead_code)]
    pub fn is_bypassed(&self) -> bool {
        self.bypassed
    }
}
