//! ステップバイステップの初期セットアップウィザード
//!
//! OpenClawを参考に、各機能を個別にセットアップ・テストできるフローを提供する。
//! `self-agent --setup` で起動。

use anyhow::Result;
use std::io::{self, Write};

use self_agent_config::AppConfig;
use self_agent_llm_client::provider::LlmProvider;

/// セットアップウィザードのメインエントリ
pub async fn run_setup() -> Result<()> {
    println!();
    println!("╔══════════════════════════════════════════╗");
    println!("║       self-agent セットアップ            ║");
    println!("╚══════════════════════════════════════════╝");
    println!();
    println!("各機能をステップバイステップで設定します。");
    println!("スキップしたい項目は Enter で飛ばせます。");
    println!();

    // 既存設定を読み込む（あれば）
    let existing_config = AppConfig::load("config/default.toml").ok();

    // Step 1: ストレージ
    println!("━━━ Step 1/4: ストレージ ━━━");
    setup_storage().await?;

    // Step 2: LLM
    println!();
    println!("━━━ Step 2/4: LLM (Claude API) ━━━");
    setup_llm(&existing_config).await?;

    // Step 3: Discord
    println!();
    println!("━━━ Step 3/4: Discord Bot ━━━");
    setup_discord(&existing_config).await?;

    // Step 4: 確認
    println!();
    println!("━━━ Step 4/4: 設定確認 ━━━");
    verify_setup().await?;

    println!();
    println!("セットアップ完了！ `cargo run` で起動できます。");
    println!();

    Ok(())
}

/// ストレージのセットアップ
async fn setup_storage() -> Result<()> {
    println!("SQLiteデータベースとMemoryStoreを初期化します。");

    let config = load_or_default_config();
    let db_path = &config.storage.sqlite_path;
    let mem_path = &config.storage.memory_path;

    // ディレクトリ作成
    if let Some(parent) = std::path::Path::new(db_path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::create_dir_all(mem_path)?;

    // DB初期化テスト
    let db = self_agent_storage::Database::open(db_path)?;
    println!("  [OK] SQLite: {}", db_path);

    let memory = self_agent_storage::MemoryStore::new(mem_path)?;
    if memory.load_global()?.is_empty() {
        memory.save_global("# Global Memory\n\nself-agent のグローバル記憶。\n")?;
    }
    println!("  [OK] MemoryStore: {}", mem_path);

    // テストタスク作成して確認
    let test_task = self_agent_storage::CreateTask {
        title: "セットアップテスト".to_string(),
        description: Some("セットアップウィザードからのテストタスク".to_string()),
        priority: None,
        due_date: None,
        source_context: None,
        source_channel: None,
        source_server: None,
    };
    let task_id = db.create_task(&test_task)?;
    db.delete_task(task_id)?;
    println!("  [OK] タスクの作成・削除テスト成功");

    drop(db);
    Ok(())
}

/// LLMのセットアップ
async fn setup_llm(existing: &Option<AppConfig>) -> Result<()> {
    let current_key = existing
        .as_ref()
        .map(|c| c.llm.api_key.clone())
        .unwrap_or_default();

    let has_env_key = std::env::var("ANTHROPIC_API_KEY").is_ok();

    if has_env_key {
        println!("  環境変数 ANTHROPIC_API_KEY が設定されています。");
    } else if !current_key.is_empty() && current_key != "" {
        println!("  config/default.toml にAPIキーが設定されています。");
    } else {
        println!("  Claude APIキーが未設定です。");
        println!("  以下のいずれかで設定してください:");
        println!("    1. 環境変数: export ANTHROPIC_API_KEY=sk-ant-...");
        println!("    2. config/default.toml の [llm] セクションに api_key を設定");
        println!();
    }

    // APIキーがあれば接続テスト
    let api_key = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .or_else(|| {
            if !current_key.is_empty() {
                Some(current_key.clone())
            } else {
                None
            }
        });

    if let Some(key) = api_key {
        if key.is_empty() || key == "YOUR_API_KEY" {
            println!("  [SKIP] APIキーが未設定のためテストをスキップ");
            println!("  → LLMなしでも基本機能（タスク管理）は動作します");
            return Ok(());
        }

        print!("  接続テスト中...");
        io::stdout().flush()?;

        let provider = self_agent_llm_client::anthropic::AnthropicProvider::new(key);
        let messages = vec![self_agent_llm_client::types::ChatMessage::user(
            "テスト。「OK」とだけ返してください。",
        )];
        let options = self_agent_llm_client::types::ChatOptions {
            max_tokens: Some(16),
            ..Default::default()
        };

        match provider.chat(&messages, &options).await {
            Ok(resp) => {
                println!(
                    "\r  [OK] Claude API 接続成功 (model={}, tokens={}/{})",
                    resp.model, resp.usage.input_tokens, resp.usage.output_tokens
                );
            }
            Err(e) => {
                println!("\r  [NG] Claude API 接続失敗: {}", e);
                println!("  → APIキーを確認してください");
                println!("  → LLMなしでも基本機能は動作します");
            }
        }
    } else {
        println!("  [SKIP] APIキー未設定。LLMなしモードで動作します。");
        println!("  → タスクの手動追加・一覧は使えます");
    }

    Ok(())
}

/// Discordのセットアップ
async fn setup_discord(existing: &Option<AppConfig>) -> Result<()> {
    let current_token = existing
        .as_ref()
        .map(|c| c.discord.token.clone())
        .unwrap_or_default();

    let has_env_token = std::env::var("DISCORD_TOKEN").is_ok();

    if has_env_token {
        println!("  環境変数 DISCORD_TOKEN が設定されています。");
    } else if !current_token.is_empty()
        && current_token != "YOUR_DISCORD_BOT_TOKEN"
    {
        println!("  config/default.toml にトークンが設定されています。");
    } else {
        println!("  Discord Botトークンが未設定です。");
        println!();
        println!("  セットアップ手順:");
        println!("    1. https://discord.com/developers/applications にアクセス");
        println!("    2. 「New Application」でアプリを作成");
        println!("    3. Bot タブ → 「Reset Token」でトークンを取得");
        println!("    4. Bot タブ → Privileged Gateway Intents:");
        println!("       - MESSAGE CONTENT INTENT を有効化");
        println!("    5. OAuth2 → URL Generator:");
        println!("       - Scopes: bot");
        println!("       - Bot Permissions: Send Messages, Read Message History");
        println!("    6. 生成されたURLでBotをサーバーに招待");
        println!();
        println!("  トークンの設定方法:");
        println!("    環境変数: export DISCORD_TOKEN=your-token-here");
        println!("    または config/default.toml の [discord] セクションに設定");
        println!();
    }

    // トークンがあれば接続テスト
    let token = std::env::var("DISCORD_TOKEN").ok().or_else(|| {
        if !current_token.is_empty() && current_token != "YOUR_DISCORD_BOT_TOKEN" {
            Some(current_token.clone())
        } else {
            None
        }
    });

    if let Some(token) = token {
        print!("  接続テスト中...");
        io::stdout().flush()?;

        // serenityのHttpクライアントで軽量な接続テスト
        let http = serenity::http::Http::new(&token);
        match http.get_current_user().await {
            Ok(user) => {
                println!(
                    "\r  [OK] Discord Bot 接続成功: {} (ID: {})",
                    user.name, user.id
                );
            }
            Err(e) => {
                println!("\r  [NG] Discord Bot 接続失敗: {}", e);
                println!("  → トークンを確認してください");
            }
        }
    } else {
        println!("  [SKIP] トークン未設定。Discord連携なしで起動します。");
    }

    Ok(())
}

/// 最終確認
async fn verify_setup() -> Result<()> {
    let config = load_or_default_config();

    let has_llm = std::env::var("ANTHROPIC_API_KEY").is_ok()
        || (!config.llm.api_key.is_empty() && config.llm.api_key != "YOUR_API_KEY");
    let has_discord = std::env::var("DISCORD_TOKEN").is_ok()
        || (config.discord.token != "YOUR_DISCORD_BOT_TOKEN"
            && !config.discord.token.is_empty());

    println!("設定状況:");
    println!(
        "  ストレージ : [OK] SQLite={}, Memory={}",
        config.storage.sqlite_path, config.storage.memory_path
    );
    println!(
        "  LLM        : [{}] provider={}, model={}",
        if has_llm { "OK" } else { "--" },
        config.llm.provider,
        config.llm.model
    );
    println!(
        "  Discord    : [{}]",
        if has_discord { "OK" } else { "--" }
    );
    println!(
        "  反応モード : {}",
        config.reaction.mode
    );
    println!();

    if !has_llm && !has_discord {
        println!("  ⚠ LLMもDiscordも未設定です。");
        println!("    まずはLLMのAPIキーを設定することをおすすめします。");
    } else if !has_llm {
        println!("  ⚠ LLM未設定。メンションへの応答はエコーモードになります。");
    } else if !has_discord {
        println!("  ⚠ Discord未設定。Discordなしで起動します。");
    }

    Ok(())
}

/// 設定を読み込む（なければデフォルト）
fn load_or_default_config() -> AppConfig {
    AppConfig::load("config/default.toml").unwrap_or_else(|_| {
        // デフォルト設定を返す
        AppConfig {
            discord: self_agent_config::DiscordConfig {
                token: String::new(),
            },
            storage: self_agent_config::StorageConfig {
                sqlite_path: "data/self-agent.db".to_string(),
                memory_path: "data/memory".to_string(),
            },
            reaction: self_agent_config::ReactionConfig {
                mode: "rule_based".to_string(),
                rules: Default::default(),
            },
            llm: Default::default(),
            agents: Default::default(),
        }
    })
}
