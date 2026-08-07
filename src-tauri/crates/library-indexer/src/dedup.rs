//! dedup.rs — índice de dedup do acervo (`OwnedIndex`), collab-aware.
//!
//! Porta canônica de `stage_downloads.py::norm`/`artist_main` (Python) para
//! Rust. `slskd-client::rank` (Etapa A) tem uma cópia LOCAL da mesma lógica,
//! criada antes deste módulo existir — o teste de paridade entre as duas
//! cópias é responsabilidade da Etapa C, não deste módulo. NÃO editar
//! `rank.rs` a partir daqui.
//!
//! `OwnedIndex` responde duas perguntas sobre o acervo já indexado no
//! Qdrant: "essa faixa já existe?" (`lookup`/`lookup_collab_aware`, usado
//! como aviso pré-download) e "onde esse artista mora?" (`folder_for_artist`,
//! usado para sugerir o destino da playlist). Ver spec
//! `docs/superpowers/specs/2026-08-07-crate-in-app-downloads-design.md` §5.1.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::Path;

use crate::error::IndexerError;
use crate::qdrant_client::QdrantClient;

// ── norm / artist_main — porta canônica do stage_downloads.py ──────────

const FEAT_WORDS: [&str; 5] = ["feat", "ft", "featuring", "with", "prod"];

/// Lowercase, remove `(..)`/`[..]`, corta a partir de
/// feat|ft|featuring|with|prod, mantém só alfanumérico ASCII + espaço,
/// colapsa espaços. Porta de `stage_downloads.py::norm`.
pub fn norm(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    let lower = s.to_lowercase();
    let no_brackets = strip_bracketed(&lower);
    let no_feat = strip_feat_clause(&no_brackets);
    let alnum = keep_alnum_space(&no_feat);
    collapse_whitespace(&alnum)
}

/// Primeiro artista antes de `&`, `,`, `;`, `/` ou ` x `. Porta de
/// `stage_downloads.py::artist_main` — `;` incluído no conjunto de
/// separadores (tag real observada: "Adam Beyer; Bart Skils").
pub fn artist_main(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    let lower = s.to_lowercase();
    let first = first_artist_segment(&lower);
    norm(&first)
}

/// Substitui cada trecho `(...)`/`[...]` (não-aninhado, fechamento mais
/// próximo de qualquer tipo) por um único espaço — réplica de
/// `re.compile(r"[\(\[].*?[\)\]]")`.
fn strip_bracketed(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '(' || c == '[' {
            let close = chars[i + 1..].iter().position(|&c| c == ')' || c == ']');
            match close {
                Some(offset) => {
                    out.push(' ');
                    i += offset + 2;
                }
                None => {
                    out.push(c);
                    i += 1;
                }
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Trunca a string a partir da primeira ocorrência, como palavra inteira,
/// de feat/ft/featuring/with/prod — réplica de
/// `re.sub(r"\b(feat|ft|featuring|with|prod)\b.*", " ", s)`.
fn strip_feat_clause(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut i = 0;
    while i < chars.len() {
        if is_word(chars[i]) {
            let start = i;
            let mut j = i;
            while j < chars.len() && is_word(chars[j]) {
                j += 1;
            }
            let word: String = chars[start..j].iter().collect();
            if FEAT_WORDS.contains(&word.as_str()) {
                let prefix: String = chars[..start].iter().collect();
                return format!("{prefix} ");
            }
            i = j;
        } else {
            i += 1;
        }
    }
    s.to_string()
}

fn keep_alnum_space(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect()
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn first_artist_segment(s: &str) -> String {
    let mut cut = s.len();
    for (idx, c) in s.char_indices() {
        if c == '&' || c == ',' || c == ';' || c == '/' {
            cut = idx;
            break;
        }
    }
    if let Some(pos) = s.find(" x ") {
        if pos < cut {
            cut = pos;
        }
    }
    s[..cut].to_string()
}

/// Todos os artistas de uma credit string, splitados nos mesmos separadores
/// de `first_artist_segment` (`&`, `,`, `;`, `/`, ` x `) e normalizados —
/// usado só por `lookup_collab_aware` (interseção de conjuntos de artistas).
fn split_artist_tokens(s: &str) -> Vec<String> {
    let lower = s.to_lowercase().replace(" x ", "&");
    lower
        .split(['&', ',', ';', '/'])
        .map(norm)
        .filter(|t| !t.is_empty())
        .collect()
}

// ── OwnedIndex ──────────────────────────────────────────────────────────

/// Resultado de uma consulta ao acervo já indexado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedVerdict {
    pub track_id: u64,
    pub title: String,
    pub artist: String,
    pub folder: Option<String>,
}

/// Índice em memória do acervo, construído a partir do payload do Qdrant.
/// Chave primária `(artist_main(artist), norm(title))`; índice secundário
/// por `norm(title)` sozinho habilita `lookup_collab_aware` a considerar
/// candidatos cujo `artist_main` diverge do da consulta (colaborações).
pub struct OwnedIndex {
    entries: Vec<OwnedVerdict>,
    by_key: HashMap<(String, String), usize>,
    by_title: HashMap<String, Vec<usize>>,
    /// `artist_main` -> (folder -> contagem de faixas). `folder_for_artist`
    /// escolhe o mais frequente (empate: lexicograficamente menor) em vez
    /// da primeira pasta vista — determinístico independente da ordem de
    /// chegada das linhas do scroll do Qdrant.
    by_artist_folder_counts: HashMap<String, HashMap<String, u32>>,
}

impl OwnedIndex {
    fn empty() -> Self {
        OwnedIndex {
            entries: Vec::new(),
            by_key: HashMap::new(),
            by_title: HashMap::new(),
            by_artist_folder_counts: HashMap::new(),
        }
    }

    fn insert(&mut self, verdict: OwnedVerdict) {
        let artist_key = artist_main(&verdict.artist);
        let title_key = norm(&verdict.title);

        if let Some(folder) = verdict.folder.as_ref() {
            *self
                .by_artist_folder_counts
                .entry(artist_key.clone())
                .or_default()
                .entry(folder.clone())
                .or_insert(0) += 1;
        }

        let idx = self.entries.len();
        self.by_title.entry(title_key.clone()).or_default().push(idx);
        self.by_key.insert((artist_key, title_key), idx);
        self.entries.push(verdict);
    }

    /// Constrói o índice a partir do acervo inteiro no Qdrant — ~1300
    /// pontos, três campos, <200ms (spec §5.1). Linhas sem `artist`/`title`
    /// (payload incompleto) são ignoradas. `music_root` é o mesmo root
    /// absoluto usado por `query::list_folders` — o campo `path` do payload
    /// é sempre absoluto (`build_track_payload` grava `entry.path`, que vem
    /// de `walk_music_root(music_root)`).
    pub fn build(client: &QdrantClient, music_root: &Path) -> Result<Self, IndexerError> {
        let rows = client.scroll_all_payloads(&["artist", "title", "path"])?;
        let mut idx = OwnedIndex::empty();
        for (id, payload) in rows {
            let artist = payload["artist"].as_str().unwrap_or("").to_string();
            let title = payload["title"].as_str().unwrap_or("").to_string();
            if artist.is_empty() || title.is_empty() {
                continue;
            }
            let folder = payload["path"]
                .as_str()
                .and_then(|p| folder_from_path(music_root, p));
            idx.insert(OwnedVerdict {
                track_id: id,
                title,
                artist,
                folder,
            });
        }
        Ok(idx)
    }

    /// Consulta direta por `(artist_main, norm(title))`. Falso negativo é
    /// esperado quando a consulta lista o artista principal do acervo fora
    /// da primeira posição do credit — nesse caso, usar
    /// `lookup_collab_aware`.
    pub fn lookup(&self, artist: &str, title: &str) -> Option<&OwnedVerdict> {
        let key = (artist_main(artist), norm(title));
        self.by_key.get(&key).map(|&i| &self.entries[i])
    }

    /// Casa por título + interseção de artistas splitados — reproduz o
    /// `is_owned` de `discover_tracks.py`: "family ties — Baby Keem &
    /// Kendrick Lamar" bate com o acervo que só tem "Baby Keem", em
    /// qualquer posição do credit.
    pub fn lookup_collab_aware(&self, artist_credit: &str, title: &str) -> Option<&OwnedVerdict> {
        let query_tokens = split_artist_tokens(artist_credit);
        if query_tokens.is_empty() {
            return None;
        }
        let candidates = self.by_title.get(&norm(title))?;
        candidates.iter().find_map(|&i| {
            let entry = &self.entries[i];
            let owned_tokens = split_artist_tokens(&entry.artist);
            query_tokens
                .iter()
                .any(|t| owned_tokens.contains(t))
                .then_some(entry)
        })
    }

    /// Pasta (playlist de 1º nível) onde o artista já mora no acervo — usada
    /// para `suggested_dest`. `None` quando o artista não tem faixa indexada
    /// com `path` resolvível sob `music_root`. Entre pastas empatadas em
    /// contagem, a lexicograficamente menor vence — desempate determinístico,
    /// não depende da ordem de chegada do scroll do Qdrant.
    pub fn folder_for_artist(&self, artist: &str) -> Option<&str> {
        let counts = self.by_artist_folder_counts.get(&artist_main(artist))?;
        counts
            .iter()
            .max_by(|(fa, ca), (fb, cb)| ca.cmp(cb).then_with(|| fb.cmp(fa)))
            .map(|(f, _)| f.as_str())
    }
}

/// Playlist de 1º nível a partir de um path de faixa, relativo a
/// `music_root` — mesma definição de "playlist" que `query::list_folders`
/// (`query.rs:702`, canônica): `strip_prefix(music_root)` e a PRIMEIRA
/// componente do relativo, exigindo pelo menos mais um componente depois
/// dela (senão o "primeiro componente" seria o próprio arquivo, não uma
/// pasta). Agnóstico de profundidade — funciona tanto para o layout
/// canônico de 3 níveis (`Playlist/Artist/YYYY - Album/NN - Title.flac`)
/// quanto para o layout mais raso predominante no acervo real
/// (`Playlist/Album/NN - Title.flac`). `None` quando `path` não está sob
/// `music_root`, ou quando o arquivo está direto na raiz (sem pasta).
fn folder_from_path(music_root: &Path, path: &str) -> Option<String> {
    let rel = Path::new(path).strip_prefix(music_root).ok()?;
    let mut components = rel.components();
    let first = components.next()?;
    components.next()?;
    first.as_os_str().to_str().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── norm / artist_main ────────────────────────────────────────────

    #[test]
    fn norm_table() {
        let cases: &[(&str, &str)] = &[
            ("Money Trees (feat. Jay Rock)", "money trees"),
            ("Sicko Mode [Radio Edit]", "sicko mode"),
            ("Beyoncé", "beyonc"),
            ("Baby Keem & Kendrick Lamar", "baby keem kendrick lamar"),
            ("R&B Anthem", "r b anthem"),
            ("", ""),
        ];
        for (input, expected) in cases {
            assert_eq!(&norm(input), expected, "norm({input:?})");
        }
    }

    #[test]
    fn artist_main_table() {
        let cases: &[(&str, &str)] = &[
            ("Baby Keem & Kendrick Lamar", "baby keem"),
            ("Adam Beyer; Bart Skils", "adam beyer"),
            ("Travis Scott, Drake", "travis scott"),
            ("Rihanna feat. Jay-Z", "rihanna"),
            ("Beyoncé", "beyonc"),
            ("Daft Punk x Pharrell", "daft punk"),
        ];
        for (input, expected) in cases {
            assert_eq!(&artist_main(input), expected, "artist_main({input:?})");
        }
    }

    // ── OwnedIndex ────────────────────────────────────────────────────

    #[test]
    fn lookup_collab_aware_matches_partial_artist() {
        let mut idx = OwnedIndex::empty();
        idx.insert(OwnedVerdict {
            track_id: 42,
            title: "family ties".to_string(),
            artist: "Baby Keem".to_string(),
            folder: Some("Rap & Hip-Hop".to_string()),
        });

        // Credit com Kendrick na primeira posição: lookup simples
        // (artist_main = primeiro artista) erra o alvo porque o acervo só
        // tem "Baby Keem".
        assert!(idx
            .lookup("Kendrick Lamar & Baby Keem", "family ties")
            .is_none());

        // lookup_collab_aware casa pela interseção de artistas splitados —
        // "baby keem" aparece nos dois lados, fora da primeira posição.
        let verdict = idx
            .lookup_collab_aware("Kendrick Lamar & Baby Keem", "family ties")
            .expect("deve casar por interseção de artistas");
        assert_eq!(verdict.track_id, 42);
        assert_eq!(verdict.folder.as_deref(), Some("Rap & Hip-Hop"));
    }

    #[test]
    fn lookup_collab_aware_none_when_no_artist_overlaps() {
        let mut idx = OwnedIndex::empty();
        idx.insert(OwnedVerdict {
            track_id: 1,
            title: "family ties".to_string(),
            artist: "Baby Keem".to_string(),
            folder: None,
        });

        assert!(idx
            .lookup_collab_aware("Travis Scott & Drake", "family ties")
            .is_none());
    }

    #[test]
    fn folder_for_artist_returns_first_path_component() {
        let root = Path::new("/home/cmr-auto/Music");
        let path = "/home/cmr-auto/Music/Rap & Hip-Hop/Baco Exu do Blues/2018 - Bluesman/01 - Queima Minha Pele.flac";
        assert_eq!(
            folder_from_path(root, path).as_deref(),
            Some("Rap & Hip-Hop")
        );

        let mut idx = OwnedIndex::empty();
        idx.insert(OwnedVerdict {
            track_id: 7,
            title: "queima minha pele".to_string(),
            artist: "Baco Exu do Blues".to_string(),
            folder: folder_from_path(root, path),
        });

        assert_eq!(
            idx.folder_for_artist("Baco Exu do Blues"),
            Some("Rap & Hip-Hop")
        );
        assert_eq!(idx.folder_for_artist("Unknown Artist"), None);
    }

    // ── folder_from_path — profundidade mista do acervo real ───────────

    #[test]
    fn folder_from_path_two_levels() {
        // Layout raso predominante no acervo: <Playlist>/<Album>/<file>,
        // sem pasta de artista. O bug original (3x .parent() fixo) devolvia
        // "Music" (o próprio music_root) nesse caso.
        let root = Path::new("/home/cmr-auto/Music");
        let path = "/home/cmr-auto/Music/Rap & Hip-Hop/2018 - Bluesman/01 - Queima Minha Pele.flac";
        assert_eq!(
            folder_from_path(root, path).as_deref(),
            Some("Rap & Hip-Hop")
        );
    }

    #[test]
    fn folder_from_path_three_plus_levels() {
        // Layout canônico: <Playlist>/<Artist>/<YYYY - Album>/<file>.
        let root = Path::new("/home/cmr-auto/Music");
        let path = "/home/cmr-auto/Music/Rap & Hip-Hop/Baco Exu do Blues/2018 - Bluesman/01 - Queima Minha Pele.flac";
        assert_eq!(
            folder_from_path(root, path).as_deref(),
            Some("Rap & Hip-Hop")
        );
    }

    #[test]
    fn folder_from_path_none_outside_music_root() {
        let root = Path::new("/home/cmr-auto/Music");
        let path = "/home/cmr-auto/Downloads/Rap & Hip-Hop/track.flac";
        assert_eq!(folder_from_path(root, path), None);
    }

    #[test]
    fn folder_from_path_none_when_file_directly_in_root() {
        // Sem pasta nenhuma acima do arquivo — não há playlist a reportar,
        // mesma regra de query::list_folders (exige >= 2 componentes).
        let root = Path::new("/home/cmr-auto/Music");
        let path = "/home/cmr-auto/Music/orphan.flac";
        assert_eq!(folder_from_path(root, path), None);
    }

    #[test]
    fn folder_for_artist_prefers_most_frequent_then_lexicographic_tiebreak() {
        let root = Path::new("/music");

        // 2 faixas em "Rap & Hip-Hop" vs 1 em "Old Rap" — a mais frequente
        // vence, não a primeira inserida.
        let mut idx = OwnedIndex::empty();
        idx.insert(OwnedVerdict {
            track_id: 1,
            title: "a".to_string(),
            artist: "X".to_string(),
            folder: folder_from_path(root, "/music/Old Rap/Album/00.flac"),
        });
        idx.insert(OwnedVerdict {
            track_id: 2,
            title: "b".to_string(),
            artist: "X".to_string(),
            folder: folder_from_path(root, "/music/Rap & Hip-Hop/Album/01.flac"),
        });
        idx.insert(OwnedVerdict {
            track_id: 3,
            title: "c".to_string(),
            artist: "X".to_string(),
            folder: folder_from_path(root, "/music/Rap & Hip-Hop/Album/02.flac"),
        });
        assert_eq!(idx.folder_for_artist("X"), Some("Rap & Hip-Hop"));

        // Empate 1x1 entre "B Folder" e "A Folder" — desempate determinístico
        // pela ordem lexicográfica, não pela ordem de inserção (inseri "B"
        // primeiro de propósito).
        let mut tie = OwnedIndex::empty();
        tie.insert(OwnedVerdict {
            track_id: 10,
            title: "a".to_string(),
            artist: "Y".to_string(),
            folder: folder_from_path(root, "/music/B Folder/Album/01.flac"),
        });
        tie.insert(OwnedVerdict {
            track_id: 11,
            title: "b".to_string(),
            artist: "Y".to_string(),
            folder: folder_from_path(root, "/music/A Folder/Album/02.flac"),
        });
        assert_eq!(tie.folder_for_artist("Y"), Some("A Folder"));
    }
}
