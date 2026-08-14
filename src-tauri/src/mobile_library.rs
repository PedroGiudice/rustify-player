// Biblioteca do Android v0 — manifest-backed.
//
// O track_id canônico é o do DESKTOP (hash do path absoluto da cmr-auto,
// types.rs path_to_id) — o celular não consegue derivá-lo dos arquivos
// transcodados. A fonte é o manifest exportado por
// scripts/android/export_manifest.py, colocado no celular em
// `<MUSIC_ROOT>/.rustify/manifest.json`, e a resolução manifest→arquivo
// físico é por stem canônico: o sync pro celular substituiu caracteres que o
// MediaProvider rejeita (: * ? " < > |) por `_`, então a canonicalização
// remove [:*?"<>|_-] dos DOIS lados e colapsa espaços (validado 1746/1746
// contra o staging em 2026-08-13).

use crate::mobile_intel::{self, Station, StationMeta, Taste, VectorIndex};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const MUSIC_ROOT: &str = "/storage/emulated/0/Music";
const MANIFEST_REL: &str = ".rustify/manifest.json";
const VECTORS_REL: &str = ".rustify/vectors.bin";
const TASTE_REL: &str = ".rustify/taste.json";
const STATIONS_REL: &str = ".rustify/stations.json";

#[derive(Deserialize)]
struct Manifest {
    tracks: Vec<ManifestTrack>,
}

#[derive(Deserialize)]
struct ManifestTrack {
    track_id: String,
    rel_path: String,
    title: String,
    artist: String,
    album: String,
    duration_ms: i64,
    track_number: i64,
    #[allow(dead_code)]
    disc_number: i64,
    genre: String,
    #[serde(default)]
    album_year: Option<i64>,
    #[serde(default)]
    dominant_color: Option<String>,
}

/// Espelha a interface `Track` de src/tauri.ts (subset que o mobile provê).
#[derive(Clone, Serialize)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist_name: Option<String>,
    pub album_title: Option<String>,
    pub album_cover_path: Option<String>,
    pub album_year: Option<i64>,
    pub duration_ms: i64,
    pub path: String,
    pub lrc_path: Option<String>,
    pub track_number: Option<i64>,
    pub genre_name: Option<String>,
    /// Hex "#rrggbb" da capa (enrichment do desktop) — ink/accent adaptativos.
    pub dominant_color: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Folder {
    pub name: String,
    pub track_count: usize,
}

pub struct MobileLibrary {
    tracks: Vec<Track>,
    by_id: HashMap<String, usize>,
    /// playlist (pasta de 1º nível) → índices em `tracks`, ordem do manifest
    /// (rel_path ordenado = disco/faixa na prática).
    folders: Vec<(String, Vec<usize>)>,
    /// Artefatos de inteligência (CMR-190) — TODOS opcionais: manifest antigo
    /// sem eles não pode quebrar o app (vira biblioteca sem inteligência).
    vectors: Option<VectorIndex>,
    taste: Taste,
    stations: Vec<Station>,
}

/// Stem canônico p/ casar manifest (nomes originais do desktop) com arquivos
/// do celular (sanitizados pelo MediaProvider). Simétrico: aplica-se aos dois
/// lados.
fn canon_stem(rel_path: &str) -> String {
    // Extensão válida: ≤5 chars alfanuméricos após o último '.' — sem '/'
    // nem espaço (diretórios com ponto, ex. "Vol. 1", não podem cortar).
    let no_ext = match rel_path.rsplit_once('.') {
        Some((stem, ext))
            if ext.len() <= 5 && !ext.is_empty()
                && ext.chars().all(|c| c.is_ascii_alphanumeric()) =>
        {
            stem
        }
        _ => rel_path,
    };
    let mut out = String::with_capacity(no_ext.len());
    let mut last_space = false;
    for c in no_ext.to_lowercase().chars() {
        let c = match c {
            ':' | '*' | '?' | '"' | '<' | '>' | '|' | '_' | '-' => ' ',
            other => other,
        };
        if c == ' ' {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim().to_string()
}

/// Varre o acervo e indexa arquivos de áudio por stem canônico.
/// `.lrc` sidecars e capas ficam em mapas próprios (por stem / por pasta).
fn walk_music(root: &Path) -> (HashMap<String, PathBuf>, HashMap<String, PathBuf>, HashMap<PathBuf, PathBuf>) {
    const AUDIO_EXTS: [&str; 7] = ["opus", "ogg", "mp3", "m4a", "aac", "flac", "wav"];
    const COVER_NAMES: [&str; 4] = ["cover.jpg", "cover.jpeg", "cover.png", "folder.jpg"];

    let mut audio = HashMap::new();
    let mut lrc = HashMap::new();
    let mut covers = HashMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if !name.starts_with('.') {
                    stack.push(path);
                }
                continue;
            }
            let Some(rel) = path.strip_prefix(root).ok().map(|r| r.to_string_lossy().to_string()) else {
                continue;
            };
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if AUDIO_EXTS.contains(&ext.as_str()) {
                audio.insert(canon_stem(&rel), path);
            } else if ext == "lrc" {
                lrc.insert(canon_stem(&rel), path);
            } else if COVER_NAMES.contains(&name.to_lowercase().as_str()) {
                covers.entry(dir.clone()).or_insert(path);
            }
        }
    }
    (audio, lrc, covers)
}

/// Carrega os artefatos de inteligência de `.rustify/` — cada um tolera
/// ausência/corrupção individualmente (log + fallback vazio).
fn load_intel(root: &Path) -> (Option<VectorIndex>, Taste, Vec<Station>) {
    let vectors = match std::fs::read(root.join(VECTORS_REL)) {
        Ok(bytes) => match VectorIndex::parse(&bytes) {
            Ok(vx) => {
                tracing::info!(vectors = vx.len(), "mobile intel: vectors.bin carregado");
                Some(vx)
            }
            Err(e) => {
                tracing::warn!(%e, "mobile intel: vectors.bin ilegível — sem similaridade");
                None
            }
        },
        Err(_) => None,
    };
    let taste = std::fs::read(root.join(TASTE_REL))
        .ok()
        .and_then(|b| match Taste::parse(&b) {
            Ok(t) => Some(t),
            Err(e) => {
                tracing::warn!(%e, "mobile intel: taste.json ilegível");
                None
            }
        })
        .unwrap_or_default();
    let stations = std::fs::read(root.join(STATIONS_REL))
        .ok()
        .and_then(|b| match mobile_intel::parse_stations(&b) {
            Ok(s) => Some(s),
            Err(e) => {
                tracing::warn!(%e, "mobile intel: stations.json ilegível");
                None
            }
        })
        .unwrap_or_default();
    (vectors, taste, stations)
}

impl MobileLibrary {
    /// Carrega manifest + resolve arquivos. Erros viram biblioteca vazia com
    /// log — sem permissão de storage o walk devolve nada e a UI mostra
    /// estado vazio em vez de crash.
    pub fn load() -> Self {
        let root = Path::new(MUSIC_ROOT);
        let manifest_path = root.join(MANIFEST_REL);
        let manifest: Manifest = match std::fs::read(&manifest_path)
            .map_err(|e| e.to_string())
            .and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string()))
        {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!(%e, path = %manifest_path.display(), "manifest ausente/ilegível — biblioteca vazia");
                return Self {
                    tracks: vec![],
                    by_id: HashMap::new(),
                    folders: vec![],
                    vectors: None,
                    taste: Taste::default(),
                    stations: vec![],
                };
            }
        };

        let (audio, lrc, covers) = walk_music(root);
        tracing::info!(
            manifest = manifest.tracks.len(),
            audio_files = audio.len(),
            "mobile library: resolvendo manifest contra o acervo local"
        );

        let mut tracks = Vec::with_capacity(manifest.tracks.len());
        let mut by_id = HashMap::new();
        let mut folder_map: HashMap<String, Vec<usize>> = HashMap::new();
        let mut unresolved = 0usize;

        for mt in manifest.tracks {
            let stem = canon_stem(&mt.rel_path);
            let Some(file) = audio.get(&stem) else {
                unresolved += 1;
                continue;
            };
            let folder = mt
                .rel_path
                .split('/')
                .next()
                .unwrap_or("(raiz)")
                .to_string();
            let cover = file
                .parent()
                .and_then(|d| covers.get(d))
                .map(|p| p.to_string_lossy().to_string());
            let idx = tracks.len();
            by_id.insert(mt.track_id.clone(), idx);
            folder_map.entry(folder).or_default().push(idx);
            tracks.push(Track {
                id: mt.track_id,
                title: mt.title,
                artist_name: (!mt.artist.is_empty()).then_some(mt.artist),
                album_title: (!mt.album.is_empty()).then_some(mt.album),
                album_cover_path: cover,
                album_year: mt.album_year,
                duration_ms: mt.duration_ms,
                path: file.to_string_lossy().to_string(),
                lrc_path: lrc.get(&stem).map(|p| p.to_string_lossy().to_string()),
                track_number: (mt.track_number > 0).then_some(mt.track_number),
                genre_name: (!mt.genre.is_empty()).then_some(mt.genre),
                dominant_color: mt.dominant_color,
            });
        }
        if unresolved > 0 {
            tracing::warn!(unresolved, "tracks do manifest sem arquivo local");
        }

        let mut folders: Vec<(String, Vec<usize>)> = folder_map.into_iter().collect();
        folders.sort_by(|a, b| a.0.cmp(&b.0));

        let (vectors, taste, stations) = load_intel(root);
        Self { tracks, by_id, folders, vectors, taste, stations }
    }

    pub fn folders(&self) -> Vec<Folder> {
        self.folders
            .iter()
            .map(|(name, idxs)| Folder { name: name.clone(), track_count: idxs.len() })
            .collect()
    }

    pub fn folder_tracks(&self, name: &str) -> Vec<Track> {
        self.folders
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, idxs)| idxs.iter().map(|&i| self.tracks[i].clone()).collect())
            .unwrap_or_default()
    }

    pub fn all_tracks(&self) -> &[Track] {
        &self.tracks
    }

    pub fn by_ids(&self, ids: &[String]) -> Vec<Track> {
        ids.iter()
            .filter_map(|id| self.by_id.get(id).map(|&i| self.tracks[i].clone()))
            .collect()
    }

    // ── Inteligência local (CMR-190) ─────────────────────────────────────────

    /// Vizinhos por cosine no espaço mert. Só devolve tracks RESOLVIDAS
    /// (com arquivo local) — pede 3× k ao índice pra compensar unresolved.
    pub fn similar_tracks(&self, id: &str, k: usize) -> Vec<Track> {
        let Some(vx) = &self.vectors else { return Vec::new() };
        let Ok(tid) = id.parse::<u64>() else { return Vec::new() };
        vx.similar(tid, k * 3, &HashSet::new())
            .into_iter()
            .filter_map(|(t, _)| self.by_id.get(&t.to_string()).map(|&i| self.tracks[i].clone()))
            .take(k)
            .collect()
    }

    pub fn stations_meta(&self) -> Vec<StationMeta> {
        self.stations.iter().map(|s| s.meta.clone()).collect()
    }

    /// Lote de uma station: pool precomputado → re-rank por gosto → sorteio
    /// ponderado no prefixo (variedade entre chamadas) → resolve pra Track.
    /// `exclude` = já tocadas/na fila nesta rodada.
    pub fn station_batch(
        &self,
        station_id: &str,
        exclude: &[String],
        limit: usize,
        seed: u64,
    ) -> Vec<Track> {
        let Some(station) = self.stations.iter().find(|s| s.meta.id == station_id) else {
            return Vec::new();
        };
        let exclude_set: HashSet<u64> =
            exclude.iter().filter_map(|s| s.parse().ok()).collect();
        let mut ranked: Vec<u64> =
            mobile_intel::rank_pool(&station.pool, &self.taste, self.vectors.as_ref())
                .into_iter()
                .filter(|t| {
                    !exclude_set.contains(t) && self.by_id.contains_key(&t.to_string())
                })
                .collect();
        mobile_intel::weighted_pick_prefix(&mut ranked, limit * 3, seed);
        ranked
            .into_iter()
            .take(limit)
            .filter_map(|t| self.by_id.get(&t.to_string()).map(|&i| self.tracks[i].clone()))
            .collect()
    }

    /// Positives do snapshot de gosto, na ordem do snapshot (rail
    /// "Based on your favorites"). Só as resolvidas.
    pub fn taste_positive_tracks(&self) -> Vec<Track> {
        self.taste
            .positives
            .iter()
            .filter_map(|t| self.by_id.get(&t.to_string()).map(|&i| self.tracks[i].clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::canon_stem;

    #[test]
    fn canon_remove_proibidos_e_colapsa() {
        // fonte desktop com ':' vs celular sanitizado com '_'
        assert_eq!(
            canon_stem("Blues/E/Vol. 1: The Early Show/04 - A.flac"),
            canon_stem("Blues/E/Vol. 1_ The Early Show/04 _ A.opus"),
        );
        // '<' '>' → '_' (caso real: "> Album Title Goes Here <")
        assert_eq!(
            canon_stem("E/> Album Title Goes Here </Strobe.flac"),
            canon_stem("E/_ Album Title Goes Here _/Strobe.opus"),
        );
        // '?' no fim do stem
        assert_eq!(
            canon_stem("R/x/102 - What's the Use?.flac"),
            canon_stem("R/x/102 - What's the Use_.opus"),
        );
    }

    #[test]
    fn canon_preserva_stem_sem_extensao_longa() {
        // sufixo após '.' com mais de 5 chars não é extensão
        assert_eq!(canon_stem("a/b/Mr. Bojangles"), "a/b/mr. bojangles");
    }
}
