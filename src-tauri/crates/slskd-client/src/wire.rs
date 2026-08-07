//! Tipos de DESSERIALIZAÇÃO da API slskd v0.
//!
//! Único ponto de acoplamento à API. Todos os tipos são `#[serde(default)]`
//! no nível de struct (sem `deny_unknown_fields`): um schema que muda numa
//! atualização do slskd nunca deve quebrar o parse — campo ausente vira o
//! default do tipo, campo desconhecido é ignorado. Ver spec §Adendo do
//! spike (2026-08-07): campos vêm em camelCase.

use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApiFile {
    pub filename: String,
    pub size: u64,
    pub extension: String,
    pub bit_depth: Option<u16>,
    pub sample_rate: Option<u32>,
    pub length: Option<u32>,
    pub is_locked: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApiSearchResponse {
    pub username: String,
    pub file_count: u32,
    pub files: Vec<ApiFile>,
    pub has_free_upload_slot: bool,
    pub locked_file_count: u32,
    pub queue_length: u32,
    pub upload_speed: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApiSearch {
    pub id: String,
    pub search_text: String,
    pub state: String,
    pub response_count: u32,
    pub file_count: u32,
    pub is_complete: bool,
    /// ISO8601 UTC (ex.: `"2026-08-07T02:14:33.77Z"`) — confirmado contra o
    /// slskd real da cmr-auto (review da Etapa C, IM-9). Habilita o critério
    /// de idade (>1h) do sweep de buscas em `src-tauri/src/slsk/coordinator.rs`.
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApiTransferFile {
    pub id: String,
    pub username: String,
    pub filename: String,
    pub size: u64,
    pub state: String,
    pub bytes_transferred: u64,
    pub average_speed: f64,
    pub percent_complete: f64,
    pub exception: Option<String>,
    pub requested_at: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApiTransferDir {
    pub directory: String,
    pub files: Vec<ApiTransferFile>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ApiTransferUser {
    pub username: String,
    pub directories: Vec<ApiTransferDir>,
}

/// `GET /api/v0/server` — os dois campos que distinguem os três estados
/// do §3.3 (reachable/logged_in/network).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerStatus {
    pub is_connected: bool,
    pub is_logged_in: bool,
}
