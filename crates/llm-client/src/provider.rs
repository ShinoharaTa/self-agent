use async_trait::async_trait;
use anyhow::Result;

use crate::types::{ChatMessage, ChatOptions, ChatResponse};

/// LLMプロバイダーの抽象トレイト
#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// プロバイダー名
    fn name(&self) -> &str;

    /// チャットリクエストを送信
    async fn chat(&self, messages: &[ChatMessage], options: &ChatOptions) -> Result<ChatResponse>;
}
