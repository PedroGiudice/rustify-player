use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

pub struct QdrantProcess {
    child: Child,
}

impl QdrantProcess {
    pub fn spawn(data_dir: &Path) -> Option<Self> {
        let binary = find_qdrant_binary()?;
        let storage_path = data_dir.join("qdrant_storage");
        std::fs::create_dir_all(&storage_path).ok()?;

        tracing::info!(
            binary = %binary.display(),
            storage = %storage_path.display(),
            "spawning Qdrant sidecar"
        );

        let child = Command::new(&binary)
            .arg("--storage-path")
            .arg(&storage_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                tracing::warn!(?e, "failed to spawn Qdrant binary");
                e
            })
            .ok()?;

        let proc = Self { child };
        if !proc.wait_healthy(Duration::from_secs(10)) {
            tracing::warn!("Qdrant did not become healthy within 10s — continuing anyway");
        }
        Some(proc)
    }

    fn wait_healthy(&self, timeout: Duration) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            if ureq::get("http://localhost:6333/healthz").call().is_ok() {
                tracing::info!("Qdrant healthy after {:?}", start.elapsed());
                return true;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        false
    }

    pub fn kill(&mut self) {
        tracing::info!("shutting down Qdrant sidecar");
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for QdrantProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

fn find_qdrant_binary() -> Option<PathBuf> {
    // 1. Environment variable override (dev/testing)
    if let Ok(path) = std::env::var("QDRANT_BINARY") {
        let p = PathBuf::from(&path);
        if p.exists() {
            return Some(p);
        }
    }

    // 2. Tauri bundled externalBin — sits next to the app executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("qdrant");
            if p.exists() {
                return Some(p);
            }
        }
    }

    // 3. System PATH
    if let Ok(output) = Command::new("which").arg("qdrant").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }

    tracing::info!("Qdrant binary not found — recommendations will use brute-force fallback");
    None
}
