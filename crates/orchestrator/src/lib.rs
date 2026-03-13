use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use self_agent_core::bus::MessageBus;
use self_agent_core::error::Result;
use self_agent_core::message::{AgentId, Message, MessageKind};
use self_agent_core::Agent;

/// オーケストレーター: エージェント間のメッセージルーティングを管理
pub struct Orchestrator {
    bus: Option<MessageBus>,
    rx: Option<mpsc::Receiver<Message>>,
}

impl Orchestrator {
    pub fn new() -> Self {
        Self {
            bus: None,
            rx: None,
        }
    }

    /// メッセージループを実行する
    pub async fn run(&mut self) -> Result<()> {
        let bus = self.bus.clone().expect("Orchestrator not initialized");
        let mut rx = self.rx.take().expect("Orchestrator not initialized");

        info!("Orchestrator message loop started");

        while let Some(msg) = rx.recv().await {
            info!(
                "Orchestrator received message: id={}, from={}, kind={:?}",
                msg.id, msg.from, msg.kind
            );

            // handle_message で応答を生成し、必要に応じて転送
            match self.handle_message(msg).await {
                Ok(Some(response)) => {
                    if let Err(e) = bus.send(response).await {
                        warn!("Failed to send response: {}", e);
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    warn!("Error handling message: {}", e);
                }
            }
        }

        info!("Orchestrator message loop ended");
        Ok(())
    }
}

impl Default for Orchestrator {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Agent for Orchestrator {
    fn id(&self) -> AgentId {
        AgentId::Orchestrator
    }

    async fn init(&mut self, bus: MessageBus) -> Result<()> {
        let rx = bus.register(AgentId::Orchestrator).await;
        self.bus = Some(bus);
        self.rx = Some(rx);
        info!("Orchestrator initialized");
        Ok(())
    }

    async fn handle_message(&mut self, message: Message) -> Result<Option<Message>> {
        let bus = self.bus.as_ref().expect("Orchestrator not initialized");

        match &message.kind {
            MessageKind::Request | MessageKind::Response => {
                // 宛先が指定されている場合はそのエージェントに転送
                if message.to.is_some() {
                    debug!(
                        "Routing message {} -> {:?}",
                        message.from,
                        message.to
                    );
                    if let Err(e) = bus.send(message).await {
                        warn!("Failed to route message: {}", e);
                    }
                } else {
                    // 宛先なしのリクエストはブロードキャスト
                    debug!("Broadcasting request from {}", message.from);
                    if let Err(e) = bus.broadcast(message).await {
                        warn!("Failed to broadcast message: {}", e);
                    }
                }
            }
            MessageKind::Notification | MessageKind::Event => {
                // 通知・イベントはブロードキャスト
                debug!("Broadcasting notification/event from {}", message.from);
                if let Err(e) = bus.broadcast(message).await {
                    warn!("Failed to broadcast message: {}", e);
                }
            }
            MessageKind::Error => {
                warn!(
                    "Error message received from {}: {}",
                    message.from, message.payload
                );
            }
        }

        Ok(None)
    }

    fn tick_interval(&self) -> Option<Duration> {
        Some(Duration::from_secs(60))
    }

    async fn tick(&mut self) -> Result<()> {
        debug!("Orchestrator health check: OK");
        Ok(())
    }

    async fn shutdown(&mut self) -> Result<()> {
        info!("Orchestrator shutting down");
        if let Some(bus) = &self.bus {
            bus.unregister(&AgentId::Orchestrator).await;
        }
        Ok(())
    }
}
