//! Formas cruas do JSON da API v2 e a conversão para [`ScTrack`].

use serde::Deserialize;

use crate::ScTrack;

#[derive(Debug, Deserialize)]
pub(crate) struct RawSearch {
    #[serde(default)]
    pub collection: Vec<RawTrack>,
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct RawUser {
    pub username: Option<String>,
    pub permalink: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RawTrack {
    pub id: u64,
    pub title: String,
    pub permalink_url: String,
    pub user: Option<RawUser>,
    pub duration: Option<u64>,
    pub full_duration: Option<u64>,
    pub playback_count: Option<u64>,
    pub created_at: Option<String>,
    pub release_date: Option<String>,
    pub genre: Option<String>,
    pub artwork_url: Option<String>,
    pub downloadable: Option<bool>,
    pub has_downloads_left: Option<bool>,
    pub purchase_url: Option<String>,
}

/// Corpo de `GET /tracks/{id}/download`.
#[derive(Debug, Deserialize)]
pub(crate) struct RawDownload {
    #[serde(rename = "redirectUri")]
    pub redirect_uri: String,
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.trim().is_empty())
}

impl From<RawTrack> for ScTrack {
    fn from(r: RawTrack) -> Self {
        let user = r.user.unwrap_or_default();
        ScTrack {
            id: r.id,
            title: r.title,
            permalink_url: r.permalink_url,
            user_name: user.username.unwrap_or_default(),
            user_permalink: user.permalink.unwrap_or_default(),
            duration_ms: r.full_duration.or(r.duration).unwrap_or(0),
            playback_count: r.playback_count.unwrap_or(0),
            created_at: r.created_at.unwrap_or_default(),
            release_date: non_empty(r.release_date),
            genre: non_empty(r.genre),
            artwork_url: non_empty(r.artwork_url),
            downloadable: r.downloadable.unwrap_or(false),
            has_downloads_left: r.has_downloads_left.unwrap_or(false),
            purchase_url: non_empty(r.purchase_url),
        }
    }
}
