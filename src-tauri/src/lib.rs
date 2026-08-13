// Crate root: despacho por plataforma.
//
// O corpo desktop (audio-engine/PipeWire, Qdrant sidecar, MPRIS via souvlaki,
// slskd) vive em desktop.rs e NÃO compila para Android — as deps são
// target-gated no Cargo.toml. O Android v0 (mobile.rs) é o shell mínimo:
// WebView + UI SolidJS; playback via plugin Kotlin Media3 (passo 2 do plano
// docs/prompts/13082026-rustify-android-v0.md).

// Módulos cross-platform (std + serde apenas). mobile_library compila em
// todos os targets para os testes de canon_stem rodarem no host.
pub(crate) mod device_identity;
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) mod mobile_library;
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) mod mobile_sync;
#[cfg(not(target_os = "android"))]
pub(crate) mod persistence;

// Módulos desktop-only: Qdrant sidecar e Soulseek dependem de
// library-indexer/slskd-client, ausentes do build Android.
#[cfg(not(target_os = "android"))]
pub(crate) mod qdrant_process;
#[cfg(not(target_os = "android"))]
pub(crate) mod slsk;
#[cfg(not(target_os = "android"))]
pub(crate) mod sync_receiver;

#[cfg(not(target_os = "android"))]
#[path = "desktop.rs"]
mod imp;

#[cfg(target_os = "android")]
#[path = "mobile.rs"]
mod imp;

// slsk/ referencia crate::Library (estado Tauri definido no corpo desktop).
#[cfg(not(target_os = "android"))]
pub(crate) use imp::Library;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    imp::run()
}
