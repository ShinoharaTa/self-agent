# Discord の Bot を持たない人格（Web だけ）と、話題ごとに選ぶ Antigravity のモデル（#530）

- 状態: 2026-11-28 の時点。オーナーの答え 7 つ（§1.1）と PR #531 のレビュー（2 回）を入れた。§9 の問いは未決
- 関連: #114（`docs/plan/personas.md`）・#451（`docs/plan/models.md`）・#457（`docs/plan/lead.md`）・#528（`docs/plan/web-ui-rebuild.md`）・#483・`docs/plan/distribution.md`
- 読んだ物: コードは main の `ec663eb` で読んだ。調べ物は同じ日の公開の文書（出典は §11）。レビューで食い違いを指された 4 つは、公式のページの原文（markdown）を開き直して確かめた（§4.3）。`agy` は入れていないし、動かしていない（実測は AG0）
- 印の意味: 【事実】= コードか公式の文書で確かめた / 【推測】= 読んだ物からの見立て / 【未確認】= 確かめられなかった

## 0. 何のために

オーナーの頼み（2026-11-28）は 3 つ。

1. 右腕のような相手（人格）を、手間なく増やしたい
2. Discord の Bot のキーを渡していない人格は、Web UI の上だけで動けば良い
3. Antigravity のエージェントに、self-agent の中から訊きたい・頼みたい

今は、人格を 1 体足すたびに Discord の Developer Portal で Bot を作り、トークンを置き、サーバーに招く必要がある。Claude 以外の相手に同じ画面から頼む道も無い。

2 本の線に分ける。互いに独立で、どちらからでも進められる。

- 場所の線（WP）: 人格が Discord の Bot を持つか、Web だけか
- エンジンの線（AG）: **話題ごとに**、Claude で動くか Antigravity で動くか。話題を始めるときに、モデルと一緒に決まる

エンジンの線は、前の版では「Antigravity で動く人格」を 1 体立てる形だった。オーナーの答え 6 で、人格は立てず、モデルの一覧から選ぶ形に変えた。

## 1. 決まった事

### 1.1 オーナーが決めた事（2026-11-28）

| # | 事 | 中身 |
|---|---|---|
| 1 | 「AGP」の意味 | Antigravity のエージェントに、self-agent の中から頼みたい |
| 2 | お金 | サブスクの枠。この機械に入れた `agy` を、オーナーの Google AI のサブスクのサインインで回す |
| 3 | 操作の範囲 | まず調べ物・相談だけ。`agy` は空の作業フォルダで動かし、この機械のプロジェクトには触らせない。後から広げられる形に |
| 4 | Web だけの人格 | Discord に何も出さない。話題が終わったまとめだけ、今まで通り右腕の #inbox に出す |
| 5 | 右腕との関係 | 右腕からは呼ばない。オーナーが自分で話しかけるだけ |
| 6 | 選び方 | 話題を始めるときのモデルの一覧に、Claude のモデルと並んで Antigravity 経由のモデルが出る。選んだ話題だけ `agy` で動く。Antigravity の人格を別に立てない。最初は、その話題では self-agent の道具（記憶・タスクなど）とプロジェクトの操作は使えない |
| 7 | 記憶 | 共有の記憶は Antigravity の話題に渡さない。後から変えられる形に |

答え 6 から出る事: エンジンは「人格ごとに固定」ではなく「話題ごと」。始めるときにモデルと一緒に決まり、途中で変えない。

### 1.2 オーナーに訊かずに置いた既定

- 1 日の上限は最初は入れない（人が打った分しか動かない。サブスクの側に 5 時間と週の上限が在る）
- 枠が尽きた後に AI クレジットを自動で使う設定（`useG1Credits`）は、公式の既定が切（§4.3 の 4）。入っていたら Antigravity の話題を「使えない」にする（§5.6）。知らない所でお金が出ないため
- 枠が尽きたら「止まった」ターンとして出す（§5.9）
- 最初の Web だけの人格の名前は、門を開ける段（WP5）で訊く

### 1.3 オーナーが受け入れた事（事実だけ）

- 規約 §6: Google が出していない道具でサービスに入る事は違反で、Antigravity と Gemini CLI のアカウントの停止・終了の理由になる、と書いて在る
- 公式の FAQ: `agy -p` は「自分で直に書くスクリプトと CI のための物」。`agy` を他のコーディングエージェントやアプリの中に包む事は、個人向けのプランでは「サポートしない」と書いて在る
- 公式のフォーラムに、他の道具から使って停止になったと訴える題の投稿が複数在る（題で確かめた。中身は読み込んでいない）
- オーナーは 2026-11-28 に、この説明を読んだ上で受け入れた
- 配る文書（`docs/environment.md` の `SELF_AGENT_ANTIGRAVITY_MODELS` の行）に、この節への案内を 1 行入れる（npm で入れた他の人が同じ設定をする前に読めるように）

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

### 2.2 Web の話題と人格

- 新しい殻の `POST /api/topics` は人格を受け取らない（`src/web/routes/topics.ts:744-830`）。Web から始めた話題は必ず既定の人格の物になる
- 古い殻の `POST /api/sessions` は `persona` を受け取る（`src/web/routes/sessions.ts:167-171`）
- `startTopic` 自体は `owner` を受け取れる（`src/app/session-ops.ts`）。今これを使うのは、足した人格の入口からの `session_open`（`src/app/right-hand.ts:133-135`）
- 足した人格の入口 `#<NAME>` は、一覧（`GET /api/topics`）に決まった入口の行として並ぶ（`src/web/routes/topics.ts:399-428`）。**画面を足さなくても、入口は一覧に出る**
- 人格の話題は軽いセッションだけ。プロジェクトもモデルも選べない（`src/app/session-ops.ts:124`・`382-383`）

### 2.3 右腕の扱い

- 右腕は「人格」の行ではない。既定の人格の #inbox を、一覧が `rightHands` に「右腕」の題で入れている（`src/web/routes/topics.ts:429-439`）
- 統括のまとめ（L2）は、どの人格の話題の物も既定の人格の #inbox に出る（`src/app/lead.ts:190`）。本文は `終わりました: <#チャンネルID>` の形（`src/app/lead.ts:72-83`）
- まとめは、同じ文を Discord に投げてから履歴に書く（`src/app/lead.ts:183-193`）。投稿に失敗すると、履歴を書かずに戻る。Web はその履歴の行の頭（`終わりました: <#`・`止まりました: <#`）でまとめと見分け（`isLeadText`。`src/app/lead.ts:72-73・119-121`）、右腕の未読の印を付ける（`src/web/routes/topics.ts:216`）。今の殻は、右腕の会話の中でだけ `<#ID>` を題名と［開く］の札に替える（`src/web/static/shell.js:793・847・857`）
- まとめが出るのは話題のターンだけ（`src/app/handler.ts:460-461`）。入口の行は「止まった」に数えない（`src/web/routes/topics.ts:142・420` の `NO_PROGRESS`。`docs/plan/lead.md` の決定 4 も同じ）

### 2.4 Discord のチャンネルを持たない話題は在るか

**無い。** 理由は 4 つ重なっている。

1. 話題を作ると必ず Discord のテキストチャンネルを作る（`src/app/session-ops.ts:143-165`）
2. そのチャンネルの ID が、`sessions`・履歴・列・SDK のセッションの鍵
3. Web の発言は、ターンにする前に必ず Discord に写す。写せなければ `echo_failed`、持ち主の Bot が落ちていれば `bot_disconnected`（`src/app/handler.ts:634-647`）
4. 再同期（`src/app/scheduler.ts:229-248`）が、Discord に無いチャンネルのセッションを「削除済み」にし、SDK のセッションと種も消す（消すのは `242-247`）

助けになる事実が 2 つ。

- 返事の本文は Discord への送信の成否と関係なく履歴に書く（`src/app/handler.ts:440-460`）。Web は履歴を読む
- 送り先は人格ごとの Gateway に振り分ける作り（`PersonaRouter.gatewayFor`）。「何も外に出さない Gateway」を 1 つ足せば、多くの道はそのまま通る

Web には通知（Web Push）が無い【事実: `src` に実装が無い】。

### 2.5 モデルの選び方と、エンジンの記録（今）

| 何 | どこ | 中身 |
|---|---|---|
| モデルの一覧 | `src/agent/models.ts` | コードの定数 `MODEL_CHOICES`（`{ key, label, model }` が 3 つ）。`resolveModelKey`（key だけ）・`resolveModelName`（key・表示名・完全な ID）・`modelKeys` |
| 話題のモデル | `sessions.model`（v47） | 完全な ID。NULL は全体の既定。途中で変える道は無い（`docs/plan/models.md` の PR-5 は未実装） |
| 選べる入口 | `src/app/commands/new.ts:196-204`・`src/web/routes/topics.ts:806-810`・`src/app/right-hand.ts:127-130` | `/new` の `model`（一覧の key）・`POST /api/topics` の `model`（一覧の key。知らなければ 400 `invalid_model`）・右腕の `session_open` の `model`（自由な文字列を `resolveModelName` で引く。知らなければ `bad_model`） |
| 選ばなかったとき | `src/app/session-ops.ts:124-131` | 場所の既定（`place_settings`）→ 無ければ NULL。足した人格の話題はモデルを持たない |
| 一覧を返す口 | — | `GET /api/models` は無い（`docs/plan/models.md` の PR-3。画面と一緒に #528 で止めている） |
| General の話題 | `src/app/session-ops.ts:389-392` | プロジェクトのセッションが使える機械では、Web・右腕から場所なしで始めた話題にも General のフォルダが入り、プロジェクトのセッションとして動く。`/new` で `project` を省いた話題は軽いセッション（`src/app/commands/new.ts:205-206`） |
| ターンの runner の選び | `src/app/turn.ts:231` | プロジェクトのセッションなら `projectRunner`、そうでなければ持ち主の人格の runner。エンジンでは分けていない |
| 新しい会話の最初の文 | `src/app/turn.ts:136-139・358` | 共有の記憶の全行（`memoryBlock`）+ seed + 本文。/renew の後・会話の記録が切れた後も同じ |
| 失敗の数え方 | `src/app/turn.ts:322-345` | `result` の届かない失敗が同じ会話の id で 3 回（`RESUME_FAILURE_LIMIT`）続くと、id を消して新しい会話で 1 回やり直す。数えないのは打ち切りと中断だけ。打ち切り・中断で終わっても、途中で受け取った id が在って保存がまだ無ければ残し、seed を消す（`src/app/turn.ts:280-287`） |
| エンジンごとの記録 | `src/store/db.ts`（v18）・`src/store/sdk-sessions.ts:13-31` | `channel_sessions.engine`・`usage_log.engine` の列は在る（既定 `claude`）。**`channel_sessions.engine` は誰も読み書きしていない**（`get`・`set` は `engine` を扱わない）。`personas.md` §3 の「エンジンが違えば捨てて seed から」は実装が無い |
| 会話の対応を読む所 | `src/app/turn.ts:303`・`src/app/session-renew.ts:82`・`src/app/topic-move.ts:272`・`src/app/inbox-rotate.ts:284`／`src/web/routes/topics.ts:345`・`src/web/routes/channels.ts:204`・`src/app/inbox-rotate.ts:251` | 前の 4 つはターンの道（続きの id を取る）。後ろの 3 つは読むだけで、ターンのエンジンを知らない（Web の一覧は、終わっていない話題の全部で読む） |
| 実行時のエンジン | `src/main.ts:372・392`・`src/app/personas.ts:15`・`src/store/usage.ts:34` | codex の人格も含め、全部 `engine: "claude"`。今在る `channel_sessions` の行も `claude`。型は `Engine`（`claude` か `codex`） |
| 使った量の合計 | `src/store/usage.ts:238-300`・`src/app/commands/usage.ts:46-71`・`src/web/routes/usage.ts:74-75` | 合計（`summarize`・`sumOutputTokens`・`listDays`）は人格と時刻だけで絞り、エンジンを見ない。1 ターン 1 行の表示（`npm run usage`。`src/app/usage-report.ts`）にエンジンの欄は無く、モデルの欄だけ |
| 表示名を引く | `src/agent/models.ts` の `labelOf` | `model` の値だけで引く。一覧に無ければ値そのまま。呼ぶ所は `src/app/session-ops.ts:85`・`src/app/right-hand.ts:199`・`src/cc/takeover.ts:100`・`src/app/usage-report.ts:76` |
| 同時のターンの枠 | `src/config.ts:213`・`src/app/queue.ts` | 同時のターンは既定で 2。話題のターンは、そのうち 1 つまで（残りは #inbox などのため） |
| 本文も画像も残らない発言 | `src/app/handler.ts:357-372` | ターンを行わず、理由の文だけ返して履歴に書く |
| /close のまとめ | `src/app/session-ops.ts:604-626`・`src/app/commands/close-text.ts:7-8` | `CLOSE_PROMPT` は `session_report` の道具を呼ぶよう頼む。道具が呼ばれなければ、返事の文を要約にする（`fallbackSummary`）。失敗したら閉じない |
| /renew のまとめ | `src/app/session-renew.ts:90-110・26-27` | 話題のモデルで、同じ会話に `RENEW_PROMPT`（「ツールは使わないでください」と書いて在る）を送る |
| `runner.run` を呼ぶ所 | `src/app/turn.ts:261`・`session-renew.ts:104`・`topic-move.ts:308`・`inbox-rotate.ts:298` ほか | 発言・/close・［続ける］・/renew・場所の付け替え・入口の日替わり |

## 3. 場所の線: Web だけの人格（確定）

オーナーの答え 4 で確定。Discord には何も作らない。この線の人格は Claude で動く（エンジンの線とは独立）。

### 3.1 決め事

- **明示の変数**: `SELF_AGENT_PERSONA_<ID>_SURFACE`。`discord`（既定）か `web`。トークンの書き忘れを「Web だけ」と取り違えないため、トークンが無いだけでは Web だけにしない。`web` でトークンも書いて在れば設定エラー
- **番号**: DB の連番から作る数字 21 桁。先頭の桁は `1` に固定し、後ろは連番を 0 で埋めた 20 桁。Discord の ID（64 ビット。20 桁まで）と重ならない。先頭を 0 にしない理由は、`<#ID>` を読む正規表現が `[1-9]\d*` の形のため。今の `\d{1,25}` の正規表現（Web の道の 15 か所と右腕の `topic_move`）もそのまま通る。チャンネルにもメッセージにも同じ連番を使う
- **ローカルかどうか**: `sessions` と `persona_channels` に列 `place`（`discord` / `local`。既定 `discord`）。番号の形や設定では決めない
- **ローカルの行の `category_id`**: `sessions.category_id` は NOT NULL（`src/store/db.ts:81`）。ローカルの行には決まった文字列 `local` を入れる（Discord の ID にならない値。カテゴリを見る道は `place` で先に分かれる）
- **ローカルの Gateway**: `Gateway` を満たす。`start` は何もしない。`send`・`sendMessage` は番号を振って返す。編集・ピン・リアクション・入力中は何もしない。`messageExists` は true。管理の操作は呼ばれたら投げる
- **サーバー**: ローカルの場所も `guild_id` を持つ。既定の Bot と `/setup` は今まで通り要る。ただし `/setup` は Web だけの人格の入口を Discord に作らず、入口の番号も上書きしない
- **知らせ**: ローカルの話題のターンの終わりは、今の L2 のまとめで右腕（Discord の #inbox）に出る。**履歴の行は今と同じ `終わりました: <#ID>` の形のまま**にし、Discord に投げる文だけ題名で書く（§3.3 の 1）。入口の返事は知らせない
- **止まったとき**: 話題は今と同じく「あなたの番」に数える。入口は数えない（今の入口と同じ。§2.3）。入口で止まった事は、その入口を開けば理由の行で分かる
- **使い方（画面を足さない間）**: 一覧の入口 `#<NAME>` を開いて話す。その入口で頼めば話題を分けられる（`session_open`）

### 3.2 変える所

| 領域 | 今 | 変える事 |
|---|---|---|
| 設定 | トークン必須 | `_SURFACE=web` で Web だけ |
| 起動の配線 | 人格ごとに `DiscordGateway` | Web だけの人格にはローカルの Gateway。`connected` は常に true |
| DB | 鍵は Discord のチャンネル ID | 連番の表と、列 `place`（マイグレーション 1 つ） |
| 話題を作る | 必ず Discord のチャンネル | ローカルなら Discord を呼ばず、番号を振る。`category_id` は `local` |
| 入口 `#<NAME>` | `/setup` が Discord に作る。在るかを Discord に訊き、無ければ作り直して番号を上書きする（`src/app/commands/setup.ts:129・155-164`） | 起動のときに、ローカルの入口を無ければ作る。`/setup` は Web だけの人格を飛ばす |
| 状態 | カテゴリの移動（`src/app/channel-ops.ts`） | ローカルは DB の状態だけ |
| 削除 | Discord のチャンネルを消す | ローカルは DB だけ |
| 再同期 | Discord に無ければ削除済み | ローカルを飛ばす |
| #system の接続の知らせ | Bot ごと（`src/app/persona-status.ts`） | Web だけの人格は出さない |
| `/new` の `persona` の選択肢 | 全人格 | Web だけの人格を外す |
| `/sessions`・`/usage` など | `<#ID>` で並べる | ローカルの話題は題名だけ |
| リマインド | 持ち主の Bot が落ちていれば見送る（`src/app/reminders.ts:610`・`639`） | ローカルの場所でどうなるかを確かめて決める【未確認】 |
| Web API | `POST /api/topics` に人格が無い。既定の Bot が切れていると 503（`src/web/routes/topics.ts:816`）。`link` は全ての話題に Discord の URL（`src/web/routes/channels.ts:105` ほか） | `persona` を受ける。ローカルの話題を作るときは 503 の関所を通さない。ローカルの場所の `link` は `null`。一覧・`/api/channels`・`/api/status` に `surface`。削除の口（§3.3 の 2） |
| 画面 | 人格を選ぶ部品が新しい殻に無い | #528 の向きが決まってから |

### 3.3 Discord に出る物・Discord でしか押せない物

ローカルの Gateway は送信を捨てる。今 Discord にだけ出している物は、ローカルの場所では消えるか、押せなくなる。1 つずつ決める。

| # | 物 | 今 | 決め | 理由 |
|---|---|---|---|---|
| 1 | 統括のまとめ（L2） | 同じ文 `終わりました: <#ID>` を Discord と履歴に（`src/app/lead.ts:183-193`） | 履歴の行は `<#ID>` のまま。Discord に投げる文だけ、ローカルの話題を `「題名」（Web）` と書く。投げてから書く順と、投稿に失敗したら履歴も書かない今の動き（§2.3）は変えない | 履歴の頭の形を変えると、Web の右腕の未読の印と札が壊れる（§2.3）。Discord ではローカルの番号は開けない |
| 2 | 完了した話題の削除の確認 | 完了から N 日で #system に `<#ID>（題名）…削除しますか` とボタン（`src/app/commands/delete.ts:41-58`・scheduler の `promptDeletes`） | ローカルの話題には出さない。代わりに Web API に削除の口を足す（WP6）。画面のボタンは #528 の後 | 答え 4（Discord に何も出さない）。確認が要る元の理由は Discord のカテゴリの枠（チャンネルの数）で、ローカルの話題は枠を使わない。消さなくても困らない |
| 3 | 記憶の変更の知らせ | 履歴に書かず、その場所に `（記憶しました: …）` と［取り消す］を送るだけ（`src/app/commands/memory-undo.ts:23-41`） | ローカルの場所では、同じ文を履歴に notice の行として書く。［取り消す］は付けない（Web の記憶の画面の「忘れる」「戻す」で直す。口は今も在る） | 共有の記憶は全人格に効く。Web だけの人格が変えた事を誰も知らない、を避ける（`personas.md` §3 の守り）。Discord には出さない |
| 4 | `kb_delete` の確認 | その場所に［削除する］［やめる］を送るだけ（`src/app/commands/kb-delete.ts:43`） | ローカルの場所では確認を出せないので、消さずに失敗を返す（確認の投稿に失敗したときと同じ道） | 押せないボタンで待たせない。確認なしで消さない。消すのは Discord の側（右腕）から頼める |
| 5 | モデルが返事に書く `<#ID>` | 既定のシステムプロンプトと `session_open` の説明が「`<#チャンネルID>` を書く」と指示（`src/agent/system-prompt.ts:29・40`・`src/agent/tools.ts:956`） | 返事は `<#ID>` のまま（指示の文を変えない）。Web の側で、どの会話でも `<#ID>` を題名と［開く］に替える | 指示の文を変えると全セッションのキャッシュが外れる。アプリが返事を書き換えると履歴が食い違う |
| 6 | そのほかのボタン付きの送信 | — | WP4 で、ローカルの Gateway に来た送信のうち履歴に行が無い物をテストで洗い出し、1 つずつ「履歴に書く・出さない・失敗を返す」を決めて固定する | 見落としを機械で拾う |

5 の「どの会話でも替える」は、今の殻の 1 か所（右腕の会話だけ、の条件を外す）で足りる見込み【推測】。新しい部品も画面も足さないが、今の画面に手を入れる段なので、#528 の止める段として WP7 と一緒に止める（その間、Web だけの人格の入口では `<#番号>` がそのまま見える）。

### 3.4 危ない所（重い順）

1. **再同期が消す**（`src/app/scheduler.ts:229-248`）。飛ばす処理は、ローカルの行を作れるようになる PR より前に main に入れる
2. **戻せなくなる点**。WP1 は v49 で起動した時点から戻せない（`src/store/db.ts` の `migrate` は、コードより新しい版の DB を開かずに投げる）。再起動の後は戻さない。戻すなら、起動のときに取った移行の前の控え（`.bak`）から戻すか、v49 の移行を残してほかを戻す（ローカルの行ができた後に飛ばす処理だけを戻すと、1 と同じ事が起きる）。門を開けた後に戻して良いのは門を開けた PR（WP5）だけ
3. **設定から人格を外したとき**。`PersonaRouter.ownerOf` は、設定に無い人格の場所を既定の人格の物として扱う（`src/app/personas.ts:65-68`）。だからローカルかどうかは DB の列で決める
4. **管理の操作にローカルの番号が渡る**。呼ぶ所は `channel-ops.ts`・`categories.ts`・`topic-move.ts`・`commands/delete.ts`・`session-ops.ts`・`reminders.ts`・`commands/setup.ts`・`main.ts`
5. **Discord にだけ出て、履歴に無い文**（§3.3）
6. **`<#ID>` の文**。まとめ・`session_open` の返事・入口の引き継ぎの要約（`src/app/inbox-rotate.ts`）。どれも `<#ID>` のまま持ち、見せる側で替える（§3.3 の 1・5）

### 3.5 プロンプトキャッシュ

外れない。既定の人格のシステムプロンプトもツールの定義も変えない（§3.3 の 5 も、指示の文を変えない形にした）。

### 3.6 採らなかった案

| 案 | 中身 | 採らない理由 |
|---|---|---|
| 既定の Bot が代わりに持つ | トークンの無い人格も Discord にチャンネルを作り、既定の Bot が喋る | オーナーの答え 4。右腕の Bot が別の人格として喋る事になる |
| 人格ごとに選べる | 上と Web だけの両方を作る | 今は要らない |
| まとめの履歴の行も題名で書く | `終わりました: 「題名」` | Web の右腕の未読の印と札が壊れる（PR #531 のレビュー） |
| 削除の確認を題名で #system に出す | ボタンは Discord で押す | 答え 4 に反する。枠を使わないので急がない |

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
| stream-json | 1 行 1 イベント。`init`（`conversation_id`、`init.cwd`（絶対パス）・`init.tools`・`init.permission_mode`、設定したときだけ `model`・`agent`）／`step_update`（`step_index`・`state` = `ACTIVE`/`DONE`・`step_type` = `user_input`/`agent_response`/`tool`/`checkpoint`、在れば `tool_name`・`text_delta`・`usage`・`tool_info`）／`result`（`conversation_id`・`status`・`response`・`duration_seconds`・`num_turns`・`usage`） | 事実 |
| `init.permission_mode` | `toolPermission` の値（既定は `request-review`）。エージェントのモード（下）ではない | 事実 |
| 使った量 | `usage` は `input_tokens`・`output_tokens`・`thinking_tokens`・`cache_read_tokens`・`total_tokens` | 事実 |
| 終わりの状態 | `SUCCESS`・`ERROR`・`CANCELED`・`INTERRUPTED`・`INVALID`・`WAITING`・`RUNNING` | 事実 |
| 続き | ヘッドレスは既定では前を覚えない。`--conversation <id>`（id は前の出力の `conversation_id`）か `--continue`（その作業フォルダの最後の会話）。どちらも新しいプロセス。会話の一覧は作業フォルダごと | 事実 |
| 別のフォルダから id で続けられるか・知らない id のときの出方 | 記述が無い | 未確認 |
| 1 プロセスで複数ターン | `--input-format stream-json`（`--output-format stream-json` が要る。`-p` は付けない）。入力は `{"event":"user","message":{"content":"…"}}`。中身はテキストだけ。ターンごとに `result`。stdin を閉じると今のターンの後に exit 0 | 事実 |
| スラッシュコマンド | ヘッドレスでも `/` で始まる本文はコマンドや skill として走る。`--disable-slash-commands`（設定は `disableSlashCommands`）で、打った通りに送る | 事実 |
| 止め方 | `SIGINT` で `INTERRUPTED`。`--print-timeout`（既定は無制限）。`SIGTERM` の記述は無い | 事実／未確認 |
| exit code | 0 = 成功（許可をやんわり拒否した回も 0）／1 = 失敗・壊れた入力／2 = CLI が自分で答えるスラッシュコマンドなど | 事実 |
| 許可 | ヘッドレスに対話の確認は無い。得られない許可は「やんわり拒否」: 続行して exit 0、stderr に道具の名前と許し方の知らせ | 事実 |
| エージェントのモード | `--mode` の値は `accept-edits`・`auto`・`plan` の 3 つだけ。**`default` という値は無い**。default モードは設定の `"agentMode": ""` で指定する。v1.5.7 から、`agentMode` が無ければ `agy -p` は `auto` が使える所では `auto`、使えない所では default で動く。`auto` は端末の sandbox が要り、使えなければ default になる。`plan` は本文の頭に `/plan` を足す | 事実（§4.3 の 1） |
| 許可の決まり | `~/.gemini/antigravity-cli/settings.json` の `permissions.allow`・`ask`・`deny`（文字列の配列）。形は `action(target)`。**CLI の action は `read_file`・`write_file`・`read_url`・`execute_url`・`command`・`unsandboxed`・`mcp` の 7 つ**（`download_url` は Antigravity のアプリの側だけ）。強さは Deny > Ask > Allow。**deny はどのモードでも効く**。`*` はその action の全部に当たる（`read_file(*)` は機械の全ファイル）。read の deny は write の deny も含む | 事実（§4.3 の 3） |
| 知らない action の決まりを書いたとき | 記述が無い | 未確認 |
| 既定の許可 | 作業フォルダの中の読み書きは確認なしで通る。**作業フォルダの外のファイルは確認が要る**（ヘッドレスではやんわり拒否）。`read_url`・`execute_url`（ブラウザを開く下請け。`read_url` の許しでは通らない）・`mcp`・`auto` の外のコマンドも確認が要る。`allowNonWorkspaceAccess`（フォルダの外の読み書きを許す）の既定は `false` | 事実（§4.3 の 4） |
| `toolPermission` | `request-review`（既定。書き込み・コマンド・Web・MCP の前に確認。allow の決まりが当たれば通る）／`strict`（**ファイルの読みを含む全ての道具の前に確認。allow の決まりが当たっていても確認**。`auto` より強い）／`proceed-in-sandbox`（sandbox の中のコマンドを確認なしで）／`always-proceed`（コマンド・Web・MCP を確認なしで。`--dangerously-skip-permissions` と同じ向き） | 事実（§4.3 の 2） |
| 検索の道具の名前と、その許可 | 記述が無い | 未確認 |
| 決まりの置き場の種類 | `/permissions` の画面に Project（開いているプロジェクトだけ）・Shared（Antigravity の製品で共有）・Global（`settings.json`）の 3 つ。CLI は 3 つを合わせて使う。Project の決まりがどのファイルに入るか・ヘッドレスで効くかは書いていない | 事実／未確認 |
| 設定のファイルの癖 | 既定と同じ値のキーは保存しない。起動のたびに書き直し、既定の値のキーを消す。知らないキーは残す。型や値がおかしい・JSON でないと「Settings Error」の画面を開く（ヘッドレスでの出方は書いていない）。`trustedWorkspaces`（訊かれて信頼したフォルダ）のキーが在る | 事実／未確認 |
| 話題に渡す文 | 作業フォルダの `AGENTS.md`・`GEMINI.md` は常に効く規則（毎ターン、システムプロンプトに入る）。全体の物は `~/.gemini/AGENTS.md` など。1 ファイル 24,000 バイトまで。ヘッドレスで読むかの記述は無い | 事実／未確認 |
| 自前の agent | `.agents/agents/<name>.md`（frontmatter に `name`・`description`・`tools`（許す道具の一覧）・`mainAgent`・`model` など。本文がシステムプロンプト）。`--agent <name>` のフラグと `agy agents` の一覧が在る。ヘッドレスで自前の agent を選べるかは書いていない | 事実／未確認 |
| モデルの選び方 | `--model <slug>`。`agy models` が、そのアカウントで使える slug を `slug  表示名` の行で全部出す（例: `gemini-4-neon-high  Gemini 4 Neon (High)`）。考える深さは slug に入っている（`-low`・`-medium`・`-high`・`-xhigh`）。知らない slug は exit 1・`status: ERROR` で、誤りの文に `invalid model selection` と使える slug の一覧 | 事実 |
| 使えるモデル | プランで違う（重い組は有料の Pro・Ultra、軽い組は全プラン）。一部のモデルは 2026-11-30 に外れると書いて在る。新しい会話の既定は、含まれるプランでは Gemini 4 Neon | 事実 |
| sandbox | `--sandbox`。Linux は kernel の名前空間。特権なしの user namespace を塞ぐホストでは使えず、そのとき `--sandbox` は何もしない | 事実 |
| サインイン | 保存済みが無ければブラウザを開く。SSH では URL を出すので、別の機械で開いてコードを端末に貼る。ヘッドレスは保存済みの資格情報を使い、無ければ `authentication required` の誤りで終わる（固まらない） | 事実 |
| 資格情報の置き場 | OS の鍵束（Linux は Secret Service / D-Bus、macOS は Keychain）。鍵束が閉じている・無いと、固まる・D-Bus の警告・`failed to retrieve token: secret keyring is locked`。公式の直し方は「D-Bus のセッションと鍵束のデーモンを動かす（例: `export $(dbus-launch)`）」。鍵束が無いときのファイルへの退避は書いていない | 事実／未確認 |
| 枠 | Pro・Ultra は 5 時間ごとに戻り、週の上限が在る。同じ組のモデルは上限を分け合う。`/usage` で残りを見る（スラッシュコマンドは `agy -p` で別に呼べと書いて在る） | 事実 |
| 枠が尽きたときに何が返るか | 記述が無い | 未確認 |
| AI クレジット | `settings.json` の `useG1Credits`。true で、枠が尽きた後に買ったクレジットを使う。**既定は `false`** | 事実（§4.3 の 4） |
| 自動の更新 | 裏で自分を更新する。`AGY_CLI_DISABLE_AUTO_UPDATE=true` で止まる | 事実 |
| 状態の置き場 | 設定は `~/.gemini/antigravity-cli/`。作業フォルダごとの最後の会話は `…/cache/last_conversations.json`。会話の本体の置き場は書いていない | 事実／未確認 |

### 4.3 公式の原文で確かめ直した 4 つ（PR #531 のレビュー）

レビューは公式のページを要約で読んでいたので、4 つとも原文（各ページの markdown 版）を開き直した。**4 つともレビューが正しく、前の版が誤っていた。**

| # | 指された事 | 原文で確かめた結果 | この文書でどう直したか |
|---|---|---|---|
| 1 | `--mode default` は無い値 | 正しい。reference と modes のページで、`--mode` の値は `accept-edits`・`auto`・`plan` だけ。default は `"agentMode": ""` | `--mode` は付けない。`"agentMode": ""` を設定に足す（§5.6・§6）。`--mode default` が通るかは AG0 で 1 回だけ見る（§7 の 7） |
| 2 | `strict` の説明が逆 | CLI については正しい。reference と settings のページは「ファイルの読みを含む全ての道具の前に確認。allow が当たっていても確認」。ただし agent-settings のページの CLI の節には「読み以外の全ての道具の前に確認」と在り、**公式のページどうしで食い違っている**（前の版はこちらを写した）。allow が効かない点はどちらでも変わらない | `strict` を使わない。`request-review` のまま deny で止める（§5.6 に比べた表） |
| 3 | `download_url` は CLI に無い | 正しい。CLI の action は 7 つで、`download_url` はアプリの側の表にだけ在る | 一覧と守りから外した。知らない action を書いたときの動きは【未確認】のまま |
| 4 | 公式に在るのに【未確認】にしていた物 | 正しい。`useG1Credits` の既定は `false`。作業フォルダの外のファイルは既定で確認が要る（`allowNonWorkspaceAccess` の既定は `false`） | 「文書の通りなら拒否。効き方は AG0」に上げた（§5.6） |

### 4.4 この機械の今（読むだけで確かめた）

- `agy` は入っていない。`~/.gemini` も無い
- x86_64・glibc 2.39
- 鍵束が無い（gnome-keyring は入っていない。ユーザーの D-Bus に Secret Service が居ない）。ユーザーの D-Bus 自体は在る
- 特権なしの user namespace は AppArmor で絞られている（Ubuntu 24.04 の既定）。`agy` の sandbox は使えず、`auto` モードも使えない見込み【推測】。`/usr/bin/bwrap` は在る（`shell.md` の段で入れた物）

## 5. エンジンの線: 話題ごとのエンジン

### 5.1 形と、#114 との折り合い

- **エンジンは話題が持つ**。話題を始めるときに、モデルの一覧から Antigravity 経由のモデルを選ぶと、その話題だけ `agy` で動く。途中で変えない（モデルと同じ決まり）
- 持ち主は既定の人格のまま。新しい人格・Bot・入口は増えない。話題は今の話題と同じ場所にできる（Discord の `/new` なら Discord のチャンネル、返事は既定の Bot が書く）
- **#114（`docs/plan/personas.md`）の「人格ごとにエンジンを固定」はそのまま残す**（codex の節 §5 は直さない）。この文書は 2 つ目の軸を足すだけ: ターンのエンジンは「話題が持っていればそれ、無ければ持ち主の人格のエンジン」。ここで言う人格のエンジンは**実行時のエンジン**（今は codex の人格も含めて全部 `claude`。§2.5）で、設定に書いた値（`codex`）ではない。足した人格の話題はモデルを選べない（今も）ので、2 つの軸がぶつかる話題は無い
- `ENGINES`（人格の設定に書ける値）は増やさない。前の版の `_ENGINE=antigravity`・人格ごとの作業フォルダ・人格の文の `AGENTS.md` は無くす
- **型の置き場**: `antigravity` を含む型（`TurnEngine` = `Engine` に `antigravity` を足した物）を `src/agent/models.ts` に置く。一覧の行の `engine`・ターンのエンジンを返す関数・`channel_sessions` と `usage_log` に書く値がこの型。`Engine`（人格の設定に書ける値。`src/config.ts`）と `TurnPersona.engine` は変えない
- 最初の範囲（答え 3・6・7）: 調べ物と相談だけ。self-agent の道具（記憶・タスク・リマインド・話題を分ける）・プロジェクトの操作・共有の記憶は無い

### 5.2 モデルの一覧

Antigravity の slug は、プランで使える物が違い、Google の都合で入れ替わる（§4.2）。持ち方を 3 つ比べた。

| 案 | 中身 | メリット | デメリット | 実装 | 運用 | |
|---|---|---|---|---|---|---|
| A. env で並べる | `SELF_AGENT_ANTIGRAVITY_MODELS` に slug をカンマ区切りで。Claude の一覧（コードの定数）に起動のときに足す | オーナーのプランに合う物だけ並ぶ。入れ替わりにコードを直さず追える。変数が空なら何も増えない（= 門） | Claude の一覧（定数）と持ち方が 2 つになる。表示名は slug のまま | 小 | 入れ替わったら env を直して再起動 | ◎ |
| B. コードの定数 | `docs/plan/models.md` §2 と同じ | 持ち方が 1 つ | プランに無い slug が並ぶ。外れるたびに PR。配った先の人のプランにも合わない | 小 | 入れ替わりのたびに PR と再起動 | △ |
| C. 起動のたびに `agy models` を読む | 一覧を `agy` に訊く | 手で直さない。表示名も取れる | 起動が `agy` とサインインに依る。10 個を超える slug が全部並ぶ。Discord の選択肢（25 個まで）に収まらない | 中 | 無 | ✗ |

**推し: A。** 決め事:

- `SELF_AGENT_ANTIGRAVITY_MODELS`: slug をカンマ区切りで 8 個まで。形は `[a-z0-9][a-z0-9.-]{0,63}`。形に合わない・重なる・9 個以上は、変数名を出して exit 1（書き間違いは今も exit 1）。**未設定・空なら、一覧にも入口にも何も増えない**
- 一覧の 1 行の型に `engine` を足す: `{ key, label, model, engine }`。Claude の 3 つは `engine: "claude"`。Antigravity の行は `key: "agy:<slug>"`・`label: "<slug>（Antigravity）"`・`model: "<slug>"`・`engine: "antigravity"`
- key に `agy:` を付ける理由: Antigravity には Claude のモデルも在り、slug が Claude の ID や key と紛れるのを避ける
- 引く関数を 2 つに分ける: 一覧の key で引く物（`/new`・Web。全部の行）と、名前で引く物（右腕の `session_open`。**Claude の行だけ**）。`bad_model` で返す key の一覧も Claude の行だけ
- 表示名を引く関数（`labelOf`・`modelLine`）は、エンジンも受け取る。エンジンが `antigravity` なら、一覧に無い slug でも `<slug>（Antigravity）` と出す（変数から slug を外した後も、話題の最初の行と使った量の行で見分けが付く）
- 段: 変数を読むのは AG5（runner の配線・`/api/status`）。入口が Antigravity の行を見るのは AG7 から。その間は、変数を入れても Antigravity の話題は出来ない（key で引く関数は、AG7 まで Claude の行だけを返す）
- slug が今の `agy` で使えるかは、起動では確かめない（`agy` を起こさない）。使えない slug はターンで分かる（§5.9 の「モデルが使えない」）
- 考える深さは slug に入っているので、`--effort` は付けない

### 5.3 どこで選べるか

| 入口 | 選べるか | 形 |
|---|---|---|
| Discord の `/new` の `model` | 選べる | 選択肢に Claude の 3 つと並ぶ。`project` と一緒なら本人にだけ断る（`persona` と一緒は今も断っている） |
| Web の `POST /api/topics` の `model` | 選べる（API まで） | 一覧の key。場所が General 以外なら 400 `model_place`。`agy` の実行ファイルが見つからなければ 503 `engine_unavailable`。できた話題の返事に `engine` を足す |
| Web の `GET /api/models` | 作る（サーバーの口だけ） | `docs/plan/models.md` の PR-3 のうち口の分。1 行は `{ key, label, engine }` |
| Web の画面（始める板の一覧・見出しの表示） | **止める**（#528） | `docs/plan/web-ui-rebuild.md` §8 |
| 右腕の `session_open` の `model` | 選べない | 名前で引く関数が Claude の行だけを見るので、今の `bad_model` が返る。引数の説明の文は変えない（答え 5・#451 の決まり） |
| 場所の既定（`place_settings`） | 置けない | 置けると、右腕・GitHub の［対応］・取り込みで始めた話題が `agy` で動いてしまう（答え 5）。既定を書く口（PR-4。未実装）を作るときに断る。読む側も、Antigravity の行に当たる既定は無い物として扱う |
| GitHub の［対応］・取り込み・古い殻の `POST /api/sessions` | 選べない | 場所の既定に従う入口なので、Claude のまま |
| #inbox・#tasks・足した人格の入口と話題 | 対象外 | Claude のまま |
| 途中でモデルを変える（`/renew model:`。未実装） | エンジンをまたぐ変更は断る | 作るときの決め事 |

- **`/new` からも選べるようにする理由**: Web の画面は #528 で止まっていて、`/new` が無いとオーナーが使える入口が無い。`/new` の選択肢は Discord のコマンドの定義で、モデルに渡すツールの定義ではないので、キャッシュは外れない
- **場所**: 選べるのは、場所の無い話題（軽いモード）だけ。Antigravity の話題には General のフォルダも入れない（プロジェクトのセッションが使える機械でも。§2.5）。場所の付け替え（Web・右腕の `topic_move`）は断る（理由の文を 1 つ足す:「Antigravity の話題は場所を変えられません」）
- 右腕が後から話題に指示を送る道（`docs/plan/lead.md` の L4。未実装）を作るときは、Antigravity の話題を断る（答え 5）

### 5.4 保存（DB）

マイグレーションは 1 つ（次の番号）。

| 何 | 中身 |
|---|---|
| `sessions.engine`（新しい列） | `TEXT`。NULL = 持ち主の人格の実行時のエンジンに従う（今は全部 `claude`。§5.1。今在る行は全部 NULL）。Antigravity の話題は `antigravity` |
| `sessions.model` | 今と同じ列に slug を入れる（`agy:` は付けない。`agy --model` にそのまま渡す値） |
| `channel_sessions.engine`（v18 から在る。今は誰も読み書きしない） | store が読み書きする。**今の `get` は変えない（副作用なし）**。Web の一覧・チャンネルの読み取り・日替わりの下見からも呼ばれ、そこにはターンのエンジンが無いため（§2.5）。別に「エンジンを渡して読む」関数を足し、保存した行のエンジンが渡した値と食い違えば、その行を消して「会話なし」を返す（seed から始まる）。**使うのはターンの道の 4 か所だけ**（発言 `src/app/turn.ts:303`・/renew `src/app/session-renew.ts:82`・場所の付け替え `src/app/topic-move.ts:272`・入口の日替わり `src/app/inbox-rotate.ts:284`）。`set` はエンジンを受け取って書く（省けば `claude`）。比べるのは実行時のエンジンなので、codex の人格の今在る行（`claude`）は消えない。`personas.md` §3 の決まりの実装 |
| `channel_sessions.session_id` | Antigravity の話題では `agy` の `conversation_id` |
| `usage_log.engine`・`usage_log.model` | `antigravity`・slug。Claude の合計からは外す（下） |

エンジンを列で持つ理由: 一覧（env）から slug を外した後も、その話題が Antigravity の物だと分かる必要が在る。モデルの文字列から見分けると、外した途端に Claude に知らないモデル名を渡してしまう。

**使った量の合計**: Antigravity のターンは、Claude の合計（Discord の `/usage`・Web の使用量の合計と日ごとの表）に足さない。トークンの数え方が違い、枠も別なので足せない。合計の 3 つの関数（`summarize`・`sumOutputTokens`・`listDays`）が、`engine` が `antigravity` の行を除く。Antigravity の分は、最初は合計としては出さず、1 ターン 1 行の表示（`npm run usage`）で見えるだけにする。今の行にエンジンの欄は無いので、欄は足さず、モデルの欄に `<slug>（Antigravity）` と出して見分ける（揃える幅は変えない。その行だけ右の欄がずれる）。そのために、行を読む所（`listRecent`）が `engine` も返す（Web の使用量の `rows` にも同じ項目が乗る。画面の字は変えない）。Antigravity の合計を別に出す表示は後の段（画面は #528）。

### 5.5 `agy` の起こし方

- **1 ターン = 1 プロセス**。常駐させない。続きは `--conversation <id>`
- **本文は stdin で渡す**のを第一候補にする: `--input-format stream-json --output-format stream-json` で 1 行書いて stdin を閉じる。理由は、引数に載せると長い本文で上限に当たり、プロセスの一覧にも本文が出るため。`--conversation` と組めるかは【未確認】。組めなければ `-p` に本文を載せ、長さの上限を自前で持つ
- **固定で付ける物**: `--output-format stream-json`・`--model <slug>`・`--disable-slash-commands`（本文が `/` で始まっても `agy` のコマンドにしない）
- **決して付けない物**: `--continue`（`-c`）・`--mode`（どの値も）・`--dangerously-skip-permissions`・`--remote-control`・`--remote-agent`・`--add-dir`（テストで引数を固定する）
- **子の env は許可の方式**: `PATH`・`HOME`・`LANG`・`XDG_RUNTIME_DIR`・`DBUS_SESSION_BUS_ADDRESS`・`AGY_CLI_DISABLE_AUTO_UPDATE=true` だけ。Discord のトークン・`CLAUDE_CODE_OAUTH_TOKEN` は渡さない（`personas.md` §5.3・§5.4 の codex と同じ考え）
- **同時に動かすのは全体で 1 つ。runner の中で直列にする**（`runner.run` は発言・/close・［続ける］・/renew など何か所からも呼ばれるので、呼ぶ側の印では漏れる）。並んで待つ間は打ち切りの時計を進めない。待つ間に中断されたら列から抜けて `aborted`。この列に並ぶのは Antigravity のターンだけ。ただし Antigravity の話題のターンも、今のキューの同時のターンの枠（既定で 2。話題のターンはそのうち 1 つまで。§2.5）を取り、runner の中で待つ間も枠を持ったままになる。既定の設定では、Antigravity の話題のターンが動いている間、ほかの話題のターンは Claude の物も待つ（今の話題どうしと同じ）。#inbox などの枠は残る
- **打ち切り**: ターン全体は今の話題と同じ時間。加えて、**最初のイベント（`init`）が 30 秒で来なければ止める**（鍵束で固まると、全体の打ち切りまで 1 つしか無い枠を塞ぐため。30 秒は仮の値で、AG0 の実測で決め直す）
- **中断**: `signal` が abort されたら `SIGINT`。決めた時間で終わらなければ `SIGKILL`。結果は `aborted`
- **`agy` の場所**: `SELF_AGENT_AGY_PATH`（在れば）→ PATH → `~/.local/bin/agy`。毎ターン探す（後から入れても再起動が要らない）

作業フォルダの持ち方は 3 つ比べた。

| 案 | 中身 | メリット | デメリット | 実装 | 運用 | |
|---|---|---|---|---|---|---|
| A. 話題ごと | `<SELF_AGENT_DATA_DIR>/antigravity/<話題の番号>/` | 話題どうしが混ざらない（`agy` の会話の一覧は作業フォルダごと）。万一書かれても、ほかの話題に見えない。話題を消すときにフォルダごと消せる | 新しいフォルダのたびに「信頼するか」を訊かれるなら使えない【未確認】 | 小 | 無 | ◎ |
| B. 全体で 1 つ | `<SELF_AGENT_DATA_DIR>/antigravity/work/` | 信頼の確認が 1 回で済む | 全部の話題の会話が 1 つの一覧に並ぶ。`--conversation` を付け忘れると別の話題を継ぐ | 小 | 無 | ○ |
| C. 人格ごと（前の版） | — | — | 人格を立てないので、意味が無くなった | — | — | ✗ |

**推し: A。** AG0 で、新しいフォルダのたびにヘッドレスが信頼の確認で止まると分かったら B にする（そのときも `--continue` は付けず、必ず `--conversation <id>`）。フォルダの中には、渡す文のファイル（§5.7）のほかは何も置かない。log にフォルダのパスを出さない。

### 5.6 調べ物だけに絞る（答え 3）

読んだ Web のページに悪い指示が混ざっていても、この機械の物を読ませない・書かせない・コマンドを打たせない。`agy` は self-agent と同じ OS のユーザーで動くので、ここがこの線でいちばん危ない。

`toolPermission` をどちらにするかを比べた（レビューの 2）。

| 案 | 調べ物（URL を読む） | 読み・書き・コマンドを止める | 設定の量 | |
|---|---|---|---|---|
| A. `request-review`（既定のまま）+ deny + `allow read_url(*)` | ◎ allow が効く | ○ deny で止める（deny はどのモードでも効く） | △ 決まりが 6 行 | ◎ |
| B. `strict` | ✗ allow が在っても確認 → ヘッドレスでは拒否。URL も読めない | ◎ 全部が確認 → 拒否 | ◎ 1 行 | △ |

**推し: A。** B は会話しか出来なくなり、答え 3 の「調べ物」が満たせない。

重ねる守り:

| # | 守り | 誰が | 印 |
|---|---|---|---|
| 1 | 話題ごとの空の作業フォルダで動かす | self-agent | 事実（形として） |
| 2 | `permissions.deny` に `read_file(*)`・`write_file(*)`・`command(*)`・`mcp(*)`・`execute_url(*)`・`unsandboxed(*)` | オーナーの手（7 が毎ターン確かめる） | 事実（文書: deny はどのモードでも効く）。効き方は AG0。`unsandboxed` の意味は未確認 |
| 3 | `permissions.allow` に `read_url(*)` | オーナーの手 | 事実（文書）。検索の道具が別の名前なら AG0 で足す |
| 4 | `toolPermission` は `request-review`（既定）か `strict`。`always-proceed`・`proceed-in-sandbox` なら使えない | 7 が確かめる | 事実 |
| 5 | `"agentMode": ""`（default モード）。`--mode` は付けない | オーナーの手 | 事実（値）。起動のたびの書き直しでこのキーが消えるかは AG0 |
| 6 | `allowNonWorkspaceAccess` と `useG1Credits` が true でない（既定は両方 `false`） | 7 が確かめる | 事実 |
| 7 | **self-agent が、毎ターンの前に `~/.gemini/antigravity-cli/settings.json` を読むだけ読み**、2・4・6 を満たさない・5 が空でない値・ファイルが無い／読めない／JSON でない、のどれかなら、`agy` を起こさずに「使えない（設定が足りません）」と返す | self-agent | 設計 |
| 8 | 危ないフラグを決して付けない（§5.5） | self-agent | 設計 |
| 9 | 自前の agent の `tools` で、道具を検索と URL の読み取りだけにする | AG0 で使えると分かれば | 未確認 |

- 2 の `read_file(*)` は、作業フォルダの中も外も読ませない（read の deny は write の deny も含む）。文書の通りなら、決まりが無くても作業フォルダの外は確認が要り、ヘッドレスでは拒まれる。deny はその上に重ねる物
- 2 の `unsandboxed(*)` は、公式の action の一覧に在るが、意味を説明した文を読めていない【未確認】。名前からは「sandbox の外でコマンドを打つ許し」と読めるので、deny に入れておく【推測】。AG0 の 8 で、意味と、deny に書いて `agy` が困らないかを見る。困るなら外す（`command(*)` の deny は残る）
- 5 について: `agentMode` のキーが無いと、ヘッドレスは `auto` が使える所では `auto` で動く。`auto` でも deny は効くので、7 は「キーが無い」を通す（書き直しで消える見込みが在るため）。`auto`・`accept-edits`・`plan` がはっきり書いて在るときだけ止める
- 7 が見られるのは Global の決まりだけ。Project・Shared の置き場に allow が足されていても見えない（deny の方が強いので、2 が在る限り通らない）

**門を開ける条件（設計の側の決め事。答え 3 の「触らせない」から出る）**: AG0 で「作業フォルダの外の読み・書き込み・コマンド」の 3 つがどれも拒まれ、URL の読み取りは通ると確かめるまで、門（AG7）を開けない。設定だけで拒めないと分かったら、OS の側で囲う段（AGX。今の `/usr/bin/bwrap` と AppArmor の profile を使い、作業フォルダと `agy` の置き場だけを見せる）を AG7 の前に入れる。

2〜6 は `~/.gemini/antigravity-cli/settings.json`（オーナーの家の下。**self-agent は書かない。読むだけ**）に入る。足す中身は `npm run agy-setup -- --print` が標準出力に出す（`cc-setup`・`unify-setup` と同じ形）。出す中身:

```json
{
  "agentMode": "",
  "permissions": {
    "allow": ["read_url(*)"],
    "deny": ["read_file(*)", "write_file(*)", "command(*)", "mcp(*)", "execute_url(*)", "unsandboxed(*)"]
  }
}
```

この設定は、同じ機械でオーナーが端末から `agy` を使うときにも掛かる。`read_file(*)` の deny が入るので、その `agy` ではコードを読む事も出来なくなる（§9 の 1）。

後から広げるとき（プロジェクトを触らせる）は、作業フォルダと決まりを話題ごとに変える段を足す。今の形はそれを塞がない。

### 5.7 話題に渡す文・記憶・seed

- **渡す文**: このエンジン用の短い静的な文を 1 つ（コードの定数）。軽いモードの `SYSTEM_PROMPT` は道具の説明を含むので渡さない。中身は「オーナーの調べ物と相談の相手をする・日本語で答える・電話で読むので表と見出しを使わない・出典の URL を添える・この機械のファイルやコマンドには触らない（触れない）・覚えておく道具やタスクの道具は無いので、頼まれたら出来ないと言う」。日時や ID は入れない
- **渡し方**: 第一候補は、作業フォルダの `AGENTS.md`（毎ターンの前に同じ中身で書く）。AG0 で `--agent` と `tools` が使えると分かれば、`.agents/agents/` の自前の agent に替える。どちらもヘッドレスで効かなければ、新しい会話の最初の本文の頭に付ける。どれにするかは AG0 の後に設計が決める
- **共有の記憶は渡さない**（答え 7）。今は新しい会話の最初の文に記憶の全行が付く（§2.5）。最初の文を組む所を 1 つの関数にまとめ、ターンのエンジンを引数に取る。Antigravity のときは記憶のブロックを付けない。**後から渡すように変えるときは、その関数と切り替え 1 つ**（後の段 AG9）
- **seed は渡す**。Antigravity の話題に届く seed は、その話題自身の要約（/renew の要約・/close の要約）と題名だけ（会話の記録が切れたときの再開もこの 2 つ）。右腕が付ける引き継ぎの文・GitHub の通知・取り込みの種は、Claude の話題にしか行かない（§5.3）。**seed と本文は Google に出る**（元の会話が既に Google に在る物）
- **本文の頭の日時の行**は今と同じ（`[日時 #話題の名前]`）
- **始めたときの案内**: 話題の最初の案内の行に、モデルの行と並べて「この話題は Antigravity（Google）で動きます。記憶・タスク・リマインドとプロジェクトの操作は使えません」を出す（静的な文）

### 5.8 Claude 前提の機能を、この話題でどうするか

まとめのターン（/close・/renew）をどちらで回すかを比べた。

| 案 | 中身 | メリット | デメリット | 実装 | 運用 | |
|---|---|---|---|---|---|---|
| A. `agy` で回す | 同じ会話の続きに、要約を頼む | 会話を持っているのは `agy` だけ。Claude の枠を使わない。Claude のターンに付く記憶と混ざらない | Google の枠を 1 ターン使う。枠切れのときは /close・/renew が止まる | 小（runner の選びを通るだけ + /close の文 1 つ） | 無 | ◎ |
| B. Claude で回す | 履歴の表から会話を組み立てて Claude に渡す | `session_report` でタスクも拾える | 新しい道（履歴 → 本文）が要る。長い会話を丸ごと Claude に流す。Claude の枠 | 中 | Claude の枠 | △ |
| C. モデルを使わない | 題名と最後の返事の頭を要約にする | 枠 0 | 要約にならない。/renew の続きに使えない | 小 | 無 | ✗ |

**推し: A。** 今の決まり（まとめのターンも話題のモデルで回す。`src/app/session-renew.ts:89`）とも同じ向き。

| 機能 | 扱い | 根拠 |
|---|---|---|
| 話題での会話・［続ける］・［中断］ | できる | |
| self-agent の道具（記憶・タスク・リマインド・ナレッジ・`project_open` など） | 無い（答え 6）。頼まれたら「この話題では出来ない」と言うよう、渡す文に書く | |
| /close | できる。**専用の静的な文**（要約だけを頼み、`session_report` に触れない）を `agy` で回す。返事の文が要約になる（今の「道具が呼ばれなかったとき」の道。§2.5）。タスクの登録の確認は出ない | 事実（今の道）／AG5 のテスト |
| /renew | できる。今の `RENEW_PROMPT` をそのまま `agy` で回す | 推測（AG5 のテスト） |
| まとめのターンが失敗したとき | 今と同じ（/close は閉じない。/renew は新しくしない） | 事実 |
| 統括のまとめ（L2） | 今のまま出る（アプリが作る文。話題のターンなので対象） | 事実 |
| 止まった話題を「あなたの番」に数える | 今のまま数える（話題なので。入口は数えないが、Antigravity は入口では動かない） | 事実（§2.3）／AG5 のテスト |
| 場所を変える・プロジェクト | できない（§5.3） | |
| 画像・添付 | できない。入力はテキストだけ【事実】。「この話題は画像を読めません」と添えて、文だけでターンにする。本文が空で画像だけの発言は、断りの文だけを返してターンを行わない（今の「本文も画像も残らない発言」と同じ扱い。§2.5） | |
| オーナーが貼った URL だけ読む決まり | 掛けられない。`agy` の側の `read_url` の決まりで動く | |
| 許可を訊く（プロジェクトのセッションの物） | 無い。やんわり拒否 | |
| 会話の要約（compaction）の印 | 無い。長くなって失敗したら /renew を案内する | 未確認（自動で縮めるか） |
| 手順の上限（maxTurns） | 無い。時間の打ち切りだけ | |
| 予約した依頼（リマインドがターンを起こす） | 起きない（置く道具が無い） | 推測 |
| 取り込み・GitHub の［対応］ | 対象外（Claude の話題の物） | |
| 利用枠の自動のやり直し・［もう一度送る］（#483） | しない（§5.9）。Claude の側もまだ main に無い【事実: `src` に実装が無い】 | |

できない物は、黙って落とさず、決まった文で「できない」と出す。

### 5.9 止まり方の分類

| 起きた事 | 見分け方 | 出し方 | 会話の id を捨てる数に入れるか |
|---|---|---|---|
| `agy` が無い | 起こせない（ENOENT） | 「この機械に `agy` が入っていません」 | 入れない |
| 設定が足りない | §5.6 の 7 | 「`agy` の設定が足りません（`npm run agy-setup -- --print`）」。`agy` を起こさない | 入れない |
| サインインしていない・切れた | 誤りの文に `authentication required`【事実: 公式の文】 | 「サインインが切れています。端末で `agy` を開いてサインインしてください」 | 入れない |
| 鍵束を読めない | 誤りの文に `keyring`【事実: 公式の例】 | 「資格情報を読めません」+ やり直しの案内 | 入れない |
| 起動しない | 最初のイベントが 30 秒で来ない（§5.5） | 「`agy` が起動しませんでした」 | 入れない |
| モデルが使えない | 誤りの文に `invalid model selection`【事実: 公式の文】 | 「このモデルは今の `agy` で使えません。新しい話題で別のモデルを選んでください」 | 入れない |
| 会話が見つからない | **形が分からない**【未確認。AG0 の 4 で残す】 | id を消し、seed から新しい会話で 1 回やり直す（今の Claude の道と同じ） | —（すぐ捨てる） |
| 枠が尽きた | **形が分からない**【未確認】 | 最初は下の「その他」に入る。形が分かった時点で分類を足す | 入れない |
| その他の失敗 | `status` が `SUCCESS` 以外・exit 1 | 「止まりました」（`TurnOutcome` の `failed`。`src/app/progress.ts:34-41`）。理由の行に `error` の先頭 1 行 | **入れない** |
| 中断 | 自分で送った `SIGINT` | 「中断しました」 | 入れない（今と同じ） |
| 時間切れ | 自前の時計 | 今の打ち切りと同じ | 入れない（今と同じ） |

- **Antigravity の話題では、失敗を「3 回で会話の id を捨てる」数に入れない**（§2.5）。レビューの 5 は「分類した失敗は数えない」だったが、枠切れの形が分からず「その他」に入るので、それも数えない事にした。数えると、枠が切れている間に 3 回打っただけで会話を失う。id を捨てるのは「会話が見つからない」と分かった失敗だけ
- **壊れた会話から抜ける道**: 数えないので、続けられない会話の id が残ると同じ失敗を繰り返す。中断・打ち切りの後も id は残る（§2.5）。/renew も同じ会話での要約のターンが要るので、それだけでは抜けられない。そこで、**Antigravity の話題で /renew の要約のターンが失敗したとき（中断は除く）、失敗の知らせに［要約なしで新しくする］を付ける**。押すと、今の「会話の記録が見つからないとき」と同じ道（`renewed_fresh`。`src/app/session-renew.ts:127-144`）を通る: 会話の id を消し、seed は今の道と同じ（前の /renew の要約 → /close の要約 → 題名）。ターンを使わない。Discord はボタン。Web は口だけ: /renew の口（`POST /api/channels/<id>/renew`）に「要約なしで」の印を付けて呼べる（Antigravity の話題で、会話の id が在るときだけ。ほかは 400）。画面のボタンは AG8
- **分類できない失敗が同じ id で続いたときの扱いは、AG0 の結果で決める**（決め打ちしない）。AG0 の 4 で「中断・`ERROR` で終わった会話を同じ id で続けられる」と分かれば、今の形（数えない + 上の抜け道）のまま。続けられないと分かれば、「中断・打ち切り・`ERROR` の後は id を残さない」か「その他の失敗だけは数える」かを、出方を見て選ぶ
- 止まったターンは、今の「止まった話題」の扱い（あなたの番に数える。`docs/plan/lead.md` の決定 4）に乗る。**入口では起きない**（§2.3）が、Antigravity は話題だけなので当たらない。場所の線の Web だけの人格の入口は、止まっても「あなたの番」に出ない（§3.1）
- #483（利用枠で止まったときの自動のやり直しと［もう一度送る］）は、Claude の側もまだ main に無い【事実】。Antigravity の側は、枠が戻る時刻も誤りの形も分からないので、最初は入れない
- console の log には分類だけを出す。`error` の本文・作業フォルダのパスは出さない

### 5.10 `agy` が無い・サインインしていない機械

決め方を 1 つにする: **毎ターン起こして知る。起動では決めない。**

- 起動は止めない。`SELF_AGENT_ANTIGRAVITY_MODELS` の書き間違いだけ exit 1。`agy` が無い・サインインしていないは exit 1 にしない
- 起動のときに `agy --version` を 1 回だけ試す（変数が空でないときだけ。枠を使わない）。log に 1 行と、下の `available` の最初の値のため。**これで使える・使えないを固定しない**
- ターンは必ず runner を通る。`agy` が無ければ runner が「`agy` が無い」の結果を返す（§5.9）。後から入れたら、次のターンから動く（再起動は要らない）
- 話題を作るときだけ、実行ファイルが在るかを見る（起こさない）。無ければ作らずに断る（§5.3）
- `/api/status` に `antigravity: { models, available }` を足す。`available` は最後に分かった値（`ok` / `not_installed` / `config` / `signed_out` / `unknown`）。変数が空なら項目ごと出さない。**止まり方の分類と同じ段（AG3 で値を持ち、AG5 で口に出す）**
- 段: 変数の読み取り・書き間違いの exit 1・起動のときの確かめ・runner の配線・`/api/status` の項目は AG5。入口は AG7（§8.3）
- npm で配る物（`docs/plan/distribution.md`）: 依存を足さない（子プロセスを起こすだけ）。`agy` は同梱しない
- Mac: 置き場の既定は同じ `~/.local/bin/agy`。資格情報は Keychain。サービスとして動く self-agent から Keychain を読めるかは【未確認】。使わない人の起動には何も影響しない

### 5.11 プロンプトキャッシュ

- Claude の側: 外れない。システムプロンプトもツールの定義も変えない。`session_open` の引数 `model` の説明の文も変えない（引く関数の中身だけが変わり、Antigravity の名前には今の `bad_model` を返す）。`/new` の選択肢は Discord のコマンドの定義
- Gemini の側: 渡す文を静的に保つ・履歴は追記だけ・モデルを途中で変えない

### 5.12 残る危なさと手間

- `read_file(*)` を deny した `agy` が、自分の規則のファイル（`AGENTS.md`）を読めるかが分からない（AG0）
- 一覧の slug が Google の側で外れると、その slug の話題は続けられない（途中でモデルを変える道が無い）。新しい話題を始める。同じエンジンの中でモデルを替える道は、`/renew model:` を作るときに考える
- `agy` は自分を更新する。出力の形が変わりうる。知らないイベントは読み飛ばし、`agy --version` を log に 1 行出す。更新の後は `npm run agy-check` を回す
- 鍵束: この機械には無い。要ると分かれば入れる（sudo）必要が出て、再起動のたびに開ける手間が出るかもしれない【推測】
- 同じサブスクの枠を、オーナーの手元の Antigravity と分け合う【推測】
- 追加の運用の費用は無い（外のサービスを足さない。サブスクは今在る物。AI クレジットが切の限り、枠を超えてお金は出ない）

### 5.13 採らなかった案

| 案 | 中身 | 採らない理由 |
|---|---|---|
| Antigravity で動く人格を立てる（前の版） | `_ENGINE=antigravity` の人格と入口 | オーナーの答え 6 |
| Gemini API の Antigravity agent | API キーの従量。Google の箱で動く。HTTP だけ | オーナーの答え 2（サブスクの枠で動かす） |
| `agy` を API キーで | この機械で、従量 | 同じ |
| SDK（Python） | 常駐が 1 つ増える。サインインの道が文書に無い | 同じ + 重い |
| ACP（`agy acp`）で常駐 | JSON-RPC。エディタ向け | 1 ターン 1 プロセスで足りる。常駐を増やさない |
| 1 プロセスで複数ターン | `--input-format stream-json` で開けたまま | 常駐と後始末が増える |
| `strict` で絞る | 全部を確認にする | URL も読めなくなる（§5.6） |

## 6. オーナーの手が要る事

コマンドは公式の文書の物。公式に無い物は【推測】と書いた。**sudo の要否**を列にした。

| # | いつ | 何を | sudo |
|---|---|---|---|
| 1 | AG0 の前 | `agy` を入れる: `curl -fsSL https://antigravity.google/cli/install.sh \| bash`。置き場は `~/.local/bin/agy`。確かめは `agy --version`。入れる前に中身を読むなら、いったんファイルに落としてから。PATH を書き換えさせない・古い別名を触らせないフラグ（`--skip-path`・`--skip-aliases`）が在る | 要らない見込み【推測: 公式に記述なし。置き場はユーザー領域】 |
| 2 | 1 の後 | サインインの前に 1 回だけ `agy -p` を打ち、「サインインしていないとき」の出方を残す（枠を使わない） | 不要 |
| 3 | 2 の後 | サインイン: tmux の中で `agy` を開く。SSH だと URL が出るので、電話で開いてサインインし、出たコードを端末に貼る。個人の Google アカウント（サブスクの物）を選ぶ | 不要 |
| 4 | 3 が通らないとき | 鍵束。公式の直し方は「D-Bus のセッションと鍵束のデーモンを動かす（例: `export $(dbus-launch)`）」。この機械には鍵束のデーモンが無いので、入れる必要が出るかもしれない（`sudo apt install gnome-keyring`【推測: 公式の文書の物ではない】） | **要るかもしれない** |
| 5 | 3 の後 | 全体の設定 `~/.gemini/antigravity-cli/settings.json` に、§5.6 の中身（`"agentMode": ""`・deny の 6 つ・allow の 1 つ）を足す。`useG1Credits` と `allowNonWorkspaceAccess` が `true` になっていない事を見る（既定は両方 `false` なので、書いていなければ良い）。AG0 では手で。後は `npm run agy-setup -- --print` が中身を出す | 不要 |
| 6 | AG0 | 実測に「はい」と言う（サブスクの枠を使う。§7） | 不要 |
| 7 | AG7 | env ファイルに `SELF_AGENT_ANTIGRAVITY_MODELS=<slug>,…` を足す（slug は AG0 で残した `agy models` の出力から選ぶ。§9 の 2）。再起動に「はい」と言う。変数を読むのは AG5 からだが、入口（AG7）が入るまでは、入れても話題は出来ない | 不要 |
| 8 | サインインが切れたとき | 3 をもう一度（要れば先に `agy` の中で `/logout`）。機械を再起動した後に鍵束が閉じていれば、開ける | 4 と同じ |
| 9 | `agy` を更新したとき | `npm run agy-check`（枠を使う） | 不要 |
| 10 | 一覧の slug が Google の側で外れたとき | env の slug を直して、再起動に「はい」と言う | 不要 |

self-agent が自分でしない事: `agy` を入れる・サインインする・`~/.gemini` の下を書く・sudo。

## 7. AG0: この機械の実測（訊いてから 1 回だけ）

オーナーが入れてサインインした後、**「回して良いか」を訊いてから** 1 回。サブスクの枠を 15 ターンほど使う。結果は `docs/research/antigravity-cli.md` に、`agy` の版と一緒に残す。秘密の物は使わない（読ませる試しのファイルは、その場で作った無害な物）。

| # | 測る事 | 分かる事 |
|---|---|---|
| 1 | サインインの前の `agy -p` | 誤りの文・exit code（枠を使わない） |
| 2 | `agy --version`・`agy models` | 版。オーナーのプランで使える slug。サインインが要るか・枠を使うか |
| 3 | 2 ターン（stream-json） | イベントの実物。`usage` が 1 回ごとか累計か。`input_tokens` がキャッシュの読みを含むか |
| 4 | 続き（`--conversation <id>`） | 前のターンを覚えているか。別のフォルダからでも続くか。**知らない id を渡したときの出方**（§5.9 の「会話が見つからない」の形）。**中断（`INTERRUPTED`）・`ERROR` で終わった会話を、同じ id で続けられるか**（§5.9 の抜け道の決め） |
| 5 | stdin で渡す形 + `--conversation` | 組めるか。stdin を閉じた後の exit code |
| 6 | 渡す文 | 作業フォルダの `AGENTS.md` がヘッドレスで効くか（`read_file(*)` を deny したままで）。`--agent` で自前の agent を選べるか。`init.tools` に出る道具の名前。`--disable-slash-commands` がヘッドレスで効くか |
| 7 | モード | `--mode default` が通るか（公式には無い値。通らない前提で設計している）。`"agentMode": ""` が、起動のたびの書き直しで消えるか。この機械で、キーが無いときに `auto` と default のどちらで動いたか（出力か stderr で分かるか） |
| 8 | 道具の拒否（§5.6 の設定で） | 作業フォルダの中への書き込み・コマンド・**作業フォルダの外の読み**・作業フォルダの中の読みが拒まれるか。URL の読み取りと検索は通るか（検索の道具の名前）。stderr の知らせの形。`read_file(*)` の deny で `agy` 自身が困らないか。`unsandboxed(*)` が何を指すか、deny に書いて困らないか |
| 9 | 決まりの置き場 | Project の決まりがどこに入るか・ヘッドレスで効くか（self-agent の分だけを分けられるか）。設定の置き場を env で分けられるか |
| 10 | 新しいフォルダ | ヘッドレスが「信頼するか」で止まるか・`trustedWorkspaces` に何が入るか（§5.5 の作業フォルダの案 A が使えるか） |
| 11 | 中断 | `SIGINT` の後の `status`・exit code。`SIGTERM` ではどうか。子プロセスが残らないか |
| 12 | 枠の表示 | `agy -p "/usage"` がヘッドレスで返すか。形 |
| 13 | サービスから | 端末を持たないユーザーのサービス（self-agent と同じ起こし方）から、資格情報を読めるか |
| 14 | 置き場 | `agy` が作業フォルダと `~/.gemini` に何を書くか |
| 15 | 重さ | 最初のイベントまでの時間（§5.5 の 30 秒を決め直す）。メモリー |

測れない事: 枠が尽きたときの出方（わざと尽くさない）。設定のファイルが壊れているときのヘッドレスの出方（オーナーの設定を壊して試さない）。

**記録とテストに載せる前に消す物**（公開のリポジトリなので）: 実物の行の `init.cwd`（絶対パス）・`conversation_id`・アカウントの名前とメール・機械の名前。作り物の値に置き換えてから commit する。AG1 のテストに使う行も同じ。

## 8. 段（1 PR = 1 論点）

印: 再 = 再起動が要る／手 = オーナーの手が要る／枠 = 利用枠を使う。

### 8.1 設計書

| 段 | 何をするか | 再 | 手 | 枠 |
|---|---|---|---|---|
| WP0 | 設計書 `docs/plan/personas-web-antigravity.md`（この文書）。CLAUDE.md の表に 1 行、`docs/status.md` に節、`docs/plan/web-ui-rebuild.md` §8 に止める段の行。2 本の線を 1 本に書く | | | |

### 8.2 場所の線

| 段 | 何をするか | 再 | 手 | 枠 |
|---|---|---|---|---|
| WP1 | DB（次の番号）: `sessions.place`・`persona_channels.place`・連番の表。store。再同期がローカルを飛ばす | 再 | | |
| WP2 | ローカルの Gateway（部品とテスト）。`PersonaRouter` が `place` を先に見て振り分ける | | | |
| WP3 | 管理の操作の関所: 作る・移す・消す・トピック・数え上げが、ローカルで Discord を呼ばない。`/setup` が Web だけの人格を飛ばす | | | |
| WP4 | 文と知らせ（§3.3 の 1〜4・6）: まとめの 2 つの文・削除の確認を出さない・記憶の変更の知らせを履歴に・`kb_delete`・`/sessions` などの題名・リマインドの扱い | | | |
| WP5 | 門を開ける: `_SURFACE`、起動の配線、入口を無ければ作る、#system と `/new` から外す、`docs/environment.md`。**確かめは、Claude で動く Web だけの人格を 1 体足して行う** | 再 | 手（名前・人格の文・env） | 枠（Claude。確かめの数ターン） |
| WP6 | Web API: `POST /api/topics` が `persona` を受ける（ローカルは 503 の関所を通さない）。ローカルの `link` は `null`。一覧・`/api/channels`・`/api/status` に `surface`。完了したローカルの話題を消す口。`web-ui-rebuild.md` の約束の節に足す | 再 | | |
| WP6b | 今の殻で、どの会話でも `<#ID>` を題名と［開く］に替える（§3.3 の 5。条件を 1 つ外す）。前後の絵を撮る。**今の画面に手を入れる段なので、WP7 と一緒に止める**（#528。それまで、Web だけの人格の入口の返事では `<#番号>` が字のまま出る） | 止める（#528） | | |
| WP7 | 画面: 話題を始めるときに人格を選ぶ・ローカルの話題を消すボタン | | | **#528 の向きが決まるまで止める** |

### 8.3 エンジンの線

| 段 | 何をするか | 再 | 手 | 枠 |
|---|---|---|---|---|
| AG0 | 実測（§7）と記録 `docs/research/antigravity-cli.md` | | 手（§6 の 1〜6） | 枠（Google。訊いてから） |
| AG1 | runner の読み取り: stream-json の行 → `RunResult`（偽のプロセス。AG0 で残した行を、§7 の「消す物」を消してからテストに使う） | | | |
| AG2 | 起こし方（§5.5）: 引数・env・話題ごとの作業フォルダ・渡す文のファイル・中断・2 つの打ち切り・runner の中の直列 | | | |
| AG3 | 設定を読んで確かめる（§5.6 の 7）・止まり方の分類（§5.9）・`available` の値を持つ・`npm run agy-setup -- --print`・`docs/commands.md` | | | |
| AG4 | 保存（§5.4）: `sessions.engine` のマイグレーション・話題の store・`channel_sessions.engine` を書く・エンジンを渡して読む関数（食い違えば捨てる。今の `get` は変えない）・型 `TurnEngine`・一覧の型に `engine`（引く関数を 2 つに）・表示名をエンジンも見て引く・合計から Antigravity の行を除く | 再 | | |
| AG5 | ターンの配線: `SELF_AGENT_ANTIGRAVITY_MODELS` を読む（書き間違いは exit 1）・起動のときの確かめ・runner の配線・runner を選ぶ所を 1 つの関数に（発言・/close・/renew）・ターンの道の 4 か所を「エンジンを渡して読む」に・最初の文に記憶を付けない・画像の断り・/close の専用の文・/renew の［要約なしで新しくする］・場所の付け替えの断り・失敗を数えない・`usage_log` と使った量の行の字・`/api/status`・`docs/environment.md`（§1.3 への案内の 1 行） | 再 | | |
| AG6 | `npm run agy-check`（実機の受け入れ。§7 の 3・4・8・11 を機械で）。`docs/commands.md` | | | 枠（Google。回すとき） |
| AG7 | 門を開ける = 入口だけ（§5.3）: key で引く関数が Antigravity の行も返す・`/new` の選択肢・`POST /api/topics`・`GET /api/models`・始めたときの案内とモデルの行・`docs/plan/models.md` の入口の表 | 再 | 手（env・`agy-check`） | 枠（Google。確かめ） |
| AG8 | 画面: 始める板のモデルの一覧に Antigravity の行を出す・話題の見出しにエンジンを出す・/renew の失敗の知らせに［要約なしで新しくする］ | | | **#528 の向きが決まるまで止める** |

- AG7 を開ける条件: AG0 で §5.6 の 3 つの拒否と URL の読み取りが確かめられている事。AG6 が通っている事
- AG4・AG5 は、Antigravity の話題が無い間は誰も通らない道（`sessions.engine` が入った行が無い）。**AG5 が main に入って変数を入れても、入口（AG7）が無いので Antigravity の話題は出来ない**。変わるのは、runner が配線される事と `/api/status` の項目だけ
- **戻さない物**: Antigravity の話題が 1 つでも出来た後は、戻して良いのは AG7（入口）だけ。AG4・AG5 を戻すと、Antigravity の話題の会話の id と slug が Claude の runner に渡る（§3.4 の 2 と同じ形）。止めたいときは変数を空にする（その話題は決まった文で断る）
- 場所の線とは独立。どちらを先にしても良い

後で（今は作らない）:

| 段 | 何をするか | 待つ物 |
|---|---|---|
| AGX | OS の側で囲う（bwrap） | AG0 で設定だけでは拒めないと分かったときだけ。そのときは AG7 の前 |
| AG9 | self-agent の道具と共有の記憶を渡す | #114 の PR-D・PR-E（127.0.0.1 の MCP）。記憶はオーナーが言ったとき（答え 7） |
| AG10 | 範囲を広げる（プロジェクトを触らせる） | オーナーが言ったとき |
| AG11 | 枠が尽きたときの自動のやり直し | #483 が入り、出方が分かったとき |
| AG12 | 右腕から頼む | 答え 5 で下げた。L4 と同じ回（ツールの定義が変わる = キャッシュが 1 回外れる） |

### 8.4 受け入れ条件（テストできる形）

- WP1
  - 古い DB から上げると、今在る行の `place` はすべて `discord`
  - `place = 'local'` の話題は、Discord の親カテゴリの一覧に無くても、再同期の後に状態も SDK のセッションの対応も種も変わらない
  - `place = 'discord'` の話題の再同期は今と同じ
  - 連番から作った番号は、先頭が `1` の数字 21 桁で、続けて取ると違う値
- WP2
  - ローカルの Gateway の `send`・`sendMessage` は、毎回違う数字 21 桁を返す。管理の操作は投げる
  - `place = 'local'` の場所の `gatewayFor` は、持ち主の人格が設定に無くてもローカルの Gateway を返す
- WP3
  - ローカルの人格の話題を作ると、偽の Gateway の `createTextChannel` が呼ばれず、`sessions` に `place = 'local'`・`category_id = 'local'` の行ができる
  - 待ち・完了・進行中にしても `moveChannel` が呼ばれず、DB の状態だけ変わる。消すと `deleteChannel` が呼ばれない
  - カテゴリの空きの数え上げにローカルの話題が入らない
  - Web だけの人格が在る設定で `/setup` を打っても、その人格の入口のために `createTextChannel` が呼ばれず、`persona_channels` の行が変わらない
- WP4
  - ローカルの話題のまとめ: 履歴の行は `終わりました: <#` で始まり（`isLeadText` が真）、Discord に投げた文には `<#` が無く、題名が在る。Discord の話題のまとめは 2 つとも今と同じ
  - まとめの投稿（Discord）に失敗したら、履歴の行も書かない（今と同じ。ローカルの話題のまとめも、既定の Bot が落ちている間は Web の右腕に出ない）
  - 完了から N 日経ったローカルの話題について、#system に削除の確認が出ない。Discord の話題には今と同じに出る
  - ローカルの場所で記憶を変えると、その場所の履歴に notice の行が 1 つでき、Discord の偽 Gateway には何も行かない
  - ローカルの場所の `kb_delete` は、消さずに失敗を返す
  - ローカルの話題への Web の発言 1 つで、履歴に owner の行と agent の行ができる。返事の中の `<#ID>` は書き換わらない
  - その 1 ターンの間にローカルの Gateway に来た送信のうち、履歴に対応の行が無い物の一覧をテストが固定する
  - ローカルの場所のリマインドは、履歴に残すか・置けないと返すかを決めてテストする
- WP5
  - `_SURFACE=web` でトークンも在ると、変数名を出して exit 1。知らない値でも同じ。`_SURFACE` 無し・トークン無しは今と同じ文で exit 1
  - `_SURFACE=web` の人格が在っても、Discord の Client の数は増えない
  - 起動すると、その人格の入口が `persona_channels` に `place = 'local'` で 1 行できる。もう一度起動しても増えない
  - `GET /api/topics` の入口にその人格の行が出て、発言でき、返事が履歴に出る（Discord の偽 Gateway に送信が行かない）
  - `/new` の `persona` の選択肢に出ない。#system に接続の知らせが出ない
  - 既定の人格のシステムプロンプトとツールの定義が、変更の前とバイト単位で同じ
  - 実機: Claude で動く Web だけの人格の入口で 2 ターン話し、`session_open` で話題を 1 つ作り、終わりのまとめが右腕の #inbox に題名で出て、Web の右腕には札で出る
- WP6
  - Web だけの人格の `persona` を付けると、その人格のローカルの話題ができる。既定の Bot が切れていても 201。知らない `persona` は 400。`place` や `model` と一緒なら 400。`persona` 無しは今と同じ（Bot が切れていれば 503）
  - ローカルの話題・入口の `link` は `null`。Discord の話題の `link` は今と同じ
  - 消す口: 完了したローカルの話題は消せる（行が削除済みになる）。Discord の話題・完了していない話題は 409
- WP6b
  - Web だけの人格の入口の返事に在る `<#番号>` が、題名と［開く］で出る。右腕の会話の出方は変わらない（`ui-shots` の前後の絵）
- AG1
  - AG0 で残した行から、本文・`conversation_id`・入力／出力／キャッシュの読みのトークンが `RunResult` に入る
  - 知らないイベントの行・JSON でない行が混ざっても落ちない
  - `result` が来ないまま終わると `ok: false`・`sessionRecorded: false`
  - テストの行の `init.cwd` と `conversation_id` は作り物の値（実物の値が残っていない事をテストが確かめる）
- AG2
  - 引数に `--output-format stream-json`・`--model <slug>`・`--disable-slash-commands` が必ず在り、`--continue`・`-c`・`--mode`・`--dangerously-skip-permissions`・`--remote-control`・`--remote-agent`・`--add-dir` が決して無い
  - 子の env に Discord のトークン・`CLAUDE_CODE_OAUTH_TOKEN` が無く、`AGY_CLI_DISABLE_AUTO_UPDATE=true` が在る
  - 違う話題は違う作業フォルダ、同じ話題は同じ作業フォルダで起きる。フォルダが無ければ作り、渡す文のファイルを書く。2 回目も同じ中身
  - 続きのターンの引数に、保存した id の `--conversation` が在る
  - `signal` の abort で子に `SIGINT` が届き、結果は `aborted`。決めた時間の後は `SIGKILL`
  - 最初のイベントが決めた時間で来なければ子を止め、「起動しない」の結果を返す
  - 2 つ同時に呼ぶと、2 つ目の子は 1 つ目が終わってから起きる。待つ間に abort すると、子を起こさずに `aborted`
  - 本文が引数にも log にも出ない
- AG3
  - 設定の読み取り: ファイルが無い・JSON でない・deny の 6 つのどれかが無い・`toolPermission` が `always-proceed` か `proceed-in-sandbox`・`allowNonWorkspaceAccess` が true・`useG1Credits` が true・`agentMode` が `auto`／`accept-edits`／`plan`、のどれでも「設定が足りない」を返し、子を起こさない
  - deny の 6 つが在り、ほかのキーが無い設定は通る。`agentMode` が `""` でも、キーが無くても通る。`toolPermission` が `strict` でも通る
  - 設定のファイルを書かない（読み取りだけで開く）
  - 起こせない（ENOENT）→「`agy` が無い」。誤りの文に `authentication required` →「サインイン」。`keyring` →「鍵束」。`invalid model selection` →「モデルが使えない」。それぞれ決まった文
  - `available` が、失敗の分類で変わり、次に成功すると `ok` に戻る
  - `npm run agy-setup -- --print` は §5.6 の JSON を出し、ファイルを書かない
  - log に `error` の本文と作業フォルダのパスが出ない
- AG4
  - 古い DB から上げると、今在る行の `sessions.engine` はすべて NULL
  - エンジンを `antigravity` で作った話題は、store がそのエンジンを返す。ほかの話題は「無い」を返す
  - 会話の対応: `antigravity` で保存した行を、エンジンを渡して読む関数に `claude` で訊くと「会話なし」が返り、行が消える。同じエンジンで訊くと id が返る。今在る行（`claude`）を `claude` で訊く動きは変わらない
  - 今の `get` は、どのエンジンの行でも id を返し、行を消さない。`antigravity` の行が在る話題について、Web の一覧（`GET /api/topics`・`GET /api/channels`）を呼んだ後も、行が残る
  - codex の人格（設定の `engine` が `codex`）の今在る行は、その人格のターンの読みで消えない（比べるのは実行時のエンジン `claude`）
  - `set` をエンジンなしで呼ぶと `claude` が入る
  - 表示名: エンジンが `antigravity` なら、一覧に無い slug でも `<slug>（Antigravity）`。エンジンなし・`claude` の引き方は今と同じ
  - 合計（`summarize`・`sumOutputTokens`・`listDays`）は、`engine` が `antigravity` の行を足さない。ほかの行の合計は今と同じ
  - 一覧の Claude の 3 行は `engine` が `claude`。名前で引く関数は Claude の行しか返さない
- AG5
  - `sessions.engine` が `antigravity` の話題の発言で、Antigravity の runner が 1 回呼ばれ、Claude の runner は呼ばれない。ほかの話題・入口は今と同じ
  - その話題の新しい会話の最初の文に、記憶のブロックの見出しが無い。seed が在れば付く。Claude の話題の最初の文は、変更の前とバイト単位で同じ
  - 画像を付けた発言は、決まった断りの文が付き、runner には文だけが渡る
  - 本文が空で画像だけの発言は、断りの文だけが返り、runner が呼ばれない（`usage_log` の行もできない）
  - /close: runner に渡る文に `session_report` の語が無い。返事の文が要約になり、タスクの確認が出ない。runner が失敗したら閉じない
  - /renew: 偽の runner（Antigravity の物）で、今と同じ結果（会話の id が消え、要約が seed に入る）
  - /renew の要約のターンが失敗した Antigravity の話題では、知らせに［要約なしで新しくする］が付く。押すと、runner を呼ばずに会話の id が消え、seed に前の /renew の要約（無ければ /close の要約、それも無ければ題名）が入り、区切りの行が 1 つ書かれる。Claude の話題の失敗の知らせには付かない。中断のときも付かない
  - /renew の口に「要約なしで」の印を付けて呼ぶと、Antigravity の話題では同じ結果。Claude の話題・会話の id が無い話題では 400 で、何も変わらない
  - 場所の付け替えは、決まった理由で断る
  - Antigravity の runner が同じ会話で 3 回続けて失敗しても、会話の id は残る
  - Antigravity の runner の失敗で終わった話題が、Claude の失敗のときと同じく「あなたの番」に数えられ、統括のまとめが出る
  - `usage_log` の行の `engine` が `antigravity`、`model` が slug。そのターンの後も、Discord の `/usage` と Web の使用量の合計・日ごとの表の数は変わらない。`npm run usage` の行のモデルの欄は `<slug>（Antigravity）`。`GET /api/usage` の `rows` の行に `engine` が乗る
  - 形に合わない slug・重なり・9 個以上は、変数名を出して exit 1。変数が在り `agy` が無い機械で、起動が exit 0 で続く
  - 変数を入れても、`/new` の `model` の選択肢は 3 つのまま、`POST /api/topics` に `agy:<slug>` を渡すと 400 `invalid_model`（入口は AG7）
  - `sessions.engine` が `antigravity` なのに Antigravity の runner が配線されていない（変数を後で空にした）とき、決まった文で断り、Claude の runner を呼ばない
  - 変数が空のとき `/api/status` に `antigravity` の項目が無い。在るとき `models` と `available` が出る
  - 既定の人格のシステムプロンプトとツールの定義が、変更の前とバイト単位で同じ
- AG6
  - `agy` が無い機械では、決まった文を出して exit 1（何も起こさない・枠を使わない）。設定が足りないときも同じ（`agy` を起こさない）
  - 実機: 2 ターン目が 1 ターン目を覚えている。作業フォルダの中への書き込み・コマンド・作業フォルダの外の読みが拒まれる。URL の読み取りは通る。中断で止まる。全部通れば exit 0、1 つでも外れれば、外れた項目の名前を出して exit 1
  - 使う作業フォルダは、その場で作って終わりに消す。出力に絶対パス・会話の id を出さない
- AG7
  - 変数が未設定・空のとき: `/new` の `model` の選択肢は 3 つ、`GET /api/models` は 3 行（どれも `engine: "claude"`）、`POST /api/topics` の動きは変更の前と同じ
  - slug を 2 つ並べると、選択肢と `GET /api/models` が 5 つになり、足した行は `key` が `agy:<slug>`・`engine` が `antigravity`
  - `POST /api/topics` に `model: "agy:<slug>"` と General を渡すと 201。返事に `engine: "antigravity"`・`mode: "light"`・`place.dir` が `null`。`sessions` の行の `engine` と `model`（slug）が入る。プロジェクトのセッションが使える設定でも、General のフォルダが入らない
  - 場所がプロジェクトなら 400 `model_place`。`/new` で `project` と一緒なら本人にだけ断る。どちらも話題を作らない
  - `agy` の実行ファイルが見つからないと 503 `engine_unavailable`（`/new` は本人にだけ断る）。話題を作らない
  - 右腕の `session_open` に `agy:<slug>`・slug・表示名のどれを渡しても `bad_model` が返り、返す key の一覧は Claude の 3 つだけ。何も作らない。引数 `model` の説明の文が、変更の前とバイト単位で同じ
  - 場所の既定に Antigravity の行の key が入っていても（DB に直に書いて試す）、無い物として扱い、話題は Claude で始まる
  - 始めたときの案内に、§5.7 の 1 行が在る
  - 始めたときのモデルの行が `モデル: <slug>（Antigravity）`
  - 実機: `npm run agy-check` が通る。`/new` で Antigravity のモデルを選んで 2 ターン話し、2 ターン目が 1 ターン目を覚えている。［中断］で止まる。/close で要約が出て、右腕にまとめが出る

実装に渡すときの注意: WP1・WP5・WP6・AG4・AG5・AG7 は再起動を伴うので、マージの後にオーナーに訊いてから（AG4 と AG5 は 1 回にまとめて良い）。WP2〜WP4・AG1〜AG3 は使われない部品で、main に入れても動きは変わらない。AG1 は AG0 の記録（実物の行）が無いと始められない。AG2 の「渡す文の渡し方」「本文を stdin で渡すか」「作業フォルダの案」は AG0 の後に設計が決めてから渡す。

## 9. 残った問い（重い順。1 つずつ訊ける形）

オーナーにしか決められない物だけを置いた。設計で選べる物は選んで §10 に書いた。

**1. この機械の `agy` を、オーナー自身も端末から使いますか。**
調べ物だけに絞る設定は、`agy` の全体の設定に入れます。ファイルの読みも拒むので、同じ機械で自分でも `agy` を使うと、その `agy` はコードを読めなくなります。
- a. 使わない。この機械の `agy` は self-agent 専用（推し。いちばん固く絞れて、段も増えない）
- b. 自分でも使う（self-agent の分だけ設定を分けられるかを実測で見る。分けられなければ、OS の側で囲う段 AGX を門の前に作る）

**2.（AG0 の後・AG7 のとき）モデルの一覧に、Antigravity のどれを並べますか。**
実測で残した `agy models` の出力（オーナーのプランで使える物）から選びます。
- a. 重い物を 1 つ・軽い物を 1 つの 2 つ（推し。一覧が短く、使い分けが出来る）
- b. 1 つだけ
- c. オーナーが名前で選ぶ（8 個まで）

**3.（実測の後・要ると分かったときだけ）鍵束を入れますか。**
サインインの保存に鍵束（gnome-keyring）が要ると分かった場合です。入れるには sudo が 1 回要り、機械を再起動するたびに開ける手間が出るかもしれません。
- a. 入れる（推し。他に、サブスクのサインインを保存する道が無い）
- b. 入れない（この機械では Antigravity のモデルを使わない。変数を空のままにする）

**4.（WP5 のとき）最初に Web だけで足す人格の名前。**
- a. 名前だけ決めてもらい、人格の文の下書きはこちらで出す（推し）
- b. 名前も文もオーナーが書く

前の版に在って、無くなった問い: 「Antigravity の人格を Web だけにするか」（答え 6 で人格を立てない）・「モデルは既定のままか」（答え 6 で一覧から選ぶ）・「AI クレジットを自動で使うか」（公式の既定が切。入っていたら使えないにする、と設計で決めた）。

## 10. 決めた事・決まっていない事・確かめられなかった事

### 設計の側で決めた事

| 事 | 中身 | 節 |
|---|---|---|
| 2 本の線に分ける | 場所とエンジンは独立 | §0 |
| エンジンは話題が持つ | `sessions.engine`。無ければ持ち主の人格の実行時のエンジン（今は全部 `claude`）。#114 の「人格ごとに固定」は残す | §5.1・§5.4 |
| 一覧は env で並べる | `SELF_AGENT_ANTIGRAVITY_MODELS`。空なら何も増えない（門） | §5.2 |
| `/new` からも選べる | Web の画面が止まっている間の入口。キャッシュは外れない | §5.3 |
| 場所の無い話題だけ | General のフォルダも入れない。場所の付け替えは断る。場所の既定には置けない | §5.3 |
| 右腕からは選べない | 名前で引く関数が Claude の行だけを見る。説明の文は変えない | §5.3 |
| 作業フォルダは話題ごと | 信頼の確認で止まるなら全体で 1 つに | §5.5 |
| 1 ターン = 1 プロセス・runner の中で直列 | 常駐させない。呼ぶ側の印に頼らない | §5.5 |
| `--mode` は付けない。`--continue` も付けない | default は設定の `"agentMode": ""` で | §5.5・§5.6 |
| `request-review` + deny + `allow read_url(*)` | `strict` は URL も読めなくなるので採らない | §5.6 |
| 設定を self-agent が毎ターン読んで確かめる | 緩んでいたら起こさない。書かない | §5.6 |
| `useG1Credits` が入っていたら使えない | 知らない所でお金が出ないため | §5.6 |
| 門の条件 | フォルダの外の読み・書き込み・コマンドが拒まれ、URL が読めると実測で確かめるまで開けない | §5.6 |
| 記憶は渡さない・seed は渡す | 最初の文を組む関数 1 つで切り替える | §5.7 |
| まとめのターンは `agy` で回す | /close は専用の文。タスクの確認は出ない | §5.8 |
| Antigravity の話題では、失敗を id を捨てる数に入れない | 枠切れの形が分からないため | §5.9 |
| 壊れた会話から抜ける道 | /renew の失敗に［要約なしで新しくする］ | §5.9 |
| 会話の対応の `get` は副作用なしのまま | 食い違いで捨てる読みは別の関数で、ターンの道の 4 か所だけ | §5.4 |
| Antigravity のターンを Claude の合計に足さない | 1 ターン 1 行の表示で見えるだけ | §5.4 |
| 変数を読むのは AG5、入口は AG7 | Antigravity の話題が出来た後に戻せるのは AG7 だけ | §8.3 |
| `agy` が在るかは毎ターン知る | 起動で固定しない。起動は止めない | §5.10 |
| まとめの履歴の行は `<#ID>` のまま | Discord に投げる文だけ題名 | §3.3 |
| ローカルの話題の削除の確認を出さない | Web API に消す口を足す | §3.3 |
| 記憶の変更の知らせは履歴に書く・`kb_delete` は失敗を返す | 押せないボタンで待たせない | §3.3 |
| 再同期の「飛ばす」を最初に入れる | ローカルの行を作れる PR より前 | §3.4 |
| 最初は自前のツールを渡さない・自動のやり直しをしない | 後の段（AG9・AG11） | §8.3 |

### 決まっていない事

| 事 | 誰が決める |
|---|---|
| §9 の 1〜4 | オーナー |
| 渡す文を `AGENTS.md` で渡すか、自前の agent か、最初の本文の頭か | 設計（AG0 の後） |
| 本文を stdin で渡すか、`-p` で渡すか | 設計（AG0 の後） |
| 作業フォルダを話題ごとにするか、全体で 1 つか | 設計（AG0 の 10 の結果で） |
| 最初のイベントの打ち切りの秒数 | 設計（AG0 の 15 の結果で） |
| 分類できない失敗が同じ id で続いたときの扱い | 設計（AG0 の 4 の結果で） |
| `unsandboxed(*)` を deny に残すか | 設計（AG0 の 8 の結果で） |
| OS の側で囲う段（AGX）が要るか | 設計（AG0 の 8・9 と §9 の 1 の答えで） |
| ローカルの場所のリマインドの扱い | 設計（WP4 の中で） |

### §1.2 の既定についての見立て

- 1 日の上限を入れない: 妥当。`useG1Credits` が入っていれば使えないにするので、枠を超えてお金は出ない。Antigravity は話題だけで動くので、入口の日替わりのような「人が打たないターン」は無い（/close と /renew のまとめが 1 ターンずつ）
- 枠切れを「止まった」ターンで出す: 妥当。ただし最初は、他の失敗と見分けが付かない（形が公式に無い）。理由の行に `agy` の誤りの文の先頭を出すので、読めば分かる

### PR #531 のレビューの「気になる物」をどう入れたか

13 個すべて入れた（入れなかった物は無い）。

| 物 | 入れた所 |
|---|---|
| `link` が切れたリンクになる | §3.2・WP6（ローカルは `null`） |
| `POST /api/topics` の 503 の関所 | §3.2・WP6 |
| `/setup` が入口を作ってしまう | §3.1・§3.2・WP3 |
| `sessions.category_id` が NOT NULL | §3.1・WP1（`local`） |
| `agy` が無いときの決めの食い違い | §5.10（毎ターン知る）。`/api/status` は AG3 で値・AG5 で口 |
| 全体の設定を self-agent が確かめない | §5.6 の 7・AG3 |
| `--continue` を付けない | §5.5・AG2 |
| 鍵束で固まる | §5.5（最初のイベントの打ち切り）・AG2 |
| 同時に 1 つの掛け方 | §5.5（runner の中で直列）・AG2 |
| AG0 の記録と AG1 のテストに載る物 | §7・AG1 |
| `web-ui-rebuild.md` §8 に行が無い | 足した（WP7・AG8） |
| `scheduler.ts` の行のずれ | §2.4・§3.4 |
| レビューが確かめていない範囲 | 下の「確かめられなかった事」に残した |

### 確かめられなかった事

- 枠が尽きたとき・サインインが切れたとき・知らない会話の id を渡したときの、実際の出方（公式に在るのは `authentication required` と `invalid model selection` の語だけ）
- `agy` の入れ方が sudo を要るか（公式に記述なし）。この機械の glibc で動くか
- 鍵束の無いサーバーで、資格情報がどこに行くか。サービスから読めるか
- `read_file(*)` を deny した `agy` が、`AGENTS.md` を読めるか。自前の agent と `--agent` がヘッドレスで効くか
- default モードを設定だけで固定できるか（`"agentMode": ""` が起動のたびの書き直しで消えるか。公式は「既定の値のキーは消す」と書いている）
- `strict` の説明が公式の 2 つのページで食い違う（§4.3 の 2）。設計は `strict` に頼らない形にした
- 知らない action を決まりに書いたときの動き。`unsandboxed` の意味。検索の道具の許可の名前
- Project の決まりの置き場と、ヘッドレスでの効き方。新しいフォルダで「信頼するか」を訊かれるか
- stdin の形と `--conversation` を組めるか。別のフォルダから id で続けられるか。中断・`ERROR` で終わった会話を続けられるか
- `usage` が 1 回ごとか累計か。会話が長くなったときに自動で縮めるか
- `SIGTERM` での止まり方。`agy --version`・`agy models` がサインインや枠を要るか
- Mac のサービスから Keychain を読めるか
- コードの側: ローカルの場所でのリマインド・入口の引き継ぎ・進み具合の表示の実際の道。今の殻で `<#ID>` を替える条件を外すのが 1 か所で足りる事。`RENEW_PROMPT` を `agy` に渡して要約が返る事。取り込み・GitHub の話題・Claude Code のチャンネルが既定の人格だけである事（読んだ範囲ではそう見える）
- 規約 §6 と FAQ は前の版で読んだ。今回は読み直していない
- この調べ物では何も動かしていない（`agy` を入れていない）

## 11. 出典

公式

- 文書の目次: https://antigravity.google/llms.txt
- 入れ方: https://antigravity.google/docs/getting-started/
- サインイン: https://antigravity.google/docs/install?tab=cli
- ヘッドレス: https://antigravity.google/docs/cli/headless/
- コマンドと設定: https://antigravity.google/docs/cli/reference/
- モード: https://antigravity.google/docs/cli/modes
- 許可: https://antigravity.google/docs/permissions ・ https://antigravity.google/docs/cli/commands/permissions
- 設定: https://antigravity.google/docs/settings ・ https://antigravity.google/docs/agent-settings
- モデル: https://antigravity.google/docs/models
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
