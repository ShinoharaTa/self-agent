# 端末のセッションの管理をやめ、取り込みとプロジェクトのセッションを本線にする（#428）

- 状態: v1（2026-11-18）。方向と §5.1 の 5 件はオーナーが決定済み（#428。5 件とも推薦どおり）。今は H1 まで（H1 は 3 本。takeover.md §5）。本書は段の順・消す物・穴の埋め方・オーナーが決める事を詰める
- 関連: #341（取り込み。`docs/plan/takeover.md`。v3）・#277（`docs/plan/unify.md`）・#191・#236・#265（リモコン）・#349（Web UI の部品）
- 言葉: **リモコン** = 端末の Claude Code を外から操作する今の機能（CC1〜CC14・Q1〜Q5）。**取り込み** = 端末の会話を SDK の resume で引き継ぎ、プロジェクトのセッションとして続ける事（#341）。**札** = 一覧の端末の行を押したときに出す小さい 1 枚（§2.2）
- 確かさの印: 【確】コードか実機で確認 /【文】設計書・issue・PR の本文から /【推】推測 /【未】未確認（§5.2 に試し方）

## 0. 目的と結論

**何のために**: 同じ「Claude Code に仕事を頼む」に入口が 2 つある（端末を外から操作するリモコンと、Bot が自分で動かすプロジェクトのセッション）。リモコンは tmux のペインに字を貼り、返事・許可・質問を hook と画面の写しで拾うので、壊れやすく、直す所が多い。本線をプロジェクトのセッション 1 つにして、端末の会話は「引き継ぐ相手」としてだけ扱う。オーナーが覚える事と、保つコードを減らす。

結論:
1. 端末のセッションに残すのは **一覧（読むだけ）と［取り込む］** だけ。画面の写し・tmux への送信・tmux での起動・返事の追いかけ・端末のセッションごとの Discord のチャンネルはやめる
2. 順は「投資を止める（H0）→ 取り込み（H1〜H3）→ 質問・モード（H4）→ ［対応］の付け替え（H5）→ 使う期間 → 消す（X1〜X5）」。DB の表を消す移行は最後（X5）
3. 取り込みの PR の列（#342〜#348）は、**今の main の上に積み直す**（土台は運び、入口と Web は作り直す。§3.4）。取り込み先は `cc-<名前>` をその場で変えるのでなく、**新しい普通のチャンネル**にする（オーナーの決定 2）
4. 消すときにプロンプトキャッシュが外れるのは **1 回**（X1 にまとめる。§4.3）
5. 外部サービスは増えない（運用コスト 0 円。§7）

範囲の外: 端末へ戻す向き（unify.md の U3）・作業ジョブ（保留のまま）・「端末の記録を読んで会話として描く」案（取り下げ済み。再検討しない）。

## 1. 今の全体の地図

### 1.1 機能ごとの行き先

| 機能 | 行き先 | コード | DB | 設定・コマンド | Discord | Web |
|---|---|---|---|---|---|---|
| プロジェクトのセッション（U1） | 残す（本線） | `agent/project-profile.ts`・`agent/permission-bridge.ts`・`app/session-ops.ts` | `sessions.project_dir`・`permission_mode`（v40） | `SELF_AGENT_CC=1`・`SELF_AGENT_WORKSPACE_DIR`・`SELF_AGENT_GENERAL_DIR`・`unify-setup` | `/new project:` | `POST /api/topics` |
| 許可・質問の保留と答える口 | 残す | `cc/permission-hold.ts`（`holdExternal`・`answer`・`answerQuestion`）・`cc/permissions.ts`・`cc/questions.ts`・`cc/question-flow.ts`・`cc/notice-text.ts` の許可と質問の文・`app/commands/cc-question.ts` | `cc_permissions`（origin sdk） | `SELF_AGENT_CC_PERMISSION_HOLD_SEC`・`SELF_AGENT_CC_QUESTION_HOLD_SEC` | `cc:perm:*`・`cc:q:*` | `/api/cc/permissions/<id>/*`・部品 `PermissionCard`・`QuestionCard` |
| プロジェクトの一覧と検査 | 残す（置き場所を移す） | `cc/starter.ts` の `listProjects`・`projectDir`・`ensureGeneralDir`・`ccPlacesOf`・`CC_PROJECT_PATTERN` | なし | 同上 | `/new`・`/move` | `/api/topics`・場所の一覧 |
| 端末のセッションの一覧（読むだけ） | 残す | `cc/agents.ts`・`cc/registry.ts`（一覧の読み取り）・`cc/claude-dirs.ts`・`cc/labels.ts` | `cc_sessions` の基本の列（v27） | `SELF_AGENT_CC_POLL_SEC`・`cc-dry-run` | なし | `/api/topics` の origin cc の行 |
| リポジトリ → 場所の地図 | 残す（ペインの部分を除く） | `tmux/workspace-map.ts` の `buildWorkspaceMap`・`app/github-handoff.ts` の `startDirOf` | なし | `SELF_AGENT_GITHUB_OWNERS` | なし | なし |
| 取り込み | これから入る | `cc/takeover*.ts`・`store/cc-takeovers.ts` | `cc_takeovers` | 足さない | `/cc take`・`cc:take:*`・`cc:takepick` | `/api/cc/sessions/<id>/takeover`・`/api/cc/takeovers/<id>/*`・札 |
| 端末で使っている間の許可・質問の届け | **移行が済むまで残す**（最後は決定 1） | `cc/hook-server.ts`・`permission-hold.ts` の `request`・`cc/channel-posts.ts` の許可と判断待ち | `cc_permissions`（origin hook）・`message_id` の列 | `SELF_AGENT_CC_HOOK_PORT`・`_HOOK_TOKEN`・`SELF_AGENT_CC_NOTIFY`・`cc-setup` | `cc:perm:*`（同じボタン） | 許可のカード |
| 取り込みのペインの確かめ | 移行が済むまで残す（§3.4 の 5） | `tmux/pane-state.ts` の `probePaneState`・`cc/panes.ts` の `lookup`・`tmux/tmux.ts` の読み取り | なし | tmux | なし | なし |
| 画面の写し・［端末］のタブ | 消す（X2） | `tmux/pane-state.ts` の写し・`web/static/views.js` の `cc:` のタブ・`shell.js` の `view2` の pane | なし | なし | なし | `GET /api/cc/sessions/<id>`・［会話］⇄［端末］ |
| tmux への送信 | 消す（X2・X3） | `cc/sender.ts`・`cc/panes.ts`（残りを除く）・`tmux/tmux.ts` の貼り付け | `cc_sends`・`cc_state` | `SELF_AGENT_CC_SEND_WAIT_MIN`・`cc-dry-run -- --reset-multiline` | `/cc cancel` | `/send`・`/api/cc/sends/<id>/cancel`・`ccComposer` |
| tmux での起動 | 消す（X2・X3） | `cc/starter.ts` の `CcStarter.launch` | `cc_starts`・`cc_sessions` の `started_by`・`tmux_session`・`tmux_session_id`・`start_pane_id`・`trust_pending_at` | `SELF_AGENT_CC_MAX_SESSIONS` | `cc:resume:`（［起動して続ける］） | `POST /api/cc/sessions`・起動のダイアログ |
| 返事の追いかけ | 消す（X3） | `cc/replies.ts` | `cc_replies`・`cc_sessions` の `follow*`・`reply_count*`・`cc_sends.reply_state` | なし | `cc:unfollow:` | `/unfollow` |
| 端末のセッションごとのチャンネル | 消す（X3） | `cc/channels.ts`・`cc/channel-posts.ts` の写し・`store/cc-channels.ts` | `cc_channels`・`guild_settings.cc_category_id`・`cc_sessions.channel_id` | なし | `/cc open\|cancel\|close`・`cc:del:*`・カテゴリ「Claude Code」 | `/channel`・`/api/cc/channels/<id>/close`・`/api/channels` の kind cc・history の cc の行 |
| SDK のツール cc_list・cc_send・cc_start | 消す（X1） | `app/cc-tools.ts`・`app/commands/cc-confirm.ts`・`agent/tools.ts` の定義・`agent/system-prompt.ts` の 1 行 | `cc_starts`・`cc_sends` の awaiting_confirm | なし | `cc:` の［送る］［起動する］［やめる］ | あなたの番の行 |
| GitHub の［対応］の宛先（tmux） | 付け替える（H5） | `app/github-handoff.ts` の宛先選び | `cc_sends.notification_id` | `SELF_AGENT_GITHUB` | `gh:act`・`gh:start`・`gh:cancel` | `/api/github/<id>/act`・`/start` |

設計書: 残す側は `unify.md`・`takeover.md`・本書。消す側は `claude-code-sessions.md`・`claude-code-channels.md`・`claude-code-questions.md`（質問の表現 §2〜§4 だけは残す側が使う）。

### 1.2 消すときに波及する所（【確】import を追った）

| 共用している物 | 使っている本線の側 | 扱い |
|---|---|---|
| `SELF_AGENT_CC=1` | プロジェクトのセッション・General・許可の橋の前提（`main.ts` の `projectRunner`・`unifyReady`）。今は **claude と tmux の両方**と、hook のポート・トークンが無いと起動エラー | 名前は変えない。X4 で hook の 2 変数と tmux の必須を外す（§4.2） |
| `cc_permissions`・`cc/permission-hold.ts`・`permissions.ts`・`questions.ts`・`question-flow.ts` | `agent/permission-bridge.ts`（origin sdk の行・`holdExternal`） | 残す。表の名前・ボタンの `cc:perm`・`cc:q`・API のパスも変えない（押せないボタンを残さない） |
| `cc/notice-text.ts`・`cc/channel-posts.ts` の `permissionHistoryText` 系・`cc/hook-server.ts` の `summarizePermission` | 許可の橋が文と要約に使う | 使う関数だけ残す側のファイルへ移してから、元を消す |
| `cc/starter.ts` のプロジェクトの検査 | `app/session-ops.ts`・`right-hand.ts`・`topic-move.ts`・`github-handoff.ts`・`commands/new.ts`・`move.ts`・`web/routes/projects.ts`・`topics.ts`・`agent/project-profile.ts`・`cc/labels.ts`（`CC_PROJECT_PATTERN`）・`main.ts` | X3 の前に別のファイルへ移す（動きは変えない PR） |
| `cc/registry.ts` の `CcTimers` | `app/topic-proposals.ts` | 型を移す |
| `cc/hook-server.ts` の型と定数（`CcHookEvent`・`CcHookReceiver`・`CcPermissionSummary`・`CC_WAITING_NOTIFICATIONS`） | `cc/registry.ts`・`cc/permission-hold.ts` | X4 の前に残す側のファイルへ移す |
| `tmux/tmux.ts` の `execFileRunner`・`RunCommand`・`CHILD_*`、`tmux/pane-state.ts` の `CLAUDE_COMMAND`・`PaneState` | `cc/agents.ts`・`tmux/workspace-map.ts` | 貼り付け・写しだけを消し、これらは残す（置き場所は実装で） |
| `web/routes/cc.ts` の `CC_PERMISSION_RECENT_MS`・`HoldSeconds`・`questionJson`・`permissionJson`・`SUBMIT_STATUS`・`CC_STATUS_DISABLED`・`CcStatus`、`commands/cc-confirm.ts` の `CC_CONFIRM_TTL_MS`・`ccRepliesIn`・`CC_START_SEND_FAILED_NOTE` | `web/routes/topics.ts`（あなたの番）・`channels.ts`・`turns.ts`・`status.ts`、`app/commands/github.ts`・`app/github-handoff.ts` | 残すファイルへ移す（`cc-confirm.ts` は X1 でファイルごとは消せない）。`/api/status` の cc の欄（hook のポート・tmux・複数行の可否を読む）は X2〜X4 で、残る物だけに削る |
| `cc/channels.ts` の `ccDeletePrompt`・`CcChannels` と振り分け（`routeCcChannelMessages` など） | `app/scheduler.ts`・`web/routes/turns.ts`・`main.ts`（配線）。`web/routes/cc.ts` は `app/commands/cc.ts` の `closeReply` も使う | X3 で呼び手ごと外す |
| 止めるときの順（`app/shutdown.ts` が型で持つ: `CcChannelPosts`・`CcHookServer`・`CcReplier`・`CcSender`・`CcStarter`・`CcConfirmExpirer`） | 停止の手順 | 消す段ごとに引数から外す |
| `cc_sessions` | 一覧・取り込み・`/api/topics` | 表は残し、X5 で使わない列だけ落とす |
| `SELF_AGENT_DELETE_AFTER_DAYS` | 普通のセッションの削除の確認 | 残す（cc の側の確認だけ消す） |
| 取り込みが頼る消す側（`ensureFor`・`markTaken`・sender の holds・`stopFollow`・`ccEndedHandler`） | 今の取り込みの設計 | 取り込みの側を変えて頼らなくする（§3.4） |

## 2. 移行の後の姿

### 2.1 オーナーの 1 日
- 新しい仕事は、Web の「新しい話題」か Discord の `/new project:<名前>` で始める。最初からプロジェクトのセッション。許可・質問はその話題のカード（Discord はボタン）で答え、進め方は `/mode` で変える
- GitHub の通知は #github か Web の GitHub のタブの［対応］。その PR・issue の話題ができ、そこで進む
- 机の端末で進めた会話を外から続けたいときは、一覧の「端末」の行 →［取り込む］。端末の claude は終わり、同じ会話が話題として続く
- 端末で実行中・判断待ちの物は、一覧に状態だけ出る。答えるのは端末か RC（決定 1）

### 2.2 一覧に端末のセッションをどう出すか
- **行**: 今の新しい殻のまま。場所（プロジェクト）の群の中に、題名の後ろへ「端末」の札を付けて出す【確 `c-list.js`】。群「Claude Code」は古い殻だけの物で、直さない（flip で消える）。workspace の外の物は群「ほかの場所」のまま
- **行を押したら**: 列 2 に**札**を出す。中身は 名前・場所・状態（待機 / 実行中 / 判断待ち）・最後の活動の時刻・RC のリンク・［取り込む］。取り込めないときはボタンを無効にして理由を 1 行（§3.5）。**画面の写し・記録の本文・入力欄は出さない**
- 札は部品で新しく作る（`c-cards` の事実の行・状態の行を使う。K の決まりどおり見本のページ・`test/web-components.test.ts`・`ui-shots`）。古い `cc:` のタブを部品に直すのではない
- 共存の間（H3〜X2）: 札が既定で、札の「端末を見る」から今の［端末］（古い描き方）を開ける。X2 で「端末を見る」と［端末］を消す
- `cc-<名前>` のチャンネルがある端末のセッション（`ch:` の行）は X3 まで今の会話のタブのまま。頭のカードに［取り込む］を 1 つ足す
- Discord: 端末のセッションの一覧は `/cc take` の選択（待機の物だけ）。状態を文で知りたいときは右腕（#inbox）の `topic_list`（origin cc の行を返す【確】）

## 3. 穴の埋め方

### 3.1 質問・モード（U2）— 段 H4
流用する物（Q1〜Q5 から）:

| 元 | 流用する物 | 流用しない物 |
|---|---|---|
| Q1 | `cc_permissions` の `question_input`・`answers`、`parseQuestions`・`validateAnswers`、`answerQuestion`、応答の形（`allow` + `updatedInput` に `answers`。canUseTool の戻り値と同じ形【文 unify.md §5.1】）、`/api/cc/permissions/<id>/answer`、保留の秒 | hook の受け口の読み取り、`answered_elsewhere` の検知（端末が無い） |
| Q2 | `question-flow.ts`（1 通を 1 問ずつ・その他はモーダル）・`cc:q:*`・質問の文 | 時間切れの文「端末か RC で答えてください」→「時間切れ。続きを送ると訊き直します」 |
| Q3 | 部品 `QuestionCard`【確 `c-cards.js`】 | なし |
| Q4 | なし（プロジェクトのセッションは最初から自分のチャンネルに出す） | `ensureFor` でチャンネルを作る道 |
| Q5 | 関係なし（会話の行の軽量化は共通） | — |

- **質問（H4a）**: `PROJECT_DISALLOWED_TOOLS` から AskUserQuestion を外し【確 `project-profile.ts`】、許可の橋で tool が AskUserQuestion のときは `question_input` 付きの行を作って質問のカードを出す。時間切れ・［やめる］は deny。`answerQuestion` は origin を見ないので `holdExternal` の行も閉じられる【確 `cc/permission-hold.ts`】。橋が、閉じた行の `answers` を `updatedInput` に写す所は新しく書く。要約のターン（/close・/renew）では AskUserQuestion を外したままにする
- **モード（H4b）**: unify.md §5.1 のとおり。`/mode`（プロジェクトのセッションの中だけ。default / acceptEdits / plan）と Web の見出しのセレクト（`TopBar` の部品に足す）。ターンの途中では変えない。bypassPermissions・dontAsk・auto は出さない
- 案の比較（順）:

| | A: 取り込み → U2（#428 の順） | B: U2 → 取り込み | **C: 並べて進め、先に入った方に後が合わせる** |
|---|---|---|---|
| 取り込みの前置きの文の直しの回数 | △ 2 回 | ◎ 1 回 | ○ |
| 止まる時間 | △ 列の積み直しを待つ | △ | ◎ 触るファイルがほぼ別 |
| 使い始めの早さ | ○ | ○ | ◎ |

**推薦 C**。H4 は取り込みと触るファイルが重ならない（重なるのは前置きの文だけ）。後から入った方が、前置きの「AskUserQuestion は使えません」を外し、端末の plan・acceptEdits を引き継ぐ（`mapTakeoverMode`。takeover.md の未決 6 の推薦どおり）。

### 3.2 GitHub の［対応］の宛先 — 段 H5

| | **A: PR・issue ごとに新しい話題** | B: 同じプロジェクトの進行中の話題へ積む | C: 押すたびに選ばせる |
|---|---|---|---|
| 一覧での追いやすさ | ◎ 1 スレッド = 1 行 | △ 別の仕事に混ざる | ○ |
| 進行中の会話の文脈 | ◎ 汚さない | ✗ 外からの依頼が割り込む | ○ |
| 押す回数 | ◎ 1 回 | ◎ | △ 2 回 |
| 実装コスト | ○ `startTopic` に乗る | △ 宛先選びを作り直す | △ |
| 同じ作業ツリーを 2 つが触る | △ 起きうる（今の tmux でも同じ） | ◎ | ○ |

**推薦 A**（決定 3）。
- 宛先: 地図（`buildWorkspaceMap`）でリポジトリ → workspace の直下のプロジェクト。`startTopic`（`by` に `github` を足す）で、場所はそのプロジェクト、題名は `handoffTitle`、最初の一言は `handoffTemplate`（文は今のまま）
- 同じスレッドにもう話題があれば、新しく作らず「対応中 → その話題」を返す（今の `already`）。その話題が閉じていれば新しく作る
- 地図に無いリポジトリは今のまま `not_local`。General で始める案は採らない（リポジトリが無い所では対応できない）
- ［対応］と［起動して送る］は 1 つになる（`no_session` の分岐が無くなる）。確認の文に「同じ場所で実行中の話題: n 件」を 1 行（重なりの注意）
- DB: 小さい表 `github_topics`（notification_id・thread_id・channel_id・created_at）を足す。`github_handoffs` という名前は使わない（同じ名前の古い表が v21 から残っていて、列が合わない【確 `store/db.ts`】。古い表は X5 で消す）。`cc_sends.notification_id` は X5 で表ごと消える
- 運用コスト: 話題が増える分は、今ある削除の確認（`SELF_AGENT_DELETE_AFTER_DAYS`）で片付く

### 3.3 tmux の外のセッションの取り込み

| 種類 | 分かっている事 | 未確認 |
|---|---|---|
| VS Code の拡張 | この機械は GUI が無いので、あるとすればリモート接続の拡張の下で動く claude | 一覧への出方・SIGTERM の後に拡張が起こし直すか |
| `claude --bg` | `claude agents --json` は background も出す【文 sessions.md §1.2】。実機で見た kind は全部 interactive | 止め方（公式の口があるか）・SIGTERM の後に戻るか |
| RC のサーバーモード（user unit） | tmux の外で動く【文】 | 一覧への出方（sessions.md §12 の 7）・子を止めたとき親が起こし直すか |

- 【確（実機 2026-11-18）】今動いている claude という名前のプロセス（二十数本）は**すべて tmux の下**。tmux の外の物は 1 本も無かった（別の名前で動く物があれば数えていない）
- 案: A **生きている tmux の外は断り、「終わらせてから取り込めます」と案内する**（今の設計。終わったセッションは取り込める）/ B 種類ごとに止め方を持つ / C 止めずに分岐して引き継ぐ（別の session_id）
- **推薦 A**（決定 4）。今は使われていない道に、未確認の止め方を作り込まない。B は実機で 3 種類の出方を見てから（§5.2 の 6）。C は採らない（同じ作業ツリーを 2 つの会話が触り、どちらが続きか分からなくなる）
- 残る穴: Bot が止まっていた間に始まって終わったセッションは `cc_sessions` に行が無く、候補に出ない。使う期間に困ったら、記録のファイル名と更新時刻だけを読んで候補に足す（本文は読まない）。今は作らない

### 3.4 取り込みの PR の列（#342〜#348）の合わせ直し
列の根は古い main で、main はそこから 200 commit 近く進んだ【確】。両方が触ったファイルは `store/db.ts`・`agent/system-prompt.ts`・`app/handler.ts`・`interactions.ts`・`shutdown.ts`・`main.ts`・`web/routes/cc.ts` と古い殻の静的ファイル。

| | A: 7 本を rebase して入れ、設計の変更は後の PR | **B: 今の main に新しいブランチで積み直す（土台は運び、入口と Web は作り直す）** | C: 全部書き直す |
|---|---|---|---|
| レビュー済みの中身を活かす | ◎ | ○ 土台はそのまま | ✗ |
| 捨てるコードを一度 main に入れない | ✗ 古い殻の画面・`cc-…` を変える道が入る | ◎ | ◎ |
| 手間 | △ 衝突 + 直後に作り直し | ○ | ✗ |

**推薦 B**。古い PR は「積み直した」と書いて閉じる（閉じるのはオーナーの指示で。force push はしない）。

**設計が変わる所**:

| # | 今の設計（takeover.md v2） | 変える | 当たる PR |
|---|---|---|---|
| 1 | 取り込み先は今ある `cc-<名前>` をその場で変える。無ければ `ensureFor` で先に作る | **新しい普通のチャンネルを作る**（`createTopicSession` の前半を切り出した `createTopicChannel` で先にチャンネルを作り、`sessions` の行は取り込みの commit で作る（takeover.md §3.1）。題名は端末のセッションの名前）。`markTaken`・同じ channel_id で `sessions` を作る道は使わない。未決 1（名前が `cc-…` のまま）は消える | #343 の `markTaken`・#344 |
| 2 | 既にある `cc-…` のチャンネル | その場で変えず、「取り込みました → 新しいチャンネル」を 1 通出して完了へ移す（移行の間だけの道。X3 で消える） | #344 |
| 3 | 入口は cc のチャンネルの中の `/cc take`。外では選ぶ | **どこで打っても一覧から選ぶ**（#347 の `cc:takepick`・`takeableSessions` を主に）。選ぶ → 確認 → 新しいチャンネル | #346・#347 |
| 4 | 終わったチャンネルの［取り込んで続ける］（CC13 の案内に載る） | 作らない（載せる先が消える側）。終わったセッションは一覧から選ぶ | #347 の半分 |
| 5 | 生きているセッションはペインの確かめ（`probePaneState`）が要る | 変えない。ただし tmux を必須にしない（無ければ生きている物は断り、終わった物だけ取り込める）。`pane-state.ts` の判定と `panes.ts` の `lookup` は残す側へ | #344 |
| 6 | Web は古い殻（`chat.js` の cc のタブの頭・`dlg-cc-take`） | **新しい殻で作り直す**（札の［取り込む］・確認は `SA.ask`）。API の 3 ルートは運ぶ。応答に新しい話題の id を返し、画面はそこへ移る（`cc:` の行は消え、`ch:` の行ができる。web-ui-v3.md §3.1 の「id は変わらない」を直す） | #348 |
| 7 | DB は v42 で `cc_takeovers` | main は v44【確】。**v45 以降**（#338 が先に入ればその次。番号は配列の位置で決まり、後から入る方がずらす）。v42 を後から直した分（T1b）は 1 つの移行にまとめる。入れる前に本番の DB に同じ名前の表が無い事を読み取り専用で確かめる | #343 |
| 8 | リモコンとの守り（`taking_over` で送信・起動・［削除する］を断る、ended の差し止め、`stopFollow`） | 運ぶのは送信の守り（`CcSender` の `holds` と `taking_over`）だけ。起動・［削除する］の守り、ended の差し止め、`stopFollow` は運ばない（行き先が別のチャンネルなので要らない。takeover.md §3.2）。X1〜X3 で相手ごと消す | #344 |
| 9 | 前置きの文（AskUserQuestion は使えません）・モードは常に default | H4 の後に直す（§3.1） | #345 |
| 10 | 設計書 #342 | v3 に直して H1 の最初に入れる（§0・§3.1・§3.5・§8 が本書と食い違う） | #342 |

変えない物: 前提（プロセスを終わらせる・待機中だけ・workspace の直下だけ）、相手の確かめ 5 つ、記録を Bot 側へ写す、SDK のツールは作らない、起動時の片付け 2 段。

### 3.5 取り込めないときの案内
案: A **断って理由と次の手を出すだけ** / B 「待機になったら取り込む」の予約 / C 「待機になったら知らせる」。**推薦 A**。B は確認から実行までの間に状況が変わる（プロセスを止める操作を予約にしない）。C は知らせの仕組みを足す投資になる。状態は一覧の行と札でいつでも見える。

| 状況 | 札・Discord の文 |
|---|---|
| 実行中 | 実行中です。終わると取り込めます |
| 判断待ち | 判断待ちです。端末か RC で答えると取り込めます（RC のリンク） |
| tmux の外で生きている | このセッションは外から終わらせません。終わらせてから取り込めます |
| 場所が workspace の直下でない | この場所のセッションは取り込めません |
| 送信の届け待ち、許可の保留中（共存の間だけ） | 今の操作が済んでから取り込めます |

## 4. 段の順

### 4.1 入れる段

| 段 | 入る物 | 前提 | オーナーに見える変化 | 戻し方 |
|---|---|---|---|---|
| **H0** 投資を止める | 文書だけ: 本書・unify.md（§0 の 6・§5.7・§5.9・§6）・web-ui-components.md（`cc:` のタブを部品にしない）・web-ui-v3.md（§3.1・§8）・claude-code-*.md の頭に 1 行・CLAUDE.md | なし | なし | revert |
| **H1** 取り込みの土台 | takeover.md v3、DB `cc_takeovers`、規則・記録の写し、`CcTakeover`、前置きの文（#343〜#345 を運ぶ。§3.4 の 1・2・5・7）。配線はしない。2〜3 PR | H0 | なし | コードだけ revert（移行の要素は残す。表は空のまま残る） |
| **H2** 取り込みの入口（Discord） | `/cc take` → 選ぶ → 確認 → 新しいチャンネル、配線、起動時の片付け、断る文（§3.5） | H1 | `/cc take` が使える | revert。取り込み済みの話題は普通の話題として残る |
| **H3** 取り込みの入口（Web）と札 | API 3 ルート、札の部品、確認、`cc:` の行の既定を札に | H2。新しい殻だけに作る | 端末の行を押すと札。［取り込む］ | revert（行は今の［端末］に戻る） |
| **H4a** 質問 | AskUserQuestion を許可の橋 → 質問のカード・ボタン | なし（H1〜H3 と並べてよい） | プロジェクトのセッションが選択肢で訊く | revert（また使えない物に戻る） |
| **H4b** モード | `/mode`、見出しのセレクト、取り込みの前置きとモードの引き継ぎ | H4a。取り込みの側は H2 | `/mode` とセレクト | revert（default 固定に戻る） |
| **H5** ［対応］の付け替え | §3.2。DB `github_topics` | なし（H4 の後が望ましい） | ［対応］で話題ができる。［起動して送る］が無くなる | コードだけ revert（移行の要素は残す。tmux の宛先に戻る。X の前なら戻せる） |
| **使う期間** | コードなし。§4.4 の数を見る | H2〜H5 | — | — |

- DB の移行を足した段（H1・H5）を戻すときは、**移行の要素を消さない**。一度起動して版が進んだ DB は、移行の数がそれより少ないコードでは開けず、起動が止まる【確 `store/db.ts` の `migrate`】

受け入れの確かめ（テストできる形）:
- H0: `npm run check`・`npm test` が通る（文書だけの PR でも走らせる）。`docs/plan/`・CLAUDE.md を「リモコン」「残す」で grep し、リモコンを残すと書いた所が無い
- H1: 単体（一時 SQLite）: v45 の移行、相手の確かめ 5 つが 1 つでも外れたら SIGTERM を送らない、running の間は送信が `taking_over` で断られる。既存のテストが全部通る
- H2: 単体（偽 Gateway）: 選ぶ → 確認 → 新しいチャンネルができ `sessions` に `project_dir` と元の session_id が入る / 実行中・判断待ち・tmux の外・直下でない は断って §3.5 の文 / 既に `cc-…` があれば案内 1 通で完了へ。**実機（利用枠を使う。最初のターン 1 回はキャッシュが全部外れる）**: 待機の端末のセッションを 1 つ取り込み、続きを 1 ターン
- H3: 単体（API）+ `ui-shots`（札の 4 つの状態）。実機: スマホの幅で札 →［取り込む］→ 新しい話題へ移る
- H4a: 単体: 1 問・複数の問・multiSelect・その他 の `updatedInput.answers` の形、時間切れは deny。**実機（利用枠 3 ターンほど）**: 「どちらにするか私に訊いて」
- H4b: 単体: ターンの途中の `/mode` は断る、選べない値は出ない。**実機（利用枠 3 ターンほど）**: default → plan → acceptEdits
- H5: 単体: 地図にある → 話題ができ最初の一言が積まれる / 同じスレッド 2 回目は `already` / 地図に無い → `not_local`。**実機（利用枠 1 ターン）**: 自分の PR の通知で 1 件

### 4.2 消す段

| 段 | 消す物 | 前提 | 見える変化 | 戻し方 |
|---|---|---|---|---|
| **X1** ツール | cc_list・cc_send・cc_start の定義、システムプロンプトの 1 行、`topic_list` の説明の直し、`app/cc-tools.ts`、`commands/cc-confirm.ts` の［送る］［起動する］、あなたの番の該当の行 | 使う期間の条件（§4.4） | 右腕が端末へ送らなくなる | revert（キャッシュがもう 1 回外れる） |
| **X2** Web | ［端末］・「端末を見る」・`cc:` のタブ（`views.js`・`shell.js` の pane）・起動のダイアログ・`GET /api/cc/sessions/<id>`・`/send`・`/api/cc/sends/<id>/cancel`・`POST /api/cc/sessions`・`/unfollow`・`/channel`。`GET /api/cc/sessions`（一覧）と `GET /api/cc/projects` は、呼び手（`api.js` の読み続け・古い殻の起動のダイアログ）を確かめてから消す。`ui-shots` の段 cc の絵を札の絵に | X1。**flip（M8）が済んでいる**（古い殻が同じ API を呼ぶ） | 端末の行は札だけ。端末の許可・質問のカードは Web では `cc-…` の会話のタブにだけ残る（X3 まで） | revert |
| **X3** Discord | `cc/channels.ts`・`channel-posts.ts` の写し・`replies.ts`・`sender.ts`・`starter.ts` の起動・`panes.ts` の残り・`/cc open\|cancel\|close`・`cc:resume`・`cc:unfollow`・`cc:del`・/setup のカテゴリ・history の cc の行・取り込みの守り（§3.4 の 8）・`cc-…` を完了へ移す道（同 2）・`cc-dry-run -- --reset-multiline`。**同じ PR で、hook から来た許可・質問は保留せず、すぐ空の本文を返す**（届け先のチャンネルが無くなるので、誰にも見えない要求を持ち続けない。端末の中でそのまま訊かれる）。決定 1 で「#system に 1 通」を採るなら、この段で作る。先にプロジェクトの検査を別のファイルへ移す PR | X1・X2 | 開いている `cc-…` に「この機能は終わりました」を 1 通出して完了へ（1 回だけ）。`/cc` は take だけ。**端末の許可・質問・判断待ちが Discord・Web に来なくなる**（今は届け先がそのセッションのチャンネルだけで、無ければ log だけ【確 `cc/channel-posts.ts`】） | revert（移したチャンネルは手で戻す） |
| **X4** hook と設定（決定 1 が「消す」のとき） | `cc/hook-server.ts`・hook の側の保留・許可と判断待ちの届けの残り・`cc-setup`・`SELF_AGENT_CC_HOOK_PORT`・`_HOOK_TOKEN`・`SELF_AGENT_CC_NOTIFY`・`_SEND_WAIT_MIN`・`_MAX_SESSIONS`。`SELF_AGENT_CC=1` は tmux が無くても起動する | X3。**先にオーナーが `~/.claude/settings.json` の hooks を外す**（受け口が無いと毎ターン hook のエラーが出る【文 sessions.md §13】） | なし（届けは X3 で止まっている）。一覧の順と判断待ちの種類は `claude agents --json` の状態だけで決まるようになる（hook が書いていた `cc_sessions` の `waiting_kind`・`last_prompt_*`・`last_event*` が更新されない） | revert + hooks を戻す |
| **X5** DB | 表 `cc_sends`・`cc_starts`・`cc_replies`・`cc_channels`・`cc_state` と、使っていない古い `github_handoffs`（v21）を消す。`cc_sessions` の `started_by`・`tmux_session`・`tmux_session_id`・`start_pane_id`・`trust_pending_at`・`channel_id`・`follow*`・`reply_count*`・`notified_at`、`guild_settings.cc_category_id`、`cc_takeovers` の使わなくなった列を落とす | X1〜X4 から 7 日 | なし | **戻せない**。入れる前に DB のファイルを控える |

- 消えた変数が env に残っていても起動は止めない（起動の log に変数名を 1 行）。Bot は常駐なので、設定エラーにして止める方が害が大きい
- `cc_permissions` は消さない。origin hook の行は今ある 30 日の片付けで消える
- 量: `src/` だけで 5 千行前後が消える見込み【推。行数からの概算】。テストも同じ PR で消す
- 受け入れ（X の各段）: `npm run check`・`npm test`・`ui-shots`（X2）が通る。`grep` で消した名前（`CcSender`・`cc_send` など）が `src/`・`docs/directory-structure.md`・`docs/environment.md`・CLAUDE.md に残っていない。プロジェクトのセッションの許可・質問・取り込みの実機の確かめを 1 回ずつやり直す（X3・X4 の後。利用枠 2〜3 ターン）
- X5 の受け入れ: 控えた DB の写しに移行を当てて、`sessions`・`cc_permissions`・`cc_sessions`・`cc_takeovers` の行数が変わらない事を見る（本番に当てる前）

### 4.3 プロンプトキャッシュを 1 回にまとめる
- 全セッションのキャッシュが外れるのは **X1 の再起動の 1 回だけ**にする。ツール 3 つの定義・システムプロンプトの 1 行・`topic_list` の説明（「Claude Code のセッション」→「端末のセッション（取り込み待ち）」）を同じ PR・同じ再起動で入れる【確 `agent/tools.ts`・`system-prompt.ts`】
- その時点で溜まっているシステムプロンプト・ツールの説明の直しがあれば X1 に寄せる。X2〜X5 ではシステムプロンプトとツールに触らない
- H2〜H5 は軽いモードのツールとシステムプロンプトに触らない（取り込み・［対応］に SDK のツールを足さない）
- H4a はプロジェクトのセッションのツールの集合が変わるので、今あるプロジェクトのセッションは次のターンで 1 回外れる見込み【推。§5.2 の 8】
- 取り込みの最初のターンは、その会話だけ全部外れる（設計どおり。1 回）

### 4.4 使う期間
- 長さ: **7 日**（決定 5）。H2〜H5 が全部入ってから数える
- 見る数（DB を読み取り専用で。本文は読まない）: 端末への送信（`cc_sends` の origin ごと）と tmux での起動（`cc_starts`）の件数 / 取り込みの成功・失敗（`cc_takeovers`）/ 端末の許可に Discord・Web から答えた件数（`cc_permissions` の origin hook で via が discord・web）
- 消し始める条件: 期間の後半 3 日に、オーナーが自分で端末へ送った・tmux で起動した件数が 0（GitHub の［対応］由来は H5 で無くなる）。取り込みが 3 回以上通り、困った事の一覧が空か、直す PR が入っている
- この間に §5.2 の 6（tmux の外の出方）をオーナーの手で見る

## 5. オーナーが決める事・未確認

### 5.1 オーナーが決めた事（5 件。2026-11-18。推薦どおり）

| # | 決める事 | 決定 | 理由 |
|---|---|---|---|
| 1 | 端末で直接使っている間の許可・質問を Discord・Web に届ける機能を、最後に消すか残すか | **消す。ただし §4.4 の数で、期間中に Discord・Web から答えたのが週に数件以下のとき。届けが実際に止まるのは X3（届け先のチャンネルを消す段）で、受け口を消すのが X4 なので、残すかどうかは X3 の前に見る。「判断待ちがある」事は一覧と札に出し続ける**（hook が無くても `claude agents --json` で分かる） | 届け先だった `cc-…` のチャンネルが無くなるので、残すなら #system へ戻す作りが新しく要る（残す方が仕事が増える）。端末のセッションは RC につながる設定【文】なので、スマホから答える道は残る。残すと受け口・ポート・トークン・`~/.claude/settings.json` の hooks を持ち続ける。多く使っていたら「#system に 1 通」の形で残す |
| 2 | 取り込み先を新しい普通のチャンネルにし、今ある `cc-…` はその場で変えず完了へ移す | **そうする** | 端末のセッションごとのチャンネルをやめるので、変える元が無くなる。道が 1 つになり X3 が軽い。失う物は `cc-…` の中の履歴との地続き（数日の間だけ） |
| 3 | ［対応］の宛先 | **PR・issue ごとに新しい話題。同じスレッドは同じ話題へ**（§3.2 の A） | 進行中の会話に割り込まない。一覧で追える |
| 4 | tmux の外の生きているセッションを self-agent が終わらせるか | **終わらせない（案内だけ）** | 今は 1 本も無い。止め方が 3 種類とも未確認 |
| 5 | 使う期間と消し始める条件 | **7 日・§4.4 の条件。X5 はさらに 7 日後** | DB の移行だけが戻せない |

ほかの未決（決める人）: 待機しているプロジェクトのセッションを「オーナーの番」に数えるか（オーナー。#338 の側）/ 古い PR #342〜#348 を閉じる時（オーナー）/ 残す関数の移し先のファイル名・札の部品の名前・`github_topics` の列の細部（実装者が決めてよい）。

### 5.2 未確認（試し方と倒し方）
利用枠を使う試しは、オーナーの許しを得てから行う。

| # | 未確認 | 試し方 | だめだったとき | 利用枠 |
|---|---|---|---|---|
| 1 | AskUserQuestion の複数の問・multiSelect・その他を `updatedInput.answers` で返せるか（確認は 1 例だけ）。headless の空答えの不具合 | 3 つの形を 1 回ずつ訊かせる | 通らない形はカードを出さず deny で「文で訊いてください」 | 3 ターン |
| 2 | 会話の途中で permission_mode を変えたときの効き方とキャッシュ | 1 つの話題で 3 つのモードを順に。`npm run usage` で読みを見る | 外れるなら `/mode` の返事に 1 行。効かないなら新しい会話（/renew）のときだけ変える | 3 ターン |
| 3 | plan モードの終わり（ExitPlanMode）が canUseTool に来るか | 2 の中で | 来なければ plan を選択肢から外す | 0 |
| 4 | 取り込んだ会話（端末のシステムプロンプトの記録で動く）で質問・モードが効くか | H4 の後、取り込んだ話題で 1 と同じ | 前置きの「質問は文で」を残す | 2 ターン |
| 5 | 取り込みの R2〜R6（圧縮の後の前置き・大きい記録・サブエージェントの脇・ターン途中の SIGTERM・背景のシェル） | takeover.md §2 のまま | 同 §2 の倒し方 | 各 1〜2 ターン |
| 6 | tmux の外の 3 種類が一覧にどう出るか（kind・cwd） | オーナーが各 1 本起こし、`npm run cc-dry-run` | 見分けられなければ「ペインが引けない = tmux の外」の今の判定のまま | 0 |
| 7 | 取り込んだ後に端末で同じ会話を resume したときの `cc_permissions` の重なり | X4 で hook を消せば起きない。残すなら手で 1 回 | hook の側で Bot の session_id の事象を捨てる | 1 ターン |
| 8 | H4a で今あるプロジェクトのセッションのキャッシュが 1 回外れるか | 入れた後の普段のターンを `npm run usage` で見る | 外れる前提で受け入れる | 0 |
| 9 | ［対応］で始めた話題の最初のターンが、テンプレートの文で止まるべき所で止まるか | 自分の PR の通知で 1 件 | テンプレートの文を直す | 1 ターン |
| 10 | #338 が `cc_channels`・`cc_sends` を読んでいないか | PR の差分を grep | 読んでいれば #338 の側を X3 の前に直す | 0 |

### 5.3 実装への申し送り（H0 のレビューから）
- **H1（takeover.md v3 で決める）**: `cc_takeovers` の `channel_id`・`guild_id` の意味。今の列は NOT NULL で、確認のボタンの照合に使う。取り込み先が「確認の後に作る新しいチャンネル」になると、確認待ちの時点の channel_id が「確認を出した場所」か「行き先」かが決まらない。Web から始めた確認を Discord のどこに出すかも決める。ここを決めずに進むと H2 で 2 本目の移行が要る → 決めた（takeover.md §3.9）
- **H1・H2**: 新しいチャンネルを作る時点。元の設計は SIGTERM の前に取り込み先を確かめる（作れなければ取り込まない）。新しい設計でも、作るのは SIGTERM の前にし、その後で失敗したときの残ったチャンネルの扱いを書く → 決めた（takeover.md §3.1）
- **H2**: 取り込んだ端末のセッションに `cc-…` のチャンネルが在ったとき、`cc_channels` の行の最後の状態を決める（ended のままだと、そこへの発言に［起動して続ける］が出て、同じ session_id が戻ると開き直る） → 決めた（takeover.md §3.2）
- **H5**: `startTopic` の `by` は今 web と right_hand の 2 つ【確 `app/session-ops.ts`】。`github` を足すと区切りの文に触る
- **X5**: 落とす `cc_sessions` の列には index が無く、DROP COLUMN で落とせる見込み【確 `store/db.ts`。レビュー】

## 6. 既存の計画との関係
- **Web UI の部品（K7 以降）**: `cc:` のタブ（［端末］）は部品にしない（web-ui-components.md の「その段で決める」を「作らない」に。`ccComposer` の issue も立てない）。K7（殻の根）は pane の切り替えを古い描き方のまま包んで運ぶだけにし、作り直さない。X2 を K8 より先に入れると、`legacy-views.css` へ移す物が減る。K9 の「1 画面 1 PR」の一覧に `cc:` のタブは元から無い（足さない）。新しく作る部品は札と見出しのモードのセレクトの 2 つ
- **flip（M8）**: H3 は新しい殻だけに作る（古い殻には足さない）。X2 は flip の後。flip が遅れても H0〜H5 と X1 は進められる
- **#338（進行状況）**: 端末のセッションとプロジェクトのセッションの「実行中」を読む【文 PR の本文】。残す側（一覧・`sessions`）だけに頼る見込み（§5.2 の 10）。DB の番号は後から入る方がずらす
- **作業ジョブ（保留）**: 触らない。`SELF_AGENT_JOBS=1` は設定エラーのまま
- **人格**: 2 体目以降の話題は場所なしで始まる【確 `right-hand.ts`】ので、プロジェクトのセッション・取り込み・［対応］は既定の人格だけ。本書で変えない
- **unify.md**: U2 は本書の H4。U3（端末へ戻す向き・`projects` の link）は範囲の外だが、取り込みが本線になると「端末へ戻りたい」の受け皿になるので、H0 でその旨を 1 行足す
- **github-notifications.md**: §5・§6 を H5 の PR で書き換える

## 7. 費用
- 外部サービス: 増えない。**0 円**
- 利用枠: 実機の確かめで合わせて 20 ターン前後（§4.1・§5.2 の計）。全セッションのキャッシュが外れるのは X1 の 1 回
- 機械: 取り込むたびに端末の claude が 1 つ終わる。プロジェクトのセッションはターンの間だけプロセスがあるので、常駐のメモリは減る向き【推】

## 8. 決めた事（本書）
- §5.1 の 5 件（オーナー。2026-11-18）
- 段の順は §4。消す段は X1（ツール）→ X2（Web）→ X3（Discord）→ X4（hook と設定）→ X5（DB）
- 取り込みの列は積み直す（§3.4 の B）。コマンドの名前は `/cc take` のまま（`/cc` に残るのは take だけ）
- `SELF_AGENT_CC`・`cc_permissions`・`cc:perm`・`cc:q`・`/api/cc/permissions` の名前は変えない
- 取り込めないときは断って理由を出すだけ（予約・知らせは作らない）
- 選ばなかった案: リモコンを残して両方を保つ（#428 で決定済み）/ 端末の記録を読んで会話として描く（取り下げ済み）/ `SELF_AGENT_CC` の名前を変える（env の移行が要るだけで得が無い）
