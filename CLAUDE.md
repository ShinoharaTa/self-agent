# self-agent

## 概要

Discord 専用サーバーに常駐する個人用エージェント。Claude Agent SDK（TypeScript）で実装し、Claude Max の利用枠で動く。
Discord の 1 スレッド = 1 SDK セッション（`resume` で継続）。

- 要件: `docs/REQUIREMENTS.md`, `docs/design/`
- 旧 Rust 版の資料は `docs/archive/`（参照のみ）

## コマンド

```bash
source ~/.nvm/nvm.sh      # 非対話シェルでは毎回必要（Node 24.20.0）
npm ci                    # 依存インストール（package-lock.json どおり）
npm run check             # 型チェック（tsc --noEmit）
npm test                  # 単体テスト（test/*.test.ts。偽 Runner / 偽 Gateway / 一時 SQLite）
npm run test:integration  # 結合テスト（OAuth トークンが無ければ skip。あれば利用枠を消費する）
npm start                 # 起動（必須の環境変数が欠けていれば変数名を出して exit 1）
npm run measure           # P0 実測（OAuth トークン必須。利用枠を消費する）
```

## ディレクトリ構成

```
src/
├── main.ts      # 配線だけ（config → store → runner → gateway → handler）
├── config.ts    # 環境変数から設定を読む
├── app/         # 受付判定・key 別直列キュー・ターンの prompt・handler
│   ├── access.ts        # 発言の受付判定。受け付けるチャンネル（#inbox と /new で作ったセッション）は DB から引く（/setup 前のサーバーだけ env の #inbox）
│   ├── turn.ts          # 1 チャンネルの 1 ターン（発言・/close 共通）。usage・SDK セッションの保存、seed の付与、resume 失敗からの復旧
│   ├── channel-ops.ts   # チャンネルのカテゴリ移動の列（全サーバーで直列・間隔・同じチャンネルはまとめる・再試行。満杯なら `完了 N` を作る）
│   ├── interactions.ts  # コマンド・ボタン等の振り分け（許可サーバー・オーナー判定 → コマンド名 / custom_id の名前空間）と起動時のコマンド登録
│   └── commands/        # スラッシュコマンド。1 コマンド 1 ファイル（help.ts, setup.ts など）。close.ts は確認のボタン（`close:`）も持つ
├── agent/       # AgentRunner と SDK 実装（query() は sdk-runner.ts だけ）・Options・システムプロンプト・ツール（タスク・session_report）
├── store/       # node:sqlite（user_version でマイグレーション）。tasks / sessions（SDK の session_id）/ usage / guild-settings（/setup で作ったカテゴリ・チャンネルの ID）/ topic-sessions（/new で作ったセッションのチャンネル、/close の要約と下書き）/ channel-seeds（次のターンの prompt の先頭に付ける文）
└── discord/     # Gateway インタフェースと discord.js 実装
scripts/measure-turn.ts  # ターン時間・RSS・トークン使用量の実測
test/            # 単体テスト。test/integration/ は結合テスト
docs/            # REQUIREMENTS.md, design/, research/, archive/, plan/（フェーズごとの実装仕様）
```

## 環境変数

| 変数名 | 用途 |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` / `DISCORD_TOKEN` | 必須。OAuth は `claude setup-token` で発行。権限 600 の `~/.config/self-agent/env` に置く（start / test:integration / measure が読む）。コミット禁止 |
| `SELF_AGENT_ALLOWED_GUILD_IDS` | 必須。動作を許可するサーバー ID（カンマ区切り）。これ以外のサーバーと DM には一切反応しない |
| `SELF_AGENT_OWNER_ID` | 必須。受け付けるオーナーの ID |
| `SELF_AGENT_INBOX_CHANNEL_ID` | 任意。/setup 前の fallback。/setup を実行していないサーバーで #inbox とみなすチャンネルの ID（/setup 後はそのサーバーでは使わない。P3 で廃止） |
| `CLAUDE_CONFIG_DIR` | SDK の設定・セッション保存先。既定 `~/.local/share/self-agent/claude` |
| `SELF_AGENT_WORKDIR` | エージェントの作業ディレクトリ。既定 `~/.local/share/self-agent/work` |
| `SELF_AGENT_DATA_DIR` | SQLite（`self-agent.db`）の保存先。既定 `~/.local/share/self-agent/data` |
| `SELF_AGENT_MODEL` | 使用モデル。既定 `claude-opus-5` |
| `SELF_AGENT_EFFORT` | `low` / `medium` / `high` / `xhigh` / `max`。未設定ならモデルの既定。変更は再起動で反映（Opus 5 は effort ごとにキャッシュが別なので、変更直後は各セッションの最初のターンだけキャッシュが効かない） |
| `SELF_AGENT_TZ` | 日時ヘッダのタイムゾーン。既定 `Asia/Tokyo` |
| `SELF_AGENT_MAX_CONCURRENT` | 同時に処理するターン数の上限。既定 2 |
| `SELF_AGENT_TURN_TIMEOUT_SEC` | 1 ターンの打ち切りまでの秒数。既定 300 |
| `SELF_AGENT_CHANNEL_OP_GAP_MS` | チャンネルのカテゴリ移動の間隔（ミリ秒、全サーバー共通で直列）。既定 2000 |

## コーディング規約

- erasable な TypeScript のみ（enum / namespace / parameter properties 禁止）。ビルドせず `node` で直接実行する（tsconfig は型チェック専用）
- 相対 import は `.ts` 拡張子付き
- 依存は最小限、バージョンは exact 固定
- public リポジトリなので、トークン・ID・個人情報をコードやログに書かない

## プロンプトキャッシュの規則

- システムプロンプトは静的に保つ。日時や ID などの可変値を入れない
- ツール集合は全セッション共通で固定する
- 会話履歴は追記のみ（途中を書き換えない）
- モデルと effort はセッション途中で変えない
- キャッシュ効果の計測は result の `modelUsage` の差分で行う
