//! board.rs — estado dos jobs de download (fila do Crate).
//!
//! `JobBoard` é o único lugar onde `DownloadJob`s vivem em memória. Escritor
//! único (`upsert`/`transition` são `pub(crate)`, só o coordinator chama);
//! leitura livre via `snapshot()` (usada pelo evento `slsk-jobs` e pelo
//! comando `slsk_jobs`). Ver spec §3.4 (invariantes de concorrência) e §3.5
//! (`JobState` de 11 estados + `RejectReason`).

use std::collections::HashMap;
use std::sync::RwLock;

use serde::Serialize;

/// Candidato de download — espelho do `slskd_client::rank::Candidate`, mas
/// com `Serialize` (o crate A é PURO, sem serde — este tipo é o de fronteira
/// IPC/persistência). `bit_rate` é derivado (size/duração), não vem do wire
/// da API; `None` quando falta duração pra calcular.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Candidate {
    pub id: String,
    pub username: String,
    pub filename: String,
    pub directory: String,
    pub size: u64,
    pub bit_depth: Option<u16>,
    pub sample_rate: Option<u32>,
    pub bit_rate: Option<u32>,
    pub length_secs: Option<u32>,
    pub free_slot: bool,
    pub upload_speed: u64,
    pub queue_length: u32,
    pub score: i32,
    pub warn: Option<String>,
}

impl From<&slskd_client::rank::Candidate> for Candidate {
    fn from(c: &slskd_client::rank::Candidate) -> Self {
        let bit_rate = c.length_secs.filter(|&l| l > 0).map(|l| {
            ((c.size as f64 * 8.0) / (l as f64) / 1000.0).round() as u32
        });
        Candidate {
            id: c.id.clone(),
            username: c.username.clone(),
            filename: c.filename.clone(),
            directory: c.directory.clone(),
            size: c.size,
            bit_depth: c.bit_depth,
            sample_rate: c.sample_rate,
            bit_rate,
            length_secs: c.length_secs,
            free_slot: c.free_slot,
            upload_speed: c.upload_speed,
            queue_length: c.queue_length,
            score: c.score,
            warn: c.warn.clone(),
        }
    }
}

/// Motivo de rejeição pós-download — decisão, não erro (spec §3.5). Nunca
/// oferecer retry automático pra estes: `AlreadyOwned`/`Bit32Unsupported`
/// nunca vão passar numa segunda tentativa da MESMA fonte.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    AlreadyOwned { track_id: String },
    Bit32Unsupported,
    NotFlac,
    Corrupt,
}

/// Estado de um job — 11 variantes (spec §3.5). `tag = "kind"` no wire:
/// `{"kind":"downloading","pct":34.0,"bps":...}`. Terminais (sem transição
/// de saída, ver [`can_transition`]): `Ready`, `Rejected`, `Manual`,
/// `Failed`, `Canceled`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum JobState {
    Queued,
    Enqueued { queue_position: Option<u32> },
    Downloading { pct: f32, bps: u64, eta_s: Option<u32> },
    Stalled { since_secs: u64 },
    Processing,
    Indexing,
    Ready { track_id: String },
    Rejected { reason: RejectReason },
    Manual { path: String, why: String },
    Failed { reason: String, retryable: bool },
    Canceled,
}

fn tag(s: &JobState) -> &'static str {
    match s {
        JobState::Queued => "queued",
        JobState::Enqueued { .. } => "enqueued",
        JobState::Downloading { .. } => "downloading",
        JobState::Stalled { .. } => "stalled",
        JobState::Processing => "processing",
        JobState::Indexing => "indexing",
        JobState::Ready { .. } => "ready",
        JobState::Rejected { .. } => "rejected",
        JobState::Manual { .. } => "manual",
        JobState::Failed { .. } => "failed",
        JobState::Canceled => "canceled",
    }
}

const TERMINALS: &[&str] = &["ready", "rejected", "manual", "failed", "canceled"];

/// Matriz de transições legais. Terminal nunca sai (nem pra si mesmo —
/// `Canceled -> Canceled` também é ilegal). Não-terminal -> mesmo `tag` é
/// sempre legal (atualização de progresso: `Downloading{34%} ->
/// Downloading{40%}`). O resto é uma tabela explícita: `Queued..Enqueued
/// ..Downloading..Processing..Indexing..Ready` é o caminho feliz;
/// `Downloading<->Stalled` é o ciclo de stall/retomada;
/// `{Downloading,Enqueued,Stalled} -> Queued` é o retry automático de fonte
/// (spec §5.6 — a 1ª falha reenfileira em silêncio, só a 2ª vira `Failed`
/// visível, então `Failed` nunca é origem de transição nenhuma).
pub fn can_transition(from: &JobState, to: &JobState) -> bool {
    let (f, t) = (tag(from), tag(to));
    if TERMINALS.contains(&f) {
        return false;
    }
    if f == t {
        return true;
    }
    matches!(
        (f, t),
        ("queued", "enqueued")
            | ("queued", "downloading")
            | ("queued", "canceled")
            | ("queued", "failed")
            | ("enqueued", "downloading")
            | ("enqueued", "stalled")
            | ("enqueued", "canceled")
            | ("enqueued", "failed")
            | ("enqueued", "queued")
            | ("downloading", "stalled")
            | ("downloading", "processing")
            | ("downloading", "canceled")
            | ("downloading", "failed")
            | ("downloading", "queued")
            | ("stalled", "downloading")
            | ("stalled", "queued")
            | ("stalled", "canceled")
            | ("stalled", "failed")
            | ("processing", "indexing")
            | ("processing", "rejected")
            | ("processing", "canceled")
            | ("processing", "failed")
            | ("indexing", "ready")
            | ("indexing", "failed")
    )
}

/// `true` quando o job não recebe mais nenhuma transição (ver [`TERMINALS`]).
pub fn is_terminal(s: &JobState) -> bool {
    TERMINALS.contains(&tag(s))
}

/// Um download em curso (ou terminado) no Crate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DownloadJob {
    pub job_id: String,
    pub username: String,
    pub remote_filename: String,
    pub display: String,
    pub dest_playlist: String,
    pub state: JobState,
    pub alternates: Vec<Candidate>,
    pub tried_source_ids: Vec<String>,
    pub created_at: i64,
}

/// `DefaultHasher` hex sobre `"{username}\u{1}{remote_filename}"` — mesma
/// filosofia de `library_indexer::types::path_to_id` e
/// `slskd_client::rank`'s `candidate_id` (spec §3.4). Enfileirar o mesmo
/// arquivo do mesmo peer duas vezes é idempotente: mesmo `job_id`.
pub fn job_id(username: &str, remote_filename: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    format!("{username}\u{1}{remote_filename}").hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// Estado de todos os jobs. Escritor único (o coordinator, via `upsert`/
/// `transition`, ambos `pub(crate)`); leitura livre (`snapshot`, `pub`).
#[derive(Default)]
pub struct JobBoard {
    jobs: RwLock<HashMap<String, DownloadJob>>,
}

impl JobBoard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot ordenado por `created_at` — determinístico entre chamadas,
    /// não depende da ordem de iteração do `HashMap`. Usado pelo evento
    /// `slsk-jobs` (board inteiro, não diffs — spec §3.5) e por `slsk_jobs`.
    pub fn snapshot(&self) -> Vec<DownloadJob> {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        let mut v: Vec<DownloadJob> = guard.values().cloned().collect();
        v.sort_by_key(|j| j.created_at);
        v
    }

    pub(crate) fn upsert(&self, j: DownloadJob) {
        let mut guard = self.jobs.write().unwrap_or_else(|p| p.into_inner());
        guard.insert(j.job_id.clone(), j);
    }

    /// Aplica a transição SE for legal (ver [`can_transition`]). Devolve
    /// `false` sem mutar nada quando o job não existe ou a transição é
    /// ilegal — nunca panica, o coordinator decide o que fazer com `false`
    /// (tipicamente: log + ignora, o board não é fonte de verdade de erro).
    pub(crate) fn transition(&self, id: &str, s: JobState) -> bool {
        let mut guard = self.jobs.write().unwrap_or_else(|p| p.into_inner());
        match guard.get_mut(id) {
            Some(job) if can_transition(&job.state, &s) => {
                job.state = s;
                true
            }
            _ => false,
        }
    }

    pub(crate) fn get(&self, id: &str) -> Option<DownloadJob> {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        guard.get(id).cloned()
    }

    pub(crate) fn contains(&self, id: &str) -> bool {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        guard.contains_key(id)
    }

    /// Jobs em estado NÃO-terminal — usado pra gatear `MAX_ACTIVE_TRANSFERS`
    /// e pra montar `alive_job_ids` da limpeza de `.rustify-incoming` no
    /// boot.
    pub(crate) fn active_ids(&self) -> Vec<String> {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        guard
            .values()
            .filter(|j| !is_terminal(&j.state))
            .map(|j| j.job_id.clone())
            .collect()
    }

    pub(crate) fn active_count(&self) -> usize {
        let guard = self.jobs.read().unwrap_or_else(|p| p.into_inner());
        guard.values().filter(|j| !is_terminal(&j.state)).count()
    }

    /// Mantém só os `cap` terminais mais recentes (FIFO por `created_at`) —
    /// `JOBS_RETAINED` (spec §6.4): o board não cresce sem limite numa
    /// sessão longa. Jobs ativos nunca são removidos aqui.
    pub(crate) fn retain_recent_terminals(&self, cap: usize) {
        let mut guard = self.jobs.write().unwrap_or_else(|p| p.into_inner());
        let mut terminal_ids: Vec<(String, i64)> = guard
            .values()
            .filter(|j| is_terminal(&j.state))
            .map(|j| (j.job_id.clone(), j.created_at))
            .collect();
        if terminal_ids.len() <= cap {
            return;
        }
        terminal_ids.sort_by_key(|(_, created_at)| *created_at);
        let to_remove = terminal_ids.len() - cap;
        for (id, _) in terminal_ids.into_iter().take(to_remove) {
            guard.remove(&id);
        }
    }

    /// Remove todos os jobs terminais, devolvendo quantos saíram —
    /// implementa `slsk_clear_finished`.
    pub(crate) fn clear_finished(&self) -> u32 {
        let mut guard = self.jobs.write().unwrap_or_else(|p| p.into_inner());
        let before = guard.len();
        guard.retain(|_, j| !is_terminal(&j.state));
        (before - guard.len()) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, state: JobState) -> DownloadJob {
        DownloadJob {
            job_id: id.to_string(),
            username: "peer".to_string(),
            remote_filename: "Artist - Title.flac".to_string(),
            display: "Artist - Title".to_string(),
            dest_playlist: "Rap & Hip-Hop".to_string(),
            state,
            alternates: Vec::new(),
            tried_source_ids: Vec::new(),
            created_at: 0,
        }
    }

    #[test]
    fn job_id_is_deterministic() {
        let a = job_id("peer_a", "Artist - Title.flac");
        let b = job_id("peer_a", "Artist - Title.flac");
        assert_eq!(a, b);

        let different_user = job_id("peer_b", "Artist - Title.flac");
        assert_ne!(a, different_user);

        let different_file = job_id("peer_a", "Other - Track.flac");
        assert_ne!(a, different_file);
    }

    #[test]
    fn can_transition_matrix() {
        // Legais: caminho feliz completo.
        assert!(can_transition(&JobState::Queued, &JobState::Enqueued { queue_position: None }));
        assert!(can_transition(
            &JobState::Enqueued { queue_position: Some(3) },
            &JobState::Downloading { pct: 0.0, bps: 0, eta_s: None }
        ));
        assert!(can_transition(
            &JobState::Downloading { pct: 50.0, bps: 100, eta_s: None },
            &JobState::Processing
        ));
        assert!(can_transition(&JobState::Processing, &JobState::Indexing));
        assert!(can_transition(
            &JobState::Indexing,
            &JobState::Ready { track_id: "42".to_string() }
        ));

        // Downloading <-> Stalled (ciclo de stall/retomada).
        assert!(can_transition(
            &JobState::Downloading { pct: 10.0, bps: 0, eta_s: None },
            &JobState::Stalled { since_secs: 120 }
        ));
        assert!(can_transition(
            &JobState::Stalled { since_secs: 120 },
            &JobState::Downloading { pct: 10.0, bps: 500, eta_s: None }
        ));

        // Ilegais.
        assert!(!can_transition(
            &JobState::Ready { track_id: "1".to_string() },
            &JobState::Downloading { pct: 0.0, bps: 0, eta_s: None }
        ));
        assert!(!can_transition(&JobState::Canceled, &JobState::Canceled));
        assert!(!can_transition(&JobState::Canceled, &JobState::Queued));
        assert!(!can_transition(
            &JobState::Canceled,
            &JobState::Ready { track_id: "1".to_string() }
        ));
        assert!(!can_transition(
            &JobState::Failed { reason: "x".to_string(), retryable: false },
            &JobState::Queued
        ));
    }

    #[test]
    fn transition_applies_legal_ignores_illegal() {
        let board = JobBoard::new();
        board.upsert(job("j1", JobState::Queued));

        assert!(board.transition("j1", JobState::Enqueued { queue_position: Some(1) }));
        assert_eq!(board.get("j1").unwrap().state, JobState::Enqueued { queue_position: Some(1) });

        // Ready é ilegal a partir de Enqueued diretamente — nada muda.
        let illegal = board.transition("j1", JobState::Ready { track_id: "9".to_string() });
        assert!(!illegal);
        assert_eq!(board.get("j1").unwrap().state, JobState::Enqueued { queue_position: Some(1) });

        // Job inexistente: false, sem panic.
        assert!(!board.transition("ghost", JobState::Canceled));
    }

    #[test]
    fn snapshot_sorted_by_created_at() {
        let board = JobBoard::new();
        let mut j2 = job("j2", JobState::Queued);
        j2.created_at = 200;
        let mut j1 = job("j1", JobState::Queued);
        j1.created_at = 100;
        board.upsert(j2);
        board.upsert(j1);

        let snap = board.snapshot();
        assert_eq!(snap[0].job_id, "j1");
        assert_eq!(snap[1].job_id, "j2");
    }

    #[test]
    fn active_count_ignores_terminals() {
        let board = JobBoard::new();
        board.upsert(job("active", JobState::Downloading { pct: 1.0, bps: 1, eta_s: None }));
        board.upsert(job("done", JobState::Ready { track_id: "1".to_string() }));
        board.upsert(job("canceled", JobState::Canceled));

        assert_eq!(board.active_count(), 1);
        assert_eq!(board.active_ids(), vec!["active".to_string()]);
    }

    #[test]
    fn retain_recent_terminals_trims_oldest_fifo() {
        let board = JobBoard::new();
        for i in 0..5u32 {
            let mut j = job(&format!("t{i}"), JobState::Canceled);
            j.created_at = i as i64;
            board.upsert(j);
        }
        board.retain_recent_terminals(3);
        let mut remaining: Vec<String> = board.snapshot().into_iter().map(|j| j.job_id).collect();
        remaining.sort();
        assert_eq!(remaining, vec!["t2".to_string(), "t3".to_string(), "t4".to_string()]);
    }

    #[test]
    fn clear_finished_removes_only_terminals() {
        let board = JobBoard::new();
        board.upsert(job("active", JobState::Downloading { pct: 1.0, bps: 1, eta_s: None }));
        board.upsert(job("done", JobState::Ready { track_id: "1".to_string() }));
        let removed = board.clear_finished();
        assert_eq!(removed, 1);
        assert_eq!(board.snapshot().len(), 1);
        assert_eq!(board.snapshot()[0].job_id, "active");
    }
}
