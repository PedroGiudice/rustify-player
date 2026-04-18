//! End-to-end CLI validator for the library indexer.
//!
//! Usage:
//!
//! ```text
//! cargo run -p library-indexer --example scan_folder --release -- \
//!     --music-root ~/Music \
//!     --db /tmp/rustify.db \
//!     --cache /tmp/rustify-cache
//! ```
//!
//! After the scan, you can query:
//!
//! ```text
//! --search "baco exu"        # top 20 FTS matches
//! --similar 42               # top 10 similarity to track id 42
//! --shuffle --genre 1 --limit 20   # shuffle tracks in genre 1
//! ```

use clap::Parser;
use library_indexer::{
    EmbedClient, Indexer, IndexerCommand, IndexerConfig, IndexerEvent, TrackFilter, TrackOrder,
};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Parser, Debug)]
#[command(about = "rustify-player library indexer CLI")]
struct Args {
    #[arg(long, default_value = "~/Music")]
    music_root: String,

    #[arg(long, default_value = "/tmp/rustify.db")]
    db: String,

    #[arg(long, default_value = "/tmp/rustify-cache")]
    cache: String,

    /// Base URL of the rustify-embed service. Omit to skip embedding.
    #[arg(long)]
    embed_url: Option<String>,

    /// Stop after the scan finishes; skip waiting on embeddings.
    #[arg(long)]
    no_wait_embed: bool,

    /// Wait for embeddings with this timeout (seconds). Ignored if
    /// --no-wait-embed.
    #[arg(long, default_value_t = 600)]
    embed_timeout_secs: u64,

    #[arg(long)]
    search: Option<String>,

    #[arg(long)]
    similar: Option<i64>,

    #[arg(long)]
    shuffle: bool,

    #[arg(long)]
    genre_id: Option<i64>,

    #[arg(long, default_value_t = 20)]
    limit: usize,

    #[arg(long, default_value = "info")]
    log_level: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| format!("library_indexer={},warn", args.log_level).into()),
        )
        .init();

    let music_root = expand_tilde(&args.music_root);
    let db_path = expand_tilde(&args.db);
    let cache_dir = expand_tilde(&args.cache);

    println!("[INFO] music_root: {}", music_root.display());
    println!("[INFO] db:         {}", db_path.display());
    println!("[INFO] cache:      {}", cache_dir.display());
    if let Some(url) = &args.embed_url {
        println!("[INFO] embed_url:  {}", url);
    } else {
        println!("[INFO] embed_url:  (disabled — tracks will be pending)");
    }
    println!();

    let config = IndexerConfig {
        db_path,
        music_root,
        cache_dir,
        embed_client: args.embed_url.as_deref().map(EmbedClient::new),
    };

    let indexer = Indexer::open(config)?;
    let rx = indexer.subscribe();

    // Event loop: render scan progress, then optionally wait for embeddings.
    let mut scan_done = false;
    let mut scan_summary: Option<(u64, u64, u64)> = None;
    let deadline = Instant::now() + Duration::from_secs(args.embed_timeout_secs);

    loop {
        let timeout = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or(Duration::ZERO);
        match rx.recv_timeout(timeout.min(Duration::from_secs(5))) {
            Ok(IndexerEvent::ScanStarted) => {
                println!("[SCAN] started");
            }
            Ok(IndexerEvent::ScanProgress { processed, total }) => {
                print!("\r[SCAN] {processed}/{total}");
                use std::io::Write;
                let _ = std::io::stdout().flush();
            }
            Ok(IndexerEvent::ScanDone { added, updated, removed }) => {
                println!(
                    "\n[SCAN] done: added={added} updated={updated} removed={removed}"
                );
                scan_done = true;
                scan_summary = Some((added, updated, removed));
                if args.no_wait_embed || args.embed_url.is_none() {
                    break;
                }
            }
            Ok(IndexerEvent::EmbeddingProgress { done, pending }) => {
                print!("\r[EMBED] done={done} pending={pending}  ");
                use std::io::Write;
                let _ = std::io::stdout().flush();
                if scan_done && pending == 0 {
                    println!();
                    break;
                }
            }
            Ok(IndexerEvent::EmbeddingDone { .. }) => {}
            Ok(IndexerEvent::TrackAdded(_))
            | Ok(IndexerEvent::TrackUpdated(_))
            | Ok(IndexerEvent::TrackRemoved(_)) => {}
            Ok(IndexerEvent::Error(msg)) => {
                eprintln!("\n[ERROR] {msg}");
            }
            Ok(_) => {}
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                if scan_done {
                    // No embeddings progress for a while — likely no embed
                    // URL, or service unreachable. Break on the outer deadline.
                    if Instant::now() >= deadline {
                        println!("\n[WARN] embed deadline hit; proceeding with partial state");
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }

    // Final summary
    println!();
    let snap = indexer.snapshot();
    println!("=== Summary ===");
    println!("tracks total:      {}", snap.tracks_total);
    println!("embeddings done:   {}", snap.embeddings_done);
    println!("embeddings pending:{}", snap.embeddings_pending);
    println!("embeddings failed: {}", snap.embeddings_failed);
    if let Some((a, u, r)) = scan_summary {
        println!("scan added/updated/removed: {a}/{u}/{r}");
    }

    let genres = indexer.list_genres()?;
    let populated: Vec<_> = genres
        .iter()
        .filter(|g| g.track_count.unwrap_or(0) > 0)
        .collect();
    println!();
    println!("Genres (populated):");
    for g in populated {
        println!("  [{:>3}] {:<30} {} tracks", g.id, g.name, g.track_count.unwrap_or(0));
    }

    // --- Optional query dumps ---------------------------------------------

    if let Some(q) = args.search {
        println!("\n=== Search: {q:?} ===");
        let results = indexer.search(&q, args.limit)?;
        println!("tracks: {}", results.tracks.len());
        for t in results.tracks.iter().take(args.limit) {
            println!(
                "  [{:>5}] {:<50} — {}",
                t.id,
                truncate(&t.title, 48),
                t.artist_name.as_deref().unwrap_or("?")
            );
        }
        println!("albums: {}", results.albums.len());
        for a in results.albums.iter().take(args.limit) {
            println!(
                "  [{:>5}] {:<50} — {}",
                a.id,
                truncate(&a.title, 48),
                a.album_artist_name.as_deref().unwrap_or("?")
            );
        }
        println!("artists: {}", results.artists.len());
        for a in results.artists.iter().take(args.limit) {
            println!("  [{:>5}] {}", a.id, a.name);
        }
    }

    if let Some(id) = args.similar {
        println!("\n=== Similar to track {id} ===");
        let results = indexer.similar(id, args.limit)?;
        if results.is_empty() {
            println!("(no results — anchor track has no embedding or none done)");
        }
        for (t, score) in results {
            println!(
                "  [{:>5}] score={:.3}  {:<40} — {}",
                t.id,
                score,
                truncate(&t.title, 38),
                t.artist_name.as_deref().unwrap_or("?")
            );
        }
    }

    if args.shuffle {
        println!("\n=== Shuffle (seed=42) ===");
        let filter = TrackFilter {
            genre_id: args.genre_id,
            order: TrackOrder::Random,
            limit: Some(args.limit),
            ..Default::default()
        };
        let tracks = indexer.shuffle(filter, 42, args.limit)?;
        for t in tracks {
            println!(
                "  [{:>5}] {:<50} — {}",
                t.id,
                truncate(&t.title, 48),
                t.artist_name.as_deref().unwrap_or("?")
            );
        }
    }

    let _ = indexer.send(IndexerCommand::Shutdown);
    Ok(())
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out = String::new();
        for (i, c) in s.chars().enumerate() {
            if i >= max - 1 {
                out.push('…');
                break;
            }
            out.push(c);
        }
        out
    }
}
