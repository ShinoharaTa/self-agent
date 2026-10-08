# self-agent

[English](README.md) | 日本語

Discord の専用サーバーに常駐する、1 人用の AI エージェント。タスク管理と情報整理を手伝う。
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)（TypeScript）で動き、Claude のサブスクリプション（Pro / Max）の利用枠を使う。

- 思いつきは `#inbox` に書く。タスクの登録・一覧・完了はその場で済む
- 腰を据えた話題は、話題ごとにチャンネル（セッション）を分ける。状態は「進行中 / 待ち / 完了」のカテゴリで見える
- Web 検索、貼った URL のページの読み取り、ナレッジベース（全文検索）、記憶（毎回前提にしたいこと）
- [Pi](https://github.com/badlogic/pi-mono) のように軽く: モデルは 1 つ、ツールは固定の少数、システムプロンプトは短く静的、サブエージェントは使わない

## 何ができるか

| 場所・操作 | できること |
|---|---|
| `#inbox` に書く | タスクの登録（「明日 買い物」）・一覧・完了。日時は発言の時刻を基準に解釈する。長くなりそうな相談は、Bot がセッションのチャンネルを作って案内する（1 日の上限あり） |
| セッションのチャンネル | 1 チャンネル = 1 つの会話。再起動しても続きから話せる |
| Web | 調べものは Web 検索。ページを読ませたいときは URL を発言に貼る（貼った URL だけ読める） |
| ナレッジ | 「この URL をナレッジに登録して」「この話をまとめて保存して」で保存し、「前に保存した〇〇は？」で引く。消すときは確認ボタンを押したときだけ消える |
| 記憶 | 「私は〇〇に住んでいる、覚えて」で保存。新しいセッションの最初に前提として渡される。変更には [取り消す] が付く |
| 自動の整理 | 12 時間発言のないセッションは「待ち」へ。完了から 30 日経ったセッションは削除するか `#system` で確認する（確認なしには消さない）。`#inbox` の会話は毎朝 4 時に要約して新しくする（時間・日数・時刻は環境変数で変えられる） |

### スラッシュコマンド

| コマンド | 内容 |
|---|---|
| `/setup` | self-agent 用のカテゴリ（`self-agent`・`進行中`・`待ち`・`完了`）と `#inbox` `#tasks` `#system` を作る。2 回目以降は消えたものだけ作り直す |
| `/new 題名` | セッションのチャンネルを作る |
| `/close` | セッションを閉じる。要約を残し、やることの候補をボタンで確認して登録してから「完了」へ移す |
| `/wait` | セッションを「待ち」へ移す。そのチャンネルで発言すると「進行中」に戻る |
| `/sessions` | セッションの一覧（リンク付き） |
| `/tasks` | 未完了のタスクの一覧。選んで完了にできる |
| `/usage` | 今日と直近 7 日のターン数・トークン・キャッシュの効き・ツール呼び出しの数 |
| `/help` | 使い方 |

`#inbox` にピン留めされるホームパネルのボタンからも、セッションの作成・タスク一覧・待ちのセッションを開ける。

## 仕組み

```
Discord ──(discord.js)── Gateway ── 受付判定（許可サーバー・オーナーのみ）
                                       │
                         チャンネルごとの直列キュー
                                       │
                         Claude Agent SDK  query()（チャンネル単位で resume）
                           ├─ 自前ツール（in-process MCP: タスク・セッション・ナレッジ・記憶）
                           └─ 組み込みツール（WebSearch / WebFetch のみ）
                                       │
                                 SQLite（node:sqlite）
```

- 1 チャンネル = 1 SDK セッション。会話の記録は SDK が保存し、`resume` で続ける
- プロンプトキャッシュを効かせるため、システムプロンプトとツール集合は全セッションで固定。日時は各発言の先頭に付ける
- 定期処理（5 分ごと）で、カテゴリのずれの修正・待ちへの移動・削除の確認・`#inbox` の切り替えを行う
- 詳しい構成は [`CLAUDE.md`](CLAUDE.md)、要求と決定事項は [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)、設計は [`docs/plan/`](docs/plan/)

## 安全のための決まり

- 反応するのは、環境変数で許可したサーバーの、オーナー本人の発言と操作だけ。DM・他のサーバー・他の人・Bot・Webhook には反応しない
- Claude Code の組み込みツールは WebSearch と WebFetch 以外すべて無効（シェル・ファイル操作はできない）
- WebFetch は、そのターンにオーナーが発言に貼った URL（とその転送先）だけ取得できる（それ以外は hook で拒否）。外のページの指示で別の URL にデータを送る経路を塞ぐため
- Web・検索結果・ナレッジの中身は「資料」として扱い、その中の指示には従わない
- チャンネルやナレッジの削除など戻せない操作は、ボタンを押したときだけ行う
- Bot のメッセージで `@everyone` やロールへの通知は出さない
- Claude の子プロセスには、許可した環境変数だけを渡す（Discord のトークンなどは渡らない）

## 動かし方

### 必要なもの

- Linux（ヘッドレスで可）、Node.js 24.20 以上
- Claude のサブスクリプション（`claude setup-token` で発行したトークンで動く。既定のモデルは Opus で、Max プランで運用している）
- Discord の Bot（自分で作成）

### 1. Discord の Bot を作る

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリと Bot を作り、Bot のトークンを発行する
2. Bot の設定で **Public Bot をオフ**、Privileged Gateway Intents の **Message Content Intent をオン**
3. サーバーに招待する（スコープ: `bot` と `applications.commands`）。Bot に必要な権限:
   View Channels / Send Messages / Read Message History / Manage Channels / Pin Messages

### 2. Claude のトークンを発行する

```bash
claude setup-token   # 表示される URL で認証し、出てきたトークン（1 年有効）を控える
```

### 3. 環境変数を置く

`~/.config/self-agent/env`（権限 600。リポジトリには置かない）:

```
# claude setup-token のトークン
CLAUDE_CODE_OAUTH_TOKEN=...
# Bot のトークン
DISCORD_TOKEN=...
# 動かすサーバーの ID（カンマ区切り）
SELF_AGENT_ALLOWED_GUILD_IDS=...
# あなたの Discord ユーザー ID
SELF_AGENT_OWNER_ID=...
```

```bash
mkdir -p ~/.config/self-agent && chmod 700 ~/.config/self-agent
( umask 077; ${EDITOR:-vi} ~/.config/self-agent/env )
```

サーバー ID とユーザー ID は、Discord の「開発者モード」をオンにすると右クリック（スマホは長押し）でコピーできる。
任意の設定（モデル、effort、各種の時間・上限）は [`CLAUDE.md` の環境変数の表](CLAUDE.md#環境変数) を参照。

### 4. 起動する

```bash
npm ci
npm start
```

常駐させるなら systemd のユーザーサービスにする（sudo 不要。nvm の Node なら先に `source ~/.nvm/nvm.sh`）。例:

```bash
systemd-run --user --unit=self-agent --working-directory="$PWD" \
  "$(command -v node)" --env-file="$HOME/.config/self-agent/env" src/main.ts
journalctl --user -u self-agent -f      # ログ
systemctl --user stop self-agent        # 停止（進行中の返信を待ってから止まる）
```

### 5. Discord で初期設定する

許可したサーバーで `/setup` を実行する。カテゴリとチャンネルができたら、`#inbox` に「明日 買い物」と書いてみる。

## 開発

```bash
npm run check             # 型チェック（tsc --noEmit。実行はビルドせず Node の型ストリッピングで行う）
npm test                  # 単体テスト（偽の Gateway / Runner と一時 SQLite。トークン不要）
npm run test:integration  # 結合テスト（Claude のトークンがあれば実際に SDK を呼ぶ。利用枠を使う）
npm run measure           # 1 ターンの時間・メモリ・トークンの実測
```

- 実行時の依存は `@anthropic-ai/claude-agent-sdk`・`discord.js`・`zod` の 3 つだけで、バージョンは固定
- 規約・ディレクトリ構成・プロンプトキャッシュの規則は [`CLAUDE.md`](CLAUDE.md)
- システムプロンプトの変更は既存のセッションには届かない（新しいセッションと `#inbox` の切り替えから反映）。ツールの追加・説明の変更は全セッションで 1 回キャッシュが外れるので、まとめて行う
