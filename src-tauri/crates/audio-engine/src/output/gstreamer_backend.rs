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

        // Build the DSP filter bin and attach to playbin's audio-filter.
        let dsp = match DspFilterBin::try_new() {
            Ok(Some(dsp_bin)) => {
                // gst_play::Play wraps a playbin internally. Access it via
                // the pipeline property to set the audio-filter.
                let pipeline = player.pipeline();
                pipeline.set_property("audio-filter", &dsp_bin.bin);
                tracing::info!("DSP filter bin attached to playbin audio-filter");
                Some(dsp_bin)
            }
            Ok(None) => {
                tracing::info!("DSP plugins not available; running without DSP");
                None
            }
            Err(e) => {
                tracing::warn!(?e, "failed to create DSP filter bin; running without DSP");
                None
            }
        };

        Ok(Self {
            player,
            adapter,
            sample_rate: 44100,
            dsp,
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
}

impl Drop for GstreamerPlayer {
    fn drop(&mut self) {
        self.player.stop();
    }
}
