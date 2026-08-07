//! slsk — política do Crate (busca + download Soulseek in-app).
//!
//! Nome do módulo é `slsk` porque `crate` é keyword reservada; o rótulo de
//! UI é **Crate**. Este módulo conhece slskd + Qdrant + Tauri — o protocolo
//! puro (testável offline) vive em `slskd-client` (crate irmão).
//!
//! Cresce em 4 tasks (spec `docs/superpowers/specs/
//! 2026-08-07-crate-in-app-downloads-design.md`, plano
//! `.superpowers/sdd/2026-08-07-crate-v1/etapa-C-brief.md`):
//! C1 config+board (aqui), C2 stage, C3 coordinator, C4 os `#[tauri::command]`
//! e o wiring em `lib.rs`.

mod board;
mod config;

pub use board::JobBoard;
pub use config::SlskConfig;
