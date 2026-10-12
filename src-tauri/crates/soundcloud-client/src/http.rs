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
use crate::{
    bitrate_estimate_kbps, ext_from_headers, ext_from_url, is_short_link, parse_search, parse_track,
    short_link_target, total_from_content_range, Original, ScError, ScTrack, SoundCloudApi,
};

const API: &str = "https://api-v2.soundcloud.com";
const HOME: &str = "https://soundcloud.com/";
const TIMEOUT: Duration = Duration::from_secs(15);
const CHUNK: usize = 256 * 1024;

pub struct HttpSoundCloud {
    agent: ureq::Agent,
    /// Mesmo agente sem seguir redirect: lê o `Location` do link curto sem
    /// baixar a página de destino.
    agent_no_redirect: ureq::Agent,
    cache_path: PathBuf,
    client_id: Mutex<Option<String>>,
}

impl HttpSoundCloud {
    /// `cache_path`: arquivo JSON do `client_id` (ex.:
    /// `<data_dir>/soundcloud_client_id.json`).
    pub fn new(cache_path: PathBuf, user_agent: String) -> Self {
        let builder = || {
            ureq::AgentBuilder::new()
                .timeout_connect(TIMEOUT)
                .timeout_read(TIMEOUT)
                .timeout_write(TIMEOUT)
                .user_agent(&user_agent)
        };
        let agent = builder().build();
        let agent_no_redirect = builder().redirects(0).build();
        Self { agent, agent_no_redirect, cache_path, client_id: Mutex::new(None) }
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

    /// `on.soundcloud.com/<id>` responde 302 para a página da faixa; o
    /// `/resolve` só aceita a página.
    fn expand_short_link(&self, url: &str) -> Result<String, ScError> {
        let resp = self.agent_no_redirect.get(url.trim()).call().map_err(map_err)?;
        resp.header("location")
            .and_then(short_link_target)
            .ok_or_else(|| ScError::Parse("o link curto não levou a uma faixa do SoundCloud".into()))
    }

    fn get_text(&self, url: &str) -> Result<String, ScError> {
        let resp = self.agent.get(url).call().map_err(map_err)?;
        resp.into_string().map_err(|e| ScError::Transport(e.to_string()))
    }

    /// GET na API v2 com `client_id`; a política de status está em [`decide`].
    fn api_get(&self, path_and_query: &str, token: Option<&str>) -> Result<String, ScError> {
        // Validado antes de qualquer rede: byte inválido no header faria o
        // ureq ecoar `Authorization: OAuth <token>` na mensagem de erro.
        let token = match token {
            Some(t) => Some(valid_token(t).ok_or(ScError::NoToken)?),
            None => None,
        };
        let mut retried = false;
        loop {
            let cid = self.client_id()?;
            let mut req = self.agent.get(&api_url(path_and_query, &cid));
            if let Some(t) = token {
                req = req.set("Authorization", &format!("OAuth {t}"));
            }
            let code = match req.call() {
                Ok(resp) => return resp.into_string().map_err(|e| ScError::Transport(e.to_string())),
                Err(ureq::Error::Status(code, _)) => code,
                Err(e) => return Err(map_err(e)),
            };
            match decide(code, token.is_some(), retried) {
                Acao::Falhar(e) => return Err(e),
                Acao::Renovar => {
                    retried = true;
                    self.invalidate_client_id();
                }
                Acao::Verificar => {
                    // 401 com token: token vencido OU client_id trocado (a API
                    // responde 401 nos dois). Uma chamada sem token desempata
                    // sem re-extrair à toa.
                    if self.client_id_ok(&cid)? {
                        return Err(ScError::NoToken);
                    }
                    retried = true;
                    self.invalidate_client_id();
                }
            }
        }
    }

    /// `true` se a API aceita o `client_id` numa chamada sem token.
    fn client_id_ok(&self, cid: &str) -> Result<bool, ScError> {
        match self.agent.get(&api_url("/search/tracks?q=a&limit=1", cid)).call() {
            Ok(_) => Ok(true),
            Err(ureq::Error::Status(401 | 403, _)) => Ok(false),
            Err(e) => Err(map_err(e)),
        }
    }

    /// Headers do original via HEAD; se o HEAD falhar, GET com
    /// `Range: bytes=0-0` (o Content-Range traz o tamanho total).
    fn probe_headers(&self, url: &str) -> Option<ProbeHeaders> {
        let read = |r: &ureq::Response, size: Option<u64>| ProbeHeaders {
            size,
            disposition: r.header("Content-Disposition").map(str::to_string),
            amz_file_type: r.header("x-amz-meta-file-type").map(str::to_string),
            content_type: r.header("Content-Type").map(str::to_string),
        };
        if let Ok(r) = self.agent.head(url).call() {
            let size = r.header("Content-Length").and_then(|v| v.trim().parse::<u64>().ok());
            return Some(read(&r, size));
        }
        let r = self.agent.get(url).set("Range", "bytes=0-0").call().ok()?;
        let size = if r.status() == 206 {
            r.header("Content-Range").and_then(total_from_content_range)
        } else {
            r.header("Content-Length").and_then(|v| v.trim().parse::<u64>().ok())
        };
        Some(read(&r, size))
    }
}

struct ProbeHeaders {
    size: Option<u64>,
    disposition: Option<String>,
    amz_file_type: Option<String>,
    content_type: Option<String>,
}

fn api_url(path_and_query: &str, cid: &str) -> String {
    let sep = if path_and_query.contains('?') { '&' } else { '?' };
    format!("{API}{path_and_query}{sep}client_id={cid}")
}

/// Token utilizável no header: sem espaço nas pontas (cópia e cola) e só
/// ASCII visível (0x21..=0x7E). Fora disso, `None`, sem ecoar o valor.
fn valid_token(t: &str) -> Option<&str> {
    let t = t.trim();
    (!t.is_empty() && t.bytes().all(|b| (0x21..=0x7E).contains(&b))).then_some(t)
}

/// O que fazer com um status de erro da API v2.
#[derive(Debug, PartialEq, Eq)]
enum Acao {
    /// Descartar o `client_id`, extrair de novo e repetir uma vez.
    Renovar,
    /// 401 com token: conferir o `client_id` sem token antes de culpar o token.
    Verificar,
    Falhar(ScError),
}

/// Política de status. 401 é ambíguo com token (a API devolve 401 tanto para
/// token inválido quanto para `client_id` vencido); 403 com token em
/// `/tracks/{id}/download` é "original indisponível para este cliente", não
/// `client_id` vencido, e não toca no cache.
fn decide(status: u16, has_token: bool, retried: bool) -> Acao {
    match (status, has_token) {
        (429, _) => Acao::Falhar(ScError::RateLimited),
        (401, true) if retried => Acao::Falhar(ScError::NoToken),
        (401, true) => Acao::Verificar,
        (401 | 403, false) if !retried => Acao::Renovar,
        (code, _) => Acao::Falhar(ScError::Http(code)),
    }
}

fn map_err(e: ureq::Error) -> ScError {
    match e {
        ureq::Error::Status(429, _) => ScError::RateLimited,
        ureq::Error::Status(code, _) => ScError::Http(code),
        ureq::Error::Transport(t) => ScError::Transport(transport_msg(&t)),
    }
}

/// Mensagem do erro de transporte sem a URL (a do original é assinada:
/// `Policy`/`Signature`/`Key-Pair-Id`) e sem o header (o `BadHeader` do ureq
/// cita `Authorization: OAuth <token>` inteiro).
fn transport_msg(t: &ureq::Transport) -> String {
    match t.kind() {
        ureq::ErrorKind::BadHeader => "header inválido no pedido".into(),
        ureq::ErrorKind::InvalidUrl => "URL inválida".into(),
        kind => match t.message() {
            Some(m) => format!("{kind}: {}", strip_queries(m)),
            None => kind.to_string(),
        },
    }
}

/// Corta query strings que porventura apareçam numa mensagem.
fn strip_queries(m: &str) -> String {
    m.split_whitespace()
        .map(|w| w.split('?').next().unwrap_or(w))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Capa só do CDN de imagens do SoundCloud: a URL vem do frontend e o Rust
/// não pode virar proxy para qualquer host.
fn artwork_host_ok(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') || authority.contains(':') {
        return false;
    }
    let host = authority.to_ascii_lowercase();
    host.ends_with(".sndcdn.com") && host.len() > ".sndcdn.com".len()
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
        let expanded;
        let url = if is_short_link(url) {
            expanded = self.expand_short_link(url)?;
            expanded.as_str()
        } else {
            url
        };
        let body = self.api_get(&format!("/resolve?url={}", urlenc(url)), None)?;
        parse_track(&body)
    }

    fn probe_original(&self, track_id: u64, token: &str, duration_ms: u64) -> Result<Original, ScError> {
        let body = self.api_get(&format!("/tracks/{track_id}/download"), Some(token))?;
        let raw: RawDownload =
            serde_json::from_str(&body).map_err(|e| ScError::Parse(e.to_string()))?;
        let url = raw.redirect_uri;
        // HEAD sem auth na URL assinada: tamanho e extensão (dos headers; o
        // caminho da URL real não tem extensão). Falha aqui não impede o
        // download; tamanho e extensão ficam desconhecidos.
        let h = self.probe_headers(&url);
        let size = h.as_ref().and_then(|h| h.size);
        let ext = h
            .as_ref()
            .and_then(|h| {
                ext_from_headers(h.disposition.as_deref(), h.amz_file_type.as_deref(), h.content_type.as_deref())
            })
            .or_else(|| ext_from_url(&url))
            .unwrap_or_default();
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
        if !artwork_host_ok(url) {
            return Err(ScError::Parse("host de capa não permitido".into()));
        }
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

    const SEGREDO: &str = "SEGREDO-DO-TOKEN";

    fn sc() -> HttpSoundCloud {
        // Cache com client_id falso: nenhum teste aqui deve chegar à rede.
        let dir = std::env::temp_dir().join(format!("sc-test-{}", std::process::id()));
        let cache = dir.join("cid.json");
        crate::client_id::write_cache(&cache, "vI5BsvpTIlavDLl7RDbbcFAPg8kls8Bg");
        HttpSoundCloud::new(cache, "rustify-player/teste".into())
    }

    #[test]
    fn token_invalido_vira_no_token_sem_ecoar_o_valor() {
        let api = sc();
        for tok in [
            format!("2-123456-{SEGREDO}\nX"),
            format!("2-123456-{SEGREDO}\u{200b}"),
            format!("2-123 {SEGREDO}"),
            "   ".to_string(),
        ] {
            for err in [api.me(&tok).unwrap_err(), api.probe_original(1, &tok, 1000).unwrap_err()] {
                assert_eq!(err, ScError::NoToken);
                assert!(!format!("{err}").contains(SEGREDO));
                assert!(!format!("{err:?}").contains(SEGREDO));
            }
        }
    }

    #[test]
    fn valid_token_apara_as_pontas() {
        assert_eq!(valid_token("  2-123-abc\n"), Some("2-123-abc"));
        assert_eq!(valid_token("2-123\tabc"), None);
        assert_eq!(valid_token("2-ção"), None);
    }

    #[test]
    fn bad_header_do_ureq_nao_vaza_o_header() {
        // O ureq valida o header antes de conectar: nenhuma rede envolvida.
        let agent = ureq::AgentBuilder::new().build();
        let e = agent
            .get("https://127.0.0.1:9/x?Policy=p&Signature=s")
            .set("Authorization", &format!("OAuth {SEGREDO}\n"))
            .call()
            .unwrap_err();
        // Sem a defesa, o Display do próprio ureq carrega o token.
        assert!(e.to_string().contains(SEGREDO));
        let mapped = map_err(e);
        assert_eq!(mapped, ScError::Transport("header inválido no pedido".into()));
        assert!(!format!("{mapped:?}").contains(SEGREDO));
    }

    #[test]
    fn erro_de_transporte_nao_carrega_a_url_assinada() {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_millis(500)).build();
        // Porta 9 (discard) em loopback: conexão recusada, sem rede externa.
        let e = agent.get("http://127.0.0.1:9/orig?Policy=PPP&Signature=SSS&Key-Pair-Id=KKK").call().unwrap_err();
        let msg = format!("{}", map_err(e));
        assert!(!msg.contains("Signature") && !msg.contains("SSS") && !msg.contains("127.0.0.1:9/orig"), "{msg}");
    }

    #[test]
    fn decide_cobre_a_politica_de_status() {
        // Sem token: 401/403 renovam o client_id uma vez.
        assert_eq!(decide(401, false, false), Acao::Renovar);
        assert_eq!(decide(403, false, false), Acao::Renovar);
        assert_eq!(decide(401, false, true), Acao::Falhar(ScError::Http(401)));
        assert_eq!(decide(403, false, true), Acao::Falhar(ScError::Http(403)));
        // Com token: 401 é ambíguo, confere o client_id; se persistir, é o token.
        assert_eq!(decide(401, true, false), Acao::Verificar);
        assert_eq!(decide(401, true, true), Acao::Falhar(ScError::NoToken));
        // Com token: 403 é "original indisponível", sem mexer no cache.
        assert_eq!(decide(403, true, false), Acao::Falhar(ScError::Http(403)));
        assert_eq!(decide(429, true, false), Acao::Falhar(ScError::RateLimited));
        assert_eq!(decide(429, false, false), Acao::Falhar(ScError::RateLimited));
        assert_eq!(decide(404, true, false), Acao::Falhar(ScError::Http(404)));
        assert_eq!(decide(500, false, false), Acao::Falhar(ScError::Http(500)));
    }

    #[test]
    fn capa_so_do_cdn_do_soundcloud() {
        assert!(artwork_host_ok("https://i1.sndcdn.com/artworks-abc-t500x500.jpg"));
        assert!(!artwork_host_ok("http://i1.sndcdn.com/a.jpg"));
        assert!(!artwork_host_ok("https://sndcdn.com.evil.net/a.jpg"));
        assert!(!artwork_host_ok("https://evil.net/?h=.sndcdn.com"));
        assert!(!artwork_host_ok("https://i1.sndcdn.com@127.0.0.1/a.jpg"));
        assert!(!artwork_host_ok("https://127.0.0.1:9223/x"));
        assert!(!artwork_host_ok("https://.sndcdn.com/a.jpg"));
        let err = sc().fetch_bytes("http://127.0.0.1:9223/", 10).unwrap_err();
        assert_eq!(err, ScError::Parse("host de capa não permitido".into()));
    }

    #[test]
    fn urlenc_codifica_acento_e_reservados() {
        assert_eq!(urlenc("mandelão"), "mandel%C3%A3o");
        assert_eq!(urlenc("https://soundcloud.com/a b"), "https%3A%2F%2Fsoundcloud.com%2Fa%20b");
    }
}
