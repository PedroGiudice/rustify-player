//! Mede FLACs com o detector espectral do app (paridade com
//! scripts/curator/quality_audit.py). Uso:
//!   cargo run --release -p library-indexer --example spectral_check -- <dir>
//! Saída TSV: caminho relativo, classe, corte (Hz ou -), ms.

use std::path::Path;
use std::time::Instant;

fn main() {
    let root = std::env::args().nth(1).expect("diretório");
    let root = Path::new(&root);
    let mut files: Vec<_> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "flac"))
        .map(|e| e.path().to_path_buf())
        .collect();
    files.sort();
    for f in files {
        let t0 = Instant::now();
        let rel = f.strip_prefix(root).unwrap().display();
        match library_indexer::spectral::analyze_flac(&f) {
            Ok(v) => println!(
                "{rel}\t{}\t{}\t{}",
                v.class.as_str(),
                v.cutoff_hz.map(|c| c.to_string()).unwrap_or("-".into()),
                t0.elapsed().as_millis()
            ),
            Err(e) => println!("{rel}\terro\t{e}\t{}", t0.elapsed().as_millis()),
        }
    }
}
