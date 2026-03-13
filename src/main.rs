use anyhow::Result;
use serde::Deserialize;
use tracing::info;

use self_agent_core::bus::MessageBus;

/// アプリケーション設定
#[derive(Debug, Deserialize)]
struct Config {
    discord: DiscordConfig,
    storage: StorageConfig,
    #[allow(dead_code)]
    reaction: ReactionConfig,
}

#[derive(Debug, Deserialize)]
struct DiscordConfig {
    token: String,
}

#[derive(Debug, Deserialize)]
struct StorageConfig {
    sqlite_path: String,
}

#[derive(Debug, Deserialize)]
struct ReactionConfig {
    #[allow(dead_code)]
    mode: String,
}

fn load_config() -> Result<Config> {
    let config_str = std::fs::read_to_string("config/default.toml")?;
    let config: Config = toml::from_str(&config_str)?;
    Ok(config)
}

#[tokio::main]
async fn main() -> Result<()> {
    // ログ初期化
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    info!("self-agent starting...");

    // 設定読み込み
    let config = load_config()?;
    info!("Config loaded: storage={}", config.storage.sqlite_path);

    // メッセージバス初期化
    let bus = MessageBus::new(256);
    info!("Message bus initialized");

    // ストレージ初期化
    let _db = self_agent_storage::Database::open(&config.storage.sqlite_path)?;
    info!("Database initialized");

    // オーケストレーター起動
    let orchestrator = self_agent_orchestrator::Orchestrator::new(bus.clone());
    let orchestrator_handle = tokio::spawn(async move {
        use self_agent_core::Agent;
        if let Err(e) = orchestrator.start().await {
            tracing::error!("Orchestrator error: {}", e);
        }
    });

    // Discord Bot起動
    let discord_bus = bus.clone();
    let discord_token = config.discord.token.clone();
    let discord_handle = tokio::spawn(async move {
        if let Err(e) = self_agent_chat_bot::discord::start_bot(&discord_token, discord_bus).await
        {
            tracing::error!("Discord bot error: {}", e);
        }
    });

    info!("All agents started. Press Ctrl+C to shutdown.");

    // シャットダウン待機
    tokio::signal::ctrl_c().await?;
    info!("Shutdown signal received");

    orchestrator_handle.abort();
    discord_handle.abort();

    info!("self-agent shutdown complete");
    Ok(())
}
