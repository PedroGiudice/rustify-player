//! Corte espectral de lossy: MP3/AAC/Opus disfarçado de FLAC.
//!
//! Porte de `scripts/curator/quality_audit.py` (método e calibração em
//! `docs/contexto/15102026-qualidade-soundcloud.md`). As duas cópias precisam
//! dar o mesmo resultado: a fixture `scripts/curator/fixtures/spectral_cliffs.json`
//! (espectros reais + resultado do Python) trava `find_cliff`, a escolha do
//! corte e `classify` dos dois lados. Mudou uma constante aqui, mude lá.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::IndexerError;

/// Classe de qualidade medida no conteúdo (não na etiqueta do arquivo).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualityClass {
    /// Sem degrau, ou degrau só no filtro do conversor (>= 20,6 kHz).
    SemCorte,
    /// Corte entre 19,5 e 20,6 kHz: MP3 320, Opus, AAC alto (raro: resampler).
    ProvavelLossy,
    /// Corte abaixo de 19,5 kHz.
    Lossy,
    /// Taxa > 48 kHz com corte de áudio de CD: upsample de 44,1/48 kHz.
    HiresDeCd,
}

/// Degrau mínimo (dB) entre a faixa logo abaixo e a logo acima do corte.
pub const DROP_DB: f64 = 20.0;
/// Meia-largura das faixas comparadas em volta do candidato e folga do centro (Hz).
const SIDE_HZ: f64 = 500.0;
const GAP_HZ: f64 = 100.0;
/// Abaixo disto nenhum corte é procurado.
const SCAN_FROM_HZ: f64 = 10_000.0;
/// Fronteiras das classes (Hz), calibradas em 15/10/2026.
pub const CUT_LOSSY: u32 = 19_500;
pub const CUT_HIGH: u32 = 20_600;
pub const HIRES_REAL_HZ: u32 = 24_500;

impl QualityClass {
    /// Nome no payload do Qdrant e no relatório (igual ao do Python).
    pub fn as_str(self) -> &'static str {
        match self {
            QualityClass::SemCorte => "sem_corte",
            QualityClass::ProvavelLossy => "provavel_lossy",
            QualityClass::Lossy => "lossy",
            QualityClass::HiresDeCd => "hires_de_cd",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        [Self::SemCorte, Self::ProvavelLossy, Self::Lossy, Self::HiresDeCd].into_iter().find(|c| c.as_str() == s)
    }

    /// Regra do CEO (15/10/2026): só lossless de verdade entra no acervo.
    pub fn is_lossy(self) -> bool {
        matches!(self, QualityClass::Lossy | QualityClass::ProvavelLossy)
    }
}

/// Classe pelo corte. Acima de `CUT_HIGH` o degrau é o filtro do conversor
/// (normal em lossless); em hi-res um degrau antes de `HIRES_REAL_HZ`
/// denuncia upsample de 44,1/48 kHz.
pub fn classify(sr: u32, cutoff_hz: Option<u32>) -> QualityClass {
    let Some(c) = cutoff_hz else { return QualityClass::SemCorte };
    if c < CUT_LOSSY {
        QualityClass::Lossy
    } else if c < CUT_HIGH {
        QualityClass::ProvavelLossy
    } else if sr > 48_000 && c < HIRES_REAL_HZ {
        QualityClass::HiresDeCd
    } else {
        QualityClass::SemCorte
    }
}

/// `round` do Python/numpy: empate vai para o par.
fn py_round(x: f64) -> f64 {
    x.round_ties_even()
}

/// Arredondamento correto a 0,1 (o `round(x, 1)` do Python).
fn round1(x: f64) -> f64 {
    format!("{x:.1}").parse().unwrap_or(x)
}

/// Média móvel de `bins` com as bordas repetidas (mesmo comprimento da entrada).
fn smooth(db: &[f64], bins: usize) -> Vec<f64> {
    if bins <= 1 || db.is_empty() {
        return db.to_vec();
    }
    let pad = bins / 2;
    let mut e = Vec::with_capacity(db.len() + bins - 1);
    e.extend(std::iter::repeat(db[0]).take(pad));
    e.extend_from_slice(db);
    e.extend(std::iter::repeat(db[db.len() - 1]).take(bins - 1 - pad));
    (0..db.len()).map(|i| e[i..i + bins].iter().sum::<f64>() / bins as f64).collect()
}

/// Maior degrau de um espectro em dB acima de `SCAN_FROM_HZ`:
/// drop(f) = média(dB em [f-SIDE-GAP, f-GAP]) - média(dB em [f+GAP, f+SIDE+GAP]).
/// Devolve (f do maior drop, se drop >= `DROP_DB`; drop arredondado a 0,1 dB).
/// `df` = largura do bin em Hz.
pub fn find_cliff(df: f64, db: &[f64]) -> (Option<u32>, f64) {
    let db = smooth(db, (py_round(150.0 / df) as usize).max(1));
    let side = py_round(SIDE_HZ / df) as usize;
    let gap = py_round(GAP_HZ / df) as usize;
    let mut cs = Vec::with_capacity(db.len() + 1);
    cs.push(0.0);
    for v in &db {
        cs.push(cs[cs.len() - 1] + v);
    }
    let lo = ((SCAN_FROM_HZ / df) as usize).max(side + gap);
    let hi = db.len().saturating_sub(side + gap + 1);
    if hi <= lo {
        return (None, 0.0);
    }
    let (mut best_i, mut best) = (lo, f64::NEG_INFINITY);
    for i in lo..hi {
        let below = (cs[i - gap] - cs[i - gap - side]) / side as f64;
        let above = (cs[i + gap + side + 1] - cs[i + gap + 1]) / side as f64;
        let d = below - above;
        if d > best {
            best = d;
            best_i = i;
        }
    }
    let cut = (best >= DROP_DB).then(|| py_round(best_i as f64 * df) as u32);
    (cut, round1(best))
}

/// Corte da faixa: vale o degrau mais forte entre o quadro típico (mediana) e
/// os quadros calmos (percentil 10). Mediana e não média: em master no talo o
/// MP3 decodificado satura e os quadros saturados apagam o degrau na média.
pub fn pick_cutoff(df: f64, median_db: &[f64], p10_db: &[f64]) -> Option<u32> {
    let a = find_cliff(df, median_db);
    let b = find_cliff(df, p10_db);
    [a, b]
        .into_iter()
        .filter_map(|(c, d)| c.map(|c| (d, c)))
        .max_by(|x, y| x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)))
        .map(|(_, c)| c)
}

/// Resultado da análise de um arquivo.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpectralVerdict {
    pub class: QualityClass,
    pub cutoff_hz: Option<u32>,
}

/// Duração de cada janela e onde elas começam (fração da faixa).
const WINDOW_S: f64 = 20.0;
const WINDOW_AT: [f64; 3] = [0.20, 0.45, 0.70];
/// Quadro 60 dB abaixo do mais forte da janela = silêncio, fora da conta.
const SILENCE_DB: f64 = 60.0;
/// Menos quadros com som que isto: não há o que medir.
const MIN_FRAMES: usize = 20;

/// ~10,8 Hz por bin em 44,1 kHz; dobra com a taxa.
pub fn fft_size(sr: u32) -> usize {
    let mut n = 4096usize;
    while sr as f64 / n as f64 > 12.0 {
        n *= 2;
    }
    n
}

/// Percentil com interpolação linear (o padrão do numpy). `v` é reordenado.
fn percentile(v: &mut [f64], q: f64) -> f64 {
    v.sort_unstable_by(|a, b| a.total_cmp(b));
    let pos = q / 100.0 * (v.len() - 1) as f64;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    v[lo] + (v[hi] - v[lo]) * (pos - lo as f64)
}

/// Espectro de cada quadro (canais somados) em dB RELATIVO à média de 2-8 kHz
/// do próprio quadro, sem os quadros de silêncio. `x` é intercalado.
fn frame_spectra(x: &[f32], ch: usize, sr: u32, out: &mut Vec<Vec<f64>>) {
    use rustfft::{num_complex::Complex, FftPlanner};
    let n = fft_size(sr);
    let hop = n / 2;
    let frames_total = x.len() / ch;
    if frames_total < n {
        return;
    }
    let nbins = n / 2 + 1;
    let df = sr as f64 / n as f64;
    let win: Vec<f64> = (0..n)
        .map(|k| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * k as f64 / (n - 1) as f64).cos())
        .collect();
    let fft = FftPlanner::<f64>::new().plan_fft_forward(n);
    let mut buf = vec![Complex::new(0.0, 0.0); n];
    let nfr = 1 + (frames_total - n) / hop;
    let mut powers: Vec<Vec<f64>> = Vec::with_capacity(nfr);
    for f in 0..nfr {
        let mut p = vec![0.0f64; nbins];
        for c in 0..ch {
            for (k, b) in buf.iter_mut().enumerate() {
                *b = Complex::new(x[(f * hop + k) * ch + c] as f64 * win[k], 0.0);
            }
            fft.process(&mut buf);
            for (pk, b) in p.iter_mut().zip(&buf[..nbins]) {
                *pk += b.norm_sqr();
            }
        }
        powers.push(p);
    }
    let energy: Vec<f64> = powers.iter().map(|p| p.iter().sum()).collect();
    let emax = energy.iter().cloned().fold(0.0, f64::max);
    if emax <= 0.0 {
        return;
    }
    let (r_lo, r_hi) = ((2000.0 / df).ceil() as usize, (8000.0 / df).floor() as usize);
    for (p, e) in powers.into_iter().zip(energy) {
        if 10.0 * (e / emax + 1e-30).log10() <= -SILENCE_DB {
            continue;
        }
        let db: Vec<f64> = p.iter().map(|v| 10.0 * (v + 1e-20).log10()).collect();
        let reference = db[r_lo..=r_hi].iter().sum::<f64>() / (r_hi - r_lo + 1) as f64;
        out.push(db.into_iter().map(|v| v - reference).collect());
    }
}

/// Decodifica só as amostras das janelas pedidas (em quadros de amostra).
/// Devolve (taxa, canais, uma Vec intercalada por janela).
fn decode_windows(path: &Path) -> Result<(u32, usize, Vec<Vec<f32>>), IndexerError> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_FLAC};
    use symphonia::core::errors::Error as SErr;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::{Limit, MetadataOptions};
    use symphonia::core::probe::Hint;

    let err = |m: String| IndexerError::Metadata { path: path.to_path_buf(), message: m };
    let file = std::fs::File::open(path).map_err(|e| err(format!("open: {e}")))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    hint.with_extension("flac");
    let meta = MetadataOptions { limit_visual_bytes: Limit::Maximum(0), limit_metadata_bytes: Limit::Maximum(64 * 1024) };
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &meta)
        .map_err(|e| err(format!("probe: {e}")))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec == CODEC_TYPE_FLAC)
        .ok_or_else(|| err("sem trilha FLAC".into()))?;
    let track_id = track.id;
    let sr = track.codec_params.sample_rate.ok_or_else(|| err("sem taxa de amostragem".into()))?;
    let ch = track.codec_params.channels.map(|c| c.count()).unwrap_or(0);
    if ch == 0 || sr == 0 {
        return Err(err("trilha sem canais".into()));
    }
    let total = track.codec_params.n_frames.unwrap_or(0) as f64 / sr as f64;
    let spans: Vec<(u64, u64)> = if total >= 3.0 * WINDOW_S + 10.0 {
        WINDOW_AT.iter().map(|a| ((total * a * sr as f64) as u64, (WINDOW_S * sr as f64) as u64)).collect()
    } else {
        // Curta ou sem duração no cabeçalho: até 60 s desde o começo.
        vec![(0, (3.0 * WINDOW_S * sr as f64) as u64)]
    };
    let end = spans.iter().map(|(a, l)| a + l).max().unwrap_or(0);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| err(format!("decoder: {e}")))?;
    let mut wins: Vec<Vec<f32>> = spans.iter().map(|(_, l)| Vec::with_capacity(*l as usize * ch)).collect();
    let mut sbuf: Option<SampleBuffer<f32>> = None;
    let mut pos: u64 = 0;
    while pos < end {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SErr::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SErr::ResetRequired) => break,
            Err(e) => return Err(err(format!("leitura: {e}"))),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SErr::DecodeError(_)) => continue,
            Err(e) => return Err(err(format!("decodificação: {e}"))),
        };
        let spec = *decoded.spec();
        let buf = sbuf.get_or_insert_with(|| SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        if buf.capacity() < decoded.capacity() * spec.channels.count() {
            *buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        }
        buf.copy_interleaved_ref(decoded);
        let s = buf.samples();
        let nfr = (s.len() / ch) as u64;
        for ((a, l), w) in spans.iter().zip(wins.iter_mut()) {
            let (lo, hi) = (pos.max(*a), (pos + nfr).min(a + l));
            if lo < hi {
                w.extend_from_slice(&s[((lo - pos) as usize) * ch..((hi - pos) as usize) * ch]);
            }
        }
        pos += nfr;
    }
    Ok((sr, ch, wins))
}

/// Mede o FLAC: 3 janelas de 20 s (20%, 45% e 70% da faixa; até 60 s desde o
/// começo se for curta), canais somados, quadros de silêncio fora. Erro se não
/// houver áudio suficiente (arquivo mudo, curto demais ou ilegível).
pub fn analyze_flac(path: &Path) -> Result<SpectralVerdict, IndexerError> {
    let (sr, ch, wins) = decode_windows(path)?;
    let mut rel: Vec<Vec<f64>> = Vec::new();
    for w in &wins {
        frame_spectra(w, ch, sr, &mut rel);
    }
    if rel.len() < MIN_FRAMES {
        return Err(IndexerError::Metadata {
            path: path.to_path_buf(),
            message: format!("só {} quadros com som", rel.len()),
        });
    }
    let nbins = rel[0].len();
    let (mut med, mut p10) = (Vec::with_capacity(nbins), Vec::with_capacity(nbins));
    let mut col = vec![0.0f64; rel.len()];
    for b in 0..nbins {
        for (c, r) in col.iter_mut().zip(&rel) {
            *c = r[b];
        }
        med.push(percentile(&mut col, 50.0));
        p10.push(percentile(&mut col, 10.0));
    }
    let df = sr as f64 / fft_size(sr) as f64;
    let cutoff_hz = pick_cutoff(df, &med, &p10);
    Ok(SpectralVerdict { class: classify(sr, cutoff_hz), cutoff_hz })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    fn have_ffmpeg() -> bool {
        Command::new("ffmpeg").arg("-version").output().map(|o| o.status.success()).unwrap_or(false)
    }

    fn ff(args: &[&str], out: &Path) {
        let st = Command::new("ffmpeg").args(["-nostdin", "-loglevel", "error", "-y"]).args(args).arg(out).status().unwrap();
        assert!(st.success(), "ffmpeg {args:?}");
    }

    /// Ruído rosa estéreo de 70 s em FLAC (lossless) e o mesmo passado por MP3 128.
    fn pares(dir: &Path) -> (PathBuf, PathBuf) {
        let flac = dir.join("rosa.flac");
        ff(&["-f", "lavfi", "-i", "anoisesrc=d=70:c=pink:a=0.3", "-ac", "2", "-ar", "44100", "-c:a", "flac"], &flac);
        let mp3 = dir.join("rosa.mp3");
        ff(&["-i", flac.to_str().unwrap(), "-c:a", "libmp3lame", "-b:a", "128k"], &mp3);
        let lossy = dir.join("rosa-mp3.flac");
        ff(&["-i", mp3.to_str().unwrap(), "-c:a", "flac"], &lossy);
        (flac, lossy)
    }

    #[test]
    fn flac_lossless_sai_sem_corte_e_mp3_disfarcado_sai_lossy() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let (flac, lossy) = pares(tmp.path());
        let v = analyze_flac(&flac).unwrap();
        assert_eq!(v.class, QualityClass::SemCorte, "{v:?}");
        let v = analyze_flac(&lossy).unwrap();
        assert_eq!(v.class, QualityClass::Lossy, "{v:?}");
        let c = v.cutoff_hz.unwrap();
        assert!((15_000..18_000).contains(&c), "corte {c}");
    }

    #[test]
    fn arquivo_mudo_e_erro() {
        if !have_ffmpeg() { eprintln!("sem ffmpeg: teste pulado"); return; }
        let tmp = tempfile::tempdir().unwrap();
        let mudo = tmp.path().join("mudo.flac");
        ff(&["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "5", "-c:a", "flac"], &mudo);
        assert!(analyze_flac(&mudo).is_err());
    }

    fn fixture() -> serde_json::Value {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../scripts/curator/fixtures/spectral_cliffs.json");
        serde_json::from_str(&std::fs::read_to_string(p).expect("fixture")).unwrap()
    }

    fn arr(v: &serde_json::Value) -> Vec<f64> {
        v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()
    }

    fn opt(v: &serde_json::Value) -> Option<u32> {
        v.as_u64().map(|x| x as u32)
    }

    #[test]
    fn concorda_com_o_python_nos_espectros_reais() {
        let fx = fixture();
        let cases = fx["cases"].as_array().unwrap();
        assert!(cases.len() >= 6);
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let sr = c["sr"].as_u64().unwrap() as u32;
            let df = sr as f64 / c["n_fft"].as_u64().unwrap() as f64;
            let med = arr(&c["median_db"]);
            let p10 = arr(&c["p10_db"]);
            let e = &c["expect"];
            let (cm, dm) = find_cliff(df, &med);
            let (cp, dp) = find_cliff(df, &p10);
            assert_eq!(cm, opt(&e["cut_med"]), "{name}: corte da mediana");
            assert!((dm - e["drop_med"].as_f64().unwrap()).abs() < 1e-9, "{name}: drop da mediana {dm}");
            assert_eq!(cp, opt(&e["cut_p10"]), "{name}: corte do p10");
            assert!((dp - e["drop_p10"].as_f64().unwrap()).abs() < 1e-9, "{name}: drop do p10 {dp}");
            let cut = pick_cutoff(df, &med, &p10);
            assert_eq!(cut, opt(&e["cutoff_hz"]), "{name}: corte final");
            let class = serde_json::to_value(classify(sr, cut)).unwrap();
            assert_eq!(class, e["class"], "{name}: classe");
        }
    }

    #[test]
    fn classes_por_corte() {
        assert_eq!(classify(44_100, None), QualityClass::SemCorte);
        assert_eq!(classify(44_100, Some(16_000)), QualityClass::Lossy);
        assert_eq!(classify(44_100, Some(18_700)), QualityClass::Lossy);
        assert_eq!(classify(44_100, Some(20_100)), QualityClass::ProvavelLossy);
        assert_eq!(classify(44_100, Some(21_400)), QualityClass::SemCorte);
        assert_eq!(classify(96_000, Some(22_000)), QualityClass::HiresDeCd);
        assert_eq!(classify(48_000, Some(22_000)), QualityClass::SemCorte);
        assert_eq!(classify(96_000, Some(40_000)), QualityClass::SemCorte);
        assert_eq!(classify(96_000, Some(16_000)), QualityClass::Lossy);
    }
}
