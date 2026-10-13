//! tidal_fila.rs — cliente HTTP para a fila de downloads da Tidal que roda
//! na VM (`scripts/curator/tidal_fila.py`, tmux `telemetria`). O app NÃO
//! fala com a Tidal: só consulta/enfileira na fila, que faz o download de
//! verdade e envia pra `cmr-auto:~/Music` por conta própria.
//!
//! API fixa (ver o script): `GET/POST <tidal_fila_url>/<token>/api/fila`.
//! O token vai no CAMINHO da URL — nunca em log, `Debug`, evento ou erro
//! devolvido ao frontend. `SourcesConfig::tidal_fila_url` guarda só
//! esquema+host+porta (sem token), seguro para aparecer em mensagem de
//! erro.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::sources::SourcesConfig;

const TIMEOUT: Duration = Duration::from_secs(10);

/// Um job da fila, como a API devolve (o campo `log` do script já vem
/// removido na origem).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct TidalJob {
    pub id: String,
    pub url: String,
    pub playlist: String,
    /// `fila | baixando | ok | parcial | falhou`.
    pub status: String,
    pub added: String,
    #[serde(default)]
    pub resumo: String,
    #[serde(default)]
    pub inicio: Option<String>,
    #[serde(default)]
    pub fim: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct FilaSnapshot {
    pub jobs: Vec<TidalJob>,
    pub pastas: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
struct ErrBody {
    error: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct EnqueueOk {
    id: Option<String>,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(TIMEOUT)
        .timeout_read(TIMEOUT)
        .timeout_write(TIMEOUT)
        .build()
}

/// Endpoint completo (com o token no caminho) — nunca sai da função que
/// monta a request; erros usam [`host_port`], não isto.
fn endpoint(cfg: &SourcesConfig, token: &str) -> String {
    format!("{}/{}/api/fila", cfg.tidal_fila_url.trim_end_matches('/'), token)
}

/// `host:porta` seguro para mensagem de erro — `tidal_fila_url` nunca
/// carrega o token (ele só entra em [`endpoint`], concatenado depois).
fn host_port(cfg: &SourcesConfig) -> &str {
    cfg.tidal_fila_url.trim_end_matches('/')
}

const SEM_TOKEN: &str = "token da fila indisponível (veja o status das fontes)";

fn offline_msg(cfg: &SourcesConfig) -> String {
    format!("fila indisponível (VM fora? {})", host_port(cfg))
}

/// Lista os jobs e as pastas conhecidas pela fila. Nunca bloqueia além do
/// `TIMEOUT`; erro de rede e erro de token viram mensagem para o usuário.
pub fn list_jobs(cfg: &SourcesConfig) -> Result<FilaSnapshot, String> {
    let token = cfg.read_tidal_token().map_err(|_| SEM_TOKEN.to_string())?;
    let resp = agent().get(&endpoint(cfg, &token)).call().map_err(|_| offline_msg(cfg))?;
    resp.into_json::<FilaSnapshot>().map_err(|e| format!("resposta inválida da fila ({}): {e}", host_port(cfg)))
}

/// Enfileira um download. Validação do link acontece ANTES de qualquer
/// chamada de rede (mesma regra da fila, espelhada em
/// [`is_valid_tidal_link`]) — evita gastar uma chamada em link óbvio.
pub fn enqueue(cfg: &SourcesConfig, url: &str, playlist: &str) -> Result<String, String> {
    let url = url.trim();
    if !is_valid_tidal_link(url) {
        return Err("link não reconhecido: use um link da Tidal de mix, playlist, álbum ou faixa".to_string());
    }
    let playlist = playlist.trim();
    if playlist.is_empty() {
        return Err("pasta vazia".to_string());
    }
    let token = cfg.read_tidal_token().map_err(|_| SEM_TOKEN.to_string())?;
    let body = serde_json::json!({ "url": url, "playlist": playlist });
    match agent().post(&endpoint(cfg, &token)).send_json(body) {
        Ok(resp) => {
            let ok: EnqueueOk = resp.into_json().map_err(|e| format!("resposta inválida da fila ({}): {e}", host_port(cfg)))?;
            ok.id.ok_or_else(|| format!("fila ({}) não devolveu o id do job", host_port(cfg)))
        }
        Err(ureq::Error::Status(400, resp)) => {
            let body: ErrBody = resp.into_json().unwrap_or_default();
            Err(body.error.unwrap_or_else(|| "link ou pasta inválidos".to_string()))
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("fila ({}) respondeu {code}", host_port(cfg))),
        Err(ureq::Error::Transport(_)) => Err(offline_msg(cfg)),
    }
}

/// Mesma regra de `URL_RE` do `tidal_fila.py`
/// (`^https?://(listen\.|www\.)?tidal\.com/(browse/)?(mix|playlist|album|track)/[A-Za-z0-9-]+`),
/// escrita à mão porque o app não tem a crate `regex`. Como o Python usa
/// `re.match` (prefixo, sem `$`), basta o primeiro caractere do id ser
/// válido — o que vier depois (querystring, barra, etc.) é irrelevante
/// tanto lá quanto aqui.
pub fn is_valid_tidal_link(url: &str) -> bool {
    let rest = url.trim();
    let Some(rest) = rest.strip_prefix("https://").or_else(|| rest.strip_prefix("http://")) else {
        return false;
    };
    let rest = rest.strip_prefix("listen.").or_else(|| rest.strip_prefix("www.")).unwrap_or(rest);
    let Some(rest) = rest.strip_prefix("tidal.com/") else {
        return false;
    };
    let rest = rest.strip_prefix("browse/").unwrap_or(rest);
    let Some(rest) = rest
        .strip_prefix("mix/")
        .or_else(|| rest.strip_prefix("playlist/"))
        .or_else(|| rest.strip_prefix("album/"))
        .or_else(|| rest.strip_prefix("track/"))
    else {
        return false;
    };
    matches!(rest.chars().next(), Some(c) if c.is_ascii_alphanumeric() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn cfg() -> SourcesConfig {
        SourcesConfig {
            sc_token_file: PathBuf::from("/nao/existe"),
            bc_identity_file: PathBuf::from("/nao/existe"),
            bc_email: String::new(),
            ffmpeg: "ffmpeg".into(),
            uv: "uv".into(),
            tidal_fila_url: "http://10.0.0.1:8470".into(),
            tidal_fila_token_file: PathBuf::from("/nao/existe/token.txt"),
        }
    }

    // ── validação do link (paridade com URL_RE do tidal_fila.py) ──────
    #[test]
    fn aceita_mix_playlist_album_track() {
        assert!(is_valid_tidal_link("https://tidal.com/mix/abc123"));
        assert!(is_valid_tidal_link("https://tidal.com/playlist/xyz-789"));
        assert!(is_valid_tidal_link("https://tidal.com/album/123"));
        assert!(is_valid_tidal_link("https://tidal.com/track/456"));
    }
    #[test]
    fn aceita_listen_www_e_browse() {
        assert!(is_valid_tidal_link("https://listen.tidal.com/mix/abc"));
        assert!(is_valid_tidal_link("https://www.tidal.com/mix/abc"));
        assert!(is_valid_tidal_link("http://tidal.com/browse/album/abc-123"));
        assert!(is_valid_tidal_link("https://listen.tidal.com/browse/playlist/abc"));
    }
    #[test]
    fn aceita_sufixo_apos_o_id_como_o_re_match_do_python() {
        // re.match não exige fim de string: querystring ou barra depois do
        // id ainda casa, desde que o 1º caractere do id seja válido.
        assert!(is_valid_tidal_link("https://tidal.com/track/12345?si=abc"));
        assert!(is_valid_tidal_link("https://tidal.com/mix/abc/extra/path"));
    }
    #[test]
    fn recusa_outros_dominios_e_lixo() {
        assert!(!is_valid_tidal_link("https://soundcloud.com/track/abc"));
        assert!(!is_valid_tidal_link("https://bandcamp.com/album/abc"));
        assert!(!is_valid_tidal_link("lixo total"));
        assert!(!is_valid_tidal_link(""));
        assert!(!is_valid_tidal_link("tidal.com/mix/abc")); // sem esquema
    }
    #[test]
    fn recusa_tipo_desconhecido_ou_id_vazio() {
        assert!(!is_valid_tidal_link("https://tidal.com/artist/abc"));
        assert!(!is_valid_tidal_link("https://tidal.com/mix/"));
        assert!(!is_valid_tidal_link("https://tidal.com/mix"));
    }

    // ── parse do JSON da API (fixture com os 5 estados) ────────────────
    #[test]
    fn parse_fila_snapshot_com_os_cinco_estados() {
        let raw = r#"{
            "jobs": [
                {"id":"1","url":"https://tidal.com/mix/a","playlist":"Jazz","status":"fila","added":"13/10 10:00","resumo":""},
                {"id":"2","url":"https://tidal.com/mix/b","playlist":"Jazz","status":"baixando","added":"13/10 10:01","resumo":"baixando..."},
                {"id":"3","url":"https://tidal.com/mix/c","playlist":"Jazz","status":"ok","added":"13/10 09:00","resumo":"Mix X: 10 novas, 5 já no acervo, 0 falhas de 15; 10 na cmr-auto","fim":"13/10 09:20"},
                {"id":"4","url":"https://tidal.com/mix/d","playlist":"Jazz","status":"parcial","added":"13/10 08:00","resumo":"parcial","fim":"13/10 08:20"},
                {"id":"5","url":"https://tidal.com/mix/e","playlist":"Jazz","status":"falhou","added":"13/10 07:00","resumo":"saiu com código 1","fim":"13/10 07:05"}
            ],
            "pastas": ["Funk Brasileiro", "Rap & Hip-Hop", "Jazz"]
        }"#;
        let snap: FilaSnapshot = serde_json::from_str(raw).unwrap();
        assert_eq!(snap.jobs.len(), 5);
        assert_eq!(snap.pastas, vec!["Funk Brasileiro", "Rap & Hip-Hop", "Jazz"]);
        let status: Vec<&str> = snap.jobs.iter().map(|j| j.status.as_str()).collect();
        assert_eq!(status, vec!["fila", "baixando", "ok", "parcial", "falhou"]);
        assert_eq!(snap.jobs[0].inicio, None);
        assert_eq!(snap.jobs[2].fim, Some("13/10 09:20".to_string()));
    }

    // ── redação do token nas mensagens de erro ─────────────────────────
    #[test]
    fn sem_token_nao_vai_a_rede_e_nao_vaza_caminho() {
        let c = cfg();
        let err = list_jobs(&c).unwrap_err();
        assert!(!err.contains("/nao/existe"));
        assert_eq!(err, SEM_TOKEN);
    }

    #[test]
    fn host_port_nunca_inclui_o_token() {
        let c = cfg();
        assert_eq!(host_port(&c), "http://10.0.0.1:8470");
        // endpoint() é quem concatena o token; host_port() (usado nas
        // mensagens de erro) nunca passa por ele.
        assert!(endpoint(&c, "SEGREDO123").ends_with("/SEGREDO123/api/fila"));
        assert!(!host_port(&c).contains("SEGREDO123"));
        assert!(!offline_msg(&c).contains("SEGREDO123"));
    }

    #[test]
    fn enqueue_rejeita_link_invalido_sem_rede() {
        let c = cfg();
        let err = enqueue(&c, "https://soundcloud.com/x", "Jazz").unwrap_err();
        assert!(err.contains("link não reconhecido"));
    }

    #[test]
    fn enqueue_rejeita_pasta_vazia_sem_rede() {
        let c = cfg();
        let err = enqueue(&c, "https://tidal.com/mix/abc", "   ").unwrap_err();
        assert_eq!(err, "pasta vazia");
    }
}
