//! Identidade estável do dispositivo — spec 2026-08-13-event-provenance.
//!
//! O arquivo `device.json` no data dir é a verdade: criado na primeira
//! execução a partir do hostname, imutável depois (renomear a máquina não
//! bifurca a identidade). Slug legível por decisão — a régua segmenta por
//! este valor e UUID opaco a tornaria ilegível.

use std::path::Path;

/// Lê (ou cria) o `device_id` persistido em `<data_dir>/device.json`.
///
/// Falhas de leitura/escrita nunca derrubam o boot: arquivo corrompido é
/// recriado do hostname; falha de escrita usa o valor em memória na sessão.
pub(crate) fn load_or_create(data_dir: &Path) -> String {
    let path = data_dir.join("device.json");

    if let Ok(raw) = std::fs::read_to_string(&path) {
        match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(v) => {
                if let Some(id) = v["device_id"].as_str().filter(|s| !s.is_empty()) {
                    return id.to_string();
                }
                tracing::warn!("device.json sem device_id válido — recriando do hostname");
            }
            Err(e) => {
                tracing::warn!(?e, "device.json corrompido — recriando do hostname");
            }
        }
    }

    let id = slugify(&hostname().unwrap_or_default());
    let id = if id.is_empty() { "unknown".to_string() } else { id };

    let body = serde_json::json!({ "device_id": id }).to_string();
    if let Err(e) = std::fs::write(&path, body) {
        tracing::warn!(?e, "falha ao persistir device.json — usando id em memória");
    }
    id
}

/// Android: o hostname do kernel é "localhost" — inútil como identidade. A
/// semente legível é o modelo do aparelho (SM-S921B → "sm-s921b").
/// device.json continua vencendo: semear outro id antes do 1º boot é
/// suportado (adb run-as em build debug).
#[cfg(target_os = "android")]
fn hostname() -> Option<String> {
    std::process::Command::new("getprop")
        .arg("ro.product.model")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Hostname da máquina. O app só shippa .deb Linux hoje — os caminhos de
/// procfs/etc cobrem o caso real; env `HOSTNAME` é o último recurso.
#[cfg(not(target_os = "android"))]
fn hostname() -> Option<String> {
    for path in ["/proc/sys/kernel/hostname", "/etc/hostname"] {
        if let Ok(s) = std::fs::read_to_string(path) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    std::env::var("HOSTNAME").ok().filter(|s| !s.is_empty())
}

/// Reduz um hostname a `[a-z0-9-]`: lowercase, runs de caracteres inválidos
/// viram um único `-`, sem `-` nas pontas.
fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_dash = false;
    for c in s.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(c);
        } else {
            pending_dash = true;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_sanitiza_hostname() {
        assert_eq!(slugify("cmr-auto"), "cmr-auto");
        assert_eq!(slugify("My Host.local"), "my-host-local");
        assert_eq!(slugify("EXTRACTLAB"), "extractlab");
        assert_eq!(slugify("--weird__name--"), "weird-name");
        assert_eq!(slugify(""), "");
    }

    #[test]
    fn primeira_chamada_cria_e_segunda_reusa() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create(dir.path());
        assert!(!first.is_empty());
        assert!(dir.path().join("device.json").exists());
        let second = load_or_create(dir.path());
        assert_eq!(first, second);
    }

    #[test]
    fn arquivo_existente_vence_o_hostname() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("device.json"),
            r#"{"device_id":"outro-device"}"#,
        )
        .unwrap();
        assert_eq!(load_or_create(dir.path()), "outro-device");
    }

    #[test]
    fn arquivo_corrompido_recria_sem_panic() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("device.json"), "not json{{{").unwrap();
        let id = load_or_create(dir.path());
        assert!(!id.is_empty());
        // e o arquivo foi reescrito com JSON válido
        let raw = std::fs::read_to_string(dir.path().join("device.json")).unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&raw).is_ok());
    }
}
