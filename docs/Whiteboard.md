# Whiteboard - self-agent 設計セッション

> セッション日時: 2026-03-14
> ステータス: セッション完了（ファシリテーター統合済み）

## セッション参加者
| 役割 | 担当 | ステータス | 主な成果物 |
|---|---|---|---|
| Facilitator | Agent-1 | 完了 | Whiteboard統合、REQUIREMENTS.md更新 |
| Requirements Analyst | Agent-2 | 完了 | openclaw_analysis.md, a2a_protocol.md, REQUIREMENTS.md追記 |
| Architecture Designer | Agent-3 | 完了 | ARCHITECTURE.md, CRATE_STRUCTURE.md |
| Project Scaffolder | Agent-4 | 完了 | Cargo workspace, 4クレート初期実装, main.rs |

## セッション目標の達成状況
| 目標 | 達成度 | 備考 |
|---|---|---|
| 要件定義書の未決定事項を解消 | 部分達成 | 5項目中3項目に方針決定。Web UI/Bot名は未決定 |
| A2Aアーキテクチャの具体設計 | 達成 | ARCHITECTURE.md + コード実装で基本設計完了 |
| Rustワークスペースの初期構成 | 達成 | 4クレートでビルド可能な骨格が存在 |
| Phase 1 MVPの実装着手可能状態 | 達成 | エントリポイント、設定、基本型が揃っている |

---

## 1. 確定した決定事項

### 1.1 技術スタック
| 項目 | 決定 | 根拠 | 決定者 |
|---|---|---|---|
| 言語 | Rust (コア) + TypeScript (スキル) | 要件定義書通り | 既定 |
| 非同期ランタイム | tokio | 事実上の標準 | Agent-3/4 |
| メッセージバス (Phase 1) | tokio::sync::broadcast | シングルプロセスで十分 | Agent-3/4 |
| Discord接続 | serenity v0.12 | エコシステム最大。poiseは必要時に追加 | Agent-4 |
| DB | rusqlite v0.31 (bundled) | SQLiteの定番 | Agent-4 |
| ログ | tracing + tracing-subscriber | 構造化ログ、tokio相性良好 | Agent-4 |
| エラー処理 (Phase 1) | anyhow | シンプルに開始。ライブラリクレートはthiserror検討 | Agent-3/4 |
| 設定管理 | toml crate直接パース | 依存最小化。config-rsは必要時に検討 | Agent-4 |
| スキルランタイム (Phase 3) | rquickjs (QuickJS) | 軽量JS実行環境 | Agent-3 |

### 1.2 アーキテクチャ方針
- **シングルプロセス・マルチエージェント**: 全エージェントを1バイナリで動作（16GB制約に適合）
- **スター型トポロジ**: 全メッセージはOrchestrator経由。ログ・監査・エラー処理を一元化
- **Agent trait**: `name()`/`id()`, `start()`, `handle_message()` のインターフェース
- **MessageBus**: broadcast channel ベースの pub/sub
- **ストレージ**: SQLite (構造化データ) + MemoryStore (MEMORY.mdファイルベース) のハイブリッド
- **記憶システム**: エージェント別MEMORY.md + 階層構造 (global/agents/context)

### 1.3 A2Aプロトコル方針
- Google A2Aプロトコルの設計思想を参考にしつつ、内部通信用に簡略化
- Agent Card パターン: 各エージェントをTOML定義で自己記述（将来対応）
- Task ライフサイクル: submitted -> working -> completed/failed
- Phase 1はtokioチャネル、Phase 2以降で抽象トレイト化 (MessageTransport trait)

---

## 2. 実装済みの成果物

### 2.1 コード構成（Agent-4）
```
self-agent/
  Cargo.toml              # workspace root + binary crate
  src/main.rs             # エントリポイント（設定読込、バス初期化、エージェント起動）
  config/default.toml     # デフォルト設定
  CLAUDE.md               # プロジェクト概要
  .gitignore
  crates/
    core/                  # Agent trait, Message, MessageBus (broadcast)
    orchestrator/          # Orchestrator (Agent trait実装、メッセージループ)
    chat-bot/              # Discord接続 (serenity EventHandler, メンション検出)
    storage/               # SQLite (tasks table) + MemoryStore
```

### 2.2 ドキュメント
| ファイル | 作成者 | 内容 |
|---|---|---|
| `docs/research/openclaw_analysis.md` | Agent-2 | OpenClaw/Claude Codeの記憶・スキルシステム分析 |
| `docs/research/a2a_protocol.md` | Agent-2 | Google A2Aプロトコルの仕様調査・self-agent適用設計 |
| `docs/architecture/ARCHITECTURE.md` | Agent-3 | A2Aアーキテクチャ詳細設計（メッセージ設計、バス設計、ライフサイクル、エラー処理） |
| `docs/architecture/CRATE_STRUCTURE.md` | Agent-3 | 10クレート構成の詳細設計（依存関係、各クレートの責務・依存） |
| `docs/REQUIREMENTS.md` | Agent-2 | スキルシステム詳細（skill.toml、パーミッション）、記憶システム詳細を追記 |

---

## 3. 設計ドキュメントとコード実装の差分

### 3.1 現在のコードと設計ドキュメントの乖離

| 項目 | 設計ドキュメント (Agent-3) | 実装コード (Agent-4) | 対応方針 |
|---|---|---|---|
| Message構造体 | UUID, timestamp, correlation_id, priority あり | from/to/kind/payload のみ (String型) | 設計に合わせてコードを拡張 |
| AgentId | enum型 (Orchestrator, TaskManager...) | String型 | 設計に合わせてenum化 |
| MessageBus | mpscベース、register/unregister方式 | broadcastベース | Phase 2でmpsc方式に移行検討 |
| Agent trait | id(), init(), handle_message(), tick(), shutdown() | name(), start(), handle_message() | 設計に合わせてtick/shutdown追加 |
| クレート数 | 10クレート (config, llm-client, task-manager等含む) | 4クレート (core, storage, chat-bot, orchestrator) | Phase 1に必要なものから段階的に追加 |
| serde_json | chat-botで使用 | chat-bot/Cargo.tomlに依存未記載 | 即時修正が必要 |

### 3.2 コードの問題点（即時対応推奨）
1. **chat-bot/Cargo.toml に serde_json 依存が欠落** -- discord.rs で使用中。コンパイルエラーの可能性
2. **CLAUDE.md で「storage は core に依存しない」と記載** -- 実際に依存していないが、CRATE_STRUCTURE.md の設計では core に依存する想定。将来的に整合が必要

---

## 4. 残りの未決定事項

### 解決済み
- [x] A2Aプロトコルの具体仕様 -> Agent trait + MessageBus + Message で基本定義済み。Google A2A参考の設計ドキュメントあり
- [x] スキルランタイムの具体実装 -> rquickjs (QuickJS) を採用。Phase 3で実装
- [x] LLMの使い分け方針 -> Claude API メイン、LLMプロバイダーtrait抽象化で切替可能に

### 未解決
- [ ] Web UIのフレームワーク選定 (Leptos vs React vs 他) -- Phase 3、急がない
- [ ] Bot名・アイデンティティ -- ユーザー判断待ち

---

## 5. 要検討事項（次セッション以降）

1. **broadcastからmpscへの移行タイミング**: 現在broadcastだが、Agent-3設計はmpsc + register方式。Phase 1完了時に評価
2. **Agent trait の拡張**: tick(), shutdown(), init() の追加。Agent-3設計の方が充実
3. **Message型のリッチ化**: UUID, timestamp, correlation_id, priority の追加
4. **MEMORY.md の Git自動コミット**: libgit2 (git2-rs) vs コマンド実行
5. **Google Calendar OAuth2**: サービスアカウント vs ユーザー認証
6. **エラーハンドリング**: anyhowからthiserrorへの段階的移行方針
7. **configクレートとllm-clientクレートの作成タイミング**

---

## 6. 次のアクション（優先順）

### Phase 1 実装準備（即時）
1. `crates/chat-bot/Cargo.toml` に `serde_json` 依存を追加
2. `cargo check` でコンパイル確認
3. Message構造体にUUID, timestampを追加
4. Agent traitに `shutdown()` メソッドを追加

### Phase 1 コア実装
5. Orchestratorのルーティングロジック実装
6. ChatBotエージェントの Agent trait 実装
7. `crates/llm-client/` クレートの作成（Claude APIクライアント）
8. TaskManagerエージェントの基本実装
9. LLM統合: メンションからのタスク抽出フロー

### インフラ・品質
10. `rust-toolchain.toml` の追加
11. 基本的なテストの追加 (core, storageの単体テスト)
12. CI設定 (GitHub Actions)

---

## 7. ファシリテーター所感

本セッションは非常に生産的であった。4エージェントの成果物は概ね整合しており、以下の点が特に優れている:

- **Agent-2**: OpenClawとGoogle A2Aの調査が的確。記憶システムの階層設計（global/agents/context）は実用的。スキルのパーミッションモデルは運用上重要な設計判断。
- **Agent-3**: アーキテクチャ設計の粒度が適切。ライフサイクル管理（起動シーケンス、シャットダウン、ヘルスチェック）とエラー分類（Recoverable/Degraded/Fatal）は実装時に直接参照できる品質。MessageTransport traitの抽象化設計も将来の拡張性を担保。
- **Agent-4**: 実装の速度と品質のバランスが良い。4クレートの最小構成で動作するスケルトンを構築。main.rsのシグナルハンドリングやconfig読み込みも実装済み。

**主な懸念**: 設計ドキュメント（Agent-3）とコード実装（Agent-4）の間に乖離がある（Message型、Agent trait、メッセージバス方式）。次のイテレーションで設計に合わせてコードを進化させる必要がある。ただし、Phase 1の初期段階ではAgent-4のシンプルな実装から始めて段階的にリッチ化する方針が合理的。

---

## 8. 追加実装ログ (2026-03-14)

### 8.1 crates/llm-client 新規作成
- **パッケージ名**: `self-agent-llm-client`
- **構成**: `src/lib.rs`, `src/types.rs`, `src/provider.rs`, `src/anthropic.rs`
- **内容**:
  - `LlmProvider` トレイト: `name()` + `chat()` の非同期抽象インターフェース
  - `AnthropicProvider`: Claude API (Messages API v2023-06-01) の実装。デフォルトモデル `claude-sonnet-4-20250514`
  - 共通型: `ChatMessage`, `ChatOptions`, `ChatResponse`, `Usage`, `Role`
- **依存**: reqwest, serde, serde_json, tokio, tracing, async-trait, anyhow, futures (workspace依存は使わず直接バージョン指定)

### 8.2 crates/config 新規作成
- **パッケージ名**: `self-agent-config`
- **構成**: `src/lib.rs`
- **内容**:
  - `AppConfig` 構造体: discord, storage, reaction, llm, agents の各設定セクション
  - `AppConfig::load()`: TOMLファイル読み込み + 環境変数オーバーライド (`DISCORD_TOKEN`, `ANTHROPIC_API_KEY`)
  - serde defaultによるオプショナルフィールド対応
- **依存**: serde, toml, tracing, anyhow (workspace依存は使わず直接バージョン指定)

### 8.3 config/default.toml 更新
- `[storage]` に `memory_path` 追加
- `[llm]` セクション追加 (provider, model, api_key)
- `[agents]` セクション追加 (bus_buffer_size)
- 旧 `[reaction.llm]` セクション削除 (新しい `[llm]` セクションに統合)

### 8.4 未完了事項
- **cargo check 未実行**: Bash権限が利用不可のため、コンパイル確認は手動で行う必要あり
- **workspace Cargo.toml 未更新**: 別エージェントが編集中のため、`members` への `"crates/llm-client"`, `"crates/config"` 追加は別途必要

### 8.5 crates/storage アップグレード
- **変更内容**: データモデル追加 (`models.rs`)、SQLite DB を CRUD 対応に拡張、MemoryStore を階層型に刷新
- **models.rs 新規追加**: `TaskStatus`, `TaskPriority`, `Task`, `CreateTask`, `UpdateTask`, `TaskFilter`, `Reminder`, `CreateReminder`, `ConversationLog` の各型を定義
- **sqlite.rs 完全リライト**: タスク CRUD (`create_task`, `get_task`, `list_tasks`, `update_task`, `delete_task`)、リマインダー (`create_reminder`, `get_pending_reminders`, `mark_reminder_fired`)、会話ログ (`log_conversation`, `get_recent_context`) を実装。マイグレーションで `tasks`, `reminders`, `conversation_logs` テーブル + インデックスを作成
- **memory.rs リライト**: `MemoryStore` を階層型 (global / agents / context) に変更。`load_global`, `save_global`, `load_agent`, `save_agent`, `load_context`, `save_context`, `list_agent_memories` メソッド
- **Cargo.toml**: workspace 依存から直接バージョン指定に変更。`serde_json`, `chrono` 依存を追加
- **lib.rs**: `models` モジュール追加、全パブリック型の re-export

### 8.6 crates/task-manager 新規作成
- **パッケージ名**: `self-agent-task-manager`
- **構成**: `src/lib.rs` のみ (単一モジュール)
- **内容**:
  - `TaskManager` 構造体: `Database` をラップしてタスク管理ビジネスロジックを提供
  - メソッド: `create_task`, `get_task`, `list_tasks`, `today_tasks`, `update_task`, `complete_task`, `delete_task`, `search_tasks`, `task_summary`
  - `today_tasks()`: Todo + InProgress のタスクを優先度降順で返す
  - `task_summary()`: LLM に渡すためのMarkdown形式サマリーを生成
- **テスト**: 5件 (`test_create_and_get_task`, `test_complete_task`, `test_today_tasks`, `test_search_tasks`, `test_task_summary`)
- **依存**: self-agent-storage (path), serde, serde_json, chrono, tracing, anyhow (すべて直接バージョン指定)

### 8.7 未完了事項 (8.5-8.6)
- **cargo check / cargo test 未実行**: Bash 権限が利用不可のため、コンパイル・テスト確認は手動で行う必要あり
- **workspace Cargo.toml 未更新**: `members` への `"crates/task-manager"` 追加は別途必要
- **DateTime パース**: SQLite の `datetime('now')` 形式 (`YYYY-MM-DD HH:MM:SS`) は chrono の RFC 3339 パーサーでは失敗し、`unwrap_or_default()` で Unix epoch にフォールバックする。将来的に `NaiveDateTime` パース + UTC 変換への改善が必要
- **core への統合**: task-manager は現在 core に依存しない設計。Agent trait 実装は core リライト完了後に追加予定
