//! Error types for the library indexer.

use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum IndexerError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("failed to walk music root: {0}")]
    Walk(#[from] walkdir::Error),

    #[error("metadata parse failed for {path:?}: {message}")]
    Metadata { path: PathBuf, message: String },

    #[error("cover art processing failed: {0}")]
    CoverArt(String),

    #[error("embedding failed: {0}")]
    Embedding(String),

    #[error("ONNX runtime error: {0}")]
    Onnx(String),

    #[error("model download failed: {0}")]
    ModelDownload(String),

    #[error("model unavailable: {0}")]
    ModelUnavailable(String),

    #[error("fs watcher error: {0}")]
    Watcher(#[from] notify::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("indexer shutdown")]
    Shutdown,
}

impl From<symphonia::core::errors::Error> for IndexerError {
    fn from(err: symphonia::core::errors::Error) -> Self {
        IndexerError::Metadata {
            path: PathBuf::new(),
            message: err.to_string(),
        }
    }
}

impl From<image::ImageError> for IndexerError {
    fn from(err: image::ImageError) -> Self {
        IndexerError::CoverArt(err.to_string())
    }
}
