//! Sondagem de mídia (`ffprobe`) e conversão para FLAC (`ffmpeg`).
//!
//! Usado pelas fontes que não entregam FLAC (SoundCloud: WAV/AIFF/MP3 do
//! produtor). O `ffmpeg` pode sair com código 0 e escrever lixo, então a
//! saída é sempre validada por `parse_flac` e pela duração.

use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone)]
pub struct MediaProbe {
    pub codec: String,
    pub duration_s: f64,
    pub bit_rate_kbps: Option<u32>,
    pub bits_per_sample: Option<u16>,
}

/// `ffmpeg` e `ffprobe` executáveis no PATH.
pub fn ffmpeg_available() -> bool {
    Command::new("ffmpeg").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
        && Command::new("ffprobe").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
}

/// `ffprobe -of json`: codec do primeiro stream de áudio, duração e bitrate do container.
pub fn probe_media(path: &Path) -> Result<MediaProbe, String> {
    let out = Command::new("ffprobe")
        .args([
            "-v", "error", "-select_streams", "a:0", "-show_entries",
            "stream=codec_name,bits_per_sample,bits_per_raw_sample:format=duration,bit_rate",
            "-of", "json",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("ffprobe não executou: {e}"))?;
    if !out.status.success() {
        return Err("ffprobe falhou: arquivo não é áudio reconhecido".into());
    }
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe json: {e}"))?;
    let s = v["streams"].get(0).ok_or("ffprobe: sem stream de áudio")?;
    let codec = s["codec_name"].as_str().unwrap_or("").to_string();
    let bits = ["bits_per_raw_sample", "bits_per_sample"]
        .iter()
        .filter_map(|k| {
            s[k].as_str()
                .and_then(|x| x.parse::<u16>().ok())
                .or_else(|| s[k].as_u64().map(|x| x as u16))
        })
        .find(|b| *b > 0);
    let bits = bits.or_else(|| match codec.as_str() {
        "pcm_s24le" | "pcm_s24be" => Some(24),
        "pcm_s16le" | "pcm_s16be" => Some(16),
        "pcm_s32le" => Some(32),
        _ => None,
    });
    let duration_s = v["format"]["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0);
    let bit_rate_kbps = v["format"]["bit_rate"]
        .as_str()
        .and_then(|b| b.parse::<u64>().ok())
        .map(|b| (b / 1000) as u32);
    Ok(MediaProbe { codec, duration_s, bit_rate_kbps, bits_per_sample: bits })
}

/// WAV/AIFF/MP3 -> FLAC. Metadados e capa da origem descartados (serão reescritos).
/// Valida a saída: `parse_flac` + duração dentro de 2% (o ffmpeg pode sair 0 e escrever lixo).
pub fn to_flac(src: &Path, dst: &Path) -> Result<(), String> {
    let probe = probe_media(src).map_err(|e| format!("ffmpeg: origem inválida ({e})"))?;
    let tmp = dst.with_extension("flac.part");
    let st = Command::new("ffmpeg")
        .args(["-nostdin", "-loglevel", "error", "-y", "-i"])
        .arg(src)
        .args(["-vn", "-map_metadata", "-1", "-c:a", "flac", "-compression_level", "8", "-f", "flac"])
        .arg(&tmp)
        .status()
        .map_err(|e| format!("ffmpeg não executou: {e}"))?;
    if !st.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err("ffmpeg falhou na conversão".into());
    }
    let md = crate::parse_flac(&tmp).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("ffmpeg produziu FLAC inválido: {e}")
    })?;
    let got = md.duration_ms as f64 / 1000.0;
    if probe.duration_s > 0.0 && (got - probe.duration_s).abs() > probe.duration_s * 0.02 + 0.2 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("ffmpeg: duração divergente ({got:.1}s vs {:.1}s)", probe.duration_s));
    }
    std::fs::rename(&tmp, dst).map_err(|e| format!("rename: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn have_ffmpeg() -> bool { ffmpeg_available() }

    fn synth(dir: &std::path::Path, name: &str, extra: &[&str]) -> std::path::PathBuf {
        let out = dir.join(name);
        let st = Command::new("ffmpeg").args(["-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "2"]).args(extra).arg(&out).status().unwrap();
        assert!(st.success());
        out
    }

    #[test]
    fn probe_media_mp3_128_vs_320_e_wav24() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let m320 = synth(tmp.path(), "a320.mp3", &["-b:a", "320k"]);
        let m128 = synth(tmp.path(), "a128.mp3", &["-b:a", "128k"]);
        let w24 = synth(tmp.path(), "a24.wav", &["-c:a", "pcm_s24le"]);
        let p = probe_media(&m320).unwrap();
        assert_eq!(p.codec, "mp3"); assert!(p.bit_rate_kbps.unwrap() >= 300, "{p:?}");
        let p = probe_media(&m128).unwrap();
        assert!(p.bit_rate_kbps.unwrap() < 200, "{p:?}");
        let p = probe_media(&w24).unwrap();
        assert_eq!(p.codec, "pcm_s24le"); assert_eq!(p.bits_per_sample, Some(24)); assert!((p.duration_s - 2.0).abs() < 0.1);
    }

    #[test]
    fn to_flac_converte_wav_e_preserva_duracao() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let w = synth(tmp.path(), "in.wav", &["-c:a", "pcm_s16le"]);
        let out = tmp.path().join("out.flac");
        to_flac(&w, &out).unwrap();
        let md = crate::parse_flac(&out).unwrap();
        assert!((md.duration_ms as f64 / 1000.0 - 2.0).abs() < 0.1);
        assert_eq!(md.bit_depth, 16);
    }

    #[test]
    fn to_flac_rejeita_saida_vazia_ou_invalida() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let bogus = tmp.path().join("lixo.wav");
        std::fs::write(&bogus, b"isto nao e audio").unwrap();
        let out = tmp.path().join("out.flac");
        let err = to_flac(&bogus, &out).unwrap_err();
        assert!(err.contains("ffmpeg"), "{err}");
        assert!(!out.exists(), "saída inválida não pode ficar no disco");
    }
}
