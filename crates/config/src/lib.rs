use anyhow::Result;
use serde::Deserialize;
use std::path::Path;

/// アプリケーション全体の設定
#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub discord: DiscordConfig,
    pub storage: StorageConfig,
    pub reaction: ReactionConfig,
    #[serde(default)]
    pub llm: LlmConfig,
    #[serde(default)]
    pub agents: AgentConfig,
}

/// Discord接続設定（トークンはシステムDBで管理）
#[derive(Debug, Clone, Deserialize, Default)]
pub struct DiscordConfig {
    #[serde(default)]
    pub token: String,
}

/// ストレージ設定
#[derive(Debug, Clone, Deserialize)]
pub struct StorageConfig {
    pub sqlite_path: String,
    #[serde(default = "default_memory_path")]
    pub memory_path: String,
}

fn default_memory_path() -> String {
    "data/memory".to_string()
}

/// 反応モード設定
#[derive(Debug, Clone, Deserialize)]
pub struct ReactionConfig {
    /// "rule_based" | "llm" | "hybrid"
    pub mode: String,
    #[serde(default)]
    pub rules: ReactionRules,
}

/// ルールベース反応設定
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ReactionRules {
    #[serde(default = "default_true")]
    pub mention: bool,
    #[serde(default = "default_true")]
    pub reply_to_self: bool,
    #[serde(default)]
    pub keyword_trigger: Vec<String>,
}

fn default_true() -> bool {
    true
}

/// LLM設定（APIキーはシステムDBで管理）
#[derive(Debug, Clone, Deserialize)]
pub struct LlmConfig {
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
}

fn default_provider() -> String {
    "anthropic".to_string()
}

fn default_model() -> String {
    "claude-sonnet-4-20250514".to_string()
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: default_provider(),
            model: default_model(),
            api_key: String::new(),
        }
    }
}

/// エージェント設定
#[derive(Debug, Clone, Deserialize, Default)]
pub struct AgentConfig {
    #[serde(default = "default_bus_buffer")]
    pub bus_buffer_size: usize,
}

fn default_bus_buffer() -> usize {
    256
}

impl AppConfig {
    /// TOMLファイルから設定を読み込む
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let content = std::fs::read_to_string(path.as_ref())?;
        let config: AppConfig = toml::from_str(&content)?;

        tracing::info!("Config loaded from {}", path.as_ref().display());
        Ok(config)
    }
}
