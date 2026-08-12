//! Busca de letras sincronizadas no lrclib.net para faixas recém-baixadas
//! (Etapa E do Crate — spec 2026-08-07, plano Task E1).
//!
//! Worker em thread própria (`slsk-lyrics`): o coordinator do Crate só faz
//! `send` no canal após o ingest — o pipeline de download nunca espera rede
//! de letra. Best-effort por contrato: miss do lrclib é silêncio, não erro.
//!
//! O sidecar `<faixa>.lrc` ao lado do FLAC é o único artefato — o app o
//! resolve por convenção ([`crate::lyrics::find_lrc_sidecar`]) e o backfill
//! existente ([`crate::IndexerHandle::sync_lyrics_to_qdrant`]) popula
//! `lrc_path`/vetor quando rodar. Nunca sobrescreve sidecar existente.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::Receiver;

/// Pedido de letra para uma faixa recém-ingerida. `artist`/`title` vêm das
/// TAGS reais do FLAC (ParsedFlacMetadata) — não do nome de arquivo do peer.
#[derive(Debug, Clone)]
pub struct LyricsJob {
    pub track_id: u64,
    pub flac_path: PathBuf,
    pub artist: String,
    pub title: String,
    pub album: Option<String>,
    pub duration_secs: Option<u32>,
}

/// Resultado de uma consulta à fonte de letras. `synced` vira sidecar `.lrc`
/// (a view de letra do app depende dos timestamps); `plain` NÃO vira sidecar,
/// mas serve de input pro vetor `lyrics` — o embedding roda sobre o texto
/// limpo, onde os timestamps são descartados de qualquer forma.
///
/// A distinção importa: na sonda de 2026-08-12 sobre o acervo, das faixas com
/// letra no lrclib só ~40% tinham versão sincronizada. Descartar o resto
/// custava ~87 vetores de letra.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FetchedLyrics {
    pub synced: Option<String>,
    pub plain: Option<String>,
}

impl FetchedLyrics {
    /// Texto para embedding: prefere o sincronizado (mesma letra, com marcas
    /// que a limpeza remove), cai pro plain.
    pub fn text_for_embedding(&self) -> Option<&str> {
        self.synced.as_deref().or(self.plain.as_deref())
    }

    pub fn is_empty(&self) -> bool {
        self.synced.is_none() && self.plain.is_none()
    }
}

/// Fonte de letras. Trait para o worker ser testável sem rede.
pub trait LyricsSource: Send + Sync {
    /// `Ok(FetchedLyrics)` — pode vir vazio (miss definitivo, sem retry);
    /// `Err` = falha transitória (rede/5xx — vale 1 retry).
    fn fetch(&self, job: &LyricsJob) -> Result<FetchedLyrics, String>;
}

/// Destino do resultado: grava o texto da letra no ponto do Qdrant (payload +
/// vetor `lyrics`). Sem isto, a letra baixada só virava vetor no PRÓXIMO boot
/// do app (quando o backfill do coordinator roda) — a track ficava semanas
/// invisível pra busca semântica.
pub trait LyricsSink: Send + Sync {
    /// `lrc_path` é `Some` quando um sidecar sincronizado foi gravado agora
    /// (ou já existia); `text` é a letra crua a embeddar.
    fn persist(&self, track_id: u64, lrc_path: Option<&Path>, text: &str) -> Result<(), String>;
}

/// Percent-encoding RFC 3986 (unreserved intactos) para query strings.
fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Monta a URL do endpoint `GET /api/get` do lrclib.
pub fn lrclib_get_url(base: &str, job: &LyricsJob) -> String {
    let mut url = format!(
        "{}/api/get?artist_name={}&track_name={}",
        base.trim_end_matches('/'),
        urlenc(&job.artist),
        urlenc(&job.title),
    );
    if let Some(album) = &job.album {
        url.push_str("&album_name=");
        url.push_str(&urlenc(album));
    }
    if let Some(d) = job.duration_secs {
        url.push_str(&format!("&duration={d}"));
    }
    url
}

/// Extrai `syncedLyrics` de uma resposta JSON do lrclib. `None` para corpo
/// sem o campo, campo nulo, ou string vazia/whitespace.
pub fn parse_lrclib_response(body: &str) -> Option<String> {
    parse_lrclib_lyrics(body).synced
}

/// Extrai `syncedLyrics` E `plainLyrics` de uma resposta do lrclib. Campos
/// nulos, ausentes ou só-whitespace viram `None`. Faixa marcada como
/// `instrumental: true` volta vazia (é um miss legítimo, não um erro).
pub fn parse_lrclib_lyrics(body: &str) -> FetchedLyrics {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return FetchedLyrics::default();
    };
    if v.get("instrumental").and_then(|i| i.as_bool()) == Some(true) {
        return FetchedLyrics::default();
    }
    let pick = |key: &str| {
        v.get(key)
            .and_then(|s| s.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
    };
    FetchedLyrics {
        synced: pick("syncedLyrics"),
        plain: pick("plainLyrics"),
    }
}

/// Caminho do sidecar `.lrc` correspondente ao FLAC (mesmo stem, mesmo dir).
pub fn sidecar_path(flac_path: &Path) -> Option<PathBuf> {
    let stem = flac_path.file_stem()?;
    Some(
        flac_path
            .parent()?
            .join(format!("{}.lrc", stem.to_string_lossy())),
    )
}

/// Grava o sidecar se ainda não existir. `Ok(true)` = gravou; `Ok(false)` =
/// já existia (intocado — sidecars presentes têm precedência, podem ter
/// vindo de fonte melhor como o pipeline wav2vec2).
pub fn write_sidecar_if_absent(flac_path: &Path, synced: &str) -> std::io::Result<bool> {
    let Some(lrc) = sidecar_path(flac_path) else {
        return Ok(false);
    };
    if lrc.exists() {
        return Ok(false);
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lrc)?;
    f.write_all(synced.as_bytes())?;
    Ok(true)
}

/// Cliente lrclib real (ureq). `base_url` injetável para testes.
pub struct Lrclib {
    pub base_url: String,
    pub user_agent: String,
}

impl Lrclib {
    pub fn new(user_agent: String) -> Self {
        Self {
            base_url: "https://lrclib.net".to_string(),
            user_agent,
        }
    }
}

impl LyricsSource for Lrclib {
    fn fetch(&self, job: &LyricsJob) -> Result<FetchedLyrics, String> {
        let url = lrclib_get_url(&self.base_url, job);
        let resp = ureq::get(&url)
            .set("User-Agent", &self.user_agent)
            .timeout(Duration::from_secs(10))
            .call();
        match resp {
            Ok(r) => {
                let body = r
                    .into_string()
                    .map_err(|e| format!("lrclib body: {e}"))?;
                Ok(parse_lrclib_lyrics(&body))
            }
            // 404 = a fonte não tem a faixa: miss definitivo, não erro.
            Err(ureq::Error::Status(404, _)) => Ok(FetchedLyrics::default()),
            Err(e) => Err(format!("lrclib: {e}")),
        }
    }
}

/// Pausa mínima entre requisições — cortesia com um serviço gratuito.
const REQUEST_GAP: Duration = Duration::from_millis(500);
/// Backoff único antes do retry de falha transitória.
const RETRY_BACKOFF: Duration = Duration::from_secs(2);

/// Sobe a thread `slsk-lyrics`. Consome jobs até o canal fechar (todos os
/// senders dropados). Nunca panica por job ruim; todo desfecho é `debug!`.
pub fn spawn_lyrics_worker(
    rx: Receiver<LyricsJob>,
    source: Arc<dyn LyricsSource>,
    sink: Option<Arc<dyn LyricsSink>>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("slsk-lyrics".into())
        .spawn(move || {
            for job in rx.iter() {
                process_job(&job, source.as_ref(), sink.as_deref());
                std::thread::sleep(REQUEST_GAP);
            }
        })
        .expect("spawn slsk-lyrics")
}

fn process_job(job: &LyricsJob, source: &dyn LyricsSource, sink: Option<&dyn LyricsSink>) {
    if job.artist.trim().is_empty() || job.title.trim().is_empty() {
        tracing::debug!(track_id = job.track_id, "lyrics: sem artist/title — pulando");
        return;
    }
    // Sidecar já no disco (re-download, ou pipeline wav2vec2 externo): não
    // bate na rede, mas ainda fecha o ciclo — o vetor pode faltar.
    if let Some(lrc) = sidecar_path(&job.flac_path) {
        if lrc.exists() {
            tracing::debug!(track_id = job.track_id, "lyrics: sidecar já existe — só persistindo");
            if let Ok(text) = std::fs::read_to_string(&lrc) {
                persist(job, sink, Some(&lrc), &text);
            }
            return;
        }
    }
    let fetched = match source.fetch(job) {
        Ok(v) => v,
        Err(first_err) => {
            std::thread::sleep(RETRY_BACKOFF);
            match source.fetch(job) {
                Ok(v) => v,
                Err(second_err) => {
                    tracing::warn!(
                        track_id = job.track_id,
                        %first_err,
                        %second_err,
                        "lyrics: fetch falhou 2x — desistindo"
                    );
                    return;
                }
            }
        }
    };

    if fetched.is_empty() {
        tracing::debug!(track_id = job.track_id, "lyrics: lrclib não tem — miss");
        return;
    }

    // Só letra SINCRONIZADA vira sidecar: a view de letra do app depende dos
    // timestamps, e um .lrc sem eles seria um contrato quebrado. O plain
    // segue direto pro vetor, sem tocar no disco.
    let mut written: Option<PathBuf> = None;
    if let Some(synced) = fetched.synced.as_deref() {
        match write_sidecar_if_absent(&job.flac_path, synced) {
            Ok(true) => {
                written = sidecar_path(&job.flac_path);
                tracing::debug!(track_id = job.track_id, "lyrics: sidecar gravado");
            }
            Ok(false) => {
                written = sidecar_path(&job.flac_path);
                tracing::debug!(track_id = job.track_id, "lyrics: sidecar apareceu no meio — intocado");
            }
            Err(e) => tracing::warn!(track_id = job.track_id, %e, "lyrics: falha ao gravar sidecar"),
        }
    }

    if let Some(text) = fetched.text_for_embedding() {
        persist(job, sink, written.as_deref(), text);
    }
}

/// Entrega ao sink, se houver. Falha aqui nunca derruba o worker: o backfill
/// do próximo boot reprocessa (é idempotente).
fn persist(job: &LyricsJob, sink: Option<&dyn LyricsSink>, lrc_path: Option<&Path>, text: &str) {
    let Some(sink) = sink else { return };
    match sink.persist(job.track_id, lrc_path, text) {
        Ok(()) => tracing::info!(track_id = job.track_id, "lyrics: payload + vetor gravados"),
        Err(e) => tracing::warn!(track_id = job.track_id, %e, "lyrics: persist falhou"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossbeam_channel::unbounded;
    use std::sync::Mutex;

    fn job(dir: &Path, artist: &str, title: &str) -> LyricsJob {
        LyricsJob {
            track_id: 1,
            flac_path: dir.join("01 - Faixa.flac"),
            artist: artist.into(),
            title: title.into(),
            album: Some("Álbum & Tal".into()),
            duration_secs: Some(215),
        }
    }

    #[test]
    fn url_escapa_reservados_e_inclui_album_e_duracao() {
        let d = tempfile::tempdir().unwrap();
        let j = job(d.path(), "Tyler, The Creator", "What? / Why & How");
        let url = lrclib_get_url("https://lrclib.net/", &j);
        assert!(url.starts_with("https://lrclib.net/api/get?artist_name="));
        assert!(url.contains("Tyler%2C%20The%20Creator"), "{url}");
        assert!(url.contains("What%3F%20%2F%20Why%20%26%20How"), "{url}");
        assert!(url.contains("&album_name=%C3%81lbum%20%26%20Tal"), "{url}");
        assert!(url.ends_with("&duration=215"), "{url}");
    }

    #[test]
    fn url_omite_album_e_duracao_ausentes() {
        let d = tempfile::tempdir().unwrap();
        let mut j = job(d.path(), "A", "B");
        j.album = None;
        j.duration_secs = None;
        let url = lrclib_get_url("https://lrclib.net", &j);
        assert!(!url.contains("album_name"));
        assert!(!url.contains("duration"));
    }

    #[test]
    fn parse_extrai_synced_e_rejeita_null_vazio_e_lixo() {
        let ok = r#"{"id":1,"syncedLyrics":"[00:01.00] linha","plainLyrics":"linha"}"#;
        assert_eq!(parse_lrclib_response(ok).as_deref(), Some("[00:01.00] linha"));
        let nulo = r#"{"id":1,"syncedLyrics":null,"plainLyrics":"so plain"}"#;
        assert_eq!(parse_lrclib_response(nulo), None);
        let vazio = r#"{"syncedLyrics":"   "}"#;
        assert_eq!(parse_lrclib_response(vazio), None);
        assert_eq!(parse_lrclib_response("not json"), None);
        assert_eq!(parse_lrclib_response("{}"), None);
    }

    #[test]
    fn sidecar_path_troca_extensao_preservando_stem() {
        let p = Path::new("/x/Album/03 - Faixa.Com.Pontos.flac");
        assert_eq!(
            sidecar_path(p).unwrap(),
            Path::new("/x/Album/03 - Faixa.Com.Pontos.lrc")
        );
    }

    #[test]
    fn write_sidecar_nunca_sobrescreve_existente() {
        let d = tempfile::tempdir().unwrap();
        let flac = d.path().join("f.flac");
        std::fs::write(&flac, b"x").unwrap();
        let lrc = d.path().join("f.lrc");
        std::fs::write(&lrc, "original").unwrap();
        let wrote = write_sidecar_if_absent(&flac, "[00:01.00] novo").unwrap();
        assert!(!wrote);
        assert_eq!(std::fs::read_to_string(&lrc).unwrap(), "original");
    }

    #[test]
    fn write_sidecar_grava_quando_ausente() {
        let d = tempfile::tempdir().unwrap();
        let flac = d.path().join("f.flac");
        std::fs::write(&flac, b"x").unwrap();
        assert!(write_sidecar_if_absent(&flac, "[00:01.00] linha").unwrap());
        assert_eq!(
            std::fs::read_to_string(d.path().join("f.lrc")).unwrap(),
            "[00:01.00] linha"
        );
    }

    /// Fonte fake roteirizável: sequência de respostas por chamada.
    struct FakeSource {
        script: Mutex<Vec<Result<FetchedLyrics, String>>>,
        calls: Mutex<Vec<String>>,
    }
    impl FakeSource {
        fn new(script: Vec<Result<FetchedLyrics, String>>) -> Self {
            Self { script: Mutex::new(script), calls: Mutex::new(Vec::new()) }
        }
    }
    impl LyricsSource for FakeSource {
        fn fetch(&self, j: &LyricsJob) -> Result<FetchedLyrics, String> {
            self.calls.lock().unwrap().push(j.title.clone());
            let mut s = self.script.lock().unwrap();
            if s.is_empty() { Ok(FetchedLyrics::default()) } else { s.remove(0) }
        }
    }

    fn synced(s: &str) -> Result<FetchedLyrics, String> {
        Ok(FetchedLyrics { synced: Some(s.into()), plain: None })
    }
    fn plain(s: &str) -> Result<FetchedLyrics, String> {
        Ok(FetchedLyrics { synced: None, plain: Some(s.into()) })
    }

    /// Sink fake: registra (track_id, lrc_path, texto) de cada persist.
    #[derive(Default)]
    struct FakeSink {
        seen: Mutex<Vec<(u64, Option<PathBuf>, String)>>,
    }
    impl LyricsSink for FakeSink {
        fn persist(&self, id: u64, lrc: Option<&Path>, text: &str) -> Result<(), String> {
            self.seen
                .lock()
                .unwrap()
                .push((id, lrc.map(Path::to_path_buf), text.to_string()));
            Ok(())
        }
    }

    /// Texto longo o bastante para valer embedding (o guard de tamanho real
    /// mora no sink de produção, mas os testes usam letras plausíveis).
    const LETRA: &str = "primeira linha da letra\nsegunda linha da letra\nterceira";

    #[test]
    fn worker_grava_sidecar_no_hit_e_encerra_com_canal_fechado() {
        let d = tempfile::tempdir().unwrap();
        let flac = d.path().join("hit.flac");
        std::fs::write(&flac, b"x").unwrap();
        let src = Arc::new(FakeSource::new(vec![synced("[00:05.00] oi")]));
        let (tx, rx) = unbounded();
        let h = spawn_lyrics_worker(rx, src.clone(), None);
        tx.send(LyricsJob { flac_path: flac.clone(), ..job(d.path(), "A", "B") }).unwrap();
        drop(tx);
        h.join().unwrap();
        assert_eq!(
            std::fs::read_to_string(d.path().join("hit.lrc")).unwrap(),
            "[00:05.00] oi"
        );
    }

    #[test]
    fn worker_nao_chama_fonte_com_sidecar_existente_mas_persiste_o_texto() {
        // O sidecar pode ter vindo de fonte melhor (wav2vec2) ou de um
        // download anterior; o que pode faltar é o VETOR.
        let d = tempfile::tempdir().unwrap();
        let flac = d.path().join("f.flac");
        std::fs::write(&flac, b"x").unwrap();
        std::fs::write(d.path().join("f.lrc"), "existente").unwrap();
        let src = Arc::new(FakeSource::new(vec![]));
        let sink = Arc::new(FakeSink::default());
        let (tx, rx) = unbounded();
        let h = spawn_lyrics_worker(rx, src.clone(), Some(sink.clone()));
        tx.send(LyricsJob { flac_path: flac, ..job(d.path(), "A", "B") }).unwrap();
        drop(tx);
        h.join().unwrap();
        assert!(src.calls.lock().unwrap().is_empty(), "fonte não deveria ser chamada");
        assert_eq!(std::fs::read_to_string(d.path().join("f.lrc")).unwrap(), "existente");
        let seen = sink.seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "sidecar existente ainda deve fechar o ciclo");
        assert_eq!(seen[0].2, "existente");
    }

    #[test]
    fn worker_retenta_uma_vez_em_erro_transitorio_e_grava() {
        let d = tempfile::tempdir().unwrap();
        let flac = d.path().join("retry.flac");
        std::fs::write(&flac, b"x").unwrap();
        let src = Arc::new(FakeSource::new(vec![
            Err("timeout".into()),
            synced("[00:09.00] veio"),
        ]));
        let (tx, rx) = unbounded();
        let h = spawn_lyrics_worker(rx, src.clone(), None);
        tx.send(LyricsJob { flac_path: flac, ..job(d.path(), "A", "B") }).unwrap();
        drop(tx);
        h.join().unwrap();
        assert_eq!(src.calls.lock().unwrap().len(), 2);
        assert!(d.path().join("retry.lrc").is_file());
    }

    #[test]
    fn worker_desiste_apos_segundo_erro_sem_sidecar() {
        let d = tempfile::tempdir().unwrap();
        let flac = d.path().join("fail.flac");
        std::fs::write(&flac, b"x").unwrap();
        let src = Arc::new(FakeSource::new(vec![
            Err("e1".into()),
            Err("e2".into()),
        ]));
        let sink = Arc::new(FakeSink::default());
        let (tx, rx) = unbounded();
        let h = spawn_lyrics_worker(rx, src.clone(), Some(sink.clone()));
        tx.send(LyricsJob { flac_path: flac, ..job(d.path(), "A", "B") }).unwrap();
        drop(tx);
        h.join().unwrap();
        assert_eq!(src.calls.lock().unwrap().len(), 2);
        assert!(!d.path().join("fail.lrc").exists());
        assert!(sink.seen.lock().unwrap().is_empty());
    }

    #[test]
    fn worker_pula_job_sem_artist_ou_title() {
        let d = tempfile::tempdir().unwrap();
        let flac = d.path().join("na.flac");
        std::fs::write(&flac, b"x").unwrap();
        let src = Arc::new(FakeSource::new(vec![]));
        let (tx, rx) = unbounded();
        let h = spawn_lyrics_worker(rx, src.clone(), None);
        tx.send(LyricsJob { artist: "  ".into(), flac_path: flac, ..job(d.path(), "A", "B") }).unwrap();
        drop(tx);
        h.join().unwrap();
        assert!(src.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn worker_persiste_letra_sincronizada_com_caminho_do_sidecar() {
        let d = tempfile::tempdir().unwrap();
        let flac = d.path().join("s.flac");
        std::fs::write(&flac, b"x").unwrap();
        let src = Arc::new(FakeSource::new(vec![synced(LETRA)]));
        let sink = Arc::new(FakeSink::default());
        let (tx, rx) = unbounded();
        let h = spawn_lyrics_worker(rx, src.clone(), Some(sink.clone()));
        tx.send(LyricsJob { track_id: 42, flac_path: flac, ..job(d.path(), "A", "B") }).unwrap();
        drop(tx);
        h.join().unwrap();
        let seen = sink.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, 42);
        assert_eq!(seen[0].1.as_deref(), Some(d.path().join("s.lrc").as_path()));
        assert_eq!(seen[0].2, LETRA);
    }

    #[test]
    fn worker_embeda_letra_nao_sincronizada_sem_criar_sidecar() {
        // ~60% das letras do lrclib só existem em plain; descartá-las custava
        // o vetor da faixa. Mas .lrc sem timestamp quebraria a view de letra.
        let d = tempfile::tempdir().unwrap();
        let flac = d.path().join("p.flac");
        std::fs::write(&flac, b"x").unwrap();
        let src = Arc::new(FakeSource::new(vec![plain(LETRA)]));
        let sink = Arc::new(FakeSink::default());
        let (tx, rx) = unbounded();
        let h = spawn_lyrics_worker(rx, src.clone(), Some(sink.clone()));
        tx.send(LyricsJob { track_id: 7, flac_path: flac, ..job(d.path(), "A", "B") }).unwrap();
        drop(tx);
        h.join().unwrap();
        assert!(!d.path().join("p.lrc").exists(), "plain não vira sidecar");
        let seen = sink.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].0, 7);
        assert_eq!(seen[0].1, None, "sem sidecar, sem lrc_path");
        assert_eq!(seen[0].2, LETRA);
    }

    #[test]
    fn worker_nao_persiste_nada_em_miss_da_fonte() {
        let d = tempfile::tempdir().unwrap();
        let flac = d.path().join("m.flac");
        std::fs::write(&flac, b"x").unwrap();
        let src = Arc::new(FakeSource::new(vec![Ok(FetchedLyrics::default())]));
        let sink = Arc::new(FakeSink::default());
        let (tx, rx) = unbounded();
        let h = spawn_lyrics_worker(rx, src.clone(), Some(sink.clone()));
        tx.send(LyricsJob { flac_path: flac, ..job(d.path(), "A", "B") }).unwrap();
        drop(tx);
        h.join().unwrap();
        assert!(sink.seen.lock().unwrap().is_empty());
        assert!(!d.path().join("m.lrc").exists());
    }

    #[test]
    fn parse_separa_synced_de_plain_e_trata_instrumental() {
        let ambos = r#"{"syncedLyrics":"[00:01.00] a","plainLyrics":"a"}"#;
        assert_eq!(
            parse_lrclib_lyrics(ambos),
            FetchedLyrics { synced: Some("[00:01.00] a".into()), plain: Some("a".into()) }
        );
        let so_plain = r#"{"syncedLyrics":null,"plainLyrics":"so plain"}"#;
        let r = parse_lrclib_lyrics(so_plain);
        assert_eq!(r.synced, None);
        assert_eq!(r.text_for_embedding(), Some("so plain"));
        // instrumental: lrclib devolve o registro com flag — não é letra.
        let inst = r#"{"instrumental":true,"plainLyrics":""}"#;
        assert!(parse_lrclib_lyrics(inst).is_empty());
        assert!(parse_lrclib_lyrics("not json").is_empty());
    }
}
