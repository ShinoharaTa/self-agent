use anyhow::Result;
use async_trait::async_trait;

use crate::message::Message;

/// すべてのエージェントが実装するトレイト
#[async_trait]
pub trait Agent: Send + Sync {
    /// エージェント名を返す
    fn name(&self) -> &str;

    /// エージェントを起動する
    async fn start(&self) -> Result<()>;

    /// メッセージを処理する
    async fn handle_message(&self, message: Message) -> Result<()>;
}
