# self-agent

自分専用の自律型マルチエージェントBot。Rustで開発。

## 概要

ADHDエンジニアのタスク管理・情報整理を支援する自律型エージェントシステム。
Discord/Slackの会話からタスクを抽出・管理し、Googleカレンダーと連携してスケジューリングを行う。

- A2A (Agent-to-Agent) アーキテクチャで複数エージェントが協調動作
- シングルユーザー向け
- 要件定義書: `docs/REQUIREMENTS.md`

## ビルド方法

```bash
cargo check   # コンパイル確認
cargo build   # ビルド
cargo test    # テスト実行
cargo run     # 起動 (config/default.toml のトークン設定が必要)
```

## ディレクトリ構成

```
self-agent/
├── Cargo.toml              # workspace定義 + ルートバイナリ
├── src/main.rs             # エントリポイント
├── config/default.toml     # デフォルト設定
├── crates/
│   ├── core/               # Agent trait, メッセージバス, メッセージ型
│   ├── storage/            # SQLite (rusqlite) + MEMORY.md管理
│   ├── chat-bot/           # Discord Bot (serenity)
│   └── orchestrator/       # エージェント間ルーティング
└── docs/
    ├── REQUIREMENTS.md     # 要件定義書
    └── Whiteboard.md       # 設計セッションメモ
```

## クレート依存関係

- `core`: 他の全クレートが依存する基盤
- `storage`: 独立 (coreに依存しない)
- `chat-bot`: core に依存
- `orchestrator`: core に依存
- ルートバイナリ: 全クレートに依存

## 主要な型

- `Agent` trait (`crates/core/src/agent.rs`): 全エージェントが実装するインターフェース
- `Message` / `MessageKind` (`crates/core/src/message.rs`): エージェント間通信の型
- `MessageBus` (`crates/core/src/bus.rs`): tokio broadcast ベースのメッセージバス
- `Database` (`crates/storage/src/sqlite.rs`): SQLiteラッパー
