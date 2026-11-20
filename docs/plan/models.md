# 話題を始めるときにモデルを選ぶ（設計）

2026-11-20。根拠の path はリポジトリの相対。

## 0. 何のために

- 話題ごとに仕事の重さが違う（調べもの・雑談は軽いモデル、設計・実装は重いモデル）。今は全部が 1 つのモデル（`SELF_AGENT_MODEL`）で動き、Max の枠を一律に使う。
- オーナーの要求:「使用するモデルもリクエスト時に選べるようにしたい」。決定済み: **選ぶのは話題を始めるとき**。場所（プロジェクト）の担当に**表示名と既定のモデル**を持たせ、話題を始めるときに上書きできる。口調・別 Bot は無し。
- 守る規則: モデルと effort はセッションの途中で変えない／ツールの集合は固定／システムプロンプトとツールの description の変更はまとめる（CLAUDE.md「プロンプトキャッシュの規則」）。

## 1. 今の事実

### 確かめた事（コード）

| 事 | 根拠 |
|---|---|
| モデルは env だけで決まる。`SELF_AGENT_MODEL`、無ければ `claude-opus-5`。文字列の検査は無い | `src/config.ts:198`・`:702` |
| effort も env だけ（`SELF_AGENT_EFFORT`。low〜max）。未設定なら Options に入れない | `src/config.ts:6`・`:717`、`src/agent/query-options.ts:347` |
| 軽いモード（#inbox・#tasks・今までのセッション）は `model: cfg.model` | `src/agent/query-options.ts:317` |
| プロジェクトのセッションも `model: cfg.model`（`config` そのもの）。runner は 1 つを共有 | `src/agent/project-profile.ts:282`・`:297`、`src/main.ts:328` |
| 人格は runner を 1 つずつ持ち `persona.model ?? config.model`。プロジェクトのセッションには人格を付けられない | `src/main.ts:368`、`src/app/commands/new.ts`（PROJECT_PERSONA_REPLY） |
| モデルは**毎ターン** Options で渡す（resume のときも同じ Options に `resume` を足すだけ） | `src/agent/sdk-runner.ts:811`・`:864` |
| **DB にモデル・effort の列は無い**（sessions・usage_log とも）。残るのは devlog だけ | `src/store/db.ts`（v3・v40 の sessions、最新 v46）、`src/agent/sdk-runner.ts:770` |
| 1 回の run に付ける情報は `RunContext`。`projectDir`・`permissionMode` が既にこの形で通っている | `src/agent/runner.ts:23-24`、`src/app/turn.ts:220`・`:235` |
| 話題を始める道: Web・右腕・GitHub の［対応］は `startTopic` の 1 本。`/new` は `openTopicSession`。取り込みは `topicSessions.create` を直に呼ぶ | `src/app/session-ops.ts`（startTopic）、`src/main.ts:1184`、`src/cc/takeover.ts:696` |
| 自前のツール（MCP）はプロジェクトのセッションにも同じものが付く | `src/agent/project-profile.ts:294-295` |
| `/renew` は引数なし。要約 → `sessions.delete` で新しい SDK セッションになる | `src/app/commands/renew.ts:34`、`src/app/session-renew.ts:100-101` |
| 場所ごとの設定を置く表は無い（`projects` 表は「作って URL で渡すプロジェクト」で別物） | `src/store/db.ts:180` |

帰結: **今は env を変えて再起動すると、進行中の全セッションが次のターンから黙って別のモデルになる**（どこにも固定していないため）。

### 確かめた事（SDK・公式）

- SDK は `@anthropic-ai/claude-agent-sdk` 0.3.286 固定（`package.json:28`）。npm の最新は 0.3.329。
- `Options.model?: string`（省略は CLI の既定）。別名（`opus`・`sonnet`・`haiku`・`fable`）と完全な ID の両方を受ける（`sdk.d.ts:1957`・`:56`）。
- 記録したシステムプロンプト（snapshot）のセッションは、途中でモデルを変えてもプロンプトは変わらない（`sdk.d.ts:2358-2384`）。プロジェクトのセッションは snapshot: true。
- init のメッセージに実際の `model` が入る（`sdk.d.ts:5885`）。
- 公式: 間違ったモデル名は起動時に弾かれず、最初の要求で失敗する。別名は CLI の版で指す先が動く（opus → 5.5 は v2.1.280、fable → 5.2 は v2.1.321）。［出典 1］
- 公式の最新: Fable 5.2 `claude-fable-5-2`、Opus 5.5 `claude-opus-5-5`、Sonnet 5.5 `claude-sonnet-5-5`、Haiku 5.5 `claude-haiku-5-5`。**今の既定 `claude-opus-5` は 1 世代前**（API の定価は 5.5 より高い）。［出典 2］
- 同梱の CLI（0.3.286）のバイナリに文字列が在る: `claude-opus-5-5`・`claude-sonnet-5-5`・`claude-opus-5`・`claude-sonnet-5`・`claude-fable-5-1`・`claude-fable-5`・`claude-haiku-4-5`。**無い**: `claude-fable-5-2`・`claude-haiku-5-5`。

### 推測・未確認

- 文字列が在る = Max の枠で呼べる、ではない。**各 ID を実際に 1 ターン通して確かめていない**（枠を使うので未実施。`SELF_AGENT_MODEL=<ID> npm run measure` で確かめられる）。
- `claude-fable-5-2`・`claude-haiku-5-5` は今の SDK では通らない見込み（公式は「CLI を上げよ」と書く）。SDK を上げれば通る見込みだが未確認。
- Max の枠の重み: 公式の表は見つからなかった。「週の上限は全モデル共通 + Fable は別の週の上限」は検索結果の要約だけで、元のページ（出典 3）は 404 で読めなかった。公式に読めたのは「プランによっては Fable の利用が枠ではなく usage credits に課金されることがある」［出典 1］。
- プロジェクトの `.claude/settings.json` の `model` と Options のどちらが勝つかは未確認（`docs/plan/unify.md:170` も未確認と書く）。

## 2. モデルの一覧をどう持つか

**コードの定数にする**（新しいファイル `src/agent/models.ts`。env にはしない）。

- 形: `{ key, label, model }` の配列。`key` は系列の名前（`opus`・`sonnet`・`haiku`・`fable`）、`label` は画面の字（「Opus 5.5」）、`model` は**完全な ID**。
- SDK の別名（`opus` など）は渡さない。CLI を上げると指す先が動き、進行中の会話が黙って変わるため。
- セッションには**完全な ID を固定**する。場所の既定は **key** で持つ（一覧を上げると、新しい話題から新しい版になる。進行中は変わらない）。
- env にしない理由: 選択肢は `/new` の choices・Web・テストに出る。定数なら型とテストで守れる。変えるのは年に数回。
- 最初の中身（推薦）: `opus` = `claude-opus-5-5`、`sonnet` = `claude-sonnet-5-5`、`haiku` = `claude-haiku-4-5`。`fable` は §10 の決め事 1。
- 全体の既定（`SELF_AGENT_MODEL`）はそのまま。一覧に無い ID でも動く（表示は ID そのまま）。

## 3. 入口ごとの形

| 入口 | 形 | ツール・プロンプトに触るか |
|---|---|---|
| Discord `/new` | 任意の引数 `model`（choices = 一覧の key と label）。省略は場所の既定 | 触らない（Discord のコマンド定義だけ） |
| Web「話題を始める」 | 板に「モデル」の選択を 1 つ足す。初期値は選んだ場所の既定。`POST /api/topics` の body に `model?`（key） | 触らない |
| 右腕 `session_open` | 任意の引数 `model`（**enum にしない文字列**。key）。使えない名前は結果 `bad_model` で使える key を返す | **触る**（ツールの定義。全セッションで 1 回キャッシュが外れる） |
| GitHub の［対応］ | 選ばせない。場所（そのリポジトリのプロジェクト）の既定 | 触らない |
| 取り込み（`/cc take`） | 選ばせない。場所の既定。端末のモデルは引き継がない（`src/cc` にモデルの情報が無い） | 触らない |
| #inbox・#tasks | **対象外**。`SELF_AGENT_MODEL` のまま（長く続く会話で、始める瞬間が無い） | - |
| 人格つき（`/new persona:`） | `model` と併用は断る（人格のモデルが決める。project と persona の併用を断るのと同じ扱い） | 触らない |

右腕に引数を足さない道: 在る（右腕は常に場所の既定で始め、変えたければ話題の側で `/renew model:`）。ただし「Sonnet で調べて」と #inbox で頼めない。要求の中心が「リクエスト時に選ぶ」なので、**引数を足す方を推す**。enum にせず文字列にするのは、一覧を変えてもツールの定義が変わらないようにするため。

解決の順（全入口で同じ・`startTopic` と `/new` の中で 1 か所）: 明示の指定 > 場所の既定 > NULL（= 全体の既定に従う。今と同じ）。

## 4. 保存と表示

- **移行 v47 が要る**（1 回にまとめる）:
  - `ALTER TABLE sessions ADD COLUMN model TEXT`（完全な ID。NULL = 全体の既定に従う。今ある行は全部 NULL = 挙動は変わらない）
  - `CREATE TABLE place_settings (place TEXT PRIMARY KEY, label TEXT, model TEXT, updated_at TEXT NOT NULL)`（place は `general` か `p:<名前>`。`model` は key。label が担当の表示名）
  - `ALTER TABLE usage_log ADD COLUMN model TEXT`（`npm run usage` でモデルごとに見るため。今は見えない）
- 実行: `RunContext` に `model?` を足し、`turn.ts` が `permissionMode` と同じ所で入れる。`query-options.ts:317` と `project-profile.ts:282` は `context.model ?? cfg.model`。devlog（`sdk-runner.ts:770`）も実際に渡した値にする。
- 表示:
  - Web: 会話の見出し（`src/web/static/c-shell.js` の `topModel`。場所・モードの並び）に label。スマホは「…」の板。一覧の行には出さない（狭い）。
  - Discord: 作ったチャンネルの最初の投稿（`welcomeText`）に 1 行「担当: <表示名>（<label>）」。全体の既定のときは出さない。
  - `topic_list` の結果の行に `model`（結果だけ。定義は変えない）。
- 場所の既定と表示名の編集: Web の設定に「場所」の一覧（表示名・既定のモデル）。env にしない（§10 の決め事 3）。

## 5. 途中で変える

- **その場の切り替えは作らない**（規則どおり。プロジェクトのセッションは snapshot でプロンプトも変わらない。キャッシュも捨てる）。
- 変えたいときは**会話を新しくする**: `/renew model:<key>`（Web は「…」の板の［モデルを変える］→ 確認「会話は新しくなり、要点を引き継ぎます」）。
  - 要約のターンは**今のモデル**で走らせ、成功した後に `sessions.model` を書き換えて SDK セッションを捨てる。要約が失敗したら変えない。
- 場所を変えたとき（topic_move）はモデルを変えない（場所の既定に引っ張られると、頼んでいない変更になる）。

## 6. effort も選べるようにするか

**しない（推薦）**。effort は今のまま `SELF_AGENT_EFFORT` の 1 つ。

- 選択肢が 4 × 5 = 20 通りになり、スマホの板と `/new` で選べない。
- effort ごとにキャッシュが別（`docs/environment.md:15`）。組み合わせが増えるほど効かないターンが増える。
- 「軽く／重く」はモデルの選択で足りる。足りなければ後で一覧の項目に effort を持たせた決め打ち（例 `opus-max`）を足せる（そのとき列を 1 つ足す）。

## 7. 案と推薦

- **A（小）話題に固定 + `/new`・Web で選ぶ**: v47 は `sessions.model` だけ。場所の既定・表示名・右腕の引数・`/renew model:` は無し。
- **B（中）A + 場所の既定と表示名 + 右腕の引数 + `/renew model:` + usage の列**: §2〜§5 の全部。
- **C（大）B + effort の選択 + 会話を変えずに切り替える `/model` + 一覧を設定画面で編集**。

| | A | B | C |
|---|---|---|---|
| オーナーの決定（場所の既定・表示名・上書き）を満たす | △ 上書きだけ | ◎ | ◎ |
| 右腕（#inbox）から選べる | ✗ | ◎ | ◎ |
| キャッシュの規則を守る | ◎ 外れ 0 | ○ ツール定義で 1 回（#448 に同梱できる） | ✗ 途中の切り替えが規則に反する |
| 実装コスト | ◎ PR 2 本 | ○ PR 6 本（小さい） | △ PR 9 本前後 + 実測 |
| 運用コスト | ◎ | ○ 一覧の更新が年に数回 | △ 組み合わせの確認が増える |

メリット / デメリット:
- A: 速い・安全。ただし毎回手で選ぶことになり、場所の既定という決定を満たさない。右腕経由（一番使う入口）で選べない。
- B: 決定を全部満たす。入口が 1 本（`startTopic`）なので足す所が少ない。デメリットはツール定義の変更が 1 回要ること。
- C: 自由度は最大。規則に反し、効果（キャッシュ・枠）を実測しないと入れられない。今は要求に無い。

**推薦: B。** 外部サービスは増やさない（追加の運用コスト 0 円）。

## 8. PR の分け方（B。各 PR は先に issue）

### PR-0: `session_open` に引数 `model` を足す（#448 の再起動に同梱）
- 済（#452）。describe の文（確定。後で変えない）:「使うモデルの名前（オーナーが名前で指定したときだけ、言われた名前のまま渡す）。使えない名前なら話題は作られず、使える名前の一覧が返るので、オーナーに伝えて選び直してもらう（自分で別の名前を選んで呼び直さない）。省略すると場所の既定のモデルで始まる」。
- 渡されたら note「モデルの指定はまだ使えないので、既定のモデルで始めました」（結果に `model` の欄は足していない。PR-2 で note を消す）。

### PR-1: 一覧・v47・実行の配線（入口なし = 挙動は変わらない）
- 触る: 新 `src/agent/models.ts`（一覧・`resolveModelKey(key)`・`labelOf(id)`）、`src/store/db.ts`（v47。§4 の 3 つ）、`src/store/topic-sessions.ts`（`create` に `model?`、`modelOf(channelId)`、`setModel`）、新 `src/store/place-settings.ts`（get・set・list）、`src/agent/runner.ts`（`RunContext.model?`）、`src/app/turn.ts`・`src/app/session-renew.ts`（context に入れる）、`query-options.ts`・`project-profile.ts`・`sdk-runner.ts`（`context.model ?? cfg.model`）、usage の記録に model、`src/cli/usage.ts` に列。
- 受け入れ: v46 の DB が v47 に上がり、今ある行の `model` は NULL／`sessions.model` が NULL のセッションの Options は変更前と同じ（比較のテスト）／値のあるセッションは軽いモード・プロジェクトのセッションとも Options.model がその値／#inbox・#tasks・予約した依頼は `cfg.model`／`npm run usage` に model の列。
- テスト: 移行、Options の同一性、偽 Runner が受けた context、人格の runner は NULL のとき人格のモデル。

### PR-2: 入口（`/new`・startTopic・右腕・［対応］・取り込み）
- 触る: `src/app/session-ops.ts`（`StartTopicInput.model?`、解決の関数 1 つ、`welcomeText` の 1 行）、`src/app/commands/new.ts`（`model` の choices。`persona` と併用は断る）、`src/app/right-hand.ts`（PR-0 の note をやめ、使えない名前は `bad_model` + key の一覧）、`src/web/routes/topics.ts`（body の `model`。重複よけのキー `:681` に足す）、`src/cc/takeover.ts`（場所の既定）。
- 受け入れ: `/new model:sonnet` の話題は `sessions.model = claude-sonnet-5-5`／省略で場所の既定が在ればその ID、無ければ NULL／`session_open` の `model: "xxx"` は話題を作らず `bad_model`／［対応］と取り込みは場所の既定／最初の投稿に担当の行（NULL のときは無い）。
- テスト: 解決の順の表（明示・場所・無し）、各入口 1 本ずつ。

### PR-3: Web（始める板・見出し）
- 触る: `src/web/static/shell.js`（板の選択。場所を変えたら初期値も追う）、`c-shell.js`・見本（見出しの label）、`GET /api/topics` の行に `model`・`modelLabel`、`GET /api/models`（一覧と場所の既定）。
- 受け入れ: 板で選んだ key が body に入る／見出しに label／スマホは「…」の板。**ui-shots の前後の画を PR に付ける**。

### PR-4: 場所の既定と表示名の編集（Web の設定）
- 触る: `GET/PUT /api/places/<place>/settings`、設定の画面の「場所」。
- 受け入れ: 既定を変えると**次に始めた話題だけ**が変わる（進行中は変わらない）／表示名が見出しと最初の投稿に出る／一覧に無い key は 400。

### PR-5: `/renew model:` と Web の［モデルを変える］
- 触る: `src/app/commands/renew.ts`（任意の `model`。セッションのチャンネルだけ。#inbox・#tasks では断る）、`src/app/session-renew.ts`（成功の後に `setModel`）、`POST /api/topics/ch:<id>/model`、「…」の板。
- 受け入れ: 要約は古いモデルで走る／成功後の次のターンは新しいモデルで新しい SDK セッション／要約の失敗時は変わらない／実行中のターンが在れば断る。

順: PR-0 →（再起動）→ PR-1 → PR-2 → PR-3 → PR-4 → PR-5。PR-1 までは何も見た目が変わらない。PR-2 で Discord から使える。

## 9. キャッシュ・再起動・コスト

- **キャッシュが外れるのは PR-0 だけ**（ツールの定義）。軽いモードは #448 で既に 1 回外れるので、同梱すれば追加は「プロジェクトのセッションの 1 回」だけ。逃すと、後日もう 1 回全セッションで外れる。
- PR-1〜5 は再起動は要るがキャッシュは外れない見込み（NULL のセッションの Options が同じであることを PR-1 のテストで守る）。実機では `npm run usage` の読みで確かめる。
- モデルを変えた話題は新しい会話になるので、その話題だけ最初のターンは書き込みになる（当然の費用）。
- 枠の目安（API の定価の比。入力）: Fable 5.2 : Opus 5.5 : Sonnet 5.5 = 8 : 4 : 2。Max の枠での重みは公式に確認できていない。
- 外部サービスの追加なし。月額の増減なし。

## 10. 決まった事・決めてほしい事

決まった事（オーナー・2026-11-20）: 選ぶのは話題を始めるとき／場所の担当に表示名と既定のモデル／口調と別 Bot は無し。
この設計で決めた事（異論が無ければこのまま）: 一覧はコードの定数・セッションには完全な ID を固定／#inbox・#tasks は対象外／effort は選ばせない／途中の変更は `/renew model:` だけ／人格との併用は断る。

オーナーに決めてもらった事（3 つ）: 1〜3 はオーナーが推薦どおりに決めた（2026-11-20）。ただし全体の既定を上げるか・`fable` を足すかは未決のまま。
1. **一覧の中身**。推薦: `opus`（5.5）・`sonnet`（5.5）・`haiku`（4.5）の 3 つで始める。`fable` は、課金（枠か usage credits か）を自分のアカウントで確かめてから足す。あわせて、全体の既定を `claude-opus-5` → `claude-opus-5-5` に上げるかは別の判断（推薦: 上げる。変えた直後は各セッションの最初のターンだけキャッシュが効かない）。
2. **PR-0 を #448 の再起動に同梱するか**。推薦: する（別 PR にして、再起動だけ 1 回にまとめる）。待てないなら同梱をあきらめ、後日 1 回の外れを受け入れる。
3. **場所の既定と表示名の編集の場所**。推薦: Web の設定（PR-4）。Discord のコマンドは作らない。

ほかの未決（決める人）:
- 各 ID が Max の枠で通るかの実機確認（オーナー。`SELF_AGENT_MODEL=<ID> npm run measure`。枠を使う。PR-2 のマージの前）。
- SDK を 0.3.329 に上げて Fable 5.2・Haiku 5.5 を使うか（オーナー。別 issue。上げると CLI の挙動も変わるので shell-check が要る）。
- プロジェクトの `.claude/settings.json` の `model` が Options に勝たないことの確認（PR-1 の実機確認。devlog の init の model で見る）。

## 11. 出典

1. https://code.claude.com/docs/en/model-config （別名・版の履歴・間違った名前の扱い・effort・Fable の課金の注意）
2. https://platform.claude.com/docs/en/about-claude/models/overview （ID と定価）
3. https://support.claude.com/en/articles/11014257-about-claude-s-max-plan-usage （404 で読めず。検索結果の要約だけ）
4. `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（0.3.286）と同梱の CLI のバイナリの文字列
