# Claude Code のセッションを会話欄に統合し、セッションごとの Discord のチャンネルで続ける（確定版）

> 関連 issue は #236。CC1〜CC8 は `docs/plan/claude-code-sessions.md`。

> 2026-11-05。spec-writer。v1（案）→ **v2（確定版。オーナーの決定 §9 を反映）**。`docs/plan/claude-code-sessions.md`（確定版。CC1〜CC8 は実装・マージ済み。DB は v35）の上に載せる。関連 issue は #191（実装は新しい issue を立てる）。
> 「確認」= 2026-11-05 に main（9923007）のコードで確かめた事実。「推測」= コードでは確かめていない前提。「未確認」= 実機で確かめるまで前提にしない（§11）。
> セッション名・パス・ID・ポートは書かない。

## 0. 目的・範囲・結論

目的（オーナーの要望）:
1. 「Console（tmux）で実行している Claude Code も会話欄に統合したい」= Web UI の会話の一覧に、この機械の Claude Code のセッションが、#inbox・セッションのチャンネルと並んで出る。
2. 「Discord にはセッションに従ってチャンネルを追加してもいいし、そこで継続もできるようにしたい」= Claude Code のセッションに Discord のチャンネルを 1 つ結びつけ、そこへの発言がそのセッションに届き、返事・許可の要求がそこに戻る。セッションが終わっても、そのチャンネルで続けられる。

範囲:
- 対象は今の CC1〜CC8 の仕組み（`claude agents --json`・hooks・tmux への貼り付け・許可の保留・返事の追いかけ）の上だけ。送る条件（idle・claude のペイン）、許可の応答の形、hook の受け口は**変えない**。
- Mac の Claude Code・RC のサーバーモード・tmux の外のセッションは対象外（見るだけのまま。チャンネルは作れない）。
- 人格は既定の人格だけ（§3.8）。ゲストは対象外。

結論:
1. **Web の会話の一覧に群「Claude Code」を足す**（§2）。並びは今の 判断待ち → 実行中 → 最近の指示 のまま 1 つの群に出し、判断待ちは点、実行中はスピナー、Discord のチャンネルがあるものは `#` の印。タブは、チャンネルの無いセッションは今の Claude Code のタブ、チャンネルのあるセッションは**会話のタブ**（history。CC14）。「Claude Code」のアクティビティは消す（起動・起動中の表示も群に移す）。
2. **チャンネルは、オーナーがそのセッションに「関わった」ときに自動で作る**（§3.1。決定 1）。関わった = Web から送った・Web から起動した・許可に答えた・`cc_send` / `cc_start` の確認で [送る] / [起動する] を押した・GitHub の [対応] で送った、のどれか 1 回。一覧を見た・タブを開いた・写しを読んだだけでは作らない。手動の口（Web のタブの [Discord のチャンネルを作る]・`/cc open`）も残す。
3. チャンネルは `/setup` が作る**カテゴリ「Claude Code」**に `cc-<名前>` で作る。そこへのオーナーの発言は**確認なしで** `cc_sends`（`origin: 'discord'`）に積み、CC3 の条件で届ける（§3.3）。チャンネルの外から積んだ送信（Web・ツール・GitHub）は本文をチャンネルに写してから届ける。届け待ち・届けた・届かなかった は**リアクション**で返す。
4. チャンネルのあるセッションの `Stop` の返事は**常に**そのチャンネルへ（CC8 の追いかけは、チャンネルを作れなかったときの代替として残す）。許可の要求・判断待ち・終了の知らせも #system ではなくそのチャンネルへ（§3.4・§3.5）。端末・RC から打った指示は「（端末か RC から）」で写す（決定 3）。
5. セッションが終わったらチャンネルは**完了カテゴリ**へ移して残し、`SELF_AGENT_DELETE_AFTER_DAYS` 日後に #system で削除の確認（セッションのチャンネルと同じ。決定 2）。同じ `session_id` が戻ってきたら（`claude -r`）同じチャンネルを開き直す。終わったチャンネルで発言すると [起動して続ける] で同じディレクトリに新しいセッションを起動し、そのチャンネルに結びつけ直す（§3.6）。
6. DB は **`cc_channels`（v36）**を足し、`cc_sends.origin` に `'discord'` を足す（表の作り直し。v37）。`cc_sessions.channel_id`（CC7 の「最後に頼んだチャンネル」）はそのまま（§4）。
7. 段: **CC9（Web の群）→ CC10（表・カテゴリ・作る口・再同期・終了と戻り）→ CC11（自動で作る・発言 → 送信・写し・印・返事）→ CC12（許可・判断待ち・端末の指示の写し）→ CC13（起動して続ける・/cc close・削除の確認）→ CC14（Web の会話のタブ）**（§7）。
8. 費用: 外部サービスは増えない（0 円）。増えるのは Discord の API 呼び出し（チャンネル作成・移動・リアクション・写し）と DB の表 1 つ。

## 1. 確認した事実（コード）と推測

### 1.1 Claude Code の連携（確認）
- `cc_sessions` は `session_id` が主キー。`gone_at` は一覧から消えたとき `markGone` が入れ、同じ `session_id` を再び一覧で見れば `upsertSeen` が `gone_at = NULL` に戻す（`src/store/cc-sessions.ts:156-195`）。**消えたことは `ended` で知らせるが、戻ったことを知らせる口は無い**（`src/cc/registry.ts:435-438`）。
- `cc_sessions.channel_id` は「最後に Discord から頼んだチャンネル」（CC7。`cc_send` の [送る]・`cc_start` の [起動する]）。`follow`・`follow_channel_id`・`follow_since`・`follow_last_stop_at`・`reply_count_day`・`reply_count` は CC8 の追いかけ。
- `cc_sends.origin` の CHECK は `'web','tool','github','start'` の 4 つ（`src/store/db.ts` の v28）。**SQLite は CHECK を後から変えられないので、`'discord'` を足すには表の作り直しが要る**。`channel_id`・`message_id` は確認の投稿のもの（CC7）。1 セッションに同時に持てる終わっていない送信（`awaiting_confirm`・`queued`・`delivering`）は 1 件（`activeFor`。`src/cc/sender.ts:187`）。
- 返事（`src/cc/replies.ts`）: `Stop` を受けたら `follow = 1` のセッションだけ `follow_channel_id` に持ち主の Bot（`ownerPosts`）で投稿し、最後の 1 通に [追いかけをやめる]。最初の返事は `send.messageId`（確認の投稿）への返信（`send.channelId === channelId` のとき）。1 日 `CC_REPLY_DAILY_LIMIT`（50）通。`history` の notice は `guildOf`（main の `webChannelLookup`。**受け付けるチャンネル（#inbox・#tasks・セッション）だけ**）が分かるときだけ書く（`src/main.ts:722-735`）。
- （Q4 より前の形。Q4（claude-code-questions.md §5）で `discord-notice.ts` の #system の経路を消し、文面は `notice-text.ts`。今の形は §3.5）許可の要求（`src/cc/discord-notice.ts`）: `SELF_AGENT_CC_NOTIFY` が 1 のときだけ作られ、**`SELF_AGENT_ALLOWED_GUILD_IDS` の順で最初の #system のあるサーバー 1 つ**に 1 通（`:422-423`）。出した場所は `cc_permissions.message_id`・`message_channel_id`（v32）。`permission-hold.ts` の `listen(listener)` は listener を 1 つ受ける（`:105`。複数にするなら変更）。`answer(id, decision, via)` の `via` は `web` / `discord`。判断待ちの知らせ・終了の知らせも同じクラス。
- hook の受け口は `UserPromptSubmit` の `prompt` を**受けた時点で先頭 200 字に切る**（`src/cc/hook-server.ts:146`・`CC_PROMPT_MAX_CHARS`）。
- `cc_send`・`cc_start` の確認（`src/app/commands/cc-confirm.ts`）: ボタンは [送る][やめる] / [起動する][やめる]。`cc_starts` に `channel_id`（頼んだチャンネル）。GitHub の [対応]（`src/app/github-handoff.ts`。CC6）は `cc_sends` に `origin github`・`notification_id` で積み、無ければ [起動して送る]。
- 起動（`src/cc/starter.ts`）: `SELF_AGENT_WORKSPACE_DIR` の**直下**の実際のディレクトリだけ。`check`（起動せず確かめる）と `launch`。起動したペインと一覧のセッションの結びつけは `cwd` が同じものだけ（結びつくまで `session_id` は無い）。
- Web（`src/web/static/sidebar.js:205-292`）: アクティビティ「Claude Code」に 起動中 / 判断待ち / 実行中 / 待機 の群と [Claude Code を起動]。行のバッジは最重要の 1 つ（許可待ち > 届け待ち > trust の確認待ち > tmux の外）。タブ `cc:<sessionId>`（`views.js:1086-1153`）は 見出し・許可のカード・セッションの表・画面の写し・送信の状態・入力欄。会話のサイドバー（`:88-106`）は 入口 / 進行中 / 待ち / 完了。

### 1.2 会話（チャンネル）の仕組み（確認）
- 受付（`src/app/access.ts`）: `resolveChannel` が #inbox / #tasks / #<NAME> / 削除されていないセッション 以外は `null` を返し、handler は何もしない（`handler.ts:506-508`）。**新しい種類のチャンネルを足すには、handler の前で振り分けるか `resolveChannel` を広げる**。main は `gateway.start({ handleMessage: handler.handleMessage, handleInteraction })` で 1 つの口を渡している（`main.ts:1011`）。
- 人格: `PersonaRouter.ownerOf` は `persona_channels` → `sessions.persona` に無いチャンネルを既定の人格にする（`personas.ts:65-68`）。`ownerPosts` はチャンネルごとに持ち主の Bot を選ぶ。
- カテゴリ: 状態カテゴリ（進行中 / 待ち / 完了）は `findStateCategory` が空きを探し、満杯なら `完了 2` を作る（`categories.ts`）。移動は `ChannelOpsQueue.enqueueMove`（全サーバーで直列。`topicSessions.setCategory` は行が無ければ何も変えない）。`/setup` は `ensureGuildLayout` が self-agent カテゴリ・#inbox・#tasks・#<NAME>・#system・#github・#jobs・状態カテゴリを「消えたものだけ」作る（`commands/setup.ts:103-198`）。カテゴリ「定型」の ID は `guild_settings.routine_category_id`（v20。同じ形で足せる）。
- 再同期（`scheduler.ts:212-258`）: `sessions` の削除されていない行のうち Discord に無いものを削除済みに、状態とカテゴリが合わないものを移し、入口のチャンネルを self-agent カテゴリへ戻す。**`cc_channels` は見ないので、同じことを足す**。
- 削除の確認（`scheduler.ts`）: 完了から `SELF_AGENT_DELETE_AFTER_DAYS` 日のセッションを `listDeleteDue` で引き、#system に [削除する][残す]（`del:`。`commands/delete.ts`）。`sessions` だけ。
- Web の会話: `GET /api/channels`（`routes/channels.ts`）は `WebChannel.kind` が `inbox | tasks | session`。`webChannelLookup` は `resolveChannel` が null なら undefined（/turns・/messages・/renew・リマインドの表示名で共通）。Web の発言は `handler.submitText` が「（Web から）」の echo を投稿してから積む。`history` は `kind owner / agent / notice / divider`・`source discord / web / system`・`outcome` は NULL 可（`db.ts` v25）。`chat.js` のタブは `ch:<channelId>`。
- Gateway（`src/discord/gateway.ts`）: `sendMessage`（ID を返す）・`editMessage`・`createTextChannel`・`moveChannel`・`deleteChannel`・`listChannelParents`・`countChannelsIn` はあるが、**リアクションを付ける・外す口は無い**。

### 1.3 推測・未確認
- `claude -r <id>`（対話の resume）で同じ `sessionId` のまま再び `claude agents --json` に出る（推測。出なければ「戻った」は起きず、§3.6 の [起動して続ける] だけになる。害は無い）。
- Discord のチャンネルの名前・topic の変更は 1 チャンネル 10 分に 2 回まで（Discord の API の制限。推測）。名前を追いかけない理由の 1 つ。
- リアクションの追加は 1 回ごとに短い間隔の制限がある（推測）。1 発言に 2 回なので問題にならない見込み。
- self-agent が貼った本文の `UserPromptSubmit` は Enter の直後（約 70 ms）に届く（確定版 §1.4 の確認）。§3.5 の「写さない」判定はこれに頼る。

## 2. Web の会話欄への統合（論点 1。決定 4・5）

### 2.1 比較
| | **A: 群「Claude Code」を会話の一覧に足す** | B: Discord のチャンネルがあるものだけ「進行中」などに混ぜる | C: 全部混ぜて印で区別 |
|---|---|---|---|
| 判断待ち → 実行中 → 最近の指示 の並び | ◎ 群の中でそのまま | ✗ セッションの群は状態ごと・作成順。混ぜると両方の並びが崩れる | ✗ 同じ |
| チャンネルの無いセッション | ◎ 同じ群に出る（印なし） | △ 「Claude Code」のアクティビティに残る（2 か所） | ◎ |
| 一目で「Claude Code か Bot のセッションか」 | ◎ 群で分かる | △ 印に頼る | ✗ 印だけ |
| 実装 | ◎ `renderCc` の中身を `chatList` に移すだけ（CC9） | △ 2 か所の描画と並びの規則 | △ |
| スマホ（群を閉じられる） | ◎ `details` で閉じられる | △ | ✗ |

**A を採る（決定 4）。** 置く位置は 入口 → **Claude Code** → 進行中 → 待ち → 完了（入口の次。判断待ちをいちばん上に近づける）。

### 2.2 決定
- 群「Claude Code」: 行は今の `ccRow`（名前・バッジ 1 つ・判断待ちの点・実行中のスピナー・経過）に、**Discord のチャンネルがあるものは左のアイコンを `hash`** にする（無いものは空の箱）。群の見出しの数は判断待ちの数（0 なら全体の数）。群の中の順は `rankSessions`（確定版 §2.2）のまま。起動中（`starting`）は群の先頭に静的な行。群の下に [Claude Code を起動]（起動のダイアログは今のもの）。一覧を読めないときの注記（stale / unreadable）は群の中の 1 行。
- 行を押すと: チャンネルが無ければ `cc:<sessionId>`（今のタブ）、あれば `ch:<channelId>`（会話のタブ。CC14 まではこちらも `cc:<sessionId>` で、見出しに [Discord で開く] を足す）。
- 「Claude Code」のアクティビティは**消す**（決定 5。`sidebar.js` の `ACTIVITIES` から外し、`renderCc` を `chatList` の群に移す。`/api/status` の `cc.enabled` が false なら群ごと出さない）。コマンドパレットの「Claude Code を起動」は残す。hash `#/cc/<sessionId>` は今のタブのために残す。
- 絞り込み（検索欄）は Claude Code の行の名前・ディレクトリにも効かせる。
- polling: 会話のサイドバーを出している間は `/api/cc/sessions` を今の Claude Code のアクティビティと同じ周期（10 秒。保留中の許可があれば 3 秒）で読む（`SA.poll.kickCc` を会話のサイドバーから呼ぶ）。出していないときは読まない（サーバー側の `touch()` の周期の切り替えはそのまま効く）。
- 未読の点（`seen`）は Claude Code の行には付けない（history が無い。CC14 でチャンネルのある行だけ付く）。
- スマホの下のバー（固定 4 タブ + その他、一覧は全幅）は別の設計で決める。**会話の一覧に Claude Code の群が入る前提は変わらない**（決定 5）。本書は下のバーの形に依存しない。

## 3. Discord のチャンネル（論点 2）

### 3.1 作る条件（決定 1）
| | A: 一覧の全部に自動 | B: オーナーが選んだときだけ（Web・/cc open） | **C: 関わったら自動（+ 手動の口）** |
|---|---|---|---|
| チャンネルの数 | ✗ tmux の二十数本に二十数チャンネル。使わないものが並ぶ | ◎ 要るものだけ | ○ 関わったものだけ。見ただけでは増えない |
| 「そこで継続」の手間 | ◎ 無い | △ 毎回 1 回選ぶ | ◎ 関わった時点でできている |
| #inbox で頼んで #inbox で読む（CC8） | ✗ 消える | ◎ 残る | △ 返事はチャンネルへ。頼んだチャンネルには「<#…> に出ます」の 1 行 |
| 実装 | △ 一覧の差分で作る | ○ 2 つの口 | ○ きっかけ 6 つ + 手動 2 つ |

**C を採る（オーナーの決定）。** 「関わった」の定義（どれか 1 回で作る。既にあれば何もしない）:

| # | きっかけ | 作る時点 | `cc_channels.origin` |
|---|---|---|---|
| 1 | Web の入力欄から送った | `cc_sends` の行（`origin web`）を `queued` で作った直後（届く前） | `web_send` |
| 2 | Web から起動した | 起動したペインが一覧のセッションと**結びついたとき**（`session_id` が分かる。trust の確認待ちの間は作らない） | `web_start` |
| 3 | 許可に答えた（Web のカード、または #system・チャンネルのボタン。[許可][常に許可][拒否] のどれか。時間切れ・他で答えられた・停止は含めない） | 応答を返した直後 | `permission` |
| 4 | `cc_send` の確認で [送る] を押した | `queued` にした直後 | `tool_send` |
| 5 | `cc_start` の確認で [起動する] を押した | 2 と同じ（結びついたとき） | `tool_start` |
| 6 | GitHub の [対応] で送った（[起動して送る] を含む） | 送信を積んだ直後（起動なら結びついたとき） | `github` |
| 手動 | Web のタブの [Discord のチャンネルを作る]・`/cc open` | 押したとき | `web` / `command` |
| 知らせ（Q4） | 許可の要求・質問・60 秒の判断待ち（`docs/plan/claude-code-questions.md` §5。`SELF_AGENT_CC_NOTIFY=0` なら作らない） | 保留を始めた直後・判断待ちを知らせるとき（**tmux の外のセッションにも作る**。最初の投稿と発言の返信に「このセッションは tmux の外なので、ここからは送れません（RC で開いてください）」） | `permission` / `question` / `waiting`（v39） |

- 作れないとき（/setup 前・満杯・Discord の失敗・一覧に無い・関わったきっかけで tmux の外）は **log だけ**（同じ理由は 1 時間に 1 回。Q4 で #system の 1 行をやめた）。

作らない: 一覧を見た・タブを開いた・画面の写しを見た・写し（§3.5）を読んだ・判断待ちの知らせを受けた・`cc_list`。許可の要求が**来た**だけ（答えていない）も作らない（答えたら作る。その要求の 1 通は #system に出たまま、結果の行はそこで書き換える）。

どのサーバーに作るか: きっかけが Discord なら**そのサーバー**。Web・GitHub の [対応]（Web から）なら `SELF_AGENT_ALLOWED_GUILD_IDS` の順で最初の /setup 済み（カテゴリ「Claude Code」がある）サーバー（#system の知らせと同じ規則）。手動の Web の口は、/setup 済みのサーバーが複数なら選ばせる。

作るときの流れ（`src/cc/channels.ts` の `openChannel(guildId, sessionId, origin)`）: `/setup` と同じ `layoutQueueKey(guildId)` のキューで → 既にそのセッションの削除されていない行があれば `exists`（終わっていれば開き直す。§3.6）→ 対象が `claude agents --json` に居て tmux の中（`findSendablePane` が当たる）でなければ `not_in_tmux` → カテゴリ「Claude Code」（`guild_settings.cc_category_id`）が無い・消えていれば `not_set_up` → 中のチャンネルが 50 なら `full` → `createTextChannel` → `cc_channels` に行 → 最初の投稿「Claude Code のセッション「<名前>」（<ディレクトリ>）のチャンネルです（<きっかけ>で作りました。きっかけがボタン・コマンドの名前で終わるときだけ空白を挟む）。ここに書くとこのセッションに届きます。返事と許可の要求はここに出ます」（名前・ディレクトリは `escapeDiscordText`）→ 結果。DB の保存に失敗したら、セッションのチャンネルと同じくチャンネル ID を log に出す（log 方針の例外）。

作れなかったとき（`not_set_up`・`full`・Discord の失敗・tmux の外）: **きっかけの処理は止めない**（送信は積まれ、起動は進み、許可の応答は返る）。返事は CC8 の追いかけの規則（頼んだチャンネルへ。Web だけのものは出ない）、許可の要求はチャンネルが無ければ log だけ（保留は続き、Web と端末・RC で答える）。log に 1 行（理由だけ。同じ理由は 1 時間に 1 回）。**Q4（docs/plan/claude-code-questions.md §5）からは #system には出さない**（Q4 より前は許可の要求を #system に出し、`not_set_up`・`full`・Discord の失敗も #system に 1 行出していた）。自動の再試行はせず、**次に関わったときにまた試す**。手動の口は理由を応答に出す（Web は 404 `not_found`（一覧に無い）/ 409 `exists` / 409 `not_in_tmux` / 409 `full` / 503 `not_set_up` / 502 `failed`（Discord の失敗）、`/cc open` は本人にだけ）。

### 3.2 カテゴリ・名前・topic
- カテゴリ「Claude Code」は `/setup` が状態カテゴリの後に作る（`cfg.cc` が true のときだけ。消えたものだけ作り直す。ID は `guild_settings.cc_category_id`）。再同期は開いているチャンネルをここへ戻す。満杯（50）なら作らずに断る（`Claude Code 2` は作らない。開いているチャンネルは生きているセッションの数（`SELF_AGENT_CC_MAX_SESSIONS` 既定 30）以下で、終わったものは完了へ移すため）。
- 名前: `cc-<normalizeChannelName(セッション名)>`（名前が無ければ `cc-<ディレクトリの最後の名前>`。100 字で切る。同じ名前が開いていれば `-2`, `-3`）。**作った後は名前を追いかけない**（セッションのチャンネルと同じ規則。名前の変更の制限もある。§1.3）。
- topic: `Claude Code: <名前>（<ディレクトリ>）`。結びつけ直し（§3.6）のときだけ書き換える。
- 持ち主は既定の人格。投稿・リアクションは既定の人格の Bot（`ownerPosts` は既定の人格を返す）。

### 3.3 チャンネルへの発言 → セッションへ送る（CC11）
- 受付（`src/cc/channels.ts` の `handleMessage`。main が `gateway.start` の `handleMessage` を「cc のチャンネルなら channels、それ以外は handler」に包む。`access.ts`・`handler.ts` は変えない）: 許可サーバー・オーナー本人・Bot と Webhook でない・既定の人格の Bot で受けた・`cc_channels` に `state` が `open`・`resuming`・`ended` の行がある（`resuming` は §3.6 で断り、`ended` は [起動して続ける] を出す）。それ以外は今までどおり handler へ。**SDK のターンは動かさない**（LLM を呼ばない）。
- 本文: `normalizeSendText`（1〜4,000 字・LF 以外の制御文字なし。Discord は 2,000 字（Nitro は 4,000 字。それでも上限の内）なので普通は上限に当たらない）。通らなければ本人の発言への返信で理由（「改行のほかの制御文字は送れません」など）。添付だけの発言は「画像・ファイルは送れません」。
- 送信: **確認を挟まない**（オーナーの直接の操作。§6）。`cc_sends` に `origin: 'discord'`・`channel_id`（このチャンネル）・`message_id`（オーナーの発言）で `queued`。届け方は CC3 のまま（idle を 2 回・貼る・確かめて Enter。作業中なら積む。`SELF_AGENT_CC_SEND_WAIT_MIN` で `gave_up`）。
- 続けて書いたとき: **同じセッションに `origin: 'discord'` の `queued` を `CC_CHANNEL_QUEUE_MAX`（5）件まで積める**（古い順に 1 件ずつ届ける。**同じセッションで `delivered` にした直後は、その pass では次の `queued` を試さない**（次の `Stop` か 30 秒後の pass で試す。届けた直後の画面がまだ idle に見えても続けて貼らない）。1 件届けると `busy` になるので、次は次の idle で届く）。6 件目は返信で「届け待ちが 5 件あります。届いてから送ってください」。Web・ツールからの送信の「1 セッション 1 件」はそのまま（`activeFor` の判定を origin で分ける。チャンネルの列が空でないときの Web・ツールの送信は `already_queued`）。
- **チャンネルの外から積んだ送信の写し**（チャンネルがあるセッションへの、Web の入力欄・`cc_send` の [送る]・GitHub の [対応]・起動の最初の指示）: 積んだ直後に、本文をチャンネルに「（Web から）」/「（<#頼んだチャンネル> から）」/「（#github の [対応]）」/「（起動の最初の指示）」+ 改行 + 本文で投稿し（2,000 字を超える分は 2 通目以降に。メンション無効・埋め込み無し）、**その投稿の ID を `cc_sends.message_id` にする**（印と返事の返信先）。`cc_send` の確認の投稿はそのまま残し、結果に「返事は <#チャンネル> に出ます」を足す。写しの投稿に失敗しても送信は止めない（印と返信先が無いだけ。log 1 行）。自動で作った直後の最初の送信も同じ（作る → 写す → 積む の順。作れなければ写さずに積む）。
- 届け待ちの印（**リアクション**。Gateway に `addReaction(channelId, messageId, emoji)`・`removeOwnReaction` を足す）:
  | 状態 | 印 | 文 |
  |---|---|---|
  | `queued`（作業中で待っている） | ⏳ | 無し（静かに待つ。`dialog` で待っているときだけ 1 回「ダイアログが出ているため待っています（端末か RC で答えてください）」を返信） |
  | `delivered` | ⏳ を外して ✅ | 無し |
  | `unconfirmed` | ⚠️ | 返信「届いたかを確かめられませんでした。画面で確かめてください」 |
  | `failed`・`gave_up` | ❌ | 返信「送れませんでした（<理由>）」/「入力待ちにならなかったため、届けるのをやめました」 |
  | `cancelled`（`/cc cancel`・Web の [やめる]） | ⏳ を外す | 無し |
  リアクションの失敗は log だけ（送信は止めない）。
- 届いたかの確かめ（実機の通し確認の後に直した）: Enter の 2 秒後の画面が `dialog`（Enter の直後に許可・案内のダイアログが出た）でも、貼った本文が入力欄から消えていれば（入力欄が無いか、本文の先頭も `[Pasted text` の印も無い）`delivered`。さらに `unconfirmed` の送信は、貼り始めた後（終わった後は 30 秒以内）にそのセッションの `UserPromptSubmit` の `prompt` が本文（`singleLine` の後・空白を正規化・先頭 200 字）と同じなら `delivered` に直し、印を ⚠️ から ✅ に付け替える（返信は足さない）。
- `/cc cancel`（チャンネルの中で。本人にだけ）: そのセッションの `queued` を全部 `cancelled` に。無ければ「届け待ちはありません」。
- 二重送信の規則（5 秒の同一本文）はそのまま。再起動で `delivering` のまま残った行は `unconfirmed`（印は再起動の後に付け直す）。

### 3.4 返事（`Stop`）をチャンネルへ（CC11）
- `replies.ts` の投稿先を **「そのセッションの開いている `cc_channels` の行 → 無ければ CC8 の `follow_channel_id`」** にする。チャンネルがある間は `follow` を見ない（常に出す）。[追いかけをやめる] は付けない（チャンネルの目的そのもの。止めたければ `/cc close`）。
- 形は CC8 のまま（「返事（hook）:」+ 本文。チャンネルでは名前を省く。1 通 1,800 字 × 3 通。メンション無効・埋め込み無し・masked link を崩す）。**最初の返事は、その送信の `message_id`（オーナーの発言か写し）への返信**（CC8 の仕組みのまま。`send.channelId === channelId` のときだけ）。返信先にするのは、その送信が `delivered` か `unconfirmed` で `message_id` があるとき（`unconfirmed` も返事待ちにする）。貼っている途中（`delivering`）に来た `Stop` は、同じセッションに次の発言が積まれていても、その送信が終わるまで待ってから扱う。
- 1 日の上限: チャンネルでは `CC_CHANNEL_REPLY_DAILY_LIMIT`（200）。超えたら 1 回「今日はここまで（上限 200）。RC で読む <リンク>」。
- チャンネルがある（作れた）セッションに #inbox から `cc_send` で頼んだとき: [送る] は今までどおり届けるが、追いかけは立てず（`startFollow` を呼ばない）、確認の投稿の結果に「返事は <#チャンネル> に出ます」を足す。GitHub の [対応] も同じ。作れなかったときは CC8 のまま（追いかけ）。
- 終了の 1 行「セッションが終わりました」は §3.6。

### 3.5 許可の要求・判断待ち・端末の指示の写し（CC12。決定 3）
> Q4（`docs/plan/claude-code-questions.md` §5。2026-11-05）で #system の経路を消した。以下は Q4 の後の形。
- 許可の要求・質問: **そのセッションのチャンネル**に CC5c と同じ 1 通（[許可][このセッションでは常に許可][拒否] + [RC で開く]。質問は選択肢の 1 通。オーナーをメンション）。`cc_permissions.message_channel_id` に残すので、書き換え（押された・他で答えられた・時間切れ・停止）は今の仕組みのまま。チャンネルが無ければ `ensureFor`（origin `permission` / `question`）で作ってから出す（tmux の外のセッションにも作る）。作れない・投稿に失敗したときは log だけ（保留は続き、Web と端末・RC で答える）。**#system には出さない**。`permission-hold.ts` の `listen` の受け手は `cc/channel-posts.ts` だけ（`claims`・`release` は消した）。文面は `cc/notice-text.ts` の純関数（`discord-notice.ts` の `CcDiscordNotifier` は消した）。
- 判断待ちの知らせ（60 秒・1 時間 10 件）: 同じくチャンネルへ（無ければ `ensureFor`（origin `waiting`）で作る）。上限を超えた分は出さず、チャンネルのあるセッションならそのチャンネルに 1 時間に 1 回だけ「判断待ちの知らせが上限…しばらく出しません」の 1 行（メンションなし。そのためにチャンネルは作らない）。「ほか n 件」の #system の 1 通は消した。
- 終了の知らせ: チャンネルがあるときだけそこに 1 行（§3.6）。無ければ出さない（#system にも出さない）。
- `SELF_AGENT_CC_NOTIFY=0` のとき: 知らせのためにチャンネルを**作らない**。既にあるチャンネルへの投稿は止めない（チャンネルはオーナーが関わって作られたもの。返事・許可・判断待ち・終了の全部がチャンネルの目的）。README に書く。
- Web の許可のカード・`/api/cc/permissions` は変わらない（Web でも Discord でも先に押した方が勝つ）。
- **端末・RC から打った指示の写し**（決定 3）: `UserPromptSubmit` のうち self-agent が届けたものでないものを、チャンネルに「（端末か RC から HH:MM）」（時刻は `SELF_AGENT_TZ` の壁時計。hook を受けた時刻。#286）+ 本文の先頭 `CC_PROMPT_MIRROR_MAX_CHARS`（1,000）字で出す（`escapeDiscordText`・メンション無効・埋め込み無し。超えた分は「（ほか n 字）」）。受け口は `prompt` を 200 字でなく 1,000 字まで事象に乗せ、**DB に残すのは今までどおり 200 字**（確定版の決定 1 は変えない）。「self-agent が届けたもの」の判定: そのセッションの直近 30 秒に `delivered` になった送信（か `delivering` 中のもの）の本文の先頭 200 字と、包みを外した `prompt` の先頭 200 字が同じなら写さない。**比べる本文は貼ったときの形（改行を空白に置き換える `singleLine` を当てた後）で、両方の空白（改行・連続する空白・前後の空白）を 1 つの空白に正規化してから比べる**（`cc_sends.text` のままだと、改行を空白に置き換えて送ったときに一致しないため）。写した投稿に返事は返信にしない。写しだけではチャンネルを作らない。
- 写すことでチャンネルは「オーナーの発言（Discord）・外からの送信の写し・端末からの指示の写し・返事・許可」の流れになり、RC で打った分の返事が唐突に見えなくなる。

### 3.6 終わったとき・戻ったとき・続けるとき（CC10・CC13。決定 2）
| | **A: 完了カテゴリへ移して残す（セッションのチャンネルと同じ）** | B: カテゴリ「Claude Code」に残す | C: 消す |
|---|---|---|---|
| 履歴 | ◎ 残る | ◎ | ✗ |
| 散らかり | ○ 完了に溜まる（`SELF_AGENT_DELETE_AFTER_DAYS` 日で削除の確認。セッションと同じ） | ✗ 生きているものと混ざる | ◎ |
| 戻った・続ける | ◎ Claude Code カテゴリへ戻す | ◎ 何もしない | ✗ 作り直し |
| 実装 | ○ `findStateCategory("done")` と `enqueueMove` をそのまま | ◎ | ○ |

**A を採る（オーナーの決定）。**
- 終わった（`registry` の `ended`。一覧から消えたときだけ。`SessionEnd` の hook は根拠にしない）: `cc_channels.state = 'ended'`・`ended_at` → 「セッションが終わりました。ここに書くと、同じディレクトリで起動して続けられます」を 1 行 → 完了カテゴリへ移す。#system の終了の知らせは無い（Q4 で消した。チャンネルの無いセッションの終了は知らせない）。既に閉じた（`/cc close`・Web の [閉じる] で `ended` の、削除されていない）チャンネルのセッションが後で終わったときも、状態とカテゴリは変えずにチャンネルに同じ 1 行を出して引き受け、#system には出さない。
- 戻った（同じ `session_id` が再び一覧に現れた。`registry` に `revived(row)` を足す。`gone_at` が NULL でない行を `upsertSeen` する前に拾う）。**開き直すのは `cc_channels` に `session_id` が一致する削除されていない行があるときだけ**（付け替え（rebind）の後の古い id は `previous_session_id` では開き直さない）: `state = 'open'`・`ended_at = NULL` → 「セッションが戻りました」→ Claude Code カテゴリへ戻す。
- 閉じた（`/cc close`）チャンネルは、セッションが一覧にある間に許可の要求・質問・判断待ちの知らせが来ても開き直す（`ensureFor` → `reopenIfListed`。答える場所が要るため。Q4）。
- 続ける（終わったチャンネルでの発言。CC13）: そのセッションがまだ一覧にある（`/cc close` で閉じただけ）なら、発言を「関わった」として扱い、`revived` で `open` に戻して「開き直しました」を出し、その発言をそのまま積む（[起動して続ける] は出さない）。一覧に無いときだけ、発言は積まずに、返信で「このセッションは終わっています」+ [起動して続ける][やめる]（`cc:resume:<channel_id>:<message_id>`。押したサーバーが行と違えば古い。保留した本文が無い（再起動の後など）ボタンは、ボタンを外して「この操作は古くなっています」に書き換える）。[起動して続ける] を押したときにセッションが一覧にあれば、起動せずに開き直してその発言を積む。[起動して続ける] は、まず `cc_channels.state` を `ended` → `resuming` に compare-and-set で移し（移せなければ「この操作は古くなっています」。二重起動を防ぐ）、 `starter.launch` を**そのセッションの `cwd`**（`cc_sessions.cwd`。`SELF_AGENT_WORKSPACE_DIR` の直下でなければ「起動できる場所ではありません。Web か端末で起動してください」）・題名はセッション名・最初の指示はその発言の本文・`startedBy: 'tool'`（`cc_sessions.started_by` の CHECK に `discord` が無いので代える。v29 の CHECK を作り直さない）で起動し、一覧に現れて結びついたら `cc_channels.session_id` を新しい `session_id` に**付け替え**（`previous_session_id` に前の id を残す。新しいチャンネルは作らない）、`state = 'open'`、topic を書き換え、Claude Code カテゴリへ戻し、「<名前> として起動しました。続けます」を出す。trust の確認待ちは確認の投稿の書き換え（CC7 と同じ文）。起動の失敗（`limit`・`low_memory`・`too_soon`・`no_server`・`launch` の例外・結びつく前の失敗）は `state` を `ended` に戻し、ボタンを残して「少し待ってもう一度押してください」。`resuming` の間のそのチャンネルの発言は積まずに返信で「起動中です。少し待ってから書いてください」と断る。再起動で `resuming` のまま残った行は起動時に `ended` に戻す。
- 削除の確認（CC13）: 完了（`ended_at`）から `SELF_AGENT_DELETE_AFTER_DAYS` 日経ったチャンネルは、セッションと同じく #system に [削除する][残す]（`scheduler` の `listDeleteDue` と同じ形を `cc_channels` にも。ボタンは `cc:del:<channel_id>` / `cc:del:keep:<channel_id>`（CC7 の `cc:keep:send|start:<id>` と重ならないよう、`cc:del:` の下に置く）。[残す] は `ended_at` を今にする。`open` に戻した（戻った・開き直した・続けた）ら `delete_prompt_message_id` を外し、次に終わったらまた確認する）。[削除する] で `deleteChannel` → `channelOps.cancel(channelId)`（未実行のカテゴリ移動を捨てる）→ `state = 'deleted'`・`deleted_at`。戻った・続けたチャンネルは `open` になるので対象から外れる。
- セッションのチャンネルの規則（`SELF_AGENT_IDLE_HOURS` の待ちへの移動・`/wait`・`topic_sessions` の削除の確認）は cc のチャンネルには当たらない（`topic_sessions` に行が無い）。
- 再同期（`scheduler`。CC10）: `cc_channels` の削除されていない行のうち Discord に無いものは `deleted` に、`open` で Claude Code カテゴリの外にあるものは戻し、`ended` で完了カテゴリの外にあるものは完了へ（1 サーバー 5 件までは既存の規則と同じ）。

### 3.7 `cc_send`・`cc_start`・[対応]・Web の起動との関係（CC11）
- `cc_send` の [送る]: `queued` にした直後に §3.1 の 4 でチャンネルを作り（作れなければそのまま）、§3.3 の写しを出し、`message_id` を写しに向ける。確認の投稿の結果は「送りました / 入力待ちになったら届けます（返事は <#チャンネル> に出ます）」。
- `cc_start` の [起動する]・Web の起動・[対応] の [起動して送る]: 結びついたとき（`starter` の結びつけの後。`cc_starts` / 起動の記録の `startedBy` と頼んだチャンネルから origin とサーバーを決める）にチャンネルを作る。最初の指示（`origin start`）はペイン宛てに積まれて結びつけの後に届くので、作れたら届く前に写せる（届いた後なら写しは「（起動の最初の指示）」で出し、返信先には使わない）。
- GitHub の [対応]: 積んだ直後に作る（サーバーは #github のサーバー）。[対応] のテンプレートは変えない。
- 第 3 のボタン（v1 の [チャンネルを作って送る]）は**作らない**（自動で作るため）。

### 3.8 受付・人格・コマンド
- `access.ts` の `resolveChannel` は cc のチャンネルに `null` を返したまま（SDK のターンにしない）。振り分けは main（§3.3）。`/close`・`/wait`・`/renew` は今までどおり「セッションのチャンネルか #inbox・#tasks で実行してください」。`session_open`・`project_open` などのツールには無関係。
- `/cc`（既定の人格のアプリ。SELF_AGENT_CC=1 のときだけ登録。コマンドの一覧が変わるのはそのとき）: `open`（一覧を `rankSessions` の順に最大 25 件のセレクト `cc:pick` で本人にだけ出し、選ぶと作る。/setup 前のサーバーでは断る）・`cancel`（§3.3）・`close`（チャンネルの中で。`state = 'ended'` にして完了へ移し「閉じました。ここに書くと起動して続けられます」。そのセッションの届け待ち（queued）はやめ（⏳ を外す）、やめたら「閉じたので、届け待ちの n 件を送るのをやめました」を添える。セッションが生きていても閉じられる = 返事はその後 follow の規則に戻る（許可の要求・質問・判断待ちは、Q4 からはセッションが一覧にあれば `ensureFor` が開き直してそこに出す）。次に関わればまた開き直す）。確定版 §5.2 の「`/cc` のコマンドは持たない」はここで改める（理由: 作る・閉じる・取り消すは LLM を通さない操作で、Web だけだとスマホからの手が無い）。
- 持ち主は既定の人格。足した人格の Bot で受けた cc のチャンネルの発言は、main の振り分けで（`event.persona !== 'default'`）黙って捨てる。
- ゲスト: 無関係（別の層）。

## 4. DB（v36〜。段ごとに上げる）

| 版 | 段 | 変更 |
|---|---|---|
| v36 | CC10 | `cc_channels(channel_id TEXT PK, guild_id TEXT NOT NULL, session_id TEXT NOT NULL, previous_session_id TEXT, name TEXT NOT NULL, cwd TEXT, state TEXT NOT NULL CHECK (state IN ('open','resuming','ended','deleted')), origin TEXT NOT NULL CHECK (origin IN ('web','command','web_send','web_start','permission','tool_send','tool_start','github')), created_at TEXT NOT NULL, ended_at TEXT, delete_prompt_message_id TEXT, deleted_at TEXT, updated_at TEXT NOT NULL)`。部分索引 `cc_channels_session ON cc_channels(session_id) WHERE state <> 'deleted'` を**一意**に（1 セッションに削除されていないチャンネルは 1 つ。サーバーをまたいでも）。`guild_settings` に `cc_category_id TEXT`。`delete_prompt_message_id` は CC13 の削除の確認。`resuming` は CC13 の [起動して続ける] の間（§3.6。二重起動を防ぐ）。チャンネルのカテゴリは持たない（再同期は Discord の親を見る） |
| v37 | CC11 | `cc_sends` の作り直し（`CREATE TABLE cc_sends_new … origin CHECK IN ('web','tool','github','start','discord') …` → `INSERT … SELECT` → `DROP` → `RENAME`。索引 5 つ（`cc_sends_session`・`cc_sends_state`・`cc_sends_created`・`cc_sends_notification`・`cc_sends_reply`）を同じ定義で作り直す。外部キーは無い。`cc_sends.message_id` のコメントを「確認・オーナーの発言・写しの投稿」に直す） |
| — | CC12・CC13・CC14 | 表の変更なし（`cc_permissions.message_channel_id` がチャンネルの ID になる。`history` に cc のチャンネルの行を書く。`persona` は `default`） |

- `cc_channels` は `deleted_at` から 30 日で消す（tick）。`name`・`cwd` はローカルの DB だけ。
- `CcChannelStore`（`src/store/cc-channels.ts`）: `create`・`get(channelId)`・`openFor(sessionId)`（`state = 'open'`）・`anyFor(sessionId)`（削除されていないもの）・`listUndeleted(guildId)`・`setState`（`resuming` への移動は compare-and-set）・`rebind(channelId, sessionId)`（`previous_session_id` に前の id）・`listDeleteDue(guildId, cutoff)`・`setDeletePrompt`・`touchEnded`（[残す]）・`markDeleted`・`prune`。
- 版の番号は目安（`MIGRATIONS.length` で確かめる）。

## 5. Web（CC14。決定 4）

### 5.1 比較（チャンネルのあるセッションのタブ）
| | **A: 会話のタブ（history）にし、画面の写しを節で足す** | B: 今の Claude Code のタブのまま + [Discord で開く] |
|---|---|---|
| Discord と同じ流れを見る | ◎ 発言・写し・返事・許可の結果が行で読める | ✗ 画面の写しだけ |
| Web から送る | ◎ 会話の入力欄（写し「（Web から）」→ `cc_sends`） | ○ 今の入力欄（§3.3 の写しで Discord には出る） |
| 画面の写し | ○ 節（既定は閉じる。開いている間だけ 3 秒ごと） | ◎ |
| 許可のカード | ◎ 今のカードを会話の末尾に | ◎ |
| 実装 | △ history の書き込み・`/api/channels` の kind・chat.js の分岐 | ◎ 0 |

**A を採る（オーナーの決定）。** CC9〜CC13 が終わってから。

### 5.2 決定
- `history` の行（Web UI が有効なときだけ。`guild_id` は `cc_channels.guild_id`、`persona` は `default`）: オーナーの発言 → `owner`（`source discord`・`message_id`）、外からの送信の写し → `owner`（`source web` / `system`・`message_id` は写しの投稿）、端末の指示の写し → `owner`（`source system`・text は「（端末か RC から HH:MM）」+ 本文）、返事 → `agent`（`text` は本文（4,000 字で切る）、`outcome done`、steps・tool_calls・duration は NULL）、届かなかった・許可の結果・終了・戻った → `notice`、起動して続けた → `divider`。今 CC8 が書いている追いかけの `notice`（受け付けるチャンネルだけ）はそのまま。
- `GET /api/channels`: `kind: "cc"` の行を足す（`{ id, guildId, kind: "cc", name: <セッション名>, title: null, persona: "default", state: null, cc: { sessionId, state: needs_input | running | idle | ended, cwdLabel, inTmux, permission: {…} | null, pending: {…} | null }, last, link }`）。`webChannelLookup` は `cc_channels` の削除されていない行も通す（`kind: "cc"`。`/turns`・`/messages` で使う。リマインドの表示名は「cc-<名前>」）。型は `routes/channels.ts` の側で `ChannelKind | "cc"` に広げ、`access.ts` の `ChannelKind` は変えない。cc のチャンネルへの `POST /api/channels/<id>/renew`・`/continue`・`/turns/<seq>/abort` は 404（SDK のターンが無い）。
- `POST /api/channels/<id>/messages`（kind cc）: `submitText` ではなく `channels.submitWeb`（§3.3 の写し「（Web から）」を既定の Bot で投稿 → `history` の owner 行 → `cc_sends` に `origin: 'web'`・`channel_id`・`message_id`（写し）で積む）。202 `{ sendId, link }`。`already_queued` は 409。閉じただけ（`ended` でセッションが一覧にある）なら Discord の発言と同じく開き直して積み、409 `ended` は一覧に無いときだけ（CC14 で決めた）。`cc:<sessionId>` のタブの入力欄（`/api/cc/sessions/<id>/send`）も、チャンネルがあれば同じ経路（CC11 から）。
- 会話のタブ（chat.js）: kind cc なら 見出しに 状態のバッジ・[RC で開く]・[画面]（節の開閉）・[Discord で開く]・[閉じる]（`/cc close` と同じ `POST /api/cc/channels/<id>/close`）、会話の行、末尾に許可のカード（`cc.permission` が pending のとき。views.js の `ccPermissionCard` を共用）、送信の状態の行（`cc.pending`。[やめる]）、入力欄（1,900 字）。実行中のターンの行は出さない（cc の `running` は見出しのバッジとスピナー）。開いている間は `/api/cc/sessions/<id>` を 3 秒ごと（画面の節を開いているとき）か 10 秒ごとに読む。
- サイドバーの Claude Code の群: チャンネルのある行は `ch:<channelId>` を開く。未読の点は history の最後の行で判定（セッションと同じ）。
- `cc:<sessionId>` のタブは、チャンネルの無いセッションのために残す。

## 6. 安全
1. 入口は Web（認証 + CSRF）、Discord（オーナー・許可サーバー・`cc_channels` にある channel_id・整数の id）、確認のボタン。**チャンネルへの発言は確認なしで送る**が、それはオーナーの直接の操作で、確定版 §7 の「LLM は確認なしに送らない」の例外ではない（LLM を通らない）。自動で作るきっかけ（§3.1）もすべてオーナーの操作（Web の送信・起動・許可の応答・確認のボタン・[対応]）で、LLM の出力だけでは作られない（`cc_send` のツールは確認の投稿まで。作るのは [送る] を押したとき）。
2. 送れる相手・送り方・ダイアログにキーを送らない・1 セッション 1 件（Web・ツール）は CC3 のまま。チャンネルの 5 件の列も同じ経路で 1 件ずつ。
3. hook 由来の文字列（名前・cwd・`prompt`・`last_assistant_message`・ツールの要約）は Discord でも history でも**データ**: `escapeDiscordText`、メンション無効、埋め込み無し、masked link を崩す。写し（§3.3・§3.5）はこの経路の文字列を Discord に出す新しい場所なので、同じ処理を通す。ターンの prompt には入れない（SDK のエージェントは cc のチャンネルを読まない）。
4. 偽の hook（確定版 §7 の 11）: 偽の `Stop` はチャンネルへの偽の返事に、偽の `UserPromptSubmit` は偽の写しになる。出所の表示（「（hook）」「（端末か RC から）」）で見分ける。写しの「self-agent が届けたものか」の判定は偽の `UserPromptSubmit` で狂いうるが、害は「自分の発言がもう 1 回写る」まで。偽の hook ではチャンネルは作られない（きっかけに hook の事象は無い）。
5. チャンネルの作成は `/setup` 済みの許可サーバーだけ・1 セッション 1 つ（一意索引）・カテゴリの 50 の上限で止める。作れなくても元の処理は止めない。削除は確認の後だけ。
6. log: 「Claude Code: チャンネルを作りました（guild=…、<origin>）」「Claude Code: チャンネルを作れませんでした（<理由>）」「Claude Code: チャンネルの発言を積みました（#send_id）」「Claude Code: チャンネルを閉じました」「Claude Code: チャンネルを付け替えました（#start_id）」「Claude Code: 写しを出しました」と失敗の種類だけ。チャンネル ID・名前・本文は出さない（作成の DB 失敗だけ例外）。
7. リアクション・チャンネルの作成・移動は Discord の制限に当たりうる。失敗は log だけで送信・返事は止めない。

## 7. 段（PR 単位）と受け入れ

| 段 | 内容 | 受け入れ（単体: `npm test`。偽 Gateway・偽 registry・一時 SQLite） | 実機（オーナー） |
|---|---|---|---|
| **CC9** Web の群（済） | `sidebar.js`: 会話の一覧に群「Claude Code」（入口の次）。`renderCc` の中身を移し、アクティビティ `cc` を外す。行は `ccRow` + チャンネルの印（CC10 まで常に無し）。起動中の行・[Claude Code を起動]・読めないときの注記。`SA.poll.kickCc` を会話のサイドバーから。web-ui.md §3.2・§3.4・GUIDELINES の語彙 | JS は `node --check`。`index.html` に inline 無し。API の変更なし（`web-cc.test.ts` はそのまま） | スマホで会話のサイドバーに Claude Code の群が出て、判断待ちが上、実行中にスピナー。行を押すと今のタブ。アクティビティバーから Claude Code が消え、パレットの「Claude Code を起動」は動く |
| **CC10** 表・カテゴリ・作る口・再同期・終了と戻り（済） | v36・`CcChannelStore`・`/setup` のカテゴリ「Claude Code」（`cfg.cc`）・`src/cc/channels.ts`（`openChannel`・`ended`・`revived`・再同期の材料）・`POST /api/cc/sessions/<id>/channel`・Web のタブの [Discord のチャンネルを作る]・`/cc open`（セレクト）・`registry` の `revived`・scheduler の再同期・tick の prune。**自動では作らず、発言もまだ送らない**（cc のチャンネルの発言は main の振り分けで黙って捨てる。README に「CC11 まで発言は届かない」） | `/setup` が `cc` のときだけカテゴリを作り ID を保存。`openChannel` が `layoutQueueKey` のキューで作り、一意索引で 2 つ目は `exists`、tmux の外は `not_in_tmux`、カテゴリが無ければ `not_set_up`、50 で `full`、作れなくても投げない。`ended` で `state ended`・完了へ `enqueueMove`・1 行の投稿、#system の終了の知らせは出ない。`revived` で `open`・Claude Code カテゴリへ・1 行。再同期で Discord に無い行が `deleted`、外にある `open` が戻る。`prune` が `deleted_at` から 30 日。log にチャンネル ID が無い（DB 失敗を除く） | Web の cc のタブから作る → Discord のカテゴリ「Claude Code」に `cc-<名前>` ができ最初の投稿が出る。`/cc open` で同じ。そのセッションを `/exit` → 1 行出て完了カテゴリへ。`claude -r` で戻す（§1.3 の推測の確認）→ 戻る |
| **CC11** 自動で作る・発言 → 送信・写し・印・返事（済） | v37（`cc_sends.origin` に `discord`）・main の `handleMessage` の振り分け・`channels.handleMessage`（検証・5 件の列・リアクション）・Gateway の `addReaction`/`removeOwnReaction`・`sender` の origin ごとの `activeFor`・**自動で作るきっかけ 1〜6**（§3.1。`sender.submit`/`confirm`（web・tool・github）、`starter` の結びつけ、`permission-hold.answer`）・作れなかったときの #system の 1 行（1 時間に 1 回）・外からの送信の写し（§3.3）・`replies.ts` の投稿先（チャンネル優先。[追いかけをやめる] 無し・返信先はオーナーの発言か写し・上限 200）・`cc_send`/[対応] の「返事は <#…> に出ます」・`/cc cancel` | オーナーの発言で `cc_sends` に `origin discord`・`channel_id`・`message_id` の `queued` ができ ⏳、偽 tmux が idle なら貼って Enter → `delivered` で ⏳ が外れ ✅。6 件目は返信で断る。2 件続けて積んで偽 tmux が idle のままでも、1 pass で届けるのは 1 件だけ。Web からの同じセッションへの送信は `already_queued`。制御文字・添付だけは返信で断り積まない。**きっかけ**: チャンネルの無いセッションに Web から送る → `queued` の直後に `cc_channels`（`web_send`）ができ最初の投稿と「（Web から）」の写しが出て `message_id` が写し。Web の起動・`cc_start` の [起動する] は結びつく前は作らず、結びついたら `web_start` / `tool_start`。許可に [許可]/[拒否]（Web・Discord のどちらでも）→ `permission`。`cc_send` の [送る] → `tool_send` と「（<#inbox> から）」の写しと結果の「返事は <#…> に出ます」。[対応] → `github`。一覧を見た・タブを開いた・`cc_list`・写しだけでは作られない。既にあれば作らない。カテゴリが無い・満杯・`createTextChannel` の失敗では送信・起動・応答が止まらず、#system に 1 行（同じ理由の 2 回目は 1 時間出ない）、返事は CC8 の追いかけに落ちる。`Stop` がチャンネルに出て、最初の 1 通はオーナーの発言（か写し）への返信、[追いかけをやめる] が無い、201 通目は上限の 1 行。チャンネルの無いセッションは CC8 のまま（`cc-replies.test.ts` が通る）。足した人格の Bot の分は捨てる。Bot 自身の投稿は積まない | Web から 1 行送る → Discord にチャンネルができ、写しと返事が出る。チャンネルに 3 行の本文 → ⏳ → 届いて ✅ → 返事がその発言への返信で出る。作業中に 2 つ続けて書く → 順に届く。`/cc cancel` で ⏳ が外れる。#inbox で `cc_send` → [送る] → 新しいチャンネルに写しと返事、#inbox には「返事は <#…> に出ます」 |
| **CC12** 許可・判断待ち・端末の指示の写し（済） | `permission-hold.ts` の複数 listener・`cc/channel-posts.ts`（許可の 1 通・判断待ち・写し）・`discord-notice.ts` の「担当済みは飛ばす」・受け口の `prompt` を 1,000 字まで事象に（DB は 200 字のまま）・`NOTIFY=0` でもチャンネルには出す | チャンネルのあるセッションの `PermissionRequest` でチャンネルに 1 通・#system には出ない・`message_channel_id` がチャンネル。[許可] の応答・書き換え・他で答えられた・時間切れは CC5c のテストと同じ結果。チャンネルの無いセッションは #system（既存のテストが通る）で、答えた後の次の要求はチャンネル。写し: 端末からの `UserPromptSubmit` が「（端末か RC から）」で出て、self-agent が 30 秒以内に届けた本文と先頭 200 字が同じなら出ない。1,001 字は「（ほか n 字）」。`NOTIFY=0` でチャンネルの投稿が出る | 端末で `npm test` の許可 → チャンネルに 1 通 → スマホで [許可]。RC から指示 → チャンネルに写しと返事 |
| **CC13** 起動して続ける・閉じる・削除の確認（済） | 終わったチャンネルでの発言 → [起動して続ける][やめる]・`rebind`・topic の書き換え・`/cc close`・削除の確認（`cc:del`/`cc:del:keep`。`listDeleteDue`） | 終わったチャンネルの発言は、セッションが一覧に無ければ積まれず確認が出る（一覧にあれば開き直して積む）。[起動して続ける] で `state` が `resuming` になり（その間の発言は「起動中です」で断られ、2 回目の押下は古い）、`starter.launch` が `cwd`・題名・本文・`tool` で呼ばれ、結びついたら `session_id` が付け替わり `previous_session_id` に前の id、`open`、Claude Code カテゴリへ（新しいチャンネルは作られない）。直下でない `cwd` は断る。起動の失敗で `ended` に戻る。`/cc close` で `ended`・完了へ・届け待ちの取り消し。完了から N 日で #system に確認、[削除する] で `deleteChannel`・`channelOps.cancel`・`deleted`、[残す] で `ended_at` が今に | 終わったチャンネルに書く → [起動して続ける] → 新しい tmux のセッションが起動し、同じチャンネルに返事 |
| **CC14** Web の会話のタブ（済） | `history` の行（§5.2）・`/api/channels` の `kind cc`・`webChannelLookup`・`POST /messages` の cc の経路・`POST /api/cc/channels/<id>/close`・chat.js の cc の見出し・画面の節・許可のカード・送信の状態・サイドバーの `ch:` | `/api/channels` に cc の行、`/turns` に owner → agent の順、Web からの送信で写しと owner 行と `cc_sends`（`origin web`・`message_id` が写し）、受け付けない（`deleted`）チャンネルは 404。既存の web のテストが通る | Web の会話の Claude Code の群からチャンネルのある行を開く → Discord と同じ流れ → 送る → Discord に「（Web から）」と返事 |

順序: CC9 → CC10 → CC11 → CC12 → CC13 → CC14。どの段もツール集合・システムプロンプトを変えない（**キャッシュは外れない**）。`/cc` のコマンドの登録は CC10（Discord のコマンドの一覧が変わるだけ）。

## 8. 本書で決めたこと・実装者が決めてよいこと

本書で決めたこと（§9 の決定の下で）: 群の位置（入口の次）、「関わった」の 6 つのきっかけと作る時点（送信は積んだ直後・起動は結びついたとき・許可は答えた直後）、許可の応答は Web でも #system のボタンでも同じきっかけ、作るサーバーの選び方、作れなかったときは元の処理を止めず log に 1 時間 1 回（Q4 より前は #system にも）、自動の再試行はしない、手動の口は 2 つ、カテゴリ「Claude Code」は 1 つで 50 で断る、名前は `cc-<名前>` で追いかけない、発言は確認なし・`origin discord`・5 件の列、外からの送信の写し、印はリアクション、返事はチャンネル優先で [追いかけをやめる] 無し・上限 200、許可の要求はチャンネルだけ（#system に出さない）、`NOTIFY=0` でもチャンネルには出す、戻ったら開き直す、続けるは [起動して続ける]（新しいチャンネルは作らない）、`/cc open|cancel|close` を持つ、`cc_sessions.started_by` は `tool` で代える、history の行の種類、段の切り方。

実装者が決めてよいこと: 表・列・関数の名前、リアクションの絵文字（上の 3 つは目安）、最初の投稿・写し・返信の文言、`CC_CHANNEL_QUEUE_MAX`・`CC_CHANNEL_REPLY_DAILY_LIMIT`・`CC_PROMPT_MIRROR_MAX_CHARS` の置き場所、`/cc open` のセレクトの行の形、`cc_sends` の作り直しの手順の細部、chat.js の cc の節の見た目、写しの判定の窓（30 秒）、作れなかったときの #system の 1 行の窓（1 時間）の持ち方（プロセスの中）。

## 9. 決定事項（オーナー。2026-11-05）

1. **チャンネルを作る条件: (c) 関わったら自動**（定義と作る時点は §3.1。一覧を見た・写しを読んだだけでは作らない）。手動の口（Web のタブの [Discord のチャンネルを作る]・`/cc open`）は残す。
2. **終わったセッションのチャンネル: (a) 完了カテゴリへ移して残し、`SELF_AGENT_DELETE_AFTER_DAYS` 日後に #system で削除の確認**（§3.6）。
3. **端末・RC から打った指示: (a) 「（端末か RC から）」で先頭 1,000 字を写す**（§3.5。DB は 200 字のまま）。
4. **Web: (a) 会話の一覧に群「Claude Code」、アクティビティ「Claude Code」は消す、チャンネルのあるセッションは会話のタブ（CC14）**（§2・§5）。
5. **スマホの下のバーは別の設計**（固定 4 タブ + その他、一覧は全幅）。会話の一覧に Claude Code の群が入る前提は変わらない（§2.2）。

## 10. 費用
- 外部サービス: 増えない（0 円）。依存: 増えない。
- 常駐: 増えない（`claude agents --json`・hook の受け口・待ち行列は今のまま）。Discord の API 呼び出しが、チャンネルの作成（関わったとき）・移動（終わった・戻ったとき）・リアクション（発言 1 つに 2 回）・写し（外からの送信 1 つに 1 通、端末からの指示 1 つに 1 通）の分だけ増える。
- オーナーの手間: `/setup` を 1 回（カテゴリ「Claude Code」）。env の追加は無い。再起動（キャッシュは外れない）。

## 11. 未確認（実機で確かめること）
1. `claude -r <id>` で同じ `sessionId` が `claude agents --json` に戻るか（§3.6 の「戻った」の前提。戻らなければ [起動して続ける] だけ）。
2. リアクションの追加・削除が discord.js でレート制限に当たらないか（1 発言に 2 回）。
3. 50 チャンネルのカテゴリの `createTextChannel` が何を返すか（`full` の判定は `countChannelsIn` で先に行うので、普通は当たらない）。
4. 写しの判定（30 秒・先頭 200 字）が、貼り付けの包み（`<pasted_content>`）を外した後の本文で合うか（CC3 の実機で 4,000 字の貼り付けが 1 つの `UserPromptSubmit` になることは確認済み）。
5. 起動の最初の指示（ペイン宛て）が、結びつけの直後に作ったチャンネルの写しより先に届くことがあるか（§3.7。届いた後なら写しは返信先に使わない）。

## 12. 実装の分解

段ごとのコードの変更（ファイル単位）。設計書・README・CLAUDE.md の変更は各段の PR で合わせる。

### 12.1 DB（`src/store/`）

| ファイル | 変更 | 段 |
|---|---|---|
| `db.ts` | v36: `cc_channels` と一意の部分索引、`guild_settings.cc_category_id`。v37: `cc_sends` の作り直し（`origin` に `'discord'`。既存の索引を `db.ts` で確かめて同じものを作る。`INSERT … SELECT` で全列を写す） | CC10・CC11 |
| `cc-channels.ts`（新規） | `CcChannelStore`（channels.md §4） | CC10 |
| `cc-sends.ts` | `CcSendOrigin` に `"discord"`、`ORIGINS`。`countQueuedDiscord(sessionId)`（列の 5 件）。`listQueued` は今のまま古い順。v37 で `message_id` のコメントを「確認・オーナーの発言・写しの投稿」に | CC11 |
| `cc-sessions.ts` | 変更なし（`channel_id`・`follow*` はそのまま） | — |
| `guild-settings.ts` | `ccCategoryId(guildId)`・`setCcCategory(guildId, id)`（`routineCategoryId`・`setRoutineCategory` と同じ形。行が無ければ false） | CC10 |

### 12.2 Claude Code（`src/cc/`）
> CC10〜CC14 の時点の分解。Q4（claude-code-questions.md §5）で `discord-notice.ts` は `notice-text.ts`（純関数だけ）に移し、`permission-hold.ts` の `claims`・`release` は消した。

| ファイル | 変更 | 段 |
|---|---|---|
| `channels.ts`（新規） | `CcChannels`: `openChannel(guildId, sessionId, origin)`（`layoutQueueKey` のキュー・一意・tmux の中・カテゴリ・50・最初の投稿・作れなかったときの #system の 1 行（1 時間 1 回））、`ensureFor(sessionId, origin, guildId?)`（きっかけから呼ぶ。既にあれば何もしない・作れなくても投げない）、`mirror(sessionId, label, text) → messageId | undefined`（外からの送信の写し）、`handleMessage(event) → boolean`（CC11。受付・検証・5 件・リアクション・終わったチャンネルの [起動して続ける]（CC13））、`ended(row)`・`revived(row)`（`session_id` が一致する削除されていない行だけ）、`close(channelId)`、`reconcile(guildId, parents)`、`resume(channelId, messageId)`（CC13）、`submitWeb`（CC14）。**TODO**: CC10 は発言が届かないので最初の投稿と終了の 1 行を縮めてある（「今はまだ届きません」・「セッションが終わりました。」だけ）。CC11 で最初の投稿を §3.1 の文に、CC13 で終了の文を §3.6 の文（「ここに書くと、同じディレクトリで起動して続けられます」）に戻した | CC10〜 |
| `channel-posts.ts`（新規） | チャンネルへの投稿（純関数 + 投稿）: 許可の 1 通（`discord-notice.ts` の `permissionNotice` を再利用）・判断待ち・終了・戻った・写し（`escapeDiscordText`・メンション無効・`suppressEmbeds`）・送信の失敗の返信・印（リアクション） | CC11・CC12 |
| `registry.ts` | deps に `revived?: (row: CcSessionRow) => void`（`upsertSeen` の前に「`gone_at` が NULL でない行のうち今回の一覧にあるもの」を引いて呼ぶ） | CC10 |
| `sender.ts` | `submit`・`confirm` の後に `channels.ensureFor`（origin web → `web_send`、tool → `tool_send`、github → `github`）→ `mirror` → `message_id` の更新。`already_queued` の判定を origin で分ける（`discord` は `countQueuedDiscord < CC_CHANNEL_QUEUE_MAX`、それ以外はチャンネルの列が空でなければ `already_queued`）。`onFinished` の後に印の更新。`origin: "discord"` の受け入れ。同じセッションで `delivered` にした pass では、そのセッションの次の `queued` を試さない（次の `Stop` か 30 秒後） | CC11 |
| `starter.ts` | 結びつけの後に `onBound(sessionId, started)` の口（`startedBy` と頼んだチャンネルから `web_start` / `tool_start` / `github` で `ensureFor`。CC13 の `rebind` も同じ口）。`launch` の `startedBy` に `"tool"`（続ける） | CC11・CC13 |
| `replies.ts` | 投稿先の決め方 `targetOf(sessionId)`（`channels.openFor` → `follow_channel_id`）。チャンネル宛ては [追いかけをやめる] を付けず・上限 `CC_CHANNEL_REPLY_DAILY_LIMIT`・返信先は `send.messageId`。`onSendFinished` の `startFollow` はチャンネルがあるときは呼ばない。`record` の `guildOf` は cc のチャンネルも引けるように（CC14 で `agent` 行） | CC11・CC14 |
| `permission-hold.ts` | `listen` を複数に（配列）。listener が `claims(row) → boolean` を返せるようにし、先に claim したものだけが投稿する（channel-posts → discord-notice の順） | CC11・CC12（Q4 で消した） |
| `discord-notice.ts` | claim 済みの要求・チャンネルのあるセッションの判断待ち・終了は出さない。それ以外は変更なし | CC12（Q4 で消した） |
| `hook-server.ts` | `UserPromptSubmit` の `prompt` を事象には `CC_PROMPT_MIRROR_MAX_CHARS`（1,000）まで乗せる。DB に残す 200 字は `cc-sessions.ts` の `applyEvent` がそのまま切る | CC12 |

### 12.3 アプリ（`src/app/`・`src/main.ts`・`src/discord/`）

| ファイル | 変更 | 段 |
|---|---|---|
| `main.ts` | `CcChannels` を作り（SELF_AGENT_CC=1 のときだけ）、`gateway.start` の `handleMessage` を「`ccChannels?.handleMessage(event)` が true なら終わり、それ以外は `handler.handleMessage`」に包む。registry の `ended`/`revived`・sender・starter・replier・permission-hold・scheduler・`/cc`・Web のルートに渡す。`channelOf`（`webChannelLookup`）に `ccChannels` を足す（CC14）。`ccPermissionButtons` は notifier（`SELF_AGENT_CC_NOTIFY`）によらず、permission-hold と channel-posts の `resolvedMessage` から作る（notifier が無ければ channel-posts だけ。`NOTIFY=0` でもチャンネルの許可のボタンが効くように） | CC10〜 |
| `access.ts`・`handler.ts` | 変更なし | — |
| `commands/cc.ts` | `/cc`（`open`・`cancel`・`close`。SELF_AGENT_CC=1 のときだけ登録）と `cc:pick`（セレクト）・`cc:resume`・`cc:del:<channel_id>`・`cc:del:keep:<channel_id>`。`cc:perm:*` の応答の後に `ensureFor(sessionId, "permission", interaction.guildId)`（許可の応答からチャンネルを作るのはここだけ。Web のカードからの応答は `routes/cc.ts` が最初の /setup 済みサーバーで `ensureFor`） | CC10・CC11・CC13 |
| `commands/cc-confirm.ts` | [送る]・[起動する] の結果の文に「返事は <#…> に出ます」（チャンネルができたとき） | CC11 |
| `github-handoff.ts` | 積んだ後・結びついた後に `ensureFor`（github）と写し | CC11 |
| `commands/setup.ts` | `cfg.cc` が true なら状態カテゴリの後にカテゴリ「Claude Code」（`ensure` の形。消えたものだけ） | CC10 |
| `scheduler.ts` | `reconcileGuild` に `cc_channels` の再同期。tick の prune に `cc_channels`。削除の確認（CC13）。deps に `ccChannels?` | CC10・CC13 |
| `interactions.ts` | `/cc` を commands に（SELF_AGENT_CC=1 のとき）。`cc:` の名前空間は今の `createCcComponent` に増やす | CC10 |
| `discord/gateway.ts`・`discord-gateway.ts`・テストの偽 Gateway | `addReaction(channelId, messageId, emoji)`・`removeOwnReaction(channelId, messageId, emoji)` | CC11 |

### 12.4 Web（`src/web/`）

| ファイル | 変更 | 段 |
|---|---|---|
| `static/sidebar.js` | `ACTIVITIES` から `cc` を外す。`chatList` に群「Claude Code」（入口の次）。`ccRow` にチャンネルの印（`s.channel` があれば `hash`）と開くタブの切り替え。起動中・[Claude Code を起動]・注記を群に。`renderChat` から `SA.poll.kickCc` | CC9・CC14 |
| `static/views.js` | cc のタブの見出しに [Discord のチャンネルを作る]（CC10）・[Discord で開く]（チャンネルがあれば）。`ccPermissionCard` を chat.js から使えるように export（CC14） | CC10・CC14 |
| `static/chat.js` | kind cc の見出し・画面の節・許可のカード・送信の状態・入力欄（1,900 字）。`channelTitle` の cc | CC14 |
| `static/workbench.js` | hash `#/cc/<id>` と `cc:` のタブはそのまま。アクティビティ `cc` の既定を外す | CC9 |
| `routes/cc.ts` | `sessionJson` に `channel: { channelId, guildId, link, state } \| null`（CC10）。`POST /api/cc/sessions/<id>/channel { guildId }` → 201 `{ channelId, link }` / 404 `not_found` / 409 `exists` / 409 `not_in_tmux` / 409 `full` / 503 `not_set_up` / 502 `failed`。`POST /api/cc/channels/<id>/close` → 200 / 404 / 409（CC14）。Web の許可のカードの応答の後に `ensureFor(sessionId, "permission", <最初の /setup 済みサーバー>)`（CC11） | CC10・CC11・CC14 |
| `routes/channels.ts` | `WebChannel.kind` を `ChannelKind | "cc"` に広げる（`access.ts` は変えない）・`cc` の項目。cc への `/renew`・`/continue`・`/turns/<seq>/abort` は 404。`webChannelLookup`・`webChannelNamer` に `ccChannels`。一覧に cc の行 | CC14 |
| `routes/turns.ts` | kind cc の `POST /messages` → `channels.submitWeb` | CC14 |
| `routes/status.ts` | 変更なし | — |

### 12.5 テスト（`test/`）

| ファイル | 変更 | 段 |
|---|---|---|
| `cc-channels-store.test.ts`（新規） | 一意索引・`resuming` の compare-and-set・`rebind`・`listDeleteDue`・`prune` | CC10 |
| `cc-channels.test.ts`（新規） | `openChannel`・`ensureFor`（きっかけ 6 つ・作らない条件・作れなかったときの #system 1 時間 1 回）・`mirror`・`ended`・`revived`・`handleMessage`（受付・5 件・リアクション・終わったチャンネル）・`resume`・`reconcile` | CC10〜CC13 |
| `cc-replies.test.ts` | チャンネル優先・[追いかけをやめる] 無し・返信先・上限 200。既存は通る | CC11 |
| `cc-sender.test.ts`・`cc-starter.test.ts` | `origin discord` の 5 件と Web の 1 件・1 pass で同じセッションに 1 件だけ・`ensureFor` の呼び出し・結びつけの後の `onBound` | CC11 |
| `cc-permissions.test.ts`・`cc-discord-notice.test.ts` | `answer` の後の `ensureFor`。既存の #system の知らせは通る | CC11 |
| `cc-channel-posts.test.ts`（新規） | 複数 listener・claim（投げたら次へ）・release で #system に落とす・チャンネルのあるセッションは #system に出ない・判断待ち（上限の共有と上限の 1 行）・写し（30 秒・先頭 200 字・`delivering`／`unconfirmed` も写さない・「ほか n 字」）・`NOTIFY=0`・再起動の後の書き換えの振り分け | CC12 |
| `cc-hook-server.test.ts` | `prompt` が事象に 1,000 字、DB に 200 字 | CC12 |
| `scheduler.test.ts`・`setup.test.ts` | カテゴリ「Claude Code」・再同期・削除の確認 | CC10・CC13 |
| `web-cc.test.ts`・`web-channels.test.ts` | `/channel`・`channel`・kind cc・`/messages` の cc | CC10・CC14 |
| `test/helpers/` の偽 Gateway | `addReaction`・`removeOwnReaction` | CC11 |
