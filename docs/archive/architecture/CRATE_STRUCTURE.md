# self-agent Rustクレート構成設計

## 1. Workspace構成

```
self-agent/
├── Cargo.toml                  # [workspace] 定義
├── crates/
│   ├── core/                   # A2Aメッセージバス、エージェントトレイト、共通型
│   ├── orchestrator/           # オーケストレーターエージェント
│   ├── task-manager/           # タスク管理エージェント
│   ├── cal-sync/               # Googleカレンダー連携エージェント
│   ├── chat-bot/               # Discord/Slack対話エージェント
│   ├── skill-runtime/          # TypeScriptスキル実行環境
│   ├── reminder/               # リマインドエージェント
│   ├── storage/                # SQLite + MEMORY.md 永続化層
│   ├── llm-client/             # LLM API クライアント抽象化
│   └── config/                 # 設定管理
├── skills/                     # TypeScriptスキルファイル置き場
├── data/                       # SQLite DB, MEMORY.md
└── docs/                       # ドキュメント
```

## 2. 各クレートの責務

### `self-agent-core`
**A2A基盤。全クレートの共通依存。**

- A2Aメッセージ型定義 (`A2AMessage`, `AgentId`, `MessageKind`)
- `Agent` トレイト定義
- `MessageBus` 実装 (tokio mpsc)
- `MessageTransport` トレイト（将来の抽象化用）
- 共通エラー型 (`SelfAgentError`)
- 共通ユーティリティ (リトライ、タイムスタンプ等)

```toml
[dependencies]
tokio = { version = "1", features = ["sync", "time", "macros"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4", "serde"] }
chrono = { version = "0.4", features = ["serde"] }
async-trait = "0.1"
thiserror = "2"
tracing = "0.1"
```

### `self-agent-storage`
**データ永続化レイヤー。SQLite + MEMORY.md。**

- SQLiteスキーマ管理（マイグレーション）
- タスク、イベント、会話履歴、リマインドのCRUD
- MEMORY.mdの読み書き
- リポジトリパターンによる抽象化

```toml
[dependencies]
self-agent-core = { path = "../core" }
rusqlite = { version = "0.32", features = ["bundled"] }
tokio = { version = "1", features = ["fs"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = { version = "0.4", features = ["serde"] }
tracing = "0.1"
```

### `self-agent-config`
**設定ファイルの読み込み・管理。**

- TOML設定ファイルのパース
- 環境変数からのオーバーライド
- 反応モード設定 (reaction config)
- APIキー管理（環境変数参照）

```toml
[dependencies]
self-agent-core = { path = "../core" }
serde = { version = "1", features = ["derive"] }
toml = "0.8"
tracing = "0.1"
```

### `self-agent-llm-client`
**LLM APIクライアント抽象化。**

- LLMプロバイダートレイト定義
- Claude API (Anthropic) クライアント実装
- OpenAI API クライアント実装
- プロンプトテンプレート管理
- ストリーミングレスポンス対応

```toml
[dependencies]
self-agent-core = { path = "../core" }
reqwest = { version = "0.12", features = ["json", "stream"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["sync"] }
tracing = "0.1"
async-trait = "0.1"
```

### `self-agent-orchestrator`
**中央ルーティング・調整エージェント。**

- メッセージルーティングロジック
- LLMによるインテント解釈
- 会話セッション管理
- エージェント健全性監視
- 承認フロー管理

```toml
[dependencies]
self-agent-core = { path = "../core" }
self-agent-llm-client = { path = "../llm-client" }
self-agent-config = { path = "../config" }
tokio = { version = "1", features = ["sync", "time"] }
serde_json = "1"
tracing = "0.1"
```

### `self-agent-task-manager`
**タスク管理エージェント。**

- タスクCRUD操作
- タスク検索・フィルタリング
- ステータス遷移管理
- 「今日やること」生成ロジック

```toml
[dependencies]
self-agent-core = { path = "../core" }
self-agent-storage = { path = "../storage" }
tokio = { version = "1", features = ["sync"] }
chrono = "0.4"
tracing = "0.1"
```

### `self-agent-cal-sync`
**Googleカレンダー連携エージェント。**

- Google Calendar API クライアント
- OAuth2トークン管理
- カレンダー同期ロジック
- 空き時間検出アルゴリズム
- ローカルキャッシュ管理

```toml
[dependencies]
self-agent-core = { path = "../core" }
self-agent-storage = { path = "../storage" }
self-agent-config = { path = "../config" }
reqwest = { version = "0.12", features = ["json"] }
tokio = { version = "1", features = ["sync", "time"] }
chrono = "0.4"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tracing = "0.1"
```

### `self-agent-chat-bot`
**Discord/Slack対話エージェント。**

- Discord接続 (serenity)
- Slack接続 (将来: slack-morphism)
- メッセージ受信・送信
- 反応モード制御
- 会話コンテキスト収集

```toml
[dependencies]
self-agent-core = { path = "../core" }
self-agent-config = { path = "../config" }
serenity = { version = "0.12", features = ["client", "gateway", "model", "cache"] }
tokio = { version = "1", features = ["sync"] }
tracing = "0.1"
```

### `self-agent-reminder`
**リマインドエージェント。**

- リマインドの登録・削除
- 時刻ベースの発火チェック
- 繰り返しリマインド対応

```toml
[dependencies]
self-agent-core = { path = "../core" }
self-agent-storage = { path = "../storage" }
tokio = { version = "1", features = ["sync", "time"] }
chrono = "0.4"
tracing = "0.1"
```

### `self-agent-skill-runtime`
**TypeScriptスキル実行環境。**

- JavaScriptランタイム管理 (rquickjs)
- スキルのロード・アンロード・ホットリロード
- スキルレジストリ
- Rustホスト関数のバインディング
- スキル間の依存解決

```toml
[dependencies]
self-agent-core = { path = "../core" }
self-agent-config = { path = "../config" }
rquickjs = { version = "0.8", features = ["bindgen", "loader", "futures"] }
tokio = { version = "1", features = ["sync", "fs"] }
serde_json = "1"
tracing = "0.1"
```

## 3. 依存関係図

```
                    ┌─────────┐
                    │  core   │  ← 全クレートが依存
                    └────┬────┘
                         │
            ┌────────────┼────────────┐
            │            │            │
       ┌────┴───┐  ┌────┴────┐  ┌────┴────┐
       │storage │  │  config │  │llm-client│
       └────┬───┘  └────┬────┘  └────┬────┘
            │            │            │
    ┌───────┼────────────┼────────────┤
    │       │            │            │
┌───┴──────┐│  ┌─────────┴──┐  ┌─────┴────────┐
│task-     ││  │ chat-bot   │  │ orchestrator │
│manager   ││  └────────────┘  └──────────────┘
└──────────┘│
    ┌───────┤
    │       │
┌───┴──────┐│  ┌──────────────┐
│ cal-sync ││  │skill-runtime │
└──────────┘│  └──────────────┘
┌───────────┘
│
┌┴─────────┐
│ reminder │
└──────────┘
```

### 依存関係ルール

1. **`core` は外部クレートのみに依存**する。他の自プロジェクトクレートへの依存は禁止。
2. **`storage` と `config` は `core` のみに依存**する。
3. **各エージェントクレートは `core` + 必要なインフラクレート**に依存する。
4. **エージェントクレート間の直接依存は禁止**。通信はすべてメッセージバス経由。
5. **`llm-client` はHTTPのみに依存**し、特定のLLMプロバイダーに強く結合しない。

## 4. バイナリクレート

ワークスペースルートにメインバイナリを配置:

```
self-agent/
├── src/
│   └── main.rs    # エントリーポイント: 全エージェントの起動・管理
```

`main.rs` は全エージェントクレートに依存し、起動シーケンスを実行する。

```toml
# Cargo.toml (workspace root)
[workspace]
members = [
    "crates/core",
    "crates/storage",
    "crates/config",
    "crates/llm-client",
    "crates/orchestrator",
    "crates/task-manager",
    "crates/cal-sync",
    "crates/chat-bot",
    "crates/skill-runtime",
    "crates/reminder",
]

[package]
name = "self-agent"
version = "0.1.0"
edition = "2021"

[dependencies]
self-agent-core = { path = "crates/core" }
self-agent-storage = { path = "crates/storage" }
self-agent-config = { path = "crates/config" }
self-agent-llm-client = { path = "crates/llm-client" }
self-agent-orchestrator = { path = "crates/orchestrator" }
self-agent-task-manager = { path = "crates/task-manager" }
self-agent-cal-sync = { path = "crates/cal-sync" }
self-agent-chat-bot = { path = "crates/chat-bot" }
self-agent-skill-runtime = { path = "crates/skill-runtime" }
self-agent-reminder = { path = "crates/reminder" }
tokio = { version = "1", features = ["full"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

## 5. ビルド・テスト方針

- **単体テスト**: 各クレート内に `#[cfg(test)]` モジュール
- **統合テスト**: ワークスペースルートの `tests/` ディレクトリ
- **CI**: `cargo test --workspace` で全テスト実行
- **ビルド時間最適化**: `core` の変更は波及が大きいため、APIを安定させることを優先
- **feature flags**: オプション機能は feature で制御
  - `slack`: Slack接続 (Phase 2で有効化)
  - `web-ui`: Web UI (Phase 3で有効化)
