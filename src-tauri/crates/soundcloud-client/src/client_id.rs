//! Extração do `client_id` público dos bundles JS da home do SoundCloud e o
//! cache dele em disco.

use std::path::Path;

use serde::{Deserialize, Serialize};

const BUNDLE_PREFIX: &str = "https://a-v2.sndcdn.com/assets/";
const CLIENT_ID_MARKER: &str = "client_id:\"";
const CLIENT_ID_LEN: usize = 32;

/// URLs dos bundles JS referenciados na home, na ordem em que aparecem e sem
/// repetição. Busca manual por prefixo (sem crate de regex).
pub fn bundle_urls(home_html: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (start, _) in home_html.match_indices(BUNDLE_PREFIX) {
        let rest = &home_html[start..];
        let end = rest
            .find(|c: char| c == '"' || c == '\'' || c.is_whitespace() || c == '<' || c == '>')
            .unwrap_or(rest.len());
        let candidate = &rest[..end];
        if candidate.ends_with(".js") && !out.iter().any(|u| u == candidate) {
            out.push(candidate.to_string());
        }
    }
    out
}

/// Primeiro `client_id:"<32 alfanuméricos>"` do bundle.
pub fn extract_client_id(bundle_js: &str) -> Option<String> {
    for (start, _) in bundle_js.match_indices(CLIENT_ID_MARKER) {
        let rest = &bundle_js[start + CLIENT_ID_MARKER.len()..];
        let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        if id.len() == CLIENT_ID_LEN && rest[CLIENT_ID_LEN..].starts_with('"') {
            return Some(id);
        }
    }
    None
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct CachedClientId {
    pub client_id: String,
    /// Segundos Unix da extração.
    pub fetched_at: u64,
}

pub(crate) fn read_cache(path: &Path) -> Option<String> {
    let body = std::fs::read_to_string(path).ok()?;
    let c: CachedClientId = serde_json::from_str(&body).ok()?;
    (c.client_id.len() == CLIENT_ID_LEN).then_some(c.client_id)
}

pub(crate) fn write_cache(path: &Path, client_id: &str) {
    let fetched_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let c = CachedClientId { client_id: client_id.to_string(), fetched_at };
    if let Ok(body) = serde_json::to_string(&c) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, body);
    }
}

pub(crate) fn drop_cache(path: &Path) {
    let _ = std::fs::remove_file(path);
}
