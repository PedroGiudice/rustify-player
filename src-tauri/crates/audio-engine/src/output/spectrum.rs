//! FFT spectrum analyzer via GStreamer's `spectrum` element.
//!
//! Inserted into the audio pipeline as a passthrough element. Emits magnitude
//! data as bus messages at ~60Hz. The Tauri layer reads these messages and
//! forwards them to the frontend via IPC event.

use gstreamer as gst;

use crate::error::OutputError;

const SPECTRUM_BANDS: u32 = 512;
const SPECTRUM_INTERVAL_NS: u64 = 16_666_666; // ~60Hz

pub struct SpectrumAnalyzer {
    pub(crate) element: gst::Element,
}

impl SpectrumAnalyzer {
    pub fn try_new() -> Result<Option<Self>, OutputError> {
        let spectrum = match gst::ElementFactory::make("spectrum")
            .property("bands", SPECTRUM_BANDS)
            .property("interval", SPECTRUM_INTERVAL_NS as u64)
            .property("threshold", -80i32)
            .property("post-messages", true)
            .property("message-magnitude", true)
            .property("message-phase", false)
            .property("multi-channel", false)
            .build()
        {
            Ok(e) => e,
            Err(_) => {
                tracing::warn!("GStreamer spectrum element not available");
                return Ok(None);
            }
        };

        Ok(Some(Self { element: spectrum }))
    }

    /// Parse a spectrum bus message into normalized u8 magnitudes.
    /// Returns None if the message is not from the spectrum element.
    pub fn parse_message(msg: &gst::Message) -> Option<Vec<u8>> {
        let s = msg.structure()?;
        if s.name().as_str() != "spectrum" {
            return None;
        }

        let magnitudes = s.get::<gst::List>("magnitude").ok()?;
        let threshold = -80.0f32;
        let range = threshold.abs();

        let data: Vec<u8> = magnitudes
            .iter()
            .map(|v| {
                let db = v.get::<f32>().unwrap_or(threshold);
                // Normalize: threshold..0 dB → 0..255
                let normalized = ((db - threshold) / range).clamp(0.0, 1.0);
                (normalized * 255.0) as u8
            })
            .collect();

        Some(data)
    }
}
