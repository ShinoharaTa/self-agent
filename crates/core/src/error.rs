use thiserror::Error;

#[derive(Error, Debug)]
pub enum CoreError {
    #[error("message bus error: {0}")]
    Bus(String),
    #[error("agent not found: {0}")]
    AgentNotFound(String),
    #[error("message timeout: correlation_id={0}")]
    Timeout(String),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub type Result<T> = std::result::Result<T, CoreError>;
