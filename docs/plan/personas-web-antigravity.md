# Discord の Bot を持たない人格（Web だけ）と、Antigravity のエンジン（#530）

- 状態: 2026-11-28 の時点。オーナーの答え 5 つ（§1.1）を入れた。§9 の問いは未決
- 関連: #114（`docs/plan/personas.md`）・#457（`docs/plan/lead.md`）・#528（`docs/plan/web-ui-rebuild.md`）・#483・`docs/plan/distribution.md`
- 読んだ物: コードは main の `ec663eb` で読んだ。調べ物は同じ日の公開の文書（出典は §11）。`agy` は入れていないし、動かしていない（実測は AG0）
- 印の意味: 【事実】= コードか公式の文書で確かめた / 【推測】= 読んだ物からの見立て / 【未確認】= 確かめられなかった

## 0. 何のために

オーナーの頼み（2026-11-28）は 3 つ。

1. 右腕のような相手（人格）を、手間なく増やしたい
2. Discord の Bot のキーを渡していない人格は、Web UI の上だけで動けば良い
3. Antigravity のエージェントに、self-agent の人格として訊きたい・頼みたい

今は、人格を 1 体足すたびに Discord の Developer Portal で Bot を作り、トークンを置き、サーバーに招く必要がある。Claude 以外の相手に同じ画面から頼む道も無い。

2 本の線に分ける。互いに独立で、どちらからでも進められる。

- 場所の線（WP）: 人格が Discord の Bot を持つか、Web だけか
- エンジンの線（AG）: 人格が Claude で動くか、Antigravity で動くか

## 1. 決まった事

### 1.1 オーナーが決めた事（2026-11-28）

| # | 事 | 中身 |
|---|---|---|
| 1 | 「AGP」の意味 | Antigravity のエージェントに、self-agent の人格として頼みたい |
| 2 | お金 | サブスクの枠。この機械に入れた `agy` を、オーナーの Google AI のサブスクのサインインで回す |
| 3 | 操作の範囲 | まず調べ物・相談だけ。`agy` は空の作業フォルダで動かし、この機械のプロジェクトには触らせない。後から広げられる形に |
| 4 | Web だけの人格 | Discord に何も出さない。話題が終わったまとめだけ、今まで通り右腕の #inbox に出す |
| 5 | 右腕との関係 | 右腕からは呼ばない。オーナーが自分で話しかけるだけ |

### 1.2 オーナーに訊かずに置いた既定

- 1 日の上限は最初は入れない（人が打った分しか動かない。サブスクの側に 5 時間と週の上限が在る）。条件は 1 つ: 枠が尽きた後に AI クレジットを自動で使う設定（`useG1Credits`）を切っておく事（§9 の 2）
- 枠が尽きたら「止まった」ターンとして出す（§5.6）
- 最初の人格の名前は、門を開ける段（WP5）で訊く

### 1.3 オーナーが受け入れた事（事実だけ）

- 規約 §6: Google が出していない道具でサービスに入る事は違反で、Antigravity と Gemini CLI のアカウントの停止・終了の理由になる、と書いて在る
- 公式の FAQ: `agy -p` は「自分で直に書くスクリプトと CI のための物」。`agy` を他のコーディングエージェントやアプリの中に包む事は、個人向けのプランでは「サポートしない」と書いて在る
- 公式のフォーラムに、他の道具から使って停止になったと訴える題の投稿が複数在る（題で確かめた。中身は読み込んでいない）
- オーナーは 2026-11-28 に、この説明を読んだ上で受け入れた
- 配る文書（`docs/environment.md` の `_ENGINE=antigravity` の行）に、この節への案内を 1 行入れる（npm で入れた他の人が同じ設定をする前に読めるように）

## 2. 今の作り（事実）

### 2.1 人格を足すのに必須の物

| 何 | どこ | 中身 |
|---|---|---|
| トークンが無いと弾く | `src/config.ts:416-417` | `SELF_AGENT_PERSONA_<ID>_DISCORD_TOKEN` が空なら `…が設定されていません` を投げる。起動は exit 1 |
| 型でも必須 | `src/config.ts:24-39` | `PersonaConfig.discordTokenEnv: string`（省けない） |
| 人格ごとに Bot を 1 つ作る | `src/main.ts:286-289` | 設定の人格ごとに `DiscordGateway` を作る |
| 実行時も Gateway が必須 | `src/app/personas.ts` | `PersonaRuntime = TurnPersona & { name; gateway; connected }` |
| エンジン | `src/config.ts:13` | `ENGINES = ["claude", "codex"]`。codex のエンジンは無く、codex の人格も Claude で動く（`src/main.ts:368-370`） |
| 人格ごとの runner | `src/main.ts:371-398` | 人格ごとに `SdkAgentRunner` を作り、`engine: "claude"` を固定で入れている |
| runner の口 | `src/agent/runner.ts:149` | `AgentRunner { run(input): Promise<RunResult> }` |
| エンジンごとの記録 | `src/store/db.ts`（v18） | `channel_sessions.engine`・`usage_log.engine` の列が在る |

### 2.2 Web の話題と人格

- 新しい殻の `POST /api/topics` は人格を受け取らない（`src/web/routes/topics.ts:744-830`）。Web から始めた話題は必ず既定の人格の物になる
- 古い殻の `POST /api/sessions` は `persona` を受け取る（`src/web/routes/sessions.ts:167-171`）
- `startTopic` 自体は `owner` を受け取れる（`src/app/session-ops.ts`）。今これを使うのは、足した人格の入口からの `session_open`（`src/app/right-hand.ts:133-135`）
- 足した人格の入口 `#<NAME>` は、一覧（`GET /api/topics`）に決まった入口の行として並ぶ（`src/web/routes/topics.ts:399-428`）。**画面を足さなくても、入口は一覧に出る**
- 人格の話題は軽いセッションだけ。プロジェクトもモデルも選べない（`src/app/session-ops.ts:124`・`382-383`）

### 2.3 右腕の扱い

- 右腕は「人格」の行ではない。既定の人格の #inbox を、一覧が `rightHands` に「右腕」の題で入れている（`src/web/routes/topics.ts:429-439`）
- 統括のまとめ（L2）は、どの人格の話題の物も既定の人格の #inbox に出る（`src/app/lead.ts:190`）。本文は `終わりました: <#チャンネルID>` の形（`src/app/lead.ts:72-83`）

### 2.4 Discord のチャンネルを持たない話題は在るか

**無い。** 理由は 4 つ重なっている。

1. 話題を作ると必ず Discord のテキストチャンネルを作る（`src/app/session-ops.ts:143-165`）
2. そのチャンネルの ID が、`sessions`・履歴・列・SDK のセッションの鍵
3. Web の発言は、ターンにする前に必ず Discord に写す。写せなければ `echo_failed`、持ち主の Bot が落ちていれば `bot_disconnected`（`src/app/handler.ts:634-647`）
4. 再同期（`src/app/scheduler.ts:222-262`）が、Discord に無いチャンネルのセッションを「削除済み」にし、SDK のセッションと種も消す

助けになる事実が 2 つ。

- 返事の本文は Discord への送信の成否と関係なく履歴に書く（`src/app/handler.ts:440-460`）。Web は履歴を読む
- 送り先は人格ごとの Gateway に振り分ける作り（`PersonaRouter.gatewayFor`）。「何も外に出さない Gateway」を 1 つ足せば、多くの道はそのまま通る

Web には通知（Web Push）が無い【事実: `src` に実装が無い】。

## 3. 場所の線: Web だけの人格（確定）

オーナーの答え 4 で確定。Discord には何も作らない。

### 3.1 決め事

- **明示の変数**: `SELF_AGENT_PERSONA_<ID>_SURFACE`。`discord`（既定）か `web`。トークンの書き忘れを「Web だけ」と取り違えないため、トークンが無いだけでは Web だけにしない。`web` でトークンも書いて在れば設定エラー
- **番号**: DB の連番から作る数字 21 桁（先頭 1 桁 + 連番を 0 で埋めた 20 桁）。Discord の ID（64 ビット。20 桁まで）と重ならず、今の `\d{1,25}` の正規表現（Web の道の 15 か所と右腕の `topic_move`）がそのまま通る。チャンネルにもメッセージにも同じ連番を使う
- **ローカルかどうか**: `sessions` と `persona_channels` に列 `place`（`discord` / `local`。既定 `discord`）。番号の形や設定では決めない
- **ローカルの Gateway**: `Gateway` を満たす。`start` は何もしない。`send`・`sendMessage` は番号を振って返す。編集・ピン・リアクション・入力中は何もしない。`messageExists` は true。管理の操作は呼ばれたら投げる
- **サーバー**: ローカルの場所も `guild_id` を持つ。既定の Bot と `/setup` は今まで通り要る
- **知らせ**: ローカルの話題のターンの終わりは、今の L2 のまとめで右腕（Discord の #inbox）に出る。本文は題名で書く。入口の返事は知らせない
- **使い方（画面を足さない間）**: 一覧の入口 `#<NAME>` を開いて話す。Claude で動く人格なら、その入口で頼めば話題を分けられる（`session_open`）

### 3.2 変える所

| 領域 | 今 | 変える事 |
|---|---|---|
| 設定 | トークン必須 | `_SURFACE=web` で Web だけ |
| 起動の配線 | 人格ごとに `DiscordGateway` | Web だけの人格にはローカルの Gateway。`connected` は常に true |
| DB | 鍵は Discord のチャンネル ID | 連番の表と、列 `place`（マイグレーション 1 つ） |
| 話題を作る | 必ず Discord のチャンネル | ローカルなら Discord を呼ばず、番号を振る |
| 入口 `#<NAME>` | `/setup` が Discord に作る（`src/app/commands/setup.ts:155-164`） | 起動のときと `/setup` のときに、ローカルの入口を無ければ作る |
| 状態 | カテゴリの移動（`src/app/channel-ops.ts`） | ローカルは DB の状態だけ |
| 削除 | Discord のチャンネルを消す | ローカルは DB だけ |
| 再同期 | Discord に無ければ削除済み | ローカルを飛ばす |
| まとめ（L2） | `<#ID>` で指す | ローカルの話題は題名で書く |
| #system の接続の知らせ | Bot ごと（`src/app/persona-status.ts`） | Web だけの人格は出さない |
| `/new` の `persona` の選択肢 | 全人格 | Web だけの人格を外す |
| `/sessions`・`/usage` など | `<#ID>` で並べる | ローカルの話題は題名だけ |
| リマインド | 持ち主の Bot が落ちていれば見送る（`src/app/reminders.ts:610`・`639`） | ローカルの場所でどうなるかを確かめて決める【未確認】 |
| Web API | `POST /api/topics` に人格が無い | `persona` を受ける。一覧・`/api/channels`・`/api/status` に `surface` |
| 画面 | 人格を選ぶ部品が新しい殻に無い | #528 の向きが決まってから |

### 3.3 危ない所（重い順）

1. **再同期が消す**（`src/app/scheduler.ts:222-262`）。飛ばす処理は、ローカルの行を作れるようになる PR より前に main に入れる
2. **戻せなくなる点**。ローカルの行ができた後に WP1 を戻すと、1 と同じ事が起きる。戻すのは門を開けた PR（WP5）だけ
3. **設定から人格を外したとき**。`PersonaRouter.ownerOf` は、設定に無い人格の場所を既定の人格の物として扱う（`src/app/personas.ts:65-68`）。だからローカルかどうかは DB の列で決める
4. **管理の操作にローカルの番号が渡る**。呼ぶ所は `channel-ops.ts`・`categories.ts`・`topic-move.ts`・`commands/delete.ts`・`session-ops.ts`・`reminders.ts`・`commands/setup.ts`・`main.ts`
5. **Discord にだけ出て、履歴に無い文**。Web だけの場所では消える。ローカルの Gateway に来た送信を数えて洗い出す
6. **`<#ID>` の文**。まとめ・`session_open` の返事・入口の引き継ぎの要約（`src/app/inbox-rotate.ts`）

### 3.4 プロンプトキャッシュ

外れない。既定の人格のシステムプロンプトもツールの定義も変えない。

### 3.5 採らなかった案

| 案 | 中身 | 採らない理由 |
|---|---|---|
| 既定の Bot が代わりに持つ | トークンの無い人格も Discord にチャンネルを作り、既定の Bot が喋る | オーナーの答え 4。右腕の Bot が別の人格として喋る事になる |
| 人格ごとに選べる | 上と Web だけの両方を作る | 今は要らない |

## 4. Antigravity の調べ

### 4.1 「AGP」

「AGP」という名前の物は、Antigravity の公式の文書のどこにも無かった【事実】。意味はオーナーの答え 1 で決まった。

### 4.2 `agy` のヘッドレス（公式の文書から）

| 項目 | 中身 | 印 |
|---|---|---|
| 入れ方 | `curl -fsSL https://antigravity.google/cli/install.sh \| bash`。置き場の既定は `~/.local/bin/agy`（macOS・Linux）。npm・Homebrew の記述は無い | 事実 |
| sudo | 記述が無い。置き場がユーザー領域なので要らない見込み | 推測 |
| 対象 | Linux x86_64 は対象（Enterprise Gateway の文書）。glibc の版の記述は無い | 事実／未確認 |
| 1 回だけ動かす | `-p`（`--print`・`--prompt`）。返事は stdout、診断は stderr | 事実 |
| 出力 | `--output-format` は `text`・`json`・`stream-json` | 事実 |
| stream-json | 1 行 1 イベント。`init`（`conversation_id`、`init.cwd`・`init.tools`・`init.permission_mode`、設定したときだけ `model`・`agent`）／`step_update`（`step_index`・`state` = `ACTIVE`/`DONE`・`step_type` = `user_input`/`agent_response`/`tool`/`checkpoint`、在れば `tool_name`・`text_delta`・`usage`・`tool_info`）／`result`（`conversation_id`・`status`・`response`・`duration_seconds`・`num_turns`・`usage`） | 事実 |
| 使った量 | `usage` は `input_tokens`・`output_tokens`・`thinking_tokens`・`cache_read_tokens`・`total_tokens` | 事実 |
| 終わりの状態 | `SUCCESS`・`ERROR`・`CANCELED`・`INTERRUPTED`・`INVALID`・`WAITING`・`RUNNING` | 事実 |
| 続き | `--conversation <id>`（id は前の出力の `conversation_id`）か `--continue`。どちらも新しいプロセス。会話の一覧は作業フォルダごと | 事実 |
| 別のフォルダから id で続けられるか | 記述が無い | 未確認 |
| 1 プロセスで複数ターン | `--input-format stream-json`（`--output-format stream-json` が要る。`-p` は付けない）。入力は `{"event":"user","message":{"content":"…"}}`。中身はテキストだけ。ターンごとに `result`。stdin を閉じると今のターンの後に exit 0 | 事実 |
| 止め方 | `SIGINT` で `INTERRUPTED`。`--print-timeout`（既定は無制限）。`SIGTERM` の記述は無い | 事実／未確認 |
| exit code | 0 = 成功（許可をやんわり拒否した回も 0）／1 = 失敗・壊れた入力／2 = CLI が自分で答えるスラッシュコマンドなど | 事実 |
| 許可 | ヘッドレスに対話の確認は無い。得られない許可は「やんわり拒否」: 続行して exit 0、stderr に知らせ | 事実 |
| 既定のモード | v1.5.7 から、`agentMode` が無ければ `agy -p` は `auto`（作業フォルダの編集と sandbox の中のコマンドを自動で通す）。`--mode=default` なら編集もコマンドも確認が要る。`plan` は書かない | 事実 |
| 許可の決まり | `~/.gemini/antigravity-cli/settings.json` の `permissions.allow`・`ask`・`deny`。形は `action(target)`。action は `read_file`・`write_file`・`command`・`read_url`・`execute_url`・`download_url`・`mcp`。強さは Deny > Ask > Allow | 事実 |
| `toolPermission` | `request-review`（既定。書き込み・コマンド・外へのネットの前に確認）／`strict`（読み以外はすべて確認。`auto` より強い）／`proceed-in-sandbox`／`always-proceed`（= `--dangerously-skip-permissions`） | 事実 |
| 検索の許可の名前 | 記述が無い | 未確認 |
| プロジェクトごとの許可のファイル | 記述が無い（ユーザー全体の 1 つだけが書いて在る） | 未確認 |
| 人格の文 | 作業フォルダの `AGENTS.md`・`GEMINI.md` は常に効く規則。全体の物は `~/.gemini/AGENTS.md` など。1 ファイル 24,000 バイトまで。ヘッドレスで読むかの記述は無い | 事実／未確認 |
| 自前の agent | `.agents/agents/<name>.md`（frontmatter に `name`・`description`・`tools`（許す道具の一覧）・`mainAgent`・`model` など。本文がシステムプロンプト）。`--agent <name>` のフラグは在るが、自前の agent を選べるとは書いていない。検索・URL の道具の名前も書いていない | 事実／未確認 |
| モデル | `--model <slug>`（一覧は `agy models`）。知らない名前は exit 1 で `invalid model selection`。`--effort` は `low`〜`max`（モデルによる） | 事実 |
| sandbox | `--sandbox`。Linux は kernel の名前空間。特権なしの user namespace を塞ぐホストでは使えず、そのとき `--sandbox` は何もしない | 事実 |
| サインイン | 保存済みが無ければブラウザを開く。SSH では URL を出すので、別の機械で開いてコードを端末に貼る。ヘッドレスは保存済みの資格情報を使い、無ければ `authentication required` の誤りで終わる（固まらない） | 事実 |
| 資格情報の置き場 | OS の鍵束（Linux は Secret Service / D-Bus、macOS は Keychain）。鍵束が閉じている・無いと、固まる・D-Bus の警告・`failed to retrieve token: secret keyring is locked`。公式の直し方は「D-Bus のセッションと鍵束のデーモンを動かす（例: `export $(dbus-launch)`）」。鍵束が無いときのファイルへの退避は書いていない | 事実／未確認 |
| 枠 | Pro・Ultra は 5 時間ごとに戻り、週の上限が在る。同じ組のモデルは上限を分け合う。`/usage` で残りを見る（スラッシュコマンドは `agy -p` で別に呼べと書いて在る） | 事実 |
| 枠が尽きたときに何が返るか | 記述が無い | 未確認 |
| AI クレジット | `settings.json` の `useG1Credits`（true で、枠が尽きた後に買ったクレジットを使う）。既定値の記述は無い | 事実／未確認 |
| 自動の更新 | 裏で自分を更新する。`AGY_CLI_DISABLE_AUTO_UPDATE=true` で止まる | 事実 |
| 状態の置き場 | 設定は `~/.gemini/antigravity-cli/`。作業フォルダごとの最後の会話は `…/cache/last_conversations.json`。会話の本体の置き場は書いていない | 事実／未確認 |

### 4.3 この機械の今（読むだけで確かめた）

- `agy` は入っていない。`~/.gemini` も無い
- x86_64・glibc 2.39
- 鍵束が無い（gnome-keyring は入っていない。ユーザーの D-Bus に Secret Service が居ない）。ユーザーの D-Bus 自体は在る
- 特権なしの user namespace は AppArmor で絞られている（Ubuntu 24.04 の既定）。`agy` の sandbox は使えない見込み【推測】。`/usr/bin/bwrap` は在る（`shell.md` の段で入れた物）

## 5. エンジンの線: `agy` のヘッドレス

### 5.1 形

- **1 ターン = 1 プロセス**。常駐させない。続きは `--conversation <id>`
- **本文は stdin で渡す**のを第一候補にする: `--input-format stream-json --output-format stream-json` で 1 行書いて stdin を閉じる。理由は、引数に載せると長い本文で上限に当たり、プロセスの一覧にも本文が出るため。`--conversation` と組めるかは【未確認】。組めなければ `-p` に本文を載せ、長さの上限を自前で持つ
- **作業フォルダ**: `<SELF_AGENT_DATA_DIR>/antigravity/<人格の id>/`。人格ごとに 1 つ。会話の一覧が作業フォルダごとなので、場所を変えない
- **固定で付ける物**: `--mode default`（`auto` にしない）・`--output-format stream-json`。人格の設定が在れば `--model`・`--effort`
- **決して付けない物**: `--dangerously-skip-permissions`・`--remote-control`・`--remote-agent`・`--add-dir`（テストで引数を固定する）
- **子の env は許可の方式**: `PATH`・`HOME`・`LANG`・`XDG_RUNTIME_DIR`・`DBUS_SESSION_BUS_ADDRESS`・`AGY_CLI_DISABLE_AUTO_UPDATE=true` だけ。Discord のトークン・`CLAUDE_CODE_OAUTH_TOKEN` は渡さない（`personas.md` §5.3・§5.4 の codex と同じ考え）
- **同時に動かすのは全体で 1 つ**（`personas.md` §5.1 の codex の決まりと同じ考え: 1 つのサインインは 1 本の直列の流れ。N100 の負荷も軽くなる。待ち行列への乗せ方は `personas.md` §5.2）
- **`agy` の場所**: `SELF_AGENT_AGY_PATH`（在れば）→ PATH → `~/.local/bin/agy`。サービスの PATH に `~/.local/bin` が無くても見つかるようにする

### 5.2 調べ物だけに絞る（答え 3）

読んだ Web のページに悪い指示が混ざっていても、この機械の物を読ませない・書かせない・コマンドを打たせない。`agy` は self-agent と同じ OS のユーザーで動くので、ここがこの線でいちばん危ない。

重ねる守り:

| # | 守り | 誰が | 印 |
|---|---|---|---|
| 1 | 専用の作業フォルダで動かす | self-agent | 事実（形として） |
| 2 | `--mode default` を必ず付ける（編集とコマンドは確認が要る → ヘッドレスではやんわり拒否） | self-agent | 事実（文書の通りなら） |
| 3 | 全体の設定に `"toolPermission": "strict"` | オーナーの手 | 事実（文書の通りなら） |
| 4 | 全体の設定の `permissions.deny` に `write_file(*)`・`command(*)`・`mcp(*)`・`execute_url(*)`・`download_url(*)` | オーナーの手 | 事実（形）／効き方は未確認 |
| 5 | 全体の設定の `permissions.allow` に `read_url(*)`（これが無いと URL の読み取りも拒まれる見込み） | オーナーの手 | 推測 |
| 6 | 作業フォルダの外のファイルの読みが拒まれる事 | AG0 で確かめる | **未確認** |
| 7 | 自前の agent の `tools` で、道具を検索と URL の読み取りだけにする | AG0 で使えると分かれば | 未確認 |

**門を開ける条件（設計の側の決め事。答え 3 の「触らせない」から出る）**: AG0 で「フォルダの外の読み・書き込み・コマンド」の 3 つがどれも拒まれると確かめるまで、門（AG6）を開けない。設定だけで拒めないと分かったら、OS の側で囲う段（AGX。今の `/usr/bin/bwrap` と AppArmor の profile を使い、作業フォルダと `agy` の置き場だけを見せる）を AG6 の前に入れる。

3〜5 は `~/.gemini/antigravity-cli/settings.json`（オーナーの家の下。self-agent は書かない）に入る。足す行は `npm run agy-setup -- --print` が標準出力に出す（`cc-setup`・`unify-setup` と同じ形）。この設定は、同じ機械でオーナーが端末から `agy` を使うときにも掛かる（§9 の 1）。

後から広げるとき（プロジェクトを触らせる）は、作業フォルダと `permissions` を人格ごとに変える段を足す。今の形はそれを塞がない。

### 5.3 人格の文

- 第一候補: 作業フォルダの `AGENTS.md`。self-agent が起動のたびに、人格のファイル（`_PROMPT_FILE`）の文 + このエンジン用の決まった文（調べ物と相談だけをする・ファイルを書かない・コマンドを打たない）で書き直す
- Claude 用の共通の本文（ツールの説明を含む）は入れない
- 文は静的に保つ（日時や ID を入れない）。Claude の側と同じ決まり
- AG0 で `--agent` と `tools` が使えると分かれば、`.agents/agents/<id>.md`（本文がシステムプロンプト・`tools` が許す道具）に替える。どちらにするかは AG0 の後に設計が決める

### 5.4 #114 の枠に乗せる

- `ENGINES` に `antigravity` を足す。人格の変数は今の物のまま: `_ENGINE=antigravity`・`_MODEL`（省けば `agy` の既定）・`_EFFORT`
- 型: `PersonaConfig` の合併に `{ engine: "antigravity"; effort: string | undefined }` を足す
- runner: `AgentRunner` を満たす物を 1 つ足す。`src/main.ts:371-398` で、エンジンで分ける
- codex と違い、**runner が入るまで Claude で代わりに動かさない**。`_ENGINE=antigravity` は門（AG6）まで設定エラー
- 会話の続き: `conversation_id` を `channel_sessions` に入れ、`engine` を `antigravity` にする（列は v18 から在る）。`result` を受け取れたときだけ `sessionRecorded: true`
- 使った量（取れる物だけ）: `usage` の `input_tokens`・`output_tokens`・`cache_read_tokens` を `TurnUsage` に当てる。キャッシュの作成は 0。ステップごとの内訳は `step_update.usage` が在れば入れ、無ければ空。`usage_log.engine` は `antigravity`、`model` は `init.model`（在れば）
- 途中経過: `step_update` の `step_type: "tool"` を `onProgress` に流す
- 中断: `signal` が abort されたら `SIGINT`。決めた時間で終わらなければ `SIGKILL`。結果は `aborted`。時間の打ち切りは自前の時計で `timeout`
- 自前のツール（メモリー・リマインド・`session_open`）は最初は渡さない。後の段（AG7）では、`agy` がこの機械で動くので、codex と同じ道（#114 の PR-D と PR-E = 127.0.0.1 の MCP）を使い回せる

### 5.5 Claude 前提の機能を、この人格でどうするか

| 機能 | 扱い | 根拠 |
|---|---|---|
| 入口での会話 | できる | |
| 話題を分ける | 最初はできない（`session_open` を持たない）。WP6 の API か、後の AG7 から | |
| /renew | できる見込み。要約のターンは `runner.run` だけを使う（`src/app/session-renew.ts:104-148`）。枠を 1 ターン使う | 推測（AG4 のテストで確かめる） |
| 入口の日替わり | できる見込み。同じく `runner.run` だけ（`src/app/inbox-rotate.ts:298`）。会話が在った日は、人が打たなくても 1 ターン使う | 推測（同上） |
| 画像・添付 | できない。入力はテキストだけ【事実】。「この人格は画像を読めません」と出し、文だけでターンにする | |
| オーナーが貼った URL だけ読む決まり | 掛けられない。`agy` の側の `read_url` の決まりで動く | |
| 許可を訊く（プロジェクトのセッションの物） | 無い。やんわり拒否 | |
| 会話の要約（compaction）の印 | 無い。長くなって失敗したら /renew を案内する | 未確認（自動で縮めるか） |
| 手順の上限（maxTurns） | 無い。時間の打ち切りだけ | |
| プロジェクト・モデル選び・場所の移動 | できない（人格の話題は今も軽いセッションだけ） | 事実 |
| 取り込み | できない（既定の人格のプロジェクトのセッションの物） | 推測 |
| 利用枠の自動のやり直し・［もう一度送る］（#483） | しない（§5.6）。Claude の側もまだ main に無い【事実: `src` に実装が無い】 | |
| 統括のまとめ（L2） | 今のまま出る（アプリが作る文） | 事実 |

できない物は、黙って落とさず、決まった文で「できない」と出す。

### 5.6 止まり方の分類

| 起きた事 | 見分け方 | 出し方 |
|---|---|---|
| `agy` が無い | 起こせない（ENOENT） | ターンにしない。「この機械に `agy` が入っていません」 |
| サインインしていない・切れた | 誤りの文に `authentication required`【事実: 公式の文】 | 「サインインが切れています。端末で `agy` を開いてサインインしてください」 |
| 鍵束を読めない | 誤りの文に `keyring`【事実: 公式の例】 | 「資格情報を読めません」+ やり直しの案内 |
| 枠が尽きた | **形が分からない**【未確認】 | 最初は下の「その他」に入る。形が分かった時点で分類を足す |
| その他の失敗 | `status` が `SUCCESS` 以外・exit 1 | 「止まりました」（`TurnOutcome` の `failed`。`src/app/progress.ts:34-41`）。理由の行に `error` の先頭 1 行 |
| 中断 | 自分で送った `SIGINT` | 「中断しました」 |
| 時間切れ | 自前の時計 | 今の打ち切りと同じ |

- 止まったターンは、今の「止まった話題」の扱い（あなたの番に数える。`docs/plan/lead.md` の決定 4・L1c の PR-3）にそのまま乗る【推測: runner の失敗として同じ道を通る。AG3 のテストで確かめる】
- #483（利用枠で止まったときの自動のやり直しと［もう一度送る］）は、Claude の側もまだ main に無い【事実】。Antigravity の側は、枠が戻る時刻も誤りの形も分からないので、最初は入れない。#483 が入り、形が分かったら、後の段（AG9）で同じ道に乗せる
- console の log には分類だけを出す。`error` の本文・作業フォルダのパスは出さない

### 5.7 `agy` が無い・サインインしていない機械

- **起動は止めない**。設定の書き間違い（知らないエンジン名など）は今まで通り exit 1。`agy` が無い・サインインしていないは exit 1 にしない
- 起動のときに `agy --version` を 1 回だけ試す（枠を使わない）。無ければ、その人格を「使えない（入っていない）」にして log に 1 行
- サインインの有無は起動では見ない。最初のターンで分かる（§5.6）
- `/api/status` の人格の行に `engine` と `available`（`ok` / `not_installed` / `signed_out` / `unknown`）を足す
- npm で配る物（`docs/plan/distribution.md`）: 依存を足さない（子プロセスを起こすだけ）。`agy` は同梱しない
- Mac: 置き場の既定は同じ `~/.local/bin/agy`。資格情報は Keychain。サービスとして動く self-agent から Keychain を読めるかは【未確認】。使わない人の起動には何も影響しない

### 5.8 プロンプトキャッシュ

- Claude の側: 外れない。既定の人格のシステムプロンプトもツールの定義も変えない（答え 5 で、右腕のツールも変えない）
- Gemini の側: 人格の文を静的に保つ・履歴は追記だけ・モデルを途中で変えない

### 5.9 残る危なさと手間

- §5.2 の 6（フォルダの外の読み）が設定で止められるかが分からない。門の条件にした
- `agy` は自分を更新する。出力の形が変わりうる。知らないイベントは読み飛ばし、`agy --version` を log に 1 行出す。更新の後は `npm run agy-check` を回す
- 鍵束: この機械には無い。要ると分かれば入れる（sudo）必要が出て、再起動のたびに開ける手間が出るかもしれない【推測】
- 同じサブスクの枠を、オーナーの手元の Antigravity と分け合う【推測】
- 追加の運用の費用は無い（外のサービスを足さない。AI クレジットを切っておく限り）

### 5.10 採らなかった案

| 案 | 中身 | 採らない理由 |
|---|---|---|
| Gemini API の Antigravity agent | API キーの従量。Google の箱で動く。HTTP だけ | オーナーの答え 2（サブスクの枠で動かす） |
| `agy` を API キーで | この機械で、従量 | 同じ |
| SDK（Python） | 常駐が 1 つ増える。サインインの道が文書に無い | 同じ + 重い |
| ACP（`agy acp`）で常駐 | JSON-RPC。エディタ向け | 1 ターン 1 プロセスで足りる。常駐を増やさない |
| 1 プロセスで複数ターン | `--input-format stream-json` で開けたまま | 常駐と後始末が増える |

## 6. オーナーの手が要る事

コマンドは公式の文書の物。公式に無い物は【推測】と書いた。**sudo の要否**を列にした。

| # | いつ | 何を | sudo |
|---|---|---|---|
| 1 | AG0 の前 | `agy` を入れる: `curl -fsSL https://antigravity.google/cli/install.sh \| bash`。置き場は `~/.local/bin/agy`。確かめは `agy --version`。入れる前に中身を読むなら、いったんファイルに落としてから。PATH を書き換えさせない・古い別名を触らせないフラグ（`--skip-path`・`--skip-aliases`）が在る | 要らない見込み【推測: 公式に記述なし。置き場はユーザー領域】 |
| 2 | 1 の後 | サインインの前に 1 回だけ `agy -p` を打ち、「サインインしていないとき」の出方を残す（枠を使わない） | 不要 |
| 3 | 2 の後 | サインイン: tmux の中で `agy` を開く。SSH だと URL が出るので、電話で開いてサインインし、出たコードを端末に貼る。個人の Google アカウント（サブスクの物）を選ぶ | 不要 |
| 4 | 3 が通らないとき | 鍵束。公式の直し方は「D-Bus のセッションと鍵束のデーモンを動かす（例: `export $(dbus-launch)`）」。この機械には鍵束のデーモンが無いので、入れる必要が出るかもしれない（`sudo apt install gnome-keyring`【推測: 公式の文書の物ではない】） | **要るかもしれない** |
| 5 | 3 の後 | 全体の設定 `~/.gemini/antigravity-cli/settings.json` に、§5.2 の 3〜5 と `"useG1Credits": false` を足す（AG0 では手で。後は `npm run agy-setup -- --print` が行を出す） | 不要 |
| 6 | AG0 | 実測に「はい」と言う（サブスクの枠を使う。§7） | 不要 |
| 7 | AG6 | env ファイルに人格を足す（`SELF_AGENT_PERSONAS`・`_NAME`・`_PROMPT_FILE`・`_ENGINE=antigravity`、Web だけなら `_SURFACE=web`）。再起動に「はい」と言う | 不要 |
| 8 | サインインが切れたとき | 3 をもう一度（要れば先に `agy` の中で `/logout`）。機械を再起動した後に鍵束が閉じていれば、開ける | 4 と同じ |
| 9 | `agy` を更新したとき | `npm run agy-check`（枠を使う） | 不要 |

self-agent が自分でしない事: `agy` を入れる・サインインする・`~/.gemini` の下を書く・sudo。

## 7. AG0: この機械の実測（訊いてから 1 回だけ）

オーナーが入れてサインインした後、**「回して良いか」を訊いてから** 1 回。サブスクの枠を 10 ターンほど使う。結果は `docs/research/antigravity-cli.md` に、`agy` の版と一緒に残す。秘密の物は使わない（読ませる試しのファイルは、その場で作った無害な物）。

| # | 測る事 | 分かる事 |
|---|---|---|
| 1 | サインインの前の `agy -p` | 誤りの文・exit code（枠を使わない） |
| 2 | `agy --version`・`agy models` | 版。モデルの名前。サインインが要るか |
| 3 | 2 ターン（stream-json） | イベントの実物。`usage` が 1 回ごとか累計か。`input_tokens` がキャッシュの読みを含むか |
| 4 | 続き（`--conversation <id>`） | 前のターンを覚えているか。別のフォルダからでも続くか |
| 5 | stdin で渡す形 + `--conversation` | 組めるか。stdin を閉じた後の exit code |
| 6 | 人格の文 | 作業フォルダの `AGENTS.md` がヘッドレスで効くか。`--agent` で自前の agent を選べるか。`init.tools` に出る道具の名前 |
| 7 | 道具の拒否（`--mode default` + §5.2 の設定） | フォルダの中への書き込み・コマンド・**フォルダの外の読み**が拒まれるか。URL の読み取りと検索は通るか。stderr の知らせの形 |
| 8 | 中断 | `SIGINT` の後の `status`・exit code。`SIGTERM` ではどうか。子プロセスが残らないか |
| 9 | 枠の表示 | `agy -p "/usage"` がヘッドレスで返すか。形 |
| 10 | サービスから | 端末を持たないユーザーのサービス（self-agent と同じ起こし方）から、資格情報を読めるか |
| 11 | 置き場 | `agy` が作業フォルダと `~/.gemini` に何を書くか。新しいフォルダで「信頼するか」を訊かれるか。`GEMINI_HOME` で設定の置き場を分けられるか |
| 12 | 重さ | 最初のイベントまでの時間。メモリー |

測れない事: 枠が尽きたときの出方（わざと尽くさない）。

## 8. 段（1 PR = 1 論点）

印: 再 = 再起動が要る／手 = オーナーの手が要る／枠 = 利用枠を使う。

### 8.1 設計書

| 段 | 何をするか | 再 | 手 | 枠 |
|---|---|---|---|---|
| WP0 | 設計書 `docs/plan/personas-web-antigravity.md`（この文書）。CLAUDE.md の表に 1 行、`docs/status.md` に節。2 本の線を 1 本に書く | | | |

### 8.2 場所の線

| 段 | 何をするか | 再 | 手 | 枠 |
|---|---|---|---|---|
| WP1 | DB（次の番号）: `sessions.place`・`persona_channels.place`・連番の表。store。再同期がローカルを飛ばす | 再 | | |
| WP2 | ローカルの Gateway（部品とテスト）。`PersonaRouter` が `place` を先に見て振り分ける | | | |
| WP3 | 管理の操作の関所: 作る・移す・消す・トピック・数え上げが、ローカルで Discord を呼ばない | | | |
| WP4 | 文と知らせ: まとめ・`session_open` の返事・入口の引き継ぎ・`/sessions` などが、ローカルの話題を題名で書く。リマインドの扱い | | | |
| WP5 | 門を開ける: `_SURFACE`、起動の配線、入口を無ければ作る、#system と `/new` から外す、`docs/environment.md`。**確かめは、Claude で動く Web だけの人格を 1 体足して行う** | 再 | 手（名前・人格の文・env） | 枠（Claude。確かめの数ターン） |
| WP6 | Web API: `POST /api/topics` が `persona` を受ける。一覧・`/api/channels`・`/api/status` に `surface`。`web-ui-rebuild.md` の約束の節に足す | 再 | | |
| WP7 | 画面: 話題を始めるときに人格を選ぶ | | | **#528 の向きが決まるまで止める** |

### 8.3 エンジンの線

| 段 | 何をするか | 再 | 手 | 枠 |
|---|---|---|---|---|
| AG0 | 実測（§7）と記録 `docs/research/antigravity-cli.md` | | 手（§6 の 1〜6） | 枠（Google。訊いてから） |
| AG1 | runner の読み取り: stream-json の行 → `RunResult`（偽のプロセス。AG0 で残した実物の行をテストに使う） | | | |
| AG2 | 起こし方: 引数・env・作業フォルダ・人格の文のファイル・中断・打ち切り | | | |
| AG3 | 止まり方の分類（§5.6）と「使えない」の出し方（§5.7）。同時に 1 つ。会話の続きと使った量の記録 | | | |
| AG4 | Claude 前提の機能の扱い（§5.5）: 画像の断り・/renew・入口の日替わりの確かめ・できない物の文 | | | |
| AG5 | `npm run agy-check`（実機の受け入れ。§7 の 3・4・7・8 を機械で）と `npm run agy-setup -- --print`。`docs/commands.md` | | | 枠（Google。回すとき） |
| AG6 | 門を開ける: `ENGINES`・設定の読み込み・配線・`/api/status`・`docs/environment.md`（§1.3 への案内の 1 行） | 再 | 手（env・`agy-check`） | 枠（Google。確かめ） |

AG6 を開ける条件: AG0 で §5.2 の 3 つの拒否が確かめられている事。Antigravity の人格を Web だけにするなら、WP5 の後。

後で（今は作らない）:

| 段 | 何をするか | 待つ物 |
|---|---|---|
| AGX | OS の側で囲う（bwrap） | AG0 で設定だけでは拒めないと分かったときだけ。そのときは AG6 の前 |
| AG7 | 自前のツールを渡す | #114 の PR-D・PR-E |
| AG8 | 範囲を広げる（プロジェクトを触らせる） | オーナーが言ったとき |
| AG9 | 枠が尽きたときの自動のやり直し | 出方が分かったとき |
| AG10 | 右腕から頼む | 答え 5 で下げた。L4 と同じ回（ツールの定義が変わる = キャッシュが 1 回外れる） |

### 8.4 受け入れ条件（テストできる形）

- WP1
  - 古い DB から上げると、今在る行の `place` はすべて `discord`
  - `place = 'local'` の話題は、Discord の親カテゴリの一覧に無くても、再同期の後に状態も SDK のセッションの対応も種も変わらない
  - `place = 'discord'` の話題の再同期は今と同じ
  - 連番から作った番号は数字 21 桁で、続けて取ると違う値
- WP2
  - ローカルの Gateway の `send`・`sendMessage` は、毎回違う数字 21 桁を返す。管理の操作は投げる
  - `place = 'local'` の場所の `gatewayFor` は、持ち主の人格が設定に無くてもローカルの Gateway を返す
- WP3
  - ローカルの人格の話題を作ると、偽の Gateway の `createTextChannel` が呼ばれず、`sessions` に `place = 'local'` の行ができる
  - 待ち・完了・進行中にしても `moveChannel` が呼ばれず、DB の状態だけ変わる。消すと `deleteChannel` が呼ばれない
  - カテゴリの空きの数え上げにローカルの話題が入らない
- WP4
  - ローカルの話題のまとめの本文に `<#` が無く、題名が在る
  - ローカルの話題への Web の発言 1 つで、履歴に owner の行と agent の行ができる
  - その 1 ターンの間にローカルの Gateway に来た送信のうち、履歴に対応の行が無い物の一覧をテストが固定する
  - ローカルの場所のリマインドは、履歴に残すか・置けないと返すかを決めてテストする
- WP5
  - `_SURFACE=web` でトークンも在ると、変数名を出して exit 1。知らない値でも同じ。`_SURFACE` 無し・トークン無しは今と同じ文で exit 1
  - `_SURFACE=web` の人格が在っても、Discord の Client の数は増えない
  - 起動すると、その人格の入口が `persona_channels` に `place = 'local'` で 1 行できる。もう一度起動しても増えない
  - `GET /api/topics` の入口にその人格の行が出て、発言でき、返事が履歴に出る（Discord の偽 Gateway に送信が行かない）
  - `/new` の `persona` の選択肢に出ない。#system に接続の知らせが出ない
  - 既定の人格のシステムプロンプトが、変更の前とバイト単位で同じ
  - 実機: Claude で動く Web だけの人格の入口で 2 ターン話し、`session_open` で話題を 1 つ作り、終わりのまとめが右腕に題名で出る
- WP6
  - Web だけの人格の `persona` を付けると、その人格のローカルの話題ができる。知らない `persona` は 400。`place` や `model` と一緒なら 400。`persona` 無しは今と同じ
- AG1
  - AG0 で残した行から、本文・`conversation_id`・入力／出力／キャッシュの読みのトークンが `RunResult` に入る
  - 知らないイベントの行・JSON でない行が混ざっても落ちない
  - `result` が来ないまま終わると `ok: false`・`sessionRecorded: false`
- AG2
  - 引数に `--mode default` と `--output-format stream-json` が必ず在り、`--dangerously-skip-permissions`・`--remote-control`・`--remote-agent`・`--add-dir` が決して無い
  - 子の env に Discord のトークン・`CLAUDE_CODE_OAUTH_TOKEN` が無く、`AGY_CLI_DISABLE_AUTO_UPDATE=true` が在る
  - 作業フォルダが無ければ作り、人格の文のファイルを書く。2 回目も同じ中身
  - 続きのターンの引数に、保存した id の `--conversation` が在る
  - `signal` の abort で子に `SIGINT` が届き、結果は `aborted`。決めた時間の後は `SIGKILL`
  - 本文が引数にも log にも出ない
- AG3
  - 起こせない（ENOENT）と、runner を呼ばずに決まった文を返し、`/api/status` の `available` が `not_installed`
  - 誤りの文に `authentication required` が在ると、決まった文を返し、`available` が `signed_out`。次に成功すると `ok` に戻る
  - Antigravity のターンが動いている間、別の Antigravity のターンは始まらない。Claude のターンは始まる
  - 再起動の後の次のターンが、保存した id で続く。`usage_log` の行の `engine` が `antigravity`
  - Antigravity の runner の失敗で終わった話題が、Claude の失敗のときと同じく「あなたの番」に数えられる
- AG4
  - 画像を付けた発言は、決まった断りの文が付き、文だけでターンになる
  - /renew と入口の日替わりが、偽の runner（Antigravity の物）で今と同じ結果になる
- AG6
  - `_ENGINE=antigravity` の人格が在り、`agy` が無い機械で、起動が exit 0 で続く
  - その人格の入口の発言で Antigravity の runner が 1 回呼ばれ、Claude の runner は呼ばれない
  - 既定の人格のシステムプロンプトとツールの定義が、変更の前と同じ
  - 実機: `npm run agy-check` が通る。入口で 2 ターン話し、2 ターン目が 1 ターン目を覚えている。［中断］で止まる

実装に渡すときの注意: WP1・WP5・WP6・AG6 は再起動を伴うので、マージの後にオーナーに訊いてから。WP2〜WP4・AG1〜AG5 は使われない部品で、main に入れても動きは変わらない。AG1 は AG0 の記録（実物の行）が無いと始められない。

## 9. 残った問い（重い順。1 つずつ訊ける形）

**1. この機械の `agy` を、オーナー自身も端末から使いますか。**
調べ物だけに絞る設定（書き込みとコマンドを拒む）は、`agy` の全体の設定に入れます。同じ機械で自分でも `agy` を使うなら、その使い方にも掛かります。
- a. 使わない。この機械の `agy` は self-agent 専用（推し。いちばん固く絞れる）
- b. 自分でも使う（self-agent 用に設定の置き場を分けられるかを実測で見る。分けられなければ、OS の側で囲う段を先に作る）

**2. サブスクの枠が尽きた後、買った AI クレジットを自動で使いますか。**
- a. 使わない（推し。枠が戻るまで「止まりました」と出る。お金は出ない）
- b. 使う（知らない所でお金が出ないよう、1 日の上限の段を先に入れる）

**3. Antigravity の人格は、Web だけにしますか。**
- a. Web だけ（推し。Discord の Bot を作らない。場所の線の WP5 の後に開ける）
- b. Discord の Bot も持たせる（場所の線を待たずに開けられる。Bot を 1 つ作る手間が要る）

**4.（実測の後・要ると分かったときだけ）鍵束を入れますか。**
サインインの保存に鍵束（gnome-keyring）が要ると分かった場合です。入れるには sudo が 1 回要り、機械を再起動するたびに開ける手間が出るかもしれません。
- a. 入れる（推し。他に、サブスクのサインインを保存する道が無い）
- b. 入れない（Antigravity の人格はこの機械では作らない）

**5.（AG6 のとき）モデルは `agy` の既定のままにしますか。**
- a. 既定のまま（推し）
- b. 指定する（`agy models` の一覧から選ぶ）

**6.（WP5 のとき）最初に Web だけで足す人格の名前。**
- a. 名前だけ決めてもらい、人格の文の下書きはこちらで出す（推し）
- b. 名前も文もオーナーが書く

## 10. 決めた事・決まっていない事・確かめられなかった事

### 設計の側で決めた事

| 事 | 中身 |
|---|---|
| 2 本の線に分ける | 場所とエンジンは独立 |
| Web だけは明示の変数で | トークンが無いだけでは Web だけにしない |
| ローカルかどうかは DB の列 | 設定や番号の形では決めない |
| 再同期の「飛ばす」を最初に入れる | ローカルの行を作れる PR より前 |
| 1 ターン = 1 プロセス | 常駐させない |
| `--mode default` を必ず付ける | ヘッドレスの既定は `auto` なので |
| 門の条件 | フォルダの外の読み・書き込み・コマンドが拒まれると実測で確かめるまで開けない |
| runner が無い間に Claude で代わりに動かさない | 設定エラーにする |
| `agy` が無くても起動は止めない | その人格だけ「使えない」 |
| self-agent は `~/.gemini` の下を書かない | 足す行を出すだけ |
| 最初は自前のツールを渡さない | 後で codex と同じ道（PR-D・PR-E） |
| 自動のやり直しをしない | 枠切れの形が分かるまで |

### 決まっていない事

| 事 | 誰が決める |
|---|---|
| §9 の 1〜6 | オーナー |
| 人格の文を `AGENTS.md` で渡すか、自前の agent で渡すか | 設計（AG0 の後） |
| 本文を stdin で渡すか、`-p` で渡すか | 設計（AG0 の後） |
| OS の側で囲う段（AGX）が要るか | 設計（AG0 の結果で決まる） |
| ローカルの場所のリマインドの扱い | 設計（WP4 の中で） |

### §1.2 の既定についての見立て

- 1 日の上限を入れない: 妥当。条件は `useG1Credits` を切る事（§9 の 2）。入口の日替わりは、会話が在った日に人が打たなくても 1 ターン使う。小さいので上限は要らない
- 枠切れを「止まった」ターンで出す: 妥当。ただし最初は、他の失敗と見分けが付かない（形が公式に無い）。理由の行に `agy` の誤りの文を出すので、読めば分かる

### 確かめられなかった事

- 枠が尽きたとき・サインインが切れたときの、実際の出方（公式に在るのは `authentication required` の語だけ）
- `agy` の入れ方が sudo を要るか（公式に記述なし）。この機械の glibc で動くか
- 鍵束の無いサーバーで、資格情報がどこに行くか。サービスから読めるか
- フォルダの外のファイルの読みが、設定で拒めるか。検索の許可の名前
- `AGENTS.md`・自前の agent が、ヘッドレスで効くか。`--agent` で自前の agent を選べるか
- stdin の形と `--conversation` を組めるか。別のフォルダから id で続けられるか
- `usage` が 1 回ごとか累計か。会話が長くなったときに自動で縮めるか
- `SIGTERM` での止まり方。新しいフォルダで「信頼するか」を訊かれるか。`GEMINI_HOME` が CLI に効くか
- `useG1Credits` の既定値
- Mac のサービスから Keychain を読めるか
- コードの側: ローカルの場所でのリマインド・入口の引き継ぎ・進み具合の表示の実際の道。止まったターンが、runner の種類によらず「あなたの番」に数えられる事。取り込み・GitHub の話題・Claude Code のチャンネルが既定の人格だけである事（読んだ範囲ではそう見える）
- この調べ物では何も動かしていない

## 11. 出典

公式

- 文書の目次: https://antigravity.google/llms.txt
- 入れ方: https://antigravity.google/docs/getting-started/
- サインイン: https://antigravity.google/docs/install?tab=cli
- ヘッドレス: https://antigravity.google/docs/cli/headless/
- コマンドと設定: https://antigravity.google/docs/cli/reference/
- モード: https://antigravity.google/docs/cli/modes
- 許可: https://antigravity.google/docs/permissions
- sandbox: https://antigravity.google/docs/sandbox
- 規則（`AGENTS.md`）: https://antigravity.google/docs/rules
- 自前の agent: https://antigravity.google/docs/subagents
- 会話と続き: https://antigravity.google/docs/cli/conversations ・ https://antigravity.google/docs/cli/commands/resume
- 枠の表示: https://antigravity.google/docs/cli/commands/usage
- AI クレジット: https://antigravity.google/docs/cli/credits
- 困ったとき（鍵束・PATH・更新）: https://antigravity.google/docs/cli/troubleshooting
- 使い方のこつ: https://antigravity.google/docs/cli/best-practices ・ https://antigravity.google/docs/cli/using
- プラン: https://antigravity.google/docs/plans
- FAQ: https://antigravity.google/docs/faq/
- 規約: https://antigravity.google/terms/
- ACP: https://antigravity.google/docs/cli/acp/
- Remote Control: https://antigravity.google/docs/remote-control
- Enterprise Gateway（対象の OS）: https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools/connect-enterprise-gateway
- 採らなかった案の元: https://aistudio.google.com/docs/antigravity-agent ・ https://antigravity.google/docs/sdk/overview

公式でない物（参考）

- フォーラムの停止の訴えの例: https://discuss.ai.google.dev/t/apology-and-appeal-unintentional-tos-violation-via-a-third-party-tool/201962
- フォーラムの問い（他のアプリから公式の CLI をサブスクで回せるか）: https://discuss.ai.google.dev/t/can-a-third-party-desktop-app-run-the-official-antigravity-cli-with-the-user-s-own-google-ai-pro-ultra-subscription/190447
- 概要と経緯: https://en.wikipedia.org/wiki/Google_Antigravity
