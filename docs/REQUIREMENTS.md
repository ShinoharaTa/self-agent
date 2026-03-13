# self-agent 要件定義書

> 自分専用の自律型マルチエージェントBot

## 1. プロジェクト概要

### 1.1 目的
ADHDエンジニアのタスク管理・情報整理を支援する自律型エージェントシステム。
Discord/Slackの会話からタスクを抽出・管理し、Googleカレンダーと連携してスケジューリングを行う。

### 1.2 コンセプト
- OpenClawを参考にした自律型エージェント
- **A2A (Agent-to-Agent) アーキテクチャ**: 役割別の複数Botが協調動作
- スキルシステムによる自己拡張
- 自分専用（シングルユーザー）

---

## 2. アーキテクチャ

### 2.1 全体構成

```
┌─────────────────────────────────────────────────────┐
│                   self-agent Core (Rust)             │
│                                                     │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐       │
│  │ Orchestrator│  │ Agent     │  │ Skill     │       │
│  │ (A2A Hub)  │──│ Registry  │──│ Runtime   │       │
│  └─────┬─────┘  └───────────┘  └─────┬─────┘       │
│        │                              │             │
│  ┌─────┴─────────────────────────┐    │             │
│  │        Message Bus             │    │             │
│  └─────┬─────┬──────┬──────┬────┘    │             │
│        │     │      │      │         │             │
│  ┌─────┴┐ ┌─┴────┐ ┌┴────┐ ┌┴─────┐  │             │
│  │Agent │ │Agent │ │Agent│ │Agent │  │             │
│  │Task  │ │Cal   │ │Chat │ │Skill │  │             │
│  │Mgr   │ │Sync  │ │Bot  │ │Dev   │  │             │
│  └──────┘ └──────┘ └─────┘ └──────┘  │             │
│                                       │             │
│  ┌────────────┐  ┌────────────┐  ┌───┴────────┐    │
│  │ SQLite     │  │ MEMORY.md  │  │ Skills     │    │
│  │ (tasks,    │  │ (agent     │  │ (TypeScript │    │
│  │  events,   │  │  memory)   │  │  plugins)  │    │
│  │  history)  │  │            │  │            │    │
│  └────────────┘  └────────────┘  └────────────┘    │
└──────────┬──────────────┬───────────────┬───────────┘
           │              │               │
     ┌─────┴─────┐ ┌─────┴─────┐  ┌──────┴──────┐
     │ Discord   │ │ Slack     │  │ Google      │
     │ (~20 svr) │ │           │  │ Calendar    │
     └───────────┘ └───────────┘  └─────────────┘
           │
     ┌─────┴──────┐
     │ Web UI     │
     │ (Tailscale)│
     └────────────┘
```

### 2.2 A2Aエージェント構成

| エージェント | 役割 | 常駐 |
|---|---|---|
| **Orchestrator** | エージェント間の調整・ルーティング | Yes |
| **TaskManager** | タスクの抽出・整理・管理 | Yes |
| **CalSync** | Googleカレンダー連携・スケジューリング | Yes |
| **ChatBot** | ユーザーとの対話インターフェース | Yes |
| **SkillDev** | スキルの自己開発・管理 | On-demand |
| **Reminder** | リマインド・通知 | Yes |

### 2.3 A2Aプロトコル仕様（Google A2A準拠）

#### 2.3.1 プロトコル概要

Google A2A (Agent-to-Agent) プロトコルに準拠した内部通信方式を採用。
HTTP + JSON-RPCベースで、各エージェントがサーバーとして動作し、タスクを受け付ける。

**設計原則:**
- Simple: 標準的なHTTP/JSON-RPCで実装
- Async-first: 長時間タスクのストリーミング対応
- Opaque execution: エージェント内部の実装を隠蔽

#### 2.3.2 Agent Card（エージェント定義）

各エージェントはTOMLファイルで自己記述:

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
```

#### 2.3.3 タスクライフサイクル

```
submitted → working → completed
                   ↘ failed
                   ↘ canceled
                   ↘ input-required (追加入力待ち)
```

#### 2.3.4 A2Aエンドポイント

| メソッド | 説明 |
|---|---|
| `tasks/send` | タスクを送信して完了まで待つ（同期） |
| `tasks/sendSubscribe` | タスクを送信してSSEストリーミング |
| `tasks/get` | タスクの状態を取得 |
| `tasks/cancel` | タスクをキャンセル |

#### 2.3.5 メッセージ構造

```rust
// メッセージは role + parts で構成
pub struct Message {
    pub role: Role,      // User | Agent
    pub parts: Vec<Part>,
}

pub enum Part {
    Text { text: String },
    Data { data: serde_json::Value },
    File { uri: String, mime_type: String },
}
```

#### 2.3.6 通信方式の段階的移行

| Phase | 方式 | 説明 |
|---|---|---|
| Phase 1 | tokio::mpsc channel | 同一プロセス内、最速・型安全 |
| Phase 2 | HTTP JSON-RPC | A2A準拠、プロセス分離可能 |
| Phase 3 | HTTP + SSE | ストリーミング対応 |

通信方式を隠蔽する抽象化レイヤー (`AgentTransport` trait) を設け、Phase移行時にコア実装を変更しない設計とする。

```rust
#[async_trait]
pub trait AgentTransport {
    async fn send(&self, agent: &str, task: Task) -> Result<TaskResult>;
    async fn send_subscribe(&self, agent: &str, task: Task) -> Result<TaskStream>;
    async fn get(&self, task_id: &str) -> Result<TaskStatus>;
    async fn cancel(&self, task_id: &str) -> Result<()>;
}
```

#### 2.3.7 MCPとの関係

- **A2A**: エージェント間通信（Orchestrator ↔ 各エージェント）
- **MCP (Model Context Protocol)**: エージェント ↔ 外部ツール（将来対応）
  - Google Calendar API、GitHub API等をMCPサーバーとして接続

### 2.4 技術スタック

| レイヤー | 技術 |
|---|---|
| コアランタイム | Rust |
| スキルランタイム | TypeScript (Deno or V8 embed) |
| データベース | SQLite |
| エージェント記憶 | MEMORY.md (Git管理) |
| LLM | Claude API (Claude Code SDK) / OpenAI Codex |
| Web UI | 未定 (候補: Leptos / React) |
| ネットワーク | Tailscale (将来的にCloudflare Tunnel) |

---

## 3. 機能要件

### 3.1 Discord/Slack接続

- **接続規模**: Discord ~20サーバー、Slack (数未定)
- **反応トリガー**:
  - メンション時: LLMで解釈して応答
  - 自分(shino3)の投稿への返信: 応答
  - ルールベース/LLMベースの反応を設定で切替可能
- **タスク追加フロー**:
  1. ユーザーがBotにメンション（例: `@bot このAPI設計来週までにまとめて`）
  2. Botが前後の会話コンテキストを読み取り
  3. LLMがタスク内容・期限・背景を解釈
  4. 対話で確認 → タスク登録

### 3.2 タスク管理

- タスクのCRUD (作成・参照・更新・削除)
- 会話文脈の紐付け保存（どの会話から生まれたタスクか）
- ステータス管理 (未着手 / 進行中 / 完了 / 保留)
- 優先度・期限の管理
- 「今日やること教えて」で整理済み一覧を返す

### 3.3 Googleカレンダー連携

- 複数カレンダーの読み取り
- 空き時間の検出
- **確定作業のみ**スケジュール登録（日付未定は入れない）
- **承認制**: Bot提案 → ユーザー承認 → 登録
- 予定の確認・検索

### 3.4 対話インターフェース

- Discord/Slack上での自然言語対話
- タスク一覧・検索
- 予定確認
- 文脈検索（「あのSlackで話してた件」）
- リマインド設定

### 3.5 リマインド

- ユーザーが依頼した時に設定
- 期限ベースのリマインド
- （自発的な通知はユーザーが依頼した場合のみ）

### 3.6 反応モード設定

```toml
# 設定例
[reaction]
mode = "rule_based"  # "rule_based" | "llm" | "hybrid"

[reaction.rules]
mention = true          # メンションに反応
reply_to_self = true    # 自分の投稿へのリプに反応
keyword_trigger = []    # 特定キーワードで反応 (将来用)

[reaction.llm]
always_on = false       # 全メッセージをLLMに流す
channels = []           # LLM反応するチャンネル指定
```

### 3.7 スキルシステム

- TypeScriptでスキルを記述
- Botが自分でスキルを開発（LLMコード生成 → テスト → ロード）
- A2Aエージェント間でスキルを共有
- ホットリロード対応
- スキルのバージョン管理 (Git)

#### 3.7.1 スキル構造

```
skills/
├── manifest.json              # スキル一覧・メタデータ（自動生成）
├── task-extract/
│   ├── skill.toml             # スキル定義
│   ├── index.ts               # TypeScript実装
│   └── test.ts                # テストコード
└── calendar-check/
    ├── skill.toml
    ├── index.ts
    └── test.ts
```

#### 3.7.2 スキル定義 (skill.toml)

```toml
[skill]
name = "task-extract"
version = "0.1.0"
description = "会話からタスクを抽出する"
author = "SkillDev"           # 作成したエージェント

[trigger]
type = "message"              # "message" | "schedule" | "event" | "manual"
pattern = "タスク|TODO|やること"

[dependencies]
agents = ["TaskManager"]      # 依存するエージェント
permissions = ["db:write", "memory:read"]  # 必要な権限

[runtime]
timeout_ms = 30000
max_memory_mb = 64
```

#### 3.7.3 スキルのライフサイクル

1. **定義**: SkillDevエージェントがLLMでコード生成 or ユーザーが手動作成
2. **テスト**: 自動テスト実行、失敗時はSkillDevが修正
3. **登録**: skills/ディレクトリに配置 → manifest.json自動更新
4. **ロード**: SkillRuntimeがホットリロード
5. **呼び出し**: エージェントがトリガー条件に基づいて呼び出し
6. **バージョン管理**: Gitコミットでバージョン追跡

#### 3.7.4 スキルのパーミッションモデル

| パーミッション | 説明 |
|---|---|
| `db:read` | SQLiteの読み取り |
| `db:write` | SQLiteへの書き込み |
| `memory:read` | MEMORY.mdの読み取り |
| `memory:write` | MEMORY.mdへの書き込み |
| `discord:send` | Discordへのメッセージ送信 |
| `slack:send` | Slackへのメッセージ送信 |
| `calendar:read` | Googleカレンダーの読み取り |
| `calendar:write` | Googleカレンダーへの書き込み（承認制） |
| `network:fetch` | 外部HTTPリクエスト |
| `skill:invoke` | 他スキルの呼び出し |

### 3.8 記憶システム

- **MEMORY.md**: エージェントの長期記憶（Git管理、OpenClaw/Claude Code参考）
  - ユーザーの好み・行動パターン
  - 学習した知識
  - エージェント設定 (AGENT.md)
- **SQLite**: 構造化データ
  - タスク
  - イベント
  - 会話履歴
  - スキルメタデータ

#### 3.8.1 記憶の階層構造（Claude Code CLAUDE.md 参考）

```
memory/
├── global.md                  # ユーザープロファイル（好み・行動パターン）
├── agents/
│   ├── orchestrator.md        # Orchestratorの学習記憶
│   ├── task_manager.md        # TaskManagerの学習記憶
│   ├── cal_sync.md            # CalSyncの学習記憶
│   ├── chat_bot.md            # ChatBotの学習記憶
│   ├── skill_dev.md           # SkillDevの学習記憶
│   └── reminder.md            # Reminderの学習記憶
└── context/
    ├── discord_servers.md     # Discordサーバー別のコンテキスト
    └── projects.md            # プロジェクト別のコンテキスト
```

#### 3.8.2 記憶の内容カテゴリ

| カテゴリ | 保存先 | 例 |
|---|---|---|
| ユーザーの好み | `memory/global.md` | 「通知は朝9時以降」「絵文字は控えめ」 |
| エージェント学習 | `memory/agents/*.md` | 「このサーバーではフォーマルな口調」 |
| タスクパターン | `memory/agents/task_manager.md` | 「月曜に週次レビューのタスクが多い」 |
| サーバーコンテキスト | `memory/context/*.md` | 各Discordサーバーの慣習・メンバー情報 |
| 構造化データ | SQLite | タスク、イベント、会話ログ |

#### 3.8.3 記憶の書き込みルール

1. **エージェント自身が書き換え可能**: 学習した知識を自分のMEMORY.mdに記録
2. **Git自動コミット**: 記憶変更時に自動でGitコミット（変更履歴を保持）
3. **コンフリクト解決**: 複数エージェントが同時に書き込む場合はOrchestratorが調停
4. **記憶の鮮度管理**: 古い情報にはタイムスタンプを付与、定期的にレビュー
5. **サイズ制限**: 各MEMORY.mdは一定サイズ以内に要約（コンテキストウィンドウ節約）

#### 3.8.4 コンテキストウィンドウ管理

- 会話が長くなった場合、重要情報をMEMORY.mdに書き出してからサマリ化
- LLMへのプロンプト構成: `MEMORY.md + 直近の会話 + タスクコンテキスト`
- 各エージェントのMEMORY.mdはそのエージェントのプロンプトにのみ含める

### 3.9 設定管理

- AGENT.md: エージェントの振る舞い設定（Bot自身が書き換え可能）
- 設定変更はGitにコミット
- TOML/YAMLベースの構造化設定

---

## 4. 非機能要件

| 項目 | 要件 |
|---|---|
| 可用性 | 自宅サーバーで常時稼働 |
| リソース | メモリ16GB以内 |
| 認証 | シングルユーザー（自分専用） |
| ネットワーク | Tailscale経由でWeb UIアクセス |
| 拡張性 | スキルシステムによる無限拡張 |
| LLMコスト | 常時監視はしない。反応トリガー制御で節約 |
| データ保全 | SQLite + MEMORY.md (Git) でバックアップ可能 |

---

## 5. やらないこと（スコープ外）

- PRの自動作成・コード変更の自動適用
- マルチユーザー対応
- 公開サービスとしての運用
- モバイルアプリ

---

## 6. MVP (フェーズ1) スコープ案

### Phase 1: コア基盤
1. Rustプロジェクト基盤 + A2Aメッセージバス
2. Discord接続 (1サーバーでテスト)
3. メンションでタスク追加（LLM解釈 + 文脈読み取り）
4. タスク一覧・検索（Bot対話）
5. SQLite + MEMORY.md 記憶基盤
6. 反応モード設定 (ルールベース)

### Phase 2: 連携拡大
7. Googleカレンダー連携
8. Slack接続
9. リマインド機能
10. Discord全サーバー展開

### Phase 3: 自律拡張
11. スキルシステム (TypeScript Runtime)
12. Botによるスキル自己開発
13. Web UI

---

## 7. エージェント間フロー例

### 7.1 Discord メンションからタスク登録

```
1. Discord → ChatBot: メッセージ受信（メンション検知）
2. ChatBot → Orchestrator: tasks/send (意図解釈依頼)
3. Orchestrator → TaskManager: tasks/send (タスク抽出)
4. TaskManager → Orchestrator: response (抽出結果 + 確認メッセージ)
5. Orchestrator → ChatBot: response (確認メッセージ)
6. ChatBot → Discord: 「このタスクを登録しますか？」
7. (ユーザーが承認)
8. ChatBot → Orchestrator: tasks/send (タスク登録確定)
9. Orchestrator → TaskManager: tasks/send (DB登録)
10. Orchestrator → CalSync: tasks/send (カレンダー登録提案、期限がある場合)
```

### 7.2 「今日やること教えて」

```
1. Discord → ChatBot: メッセージ受信
2. ChatBot → Orchestrator: tasks/send (今日のタスク取得)
3. Orchestrator → TaskManager: tasks/send (期限=今日のタスク一覧)
4. Orchestrator → CalSync: tasks/send (今日の予定一覧)
5. Orchestrator → ChatBot: response (統合された今日のスケジュール)
6. ChatBot → Discord: 整理済み一覧を返信
```

---

## 8. 未決定事項

- [ ] Web UIのフレームワーク選定 (Leptos vs React vs 他)
- [ ] スキルランタイムの具体実装 (Deno embed vs V8 vs 他)
- [ ] LLMの使い分け方針 (Claude vs Codex の棲み分け)
- [x] ~~A2Aプロトコルの具体仕様~~ → セクション2.3で定義済み
- [ ] Bot名・アイデンティティ
- [ ] MEMORY.mdのサイズ上限（各ファイルの推奨最大行数）
- [ ] エージェント間通信の認証方式（内部通信のため簡略化候補）
- [ ] スキルのサンドボックス実装方式（Deno permissions / V8 isolate）
