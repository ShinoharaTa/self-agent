use anyhow::Result;
use async_trait::async_trait;
use serenity::all::{Context, EventHandler, GatewayIntents, Message, Ready};
use serenity::Client;
use tracing::info;

use self_agent_core::bus::MessageBus;
use self_agent_core::message::{Message as AgentMessage, MessageKind};

/// Discord Bot ハンドラー
pub struct DiscordHandler {
    bus: MessageBus,
    bot_user_id: std::sync::RwLock<Option<u64>>,
}

impl DiscordHandler {
    pub fn new(bus: MessageBus) -> Self {
        Self {
            bus,
            bot_user_id: std::sync::RwLock::new(None),
        }
    }

    /// メッセージがBotへのメンションを含むか判定する
    fn is_mentioned(&self, msg: &Message) -> bool {
        let bot_id = self.bot_user_id.read().unwrap();
        if let Some(id) = *bot_id {
            msg.mentions.iter().any(|u| u.id.get() == id)
        } else {
            false
        }
    }
}

#[async_trait]
impl EventHandler for DiscordHandler {
    async fn message(&self, _ctx: Context, msg: Message) {
        // Bot自身のメッセージは無視
        if msg.author.bot {
            return;
        }

        // メンション検出
        if self.is_mentioned(&msg) {
            info!(
                "Mentioned by {} in #{}: {}",
                msg.author.name,
                msg.channel_id,
                msg.content
            );

            let agent_msg = AgentMessage {
                from: "chat-bot".to_string(),
                to: None,
                kind: MessageKind::ChatInput,
                payload: serde_json::to_string(&serde_json::json!({
                    "content": msg.content,
                    "author": msg.author.name,
                    "channel_id": msg.channel_id.to_string(),
                }))
                .unwrap_or_default(),
            };

            if let Err(e) = self.bus.publish(agent_msg) {
                tracing::error!("Failed to publish message to bus: {}", e);
            }
        }
    }

    async fn ready(&self, _ctx: Context, ready: Ready) {
        info!("Discord bot connected as {}", ready.user.name);
        let mut bot_id = self.bot_user_id.write().unwrap();
        *bot_id = Some(ready.user.id.get());
    }
}

/// Discord Botを起動する
pub async fn start_bot(token: &str, bus: MessageBus) -> Result<()> {
    let intents = GatewayIntents::GUILD_MESSAGES
        | GatewayIntents::MESSAGE_CONTENT
        | GatewayIntents::DIRECT_MESSAGES;

    let handler = DiscordHandler::new(bus);

    let mut client = Client::builder(token, intents)
        .event_handler(handler)
        .await?;

    client.start().await?;
    Ok(())
}
