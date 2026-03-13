use tokio::sync::broadcast;
use tracing::info;

use crate::message::Message;

/// エージェント間のメッセージバス (broadcast channel ベース)
#[derive(Debug)]
pub struct MessageBus {
    sender: broadcast::Sender<Message>,
}

impl MessageBus {
    /// 新しいメッセージバスを作成する
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        info!("MessageBus initialized with capacity {}", capacity);
        Self { sender }
    }

    /// メッセージを送信する
    pub fn publish(&self, message: Message) -> anyhow::Result<()> {
        self.sender
            .send(message)
            .map_err(|e| anyhow::anyhow!("Failed to publish message: {}", e))?;
        Ok(())
    }

    /// 新しいレシーバーを取得する
    pub fn subscribe(&self) -> broadcast::Receiver<Message> {
        self.sender.subscribe()
    }
}

impl Clone for MessageBus {
    fn clone(&self) -> Self {
        Self {
            sender: self.sender.clone(),
        }
    }
}
