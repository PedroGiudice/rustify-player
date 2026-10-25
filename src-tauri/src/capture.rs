// Captura da própria janela com os pixels reais do WebKitGTK, para a avaliação
// de design (Impeccable) pela ponte MCP. O screenshot da ponte não existe no
// Linux, a reconstrução do DOM (modern-screenshot) perde capas, fonte e o fundo,
// e o print do sistema pega o que estiver na frente da tela. O snapshot do
// próprio WebKit não tem nenhum desses defeitos.
//
// Uso: `window.__TAURI__.core.invoke("debug_capture_webview")` pela ponte; o PNG
// fica em ~/.cache/rustify-player/captures/ (só as KEEP mais recentes) e a
// resposta traz o caminho para buscar por scp. Nunca escreve fora dessa pasta.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::WebviewWindow;

const KEEP: usize = 20;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize)]
pub struct CaptureInfo {
    path: String,
    width: u32,
    height: u32,
    ms: u64,
}

struct Raw {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

/// Fotografa a janela principal. `full_document` pega a página inteira em vez
/// da parte visível (o app rola por dentro, então quase sempre dá no mesmo).
#[tauri::command]
pub async fn debug_capture_webview(
    window: WebviewWindow,
    full_document: Option<bool>,
) -> Result<CaptureInfo, String> {
    let started = Instant::now();
    let full = full_document.unwrap_or(false);
    let (tx, rx) = mpsc::channel::<Result<Raw, String>>();

    window
        .with_webview(move |pw| {
            use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
            let region = if full {
                SnapshotRegion::FullDocument
            } else {
                SnapshotRegion::Visible
            };
            // O callback roda no loop principal do GTK: só copia os bytes; a
            // conversão e o PNG ficam fora da thread da interface.
            pw.inner().snapshot(
                region,
                SnapshotOptions::NONE,
                None::<&webkit2gtk::gio::Cancellable>,
                move |res| {
                    let _ = tx.send(res.map_err(|e| e.to_string()).and_then(surface_to_raw));
                },
            );
        })
        .map_err(|e| e.to_string())?;

    let dir = crate::imp::cache_dir().join("captures");
    tauri::async_runtime::spawn_blocking(move || {
        let raw = rx
            .recv_timeout(TIMEOUT)
            .map_err(|_| format!("captura sem resposta em {} s", TIMEOUT.as_secs()))??;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = dir.join(format!("capture-{stamp}.png"));
        let img = image::RgbaImage::from_raw(raw.width, raw.height, raw.rgba)
            .ok_or("buffer da captura com tamanho errado")?;
        img.save_with_format(&path, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        prune(&dir, KEEP);
        Ok(CaptureInfo {
            path: path.to_string_lossy().into_owned(),
            width: raw.width,
            height: raw.height,
            ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn surface_to_raw(surface: cairo::Surface) -> Result<Raw, String> {
    let img = cairo::ImageSurface::try_from(surface)
        .map_err(|_| "o snapshot não veio como imagem".to_string())?;
    img.flush();
    let has_alpha = match img.format() {
        cairo::Format::ARgb32 => true,
        cairo::Format::Rgb24 => false,
        other => return Err(format!("formato de captura inesperado: {other:?}")),
    };
    let (w, h, stride) = (img.width() as usize, img.height() as usize, img.stride() as usize);
    let mut rgba = Vec::new();
    img.with_data(|data| rgba = cairo_to_rgba(data, w, h, stride, has_alpha))
        .map_err(|e| e.to_string())?;
    Ok(Raw { width: w as u32, height: h as u32, rgba })
}

/// Cairo guarda cada pixel como u32 em ordem nativa (A no byte alto), com cor
/// pré-multiplicada pelo alfa; o PNG quer RGBA direto.
fn cairo_to_rgba(data: &[u8], w: usize, h: usize, stride: usize, has_alpha: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        let row = &data[y * stride..y * stride + w * 4];
        for px in row.chunks_exact(4) {
            let v = u32::from_ne_bytes([px[0], px[1], px[2], px[3]]);
            let a = if has_alpha { v >> 24 } else { 255 };
            let un = |c: u32| -> u8 {
                if a == 0 {
                    0
                } else {
                    ((c * 255 + a / 2) / a).min(255) as u8
                }
            };
            out.extend_from_slice(&[un((v >> 16) & 0xff), un((v >> 8) & 0xff), un(v & 0xff), a as u8]);
        }
    }
    out
}

/// Mantém só as `keep` capturas mais novas (o nome carrega o instante em ms).
fn prune(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("capture-") && n.ends_with(".png"))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort();
    for old in &files[..files.len() - keep] {
        let _ = std::fs::remove_file(old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(a: u32, r: u32, g: u32, b: u32) -> [u8; 4] {
        ((a << 24) | (r << 16) | (g << 8) | b).to_ne_bytes()
    }

    #[test]
    fn converte_opaco_e_respeita_stride() {
        // 2x1 com 4 bytes de sobra no fim da linha.
        let mut data = Vec::new();
        data.extend_from_slice(&px(255, 10, 20, 30));
        data.extend_from_slice(&px(255, 200, 100, 0));
        data.extend_from_slice(&[9, 9, 9, 9]);
        let out = cairo_to_rgba(&data, 2, 1, 12, true);
        assert_eq!(out, vec![10, 20, 30, 255, 200, 100, 0, 255]);
    }

    #[test]
    fn desfaz_pre_multiplicacao() {
        // Vermelho puro com alfa 50%: cairo guarda r=128.
        let out = cairo_to_rgba(&px(128, 128, 0, 0), 1, 1, 4, true);
        assert_eq!(out, vec![255, 0, 0, 128]);
        let zero = cairo_to_rgba(&px(0, 0, 0, 0), 1, 1, 4, true);
        assert_eq!(zero, vec![0, 0, 0, 0]);
    }

    #[test]
    fn rgb24_ignora_o_byte_de_alfa() {
        let out = cairo_to_rgba(&px(0, 1, 2, 3), 1, 1, 4, false);
        assert_eq!(out, vec![1, 2, 3, 255]);
    }

    #[test]
    fn prune_guarda_as_mais_novas_e_ignora_outros_arquivos() {
        let dir = std::env::temp_dir().join(format!("rustify-capture-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for stamp in [1000, 1001, 1002, 1003] {
            std::fs::write(dir.join(format!("capture-{stamp}.png")), b"x").unwrap();
        }
        std::fs::write(dir.join("outro.png"), b"x").unwrap();
        prune(&dir, 2);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, vec!["capture-1002.png", "capture-1003.png", "outro.png"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
