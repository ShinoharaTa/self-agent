use anyhow::Result;
use async_trait::async_trait;
use tracing::info;

use self_agent_core::bus::MessageBus;
use self_agent_core::message::Message;
use self_agent_core::Agent;

/// オーケストレーター: エージェント間のメッセージルーティングを管理
pub struct Orchestrator {
    bus: MessageBus,
}

impl Orchestrator {
    pub fn new(bus: MessageBus) -> Self {
        Self { bus }
    }
}

#[async_trait]
impl Agent for Orchestrator {
    fn name(&self) -> &str {
        "orchestrator"
    }

    async fn start(&self) -> Result<()> {
        info!("Orchestrator started");
        let mut rx = self.bus.subscribe();

        loop {
            match rx.recv().await {
                Ok(msg) => {
                    info!(
                        "Orchestrator received message from '{}': {:?}",
                        msg.from, msg.kind
                    );
                    // TODO: メッセージルーティングロジックを実装
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("Orchestrator lagged behind by {} messages", n);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    info!("Message bus closed, shutting down orchestrator");
                    break;
                }
            }
        }

        Ok(())
    }

    async fn handle_message(&self, message: Message) -> Result<()> {
        info!(
            "Orchestrator handling message from '{}': {:?}",
            message.from, message.kind
        );
        // TODO: メッセージ種別に応じたルーティング
        Ok(())
    }
}
