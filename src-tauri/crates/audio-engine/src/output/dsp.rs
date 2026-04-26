//! DSP filter bin: LV2 plugins wired as a GStreamer audio-filter.
//!
//! Creates a GstBin with:
//!   audioconvert → LSP Para EQ x16 Stereo → LSP Limiter Stereo → Calf Bass Enhancer → audioconvert
//!
//! The bin is set as the `audio-filter` property on `playbin` inside `gst_play::Play`.

use gstreamer as gst;
use gstreamer::prelude::*;

use crate::error::OutputError;

/// GStreamer element factory names (confirmed via `gst-inspect-1.0`).
const EQ_ELEMENT: &str = "lsp-plug-in-plugins-lv2-para-equalizer-x16-stereo";
const LIMITER_ELEMENT: &str = "lsp-plug-in-plugins-lv2-limiter-stereo";
const BASS_ENHANCER_ELEMENT: &str = "calf-sourceforge-net-plugins-BassEnhancer";

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
    /// (graceful degradation — playback works without DSP).
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

        // Sane defaults: all EQ bands flat (0 dB gain), limiter at 0 dB, bass off.
        // LSP gain is linear (1.0 = 0 dB).
        for i in 0..16u8 {
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
    /// LSP types: 0=Off, 1=Bell, 2=Hi-pass, 3=Hi-shelf, 4=Lo-pass,
    ///            5=Lo-shelf, 6=Notch, 7=Resonance, 8=Allpass, 9=Bandpass,
    ///            10=Ladder-pass, 11=Ladder-rej
    pub fn set_eq_filter_type(&self, band: u8, filter_type: i32) {
        if band >= 16 {
            return;
        }
        self.eq.set_property(&format!("ft-{band}"), filter_type);
    }

    /// Set EQ global input/output gain in dB (converted to linear for the plugin).
    pub fn set_eq_gain(&self, input: f32, output: f32) {
        let g_in = 10.0f32.powf(input / 20.0);
        let g_out = 10.0f32.powf(output / 20.0);
        self.eq.set_property("g-in", g_in);
        self.eq.set_property("g-out", g_out);
    }

    /// Set EQ operating mode. 0=IIR, 1=FIR, 2=FFT, 3=SPM.
    pub fn set_eq_mode(&self, mode: i32) {
        self.eq.set_property("mode", mode);
    }

    // -----------------------------------------------------------------------
    // Limiter
    // -----------------------------------------------------------------------

    /// Set limiter threshold in dB (linear for the plugin: 10^(dB/20)).
    pub fn set_limiter_threshold(&self, threshold_db: f32) {
        let linear = 10.0f32.powf(threshold_db / 20.0);
        self.limiter.set_property("th", linear);
    }

    pub fn set_limiter_knee(&self, knee: f32) {
        self.limiter.set_property("knee", knee.clamp(0.25119, 3.98107));
    }

    pub fn set_limiter_lookahead(&self, lookahead: f32) {
        self.limiter.set_property("lk", lookahead.clamp(0.1, 20.0));
    }

    pub fn set_limiter_mode(&self, mode: i32) {
        self.limiter.set_property("mode", mode);
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
        self.bass_enhancer.set_property("drive", drive.clamp(0.1, 10.0));
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
        self.bass_enhancer
            .set_property("bypass", bypass);
    }

    pub fn set_bass_levels(&self, input: f32, output: f32) {
        self.bass_enhancer.set_property("level-in", input);
        self.bass_enhancer.set_property("level-out", output);
    }

    // -----------------------------------------------------------------------
    // Global bypass
    // -----------------------------------------------------------------------

    /// Bypass is implemented by setting all EQ bands to flat, limiter threshold
    /// to max, and bass enhancer to bypass. We don't remove/re-add the bin
    /// because that requires pipeline state changes and risks glitches.
    pub fn set_bypassed(&mut self, bypass: bool) {
        self.bypassed = bypass;
        if bypass {
            for i in 0..16u8 {
                self.eq.set_property(&format!("g-{i}"), 1.0f32);
            }
            self.limiter.set_property("th", 1.0f32); // 0 dB = no limiting
            self.limiter.set_property("g-in", 1.0f32);
            self.limiter.set_property("g-out", 1.0f32);
            self.bass_enhancer.set_property("bypass", true);
        }
        // When un-bypassing, the caller should re-apply their desired settings.
    }
}
