//! Perfil de volume por faixa: 400 baldes de RMS em dBFS (u8), para o seek
//! mostrar a forma da música.
//!
//! Escala: 0 = -60 dBFS ou menos, 255 = 0 dBFS (senoide cheia fica em ~242,
//! pois seu RMS é -3 dBFS). Mono = média dos canais por frame. O RMS de cada
//! balde é a raiz da média dos quadrados de TODOS os frames dele.
//!
//! O acumulador não depende do total de frames anunciado no cabeçalho: guarda
//! a soma de quadrados por bloco de 256 frames e só no `finish` redistribui os
//! blocos nos 400 baldes (por centro do bloco). Memória: 8 bytes por bloco,
//! ~1,4 MB por hora de áudio a 44,1 kHz.
//!
//! Gravado no payload de `rustify_tracks` como `wave_profile` (array de 400
//! inteiros) e `wave_profile_v` = [`WAVE_VERSION`]; `wave_profile_v` = 0 é o
//! marcador de "tentou e falhou" (o backfill não insiste).

use std::fs::File;
use std::path::{Path, PathBuf};

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_FLAC};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{Limit, MetadataOptions};
use symphonia::core::probe::Hint;

use crate::error::IndexerError;

pub const WAVE_BUCKETS: usize = 400;
pub const WAVE_VERSION: u32 = 1;
/// Piso da escala: RMS em dBFS igual ou abaixo disto vira 0.
pub const FLOOR_DB: f64 = -60.0;
/// Frames por bloco intermediário do acumulador.
const BLOCK_FRAMES: u32 = 256;

/// RMS linear (0..1+) para o byte da escala (0 = -60 dBFS, 255 = 0 dBFS).
pub fn rms_to_u8(rms: f64) -> u8 {
    if !(rms > 0.0) {
        return 0;
    }
    let db = 20.0 * rms.log10();
    (((db - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Acumula frames (interleaved) e produz o perfil.
#[derive(Debug, Default)]
pub struct WaveAccumulator {
    /// Soma de quadrados do sinal mono de cada bloco fechado.
    blocks: Vec<f64>,
    cur_sumsq: f64,
    cur_n: u32,
    total_frames: u64,
}

impl WaveAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Alimenta com amostras interleaved de `channels` canais. Sobra parcial
    /// (menos de um frame completo) é descartada.
    pub fn push_interleaved(&mut self, samples: &[f32], channels: usize) {
        let ch = channels.max(1);
        let inv = 1.0 / ch as f32;
        for frame in samples.chunks_exact(ch) {
            let mono = if ch == 1 { frame[0] } else { frame.iter().sum::<f32>() * inv };
            self.cur_sumsq += (mono as f64) * (mono as f64);
            self.cur_n += 1;
            self.total_frames += 1;
            if self.cur_n == BLOCK_FRAMES {
                self.blocks.push(self.cur_sumsq);
                self.cur_sumsq = 0.0;
                self.cur_n = 0;
            }
        }
    }

    pub fn total_frames(&self) -> u64 {
        self.total_frames
    }

    /// Perfil de [`WAVE_BUCKETS`] bytes, ou `None` se não houve nenhum frame.
    /// Balde sem bloco (faixa mais curta que 400 blocos) repete o anterior.
    pub fn finish(mut self) -> Option<Vec<u8>> {
        if self.total_frames == 0 {
            return None;
        }
        let total = self.total_frames;
        let tail_n = self.cur_n as u64;
        if tail_n > 0 {
            self.blocks.push(self.cur_sumsq);
        }
        let mut sumsq = [0.0f64; WAVE_BUCKETS];
        let mut count = [0u64; WAVE_BUCKETS];
        let last = self.blocks.len() - 1;
        for (j, &sq) in self.blocks.iter().enumerate() {
            let n = if j == last && tail_n > 0 { tail_n } else { BLOCK_FRAMES as u64 };
            let center = j as u64 * BLOCK_FRAMES as u64 + n / 2;
            let b = ((center * WAVE_BUCKETS as u64 / total) as usize).min(WAVE_BUCKETS - 1);
            sumsq[b] += sq;
            count[b] += n;
        }
        let mut out = Vec::with_capacity(WAVE_BUCKETS);
        let mut prev = 0u8;
        for b in 0..WAVE_BUCKETS {
            let v = if count[b] > 0 {
                rms_to_u8((sumsq[b] / count[b] as f64).sqrt())
            } else {
                prev
            };
            out.push(v);
            prev = v;
        }
        Some(out)
    }
}

/// Decodifica o FLAC inteiro e devolve o perfil de [`WAVE_BUCKETS`] bytes.
pub fn analyze_flac(path: &Path) -> Result<Vec<u8>, IndexerError> {
    let err = |m: String| IndexerError::Metadata { path: PathBuf::from(path), message: m };
    let file = File::open(path).map_err(|e| err(format!("open: {e}")))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    hint.with_extension("flac");
    hint.mime_type("audio/flac");
    let meta_opts = MetadataOptions {
        limit_visual_bytes: Limit::Maximum(0),
        limit_metadata_bytes: Limit::Maximum(64 * 1024),
    };
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &meta_opts)
        .map_err(|e| err(format!("probe: {e}")))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec == CODEC_TYPE_FLAC)
        .ok_or_else(|| err("no FLAC track in container".into()))?;
    let track_id = track.id;
    let channels = track
        .codec_params
        .channels
        .map(|c| c.count())
        .filter(|&c| c > 0)
        .ok_or_else(|| err("missing channel layout".into()))?;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| err(format!("decoder init: {e}")))?;

    let mut acc = WaveAccumulator::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(ref e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(err(format!("read packet: {e}"))),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(err(format!("decode: {e}"))),
        };
        let spec = *decoded.spec();
        let frames = decoded.capacity() as u64;
        let buf = sample_buf.get_or_insert_with(|| SampleBuffer::<f32>::new(frames, spec));
        buf.copy_interleaved_ref(decoded);
        acc.push_interleaved(buf.samples(), channels);
    }
    acc.finish().ok_or_else(|| err("no audio frames decoded".into()))
}

/// Valida o array do payload: exatamente [`WAVE_BUCKETS`] inteiros 0..=255.
pub fn parse_profile(v: &serde_json::Value) -> Option<Vec<u8>> {
    let arr = v.as_array()?;
    if arr.len() != WAVE_BUCKETS {
        return None;
    }
    arr.iter().map(|x| x.as_u64().and_then(|n| u8::try_from(n).ok())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(frames: usize, amp: f32, channels: usize) -> Vec<f32> {
        let mut v = Vec::with_capacity(frames * channels);
        for i in 0..frames {
            let s = amp * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 44_100.0).sin();
            for _ in 0..channels {
                v.push(s);
            }
        }
        v
    }

    #[test]
    fn escala_dbfs() {
        assert_eq!(rms_to_u8(0.0), 0);
        assert_eq!(rms_to_u8(1e-4), 0); // -80 dBFS
        assert_eq!(rms_to_u8(0.001), 0); // exatamente -60
        assert_eq!(rms_to_u8(1.0), 255);
        assert_eq!(rms_to_u8(2.0), 255); // acima de 0 dBFS satura
        assert_eq!(rms_to_u8(0.1), 170); // -20 dB => (40/60)*255
        assert_eq!(rms_to_u8(f64::NAN), 0);
    }

    #[test]
    fn sempre_400_baldes() {
        let mut a = WaveAccumulator::new();
        a.push_interleaved(&sine(44_100 * 5, 0.5, 2), 2);
        assert_eq!(a.finish().unwrap().len(), WAVE_BUCKETS);
    }

    #[test]
    fn senoide_constante_da_perfil_plano_no_nivel_certo() {
        let mut a = WaveAccumulator::new();
        a.push_interleaved(&sine(44_100 * 10, 0.5, 1), 1);
        let p = a.finish().unwrap();
        // RMS de 0.5 sin = 0.3536 => -9.03 dBFS => (50.97/60)*255 = 216.6
        for &b in &p {
            assert!((b as i32 - 217).abs() <= 2, "balde {b}");
        }
    }

    #[test]
    fn forma_acompanha_o_volume() {
        // 1/3 silencio, 1/3 amp 0.1, 1/3 amp 0.8
        let n = 44_100 * 9;
        let mut s = vec![0.0f32; n / 3];
        s.extend(sine(n / 3, 0.1, 1));
        s.extend(sine(n / 3, 0.8, 1));
        let mut a = WaveAccumulator::new();
        a.push_interleaved(&s, 1);
        let p = a.finish().unwrap();
        assert_eq!(p[10], 0);
        assert!(p[200] > 100 && p[200] < p[390]);
        assert!(p[390] > 220);
    }

    #[test]
    fn mono_e_media_dos_canais() {
        // L=+0.5, R=-0.5 anula (média 0): silêncio. L=R=0.5: -6 dBFS.
        let mut anula = WaveAccumulator::new();
        let x: Vec<f32> = (0..44_100 * 2).flat_map(|_| [0.5f32, -0.5]).collect();
        anula.push_interleaved(&x, 2);
        assert!(anula.finish().unwrap().iter().all(|&b| b == 0));

        let mut igual = WaveAccumulator::new();
        let y: Vec<f32> = (0..44_100 * 2).flat_map(|_| [0.5f32, 0.5]).collect();
        igual.push_interleaved(&y, 2);
        let p = igual.finish().unwrap();
        assert!(p.iter().all(|&b| b == rms_to_u8(0.5)));
    }

    #[test]
    fn faixa_curta_repete_balde_anterior_em_vez_de_buraco() {
        // 1000 frames => 4 blocos, bem menos que 400 baldes.
        let mut a = WaveAccumulator::new();
        a.push_interleaved(&vec![0.5f32; 1000], 1);
        let p = a.finish().unwrap();
        assert_eq!(p.len(), WAVE_BUCKETS);
        let v = rms_to_u8(0.5);
        assert_eq!(p[399], v);
        assert!(p.iter().all(|&b| b == v || b == 0));
    }

    #[test]
    fn sem_frames_nao_ha_perfil() {
        assert!(WaveAccumulator::new().finish().is_none());
        let mut a = WaveAccumulator::new();
        a.push_interleaved(&[0.1], 2); // meio frame
        assert!(a.finish().is_none());
    }

    #[test]
    fn independe_de_como_o_audio_e_fatiado() {
        let s = sine(44_100 * 3, 0.4, 2);
        let mut a = WaveAccumulator::new();
        a.push_interleaved(&s, 2);
        let mut b = WaveAccumulator::new();
        for chunk in s.chunks(2 * 1117) {
            b.push_interleaved(chunk, 2);
        }
        assert_eq!(a.finish(), b.finish());
    }

    #[test]
    fn parse_profile_valida_tamanho_e_faixa() {
        let ok = serde_json::json!(vec![7u8; WAVE_BUCKETS]);
        assert_eq!(parse_profile(&ok).unwrap().len(), WAVE_BUCKETS);
        assert!(parse_profile(&serde_json::json!([1, 2, 3])).is_none());
        let mut grande = vec![serde_json::json!(1); WAVE_BUCKETS];
        grande[5] = serde_json::json!(300);
        assert!(parse_profile(&serde_json::Value::Array(grande)).is_none());
        assert!(parse_profile(&serde_json::Value::Null).is_none());
    }

    #[test]
    fn arquivo_inexistente_e_erro() {
        assert!(analyze_flac(Path::new("/nao/existe.flac")).is_err());
    }

    /// Medição de tempo em arquivo real: `WAVE_BENCH_FLAC=/caminho.flac cargo
    /// test -p library-indexer --release bench_perfil -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn bench_perfil() {
        let p = std::env::var("WAVE_BENCH_FLAC").expect("WAVE_BENCH_FLAC");
        let t = std::time::Instant::now();
        let prof = analyze_flac(Path::new(&p)).unwrap();
        eprintln!("perfil: {} baldes em {:?}", prof.len(), t.elapsed());
        eprintln!("{:?}", &prof[..40]);
    }
}
