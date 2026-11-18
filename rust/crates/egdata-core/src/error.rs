//! Core error types for egdata-core.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("{0}")]
    InvalidInput(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Internal(String),
    #[error("{0}")]
    Upstream(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display() {
        assert_eq!(CoreError::InvalidInput("bad".into()).to_string(), "bad");
        assert_eq!(CoreError::NotFound("missing".into()).to_string(), "missing");
        assert_eq!(CoreError::Internal("boom".into()).to_string(), "boom");
        assert_eq!(
            CoreError::Upstream("upstream".into()).to_string(),
            "upstream"
        );
    }
}
