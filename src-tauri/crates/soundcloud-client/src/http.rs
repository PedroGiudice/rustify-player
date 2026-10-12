//! Implementação HTTP real do [`SoundCloudApi`] sobre `ureq`.
//!
//! O token OAuth só passa por parâmetro e vai direto para o header; nunca entra
//! em log, `Debug` ou mensagem de erro.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::client_id::{bundle_urls, drop_cache, extract_client_id, read_cache, write_cache};
use crate::wire::RawDownload;
use crate::{bitrate_estimate_kbps, ext_from_url, parse_search, parse_track, Original, ScError, ScTrack, SoundCloudApi};

const API: &str = "https://api-v2.soundcloud.com";
const HOME: &str = "https://soundcloud.com/";
const TIMEOUT: Duration = Duration::from_secs(15);
const CHUNK: usize = 256 * 1024;

pub struct HttpSoundCloud {
    agent: ureq::Agent,
    cache_path: PathBuf,
    client_id: Mutex<Option<String>>,
}

impl HttpSoundCloud {
    /// `cache_path`: arquivo JSON do `client_id` (ex.:
    /// `<data_dir>/soundcloud_client_id.json`).
    pub fn new(cache_path: PathBuf, user_agent: String) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(TIMEOUT)
            .timeout_read(TIMEOUT)
            .timeout_write(TIMEOUT)
            .user_agent(&user_agent)
            .build();
        Self { agent, cache_path, client_id: Mutex::new(None) }
    }

    /// `client_id` em memória, senão do cache em disco, senão extraído da home
    /// (bundles do último para o primeiro; o que carrega o id costuma ser o
    /// último).
    fn client_id(&self) -> Result<String, ScError> {
        let mut guard = self.client_id.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(id) = guard.as_ref() {
            return Ok(id.clone());
        }
        if let Some(id) = read_cache(&self.cache_path) {
            *guard = Some(id.clone());
            return Ok(id);
        }
        let home = self.get_text(HOME)?;
        for url in bundle_urls(&home).iter().rev() {
            let Ok(js) = self.get_text(url) else { continue };
            if let Some(id) = extract_client_id(&js) {
                write_cache(&self.cache_path, &id);
                *guard = Some(id.clone());
                return Ok(id);
            }
        }
        Err(ScError::Parse("client_id não encontrado nos bundles da home".into()))
    }

    fn invalidate_client_id(&self) {
        *self.client_id.lock().unwrap_or_else(|p| p.into_inner()) = None;
        drop_cache(&self.cache_path);
    }

    fn get_text(&self, url: &str) -> Result<String, ScError> {
        let resp = self.agent.get(url).call().map_err(map_err)?;
        resp.into_string().map_err(|e| ScError::Transport(e.to_string()))
    }

    /// GET na API v2 com `client_id`. Sem token, 401/403 descartam o
    /// `client_id` e tentam de novo uma vez. Com token, 401 é token recusado
    /// (`NoToken`) e só 403 renova o `client_id`.
    fn api_get(&self, path_and_query: &str, token: Option<&str>) -> Result<String, ScError> {
        let mut retried = false;
        loop {
            let cid = self.client_id()?;
            let sep = if path_and_query.contains('?') { '&' } else { '?' };
            let url = format!("{API}{path_and_query}{sep}client_id={cid}");
            let mut req = self.agent.get(&url);
            if let Some(t) = token {
                req = req.set("Authorization", &format!("OAuth {t}"));
            }
            match req.call() {
                Ok(resp) => return resp.into_string().map_err(|e| ScError::Transport(e.to_string())),
                Err(ureq::Error::Status(401, _)) if token.is_some() => return Err(ScError::NoToken),
                Err(ureq::Error::Status(code @ (401 | 403), _)) => {
                    if retried {
                        return Err(ScError::Http(code));
                    }
                    retried = true;
                    self.invalidate_client_id();
                }
                Err(e) => return Err(map_err(e)),
            }
        }
    }
}

fn map_err(e: ureq::Error) -> ScError {
    match e {
        ureq::Error::Status(429, _) => ScError::RateLimited,
        ureq::Error::Status(code, _) => ScError::Http(code),
        // A mensagem do transporte cita só a URL do pedido; o token vai no
        // header e não aparece nela.
        ureq::Error::Transport(t) => ScError::Transport(t.to_string()),
    }
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".part");
    dest.with_file_name(name)
}

/// Codifica um componente de query (RFC 3986, não reservados intactos).
/// Cópia do `urlenc` do `lyrics_fetch.rs`: crates não compartilham.
fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

impl SoundCloudApi for HttpSoundCloud {
    fn search(&self, q: &str, limit: u32) -> Result<Vec<ScTrack>, ScError> {
        let body = self.api_get(&format!("/search/tracks?q={}&limit={limit}", urlenc(q)), None)?;
        parse_search(&body)
    }

    fn resolve(&self, url: &str) -> Result<ScTrack, ScError> {
        let body = self.api_get(&format!("/resolve?url={}", urlenc(url)), None)?;
        parse_track(&body)
    }

    fn probe_original(&self, track_id: u64, token: &str, duration_ms: u64) -> Result<Original, ScError> {
        let body = self.api_get(&format!("/tracks/{track_id}/download"), Some(token))?;
        let raw: RawDownload =
            serde_json::from_str(&body).map_err(|e| ScError::Parse(e.to_string()))?;
        let url = raw.redirect_uri;
        // HEAD sem auth na URL assinada: só para o tamanho. Falha aqui não
        // impede o download; o tamanho fica desconhecido.
        let size = self
            .agent
            .head(&url)
            .call()
            .ok()
            .and_then(|r| r.header("Content-Length").and_then(|v| v.trim().parse::<u64>().ok()));
        let ext = ext_from_url(&url).unwrap_or_default();
        let kbps_est = match (size, duration_ms) {
            (Some(s), d) if d > 0 => Some(bitrate_estimate_kbps(s, d)),
            _ => None,
        };
        Ok(Original { url, ext, size, kbps_est })
    }

    fn download(
        &self,
        url: &str,
        dest: &Path,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<(), ScError> {
        let resp = self.agent.get(url).call().map_err(map_err)?;
        let total = resp.header("Content-Length").and_then(|v| v.trim().parse::<u64>().ok());
        let part = part_path(dest);
        let io = |e: std::io::Error| ScError::Transport(e.to_string());
        let result = (|| {
            let mut file = std::fs::File::create(&part).map_err(io)?;
            let mut reader = resp.into_reader();
            let mut buf = vec![0u8; CHUNK];
            let mut so_far: u64 = 0;
            let mut reported: u64 = 0;
            loop {
                let n = reader.read(&mut buf).map_err(io)?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n]).map_err(io)?;
                so_far += n as u64;
                if so_far - reported >= CHUNK as u64 {
                    reported = so_far;
                    progress(so_far, total);
                }
            }
            file.flush().map_err(io)?;
            file.sync_all().map_err(io)?;
            if let Some(t) = total {
                if so_far != t {
                    return Err(ScError::Transport(format!(
                        "download incompleto: {so_far} de {t} bytes"
                    )));
                }
            }
            progress(so_far, total);
            std::fs::rename(&part, dest).map_err(io)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&part);
        }
        result
    }

    fn fetch_bytes(&self, url: &str, max: usize) -> Result<Vec<u8>, ScError> {
        let resp = self.agent.get(url).call().map_err(map_err)?;
        let mut out = Vec::new();
        resp.into_reader()
            .take(max as u64 + 1)
            .read_to_end(&mut out)
            .map_err(|e| ScError::Transport(e.to_string()))?;
        if out.len() > max {
            return Err(ScError::Parse(format!("resposta maior que {max} bytes")));
        }
        Ok(out)
    }

    fn me(&self, token: &str) -> Result<(), ScError> {
        self.api_get("/me", Some(token)).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_path_acrescenta_sufixo() {
        assert_eq!(part_path(Path::new("/tmp/a/x.wav")), PathBuf::from("/tmp/a/x.wav.part"));
    }

    #[test]
    fn urlenc_codifica_acento_e_reservados() {
        assert_eq!(urlenc("mandelão"), "mandel%C3%A3o");
        assert_eq!(urlenc("https://soundcloud.com/a b"), "https%3A%2F%2Fsoundcloud.com%2Fa%20b");
    }
}
