//! Cliente Rust puro para a API do slskd (Soulseek daemon).
//!
//! Protocolo, ranking, pacing e destino de staging — 100% testável offline
//! contra fixtures reais. Sem dependência de Tauri ou Qdrant; a política
//! (coordinator, board, staging no disco) mora em `src-tauri/src/slsk/`.

pub mod error;
pub mod pacing;
pub mod rank;
pub mod wire;
