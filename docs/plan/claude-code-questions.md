# Claude Code の質問（AskUserQuestion）に Discord・Web から答え、知らせを #system からセッションのチャンネルへ移す

> 関連 issue は実装のときに立てる。CC1〜CC8 は `docs/plan/claude-code-sessions.md`、CC9〜CC14 は `docs/plan/claude-code-channels.md`。

> 2026-11-05。spec-writer。v1（案）→ **v2（確定版。オーナーの決定 §13.1 を反映）**。`docs/plan/claude-code-channels.md`（確定版。CC9〜CC14 は実装・マージ済み。DB は v37）の上に載せる。
> 「確認」= 2026-11-05 に main（9920cd0）のコードと、この機械の Claude Code 2.1.318 で確かめた事実。「推測」= 確かめていない前提。「未確認」= 実機で確かめるまで前提にしない（§11）。
> セッション名・パス・ID・ポートは書かない。

## 0. 目的・範囲・結論

目的（オーナーの決定。2026-11-05）:
1. **Claude Code の `AskUserQuestion`（選択肢の質問）を、Discord と Web で選択肢のボタンとして出し、押した答えを Claude Code に返す。** 今は質問の JSON が「許可の要求」の要約として [許可][拒否] 付きで出ている（直近 12 件の許可の要求のうち 11 件が AskUserQuestion）。
2. **Claude Code のセッションの知らせ（許可の要求・質問・判断待ち・self-agent が起動したセッションの終了・写しなど）は #system に出さない。** チャンネルが無いセッションで知らせが要ったときに、そのセッションの `cc-` チャンネルを自動で作ってそこに出す（何も起きないセッションには作らない）。
3. **Web の会話のタブの実行中の行を軽くする。** 枠を外し「作業中…（経過・ツール n 回）」の 1 行 + 直近の手順 3 つを薄い文字で、全部の手順は押して開く。

範囲:
- 対象は今の CC1〜CC14 の仕組みの上だけ。hook の受け口・保留・`answered_elsewhere` の検知・チャンネルを作る流れ（`openChannel`）は**変えない**。質問は「許可の要求」の 1 つの形として扱う（§2）。
- 人格は既定の人格だけ。ゲストは対象外。作業ジョブ（PR-J4）は対象外。

結論（決めたこと）:
1. **質問は `cc_permissions` の行のまま扱う**（`tool_name = 'AskUserQuestion'`。種類の列は足さない）。**質問の全体は新しい列 `question_input`（`tool_input` の JSON そのまま。32 KB まで）に持つ**。「`tool_input` の全体を持たない」決まりは、AskUserQuestion だけ例外にする（質問の文そのものが表示する内容で、答えを返すのに `question` の文と `questions` の全体が要るため。§2.2）。
2. **応答は `allow` + `updatedInput`（`tool_input` そのまま + `answers`）**。`answers` は `question` の文をキー、選んだ `label` を値（複数選択は `, ` でつなぐ。「その他」は打った文字列）。**[やめる] は deny**（Claude Code に「答えない」と返す。message は「self-agent（Discord / Web）から断りました」。端末に任せる口は作らない。§2.3）。
3. **Discord は 1 通を 1 問ずつ書き換える**（§3）。選択肢はボタン（4 つまで + [その他]）、複数選択はセレクト + [決める]。[その他] はモーダルの自由入力。1 問だけならボタンを押した時点で答えが返る。答え終わったら答えの行に書き換えてボタンを外す。名前空間は `cc:q:*`。
4. **Web は許可のカードと同じ場所に質問のカード**（ラジオ / チェック / その他の入力・[答える]・[答えない]）。API は `POST /api/cc/permissions/<id>/answer`（[答えない] は今の `/deny`）（§4）。
5. **保留の長さは質問だけ別の変数 `SELF_AGENT_CC_QUESTION_HOLD_SEC`（既定 900、1〜1800）**。`npm run cc-setup` の `PermissionRequest` の timeout は 2 つの大きい方 + 5（§2.4）。
6. **#system は使わない**（§5）。許可の要求・質問・判断待ちは、チャンネルが無ければ `ensureFor`（origin `permission` / `question` / `waiting`）で作ってから出す。終了の知らせはチャンネルがあるときだけ。tmux の外のセッションも知らせの origin ならチャンネルを作る（書くと「送れません」）。作れない（/setup 前・満杯・Discord の失敗）ときは log だけ。`SELF_AGENT_CC_NOTIFY=0` は「知らせのためにチャンネルを作らない・既にあるチャンネルには出す」に意味を変える。`cc/discord-notice.ts` の `CcDiscordNotifier`（#system の経路）は消し、文面の純関数だけ残す。
7. **実行中の行**は `details` の枠を外し、1 行 + 直近 3 手順（薄い文字）+ 「すべての手順（n）」の開閉（§6）。
8. 段: **Q5（実行中の行。独立・小さい）→ Q1（受け口・DB・応答・Web の API）→ Q2（Discord の UI）→ Q3（Web の UI）→ Q4（#system を使わない）**（§8）。DB は Q1 で v38、Q4 で v39。
9. 費用: 外部サービス・依存は増えない（0 円）。増えるのは Discord の API 呼び出し（質問 1 件につき 問の数 + 1 回の書き換え、知らせのためのチャンネルの作成）。

## 1. 確認した事実と推測

### 1.1 Claude Code 2.1.318（確認: 実機。`scratchpad/askq/hook-result.log`）
- `AskUserQuestion` は `PreToolUse` の直後に **`PermissionRequest` の hook として届く**。`tool_input` は `{ questions: [{ question, header, options: [{ label, description }], multiSelect }] }`。
- hook が `{ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { ...tool_input, answers: { "<question>": "<label>" } } } } }` を返すと、**端末のダイアログを出さずにツールが実行され**、`PostToolUse` の `tool_input` に `answers` が入っていた（`PermissionRequest` から 33 ms 後）。
- 公式 docs（hooks.md「Tools that require user interaction」。`PreToolUse` の節）: `answers` は question の文をキーに、選んだ option の label を値に。**複数選択は label をカンマでつなぐ**。「`allow` だけでは足りない（`updatedInput` に答えが要る）」。「Other」（自由入力）の形は書かれていない（推測: 打った文字列をそのまま値に。§11 の 2）。
- `PermissionRequest` の hook の timeout の上限は docs に無い（http hook の既定は 600 秒。§11 の 4）。

### 1.2 コード（確認）
> main（9920cd0）の時点の形。#system の経路（`discord-notice.ts`・`CcDiscordNotifier`・`claims` / `release`・`noticeFailure`・`owns`）は Q4（#270）で消した。今の形は §5 と CLAUDE.md。
- 受け口（`src/cc/hook-server.ts`）: `summarizePermission` は Bash・WebFetch・ファイルのツール以外を `tool_input` の JSON の先頭 500 字にする（`CC_PERMISSION_SUMMARY_MAX_CHARS`）。**`tool_input` の全体は持たない**（`CcPermissionSummary` に無い）。`requestHash` は `tool_name` + `tool_input` の sha256。本文の上限は 1 MB。
- 保留（`src/cc/permission-hold.ts`）: `request` → `cc_permissions` に `pending` → `SELF_AGENT_CC_PERMISSION_HOLD_SEC` 保留。`answer(id, "allow" | "always" | "deny", via, requestHash)` が `pending` からの compare-and-set。`decisionBody` は `allow` に `updatedInput` を付けない。`observe`（Stop・UserPromptSubmit）・`onListed`（status が waiting でない）で `answered_elsewhere`。`listen` は複数の受け手（`claims` / `held` / `resolved`）、`release` で次の受け手へ（Q4 より前の形。Q4 で `claims`・`release` を消し、受け手は `channel-posts.ts` だけ）。
- 表（`src/store/cc-permissions.ts`・`db.ts` v30〜v32）: `state` の CHECK は 7 つ、`via` の CHECK は `web / discord / hook / status / shutdown / limit`。`state` と `via` の CHECK は独立（`released` + `via web` は通る）。`summary`・`always_rules`・`message_id`・`message_channel_id`。1 セッションに `pending` は 1 件（部分一意索引）。
- Discord の 1 通（Q4 より前は `src/cc/discord-notice.ts`、Q4 から `src/cc/notice-text.ts` の `permissionNotice` / `permissionResolvedMessage` / `permissionResultLine`。`src/cc/channel-posts.ts` も同じ関数）: 見出し（名前・ディレクトリ・mode）+ ツール名 + 要約のコードブロック + 常に許可の説明 + 「端末や RC のダイアログでも答えられます（ボタンは n 分効きます）」。1 行目 [許可][常に許可][拒否]、2 行目 [RC で開く]。
- ボタン（`src/app/commands/cc.ts`）: `cc:<種類>:<操作>:<id>` を 2 つ目の語で振り分け（`perm` / `send` / `start` / `keep` / `unfollow` / `pick` / `resume` / `del`）。`cc:perm:*` は `buttons.answer` → `responder.update(resolved.message)`（失敗したら `editMessage`）→ `finally` で `answered`（`ensureFor(permission)`）。
- Discord の部品（`src/discord/gateway.ts`）: `ComponentRow` は `buttons`（1 行 5 個）/ `links` / `select`（1 行 1 つ・25 項目）。1 メッセージ 5 行。`ModalDef` は TextInput 5 個まで（`short` / `paragraph`・`maxLength`）。`Interaction` は `button` / `select`（`values`）/ `modal`（`fields`）。`responder` は `deferUpdate` / `update` / `reply` / `showModal`。
- Web（`src/web/routes/cc.ts`）: `permissionJson` は `id / sessionId / state / via / toolName / summary / alwaysRule / alwaysNote / requestHash / permissionMode / createdAt / expiresAt / resolvedAt`。`POST /api/cc/permissions/<id>/allow|always|deny` は `{ requestHash }` 必須。`views.js` の `ccPermissionCard` は `pending` なら [許可][拒否] と「常に許可」のチェック。
- チャンネル（`src/cc/channels.ts`）: `ensureFor(sessionId, origin, guildId?)` は既にあれば `exists`（終わっていれば開き直す）、無ければ `defaultGuild`（最初のカテゴリ「Claude Code」のあるサーバー）に `openChannel`。作れなければ `not_set_up` / `full` / `failed` を **#system に 1 行（1 時間に 1 回）**（`noticeFailure`。Q4 で消し、log だけにした）。`openChannel` は一覧に無ければ `not_found`、`findSendablePane` が当たらなければ `not_in_tmux`。`cc_channels.origin` の CHECK は 8 つ（`web / command / web_send / web_start / permission / tool_send / tool_start / github`）。
- 知らせの振り分け（`src/main.ts:706-753`）: `CcChannelPosts`（チャンネル）を先に `listen`、`config.ccNotify` なら `CcDiscordNotifier`（#system）を後に `listen`。`ccEndedHandler` はチャンネルも追いかけも無いときだけ notifier の `ended`。`rewriteRecovered` は `owns` で振り分け（Q4 より前の形。Q4 で `CcDiscordNotifier`・`owns` を消した）。
- 実行中の行（`src/web/static/chat.js:535-557`・`app.css:1338-1405`）: `details.steps`（`summary` にスピナー + 「作業中…」、中に全手順の `ol.steps-list`）を Bot の吹き出しの中に。既定は開く（`stepsClosed`）。`.msg-bubble .steps` は `--bubble-inset` の地と枠。

### 1.3 推測・未確認（§11 に集める）
- AskUserQuestion の `questions` は 1〜4 問、`options` は 1 問 2〜4 つ、`header` は 12 字まで（Claude Code のツールの説明。推測。本書は 1〜4 問・2〜8 択まで受け、それ以外は読めない形として扱う）。
- 質問のダイアログが出ている間の `claude agents --json` の `status` は `waiting`（許可のダイアログと同じ。推測。`answered_elsewhere` の検知の前提）。
- セレクトの操作から `showModal` で開いたモーダルの応答で元の 1 通を `update` できる（discord.js。推測）。

## 2. 質問の表現（論点 A・D・E）

### 2.1 比較（行の持ち方）
| | **A: `cc_permissions` の行のまま（`tool_name = AskUserQuestion`）+ 質問の列** | B: `kind` の列（`permission` / `question`）を足す | C: 別の表 `cc_questions` |
|---|---|---|---|
| 保留・検知・1 セッション 1 件・再起動の後始末 | ◎ そのまま効く | ◎ | ✗ 全部を作り直す |
| 「許可の要求」と「質問」の見分け | ○ `tool_name` で分かる（受け口が読む固定の語） | ◎ 列で分かる | ◎ |
| DB の変更 | ◎ 列を 2 つ足す（ALTER） | △ 列 1 つ + CHECK（作り直し） | ✗ |
| Web・Discord の表示の分岐 | ○ `toolName === "AskUserQuestion" && questions !== null` | ○ | ○ |

**A を採る。** `tool_name` が AskUserQuestion でも質問の形が読めない行は、今までどおりの「許可の要求」として出す（§2.2）。

### 2.2 決定（DB と受け口）
- **v38**: `cc_permissions` に `question_input TEXT`（AskUserQuestion の `tool_input` の JSON **そのまま**。読めない形・大きすぎれば NULL）と `answers TEXT`（返した `answers` の JSON。答えたときだけ）を ALTER で足す。CHECK は変えない。
- 受け口（`hook-server.ts`）: `tool_name` が `AskUserQuestion` なら `parseQuestions(tool_input)`（純関数。`cc/questions.ts`）で形を確かめる: `questions` は 1〜4 個の配列、各要素は `question`（1〜2,000 字の文字列）・`header`（省略可。100 字まで）・`options`（2〜8 個の `{ label（1〜200 字）, description?（1,000 字まで） }`）・`multiSelect`（省略可。boolean）。通れば `tool_input` の JSON（`CC_QUESTION_INPUT_MAX_BYTES` = 32 KB 以下）を `questionInput` として事象に乗せる。通らなければ今までどおり（要約は JSON の先頭 500 字）。
  - 要約（`summary`）は質問のときは「質問 n 件: <header か question の先頭 40 字>・…」（500 字まで）にする（一覧のバッジ・log 以外の表示に使う）。
  - 「`tool_input` の全体を持たない」決まりの折り合い: **持つのは AskUserQuestion だけ**（Write の中身のような大きな・秘密になりうる入力は今までどおり持たない）。質問の文は表示する内容そのものなので、持つことで漏れるものが増えない。上限 32 KB（hook の本文の上限 1 MB とは別）。30 日で消える（`prune`）のは今までどおり。
  - `question_input` を**そのまま**持つ理由: `answers` のキーは `question` の文の完全一致（docs）。表示用に切った文をキーにすると当たらない。表示で切るのは画面の側（§3・§4）。
- 保留（`permission-hold.ts`）: `request` は変えない（質問も `pending` で保留。1 セッション 1 件・`answered_elsewhere` の検知・上限・停止はそのまま）。**`answerQuestion(id, answers, via, requestHash)`** を足す: 行が `pending` で保留中・`requestHash` が合う・`question_input` がある・`answers` のキーが `questions` の `question` の集合と一致（`validateAnswers`。§2.3）のときだけ compare-and-set で `allowed`（`via` は `web` / `discord`）にし、`answers` の列を書いて `decisionBody("question", input, answers)` で閉じる。それ以外は `stale`。
- **[やめる]（答えない）**: 今の `answer(id, "deny", via, requestHash)` をそのまま使う（`denied`）。質問の行では deny の message を `CC_QUESTION_DENY_MESSAGE`「self-agent（Discord / Web）から断りました」にする（`decisionBody("deny", { question: true })`）。端末に任せる（`released`）口は作らない（決定 §13.1 の 1）。
- `cc_list`（SDK のツール）・`/api/status` の `pendingPermissions`・`sessionsAnsweredSince`（判断待ちの抑え）は変えない（質問も「許可の要求」として数える）。

### 2.3 決定（応答の形）
- 答え: `{ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { ...<question_input の JSON を parse したもの>, answers } } } }`（`decisionBody` に `"question"` の形を足す。`updatedPermissions` は付けない）。
- `answers`: `{ "<question の文（そのまま）>": "<値>" }`。値は、1 つ選んだら `label` そのまま、複数選択は選んだ `label` を**選択肢の順**に `, ` でつなぐ（docs は「カンマ」。区切りの空白は推測。§11 の 1）、「その他」は打った文字列（前後の空白を除く。1〜1,000 字。改行以外の制御文字は空白に。推測。§11 の 2）。
- `validateAnswers(questions, given)`（純関数）: 問ごとに `{ labels: string[] } | { other: string }` の 1 つ。`labels` は空でなく、どれも `options` の `label` にあり、`multiSelect` でなければ 1 つ。`other` は上の形。全部の問に答えがあり、余計なキーが無い。
- [やめる]: `{ behavior: "deny", message: "self-agent（Discord / Web）から断りました" }`（`interrupt` は付けない = Claude は止まらず、答えが無いまま次の手を考える。許可の [拒否] と同じ形で message だけ違う）。端末のダイアログは閉じる（`Denied by PermissionRequest hook`）。端末で答えたければボタンを押さずに端末で答える（`answered_elsewhere` の検知は今のまま）。

### 2.4 決定（保留の長さ）
| | A: 今の変数のまま（300 秒・上限 600） | **B: 質問だけ別の変数（既定 900・上限 1,800）** | C: 1 つの変数の上限を 1,800 に |
|---|---|---|---|
| スマホで気づいて答えるまで | △ 5 分は短い（許可はダイアログのままでも困らないが、質問は会話の続き） | ◎ 15 分 | ○ 許可も長くなる |
| 設定の数 | ◎ 増えない | △ 1 つ増える | ◎ |
| hook の timeout | ◎ 今のまま | ○ 2 つの大きい方 + 5 | ○ |

**B を採る**（決定 §13.1 の 2）。`SELF_AGENT_CC_QUESTION_HOLD_SEC`（1〜1,800 の整数。既定 900）。`npm run cc-setup -- --print` の `PermissionRequest` の `timeout` は `max(SELF_AGENT_CC_PERMISSION_HOLD_SEC, SELF_AGENT_CC_QUESTION_HOLD_SEC) + 5`。`permissionExpiresAt` は行の `question_input` の有無で長さを選ぶ。時間切れの文は「時間切れ。端末か RC で答えてください <RC のリンク>」（今の許可と同じ）。

## 3. Discord の UI（論点 B）

### 3.1 比較（複数の質問の出し方）
| | A: 1 通に全部の問を並べ、押して選んでから [送る] | **B: 1 通を 1 問ずつ書き換える（答えると次の問）** | C: 1 問 1 通 |
|---|---|---|---|
| 行の数（5 行まで） | △ 4 問 + [送る] の行で 5。[RC で開く] が入らない | ◎ 2〜3 行（選択肢・[やめる]・RC） | ◎ |
| 2,000 字 | △ 4 問 × 4 択 + 説明で超えうる | ◎ 今の問だけ本文に。答えた問は 1 行ずつ | ◎ |
| タップの数（スマホ） | △ 選ぶ + [送る] | ◎ 問の数だけ（1 問なら 1 回） | ○ |
| 選んだ状態の表示 | △ ボタンの色で表す（押すたびに書き換え） | ◎ 無い（押したら次） | ◎ |
| 途中の答えの置き場所 | プロセスの中 | プロセスの中 | プロセスの中 |
| 実装 | △ 選択の切り替え・全部答えたかの判定 | ○ 1 通の書き換えと「次の問」 | △ 通が増え、古いボタンの管理が増える |

**B を採る。** Claude Code は全部の `answers` を一度に受けるので、最後の問に答えた時点で返す。

### 3.2 決定
- 1 通の本文（`questionNotice(row, step, session, options)`。純関数。`cc/questions.ts`）:
  ```
  @owner Claude Code が質問しています: <名前>（<ディレクトリ>・<mode>）
  答え済み: 「<header 1>」<答え>（2 問目以降のときだけ。1 問 1 行）
  質問 <k>/<n>「<header>」
  <question の文（1,000 字まで。超えたら「…」）>
  1. <label（80 字）> — <description（100 字）>
  2. …
  端末や RC のダイアログでも答えられます（ボタンは <n> 分効きます）
  ```
  名前・header・question・label・description は hook から来たデータなので `escapeDiscordText`（`plain`）・メンション無効・`suppressEmbeds`。2,000 字（メンションの分を引く）に収まるまで `description` → `question` の順に末尾を落とす。
- 部品の行:
  | 問の形 | 1 行目 | 2 行目 | 3 行目 |
  |---|---|---|---|
  | 1 つ選ぶ・選択肢 4 つまで | 選択肢のボタン `1. <label>`（`cc:q:pick:<id>:<q>:<o>`。label は 80 字で切る）+ [その他]（`cc:q:other:<id>:<q>`） | [やめる]（`cc:q:drop:<id>`） | [RC で開く]（RC の id が分かるときだけ） |
  | 1 つ選ぶ・選択肢 5 つ以上 | セレクト（`cc:q:sel:<id>:<q>`。min 1・max 1。label 100 字・description 100 字） | [決める]（`cc:q:ok:<id>:<q>`）[その他][やめる] | 同上 |
  | 複数選択 | セレクト（min 1・max = 選択肢の数） | [決める][その他][やめる] | 同上 |
  `<q>`・`<o>` は 0 始まりの添字（整数だけ）。custom_id は 100 字に収まる。
- 流れ（`CcQuestionFlow`。プロセスの中。`cc/question-flow.ts`）: 行 id → `{ answers: Record<question, value>, step }`。
  - [選択肢] / [決める]（選んだものがある）/ モーダルの送信 → その問の答えを記録 → 次の問があれば `responder.update` で次の問の 1 通に → 最後の問なら `permissionHold.answerQuestion(id, answers, "discord")` → 通れば答えの行に書き換え（下）、`stale` なら「この操作は古くなっています」（本人にだけ）。
  - セレクトの操作は `values` を記録して `deferUpdate`（[決める] で確定）。[決める] を選ばずに押したら本人にだけ「選んでください」。
  - [その他] → `showModal`（title「その他（<header の 40 字>）」、TextInput `text`・paragraph・1〜1,000 字・required。custom_id `cc:q:text:<id>:<q>`）。送信（`kind: "modal"`）は同じ経路で記録。
  - [やめる] → `answer(id, "deny", "discord")` → 「答えませんでした（Discord）」に書き換え、ボタンを外す（[RC で開く] は残す）。途中の答えは捨てる。
  - 1 問だけで 1 つ選ぶ形なら、[選択肢] を押した時点で `answerQuestion`（[送る] は無い）。
  - 行が `pending` でない・保留していない・`question_input` が無い・添字が範囲外 → 本人にだけ「この操作は古くなっています」。再起動の後は途中の答えが消えるので、同じく古い（再起動は `pending` を `expired` にするので矛盾しない）。
- 答え終わった 1 通（`questionResolvedMessage`）: 見出しの後ろを「答えました（Discord | Web）: 「<header>」<値>、「<header>」<値>」に。`denied` は「答えませんでした（Discord | Web）」、`answered_elsewhere` は「端末か RC で答えられました」、`expired` は「時間切れ。端末か RC で答えてください <リンク>」、`released` は今の文。押すボタンは外し、[RC で開く] は残す。Web で答えられたものは `resolved` の listener が `editMessage`（今の許可と同じ）。Discord で答えたものは応答で書き換え（失敗したら `editMessage` で代える。今と同じ）。
- 1 通の置き場所: チャンネル（§5。Q4 まではチャンネルがあればチャンネル、無ければ #system。今の許可と同じ振り分け）。`cc_permissions.message_id`・`message_channel_id` に残す。
- 答えた後のチャンネル: `answered`（`ensureFor`）は今までどおり呼ぶ（origin は Q4 までは `permission`、Q4 から `question`）。
- 読めない形（`question_input` が NULL の AskUserQuestion）: 今までどおりの許可の 1 通（[許可][拒否]）に「質問の形を読めませんでした。端末か RC で答えてください」を足す（`allow` だけでは答えにならない見込み。§11 の 3）。
- history（Web の会話。CC14）: 出したら `notice`「質問: 「<header>」<question の 200 字>…（n 問）」、終わったら `notice`「質問の答え: …」（`permissionResultHistoryText` と同じ場所）。

## 4. Web の UI と API（論点 C）

- `GET /api/cc/sessions`・`/api/cc/sessions/<id>`・`/api/cc/permissions`・`/api/channels` の `cc.permission` に **`question`** を足す: `{ questions: [{ question, header, options: [{ label, description }], multiSelect }], answers: { [question]: value } | null } | null`（`question_input` から作る。表示用に切らない（画面が切る）。`question_input` が無ければ `null`）。`expiresAt` は質問の長さで。
- `POST /api/cc/permissions/<id>/answer` `{ requestHash, answers: Array<{ labels: string[] } | { other: string }> }`（問の順）。`requestHash` が文字列でない・`answers` が配列でない・形が違う（`validateAnswers` を通らない）は 400 `bad_request`。`answerQuestion(…, "web")` で 200 `{ state: "allowed" }`、無い id は 404、`stale` は 409。通ったら `answered`（`ensureFor`）。
- [答えない] は今の `POST /api/cc/permissions/<id>/deny`（質問の行では message が「断りました」になる。API は変えない）。
- カード（`views.js` の `ccQuestionCard`。`ccPermissionCard` が `p.question` のあるときに委ねる。`chat.js` の cc のタブと `cc:<sessionId>` のタブで共用）:
  - 保留中: 見出し「質問に答えてください」+ 残り。問ごとに `fieldset`（`legend` に header・問の文は `<p>`。textContent）: 1 つ選ぶ形はラジオ（label と description）、複数選択はチェックボックス、最後に「その他」のラジオ / チェックと 1 行の `textarea`（1,000 字。選ぶと有効）。下に [答える]（secondary）[答えない]（ghost）。全部の問に答えが無ければ [答える] は押せない（`title` に理由）。選んだ状態はタブのメモリ（`ccQuestionDraft`。描き直しでも残す。終わったら消す）。押したら応答が来るまで止め、409 はトースト「この操作は古くなっています」。
  - 終わったもの: 「答えました（Web）: 「<header>」<値>…」/「答えませんでした（Web）」/「端末か RC で答えられました」/「時間切れ…」。
  - 「端末や RC のダイアログでも答えられます」は許可と同じ（PC は `title`、スマホは常設）。
- サイドバーのバッジ「許可待ち」は質問のときは「質問」（`title` に要約）。順は 許可待ち・質問 > 届け待ち > trust > tmux の外（同じ位置）。
- GUIDELINES（`docs/design/WEB-UI-GUIDELINES.md` §5・§7）に「質問のカード」の語彙（答える・答えない）を足す。

## 5. #system を使わない（論点 F）

### 5.1 種類ごとの行き先
| 知らせ | 今 | **これから** | チャンネルが無いとき |
|---|---|---|---|
| 許可の要求（1 通とボタン） | チャンネル → 無ければ #system | チャンネル | `ensureFor(sessionId, "permission")` で作ってから出す |
| 質問（§3） | — | チャンネル | `ensureFor(sessionId, "question")` |
| 判断待ち（60 秒・1 時間 10 件） | チャンネル → 無ければ #system | チャンネル | `ensureFor(sessionId, "waiting")` |
| 「ほかに判断待ちが n 件」 | #system | **出さない**（チャンネルごとの上限の 1 行はそのまま） | — |
| self-agent が起動したセッションの終了 | チャンネル → 追いかけ → 無ければ #system | チャンネル（`ended` の 1 行）か追いかけ | **出さない**（log だけ。終わったセッションにチャンネルを作っても意味が無い。self-agent が起動したものは結びついた時点でチャンネルがある（CC11）） |
| 端末・RC の指示の写し | チャンネルだけ | 同じ | 作らない（決定 3 のまま） |
| 返事（Stop） | チャンネル → 追いかけ | 同じ | 同じ（CC8 の追いかけ） |
| `ensureFor` の失敗（`not_set_up` / `full` / `failed`） | #system に 1 時間 1 回 | **log だけ** | — |
| 複数行の送信が止まった（`multiline_ok`） | #system | #system のまま（運用の知らせ。セッションの知らせではない） | — |
| 終わったチャンネルの削除の確認（`cc:del`） | #system | #system のまま（セッションのチャンネルと同じ扱い。決定 2） | — |
| `cc_send` / `cc_start` の確認 | 頼んだチャンネル | 同じ | — |

- **閉じた（`/cc close`。`ended` でセッションは生きている）チャンネルも、許可の要求・質問・判断待ちで開き直す**（`ensureFor` → `reopenIfListed`。答える場所が要るため。Q4 で確かめた意図どおりの振る舞い）。
- 「何も起きないセッションには作らない」: 作るきっかけは上の 3 つ（許可の要求・質問・判断待ち）と CC11 の「関わった」だけ。一覧に出た・写し・終了・`cc_list` では作らない。
- 作る先: `defaultGuild`（`SELF_AGENT_ALLOWED_GUILD_IDS` の順で最初のカテゴリ「Claude Code」のあるサーバー）。
- **tmux の外のセッション**（RC のサーバーモードなど。`openChannel` が `not_in_tmux` で断る）: 知らせの origin（`permission` / `question` / `waiting`）のときは **tmux の外でも作る**（`create` の `findSendablePane` の確かめを飛ばす）。そのチャンネルへの発言は `sender.submit` が `not_in_tmux` で断るので、返信で「このセッションは tmux の外なので、ここからは送れません（RC で開いてください）」（最初の投稿にも同じ 1 行）。許可の応答は hook なので tmux の外でも効く（未確認。§11 の 6）。決定 §13.1 の 3。
- 作れないとき（/setup 前・満杯・Discord の失敗・一覧に無い）: **log だけ**（「Claude Code: 知らせのチャンネルを作れませんでした（<理由>）」。同じ理由は 1 時間に 1 回）。保留は続き、Web のカードと端末・RC で答える。自動の再試行はせず、次の知らせでまた試す。
- 順序: 保留を始めたら（`held`）→ `ensureFor` を待つ（`layoutQueueKey` のキュー。数秒）→ 開いているチャンネルに 1 通 → `setMessage`。`ensureFor` の間に終わっていれば（Web・端末で答えられた）投稿の後に書き換える（今の `postPermission` の末尾と同じ）。`ensureFor` が失敗したら出さない（`release` で #system に落とす経路は**消す**）。
- `SELF_AGENT_CC_NOTIFY`: **意味を「知らせのためにチャンネルを自動で作るか」に変える**。`0` なら許可・質問・判断待ちでチャンネルを作らず、チャンネルが無ければ Discord には出さない（Web と端末・RC だけ）。既にあるチャンネルには `0` でも出す（今の規則のまま）。「関わった」で作るのは `0` でも変えない（CC11）。README・CLAUDE.md の説明を直す。
- `cc/discord-notice.ts`: `CcDiscordNotifier` のクラス（#system の 1 通・判断待ち・「ほか n 件」・終了）を**消し**、文面の純関数（`permissionNotice`・`permissionResultLine`・`permissionResolvedMessage`・`waitingNotice`・`dueWaitingViews`・`noticeSessionOf`・`CcWaitBudget`・`endedNotice`）を `cc/notice-text.ts` に移す（`channel-posts.ts`・`channels.ts`・`commands/cc.ts` の import を直す）。`waitingOverflowText` は消す。
- `permission-hold.ts`: 受け手が 1 つになるので `claims` / `release` / `claimedBy` / `released` を**消す**（`listen` は 1 つ。`held` / `resolved` だけ）。`rewriteRecovered` は channel-posts だけ（`owns` は不要）。
- `channels.ts`: `noticeFailure` と deps の `notify` を消す。`ccEndedHandler` の `notifier` を消す。`cc_channels.origin` に `question`・`waiting` を足す（**v39**。CHECK の変更なので表の作り直し。v37 の `cc_sends` と同じ手順）。最初の投稿のきっかけの文: 「許可の要求で」「質問で」「判断待ちの知らせで」。
- `main.ts`: `ccNotifier` と `config.ccNotify` の分岐を消し、`CcChannelPosts` に `channels`（`ensureFor`）と `ccNotify` を渡す。`SystemNotifier` は cc には渡さない（`multiline_ok` の sender だけ残る）。
- `/api/status`・`/api/notices` は変えない。

### 5.2 比較（作れないときに #system を残すか）
| | A: 作れないときだけ #system に出す | **B: 出さない（log だけ）** |
|---|---|---|
| 気づける | ◎ | △ Web のカード・端末のダイアログで分かる |
| #system を使わない決定 | ✗ 例外が残る | ◎ |
| 実装 | △ 2 つの経路を残す | ◎ 1 つ |

**B を採る**（オーナーの決定 2 のとおり）。

## 6. 実行中の行の軽量化（論点 G）

- 構造（`chat.js` の `renderRunning`）: Bot の吹き出しの中に
  1. `div.run-line`: スピナー + `[data-run-progress]` の「作業中…（m 分 s 秒・ツール n 回）」（1 秒で刻む数字は今のまま）。
  2. `ol.run-recent`: 直近 3 つの手順（最後が `is-current`）。手順が無ければ「まだ手順はありません」の 1 行。
  3. 手順が 4 つ以上あるときだけ `details.steps.steps-plain`: `summary`「すべての手順（n）」+ 全部の `ol.steps-list`。**既定は閉じる**（`stepsClosed` は「開いたチャンネル」の集合 `stepsOpened` に反転。タブのメモリ）。
  4. [中断]（`msg-actions`）は今のまま。
- CSS（`app.css`）: `.msg-bubble .run-line` は枠・地なし、`color: var(--text)`、`font-size: var(--font-sm)`。`.run-recent` は `color: var(--text-muted)`・`font-size: var(--font-sm)`・`list-style: none`・`padding-left: var(--space-5)`・`overflow-wrap: anywhere`、`li.is-current` は `--text-secondary`。`.steps-plain` は `background: none; border: 0`、`summary` は `--text-muted` の 1 行（chevron だけ）。`.steps-list` の `border-top` は `.steps-plain` では消す。終わった返事の `summary.is-done` などの色は変えない（終わった行は今のまま `details.steps` を使う）。
- 動き: 描き直しでは `run-line` の文字だけ変える（今の `data-run-progress` の仕組み）。手順の差分は描き直す（今と同じ）。
- GUIDELINES §4（部品）の「実行中の行」の記述を直し、`docs/plan/web-ui-polish.md` に UI-12 として足す。

## 7. 安全

1. 入口は Web（認証 + CSRF の 3 条件）と Discord（オーナー・許可サーバー・整数の id・添字）。**答えを返すのはオーナーの操作のときだけ**（自動で答える経路は書かない。テストで、押さずに時間が経ったときの応答が空の本文であることを確かめる）。
2. `updatedInput` は `question_input`（DB の行）から作り、custom_id・Web の本文からは `questions` を受け取らない（添字と値だけ）。`labels` は行の `options` にあるものだけ、`other` は 1,000 字・制御文字なし。`answers` のキーは行の `question` の文だけ（余計なキーは `stale`）。
3. 先に答えた方が勝つ（`pending` からの compare-and-set。Web と Discord・端末）。途中の答え（Discord）はプロセスの中だけで、行が終われば捨てる。
4. hook 由来の文字列（question・header・label・description・名前）はデータ: Discord は `escapeDiscordText`・メンション無効・埋め込みなし、Web は textContent。モーダルの入力（オーナーの文字列）も `answers` の値としてそのまま返すだけで、log には出さない。
5. `question_input` は 32 KB まで・AskUserQuestion だけ・30 日で消す。log は「Claude Code: 質問（#id）→ <状態>（<経路>）」と件数だけ（問の文・答え・セッションの ID は出さない）。
6. 知らせのためのチャンネルの作成は許可サーバー・/setup 済み・1 セッション 1 つ・50 の上限のまま。作れなくても保留・Web は止めない。
7. 偽の hook（確定版 §7 の 11）: 一覧に無いセッションの `PermissionRequest` は保留しない（今のまま）。偽の質問で作られるチャンネルは一覧にあるセッションの分だけ。

## 8. 段（PR 単位）と受け入れ（論点 H）

| 段 | 内容 | 受け入れ（単体: `npm test`。偽 Gateway・偽 registry・一時 SQLite） | 実機（オーナー） |
|---|---|---|---|
| **Q5** 実行中の行 | `chat.js` の `renderRunning`・`app.css`・GUIDELINES・web-ui-polish.md（§6）。API の変更なし | JS は `node --check`。`index.html` に inline 無し。既存の web のテストが通る | スマホの会話のタブで、作業中の行が 1 行 + 薄い 3 行になり、「すべての手順」を押すと全部出る。[中断] が効く。終わると「完了（…）」の行になる |
| **Q1** 受け口・DB・応答・Web の API | v38・`cc/questions.ts`（`parseQuestions`・`validateAnswers`・`answersOf`・`questionSummary`。純関数）・`hook-server.ts`（`questionInput`）・`CcPermissionStore`（列・`setAnswers`）・`permission-hold.ts`（`answerQuestion`・質問の deny の message・`decisionBody("question")`・`permissionExpiresAt` の長さ）・`config.ts`（`SELF_AGENT_CC_QUESTION_HOLD_SEC`）・`cli/cc-setup.ts`（timeout）・`routes/cc.ts`（`question` の項目・`/answer`）。Discord・Web の画面は変えない（画面は今の許可のカードのまま。[許可] は質問では `stale`（`question_input` のある行の `answer("allow")` は断る）） | 形の合う `tool_input` が `question_input` に入り、合わない・33 KB は NULL で今までどおり。`answerQuestion` が `updatedInput`（`tool_input` そのまま + `answers`）の JSON を返し、複数選択は `, `、`other` は文字列。キーの不足・余計・無い label・`multiSelect` でない 2 つは `stale`。質問の行の `deny` は message が「断りました」。時間切れは質問の長さ。`cc-setup` の timeout が大きい方 + 5。押さなければ空の本文（自動の allow が無い）。`/answer` の 400 / 404 / 409 / 200 | `npm run check`・`npm test`。実機は Q3 で |
| **Q2** Discord の UI（済。#268） | `cc/question-flow.ts`（途中の答え）・`notice-text`（`questionNotice`・`questionResolvedMessage`。Q4 で `discord-notice.ts` から `notice-text.ts` に移した）・`channel-posts.ts`（質問は `questionNotice`、終わりは `questionResolvedMessage`）・`commands/cc.ts`（`cc:q:pick|sel|ok|other|text|drop`。モーダル・セレクト）・history の文 | 1 問 1 択はボタンで即答え、2 問は 1 通目 → 書き換え → 2 問目 → 答えの行。複数選択はセレクト + [決める]、選ばずに [決める] は本人にだけ。[その他] のモーダルの文字列が値。[やめる] で `denied`（message は「断りました」）。Web で先に答えられたら `editMessage` で答えの行。再起動の後のボタンは古い。読めない形は許可の 1 通 + 注記。本文が 2,000 字に収まる（長い description・question を落とす）。名前・問の文がエスケープされる | 端末で `AskUserQuestion` を 1 問・4 問・複数選択で出させ、スマホで答える → `PostToolUse` に `answers`（`npm run cc-dry-run` は使わず、端末の記録で確かめる）。「その他」の文字列が Claude に渡る。[やめる] で端末に `Denied by PermissionRequest hook` と「断りました」が出て Claude が進む |
| **Q3** Web の UI | `views.js` の `ccQuestionCard`・`chat.js`・`sidebar.js` のバッジ・GUIDELINES §5・§7 | `node --check`・inline 無し。既存の `web-cc*.test.ts` が通る | Web の会話のタブ（チャンネルあり）と `cc:` のタブで質問のカードが出て、ラジオ / チェック / その他で答える。Discord で先に答えたらカードが「端末か RC で…」ではなく「答えました（Discord）」になる |
| **Q4** #system を使わない（済。#270） | v39（`cc_channels.origin`）・`channel-posts.ts`（`ensureFor` → 1 通。判断待ちも）・`channels.ts`（`noticeFailure` 削除・tmux の外の知らせの origin・最初の投稿の文）・`permission-hold.ts`（`claims` / `release` 削除）・`discord-notice.ts` → `notice-text.ts`（クラス削除）・`main.ts`・`config.ts`（`ccNotify` の説明）・README・CLAUDE.md | チャンネルの無いセッションの `PermissionRequest` で `cc_channels`（origin `permission`）ができ 1 通がそこに出る。質問は `question`、60 秒の判断待ちは `waiting`。`not_set_up` / `full` / `failed` / tmux の外（判断待ちは作る）では #system に何も出ず log だけ、保留は続く。終了はチャンネルがあるときだけ。`NOTIFY=0` ではチャンネルを作らず、あるチャンネルには出る。`SystemNotifier` を cc が呼ばない（`multiline_ok` を除く）。既存の `cc-discord-notice.test.ts` は純関数の分だけ残す | `/setup` 済みで、チャンネルの無い端末のセッションで `npm test` の許可 → `cc-<名前>` ができて 1 通。答える → そのチャンネル。#system に出ない。RC のサーバーモードのセッション（あれば）の質問 → チャンネルができ、書くと「送れません」 |

### 8.1 issue の題名案と触るファイル（implementer に渡す単位）

| 段 | issue の題名案 | 触るファイル |
|---|---|---|
| Q5 | Web の会話の実行中の行を軽くする（1 行 + 直近 3 手順・全部は開閉） | `src/web/static/chat.js`（`renderRunning`・`stepsOpened`）・`src/web/static/app.css`・`docs/design/WEB-UI-GUIDELINES.md` §4・`docs/plan/web-ui-polish.md`（UI-12） |
| Q1 | Claude Code の AskUserQuestion を質問として受け、答えを返す口（DB v38・保留・Web の API） | `src/store/db.ts`（v38）・`src/store/cc-permissions.ts`・`src/cc/questions.ts`（新規）・`src/cc/hook-server.ts`・`src/cc/permission-hold.ts`・`src/config.ts`・`src/cli/cc-setup.ts`・`src/web/routes/cc.ts`・`test/cc-questions.test.ts`（新規）・`test/cc-permissions.test.ts`・`test/cc-hook-server.test.ts`・`test/cc-store.test.ts`・`test/cc-cli.test.ts`・`test/web-cc.test.ts`・README・CLAUDE.md |
| Q2 | Claude Code の質問に Discord の選択肢のボタンで答える（1 通を 1 問ずつ・その他はモーダル） | `src/cc/question-flow.ts`（新規）・`src/cc/questions.ts`（文面）・`src/cc/discord-notice.ts`（Q4 までここ）・`src/cc/channel-posts.ts`・`src/app/commands/cc.ts`・`src/main.ts`（`ccPermissionButtons`）・`test/cc-command.test.ts`・`test/cc-channel-posts.test.ts`・`test/cc-questions.test.ts`・CLAUDE.md |
| Q3 | Claude Code の質問に Web のカードで答える | `src/web/static/views.js`（`ccQuestionCard`）・`src/web/static/chat.js`・`src/web/static/sidebar.js`・`src/web/static/app.css`・`docs/design/WEB-UI-GUIDELINES.md` §5・§7・CLAUDE.md |
| Q4 | Claude Code の知らせを #system に出さず、セッションのチャンネルを自動で作って出す（DB v39） | `src/store/db.ts`（v39）・`src/store/cc-channels.ts`・`src/cc/channel-posts.ts`・`src/cc/channels.ts`・`src/cc/permission-hold.ts`・`src/cc/discord-notice.ts` → `src/cc/notice-text.ts`・`src/app/commands/cc.ts`（import）・`src/main.ts`・`src/config.ts`（`ccNotify` の説明）・`test/cc-channel-posts.test.ts`・`test/cc-channels.test.ts`・`test/cc-channels-store.test.ts`・`test/cc-discord-notice.test.ts` → `test/cc-notice-text.test.ts`・`test/cc-permissions.test.ts`・README・CLAUDE.md |

順序: **Q5 → Q1 → Q2 → Q3 → Q4**（Q5 は独立で、いつでもよい。Q3 と Q4 は入れ替えてもよい）。どの段もツール集合・システムプロンプトを変えない（**キャッシュは外れない**）。各段の PR で README・CLAUDE.md・本書の「済」を直す。

## 9. DB（v38〜）

| 版 | 段 | 変更 |
|---|---|---|
| v38 | Q1 | `ALTER TABLE cc_permissions ADD COLUMN question_input TEXT; ALTER TABLE cc_permissions ADD COLUMN answers TEXT;`（`question_input` は AskUserQuestion の `tool_input` の JSON そのまま（32 KB まで。読めない形は NULL）、`answers` は返した `answers` の JSON。CHECK は変えない） |
| v39 | Q4 | `cc_channels` の作り直し（`origin` の CHECK に `'question'`・`'waiting'`。v37 の `cc_sends` と同じ手順: `cc_channels_new` → `INSERT … SELECT` → `DROP` → `RENAME` → 一意の部分索引 `cc_channels_session` と `cc_channels_guild` を同じ定義で） |

- `CcPermissionStore`: `add` に `questionInput?`、`setAnswers(id, answers)`、`CcPermissionRow` に `questionInput: string | null`・`answers: Record<string, string> | null`（読むときに形を確かめ、違えば null）。`prune` は変えない。
- 版の番号は目安（`MIGRATIONS.length` で確かめる）。移行の前の控え（`self-agent.db.v37.bak` など）は今の仕組みのまま。

## 10. 設定（環境変数）

| 変数 | 変更 |
|---|---|
| `SELF_AGENT_CC_QUESTION_HOLD_SEC` | **新規**（Q1）。質問（AskUserQuestion）の応答を保留する秒数（1〜1,800 の整数。既定 900）。この間に Discord・Web で答えなければ空の本文を返す（端末・RC のダイアログはそのまま）。`npm run cc-setup` の `PermissionRequest` の timeout は `max(許可, 質問) + 5` |
| `SELF_AGENT_CC_PERMISSION_HOLD_SEC` | 変更なし（許可の要求だけに効く） |
| `SELF_AGENT_CC_NOTIFY` | **意味を変える**（Q4）。`0` なら許可の要求・質問・判断待ちのために Claude Code のチャンネルを自動で作らず、チャンネルが無ければ Discord に出さない（Web と端末・RC で答える）。既にあるチャンネルには `0` でも出す。「関わった」で作るのは変えない。#system には `1` でも出ない |

## 11. 未確認（実機で確かめること）

1. 複数選択の `answers` の区切り（`, ` か `,`）。`PostToolUse` の `tool_input.answers` と Claude の返事で確かめる（Q2 の実機）。
2. 「その他」（自由入力）の値の形（打った文字列をそのまま値に。Claude が自由入力として読むか）。
3. 読めない形の AskUserQuestion に `allow` だけを返したとき何が起きるか（ダイアログが出るか・エラーか）。§3.2 の注記の文を直す材料。
4. `PermissionRequest` の hook の timeout が 600 秒を超えても効くか（質問の保留 900 秒）。効かなければ上限を 595 に下げる（決定 §13.1 の 2 の但し書き）。
5. セレクトの操作から `showModal` で開いたモーダルの応答で、元の 1 通を `update` できるか（できなければ `editMessage` で代える。`commands/cc.ts` は今もその代替を持つ）。
6. tmux の外のセッション（RC のサーバーモード）の `PermissionRequest` に hook の応答が効くか（確定版 §12 の 7。Q4 の「tmux の外でも作る」の前提）。
7. 質問のダイアログが出ている間の `claude agents --json` の `status` が `waiting` か（`answered_elsewhere` の `status` の検知）。
8. AskUserQuestion の `options` の上限（4 と推測）。5 つ以上が来たらセレクトに落ちることを確かめる。

## 12. 実装の分解

### 12.1 DB（`src/store/`）
| ファイル | 変更 | 段 |
|---|---|---|
| `db.ts` | v38（2 列の ALTER）、v39（`cc_channels` の作り直し） | Q1・Q4 |
| `cc-permissions.ts` | `questionInput`・`answers` の列と `setAnswers`、`add` の `questionInput?` | Q1 |
| `cc-channels.ts` | `CcChannelOrigin` に `question`・`waiting` | Q4 |

### 12.2 Claude Code（`src/cc/`）
| ファイル | 変更 | 段 |
|---|---|---|
| `questions.ts`（新規） | 純関数: `parseQuestions(toolInput) → CcQuestion[] \| undefined`、`CC_QUESTION_INPUT_MAX_BYTES`、`questionSummary(questions)`（要約の文）、`validateAnswers(questions, given) → Record<string, string> \| undefined`（`, ` の連結・`other` の検証）、`questionNotice(row, step, session, options)`・`questionResolvedMessage`・`questionResultLine`（Discord の文面。2,000 字に収める）、`questionHistoryText` / `questionResultHistoryText`、`questionCustomId(action, id, q?, o?)` | Q1・Q2 |
| `question-flow.ts`（新規） | `CcQuestionFlow`: 行 id → 途中の答えと今の問（プロセスの中）。`pick(id, q, value)`・`select(id, q, values)`・`current(id)`・`complete(id) → answers \| undefined`・`drop(id)`。`permission-hold.ts` の `resolved` で消す | Q2 |
| `hook-server.ts` | `CcPermissionSummary` に `questionInput?: string`（AskUserQuestion で形が通ったときだけ）。要約は `questionSummary` | Q1 |
| `permission-hold.ts` | `answerQuestion`・`CC_QUESTION_DENY_MESSAGE`（質問の行の deny）・`decisionBody("question", input, answers)`・`answer("allow")` は `question_input` のある行で `stale`・`permissionExpiresAt(row, holdSec, questionHoldSec)`。Q4 で `claims` / `release` / `claimedBy` / `released` を削除 | Q1・Q4 |
| `channel-posts.ts` | 質問なら `questionNotice` / `questionResolvedMessage`（`resolvedMessage` も）。Q4 で `held` を `ensureFor` → 投稿に、`checkWaiting` でチャンネルの無いセッションも `ensureFor("waiting")` → 投稿、`release` の deps を削除、`ccNotify` の deps | Q2・Q4 |
| `discord-notice.ts` → `notice-text.ts` | Q4 で `CcDiscordNotifier` を削除し純関数だけ残して改名（`CcWaitBudget` も） | Q4 |
| `channels.ts` | `noticeFailure`・`notify` の削除、`create` の tmux の確かめを知らせの origin では飛ばす、最初の投稿の文（origin の語・tmux の外の 1 行）、`ccEndedHandler` の `notifier` の削除、`handleMessage` の tmux の外の返信 | Q4 |

### 12.3 アプリ（`src/app/`・`src/main.ts`・`src/config.ts`・`src/cli/`）
| ファイル | 変更 | 段 |
|---|---|---|
| `config.ts` | `ccQuestionHoldSec`（`SELF_AGENT_CC_QUESTION_HOLD_SEC`）。Q4 で `ccNotify` の説明 | Q1・Q4 |
| `cli/cc-setup.ts` | timeout を `max(…) + 5` | Q1 |
| `commands/cc.ts` | `cc:q:*`（button・select・modal）。`CcPermissionButtons` に `answerQuestion`・`flow`（deny は今の `answer`） | Q2 |
| `interactions.ts` | 変更なし（`cc:` は既に受ける。modal の `cc:q:text` も `custom_id` の名前空間で同じ振り分け） | — |
| `main.ts` | `ccPermissionButtons` に質問の口。Q4 で `ccNotifier` の削除・`CcChannelPosts` に `channels` と `ccNotify` | Q2・Q4 |

### 12.4 Web（`src/web/`）
| ファイル | 変更 | 段 |
|---|---|---|
| `routes/cc.ts` | `permissionJson` に `question`、`/answer`、`expiresAt` の長さ | Q1 |
| `routes/channels.ts` | `cc.permission` は `permissionJson` を通すので変更なし | — |
| `static/views.js` | `ccQuestionCard`・`ccPermissionCard` の委ね | Q3 |
| `static/chat.js` | `renderRunning`（Q5）。質問のカード（Q3）は `ccPermissionCard` 経由で変更なし | Q5 |
| `static/sidebar.js` | バッジ「質問」 | Q3 |
| `static/app.css` | `.run-line`・`.run-recent`・`.steps-plain`（Q5）、質問のカード（Q3） | Q5・Q3 |

### 12.5 テスト（`test/`）
| ファイル | 変更 | 段 |
|---|---|---|
| `cc-questions.test.ts`（新規） | `parseQuestions`（形・上限・4 問・2〜8 択）・`validateAnswers`（連結・other・不足・余計）・`questionNotice`（2,000 字・エスケープ・行の数）・`questionResolvedMessage` | Q1・Q2 |
| `cc-permissions.test.ts` | `answerQuestion`・質問の deny の message・`decisionBody("question")`・時間切れの長さ・自動の allow が無い・`allow` は質問で `stale` | Q1 |
| `cc-hook-server.test.ts` | AskUserQuestion の `questionInput`・33 KB・読めない形 | Q1 |
| `cc-store.test.ts` | v38 の列・`setAnswers` | Q1 |
| `cc-cli.test.ts` | `cc-setup` の timeout | Q1 |
| `web-cc.test.ts` | `question` の項目・`/answer`・質問の `/deny` | Q1 |
| `cc-command.test.ts` | `cc:q:*` の流れ（1 問・複数の問・セレクト・モーダル・やめる・古い） | Q2 |
| `cc-channel-posts.test.ts` | 質問の 1 通と書き換え（Q2）。Q4 で `ensureFor` → 投稿・作れないとき log だけ・判断待ちの作成・`NOTIFY=0`・tmux の外 | Q2・Q4 |
| `cc-discord-notice.test.ts` | Q4 で純関数の分だけ `cc-notice-text.test.ts` に | Q4 |
| `cc-channels.test.ts`・`cc-channels-store.test.ts` | v39 の origin・tmux の外の作成・最初の投稿の文・`noticeFailure` が無い | Q4 |
| `web-channels.test.ts` など | `renderRunning` は JS なので `node --check` だけ | Q5 |

## 13. 本書で決めたこと・実装者が決めてよいこと

### 13.1 決定事項（オーナー。2026-11-05）
1. **質問の [やめる] は deny**（Claude Code に「答えない」と返す。message は「self-agent（Discord / Web）から断りました」）。端末に任せる（`released`）口は作らない（§2.3）。
2. **質問の保留は別の変数 `SELF_AGENT_CC_QUESTION_HOLD_SEC`（1〜1,800、既定 900）**（§2.4・§10）。
3. **tmux の外のセッションも、知らせの origin（`permission` / `question` / `waiting`）ならチャンネルを作って出す**（そのチャンネルに書くと「送れません」。§5.1）。

### 13.2 本書で決めたこと・実装者が決めてよいこと

本書で決めたこと（§13.1 の下で）: 質問は `cc_permissions` の行（列 2 つ）、`question_input` は `tool_input` そのまま 32 KB、応答は `allow` + `updatedInput`、[やめる] は deny（message「断りました」。端末に任せる口は作らない）、保留は別の変数（既定 900・上限 1,800）、Discord は 1 通を 1 問ずつ書き換え（ボタン 4 + [その他]・5 つ以上と複数選択はセレクト + [決める]・1 問 1 択は即答え）、`cc:q:*` の名前空間、Web のカードと API の形、#system の経路の削除と 3 つの知らせの origin、作れないときは log だけ、tmux の外でも知らせのチャンネルは作る、`NOTIFY=0` の意味、終了はチャンネルがあるときだけ、実行中の行の構造（1 行 + 3 + 開閉）、段の切り方と順序。

実装者が決めてよいこと: 関数・列の名前の細部、`CC_QUESTION_INPUT_MAX_BYTES` の置き場所、本文を 2,000 字に収めるときの落とし方の細部、セレクトの placeholder・モーダルの title の文、Web のカードの並び（ラジオの前後）、`run-recent` の行間・色の変数の選び方、v39 の作り直しの手順の細部、history の文の細部、log の文の細部。

## 14. 費用
- 外部サービス: 増えない（0 円）。依存: 増えない。常駐: 増えない。
- Discord の API 呼び出し: 質問 1 件につき 1 通 + 問の数の書き換え（セレクトの `deferUpdate` を含めても問ごとに 2 回まで）、知らせのためのチャンネルの作成（セッションごとに 1 回）。#system の投稿はその分減る。
- オーナーの手間: env に `SELF_AGENT_CC_QUESTION_HOLD_SEC`（任意）、`npm run cc-setup -- --print` の出し直しを `~/.claude/settings.json` に写す（timeout が変わる）、再起動（キャッシュは外れない）。
