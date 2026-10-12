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
/// Resultados pedidos à busca do SoundCloud.
const SC_SEARCH_LIMIT: u32 = 30;
/// Teto da capa baixada para o card e lado máximo do JPEG devolvido.
const ARTWORK_MAX_BYTES: usize = 8 * 1024 * 1024;
const ARTWORK_CARD_SIDE: u32 = 500;

/// Estado das fontes externas compartilhado entre os comandos.
struct External {
    sc_api: Arc<dyn SoundCloudApi>,
    sources: Arc<SourcesConfig>,
    /// `(quando, hash do token, veredito)`: o hash (nunca o token) faz um
    /// token trocado no arquivo invalidar o cache na hora.
    me_cache: Mutex<Option<(Instant, u64, TokenStatus)>>,
    indexer: IndexerHandle,
    music_root: PathBuf,
    owned_cache: Mutex<Option<(Instant, Arc<OwnedIndex>)>>,
}

impl External {
    /// Status das fontes com o `me` em cache (spec §5.4: a UI consulta a
    /// cada 30 s; o SoundCloud não precisa ouvir isso).
    fn sources_status(&self) -> SourcesStatus {
        compute_with(&self.sources, |token| {
            let key = token_hash(token);
            let mut g = self.me_cache.lock().unwrap_or_else(|p| p.into_inner());
            if let Some((at, k, st)) = g.as_ref() {
                if *k == key && at.elapsed() < ME_CACHE_TTL {
                    return st.clone();
                }
            }
            let st = me_verdict(self.sc_api.me(token));
            *g = (!matches!(st, TokenStatus::ApiDown)).then(|| (Instant::now(), key, st.clone()));
            st
        })
    }

    /// Pasta do acervo onde o artista já mora (`suggested_dest`). Falha do
    /// Qdrant vira `None`: a sugestão é conveniência, não pré-requisito.
    fn suggest_dest(&self, artist: &str) -> Option<String> {
        let idx = {
            let mut g = self.owned_cache.lock().unwrap_or_else(|p| p.into_inner());
            match g.as_ref() {
                Some((at, idx)) if at.elapsed() < OWNED_CACHE_TTL => idx.clone(),
                _ => match OwnedIndex::build(self.indexer.client(), &self.music_root) {
                    Ok(idx) => {
                        let idx = Arc::new(idx);
                        *g = Some((Instant::now(), idx.clone()));
                        idx
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "crate: OwnedIndex indisponível para suggested_dest");
                        return None;
                    }
                },
            }
        };
        idx.folder_for_artist(artist).map(str::to_string)
    }

    fn to_result(&self, t: ScTrack) -> ScResult {
        let suggested_dest = self.suggest_dest(&t.user_name);
        ScResult::from_track(t, suggested_dest)
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

/// Status das fontes (spec §5.4). `sc = None` não chama a rede: com o
/// arquivo de token legível o SoundCloud fica `TokenOk`. Em produção o
/// status sai de `External::sources_status`, que põe o `me` em cache.
#[cfg(test)]
pub(crate) fn compute_sources_status(cfg: &SourcesConfig, sc: Option<&dyn SoundCloudApi>) -> SourcesStatus {
    compute_with(cfg, |token| match sc {
        Some(api) => me_verdict(api.me(token)),
        None => TokenStatus::TokenOk,
    })
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
        "wav" => ("WAV".to_string(), true, None),
        "aiff" | "aif" => ("AIFF".to_string(), true, None),
        "mp3" => match kbps_est {
            Some(k) if k < sc_worker::MIN_MP3_KBPS => {
                (format!("MP3 {k}"), false, Some(format!("MP3 {k}, não entra (abaixo de 320)")))
            }
            Some(_) => ("MP3 320".to_string(), true, None),
            // Sem tamanho não há estimativa: o ffprobe decide depois de baixar.
            None => ("MP3".to_string(), true, None),
        },
        "" => ("?".to_string(), false, Some("formato do original desconhecido".to_string())),
        other => (other.to_ascii_uppercase(), false, Some(format!("formato não suportado ({other})"))),
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
            me_cache: Mutex::new(None),
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
        let tracks = ext.sc_api.search(query.trim(), SC_SEARCH_LIMIT).map_err(sc_err)?;
        Ok(tracks.into_iter().map(|t| ext.to_result(t)).collect())
    })
    .await
}

#[tauri::command]
pub(crate) async fn crate_sc_resolve(sl: State<'_, Slsk>, url: String) -> Result<ScResult, String> {
    let ext = sl.ext.clone();
    blocking(move || {
        let t = ext.sc_api.resolve(url.trim()).map_err(sc_err)?;
        Ok(ext.to_result(t))
    })
    .await
}

#[tauri::command]
pub(crate) async fn crate_sc_probe(sl: State<'_, Slsk>, track_id: u64, duration_ms: u64) -> Result<ScProbe, String> {
    let ext = sl.ext.clone();
    blocking(move || {
        // Lido agora, só em memória: nunca em log nem na resposta.
        let token = ext.sources.read_sc_token().map_err(|_| "sem token do SoundCloud".to_string())?;
        let orig = ext.sc_api.probe_original(track_id, &token, duration_ms).map_err(sc_err)?;
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
    if !matches!(source, Source::SoundCloud { .. }) {
        return Err("fonte ainda não suportada".to_string());
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
    fn sources_status_sem_token_e_sem_ffmpeg_inexistente() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = sources::SourcesConfig::load_with(tmp.path(), |_| None);
        cfg.sc_token_file = tmp.path().join("nao.txt");
        cfg.ffmpeg = "/caminho/inexistente/ffmpeg".into();
        let st = compute_sources_status(&cfg, None); // None = sem cliente (não chama a rede)
        assert!(matches!(st.soundcloud, sources::TokenStatus::NoToken));
        assert!(!st.ffmpeg);
    }

    #[test]
    fn sources_status_com_token_sem_cliente_e_token_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let mut cfg = sources::SourcesConfig::load_with(tmp.path(), |_| None);
        cfg.sc_token_file = tmp.path().join("sc.txt");
        std::fs::write(&cfg.sc_token_file, "2-abc\n").unwrap();
        cfg.bc_identity_file = tmp.path().join("bc.txt");
        let st = compute_sources_status(&cfg, None);
        assert!(matches!(st.soundcloud, sources::TokenStatus::TokenOk));
        assert!(!st.bandcamp_identity, "arquivo de identidade ausente");
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
        assert!(probe_verdict("mp3", None, None).allowed, "sem estimativa o ffprobe decide");
        let m4a = probe_verdict("m4a", Some(1), Some(256));
        assert!(!m4a.allowed && m4a.reason.as_deref() == Some("formato não suportado (m4a)"));
        assert!(!probe_verdict("", None, None).allowed);
    }
}
