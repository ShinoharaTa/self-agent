# コマンド

毎日使うものと、気を付ける点の 1 行は `CLAUDE.md` の「コマンド」。ここは各コマンドの細かい説明（引数・読む物・書く物・exit code）。

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
npm run vendor-web        # Web UI の部品が使う Preact と htm（devDependencies）の ESM を scripts/vendor-web.ts で node_modules から src/web/static/vendor-preact.js・vendor-preact-hooks.js・vendor-htm.js に書き直す（手で直さない。版を上げたら走らせて commit する。npm test が commit したものと一致するか確かめる。ライセンスは THIRD_PARTY_LICENSES.md）
npm run ui-shots -- --out <dir> # Web UI の決まった画面を、作り物のデータの一時 DB と本物の Web サーバー（127.0.0.1 の空きポート）で、playwright-core のヘッドレス Chromium で <dir> に PNG と console.log として撮る（[--only <名前の一部>]。<dir> はリポジトリの外だけ。Discord・Claude・GitHub に出ない・env ファイルと本番の DB を読まない。Chromium が無い・--only に合う画面が無い・途中の段が失敗したときは exit 1。SIGINT・SIGTERM・SIGHUP でも閉じて 130・143・129。幅の検査は仮名が全角の等幅の字（この機械では IPAGothic）が要る。無ければその段が失敗）
```
