//! coordinator.rs — thread única (`slsk-coord`): busca, transfers, staging,
//! reconciliação (spec §3.4, §5.6, §6). Escritor único do `JobBoard` e do
//! `SearchStore` — nenhum outro lugar do app muta esses dois.
//!
//! Testabilidade: a lógica de decisão vive em métodos de [`Coordinator`]
//! que recebem `now: Instant` explícito (mesmo padrão de `pacing.rs`) — os
//! testes chamam esses métodos direto, sem thread real nem `sleep`.
//! `spawn_coordinator` é a casca fina que roda isso de verdade num loop
//! com timeouts computados.

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

use super::board::{Candidate, DownloadJob, JobBoard, JobState};
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
const EMIT_THROTTLE: Duration = Duration::from_millis(500);
const OWNED_INDEX_TTL: Duration = Duration::from_secs(60);
const LOCATE_RETRY_WINDOW: Duration = Duration::from_secs(30);
const LOCATE_RETRY_INTERVAL: Duration = Duration::from_millis(500);
const TERMINAL_PRUNE_AGE_SECS: i64 = 7 * 24 * 60 * 60;
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

/// Estado do coordinator. `new()` é `pub(super)` — só `spawn_coordinator`
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
    /// documentada — ver `docs/.../etapa-C-report.md`.
    enqueued_since: Mutex<HashMap<String, Instant>>,
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
                // OwnedIndex válido. Isso bloqueia staging até o Qdrant
                // voltar — comportamento correto (nunca mover pra dentro
                // de ~/Music sem checar dedup), mas o chamador precisa
                // tratar. Como `stage_file` exige `&OwnedIndex` sem
                // Option, propagamos via panic controlado no chamador
                // (process_ready_transfer trata isso ANTES de chegar aqui
                // checando o Result da invalidação, ver invalidate_owned).
                panic!("slsk-coord: OwnedIndex indisponível (Qdrant fora do ar) e sem cache anterior")
            }
        }
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
    /// podadas. Nunca panica com arquivo ausente/malformado.
    fn reconcile_boot(&self, now_unix: i64) {
        let persisted = self.load_persisted_jobs();
        let downloads = self.api.downloads().unwrap_or_default();

        for pj in persisted {
            if now_unix - pj.created_at > TERMINAL_PRUNE_AGE_SECS {
                continue;
            }
            let state = match find_transfer(&downloads, &pj.username, &pj.remote_filename) {
                Some(file) => job_state_from_outcome(
                    classify_transfer_state(&file.state),
                    file.percent_complete as f32,
                    file.average_speed as u64,
                    file.size,
                    file.bytes_transferred,
                ),
                // Sem rastro no slskd: ou terminou faz tempo (Ready já foi
                // processado e removido daqui, não recriamos), ou o
                // download morreu junto com o slskd. Marca Manual — nunca
                // perde o rastro do arquivo (spec R2/M1), o usuário decide.
                None => JobState::Manual {
                    path: self.cfg.downloads_dir.display().to_string(),
                    why: "sem rastro no slskd apos reiniciar — verifique downloads manualmente".to_string(),
                },
            };
            self.board.upsert(DownloadJob {
                job_id: pj.job_id,
                username: pj.username,
                remote_filename: pj.remote_filename.clone(),
                display: pj.remote_filename,
                dest_playlist: pj.dest_playlist,
                state,
                alternates: pj.alternates,
                tried_source_ids: Vec::new(),
                created_at: pj.created_at,
            });
        }
        self.board.retain_recent_terminals(JOBS_RETAINED);
        stage::clean_orphan_incoming(&self.cfg.music_root, &self.board.active_ids());
    }

    // ── Busca (spec §3.4, §6.1-§6.3) ───────────────────────────────────

    /// Primeiro uso da sessão: varre `list_searches()` e deleta tudo além
    /// das `SWEEP_MAX_KEEP` mais recentes. Idempotente — só roda uma vez
    /// por vida do coordinator (`swept_once`). A API não devolve timestamp
    /// em `ApiSearch` (wire.rs, Etapa A) — o critério de ">1h" do §6.3 não
    /// é verificável com o schema atual; mantemos só o corte por
    /// quantidade, documentado aqui e no report da etapa.
    fn ensure_swept(&self) {
        if self.swept_once.swap(true, Ordering::SeqCst) {
            return;
        }
        let all = match self.api.list_searches() {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(?e, "slsk-coord: sweep inicial falhou ao listar buscas");
                return;
            }
        };
        if all.len() <= SWEEP_MAX_KEEP {
            return;
        }
        let stale = &all[..all.len() - SWEEP_MAX_KEEP];
        tracing::info!(count = stale.len(), "slsk-coord: sweep de buscas acumuladas");
        for s in stale {
            let _ = self.api.delete_search(&s.id);
        }
    }

    /// Handler de `SlskTask::Search`. Responde no ATO (pacer é só memória,
    /// sem I/O) — o `start_search` de rede acontece DEPOIS de já ter
    /// respondido, aqui mesmo na thread do coordinator (fire-and-forget do
    /// ponto de vista do comando, spec E2).
    fn handle_search(&self, query: String, force: bool, now: Instant) -> Result<String, String> {
        self.ensure_swept();

        let decision = self.lock_pacer().check(now, force);
        let outcome = match decision {
            PaceDecision::Go => Ok(()),
            PaceDecision::Cooldown(s) => Err(format!("cooldown:{s}")),
            PaceDecision::Cold(s) => Err(format!("cold:{s}")),
            PaceDecision::HourlyCapped => Err("busy".to_string()),
        };
        outcome?;
        self.lock_pacer().record_search(now);

        let local_id = format!("s{}", self.search_seq.fetch_add(1, Ordering::SeqCst));
        {
            let mut store = self.searches.write().unwrap_or_else(|p| p.into_inner());
            store.entries.insert(
                local_id.clone(),
                StoredSearch {
                    remote_id: None,
                    snapshot: SearchSnapshot::default(),
                    raw_groups: HashMap::new(),
                },
            );
        }

        match self.api.start_search(&query) {
            Ok(remote_id) => {
                let mut store = self.searches.write().unwrap_or_else(|p| p.into_inner());
                if let Some(entry) = store.entries.get_mut(&local_id) {
                    entry.remote_id = Some(remote_id.clone());
                }
                drop(store);
                *self.active_search.lock().unwrap_or_else(|p| p.into_inner()) = Some(ActiveSearch {
                    local_id: local_id.clone(),
                    remote_id,
                    started_at: now,
                    next_poll_at: now,
                });
                Ok(local_id)
            }
            Err(e) => {
                let mut store = self.searches.write().unwrap_or_else(|p| p.into_inner());
                if let Some(entry) = store.entries.get_mut(&local_id) {
                    entry.snapshot.state = SearchState::Failed;
                    entry.snapshot.note = Some(e.to_string());
                }
                Ok(local_id)
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
        let query = self
            .searches
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .entries
            .get(&local_id)
            .map(|_| String::new())
            .unwrap_or_default();
        let ranked = slskd_client::rank::aggregate(&responses, &query);

        let owned = self.owned_index_provider_safe();
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

    fn owned_index_provider_safe(&self) -> Option<Arc<OwnedIndex>> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.owned_index())).ok()
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

    // ── Download: criação de job (spec §3.4, §5.1, §4.5) ───────────────

    /// Núcleo de `SlskTask::Download`, já com o candidato resolvido —
    /// separado da resolução via `SearchStore` pra ficar testável sem
    /// precisar montar uma busca fake inteira.
    fn start_download(
        &self,
        candidate: &slskd_client::rank::Candidate,
        alternates: Vec<slskd_client::rank::Candidate>,
        dest_playlist: &str,
        now: Instant,
    ) -> Result<String, String> {
        let job_id = super::board::job_id(&candidate.username, &candidate.filename);
        if self.board.contains(&job_id) {
            // Idempotente: mesmo arquivo do mesmo peer já enfileirado.
            return Ok(job_id);
        }

        let display = slskd_client::rank::guess_artist_title(&candidate.filename)
            .map(|(a, t)| format!("{a} - {t}"))
            .unwrap_or_else(|| slskd_client::rank::remote_basename(&candidate.filename).to_string());

        let job = DownloadJob {
            job_id: job_id.clone(),
            username: candidate.username.clone(),
            remote_filename: candidate.filename.clone(),
            display,
            dest_playlist: dest_playlist.to_string(),
            state: JobState::Queued,
            alternates: alternates.iter().map(Candidate::from).collect(),
            tried_source_ids: Vec::new(),
            created_at: unix_now(),
        };
        self.board.upsert(job);
        self.mark_dirty();

        if self.board.active_count() > MAX_ACTIVE_TRANSFERS {
            // Ficou em Queued mesmo (capacidade estourada) — o próximo
            // ciclo de poll promove quando uma vaga abrir.
            return Ok(job_id);
        }

        self.enqueue_job(&job_id, &candidate.username, &candidate.filename, candidate.size, now);
        Ok(job_id)
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

    fn handle_task_download(
        &self,
        search_id: &str,
        group_key: &str,
        source_id: &str,
        dest: &str,
        now: Instant,
    ) -> Result<String, String> {
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
        drop(store);
        self.start_download(&candidate, alternates, dest, now)
    }

    /// `[Trocar fonte]` — pega a próxima alternativa NÃO tentada ainda
    /// (`tried_source_ids`), reenfileira sob o MESMO `job_id` (a linha na
    /// UI não muda). `enqueue`, não `search` — não alimenta o pacer de
    /// busca (spec §5.6).
    fn try_other_source(&self, job_id: &str, now: Instant) -> Result<String, String> {
        let job = self.board.get(job_id).ok_or_else(|| "job nao encontrado".to_string())?;
        let next = job
            .alternates
            .iter()
            .find(|c| !job.tried_source_ids.contains(&c.id))
            .cloned()
            .ok_or_else(|| "sem outras fontes disponiveis".to_string())?;

        if !self.board.transition(job_id, JobState::Queued) {
            return Err("job em estado que nao aceita troca de fonte agora".to_string());
        }
        let mut tried = job.tried_source_ids.clone();
        tried.push(next.id.clone());
        self.board.upsert(DownloadJob {
            username: next.username.clone(),
            remote_filename: next.filename.clone(),
            tried_source_ids: tried,
            ..job
        });
        self.enqueue_job(job_id, &next.username, &next.filename, next.size, now);
        Ok(job_id.to_string())
    }

    fn cancel_job(&self, job_id: &str) {
        if self.board.transition(job_id, JobState::Canceled) {
            let job = self.board.get(job_id);
            if let Some(j) = job {
                let _ = self.api.cancel_download(&j.username, job_id);
            }
            self.mark_dirty();
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
    /// fabricado.
    fn poll_active_transfers_once(&self, now: Instant) {
        let active_ids = self.board.active_ids();
        if active_ids.is_empty() {
            return;
        }
        let downloads = match self.api.downloads() {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(?e, "slsk-coord: poll de transfers falhou");
                return;
            }
        };

        for job_id in active_ids {
            let Some(job) = self.board.get(&job_id) else { continue };
            match &job.state {
                JobState::Enqueued { .. } | JobState::Downloading { .. } | JobState::Stalled { .. } => {
                    self.poll_one_transfer(&job, &downloads, now);
                }
                _ => {}
            }
        }

        // Promove fila: se abriu vaga (jobs Queued esperando capacidade).
        self.promote_queued(now);
    }

    fn promote_queued(&self, now: Instant) {
        while self.board.active_count() < MAX_ACTIVE_TRANSFERS {
            let queued = self
                .board
                .snapshot()
                .into_iter()
                .find(|j| j.state == JobState::Queued);
            let Some(job) = queued else { break };
            self.enqueue_job(&job.job_id, &job.username, &job.remote_filename, 0, now);
        }
    }

    fn poll_one_transfer(&self, job: &DownloadJob, downloads: &[ApiTransferUser], now: Instant) {
        let Some(file) = find_transfer(downloads, &job.username, &job.remote_filename) else {
            return;
        };
        let outcome = classify_transfer_state(&file.state);
        match outcome {
            TransferOutcome::Succeeded => {
                self.stall_bytes.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);
                self.enqueued_since.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);
                self.process_succeeded_transfer(job, now);
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
                self.check_bytes_stall(job, file.bytes_transferred, file.percent_complete as f32, file.average_speed as u64, file.size, now);
            }
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
            self.board.transition(
                &job.job_id,
                JobState::Downloading { pct, bps, eta_s },
            );
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
    /// `Failed` visível.
    fn handle_transfer_failure(&self, job: &DownloadJob, raw_state: &str, now: Instant) {
        self.stall_bytes.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);
        self.enqueued_since.lock().unwrap_or_else(|p| p.into_inner()).remove(&job.job_id);

        let already_retried = job.tried_source_ids.len() >= 1;
        let next = job
            .alternates
            .iter()
            .find(|c| !job.tried_source_ids.contains(&c.id))
            .cloned();

        match (already_retried, next) {
            (false, Some(alt)) => {
                self.board.transition(&job.job_id, JobState::Queued);
                let mut tried = job.tried_source_ids.clone();
                tried.push(alt.id.clone());
                self.board.upsert(DownloadJob {
                    username: alt.username.clone(),
                    remote_filename: alt.filename.clone(),
                    tried_source_ids: tried,
                    ..job.clone()
                });
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

    /// `Succeeded`: localiza (retenta até `LOCATE_RETRY_WINDOW`), valida,
    /// move, indexa. `Processing`/`Indexing` são estados de transição
    /// rápidos — este método faz tudo em UMA chamada (o coordinator é
    /// single-thread; um download grande já levou minutos, mais uns
    /// segundos de move+parse não muda a UX).
    fn process_succeeded_transfer(&self, job: &DownloadJob, now: Instant) {
        self.board.transition(&job.job_id, JobState::Processing);
        self.mark_dirty();

        let started_at = SystemTime::now() - Duration::from_secs(3600); // ver nota abaixo
        let local = self.locate_with_retry(&job.remote_filename, started_at);
        let Some(local) = local else {
            self.board.transition(
                &job.job_id,
                JobState::Manual {
                    path: self.cfg.downloads_dir.display().to_string(),
                    why: "baixou, mas nao achei o arquivo em downloads_dir".to_string(),
                },
            );
            self.mark_dirty();
            return;
        };

        let owned = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.owned_index())) {
            Ok(idx) => idx,
            Err(_) => {
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

        match stage::stage_file(&self.cfg.music_root, &job.dest_playlist, &local, &owned) {
            Ok(stage::StageOutcome::Staged { final_path }) => {
                self.board.transition(&job.job_id, JobState::Indexing);
                self.mark_dirty();
                let outcomes = (self.ingest)(vec![final_path.clone()]);
                self.invalidate_owned();
                match outcomes.into_iter().find(|o| o.path == final_path) {
                    Some(IngestOutcome { result: Ok(track_id), .. }) => {
                        self.board.transition(
                            &job.job_id,
                            JobState::Ready { track_id: track_id.to_string() },
                        );
                    }
                    Some(IngestOutcome { result: Err(e), .. }) => {
                        self.board.transition(
                            &job.job_id,
                            JobState::Failed { reason: e, retryable: true },
                        );
                    }
                    None => {
                        self.board.transition(
                            &job.job_id,
                            JobState::Failed {
                                reason: "ingest nao retornou outcome para o path staged".to_string(),
                                retryable: true,
                            },
                        );
                    }
                }
            }
            Ok(stage::StageOutcome::Rejected(reason)) => {
                let reason_label = format!("{reason:?}");
                let _ = stage::quarantine(&self.cfg.music_root, &local, &reason_label);
                self.board.transition(&job.job_id, JobState::Rejected { reason });
            }
            Err(e) => {
                self.board.transition(
                    &job.job_id,
                    JobState::Failed { reason: e, retryable: true },
                );
            }
        }
        self.mark_dirty();
        let _ = now;
    }

    /// Cascata de localização com retry (spec §5.2): tenta imediatamente,
    /// e se não achar, retenta a cada `LOCATE_RETRY_INTERVAL` até
    /// `LOCATE_RETRY_WINDOW`. Em teste isso bloquearia por até 30s de
    /// verdade — os testes deste módulo evitam esse caminho colocando o
    /// arquivo no lugar ANTES de chamar `process_succeeded_transfer`
    /// (degrau 1 acha na primeira tentativa, sem retry).
    fn locate_with_retry(&self, remote_filename: &str, started_at: SystemTime) -> Option<PathBuf> {
        let deadline = Instant::now() + LOCATE_RETRY_WINDOW;
        loop {
            if let Some(p) = stage::locate_downloaded(&self.cfg.downloads_dir, remote_filename, started_at) {
                return Some(p);
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(LOCATE_RETRY_INTERVAL);
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
            SlskTask::Search { query, force, reply } => {
                let _ = reply.send(self.handle_search(query, force, now));
            }
            SlskTask::Download { search_id, group_key, source_id, dest, reply } => {
                let _ = reply.send(self.handle_task_download(&search_id, &group_key, &source_id, &dest, now));
            }
            SlskTask::TryOtherSource { job_id, reply } => {
                let _ = reply.send(self.try_other_source(&job_id, now));
            }
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
    use slskd_client::wire::{ApiTransferDir, ApiTransferFile, ApiTransferUser};
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

    fn make_coordinator(
        tmp: &Path,
        api: Arc<dyn SlskdApi>,
    ) -> Coordinator {
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

    fn transfer_user(username: &str, filename: &str, state: &str, bytes: u64, size: u64) -> ApiTransferUser {
        ApiTransferUser {
            username: username.to_string(),
            directories: vec![ApiTransferDir {
                directory: String::new(),
                files: vec![ApiTransferFile {
                    id: "t1".to_string(),
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

        // Poll: transfer Succeeded -> Processing -> Indexing -> Ready.
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
        assert_eq!(coord.board.active_count(), 3);

        let fourth = candidate("peer4", "Artist\\Track4.flac", 1000);
        let job_id = coord.start_download(&fourth, vec![], "Rap & Hip-Hop", now).unwrap();
        assert_eq!(coord.board.get(&job_id).unwrap().state, JobState::Queued);
        assert_eq!(fake.enqueue_calls.lock().unwrap().len(), 3, "so os 3 primeiros devem ter chamado enqueue");
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
    fn sweep_deletes_stale_searches_on_first_use() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        let many: Vec<slskd_client::wire::ApiSearch> = (0..60)
            .map(|i| slskd_client::wire::ApiSearch {
                id: format!("s{i}"),
                search_text: "x".to_string(),
                state: "Completed".to_string(),
                response_count: 0,
                file_count: 0,
                is_complete: true,
            })
            .collect();
        fake.list_searches_script.lock().unwrap().push_back(Ok(many));
        let coord = make_coordinator(tmp.path(), fake.clone());

        coord.ensure_swept();
        let deleted = fake.delete_search_calls.lock().unwrap().clone();
        assert_eq!(deleted.len(), 10, "60 buscas - 50 retidas = 10 deletadas");
        assert_eq!(deleted, (0..10).map(|i| format!("s{i}")).collect::<Vec<_>>());

        // Idempotente: 2a chamada na mesma sessao nao varre de novo.
        coord.ensure_swept();
        assert_eq!(fake.delete_search_calls.lock().unwrap().len(), 10);
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
            alternates: vec![],
            tried_source_ids: vec![],
            created_at: 0,
        });
        assert_eq!(coord.clear_finished(), 1);
        assert!(coord.board.snapshot().is_empty());
    }
}
