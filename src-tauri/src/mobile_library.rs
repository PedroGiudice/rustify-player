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
    /// Estado do like exportado do desktop (CMR-220). Ausentes em manifest
    /// antigo; `like_updated_at` sem `liked_at` = descurtida (o LWW local
    /// precisa do carimbo para não ressuscitar um like velho).
    #[serde(default)]
    liked_at: Option<i64>,
    #[serde(default)]
    like_updated_at: Option<i64>,
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
    /// Like semeado pelo manifest (CMR-220); a UI aplica LWW com o override
    /// local por `like_updated_at`.
    pub liked_at: Option<i64>,
    pub like_updated_at: Option<i64>,
}

#[derive(Clone, Serialize)]
pub struct Folder {
    pub name: String,
    pub track_count: usize,
}

/// De onde saiu o lote de rádio. `Vector` é o modo bom; os outros dois são
/// degradação honesta — a faixa não tem vetor (leva nova ainda sem MERT) e o
/// rádio precisa tocar assim mesmo.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RadioLayer {
    Vector,
    ArtistFolder,
    Library,
}

/// Primeiro lote de um rádio + como ele foi obtido.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadioStart {
    pub tracks: Vec<Track>,
    pub layer: RadioLayer,
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
                liked_at: mt.liked_at,
                like_updated_at: mt.like_updated_at,
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
    /// Negatives do gosto ficam de fora: sugerir skip conhecido é desperdício
    /// (o rail é pequeno). Recentes NÃO são excluídas — isto é um rail de
    /// navegação ("o que parece com isto"), não um rádio.
    pub fn similar_tracks(&self, id: &str, k: usize) -> Vec<Track> {
        let Some(vx) = &self.vectors else { return Vec::new() };
        let Ok(tid) = id.parse::<u64>() else { return Vec::new() };
        let negatives: HashSet<u64> = self.taste.negatives.iter().copied().collect();
        vx.similar(tid, k * 3, &negatives)
            .into_iter()
            .filter_map(|(t, _)| self.by_id.get(&t.to_string()).map(|&i| self.tracks[i].clone()))
            .take(k)
            .collect()
    }

    /// Como o lote de rádio foi obtido. A UI usa isto para ser honesta sobre
    /// o modo degradado em vez de fingir que a recomendação é a boa.
    pub fn radio_candidates(
        &self,
        seed_id: &str,
        exclude: &[String],
        session_negatives: &[u64],
        limit: usize,
        seed: u64,
    ) -> (Vec<Track>, RadioLayer) {
        let vetor = self.radio_batch(seed_id, exclude, session_negatives, limit, seed);
        if !vetor.is_empty() {
            return (vetor, RadioLayer::Vector);
        }
        // Faixa sem linha no vectors.bin (leva nova que ainda não passou pelo
        // MERT) ou vizinhança inteira já excluída. Devolver vazio aqui é o que
        // fazia a música PARAR e a UI acusar erro de configuração.
        let vizinhos = self.artist_or_folder_batch(seed_id, exclude, limit, seed);
        if !vizinhos.is_empty() {
            return (vizinhos, RadioLayer::ArtistFolder);
        }
        let acervo = self.library_batch(seed_id, exclude, limit, seed);
        if !acervo.is_empty() || self.tracks.is_empty() {
            return (acervo, RadioLayer::Library);
        }
        // Último recurso: o exclude (recentes + sessão) engoliu o acervo
        // inteiro — acervo pequeno, sessão longa. Repetir o que tocou há
        // pouco é melhor que silêncio, que é a única alternativa aqui.
        (self.library_batch(seed_id, &[], limit, seed), RadioLayer::Library)
    }

    /// Camada 2: quem acompanha a faixa no acervo — mesmo artista primeiro,
    /// depois a pasta (playlist) em que ela vive. Sem vetor nenhum envolvido.
    fn artist_or_folder_batch(
        &self,
        seed_id: &str,
        exclude: &[String],
        limit: usize,
        seed: u64,
    ) -> Vec<Track> {
        let Some(&si) = self.by_id.get(seed_id) else { return Vec::new() };
        let mut blocked: HashSet<&str> = exclude.iter().map(|s| s.as_str()).collect();
        blocked.insert(seed_id);
        let artista = self.tracks[si].artist_name.as_deref();
        let pasta = self
            .folders
            .iter()
            .find(|(_, idx)| idx.contains(&si))
            .map(|(name, _)| name.as_str());

        let mut do_artista: Vec<usize> = Vec::new();
        if let Some(a) = artista.filter(|a| !a.trim().is_empty()) {
            do_artista.extend(self.tracks.iter().enumerate().filter_map(|(i, t)| {
                (t.artist_name.as_deref() == Some(a) && !blocked.contains(t.id.as_str()))
                    .then_some(i)
            }));
        }
        let mut da_pasta: Vec<usize> = Vec::new();
        if let Some(p) = pasta {
            let ja: HashSet<usize> = do_artista.iter().copied().collect();
            if let Some((_, idx)) = self.folders.iter().find(|(name, _)| name == p) {
                da_pasta.extend(idx.iter().copied().filter(|i| {
                    !ja.contains(i) && !blocked.contains(self.tracks[*i].id.as_str())
                }));
            }
        }
        // Embaralha DENTRO de cada camada, nunca entre elas: um único shuffle
        // no pool inteiro jogaria fora a prioridade do artista, que é a razão
        // de a camada existir.
        mobile_intel::shuffle(&mut do_artista, seed);
        mobile_intel::shuffle(&mut da_pasta, seed ^ 0x5DEE_CE66);
        do_artista
            .into_iter()
            .chain(da_pasta)
            .take(limit)
            .map(|i| self.tracks[i].clone())
            .collect()
    }

    /// Camada 3: o acervo inteiro, embaralhado. Só falha se a biblioteca
    /// estiver vazia — e aí não havia o que tocar mesmo.
    fn library_batch(
        &self,
        seed_id: &str,
        exclude: &[String],
        limit: usize,
        seed: u64,
    ) -> Vec<Track> {
        let mut blocked: HashSet<&str> = exclude.iter().map(|s| s.as_str()).collect();
        blocked.insert(seed_id);
        let mut pool: Vec<usize> = self
            .tracks
            .iter()
            .enumerate()
            .filter_map(|(i, t)| (!blocked.contains(t.id.as_str())).then_some(i))
            .collect();
        mobile_intel::shuffle(&mut pool, seed);
        pool.into_iter().take(limit).map(|i| self.tracks[i].clone()).collect()
    }

    /// Lote de rádio semeado por uma faixa — o autoplay de qualquer fila que
    /// não seja station. Pool DUPLO (vizinhança da semente ∪ vizinhança do
    /// gosto), cap de 2 por artista no topo, sorteio ponderado no prefixo.
    /// Vazio = a faixa não tem vetor; quem trata é [`radio_candidates`].
    pub fn radio_batch(
        &self,
        seed_id: &str,
        exclude: &[String],
        session_negatives: &[u64],
        limit: usize,
        seed: u64,
    ) -> Vec<Track> {
        let Some(vx) = &self.vectors else { return Vec::new() };
        let Ok(tid) = seed_id.parse::<u64>() else { return Vec::new() };
        let exclude_set: HashSet<u64> =
            exclude.iter().filter_map(|s| s.parse().ok()).collect();
        let ranked: Vec<u64> = mobile_intel::autoplay_pool(
            tid,
            &self.taste,
            vx,
            &exclude_set,
            mobile_intel::POOL_FETCH,
            session_negatives,
        )
        .into_iter()
        .filter(|t| self.by_id.contains_key(&t.to_string()))
        .collect();
        let mut capped = mobile_intel::cap_per_artist(
            ranked,
            |id| self.artist_of(id),
            mobile_intel::MAX_PER_ARTIST,
        );
        mobile_intel::weighted_pick_prefix(&mut capped, limit * 3, seed);
        capped
            .into_iter()
            .take(limit)
            .filter_map(|t| self.by_id.get(&t.to_string()).map(|&i| self.tracks[i].clone()))
            .collect()
    }

    fn artist_of(&self, id: u64) -> Option<String> {
        self.by_id
            .get(&id.to_string())
            .and_then(|&i| self.tracks[i].artist_name.clone())
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
        session_negatives: &[u64],
        limit: usize,
        seed: u64,
    ) -> Vec<Track> {
        let Some(station) = self.stations.iter().find(|s| s.meta.id == station_id) else {
            return Vec::new();
        };
        let exclude_set: HashSet<u64> =
            exclude.iter().filter_map(|s| s.parse().ok()).collect();
        let mut ranked: Vec<u64> = mobile_intel::rank_pool(
            &station.pool,
            &self.taste,
            self.vectors.as_ref(),
            session_negatives,
        )
        .into_iter()
        .filter(|t| !exclude_set.contains(t) && self.by_id.contains_key(&t.to_string()))
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
    use super::*;

    fn t(id: &str, artist: &str) -> Track {
        Track {
            id: id.into(),
            title: format!("t{id}"),
            artist_name: Some(artist.into()),
            album_title: None,
            album_cover_path: None,
            album_year: None,
            duration_ms: 180_000,
            path: format!("/m/{artist}/{id}.opus"),
            lrc_path: None,
            track_number: None,
            genre_name: None,
            dominant_color: None,
            liked_at: None,
            like_updated_at: None,
        }
    }

    /// Biblioteca sem NENHUM artefato de inteligência: é exatamente o estado de
    /// uma faixa recém-chegada do Crate, que ainda não passou pelo MERT.
    fn lib_sem_vetores() -> MobileLibrary {
        let tracks = vec![
            t("1", "A"),
            t("2", "A"),
            t("3", "A"),
            t("4", "B"),
            t("5", "C"),
        ];
        let by_id = tracks
            .iter()
            .enumerate()
            .map(|(i, tr)| (tr.id.clone(), i))
            .collect();
        MobileLibrary {
            tracks,
            by_id,
            folders: vec![("Rap".into(), vec![0, 1, 2, 3]), ("Jazz".into(), vec![4])],
            vectors: None,
            taste: Taste::default(),
            stations: Vec::new(),
        }
    }

    #[test]
    fn radio_de_faixa_sem_vetor_toca_o_artista() {
        let lib = lib_sem_vetores();
        let (tracks, layer) = lib.radio_candidates("1", &[], &[], 10, 7);
        assert_eq!(layer, RadioLayer::ArtistFolder);
        // nunca a própria semente
        assert!(!tracks.iter().any(|x| x.id == "1"));
        // as duas do mesmo artista vêm antes da vizinha só-de-pasta
        let ids: Vec<&str> = tracks.iter().map(|x| x.id.as_str()).collect();
        assert!(ids.contains(&"2") && ids.contains(&"3"));
        assert_eq!(
            ids.iter().position(|i| *i == "4").unwrap(),
            2,
            "a faixa que só divide a pasta entra depois do artista"
        );
    }

    #[test]
    fn artista_solitario_cai_pra_pasta_e_depois_pro_acervo() {
        let lib = lib_sem_vetores();
        // "5" é o único artista C, e a pasta dele só tem ele: sobra o acervo.
        let (tracks, layer) = lib.radio_candidates("5", &[], &[], 10, 7);
        assert_eq!(layer, RadioLayer::Library);
        assert_eq!(tracks.len(), 4);
        assert!(!tracks.iter().any(|x| x.id == "5"));
    }

    #[test]
    fn radio_nunca_devolve_vazio_com_acervo_nao_vazio() {
        let lib = lib_sem_vetores();
        for seed_id in ["1", "2", "3", "4", "5"] {
            let (tracks, _) = lib.radio_candidates(seed_id, &[], &[], 3, 11);
            assert!(!tracks.is_empty(), "rádio vazio para {seed_id}");
        }
        // id que nem existe no acervo: ainda assim toca (camada 3)
        let (tracks, layer) = lib.radio_candidates("999", &[], &[], 3, 11);
        assert_eq!(layer, RadioLayer::Library);
        assert_eq!(tracks.len(), 3);
    }

    #[test]
    fn fallback_respeita_o_exclude_da_rodada() {
        let lib = lib_sem_vetores();
        let exclude = vec!["2".to_string(), "3".to_string()];
        let (tracks, _) = lib.radio_candidates("1", &exclude, &[], 10, 7);
        assert!(!tracks.iter().any(|x| x.id == "2" || x.id == "3"));
    }

    use super::canon_stem;

    /// Estado do like semeado pelo manifest (CMR-220). Manifest antigo (sem os
    /// campos) e `null` explícito (descurtida exportada) precisam carregar —
    /// a biblioteca inteira viraria vazia se o parser rejeitasse.
    #[test]
    fn manifest_track_aceita_campos_novos_e_ausentes() {
        let base = r#""rel_path":"a/b.opus","title":"t","artist":"","album":"",
            "duration_ms":1,"track_number":0,"disc_number":1,"genre":"""#;
        let com: ManifestTrack = serde_json::from_str(&format!(
            r#"{{"track_id":"1",{base},"liked_at":1700000000,"like_updated_at":1700000100}}"#
        ))
        .unwrap();
        assert_eq!(com.liked_at, Some(1_700_000_000));
        assert_eq!(com.like_updated_at, Some(1_700_000_100));

        let sem: ManifestTrack =
            serde_json::from_str(&format!(r#"{{"track_id":"2",{base}}}"#)).unwrap();
        assert_eq!(sem.liked_at, None);
        assert_eq!(sem.like_updated_at, None);

        let descurtida: ManifestTrack = serde_json::from_str(&format!(
            r#"{{"track_id":"3",{base},"liked_at":null,"like_updated_at":1700000200}}"#
        ))
        .unwrap();
        assert_eq!(descurtida.liked_at, None);
        assert_eq!(descurtida.like_updated_at, Some(1_700_000_200));
    }

    /// O wire pro JS carrega os dois campos com os nomes do `Track` do
    /// types.ts (snake_case, sem rename).
    #[test]
    fn track_serializa_liked_at_e_like_updated_at() {
        let mut tr = t("1", "A");
        tr.liked_at = Some(5);
        let v = serde_json::to_value(&tr).unwrap();
        assert_eq!(v["liked_at"], 5);
        assert!(v["like_updated_at"].is_null());
    }

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
