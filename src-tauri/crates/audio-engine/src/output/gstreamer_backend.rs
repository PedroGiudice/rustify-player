//! GStreamer-based audio backend using the Play (GstPlay) high-level API.
//!
//! GStreamer handles everything: FLAC decode, sample rate conversion,
//! channel mapping, volume, and output to PipeWire. We just drive it.

use std::path::Path;
use std::time::Duration;

use gstreamer as gst;
use gstreamer::glib;
use gstreamer::prelude::*;
use gstreamer_play as gst_play;

use crate::error::OutputError;
use super::dsp::DspFilterBin;

pub(crate) struct GstreamerPlayer {
    player: gst_play::Play,
    adapter: gst_play::PlaySignalAdapter,
    sample_rate: u32,
    pub(crate) dsp: Option<DspFilterBin>,
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

        // Set DSP as audio-filter if available.
        let pipeline = player.pipeline();
        if let Some(ref dsp_bin) = dsp {
            pipeline.set_property("audio-filter", &dsp_bin.bin);
            tracing::info!("DSP filter bin attached to playbin audio-filter");
        }

        Ok(Self {
            player,
            adapter,
            sample_rate: 44100,
            dsp,
        })
    }

    pub fn load(&mut self, path: &Path) {
        let uri = file_uri(path);
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

/// Build a percent-encoded `file://` URI from a filesystem path.
///
/// `format!("file://{}", path)` is wrong: characters that are *syntactic* in a
/// URI corrupt the parse and `GstGioSrc` then fails to open the resource with
/// "No input stream provided by subclass" — playback silently never starts.
/// Real cases this broke: `5% TINT.flac` (`%` introduces a percent-escape) and
/// `Interlude #4.flac` (`#` is the fragment delimiter).
///
/// `glib::filename_to_uri` percent-encodes exactly the bytes that need it
/// (`%`→`%25`, `#`→`%23`, space→`%20`) and leaves safe ones (`&`, `(`) literal.
/// It requires an absolute path; library paths already are, but we coerce
/// defensively and fall back to the raw form (logged) if conversion fails.
fn file_uri(path: &Path) -> String {
    let abs_buf;
    let abs: &Path = if path.is_absolute() {
        path
    } else {
        abs_buf = std::env::current_dir()
            .map(|d| d.join(path))
            .unwrap_or_else(|_| path.to_path_buf());
        &abs_buf
    };
    match glib::filename_to_uri(abs, None) {
        Ok(uri) => uri.to_string(),
        Err(e) => {
            tracing::error!(
                error = %e,
                path = %abs.display(),
                "filename_to_uri failed; using raw file:// (special chars may break playback)"
            );
            format!("file://{}", abs.display())
        }
    }
}

impl Drop for GstreamerPlayer {
    fn drop(&mut self) {
        self.player.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_uri_percent_encodes_the_percent_sign() {
        // The bug that broke "5% TINT.flac": `%` must become `%25`.
        let uri = file_uri(Path::new("/music/09 - 5% TINT.flac"));
        assert!(uri.starts_with("file:///"), "{uri}");
        assert!(uri.contains("%25"), "percent must be encoded: {uri}");
        assert!(!uri.contains("5% TINT"), "raw `% ` leaks into uri: {uri}");
        assert!(uri.contains("%20"), "space must be encoded: {uri}");
    }

    #[test]
    fn file_uri_encodes_the_hash() {
        // `#` is the URI fragment delimiter; broke "Interlude #4.flac".
        let uri = file_uri(Path::new("/music/Interlude #4.flac"));
        assert!(uri.contains("%23"), "hash must be encoded: {uri}");
        assert!(!uri.contains("#4"), "raw `#` leaks into uri: {uri}");
    }

    #[test]
    fn file_uri_roundtrips_back_to_the_original_path() {
        // The strongest check: glib parses our URI back to the exact path.
        let p = Path::new("/music/Rap & Hip-Hop/5% TINT #1.flac");
        let uri = file_uri(p);
        let (back, _host) = glib::filename_from_uri(&uri).expect("uri parses back");
        assert_eq!(back.as_path(), p, "roundtrip mismatch from {uri}");
    }
}
