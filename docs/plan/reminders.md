# 時刻に知らせる・定期の依頼（リマインド）

> 2026-10-13。issue #99。オーナーの要望「タスク設定とかリマインドを指示したら、指定した時刻（JST）でイベント発火するようにして。定期的なイベントも。毎週とか毎月とか毎朝とか」への実装仕様。
> REQUIREMENTS の R6（リマインダー）と、決定事項「通知: 鳴らすのは朝のサマリー・リマインド・承認待ち・停止の 4 種だけ」のうち、朝のサマリーとリマインドを扱う。

## 推奨の要約
- 発火の種類は 2 つ。notify は決まった文をボタン付きで投稿するだけで LLM は呼ばない（既定）。prompt は「毎朝 8 時に今日のタスクを出して」のような依頼で、エージェントのターンを 1 回起こす。
- データはタスクとは別の `reminders` テーブル（v16）。1 回だけのリマインドは `task_id` でタスクに紐づけられる。繰り返すものは毎回タスクを作らず 1 行を使い回す。
- 繰り返しは自前の小さな形: 毎日・平日・曜日（複数）・毎月 n 日・毎月末日と HH:MM。依存は足さない。SELF_AGENT_TZ で解釈し、次回の時刻を UTC の ISO 文字列で保存する。31 日のように存在しない日は、その月の末日に寄せる。
- タイマーは分の境目にそろえた 1 分ごとの tick。5 分の Scheduler とは別に持ち、永続のタイマーは持たない。止まっていた間に過ぎた分は 1 回だけ出す。繰り返しの溜まった回はまとめ、12 時間より古ければ出さない。
- 投稿先は頼んだチャンネル。無くなっていたら #tasks、それも無ければ #inbox。オーナーだけをメンションして鳴らす（allowedMentions の users にオーナーだけ。@everyone とロールは今のまま鳴らさない）。
- 発火のメッセージのボタン: 1 回だけ → [完了][10 分後][1 時間後]。繰り返し → [済んだ][10 分後][1 時間後][止める]。
- ツールは末尾に 3 つ足す（reminder_set / reminder_list / reminder_cancel）。時刻は、1 回だけなら `at`（"YYYY-MM-DD HH:MM"、ヘッダのタイムゾーン）、繰り返しなら `repeat` + `time` + `on`。結果の `next` をモデルにそのまま復唱させ、日付の計算違いにオーナーが気づけるようにする。
- コマンドは /reminders（一覧・次の回を飛ばす・止める）を 1 つ足す。環境変数は足さない。
- PR は 4 本。キャッシュが外れるのは PR-R4（ツールとシステムプロンプト）の 1 回だけ。

## 0. 目的
- オーナーが「〜時に知らせて」「毎朝〜して」と頼んだら、その時刻にスマホへ通知が届き、通知からその場で片付けられる（完了・あとで・止める）ようにする。
- ADHD の支援として「忘れない」「始められる」を助ける。鳴らしすぎて無視されるのも避ける。
- 守るもの: 利用枠（自動の LLM ターンは上限付き）、プロンプトキャッシュ（ツール集合の変更は 1 回だけ）、通知の規則（@everyone とロールは鳴らさない）。

## 1. コードで確認した事実 / 推測
事実:
- `tasks.due` は日付（YYYY-MM-DD）だけで、時刻の列は無い。tasks には guild_id が無く、タスクのツールは全サーバー共通。
- 定期処理は `scheduler.ts` の 5 分ごとの tick（`TICK_INTERVAL_MS`）だけ。永続のタイマーは持たず、対象は毎回 DB から求めている。
- `convert.ts` の `ALLOWED_MENTIONS` は `{ parse: [], repliedUser: true }`。オーナーの発言への返信（`gateway.send` の replyToId）では今もオーナーに通知が届く。`sendMessage`（ボタン付き）の投稿や返信先の無い投稿は鳴らない。
- `queue.ts`: セッション以外のジョブは全枠を使える。#inbox・#tasks の 1 ターンは 8 手順・`SELF_AGENT_TURN_TIMEOUT_SEC`（sdk-runner.ts）。
- `turn.ts` の `runChannelTurn` は、resume・記憶と seed の付与・resume 失敗からの復旧まで行う。アプリが起こすターンも、この関数を通せば発言と同じ扱いになる（inbox-rotate.ts は要約専用なので使っていない）。
- `shutdown.ts` は `scheduler.stop()`/`idle()` とキューの `idle()` を待つ。
- 古いボタンの文言は 2 通り。delete.ts の `STALE_TEXT`「この確認は古くなっています」（メッセージを書き換える）と、turn-controls.ts の `STALE_TURN_REPLY`「この操作は古くなっています」（本人にだけ返す）。
- `time.ts` の `offsetMs` は非公開で、inbox-rotate.ts の `localMinutes` も非公開。タイムゾーンの壁時計から UTC に直す公開の関数は無い。
- テストの整合チェック: query-options.test.ts は SYSTEM_PROMPT に出てくるツール名・コマンド名がすべて実在するかを、interactions.test.ts は HELP_TEXT が登録したコマンドを全部説明しているかを確かめる。
- REQUIREMENTS の未決に「タスクの時刻・優先度（P4 のリマインダー・朝のサマリーと一緒に決める）」がある。

推測・未確認:
- ツール 3 つの定義は合わせて 600〜900 トークン程度。`npm run measure` で実測し、PR-R4 に書く。
- prompt の 1 回は、オーナーの発言 1 回とほぼ同じ量を消費する（入力の大半はキャッシュの読み）。ただし毎朝の #inbox・#tasks の切り替え（04:00）の直後なら、その日の最初のターンになりキャッシュを作り直す。
- Discord のサーバー通知を「@mentions のみ」にしていても、ユーザーへのメンションでスマホに通知が届く（Discord の通常の挙動。手動で確かめる）。

## 2. 決定事項と理由

### 2.1 発火したときにすること → 種類で分ける
| 観点 | (a) 投稿だけ | (b) 毎回ターン | (c) 種類で分ける |
|---|---|---|---|
| 利用枠 | ◎ 0 | △ 発火ごとに 1 ターン | ○ prompt だけ（上限 5 件） |
| キャッシュ | ◎ 影響なし | ○ 履歴に追記するだけ | ○ 同左 |
| #inbox の会話への影響 | ◎ なし | △ 毎回履歴が増える | ○ prompt だけ増える |
| 「毎朝のブリーフィング」 | ✗ 固定の文しか出せない | ◎ | ◎ |
| 実装量 | ◎ | ○ | ○（(a)+(b)。ターンは runChannelTurn を流用する） |

- 「薬を飲む」「ゴミ出し」のようなリマインドは決まった文で足りる。LLM を通すと遅くなり、利用枠を使い、言い回しも揺れる。
- 「毎朝」は今日のタスクの提示（ブリーフィング）を想定している可能性が高い。期限切れ・今日の分から「何からやるか 1 つ」を選ぶのは LLM の仕事（システムプロンプトに既にある規則）。
- 既定は notify。モデルが prompt を選ぶのは、時刻に「調べる・まとめる・一覧を出す」ことを頼まれたときだけ。
- prompt は、頼まれたチャンネルが #inbox か #tasks のときだけ作れる。セッションのチャンネルでは not_available（自動のターンで待ちのセッションが進行中に戻る・途中経過が出る、といった扱いを決める必要があり、今回は範囲外）。
- prompt は頼まれたチャンネル（#inbox か #tasks）の会話で動かす。#tasks は「タスク以外の話題は答えない」ので、#tasks に一律で寄せない。

### 2.2 データモデル → 別テーブル `reminders`
| 観点 | A. tasks に時刻と繰り返しを足す | B. 別テーブル（task_id で任意に紐づけ） |
|---|---|---|
| タスクでないリマインド（「8 時に薬」） | △ タスクとして一覧に混ざる | ◎ |
| 1 つのタスクに知らせを付ける | ○ | ○（task_id） |
| 既存の task_* ツール定義 | ✗ 変わる | ◎ 変わらない |
| 実装量 | ○ | ○ |

- 1 回だけのリマインドは `task_id` を持てる。[完了] でタスクも完了にする。紐づけたタスクが既に done・dropped なら、発火時に投稿せずに done にする（tasks 側の変更で reminders を触らない。発火時にだけ確かめる）。
- 繰り返しはタスクと紐づけない。「毎週のゴミ出し」は繰り返しのリマインドで表し、[済んだ] はその回の確認にとどめる。回ごとにタスクを作る方式は /tasks の一覧が埋まるので採らない。
- タスクの期限（due）から自動でリマインドは作らない（鳴らしすぎになる）。期限の確認は毎朝の prompt に任せる。

### 2.3 繰り返しの表現 → 自前の小さな形
- RRULE は採らない。依存が増えるか自前のパーサが大きくなるうえ、使わない表現まで持つことになる。
- 表せるもの（時刻は HH:MM、すべて SELF_AGENT_TZ で解釈）: `daily`（毎日）、`weekdays`（月〜金。祝日は考えない）、`weekly`（曜日を 1〜7 個）、`monthly`（1〜31 日か末日 `last`）。
- 存在しない日（2 月 30 日・4 月 31 日）は、その月の末日に寄せる。
- 毎年・隔週・n 時間ごとは入れない。どの形も最短の間隔は 1 日。
- DB には正規化した 1 本の文字列（`rule`）で保存する。1 回だけのものは NULL。

  | rule | 意味 |
  |---|---|
  | `daily@08:00` | 毎日 8:00 |
  | `weekdays@08:00` | 平日 8:00 |
  | `weekly:mon,wed,fri@08:00` | 毎週 月・水・金 8:00（曜日は mon..sun の順に並べ、重複を除く） |
  | `monthly:15@09:00` | 毎月 15 日 9:00 |
  | `monthly:last@09:00` | 毎月 末日 9:00 |

- 次回の計算: `nextOccurrence(rule, after, timeZone)` は、`after` より厳密に後の最初の回を返す純関数。after の SELF_AGENT_TZ の日付から 1 日ずつ進め（上限 400 日）、合う日の HH:MM を UTC に直す。夏時間の飛ぶ時刻は飛んだ後の同じ壁時計の時刻（ずれの差だけ後ろ）、重なる時刻は早い方。
- 時刻の文字列はすべて「SELF_AGENT_TZ の壁時計」。保存する `next_at`・`snooze_at` は UTC の ISO 文字列。

### 2.4 タイマー → 分の境目にそろえた 1 分ごとの tick
| 観点 | 次の 1 件に setTimeout を張り直す | 1 分ごとの tick（分の境目にそろえる） |
|---|---|---|
| 精度 | ◎ | ○（時刻は分単位なので、境目にそろえれば 1 秒以内） |
| 24.8 日の上限・時計のずれ | △ 上限で区切って張り直しが要る | ◎ 毎分 DB を見る |
| 追加・変更・スヌーズへの追従 | △ 変更のたびに張り直す | ◎ 何もしない |
| コスト | ◎ | ◎ 1 分に 1 回の SELECT（索引あり） |

- `ReminderScheduler`（src/app/reminders.ts）を 5 分の Scheduler とは別に置く。起動直後に 1 回 tick し、以後は「次の分の境目 + 200ms」に `after` を張り直す。毎回 now から求めるので、ずれは溜まらない。tick は重ねない（実行中なら飛ばす）。
- 止まっていた間に過ぎた分:
  - 1 回だけ: 必ず 1 回出す。予定から 5 分以上遅れていれば「（9:00 の予定・25 分遅れ）」を添える。1 日以上なら日付を入れる（「（10/13(火) 9:00 の予定でした）」）。
  - 繰り返し: 過ぎた回のうち最後の 1 回だけを出し、2 回以上過ぎていれば「（ほか n 回分は止まっていた間に過ぎました）」を添える。最後の回が 12 時間より古ければ出さずに次の回へ進め、log にだけ残す。
- 二重発火の防止と再試行:
  - notify は「投稿してから進める」（少なくとも 1 回届く）。投稿が成功したら `fire_seq` を比べて書き換える（compare-and-set）。失敗したら DB を変えず、次の tick でやり直す。同じ回で 30 回（約 30 分）失敗したらその回は諦めて進め、log に残す（回数はプロセス内で覚える）。投稿と DB 更新の間でプロセスが落ちたときだけ、再起動後に同じ回が 2 回出る（害が小さいので許す）。
  - prompt は「進めてから動かす」（多くても 1 回）。先に DB を進めてから、ターンを発言と同じキューに入れる。失敗してもやり直さない（利用枠を使うため）。失敗したら「予約した依頼（#id）を実行できませんでした」をメンション付きで投稿する。
  - 同じ tick の中では、実行中の id を Set で覚えて重ねない。
- 停止処理（shutdown.ts）: `ReminderScheduler` に `stop()`/`idle()` を持たせ、Scheduler と同じ時点で止める。idle は実行中の notify の投稿を待つ。止めた後はまだ始めていない発火を行わない（次の起動の最初の tick で拾う）。prompt のターンは turnQueue の待ち合わせで待ち、猶予を超えたらその回は失われる（進めた後なので出し直さない）。

### 2.5 投稿先と通知
- 投稿先は頼んだチャンネル（ツールの context.channelId）。#inbox・#tasks・セッションのどれでもよい（prompt は §2.1 のとおり #inbox・#tasks だけ）。セッションが完了や待ちでもそのチャンネルに出し、状態は変えない。
- そのチャンネルが無いときは、そのサーバーの #tasks、無ければ #inbox に出す。「無い」の判定はセッションが削除済み、または投稿に失敗した後の `gateway.channelExists` が false。本文に「（元のチャンネルが無いため、ここに出しました）」を添え、`channel_id` を書き換える（以後もそこに出す）。どちらも無ければその回は諦めて log に残す（guild の ID だけ）。
- 通知はオーナーだけをメンションして鳴らす。本文の先頭に `<@オーナーID>` を付け、allowedMentions を `{ parse: [], users: [ownerId], repliedUser: true }` にする。`parse: []` は今のままなので、本文に `@everyone` やロールが入っていても鳴らない。README に「Reminders mention only the owner」を足す。

### 2.6 発火時のボタン
- 1 回だけ: [完了]（success）[10 分後][1 時間後]。繰り返し: [済んだ]（success）[10 分後][1 時間後][止める]（danger）。
- 「この回を飛ばす」は発火時には既に過ぎた回なので出さない。「次の回を飛ばす」は /reminders と reminder_cancel の `skip_next` で行う。
- 押した後はメッセージを書き換えてボタンを外す。書き換えた本文は DB から作り直し、メンションは付けない（編集では鳴らない）。
  - [完了]・[済んだ] → `→ 完了にしました`（紐づけたタスクがあれば `（#12 も完了にしました）`）
  - [10 分後] → `→ 10 分後（9:35）にもう一度知らせます`
  - [止める] → `→ 止めました`
- 新しい回を投稿したら、前の回のメッセージ（`last_message_id`）のボタンを外す。失敗は log だけ。
- 古いボタン（行が無い・`fire_seq` が違う・状態がその操作に合わない）は、本人にだけ「この操作は古くなっています」と返し、メッセージは変えない（turn-controls と同じ扱い。本文を消さないため STALE_TEXT への書き換えはしない）。

### 2.7 ツール → 新しく 3 つ
| 観点 | task_add / task_update に引数を足す | 新しく 3 つ |
|---|---|---|
| タスクでないリマインド | ✗ 表せない | ◎ |
| ツール定義の変更 | 既存 2 つが変わる | 3 つ増える（どちらもキャッシュは 1 回外れる） |
| モデルの迷い | △ 「タスクにする？」と迷う | ○ 名前で分かる |

- 時刻はモデルに「SELF_AGENT_TZ の壁時計」で渡させる。UTC やオフセット付きの ISO はモデルの計算違いが増えるので、アプリが変換する。「30 分後」「明日 9 時」はヘッダの日時を基準にモデルが計算し、結果の `next`（曜日付き）を必ず復唱させる。

### 2.8 コマンドと一覧
- `/reminders` を足す。一覧の表示と、選んで「次の回を飛ばす」「止める」を行う（§6）。
- /tasks の一覧の行で、紐づけたまだ先のリマインドがあれば「（知らせ 10/14(水) 9:00）」を足す。task_list の要素にも `remind`（"YYYY-MM-DD HH:MM"）を足す（結果の形が変わるだけで、ツール定義は変わらない）。
- ホームパネルは変えない。

## 3. DB（user_version 16）
```sql
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('notify', 'prompt')),
  text TEXT NOT NULL,
  task_id INTEGER,
  rule TEXT,
  next_at TEXT,
  snooze_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'fired', 'done', 'cancelled')),
  fire_seq INTEGER NOT NULL DEFAULT 0,
  last_fired_at TEXT,
  last_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX reminders_active ON reminders (status, next_at);
```
- 列: `rule` は §2.3 の形（NULL は 1 回だけ）。`next_at` は規則による次の回（1 回だけなら指定時刻。もう無ければ NULL）。`snooze_at` はスヌーズで決めた、もう一度知らせる時刻。`fire_seq` は投稿のたびに 1 増やす（スヌーズで出し直したときも）。
- 状態: `active`（これから知らせる。next_at か snooze_at のどちらかがある）、`fired`（1 回だけのものを知らせた後で、まだボタンが押されていない）、`done`（完了。1 回だけで [完了]、紐づけたタスクが閉じていた）、`cancelled`（止めた）。
- 発火の対象: `status = 'active' AND ((next_at IS NOT NULL AND next_at <= now) OR (snooze_at IS NOT NULL AND snooze_at <= now))`。早い順に、1 tick で最大 20 件。
- 規則による回を出したら snooze_at も消す（新しい回が前のスヌーズより優先する）。
- 物理削除はしない。
- ストア（src/store/reminders.ts。SDK・Discord に依存しない）: `add`、`get`、`listActive(limit)`（next_at と snooze_at の早い方の順）、`listDue(now, limit)`、`countActive({ kind? })`、`findDuplicate(channelId, text, rule, nextAt)`、`markFired(id, expectedSeq, { nextAt, status, messageId, firedAt })`（active で fire_seq が expectedSeq のときだけ書き換え、成否を返す。投稿の間に止められたら false）、`claim(id, expectedSeq, { nextAt, status, firedAt })`（prompt 用。先に進める。条件は markFired と同じ）、`snooze(id, at, expectedSeq?)`、`complete(id, expectedSeq?)`（1 回だけのもの）、`clearSnooze(id, expectedSeq?)`（繰り返しの [済んだ]。snooze_at を消すだけ）、`cancel(id, expectedSeq?)`（expectedSeq を渡せば fire_seq が一致するときだけ。ボタンの古さの判定に使う）、`skipNext(id, nextAt)`、`moveChannel(id, channelId)`、`nextForTasks(taskIds)`（/tasks と task_list 用）。

## 4. ツールの定義（PR-R4。MCP の末尾にこの順で足す）
並びは `…, project_open, project_files, reminder_set, reminder_list, reminder_cancel`。

### reminder_set
入力（形式の確かめは既存と同じく z.string() で受けてハンドラで行う）:
- `text`: string 1〜500。notify はそのまま投稿する文、prompt はそのときの自分への依頼。
- `kind?`: `"notify" | "prompt"`。既定は notify。
- `at?`: `"YYYY-MM-DD HH:MM"`（1 回だけ。SELF_AGENT_TZ）。
- `repeat?`: `"daily" | "weekdays" | "weekly" | "monthly"`。
- `time?`: `"HH:MM"`（repeat のとき必須）。
- `on?`: weekly は `"mon,wed"`、monthly は `"1"`〜`"31"` か `"last"`。
- `task_id?`: number（1 回だけのときだけ）。

結果（JSON。日時はすべて SELF_AGENT_TZ）:
- `{ result: "created", id, kind, text, next: "2026-10-14(水) 09:00", repeat: "毎週 月・水 8:00" | null, task: { id, title } | null }`
- `{ result: "exists", id, next, repeat }`: 同じチャンネル・text・rule（1 回だけなら同じ時刻）の active がある。作らない。
- `{ result: "invalid_args", message }`: at と repeat が両方ある・どちらも無い、repeat に time が無い、weekly・monthly に on が無い・形が違う、repeat に task_id。
- `{ result: "invalid_time", message }`: at・time の形が違う、存在しない日付（2026-02-30）。
- `{ result: "in_past", now: "…" }`: at が今より 5 分以上前。5 分以内なら作って、次の tick ですぐ知らせる。
- `{ result: "task_not_found" }`、`{ result: "task_closed" }`
- `{ result: "limit", message }`: active が 50 件。prompt の active は 5 件まで。
- `{ result: "not_available", message }`: context が無い、予約した依頼のターンの中、セッションのチャンネルで prompt を頼んだ。

説明文（案。可変値は入れない）:「オーナーが時刻に知らせてほしい・毎日/毎週/毎月〜してほしいと頼んだときに使う。このチャンネルに、その時刻にオーナーをメンションして投稿する。1 回だけなら at（ヘッダと同じタイムゾーンの YYYY-MM-DD HH:MM。「30 分後」「明日 9 時」はヘッダの日時から計算する）、繰り返しなら repeat・time・on を渡す。kind は、知らせるだけなら notify（既定）、その時刻に調べる・まとめる・一覧を出すなど自分が動くなら prompt にし、text にそのときの自分への依頼を書く（prompt は #inbox・#tasks だけ）。既にあるタスクについて知らせるなら task_id を付ける。結果の next と repeat をそのまま 1 行で伝える。」

### reminder_list
- 入力: `{}`。
- 結果: `{ reminders: [{ id, kind, text, next, repeat, task_id, channel: "<#…>" }] }`。active を次の時刻の順に最大 50 件。
- 説明文:「登録済みのリマインドと予約した依頼を、次に知らせる順に返す。一覧を聞かれたとき、止める・飛ばす id を確かめるときに使う。」

### reminder_cancel
- 入力: `{ id: number, skip_next?: boolean }`
- 結果: `{ result: "cancelled", id, text }`、`{ result: "skipped", id, next }`（飛ばした後の新しい次の回）、`{ result: "not_found" }`、`{ result: "not_active" }`、`{ result: "not_repeating" }`（1 回だけのものに skip_next）。
- 説明文:「リマインドを止める。skip_next を付けると、繰り返しの次の 1 回だけを飛ばす。止めて・もういらない・今度は休みと言われたときに使う。」

### 共通
- `RunContext` に `scheduled?: true` を足す。予約した依頼のターンで立てる。そのターンでは reminder_set と session_open が `not_available` を返す（自動のターンから予約やチャンネルが増えるのを止める）。
- log は「reminder_set: created（#id、notify|prompt）」の形にとどめる。text・時刻・チャンネル ID は出さない。

## 5. 発火の流れ（src/app/reminders.ts）
tick(now):
1. 停止を始めていたら何もしない。`listDue(now, 20)` を取り、1 件ずつ順に処理する。
2. 紐づけたタスクが open でなければ、投稿せずに `complete` する。log は「紐づけたタスクが閉じているため知らせませんでした（#id）」。
3. 回の時刻を求める。snooze_at が due ならそれを回にする。next_at が due なら規則で過ぎた最後の回とその回数を数える（400 回まで）。繰り返しで最後の回が 12 時間より前なら、next_at を `nextOccurrence(rule, now)` へ進めて終わる（log「止まっていた間に過ぎたため飛ばしました（#id、n 回）」）。
4. 投稿先を決める（§2.5 の fallback）。
5. notify: 本文は 1 行目 `リマインド: <text>`、紐づけたタスクがあれば `（#12 <題名>）`、繰り返しなら `（毎週 月・水 8:00）`、スヌーズの回なら `（もう一度）`、遅れ・まとめの注記（§2.4）。メンション付きで sendMessage し、成功したら `markFired`（1 回だけ: next_at・snooze_at を NULL、status を fired。繰り返し: next_at を `nextOccurrence(rule, now)`、snooze_at を NULL。どちらも fire_seq +1、last_message_id を保存）。markFired が false（投稿の間に止められた）なら、いま投稿したメッセージのボタンを外す。その後、前の last_message_id のボタンを外す。12 時間より古い繰り返しの回を出さずに進めるときは skipNext、30 回失敗した 1 回だけのものは complete を使う。
6. prompt: 先に `claim` で進める（fire_seq +1、1 回だけなら status は done）。`turnQueue.run(channelId, job)` に入れて tick では待たない（走っているターンは Set で覚え、idle で待つ）。job はチャンネルを決め直し（resolveChannel が inbox・tasks を返すものだけ。それ以外は fallback）、`runChannelTurn` に kind（そのチャンネルの種類）、prompt（`buildTurnPrompt("予約した依頼（#<id>・<繰り返しの表示 か 1 回だけ>）:\n<text>", 今, tz, "inbox"|"tasks")`）、allowedUrls `[]`、context `scheduled: true` を渡す。typing を出す。成功したら返答を `send(channelId, text + "\n（予約した依頼 #<id>）", undefined, ownerId)` で送る（分割した最初の塊にだけメンション）。失敗したら「予約した依頼（#id）を実行できませんでした」（手順の上限なら MAX_TURNS_REPLY）をメンション付きで送る。途中経過・[中断]・[続ける] は付けない。
7. log: 「リマインドを知らせました（#id、guild=…、遅れ n 分）」「予約した依頼のターンを始めました（#id、guild=…）」、投稿の失敗は describeError。text・チャンネル ID・ユーザー ID は出さない（reminders の id は出してよい）。

Discord 側の変更（PR-R2）:
- `OutgoingMessage` に `mentionUserId?: string` を足す。`toPayload` はあれば content の先頭に `<@id> ` を付け、allowedMentions を `{ parse: [], users: [id], repliedUser: true }` にする。
- `Gateway.send` に第 4 引数 `mentionUserId?: string` を足す。最初の塊にだけ付ける。既存の呼び出しは変えない。
- 2000 字の上限は、メンションの分を差し引いて app 側で守る。

## 6. ボタンとコマンドの custom_id（名前空間 `rem:`）
| custom_id | どこに | 動作 |
|---|---|---|
| `rem:done:<id>:<seq>` | 発火のメッセージ | 1 回だけ: done にし、紐づけたタスクを complete する。繰り返し: snooze_at を消すだけ。書き換えてボタンを外す |
| `rem:snooze:<10\|60>:<id>:<seq>` | 発火のメッセージ | snooze_at = 押した時刻 + n 分。1 回だけなら status を active に戻す。書き換えてボタンを外す |
| `rem:stop:<id>:<seq>` | 繰り返しの発火のメッセージ | cancelled にする。書き換えてボタンを外す |
| `rem:pick` | /reminders のセレクト | 選んだものの詳細を本人にだけ出す。[次の回を飛ばす]（繰り返しだけ）と [止める] を付ける |
| `rem:skip:<id>` | /reminders の詳細 | 次の回を飛ばし、「次の回（10/14(水)）を飛ばしました。次は 10/16(金) 8:00」に書き換える |
| `rem:cancel:<id>` | /reminders の詳細 | 「止めました: <text>」に書き換える |

- 発火のメッセージのボタンは `<seq>` が今の fire_seq と一致し、状態が合うときだけ動く（done・snooze は fired・active のとき、stop は active のとき）。合わなければ本人にだけ「この操作は古くなっています」。
- /reminders 由来のボタン（skip・cancel）は、active でなければ STALE_TEXT に書き換える（/projects と同じ）。
- DB の状態で判定するので、再起動の後でも押せる。

/reminders（src/app/commands/reminders.ts）:
- 説明は「リマインドと予約した依頼の一覧を表示します（選んで止められます）」。
- 本人にだけ、active を次の時刻の順に表示する。1 行は `#3 毎朝 8:00 今日のタスクを出す（依頼・<#ch>）次 10/14(水) 8:00`。1 回だけなら繰り返しの部分は `10/14(水) 9:00`。
- 2000 字を超えたら `fitItems` で「ほか n 件」にする。0 件なら「リマインドはありません」。
- セレクトは最大 25 件。全サーバー分を出す（/projects と同じ）。
- /help に 1 行足す:「`/reminders` リマインドと予約した依頼を一覧にします。選んで止めたり、次の回を飛ばしたりできます」。

## 7. システムプロンプト（PR-R4 でまとめて変える）
「やること:」の task_update の行の直後に足す:
- 「時刻に知らせてほしい、毎朝・毎週・毎月〜してほしいと言われたら reminder_set を使い、結果の next と repeat を 1 行で伝える。時刻が分からなければ確かめる。知らせるために task_add はしない。既にあるタスクについてなら task_id を付ける。」
- 「止めて・今度は休みと言われたら reminder_list で id を確かめ、reminder_cancel を使う。」

引き継ぎの文の段落（「オーナーについての記憶…」の後）に足す:
- 「発言の先頭が「予約した依頼（#番号…）:」なら、オーナーが前に頼んだ依頼をアプリがその時刻に送ったものです。オーナーはその場にいない前提で、質問で終えずに 1 回の返事で完結させてください。」

「このアプリについて」の「コマンド:」に `/reminders（リマインドの一覧と止める）` を足す。/help の文と揃える。

既存の行との関係: #tasks の「タスクの話だけ」とは衝突しない。#tasks で調べものの予約を頼まれたら、今の規則どおり #inbox へ案内する。

## 8. 環境変数
- 足さない。12 時間・5 分・30 回・件数の上限はコードの定数にする（`REMINDER_*` として export し、テストで参照する）。
- `SELF_AGENT_TZ` をそのまま使う。

## 9. テスト（時計とタイマーは注入する）
`ReminderScheduler` には `now: () => Date` と `timers.after(fn, ms)` を注入する。偽 Gateway・一時 SQLite・偽 Runner で書く。

- recurrence（純関数。表で書く）: daily（当日のまだ先・過ぎた時刻・ちょうど同じ時刻は翌日）、weekdays（金曜の夜 → 月曜）、weekly（複数の曜日・同じ日の後の時刻）、monthly（15 日、31 日 → 2 月 28 日・閏年の 29 日・4 月 30 日、last、年またぎ）、Asia/Tokyo と America/New_York（夏時間の飛ぶ・重なる時刻）、rule の正規化と壊れた形の拒否。
- ツール（PR-R4）: at・repeat の組み合わせごとの結果、in_past の境目、exists、task_not_found・task_closed、limit（50・prompt 5）、セッションでの prompt は not_available、`scheduled` のターンでは reminder_set・session_open が not_available、結果の next は曜日付き、ツール名の並び、SYSTEM_PROMPT の名前の整合。
- 発火（PR-R2・R3）: 分の境目 + 200ms に次の tick、notify はメンション付きで 1 回出て fire_seq が 1 増える（同じ tick を 2 回呼んでも 2 回目は出ない）、投稿に失敗したら DB は変わらず次の tick で出る、30 回失敗で進めて log、チャンネルが無ければ #tasks → #inbox → log だけ、止まっていた後（1 回だけ → 遅れの注記付きで 1 回、繰り返しで 3 回過ぎた → 1 回だけ出て「ほか 2 回分」、12 時間より古い → 出ずに次へ）、紐づけたタスクが done なら出ずに done、新しい回で前のメッセージのボタンが外れる、stop の後は発火しない、idle は実行中の投稿を待つ。prompt（PR-R3）: 先に進めてからターンが turnQueue の同じ key で走る、prompt の先頭とヘッダ、context の `scheduled`、allowedUrls は空、返答はメンション付き、失敗しても 2 回目は走らず失敗の知らせが出る、usage が記録される。
- Discord の変換: `mentionUserId` で content の先頭と `allowedMentions.users` が付き `parse` は空のまま。付けなければ今と同じ payload。
- ボタンと /reminders: done・snooze・stop の状態遷移と書き換え、seq が違う・cancelled・行が無いなら本人にだけ「この操作は古くなっています」、skip と cancel、HELP_TEXT の網羅。
- 手動（スマホ）: 「10 分後に洗濯物って知らせて」→ 10 分後に通知 → [完了]。「毎朝 8 時に今日のタスクを出して」→ 翌朝 8 時に #inbox に一覧と「1 つ」が届く。/reminders で止められる。

## 10. 実装を分ける単位（各 PR は単独でマージできる）
- PR-R1「reminders のストアと繰り返しの計算」: db.ts の v16、src/store/reminders.ts、src/app/recurrence.ts（parseRule・formatRule・describeRule（日本語）・nextOccurrence・壁時計から UTC への変換）、time.ts の変換関数の公開、単体テスト。動作は変わらない。
- PR-R2「リマインドの発火（notify）・メンション・ボタン・/reminders」（R1 の上）: ReminderScheduler（notify だけ。prompt の行は R3 まで「未対応」と log に出して cancelled にする）、convert.ts・gateway の mentionUserId、`rem:` のボタン、/reminders・/help、main.ts の配線と shutdown.ts の stop・idle、README の安全規則の 1 行。作る経路はまだ無い（テストは行を直接入れる）。キャッシュには影響しない。
- PR-R3「予約した依頼（prompt）のターン」（R2 の上）: RunContext の `scheduled`、runChannelTurn を使った prompt の実行・返信・失敗の知らせ、session_open の not_available の判定。ツール定義は変わらない。
- PR-R4「リマインドのツールとシステムプロンプト」（R3 の上）: ツール 3 つ、task_list の `remind`、/tasks の「（知らせ …）」、§7 の行、CLAUDE.md、REQUIREMENTS（R6 を済に。未決の「タスクの時刻」をリマインドで代えると決定事項へ。優先度は未決のまま）、PR 本文に `npm run measure` の増分。キャッシュが外れるのはこの PR だけ。

## 11. 決めた既定値（オーナーの確認を待たずに推奨で進めた。変えるときはここを直す）
1. 投稿先: 頼んだチャンネル（すべて #tasks に集める案は採らない）。
2. 予約した依頼（prompt）: 入れる（active は 5 件まで）。毎朝のブリーフィングは最初から作らない（一度頼めば作られる）。
3. 止まっていた間に過ぎた繰り返し: 12 時間以内なら最後の 1 回を出し、それより古ければ出さない。
4. スヌーズの選択肢: 10 分・1 時間。「明日の朝」は入れない（朝の時刻の設定が別に要る）。
5. 繰り返しの種類: 毎日・平日・曜日・毎月 n 日・末日。毎年・隔週は入れない（足すとツール定義が変わり、キャッシュがもう 1 回外れる）。
6. 存在しない日（31 日など）: その月の末日に寄せる。
7. 押されなかった 1 回だけのリマインドを、もう一度知らせるか: しない（無視が多ければ「1 時間後にもう 1 回」を足す）。
8. メンション: すべての発火で鳴らす（予約した依頼の返事も含む）。

## 12. やらないこと（今回）
- セッションのチャンネルでの予約した依頼。
- 回ごとにタスクを作る繰り返しのタスク。
- タスクの期限から自動で作るリマインド。
- 予約した依頼のターンでの WebFetch（オーナーが貼った URL の規則を崩さないため。WebSearch は使える）。
- Google カレンダー連携（R7）。
