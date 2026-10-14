# 人格（persona）— 1 プロセスに複数の Discord Bot・共有 DB・codex エンジン（シェル付き）— 設計案 v2（#114）

> 2026-10-13。spec-writer。リポジトリは変更していない。v1（人格ごとに別プロセス）をオーナーの回答で置き換えた版。
> 「確認」= 2026-10-13 にコード・ホスト・公式文書で確かめた事実。「未確認」= 実装・受け入れで確かめるまで前提にしない。出典は末尾。

## 0. 目的・オーナーの回答・結論

目的: オーナー 1 人が、同じ Discord サーバーで性格・役割の違う複数の相手（人格）と話せるようにする。タスク・記憶・ナレッジは全員で共有する。Claude の枠だけに頼らず、ChatGPT のプランの枠（codex）でも動かす。

オーナーの回答（2026-10-13）:
1. 2 体目は**同じサーバー**、できれば**同じプロセス**。環境（unit・env ファイル・checkout）を増やさない。
2. タスク・記憶・ナレッジは**共有**（同じ DB）。
3. codex の人格にも**シェル**を使わせる。
4. LINE は**後回し**（今は塞がない程度の配慮だけ）。

結論:
- **1 プロセス・1 DB・1 env ファイル・1 unit**。Discord の Bot（アプリ）を人格の数だけ同じプロセスで動かす（discord.js の Client を人格ごとに 1 つ）。
- **チャンネルには持ち主の人格が 1 つだけ**（DB の列）。発言に答えるのは持ち主の Bot だけ。二重の返事は構造上起きない。
- 管理の操作（カテゴリ・チャンネルの作成と移動・#system・スラッシュコマンド）は**既定の人格の Bot だけ**が持つ。2 体目の Bot は自分のチャンネルでの発言・返事・ボタンだけ（権限も最小）。
- 共有: タスク・リマインド・記憶・ナレッジ・プロジェクトの置き場（workDir）。人格ごと: SDK セッション・seed・要約・usage・devlog の印・自分のチャンネル。
- エンジンは人格ごとに固定（既定の人格 = Claude、2 体目 = codex を推薦）。キューは 1 本で全人格共通。シェルの排他（shell.md §2.9 I1・I2）は**エンジンをまたいで全体で 1**。
- codex のシェルは **shell.md の PR 3 とホストの準備（§6.1・§6.2）が済んでから**。codex は PATH の最初の `bwrap` を使うので、§6.1 の `/usr/bin/bwrap` 用の AppArmor の profile がそのまま効く見込み（未確認）。

---

## 1. 設定（env ファイルは 1 つのまま）

既定の人格（今の Bot）は今の変数のまま。足す人格だけ変数を足す。

| 変数 | 意味 |
|---|---|
| `SELF_AGENT_PERSONAS` | 足す人格の id（`[a-z0-9]{1,12}`、カンマ区切り）。未設定なら今と同じ 1 体だけ |
| `SELF_AGENT_PERSONA_<ID>_DISCORD_TOKEN` | その人格の Bot のトークン（ID は大文字） |
| `SELF_AGENT_PERSONA_<ID>_NAME` | 表示名（チャンネル名・topic・一覧に使う。20 字以内） |
| `SELF_AGENT_PERSONA_<ID>_PROMPT_FILE` | 人格の文（性格・口調・役割）のファイル。既定 `~/.config/self-agent/personas/<id>.md`。起動時に 1 回読む。リポジトリの外（個人的な内容になりうる。見本だけ docs に置く） |
| `SELF_AGENT_PERSONA_<ID>_ENGINE` | `claude` / `codex`（既定 claude） |
| `SELF_AGENT_PERSONA_<ID>_MODEL` / `_EFFORT` | そのエンジンのモデル・effort（プロセスの間は固定） |
| `SELF_AGENT_CODEX_HOME` | codex の認証と会話の記録。既定 `~/.local/share/self-agent/codex`（オーナーの `~/.codex` とは別。§5.1） |

- id は DB のキーになるので後から変えない。既定の人格の id は `default`（予約）。
- 2 体目の Bot の名前・アイコンは Developer Portal で設定（コードは持たない）。
- 起動時の確認: id の重複・予約語・トークンの欠け・同じトークンを 2 人格に（値は出さず変数名だけ出す）→ exit 1。
- `<dataDir>/lock`（二重起動の防止）は v1 と同じく入れる（同じ DB を 2 プロセスが使うと 2 回答える）。

---

## 2. 同じサーバーでのチャンネルの持ち主と振り分け

### 2.1 置き場（推薦）
```
self-agent（カテゴリ。既定の人格の Bot が作る）
  #inbox     … 既定の人格
  #tasks     … 既定の人格（タスクは共有なので 1 つだけ）
  #<NAME>    … 2 体目の入口（kind は inbox と同じ扱い）
  #system    … 既定の人格（全体の知らせ）
進行中 / 待ち / 完了（全人格で共有）
  #<題名>    … 既定の人格のセッション（名前は今と同じ）
  #<NAME>-<題名> … 2 体目のセッション（接頭辞で見分ける。topic にも人格名）
```
- 比較: (a) 上の形（入口だけ人格ごと・状態カテゴリは共有）◎ / (b) 人格ごとにカテゴリ一式（`<NAME>`・`<NAME> 進行中`…）△ カテゴリが倍、スマホで長い / (c) #inbox を共有してメンションで振り分け ✗ 1 つのチャンネルに SDK セッションが 2 本要り、取り違えと二重の返事の元。
- **推薦: (a)**。#tasks は共有のタスクを扱う場所なので 1 つで足りる。2 体目にタスクを頼むのは #<NAME> でも今どおりできる（ツールは共有の DB に書く）。

### 2.2 振り分けの規則（決定案）
- DB: 受け付けるチャンネルごとに `persona`（id）を 1 つ持つ。セッション（`sessions`）に列 `persona`（既存の行は `default`）。入口のチャンネル（#inbox・#tasks・#<NAME>）は新しい表 `persona_channels(guild_id, persona, kind, channel_id, rotated_at)` に移す（今の `guild_settings` の inbox/tasks の ID と切り替えの時刻は既定の人格の行として写す）。
- 発言: 全部の Bot が同じ発言を受け取る（同じサーバーにいるため）。`access.ts` の判定に「**このチャンネルの持ち主 = 受け取った Bot の人格**」を足し、それ以外の Bot は黙って捨てる。持ち主は 1 つなので二重には答えない。Bot の発言は今どおり無視（Bot 同士で会話しない。確認: access.ts）。
- セッションの持ち主: 作った人格。/new は人格を選ぶ任意の引数（`persona`、選択肢は表示名。既定は既定の人格）。#<NAME> の session_open で作ったものは 2 体目のもの。持ち主は後から変えない（SDK セッションがエンジンごとに別なので）。
- スラッシュコマンド: **既定の人格のアプリだけが登録する**。2 体目のアプリは何も登録しない（入力欄に同じコマンドが 2 つ並ばない）。2 体目のチャンネルで /close・/renew・/wait を打っても、既定のアプリが受け、**ターンはチャンネルの持ち主の人格（エンジン・プロンプト）で動かし、返事は持ち主の Bot が投稿**する。interaction への応答（本人だけの表示など）は受けたアプリから返す。
- ボタン・セレクト: 押下はそのメッセージを送ったアプリに届く（Discord の仕様）。だから全部の Bot の interaction を受け付け、custom_id の処理は今と同じ（どのアプリで受けたかは問わず、対象のチャンネルの持ち主で動かす）。2 体目が送るのは返事と、そのターンの [中断]・[続ける]・記憶の [取り消す]・kb_delete の確認だけ。
- 管理の操作: カテゴリ・チャンネルの作成・移動・削除、ピン留め、#system、再同期は**既定の人格の Bot が行う**。2 体目の Bot に要る権限は「チャンネルを見る・送る・履歴を読む」だけ（Manage Channels は渡さない）。カテゴリは非公開にしない方針（REQUIREMENTS）なので、2 体目もサーバーのロールで全チャンネルが見える。
- 投稿の経路: `gatewayFor(channelId)`（持ち主の Bot）と `adminGateway`（既定の人格）に分ける。返事・途中経過・入力中表示・リマインドの投稿・記憶の知らせは持ち主の Bot、それ以外は admin。
- リマインド: 作ったチャンネル（reminders.channel_id）の持ち主の Bot が投稿する。予約した依頼（prompt）のターンもその人格で動く。
- 2 体目の Bot が落ちた（ログインできない）とき: そのチャンネルには答えられない。起動時と tick に #system へ「<NAME> の Bot に接続できません」を 1 回（変わったときだけ）。既定の人格は動き続ける。
- /setup: 既定の人格の Bot が、足した人格の #<NAME> も作る（消えたものだけ作り直すのは今と同じ）。#<NAME> にもホームパネルを置くかは不要（コマンドは既定のアプリにある）。
- PR-B の時点で既定の人格の Bot のまま投稿していたもの（2 体目のチャンネルでどちらの Bot が出すかは PR-C で決める）: 新しいセッションの最初の投稿（`new.ts`・`session-open.ts`）、待ちに移した知らせ（`scheduler.ts`）、#inbox・#tasks の /renew の結果（`renew.ts`）、待ちの知らせの [閉じる] の結果（既定の人格の Bot のメッセージを書き換えるため）。devlog の人格の印も PR-C に回す。
  - **PR-C で決めたこと**: 新しいセッションの最初の投稿と待ちに移した知らせ（[続ける][閉じる] 付き）は**チャンネルの持ち主の Bot** が出す（失敗は今までどおり log だけで、既定の人格の Bot には回さない）。知らせを持ち主の Bot が出すので、[閉じる] の押下はそのアプリに届き、結果はそのメッセージの書き換え（= 持ち主の Bot）になる（PR-B より前に既定の人格の Bot が出した知らせは、既定のアプリで受けて書き換える）。/renew は #<NAME> でも使え、日次の切り替えと同じ処理をその人格の要約・切り替えの日と時刻で行い、結果は持ち主の Bot が投稿する（commandResponse。#inbox・#tasks は今までどおり公開の応答）。devlog の記録には人格の id（`persona`）を付け、`npm run devlog -- --persona <id>` で絞れる（印の無い以前の記録は既定の人格）。

### 2.3 受け入れ条件
- 2 つの偽 Gateway に同じ発言を流すと、持ち主の側だけが handler に渡す（両方・どちらでもない、が無い）。
- 2 体目のチャンネルで既定のアプリの /close を受けると、ターンは 2 体目の runner で動き、返事は 2 体目の Gateway から出る。
- 2 体目の Gateway は createCategory・moveChannel・deleteChannel・registerGuildCommands を呼ばれない（偽 Gateway で確かめる）。
- `SELF_AGENT_PERSONAS` が無いとき、DB の移行後も今のテストがすべてそのまま通る（振る舞いが変わらない）。
- 実機: 同じサーバーで #inbox と #<NAME> にそれぞれ書き、それぞれの Bot だけが答える。

---

## 3. 共有するもの・人格ごとのもの

| データ | 扱い | 理由・備考 |
|---|---|---|
| タスク・リマインド | 共有 | オーナーの回答。リマインドの投稿は作ったチャンネルの持ち主 |
| 記憶 | 共有。行に `created_by`（人格 id）を記録するが、**プロンプトの記憶のブロックには出さない** | 記憶はオーナーについての事実で、誰が覚えたかは要らない。出すと既定の人格のプロンプトも変わる |
| ナレッジ | 共有。`created_by` を記録（表示は kb_get の結果にだけ。v1 は出さない） | |
| プロジェクト（workDir・projects 表） | 共有の置き場。行はチャンネルごと = 持ち主の人格のもの。静的サーバーも 1 つ | 8 GB のイメージ・容量の判定・掃除を 1 つで済ませる（shell.md §2.7） |
| SDK セッション（`channel_sessions`） | チャンネルごと（= 人格ごと）。列 `engine` を足す | Claude の session_id と codex の thread_id は互いに resume できない。エンジンが違えば捨てて seed から（resume 失敗の復旧と同じ扱い） |
| seed・/close と /renew の要約 | チャンネルごと | |
| #inbox 系の日次の要約（`inbox_summaries`） | 人格ごと（列 `persona`） | 要約は会話の口調・文脈を含む |
| usage | 列 `persona`・`engine` を足す。/usage は人格ごとに分けて表示 | 枠が別（Claude / ChatGPT） |
| devlog | 1 つのファイルに人格の印を付ける | |
| session_open の 1 日の上限 | 全人格で合算 | オーナー 1 人のチャンネル数を抑える目的のため |

- 共有の代償: 2 体目でのプロンプトインジェクション（Web のページ等）が共有の記憶・タスクを変えうる。今の守り（記憶の変更は必ず知らせて [取り消す]、Web の中身の指示に従わない）をそのまま両方に効かせる。
- 記憶の変更の知らせは、変えた人格のチャンネルに出る（今と同じ）。もう一方の人格は次の新しいセッションの最初に記憶のブロックで知る（今と同じ規則）。

---

## 4. プロンプトキャッシュ

- システムプロンプトは人格ごとに起動時に 1 回組み立てる: `[人格の文] + [共通の本文]`。
  - 既定の人格は人格の文を持たず、**今の SYSTEM_PROMPT と 1 バイトも違わない**（単体テストで等しさを固定）。
  - 足した人格は、今の SYSTEM_PROMPT の最初の段落（「あなたは self-agent。…」）を人格の文に置き換え、残りは同じ。「#inbox と #tasks では短く」などの規則は、ヘッダの論理名で効かせる（#<NAME> のターンのヘッダは `#inbox` ではなく `#<NAME>` にし、共通の本文に 1 行「ヘッダが #inbox・#tasks・<入口のチャンネル> のときは短く」と書くと既定の人格のプロンプトが変わる → **#<NAME> のヘッダは `#inbox` と同じ論理名で出す**（Discord 上の名前と違うが、プロンプトを変えずに済む）。どちらにするかは §7 の未決 3）
- ツール集合: 人格（= エンジン）ごとに固定。
  - Claude の人格: 今と同じ（シェルの PR 3 の後は 7 個 + MCP）。
  - codex の人格: Codex の組み込み（版を固定）+ 同じ MCP のツール。ただし codex は**スレッドの種類で 2 通り**（#inbox 系はシェルなし、セッションはシェルあり。§5.3）。1 つのスレッドの中では変わらないので、スレッドごとのキャッシュは保たれる。
- 自前の MCP のツールの説明文は Claude と codex で同じ定義から作る（PR-3 で SDK 非依存に）。説明文を変えると両方のエンジンで 1 回外れる。
- Claude のキャッシュは人格ごとに別の系列になる（プロンプトの先頭が違うため）。既定の人格のキャッシュには影響しない。

---

## 5. エンジン（1 プロセスに Claude と codex）

### 5.1 codex の使い方（v1 の調べを引き継ぐ）
- `@openai/codex-sdk`（CLI の `codex exec --json` を起こす）を exact 版で固定し、Bot の node_modules の codex を使う（`codexPathOverride`。オーナーの `~/.local/bin/codex` 0.154.0 は使わない。確認）。
- 認証: `SELF_AGENT_CODEX_HOME` に、オーナーが 1 回 `CODEX_HOME=<そこ> <固定版の codex> login --device-auth`。公式は自動化には API キーを推奨し、ChatGPT のアカウントでの自動化は「信頼できる非公開の機械」「1 つの auth.json は 1 本の直列の流れだけ」を条件にする（確認）。→ **codex のターンはプロセス全体で同時に 1 つ**（codex の人格が 2 つになっても 1）。オーナーの `~/.codex/auth.json` とは共有しない。
- AgentRunner への対応・失うもの（maxTurns なし、ステップごとの usage と contextTokens なし、compaction の印なし、WebFetch の許可リストの hook なし）は v1 の §4.2・§4.3 のとおり。自前ツールは 127.0.0.1 の Streamable HTTP の MCP（run ごとのトークン → RunContext）で渡す。

### 5.2 キューと同時実行（1 本のキューを全人格で）
- `turnQueue` は今の 1 本のまま（key = channelId。チャンネルは 1 人格のものなので key は衝突しない）。
- 枠:
  - 全体: `SELF_AGENT_MAX_CONCURRENT`（人格を足したら 3 を推薦。§7）。
  - セッションのジョブ: 今どおり 全体 - 1（最低 1）。**`SELF_AGENT_SHELL=1` なら全人格・全エンジンで 1**（I2。workDir が共有のため）。
  - codex のジョブ: 全体で 1（auth.json の規則）。`QueueRunOptions` に `engine` を足し、`canStart` に「codex は動いている codex が 0 のときだけ」を足す。
- tick の掃除（.trash・.tmp・.cache）は今どおり「セッションのジョブが 1 つでも動いていれば飛ばす」。codex の人格のセッションのジョブも数える。

### 5.3 codex の人格のシェル（オーナーの回答 3）

**ホストで確かめたこと・分かったこと**
- 今のホストで `codex sandbox linux -- /bin/true` は `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` で失敗（確認）。`/usr/bin/bwrap` は未導入なので、これは codex の同梱の bwrap。
- 公式: 「Codex は PATH にある最初の `bwrap` を使い、無ければ同梱の helper に戻る」（確認: 公式の Sandbox の頁）。→ shell.md §6.1 で `bubblewrap` を入れ、Bot が codex に渡す PATH を shell.md の `shellPath`（`<node の bin>:/usr/local/bin:/usr/bin:/bin`）にすれば、**`/usr/bin/bwrap` + §6.1 の AppArmor の profile で動く見込み**（未確認。§6.1 の後に `codex sandbox linux -- /bin/true` で確かめる）。
- **注意**: codex の文書の Ubuntu 向けの直し方（`bwrap-userns-restrict` の profile を読み込む）を §6.1 に**重ねない**。同じ `/usr/bin/bwrap` に 2 つの profile が付くとどちらも付かなくなり、他の bwrap 利用まで壊れる（確認: openai/codex issue #38715）。§6.1 の 1 つだけにする。

**ポリシーを shell.md に揃える（同じ関数から作る）**

| shell.md（Claude） | codex の対応（設定の項目は公式のリファレンスで確認。効き方は未確認） |
|---|---|
| §2.1 使える場面（セッション + プロジェクトあり、scheduled・/close・#inbox 系は不可） | codex に PreToolUse の in-process の hook は無い（hooks はコマンドを起こす形）。→ **run ごとに起動の設定で絞る**: #inbox 系のスレッドは常に `features.shell_tool=false`。セッションのスレッドは常に shell あり、run ごとに `sandbox_mode` を切り替える: 使える場面なら `workspace-write`（cwd はそのプロジェクトの dir）、それ以外（プロジェクトなし・/close・自己診断が通らない・容量超え）は `read-only`（ネットなし） |
| §2.2 filesystem（denyRead `~`・/tmp・/run・/var/log・秘密の場所、allowRead workDir・node、allowWrite projects・.cache・.tmp） | `default_permissions` + `permissions.<name>.filesystem`（パスごとに read / write / deny）。**値は shell.md PR 3 の「denyRead・allowRead・allowWrite を作る関数」から作る**。秘密の場所に `SELF_AGENT_CODEX_HOME`（auth.json）を足す（Claude 側の denyRead と自己診断の重なりの確認にも足す）。未確認: 深いパスの指定が浅い deny より優先されるか |
| §2.2 network（GitHub・npm だけ、strictAllowlist） | `features.network_proxy`（**実験的・既定で無効**）+ `network.domains` の allow。未設定なら外へ出られない（確認: リファレンスの記載）。実験的なので、§7 の未決 4 |
| §2.4 子の env（トークンを渡さない・PATH・npm・git の変数） | codex 本体の env は SDK の `env`（渡すと process.env を継がない。確認）で許可方式。**Discord のトークン（全人格）・CLAUDE_CODE_OAUTH_TOKEN は渡さない**。コマンドの env は `shell_environment_policy.inherit=none` + `set` で §2.4 と同じ値（MCP のトークンの変数も入れない） |
| §2.5 引数の拒否（run_in_background・dangerouslyDisableSandbox） | `approval_policy=never`（失敗したコマンドを sandbox の外で再実行しない）。`--dangerously-bypass-approvals-and-sandbox` は使わない（引数をテストで固定） |
| §2.6 時間（1 コマンド 5 分）・常駐プロセスを作らない | `features.unified_exec=false`（**必須**。PTY のバックグラウンドの端末でコマンドをまたいでプロセスが残る作りのため）。1 コマンドの時間の上限の項目は未確認 |
| §2.7 容量（1 プロジェクト 1 GB・空き 512 MB） | hook が無いので **run の前に判定**し、超えていれば `read-only` で動かして、先頭に「容量の上限を超えています…」の注記を付ける。ターンの途中で超えた分は 8 GB のイメージで止まる（Claude より粗い。受け入れる） |
| §2.9 I1（コマンドより長く生きない） | 未確認: codex の bwrap の引数（PID 名前空間・die-with-parent）。**shell.md §7 の必須の 2 項目（`sleep 300 &` が残らない・中断と打ち切りで残らない）を codex でも通すまで有効にしない** |
| §2.9 I2（Bot 側のパスの操作と重ならない） | §5.2 のセッションの枠 1（全エンジン）で満たす。apply_patch が sandbox の外で書くなら Claude の Write と同じ扱い（同じターンの中で順に動き、I1 で sandbox のプロセスは残っていない）。未確認: apply_patch がどこで動くか・パスの判定 |
| §4 fail-closed（自己診断が通らなければ止める） | 自己診断が通らない間は、セッションも `read-only`。codex の同梱の bwrap に戻らないこと（`/usr/bin/bwrap` が消えると同梱に戻り、このホストでは失敗する = 閉じる方向。確認: 今の失敗） |
| §7 shell-check | `scripts/shell-check.ts` に `--engine codex` を足し、同じ項目（秘密のファイル・env・ネット・書き込み・I1）を codex で通す |

**順序（推薦）**: Claude のシェル（PR 3）→ codex のエンジン（シェルなし）→ codex のシェル。理由: §6.1・§6.2 の sudo、自己診断、容量と掃除、セッションの枠 1、denyRead を作る関数がすべて PR 3 までに揃い、codex はそれを使い回せる。先に codex のシェルを作ると、同じ守りを 2 回作ることになる。

### 5.4 1 プロセスの中の秘密
- プロセスの env には全人格の Discord のトークン・CLAUDE_CODE_OAUTH_TOKEN がある（1 プロセスを選んだ代償。v1 の別プロセスより事故の範囲が広い）。
- 誰が何を見るか:

| | Discord のトークン | Claude の OAuth | codex の auth.json | MCP の run ごとのトークン |
|---|---|---|---|---|
| Bot（node） | 全部（各 Client に自分の分だけ渡す。log に出さない） | 持つが使わない（子へ渡すだけ） | 読まない | 作る |
| Claude の CLI（子） | 渡さない（今の許可方式の childEnv） | 渡す | 見えない（Bash は `~` を denyRead。CODEX_HOME を秘密の場所に足す） | — |
| Claude の Bash（sandbox） | 無し | credentials.envVars で消す | 読めない | — |
| codex の CLI（子） | 渡さない | 渡さない | 自分で読み書き（更新を書き戻す） | env で受ける |
| codex のコマンド（sandbox） | 無し | 無し | deny（permissions） | 無し（inherit=none） |

- 受け入れ（shell-check の追加）: Claude の Bash と codex のコマンドの両方で、ダミーの値を入れた `SELF_AGENT_PERSONA_X_DISCORD_TOKEN`・auth.json と同じ場所のダミーのファイルが見えない。

---

## 6. LINE（後回し。塞がないための配慮だけ）
- 人格を Discord に結びつけない: 人格の id は DB で Discord の ID と別の列。チャンネルの持ち主の表（`persona_channels`・`sessions.persona`）は ID の文字列だけを持ち、Discord 固有の形を前提にしない。
- それ以上は作らない（受け口・Funnel・通数の扱いは v1 の §3 を、着手するときに見直す）。

---

## 7. PR 分解・順序・残りの未決

### 7.1 順序
1. **shell.md の PR 3（Claude のシェル）を先に終える**（進行中。キャッシュが外れる唯一の PR。#108 の A と同じ再起動）。
2. 人格の PR は既定の人格のプロンプトとツールを 1 バイトも変えないので、PR 3 と並行して作れる（マージは PR 3 の後が衝突が少ない）。
3. 2 体目が Claude で話せる（PR-A〜C）→ codex のエンジン（PR-D〜F）→ codex のシェル（PR-G）。

### 7.2 PR（1 PR = 1 論点。implementer に渡す粒度）
- **PR-A 人格の設定と DB の移行**（振る舞いは変えない）: config に §1 の変数と検証。DB の移行（`sessions.persona`・`channel_sessions.engine`・`usage_log.persona/engine`・`inbox_summaries.persona`・`memories.created_by`・`kb_entries.created_by`・`persona_channels` を足し、今の inbox/tasks の ID と切り替えの時刻を既定の人格の行に写す）。読み書きは persona_channels に切り替え。`<dataDir>/lock`。人格ごとのシステムプロンプトの組み立て（既定は今と同一のテスト）。
- **PR-B 複数の Gateway と振り分け**: 人格ごとの DiscordGateway（トークンは変数名で渡す）、`gatewayFor(channelId)`・`adminGateway`、access の持ち主の判定、全 Bot の interaction の受付、持ち主の runner でターン、2 体目の接続の失敗の #system の知らせ。
- **PR-C 2 体目のチャンネル**: /setup で #<NAME>、/new の `persona` 引数、2 体目のセッションのチャンネル名の接頭辞と topic、session_open の持ち主、/sessions・/usage の人格の表示、README・REQUIREMENTS・CLAUDE.md。→ ここで 2 体目（Claude）が使える。
- **PR-D ツール定義を SDK 非依存に**（Claude の説明文は 1 文字も変えない。テストで固定）。PR-A と並行可。
- **PR-E 127.0.0.1 の MCP（Streamable HTTP）**: run ごとのトークン、`@modelcontextprotocol/sdk` を固定版で。
- **PR-F codex のエンジン（シェルなし）**: `codex-runner.ts`、固定版の SDK と CLI、`features` の無効化の一覧（shell_tool・multi_agent・plugins・apps・browser_use・computer_use・image_generation・unified_exec ほか。テストで引数を固定）、codex の枠 1、エンジンの違う SDK セッションの破棄、usage の対応、`codex login` の手順。
- **PR-G codex のシェル**（PR 3・§6.1・§6.2 の後）: §5.3 の表のとおり。shell-check の `--engine codex` を通すまで有効にしない（I1 の 2 項目は必須）。

### 7.3 費用
- Discord の 2 体目: 0 円。Claude の枠は既定の人格と共有（2 体目を codex にすれば ChatGPT の枠に分かれる）。
- codex: 0 円（ChatGPT のプランの枠の中。プランの種類と上限の数値は未確認）。依存が 2 つ（codex の SDK と CLI）、MCP の SDK が 1 つ増える。

### 7.4 決定（この案）
1 プロセス・1 DB・1 env、チャンネルの持ち主は 1 人格、管理は既定の Bot、コマンドは既定のアプリだけ、共有と人格ごとの分け方（§3）、既定の人格のプロンプトは不変、キューは 1 本で codex は 1・シェル有効時のセッションは全体で 1、codex のシェルは PR 3 の後で shell-check を通してから。

### 7.5 オーナーが決めたこと（2026-10-13、すべて推薦どおり。順番だけ変更）
1. 2 体目の入口は #<NAME> 1 つだけ
2. 2 体目のセッションのチャンネル名は `<NAME>-<題名>`（既定の人格は今のまま）
3. #<NAME> の日時ヘッダのチャンネル名は `#inbox` と同じ論理名（プロンプトを変えない）
4. codex のシェルのネットは network_proxy の許可リスト（GitHub・npm）で、shell-check を通るときだけ。通らなければネットなし
5. 人格を足したら `SELF_AGENT_MAX_CONCURRENT=3`
6. 2 体目のエンジンは codex（PR-F までは Claude で動かす）
7. 順番: シェルの PR 3 より先に 2 体目（PR-A〜C）を進める（シェルとは並行可）

実装者が決めてよいこと: 文言、DB の列名、`gatewayFor` の形、偽 codex の作り、MCP のポートの選び方。

---

## 出典
- Codex の Sandbox（PATH の最初の bwrap を使い、無ければ同梱に戻る）: https://learn.chatgpt.com/docs/sandboxing
- AppArmor の profile の衝突（同じ /usr/bin/bwrap に 2 つ付くとどちらも付かない、2026-08-15）: https://github.com/openai/codex/issues/38715
- Ubuntu の AppArmor と codex の bwrap の失敗（RTM_NEWADDR）: https://github.com/openai/codex/issues/15057
- Codex の設定リファレンス（sandbox_mode・sandbox_workspace_write・default_permissions・permissions.<name>.filesystem / network.domains・features.network_proxy（実験的）・shell_environment_policy・features.unified_exec・features.shell_tool・multi_agent・developer_instructions・mcp_servers.url / bearer_token_env_var・hooks）: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex SDK（TypeScript）: https://github.com/openai/codex/blob/main/sdk/typescript/README.md （型は npm `@openai/codex-sdk@0.162.1`）、概要: https://learn.chatgpt.com/docs/codex-sdk
- ChatGPT アカウントでの自動化の認証（API キー推奨・1 auth.json = 1 本の流れ）: https://learn.chatgpt.com/docs/auth/ci-cd-auth
- Sign in with ChatGPT のプランの共有（プレビュー。今は採らない）: https://developers.openai.com/siwc/token-sharing-open-source
- Codex の利用枠（5 時間枠・週。第三者）: https://justinmckelvey.com/blog/codex-usage-limits
