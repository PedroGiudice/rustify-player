---
name: Migracao pipewire-rs concluida
description: Backend audio migrado de cpal para pipewire-rs nativo em 2026-04-19, validado na cmr-auto com reproducao normal.
type: project
---

Migracao cpal → pipewire-rs concluida e validada em 2026-04-19.

**Commits (branch fix-playback-race-condition):**
- cb5b123 — ADR 001 pipewire native backend
- af87fd8 — remove OutputMode::Jack
- 4ccf74b — replace cpal backend com pipewire-rs (649 LOC)
- aef569c — remove OutputMode, DeviceInfo, device picker

**Resultado:** audio reproduz normalmente na cmr-auto. Usuario reporta "melhorou 100x comparado com antes".

**Estado atual do crate audio-engine:**
- pipewire 0.9 + libspa 0.9, sem cpal
- PipewireBackend::new() sem parametros — unica rota e AUTOCONNECT + MEDIA_ROLE=Music
- 14 tests passando, 0 clippy warnings
- Build deps: libpipewire-0.3-dev + libclang-dev na VM

**Pendencias carryover:**
1. Tech badge — app nao mostra qualidade da reproducao (bit_depth, sample_rate). Precisa popular TrackInfo com bits_per_sample do symphonia.
2. Preset picker EasyEffects — CLI wrapper + dropdown em Settings (D-Bus com.github.wwmm.easyeffects).
3. Volume — testar proporcionalidade apos migracao.
4. 2x clicks pra tocar — investigar play_on_load.
