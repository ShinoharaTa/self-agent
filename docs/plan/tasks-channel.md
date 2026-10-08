# #tasks をタスク専用の会話チャンネルにする

> 2026-10-08。オーナーの決定:「#tasks はタスク専用の会話」「会話の切り替えは #inbox と同じく要約して引き継ぐ」「削除は作らず、やめる（dropped）で代える」「タスク以外の話題は 1 行で案内する」。
> 調べた対象は段 1 の PR（#44〜#54）と #56。

## 0. 目的
- 「やることを忘れない・整理する・始められる」を、スマホから短い往復で済ませる場所を作る。
- #inbox は「思いつきを投げる入口」、#tasks は「溜まったタスクを見直して、今日の 1 つを決める場所」。

## 1. コードで確認した事実 / 推測
事実:
- `access.ts` の resolver は #inbox とセッションしか返さない。今は #tasks の発言は無視される。
- `/setup` は #tasks を topic「タスクの一覧」で作る。topic は作成時にしか設定しない（既存の #tasks は変わらない）。
- `sdk-runner.ts` は `kind === "session"` 以外を 8 手順・`SELF_AGENT_TURN_TIMEOUT_SEC` にする。kind を足せば #inbox と同じ上限になる。
- `queue.ts` の枠は「セッションかそれ以外か」の 2 種。セッション以外は全枠を使える。
- `tools.ts` の project_open は `context.kind === "inbox"` だけを弾く。kind "tasks" を足すと #tasks でプロジェクトを作れてしまう（要修正）。
- `turn.ts` の resumeSeed はセッション以外に「直近の #inbox の要約」を入れる。#tasks にも入ってしまう（要修正）。
- `handler.ts` はセッション以外のヘッダを `#inbox` にする（要修正）。
- session_open は resolver が "inbox" のときだけ動く。#tasks では自動で not_available。
- `store/tasks.ts` の toTask は "done" 以外を "open" に読む。status を足すならここも直す。status 列に CHECK 制約は無い（マイグレーション不要）。
- `usage_log` に key ごとの時刻と最後のステップの入力（contextTokens）がある。#tasks の切り替えは列を足さずに判定できる。
- #56 は「書き方」の行を変え、「このアプリについて」に「#tasks: まだ役割が無い。」を足している。
推測・未確認:
- 追加するツール定義のトークン数（推定 300〜400）。`npm run measure` で実測する。
- システムプロンプトの変更で既存セッションのキャッシュは外れない（CLAUDE.md の規則どおりなら）。

## 2. 受け付けと SDK セッション
決定: 新しい kind "tasks" を足し、会話の切り替えは #inbox と同じく要約して引き継ぐ。
- `ChannelKind` と `RunContext.kind` に "tasks" を足す。resolver は guild_settings の tasksChannelId なら "tasks"（/setup 前の env の fallback には #tasks は無い）。
- 上限は #inbox と同じ（8 手順・`SELF_AGENT_TURN_TIMEOUT_SEC`）。途中経過・[中断]・[続ける] は付けない。
- 同時実行はセッション以外のジョブ。セッションが動いている間は #inbox と予備の 1 枠を取り合う（#tasks のターンは短いので許容）。
- 切り替え: `inbox-rotate.ts` を一般化し、/setup 済みのサーバーの #inbox と #tasks の両方に同じ規則を当てる（スケジューラの tick で、チャンネルごとに発言と同じキューで行う）。
  - 毎日 `SELF_AGENT_INBOX_ROTATE_AT` を過ぎたら、または直近の成功したターンの最後のステップの入力が `SELF_AGENT_INBOX_MAX_INPUT_TOKENS` を超えたら: 要約を頼むターン → 要約を保存 → SDK セッションを捨てる → 要約を seed に → 切り替えた日と時刻を記録 → そのチャンネルに知らせる。
  - 前回の切り替えから会話が無ければ LLM を呼ばずに日付と時刻だけ記録。記録が NULL（初回）は基準の時刻を記録するだけ（#inbox と同じ）。会話の記録が切れていたら要約せずに切り替え、直近の同じチャンネルの要約を seed に。それ以外の失敗は何も変えず 1 時間はやり直さない。
  - #tasks の要約の頼み方: 「会話を新しくするので、ここまでの #tasks のやり取りのうち、今後も必要なこと（相談の途中のこと・決めた方針・約束）だけを 600 字以内の箇条書きで返答してください。タスクの一覧は DB にあるので書き写さないでください。ツールは使わないでください。」
  - #tasks の seed: 「これまでの #tasks の要約:」+ 要約。
  - DB（v14）: `inbox_summaries` に `channel_kind TEXT NOT NULL DEFAULT 'inbox'`（'inbox' | 'tasks'）、`guild_settings` に `tasks_rotated_at TEXT`。
- resume 失敗の復旧: #tasks は直近の #tasks の要約を seed にする（#inbox の要約は使わない）。
- ヘッダのチャンネル名は `#tasks`。
- 一覧の返事に必ず `#id` を出すので、日をまたいでも「#12 を完了」で通じる。

## 3. ツール（ADHD 支援で最小限）
足すのは 1 個、広げるのは 1 個。task_complete は残す（履歴にある呼び出しと /tasks のため）。
- `task_update`（新規。task_complete の直後に置く）: `id` 必須、`title?`（1〜200 字）、`due?`（YYYY-MM-DD か `"none"` で期限を外す）、`status?`（open / done / dropped）。
  - 返り値: `{ result: "updated", before: {id,title,due,status}, after: {...} }`。id が無ければ not_found、変更項目が無ければ no_change。
  - done・dropped にすると completed_at を今に、open に戻すと null に。
  - 説明文（案）: 「タスクの題名・期限・状態を変える。期限の変更、言い直し、やめた（dropped）、終わっていなかった（open に戻す）と言われたときに使う。変更前と変更後を返すので、変えた内容を 1 行で伝える。」
- `task_list` を広げる: `status` に dropped を足す。`due_by`（YYYY-MM-DD）で「未完了で期限がこの日以前（期限切れを含む、期限なしは除く）」に絞れる。done・dropped は閉じた時刻の新しい順。各要素に status を、done・dropped は closed（日付）を足す。
- 削除は作らない。「やめる」は dropped（戻せる）なので確認ボタンは要らない。誤登録も dropped で消える（/tasks の一覧に出ない）。物理削除が要る場面が出たら /tasks の UI に [削除する]（確認付き）を足す。
- 時刻・優先度・「今日やる」印は足さない。P4（リマインダー・朝のサマリー）でまとめて決める。「今日やること」は `due_by` と下のプロンプトで賄う。
- キャッシュ: 定義が変わるのは task_update の追加と task_list の入力の形。どちらも 1 つの PR（PR-T1）に入れ、段 1 と同じデプロイにする。

## 4. システムプロンプト（PR-T2 でまとめて変える）
- 引き継ぎの文の列挙（「これまでの #inbox の要約:」など）に「これまでの #tasks の要約:」を足す。
- 「書き方」の書き分けを置き換え: 「#inbox と #tasks では短く、基本 1〜3 行（タスクの一覧は 1 件 1 行）。セッションのチャンネル（ヘッダが #inbox・#tasks 以外）では、必要なだけ書いてよい。」
- 「やること」に足す（#inbox・#tasks 共通）:
  - 「期限や題名を変える、やめる、終わっていなかったと言われたら task_update を使い、変えた内容を 1 行で伝える。」
  - 「今日やることを聞かれたら task_list の due_by に今日の日付を渡す。何からやるか聞かれたら 1 つだけ選び、理由を 1 行添える。」
  - 「取りかかれないと言われたら、5 分でできる最初の一歩を 1 つだけ提案する。」
- 「#tasks では（ヘッダが #tasks）:」の節を足す:
  - 「タスクの話だけをする。タスク以外の話題（調べもの・相談・作ってほしいもの）は答えずに、#inbox か /new のセッションで話すよう 1 行で案内する。」
  - 「一覧は期限切れ・今日・それ以外の順に出す。10 件を超えるときは今日までのものだけ出し、残りは件数と /tasks を案内する。」
- 「このアプリについて」の「#tasks: まだ役割が無い。」を「#tasks: タスクの話だけをする場所（登録・一覧・期限や題名の変更・完了・やめる・今日やることの相談）。」に。
- #inbox の行（「#inbox で 3 往復以上…session_open」）はそのまま。#tasks では session_open が not_available を返す。

## 5. すみ分け・/setup・/help・パネル
- #inbox でもタスクの操作はすべてできる（ツールは共通。思いついた場所で登録できることを優先）。#tasks は見直しと整理の場所。
- /setup の #tasks の topic: 「タスクの話だけをする場所。登録・期限の変更・やめる・今日やることを Bot と話せます」。既存の #tasks は変わらないので、オーナーが 1 回だけ Discord で topic を書き換える（PR 本文に書く。コードで直さない）。
- /help: 1 行目の段落の後に「#tasks ではタスクの話だけを受け付けます（期限や題名の変更・やめる・今日やることの相談）。」を足す。
- ホームパネルは変えない。#tasks にパネルや常駐の一覧は置かない（一覧は /tasks とホームパネルの [タスク一覧]）。

## 6. デプロイの順番とキャッシュ
- ツール定義が変わるのは PR-T1 だけ。段 1（#44〜#54）+ #56 と同じデプロイに入れれば、全セッションでキャッシュが外れるのは 1 回で済む。
- PR-T2 はツール定義を変えないので、いつ出してもキャッシュは外れない。ただし #tasks の受け付けとプロンプトの行は同じ PR で出す（受け付けだけ先に出すと #tasks が「セッション」として長く書く）。
- プロンプトの変更が届くのは: #tasks は最初から（必ず新しい SDK セッション）、#inbox は次の日次の切り替えから、既存のセッションには届かない（task_update はツールの説明で届く）。
- 推奨の順: #54 → #56 → PR-T1 → PR-T2 を積み、まとめてマージ・再起動する。段 1 を急ぐなら、T1 までで一度デプロイし T2 は後でよい。

## 7. PR 分解と受け入れ条件
PR-T1「タスクの変更とやめる」（#56 の上に積む。issue を先に立てる）
- store: TaskStatus に dropped、toTask で読む、`update(id, {title?, due?: string | null, status?})`、`list` に dueBy と閉じたものの並び。
- tools: task_update を task_complete の直後に、task_list の入力と返り値。説明文は §3 の案。
- docs: CLAUDE.md のツールの並び、REQUIREMENTS の R5 と未決。PR 本文に `npm run measure` の増分（トークンが無ければ「未計測」と書く）。
- 受け入れ（単体）:
  - task_update で題名・期限が変わり、before と after が返る。`due: "none"` で期限が null。無い id は not_found、項目なしは no_change。
  - dropped と done で completed_at が入り、open に戻すと null。dropped は task_list の既定（open）と /tasks の一覧に出ない。
  - `task_list({ due_by })` が期限切れと当日の未完了だけを返し、期限なしを含まない。
  - ツール名の並びが task_add, task_list, task_complete, task_update, session_report, … で固定。
  - `npm run check` と `npm test` が通る。

PR-T2「#tasks をタスクの会話チャンネルにする」（PR-T1 の上）
- access・RunContext に "tasks"。handler のヘッダ名。turn の resumeSeed で #tasks は #tasks の要約。§2 の切り替え（inbox-rotate.ts の一般化と v14）。project_open の判定を「session 以外は not_available」に。
- system-prompt（§4）、/setup の topic、/help（§5）、CLAUDE.md・REQUIREMENTS（未決 2 件を決定事項へ）。
- 受け入れ（単体）:
  - #tasks の発言は kind "tasks"・ヘッダ `#tasks` で 1 ターン走る。別サーバーの同じ ID、/setup 前の env の fallback では受け付けない。
  - #tasks の run は 8 手順・`SELF_AGENT_TURN_TIMEOUT_SEC`。途中経過と [中断] は出ない。手順の上限では [続ける] を付けない。
  - 切り替えの規則（日次・サイズ・会話なし・初回の基準・記録切れ・失敗後 1 時間）が #inbox と同じく #tasks にも効き、要約は channel_kind 'tasks' で保存され、次の #tasks の最初の prompt は [記憶, 「これまでの #tasks の要約:」, 発言]。#inbox の切り替えは #tasks の要約を使わない（逆も）。
  - #tasks の resume 失敗の復旧で、直近の #tasks の要約を seed にする（#inbox の要約は使わない）。
  - #tasks で project_open・session_open・session_report は not_available。Write は拒否。
  - システムプロンプトに §4 の行があり、「まだ役割が無い」が無い。/help に #tasks の行がある。
- 受け入れ（手動・スマホ）: #tasks で「今日やることは？」→ 1 件 1 行の短い一覧。「#3 を来週の月曜に」→ 期限が変わり 1 行で返る。「#5 やめた」→ /tasks から消える。「この API 調べて」→ #inbox か /new へ案内。

## 8. 決定事項と未決
- オーナーの決定: #tasks はタスク専用の会話 / 切り替えは要約して引き継ぐ / 削除は dropped で代える / タスク以外は 1 行で案内。
- spec-writer の推奨として決めたもの: kind "tasks" を足す / 上限は #inbox と同じ / 切り替えの時刻と上限は #inbox の env を流用 / #inbox でもタスク操作は全部できる / 時刻・優先度・今日やる印は P4 / ホームパネルは変えない。
- P4 で決めること: 朝のサマリーとリマインドの投稿先を #tasks にするか。
