# self-agent A2A アーキテクチャ設計書

## 1. 設計方針

- **シングルプロセス・マルチエージェント**: 全エージェントを1つのRustバイナリ内で動作させる。軽量かつ16GB RAM制約に適合。
- **メッセージパッシング**: エージェント間はtokio mpscチャネル経由の非同期メッセージで疎結合に通信。
- **Orchestrator中心のスター型トポロジ**: 全メッセージはOrchestratorを経由し、ルーティング・ロギング・エラーハンドリングを一元化。
- **将来の分散化パス**: メッセージバスをtokio mpscからNATS/Redis Streamsに差し替え可能な抽象化を維持。

---

## 2. A2Aメッセージ設計

### 2.1 メッセージフォーマット

```rust
/// A2Aメッセージの基本構造
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2AMessage {
    /// メッセージの一意識別子
    pub id: Uuid,
    /// 送信元エージェント
    pub from: AgentId,
    /// 宛先エージェント (None = broadcast)
    pub to: Option<AgentId>,
    /// メッセージ種別
    pub kind: MessageKind,
    /// ペイロード (JSON値)
    pub payload: serde_json::Value,
    /// 相関ID (リクエスト-レスポンスの紐付け)
    pub correlation_id: Option<Uuid>,
    /// タイムスタンプ
    pub timestamp: chrono::DateTime<chrono::Utc>,
    /// メッセージの優先度
    pub priority: Priority,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentId {
    Orchestrator,
    TaskManager,
    CalSync,
    ChatBot,
    SkillDev,
    Reminder,
    Skill(String), // 動的スキル
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MessageKind {
    /// リクエスト（応答を期待する）
    Request,
    /// レスポンス（Requestに対する応答）
    Response,
    /// 一方向通知（応答不要）
    Notification,
    /// イベント（状態変化の通知）
    Event,
    /// エラー
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Low = 0,
    Normal = 1,
    High = 2,
    Urgent = 3,
}
```

### 2.2 ペイロード規約

ペイロードは `serde_json::Value` として柔軟に保持するが、各エージェント間の通信には型付きペイロード構造体を定義する。

```rust
// 例: ChatBot → Orchestrator へのタスク追加リクエスト
#[derive(Debug, Serialize, Deserialize)]
pub struct TaskAddRequest {
    pub raw_text: String,
    pub context: ConversationContext,
    pub source: MessageSource,
}

// 例: Orchestrator → TaskManager へのタスク登録指示
#[derive(Debug, Serialize, Deserialize)]
pub struct TaskCreateCommand {
    pub title: String,
    pub description: Option<String>,
    pub due_date: Option<chrono::NaiveDate>,
    pub priority: TaskPriority,
    pub context_ref: Option<String>,
}
```

### 2.3 メッセージフロー例

```
ユーザー: "@bot このAPI設計来週までにまとめて"

1. [Discord] → ChatBot: ユーザーメッセージ受信
2. ChatBot → Orchestrator: Request(TaskAddRequest)
3. Orchestrator → TaskManager: Request(TaskCreateCommand)
   ※ Orchestratorが必要に応じてLLMで意図解釈
4. TaskManager → Orchestrator: Response(TaskCreated { id, title })
5. Orchestrator → ChatBot: Response(TaskCreated)
6. ChatBot → [Discord]: "タスク登録しました: 「API設計をまとめる」期限: 来週金曜"
```

---

## 3. メッセージバス設計

### 3.1 構造

```rust
pub struct MessageBus {
    /// 各エージェントへの送信チャネル
    agents: HashMap<AgentId, mpsc::Sender<A2AMessage>>,
    /// メッセージログ用チャネル (オプション)
    logger: Option<mpsc::Sender<A2AMessage>>,
}

impl MessageBus {
    /// エージェントを登録し、受信用Receiverを返す
    pub fn register(&mut self, id: AgentId, buffer_size: usize)
        -> mpsc::Receiver<A2AMessage>;

    /// メッセージを送信（宛先指定）
    pub async fn send(&self, msg: A2AMessage) -> Result<(), BusError>;

    /// ブロードキャスト（全エージェントに送信）
    pub async fn broadcast(&self, msg: A2AMessage) -> Result<(), BusError>;

    /// エージェントを登録解除
    pub fn unregister(&mut self, id: &AgentId);
}
```

### 3.2 チャネル設定

| エージェント | バッファサイズ | 理由 |
|---|---|---|
| Orchestrator | 256 | ハブとして最も多くのメッセージを処理 |
| ChatBot | 128 | Discord/Slackからのメッセージが集中する可能性 |
| TaskManager | 64 | タスク操作は比較的低頻度 |
| CalSync | 32 | カレンダー操作は低頻度 |
| Reminder | 32 | リマインド確認は低頻度 |
| SkillDev | 16 | オンデマンド起動 |

### 3.3 将来の拡張パス

```
Phase 1 (MVP):    tokio::sync::mpsc (インプロセス)
Phase 2:          抽象トレイト化 → テスト用モック差し替え可能に
Phase 3 (将来):   NATS / Redis Streams バックエンド追加
                  → マルチプロセス・マルチノード対応
```

抽象化のために `MessageTransport` トレイトを定義:

```rust
#[async_trait]
pub trait MessageTransport: Send + Sync {
    async fn send(&self, msg: A2AMessage) -> Result<(), BusError>;
    async fn recv(&mut self) -> Option<A2AMessage>;
    async fn broadcast(&self, msg: A2AMessage) -> Result<(), BusError>;
}
```

---

## 4. エージェント設計

### 4.1 エージェント共通トレイト

```rust
#[async_trait]
pub trait Agent: Send + Sync {
    /// エージェントのID
    fn id(&self) -> AgentId;

    /// 初期化処理
    async fn init(&mut self, bus: Arc<MessageBus>) -> Result<()>;

    /// メッセージ受信時のハンドラ
    async fn handle_message(&mut self, msg: A2AMessage) -> Result<Option<A2AMessage>>;

    /// 定期処理 (tick)。None = 定期処理なし
    fn tick_interval(&self) -> Option<Duration> { None }

    /// 定期処理の実行
    async fn tick(&mut self) -> Result<()> { Ok(()) }

    /// シャットダウン処理
    async fn shutdown(&mut self) -> Result<()>;
}
```

### 4.2 各エージェントの責務と境界

#### Orchestrator
- **責務**: メッセージルーティング、エージェント間調整、LLMによるインテント解釈
- **入力**: 全エージェントからのメッセージ
- **出力**: 適切なエージェントへのルーティング済みメッセージ
- **状態**: エージェント稼働状況、進行中の会話セッション
- **境界**: ビジネスロジックは持たない。判断が必要な場合はLLMに委譲。

#### TaskManager
- **責務**: タスクのCRUD、ステータス管理、検索、タスク一覧の生成
- **入力**: タスク操作コマンド (Create, Update, Delete, Query)
- **出力**: タスク操作結果、タスク一覧
- **状態**: SQLiteのtasksテーブルが真のソース
- **境界**: タスクの解釈・文脈理解はしない（Orchestratorが行う）。スケジューリングはCalSyncに委譲。

#### CalSync
- **責務**: Googleカレンダーとの同期、空き時間検出、予定の登録（承認後）
- **入力**: カレンダー操作コマンド (GetEvents, FindFreeSlots, CreateEvent)
- **出力**: カレンダーデータ、空き時間リスト
- **状態**: ローカルキャッシュ (SQLite) + Google Calendar API
- **tick**: 定期的にカレンダーを同期（15分間隔）
- **境界**: 予定の登録は必ずユーザー承認を経る。承認フローはOrchestrator経由でChatBotが担当。

#### ChatBot
- **責務**: Discord/Slackとの接続、ユーザーメッセージの受信・送信、反応モード制御
- **入力**: Discord/Slackイベント、Orchestratorからの応答メッセージ
- **出力**: ユーザーメッセージのA2A変換、Discordへのレスポンス送信
- **状態**: 接続状態、会話コンテキスト（直近数メッセージ）
- **境界**: メッセージの解釈・タスク抽出はしない。プラットフォーム固有の処理（Discord API等）を隠蔽する。

#### SkillDev
- **責務**: TypeScriptスキルの開発・テスト・デプロイ、スキルのホットリロード
- **入力**: スキル開発指示、スキル実行リクエスト
- **出力**: スキルの実行結果、開発レポート
- **状態**: スキルレジストリ（ロード済みスキル一覧）
- **境界**: オンデマンド起動。スキル実行環境（ランタイム）の管理が責務。LLMによるコード生成はOrchestratorが調整。

#### Reminder
- **責務**: リマインドの登録・管理・発火
- **入力**: リマインド設定コマンド、時刻トリガー
- **出力**: リマインド通知（Orchestrator経由でChatBotへ）
- **状態**: SQLiteのremindersテーブル
- **tick**: 1分間隔でリマインドの発火チェック
- **境界**: リマインドの発火のみが責務。ユーザーへの通知方法の決定はOrchestratorが行う。

### 4.3 エージェント間の通信パターン

```
                    ┌──────────────┐
          ┌────────>│ Orchestrator │<────────┐
          │         └──────┬───────┘         │
          │                │                 │
    ┌─────┴─────┐   ┌─────┴─────┐   ┌──────┴─────┐
    │  ChatBot  │   │TaskManager│   │  CalSync   │
    └───────────┘   └───────────┘   └────────────┘
          ^                                  ^
          │         ┌───────────┐            │
          └─────────│  Reminder │────────────┘
                    └───────────┘
                          ^
                    ┌─────┴─────┐
                    │ SkillDev  │
                    └───────────┘
```

全ての通信はOrchestratorを経由する（スター型）。これにより:
- メッセージのログ・監査が容易
- エージェント追加時の変更が最小
- エラーハンドリングを一元化

---

## 5. エージェントのライフサイクル管理

### 5.1 起動シーケンス

```
1. main() 開始
2. 設定ファイル読み込み (config.toml)
3. SQLite接続初期化
4. MessageBus 生成
5. 各エージェントの生成・MessageBusへの登録
   a. Orchestrator (最初に起動)
   b. TaskManager
   c. CalSync
   d. ChatBot
   e. Reminder
   f. SkillDev (遅延起動可)
6. 各エージェントの init() を呼び出し
7. 各エージェントをtokio::spawnでタスク起動
8. シグナルハンドラ登録 (SIGTERM, SIGINT)
9. 稼働開始
```

### 5.2 実行ループ

各エージェントは以下のループで動作:

```rust
async fn run_agent(mut agent: Box<dyn Agent>, mut rx: mpsc::Receiver<A2AMessage>) {
    let tick_interval = agent.tick_interval();
    let mut tick_timer = tick_interval.map(|d| tokio::time::interval(d));

    loop {
        tokio::select! {
            // メッセージ受信
            Some(msg) = rx.recv() => {
                if let Err(e) = agent.handle_message(msg).await {
                    tracing::error!(agent = ?agent.id(), "handle_message error: {e}");
                }
            }
            // 定期処理
            _ = async {
                if let Some(ref mut timer) = tick_timer {
                    timer.tick().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {
                if let Err(e) = agent.tick().await {
                    tracing::error!(agent = ?agent.id(), "tick error: {e}");
                }
            }
        }
    }
}
```

### 5.3 シャットダウン

```
1. SIGTERMまたはSIGINT受信
2. 全エージェントにShutdownメッセージをブロードキャスト
3. 各エージェントの shutdown() を呼び出し（タイムアウト: 10秒）
   - ChatBot: Discord/Slack接続をクローズ
   - CalSync: 未保存のキャッシュをフラッシュ
   - TaskManager: トランザクションをコミット
   - Reminder: 次回起動時に再チェックするためステートは永続化済み
4. MessageBusのチャネルをドロップ
5. SQLite接続クローズ
6. プロセス終了
```

### 5.4 エージェントの健全性監視

Orchestratorが各エージェントの生存を監視:

- **Heartbeat**: 各エージェントは30秒ごとにheartbeatを返す
- **応答タイムアウト**: Requestに対し30秒以内にResponseがなければタイムアウトエラー
- **再起動**: エージェントがパニックした場合、Orchestratorがtokio::spawnで再起動を試みる（最大3回）

---

## 6. エラーハンドリング

### 6.1 エラーの分類

| レベル | 例 | 対応 |
|---|---|---|
| Recoverable | API一時エラー、タイムアウト | リトライ (exponential backoff) |
| Degraded | カレンダーAPI不通 | 該当機能を一時無効化、他エージェントは継続 |
| Fatal | DB破損、設定不正 | ログ出力して安全にシャットダウン |

### 6.2 リトライポリシー

外部API呼び出し（Google Calendar, Discord, LLM）には共通のリトライラッパーを適用:

- 初回リトライ: 1秒後
- 最大リトライ: 5回
- バックオフ: 指数 (1s, 2s, 4s, 8s, 16s)
- サーキットブレーカー: 連続5回失敗で30秒間停止

---

## 7. セキュリティ考慮

- シングルユーザーのため認証は最小限（Tailscale ACLで制御）
- APIキー（Discord, Google, LLM）は環境変数またはシークレットファイルで管理
- MEMORY.mdをGit管理する場合、センシティブ情報を含めない運用ルールを策定
- SQLiteファイルのパーミッション制限 (0600)
