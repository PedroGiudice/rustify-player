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
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

use crossbeam_channel::{Receiver, Sender};
use library_indexer::lyrics_fetch::{spawn_lyrics_worker, Lrclib, LyricsJob};
use library_indexer::{IndexerHandle, IngestOutcome, OwnedIndex};
use serde::{Deserialize, Serialize};
use slskd_client::pacing::{PaceDecision, Pacer};
use slskd_client::wire::ApiTransferUser;
use slskd_client::{SearchGuard, SlskdApi};
use tauri::{AppHandle, Emitter};

use super::board::{
    can_transition, unix_now, Candidate, ConfirmedMeta, DownloadJob, FormatIn, JobBoard, JobState, RejectReason,
    Source, WaitReason,
};
use super::config::SlskConfig;
use super::stage;

// ── Constantes (spec §3.4 + §6) ────────────────────────────────────────
const SEARCH_WINDOW: Duration = Duration::from_secs(25);
const SEARCH_POLL: Duration = Duration::from_millis(700);
const POLL_ACTIVE: Duration = Duration::from_millis(1_000);
const POLL_IDLE: Duration = Duration::from_secs(5);
const STALL_BYTES_SECS: u64 = 120;
const STALL_ENQUEUED_SECS: u64 = 300;
const JOBS_RETAINED: usize = 50;
const SWEEP_MAX_KEEP: usize = 50;
const SWEEP_MAX_AGE_SECS: i64 = 60 * 60;
const EMIT_THROTTLE: Duration = Duration::from_millis(500);
const OWNED_INDEX_TTL: Duration = Duration::from_secs(60);
const LOCATE_RETRY_WINDOW: Duration = Duration::from_secs(30);
const TERMINAL_PRUNE_AGE_SECS: i64 = 7 * 24 * 60 * 60;
const MISSING_TRANSFER_TIMEOUT_SECS: u64 = 120;
/// Falhas consecutivas de `api.downloads()` antes de declarar "slskd
/// fora do ar" (review NB-2) — mesmo espírito de `EMPTY_STREAK_TRIP` do
/// `Pacer` (slskd-client/pacing.rs): um blip isolado não é queda.
const DOWNLOADS_FAIL_THRESHOLD: u32 = 3;
const INGEST_MAX_RETRIES: u8 = 5;
const INGEST_RETRY_INTERVAL: Duration = Duration::from_secs(30);
const JOBS_FILE_NAME: &str = "slsk_jobs.json";

/// Tetos de transferências simultâneas POR ORIGEM (spec §2.4): uma fonte
/// não ocupa vaga da outra.
pub const MAX_ACTIVE_SOULSEEK: usize = 3;
pub const MAX_ACTIVE_SOUNDCLOUD: usize = 2;
pub const MAX_ACTIVE_BANDCAMP: usize = 1;

/// Origens servidas por worker próprio (tudo menos o Soulseek, que fala
/// direto com o slskd).
const EXTERNAL_KINDS: [&str; 2] = ["sound_cloud", "bandcamp"];

fn max_active_for(kind: &str) -> usize {
    match kind {
        "soulseek" => MAX_ACTIVE_SOULSEEK,
        "sound_cloud" => MAX_ACTIVE_SOUNDCLOUD,
        _ => MAX_ACTIVE_BANDCAMP,
    }
}

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
    /// Download de fonte externa (SoundCloud, Bandcamp) com o metadado que o
    /// CEO confirmou no card. Responde o `job_id` sem I/O; o trabalho pesado
    /// é do worker da fonte.
    DownloadExternal {
        source: Source,
        meta: ConfirmedMeta,
        /// Capa da faixa na fonte (vem do card); ver `DownloadJob::artwork_url`.
        artwork_url: Option<String>,
        dest: String,
        reply: Sender<Result<String, String>>,
    },
}

/// Enviado ao worker de uma fonte externa (spec §2.4).
#[derive(Debug, Clone)]
pub struct FetchTask {
    pub job_id: String,
    /// Tentativa do job (ver `DownloadJob::attempt`): o worker a devolve em
    /// todo `FetchEvent` e a passa a `JobBoard::is_canceled`.
    pub attempt: u32,
    pub source: Source,
    pub meta: ConfirmedMeta,
    /// Capa da faixa na fonte, copiada de `DownloadJob::artwork_url`.
    pub artwork_url: Option<String>,
    pub playlist: String,
    /// `<music_root>/.rustify-incoming` — o worker grava
    /// `<file_stem>.<ext>` e `<file_stem>.flac` aqui (ver [`Self::file_stem`]).
    pub incoming_dir: PathBuf,
}

impl FetchTask {
    /// Nome-base dos arquivos desta tentativa no incoming:
    /// `<job_id>.a<attempt>`. Duas tentativas do mesmo job nunca dividem
    /// arquivo, então descartar o resultado de uma tentativa velha não apaga
    /// o da nova. O boot apaga esses arquivos como órfãos
    /// (`clean_orphan_incoming` só poupa `<job_id>.flac`), o que é o certo:
    /// job externo em voo recomeça do zero no boot.
    pub fn file_stem(&self) -> String {
        format!("{}.a{}", self.job_id, self.attempt)
    }
}

/// Devolvido pelo worker; o coordinator drena a cada tick e aplica no board.
#[derive(Debug, Clone)]
/// Todo evento carrega a tentativa do `FetchTask` que o gerou.
pub enum FetchEvent {
    Started { job_id: String, attempt: u32 },
    Progress { job_id: String, attempt: u32, pct: f32, bps: u64, eta_s: Option<u32> },
    Done { job_id: String, attempt: u32, flac_path: PathBuf, format_in: FormatIn },
    /// `quarantine`: arquivo baixado que o worker não apagou e que o
    /// coordinator move para `.rustify-quarentena` (`None` = nada a guardar).
    Rejected { job_id: String, attempt: u32, reason: RejectReason, quarantine: Option<PathBuf> },
    Failed { job_id: String, attempt: u32, reason: String, retryable: bool },
}

impl FetchEvent {
    fn key(&self) -> (&str, u32) {
        match self {
            FetchEvent::Started { job_id, attempt }
            | FetchEvent::Progress { job_id, attempt, .. }
            | FetchEvent::Done { job_id, attempt, .. }
            | FetchEvent::Rejected { job_id, attempt, .. }
            | FetchEvent::Failed { job_id, attempt, .. } => (job_id.as_str(), *attempt),
        }
    }
}

/// Ligação do coordinator com os workers das fontes externas: um `Sender`
/// por origem (`Source::kind`) e um canal de volta único, compartilhado.
pub struct FetchWiring {
    pub workers: Vec<(&'static str, Sender<FetchTask>)>,
    pub events: Receiver<FetchEvent>,
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
    /// `default` = arquivo gravado antes de existir origem por job: o
    /// `load_persisted_jobs` reconstrói a variante Soulseek a partir de
    /// `username`/`remote_filename` soltos.
    #[serde(default = "legacy_source_placeholder")]
    source: Source,
    /// Compatibilidade com o `slsk_jobs.json` anterior (campos soltos).
    /// `save_jobs` grava os valores reais nos jobs Soulseek (escrita dupla):
    /// num rollback, o app antigo continua achando o transfer no slskd.
    #[serde(default)]
    username: String,
    #[serde(default)]
    remote_filename: String,
    #[serde(default)]
    meta: ConfirmedMeta,
    /// `default` = arquivo anterior ao campo: o job volta sem capa.
    #[serde(default)]
    artwork_url: Option<String>,
    #[serde(default = "one")]
    tracks: u16,
    dest_playlist: String,
    #[serde(default)]
    alternates: Vec<Candidate>,
    /// `default` = arquivo gravado antes do campo existir — job volta com
    /// rótulo vazio e o frontend cai no tamanho.
    #[serde(default)]
    quality_label: String,
    /// Único estado persistido: `Waiting` volta como está no boot (spec
    /// §2.3); os demais são reconstruídos pela reconciliação.
    #[serde(default)]
    waiting: Option<(WaitReason, String)>,
    /// Instante (unix) em que o job entrou em `Waiting`, lido da âncora do
    /// board (`JobBoard::waiting_since_unix`), nunca derivado do
    /// `since_secs`: a idade da espera (teto de 24 h da compra, spec §6.2)
    /// não recomeça a cada gravação nem a cada reinício.
    #[serde(default)]
    waiting_since_unix: Option<i64>,
    /// Formato de origem já detectado (rótulo WAV/MP3 320 na fila). Só
    /// importa para job que volta em `Indexing`; os outros baixam de novo.
    #[serde(default)]
    format_in: Option<FormatIn>,
    /// Arquivo já colocado em `~/Music` de um job em `Indexing`: o boot
    /// retoma o ingest dele em vez de baixar de novo.
    #[serde(default)]
    indexing_path: Option<PathBuf>,
    #[serde(default)]
    attempt: u32,
    created_at: i64,
}

fn one() -> u16 {
    1
}

fn legacy_source_placeholder() -> Source {
    Source::Soulseek { username: String::new(), remote_filename: String::new(), size: 0 }
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

/// Nome da subpasta/motivo de quarentena para um `RejectReason`.
fn reject_slug(reason: &RejectReason) -> &'static str {
    match reason {
        RejectReason::AlreadyOwned { .. } => "already_owned",
        RejectReason::Bit32Unsupported => "bit32_unsupported",
        RejectReason::NotFlac => "not_flac",
        RejectReason::Corrupt => "corrupt",
        RejectReason::LowBitrate { .. } => "low_bitrate",
        RejectReason::NoDownload => "no_download",
    }
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
    /// Falhas CONSECUTIVAS de `api.downloads()` — só declara "slskd fora"
    /// depois de `DOWNLOADS_FAIL_THRESHOLD` seguidas (review NB-2: um
    /// único 500/timeout sob carga não é "caiu", e derrubava jobs em
    /// `Processing`/`Indexing` que nem dependem mais do slskd). Zera em
    /// qualquer sucesso.
    downloads_fail_streak: AtomicU32,
    jobs_path: PathBuf,
    /// Canal pro worker `slsk-lyrics` (Etapa E): o coordinator só faz
    /// `try_send` após ingest OK — fila cheia descarta (letra é
    /// enriquecimento best-effort, nunca backpressure no pipeline).
    /// `None` nos testes que não exercitam letras.
    lyrics_tx: Option<Sender<LyricsJob>>,
    /// Canais dos workers das fontes externas (spec §2.4): `FetchTask` sai
    /// por `try_send` (bounded), `FetchEvent` volta e é drenado a cada tick.
    /// Um worker por origem (`Source::kind`); origem sem worker vira
    /// `Failed{"fonte ainda não suportada"}`.
    fetch_workers: HashMap<&'static str, Sender<FetchTask>>,
    fetch_rx: Option<Receiver<FetchEvent>>,
    /// Próxima tentativa (`DownloadJob::attempt`). Monotônico na sessão;
    /// o boot o avança além das tentativas persistidas.
    attempt_seq: AtomicU32,
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
            downloads_fail_streak: AtomicU32::new(0),
            jobs_path,
            lyrics_tx: None,
            fetch_workers: HashMap::new(),
            fetch_rx: None,
            attempt_seq: AtomicU32::new(0),
            dirty: Mutex::new(false),
            last_emit: Mutex::new(None),
        }
    }

    /// Liga o canal do worker de letras (Etapa E). Encadeado por
    /// `spawn_coordinator`; testes que não exercitam letras ficam com `None`.
    fn with_lyrics_tx(mut self, tx: Sender<LyricsJob>) -> Self {
        self.lyrics_tx = Some(tx);
        self
    }

    /// Registra o worker de uma origem externa (`Source::kind`).
    fn with_fetch_worker(mut self, kind: &'static str, tx: Sender<FetchTask>) -> Self {
        self.fetch_workers.insert(kind, tx);
        self
    }

    /// Liga o canal de volta, compartilhado por todos os workers.
    fn with_fetch_events(mut self, rx: Receiver<FetchEvent>) -> Self {
        self.fetch_rx = Some(rx);
        self
    }

    fn next_attempt(&self) -> u32 {
        self.attempt_seq.fetch_add(1, Ordering::SeqCst)
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
        let indexing_paths: HashMap<String, PathBuf> = self
            .indexing_retry
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .map(|(id, (_, _, path))| (id.clone(), path.clone()))
            .collect();
        let persisted: Vec<PersistedJob> = self
            .board
            .snapshot()
            .into_iter()
            .filter(|j| !super::board::is_terminal(&j.state))
            .map(|j| PersistedJob {
                waiting: match &j.state {
                    JobState::Waiting { reason, url, .. } => Some((*reason, url.clone())),
                    _ => None,
                },
                waiting_since_unix: match &j.state {
                    JobState::Waiting { .. } => self.board.waiting_since_unix(&j.job_id),
                    _ => None,
                },
                format_in: j.format_in,
                indexing_path: match j.state {
                    JobState::Indexing => indexing_paths.get(&j.job_id).cloned(),
                    _ => None,
                },
                username: j.soulseek().map(|(u, _, _)| u.to_string()).unwrap_or_default(),
                remote_filename: j.soulseek().map(|(_, f, _)| f.to_string()).unwrap_or_default(),
                attempt: j.attempt,
                job_id: j.job_id,
                source: j.source,
                meta: j.meta,
                artwork_url: j.artwork_url,
                tracks: j.tracks,
                dest_playlist: j.dest_playlist,
                alternates: j.alternates,
                quality_label: j.quality_label,
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
            Ok(mut v) => {
                for pj in &mut v {
                    let placeholder =
                        matches!(&pj.source, Source::Soulseek { username, .. } if username.is_empty());
                    if placeholder && !pj.username.is_empty() {
                        pj.source = Source::Soulseek {
                            username: std::mem::take(&mut pj.username),
                            remote_filename: std::mem::take(&mut pj.remote_filename),
                            size: 0,
                        };
                    }
                }
                v
            }
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
            // Tentativas novas nunca repetem uma persistida.
            self.attempt_seq.fetch_max(pj.attempt.saturating_add(1), Ordering::SeqCst);
            let base = DownloadJob {
                job_id: pj.job_id.clone(),
                source: pj.source.clone(),
                meta: pj.meta.clone(),
                artwork_url: pj.artwork_url.clone(),
                format_in: pj.format_in,
                tracks: pj.tracks,
                display: String::new(), // preenchido abaixo, por origem
                dest_playlist: pj.dest_playlist,
                state: JobState::Queued, // placeholder, sobrescrito abaixo
                quality_label: pj.quality_label.clone(),
                alternates: pj.alternates,
                tried_source_ids: Vec::new(),
                created_at: pj.created_at,
                attempt: pj.attempt,
            };
            let display = match base.soulseek() {
                Some((_, remote_filename, _)) => remote_filename.to_string(),
                None => format!("{} - {}", base.meta.artist, base.meta.title),
            };
            let base = DownloadJob { display, ..base };

            // `Indexing` com o arquivo já em `~/Music` (qualquer origem): o
            // download e o staging já aconteceram, só falta o ingest. Retoma
            // no primeiro tick em vez de baixar de novo (o download repetido
            // terminaria em `AlreadyOwned` ou numa duplicata `(2)`).
            if let Some(path) = pj.indexing_path.as_ref().filter(|p| p.is_file()) {
                self.indexing_retry
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(pj.job_id.clone(), (0, now, path.clone()));
                self.board.upsert(DownloadJob { state: JobState::Indexing, ..base });
                continue;
            }

            // Fonte externa (spec §2.3): nada a cruzar com o slskd. `Waiting`
            // volta como está, com a âncora do instante de entrada (o
            // `upsert_at` com o mesmo `now_unix` a restaura exata); o resto
            // recomeça do zero como `Queued` e é despachado ao worker no
            // fim, respeitando o teto da origem. Na fase 2 (Bandcamp) o boot
            // também terá de reentregar os `Waiting` ao worker, que é quem
            // consulta a `collection` durante a espera.
            let Some((username, remote_filename)) =
                base.soulseek().map(|(u, f, _)| (u.to_string(), f.to_string()))
            else {
                let state = match pj.waiting {
                    Some((reason, url)) => {
                        let since_secs = pj
                            .waiting_since_unix
                            .map(|t| u64::try_from(now_unix - t).unwrap_or(0))
                            .unwrap_or(0);
                        JobState::Waiting { reason, url, since_secs }
                    }
                    None => JobState::Queued,
                };
                self.board.upsert_at(DownloadJob { state, format_in: None, ..base }, now_unix);
                continue;
            };
            // `size` vem do `source` persistido (0 em arquivo legado). Só
            // importa pra `promote_queued`, e jobs reconciliados nunca voltam
            // a ficar `Queued` localmente antes de um novo `try_other_source`,
            // que já grava o `size` certo da alternativa escolhida.

            match find_transfer(&downloads, &username, &remote_filename) {
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
        for kind in EXTERNAL_KINDS {
            self.promote_external(kind);
        }
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
                // NB-3: `started_at` precisa ser o instante em que a
                // busca REALMENTE começou no slskd — não o `now` (param
                // de `handle_search`) capturado antes de `ensure_swept`/
                // `start_search`. Um sweep lento (o cenário exato que o
                // §6.3 existe pra tratar: centenas de DELETE sequenciais)
                // "comia" a janela de 25s antes da busca sequer começar;
                // o primeiro poll via `window_over`, marcava `Empty` e
                // alimentava o detector de rede fria com um falso vazio.
                let started_at = Instant::now();
                *active = Some(ActiveSearch {
                    local_id,
                    remote_id,
                    started_at,
                    next_poll_at: started_at,
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

        if window_over {
            // Outcome do pacer é POR BUSCA FECHADA (§6.2: "3 buscas vazias
            // seguidas" = rede throttled), nunca por poll: os primeiros
            // ticks de toda busca vêm zerados enquanto a rede responde, e
            // contá-los como strikes armava cold com penalidade dobrada em
            // uso humano normal (2 buscas manuais -> 60 min de pausa).
            self.lock_pacer().record_result(now, responses.len() as u32);
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
        let (job_id, needs_enqueue) = self.create_or_get_soulseek_job(candidate, alternates, dest_playlist);
        if !needs_enqueue || self.board.in_flight_count_for("soulseek") >= max_active_for("soulseek") {
            return Ok(job_id);
        }
        self.enqueue_job(&job_id, &candidate.username, &candidate.filename, candidate.size, now);
        Ok(job_id)
    }

    /// Parte memory-only de criar um job. Não faz I/O nenhuma, então é
    /// seguro chamar ANTES de responder um `reply` (CR-1). Devolve
    /// `(job_id, needs_enqueue)` (review NB-2 do fix round 1 quebrou a
    /// idempotência ao virar só `String`: um job já EM VOO — não-terminal
    /// — devolvia o mesmo `job_id` mas `needs_enqueue` ficava implícito
    /// "sempre true" nos dois chamadores, então dois cliques no mesmo
    /// candidato mandavam dois `POST /transfers/downloads`; pior, um job
    /// já `Ready` (terminal) tentava `Ready -> Enqueued`, ilegal na
    /// matriz, então o `enqueue_job` ainda batia na rede e baixava de
    /// novo, mas o `board.transition` falhava em silêncio e NENHUM job
    /// acompanhava o download — arquivo órfão em `downloads_dir`).
    ///
    /// Semântica real agora: job não existe -> cria `Queued`,
    /// `needs_enqueue=true`. Job existe e NÃO é terminal (já em voo ou
    /// `Queued` esperando vaga) -> devolve o mesmo, `needs_enqueue=false`
    /// (idempotente de verdade — não reenfileira o que já está andando).
    /// Job existe e é terminal (`Ready`/`Rejected`/`Failed`/`Manual`/
    /// `Canceled`) -> **recria** como um pedido novo (reseta
    /// `tried_source_ids`, `created_at`, `alternates` pros atuais,
    /// `state: Queued`), `needs_enqueue=true` — clicar `[Baixar]` de novo
    /// num job terminado é uma intenção explícita de tentar de novo, não
    /// um duplicado a ignorar. Toda criação ou recriação ganha uma
    /// `attempt` nova: eventos ainda em trânsito da tentativa anterior são
    /// descartados por `drain_fetch_events`.
    #[allow(clippy::too_many_arguments)]
    fn create_or_get_job(
        &self,
        source: Source,
        meta: ConfirmedMeta,
        artwork_url: Option<String>,
        display: String,
        quality_label: String,
        alternates: Vec<Candidate>,
        dest_playlist: &str,
    ) -> (String, bool) {
        let job_id = super::board::job_id(&source);
        if let Some(existing) = self.board.get(&job_id) {
            if !super::board::is_terminal(&existing.state) {
                return (job_id, false);
            }
        }
        self.board.upsert(DownloadJob {
            job_id: job_id.clone(),
            source,
            meta,
            artwork_url,
            format_in: None,
            tracks: 1,
            display,
            dest_playlist: dest_playlist.to_string(),
            state: JobState::Queued,
            quality_label,
            alternates,
            tried_source_ids: Vec::new(),
            created_at: unix_now(),
            attempt: self.next_attempt(),
        });
        self.mark_dirty();
        (job_id, true)
    }

    /// Chamador Soulseek de [`Self::create_or_get_job`]: monta a origem, o
    /// `display` e o rótulo de qualidade a partir do candidato.
    fn create_or_get_soulseek_job(
        &self,
        candidate: &slskd_client::rank::Candidate,
        alternates: Vec<slskd_client::rank::Candidate>,
        dest_playlist: &str,
    ) -> (String, bool) {
        let display = slskd_client::rank::guess_artist_title(&candidate.filename)
            .map(|(a, t)| format!("{a} - {t}"))
            .unwrap_or_else(|| slskd_client::rank::remote_basename(&candidate.filename).to_string());
        self.create_or_get_job(
            Source::Soulseek {
                username: candidate.username.clone(),
                remote_filename: candidate.filename.clone(),
                size: candidate.size,
            },
            ConfirmedMeta::default(),
            None,
            display,
            slskd_client::rank::quality_label(candidate.bit_depth, candidate.sample_rate),
            alternates.iter().map(Candidate::from).collect(),
            dest_playlist,
        )
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
            .ok_or_else(|| "grupo não encontrado nessa busca".to_string())?;
        let candidate = std::iter::once(&group.best)
            .chain(group.alternates.iter())
            .find(|c| c.id == source_id)
            .ok_or_else(|| "fonte não encontrada nesse grupo".to_string())?
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
            let _ = reply.send(Err("destino de playlist inválido".to_string()));
            return;
        }
        let (candidate, alternates) = match self.resolve_download_candidate(search_id, group_key, source_id) {
            Ok(v) => v,
            Err(e) => {
                let _ = reply.send(Err(e));
                return;
            }
        };

        let (job_id, needs_enqueue) = self.create_or_get_soulseek_job(&candidate, alternates, dest);
        let _ = reply.send(Ok(job_id.clone()));

        if !needs_enqueue || self.board.in_flight_count_for("soulseek") >= max_active_for("soulseek") {
            return;
        }
        self.enqueue_job(&job_id, &candidate.username, &candidate.filename, candidate.size, now);
    }

    /// Handler de `SlskTask::DownloadExternal`. Valida, cria (ou devolve) o
    /// job em memória e responde o `job_id` antes de qualquer outra coisa;
    /// o despacho ao worker é um `try_send`, sem I/O. Idempotente: a mesma
    /// faixa em voo devolve o job existente sem segundo download.
    fn handle_task_download_external(
        &self,
        source: Source,
        meta: ConfirmedMeta,
        artwork_url: Option<String>,
        dest: &str,
        reply: Sender<Result<String, String>>,
    ) {
        if !EXTERNAL_KINDS.contains(&source.kind()) {
            let _ = reply.send(Err("origem não aceita por este caminho".to_string()));
            return;
        }
        if !is_valid_playlist_name(dest) {
            let _ = reply.send(Err("destino de playlist inválido".to_string()));
            return;
        }
        if meta.artist.trim().is_empty() || meta.title.trim().is_empty() {
            let _ = reply.send(Err("artista e título são obrigatórios".to_string()));
            return;
        }
        let kind = source.kind();
        let display = format!("{} - {}", meta.artist, meta.title);
        let (job_id, is_new) = self.create_or_get_job(source, meta, artwork_url, display, String::new(), Vec::new(), dest);
        let _ = reply.send(Ok(job_id));
        if !is_new {
            return;
        }
        self.promote_external(kind);
    }

    /// Despacha jobs `Queued` da origem `kind` ao worker enquanto houver vaga.
    /// Para no primeiro despacho que não sai (fila do worker cheia): o job
    /// fica `Queued` e o próximo tick tenta de novo.
    fn promote_external(&self, kind: &str) {
        // Soulseek é promovido por `promote_queued` (enqueue no slskd); um
        // job Soulseek mandado ao worker externo pularia o slskd.
        if !EXTERNAL_KINDS.contains(&kind) {
            return;
        }
        while self.board.in_flight_count_for(kind) < max_active_for(kind) {
            let next = self
                .board
                .snapshot()
                .into_iter()
                .find(|j| j.state == JobState::Queued && j.source.kind() == kind);
            let Some(job) = next else { break };
            if !self.dispatch_fetch(&job) {
                break;
            }
        }
    }

    /// Manda o job ao worker. `true` quando o job saiu de `Queued` (foi
    /// aceito pelo worker, ou falhou por não haver worker); `false` quando
    /// continua `Queued` (fila cheia).
    fn dispatch_fetch(&self, job: &DownloadJob) -> bool {
        let Some(tx) = self.fetch_workers.get(job.source.kind()) else {
            self.board.transition(
                &job.job_id,
                JobState::Failed { reason: "fonte ainda não suportada".to_string(), retryable: false },
            );
            self.mark_dirty();
            return true;
        };
        let task = FetchTask {
            job_id: job.job_id.clone(),
            attempt: job.attempt,
            source: job.source.clone(),
            meta: job.meta.clone(),
            artwork_url: job.artwork_url.clone(),
            playlist: job.dest_playlist.clone(),
            incoming_dir: self.cfg.music_root.join(stage::INCOMING_DIR_NAME),
        };
        match tx.try_send(task) {
            Ok(()) => {
                self.board.transition(&job.job_id, JobState::Enqueued { queue_position: None });
                self.mark_dirty();
                true
            }
            Err(crossbeam_channel::TrySendError::Full(_)) => false,
            Err(crossbeam_channel::TrySendError::Disconnected(_)) => {
                self.board.transition(
                    &job.job_id,
                    JobState::Failed {
                        reason: "o download da fonte externa foi interrompido".to_string(),
                        retryable: true,
                    },
                );
                self.mark_dirty();
                true
            }
        }
    }

    /// Aplica no board o que o worker devolveu. Chamado a cada tick do loop.
    ///
    /// Evento de outra tentativa (o job foi recriado) ou de job que saiu do
    /// board é descartado inteiro, e o arquivo que ele trazia é apagado: só
    /// a tentativa atual move o job. `Done` de um job que não aceita mais
    /// `Processing` (cancelado no meio) também descarta o FLAC pronto: nada
    /// entra no acervo sem job acompanhando. Grava o `slsk_jobs.json` uma vez
    /// por drain, e só se alguma transição foi aceita.
    fn drain_fetch_events(&self, _now: Instant) {
        let Some(rx) = &self.fetch_rx else { return };
        let mut changed = false;
        for ev in rx.try_iter().collect::<Vec<_>>() {
            let (job_id, attempt) = ev.key();
            let current = self.board.get(job_id).is_some_and(|j| j.attempt == attempt);
            if !current {
                tracing::debug!(job_id, attempt, "slsk-coord: evento de tentativa antiga descartado");
                match &ev {
                    FetchEvent::Done { flac_path, .. } => self.discard_fetched(flac_path),
                    FetchEvent::Rejected { quarantine: Some(path), .. } => self.discard_fetched(path),
                    _ => {}
                }
                continue;
            }
            match ev {
                FetchEvent::Started { job_id, .. } => {
                    changed |= self
                        .board
                        .transition(&job_id, JobState::Downloading { pct: 0.0, bps: 0, eta_s: None });
                }
                FetchEvent::Progress { job_id, pct, bps, eta_s, .. } => {
                    changed |= self.board.transition(&job_id, JobState::Downloading { pct, bps, eta_s });
                }
                FetchEvent::Done { job_id, flac_path, format_in, .. } => {
                    if !self.is_in_incoming(&flac_path) {
                        // O worker só grava no incoming. Um caminho fora dele
                        // (p. ex. uma faixa que já está no acervo) iria para
                        // o staging e, num `AlreadyOwned`, para a quarentena.
                        tracing::warn!(job_id, path = %flac_path.display(), "slsk-coord: Done com arquivo fora do incoming, recusado");
                        changed |= self.board.transition(
                            &job_id,
                            JobState::Failed {
                                reason: "arquivo baixado fora da pasta de entrada".to_string(),
                                retryable: false,
                            },
                        );
                    } else if self.board.transition(&job_id, JobState::Processing) {
                        changed = true;
                        if let Some(mut job) = self.board.get(&job_id) {
                            job.format_in = Some(format_in);
                            self.board.upsert(job.clone());
                            self.stage_and_ingest(&job, flac_path);
                        }
                    } else {
                        self.discard_fetched(&flac_path);
                    }
                }
                FetchEvent::Rejected { job_id, reason, quarantine, .. } => {
                    // A matriz só aceita `rejected` a partir de `processing`
                    // (é o veredito da validação): o worker rejeita durante a
                    // sondagem/conversão, que é exatamente o `Processing`. Job
                    // cancelado recusa as duas transições e fica como está.
                    self.board.transition(&job_id, JobState::Processing);
                    let slug = reject_slug(&reason);
                    if self.board.transition(&job_id, JobState::Rejected { reason }) {
                        changed = true;
                        if let Some(path) = quarantine {
                            if self.is_in_incoming(&path) {
                                let dest = stage::quarantine(&self.cfg.music_root, &path, slug);
                                tracing::info!(job_id, path = %dest.display(), "slsk-coord: rejeitado pelo worker, arquivo na quarentena");
                            } else {
                                tracing::warn!(job_id, path = %path.display(), "slsk-coord: arquivo rejeitado fora do incoming, não movido");
                            }
                        }
                    } else if let Some(path) = quarantine {
                        self.discard_fetched(&path);
                    }
                }
                FetchEvent::Failed { job_id, reason, retryable, .. } => {
                    changed |= self.board.transition(&job_id, JobState::Failed { reason, retryable });
                }
            }
        }
        if changed {
            self.mark_dirty();
        }
        // Vagas abertas por terminais (e fila do worker que esvaziou):
        // promover a fila externa.
        for kind in EXTERNAL_KINDS {
            self.promote_external(kind);
        }
    }

    /// `true` só para um arquivo dentro de `.rustify-incoming`. `starts_with`
    /// é léxico e não resolve `..` (`<incoming>/../P/x.flac` passaria), então
    /// caminho com componente que não seja nome comum é recusado.
    fn is_in_incoming(&self, path: &std::path::Path) -> bool {
        let incoming = self.cfg.music_root.join(stage::INCOMING_DIR_NAME);
        path.strip_prefix(&incoming).is_ok_and(|rest| {
            rest.components().next().is_some()
                && rest.components().all(|c| matches!(c, std::path::Component::Normal(_)))
        })
    }

    /// Apaga um arquivo que o worker produziu e que nenhum job vai usar. Só
    /// mexe dentro de `.rustify-incoming` (o worker nunca grava fora dele);
    /// qualquer outro caminho fica como está, com log.
    fn discard_fetched(&self, path: &std::path::Path) {
        if self.is_in_incoming(path) {
            let _ = std::fs::remove_file(path);
        } else {
            tracing::warn!(path = %path.display(), "slsk-coord: arquivo do worker fora do incoming, não apagado");
        }
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
        let job = self.board.get(job_id).ok_or_else(|| "job não encontrado".to_string())?;
        let next = job
            .alternates
            .iter()
            .find(|c| !job.tried_source_ids.contains(&c.id))
            .cloned()
            .ok_or_else(|| "sem outras fontes disponíveis".to_string())?;

        if !can_transition(&job.state, &JobState::Queued) {
            return Err("job em estado que não aceita troca de fonte agora".to_string());
        }

        let mut tried = job.tried_source_ids.clone();
        tried.push(next.id.clone());
        self.board.upsert(DownloadJob {
            source: Source::Soulseek {
                username: next.username.clone(),
                remote_filename: next.filename.clone(),
                size: next.size,
            },
            tried_source_ids: tried,
            state: JobState::Queued,
            quality_label: slskd_client::rank::quality_label(next.bit_depth, next.sample_rate),
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
        // Origem externa: só a transição local — o worker consulta
        // `JobBoard::is_canceled(job_id, attempt)` antes de cada etapa e
        // abandona o trabalho; eventos que ainda cheguem são recusados pela
        // matriz (job `Canceled`) ou descartados (job recriado).
        let Some((username, remote_filename, _)) = job.soulseek() else { return };
        if let Ok(downloads) = self.api.downloads() {
            if let Some(file) = find_transfer(&downloads, username, remote_filename) {
                let _ = self.api.cancel_download(username, &file.id);
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
    /// fabricado.
    ///
    /// `api.downloads()` falhando não interrompe o tick inteiro (review
    /// NB-2): jobs em `Processing`/`Indexing` NÃO dependem mais do slskd
    /// nesse ponto (o arquivo já saiu de `downloads_dir` — `Processing`
    /// está localizando localmente, `Indexing` está retentando o Qdrant)
    /// e continuam progredindo mesmo com o slskd fora. Só depois de
    /// `DOWNLOADS_FAIL_THRESHOLD` falhas CONSECUTIVAS (não uma só — um
    /// 500/timeout isolado sob carga não é "caiu") os jobs que REALMENTE
    /// dependem do slskd (`Enqueued`/`Downloading`/`Stalled`, os únicos
    /// com transfer ativo lá) viram `Failed{retryable:true}`.
    fn poll_active_transfers_once(&self, now: Instant) {
        let active_ids = self.board.active_ids();
        if active_ids.is_empty() {
            return;
        }

        // Só consulta o slskd quando há job Soulseek que dependa dele: em voo
        // (`Enqueued`/`Downloading`/`Stalled`) ou esperando vaga (`Queued`,
        // que `promote_queued` enfileira lá). Jobs externos e
        // `Processing`/`Indexing` andam sem o slskd; com ele fora do ar ou
        // travado, consultá-lo a cada tick só gerava warn por segundo e
        // segurava o coordinator no timeout do ureq (spec §2.4).
        let needs_slskd = self.board.snapshot().iter().any(|j| {
            j.soulseek().is_some()
                && matches!(
                    j.state,
                    JobState::Queued | JobState::Enqueued { .. } | JobState::Downloading { .. } | JobState::Stalled { .. }
                )
        });
        let downloads = if !needs_slskd {
            None
        } else {
            match self.api.downloads() {
                Ok(d) => {
                    self.downloads_fail_streak.store(0, Ordering::SeqCst);
                    Some(d)
                }
                Err(e) => {
                    let streak = self.downloads_fail_streak.fetch_add(1, Ordering::SeqCst) + 1;
                    tracing::warn!(?e, streak, "slsk-coord: poll de transfers falhou");
                    if streak >= DOWNLOADS_FAIL_THRESHOLD {
                        self.fail_network_dependent_jobs("slskd inalcancavel");
                    }
                    None
                }
            }
        };

        for job_id in active_ids {
            let Some(job) = self.board.get(&job_id) else { continue };
            match &job.state {
                JobState::Enqueued { .. } | JobState::Downloading { .. } | JobState::Stalled { .. } => {
                    // Origem externa: o progresso chega pelo canal do
                    // worker (`drain_fetch_events`), não pelo slskd.
                    if job.soulseek().is_none() {
                        continue;
                    }
                    if let Some(downloads) = downloads.as_deref() {
                        self.poll_one_transfer(&job, downloads, now);
                    }
                    // Sem `downloads` (slskd fora, ainda sob o threshold
                    // ou já falhado): nada de novo pra ver, o job so
                    // espera o próximo tick.
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

        if downloads.is_some() {
            self.promote_queued(now);
        }
    }

    /// Só os estados com transfer ATIVO no slskd (review NB-2:
    /// `Processing`/`Indexing` não entram — não dependem mais do slskd
    /// nesse ponto do pipeline, e falhá-los derrubava faixas já staged
    /// só esperando o Qdrant voltar).
    fn fail_network_dependent_jobs(&self, reason: &str) {
        for job in self.board.snapshot() {
            if job.soulseek().is_some()
                && matches!(
                    job.state,
                    JobState::Enqueued { .. } | JobState::Downloading { .. } | JobState::Stalled { .. }
                )
                && self.board.transition(&job.job_id, JobState::Failed { reason: reason.to_string(), retryable: true })
            {
                self.mark_dirty();
            }
        }
    }

    /// Promove jobs `Queued` enquanto houver vaga — usa `in_flight_count`
    /// (review CR-2: `active_count` antigo contava `Queued` também, então
    /// promover um job nunca reduzia a contagem de "não-terminal" e a fila
    /// travava permanentemente com ≥`MAX_ACTIVE_SOULSEEK+1` jobs). Usa
    /// `job.size` real (review IM-7: antes ia com `size:0` fixo).
    fn promote_queued(&self, now: Instant) {
        while self.board.in_flight_count_for("soulseek") < max_active_for("soulseek") {
            let queued = self
                .board
                .snapshot()
                .into_iter()
                .find(|j| j.state == JobState::Queued && j.soulseek().is_some());
            let Some(job) = queued else { break };
            let Some((username, remote_filename, size)) = job.soulseek() else { break };
            self.enqueue_job(&job.job_id, username, remote_filename, size, now);
        }
    }

    fn poll_one_transfer(&self, job: &DownloadJob, downloads: &[ApiTransferUser], now: Instant) {
        let Some((username, remote_filename, _)) = job.soulseek() else { return };
        let Some(file) = find_transfer(downloads, username, remote_filename) else {
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
                    source: Source::Soulseek {
                        username: alt.username.clone(),
                        remote_filename: alt.filename.clone(),
                        size: alt.size,
                    },
                    tried_source_ids: tried,
                    state: JobState::Queued,
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
        let Some((_, remote_filename, _)) = job.soulseek() else { return };
        let started_at = job_created_at_as_systemtime(job.created_at);
        match stage::locate_downloaded(&self.cfg.downloads_dir, remote_filename, started_at) {
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
        let Some((_, remote_filename, _)) = job.soulseek() else { return };
        let started_at = job_created_at_as_systemtime(job.created_at);
        match stage::locate_downloaded(&self.cfg.downloads_dir, remote_filename, started_at) {
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
                        why: "baixou, mas não achei o arquivo em downloads_dir".to_string(),
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
    ///
    /// Falha antes de mover, em job de origem externa: o arquivo está no
    /// `.rustify-incoming` (no Soulseek ele fica em `downloads_dir`, que é do
    /// slskd) e é apagado. Cada nova tentativa baixa um arquivo próprio, então
    /// guardá-lo só acumularia lixo no acervo oculto até o próximo boot.
    fn stage_and_ingest(&self, job: &DownloadJob, local: PathBuf) {
        let owned = match self.owned_index_safe() {
            Some(idx) => idx,
            None => {
                self.board.transition(
                    &job.job_id,
                    JobState::Failed {
                        reason: "Qdrant indisponível para checagem de dedup".to_string(),
                        retryable: true,
                    },
                );
                self.discard_external_leftover(job, &local);
                self.mark_dirty();
                return;
            }
        };

        match stage::stage_file(&self.cfg.music_root, &job.dest_playlist, &local, &owned, &job.job_id) {
            Ok(stage::StageOutcome::Staged { final_path }) => {
                // Fonte externa (`format_in` detectado): o worker embutiu a
                // capa no FLAC; a pasta do álbum ganha o `cover.jpg` dela.
                // Melhor esforço: falha aqui não segura o ingest.
                if job.format_in.is_some() {
                    if let Err(e) = stage::write_folder_cover(&final_path) {
                        tracing::warn!(job_id = %job.job_id, error = %e, "slsk-coord: cover.jpg da pasta não gravado");
                    }
                }
                self.board.transition(&job.job_id, JobState::Indexing);
                // Registra o arquivo ANTES de persistir: se o app morrer no
                // meio do ingest, o boot retoma daqui (`indexing_path`).
                self.indexing_retry
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(job.job_id.clone(), (0, Instant::now(), final_path.clone()));
                self.mark_dirty();
                self.try_ingest(job, final_path, Instant::now());
            }
            Ok(stage::StageOutcome::Rejected(reason)) => {
                self.board.transition(&job.job_id, JobState::Rejected { reason });
                self.mark_dirty();
            }
            Err(e) => {
                self.board.transition(&job.job_id, JobState::Failed { reason: e, retryable: true });
                self.discard_external_leftover(job, &local);
                self.mark_dirty();
            }
        }
    }

    /// Ver [`Self::stage_and_ingest`]: só origem externa. Apaga o arquivo da
    /// tentativa e também o `<incoming>/<job_id>.flac` em que o `stage_file`
    /// o renomeia antes de colocar no destino: um erro depois desse rename
    /// (`create_dir_all`, `metadata`, `move_file`) deixaria a cópia lá.
    fn discard_external_leftover(&self, job: &DownloadJob, local: &std::path::Path) {
        if job.soulseek().is_some() {
            return;
        }
        for path in [local.to_path_buf(), stage::incoming_path(&self.cfg.music_root, &job.job_id)] {
            if path.is_file() {
                self.discard_fetched(&path);
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
                self.send_lyrics_job(track_id, &final_path);
            }
            Some(IngestOutcome { result: Err(e), .. }) => {
                self.schedule_ingest_retry(job, final_path, now, e);
            }
            None => {
                self.schedule_ingest_retry(
                    job,
                    final_path,
                    now,
                    "ingest não retornou outcome para o path staged".to_string(),
                );
            }
        }
        self.mark_dirty();
    }

    /// Enfileira a busca de letra da faixa recém-ingerida (Etapa E). Tags
    /// saem do próprio arquivo staged (`parse_flac` local, ~ms) — não do
    /// nome de arquivo do peer. `try_send`: fila cheia descarta em debug,
    /// letra nunca gera backpressure nem erro de job.
    fn send_lyrics_job(&self, track_id: u64, final_path: &std::path::Path) {
        let Some(tx) = &self.lyrics_tx else { return };
        let md = match library_indexer::parse_flac(final_path) {
            Ok(md) => md,
            Err(e) => {
                tracing::debug!(track_id, %e, "lyrics: parse do staged falhou — sem job");
                return;
            }
        };
        let job = LyricsJob {
            track_id,
            flac_path: final_path.to_path_buf(),
            artist: md.artist.unwrap_or_default(),
            title: md.title.unwrap_or_default(),
            album: md.album,
            duration_secs: u32::try_from(md.duration_ms / 1000).ok().filter(|d| *d > 0),
        };
        if tx.try_send(job).is_err() {
            tracing::debug!(track_id, "lyrics: fila cheia — job descartado");
        }
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

    fn emit_if_dirty(&self, now: Instant, emit: &dyn Fn(Vec<DownloadJob>)) {
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
        emit(self.board.snapshot());
    }

    // ── Loop real (produção) ───────────────────────────────────────────

    fn run_loop(&self, app: &AppHandle, cmd_rx: &Receiver<SlskTask>) {
        let emit = |jobs: Vec<DownloadJob>| {
            let _ = app.emit("slsk-jobs", jobs);
        };
        while self.tick(cmd_rx, &emit) {}
    }

    /// Uma volta do loop: espera um comando (com o teto do modo atual) e
    /// atende, faz o poll da busca, drena os eventos dos workers, consulta os
    /// transfers e emite o board. Devolve `false` quando o canal de comandos
    /// fecha. Separada do `run_loop` para os testes rodarem o loop real sem
    /// `AppHandle` (latência dos comandos, spec §8).
    fn tick(&self, cmd_rx: &Receiver<SlskTask>, emit: &dyn Fn(Vec<DownloadJob>)) -> bool {
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
                return false;
            }
        }

        let now = Instant::now();
        self.poll_active_search_once(now);
        self.drain_fetch_events(now);
        if has_active_jobs {
            self.poll_active_transfers_once(now);
            self.board.retain_recent_terminals(JOBS_RETAINED);
        }
        self.emit_if_dirty(now, emit);
        true
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
            SlskTask::DownloadExternal { source, meta, artwork_url, dest, reply } => {
                self.handle_task_download_external(source, meta, artwork_url, &dest, reply);
            }
        }
    }
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
    fetch: Option<FetchWiring>,
) -> JoinHandle<()> {
    let ingest_indexer = indexer.clone();
    let ingest: Box<dyn Fn(Vec<PathBuf>) -> Vec<IngestOutcome> + Send + Sync> =
        Box::new(move |paths| ingest_indexer.ingest_paths(paths));

    let sink_indexer = indexer.clone();

    let qdrant_indexer = indexer;
    let music_root_for_owned = cfg.music_root.clone();
    let owned_index_provider: Box<dyn Fn() -> Result<OwnedIndex, String> + Send + Sync> =
        Box::new(move || {
            OwnedIndex::build(qdrant_indexer.client(), &music_root_for_owned).map_err(|e| e.to_string())
        });

    let jobs_path = jobs_path_from_cfg(&cfg);

    // Worker de letras (Etapa E): thread própria, canal bounded — o
    // coordinator só faz try_send. O worker encerra sozinho quando o
    // coordinator morrer (tx dropado -> canal fecha -> iter termina).
    let (lyrics_tx, lyrics_rx) = crossbeam_channel::bounded::<LyricsJob>(64);
    let user_agent = format!(
        "rustify-player/{} (+https://github.com/PedroGiudice/rustify-player)",
        env!("CARGO_PKG_VERSION")
    );
    // Sink: fecha o ciclo da faixa nova (payload + vetor `lyrics`) assim que a
    // letra chega. Sem ele a letra baixada só virava vetor no próximo boot.
    let lyrics_sink = sink_indexer.lyrics_sink();
    let _lyrics_worker =
        spawn_lyrics_worker(lyrics_rx, Arc::new(Lrclib::new(user_agent)), lyrics_sink);

    std::thread::Builder::new()
        .name("slsk-coord".to_string())
        .spawn(move || {
            let mut coordinator =
                Coordinator::new(cfg, api, board, searches, ingest, owned_index_provider, jobs_path)
                    .with_lyrics_tx(lyrics_tx);
            if let Some(FetchWiring { workers, events }) = fetch {
                for (kind, tx) in workers {
                    coordinator = coordinator.with_fetch_worker(kind, tx);
                }
                coordinator = coordinator.with_fetch_events(events);
            }
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

    /// Job Soulseek montado à mão (setup de testes que não passam por
    /// `start_download`).
    fn mk_job(id: &str, username: &str, remote_filename: &str, size: u64, state: JobState) -> DownloadJob {
        DownloadJob {
            job_id: id.to_string(),
            source: Source::Soulseek {
                username: username.to_string(),
                remote_filename: remote_filename.to_string(),
                size,
            },
            meta: Default::default(),
            artwork_url: None,
            format_in: None,
            tracks: 1,
            display: id.to_string(),
            dest_playlist: "P".to_string(),
            state,
            quality_label: "FLAC 16/44".to_string(),
            alternates: vec![],
            tried_source_ids: vec![],
            created_at: 0,
            attempt: 0,
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

    /// Etapa E: ingest OK dispara UM LyricsJob no canal, com track_id do
    /// ingest e tags lidas do PRÓPRIO arquivo staged (não do nome remoto).
    #[test]
    fn ready_dispara_lyrics_job_com_tags_do_arquivo_staged() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        let (lyrics_tx, lyrics_rx) = crossbeam_channel::bounded(4);
        let coord = make_coordinator(tmp.path(), fake.clone()).with_lyrics_tx(lyrics_tx);

        let now = Instant::now();
        let cand = candidate("peer1", "Artist\\Album\\01 - Title.flac", 1000);
        let job_id = coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();

        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("crates/audio-engine/tests/fixtures/track_01.flac");
        let dl_dir = tmp.path().join("downloads").join("Album");
        std::fs::create_dir_all(&dl_dir).unwrap();
        std::fs::copy(&fixture, dl_dir.join("01 - Title.flac")).unwrap();

        fake.downloads_script.lock().unwrap().push_back(Ok(vec![transfer_user(
            "peer1",
            "Artist\\Album\\01 - Title.flac",
            "Completed, Succeeded",
            1000,
            1000,
        )]));
        coord.poll_active_transfers_once(now + Duration::from_secs(1));
        assert!(matches!(coord.board.get(&job_id).unwrap().state, JobState::Ready { .. }));

        let sent = lyrics_rx.try_recv().expect("ingest OK deveria enfileirar LyricsJob");
        let md = library_indexer::parse_flac(&fixture).unwrap();
        assert_eq!(sent.artist, md.artist.unwrap_or_default());
        assert_eq!(sent.title, md.title.unwrap_or_default());
        assert!(sent.flac_path.starts_with(tmp.path().join("Music")), "path staged sob music_root");
        assert!(lyrics_rx.try_recv().is_err(), "exatamente um job por ingest");
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
        assert_eq!(job.soulseek().unwrap().0, "peer2", "deveria ter trocado pra fonte alternativa");
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
    fn start_download_idempotent_while_job_still_in_flight() {
        // NB-1: dois cliques no MESMO candidato enquanto o job ainda esta
        // em voo (Enqueued/Downloading/...) nao podem mandar dois
        // POST /transfers/downloads.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();
        let cand = candidate("peer1", "Artist\\Title.flac", 1000);

        let job_id1 = coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();
        let job_id2 = coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();

        assert_eq!(job_id1, job_id2);
        assert_eq!(
            fake.enqueue_calls.lock().unwrap().len(),
            1,
            "clicar 2x no mesmo candidato ainda em voo deve ser idempotente"
        );
    }

    #[test]
    fn start_download_on_terminal_job_recreates_and_reenqueues() {
        // NB-1: o refactor de start_download em create_or_get_job +
        // enqueue_job perdeu o early-return de board.contains — a funcao
        // devolvia o job_id existente SEM sinalizar "ja existia", e os
        // chamadores enfileiravam mesmo assim. Pior caso: job ja Ready
        // (terminal) -> a transicao pra Enqueued e recusada em silencio
        // (Ready->Enqueued nao esta na matriz) mas o enqueue_job ja tinha
        // batido na rede — arquivo baixado de novo, orfao, sem job
        // nenhum acompanhando. Fix: job terminal e RECRIADO (reset pra
        // Queued) antes de reenfileirar de verdade.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();
        let cand = candidate("peer1", "Artist\\Title.flac", 1000);

        let job_id = coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();
        let job = coord.board.get(&job_id).unwrap();
        coord.board.upsert(DownloadJob { state: JobState::Ready { track_id: "1".to_string() }, ..job });

        fake.push_enqueue(Ok(()));
        let job_id2 = coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();

        assert_eq!(job_id2, job_id, "job_id continua deterministico (mesmo username+filename)");
        assert_eq!(
            fake.enqueue_calls.lock().unwrap().len(),
            2,
            "job recriado a partir de Ready deveria ter enfileirado de novo"
        );
        assert!(
            matches!(coord.board.get(&job_id).unwrap().state, JobState::Enqueued { .. }),
            "apos recriar e reenfileirar, o job devia estar Enqueued, nao preso em Ready"
        );
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
        // MAX_ACTIVE_SOULSEEK.
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
            coord.board.upsert(mk_job(
                &format!("busy{i}"),
                &format!("busy_peer{i}"),
                &format!("Busy{i}.flac"),
                1,
                JobState::Downloading { pct: 1.0, bps: 1, eta_s: None },
            ));
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
        // Formato LEGADO do slsk_jobs.json (username/remote_filename soltos,
        // sem `source`): o boot reconstrói a origem Soulseek.
        let legacy = serde_json::json!([{
            "job_id": "abc123",
            "username": "peer1",
            "remote_filename": "Artist\\Title.flac",
            "dest_playlist": "Trance",
            "alternates": [],
            "quality_label": "FLAC 16/44",
            "created_at": unix_now(),
        }]);
        std::fs::write(&jobs_path, legacy.to_string()).unwrap();

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
        assert_eq!(job.soulseek(), Some(("peer1", "Artist\\Title.flac", 0)));
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
            source: Source::Soulseek {
                username: "peer1".to_string(),
                remote_filename: "Artist\\Album\\01 - Title.flac".to_string(),
                size: 1000,
            },
            username: String::new(),
            remote_filename: String::new(),
            meta: ConfirmedMeta::default(),
            artwork_url: None,
            tracks: 1,
            dest_playlist: "Trance".to_string(),
            alternates: vec![],
            quality_label: "FLAC 16/44".to_string(),
            waiting: None,
            waiting_since_unix: None,
            format_in: None,
            indexing_path: None,
            attempt: 0,
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
        // IM-10b (ajustado pelo NB-2 do fix round 2): slskd cai -> apos
        // DOWNLOADS_FAIL_THRESHOLD falhas CONSECUTIVAS, jobs Enqueued/
        // Downloading/Stalled viram Failed{retryable}. Uma falha ISOLADA
        // (abaixo do threshold) nao pode derrubar nada.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.push_enqueue(Ok(()));
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();
        let cand = candidate("peer1", "Artist\\Title.flac", 1000);
        let job_id = coord.start_download(&cand, vec![], "Rap & Hip-Hop", now).unwrap();

        for i in 0..(DOWNLOADS_FAIL_THRESHOLD - 1) {
            fake.downloads_script.lock().unwrap().push_back(Err(SlskdError::Network("offline".to_string())));
            coord.poll_active_transfers_once(now + Duration::from_secs(i as u64 + 1));
            assert!(
                matches!(coord.board.get(&job_id).unwrap().state, JobState::Enqueued { .. }),
                "abaixo do threshold de falhas consecutivas ainda nao pode falhar"
            );
        }

        fake.downloads_script.lock().unwrap().push_back(Err(SlskdError::Network("offline".to_string())));
        coord.poll_active_transfers_once(now + Duration::from_secs(DOWNLOADS_FAIL_THRESHOLD as u64 + 1));

        match coord.board.get(&job_id).unwrap().state {
            JobState::Failed { retryable: true, .. } => {}
            other => panic!("esperava Failed{{retryable:true}} apos o threshold, veio {other:?}"),
        }
    }

    #[test]
    fn poll_does_not_fail_processing_or_indexing_jobs_when_slskd_unreachable() {
        // NB-2: Processing (localizando localmente) e Indexing (retentando
        // o Qdrant) nao dependem mais do slskd nesse ponto do pipeline —
        // um blip do slskd nao pode derrubar uma faixa ja staged em
        // ~/Music so esperando o Qdrant voltar.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();

        coord.board.upsert(DownloadJob {
            created_at: unix_now(),
            ..mk_job("indexing1", "peer1", "Artist\\Title.flac", 1000, JobState::Indexing)
        });

        for i in 0..(DOWNLOADS_FAIL_THRESHOLD + 2) {
            fake.downloads_script.lock().unwrap().push_back(Err(SlskdError::Network("offline".to_string())));
            coord.poll_active_transfers_once(now + Duration::from_secs(i as u64 + 1));
        }

        assert!(
            matches!(coord.board.get("indexing1").unwrap().state, JobState::Indexing),
            "job em Indexing nao deveria ser afetado por falhas de downloads(), mesmo muitas"
        );
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

        // Fonte alternativa hi-res: o rótulo de qualidade do job precisa
        // acompanhar a troca (aba Fila mostra o rótulo da fonte ATUAL).
        let alt = slskd_client::rank::Candidate {
            bit_depth: Some(24),
            sample_rate: Some(96_000),
            ..candidate("peer2", "Artist\\Title.flac", 1000)
        };
        let cand = candidate("peer1", "Artist\\Title.flac", 1000);
        let job_id = coord.start_download(&cand, vec![alt], "Rap & Hip-Hop", now).unwrap();
        assert_eq!(coord.board.get(&job_id).unwrap().quality_label, "FLAC 16/44");

        let result = coord.try_other_source(&job_id, now + Duration::from_secs(1));
        assert!(result.is_ok());
        let job = coord.board.get(&job_id).unwrap();
        assert_eq!(job.soulseek().unwrap().0, "peer2");
        assert_eq!(job.tried_source_ids.len(), 1);
        assert_eq!(job.quality_label, "FLAC 24/96");
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
        let (job_id, _) = coord.create_or_get_soulseek_job(&cand, vec![alt], "Rap & Hip-Hop");
        coord.board.upsert(DownloadJob {
            state: JobState::Failed { reason: "x".to_string(), retryable: false },
            ..coord.board.get(&job_id).unwrap()
        });

        let result = coord.try_other_source(&job_id, now);
        assert!(result.is_ok(), "deveria funcionar a partir de Failed: {result:?}");
        assert_eq!(coord.board.get(&job_id).unwrap().soulseek().unwrap().0, "peer2");
    }

    #[test]
    fn clear_finished_persists_and_returns_count() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        let coord = make_coordinator(tmp.path(), fake);
        coord.board.upsert(mk_job("j1", "u", "f", 0, JobState::Ready { track_id: "1".to_string() }));
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

        // NB-3: started_at/next_poll_at agora são carimbados DENTRO de
        // handle_search (depois do start_search), não com o `now` capturado
        // antes de chamá-lo — então pollar com esse `now` antigo poderia
        // cair antes de `next_poll_at` e não pollar nada. Usa um instante
        // fresco, capturado depois de handle_search já ter retornado.
        coord.poll_active_search_once(Instant::now());
        let snapshot = coord.searches.read().unwrap().snapshot(&search_id).unwrap();
        assert_eq!(snapshot.groups.len(), 1);
        // A query pedia "live" explicitamente -> NAO deveria levar o
        // warn de derank (prova que rank::aggregate recebeu a query real,
        // nao "").
        assert_ne!(snapshot.groups[0].best.warn.as_deref(), Some("parece live"));
    }

    #[test]
    fn pacer_outcome_e_por_busca_fechada_nao_por_poll() {
        // Bug de produção (teste real do usuário, 2026-08-07): os primeiros
        // ticks de TODA busca vêm com 0 respostas (a rede demora segundos) e
        // cada poll de 700ms contava um strike no pacer — 3 ticks armavam
        // cold e os seguintes dobravam a penalidade até 60 min, mesmo a
        // busca terminando COM resultado. O outcome do §6.2 é da BUSCA
        // ("3 buscas vazias seguidas"), registrado só no fim da janela.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        fake.start_search_script.lock().unwrap().push_back(Ok("remote-1".to_string()));
        // 4 polls com a rede ainda calada...
        for _ in 0..4 {
            fake.search_responses_script.lock().unwrap().push_back(Ok(vec![]));
        }
        // ...e a resposta chega antes da janela fechar.
        fake.search_responses_script.lock().unwrap().push_back(Ok(vec![ApiSearchResponse {
            username: "peer1".to_string(),
            file_count: 1,
            files: vec![slskd_client::wire::ApiFile {
                filename: "Sidoka - UFA.flac".to_string(),
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

        let (r1_tx, r1_rx) = crossbeam_channel::bounded(1);
        let t0 = Instant::now();
        coord.handle_search("sidoka".to_string(), false, t0, r1_tx);
        r1_rx.recv().unwrap().unwrap();

        // Polls dentro da janela, espaçados de SEARCH_POLL (base fresca —
        // started_at é carimbado dentro de handle_search, ver NB-3).
        let base = Instant::now();
        for k in 1..=4u32 {
            coord.poll_active_search_once(base + SEARCH_POLL * k + Duration::from_millis(50));
        }
        // Fecha a janela com a resposta presente.
        coord.poll_active_search_once(base + SEARCH_WINDOW + Duration::from_secs(1));

        // Busca seguinte, bem depois do intervalo mínimo: a anterior fechou
        // COM resultado, então NUNCA pode vir "cold".
        fake.start_search_script.lock().unwrap().push_back(Ok("remote-2".to_string()));
        let (r2_tx, r2_rx) = crossbeam_channel::bounded(1);
        coord.handle_search("sidoka mob".to_string(), false, base + SEARCH_WINDOW + Duration::from_secs(10), r2_tx);
        let second = r2_rx.recv().unwrap();
        assert!(second.is_ok(), "segunda busca bloqueada pelo pacer: {:?}", second.err());
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

    #[test]
    fn active_search_window_not_consumed_by_slow_sweep() {
        // NB-3: started_at precisa ser carimbado DEPOIS do sweep+
        // start_search, nao no `now` de handle_task (capturado antes dos
        // dois). Prova: segura list_searches (chamado por ensure_swept)
        // por ~300ms via rendezvous; se started_at fosse carimbado antes
        // disso, o elapsed_ms reportado no poll imediatamente apos seria
        // proximo de 300ms; com o fix, e proximo de 0 (o relogio so
        // comeca a contar depois do gate liberar).
        struct SlowSweepApi {
            gate_rx: StdMutex<crossbeam_channel::Receiver<()>>,
        }
        impl SlskdApi for SlowSweepApi {
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
        let api: Arc<dyn SlskdApi> = Arc::new(SlowSweepApi { gate_rx: StdMutex::new(gate_rx) });
        let coord = Arc::new(make_coordinator(tmp.path(), api));

        let (reply_tx, reply_rx) = crossbeam_channel::bounded(1);
        let coord2 = coord.clone();
        let handle = std::thread::spawn(move || {
            coord2.handle_search("query".to_string(), false, Instant::now(), reply_tx);
        });
        let search_id = reply_rx.recv().unwrap().unwrap();

        std::thread::sleep(Duration::from_millis(300));
        gate_tx.send(()).unwrap();
        handle.join().unwrap();

        coord.poll_active_search_once(Instant::now());
        let snapshot = coord.searches.read().unwrap().snapshot(&search_id).unwrap();
        assert!(
            snapshot.elapsed_ms < 100,
            "started_at deveria ser carimbado apos o sweep (que levou ~300ms), elapsed_ms={}",
            snapshot.elapsed_ms
        );
    }

    // ── Fontes externas (plano Crate fase 1, Task 2) ───────────────────

    fn test_coordinator() -> (Coordinator, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let c = make_coordinator(tmp.path(), Arc::new(FakeSlskd::new()));
        (c, tmp)
    }

    /// Segundo coordinator sobre o MESMO diretório (mesmo `slsk_jobs.json`).
    fn test_coordinator_at(dir: &Path) -> (Coordinator, ()) {
        (make_coordinator(dir, Arc::new(FakeSlskd::new())), ())
    }

    fn fixture_flac() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("crates/audio-engine/tests/fixtures/track_01.flac")
    }

    fn sc_source(id: u64) -> Source {
        Source::SoundCloud { track_id: id, permalink_url: format!("https://soundcloud.com/a/{id}") }
    }

    /// Tentativa atual do job (o worker devolve em todo evento).
    fn att(c: &Coordinator, id: &str) -> u32 {
        c.board.get(id).expect("job existe").attempt
    }

    fn meta(artist: &str, title: &str) -> ConfirmedMeta {
        ConfirmedMeta { artist: artist.into(), title: title.into(), album: title.into(), year: Some(2024), label: None }
    }

    #[test]
    fn download_external_e_idempotente() {
        let (c, _tmp) = test_coordinator();
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (_etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = c.with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        let (r1, rx1) = crossbeam_channel::bounded(1);
        c.handle_task(SlskTask::DownloadExternal { source: sc_source(7), meta: meta("DJ Arana", "Festa"), artwork_url: None, dest: "Funk Brasileiro".into(), reply: r1 });
        let id1 = rx1.recv().unwrap().unwrap();
        let (r2, rx2) = crossbeam_channel::bounded(1);
        c.handle_task(SlskTask::DownloadExternal { source: sc_source(7), meta: meta("DJ Arana", "Festa"), artwork_url: None, dest: "Funk Brasileiro".into(), reply: r2 });
        let id2 = rx2.recv().unwrap().unwrap();
        assert_eq!(id1, id2);
        assert_eq!(frx.try_iter().count(), 1, "um único FetchTask para o worker");
        let job = c.board.get(&id1).unwrap();
        assert_eq!(job.state, JobState::Enqueued { queue_position: None });
        assert_eq!(job.meta.artist, "DJ Arana");
    }

    #[test]
    fn download_external_valida_destino_e_meta() {
        let (c, _tmp) = test_coordinator();
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (_etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = c.with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        let (r, rx) = crossbeam_channel::bounded(1);
        c.handle_task(SlskTask::DownloadExternal { source: sc_source(8), meta: meta("A", "T"), artwork_url: None, dest: "../x".into(), reply: r });
        assert!(rx.recv().unwrap().is_err());
        let (r, rx) = crossbeam_channel::bounded(1);
        c.handle_task(SlskTask::DownloadExternal { source: sc_source(8), meta: meta("  ", "T"), artwork_url: None, dest: "P".into(), reply: r });
        assert!(rx.recv().unwrap().is_err());
        assert_eq!(frx.try_iter().count(), 0);
        assert!(c.board.snapshot().is_empty());
    }

    #[test]
    fn eventos_do_worker_movem_o_job() {
        let (c, tmp) = test_coordinator();
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = c.with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        let (r, rx) = crossbeam_channel::bounded(1);
        c.handle_task(SlskTask::DownloadExternal { source: sc_source(1), meta: meta("A", "T"), artwork_url: None, dest: "P".into(), reply: r });
        let id = rx.recv().unwrap().unwrap();
        etx.send(FetchEvent::Progress { job_id: id.clone(), attempt: att(&c, &id), pct: 40.0, bps: 1000, eta_s: Some(3) }).unwrap();
        c.drain_fetch_events(Instant::now());
        assert!(matches!(c.board.get(&id).unwrap().state, JobState::Downloading { pct, .. } if (pct - 40.0).abs() < 0.01));
        // Done com um FLAC real de fixture → stage_and_ingest → Indexing/Ready pelo ingest falso
        let flac = fetched_flac(&c, &frx.try_recv().unwrap());
        etx.send(FetchEvent::Done { job_id: id.clone(), attempt: att(&c, &id), flac_path: flac, format_in: FormatIn::Wav16 }).unwrap();
        c.drain_fetch_events(Instant::now());
        let job = c.board.get(&id).unwrap();
        // O ingest falso sempre devolve Ok: tem de chegar a Ready, com o
        // arquivo na pasta canônica da playlist.
        assert!(matches!(job.state, JobState::Ready { .. }), "estado: {:?}", job.state);
        assert_eq!(job.format_in, Some(FormatIn::Wav16));
        assert_eq!(flacs_under(&tmp.path().join("Music").join("P")).len(), 1, "FLAC em Music/P");
    }

    #[test]
    fn done_de_job_cancelado_nao_entra_no_acervo() {
        let (c, tmp) = test_coordinator();
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = c.with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        let (r, rx) = crossbeam_channel::bounded(1);
        c.handle_task(SlskTask::DownloadExternal { source: sc_source(4), meta: meta("A", "T"), artwork_url: None, dest: "P".into(), reply: r });
        let id = rx.recv().unwrap().unwrap();
        c.handle_task(SlskTask::CancelJob { job_id: id.clone() });
        assert_eq!(c.board.get(&id).unwrap().state, JobState::Canceled);
        let flac = fetched_flac(&c, &frx.try_recv().unwrap());
        etx.send(FetchEvent::Done { job_id: id.clone(), attempt: att(&c, &id), flac_path: flac.clone(), format_in: FormatIn::Flac }).unwrap();
        c.drain_fetch_events(Instant::now());
        assert_eq!(c.board.get(&id).unwrap().state, JobState::Canceled);
        assert!(!flac.exists(), "o FLAC pronto de job cancelado é descartado");
        assert!(!tmp.path().join("Music").join("P").exists(), "nada entra no acervo");
    }

    #[test]
    fn rejected_do_worker_vira_rejected_no_board() {
        let (c, _tmp) = test_coordinator();
        let (ftx, _frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = c.with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        let (r, rx) = crossbeam_channel::bounded(1);
        c.handle_task(SlskTask::DownloadExternal { source: sc_source(2), meta: meta("A", "T"), artwork_url: None, dest: "P".into(), reply: r });
        let id = rx.recv().unwrap().unwrap();
        etx.send(FetchEvent::Rejected { job_id: id.clone(), attempt: att(&c, &id), reason: RejectReason::LowBitrate { kbps: 128 }, quarantine: None }).unwrap();
        c.drain_fetch_events(Instant::now());
        assert_eq!(c.board.get(&id).unwrap().state, JobState::Rejected { reason: RejectReason::LowBitrate { kbps: 128 } });
    }

    #[test]
    fn teto_do_soundcloud_deixa_o_excedente_queued() {
        let (c, _tmp) = test_coordinator();
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (_etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = c.with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        for i in 0..4u64 {
            let (r, rx) = crossbeam_channel::bounded(1);
            c.handle_task(SlskTask::DownloadExternal { source: sc_source(10 + i), meta: meta("A", &format!("T{i}")), artwork_url: None, dest: "P".into(), reply: r });
            rx.recv().unwrap().unwrap();
        }
        assert_eq!(frx.try_iter().count(), MAX_ACTIVE_SOUNDCLOUD, "só 2 vão para o worker; os outros ficam Queued");
        let queued = c.board.snapshot().into_iter().filter(|j| j.state == JobState::Queued).count();
        assert_eq!(queued, 2);
    }

    #[test]
    fn fila_do_worker_cheia_deixa_queued_sem_travar() {
        // try_send falhando (fila cheia) não pode prender o promote num loop:
        // o job fica Queued e o próximo tick tenta de novo.
        let (c, _tmp) = test_coordinator();
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(1);
        let (_etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = c.with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        for i in 0..2u64 {
            let (r, rx) = crossbeam_channel::bounded(1);
            c.handle_task(SlskTask::DownloadExternal { source: sc_source(20 + i), meta: meta("A", &format!("T{i}")), artwork_url: None, dest: "P".into(), reply: r });
            rx.recv().unwrap().unwrap();
        }
        let states: Vec<JobState> = c.board.snapshot().into_iter().map(|j| j.state).collect();
        assert_eq!(states.iter().filter(|s| **s == JobState::Queued).count(), 1);
        assert_eq!(frx.try_iter().count(), 1);
        c.drain_fetch_events(Instant::now());
        assert_eq!(frx.try_iter().count(), 1, "vaga na fila do worker: o Queued é despachado no tick");
    }

    #[test]
    fn slskd_fora_do_ar_nao_falha_job_externo() {
        let (c, _tmp) = test_coordinator();
        let (ftx, _frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (_etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = c.with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        let (r, rx) = crossbeam_channel::bounded(1);
        c.handle_task(SlskTask::DownloadExternal { source: sc_source(3), meta: meta("A", "T"), artwork_url: None, dest: "P".into(), reply: r });
        let id = rx.recv().unwrap().unwrap();
        c.fail_network_dependent_jobs("slskd inalcancavel");
        assert_eq!(c.board.get(&id).unwrap().state, JobState::Enqueued { queue_position: None });
    }

    #[test]
    fn persisted_job_externo_volta_queued_no_boot() {
        let (c, tmp) = test_coordinator();
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (_etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = c.with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        let (r, rx) = crossbeam_channel::bounded(1);
        let capa = Some("https://i1.sndcdn.com/artworks-abc-large.jpg".to_string());
        c.handle_task(SlskTask::DownloadExternal { source: sc_source(5), meta: meta("A", "T"), artwork_url: capa.clone(), dest: "P".into(), reply: r });
        let id = rx.recv().unwrap().unwrap();
        let tasks: Vec<FetchTask> = frx.try_iter().collect();
        assert_eq!(tasks[0].artwork_url, capa, "a capa do card chega ao worker");
        c.board.transition(&id, JobState::Downloading { pct: 10.0, bps: 1, eta_s: None });
        c.save_jobs();
        // segundo coordinator lendo o mesmo jobs_path
        let (c2, _) = test_coordinator_at(tmp.path());
        let (ftx2, frx2) = crossbeam_channel::bounded::<FetchTask>(16);
        let (_e2, erx2) = crossbeam_channel::unbounded::<FetchEvent>();
        let c2 = c2.with_fetch_worker("sound_cloud", ftx2).with_fetch_events(erx2);
        c2.reconcile_boot(unix_now());
        let job = c2.board.get(&id).expect("job restaurado");
        assert_eq!(job.meta.artist, "A");
        assert!(matches!(job.state, JobState::Queued | JobState::Enqueued { .. }));
        assert_eq!(job.artwork_url, capa, "a capa sobrevive ao reinício");
        let tasks2: Vec<FetchTask> = frx2.try_iter().collect();
        assert_eq!(tasks2.len(), 1, "re-despachado ao worker no boot");
        assert_eq!(tasks2[0].artwork_url, capa);
    }

    #[test]
    fn persisted_waiting_e_restaurado_como_esta() {
        let (c, tmp) = test_coordinator();
        let src = Source::Bandcamp { item_type: "a".into(), item_id: 9, url: "https://x.bandcamp.com/album/y".into() };
        let id = super::super::board::job_id(&src);
        c.board.upsert(DownloadJob {
            job_id: id.clone(),
            source: src,
            meta: meta("A", "Y"),
            artwork_url: None,
            format_in: None,
            tracks: 3,
            display: "A - Y".into(),
            dest_playlist: "P".into(),
            state: JobState::Waiting { reason: WaitReason::Purchase, url: "https://x.bandcamp.com/album/y".into(), since_secs: 5 },
            quality_label: String::new(),
            alternates: vec![],
            tried_source_ids: vec![],
            created_at: unix_now(),
            attempt: 0,
        });
        c.save_jobs();
        let (c2, _) = test_coordinator_at(tmp.path());
        let (ftx2, frx2) = crossbeam_channel::bounded::<FetchTask>(16);
        let (_e2, erx2) = crossbeam_channel::unbounded::<FetchEvent>();
        let c2 = c2.with_fetch_worker("sound_cloud", ftx2).with_fetch_events(erx2);
        c2.reconcile_boot(unix_now());
        let job = c2.board.get(&id).expect("job restaurado");
        assert!(matches!(job.state, JobState::Waiting { reason: WaitReason::Purchase, .. }), "estado: {:?}", job.state);
        assert_eq!(job.tracks, 3);
        // Sem asserção sobre o worker de propósito: na fase 2 (Bandcamp,
        // spec §6.2) quem consulta a `collection` durante a espera é o
        // worker, e o boot (ou um tick do coordinator) vai precisar
        // reentregar a ele os jobs em `Waiting`. Hoje nada é despachado.
        let _ = frx2;
    }

    // ── Correções do review das Tasks 1 e 2 ────────────────────────────

    /// Coordinator com o worker do SoundCloud ligado.
    fn wired(cap: usize) -> (Coordinator, tempfile::TempDir, Receiver<FetchTask>, Sender<FetchEvent>) {
        let (c, tmp) = test_coordinator();
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(cap);
        let (etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        (c.with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx), tmp, frx, etx)
    }

    fn external(c: &Coordinator, source: Source, m: ConfirmedMeta, dest: &str) -> Result<String, String> {
        let (r, rx) = crossbeam_channel::bounded(1);
        c.handle_task(SlskTask::DownloadExternal { source, meta: m, artwork_url: None, dest: dest.into(), reply: r });
        rx.recv().unwrap()
    }

    /// FLAC de fixture no incoming, com o nome que o worker usa para a tentativa.
    fn fetched_flac(c: &Coordinator, task: &FetchTask) -> PathBuf {
        let dir = c.cfg.music_root.join(stage::INCOMING_DIR_NAME);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{}.flac", task.file_stem()));
        std::fs::copy(fixture_flac(), &p).unwrap();
        p
    }

    fn flacs_under(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Ok(rd) = std::fs::read_dir(dir) else { return out };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(flacs_under(&p));
            } else if p.extension().and_then(|x| x.to_str()) == Some("flac") {
                out.push(p);
            }
        }
        out
    }

    #[test]
    fn eventos_de_tentativa_antiga_sao_ignorados_apos_recriar() {
        // Cancelar e clicar Baixar de novo com o metadado corrigido: o Done e o
        // Failed da tentativa velha não podem tocar na tentativa nova.
        let (c, tmp, frx, etx) = wired(16);
        let id = external(&c, sc_source(30), meta("A", "Errado"), "P").unwrap();
        let velha = frx.try_recv().expect("FetchTask da tentativa velha");
        c.handle_task(SlskTask::CancelJob { job_id: id.clone() });
        let id2 = external(&c, sc_source(30), meta("A", "Certo"), "P").unwrap();
        assert_eq!(id, id2);
        let nova = frx.try_recv().expect("FetchTask da tentativa nova");
        assert_ne!(velha.attempt, nova.attempt);
        assert_ne!(velha.file_stem(), nova.file_stem(), "tentativas não dividem arquivo no incoming");
        assert_eq!(nova.meta.title, "Certo");
        assert!(c.board.is_canceled(&id, velha.attempt), "o worker da tentativa velha vê o cancelamento");
        assert!(!c.board.is_canceled(&id, nova.attempt));

        // Failed{"cancelado"} velho: ignorado, a tentativa nova segue Enqueued.
        etx.send(FetchEvent::Failed { job_id: id.clone(), attempt: velha.attempt, reason: "cancelado".into(), retryable: false }).unwrap();
        // Done velho: ignorado, e o FLAC dele é descartado.
        let flac_velho = fetched_flac(&c, &velha);
        etx.send(FetchEvent::Done { job_id: id.clone(), attempt: velha.attempt, flac_path: flac_velho.clone(), format_in: FormatIn::Wav16 }).unwrap();
        c.drain_fetch_events(Instant::now());
        assert_eq!(c.board.get(&id).unwrap().state, JobState::Enqueued { queue_position: None });
        assert!(!flac_velho.exists(), "FLAC da tentativa velha descartado");
        assert!(flacs_under(&tmp.path().join("Music").join("P")).is_empty(), "nada da tentativa velha entra no acervo");

        // Done da tentativa nova: entra.
        let flac_novo = fetched_flac(&c, &nova);
        etx.send(FetchEvent::Done { job_id: id.clone(), attempt: nova.attempt, flac_path: flac_novo, format_in: FormatIn::Wav16 }).unwrap();
        c.drain_fetch_events(Instant::now());
        assert!(matches!(c.board.get(&id).unwrap().state, JobState::Ready { .. }), "{:?}", c.board.get(&id).unwrap().state);
        assert_eq!(flacs_under(&tmp.path().join("Music").join("P")).len(), 1, "só o FLAC da tentativa nova");
    }

    #[test]
    fn limpar_concluidos_e_recriar_nao_reaproveita_tentativa() {
        let (c, _tmp, frx, _etx) = wired(16);
        let id = external(&c, sc_source(31), meta("A", "T"), "P").unwrap();
        let velha = frx.try_recv().unwrap();
        c.handle_task(SlskTask::CancelJob { job_id: id.clone() });
        let (r, rx) = crossbeam_channel::bounded(1);
        c.handle_task(SlskTask::ClearFinished { reply: r });
        assert_eq!(rx.recv().unwrap(), 1);
        assert!(c.board.is_canceled(&id, velha.attempt), "job removido conta como cancelado");
        external(&c, sc_source(31), meta("A", "T"), "P").unwrap();
        let nova = frx.try_recv().unwrap();
        assert_ne!(velha.attempt, nova.attempt, "tentativa nova mesmo depois de o job sair do board");
        assert!(c.board.is_canceled(&id, velha.attempt));
    }

    #[test]
    fn download_external_recusa_origem_soulseek() {
        let (c, _tmp, frx, _etx) = wired(16);
        // Job Soulseek legítimo esperando vaga: não pode ir ao worker externo.
        c.board.upsert(mk_job("slsk-q", "peer", "a.flac", 10, JobState::Queued));
        let r = external(&c, Source::Soulseek { username: "u".into(), remote_filename: "f.flac".into(), size: 1 }, meta("A", "T"), "P");
        assert_eq!(r, Err("origem não aceita por este caminho".to_string()));
        c.promote_external("soulseek");
        assert_eq!(c.board.get("slsk-q").unwrap().state, JobState::Queued);
        assert_eq!(frx.try_iter().count(), 0);
    }

    #[test]
    fn origem_sem_worker_falha_como_nao_suportada() {
        let (c, _tmp, frx, _etx) = wired(16);
        let bc = Source::Bandcamp { item_type: "a".into(), item_id: 1, url: "https://x.bandcamp.com/album/y".into() };
        let id = external(&c, bc, meta("A", "Y"), "P").unwrap();
        assert_eq!(
            c.board.get(&id).unwrap().state,
            JobState::Failed { reason: "fonte ainda não suportada".into(), retryable: false }
        );
        assert_eq!(frx.try_iter().count(), 0, "job do Bandcamp não vai para o worker do SoundCloud");
    }

    #[test]
    fn worker_desconectado_falha_com_texto_em_portugues() {
        let (c, _tmp, frx, _etx) = wired(16);
        drop(frx);
        let id = external(&c, sc_source(32), meta("A", "T"), "P").unwrap();
        assert_eq!(
            c.board.get(&id).unwrap().state,
            JobState::Failed { reason: "o download da fonte externa foi interrompido".into(), retryable: true }
        );
    }

    #[test]
    fn poll_nao_consulta_slskd_com_so_jobs_externos() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        let (ftx, _frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (_etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = make_coordinator(tmp.path(), fake.clone()).with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        external(&c, sc_source(33), meta("A", "T"), "P").unwrap();
        fake.downloads_script.lock().unwrap().push_back(Err(SlskdError::Network("offline".to_string())));
        c.poll_active_transfers_once(Instant::now());
        assert_eq!(fake.downloads_script.lock().unwrap().len(), 1, "sem job Soulseek em voo, o slskd não é consultado");
        // Com um job Soulseek em voo, consulta.
        c.board.upsert(mk_job("s1", "peer", "a.flac", 10, JobState::Enqueued { queue_position: None }));
        c.poll_active_transfers_once(Instant::now());
        assert!(fake.downloads_script.lock().unwrap().is_empty());
    }

    #[test]
    fn started_e_failed_do_worker_movem_o_job() {
        let (c, _tmp, _frx, etx) = wired(16);
        let id = external(&c, sc_source(34), meta("A", "T"), "P").unwrap();
        etx.send(FetchEvent::Started { job_id: id.clone(), attempt: att(&c, &id) }).unwrap();
        c.drain_fetch_events(Instant::now());
        assert_eq!(c.board.get(&id).unwrap().state, JobState::Downloading { pct: 0.0, bps: 0, eta_s: None });
        etx.send(FetchEvent::Failed { job_id: id.clone(), attempt: att(&c, &id), reason: "token do SoundCloud recusado".into(), retryable: false }).unwrap();
        c.drain_fetch_events(Instant::now());
        assert_eq!(
            c.board.get(&id).unwrap().state,
            JobState::Failed { reason: "token do SoundCloud recusado".into(), retryable: false }
        );
    }

    #[test]
    fn terminal_libera_vaga_e_promove_o_queued() {
        let (c, _tmp, frx, etx) = wired(16);
        let ids: Vec<String> = (0..3u64)
            .map(|i| external(&c, sc_source(40 + i), meta("A", &format!("T{i}")), "P").unwrap())
            .collect();
        assert_eq!(frx.try_iter().count(), MAX_ACTIVE_SOUNDCLOUD);
        assert_eq!(c.board.get(&ids[2]).unwrap().state, JobState::Queued);
        etx.send(FetchEvent::Failed { job_id: ids[0].clone(), attempt: att(&c, &ids[0]), reason: "x".into(), retryable: true }).unwrap();
        c.drain_fetch_events(Instant::now());
        let promovido: Vec<FetchTask> = frx.try_iter().collect();
        assert_eq!(promovido.len(), 1);
        assert_eq!(promovido[0].job_id, ids[2]);
        assert_eq!(c.board.get(&ids[2]).unwrap().state, JobState::Enqueued { queue_position: None });
    }

    #[test]
    fn teto_com_soulseek_e_soundcloud_juntos() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (_etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = make_coordinator(tmp.path(), fake.clone()).with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        let now = Instant::now();
        // Soulseek no teto (3 em voo) não tira vaga do SoundCloud...
        for i in 0..MAX_ACTIVE_SOULSEEK {
            c.start_download(&candidate("peer", &format!("A\\T{i}.flac"), 100), vec![], "P", now).unwrap();
        }
        let slsk_queued = c.start_download(&candidate("peer", "A\\Extra.flac", 100), vec![], "P", now).unwrap();
        assert_eq!(c.board.get(&slsk_queued).unwrap().state, JobState::Queued);
        for i in 0..MAX_ACTIVE_SOUNDCLOUD as u64 {
            external(&c, sc_source(50 + i), meta("A", &format!("S{i}")), "P").unwrap();
        }
        assert_eq!(frx.try_iter().count(), MAX_ACTIVE_SOUNDCLOUD);
        // ...e o SoundCloud no teto não tira vaga nem promove o Soulseek.
        let sc_queued = external(&c, sc_source(60), meta("A", "S9"), "P").unwrap();
        assert_eq!(c.board.get(&sc_queued).unwrap().state, JobState::Queued);
        assert_eq!(c.board.in_flight_count_for("soulseek"), MAX_ACTIVE_SOULSEEK);
        assert_eq!(c.board.in_flight_count_for("sound_cloud"), MAX_ACTIVE_SOUNDCLOUD);
        assert_eq!(fake.enqueue_calls.lock().unwrap().len(), MAX_ACTIVE_SOULSEEK, "nenhum enqueue extra no slskd");
        c.drain_fetch_events(now);
        assert_eq!(c.board.get(&slsk_queued).unwrap().state, JobState::Queued, "drain externo não promove Soulseek");
    }

    #[test]
    fn rejected_com_arquivo_vai_para_a_quarentena() {
        let (c, tmp, frx, etx) = wired(16);
        let id = external(&c, sc_source(35), meta("A", "T"), "P").unwrap();
        let task = frx.try_recv().unwrap();
        let raw = fetched_flac(&c, &task);
        etx.send(FetchEvent::Rejected { job_id: id.clone(), attempt: task.attempt, reason: RejectReason::LowBitrate { kbps: 128 }, quarantine: Some(raw.clone()) }).unwrap();
        c.drain_fetch_events(Instant::now());
        assert_eq!(c.board.get(&id).unwrap().state, JobState::Rejected { reason: RejectReason::LowBitrate { kbps: 128 } });
        assert!(!raw.exists(), "saiu do incoming");
        assert_eq!(flacs_under(&tmp.path().join("Music").join(".rustify-quarentena")).len(), 1, "arquivo na quarentena");
    }

    #[test]
    fn evento_recusado_nao_suja_nem_grava() {
        let (c, _tmp, _frx, etx) = wired(16);
        let id = external(&c, sc_source(36), meta("A", "T"), "P").unwrap();
        let a = att(&c, &id);
        c.handle_task(SlskTask::CancelJob { job_id: id.clone() });
        *c.dirty.lock().unwrap() = false;
        for pct in [10.0, 20.0, 30.0] {
            etx.send(FetchEvent::Progress { job_id: id.clone(), attempt: a, pct, bps: 1, eta_s: None }).unwrap();
        }
        c.drain_fetch_events(Instant::now());
        assert!(!*c.dirty.lock().unwrap(), "progresso de job cancelado não marca sujo");
    }

    #[test]
    fn job_externo_em_indexing_retoma_o_ingest_no_boot() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg(tmp.path());
        // Ingest que falha: o job fica em Indexing com o arquivo já em ~/Music.
        let failing: Box<dyn Fn(Vec<PathBuf>) -> Vec<IngestOutcome> + Send + Sync> = Box::new(|paths: Vec<PathBuf>| {
            paths.into_iter().map(|path| IngestOutcome { path, result: Err("qdrant fora".to_string()) }).collect()
        });
        let c = Coordinator::new(
            cfg,
            Arc::new(FakeSlskd::new()),
            Arc::new(JobBoard::new()),
            Arc::new(RwLock::new(SearchStore::default())),
            failing,
            Box::new(|| Ok(empty_owned_index())),
            tmp.path().join("slsk_jobs.json"),
        );
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = c.with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        let id = external(&c, sc_source(37), meta("A", "T"), "P").unwrap();
        let task = frx.try_recv().unwrap();
        let flac = fetched_flac(&c, &task);
        etx.send(FetchEvent::Done { job_id: id.clone(), attempt: task.attempt, flac_path: flac, format_in: FormatIn::Flac }).unwrap();
        c.drain_fetch_events(Instant::now());
        assert_eq!(c.board.get(&id).unwrap().state, JobState::Indexing);
        let placed = flacs_under(&tmp.path().join("Music").join("P"));
        assert_eq!(placed.len(), 1);

        // Reinício: retoma o ingest do arquivo já colocado, sem baixar de novo.
        let (c2, _) = test_coordinator_at(tmp.path());
        let (ftx2, frx2) = crossbeam_channel::bounded::<FetchTask>(16);
        let (_e2, erx2) = crossbeam_channel::unbounded::<FetchEvent>();
        let c2 = c2.with_fetch_worker("sound_cloud", ftx2).with_fetch_events(erx2);
        c2.reconcile_boot(unix_now());
        assert_eq!(c2.board.get(&id).unwrap().state, JobState::Indexing);
        assert_eq!(frx2.try_iter().count(), 0, "não volta ao worker");
        c2.poll_active_transfers_once(Instant::now());
        assert!(matches!(c2.board.get(&id).unwrap().state, JobState::Ready { .. }), "{:?}", c2.board.get(&id).unwrap().state);
        assert_eq!(flacs_under(&tmp.path().join("Music").join("P")), placed, "sem duplicata");
    }

    #[test]
    fn save_jobs_grava_campos_legados_do_soulseek() {
        let (c, tmp) = test_coordinator();
        c.board.upsert(mk_job("s1", "peer1", "A\\T.flac", 10, JobState::Enqueued { queue_position: None }));
        c.save_jobs();
        let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(tmp.path().join("slsk_jobs.json")).unwrap()).unwrap();
        assert_eq!(raw[0]["username"], "peer1");
        assert_eq!(raw[0]["remote_filename"], "A\\T.flac");
    }

    // ── Correções do segundo review das Tasks 1 e 2 ────────────────────

    #[test]
    fn poll_promove_queued_soulseek_mesmo_sem_job_em_voo_no_slskd() {
        // Desvio 3: só há job Soulseek `Queued` (os 3 que estavam em voo
        // saíram do slskd). Sem consultar o slskd, `promote_queued` nunca
        // roda e a fila trava para sempre.
        let tmp = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeSlskd::new());
        for _ in 0..MAX_ACTIVE_SOULSEEK {
            fake.push_enqueue(Ok(()));
        }
        let coord = make_coordinator(tmp.path(), fake.clone());
        let now = Instant::now();
        let em_voo: Vec<String> = (0..MAX_ACTIVE_SOULSEEK)
            .map(|i| coord.start_download(&candidate(&format!("peer{i}"), &format!("A\\T{i}.flac"), 1000), vec![], "P", now).unwrap())
            .collect();
        let fila = coord.start_download(&candidate("peer_q", "A\\Fila.flac", 1000), vec![], "P", now).unwrap();
        assert_eq!(coord.board.get(&fila).unwrap().state, JobState::Queued);

        // Dois terminam e um vai para Indexing: nenhum Soulseek fica em
        // Enqueued/Downloading/Stalled.
        for (i, id) in em_voo.iter().enumerate() {
            let job = coord.board.get(id).unwrap();
            let state = if i == 0 { JobState::Indexing } else { JobState::Ready { track_id: "1".into() } };
            coord.board.upsert(DownloadJob { state, ..job });
        }
        fake.push_enqueue(Ok(()));
        coord.poll_active_transfers_once(now);

        assert_eq!(coord.board.get(&fila).unwrap().state, JobState::Enqueued { queue_position: None });
        assert_eq!(fake.enqueue_calls.lock().unwrap().len(), MAX_ACTIVE_SOULSEEK + 1);
    }

    #[test]
    fn boot_avanca_o_contador_alem_das_tentativas_persistidas() {
        let (c, tmp) = test_coordinator();
        let src = sc_source(70);
        let id = super::super::board::job_id(&src);
        c.board.upsert(DownloadJob {
            job_id: id.clone(),
            source: src.clone(),
            meta: meta("A", "T"),
            artwork_url: None,
            format_in: None,
            tracks: 1,
            display: "A - T".into(),
            dest_playlist: "P".into(),
            state: JobState::Enqueued { queue_position: None },
            quality_label: String::new(),
            alternates: vec![],
            tried_source_ids: vec![],
            created_at: unix_now(),
            attempt: 5,
        });
        c.save_jobs();

        let (c2, _) = test_coordinator_at(tmp.path());
        let (ftx2, frx2) = crossbeam_channel::bounded::<FetchTask>(16);
        let (_e2, erx2) = crossbeam_channel::unbounded::<FetchEvent>();
        let c2 = c2.with_fetch_worker("sound_cloud", ftx2).with_fetch_events(erx2);
        c2.reconcile_boot(unix_now());
        let restaurada = frx2.try_recv().expect("re-despachado no boot");
        assert_eq!(restaurada.attempt, 5, "o boot mantém a tentativa persistida");

        // Job novo criado depois do boot: tentativa acima da persistida.
        let outro = external(&c2, sc_source(71), meta("B", "U"), "P").unwrap();
        assert!(att(&c2, &outro) > 5, "tentativa nova {} repete uma persistida", att(&c2, &outro));
        frx2.try_iter().count();

        // Cancelar e baixar de novo o job restaurado: nunca a tentativa 5.
        c2.handle_task(SlskTask::CancelJob { job_id: id.clone() });
        external(&c2, src, meta("A", "T"), "P").unwrap();
        let recriada = frx2.try_recv().expect("FetchTask da recriação");
        assert_ne!(recriada.attempt, 5);
        assert!(recriada.attempt > 5);
        assert_ne!(recriada.file_stem(), restaurada.file_stem(), "a tarefa velha e a nova não dividem arquivo");
    }

    #[test]
    fn falha_de_dedup_em_job_externo_apaga_o_arquivo_do_incoming() {
        let tmp = tempfile::tempdir().unwrap();
        let (ingest, _calls) = recording_ingest();
        let c = Coordinator::new(
            test_cfg(tmp.path()),
            Arc::new(FakeSlskd::new()),
            Arc::new(JobBoard::new()),
            Arc::new(RwLock::new(SearchStore::default())),
            ingest,
            Box::new(|| Err("qdrant fora".to_string())),
            tmp.path().join("slsk_jobs.json"),
        );
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = c.with_fetch_worker("sound_cloud", ftx).with_fetch_events(erx);
        let id = external(&c, sc_source(72), meta("A", "T"), "P").unwrap();
        let task = frx.try_recv().unwrap();
        let flac = fetched_flac(&c, &task);
        etx.send(FetchEvent::Done { job_id: id.clone(), attempt: task.attempt, flac_path: flac.clone(), format_in: FormatIn::Wav16 }).unwrap();
        c.drain_fetch_events(Instant::now());
        assert_eq!(
            c.board.get(&id).unwrap().state,
            JobState::Failed { reason: "Qdrant indisponível para checagem de dedup".into(), retryable: true }
        );
        assert!(!flac.exists(), "o FLAC da tentativa que falhou não fica no incoming");
    }

    #[test]
    fn discard_fetched_recusa_caminho_que_sai_do_incoming() {
        let (c, tmp, frx, etx) = wired(16);
        let acervo = tmp.path().join("Music").join("P");
        std::fs::create_dir_all(&acervo).unwrap();
        let faixa = acervo.join("x.flac");
        std::fs::copy(fixture_flac(), &faixa).unwrap();
        let incoming = c.cfg.music_root.join(stage::INCOMING_DIR_NAME);
        std::fs::create_dir_all(&incoming).unwrap();
        let escapando = incoming.join("..").join("P").join("x.flac");
        c.discard_fetched(&escapando);
        assert!(faixa.exists(), "`..` não pode tirar a exclusão de dentro do incoming");

        // Quarentena também só aceita arquivo de dentro do incoming.
        let id = external(&c, sc_source(73), meta("A", "T"), "P").unwrap();
        let task = frx.try_recv().unwrap();
        etx.send(FetchEvent::Rejected {
            job_id: id.clone(),
            attempt: task.attempt,
            reason: RejectReason::LowBitrate { kbps: 128 },
            quarantine: Some(escapando),
        })
        .unwrap();
        c.drain_fetch_events(Instant::now());
        assert_eq!(c.board.get(&id).unwrap().state, JobState::Rejected { reason: RejectReason::LowBitrate { kbps: 128 } });
        assert!(faixa.exists(), "arquivo do acervo não vai para a quarentena");
    }

    #[test]
    fn waiting_preserva_a_idade_entre_reinicios() {
        let (c, tmp) = test_coordinator();
        let src = Source::Bandcamp { item_type: "a".into(), item_id: 11, url: "https://x.bandcamp.com/album/z".into() };
        let id = super::super::board::job_id(&src);
        let t = unix_now();
        c.board.upsert(DownloadJob {
            job_id: id.clone(),
            source: src,
            meta: meta("A", "Z"),
            artwork_url: None,
            format_in: None,
            tracks: 1,
            display: "A - Z".into(),
            dest_playlist: "P".into(),
            state: JobState::Queued,
            quality_label: String::new(),
            alternates: vec![],
            tried_source_ids: vec![],
            created_at: t,
            attempt: 0,
        });
        // Entrou em `Waiting` 150 s antes da gravação: a idade acumulada até
        // o `save_jobs` não pode se perder.
        let w = JobState::Waiting { reason: WaitReason::Purchase, url: "https://x.bandcamp.com/album/z".into(), since_secs: 0 };
        assert!(c.board.transition_at(&id, w, t - 150));
        c.save_jobs();
        c.save_jobs(); // gravações repetidas não empurram a âncora
        let (c2, _) = test_coordinator_at(tmp.path());
        c2.reconcile_boot(t + 3600);
        assert_eq!(c2.board.waiting_since_unix(&id), Some(t - 150), "âncora restaurada como estava");
        match c2.board.get_at(&id, t + 3600).unwrap().state {
            JobState::Waiting { since_secs, .. } => {
                assert_eq!(since_secs, 3750, "idade = antes da gravação + desligado + depois do boot")
            }
            other => panic!("estado: {other:?}"),
        }
    }

    #[test]
    fn format_in_de_job_externo_sobrevive_ao_boot() {
        let (c, tmp) = test_coordinator();
        let src = sc_source(80);
        let id = super::super::board::job_id(&src);
        let music = tmp.path().join("Music").join("P");
        std::fs::create_dir_all(&music).unwrap();
        let faixa = music.join("t.flac");
        std::fs::copy(fixture_flac(), &faixa).unwrap();
        c.board.upsert(DownloadJob {
            job_id: id.clone(),
            source: src,
            meta: meta("A", "T"),
            artwork_url: None,
            format_in: Some(FormatIn::Mp3_320),
            tracks: 1,
            display: "A - T".into(),
            dest_playlist: "P".into(),
            state: JobState::Indexing,
            quality_label: String::new(),
            alternates: vec![],
            tried_source_ids: vec![],
            created_at: unix_now(),
            attempt: 0,
        });
        c.indexing_retry
            .lock()
            .unwrap()
            .insert(id.clone(), (0, Instant::now(), faixa.clone()));
        c.save_jobs();
        let (c2, _) = test_coordinator_at(tmp.path());
        c2.reconcile_boot(unix_now());
        assert_eq!(c2.board.get(&id).unwrap().format_in, Some(FormatIn::Mp3_320));
    }

    #[test]
    fn done_com_arquivo_fora_do_incoming_falha_sem_tocar_no_arquivo() {
        let (c, tmp, frx, etx) = wired(16);
        let acervo = tmp.path().join("Music").join("P");
        std::fs::create_dir_all(&acervo).unwrap();
        let faixa = acervo.join("x.flac");
        std::fs::copy(fixture_flac(), &faixa).unwrap();
        let id = external(&c, sc_source(81), meta("A", "T"), "Q").unwrap();
        let task = frx.try_recv().unwrap();
        etx.send(FetchEvent::Done { job_id: id.clone(), attempt: task.attempt, flac_path: faixa.clone(), format_in: FormatIn::Flac })
            .unwrap();
        c.drain_fetch_events(Instant::now());
        assert!(
            matches!(c.board.get(&id).unwrap().state, JobState::Failed { retryable: false, .. }),
            "estado: {:?}",
            c.board.get(&id).unwrap().state
        );
        assert!(faixa.exists(), "arquivo fora do incoming não é movido");
        assert!(!tmp.path().join("Music").join("Q").exists(), "nada entra no acervo");
    }

    #[test]
    fn falha_depois_do_staging_apaga_o_arquivo_renomeado_no_incoming() {
        let (c, tmp, frx, etx) = wired(16);
        // `Music/P` como ARQUIVO: o `create_dir_all` do destino falha
        // depois que o `stage_file` já renomeou para `<incoming>/<job_id>.flac`.
        std::fs::create_dir_all(tmp.path().join("Music")).unwrap();
        std::fs::write(tmp.path().join("Music").join("P"), b"x").unwrap();
        let id = external(&c, sc_source(82), meta("A", "T"), "P").unwrap();
        let task = frx.try_recv().unwrap();
        let flac = fetched_flac(&c, &task);
        etx.send(FetchEvent::Done { job_id: id.clone(), attempt: task.attempt, flac_path: flac.clone(), format_in: FormatIn::Flac })
            .unwrap();
        c.drain_fetch_events(Instant::now());
        assert!(matches!(c.board.get(&id).unwrap().state, JobState::Failed { retryable: true, .. }));
        assert!(!flac.exists());
        assert!(
            !stage::incoming_path(&c.cfg.music_root, &id).exists(),
            "o arquivo renomeado pelo staging não fica no incoming"
        );
    }

    /// Spec §8: comandos com resposta seguem abaixo de 2 s durante um download
    /// externo. O `stage_and_ingest` roda síncrono na `slsk-coord`, então o
    /// pior caso é a volta que drena os `Done`: o ingest falso leva 500 ms por
    /// chamada (o real é parse + capa + upsert no Qdrant) e chegam dois `Done`
    /// (teto do SoundCloud) no meio de uma rajada de `Progress`. Os comandos
    /// passam pelo canal real e pelo mesmo `tick` da produção.
    #[test]
    fn comandos_respondem_em_menos_de_2s_durante_download_externo() {
        const INGEST_LENTO: Duration = Duration::from_millis(500);
        const TETO: Duration = Duration::from_secs(2);
        let tmp = tempfile::tempdir().unwrap();
        let ingeridos = Arc::new(AtomicU32::new(0));
        let (ingest_tx, ingest_rx) = crossbeam_channel::unbounded::<()>();
        let ingeridos2 = ingeridos.clone();
        let ingest: Box<dyn Fn(Vec<PathBuf>) -> Vec<IngestOutcome> + Send + Sync> = Box::new(move |paths| {
            let _ = ingest_tx.send(());
            std::thread::sleep(INGEST_LENTO);
            ingeridos2.fetch_add(1, Ordering::SeqCst);
            paths.into_iter().map(|path| IngestOutcome { path, result: Ok(42) }).collect()
        });
        let owned: Box<dyn Fn() -> Result<OwnedIndex, String> + Send + Sync> = Box::new(|| Ok(empty_owned_index()));
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        let c = Arc::new(
            Coordinator::new(
                test_cfg(tmp.path()),
                Arc::new(FakeSlskd::new()),
                Arc::new(JobBoard::new()),
                Arc::new(RwLock::new(SearchStore::default())),
                ingest,
                owned,
                tmp.path().join("slsk_jobs.json"),
            )
            .with_fetch_worker("sound_cloud", ftx)
            .with_fetch_events(erx),
        );
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded::<SlskTask>();
        let loop_c = c.clone();
        let coord = std::thread::spawn(move || {
            let emit = |_: Vec<DownloadJob>| {};
            while loop_c.tick(&cmd_rx, &emit) {}
        });

        let pedir_externo = |id: u64| -> (Result<String, String>, Duration) {
            let (r, rx) = crossbeam_channel::bounded(1);
            let t0 = Instant::now();
            cmd_tx
                .send(SlskTask::DownloadExternal {
                    source: sc_source(id),
                    meta: meta("A", &format!("T{id}")),
                    artwork_url: None,
                    dest: "P".into(),
                    reply: r,
                })
                .unwrap();
            let res = rx.recv_timeout(TETO).expect("DownloadExternal sem resposta em 2 s");
            (res, t0.elapsed())
        };
        pedir_externo(1).0.unwrap();
        pedir_externo(2).0.unwrap();
        let tarefas: Vec<FetchTask> = (0..2).map(|_| frx.recv_timeout(TETO).expect("tarefa no worker")).collect();
        // Faixas diferentes (track_01 e track_02): a mesma nos dois jobs
        // cairia no dedup do staging e só uma chegaria ao ingest.
        let flacs: Vec<PathBuf> = tarefas
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let p = fetched_flac(&c, t);
                if i == 1 {
                    std::fs::copy(fixture_flac().with_file_name("track_02.flac"), &p).unwrap();
                }
                p
            })
            .collect();

        // Worker falso: rajada de Progress das duas tarefas e um Done de cada.
        let worker = std::thread::spawn(move || {
            for i in 0..2_000u32 {
                for t in &tarefas {
                    let _ = etx.send(FetchEvent::Progress {
                        job_id: t.job_id.clone(),
                        attempt: t.attempt,
                        pct: (i % 100) as f32,
                        bps: 1_000,
                        eta_s: Some(1),
                    });
                }
            }
            for (t, flac) in tarefas.iter().zip(flacs) {
                let _ = etx.send(FetchEvent::Done {
                    job_id: t.job_id.clone(),
                    attempt: t.attempt,
                    flac_path: flac,
                    format_in: FormatIn::Wav16,
                });
            }
            etx
        });

        // Os comandos saem com o ingest JÁ em curso na slsk-coord.
        ingest_rx.recv_timeout(Duration::from_secs(10)).expect("o Done chegou ao ingest");
        let (r, rx) = crossbeam_channel::bounded(1);
        let t0 = Instant::now();
        cmd_tx.send(SlskTask::ClearFinished { reply: r }).unwrap();
        rx.recv_timeout(TETO).expect("ClearFinished sem resposta em 2 s durante o ingest");
        let limpar = t0.elapsed();
        let (res, externo) = pedir_externo(3);
        res.unwrap();
        assert!(limpar < TETO, "ClearFinished levou {limpar:?}");
        assert!(externo < TETO, "DownloadExternal levou {externo:?}");

        // Os dois downloads terminam o ingest (nada ficou preso).
        let fim = Instant::now() + Duration::from_secs(10);
        while ingeridos.load(Ordering::SeqCst) < 2 && Instant::now() < fim {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(ingeridos.load(Ordering::SeqCst), 2, "os dois Done chegaram ao ingest: {:?}", c.board.snapshot().iter().map(|j| j.state.clone()).collect::<Vec<_>>());
        let _etx = worker.join().unwrap();
        drop(cmd_tx);
        coord.join().unwrap();
    }
}
