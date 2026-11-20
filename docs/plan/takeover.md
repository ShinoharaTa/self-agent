# 取り込み（端末の Claude Code の会話を self-agent のセッションが引き継ぐ）設計（#341）

v3（2026-11-18。#428 の方向に合わせた）。前提: `docs/plan/terminal-handover.md`（#428。段 H0〜H5・X1〜X5）、`docs/plan/unify.md`（U1・U3）、`claude-code-sessions.md`、`claude-code-channels.md`。

書き分け: 「確認」「事実」はコードか実機で確かめた物。「推測」「未確認」はそう書く。v3 で足した確かめはコードを読んだ物だけで、実機・利用枠を使う確かめは足していない（§2 は v2 のまま）。

### 版の履歴

| 版 | 日 | 内容 |
|---|---|---|
| v1 | — | 初版（PR #342） |
| v2 | 2026-11-13 | レビュー反映（§9）。段 T1〜T5 を PR #343〜#348 に積んだ（main には入っていない） |
| v3 | 2026-11-18 | #428（リモコンをやめ、取り込みとプロジェクトのセッションを本線にする）に合わせた。下の表 |

v2 → v3 で変えた所（ここに無い節は v2 のまま運んだ）:

| 節 | v2 | v3 |
|---|---|---|
| §0・§3.1 | 今ある `cc-<名前>` のチャンネルをその場でプロジェクトのセッションに変える | **新しい普通のチャンネル**を作る。作るのは SIGTERM の前。失敗したら作ったチャンネルは消す |
| §3.2 | 取り込みの間の ended の知らせを差し止め、失敗したら流し直す（`ended_held`・`intercept`） | **差し止めない**。`cc-…` が在れば案内を 1 通出して完了へ移し、行は deleted |
| §3.2 | 守りは送信・［起動して続ける］・close・開き直し・［削除する］ | 守りは**送信だけ**（`CcSender` の `holds`）。チャンネルの側の守りは要らない |
| §3.4 | 生きているセッションは tmux のペインが要る | 変えない。**tmux が無い機械**では生きている物を断り、終わった物だけ取り込める（追補） |
| §3.5 | 入口は cc のチャンネルの中の `/cc take`。［取り込んで続ける］。Web は古い殻 | **どこで打っても候補から選ぶ**。［取り込んで続ける］は作らない。Web は新しい殻（札）で作り直す |
| §3.9・§4 | DB は v42。`channel_id` 1 列・`ended_held` | **v45 の 1 つの移行**。`confirm_channel_id`（確認を出した場所）と `target_channel_id`（行き先）を分ける。step に `channel` |
| §4 | 符号 `channel_busy`・`channel_changed`・`no_category` | 3 つを消し `no_channel` を足す。断る文は terminal-handover.md §3.5 の表 |
| §5 | 段 T1〜T5 | 段 H1（a〜c）・H2・H3。v2 の §5.1〜§5.7 は記録として残す |
| §8 | 未決 8 件 | 消えた物・決まった物を分け、オーナーに訊く事は 3 件 |

## 0. 目的と結論

**何のために**: 端末（tmux）で進めていた Claude Code の会話を、席を離れた後もスマートフォンの Discord・Web から「同じ会話の続き」として進めたい。端末を外から操作するリモコン（CC1〜CC14）はやめる方向なので（#428）、端末の会話を続ける口は取り込みだけになる。取り込みは、会話の記録を self-agent のプロジェクトのセッション（U1）が SDK の `resume` で引き継ぎ、以後は普通の話題として動かす。

**結論**
- 取り込み先は **新しい普通のチャンネル**（`/new project:` と同じ形の話題）。題名は端末のセッションの名前。チャンネルは **SIGTERM の前**に作り、作れなければ取り込まない（端末はそのまま）。その後で失敗したら、作ったチャンネルは消す。
- 端末の claude は **SIGTERM** で終わらせる。生きているセッションは tmux の中・待機中だけ。終わったセッションも同じ手順で取り込め（tmux は要らない）、やり直しの口を兼ねる。
- 記録は Bot の `CLAUDE_CONFIG_DIR` へ **コピー**する（session_id は同じ。端末側とはそこで分岐）。
- 取り込んだ会話には **PROJECT_APPEND が入らない**（probe）。最初のターンの発言の前に 1 回だけ「前置き」を付ける。許可のモードは端末の plan・acceptEdits をそのまま引き継ぎ、ほかは default（H4b）。
- 入口は `/cc take`（どこで打っても候補から選ぶ → 確認のボタン）と、Web の札の［取り込む］。SDK のツールは作らない。DB は表 1 つ（移行 1 つ）。環境変数は足さない。逆向き（端末へ戻す）は U3。
- 今ある `cc-…` のチャンネルは変えない。取り込んだセッションに在れば「続きは新しいチャンネルで」を 1 通出して完了へ移す（リモコンを消すまでの間だけの道）。

決まっている前提（#341・#428。再検討しない）: `/clear` は貼らずプロセスを終わらせる / 待機中だけ / `SELF_AGENT_WORKSPACE_DIR` の直下のプロジェクトだけ / tmux の外の生きているセッションは終わらせない / 取り込み先は新しい普通のチャンネル。

## 1. 確認した事実

### 1.1 確認（コード。main 85e173f）（v2 のまま。その後の main で変わった所と v3 で足した事実は §1.3）

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
15. マイグレーションは配列の位置で番号が決まる（v2 を書いた時点の main の最後は v41。今は v44 で、この表は v45。§3.9）。`sessions.origin` は CHECK があり、値を足すには表の作り直しが要る。
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

### 1.3 v3 で足した事実（コード。main 3f783a2）

1. 発言の振り分けは `sessions` に行があり、削除済みでなく、同じサーバーのチャンネルだけを話題として受ける。**行の無いチャンネルの発言は黙って捨てる**。scheduler の再同期（`reconcileGuild`）も `sessions` の行から引くので、行の無いチャンネルには触らない。→ 作ったばかりで `sessions` の行がまだ無いチャンネルは、何も起こさない。
2. `/new` の本体 `createTopicSession`（`app/session-ops.ts`）は、/setup の確認 → 進行中のカテゴリ（`findStateCategory`）→ `gateway.createTextChannel`（名前 `sessionChannelName`・topic `sessionTopic`）→ `topicSessions.create` を 1 つの関数の中で続けて行う（チャンネルを作る所と行を作る所は分かれていない）。
3. Gateway に `createTextChannel`・`deleteChannel`（既に無ければ何もしない。権限・通信の失敗は投げる）がある。チャンネル名の変更は無い（v2 のまま）。
4. `CcChannels.ended()` は、その session_id の deleted でない行が無ければ何もしない。open の行は ended にして「セッションが終わりました。ここに書くと、同じディレクトリで起動して続けられます」を出し、完了へ移す。すでに ended の行にも同じ文を 1 行出す。`ccEndedHandler` はこれと `replier.ended`（追いかけを終える）を呼ぶ。
5. `cc_channels` の行を deleted にする口（`markDeleted(channelId)`）はすでにある。deleted の行のチャンネルは、発言の振り分け・［起動して続ける］・開き直し・削除の確認のどれにも当たらない（判定はどこも `state !== "deleted"`。§1.1 の 3）。
6. tmux のペインを引く口の失敗は `no_server`・`not_found`・`failed` の 3 つ。tmux の包みは絶対パスの実行ファイルが要る。**tmux の実行ファイルが無い機械で `no_server` と `failed` のどちらが返るかは未確認**（推測: `failed`）。
7. DB は v44。番号は `MIGRATIONS` の配列の位置で決まる。一度起動して版が進んだ DB は、移行の数がそれより少ないコードでは開けない。
8. 一覧から消えたセッションの行（`cc_sessions` の gone）は 30 日で消える（`CC_SESSION_KEEP_DAYS`）。終わったセッションを取り込めるのはその間。
9. Web の話題を作る API（`/api/topics`）は、サーバーを「指定があればそれ、無ければ許可したサーバーのうち /setup の済んだ最初の物」で決め、無ければ 409 `not_set_up`。
10. 一覧の行（registry の view）には RC の id（`bridgeSessionId`）がある（「RC で答える」の案内にリンクを足せるかは H2 で見る）。

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

段の名前の読み替え（v3）: 「T3b の後」「T3b の実機確認」は **H2 の実機の確かめ**、「T4」は H2 の後の追補、M1 の手順 5（R6）は §8 の「オーナーに訊く事」の 3。表の中身（確かめた結果・倒し方）は v2 のまま。

## 3. 案の比較と決定

### 3.1 取り込み先のチャンネル（v3 で書き直した）

**どこへ取り込むか**は #428 でオーナーが決めた（決定 2）: 新しい普通のチャンネル。v2 の比較（その場で変える案は Web の履歴が続くが、リモコンのチャンネルが残る前提だった）は、変える元が消える側になったので成り立たない。失う物は `cc-…` の中の履歴との地続きで、**新しいチャンネルは空から始まる**（前の会話は self-agent が覚えているが、画面には出ない。完了の文に 1 行書く）。

残る論点は 2 つ。

**(1) いつチャンネルを作るか**

| 観点 | (a) 確認を出すとき | **(b) ［取り込む］の後・SIGTERM の前** | (c) 記録を写した後 |
|---|---|---|---|
| 作れなければ取り込まない（端末はそのまま） | ◎ | ◎ | ✗ 端末を終わらせた後に作れない事がある |
| やめる・失効のたびに空のチャンネルが残らない | ✗ 毎回残るか消す | ◎ | ◎ |
| 実装コスト | △ 失効の片付けが増える | ○ step を 1 つ足す | ○ |
| 運用コスト | △ | ◎ | △ 失敗がやり直しの効かない側で起きる |

**決定: (b)。** step `channel` を check と term の間に足す（§4）。

- `/new` と同じキュー（`layoutQueueKey`）の中で、進行中のカテゴリの解決と Discord のチャンネルの作成を行う。期限は 15 秒。作れなければ `no_channel`（端末はそのまま）。
- **`sessions` の行は commit まで作らない**。その間のチャンネルは、発言しても何も起こらない（§1.3 の 1）。作る道具は `createTopicSession` の前半を切り出した `createTopicChannel`（/setup の確認・カテゴリ・チャンネルの作成まで。行は作らない）。`createTopicSession` はそれを呼ぶ形にし、振る舞いは変えない。
- 作ったらすぐ `cc_takeovers.target_channel_id` に書く（落ちても、どのチャンネルを作ったかが DB に残る）。書く口が false を返した（行が実行中でない・行き先がもう在る）ときは DB に残らないので、その場で消し、消せなければ log にチャンネル ID を出す（`/new` が DB の保存に失敗したときと同じ）。書く口が例外を出した（UNIQUE＝別の行の行き先かもしれない・DB の失敗）ときは**消さずに**、手で消せるよう log にチャンネル ID を出して `internal` にする。
- 作成の要求を出してから行き先を書くまでの間にプロセスごと落ちると、チャンネルは残り log も出ない（Discord の返りを待つ間と、その後の同期の数行。受ける）。
- **題名**は `cc_sessions.name` を `normalizeTopicTitle` に通し、100 字で切った物。空ならプロジェクトの名前。名前・topic・カテゴリは `/new project:<名前>` と同じ（`sessionChannelName`・`sessionTopic(題名, undefined, プロジェクト)`・進行中）。

**(2) チャンネルを作った後に失敗したら、そのチャンネルをどうするか**

| 観点 | **(a) 消す** | (b) 普通の話題として残す（空のプロジェクトのセッションにする） | (c) 完了へ移して残す |
|---|---|---|---|
| やり直しのたびにチャンネルが増えない | ◎ | ✗ 失敗の数だけ空の話題が増える | ✗ 同左（完了に溜まる） |
| 残った物の意味が分かる | ◎ 何も残らない | △ 端末の続きに見えるが、続きではない | △ `sessions` の行の無いチャンネルが残る |
| 実装コスト | ○ 消す・消せないときの覚え | △ 行を作る道がもう 1 本 | △ 行の無いチャンネルの移動は今の口に無い |
| 運用コスト | ○ 消せなかった物だけ手で消す | ✗ 手で閉じる | △ 手で消す |

**決定: (a)。**

- 消すのは、**その取り込みが作り、まだ `sessions` の行が無いチャンネルだけ**（`target_channel_id` に在り、取り込みが done でない）。`gateway.deleteChannel` で消し、消せたら `target_channel_id` を空に戻す。
- 消せなかったら `target_channel_id` を失敗の行に残し、log にチャンネル ID を出す（CLAUDE.md の「作ったチャンネルの ID は手で消せるよう出してよい」の例外と同じ扱い）。起動のたびに 1 回ずつ消し直す（§3.4 の「落ちたとき」。Unknown Channel は消せた扱いなので、手で消されていれば片付く）。
- 期限（15 秒）の後に遅れて作成が返ったら、そのチャンネルもその場で消す（消せなければ log にチャンネル ID だけ。DB には残らない）。
- 作ってから消すまでの間にオーナーがそのチャンネルに書いた発言は、どこにも届かず一緒に消える（数秒〜十数秒の間。受け入れる）。

### 3.2 リモコン側の行と、終了の知らせ（v3 で書き直した）

リモコンを消すまで（X1〜X3）の間だけ要る節。取り込むセッションに `cc-…` のチャンネルが在るとき、SIGTERM で一覧から消えると、リモコンが「セッションが終わりました。ここに書くと、同じディレクトリで起動して続けられます」を出して完了へ移す（§1.3 の 4）。

| 観点 | (A) v2 のまま差し止める（`ended_held`・`intercept`・流し直し） | **(B) 差し止めない。後始末で案内を 1 通足す** | (C) SIGTERM の前に黙って ended にしておく |
|---|---|---|---|
| `cc-…` に出る文 | ◎ 案内の 1 通だけ | △ 「終わりました」と案内の 2 通 | ○ 案内だけ（失敗したときは何も出ない） |
| 失敗したときの整合 | ○ 流し直しが要る（再起動をまたぐ印が要る） | ◎ 普段の ended のまま。何もしなくてよい | ✗ 端末が生きているのに ended の行が残りうる |
| 消える側（`cc/channels.ts`）に足すコード | ✗ ended の受け口・流し直し・守り | ◎ 無し | △ 状態を先に変える口 |
| 実装コスト | ✗ 列・ストア 3 関数・本体 2 関数・テスト十数件 | ◎ | △ |
| 運用コスト | ○ | ○ 2 通になるのは X3 まで | △ |

**決定: (B)。** リモコンは消える側なので、そこに新しい仕組みを足さない。失敗したときは普段どおりの終わったチャンネルになり、［起動して続ける］（同じディレクトリで**新しい**会話）も今までどおり使える。

**成功したとき（後始末で。`cc-…` が在るときだけ）**
- その session_id の `cc_channels` の行が open か ended なら、**deleted にする**（今ある `markDeleted`。行の状態を読んでから deleted にするまで await を挟まない）。続けて案内を 1 通出し、完了へ移す（`enqueueMove`。すでに完了に在れば何も起きない）。
  - 案内の文: 「この会話は self-agent が取り込みました。続きは <#新しいチャンネル> で。このチャンネルに書いても届きません。」
  - deleted にする理由: ended のままだと、そこへの発言に［起動して続ける］が出て、同じ session_id が一覧に戻ると開き直る。deleted なら今ある判定だけでどれも止まる（§1.3 の 5）。チャンネルは完了カテゴリに残る（消すのはオーナーが手で）。#system に削除の確認が出ていても、その文は書き換えない（deleted の行の確認を押したときの返事は今の `cc:del` のまま。H2 のテストで確かめた: ［削除する］・［残す］のどちらも「すでに処理済みです」に書き換えてボタンを外すだけで、チャンネルは消さず、行も変えない）。
- 行が resuming（［起動して続ける］の途中）なら**触らない**。そのチャンネルは新しい claude のチャンネルとして続く。
- 追いかけ（`follow`）は止めない（`replier.ended` が普段どおり終える）。追いかけ先への 1 行は出さない。
- 一覧に遅れて ended が来ても、deleted の行には何も出ない（§1.3 の 4）。

**取り込みの前に断る**（共存の間だけ。文は「今の操作が済んでから取り込めます」）: そのセッションに `cc_sends` の届け待ち（awaiting_confirm・queued・delivering）が 1 件でもある / `cc_permissions` に pending がある。成功しても `cc_sends`・`cc_permissions` の行は触らない。

**running の間の守り**（`start(id)` の直後から done / failed まで。DB の `runningFor` で見る）
- **送信だけ止める**。`CcSender.submit`・`propose` は、送り先の確かめを await した**後**の「行を作るまで await しない」区間で見て `taking_over` で断る。`confirm`（［送る］）も断る。`attempt` は届けずに queued のまま戻る。理由: SIGTERM の直前に指示がペインへ届くと、指示が途中で止まる。取り込みの側の「届け待ちが無い」の確かめは `start(id)` の後に行う。
- `taking_over` の文は「取り込みの途中です。終わってから送ってください」。結果の型に値が増えるので、`already_queued` の文を出している所の全部に足す（§5 の H1b）。
- **チャンネルの側の守りは要らない**（v2 の `holdsChannel`・`channel_busy`・`channel_changed`・条件付きの commit）。取り込みは `cc-…` の行を成功の後始末でしか変えず、その 1 箇所は同期で状態を見てから変える。
- 起動（`cc_start`・Web の起動）は止めない。新しい claude は別の session_id で、取り込みの対象にならない。

**X の段で外す物**（共存の間だけの依存。§5 の一覧）: `cc_channels` の行を deleted にする後始末と案内、`cc_sends`・`cc_permissions` の確かめ、`CcSender` の `holds` と `taking_over` の文。

取り込んだ後に端末で同じ会話を resume した場合は §7 の 3。

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

- **生きているセッションの条件**: 今読んだ一覧で interactive・idle・信頼の確認待ちでない・保留の許可が無い・**tmux のペインが引けて `probePaneState` が idle**。tmux の外は断る（/exit の後の取り込みで拾える）。ペインを撮れなければ `tmux_failed`。 **追補（v3）**: tmux を必須にしない。ペインを引く口・撮る口は本体の省ける依存にし、渡されなければ（tmux の無い機械）生きているセッションはすべて `not_in_tmux` で断る。引く口が `no_server`（tmux のサーバーが動いていない）を返したときも `not_in_tmux`、ほかの失敗は `tmux_failed`。
- **「今読んだ一覧」**: `t0 = now()` → `await registry.tick()` → `snapshot()` が `stale === false`・`unreadable === false`・`fetchedAt >= t0`。満たさなければ `list_failed`（終わったセッションの取り込みでも同じ。「一覧に無い」を古い一覧で言わない）。
- **cwd の形**: 名前は `takeoverProjectName(cwd, workspaceDir)`（`cc/channels.ts` の `resumeProject` と同じ中身。あちらは import しない）。`checkSessionProject(名前)` を通し、さらに**端末の cwd（末尾の / を除く）が runner の cwd（`verifiedProjectDir(名前)`）と同じ文字列**のときだけ取り込む。違えば `outside_workspace`（作業場所が symlink 越しなど。probe で確かめたのは同じ形だけ）。
- **相手の確かめ**（signal の直前に全部。1 つでも欠ければ `identity`。signal は送らない）:
  1. 今読んだ一覧にその session_id があり、pid が最初の確かめと同じで、interactive・idle。
  2. `sessionFile(pid, sessionId)` が返る。
  3. `/proc/<pid>/stat` の comm が `claude`・state が R・S・D のどれか（Z のほか、止まっている T・t も落とす。SIGTERM が保留され、後で fg した瞬間に死ぬ）・starttime が最初の確かめと同じ。`sessions/<pid>.json` に `procStart` があれば、starttime と文字列で一致すること（実機の 2.1.288・2.1.321 で一致を確認。無い版は 4 だけ）。
  4. プロセスの開始（`/proc/stat` の btime × 1000 + starttime × 10 ミリ秒）が、一覧の `startedAt` + 2 秒以下。使い回された pid のプロセスは `startedAt` より後に始まっているので落ちる。`startedAt`・btime が読めなければ落とす。
  5. pid が 1 より大きく、自分でなく、**自分の祖先でも子孫でもない**。祖先は pid 1 に着くまでたどる（8 段で打ち切らない。1,024 段を超える・途中で読めないなら落とす）。
- **直前の競合**: 最初の確かめで記録の大きさを覚える → 2 秒おく → 一覧を読み直し、ペインを撮り直し、**記録の増えた分に `user`・`assistant` の行が無い**ことを見る（あれば `changed`。大きさ・mtime は比べない。§1.1 の 7）→ 相手の確かめ → すぐ SIGTERM。終了の後にもう一度増えた分を見て、あれば `interrupted` を立て、完了の文に 1 行足す。
- **終了の確かめ**: `/proc/<pid>` が消える（か starttime が変わる）のを 250 ms ごとに 10 秒まで待つ。**消えたことが根拠**。その後に一覧を 1 回読む（registry に追いつかせるだけ。読めなくても進む）。消えなければ `not_exited`。**SIGTERM は取り消せない**ので、後から終わることがある（普通の ended になる）。 v3 では tmux の有無によらず、根拠は `/proc` だけ（ペインがシェルに戻った事は見ない）。
- **終了の前に済ませる**（v3 で直した）: プロジェクトの検証・元の記録の検査・写し先の用意・**新しいチャンネルの作成**（/new と同じ `layoutQueueKey` のキューの中で、進行中のカテゴリの解決とチャンネルの作成。カテゴリが無ければここで作られ、失敗しても残る。§3.1）。チャンネルを作るのに時間がかかるので、2 秒おいての確かめ直しはその後に行い、確かめ直しから SIGTERM までの間に通信を挟まない。
- **落ちたとき**（v3 で直した。起動時の片付けは 2 段のまま）: 前段（DB だけ。registry の最初の読みと操作の受け付けより前）で、running の取り込みを failed（`restart`）にする。後段（Gateway が使えるようになってから）で、前段が失敗にした行の確認の文を書き換え、**failed の行に残った行き先のチャンネルを消し**（§3.1）、後始末の済んでいない done の行の後始末をやり直す。流し直す ended は無い（§3.2）。registry がまだ終了を見ていなかったものは、最初の読みが普通に ended にする。どちらも `/cc take` をもう一度。
- **終わったセッションの取り込み**: 今読んだ一覧に無い・`cc_sessions` に gone の行がある・cwd の形が合う・元の記録がある、が条件。手順は終了を飛ばすだけ。 tmux は要らない（v3）。「終わった」の根拠は、今読んだ一覧に無い事と `cc_sessions` の gone の 2 つで、写す直前にもう一度、一覧に戻っていない事を見る（§4 の copy）。

### 3.5 入口（v3 で書き直した。作るのは H2・H3。ここは形だけ）

比べた案（v2 のまま）: (a) `/cc take` + 確認のボタン（2 段で誤操作が少ない）/ (b) 終わったチャンネルの［取り込んで続ける］/ (c) Web のボタン / (d) SDK のツール（モデルがプロセスを止める口になり、全セッションのキャッシュが 1 回外れる）。

**決定: (a) と (c)。(b) は作らない**（載せる先の案内が消える側）。**(d) は作らない。**

**本体の口**（入口によらず同じ。H1b）
- `takeable()`: 一覧を 1 回読み、取り込める物（待機の物と、終わった物）を返す。順は「待機（最後の活動の新しい順）→ 終わった物（終わった時刻の新しい順）」。各行は session_id・題名・プロジェクト・生きているか・時刻（待機は最後の活動、終わった物は終わった時刻。分からなければ無し）。
- `propose({ sessionId, entry, guildId, confirmChannelId })`: 条件を見て、確認待ちの行と確認の文を返す。`entry` が web なら `confirmChannelId` は渡さない。行き先はまだ作らない。
- `confirm(id)`・`cancel(id)`・`expire()`（10 分。1 分ごと）。
- 対象の session_id は、入口が出した候補の値（セレクトの値・API のパス）で受けるが、**本体が一覧と `cc_sessions` で引き直して確かめる**（§3.9）。一覧にも `cc_sessions` にも無い session_id（細工した値・古い候補）は、場所のせいにせず `identity` で断る（`cc_sessions` に行が在って cwd が無い物は `outside_workspace` のまま）。

**Discord（H2）**
- `/cc take`（引数なし）は**どのチャンネルで打っても**同じ: `takeable()` の候補をセレクト（`cc:takepick`。25 件まで）で本人にだけ出す。候補が無ければ「取り込めるセッションがありません（実行中 N・判断待ち M）。」を本人にだけ。
- 選ぶと `propose` → **打ったチャンネルに**確認の文とボタン（`cc:take:go:<id>`・`cc:take:no:<id>`）を出し、その投稿を行に書く（`confirm_channel_id`・`confirm_message_id`）。出せなければ確認をやめる。
- ボタンの照合: id の行が在る / `entry` が discord / state が awaiting_confirm / 押されたチャンネルが `confirm_channel_id` と同じ / 押した人がオーナー。どれか欠ければ「この確認はもう使えません。」。
- ［取り込む］の結果は確認の文を書き換える: 成功は「取り込みました → <#新しいチャンネル>」、失敗は「取り込めませんでした: <文>」。10 分で失効（「取り込みの確認は期限切れです（10 分）。」）。
- 断るとき（選んだ後に状況が変わった）は、§4 の文を本人にだけ返す。
- H2 で決めた事: 候補は取り込める物（待機と終わった物）だけで、取り込めない物は出さずに「実行中 N・判断待ち M は選べません」の行で数だけ見せる（Discord のセレクトは 1 行ずつ無効にできない）。各行は 題名（空白を畳んで 100 字。空ならプロジェクト）・`待機｜終了・<プロジェクト>・<MM-DD HH:MM>`。25 件を超えたら「新しい順の 25 件です（ほか N 件）」の行を足す。判断待ちで断るときは RC のリンクがあれば次の行に足す。セレクトの 1 通は選んだ後も残る（もう一度選ぶと「取り込みの途中です」）。`/cc take` は `/setup` の有無を見ない（`/setup` 前は［取り込む］の後に `no_channel` の文）。

**Web（H3。新しい殻だけ）**
- 一覧の端末の行を押すと札。取り込めるときは［取り込む］、取り込めないときは §4 の文。確認は `SA.ask`（文は Discord と同じ）。
- 確認の形（H3 で作った）: danger の確認で、最初の焦点は［やめる］。本文はサーバーの文、対象は札の題。やめたら `/cancel` だけ、進めたら `/confirm` だけを送る。進めた応答が切れた・5xx のときは結果が分からない形にして、1.5 秒・5 秒・15 秒で判定を読み直し、`last` の番号が合えば済んだ・失敗・始まっていないを決める（実行中・分からないはそのまま。［確かめ直す］）。済んだら知らせを出し、札が出ていればその新しい話題を開く。進めた後の失敗（断られた・読み直しで失敗か始まっていないと分かった）は札の文にし、そのとき札を出していなければ失敗の知らせも出す（文は、札に戻って開いたときの読み直しでは消さない）。`last` の番号が自分の番号より新しければ（後から別の取り込みが作られた）、分からない形を解いて今の判定を見せる。
- API は 4 つ（H3 の API で決めた形）: `GET /api/cc/sessions/<id>/takeover`（判定を読む。本体の `check` で、`propose` と同じ判定。行を作らない。200 `{ takeable, state, reason, text, title, project, activityAt, rcUrl, last }`。`text` は理由だけの文、`state` は `idle`・`running`・`waiting`・`ended`・`unknown`）・`POST /api/cc/sessions/<id>/takeover`（確認待ちの行を作る。201 `{ id, text }`）・`POST /api/cc/takeovers/<番号>/confirm`（200 `{ ok, id, text }`。**`id` は新しい話題の `ch:<channelId>`** で、画面はそこへ移る）・`POST /api/cc/takeovers/<番号>/cancel`（200 `{ ok }`）。断り・失効・失敗は 409 `{ error, text }`、もう使えない確認は 409 `stale`（文は Discord と同じ「この確認はもう使えません。」）、番号が数字でなければ 400、形の違う session_id・無い番号・配線が無ければ 404。
- `last` はその session_id の一番新しい取り込み（`{ takeover, state, id }`。`id` は done で行き先が在るときだけ `ch:<channelId>`）。応答が届かなかったときに読み直して、済んでいれば新しい話題へ移る。
- 自分（Web）の確認待ちが残っていれば、GET は取り込めると見て、確認を作る POST がそれを取り消して作り直す（画面を閉じた・切れた後に 10 分待たせない）。Discord の確認待ち・実行中の行は取り消さない（`in_progress`）。
- サーバーは `/api/topics` と同じ決め方（§1.3 の 9）。無ければ 409 `not_set_up`。
- **Web から始めた確認は Discord に出さない**（`confirm_channel_id` は空）。確認は Web の 1 枚で完結し、Discord に見えるのは結果（新しいチャンネルの最初の投稿）だけ。confirm・cancel の API は `entry` が web の行だけを受ける（Discord の確認を Web から進めない。逆も）。

比べた案（Web から始めた確認を Discord のどこに出すか）:

| 観点 | **出さない** | #system に出す | 新しいチャンネルを先に作ってそこに出す |
|---|---|---|---|
| 確認が 2 箇所に出て食い違わない | ◎ | △ 片方で進めたらもう片方を書き換える | △ |
| やめたときに物が残らない | ◎ | ○ 1 通残る | ✗ チャンネルが残る（§3.1 の (a)） |
| 実装コスト・運用コスト | ◎ | △ | ✗ |

### 3.6 取り込んだセッションの形

（v2 のまま。読み替え: 「そのチャンネル」は**行き先の新しいチャンネル**で、取り込みの行は `target_channel_id` で引く。「U2」「/mode」は terminal-handover.md の段 H4b。H4a・H4b の後に、前置きの「AskUserQuestion は使えません」とモードの引き継ぎを直す。）

- `sessions`: state active・origin `command`（CHECK を変えない。出どころは `cc_takeovers`）・persona は既定・`project_dir` はプロジェクトの名前。
- **`permission_mode` は端末の plan・acceptEdits をそのまま引き継ぎ、ほか（default・auto・bypassPermissions・不明）は default**（`mapTakeoverMode`。propose で `cc_takeovers.permission_mode` に置き、commit で `sessions` に写す）。H4b で /mode が入り、取り込んだ後でも戻せるようになったので引き継ぐ（未決 6）。確認の文に「許可のモードは <引き継ぐモード> になります（端末: <端末のモード>）」と書く。端末のモードは `cc_takeovers.terminal_mode` に残す。端末のモードは最後に受けた hook の値（`cc_sessions.permission_mode`）で、終わったセッションでも行に残っていれば引き継ぐ。hook を一度も受けていなければ不明で default。H4b の前に作られて確認待ちのまま残っていた行は、行の値（default）のまま進む。
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

`turn.ts` が SDK セッションを捨てるのは 1 箇所で、理由は 3 つ（画像の拒否・`No conversation found`・連続失敗。§1.1 の 8）。今は黙って新しい会話になる。その直前で、捨てる session_id がそのチャンネルの取り込んだものと同じなら、チャンネルに 1 回だけ知らせる:「取り込んだ会話を続けられなくなったため、新しい会話として続けます。元の会話は端末で claude --resume で開けます。」。/renew が要約を取ってから捨てる場合（成功）は /renew の返事があるので足さない。/renew が会話の記録が無くて捨てる場合は、同じ知らせを出す（§9.5）。話題の場所の付け替え（`app/topic-move.ts`）が要点なしで付け替える場合（記録が無い・今の場所が使えない）も、付け替えが通った後に同じ知らせを出す（H2 で決めた。要点が取れた場合は /renew の成功と同じで足さない）。

### 3.7 進行状況（#338）との関係

- **DB**: どちらも配列の末尾に足すので、番号は入った順（main は v44。取り込みが先なら v45、#338 が先に入れば取り込みは 1 つ後ろにずれる。後から入る方が rebase して合わせる）。表・列は重ならない。マージ前の枝を本番の DB で動かさない。
- **分類**: 取り込むと CC のセッションが 1 つ減り、プロジェクトのセッションが 1 つ増える（二重には数えない）。待機しているプロジェクトのセッションを「オーナーの番」に数えるかは #338 の側の課題（terminal-handover.md §5.1 の「ほかの未決」）。

### 3.8 逆向き（Discord のセッションを端末へ戻す）

**決定: 範囲外。置き場所は U3。** コピーの形では Bot 側の記録を `~/.claude` へ書き戻すことになり、「`~/.claude` に書かない」線を越える。`projects` を共有すれば（P5）写さずに端末の `claude --resume` で続きが読め、それが U3。起動の口（`buildClaudeCommand`）に `--resume` も無い。U3 に渡す材料: P5・同時に書かない守り・自動メモリの場所。

### 3.9 DB・環境変数・安全（v3 で書き直した）

**DB**: 表 `cc_takeovers` を **1 つの移行**で足す（v45。#338 が先に入れば 1 つ後ろ）。v2 の v42 と、それを後から直した分（T1b）と、v3 の列の入れ替えを全部まとめた形。`sessions`・`cc_channels`・`cc_sessions` の定義は変えない。本文は置かない。**H2・H3 で 2 本目の移行は要らない**（確認の投稿・行き先・Web の入口の列は最初から在る）。入れる前に、本番の DB に同じ名前の表が無い事を読み取り専用で確かめる（terminal-handover.md §3.4 の 7）。

確認を出した場所と行き先を、どう持つか:

| 観点 | (A) `channel_id` 1 列（確認の間は出した場所、作った後は行き先に書き換える） | **(B) 2 列に分ける（`confirm_channel_id`・`target_channel_id`）** | (C) `channel_id` は出した場所。行き先は `channel_sessions` を session_id で引く |
|---|---|---|---|
| ボタンの照合（出した場所） | △ 作った後は照合できない（確認の文の書き換えにも要る） | ◎ | ◎ |
| 前置き・失敗の片付け（行き先） | △ 状態で意味が変わる | ◎ 列で引ける | ✗ commit の前の行き先を覚える所が無い |
| Web の入口（出した場所が無い） | ✗ NOT NULL に入れる値が無い | ◎ NULL | △ |
| 実装コスト | ○ | ○ | △ |

**決定: (B)。**

| 列 | 型・制約 | 意味 |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | ボタン・API の番号 |
| `session_id` | TEXT NOT NULL | 取り込む会話 |
| `source` | TEXT NOT NULL。`alive`・`ended` | 確認のとき生きていたか |
| `project` | TEXT NOT NULL | 作業場所の直下の名前 |
| `guild_id` | TEXT NOT NULL | **行き先のチャンネルを作るサーバー**（Discord は打ったサーバー、Web は §3.5 の決め方） |
| `entry` | TEXT NOT NULL。`discord`・`web` | 入口 |
| `confirm_channel_id` | TEXT（NULL 可） | **確認を出した Discord のチャンネル**。`entry` が discord のときだけ入る |
| `confirm_message_id` | TEXT（NULL 可） | 確認の投稿（出した後に入る） |
| `target_channel_id` | TEXT（NULL 可） | **行き先**（新しいチャンネル）。step `channel` で作った直後に入る。失敗して消せたら NULL に戻す |
| `state` | TEXT NOT NULL。`awaiting_confirm`・`running`・`done`・`failed`・`cancelled` | §4 |
| `step` | TEXT（NULL 可）。`check`・`channel`・`term`・`copy`・`commit` | running の間の位置 |
| `failure` | TEXT（NULL 可） | 失敗の符号（文字列のまま） |
| `permission_mode` | TEXT NOT NULL。`default`・`acceptEdits`・`plan` | 取り込んだセッションのモード（端末の plan・acceptEdits はそのまま、ほかは default） |
| `terminal_mode` | TEXT（NULL 可） | 端末のときのモード（確認の文に出す） |
| `interrupted` | INTEGER NOT NULL DEFAULT 0 | 終わらせる直前に端末で動きがあった |
| `note_pending` | INTEGER NOT NULL DEFAULT 0 | 前置きをまだ付けていない |
| `effects_at` | TEXT（NULL 可） | 後始末を済ませた時刻 |
| `created_at`・`updated_at` | TEXT NOT NULL | |
| `finished_at` | TEXT（NULL 可） | |

- 表の CHECK（3 つ）: `(entry = 'discord') = (confirm_channel_id IS NOT NULL)` / `confirm_message_id IS NULL OR confirm_channel_id IS NOT NULL` / `state <> 'done' OR target_channel_id IS NOT NULL`。
- index（2 つ）: `cc_takeovers_active` = `session_id` の一意（`state IN ('awaiting_confirm','running')` の行だけ。同じ会話に確認待ち・実行中は 1 つ）/ `cc_takeovers_target` = `target_channel_id` の一意（NULL でない行だけ。前置き・片付けはここで引く）。
- v2 から消す物: `channel_id`・`ended_held`・index `cc_takeovers_channel`。
- **ボタンの照合**（`cc:take:go|no:<id>`）: id で行を引き、`entry`・state・`confirm_channel_id` を見る（§3.5）。index は要らない（主キー）。
- **前置き**（§3.6.1）の「そのチャンネルの取り込み」は `target_channel_id` で引く。

**環境変数**: 足さない。`SELF_AGENT_CC=1` で、プロジェクトのセッションの準備（`ProjectSessionGate.ready`）ができているときだけ動く。

**安全**
- オーナーだけ（`/cc` の既存の確かめ）。ボタンは押した人・チャンネル・state を確かめる。Web は `Tailscale-User-Login`。
- 入口から受けるのは session_id（UUID の形だけ）と取り込みの番号だけ。**cwd・pid・名前・パスは一覧と `cc_sessions` から引き、入力の文字列から取らない**。signal は SIGTERM だけ・1 つの pid だけ・§3.4 の確かめを通ったときだけ。
- 消すチャンネルは、その取り込みが作って `target_channel_id` に書いた物だけ。`sessions` に行のあるチャンネルは消さない（§3.1）。
- ログに session_id・pid・cwd・名前・パス・本文を出さない（理由の符号と段だけ）。チャンネル ID は、消せなかった行き先のチャンネルのときだけ出す（§3.1）。
- 書く先は `CLAUDE_CONFIG_DIR` の中だけ。`~/.claude` には書かない。

## 4. 手順と状態遷移（v3 で書き直した）

流れ: 選ぶ → 確認 → ［取り込む］→ 相手の条件の確かめ → **新しいチャンネルを作る** → （生きていれば）確かめ直して SIGTERM → 記録を写す → DB を切り替える → 後始末 → 新しいチャンネルの最初の発言が resume の最初のターン（前置き付き）。

`cc_takeovers.state` の遷移:

| から | きっかけ | へ | 行き先のチャンネル |
|---|---|---|---|
| （無し） | `propose`（選んだ・Web の［取り込む］） | awaiting_confirm | 無い |
| awaiting_confirm | ［やめる］・10 分 | cancelled | 無い |
| awaiting_confirm | ［取り込む］ | running（step check） | 無い |
| running | step `channel` が済む | running | **在る**（`sessions` の行はまだ無い。発言は届かない） |
| running | commit | done（`note_pending = 1`） | 在る（普通の話題になる） |
| running | 失敗 | failed | **消す**。消せたら `target_channel_id` を空に。消せなければ残し、起動時にもう一度 |
| running | 再起動 | failed（`restart`） | 同上（起動時の後段で消す） |

running の間の step:

| step | すること | 失敗したとき（端末 / 行き先） |
|---|---|---|
| check | `start(id)` → 一覧を読む（§3.4）→ §3.2・§3.4 の条件（届け待ち・保留の許可はここで見る）→ 確認のときと生死・プロジェクトが同じ → cwd の形 → 元の記録の検査と大きさの記憶 → 生きていれば最初の `/proc/<pid>/stat` → 写し先の用意 | 端末はそのまま / まだ無い |
| channel | `/new` と同じキューの中で、進行中のカテゴリの解決と新しいチャンネルの作成（期限 15 秒）→ `target_channel_id` に書く | `no_channel`。端末はそのまま / 無い（遅れてできた物は消す） |
| （channel の続き。生きているときだけ） | 2 秒おいて、一覧・ペイン・記録の増えた分を確かめ直す | `changed` など。端末はそのまま / 消す |
| term（生きているときだけ） | 相手の確かめ → SIGTERM → `/proc/<pid>` が消えるまで待つ → 一覧を 1 回読む → 増えた分を見る | 確かめで落ちた: `identity`（signal なし）。消えない: `not_exited`（signal は送った）/ 消す |
| copy | 終わったセッションなら一覧を 1 回読み直して戻っていない事 → 記録を写す（同じ実体なら写さない） | `copy_failed`・`already_taken`・`changed`。生きていた物は端末が終わっている（終わった会話として取り込み直せる）/ 消す |
| commit | `BEGIN IMMEDIATE` の 1 つのトランザクション: `sessions` の行（行き先の channel_id・state active・origin `command`・`project_dir`・`permission_mode` は取り込みの行の値）→ `channel_sessions` に（行き先の channel_id, session_id）→ 取り込みを done（`note_pending = 1`）。内側に BEGIN のある操作は呼ばない | 巻き戻して `copy_failed` / 消す |
| （後始末。失敗しても done） | 新しいチャンネルに完了の文・Web の履歴に区切りと知らせ → `cc-…` が在れば deleted・案内・完了へ（§3.2）→ Discord の入口なら確認の文を書き換える → `effects_at` | 起動時に、`effects_at` が空の done の行をやり直す（完了の文がまれに 2 回出るのは受け入れる。行き先の `sessions` の行が無ければ済みにするだけ）。`cc-…` を deleted にした後・案内と完了への移動の前に落ちると、やり直しでは案内も移動も出ない（二重に出さない方を取った。受ける） |

v2 と違う所: step `channel` が増えた / commit は `cc_channels` に触らず、`stopFollow` も呼ばない / 進行中への移動と topic の書き換えは要らない（最初からその形で作る）/ 差し止めた ended の流し直しは無い。

**失敗の符号と文**（Discord は確認の文を `取り込めませんでした: <文>` に書き換える。Web は 409 の `text`。**SIGTERM を送った後**の失敗は、`not_exited` を除き「端末の Claude Code は終了しています。もう一度取り込むと、終わった会話から取り込めます。」を足す）:

- SIGTERM を送った後・終了を見届ける前の例外は、言い切らずに「終了しているかもしれません」の側の文（`TAKEOVER_MAYBE_TERM_TEXT`。再起動の restart と同じ）を足す（符号は `copy_failed`）。
- 終わったセッションも、写す前（copy の直前）に一覧を 1 回読み直す（チャンネルの作成の間に端末で resume されたものに気づく。読めなければ手元の一覧で確かめて進む）。

取り込めないときの文（terminal-handover.md §3.5 の表のまま。候補を選んだ後・札・確認の後のどこでも同じ文）:

| 状況 | 符号 | 文 |
|---|---|---|
| 実行中 | `busy` | 実行中です。終わると取り込めます |
| 判断待ち（一覧の状態） | `waiting` | 判断待ちです。端末か RC で答えると取り込めます |
| tmux の外で生きている（tmux の無い機械を含む） | `not_in_tmux` | このセッションは外から終わらせません。終わらせてから取り込めます |
| 場所が作業場所の直下でない・cwd の形が違う | `outside_workspace` | この場所のセッションは取り込めません |
| 届け待ちの送信がある・self-agent が保留している許可がある（共存の間だけ） | `queued` | 今の操作が済んでから取り込めます |

v3 で足した・変えた符号:

| 符号 | 文 |
|---|---|
| `no_channel`（`no_category` を置き換える） | 新しいチャンネルを作れませんでした（/setup が済んでいるか確かめてください）。端末の Claude Code はそのままです |
| `channel_busy`・`channel_changed` | 消す（§3.2） |

ほかの符号（`not_ready`・`list_failed`・`target_invalid`・`tmux_failed`・`pane`・`already_taken`・`in_progress`・`no_transcript`・`too_large`・`changed`・`identity`・`not_exited`・`copy_failed`・`internal`・`restart`）の文は v2 のまま（`cc/takeover-rules.ts` の `FAILURE_TEXTS`）。

確認の文: 「「<題名>」（<プロジェクト>）を取り込みます。端末の Claude Code は終了し、続きは新しいチャンネルで self-agent が引き継ぎます。許可のモードは <引き継ぐモード> になります（端末: <端末のモード>）。モデルは self-agent の設定のものになります。」（終わったセッションは 2 文目の前半を「端末の Claude Code はすでに終わっています。」に）。

完了の文（新しいチャンネルの最初の投稿と、Web の履歴の知らせ）: 「端末の Claude Code から取り込みました。ここから先は self-agent がこの会話を続けます（<プロジェクト>・許可のモード <引き継いだモード>）。これより前の会話はここには出ませんが、self-agent は覚えています。端末で claude --resume すると取り込む前までの会話が別に開きます（ここでの続きは入りません）。」`interrupted` なら「取り込みの直前に端末で動きがありました。最後の指示は途中で止まっているかもしれません。」を足す。

確認の文の書き換え（Discord の入口。成功）: 「取り込みました → <#新しいチャンネル>」。

## 5. 段階分け（v3 で書き直した）

段の順・前提・戻し方は terminal-handover.md §4.1。ここは取り込みの中身の割りだけ。

| v3 の段 | 入る物 | v2 の段（PR）から | オーナーに見える変化 |
|---|---|---|---|
| **H1a** | 本書（v3）、DB v45、ストア、判定の純関数、記録の写し | 設計（#342）・T1・T1b（#343）を運び、列と符号を v3 に直す | なし |
| **H1b** | 本体 `CcTakeover`、`createTopicChannel` の切り出し、`CcSender` の `holds` と `taking_over` の文 | T2（#344）と、#346〜#348 が本体に足した直しを運び、行き先・後始末・失敗の片付けを v3 に直す | なし（配線しない） |
| **H1c** | 前置き（ターン側）、resume を捨てたときの知らせの口 | T3a（#345）と、#346 の `session-renew.ts`・`handler.ts` の受け渡し | なし |
| **H2** | `/cc take`（選ぶ・確認のボタン）、main の配線、起動時の片付け、失効のタイマー | T3b（#346）・T4 の `cc:takepick`（#347）を作り直す | `/cc take` が使える |
| **H3** | Web の API 3 つ、札、確認 | T5（#348）の API を運び、画面は新しい殻で作り直す | 札の［取り込む］ |
| 作らない | ［取り込んで続ける］（T4）、古い殻の画面（T5）、`cc/channels.ts` への守りと差し止め（T2） | — | — |

**H1 の順**: H1a と H1c は互いに独立で、どちらも main から切れる。H1b は両方が入ってから切る（本体はストアと規則（H1a）を使い、本物の本体をターンに渡すテスト 2 件を H1c のテストのファイルに足すため）。PR ごとの指示は実装の issue に置く。

**今は H3 まで**: H1 の 3 本と、H2 の 2 本（1 本目は main への配線。起動時の片付けの前段・後段、確認の失効のタイマーと停止、`CcSender` の `holds`、ターンの口、場所の付け替えの `resumeDropped`。2 本目は入口 `/cc take`・`cc:takepick`・`cc:take:go|no:<id>`（`app/commands/cc-take.ts`。振り分けは `app/commands/cc.ts`））。Discord から取り込める。実機の確かめ（§6 の H2）はまだ。H3 は取り込みの 4 ルート（`web/routes/cc-takeover.ts`）と札の部品 `c-term.js`、新しい殻の端末の行の札（つなぎ `takeover.js`）。実機の確かめはまだ。

停止のとき、取り込みの途中の 1 件（`CcTakeover.idle`）は停止の猶予（`SELF_AGENT_SHUTDOWN_GRACE_SEC`。既定 30 秒）の中で終わるのを待つ。待ちの sleep だけでチャンネルの作成の期限 15 秒・SIGTERM の前の間 2 秒・終了の見届け 10 秒の合計 27 秒になり、キューの待ち・写し・Discord の呼び出しを足すと猶予を超えうるので、切れたら次の起動の前段（`recoverRunning`）が失敗（restart）にする。チャンネルを作ってから行き先を行に書くまでの間に切れると、作ったチャンネルが残る（行に行き先が無いので起動時にも消せない）。

**X の段で外す物**（共存の間だけ足す、消える側への依存）:

| 物 | 足す段 | 外す段 |
|---|---|---|
| `taking_over` の文: `app/cc-tools.ts`・`app/commands/cc-confirm.ts`（［送る］） | H1b | X1（ファイルごと消える） |
| `taking_over` の文: `web/routes/cc.ts` の送信の 409 | H1b | X2（送信の API ごと消える） |
| `CcSender` の `holds` と結果の値 `taking_over`（`cc/sender.ts`）、`cc/channels.ts` の断る文の表、`app/github-handoff.ts` の失敗の文 | H1b | X3（`github-handoff.ts` の分は H5 で宛先を付け替えるときに消える） |
| 本体の `ccSends.activeFor`（届け待ちの確かめ。省ける依存） | H1b | X3 |
| 本体の `ccChannels`（`anyFor`・`markDeleted`）と `cc-…` への案内の 1 通（省ける依存） | H1b | X3 |
| 本体の `ccPermissions.pendingFor`（hook が保留している許可の確かめ。省ける依存） | H1b | X4 |

本体は消える側のファイルを **import しない**（`cc/channels.ts`・`cc/sender.ts`・`cc/replies.ts`・`cc/starter.ts`・`app/commands/cc-confirm.ts`）。v2 がそこから借りていた物（cwd からプロジェクトの名前を引く純関数・題名の正規化・確認の失効の時間）は、残る側に同じ中身を置く。

### 5.0 下の §5.1〜§5.7 の読み方

§5.1〜§5.7 は **v2 の段（T1〜T5）の細部の記録**で、運ぶコードの元の説明としてそのまま残す。次の所は v3 と食い違い、**本文（§3・§4）が優先**:

- §5.1: `ended_held`・`hold`・`releaseHeld`・`listHeld`・`runningForChannel`・`markTaken`・`channelState`・符号 `channel_busy`・`channel_changed`・`no_category`・「v42 を直接直す」→ どれも v3 には無い（§3.2・§3.9・§4）。
- §5.2: `propose({ channelId, entry })`・`ensureFor`・`holdsChannel`・`intercept`・`replayEnded`・`cc/channels.ts` への変更・［削除する］の守り → 無い。`CcSender` の `holds` は運ぶ。
- §5.5: 「cc のチャンネルの中なら」→ どこでも候補から選ぶ（§3.5）。起動時の順は §3.4 の「落ちたとき」。
- §5.6: ［取り込んで続ける］と保留した発言の流し直し → 作らない。`cc:takepick` は H2 の主の入口になる（`ensureFor` は呼ばない）。
- §5.7: `ensureFor`・古い殻の画面・「同じ `ch:<id>` のタブが開き直る」→ 無い（§3.5）。

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
- `POST /api/cc/sessions/<id>/takeover`（チャンネルが無いときだけ `ensureFor` → `propose`。entry web）・`POST /api/cc/takeovers/<id>/confirm`・`/cancel`。Discord の確認の文も同じ行を見る。
- cc の会話のタブに [取り込む] → 確認のダイアログ（§4 の文）。断られたら符号の文。done の後は同じ `ch:<id>` のタブが session の種類で開き直る。

**作ったもの（T5。§9.8）**: 3 つのルート（通れば 201 `{ id, channelId, text }`／confirm は 200 `{ ok, channelId, text }`／cancel は 200 `{ ok }`。断り・stale・expired・失敗・チャンネルを作れないは 409 `{ error, text }`。番号が数字でなければ 400、配線が無ければ 404）と、cc の会話のタブの頭の [取り込む]・確認のダイアログ `dlg-cc-take`（`chat.js`）。

## 6. 受け入れ条件（v3 で書き直した）

どの段も: `npm run check` と `npm test` が通る。ログに session_id・pid・cwd・名前が出ない。H1 の 3 本は配線しないので、オーナーに見える変化が無い（`/cc take` は無い・Web に取り込みの口は無い）。

**H1a**（一時 SQLite・一時ディレクトリ）
- v44 の DB を上げると最新の版になり、`cc_takeovers` ができる。`channel_id`・`ended_held` の列は無い。
- 同じ session_id に確認待ち・実行中の行は 2 つ作れない。`entry` が discord で `confirm_channel_id` が空・web で入っている行は作れない。`target_channel_id` が空のまま done にできない。同じ `target_channel_id` の行は 2 つ作れない。
- `setTarget` は running の行だけ・`clearTarget` は failed の行だけ変える。`takenFor`・`clearNote` は `target_channel_id` で引く。
- `takeoverRefusal`: 実行中・判断待ち・tmux の外・直下でない・届け待ち（保留の許可を含む）が、§4 の符号と文で返る。`channel_busy`・`channel_changed`・`no_category` は型に無い。
- 記録の写し・相手の確かめの純関数は、v2 のテスト（§5.1 の「テスト」）がそのまま通る。

**H1b**（偽の registry・kill・proc・Gateway、一時 SQLite）
- 待機のセッション: 新しいチャンネルが 1 つ作られ（進行中のカテゴリ・名前と topic は `/new project:` と同じ）、**その後で** kill が SIGTERM・その pid で 1 回だけ呼ばれ、`sessions` に新しい channel_id の行（`project_dir`・default）、`channel_sessions` に（新しい channel_id, 元の session_id）、取り込みが done・`note_pending = 1`・`target_channel_id` が新しい channel_id。終わったセッション（gone）は kill なしで同じ結果。
- チャンネルを作れない（/setup が無い・カテゴリの失敗・`createTextChannel` の失敗・期限）→ `no_channel` で kill は呼ばれない。期限の後に作成が返ったら、そのチャンネルに `deleteChannel` が 1 回呼ばれる。
- kill が呼ばれない: 一覧が stale・unreadable・古い（`list_failed`）/ 確かめ直しで busy・増えた分に user の行（`changed`）/ comm・starttime・開始の時刻・祖先のどれかが合わない（`identity`）/ 端末の cwd が runner の cwd と違う（`outside_workspace`）。**チャンネルを作った後の失敗では、どれも `deleteChannel` がそのチャンネルに 1 回呼ばれ、`target_channel_id` が空に戻り、`sessions` の行はできない。**
- kill の後に pid が消えない → `not_exited`。写しの失敗 → `copy_failed`。どちらもチャンネルは消える。
- `deleteChannel` が失敗 → 行は failed のまま `target_channel_id` が残り、`recoverEffects()` がもう一度 `deleteChannel` を呼ぶ。`sessions` に行のあるチャンネルには `deleteChannel` を呼ばない。
- `recoverRunning()`: running の行 → failed（`restart`）。`recoverEffects()`: 作ったチャンネルの残る failed の行は消す / done で `effects_at` が空の行は後始末を 1 回。2 回目の呼び出しでは何もしない。
- `cc-…` の行が open・ended のセッションを取り込む → 行が deleted、そのチャンネルに案内が 1 通、完了への移動が 1 回積まれる。resuming の行は変わらず、案内も出ない。`cc-…` の無いセッションでは何も出ない。`channels.ended`・`replier.ended` に手を入れていない（差し止めない）。
- 届け待ちの `cc_sends`・pending の `cc_permissions` があれば `queued` で断る。`ccChannels`・`ccSends`・`ccPermissions`・`panes`・`probePane` を渡さなくても本体が動く（生きている物は `not_in_tmux`、終わった物は取り込める）。
- running の間: `CcSender` の `submit`・`propose`・［送る］は `taking_over`、`attempt` は届けない。
- `takeable()`: 待機の物と終わった物だけが、決めた順で返る。実行中・判断待ち・直下でない・取り込み済みは入らない。
- `createTopicSession` の今あるテストがそのまま通る（切り出しで振る舞いが変わらない）。
- 本物の `CcTakeover` をターン（`TurnDeps.takeover`。H1c）に渡す: done・`note_pending = 1` の行 → 最初の resume の prompt の頭に前置き → 次のターンには付かない / SDK セッションを捨てたら、行き先のチャンネルに知らせが 1 通。
- 本体が `cc/channels.ts`・`cc/sender.ts`・`cc/replies.ts`・`cc/starter.ts`・`app/commands/cc-confirm.ts` を import していない（grep）。

**H1c**（偽の takeover）
- §3.6.1 の表の 4 行 / session_id が違えば付かない / `purpose: "close"`・予約では付かない / 新規の prompt に入らない / SDK セッションを捨てる 3 つの理由のそれぞれと、/renew が resume の失敗で会話を捨てるときに、`resumeDropped` が 1 回。
- `takeover` を渡さないとき、ターンの振る舞いは今までと同じ（今あるテストがそのまま通る）。軽いモードの `SYSTEM_PROMPT` とツールの定義が変わっていない。

**H2**（単体は済。実機の確かめはまだ）
- オーナー以外の `/cc take`・ボタンは何も起こさない。別のチャンネルから押した・Web の行の番号で押したときは「この確認はもう使えません。」。10 分後の［取り込む］は、確認の文を「取り込みの確認は期限切れです（10 分）。」に書き換えるだけ（失効した後の行のボタンは「この確認はもう使えません。」）。
- 選ぶ → 確認 → 新しいチャンネルができ、確認の文が「取り込みました → <#…>」になる。実行中・判断待ち・tmux の外・直下でない は §4 の文で断る。
- 実機（利用枠を使う。最初のターンはキャッシュが全部外れる）: 取り込むとペインがシェルに戻る / 新しいチャンネルの最初の発言に前の会話を踏まえた返事が来る / 2 通目に前置きが付かない（devlog）/ `npm run usage` の最初の行が cacheRead 0 / 書き込みで許可のカードが出る / `cc-…` が在ったセッションでは案内が 1 通出て、そこに書いても何も起きない。

**H3**
- API: 201 `{ id, text }` → confirm 200 `{ ok, channelId, text }`（`channelId` は新しい話題）→ `/api/channels` にその話題が出る。Discord に確認の投稿は出ない。Discord の行の番号では 409。
- `ui-shots`（札の 4 つの状態）。実機: スマホの幅で札 →［取り込む］→ 新しい話題へ移る。

## 7. リスク

1. **終わらせた後に取り込めない**（コピー・DB の失敗、再起動）。記録は残るので、`/cc take` で終わった会話から選んでやり直せる（v3）。
2. **版のずれ**（§1.1 の 17）。記録は内部形式なので読めなくなりうる（§3.6.3 の知らせになる）。
3. **同じ session_id が 2 つの入口にある**（取り込んだ後に端末で resume）。記録は別なので混ざらないが、`cc_permissions` の「session_id ごとに pending は 1 つ」の索引に両方が当たると片方の保留が作れない（未確認）。今は受け入れる（未決 2）。
4. **前置きが効かない・圧縮で消える**（R2）。/renew で普通のプロジェクトのセッションにできる。
5. **別のモデル・別の版が書いた記録**を読む（確かめたのは P3 の 1 例）。
6. **誤った pid への signal**。§3.4 の 5 つの確かめで守る。comm が `claude` でない・`startedAt` が開始より前になる形があれば、`identity` で断る側に倒れる。
7. **背景のタスク・MCP の子プロセス**が SIGTERM の後に残る・止まる（R6。未確認）。
8. **SIGTERM の後に終わらない**（`not_exited`）。取り消せないので、後から終わると普通の ended になる。

v3 で足した・変わった物:

9. **新しいチャンネルは空から始まる**。前の会話は self-agent が覚えているが、Discord・Web の画面には出ない（オーナーが決めた失う物。完了の文に 1 行）。困ったら端末で `claude --resume` すれば取り込む前までを読める。
10. **作ったチャンネルの消し残り**（Discord の失敗・期限の後に遅れてできた）。`sessions` の行が無いので何も起こさないが、進行中のカテゴリに空のチャンネルが見える。DB に残った物は起動時にもう一度消す。log にチャンネル ID を出すので手でも消せる。
11. **`cc-…` に 2 通出る**（「セッションが終わりました…」と案内。§3.2 の B）。リモコンを消す X3 まで。
12. **写しに失敗した後の `cc-…`** は普段の終わったチャンネルで、［起動して続ける］は新しい会話になる（会話は続かない）。続けたいときは `/cc take` で終わった会話から選ぶ。
13. **Bot が止まっていた間に終わったセッション**は `cc_sessions` に行が無く、候補に出ない（terminal-handover.md §3.3 の「残る穴」）。終わってから 30 日を過ぎた物も出ない（§1.3 の 8）。
14. **取り込みの後に同じ session_id が端末に戻る**と、リモコンが新しい `cc-…` を作りうる（X3 まで。`cc_channels` の一意索引は deleted の行を数えない）。§7 の 3 と同じく受け入れる。
15. **起動時の後段を待つ間の［取り込む］**。再起動の前に出した確認の［取り込む］が後段（`recoverEffects`）を待つ間に押されると、その行の後始末が 2 回走って完了の文が 2 通出うる（後始末待ちの行が在るときだけ）。受ける。

## 8. 決定事項と未決（v3 で書き直した）

**決定（本書）**
1. 取り込み先は新しい普通のチャンネル（#428 の決定 2）。作るのは［取り込む］の後・SIGTERM の前。`sessions` の行は commit で作る（§3.1）。
2. チャンネルを作った後の失敗では、そのチャンネルを消す。消せなければ DB に残し、起動時にもう一度（§3.1）。
3. ended の知らせは差し止めない。`cc-…` が在れば、成功の後始末で deleted にして案内を 1 通出し、完了へ移す（§3.2）。
4. 共存の間の守りは送信だけ。チャンネルの側の守り・起動の守りは持たない（§3.2）。
5. tmux は必須にしない。生きている物は tmux のペインが待機のときだけ、終わった物は tmux なしで取り込める（§3.4）。
6. 入口は `/cc take`（どこでも候補から選ぶ）と Web の札。確認は 10 分で失効。Web から始めた確認は Discord に出さない（§3.5）。
7. DB は 1 つの移行（v45）。確認を出した場所と行き先は別の列（§3.9）。
8. v2 のまま: プロセスを終わらせる・待機中だけ・直下だけ・相手の確かめ 5 つ・記録を Bot 側へ写す・前置きの付け方・SDK のツールは作らない・起動時の片付け 2 段・逆向きは U3。

**v2 の未決の行き先**

| v2 の # | 内容 | v3 |
|---|---|---|
| 1 | チャンネルの名前が `cc-…` のまま | **消えた**（新しいチャンネルは普通の名前） |
| 2 | 取り込んだ後に端末で同じ会話を resume する重なりを fork で避けるか | 残る。今は避けない。決めるのは U3 のとき（オーナー）。hook を消せば（X4）起きない |
| 3 | 待機しているプロジェクトのセッションを「オーナーの番」に数えるか | #338 の側（terminal-handover.md §5.1） |
| 4 | tmux の外の生きているセッションも終わらせるか | **決まった**（#428 の決定 4: 終わらせない） |
| 5 | `TAKEOVER_MAX_BYTES` の値 | 実装者（128 MB で始め、R3 で直す） |
| 6 | 端末の plan・acceptEdits を引き継ぐか | **決まった**（H4b: 引き継ぐ。ほかは default。§3.6） |
| 7 | 端末の cwd の形が違うセッションも取り込むか | 残る。今は断る。使う期間に困ったら見直す（オーナー） |
| 8 | M1 の手順 5（R6。背景のシェル・MCP の子プロセスが SIGTERM の後に残るか） | 残る（下の 3） |
| — | （v3 のレビューで足した）取り込んだ話題の場所を付け替えたとき、会話の記録が無くて新しい会話になると、「元の会話は端末で開けます」の知らせが出ない（§3.6.3） | 決めた: 要点なしで付け替える経路だけ通す（`topic-move.ts` の deps に `takeover` を足し、付け替えが通った後に `resumeDropped`。H2） |

**オーナーの決定とオーナーに訊く事（決定 2 件・訊く事 1 件）**

| # | 事 | 決定・推薦 | 時 |
|---|---|---|---|
| 1 | `cc-…` のチャンネルが在るセッションを取り込むと、そこに「セッションが終わりました…」と「続きは新しいチャンネルで」の 2 通が出る（X3 までの間だけ。§3.2 の B） | **2026-11-19 オーナーの決定: 2 通でよい**（差し止めは足さない） | 決定済み |
| 2 | チャンネルを作った後に取り込みが失敗したときの、作ったチャンネル（数秒〜十数秒だけ見えて消える） | **2026-11-19 オーナーの決定: 消す**（§3.1） | 決定済み |
| 3 | R6 の手での確認（背景のシェルを 1 つ動かしたままの claude に SIGTERM。利用枠を 1 ターン使う）をいつ行うか（訊く事） | **推薦: H2 の実機の確かめの前に 1 回**。残る・止まるの結果を確認の文に 1 行足す（§2 の倒し方） | H2 の前 |

**実装者が決めてよい物**: `TAKEOVER_MAX_BYTES` などの定数の値（本書の値で始める）/ log の文 / テストの組み方 / ストア・本体の private な関数の名前 / 候補のセレクトの各行の見せ方（H2）/ 札の部品の名前（H3）。

## 9. レビュー（PR #342）の指摘の扱い

（v2 までのレビューの記録。そのまま残す。ここに出る `ended_held`・`intercept`・`markTaken`・`holdsChannel`・［取り込んで続ける］・古い殻の画面は v3 には無い。相手の確かめ・記録の写し・前置き・起動時の片付けの締めは v3 でも生きている。）

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
- confirm の HTTP は終わるまで待つ（10 秒を超えることがある）。待つ間は Esc を止め、ボタンを無効にする。背景を押して閉じても取り込みは続く（結果の出し方は §9.9）。
- done の後は、タブの状態を捨てて（`store.resetTurns`）チャンネルの一覧と会話を読み直し、同じ `ch:<id>` が session として描き直される。完了の文は会話の履歴の notice の行に残る（§9.9）。
- 静的ファイルの版を上げる仕組みは無い（ETag）。
- **ブラウザでは確かめていない**（この機械にブラウザが無い）: ダイアログの見た目・改行・スマホの幅・待つ間の表示・焦点の戻り・タブの描き直し。

### 9.9 PR #348（T5）のレビューで足した締め

重大 1（ダイアログの最初の焦点）・中 4・小 6。次を入れた。

- **ダイアログの最初の焦点は [やめる]、[取り込む] は danger の色。** 戻せない操作（端末の claude を終わらせる）なので、Enter の押しっぱなし・二度押しで進まないようにする（GUIDELINES の「戻せない側を primary にしない」）。見出しの [取り込む] は、`/takeover` を待つ間・ダイアログを開いている間・背景で閉じた後の取り込み中は無効にして、理由を title に出す。
- **Web にはエスケープ前の文を返す。** 確認の文・完了の文は Discord 向けに Markdown を無効にしてある（`self\-agent`）。propose・confirm の結果に `plainText` を足し、Web の応答と履歴の行はそちらを使う。Discord に出す文は変えない。
- **確認待ちが残っているときの Web の [取り込む] は作り直す。** 同じチャンネルに確認待ちの行があれば cancel して Discord の確認の投稿を「取り込みをやめました。」に書き換え、propose し直す（再読み込み・応答が届かなかった後に、10 分待たずに答え直せる）。取り込み中（running）の行があるときは今までどおり断る。
- **confirm の結果が分からないとき**（接続が切れた・5xx）は「結果を確かめられませんでした。取り込みは続いているかもしれません。」を出し、1.5 秒・5 秒・15 秒後に読み直す。「つながりません」と出すと、取り込みが済んでいるのにもう一度押すことになる。
- **チャンネルが既にあれば開き直さない。** `/cc close` で閉じただけのチャンネルが、断られる取り込み（実行中など）のたびに開き直されていた。チャンネルの行があればそのまま propose し、無いときだけ `ensureFor`。
- **完了の文は履歴の notice の行に残す**（区切りの行の直後。Discord からの取り込みでも同じ）。「最後の指示は途中で止まっているかもしれません」の注意が、4 秒で消えるトーストにしか出ていなかった。Web の done のトーストはやめた。
- Discord で先に答えた後の「この確認はもう使えません。」は、消えない error でなく通常のトーストにして読み直す。done の後の焦点は入力欄。
- テスト: Web で開けないチャンネルの行への confirm・cancel は 404 で SIGTERM なし／confirm・cancel の 401・403／並行の 2 つの confirm（SIGTERM は 1 回・片方は stale）／作り直し／閉じたチャンネルが開き直されない／履歴の notice の行。

入れなかったもの:

- 失敗の文の続け方は「もう一度取り込む」の言い方にして、Discord と Web のどちらでも通じる（文を入口ごとに分けない。Web では [取り込む] を押し直す）。
- 応答の `channelId` を画面が使っていない。害は無いので残す。
- 画面の挙動（焦点・無効の表示・読み直しの間隔）は、静的テストで文字列の形を見ているだけ。**ブラウザでは確かめていない**（§9.8 と同じ）。

### 9.10 H2 で決めた事（設計に無かった細部）

- 入口は `app/commands/cc-take.ts` に置き、`app/commands/cc.ts` は `/cc take`・`cc:takepick`・`cc:take:go|no:<id>` を振り分けるだけ。入口は消える側（`cc/channels.ts`・`cc/sender.ts`・`cc/replies.ts`・`cc/starter.ts`・`app/commands/cc-confirm.ts`）と `app/commands/cc.ts` を import しない（テストで見張る）。`/cc` を登録する条件は今のまま（`ccChannels` を渡したとき。X3 で変える）。
- `/cc take` は先に本人にだけ見える形で保留してから一覧を読む（数秒かかりうる）。準備ができていなければ一覧を読まずに `not_ready` の文。セレクトを保留の後の応答に載せる形は実機で見ていない。
- 選ぶ（`cc:takepick`）も保留してから `propose`（entry discord・打ったチャンネルが `confirm_channel_id`）。確認の文とボタンは打ったチャンネルに既定の人格の Bot で出し、本人には「取り込みの確認をこのチャンネルに出しました」。出せなければ `cancel` して「取り込みの確認を出せませんでした」。
- ボタンの照合は、行が在る・entry が discord・awaiting_confirm・押したサーバーが行のサーバー・押したチャンネルが `confirm_channel_id`。オーナーの判定は振り分けの前（`app/interactions.ts`）。［やめる］は `cancel` が通ったときだけ確認の文を「取り込みをやめました。」に書き換える（書き換えの失敗は log だけ）。［取り込む］は保留してから `confirm` を待ち、stale なら本人にだけ断り、確認の文を本体が書き換えられなかったときだけ押された 1 通を結果の文にする。
- 入口の deps は main が後から作るので getter で渡す（`ccTakeEntry`。本体を作った直後に作る）。実行中・判断待ちの数と RC のリンクは一覧の今の写しから引く。
- log は取り込みの番号と例外の種類だけ（session_id・題名・プロジェクト・チャンネル ID・ユーザー ID を出さない）。
- 実機の確かめ（§6 の H2）はまだ。
