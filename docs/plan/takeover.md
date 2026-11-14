# 取り込み（端末の Claude Code の会話を self-agent のセッションが引き継ぐ）設計（#341）

v2（2026-11-13。レビュー反映。指摘ごとの扱いは §9）。前提: `docs/plan/unify.md`（U1・U3）、`claude-code-sessions.md`、`claude-code-channels.md`（CC13）。

## 0. 目的と結論

**何のために**: 端末（tmux）で進めていた Claude Code の会話を、席を離れた後もスマートフォンの Discord・Web から「同じ会話の続き」として進めたい。今のリモコン（CC1〜CC14）はペインに貼り付けるので画面の状態に左右される。取り込みは、会話の記録を self-agent のプロジェクトのセッション（U1）が SDK の `resume` で引き継ぎ、以後は普通のセッションとして動かす。リモコンは残す。

**結論**
- **今ある `cc-<名前>` のチャンネルをその場でプロジェクトのセッションに変える**（Web の履歴が続く）。無ければ先に作る。
- 端末の claude は **SIGTERM** で終わらせる。生きているセッションは tmux の中・待機中だけ。終わったセッションも同じ手順で取り込め、やり直しの口を兼ねる。
- 記録は Bot の `CLAUDE_CONFIG_DIR` へ **コピー**する（session_id は同じ。端末側とはそこで分岐）。
- 取り込んだ会話には **PROJECT_APPEND が入らない**（probe）。最初のターンの発言の前に 1 回だけ「前置き」を付ける。許可のモードは U2 まで常に default。
- 入口は `/cc take`（確認のボタン付き）から。SDK のツールは作らない。DB は表 1 つ。環境変数は足さない。逆向き（端末へ戻す）は U3。

決まっている前提（#341。再検討しない）: `/clear` は貼らずプロセスを終わらせる / 待機中だけ / `SELF_AGENT_WORKSPACE_DIR` の直下のプロジェクトだけ。

## 1. 確認した事実

### 1.1 確認（コード。main 85e173f）

1. セッションの終了は **`claude agents --json` の一覧から消えたこと**だけで決める（`cc/registry.ts`）。消えると `ccEndedHandler`（`cc/channels.ts`）→ `channels.ended`（すでに ended の行にも終了の文を出す）と `replier.ended`。hook は証拠にしない。
2. registry は消えたセッションの **gone_at を DB に書いてから** ended を知らせる。`tick()` は結果を返さない。読めなければ前回の一覧を保ち（`snapshot().stale`）、5 回続くと空にする（`unreadable`。gone にはしない）。読めた時刻は `fetchedAt`。
3. `cc_channels` の行が deleted でない間、そのチャンネルの発言はリモコンが取る。判定はどこも `state !== "deleted"`。一意索引は `(session_id) WHERE state <> 'deleted'`。`cc_channels.name` は `cc-` 付きのチャンネル名。
4. Web の履歴は `channel_id` で引く。`/api/channels` の kind は、deleted でない cc の行があれば `cc`、無ければ `sessions` から。
5. プロジェクトのセッション（`agent/project-profile.ts`）: preset + `PROJECT_APPEND` + `snapshot: true`、`AskUserQuestion` を外す、許可は canUseTool → `cc_permissions`（origin sdk）。モデルは `cfg.model`、モードは `sessions.permission_mode`（/new は default 固定。変える口 /mode は U2）。自動メモリは切ってあり、guard は `~/.claude` を拒む。
6. runner の cwd は `cc/starter.ts` の `projectDir()` = `join(realpath(作業場所), 名前)`（プロジェクトのディレクトリが symlink なら通さない）。`resumeProject()` は cwd の親が作業場所（realpath の前後どちらでも）なら名前を返す。
7. 記録: 端末は `~/.claude/projects/<cwd の英数字以外を - に>/<session_id>.jsonl`（`projectDirName`）、Bot は `<cfg.claudeConfigDir>/projects/<同じ名前>/`。隣に `<session_id>/`（subagents など）と `memory/` があることがある。最大は 110 MB。mtime は会話が無くても進む（#310）。
8. `app/turn.ts`: resume の経路で、画像の拒否・`No conversation found`・失敗が 3 回続いた、のどれかになると、**1 箇所で SDK セッションを黙って捨て**、seed を付けて新しい会話でやり直す。seed を扱うのは新規の経路だけで、resume の成功はその手前で戻る。/close の要約はここを通る（`purpose: "close"`）。/renew は通らない（`app/session-renew.ts` が自分で捨てる）。
9. `usage_log` はステップごとの usage の合計。`modelUsage` を読むのは `cli/measure.ts` だけ。
10. tmux の包みに kill は無い。pid からペインを引く関数は `cc/panes.ts`（祖先は 8 段まで）、`probePaneState` は `tmux/pane-state.ts`（gone / not_claude / copy_mode / owner_active / dialog / busy / no_prompt / draft / idle）。
11. `ClaudeDirs.sessionFile(pid, sessionId)` は `sessions/<pid>.json` を読む（sessionId が違えば undefined）。
12. `CcSender.submit`・`propose` は送り先の確かめ（await）の後、await しない区間で積む。
13. `SdkSessionStore`（`channel_sessions`）は key からしか引けない。DB の接続は 1 本。`markGone`・`upsertSeen` は内側に BEGIN を持つ。
14. CC13 の [起動して続ける] は**新しい** claude を起動する（`--resume` は無い）。保留した発言はメモリの中（`<channelId>:<messageId>`）。
15. マイグレーションは配列の位置で番号が決まる（main の最後は v41）。`sessions.origin` は CHECK があり、値を足すには表の作り直しが要る。
16. Gateway にチャンネル名の変更は無い（topic と移動はある）。`findStateCategory` はカテゴリを作ることがあり、/new は `layoutQueueKey` のキューの中で呼ぶ。
17. SDK 0.3.286（同梱 CLI 2.1.286）。端末の CLI は先に進む。

確認（実機。2026-11-13。生きている 27 セッション）: `/proc/<pid>/stat` の comm は全部 `claude`。一覧の `startedAt` はプロセスの開始より 1.2〜15.5 秒**後**。exe の名前は版の番号（2.1.288〜）で比べられない。Bot の unit に隔離の設定は無い（ProtectProc=default・PrivateUsers=no・PrivateTmp=no・ProtectHome=no）。

### 1.2 確認（probe。2026-11-13。端末 2.1.323 / Opus 5.5 / auto → SDK 同梱 2.1.286 / opus-5 / default）

| # | 確かめたこと | 結果 |
|---|---|---|
| P1 | 待機中の claude へ SIGTERM | 約 1.5 秒で終了。記録に 2 行（last-prompt・cost-state）を足す。`sessions/<pid>.json` は消え、ペインはシェルに戻る |
| P2 | 記録を置かずに resume | `No conversation found`（turn.ts が見ている文） |
| P3 | 記録を Bot 側にコピーして resume | **成功**（版違い・モデル違いでも）。**session_id は同じ**。追記は Bot 側だけ（分岐） |
| P4 | `forkSession: true` | 成功。新しい session_id |
| P5 | `projects/<名前>` を端末側への symlink にして resume | 成功。端末側に追記され、端末の `claude --resume` で続きを読めた |
| P6 | system prompt の append | **効かない**。snapshot: true の resume は、記録された端末の system prompt を送る（コピー・fork・共有のどれでも） |
| P7・P8 | 自前の MCP ツール・許可のモード | ツールは使える。端末が auto でも resume の init は `default` で、canUseTool が呼ばれた |
| P9 | modelUsage | 最初の result に端末側の累計（別モデルの行）が混ざる。Bot のモデルの行は最初のターンで cacheRead 0 |

## 2. 残りの確かめる項目（未確認。設計は倒した側で書いた）

| # | 項目 | いつ | 駄目だったときの倒し方 |
|---|---|---|---|
| R1 | **確認済み（M1。2026-11-13）**。Bot の unit と同じ設定の一時 unit から端末の claude の `/proc` を読めて SIGTERM が届く（1.26 秒で終了） | M1（§5.4） | 終わったセッションの取り込み（端末で /exit してから）だけにする |
| R2 | 圧縮の後に PROJECT_APPEND が入るか・前置きが残るか | T3b の後に 1 回 | 圧縮の次のターンにも前置きを付ける（T4） |
| R3 | 数十 MB の記録の resume（時間・メモリ）と、同期のコピーで止まる時間 | T3b の実機確認 | `TAKEOVER_MAX_BYTES` を下げる |
| R4 | サブエージェントを使った会話を、脇のディレクトリなしで resume | T3b の実機確認 | 脇のディレクトリも写す |
| R5 | ターンの途中で SIGTERM を受けた記録の resume | 手で 1 回 | §3.6.3 の知らせで新しい会話になる |
| R6 | 待機中の claude が抱える背景のシェル・MCP の子プロセスが、SIGTERM の後に残るか | M1（§5.4 の 5） | 結果を確認の文に 1 行足す（「背景のタスクは止まります／残ります」） |
| R7 | **確認済み（M1）**。SIGTERM で終わった pid は次の `claude agents --json` に無かった（1 回見ただけ） | M1 | §3.4 の確かめで落ちる（取り込めないだけ） |

## 3. 案の比較と決定

### 3.1 取り込み先のチャンネル

| 観点 | (a) cc のチャンネルをその場で変える | (b) いつも新しいチャンネル | (c) あれば (a)・無ければ (b) |
|---|---|---|---|
| Web の履歴の連続 | ◎ 同じ channel_id | ✗ 切れる | ○ |
| Discord での見え方 | ○ 名前は `cc-…` のまま | ◎ | △ |
| 実装コスト | ○ 行の付け替え | ○ | ✗ 2 経路 |
| 運用コスト | ◎ チャンネルが増えない | △ 毎回 1 つ増え、古い方の始末が残る | △ 同左 |

**決定: (a)。チャンネルが無いときは `ensureFor`（CC10・CC11 の既存の作成）で先に作ってから変える**ので、経路は 1 本になる。作れなければ取り込まない。

- cc の行は **deleted にする**。既存の判定に触らずに発言がリモコンに行かなくなり、一意索引も空く。出どころは `cc_takeovers` に残す（state を足す案は、表の作り直しと全部の判定の見直しが要る）。
- `sessions` の行を同じ channel_id で作り、カテゴリは進行中へ `enqueueMove`、topic は `sessionTopic(題名, undefined, プロジェクト)`。**題名は `cc_sessions.name`**（無ければプロジェクトの名前。`cc_channels.name` は `cc-` 付きなので使わない）。
- ended のチャンネルの削除の確認（#system の `cc:del:`）は、ボタンを外して「取り込まれました」に編集する。チャンネル名が `cc-…` のままなのは受け入れる（未決 1）。

### 3.2 リモコン側の行と、終了の見分け

**決定: 見分ける場所を `ccEndedHandler` の 1 箇所にし、差し止めたことを DB に書く。** そのセッションに running の取り込みがあれば、ended の知らせを通さず（`channels.ended`・`replier.ended` を呼ばない）、`cc_takeovers.ended_held` を 1 にする。成功すれば捨てる。失敗したとき・再起動で failed に戻したときは、**`ended_held` を 1 → 0 にできた行だけ** 2 つを呼び直す（差し止めていないのに流すと終了の文が二重に出る。§1.1 の 1）。DB に書くのは、registry が gone_at を先に書くので（§1.1 の 2）、再起動すると ended が二度と来ないため。

取り込みの前に断る: `cc_channels` が resuming / `cc_sends` に awaiting_confirm・queued・delivering が 1 件でもある / `cc_permissions` に pending がある。成功したとき: `cc_channels` は deleted（§3.1）、`cc_sessions` は一覧から消えて gone・`stopFollow`（追いかけ先が別のチャンネルなら 1 行だけ知らせる）、`cc_sends`・`cc_permissions` は触らない（以後は同じ session_id で origin sdk の行ができる）。

running の間（`start(id)` の直後から done / failed まで。DB の `runningFor`・`runningForChannel` で見る）は、次を止める。
- **送信**: `CcSender.submit`・`propose` は、送り先の確かめを await した**後**の「行を作るまで await しない」区間で見て `taking_over` で断る。`confirm`（[送る]）も断る。`attempt` は届けずに queued のまま戻る。取り込みの側の「届け待ちが無い」の確かめは `start(id)` の後に行う。
- **チャンネル**: `CcChannels.resume`（[起動して続ける]）・`close`（/cc close・Web）・`revived`（開き直し。`reopenIfListed` を含む）と、`cc:del` の [削除する] は、何も変えずに「取り込みの途中です。終わってからもう一度。」を返す。
- **文面**: `taking_over` は「取り込みの途中です。終わってから送ってください」。`SUBMIT_REJECT_REPLY` のほか、`already_queued` の文を出している所の全部に足す（§5.2）。
- **commit は条件付き**: cc の行を「session_id が同じで state が open か ended」のときだけ deleted にする。違っていたら巻き戻して失敗（`channel_changed`）。
- 取り込んだ後に端末で同じ会話を resume した場合は §7 の 3。

### 3.3 記録の置き場所

| 観点 | (A) Bot 側へコピー | (B) `projects/<名前>` を symlink で共有（U3 の形） | (C) fork して新しい session_id |
|---|---|---|---|
| 2 つのプロセスが同じ記録に書く | ◎ 起きない（分岐） | ✗ 端末で resume すると起きる | ◎ |
| 端末へ戻れる | ✗ 取り込む前までしか無い | ◎ そのまま戻れる | ✗ |
| `~/.claude` に書かない線 | ◎ | ✗ CLI が端末側に追記する | ◎ |
| 実装コスト | ◎ ファイル 1 つ | △ 自動メモリ・守り・setup が要る（U3） | △ runner に fork の口 |
| 運用コスト | ○ ディスクが記録 1 つ分 | ◎ | △ 2 つ分 |

**決定: 今は (A)。** `<session_id>.jsonl` だけを写す。session_id は変えない（U3 で (B) に移ると、同じ ID のまま端末と行き来できる）。
- **実体が同じなら写さない**（両方のディレクトリの realpath が同じ）。U3 で共有したらこの分岐に入り、コードを変えずに (B) になる（「同時に書く」守りは U3 で決める）。
- 写し先のディレクトリは、realpath が `<CLAUDE_CONFIG_DIR>/projects` の realpath の下にあるときだけ使う（外へ出ていれば `target_invalid`。上の「同じ実体」は別扱い）。
- 写し方: 元を O_NOFOLLOW で開き、fstat で通常ファイル・`TAKEOVER_MAX_BYTES`（128 MB）以下を確かめる → 一時名（排他・mode 600）へコピー → rename。
- 写し先に同じ名前がすでにある: `channel_sessions` にその session_id の行があれば断る（`already_taken`）。無ければ古い方を `<名前>.old` に退けてから写す（`.old` は 1 つだけ）。
- 場所の名前は **runner の cwd** から作る（§3.4 の「cwd の形」を確かめた後）。

### 3.4 claude の終わらせ方と競合

比べた案: (a) pid へ SIGTERM（P1 で確認。画面の状態に左右されず、競合してもターンが止まるだけ）/ (b) ペインに `/exit` を貼る（未確認。書きかけ・ダイアログで誤り、発言として入りうる）/ (c) tmux の kill-pane（ペインごと消える。包みに kill が要る）。

**決定: (a)。SIGKILL は送らない。プロセスグループにも送らない。**

- **生きているセッションの条件**: 今読んだ一覧で interactive・idle・信頼の確認待ちでない・保留の許可が無い・**tmux のペインが引けて `probePaneState` が idle**。tmux の外は断る（/exit の後の取り込みで拾える）。ペインを撮れなければ `tmux_failed`。
- **「今読んだ一覧」**: `t0 = now()` → `await registry.tick()` → `snapshot()` が `stale === false`・`unreadable === false`・`fetchedAt >= t0`。満たさなければ `list_failed`（終わったセッションの取り込みでも同じ。「一覧に無い」を古い一覧で言わない）。
- **cwd の形**: 名前は `resumeProject(cwd)`。`checkSessionProject(名前)` を通し、さらに**端末の cwd（末尾の / を除く）が runner の cwd（`verifiedProjectDir(名前)`）と同じ文字列**のときだけ取り込む。違えば `outside_workspace`（作業場所が symlink 越しなど。probe で確かめたのは同じ形だけ）。
- **相手の確かめ**（signal の直前に全部。1 つでも欠ければ `identity`。signal は送らない）:
  1. 今読んだ一覧にその session_id があり、pid が最初の確かめと同じで、interactive・idle。
  2. `sessionFile(pid, sessionId)` が返る。
  3. `/proc/<pid>/stat` の comm が `claude`・state が R・S・D のどれか（Z のほか、止まっている T・t も落とす。SIGTERM が保留され、後で fg した瞬間に死ぬ）・starttime が最初の確かめと同じ。`sessions/<pid>.json` に `procStart` があれば、starttime と文字列で一致すること（実機の 2.1.288・2.1.321 で一致を確認。無い版は 4 だけ）。
  4. プロセスの開始（`/proc/stat` の btime × 1000 + starttime × 10 ミリ秒）が、一覧の `startedAt` + 2 秒以下。使い回された pid のプロセスは `startedAt` より後に始まっているので落ちる。`startedAt`・btime が読めなければ落とす。
  5. pid が 1 より大きく、自分でなく、**自分の祖先でも子孫でもない**。祖先は pid 1 に着くまでたどる（8 段で打ち切らない。1,024 段を超える・途中で読めないなら落とす）。
- **直前の競合**: 最初の確かめで記録の大きさを覚える → 2 秒おく → 一覧を読み直し、ペインを撮り直し、**記録の増えた分に `user`・`assistant` の行が無い**ことを見る（あれば `changed`。大きさ・mtime は比べない。§1.1 の 7）→ 相手の確かめ → すぐ SIGTERM。終了の後にもう一度増えた分を見て、あれば `interrupted` を立て、完了の文に 1 行足す。
- **終了の確かめ**: `/proc/<pid>` が消える（か starttime が変わる）のを 250 ms ごとに 10 秒まで待つ。**消えたことが根拠**。その後に一覧を 1 回読む（registry に追いつかせるだけ。読めなくても進む）。消えなければ `not_exited`。**SIGTERM は取り消せない**ので、後から終わることがある（普通の ended になる）。
- **終了の前に済ませる**: プロジェクトの検証・元の記録の検査・写し先の用意・進行中のカテゴリの解決（/new と同じ `layoutQueueKey` のキューの中で。無ければここで作られ、失敗しても残る）。
- **落ちたとき**: 起動時に running の取り込みを failed（`restart`）にし、差し止めた ended を流し直してから registry を始める（§3.2）。registry がまだ終了を見ていなかったものは、最初の読みが普通に ended にする。どちらも `/cc take` をもう一度。
- **終わったセッションの取り込み**: 今読んだ一覧に無い・`cc_sessions` に gone の行がある・cwd の形が合う・元の記録がある、が条件。手順は終了を飛ばすだけ。

### 3.5 入口

比べた案: (a) `/cc take` + 確認のボタン（2 段で誤操作が少ない）/ (b) ended のチャンネルの [取り込んで続ける] / (c) Web のボタン / (d) SDK のツール（モデルがプロセスを止める口になり、全セッションのキャッシュが 1 回外れる）。

**決定: (a) → (b) → (c) の順。(d) は作らない。** 最初の入口（T3b）は cc のチャンネルの中での `/cc take` だけ。確認は 10 分で失効（`cc_send` の確認と同じ型）。ボタンは `cc:take:go:<id>`・`cc:take:no:<id>`。

### 3.6 取り込んだセッションの形

- `sessions`: state active・origin `command`（CHECK を変えない。出どころは `cc_takeovers`）・persona は既定・`project_dir` はプロジェクトの名前。
- **`permission_mode` は常に default**。U1 には後からモードを変える口が無く（§1.1 の 5）、plan・acceptEdits を引き継ぐと戻せない。確認の文に「許可のモードは default になります（端末: <端末のモード>）」と書く。端末のモードは `cc_takeovers.terminal_mode` に残す。U2 で /mode が入ったら引き継ぎを見直す（未決 6）。
- モデルと effort は `cfg` のもの（端末のモデルは引き継がない）。最初のターンはキャッシュが全部外れる（P9）。**1 回だけ受け入れ**、CLAUDE.md の「プロンプトキャッシュの規則」に例外として 1 行足す。

#### 3.6.1 self-agent の案内の渡し方（P6 への対応）

比べた案: (a) 最初のターンの発言の前に前置きを 1 回（追記だけなのでキャッシュに触らない）/ (b) 取り込んだ会話だけ snapshot: false（効くか未確認。git の状態が変わるたびに全部外れうる）/ (c) 取り込み時に案内だけのターンを打つ（用が無いのに 1 ターン使う）。

**決定: (a)。** 付ける・消すの条件（T3a）:

- **付ける**のは次を全部満たすターンだけ: resume の経路である / `purpose` が無い（/close の要約でない）・予約でない / そのチャンネルの最新の done の取り込みが `note_pending = 1` / **その取り込みの session_id が、今 resume する session_id と同じ**。/renew・resume の失敗で会話が新しくなれば id が変わるので付かない。新規でやり直す prompt には混ぜない。
- **消す**（`note_pending = 0`）かどうかは、その resume の結果で決める。

| resume の結果 | 前置き |
|---|---|
| 成功 | 消す |
| 失敗だが result が届いた（`sessionRecorded`。API のエラー・手順数の上限など） | 消す（prompt は記録済み） |
| 中断・タイムアウト・result の届かない失敗 | **残す**（記録されたか分からない。二重に入っても害は無く、1 回も入らない方が困る） |
| SDK セッションを捨てた（§3.6.3） | 消す |

`TAKEOVER_NOTE` は下の頭書き + `PROJECT_APPEND`（システムプロンプトではないので、変えてもキャッシュは外れない）。

```
（self-agent が付けた知らせです。オーナーの発言ではありません）この会話は、端末の Claude Code から self-agent が引き継ぎました。これより前の指示のうち、端末の画面を前提にしたものより、次を優先してください。
- 端末の画面はもうありません。AskUserQuestion は使えません。訊きたいことは本文に書いてください。
- 自動メモリ（~/.claude の下のファイル）は、ここからは読み書きできません。試さないでください。
- モデルと許可のモードは、端末のときと違うことがあります。
```

#### 3.6.2 usage の扱い（P9 への対応）

**決定: 何も変えない。** `usage_log` はステップごとの usage の合計なので端末の累計は混ざらない（§1.1 の 9）。最初の行は cacheRead 0 になる（正しい値）。**取り込んだ会話では `modelUsage` と費用の累計を計測に使わない**。

#### 3.6.3 resume に失敗したとき

`turn.ts` が SDK セッションを捨てるのは 1 箇所で、理由は 3 つ（画像の拒否・`No conversation found`・連続失敗。§1.1 の 8）。今は黙って新しい会話になる。その直前で、捨てる session_id がそのチャンネルの取り込んだものと同じなら、チャンネルに 1 回だけ知らせる:「取り込んだ会話を続けられなくなったため、新しい会話として続けます。元の会話は端末で claude --resume で開けます。」。/renew が自分で捨てる場合は /renew の返事があるので足さない。

### 3.7 進行状況（#338）との関係

- **DB**: どちらも配列の末尾に足すので、番号は入った順（後から入る方が rebase して v43 にする）。表・列は重ならない。マージ前の枝を本番の DB で動かさない。
- **分類**: 取り込むと CC のセッションが 1 つ減り、プロジェクトのセッションが 1 つ増える（二重には数えない）。`classifyProject` は「待機の CC のセッション + 未コミット」を owner にするが、待機しているプロジェクトのセッションは見ないので、取り込みの後は agent 側に出る。U1 のセッション全部の話なので #338 の側の課題にする（未決 3）。

### 3.8 逆向き（Discord のセッションを端末へ戻す）

**決定: 範囲外。置き場所は U3。** コピーの形では Bot 側の記録を `~/.claude` へ書き戻すことになり、「`~/.claude` に書かない」線を越える。`projects` を共有すれば（P5）写さずに端末の `claude --resume` で続きが読め、それが U3。起動の口（`buildClaudeCommand`）に `--resume` も無い。U3 に渡す材料: P5・同時に書かない守り・自動メモリの場所。

### 3.9 DB・環境変数・安全

- **DB**: 表 `cc_takeovers` を 1 つ足す（T1 で済み。§5.1 の追補で列を 1 つ入れ替える）。`sessions`・`cc_channels`・`cc_sessions` の定義は変えない。`cc_takeovers` に本文は置かない。
- **環境変数**: 足さない。`SELF_AGENT_CC=1` で、プロジェクトのセッションの準備（`ProjectSessionGate.ready`）ができているときだけ動く。
- **安全**
  - オーナーだけ（`/cc` の既存の確かめ）。ボタンは押した人・チャンネル・state を確かめる。Web は `Tailscale-User-Login`。
  - 対象の session_id・pid はチャンネルの行と一覧から引き、**入力の文字列から取らない**。signal は SIGTERM だけ・1 つの pid だけ・§3.4 の確かめを通ったときだけ。
  - ログに session_id・pid・cwd・名前・パス・本文を出さない（理由の符号と段だけ）。
  - 書く先は `CLAUDE_CONFIG_DIR` の中だけ。`~/.claude` には書かない。

## 4. 手順と状態遷移

`cc_takeovers.state`: `awaiting_confirm` →（[取り込む]）`running` → `done` / `failed`。`awaiting_confirm` →（[やめる]・10 分）`cancelled`。running の間の位置は `step`。

| step | すること | 失敗したとき |
|---|---|---|
| check | `start(id)` → 一覧を読む（§3.4）→ §3.2・§3.4 の条件 → cwd の形 → 元の記録の検査と大きさの記憶 → カテゴリの解決 → 写し先の用意。生きていれば 2 秒おいて、一覧・ペイン・増えた分を確かめ直す | failed。端末のセッションと DB の行は変えていない（カテゴリと写し先のディレクトリはできていることがある） |
| term（生きているときだけ） | 相手の確かめ → SIGTERM → `/proc/<pid>` が消えるまで待つ → 一覧を 1 回読む → 増えた分を見る | 確かめで落ちた: `identity`（signal なし）。消えない: `not_exited`（signal は送った） |
| copy | 記録を写す（同じ実体なら写さない） | `copy_failed`。差し止めた ended を流し直す（§3.2）→ 普通の ended のチャンネルになる |
| commit | `BEGIN IMMEDIATE` の 1 つのトランザクション: cc の行を条件付きで deleted（`markTaken`。0 行なら巻き戻して `channel_changed`）・`sessions` の行・`channel_sessions` に session_id・`stopFollow`・取り込みを done（`note_pending = 1`・`ended_held = 0`）。内側に BEGIN のある操作（`markGone` など）は呼ばない | 同上（巻き戻る） |
| （後始末。失敗しても done） | 進行中へ移す・topic・完了の文・履歴の divider・確認の文と削除の確認の編集・追いかけ先への 1 行 → `effects_at` | 起動時に、`effects_at` が空の done の行の移動と topic だけやり直す |

失敗の符号と文（確認の文を `取り込めませんでした: <文>` に編集。**SIGTERM を送った後**の失敗は、`not_exited` を除き「端末の Claude Code は終了しています。このチャンネルで /cc take をもう一度実行すると、終わった会話から取り込めます。」を足す）:

| 符号（v2 で足した・文を変えたもの） | 文 |
|---|---|
| list_failed / tmux_failed | Claude Code の一覧を読めませんでした。もう一度 / 端末の画面を読めませんでした。もう一度 |
| channel_busy / channel_changed | このチャンネルは起動の途中です。終わってからもう一度 / 取り込みの間にチャンネルの状態が変わりました。もう一度 |
| no_category / target_invalid | 進行中のカテゴリを用意できませんでした / 記録の写し先を使えません（CLAUDE_CONFIG_DIR の projects の外を指しています） |
| identity | セッションを確かめられませんでした。端末の Claude Code はそのままです |
| not_exited | 10 秒待っても端末の Claude Code が終わりませんでした。取り込みはやめました。後から終わったら、もう一度 /cc take してください |

ほかの符号の文は T1 のまま（`cc/takeover-rules.ts` の `FAILURE_TEXTS`）。

確認の文: 「「<題名>」（<プロジェクト>）を取り込みます。端末の Claude Code は終了し、続きはこのチャンネルで self-agent が引き継ぎます。許可のモードは default になります（端末: <端末のモード>）。モデルは self-agent の設定のものになります。」（終わったセッションは 2 文目の前半を「端末の Claude Code はすでに終わっています。」に）。
完了の文: 「取り込みました。ここから先は self-agent がこの会話を続けます（<プロジェクト>・許可のモード default）。端末で claude --resume すると取り込む前までの会話が別に開きます（ここでの続きは入りません）。」`interrupted` なら「取り込みの直前に端末で動きがありました。最後の指示は途中で止まっているかもしれません。」を足す。

## 5. 段階分け（1 段 = 1 PR。順に積む）

| v2 の段 | v1 の段 | 内容 | 使えるようになること |
|---|---|---|---|
| T1（済） | T1 | DB・ストア・判定の純関数・記録の写し | なし |
| T1b | （T1 の追補） | §5.1。T1 の PR に積む | なし |
| T2 | T2 | 本体 `CcTakeover`・ended の差し止め・送信とチャンネルのゲート・再起動の復旧 | なし |
| T3a | T3 の一部 | ターン側（前置き・resume を捨てたときの知らせ）。main からは渡さない | なし |
| M1（済。手順 5 は未） | T3 の実機確認の一部 | 手での確認（PR なし）。T2 の後・T3b の前 | R1・R7 が決まった。R6 は未確認 |
| T3b | T3 の残り | `/cc take`・確認のボタン・main の配線・文書 | cc のチャンネルの中から取り込める |
| T4（済。3 つ目は R2 待ち） | T4 | Discord の入口を広げる | [取り込んで続ける]・チャンネルの外から選ぶ |
| T5（済） | T5 | Web | セッションのタブから取り込める |

### 5.1 T1 の追補（T1b）

**T1 の追認**（実装者が狭い側に倒した点。設計として採る）: interactive でない行は `identity` / 信頼の確認待ちは `pane` / status が idle・waiting 以外は `busy` / 保留の許可は `waiting` / 元が通常ファイルでなければ `no_transcript` / session_id が UUID の形でなければ `takeoverPaths` は undefined / `copyTranscript` の `now` / `takeoverRefusal` の入力を alive・ended で分け、直下かは `project` で渡す。変えるのは 1 点だけ: ペインを撮れないときは `pane` でなく `tmux_failed`。

**DB**（`src/store/db.ts`）: v42 の SQL を**直接直す**（どこにもマージされていない。9bf2eef を動かした DB があれば作り直す。本番の DB で動かしていないことは先に確かめる）。`pending_text TEXT` の行を消し（本文を置かない。T4 はメモリで持つ）、`ended_held INTEGER NOT NULL DEFAULT 0` を足す。`permission_mode` の列はそのまま（U2 まで常に default）。

**`src/store/cc-takeovers.ts`**
- `CcTakeoverRow`: `pendingText` を消し `endedHeld: boolean` を足す。`CcTakeoverPropose` の `pendingText` を消す。
- `hold(id): boolean` — running の行の `ended_held` を 1 に（変わったら true）。
- `releaseHeld(id): boolean` — `ended_held = 1` の行を 0 に。1 行変わったときだけ true（流し直しの compare-and-set）。
- `listHeld(): CcTakeoverRow[]` — `state = 'failed' AND ended_held = 1`。
- `runningForChannel(channelId): CcTakeoverRow | undefined`。
- `finish(id)`: `ended_held = 0` も書く。`fail`・`resetRunning` は `ended_held` を変えない。
- テスト: hold は running 以外で false / releaseHeld は 2 回目が false / finish の後は listHeld に出ない / resetRunning の後も `endedHeld` が残る。

**`src/cc/takeover-rules.ts`**
- 定数: `TAKEOVER_COMM = "claude"`・`TAKEOVER_START_SLACK_MS = 2000`・`TAKEOVER_LINEAGE_MAX = 1024`・`TAKEOVER_CLK_TCK = 100`。
- `parseStat(stat): { comm: string; state: string; ppid: number; startTime: number } | undefined` — comm は最初の `(` と最後の `)` の間。その後ろの 1・2・20 番目が state・ppid・starttime。`parseStatStartTime` は消す（呼び出しはまだ無い）。
- `parseBtime(procStat): number | undefined`（`btime <秒>` の行）、`procStartMs(startTime, btimeSec): number`（`btimeSec * 1000 + startTime * 1000 / TAKEOVER_CLK_TCK`）。
- `lineage(pid, parentOf: (pid) => number | undefined): number[] | undefined` — 親を pid ≤ 1 までたどった列（自分は含めない）。途中で読めない・`TAKEOVER_LINEAGE_MAX` を超えるなら undefined。
- `takeoverIdentity(input): boolean` — §3.4 の 1〜5 を全部満たすときだけ true。入力: `{ view: Pick<CcSessionView, "pid" | "kind" | "status" | "startedAt"> | undefined（今読んだ一覧のその session_id の行）; first: { pid: number; startTime: number }; sessionFile: boolean; stat: ReturnType<typeof parseStat>; btimeSec: number | undefined; ownPid: number; ownAncestors: number[] | undefined; targetAncestors: number[] | undefined }`。5 は「`ownAncestors` に pid が無い」「`targetAncestors` に ownPid が無い」「どちらも undefined でない」。
- `TakeoverFailure` に `list_failed`・`tmux_failed`・`channel_busy`・`channel_changed`・`no_category`・`target_invalid` を足し、文は §4（`not_exited`・`identity` の文も §4 に直す）。`takeoverFailureText(code, afterTerm)` は `not_exited` に後ろの文を足さない。
- `TakeoverRefusalInput` に `listFresh: boolean` と `channelState: "open" | "ended" | "resuming"` を足す。順は not_ready → `list_failed`（`!listFresh`）→ outside_workspace → `channel_busy`（resuming）→ 今までの順。`pane === "failed"` は `tmux_failed`。`project` は「cwd の形まで合った名前」（合わなければ呼び出し側が undefined を渡す）。
- `mapTakeoverMode` は残す（U2 まで呼ばない、とコメントに書く）。
- テスト: comm に空白・括弧のある stat / state Z / starttime の違い / 開始が `startedAt` + 2 秒を超える / `startedAt`・btime が undefined / pid が自分・自分の祖先・自分の子孫 / lineage が読めない・長すぎる / comm が `claude` でない → どれも false。全部そろえば true。新しい符号の順。

**`src/cc/takeover-files.ts`**
- `prepareTarget(dir, projectsRoot, srcDir): "ready" | "shared" | "invalid"` — mkdir -p（mode 700）の後、`realpath(dir) === realpath(srcDir)` なら shared、`realpath(dir)` が `realpath(projectsRoot)` の下なら ready、ほか（mkdir の失敗を含む）は invalid。
- `copyTranscript`: 退ける名前を `<dst>.old` に固定（あれば上書き）。元を O_NOFOLLOW で開いて fstat で確かめるのは T1 で済み（変えない。`inspectSource` は事前の検査で、根拠はこちら）。
- テスト: projects の下の symlink が外を指す → invalid / src と同じ実体 → shared / `.old` が 2 回目で増えない。

**ほかの store**
- `src/store/sdk-sessions.ts`: `hasSessionId(sessionId): boolean`（`SELECT 1 FROM channel_sessions WHERE session_id = ? LIMIT 1`）。`already_taken` の判定と `copyTranscript` の `hasMapping` に使う。
- `src/store/cc-channels.ts`: `markTaken(channelId, sessionId): boolean` — `UPDATE … SET state = 'deleted' … WHERE channel_id = ? AND session_id = ? AND state IN ('open','ended')`。1 行変わったら true。内側に BEGIN を置かない。
- テスト: 別の key に同じ session_id があれば true / resuming・別の session_id の行は markTaken が false。

### 5.2 T2 本体
- `src/cc/takeover.ts`（新）`CcTakeover`。deps はすべて注入: `db`（commit の BEGIN 用）・registry・panes・`ClaudeDirs`・各 store・`ensureFor`・`findStateCategory`・`queue`・`checkSessionProject`・`verifiedProjectDir`・`channelOps`・gateway・history・`kill`・`readProc(pid)`・`readBtime`・`sleep`・`now`・`ownPid`・`replayEnded(session)`・log。
  - `propose({ channelId, entry })`: cc の行 → 一覧を読む → `takeoverRefusal` → 行を作り、確認の文とボタンを返す。
  - `confirm(id)`: §4 の step を順に。`cancel(id)`・`expire()`（1 分ごと。確認の文を「取り込みの確認は期限切れです（10 分）。」に編集）。
  - `holds(sessionId)`・`holdsChannel(channelId)`: running の行があるか（DB）。
  - `intercept(session)`: running の行があれば `hold(id)` して true。失敗のときは `fail(id, code)` → `releaseHeld(id)` が true なら `replayEnded`。
  - `recover()`: `resetRunning()` → `listHeld()` の各行で `releaseHeld` → true なら `replayEnded(ccSessions.get(sessionId))` → `listEffectsPending()` の移動・topic。
  - `noteFor(channelId, sessionId, turn)`・`noteDone(channelId)`・`resumeDropped(channelId, sessionId)`（§3.6.1・§3.6.3。T3a が呼ぶ）。
- `src/cc/channels.ts`: `ccEndedHandler` の deps に `takeover: () => { intercept(session): boolean } | undefined`。true なら 2 つを呼ばない。`replayEnded` は同じ 2 つを呼ぶ関数として出す。`resume`・`close`・`revived` の先頭に `holdsChannel` / `holds` の確かめ。`SUBMIT_REJECT_REPLY` に `taking_over`。
- `src/cc/sender.ts`: deps に `holds?: (sessionId) => boolean`。`submit`・`propose` は await の後の区間で、`confirm` は先頭で見る（`confirm` の返り値に `"taking_over"`）。`attempt` は queued のまま戻る。
- `taking_over` の文を足す所: Web の送信の API・`app/github-handoff.ts`・`agent/cc-tools.ts`・`app/commands/cc.ts`（[送る]・[削除する]）。
- テスト `test/cc-takeover.test.ts`（偽の registry・kill・proc、一時 SQLite）: §6 の T2。

### 5.3 T3a ターン側
- `src/agent/system-prompt.ts`: `TAKEOVER_NOTE_HEAD`（§3.6.1）と `TAKEOVER_NOTE = [TAKEOVER_NOTE_HEAD, PROJECT_APPEND].join("\n")`。
- `src/app/turn.ts`: `TurnDeps` に `takeover?: { noteFor(key, sessionId, turn): string | undefined; noteDone(key): void; resumeDropped(key, sessionId): void }`。
  - resume の経路の `runOnce` だけ、`noteFor` が返れば `` `${note}\n\n${prompt}` `` を渡す。`runFresh` には渡さない。
  - 前置きを付けた resume の直後（`if (result.ok) return` の**前**）: `result.ok || result.sessionRecorded === true` なら `noteDone`。
  - SDK セッションを捨てる 1 箇所（`sessions.delete(key)` の直前）で `resumeDropped(key, sessionId)`。
- テスト（偽の takeover）: §3.6.1 の表の 4 行 / session_id が違えば付かない / `purpose: "close"`・予約では付かない / 新規の prompt に入らない / 捨てる 3 つの理由それぞれで `resumeDropped` が 1 回。

### 5.4 M1 手での確認（利用枠を使うのは手順 5 だけ）
1. 作業場所の直下に捨てるプロジェクトを作り、tmux で claude を起動して待機にする（指示は打たない）。
2. `claude agents --json` でその pid と `startedAt` を控える。
3. Bot の unit と同じ設定の一時 unit（`systemd-run --user`。sudo なし）から、`/proc/<pid>/stat` を読めて comm が `claude`・開始が `startedAt` より前であることを見て、SIGTERM を送る。
4. 見るもの: 10 秒以内に `/proc/<pid>` が消える / ペインがシェルに戻る / `sessions/<pid>.json` が消える / 次の `claude agents --json` に無い（R7）/ 記録に増えた行の type が user・assistant でない。
5. （任意。1 ターン使う）背景のシェルを 1 つ動かしたまま待機にして同じことを行い、子プロセスが残るかを見る（R6）。
6. 結果を #341 に書く。3・4 が通らなければ R1 の倒し方（終わったセッションだけ）で T3b を作る。

**結果（2026-11-13。#341 のコメント）**: 手順 1〜4 は通った。一時 unit の中から本物の確かめ（`takeoverIdentity`・`parseStat`・`lineage`・`ClaudeDirs.sessionFile`）を通して SIGTERM を送り、1.26 秒で `/proc/<pid>` が消え、`sessions/<pid>.json` が消え、次の一覧に無く、Bot は動いたままだった。`procStart` と starttime は一致し、`startedAt` を 60 秒ずらす・`procStart` を変えると確かめは false になった。見ていないもの: 記録に増える行（指示を打っていないので記録が無い。会話のある記録では probe で確認済み）／ペインがシェルに戻る（claude をペインのコマンドとして起動したのでペインごと閉じた。シェルの上では probe で確認済み）／**手順 5（R6）は行っていない**。T3b は「生きているセッションも取り込む」形で作った。

### 5.5 T3b 入口（Discord）と配線
- `src/app/commands/cc.ts`: サブコマンド `take`（引数なし）。cc のチャンネル（open・ended）の中なら `propose`、外なら「Claude Code のチャンネルの中で使ってください（無ければ /cc open）。」。ボタン `cc:take:go:<id>`・`cc:take:no:<id>`（押した人がオーナー・行の channel_id が同じ・state が awaiting_confirm でなければ「この確認はもう使えません。」）。
- `src/main.ts`: `SELF_AGENT_CC=1` のときだけ組み立てる。Gateway・`CcChannels`・replier の後に **`recover()` → `registry.start()`** の順。`ccEndedHandler`・`CcSender`・`CcChannels`・turn の deps に渡す。失効のタイマー。
- 文書: CLAUDE.md（概要に 1 行・キャッシュの規則に例外 1 行）、`docs/directory-structure.md`、`docs/plan/unify.md` の U3 に「取り込みの記録の共有・端末へ戻す」。
- 実機確認: R3・R4 と §6 の T3b。

### 5.6 T4 Discord の入口を広げる
- ended のチャンネルの発言に出す [起動して続ける][やめる] に **[取り込んで続ける]**（`cc:take:resume:<channelId>:<messageId>`。保留した発言は今の `resumePending` と同じメモリの口から引く。再起動で消えていれば「もう一度送ってください」）。押すと `propose` → そのまま `confirm`。done の後、その発言を最初のターンとして流す（Web の `POST /messages` と同じ経路。関数名は未確認）。条件に合わないときはボタンを出さない。
- cc のチャンネルの外での `/cc take`: `/cc open` と同じ選択（`cc:takepick`）で取り込めるセッションだけ出し、選ぶと `ensureFor` で作ったチャンネルに確認の文を出す。
- R2 が「入らない」なら、圧縮の次のターンに `note_pending` を 1 に戻す。

**作ったもの（T4。§9.6）**: 1 つ目と 2 つ目。3 つ目は R2 が未確認なので入れていない（R2 を確かめてから）。保留した発言は Web の経路（`submitText`。「（Web から）」の投稿が増え、履歴の owner の行が二重になる）ではなく、echo を出さない `handler.submitHeld`（元の発言への返信・source discord・保留のときに書いた owner の行の id を渡す）で流す。

### 5.7 T5 Web
- `POST /api/cc/sessions/<id>/takeover`（`ensureFor` → `propose`。entry web）・`POST /api/cc/takeovers/<id>/confirm`・`/cancel`。Discord の確認の文も同じ行を見る。
- cc の会話のタブに [取り込む] → 確認のダイアログ（§4 の文）。断られたら符号の文。done の後は同じ `ch:<id>` のタブが session の種類で開き直る。

**作ったもの（T5。§9.8）**: 3 つのルート（通れば 201 `{ id, channelId, text }`／confirm は 200 `{ ok, channelId, text }`／cancel は 200 `{ ok }`。断り・stale・expired・失敗・チャンネルを作れないは 409 `{ error, text }`。番号が数字でなければ 400、配線が無ければ 404）と、cc の会話のタブの頭の [取り込む]・確認のダイアログ `dlg-cc-take`（`chat.js`）。

## 6. 受け入れ条件

T1・T1b: §5.1 の各「テスト」と、T1 のテスト（移行・一意索引・写しの検査）が通る。

T2（偽の部品）
- 待機のセッション: kill が SIGTERM・その pid で 1 回だけ呼ばれ、`sessions` に同じ channel_id の行（project_dir・default）、`channel_sessions` に同じ session_id、cc の行が deleted、取り込みが done・`note_pending = 1`。終わったセッション（gone）は kill なしで同じ結果。
- kill が呼ばれない: 一覧が stale・unreadable・古い（`list_failed`。ended の取り込みでも）/ 確かめ直しで busy・増えた分に user の行（`changed`）/ comm・starttime・開始の時刻・祖先のどれかが合わない（`identity`）/ 端末の cwd が runner の cwd と違う（`outside_workspace`）/ カテゴリを作れない（`no_category`）。
- kill の後に pid が消えない → `not_exited`。ほかの行は変わらない。
- running の間の ended: `channels.ended`・`replier.ended` が呼ばれず `ended_held = 1`。copy の失敗で 2 つが 1 回ずつ呼ばれる。**ended が来る前の失敗では呼ばれない**。done の後に遅れて来た ended では、取り込んだチャンネルに何も出ない。
- `recover()`: running・`ended_held = 1` の行 → failed（`restart`）で 2 つが 1 回ずつ。2 回目の `recover()` では呼ばれない。`ended_held = 0` の行では呼ばれない。done で `effects_at` が空の行は移動と topic が 1 回ずつ。
- running の間: `submit`・`propose`・[送る] は `taking_over`、`attempt` は届けない、`resume`・`close`・開き直し・[削除する] は行を変えない。
- commit の直前に cc の行が resuming・別の session_id → `channel_changed` で、`sessions` の行はできない。
- ログに session_id・pid・cwd・名前が出ない。

T3a: §5.3 の「テスト」。

T3b
- オーナー以外の `/cc take`・ボタンは何も起こさない。10 分後の [取り込む] は使えない。
- 実機: 取り込むとペインがシェルに戻る / 最初の発言に前の会話を踏まえた返事が来る / 2 通目に前置きが付かない（devlog）/ Web の会話のタブで cc の頃の行の下に続く / `npm run usage` の最初の行が cacheRead 0 / 書き込みで許可のカードが出る。

T4・T5
- ended のチャンネルで発言 → [取り込んで続ける] → その発言への返事が同じチャンネルに 1 回だけ来る。
- Web の [取り込む] → 確認 → 同じタブが session として続く。

## 7. リスク

1. **終わらせた後に取り込めない**（コピー・DB の失敗、再起動）。記録は残るので、ended のチャンネルから `/cc take` でやり直せる。
2. **版のずれ**（§1.1 の 17）。記録は内部形式なので読めなくなりうる（§3.6.3 の知らせになる）。
3. **同じ session_id が 2 つの入口にある**（取り込んだ後に端末で resume）。記録は別なので混ざらないが、`cc_permissions` の「session_id ごとに pending は 1 つ」の索引に両方が当たると片方の保留が作れない（未確認）。今は受け入れる（未決 2）。
4. **前置きが効かない・圧縮で消える**（R2）。/renew で普通のプロジェクトのセッションにできる。
5. **別のモデル・別の版が書いた記録**を読む（確かめたのは P3 の 1 例）。
6. **誤った pid への signal**。§3.4 の 5 つの確かめで守る。comm が `claude` でない・`startedAt` が開始より前になる形があれば、`identity` で断る側に倒れる。
7. **背景のタスク・MCP の子プロセス**が SIGTERM の後に残る・止まる（R6。未確認）。
8. **SIGTERM の後に終わらない**（`not_exited`）。取り消せないので、後から終わると普通の ended になる。

## 8. 決定事項と未決

決定（この文書）: §3.1〜§3.9 の各「決定」と §5 の段。

未決
| # | 内容 | 推薦 | 決める人 |
|---|---|---|---|
| 1 | チャンネルの名前が `cc-…` のまま（Gateway に名前の変更を足すか） | 足さない（topic と Web の題名で分かる） | オーナー |
| 2 | §7 の 3 を fork（P4。新しい session_id）で避けるか | 今は避けない。U3 で共有にすると同じ ID が要る | オーナー（U3 を決めるとき） |
| 3 | 進行状況で、待機しているプロジェクトのセッションを「オーナーの番」に数えるか | 数える（#338 の後続） | オーナー・#338 の担当 |
| 4 | tmux の外の生きているセッションも終わらせるか | しない（/exit の後の取り込みで足りる） | オーナー |
| 5 | `TAKEOVER_MAX_BYTES` の値 | 128 MB で始め、R3 で直す | 実装の担当 |
| 6 | U2（/mode）の後、端末の plan・acceptEdits を引き継ぐか | 引き継ぐ（`mapTakeoverMode`）。U2 の段で決める | オーナー（U2 のとき） |
| 7 | 端末の cwd の形が違う（作業場所が symlink 越しなど）セッションも取り込むか | 今は断る。要るなら、その形の resume を 1 回確かめてから緩める | オーナー |
| 8 | M1（§5.4）を誰が行うか。手順 5（端末で 1 ターン使う）も行うか | 手順 1〜4 は済み（捨てのセッションで行った。§5.4 の結果）。残りは手順 5（R6）を 1 回 | オーナー |

## 9. レビュー（PR #342）の指摘の扱い

20 件すべて採った。直した所: 1・2 → §3.6.1・§3.6.3・§5.3 / 3・6 → §3.2・`ended_held`・`recover()` / 4・5・9 → §3.4・`takeoverIdentity`・`listFresh` / 7・8 → §3.2・`markTaken` / 10 → §3.3・§3.4・`prepareTarget` / 11 → `hasSessionId` / 12 → §3.4・`no_category` / 13 → §3.6・未決 6 / 14 → R6・§7 の 7・8 / 15 → §5 の表 / 16〜19 → §1.1 の 10・8・3、§3.1 の題名 / 20 → §5.1（`pending_text`・`.old`）・§5.2 の `db`・§5.6 のボタン・§3.6.1（/close の要約）。写しの O_NOFOLLOW + fstat は T1 で済んでいた。

### 9.1 PR #343（T1・T1b）のレビューで足した締め

重大は無し。採ったもの: 相手の確かめの state を R・S・D に限る／`procStart` と starttime の一致（§3.4 の 3）／`copyTranscript` が写す直前に「写し先が projects の下」を確かめ直す（`prepareTarget` から写しまで数秒空く）／元を開くときの O_NONBLOCK（FIFO で止まらない）／`lineage` は親が 0 以上の整数でなければ undefined／読めない行が増えていたら `changed` の側（`appendedInterrupted` が true）／rename の前の fsync／`releaseHeld` は failed の行だけ・`markEffects` は 1 回だけ true。採らなかったもの: `prepareTarget` の mkdir の順（`takeoverPaths` の名前に `/` が入らないので届かない）。T2 への申し送り: fs の例外の message（パスが入る）を log に出さない／check の段で cc の行の session_id が取り込みの行と同じことを見る／再起動で step が `term` の行は SIGTERM を送ったか分からないので、失敗の文は「終了しているかもしれません」の側にする。

### 9.2 PR #344（T2）のレビューで足した締め

重大は無し。採ったもの: `failed()` は投げない（DB が失敗しても確認の文は書き換え、行は次の `recover()` に残す。`confirm` は reject しない）／SIGTERM の前のカテゴリの解決に 15 秒の期限（`TAKEOVER_CATEGORY_TIMEOUT_MS`。過ぎたら `no_category`）／`ccReplayEnded` は届いたか（boolean）を返し、届いたときだけ `releaseHeld`（届かなければ次の `recover()` が流し直す）／取り込み中の ended のチャンネルの発言は [起動して続ける] を出さずに断る（`submitWeb` は `taking_over`）／ended の取り込みは写しの直前に一覧に戻っていないことを見る（戻っていたら `changed`）／sender は `bindSession` の後に holds を見直す／kill の ESRCH は `changed`、SIGTERM より前の例外は符号 `internal`（端末はそのまま）／後始末は確認の文が先・topic が最後（`recover()` は topic を待たない）／「終わっているかもしれません」の 1 行は生きていた行だけ。残したもの: カテゴリの期限の `sleep` は取り消せず 15 秒のタイマーが残る／期限の後にカテゴリが作られることがある（次の取り込みで使われる）。

### 9.3 PR #345（T3a）のレビューで足した締め

重大は無し。採ったもの: 前置きの 3 つの呼び出し（`noteFor`・`noteDone`・`resumeDropped`）の例外はターンを止めない（`takeoverCall`。log は例外の種類の名前だけ）／本物の `CcTakeover` をつないだテスト（取り込んだ最初のターンにだけ前置きが付く・resume を捨てたら知らせる）。

### 9.4 T3b で決めたこと（設計に無かった細部）

- 失効は `CcTakeoverExpirer`（1 分ごとに `expire()`。`CcConfirmExpirer` と同じ形。終了時に止める）。
- `/cc take` は先に本人にだけ見える形で保留し、確認の文はチャンネルに出す。出せなければ `cancel` して「取り込みの確認を出せませんでした」。
- ボタンは、オーナー・同じチャンネル・`awaiting_confirm` でなければ「この確認はもう使えません。」。10 分を過ぎた [取り込む] は `confirm` が expired にして確認の文を書き換えるだけ（kill しない）。
- 起動時の片付けは 2 段（#346 のレビューで分けた。§9.5）: 前段 `recoverRunning()`（DB だけ。running の行を restart で failed にする）は `CcTakeover` を組み立てた直後で、最初の `ccRegistry.tick()` と `gateway.start` より前。後段 `recoverEffects()`（確認の文の書き換え・差し止めた ended の流し直し・後始末の残り）は `gateway.start` の直後・`ccRegistry.start()` の前。どちらの例外も log だけで起動を続ける。
- 発言のターンに前置きを届けるため `HandlerDeps` に `takeover?` を足した（handler が turnDeps を 1 つずつ写しているため）。

### 9.5 PR #346（T3b）のレビューで足した締め

重大は無し。採ったもの: 起動時の片付けを 2 段に分ける（最初の `ccRegistry.tick()` が `recover()` より先に走り、running の行が残っていると holds が効いて revived を捨てていた。`gateway.start` の途中に押された古い [取り込む] と片付けの競合も、前段が操作を受け付ける前に済むので無くなる）／`confirm` の戻り値に `edited`（確認の文を書き換えられたか）を足し、書き換えられなければ押された 1 通を応答の側から書き換える（それも駄目なら log だけ）／取り込んだセッションの /renew で resume を捨てる経路も `resumeDropped` を通す／テスト（同時の二度押しは kill 1 回・2 つ目は「この確認はもう使えません。」、形の違う custom_id は throw）。採らなかったもの: [やめる] の書き換えの失敗でボタンが残る（次に押せば「使えません」。害が無い）／main.ts の配線のテスト（組み立てのテストの土台が無い。型と目視）／`CcTakeoverExpirer` と `CcConfirmExpirer` の共通化（別の PR）。

### 9.6 T4 で決めたこと（設計に無かった細部）

- **[取り込んで続ける] は終わったセッション専用**。propose した行の元が生きていたら `cancel` して「セッションが動いています。/cc take で確認してから取り込んでください。」（確認の文を見せずに SIGTERM を送らない）。
- ボタンを出すかは、行を作らない断る判定（`CcTakeover.refusal`。propose と同じ判定を共有）で決める。配線が無い・断られる・判定が例外なら出さない。判定は一覧を読むので、ended のチャンネルの発言への案内が少し遅くなる。
- ボタンの付いていた案内の投稿を取り込みの確認の投稿にする（`setConfirmMessage`）。結果の文はそこに出る。書き換えられなければ押された 1 通を応答の側から書き換える（§9.5 の `edited`）。
- 保留は [起動して続ける] と同じ口から引く（`takePending`。チャンネルが ended のときだけ引く。起動の途中（resuming）に押されたら引かずに「起動中です」の文。保留が無ければ案内を「古くなっています」に書き換えて「この発言はもう残っていません。もう一度送ってください。」）。どれか 1 つを押せば残りは古くなる。
- done の後の発言は `handler.submitHeld` で流す（§5.6）。受け付けられなければ「取り込みましたが、発言を流せませんでした。もう一度送ってください。」。
- チャンネルの外の `/cc take` は取り込めるセッションだけの選択（`cc:takepick`。`takeableSessions`。チャンネルの無いセッションは open として判定。25 件まで）。選ぶと `/cc open` と同じやり方でチャンネルを作り、そこに確認を出す。候補が無ければ「取り込めるセッションはありません。」。

### 9.7 PR #347（T4）のレビューで足した締め

重大は無し（確認の文なしに SIGTERM へ行く経路が無いことは、propose の後の「ended でなければ cancel」・confirm の中の「元の状態が変わっていたら changed」・kill は alive と判定した行だけ、の 3 か所で確かめた）。採ったもの: 保留を引いた後の失敗（confirm の失敗・stale・元が生きていて cancel）はどれも本人に「もう一度送ってください。」を返す／案内を出す前の判定（一覧を読む）でセッションが戻ったら、行を読み直して open の経路に回す（案内を出さない）／`confirm` は topic の書き換えを待たない（レート制限で最初のターンが遅れないように。失敗は log だけ）／`takeableSessions` はペインを撮る前に撮らなくても決まる条件で落とす（結果と符号の順は同じ）／選択の候補は一覧を読み直してから取る／`ready()` が偽なら一覧を読まない。採らなかったもの: 保留した発言の添付は落ちる（[起動して続ける] と同じ）／25 件を超える候補／本物の commit → `submitHeld` → 前置きを通しで見るテスト（土台を 2 つつなぐのが大きい。前置きと `submitHeld` は別々のテストで見ている。**実機で確かめる**）。

### 9.8 T5 で決めたこと（設計に無かった細部）

- Web の [取り込む] を押すと、Discord のそのチャンネルにも同じ確認の投稿（ボタン付き）が出る。どちらからでも答えられ、先に答えた方が効く（後の方は「この確認はもう使えません。」）。Discord に出せなくても Web からのときは取り消さない（ダイアログで答えられる）。
- Web の [やめる]・ダイアログを閉じたときは `cancel` し、Discord の確認の投稿を「取り込みをやめました。」に書き換える（Discord の [やめる] と同じ処理）。
- confirm の HTTP は終わるまで待つ（10 秒を超えることがある）。待つ間は Esc を止め、ボタンを無効にする。背景を押して閉じても取り込みは続き、結果はトーストで出す。
- done の後は、タブの状態を捨てて（`store.resetTurns`）チャンネルの一覧と会話を読み直し、同じ `ch:<id>` が session として描き直される。完了の文はトーストでも出す。
- 静的ファイルの版を上げる仕組みは無い（ETag）。
- **ブラウザでは確かめていない**（この機械にブラウザが無い）: ダイアログの見た目・改行・スマホの幅・待つ間の表示・焦点の戻り・タブの描き直し。
