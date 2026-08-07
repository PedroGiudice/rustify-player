//! Erros do cliente slskd.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SlskdError {
    #[error("http error: status {0}")]
    Http(u16),

    #[error("unauthorized")]
    Unauthorized,

    #[error("conflict (409)")]
    Conflict409,

    #[error("network error: {0}")]
    Network(String),

    #[error("parse error: {0}")]
    Parse(String),
}
