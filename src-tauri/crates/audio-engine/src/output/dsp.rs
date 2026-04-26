//! DSP filter bin: LV2 plugins wired as a GStreamer audio-filter.
//!
//! Creates a GstBin with:
//!   audioconvert -> LSP Para EQ x16 Stereo -> LSP Limiter Stereo -> Calf Bass Enhancer -> audioconvert
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

/// Look up the nick string for a numeric enum value.
/// Returns `None` if `value` is out of range.
fn enum_nick(table: &[&'static str], value: i32) -> Option<&'static str> {
    usize::try_from(value)
        .ok()
        .and_then(|idx| table.get(idx).copied())
}

/// Wraps the DSP filter bin and provides typed access to plugin properties.
pub(crate) struct DspFilterBin {
    pub bin: gst::Bin,
    eq: gst::Element,
    limiter: gst::Element,
    bass_enhancer: gst::Element,
    bypassed: bool,
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

        let convert_in = gst::ElementFactory::make("audioconvert")
            .build()
            .map_err(|e| OutputError::PipewireInit(format!("audioconvert: {e}")))?;
        let convert_out = gst::ElementFactory::make("audioconvert")
            .build()
            .map_err(|e| OutputError::PipewireInit(format!("audioconvert: {e}")))?;

        let bin = gst::Bin::new();

        bin.add_many([&convert_in, &eq, &limiter, &bass_enhancer, &convert_out])
            .map_err(|e| OutputError::PipewireInit(format!("bin.add_many: {e}")))?;

        gst::Element::link_many([&convert_in, &eq, &limiter, &bass_enhancer, &convert_out])
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
        limiter.set_property("enabled", true);

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
            limiter,
            bass_enhancer,
            bypassed: false,
        }))
    }

    // -----------------------------------------------------------------------
    // Parametric EQ
    // -----------------------------------------------------------------------

    /// Set a single EQ band. `gain` is in dB (converted to linear for the plugin).
    ///
    /// Filter types are pre-set to Bell at init — only freq/gain/Q change here
    /// to avoid LV2 buffer reinitialization artifacts during playback.
    pub fn set_eq_band(&self, band: u8, freq: f32, gain_db: f32, q: f32) {
        if band >= 16 {
            return;
        }
        let gain_linear = 10.0f32.powf(gain_db / 20.0);
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
        let g_in = 10.0f32.powf(input / 20.0);
        let g_out = 10.0f32.powf(output / 20.0);
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

    pub fn set_eq_enabled(&self, enabled: bool) {
        self.eq.set_property("enabled", enabled);
    }

    // -----------------------------------------------------------------------
    // Limiter
    // -----------------------------------------------------------------------

    pub fn set_limiter_enabled(&self, enabled: bool) {
        self.limiter.set_property("enabled", enabled);
    }

    /// Set limiter threshold in dB (linear for the plugin: 10^(dB/20)).
    pub fn set_limiter_threshold(&self, threshold_db: f32) {
        let linear = 10.0f32.powf(threshold_db / 20.0);
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
        let g_in = 10.0f32.powf(input / 20.0);
        let g_out = 10.0f32.powf(output / 20.0);
        self.limiter.set_property("g-in", g_in);
        self.limiter.set_property("g-out", g_out);
    }

    pub fn set_limiter_boost(&self, boost: bool) {
        self.limiter.set_property("boost", boost);
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

    pub fn set_bass_bypass(&self, bypass: bool) {
        self.bass_enhancer.set_property("bypass", bypass);
    }

    pub fn set_bass_levels(&self, input: f32, output: f32) {
        self.bass_enhancer.set_property("level-in", input);
        self.bass_enhancer.set_property("level-out", output);
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
            self.eq.set_property("enabled", true);
            self.limiter.set_property("enabled", true);
            // Bass enhancer stays bypassed until explicitly un-bypassed by
            // the caller via set_bass_bypass(false) — it's off by default.
            tracing::debug!("DSP un-bypassed (plugins re-enabled)");
        }
    }

    /// Returns `true` if the DSP chain is currently bypassed.
    #[allow(dead_code)]
    pub fn is_bypassed(&self) -> bool {
        self.bypassed
    }
}
