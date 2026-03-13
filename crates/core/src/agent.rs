use std::time::Duration;

use async_trait::async_trait;

use crate::bus::MessageBus;
use crate::error::Result;
use crate::message::{AgentId, Message};

/// すべてのエージェントが実装するトレイト
#[async_trait]
pub trait Agent: Send + Sync {
    /// エージェントのID
    fn id(&self) -> AgentId;

    /// 初期化処理
    async fn init(&mut self, bus: MessageBus) -> Result<()>;

    /// メッセージを処理する
    async fn handle_message(&mut self, message: Message) -> Result<Option<Message>>;

    /// 定期処理の間隔 (None = 定期処理なし)
    fn tick_interval(&self) -> Option<Duration> {
        None
    }

    /// 定期処理
    async fn tick(&mut self) -> Result<()> {
        Ok(())
    }

    /// シャットダウン処理
    async fn shutdown(&mut self) -> Result<()> {
        Ok(())
    }
}
