//! GStreamer-based audio backend using the Play (GstPlay) high-level API.
//!
//! GStreamer handles everything: FLAC decode, sample rate conversion,
//! channel mapping, volume, and output to PipeWire. We just drive it.

use std::path::Path;
use std::time::Duration;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_play as gst_play;

use crate::error::OutputError;
use super::dsp::DspFilterBin;
use super::spectrum::SpectrumAnalyzer;

pub(crate) struct GstreamerPlayer {
    player: gst_play::Play,
    adapter: gst_play::PlaySignalAdapter,
    sample_rate: u32,
    pub(crate) dsp: Option<DspFilterBin>,
    pub(crate) spectrum: Option<SpectrumAnalyzer>,
}

impl GstreamerPlayer {
    pub fn new() -> Result<Self, OutputError> {
        gst::init().map_err(|e| OutputError::PipewireInit(format!("gstreamer init: {e}")))?;

        let player = gst_play::Play::new(None::<gst_play::PlayVideoRenderer>);
        let adapter = gst_play::PlaySignalAdapter::new(&player);

        // Audio-only: disable video.
        player.set_video_track_enabled(false);

        // Build the DSP filter bin.
        let dsp = match DspFilterBin::try_new() {
            Ok(Some(dsp_bin)) => Some(dsp_bin),
            Ok(None) => {
                tracing::info!("DSP plugins not available; running without DSP");
                None
            }
            Err(e) => {
                tracing::warn!(?e, "failed to create DSP filter bin; running without DSP");
                None
            }
        };

        // Build spectrum analyzer (optional, graceful degradation).
        let spectrum = match SpectrumAnalyzer::try_new() {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(?e, "failed to create spectrum analyzer");
                None
            }
        };

        // Assemble audio-filter: a wrapper bin containing [DSP] → [spectrum].
        // If neither is available, no audio-filter is set.
        let pipeline = player.pipeline();

        match (&dsp, &spectrum) {
            (Some(dsp_bin), Some(spec)) => {
                // Wrapper bin: dsp_bin → spectrum
                let wrapper = gst::Bin::new();
                wrapper.add_many([&dsp_bin.bin.clone().upcast(), &spec.element]).unwrap();
                dsp_bin.bin.link(&spec.element).unwrap();

                let sink_pad = dsp_bin.bin.static_pad("sink").unwrap();
                let src_pad = spec.element.static_pad("src").unwrap();
                wrapper.add_pad(&gst::GhostPad::with_target(&sink_pad).unwrap()).unwrap();
                wrapper.add_pad(&gst::GhostPad::with_target(&src_pad).unwrap()).unwrap();

                pipeline.set_property("audio-filter", &wrapper);
                tracing::info!("DSP + spectrum attached to playbin audio-filter");
            }
            (Some(dsp_bin), None) => {
                pipeline.set_property("audio-filter", &dsp_bin.bin);
                tracing::info!("DSP filter bin attached to playbin audio-filter");
            }
            (None, Some(spec)) => {
                // Standalone spectrum as audio-filter (passthrough analysis).
                pipeline.set_property("audio-filter", &spec.element);
                tracing::info!("Spectrum analyzer attached to playbin audio-filter");
            }
            (None, None) => {
                tracing::info!("No audio-filter configured");
            }
        }

        Ok(Self {
            player,
            adapter,
            sample_rate: 44100,
            dsp,
            spectrum,
        })
    }

    pub fn load(&mut self, path: &Path) {
        let uri = format!("file://{}", path.display());
        self.player.set_uri(Some(&uri));
    }

    pub fn play(&self) {
        self.player.play();
    }

    pub fn pause(&self) {
        self.player.pause();
    }

    pub fn stop(&self) {
        self.player.stop();
    }

    pub fn seek(&self, position: Duration) {
        let clock_time = gst::ClockTime::from_nseconds(position.as_nanos() as u64);
        self.player.seek(clock_time);
    }

    pub fn set_volume(&self, volume: f64) {
        self.player.set_volume(volume.clamp(0.0, 1.0));
    }

    pub fn position(&self) -> Option<Duration> {
        self.player.position().map(|ct| {
            Duration::from_nanos(ct.nseconds())
        })
    }

    pub fn running_time_ns(&self) -> u64 {
        let pipeline = self.player.pipeline();
        let clock = match pipeline.clock() {
            Some(c) => c,
            None => return 0,
        };
        let now_ns = clock.time().nseconds();
        let base_ns = pipeline.base_time().map_or(0, |t| t.nseconds());
        now_ns.saturating_sub(base_ns)
    }

    pub fn pipeline_clock(&self) -> Option<gst::Clock> {
        self.player.pipeline().clock()
    }

    pub fn pipeline_base_time_ns(&self) -> u64 {
        self.player.pipeline().base_time().map_or(0, |t| t.nseconds())
    }

    #[allow(dead_code)]
    pub fn duration(&self) -> Option<Duration> {
        self.player.duration().map(|ct| {
            Duration::from_nanos(ct.nseconds())
        })
    }

    pub fn signal_adapter(&self) -> &gst_play::PlaySignalAdapter {
        &self.adapter
    }

    pub fn set_sample_rate(&mut self, sr: u32) {
        self.sample_rate = sr;
    }

    pub fn position_samples(&self) -> u64 {
        if let Some(pos) = self.position() {
            (pos.as_secs_f64() * f64::from(self.sample_rate)) as u64
        } else {
            0
        }
    }

    pub fn bus(&self) -> Option<gst::Bus> {
        self.player.pipeline().bus()
    }

    pub fn sink_latency_ms(&self) -> u64 {
        // Try querying pipeline latency first
        let pipeline = self.player.pipeline();
        let mut q = gst::query::Latency::new();
        if pipeline.query(&mut q) {
            let (_, min, _) = q.result();
            let ms = min.mseconds();
            if ms > 5 {
                tracing::info!(latency_ms = ms, "sink latency from pipeline query");
                return ms;
            }
        }

        // Fallback: read PipeWire quantum from pw-metadata
        match std::process::Command::new("pw-metadata")
            .args(["-n", "settings", "0"])
            .output()
        {
            Ok(out) => {
                let text = String::from_utf8_lossy(&out.stdout);
                let quantum = text.lines()
                    .find(|l| l.contains("clock.quantum"))
                    .and_then(|l| l.split('\'').nth(3))
                    .and_then(|v| v.trim().parse::<u64>().ok())
                    .unwrap_or(1024);
                let rate = text.lines()
                    .find(|l| l.contains("clock.rate") && !l.contains("allowed") && !l.contains("force"))
                    .and_then(|l| l.split('\'').nth(3))
                    .and_then(|v| v.trim().parse::<u64>().ok())
                    .unwrap_or(48000);
                // PipeWire uses ~2 quantum periods of buffering typically
                let ms = (quantum * 1000 * 2) / rate;
                tracing::info!(quantum, rate, latency_ms = ms, "sink latency from PipeWire metadata (2x quantum)");
                ms
            }
            Err(_) => {
                tracing::debug!("pw-metadata not available, defaulting to 85ms");
                85
            }
        }
    }
}

impl Drop for GstreamerPlayer {
    fn drop(&mut self) {
        self.player.stop();
    }
}
