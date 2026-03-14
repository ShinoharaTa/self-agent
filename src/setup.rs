//! ステップバイステップの初期セットアップウィザード
//!
//! 各機能を個別にセットアップ・テストできるフローを提供する。
//! `self-agent --setup` で起動。

use anyhow::Result;
use std::io::{self, BufRead, Write};

use self_agent_config::AppConfig;
use self_agent_llm_client::provider::LlmProvider;
use self_agent_storage::Database;

/// セットアップウィザードのメインエントリ
pub async fn run_setup() -> Result<()> {
    println!();
    println!("╔══════════════════════════════════════════╗");
    println!("║       self-agent セットアップ            ║");
    println!("╚══════════════════════════════════════════╝");
    println!();
    println!("各機能をステップバイステップで設定します。");
    println!("スキップしたい項目は Enter で飛ばせます。");
    println!("設定値はシステムDB (SQLite) に保存されます。");
    println!();

    // ストレージ初期化（設定の保存先なので最初に）
    let config = load_or_default_config();
    let db = Database::open(&config.storage.sqlite_path)?;

    // Step 1: ストレージ
    println!("━━━ Step 1/4: ストレージ ━━━");
    setup_storage(&db).await?;

    // Step 2: LLM
    println!();
    println!("━━━ Step 2/4: LLM (Claude API) ━━━");
    setup_llm(&db).await?;

    // Step 3: Discord
    println!();
    println!("━━━ Step 3/4: Discord Bot ━━━");
    setup_discord(&db).await?;

    // Step 4: 確認
    println!();
    println!("━━━ Step 4/4: 設定確認 ━━━");
    verify_setup(&db).await?;

    println!();
    println!("セットアップ完了！ `cargo run` で起動できます。");
    println!();

    Ok(())
}

/// 標準入力から1行読み取る（パスワード的なものも含む）
fn prompt_input(label: &str) -> Result<String> {
    print!("  {} ", label);
    io::stdout().flush()?;
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line)?;
    Ok(line.trim().to_string())
}

/// 値をマスク表示（先頭4文字 + ****）
fn mask_value(val: &str) -> String {
    if val.len() <= 4 {
        "****".to_string()
    } else {
        format!("{}****", &val[..4])
    }
}

/// ストレージのセットアップ
async fn setup_storage(db: &Database) -> Result<()> {
    println!("  SQLiteデータベースとMemoryStoreを初期化します。");

    let config = load_or_default_config();
    let mem_path = &config.storage.memory_path;

    std::fs::create_dir_all(mem_path)?;

    let memory = self_agent_storage::MemoryStore::new(mem_path)?;
    if memory.load_global()?.is_empty() {
        memory.save_global("# Global Memory\n\nself-agent のグローバル記憶。\n")?;
    }

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

    println!("  [OK] SQLite: {}", config.storage.sqlite_path);
    println!("  [OK] MemoryStore: {}", mem_path);
    println!("  [OK] タスクの作成・削除テスト成功");

    Ok(())
}

/// LLMのセットアップ
async fn setup_llm(db: &Database) -> Result<()> {
    // 現在の設定を確認（DB → 環境変数の順）
    let current_key = db
        .get_config("anthropic_api_key")?
        .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok());

    if let Some(ref key) = current_key {
        if !key.is_empty() && key != "YOUR_API_KEY" {
            println!("  APIキーが設定済みです: {}", mask_value(key));
            let ans = prompt_input("変更しますか? (y/N):")?;
            if !ans.eq_ignore_ascii_case("y") {
                // 既存キーで接続テスト
                test_llm_connection(key).await;
                return Ok(());
            }
        }
    }

    println!("  Claude APIキーを入力してください。");
    println!("  (https://console.anthropic.com/settings/keys で取得)");
    let key = prompt_input("API Key (sk-ant-...):")?;

    if key.is_empty() {
        println!("  [SKIP] APIキー未設定。LLMなしモードで動作します。");
        println!("  → タスクの手動追加・一覧は使えます");
        return Ok(());
    }

    // 接続テスト
    let ok = test_llm_connection(&key).await;

    if ok {
        db.set_config("anthropic_api_key", &key)?;
        println!("  → DBに保存しました");
    } else {
        let ans = prompt_input("接続失敗しましたが保存しますか? (y/N):")?;
        if ans.eq_ignore_ascii_case("y") {
            db.set_config("anthropic_api_key", &key)?;
            println!("  → DBに保存しました");
        }
    }

    Ok(())
}

/// LLM接続テスト（成功したらtrue）
async fn test_llm_connection(key: &str) -> bool {
    print!("  接続テスト中...");
    io::stdout().flush().ok();

    let provider = self_agent_llm_client::anthropic::AnthropicProvider::new(key.to_string());
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
            true
        }
        Err(e) => {
            println!("\r  [NG] Claude API 接続失敗: {}", e);
            false
        }
    }
}

/// Discordのセットアップ
async fn setup_discord(db: &Database) -> Result<()> {
    let current_token = db
        .get_config("discord_token")?
        .or_else(|| std::env::var("DISCORD_TOKEN").ok());

    if let Some(ref token) = current_token {
        if !token.is_empty() && token != "YOUR_DISCORD_BOT_TOKEN" {
            println!("  Discordトークンが設定済みです: {}", mask_value(token));
            let ans = prompt_input("変更しますか? (y/N):")?;
            if !ans.eq_ignore_ascii_case("y") {
                test_discord_connection(token).await;
                return Ok(());
            }
        }
    }

    println!("  Discord Botトークンを入力してください。");
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

    let token = prompt_input("Bot Token:")?;

    if token.is_empty() {
        println!("  [SKIP] トークン未設定。Discord連携なしで起動します。");
        return Ok(());
    }

    let ok = test_discord_connection(&token).await;

    if ok {
        db.set_config("discord_token", &token)?;
        println!("  → DBに保存しました");
    } else {
        let ans = prompt_input("接続失敗しましたが保存しますか? (y/N):")?;
        if ans.eq_ignore_ascii_case("y") {
            db.set_config("discord_token", &token)?;
            println!("  → DBに保存しました");
        }
    }

    Ok(())
}

/// Discord接続テスト（成功したらtrue）
async fn test_discord_connection(token: &str) -> bool {
    print!("  接続テスト中...");
    io::stdout().flush().ok();

    let http = serenity::http::Http::new(token);
    match http.get_current_user().await {
        Ok(user) => {
            println!(
                "\r  [OK] Discord Bot 接続成功: {} (ID: {})",
                user.name, user.id
            );
            true
        }
        Err(e) => {
            println!("\r  [NG] Discord Bot 接続失敗: {}", e);
            false
        }
    }
}

/// 最終確認
async fn verify_setup(db: &Database) -> Result<()> {
    let config = load_or_default_config();

    let has_llm = db
        .get_config("anthropic_api_key")?
        .map(|k| !k.is_empty())
        .unwrap_or(false)
        || std::env::var("ANTHROPIC_API_KEY").is_ok();

    let has_discord = db
        .get_config("discord_token")?
        .map(|t| !t.is_empty())
        .unwrap_or(false)
        || std::env::var("DISCORD_TOKEN").is_ok();

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

    // DB内の全設定を表示
    let configs = db.list_config()?;
    if !configs.is_empty() {
        println!("  DB保存済みの設定:");
        for (key, value) in &configs {
            let display = if key.contains("key") || key.contains("token") || key.contains("secret")
            {
                mask_value(value)
            } else {
                value.clone()
            };
            println!("    {} = {}", key, display);
        }
        println!();
    }

    if !has_llm && !has_discord {
        println!("  ! LLMもDiscordも未設定です。");
        println!("    まずはLLMのAPIキーを設定することをおすすめします。");
    } else if !has_llm {
        println!("  ! LLM未設定。メンションへの応答はエコーモードになります。");
    } else if !has_discord {
        println!("  ! Discord未設定。Discordなしで起動します。");
    }

    Ok(())
}

/// 設定を読み込む（なければデフォルト）
fn load_or_default_config() -> AppConfig {
    AppConfig::load("config/default.toml").unwrap_or_else(|_| {
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
