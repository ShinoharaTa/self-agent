# 定型チャンネル（領収書・予定など）と #inbox からの引き渡し、画像の受け取り、スキル — 設計案（#119）

> 2026-10-14。spec-writer。リポジトリは変更していない。
> 「確認」= 2026-10-14 に main（79ec8b0）・PR #118 の差分・SDK 0.3.286 の sdk.d.ts と同梱 CLI・公式文書で確かめた事実。「未確認」= 実装・受け入れで確かめるまで前提にしない。

## 0. 目的・結論

目的（オーナー、#119）: 領収書の登録・予定の管理のような**決まった仕事を、いつも同じチャンネルで対話しながら**片付けたい。セッション（/new・/close・待ち/完了）を意識しない。#inbox で頼んだら、その仕事のチャンネルに任せられる。
追加の要望（同日）: 貼った画像を見る・外部サービスを操作するのを「スキル」として使えるようにしたい。

結論（推薦）:
1. 新しいチャンネルの種類 **定型チャンネル**（kind `routine`）。カテゴリ「定型」に置く。状態（進行中/待ち/完了）・/close・idle の待ち・30 日後の削除は**無い**。#inbox と同じく日次・サイズで要約して自動で切り替える。作るのはオーナーの `/routine new` だけ。
2. チャンネルごとに**手順**（オーナーが決めた常設の指示、2,000 字まで）を DB に持つ。システムプロンプトには入れず、**新しい SDK セッションの最初の prompt の先頭**に毎回 DB から付ける（記憶のブロックと同じ仕組み）。会話の途中で変えたら、次のターンの先頭に新しい手順を 1 回だけ追記する（履歴は追記だけなのでキャッシュは壊れない）。
3. データは**汎用の記録表 1 つ**（`routine_records`。日付 + 自由な項目の JSON + 添付）と**ツール 1 つ**（`routine_records`）。領収書も予定もこれで表す。定型ごとの専用ツールは作らない。予定の知らせは既存のリマインド（reminder_set）を使う。
4. #inbox からの引き渡しは**ツール 1 つ**（`routine`：list / handoff / propose_instructions）。handoff は相手のチャンネルに依頼を投稿し、そのチャンネルのキューで 1 ターン起こす（待たない）。
5. **画像の受け取りはアプリの機能**（Gateway が添付を取り、そのターンの prompt に image の content block として渡す）。スキルでは作れない（スキルは指示の文書で、Discord の添付を取る手段を持たない）。全チャンネルで効く。キャッシュは外れない。
6. **スキル**は「やり方（手順書）」の置き場として SDK の Skills を使う。リポジトリの外のディレクトリをローカル plugin として読み、使うスキルは設定で固定する。外部サービスの**操作そのもの**はスキルではなく、アプリが持つ MCP のツール（秘密は Bot の env だけ）で足す。最初の一歩は「Skills を有効にして、領収書の読み方のスキル 1 つ」まで。外部サービスは対象を決めてから（R7 のカレンダーなど）。
7. ツール・システムプロンプトの変更（キャッシュが全セッションで 1 回外れる）は、シェルの PR 3・#108 の A・#117 の書き出しのツールと**同じ再起動**にまとめる。

外部サービスは増えない（運用費 0 円）。増えるのは利用枠（画像 1 枚あたりの入力）とディスク（領収書の画像）。どちらも §5.6。

---

## 1. コードで確認した事実 / 推測

確認:
- 受け付けるチャンネルの種類は `inbox | tasks | session`（`access.ts` の `ChannelKind`、`runner.ts` の `RunContext.kind`）。PR #118 で足した人格の `#<NAME>` は種類 `inbox` として受け付ける。
- `acceptedChannel` は `event.content.trim() === ""` を弾く。**画像だけの発言は今は無視される**。`IncomingMessage` に添付の項目は無い（`gateway.ts`）。intents は Guilds・GuildMessages・MessageContent。
- runner の prompt は文字列だけ（`RunInput.prompt: string`、`QueryFn` も `prompt: string`）。SDK の `query()` は `prompt: string | AsyncIterable<SDKUserMessage>` を受け、`SDKUserMessage.message` は Messages API の MessageParam（text・image・document の block を持てる）。
- 1 ターンの上限は `context.kind === "session"` かどうかの 2 通り（sdk-runner.ts:416）。session 以外は 8 手順・`SELF_AGENT_TURN_TIMEOUT_SEC`。キューの枠も「session かそれ以外か」の 2 通り（queue.ts）。
- 種類で分岐している箇所: project_open（session 以外は not_available）、ファイルの書き込み（session のプロジェクトだけ）、session_open（resolver が inbox のときだけ）、reminder_set の prompt（tools.ts:546 は session だけ弾く。発火側 reminders.ts:376 は inbox・tasks だけを実行先にする）、要約の seed（turn.ts:230 は tasks 以外を inbox の要約にする）、日時ヘッダのチャンネル名（handler.ts:367）。
- 切り替え（`inbox-rotate.ts`）は「スロット（種類 × 人格）」を順に回す形に PR #118 で一般化済み。要約の prompt は静的な文字列で種類ごと、要約は `inbox_summaries`（guild・種類・人格ごと）に残す。
- 状態カテゴリは `state_categories`（state は CHECK で active/waiting/done）と `findStateCategory`（満杯なら `進行中 N` を作る）。
- システムプロンプトは引き継ぎの文を名前で列挙している（「これまでの #inbox の要約:」など）。「#inbox と #tasks では短く…セッション（ヘッダが #inbox・#tasks 以外）では必要なだけ」の書き分けがある。
- 通知の方針（REQUIREMENTS）: 鳴らすのは朝のサマリー・リマインド・承認待ち・停止の 4 種だけ。
- SDK の Skills（sdk.d.ts・公式文書）: `skills?: string[] | 'all'` で有効にする（Skill のツールは `tools` に明示が要る）。スキルは `settingSources` の user/project か、`plugins: [{ type: 'local', path }]` から見つかる（今は `settingSources: []`）。`skills` は「文脈の絞り込みで sandbox ではない」と明記。同梱 CLI に `skill_listing`・「The following skills are available for use with the Skill tool:」の文字列があり、スキルの一覧はシステムプロンプトではなく会話の添付（system-reminder）として送られる。`disableSkillShellExecution`（スキルの `` !`cmd` `` を実行しない）と `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`（同梱スキルを消す）がある。

推測・未確認:
- prompt を `AsyncIterable<SDKUserMessage>`（1 件 yield して終える）にしても、resume・hooks・result の扱いは文字列のときと同じ（結合テストで確かめる）。
- 画像 1 枚の入力トークン。長辺 1568px 程度なら約 1,600 トークン（従来のモデルの目安）。`claude-opus-5` の解像度の上限と換算は未確認。`npm run measure` で実測する。
- Discord の media proxy（attachment の proxyURL に `?width=&height=`）で縮小した画像を取れる。取れなければ §5.4 の代案。
- スキルの一覧の添付は、セッションの最初と一覧が変わったときだけ会話に入る（毎ターンではない）。スキル集合を変えても既存のセッションは追記で済む。
- dontAsk のままで `skills` を渡せば Skill のツールが通る（SDK が allowedTools に足すと文書にある）。

---

## 2. 定型チャンネルの概念

### 2.1 何が違うか

| | #inbox・#tasks | セッション | 定型チャンネル（新） |
|---|---|---|---|
| 目的 | 入口・タスクの見直し | 話題ごとの作業 | 決まった仕事を繰り返す |
| 数 | 固定 | 増えて閉じる | オーナーが作った分（サーバーごと 20 まで） |
| 状態・/close・idle で待ち・削除の確認 | 無し | 有り | **無し** |
| 会話の切り替え | 日次・サイズで要約 | /renew だけ | **日次・サイズで要約**（#inbox と同じ規則） |
| 常設の指示 | システムプロンプト | 無し | **チャンネルの手順（DB）** |
| データ | タスク | プロジェクト | **記録（routine_records）** |
| 1 ターンの上限・キューの枠 | 8 手順・300 秒・セッション以外 | 40 手順・900 秒・セッション | 8 手順・300 秒・セッション以外 |
| プロジェクト・ファイルの書き込み・シェル | 不可 | 可 | **不可**（必要ならセッションで） |

### 2.2 作り方・一覧・名前・削除（決定案）
- 作る: `/routine new name:<名前> purpose:<1 行の目的> template:<領収書|予定|空>`（人格を足していれば `persona` も。PR #118 の /new と同じ形）。作ったら手順の編集モーダルを続けて出す（テンプレートを初期値に）。**エージェントは作らない**（#inbox で「経費のチャンネルがほしい」と言われたら /routine new を案内する）。理由: session_open と違い消えないチャンネルなので、勝手に増やさない。
- テンプレート: リポジトリの `templates/routines/receipts.md`・`schedule.md`（一般的な文だけ。個人の情報は入れない）。作るときに DB に写す（以後はファイルを見ない）。
- 一覧と操作: `/routines`（本人にだけ。セレクトで選ぶ → [手順を編集][削除]）。ホームパネルにはボタンを足さない（5 個の枠を使わない）。
- 名前: Discord のチャンネル名そのもの。改名はオーナーが Discord で行い、5 分ごとの再同期で DB の名前を合わせる（改名のコマンドは作らない）。handoff の名前の照合は DB の名前で行う。
- 削除: [削除] → 確認 → Discord のチャンネルを消し、DB は `archived` にする。**記録・添付・手順は残す**（#117 の書き出しで取り出せる）。オーナーが Discord で直接消した場合も、再同期で `archived` に。戻す機能は作らない。
- カテゴリ: 「定型」を 1 つ（最初の /routine new で作り、`guild_settings.routine_category_id` に保存。/setup でも消えていれば作り直す）。上限 20 なので `定型 2` のあふれは作らない（`state_categories` の CHECK を変えずに済む）。並びは self-agent の次。
- 人格: `routines.persona`（既定 `default`）。返事・handoff の投稿は持ち主の Bot（PR #118 の `gatewayFor`）。チャンネル名に接頭辞は付けない（オーナーが名前を決めるため）。topic に人格名と目的。
- 再同期（scheduler.ts の最初）: Discord 上に無い → archived、カテゴリが違う → 「定型」へ移す、名前が違う → DB を更新。

---

## 3. 手順（チャンネルごとの常設の指示）

### 3.1 置き場（比較）

| 観点 | (a) DB の列 + Discord のモーダルで編集 | (b) リポジトリ外のファイル（SSH で編集） | (c) スキル（SKILL.md）として持つ |
|---|---|---|---|
| スマホから直せる | ◎ | △ SSH + エディタ | △ 同左 |
| 確実に効く（毎回渡る） | ◎ セッションの最初に必ず付ける | ◎ | △ モデルが説明を見て呼んだときだけ |
| チャンネルに閉じる | ◎ | ◎ | ✗ 一覧は全チャンネルに出る |
| エージェントに直させる | ○ 提案 → オーナーのボタンで反映 | ✗ | ✗ |
| 実装量 | ○ | ◎ | ○（§8 の仕組みが前提） |

**推薦: (a)**。手順は短く（2,000 字）、チャンネル固有のこと（何を記録するか・勘定科目の候補・返事の形）だけ書く。何度も使うやり方（領収書の読み方・外部サービスの使い方）は §8 のスキルに置き、手順から名前で指す（例「読み取りは receipt-reading スキルに従う」）。

### 3.2 渡し方（キャッシュの規則を守る）
- 新しい SDK セッションの最初の prompt: `[記憶のブロック, 手順のブロック, seed, prompt]` を空行でつなぐ（今の `[記憶, seed, prompt]` に 1 つ足す）。手順のブロックは毎回 DB から作り、seed には保存しない。
  - 形: `このチャンネルの手順（オーナーが決めたもの）:\n<本文>`。
- 会話の途中で手順を変えたら: `routines.instructions_rev` を 1 増やす。SDK セッションに渡した版を `routines.seen_rev` に記録しておき、次のターンで `seen_rev < instructions_rev` なら prompt の先頭に `手順が変わりました。以後はこの手順に従ってください:\n<本文>` を付けて `seen_rev` を進める。
- 正しさ: 会話は追記だけ。古い手順は履歴に残るが、新しい方が後ろにあり明示的に置き換えを宣言する。切り替え（§4）で古い手順は消える。
- コスト: 手順 2,000 字 ≒ 1,500 トークン程度（推定）が SDK セッションの最初に 1 回。以後はキャッシュの読み。変更時に同じ分を 1 回追記。システムプロンプト・ツールは変わらない。
- エージェントからの変更: `routine` ツールの `propose_instructions`（新しい全文）→ アプリが差分の要約と [反映する][やめる] を投稿 → オーナーが押したときだけ保存（kb_delete の確認と同じ形）。Web の中身の指示で手順が書き換わらないようにするため、**ボタン無しには反映しない**。
- モーダル: Discord の段落入力は 4,000 字まで（手順の上限 2,000 字はこれに収まる）。

---

## 4. 会話の切り替え（オーナーがセッションを意識しないため）
- 規則は #inbox と同じ: 毎日 `SELF_AGENT_INBOX_ROTATE_AT` を過ぎたら、または直近の成功したターンの最後のステップの入力が `SELF_AGENT_INBOX_MAX_INPUT_TOKENS` を超えたら、要約して SDK セッションを捨てる。会話が無ければ LLM を呼ばない（定型チャンネルが増えても、使わない日は 0 ターン）。環境変数は足さない。
- 実装: `InboxRotator` のスロットに `{ kind: "routine", channelId }` を足す（PR #118 のスロットの形をそのまま使う）。切り替えの日と時刻は `routines.rotated_date`・`rotated_at`。
- 要約の頼み方（静的な文、定型チャンネル共通）:「会話を新しくするので、ここまでのやり取りのうち、今後も必要なこと（確認待ちのもの・途中のもの・決めた約束）だけを 600 字以内の箇条書きで返答してください。記録は DB にあり、手順は別に渡すので、どちらも書き写さないでください。ツールは使わないでください。」
- 要約の置き場: `routines.summary`（直近の 1 つだけ。resume 失敗の復旧にも使う）。`inbox_summaries` は guild × 種類 × 人格の鍵なのでチャンネルごとの要約に合わない。
- seed: `これまでの #<名前> の要約:\n<要約>`。新しいセッションの最初には手順のブロックも付く（§3.2）。
- 画像は会話の履歴に残るので入力が膨らむ。日次の切り替えで消える。サイズの判定で早めに切り替わることもある（受け入れる）。
- /renew: 定型チャンネルでは rotateNow と同じ（#inbox と同じ扱い）。
- 知らせ: 切り替えたら今と同じ 1 行（「会話を新しくしました…」）。定型チャンネルが多いと毎朝並ぶので、**定型チャンネルでは知らせない**（推薦。未決 4）。

---

## 5. データ

### 5.1 汎用の記録（比較）

| 観点 | (a) 定型ごとの専用ツール（receipt_add など） | (b) 汎用の記録表 + ツール 1 つ | (c) チャンネルごとの CSV/Markdown を Read/Edit |
|---|---|---|---|
| ツール集合の固定 | ✗ 定型を足すたびに変わる | ◎ 1 回だけ | ◎ 増えない |
| 合計・期間の絞り込み | ◎ | ○ SQL で（合計はアプリが出す） | △ モデルが足し算する（間違える） |
| 書き換えの事故 | ○ | ○ 1 件ずつ・取り消しは void | △ Edit で他の行を壊しうる |
| #117 の書き出し | ○ | ◎ CSV/Markdown にアプリが変換 | ◎ そのまま |
| 実装量 | ✗ | ○ | ○（書き込みの許可を session 以外に広げる） |

**推薦: (b)**。

`routine_records`（v20）:
```sql
CREATE TABLE routine_records (
  id INTEGER PRIMARY KEY,
  channel_id TEXT NOT NULL,          -- 定型チャンネル
  date TEXT,                         -- YYYY-MM-DD（領収書の日付・予定の日）。無くてもよい
  fields TEXT NOT NULL,              -- JSON オブジェクト（値は文字列か数。30 キー・2,000 字まで）
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX routine_records_channel_date ON routine_records (channel_id, status, date);
```
- 項目の名前は手順で決める（例: 領収書は `store`・`amount`・`tax`・`category`・`payment`、予定は `time`・`title`・`place`）。表の形はアプリが強制しない。
- 消すのは `void`（タスクの dropped と同じく戻せる）。物理削除はしない。

ツール `routine_records`（定型チャンネルのターンでだけ使える。それ以外は not_available）:
- `action: "add"`: `date?`・`fields`・`attach?: boolean`（true ならこのターンの添付をこの記録に結びつける）→ `{ result: "added", id, date, fields, attachments: n }`。
- `action: "list"`: `date_from?`・`date_to?`・`query?`（fields の文字列の部分一致）・`status?`（既定 active）・`sum?`（数の項目名）・`limit?`（既定 30、最大 100）→ `{ records: [...], total?: number, count }`。合計はアプリが出す（モデルに足させない）。
- `action: "update"`: `id`・`date?`・`fields?`（指定したキーだけ変える。null でキーを消す）・`status?`（active / void）→ `{ result: "updated", before, after }`。
- 結果の id は返事に出させ（「#12 を直して」で通じる）、ログは「routine_records: add（#id）」だけで中身は出さない。

### 5.2 領収書
- 流れ: オーナーが #領収書 に写真を貼る（文は無くてよい）→ アプリが画像をそのターンに渡す（§5.3）→ モデルが読み取り、手順の項目で `add`（attach: true）→「#12 10/14 ○○ 1,280 円（会議費）で記録しました。違えば言ってください」の 1〜2 行。
- 読めない・曖昧なら記録せずに聞く（手順に書く）。
- 「今月の合計」→ `list`（date_from・date_to・sum: amount）。

### 5.3 画像の受け取り（アプリの機能。全チャンネル）

| 観点 | (A) そのターンの prompt に image の block で渡す | (B) ファイルに置き、モデルが Read で見る |
|---|---|---|
| 確実さ | ◎ 貼った画像は必ず見える | △ モデルが Read を呼んだときだけ |
| 手順の消費 | ◎ 0 | △ 1 手順（#inbox は 8 まで） |
| 許可の広さ | ◎ ファイルの許可を変えない | △ Read の許可を projects の外へ広げる。シェル（PR 3）の allowRead が workDir 全体なので、workDir に置くとセッションの Bash から全部の領収書が読める |
| 変更の範囲 | △ runner の prompt を AsyncIterable にする | ○ |
| キャッシュ | ◎ 会話への追記だけ | ◎ 同左 |

**推薦: (A)**。原本は `<dataDir>/attachments/` に置き（シェルの sandbox が読めない場所）、エージェントのツールからは触らせない。

決定案:
- 対象: 受け付けるすべてのチャンネル（#inbox・#tasks・セッション・定型）の、オーナーの発言の添付。種類は `image/jpeg`・`image/png`・`image/webp`・`image/gif`。1 発言 4 枚まで、1 枚 10 MB まで（Discord の通常の上限に合わせる）。それ以外の添付は「（添付 n 件は読めない形式のため渡していません）」をヘッダの次に付けて本文だけ渡す。
- 画像だけの発言も受け付ける（`acceptedChannel` の空の判定を「本文も読める添付も無い」に変える）。
- 取り方: discord.js の `message.attachments` の url を Gateway で取得（タイムアウト 15 秒）。モデルに渡すのは長辺 1568px に縮めたもの（Discord の proxyURL の width/height。未確認。§5.4）。base64 で 3.75 MB（API の 5 MB の上限の手前）を超えたら渡さず、「画像が大きすぎて読めませんでした」と返す。
- 保存: 原本を `<dataDir>/attachments/<guildId>/<channelId>/<messageId>-<n>.<ext>`（ディレクトリ 700・ファイル 600）。DB `attachments`（id・guild_id・channel_id・message_id・path・content_type・size・width・height・sha256・record_id・created_at・deleted_at）。
- 保持: 記録に結びついたもの（`record_id` あり）は残す。結びついていないものは 30 日で消す（scheduler の tick。.trash の掃除と同じ並び）。void にした記録の添付は残す（戻せるように）。
- ターンへの渡し方: `RunInput` に `images?: { mediaType; data(base64) }[]` を足す。sdk-runner は images があれば `prompt` を `{ type: "user", message: { role: "user", content: [text, ...images] }, parent_tool_use_id: null }` を 1 件 yield する AsyncIterable にする（`client_composed` は付けない。付けるとスキルの一覧が付かない）。resume 失敗のやり直しにも同じ画像を渡す。RunContext に `attachmentIds` を足し、`routine_records` の attach と handoff で使う。
- ログ・devlog: console には枚数だけ。devlog は `[画像 2 枚]` の印だけ（base64 を書かない）。
- プライバシー: 画像は会話の一部として Anthropic の API に送られ、SDK の会話の記録（`CLAUDE_CONFIG_DIR` の下）にも base64 で残る（テキストと同じ扱い）。README の安全の節に 1 行書く。

### 5.4 縮小の手段（未確認の分岐）
- 1 案: Discord の media proxy の縮小（依存なし）。PR-R2 の最初に実機で確かめる。
- 効かなければ: (i) 縮小せず 3.75 MB 以下だけ渡す（スマホの写真は超えることがある）か、(ii) `sharp`（ネイティブの依存）を足す。**(i) で出して困ったら (ii)**（オーナー判断。未決 6）。
- 原本は縮めずに保存する（個人事業の帳簿の要件がありうるため。要件の適否は未確認・オーナーの判断）。

### 5.5 予定
- 予定 = 記録（date・fields.time・title・place）。「来週の予定は」→ `list`（期間）。
- 知らせ: 既存の `reminder_set` を予定のチャンネルで使う（知らせはそのチャンネルに出る。reminders.md §2.5 の規則どおり）。記録とリマインドは結びつけない（リマインドの text に「#12 歯医者」と書かせる程度）。
- 予約した依頼（prompt）を定型チャンネルでも使えるようにする（「毎朝 7 時に今日の予定を出して」）。セッションではないので reminders.md §2.1 の理由（状態の扱い）は当たらない。変えるのは `reminders.ts` の実行先の判定（inbox・tasks・routine）と、reminder_set の説明文（「prompt は #inbox・#tasks だけ」→ 「セッション以外」。**キャッシュの束に入れる**）。
- Google カレンダー（R7）は対象外。入れるときは §8.3 の外部サービスの形で、記録の代わりにカレンダーを正にするかをそこで決める。

### 5.6 コスト
- 外部サービス: 0 円。
- 利用枠: 画像 1 枚 ≒ 1,600 トークン（推定）。履歴に残るので、その日の後のターンではキャッシュの読みとして毎回数える。領収書 1 日 5 枚なら 1 日の終わりの会話で 8,000 トークン程度の上乗せ（推定）。
- ディスク: スマホの写真 2〜5 MB。月 50 枚で最大 250 MB/月、年 3 GB 程度（最悪）。保存先は `/` と共有（shell.md §1.2）なので、/usage に添付の合計を 1 行出す（PR-R2）。

---

## 6. #inbox からの引き渡し

### 6.1 ツール `routine`
- `action: "list"` → `{ routines: [{ name, purpose, channel: "<#id>" }] }`（archived は出さない）。
- `action: "handoff"`: `name`・`request`（1〜1,000 字）・`attach?: boolean`（このターンの画像を渡す）→
  - `{ result: "queued", channel: "<#id>" }`
  - `{ result: "not_found", routines: [...] }`（名前が合わない。候補を返す）
  - `{ result: "not_available", message }`: 定型チャンネル自身のターン（定型どうしで渡し合わない）、予約した依頼のターン、context の無いターン。
  - `{ result: "limit", message }`: 同じ定型へ 1 時間に 10 件まで（ループよけ）。
  - `{ result: "failed" }`: 相手のチャンネルへの投稿に失敗（ターンは入れない）。
- `action: "propose_instructions"`（定型チャンネルのターンだけ）: §3.2。
- 説明文（案）:「定型チャンネル（領収書・予定など、決まった仕事のチャンネル）を扱う。#inbox やセッションで、ある定型チャンネルの仕事を頼まれたら handoff で渡し、<#チャンネルID> に渡したことを 1 行で伝える（中身はそちらで進む）。名前が分からなければ list。定型チャンネルで手順を変えてと言われたら propose_instructions に新しい全文を渡す（オーナーが確認して反映する）。」

### 6.2 流れ（handoff）
1. ツールが検証 → 相手のチャンネルに持ち主の Bot で投稿: `<#元のチャンネル> からの依頼: <request>`（attach なら「（画像 n 枚）」）。
2. 投稿に成功したら、相手のチャンネルの key で `turnQueue.run` にジョブを入れ、**待たずに** `queued` を返す（ツールの中で他のターンを待つと、枠の取り合いで詰まる）。
3. ジョブ: 停止中なら戻る → `runChannelTurn`（kind `routine`、prompt は `buildTurnPrompt("<#元> からの依頼（オーナーが頼んだもの）:\n<request>", 今, tz, 名前)`、images は渡した分、allowedUrls は元のターンのもの）→ 返事を相手のチャンネルに投稿（メンションなし）。
4. 失敗は相手のチャンネルに今と同じ形で返す。

オーナーに見えるもの:
- #inbox: モデルの 1 行「<#領収書> に渡しました」。
- #領収書: Bot の「#inbox からの依頼: …」→ その返事。未読の印で気づく。**メンションしない**（通知の 4 種の方針。未決 5）。

守り:
- 依頼の文は #inbox のエージェントが書く。#inbox で読んだ Web のページの指示が混ざりうる → 相手側は「#… からの依頼」をアプリの文脈と扱い、記録の変更は返事に必ず出す（void で戻せる）。手順の変更は handoff 経由でもボタン必須（§3.2）。
- 定型チャンネルからは handoff できない（往復しない）。

### 6.3 予約した依頼
- 定型チャンネルで頼んだ prompt のリマインドは、そのチャンネルで動く（§5.5）。#inbox から「毎朝予定を出して」と頼まれたら、handoff で予定のチャンネルに頼み、そこで reminder_set させる（#inbox に作らない）。

---

## 7. #117（Markdown の書き出し）との関係（メモだけ）
- 記録は `routine_records` にあるので、「今月の領収書を CSV で」はアプリが組み立てて添付で渡せる（画像は zip かリンク）。#117 の成果物を渡すツールに `source: "records"` を足すか、/export に定型の記録を足すかは #117 の設計で決める。
- 送るファイルの添付（Gateway の送信側）は #117 で作る。受け取り側（§5.3）と同じ `attachments` の表・保存先を使えるよう、列名は揃えておく。

---

## 8. スキル（オーナーの追加の要望）

### 8.1 何をスキルにし、何をアプリの機能にするか

| 能力 | 置き場 | 理由 |
|---|---|---|
| 貼った画像を受け取る | **アプリ**（§5.3） | スキルは指示の文書。Discord の添付を取る手段（Gateway・トークン）を持たない。WebFetch は貼られた URL の GET だけで画像を見られない |
| 画像の読み方（領収書の項目・和暦・税込みの判定など） | **スキル** | 何度も使うやり方。どのチャンネルでも使える |
| 外部サービスを操作する（API を呼ぶ） | **アプリの MCP ツール**（＋使い方はスキル） | 秘密（API キー・OAuth）を Bot の env にだけ置き、CLI の子・モデル・シェルに見せないため |
| チャンネル固有の常設の指示 | **定型チャンネルの手順**（§3） | 必ず効かせたい・スマホで直したい |

### 8.2 Skills の有効にし方（決定案）
- 置き場: リポジトリの外の **ローカル plugin** `~/.config/self-agent/skills-plugin/`（`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`）。個人の情報（勘定科目・店・会社名）が入りうるので public のリポジトリに置かない。見本だけ `templates/skills/receipt-reading/SKILL.md` に置く。
- Options: `plugins: [{ type: "local", path, skipMcpDiscovery: true }]`、`skills: [<設定のスキル名>]`（`'all'` にしない）、`tools` の末尾に `"Skill"`、`settingSources: []` は変えない（CLAUDE.md・ユーザー設定は読まない）、env に `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`、flag settings に `disableSkillShellExecution: true`。
- 設定: `SELF_AGENT_SKILLS_DIR`（既定は上の場所）・`SELF_AGENT_SKILLS`（使うスキル名のカンマ区切り。未設定なら Skills を有効にしない = 今と同じ）。起動時に 1 回読み、プロセスの間は固定。
- v1 のスキルは **SKILL.md 1 枚だけ**（補助のファイル・スクリプトを持たない）。補助のファイルを Read させるには file-access.ts の Read の許可を skills のディレクトリへ広げる必要があり、今は要らない。
- オーナーが SSH で書く。エージェントにはスキルを書かせない（Write の許可は session のプロジェクトだけのまま。skills のディレクトリは workDir の外なのでシェルの allowWrite にも入らない）。

### 8.3 外部サービス（形だけ決め、最初のサービスは選んでから）
- 形: サービスごとに `src/agent/services/<name>.ts` の自前 MCP のツール（in-process。今の `createTaskMcpServer` と同じ）。秘密は `~/.config/self-agent/env`（600）の変数で、Bot のプロセスだけが読む。CLI の子には渡さない（childEnv は許可方式のまま）。有効にするかは env の有無で決め、起動時に固定。
- 第三者の MCP サーバー（stdio）を使う場合: 版を exact で固定し、子の env は許可方式でそのサービスの秘密だけ。説明文は相手が書くので、版を上げるたびにキャッシュが外れる。**自前の薄いツールを推薦**。
- スキルのスクリプト + シェル + curl は**使わない**: シェル（PR 3）はセッションのプロジェクトだけ・ネットは GitHub/npm だけ・秘密は sandbox から見えない作りなので、外部の API を叩けない（そう作ってある）。
- 書き込みを伴う操作（予定の登録・会計への登録）は REQUIREMENTS の R7 の「承認制」に合わせ、ツールは「下書き → オーナーのボタンで実行」にする。
- サービスを足す = ツール集合が変わる = 全セッションで 1 回外れる。足すときは他の変更と束ねる。

### 8.4 キャッシュ
- `tools` に `Skill` を足す: 1 回外れる（束ねる）。
- スキルの一覧は会話の添付（system-reminder。確認: CLI の `skill_listing`）。スキル集合を固定すれば安定。スキルを足す・説明を変えると、既存のセッションには一覧の差分が追記される見込み（未確認。devlog と /usage で確かめる）。
- スキルの本文は呼んだときにツールの結果として会話に入る（呼ばれなければ 0）。

### 8.5 安全
- スキルは指示の権限を持つ文書。書けるのはオーナーだけ（ディレクトリ 700、workDir の外）。
- `skills` は sandbox ではない（SDK の明記）。守りは今の PreToolUse の hook（ファイル・WebFetch・シェル）のまま。スキルの frontmatter の `allowed-tools` で Bash などが許可されても hook が拒否する（受け入れ条件でテスト）。
- `context: fork`（サブエージェントで動かす）のスキルは書かない（プロジェクトの方針。Agent のツールは tools に無い）。
- 同梱のスキル（code-review など）は消す。

### 8.6 最初の一歩
1. 画像の受け取り（PR-R2。キャッシュに影響なし）で「貼った画像を見る」は先に叶う。
2. キャッシュの束（PR-R4・R5）で Skills を有効にし、見本 `receipt-reading` を 1 つ。
3. 外部サービスは対象を決めてから（候補: R7 の Google カレンダー。承認制）。

---

## 9. PR 分解（1 PR = 1 論点。implementer に渡す粒度）

順序の前提: PR #118（人格の入口）を先にマージ（access.ts・inbox-rotate.ts・setup.ts・new.ts が重なる）。

- **PR-R1 ストア**（振る舞いは変えない。キャッシュ影響なし）: DB v20（`routines`・`routine_records`・`attachments`、`guild_settings.routine_category_id`）。`src/store/routines.ts`・`routine-records.ts`・`attachments.ts` と単体テスト。
  - `routines`: channel_id PK・guild_id・persona・name・purpose・instructions・instructions_rev・seen_rev・summary・rotated_date・rotated_at・state（active/archived）・created_at・updated_at・archived_at。サーバーごと active 20 件まで（ストアで数えられるように）。
- **PR-R2 画像の受け取り**（キャッシュ影響なし）: §5.3・§5.4。Gateway の添付（取得・縮小・形式と大きさの判定）、`acceptedChannel` の空の判定、保存と 30 日の掃除、`RunInput.images` と sdk-runner の AsyncIterable、resume 失敗のやり直しでも渡す、devlog の印、/usage に添付の合計、README の 1 行。
- **PR-R3 定型チャンネル**（キャッシュ影響なし。ツール・システムプロンプトは変えない）: kind `routine`（ChannelKind・RunContext・resolver）、`/routine new`（テンプレート 2 つ・モーダル・persona）、`/routines`（手順の編集・削除の確認）、「定型」カテゴリ、日時ヘッダの名前、手順のブロックと rev（turn.ts）、resume 失敗の seed、切り替えのスロットと要約の prompt、/renew、再同期（archived・カテゴリ・名前）、予約した依頼の実行先に routine、/help・README・CLAUDE.md。
  - この時点では記録のツール・handoff が無いので、定型チャンネルは「手順付きの常設の会話」として使える（記録はまだ会話の中だけ）。
- **PR-R4 ツールとシステムプロンプト**（**キャッシュが外れる束**）: `routine_records`・`routine` の 2 つ（MCP の末尾に足す）、reminder_set の説明文（prompt はセッション以外）、システムプロンプトの行（下記）、handoff のジョブ、propose_instructions の確認ボタン（`rtn:` 名前空間）、`npm run measure` の増分を PR に書く。
  - システムプロンプトに足す行（案）: 引き継ぎの文の列挙を「これまでの #… の要約:」の形にし、「このチャンネルの手順（オーナーが決めたもの）:」「手順が変わりました。」「#… からの依頼（オーナーが頼んだもの）:」をアプリの文脈として足す。「定型チャンネル（手順が付いているチャンネル）では手順に従い、短く 1〜3 行。手順に無い話題は #inbox を案内する」。「アプリについて」に定型チャンネルと /routine・/routines。
- **PR-R5 Skills**（**同じ束**）: §8.2。`SELF_AGENT_SKILLS_DIR`・`SELF_AGENT_SKILLS`、Options（plugins・skills・tools の Skill・env・flag settings）、見本のスキル、README（スキルの置き方と注意）、measure の増分。`SELF_AGENT_SKILLS` が無ければ Options は今と同一（テストで固定）。

束（1 回の再起動）: シェルの PR 3・#108 の A・#117 の成果物のツール・PR-R4・PR-R5。全部マージしてから 1 回だけ再起動する（Bot は main の作業ツリーで動くため、マージの間は再起動しない）。codex の PR-D（ツール定義を SDK 非依存に）が先に入るなら、R4 のツールはその形で書く。

---

## 10. 受け入れ条件（テストできる形）

PR-R1
- v19 の DB を開くと v20 に上がり、既存のテストがそのまま通る。移行前に控えが取られる。
- 記録の add/list（期間・部分一致・sum）/update（キーの削除・void）が単体テストで期待どおり。sum は数でない値を数えない。

PR-R2
- 偽 Gateway で画像 1 枚だけの発言を流すと受け付け、runner に `images` 1 件・prompt にヘッダが渡る。本文も添付も無い発言は今どおり無視。
- 対応しない形式・5 枚目以降・大きすぎる画像は渡さず、注記がヘッダの次に付く。
- 原本が `<dataDir>/attachments/…` に 600 で保存され、30 日を過ぎた結びつきの無いものが tick で消え、結びついたものは残る。
- console のログと devlog に base64・ファイル名・パスが出ない。
- 画像の無い発言の run は、今と同じく文字列の prompt で query() を呼ぶ（AsyncIterable にしない）。
- 結合テスト（トークンがあるとき）: 画像付きのターンで返事が返り、次のターンで resume できる。

PR-R3
- `/routine new` でカテゴリ「定型」とチャンネルができ、そのチャンネルの発言が kind `routine` で受け付けられる。21 個目は断る。
- 新しい SDK セッションの最初の prompt が `[記憶, 手順, seed, 発言]` の順。手順を変えると次のターンの先頭に 1 回だけ「手順が変わりました。」が付き、その次には付かない。
- 定型チャンネルのターンは 8 手順・`SELF_AGENT_TURN_TIMEOUT_SEC`・セッション以外の枠。project_open・Write・session_open は使えない。
- 日次の時刻を過ぎた tick で、会話のあった定型チャンネルだけ要約のターンが走り、`routines.summary` と seed が入る。会話の無いものは LLM を呼ばない。定型チャンネルには知らせを投稿しない。
- Discord 上でチャンネルを消すと次の tick で archived になり、受け付けなくなる。改名すると DB の名前が変わる。
- 定型チャンネルで頼んだ予約した依頼がそのチャンネルで動く。

PR-R4
- ツール名の並びと SYSTEM_PROMPT の名前の整合のテストが通る。
- `routine_records` は定型チャンネル以外で not_available。attach: true でそのターンの添付が記録に結びつく。
- handoff: 相手のチャンネルに「… からの依頼」が投稿され、相手の key でターンが 1 回走り、元のターンは待たずに queued を返す。定型チャンネル・予約した依頼のターンからは not_available。同じ相手へ 1 時間 11 件目は limit。投稿に失敗したらターンは走らない。
- propose_instructions はボタンを押すまで手順を変えない。[やめる]・古いボタンでは変わらない。
- measure の増分（ツール 2 つ分のトークン）を PR に書く。

PR-R5
- `SELF_AGENT_SKILLS` が無いとき、buildQueryOptions の結果が今と同一。
- あるとき: tools の末尾が `Skill`、skills が設定の名前の配列、同梱のスキルが init の一覧に無い、見本のスキルを呼べる（結合テスト）。
- スキルの frontmatter で Bash・Write を許しても、hook の判定どおり拒否される（偽のスキルで結合テスト）。

---

## 11. 決定事項と未決

決定（この案）:
- 定型チャンネルは状態を持たず、#inbox と同じ切り替え。セッション以外の枠と上限。プロジェクト・ファイルの書き込み・シェルは不可。
- 手順は DB、セッションの最初に付ける。エージェントの変更はボタンで確認。
- データは汎用の記録表とツール 1 つ。引き渡しはツール 1 つ（待たない）。
- 画像はアプリの機能で、prompt の image の block。原本は dataDir。
- スキルはやり方の置き場（リポジトリ外の plugin・固定の集合）。外部サービスはアプリの MCP ツール。
- ツール・プロンプトの変更は 1 回の束に。

実装者が決めてよい: 文言、列名、custom_id の形（`rtn:`）、テンプレートの文、縮小の幅の細部。

オーナーが決めたこと（2026-10-14）:
1. 呼び名とカテゴリ名は「定型」
2. **作り方: `/routine new` に加えて、オーナーが指示したときはエージェントが定型化する**（オーナーの回答「指示があったときは定型化する」）。#inbox などで「これを定型にして」と頼まれたら新しい定型チャンネルを作り、セッションのチャンネルで頼まれたらそのチャンネルを定型チャンネルに変える（状態のカテゴリから「定型」へ移し、手順はそれまでの会話から案を作ってボタンで確認）。頼まれていないのに作ったり変えたりはしない。ツールは R4 の `routine` に `create`・`convert` を足す（R3 はコマンドだけ）
3. サーバーあたりの上限 20
4. 定型チャンネルの日次の切り替えの知らせは出さない
5. handoff の返事でオーナーをメンションしない
6. 画像の縮小が Discord の proxy で効かなければ、まず大きすぎるものは断り、困ったら `sharp` を足す
7. 受け取る添付は v1 は画像だけ（PDF は後）
8. 添付の保持: 記録に結びついたものは無期限、それ以外は 30 日。原本は縮めずに残す
9. #inbox から記録は読まない（handoff で定型チャンネルに聞く）
10. 最初の外部サービスは今回は入れない
11. スキルを書くのはオーナー（SSH）だけ

順序の確認（オーナー）: #118 → R1 → R2（ここで画像が使える）→ R3 → 束（シェル PR 3・#108 A・#117 のツール・R4・R5）。R2 を #118 より先にしてもよい（触るファイルが少ない）。

---

## 出典
- SDK の Skills（skills の option・plugins で読む・settingSources・Skill のツール・sandbox ではない注意）: https://code.claude.com/docs/en/agent-sdk/skills
- 型: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（0.3.286）の `skills`・`plugins`・`SdkPluginConfig`・`SDKUserMessage`・`disableSkillShellExecution`・`disableBundledSkills`
- スキルの一覧が会話の添付であること: 同梱 CLI（`claude-agent-sdk-linux-x64/claude`）の文字列 `skill_listing`・"The following skills are available for use with the Skill tool:"
