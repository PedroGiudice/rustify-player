//! tidal_fila.rs — cliente HTTP para a fila de downloads da Tidal que roda
//! na VM (`scripts/curator/tidal_fila.py`, tmux `telemetria`). O app NÃO
//! fala com a Tidal: só consulta/enfileira na fila, que faz o download de
//! verdade e envia pra `cmr-auto:~/Music` por conta própria.
//!
//! API fixa (ver o script): `GET/POST <tidal_fila_url>/<token>/api/fila`,
//! e, para a busca da aba Tidal (spec 2026-10-14), `GET .../api/busca?q=`,
//! `.../api/artista/<id>` e `.../api/previa?ref=`. A fila é quem fala com a
//! Tidal (tidalapi na VM); o app só lê o JSON. Capa: o app baixa a imagem de
//! `resources.tidal.com` aqui no Rust e devolve `data:` URL (a CSP não ganha
//! host externo).
//! O token vai no CAMINHO da URL — nunca em log, `Debug`, evento ou erro
//! devolvido ao frontend. `SourcesConfig::tidal_fila_url` guarda só
//! esquema+host+porta (sem token), seguro para aparecer em mensagem de
//! erro.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::sources::SourcesConfig;

const TIMEOUT: Duration = Duration::from_secs(10);
/// Busca, artista e prévia: o CEO está esperando na tela (spec §3.3).
const SEARCH_TIMEOUT: Duration = Duration::from_secs(8);
/// Teto do pedido de seleção (o mesmo `MAX_FAIXAS` da fila).
pub const MAX_TRACK_IDS: usize = 200;
/// Único host de capa aceito por [`fetch_cover`].
const COVER_PREFIX: &str = "https://resources.tidal.com/images/";
const COVER_MAX_BYTES: u64 = 4 * 1024 * 1024;

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
    /// Job de seleção (prévia do Crate): título do lote e quantas faixas.
    #[serde(default)]
    pub titulo: Option<String>,
    #[serde(default)]
    pub origem: Option<String>,
    #[serde(default)]
    pub n_faixas: Option<u32>,
}

// ── Busca (o JSON da fila passa direto para a tela, com os mesmos nomes) ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TidalTrack {
    pub id: u64,
    pub titulo: String,
    #[serde(default)]
    pub artistas: Vec<String>,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub album_id: Option<u64>,
    #[serde(default)]
    pub ano: Option<i32>,
    #[serde(default)]
    pub duracao_s: u32,
    #[serde(default)]
    pub hires: bool,
    #[serde(default)]
    pub capa: Option<String>,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TidalAlbum {
    pub id: u64,
    pub titulo: String,
    #[serde(default)]
    pub artista: String,
    #[serde(default)]
    pub ano: Option<i32>,
    #[serde(default)]
    pub n_faixas: u32,
    #[serde(default)]
    pub duracao_s: u32,
    #[serde(default)]
    pub hires: bool,
    /// `album | ep | single`.
    #[serde(default)]
    pub tipo: String,
    #[serde(default)]
    pub capa: Option<String>,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TidalArtist {
    pub id: u64,
    pub nome: String,
    #[serde(default)]
    pub foto: Option<String>,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TidalPlaylist {
    pub id: String,
    pub titulo: String,
    #[serde(default)]
    pub n_faixas: u32,
    #[serde(default)]
    pub duracao_s: u32,
    #[serde(default)]
    pub autor: Option<String>,
    #[serde(default)]
    pub capa: Option<String>,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TidalTopHit {
    /// `faixa | album | artista | playlist`.
    pub tipo: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TidalSearch {
    pub q: String,
    #[serde(default)]
    pub top: Option<TidalTopHit>,
    #[serde(default)]
    pub faixas: Vec<TidalTrack>,
    #[serde(default)]
    pub albuns: Vec<TidalAlbum>,
    #[serde(default)]
    pub artistas: Vec<TidalArtist>,
    #[serde(default)]
    pub playlists: Vec<TidalPlaylist>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TidalRadio {
    pub mix_id: String,
    #[serde(default)]
    pub n_faixas: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TidalArtistPage {
    pub id: u64,
    pub nome: String,
    #[serde(default)]
    pub foto: Option<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub populares: Vec<TidalTrack>,
    #[serde(default)]
    pub albuns: Vec<TidalAlbum>,
    #[serde(default)]
    pub eps_singles: Vec<TidalAlbum>,
    #[serde(default)]
    pub radio: Option<TidalRadio>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TidalPreview {
    /// `mix | radio | playlist | album | faixa`.
    pub tipo: String,
    pub titulo: String,
    /// Forma canônica `tipo:id` — vai como `origem` no pedido de seleção.
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub faixas: Vec<TidalTrack>,
    #[serde(default)]
    pub duracao_s: u32,
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
    agent_with(TIMEOUT)
}

fn agent_with(t: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(t).timeout_read(t).timeout_write(t).build()
}

/// Endpoint completo (com o token no caminho) — nunca sai da função que
/// monta a request; erros usam [`host_port`], não isto.
fn endpoint(cfg: &SourcesConfig, token: &str) -> String {
    api_url(cfg, token, "fila")
}

/// `<base>/<token>/api/<rota>` — mesma regra de [`endpoint`]: o resultado
/// nunca aparece em mensagem de erro.
fn api_url(cfg: &SourcesConfig, token: &str, rota: &str) -> String {
    format!("{}/{}/api/{}", cfg.tidal_fila_url.trim_end_matches('/'), token, rota)
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
    post_fila(cfg, &token, serde_json::json!({ "url": url, "playlist": playlist }))
}

/// Erro de status da fila -> texto da tela. A fila manda `{"error": "..."}`
/// em PT-BR (400 texto curto/ref inválida, 404, 502 Tidal sem resposta, 503
/// sessão expirada); sem corpo legível, cai no código.
fn status_msg(cfg: &SourcesConfig, code: u16, resp: ureq::Response) -> String {
    let body: ErrBody = resp.into_json().unwrap_or_default();
    body.error.unwrap_or_else(|| format!("fila ({}) respondeu {code}", host_port(cfg)))
}

fn get_json<T: serde::de::DeserializeOwned>(cfg: &SourcesConfig, rota: &str, query: &[(&str, &str)]) -> Result<T, String> {
    let token = cfg.read_tidal_token().map_err(|_| SEM_TOKEN.to_string())?;
    let mut req = agent_with(SEARCH_TIMEOUT).get(&api_url(cfg, &token, rota));
    for (k, v) in query {
        req = req.query(k, v);
    }
    match req.call() {
        Ok(resp) => resp.into_json::<T>().map_err(|e| format!("resposta inválida da fila ({}): {e}", host_port(cfg))),
        Err(ureq::Error::Status(code, resp)) => Err(status_msg(cfg, code, resp)),
        Err(ureq::Error::Transport(_)) => Err(offline_msg(cfg)),
    }
}

/// Busca por texto (faixas, álbuns, artistas, playlists). Texto com menos
/// de 2 caracteres é recusado aqui, sem ir à rede (mesma regra da fila).
pub fn search(cfg: &SourcesConfig, q: &str) -> Result<TidalSearch, String> {
    let q = q.trim();
    if q.chars().count() < 2 {
        return Err("digite ao menos 2 caracteres".to_string());
    }
    get_json(cfg, "busca", &[("q", q)])
}

/// Página do artista: populares, álbuns, EPs/singles e o rádio.
pub fn artist(cfg: &SourcesConfig, id: u64) -> Result<TidalArtistPage, String> {
    get_json(cfg, &format!("artista/{id}"), &[])
}

/// Prévia de mix/rádio/playlist/álbum/faixa: `reference` é link da Tidal ou
/// `tipo:id` (a fila valida e devolve a forma canônica em `ref`).
pub fn preview(cfg: &SourcesConfig, reference: &str) -> Result<TidalPreview, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err("referência vazia".to_string());
    }
    get_json(cfg, "previa", &[("ref", reference)])
}

/// Pedido de seleção (as faixas marcadas na prévia). Valida antes da rede:
/// 1 a [`MAX_TRACK_IDS`] ids e pasta não vazia.
pub fn enqueue_selection(
    cfg: &SourcesConfig,
    track_ids: &[u64],
    title: &str,
    origin: &str,
    playlist: &str,
) -> Result<String, String> {
    if track_ids.is_empty() {
        return Err("nenhuma faixa selecionada".to_string());
    }
    if track_ids.len() > MAX_TRACK_IDS {
        return Err(format!("no máximo {MAX_TRACK_IDS} faixas por pedido ({})", track_ids.len()));
    }
    let playlist = playlist.trim();
    if playlist.is_empty() {
        return Err("pasta vazia".to_string());
    }
    let token = cfg.read_tidal_token().map_err(|_| SEM_TOKEN.to_string())?;
    let body = serde_json::json!({ "faixas": track_ids, "titulo": title.trim(), "origem": origin.trim(), "playlist": playlist });
    post_fila(cfg, &token, body)
}

fn post_fila(cfg: &SourcesConfig, token: &str, body: serde_json::Value) -> Result<String, String> {
    match agent().post(&endpoint(cfg, token)).send_json(body) {
        Ok(resp) => {
            let ok: EnqueueOk = resp.into_json().map_err(|e| format!("resposta inválida da fila ({}): {e}", host_port(cfg)))?;
            ok.id.ok_or_else(|| format!("fila ({}) não devolveu o id do job", host_port(cfg)))
        }
        Err(ureq::Error::Status(400, resp)) => {
            let body: ErrBody = resp.into_json().unwrap_or_default();
            Err(body.error.unwrap_or_else(|| "pedido recusado pela fila".to_string()))
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("fila ({}) respondeu {code}", host_port(cfg))),
        Err(ureq::Error::Transport(_)) => Err(offline_msg(cfg)),
    }
}

/// Só capa do CDN de imagens da Tidal, por https.
pub fn is_tidal_cover_url(url: &str) -> bool {
    url.starts_with(COVER_PREFIX) && !url[COVER_PREFIX.len()..].contains("..") && url.len() < 300
}

/// Bytes da capa (o chamador redimensiona e devolve `data:` URL). Teto de
/// [`COVER_MAX_BYTES`].
pub fn fetch_cover(url: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    if !is_tidal_cover_url(url) {
        return Err("endereço de capa inválido".to_string());
    }
    let resp = agent_with(SEARCH_TIMEOUT).get(url).call().map_err(|_| "capa indisponível".to_string())?;
    let mut out = Vec::new();
    resp.into_reader()
        .take(COVER_MAX_BYTES + 1)
        .read_to_end(&mut out)
        .map_err(|_| "capa indisponível".to_string())?;
    if out.len() as u64 > COVER_MAX_BYTES {
        return Err("capa grande demais".to_string());
    }
    Ok(out)
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

    // ── busca (spec 2026-10-14) ───────────────────────────────────────
    #[test]
    fn parse_busca_da_fila() {
        let raw = r#"{"q":"Orochi","top":{"tipo":"artista","id":"4568627"},
            "faixas":[{"id":135615431,"titulo":"Mitsubishi","artistas":["Orochi"],"album":"Celebridade","album_id":135615427,
                       "ano":2020,"duracao_s":182,"hires":false,"capa":"https://resources.tidal.com/images/a/b/320x320.jpg",
                       "url":"https://tidal.com/browse/track/135615431"}],
            "albuns":[{"id":135615427,"titulo":"Celebridade","artista":"Orochi","ano":2020,"n_faixas":15,"duracao_s":3450,
                       "hires":true,"tipo":"album","capa":null,"url":"u"}],
            "artistas":[{"id":4568627,"nome":"Orochi","foto":null,"url":"u"}],
            "playlists":[{"id":"2fee16d8-2d83-4d07-acd1-64a83ebff23e","titulo":"Rio","n_faixas":35,"duracao_s":7860,"autor":null,"capa":null,"url":"u"}]}"#;
        let r: TidalSearch = serde_json::from_str(raw).unwrap();
        assert_eq!(r.top.as_ref().unwrap().tipo, "artista");
        assert_eq!(r.faixas[0].id, 135615431);
        assert_eq!(r.faixas[0].album_id, Some(135615427));
        assert!(r.albuns[0].hires);
        assert_eq!(r.playlists[0].n_faixas, 35);
        // ida e volta mantém os nomes que a tela usa
        let back = serde_json::to_value(&r).unwrap();
        assert_eq!(back["faixas"][0]["duracao_s"], 182);
        assert_eq!(back["albuns"][0]["n_faixas"], 15);
    }

    #[test]
    fn parse_previa_usa_ref_no_json() {
        let raw = r#"{"tipo":"radio","titulo":"Rádio de Orochi","ref":"mix:0001b8","faixas":[{"id":1,"titulo":"A"}],"duracao_s":180}"#;
        let p: TidalPreview = serde_json::from_str(raw).unwrap();
        assert_eq!(p.reference, "mix:0001b8");
        assert_eq!(p.faixas[0].artistas, Vec::<String>::new());
        assert_eq!(serde_json::to_value(&p).unwrap()["ref"], "mix:0001b8");
    }

    #[test]
    fn parse_artista_sem_radio() {
        let raw = r#"{"id":1,"nome":"X","populares":[],"albuns":[],"eps_singles":[],"radio":null}"#;
        let a: TidalArtistPage = serde_json::from_str(raw).unwrap();
        assert!(a.radio.is_none());
    }

    #[test]
    fn job_de_selecao_traz_titulo_e_contagem() {
        let raw = r#"{"id":"1","url":"","playlist":"Rap","status":"fila","added":"14/10 10:00","titulo":"Rádio","origem":"mix:a","n_faixas":18}"#;
        let j: TidalJob = serde_json::from_str(raw).unwrap();
        assert_eq!((j.titulo.as_deref(), j.n_faixas), (Some("Rádio"), Some(18)));
    }

    #[test]
    fn busca_curta_nao_vai_a_rede() {
        let c = cfg();
        assert_eq!(search(&c, " a ").unwrap_err(), "digite ao menos 2 caracteres");
        // com 2+ caracteres o próximo passo é o token, que falta: erro sem caminho
        assert_eq!(search(&c, "orochi").unwrap_err(), SEM_TOKEN);
        assert_eq!(artist(&c, 1).unwrap_err(), SEM_TOKEN);
        assert_eq!(preview(&c, "mix:a").unwrap_err(), SEM_TOKEN);
        assert_eq!(preview(&c, "  ").unwrap_err(), "referência vazia");
    }

    #[test]
    fn selecao_valida_antes_da_rede() {
        let c = cfg();
        assert_eq!(enqueue_selection(&c, &[], "t", "o", "Jazz").unwrap_err(), "nenhuma faixa selecionada");
        let muitas: Vec<u64> = (1..=(MAX_TRACK_IDS as u64 + 1)).collect();
        assert!(enqueue_selection(&c, &muitas, "t", "o", "Jazz").unwrap_err().contains("no máximo 200"));
        assert_eq!(enqueue_selection(&c, &[1], "t", "o", " ").unwrap_err(), "pasta vazia");
        assert_eq!(enqueue_selection(&c, &[1], "t", "o", "Jazz").unwrap_err(), SEM_TOKEN);
    }

    #[test]
    fn api_url_so_no_caminho_e_erros_sem_token() {
        let c = cfg();
        assert_eq!(api_url(&c, "SEGREDO", "busca"), "http://10.0.0.1:8470/SEGREDO/api/busca");
        // A fila responde 503 com corpo de erro; a mensagem da tela é o corpo, nunca a URL.
        assert!(!offline_msg(&c).contains("SEGREDO"));
    }

    #[test]
    fn capa_so_do_cdn_da_tidal() {
        assert!(is_tidal_cover_url("https://resources.tidal.com/images/1106/97bd/41e7/a522/31b2/320x320.jpg"));
        assert!(!is_tidal_cover_url("http://resources.tidal.com/images/x.jpg"));
        assert!(!is_tidal_cover_url("https://resources.tidal.com.evil.com/images/x.jpg"));
        assert!(!is_tidal_cover_url("https://evil.com/https://resources.tidal.com/images/x.jpg"));
        assert!(!is_tidal_cover_url("https://resources.tidal.com/images/../x"));
        assert_eq!(fetch_cover("file:///etc/passwd").unwrap_err(), "endereço de capa inválido");
    }

    #[test]
    fn enqueue_rejeita_pasta_vazia_sem_rede() {
        let c = cfg();
        let err = enqueue(&c, "https://tidal.com/mix/abc", "   ").unwrap_err();
        assert_eq!(err, "pasta vazia");
    }
}
