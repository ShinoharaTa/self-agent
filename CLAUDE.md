# self-agent

## 概要

Discord 専用サーバーに常駐する個人用エージェント。Claude Agent SDK（TypeScript）で実装し、Claude Max の利用枠で動く。
Discord の 1 チャンネル（#inbox・#tasks と /new で作ったセッションのチャンネル）= 1 SDK セッション（`resume` で継続）。
サブエージェントは使わない。話題を分けたいときはセッション（チャンネル）を分ける。

- 要求と決定事項: `docs/REQUIREMENTS.md`（再始動版）
- 人格（1 プロセスに複数の Bot・共有 DB・codex）の設計: `docs/plan/personas.md`（#114）。今は 2 体目以降も Claude で動く（入口 #<NAME>・/new の persona・#<NAME> の session_open まで）。codex のエンジンはまだ無い
- 定型チャンネル（領収書・予定など）・#inbox からの引き渡し・画像の受け取り・スキルの設計: `docs/plan/routines.md`（#119。今は DB の表とストア（PR-R1）と画像の受け取り（PR-R2）まで。定型チャンネルの振る舞いはまだ無い）
- GitHub の通知を #github に流し、Claude Code のセッションに渡す設計: `docs/plan/github-notifications.md`（#122。段 1（ポーリングと #github。PR-G2）と、段 2・3 を Claude Code のセッションへの送信の上に載せ替えたもの（claude-code-sessions.md の CC6。#github と Web の GitHub のタブの [対応]・[起動して送る]。SELF_AGENT_CC=1 のときだけ）まで）
- シェル（Bash）を使えるようにする設計: `docs/plan/shell.md`。`SELF_AGENT_SHELL=1` のときだけ、セッションのチャンネルのプロジェクトの中で SDK の sandbox（bwrap）付きの Bash を使える（自己診断が通らなければ止める）。受け入れの実機確認は `npm run shell-check`
- サーバー上で動く作業ジョブ（Discord から頼むとリポジトリを実装して draft PR を返す）の設計: `docs/plan/coding-jobs.md`（#129。保留（2026-11-01）。PR-J4 は畳む（docs/plan/unify.md §8 の 5）。今あるのは設定・DB の表・状態の遷移と #jobs の文面（PR-J1）、host 側の git と gh の包み（PR-J2）、ジョブの進行・#jobs・`/job`・ボタンと偽 Runner の dry-run（PR-J3）まで。ジョブ用の runner（PR-J4）は作らないので `SELF_AGENT_JOBS=1` は設定エラーのまま）
- 他の Discord サーバーで、オーナー以外の人にツールなし・Opus 5.5 low で答える「ゲスト利用の簡易モード」の設計: `docs/plan/guest-mode.md`（#147。v3。ゲスト専用の Bot・API キー認証・サーバーの許可（メインサーバーの `/guests invite` で発行する認証コードを、ゲストのサーバーの管理者が定型文への返信で貼る。DB `guest_guilds`）と `/guest on` の二段構え。今は GU4b まで（運用の手順と接続の知らせは GU3）。`SELF_AGENT_GUEST_GUILD_IDS` は廃止で、残っていれば設定エラー
- 配布（npm）・入口の統一・Mac 対応の設計: `docs/plan/distribution.md`（#157）。Web UI（tailnet の中のブラウザから使う VS Code 風の Web アプリ。別ポート・`Tailscale-User-Login` 必須）の設計: `docs/plan/web-ui.md`（#157。v2。段 W1〜W8 は #162〜#173。今は W7 まで実装済み（ジョブの画面 W8 は、作業ジョブを保留して PR-J4 を畳んだので作らない））
- この機械の Claude Code（CLI）の対話セッションを一覧・送信・起動し、許可の要求に Web・Discord から答える設計: `docs/plan/claude-code-sessions.md`（#191。設計は確定。Claude Code の質問（AskUserQuestion）を Discord・Web の選択肢で答え、セッションの知らせを #system に出さず要ったときにチャンネルを作る設計: `docs/plan/claude-code-questions.md`（#265。段 Q5・Q1〜Q4。
Q5 と Q1〜Q4 はすべて済み。Q4 は許可の要求・質問・判断待ちを #system に出さず、そのセッションの Claude Code のチャンネルに出す。無ければ ensureFor で作る（tmux の外も）。作れなければ log だけ。DB の cc_channels.origin に question・waiting（v39））まで。Q3・Q5 は別 PR）

CC9〜CC14 すべて済み（CC9〜CC14 は docs/plan/claude-code-channels.md。CC1 の状態の収集: claude agents --json の周期の読み取り・DB の cc_sessions・hook の受け口・`npm run cc-dry-run`・`npm run cc-setup -- --print`。CC2 の Web UI の一覧と画面の写し: `/api/cc/sessions`・`/api/cc/sessions/<id>`・一覧（CC9 から会話のサイドバーの群「Claude Code」）。CC3 の Web からの送信（複数行）: DB の cc_sends と待ち行列・`/api/cc/sessions/<id>/send`・`/api/cc/sends/<id>/cancel`・セッションのタブの入力欄。CC4 の起動: `SELF_AGENT_WORKSPACE_DIR` の直下に tmux の新しいセッションで claude を起動する `/api/cc/projects`・`POST /api/cc/sessions` と起動のダイアログ、最初の指示（cc_sends のペイン宛て）、DB の cc_sessions の started_by など（v29）。CC5a の許可の要求の保留と Web からの [許可]・[拒否]: DB の cc_permissions（v30）・cc/permission-hold.ts・`/api/cc/permissions`・セッションのタブの許可のカード。CC5b の「このセッションでは常に許可」: cc/permissions.ts の線引き・cc_permissions.always_rules（v31）・`/always`・カードのボタン。CC5c の Discord: #system の許可の要求の 1 通とボタン `cc:perm:allow|always|deny:<id>`（app/commands/cc.ts）・判断待ちの知らせ・self-agent が起動したセッションの終了（Q4 で #system をやめ、文面は cc/notice-text.ts）・DB の cc_permissions.message_id・cc_sessions.notified_at（v32）・`SELF_AGENT_CC_NOTIFY`）。CC6 の GitHub の通知の [対応]: app/github-handoff.ts・`gh:` のボタン・`/api/github/<id>/act`・`/start`、DB の cc_sends.notification_id（v33）。CC7 の SDK のツール: cc_list・cc_send・cc_start と、頼んだチャンネルへの確認の投稿と [送る]・[起動する]・[やめる]（`cc:`。振り分けは app/commands/cc.ts。10 分で失効）・DB の cc_starts と cc_sends・cc_sessions の channel_id など（v34）。CC8 の返事を Discord に戻す（追いかけ）: cc/replies.ts・Stop の last_assistant_message・[追いかけをやめる]（`cc:unfollow:`）・`POST /api/cc/sessions/<id>/unfollow`・DB の cc_replies と cc_sessions の follow の列・cc_sends の reply_state（v35）。段 CC1〜CC8（CC5 は a〜c に分ける）。作業ジョブの PR-J4 は畳んだ（保留））。会話欄への統合とセッションごとの Discord のチャンネルの設計: `docs/plan/claude-code-channels.md`（#236。段 CC9〜CC14。設計は確定。
CC9 は済（Web の会話のサイドバーの群「Claude Code」。アクティビティ「Claude Code」は消した）。CC10 も済（DB の cc_channels と guild_settings.cc_category_id（v36）・/setup のカテゴリ「Claude Code」・cc/channels.ts・手動の口（Web のセッションのタブの [Discord のチャンネルを作る] と `POST /api/cc/sessions/<id>/channel`・`/cc open`）・再同期・一覧から消えたら完了へ移し、同じ session_id が戻れば開き直す。CC11 も済（DB の cc_sends の origin に discord（v37。表の作り直し）・関わったら自動で作る（Web からの送信・起動の結びつけ・許可の応答・cc_send の [送る]・cc_start の [起動する]・[対応]。作れなくても元の処理は止めない）・チャンネルの発言を確認なしで cc_sends（origin discord。同じセッションに 5 件まで・1 pass で同じセッションに 1 件）に積んで届ける・外からの送信の写し・リアクションの印・返事はチャンネル優先（[追いかけをやめる] 無し・1 日 200 通）・`/cc cancel`）。CC12 も済（許可の要求・判断待ちはチャンネルがあればそこへ（#system には出さない。cc/channel-posts.ts と permission-hold.ts の複数の受け手）・端末・RC から打った指示の写し「（端末か RC から HH:MM）」（先頭 1,000 字。self-agent が届けたものは写さない）・SELF_AGENT_CC_NOTIFY=0 でもチャンネルには出す）。CC13 も済（終わったチャンネルの発言は、セッションが一覧にあれば（/cc close で閉じただけ）開き直して積み、無ければ積まずに [起動して続ける][やめる]（`cc:resume:`。ended → resuming の compare-and-set・そのセッションの cwd（直下だけ）で starter.launch・結びついたら session_id を付け替えて open・topic の書き換え（Gateway の setChannelTopic）・起動の失敗・結びつけられなければ ended に戻す・再起動で resuming は ended に）・`/cc close`（届け待ちも取り消す）・終わってから SELF_AGENT_DELETE_AFTER_DAYS 日の削除の確認（open に戻すと確認を外す）（#system の `cc:del:`・`cc:del:keep:`）・終了の文を §3.6 の文に）。CC14 も済（Web の会話のタブ: history にチャンネルの行（オーナーの発言・写しは owner、返事は agent、許可の要求とその結果・判断待ち・届かなかった・終わった・戻った・閉じたは notice、[起動して続ける] は divider）・`/api/channels` の kind cc・`/turns`・`POST /messages` は /send と同じ経路で積む（cc/channels.ts の submitWeb）・`POST /api/cc/channels/<id>/close`・群「Claude Code」のチャンネルのある行は会話のタブ（ch:<id>）・未読の点）。会話のサイドバーの群「Claude Code」（アクティビティは消す）、オーナーが関わった（Web から送った・起動した・許可に答えた・[送る]/[起動する]・[対応]）ときに自動で作るカテゴリ「Claude Code」の `cc-<名前>` のチャンネル、そこへの発言を確認なしで cc_sends（origin discord。5 件まで）に積みリアクションで印、返事・許可・判断待ち・終了はそのチャンネルへ、外からの送信と端末・RC の指示の写し、終わったら完了カテゴリへ移して削除の確認、戻れば開き直し、終わったチャンネルの発言は [起動して続ける]、`/cc open|cancel|close`、Web の会話のタブ（history）。DB は v36〜v37）
- Web UI の見た目の決まり（色・型・間隔・部品・動き・言葉・a11y・AI っぽさの禁止。性格は A「夜勤の計器盤」）: `docs/design/WEB-UI-GUIDELINES.md`（#225）。今の画面との差と段 UI-1〜UI-6（順は UI-6 → UI-1 → UI-2 → UI-3 → UI-4 → UI-5）: `docs/plan/web-ui-polish.md`。PWA は `docs/plan/web-ui.md` §11（#224。https の tailscale serve だけが対象）。UI-1〜UI-6 はすべて済み。スマホの第 2 回（#248。fix・UI-7〜UI-12）は同じファイルの §5 で、すべて済み（実機での確認は polish.md §5 の「実機で確かめること」）
- 入口によらず同じエージェントにする（self-agent と Claude Code の統合）設計: `docs/plan/unify.md`（#277）。今は U1 まで（プロジェクトのセッション: `/new project:<名前>` か Web の「新しいセッション」のプロジェクトで、`SELF_AGENT_WORKSPACE_DIR` の直下のプロジェクトを cwd に Claude Code と同じ装備（preset のシステムプロンプト・CLAUDE.md・skills・Bash）で動くセッションを作る。許可は canUseTool → そのチャンネルと Web の許可のカードで答え、待つ間はターンの打ち切りを止める。`SELF_AGENT_CC=1` と `npm run unify-setup -- --print` の link が要る。質問・/mode は U2）
- 旧 Rust 版の資料は `docs/archive/`（参照のみ）

## コマンド

```bash
source ~/.nvm/nvm.sh      # 非対話シェルでは毎回必要（Node 24.20.0）
npm ci                    # 依存インストール（package-lock.json どおり）
npm run check             # 型チェック（tsc --noEmit）
npm test                  # 単体テスト（test/*.test.ts。偽 Runner / 偽 Gateway / 一時 SQLite）
npm run test:integration  # 結合テスト（OAuth トークンが無ければ skip。あれば利用枠を消費する）
npm start                 # 起動（node src/cli.ts start。必須の環境変数が欠けていれば変数名を出して exit 1）
node src/cli.ts <sub>     # self-agent コマンドの入口（./bin/self-agent <sub> も同じ。sub は start / devlog / usage / guest-setup / github-dry-run / shell-check / job-dry-run / cc-dry-run / cc-setup / unify-setup / measure、ほかに --help・--version。env ファイル（SELF_AGENT_ENV_FILE、無ければ ~/.config/self-agent/env。既にある変数は上書きしない）を読んでから動かす。サブコマンドが無い・知らない名前・引数付きの start は exit 2。npm run * は今までどおり scripts/ の入口から同じ本体を呼ぶ）
npm run measure           # P0 実測（本体と同じ Options・ツールで 2 ターン。OAuth トークン必須。利用枠を消費する）
npm run devlog            # dev モードの会話ログを 1 ターンずつ表示（-- [--date YYYY-MM-DD] [--kind inbox|tasks|session] [--channel <id>] [--persona <id>] [--last N]。既定は今日・全部。トークン不要）
npm run usage             # ターンごとのトークン（キャッシュの読み・書き）を 1 ターン 1 行で表示（-- [--date YYYY-MM-DD] [--last N] [--kind <種類>] [--steps]。既定は今日・最後の 20 件。DB は読み取り専用で開く。トークン不要）
npm run github-dry-run    # GitHub の通知を 1 回だけ取得して振り分け、赤・黄・白の件数だけを表示（gh のログインを使う。投稿しない・DB も GitHub の既読も変えない）
npm run shell-check       # シェル（Bash）の受け入れの実機確認（docs/plan/shell.md §7。本体と同じ runner・Options で決めたコマンドを 1 つずつ Bash で実行させ、通った・通らないを表で出す。自己診断が通らなければ試さない。OAuth トークン必須。利用枠を消費する）
npm run job-dry-run       # 作業ジョブのアプリ側を LLM なしで 1 回（-- --repo <owner/repo> [--issue <n>]。決まったファイルを commit する偽 Runner で、準備 → 取り込み → 検査 → push → draft PR まで実際に行う。gh のログインを使い、ネットに出る。Discord には出さない）
npm run guest-setup       # ゲストの 2 つの変数（SELF_AGENT_GUEST_DISCORD_TOKEN・SELF_AGENT_GUEST_API_KEY）を端末で対話式に訊き（サーバー ID は訊かない。廃止した SELF_AGENT_GUEST_GUILD_IDS の行があれば消すか確認する）、Discord と Claude に実際に通るか確かめてから ~/.config/self-agent/env に書く（-- [--skip-check] で確認を飛ばす。控えは env.bak。反映は再起動。トークン・キーは画面に出さない。ネットに出る）
npm run cc-dry-run        # この機械の Claude Code のセッションを 1 回だけ読み（claude agents --json と ~/.claude の補助。claude は ~/.local/bin か /usr/local/bin・/usr/bin（ほかは PATH）から）、判断待ち・実行中・待機の件数と各行の状態・名前・最後の活動の時刻を表示（docs/plan/claude-code-sessions.md。hook の事象は使わない。sessionId・cwd は出さない。投稿しない・DB を変えない・hook の受け口を立てない。`-- --reset-multiline` のときだけ、一覧は読まずに DB の cc_state.multiline_ok を 1 に戻す（Web からの送信が複数行を止めた後、実機で確かめ直したとき。ほかは変えない・移行しない））
npm run cc-setup -- --print # ~/.claude/settings.json に足す hooks の設定（5 つの事象の http hook と env。ポートと PermissionRequest の timeout（SELF_AGENT_CC_PERMISSION_HOLD_SEC と SELF_AGENT_CC_QUESTION_HOLD_SEC の大きい方 + 5）を埋め、トークンの値は置き場所の文にする）を標準出力に出す（ファイルは書かない。--print が無ければ使い方で exit 2、SELF_AGENT_CC_HOOK_PORT が無ければ exit 1）
npm run unify-setup -- --print # プロジェクトのセッション（docs/plan/unify.md §5.3）のために、CLAUDE_CONFIG_DIR の skills・agents を ~/.claude の同じ名前への symlink にする `ln -s` の行（CLAUDE_CONFIG_DIR が無ければ先に mkdir -p）を標準出力に出す。済んだものは「済」、~/.claude に無いものは先にその mkdir -p の行、symlink でないもの・向きの違うものは理由の文（ファイルは書かない。--print が無ければ使い方で exit 2。CLAUDE.md は link しない（~/.claude/CLAUDE.md は CONFIG_DIR によらず読まれる））
npm run make-icons        # Web UI のホーム画面のアイコン（app-icon.svg と 4 つの PNG）を scripts/make-icons.ts で src/web/static/ に書き直す（依存なし。図形を変えたら走らせて commit する。npm test が commit したものと一致するか確かめる）
```

## ディレクトリ構成

各ファイルの役割は [docs/directory-structure.md](docs/directory-structure.md) にある。必要な箇所だけ grep して読む。

- `src/` 本体、`test/` テスト、`scripts/` 補助スクリプト、`docs/` 仕様（REQUIREMENTS.md, design/, research/, archive/, plan/）
- CLAUDE.md は毎回すべて読み込まれるので、ファイルの説明はここに足さず docs/directory-structure.md に書く

## 環境変数

一覧は [docs/environment.md](docs/environment.md) にある。変数を足したらそちらに書く。

## コーディング規約

- erasable な TypeScript のみ（enum / namespace / parameter properties 禁止）。ビルドせず `node` で直接実行する（tsconfig は型チェック専用）
- 相対 import は `.ts` 拡張子付き
- 依存は最小限、バージョンは exact 固定
- public リポジトリなので、トークン・ID・個人情報をコードやログに書かない
- ローカルのログ（console）にはサーバー ID を出してよい。チャンネル ID・ユーザー ID・本文・トークンは出さない（例外: /new でチャンネルを作った後に DB 保存に失敗したときは、手で消せるよう作ったチャンネルの ID を出す）
- dev モードの会話ログ（`<SELF_AGENT_DATA_DIR>/devlog/`）は例外として本文・チャンネル ID を含む（ローカルのファイル。リポジトリには入れない）。console のログには、その中身・パスを出さない

## プロンプトキャッシュの規則

- システムプロンプトは静的に保つ。日時や ID などの可変値を入れない
- システムプロンプトは `{ type: "custom", prompt, snapshot: false }` で渡し、SDK に記録させない（毎回今の SYSTEM_PROMPT を送る）。既定（記録する）に戻すと各セッションの最初の記録に戻るので戻さない
- ツール集合は全セッション共通で固定する
- 会話履歴は追記のみ（途中を書き換えない）
- モデルと effort はセッション途中で変えない
- キャッシュ効果の計測は result の `modelUsage` の差分で行う
- システムプロンプトの変更は全セッションの次のターンから効き、そのターンだけ全セッションで 1 回キャッシュが外れる（#69 で実測）。ツールの description も毎ターン送られるので同じ。どちらも変更はまとめて行う。会話の中の古い返事の癖まで消したいときは /renew
- プロジェクトのセッション（docs/plan/unify.md。agent/project-profile.ts）は例外: Claude Code の preset のシステムプロンプト（cwd・git の状態などの動的な節を含む）に PROJECT_APPEND を足して snapshot: true で会話ごとに固定し、settingSources（user・project・local）と CLI の既定のツールを使う。軽いモード（#inbox・#tasks・今までのセッション）の Options は変えない
- CC7（cc_list・cc_send・cc_start のツールとシステムプロンプトの 1 行）を入れた再起動の後は、全セッションの次のターンで 1 回キャッシュが外れる（SELF_AGENT_CC が無効でも同じ。ツールは無効でも定義するため）
