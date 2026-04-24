//! Output backend — now a thin module re-exporting the GStreamer backend types.
//!
//! GStreamer handles the entire audio pipeline (decode → resample →
//! mix → output). This module exists for structural consistency.

pub(crate) mod dsp;
mod gstreamer_backend;

pub(crate) use gstreamer_backend::GstreamerPlayer;
