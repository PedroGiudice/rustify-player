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

/// Teto da capa baixada da fonte.
const COVER_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Lado máximo da capa embutida no FLAC.
const COVER_MAX_SIDE: u32 = 1500;
/// Intervalo mínimo entre eventos de progresso.
const PROGRESS_EVERY_MS: u128 = 300;

/// Puro, testável: decide o `FormatIn` (ou a rejeição) a partir da sondagem
/// do arquivo BAIXADO. A extensão só desempata PCM (AIFF x WAV); o codec
/// real manda: um `.wav` que é MP3 por dentro segue a regra do MP3. Só
/// lossless entra (CEO, 15/10/2026): codec com perda é recusado em qualquer
/// bitrate; o corte espectral do lossless é checado depois, no `stage_file`.
pub fn classify_original(ext: &str, p: &MediaProbe) -> Result<FormatIn, RejectReason> {
    match p.codec.as_str() {
        "flac" => Ok(FormatIn::Flac),
        c if c.starts_with("pcm_") => {
            if ext.eq_ignore_ascii_case("aiff") || ext.eq_ignore_ascii_case("aif") {
                return Ok(FormatIn::Aiff);
            }
            Ok(if p.bits_per_sample.unwrap_or(16) >= 24 { FormatIn::Wav24 } else { FormatIn::Wav16 })
        }
        c @ ("mp3" | "mp2" | "aac" | "opus" | "vorbis" | "wmav2" | "ac3" | "eac3") => {
            Err(RejectReason::LossyFormat { format: c.to_ascii_uppercase() })
        }
        _ => Err(RejectReason::NoDownload),
    }
}

/// Sobe UMA thread `sc-worker`. Uma tarefa por vez, na ordem do canal; cada
/// tarefa termina em exatamente um evento final (`Done`, `Rejected` ou
/// `Failed`), mesmo em panic. A thread acaba quando o `Sender` das tarefas
/// é derrubado.
///
/// O teto do SoundCloud (`MAX_ACTIVE_SOUNDCLOUD`, spec §2.4) é de downloads
/// simultâneos: o wiring sobe essa quantidade de instâncias sobre o MESMO
/// `Receiver` (o canal do crossbeam é MPMC). Uma instância só deixaria o
/// segundo job aceito parado em `Enqueued` até o primeiro terminar.
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
                .unwrap_or_else(|_| {
                    // O panic pode ter deixado original, FLAC ou `.part`.
                    clean_task_files(&task);
                    FetchEvent::Failed {
                        job_id: task.job_id.clone(),
                        attempt: task.attempt,
                        reason: "falha interna no download do SoundCloud".into(),
                        retryable: false,
                    }
                });
                let _ = tx.send(ev);
            }
        })
        .expect("spawn sc-worker")
}

/// Apaga `<incoming_dir>/<file_stem>.*` (original, FLAC e `.part`) da
/// tentativa. Melhor esforço: pasta ausente não é erro.
fn clean_task_files(t: &FetchTask) {
    let prefix = format!("{}.", t.file_stem());
    let Ok(rd) = std::fs::read_dir(&t.incoming_dir) else { return };
    for entry in rd.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
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
    // Sem ffmpeg/ffprobe nada do que baixar vira FLAC: falha antes de gastar
    // a banda do original (spec §4.1).
    let tools = Tools::from_ffmpeg(&cfg.ffmpeg);
    if !transcode::ffmpeg_available(&tools) {
        return fail("ffmpeg ausente".into(), false);
    }
    if board.is_canceled(&job_id, attempt) {
        return canceled();
    }
    // Instalação nova (ou pasta oculta apagada) não tem `.rustify-incoming`:
    // nada antes do worker a cria, e o download daria ENOENT.
    if let Err(e) = std::fs::create_dir_all(&t.incoming_dir) {
        return fail(format!("pasta de entrada: {e}"), false);
    }

    // 1) sondagem do original
    let orig = match api.probe_original(*track_id, &token, 0) {
        Ok(o) => o,
        Err(ScError::NoToken) => return fail("token do SoundCloud recusado (expirado?)".into(), false),
        Err(ScError::RateLimited) => {
            return fail("SoundCloud limitou as chamadas; tente em alguns minutos".into(), true)
        }
        // Com token, 403/404 em `/download` = original indisponível para este
        // cliente: determinístico, tentar de novo não muda nada.
        Err(ScError::Http(403 | 404)) => {
            return FetchEvent::Rejected { job_id, attempt, reason: RejectReason::NoDownload, quarantine: None }
        }
        Err(e) => return fail(e.to_string(), true),
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
        clean_task_files(t);
        return match e {
            // O download vai para a URL assinada do CDN, sem token: 401/403
            // aqui é link expirado ou bloqueio, nunca o token (esse é julgado
            // na sondagem). Repetir faz nova sondagem e gera outro link.
            ScError::Http(401 | 403) => fail(
                "o SoundCloud recusou o link do original (expirado ou bloqueado); tente de novo".into(),
                true,
            ),
            ScError::RateLimited => fail("SoundCloud limitou as chamadas; tente em alguns minutos".into(), true),
            e => fail(format!("download: {e}"), true),
        };
    }
    if board.is_canceled(&job_id, attempt) {
        let _ = std::fs::remove_file(&raw);
        return canceled();
    }

    // 3) sondagem real e classificação (a extensão pode mentir)
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

    // 5) capa (melhor esforço) e tags confirmadas no card
    let cover = t
        .artwork_url
        .as_deref()
        .and_then(|u| api.fetch_bytes(&artwork_500(u), COVER_MAX_BYTES).ok())
        .and_then(|b| library_indexer::resize_cover_jpeg(&b, COVER_MAX_SIDE).ok());
    // Depois da capa (outra chamada de rede) cobre o cancelamento durante a
    // conversão e durante a busca da capa.
    if board.is_canceled(&job_id, attempt) {
        let _ = std::fs::remove_file(&flac);
        return canceled();
    }
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
        comment: None,
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
        // Só lossless entra (CEO, 15/10/2026): MP3 de qualquer bitrate fica fora
        let lossy = |f: &str| Err(RejectReason::LossyFormat { format: f.into() });
        assert_eq!(classify_original("mp3", &p("mp3", Some(320), None)), lossy("MP3"));
        assert_eq!(classify_original("mp3", &p("mp3", Some(128), None)), lossy("MP3"));
        // extensão mente: ".wav" que é mp3 por dentro segue a sondagem
        assert_eq!(classify_original("wav", &p("mp3", Some(192), None)), lossy("MP3"));
        assert_eq!(classify_original("m4a", &p("aac", Some(256), None)), lossy("AAC"));
        assert_eq!(classify_original("bin", &p("mjpeg", None, None)), Err(RejectReason::NoDownload));
    }

    /// Modos do `FakeSc`: cada um simula um jeito de a fonte responder.
    #[derive(Default)]
    struct Modo {
        /// `probe_original` devolve `NoToken` (token recusado na sondagem).
        probe_401: bool,
        /// `probe_original` devolve este status HTTP.
        probe_http: Option<u16>,
        /// `download` começa, deixa um `.part` e devolve `Http(401)`.
        download_401: bool,
        /// `download` copia o original e entra em panic.
        download_panic: bool,
        /// Bytes devolvidos por `fetch_bytes` (capa); `None` = 404.
        capa: Option<Vec<u8>>,
        /// `download` copia o original e cancela o job "j1" no board (o
        /// usuário cancelou com o download em curso).
        cancelar_no_download: bool,
        /// `fetch_bytes` cancela o job "j1" (cancelado na conversão ou na capa).
        cancelar_na_capa: bool,
        /// `download` só segue quando outro download estiver em curso ao
        /// mesmo tempo (até 5 s); sozinho falha. Prova downloads simultâneos.
        esperar_par: bool,
    }

    struct FakeSc {
        src: std::path::PathBuf,
        ext: &'static str,
        modo: Modo,
        log: Mutex<Vec<String>>,
        board: Arc<JobBoard>,
        em_download: std::sync::atomic::AtomicU32,
    }
    impl SoundCloudApi for FakeSc {
        fn search(&self, _: &str, _: u32) -> Result<Vec<ScTrack>, ScError> { unimplemented!() }
        fn resolve(&self, _: &str) -> Result<ScTrack, ScError> { unimplemented!() }
        fn probe_original(&self, _: u64, _: &str, _: u64) -> Result<Original, ScError> {
            if self.modo.probe_401 { return Err(ScError::NoToken); }
            if let Some(code) = self.modo.probe_http { return Err(ScError::Http(code)); }
            Ok(Original { url: "fake://orig".into(), ext: self.ext.into(), size: Some(std::fs::metadata(&self.src).unwrap().len()), kbps_est: None })
        }
        fn download(&self, _: &str, dest: &std::path::Path, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<(), ScError> {
            self.log.lock().unwrap().push("download".into());
            if self.modo.download_401 {
                let mut part = dest.as_os_str().to_owned(); part.push(".part");
                std::fs::write(&part, b"metade").unwrap();
                progress(6, Some(10));
                return Err(ScError::Http(401));
            }
            if self.modo.esperar_par {
                use std::sync::atomic::Ordering;
                self.em_download.fetch_add(1, Ordering::SeqCst);
                let fim = Instant::now() + std::time::Duration::from_secs(5);
                while self.em_download.load(Ordering::SeqCst) < 2 {
                    if Instant::now() > fim { return Err(ScError::Transport("nenhum download em paralelo".into())); }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
            }
            std::fs::copy(&self.src, dest).unwrap();
            if self.modo.download_panic { panic!("panic simulado no download"); }
            if self.modo.cancelar_no_download { assert!(self.board.transition("j1", JobState::Canceled)); }
            progress(10, Some(10));
            Ok(())
        }
        fn fetch_bytes(&self, url: &str, _: usize) -> Result<Vec<u8>, ScError> {
            self.log.lock().unwrap().push(format!("fetch {url}"));
            if self.modo.cancelar_na_capa { assert!(self.board.transition("j1", JobState::Canceled)); }
            self.modo.capa.clone().ok_or(ScError::Http(404))
        }
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
        board_com_jobs(&["j1"])
    }

    fn board_com_jobs(ids: &[&str]) -> Arc<JobBoard> {
        let board = JobBoard::new();
        for id in ids {
        board.upsert(DownloadJob {
            job_id: (*id).into(),
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
        }
        Arc::new(board)
    }

    fn setup_modo(ext: &'static str, extra: &[&str], modo: Modo) -> (tempfile::TempDir, Arc<FakeSc>, Arc<SourcesConfig>, Arc<JobBoard>) {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join(format!("orig.{ext}"));
        let st = std::process::Command::new("ffmpeg").args(["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "2"]).args(extra).arg(&src).status().unwrap();
        assert!(st.success());
        let token = tmp.path().join("tok.txt"); std::fs::write(&token, "2-x-y-z").unwrap();
        let mut cfg = SourcesConfig::load_with(tmp.path(), |_| None); cfg.sc_token_file = token;
        let board = board_com_jobs(&["j1", "j2"]);
        let api = FakeSc { src, ext, modo, log: Mutex::new(vec![]), board: board.clone(), em_download: Default::default() };
        (tmp, Arc::new(api), Arc::new(cfg), board)
    }

    fn setup(ext: &'static str, extra: &[&str]) -> (tempfile::TempDir, Arc<FakeSc>, Arc<SourcesConfig>, Arc<JobBoard>) {
        setup_modo(ext, extra, Modo::default())
    }

    /// Tarefa com `incoming_dir` que AINDA NÃO existe: criar a pasta é
    /// responsabilidade do worker (instalação nova não tem `.rustify-incoming`).
    fn task(tmp: &tempfile::TempDir) -> FetchTask {
        let incoming = tmp.path().join(".rustify-incoming");
        FetchTask { job_id: "j1".into(), attempt: 0, source: Source::SoundCloud { track_id: 1, permalink_url: "https://soundcloud.com/a/b".into() },
            meta: ConfirmedMeta { artist: "DJ Arana".into(), title: "Festa".into(), album: "Festa".into(), year: Some(2024), label: None },
            artwork_url: None, playlist: "Funk Brasileiro".into(), incoming_dir: incoming }
    }

    /// Nomes dos arquivos `j1.a0.*` que sobraram no incoming.
    fn sobras(tmp: &tempfile::TempDir) -> Vec<String> {
        let Ok(rd) = std::fs::read_dir(tmp.path().join(".rustify-incoming")) else { return Vec::new() };
        rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("j1.a0.")).collect()
    }

    fn run_one(api: Arc<FakeSc>, cfg: Arc<SourcesConfig>, board: Arc<JobBoard>, t: FetchTask) -> Vec<FetchEvent> {
        let (ftx, frx) = crossbeam_channel::bounded(1); let (etx, erx) = crossbeam_channel::unbounded();
        let h = spawn_sc_worker(frx, etx, api, cfg, board); ftx.send(t).unwrap(); drop(ftx); h.join().unwrap();
        erx.try_iter().collect()
    }

    fn done_de(evs: &[FetchEvent]) -> Option<(std::path::PathBuf, FormatIn)> {
        evs.iter().find_map(|e| if let FetchEvent::Done { flac_path, format_in, .. } = e { Some((flac_path.clone(), *format_in)) } else { None })
    }

    #[test]
    fn wav_vira_flac_com_tags_e_done() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup("wav", &["-c:a", "pcm_s24le"]);
        let evs = run_one(api, cfg, board, task(&tmp));
        let done = done_de(&evs).expect("Done");
        assert_eq!(done.1, FormatIn::Wav24);
        let md = library_indexer::parse_flac(&done.0).unwrap();
        assert_eq!(md.artist.as_deref(), Some("DJ Arana")); assert_eq!(md.genre_raw.as_deref(), Some("Funk Brasileiro"));
        assert!(evs.iter().any(|e| matches!(e, FetchEvent::Progress { .. })));
        assert!(!tmp.path().join(".rustify-incoming/j1.a0.wav").exists(), "original convertido sai do incoming");
    }

    #[test]
    fn incoming_inexistente_e_criado_pelo_worker() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup("wav", &[]);
        let t = task(&tmp);
        assert!(!t.incoming_dir.exists(), "pré-condição: pasta ainda não existe");
        let evs = run_one(api, cfg, board, t);
        assert!(done_de(&evs).is_some(), "{evs:?}");
    }

    #[test]
    fn wav_com_capa_embute_picture_500() {
        if !ffmpeg_ok() { return; }
        let tmp_capa = tempfile::tempdir().unwrap();
        let jpg = tmp_capa.path().join("capa.jpg");
        let st = std::process::Command::new("ffmpeg").args(["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1"]).arg(&jpg).status().unwrap();
        assert!(st.success());
        let modo = Modo { capa: Some(std::fs::read(&jpg).unwrap()), ..Modo::default() };
        let (tmp, api, cfg, board) = setup_modo("wav", &[], modo);
        let mut t = task(&tmp);
        t.artwork_url = Some("https://i1.sndcdn.com/x-large.jpg".into());
        let evs = run_one(api.clone(), cfg, board, t);
        let (path, _) = done_de(&evs).expect("Done");
        let pics = library_indexer::parse_flac(&path).unwrap().pictures;
        assert_eq!(pics.len(), 1, "capa embutida");
        assert_eq!(pics[0].mime, "image/jpeg");
        assert!(api.log.lock().unwrap().iter().any(|l| l == "fetch https://i1.sndcdn.com/x-t500x500.jpg"), "{:?}", api.log.lock().unwrap());
    }

    #[test]
    fn mp3_320_e_recusado_e_sai_do_incoming() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup("mp3", &["-b:a", "320k"]);
        let evs = run_one(api, cfg, board, task(&tmp));
        assert!(
            matches!(evs.last(), Some(FetchEvent::Rejected { reason: RejectReason::LossyFormat { format }, .. }) if format == "MP3"),
            "{evs:?}"
        );
        assert!(!tmp.path().join(".rustify-incoming/j1.a0.mp3").exists(), "original rejeitado sai do incoming");
    }

    #[test]
    fn sondagem_401_falha_sem_retry() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup_modo("wav", &[], Modo { probe_401: true, ..Modo::default() });
        let evs = run_one(api.clone(), cfg, board, task(&tmp));
        assert!(matches!(evs.last(), Some(FetchEvent::Failed { retryable: false, reason, .. }) if reason.contains("token")), "{evs:?}");
        assert!(api.log.lock().unwrap().is_empty(), "não baixou nada");
    }

    /// O download vai para a URL assinada do CDN, SEM token: 401/403 ali é
    /// link expirado ou bloqueio, não token. Uma nova sondagem gera outro
    /// link, então o job pode ser repetido e o texto não culpa o token.
    #[test]
    fn download_401_do_cdn_falha_com_retry_sem_culpar_o_token() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup_modo("wav", &[], Modo { download_401: true, ..Modo::default() });
        let evs = run_one(api.clone(), cfg, board, task(&tmp));
        assert_eq!(api.log.lock().unwrap().as_slice(), ["download"], "o download começou");
        assert!(
            matches!(evs.last(), Some(FetchEvent::Failed { retryable: true, reason, .. }) if reason.contains("link do original") && !reason.contains("token")),
            "{evs:?}"
        );
        assert!(sobras(&tmp).is_empty(), "nada de j1.a0.* no incoming: {:?}", sobras(&tmp));
    }

    #[test]
    fn original_indisponivel_403_404_rejeita_sem_download() {
        if !ffmpeg_ok() { return; }
        for code in [403u16, 404] {
            let (tmp, api, cfg, board) = setup_modo("wav", &[], Modo { probe_http: Some(code), ..Modo::default() });
            let evs = run_one(api.clone(), cfg, board, task(&tmp));
            assert!(matches!(evs.last(), Some(FetchEvent::Rejected { reason: RejectReason::NoDownload, .. })), "{code}: {evs:?}");
            assert!(api.log.lock().unwrap().is_empty(), "{code}: não baixou nada");
        }
    }

    #[test]
    fn sondagem_com_erro_de_rede_nao_repete_o_prefixo() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup_modo("wav", &[], Modo { probe_http: Some(500), ..Modo::default() });
        let evs = run_one(api, cfg, board, task(&tmp));
        match evs.last() {
            Some(FetchEvent::Failed { retryable: true, reason, .. }) => {
                assert_eq!(reason.matches("SoundCloud").count(), 1, "{reason}");
            }
            other => panic!("esperava Failed retentável, veio {other:?}"),
        }
    }

    #[test]
    fn sem_ffmpeg_falha_sem_baixar() {
        let (tmp, api, cfg, board) = (|| {
            let tmp = tempfile::tempdir().unwrap();
            let src = tmp.path().join("orig.wav"); std::fs::write(&src, b"RIFF").unwrap();
            let token = tmp.path().join("tok.txt"); std::fs::write(&token, "2-x-y-z").unwrap();
            let mut cfg = SourcesConfig::load_with(tmp.path(), |_| None);
            cfg.sc_token_file = token;
            cfg.ffmpeg = "/caminho/inexistente/ffmpeg".into();
            let board = board_com_job();
            let api = FakeSc { src, ext: "wav", modo: Modo::default(), log: Mutex::new(vec![]), board: board.clone(), em_download: Default::default() };
            (tmp, Arc::new(api), Arc::new(cfg), board)
        })();
        let evs = run_one(api.clone(), cfg, board, task(&tmp));
        assert!(matches!(evs.last(), Some(FetchEvent::Failed { retryable: false, reason, .. }) if reason == "ffmpeg ausente"), "{evs:?}");
        assert!(api.log.lock().unwrap().is_empty(), "não baixou nada");
    }

    #[test]
    fn panic_no_meio_limpa_o_incoming() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup_modo("wav", &[], Modo { download_panic: true, ..Modo::default() });
        let evs = run_one(api, cfg, board, task(&tmp));
        assert!(matches!(evs.last(), Some(FetchEvent::Failed { retryable: false, .. })), "{evs:?}");
        assert!(sobras(&tmp).is_empty(), "panic não deixa original no incoming: {:?}", sobras(&tmp));
    }

    #[test]
    fn sem_arquivo_de_token_falha_antes_de_baixar() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup("wav", &[]);
        let mut cfg2 = (*cfg).clone(); cfg2.sc_token_file = tmp.path().join("inexistente.txt");
        let evs = run_one(api.clone(), Arc::new(cfg2), board, task(&tmp));
        assert!(matches!(evs.last(), Some(FetchEvent::Failed { retryable: false, reason, .. }) if reason.contains("token")), "{evs:?}");
        assert!(api.log.lock().unwrap().is_empty(), "não baixou nada");
    }

    #[test]
    fn job_cancelado_nao_baixa() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, _) = setup("wav", &[]);
        let evs = run_one(api.clone(), cfg, Arc::new(JobBoard::new()), task(&tmp));
        assert!(matches!(evs.last(), Some(FetchEvent::Failed { retryable: false, reason, .. }) if reason == "cancelado"), "{evs:?}");
        assert!(api.log.lock().unwrap().is_empty(), "job fora do board não baixa");
    }

    fn cancelado_sem_sobras(evs: &[FetchEvent], tmp: &tempfile::TempDir) {
        assert!(matches!(evs.last(), Some(FetchEvent::Failed { retryable: false, reason, .. }) if reason == "cancelado"), "{evs:?}");
        assert!(done_de(evs).is_none(), "{evs:?}");
        assert!(sobras(tmp).is_empty(), "cancelado não deixa original nem FLAC: {:?}", sobras(tmp));
    }

    #[test]
    fn cancelado_durante_o_download_apaga_o_original() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup_modo("wav", &[], Modo { cancelar_no_download: true, ..Modo::default() });
        let evs = run_one(api, cfg, board, task(&tmp));
        cancelado_sem_sobras(&evs, &tmp);
    }

    #[test]
    fn cancelado_depois_da_conversao_apaga_o_flac() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup_modo("wav", &[], Modo { cancelar_na_capa: true, ..Modo::default() });
        let mut t = task(&tmp);
        t.artwork_url = Some("https://i1.sndcdn.com/x-large.jpg".into());
        let evs = run_one(api.clone(), cfg, board, t);
        assert!(api.log.lock().unwrap().iter().any(|l| l.starts_with("fetch ")), "chegou à capa, depois da conversão");
        cancelado_sem_sobras(&evs, &tmp);
    }

    /// Original FLAC: vira o arquivo entregue por rename, sem ffmpeg. Com a
    /// extensão "flac" o original e o entregue são o mesmo caminho; com outra
    /// extensão (a sondagem manda) o original some depois do rename.
    #[test]
    fn original_flac_entra_por_rename_com_tags() {
        if !ffmpeg_ok() { return; }
        for ext in ["flac", "wav"] {
            let (tmp, api, cfg, board) = setup(ext, &["-c:a", "flac", "-f", "flac"]);
            let evs = run_one(api, cfg, board, task(&tmp));
            let (path, fmt) = done_de(&evs).unwrap_or_else(|| panic!("{ext}: {evs:?}"));
            assert_eq!(fmt, FormatIn::Flac, "{ext}");
            assert_eq!(path, tmp.path().join(".rustify-incoming/j1.a0.flac"), "{ext}");
            let md = library_indexer::parse_flac(&path).unwrap();
            assert_eq!(md.artist.as_deref(), Some("DJ Arana"), "{ext}");
            assert_eq!(md.title.as_deref(), Some("Festa"), "{ext}");
            assert_eq!(sobras(&tmp), vec!["j1.a0.flac".to_string()], "{ext}");
        }
    }

    /// O teto do SoundCloud é de 2 downloads simultâneos (spec §2.4): duas
    /// instâncias do worker sobre o MESMO canal baixam em paralelo e cada
    /// tarefa grava só os arquivos da sua tentativa.
    #[test]
    fn duas_instancias_baixam_em_paralelo() {
        if !ffmpeg_ok() { return; }
        let (tmp, api, cfg, board) = setup_modo("wav", &[], Modo { esperar_par: true, ..Modo::default() });
        let (ftx, frx) = crossbeam_channel::bounded(2);
        let (etx, erx) = crossbeam_channel::unbounded();
        let api_dyn: Arc<dyn SoundCloudApi> = api;
        let hs: Vec<_> = (0..2)
            .map(|_| spawn_sc_worker(frx.clone(), etx.clone(), api_dyn.clone(), cfg.clone(), board.clone()))
            .collect();
        let t1 = task(&tmp);
        let mut t2 = task(&tmp);
        t2.job_id = "j2".into();
        ftx.send(t1).unwrap();
        ftx.send(t2).unwrap();
        drop(ftx);
        for h in hs { h.join().unwrap(); }
        drop(etx);
        let evs: Vec<FetchEvent> = erx.try_iter().collect();
        let mut done: Vec<String> = evs
            .iter()
            .filter_map(|e| if let FetchEvent::Done { flac_path, .. } = e { Some(flac_path.file_name().unwrap().to_string_lossy().into_owned()) } else { None })
            .collect();
        done.sort();
        assert_eq!(done, ["j1.a0.flac", "j2.a0.flac"], "{evs:?}");
    }
}
