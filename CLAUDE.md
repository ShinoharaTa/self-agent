# self-agent

自分専用の自律型マルチエージェントBot。Rustで開発。

## 概要

ADHDエンジニアのタスク管理・情報整理を支援する自律型エージェントシステム。
Discord/Slackの会話からタスクを抽出・管理し、Googleカレンダーと連携してスケジューリングを行う。

- A2A (Agent-to-Agent) アーキテクチャで複数エージェントが協調動作
- シングルユーザー向け
- 要件定義書: `docs/REQUIREMENTS.md`
- アーキテクチャ設計: `docs/architecture/`

## ビルド方法

```bash
cargo check          # コンパイル確認
cargo build          # ビルド
cargo test --workspace  # 全テスト実行
cargo run            # 起動 (環境変数 or config/default.toml のトークン設定が必要)
```

## 環境変数

| 変数名 | 用途 |
|---|---|
| `DISCORD_TOKEN` | Discord Botトークン (config.tomlをオーバーライド) |
| `ANTHROPIC_API_KEY` | Claude APIキー (config.tomlをオーバーライド) |
| `RUST_LOG` | ログレベル (例: `info`, `debug`) |

## ディレクトリ構成

```
self-agent/
├── Cargo.toml              # workspace定義 + ルートバイナリ
├── src/main.rs             # エントリポイント
├── config/default.toml     # デフォルト設定
├── crates/
│   ├── core/               # Agent trait, MessageBus (mpsc), Message型, エラー型
│   ├── config/             # AppConfig (TOML読み込み + 環境変数オーバーライド)
│   ├── storage/            # SQLite (rusqlite) + 階層型MemoryStore
│   ├── llm-client/         # LlmProvider trait + Anthropic (Claude API) 実装
│   ├── task-manager/       # タスクCRUD・検索・サマリー (5テストあり)
│   ├── chat-bot/           # Discord Bot (serenity) + メンション検出
│   └── orchestrator/       # A2Aメッセージルーティング
└── docs/
    ├── REQUIREMENTS.md     # 要件定義書
    ├── Whiteboard.md       # 設計セッションメモ
    ├── architecture/       # ARCHITECTURE.md, CRATE_STRUCTURE.md, TECH_DECISIONS.md
    └── research/           # OpenClaw分析, A2Aプロトコル調査
```

## クレート依存関係

```
core ← orchestrator, chat-bot
storage ← task-manager
config, llm-client (独立)
ルートバイナリ → 全クレートに依存
```

## 主要な型

- `Agent` trait (`core/src/agent.rs`): id(), init(), handle_message(), tick(), shutdown()
- `AgentId` enum (`core/src/message.rs`): Orchestrator, TaskManager, CalSync, ChatBot, SkillDev, Reminder
- `Message` (`core/src/message.rs`): UUID, from/to, kind, payload(JSON), correlation_id, timestamp, priority
- `MessageBus` (`core/src/bus.rs`): tokio mpsc ベース、register/unregister/send/broadcast
- `Database` (`storage/src/sqlite.rs`): tasks, reminders, conversation_logs テーブル
- `MemoryStore` (`storage/src/memory.rs`): 階層型 (global / agents / context)
- `LlmProvider` trait (`llm-client/src/provider.rs`): chat() メソッド
- `AppConfig` (`config/src/lib.rs`): discord, storage, reaction, llm, agents セクション
