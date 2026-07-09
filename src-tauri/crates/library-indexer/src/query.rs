//! Read-side queries backed by Qdrant.
//!
//! Replaces the old `search.rs` module. Every function takes `&QdrantClient`
//! instead of `&rusqlite::Connection`.

#![allow(dead_code)]

use crate::error::IndexerError;
use crate::qdrant_client::QdrantClient;
use crate::types::{
    Album, AlbumFilter, Artist, ArtistFilter, EmbeddingStatus, Genre,
    SearchResults, Track, TrackFilter, TrackOrder,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Payload → type conversion
// ---------------------------------------------------------------------------

pub(crate) fn payload_to_track(id: u64, p: &Value) -> Track {
    let cover_str = p["cover_path"].as_str().map(PathBuf::from);
    let lrc_str = p["lrc_path"].as_str().map(PathBuf::from);
    let tags = p["tags"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let status = p["embedding_status"].as_str().unwrap_or("pending");

    Track {
        id,
        path: PathBuf::from(p["path"].as_str().unwrap_or("")),
        filename: p["filename"].as_str().unwrap_or("").to_string(),
        title: p["title"].as_str().unwrap_or("").to_string(),
        track_number: p["track_number"].as_i64().map(|v| v as i32),
        disc_number: p["disc_number"].as_i64().unwrap_or(1) as i32,
        duration_ms: p["duration_ms"].as_i64().unwrap_or(0),
        album_title: p["album_title"].as_str().filter(|s| !s.is_empty()).map(String::from),
        album_year: p["album_year"].as_i64().map(|v| v as i32),
        album_cover_path: cover_str,
        artist_name: p["artist"].as_str().filter(|s| !s.is_empty()).map(String::from),
        genre_name: p["genre"].as_str().filter(|s| !s.is_empty()).map(String::from),
        tags,
        sample_rate: p["sample_rate"].as_u64().unwrap_or(44100) as u32,
        bit_depth: p["bit_depth"].as_u64().unwrap_or(16) as u16,
        channels: p["channels"].as_u64().unwrap_or(2) as u16,
        rg_track_gain: p["rg_track_gain"].as_f64().map(|v| v as f32),
        rg_album_gain: p["rg_album_gain"].as_f64().map(|v| v as f32),
        rg_track_peak: p["rg_track_peak"].as_f64().map(|v| v as f32),
        rg_album_peak: p["rg_album_peak"].as_f64().map(|v| v as f32),
        lufs_integrated: p["lufs_integrated"].as_f64().map(|v| v as f32),
        embedding_status: EmbeddingStatus::parse(status).unwrap_or(EmbeddingStatus::Pending),
        play_count: p["play_count"].as_u64().unwrap_or(0) as u32,
        last_played: p["last_played"].as_i64(),
        liked_at: p["liked_at"].as_i64(),
        lrc_path: lrc_str,
    }
}

// ---------------------------------------------------------------------------
// Single track lookups
// ---------------------------------------------------------------------------

pub fn get_track(client: &QdrantClient, id: u64) -> Result<Option<Track>, IndexerError> {
    match client.get_point(id)? {
        Some(point) => {
            let payload = &point["payload"];
            Ok(Some(payload_to_track(id, payload)))
        }
        None => Ok(None),
    }
}

pub fn get_track_by_path(
    client: &QdrantClient,
    path: &std::path::Path,
) -> Result<Option<Track>, IndexerError> {
    let id = crate::types::path_to_id(path);
    get_track(client, id)
}

// ---------------------------------------------------------------------------
// List queries
// ---------------------------------------------------------------------------

pub fn list_tracks(
    client: &QdrantClient,
    filter: &TrackFilter,
) -> Result<Vec<Track>, IndexerError> {
    let qdrant_filter = build_track_filter(filter);
    let order_key = match filter.order {
        TrackOrder::RecentlyAdded => Some("indexed_at"),
        TrackOrder::LastPlayed => Some("last_played"),
        _ => None,
    };
    // Sem limit explícito = biblioteca inteira. O default antigo de 500
    // cortava a view Tracks silenciosamente (500 de N) enquanto os counts
    // de playlist/genre agregam o total — os números não batiam na UI.
    let limit = filter.limit.unwrap_or(100_000);

    let results = client.scroll_with_filter(qdrant_filter, order_key, limit, false)?;
    let mut tracks: Vec<Track> = results
        .iter()
        .map(|(id, payload)| payload_to_track(*id, payload))
        .collect();

    match filter.order {
        TrackOrder::AlbumDiscTrack => {
            tracks.sort_by(|a, b| {
                a.album_title
                    .cmp(&b.album_title)
                    .then(a.disc_number.cmp(&b.disc_number))
                    .then(a.track_number.cmp(&b.track_number))
                    .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
            });
        }
        TrackOrder::TitleAsc => {
            tracks.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        }
        TrackOrder::Random => {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            tracks.sort_by(|a, b| {
                let mut ha = DefaultHasher::new();
                a.id.hash(&mut ha);
                let mut hb = DefaultHasher::new();
                b.id.hash(&mut hb);
                ha.finish().cmp(&hb.finish())
            });
        }
        _ => {}
    }

    Ok(tracks)
}

fn build_track_filter(filter: &TrackFilter) -> Option<Value> {
    let mut must: Vec<Value> = Vec::new();

    if let Some(genre) = &filter.genre {
        must.push(json!({"key": "genre", "match": {"value": genre}}));
    }
    if let Some(artist) = &filter.artist {
        must.push(json!({"key": "artist_exact", "match": {"value": artist}}));
    }
    if let Some(album) = &filter.album {
        must.push(json!({"key": "album_title_exact", "match": {"value": album}}));
    }
    for tag in &filter.tags {
        must.push(json!({"key": "tags", "match": {"value": tag}}));
    }

    if must.is_empty() {
        None
    } else {
        Some(json!({"must": must}))
    }
}

// ---------------------------------------------------------------------------
// Aggregation (albums, artists, genres)
// ---------------------------------------------------------------------------

pub fn list_genres(client: &QdrantClient) -> Result<Vec<Genre>, IndexerError> {
    let all = client.scroll_all_payloads(&["genre"])?;
    let mut counts: HashMap<String, u32> = HashMap::new();
    for (_, payload) in &all {
        if let Some(g) = payload["genre"].as_str() {
            if !g.is_empty() {
                *counts.entry(g.to_string()).or_default() += 1;
            }
        }
    }
    let mut genres: Vec<Genre> = counts
        .into_iter()
        .map(|(name, track_count)| Genre { name, track_count })
        .collect();
    genres.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(genres)
}

pub fn list_albums(
    client: &QdrantClient,
    filter: &AlbumFilter,
) -> Result<Vec<Album>, IndexerError> {
    let fields = &[
        "album_title",
        "artist",
        "album_year",
        "cover_path",
        "genre",
    ];
    let all = client.scroll_all_payloads(fields)?;

    let mut album_map: HashMap<String, Album> = HashMap::new();
    for (_, payload) in &all {
        let title = match payload["album_title"].as_str() {
            Some(t) if !t.is_empty() => t,
            _ => continue,
        };
        let artist = payload["artist"].as_str().filter(|s| !s.is_empty()).map(String::from);
        let genre = payload["genre"].as_str().unwrap_or("");

        if let Some(f_genre) = &filter.genre {
            if genre != f_genre {
                continue;
            }
        }
        if let Some(f_artist) = &filter.artist {
            if artist.as_deref() != Some(f_artist.as_str()) {
                continue;
            }
        }

        let key = format!(
            "{}|{}",
            title.to_lowercase(),
            artist.as_deref().unwrap_or("")
        );
        let entry = album_map.entry(key).or_insert_with(|| Album {
            title: title.to_string(),
            artist_name: artist.clone(),
            year: payload["album_year"].as_i64().map(|v| v as i32),
            cover_path: payload["cover_path"].as_str().map(PathBuf::from),
            track_count: 0,
        });
        entry.track_count += 1;
        if entry.cover_path.is_none() {
            entry.cover_path = payload["cover_path"].as_str().map(PathBuf::from);
        }
    }

    let mut albums: Vec<Album> = album_map.into_values().collect();
    albums.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    if let Some(limit) = filter.limit {
        albums.truncate(limit);
    }
    Ok(albums)
}

pub fn list_artists(
    client: &QdrantClient,
    filter: &ArtistFilter,
) -> Result<Vec<Artist>, IndexerError> {
    let fields = &["artist", "album_title", "genre"];
    let all = client.scroll_all_payloads(fields)?;

    let mut artist_tracks: HashMap<String, u32> = HashMap::new();
    let mut artist_albums: HashMap<String, HashSet<String>> = HashMap::new();
    for (_, payload) in &all {
        let name = match payload["artist"].as_str() {
            Some(n) if !n.is_empty() => n,
            _ => continue,
        };
        if let Some(f_genre) = &filter.genre {
            if payload["genre"].as_str().unwrap_or("") != f_genre {
                continue;
            }
        }
        *artist_tracks.entry(name.to_string()).or_default() += 1;
        if let Some(album) = payload["album_title"].as_str() {
            if !album.is_empty() {
                artist_albums
                    .entry(name.to_string())
                    .or_default()
                    .insert(album.to_string());
            }
        }
    }

    let mut artists: Vec<Artist> = artist_tracks
        .into_iter()
        .map(|(name, track_count)| {
            let album_count = artist_albums
                .get(&name)
                .map(|s| s.len() as u32)
                .unwrap_or(0);
            Artist {
                name,
                sort_name: None,
                track_count,
                album_count,
            }
        })
        .collect();
    artists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    if let Some(limit) = filter.limit {
        artists.truncate(limit);
    }
    Ok(artists)
}

// ---------------------------------------------------------------------------
// Text search
// ---------------------------------------------------------------------------

/// Pesos por campo no ranking de busca (título > artista > álbum).
const W_TITLE: i32 = 1000;
const W_ARTIST: i32 = 500;
const W_ALBUM: i32 = 300;

/// Remove diacríticos latinos/PT-BR comuns. Não depende de crate externa;
/// o caractere já chega minúsculo de `norm`.
fn strip_accent(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ç' => 'c',
        'ñ' => 'n',
        'ý' | 'ÿ' => 'y',
        other => other,
    }
}

/// Normaliza texto para comparação de busca: trim + lowercase (Unicode-aware)
/// + remoção de acentos. Garante que "amari" case com "Amari" e "beyonce"
/// com "Beyoncé", independentemente de qualquer índice do Qdrant.
fn norm(s: &str) -> String {
    s.trim().to_lowercase().chars().map(strip_accent).collect()
}

/// Versão "comprimida" de um texto já normalizado: só caracteres alfanuméricos,
/// sem espaços nem pontuação. Permite casar títulos estilizados com letras
/// espaçadas (ex: J. Cole "The Off-Season" guarda "a m a r i" no metadata) —
/// `squish("a m a r i") == "amari" == squish("amari")`.
fn squish(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Pontua o match de `needle` contra um único campo (ambos já normalizados).
/// 0 = sem match. Camadas: 4 exato, 3 prefixo do campo, 2 prefixo de palavra,
/// 1 substring no meio.
fn field_score(needle: &str, field: &str) -> i32 {
    if needle.is_empty() || field.is_empty() {
        return 0;
    }
    if field == needle {
        4
    } else if field.starts_with(needle) {
        3
    } else if field.split_whitespace().any(|w| w.starts_with(needle)) {
        2
    } else if field.contains(needle) {
        1
    } else {
        0
    }
}

/// Pontua uma track. `needle`, `title`, `artist` e `album` já vêm normalizados.
/// 0 = não casa; maior = mais relevante.
///
/// A `needle` é tokenizada por espaços e exige-se que TODOS os tokens casem
/// (AND), cada um pela sua melhor contribuição ponderada entre os três campos.
/// Isso reproduz — e melhora — o comportamento do antigo filtro full-text do
/// Qdrant (`match:{text}`): busca "artista faixa" funciona em qualquer ordem e
/// com tokens em campos diferentes (ex: "kendrick humble" casando o artista no
/// `artist` e o título no `title`). Para um único token, equivale a pegar o
/// melhor campo — um match no título supera um no artista, que supera no álbum.
fn match_score(needle: &str, title: &str, artist: &str, album: &str) -> i32 {
    let toks: Vec<&str> = needle.split_whitespace().collect();
    if toks.is_empty() {
        return 0;
    }

    // 1. Match por token (AND, melhor campo por token) — caminho normal.
    let mut total = 0;
    let mut all_ok = true;
    for tok in &toks {
        let best = (W_TITLE * field_score(tok, title))
            .max(W_ARTIST * field_score(tok, artist))
            .max(W_ALBUM * field_score(tok, album));
        if best == 0 {
            all_ok = false;
            break;
        }
        total += best;
    }
    if all_ok {
        return total;
    }

    // 2. Fallback comprimido: ignora espaços/pontuação para casar títulos
    // estilizados ("a m a r i"). Score baixo (metade do peso) para ficar abaixo
    // de qualquer match normal. Needle mínima de 3 chars evita ruído.
    let nq = squish(needle);
    if nq.len() >= 3 {
        if squish(title).contains(&nq) {
            return W_TITLE / 2;
        }
        if squish(artist).contains(&nq) {
            return W_ARTIST / 2;
        }
        if squish(album).contains(&nq) {
            return W_ALBUM / 2;
        }
    }
    0
}

pub fn search(
    client: &QdrantClient,
    query: &str,
    limit: usize,
) -> Result<SearchResults, IndexerError> {
    let needle = norm(query);
    if needle.is_empty() {
        return Ok(SearchResults {
            tracks: Vec::new(),
            albums: Vec::new(),
            artists: Vec::new(),
        });
    }

    // Busca client-side sobre a biblioteca inteira. Substitui o antigo filtro
    // Qdrant `match:{text}`, cujo fallback case-sensitive (quando o segment não
    // tem índice full-text) quebrava buscas em minúsculo contra títulos
    // capitalizados. Para uma biblioteca pessoal (~10³ faixas) o custo é trivial
    // e ainda ganha substring + case/accent-insensitive (UX melhor que o
    // tokenizer word do Qdrant). Ver query::search_playlists (mesmo padrão).
    let all = client.scroll_all_full()?;

    let mut scored: Vec<(i32, Track)> = Vec::with_capacity(all.len());
    for (id, payload) in &all {
        let t = payload_to_track(*id, payload);
        let title = norm(&t.title);
        let artist = t.artist_name.as_deref().map(norm).unwrap_or_default();
        let album = t.album_title.as_deref().map(norm).unwrap_or_default();
        let score = match_score(&needle, &title, &artist, &album);
        if score > 0 {
            scored.push((score, t));
        }
    }

    // Maior score primeiro; desempate estável por título.
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.title.to_lowercase().cmp(&b.1.title.to_lowercase()))
    });

    let tracks: Vec<Track> = scored.into_iter().map(|(_, t)| t).take(limit).collect();

    let mut seen_albums = HashSet::new();
    let mut albums = Vec::new();
    let mut seen_artists = HashSet::new();
    let mut artists = Vec::new();

    for t in &tracks {
        if let Some(album) = &t.album_title {
            let key = album.to_lowercase();
            if seen_albums.insert(key) && albums.len() < 5 {
                albums.push(Album {
                    title: album.clone(),
                    artist_name: t.artist_name.clone(),
                    year: t.album_year,
                    cover_path: t.album_cover_path.clone(),
                    track_count: 0,
                });
            }
        }
        if let Some(artist) = &t.artist_name {
            let key = artist.to_lowercase();
            if seen_artists.insert(key) && artists.len() < 5 {
                artists.push(Artist {
                    name: artist.clone(),
                    sort_name: None,
                    track_count: 0,
                    album_count: 0,
                });
            }
        }
    }

    Ok(SearchResults {
        tracks,
        albums,
        artists,
    })
}

// ---------------------------------------------------------------------------
// Playback history & likes (backed by track_enrichments collection)
// ---------------------------------------------------------------------------

fn resolve_tracks_with_enrichments(
    client: &QdrantClient,
    enriched: &[(u64, Value)],
) -> Vec<Track> {
    let mut tracks = Vec::new();
    for (id, enr) in enriched {
        if let Ok(Some(point)) = client.get_point(*id) {
            let payload = &point["payload"];
            let mut track = payload_to_track(*id, payload);
            track.play_count = enr["play_count"].as_u64().unwrap_or(0) as u32;
            track.last_played = enr["last_played"].as_i64();
            track.liked_at = enr["liked_at"].as_i64();
            tracks.push(track);
        }
    }
    tracks
}

pub fn record_play(client: &QdrantClient, track_id: u64) -> Result<(), IndexerError> {
    let existing = client.get_enrichment(track_id)?;
    let current_count = existing["play_count"].as_u64().unwrap_or(0);
    let now = unix_now();

    client.set_enrichment(track_id, json!({
        "play_count": current_count + 1,
        "last_played": now
    }))
}

pub fn list_history(client: &QdrantClient, limit: usize) -> Result<Vec<Track>, IndexerError> {
    let filter = json!({
        "must": [{"key": "last_played", "range": {"gt": 0}}]
    });
    let enriched = client.scroll_enrichments(Some(filter), Some("last_played"), limit)?;
    Ok(resolve_tracks_with_enrichments(client, &enriched))
}

pub fn toggle_like(client: &QdrantClient, track_id: u64) -> Result<bool, IndexerError> {
    let existing = client.get_enrichment(track_id)?;
    let currently_liked = existing["liked_at"].as_i64().is_some();

    if currently_liked {
        client.set_enrichment(track_id, json!({"liked_at": null}))?;
        Ok(false)
    } else {
        let now = unix_now();
        client.set_enrichment(track_id, json!({"liked_at": now}))?;
        Ok(true)
    }
}

pub fn list_liked(client: &QdrantClient, limit: usize) -> Result<Vec<Track>, IndexerError> {
    let filter = json!({
        "must": [{"key": "liked_at", "range": {"gt": 0}}]
    });
    let enriched = client.scroll_enrichments(Some(filter), Some("liked_at"), limit)?;
    Ok(resolve_tracks_with_enrichments(client, &enriched))
}

pub fn is_liked(client: &QdrantClient, track_id: u64) -> Result<bool, IndexerError> {
    let enr = client.get_enrichment(track_id)?;
    Ok(enr["liked_at"].as_i64().is_some())
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct Recommendations {
    pub most_played: Vec<Track>,
    pub based_on_top: Vec<Track>,
    pub discover: Vec<Track>,
}

pub fn recommendations(client: &QdrantClient) -> Result<Recommendations, IndexerError> {
    // play_count/liked_at VIVOS moram em track_enrichments — record_play e
    // toggle_like escrevem la desde a migracao. Ler de rustify_tracks (como
    // este codigo fazia) devolvia contadores fosseis pre-migracao: a Home
    // ignorava ~90% dos plays e TODOS os likes.
    let played_filter = json!({"must": [{"key": "play_count", "range": {"gt": 0}}]});
    let top_played = client.scroll_enrichments(Some(played_filter.clone()), Some("play_count"), 10)?;
    let most_played = resolve_tracks_with_enrichments(client, &top_played);

    let liked_filter = json!({"must": [{"key": "liked_at", "range": {"gt": 0}}]});
    let liked = client.scroll_enrichments(Some(liked_filter), Some("liked_at"), 10)?;
    let mut seed_ids: Vec<u64> = liked.iter().map(|(id, _)| *id).collect();
    for t in most_played.iter().take(5) {
        if !seed_ids.contains(&t.id) {
            seed_ids.push(t.id);
        }
    }
    seed_ids.truncate(10);

    // Set completo de tracks ja tocadas: o payload play_count de
    // rustify_tracks e fossil, entao o filtro do discover consulta os
    // enrichments (uma passada; acervo ~1.3k pontos).
    let played_all = client.scroll_enrichments(Some(played_filter), None, 10_000)?;
    let played_ids: std::collections::HashSet<u64> =
        played_all.iter().map(|(id, _)| *id).collect();

    let based_on_top = if !seed_ids.is_empty() {
        let rec_ids = client.recommend(&seed_ids, &[], &[], 10)?;
        let mut tracks = Vec::new();
        for (tid, _score) in rec_ids {
            if let Some(t) = get_track(client, tid)? {
                if !seed_ids.contains(&t.id) {
                    tracks.push(t);
                }
            }
        }
        tracks
    } else {
        Vec::new()
    };

    let discover = if !seed_ids.is_empty() {
        let rec_ids = client.recommend(&seed_ids, &[], &[], 20)?;
        let mut tracks = Vec::new();
        for (tid, _score) in rec_ids {
            if let Some(t) = get_track(client, tid)? {
                if !played_ids.contains(&t.id) && !seed_ids.contains(&t.id) {
                    tracks.push(t);
                }
            }
        }
        tracks.truncate(10);
        tracks
    } else {
        Vec::new()
    };

    Ok(Recommendations {
        most_played,
        based_on_top,
        discover,
    })
}

// ---------------------------------------------------------------------------
// Similar, shuffle, folders
// ---------------------------------------------------------------------------

pub fn similar(
    client: &QdrantClient,
    track_id: u64,
    limit: usize,
) -> Result<Vec<(Track, f32)>, IndexerError> {
    let recs = client.recommend(&[track_id], &[], &[], limit)?;
    let mut results = Vec::new();
    for (tid, score) in recs {
        if let Some(t) = get_track(client, tid)? {
            results.push((t, score as f32));
        }
    }
    Ok(results)
}

pub fn shuffle(
    client: &QdrantClient,
    filter: &TrackFilter,
    seed: u64,
    limit: usize,
) -> Result<Vec<Track>, IndexerError> {
    let fetch_filter = TrackFilter {
        limit: Some(limit * 3),
        genre: filter.genre.clone(),
        artist: filter.artist.clone(),
        album: filter.album.clone(),
        tags: filter.tags.clone(),
        order: TrackOrder::AlbumDiscTrack,
    };
    let mut tracks = list_tracks(client, &fetch_filter)?;
    let mut rng = seed;
    for i in (1..tracks.len()).rev() {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let j = (rng as usize) % (i + 1);
        tracks.swap(i, j);
    }
    tracks.truncate(limit);
    Ok(tracks)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FolderPlaylist {
    #[serde(rename = "name")]
    pub folder: String,
    pub track_count: u32,
    /// Backward-compat: primeira cover encontrada.
    pub cover_path: Option<PathBuf>,
    /// Ate 4 covers distintas (de albums/tracks diferentes) — usado pra
    /// mosaico 2x2 no frontend. Ordem: primeiras 4 encontradas no scroll.
    #[serde(default)]
    pub cover_paths: Vec<PathBuf>,
}

const MOSAIC_MAX_COVERS: usize = 4;

pub fn list_folders(
    client: &QdrantClient,
    music_root: &str,
) -> Result<Vec<FolderPlaylist>, IndexerError> {
    let all = client.scroll_all_payloads(&["path", "cover_path"])?;
    let mut folder_map: HashMap<String, (u32, Vec<PathBuf>)> = HashMap::new();
    let root = std::path::Path::new(music_root);

    for (_, payload) in &all {
        let path_str = payload["path"].as_str().unwrap_or("");
        let path = std::path::Path::new(path_str);
        if let Ok(rel) = path.strip_prefix(root) {
            let mut components = rel.components();
            if let Some(first) = components.next() {
                // Only use first-level directory as folder name
                if components.next().is_some() {
                    let folder = first.as_os_str().to_string_lossy().to_string();
                    if !folder.is_empty() {
                        let entry = folder_map.entry(folder).or_insert((0, Vec::new()));
                        entry.0 += 1;
                        if entry.1.len() < MOSAIC_MAX_COVERS {
                            if let Some(cover) = payload["cover_path"].as_str().map(PathBuf::from) {
                                // Distinct: skip if already present
                                if !entry.1.contains(&cover) {
                                    entry.1.push(cover);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let mut folders: Vec<FolderPlaylist> = folder_map
        .into_iter()
        .map(|(folder, (track_count, cover_paths))| FolderPlaylist {
            folder,
            track_count,
            cover_path: cover_paths.first().cloned(),
            cover_paths,
        })
        .collect();
    folders.sort_by(|a, b| a.folder.cmp(&b.folder));
    Ok(folders)
}

pub fn list_folder_tracks(
    client: &QdrantClient,
    music_root: &str,
    folder: &str,
) -> Result<Vec<Track>, IndexerError> {
    let prefix = format!("{}/{}", music_root.trim_end_matches('/'), folder);
    let all = client.scroll_all_payloads(&[
        "path",
        "filename",
        "title",
        "track_number",
        "disc_number",
        "duration_ms",
        "album_title",
        "album_year",
        "cover_path",
        "artist",
        "genre",
        "tags",
        "sample_rate",
        "bit_depth",
        "channels",
        "rg_track_gain",
        "rg_album_gain",
        "rg_track_peak",
        "rg_album_peak",
        "embedding_status",
        "play_count",
        "last_played",
        "liked_at",
        "lrc_path",
    ])?;

    let mut tracks: Vec<Track> = all
        .iter()
        .filter(|(_, p)| {
            p["path"]
                .as_str()
                .map(|s| s.starts_with(&prefix))
                .unwrap_or(false)
        })
        .map(|(id, p)| payload_to_track(*id, p))
        .collect();
    tracks.sort_by(|a, b| {
        a.disc_number
            .cmp(&b.disc_number)
            .then(a.track_number.cmp(&b.track_number))
            .then(a.title.cmp(&b.title))
    });
    Ok(tracks)
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

pub fn get_lyrics(
    client: &QdrantClient,
    track_id: u64,
) -> Result<Vec<crate::lyrics::LyricLine>, IndexerError> {
    let point = match client.get_point(track_id)? {
        Some(p) => p,
        None => return Ok(Vec::new()),
    };
    let payload = &point["payload"];

    if let Some(lrc) = payload["lrc_path"].as_str() {
        let path = std::path::Path::new(lrc);
        if path.is_file() {
            return crate::lyrics::parse_lrc_file(path);
        }
    }

    if let Some(text) = payload["embedded_lyrics"].as_str() {
        if !text.trim().is_empty() {
            // embedded_lyrics e um LRC completo: parsear pra sincronizar e limpar
            // o "[mm:ss]" do texto. So cai pra texto plano se nao houver timestamps.
            return Ok(crate::lyrics::lyrics_from_embedded(text));
        }
    }

    Ok(Vec::new())
}

// ---------------------------------------------------------------------------
// Autoplay
// ---------------------------------------------------------------------------

pub fn autoplay_next(
    client: &QdrantClient,
    seed_track_id: u64,
    exclude_ids: &[u64],
    limit: usize,
) -> Result<Vec<(u64, f64)>, IndexerError> {
    // exclude_ids is a hard exclusion (filter), not a Qdrant negative — recently
    // played tracks should be filtered out, not used to skew the recommendation
    // vector away from their semantic neighborhood.
    let recs = client.recommend(&[seed_track_id], &[], exclude_ids, limit)?;
    Ok(recs)
}

// ---------------------------------------------------------------------------
// Playlist search (folder-based)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlaylistSearchResult {
    pub folder: String,
    pub tracks: Vec<Track>,
}

pub fn search_playlists(
    client: &QdrantClient,
    music_root: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<PlaylistSearchResult>, IndexerError> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    let folders = list_folders(client, music_root)?;
    let matching: Vec<&FolderPlaylist> = folders
        .iter()
        .filter(|f| f.folder.to_lowercase().contains(&q))
        .take(limit)
        .collect();

    let mut results = Vec::new();
    for f in matching {
        let tracks = list_folder_tracks(client, music_root, &f.folder)?;
        results.push(PlaylistSearchResult {
            folder: f.folder.clone(),
            tracks,
        });
    }
    Ok(results)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{match_score, norm};

    #[test]
    fn norm_lowercases_and_strips_accents() {
        assert_eq!(norm("Amari"), "amari");
        assert_eq!(norm("  Beyoncé  "), "beyonce");
        assert_eq!(norm("Olá Mündo Çödê"), "ola mundo code");
        assert_eq!(norm("J. Cole"), "j. cole");
    }

    // O BUG reportado: buscar "amari" (minúsculo) deve achar a track "Amari"
    // (capitalizada no metadata). O fallback case-sensitive do Qdrant falhava aqui.
    #[test]
    fn matches_case_insensitively_the_reported_bug() {
        let s = match_score("amari", "amari", "j. cole", "the off-season");
        assert!(s > 0, "query 'amari' deve casar título 'Amari' (case-insensitive)");
    }

    #[test]
    fn matches_word_in_the_middle_of_title() {
        // "role" deve achar "No Role Modelz" (palavra do meio, case-insensitive).
        let s = match_score("role", "no role modelz", "j. cole", "");
        assert!(s > 0, "query 'role' deve casar 'No Role Modelz'");
    }

    #[test]
    fn matches_accent_insensitively() {
        let s = match_score("beyonce", "halo", "beyonce", "");
        assert!(s > 0, "query sem acento deve casar artista com acento");
    }

    #[test]
    fn no_match_returns_zero() {
        assert_eq!(match_score("xyzzy", "amari", "j. cole", "the off-season"), 0);
    }

    #[test]
    fn empty_needle_never_matches() {
        // Guard defensivo: needle vazio não deve casar tudo via starts_with("").
        assert_eq!(match_score("", "amari", "j. cole", "x"), 0);
    }

    #[test]
    fn exact_title_ranks_above_prefix_title() {
        let exact = match_score("amari", "amari", "", "");
        let prefix = match_score("amari", "amari (slowed)", "", "");
        assert!(exact > prefix, "match exato no título > prefixo no título");
    }

    #[test]
    fn title_match_ranks_above_artist_match() {
        // Mesma needle: casar no título vale mais que casar no artista.
        let by_title = match_score("cole", "cole world", "someone", "");
        let by_artist = match_score("cole", "different", "j. cole", "");
        assert!(by_title > by_artist, "match no título > match no artista");
    }

    #[test]
    fn substring_ranks_below_word_prefix() {
        // "ari": word_prefix em "Ari Lennox" vs substring em "Amari".
        let word_prefix = match_score("ari", "ari lennox", "", "");
        let substring = match_score("ari", "amari", "", "");
        assert!(word_prefix > substring, "prefixo de palavra > substring no meio");
    }

    // --- Busca multi-palavra (query dominante "artista faixa" no acervo) ---
    // O filtro Qdrant antigo fazia AND de tokens order-independent dentro de um
    // campo; tratar a needle como string única era regressão.

    #[test]
    fn multiword_matches_artist_in_order() {
        let s = match_score("kendrick lamar", "humble.", "kendrick lamar", "damn");
        assert!(s > 0, "'kendrick lamar' deve casar o artista 'Kendrick Lamar'");
    }

    #[test]
    fn multiword_is_order_independent() {
        // Ordem trocada deve casar igual (AND de tokens, não substring literal).
        let s = match_score("lamar kendrick", "humble.", "kendrick lamar", "damn");
        assert!(s > 0, "'lamar kendrick' (ordem trocada) deve casar 'Kendrick Lamar'");
    }

    #[test]
    fn multiword_matches_across_fields() {
        // Um token no artista, outro no título.
        let s = match_score("kendrick humble", "humble.", "kendrick lamar", "damn");
        assert!(s > 0, "tokens em campos diferentes (artista+título) devem casar");
    }

    #[test]
    fn multiword_requires_all_tokens() {
        // AND: se um token não casa em lugar nenhum, não há match.
        let s = match_score("kendrick zzzqqq", "humble.", "kendrick lamar", "damn");
        assert_eq!(s, 0, "token sem match em nenhum campo zera o resultado (AND)");
    }

    // --- Títulos estilizados com letras espaçadas (ex: J. Cole "The Off-Season") ---
    // O metadata traz "a m a r i", "m y . l i f e" etc; buscar "amari" deve casar
    // ignorando espaçamento e pontuação.

    #[test]
    fn matches_letter_spaced_title() {
        let s = match_score("amari", "a m a r i", "j. cole", "the off-season");
        assert!(s > 0, "'amari' deve casar o título estilizado 'a m a r i'");
    }

    #[test]
    fn matches_letter_spaced_multiword() {
        let s = match_score("my life", "m y . l i f e", "j. cole", "the off-season");
        assert!(s > 0, "'my life' deve casar 'm y . l i f e'");
    }

    #[test]
    fn squish_fallback_ranks_below_normal_match() {
        let spaced = match_score("amari", "a m a r i", "j. cole", "");
        let normal = match_score("amari", "amari", "j. cole", "");
        assert!(spaced > 0, "estilizado deve casar");
        assert!(normal > spaced, "match normal de título > match via squish");
    }

    #[test]
    fn short_needle_does_not_oversquish() {
        // needle de 1-2 chars não deve casar via squish (evita ruído).
        assert_eq!(match_score("a", "x y z w q", "", ""), 0);
    }
}
