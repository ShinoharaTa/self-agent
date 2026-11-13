# 取り込み（端末の Claude Code の会話を self-agent のセッションが引き継ぐ）設計（#341）

v1（2026-11-13）。前提: `docs/plan/unify.md`（U1・U3）、`claude-code-sessions.md`、`claude-code-channels.md`（CC13）。

## 0. 目的と結論

**何のために**: 端末（tmux）で進めていた Claude Code の会話を、席を離れた後もスマートフォンの Discord・Web から「同じ会話の続き」として進めたい。今のリモコン（CC1〜CC14）はペインに貼り付けるので画面の状態に左右され、許可・質問は hook 越しになる。取り込みは、会話の記録を self-agent のプロジェクトのセッション（U1）が SDK の `resume` で引き継ぎ、以後は普通のセッションとして動かす。リモコンとは別の経路で、リモコンは残す。

**結論**
- 取り込み先は **今ある `cc-<名前>` のチャンネルをその場でプロジェクトのセッションに変える**（チャンネル ID は同じで、Web の履歴が続く）。無ければ先に作ってから変える。
- 端末の claude は **SIGTERM** で終わらせる（probe で確認）。生きているセッションは tmux の中・待機中だけ。終わったセッションも同じ手順で取り込め、失敗・再起動の後のやり直しの口を兼ねる。
- 記録は Bot の `CLAUDE_CONFIG_DIR` へ **コピー**する（session_id は同じ。端末側とはそこで分岐）。U3 で `projects` を共有しても、同じコードのまま通る。
- 取り込んだ会話には **PROJECT_APPEND が入らない**（probe）。最初のターンの発言の前に 1 回だけ「前置き」を付けて渡す。
- 入口は `/cc take`（確認のボタン付き）から。SDK のツールは作らない。DB は表 1 つ（`cc_takeovers`）。環境変数は足さない。逆向き（端末へ戻す）は U3 に置く。

決まっている前提（#341。再検討しない）: `/clear` は貼らずプロセスを終わらせる / 待機中だけ / `SELF_AGENT_WORKSPACE_DIR` の直下のプロジェクトだけ。

## 1. 確認した事実

### 1.1 確認（コード。main 85e173f）

1. セッションの終了は **`claude agents --json` の一覧から消えたこと**だけで決める（`cc/registry.ts`）。消えると `ccEndedHandler`（`cc/channels.ts`）→ `channels.ended`（ended にして完了へ移す）と `replier.ended`（追いかけ中なら「終わりました」）。SessionEnd の hook は証拠にしない。
2. `cc_channels` の行が deleted でない間、そのチャンネルの発言はリモコンが取る（SDK のターンにならない）。判定は 15 箇所すべて `state !== "deleted"`。一意索引は `(session_id) WHERE state <> 'deleted'`。
3. Web の履歴（`history`）は `channel_id` で引き、cc の行とセッションの行は同じ表。`/api/channels` の kind は、deleted でない cc の行があれば `cc`、無ければ `sessions` から。
4. プロジェクトのセッション（`agent/project-profile.ts`）: preset + `PROJECT_APPEND` + `snapshot: true`、`settingSources` 3 つ、`AskUserQuestion` を外す、許可は canUseTool → `cc_permissions`（origin sdk）。モデルは `cfg.model`、モードは `sessions.permission_mode`（default / acceptEdits / plan）。自動メモリは切ってある（U3 まで）。秘密の場所の guard は `~/.claude` を拒む。
5. 記録: 端末は `~/.claude/projects/<cwd の英数字以外を - に>/<session_id>.jsonl`（`projectDirName`）、Bot は `<cfg.claudeConfigDir>/projects/<同じ名前>/`。隣に `<session_id>/`（subagents など）と `memory/` があることがある。実機の記録は最大 110 MB。
6. `app/turn.ts`: resume が `No conversation found` で失敗するか失敗が 3 回続くと、**SDK セッションを黙って捨て**、seed を付けて新しい会話でやり直す。seed は SDK セッションが無いときだけ付く。
7. `usage_log` はステップごとの usage の合計（`agent/sdk-runner.ts`）。`modelUsage` を読むのは `cli/measure.ts` だけ。
8. tmux の包みに kill は無い。self-agent が起動した claude は終わるとペインがシェルに戻る。`cc/panes.ts` に pid からペインを引く関数と `probePaneState`（idle / draft / dialog / busy / owner_active / copy_mode …）がある。
9. `ClaudeDirs.sessionFile(pid, sessionId)` が `~/.claude/sessions/<pid>.json` を読む（sessionId が違えば undefined）。
10. CC13 の [起動して続ける] は同じ cwd で**新しい** claude を起動する（`--resume` は無い）。resuming は再起動時に ended に戻す。
11. マイグレーションは配列の位置で番号が決まる（main の最後は v41。テストは `MIGRATIONS.length` で比べる）。`sessions.origin` と `cc_sessions.started_by` は CHECK があり、値を足すには表の作り直しが要る。
12. Gateway は作成後のチャンネル名の変更を持たない。topic の書き換えと移動はある。
13. SDK 0.3.286（同梱 CLI 2.1.286）。端末の CLI は 2.1.323（自動更新で先に進む）。

### 1.2 確認（probe。2026-11-13・一度きり。端末 2.1.323 / Opus 5.5 / auto → SDK 同梱 2.1.286 / opus-5 / default）

| # | 確かめたこと | 結果 |
|---|---|---|
| P1 | 待機中の claude へ SIGTERM | 約 1.5 秒で終了。記録に 2 行（last-prompt・cost-state）を足して閉じる。`sessions/<pid>.json` は消え、ペインはシェルに戻る |
| P2 | 記録を置かずに resume | `No conversation found with session ID`（turn.ts が見ている文と同じ） |
| P3 | 記録を Bot 側にコピーして resume | **成功**。版違い・モデル違いでも前の内容（ツールの結果を含む）を答えた。**session_id は同じ**。追記は Bot 側だけ（端末側は変わらない = 分岐） |
| P4 | `forkSession: true` | 成功。新しい session_id |
| P5 | `projects/<名前>` を端末側への symlink にして resume | 成功。端末側に追記され、端末の `claude --resume` で SDK のターンを読めた |
| P6 | system prompt の append | **効かない**。端末の記録に system prompt が記録されていて、snapshot: true の resume はそれを送る（コピー・fork・共有のどれでも） |
| P7 | 自前の MCP ツール | 使える |
| P8 | 許可のモード | 記録に端末の auto が残っていても resume の init は `default` で、canUseTool が呼ばれた |
| P9 | modelUsage | 最初の result に端末側の累計（別モデルの行）が混ざる。Bot のモデルの行は最初のターンで cacheRead 0（全部書き直し） |
| P10 | 記録された system prompt | 端末のもの。自動メモリは `~/.claude` の下を指すはず（Bot の guard は拒む） |

## 2. 残りの確かめる項目（未確認。設計は倒した側で書いてある）

| # | 項目 | いつ | 駄目だったときの倒し方 |
|---|---|---|---|
| R1 | Bot の unit から端末の claude の pid を `/proc` で読めて SIGTERM が届く（unit の設定に隔離は無い: `systemctl --user show` で ProtectProc=default・PrivateUsers=no・PrivateTmp=no・ProtectHome=no を確認。同じ uid なので届く見込み。実際の kill は未確認） | T3 の実機確認 | 終わったセッションの取り込み（端末で /exit してから）だけにする |
| R2 | 圧縮の後に PROJECT_APPEND が入るか・前置きが残るか | T3 の後、長い会話で 1 回 | 入らなければ、圧縮の後の最初のターンにも前置きを付ける（T4 に足す） |
| R3 | 数十 MB の記録の resume（時間・unit のメモリ上限） | T3 の実機確認 | `TAKEOVER_MAX_BYTES` を下げ、「端末で /compact してから」と案内する |
| R4 | サブエージェントを使った会話を、脇のディレクトリなしで resume | T3 の実機確認 | 脇のディレクトリも写す（通常ファイルだけ） |
| R5 | ターンの途中で SIGTERM を受けた記録の resume | 手で 1 回 | 失敗すれば §3.6.3 の知らせで新しい会話になる |
| R6 | さらに進んだ版の端末の記録を同梱 CLI が読めなくなる | 起きたとき | SDK を上げる（それまでは R5 と同じ倒れ方） |

## 3. 案の比較と決定

### 3.1 取り込み先のチャンネル

| 観点 | (a) cc のチャンネルをその場で変える | (b) いつも新しいセッションのチャンネル | (c) あれば (a)・無ければ (b) |
|---|---|---|---|
| Web の履歴の連続 | ◎ 同じ channel_id | ✗ 切れる | ○ |
| Discord での見え方 | ○ 名前は `cc-…` のまま（変更の口が無い） | ◎ 普通のセッションの名前 | △ 2 通り |
| 残った cc のチャンネルの始末 | ◎ 要らない | △ 完了へ移す・削除の確認が残る | △ |
| 実装コスト | ○ 行の付け替え | ○ 既存の作成を呼ぶ | ✗ 2 経路 |
| 運用コスト | ◎ チャンネルが増えない | △ 1 回ごとに 1 つ増える | △ |

**決定: (a)。チャンネルが無いときは `ensureFor`（CC10・CC11 の既存の作成）で先に作ってから変える**ので、経路は 1 本になる。作れなければ取り込まない（何も変えていない段階）。

- cc の行は **deleted にする**。15 箇所の判定に触らずに発言がリモコンに行かなくなり、一意索引も空く。出どころは `cc_takeovers` に残す。state を足す案は表の作り直しと 15 箇所の見直しが要るので採らない。
- `sessions` の行を同じ channel_id で作り、カテゴリは進行中（`findStateCategory(guildId, "active")`）へ `enqueueMove`、topic は `sessionTopic(題名, undefined, プロジェクト)`。題名は `cc_channels.name`。
- ended のチャンネルの削除の確認（#system の `cc:del:`）は、ボタンを外して「取り込まれました」に編集する（失敗しても続ける）。
- 名前が `cc-…` のままなのは受け入れる（未決 1）。

### 3.2 リモコン側の行と、終了の見分け

**決定: 見分ける場所を `ccEndedHandler` の 1 箇所にする。** そのセッションに running の取り込みがあれば、ended の知らせを**通さない**（`channels.ended`・`replier.ended` を呼ばない）。取り込みが成功すれば捨て、終了の後で失敗すれば本体が同じ 2 つを呼び直す（普通の ended になる）。

| 行 | 取り込みの前（断る条件） | 成功したとき |
|---|---|---|
| `cc_sessions` | — | 一覧から消えて gone（今までどおり 30 日で消える）。`stopFollow` |
| `cc_channels` | — | deleted（§3.1） |
| `cc_sends` | awaiting_confirm・queued・delivering が 1 件でもあれば断る | 触らない（履歴） |
| 追いかけ（follow） | — | 止める。追いかけ先が別のチャンネルなら 1 行だけ知らせる |
| `cc_permissions` | pending があれば断る（待機中なら無いはず） | 触らない。以後は同じ session_id で origin sdk の行ができる |

- running の間は、`CcSender.submit` がそのセッションへの送信を断り（`taking_over`）、届けもしない。チャンネルの発言には「取り込みの途中です。終わってから送ってください。」を返す。
- hook の事象（SessionEnd・Stop）が途中で届いても、終了の根拠は一覧だけなので影響しない。終了の前に PermissionRequest が届いたら取り込みをやめる。
- 取り込んだ後に端末で同じ会話を resume した場合は §7 の 3（cc の行は deleted なので `revived` は何もしない）。

### 3.3 記録の置き場所

| 観点 | (A) Bot 側へコピー | (B) `projects/<名前>` を symlink で共有（U3 の形） | (C) fork して新しい session_id |
|---|---|---|---|
| probe | ◎ P3 | ◎ P5 | ○ P4 |
| 2 つのプロセスが同じ記録に書く | ◎ 起きない（分岐） | ✗ 端末で resume すると起きる。守りが要る | ◎ |
| 端末へ戻れる | ✗ 取り込む前までしか無い | ◎ そのまま戻れる | ✗ |
| `~/.claude` に書かない線 | ◎ | ✗ CLI が端末側に追記する | ◎ |
| 実装コスト | ◎ ファイル 1 つ | △ 自動メモリ・守り・setup の決めが要る（U3） | △ runner に fork の口・古い写しの掃除 |
| 運用コスト | ○ ディスクが記録 1 つ分 | ◎ | △ 2 つ分 |

**決定: 今は (A)。** `<session_id>.jsonl` だけを写す（脇のディレクトリと `memory/` は写さない。自動メモリは U3 まで切ってある）。session_id は変えない（U3 で (B) に移ったとき、同じ ID のまま端末と行き来できる形に揃う）。
- **実体が同じなら写さない**（両方のディレクトリの realpath が同じ）。U3 で共有したらこの分岐に入り、コードを変えずに (B) になる。そのときの「同時に書く」守り（その session_id が端末の一覧に生きている間はターンを始めない）は U3 で決める。
- 写し方: 元が通常ファイル（symlink でない）で `TAKEOVER_MAX_BYTES`（128 MB）以下 → 一時名（排他・mode 600）へコピー → rename。本文は読まない。
- 写し先に同じ名前がすでにある: `channel_sessions` にその session_id の行があれば断る（`already_taken`）。無ければ古い方を `<名前>.old-<時刻>` に退けてから写す。

### 3.4 claude の終わらせ方と競合

| 観点 | (a) pid へ SIGTERM | (b) ペインに `/exit` を貼る | (c) tmux の kill-pane |
|---|---|---|---|
| probe | ◎ P1 | 未確認 | 未確認 |
| 画面の状態に左右されない | ◎ | ✗ 書きかけ・ダイアログで誤る | ○ |
| 競合したときの残り方 | ○ ターンが止まるだけ | ✗ `/exit` が発言として入りうる | ✗ ペインごと消える |
| 実装コスト | ◎ `process.kill` | ○ 既存の貼り付け | △ 包みに kill を足す |

**決定: (a)。SIGKILL は送らない。プロセスグループにも送らない。**

- 生きているセッションの条件: 一覧で `kind === "interactive"`・`status === "idle"`・信頼の確認待ちでない・cwd が直下のプロジェクト・**tmux のペインが引けて `probePaneState` が idle**（書きかけ・ダイアログ・操作の直後（60 秒）・コピーモードは断る）。tmux の外のセッションは断る（画面の証拠が取れない。/exit の後の取り込みで拾える）。
- 相手の確かめ（signal の直前に全部）: 今読んだ一覧でその session_id が同じ pid / `sessionFile(pid, sessionId)` が返る / `/proc/<pid>/stat` の starttime が最初と同じ / pid が自分・自分の祖先でない。
- 直前の競合: 最初の確かめ → 2 秒おく → 一覧を読み直して idle・記録の大きさと mtime が変わっていない・ペインが idle → すぐ SIGTERM。この間にターンが始まれば止まる。終了の後に、記録の増えた行の `type` だけを見て `user`・`assistant` があれば `interrupted` を立て、完了の文に 1 行足す。
- 終了の確かめ: `/proc/<pid>` が消えるのを 250 ms ごとに 10 秒まで待つ。消えなければ失敗（`not_exited`。何も変えていない。端末は生きたまま）。消えたら一覧を読み直して無いことを確かめる。
- **失敗しうることは終了の前に済ませる**: 進行中のカテゴリの解決・写し先のディレクトリの作成・元の記録の検査。
- 落ちたとき: 起動時に running の取り込みを failed（`restart`）にしてから registry を始める（CC13 の `resetResuming` と同じ考え）。claude が終わっていれば普通の ended になり、そのチャンネルで `/cc take` をもう一度。
- 終わったセッションの取り込み: 条件は `cc_sessions` に gone の行がある・一覧に無い・cwd が直下・元の記録がある。手順は終了を飛ばすだけ。

### 3.5 入口

| 観点 | (a) `/cc take` + 確認のボタン | (b) ended のチャンネルの [取り込んで続ける] | (c) Web のボタン | (d) SDK のツール |
|---|---|---|---|---|
| 誤操作の少なさ | ◎ 2 段 | ○ | ○ 確認のダイアログ | ✗ モデルがプロセスを止める口になる |
| キャッシュ | ◎ | ◎ | ◎ | ✗ 全セッションで 1 回外れる |
| 実装コスト | ○ | ○ | △ API・画面 | △ |

**決定: (a) → (b) → (c) の順。(d) は作らない。** 最初の段（T3）は cc のチャンネルの中での `/cc take` だけ。確認は 10 分で失効（`cc_send` の確認と同じ型）。ボタンは `cc:take:go:<id>`・`cc:take:no:<id>`。

### 3.6 取り込んだセッションの形

- `sessions`: state active・origin `command`（CHECK を変えない。出どころは `cc_takeovers`）・persona は既定・`project_dir` はプロジェクトの名前・`permission_mode` は端末のモード（`cc_sessions.permission_mode`）が default / acceptEdits / plan ならそのまま、ほか（auto・bypassPermissions・不明）は **default**。確認の文に両方を書く。
- モデルと effort は `cfg` のもの（端末のモデルは引き継がない）。最初のターンはキャッシュが全部外れる（P9）。**1 回だけ受け入れ**、CLAUDE.md の「プロンプトキャッシュの規則」に例外として 1 行足す。取り込みの時点で確かめのターンは打たない。

#### 3.6.1 self-agent の案内の渡し方（P6 への対応）

| 観点 | (a) 最初のターンの発言の前に前置きを 1 回 | (b) 取り込んだ会話だけ snapshot: false | (c) 取り込み時に案内だけのターンを打つ |
|---|---|---|---|
| 効くか | ○ 発言として記録に残る | 未確認 | ○ |
| キャッシュ | ◎ 追記だけ | ✗ git の状態が変わるたびに全部外れうる | ◎ |
| 利用枠 | ◎ | ✗ | ✗ 用が無いのに 1 ターン |
| 実装コスト | ○ turn.ts に 1 箇所 | ○ | △ |

**決定: (a)。** `cc_takeovers.note_pending` が 1 の間、resume するターンの prompt の先頭に `TAKEOVER_NOTE` を付け、その prompt が記録された時点で 0 にする（seed を消すのと同じ条件）。`TAKEOVER_NOTE` は下の頭書き + `PROJECT_APPEND`（システムプロンプトではないので、変えても他のセッションのキャッシュは外れない）。/renew の後は普通のプロジェクトのセッションになる。

頭書き（T3 でこのまま使う）:

```
（self-agent が付けた知らせです。オーナーの発言ではありません）この会話は、端末の Claude Code から self-agent が引き継ぎました。これより前の指示のうち、端末の画面を前提にしたものより、次を優先してください。
- 端末の画面はもうありません。AskUserQuestion は使えません。訊きたいことは本文に書いてください。
- 自動メモリ（~/.claude の下のファイル）は、ここからは読み書きできません。試さないでください。
- モデルと許可のモードは、端末のときと違うことがあります。
```

#### 3.6.2 usage の扱い（P9 への対応）

**決定: 何も変えない。** `usage_log` はステップごとの usage の合計なので端末の累計は混ざらない（§1.1 の 7）。最初の行は cacheRead 0・書き込みが大きい行になる（正しい値）。**取り込んだ会話では `modelUsage` と費用の累計を計測に使わない**。キャッシュの効きは 2 ターン目から `npm run usage` の行で見る。

#### 3.6.3 resume に失敗したとき

今は黙って新しい会話になる（§1.1 の 6）。取り込んだチャンネルでは、捨てる所で 1 回だけ知らせる:「取り込んだ会話の記録を読めませんでした。新しい会話として続けます。元の会話は端末で claude --resume で開けます。」（やり直しは今までどおり）。

### 3.7 進行状況（#338）との関係

- **DB**: 取り込みのマイグレーションは配列の末尾に足す。番号は入った順で決まる（#338 が先なら v43、後なら v42 で #338 が v43）。後から入る方が rebase してコメントの番号を直す。表・列は重ならない。マージ前の枝を本番の DB で動かさない。
- **分類**: 取り込むと CC のセッションが 1 つ減り、プロジェクトのセッションが 1 つ増える。二重には数えない。ただし `classifyProject` は「待機の CC のセッション + 未コミット」を owner にするが、**待機しているプロジェクトのセッション**は見ない（`BoardLive.turnRunning` だけ）ので、取り込みの後は同じ状況が agent 側に出る。U1 のセッション全部の話なので #338 の側の課題にし、取り込みの段では board を触らない（未決 3）。

### 3.8 逆向き（Discord のセッションを端末へ戻す）

**決定: 範囲外。置き場所は U3。** 理由: (1) コピーの形では Bot 側の記録を `~/.claude` へ書き戻すことになり、「`~/.claude` に書かない」線を越える。(2) `projects` を共有すれば（P5）、写さずに端末の `claude --resume` で続きが読める。それが U3。(3) 起動の口（`buildClaudeCommand`）に `--resume` が無い。U3 に渡す材料: P5・同時に書かない守り・自動メモリ（P10）。

### 3.9 DB・環境変数・安全

- **DB**: 表 `cc_takeovers` を 1 つ足す（§5 の T1）。`sessions`・`cc_channels`・`cc_sessions` の定義は変えない。
- **環境変数**: 足さない。`SELF_AGENT_CC=1` と `ProjectSessionGate.ready` がそろったときだけ動く。
- **安全**
  - オーナーだけ。`/cc` の既存の確かめ（許可したサーバー・オーナーのユーザー・既定の人格の Bot）と同じ。ボタンは押した人・チャンネル・state を確かめる。Web は `Tailscale-User-Login`。
  - 対象の session_id・pid は、チャンネルの行と一覧から引く。**入力の文字列から取らない**。発言・モデルの出力からは起こせない（ツールが無い）。
  - signal は SIGTERM だけ・1 つの pid だけ・§3.4 の確かめを通ったときだけ。
  - ログに session_id・pid・cwd・名前・パス・本文を出さない（理由の符号と段だけ）。
  - 書く先は `CLAUDE_CONFIG_DIR` の中だけ。`~/.claude` には書かない。

## 4. 手順と状態遷移

`cc_takeovers.state`: `awaiting_confirm` →（[取り込む]）`running` → `done` / `failed`。`awaiting_confirm` →（[やめる]・10 分）`cancelled`。running の間の位置は `step`。

| step | すること | 失敗したとき |
|---|---|---|
| check | §3.4・§3.2 の条件、元の記録の検査、進行中のカテゴリの解決、写し先のディレクトリの作成。生きていれば 2 秒おいて確かめ直す | failed。何も変えていない |
| term（生きているときだけ） | 相手の確かめ → SIGTERM → `/proc/<pid>` が消えるまで待つ → 一覧に無いことを確かめる → 増えた行の type を見る | 消えない: failed（`not_exited`）。何も変えていない |
| copy | 記録を写す（同じ実体なら写さない） | failed（`copy_failed`）。保留していた ended を流し直す → 普通の ended のチャンネルになる |
| commit | 1 つのトランザクションで: `sessions` の行を作る・`channel_sessions` に session_id を置く・cc の行を deleted・`stopFollow`・取り込みを done（`note_pending = 1`） | 同上（巻き戻る） |
| （後始末。失敗しても done のまま） | 進行中へ移す・topic・完了の文・履歴の divider・確認の文の編集・削除の確認の編集・追いかけ先への 1 行。終わったら `effects_at` | 起動時に、done で `effects_at` が空の行の移動と topic だけやり直す |

失敗の符号と文（確認の文を `取り込めませんでした: <文>` に編集。終了の後の失敗は「端末の Claude Code は終了しています。このチャンネルで /cc take をもう一度実行すると、終わった会話から取り込めます。」を足す）:

| 符号 | 文 |
|---|---|
| not_ready | プロジェクトのセッションの準備ができていません（npm run unify-setup -- --print） |
| outside_workspace | 作業場所の直下のプロジェクトのセッションだけ取り込めます |
| busy / waiting | 実行中です / 判断待ち（許可・質問）です。待機になってからもう一度 |
| not_in_tmux | tmux の外のセッションです。端末で /exit してからもう一度 |
| pane | 端末の画面が待機の状態ではありません（書きかけ・ダイアログ・操作の直後） |
| queued | 届け待ちの指示があります。届くのを待つか /cc cancel してから |
| already_taken / in_progress | すでに取り込んだ会話です / 取り込みの途中です |
| no_transcript / too_large | 会話の記録が見つかりません / 記録が大きすぎます。端末で /compact してから |
| changed / identity | 直前に動きがありました。もう一度 / セッションを確かめられませんでした |
| not_exited | 端末の Claude Code が終わりませんでした。何も変えていません |
| copy_failed / restart | 記録を写せませんでした / self-agent が再起動しました |

確認の文: 「「<名前>」（<プロジェクト>）を取り込みます。端末の Claude Code は終了し、続きはこのチャンネルで self-agent が引き継ぎます。許可のモード: <mode>（端末: <端末のモード>）。モデルは self-agent の設定のものになります。」（終わったセッションは 2 文目の前半を「端末の Claude Code はすでに終わっています。」に）。
完了の文: 「取り込みました。ここから先は self-agent がこの会話を続けます（<プロジェクト>・許可のモード <mode>）。端末で claude --resume すると取り込む前までの会話が別に開きます（ここでの続きは入りません）。」。`interrupted` なら「取り込みの直前に端末で動きがありました。最後の指示は途中で止まっているかもしれません。」を足す。

## 5. 段階分け（1 段 = 1 PR。順に積む）

| 段 | 内容 | 使えるようになること |
|---|---|---|
| T1 | 土台: DB・ストア・判定の純関数・記録の写し（配線なし） | なし |
| T2 | 本体 `CcTakeover`・ended の保留・送信のゲート・再起動の復旧（入口なし） | なし（偽の部品でテスト） |
| T3 | `/cc take`・確認のボタン・ターン側（前置き・resume 失敗の知らせ）・配線・文書 | cc のチャンネルの中から取り込める |
| T4 | Discord の入口を広げる | ended の発言から [取り込んで続ける]・チャンネルの外から選ぶ |
| T5 | Web | セッションのタブから取り込める |

### T1 土台
- `src/store/db.ts`: `MIGRATIONS` の末尾に 1 つ足す。
  ```sql
  CREATE TABLE cc_takeovers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('alive','ended')),
    project TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    entry TEXT NOT NULL CHECK (entry IN ('discord','web')),
    state TEXT NOT NULL CHECK (state IN ('awaiting_confirm','running','done','failed','cancelled')),
    step TEXT CHECK (step IN ('check','term','copy','commit')),
    failure TEXT,
    permission_mode TEXT NOT NULL CHECK (permission_mode IN ('default','acceptEdits','plan')),
    terminal_mode TEXT,
    interrupted INTEGER NOT NULL DEFAULT 0,
    note_pending INTEGER NOT NULL DEFAULT 0,
    pending_text TEXT,
    confirm_message_id TEXT,
    effects_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE UNIQUE INDEX cc_takeovers_active ON cc_takeovers(session_id) WHERE state IN ('awaiting_confirm','running');
  CREATE INDEX cc_takeovers_channel ON cc_takeovers(channel_id, state);
  ```
- `src/store/cc-takeovers.ts`（新）`CcTakeoverStore`: `propose(input)`（索引に当たれば undefined）・`get(id)`・`activeFor(sessionId)`・`runningFor(sessionId)`・`start(id)`（awaiting_confirm → running。当たらなければ false）・`setStep(id, step)`・`setInterrupted(id)`・`finish(id)`（done・`note_pending = 1`）・`fail(id, failure)`・`cancel(id)`・`expire(cutoffIso)`（返り値は行）・`resetRunning()`（running → failed `restart`。返り値は行）・`takenFor(channelId)`（最新の done）・`clearNote(channelId)`・`setConfirmMessage(id, messageId)`・`markEffects(id)`・`listEffectsPending()`。
- `src/cc/takeover-rules.ts`（新。純関数）: `takeoverRefusal(input)`（§4 の符号を返す。入力は view・ペインの状態・届け待ちの数・保留の許可の有無・`channel_sessions` の有無・ready）、`mapTakeoverMode(mode)`（§3.6）、`parseStatStartTime(stat)`（22 番目の欄。comm の括弧は最後の `)` で切る）、`appendedInterrupted(lines)`（JSON の `type` が user・assistant の行があれば true。読めない行は無視）、`takeoverFailureText(code, afterTerm)`、定数 `TAKEOVER_SETTLE_MS = 2000`・`TAKEOVER_EXIT_TIMEOUT_MS = 10000`・`TAKEOVER_EXIT_POLL_MS = 250`・`TAKEOVER_MAX_BYTES = 128 * 1024 * 1024`。
- `src/cc/takeover-files.ts`（新）: `takeoverPaths(home, configDir, cwd, sessionId)`（`projectDirName` を使う）・`inspectSource(path)`（lstat。通常ファイルと大きさ）・`prepareTarget(dir)`（mkdir -p・mode 700）・`copyTranscript({ src, dst, hasMapping })`（§3.3。返り値 `copied` / `shared` / `already_taken`）・`readAppended(path, fromSize)`。
- テスト: `test/cc-takeovers-store.test.ts`・`test/cc-takeover-rules.test.ts`・`test/cc-takeover-files.test.ts`（一時ディレクトリ）。`docs/directory-structure.md` に 3 ファイル。

### T2 本体
- `src/cc/takeover.ts`（新）`CcTakeover`。deps はすべて注入（registry・panes・`ClaudeDirs`・各 store・`findStateCategory`・`channelOps`・gateway・history・`kill`・`readStat`・`sleep`・`now`・`ownPid`・`replayEnded`・log）。
  - `propose({ channelId, entry, pendingText? })`: cc の行 → セッション → `takeoverRefusal` → 行を作り、確認の文とボタンを返す。
  - `confirm(id)`: `start(id)` → §4 の step を順に。`cancel(id)`・`expire()`（1 分ごと。確認の文を「取り込みの確認は期限切れです（10 分）。」に編集）。
  - `holds(sessionId)`: running の取り込みがあるか。
  - `intercept(session)`: `holds` なら、その session を覚えて true。
  - `recover()`: `resetRunning()` と、`listEffectsPending()` の移動・topic のやり直し。
  - `noteFor(channelId)`・`noteDone(channelId)`・`resumeDropped(channelId, sessionId)`（T3 の turn.ts から呼ぶ）。
- `src/cc/channels.ts`: `ccEndedHandler` の deps に `takeover: () => { intercept(session): boolean } | undefined` を足し、true なら 2 つを呼ばない。`handleMessage` は、送信が `taking_over` で断られたら §3.2 の文を返す。
- `src/cc/sender.ts`: deps に `holds?: (sessionId) => boolean`。`submit` は `taking_over` で断り、`attempt` は届けずに queued のまま戻る。
- テスト `test/cc-takeover.test.ts`（偽の registry・kill、一時 SQLite）: §6 の T2。

### T3 入口（Discord）とターン側
- `src/app/commands/cc.ts`: サブコマンド `take`（引数なし）。cc のチャンネル（open・ended）の中なら `propose`、外なら「Claude Code のチャンネルの中で使ってください（無ければ /cc open）。」。ボタン `cc:take:go:<id>`・`cc:take:no:<id>` を `createCcComponent` に足す（押した人がオーナー・行の channel_id が同じ・state が awaiting_confirm でなければ「この確認はもう使えません。」）。
- `src/agent/system-prompt.ts`: `TAKEOVER_NOTE_HEAD`（§3.6.1 の文）と `TAKEOVER_NOTE = [TAKEOVER_NOTE_HEAD, PROJECT_APPEND].join("\n")`。
- `src/app/turn.ts`: `TurnDeps` に `takeover?: { noteFor(key): string | undefined; noteDone(key): void; resumeDropped(key, sessionId): void }`。SDK セッションがあり `noteFor` が返れば prompt の先頭に付ける。seed を消すのと同じ 2 箇所で `noteDone`。SDK セッションを捨てる 2 箇所で `resumeDropped`（取り込んだ session_id と同じなら §3.6.3 の文を 1 回投稿し、`note_pending` を 0 に）。
- `src/main.ts`: `SELF_AGENT_CC=1` のときだけ組み立てる。**`recover()` を registry の開始より前に**呼ぶ。`ccEndedHandler`・`CcSender`・turn の deps に渡す。失効のタイマー。
- 文書: CLAUDE.md（概要に 1 行・キャッシュの規則に例外 1 行）、`docs/directory-structure.md`、`docs/plan/unify.md` の U3 の行に「取り込みの記録の共有・端末へ戻す」。
- 実機確認: R1・R3・R4 と §6 の T3。

### T4 Discord の入口を広げる
- ended のチャンネルの発言に出す [起動して続ける][やめる]（`ccResumeButtons`）に **[取り込んで続ける]**（`cc:take:resume:<channelId>`）を足す。押すと、保留している発言を `pending_text` に入れて `propose` → そのまま `confirm`。done の後、その発言を最初のターンとして流す（通常の発言と同じ経路）。条件に合わないときはボタンを出さない。
- cc のチャンネルの外での `/cc take`: `/cc open` と同じ選択（`cc:pick` の型で `cc:takepick`）で、取り込めるセッションだけ出す。選ぶと `ensureFor` でチャンネルを作り、そこに確認の文を出す。
- R2 の結果が「入らない」なら、圧縮の後の最初のターンにも前置きを付ける（`result.compacted` の次のターン。`note_pending` を 1 に戻す）。

### T5 Web
- `POST /api/cc/sessions/<id>/takeover`（`ensureFor` → `propose`。entry web）・`POST /api/cc/takeovers/<id>/confirm`・`/cancel`。Discord の確認の文も同じ行を見る（どちらで答えてもよい）。
- セッションのタブ（cc の会話のタブ）に [取り込む]。押すと確認のダイアログ（§4 の確認の文）。断られたら符号の文を出す。done の後は同じ `ch:<id>` のタブが session の種類で開き直る（一覧の読み直し）。見た目は WEB-UI-GUIDELINES.md に従う。

## 6. 受け入れ条件

T1
- 新しい DB・1 つ前の版の DB のどちらからも `user_version` が `MIGRATIONS.length` になり、`cc_takeovers` がある。
- 同じ session_id で awaiting_confirm・running の行は 2 つ作れない。done の後は作れる。
- `takeoverRefusal` が §4 の各符号を条件どおりに返す。`mapTakeoverMode("auto")` は default。
- 元が symlink・128 MB 超なら写さない。写した先は mode 600。`channel_sessions` に行があれば `already_taken`。

T2（偽の部品）
- 待機のセッション: confirm の後、kill が SIGTERM で 1 回だけ呼ばれ、`sessions` に同じ channel_id の行（project_dir・permission_mode）、`channel_sessions` に同じ session_id、cc の行が deleted、取り込みが done・`note_pending = 1`。
- 確かめ直しで busy なら kill は呼ばれず failed（`changed`）。starttime が違えば failed（`identity`）。
- kill の後に pid が消えなければ failed（`not_exited`）で、ほかの行は変わらない。
- running の間の ended では `channels.ended`・`replier.ended` が呼ばれない。copy で失敗すると `replayEnded` が 1 回呼ばれる。
- running の間、そのセッションへの `submit` は `taking_over`。
- `recover()`: running の行が failed（`restart`）。done で `effects_at` が空の行は移動と topic が 1 回ずつ。
- 終わったセッション（gone）: kill は呼ばれず、同じ結果になる。
- ログに session_id・pid・cwd・名前が出ない。

T3
- オーナー以外の `/cc take`・ボタンは何も起こさない。10 分後の [取り込む] は使えない。
- 取り込んだチャンネルの最初の発言の prompt は `TAKEOVER_NOTE` で始まり、2 回目からは付かない。取り込んでいないセッションには付かない。
- 取り込んだチャンネルで resume が `No conversation found` になったら、§3.6.3 の文が 1 回出て、新しい会話でやり直される。
- 実機: 待機の端末のセッションを取り込むとペインがシェルに戻る / 最初の発言に前の会話を踏まえた返事が来る / Web の会話のタブで cc の頃の行の下に続く / `npm run usage` の最初の行が cacheRead 0 / 書き込みで許可のカードが出る。

T4・T5
- ended のチャンネルで発言 → [取り込んで続ける] → その発言への返事が同じチャンネルに来る（発言は 1 回だけ流れる）。
- Web の [取り込む] → 確認 → 同じタブが session として続く。`Tailscale-User-Login` が無ければ今までどおり断る。

## 7. リスク

1. **終わらせた後に取り込めない**（コピー・DB の失敗、再起動）。記録は残るので、ended のチャンネルから `/cc take` でやり直せる（端末の `claude --resume` も可）。
2. **版のずれ**（§1.1 の 13）。今は読める（P3）が内部形式なので壊れうる。壊れると §3.6.3 の知らせになる。
3. **同じ session_id が 2 つの入口にある**（取り込んだ後に端末で resume）。記録は別なので混ざらないが、`cc_permissions` の「session_id ごとに pending は 1 つ」の索引に両方が当たると片方の保留が作れない（倒れ方は未確認）。今は受け入れる（未決 2）。
4. **前置きが効かない・圧縮で消える**（R2）。/renew で普通のプロジェクトのセッションにできる。
5. **別のモデルが書いた記録**（思考のブロックなど）を読む。P3 では通ったが 1 例だけ。
6. **誤った pid への signal**。§3.4 の 4 つの確かめで守る。
7. **大きい文脈**。最初のターンは全部書き直しで、利用枠を 1 回分大きく使う。確認の段で止められる。

## 8. 決定事項と未決

決定（この文書）: §3.1〜§3.9 の各「決定」。段は T1〜T5。SDK のツールは作らない。環境変数は足さない。逆向きは U3。

未決
| # | 内容 | 推薦 | 決める人 |
|---|---|---|---|
| 1 | チャンネルの名前が `cc-…` のまま（Gateway に名前の変更を足すか） | 足さない（topic と Web の題名で分かる） | オーナー |
| 2 | §7 の 3 を fork（P4。新しい session_id）で避けるか | 今は避けない。U3 で共有にすると同じ ID が要る | オーナー（U3 を決めるとき） |
| 3 | 進行状況で、待機しているプロジェクトのセッションを「オーナーの番」に数えるか | 数える（#338 の後続で） | オーナー・#338 の担当 |
| 4 | tmux の外の生きているセッションも終わらせるか | しない（/exit の後の取り込みで足りる） | オーナー |
| 5 | `TAKEOVER_MAX_BYTES` の値 | 128 MB で始め、R3 で直す | 実装の担当（R3 の結果で） |
