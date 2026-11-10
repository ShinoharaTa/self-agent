# 外部連携設計書

> 作成日: 2026-03-14
> 作成者: Agent-3 (インテグレーション設計)
> ステータス: 設計セッション成果物

## 1. 設計目標

1. Google Calendar連携 (OAuth2フロー、承認制スケジュール)
2. Slack Bot連携 (Discord ChatBotとの共通化)
3. リマインダーエージェントの設計
4. 外部サービス認証の統一管理 (OAuthトークン保存・リフレッシュ)
5. スキルシステムのアーキテクチャ概要

---

## 2. 外部サービス認証の統一管理

### 2.1 設計方針

すべての外部サービス (Google, Slack, 将来のGitHub等) のOAuth認証を統一的に管理する`CredentialStore`を設計する。

### 2.2 CredentialStore

```rust
/// 外部サービスのクレデンシャル管理
pub struct CredentialStore {
    db: Arc<Mutex<Database>>,
}

/// 保存するクレデンシャル
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredential {
    pub service: String,           // "google", "slack", "github"
    pub credential_type: CredentialType,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CredentialType {
    /// APIキー/トークン (Discord Bot Token, etc.)
    Token {
        token: String,
    },
    /// OAuth2トークン
    OAuth2 {
        access_token: String,
        refresh_token: Option<String>,
        expires_at: Option<DateTime<Utc>>,
        token_type: String,
        scopes: Vec<String>,
    },
    /// サービスアカウント (Google Cloud)
    ServiceAccount {
        credentials_json: String,
    },
}

impl CredentialStore {
    /// クレデンシャルを保存 (暗号化してSQLiteに保存)
    pub fn save(&self, service: &str, credential: &StoredCredential) -> Result<()>;

    /// クレデンシャルを取得
    pub fn get(&self, service: &str) -> Result<Option<StoredCredential>>;

    /// クレデンシャルを削除
    pub fn delete(&self, service: &str) -> Result<()>;

    /// OAuth2トークンのリフレッシュ
    pub async fn refresh_oauth2(
        &self,
        service: &str,
        token_url: &str,
        client_id: &str,
        client_secret: &str,
    ) -> Result<StoredCredential>;

    /// 全サービスのクレデンシャル一覧 (マスク表示用)
    pub fn list(&self) -> Result<Vec<(String, String)>>;
}
```

### 2.3 SQLiteスキーマ

```sql
CREATE TABLE IF NOT EXISTS credentials (
    service TEXT PRIMARY KEY,
    credential_type TEXT NOT NULL,    -- "token", "oauth2", "service_account"
    data TEXT NOT NULL,               -- JSON (将来的には暗号化)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 2.4 暗号化方針

Phase 1: 平文でSQLiteに保存 (ファイルパーミッション 0600 で保護)
Phase 2: `aes-gcm` クレートで暗号化。マスターキーは環境変数 `SELF_AGENT_MASTER_KEY` から取得。

---

## 3. Google Calendar連携

### 3.1 概要

Google Calendar API v3を使用し、以下の機能を提供:
- 複数カレンダーの読み取り
- 空き時間の検出
- 予定の登録 (承認制)
- 予定の確認・検索

### 3.2 OAuth2フロー

```
┌──────────┐                    ┌──────────────┐
│ セットアップ │                    │ Google OAuth  │
│ ウィザード  │                    │ Server       │
└─────┬────┘                    └──────┬───────┘
      │                                │
      │  1. 認証URLを表示              │
      │  (ブラウザで開くよう指示)        │
      │                                │
      │  ──────── ブラウザ ─────────►  │
      │                                │
      │     2. ユーザーがGoogle認証      │
      │        ・カレンダースコープ承認   │
      │                                │
      │  ◄──── redirect_uri ─────────  │
      │     (localhost:PORT/callback)   │
      │                                │
      │  3. 認可コードを受信            │
      │                                │
      │  4. 認可コード → トークン交換   │
      │  ─────────────────────────────► │
      │  ◄───────── access_token ───── │
      │              refresh_token     │
      │                                │
      │  5. CredentialStoreに保存       │
      └────────────────────────────────┘
```

### 3.3 OAuth2実装

```rust
pub struct GoogleOAuth2 {
    client_id: String,
    client_secret: String,
    redirect_uri: String,      // "http://localhost:PORT/callback"
    scopes: Vec<String>,
}

impl GoogleOAuth2 {
    pub fn new(client_id: String, client_secret: String) -> Self {
        Self {
            client_id,
            client_secret,
            redirect_uri: "http://localhost:18431/callback".to_string(),
            scopes: vec![
                "https://www.googleapis.com/auth/calendar.readonly".to_string(),
                "https://www.googleapis.com/auth/calendar.events".to_string(),
            ],
        }
    }

    /// 認証URLを生成
    pub fn authorization_url(&self) -> (String, String) {
        // (url, state) を返す
    }

    /// ローカルHTTPサーバーで認可コードを受け取り、トークンに交換
    pub async fn exchange_code(&self, timeout: Duration) -> Result<StoredCredential> {
        // 1. localhost:PORT でHTTPサーバー起動
        // 2. /callback でGETリクエスト待ち
        // 3. code パラメータを取得
        // 4. Google Token Endpoint に POST
        // 5. StoredCredential を返す
    }
}
```

### 3.4 CalSync エージェント設計

```rust
pub struct CalSyncAgent {
    bus: MessageBus,
    credential_store: Arc<CredentialStore>,
    calendar_client: Option<GoogleCalendarClient>,
    /// ローカルキャッシュ (直近の予定)
    cache: RwLock<CalendarCache>,
}

/// Google Calendar APIクライアント
pub struct GoogleCalendarClient {
    client: Client,
    credential_store: Arc<CredentialStore>,
}

impl GoogleCalendarClient {
    /// 予定の一覧取得
    pub async fn list_events(
        &self,
        calendar_id: &str,
        time_min: DateTime<Utc>,
        time_max: DateTime<Utc>,
    ) -> Result<Vec<CalendarEvent>>;

    /// 空き時間の検索
    pub async fn find_free_slots(
        &self,
        calendar_ids: &[String],
        time_min: DateTime<Utc>,
        time_max: DateTime<Utc>,
        duration: Duration,
    ) -> Result<Vec<TimeSlot>>;

    /// 予定の作成
    pub async fn create_event(
        &self,
        calendar_id: &str,
        event: &NewCalendarEvent,
    ) -> Result<CalendarEvent>;
}

/// カレンダーイベント
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalendarEvent {
    pub id: String,
    pub summary: String,
    pub description: Option<String>,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub calendar_id: String,
    pub status: String,
}

/// 空き時間スロット
#[derive(Debug, Clone)]
pub struct TimeSlot {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}
```

### 3.5 承認制スケジュール登録フロー

```
1. Orchestrator → CalSync: "来週水曜のAPI設計MTGを登録して"
2. CalSync: 空き時間を検索
3. CalSync → Orchestrator: 候補スロット提案
   [Response: "以下の時間が空いています:
    A) 3/18 10:00-11:00
    B) 3/18 14:00-15:00
    C) 3/18 16:00-17:00"]
4. Orchestrator → ChatBot: 候補をユーザーに提示
5. ChatBot → Discord: "どの時間にしますか? A/B/C"
6. ユーザー: "Bで"
7. ChatBot → Orchestrator → CalSync: 登録確定 (3/18 14:00-15:00)
8. CalSync: Google Calendar API で予定作成
9. CalSync → Orchestrator → ChatBot → Discord: "登録しました"
```

### 3.6 設定

```toml
[google_calendar]
enabled = false
# OAuth2設定 (Google Cloud Console で取得)
client_id = ""
client_secret = ""
# 同期対象のカレンダーID (空なら全カレンダー)
calendar_ids = []
# 同期間隔 (分)
sync_interval_minutes = 15
# 確定済みの予定のみ登録
confirmed_only = true
```

---

## 4. Slack Bot連携

### 4.1 Discord/Slack共通化の設計

Discord ChatBotとSlack Botの共通部分を抽出し、プラットフォーム非依存の`ChatPlatform` traitを定義する。

```rust
/// チャットプラットフォーム抽象
#[async_trait]
pub trait ChatPlatform: Send + Sync {
    /// プラットフォーム名
    fn name(&self) -> &str;

    /// メッセージを送信
    async fn send_message(
        &self,
        channel_id: &str,
        content: &str,
    ) -> Result<()>;

    /// 直近のメッセージ履歴を取得
    async fn get_recent_messages(
        &self,
        channel_id: &str,
        limit: usize,
    ) -> Result<Vec<PlatformMessage>>;
}

/// プラットフォーム共通のメッセージ
#[derive(Debug, Clone)]
pub struct PlatformMessage {
    pub id: String,
    pub channel_id: String,
    pub server_id: Option<String>,
    pub author_name: String,
    pub author_id: String,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub is_bot: bool,
    pub platform: String,  // "discord" | "slack"
}

/// プラットフォームからのイベント
#[derive(Debug, Clone)]
pub enum PlatformEvent {
    /// メンションされた
    Mentioned {
        message: PlatformMessage,
        context: Vec<PlatformMessage>,
    },
    /// 自分の投稿にリプライされた
    RepliedTo {
        message: PlatformMessage,
        original: PlatformMessage,
    },
    /// ダイレクトメッセージ
    DirectMessage {
        message: PlatformMessage,
    },
}
```

### 4.2 chat-botクレートのリファクタリング

```
crates/chat-bot/
├── Cargo.toml
└── src/
    ├── lib.rs              # re-exports
    ├── platform.rs          # ChatPlatform trait, PlatformMessage, PlatformEvent
    ├── handler.rs           # 共通メッセージハンドラ (MessageBusとの連携)
    ├── discord.rs           # DiscordPlatform (既存のdiscord.rsをリファクタリング)
    └── slack.rs             # SlackPlatform (新規)
```

### 4.3 Slack Bot実装

```rust
pub struct SlackPlatform {
    client: SlackClient,          // slack-morphism クレート
    bot_user_id: String,
}

#[async_trait]
impl ChatPlatform for SlackPlatform {
    fn name(&self) -> &str { "slack" }

    async fn send_message(&self, channel_id: &str, content: &str) -> Result<()> {
        self.client.chat_post_message(
            &SlackApiChatPostMessageRequest::new(
                SlackChannelId::new(channel_id.to_string()),
                SlackMessageContent::new().with_text(content.to_string()),
            )
        ).await?;
        Ok(())
    }

    async fn get_recent_messages(
        &self,
        channel_id: &str,
        limit: usize,
    ) -> Result<Vec<PlatformMessage>> {
        // Slack conversations.history API
    }
}
```

### 4.4 Slack設定

```toml
[slack]
enabled = false
# Slack Bot Token (xoxb-...)
bot_token = ""
# Slack App Token (xapp-...) for Socket Mode
app_token = ""
# Socket Mode (推奨: Webhook不要)
socket_mode = true
```

### 4.5 Discord/Slackの相違点と対処

| 項目 | Discord | Slack | 共通化方針 |
|---|---|---|---|
| 認証 | Bot Token | Bot Token + App Token | CredentialStoreで統一管理 |
| リアルタイム接続 | Gateway (WebSocket) | Socket Mode or Events API | 各プラットフォーム固有 |
| メンション検出 | `<@bot_id>` | `<@bot_id>` | ほぼ同じ |
| チャンネルID | Snowflake (u64) | 文字列 (C0xxxxx) | 文字列に統一 |
| メッセージ履歴 | get_messages() | conversations.history() | ChatPlatform traitで抽象化 |
| リアクション | emoji名 | emoji名 | 同じ |
| スレッド | なし (返信はリプライ) | あり (thread_ts) | Slackはスレッド対応 |

---

## 5. リマインダーエージェント

### 5.1 設計

```rust
pub struct ReminderAgent {
    bus: MessageBus,
    db: Arc<Mutex<Database>>,
}

#[async_trait]
impl Agent for ReminderAgent {
    fn id(&self) -> AgentId { AgentId::Reminder }

    fn tick_interval(&self) -> Option<Duration> {
        Some(Duration::from_secs(60)) // 1分間隔でチェック
    }

    async fn tick(&mut self) -> Result<()> {
        // 1. 現在時刻以前のpendingリマインダーを取得
        let reminders = self.db.lock().unwrap()
            .get_pending_reminders()?;

        for reminder in reminders {
            if reminder.remind_at <= Utc::now() {
                // 2. Orchestratorに通知メッセージを送信
                let msg = Message {
                    from: AgentId::Reminder,
                    to: Some(AgentId::Orchestrator),
                    kind: MessageKind::Notification,
                    payload: json!({
                        "type": "reminder_fired",
                        "reminder_id": reminder.id,
                        "task_id": reminder.task_id,
                        "message": reminder.message,
                        "channel_id": reminder.channel_id,
                    }),
                    ..Default::default()
                };
                self.bus.send(msg).await?;

                // 3. リマインダーを発火済みにマーク
                self.db.lock().unwrap()
                    .mark_reminder_fired(reminder.id)?;
            }
        }
        Ok(())
    }

    async fn handle_message(&mut self, msg: A2AMessage) -> Result<Option<A2AMessage>> {
        // リマインダー作成/削除/一覧のコマンド処理
        match msg.payload.get("action").and_then(|v| v.as_str()) {
            Some("create") => { /* リマインダー作成 */ }
            Some("list") => { /* リマインダー一覧 */ }
            Some("cancel") => { /* リマインダー削除 */ }
            _ => {}
        }
        Ok(None)
    }

    async fn shutdown(&mut self) -> Result<()> {
        tracing::info!("ReminderAgent shutting down");
        Ok(())
    }
}
```

### 5.2 リマインダーの種類

| 種類 | トリガー | 例 |
|---|---|---|
| 時刻指定 | 指定時刻に発火 | "15:00にMTG参加を通知" |
| タスク期限 | タスクの期限前に発火 | "期限1時間前に通知" |
| 繰り返し | cron式で定期発火 | "毎朝9:00に今日のタスクを通知" |
| 場所ベース (将来) | 位置情報で発火 | "会社に着いたらリマインド" |

### 5.3 リマインダーのデータモデル (storage/models.rs 既存の拡張)

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reminder {
    pub id: i64,
    pub task_id: Option<i64>,     // 関連タスク (任意)
    pub message: String,
    pub remind_at: DateTime<Utc>,
    pub channel_id: Option<String>, // 通知先チャンネル
    pub platform: Option<String>,   // "discord" | "slack"
    pub repeat: Option<String>,     // cron式 (繰り返しの場合)
    pub fired: bool,
    pub created_at: DateTime<Utc>,
}
```

### 5.4 自然言語からのリマインダー作成

```
ユーザー: "@bot 明日の10時にスプリントレビューの準備をリマインドして"

1. ChatBot → Orchestrator: メッセージ転送
2. Orchestrator: LLMでインテント解釈
   → {action: "create_reminder", time: "2026-03-15T10:00:00", message: "スプリントレビューの準備"}
3. Orchestrator → Reminder: リマインダー作成
4. Reminder: DBに保存
5. Reminder → Orchestrator → ChatBot → Discord: "3/15 10:00にリマインドします"

(翌日10:00)
6. Reminder tick(): 発火時刻到達を検知
7. Reminder → Orchestrator → ChatBot → Discord: "リマインド: スプリントレビューの準備"
```

---

## 6. スキルシステムのアーキテクチャ概要

### 6.1 全体構成

```
┌─────────────────────────────────────────┐
│            SkillDev Agent               │
│  (スキル開発・管理・テスト)               │
└──────────────┬──────────────────────────┘
               │ A2A Messages
┌──────────────┴──────────────────────────┐
│          Skill Runtime (rquickjs)        │
│                                          │
│  ┌────────────┐  ┌────────────┐         │
│  │ Skill      │  │ Sandbox    │         │
│  │ Registry   │  │ Manager    │         │
│  └─────┬──────┘  └─────┬──────┘         │
│        │               │                │
│  ┌─────┴───────────────┴──────────┐     │
│  │       QuickJS Runtime          │     │
│  │  ┌────────┐  ┌────────┐       │     │
│  │  │ Skill  │  │ Skill  │ ...   │     │
│  │  │ task-  │  │ cal-   │       │     │
│  │  │ extract│  │ check  │       │     │
│  │  └────────┘  └────────┘       │     │
│  └────────────────────────────────┘     │
│                                          │
│  ┌────────────────────────────────┐     │
│  │    Host Functions (Rust)       │     │
│  │  db_read(), db_write(),        │     │
│  │  memory_read(), send_message() │     │
│  └────────────────────────────────┘     │
└──────────────────────────────────────────┘
```

### 6.2 SkillRegistry

```rust
pub struct SkillRegistry {
    skills: HashMap<String, SkillDefinition>,
    skills_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDefinition {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub trigger: SkillTrigger,
    pub dependencies: SkillDependencies,
    pub runtime: SkillRuntime,
    /// コンパイル済みJSコード
    pub compiled_js: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SkillTrigger {
    Message { pattern: String },
    Schedule { cron: String },
    Event { event_type: String },
    Manual,
}

impl SkillRegistry {
    /// skills/ ディレクトリをスキャンして登録
    pub fn scan(&mut self) -> Result<usize>;

    /// ホットリロード: 変更されたスキルを再ロード
    pub fn reload(&mut self, skill_id: &str) -> Result<()>;

    /// トリガー条件にマッチするスキルを検索
    pub fn match_trigger(&self, event: &PlatformEvent) -> Vec<&SkillDefinition>;
}
```

### 6.3 SandboxManager

```rust
pub struct SandboxManager {
    /// スキルごとのパーミッション
    permissions: HashMap<String, Vec<Permission>>,
}

#[derive(Debug, Clone)]
pub enum Permission {
    DbRead,
    DbWrite,
    MemoryRead,
    MemoryWrite,
    DiscordSend,
    SlackSend,
    CalendarRead,
    CalendarWrite,
    NetworkFetch { allowed_domains: Vec<String> },
    SkillInvoke { allowed_skills: Vec<String> },
}

impl SandboxManager {
    /// パーミッションチェック
    pub fn check(&self, skill_id: &str, permission: &Permission) -> bool;

    /// ホスト関数のバインディングを生成 (パーミッション付き)
    pub fn create_bindings(&self, skill_id: &str) -> HostFunctions;
}
```

### 6.4 TypeScript -> JavaScript ビルドパイプライン

```
skills/task-extract/index.ts
         │
         ▼ (swcまたはesbuild)
skills/task-extract/.build/index.js
         │
         ▼ (rquickjs)
QuickJS Runtime で実行
```

ビルドは以下のタイミングで実行:
- スキル登録時
- ホットリロード時
- SkillDevエージェントが新しいスキルを生成した時

---

## 7. 統合: 新しいクレート構成

### 7.1 追加クレート

| クレート | 責務 | Phase |
|---|---|---|
| `self-agent-credentials` | CredentialStore, OAuth2ヘルパー | 2 |
| `self-agent-cal-sync` | Google Calendar連携エージェント | 2 |
| `self-agent-reminder` | リマインダーエージェント | 2 |
| `self-agent-skill-runtime` | スキル実行環境 | 3 |

### 7.2 chat-bot クレートの変更

```
# 追加依存
slack-morphism = { version = "2", features = ["hyper"] }  # Phase 2
```

### 7.3 storage クレートの変更

```sql
-- 追加テーブル
CREATE TABLE IF NOT EXISTS credentials (...);       -- 認証情報
CREATE TABLE IF NOT EXISTS calendar_cache (...);    -- カレンダーキャッシュ
CREATE TABLE IF NOT EXISTS llm_usage (...);         -- LLM使用量
```

---

## 8. セットアップウィザードの拡張

### 8.1 フロー (全体)

```
Step 1/6: ストレージ
Step 2/6: LLMプロバイダー (マルチプロバイダー対応)
Step 3/6: Discord Bot
Step 4/6: Slack Bot [NEW]
Step 5/6: Google Calendar [NEW]
Step 6/6: 設定確認
```

### 8.2 Google Calendar セットアップ

```
━━━ Step 5/6: Google Calendar ━━━
  Google Calendar連携を設定しますか? (y/N): y

  セットアップ手順:
    1. https://console.cloud.google.com にアクセス
    2. プロジェクトを選択/作成
    3. API & Services → Enable APIs → Google Calendar API を有効化
    4. Credentials → Create Credentials → OAuth 2.0 Client ID
       - Application type: Desktop App
    5. Client ID と Client Secret をコピー

  Client ID: [入力]
  Client Secret: [入力]

  ブラウザで認証を行います...
  以下のURLをブラウザで開いてください:
  https://accounts.google.com/o/oauth2/v2/auth?client_id=...&scope=calendar...

  認証待機中... [OK] Google Calendar 認証成功
  → 利用可能なカレンダー:
    1. primary (your.email@gmail.com)
    2. Work Calendar
    3. 日本の祝日
  同期するカレンダー (カンマ区切り, 空で全て): 1,2

  [OK] Google Calendar 設定完了
```

### 8.3 Slack セットアップ

```
━━━ Step 4/6: Slack Bot ━━━
  Slack Bot連携を設定しますか? (y/N): y

  セットアップ手順:
    1. https://api.slack.com/apps にアクセス
    2. 「Create New App」→ 「From scratch」
    3. OAuth & Permissions → Bot Token Scopes:
       - chat:write, channels:history, channels:read,
       - im:history, im:read, im:write, app_mentions:read
    4. Install to Workspace → Bot User OAuth Token をコピー
    5. Basic Information → App-Level Tokens:
       - 「Generate Token」→ Scope: connections:write
       - App Token をコピー

  Bot Token (xoxb-...): [入力]
  App Token (xapp-...): [入力]

  接続テスト中... [OK] Slack Bot 接続成功: bot-name
```

---

## 9. 依存関係と実装順序

```
Phase 2 の実装順序:

1. CredentialStore (storage クレートに追加)
   ↓
2. ChatPlatform trait (chat-bot クレートをリファクタリング)
   ↓
3. Slack Bot 実装 (chat-bot/slack.rs)
   │
4. リマインダーエージェント (crates/reminder/)
   │
5. Google OAuth2 ヘルパー
   ↓
6. Google Calendar クライアント
   ↓
7. CalSync エージェント (crates/cal-sync/)
   ↓
8. セットアップウィザード更新 (Slack, Calendar 追加)

Phase 3:
9. スキルランタイム (crates/skill-runtime/)
10. SkillDev エージェント
```

---

## 10. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| Google OAuth2の複雑さ | Calendar連携の遅延 | ローカルサーバーでの認可コード受取を先に実装・テスト |
| Slack APIの変更頻度 | メンテナンスコスト | slack-morphism クレートに依存し、低レベルAPI直接操作を避ける |
| rquickjsのTypeScript非対応 | スキル開発体験の低下 | swcでのトランスパイルを自動化、開発者はTSのみ記述 |
| OAuth2トークンの期限切れ | Calendar連携の中断 | バックグラウンドでの自動リフレッシュ、期限切れ10分前にリフレッシュ |
| 複数プラットフォームのテスト | テストコスト増大 | ChatPlatform traitのモック実装でユニットテスト、E2Eは手動 |
