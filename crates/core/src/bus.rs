use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{mpsc, RwLock};
use tracing::{debug, info, warn};

use crate::error::CoreError;
use crate::message::{AgentId, Message};

/// エージェント間のメッセージバス (mpsc channel ベース)
#[derive(Clone)]
pub struct MessageBus {
    inner: Arc<RwLock<MessageBusInner>>,
}

struct MessageBusInner {
    agents: HashMap<AgentId, mpsc::Sender<Message>>,
    default_buffer_size: usize,
}

impl MessageBus {
    /// 新しいメッセージバスを作成する
    pub fn new(default_buffer_size: usize) -> Self {
        info!("MessageBus initialized (buffer_size={})", default_buffer_size);
        Self {
            inner: Arc::new(RwLock::new(MessageBusInner {
                agents: HashMap::new(),
                default_buffer_size,
            })),
        }
    }

    /// エージェントを登録し、受信用Receiverを返す
    pub async fn register(&self, id: AgentId) -> mpsc::Receiver<Message> {
        let inner = self.inner.read().await;
        let buffer_size = inner.default_buffer_size;
        drop(inner);
        self.register_with_buffer(id, buffer_size).await
    }

    /// バッファサイズを指定してエージェントを登録
    pub async fn register_with_buffer(
        &self,
        id: AgentId,
        buffer_size: usize,
    ) -> mpsc::Receiver<Message> {
        let (tx, rx) = mpsc::channel(buffer_size);
        let mut inner = self.inner.write().await;
        info!("Agent registered: {} (buffer={})", id, buffer_size);
        inner.agents.insert(id, tx);
        rx
    }

    /// エージェントを登録解除
    pub async fn unregister(&self, id: &AgentId) {
        let mut inner = self.inner.write().await;
        inner.agents.remove(id);
        info!("Agent unregistered: {}", id);
    }

    /// メッセージを送信（宛先指定）
    pub async fn send(&self, msg: Message) -> std::result::Result<(), CoreError> {
        let inner = self.inner.read().await;
        if let Some(to) = &msg.to {
            if let Some(tx) = inner.agents.get(to) {
                debug!("Sending message {} -> {}", msg.from, to);
                tx.send(msg)
                    .await
                    .map_err(|e| CoreError::Bus(format!("send failed: {}", e)))?;
            } else {
                warn!("Agent not found: {}", to);
                return Err(CoreError::AgentNotFound(to.to_string()));
            }
        } else {
            // broadcast
            self.broadcast_inner(&inner, msg).await?;
        }
        Ok(())
    }

    /// 全エージェントにブロードキャスト
    pub async fn broadcast(&self, msg: Message) -> std::result::Result<(), CoreError> {
        let inner = self.inner.read().await;
        self.broadcast_inner(&inner, msg).await
    }

    async fn broadcast_inner(
        &self,
        inner: &MessageBusInner,
        msg: Message,
    ) -> std::result::Result<(), CoreError> {
        debug!("Broadcasting message from {}", msg.from);
        for (id, tx) in &inner.agents {
            if *id != msg.from {
                if let Err(e) = tx.send(msg.clone()).await {
                    warn!("Failed to send to {}: {}", id, e);
                }
            }
        }
        Ok(())
    }
}

impl std::fmt::Debug for MessageBus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MessageBus").finish()
    }
}
