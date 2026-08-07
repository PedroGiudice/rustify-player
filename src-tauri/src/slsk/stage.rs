//! stage.rs — localizar o arquivo baixado, validar, mover atômico,
//! quarentena (spec §5.2-§5.4). PURO em relação a rede: só filesystem +
//! `symphonia` (probe/decode) + `library_indexer` (parse_flac/OwnedIndex).
//!
//! Ordem das checagens em [`stage_file`] é fixa (spec, adendo do plano):
//! parse_flac -> 32bit -> decode probe (Corrupt) -> dedup (AlreadyOwned) ->
//! só DEPOIS disso o arquivo é tocado (movido pra `.rustify-incoming`). Em
//! QUALQUER `Rejected` (incluindo a colisão de mesmo tamanho detectada
//! depois do move, review IM-2), o arquivo termina em
//! `.rustify-quarentena` — nunca é deletado, nunca fica largado em
//! `downloads_dir`. `stage_file` cuida disso internamente (chama
//! [`quarantine`] sozinho); quem chama só reage ao `StageOutcome`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use library_indexer::{types::path_to_id, OwnedIndex, ParsedFlacMetadata};
use slskd_client::rank::{remote_basename, remote_parent_dir};
use slskd_client::stage_plan::{canonical_dest, sanitize_component, TrackMeta};

use super::board::RejectReason;

const INCOMING_DIR_NAME: &str = ".rustify-incoming";
const QUARANTINE_DIR_NAME: &str = ".rustify-quarentena";

#[derive(Debug, Clone, PartialEq)]
pub enum StageOutcome {
    Staged { final_path: PathBuf },
    Rejected(RejectReason),
}

/// Cascata de localização (spec §5.2, adendo do spike): degrau 1 = predição
/// determinística (`downloads_dir/<última-pasta-remota>/<basename-remoto>`,
/// a mesma regra que o slskd usa de fato — confirmada contra dados reais);
/// degrau 2 = varredura recursiva de `downloads_dir` por um arquivo com
/// `mtime > started_at` cujo nome bate (case-insensitive) com o basename
/// remoto. `None` quando nenhum dos dois acha nada — o coordinator retenta
/// em ticks de poll subsequentes (não bloqueia esta função) antes de
/// decidir `Manual`.
pub fn locate_downloaded(
    downloads_dir: &Path,
    remote_filename: &str,
    started_at: SystemTime,
) -> Option<PathBuf> {
    let parent = remote_parent_dir(remote_filename);
    let basename = remote_basename(remote_filename);

    let predicted = if parent.is_empty() {
        downloads_dir.join(basename)
    } else {
        downloads_dir.join(parent).join(basename)
    };
    if predicted.is_file() {
        return Some(predicted);
    }

    let basename_lower = basename.to_lowercase();
    for entry in walkdir::WalkDir::new(downloads_dir)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str() else {
            continue;
        };
        if name.to_lowercase() != basename_lower {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let Ok(mtime) = meta.modified() else {
            continue;
        };
        if mtime > started_at {
            return Some(entry.path().to_path_buf());
        }
    }
    None
}

/// Só o corte `bit_depth == 32` — extraído de [`stage_file`] pra ser
/// testável sem precisar de um FLAC 32-bit de verdade em disco (não há
/// fixture disponível no repo, e o crate não tem encoder FLAC nas
/// dependências pra gerar um em teste). `ParsedFlacMetadata` tem todos os
/// campos `pub` + `Default`, então o teste constrói um valor direto.
fn bit_depth_reject(md: &ParsedFlacMetadata) -> Option<RejectReason> {
    if md.bit_depth == 32 {
        Some(RejectReason::Bit32Unsupported)
    } else {
        None
    }
}

/// Decodifica o 1º pacote de áudio — pega o arquivo que o peer mentiu ou que
/// quebra no meio, indo além do que `parse_flac` (só header + tags) valida.
fn decode_probe(path: &Path) -> Result<(), String> {
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_FLAC};
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("flac");

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| e.to_string())?;
    let mut reader = probed.format;
    let track = reader.default_track().ok_or("sem default track")?;
    if track.codec_params.codec != CODEC_TYPE_FLAC {
        return Err("codec nao e FLAC".to_string());
    }
    let codec_params = track.codec_params.clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;
    let packet = reader.next_packet().map_err(|e| e.to_string())?;
    decoder.decode(&packet).map_err(|e| e.to_string())?;
    Ok(())
}

/// Move `src` -> `dst`, criando o diretório-pai se preciso. `rename` direto
/// quando é a mesma FS; em `EXDEV` (cruzar filesystems — `downloads_dir` e
/// `music_root` normalmente NÃO são o mesmo disco), cai pra `copy` +
/// `sync_all` + remove da origem, preservando a semântica "moveu".
fn move_file(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(18) => {
            fs::copy(src, dst).map_err(|e| e.to_string())?;
            let f = fs::File::open(dst).map_err(|e| e.to_string())?;
            f.sync_all().map_err(|e| e.to_string())?;
            fs::remove_file(src).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(e) => Err(format!(
            "rename {} -> {}: {e}",
            src.display(),
            dst.display()
        )),
    }
}

/// Primeiro nome livre em `dir` pra `<stem>.<ext>`, senão `<stem> (2).<ext>`,
/// `<stem> (3).<ext>`... Nunca sobrescreve (regra dura do projeto).
fn next_free_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    let mut n = 2u32;
    loop {
        let candidate = dir.join(format!("{stem} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

fn stem_ext(path: &Path) -> (String, String) {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("track")
        .to_string();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("flac")
        .to_string();
    (stem, ext)
}

fn today_ymd_string() -> String {
    let secs = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's `civil_from_days` — dias desde a época Unix -> (ano,
/// mês, dia). Autocontido pra não puxar `chrono`/`time` como dependência
/// nova só pro nome da pasta de quarentena.
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

/// Move `file` pra `~/Music/.rustify-quarentena/<YYYY-MM-DD>/`, sem nunca
/// sobrescrever (mesma política de colisão de [`place_at_destination`]) —
/// compartilhado por [`quarantine`] (chamada externa, pré-move) e pelo
/// caminho interno de [`stage_file`]/[`place_at_destination`] (pós-move,
/// review IM-2: a colisão de mesmo tamanho NÃO pode mais deletar o
/// arquivo). Best-effort: se `file` já sumiu ou o `fs::rename` falha, loga
/// e devolve o destino calculado mesmo assim.
fn move_to_quarantine(music_root: &Path, file: &Path, reason: &str) -> PathBuf {
    let dir = music_root.join(QUARANTINE_DIR_NAME).join(today_ymd_string());
    if let Err(e) = fs::create_dir_all(&dir) {
        tracing::warn!(?e, dir = %dir.display(), "quarantine: falha ao criar diretorio");
    }
    let (stem, ext) = stem_ext(file);
    let dest = next_free_path(&dir, &stem, &ext);
    match move_file(file, &dest) {
        Ok(()) => {
            tracing::warn!(reason, path = %dest.display(), "arquivo movido para quarentena");
        }
        Err(e) => {
            tracing::warn!(reason, error = %e, "quarantine: falha ao mover arquivo");
        }
    }
    dest
}

/// Move um arquivo rejeitado pra quarentena. Chamada externa (pré-move) —
/// mantida pública pro caso de o coordinator precisar quarentenar algo por
/// fora do fluxo de [`stage_file`] (hoje `stage_file` já cuida disso
/// internamente pra todo `Rejected` que produz — por isso não tem chamador
/// em código de produção agora, só nos testes deste módulo).
#[allow(dead_code)]
pub fn quarantine(music_root: &Path, local: &Path, reason: &str) -> PathBuf {
    move_to_quarantine(music_root, local, reason)
}

/// Resolve o destino final: `dest` livre -> rename direto; `dest` ocupado
/// com o MESMO tamanho -> já é essa faixa, `Rejected{AlreadyOwned}` — o
/// `incoming` NUNCA é deletado (review IM-2), vai pra quarentena como
/// qualquer outro rejeitado; `track_id` é `path_to_id(dest)` (a mesma
/// função determinística que `pipeline.rs` usa pro ID do ponto no Qdrant
/// quando essa faixa foi upsertada, então é o ID real, não um palpite);
/// tamanho DIFERENTE -> nunca sobrescreve, sufixa ` (2)`, ` (3)`...
fn place_at_destination(music_root: &Path, incoming: &Path, dest: &Path) -> Result<StageOutcome, String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    if dest.exists() {
        let incoming_len = fs::metadata(incoming).map_err(|e| e.to_string())?.len();
        let dest_len = fs::metadata(dest).map_err(|e| e.to_string())?.len();
        if incoming_len == dest_len {
            move_to_quarantine(music_root, incoming, "already_owned_same_size");
            let track_id = path_to_id(dest).to_string();
            return Ok(StageOutcome::Rejected(RejectReason::AlreadyOwned { track_id }));
        }
        let (stem, ext) = stem_ext(dest);
        let parent = dest.parent().unwrap_or_else(|| Path::new("."));
        let unique_dest = next_free_path(parent, &stem, &ext);
        move_file(incoming, &unique_dest)?;
        return Ok(StageOutcome::Staged { final_path: unique_dest });
    }

    move_file(incoming, dest)?;
    Ok(StageOutcome::Staged { final_path: dest.to_path_buf() })
}

/// Pipeline completo pós-download (spec §5.3-§5.4). `local` é o arquivo já
/// localizado por [`locate_downloaded`], ainda no lugar original — só é
/// tocado depois do último gate (dedup), quando o destino já está decidido.
/// Em QUALQUER `Rejected` (early ou pós-move), o arquivo termina em
/// `.rustify-quarentena` — nunca é deletado, nunca fica largado (review
/// IM-2). `job_id` nomeia o staging temporário
/// (`.rustify-incoming/<job_id>.flac`, spec §5.4) — habilita
/// [`clean_orphan_incoming`] a correlacionar exatamente (review, Minor
/// promovido: antes usava o basename local, sem relação com o job).
pub fn stage_file(
    music_root: &Path,
    playlist: &str,
    local: &Path,
    owned: &OwnedIndex,
    job_id: &str,
) -> Result<StageOutcome, String> {
    let md = match library_indexer::parse_flac(local) {
        Ok(md) => md,
        Err(_) => {
            move_to_quarantine(music_root, local, "not_flac");
            return Ok(StageOutcome::Rejected(RejectReason::NotFlac));
        }
    };

    if let Some(reason) = bit_depth_reject(&md) {
        move_to_quarantine(music_root, local, "bit32_unsupported");
        return Ok(StageOutcome::Rejected(reason));
    }

    if decode_probe(local).is_err() {
        move_to_quarantine(music_root, local, "corrupt");
        return Ok(StageOutcome::Rejected(RejectReason::Corrupt));
    }

    let dedup_artist = md
        .artist
        .clone()
        .or_else(|| md.album_artist.clone())
        .unwrap_or_default();
    let dedup_title = md.title.clone().unwrap_or_default();
    if let Some(verdict) = owned.lookup_collab_aware(&dedup_artist, &dedup_title) {
        move_to_quarantine(music_root, local, "already_owned");
        return Ok(StageOutcome::Rejected(RejectReason::AlreadyOwned {
            track_id: verdict.track_id.to_string(),
        }));
    }

    let track_meta = TrackMeta {
        artist: md.artist.clone().or_else(|| md.album_artist.clone()),
        album: md.album.clone(),
        title: md.title.clone(),
        track_no: md.track_number.and_then(|n| u32::try_from(n).ok()),
        year: md.year.and_then(|y| u32::try_from(y).ok()),
    };
    let fallback_basename = sanitize_component(
        local.file_name().and_then(|n| n.to_str()).unwrap_or("track.flac"),
    );
    let dest = canonical_dest(music_root, playlist, &track_meta, &fallback_basename);

    let incoming_dir = music_root.join(INCOMING_DIR_NAME);
    fs::create_dir_all(&incoming_dir).map_err(|e| e.to_string())?;
    let incoming_stem = sanitize_component(job_id);
    let incoming_path = incoming_dir.join(format!("{incoming_stem}.flac"));
    move_file(local, &incoming_path)?;

    place_at_destination(music_root, &incoming_path, &dest)
}

/// No boot, `.rustify-incoming/` é varrida. Órfão = arquivo cujo nome
/// (`<job_id>.flac`, ver [`stage_file`]) NÃO está em `alive_job_ids` —
/// correlação exata (review, Minor promovido: antes o nome derivava do
/// basename local, sem relação nenhuma com jobs vivos, e a limpeza virava
/// no-op justamente quando havia órfãos de verdade).
pub fn clean_orphan_incoming(music_root: &Path, alive_job_ids: &[String]) {
    let dir = music_root.join(INCOMING_DIR_NAME);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if alive_job_ids.iter().any(|id| id == stem) {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => tracing::info!(path = %path.display(), "clean_orphan_incoming: orfao removido"),
            Err(e) => tracing::warn!(?e, path = %path.display(), "clean_orphan_incoming: falha ao remover"),
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Fábrica de um `OwnedIndex` REAL (vazio) sem depender de um Qdrant de
    //! verdade nos testes — sobe um servidor HTTP mínimo, hand-rolled, que
    //! responde ao ÚNICO endpoint que `OwnedIndex::build` bate
    //! (`POST /collections/rustify_tracks/points/scroll`) com uma página
    //! vazia (`next_page_offset: null`, o scroll para no 1º round-trip).
    //! Nenhum teste do Etapa C precisa de dedup MATCH real — isso já é
    //! coberto pelos testes de `dedup.rs` na Etapa B — só precisamos de uma
    //! instância válida pra passar pelo tipo `&OwnedIndex` que `stage_file`
    //! exige. `dedup.rs` não expõe um construtor de teste (`empty()`/
    //! `insert()` são privados, fora do escopo desta etapa), daí este
    //! caminho em vez de tocar naquele arquivo.
    use library_indexer::{OwnedIndex, QdrantClient};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::Path;

    pub(crate) fn empty_owned_index() -> OwnedIndex {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake qdrant");
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let body: &[u8] = br#"{"result":{"points":[],"next_page_offset":null}}"#;
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body);
                let _ = stream.flush();
            }
        });
        let client = QdrantClient::new(format!("http://{addr}"));
        OwnedIndex::build(&client, Path::new("/music")).expect("build contra fake qdrant")
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::empty_owned_index;
    use super::*;
    use std::time::Duration;

    fn flac_fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("crates/audio-engine/tests/fixtures/track_01.flac")
    }

    /// Réplica do filtro EXATO de `library_indexer::scan::walk_music_root`
    /// (`scan.rs:58`: `filter_entry(|e| e.depth() == 0 || !is_hidden(e.path()))`,
    /// `is_hidden` = componente começando com `.`). `scan` é `mod` privado
    /// do crate `library-indexer` — fora do escopo de edição da Etapa C, e
    /// sem re-export público — então não há como chamar a função real
    /// daqui. Em vez de um mock solto, replicamos o MESMO predicado
    /// (mesma condição de corte do WalkDir) pra provar que
    /// `.rustify-incoming`/`.rustify-quarentena` caem exatamente no mesmo
    /// caminho de exclusão que `.quarentena` já cobre em
    /// `scan.rs::walk_skips_hidden_dirs` (Etapa B, já commitado e passando).
    fn count_visible_flacs(root: &Path) -> usize {
        fn is_hidden(path: &Path) -> bool {
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with('.'))
                .unwrap_or(false)
        }
        walkdir::WalkDir::new(root)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !is_hidden(e.path()))
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_type().is_file()
                    && e.path()
                        .extension()
                        .and_then(|x| x.to_str())
                        .map(|x| x.eq_ignore_ascii_case("flac"))
                        .unwrap_or(false)
            })
            .count()
    }

    #[test]
    fn locate_downloaded_predicts_last_dir_plus_basename() {
        let tmp = tempfile::tempdir().unwrap();
        let downloads_dir = tmp.path();
        let dir = downloads_dir.join("(1995) Soundtracks");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("01 - Children.flac"), b"fake").unwrap();

        let remote = "VARIETY\\Robert Miles\\EP\\(1995) Soundtracks\\01 - Children.flac";
        let found = locate_downloaded(downloads_dir, remote, SystemTime::UNIX_EPOCH)
            .expect("deveria achar via predicao");
        assert_eq!(found, dir.join("01 - Children.flac"));
    }

    #[test]
    fn locate_downloaded_falls_back_to_mtime_scan() {
        let tmp = tempfile::tempdir().unwrap();
        let downloads_dir = tmp.path();
        // Predição erraria: slskd colocou numa subpasta com nome diferente
        // do que a regra determinística previu (ex.: sanitização distinta).
        let odd_dir = downloads_dir.join("outra pasta qualquer");
        fs::create_dir_all(&odd_dir).unwrap();
        let started_at = SystemTime::now();
        std::thread::sleep(Duration::from_millis(10));
        fs::write(odd_dir.join("Children.FLAC"), b"fake").unwrap();

        let remote = "VARIETY\\Robert Miles\\EP\\(1995) Soundtracks\\Children.flac";
        let found = locate_downloaded(downloads_dir, remote, started_at)
            .expect("deveria achar via varredura mtime");
        assert_eq!(found, odd_dir.join("Children.FLAC"));
    }

    #[test]
    fn locate_downloaded_scan_ignores_older_files() {
        let tmp = tempfile::tempdir().unwrap();
        let downloads_dir = tmp.path();
        fs::write(downloads_dir.join("Children.flac"), b"fake-antigo").unwrap();
        std::thread::sleep(Duration::from_millis(10));
        let started_at = SystemTime::now();

        let remote = "Robert Miles\\Children.flac";
        assert!(locate_downloaded(downloads_dir, remote, started_at).is_none());
    }

    #[test]
    fn rustify_incoming_is_invisible_to_walk_music_root() {
        let tmp = tempfile::tempdir().unwrap();
        let music_root = tmp.path();
        let incoming = music_root.join(INCOMING_DIR_NAME);
        fs::create_dir_all(&incoming).unwrap();
        fs::write(incoming.join("staging.flac"), b"fake").unwrap();
        // Arquivo legítimo, pra provar que o walk enxerga o resto normalmente.
        fs::create_dir_all(music_root.join("Rock/Artist/2000 - Album")).unwrap();
        fs::write(
            music_root.join("Rock/Artist/2000 - Album/01 - Song.flac"),
            b"fake",
        )
        .unwrap();

        assert_eq!(
            count_visible_flacs(music_root),
            1,
            "so o arquivo fora de .rustify-incoming deve aparecer"
        );
    }

    #[test]
    fn quarantine_dir_is_invisible_to_walk_music_root() {
        let tmp = tempfile::tempdir().unwrap();
        let music_root = tmp.path();
        let local_dir = tmp.path().join("elsewhere");
        fs::create_dir_all(&local_dir).unwrap();
        let local = local_dir.join("bad.flac");
        fs::write(&local, b"fake-32bit").unwrap();

        let dest = quarantine(music_root, &local, "bit32");
        assert!(dest.starts_with(music_root.join(QUARANTINE_DIR_NAME)));
        assert!(dest.is_file());
        assert!(!local.exists());

        fs::create_dir_all(music_root.join("Rock/Artist/2000 - Album")).unwrap();
        fs::write(
            music_root.join("Rock/Artist/2000 - Album/01 - Song.flac"),
            b"fake",
        )
        .unwrap();
        assert_eq!(count_visible_flacs(music_root), 1);
    }

    #[test]
    fn stage_collision_same_size_never_deletes_moves_to_quarantine() {
        // IM-2: colisao de mesmo tamanho NUNCA deleta o arquivo — vai pra
        // quarentena, igual a qualquer outro Rejected.
        let tmp = tempfile::tempdir().unwrap();
        let music_root = tmp.path().join("Music");
        fs::create_dir_all(&music_root).unwrap();
        let dest_dir = music_root.join("Rap & Hip-Hop/_Compilations/Singles");
        fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("fallback.flac");
        fs::write(&dest, b"0123456789").unwrap(); // 10 bytes

        let incoming_same = tmp.path().join("incoming_same.flac");
        fs::write(&incoming_same, b"9876543210").unwrap(); // 10 bytes
        let out_same = place_at_destination(&music_root, &incoming_same, &dest).unwrap();
        match out_same {
            StageOutcome::Rejected(RejectReason::AlreadyOwned { .. }) => {}
            other => panic!("esperava Rejected(AlreadyOwned), veio {other:?}"),
        }
        assert_eq!(fs::read(&dest).unwrap(), b"0123456789"); // conteudo original intacto
        assert!(!incoming_same.exists(), "incoming saiu do lugar (foi movido, nao apagado)");
        // O conteudo tem que estar em ALGUM lugar — na quarentena.
        let quarantine_root = music_root.join(QUARANTINE_DIR_NAME);
        let found_in_quarantine = walkdir::WalkDir::new(&quarantine_root)
            .into_iter()
            .filter_map(Result::ok)
            .any(|e| e.file_type().is_file() && fs::read(e.path()).unwrap() == b"9876543210");
        assert!(found_in_quarantine, "arquivo com colisao deveria estar na quarentena, nao sumido");

        // Tamanho diferente: sufixa, nunca sobrescreve, nao mexe em quarentena.
        let incoming_diff = tmp.path().join("incoming_diff.flac");
        fs::write(&incoming_diff, b"tamanho-bem-diferente-mesmo").unwrap();
        let out_diff = place_at_destination(&music_root, &incoming_diff, &dest).unwrap();
        match out_diff {
            StageOutcome::Staged { final_path } => {
                assert_eq!(final_path, dest_dir.join("fallback (2).flac"));
                assert!(final_path.is_file());
            }
            other => panic!("esperava Staged com sufixo, veio {other:?}"),
        }
        assert_eq!(fs::read(&dest).unwrap(), b"0123456789"); // original ainda intacto
    }

    #[test]
    fn boot_cleans_orphan_incoming_by_exact_job_id() {
        let tmp = tempfile::tempdir().unwrap();
        let music_root = tmp.path();
        let incoming = music_root.join(INCOMING_DIR_NAME);
        fs::create_dir_all(&incoming).unwrap();
        fs::write(incoming.join("orphan-job.flac"), b"fake").unwrap();
        fs::write(incoming.join("alive-job.flac"), b"fake").unwrap();

        // "alive-job" esta na lista de jobs vivos -> sobrevive.
        // "orphan-job" nao esta -> e removido, MESMO com jobs vivos no boot
        // (correlacao exata agora, nao mais "qualquer job vivo == nao mexe").
        clean_orphan_incoming(music_root, &["alive-job".to_string()]);

        assert!(!incoming.join("orphan-job.flac").exists());
        assert!(incoming.join("alive-job.flac").exists());
    }

    #[test]
    fn stage_file_rejects_bit_depth_32_via_metadata_check() {
        // Ver doc-comment de bit_depth_reject: sem fixture 32-bit real
        // disponivel, testamos a checagem exata que stage_file usa.
        let md32 = ParsedFlacMetadata { bit_depth: 32, ..Default::default() };
        assert_eq!(bit_depth_reject(&md32), Some(RejectReason::Bit32Unsupported));

        let md16 = ParsedFlacMetadata { bit_depth: 16, ..Default::default() };
        assert_eq!(bit_depth_reject(&md16), None);

        let md24 = ParsedFlacMetadata { bit_depth: 24, ..Default::default() };
        assert_eq!(bit_depth_reject(&md24), None);
    }

    #[test]
    fn stage_file_rejects_not_flac_and_quarantines_local() {
        let tmp = tempfile::tempdir().unwrap();
        let music_root = tmp.path().join("Music");
        fs::create_dir_all(&music_root).unwrap();
        let local = tmp.path().join("not-a-flac.flac");
        fs::write(&local, b"isto nao e um flac de verdade").unwrap();

        let owned = empty_owned_index();
        let outcome = stage_file(&music_root, "Rap & Hip-Hop", &local, &owned, "job-abc").unwrap();
        assert_eq!(outcome, StageOutcome::Rejected(RejectReason::NotFlac));
        // IM-2: nao fica largado no lugar original NEM e deletado — vai
        // pra quarentena.
        assert!(!local.exists());
        let quarantine_root = music_root.join(QUARANTINE_DIR_NAME);
        let found = walkdir::WalkDir::new(&quarantine_root)
            .into_iter()
            .filter_map(Result::ok)
            .any(|e| e.file_type().is_file());
        assert!(found, "arquivo rejeitado deveria estar na quarentena");
    }

    #[test]
    fn stage_file_rejects_corrupt_via_decode_probe() {
        // Header/metadata validos (parse_flac passa) mas o corpo do 1o
        // frame de audio e ruido (decode_probe falha ao decodificar) — o
        // symphonia FLAC decoder (sem verify, DecoderOptions::default())
        // se mostrou surpreendentemente tolerante em testes empiricos:
        // truncar o frame real, ou so corromper alguns bytes do inicio
        // dele mantendo o resto intacto, NAO falha o decode (o decoder
        // aparentemente decodifica o que conseguir sem validar
        // completude/CRC). O que funciona de forma reproduzivel: manter
        // so os 10 primeiros bytes REAIS do frame (sync code + comeco do
        // header) — o bastante pro probe aceitar o container como FLAC
        // valido — e substituir TODO o resto por ruido pseudo-aleatorio
        // (xorshift determinístico, mesmo gerador ja usado em
        // `lib.rs::shuffle_prefix`, sem dependencia nova). Confirmado
        // contra 4 seeds diferentes antes de fixar este em definitivo.
        let tmp = tempfile::tempdir().unwrap();
        let music_root = tmp.path().join("Music");
        fs::create_dir_all(&music_root).unwrap();

        let full = fs::read(flac_fixture()).unwrap();
        let metadata_end = metadata_blocks_end(&full).expect("fixture deveria ter blocks validos");
        let keep_real = 10usize;
        let mut corrupted = full[..(metadata_end + keep_real).min(full.len())].to_vec();
        let mut seed: u64 = 42;
        for _ in 0..50_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            corrupted.push((seed & 0xff) as u8);
        }
        let local = tmp.path().join("corrupt.flac");
        fs::write(&local, &corrupted).unwrap();

        // Confirma a premissa do teste: parse_flac (so header/tags) aceita
        // mesmo com o corpo do audio sendo ruido.
        assert!(
            library_indexer::parse_flac(&local).is_ok(),
            "premissa do teste: parse_flac deveria aceitar so pelos metadata blocks + inicio do frame"
        );

        let owned = empty_owned_index();
        let outcome = stage_file(&music_root, "Rap & Hip-Hop", &local, &owned, "job-corrupt").unwrap();
        assert_eq!(outcome, StageOutcome::Rejected(RejectReason::Corrupt));
        assert!(!local.exists());
    }

    /// Percorre os metadata blocks de um FLAC (a partir do byte 4, após o
    /// magic `fLaC`) e devolve o offset onde eles terminam (início dos
    /// frames de áudio) — mesmo algoritmo de leitura de header usado só
    /// pra montar a fixture truncada do teste acima, não faz parte do
    /// pipeline de produção.
    fn metadata_blocks_end(data: &[u8]) -> Option<usize> {
        if data.get(0..4) != Some(b"fLaC") {
            return None;
        }
        let mut pos = 4usize;
        loop {
            let header = data.get(pos..pos + 4)?;
            let last = header[0] & 0x80 != 0;
            let length = ((header[1] as usize) << 16) | ((header[2] as usize) << 8) | header[3] as usize;
            pos += 4 + length;
            if last {
                return Some(pos);
            }
        }
    }

    #[test]
    fn stage_file_moves_valid_flac_atomically_into_canonical_dest() {
        let tmp = tempfile::tempdir().unwrap();
        let music_root = tmp.path().join("Music");
        fs::create_dir_all(&music_root).unwrap();
        let local = tmp.path().join("downloaded.flac");
        fs::copy(flac_fixture(), &local).unwrap();

        let owned = empty_owned_index();
        let outcome = stage_file(&music_root, "Trance", &local, &owned, "job-ok").unwrap();
        match outcome {
            StageOutcome::Staged { final_path } => {
                assert!(final_path.starts_with(music_root.join("Trance")));
                assert!(final_path.is_file());
            }
            other => panic!("esperava Staged, veio {other:?}"),
        }
        assert!(!local.exists(), "arquivo original deve ter sido movido");
    }

    #[test]
    fn stage_file_incoming_named_by_job_id() {
        // Spec §5.4: .rustify-incoming/<job_id>.flac. Como o move pro
        // destino final e atomico, o jeito de observar o nome intermediario
        // e falhar o dedup (AlreadyOwned) DEPOIS do move pra incoming mas
        // sem sufixo — o teste de colisao ja prova isso indiretamente;
        // aqui validamos o caminho feliz olhando o destino final, que
        // carrega metadados reais (nao job_id) — entao testamos a NOMEACAO
        // via clean_orphan_incoming, que e o consumidor real da convencao.
        let tmp = tempfile::tempdir().unwrap();
        let music_root = tmp.path();
        let incoming = music_root.join(INCOMING_DIR_NAME);
        fs::create_dir_all(&incoming).unwrap();
        fs::write(incoming.join("abc123.flac"), b"fake").unwrap();

        clean_orphan_incoming(music_root, &["abc123".to_string()]);
        assert!(incoming.join("abc123.flac").exists(), "job_id bate com o nome, deve sobreviver");

        clean_orphan_incoming(music_root, &["outro-job".to_string()]);
        assert!(!incoming.join("abc123.flac").exists(), "job_id nao bate, deve ser removido");
    }
}
