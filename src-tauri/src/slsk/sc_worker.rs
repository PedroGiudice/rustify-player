//! sc_worker.rs — thread `sc-worker`: executa o download de UMA faixa do
//! SoundCloud e entrega um FLAC pronto (tags + capa) ao coordinator. Nunca
//! escreve no board: só o consulta para abandonar tarefa cancelada. Todo
//! arquivo fica em `.rustify-incoming`; o que não vira `Done` é apagado aqui.
//! Spec §2.4 e §4.3.

use std::sync::Arc;
use std::time::Instant;

use crossbeam_channel::{Receiver, Sender};
use library_indexer::tagwrite::{write_tags, TagSet};
use library_indexer::transcode::{self, MediaProbe, Tools};
use soundcloud_client::{artwork_500, ScError, SoundCloudApi};

use super::board::{FormatIn, JobBoard, RejectReason, Source};
use super::coordinator::{FetchEvent, FetchTask};
use super::sources::SourcesConfig;

/// Piso do MP3 original (spec §3, política de lossy).
pub const MIN_MP3_KBPS: u32 = 300;
/// Teto da capa baixada da fonte.
const COVER_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Lado máximo da capa embutida no FLAC.
const COVER_MAX_SIDE: u32 = 1500;
/// Intervalo mínimo entre eventos de progresso.
const PROGRESS_EVERY_MS: u128 = 300;

/// Puro, testável: decide o `FormatIn` (ou a rejeição) a partir da sondagem
/// do arquivo BAIXADO. A extensão só desempata PCM (AIFF x WAV); o codec
/// real manda: um `.wav` que é MP3 por dentro segue a regra do MP3.
pub fn classify_original(ext: &str, p: &MediaProbe) -> Result<FormatIn, RejectReason> {
    match p.codec.as_str() {
        "flac" => Ok(FormatIn::Flac),
        c if c.starts_with("pcm_") => {
            if ext.eq_ignore_ascii_case("aiff") || ext.eq_ignore_ascii_case("aif") {
                return Ok(FormatIn::Aiff);
            }
            Ok(if p.bits_per_sample.unwrap_or(16) >= 24 { FormatIn::Wav24 } else { FormatIn::Wav16 })
        }
        "mp3" => {
            let kbps = p.bit_rate_kbps.unwrap_or(0);
            if kbps >= MIN_MP3_KBPS {
                Ok(FormatIn::Mp3_320)
            } else {
                Err(RejectReason::LowBitrate { kbps })
            }
        }
        _ => Err(RejectReason::NoDownload),
    }
}

/// Sobe a thread `sc-worker`. Uma tarefa por vez, na ordem do canal; cada
/// tarefa termina em exatamente um evento final (`Done`, `Rejected` ou
/// `Failed`), mesmo em panic. A thread acaba quando o `Sender` das tarefas
/// é derrubado.
#[allow(dead_code)] // ligado ao coordinator na Task 7 do plano Crate fase 1
pub fn spawn_sc_worker(
    rx: Receiver<FetchTask>,
    tx: Sender<FetchEvent>,
    api: Arc<dyn SoundCloudApi>,
    cfg: Arc<SourcesConfig>,
    board: Arc<JobBoard>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("sc-worker".into())
        .spawn(move || {
            for task in rx.iter() {
                let ev = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_task(&task, api.as_ref(), &cfg, &board, &tx)
                }))
                .unwrap_or_else(|_| FetchEvent::Failed {
                    job_id: task.job_id.clone(),
                    attempt: task.attempt,
                    reason: "falha interna no download do SoundCloud".into(),
                    retryable: false,
                });
                let _ = tx.send(ev);
            }
        })
        .expect("spawn sc-worker")
}

fn run_task(
    t: &FetchTask,
    api: &dyn SoundCloudApi,
    cfg: &SourcesConfig,
    board: &JobBoard,
    tx: &Sender<FetchEvent>,
) -> FetchEvent {
    let job_id = t.job_id.clone();
    let attempt = t.attempt;
    let fail = |reason: String, retryable: bool| FetchEvent::Failed { job_id: job_id.clone(), attempt, reason, retryable };
    let canceled = || fail("cancelado".into(), false);
    let Source::SoundCloud { track_id, .. } = &t.source else {
        return fail("worker do SoundCloud recebeu outra origem".into(), false);
    };
    // O token é lido do arquivo agora e só circula em memória: nunca em
    // log, evento ou mensagem de erro.
    let token = match cfg.read_sc_token() {
        Ok(tk) => tk,
        Err(e) => return fail(format!("sem token do SoundCloud: {e}"), false),
    };
    if board.is_canceled(&job_id, attempt) {
        return canceled();
    }

    // 1) sondagem do original
    let orig = match api.probe_original(*track_id, &token, 0) {
        Ok(o) => o,
        Err(ScError::NoToken) => return fail("token do SoundCloud recusado (expirado?)".into(), false),
        Err(ScError::RateLimited) => {
            return fail("SoundCloud limitou as chamadas; tente em alguns minutos".into(), true)
        }
        Err(e) => return fail(format!("SoundCloud: {e}"), true),
    };

    // 2) download para o incoming
    let raw = t.incoming_dir.join(format!("{}.{}", t.file_stem(), orig.ext));
    let _ = tx.send(FetchEvent::Started { job_id: job_id.clone(), attempt });
    let started = Instant::now();
    let mut last: Option<Instant> = None;
    let mut cb = |done: u64, total: Option<u64>| {
        let fim = total.is_some_and(|tt| done >= tt);
        if !fim && last.is_some_and(|l| l.elapsed().as_millis() < PROGRESS_EVERY_MS) {
            return;
        }
        last = Some(Instant::now());
        let secs = started.elapsed().as_secs_f64().max(0.001);
        let bps = (done as f64 / secs) as u64;
        let pct = total
            .map(|tt| if tt > 0 { (done as f32 * 100.0 / tt as f32).min(100.0) } else { 0.0 })
            .unwrap_or(0.0);
        let eta_s = total
            .filter(|tt| bps > 0 && *tt > done)
            .map(|tt| u32::try_from((tt - done) / bps).unwrap_or(u32::MAX));
        let _ = tx.send(FetchEvent::Progress { job_id: job_id.clone(), attempt, pct, bps, eta_s });
    };
    if let Err(e) = api.download(&orig.url, &raw, &mut cb) {
        let _ = std::fs::remove_file(&raw);
        return match e {
            ScError::NoToken | ScError::Http(401) | ScError::Http(403) => {
                fail("token do SoundCloud recusado no download".into(), false)
            }
            ScError::RateLimited => fail("SoundCloud limitou as chamadas; tente em alguns minutos".into(), true),
            e => fail(format!("download: {e}"), true),
        };
    }
    if board.is_canceled(&job_id, attempt) {
        let _ = std::fs::remove_file(&raw);
        return canceled();
    }

    // 3) sondagem real e classificação (a extensão pode mentir)
    let tools = Tools::from_ffmpeg(&cfg.ffmpeg);
    let probe = match transcode::probe_media(&tools, &raw) {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_file(&raw);
            let retryable = e.retryable();
            return fail(format!("arquivo baixado não é áudio legível: {e}"), retryable);
        }
    };
    let format_in = match classify_original(&orig.ext, &probe) {
        Ok(f) => f,
        Err(reason) => {
            let _ = std::fs::remove_file(&raw);
            return FetchEvent::Rejected { job_id, attempt, reason, quarantine: None };
        }
    };

    // 4) FLAC no incoming
    let flac = t.incoming_dir.join(format!("{}.flac", t.file_stem()));
    let conv = if format_in == FormatIn::Flac {
        std::fs::rename(&raw, &flac).map_err(|e| (format!("FLAC original: {e}"), false))
    } else {
        transcode::to_flac(&tools, &raw, &flac).map_err(|e| (e.to_string(), e.retryable()))
    };
    if raw != flac {
        let _ = std::fs::remove_file(&raw);
    }
    if let Err((reason, retryable)) = conv {
        let _ = std::fs::remove_file(&flac);
        return fail(reason, retryable);
    }
    if board.is_canceled(&job_id, attempt) {
        let _ = std::fs::remove_file(&flac);
        return canceled();
    }

    // 5) capa (melhor esforço) e tags confirmadas no card
    let cover = t
        .artwork_url
        .as_deref()
        .and_then(|u| api.fetch_bytes(&artwork_500(u), COVER_MAX_BYTES).ok())
        .and_then(|b| library_indexer::resize_cover_jpeg(&b, COVER_MAX_SIDE).ok());
    let comment = if format_in.is_lossy() { Some("source: lossy mp3") } else { None };
    let tags = TagSet {
        artist: &t.meta.artist,
        album_artist: &t.meta.artist,
        album: &t.meta.album,
        title: &t.meta.title,
        year: t.meta.year,
        track_no: 1,
        track_total: 1,
        genre: &t.playlist,
        label: t.meta.label.as_deref(),
        comment,
    };
    if let Err(e) = write_tags(&flac, &tags, cover.as_deref()) {
        let _ = std::fs::remove_file(&flac);
        return fail(format!("tags: {e}"), false);
    }
    FetchEvent::Done { job_id, attempt, flac_path: flac, format_in }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::board::{ConfirmedMeta, DownloadJob, JobState};
    use soundcloud_client::{Original, ScTrack};
    use std::sync::Mutex;

    #[test]
    fn classify_original_cobre_a_tabela_da_spec() {
        let p = |codec: &str, kbps: Option<u32>, bits: Option<u16>| MediaProbe { codec: codec.into(), duration_s: 100.0, bit_rate_kbps: kbps, bits_per_sample: bits };
        assert_eq!(classify_original("wav", &p("pcm_s24le", None, Some(24))), Ok(FormatIn::Wav24));
        assert_eq!(classify_original("wav", &p("pcm_s16le", None, Some(16))), Ok(FormatIn::Wav16));
        assert_eq!(classify_original("aiff", &p("pcm_s16be", None, Some(16))), Ok(FormatIn::Aiff));
        assert_eq!(classify_original("flac", &p("flac", None, Some(16))), Ok(FormatIn::Flac));
        assert_eq!(classify_original("mp3", &p("mp3", Some(320), None)), Ok(FormatIn::Mp3_320));
        assert_eq!(classify_original("mp3", &p("mp3", Some(128), None)), Err(RejectReason::LowBitrate { kbps: 128 }));
        // extensão mente: ".wav" que é mp3 por dentro segue a sondagem
        assert_eq!(classify_original("wav", &p("mp3", Some(192), None)), Err(RejectReason::LowBitrate { kbps: 192 }));
        assert_eq!(classify_original("m4a", &p("aac", Some(256), None)), Err(RejectReason::NoDownload));
    }

    struct FakeSc { src: std::path::PathBuf, ext: &'static str, fail_401: bool, log: Mutex<Vec<String>> }
    impl SoundCloudApi for FakeSc {
        fn search(&self, _: &str, _: u32) -> Result<Vec<ScTrack>, ScError> { unimplemented!() }
        fn resolve(&self, _: &str) -> Result<ScTrack, ScError> { unimplemented!() }
        fn probe_original(&self, _: u64, _: &str, _: u64) -> Result<Original, ScError> {
            if self.fail_401 { return Err(ScError::NoToken); }
            Ok(Original { url: "fake://orig".into(), ext: self.ext.into(), size: Some(std::fs::metadata(&self.src).unwrap().len()), kbps_est: None })
        }
        fn download(&self, _: &str, dest: &std::path::Path, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<(), ScError> {
            std::fs::copy(&self.src, dest).unwrap(); progress(10, Some(10)); self.log.lock().unwrap().push("download".into()); Ok(())
        }
        fn fetch_bytes(&self, _: &str, _: usize) -> Result<Vec<u8>, ScError> { Err(ScError::Http(404)) }
        fn me(&self, _: &str) -> Result<(), ScError> { Ok(()) }
    }

    fn ffmpeg_ok() -> bool {
        let ok = transcode::ffmpeg_available(&Tools::default());
        if !ok { eprintln!("sem ffmpeg: teste pulado"); }
        ok
    }

    /// Job "j1" tentativa 0 no board: sem ele `is_canceled` é `true` (job
    /// ausente) e o worker abandonaria a tarefa antes de baixar.
    fn board_com_job() -> Arc<JobBoard> {
        let board = JobBoard::new();
        board.upsert(DownloadJob {
            job_id: "j1".into(),
            source: Source::SoundCloud { track_id: 1, permalink_url: "https://soundcloud.com/a/b".into() },
            meta: ConfirmedMeta::default(),
            artwork_url: None,
            format_in: None,
            tracks: 1,
            display: "DJ Arana - Festa".into(),
            dest_playlist: "Funk Brasileiro".into(),
            state: JobState::Enqueued { queue_position: None },
            quality_label: String::new(),
            alternates: Vec::new(),
            tried_source_ids: Vec::new(),
            created_at: 0,
            attempt: 0,
        });
        Arc::new(board)
    }

    fn setup(ext: &'static str, extra: &[&str], fail_401: bool) -> (tempfile::TempDir, Arc<FakeSc>, Arc<SourcesConfig>, Arc<JobBoard>) {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join(format!("orig.{ext}"));
        let st = std::process::Command::new("ffmpeg").args(["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "2"]).args(extra).arg(&src).status().unwrap();
        assert!(st.success());
        let token = tmp.path().join("tok.txt"); std::fs::write(&token, "2-x-y-z").unwrap();
        let mut cfg = SourcesConfig::load_with(tmp.path(), |_| None); cfg.sc_token_file = token;
        (tmp, Arc::new(FakeSc { src, ext, fail_401, log: Mutex::new(vec![]) }), Arc::new(cfg), board_com_job())
    }

    fn task(tmp: &tempfile::TempDir) -> FetchTask {
        let incoming = tmp.path().join(".rustify-incoming"); std::fs::create_dir_all(&incoming).unwrap();
        FetchTask { job_id: "j1".into(), attempt: 0, source: Source::SoundCloud { track_id: 1, permalink_url: "https://soundcloud.com/a/b".into() },
            meta: ConfirmedMeta { artist: "DJ Arana".into(), title: "Festa".into(), album: "Festa".into(), year: Some(2024), label: None },
            artwork_url: None, playlist: "Funk Brasileiro".into(), incoming_dir: incoming }
    }

    fn run_one(api: Arc<FakeSc>, cfg: Arc<SourcesConfig>, board: Arc<JobBoard>, t: FetchTask) -> Vec<FetchEvent> {
        let (ftx, frx) = crossbeam_channel::bounded(1); let (etx, erx) = crossbeam_channel::unbounded();
        let h = spawn_sc_worker(frx, etx, api, cfg, board); ftx.send(t).unwrap(); drop(ftx); h.join().unwrap();
        erx.try_iter().collect()
    }

    #[test]
    fn wav_vira_flac_com_tags_e_done() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup("wav", &["-c:a", "pcm_s24le"], false);
        let evs = run_one(api, cfg, board, task(&tmp));
        let done = evs.iter().find_map(|e| if let FetchEvent::Done { flac_path, format_in, .. } = e { Some((flac_path.clone(), *format_in)) } else { None }).expect("Done");
        assert_eq!(done.1, FormatIn::Wav24);
        let md = library_indexer::parse_flac(&done.0).unwrap();
        assert_eq!(md.artist.as_deref(), Some("DJ Arana")); assert_eq!(md.genre_raw.as_deref(), Some("Funk Brasileiro"));
        assert!(evs.iter().any(|e| matches!(e, FetchEvent::Progress { .. })));
        assert!(!tmp.path().join(".rustify-incoming/j1.a0.wav").exists(), "original convertido sai do incoming");
    }

    #[test]
    fn mp3_abaixo_de_300_rejeita_low_bitrate() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup("mp3", &["-b:a", "128k"], false);
        let evs = run_one(api, cfg, board, task(&tmp));
        assert!(matches!(evs.last(), Some(FetchEvent::Rejected { reason: RejectReason::LowBitrate { .. }, .. })), "{evs:?}");
        assert!(!tmp.path().join(".rustify-incoming/j1.a0.mp3").exists(), "original rejeitado sai do incoming");
    }

    #[test]
    fn mp3_320_entra_com_comment_de_origem() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup("mp3", &["-b:a", "320k"], false);
        let evs = run_one(api, cfg, board, task(&tmp));
        let (path, fmt) = evs.iter().find_map(|e| if let FetchEvent::Done { flac_path, format_in, .. } = e { Some((flac_path.clone(), *format_in)) } else { None }).unwrap();
        assert_eq!(fmt, FormatIn::Mp3_320);
        let tagged = lofty::read_from_path(&path).unwrap();
        use lofty::prelude::*; let c = tagged.primary_tag().and_then(|t| t.comment().map(|s| s.to_string()));
        assert_eq!(c.as_deref(), Some("source: lossy mp3"));
    }

    #[test]
    fn fake_sc_download_401_falha_sem_retry() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup("wav", &[], true);
        let evs = run_one(api, cfg, board, task(&tmp));
        assert!(matches!(evs.last(), Some(FetchEvent::Failed { retryable: false, reason, .. }) if reason.contains("token")), "{evs:?}");
    }

    #[test]
    fn sem_arquivo_de_token_falha_antes_de_baixar() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup("wav", &[], false);
        let mut cfg2 = (*cfg).clone(); cfg2.sc_token_file = tmp.path().join("inexistente.txt");
        let evs = run_one(api.clone(), Arc::new(cfg2), board, task(&tmp));
        assert!(matches!(evs.last(), Some(FetchEvent::Failed { retryable: false, .. })));
        assert!(api.log.lock().unwrap().is_empty(), "nao baixou nada");
    }

    #[test]
    fn job_cancelado_nao_baixa() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, _) = setup("wav", &[], false);
        let evs = run_one(api.clone(), cfg, Arc::new(JobBoard::new()), task(&tmp));
        assert!(matches!(evs.last(), Some(FetchEvent::Failed { retryable: false, .. })), "{evs:?}");
        assert!(api.log.lock().unwrap().is_empty(), "job fora do board não baixa");
    }
}
