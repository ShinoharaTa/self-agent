# Google A2A (Agent-to-Agent) プロトコル調査

> 調査日: 2026-03-14
> 調査者: Agent-2 (Requirements Analyst)
> 注: WebSearch/WebFetchが制限されていたため、既知の情報に基づく分析

## 1. A2Aプロトコル概要

Google A2A (Agent-to-Agent) プロトコルは、2025年4月にGoogleが発表したエージェント間通信のオープンプロトコル。異なるフレームワーク・ベンダーで構築されたAIエージェント同士が、標準化された方法で連携できるようにする仕組み。

### 1.1 設計原則
1. **Simple**: HTTP + JSON-RPCベースで既存のWeb技術を活用
2. **Enterprise-ready**: 認証・認可・セキュリティを考慮
3. **Async-first**: 長時間タスクのストリーミング・プッシュ通知対応
4. **Modality-agnostic**: テキスト、画像、音声など様々なモダリティに対応
5. **Opaque execution**: エージェント内部の実装詳細を隠蔽

## 2. コアコンセプト

### 2.1 Agent Card（エージェントカード）

エージェントの自己記述メタデータ。`/.well-known/agent.json` で公開される。

```json
{
  "name": "TaskManager",
  "description": "タスクの抽出・整理・管理を行うエージェント",
  "url": "http://localhost:8001",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false
  },
  "skills": [
    {
      "id": "task-extract",
      "name": "タスク抽出",
      "description": "会話からタスクを抽出する",
      "inputModes": ["text"],
      "outputModes": ["text", "data"]
    },
    {
      "id": "task-list",
      "name": "タスク一覧",
      "description": "タスクの一覧を返す",
      "inputModes": ["text"],
      "outputModes": ["text", "data"]
    }
  ],
  "authentication": {
    "schemes": ["bearer"]
  }
}
```

### 2.2 Task（タスク）

A2Aの基本作業単位。クライアントがサーバーエージェントに送信する。

**タスクのライフサイクル:**
```
submitted → working → completed
                  ↘ failed
                  ↘ canceled
                  ↘ input-required (追加入力待ち)
```

**タスク構造:**
```json
{
  "id": "task-uuid-123",
  "status": {
    "state": "working",
    "message": {
      "role": "agent",
      "parts": [{"type": "text", "text": "タスクを処理中..."}]
    }
  },
  "artifacts": [
    {
      "name": "extracted-tasks",
      "parts": [{"type": "data", "data": {"tasks": [...]}}]
    }
  ],
  "history": [
    {"role": "user", "parts": [{"type": "text", "text": "このAPI設計来週までにまとめて"}]},
    {"role": "agent", "parts": [{"type": "text", "text": "タスクとして登録しました"}]}
  ]
}
```

### 2.3 Message（メッセージ）

エージェント間の通信単位。`role`（user/agent）と`parts`で構成。

**Part の種類:**
- `TextPart`: テキストデータ
- `FilePart`: ファイル（バイナリ/URI）
- `DataPart`: 構造化データ（JSON）

### 2.4 Artifact（成果物）

タスク実行の結果として生成される出力。

## 3. プロトコル仕様

### 3.1 エンドポイント

A2AはHTTP + JSON-RPCベース:

| メソッド | 説明 |
|---|---|
| `tasks/send` | タスクを送信して完了まで待つ |
| `tasks/sendSubscribe` | タスクを送信してSSEでストリーミング |
| `tasks/get` | タスクの状態を取得 |
| `tasks/cancel` | タスクをキャンセル |
| `tasks/pushNotification/set` | プッシュ通知を設定 |
| `tasks/pushNotification/get` | プッシュ通知設定を取得 |

### 3.2 通信パターン

**同期パターン:**
```
Client ──tasks/send──> Server Agent
Client <──response──── Server Agent
```

**ストリーミングパターン:**
```
Client ──tasks/sendSubscribe──> Server Agent
Client <──SSE: status update──── Server Agent
Client <──SSE: status update──── Server Agent
Client <──SSE: artifact──────── Server Agent
Client <──SSE: completed──────── Server Agent
```

**プッシュ通知パターン:**
```
Client ──tasks/send──────────────> Server Agent
Client <──accepted─────────────── Server Agent
        ... (非同期処理) ...
Client <──webhook notification──── Server Agent
```

## 4. self-agentへの適用設計

### 4.1 内部A2Aアーキテクチャ

self-agentではA2Aを**内部通信プロトコル**として採用する。外部公開ではなくローカルプロセス間通信。

```
┌─────────────────────────────────────────┐
│           Orchestrator (A2A Hub)         │
│         localhost:8000                   │
│                                          │
│  Agent Registry:                         │
│  ┌──────────────┬───────────────────┐    │
│  │ Agent        │ URL               │    │
│  ├──────────────┼───────────────────┤    │
│  │ TaskManager  │ localhost:8001    │    │
│  │ CalSync      │ localhost:8002    │    │
│  │ ChatBot      │ localhost:8003    │    │
│  │ SkillDev     │ localhost:8004    │    │
│  │ Reminder     │ localhost:8005    │    │
│  └──────────────┴───────────────────┘    │
└─────────────────────────────────────────┘
```

### 4.2 self-agent用のAgent Card簡略版

外部公開しないため、認証は簡略化。ローカル通信に最適化。

```toml
# agents/task_manager/agent.toml
[agent]
name = "TaskManager"
description = "タスクの抽出・整理・管理"
port = 8001
always_on = true

[capabilities]
streaming = true
push_notifications = false

[[skills]]
id = "task-extract"
name = "タスク抽出"
description = "会話テキストからタスクを抽出"
input_modes = ["text"]
output_modes = ["text", "data"]

[[skills]]
id = "task-list"
name = "タスク一覧"
description = "条件に合うタスク一覧を返す"
input_modes = ["text"]
output_modes = ["data"]

[[skills]]
id = "task-update"
name = "タスク更新"
description = "タスクの状態を更新"
input_modes = ["data"]
output_modes = ["data"]
```

### 4.3 メッセージバス設計

内部通信ではHTTPの代わりに、より軽量な方法も検討:

| 方式 | メリット | デメリット |
|---|---|---|
| HTTP (JSON-RPC) | A2A準拠、デバッグ容易 | オーバーヘッド |
| Unix Domain Socket | 高速、ローカル最適 | A2Aから逸脱 |
| tokio::mpsc channel | 最速、型安全 | プロセス内限定 |
| gRPC | 型安全、ストリーミング | 複雑 |

**推奨**: Phase 1ではtokio::mpsc（同一プロセス内）、Phase 2でHTTP JSON-RPCに移行可能な抽象化レイヤーを設ける。

### 4.4 タスクフロー例

**Discord メンションからタスク登録:**

```
1. Discord → ChatBot: メッセージ受信
2. ChatBot → Orchestrator: tasks/send (意図解釈依頼)
3. Orchestrator → TaskManager: tasks/send (タスク抽出)
4. TaskManager → Orchestrator: response (抽出結果)
5. Orchestrator → ChatBot: response (確認メッセージ生成)
6. ChatBot → Discord: 確認メッセージ送信
7. (ユーザー確認後)
8. ChatBot → Orchestrator: tasks/send (タスク登録確定)
9. Orchestrator → TaskManager: tasks/send (タスク登録)
10. Orchestrator → CalSync: tasks/send (カレンダー登録提案)
```

### 4.5 A2Aメッセージの内部表現 (Rust)

```rust
/// A2Aメッセージの内部表現
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2AMessage {
    pub id: String,
    pub method: String,           // "tasks/send", "tasks/get", etc.
    pub from_agent: String,
    pub to_agent: String,
    pub task: Task,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub status: TaskStatus,
    pub history: Vec<Message>,
    pub artifacts: Vec<Artifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TaskState {
    Submitted,
    Working,
    Completed,
    Failed,
    Canceled,
    InputRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,  // User | Agent
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Part {
    Text { text: String },
    Data { data: serde_json::Value },
    File { uri: String, mime_type: String },
}
```

## 5. MCP (Model Context Protocol) との関係

A2Aは**エージェント間**の通信プロトコル、MCPは**エージェントとツール間**の通信プロトコル。

```
┌─────────┐   A2A    ┌─────────┐
│ Agent A │◄────────►│ Agent B │
└────┬────┘          └────┬────┘
     │ MCP                │ MCP
     ▼                    ▼
┌─────────┐          ┌─────────┐
│ Tool 1  │          │ Tool 2  │
└─────────┘          └─────────┘
```

self-agentでの使い分け:
- **A2A**: Orchestrator ↔ 各エージェント間
- **MCP (将来)**: エージェント ↔ 外部ツール（GitHub、Google Calendar API等）

## 6. まとめ

### self-agentに適用するA2A設計パターン

1. **Agent Card パターン**: 各エージェントをTOML定義ファイルで自己記述
2. **Task ライフサイクル**: submitted → working → completed/failed の状態管理
3. **Message/Part 構造**: テキスト・データ・ファイルを統一フォーマットで送受信
4. **Orchestrator パターン**: ハブ型のルーティングで複雑な連携を管理
5. **ストリーミング**: 長時間タスクのリアルタイム進捗通知
6. **抽象化レイヤー**: 通信方式を隠蔽し、将来の変更に備える
