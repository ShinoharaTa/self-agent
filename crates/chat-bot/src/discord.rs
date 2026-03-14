use std::sync::{Arc, Mutex};

use anyhow::Result;
use async_trait::async_trait;
use serenity::all::{
    ChannelId, Context, EventHandler, GatewayIntents, GetMessages, Message as DiscordMessage,
    Ready,
};
use serenity::Client;
use tokio::sync::{mpsc, RwLock};
use tracing::{error, info, warn};

use self_agent_core::bus::MessageBus;
use self_agent_core::message::{AgentId, Message};
use self_agent_storage::Database;

/// DiscordHandler と response_listener が共有する状態
struct SharedState {
    /// serenity の HTTP クライアント (Ready イベントで設定される)
    http: RwLock<Option<Arc<serenity::http::Http>>>,
    /// Bot 自身のユーザー ID (Ready イベントで設定される)
    bot_user_id: RwLock<Option<u64>>,
    /// エージェント間メッセージバス
    bus: MessageBus,
    /// 会話ログ保存用 DB (Mutex で Sync を確保)
    db: Option<Mutex<Database>>,
}

/// Discord Bot ハンドラー
pub struct DiscordHandler {
    state: Arc<SharedState>,
}

impl DiscordHandler {
    fn new(state: Arc<SharedState>) -> Self {
        Self { state }
    }

    /// 会話をDBにログ保存する
    fn log_message(
        &self,
        platform: &str,
        server_id: &str,
        channel_id: &str,
        author: &str,
        content: &str,
    ) {
        if let Some(db_mutex) = &self.state.db {
            match db_mutex.lock() {
                Ok(db) => {
                    if let Err(e) =
                        db.log_conversation(platform, server_id, channel_id, author, content)
                    {
                        warn!("Failed to log conversation: {}", e);
                    }
                }
                Err(e) => {
                    warn!("Failed to acquire DB lock: {}", e);
                }
            }
        }
    }
}

#[async_trait]
impl EventHandler for DiscordHandler {
    async fn message(&self, ctx: Context, msg: DiscordMessage) {
        // Bot自身のメッセージは無視
        if msg.author.bot {
            return;
        }

        let server_id = msg
            .guild_id
            .map(|id| id.to_string())
            .unwrap_or_default();
        let channel_id_str = msg.channel_id.to_string();

        // 全メッセージをログに保存
        self.log_message(
            "discord",
            &server_id,
            &channel_id_str,
            &msg.author.name,
            &msg.content,
        );

        // メンション検出
        let is_mentioned = {
            let bot_id = self.state.bot_user_id.read().await;
            bot_id
                .map(|id| msg.mentions.iter().any(|u| u.id.get() == id))
                .unwrap_or(false)
        };

        if is_mentioned {
            info!(
                "Mentioned by {} in #{}: {}",
                msg.author.name, msg.channel_id, msg.content
            );

            // 前後の会話コンテキストを取得
            let context = {
                let builder = GetMessages::new().before(msg.id).limit(10);
                match msg.channel_id.messages(&ctx.http, builder).await {
                    Ok(messages) => messages
                        .iter()
                        .rev()
                        .filter(|m| !m.author.bot)
                        .map(|m| format!("{}: {}", m.author.name, m.content))
                        .collect::<Vec<_>>()
                        .join("\n"),
                    Err(e) => {
                        warn!("Failed to get channel context: {}", e);
                        String::new()
                    }
                }
            };

            // メッセージバスに送信
            let agent_msg = Message::request(
                AgentId::ChatBot,
                AgentId::Orchestrator,
                serde_json::json!({
                    "content": msg.content,
                    "author": msg.author.name,
                    "channel_id": channel_id_str,
                    "server_id": server_id,
                    "message_id": msg.id.to_string(),
                    "context": context,
                }),
            );

            if let Err(e) = self.state.bus.send(agent_msg).await {
                error!("Failed to send message to bus: {}", e);
            }
        }
    }

    async fn ready(&self, ctx: Context, ready: Ready) {
        info!("Discord bot connected as {}", ready.user.name);
        *self.state.bot_user_id.write().await = Some(ready.user.id.get());
        *self.state.http.write().await = Some(ctx.http.clone());
    }
}

/// メッセージバスからの応答をDiscordに送信するリスナータスク
async fn response_listener(mut rx: mpsc::Receiver<Message>, state: Arc<SharedState>) {
    info!("Discord response listener started");
    while let Some(msg) = rx.recv().await {
        let text = match msg.payload.get("text").and_then(|v| v.as_str()) {
            Some(t) => t.to_string(),
            None => continue,
        };
        let channel_id_str = match msg.payload.get("channel_id").and_then(|v| v.as_str()) {
            Some(c) => c.to_string(),
            None => continue,
        };
        let channel_id = match channel_id_str.parse::<u64>() {
            Ok(id) => ChannelId::new(id),
            Err(_) => {
                warn!("Invalid channel_id: {}", channel_id_str);
                continue;
            }
        };

        let http = state.http.read().await;
        if let Some(http_client) = http.as_ref() {
            match channel_id.say(http_client, &text).await {
                Ok(_) => info!("Response sent to Discord #{}", channel_id_str),
                Err(e) => error!("Failed to send to Discord: {}", e),
            }
        } else {
            warn!("HTTP client not ready, dropping message");
        }
    }
}

/// Discord Botを起動する
pub async fn start_bot(token: &str, bus: MessageBus, db: Option<Database>) -> Result<()> {
    // ChatBot のチャネルを登録してレスポンスリスナーを起動
    let chatbot_rx = bus.register(AgentId::ChatBot).await;

    let state = Arc::new(SharedState {
        http: RwLock::new(None),
        bot_user_id: RwLock::new(None),
        bus,
        db: db.map(Mutex::new),
    });

    // レスポンスリスナーをバックグラウンドタスクとして起動
    let listener_state = state.clone();
    tokio::spawn(async move {
        response_listener(chatbot_rx, listener_state).await;
    });

    // Discord Bot 起動
    let intents = GatewayIntents::GUILD_MESSAGES
        | GatewayIntents::MESSAGE_CONTENT
        | GatewayIntents::DIRECT_MESSAGES;

    let handler = DiscordHandler::new(state);

    let mut client = Client::builder(token, intents)
        .event_handler(handler)
        .await?;

    client.start().await?;
    Ok(())
}
