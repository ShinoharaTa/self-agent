use anyhow::Result;
use async_trait::async_trait;
use serenity::all::{Context, EventHandler, GatewayIntents, Message as DiscordMessage, Ready};
use serenity::Client;
use tracing::info;

use self_agent_core::bus::MessageBus;
use self_agent_core::message::{AgentId, Message};

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
    fn is_mentioned(&self, msg: &DiscordMessage) -> bool {
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
    async fn message(&self, _ctx: Context, msg: DiscordMessage) {
        // Bot自身のメッセージは無視
        if msg.author.bot {
            return;
        }

        // メンション検出
        if self.is_mentioned(&msg) {
            info!(
                "Mentioned by {} in #{}: {}",
                msg.author.name, msg.channel_id, msg.content
            );

            let agent_msg = Message::request(
                AgentId::ChatBot,
                AgentId::Orchestrator,
                serde_json::json!({
                    "content": msg.content,
                    "author": msg.author.name,
                    "channel_id": msg.channel_id.to_string(),
                }),
            );

            if let Err(e) = self.bus.send(agent_msg).await {
                tracing::error!("Failed to send message to bus: {}", e);
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
