# self-agent 技術選定ドキュメント

## 概要

各技術選定の判断根拠を記録する。16GB RAMの自宅サーバーで常時稼働することを前提とする。

---

## 1. スキルランタイム

TypeScriptスキルを実行するためのJavaScript埋め込みエンジンの選定。

### 候補比較

| 項目 | deno_core | boa_engine | rquickjs |
|---|---|---|---|
| ベースエンジン | V8 | 独自実装 (Rust) | QuickJS (C) |
| メモリ使用量 | 大 (~50-100MB) | 中 (~20-40MB) | 小 (~5-15MB) |
| 実行速度 | 非常に速い (JIT) | 遅い (インタプリタ) | 中程度 (インタプリタ) |
| TypeScript対応 | ネイティブ | なし | なし (トランスパイル必要) |
| ビルド複雑度 | 高 (V8ビルド依存) | 低 (pure Rust) | 中 (Cバインディング) |
| エコシステム成熟度 | 高 (Deno本体で使用) | 低 (開発中) | 中 (安定) |
| Rust統合 | API変更が頻繁 | 良好 | 良好 |
| async対応 | あり | 限定的 | あり (futuresフィーチャー) |
| crates.ioダウンロード | 多い | 中程度 | 増加傾向 |

### 推奨: rquickjs

**理由:**
1. **メモリ効率**: 16GB制約下で常時稼働するため、V8の50-100MBは大きい。QuickJSは5-15MBで済む。
2. **ビルドの簡便さ**: deno_coreはV8のビルドが複雑で、CI/CDやクロスコンパイルが困難。rquickjsはCバインディングだが比較的容易。
3. **十分な機能**: ES2023対応、async/await対応。スキルの用途（API呼び出し、データ変換等）には十分な性能。
4. **安定したAPI**: rquickjsはAPIが安定しており、破壊的変更が少ない。
5. **TypeScript対応**: swcクレートでトランスパイルするか、スキル開発時にtscでJSにコンパイルする運用で対応可能。

**リスク:**
- JITがないため、重い計算処理には向かない（ただしスキルの用途では問題にならない）。
- TypeScriptの直接実行はできないため、トランスパイルのワークフローが必要。

**代替案:**
- もしスキルが複雑化し、Node.js互換APIが必要になった場合はdeno_coreへ移行を検討。

---

## 2. Discord SDK

### 候補比較

| 項目 | serenity | twilight |
|---|---|---|
| 設計思想 | 高レベル・使いやすさ重視 | 低レベル・柔軟性重視 |
| 学習コスト | 低い | 高い |
| キャッシュ | 組み込み | オプション (twilight-cache) |
| メモリ使用量 | 中 (キャッシュ込み) | 低 (必要なものだけ) |
| コミュニティ | 大きい・活発 | 中程度 |
| Bot開発実績 | 非常に多い | 中程度 |
| 20サーバー規模 | 十分対応可能 | オーバースペック |
| ドキュメント | 充実 | 十分 |
| Gatewayハンドリング | 自動 | 手動制御可能 |

### 推奨: serenity

**理由:**
1. **開発効率**: 高レベルAPIで素早くBot開発が可能。A2Aアーキテクチャの開発に集中できる。
2. **コミュニティ**: エコシステムが充実しており、問題解決が容易。
3. **20サーバー規模に適合**: serenityのキャッシュ機構で20サーバー程度は問題なく処理できる。twilightの低レベル制御は不要。
4. **安定性**: 長い開発歴があり、Discord API変更への追従が確実。

**メモリ最適化:**
- 不要なキャッシュを無効化 (`CacheSettings` でメッセージキャッシュサイズを制限)
- GuildMemberキャッシュの制限

**注意点:**
- serenity 0.12はpoise (コマンドフレームワーク) と組み合わせ可能。スラッシュコマンド対応が容易になる。

---

## 3. SQLite

### 候補比較

| 項目 | rusqlite | sqlx (SQLite) |
|---|---|---|
| 型チェック | ランタイム | コンパイル時 (query!マクロ) |
| 非同期 | 同期 (blocking) | 非同期ネイティブ |
| マイグレーション | 手動 or refinery連携 | 組み込み |
| 接続プール | なし (単一接続) | 組み込み |
| 依存サイズ | 小さい | 大きい |
| SQLite bundled | features = ["bundled"] | features = ["sqlite"] |
| 学習コスト | 低い | 中程度 |

### 推奨: rusqlite

**理由:**
1. **シンプルさ**: シングルユーザー・シングルプロセスのため、接続プールは不要。
2. **軽量**: 依存が少なく、ビルド時間とバイナリサイズに有利。
3. **十分な機能**: SQLiteはファイルロックベースの同期で十分。tokio::task::spawn_blockingでasyncコンテキストから安全に呼び出せる。
4. **bundled feature**: システムにSQLiteをインストールする必要がない。

**非同期対応パターン:**

```rust
// storageクレート内でtokio::task::spawn_blockingを使用
pub async fn get_task(db: &Connection, id: i64) -> Result<Task> {
    let db = db.clone(); // Arcで共有
    tokio::task::spawn_blocking(move || {
        db.query_row("SELECT ... WHERE id = ?", [id], |row| {
            // ...
        })
    }).await?
}
```

**代替案:**
- 将来的にPostgreSQL等に移行する可能性がある場合はsqlxを検討。ただし現時点ではSQLite固定の前提。

---

## 4. HTTPクライアント

### 選定: reqwest

**理由:**
- Rustの事実上の標準HTTPクライアント。
- tokio非同期対応、JSON対応、ストリーミング対応。
- Google Calendar API, LLM API呼び出しに必要な全機能を備える。
- 他の選択肢を検討する理由がない。

```toml
reqwest = { version = "0.12", features = ["json", "stream"] }
```

---

## 5. 非同期ランタイム

### 選定: tokio

**理由:**
- Rustの非同期ランタイムの事実上の標準。
- serenity, reqwest等の主要クレートがtokio前提。
- mpscチャネル、タイマー、シグナルハンドリング等、本プロジェクトに必要な機能がすべて揃っている。
- 選択の余地なし（エコシステムがtokioに収束している）。

```toml
tokio = { version = "1", features = ["full"] }
```

---

## 6. LLM SDK

### 候補比較

| 項目 | 直接HTTP (reqwest) | async-openai | genai | misanthropic |
|---|---|---|---|---|
| マルチプロバイダー | 自前実装が必要 | OpenAI互換のみ | Claude + OpenAI + 他 | Anthropicのみ |
| メンテナンス | 自分で管理 | 活発 | 活発 | 中程度 |
| 柔軟性 | 最高 | 高 | 中 | 中 |
| ストリーミング | 自前実装 | 対応 | 対応 | 対応 |
| 依存サイズ | reqwestのみ | 中 | 中 | 小 |

### 推奨: reqwest直接 + 自前の薄い抽象化レイヤー (`llm-client` クレート)

**理由:**
1. **プロバイダー非依存**: Claude API と OpenAI API 両方に対応するため、特定SDKに依存しない方が柔軟。
2. **APIの安定性**: LLM APIは頻繁に変更される。SDKの更新を待つよりも自前実装の方が追従が速い。
3. **シンプルさ**: 使うAPIは限定的（chat completion, streaming）なので、薄いラッパーで十分。
4. **デバッグ容易性**: 直接HTTPリクエストを組み立てることで、問題発生時のデバッグが容易。

**設計:**

```rust
#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn chat(&self, messages: &[ChatMessage], options: &ChatOptions)
        -> Result<ChatResponse>;
    async fn chat_stream(&self, messages: &[ChatMessage], options: &ChatOptions)
        -> Result<Pin<Box<dyn Stream<Item = Result<ChatChunk>>>>>;
}

pub struct AnthropicProvider { /* reqwest::Client, api_key */ }
pub struct OpenAiProvider { /* reqwest::Client, api_key */ }
```

**代替案:**
- もしOpenAI互換APIのみで十分なら `async-openai` を採用。Claude APIもOpenAI互換エンドポイントを提供している場合はこちらが簡便。

---

## 7. ログ・トレーシング

### 選定: tracing + tracing-subscriber

**理由:**
- Rustの構造化ログの標準。tokioエコシステムとの統合が優れている。
- `tracing::instrument` で関数単位のスパン計測が可能。
- env-filterでログレベルを動的に制御可能。

```toml
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
```

---

## 8. シリアライゼーション

### 選定: serde + serde_json + toml

**理由:**
- serde: Rustのシリアライゼーション標準。選択の余地なし。
- serde_json: A2Aメッセージのペイロード、LLM API通信。
- toml: 設定ファイル（要件に記載の設定形式に適合）。

---

## 9. 日時処理

### 選定: chrono

**理由:**
- タスク期限、カレンダーイベント、リマインド時刻等、日時処理が多用される。
- タイムゾーン対応が必要（Googleカレンダー連携）。
- serde統合が良好。

```toml
chrono = { version = "0.4", features = ["serde"] }
```

**注意:** `time` クレートも選択肢だが、chronoの方がタイムゾーン処理が充実しており、カレンダー連携に適する。

---

## 10. エラーハンドリング

### 選定: thiserror + anyhow

- **thiserror**: ライブラリクレート（core, storage等）のエラー型定義に使用。型安全なエラーハンドリング。
- **anyhow**: バイナリクレート（main.rs）やプロトタイピング時に使用。簡潔なエラー伝播。

```toml
thiserror = "2"
anyhow = "1"
```

---

## 11. OAuth2 (Google Calendar)

### 選定: oauth2クレート

```toml
oauth2 = "4"
```

**理由:**
- Google Calendar APIのOAuth2フローに必要。
- 型安全なOAuth2実装。
- トークンリフレッシュの自動化が可能。

---

## 12. テスト

| ツール | 用途 |
|---|---|
| `#[tokio::test]` | 非同期テスト |
| `mockall` | モック生成 (トレイトのモック) |
| `assert_cmd` | CLIの統合テスト |
| `testcontainers` | (将来) 外部サービスのテスト |

---

## 選定サマリー

| カテゴリ | 選定 | バージョン |
|---|---|---|
| 非同期ランタイム | tokio | 1.x |
| HTTPクライアント | reqwest | 0.12 |
| Discord SDK | serenity | 0.12 |
| SQLite | rusqlite (bundled) | 0.32 |
| スキルランタイム | rquickjs | 0.8 |
| LLM API | reqwest直接 + 自前抽象化 | - |
| ログ | tracing + tracing-subscriber | 0.1 / 0.3 |
| シリアライゼーション | serde + serde_json + toml | 1 / 1 / 0.8 |
| 日時 | chrono | 0.4 |
| エラー | thiserror + anyhow | 2 / 1 |
| OAuth2 | oauth2 | 4 |
| テスト | mockall | 0.13 |
