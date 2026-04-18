# ADR 001 — Native PipeWire backend for audio-engine

- **Status:** Accepted
- **Date:** 2026-04-19
- **Branch:** `fix-playback-race-condition`

## Context

The `audio-engine` crate initially used `cpal` 0.17 as a cross-platform output
layer. On Linux, `cpal` talks to ALSA; on Ubuntu 24.04 that ALSA endpoint is
provided by the `libasound` compatibility plugin of PipeWire. The audible path
therefore looks like:

```
symphonia → cpal → ALSA-compat (libasound) → PipeWire graph → hardware
```

Three layers of indirection, three chances for a sample rate mismatch. After
commit `f1af547` ("request source sample rate when opening cpal stream") the
user still reported wrong pitch on high-rate FLACs (96 kHz, 192 kHz). Logs show
PipeWire silently re-negotiating the graph rate: the ALSA-compat plugin does
not forward the stream rate request to the daemon, so the requested rate is
applied only at the cpal edge and resampled away before reaching the sink.

Additional friction:

- `OutputMode::BitPerfect` cannot be bit-perfect on PipeWire without
  `PW_KEY_TARGET_OBJECT`, which `cpal` does not expose.
- `OutputMode::Jack` was dead on arrival — JACK on this setup is itself a
  PipeWire client.
- Device enumeration via `cpal::available_hosts()` reports one synthetic host
  on Linux; the user-visible sink list is opaque.

The project is Linux-only by design (EasyEffects, PipeWire, Ubuntu). There is
no Windows/macOS requirement, so the cross-platform ceiling of `cpal` buys
nothing.

## Decision

Replace the `cpal` backend with a native `pipewire-rs` 0.9 backend implementing
the same `AudioOutput` trait. Keep the rest of the engine untouched: state
machine, gapless preloading, `rtrb` SPSC decoder→RT ring buffer, decoder,
tests. The trait is already designed for swap — `configure()` returns an
`ActiveStream` that owns both the producer end and a backend-private
keepalive — so the replacement is drop-in.

Shape of the new backend:

- `PipewireBackend { xruns, mode }` implementing `AudioOutput`.
- `configure(format)` spawns a dedicated thread that owns the `MainLoopRc →
  ContextRc → Core → StreamBox` chain.
- Control-plane commands (currently just `Shutdown`) flow on a
  `pipewire::channel` attached to the loop. Audio data continues to flow on
  `rtrb`.
- `pipewire::init()` is already idempotent (internal `OnceCell`), no extra
  guard needed.
- `RT_PROCESS | AUTOCONNECT | MAP_BUFFERS` flags; zero allocation in the
  realtime `process` callback.
- Stream properties `MEDIA_TYPE=Audio`, `MEDIA_CATEGORY=Playback`,
  `MEDIA_ROLE=Music` so wireplumber routes through the user's default sink —
  which in this setup is the EasyEffects loopback.
- `EnumFormat` POD built with `libspa::param::audio::AudioInfoRaw` set to
  `F32LE`, track sample rate, source channels.

## Trade-offs

| Gain | Cost |
|------|------|
| Real sample rate negotiation per track — daemon actually honors the rate | Linux-only. Windows/macOS build breaks. Acceptable: project is Linux-only. |
| Direct path to `EXCLUSIVE + TARGET_OBJECT` for future real bit-perfect mode | Runtime dep `libpipewire-0.3-0` (present on every modern Ubuntu). Build dep `libpipewire-0.3-dev` + `libclang-dev` on the VM. |
| `MEDIA_ROLE=Music` means the stream shows up properly in EasyEffects / Helvum | `cargo check` now pulls `bindgen` (`pipewire-sys`), ~10 s added to cold builds. |
| Lose ~437 LOC of cpal adapter + all cpal error wrapping in `error.rs` | Need to author ~400 LOC of pipewire glue. Net LOC is roughly flat. |

## Alternatives rejected

- **Keep cpal, force `stream_config.sample_rate = format.sample_rate`.**
  Already tried (f1af547). Does not fix it — the ALSA-compat layer eats the
  request.
- **Go to raw ALSA via `alsa` crate.** Bypasses PipeWire entirely, which kills
  EasyEffects routing. Non-starter given the user's workflow.
- **Use the JACK backend in cpal.** Same problem: on this system JACK is
  provided by `pipewire-jack`, so we'd still be behind one more translation
  layer.
- **Wait for cpal to expose PipeWire natively.** No such PR in flight; no
  reason to believe cpal will ever acquire graph-aware APIs
  (`PW_KEY_TARGET_OBJECT`, exclusive reservation, MEDIA_ROLE).

## References

- pipewire-rs 0.9.2 crate docs:
  <https://pipewire.pages.freedesktop.org/pipewire-rs/pipewire/>
- Upstream audio playback example (`tone.rs`) in
  `pipewire/examples/tone.rs` — the closest template for our `process`
  callback.
- PipeWire C tutorial 4 (structurally equivalent):
  <https://docs.pipewire.org/page_tutorial4.html>
- The diagnostic commit showing cpal cannot fix the sample rate:
  `git show f1af547`.
- Current trait: `src-tauri/crates/audio-engine/src/output/mod.rs:37-47`.
