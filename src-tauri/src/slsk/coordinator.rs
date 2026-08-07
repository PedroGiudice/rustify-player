//! coordinator.rs — thread única (`slsk-coord`): busca, transfers, staging,
//! reconciliação (spec §3.4, §5.6, §6). Escritor único do `JobBoard` e do
//! `SearchStore` — nenhum outro lugar do app muta esses dois.
//!
//! Testabilidade: a lógica de decisão vive em métodos de [`Coordinator`]
//! que recebem `now: Instant` explícito (mesmo padrão de `pacing.rs`) — os
//! testes chamam esses métodos direto, sem thread real nem `sleep`.
//! `spawn_coordinator` é a casca fina que roda isso de verdade num loop
//! com timeouts computados.
//!
//! **Nada bloqueia I/O de rede antes de responder um `SlskTask` com
//! `reply`** (fix round 1 do review, CR-1): `handle_search`,
//! `handle_task_download` e `handle_try_other_source` respondem ao `reply`
//! ANTES de qualquer `ensure_swept`/`start_search`/`enqueue`. `locate` pós-
//! download deixou de bloquear em `thread::sleep` — virou uma máquina
//! tick-driven (`locating`/`begin_locate`/`continue_locate`) que reusa o
//! poll normal de 1s/5s.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use crossbeam_channel::{Receiver, Sender};
use library_indexer::{IndexerHandle, IngestOutcome, OwnedIndex};
use serde::{Deserialize, Serialize};
use slskd_client::pacing::{PaceDecision, Pacer};
use slskd_client::wire::ApiTransferUser;
use slskd_client::{SearchGuard, SlskdApi};
use tauri::{AppHandle, Emitter};

use super::board::{can_transition, Candidate, DownloadJob, JobBoard, JobState};
use super::config::SlskConfig;
use super::stage;

// ── Constantes (spec §3.4 + §6) ────────────────────────────────────────
const SEARCH_WINDOW: Duration = Duration::from_secs(25);
const SEARCH_POLL: Duration = Duration::from_millis(700);
const POLL_ACTIVE: Duration = Duration::from_millis(1_000);
const POLL_IDLE: Duration = Duration::from_secs(5);
const STALL_BYTES_SECS: u64 = 120;
const STALL_ENQUEUED_SECS: u64 = 300;
const MAX_ACTIVE_TRANSFERS: usize = 3;
const JOBS_RETAINED: usize = 50;
const SWEEP_MAX_KEEP: usize = 50;
const SWEEP_MAX_AGE_SECS: i64 = 60 * 60;
const EMIT_THROTTLE: Duration = Duration::from_millis(500);
const OWNED_INDEX_TTL: Duration = Duration::from_secs(60);
const LOCATE_RETRY_WINDOW: Duration = Duration::from_secs(30);
const TERMINAL_PRUNE_AGE_SECS: i64 = 7 * 24 * 60 * 60;
const MISSING_TRANSFER_TIMEOUT_SECS: u64 = 120;
const INGEST_MAX_RETRIES: u8 = 5;
const INGEST_RETRY_INTERVAL: Duration = Duration::from_secs(30);
const JOBS_FILE_NAME: &str = "slsk_jobs.json";

// ── Tarefas que o app manda pro coordinator ────────────────────────────

pub enum SlskTask {
    Search {
        query: String,
        force: bool,
        reply: Sender<Result<String, String>>,
    },
    Download {
        search_id: String,
        group_key: String,
        source_id: String,
        dest: String,
        reply: Sender<Result<String, String>>,
    },
    TryOtherSource {
        job_id: String,
        reply: Sender<Result<String, String>>,
    },
    CancelSearch {
        search_id: String,
    },
    CancelJob {
        job_id: String,
    },
    ClearFinished {
        reply: Sender<u32>,
    },
}

// ── Wire de busca (IPC) ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SearchState {
    Running,
    Done,
    Empty,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct OwnedVerdictWire {
    pub track_id: String,
    pub title: String,
    pub artist: String,
}

impl From<&library_indexer::OwnedVerdict> for OwnedVerdictWire {
    fn from(v: &library_indexer::OwnedVerdict) -> Self {
        Self {
            track_id: v.track_id.to_string(),
            title: v.title.clone(),
            artist: v.artist.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ResultGroup {
    pub group_key: String,
    pub display_title: String,
    pub display_artist: Option<String>,
    pub album_hint: Option<String>,
    pub duration_secs: Option<u32>,
    pub quality_label: String,
    pub owned: Option<OwnedVerdictWire>,
    pub suggested_dest: Option<String>,
    pub best: Candidate,
    pub alternates: Vec<Candidate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SearchSnapshot {
    pub state: SearchState,
    pub elapsed_ms: u64,
    pub responses_seen: u32,
    pub groups: Vec<ResultGroup>,
    pub note: Option<String>,
}

impl Default for SearchSnapshot {
    fn default() -> Self {
        SearchSnapshot {
            state: SearchState::Running,
            elapsed_ms: 0,
            responses_seen: 0,
            groups: Vec::new(),
            note: None,
        }
    }
}

/// Dados brutos de UM grupo de resultado guardados no `SearchStore` — o que
/// `slsk_download` precisa pra reconstruir `username`/`filename`/`size` a
/// partir de `group_key` + `source_id`, sem confiar em nada vindo do
/// webview (spec M5).
struct RawGroup {
    best: slskd_client::rank::Candidate,
    alternates: Vec<slskd_client::rank::Candidate>,
}

struct StoredSearch {
    remote_id: Option<String>,
    /// Texto digitado pelo usuário — usado por `rank::aggregate` pro derank
    /// de live/remix e pra similaridade título×query (review IM-4: antes
    /// isto NUNCA era guardado, `poll_active_search_once` sempre agregava
    /// com `""`, zerando esses dois sinais de score).
    query: String,
    snapshot: SearchSnapshot,
    raw_groups: HashMap<String, RawGroup>,
}

/// `search_id -> StoredSearch`. Escritor único: o coordinator.
#[derive(Default)]
pub struct SearchStore {
    entries: HashMap<String, StoredSearch>,
}

impl SearchStore {
    pub fn snapshot(&self, search_id: &str) -> Option<SearchSnapshot> {
        self.entries.get(search_id).map(|s| s.snapshot.clone())
    }
}

/// Busca em voo — o que o loop principal usa pra saber se ainda deve
/// pollar (`SEARCH_WINDOW`/`SEARCH_POLL`).
struct ActiveSearch {
    local_id: String,
    remote_id: String,
    started_at: Instant,
    next_poll_at: Instant,
}

/// Persistido em `slsk_jobs.json` — só o que o slskd NÃO sabe (spec §3.6).
/// Terminais NÃO entram aqui (review IM-1: um `Ready`/`Failed`/`Rejected`
/// persistido "ressuscitava" como `Manual` no boot seguinte, porque
/// `reconcile_boot` não consegue distinguir "terminou bem" de "morreu
/// junto com o app" só olhando o slskd).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedJob {
    job_id: String,
    username: String,
    remote_filename: String,
    dest_playlist: String,
    #[serde(default)]
    alternates: Vec<Candidate>,
    created_at: i64,
}

/// Classificação por substring dos estados reais de `/transfers/downloads`
/// (spec, adendo do spike: `"<fase>, <detalhe>"`, ex. `"Completed,
/// Succeeded"`, `"Queued, Remotely"`). Fallback conservador: qualquer coisa
/// não reconhecida é tratada como "ainda em curso" (nunca falha por engano
/// um transfer real só porque o slskd mudou uma string numa atualização).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransferOutcome {
    Queued,
    InProgress,
    Succeeded,
    Errored,
    TimedOut,
    Aborted,
    Canceled,
}

fn classify_transfer_state(state: &str) -> TransferOutcome {
    if state.contains("Succeeded") {
        TransferOutcome::Succeeded
    } else if state.contains("TimedOut") {
        TransferOutcome::TimedOut
    } else if state.contains("Errored") {
        TransferOutcome::Errored
    } else if state.contains("Cancelled") || state.contains("Canceled") {
        TransferOutcome::Canceled
    } else if state.contains("Aborted") {
        TransferOutcome::Aborted
    } else if state.contains("Queued") {
        TransferOutcome::Queued
    } else {
        TransferOutcome::InProgress
    }
}

fn find_transfer<'a>(
    downloads: &'a [ApiTransferUser],
    username: &str,
    remote_filename: &str,
) -> Option<&'a slskd_client::wire::ApiTransferFile> {
    downloads
        .iter()
        .find(|u| u.username == username)?
        .directories
        .iter()
        .flat_map(|d| &d.files)
        .find(|f| f.filename == remote_filename)
}

/// Parser mínimo de timestamp ISO8601 UTC (`YYYY-MM-DDTHH:MM:SS[.fff]Z`) —
/// o único formato que a API do slskd emite em `startedAt`/`endedAt`
/// (confirmado contra a instância real, review IM-9). Sem `chrono`/`time`
/// como dependência nova só pra isto. `None` em qualquer formato
/// inesperado — nunca panica.
fn parse_iso8601_utc(s: &str) -> Option<i64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    let time_main = time.split('.').next().unwrap_or(time);
    let mut time_parts = time_main.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let min: i64 = time_parts.next()?.parse().ok()?;
    let sec: i64 = time_parts.next()?.parse().ok()?;
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + min * 60 + sec)
}

/// Howard Hinnant's `days_from_civil` — inverso do `civil_from_days` de
/// `stage.rs` (aquele é dias->data, este é data->dias; cada arquivo usa só
/// a direção que precisa, duplicar ~10 linhas é mais simples que acoplar
/// os dois módulos por uma função utilitária).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn is_valid_playlist_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\')
}

fn job_created_at_as_systemtime(created_at: i64) -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(created_at.max(0) as u64)
}

/// Estado do coordinator. `new()` é privado — só `spawn_coordinator`
/// (produção) e os testes deste módulo constroem um.
pub struct Coordinator {
    cfg: Arc<SlskConfig>,
    api: Arc<dyn SlskdApi>,
    board: Arc<JobBoard>,
    searches: Arc<RwLock<SearchStore>>,
    ingest: Box<dyn Fn(Vec<PathBuf>) -> Vec<IngestOutcome> + Send + Sync>,
    owned_index_provider: Box<dyn Fn() -> Result<OwnedIndex, String> + Send + Sync>,
    pacer: Mutex<Pacer>,
    active_search: Mutex<Option<ActiveSearch>>,
    swept_once: std::sync::atomic::AtomicBool,
    search_seq: AtomicU64,
    owned_cache: Mutex<Option<(Instant, Arc<OwnedIndex>)>>,
    /// `job_id -> (bytes_transferred, quando_vimos_esse_valor_pela_1a_vez)`
    /// pra detectar stall por bytes parados (`STALL_BYTES_SECS`).
    stall_bytes: Mutex<HashMap<String, (u64, Instant)>>,
    /// `job_id -> quando entrou em Enqueued` pra detectar stall por fila
    /// longa (`STALL_ENQUEUED_SECS`) — sem posição numérica disponível no
    /// wire atual (`ApiTransferFile` não tem esse campo), então o sinal é
    /// só "tempo em Enqueued", não "posição não cai". Aproximação
    /// documentada — ver `etapa-C-report.md`.
    enqueued_since: Mutex<HashMap<String, Instant>>,
    /// `job_id -> quando vimos o transfer pela última vez em
    /// `GET /transfers/downloads`` — job some da lista (peer caiu, slskd
    /// esqueceu) vira `Failed` depois de `MISSING_TRANSFER_TIMEOUT_SECS`
    /// (review IM-8b).
    last_seen: Mutex<HashMap<String, Instant>>,
    /// `job_id -> deadline` de locate pendente — substitui o antigo loop
    /// de `thread::sleep` (review CR-1): tenta uma vez, se não achar entra
    /// aqui e o próximo tick de poll tenta de novo, até a deadline.
    locating: Mutex<HashMap<String, Instant>>,
    /// `job_id -> (tentativas, próxima tentativa, path staged)` — retry de
    /// ingest quando o Qdrant está fora (review IM-10a): fica em
    /// `Indexing`, retenta a cada `INGEST_RETRY_INTERVAL` até
    /// `INGEST_MAX_RETRIES`, só então vira `Failed`.
    indexing_retry: Mutex<HashMap<String, (u8, Instant, PathBuf)>>,
    jobs_path: PathBuf,
    dirty: Mutex<bool>,
    last_emit: Mutex<Option<Instant>>,
}

impl Coordinator {
    #[allow(clippy::too_many_arguments)]
    fn new(
        cfg: Arc<SlskConfig>,
        api: Arc<dyn SlskdApi>,
        board: Arc<JobBoard>,
        searches: Arc<RwLock<SearchStore>>,
        ingest: Box<dyn Fn(Vec<PathBuf>) -> Vec<IngestOutcome> + Send + Sync>,
        owned_index_provider: Box<dyn Fn() -> Result<OwnedIndex, String> + Send + Sync>,
        jobs_path: PathBuf,
    ) -> Self {
        Coordinator {
            cfg,
            api,
            board,
            searches,
            ingest,
            owned_index_provider,
            pacer: Mutex::new(Pacer::new()),
            active_search: Mutex::new(None),
            swept_once: std::sync::atomic::AtomicBool::new(false),
            search_seq: AtomicU64::new(0),
            owned_cache: Mutex::new(None),
            stall_bytes: Mutex::new(HashMap::new()),
            enqueued_since: Mutex::new(HashMap::new()),
            last_seen: Mutex::new(HashMap::new()),
            locating: Mutex::new(HashMap::new()),
            indexing_retry: Mutex::new(HashMap::new()),
            jobs_path,
            dirty: Mutex::new(false),
            last_emit: Mutex::new(None),
        }
    }

    fn lock_pacer(&self) -> std::sync::MutexGuard<'_, Pacer> {
        self.pacer.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn mark_dirty(&self) {
        *self.dirty.lock().unwrap_or_else(|p| p.into_inner()) = true;
        self.save_jobs();
    }

    // ── Dedup index (cache TTL 60s) ────────────────────────────────────

    fn owned_index(&self) -> Arc<OwnedIndex> {
        let mut cache = self.owned_cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((built_at, idx)) = cache.as_ref() {
            if built_at.elapsed() < OWNED_INDEX_TTL {
                return idx.clone();
            }
        }
        match (self.owned_index_provider)() {
            Ok(idx) => {
                let idx = Arc::new(idx);
                *cache = Some((Instant::now(), idx.clone()));
                idx
            }
            Err(e) => {
                tracing::warn!(error = %e, "slsk-coord: falha ao construir OwnedIndex; dedup degradado");
                if let Some((_, idx)) = cache.as_ref() {
                    return idx.clone();
                }
                // Sem cache anterior e sem Qdrant: não há como produzir um
                // OwnedIndex válido. Todo chamador usa catch_unwind em
                // volta desta função e trata como Failed{retryable:true} —
                // nunca deixa esse panic escapar pra fora do coordinator.
                panic!("slsk-coord: OwnedIndex indisponível (Qdrant fora do ar) e sem cache anterior")
            }
        }
    }

    fn owned_index_safe(&self) -> Option<Arc<OwnedIndex>> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.owned_index())).ok()
    }

    fn invalidate_owned(&self) {
        *self.owned_cache.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    // ── Persistência mínima (spec §3.6) ────────────────────────────────

    fn save_jobs(&self) {
        let persisted: Vec<PersistedJob> = self
            .board
            .snapshot()
            .into_iter()
            .filter(|j| !super::board::is_terminal(&j.state))
            .map(|j| PersistedJob {
                job_id: j.job_id,
                username: j.username,
                remote_filename: j.remote_filename,
                dest_playlist: j.dest_playlist,
                alternates: j.alternates,
                created_at: j.created_at,
            })
            .collect();
        let body = match serde_json::to_string(&persisted) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(?e, "slsk-coord: falha ao serializar slsk_jobs.json");
                return;
            }
        };
        let tmp = self.jobs_path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, &body).and_then(|_| std::fs::rename(&tmp, &self.jobs_path)) {
            tracing::warn!(?e, "slsk-coord: falha ao persistir slsk_jobs.json");
        }
    }

    fn load_persisted_jobs(&self) -> Vec<PersistedJob> {
        let raw = match std::fs::read_to_string(&self.jobs_path) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        match serde_json::from_str::<Vec<PersistedJob>>(&raw) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(?e, "slsk-coord: slsk_jobs.json malformado, ignorando (nunca panic)");
                Vec::new()
            }
        }
    }

    /// Boot: cruza `slsk_jobs.json` com `GET /transfers/downloads` pra
    /// restaurar `dest_playlist`/`alternates` — o estado em si vem da
    /// reconciliação, não do disco (spec §3.6). Entradas >7 dias são
    /// podadas. Um transfer já `Succeeded` no boot RETOMA o staging de
    /// verdade (review IM-8a: antes só marcava `Processing` e ficava preso
    /// pra sempre, porque o poll normal não trata jobs em `Processing`).
    /// Nunca panica com arquivo ausente/malformado.
    fn reconcile_boot(&self, now_unix: i64) {
        let persisted = self.load_persisted_jobs();
        let downloads = self.api.downloads().unwrap_or_default();
        let now = Instant::now();

        for pj in persisted {
            if now_unix - pj.created_at > TERMINAL_PRUNE_AGE_SECS {
                continue;
            }
            let base = DownloadJob {
                job_id: pj.job_id.clone(),
                username: pj.username.clone(),
                remote_filename: pj.remote_filename.clone(),
                display: pj.remote_filename.clone(),
                dest_playlist: pj.dest_playlist,
                state: JobState::Queued, // placeholder, sobrescrito abaixo
                // Não persistido — só importa pra `promote_queued` de jobs
                // criados na MESMA sessão (`start_download` grava o size
                // real); jobs reconciliados nunca voltam a ficar `Queued`
                // localmente antes de um novo `try_other_source`, que já
                // grava o `size` certo da alternativa escolhida.
                size: 0,
                alternates: pj.alternates,
                tried_source_ids: Vec::new(),
                created_at: pj.created_at,
            };

            match find_transfer(&downloads, &pj.username, &pj.remote_filename) {
                Some(file) => {
                    let outcome = classify_transfer_state(&file.state);
                    if outcome == TransferOutcome::Succeeded {
                        self.board.upsert(DownloadJob { state: JobState::Processing, ..base });
                        if let Some(job) = self.board.get(&pj.job_id) {
                            self.begin_locate(&job, now);
                        }
                    } else {
                        let state = job_state_from_outcome(
                            outcome,
                            file.percent_complete as f32,
                            file.average_speed as u64,
                            file.size,
                            file.bytes_transferred,
                        );
                        self.board.upsert(DownloadJob { state, ..base });
                    }
                }
                None => {
                    self.board.upsert(DownloadJob {
                        state: JobState::Manual {
                            path: self.cfg.downloads_dir.display().to_string(),
                            why: "sem rastro no slskd apos reiniciar — verifique downloads manualmente"
                                .to_string(),
                        },
                        ..base
                    });
                }
            }
        }
        self.board.retain_recent_terminals(JOBS_RETAINED);
        stage::clean_orphan_incoming(&self.cfg.music_root, &self.board.active_ids());
    }

    // ── Busca (spec §3.4, §6.1-§6.3) ───────────────────────────────────

    /// Primeiro uso da sessão: varre `list_searches()`, ordena
    /// EXPLICITAMENTE por `started_at` (review IM-9: não assume a ordem
    /// que a API devolve) e deleta tudo além das `SWEEP_MAX_KEEP` mais
    /// recentes OU mais velho que `SWEEP_MAX_AGE_SECS` — os dois critérios
    /// do §6.3, agora os dois implementados (a API real tem
    /// `startedAt`/`endedAt`, confirmado). Idempotente — só roda uma vez
    /// por vida do coordinator (`swept_once`).
    fn ensure_swept(&self) {
        if self.swept_once.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut all = match self.api.list_searches() {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(?e, "slsk-coord: sweep inicial falhou ao listar buscas");
                return;
            }
        };
        all.sort_by_key(|s| s.started_at.as_deref().and_then(parse_iso8601_utc).unwrap_or(0));

        let cutoff = unix_now() - SWEEP_MAX_AGE_SECS;
        let keep_recent_from = all.len().saturating_sub(SWEEP_MAX_KEEP);

        let mut deleted = 0usize;
        for (idx, s) in all.iter().enumerate() {
            let beyond_count = idx < keep_recent_from;
            let too_old = s
                .started_at
                .as_deref()
                .and_then(parse_iso8601_utc)
                .map(|t| t < cutoff)
                .unwrap_or(false);
            if beyond_count || too_old {
                let _ = self.api.delete_search(&s.id);
                deleted += 1;
            }
        }
        if deleted > 0 {
            tracing::info!(count = deleted, "slsk-coord: sweep de buscas acumuladas");
        }
    }

    /// Handler de `SlskTask::Search`. Responde ao `reply` ANTES de
    /// `ensure_swept`/`start_search` (review CR-1: essas duas chamadas são
    /// I/O de rede — `ensure_swept` pode disparar centenas de `DELETE`,
    /// como no incidente de 17/07 — e não podiam ficar no caminho de um
    /// comando que a spec exige responder em microssegundos).
    fn handle_search(&self, query: String, force: bool, now: Instant, reply: Sender<Result<String, String>>) {
        let decision = self.lock_pacer().check(now, force);
        let mapped = match decision {
            PaceDecision::Go => Ok(()),
            PaceDecision::Cooldown(s) => Err(format!("cooldown:{s}")),
            PaceDecision::Cold(s) => Err(format!("cold:{s}")),
            PaceDecision::HourlyCapped => Err("busy".to_string()),
        };
        if let Err(e) = mapped {
            let _ = reply.send(Err(e));
            return;
        }
        self.lock_pacer().record_search(now);

        let local_id = format!("s{}", self.search_seq.fetch_add(1, Ordering::SeqCst));
        {
            let mut store = self.searches.write().unwrap_or_else(|p| p.into_inner());
            store.entries.insert(
                local_id.clone(),
                StoredSearch {
                    remote_id: None,
                    query: query.clone(),
                    snapshot: SearchSnapshot::default(),
                    raw_groups: HashMap::new(),
                },
            );
        }

        // Responde JÁ — tudo daqui pra baixo é I/O de rede.
        let _ = reply.send(Ok(local_id.clone()));

        self.ensure_swept();

        match self.api.start_search(&query) {
            Ok(remote_id) => {
                {
                    let mut store = self.searches.write().unwrap_or_else(|p| p.into_inner());
                    if let Some(entry) = store.entries.get_mut(&local_id) {
                        entry.remote_id = Some(remote_id.clone());
                    }
                }
                // IM-5: uma busca anterior em voo (o Pacer libera nova
                // busca a partir de 4s, bem antes da janela de 25s da
                // anterior estourar) precisa ser deletada AGORA, não só
                // quando a nova terminar — senão ela vaza no slskd
                // (exatamente o passivo que o §6.3 existe pra eliminar).
                let mut active = self.active_search.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(prev) = active.take() {
                    let _ = self.api.delete_search(&prev.remote_id);
                }
                *active = Some(ActiveSearch {
                    local_id,
                    remote_id,
                    started_at: now,
                    next_poll_at: now,
                });
            }
            Err(e) => {
                let mut store = self.searches.write().unwrap_or_else(|p| p.into_inner());
                if let Some(entry) = store.entries.get_mut(&local_id) {
                    entry.snapshot.state = SearchState::Failed;
                    entry.snapshot.note = Some(e.to_string());
                }
            }
        }
    }

    /// Poll de UMA busca ativa, se houver e se já passou `SEARCH_POLL`
    /// desde o último poll. Encerra em `Done`/`Empty` quando a janela de
    /// `SEARCH_WINDOW` estoura, e SEMPRE deleta a busca no slskd ao
    /// encerrar (`SearchGuard`, mata o 409 na raiz — spec §6.3).
    fn poll_active_search_once(&self, now: Instant) {
        let should_poll = {
            let guard = self.active_search.lock().unwrap_or_else(|p| p.into_inner());
            match guard.as_ref() {
                Some(s) => now >= s.next_poll_at,
                None => false,
            }
        };
        if !should_poll {
            return;
        }

        let (local_id, remote_id, started_at) = {
            let guard = self.active_search.lock().unwrap_or_else(|p| p.into_inner());
            let s = guard.as_ref().unwrap();
            (s.local_id.clone(), s.remote_id.clone(), s.started_at)
        };

        let responses = self.api.search_responses(&remote_id).unwrap_or_default();
        // IM-4: a query REAL guardada em StoredSearch — antes isto sempre
        // vinha "", zerando o derank de live/remix e a similaridade de
        // título no ranking.
        let query = self
            .searches
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .entries
            .get(&local_id)
            .map(|e| e.query.clone())
            .unwrap_or_default();
        let ranked = slskd_client::rank::aggregate(&responses, &query);

        let owned = self.owned_index_safe();
        let elapsed = now.saturating_duration_since(started_at);
        let window_over = elapsed >= SEARCH_WINDOW;

        {
            let mut store = self.searches.write().unwrap_or_else(|p| p.into_inner());
            if let Some(entry) = store.entries.get_mut(&local_id) {
                let mut raw_groups = HashMap::new();
                let mut groups = Vec::with_capacity(ranked.groups.len());
                for g in &ranked.groups {
                    let owned_verdict = owned.as_ref().and_then(|idx| {
                        g.display_artist
                            .as_deref()
                            .and_then(|artist| idx.lookup_collab_aware(artist, &g.display_title))
                            .map(OwnedVerdictWire::from)
                    });
                    let suggested_dest = owned.as_ref().and_then(|idx| {
                        g.display_artist
                            .as_deref()
                            .and_then(|artist| idx.folder_for_artist(artist))
                            .map(|s| s.to_string())
                    });
                    groups.push(ResultGroup {
                        group_key: g.group_key.clone(),
                        display_title: g.display_title.clone(),
                        display_artist: g.display_artist.clone(),
                        album_hint: g.album_hint.clone(),
                        duration_secs: g.duration_secs,
                        quality_label: g.quality_label.clone(),
                        owned: owned_verdict,
                        suggested_dest,
                        best: Candidate::from(&g.best),
                        alternates: g.alternates.iter().map(Candidate::from).collect(),
                    });
                    raw_groups.insert(
                        g.group_key.clone(),
                        RawGroup {
                            best: g.best.clone(),
                            alternates: g.alternates.clone(),
                        },
                    );
                }
                entry.snapshot.elapsed_ms = elapsed.as_millis() as u64;
                entry.snapshot.responses_seen = responses.len() as u32;
                entry.snapshot.groups = groups;
                entry.snapshot.state = if window_over {
                    if entry.snapshot.groups.is_empty() {
                        SearchState::Empty
                    } else {
                        SearchState::Done
                    }
                } else {
                    SearchState::Running
                };
                entry.raw_groups = raw_groups;
            }
        }

        self.lock_pacer().record_result(now, responses.len() as u32);

        if window_over {
            let _guard = SearchGuard(self.api.as_ref(), remote_id);
            let mut active = self.active_search.lock().unwrap_or_else(|p| p.into_inner());
            *active = None;
        } else {
            let mut active = self.active_search.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(s) = active.as_mut() {
                s.next_poll_at = now + SEARCH_POLL;
            }
        }
    }

    fn handle_cancel_search(&self, search_id: String) {
        let mut active = self.active_search.lock().unwrap_or_else(|p| p.into_inner());
        if active.as_ref().map(|s| s.local_id == search_id).unwrap_or(false) {
            if let Some(s) = active.take() {
                let _ = self.api.delete_search(&s.remote_id);
            }
        }
        drop(active);
        let mut store = self.searches.write().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = store.entries.get_mut(&search_id) {
            entry.snapshot.state = SearchState::Canceled;
        }
    }

    /// Chamado no `Disconnected` do `run_loop` (app fechando): mata
    /// qualquer busca em voo antes da thread morrer — o `SearchGuard`
    /// normal só cobre o caminho de `window_over`, não o shutdown
    /// (review IM-5).
    fn shutdown_active_search(&self) {
        let mut active = self.active_search.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(s) = active.take() {
            let _ = self.api.delete_search(&s.remote_id);
        }
    }

    // ── Download: criação de job (spec §3.4, §5.1, §4.5) ───────────────

    /// Núcleo de `SlskTask::Download`, já com o candidato resolvido —
    /// separado da resolução via `SearchStore` pra ficar testável sem
    /// precisar montar uma busca fake inteira. Só os testes chamam isto
    /// direto; produção usa `handle_task_download`, que responde ao
    /// `reply` ANTES de `enqueue_job` (CR-1) — mesma lógica, ordem
    /// diferente (`reply` primeiro, sem esperar o `enqueue_job` síncrono
    /// que este método faz).
    #[cfg(test)]
    fn start_download(
        &self,
        candidate: &slskd_client::rank::Candidate,
        alternates: Vec<slskd_client::rank::Candidate>,
        dest_playlist: &str,
        now: Instant,
    ) -> Result<String, String> {
        let job_id = self.create_or_get_job(candidate, alternates, dest_playlist);
        if self.board.in_flight_count() >= MAX_ACTIVE_TRANSFERS {
            return Ok(job_id);
        }
        self.enqueue_job(&job_id, &candidate.username, &candidate.filename, candidate.size, now);
        Ok(job_id)
    }

    /// Parte memory-only de criar um job — idempotente por `job_id`. Não
    /// faz I/O nenhuma, então é seguro chamar ANTES de responder um
    /// `reply` (CR-1).
    fn create_or_get_job(
        &self,
        candidate: &slskd_client::rank::Candidate,
        alternates: Vec<slskd_client::rank::Candidate>,
        dest_playlist: &str,
    ) -> String {
        let job_id = super::board::job_id(&candidate.username, &candidate.filename);
        if self.board.contains(&job_id) {
            return job_id;
        }
        let display = slskd_client::rank::guess_artist_title(&candidate.filename)
            .map(|(a, t)| format!("{a} - {t}"))
            .unwrap_or_else(|| slskd_client::rank::remote_basename(&candidate.filename).to_string());

        self.board.upsert(DownloadJob {
            job_id: job_id.clone(),
            username: candidate.username.clone(),
            remote_filename: candidate.filename.clone(),
            display,
            dest_playlist: dest_playlist.to_string(),
            state: JobState::Queued,
            size: candidate.size,
            alternates: alternates.iter().map(Candidate::from).collect(),
            tried_source_ids: Vec::new(),
            created_at: unix_now(),
        });
        self.mark_dirty();
        job_id
    }

    fn enqueue_job(&self, job_id: &str, username: &str, filename: &str, size: u64, now: Instant) {
        match self.api.enqueue(username, filename, size) {
            Ok(()) => {
                self.board.transition(job_id, JobState::Enqueued { queue_position: None });
                self.enqueued_since
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(job_id.to_string(), now);
            }
            Err(e) => {
                self.board.transition(
                    job_id,
                    JobState::Failed { reason: e.to_string(), retryable: true },
                );
            }
        }
        self.mark_dirty();
    }

    /// Resolve `search_id`+`group_key`+`source_id` num candidato — só
    /// leitura do `SearchStore` (memory-only), sem I/O.
    fn resolve_download_candidate(
        &self,
        search_id: &str,
        group_key: &str,
        source_id: &str,
    ) -> Result<(slskd_client::rank::Candidate, Vec<slskd_client::rank::Candidate>), String> {
        let store = self.searches.read().unwrap_or_else(|p| p.into_inner());
        let entry = store
            .entries
            .get(search_id)
            .ok_or_else(|| "busca desconhecida ou expirada".to_string())?;
        let group = entry
            .raw_groups
            .get(group_key)
            .ok_or_else(|| "grupo nao encontrado nessa busca".to_string())?;
        let candidate = std::iter::once(&group.best)
            .chain(group.alternates.iter())
            .find(|c| c.id == source_id)
            .ok_or_else(|| "fonte nao encontrada nesse grupo".to_string())?
            .clone();
        let alternates: Vec<_> = std::iter::once(&group.best)
            .chain(group.alternates.iter())
            .filter(|c| c.id != source_id)
            .cloned()
            .collect();
        Ok((candidate, alternates))
    }

    /// Handler de `SlskTask::Download`. Responde ao `reply` com o `job_id`
    /// (determinístico, sem I/O) IMEDIATAMENTE após criar o job em
    /// memória — o `enqueue_job` (I/O de rede) roda DEPOIS (review CR-1).
    fn handle_task_download(
        &self,
        search_id: &str,
        group_key: &str,
        source_id: &str,
        dest: &str,
        now: Instant,
        reply: Sender<Result<String, String>>,
    ) {
        if !is_valid_playlist_name(dest) {
            let _ = reply.send(Err("destino de playlist invalido".to_string()));
            return;
        }
        let (candidate, alternates) = match self.resolve_download_candidate(search_id, group_key, source_id) {
            Ok(v) => v,
            Err(e) => {
                let _ = reply.send(Err(e));
                return;
            }
        };

        let job_id = self.create_or_get_job(&candidate, alternates, dest);
        let _ = reply.send(Ok(job_id.clone()));

        if self.board.in_flight_count() >= MAX_ACTIVE_TRANSFERS {
            return;
        }
        self.enqueue_job(&job_id, &candidate.username, &candidate.filename, candidate.size, now);
    }

    /// Parte síncrona (memory-only) do `[Trocar fonte]`: valida, escolhe a
    /// próxima fonte não tentada, aplica a mutação de estado. `state:
    /// JobState::Queued` é gravado EXPLICITAMENTE no `upsert` (review
    /// IM-6: o código antigo fazia `board.transition(...Queued)` e DEPOIS
    /// um `upsert` com `..job` — o `job` capturado ANTES da transição
    /// ainda tinha o `state` velho, então o `upsert` desfazia a transição
    /// em silêncio). Usa `can_transition` direto (não `board.transition`)
    /// porque a aresta `{failed,rejected}->queued` (CR-3) precisa valer
    /// aqui mesmo sem ir por `board.transition` duas vezes.
    fn try_other_source_sync(&self, job_id: &str) -> Result<Candidate, String> {
        let job = self.board.get(job_id).ok_or_else(|| "job nao encontrado".to_string())?;
        let next = job
            .alternates
            .iter()
            .find(|c| !job.tried_source_ids.contains(&c.id))
            .cloned()
            .ok_or_else(|| "sem outras fontes disponiveis".to_string())?;

        if !can_transition(&job.state, &JobState::Queued) {
            return Err("job em estado que nao aceita troca de fonte agora".to_string());
        }

        let mut tried = job.tried_source_ids.clone();
        tried.push(next.id.clone());
        self.board.upsert(DownloadJob {
            username: next.username.clone(),
            remote_filename: next.filename.clone(),
            tried_source_ids: tried,
            state: JobState::Queued,
            size: next.size,
            ..job
        });
        self.mark_dirty();
        Ok(next)
    }

    /// Versão direta (testes chamam isso) — síncrona, faz a troca de
    /// fonte E o enqueue numa tacada.
    #[cfg(test)]
    fn try_other_source(&self, job_id: &str, now: Instant) -> Result<String, String> {
        let next = self.try_other_source_sync(job_id)?;
        self.enqueue_job(job_id, &next.username, &next.filename, next.size, now);
        Ok(job_id.to_string())
    }

    /// Handler de `SlskTask::TryOtherSource`. Responde ao `reply` ANTES do
    /// `enqueue_job` (I/O) — mesma lógica de `try_other_source`, ordem
    /// diferente (review CR-1).
    fn handle_try_other_source(&self, job_id: &str, now: Instant, reply: Sender<Result<String, String>>) {
        match self.try_other_source_sync(job_id) {
            Ok(next) => {
                let _ = reply.send(Ok(job_id.to_string()));
                self.enqueue_job(job_id, &next.username, &next.filename, next.size, now);
            }
            Err(e) => {
                let _ = reply.send(Err(e));
            }
        }
    }

    /// `slsk_cancel`. Usa o `id` REAL do transfer no slskd
    /// (`ApiTransferFile.id`, um GUID) — não o nosso hash `DefaultHasher`
    /// (review IM-3: `cancel_download(username, job_id)` batia num
    /// `DELETE .../{username}/{job_id}` que nunca existiu no slskd, o 404
    /// era engolido, e o download continuava consumindo banda e slot lá).
    /// Sem transfer encontrado (job só local, nunca chegou a enfileirar,
    /// ou já sumiu do slskd), cancela só localmente.
    fn cancel_job(&self, job_id: &str) {
        let Some(job) = self.board.get(job_id) else { return };
        if !self.board.transition(job_id, JobState::Canceled) {
            return;
        }
        self.mark_dirty();
        if let Ok(downloads) = self.api.downloads() {
            if let Some(file) = find_transfer(&downloads, &job.username, &job.remote_filename) {
                let _ = self.api.cancel_download(&job.username, &file.id);
            }
        }
    }

    fn clear_finished(&self) -> u32 {
        let n = self.board.clear_finished();
        if n > 0 {
            self.mark_dirty();
        }
        n
    }

    // ── Transfers: poll, stall, staging, ingest (spec §5.2-§5.6) ───────

    /// Um ciclo de poll sobre TODOS os jobs ativos. Chamado pelo loop real
    /// a cada `POLL_ACTIVE`/`POLL_IDLE`; os testes chamam direto com `now`
    /// fabricado. Se `api.downloads()` falhar (slskd fora do ar), TODOS os
    /// jobs in-flight viram `Failed{retryable:true}` (review IM-10b) — sem
    /// isso ficavam presos indefinidamente em `Downloading`/`Enqueued`.
    fn poll_active_transfers_once(&self, now: Instant) {
        let active_ids = self.board.active_ids();
        if active_ids.is_empty() {
            return;
        }
        let downloads = match self.api.downloads() {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(?e, "slsk-coord: poll de transfers falhou — slskd parece fora do ar");
                self.fail_all_in_flight("slskd inalcancavel");
                return;
            }
        };

        for job_id in active_ids {
            let Some(job) = self.board.get(&job_id) else { continue };
            match &job.state {
                JobState::Enqueued { .. } | JobState::Downloading { .. } | JobState::Stalled { .. } => {
                    self.poll_one_transfer(&job, &downloads, now);
                }
                JobState::Processing => {
                    let pending = self.locating.lock().unwrap_or_else(|p| p.into_inner()).contains_key(&job_id);
                    if pending {
                        self.continue_locate(&job, now);
                    }
                }
                JobState::Indexing => {
                    self.continue_ingest_retry(&job, now);
                }
                _ => {}
            }
        }

        self.promote_queued(now);
    }

    fn fail_all_in_flight(&self, reason: &str) {
        for job_id in self.board.in_flight_ids() {
            if self.board.transition(&job_id, JobState::Failed { reason: reason.to_string(), retryable: true }) {
                self.mark_dirty();
            }
        }
    }

    /// Promove jobs `Queued` enquanto houver vaga — usa `in_flight_count`
    /// (review CR-2: `active_count` antigo contava `Queued` também, então
    /// promover um job nunca reduzia a contagem de "não-terminal" e a fila
    /// travava permanentemente com ≥`MAX_ACTIVE_TRANSFERS+1` jobs). Usa
    /// `job.size` real (review IM-7: antes ia com `size:0` fixo).
    fn promote_queued(&self, now: Instant) {
        while self.board.in_flight_count() < MAX_ACTIVE_TRANSFERS {
            let queued = self
                .board
                .snapshot()
                .into_iter()
                .find(|j| j.state == JobState::Queued);
            let Some(job) = queued else { break };
            self.enqueue_job(&job.job_id, &job.username, &job.remote_filename, job.size, now);
        }
    }

    fn poll_one_transfer(&self, job: &DownloadJob, downloads: &[ApiTransferUser], now: Instant) {
        let Some(file) = find_transfer(downloads, &job.username, &job.remote_filename) else {
            self.handle_missing_transfer(job, now);
            return;
        };
        self.last_seen.lock().unwrap_or_else(|p| p.into_inner()).insert(job.job_id.clone(), now);

        let outcome = classify_transfer_state(&file.state);
        match outcome {
            TransferOutcome::Succeeded => {
                self.stall_bytes.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);
                self.enqueued_since.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);
                self.board.transition(&job.job_id, JobState::Processing);
                self.mark_dirty();
                self.begin_locate(job, now);
            }
            TransferOutcome::Errored | TransferOutcome::TimedOut => {
                self.handle_transfer_failure(job, &file.state, now);
            }
            TransferOutcome::Aborted | TransferOutcome::Canceled => {
                self.board.transition(&job.job_id, JobState::Canceled);
                self.mark_dirty();
            }
            TransferOutcome::Queued => {
                self.check_enqueued_stall(job, now);
            }
            TransferOutcome::InProgress => {
                self.check_bytes_stall(
                    job,
                    file.bytes_transferred,
                    file.percent_complete as f32,
                    file.average_speed as u64,
                    file.size,
                    now,
                );
            }
        }
    }

    /// `find_transfer` não achou o job na resposta do slskd (peer caiu,
    /// slskd esqueceu o transfer) — depois de `MISSING_TRANSFER_TIMEOUT_SECS`
    /// sem reaparecer, vira `Failed` visível em vez de `Enqueued` pra
    /// sempre (review IM-8b).
    fn handle_missing_transfer(&self, job: &DownloadJob, now: Instant) {
        let baseline = {
            let mut last_seen = self.last_seen.lock().unwrap_or_else(|p| p.into_inner());
            *last_seen.entry(job.job_id.clone()).or_insert(now)
        };
        if now.saturating_duration_since(baseline).as_secs() >= MISSING_TRANSFER_TIMEOUT_SECS {
            self.last_seen.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);
            self.board.transition(
                &job.job_id,
                JobState::Failed { reason: "transfer sumiu do slskd".to_string(), retryable: true },
            );
            self.mark_dirty();
        }
    }

    fn check_bytes_stall(&self, job: &DownloadJob, bytes: u64, pct: f32, bps: u64, size: u64, now: Instant) {
        let mut stall_map = self.stall_bytes.lock().unwrap_or_else(|p| p.into_inner());
        let stalled_secs = match stall_map.get(&job.job_id) {
            Some((last_bytes, since)) if *last_bytes == bytes => {
                now.saturating_duration_since(*since).as_secs()
            }
            _ => {
                stall_map.insert(job.job_id.clone(), (bytes, now));
                0
            }
        };
        drop(stall_map);

        if stalled_secs >= STALL_BYTES_SECS {
            self.board.transition(&job.job_id, JobState::Stalled { since_secs: stalled_secs });
        } else {
            let eta_s = if bps > 0 && size > bytes {
                Some(((size - bytes) / bps) as u32)
            } else {
                None
            };
            self.board.transition(&job.job_id, JobState::Downloading { pct, bps, eta_s });
        }
        self.mark_dirty();
    }

    fn check_enqueued_stall(&self, job: &DownloadJob, now: Instant) {
        let mut since_map = self.enqueued_since.lock().unwrap_or_else(|p| p.into_inner());
        let since = *since_map.entry(job.job_id.clone()).or_insert(now);
        drop(since_map);
        let waited = now.saturating_duration_since(since).as_secs();
        if waited >= STALL_ENQUEUED_SECS {
            self.board.transition(&job.job_id, JobState::Stalled { since_secs: waited });
            self.mark_dirty();
        }
    }

    /// 1ª falha (`Errored`/`TimedOut`): retry automático numa fonte ainda
    /// não tentada, SEM passar por `Failed` (spec §5.6). Sem fonte nova
    /// disponível, ou já tinha tentado antes (retry já consumido): vira
    /// `Failed` visível. `state: JobState::Queued` explícito no `upsert`
    /// (review IM-6, mesma causa raiz de `try_other_source_sync`).
    fn handle_transfer_failure(&self, job: &DownloadJob, raw_state: &str, now: Instant) {
        self.stall_bytes.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);
        self.enqueued_since.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);

        let already_retried = !job.tried_source_ids.is_empty();
        let next = job
            .alternates
            .iter()
            .find(|c| !job.tried_source_ids.contains(&c.id))
            .cloned();

        match (already_retried, next) {
            (false, Some(alt)) => {
                let mut tried = job.tried_source_ids.clone();
                tried.push(alt.id.clone());
                self.board.upsert(DownloadJob {
                    username: alt.username.clone(),
                    remote_filename: alt.filename.clone(),
                    tried_source_ids: tried,
                    state: JobState::Queued,
                    size: alt.size,
                    ..job.clone()
                });
                self.mark_dirty();
                self.enqueue_job(&job.job_id, &alt.username, &alt.filename, alt.size, now);
            }
            _ => {
                self.board.transition(
                    &job.job_id,
                    JobState::Failed { reason: raw_state.to_string(), retryable: false },
                );
                self.mark_dirty();
            }
        }
    }

    // ── Localização + staging (não bloqueia — review CR-1) ─────────────

    /// 1ª tentativa de localizar o arquivo baixado. Achou -> segue direto
    /// pro staging; não achou -> registra em `locating` com deadline
    /// `LOCATE_RETRY_WINDOW` pro PRÓXIMO tick de poll tentar de novo
    /// (`continue_locate`). Nunca dá `sleep` — troca o loop bloqueante
    /// antigo pelo cadenciamento normal de poll (1s ativo / 5s idle).
    fn begin_locate(&self, job: &DownloadJob, now: Instant) {
        let started_at = job_created_at_as_systemtime(job.created_at);
        match stage::locate_downloaded(&self.cfg.downloads_dir, &job.remote_filename, started_at) {
            Some(local) => {
                self.locating.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);
                self.stage_and_ingest(job, local);
            }
            None => {
                self.locating
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(job.job_id.clone(), now + LOCATE_RETRY_WINDOW);
            }
        }
    }

    fn continue_locate(&self, job: &DownloadJob, now: Instant) {
        let deadline = {
            let locating = self.locating.lock().unwrap_or_else(|p| p.into_inner());
            locating.get(&job.job_id).copied()
        };
        let Some(deadline) = deadline else { return };
        let started_at = job_created_at_as_systemtime(job.created_at);
        match stage::locate_downloaded(&self.cfg.downloads_dir, &job.remote_filename, started_at) {
            Some(local) => {
                self.locating.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);
                self.stage_and_ingest(job, local);
            }
            None if now >= deadline => {
                self.locating.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);
                self.board.transition(
                    &job.job_id,
                    JobState::Manual {
                        path: self.cfg.downloads_dir.display().to_string(),
                        why: "baixou, mas nao achei o arquivo em downloads_dir".to_string(),
                    },
                );
                self.mark_dirty();
            }
            None => {} // ainda dentro da janela, tenta de novo no proximo tick
        }
    }

    /// Valida (dedup via `OwnedIndex`) e move (`stage::stage_file`, que já
    /// cuida de quarentena internamente em qualquer `Rejected` — review
    /// IM-2). Sucesso -> `Indexing` + `try_ingest`.
    fn stage_and_ingest(&self, job: &DownloadJob, local: PathBuf) {
        let owned = match self.owned_index_safe() {
            Some(idx) => idx,
            None => {
                self.board.transition(
                    &job.job_id,
                    JobState::Failed {
                        reason: "Qdrant indisponivel para checagem de dedup".to_string(),
                        retryable: true,
                    },
                );
                self.mark_dirty();
                return;
            }
        };

        match stage::stage_file(&self.cfg.music_root, &job.dest_playlist, &local, &owned, &job.job_id) {
            Ok(stage::StageOutcome::Staged { final_path }) => {
                self.board.transition(&job.job_id, JobState::Indexing);
                self.mark_dirty();
                self.try_ingest(job, final_path, Instant::now());
            }
            Ok(stage::StageOutcome::Rejected(reason)) => {
                self.board.transition(&job.job_id, JobState::Rejected { reason });
                self.mark_dirty();
            }
            Err(e) => {
                self.board.transition(&job.job_id, JobState::Failed { reason: e, retryable: true });
                self.mark_dirty();
            }
        }
    }

    /// Chama `ingest`. Sucesso -> `Ready`. Falha -> `schedule_ingest_retry`
    /// (review IM-10a: antes ia direto pra `Failed`, ignorando o retry de
    /// 5x/30s que o §5.6 pede pro caso "Qdrant fora no ingest").
    fn try_ingest(&self, job: &DownloadJob, final_path: PathBuf, now: Instant) {
        let outcomes = (self.ingest)(vec![final_path.clone()]);
        self.invalidate_owned();
        match outcomes.into_iter().find(|o| o.path == final_path) {
            Some(IngestOutcome { result: Ok(track_id), .. }) => {
                self.indexing_retry.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);
                self.board.transition(&job.job_id, JobState::Ready { track_id: track_id.to_string() });
            }
            Some(IngestOutcome { result: Err(e), .. }) => {
                self.schedule_ingest_retry(job, final_path, now, e);
            }
            None => {
                self.schedule_ingest_retry(
                    job,
                    final_path,
                    now,
                    "ingest nao retornou outcome para o path staged".to_string(),
                );
            }
        }
        self.mark_dirty();
    }

    fn schedule_ingest_retry(&self, job: &DownloadJob, final_path: PathBuf, now: Instant, reason: String) {
        let mut retry_map = self.indexing_retry.lock().unwrap_or_else(|p| p.into_inner());
        let attempts = retry_map.get(&job.job_id).map(|(a, _, _)| *a).unwrap_or(0) + 1;
        if attempts >= INGEST_MAX_RETRIES {
            retry_map.remove(&job.job_id);
            drop(retry_map);
            self.board.transition(&job.job_id, JobState::Failed { reason, retryable: true });
        } else {
            retry_map.insert(job.job_id.clone(), (attempts, now + INGEST_RETRY_INTERVAL, final_path));
            // Continua em Indexing (self-loop, já legal na matriz) — a
            // próxima tentativa acontece no tick de poll em que
            // `now >= next_attempt_at` (`continue_ingest_retry`).
        }
    }

    fn continue_ingest_retry(&self, job: &DownloadJob, now: Instant) {
        let pending = {
            let retry_map = self.indexing_retry.lock().unwrap_or_else(|p| p.into_inner());
            retry_map.get(&job.job_id).cloned()
        };
        let Some((_, next_at, final_path)) = pending else { return };
        if now >= next_at {
            self.try_ingest(job, final_path, now);
        }
    }

    // ── Emissão de estado (spec §3.5) ──────────────────────────────────

    fn emit_if_dirty(&self, app: &AppHandle, now: Instant) {
        let mut dirty = self.dirty.lock().unwrap_or_else(|p| p.into_inner());
        if !*dirty {
            return;
        }
        let mut last = self.last_emit.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(t) = *last {
            if now.saturating_duration_since(t) < EMIT_THROTTLE {
                return;
            }
        }
        *dirty = false;
        *last = Some(now);
        drop(dirty);
        drop(last);
        let _ = app.emit("slsk-jobs", self.board.snapshot());
    }

    // ── Loop real (produção) ───────────────────────────────────────────

    fn run_loop(&self, app: &AppHandle, cmd_rx: &Receiver<SlskTask>) {
        loop {
            let has_active_search = self
                .active_search
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_some();
            let has_active_jobs = self.board.active_count() > 0;

            let timeout = if has_active_search {
                SEARCH_POLL
            } else if has_active_jobs {
                POLL_ACTIVE
            } else {
                POLL_IDLE
            };

            match cmd_rx.recv_timeout(timeout) {
                Ok(task) => self.handle_task(task),
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    self.shutdown_active_search();
                    tracing::info!("slsk-coord: canal de comandos fechado, encerrando thread");
                    return;
                }
            }

            let now = Instant::now();
            self.poll_active_search_once(now);
            if has_active_jobs {
                self.poll_active_transfers_once(now);
                self.board.retain_recent_terminals(JOBS_RETAINED);
            }
            self.emit_if_dirty(app, now);
        }
    }

    fn handle_task(&self, task: SlskTask) {
        let now = Instant::now();
        match task {
            SlskTask::Search { query, force, reply } => self.handle_search(query, force, now, reply),
            SlskTask::Download { search_id, group_key, source_id, dest, reply } => {
                self.handle_task_download(&search_id, &group_key, &source_id, &dest, now, reply);
            }
            SlskTask::TryOtherSource { job_id, reply } => self.handle_try_other_source(&job_id, now, reply),
            SlskTask::CancelSearch { search_id } => self.handle_cancel_search(search_id),
            SlskTask::CancelJob { job_id } => self.cancel_job(&job_id),
            SlskTask::ClearFinished { reply } => {
                let _ = reply.send(self.clear_finished());
            }
        }
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn job_state_from_outcome(
    outcome: TransferOutcome,
    pct: f32,
    bps: u64,
    size: u64,
    bytes: u64,
) -> JobState {
    match outcome {
        TransferOutcome::Succeeded => JobState::Processing,
        TransferOutcome::Errored | TransferOutcome::TimedOut => {
            JobState::Failed { reason: "transfer com erro apos reinicio".to_string(), retryable: false }
        }
        TransferOutcome::Aborted | TransferOutcome::Canceled => JobState::Canceled,
        TransferOutcome::Queued => JobState::Enqueued { queue_position: None },
        TransferOutcome::InProgress => {
            let eta_s = if bps > 0 && size > bytes { Some(((size - bytes) / bps) as u32) } else { None };
            JobState::Downloading { pct, bps, eta_s }
        }
    }
}

/// Casca fina de produção: monta o [`Coordinator`] usando o `IndexerHandle`
/// de verdade (ingest + `OwnedIndex::build` contra o Qdrant real) e roda o
/// loop numa thread própria (`slsk-coord`, mesmo padrão de
/// `library-indexer-coord`/`spectrum-emitter`).
#[allow(clippy::too_many_arguments)]
pub fn spawn_coordinator(
    cfg: Arc<SlskConfig>,
    api: Arc<dyn SlskdApi>,
    board: Arc<JobBoard>,
    searches: Arc<RwLock<SearchStore>>,
    indexer: IndexerHandle,
    app: AppHandle,
    cmd_rx: Receiver<SlskTask>,
) -> JoinHandle<()> {
    let ingest_indexer = indexer.clone();
    let ingest: Box<dyn Fn(Vec<PathBuf>) -> Vec<IngestOutcome> + Send + Sync> =
        Box::new(move |paths| ingest_indexer.ingest_paths(paths));

    let qdrant_indexer = indexer;
    let music_root_for_owned = cfg.music_root.clone();
    let owned_index_provider: Box<dyn Fn() -> Result<OwnedIndex, String> + Send + Sync> =
        Box::new(move || {
            OwnedIndex::build(qdrant_indexer.client(), &music_root_for_owned).map_err(|e| e.to_string())
        });

    let jobs_path = jobs_path_from_cfg(&cfg);

    std::thread::Builder::new()
        .name("slsk-coord".to_string())
        .spawn(move || {
            let coordinator = Coordinator::new(cfg, api, board, searches, ingest, owned_index_provider, jobs_path);
            coordinator.reconcile_boot(unix_now());
            coordinator.run_loop(&app, &cmd_rx);
        })
        .expect("failed to spawn slsk-coord thread")
}

/// `slsk_jobs.json` mora no mesmo `data_dir` de themes/stations/slsk.json —
/// `SlskConfig` não guarda `data_dir` diretamente (só `downloads_dir`/
/// `music_root`), então derivamos a partir da convenção fixa do app
/// (`~/.local/share/rustify-player`), a mesma usada por `slsk::config`.
fn jobs_path_from_cfg(_cfg: &SlskConfig) -> PathBuf {
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/home"));
    home.join(".local/share/rustify-player").join(JOBS_FILE_NAME)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slsk::stage::test_support::empty_owned_index;
    use slskd_client::testing::FakeSlskd;
    use slskd_client::wire::{ApiSearch, ApiSearchResponse, ApiTransferDir, ApiTransferFile, ApiTransferUser, ServerStatus};
    use slskd_client::SlskdError;
    use std::path::Path;
    use std::sync::Mutex as StdMutex;

    fn test_cfg(tmp: &Path) -> Arc<SlskConfig> {
        Arc::new(SlskConfig {
            base_url: "http://127.0.0.1:0".to_string(),
            auth: slskd_client::SlskAuth::ApiKey("test".to_string()),
            downloads_dir: tmp.join("downloads"),
            container_prefix: None,
            music_root: tmp.join("Music"),
        })
    }

    fn recording_ingest() -> (
        Box<dyn Fn(Vec<PathBuf>) -> Vec<IngestOutcome> + Send + Sync>,
        Arc<StdMutex<Vec<PathBuf>>>,
    ) {
        let calls = Arc::new(StdMutex::new(Vec::new()));
        let calls_clone = calls.clone();
        let f = move |paths: Vec<PathBuf>| -> Vec<IngestOutcome> {
            calls_clone.lock().unwrap().extend(paths.iter().cloned());
            paths
                .into_iter()
                .enumerate()
                .map(|(i, path)| IngestOutcome { path, result: Ok(1000 + i as u64) })
                .collect()
        };
        (Box::new(f), calls)
    }

    fn make_coordinator(tmp: &Path, api: Arc<dyn SlskdApi>) -> Coordinator {
        let cfg = test_cfg(tmp);
        let (ingest, _calls) = recording_ingest();
        let owned_provider: Box<dyn Fn() -> Result<OwnedIndex, String> + Send + Sync> =
            Box::new(|| Ok(empty_owned_index()));
        Coordinator::new(
            cfg,
            api,
            Arc::new(JobBoard::new()),
            Arc::new(RwLock::new(SearchStore::default())),
            ingest,
            owned_provider,
            tmp.join("slsk_jobs.json"),
        )
    }

    fn candidate(username: &str, filename: &str, size: u64) -> slskd_client::rank::Candidate {
        slskd_client::rank::Candidate {
            id: format!("{username}-{filename}"),
            username: username.to_string(),
            filename: filename.to_string(),
            directory: String::new(),
            size,
            bit_depth: Some(16),
            sample_rate: Some(44_100),
            length_secs: Some(200),
            free_slot: true,
            upload_speed: 100_000,
            queue_length: 0,
            score: 0,
            warn: None,
        }
    }

    fn transfer_user_with_id(
        username: &str,
        filename: &str,
        state: &str,
        bytes: u64,
        size: u64,
        transfer_id: &str,
    ) -> ApiTransferUser {
        ApiTransferUser {
            username: username.to_string(),
            directories: vec![ApiTransferDir {
                directory: String::new(),
                files: vec![ApiTransferFile {
                    id: transfer_id.to_string(),
                    username: username.to_string(),
                    filename: filename.to_string(),
                    size,
                    state: state.to_string(),
                    bytes_transferred: bytes,
                    average_speed: 1000.0,
                    percent_complete: (bytes as f64 / size as f64 * 100.0) as f64,
                    exception: None,
                    requested_at: None,
                    started_at: None,
                    ended_at: None,
                }],
            }],
        }
    }

    fn transfer_user(username: &str, filename: &str, state: &str, bytes: u64, size: u64) -> ApiTransferUser {
        transfer_user_with_id(username, filename, state, bytes, size, "t1")
    }

    fn civil_from_days(z: i64) -> (i64, u32, u32) {
        let z = z + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = (z - era * 146_097) as u64;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe as i64 + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let y = if m <= 2 { y + 1 } else { y };
        (y, m, d)
    }

    fn format_iso8601(unix_secs: i64) -> String {
        let days = unix_secs.div_euclid(86_400);
        let secs_of_day = unix_secs.rem_euclid(86_400);
        let (y, m, d) = civil_from_days(days);
        let h = secs_of_day / 3600;
        let mi = (secs_of_day % 3600) / 60;
        let s = secs_of_day % 60;
        format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
    }

    fn search_entry(id: &str, started_at_offset_secs: i64) -> ApiSearch {
        ApiSearch {
            id: id.to_string(),
            search_text: "x".to_string(),
            state: "Completed".to_string(),
            response_count: 0,
            file_count: 0,
            is_complete: true,
            started_at: Some(format_iso8601(unix_now() + started_at_offset_secs)),
            ended_at: None,
        }
    }

    #[test]
    fn job_transitions_queued_downloading_ready() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        let coord = make_coordinator(tmp.path(), fake.clone());

        let now = Instant::now();
        let cand = candidate("peer1", "Artist\\Album\\01 - Title.flac", 1000);
        let job_id = coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();
        assert_eq!(coord.board.get(&job_id).unwrap().state, JobState::Enqueued { queue_position: None });

        // Coloca o arquivo staged onde a predicao deterministica vai achar.
        let dl_dir = tmp.path().join("downloads").join("Album");
        std::fs::create_dir_all(&dl_dir).unwrap();
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("crates/audio-engine/tests/fixtures/track_01.flac"),
            dl_dir.join("01 - Title.flac"),
        )
        .unwrap();

        // Poll: transfer Succeeded -> Processing -> (locate imediato,
        // degrau 1) -> Indexing -> Ready, tudo dentro de UM poll (sem sleep).
        fake.downloads_script.lock().unwrap().push_back(Ok(vec![transfer_user(
            "peer1",
            "Artist\\Album\\01 - Title.flac",
            "Completed, Succeeded",
            1000,
            1000,
        )]));
        coord.poll_active_transfers_once(now + Duration::from_secs(1));

        let job = coord.board.get(&job_id).unwrap();
        match job.state {
            JobState::Ready { .. } => {}
            other => panic!("esperava Ready, veio {other:?}"),
        }
    }

    #[test]
    fn job_marks_stalled_after_120s() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        let coord = make_coordinator(tmp.path(), fake.clone());
        let t0 = Instant::now();
        let cand = candidate("peer1", "Artist\\Title.flac", 1000);
        let job_id = coord.start_download(&cand, vec![], "Rap & Hip-Hop", t0).unwrap();

        fake.downloads_script.lock().unwrap().push_back(Ok(vec![transfer_user(
            "peer1", "Artist\\Title.flac", "InProgress", 500, 1000,
        )]));
        coord.poll_active_transfers_once(t0 + Duration::from_secs(1));
        assert!(matches!(coord.board.get(&job_id).unwrap().state, JobState::Downloading { .. }));

        // Mesmos bytes, 121s depois -> Stalled.
        fake.downloads_script.lock().unwrap().push_back(Ok(vec![transfer_user(
            "peer1", "Artist\\Title.flac", "InProgress", 500, 1000,
        )]));
        coord.poll_active_transfers_once(t0 + Duration::from_secs(1) + Duration::from_secs(121));
        match coord.board.get(&job_id).unwrap().state {
            JobState::Stalled { since_secs } => assert!(since_secs >= 120),
            other => panic!("esperava Stalled, veio {other:?}"),
        }
    }

    #[test]
    fn job_auto_retries_once_then_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        fake.push_enqueue(Ok(())); // retry re-enfileira
        let coord = make_coordinator(tmp.path(), fake.clone());
        let t0 = Instant::now();

        let alt = candidate("peer2", "Artist\\Title.flac", 1000);
        let cand = candidate("peer1", "Artist\\Title.flac", 1000);
        let job_id = coord.start_download(&cand, vec![alt.clone()], "Rap & Hip-Hop", t0).unwrap();

        // 1a falha: retry automatico, sem passar por Failed.
        fake.downloads_script.lock().unwrap().push_back(Ok(vec![transfer_user(
            "peer1", "Artist\\Title.flac", "Completed, Errored", 0, 1000,
        )]));
        coord.poll_active_transfers_once(t0 + Duration::from_secs(1));
        let job = coord.board.get(&job_id).unwrap();
        assert_eq!(job.username, "peer2", "deveria ter trocado pra fonte alternativa");
        assert!(!matches!(job.state, JobState::Failed { .. }));

        // 2a falha (mesma fonte alternativa, sem mais alternates): Failed visivel.
        fake.downloads_script.lock().unwrap().push_back(Ok(vec![transfer_user(
            "peer2", "Artist\\Title.flac", "Completed, Errored", 0, 1000,
        )]));
        coord.poll_active_transfers_once(t0 + Duration::from_secs(2));
        match coord.board.get(&job_id).unwrap().state {
            JobState::Failed { .. } => {}
            other => panic!("esperava Failed na 2a falha, veio {other:?}"),
        }
    }

    #[test]
    fn max_active_transfers_holds_fourth_in_queued() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        for _ in 0..3 {
            fake.push_enqueue(Ok(()));
        }
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();

        for i in 0..3 {
            let cand = candidate(&format!("peer{i}"), &format!("Artist\\Track{i}.flac"), 1000);
            coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();
        }
        assert_eq!(coord.board.in_flight_count(), 3);

        let fourth = candidate("peer4", "Artist\\Track4.flac", 1000);
        let job_id = coord.start_download(&fourth, vec![], "Rap & Hip-Hop", now).unwrap();
        assert_eq!(coord.board.get(&job_id).unwrap().state, JobState::Queued);
        assert_eq!(fake.enqueue_calls.lock().unwrap().len(), 3, "so os 3 primeiros devem ter chamado enqueue");
    }

    #[test]
    fn promote_queued_after_slot_frees_up() {
        // CR-2: promover um Queued precisa reduzir a contagem de in-flight
        // de verdade — sem isso a fila trava permanentemente acima de
        // MAX_ACTIVE_TRANSFERS.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        for _ in 0..3 {
            fake.push_enqueue(Ok(()));
        }
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();

        let mut job_ids = Vec::new();
        for i in 0..3 {
            let cand = candidate(&format!("peer{i}"), &format!("Artist\\Track{i}.flac"), 1000);
            job_ids.push(coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap());
        }
        for i in 3..6 {
            let cand = candidate(&format!("peer{i}"), &format!("Artist\\Track{i}.flac"), 1000);
            let id = coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();
            assert_eq!(coord.board.get(&id).unwrap().state, JobState::Queued);
        }

        // Termina os 3 em voo -> abre 3 vagas. upsert (nao transition):
        // Downloading->Ready direto nao e uma aresta legal da matriz —
        // aqui so simulamos "terminou por fora" pro setup do teste.
        for id in &job_ids {
            let job = coord.board.get(id).unwrap();
            coord.board.upsert(DownloadJob { state: JobState::Ready { track_id: "1".to_string() }, ..job });
        }
        for _ in 0..3 {
            fake.push_enqueue(Ok(()));
        }
        coord.promote_queued(now);

        assert_eq!(coord.board.in_flight_count(), 3, "os 3 que estavam Queued deveriam ter sido promovidos");
        assert_eq!(fake.enqueue_calls.lock().unwrap().len(), 6);
    }

    #[test]
    fn promote_queued_uses_job_size_not_zero() {
        // IM-7: promote_queued precisa mandar o size REAL, nao 0.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();

        for i in 0..3 {
            coord.board.upsert(DownloadJob {
                job_id: format!("busy{i}"),
                username: format!("busy_peer{i}"),
                remote_filename: format!("Busy{i}.flac"),
                display: "busy".to_string(),
                dest_playlist: "P".to_string(),
                state: JobState::Downloading { pct: 1.0, bps: 1, eta_s: None },
                size: 1,
                alternates: vec![],
                tried_source_ids: vec![],
                created_at: 0,
            });
        }

        let cand = candidate("peer_queued", "Artist\\Track.flac", 987_654);
        let job_id = coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();
        assert_eq!(coord.board.get(&job_id).unwrap().state, JobState::Queued);
        assert!(fake.enqueue_calls.lock().unwrap().is_empty());

        let busy0 = coord.board.get("busy0").unwrap();
        coord.board.upsert(DownloadJob { state: JobState::Ready { track_id: "1".to_string() }, ..busy0 });
        fake.push_enqueue(Ok(()));
        coord.promote_queued(now);

        let calls = fake.enqueue_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0], ("peer_queued".to_string(), "Artist\\Track.flac".to_string(), 987_654));
    }

    #[test]
    fn boot_reconciliation_restores_dest_playlist() {
        let tmp = tempfile::tempdir().unwrap();
        let jobs_path = tmp.path().join("slsk_jobs.json");
        let persisted = vec![PersistedJob {
            job_id: "abc123".to_string(),
            username: "peer1".to_string(),
            remote_filename: "Artist\\Title.flac".to_string(),
            dest_playlist: "Trance".to_string(),
            alternates: vec![],
            created_at: unix_now(),
        }];
        std::fs::write(&jobs_path, serde_json::to_string(&persisted).unwrap()).unwrap();

        let fake = Arc::new(FakeSlskd::new());
        fake.downloads_script.lock().unwrap().push_back(Ok(vec![transfer_user(
            "peer1", "Artist\\Title.flac", "InProgress", 200, 1000,
        )]));

        let cfg = test_cfg(tmp.path());
        let (ingest, _calls) = recording_ingest();
        let owned_provider: Box<dyn Fn() -> Result<OwnedIndex, String> + Send + Sync> =
            Box::new(|| Ok(empty_owned_index()));
        let coord = Coordinator::new(
            cfg,
            fake,
            Arc::new(JobBoard::new()),
            Arc::new(RwLock::new(SearchStore::default())),
            ingest,
            owned_provider,
            jobs_path,
        );

        coord.reconcile_boot(unix_now());
        let job = coord.board.get("abc123").expect("job deveria ter sido restaurado");
        assert_eq!(job.dest_playlist, "Trance");
        assert!(matches!(job.state, JobState::Downloading { .. }));
    }

    #[test]
    fn boot_reconciliation_resumes_staging_for_succeeded_transfer() {
        // IM-8a: um transfer ja Succeeded no boot precisa RETOMAR o
        // staging de verdade, nao so marcar Processing e ficar preso.
        let tmp = tempfile::tempdir().unwrap();
        let jobs_path = tmp.path().join("slsk_jobs.json");
        let persisted = vec![PersistedJob {
            job_id: "resumed1".to_string(),
            username: "peer1".to_string(),
            remote_filename: "Artist\\Album\\01 - Title.flac".to_string(),
            dest_playlist: "Trance".to_string(),
            alternates: vec![],
            created_at: unix_now(),
        }];
        std::fs::write(&jobs_path, serde_json::to_string(&persisted).unwrap()).unwrap();

        let dl_dir = tmp.path().join("downloads").join("Album");
        std::fs::create_dir_all(&dl_dir).unwrap();
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("crates/audio-engine/tests/fixtures/track_01.flac"),
            dl_dir.join("01 - Title.flac"),
        )
        .unwrap();

        let fake = Arc::new(FakeSlskd::new());
        fake.downloads_script.lock().unwrap().push_back(Ok(vec![transfer_user(
            "peer1", "Artist\\Album\\01 - Title.flac", "Completed, Succeeded", 1000, 1000,
        )]));

        let cfg = test_cfg(tmp.path());
        let (ingest, _calls) = recording_ingest();
        let owned_provider: Box<dyn Fn() -> Result<OwnedIndex, String> + Send + Sync> =
            Box::new(|| Ok(empty_owned_index()));
        let coord = Coordinator::new(
            cfg,
            fake,
            Arc::new(JobBoard::new()),
            Arc::new(RwLock::new(SearchStore::default())),
            ingest,
            owned_provider,
            jobs_path,
        );

        coord.reconcile_boot(unix_now());
        let job = coord.board.get("resumed1").expect("job deveria existir");
        match job.state {
            JobState::Ready { .. } => {}
            other => panic!("esperava Ready (staging retomado no boot), veio {other:?}"),
        }
    }

    #[test]
    fn poll_marks_job_failed_when_transfer_missing_past_timeout() {
        // IM-8b: transfer some da lista do slskd -> Failed apos timeout,
        // nao Enqueued pra sempre.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        let coord = make_coordinator(tmp.path(), fake.clone());
        let t0 = Instant::now();
        let cand = candidate("peer1", "Artist\\Title.flac", 1000);
        let job_id = coord.start_download(&cand, vec![], "Rap & Hip-Hop", t0).unwrap();

        // Downloads vazio -> job nao aparece na lista.
        fake.downloads_script.lock().unwrap().push_back(Ok(vec![]));
        coord.poll_active_transfers_once(t0 + Duration::from_secs(1));
        assert!(matches!(coord.board.get(&job_id).unwrap().state, JobState::Enqueued { .. }));

        fake.downloads_script.lock().unwrap().push_back(Ok(vec![]));
        coord.poll_active_transfers_once(t0 + Duration::from_secs(1) + Duration::from_secs(121));
        match coord.board.get(&job_id).unwrap().state {
            JobState::Failed { retryable: true, .. } => {}
            other => panic!("esperava Failed{{retryable:true}}, veio {other:?}"),
        }
    }

    #[test]
    fn poll_fails_in_flight_jobs_when_slskd_unreachable() {
        // IM-10b: slskd cai -> jobs in-flight viram Failed{retryable},
        // nao ficam presos em Downloading indefinidamente.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();
        let cand = candidate("peer1", "Artist\\Title.flac", 1000);
        let job_id = coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();

        fake.downloads_script.lock().unwrap().push_back(Err(SlskdError::Network("offline".to_string())));
        coord.poll_active_transfers_once(now + Duration::from_secs(1));

        match coord.board.get(&job_id).unwrap().state {
            JobState::Failed { retryable: true, .. } => {}
            other => panic!("esperava Failed{{retryable:true}}, veio {other:?}"),
        }
    }

    #[test]
    fn ingest_failure_retries_before_giving_up() {
        // IM-10a: falha de ingest (ex.: Qdrant fora) fica em Indexing
        // retentando, so vira Failed depois de esgotar as tentativas.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        let coord_cfg = test_cfg(tmp.path());

        let fail_count = Arc::new(StdMutex::new(0u32));
        let fail_count_clone = fail_count.clone();
        let ingest: Box<dyn Fn(Vec<PathBuf>) -> Vec<IngestOutcome> + Send + Sync> = Box::new(move |paths| {
            *fail_count_clone.lock().unwrap() += 1;
            paths
                .into_iter()
                .map(|path| IngestOutcome { path, result: Err("qdrant fora".to_string()) })
                .collect()
        });
        let owned_provider: Box<dyn Fn() -> Result<OwnedIndex, String> + Send + Sync> =
            Box::new(|| Ok(empty_owned_index()));
        let coord = Coordinator::new(
            coord_cfg,
            fake.clone(),
            Arc::new(JobBoard::new()),
            Arc::new(RwLock::new(SearchStore::default())),
            ingest,
            owned_provider,
            tmp.path().join("slsk_jobs.json"),
        );

        let now = Instant::now();
        let cand = candidate("peer1", "Artist\\Album\\01 - Title.flac", 1000);
        let job_id = coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();

        let dl_dir = tmp.path().join("downloads").join("Album");
        std::fs::create_dir_all(&dl_dir).unwrap();
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("crates/audio-engine/tests/fixtures/track_01.flac"),
            dl_dir.join("01 - Title.flac"),
        )
        .unwrap();

        fake.downloads_script.lock().unwrap().push_back(Ok(vec![transfer_user(
            "peer1", "Artist\\Album\\01 - Title.flac", "Completed, Succeeded", 1000, 1000,
        )]));
        coord.poll_active_transfers_once(now + Duration::from_secs(1));

        // 1a falha de ingest: continua em Indexing, nao Failed ainda.
        assert!(matches!(coord.board.get(&job_id).unwrap().state, JobState::Indexing));
        assert_eq!(*fail_count.lock().unwrap(), 1);

        // Simula os ticks de retry ate esgotar (INGEST_MAX_RETRIES=5).
        let mut t = now + Duration::from_secs(1);
        for _ in 0..(INGEST_MAX_RETRIES - 1) {
            t += INGEST_RETRY_INTERVAL + Duration::from_secs(1);
            let job = coord.board.get(&job_id).unwrap();
            coord.continue_ingest_retry(&job, t);
        }

        match coord.board.get(&job_id).unwrap().state {
            JobState::Failed { retryable: true, .. } => {}
            other => panic!("esperava Failed apos esgotar retries, veio {other:?}"),
        }
        assert_eq!(*fail_count.lock().unwrap(), INGEST_MAX_RETRIES as u32);
    }

    #[test]
    fn cancel_job_uses_real_transfer_id_not_job_hash() {
        // IM-3: cancel_download precisa usar o id REAL do transfer
        // (ApiTransferFile.id), nao o hash local do job_id.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();
        let cand = candidate("peer1", "Artist\\Title.flac", 1000);
        let job_id = coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();
        assert_ne!(job_id, "real-transfer-guid-123");

        fake.downloads_script.lock().unwrap().push_back(Ok(vec![transfer_user_with_id(
            "peer1", "Artist\\Title.flac", "InProgress", 100, 1000, "real-transfer-guid-123",
        )]));
        coord.cancel_job(&job_id);

        let calls = fake.cancel_download_calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0], ("peer1".to_string(), "real-transfer-guid-123".to_string()));
        assert_eq!(coord.board.get(&job_id).unwrap().state, JobState::Canceled);
    }

    #[test]
    fn try_other_source_switches_and_records_tried() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        fake.push_enqueue(Ok(()));
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();

        let alt = candidate("peer2", "Artist\\Title.flac", 1000);
        let cand = candidate("peer1", "Artist\\Title.flac", 1000);
        let job_id = coord.start_download(&cand, vec![alt], "Rap & Hip-Hop", now).unwrap();

        let result = coord.try_other_source(&job_id, now + Duration::from_secs(1));
        assert!(result.is_ok());
        let job = coord.board.get(&job_id).unwrap();
        assert_eq!(job.username, "peer2");
        assert_eq!(job.tried_source_ids.len(), 1);
        // IM-6: o state precisa refletir a troca (Enqueued da nova fonte),
        // nao ficar clobbereado de volta pro estado da fonte antiga.
        assert!(matches!(job.state, JobState::Enqueued { .. }));
    }

    #[test]
    fn try_other_source_works_from_failed_and_rejected() {
        // CR-3: [Tentar outra fonte]/[Trocar fonte] precisa funcionar
        // exatamente nos estados onde a spec §4.6 o define como acao
        // primaria — failed e rejected, nao so stalled/enqueued.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();

        let alt = candidate("peer2", "Artist\\Title.flac", 1000);
        let cand = candidate("peer1", "Artist\\Title.flac", 1000);
        let job_id = coord.create_or_get_job(&cand, vec![alt], "Rap & Hip-Hop");
        coord.board.upsert(DownloadJob {
            state: JobState::Failed { reason: "x".to_string(), retryable: false },
            ..coord.board.get(&job_id).unwrap()
        });

        let result = coord.try_other_source(&job_id, now);
        assert!(result.is_ok(), "deveria funcionar a partir de Failed: {result:?}");
        assert_eq!(coord.board.get(&job_id).unwrap().username, "peer2");
    }

    #[test]
    fn clear_finished_persists_and_returns_count() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        let coord = make_coordinator(tmp.path(), fake);
        coord.board.upsert(DownloadJob {
            job_id: "j1".to_string(),
            username: "u".to_string(),
            remote_filename: "f".to_string(),
            display: "f".to_string(),
            dest_playlist: "P".to_string(),
            state: JobState::Ready { track_id: "1".to_string() },
            size: 0,
            alternates: vec![],
            tried_source_ids: vec![],
            created_at: 0,
        });
        assert_eq!(coord.clear_finished(), 1);
        assert!(coord.board.snapshot().is_empty());
    }

    #[test]
    fn sweep_deletes_oldest_by_count_after_explicit_sort() {
        // IM-9: ordena EXPLICITAMENTE por started_at (nao assume a ordem
        // que a API devolve) e deleta as mais antigas alem de SWEEP_MAX_KEEP.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());

        // s0 = mais antiga (60s atras), s59 = mais nova (agora). Lista
        // entregue em ordem REVERSA (mais nova primeiro) pra provar que o
        // sweep ordena de verdade em vez de confiar na ordem de entrada.
        let many: Vec<ApiSearch> = (0..60).rev().map(|i| search_entry(&format!("s{i}"), i - 60)).collect();
        fake.list_searches_script.lock().unwrap().push_back(Ok(many));
        let coord = make_coordinator(tmp.path(), fake.clone());

        coord.ensure_swept();
        let mut deleted = fake.delete_search_calls.lock().unwrap().clone();
        deleted.sort();
        let mut expected: Vec<String> = (0..10).map(|i| format!("s{i}")).collect();
        expected.sort();
        assert_eq!(deleted, expected, "deveria deletar as 10 mais antigas (s0..s9)");

        // Idempotente: 2a chamada na mesma sessao nao varre de novo.
        coord.ensure_swept();
        assert_eq!(fake.delete_search_calls.lock().unwrap().len(), 10);
    }

    #[test]
    fn sweep_deletes_by_age_even_under_count_limit() {
        // IM-9: criterio de idade (>1h) funciona mesmo com poucas buscas
        // (bem abaixo de SWEEP_MAX_KEEP=50) — a premissa do report antigo
        // ("wire nao tem timestamp") era falsa, a API real devolve
        // startedAt/endedAt.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        let entries = vec![
            search_entry("old", -2 * 3600),
            search_entry("fresh", -5),
        ];
        fake.list_searches_script.lock().unwrap().push_back(Ok(entries));
        let coord = make_coordinator(tmp.path(), fake.clone());

        coord.ensure_swept();
        let deleted = fake.delete_search_calls.lock().unwrap().clone();
        assert_eq!(deleted, vec!["old".to_string()]);
    }

    #[test]
    fn handle_search_replies_before_network_io() {
        // CR-1: o reply chega SEM esperar ensure_swept/start_search (I/O
        // de rede). Prova por concorrencia real: list_searches (chamada
        // por ensure_swept) fica bloqueado num rendezvous ate o teste
        // liberar; a thread principal so precisa do reply, nao do retorno
        // de handle_search inteiro.
        struct BlockingApi {
            gate_rx: StdMutex<crossbeam_channel::Receiver<()>>,
        }
        impl SlskdApi for BlockingApi {
            fn status(&self) -> Result<ServerStatus, SlskdError> {
                Ok(ServerStatus::default())
            }
            fn start_search(&self, _text: &str) -> Result<String, SlskdError> {
                Ok("remote-1".to_string())
            }
            fn search_state(&self, _id: &str) -> Result<ApiSearch, SlskdError> {
                Ok(ApiSearch::default())
            }
            fn search_responses(&self, _id: &str) -> Result<Vec<ApiSearchResponse>, SlskdError> {
                Ok(Vec::new())
            }
            fn delete_search(&self, _id: &str) -> Result<(), SlskdError> {
                Ok(())
            }
            fn list_searches(&self) -> Result<Vec<ApiSearch>, SlskdError> {
                let _ = self.gate_rx.lock().unwrap().recv();
                Ok(Vec::new())
            }
            fn enqueue(&self, _u: &str, _f: &str, _s: u64) -> Result<(), SlskdError> {
                Ok(())
            }
            fn downloads(&self) -> Result<Vec<ApiTransferUser>, SlskdError> {
                Ok(Vec::new())
            }
            fn cancel_download(&self, _u: &str, _id: &str) -> Result<(), SlskdError> {
                Ok(())
            }
        }

        let tmp = tempfile::tempdir().unwrap();
        let (gate_tx, gate_rx) = crossbeam_channel::bounded::<()>(0);
        let api: Arc<dyn SlskdApi> = Arc::new(BlockingApi { gate_rx: StdMutex::new(gate_rx) });
        let coord = Arc::new(make_coordinator(tmp.path(), api));

        let (reply_tx, reply_rx) = crossbeam_channel::bounded(1);
        let coord2 = coord.clone();
        let handle = std::thread::spawn(move || {
            coord2.handle_search("query".to_string(), false, Instant::now(), reply_tx);
        });

        let reply = reply_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("reply deveria chegar sem esperar list_searches (ensure_swept) desbloquear");
        assert!(reply.is_ok());

        gate_tx.send(()).unwrap();
        handle.join().unwrap();
    }

    #[test]
    fn search_query_is_stored_and_used_in_ranking() {
        // IM-4: a query digitada precisa ser guardada e usada no
        // aggregate — antes ia sempre "", zerando derank de live/remix e
        // similaridade de titulo.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.start_search_script.lock().unwrap().push_back(Ok("remote-1".to_string()));
        fake.search_responses_script.lock().unwrap().push_back(Ok(vec![ApiSearchResponse {
            username: "peer1".to_string(),
            file_count: 1,
            files: vec![slskd_client::wire::ApiFile {
                filename: "Artist - Title (Live).flac".to_string(),
                size: 30_000_000,
                extension: "flac".to_string(),
                bit_depth: Some(16),
                sample_rate: Some(44_100),
                length: Some(200),
                is_locked: false,
            }],
            has_free_upload_slot: true,
            locked_file_count: 0,
            queue_length: 0,
            upload_speed: 100_000,
        }]));
        let coord = make_coordinator(tmp.path(), fake.clone());

        let (reply_tx, reply_rx) = crossbeam_channel::bounded(1);
        let now = Instant::now();
        coord.handle_search("artist title live".to_string(), false, now, reply_tx);
        let search_id = reply_rx.recv().unwrap().unwrap();

        coord.poll_active_search_once(now);
        let snapshot = coord.searches.read().unwrap().snapshot(&search_id).unwrap();
        assert_eq!(snapshot.groups.len(), 1);
        // A query pedia "live" explicitamente -> NAO deveria levar o
        // warn de derank (prova que rank::aggregate recebeu a query real,
        // nao "").
        assert_ne!(snapshot.groups[0].best.warn.as_deref(), Some("parece live"));
    }

    #[test]
    fn handle_search_deletes_previous_active_search_on_replacement() {
        // IM-5: uma busca nova precisa deletar a anterior em voo no
        // slskd, nao so no fim da janela de 25s.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.start_search_script.lock().unwrap().push_back(Ok("remote-old".to_string()));
        fake.start_search_script.lock().unwrap().push_back(Ok("remote-new".to_string()));
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();

        let (r1_tx, r1_rx) = crossbeam_channel::bounded(1);
        coord.handle_search("primeira".to_string(), false, now, r1_tx);
        r1_rx.recv().unwrap().unwrap();

        let (r2_tx, r2_rx) = crossbeam_channel::bounded(1);
        coord.handle_search("segunda".to_string(), true, now + Duration::from_secs(5), r2_tx);
        r2_rx.recv().unwrap().unwrap();

        let deleted = fake.delete_search_calls.lock().unwrap().clone();
        assert!(deleted.contains(&"remote-old".to_string()), "busca anterior deveria ter sido deletada ao trocar");
    }
}
