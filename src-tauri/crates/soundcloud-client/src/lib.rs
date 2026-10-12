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

/// Arquivo original sondado: URL assinada, extensão (dos headers do `HEAD`,
/// com o caminho da URL como último recurso), tamanho e bitrate estimado por
/// tamanho/duração.
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
    // O `/resolve` aceita link de perfil (`kind:user`) e de set
    // (`kind:playlist`, que tem id/title/permalink_url e passaria como faixa).
    let kind: wire::RawKind = serde_json::from_str(body).map_err(|e| ScError::Parse(e.to_string()))?;
    if kind.kind.as_deref().is_some_and(|k| k != "track") {
        return Err(ScError::Parse("o link não é de uma faixa".into()));
    }
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

/// Extensão do original a partir dos headers da URL assinada, na ordem dos
/// clientes de referência (yt-dlp `urlhandle_detect_ext`, soundcloud.ts,
/// scdl): `filename*`/`filename` do Content-Disposition, depois
/// `x-amz-meta-file-type`, depois o Content-Type. A URL real do original não
/// tem extensão no caminho (`cf-media.sndcdn.com/gp1vtDolJmrM?Policy=...`),
/// então o caminho só entra como último recurso, fora daqui.
pub fn ext_from_headers(
    content_disposition: Option<&str>,
    amz_file_type: Option<&str>,
    content_type: Option<&str>,
) -> Option<String> {
    content_disposition
        .and_then(filename_from_disposition)
        .and_then(|name| name.rsplit_once('.').map(|(_, e)| e.to_string()))
        .and_then(|e| clean_ext(&e))
        .or_else(|| amz_file_type.and_then(clean_ext))
        .or_else(|| content_type.and_then(ext_from_content_type))
}

fn clean_ext(e: &str) -> Option<String> {
    let e = e.trim().trim_start_matches('.').to_ascii_lowercase();
    (!e.is_empty() && e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric())).then_some(e)
}

/// Nome do arquivo do Content-Disposition. `filename*` (RFC 5987,
/// `UTF-8''nome%20codificado`) tem precedência sobre `filename`.
fn filename_from_disposition(cd: &str) -> Option<String> {
    let mut plain: Option<String> = None;
    let mut extended: Option<String> = None;
    for part in cd.split(';') {
        let Some((k, v)) = part.split_once('=') else { continue };
        let k = k.trim().to_ascii_lowercase();
        let v = v.trim();
        if k == "filename*" {
            let raw = v.rsplit("''").next().unwrap_or(v).trim_matches('"');
            extended = Some(pct_decode(raw));
        } else if k == "filename" {
            plain = Some(v.trim_matches('"').to_string());
        }
    }
    extended.or(plain).filter(|n| !n.is_empty())
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn ext_from_content_type(ct: &str) -> Option<String> {
    let mime = ct.split(';').next()?.trim().to_ascii_lowercase();
    let ext = match mime.as_str() {
        "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => "wav",
        "audio/aiff" | "audio/x-aiff" => "aiff",
        "audio/flac" | "audio/x-flac" => "flac",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/mp4" | "audio/aac" | "audio/x-m4a" => "m4a",
        "audio/ogg" => "ogg",
        _ => return None,
    };
    Some(ext.to_string())
}

/// Tamanho total de um `Content-Range: bytes 0-0/12345` (resposta 206 ao GET
/// com `Range: bytes=0-0`, o plano B quando o HEAD falha).
pub fn total_from_content_range(cr: &str) -> Option<u64> {
    cr.rsplit('/').next()?.trim().parse().ok()
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
        // Ordem do documento preservada: a varredura vai do último ao primeiro.
        assert_eq!(urls.len(), 9);
        assert_eq!(urls.first().map(String::as_str), Some("https://a-v2.sndcdn.com/assets/59-ac0a49ce.js"));
        assert_eq!(urls.last().map(String::as_str), Some("https://a-v2.sndcdn.com/assets/55-f24f7f25.js"));
        let id = extract_client_id(&fx("app_bundle.js")).expect("client_id no bundle");
        assert_eq!(id, "vI5BsvpTIlavDLl7RDbbcFAPg8kls8Bg");
    }

    #[test]
    fn extract_client_id_pula_candidato_invalido() {
        let js = r#"a={client_id:"curto"},b={client_id:"vI5BsvpTIlavDLl7RDbbcFAPg8kls8BgX"},c={client_id:"vI5BsvpTIlavDLl7RDbbcFAPg8kls8Bg"}"#;
        assert_eq!(extract_client_id(js).as_deref(), Some("vI5BsvpTIlavDLl7RDbbcFAPg8kls8Bg"));
        assert_eq!(extract_client_id(r#"client_id:"curto""#), None);
    }

    #[test]
    fn ext_from_headers_segue_a_ordem_dos_clientes_de_referencia() {
        // Content-Disposition (forma do CDN do SoundCloud).
        assert_eq!(ext_from_headers(Some(r#"attachment;filename="Mandelão - Beat.wav""#), Some("mp3"), Some("audio/mpeg")).as_deref(), Some("wav"));
        // filename* (RFC 5987) tem precedência sobre filename.
        assert_eq!(ext_from_headers(Some(r#"attachment; filename="x.mp3"; filename*=UTF-8''Mandel%C3%A3o%20Beat.AIFF"#), None, None).as_deref(), Some("aiff"));
        // Sem nome com extensão: x-amz-meta-file-type.
        assert_eq!(ext_from_headers(Some("attachment"), Some("wav"), Some("audio/mpeg")).as_deref(), Some("wav"));
        assert_eq!(ext_from_headers(Some(r#"attachment;filename="semextensao""#), Some(" FLAC "), None).as_deref(), Some("flac"));
        // Só o Content-Type.
        assert_eq!(ext_from_headers(None, None, Some("audio/x-wav")).as_deref(), Some("wav"));
        assert_eq!(ext_from_headers(None, None, Some("audio/wav; charset=binary")).as_deref(), Some("wav"));
        assert_eq!(ext_from_headers(None, None, Some("audio/x-aiff")).as_deref(), Some("aiff"));
        assert_eq!(ext_from_headers(None, None, Some("audio/flac")).as_deref(), Some("flac"));
        assert_eq!(ext_from_headers(None, None, Some("audio/mpeg")).as_deref(), Some("mp3"));
        assert_eq!(ext_from_headers(None, None, Some("audio/mp4")).as_deref(), Some("m4a"));
        assert_eq!(ext_from_headers(None, None, Some("audio/aac")).as_deref(), Some("m4a"));
        // Nada útil.
        assert_eq!(ext_from_headers(None, None, Some("application/octet-stream")), None);
        assert_eq!(ext_from_headers(None, Some(""), None), None);
    }

    #[test]
    fn total_do_content_range() {
        assert_eq!(total_from_content_range("bytes 0-0/7441408"), Some(7_441_408));
        assert_eq!(total_from_content_range("bytes 0-0/*"), None);
    }

    #[test]
    fn parse_track_recusa_perfil_e_set() {
        let user = r#"{"kind":"user","id":7,"username":"mc","permalink_url":"https://soundcloud.com/mc"}"#;
        assert_eq!(parse_track(user), Err(ScError::Parse("o link não é de uma faixa".into())));
        let set = r#"{"kind":"playlist","id":1246932139,"title":"Set","permalink_url":"https://soundcloud.com/mc/sets/x","duration":12060000}"#;
        assert_eq!(parse_track(set), Err(ScError::Parse("o link não é de uma faixa".into())));
        assert!(parse_track(&fx("track_native.json")).is_ok());
    }

    #[test]
    fn estimativa_de_bitrate_e_extensao() {
        assert_eq!(bitrate_estimate_kbps(7_267 * 1024, 183_000), 325);   // MP3 320 real do piloto
        assert_eq!(bitrate_estimate_kbps(3_586 * 1024, 228_000), 129);   // MP3 128 real do piloto
        // Forma real do original (yt-dlp#8435): sem extensão no caminho.
        assert_eq!(ext_from_url("https://cf-media.sndcdn.com/gp1vtDolJmrM?Policy=x&Signature=y&Key-Pair-Id=z"), None);
        assert_eq!(ext_from_url("https://x/y/track.MP3").as_deref(), Some("mp3"));
        assert_eq!(ext_from_url("https://x/y/noext"), None);
    }

    #[test]
    fn artwork_500() {
        assert_eq!(super::artwork_500("https://i1.sndcdn.com/artworks-abc-large.jpg"), "https://i1.sndcdn.com/artworks-abc-t500x500.jpg");
    }
}
