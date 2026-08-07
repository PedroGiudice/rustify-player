//! rank.rs — agregação de resultados de busca por faixa e score lexicográfico.
//!
//! PURO: nenhuma dependência de rede, Tauri ou Qdrant. `norm`/`artist_main`
//! são definidos aqui (porta do Python `stage_downloads.py`) até a Etapa B
//! criar `library-indexer/src/dedup.rs` com a mesma lógica — o teste de
//! paridade entre os dois é responsabilidade da Etapa C, não desta.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use crate::wire::{ApiFile, ApiSearchResponse};

// ── Filtros duros (spec §4.4) ──────────────────────────────────────────
const MIN_FILE_SIZE_BYTES: u64 = 2_000_000;
const MAX_FILE_SIZE_BYTES: u64 = 300_000_000;

// ── Pesos do score lexicográfico (spec §4.4, consts nomeadas) ─────────
const SCORE_BIT32_PENALTY: i32 = -10_000;
const SCORE_LIVE_PENALTY: i32 = -5_000;
const SCORE_FREE_SLOT_BONUS: i32 = 3_000;
const SCORE_QUEUE_PENALTY_PER_UNIT: i32 = -20;
const QUEUE_LENGTH_CAP: u32 = 50;
const SCORE_HI_RES_BONUS: i32 = 400;
const HI_RES_MIN_BIT_DEPTH: u16 = 24;
const HI_RES_MIN_SAMPLE_RATE: u32 = 88_200;
const SCORE_BITRATE_COHERENCE_BONUS: i32 = 200;
const BITRATE_COHERENT_MIN_KBPS: f64 = 700.0;
const BITRATE_COHERENT_MAX_KBPS: f64 = 1_500.0;
const UPLOAD_SPEED_UNIT_BYTES: u64 = 50_000; // 50 KB/s
const SCORE_UPLOAD_SPEED_PER_UNIT: i32 = 1;
const SCORE_UPLOAD_SPEED_CAP: i32 = 600;
const SCORE_SIMILARITY_MAX: f64 = 300.0;

const DERANK_KEYWORDS: [&str; 6] = [
    "live",
    "remix",
    "extended",
    "instrumental",
    "nightcore",
    "sped up", // cobre "spedup" via segunda checagem em matches_derank_keyword
];
const DURATION_OUTLIER_TOLERANCE: f64 = 0.15;

#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: String,
    pub username: String,
    pub filename: String,
    pub directory: String,
    pub size: u64,
    pub bit_depth: Option<u16>,
    pub sample_rate: Option<u32>,
    pub length_secs: Option<u32>,
    pub free_slot: bool,
    pub upload_speed: u64,
    pub queue_length: u32,
    pub score: i32,
    pub warn: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResultGroup {
    pub group_key: String,
    pub display_title: String,
    pub display_artist: Option<String>,
    pub album_hint: Option<String>,
    pub duration_secs: Option<u32>,
    pub quality_label: String,
    pub best: Candidate,
    pub alternates: Vec<Candidate>,
}

#[derive(Debug, Clone, Default)]
pub struct RankedResults {
    pub groups: Vec<ResultGroup>,
}

// ── norm / artist_main — porta local do stage_downloads.py ────────────
//
// A Etapa B cria library-indexer/src/dedup.rs com a MESMA lógica (norm,
// artist_main, OwnedIndex). O teste de paridade entre as duas cópias é
// responsabilidade da Etapa C — aqui só garantimos que a chave de
// agrupamento é estável e consistente internamente.

const FEAT_WORDS: [&str; 5] = ["feat", "ft", "featuring", "with", "prod"];

/// Lowercase, remove `(..)`/`[..]`, corta a partir de feat|ft|featuring|with|prod,
/// mantém só alfanumérico+espaço, colapsa espaços. Porta de `stage_downloads.py::norm`.
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
/// `stage_downloads.py::artist_main` (com `;` adicional ao conjunto de
/// separadores, conforme brief da Etapa A).
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

// ── guess_artist_title / remote_basename / remote_parent_dir ──────────
//
// Adendo do spike (2026-08-07): filename remoto usa BACKSLASH. Todo parse
// de basename/diretório divide por `\` E `/`.

pub fn remote_basename(remote_filename: &str) -> &str {
    remote_filename
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(remote_filename)
}

/// Última componente de diretório do path remoto — regra de localização
/// local confirmada no spike (§Adendo item 4): pasta local = última-pasta
/// remota + basename.
pub fn remote_parent_dir(remote_filename: &str) -> &str {
    let trimmed = remote_filename.trim_end_matches(['\\', '/']);
    let without_basename = match trimmed.rfind(['\\', '/']) {
        Some(idx) => &trimmed[..idx],
        None => return "",
    };
    without_basename.rsplit(['\\', '/']).next().unwrap_or("")
}

/// Diretório remoto completo (tudo antes do basename) — usado em
/// `Candidate.directory`, que habilita "baixar álbum" na fase 2.
fn remote_dir_full(remote_filename: &str) -> String {
    match remote_filename.rfind(['\\', '/']) {
        Some(idx) => remote_filename[..idx].to_string(),
        None => String::new(),
    }
}

fn strip_extension(basename: &str) -> &str {
    basename
        .rsplit_once('.')
        .map(|(stem, _ext)| stem)
        .unwrap_or(basename)
}

/// Remove um prefixo de faixa tipo "01 - " / "01. " do início do trecho.
/// Sem prefixo numérico reconhecível, devolve a entrada intacta.
fn strip_track_number(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 || i > 3 {
        return s;
    }
    let rest = s[i..].trim_start();
    let rest = rest.strip_prefix('-').or_else(|| rest.strip_prefix('.'));
    match rest {
        Some(r) => r.trim_start(),
        None => s,
    }
}

/// Extrai `(artist, title)` do nome do arquivo remoto — variantes
/// `NN - Artist - Title.ext` e `Artist - Title.ext`. Sem separador
/// reconhecível (ex.: `Anita.flac`), devolve `None`.
pub fn guess_artist_title(remote_filename: &str) -> Option<(String, String)> {
    let basename = remote_basename(remote_filename);
    let stem = strip_extension(basename);
    let without_track_no = strip_track_number(stem);
    let parts: Vec<&str> = without_track_no.splitn(2, " - ").collect();
    if parts.len() == 2 && !parts[0].trim().is_empty() && !parts[1].trim().is_empty() {
        Some((parts[0].trim().to_string(), parts[1].trim().to_string()))
    } else {
        None
    }
}

/// Título de fallback quando `guess_artist_title` não consegue separar
/// artista — usa o basename inteiro (sem extensão, sem número de faixa).
fn fallback_title(remote_filename: &str) -> String {
    let basename = remote_basename(remote_filename);
    let stem = strip_extension(basename);
    strip_track_number(stem).trim().to_string()
}

// ── agregação e score ───────────────────────────────────────────────

struct RawCandidate {
    candidate: Candidate,
    display_artist: Option<String>,
    display_title: String,
}

fn duration_bucket(secs: Option<u32>) -> String {
    match secs {
        Some(s) => (s / 5).to_string(),
        None => "?".to_string(),
    }
}

/// `group_key = norm(artist) + \u{1} + norm(title)` + bucket de duração
/// de 5s (spec §4.4). Mesma chave que `OwnedIndex` vai indexar na Etapa B
/// — se divergirem, o dedup falha em silêncio.
fn make_group_key(artist: &str, title: &str, duration_secs: Option<u32>) -> String {
    format!(
        "{}\u{1}{}\u{1}{}",
        norm(artist),
        norm(title),
        duration_bucket(duration_secs)
    )
}

/// `hash(username + filename)` — mesma filosofia de `JobId` (spec §3.4).
fn candidate_id(username: &str, filename: &str) -> String {
    let mut hasher = DefaultHasher::new();
    format!("{username}\u{1}{filename}").hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn matches_derank_keyword(filename_lower: &str) -> Option<&'static str> {
    if filename_lower.contains("spedup") {
        return Some("sped up");
    }
    DERANK_KEYWORDS
        .iter()
        .copied()
        .find(|kw| filename_lower.contains(kw))
}

fn score_candidate(
    response: &ApiSearchResponse,
    file: &ApiFile,
    title: &str,
    query_lower: &str,
) -> (i32, Option<String>) {
    let mut score: i32 = 0;
    let mut warn: Option<String> = None;

    if file.bit_depth == Some(32) {
        score += SCORE_BIT32_PENALTY;
        warn = Some("32-bit".to_string());
    }

    let filename_lower = file.filename.to_lowercase();
    if let Some(kw) = matches_derank_keyword(&filename_lower) {
        if !query_lower.contains(kw) {
            score += SCORE_LIVE_PENALTY;
            if warn.is_none() {
                warn = Some("parece live".to_string());
            }
        }
    }

    if response.has_free_upload_slot {
        score += SCORE_FREE_SLOT_BONUS;
    }
    let queue_capped = response.queue_length.min(QUEUE_LENGTH_CAP) as i32;
    score += SCORE_QUEUE_PENALTY_PER_UNIT * queue_capped;

    if let (Some(bd), Some(sr)) = (file.bit_depth, file.sample_rate) {
        if bd >= HI_RES_MIN_BIT_DEPTH && sr >= HI_RES_MIN_SAMPLE_RATE {
            score += SCORE_HI_RES_BONUS;
        }
    }

    if let Some(len) = file.length {
        if len > 0 {
            let kbps = (file.size as f64 * 8.0) / (len as f64) / 1000.0;
            if (BITRATE_COHERENT_MIN_KBPS..=BITRATE_COHERENT_MAX_KBPS).contains(&kbps) {
                score += SCORE_BITRATE_COHERENCE_BONUS;
            }
        }
    }

    let speed_units = (response.upload_speed / UPLOAD_SPEED_UNIT_BYTES) as i32;
    score += (speed_units * SCORE_UPLOAD_SPEED_PER_UNIT).min(SCORE_UPLOAD_SPEED_CAP);

    let sim = strsim::normalized_levenshtein(&title.to_lowercase(), query_lower);
    score += (sim * SCORE_SIMILARITY_MAX).round() as i32;

    (score, warn)
}

fn median(values: &[u32]) -> Option<u32> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    Some(sorted[sorted.len() / 2])
}

/// Fontes fora de ±15% da mediana de duração do grupo ganham
/// `warn: "duração destoa"` — sinal barato de live/extended (spec §4.4.4).
/// Não sobrescreve um warn mais severo (32-bit, live) já setado.
fn apply_duration_outlier_warns(raws: &mut [RawCandidate]) {
    let durations: Vec<u32> = raws
        .iter()
        .filter_map(|r| r.candidate.length_secs)
        .collect();
    let Some(med) = median(&durations) else {
        return;
    };
    let med_f = med.max(1) as f64;
    for r in raws.iter_mut() {
        if let Some(len) = r.candidate.length_secs {
            let diff = (len as f64 - med_f).abs() / med_f;
            if diff > DURATION_OUTLIER_TOLERANCE && r.candidate.warn.is_none() {
                r.candidate.warn = Some("duração destoa".to_string());
            }
        }
    }
}

fn quality_label_for(candidate: &Candidate) -> String {
    let bit = candidate
        .bit_depth
        .map(|b| b.to_string())
        .unwrap_or_else(|| "?".to_string());
    let khz = candidate
        .sample_rate
        .map(|s| (s / 1000).to_string())
        .unwrap_or_else(|| "?".to_string());
    format!("FLAC {bit}/{khz}")
}

/// Agrega respostas de busca por faixa: aplica filtros duros (só FLAC,
/// tamanho 2MB-300MB), agrupa por `(artist, title, duration_bucket)`
/// normalizados, pontua cada candidato e ordena por score desc dentro do
/// grupo. Devolve os grupos na ordem de primeiro-visto entre as respostas.
pub fn aggregate(responses: &[ApiSearchResponse], query: &str) -> RankedResults {
    let query_lower = query.to_lowercase();
    let mut order: Vec<String> = Vec::new();
    let mut buckets: HashMap<String, Vec<RawCandidate>> = HashMap::new();

    for response in responses {
        for file in &response.files {
            if !file.extension.eq_ignore_ascii_case("flac") {
                continue;
            }
            if file.size < MIN_FILE_SIZE_BYTES || file.size > MAX_FILE_SIZE_BYTES {
                continue;
            }

            let (artist, title) = match guess_artist_title(&file.filename) {
                Some((a, t)) => (Some(a), t),
                None => (None, fallback_title(&file.filename)),
            };

            let key = make_group_key(artist.as_deref().unwrap_or(""), &title, file.length);
            let (score, warn) = score_candidate(response, file, &title, &query_lower);

            let candidate = Candidate {
                id: candidate_id(&response.username, &file.filename),
                username: response.username.clone(),
                filename: file.filename.clone(),
                directory: remote_dir_full(&file.filename),
                size: file.size,
                bit_depth: file.bit_depth,
                sample_rate: file.sample_rate,
                length_secs: file.length,
                free_slot: response.has_free_upload_slot,
                upload_speed: response.upload_speed,
                queue_length: response.queue_length,
                score,
                warn,
            };

            if !buckets.contains_key(&key) {
                order.push(key.clone());
            }
            buckets.entry(key).or_default().push(RawCandidate {
                candidate,
                display_artist: artist,
                display_title: title,
            });
        }
    }

    let mut groups = Vec::with_capacity(order.len());
    for key in order {
        let mut raws = buckets.remove(&key).unwrap_or_default();
        apply_duration_outlier_warns(&mut raws);
        raws.sort_by(|a, b| b.candidate.score.cmp(&a.candidate.score));

        let durations: Vec<u32> = raws
            .iter()
            .filter_map(|r| r.candidate.length_secs)
            .collect();
        let duration_secs = median(&durations);

        let (display_artist, display_title) = raws
            .first()
            .map(|r| (r.display_artist.clone(), r.display_title.clone()))
            .unwrap_or((None, String::new()));

        let mut candidates: Vec<Candidate> = raws.into_iter().map(|r| r.candidate).collect();
        let best = candidates.remove(0);
        let quality_label = quality_label_for(&best);

        groups.push(ResultGroup {
            group_key: key,
            display_title,
            display_artist,
            album_hint: None,
            duration_secs,
            quality_label,
            best,
            alternates: candidates,
        });
    }

    RankedResults { groups }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{ApiFile, ApiSearchResponse};

    fn file(filename: &str, size: u64) -> ApiFile {
        ApiFile {
            filename: filename.to_string(),
            size,
            extension: "flac".to_string(),
            bit_depth: Some(16),
            sample_rate: Some(44_100),
            length: Some(200),
            is_locked: false,
        }
    }

    fn response(username: &str, files: Vec<ApiFile>) -> ApiSearchResponse {
        ApiSearchResponse {
            username: username.to_string(),
            file_count: files.len() as u32,
            files,
            has_free_upload_slot: false,
            locked_file_count: 0,
            queue_length: 0,
            upload_speed: 0,
        }
    }

    #[test]
    fn aggregate_collapses_same_track_across_peers() {
        let responses = vec![
            response("peer_a", vec![file("01 - Smino - Anita.flac", 30_000_000)]),
            response("peer_b", vec![file("Smino - Anita.flac", 30_500_000)]),
        ];
        let ranked = aggregate(&responses, "anita smino");
        assert_eq!(ranked.groups.len(), 1);
        assert_eq!(ranked.groups[0].alternates.len(), 1);
    }

    #[test]
    fn aggregate_drops_non_flac() {
        let mut mp3 = file("01 - Smino - Anita.mp3", 8_000_000);
        mp3.extension = "mp3".to_string();
        let responses = vec![response("peer_a", vec![mp3])];
        let ranked = aggregate(&responses, "anita");
        assert!(ranked.groups.is_empty());
    }

    #[test]
    fn score_prefers_free_slot_over_hi_res() {
        let mut hi_res = file("Artist - Title.flac", 60_000_000);
        hi_res.bit_depth = Some(24);
        hi_res.sample_rate = Some(96_000);
        let free = file("Artist - Title.flac", 30_000_000);

        let mut hi_res_peer = response("hi_res_peer", vec![hi_res]);
        hi_res_peer.has_free_upload_slot = false;
        let mut free_peer = response("free_peer", vec![free]);
        free_peer.has_free_upload_slot = true;

        let ranked = aggregate(&[hi_res_peer, free_peer], "title");
        assert_eq!(ranked.groups.len(), 1);
        assert_eq!(ranked.groups[0].best.username, "free_peer");
    }

    #[test]
    fn score_never_elects_32bit_as_best() {
        let mut bit32 = file("Artist - Title.flac", 80_000_000);
        bit32.bit_depth = Some(32);
        let normal = file("Artist - Title.flac", 30_000_000);

        let responses = vec![
            response("peer_32", vec![bit32]),
            response("peer_16", vec![normal]),
        ];
        let ranked = aggregate(&responses, "title");
        assert_eq!(ranked.groups.len(), 1);
        assert_eq!(ranked.groups[0].best.username, "peer_16");
        let alt = &ranked.groups[0].alternates[0];
        assert_eq!(alt.username, "peer_32");
        assert_eq!(alt.warn.as_deref(), Some("32-bit"));
    }

    #[test]
    fn score_deranks_live_unless_query_asks_for_live() {
        let live = file("Artist - Title (Live).flac", 30_000_000);
        let studio = file("Artist - Title.flac", 30_000_000);
        let responses = vec![
            response("peer_live", vec![live]),
            response("peer_studio", vec![studio]),
        ];

        let without_live_term = aggregate(&responses, "artist title");
        let group = &without_live_term.groups[0];
        let live_candidate = std::iter::once(&group.best)
            .chain(group.alternates.iter())
            .find(|c| c.username == "peer_live")
            .expect("peer_live should be in the group");
        assert_eq!(live_candidate.warn.as_deref(), Some("parece live"));
        assert_eq!(group.best.username, "peer_studio");

        let with_live_term = aggregate(&responses, "artist title live");
        let group2 = &with_live_term.groups[0];
        let live_candidate2 = std::iter::once(&group2.best)
            .chain(group2.alternates.iter())
            .find(|c| c.username == "peer_live")
            .expect("peer_live should be in the group");
        assert_ne!(live_candidate2.warn.as_deref(), Some("parece live"));
    }

    #[test]
    fn filters_reject_by_absolute_size_not_bytes_per_second() {
        let mut hi_bitrate = file("Artist - Title.flac", 80_000_000);
        hi_bitrate.bit_depth = Some(24);
        hi_bitrate.sample_rate = Some(192_000);
        hi_bitrate.length = Some(200);
        let ranked = aggregate(&[response("peer_hi", vec![hi_bitrate])], "title");
        assert_eq!(ranked.groups.len(), 1);
        assert_eq!(ranked.groups[0].best.username, "peer_hi");

        let too_big = file("Artist - Title.flac", 400_000_000);
        let ranked2 = aggregate(&[response("peer_big", vec![too_big])], "title");
        assert!(ranked2.groups.is_empty());
    }

    #[test]
    fn guess_artist_title_variants() {
        assert_eq!(
            guess_artist_title("01 - Smino - Anita.flac"),
            Some(("Smino".to_string(), "Anita".to_string()))
        );
        assert_eq!(guess_artist_title("Anita.flac"), None);
        assert_eq!(
            guess_artist_title(
                "VARIETY\\Robert Miles\\EP\\(1995) Soundtracks\\01 - Robert Miles - Children.flac"
            ),
            Some(("Robert Miles".to_string(), "Children".to_string()))
        );
    }

    #[test]
    fn remote_parent_dir_handles_backslash() {
        let path = "VARIETY\\Robert Miles\\EP\\(1995) Soundtracks\\01 - Children.flac";
        assert_eq!(remote_parent_dir(path), "(1995) Soundtracks");
        assert_eq!(remote_basename(path), "01 - Children.flac");
    }
}
