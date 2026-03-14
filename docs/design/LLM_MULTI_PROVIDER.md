# マルチLLMプロバイダー設計書

> 作成日: 2026-03-14
> 作成者: Agent-2 (LLMアーキテクト)
> ステータス: 設計セッション成果物

## 1. 設計目標

1. 複数のLLMプロバイダー (Anthropic, OpenAI, xAI, Ollama, GLM, Vertex AI) をプラグイン的に追加可能にする
2. タスクの性質に応じたモデル選択 (モデルルーティング)
3. OAuth認証が必要なプロバイダー (Vertex AI, Azure OpenAI) への対応
4. セットアップウィザードでのプロバイダー選択・設定
5. コスト追跡とレートリミット管理
6. 既存の `LlmProvider` trait と `AnthropicProvider` を破壊的変更なく拡張

---

## 2. 現状分析

### 2.1 現在の実装

```rust
// crates/llm-client/src/provider.rs
#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn name(&self) -> &str;
    async fn chat(&self, messages: &[ChatMessage], options: &ChatOptions) -> Result<ChatResponse>;
}

// crates/llm-client/src/anthropic.rs
pub struct AnthropicProvider {
    client: Client,
    api_key: String,
    default_model: String,
}
```

### 2.2 現在の設定 (config/default.toml)

```toml
[llm]
provider = "anthropic"
model = "claude-sonnet-4-20250514"
api_key = ""
```

### 2.3 課題
- プロバイダーが1つしかない (Anthropic)
- 設定が単一プロバイダー前提の構造
- ストリーミング未対応 (`chat_stream` がtraitにない)
- エラー型がanyhowのみ (プロバイダー固有エラーの区別不可)
- コスト追跡の仕組みなし

---

## 3. 設計: LlmProvider Trait 拡張

### 3.1 拡張後のtrait

```rust
use std::pin::Pin;
use futures::Stream;

/// プロバイダーの認証方式
#[derive(Debug, Clone)]
pub enum AuthMethod {
    /// APIキー方式 (Anthropic, OpenAI, xAI)
    ApiKey { key: String },
    /// OAuth2方式 (Vertex AI, Azure OpenAI)
    OAuth2 {
        client_id: String,
        client_secret: String,
        token_url: String,
        scopes: Vec<String>,
    },
    /// ローカル (Ollama) - 認証不要
    None,
}

/// プロバイダーの能力情報
#[derive(Debug, Clone)]
pub struct ProviderCapabilities {
    /// ストリーミング対応
    pub streaming: bool,
    /// ビジョン (画像入力) 対応
    pub vision: bool,
    /// 関数呼び出し対応
    pub function_calling: bool,
    /// 利用可能なモデル一覧
    pub available_models: Vec<ModelInfo>,
    /// 最大コンテキストウィンドウ (トークン数)
    pub max_context_window: u32,
}

/// モデル情報
#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub max_tokens: u32,
    pub input_cost_per_1k: Option<f64>,  // USD per 1K tokens
    pub output_cost_per_1k: Option<f64>,
}

/// ストリーミングチャンク
#[derive(Debug, Clone)]
pub struct ChatChunk {
    pub delta: String,
    pub finish_reason: Option<String>,
}

/// LLMプロバイダーの拡張トレイト
#[async_trait]
pub trait LlmProvider: Send + Sync {
    /// プロバイダー名 (e.g., "anthropic", "openai", "ollama")
    fn name(&self) -> &str;

    /// プロバイダーの能力情報
    fn capabilities(&self) -> &ProviderCapabilities;

    /// チャットリクエスト (同期)
    async fn chat(
        &self,
        messages: &[ChatMessage],
        options: &ChatOptions,
    ) -> Result<ChatResponse>;

    /// チャットリクエスト (ストリーミング)
    /// デフォルト実装: 同期chatをラップ
    async fn chat_stream(
        &self,
        messages: &[ChatMessage],
        options: &ChatOptions,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<ChatChunk>> + Send>>> {
        let response = self.chat(messages, options).await?;
        let chunk = ChatChunk {
            delta: response.content,
            finish_reason: Some("stop".to_string()),
        };
        Ok(Box::pin(futures::stream::once(async { Ok(chunk) })))
    }

    /// 接続テスト
    async fn test_connection(&self) -> Result<bool> {
        let messages = vec![ChatMessage::user("test")];
        let options = ChatOptions { max_tokens: Some(1), ..Default::default() };
        self.chat(&messages, &options).await.map(|_| true)
    }
}
```

### 3.2 ChatOptions 拡張

```rust
#[derive(Debug, Clone, Default)]
pub struct ChatOptions {
    pub model: Option<String>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub system_prompt: Option<String>,
    // -- 追加フィールド --
    pub top_p: Option<f32>,
    pub stop_sequences: Option<Vec<String>>,
    /// プロバイダー固有パラメータ (JSON)
    pub extra: Option<serde_json::Value>,
}
```

### 3.3 ChatResponse 拡張

```rust
#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub content: String,
    pub model: String,
    pub usage: Usage,
    // -- 追加フィールド --
    pub provider: String,
    pub finish_reason: Option<String>,
    /// レスポンス所要時間 (ミリ秒)
    pub latency_ms: u64,
}
```

---

## 4. 各プロバイダーの実装設計

### 4.1 プロバイダー一覧

| プロバイダー | API形式 | 認証方式 | ベースURL | 優先度 |
|---|---|---|---|---|
| Anthropic | Anthropic Messages API | APIキー | api.anthropic.com | 実装済み |
| OpenAI | OpenAI Chat Completions | APIキー | api.openai.com | Phase 2-1 |
| xAI (Grok) | OpenAI互換 | APIキー | api.x.ai | Phase 2-2 |
| Ollama | OpenAI互換 | なし | localhost:11434 | Phase 2-2 |
| GLM (Zhipu) | OpenAI互換 | APIキー | open.bigmodel.cn | Phase 2-3 |
| Vertex AI | Google Vertex | OAuth2 (Service Account) | {region}-aiplatform.googleapis.com | Phase 2-3 |
| Azure OpenAI | OpenAI互換 | APIキー or Azure AD | {endpoint}.openai.azure.com | Phase 2-3 |

### 4.2 OpenAI互換プロバイダーの共通実装

xAI, Ollama, GLM, Azure OpenAIはOpenAI Chat Completions APIと互換性があるため、共通の`OpenAiCompatibleProvider`を作成し、ベースURL・認証・ヘッダーのみ差し替える。

```rust
/// OpenAI互換APIプロバイダー
pub struct OpenAiCompatibleProvider {
    client: Client,
    config: OpenAiCompatibleConfig,
}

#[derive(Debug, Clone)]
pub struct OpenAiCompatibleConfig {
    /// プロバイダー名
    pub name: String,
    /// API ベースURL
    pub base_url: String,
    /// 認証方式
    pub auth: AuthMethod,
    /// デフォルトモデル
    pub default_model: String,
    /// カスタムヘッダー
    pub extra_headers: HashMap<String, String>,
    /// 能力情報
    pub capabilities: ProviderCapabilities,
}

impl OpenAiCompatibleProvider {
    pub fn openai(api_key: String) -> Self { /* ... */ }
    pub fn xai(api_key: String) -> Self { /* ... */ }
    pub fn ollama() -> Self { /* base_url = localhost:11434, auth = None */ }
    pub fn glm(api_key: String) -> Self { /* ... */ }
    pub fn azure(endpoint: String, api_key: String, deployment: String) -> Self { /* ... */ }
}
```

### 4.3 Vertex AI プロバイダー (OAuth2)

```rust
pub struct VertexAiProvider {
    client: Client,
    project_id: String,
    region: String,
    /// OAuth2トークンマネージャー
    token_manager: Arc<TokenManager>,
    default_model: String,
}

/// OAuth2トークンの自動リフレッシュ
pub struct TokenManager {
    token: RwLock<Option<OAuthToken>>,
    credentials: ServiceAccountCredentials,
}

impl TokenManager {
    /// トークンを取得 (期限切れならリフレッシュ)
    pub async fn get_token(&self) -> Result<String> {
        let token = self.token.read().await;
        if let Some(t) = token.as_ref() {
            if !t.is_expired() {
                return Ok(t.access_token.clone());
            }
        }
        drop(token);
        self.refresh_token().await
    }
}
```

---

## 5. 設定ファイル設計 (config/default.toml)

### 5.1 LocalGPT参考のプロバイダーセクション方式

```toml
# デフォルトプロバイダーとモデル
[llm]
default_provider = "anthropic"
default_model = "claude-sonnet-4-20250514"

# Anthropic設定
[llm.providers.anthropic]
enabled = true
api_key = ""                    # 空なら環境変数/DBから取得
default_model = "claude-sonnet-4-20250514"
# api_key は ANTHROPIC_API_KEY 環境変数 or DB設定で上書き可能

# OpenAI設定
[llm.providers.openai]
enabled = false
api_key = ""
default_model = "gpt-4o"
# api_key は OPENAI_API_KEY 環境変数 or DB設定で上書き可能

# xAI (Grok) 設定
[llm.providers.xai]
enabled = false
api_key = ""
base_url = "https://api.x.ai/v1"
default_model = "grok-3"

# Ollama (ローカル) 設定
[llm.providers.ollama]
enabled = false
base_url = "http://localhost:11434"
default_model = "llama3.2"

# GLM (Zhipu AI) 設定
[llm.providers.glm]
enabled = false
api_key = ""
base_url = "https://open.bigmodel.cn/api/paas/v4"
default_model = "glm-4-plus"

# Vertex AI (Google Cloud) 設定
[llm.providers.vertex_ai]
enabled = false
project_id = ""
region = "us-central1"
default_model = "gemini-2.0-flash"
# 認証: サービスアカウントJSONファイルへのパス
credentials_path = ""

# Azure OpenAI 設定
[llm.providers.azure_openai]
enabled = false
endpoint = ""
api_key = ""
api_version = "2024-10-21"
default_model = ""              # deployment名
```

### 5.2 AppConfig の拡張

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct LlmConfig {
    pub default_provider: String,
    pub default_model: String,
    #[serde(default)]
    pub providers: HashMap<String, ProviderConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    pub default_model: String,
    // Vertex AI用
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub credentials_path: String,
    // Azure用
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub api_version: String,
}
```

---

## 6. モデルルーティング設計

### 6.1 コンセプト

タスクの種類に応じて最適なモデルを自動選択する。ユーザーが明示的に指定した場合はそちらを優先。

### 6.2 ルーティングルール

```toml
# config/default.toml

[llm.routing]
# タスク種別ごとのモデル割り当て
[llm.routing.rules]
# 意図解釈: 高品質モデル推奨
intent_parsing = { provider = "anthropic", model = "claude-sonnet-4-20250514" }
# タスク要約: 中品質で十分
summarization = { provider = "anthropic", model = "claude-haiku-4-20250514" }
# コード生成 (スキル開発): 高品質推奨
code_generation = { provider = "anthropic", model = "claude-sonnet-4-20250514" }
# 雑談: コスト最適化
chat = { provider = "ollama", model = "llama3.2" }
# フォールバック
default = { provider = "anthropic", model = "claude-sonnet-4-20250514" }
```

### 6.3 ルーターの実装

```rust
/// モデルルーター
pub struct ModelRouter {
    providers: HashMap<String, Arc<dyn LlmProvider>>,
    rules: RoutingRules,
    default_provider: String,
    default_model: String,
}

/// タスク種別
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub enum TaskType {
    IntentParsing,
    Summarization,
    CodeGeneration,
    Chat,
    Custom(String),
}

/// ルーティングルール
#[derive(Debug, Clone)]
pub struct RoutingRule {
    pub provider: String,
    pub model: String,
}

impl ModelRouter {
    /// タスク種別に基づいてプロバイダーとモデルを選択
    pub fn resolve(&self, task_type: &TaskType) -> (&dyn LlmProvider, String) {
        let rule = self.rules.get(task_type)
            .unwrap_or(&self.rules.default);

        let provider = self.providers.get(&rule.provider)
            .unwrap_or_else(|| self.providers.get(&self.default_provider).unwrap());

        (provider.as_ref(), rule.model.clone())
    }

    /// 直接チャット (ルーティング込み)
    pub async fn chat(
        &self,
        task_type: &TaskType,
        messages: &[ChatMessage],
        options: &ChatOptions,
    ) -> Result<ChatResponse> {
        let (provider, model) = self.resolve(task_type);
        let options = ChatOptions {
            model: Some(model),
            ..options.clone()
        };
        provider.chat(messages, &options).await
    }
}
```

---

## 7. プロバイダーレジストリ

### 7.1 設計

```rust
/// プロバイダーレジストリ: 設定からプロバイダーインスタンスを生成・管理
pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn LlmProvider>>,
}

impl ProviderRegistry {
    /// 設定ファイルからレジストリを構築
    pub fn from_config(config: &LlmConfig, db: &Database) -> Result<Self> {
        let mut providers = HashMap::new();

        for (name, provider_config) in &config.providers {
            if !provider_config.enabled {
                continue;
            }

            // APIキーの解決: DB → 環境変数 → config.toml
            let api_key = resolve_api_key(name, provider_config, db)?;

            let provider: Arc<dyn LlmProvider> = match name.as_str() {
                "anthropic" => Arc::new(
                    AnthropicProvider::new(api_key)
                        .with_model(provider_config.default_model.clone())
                ),
                "openai" => Arc::new(
                    OpenAiCompatibleProvider::openai(api_key)
                ),
                "xai" => Arc::new(
                    OpenAiCompatibleProvider::xai(api_key)
                ),
                "ollama" => Arc::new(
                    OpenAiCompatibleProvider::ollama()
                        .with_base_url(&provider_config.base_url)
                ),
                "vertex_ai" => Arc::new(
                    VertexAiProvider::from_config(provider_config)?
                ),
                _ => {
                    tracing::warn!("Unknown provider: {}", name);
                    continue;
                }
            };

            providers.insert(name.clone(), provider);
        }

        Ok(Self { providers })
    }

    pub fn get(&self, name: &str) -> Option<&Arc<dyn LlmProvider>> {
        self.providers.get(name)
    }

    pub fn list(&self) -> Vec<&str> {
        self.providers.keys().map(|s| s.as_str()).collect()
    }
}

/// APIキー解決の優先順位: DB → 環境変数 → config.toml
fn resolve_api_key(
    provider_name: &str,
    config: &ProviderConfig,
    db: &Database,
) -> Result<String> {
    let db_key = format!("{}_api_key", provider_name);
    let env_key = format!("{}_API_KEY", provider_name.to_uppercase());

    db.get_config(&db_key)?
        .or_else(|| std::env::var(&env_key).ok())
        .or_else(|| {
            let key = &config.api_key;
            if !key.is_empty() && key != "YOUR_API_KEY" {
                Some(key.clone())
            } else {
                None
            }
        })
        .ok_or_else(|| anyhow::anyhow!(
            "API key not found for provider '{}'. Set via DB ({}), env var ({}), or config.",
            provider_name, db_key, env_key
        ))
}
```

---

## 8. コスト追跡

### 8.1 Usage追跡

```rust
/// LLM使用量の追跡
pub struct UsageTracker {
    db: Arc<Mutex<Database>>,
}

/// 使用量レコード
pub struct UsageRecord {
    pub timestamp: DateTime<Utc>,
    pub provider: String,
    pub model: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub estimated_cost_usd: f64,
    pub latency_ms: u64,
    pub task_type: String,
    pub agent_id: String,
}

impl UsageTracker {
    /// 使用量を記録
    pub fn record(&self, record: UsageRecord) -> Result<()> { /* SQLite INSERT */ }

    /// 期間別の使用量サマリー
    pub fn summary(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<UsageSummary> {
        /* SQLite集計 */
    }

    /// 今月の推定コスト
    pub fn current_month_cost(&self) -> Result<f64> { /* ... */ }
}
```

### 8.2 SQLiteスキーマ

```sql
CREATE TABLE IF NOT EXISTS llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    estimated_cost_usd REAL NOT NULL DEFAULT 0.0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    task_type TEXT NOT NULL DEFAULT 'unknown',
    agent_id TEXT NOT NULL DEFAULT 'unknown',
    correlation_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_timestamp ON llm_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_llm_usage_provider ON llm_usage(provider);
```

---

## 9. レートリミット管理

### 9.1 設計

```rust
/// トークンバケットベースのレートリミッター
pub struct RateLimiter {
    /// プロバイダーごとのリミット設定
    limits: HashMap<String, RateLimit>,
}

pub struct RateLimit {
    /// リクエスト/分
    pub requests_per_minute: u32,
    /// トークン/分
    pub tokens_per_minute: u32,
    /// 現在のカウンター
    bucket: Arc<Mutex<TokenBucket>>,
}

impl RateLimiter {
    /// リクエスト前にレートリミットチェック
    /// 超過の場合はOk(Duration)で待機時間を返す
    pub async fn check(&self, provider: &str) -> Result<Option<Duration>> {
        /* ... */
    }

    /// リクエスト後にカウンターを更新
    pub fn record_usage(&self, provider: &str, tokens: u32) {
        /* ... */
    }
}
```

---

## 10. セットアップウィザードの拡張

### 10.1 フロー

```
Step 2/N: LLMプロバイダー設定

利用可能なプロバイダー:
  1. Anthropic (Claude) [現在設定済み]
  2. OpenAI (GPT-4o)
  3. xAI (Grok)
  4. Ollama (ローカル)
  5. GLM (Zhipu AI)
  6. Vertex AI (Google Cloud)
  7. Azure OpenAI

設定するプロバイダーの番号を入力 (カンマ区切りで複数可): 1,4

━━━ Anthropic 設定 ━━━
  APIキーが設定済みです: sk-a****
  変更しますか? (y/N): N
  [OK] Claude API 接続成功

━━━ Ollama 設定 ━━━
  URL (default: http://localhost:11434): [Enter]
  接続テスト中... [OK] Ollama 接続成功
  利用可能なモデル:
    1. llama3.2 (8B)
    2. codellama (34B)
  デフォルトモデル (1): 1

デフォルトプロバイダー: anthropic (変更する場合は番号入力): [Enter]
```

---

## 11. 移行計画

### Phase 1 (現在): 既存コード維持
- `LlmProvider` traitはそのまま
- `AnthropicProvider` はそのまま

### Phase 2-1: trait拡張 + OpenAI対応
1. `LlmProvider` traitに `capabilities()`, `chat_stream()` を追加
2. `ChatResponse` に `provider`, `latency_ms` を追加
3. `OpenAiCompatibleProvider` を実装
4. `ProviderRegistry` を実装
5. `config/default.toml` を `[llm.providers.xxx]` 形式に移行
6. セットアップウィザードの更新
7. `UsageTracker` (SQLite) を実装

### Phase 2-2: 追加プロバイダー + ルーティング
8. xAI, Ollama プロバイダー追加 (OpenAI互換で簡単)
9. `ModelRouter` 実装
10. `RateLimiter` 実装
11. ルーティングルール設定

### Phase 2-3: OAuth対応プロバイダー
12. `TokenManager` (OAuth2) 実装
13. `VertexAiProvider` 実装
14. Azure OpenAI対応
15. GLM対応

---

## 12. ファイル構成 (実装後)

```
crates/llm-client/
├── Cargo.toml
└── src/
    ├── lib.rs              # re-exports
    ├── provider.rs          # LlmProvider trait (拡張後)
    ├── types.rs             # ChatMessage, ChatOptions, ChatResponse等
    ├── anthropic.rs         # AnthropicProvider (既存、拡張)
    ├── openai_compat.rs     # OpenAiCompatibleProvider (新規)
    ├── vertex_ai.rs         # VertexAiProvider (新規)
    ├── registry.rs          # ProviderRegistry (新規)
    ├── router.rs            # ModelRouter (新規)
    ├── rate_limit.rs        # RateLimiter (新規)
    ├── usage.rs             # UsageTracker (新規)
    └── oauth.rs             # TokenManager (新規)
```
