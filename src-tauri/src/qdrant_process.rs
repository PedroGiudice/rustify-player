use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

pub struct QdrantProcess {
    child: Child,
}

impl QdrantProcess {
    /// Spawn the Qdrant binary. Returns `None` if binary not found or fails to start.
    /// Graceful degradation: absence of the binary is not an error.
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

        // Wait for Qdrant to become healthy (up to 10s). Slow start doesn't
        // abort: the process is running, just not yet accepting connections.
        if !proc.wait_healthy(Duration::from_secs(10)) {
            tracing::warn!("Qdrant did not become healthy within 10s — continuing anyway");
        }

        Some(proc)
    }

    fn wait_healthy(&self, timeout: Duration) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < timeout {
            if ureq::get("http://localhost:6333/healthz")
                .call()
                .is_ok()
            {
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
    // 1. Environment variable override
    if let Ok(path) = std::env::var("QDRANT_BINARY") {
        let p = PathBuf::from(&path);
        if p.exists() {
            return Some(p);
        }
    }

    // 2. ~/.local/share/rustify-player/qdrant/qdrant
    let home = std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/home"));
    {
        let p = home
            .join(".local")
            .join("share")
            .join("rustify-player")
            .join("qdrant")
            .join("qdrant");
        if p.exists() {
            return Some(p);
        }
    }

    // 3. ~/.local/bin/qdrant
    {
        let p = home.join(".local").join("bin").join("qdrant");
        if p.exists() {
            return Some(p);
        }
    }

    // 4. System PATH via `which`
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
