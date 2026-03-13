use anyhow::Result;
use tracing::info;

use self_agent_config::AppConfig;
use self_agent_core::bus::MessageBus;
use self_agent_core::message::AgentId;
use self_agent_core::Agent;
use self_agent_storage::{Database, MemoryStore};

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
    let config = AppConfig::load("config/default.toml")?;
    info!(
        "Config loaded: storage={}, memory={}",
        config.storage.sqlite_path, config.storage.memory_path
    );

    // メッセージバス初期化
    let bus = MessageBus::new(config.agents.bus_buffer_size);

    // ストレージ初期化
    let db = Database::open(&config.storage.sqlite_path)?;
    let memory = MemoryStore::new(&config.storage.memory_path)?;
    info!("Storage initialized (SQLite + MemoryStore)");

    // TaskManager初期化
    let _task_manager = self_agent_task_manager::TaskManager::new(db);
    info!("TaskManager initialized");

    // MemoryStore: グローバル記憶の初期化（存在しない場合）
    if memory.load_global()?.is_empty() {
        memory.save_global("# Global Memory\n\nself-agent のグローバル記憶。\n")?;
    }

    // オーケストレーター初期化・起動
    let mut orchestrator = self_agent_orchestrator::Orchestrator::new();
    orchestrator
        .init(bus.clone())
        .await
        .map_err(|e| anyhow::anyhow!("{}", e))?;

    let orchestrator_handle = tokio::spawn(async move {
        if let Err(e) = orchestrator.run().await {
            tracing::error!("Orchestrator error: {}", e);
        }
    });

    // ChatBot をメッセージバスに登録
    let _chatbot_rx = bus.register(AgentId::ChatBot).await;

    // Discord Bot起動
    let discord_bus = bus.clone();
    let discord_token = config.discord.token.clone();
    let discord_handle = tokio::spawn(async move {
        if let Err(e) =
            self_agent_chat_bot::discord::start_bot(&discord_token, discord_bus).await
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
