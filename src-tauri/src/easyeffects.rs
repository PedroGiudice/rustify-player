//! EasyEffects preset integration.
//!
//! EasyEffects stores output presets as JSON files in
//! `~/.config/easyeffects/output/`. The currently active preset name is
//! persisted in GSettings at `com.github.wwmm.easyeffects
//! last-used-output-preset`. Applying a preset works by invoking
//! `easyeffects -p <name>` which talks to the running EE daemon via D-Bus.
//!
//! All functions return `Err` when EasyEffects is not installed (no
//! `easyeffects` binary in `$PATH`). The frontend can use this to hide the
//! settings section entirely.

use std::process::Command;

/// Check that `easyeffects` is available. Cheap — just runs `which`.
fn is_installed() -> bool {
    Command::new("which")
        .arg("easyeffects")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn ee_config_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let p = std::path::PathBuf::from(home)
        .join(".config")
        .join("easyeffects")
        .join("output");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// List available output presets by scanning `~/.config/easyeffects/output/`.
/// Returns preset names without the `.json` extension, sorted alphabetically.
pub fn list_presets() -> Result<Vec<String>, String> {
    if !is_installed() {
        return Err("easyeffects not installed".into());
    }
    let dir = ee_config_dir().ok_or("easyeffects config dir not found")?;
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| format!("read_dir: {}", e))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                return None;
            }
            path.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        })
        .collect();
    names.sort_by_key(|s| s.to_lowercase());
    Ok(names)
}

/// Read the last-used preset name via GSettings. GSettings returns the value
/// quoted (e.g. `'My Preset'`), so strip the surrounding quotes.
pub fn get_current_preset() -> Result<String, String> {
    if !is_installed() {
        return Err("easyeffects not installed".into());
    }
    let out = Command::new("gsettings")
        .args([
            "get",
            "com.github.wwmm.easyeffects",
            "last-used-output-preset",
        ])
        .output()
        .map_err(|e| format!("gsettings spawn: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "gsettings failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let trimmed = raw
        .trim_matches(|c: char| c == '\'' || c == '"')
        .to_string();
    Ok(trimmed)
}

/// Apply a preset by invoking `easyeffects -p <name>`. Blocks until the
/// child process exits. On success the EE daemon should have switched
/// and updated the gsettings key.
pub fn apply_preset(name: &str) -> Result<(), String> {
    if !is_installed() {
        return Err("easyeffects not installed".into());
    }
    // Basic name validation — presets are plain filenames in a user dir,
    // but we still reject anything that could escape the arg or trip EE.
    // Reject leading '-' to avoid the arg being parsed as a CLI flag
    // (e.g. a preset literally named "-h" would become `easyeffects -p -h`).
    if name.is_empty()
        || name.contains('\0')
        || name.contains('/')
        || name.starts_with('-')
    {
        return Err("invalid preset name".into());
    }
    let status = Command::new("easyeffects")
        .args(["-p", name])
        .status()
        .map_err(|e| format!("easyeffects spawn: {}", e))?;
    if !status.success() {
        return Err(format!("easyeffects exited with {}", status));
    }
    Ok(())
}
