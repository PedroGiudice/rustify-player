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
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use tracing::{info, warn};

/// Desfecho de uma faixa num pedido de mover.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MoveStatus {
    Moved,
    AlreadyThere,
    Failed,
}

/// Uma linha do relatório. Ids como string: são u64 e passam de 2^53.
#[derive(Debug, Clone, Serialize)]
pub struct MoveItem {
    pub track_id: String,
    pub new_track_id: Option<String>,
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
            items,
        }
    }

    /// Relatório com todas as faixas falhando pelo mesmo motivo (destino
    /// inválido, Qdrant fora, indexador desligado).
    pub fn all_failed(dest_playlist: &str, ids: &[u64], reason: &str) -> Self {
        let items = ids
            .iter()
            .map(|id| MoveItem {
                track_id: id.to_string(),
                new_track_id: None,
                title: None,
                status: MoveStatus::Failed,
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
    pub new_lrc: Option<PathBuf>,
    pub warnings: Vec<String>,
}

/// `rename`; entre sistemas de arquivos (EXDEV), copia preservando o mtime
/// (o scan compara mtime/tamanho: sem preservar, reindexaria do zero) e
/// remove a origem.
fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(18) => {
            copy_preserving_mtime(from, to)?;
            fs::remove_file(from)
        }
        Err(e) => Err(e),
    }
}

fn copy_preserving_mtime(from: &Path, to: &Path) -> io::Result<()> {
    fs::copy(from, to)?;
    let mtime = fs::metadata(from)?.modified()?;
    fs::OpenOptions::new().write(true).open(to)?.set_modified(mtime)
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

    fs::create_dir_all(&dst_dir).map_err(|e| format!("criar pasta de destino: {e}"))?;
    move_file(src, dst).map_err(|e| format!("mover arquivo: {e}"))?;

    let mut out = FsOutcome {
        ops: vec![FsOp::Moved { from: src.to_path_buf(), to: dst.to_path_buf() }],
        new_lrc: None,
        warnings: Vec::new(),
    };

    if let Some(lrc) = lrc_src {
        let lrc_dst = dst.with_extension("lrc");
        if lrc_dst.exists() {
            out.warnings.push("letra .lrc já existia no destino; a da origem ficou".into());
            out.new_lrc = Some(lrc_dst);
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
        let result = match cover_action(cover_dst.exists(), left) {
            CoverAction::Move => move_file(&cover, &cover_dst)
                .map(|()| out.ops.push(FsOp::Moved { from: cover.clone(), to: cover_dst.clone() })),
            CoverAction::Copy => fs::copy(&cover, &cover_dst)
                .map(|_| out.ops.push(FsOp::Copied { to: cover_dst.clone() })),
            CoverAction::RemoveSource => fs::remove_file(&cover),
            CoverAction::Keep => Ok(()),
        };
        if let Err(e) = result {
            out.warnings.push(format!("capa {} não acompanhou: {e}", name.to_string_lossy()));
        }
    }
    Ok(out)
}

/// Desfaz a parte de disco (o índice recusou o ponto novo): o arquivo volta
/// para onde estava e as cópias de capa somem. Capa já REMOVIDA da origem
/// (destino tinha a mesma) não volta — o destino continua com ela.
pub fn rollback_files(outcome: &FsOutcome) {
    for op in outcome.ops.iter().rev() {
        let r = match op {
            FsOp::Moved { from, to } => move_file(to, from),
            FsOp::Copied { to } => fs::remove_file(to),
        };
        if let Err(e) = r {
            warn!(target: "library_indexer::relocate", ?op, error = %e, "rollback falhou");
        }
    }
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
// Orquestração (roda na thread do coordinator)
// ---------------------------------------------------------------------------

pub fn move_tracks(client: &QdrantClient, music_root: &Path, ids: &[u64], dest_playlist: &str) -> MoveReport {
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

    let items = ids
        .iter()
        .map(|&id| move_one(client, music_root, id, dest_playlist, &mut events))
        .collect();
    let report = MoveReport::new(dest_playlist, items);
    info!(
        target: "library_indexer::relocate",
        dest = dest_playlist, moved = report.moved, already = report.already_there, failed = report.failed,
        "mover para playlist concluído"
    );
    report
}

fn move_one(
    client: &QdrantClient,
    music_root: &Path,
    old_id: u64,
    dest: &str,
    events: &mut HashMap<u64, Vec<Value>>,
) -> MoveItem {
    let mut item = MoveItem {
        track_id: old_id.to_string(),
        new_track_id: None,
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

    let fs_out = match relocate_files(&src, &dst) {
        Ok(o) => o,
        Err(e) => return fail(item, e),
    };

    let new_id = path_to_id(&dst);
    let new_payload = relocated_payload(&payload, &dst, fs_out.new_lrc.as_deref(), dest);
    if let Err(e) = client.upsert_point_raw(new_id, &new_payload, &vector) {
        rollback_files(&fs_out);
        return fail(item, format!("gravar faixa no índice: {e} (arquivo devolvido à origem)"));
    }

    let mut warnings = fs_out.warnings;
    match client.get_enrichment(old_id) {
        Ok(enr) if enr.as_object().is_some_and(|m| !m.is_empty()) => {
            match client.set_enrichment(new_id, enr) {
                Ok(()) => {
                    if let Err(e) = client.delete_enrichment(old_id) {
                        warnings.push(format!("enrichment antigo não foi apagado: {e}"));
                    }
                }
                Err(e) => warnings.push(format!("like/vibe não acompanharam: {e}")),
            }
        }
        Ok(_) => {}
        Err(e) => warnings.push(format!("like/vibe não acompanharam: {e}")),
    }
    if let Some(pids) = events.remove(&old_id) {
        match client.set_play_events_track_id(&pids, new_id) {
            Ok(()) => {
                events.insert(new_id, pids);
            }
            Err(e) => {
                warnings.push(format!("histórico de plays não acompanhou: {e}"));
                events.insert(old_id, pids);
            }
        }
    }
    // Por último: se falhar, o próximo scan apaga (o caminho sumiu do disco).
    if let Err(e) = client.delete_points(&[old_id]) {
        warnings.push(format!("ponto antigo será limpo no próximo scan: {e}"));
    }

    if let Some(src_dir) = src.parent() {
        if let Ok(rel) = src.strip_prefix(music_root) {
            if let Some(first) = rel.components().next() {
                remove_empty_dirs(src_dir, &music_root.join(first));
            }
        }
    }

    item.status = MoveStatus::Moved;
    item.new_track_id = Some(new_id.to_string());
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
        rollback_files(&out);
        assert!(src.is_file() && !dst.exists());
        assert!(!r.join("Nova/A/B/folder.jpg").exists());
        assert!(album.join("folder.jpg").is_file());
    }

    #[test]
    fn relatorio_conta_por_status() {
        let mk = |s| MoveItem { track_id: "1".into(), new_track_id: None, title: None, status: s, detail: None };
        let r = MoveReport::new("X", vec![mk(MoveStatus::Moved), mk(MoveStatus::Moved), mk(MoveStatus::AlreadyThere), mk(MoveStatus::Failed)]);
        assert_eq!((r.moved, r.already_there, r.failed), (2, 1, 1));
        let s = serde_json::to_value(&r).unwrap();
        assert_eq!(s["items"][2]["status"], "already_there");
    }
}
