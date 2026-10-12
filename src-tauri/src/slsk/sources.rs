//! sources.rs — configuração das fontes externas do Crate (SoundCloud,
//! Bandcamp) e das ferramentas que elas usam (ffmpeg, uv). Spec §2.5.
//!
//! Precedência por campo: env `RUSTIFY_*` > `sources.json` no data dir >
//! default. O arquivo guarda só CAMINHOS de segredo, nunca o segredo; o
//! conteúdo é lido sob demanda por [`read_secret_file`] e jamais vai para
//! log ou `Debug`.

#![allow(dead_code)] // consumido pelo sc-worker e pelos comandos (Tasks 6 e 7)

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

const CONFIG_FILE_NAME: &str = "sources.json";

#[derive(Clone)]
pub struct SourcesConfig {
    pub sc_token_file: PathBuf,
    pub bc_identity_file: PathBuf,
    pub bc_email: String,
    pub ffmpeg: String,
    pub uv: String,
}

impl std::fmt::Debug for SourcesConfig {
    // Só caminhos e nomes de binário: nenhum conteúdo de segredo.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourcesConfig")
            .field("sc_token_file", &self.sc_token_file)
            .field("bc_identity_file", &self.bc_identity_file)
            .field("bc_email_set", &!self.bc_email.is_empty())
            .field("ffmpeg", &self.ffmpeg)
            .field("uv", &self.uv)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenStatus {
    TokenOk,
    NoToken,
    ApiDown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SourcesStatus {
    pub soundcloud: TokenStatus,
    pub ffmpeg: bool,
    pub uv: bool,
    pub bandcamp_identity: bool,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct FileConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    soundcloud: Option<FileSoundCloud>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bandcamp: Option<FileBandcamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tools: Option<FileTools>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct FileSoundCloud {
    oauth_token_file: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct FileBandcamp {
    identity_file: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct FileTools {
    ffmpeg: Option<String>,
    uv: Option<String>,
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/home"))
}

/// Expande `~` / `~/...` pelo `HOME`.
fn expand_tilde(s: &str) -> PathBuf {
    if s == "~" {
        home_dir()
    } else if let Some(rest) = s.strip_prefix("~/") {
        home_dir().join(rest)
    } else {
        PathBuf::from(s)
    }
}

fn default_config() -> SourcesConfig {
    let home = home_dir();
    SourcesConfig {
        sc_token_file: home.join(".secrets").join("soundcloud-oauth.txt"),
        bc_identity_file: home.join(".secrets").join("bandcamp-identity.txt"),
        bc_email: String::new(),
        ffmpeg: "ffmpeg".to_string(),
        uv: home.join(".local").join("bin").join("uv").to_string_lossy().into_owned(),
    }
}

fn default_file() -> FileConfig {
    FileConfig {
        soundcloud: Some(FileSoundCloud {
            oauth_token_file: Some("~/.secrets/soundcloud-oauth.txt".into()),
        }),
        bandcamp: Some(FileBandcamp {
            identity_file: Some("~/.secrets/bandcamp-identity.txt".into()),
            email: Some(String::new()),
        }),
        tools: Some(FileTools {
            ffmpeg: Some("ffmpeg".into()),
            uv: Some("~/.local/bin/uv".into()),
        }),
    }
}

impl SourcesConfig {
    pub fn load(data_dir: &Path) -> Self {
        Self::load_with(data_dir, |key| std::env::var(key).ok())
    }

    pub(crate) fn load_with(data_dir: &Path, env: impl Fn(&str) -> Option<String>) -> Self {
        let mut cfg = default_config();
        let path = data_dir.join(CONFIG_FILE_NAME);
        match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<FileConfig>(&raw) {
                Ok(file) => cfg = merge_file(cfg, file),
                Err(e) => tracing::warn!(
                    path = %path.display(), error = %e,
                    "sources config: sources.json malformado, usando defaults"
                ),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => write_defaults(&path),
            Err(e) => tracing::warn!(
                path = %path.display(), error = %e,
                "sources config: falha ao ler sources.json, usando defaults"
            ),
        }
        apply_env_overrides(cfg, &env)
    }

    pub fn read_sc_token(&self) -> Result<String, String> {
        read_secret_file(&self.sc_token_file)
    }
}

/// Primeira execução: grava o arquivo com os defaults (tmp + rename) para o
/// usuário ter onde editar. Falha aqui não impede o boot.
fn write_defaults(path: &Path) {
    let Ok(json) = serde_json::to_string_pretty(&default_file()) else { return };
    let tmp = path.with_extension("json.tmp");
    let res = std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, path));
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        tracing::warn!(path = %path.display(), error = %e, "sources config: não consegui gravar os defaults");
    }
}

fn merge_file(mut cfg: SourcesConfig, file: FileConfig) -> SourcesConfig {
    if let Some(p) = file.soundcloud.and_then(|s| s.oauth_token_file) {
        cfg.sc_token_file = expand_tilde(&p);
    }
    if let Some(bc) = file.bandcamp {
        if let Some(p) = bc.identity_file {
            cfg.bc_identity_file = expand_tilde(&p);
        }
        if let Some(e) = bc.email {
            cfg.bc_email = e;
        }
    }
    if let Some(t) = file.tools {
        if let Some(f) = t.ffmpeg {
            cfg.ffmpeg = expand_tilde(&f).to_string_lossy().into_owned();
        }
        if let Some(u) = t.uv {
            cfg.uv = expand_tilde(&u).to_string_lossy().into_owned();
        }
    }
    cfg
}

fn apply_env_overrides(mut cfg: SourcesConfig, env: &impl Fn(&str) -> Option<String>) -> SourcesConfig {
    if let Some(v) = env("RUSTIFY_SC_TOKEN_FILE") {
        cfg.sc_token_file = expand_tilde(&v);
    }
    if let Some(v) = env("RUSTIFY_BC_IDENTITY_FILE") {
        cfg.bc_identity_file = expand_tilde(&v);
    }
    if let Some(v) = env("RUSTIFY_BC_EMAIL") {
        cfg.bc_email = v;
    }
    if let Some(v) = env("RUSTIFY_FFMPEG") {
        cfg.ffmpeg = expand_tilde(&v).to_string_lossy().into_owned();
    }
    if let Some(v) = env("RUSTIFY_UV") {
        cfg.uv = expand_tilde(&v).to_string_lossy().into_owned();
    }
    cfg
}

static PERM_WARNED: AtomicBool = AtomicBool::new(false);

/// Lê um arquivo de segredo: `trim`, vazio é erro. O conteúdo nunca entra
/// na mensagem de erro (só o caminho). No Unix avisa uma vez se o arquivo
/// for legível por grupo/outros.
pub fn read_secret_file(path: &Path) -> Result<String, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("não consegui ler o arquivo de segredo {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(md) = std::fs::metadata(path) {
            if md.permissions().mode() & 0o077 != 0 && !PERM_WARNED.swap(true, Ordering::Relaxed) {
                tracing::warn!(path = %path.display(), "arquivo de segredo com permissão aberta; use chmod 600");
            }
        }
    }
    let v = raw.trim();
    if v.is_empty() {
        return Err(format!("arquivo de segredo vazio: {}", path.display()));
    }
    Ok(v.to_string())
}

/// `(ffmpeg, uv)` disponíveis: roda `<ffmpeg> -version` e `<uv> --version`.
pub fn tools_status(cfg: &SourcesConfig) -> (bool, bool) {
    let ok = |bin: &str, arg: &str| {
        std::process::Command::new(bin)
            .arg(arg)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    (ok(&cfg.ffmpeg, "-version"), ok(&cfg.uv, "--version"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn load_le_arquivo_e_env_sobrepoe() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("sources.json"), r#"{"soundcloud":{"oauth_token_file":"/a/sc.txt"},"bandcamp":{"identity_file":"/a/bc.txt","email":"x@y"},"tools":{"ffmpeg":"/opt/ffmpeg","uv":"/opt/uv"}}"#).unwrap();
        let cfg = SourcesConfig::load_with(tmp.path(), |k| if k == "RUSTIFY_FFMPEG" { Some("/usr/bin/ffmpeg".into()) } else { None });
        assert_eq!(cfg.sc_token_file, PathBuf::from("/a/sc.txt"));
        assert_eq!(cfg.bc_email, "x@y");
        assert_eq!(cfg.ffmpeg, "/usr/bin/ffmpeg");
        assert_eq!(cfg.uv, "/opt/uv");
    }
    #[test]
    fn defaults_expandem_til() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = SourcesConfig::load_with(tmp.path(), |_| None);
        assert!(cfg.sc_token_file.ends_with(".secrets/soundcloud-oauth.txt"));
        assert!(cfg.sc_token_file.is_absolute());
        assert!(tmp.path().join("sources.json").exists(), "arquivo criado com defaults na primeira execução");
    }
    #[test]
    fn read_secret_file_faz_trim_e_erro_claro() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("t.txt");
        std::fs::write(&f, "  2-abc-def  \n").unwrap();
        assert_eq!(read_secret_file(&f).unwrap(), "2-abc-def");
        let err = read_secret_file(&tmp.path().join("nao.txt")).unwrap_err();
        assert!(err.contains("nao.txt"));
        std::fs::write(&f, "\n").unwrap();
        assert!(read_secret_file(&f).is_err(), "arquivo vazio e erro, nao token vazio");
    }
}
