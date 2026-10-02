# P2「セッション」実装仕様（implementer 向け）

目的: 1 テキストチャンネル = 1 セッションで話題を分け、状態をカテゴリ（進行中/待ち/完了）で可視化する。コードで確認した P1 の事実:
会話 key は channelId（`channel_sessions`）、受付は `isAccepted`（env の inbox 固定）、Gateway は send/startTyping のみ、MCP サーバーは run ごと生成（ツール定義は固定）、DB は `MIGRATIONS` 追記式（現在 v1）。

## 0. 共通方針（全 PR）
- Discord 境界は `src/discord/gateway.ts` の型だけ拡張し、discord.js は `discord-gateway.ts` に閉じる。テストは FakeGateway で呼び出しを記録する。
- 状態の正は DB。Discord 側の失敗（移動できない等）は log + 再試行し、DB は先に更新する。
- **チャンネル名・topic は作成時にだけ設定し、以後変更しない**（name/topic の PATCH は 2 回/10 分の制限。コミュニティ情報、公式未記載）。状態は名前に入れず、カテゴリで表す。
- `setParent` は **`lockPermissions: false`** で呼ぶ（既定 true だと overwrite の書き込みになり MANAGE_ROLES が要る）。そのため 3 つの状態カテゴリの overwrite は /setup で同一にする。
- custom_id は `<ns>:<action>:<channelId>`（100 字以内）。コマンド/ボタンは「許可ギルド かつ userId == owner」以外は ephemeral「オーナー専用です」で終える。LLM を呼ぶ・Discord REST を複数回叩く操作は先に `defer`。
- Bot に要る権限: View Channels / Send Messages / Read Message History / Manage Channels / Pin Messages（`PermissionFlagsBits.PinMessages`、discord-api-types 0.38.56 に有り）。Administrator・Manage Roles は不要。
- ツールを追加する PR（PR4, PR7）はデプロイ直後に全セッションで 1 回だけキャッシュミスする。許容。

## 1. PR の並び（依存順。各 1 論点）
| # | ブランチ | 目的 | 依存 |
|---|---|---|---|
| 1 | feature/p2-interactions | Interaction 受信基盤 + ギルド単位コマンド登録 + `/help` | - |
| 2 | feature/p2-setup | `/setup` とギルド設定の DB 化（v2）、env inbox は fallback | 1 |
| 3 | feature/p2-new-session | `/new` でセッション作成、受付拡張、満杯カテゴリ自動追加（v3） | 2 |
| 4 | feature/p2-close | `/close`: `session_report` ツール → 確認ボタン → 要約保存 → 完了へ移動。ChannelOpsQueue。resume 失敗の復旧（v4） | 3 |
| 5 | feature/p2-wait | `/wait`・発言で復帰・12h 無発言→待ち。Scheduler。[続ける][閉じる] | 4 |
| 6 | feature/p2-nav | `/sessions` `/tasks`、#inbox ピン留めホームパネル（モーダル） | 5 |
| 7 | feature/p2-auto-session | #inbox で `session_open` ツール + 歯止め | 4 |
| 8 | feature/p2-delete | 完了 30 日後の削除（確認ボタン必須、要約は残す）（v5） | 5 |
| 9 | feature/p2-inbox-rotate | #inbox の日次ローテーション（前日要約を持ち越し）（v6） | 4,5 |

### PR1 Interaction 基盤
- gateway.ts に追加: `Interaction`（kind: command/button/select/modal、guildId/channelId/userId/createdAt、command は name+options、button/select は customId(+values)、modal は customId+fields）、`InteractionResponder { defer(ephemeral), reply(msg), update(msg), showModal(def) }`、`OutgoingMessage { text, components?, ephemeral? }`（components は buttons 行 ≤5 個 / string select ≤25 件）、`CommandDef`。
- `Gateway.start({ onMessage, onInteraction })`、`registerGuildCommands(guildId, defs)`（`guild.commands.set` = bulk overwrite。起動時に許可ギルド全部へ）。許可外ギルドからの interaction は無視。
- `src/app/interactions.ts`: 所有者チェック → `commands/<name>.ts` / `buttons.ts` へ振り分け。P1 の `createHandler` は触らない。`/help` は静的テキストを ephemeral 返信。
- テスト: 所有者以外/許可外ギルドは拒否、`/help` が ephemeral、未知の customId は無視して log。
- 完了条件: `npm test` 通過、起動時にコマンドが許可ギルドに登録される。実機（#4）: 登録反映、3 秒以内 defer、bulk overwrite が 200 回/日の作成上限に数えられるか（未確認）。

### PR2 /setup とギルド設定
- v2: `guild_settings(guild_id PK, home_category_id, inbox_channel_id, tasks_channel_id, system_channel_id, home_panel_message_id NULL, created_at, updated_at)`、`state_categories(guild_id, state('active'|'waiting'|'done'), ordinal INT, category_id UNIQUE, created_at, PK(guild_id,state,ordinal))`。`src/store/guild-settings.ts`。
- Gateway 追加: `createCategory(guildId,name)`, `createTextChannel(guildId,{name,parentId,topic?})`, `channelExists(id)`。
- `/setup`: defer(ephemeral) → DB 行が無ければ `self-agent` カテゴリ + #inbox/#tasks/#system、`進行中`/`待ち`/`完了` カテゴリ（ordinal 1）を作り保存。既にあれば各 ID の存在を確認し、消えたものだけ作り直す（冪等）。結果を ephemeral でリンク列挙。
- `config.ts`: `inboxChannelId` を `missingForStart` から外す。`access.ts`: `isAccepted(event, cfg, resolve)` に変更し、`resolve(guildId, channelId) → 'inbox' | 'session' | null` を store から引く。DB 行が無いギルドだけ env を inbox とみなし、起動時に「/setup 未実行、env フォールバック中」を log（P3 で env 廃止）。
- テスト: 新規作成の呼び出し順と保存 ID、2 回目は作り直さない、一部欠損の再作成、env フォールバックの有無。
- 実機: カテゴリ overwrite の付与可否（§3）、作成チャンネルが親と同期されるか（未確認。されなければ `permissionOverwrites` にカテゴリの overwrite を明示コピーして作る）。

### PR3 /new とセッション
- v3: `sessions(channel_id PK, guild_id, title, state, category_id, created_at, last_activity_at, waiting_since NULL, closed_at NULL)`。`src/store/sessions.ts` は `channel_sessions` 用のまま残し、新規に `src/store/topic-sessions.ts`（名前衝突回避）。
- Gateway 追加: `countChannelsIn(categoryId)`（Discord の実数。手動で置かれた分も数える）。
- `/new 題名`: defer(ephemeral) → `active` の ordinal 昇順で空き（<50）を探し、無ければ `進行中 N` を作って `state_categories` に追加 → チャンネル作成（name は題名を正規化: 空白→`-`、100 字切り、記号除去。topic に元の題名）→ sessions 保存 → ephemeral に `<#id>`、新チャンネルに「セッション「題名」を始めました」。
- 受付: `resolve` が `'session'`（state != deleted）なら受ける。handler の key は channelId のまま。`buildTurnPrompt` の channelName に title を渡す。発言で `last_activity_at` 更新（ターン投入前に同期で）。
- テスト: 空きカテゴリ選択・満杯時の `進行中 2` 作成・名前正規化・セッションチャンネルでの受付と prompt ヘッダ。

### PR4 /close と要約
- ツール `session_report(summary ≤600字, tasks[{title, due?}] ≤10)` を全セッション共通で追加。`createTaskMcpServer(tasks, ctx)` に per-run ctx `{guildId, channelId}` を渡す（定義は同一、クロージャだけ変わる）。ハンドラは `sessions.close_draft`（v4: `summary TEXT, close_draft TEXT(JSON)` 追加）に保存して `{ok}` を返す。
- 流れ: `/close`（セッション外なら ephemeral 拒否）→ defer → 静的 CLOSE_PROMPT（「session_report を 1 回呼べ」）で resume ターン → draft 無ければ返答本文を summary に → チャンネルに要約 + タスク番号付き + `close:all|pick|none:<ch>`（tasks 0 件なら確認無しで確定）→ `pick` は string select（multi）→ 確定: task_add 相当で登録、`state=done, closed_at, summary`、draft 削除、完了カテゴリへ移動、元メッセージを編集してボタン除去。再起動後もボタンは DB の draft で動く（無ければ「/close をやり直してください」）。
- `src/app/channel-ops.ts` ChannelOpsQueue: 全ギルド共通で直列、間隔 `SELF_AGENT_CHANNEL_OP_GAP_MS`（既定 2000）、同一 channelId は最新の目的カテゴリに統合、既に目的カテゴリなら skip、失敗は 30s/2m/10m で 3 回再試行後 log。移動先も満杯なら `完了 N` を自動追加。
- resume 失敗の復旧: run が ok:false かつ resume 起因（エラー文字列は実機で確定、未確認）なら `channel_sessions` の行を消し、`channel_seeds(channel_id PK, text, created_at)`（v4）に「前の記録が切れたため要約から再開」+ summary を入れ、同ターンを sessionId 無しで 1 回だけ再実行。handler は「sdk session 無し かつ seed あり」なら prompt 先頭に seed を付けて seed を消す（seed は PR7/9 でも使う）。
- テスト: draft 保存→3 種ボタン→登録件数と状態、0 件の即確定、再起動相当（新 handler）でボタンが動く、queue の統合・skip・再試行、resume 復旧の 1 回限り。実機: 要約品質、ボタン応答、移動のレート制限（§5）。

### PR5 /wait・復帰・12h・Scheduler
- `src/app/session-state.ts`: 純関数 `transition(state, event) → {next, actions}`（event: message/wait/continue/close/idle12h）。`src/app/scheduler.ts`: `tick()` を公開、`start(intervalMs=5min)`、clock 注入。起動直後に 1 回 tick（再計算は DB から行うので永続タイマー不要）。
- idle: `active` かつ `last_activity_at ≤ now-12h`（`SELF_AGENT_IDLE_HOURS` 既定 12）→ waiting、待ちへ移動、「12 時間発言がないので待ちに移しました」+ `wait:continue:<ch>` `wait:close:<ch>`（close は PR4 の流れ）。1 tick で動かすのは最大 5 件。
- `waiting`/`done` で発言 or [続ける] → active、`closed_at` を null、進行中へ。`/wait` は即 waiting。
- テスト: 遷移表の全組合せ、tick の境界時刻、5 件上限、再起動後の tick で過去分を拾う。

### PR6 ナビゲーション
- `/sessions`: 状態ごとに `<#id> 題名（最終 n 時間前）` を ephemeral、各 25 件まで。`/tasks`: open 20 件。
- ホームパネル: /setup の最後に #inbox へ投稿してピン留め（`pinMessage` 追加）、message_id を保存。ボタン `home:new`（モーダルで題名 → PR3 と同じ処理）/`home:tasks`/`home:waiting`（ephemeral 一覧）。無くなっていたら /setup で再投稿。
- 実機: ピン留め権限、モーダル表示。

### PR7 #inbox からのセッション起こし
- ツール `session_open(title, context ≤400字)` を共通集合に追加。ctx が inbox 以外なら `{result:"not_available"}`。歯止め: 1 日 `SELF_AGENT_AUTO_SESSION_PER_DAY`（既定 3）、前回から 15 分、同じ正規化題名の active/waiting があればそれを返す、超過時は `{result:"limit"}`（LLM は「/new で作って」と案内）。成功時は PR3 と同じ作成 + `channel_seeds` に context を入れ、`{channelId}` を返す。
- システムプロンプトに静的な 1 行を追加（「3 往復以上かかりそうな相談・設計・調べものは session_open、単発のタスク登録では使わない」）。
- テスト: inbox 以外で不可、上限・クールダウン・重複、seed が最初のターンに付く。

### PR8 30 日後の削除
- v5: sessions に `delete_prompt_message_id NULL, deleted_at NULL`。tick: `done` かつ `closed_at ≤ now-30d` かつ prompt 未送信 → #system に「<#id> 題名 を削除しますか」+ `del:yes:<ch>` / `del:keep:<ch>`（keep は closed_at を今にして 30 日延長）。yes → `deleteChannel`、`deleted_at` 設定、要約は残す。確認無しの自動削除はしない。
- テスト: 送信は 1 回だけ、keep の延長、yes 後は受付対象外。

### PR9 #inbox の日次ローテーション
- v6: `inbox_summaries(id, guild_id, date, summary, created_at)`、`guild_settings.inbox_rotated_date`。tick: ローカル `SELF_AGENT_INBOX_ROTATE_AT`（既定 04:00）を過ぎ、かつ未ローテなら: その日に inbox のターンが無ければ記録だけ更新、あれば `session_report` で要約 → 保存 → `channel_sessions` の inbox 行を削除 → seed に「前日までの要約」を入れる。プロセス停止で跨いだ場合は次の tick で実行（怠惰実行の保険）。
- テスト: 境界日時、ターン無しの日は LLM を呼ばない、seed が翌日最初のターンに付く。

## 2. 決めてほしい点への回答
- **ギルド設定**: DB（PR2）。env は fallback + 起動時 log、P3 で削除。理由: /setup 前でもコマンドだけは動く必要があり、env を必須にすると P1 と二重管理になる。
- **#inbox**: 日次ローテ（PR9）推奨。1 本で伸ばすと cache read が毎ターン増え、いずれ context 上限。代替の「サイズで切る」は補助として `SELF_AGENT_INBOX_MAX_INPUT_TOKENS`（既定 150k、超えたら次の tick で同処理）を PR9 に含める。
- **長くなりそう**: LLM ツール `session_open` + 数値の歯止め（PR7）。ヒューリスティック（連投回数）は誤爆が多い。
- **権限の絞り方**: 案A = Bot ロールにギルド全体の Manage Channels（確実、他カテゴリも触れてしまう）。案B = /setup 実行時だけ案A、完了後オーナーが全体権限を外し、Bot が /setup 中に自分へ付けた各カテゴリの overwrite（Manage Channels, Pin Messages）だけ残す。公式仕様は「作成は MANAGE_CHANNELS が要る」「親変更は元・先双方で要る」とあり、カテゴリ overwrite だけで作成できるかは**未確認**。推奨: 案B を #4 で検証、不可なら案A。
- **移動のレート制限**: parent_id の制限は公式未記載。name/topic 以外は 10 回/15 秒/チャンネル（コミュニティ情報）。対策は ChannelOpsQueue（直列・2 秒間隔・統合・再試行）+ tick あたり 5 件 + 名前を変えない。
- **タイマー**: プロセス内 5 分 tick + DB 駆動（PR5）。再起動時は起動直後の tick が過去分を拾うので再計算処理は不要。
- **ナビ**: PR6（/sessions /tasks /ホームパネル）。[続ける][閉じる] は PR5、削除確認は PR8。

## 3. 未決（オーナー判断）
1. 権限方式 案A/案B（#4 の検証結果で決める）。
2. チャンネル名: 題名のみ（推奨）か `1002-題名` の日付接頭辞か。
3. ローテ時刻 04:00、自動セッション上限 3/日、idle 12h の既定値でよいか。
4. 削除確認の投稿先: #system（推奨、見落としにくい）か当該チャンネルか。
5. #tasks の中身（P2 では空のまま作るだけ。一覧メッセージの常時更新は P4 の朝サマリーと一緒に）。
6. 既存の手作りカテゴリを /setup で再利用するか（P2 は常に新規作成）。
7. 共用サーバーでオーナーが管理者でない場合、コマンドを他メンバーに見せない設定（default_member_permissions）をどうするか。
