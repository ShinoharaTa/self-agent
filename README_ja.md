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
- プロジェクトのあるセッションのチャンネルでは、Bot がシェルのコマンド（Bash。`git clone`・`npm install` など）を 1 つずつの承認なしに実行できる。コマンドはすべて OS の sandbox（bubblewrap）の中で動き、書けるのは作業ディレクトリの projects・.cache・.tmp の中だけ、ホーム（トークン・SSH の鍵・gh の認証・Bot の DB と会話の記録・他のプロジェクト）・`/tmp`・`/run`・`/var/log` は読めず、届くのは GitHub と npm の registry だけ。Claude のトークンはコマンドの環境から消す。コマンドは 5 分で打ち切られ、プロセスを残せない
- sandbox を起動できなければシェルは止まり（コマンドは拒否される）、`#system` にそう知らせる。`SELF_AGENT_SHELL=1` を設定しない限りシェルは使わない
- 作業ディレクトリは別の 8 GB のファイルシステムのイメージにし、大きなダウンロードが暴走してもホストのディスクを埋めない
- 組み込みツールは WebSearch・WebFetch（シェルが有効なら Bash も）とファイル操作（Read / Write / Edit / Glob）で、読めるのは projects の中、書けるのはそのチャンネルのプロジェクトの中だけ（hook で判定する）。Bot が消したファイルはプロジェクトの `.trash` に移り（戻せる）、30 日で消える
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
- （シェルを使うなら）bubblewrap と socat、Ubuntu 24.04 以降では bwrap 用の AppArmor の profile（[`docs/plan/shell.md`](docs/plan/shell.md) §6）

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
  -p MemoryMax=4G -p MemoryHigh=3G -p CPUQuota=300% -p TasksMax=1024 \
  "$(command -v node)" --env-file="$HOME/.config/self-agent/env" src/cli.ts start
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

9. の Claude Code の連携（`SELF_AGENT_CC=1`）も有効で `git` があれば、自分のリポジトリ（`SELF_AGENT_GITHUB_OWNERS`）か `SELF_AGENT_WORKSPACE_DIR` の直下・1 つ下に clone してあるリポジトリの通知に [対応] が付く（Web UI の GitHub のタブにも）。押すと、そのリポジトリのディレクトリで動いている Claude Code のセッションに、リポジトリ・番号・種別・URL だけの 1 行の対応依頼（題名や本文は入れない）を積み、入力待ちになったら届ける。候補が複数で入力待ちのものに絞れなければ送らずに候補を出す。セッションが無ければ [起動して送る] で、そのディレクトリに新しいセッションを起動して同じ依頼を届ける（起動の条件は 9. と同じ）。同じ通知の依頼が送信待ちか 30 分以内に届けていれば、もう一度押しても積まない。

### 8.（任意）Web UI

tailnet の中のブラウザから Bot の状態と使用量を見る小さな Web アプリ（作りかけ。今は `/api/status`・`/api/usage` と仮の画面だけ）。`127.0.0.1` だけで待ち受け、`tailscale serve` で別のポートに出す。

1. `~/.config/self-agent/env` に足して再起動する（ポートとログインの両方があるときだけ有効）

```
# Web UI のポート（127.0.0.1 だけで待ち受ける）
SELF_AGENT_WEB_PORT=8791
# 自分の Tailscale のログイン。Tailscale-User-Login がこれと完全一致する要求だけを通す
SELF_AGENT_WEB_ALLOWED_LOGIN=<you>@<domain>
# 任意: ログインのヘッダが無いときに /login で貼るトークン（空白を含まない 32 字以上）
SELF_AGENT_WEB_TOKEN=...
```

2. tailnet に出す（1 回だけ。設定は残る）

```bash
tailscale serve --bg --https=9444 http://127.0.0.1:8791
```

3. `https://<host>.<tailnet>.ts.net:9444/` を開く。ログインのヘッダが無ければ（トークンを設定していれば）`/login` に移るので、トークンを貼ると 30 日の Cookie が付く。トークンを差し替えると全員ログアウトする。ヘッダ無しで `127.0.0.1` に直接送った要求は 401 になる。

4. （任意）iPhone では Safari で 3. の https の URL を開き、共有 →「ホーム画面に追加」で、アプリのように枠なしで開ける（アイコンと名前 self-agent 付き。Android・PC の Chrome はメニューの「アプリをインストール」）。https の `tailscale serve` 経由が前提で、http では認証を通れない（Cookie が `Secure` 付きのため）。オフラインでは動かない。

### 9.（任意）この機械の Claude Code のセッションを見る・送る・起動する

作りかけ（`docs/plan/claude-code-sessions.md` の段 CC5c・CC7・CC8）。Bot が `claude agents --json` を周期で読み、Claude Code の hooks をローカルのポートで受けて、どのセッションが判断待ち・実行中・待機かを知る。Web UI（有効なとき）の会話のサイドバーの群「Claude Code」（入口の次）に一覧（判断待ち → 実行中 → 最近の指示の順。会話の数は未読 + 判断待ち）が、行を押すとそのセッションのタブに、tmux の中のセッションの画面の写し（3 秒ごと）が出る。tmux の中のセッションのタブの入力欄から指示を送れる（複数行可・2,000 字まで。入力待ちのときだけ貼って Enter を押し、作業中なら入力待ちになるまで待つ。`SELF_AGENT_CC_SEND_WAIT_MIN`（既定 120 分）待っても届かなければ諦める。待っている間は [取り消す] で止められる）。貼れたか確かめられなかったときは Enter を押さないので、画面を見て確かめる。複数行の貼り付けが 1 行目で送信されたように見えることが続くと、以後は改行を空白に置き換えて送り、#system に知らせる。端末で確かめて問題が無ければ `npm run cc-dry-run -- --reset-multiline` で戻す（DB のその値だけを変える）。群の [Claude Code を起動]（コマンドパレットにもある）から、`SELF_AGENT_WORKSPACE_DIR`（既定 `~/workspace`）の直下のディレクトリで新しいセッションを起動できる（tmux の既定のサーバーに新しいセッションを作り、`claude -n <題名>` を起動する。権限モードは既定・default・acceptEdits・plan・auto から選ぶ。最初の指示を書いておくと、入力待ちになってから送る）。tmux のサーバーが動いていなければ断る（Bot からは起こさない）。生きている `claude` が `SELF_AGENT_CC_MAX_SESSIONS`（既定 30）本以上・空きメモリが 1 GB 未満・前の起動から 1 分未満のときも断る。tmux のセッション名は表示用で、tmux の hook が名前を変えても Bot はペインで追う。新しいディレクトリでは trust の確認（「Yes, I trust this folder」）が出るが、既定の選択が「No, exit」なので Bot はキーを送らない。一覧に「trust の確認待ち」が出たら、端末か RC で答える。許可を求められたら、Bot は Claude Code の `PermissionRequest` の hook を最長 `SELF_AGENT_CC_PERMISSION_HOLD_SEC` 秒（既定 300）保留し、そのセッションのタブに [許可][拒否] のカードを出す。Claude Code がその要求に規則を提案したとき（例: `Bash(npm test *)`）は [このセッションでは常に許可（<ルール>）] も出る。ルールはそのセッションにだけ加わり（設定ファイルには書かない）、`claude` のプロセスが終われば消える。広い・危ないルールは出さない（コマンドの語が無い・危ない語（`rm`・`sudo`・`curl` など）・包み語（`env`・`bash`・`xargs` など）・クォートやパスで指した最初の語（`"rm"`・`./x.sh`）・任意のコードを実行できる入口（`node`・`npx`・`python`・`make` など。npm は `npm test`・`npm run <名前>` だけ）・git の破壊的な語（`push`・`reset`・`checkout` など）・`find -exec`・`-delete`・パイプやリダイレクトなど。ファイルのルールはそのセッションのディレクトリのプロジェクトの中だけ）。規則の提案が無い要求も多いので、ボタンが出ないことはよくある。その間も端末（と RC）にはふだんのダイアログが出ていて、先に答えた方が効く。端末で答えたら、カードは 10 秒ほどで閉じる。時間内に押さなければ Bot は何も答えず、ダイアログはそのまま残る。Bot がまだ一覧で見ていないセッションの要求（起動直後や `claude agents --json` を読めない間など）は保留しないので、端末か RC で答える。許可の要求は Discord の #system にも 1 通（オーナーをメンション）がボタン付きで出て（[許可][このセッションでは常に許可][拒否] と、RC のリンクが分かれば [RC で開く]）、スマホからも答えられる。答えが決まる（Web・Discord で押された・端末で答えられた・時間切れ）とその 1 通が書き換わってボタンが消える。先に答えられた後に押すと「この操作は古くなっています」。許可の要求以外の判断待ち（質問のダイアログ・sandbox のネットの許可・時間切れの後のダイアログなど）が 60 秒続くと #system に 1 回知らせる（1 時間に 10 件まで。超えた分は「ほか n 件」の 1 通にまとめる）。Bot が起動したセッションが終わったときも 1 行知らせる。`SELF_AGENT_CC_NOTIFY=0` で #system への知らせを全部止められる（許可の要求は Web と端末・RC で答える。保留の長さは変わらない）。`npm run cc-dry-run` でも確かめられる。`claude` と `tmux` が `~/.local/bin` か `/usr/local/bin`・`/usr/bin`（ほかの場所なら Bot の `PATH`）に要る。Bot は `claude agents --json` に `HOME`・`PATH`・`LANG` だけの環境を渡すが、それで動くかはまだ確かめていない。

Discord からも頼める（CC7）。#inbox などで「<名前> のセッションに『…』と伝えて」「alpha で新しく Claude Code を始めて」と書くと、Bot はそのチャンネルに確認（送る本文の全文。本文は 4,000 字までで、1 通 1,800 字ずつ最大 3 通に分けて出す）と、最後の 1 通に [送る][やめる] / [起動する][やめる] を出す。見せきれない本文は送らない。送る・起動するのはボタンを押したときだけで、10 分押さなければ取り消す（セッションの数・メモリ・1 分の間隔などで今は起動できないときは、ボタンを残すので少し待って押し直す。Web のページなどに書かれた依頼で Bot が確認を出しても、本文を見て [やめる] を押せばよい）。セッションの様子を聞けば一覧（判断待ち・実行中・待機）で答える。予約した依頼・/close のターンでは使えない。このツールとシステムプロンプトの 1 行が入った版で Bot を再起動すると、全セッションの次のターンで 1 回だけプロンプトキャッシュが外れる（`SELF_AGENT_CC` が無効でも同じ。`npm run usage` で確かめられる）。

Discord から頼んだセッションの返事は、頼んだチャンネルに戻ってくる（CC8）。[送る]（か最初の指示付きの [起動する]）で届いたら、そのセッションを「追いかけ」にして、以後そのセッションが答え終わるたび（Claude Code の `Stop` の hook。RC・端末・Web から打った指示の返事も）、「Claude Code（<名前>）の返事（hook）:」に続けて返事をそのチャンネルに出す。最初の返事は確認の投稿への返信になる。1 通 1,800 字ずつ最大 3 通で、それより長い分は「ほか n 字。RC で読む」になる。返事は Claude Code から来たデータなので、メンションは鳴らさず、リンクのプレビューも出さず、Bot の会話にも入れない。止めるときは返事の [追いかけをやめる] か、Web のセッションのタブの [追いかけをやめる] を押す（投稿先を別のチャンネルに移した後でも、前のチャンネルの返事のボタンで止まる）。セッションが終わったとき（「終わりました」を 1 行出す）と、3 日返事が無いときにも止まる。1 セッション 1 日 50 通までで、超えたらその日は「今日はここまで」を 1 行出して止め、翌日にまた出す。別のチャンネルから頼むと、そのチャンネルに移る。Esc で止めたターンには `Stop` が来ないので、その返事は戻らない。

1. `npm run cc-dry-run` で、セッションを 3 群（判断待ち・実行中・待機）で確かめる（投稿しない・何も変えない）
2. `~/.config/self-agent/env` に足す（トークンは Claude Code の hooks と共有する。空白を含まない 32 字以上）

```
SELF_AGENT_CC=1
# hook の受け口のポート（127.0.0.1 だけで待ち受ける。tailscale serve には出さない）
SELF_AGENT_CC_HOOK_PORT=8792
SELF_AGENT_CC_HOOK_TOKEN=...
```

3. hooks の設定を出して、自分で `~/.claude/settings.json` に足す（Bot は `~/.claude` に書かない）

```bash
npm run cc-setup -- --print
```

`env` の 1 行と、5 つの事象（`UserPromptSubmit`・`Stop`・`SessionEnd`・`Notification`・`PermissionRequest`。`SessionStart` は http hook に対応していないので外している）の `hooks` が出る。どれも `http://127.0.0.1:<port>/hook` への `type: "http"` で、ヘッダは `X-Self-Agent-Hook: $SELF_AGENT_CC_HOOK_TOKEN`。`env` の置き場所の文は `~/.config/self-agent/env` と同じトークンに置き換え、`~/.claude/settings.json` は 600 のままにする。`settings.json` の `env` からトークンが読まれないときは、tmux のサーバーを起こすシェルで `SELF_AGENT_CC_HOOK_TOKEN` を `export` する。

4. Bot を再起動する。Bot を止めている間も発言は遅れないが、毎ターン端末に hook のエラーの行（`hook error … ECONNREFUSED`）が出る（RC にも出るはず）。

## 開発

```bash
npm run check             # 型チェック（tsc --noEmit。実行はビルドせず Node の型ストリッピングで行う）
npm test                  # 単体テスト（偽の Gateway / Runner と一時 SQLite。トークン不要）
npm run test:integration  # 結合テスト（Claude のトークンがあれば実際に SDK を呼ぶ。利用枠を使う）
npm run measure           # 1 ターンの時間・メモリ・トークンの実測
npm run github-dry-run    # GitHub の通知を 1 回だけ取得して振り分けの件数を表示（投稿しない）
npm run cc-dry-run        # この機械の Claude Code のセッションを 1 回だけ読んで 3 群で表示（投稿しない）
```

- 実行時の依存は `@anthropic-ai/claude-agent-sdk`・`discord.js`・`zod` の 3 つだけで、バージョンは固定
- 規約・ディレクトリ構成・プロンプトキャッシュの規則は [`CLAUDE.md`](CLAUDE.md)
- システムプロンプトは毎回送る（`snapshot: false`）ので、変更は既存のセッションにも次のターンから届く。システムプロンプトの変更・ツールの追加・説明の変更は全セッションで 1 回キャッシュが外れるので、まとめて行う
