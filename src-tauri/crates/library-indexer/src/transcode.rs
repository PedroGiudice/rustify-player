//! Sondagem de mídia (`ffprobe`) e conversão para FLAC (`ffmpeg`).
//!
//! Usado pelas fontes que não entregam FLAC (SoundCloud: WAV/AIFF/MP3 do
//! produtor). O `ffmpeg` pode sair com código 0 e escrever lixo, então a
//! saída é sempre validada por `parse_flac` e pela duração.
//!
//! Os binários vêm de [`Tools`] (caminho configurável, `tools.ffmpeg` /
//! `RUSTIFY_FFMPEG`) e toda execução tem teto de tempo: processo travado é
//! morto e volta como [`TranscodeError::Timeout`], que o chamador trata como
//! falha retentável.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct MediaProbe {
    pub codec: String,
    pub duration_s: f64,
    /// Bitrate do stream de áudio (cai no do container só se o stream não informar:
    /// o do container inclui ID3 e capa embutida e infla MP3 de 128k para 300+).
    pub bit_rate_kbps: Option<u32>,
    pub bits_per_sample: Option<u16>,
}

/// Binários externos e tetos de tempo.
#[derive(Debug, Clone)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    /// Teto do `ffprobe` e do `-version`.
    pub probe_timeout: Duration,
    /// Piso do teto da conversão; soma-se 1 s por segundo de áudio sondado.
    pub transcode_floor: Duration,
}

impl Tools {
    /// `ffprobe` é derivado do diretório do `ffmpeg` configurado; nome nu
    /// (sem `/`) continua resolvido pelo PATH.
    pub fn from_ffmpeg(ffmpeg: impl Into<PathBuf>) -> Self {
        let ffmpeg: PathBuf = ffmpeg.into();
        let ffprobe = match ffmpeg.parent() {
            Some(dir) if !dir.as_os_str().is_empty() => dir.join("ffprobe"),
            _ => PathBuf::from("ffprobe"),
        };
        Tools { ffmpeg, ffprobe, probe_timeout: Duration::from_secs(30), transcode_floor: Duration::from_secs(60) }
    }
}

impl Default for Tools {
    fn default() -> Self { Tools::from_ffmpeg("ffmpeg") }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscodeError {
    /// Processo externo estourou o teto e foi morto (retentável).
    Timeout(String),
    /// Falha determinística: binário ausente, entrada não é áudio, saída inválida.
    Falhou(String),
}

impl TranscodeError {
    pub fn retryable(&self) -> bool { matches!(self, TranscodeError::Timeout(_)) }
}

impl std::fmt::Display for TranscodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranscodeError::Timeout(m) => write!(f, "tempo esgotado: {m}"),
            TranscodeError::Falhou(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for TranscodeError {}

struct Saida { ok: bool, stdout: Vec<u8>, stderr: Vec<u8> }

fn drain<R: Read + Send + 'static>(r: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = r { let _ = r.read_to_end(&mut buf); }
        buf
    })
}

/// Executa com teto de tempo. Ao estourar: `kill` + `wait` e `Timeout`.
/// As threads leitoras não são aguardadas no timeout (um neto que herdou o
/// pipe poderia segurá-las).
fn run_limited(mut cmd: Command, nome: &str, teto: Duration) -> Result<Saida, TranscodeError> {
    let mut child: Child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| TranscodeError::Falhou(format!("{nome} não executou: {e}")))?;
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let prazo = Instant::now() + teto;
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                let stdout = out.join().unwrap_or_default();
                let stderr = err.join().unwrap_or_default();
                return Ok(Saida { ok: st.success(), stdout, stderr });
            }
            Ok(None) if Instant::now() >= prazo => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(TranscodeError::Timeout(format!("{nome} passou de {}s e foi encerrado", teto.as_secs())));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(TranscodeError::Falhou(format!("{nome}: {e}")));
            }
        }
    }
}

fn stderr_tail(b: &[u8]) -> String {
    let s = String::from_utf8_lossy(b);
    let s = s.trim();
    let n = s.chars().count();
    if n > 300 { s.chars().skip(n - 300).collect() } else { s.to_string() }
}

/// `ffmpeg` e `ffprobe` executáveis.
pub fn ffmpeg_available(tools: &Tools) -> bool {
    let ok = |bin: &Path| {
        let mut c = Command::new(bin);
        c.arg("-version");
        run_limited(c, "ffmpeg", tools.probe_timeout).map(|s| s.ok).unwrap_or(false)
    };
    ok(&tools.ffmpeg) && ok(&tools.ffprobe)
}

/// `ffprobe -of json`: codec, profundidade e bitrate do primeiro stream de áudio;
/// duração do container.
pub fn probe_media(tools: &Tools, path: &Path) -> Result<MediaProbe, TranscodeError> {
    let mut c = Command::new(&tools.ffprobe);
    c.args([
        "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=codec_name,bit_rate,bits_per_sample,bits_per_raw_sample:format=duration,bit_rate",
        "-of", "json",
    ])
    .arg(path);
    let out = run_limited(c, "ffprobe", tools.probe_timeout)?;
    if !out.ok {
        return Err(TranscodeError::Falhou(format!(
            "ffprobe falhou: arquivo não é áudio reconhecido ({})",
            stderr_tail(&out.stderr)
        )));
    }
    parse_probe_json(&out.stdout)
}

fn parse_probe_json(stdout: &[u8]) -> Result<MediaProbe, TranscodeError> {
    let v: serde_json::Value = serde_json::from_slice(stdout)
        .map_err(|e| TranscodeError::Falhou(format!("ffprobe json: {e}")))?;
    let s = v["streams"].get(0).ok_or_else(|| TranscodeError::Falhou("ffprobe: sem stream de áudio".into()))?;
    let num = |x: &serde_json::Value| -> Option<u64> {
        x.as_str().and_then(|t| t.parse::<u64>().ok()).or_else(|| x.as_u64())
    };
    let codec = s["codec_name"].as_str().unwrap_or("").to_string();
    let bits = ["bits_per_raw_sample", "bits_per_sample"]
        .iter()
        .filter_map(|k| num(&s[*k]).map(|x| x as u16))
        .find(|b| *b > 0);
    let bits = bits.or_else(|| match codec.as_str() {
        "pcm_s24le" | "pcm_s24be" => Some(24),
        "pcm_s16le" | "pcm_s16be" => Some(16),
        "pcm_s32le" => Some(32),
        _ => None,
    });
    let duration_s = v["format"]["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0);
    let bit_rate_kbps = num(&s["bit_rate"])
        .filter(|b| *b > 0)
        .or_else(|| num(&v["format"]["bit_rate"]))
        .map(|b| (b / 1000) as u32);
    Ok(MediaProbe { codec, duration_s, bit_rate_kbps, bits_per_sample: bits })
}

/// Codec com perda: tudo que não é PCM nem lossless conhecido.
fn is_lossy_codec(codec: &str) -> bool {
    !(codec.starts_with("pcm_") || matches!(codec, "flac" | "alac" | "wavpack" | "ape" | "tta" | "mlp" | "truehd"))
}

/// WAV/AIFF/MP3 -> FLAC. Metadados e capa da origem descartados (serão reescritos).
/// Origem lossy sai em 16 bit (com dither); PCM mantém a profundidade.
/// Valida a saída: `parse_flac` + duração dentro de 2% (o ffmpeg pode sair 0 e escrever lixo).
/// Em qualquer falha nem `dst` nem o temporário `.flac.part` ficam no disco.
pub fn to_flac(tools: &Tools, src: &Path, dst: &Path) -> Result<(), TranscodeError> {
    let probe = probe_media(tools, src).map_err(|e| match e {
        TranscodeError::Falhou(m) => TranscodeError::Falhou(format!("ffmpeg: origem inválida ({m})")),
        t => t,
    })?;
    let tmp = dst.with_extension("flac.part");
    let falha = |e: TranscodeError| {
        let _ = std::fs::remove_file(&tmp);
        e
    };
    let mut c = Command::new(&tools.ffmpeg);
    c.args(["-nostdin", "-loglevel", "error", "-y", "-i"])
        .arg(src)
        .args(["-vn", "-map_metadata", "-1"]);
    if is_lossy_codec(&probe.codec) {
        // O decodificador de MP3/AAC entrega float e o encoder FLAC escolheria
        // 32 bit (gravado como 24): o arquivo pareceria hi-res sem ser.
        c.args(["-af", "aresample=out_sample_fmt=s16:dither_method=triangular"]);
    }
    c.args(["-c:a", "flac", "-compression_level", "8", "-f", "flac"]).arg(&tmp);
    let teto = tools.transcode_floor + Duration::from_secs_f64(probe.duration_s.max(0.0));
    let out = run_limited(c, "ffmpeg", teto).map_err(falha)?;
    if !out.ok {
        return Err(falha(TranscodeError::Falhou(format!("ffmpeg falhou na conversão ({})", stderr_tail(&out.stderr)))));
    }
    let md = crate::parse_flac(&tmp)
        .map_err(|e| falha(TranscodeError::Falhou(format!("ffmpeg produziu FLAC inválido: {e}"))))?;
    let got = md.duration_ms as f64 / 1000.0;
    if probe.duration_s > 0.0 && (got - probe.duration_s).abs() > probe.duration_s * 0.02 + 0.2 {
        return Err(falha(TranscodeError::Falhou(format!(
            "ffmpeg: duração divergente ({got:.1}s vs {:.1}s)",
            probe.duration_s
        ))));
    }
    std::fs::rename(&tmp, dst).map_err(|e| falha(TranscodeError::Falhou(format!("rename: {e}"))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    fn have_ffmpeg() -> bool { ffmpeg_available(&Tools::default()) }

    fn synth(dir: &Path, name: &str, dur: u32, extra: &[&str]) -> PathBuf {
        let out = dir.join(name);
        let st = Command::new("ffmpeg")
            .args(["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("sine=frequency=440:duration={dur}"))
            .args(["-ac", "2"])
            .args(extra)
            .arg(&out)
            .status()
            .unwrap();
        assert!(st.success());
        out
    }

    /// ffmpeg falso: script com o corpo dado; `$last` é o arquivo de saída.
    fn fake_ffmpeg(dir: &Path, corpo: &str) -> Tools {
        let p = dir.join("ffmpeg-falso");
        std::fs::write(&p, format!("#!/bin/sh\nfor a; do last=$a; done\n{corpo}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        Tools { ffmpeg: p, ..Tools::default() }
    }

    #[test]
    fn tools_deriva_ffprobe_do_diretorio_do_ffmpeg() {
        let t = Tools::from_ffmpeg("/opt/ff/bin/ffmpeg");
        assert_eq!(t.ffprobe, PathBuf::from("/opt/ff/bin/ffprobe"));
        assert_eq!(Tools::from_ffmpeg("ffmpeg").ffprobe, PathBuf::from("ffprobe"));
    }

    #[test]
    fn ffmpeg_fora_do_caminho_configurado_nao_esta_disponivel() {
        let t = Tools::from_ffmpeg("/nao/existe/ffmpeg");
        assert!(!ffmpeg_available(&t));
        let tmp = tempfile::tempdir().unwrap();
        let err = probe_media(&t, &tmp.path().join("x.wav")).unwrap_err();
        assert!(err.to_string().contains("não executou"), "{err}");
    }

    #[test]
    fn probe_media_mp3_128_vs_320_e_wav24() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let t = Tools::default();
        let tmp = tempfile::tempdir().unwrap();
        let m320 = synth(tmp.path(), "a320.mp3", 2, &["-b:a", "320k"]);
        let m128 = synth(tmp.path(), "a128.mp3", 2, &["-b:a", "128k"]);
        let w24 = synth(tmp.path(), "a24.wav", 2, &["-c:a", "pcm_s24le"]);
        let p = probe_media(&t, &m320).unwrap();
        assert_eq!(p.codec, "mp3"); assert!(p.bit_rate_kbps.unwrap() >= 300, "{p:?}");
        let p = probe_media(&t, &m128).unwrap();
        assert!(p.bit_rate_kbps.unwrap() < 200, "{p:?}");
        let p = probe_media(&t, &w24).unwrap();
        assert_eq!(p.codec, "pcm_s24le"); assert_eq!(p.bits_per_sample, Some(24)); assert!((p.duration_s - 2.0).abs() < 0.1);
    }

    #[test]
    fn probe_media_mp3_128_com_capa_grande_nao_passa_por_320() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let t = Tools::default();
        let tmp = tempfile::tempdir().unwrap();
        // capa de ruído (não comprime): centenas de KB contra ~32 KB de áudio
        let capa = tmp.path().join("capa.jpg");
        let st = Command::new("ffmpeg")
            .args(["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=1500x1500,geq=random(1)*255:128:128", "-frames:v", "1", "-q:v", "2"])
            .arg(&capa).status().unwrap();
        assert!(st.success());
        let audio = synth(tmp.path(), "a.mp3", 2, &["-b:a", "128k"]);
        let com_capa = tmp.path().join("a-capa.mp3");
        let st = Command::new("ffmpeg")
            .args(["-nostdin", "-loglevel", "error", "-y", "-i"]).arg(&audio).arg("-i").arg(&capa)
            .args(["-map", "0:a", "-map", "1:v", "-c", "copy", "-disposition:v", "attached_pic"])
            .arg(&com_capa).status().unwrap();
        assert!(st.success());
        assert!(std::fs::metadata(&com_capa).unwrap().len() > 200_000, "fixture precisa de capa grande");
        let p = probe_media(&t, &com_capa).unwrap();
        assert!(p.bit_rate_kbps.unwrap() < 200, "bitrate do container (com capa) vazou: {p:?}");
    }

    #[test]
    fn to_flac_converte_wav_e_preserva_duracao() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let w = synth(tmp.path(), "in.wav", 2, &["-c:a", "pcm_s16le"]);
        let out = tmp.path().join("out.flac");
        to_flac(&Tools::default(), &w, &out).unwrap();
        let md = crate::parse_flac(&out).unwrap();
        assert!((md.duration_ms as f64 / 1000.0 - 2.0).abs() < 0.1);
        assert_eq!(md.bit_depth, 16);
        assert!(!tmp.path().join("out.flac.part").exists());
    }

    /// O decodificador de MP3/AAC entrega float e o encoder FLAC escolhia
    /// 32 bit (gravado como 24): a faixa parecia hi-res sem ser.
    #[test]
    fn to_flac_de_lossy_sai_16_bit() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        for (nome, extra) in [("in.mp3", &["-b:a", "320k"][..]), ("in.m4a", &["-c:a", "aac", "-b:a", "256k"][..])] {
            let src = synth(tmp.path(), nome, 2, extra);
            let out = tmp.path().join(format!("{nome}.flac"));
            to_flac(&Tools::default(), &src, &out).unwrap();
            let md = crate::parse_flac(&out).unwrap();
            assert_eq!(md.bit_depth, 16, "{nome} virou FLAC {} bit", md.bit_depth);
            assert!((md.duration_ms as f64 / 1000.0 - 2.0).abs() < 0.1);
        }
    }

    #[test]
    fn to_flac_de_wav_24_continua_24_bit() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let w = synth(tmp.path(), "in24.wav", 2, &["-c:a", "pcm_s24le"]);
        let out = tmp.path().join("out24.flac");
        to_flac(&Tools::default(), &w, &out).unwrap();
        assert_eq!(crate::parse_flac(&out).unwrap().bit_depth, 24);
    }

    #[test]
    fn to_flac_origem_que_nao_e_audio_falha_sem_retry() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let bogus = tmp.path().join("lixo.wav");
        std::fs::write(&bogus, b"isto nao e audio").unwrap();
        let out = tmp.path().join("out.flac");
        let err = to_flac(&Tools::default(), &bogus, &out).unwrap_err();
        assert!(matches!(&err, TranscodeError::Falhou(m) if m.contains("origem inválida")), "{err}");
        assert!(!err.retryable());
        assert!(!out.exists());
    }

    fn assert_sem_saida(dir: &Path) {
        assert!(!dir.join("out.flac").exists(), "out.flac não pode ficar no disco");
        assert!(!dir.join("out.flac.part").exists(), "out.flac.part não pode ficar no disco");
    }

    #[test]
    fn to_flac_ffmpeg_sai_zero_com_lixo_e_rejeitado() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let w = synth(tmp.path(), "in.wav", 2, &["-c:a", "pcm_s16le"]);
        let t = fake_ffmpeg(tmp.path(), "printf 'lixo que nao e flac' > \"$last\"\nexit 0");
        let err = to_flac(&t, &w, &tmp.path().join("out.flac")).unwrap_err();
        assert!(matches!(&err, TranscodeError::Falhou(m) if m.contains("FLAC inválido")), "{err}");
        assert_sem_saida(tmp.path());
    }

    #[test]
    fn to_flac_ffmpeg_escreve_flac_curto_demais_e_rejeitado() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let w = synth(tmp.path(), "in.wav", 4, &["-c:a", "pcm_s16le"]);
        let curto = synth(tmp.path(), "curto.flac", 1, &["-c:a", "flac"]);
        let t = fake_ffmpeg(tmp.path(), &format!("cp '{}' \"$last\"\nexit 0", curto.display()));
        let err = to_flac(&t, &w, &tmp.path().join("out.flac")).unwrap_err();
        assert!(matches!(&err, TranscodeError::Falhou(m) if m.contains("duração divergente")), "{err}");
        assert_sem_saida(tmp.path());
    }

    #[test]
    fn to_flac_ffmpeg_travado_e_morto_e_volta_timeout_retentavel() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let w = synth(tmp.path(), "in.wav", 1, &["-c:a", "pcm_s16le"]);
        let mut t = fake_ffmpeg(tmp.path(), "printf parcial > \"$last\"\nexec sleep 60");
        t.transcode_floor = Duration::from_millis(500);
        let t0 = Instant::now();
        let err = to_flac(&t, &w, &tmp.path().join("out.flac")).unwrap_err();
        assert!(t0.elapsed() < Duration::from_secs(10), "não respeitou o teto: {:?}", t0.elapsed());
        assert!(matches!(err, TranscodeError::Timeout(_)), "{err}");
        assert!(err.retryable());
        assert_sem_saida(tmp.path());
    }

    #[test]
    fn probe_travado_volta_timeout() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("ffprobe-falso");
        std::fs::write(&p, "#!/bin/sh\nexec sleep 60\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        let t = Tools { ffprobe: p, probe_timeout: Duration::from_millis(300), ..Tools::default() };
        let err = probe_media(&t, &tmp.path().join("x.wav")).unwrap_err();
        assert!(matches!(err, TranscodeError::Timeout(_)), "{err}");
    }
}
