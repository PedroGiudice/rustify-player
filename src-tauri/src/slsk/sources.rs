//! sources.rs — configuração das fontes externas do Crate (SoundCloud,
//! Bandcamp) e das ferramentas que elas usam (ffmpeg, uv). Spec §7.
//!
//! Precedência por campo: env `RUSTIFY_*` > `sources.json` no data dir >
//! default. O arquivo guarda só CAMINHOS de segredo, nunca o segredo; o
//! conteúdo é lido sob demanda por [`read_secret_file`] e jamais vai para
//! log ou `Debug`.

use std::path::{Path, PathBuf};
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const CONFIG_FILE_NAME: &str = "sources.json";

#[derive(Clone)]
pub struct SourcesConfig {
    pub sc_token_file: PathBuf,
    pub bc_identity_file: PathBuf,
    pub bc_email: String,
    pub ffmpeg: String,
    pub uv: String,
    /// Base da fila de downloads da Tidal (`scripts/curator/tidal_fila.py`
    /// na VM) — só esquema+host+porta, nunca o token. O token vai
    /// concatenado no CAMINHO da URL na hora da chamada, lido sob demanda
    /// de `tidal_fila_token_file`.
    pub tidal_fila_url: String,
    pub tidal_fila_token_file: PathBuf,
}

impl std::fmt::Debug for SourcesConfig {
    // Só caminhos e nomes de binário: nenhum conteúdo de segredo.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourcesConfig")
            .field("sc_token_file", &safe_path(&self.sc_token_file))
            .field("bc_identity_file", &safe_path(&self.bc_identity_file))
            .field("bc_email_set", &!self.bc_email.is_empty())
            .field("ffmpeg", &self.ffmpeg)
            .field("uv", &self.uv)
            .field("tidal_fila_url", &self.tidal_fila_url)
            .field("tidal_fila_token_file", &safe_path(&self.tidal_fila_token_file))
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
    /// Só `TokenOk`/`NoToken` (arquivo legível ou não) — a fila da Tidal
    /// não é consultada aqui; o `ApiDown` da variante fica reservado para
    /// o SoundCloud.
    pub tidal: TokenStatus,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct FileConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    soundcloud: Option<FileSoundCloud>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bandcamp: Option<FileBandcamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tools: Option<FileTools>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tidal: Option<FileTidal>,
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

#[derive(Debug, Serialize, Deserialize, Default)]
struct FileTidal {
    fila_url: Option<String>,
    token_file: Option<String>,
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

/// Host:porta padrão da fila da Tidal na VM (tailnet) — `tidal_fila.py`.
const DEFAULT_TIDAL_FILA_URL: &str = "http://100.64.242.118:8470";

fn default_config() -> SourcesConfig {
    let home = home_dir();
    SourcesConfig {
        sc_token_file: home.join(".secrets").join("soundcloud-oauth.txt"),
        bc_identity_file: home.join(".secrets").join("bandcamp-identity.txt"),
        bc_email: String::new(),
        ffmpeg: "ffmpeg".to_string(),
        uv: home.join(".local").join("bin").join("uv").to_string_lossy().into_owned(),
        tidal_fila_url: DEFAULT_TIDAL_FILA_URL.to_string(),
        tidal_fila_token_file: home.join(".secrets").join("telemetria-token.txt"),
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
        tidal: Some(FileTidal {
            fila_url: Some(DEFAULT_TIDAL_FILA_URL.into()),
            token_file: Some("~/.secrets/telemetria-token.txt".into()),
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
                // Só linha/coluna: o Display do serde_json cita o valor, que
                // pode ser um segredo colado no lugar do caminho.
                Err(e) => tracing::warn!(
                    path = %path.display(), line = e.line(), column = e.column(),
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

    pub fn read_tidal_token(&self) -> Result<String, String> {
        read_secret_file(&self.tidal_fila_token_file)
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
    if let Some(t) = file.tidal {
        if let Some(u) = t.fila_url {
            cfg.tidal_fila_url = u;
        }
        if let Some(p) = t.token_file {
            cfg.tidal_fila_token_file = expand_tilde(&p);
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
    if let Some(v) = env("RUSTIFY_TIDAL_FILA_URL") {
        cfg.tidal_fila_url = v;
    }
    if let Some(v) = env("RUSTIFY_TIDAL_FILA_TOKEN_FILE") {
        cfg.tidal_fila_token_file = expand_tilde(&v);
    }
    cfg
}

/// Caminhos de segredo já avisados por permissão aberta (um aviso por arquivo).
static PERM_WARNED: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// Representação de um caminho de segredo segura para log, `Debug` e
/// mensagem de erro. Caminho que não começa por `/` ou `~` pode ser o
/// próprio segredo colado no campo errado: aí só o tamanho aparece.
fn safe_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if s.starts_with('/') || s.starts_with('~') {
        s.into_owned()
    } else {
        format!("<caminho não absoluto, {} caracteres>", s.chars().count())
    }
}

/// Lê um arquivo de segredo: `trim`, vazio é erro. O conteúdo nunca entra
/// na mensagem de erro (só o caminho, via [`safe_path`]). No Unix avisa uma
/// vez por arquivo se ele for legível por grupo/outros.
pub fn read_secret_file(path: &Path) -> Result<String, String> {
    let shown = safe_path(path);
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("não consegui ler o arquivo de segredo {shown}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(md) = std::fs::metadata(path) {
            if md.permissions().mode() & 0o077 != 0 && first_perm_warning(path) {
                tracing::warn!(path = %shown, "arquivo de segredo com permissão aberta; use chmod 600");
            }
        }
    }
    let v = raw.trim();
    if v.is_empty() {
        return Err(format!("arquivo de segredo vazio: {shown}"));
    }
    Ok(v.to_string())
}

/// `true` na primeira vez que o caminho é visto com permissão aberta.
fn first_perm_warning(path: &Path) -> bool {
    let mut g = PERM_WARNED.lock().unwrap_or_else(|e| e.into_inner());
    g.get_or_insert_with(HashSet::new).insert(path.to_path_buf())
}

/// Teto de cada sonda de ferramenta: o status inteiro responde em < 2 s.
const TOOL_PROBE_TIMEOUT: Duration = Duration::from_millis(600);

/// `(ffmpeg, uv)` disponíveis. O ffmpeg usa a mesma sonda do worker
/// (`ffmpeg` + `ffprobe` derivado do diretório, com teto); o uv roda
/// `--version` com teto curto.
pub fn tools_status(cfg: &SourcesConfig) -> (bool, bool) {
    let mut tools = library_indexer::transcode::Tools::from_ffmpeg(&cfg.ffmpeg);
    tools.probe_timeout = TOOL_PROBE_TIMEOUT;
    let ffmpeg = library_indexer::transcode::ffmpeg_available(&tools);
    (ffmpeg, runs_ok(&cfg.uv, "--version", TOOL_PROBE_TIMEOUT))
}

/// Executa `<bin> <arg>` sem saída; `false` se falhar ou passar do teto
/// (o processo é encerrado).
fn runs_ok(bin: &str, arg: &str, teto: Duration) -> bool {
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new(bin)
        .arg(arg)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let prazo = Instant::now() + teto;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return st.success(),
            Ok(None) if Instant::now() < prazo => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Base64 padrão (RFC 4648, com `=`), para a capa do card virar data URL.
/// Vinte linhas em vez de um crate novo: só codifica, nunca decodifica.
pub fn base64_encode(bytes: &[u8]) -> String {
    const ALFABETO: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for bloco in bytes.chunks(3) {
        let b = [bloco[0], *bloco.get(1).unwrap_or(&0), *bloco.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= bloco.len() {
                out.push(ALFABETO[((n >> (18 - 6 * i)) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn base64_encode_bate_com_a_rfc() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd, 0x00]), "//79AA==");
    }
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
        assert!(read_secret_file(&f).is_err(), "arquivo vazio é erro, não token vazio");
    }
    #[test]
    fn ida_e_volta_expande_til_do_arquivo_gravado() {
        let tmp = tempfile::tempdir().unwrap();
        let a = SourcesConfig::load_with(tmp.path(), |_| None);
        let raw = std::fs::read_to_string(tmp.path().join("sources.json")).unwrap();
        assert!(raw.contains("~/.secrets/soundcloud-oauth.txt"), "defaults gravados com ~");
        let b = SourcesConfig::load_with(tmp.path(), |_| None);
        assert!(b.sc_token_file.is_absolute() && b.bc_identity_file.is_absolute());
        assert!(Path::new(&b.uv).is_absolute());
        assert_eq!(a.sc_token_file, b.sc_token_file);
        assert_eq!(a.bc_identity_file, b.bc_identity_file);
        assert_eq!(a.uv, b.uv);
    }
    #[test]
    fn til_no_arquivo_vira_home() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("sources.json"), r#"{"soundcloud":{"oauth_token_file":"~/x/sc.txt"}}"#).unwrap();
        let cfg = SourcesConfig::load_with(tmp.path(), |_| None);
        assert_eq!(cfg.sc_token_file, home_dir().join("x/sc.txt"));
    }
    #[test]
    fn env_sobrepoe_as_cinco_variaveis() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = SourcesConfig::load_with(tmp.path(), |k| match k {
            "RUSTIFY_SC_TOKEN_FILE" => Some("/e/sc.txt".into()),
            "RUSTIFY_BC_IDENTITY_FILE" => Some("~/e/bc.txt".into()),
            "RUSTIFY_BC_EMAIL" => Some("e@mail".into()),
            "RUSTIFY_FFMPEG" => Some("/e/ffmpeg".into()),
            "RUSTIFY_UV" => Some("/e/uv".into()),
            _ => None,
        });
        assert_eq!(cfg.sc_token_file, PathBuf::from("/e/sc.txt"));
        assert_eq!(cfg.bc_identity_file, home_dir().join("e/bc.txt"));
        assert_eq!(cfg.bc_email, "e@mail");
        assert_eq!(cfg.ffmpeg, "/e/ffmpeg");
        assert_eq!(cfg.uv, "/e/uv");
    }
    #[test]
    fn tidal_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = SourcesConfig::load_with(tmp.path(), |_| None);
        assert_eq!(cfg.tidal_fila_url, DEFAULT_TIDAL_FILA_URL);
        assert!(cfg.tidal_fila_token_file.ends_with(".secrets/telemetria-token.txt"));
        assert!(cfg.tidal_fila_token_file.is_absolute());
        let raw = std::fs::read_to_string(tmp.path().join("sources.json")).unwrap();
        assert!(raw.contains("~/.secrets/telemetria-token.txt"), "defaults gravados com ~: {raw}");
    }
    #[test]
    fn tidal_arquivo_e_env_sobrepoem() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("sources.json"),
            r#"{"tidal":{"fila_url":"http://1.2.3.4:9000","token_file":"~/x/tok.txt"}}"#,
        )
        .unwrap();
        let cfg = SourcesConfig::load_with(tmp.path(), |_| None);
        assert_eq!(cfg.tidal_fila_url, "http://1.2.3.4:9000");
        assert_eq!(cfg.tidal_fila_token_file, home_dir().join("x/tok.txt"));

        let cfg = SourcesConfig::load_with(tmp.path(), |k| match k {
            "RUSTIFY_TIDAL_FILA_URL" => Some("http://5.6.7.8:1111".into()),
            "RUSTIFY_TIDAL_FILA_TOKEN_FILE" => Some("/e/tok.txt".into()),
            _ => None,
        });
        assert_eq!(cfg.tidal_fila_url, "http://5.6.7.8:1111");
        assert_eq!(cfg.tidal_fila_token_file, PathBuf::from("/e/tok.txt"));
    }
    #[test]
    fn tidal_token_file_nao_vaza_no_debug() {
        let cfg = SourcesConfig { tidal_fila_token_file: PathBuf::from("2-SEGREDO-no-caminho"), ..default_config() };
        assert!(!format!("{cfg:?}").contains("SEGREDO"));
    }
    #[test]
    fn segredo_colado_no_caminho_nao_vaza() {
        let token = "2-123456-abcdefSEGREDO";
        let cfg = SourcesConfig { sc_token_file: PathBuf::from(token), ..default_config() };
        assert!(!format!("{cfg:?}").contains(token));
        let err = read_secret_file(Path::new(token)).unwrap_err();
        assert!(!err.contains(token), "{err}");
    }
    #[cfg(unix)]
    #[test]
    fn aviso_de_permissao_e_por_arquivo() {
        let tmp = tempfile::tempdir().unwrap();
        let (a, b) = (tmp.path().join("a"), tmp.path().join("b"));
        assert!(first_perm_warning(&a));
        assert!(!first_perm_warning(&a));
        assert!(first_perm_warning(&b));
    }
    #[cfg(unix)]
    #[test]
    fn ffmpeg_sem_ffprobe_e_indisponivel() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let ff = tmp.path().join("ffmpeg");
        std::fs::write(&ff, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&ff, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cfg = SourcesConfig { ffmpeg: ff.to_string_lossy().into_owned(), uv: "/nao/existe/uv".into(), ..default_config() };
        assert_eq!(tools_status(&cfg), (false, false));
        let fp = tmp.path().join("ffprobe");
        std::fs::copy(&ff, &fp).unwrap();
        std::fs::set_permissions(&fp, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(tools_status(&cfg).0, "com ffprobe ao lado, disponível");
    }
}
