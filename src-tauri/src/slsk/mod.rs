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
mod stage;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use crossbeam_channel::Sender;
use library_indexer::{IndexerHandle, Track};
use serde::Serialize;
use slskd_client::{HttpSlskd, SlskdApi};
use tauri::{AppHandle, State};

use board::DownloadJob;
use config::SlskConfig;
use coordinator::{SearchSnapshot, SearchState, SearchStore, SlskTask};

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

        coordinator::spawn_coordinator(cfg, api, board.clone(), searches.clone(), indexer, app, cmd_rx);

        Slsk { board, searches, status, cmd_tx }
    }

    fn send_and_wait(&self, build: impl FnOnce(Sender<Result<String, String>>) -> SlskTask) -> Result<String, String> {
        let (reply_tx, reply_rx) = crossbeam_channel::bounded(1);
        self.cmd_tx
            .send(build(reply_tx))
            .map_err(|_| "coordinator indisponivel".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "coordinator nao respondeu".to_string())?
    }
}

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
        .map_err(|_| "coordinator indisponivel".to_string())
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
        .map_err(|_| "coordinator indisponivel".to_string())
}

#[tauri::command]
pub(crate) fn slsk_clear_finished(sl: State<Slsk>) -> u32 {
    let (reply_tx, reply_rx) = crossbeam_channel::bounded(1);
    if sl.cmd_tx.send(SlskTask::ClearFinished { reply: reply_tx }).is_err() {
        return 0;
    }
    reply_rx.recv().unwrap_or(0)
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
