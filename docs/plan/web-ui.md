# Web UI（tailnet の中でスマホ・PC のブラウザから使う Web アプリ）— 設計案 v2（#157）

> 2026-10-29。spec-writer。v1（スマホ向けの補助画面）のモックを見たオーナーの「PC は VS Code のようなレイアウトで、Web アプリとしても成立する UI を期待」と、モック v2（VS Code の構成。「提案」の印の部品を含む）への「いい感じだね、実装しておいて」を受けて書き直した版。**v1 の決定（別ポート・`Tailscale-User-Login` 必須・env のトークン + Cookie・CSRF の 3 条件・CSP・素の HTML + fetch・log の規約）は変えない。** 変えるのは、画面の構成（§3）、会話を Web で見る・送る（§4・§5）、セッションの操作（§6）、段の切り方（§8）。**エディタの左右分割は作らない**（オーナーの指示。タブの切り替えだけ）。全体の順は `docs/plan/distribution.md` §1（§8.2 に更新案）。リポジトリのソースは変更していない。
> 「確認」= 2026-10-29 に main（3754b98）のコードとモック v2（scratchpad の `web-mock/v2/`）で確かめた事実。「未確認」= 実装・実機で確かめるまで前提にしない。

## 0. 目的・結論

目的: Discord を開かずに、tailnet の中のブラウザ（PC はキーボード中心、スマホは指）から、Bot の状態・使用量・セッション・会話を見て、会話に送り、実行中のターンの途中経過を見て止め、セッション・タスク・リマインド・記憶を操作できる。**Discord が主で、Web は同じ Bot・同じ DB を別の窓から使う。** Web から送った発言と返事は Discord にも出る。

結論:
1. 入口・認証・CSRF・CSP・技術は **v1 のまま**（§2）。別ポート `SELF_AGENT_WEB_PORT`（127.0.0.1）を `tailscale serve --https=9444` で出し、`SELF_AGENT_WEB_ALLOWED_LOGIN` 必須、任意の `SELF_AGENT_WEB_TOKEN` + HMAC の Cookie 30 日、依存は足さない。
2. 画面は **1 枚の HTML の SPA**（`src/web/static/`。モック v2 の workbench・sidebar・views・chat・ui をそのまま移し、`data.js` を `/api/*` を呼ぶ `api.js` に置き換える）。ダーク既定・PC は 28px 行・指の端末は 44px。`templates/web/site/base.css` と `icons.svg` は**複製せず**配る（§3.3）。
3. 会話の履歴は **DB に新しく保存する（案 B）**: `history` 表に、オーナーの発言（Discord で書いたものも）・Bot の返事（終わり方・手順・ツール回数）・区切り（/renew・/close・切り替え）を handler と各処理が書く（§4）。Discord の履歴は取りに行かない。未読の位置はブラウザ（localStorage）が持つ。
4. Web から送れるのは **受け付けるチャンネル全部**（#inbox・#tasks・#<NAME>・セッションのチャンネル。全人格）。`Handler.submitText` が、**キューに入れる前に持ち主の Bot で「（Web から）」付きの本文をチャンネルに投稿し**（投稿できなければ受け付けない）、Discord の発言と同じ経路（最終発言の記録・待ち/完了 → 進行中・キュー・turn.ts）で 1 ターン入れ、返事はその投稿への返信にする（Discord 側でも会話が送った順に読める。§5）。
5. 途中経過は **polling**（実行中のターンは 2 秒ごと）。handler が実行中のターンの経過・ツール回数・直近の手順を持ち、`/api/running` で返す。[中断]・[続ける] は Discord のボタンと同じ `handler.abortTurn`・`continueTurn`（§5.3）。SSE は tailscale serve 越しが未確認なので入れない（確かめ方は §5.4）。
6. セッションの操作（/new・/wait・/close・/renew・待ち → 続ける）は、コマンドのファイルから **`src/app/session-ops.ts`** に本体を出し、Discord のコマンドと Web の両方がそれを呼ぶ（§6）。
7. #system の知らせは、各所が直接 `gateway.sendMessage(systemChannelId, …)` している（確認。§1）ので、**`notices` 表に記録してから投稿する 1 つの関数に通し直す**（§7.1）。ジョブのビューは PR-J4 の後（§7.5）。
8. 段: **W1（殻 + 認証 + 状態 + 使用量 + 設定）→ W2（会話を見る）→ W3（送る + 途中経過）→ W4（タスク・リマインド・記憶）→ W5（セッションの操作）→ W6（知らせ・GitHub・ナレッジ）→ W7（プロジェクト）→ W8（ジョブ）**。W1〜W3 を D2 の前に、W4〜W8 は P1-b（0.1.0 の公開）の後（§8）。
9. 費用: 0 円（外部サービスは増えない）。運用コストは `tailscale serve` を 1 回打つことと env の 2〜3 変数、DB が履歴の分（1 ターン 1〜3 KB。90 日で消す）だけ増える。

## 1. 確認した事実

v1 §1 の事実（静的サーバーの `allowedLogin`、Tailscale KB の `Tailscale-User-Login`、Cookie はポートで分かれない、serve 越しの SSE・`Sec-Fetch-*` は未確認）はそのまま。v2 で足した確認:

- 確認（`src/app/handler.ts:135-383`）: `createHandler` の `submit(request: TurnRequest)`（322-338 行）は、セッションなら `topicSessions.touch` で最終発言を記録して `revive`（待ち・完了 → 進行中。`applySessionEvent(session, "message")`）し、`queue.run(channelId, () => handleTurn(…), { session })` を **await する**。`continueTurn`（368-375 行）は `resolveChannel(guildId, channelId) !== "session"` なら何もせず、`submit({ …, content: CONTINUE_PROMPT, at })`（返信先無し・添付無し）。`abortTurn(channelId, turnSeq)`（376-381 行）は `running: Map<channelId, { turnSeq, controller }>` を引く。**実行中のターンの経過・ツール回数・手順は handler に無い**（`startProgress` の中（`src/app/progress.ts:92-`）にクロージャで閉じている: `toolCalls`・`label`・`startedAt`）。`turnOutcome(result)`（50-56 行）で終わり方（done / max_turns / aborted / failed）が決まる。返事の本文は `reply(request, text)`（183-189 行）で `gateway.send(channelId, text, replyToId)`。
- 確認（`src/app/progress.ts`）: `startProgress` は `onProgress(step)` で `toolCalls++` と `label = step.label` を持ち、表示は `progressText(elapsedMs, toolCalls, label)`。手順の履歴（配列）は持たない。`ProgressStep` は `{ label }`（`src/agent/runner.ts:23`）。label は `src/agent/sdk-runner.ts:211-` の `progressLabel`（「書いています: <相対パス>」「ツールを使っています: <名前>」など。中身・URL は入らない）。
- 確認（`src/app/session-state.ts`）: `transition(state, event)` は純関数、`applySessionEvent(session, event, { topicSessions, channelOps })` が DB とカテゴリ移動に反映する（`close` は受けない）。/wait（`commands/wait.ts:35-45`）と [続ける]（`wait:continue`。58-74 行）はこれを呼ぶだけ。
- 確認（`src/app/commands/new.ts`）: `createTopicSession(guildId, title, deps, origin, owner)`（80 行〜）は responder を使わず、`startTopicSession`（122 行〜）が題名の検証 → `responder.defer` → `queue.run(layoutQueueKey(guildId), …)` → 最初の投稿（持ち主の Bot）→ `<#id> を作りました`。`welcomeText`・`sessionOwnerOf`・`TITLE_MAX_LENGTH`（100）は export 済み。ホームパネルのモーダル（`commands/home.ts`）も `startTopicSession` を呼ぶ。
- 確認（`src/app/commands/close.ts`）: `runClose(deps, guildId, channelId, responder, response)`（201 行〜）が閉じられるかの判定 → `response.defer()` → `turnQueue.run(channelId, () => closeTurn(…), { session: true })` → 結果（closed / failed / finalized / confirm(draft)）を `response.show`。`closeTurn`（171 行〜）と `finalizeClose(session, draft, selected, deps)`（114 行〜）は responder を使わない（**export されていない**）。確認のボタン（`close:all|pick|none|sel`）は DB の下書き（`topicSessions.getCloseDraft`）で動く。
- 確認（`src/app/commands/renew.ts`）: /renew は `guildSettings` から #inbox / #tasks / #<NAME> を判定して `inboxRotator.rotateNow(guildId, kind, persona)`、セッションなら `renewSession(deps, guildId, channelId)`（`src/app/session-renew.ts:51`。responder を使わない）。結果の文は `renewedText`（export 済み）と `sessionReply`・`rotateReply`（**export されていない**）。
- 確認（`src/app/commands/turn-controls.ts`）: [中断] は `turns.abortTurn(channelId, turnSeq)` が false なら「この操作は古くなっています」、[続ける] は `resolveChannel === "session"` を確かめてボタンを外し `turns.continueTurn(guildId, channelId, interaction.createdAt)` を待つ。
- 確認（`src/app/personas.ts`）: `PersonaRouter.ownerOf(channelId)`・`ownerConnected(channelId)`・`gatewayFor`・`ownerPosts()`・`all`（`PersonaRuntime` に `name`・`connected()`）。`commandResponse` は /close・/renew の結果の出し方（持ち主が既定でなければ持ち主の Bot がチャンネルに投稿）。
- 確認（`src/app/access.ts:58-`）: `createChannelResolver` は #inbox（/setup 前は env）・#tasks・設定にある人格の #<NAME>・削除されていないセッションを返す。`acceptedChannel` はオーナー判定と持ち主の Bot の判定（Web には Bot が無いので後者は使わない）。
- 確認（`src/discord/gateway.ts`・`discord-gateway.ts`）: **Gateway にチャンネルの履歴を取る口は無い**（`messageExists` が `channel.messages.fetch({ message })` を 1 件だけ）。`send` は長い本文を分割し ID を返さない、`sendMessage` は 1 通（2,000 字以内・分割しない）で ID を返す。`connected()`・`selfUserId()`・`listGuildIds()` はある。サーバー名を返すものは無い。
- 確認（`src/devlog/log.ts`）: dev ログの `prompt` は「SDK に渡した文字列そのまま（ヘッダ・記憶のブロック・seed を含む）」、steps は tool_use の input（2,000 字まで）を含む。**会話の表示には向かない**（記憶・seed・ツールの入力が混じる。dev モードだけ）。
- 確認（store）: `TopicSessionStore.listByState(guildId, state, limit)`・`listUndeleted(guildId)`・`get`・`personaOf`・`getCloseDraft`・`close`・`setRenewed`。`GuildSettingsStore.get(guildId)`（inbox / tasks / system / github の ID）・`personaInbox(guildId, persona)`・`entryChannel(channelId)`。`UsageStore.listRecent`・`summarize(since, persona?)`・`sumOutputTokens`。`TaskStore.list({ status, limit, dueBy })`・`complete`・`update`。`ReminderStore.listActive(limit)`・`cancel(id, seq?)`・`skipNext(id, next)`・`nextForTasks`。`MemoryStore.list()`（有効なものだけ）・`softDelete`・`restore`。`KnowledgeStore.search(query, limit ≤ 10)`・`get`（**一覧（新しい順）は無い**）。`ProjectStore.list()`・`getBySlug`（**ファイルの一覧を返すものは無い**）。`GithubStore.listUnposted`・`getNotification`（**投稿済みの一覧は無い**）。`JobStore.listOpen()`・`listRuns(jobId)`・`latestRun`（**閉じた job を含む最近の一覧は無い**）。`MIGRATIONS` は 24 要素（user_version 24）。
- 確認（#system への知らせの経路）: `src/app/shell-state.ts:137-139`、`src/app/persona-status.ts:93-95`、`src/github/poller.ts:672-`（`postNotice`）、`src/app/scheduler.ts:372-382`（削除の確認）、`src/guest/notify.ts`（ゲスト）が**それぞれ** `guildSettings.get(guildId)?.systemChannelId` を引いて `gateway.sendMessage` する。**共通の関数も記録も無い。**
- 確認（`src/app/queue.ts`）: `runningSessionJobs()` はあるが待ちの数を返すものは無い。
- 確認（`src/main.ts`）: 静的サーバーは `config.servePort && config.publicBaseUrl` のときだけ作り、`start` の失敗は log だけで Bot は動き続け、`createShutdown` の `staticServer` で閉じる。handler は `createHandler({ …turn, gateway: ownerPosts, channelOps, queue: turnQueue, now, prepareImages })`。
- 確認（モック v2）: `index.html` は `base.css` → `app.css`、`ui.js` → `data.js` → `chat.js` → `views.js` → `sidebar.js` → `workbench.js` の順（すべて `defer`、inline 無し）。`base.css` と `icons.svg` は `templates/web/site/` のものと**同一**（`cmp`）。`app.css` は `:root` に骨組みの寸法（`--row: 28px`・`--sidebar-w`・`--panel-h` など）、`@media (pointer: coarse)` で `--row: var(--tap)`（44px）、`:root[data-theme="dark"|"light"]` に base.css の色を写したもの、`:root[data-proposals="hide"] [data-proposal]` の出し入れ。`workbench.js` は localStorage（`sa-mock-v2:` の theme・proposals・`--sidebar-w`・`--panel-h`）、`S.groups` は 1 つ（分割の描画コード `is-split`・`moveTab`・`closeGroup` は残骸）、パネル（出力・知らせ・ジョブ）、ステータスバー、コマンドパレット（`>` / `/` でコマンド）、キーボード（Ctrl+K / Ctrl+Shift+P / Ctrl+B / Ctrl+J / Alt+W / Alt+1〜9 / Esc）、新しいセッションのダイアログ（題名 + 人格）、幅・高さのつまみ（CSSOM の `setProperty`。style 属性を書かない）。`chat.js` は会話のタブ（owner / agent（steps・end・cont）/ notice（undo）/ divider / running）、composer（Enter で送信・Shift+Enter で改行・変換中は送らない・2,000 字）、ヘッダの操作（待ちにする・閉じる・会話を新しくする・プロジェクト・ページ・Discord）。`views.js` は tasks（状態の切り替え・完了 + 取り消しのトースト）/ reminders（次を飛ばす・止める）/ usage（日付・人格ごとのカード・ターンの表）/ devlog（左に一覧・右に中身）/ status / settings（テーマ・提案・キー・環境変数の有無）/ project（ファイル一覧 + 読むだけの中身）/ job / github / knowledge（master-detail）/ memories（忘れる + 取り消し）/ welcome。`sidebar.js` の ACTIVITIES は chat / tasks / reminders / knowledge / projects / jobs / github / usage / devlog / status / settings。`data.js` のダミーの形が §3.4 の API の材料。

## 2. 決定事項（v1 から変わらないもの）

| 項目 | 決定 |
|---|---|
| 入口 | 別ポート `SELF_AGENT_WEB_PORT`（1〜65535。`127.0.0.1` だけ）。`tailscale serve --bg --https=9444 http://127.0.0.1:<port>`。静的サーバー（`/p/`。9443）とは別サーバー・別オリジン |
| 有効の条件 | `SELF_AGENT_WEB_PORT` と `SELF_AGENT_WEB_ALLOWED_LOGIN` の両方。どちらかが無ければ Web UI は起動しない（設定エラーではなく無効。log 1 行）。ポートの範囲外・空のログイン・32 字未満のトークンは設定エラー |
| 認証 1 | `Tailscale-User-Login` が `SELF_AGENT_WEB_ALLOWED_LOGIN` と完全一致 |
| 認証 2 | `SELF_AGENT_WEB_TOKEN`（任意。32 字以上・空白なし）。`GET /login` のフォームに貼ると `POST /login` が `timingSafeEqual` で比べ（長さが違えば比較せず不一致）、Cookie `self_agent_web`（`<exp>.<HMAC-SHA256(token, "v1:" + exp)>` の hex。exp は UNIX 秒で 30 日。`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`）。失敗の窓は全体で 1 つ: 1 分に 5 回、超えたら 429。失効はトークンの差し替え |
| 両方無いとき | 401（API）/ `/login` へ 302（画面）。トークンが無ければ `/login` は 404。**`/static/*` だけは認証なしで配る**（秘密は無い。ログイン画面の CSS のため。§3.3） |
| CSRF | POST は (1) `Sec-Fetch-Site` があれば `same-origin`、無ければ `Origin` が `Host` と一致（どちらも無ければ 403）、(2) `X-Self-Agent: 1`、(3) `Content-Type: application/json` で本文が JSON オブジェクト（`{}` でよい）の 3 つ全部。`/login` だけ `application/x-www-form-urlencoded` + (1) |
| 応答ヘッダ | `Content-Security-Policy: default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cross-Origin-Resource-Policy: same-origin`、`Cache-Control: no-store`（API）/ `no-cache`（HTML・CSS・JS・SVG） |
| 技術 | 素の HTML + `fetch`。依存は 3 つのまま。inline の script・style を書かない（CSP に `'unsafe-inline'` を足さない。つまみは CSSOM の `setProperty`） |
| 範囲外 | env の編集（状態に「設定の有無」だけ）。画像の送信（v2 では文字だけ）。発火のメッセージのボタン（済んだ・10 分後・1 時間後。`fire_seq` に紐づく）。kb の削除（Discord の確認から）。[対応]（GitHub の段 2） |
| HTTP ステータス（操作） | 成功は 200 で結果の JSON（ターンを始めるものは 202）。無い・受け付けないチャンネルは 404。`already`・`active` でない・古い・状態が合わない は 409。対象の Bot が接続していなければ 503、Web の発言の echo を投稿できなければ 502。形の誤りは 400。本文は 64 KB まで（超えたら 413）。停止を始めた後の POST は 503 `{ error: "stopping" }` |
| 操作の主体 | 認証を通った人 = オーナー。記録（usage・log・history の source）は Discord の操作と同じ扱い（source だけ `web`） |
| log | リクエストごとに出さない。認証の失敗は種類だけ。本文・チャンネル ID・ヘッダの値・Cookie・トークンは出さない。「Web から #inbox に送りました（guild=…）」のように種類とサーバーだけ |
| 静的サーバーとの関係 | 別サーバー・別ポート・別の serve。`SELF_AGENT_SERVE_*`・`build-and-serve.md` の決定は変えない |

## 3. 画面（SPA）

### 3.1 構成（モック v2 を本番へ）
- `src/web/static/` に置く: `index.html`・`app.css`・`ui.js`・`api.js`（`data.js` の置き換え）・`chat.js`・`views.js`・`sidebar.js`・`workbench.js`・`icons-app.svg`。`base.css`・`icons.svg` は `templates/web/site/` のものを `/static/base.css`・`/static/icons.svg` で配る（複製しない。`scaffold.ts` の `WEB_TEMPLATE_DIR`）。`src/web/static/` は `new URL("./static/", import.meta.url)` で解決する（`dist/` でも同じ深さ）。公開物では `build` が `dist/web/static/` に複製する（決定済み。distribution.md §4.1）。
- モックから外すもの: 「提案」の印と出し入れ（`data-proposal`・`proposal()`・`only-current`・`proposal-toggle`・`setProposals`・設定の「提案の部品」）、「モック v2」のバッジ、分割の残骸（`is-split`・`moveTab`・`closeGroup`・`splitSash`・`wb-sash-group`・タブのドラッグ）、`data.js` のダミー、`chat.js` の偽の進行（`startRun`・`tick`・`finishRun` の script）。
- `window.SA` の名前空間と各ファイルの役割分担は保つ。`api.js` が `SA.api`（`fetch` の包み: `X-Self-Agent: 1`、JSON、401 なら `/` へ（§3.3）、エラーはトースト）と `SA.store`（`/api/*` の結果を持つメモリの状態。`channels`・`turns[channelId]`・`running`・`tasks`・… と、変わったら `SA.app.refresh*` を呼ぶ）を持つ。`chat.js`・`views.js`・`sidebar.js` は `SA.data` の代わりに `SA.store` を読む。
- 深いリンクは **URL の hash**（`#/ch/<channelId>`・`#/tasks`・`#/reminders`・`#/usage`・`#/devlog`・`#/status`・`#/settings`・`#/project/<slug>`・`#/job/<id>`・`#/github`・`#/knowledge`・`#/memories`・`#/sessions/new`）。hash はサーバーに届かないので、ルータ・認証・CSP は 1 枚の HTML のまま。タブを開く・切り替えるたびに `history.replaceState` で hash を変え、読み込み時は hash があればそれを開く。パスでの深いリンクは作らない。
- localStorage（接頭辞 `self-agent-web:`。読めなくても動く。モックの `sa-mock-v2:` は使わない）: `theme`（dark / light / system。既定 dark）、`--sidebar-w`・`--panel-h`、`tabs`（開いているタブの ID の並びと active）、`panel`（開いているか・どのタブか）、`drafts`（チャンネルごとの書きかけ。送ったら消す）、`seen`（§4.4 の未読）。本文以外は小さい。書きかけは本人のブラウザだけ。
- 更新（polling。`document.visibilityState === "visible"` のときだけ。隠れたら止め、戻ったら即 1 回）: `/api/status` 10 秒。`/api/running` は実行中のターンが 1 つでもあれば 2 秒、無ければ 10 秒。開いている会話のタブの `turns?after=<最後の id>` は、`/api/running` の結果がそのチャンネルで変わったとき（始まった・終わった）と 5 秒ごと。一覧（channels・tasks・reminders・…）は開いたときと 60 秒ごと、操作の後は即。`/api/status` の応答に `stopping: true` が来たらトースト「再起動中です」を出して polling を止める。

### 3.2 殻（W1）
- タイトルバー（サイドバーの切り替え・名前・コマンドセンター（Ctrl+K）・パネルの切り替え・テーマ）、アクティビティバー（PC は左の縦、1023px 以下は下の横。項目は §3.4 の表の順。無効な機能（dev モードでない devlog・GitHub 無効・ジョブ無効・配信無効のプロジェクト）は `/api/status` を見て**項目ごと出さない**）、サイドバー（PC は幅のつまみ付き、狭い画面はドロワー）、エディタ（タブ。Alt+1〜9・Alt+W・中クリックで閉じる・矢印で移動）、パネル（出力・知らせ・ジョブ。Ctrl+J。狭い画面は既定で閉じる）、ステータスバー（Bot の接続の点・シェル・実行中 n・ジョブ n・知らせ n・今日のトークン・版）、コマンドパレット、確認ダイアログ、トースト、ようこそ。振る舞いはモックの `workbench.js` のとおり（分割を除く）。
- テーマ: 既定 **dark**（`<html data-theme="dark">`。モックと同じ）。`system` を選ぶと `data-theme` を外して base.css の `prefers-color-scheme` に任せる。色の値は app.css の `:root[data-theme]` に base.css の写し（確認。base.css は編集しない）。
- 密度: app.css の `--row`（PC 28px、`pointer: coarse` で `--tap` = 44px）、`.btn-sm`・`.input-sm`・`.chip-sm`・`.segmented-sm`。**`templates/web/DESIGN.md` の「押せるものは 44×44px 以上」「.container 640px」は LLM が作るページの決まりで、Web UI には当てはめない**（Web UI 専用の app.css で上書きする。DESIGN.md・base.css は変えない。両者の関係は app.css の先頭のコメントと本文書に書く）。
- 設定の画面: テーマ、キーボードの一覧、環境変数の**有無**（`/api/status` の `env`。値は返さない）。

### 3.3 配り方
- `GET /` → `index.html`、`GET /static/<name>` → `src/web/static/<name>`（`base.css`・`icons.svg` だけ `templates/web/site/`）。`name` は `/^[A-Za-z0-9_-]+\.(html|css|js|svg)$/` に合うものだけ（`..`・ドットで始まる名前・拡張子なしは 404）。**`/static/*` は認証なしで配る**（中身は公開リポジトリにあるもので秘密は無く、ログイン画面が `base.css` を読むため）。`/`・`/api/*` は認証が要る。Content-Type は html / css / js / svg の小さな表（static-server.ts の表とは別。`charset=utf-8`）。`Cache-Control: no-cache` と `ETag`（ファイルの mtime + size）。`GET /login` はトークンがあるときだけのフォーム（`src/web/server.ts` の中で組み立てる。誤り・回数の超過の固定の文を出すため。`/static/base.css` を読み、殻と同じ部品で組む。認証なしで返す唯一の HTML）。401 のとき画面（api.js）は `/` へ移る（トークンがあれば `/` が `/login` へ 302、無ければ「Tailscale でつないでください」。`/login` はトークンが無いと 404 のため）。
- 認証を通らない `GET /` は `/login` へ 302（トークンが無ければ 401 の本文「Tailscale でつないでください」）。ルートの処理が投げたときの 500 の log は例外の message だけ（`describeError` 相当。パス・クエリは出さない）。

### 3.4 画面と API の対応（段付き。GET は読む・POST は変える（CSRF の 3 条件））
| アクティビティ / タブ | GET | POST | 段 |
|---|---|---|---|
| 状態 | `/api/status`（§3.5） | — | W1 |
| 使用量 | `/api/usage?date=YYYY-MM-DD&last=N&kind=`・`/api/usage/days?n=30` | — | W1 |
| 設定 | （`/api/status` の `env`） | — | W1 |
| 会話（サイドバー） | `/api/channels`（§4.3） | — | W2 |
| 会話のタブ | `/api/channels/<id>/turns?before=&after=&limit=`（§4.3） | `/api/channels/<id>/messages`・`/turns/<seq>/abort`・`/continue`（§5） | W2 / W3 |
| 実行中 | `/api/running`（§5.2） | — | W3 |
| 会話ログ | `/api/devlog/days`・`/api/devlog?date=&kind=&channel=&persona=&last=`（dev モードでなければ 404） | — | W2 |
| タスク | `/api/tasks?status=` | `/api/tasks/<id>/complete`・`/api/tasks/<id>/reopen`（取り消し） | W4 |
| リマインド | `/api/reminders` | `/api/reminders/<id>/cancel`・`/skip` | W4 |
| 記憶 | `/api/memories` | `/api/memories/<id>/forget`・`/restore` | W4 |
| 新しいセッション | （`/api/channels` の `personas`・`guilds`） | `/api/sessions` | W5 |
| セッションの操作 | — | `/api/sessions/<id>/wait`・`/continue`・`/close`・`/close/confirm`・`/api/channels/<id>/renew` | W5 |
| 知らせ（パネル） | `/api/notices?last=50` | — | W6 |
| GitHub | `/api/github?last=50` | — | W6 |
| ナレッジ | `/api/knowledge?q=&last=`・`/api/knowledge/<id>` | — | W6 |
| プロジェクト | `/api/projects`・`/api/projects/<slug>/files`・`/api/projects/<slug>/file?path=` | — | W7 |
| ジョブ | `/api/jobs?last=20`・`/api/jobs/<id>` | `/api/jobs/runs/<runId>/abort`・`/retry`・`/push`・`/api/jobs/<id>/more` | W8 |

- 応答は JSON（`application/json; charset=utf-8`）。ID（サーバー・チャンネル・メッセージ）は Discord のリンク（`https://discord.com/channels/<guild>/<channel>[/<message>]`）を作るために返す（本人だけが見る。log には出さない）。
- 知らないパス・メソッドは 404 / 405。機能が無効のもの（devlog・github・jobs・projects）はそのパスごと 404。

### 3.5 `/api/status`
```json
{ "version": "0.1.0" | null, "startedAt": "ISO", "stopping": false,
  "bots": [{ "persona": "default", "name": "既定の人格", "isDefault": true, "connected": true }, …, { "persona": "guest", "name": "しのえもん", "guest": true, "connected": true }],
  "shell": { "configured": true, "enabled": true, "failed": [] },
  "queue": { "runningSessionJobs": 1 }, "running": 1,
  "serving": true, "publicBaseUrl": "https://…" | null, "devMode": true,
  "github": { "enabled": true, "lastFetchAt": "ISO" | null, "failure": "auth" | "rate_limited" | … | null } ,
  "jobs": { "enabled": false }, "guest": true,
  "guilds": [{ "id": "…", "setUp": true }],
  "env": [["CLAUDE_CODE_OAUTH_TOKEN", true], …] }
```
`env` は CLAUDE.md の環境変数の表の名前の一覧（固定の配列を `src/web/routes/status.ts` に持つ）と `process.env` に非空の値があるかだけ。`github.lastFetchAt`・`failure` は `GithubPoller` に `status()` を足して読む（W6 まで `null`）。`shell.failed` は `ShellState` に `failedItems()` を足す（W1）。

## 4. 会話を Web で見る（W2）

### 4.1 履歴の出所の比較
| | A: Discord の履歴を Bot が取って返す | **B: ターンを DB に新しく保存する** | C: devlog を使う |
|---|---|---|---|
| Discord で直接書いた発言 | ◎ 全部見える（他の Bot の投稿も） | ○ 受け付けた発言は全部（handler が受け取る。§4.2）。Bot だけの投稿（リマインドの発火・記憶の知らせ・kb の確認）は見えない | ✗ prompt の中に埋もれる |
| 手順・終わり方・ツール回数 | △ 途中経過のメッセージを文字で解析 | ◎ 構造のまま | ○ steps はあるが tool_use の入力まで入る |
| プライバシー | ○ 新しい保存は無い | △ 本文を DB にもう 1 つ持つ（SDK の記録と Discord に既にある。DB は 600・dataDir の中。日数で消す） | ✗ 記憶・seed・ツールの入力が混じり、dev モードだけ |
| 再起動・Discord が落ちている | ✗ Discord に頼る | ◎ DB だけ | ○ |
| Discord のレート制限・遅さ | ✗ タブを開くたびに API（50 件 / 1 回。serve 越しの往復に Discord の往復が足される） | ◎ 無い | ◎ |
| 保存量 | ◎ 無し | △ 1 ターン 1〜3 KB。90 日で消す | — |
| Web から送ったもの | ○ echo を投稿すれば見える | ◎ 書くときに残す | — |
| 実装 | 新しい Gateway の口 + 解析 | 表 1 つ + handler ほか 4 箇所に 1 行ずつ | — |

**B を採る。** Web の会話は「Bot と交わしたターン」であって Discord のチャンネルの写しではない、と割り切る。Discord だけにある投稿（リマインドの発火など）は「Discord で開く」のリンクで見る。C は「会話ログ」のタブとして dev モードのときだけ別に出す（v1 の W2 のまま）。

### 4.2 `history` 表（v25）と書く場所
- `history(id INTEGER PK AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('owner','agent','notice','divider')), source TEXT NOT NULL CHECK (source IN ('discord','web','system')), persona TEXT NOT NULL DEFAULT 'default', text TEXT NOT NULL, outcome TEXT CHECK (outcome IN ('done','max_turns','aborted','failed')), steps TEXT, tool_calls INTEGER, duration_ms INTEGER, message_id TEXT)`。索引 `history_channel ON history(channel_id, id)`、`history_at ON history(at)`。`steps` は label の JSON 配列（**先頭 50 件 + 「（ほか n 手順）」**。中身・URL は label に元から無い）。`text` は 4,000 字で切る（返事は Discord に全文がある）。
- `HistoryStore`（`src/store/history.ts`）: `add(row) → id`、`list(channelId, { before?, after?, limit })`（`before` はその id より小さいものを新しい順に limit 件、`after` はその id より大きいものを古い順、どちらも無ければ最新 limit 件。limit は 1〜200）、`latestByChannel(guildId) → Map<channelId, { id, at, kind }>`、`prune(cutoff) → 消した数`。
- 書く場所（`history` は各 deps に `Pick<HistoryStore, "add">` で渡す。無ければ書かない）:
  - `handler.submit`: キューに入れる前に `owner` 行（`text` は本文。Discord なら `source: "discord"`・`message_id: event.id`、[続ける] は「続けてください」）。本文が空で画像だけの発言は `text` を「（画像 n 枚）」にする（本文があり画像もあれば本文の末尾に「（画像 n 枚）」を足す）。本文も画像も無い発言（読めない添付だけ）は `notice` 行にその注記。Web の発言は `submitText` が echo の投稿の後に owner 行を書いてから `submit` に渡す（`request.historyId` があれば `submit` は書かない。§5.1）。
  - `handler.handleTurn` の終わり: `agent` 行（`text` は REVIVED_NOTE を付ける前の返事の本文（COMPACTED_NOTE は含む。失敗の文面もそのまま）、`outcome`、`steps`、`tool_calls`、`duration_ms`。handler が `progress.onProgress` を包んで label を集める（§5.1 と同じ配列））。REVIVED_NOTE は `notice` 行だけに書く（agent 行の text には付けない）。
  - `reminders.ts` の予約した依頼のターン（`runChannelTurn` を直接呼ぶ）: `owner` 行（`text` は予約の prompt の本文（`scheduledPromptContent`）、`source: "system"`）→ `agent` 行（返した本文（`scheduledReplyNote` 付き）・outcome・tool_calls・duration_ms。steps は無し）。
  - `session-renew.ts`・`inbox-rotate.ts`（切り替え・rotateNow）: `divider` 行（「会話を新しくしました。前の会話の要約: …」/ `ROTATED_NOTICE`）。
  - `close.ts` の `finalizeClose`: `divider` 行（「閉じました。要約: …（登録 n 件）」）。
  - `scheduler.ts` の idle・`handler.revive`: `notice` 行（「12 時間発言がないので待ちに移しました」/ REVIVED_NOTE。revive の notice は owner 行の後・agent 行の前）。
  - W5 のセッションの操作（/wait・[続ける]）も `notice` 行。
- 消す: `scheduler` の tick で `history.prune(今 - SELF_AGENT_WEB_HISTORY_DAYS 日)`（既定 90。Web UI が無効でも書くし消す。表は Discord だけでも役に立たないので、**Web UI が無効なら書かない**（`history` を渡さない）→ 推し。消すのは有効・無効を問わず）。

### 4.3 API
- `GET /api/channels` → `{ guilds: [{ id, setUp }], personas: [{ id, name, isDefault, connected }], channels: [ { id, guildId, kind: "inbox" | "tasks" | "session", name: "inbox" | "tasks" | "<NAME>" | null, title: <題名> | null, persona, state: "active" | "waiting" | "done" | null, project: { slug, url } | null, last: { id, at, kind } | null, link: "https://discord.com/channels/<g>/<c>" } ] }`。対象は **/setup 済みのサーバーだけ**（`guildSettings.get(guildId)` が無いサーバーは `guilds` に `setUp: false` で出すだけで、env の #inbox も返さない）。入口は `guildSettings.get`（inbox / tasks）と設定にある人格の `personaInbox`、セッションは `listByState` × active・waiting（上限 `SESSION_LIST_LIMITS`）と done（新しい 10 件）。`last` は `history.latestByChannel`。`project` は `projects.getByChannel`。
- `GET /api/channels/<id>/turns?before=&after=&limit=50` → `{ channel: {…上と同じ 1 件}, turns: [ { id, at, kind, source, persona, text, outcome, steps, toolCalls, durationMs, messageId, link } ], hasMore }`。チャンネルが受け付け対象でなければ 404（削除済みのセッションも 404。完了は 200）。
- 表示の対応（`chat.js`）: `owner` → `msg-owner`、`agent` → `msg-agent`（`steps` の details と `end`（`outcome` と `progressEndText` 相当の文を `toolCalls`・`durationMs` から client で作る）。`outcome === "max_turns"` かつそのチャンネルの最後の行かつセッションなら [続ける]）、`notice` → `tl-notice`、`divider` → `tl-divider`。`running` はこの API には無く、`/api/running`（§5.2）から足す。

### 4.4 既読（未読の位置）
- サーバーは持たない。ブラウザの localStorage `seen[channelId] = <見た最後の history.id>`。会話のタブを表示している間（visible かつ active）は最新の id を `seen` に書き、サイドバーの未読の点は `channel.last.kind === "agent" && last.id > seen[id]`。アクティビティバーの数字は未読のチャンネル数。1 人用なので端末ごとで十分（別の端末で読んだかは合わせない）。

## 5. Web から送る・途中経過（W3）

### 5.1 handler の口
- `Handler.submitText(input: { guildId, channelId, content, at, source: "web" }) → Promise<SubmitResult>`: `kind = resolveChannel(guildId, channelId)`、`null` なら `{ result: "not_accepted" }`。持ち主の Bot が `personas.ownerConnected(channelId)` でなければ `{ result: "bot_disconnected" }`。それ以外は **キューに入れる前に** 持ち主の Bot（`gateway.sendMessage`）で `（Web から）\n<本文>` を 1 通投稿し（失敗は log「Web の発言の投稿に失敗しました」で `{ result: "echo_failed" }`。ターンは入れない）、その message ID 付きで `history` の `owner` 行（`source: "web"`）を書き、`request.historyId` と `replyToId = <echo の ID>` を付けて内部の `submit`（最終発言の記録・待ち/完了 → 進行中・キュー）を **await せずに** 始め（`void submit(...)`。失敗は log）、`{ result: "accepted", turnId: <owner 行の id> }` を返す。`submit` は `historyId` があれば owner 行を書かない（Discord の発言は今までどおり `submit` で書く）。返事は echo への返信なので Discord の時系列は送った順になる。本文の検証（空・1,900 字超）は API 側（400）。`continueTurn` も同じ `submit` なので変えない（Web の [続ける] は `continueTurn` を `void` で呼び 202）。
- `Handler.runningTurns() → RunningTurn[]`: `{ guildId, channelId, turnSeq, startedAt: ISO, toolCalls, label: string | undefined, steps: string[] (直近 30 件), source: "discord" | "web" }`。`running` の値に `startedAt`・`toolCalls`・`label`・`steps`・`source` を足し、`startTurnProgress` の `onProgress` を包んで更新する（`progress.ts` は変えない）。#inbox・#tasks のターンにも番号を振って `running` に入れる（**中断は今までどおりセッションだけ**: `abortTurn` は `kind === "session"` のものだけ true）。これで `/api/running` に #inbox の実行中も出る。
- Web の発言の Discord 側: 上の echo（`WEB_ECHO_PREFIX = "（Web から）"`）。`handleTurn` は `replyToId` を使うだけで Web を特別扱いしない。本文の上限は **1,900 字**（接頭辞と改行を足して `sendMessage` の 2,000 字に収める。composer の数字も 1,900）。
- 送信先の範囲: **受け付けるチャンネル全部**（既定・足した人格の #inbox / #<NAME>、#tasks、削除されていないセッション（完了は進行中に戻る））。理由: handler がチャンネル ID で人格を引くので 1 箇所で済み、モックの composer は全部のタブに付いている。持ち主の Bot が接続していなければ 503（echo も返事も出せない）。既定の人格も同じ判定。

### 5.2 API
- `POST /api/channels/<id>/messages` `{ text }` → 202 `{ turnId, link }`（`link` は echo のメッセージへの Discord のリンク）。空・1,900 字超は 400、受け付けないチャンネルは 404、停止中は 503 `stopping`、持ち主の Bot が未接続なら 503 `bot_disconnected`、echo を投稿できなければ 502 `echo_failed`（ターンは入れない。画面は「送れませんでした」で本文を composer に残す）。二重送信: 同じチャンネル・同じ本文が 5 秒以内なら 2 回目は echo も submit もせず、**前回の `turnId` で 202** を返す（プロセス内の `Map<channelId, { text, at, turnId }>`）。副作用: 「はい」のような短い返事を 5 秒以内に 2 回送ると 2 回目が消える（意図したとおり。画面は 1 回目と同じ結果になる）。log は「Web から <kind> に送りました（guild=…）」。
- `GET /api/running` → `{ turns: [ { channelId, guildId, turnSeq, startedAt, elapsedMs, toolCalls, label, steps, source, abortable: boolean } ] }`。
- `POST /api/channels/<id>/turns/<seq>/abort` `{}` → `handler.abortTurn` が true なら 200 `{ aborted: true }`、false なら 409。
- `POST /api/channels/<id>/continue` `{}` → `resolveChannel === "session"` でなければ 404、そのチャンネルに実行中のターンがあれば 409、それ以外は `void handler.continueTurn(guildId, channelId, now)` で 202。
- 画面: composer（モックのまま。送ったら owner 行を楽観的に足し、`turns?after=` で置き換える）、`running` の行（`/api/running` から。`abortable` のときだけ [中断]）、パネルの「出力」は `/api/running` の `steps` の差分と `agent` 行の終わりの文を client が時刻付きで積む（API は無い）。タブとサイドバーのスピナーは `running` の有無。

### 5.3 Discord のボタンとの共有
- [中断]: `turn-controls.ts` と同じ `handler.abortTurn`。表示（「中断しました（…）」）は handler が Discord の途中経過を書き換え、Web は次の `turns?after=` で `agent` 行（`outcome: "aborted"`）を受け取る。
- [続ける]: 同じ `handler.continueTurn`。Discord の返信のボタンは残る（押せば古い判定で「この操作は古くなっています」にはならず、もう 1 ターン入る。Discord と同じ振る舞い）。

### 5.4 SSE を使わない理由と、後で確かめる方法
- 未確認: `tailscale serve` が長いストリームをそのまま通すか・無通信で切るか。polling は loopback の小さな JSON（`/api/running` は数百バイト）なので 2 秒でも負荷は無い。
- 確かめ方（W3 の実機の受け入れに「参考」として入れる。通れば後で `/api/events` を足す）: `curl -N https://<host>.<tailnet>.ts.net:9444/api/status-stream`（実装者が W3 で 30 秒ごとに `: ping` を流す試験用の GET を 1 つ足してよい。認証は同じ）を 5 分つなぎ、切れずに ping が届けば SSE は使える。

## 6. セッションの操作を Discord と Web で共有する（W5）

### 6.1 `src/app/session-ops.ts`（W5-a。Discord の振る舞いは変えない）
| 関数 | 中身 | 呼ぶ側 |
|---|---|---|
| `openTopicSession(guildId, rawTitle, owner, deps, via) → { result: "empty_title" } \| { result: "not_set_up" } \| { result: "created", channelId }` | `new.ts` の `startTopicSession` から responder を外したもの（trim・`queue.run(layoutQueueKey)` → `createTopicSession` → 持ち主の Bot の `welcomeText` の投稿（失敗は log）→ log） | `/new`・ホームパネル（応答だけ残す）・Web `POST /api/sessions` |
| `waitSession(guildId, channelId, deps) → "not_session" \| "closed" \| "waited" \| "unchanged"` | `wait.ts` の /wait の判定 + `applySessionEvent(session, "wait")` + log + `history` の notice | `/wait`・Web |
| `continueSession(guildId, channelId, deps) → "not_session" \| "deleted" \| "continued" \| "unchanged"` | `wait:continue` の判定 + `applySessionEvent(session, "continue")` | [続ける]（待ちの知らせ）・Web |
| `closeSession(guildId, channelId, deps) → { result: "not_session" } | CloseTurnOutcome`（not_session / closed / failed / finalized / confirm(draft)。not_session は受け付ける前だけで、Web は 404、closed は 409。node_modules の削除（`removeClosedNodeModules`）は中で呼ばず、結果を出した後に呼び出し側が呼ぶ） | `close.ts` の「閉じられるか」+ `turnQueue.run(channelId, closeTurn, { session: true })`。`closeTurn`・`finalizeClose`・`removeClosedNodeModules` をここへ（`close.ts` は応答と custom_id の処理だけに）。`confirmButtons`（今は export していない）を export する（循環になるなら `confirmText`・`confirmButtons`・`closedText` を `commands/close-text.ts` に出す）。Web の /close の確認を Discord にも投稿するのに使う（§6.2） | `/close`・[閉じる]・Web |
| `confirmClose(guildId, channelId, selected: number[] \| "all" \| "none", deps) → { result: "no_draft" } \| { result: "closed", summary, registered }` | 下書きの取得 → `finalizeClose` → `removeClosedNodeModules` | `close:all/none/sel`・Web |
| `renewChannel(guildId, channelId, deps) → { result: "not_renewable" } \| { result: "closed" } \| { result: "done", text }` | `renew.ts` の #inbox / #tasks / #<NAME> の判定（`rotateNow`）とセッション（`renewSession`）と文（`sessionReply`・`rotateReply` をここへ）。`history` の divider | `/renew`・Web |

- `/close`・`/renew` の `commandResponse`（持ち主の Bot がチャンネルに投稿）はコマンド側に残す。Web からの /close の確認（候補あり）は、**Discord にも同じ確認のメッセージ（ボタン付き）を持ち主の Bot で投稿する**（Web と Discord のどちらからでも確定でき、先に確定した方が勝つ。後の方は `no_draft` → Discord は NO_DRAFT_REPLY、Web は 409）。Web からの /renew の結果の文も Discord に投稿する（`ownerPosts.send`）。

### 6.2 API（W5-b）
- `POST /api/sessions` `{ guildId, title, persona? }` → 201 `{ channelId, link }`。空の題名 400、`not_set_up` 409、`persona` が設定に無ければ 400、既定の人格の Bot が未接続なら 503（チャンネルを作るのは既定の人格の Bot）。
- `POST /api/sessions/<id>/wait` → 200 `{ state }` / `not_session` 404 / `closed` 409。`/continue` → 200 / 404 / `deleted` 409。
- `POST /api/sessions/<id>/close` → 202 `{ accepted: true }`（要約のターンは最長 900 秒なので待たない。結果は `divider` 行（確定）か `notice` 行「確認待ち」+ `GET /api/channels/<id>/turns` の `channel.closeDraft`（`{ summary, tasks }`。下書きがあるときだけ）で届く）。閉じられなければ 404 / 409。実行中のターンがあればキューで順番を待つ（Discord と同じ）。
- `POST /api/sessions/<id>/close/confirm` `{ selected: number[] | "all" | "none" }` → 200 `{ summary, registered }` / `no_draft` 409。
- `POST /api/channels/<id>/renew` → 202（結果は `divider` 行。失敗は `notice` 行「失敗しました。もう一度 …」）。
- 画面: モックの「新しいセッション」ダイアログ（題名 + 人格。人格の選択肢は `/api/channels` の `personas`）、ヘッダの [待ちにする][閉じる][会話を新しくする]、`closeDraft` があるときは会話の末尾に確認のカード（要約・候補のチェックボックス・[全部登録][選んだものを登録][登録しない]）。

## 7. 知らせ・GitHub・ナレッジ・プロジェクト・ジョブ

### 7.1 #system の知らせ（W6-a）
- `notices(id, at, guild_id, level CHECK IN ('info','success','warning','danger'), text, message_id, posted_at)`（v26）。`NoticeStore.add`・`findUnposted(guildId, text)`（同じサーバー・同じ本文で `posted_at IS NULL` の行）・`markPosted(id, messageId, at)`・`listRecent(limit)`・`countSince(since)`・`prune(cutoff)`（90 日）。
- `src/app/system-notice.ts` の `createSystemNotifier({ guildSettings, gateway, notices?, log }) → SystemNotifier = (guildId, message: OutgoingMessage, { level, timeoutMs? }) => Promise<string | undefined>`: 同じサーバー・同じ本文で未投稿（`posted_at` が NULL）の行があればそれを使い、無ければ `add`（**やり直しで行が増えない**）→ `systemChannelId` が無ければ undefined（行は残る）→ `withTimeout(gateway.sendMessage, timeoutMs ?? SHELL_NOTICE_TIMEOUT_MS)` → `markPosted` して message ID を返す。失敗は**投げる**（既存の各所の「投稿できたサーバーだけ知らせ済みにし、失敗は log して次の tick でやり直す」の規則をそのまま保つ）。`shell-state.ts`・`persona-status.ts`・`github/poller.ts`（`postNotice` の送る部分）・`scheduler.ts`（削除の確認。返った ID を `setDeletePrompt` に）・`guest/notify.ts`（`notifySystem` 相当）をこれに通す。level は呼び出し側が渡す（接続できない = warning、戻った = success、取得できない = danger、削除の確認 = info）。
- `GET /api/notices?last=50` → `[{ id, at, guildId, level, text, link }]`。パネルの「知らせ」とステータスバーの数（直近 24 時間の件数）。

### 7.2 GitHub（W6-b）
- `GithubStore.listPosted(limit)`（`posted_at IS NOT NULL` を `updated_at` の新しい順）を足す。`GithubPoller.status() → { lastFetchAt, failure, pausedUntil }`（取得できた時刻は `github_poll_state` の `last_modified` でなく tick の成功時刻をプロセス内で持つ）。
- `GET /api/github?last=50` → `[{ id, level, label, title, url, actorLogin, actorKnown, updatedAt, repo }]`（`repo` は `url` から取らず `thread` の情報を store に足さない。`url` のパスから `owner/repo` を切り出すのは **client**（表示だけ））。[対応] は disabled のまま（段 2）。

### 7.3 ナレッジ・記憶
- `KnowledgeStore.listRecent(limit)`（`updated_at` の新しい順。`body` を除く）を足す。`GET /api/knowledge?q=&last=30` は `q` が空なら `listRecent`、あれば `search(q, 10)`。`GET /api/knowledge/<id>` は `get`（本文あり）。削除は置かない（Discord の確認から）。
- `GET /api/memories` → `memories.list()`（有効なもの）。`POST /api/memories/<id>/forget` → `softDelete` → 200 / 404。`/restore` → `restore` → 200 / 404（上限 `MEMORY_MAX_ACTIVE` は確かめない。Discord の [取り消す] と同じ）。トーストの [取り消す] は `/restore`。

### 7.4 プロジェクト（W7。読むだけ）
- `src/agent/project-listing.ts`（SDK に依存しない）: `listProjectFiles(projectsDir, slug) → { files: [{ path, size, mtime }], truncated } | undefined`（`verifiedProjectDir` を通らなければ undefined。`lstat` で symlink・ディレクトリは出さず、`node_modules` には入らない。ドットで始まる名前（`.trash`・`.git`・`.env` など）は一覧にも読み取りにも出さない。深さ 6・500 件・開くディレクトリ 2,000 まで。読めない（EACCES）ものは飛ばす）。`readProjectFile(projectsDir, slug, relPath) → { text } | "not_found" | "too_large" | "binary" | "invalid_path"`（`file-access.ts` と同じく要素に `..`・`/` 始まりは invalid、realpath が dir の中、`O_NOFOLLOW` で開き通常のファイルだけ、256 KB まで、UTF-8 で読めなければ（先頭 8 KB に NUL があれば）binary）。
- `GET /api/projects` → `[{ slug, title, channelId, updatedAt, url }]`（`url` は `publicBaseUrl` から。無ければ null）。`/files`・`/file?path=` は上の関数。配信が無効でも一覧は出す（`url` は null）。ページは別オリジン（9443）なので埋め込まずリンク。

### 7.5 ジョブ（W8。PR-J4 の後）
- `JobStore.listRecent(limit)`（`updated_at` の新しい順。閉じたものを含む）を足す。`GET /api/jobs?last=20` → `[{ job: {…}, run: latestRun }]`、`GET /api/jobs/<id>` → `{ job, runs }`。操作は `JobOrchestrator.abort(runId)`・`retry(runId)`・`pushHeld(runId)`・`continueJob(jobId, instruction)`（ある。`abort` は boolean、`retry`・`pushHeld` は `ButtonResult`（`started` / `stale`）、`continueJob` は `{ ok: true, runId } | { ok: false, reply } | "stale"`。`stale` は 409、`{ ok: false }` は 400 に `reply` を添える）。#jobs のメッセージは今までどおり orchestrator が書き換える。
- `SELF_AGENT_JOBS` が無効（今は常に）なら `/api/jobs*` は 404 で、アクティビティにも出さない。

## 8. 段

### 8.1 Web の段（モックの部品との対応）
| 段 | 内容 | PR |
|---|---|---|
| W1 | **殻 + 認証 + 状態 + 使用量 + 設定**。W1-a: `config.web`・`src/web/`（server・auth・csrf・static・routes の status / usage / login）・`main.ts` の配線・`shutdown`・README・CLAUDE.md。W1-b: SPA の殻（index.html・app.css・ui.js・api.js・workbench.js・sidebar.js（状態・使用量・設定だけ）・views.js の status / usage / settings / welcome） | 2 |
| W2 | **会話を見る**。W2-a: `history` 表・`HistoryStore`・handler / renew / close / rotate / scheduler の記録・prune・`SELF_AGENT_WEB_HISTORY_DAYS`。W2-b: `/api/channels`・`/turns`・`/api/devlog`・chat.js（読むだけ。composer は無し）・sidebar の会話・devlog のビュー・未読 | 2 |
| W3 | **送る + 途中経過**。`submitText`・`runningTurns`・echo・`/messages`・`/api/running`・abort・continue・composer・running の行・出力パネル・ステータスバーの「実行中 n」 | 1 |
| W4 | **タスク・リマインド・記憶**。`reminders-ops.ts`（v1 §3.5 の `skipNextOf` の抜き出し）・API・ビュー・サイドバー | 1 |
| W5 | **セッションの操作**。W5-a: `session-ops.ts` の抜き出し（Discord の振る舞いは変えない）。W5-b: API・新しいセッションのダイアログ・ヘッダの操作・closeDraft のカード・パレットのコマンド | 2 |
| W6 | **知らせ・GitHub・ナレッジ**。W6-a: `notices` 表・`system-notice.ts`・5 箇所の置き換え。W6-b: `/api/notices`・`/api/github`・`poller.status()`・`/api/knowledge`・パネルの知らせ・GitHub・ナレッジ・記憶のサイドバー | 2 |
| W7 | **プロジェクト**。`project-listing.ts`・API・ビュー | 1 |
| W8 | **ジョブ**（PR-J4 の後）。`JobStore.listRecent`・API・ビュー・パネルのジョブ | 1 |

### 8.2 全体の順（distribution.md §1 の更新案）
`D1 → W1 → W2 → W3 → D2 → D3 → P1-a → M1 → P1-b → W4 → W5 → W6 → W7 → M2 → W8（J4 の後）`。W1〜W3 で「見る・送る・止める」が揃い Web アプリとして成立するので、0.1.0 にはそこまでを入れて公開を遅らせない。W4〜W7 は Discord のコマンドの抜き出しを含み、公開物に影響しないので 0.2.0。P1-a の `files` に `src/web/static`（か `dist/web/static` への複製）を足す 1 行を distribution.md §4.1 に入れる。

## 9. 受け入れ条件

単体（`npm test`。`port: 0`・偽の store と gateway（`test/helpers/`）・ネット無し）:
- W1-a: v1 §5 の W1 の項目（有効の条件・ヘッダ一致 200・不一致 401/302・Cookie・`/login` 404/429・CSRF の 3 条件・本文の形・CSP ほかの応答ヘッダ・log に値が出ない・`/api/usage` が `listRecent` と一致・`last=201` は 400・`version` null）に加え、`/static/<name>` が認証なしで 200、`/static/..`・`/static/.x`・`/static/a/b`・`/static/app` が 404、`base.css` の中身が `templates/web/site/base.css` と同じ、`/api/status` の `env` に値が無い（名前と真偽だけ）、`shell.failed` が `ShellState` の失敗の項目、`stopping` が停止後に true、POST が停止後に 503。
- W1-b: JS は `node --check` が通る（テストは DOM が無いので構文だけ）。`index.html` に `<script>`・`<style>` の inline が無い（grep）。
- W2-a: `history` の行が、偽 gateway の #inbox の 1 ターンで `owner`（source discord・message_id）→ `agent`（outcome done・steps の label・toolCalls。text に REVIVED_NOTE が無い）の順にでき、待ちのセッションの発言では owner → notice（REVIVED_NOTE）→ agent、画像だけの発言の owner は「（画像 1 枚）」、[続ける] は owner の text が「続けてください」、予約した依頼は owner（source system）→ agent、/renew は divider、/close の確定は divider、idle は notice、steps は 51 手順目から「（ほか n 手順）」、text が 4,001 字で切れる、`prune` が cutoff より前だけ消す、`latestByChannel` が最後の行、`history` を渡さなければ何も書かない。
- W2-b: `/api/channels` に入口（設定にある人格の #<NAME> を含む）とセッション（状態・題名・persona・last・link・project）、削除済みのセッションは無い、`/turns` の `before`・`after`・`limit`（201 は 400）、受け付けないチャンネルは 404、`/api/devlog` は dev モードでなければ 404・日付の形が違えば 400。
- W3: `submitText` が `not_accepted` で何もしない、#inbox で `[<日時> #inbox]` の prompt が偽 runner に届き返事が #inbox に出る、セッションで待ち → 進行中と `touch`、`（Web から）\n<本文>` が持ち主の Bot の `sendMessage` でキューに入れる前に出て owner 行の message_id がその ID・返事の `replyToId` もその ID、echo の失敗は `echo_failed`（502）で owner 行もターンも無い、1,901 字は 400、5 秒以内の同じ本文は echo が 1 回で 2 回目の応答の turnId が 1 回目と同じ、Bot 未接続は 503、`runningTurns` に startedAt・toolCalls・label・steps（31 手順目で先頭が落ちる）・source、#inbox のターンは `abortable: false`、`abort` が 200 / 409、`continue` が実行中なら 409。
- W4: `complete` 200 / 404 / 409（2 回目）、`reopen` は done → open、`cancel`・`skip` 404 / 409、`skipNextOf` の結果が Discord のコンポーネントと同じ（既存の reminders のテストが通る）、`forget`・`restore` 200 / 404。
- W5-a: 既存の `new-session`・`home`・`close`・`renew`・`wait`・`scheduler` のテストが変更なしで通る（抜き出しだけ）。
- W5-b: `POST /api/sessions` 201（偽 gateway にチャンネルと welcome）・空 400・not_set_up 409・人格が無い 400、`wait`・`continue` の遷移と 404 / 409、`close` 202 の後に偽 runner の session_report で `closeDraft` が出て Discord にも確認のメッセージ、`confirm` で登録数と divider・2 回目は 409、`renew` 202 の後に divider と Discord への投稿。
- W6-a: 5 箇所の既存のテスト（shell-state・persona-status・github-poller・scheduler・guest-notice）が通り、`notices` に level 付きの行が増える、`systemChannelId` が無ければ行だけ増えて undefined、投稿の失敗は投げて `posted_at` が NULL のまま、同じ本文のやり直しで行が増えない（`posted_at` が入るだけ）。
- W6-b: `/api/notices` の順と件数、`/api/github` が posted だけ、`/api/knowledge?q=` が search・無ければ listRecent、`/api/knowledge/<id>` に body。
- W7: `listProjectFiles` が symlink・`node_modules` を出さず 500 件で `truncated`、`readProjectFile` が `..`・絶対パス・外への symlink・ディレクトリ・256 KB 超・NUL 入りを拒む、`verifiedProjectDir` を通らなければ undefined / 404。
- W8: `/api/jobs` の形、`abort` 200 / 409、無効なら 404。
- 共通: `npm run check`、依存 3 つのまま、`src/web/**` に `console.log` が無い。

実機（Ubuntu。オーナー。結果は #157 に）:
- W1: `tailscale serve --bg --https=9444 http://127.0.0.1:<port>` の後、PC とスマホで `https://<host>.<tailnet>.ts.net:9444/` が開き、殻（タブ・サイドバー・パレット・テーマ）が動き、状態と使用量が見える。**`/login` の POST が通る**（serve が `Sec-Fetch-*`・`Origin` を通すかの確認。通らなければ §2 の条件を見直す）。`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/api/status` が 401。9443 の `/p/` は今までどおり。
- W2: Discord で #inbox に書いた発言と返事が、Web の会話のタブに出る（手順・終わり方付き）。
- W3: Web から #inbox とセッションに送ると、Discord に「（Web から）」の投稿と返信が出て、Web の会話に途中経過（手順が増える）→ 返事が出る。[中断] で両方に「中断しました」。参考: §5.4 の SSE の確認。
- W5: Web の「新しいセッション」で Discord にチャンネルができ、[閉じる] で Discord と Web の両方に確認が出て、どちらで確定しても他方が「古い」になる。

## 10. 決めてもらうこと（推し付き）

決まったこと（2026-10-29。オーナー）: モック v2 の採用（「提案」の部品を含む）、分割は作らない、送信先を広げる、Discord が主。

次の 4 つは推しのまま進める（オーナーの「実装しておいて」を受けて。変えるときはこの節を直す PR で）:

1. **履歴の保存**: 案 B（`history` 表。Web UI が有効なときだけ書く。90 日）が推し。Web を使わないときに DB を増やさない。
2. **Web の発言の Discord への echo**: 「（Web から）」付きで持ち主の Bot が投稿し、返事はそれへの返信（推し）。echo 無し（返事だけ）だと Discord で会話が読めなくなる。
3. **Web の本文の上限 1,900 字**（echo を `sendMessage` の 2,000 字に収める。推し）。2,000 字にするなら echo を `send`（分割）にして返信先を外す。
4. **全体の順**: W1〜W3 → D2 → D3 → P1-a → M1 → P1-b → W4〜W7 → M2 → W8（推し。0.1.0 は W3 まで）。

実装者が決めてよいこと: ルータの作り、`api.js` の形、polling の細部（§3.1 の間隔は目安）、`/api/status` の項目の名前、失敗の回数の窓の持ち方、`history` の `text` の切り方（4,000 字は目安）、app.css の整理（モックのコメントを本番の言葉に）、`session-ops.ts` の関数名。
