//! Cliente puro da API v2 do SoundCloud (sem Tauri): busca, resolve, sondagem
//! do arquivo original e download. O `client_id` público sai dos bundles JS da
//! home; o token OAuth (necessário para o original) é passado por chamada e
//! nunca guardado nem logado aqui.

mod client_id;
mod http;
mod wire;

use serde::Serialize;

pub use client_id::{bundle_urls, extract_client_id};
pub use http::HttpSoundCloud;

/// Faixa como a API v2 a devolve, só com os campos que o Crate usa.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScTrack {
    pub id: u64,
    pub title: String,
    pub permalink_url: String,
    pub user_name: String,
    pub user_permalink: String,
    pub duration_ms: u64,
    pub playback_count: u64,
    pub created_at: String,
    pub release_date: Option<String>,
    pub genre: Option<String>,
    pub artwork_url: Option<String>,
    pub downloadable: bool,
    pub has_downloads_left: bool,
    pub purchase_url: Option<String>,
}

/// Como (e se) o arquivo original da faixa pode ser obtido.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Availability {
    /// Download nativo liberado.
    Native,
    /// Download nativo existe, mas a cota do produtor acabou.
    QuotaExhausted,
    /// Sem download nativo; o link de compra/gate (Hypeddit, ToneDen, Bandcamp).
    ExternalGate { url: String },
    /// Sem download de forma nenhuma.
    None,
}

/// Arquivo original sondado: URL assinada, extensão (da URL), tamanho do
/// `HEAD` e bitrate estimado por tamanho/duração.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Original {
    pub url: String,
    pub ext: String,
    pub size: Option<u64>,
    pub kbps_est: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ScError {
    #[error("token do SoundCloud ausente ou recusado")]
    NoToken,
    #[error("SoundCloud limitou as chamadas (429)")]
    RateLimited,
    #[error("SoundCloud respondeu HTTP {0}")]
    Http(u16),
    #[error("falha de rede com o SoundCloud: {0}")]
    Transport(String),
    #[error("resposta do SoundCloud ilegível: {0}")]
    Parse(String),
}

/// Fronteira de rede, para o worker poder trocar por um fake nos testes.
pub trait SoundCloudApi: Send + Sync {
    fn search(&self, q: &str, limit: u32) -> Result<Vec<ScTrack>, ScError>;
    fn resolve(&self, url: &str) -> Result<ScTrack, ScError>;
    /// `duration_ms` (da faixa) entra só para calcular `kbps_est`.
    fn probe_original(&self, track_id: u64, token: &str, duration_ms: u64) -> Result<Original, ScError>;
    fn download(
        &self,
        url: &str,
        dest: &std::path::Path,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<(), ScError>;
    fn fetch_bytes(&self, url: &str, max: usize) -> Result<Vec<u8>, ScError>;
    fn me(&self, token: &str) -> Result<(), ScError>;
}

pub fn parse_search(body: &str) -> Result<Vec<ScTrack>, ScError> {
    let raw: wire::RawSearch = serde_json::from_str(body).map_err(|e| ScError::Parse(e.to_string()))?;
    Ok(raw.collection.into_iter().map(ScTrack::from).collect())
}

pub fn parse_track(body: &str) -> Result<ScTrack, ScError> {
    let raw: wire::RawTrack = serde_json::from_str(body).map_err(|e| ScError::Parse(e.to_string()))?;
    Ok(raw.into())
}

pub fn availability(t: &ScTrack) -> Availability {
    if t.downloadable {
        if t.has_downloads_left { Availability::Native } else { Availability::QuotaExhausted }
    } else if let Some(u) = t.purchase_url.as_deref().filter(|u| !u.is_empty()) {
        Availability::ExternalGate { url: u.to_string() }
    } else {
        Availability::None
    }
}

/// kbps = bytes * 8 / ms (bits por milissegundo = kbit/s).
pub fn bitrate_estimate_kbps(size_bytes: u64, duration_ms: u64) -> u32 {
    if duration_ms == 0 { return 0; }
    ((size_bytes as f64 * 8.0) / (duration_ms as f64)).round() as u32
}

/// Extensão do último segmento do caminho, em minúsculas, ignorando query e
/// fragmento (URLs assinadas do CDN carregam `?Policy=...`).
pub fn ext_from_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let name = path.rsplit('/').next()?;
    let (_, ext) = name.rsplit_once('.')?;
    if ext.is_empty() || ext.len() > 5 { return None; }
    Some(ext.to_ascii_lowercase())
}

/// Troca a miniatura `-large` (100 px) pela variante de 500 px.
pub fn artwork_500(url: &str) -> String { url.replace("-large.", "-t500x500.") }

#[cfg(test)]
mod tests {
    use super::*;
    fn fx(name: &str) -> String { std::fs::read_to_string(format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap() }

    #[test]
    fn parse_search_devolve_faixas_com_campos_essenciais() {
        let tracks = parse_search(&fx("search_mandelao.json")).unwrap();
        assert!(!tracks.is_empty());
        let t = &tracks[0];
        assert!(t.id > 0 && !t.title.is_empty() && t.permalink_url.starts_with("https://soundcloud.com/"));
        assert!(t.duration_ms > 0);
    }

    #[test]
    fn availability_distingue_os_quatro_casos() {
        let native = parse_track(&fx("track_native.json")).unwrap();
        assert_eq!(availability(&native), Availability::Native);
        let gate = parse_track(&fx("track_gate.json")).unwrap();
        assert!(matches!(availability(&gate), Availability::ExternalGate { .. }));
        let none = parse_track(&fx("track_none.json")).unwrap();
        assert_eq!(availability(&none), Availability::None);
        let mut quota = native.clone();
        quota.has_downloads_left = false;
        assert_eq!(availability(&quota), Availability::QuotaExhausted);
    }

    #[test]
    fn client_id_sai_do_bundle_e_bundles_saem_da_home() {
        let urls = bundle_urls(&fx("home.html"));
        assert!(urls.iter().all(|u| u.starts_with("https://a-v2.sndcdn.com/assets/") && u.ends_with(".js")));
        assert!(!urls.is_empty());
        let id = extract_client_id(&fx("app_bundle.js")).expect("client_id no bundle");
        assert_eq!(id.len(), 32);
    }

    #[test]
    fn estimativa_de_bitrate_e_extensao() {
        assert_eq!(bitrate_estimate_kbps(7_267 * 1024, 183_000), 325);   // MP3 320 real do piloto
        assert_eq!(bitrate_estimate_kbps(3_586 * 1024, 228_000), 129);   // MP3 128 real do piloto
        assert_eq!(ext_from_url("https://cf-media.sndcdn.com/abc.wav?Policy=x&Signature=y").as_deref(), Some("wav"));
        assert_eq!(ext_from_url("https://x/y/track.MP3").as_deref(), Some("mp3"));
        assert_eq!(ext_from_url("https://x/y/noext"), None);
    }

    #[test]
    fn artwork_500() {
        assert_eq!(super::artwork_500("https://i1.sndcdn.com/artworks-abc-large.jpg"), "https://i1.sndcdn.com/artworks-abc-t500x500.jpg");
    }
}
