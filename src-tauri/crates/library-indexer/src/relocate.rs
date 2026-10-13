//! Mover faixas entre playlists (CMR-298) sem perder o histórico.
//!
//! Playlist = pasta de 1º nível sob `music_root`, e o id da faixa é o hash
//! do caminho (`path_to_id`). Um `mv` cru vira Remove + Create para o
//! watcher: o ponto novo nasce sem vetores e `track_enrichments` (vibe,
//! like, contagem de plays) e `play_events` ficam órfãos no id antigo.
//!
//! Aqui o movimento é feito pelo próprio indexador, na thread do
//! coordinator (serializado com o `run_scan`): o arquivo muda de lugar, o
//! ponto novo é gravado com o payload e os vetores do antigo, o histórico
//! é reapontado e só então o ponto antigo sai. Quando o watcher acordar, o
//! scan encontra o caminho novo com o mesmo mtime/tamanho e não reescreve
//! nada; o caminho antigo já não está no índice.
//!
//! Fora do escopo (documentado no CLAUDE.md): `stations.json`, manifest e
//! vetores do celular e a fila salva em `state.json` carregam o id antigo
//! até o próximo export/uso.

use crate::lyrics::find_lrc_sidecar;
use crate::qdrant_client::QdrantClient;
use crate::types::path_to_id;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tracing::{info, warn};

/// Desfecho de uma faixa num pedido de mover.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MoveStatus {
    Moved,
    AlreadyThere,
    Failed,
    /// O indexador não respondeu a tempo; o pedido segue na fila e o
    /// resultado chega depois pelo evento `TracksMoved`.
    Pending,
}

/// Uma linha do relatório. Ids como string: são u64 e passam de 2^53.
#[derive(Debug, Clone, Serialize)]
pub struct MoveItem {
    pub track_id: String,
    pub new_track_id: Option<String>,
    /// Caminho novo do arquivo — o frontend atualiza a fila em memória.
    pub new_path: Option<String>,
    /// Sidecar `.lrc` que acompanhou a faixa (None = sem letra sincronizada).
    pub new_lrc_path: Option<String>,
    pub title: Option<String>,
    pub status: MoveStatus,
    /// Motivo da falha, ou avisos de uma migração parcial (o arquivo foi
    /// movido mas parte do histórico não acompanhou).
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MoveReport {
    pub dest_playlist: String,
    pub moved: usize,
    pub already_there: usize,
    pub failed: usize,
    pub pending: usize,
    pub items: Vec<MoveItem>,
}

impl MoveReport {
    pub fn new(dest_playlist: &str, items: Vec<MoveItem>) -> Self {
        let count = |s| items.iter().filter(|i| i.status == s).count();
        MoveReport {
            dest_playlist: dest_playlist.to_string(),
            moved: count(MoveStatus::Moved),
            already_there: count(MoveStatus::AlreadyThere),
            failed: count(MoveStatus::Failed),
            pending: count(MoveStatus::Pending),
            items,
        }
    }

    /// Relatório com todas as faixas falhando pelo mesmo motivo (destino
    /// inválido, Qdrant fora, indexador desligado).
    pub fn all_failed(dest_playlist: &str, ids: &[u64], reason: &str) -> Self {
        Self::all_with(dest_playlist, ids, MoveStatus::Failed, reason)
    }

    /// Relatório de espera esgotada: as faixas seguem na fila do indexador.
    pub fn all_pending(dest_playlist: &str, ids: &[u64]) -> Self {
        Self::all_with(dest_playlist, ids, MoveStatus::Pending, "ainda em andamento")
    }

    fn all_with(dest_playlist: &str, ids: &[u64], status: MoveStatus, reason: &str) -> Self {
        let items = ids
            .iter()
            .map(|id| MoveItem {
                track_id: id.to_string(),
                new_track_id: None,
                new_path: None,
                new_lrc_path: None,
                title: None,
                status,
                detail: Some(reason.to_string()),
            })
            .collect();
        Self::new(dest_playlist, items)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    /// A faixa já está na playlist de destino.
    SameDest,
    /// O arquivo não está sob `music_root`, ou está solto na raiz.
    OutsideLibrary,
}

/// Nome de playlist aceitável como destino: não vazio, sem separador de
/// caminho e sem `.`/`_` na frente (pastas ocultas e de sistema, como
/// `_Compilations` e `.rustify-incoming`, nunca viram playlist).
pub fn is_valid_dest_playlist(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty()
        && n == name
        && !n.starts_with('.')
        && !n.starts_with('_')
        && !n.contains('/')
        && !n.contains('\\')
        && !n.contains('\0')
}

/// Caminho novo de uma faixa: troca SÓ a pasta de 1º nível (a playlist) e
/// preserva tudo o que vem abaixo dela — artista, álbum (com a marca
/// ` [tidal]`, que nunca muda), subpasta de disco e nome do arquivo.
pub fn plan_destination(music_root: &Path, src: &Path, dest_playlist: &str) -> Result<PathBuf, PlanError> {
    let rel = src.strip_prefix(music_root).map_err(|_| PlanError::OutsideLibrary)?;
    let comps: Vec<&std::ffi::OsStr> = rel
        .components()
        .map(|c| match c {
            Component::Normal(s) => Some(s),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .ok_or(PlanError::OutsideLibrary)?;
    // Precisa de pelo menos <playlist>/<arquivo>.
    if comps.len() < 2 {
        return Err(PlanError::OutsideLibrary);
    }
    if comps[0] == std::ffi::OsStr::new(dest_playlist) {
        return Err(PlanError::SameDest);
    }
    let mut out = music_root.join(dest_playlist);
    for c in &comps[1..] {
        out.push(c);
    }
    Ok(out)
}

/// Nomes de capa de pasta que acompanham o álbum — a mesma lista que o
/// scanner procura (`metadata::find_folder_cover`), sem diferenciar caixa.
pub fn is_folder_cover(file_name: &str) -> bool {
    const CANDIDATES: &[&str] = &[
        "cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.jpeg", "folder.png",
        "front.jpg", "front.jpeg", "front.png", "album.jpg", "album.png",
    ];
    let lower = file_name.to_lowercase();
    CANDIDATES.contains(&lower.as_str())
}

/// O que fazer com uma capa de pasta ao mover uma faixa do álbum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoverAction {
    /// Destino sem capa e origem vazia de faixas: leva a capa.
    Move,
    /// Destino sem capa e ainda há faixas na origem: copia.
    Copy,
    /// Destino já tem a capa e a origem esvaziou: a da origem sai.
    RemoveSource,
    /// Destino já tem a capa e ainda há faixas na origem: nada.
    Keep,
}

pub fn cover_action(dest_has_cover: bool, flacs_left_in_source: usize) -> CoverAction {
    match (dest_has_cover, flacs_left_in_source == 0) {
        (false, true) => CoverAction::Move,
        (false, false) => CoverAction::Copy,
        (true, true) => CoverAction::RemoveSource,
        (true, false) => CoverAction::Keep,
    }
}

/// Payload do ponto novo: o antigo inteiro (letra externa, LUFS, status de
/// embedding, mtime/tamanho) com os campos que derivam do caminho
/// atualizados. `cover_path` aponta para o cache por álbum e não muda.
pub fn relocated_payload(old: &Value, new_path: &Path, new_lrc: Option<&Path>, dest_playlist: &str) -> Value {
    let mut p = if old.is_object() { old.clone() } else { serde_json::json!({}) };
    let obj = p.as_object_mut().expect("objeto");
    obj.insert("path".into(), Value::String(new_path.to_string_lossy().into_owned()));
    if let Some(name) = new_path.file_name() {
        obj.insert("filename".into(), Value::String(name.to_string_lossy().into_owned()));
    }
    // `genre` é a pasta de 1º nível (scan.rs::extract_path_parts).
    obj.insert("genre".into(), Value::String(dest_playlist.to_string()));
    obj.insert(
        "lrc_path".into(),
        new_lrc.map_or(Value::Null, |l| Value::String(l.to_string_lossy().into_owned())),
    );
    p
}

// ---------------------------------------------------------------------------
// Sistema de arquivos
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum FsOp {
    Moved { from: PathBuf, to: PathBuf },
    Copied { to: PathBuf },
}

/// Resultado da parte de disco de um movimento.
#[derive(Debug)]
pub struct FsOutcome {
    ops: Vec<FsOp>,
    /// Pasta mais alta criada para o destino (rollback a remove se vazia).
    created_root: Option<PathBuf>,
    pub new_lrc: Option<PathBuf>,
    pub warnings: Vec<String>,
}

/// errno EXDEV: origem e destino em sistemas de arquivos diferentes.
const EXDEV: i32 = 18;

/// Só `rename`. Entre sistemas de arquivos recusa: o scanner anda com
/// `same_file_system(true)` e apagaria do índice uma cópia fora dele.
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|e| {
        if e.raw_os_error() == Some(EXDEV) {
            "destino em outro sistema de arquivos".to_string()
        } else {
            e.to_string()
        }
    })
}

fn count_flacs(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| {
                    e.path()
                        .extension()
                        .and_then(|x| x.to_str())
                        .is_some_and(|x| x.eq_ignore_ascii_case("flac"))
                })
                .count()
        })
        .unwrap_or(0)
}

/// Mesmo conteúdo: tamanho e SHA-256 iguais.
fn same_content(a: &Path, b: &Path) -> bool {
    use sha2::{Digest, Sha256};
    let (Ok(ma), Ok(mb)) = (fs::metadata(a), fs::metadata(b)) else { return false };
    if ma.len() != mb.len() {
        return false;
    }
    match (fs::read(a), fs::read(b)) {
        (Ok(x), Ok(y)) => Sha256::digest(&x) == Sha256::digest(&y),
        _ => false,
    }
}

/// Pasta ancestral mais alta de `dir` que ainda não existe.
fn first_missing_ancestor(dir: &Path) -> Option<PathBuf> {
    let mut missing = None;
    let mut cur = Some(dir);
    while let Some(c) = cur {
        if c.exists() {
            break;
        }
        missing = Some(c.to_path_buf());
        cur = c.parent();
    }
    missing
}

/// Move o FLAC e o que o acompanha (sidecar `.lrc` de mesmo stem, capas de
/// pasta). Falha no FLAC = erro (nada mudou). Falha num acompanhante vira
/// aviso: a faixa já mudou de lugar e o histórico ainda vai junto.
pub fn relocate_files(src: &Path, dst: &Path) -> Result<FsOutcome, String> {
    if !src.is_file() {
        return Err("arquivo não existe no disco".into());
    }
    if dst.exists() {
        return Err("já existe um arquivo com esse nome no destino".into());
    }
    let src_dir = src.parent().ok_or("caminho sem pasta")?.to_path_buf();
    let dst_dir = dst.parent().ok_or("caminho sem pasta")?.to_path_buf();
    let lrc_src = find_lrc_sidecar(src);

    let created_root = first_missing_ancestor(&dst_dir);
    fs::create_dir_all(&dst_dir).map_err(|e| format!("criar pasta de destino: {e}"))?;
    if let Err(e) = move_file(src, dst) {
        if let Some(root) = &created_root {
            remove_empty_dirs(&dst_dir, root.parent().unwrap_or(root));
        }
        return Err(format!("mover arquivo: {e}"));
    }

    let mut out = FsOutcome {
        ops: vec![FsOp::Moved { from: src.to_path_buf(), to: dst.to_path_buf() }],
        created_root,
        new_lrc: None,
        warnings: Vec::new(),
    };

    if let Some(lrc) = lrc_src {
        let lrc_dst = dst.with_extension("lrc");
        if lrc_dst.exists() {
            // Não adota: o .lrc que já estava lá pode ser de outra gravação.
            out.warnings.push("letra .lrc já existia no destino; nenhuma das duas foi associada".into());
        } else {
            match move_file(&lrc, &lrc_dst) {
                Ok(()) => {
                    out.ops.push(FsOp::Moved { from: lrc, to: lrc_dst.clone() });
                    out.new_lrc = Some(lrc_dst);
                }
                Err(e) => out.warnings.push(format!("letra .lrc não acompanhou: {e}")),
            }
        }
    }

    let left = count_flacs(&src_dir);
    let covers: Vec<PathBuf> = fs::read_dir(&src_dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file() && p.file_name().and_then(|n| n.to_str()).is_some_and(is_folder_cover))
                .collect()
        })
        .unwrap_or_default();
    for cover in covers {
        let Some(name) = cover.file_name() else { continue };
        let cover_dst = dst_dir.join(name);
        let result: Result<(), String> = match cover_action(cover_dst.exists(), left) {
            CoverAction::Move => move_file(&cover, &cover_dst)
                .map(|()| out.ops.push(FsOp::Moved { from: cover.clone(), to: cover_dst.clone() })),
            CoverAction::Copy => fs::copy(&cover, &cover_dst)
                .map(|_| out.ops.push(FsOp::Copied { to: cover_dst.clone() }))
                .map_err(|e| e.to_string()),
            // Só apaga a da origem se a do destino for a MESMA imagem; capa
            // diferente fica (a pasta não some, mas nada se perde).
            CoverAction::RemoveSource if same_content(&cover, &cover_dst) => {
                fs::remove_file(&cover).map_err(|e| e.to_string())
            }
            CoverAction::RemoveSource | CoverAction::Keep => Ok(()),
        };
        if let Err(e) = result {
            out.warnings.push(format!("capa {} não acompanhou: {e}", name.to_string_lossy()));
        }
    }
    Ok(out)
}

/// Desfaz a parte de disco (o índice recusou o ponto novo): o arquivo volta
/// para onde estava, as cópias de capa somem e as pastas criadas para o
/// destino saem se ficarem vazias. Capa já REMOVIDA da origem (o destino
/// tinha a mesma imagem) não volta. `Err` lista o que não deu para desfazer.
pub fn rollback_files(outcome: &FsOutcome, dst_dir: &Path) -> Result<(), String> {
    let mut failed = Vec::new();
    for op in outcome.ops.iter().rev() {
        let r = match op {
            FsOp::Moved { from, to } => move_file(to, from).map_err(|e| format!("{}: {e}", to.display())),
            FsOp::Copied { to } => fs::remove_file(to).map_err(|e| format!("{}: {e}", to.display())),
        };
        if let Err(e) = r {
            warn!(target: "library_indexer::relocate", ?op, error = %e, "rollback falhou");
            failed.push(e);
        }
    }
    if let Some(root) = &outcome.created_root {
        remove_empty_dirs(dst_dir, root.parent().unwrap_or(root));
    }
    if failed.is_empty() { Ok(()) } else { Err(failed.join("; ")) }
}

/// Remove `dir` e os ancestrais que ficarem vazios, parando ANTES de `stop`
/// (a pasta da playlist de origem fica, mesmo vazia).
pub fn remove_empty_dirs(dir: &Path, stop: &Path) {
    let mut cur = dir.to_path_buf();
    while cur != stop && cur.starts_with(stop) {
        let empty = fs::read_dir(&cur).map(|mut rd| rd.next().is_none()).unwrap_or(false);
        if !empty || fs::remove_dir(&cur).is_err() {
            break;
        }
        match cur.parent() {
            Some(p) => cur = p.to_path_buf(),
            None => break,
        }
    }
}

// ---------------------------------------------------------------------------
// Histórico (enrichment, play_events, ponto antigo)
// ---------------------------------------------------------------------------

/// O que a migração de histórico precisa do Qdrant. Trait para o replay do
/// registro de intenção ser testável sem servidor.
pub trait HistoryStore {
    fn enrichment(&self, id: u64) -> Result<Value, String>;
    /// PUT completo: o payload do id novo vira exatamente `payload`.
    fn replace_enrichment(&self, id: u64, payload: &Value) -> Result<(), String>;
    fn delete_enrichment(&self, id: u64) -> Result<(), String>;
    fn play_event_track_ids(&self) -> Result<Vec<(Value, u64)>, String>;
    /// Quantos pontos (na ordem de `pids`) foram reapontados, e o erro que
    /// interrompeu, se houve.
    fn repoint_play_events(&self, pids: &[Value], new_id: u64) -> (usize, Option<String>);
    fn delete_track(&self, id: u64) -> Result<(), String>;
}

impl HistoryStore for QdrantClient {
    fn enrichment(&self, id: u64) -> Result<Value, String> {
        self.get_enrichment(id).map_err(|e| e.to_string())
    }
    fn replace_enrichment(&self, id: u64, payload: &Value) -> Result<(), String> {
        QdrantClient::replace_enrichment(self, id, payload).map_err(|e| e.to_string())
    }
    fn delete_enrichment(&self, id: u64) -> Result<(), String> {
        QdrantClient::delete_enrichment(self, id).map_err(|e| e.to_string())
    }
    fn play_event_track_ids(&self) -> Result<Vec<(Value, u64)>, String> {
        self.scroll_play_event_track_ids().map_err(|e| e.to_string())
    }
    fn repoint_play_events(&self, pids: &[Value], new_id: u64) -> (usize, Option<String>) {
        let (n, err) = self.set_play_events_track_id(pids, new_id);
        (n, err.map(|e| e.to_string()))
    }
    fn delete_track(&self, id: u64) -> Result<(), String> {
        self.delete_points(&[id]).map_err(|e| e.to_string())
    }
}

/// Leva o histórico de `old` para `new`. Idempotente: rodar de novo depois
/// de uma queda só refaz o que faltou. Devolve avisos e os play_events que
/// NÃO foram reapontados.
pub fn migrate_history<S: HistoryStore>(store: &S, old: u64, new: u64, pids: Vec<Value>) -> (Vec<String>, Vec<Value>) {
    let mut warnings = Vec::new();
    match store.enrichment(old) {
        Ok(enr) if enr.as_object().is_some_and(|m| !m.is_empty()) => match store.replace_enrichment(new, &enr) {
            Ok(()) => {
                if let Err(e) = store.delete_enrichment(old) {
                    warnings.push(format!("enrichment antigo não foi apagado: {e}"));
                }
            }
            Err(e) => warnings.push(format!("like/vibe não acompanharam: {e}")),
        },
        Ok(_) => {}
        Err(e) => warnings.push(format!("like/vibe não acompanharam: {e}")),
    }
    let left = repoint(store, pids, new, &mut warnings);
    // Por último: se falhar, o próximo scan apaga (o caminho sumiu do disco).
    if let Err(e) = store.delete_track(old) {
        warnings.push(format!("ponto antigo será limpo no próximo scan: {e}"));
    }
    (warnings, left)
}

fn repoint<S: HistoryStore>(store: &S, pids: Vec<Value>, new: u64, warnings: &mut Vec<String>) -> Vec<Value> {
    if pids.is_empty() {
        return pids;
    }
    let (n, err) = store.repoint_play_events(&pids, new);
    if let Some(e) = err {
        warnings.push(format!("histórico de plays: {n} de {} reapontados ({e})", pids.len()));
    }
    pids[n.min(pids.len())..].to_vec()
}

// ---------------------------------------------------------------------------
// Registro de intenção (queda no meio do move)
// ---------------------------------------------------------------------------

/// Gravado ANTES do rename e apagado no fim. Se o app cair no meio, o
/// coordinator reprocessa no boot, antes do primeiro scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveIntent {
    pub old_id: u64,
    pub new_id: u64,
    pub src: PathBuf,
    pub dst: PathBuf,
    pub lrc_src: Option<PathBuf>,
    pub lrc_dst: Option<PathBuf>,
    /// O ponto novo já foi gravado: o replay completa o histórico em vez
    /// de desfazer o rename.
    pub upserted: bool,
}

/// Arquivo `move-journal.json` no data dir. `path: None` desliga (testes e
/// CLI sem data dir).
#[derive(Debug, Clone, Default)]
pub struct Journal {
    path: Option<PathBuf>,
}

impl Journal {
    pub const FILE: &'static str = "move-journal.json";

    pub fn in_dir(dir: &Path) -> Self {
        Journal { path: Some(dir.join(Self::FILE)) }
    }

    pub fn disabled() -> Self {
        Journal { path: None }
    }

    pub fn write(&self, intent: &MoveIntent) -> Result<(), String> {
        let Some(path) = &self.path else { return Ok(()) };
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        let body = serde_json::to_vec(intent).map_err(|e| e.to_string())?;
        fs::write(&tmp, body).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    pub fn load(&self) -> Option<MoveIntent> {
        let path = self.path.as_ref()?;
        let bytes = fs::read(path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    pub fn clear(&self) {
        if let Some(path) = &self.path {
            let _ = fs::remove_file(path);
        }
    }
}

/// Desfecho do replay de uma pendência.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayOutcome {
    /// O ponto novo não chegou a ser gravado: o arquivo voltou à origem.
    Undone,
    /// Histórico completado no id novo (avisos, se houve; o registro fica
    /// para nova tentativa no próximo boot quando há aviso).
    Completed(Vec<String>),
}

/// Reprocessa a pendência do registro, se houver. Idempotente.
pub fn replay_pending<S: HistoryStore>(store: &S, journal: &Journal, music_root: &Path) -> Option<ReplayOutcome> {
    let intent = journal.load()?;
    warn!(target: "library_indexer::relocate", ?intent, "mover para playlist: pendência de uma queda, reprocessando");
    if !intent.upserted {
        let back = |from: &Path, to: &Path| {
            if from.is_file() && !to.exists() {
                if let Some(dir) = to.parent() {
                    let _ = fs::create_dir_all(dir);
                }
                if let Err(e) = fs::rename(from, to) {
                    warn!(target: "library_indexer::relocate", error = %e, "replay: não deu para devolver o arquivo");
                }
            }
        };
        back(&intent.dst, &intent.src);
        if let (Some(ls), Some(ld)) = (&intent.lrc_src, &intent.lrc_dst) {
            back(ld, ls);
        }
        if let Some(dir) = intent.dst.parent() {
            remove_empty_dirs(dir, music_root);
        }
        journal.clear();
        return Some(ReplayOutcome::Undone);
    }
    let pids = match store.play_event_track_ids() {
        Ok(rows) => rows.into_iter().filter(|(_, t)| *t == intent.old_id).map(|(p, _)| p).collect(),
        Err(e) => return Some(ReplayOutcome::Completed(vec![format!("play_events indisponível: {e}")])),
    };
    let (warnings, _) = migrate_history(store, intent.old_id, intent.new_id, pids);
    if warnings.is_empty() {
        journal.clear();
    }
    Some(ReplayOutcome::Completed(warnings))
}

// ---------------------------------------------------------------------------
// Orquestração (roda na thread do coordinator)
// ---------------------------------------------------------------------------

pub fn move_tracks(
    client: &QdrantClient,
    music_root: &Path,
    journal: &Journal,
    ids: &[u64],
    dest_playlist: &str,
) -> MoveReport {
    if !is_valid_dest_playlist(dest_playlist) {
        return MoveReport::all_failed(dest_playlist, ids, "nome de playlist inválido");
    }
    // O índice dos play_events vem ANTES de qualquer arquivo mudar: sem ele
    // o histórico ficaria para trás, então a falha aborta o lote inteiro.
    let mut events: HashMap<u64, Vec<Value>> = HashMap::new();
    match client.scroll_play_event_track_ids() {
        Ok(rows) => {
            for (pid, tid) in rows {
                events.entry(tid).or_default().push(pid);
            }
        }
        Err(e) => {
            return MoveReport::all_failed(dest_playlist, ids, &format!("histórico de plays indisponível: {e}"));
        }
    }

    let mut items: Vec<MoveItem> = ids
        .iter()
        .map(|&id| {
            let pids = events.remove(&id).unwrap_or_default();
            move_one(client, music_root, journal, id, dest_playlist, pids)
        })
        .collect();

    // Segunda passada: plays gravados no id antigo DURANTE o lote (a faixa
    // tocando terminou no meio) ou que falharam na primeira.
    sweep_late_events(client, &mut items);

    let report = MoveReport::new(dest_playlist, items);
    info!(
        target: "library_indexer::relocate",
        dest = dest_playlist, moved = report.moved, already = report.already_there, failed = report.failed,
        "mover para playlist concluído"
    );
    report
}

fn push_detail(item: &mut MoveItem, msg: String) {
    item.detail = Some(match item.detail.take() {
        Some(d) => format!("{d}; {msg}"),
        None => msg,
    });
}

/// Reaponta qualquer play_event ainda no id antigo de uma faixa movida.
pub fn sweep_late_events<S: HistoryStore>(store: &S, items: &mut [MoveItem]) {
    let moved: HashMap<u64, usize> = items
        .iter()
        .enumerate()
        .filter(|(_, i)| i.status == MoveStatus::Moved)
        .filter_map(|(k, i)| i.track_id.parse::<u64>().ok().map(|old| (old, k)))
        .collect();
    if moved.is_empty() {
        return;
    }
    let rows = match store.play_event_track_ids() {
        Ok(r) => r,
        Err(e) => {
            for &k in moved.values() {
                push_detail(&mut items[k], format!("conferência final de plays falhou: {e}"));
            }
            return;
        }
    };
    let mut late: HashMap<u64, Vec<Value>> = HashMap::new();
    for (pid, tid) in rows {
        if moved.contains_key(&tid) {
            late.entry(tid).or_default().push(pid);
        }
    }
    for (old, pids) in late {
        let k = moved[&old];
        let Some(new) = items[k].new_track_id.as_deref().and_then(|s| s.parse::<u64>().ok()) else { continue };
        let mut warnings = Vec::new();
        let left = repoint(store, pids, new, &mut warnings);
        if !left.is_empty() {
            for w in warnings {
                push_detail(&mut items[k], w);
            }
        }
    }
}

fn move_one(
    client: &QdrantClient,
    music_root: &Path,
    journal: &Journal,
    old_id: u64,
    dest: &str,
    pids: Vec<Value>,
) -> MoveItem {
    let mut item = MoveItem {
        track_id: old_id.to_string(),
        new_track_id: None,
        new_path: None,
        new_lrc_path: None,
        title: None,
        status: MoveStatus::Failed,
        detail: None,
    };
    let fail = |mut item: MoveItem, why: String| {
        item.detail = Some(why);
        item
    };

    let (payload, vector) = match client.get_point_with_vectors(old_id) {
        Ok(Some(pv)) => pv,
        Ok(None) => return fail(item, "faixa não encontrada no índice".into()),
        Err(e) => return fail(item, format!("ler faixa do índice: {e}")),
    };
    item.title = payload["title"].as_str().map(str::to_string);
    let Some(src) = payload["path"].as_str().filter(|s| !s.is_empty()).map(PathBuf::from) else {
        return fail(item, "faixa sem caminho no índice".into());
    };
    let dst = match plan_destination(music_root, &src, dest) {
        Ok(d) => d,
        Err(PlanError::SameDest) => {
            item.status = MoveStatus::AlreadyThere;
            return item;
        }
        Err(PlanError::OutsideLibrary) => return fail(item, "arquivo fora de uma playlist do acervo".into()),
    };
    let new_id = path_to_id(&dst);

    let lrc_src = find_lrc_sidecar(&src);
    let lrc_dst = lrc_src.as_ref().map(|_| dst.with_extension("lrc")).filter(|p| !p.exists());
    let mut intent = MoveIntent {
        old_id,
        new_id,
        src: src.clone(),
        dst: dst.clone(),
        lrc_src: lrc_dst.as_ref().and(lrc_src),
        lrc_dst,
        upserted: false,
    };
    if let Err(e) = journal.write(&intent) {
        return fail(item, format!("registro de intenção: {e}"));
    }

    let fs_out = match relocate_files(&src, &dst) {
        Ok(o) => o,
        Err(e) => {
            journal.clear();
            return fail(item, e);
        }
    };

    let new_payload = relocated_payload(&payload, &dst, fs_out.new_lrc.as_deref(), dest);
    if let Err(e) = client.upsert_point_raw(new_id, &new_payload, &vector) {
        let undo = match rollback_files(&fs_out, dst.parent().unwrap_or(&dst)) {
            Ok(()) => {
                journal.clear();
                "arquivo devolvido à origem".to_string()
            }
            // O registro fica: o replay do próximo boot tenta de novo.
            Err(r) => format!("e o rollback falhou, confira no disco: {r}"),
        };
        return fail(item, format!("gravar faixa no índice: {e} ({undo})"));
    }
    intent.upserted = true;
    let mut warnings = fs_out.warnings.clone();
    if let Err(e) = journal.write(&intent) {
        warnings.push(format!("registro de intenção não atualizado: {e}"));
    }

    let (hist_warnings, _) = migrate_history(client, old_id, new_id, pids);
    warnings.extend(hist_warnings);
    journal.clear();

    if let Some(src_dir) = src.parent() {
        if let Ok(rel) = src.strip_prefix(music_root) {
            if let Some(first) = rel.components().next() {
                remove_empty_dirs(src_dir, &music_root.join(first));
            }
        }
    }

    item.status = MoveStatus::Moved;
    item.new_track_id = Some(new_id.to_string());
    item.new_path = Some(dst.to_string_lossy().into_owned());
    item.new_lrc_path = fs_out.new_lrc.as_ref().map(|p| p.to_string_lossy().into_owned());
    item.detail = (!warnings.is_empty()).then(|| warnings.join("; "));
    item
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{Duration, SystemTime};

    fn root() -> PathBuf {
        PathBuf::from("/m")
    }

    #[test]
    fn destino_preserva_artista_e_album() {
        let src = Path::new("/m/Rap/Baco/2017 - Esú/03 - Esú.flac");
        assert_eq!(
            plan_destination(&root(), src, "Favoritas").unwrap(),
            PathBuf::from("/m/Favoritas/Baco/2017 - Esú/03 - Esú.flac")
        );
    }

    #[test]
    fn destino_preserva_marca_tidal_e_subpasta_de_disco() {
        let src = Path::new("/m/Mix/Artista/Álbum [tidal]/CD2/01 Faixa.flac");
        assert_eq!(
            plan_destination(&root(), src, "Novas").unwrap(),
            PathBuf::from("/m/Novas/Artista/Álbum [tidal]/CD2/01 Faixa.flac")
        );
    }

    #[test]
    fn destino_igual_a_origem_e_recusado() {
        let src = Path::new("/m/Rap/A/B/x.flac");
        assert_eq!(plan_destination(&root(), src, "Rap"), Err(PlanError::SameDest));
    }

    #[test]
    fn fora_do_acervo_ou_solto_na_raiz_e_recusado() {
        assert_eq!(
            plan_destination(&root(), Path::new("/outro/Rap/x.flac"), "Y"),
            Err(PlanError::OutsideLibrary)
        );
        assert_eq!(
            plan_destination(&root(), Path::new("/m/x.flac"), "Y"),
            Err(PlanError::OutsideLibrary)
        );
        assert_eq!(
            plan_destination(&root(), Path::new("/m/Rap/../x.flac"), "Y"),
            Err(PlanError::OutsideLibrary)
        );
    }

    #[test]
    fn nome_de_playlist_valido() {
        assert!(is_valid_dest_playlist("Rap & Hip-Hop"));
        assert!(is_valid_dest_playlist("Funk BR"));
        for bad in ["", " ", ".rustify-incoming", "_Compilations", "a/b", "a\\b", " Rap", ".."] {
            assert!(!is_valid_dest_playlist(bad), "{bad:?} deveria ser recusado");
        }
    }

    #[test]
    fn capa_copia_enquanto_restam_faixas_e_move_na_ultima() {
        assert_eq!(cover_action(false, 3), CoverAction::Copy);
        assert_eq!(cover_action(true, 2), CoverAction::Keep);
        assert_eq!(cover_action(true, 0), CoverAction::RemoveSource);
        assert_eq!(cover_action(false, 0), CoverAction::Move);
    }

    #[test]
    fn nomes_de_capa_sem_caixa() {
        assert!(is_folder_cover("cover.jpg"));
        assert!(is_folder_cover("Folder.JPG"));
        assert!(!is_folder_cover("back.jpg"));
        assert!(!is_folder_cover("01 - x.flac"));
    }

    #[test]
    fn payload_novo_troca_so_campos_de_caminho() {
        let old = json!({
            "path": "/m/Rap/A/B/01 x.flac", "filename": "01 x.flac", "genre": "Rap",
            "lrc_path": "/m/Rap/A/B/01 x.lrc", "cover_path": "covers/123.webp",
            "lyrics_text": "verso", "lyrics_status": "plain", "mtime": 10, "size_bytes": 99,
            "embedding_status": "done", "title": "x"
        });
        let new = relocated_payload(
            &old,
            Path::new("/m/Nova/A/B/01 x.flac"),
            Some(Path::new("/m/Nova/A/B/01 x.lrc")),
            "Nova",
        );
        assert_eq!(new["path"], "/m/Nova/A/B/01 x.flac");
        assert_eq!(new["filename"], "01 x.flac");
        assert_eq!(new["genre"], "Nova");
        assert_eq!(new["lrc_path"], "/m/Nova/A/B/01 x.lrc");
        for k in ["cover_path", "lyrics_text", "lyrics_status", "mtime", "size_bytes", "embedding_status", "title"] {
            assert_eq!(new[k], old[k], "campo {k} deveria ser preservado");
        }
        let sem_lrc = relocated_payload(&old, Path::new("/m/Nova/A/B/01 x.flac"), None, "Nova");
        assert!(sem_lrc["lrc_path"].is_null());
    }

    #[test]
    fn arquivos_acompanham_e_capa_e_copiada_ate_a_ultima_faixa() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        let album = r.join("Rap/Art/2020 - Alb");
        fs::create_dir_all(&album).unwrap();
        for f in ["01 a.flac", "02 b.flac", "01 a.lrc", "cover.jpg"] {
            fs::write(album.join(f), f).unwrap();
        }
        let old_mtime = SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        fs::OpenOptions::new().write(true).open(album.join("01 a.flac")).unwrap().set_modified(old_mtime).unwrap();

        // 1ª faixa: ainda resta a 02 na origem -> capa copiada.
        let src_a = album.join("01 a.flac");
        let dst_a = plan_destination(r, &src_a, "Nova").unwrap();
        let out = relocate_files(&src_a, &dst_a).unwrap();
        assert!(dst_a.is_file() && !src_a.exists());
        assert_eq!(fs::metadata(&dst_a).unwrap().modified().unwrap(), old_mtime);
        assert_eq!(out.new_lrc.as_deref(), Some(dst_a.with_extension("lrc").as_path()));
        assert!(!album.join("01 a.lrc").exists());
        assert!(album.join("cover.jpg").is_file());
        assert!(dst_a.parent().unwrap().join("cover.jpg").is_file());
        assert!(out.warnings.is_empty());

        // 2ª (última) faixa: destino já tem a capa -> a da origem sai e as
        // pastas vazias somem até a playlist (que fica).
        let src_b = album.join("02 b.flac");
        let dst_b = plan_destination(r, &src_b, "Nova").unwrap();
        relocate_files(&src_b, &dst_b).unwrap();
        assert!(!album.join("cover.jpg").exists());
        remove_empty_dirs(&album, &r.join("Rap"));
        assert!(!album.exists());
        assert!(!r.join("Rap/Art").exists());
        assert!(r.join("Rap").is_dir());
    }

    #[test]
    fn colisao_no_destino_falha_sem_mexer_em_nada() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        fs::create_dir_all(r.join("Rap/A/B")).unwrap();
        fs::create_dir_all(r.join("Nova/A/B")).unwrap();
        fs::write(r.join("Rap/A/B/x.flac"), "1").unwrap();
        fs::write(r.join("Nova/A/B/x.flac"), "2").unwrap();
        let src = r.join("Rap/A/B/x.flac");
        let dst = plan_destination(r, &src, "Nova").unwrap();
        assert!(relocate_files(&src, &dst).is_err());
        assert_eq!(fs::read_to_string(&src).unwrap(), "1");
    }

    #[test]
    fn rollback_devolve_arquivo_e_apaga_copia_de_capa() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        let album = r.join("Rap/A/B");
        fs::create_dir_all(&album).unwrap();
        for f in ["1.flac", "2.flac", "folder.jpg"] {
            fs::write(album.join(f), f).unwrap();
        }
        let src = album.join("1.flac");
        let dst = plan_destination(r, &src, "Nova").unwrap();
        let out = relocate_files(&src, &dst).unwrap();
        rollback_files(&out, dst.parent().unwrap()).unwrap();
        assert!(src.is_file() && !dst.exists());
        assert!(!r.join("Nova/A/B/folder.jpg").exists());
        assert!(album.join("folder.jpg").is_file());
        // As pastas criadas para o destino somem junto.
        assert!(!r.join("Nova").exists());
    }

    #[test]
    fn rollback_que_falha_e_relatado() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        fs::create_dir_all(r.join("Rap/A/B")).unwrap();
        let src = r.join("Rap/A/B/1.flac");
        fs::write(&src, "1").unwrap();
        let dst = plan_destination(r, &src, "Nova").unwrap();
        let out = relocate_files(&src, &dst).unwrap();
        fs::remove_file(&dst).unwrap(); // some antes do rollback
        assert!(rollback_files(&out, dst.parent().unwrap()).is_err());
    }

    #[test]
    fn capa_diferente_no_destino_nao_apaga_a_da_origem() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        fs::create_dir_all(r.join("Rap/A/B")).unwrap();
        fs::create_dir_all(r.join("Nova/A/B")).unwrap();
        fs::write(r.join("Rap/A/B/1.flac"), "1").unwrap();
        fs::write(r.join("Rap/A/B/cover.jpg"), "capa-velha").unwrap();
        fs::write(r.join("Nova/A/B/cover.jpg"), "outra-capa").unwrap();
        let src = r.join("Rap/A/B/1.flac");
        relocate_files(&src, &plan_destination(r, &src, "Nova").unwrap()).unwrap();
        assert_eq!(fs::read_to_string(r.join("Rap/A/B/cover.jpg")).unwrap(), "capa-velha");
        assert_eq!(fs::read_to_string(r.join("Nova/A/B/cover.jpg")).unwrap(), "outra-capa");
    }

    #[test]
    fn lrc_ja_existente_no_destino_nao_e_adotado() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        fs::create_dir_all(r.join("Rap/A/B")).unwrap();
        fs::create_dir_all(r.join("Nova/A/B")).unwrap();
        fs::write(r.join("Rap/A/B/1.flac"), "1").unwrap();
        fs::write(r.join("Rap/A/B/1.lrc"), "minha").unwrap();
        fs::write(r.join("Nova/A/B/1.lrc"), "alheia").unwrap();
        let src = r.join("Rap/A/B/1.flac");
        let out = relocate_files(&src, &plan_destination(r, &src, "Nova").unwrap()).unwrap();
        assert!(out.new_lrc.is_none());
        assert_eq!(out.warnings.len(), 1);
        assert_eq!(fs::read_to_string(r.join("Rap/A/B/1.lrc")).unwrap(), "minha");
    }

    #[test]
    fn relatorio_conta_por_status() {
        let mk = |s| MoveItem { track_id: "1".into(), new_track_id: None, new_path: None, new_lrc_path: None, title: None, status: s, detail: None };
        let r = MoveReport::new("X", vec![mk(MoveStatus::Moved), mk(MoveStatus::Moved), mk(MoveStatus::AlreadyThere), mk(MoveStatus::Failed)]);
        assert_eq!((r.moved, r.already_there, r.failed), (2, 1, 1));
        let s = serde_json::to_value(&r).unwrap();
        assert_eq!(s["items"][2]["status"], "already_there");
    }

    // ── Histórico e registro de intenção (fake do Qdrant) ──────────────

    #[derive(Default)]
    struct FakeStore {
        enrich: std::cell::RefCell<HashMap<u64, Value>>,
        events: std::cell::RefCell<Vec<(Value, u64)>>,
        tracks: std::cell::RefCell<std::collections::HashSet<u64>>,
        /// Quantos pontos o próximo repoint aplica antes de "cair".
        fail_after: std::cell::Cell<Option<usize>>,
    }

    impl HistoryStore for FakeStore {
        fn enrichment(&self, id: u64) -> Result<Value, String> {
            Ok(self.enrich.borrow().get(&id).cloned().unwrap_or_else(|| json!({})))
        }
        fn replace_enrichment(&self, id: u64, payload: &Value) -> Result<(), String> {
            self.enrich.borrow_mut().insert(id, payload.clone());
            Ok(())
        }
        fn delete_enrichment(&self, id: u64) -> Result<(), String> {
            self.enrich.borrow_mut().remove(&id);
            Ok(())
        }
        fn play_event_track_ids(&self) -> Result<Vec<(Value, u64)>, String> {
            Ok(self.events.borrow().clone())
        }
        fn repoint_play_events(&self, pids: &[Value], new_id: u64) -> (usize, Option<String>) {
            let limit = self.fail_after.take().unwrap_or(usize::MAX);
            let mut n = 0;
            for pid in pids {
                if n == limit {
                    return (n, Some("caiu".into()));
                }
                for (p, t) in self.events.borrow_mut().iter_mut() {
                    if p == pid {
                        *t = new_id;
                    }
                }
                n += 1;
            }
            (n, None)
        }
        fn delete_track(&self, id: u64) -> Result<(), String> {
            self.tracks.borrow_mut().remove(&id);
            Ok(())
        }
    }

    fn store_with_history(old: u64) -> FakeStore {
        let s = FakeStore::default();
        s.enrich.borrow_mut().insert(old, json!({ "liked_at": 5, "play_count": 3 }));
        s.events.borrow_mut().extend([(json!("a"), old), (json!("b"), old), (json!("c"), 99)]);
        s.tracks.borrow_mut().insert(old);
        s
    }

    #[test]
    fn migracao_substitui_enrichment_e_reaponta_plays() {
        let s = store_with_history(1);
        s.enrich.borrow_mut().insert(2, json!({ "lixo": true }));
        let (warn, left) = migrate_history(&s, 1, 2, vec![json!("a"), json!("b")]);
        assert!(warn.is_empty() && left.is_empty());
        assert_eq!(s.enrich.borrow()[&2], json!({ "liked_at": 5, "play_count": 3 }), "PUT completo, sem merge");
        assert!(!s.enrich.borrow().contains_key(&1));
        assert!(!s.tracks.borrow().contains(&1));
        assert_eq!(s.events.borrow().iter().filter(|(_, t)| *t == 2).count(), 2);
    }

    #[test]
    fn reaponte_parcial_devolve_o_resto_e_avisa() {
        let s = store_with_history(1);
        s.fail_after.set(Some(1));
        let (warn, left) = migrate_history(&s, 1, 2, vec![json!("a"), json!("b")]);
        assert_eq!(left, vec![json!("b")]);
        assert!(warn[0].contains("1 de 2"), "{warn:?}");
    }

    #[test]
    fn conferencia_final_pega_play_gravado_durante_o_lote() {
        let s = store_with_history(1);
        let mut items = vec![MoveItem {
            track_id: "1".into(), new_track_id: Some("2".into()), new_path: None, new_lrc_path: None,
            title: None, status: MoveStatus::Moved, detail: None,
        }];
        sweep_late_events(&s, &mut items);
        assert_eq!(s.events.borrow().iter().filter(|(_, t)| *t == 1).count(), 0);
        assert_eq!(s.events.borrow().iter().filter(|(_, t)| *t == 99).count(), 1, "outras faixas intactas");
        assert!(items[0].detail.is_none());
    }

    #[test]
    fn replay_sem_upsert_desfaz_o_rename() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        fs::create_dir_all(r.join("Nova/A/B")).unwrap();
        fs::create_dir_all(r.join("Rap/A/B")).unwrap();
        fs::write(r.join("Nova/A/B/1.flac"), "1").unwrap();
        fs::write(r.join("Nova/A/B/1.lrc"), "l").unwrap();
        let journal = Journal::in_dir(&r.join(".data"));
        journal
            .write(&MoveIntent {
                old_id: 1, new_id: 2,
                src: r.join("Rap/A/B/1.flac"), dst: r.join("Nova/A/B/1.flac"),
                lrc_src: Some(r.join("Rap/A/B/1.lrc")), lrc_dst: Some(r.join("Nova/A/B/1.lrc")),
                upserted: false,
            })
            .unwrap();
        let s = store_with_history(1);
        assert_eq!(replay_pending(&s, &journal, r), Some(ReplayOutcome::Undone));
        assert!(r.join("Rap/A/B/1.flac").is_file() && r.join("Rap/A/B/1.lrc").is_file());
        assert!(!r.join("Nova").exists());
        assert!(journal.load().is_none());
        // Histórico intocado: o ponto antigo continua sendo o válido.
        assert!(s.tracks.borrow().contains(&1));
        assert_eq!(replay_pending(&s, &journal, r), None, "idempotente");
    }

    #[test]
    fn replay_com_upsert_completa_o_historico() {
        let tmp = tempfile::tempdir().unwrap();
        let journal = Journal::in_dir(tmp.path());
        let intent = MoveIntent {
            old_id: 1, new_id: 2,
            src: tmp.path().join("Rap/x.flac"), dst: tmp.path().join("Nova/x.flac"),
            lrc_src: None, lrc_dst: None, upserted: true,
        };
        journal.write(&intent).unwrap();
        assert_eq!(journal.load(), Some(intent));
        let s = store_with_history(1);
        assert_eq!(replay_pending(&s, &journal, tmp.path()), Some(ReplayOutcome::Completed(vec![])));
        assert_eq!(s.enrich.borrow()[&2]["liked_at"], 5);
        assert_eq!(s.events.borrow().iter().filter(|(_, t)| *t == 2).count(), 2);
        assert!(!s.tracks.borrow().contains(&1));
        assert!(journal.load().is_none());
    }
}
