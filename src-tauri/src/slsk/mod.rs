//! slsk — política do Crate (busca + download Soulseek in-app).
//!
//! Nome do módulo é `slsk` porque `crate` é keyword reservada; o rótulo de
//! UI é **Crate**. Este módulo conhece slskd + Qdrant + Tauri — o protocolo
//! puro (testável offline) vive em `slskd-client` (crate irmão).
//!
//! Cresceu em 4 tasks (spec `docs/superpowers/specs/
//! 2026-08-07-crate-in-app-downloads-design.md`, plano
//! `.superpowers/sdd/2026-08-07-crate-v1/etapa-C-brief.md`): C1 config+board,
//! C2 stage, C3 coordinator, C4 (aqui) os 10 `#[tauri::command]` e o
//! wiring em `lib.rs` (`mod slsk;` + `app.manage(Slsk::new(...))` DEPOIS do
//! indexer existir + `generate_handler!`).

mod board;
mod config;
mod coordinator;
mod sc_worker;
mod sources;
mod stage;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use library_indexer::{IndexerHandle, OwnedIndex, Track};
use serde::Serialize;
use slskd_client::{HttpSlskd, SlskdApi};
use soundcloud_client::{Availability, HttpSoundCloud, ScError, ScTrack, SoundCloudApi};
use tauri::{AppHandle, State};

use board::{ConfirmedMeta, DownloadJob, Source};
use config::SlskConfig;
use coordinator::{FetchEvent, FetchTask, FetchWiring, SearchSnapshot, SearchState, SearchStore, SlskTask};
use sources::{SourcesConfig, SourcesStatus, TokenStatus};

/// Três estados distinguíveis (spec §3.3) — colapsá-los gera ticket de
/// suporte ("app não funciona" quando é só o slskd fora do ar).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SlskStatus {
    pub reachable: bool,
    pub logged_in: bool,
    pub network_connected: bool,
    pub message: String,
}

impl SlskStatus {
    fn unknown() -> Self {
        SlskStatus {
            reachable: false,
            logged_in: false,
            network_connected: false,
            message: "verificando conexao com o slskd...".to_string(),
        }
    }
}

fn status_message(reachable: bool, logged_in: bool, network_connected: bool) -> String {
    if !reachable {
        "o daemon Soulseek nao responde em 127.0.0.1:5030".to_string()
    } else if !logged_in {
        "credenciais do slskd recusadas".to_string()
    } else if !network_connected {
        "slskd de pe, mas fora da rede Soulseek".to_string()
    } else {
        "conectado".to_string()
    }
}

const STATUS_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// Thread dedicada, mesmo padrão de `spectrum-emitter`/`media-controls`
/// (`lib.rs`). Existe pra `slsk_status` nunca bloquear: o comando só lê o
/// cache (`Mutex`, leitura instantânea); quem bate na rede é esta thread,
/// de tempos em tempos. Deliberadamente FORA do `spawn_coordinator` da
/// Etapa C3 — aquela assinatura é fixa (sem campo de status) e a thread do
/// coordinator já tem trabalho suficiente; um poll de status separado e
/// desacoplado é mais simples que enfiar isso no loop principal.
fn spawn_status_poller(api: Arc<dyn SlskdApi>, cache: Arc<Mutex<SlskStatus>>) {
    std::thread::Builder::new()
        .name("slsk-status".to_string())
        .spawn(move || loop {
            let status = match api.status() {
                Ok(s) => SlskStatus {
                    reachable: true,
                    logged_in: s.is_logged_in,
                    network_connected: s.is_connected,
                    message: status_message(true, s.is_logged_in, s.is_connected),
                },
                Err(_) => SlskStatus {
                    reachable: false,
                    logged_in: false,
                    network_connected: false,
                    message: status_message(false, false, false),
                },
            };
            *cache.lock().unwrap_or_else(|p| p.into_inner()) = status;
            std::thread::sleep(STATUS_POLL_INTERVAL);
        })
        .expect("failed to spawn slsk-status thread");
}

/// Estado do Crate gerenciado pelo Tauri. Escritor único do `JobBoard`/
/// `SearchStore` é o coordinator (thread `slsk-coord`) — os comandos aqui
/// só leem ou mandam `SlskTask` pelo canal, nunca mutam direto (spec §3.4,
/// invariante 1: nenhum `#[tauri::command]` bloqueia).
pub struct Slsk {
    board: Arc<board::JobBoard>,
    searches: Arc<RwLock<SearchStore>>,
    status: Arc<Mutex<SlskStatus>>,
    cmd_tx: Sender<SlskTask>,
    /// Fontes externas (SoundCloud): `Arc` para os comandos `async` levarem
    /// o que precisam para dentro do `spawn_blocking`.
    ext: Arc<External>,
}

/// Validade do veredito do `me` (token aceito ou recusado). `ApiDown` nunca
/// é guardado: a próxima consulta tenta de novo.
const ME_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
/// Validade do `OwnedIndex` usado no `suggested_dest` dos resultados.
const OWNED_CACHE_TTL: Duration = Duration::from_secs(60);
/// Resultados pedidos à busca do SoundCloud (spec §3.1/§5.1: até 10).
const SC_SEARCH_LIMIT: u32 = 10;
/// Pacer do SoundCloud (spec §2.4): intervalo mínimo entre chamadas e teto
/// por hora de busca/resolução, sem período de "frio".
const SC_MIN_INTERVAL: Duration = Duration::from_secs(1);
const SC_MAX_PER_HOUR: usize = 120;
const SC_WINDOW: Duration = Duration::from_secs(3600);
/// Código estável de "sem token" devolvido por `crate_sc_probe` (arquivo
/// ilegível ou token recusado pela API); a UI compara com ele.
const NO_TOKEN: &str = "no_token";
/// Teto da capa baixada para o card e lado máximo do JPEG devolvido.
const ARTWORK_MAX_BYTES: usize = 8 * 1024 * 1024;
const ARTWORK_CARD_SIDE: u32 = 500;

/// Estado das fontes externas compartilhado entre os comandos.
struct External {
    sc_api: Arc<dyn SoundCloudApi>,
    sources: Arc<SourcesConfig>,
    me_cache: Mutex<MeCache>,
    sc_pacer: Mutex<ScPacer>,
    indexer: IndexerHandle,
    music_root: PathBuf,
    owned_cache: Mutex<Option<(Instant, Arc<OwnedIndex>)>>,
}

impl External {
    /// Status das fontes com o `me` em cache (spec §5.4: a UI consulta a
    /// cada 30 s; o SoundCloud não precisa ouvir isso).
    fn sources_status(&self) -> SourcesStatus {
        compute_with(&self.sources, |token| {
            cached_me(&self.me_cache, token, Instant::now(), |t| me_verdict(self.sc_api.me(t)))
        })
    }

    /// Consulta o pacer do SoundCloud antes de busca/resolução. Estourado,
    /// devolve erro na hora (nunca dorme na thread).
    fn pace(&self) -> Result<(), String> {
        self.sc_pacer.lock().unwrap_or_else(|p| p.into_inner()).admit(Instant::now())
    }

    /// `OwnedIndex` do `suggested_dest`, montado no máximo uma vez por
    /// comando. Falha do Qdrant vira `None`: a sugestão é conveniência, não
    /// pré-requisito.
    fn owned_index(&self) -> Option<Arc<OwnedIndex>> {
        let mut g = self.owned_cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, idx)) = g.as_ref() {
            if at.elapsed() < OWNED_CACHE_TTL {
                return Some(idx.clone());
            }
        }
        match OwnedIndex::build(self.indexer.client(), &self.music_root) {
            Ok(idx) => {
                let idx = Arc::new(idx);
                *g = Some((Instant::now(), idx.clone()));
                Some(idx)
            }
            Err(e) => {
                tracing::warn!(error = %e, "crate: OwnedIndex indisponível para suggested_dest");
                None
            }
        }
    }
}

fn to_result(owned: Option<&OwnedIndex>, t: ScTrack) -> ScResult {
    let suggested_dest = owned.and_then(|idx| idx.folder_for_artist(&t.user_name)).map(str::to_string);
    ScResult::from_track(t, suggested_dest)
}

/// Veredito do `me` em cache: `(quando, hash do token, veredito)`. O hash
/// (nunca o token) faz um token trocado no arquivo invalidar na hora.
#[derive(Default)]
struct MeCache {
    entry: Option<(Instant, u64, TokenStatus)>,
}

/// Lê o cache, solta o lock, chama `check` (rede) e só então grava: um `me`
/// lento não prende os polls seguintes no mutex. `ApiDown` nunca é guardado.
fn cached_me(cache: &Mutex<MeCache>, token: &str, now: Instant, check: impl FnOnce(&str) -> TokenStatus) -> TokenStatus {
    let key = token_hash(token);
    {
        let g = cache.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, k, st)) = g.entry.as_ref() {
            if *k == key && now.saturating_duration_since(*at) < ME_CACHE_TTL {
                return st.clone();
            }
        }
    }
    let st = check(token);
    if !matches!(st, TokenStatus::ApiDown) {
        cache.lock().unwrap_or_else(|p| p.into_inner()).entry = Some((now, key, st.clone()));
    }
    st
}

/// Pacer do SoundCloud (spec §2.4). Relógio injetado em `admit` para teste.
#[derive(Default)]
struct ScPacer {
    last: Option<Instant>,
    window: VecDeque<Instant>,
}

impl ScPacer {
    fn admit(&mut self, now: Instant) -> Result<(), String> {
        while let Some(&first) = self.window.front() {
            if now.saturating_duration_since(first) >= SC_WINDOW {
                self.window.pop_front();
            } else {
                break;
            }
        }
        let cedo = self.last.is_some_and(|l| now.saturating_duration_since(l) < SC_MIN_INTERVAL);
        if cedo || self.window.len() >= SC_MAX_PER_HOUR {
            return Err("SoundCloud: aguarde alguns segundos".to_string());
        }
        self.last = Some(now);
        self.window.push_back(now);
        Ok(())
    }
}

fn token_hash(token: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut h);
    h.finish()
}

fn me_verdict(r: Result<(), ScError>) -> TokenStatus {
    match r {
        Ok(()) => TokenStatus::TokenOk,
        Err(ScError::NoToken) => TokenStatus::NoToken,
        Err(_) => TokenStatus::ApiDown,
    }
}

/// Núcleo do status: ferramentas, identidade do Bandcamp e o token do
/// SoundCloud, cujo veredito (quando há token) vem de `check`.
fn compute_with(cfg: &SourcesConfig, check: impl FnOnce(&str) -> TokenStatus) -> SourcesStatus {
    let (ffmpeg, uv) = sources::tools_status(cfg);
    let bandcamp_identity = std::fs::metadata(&cfg.bc_identity_file).map(|m| m.len() > 0).unwrap_or(false);
    let soundcloud = match cfg.read_sc_token() {
        Ok(token) => check(&token),
        Err(_) => TokenStatus::NoToken,
    };
    SourcesStatus { soundcloud, ffmpeg, uv, bandcamp_identity }
}

/// Faixa do SoundCloud como a busca do Crate a mostra (spec §5.1).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ScResult {
    pub id: u64,
    pub title: String,
    pub permalink_url: String,
    pub user_name: String,
    pub user_permalink: String,
    pub duration_ms: u64,
    pub playback_count: u64,
    pub created_at: String,
    pub release_date: Option<String>,
    pub genre: Option<String>,
    pub artwork_url: Option<String>,
    pub availability: Availability,
    pub suggested_dest: Option<String>,
}

impl ScResult {
    fn from_track(t: ScTrack, suggested_dest: Option<String>) -> Self {
        let availability = soundcloud_client::availability(&t);
        ScResult {
            id: t.id,
            title: t.title,
            permalink_url: t.permalink_url,
            user_name: t.user_name,
            user_permalink: t.user_permalink,
            duration_ms: t.duration_ms,
            playback_count: t.playback_count,
            created_at: t.created_at,
            release_date: t.release_date,
            genre: t.genre,
            artwork_url: t.artwork_url,
            availability,
            suggested_dest,
        }
    }
}

/// Sondagem do original para o card: formato, tamanho e se pode entrar.
/// A decisão final continua sendo do `ffprobe` do arquivo baixado.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct ScProbe {
    pub ext: String,
    pub size: Option<u64>,
    pub kbps_est: Option<u32>,
    pub format_label: String,
    pub allowed: bool,
    pub reason: Option<String>,
}

/// Política de formato da spec §3.2 aplicada à sondagem (antes de baixar).
fn probe_verdict(ext: &str, size: Option<u64>, kbps_est: Option<u32>) -> ScProbe {
    let e = ext.to_ascii_lowercase();
    let (format_label, allowed, reason) = match e.as_str() {
        "flac" => ("FLAC".to_string(), true, None),
        "wav" | "wave" => ("WAV".to_string(), true, None),
        "aiff" | "aif" | "aifc" => ("AIFF".to_string(), true, None),
        "mp3" => match kbps_est {
            Some(k) if k < sc_worker::MIN_MP3_KBPS => {
                // Só o motivo: o card já mostra "MP3 {k} · não entra".
                (format!("MP3 {k}"), false, Some("abaixo de 320 kbps".to_string()))
            }
            Some(_) => ("MP3 320".to_string(), true, None),
            // Sem tamanho não há estimativa: o ffprobe decide depois de baixar.
            None => ("MP3".to_string(), true, None),
        },
        // A URL assinada do CDN não tem extensão e o `ext` vem só dos
        // headers: sem ele, quem decide é o ffprobe do arquivo baixado,
        // como faz o worker.
        "" => ("formato a confirmar".to_string(), true, None),
        other => (other.to_ascii_uppercase(), false, Some("formato não suportado".to_string())),
    };
    ScProbe { ext: e, size, kbps_est, format_label, allowed, reason }
}

/// Mensagem de erro do SoundCloud para a UI (nunca carrega o token).
fn sc_err(e: ScError) -> String {
    match e {
        ScError::NoToken => "token do SoundCloud recusado".to_string(),
        other => other.to_string(),
    }
}

/// Erro de `crate_sc_probe`: token ausente ou recusado vira o código
/// estável `NO_TOKEN`; o resto segue como texto.
fn probe_err(e: ScError) -> String {
    match e {
        ScError::NoToken => NO_TOKEN.to_string(),
        other => sc_err(other),
    }
}

/// Roda `f` fora da thread do IPC (comandos que vão à rede).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("falha interna: {e}"))?
}

impl Slsk {
    /// Chamado do `setup` do app DEPOIS do `Library`/`IndexerHandle`
    /// existirem — o coordinator injeta `ingest_paths`/`client()` direto
    /// no `IndexerHandle` real (Etapa C3). `music_root` vem de
    /// `library.music_root.clone()`, não do default calculado por
    /// `SlskConfig::load` — mesma fonte única usada no resto do app (ver
    /// nota em `config.rs`).
    pub fn new(app: AppHandle, data_dir: &Path, music_root: PathBuf, indexer: IndexerHandle) -> Self {
        let mut cfg = SlskConfig::load(data_dir);
        cfg.music_root = music_root;
        let cfg = Arc::new(cfg);

        let api: Arc<dyn SlskdApi> = Arc::new(HttpSlskd::new(cfg.base_url.clone(), cfg.auth.clone()));
        let board = Arc::new(board::JobBoard::new());
        let searches = Arc::new(RwLock::new(SearchStore::default()));
        let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded();

        let status = Arc::new(Mutex::new(SlskStatus::unknown()));
        spawn_status_poller(api.clone(), status.clone());

        let sources = Arc::new(SourcesConfig::load(data_dir));
        let user_agent = format!(
            "rustify-player/{} (+https://github.com/PedroGiudice/rustify-player)",
            env!("CARGO_PKG_VERSION")
        );
        let sc_api: Arc<dyn SoundCloudApi> =
            Arc::new(HttpSoundCloud::new(data_dir.join("soundcloud_client_id.json"), user_agent));

        // Worker do SoundCloud: `MAX_ACTIVE_SOUNDCLOUD` instâncias sobre o
        // MESMO `Receiver` (canal MPMC), uma por download simultâneo
        // permitido (spec §2.4). O Bandcamp (fase 2) não tem worker: job
        // dele vira `Failed{"fonte ainda não suportada"}` no coordinator.
        let (ftx, frx) = crossbeam_channel::bounded::<FetchTask>(16);
        let (etx, erx) = crossbeam_channel::unbounded::<FetchEvent>();
        for _ in 0..coordinator::MAX_ACTIVE_SOUNDCLOUD {
            sc_worker::spawn_sc_worker(frx.clone(), etx.clone(), sc_api.clone(), sources.clone(), board.clone());
        }
        let fetch = FetchWiring { workers: vec![("sound_cloud", ftx)], events: erx };

        let ext = Arc::new(External {
            sc_api,
            sources,
            me_cache: Mutex::new(MeCache::default()),
            sc_pacer: Mutex::new(ScPacer::default()),
            indexer: indexer.clone(),
            music_root: cfg.music_root.clone(),
            owned_cache: Mutex::new(None),
        });

        coordinator::spawn_coordinator(cfg, api, board.clone(), searches.clone(), indexer, app, cmd_rx, Some(fetch));

        Slsk { board, searches, status, cmd_tx, ext }
    }

    /// `recv_timeout` (não `recv` puro) — defesa em profundidade (review
    /// CR-1): o coordinator agora responde a `Search`/`Download`/
    /// `TryOtherSource` ANTES de qualquer I/O de rede (ver
    /// `coordinator::handle_search`/`handle_task_download`/
    /// `handle_try_other_source`), então o `recv` normal já deveria ser
    /// rápido — mas nada impede o coordinator de estar temporariamente
    /// ocupado processando um poll tick anterior quando a tarefa chega na
    /// fila. Timeout generoso (bem acima do que qualquer caminho feliz
    /// leva) garante que o comando NUNCA trava pra sempre.
    fn send_and_wait(&self, build: impl FnOnce(Sender<Result<String, String>>) -> SlskTask) -> Result<String, String> {
        let (reply_tx, reply_rx) = crossbeam_channel::bounded(1);
        self.cmd_tx
            .send(build(reply_tx))
            .map_err(|_| "coordinator indisponível".to_string())?;
        match reply_rx.recv_timeout(SEND_AND_WAIT_TIMEOUT) {
            Ok(inner) => inner,
            Err(_) => Err("coordinator não respondeu a tempo".to_string()),
        }
    }
}

const SEND_AND_WAIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

// ── Comandos IPC (spec §3.5) ────────────────────────────────────────────
// Convenção do repo: `slsk_` snake_case; argumentos chegam em camelCase do
// invoke() e o Tauri converte pro nome snake_case do parâmetro sozinho.

#[tauri::command]
pub(crate) fn slsk_status(sl: State<Slsk>) -> SlskStatus {
    sl.status.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Fire-and-forget: devolve `search_id` (ou o `Err` mapeado do
/// `PaceDecision`) em microssegundos — o pacer é só memória, sem I/O
/// (spec E2). O `start_search` de rede roda na thread `slsk-coord`, depois
/// de já ter respondido este comando.
#[tauri::command]
pub(crate) fn slsk_search(sl: State<Slsk>, query: String, force: bool) -> Result<String, String> {
    sl.send_and_wait(|reply| SlskTask::Search { query, force, reply })
}

#[tauri::command]
pub(crate) fn slsk_results(sl: State<Slsk>, search_id: String) -> SearchSnapshot {
    sl.searches
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .snapshot(&search_id)
        .unwrap_or_else(|| SearchSnapshot {
            state: SearchState::Failed,
            note: Some("busca desconhecida ou expirada".to_string()),
            ..SearchSnapshot::default()
        })
}

#[tauri::command]
pub(crate) fn slsk_cancel_search(sl: State<Slsk>, search_id: String) -> Result<(), String> {
    sl.cmd_tx
        .send(SlskTask::CancelSearch { search_id })
        .map_err(|_| "coordinator indisponível".to_string())
}

/// Camada 1 de dedup (confiável, spec §5.1): reusa `query::search` (via
/// `IndexerHandle::search`, Qdrant LOCAL — não é a rede Soulseek, então
/// não passa pelo canal do coordinator, mesmo padrão de `lib_search` em
/// `lib.rs`) com a string que o usuário digitou.
#[tauri::command]
pub(crate) fn slsk_dedup_probe(lib: State<crate::Library>, query: String) -> Vec<Track> {
    lib.handle
        .search(&query, 10)
        .map(|r| r.tracks)
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) fn slsk_download(
    sl: State<Slsk>,
    search_id: String,
    group_key: String,
    source_id: String,
    dest_playlist: String,
) -> Result<String, String> {
    sl.send_and_wait(|reply| SlskTask::Download {
        search_id,
        group_key,
        source_id,
        dest: dest_playlist,
        reply,
    })
}

#[tauri::command]
pub(crate) fn slsk_jobs(sl: State<Slsk>) -> Vec<DownloadJob> {
    sl.board.snapshot()
}

#[tauri::command]
pub(crate) fn slsk_try_other_source(sl: State<Slsk>, job_id: String) -> Result<String, String> {
    sl.send_and_wait(|reply| SlskTask::TryOtherSource { job_id, reply })
}

#[tauri::command]
pub(crate) fn slsk_cancel(sl: State<Slsk>, job_id: String) -> Result<(), String> {
    sl.cmd_tx
        .send(SlskTask::CancelJob { job_id })
        .map_err(|_| "coordinator indisponível".to_string())
}

#[tauri::command]
pub(crate) fn slsk_clear_finished(sl: State<Slsk>) -> u32 {
    let (reply_tx, reply_rx) = crossbeam_channel::bounded(1);
    if sl.cmd_tx.send(SlskTask::ClearFinished { reply: reply_tx }).is_err() {
        return 0;
    }
    reply_rx.recv_timeout(SEND_AND_WAIT_TIMEOUT).unwrap_or(0)
}

// ── Fontes externas (SoundCloud) ────────────────────────────────────────
// Os que vão à rede são `async` e rodam em `spawn_blocking`: a thread do
// IPC nunca espera o SoundCloud.

#[tauri::command]
pub(crate) async fn crate_sc_search(sl: State<'_, Slsk>, query: String) -> Result<Vec<ScResult>, String> {
    let ext = sl.ext.clone();
    blocking(move || {
        ext.pace()?;
        let tracks = ext.sc_api.search(query.trim(), SC_SEARCH_LIMIT).map_err(sc_err)?;
        let owned = ext.owned_index();
        Ok(tracks.into_iter().map(|t| to_result(owned.as_deref(), t)).collect())
    })
    .await
}

#[tauri::command]
pub(crate) async fn crate_sc_resolve(sl: State<'_, Slsk>, url: String) -> Result<ScResult, String> {
    let ext = sl.ext.clone();
    blocking(move || {
        ext.pace()?;
        let t = ext.sc_api.resolve(url.trim()).map_err(sc_err)?;
        Ok(to_result(ext.owned_index().as_deref(), t))
    })
    .await
}

#[tauri::command]
pub(crate) async fn crate_sc_probe(sl: State<'_, Slsk>, track_id: u64, duration_ms: u64) -> Result<ScProbe, String> {
    let ext = sl.ext.clone();
    blocking(move || {
        // Lido agora, só em memória: nunca em log nem na resposta.
        let token = ext.sources.read_sc_token().map_err(|_| NO_TOKEN.to_string())?;
        let orig = ext.sc_api.probe_original(track_id, &token, duration_ms).map_err(probe_err)?;
        Ok(probe_verdict(&orig.ext, orig.size, orig.kbps_est))
    })
    .await
}

/// Capa do card como data URL JPEG (a CSP não aceita host externo).
#[tauri::command]
pub(crate) async fn crate_sc_artwork(sl: State<'_, Slsk>, url: String) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("endereço de capa inválido".to_string());
    }
    let ext = sl.ext.clone();
    blocking(move || {
        let bytes = ext
            .sc_api
            .fetch_bytes(&soundcloud_client::artwork_500(&url), ARTWORK_MAX_BYTES)
            .map_err(sc_err)?;
        let jpeg = library_indexer::resize_cover_jpeg(&bytes, ARTWORK_CARD_SIDE)?;
        Ok(format!("data:image/jpeg;base64,{}", sources::base64_encode(&jpeg)))
    })
    .await
}

/// Download de fonte externa com o metadado confirmado no card. Fase 1:
/// só SoundCloud (o Soulseek segue por `slsk_download`).
#[tauri::command]
pub(crate) fn crate_download(
    sl: State<Slsk>,
    source: Source,
    meta: ConfirmedMeta,
    dest_playlist: String,
    artwork_url: Option<String>,
) -> Result<String, String> {
    match source {
        Source::SoundCloud { .. } => {}
        Source::Soulseek { .. } => return Err("origem não aceita por este caminho (Soulseek usa slsk_download)".to_string()),
        Source::Bandcamp { .. } => return Err("fonte ainda não suportada".to_string()),
    }
    sl.send_and_wait(|reply| SlskTask::DownloadExternal { source, meta, artwork_url, dest: dest_playlist, reply })
}

#[tauri::command]
pub(crate) async fn crate_sources_status(sl: State<'_, Slsk>) -> Result<SourcesStatus, String> {
    let ext = sl.ext.clone();
    blocking(move || Ok(ext.sources_status())).await
}

#[cfg(test)]
mod dedup_parity {
    //! Débito herdado da Etapa A/B (review do CMR-crate-v1): `rank::norm`/
    //! `rank::artist_main` (`slskd-client`, Etapa A) e `dedup::norm`/
    //! `dedup::artist_main` (`library-indexer`, Etapa B) são cópias
    //! PARALELAS da mesma lógica — a Etapa A existia antes do `dedup.rs`
    //! da Etapa B nascer. Se divergirem em algum caso, o dedup falha em
    //! SILÊNCIO: a chave de agrupamento que `rank::aggregate` gera pra uma
    //! faixa da busca deixa de bater com a chave que `OwnedIndex` indexou
    //! pro acervo, e `owned`/`suggested_dest` somem sem erro nenhum na
    //! tela. Este teste compara as duas cópias com a MESMA tabela de
    //! casos — nunca contra `query::norm` (P3 da spec: aquilo é
    //! normalização de BUSCA, não de dedup, "Money Trees (feat. Jay
    //! Rock)" não bateria com "Money Trees").
    const CASES: &[&str] = &[
        "Money Trees (feat. Jay Rock)",
        "Sicko Mode [Radio Edit]",
        "Beyoncé",
        "Baby Keem & Kendrick Lamar",
        "R&B Anthem",
        "",
        "Rihanna feat. Jay-Z",
        "Adam Beyer; Bart Skils",
        "Travis Scott, Drake",
        "Daft Punk x Pharrell",
        "Artist prod. Someone",
        "  espaços   colapsados  ",
        "UPPER CASE Title",
    ];

    #[test]
    fn dedup_key_matches_owned_index_key() {
        for case in CASES {
            assert_eq!(
                slskd_client::rank::norm(case),
                library_indexer::dedup::norm(case),
                "rank::norm e dedup::norm divergem para {case:?}"
            );
            assert_eq!(
                slskd_client::rank::artist_main(case),
                library_indexer::dedup::artist_main(case),
                "rank::artist_main e dedup::artist_main divergem para {case:?}"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_status_sem_token_nao_consulta_o_me() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = sources::SourcesConfig::load_with(tmp.path(), |_| None);
        cfg.sc_token_file = tmp.path().join("nao.txt");
        cfg.ffmpeg = "/caminho/inexistente/ffmpeg".into();
        let st = compute_with(&cfg, |_| panic!("sem token não pode ir à rede"));
        assert!(matches!(st.soundcloud, sources::TokenStatus::NoToken));
        assert!(!st.ffmpeg);
    }

    #[test]
    fn sources_status_com_token_usa_o_veredito_do_me() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = sources::SourcesConfig::load_with(tmp.path(), |_| None);
        cfg.sc_token_file = tmp.path().join("sc.txt");
        std::fs::write(&cfg.sc_token_file, "2-abc\n").unwrap();
        cfg.bc_identity_file = tmp.path().join("bc.txt");
        let mut visto = None;
        let st = compute_with(&cfg, |t| {
            visto = Some(t.to_string());
            TokenStatus::ApiDown
        });
        assert_eq!(visto.as_deref(), Some("2-abc"));
        assert!(matches!(st.soundcloud, sources::TokenStatus::ApiDown));
        assert!(!st.bandcamp_identity, "arquivo de identidade ausente");
    }

    /// Conta as chamadas a `check` através de `cached_me`, o caminho de produção.
    fn me_contado(cache: &Mutex<MeCache>, token: &str, now: Instant, st: TokenStatus, n: &mut u32) -> TokenStatus {
        cached_me(cache, token, now, |_| {
            *n += 1;
            st.clone()
        })
    }

    #[test]
    fn me_cache_acerta_dentro_do_ttl() {
        let cache = Mutex::new(MeCache::default());
        let t0 = Instant::now();
        let mut n = 0;
        me_contado(&cache, "a", t0, TokenStatus::TokenOk, &mut n);
        let st = me_contado(&cache, "a", t0 + Duration::from_secs(60), TokenStatus::NoToken, &mut n);
        assert_eq!(n, 1);
        assert!(matches!(st, TokenStatus::TokenOk), "veio do cache");
    }

    #[test]
    fn me_cache_expira_depois_do_ttl() {
        let cache = Mutex::new(MeCache::default());
        let t0 = Instant::now();
        let mut n = 0;
        me_contado(&cache, "a", t0, TokenStatus::TokenOk, &mut n);
        me_contado(&cache, "a", t0 + ME_CACHE_TTL + Duration::from_secs(1), TokenStatus::TokenOk, &mut n);
        assert_eq!(n, 2);
    }

    #[test]
    fn me_cache_invalida_com_token_trocado() {
        let cache = Mutex::new(MeCache::default());
        let t0 = Instant::now();
        let mut n = 0;
        me_contado(&cache, "a", t0, TokenStatus::NoToken, &mut n);
        let st = me_contado(&cache, "b", t0 + Duration::from_secs(1), TokenStatus::TokenOk, &mut n);
        assert_eq!(n, 2);
        assert!(matches!(st, TokenStatus::TokenOk));
    }

    #[test]
    fn me_cache_nunca_guarda_api_down() {
        let cache = Mutex::new(MeCache::default());
        let t0 = Instant::now();
        let mut n = 0;
        for i in 0..3 {
            me_contado(&cache, "a", t0 + Duration::from_secs(i), TokenStatus::ApiDown, &mut n);
        }
        assert_eq!(n, 3);
    }

    #[test]
    fn me_cache_solta_o_lock_durante_a_verificacao() {
        let cache = Mutex::new(MeCache::default());
        cached_me(&cache, "a", Instant::now(), |_| {
            assert!(cache.try_lock().is_ok(), "lock preso durante a chamada de rede");
            TokenStatus::TokenOk
        });
    }

    #[test]
    fn sc_pacer_exige_um_segundo_entre_chamadas() {
        let mut p = ScPacer::default();
        let t0 = Instant::now();
        assert!(p.admit(t0).is_ok());
        let e = p.admit(t0 + Duration::from_millis(500)).unwrap_err();
        assert!(e.contains("aguarde"), "{e}");
        assert!(p.admit(t0 + Duration::from_millis(1000)).is_ok());
    }

    #[test]
    fn sc_pacer_teto_de_120_por_hora_sem_frio() {
        let mut p = ScPacer::default();
        let t0 = Instant::now();
        for i in 0..SC_MAX_PER_HOUR as u64 {
            assert!(p.admit(t0 + Duration::from_secs(i * 2)).is_ok(), "chamada {i}");
        }
        let cheio = t0 + Duration::from_secs(SC_MAX_PER_HOUR as u64 * 2);
        assert!(p.admit(cheio).is_err(), "121ª dentro da hora");
        // A primeira sai da janela de 1 h: volta a aceitar, sem período de frio.
        assert!(p.admit(t0 + Duration::from_secs(3600) + Duration::from_millis(1)).is_ok());
    }

    #[test]
    fn sc_pacer_recusa_nao_conta_na_janela() {
        let mut p = ScPacer::default();
        let t0 = Instant::now();
        p.admit(t0).unwrap();
        for i in 1..10 {
            let _ = p.admit(t0 + Duration::from_millis(i * 50));
        }
        assert_eq!(p.window.len(), 1);
    }

    #[test]
    fn probe_sem_token_devolve_codigo_estavel() {
        assert_eq!(probe_err(ScError::NoToken), NO_TOKEN);
        assert_eq!(NO_TOKEN, "no_token");
        assert_ne!(probe_err(ScError::Http(503)), NO_TOKEN);
    }

    #[test]
    fn me_verdict_distingue_recusa_de_queda() {
        assert!(matches!(me_verdict(Ok(())), TokenStatus::TokenOk));
        assert!(matches!(me_verdict(Err(ScError::NoToken)), TokenStatus::NoToken));
        assert!(matches!(me_verdict(Err(ScError::Http(503))), TokenStatus::ApiDown));
        assert!(matches!(me_verdict(Err(ScError::Transport("x".into()))), TokenStatus::ApiDown));
    }

    #[test]
    fn probe_verdict_segue_a_politica_de_formato() {
        assert!(probe_verdict("WAV", Some(1), Some(1411)).allowed);
        assert_eq!(probe_verdict("aif", None, None).format_label, "AIFF");
        let ok = probe_verdict("mp3", Some(7_000_000), Some(320));
        assert!(ok.allowed && ok.format_label == "MP3 320");
        let baixo = probe_verdict("mp3", Some(3_000_000), Some(129));
        assert!(!baixo.allowed);
        assert_eq!(baixo.format_label, "MP3 129");
        assert_eq!(baixo.reason.as_deref(), Some("abaixo de 320 kbps"), "o rótulo não se repete no motivo");
        assert!(probe_verdict("mp3", None, None).allowed, "sem estimativa o ffprobe decide");
        let m4a = probe_verdict("m4a", Some(1), Some(256));
        assert!(!m4a.allowed && m4a.reason.as_deref() == Some("formato não suportado"));
        let vazio = probe_verdict("", None, None);
        assert!(vazio.allowed, "sem extensão o ffprobe decide");
        assert_eq!(vazio.format_label, "formato a confirmar");
        assert!(probe_verdict("wave", None, None).allowed);
        assert_eq!(probe_verdict("aifc", None, None).format_label, "AIFF");
    }
}
