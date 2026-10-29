# Web UI（tailnet の中でスマホ・PC のブラウザから使う補助の画面）— 設計案 v1（#157）

> 2026-10-29。spec-writer。素案 §3 に対するオーナーの決定（別ポート + `Tailscale-User-Login` 必須・env のトークン + Cookie・最初から操作も入れる・env の編集は載せない）を反映した版。**全体の順（D1 → W1 → W2 → W3 → D2 → …）は `docs/plan/distribution.md` §1。** リポジトリのソースは変更していない。
> 「確認」= 2026-10-29 に main（d6cdb85）のコードと公式ドキュメント（Tailscale KB）で確かめた事実。「未確認」= 実装・実機で確かめるまで前提にしない。

## 0. 目的・結論

目的: Discord を開かずに、tailnet の中のブラウザから Bot の状態・usage・セッション・会話ログを見て、タスクの完了・リマインドの操作・#inbox への投稿ができる。Discord が主で Web は補助（REQUIREMENTS.md が「将来に回す」としていた Web UI の範囲をここで決める）。

結論:
1. **別ポート**（`SELF_AGENT_WEB_PORT`。127.0.0.1 だけ）に `node:http` の小さなサーバー `src/web/` を足し、`tailscale serve --https=9444` で出す。静的サーバー（`/p/<slug>/`。9443）とは**別サーバー・別オリジン**。
2. 認証は **`SELF_AGENT_WEB_ALLOWED_LOGIN`（必須）と `Tailscale-User-Login` の完全一致**。Tailscale 以外の VPN・手元の確認用に **`SELF_AGENT_WEB_TOKEN`（任意）+ HttpOnly の Cookie（HMAC）**。`SELF_AGENT_WEB_ALLOWED_LOGIN` が無ければ Web UI は起動しない。
3. 状態を変える要求は CSRF の 3 条件（§3.3）。CSP は `default-src 'self'`。
4. 画面は素の HTML + `fetch`（依存を足さない）。`templates/web/site/base.css` を流用。更新は polling。
5. 操作は Discord のボタンと**同じストアの処理**を呼ぶ（§3.5）。#inbox への投稿は handler に「オーナーの発言と同じ経路」を 1 つ足して渡す。
6. 段: W1（土台 + 状態 + usage + 認証 + CSRF）→ W2（セッション一覧 + devlog）→ W3（操作）。続けて進め、PR は分ける。
7. 費用: 0 円（Tailscale の個人プランの範囲。外部サービスは増えない）。運用コストは `tailscale serve` を 1 回打つことと、env に 2〜3 変数。

## 1. 確認した事実

- 確認（`src/serve/static-server.ts`）: `allowedLogin` が**任意**で、あるときだけ `req.headers["tailscale-user-login"]` との完全一致で 403。`server.listen(port, host)`（host は main.ts が 127.0.0.1）。GET/HEAD だけ。log はリクエストごとに出さない。テストは `port: 0` で待ち受けて `server.address().port` を使う（`test/static-server.test.ts`）。
- 確認（Tailscale KB 1312）: serve が付けるのは `Tailscale-User-Login`・`Tailscale-User-Name`・`Tailscale-User-Profile-Pic`。Funnel には付かない。同じポートを Serve と Funnel で同時に使えない。KB 1242: `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`。
- 設計上の事実: このヘッダは tailscaled が付けるので、**127.0.0.1 に直接つなげる同じ OS ユーザーのプロセスは偽装できる**（今の静的サーバーと同じ前提）。sandbox の中の Bash は `/tmp`・`/run` を読めずネットも GitHub・npm だけなので届かない（shell-check で確認済み）。
- 確認（`src/app/handler.ts`）: `Handler` は `handleMessage(IncomingMessage)`・`continueTurn(guildId, channelId, at)`・`abortTurn`。`continueTurn` は内部の `submit({ guildId, channelId, kind: "session", content: CONTINUE_PROMPT, at })` を呼ぶだけで、**返信先無し・添付無し**でオーナーの発言と同じ経路（日時ヘッダ・キュー・turn.ts・返信は `gateway.send(channelId, text, replyToId)`）を通る。`handleMessage` は `event.id` を `replyToId` と添付の `messageId` に使う。
- 確認（`src/app/access.ts`）: `ResolveChannel = (guildId, channelId) => ChannelKind | null`。#inbox の ID は /setup 済みなら DB（`guild_settings` / `persona_channels`）、無ければ env の `SELF_AGENT_INBOX_CHANNEL_ID`。
- 確認（`src/app/commands/tasks.ts`）: `createTasksComponent` の [完了] は `tasks.complete(id).result === "completed"` を数えて `taskListMessage(deps)` で書き換えるだけ。`taskLine`・`taskListMessage` は export 済み。
- 確認（`src/app/commands/reminders.ts`）: `/reminders` の [止める] は `reminders.cancel(id)`、[次の回を飛ばす] は `nextOccurrence(reminder.rule, new Date(reminder.nextAt), cfg.timeZone)` を計算して `reminders.skipNext(id, next)`（**この計算はコンポーネントの中に inline**）。発火のメッセージのボタン（`rem:done`・`rem:stop`）は `fire_seq` を持つのでメッセージに紐づく。`reminderLine`・`reminderListMessage` は export 済み。
- 確認（store）: `TaskStore.list(options)`・`complete(id)`・`update(id, changes)`。`ReminderStore.listActive(limit)`・`get`・`cancel(id, expectedSeq?)`・`skipNext(id, nextAt)`・`nextForTasks`。`UsageStore.listRecent(options)`・`summarize(since, persona?)`・`sumOutputTokens`。`TopicSessionStore.listByState(guildId, state, limit)`・`listUndeleted(guildId)`。
- 確認（表示の純関数）: `src/app/usage-report.ts`（`formatUsageEntry`・`formatUsageTotals`・`entryTokens`）、`src/app/commands/usage.ts`（`usageText`・`attachmentTotalsLine`）、`src/app/commands/sessions.ts`（`sessionLine`・`sessionListText`）、`src/devlog/format.ts`（`parseDevLog`・`selectDevLogRecords`・`formatDevLogRecord`）、`src/devlog/log.ts`（`devLogDir`）。
- 確認（状態の材料）: `DiscordGateway.connected()`・`selfUserId()`、`ShellState.enabled()`、`KeyedSerialQueue.runningSessionJobs()`（**待ちの数を返すものは無い**）、`StaticServer.listening()`。`GithubPoller` は `start/stop/idle/tick` だけで**状態を返すものは無い**。`PersonaStatus` は足した人格の接続を tick ごとに refresh する。
- 確認（`templates/web/site/base.css`）: 変数と部品の CSS。`scaffold.ts` の `WEB_TEMPLATE_DIR` が絶対パスを持つ（配信するだけなら複製は要らない）。
- 未確認: `tailscale serve` 越しに SSE（長いストリーム）が通るか → W1 では使わない（polling）。serve が `X-Forwarded-Proto` を付けるか → 使わない（Cookie は常に `Secure`）。

## 2. 決定事項

| 項目 | 決定 | 根拠 |
|---|---|---|
| 入口 | **別ポート** `SELF_AGENT_WEB_PORT`（1〜65535。`127.0.0.1` だけ）。`tailscale serve --bg --https=9444 http://127.0.0.1:<port>` | LLM が書いたページ（`/p/`）と同じオリジンにしない（素案 §3.1） |
| 有効の条件 | `SELF_AGENT_WEB_PORT` と **`SELF_AGENT_WEB_ALLOWED_LOGIN` の両方**。どちらかが無ければ Web UI は起動しない（設定エラーではなく無効。log 1 行）。形の誤り（ポートの範囲外・空のログイン）は設定エラー | 読める情報と操作があるので本人確認を必須に |
| 認証 1 | `Tailscale-User-Login` が `SELF_AGENT_WEB_ALLOWED_LOGIN` と完全一致 | 静的サーバーと同じ比較 |
| 認証 2 | `SELF_AGENT_WEB_TOKEN`（任意。32 字以上・空白なし。短ければ設定エラー）。`GET /login` のフォームに貼ると `POST /login` が Cookie `self_agent_web`（値は `HMAC-SHA256(token, "self-agent-web:v1")` の hex。`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=30 日`）を返す。以後は Cookie が一致（`timingSafeEqual`）すれば通す。失敗は 1 分に 5 回まで（プロセス内。超えたら 429） | Tailscale 以外の VPN・手元の確認用。トークンそのものは Cookie に入れない |
| 両方無いとき | 401（API）/ `/login` へ 302（画面）。`SELF_AGENT_WEB_TOKEN` が無ければ `/login` は 404 | — |
| CSRF | POST は (1) `Sec-Fetch-Site: same-origin`、(2) `X-Self-Agent: 1`、(3) `Content-Type: application/json` の 3 つ全部。GET は読み取りだけ。`/login` の POST だけは (2)(3) の代わりに `application/x-www-form-urlencoded` + (1) | 別ポートでも同じ site なので要る |
| 応答ヘッダ | `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`（API）/ `no-cache`（画面・CSS） | 外部のアセットは読まない |
| 技術 | 素の HTML + `fetch`。`src/web/server.ts`（ルータ・認証・CSRF・JSON）、`src/web/pages/*.html`（各ページの JS は数十行・inline でなく `/static/*.js`。CSP に `'unsafe-inline'` を足さない）、`templates/web/site/base.css` を `/static/base.css` で配る（複製しない） | 依存は 3 つのまま |
| 更新 | polling（状態は 10 秒・一覧は開いたとき。間隔は実装者） | SSE は未確認 |
| 範囲 | 状態・usage・セッション一覧・devlog・タスク・リマインド・#inbox への投稿。**env の編集は載せない**（状態に「設定の有無」だけ） | オーナーの決定 3 |
| 操作の主体 | 認証を通った人 = オーナー。操作の記録（usage・log）は Discord の操作と同じ扱い | 1 人用 |
| log | リクエストごとに出さない。認証の失敗は種類だけ（ヘッダの値・Cookie・トークンは出さない）。本文（#inbox の投稿）も出さない | CLAUDE.md の規約 |
| 静的サーバーとの関係 | 別サーバー・別ポート・別の serve。`SELF_AGENT_SERVE_*` には触らない。`build-and-serve.md` の決定（`/p/` は CSP 無し・`/` は一覧）は変えない | — |

## 3. 設計

### 3.1 配線（W1）
- `main.ts` は `config.web`（`port`・`allowedLogin`・`token?`）があるときだけ `createWebServer(deps)` を作り、静的サーバーと同じく起動に失敗しても Bot は動かし続け、停止（shutdown.ts）で閉じる。`deps` は読む対象（store・`ShellState`・gateway の `connected()`・queue・`StaticServer.listening()`・`cfg`）と、W3 で `handler`・`tasks`・`reminders`。
- `src/cli.ts`（D1）に Web は要らない（同じプロセスの中）。

### 3.2 認証の流れ
1. 127.0.0.1 以外から来た接続は無い前提（bind が 127.0.0.1）。それでも `req.socket.remoteAddress` が loopback でなければ 403（防御の 2 段目）。
2. `Tailscale-User-Login` が一致 → 通す。
3. 違う・無い → Cookie を見る（`SELF_AGENT_WEB_TOKEN` があるときだけ）。一致 → 通す。
4. どちらも駄目 → 401 / 302。

### 3.3 画面と API
| 画面 | GET（読む） | POST（変える。CSRF 3 条件） | 材料 | 段 |
|---|---|---|---|---|
| `/`（状態） | `/api/status` → `{ version, startedAt, bots: [{ persona, name, connected }], shell: { enabled, items }, queue: { runningSessionJobs }, serving, devMode, github: { enabled } }` | — | §1 の状態の材料。`version` は package.json。GitHub の最後の tick・失敗は W2 で `GithubPoller` に getter を足して出す | W1 |
| `/usage` | `/api/usage?date=YYYY-MM-DD&last=N&kind=` → `UsageStore.listRecent` の行（`entryTokens`）と `summarize` の合計（人格ごと）。既定は今日・20 件 | — | `npm run usage`・`/usage` と同じ範囲の情報 | W1 |
| `/sessions` | `/api/sessions?guild=` → `listByState` × 3（上限は `SESSION_LIST_LIMITS`）。各行に題名・状態・最終発言・人格名・Discord のリンク `https://discord.com/channels/<guild>/<channel>` | — | `sessionLine` の材料 | W2 |
| `/devlog` | `/api/devlog?date=&kind=&channel=&persona=&last=`。`SELF_AGENT_DEV_MODE=1` でなければ 404 | — | `parseDevLog`・`selectDevLogRecords`・`formatDevLogRecord`（表示は文字列のまま `<pre>`） | W2 |
| `/tasks` | `/api/tasks?status=open\|done\|dropped` → `TaskStore.list` + `nextForTasks` | `/api/tasks/<id>/complete` | §3.5 | W3 |
| `/reminders` | `/api/reminders` → `listActive(50)` | `/api/reminders/<id>/cancel`・`/api/reminders/<id>/skip` | §3.5 | W3 |
| `/inbox` | `/api/inbox/targets` → /setup 済みのサーバーの #inbox（既定の人格だけ） | `/api/inbox` `{ guildId, text }` → 202 `{ accepted: true, link }` | §3.6 | W3 |
| `/login` | フォーム（`SELF_AGENT_WEB_TOKEN` があるときだけ） | トークン → Cookie | §2 | W1 |
| `/static/base.css`・`/static/*.js` | 同梱のファイル | — | — | W1 |

- 応答は JSON（`application/json; charset=utf-8`）。ID（サーバー・チャンネル）は Discord のリンクを作るために返す（Web は本人だけが見る。log には出さない）。
- 知らないパス・メソッドは 404 / 405。本文は 64 KB まで（超えたら 413）。

### 3.4 W1 の土台（`src/web/`）
- `server.ts`: `createWebServer({ host, port, allowedLogin, token?, deps, log }) => { start(), stop(), listening() }`。ルータは「メソッド + パスの前方一致」の小さな表。認証・CSRF・ヘッダは全ルートに共通の前処理。
- `auth.ts`: 純関数 `authenticate(headers, cookies, cfg) => "login" | "cookie" | "none"`、`cookieValueFor(token)`、`csrfOk(headers)`、失敗の回数の窓。
- `routes/*.ts`: 画面ごとに 1 ファイル（`status.ts`・`usage.ts` …）。store を読む関数は純関数に近い形にしてテストする。
- `pages/*.html`・`static/*.js`: `fetch("/api/…", { headers: { "X-Self-Agent": "1" } })`。スマホの幅を基準（`base.css` の変数と部品だけで組む）。

### 3.5 操作を Discord のボタンと共有する（W3）
- タスクの完了: `tasks.complete(id)` を直接呼ぶ（`createTasksComponent` はこれと `responder.update` だけなので、共有するのはストアの呼び出し。結果 `completed | already | not_found` をそのまま JSON に）。
- リマインドを止める: `reminders.cancel(id)`（seq 無し = `/reminders` の [止める] と同じ）。`active` でなければ 409（Discord の「古くなっています」に相当）。
- 次の回を飛ばす: `reminders.ts` の inline の計算を **`skipNextOf(reminders, id, timeZone) => { skipped, next } | "stale"`** として `src/app/reminders-ops.ts`（純関数 + store）に出し、Discord のコンポーネントと Web の両方がそれを呼ぶ（W3 の最初の PR で抜き出し、Discord 側の振る舞いは変えない。既存のテストで確かめる）。
- 発火のメッセージのボタン（`rem:done`・`rem:stop`・snooze）は **Web には置かない**（メッセージと `fire_seq` に紐づく操作。Web からは「止める」「次を飛ばす」だけ）。
- タスクの追加・編集・リマインドの追加は Web に置かない（#inbox に書けば Bot が `task_add`・`reminder_set` を使う。Web の範囲を「一覧と確認の操作」に留める）。

### 3.6 #inbox への投稿（W3）
- Discord の発言ではないので `IncomingMessage` を偽造しない（`event.id` が返信先と添付の ID に使われ、存在しないメッセージへの返信になる）。代わりに **`Handler.submitText(guildId, channelId, content, at)`** を足す: `continueTurn` と同じ内部の `submit` を、`kind` は `resolveChannel(guildId, channelId)`（`null` なら何もしない）、`content` は渡した本文、返信先無し・添付無しで呼ぶ。日時ヘッダは `at`（押した時刻）で handler が付ける（`[<日時> #inbox]`。Discord の発言と同じ）。
- 対象は /setup 済みのサーバーの**既定の人格の #inbox**だけ（W3）。足した人格の #<NAME> は後（持ち主の Bot の選択が要る）。
- 返事は Discord の #inbox に出る（Web には出さない）。API は 202 と Discord のリンクをすぐ返し、ターンの完了は待たない（ターンは最長 300 秒。serve 越しの長い待ちを避ける）。本文は 2,000 字まで（Discord の発言と同じ上限）。
- 二重送信: 同じサーバー・同じ本文が 5 秒以内なら 2 回目は 202 のまま捨てる（プロセス内）。
- usage の種類は `inbox`（Discord の発言と同じ）。log は「Web から #inbox に投稿しました（guild=…）」だけで本文は出さない。

## 4. 段

| 段 | 内容 | PR |
|---|---|---|
| W1 | `config.web`・`src/web/`（server・auth・routes の status・usage・login・static）・`main.ts` の配線・`shutdown` で閉じる・README の節（`tailscale serve --https=9444`）・CLAUDE.md の `web/` と環境変数 | 1 |
| W2 | sessions・devlog の API と画面。`GithubPoller` に状態の getter（最後の tick・失敗の種類）を足して status に出す | 1 |
| W3 | `reminders-ops.ts` の抜き出し → `Handler.submitText` → tasks・reminders・inbox の API と画面 | 2〜3（抜き出し / submitText / 画面） |

## 5. 受け入れ条件

単体（`npm test`。`port: 0`・偽の store・ネット無し）:
- W1: `SELF_AGENT_WEB_ALLOWED_LOGIN` が無ければ `createWebServer` を作らない（config は `web: undefined`）。ポートの範囲外・トークンが 32 字未満は設定エラー。ヘッダ一致で 200、不一致・無しで 401（API）/ 302（画面）。Cookie が一致で 200、違う値で 401。`/login` はトークンが無ければ 404、間違いを 6 回で 429。POST は 3 条件のどれか 1 つが欠けると 403（`Sec-Fetch-Site: same-site`・`cross-site`・無し、ヘッダ無し、`text/plain`）。全応答に CSP・`X-Frame-Options`・`nosniff`。`/p/` と知らないパスは 404。log にヘッダの値・Cookie・トークンが出ない（偽の log を全部見る）。`/api/usage` の行が `npm run usage` と同じ数字。
- W2: `/api/devlog` は `devMode` が false なら 404。日付の形が違えば 400。セッションの行に Discord のリンクと人格名。
- W3: `complete` が `completed` / `already` / `not_found` を返し、2 回目は `already`。`cancel`・`skip` が `active` でなければ 409。`skipNextOf` の結果が Discord のコンポーネントと同じ（既存の reminders のテストが抜き出しの後も通る）。`submitText` が `resolveChannel` で `null` なら何もしない、#inbox なら `kind: "inbox"` で偽 runner に `[<日時> #inbox]` 付きの prompt が届き、返事が偽 gateway の #inbox に出る。2,001 字は 400。5 秒以内の同じ本文は 1 回。
- 共通: `npm run check` が通る。依存が 3 つのまま。

実機（Ubuntu。オーナー。結果は #157 に）:
- W1: `tailscale serve --bg --https=9444 http://127.0.0.1:<port>` の後、スマホで `https://<host>.<tailnet>.ts.net:9444/` が開き状態と usage が見える。`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/api/status` が 401。9443 の `/p/` は今までどおり。
- W3: Web でタスクを完了にすると Discord の `/tasks` から消える。Web から #inbox に投稿すると Discord の #inbox に日時ヘッダ付きの 1 ターンの返事が出る。

## 6. 決めてもらうこと（推し付き）

1. **Cookie の有効期間**: 30 日（推し）か、ブラウザを閉じるまでか。
2. **#inbox への投稿の対象**: 既定の人格だけ（推し。W3）か、足した人格の #<NAME> も最初から入れるか。

実装者が決めてよいこと: ルータの作り、ページの見た目（base.css の範囲で）、polling の間隔、`/api/status` の項目の名前、失敗の回数の窓の持ち方、`reminders-ops.ts` の名前。
