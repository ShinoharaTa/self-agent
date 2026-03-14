use std::sync::Arc;

use anyhow::Result;
use tracing::info;

use self_agent_config::AppConfig;
use self_agent_core::bus::MessageBus;
use self_agent_core::Agent;
use self_agent_llm_client::anthropic::AnthropicProvider;
use self_agent_llm_client::provider::LlmProvider;
use self_agent_storage::{Database, MemoryStore};

mod setup;

#[tokio::main]
async fn main() -> Result<()> {
    // --setup フラグの検出
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--setup" || a == "setup") {
        return setup::run_setup().await;
    }

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
    let config_db = Database::open(&config.storage.sqlite_path)?;
    let memory = MemoryStore::new(&config.storage.memory_path)?;
    info!("Storage initialized (SQLite + MemoryStore)");

    // MemoryStore: グローバル記憶の初期化
    if memory.load_global()?.is_empty() {
        memory.save_global("# Global Memory\n\nself-agent のグローバル記憶。\n")?;
    }

    // クレデンシャル解決: DB → 環境変数 → config.toml の優先順
    let llm_api_key = config_db
        .get_config("anthropic_api_key")?
        .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
        .or_else(|| {
            let key = &config.llm.api_key;
            if !key.is_empty() && key != "YOUR_API_KEY" {
                Some(key.clone())
            } else {
                None
            }
        });

    let discord_token = config_db
        .get_config("discord_token")?
        .or_else(|| std::env::var("DISCORD_TOKEN").ok())
        .or_else(|| {
            let token = &config.discord.token;
            if !token.is_empty() && token != "YOUR_DISCORD_BOT_TOKEN" {
                Some(token.clone())
            } else {
                None
            }
        });

    // config_db は設定読み出し専用なのでここで閉じる
    drop(config_db);

    // Orchestrator用DB（Mutex wrapped）
    let db = Arc::new(std::sync::Mutex::new(
        Database::open(&config.storage.sqlite_path)?,
    ));

    // LLM初期化
    let llm: Option<Arc<dyn LlmProvider>> = if let Some(key) = llm_api_key {
        info!(
            "LLM initialized: provider={}, model={}",
            config.llm.provider, config.llm.model
        );
        Some(Arc::new(
            AnthropicProvider::new(key).with_model(config.llm.model.clone()),
        ))
    } else {
        info!("LLM not configured, running in echo mode");
        info!("Run with --setup to configure");
        None
    };

    // Orchestrator初期化・起動
    let mut orchestrator = self_agent_orchestrator::Orchestrator::new();
    if let Some(llm) = llm {
        orchestrator = orchestrator.with_llm(llm);
    }
    orchestrator = orchestrator.with_db(db.clone());
    orchestrator
        .init(bus.clone())
        .await
        .map_err(|e| anyhow::anyhow!("{}", e))?;

    let orchestrator_handle = tokio::spawn(async move {
        if let Err(e) = orchestrator.run().await {
            tracing::error!("Orchestrator error: {}", e);
        }
    });

    // Discord Bot起動
    let discord_handle = if let Some(token) = discord_token {
        let chat_db = Database::open(&config.storage.sqlite_path)?;
        let discord_bus = bus.clone();
        Some(tokio::spawn(async move {
            if let Err(e) =
                self_agent_chat_bot::discord::start_bot(&token, discord_bus, Some(chat_db)).await
            {
                tracing::error!("Discord bot error: {}", e);
            }
        }))
    } else {
        info!("Discord not configured, skipping bot startup");
        info!("Run with --setup to configure");
        None
    };

    info!("self-agent started. Press Ctrl+C to shutdown.");

    // シャットダウン待機
    tokio::signal::ctrl_c().await?;
    info!("Shutdown signal received");

    orchestrator_handle.abort();
    if let Some(handle) = discord_handle {
        handle.abort();
    }

    info!("self-agent shutdown complete");
    Ok(())
}
