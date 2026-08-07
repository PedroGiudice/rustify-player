//! config.rs — descoberta e configuração do slskd (spec §3.3).
//!
//! Precedência por campo: env `RUSTIFY_SLSKD_*` > `~/.local/share/
//! rustify-player/slsk.json` > default. Parse de arquivo malformado nunca
//! derruba o boot: cai pro default com um `warn!` (mesmo espírito de
//! `persistence.rs::load` — nunca panic por config do usuário).

use std::path::{Path, PathBuf};

use serde::Deserialize;
use slskd_client::SlskAuth;

const CONFIG_FILE_NAME: &str = "slsk.json";
const DEFAULT_BASE_URL: &str = "http://127.0.0.1:5030";
const DEFAULT_USER: &str = "slskd";
const DEFAULT_PASS: &str = "slskd";

#[derive(Clone)]
pub struct SlskConfig {
    pub base_url: String,
    pub auth: SlskAuth,
    pub downloads_dir: PathBuf,
    pub container_prefix: Option<String>,
    /// NÃO faz parte do schema de `slsk.json` nem dos overrides de env —
    /// é a raiz do acervo (`~/Music`), a mesma fonte única usada em todo o
    /// resto do app (`lib.rs::dirs_home().join("Music")`). `load()` calcula
    /// um default consistente; o setup do app (`lib.rs`) sobrescreve com
    /// `library.music_root.clone()` logo após carregar, pra nunca divergir
    /// da raiz real. Existe aqui (em vez de um parâmetro extra em
    /// `spawn_coordinator`) porque o coordinator precisa dela tanto pra
    /// `stage_file` quanto pra `OwnedIndex::build`, e `SlskConfig` já é o
    /// pacote que ele carrega inteiro.
    pub music_root: PathBuf,
}

impl std::fmt::Debug for SlskConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SlskConfig")
            .field("base_url", &self.base_url)
            .field("auth", &self.auth)
            .field("downloads_dir", &self.downloads_dir)
            .field("container_prefix", &self.container_prefix)
            .field("music_root", &self.music_root)
            .finish()
    }
}

#[derive(Debug, Deserialize, Default)]
struct FileConfig {
    base_url: Option<String>,
    auth: Option<FileAuth>,
    downloads_dir: Option<String>,
    container_prefix: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum FileAuth {
    ApiKey { key: String },
    Password { user: String, pass: String },
}

fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/home"))
}

fn default_config() -> SlskConfig {
    SlskConfig {
        base_url: DEFAULT_BASE_URL.to_string(),
        auth: SlskAuth::Password {
            user: DEFAULT_USER.to_string(),
            pass: DEFAULT_PASS.to_string(),
        },
        downloads_dir: home_dir().join("slskd_dados").join("downloads"),
        container_prefix: None,
        music_root: home_dir().join("Music"),
    }
}

impl SlskConfig {
    /// `env RUSTIFY_SLSKD_{URL,API_KEY,USER,PASS,DOWNLOADS} > slsk.json
    /// (0600) > default`. Usa o ambiente de processo real — para testes
    /// determinísticos (sem mutar env vars globais entre threads), ver
    /// [`Self::load_with`].
    pub fn load(data_dir: &Path) -> Self {
        Self::load_with(data_dir, |key| std::env::var(key).ok())
    }

    fn load_with(data_dir: &Path, env: impl Fn(&str) -> Option<String>) -> Self {
        let mut cfg = default_config();
        if let Some(from_file) = Self::load_file(data_dir) {
            cfg = from_file;
        }
        apply_env_overrides(cfg, &env)
    }

    fn load_file(data_dir: &Path) -> Option<SlskConfig> {
        let path = data_dir.join(CONFIG_FILE_NAME);
        let raw = std::fs::read_to_string(&path).ok()?;
        match serde_json::from_str::<FileConfig>(&raw) {
            Ok(file) => Some(merge_file(default_config(), file)),
            Err(e) => {
                tracing::warn!(
                    path = %path.display(), error = %e,
                    "slsk config: slsk.json malformado, usando defaults"
                );
                None
            }
        }
    }
}

fn merge_file(mut cfg: SlskConfig, file: FileConfig) -> SlskConfig {
    if let Some(url) = file.base_url {
        cfg.base_url = url;
    }
    if let Some(dir) = file.downloads_dir {
        cfg.downloads_dir = PathBuf::from(dir);
    }
    if let Some(prefix) = file.container_prefix {
        cfg.container_prefix = Some(prefix);
    }
    if let Some(auth) = file.auth {
        cfg.auth = match auth {
            FileAuth::ApiKey { key } => SlskAuth::ApiKey(key),
            FileAuth::Password { user, pass } => SlskAuth::Password { user, pass },
        };
    }
    cfg
}

fn apply_env_overrides(mut cfg: SlskConfig, env: &impl Fn(&str) -> Option<String>) -> SlskConfig {
    if let Some(url) = env("RUSTIFY_SLSKD_URL") {
        cfg.base_url = url;
    }
    if let Some(dir) = env("RUSTIFY_SLSKD_DOWNLOADS") {
        cfg.downloads_dir = PathBuf::from(dir);
    }

    let api_key = env("RUSTIFY_SLSKD_API_KEY");
    let user = env("RUSTIFY_SLSKD_USER");
    let pass = env("RUSTIFY_SLSKD_PASS");

    if let Some(key) = api_key {
        cfg.auth = SlskAuth::ApiKey(key);
    } else if user.is_some() || pass.is_some() {
        let (base_user, base_pass) = match &cfg.auth {
            SlskAuth::Password { user, pass } => (user.clone(), pass.clone()),
            SlskAuth::ApiKey(_) => (DEFAULT_USER.to_string(), DEFAULT_PASS.to_string()),
        };
        cfg.auth = SlskAuth::Password {
            user: user.unwrap_or(base_user),
            pass: pass.unwrap_or(base_pass),
        };
    }
    cfg
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_map(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key: &str| map.get(key).cloned()
    }

    #[test]
    fn config_env_overrides_file() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join(CONFIG_FILE_NAME),
            r#"{"base_url": "http://127.0.0.1:9999", "downloads_dir": "/from/file"}"#,
        )
        .unwrap();

        let env = env_map(&[("RUSTIFY_SLSKD_URL", "http://127.0.0.1:1111")]);
        let cfg = SlskConfig::load_with(tmp.path(), env);

        // Env vence o arquivo no campo que ele cobre...
        assert_eq!(cfg.base_url, "http://127.0.0.1:1111");
        // ...mas o arquivo continua valendo pro que o env não tocou.
        assert_eq!(cfg.downloads_dir, PathBuf::from("/from/file"));
    }

    #[test]
    fn config_env_api_key_overrides_password_auth() {
        let tmp = tempfile::tempdir().unwrap();
        let env = env_map(&[("RUSTIFY_SLSKD_API_KEY", "top-secret")]);
        let cfg = SlskConfig::load_with(tmp.path(), env);
        match cfg.auth {
            SlskAuth::ApiKey(k) => assert_eq!(k, "top-secret"),
            SlskAuth::Password { .. } => panic!("esperava ApiKey"),
        }
    }

    #[test]
    fn config_bad_json_falls_back_default() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(CONFIG_FILE_NAME), "{ isso nao e json").unwrap();

        let cfg = SlskConfig::load_with(tmp.path(), |_| None);

        assert_eq!(cfg.base_url, DEFAULT_BASE_URL);
        match cfg.auth {
            SlskAuth::Password { user, pass } => {
                assert_eq!(user, DEFAULT_USER);
                assert_eq!(pass, DEFAULT_PASS);
            }
            SlskAuth::ApiKey(_) => panic!("esperava Password default"),
        }
    }

    #[test]
    fn config_missing_file_uses_default() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = SlskConfig::load_with(tmp.path(), |_| None);
        assert_eq!(cfg.base_url, DEFAULT_BASE_URL);
        assert_eq!(
            cfg.downloads_dir,
            home_dir().join("slskd_dados").join("downloads")
        );
    }
}
