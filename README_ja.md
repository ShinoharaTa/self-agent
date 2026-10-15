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
| `/setup` | self-agent 用のカテゴリ（`self-agent`・`進行中`・`待ち`・`完了`）と `#inbox` `#tasks` `#system`（GitHub の通知を有効にしていれば `#github` も）を作る。2 回目以降は消えたものだけ作り直す |
| `/new 題名` | セッションのチャンネルを作る |
| `/close` | セッションを閉じる。要約を残し、やることの候補をボタンで確認して登録してから「完了」へ移す |
| `/renew` | 会話を要約して新しくする（長くなった会話の仕切り直し）。セッション・`#inbox`・`#tasks` で使える |
| `/wait` | セッションを「待ち」へ移す。そのチャンネルで発言すると「進行中」に戻る |
| `/sessions` | セッションの一覧（リンク付き） |
| `/tasks` | 未完了のタスクの一覧。選んで完了にできる |
| `/reminders` | リマインドと予約した依頼の一覧。選んで次の回を飛ばしたり止めたりできる |
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
                           ├─ 自前ツール（in-process MCP: タスク・セッション・ナレッジ・記憶・プロジェクト）
                           └─ 組み込みツール（Web: WebSearch / WebFetch、
                                              ファイル: Read / Write / Edit / Glob。プロジェクトの中だけ）
                                       │
                                 SQLite（node:sqlite）
```

- 1 チャンネル = 1 SDK セッション。会話の記録は SDK が保存し、`resume` で続ける
- プロンプトキャッシュを効かせるため、システムプロンプトとツール集合は全セッションで固定。日時は各発言の先頭に付ける
- 定期処理（5 分ごと）で、カテゴリのずれの修正・待ちへの移動・削除の確認・`#inbox` の切り替えを行う
- 詳しい構成は [`CLAUDE.md`](CLAUDE.md)、要求と決定事項は [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)、設計は [`docs/plan/`](docs/plan/)

## 安全のための決まり

- 反応するのは、環境変数で許可したサーバーの、オーナー本人の発言と操作だけ。DM・他のサーバー・他の人・Bot・Webhook には反応しない
- シェルは無い。組み込みツールは WebSearch・WebFetch とファイル操作（Read / Write / Edit / Glob）だけで、読めるのは projects の中、書けるのはそのチャンネルのプロジェクトの中だけ（hook で判定する）。Bot が消したファイルはプロジェクトの `.trash` に移り（戻せる）、30 日で消える
- WebFetch は、そのターンにオーナーが発言に貼った URL（とその転送先）だけ取得できる（それ以外は hook で拒否）。外のページの指示で別の URL にデータを送る経路を塞ぐため
- Web・検索結果・ナレッジの中身は「資料」として扱い、その中の指示には従わない
- オーナーが貼った画像（JPEG・PNG・WebP・GIF。1 発言 4 枚まで）は会話の一部として Anthropic の API に送られ、SDK の会話の記録（`CLAUDE_CONFIG_DIR` の下）にも残る。原本は `<SELF_AGENT_DATA_DIR>/attachments/` に置く（記録に結びつかなければ 30 日で消える）
- チャンネルやナレッジの削除など戻せない操作は、ボタンを押したときだけ行う
- Bot のメッセージで `@everyone` やロールへの通知は出さない
- リマインドと GitHub の自分宛ての通知（赤）は、オーナーだけをメンションして鳴らす
- GitHub の通知の取得は、アプリが gh の今のログインで GET だけを行う（LLM は関わらない）。GitHub の既読は変えない。ローカルのログにはリポジトリ名・題名・URL を出さない
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

### 6.（任意）2 体目の Bot（人格）を足す

性格・役割の違う 2 体目の Bot を、同じプロセス・同じサーバーで動かせる。タスク・記憶・ナレッジは共有する。

1. Developer Portal でアプリと Bot をもう 1 つ作り、トークンを発行する。**Public Bot はオフ**、**Message Content Intent はオン**
2. 同じサーバーに招待する（スコープ: `bot` と `applications.commands`）。権限は次の 3 つだけ:
   View Channels / Send Messages / Read Message History（Manage Channels は渡さない。チャンネルの作成・移動は 1 体目の Bot が行う）
3. `~/.config/self-agent/env` に足す（`<ID>` は人格の id の大文字）:

```
# 人格の id（英小文字と数字の 1〜12 字、カンマ区切り、10 個まで）
SELF_AGENT_PERSONAS=mika
SELF_AGENT_PERSONA_MIKA_DISCORD_TOKEN=...
# 表示名（20 字以内。チャンネル名 #<NAME> にもなるので inbox・tasks・system・github にはできない。未設定なら id）
SELF_AGENT_PERSONA_MIKA_NAME=Mika
# 任意: 性格・口調・役割の文（既定 ~/.config/self-agent/personas/<id>.md。リポジトリには置かない）
SELF_AGENT_PERSONA_MIKA_PROMPT_FILE=...
# 任意: claude（既定）/ codex（codex のエンジンができるまでは Claude で動く）と、そのモデル・effort
SELF_AGENT_PERSONA_MIKA_ENGINE=claude
SELF_AGENT_PERSONA_MIKA_MODEL=...
SELF_AGENT_PERSONA_MIKA_EFFORT=...
# 人格を足したら推薦
SELF_AGENT_MAX_CONCURRENT=3
```

4. 再起動して、もう一度 `/setup` を実行する。self-agent カテゴリに `#<NAME>`（例 `#mika`）ができるので、そこに書くと 2 体目が答える。
   2 体目とのセッションは `/new` の `persona` で選ぶ（チャンネル名は `<NAME>-<題名>`）か、`#<NAME>` で頼む。

### 7.（任意）GitHub の通知を `#github` に流す

自分の PR へのコメント・レビュー、メンション、レビュー依頼（赤。オーナーだけをメンションして鳴らす）と、自分のリポジトリの他人の新しい Issue / PR（黄。鳴らさない）を `#github` に流す。自分や Bot の操作は流さない。

1. `gh auth status` でログイン済みを確かめる。トークンは `~/.config/gh/hosts.yml` に保存されている必要がある（keyring に保存したログインは Bot から読めない）
2. `npm run github-dry-run` で、取得と振り分けの件数（赤・黄・白）だけを確かめる（投稿しない・GitHub の既読も変えない）
3. `~/.config/self-agent/env` に足して再起動し、もう一度 `/setup` を実行する（self-agent カテゴリに `#github` ができる）

```
SELF_AGENT_GITHUB=1
# 任意: 「自分のリポジトリ」とみなす持ち主（既定は gh のログイン 1 つ）。所属する org を足す
SELF_AGENT_GITHUB_OWNERS=<login>,<org>
# 任意: ポーリングの間隔（秒、60 以上。既定 300）
SELF_AGENT_GITHUB_POLL_SEC=300
```

最初の取得では今ある未読は流さず、`#github` に開始の知らせを 1 通出す。以後は 5 分ごとに新しいものだけを流す（1 回 10 件まで。残りは「ほか n 件」にまとめる）。取得できない状態（gh の認証など）は `#system` に知らせる。

## 開発

```bash
npm run check             # 型チェック（tsc --noEmit。実行はビルドせず Node の型ストリッピングで行う）
npm test                  # 単体テスト（偽の Gateway / Runner と一時 SQLite。トークン不要）
npm run test:integration  # 結合テスト（Claude のトークンがあれば実際に SDK を呼ぶ。利用枠を使う）
npm run measure           # 1 ターンの時間・メモリ・トークンの実測
npm run github-dry-run    # GitHub の通知を 1 回だけ取得して振り分けの件数を表示（投稿しない）
```

- 実行時の依存は `@anthropic-ai/claude-agent-sdk`・`discord.js`・`zod` の 3 つだけで、バージョンは固定
- 規約・ディレクトリ構成・プロンプトキャッシュの規則は [`CLAUDE.md`](CLAUDE.md)
- システムプロンプトは毎回送る（`snapshot: false`）ので、変更は既存のセッションにも次のターンから届く。システムプロンプトの変更・ツールの追加・説明の変更は全セッションで 1 回キャッシュが外れるので、まとめて行う
