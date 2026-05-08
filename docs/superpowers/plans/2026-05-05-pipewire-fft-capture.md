# PipeWire FFT Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace GStreamer's spectrum element with a PipeWire monitor stream capture + rustfft, eliminating the ~1.3s sync gap between spectrum visualization and audio playback.

**Architecture:** A dedicated PipeWire MainLoop thread opens a `pw_stream` in capture mode targeting the app's own sink monitor. The RT process callback copies raw f32 samples into a lock-free ring buffer (`rtrb`). A separate FFT worker thread reads from the ring buffer, applies a 1024-sample Hanning-windowed FFT via `rustfft`, normalizes to 512 magnitude bins (u8), and writes to the existing `spectrum_buf: Arc<Mutex<(u64, Vec<u8>)>>`. The emitter thread and frontend remain unchanged.

**Tech Stack:** `pipewire` 0.9, `libspa` 0.9, `rtrb` 0.3, `rustfft` 5.x (new dep), existing `audio-engine` crate

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src-tauri/Cargo.toml` | Modify | Add `rustfft` to workspace deps |
| `src-tauri/crates/audio-engine/Cargo.toml` | Modify | Add `pipewire`, `libspa`, `rtrb`, `rustfft` deps |
| `src-tauri/crates/audio-engine/src/output/pw_capture.rs` | Create | PipeWire stream capture + FFT worker |
| `src-tauri/crates/audio-engine/src/output/mod.rs` | Modify | Add `pub mod pw_capture;` |
| `src-tauri/crates/audio-engine/src/engine.rs` | Modify | Start PwCapture, remove GStreamer spectrum sync_handler |
| `src-tauri/crates/audio-engine/src/output/gstreamer_backend.rs` | Modify | Remove spectrum element from pipeline |
| `src-tauri/crates/audio-engine/src/output/spectrum.rs` | Delete | No longer needed (GStreamer spectrum) |
| `src-tauri/src/lib.rs` | Modify | Emitter uses timestamp=0 (render immediately) |
| `src/components/SpectrumBackground.tsx` | Modify | Remove ring buffer, render on receive |

---

### Task 1: Add rustfft dependency

**Files:**
- Modify: `src-tauri/Cargo.toml` (workspace dependencies section)
- Modify: `src-tauri/crates/audio-engine/Cargo.toml` (dependencies section)

- [ ] **Step 1: Add rustfft to workspace Cargo.toml**

In `src-tauri/Cargo.toml`, add after the `rtrb` line:

```toml
rustfft = "6"
```

- [ ] **Step 2: Add deps to audio-engine Cargo.toml**

In `src-tauri/crates/audio-engine/Cargo.toml`, add to `[dependencies]`:

```toml
pipewire = { workspace = true }
libspa = { workspace = true }
rtrb = { workspace = true }
rustfft = { workspace = true }
```

- [ ] **Step 3: Verify compilation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles (warnings OK)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/crates/audio-engine/Cargo.toml
git commit -m "feat(audio): add pipewire, libspa, rtrb, rustfft deps for PW capture"
```

---

### Task 2: Create pw_capture module — PipeWire stream + FFT worker

**Files:**
- Create: `src-tauri/crates/audio-engine/src/output/pw_capture.rs`
- Modify: `src-tauri/crates/audio-engine/src/output/mod.rs`

This is the core module. It spawns two threads:
1. **PipeWire thread** — runs MainLoop, opens pw_stream in capture mode (sink monitor), process callback copies f32 samples to rtrb Producer
2. **FFT thread** — reads from rtrb Consumer, accumulates 1024 samples, applies Hanning window + FFT, writes 512 magnitude bins to shared buffer

- [ ] **Step 1: Add module declaration**

In `src-tauri/crates/audio-engine/src/output/mod.rs`, add:

```rust
pub mod pw_capture;
```

- [ ] **Step 2: Create pw_capture.rs with full implementation**

Create `src-tauri/crates/audio-engine/src/output/pw_capture.rs`:

```rust
//! PipeWire monitor capture + FFT analysis.
//!
//! Captures audio from the app's own PipeWire sink monitor and computes
//! a 512-bin magnitude spectrum at ~60Hz. Data is written to a shared
//! buffer consumed by the spectrum emitter thread.

use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use rtrb::RingBuffer;
use rustfft::{FftPlanner, num_complex::Complex};

const FFT_SIZE: usize = 1024;
const SPECTRUM_BINS: usize = 512; // FFT_SIZE / 2
const RING_CAPACITY: usize = 8192; // ~85ms at 96kHz stereo
const TARGET_FPS: f64 = 60.0;

/// Handle to stop the capture threads.
pub struct PwCaptureHandle {
    running: Arc<AtomicBool>,
}

impl Drop for PwCaptureHandle {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

/// Start PipeWire capture targeting the given node name.
/// Writes FFT results to `spectrum_buf` in the same format as the old
/// GStreamer spectrum: (timestamp_ns, Vec<u8> of 512 normalized magnitudes).
///
/// `target_node` should be "rustify-player" (our app's PipeWire node name).
pub fn start(
    target_node: &str,
    spectrum_buf: Arc<Mutex<(u64, Vec<u8>)>>,
) -> Option<PwCaptureHandle> {
    let running = Arc::new(AtomicBool::new(true));
    let running_pw = running.clone();
    let running_fft = running.clone();
    let target = target_node.to_string();

    // Lock-free ring buffer: PW RT thread → FFT worker
    let (producer, consumer) = RingBuffer::<f32>::new(RING_CAPACITY);

    // FFT worker thread
    let spectrum_buf_fft = spectrum_buf.clone();
    std::thread::Builder::new()
        .name("pw-fft-worker".to_string())
        .spawn(move || {
            fft_worker(consumer, spectrum_buf_fft, running_fft);
        })
        .ok()?;

    // PipeWire capture thread
    std::thread::Builder::new()
        .name("pw-capture".to_string())
        .spawn(move || {
            if let Err(e) = pw_capture_loop(target, producer, running_pw) {
                tracing::error!("pw-capture failed: {e}");
            }
        })
        .ok()?;

    Some(PwCaptureHandle { running })
}

fn pw_capture_loop(
    target_node: String,
    mut producer: rtrb::Producer<f32>,
    running: Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error>> {
    pipewire::init();

    let mainloop = pipewire::main_loop::MainLoop::new(None)?;
    let context = pipewire::context::Context::new(&mainloop)?;
    let core = context.connect(None)?;

    let props = pipewire::properties::properties! {
        *pipewire::keys::MEDIA_TYPE => "Audio",
        *pipewire::keys::MEDIA_CATEGORY => "Capture",
        *pipewire::keys::MEDIA_ROLE => "DSP",
        *pipewire::keys::STREAM_CAPTURE_SINK => "true",
        *pipewire::keys::NODE_TARGET => target_node.as_str(),
    };

    let stream = pipewire::stream::Stream::new(&core, "rustify-spectrum", props)?;

    // Propose format: F32 mono (we'll mix channels in callback)
    let audio_info = libspa::param::audio::AudioInfoRaw::new()
        .set_format(libspa::param::audio::AudioFormat::F32LE)
        .set_rate(0) // 0 = accept any rate
        .set_channels(1); // mono mix

    let mut params = [libspa::pod::Pod::from_bytes(
        &libspa::param::audio::AudioInfoRaw::build_pod(&audio_info)?,
    )?];

    let running_cb = running.clone();
    let mainloop_weak = mainloop.downgrade();

    stream.add_local_listener()
        .process(move |stream, _| {
            if !running_cb.load(Ordering::Relaxed) {
                if let Some(ml) = mainloop_weak.upgrade() {
                    ml.quit();
                }
                return;
            }
            if let Some(mut buffer) = stream.dequeue_buffer() {
                let datas = buffer.datas_mut();
                if let Some(data) = datas.first_mut() {
                    if let Some(slice) = data.data() {
                        let samples: &[f32] = bytemuck::cast_slice(slice);
                        // Write as many samples as the ring buffer can accept
                        let writable = producer.slots();
                        let n = samples.len().min(writable);
                        if n > 0 {
                            if let Ok(mut chunk) = producer.write_chunk(n) {
                                let (a, b) = chunk.as_mut_slices();
                                let first = a.len().min(n);
                                a[..first].copy_from_slice(&samples[..first]);
                                if first < n {
                                    b[..n - first].copy_from_slice(&samples[first..n]);
                                }
                                chunk.commit_all();
                            }
                        }
                    }
                }
                stream.queue_buffer(buffer);
            }
        })
        .register()?;

    stream.connect(
        pipewire::stream::StreamFlags::AUTOCONNECT
            | pipewire::stream::StreamFlags::MAP_BUFFERS
            | pipewire::stream::StreamFlags::RT_PROCESS,
        &mut params,
    )?;

    // Run until stopped
    mainloop.run();

    Ok(())
}

fn fft_worker(
    mut consumer: rtrb::Consumer<f32>,
    spectrum_buf: Arc<Mutex<(u64, Vec<u8>)>>,
    running: Arc<AtomicBool>,
) {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);

    let mut window = vec![0.0f32; FFT_SIZE];
    // Hanning window
    for i in 0..FFT_SIZE {
        window[i] = 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE - 1) as f32).cos());
    }

    let mut accumulator = Vec::with_capacity(FFT_SIZE);
    let mut fft_buf = vec![Complex::new(0.0f32, 0.0); FFT_SIZE];

    let interval = std::time::Duration::from_secs_f64(1.0 / TARGET_FPS);

    while running.load(Ordering::Relaxed) {
        std::thread::sleep(interval);

        // Drain available samples from ring buffer
        let available = consumer.slots();
        if available == 0 {
            continue;
        }
        if let Ok(chunk) = consumer.read_chunk(available) {
            let (a, b) = chunk.as_slices();
            accumulator.extend_from_slice(a);
            accumulator.extend_from_slice(b);
            chunk.commit_all();
        }

        // Process complete FFT windows (keep only the last one for freshness)
        if accumulator.len() < FFT_SIZE {
            continue;
        }

        // Use the LAST complete window (most recent samples)
        let start = accumulator.len() - FFT_SIZE;
        for i in 0..FFT_SIZE {
            fft_buf[i] = Complex::new(accumulator[start + i] * window[i], 0.0);
        }
        // Discard processed samples, keep remainder
        accumulator.drain(..start + FFT_SIZE);

        // FFT
        fft.process(&mut fft_buf);

        // Magnitude → u8 (first 512 bins = positive frequencies)
        let mut magnitudes = vec![0u8; SPECTRUM_BINS];
        let threshold_db = -80.0f32;
        let range = threshold_db.abs();

        for i in 0..SPECTRUM_BINS {
            let mag = fft_buf[i].norm() / FFT_SIZE as f32;
            let db = if mag > 0.0 { 20.0 * mag.log10() } else { threshold_db };
            let normalized = ((db - threshold_db) / range).clamp(0.0, 1.0);
            magnitudes[i] = (normalized * 255.0) as u8;
        }

        // Write to shared buffer — timestamp 0 means "render now"
        if let Ok(mut buf) = spectrum_buf.lock() {
            *buf = (0, magnitudes);
        }
    }
}
```

**Note:** This code uses `bytemuck` for safe f32 slice casting. We need to add it as a dep. Alternative: use `unsafe { std::slice::from_raw_parts(...) }`. For safety, prefer bytemuck.

- [ ] **Step 3: Add bytemuck dep**

In `src-tauri/Cargo.toml` workspace deps:
```toml
bytemuck = { version = "1", features = ["derive"] }
```

In `src-tauri/crates/audio-engine/Cargo.toml`:
```toml
bytemuck = { workspace = true }
```

- [ ] **Step 4: Verify compilation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: may have warnings about unused code, but no errors

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/audio-engine/src/output/pw_capture.rs \
        src-tauri/crates/audio-engine/src/output/mod.rs \
        src-tauri/Cargo.toml src-tauri/crates/audio-engine/Cargo.toml
git commit -m "feat(audio): PipeWire monitor capture + rustfft spectrum analyzer"
```

---

### Task 3: Wire PwCapture into the engine, remove GStreamer spectrum

**Files:**
- Modify: `src-tauri/crates/audio-engine/src/engine.rs`
- Modify: `src-tauri/crates/audio-engine/src/output/gstreamer_backend.rs`
- Delete: `src-tauri/crates/audio-engine/src/output/spectrum.rs`

- [ ] **Step 1: Start PwCapture in engine spawn**

In `src-tauri/crates/audio-engine/src/engine.rs`, replace the bus sync_handler block (lines 137-149) with PwCapture start:

```rust
// Start PipeWire capture for spectrum analysis (captures from our own sink monitor)
let _pw_capture = crate::output::pw_capture::start(
    "rustify-player",
    spectrum_latest.clone(),
);
if _pw_capture.is_none() {
    tracing::warn!("PipeWire capture unavailable — spectrum disabled");
}
```

Keep the `spectrum_latest` Arc<Mutex> — PwCapture writes to it.

Store `_pw_capture` in `EngineState` or keep as local in the thread (it just needs to live as long as the engine runs). Simplest: keep as local binding in the spawned thread.

- [ ] **Step 2: Remove spectrum element from GStreamer pipeline**

In `src-tauri/crates/audio-engine/src/output/gstreamer_backend.rs`:

1. Remove `use super::spectrum::SpectrumAnalyzer;` import
2. Remove `pub(crate) spectrum: Option<SpectrumAnalyzer>,` field from struct
3. Remove spectrum creation in `new()` (lines 48-56 approx)
4. Remove spectrum linking in the wrapper bin logic (lines 57-83 approx)
5. Simplify: if DSP exists, set it as audio-filter directly. If not, no audio-filter.
6. Remove `spectrum` from struct initialization

- [ ] **Step 3: Delete spectrum.rs**

```bash
rm src-tauri/crates/audio-engine/src/output/spectrum.rs
```

Remove `pub mod spectrum;` from `src-tauri/crates/audio-engine/src/output/mod.rs`.

- [ ] **Step 4: Remove spectrum references in engine.rs**

Remove the `use crate::output::spectrum::SpectrumAnalyzer` reference in the sync_handler (should already be gone from Step 1).

- [ ] **Step 5: Verify compilation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles clean (new warnings about PwCaptureHandle may appear)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(audio): replace GStreamer spectrum with PipeWire capture"
```

---

### Task 4: Simplify emitter — render immediately

**Files:**
- Modify: `src-tauri/src/lib.rs`

The PwCapture writes `(0, magnitudes)` to spectrum_buf — timestamp 0 means "this data is from right now." The emitter should emit immediately with `stream_time_ms = 0` to signal the frontend to render on receive.

- [ ] **Step 1: Simplify emitter thread**

In `src-tauri/src/lib.rs`, the spectrum-emitter thread (~line 1945). Replace the current logic with:

```rust
std::thread::Builder::new()
    .name("spectrum-emitter".to_string())
    .spawn(move || {
        let mut last_data_hash: u64 = 0;

        loop {
            std::thread::sleep(std::time::Duration::from_millis(16));
            if !spectrum_flag.load(Ordering::Relaxed) {
                continue;
            }

            let fft = if let Ok(buf) = spectrum_buf.lock() {
                if buf.1.is_empty() {
                    continue;
                }
                // Simple change detection: check first + last + len
                let hash = (buf.1.len() as u64) ^ (buf.1[0] as u64) << 8
                    ^ (*buf.1.last().unwrap_or(&0) as u64) << 16;
                if hash == last_data_hash {
                    continue;
                }
                last_data_hash = hash;
                buf.1.clone()
            } else {
                continue;
            };

            let payload = FftPayload {
                stream_time_ms: 0, // "render now" — PW capture is already synced
                magnitudes: fft,
            };
            let _ = spectrum_handle.emit("audio-fft", &payload);
        }
    })
    .ok();
```

- [ ] **Step 2: Remove `spectrum_metrics` reference**

Remove the `let spectrum_metrics = engine.shared_metrics();` line and the `Ordering` import if no longer used elsewhere.

- [ ] **Step 3: Verify compilation**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(spectrum): emitter uses PW capture data (render-immediate)"
```

---

### Task 5: Simplify frontend — remove ring buffer, render on receive

**Files:**
- Modify: `src/components/SpectrumBackground.tsx`

With PipeWire capture, FFT data arrives already synchronized. The frontend renders immediately on receive — no temporal matching needed.

- [ ] **Step 1: Remove ring buffer and clock logic**

In `src/components/SpectrumBackground.tsx`:

1. Remove `RING_CAPACITY` const
2. Remove the ring buffer array, `ringHead`, clock anchors (`clockAnchorPerf`, `clockAnchorPos`, `clockPlaying`), `getPlaybackMs()` function
3. Remove the `createEffect` that syncs clock from `player.positionSecs`/`player.isPlaying`
4. Remove the diagnostic `_dbgCount` and `console.log` statements
5. In the `onAudioFft` callback: write directly to `rawFft` instead of ring buffer:

```typescript
onAudioFft((payload: FftPayload) => {
    const len = Math.min(payload.magnitudes.length, RAW_BANDS);
    for (let i = 0; i < len; i++) rawFft[i] = payload.magnitudes[i];
    for (let i = len; i < RAW_BANDS; i++) rawFft[i] = 0;
}).then(unsub => { unlisten = unsub; });
```

6. In `draw()`: remove the ring buffer scanning logic (the "Pick frame from ring buffer" section). The `rawFft` array is already populated by the event handler. Just proceed directly to the smoothing step.

- [ ] **Step 2: Remove FftPayload stream_time_ms usage**

The import of `FftPayload` stays (the type still exists), but we no longer read `stream_time_ms`. Can optionally remove it from the interface in `src/tauri.ts` or leave it for future use.

- [ ] **Step 3: Remove player import if unused**

If `player` was only imported for the clock sync effect, remove `import { player } from "../store/player"`. Keep it if still used for track color.

Check: `player.currentTrack` is still used for `getTrackColor`. Keep the import.

- [ ] **Step 4: Verify frontend builds**

Run: `npx vite build --mode development`

- [ ] **Step 5: Commit**

```bash
git add src/components/SpectrumBackground.tsx
git commit -m "refactor(spectrum): remove ring buffer, render FFT data immediately"
```

---

### Task 6: Clean up dead code

**Files:**
- Modify: `src-tauri/src/lib.rs` — Remove `SpectrumConfig::regroup()` (dead code warning)
- Modify: `src-tauri/src/lib.rs` — Remove `FftPayload.stream_time_ms` field (optional, can keep for debug)
- Modify: `src-tauri/crates/audio-engine/src/engine.rs` — Remove `position_ns` from SharedMetrics (no longer needed)

- [ ] **Step 1: Remove SpectrumConfig::regroup()**

Delete the `regroup` method from `SpectrumConfig` impl block (~line 75 in lib.rs).

- [ ] **Step 2: Remove position_ns from SharedMetrics**

In `engine.rs`, remove the `position_ns: AtomicU64` field and its initialization. Remove the `position_ns.store(...)` call in `maybe_emit_position()`.

- [ ] **Step 3: Verify**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: zero warnings about dead code for our code (gstreamer warnings may remain)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove dead spectrum sync code"
```

---

### Task 7: Integration test — full build and verify

- [ ] **Step 1: Full build**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --release`
Expected: compiles successfully

- [ ] **Step 2: Frontend build**

Run: `npx vite build --mode development`
Expected: no errors

- [ ] **Step 3: Release**

Run: `./scripts/release.sh`
Expected: .deb published to GitHub release

- [ ] **Step 4: Deploy and test on cmr-auto**

```bash
ssh cmr-auto@100.102.249.9 "gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.2.1_amd64.deb"
```

Test: play a track, observe spectrum is synchronized with audio (no 1.3s lead).

---

## Implementation Notes

### Why this works
PipeWire's monitor capture taps audio AFTER the sink processes it — the exact moment it reaches speakers. No pipeline buffering between analysis and output. The FFT data represents what the user hears NOW.

### Fallback
If PipeWire capture fails (e.g., node not found), the spectrum simply doesn't animate. The existing `spectrum_subscribe`/`unsubscribe` IPC still controls emission. A future enhancement could fall back to GStreamer spectrum with the manual delay slider.

### Target node discovery
We hardcode `"rustify-player"` as the node name. GStreamer's pipewiresink uses `application.name` from the pipeline, which matches our binary name. If this doesn't work, we can use `PW_KEY_TARGET_OBJECT` with the node ID (discoverable via `pw-cli`).

### Performance
- FFT of 1024 samples: ~10us on modern CPU
- Ring buffer ops: lock-free, zero allocation
- Thread count: +2 (PW capture, FFT worker) — acceptable for a desktop app
