# 環境変数

| 変数名 | 用途 |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` / `DISCORD_TOKEN` | 必須。OAuth は `claude setup-token` で発行。権限 600 の `~/.config/self-agent/env` に置く（start / test:integration / measure が読む）。コミット禁止 |
| `SELF_AGENT_ALLOWED_GUILD_IDS` | 必須。動作を許可するサーバー ID（カンマ区切り）。これ以外のサーバーと DM には一切反応しない |
| `SELF_AGENT_OWNER_ID` | 必須。受け付けるオーナーの ID（数字 17〜20 桁。それ以外は設定エラー） |
| `SELF_AGENT_INBOX_CHANNEL_ID` | 任意。/setup 前の fallback。/setup を実行していないサーバーで #inbox とみなすチャンネルの ID（数字 17〜20 桁。それ以外は設定エラー。/setup 後はそのサーバーでは使わない） |
| `SELF_AGENT_ENV_FILE` | 任意。`self-agent` コマンド（`node src/cli.ts`・`./bin/self-agent`）が読む env ファイルの場所。既定 `~/.config/self-agent/env`（空は無いものとする）。`npm run *`・`npm start` では node のフラグで既定の env を先に読むので効かない |
| `SELF_AGENT_NODE` | 任意。`bin/self-agent` が使う node。既定は PATH の `node` |
| `CLAUDE_CONFIG_DIR` | SDK の設定・セッション保存先。既定 `~/.local/share/self-agent/claude`。その中の skills・agents は `npm run unify-setup -- --print` で ~/.claude への symlink にする（プロジェクトのセッション） |
| `SELF_AGENT_WORKDIR` | エージェントの作業ディレクトリ。既定 `~/.local/share/self-agent/work`。CLI の cwd は `<これ>/cwd` |
| `SELF_AGENT_DATA_DIR` | SQLite（`self-agent.db`）と、受け取った画像の原本（`attachments/`。記録に結びつかなければ 30 日で消す）の保存先。既定 `~/.local/share/self-agent/data` |
| `SELF_AGENT_MODEL` | 使用モデル。既定 `claude-opus-5` |
| `SELF_AGENT_EFFORT` | `low` / `medium` / `high` / `xhigh` / `max`。未設定ならモデルの既定。変更は再起動で反映（Opus 5 は effort ごとにキャッシュが別なので、変更直後は各セッションの最初のターンだけキャッシュが効かない） |
| `SELF_AGENT_TZ` | 日時ヘッダのタイムゾーン。既定 `Asia/Tokyo` |
| `SELF_AGENT_MAX_CONCURRENT` | 同時に処理するターン数の上限。既定 2。セッションのチャンネルのターン（/close を含む）が同時に使えるのはこれ - 1 まで（最低 1）で、残りは #inbox・#tasks 用 |
| `SELF_AGENT_TURN_TIMEOUT_SEC` | 1 ターンの打ち切りまでの秒数。既定 300 |
| `SELF_AGENT_CHANNEL_OP_GAP_MS` | チャンネルのカテゴリ移動の間隔（ミリ秒、全サーバー共通で直列）。既定 2000 |
| `SELF_AGENT_SHUTDOWN_GRACE_SEC` | 停止時（SIGINT / SIGTERM）に進行中のターンを返信まで待つ上限の秒数。既定 30。待つ間は新しい発言・操作を受け付けない。2 回目のシグナルでは待たずに終了する |
| `SELF_AGENT_IDLE_HOURS` | 進行中のセッションを、最後の発言からこの時間（正の整数、時間単位）経ったら待ちに移す。既定 12 |
| `SELF_AGENT_AUTO_SESSION_PER_DAY` | #inbox から session_open で自動で作れるセッションの 1 日（`SELF_AGENT_TZ` の日付）あたりの数（正の整数）。既定 3。/new で作ったものは数えない |
| `SELF_AGENT_DELETE_AFTER_DAYS` | 完了からこの日数（正の整数）経ったセッションについて、チャンネルを削除するか #system で確認する。既定 30。[残す] を押すとその時点からまたこの日数後に確認する |
| `SELF_AGENT_INBOX_ROTATE_AT` | 毎日この時刻（`HH:MM`、`SELF_AGENT_TZ`）を過ぎたら #inbox と #tasks の会話をそれぞれ要約して新しいセッションに切り替える（/setup 済みのサーバーだけ）。既定 `04:00` |
| `SELF_AGENT_INBOX_MAX_INPUT_TOKENS` | #inbox・#tasks それぞれの直近の成功したターンの最後のステップの入力（input + cache read + cache creation。各ステップの合算ではない）がこれ（正の整数）を超えたら、次の tick でそのチャンネルに同じ切り替えを行う。既定 150000 |
| `SELF_AGENT_SERVE_PORT` | 任意。作ったプロジェクトの `site/` を配る静的サーバーのポート（1〜65535。`127.0.0.1` で待ち受ける）。これと `SELF_AGENT_PUBLIC_BASE_URL` のどちらかが無ければ作って URL で渡す機能ごと無効 |
| `SELF_AGENT_PUBLIC_BASE_URL` | 任意。プロジェクトの URL の前半（`http://` か `https://` で始める。末尾の `/` は除く）。URL は `<これ>/p/<slug>/`。ホスト名は env に置き、リポジトリには書かない |
| `SELF_AGENT_SERVE_ALLOWED_LOGIN` | 任意。設定すると、静的サーバーは `Tailscale-User-Login` ヘッダがこれと一致しない要求を 403 にする（tailnet を他人と共有しているときだけ使う） |
| `SELF_AGENT_SESSION_MAX_TURNS` | セッションのチャンネルの 1 ターンの手順（maxTurns）の上限（正の整数）。既定 40。#inbox・#tasks は対象外 |
| `SELF_AGENT_SESSION_TURN_TIMEOUT_SEC` | セッションのチャンネルの 1 ターンの打ち切りまでの秒数（正の整数）。既定 900。#inbox・#tasks は `SELF_AGENT_TURN_TIMEOUT_SEC` |
| `SELF_AGENT_DEV_MODE` | `1` で dev モード（run ごとの会話を `<SELF_AGENT_DATA_DIR>/devlog/<YYYY-MM-DD>.jsonl` に残す。`npm run devlog` で読む）。未設定か `0` なら無効。それ以外の値は設定エラー |
| `SELF_AGENT_DEV_LOG_DAYS` | dev モードの会話ログを残す日数（正の整数）。既定 30。今日（`SELF_AGENT_TZ`）からこの日数より前の日のファイルを tick で消す（dev モードでなくても、ディレクトリがあれば消す） |
| `SELF_AGENT_PERSONAS` | 任意。足す人格の id（`[a-z0-9]{1,12}`、カンマ区切り、10 個まで。`default` は予約）。未設定なら今と同じ 1 体だけ。人格ごとに `SELF_AGENT_PERSONA_<ID>_DISCORD_TOKEN`（必須。ID は大文字。ほかの人格・`DISCORD_TOKEN` と同じ値は不可）・`_NAME`（表示名。20 字以内、既定は id）・`_PROMPT_FILE`（人格の文。既定 `~/.config/self-agent/personas/<id>.md`）・`_ENGINE`（`claude` / `codex`、既定 claude）・`_MODEL`・`_EFFORT`。設定の誤りは変数名だけを出して起動しない。足した人格の Bot も同じプロセスで動かし、その人格が持ち主のチャンネル（persona_channels・sessions.persona）の発言に答える。ログインできなくても既定の人格は動き続け、#system に知らせる。/setup で入口の #<NAME> を作り、/new の persona か #<NAME> の session_open でその人格のセッションを作る。表示名から作るチャンネル名が空・inbox/tasks/system/github/jobs・人格どうしで重なるなら設定エラー。人格を足したら SELF_AGENT_MAX_CONCURRENT=3 を推薦。`_ENGINE=codex` は codex のエンジンができるまで Claude で動く |
| `SELF_AGENT_CODEX_HOME` | codex の認証と会話の記録の場所。既定 `~/.local/share/self-agent/codex`（codex の人格があるときだけ使う） |
| `SELF_AGENT_SHELL` | `1` でシェル（Bash）を有効にする（`docs/plan/shell.md`）。ツールに Bash を足し、セッションのチャンネルのプロジェクトがあるときだけ SDK の sandbox（bwrap）の中で使える。起動時と tick ごとに sandbox の自己診断をして結果を log と #system に出し、通らない間・bwrap か socat が無い run は sandbox を付けず Bash を拒否する。セッションのジョブの同時実行は 1 になり、#inbox・#tasks のターンはファイルのツールを使えない。システムプロンプトが変わるので、変えた直後は全セッションでキャッシュが 1 回外れる。有効にする前に `npm run shell-check` を通す。未設定か `0` なら何もしない（今までと同じ Options）。それ以外の値は設定エラー |
| `SELF_AGENT_GITHUB` | `1` で GitHub の通知の段 1（gh の今のログインで未読の通知を取り、自分宛て（赤）と自分のリポジトリの新しい Issue / PR（黄）を #github に流す。`docs/plan/github-notifications.md`）を有効にし、/setup が #github を作る。未設定か `0` なら何もしない。それ以外の値は設定エラー。gh のトークンは `~/.config/gh/hosts.yml` に保存されている必要がある（keyring のログインは読めない）。`SELF_AGENT_CC=1` も有効なら、自分のリポジトリと ~/workspace にあるリポジトリの通知に [対応]（そのリポジトリの Claude Code のセッションに対応依頼を送る・無ければ起動して送る）を付ける |
| `SELF_AGENT_GITHUB_POLL_SEC` | GitHub の通知のポーリングの間隔（秒、60 以上の整数）。既定 300。実際の間隔は直近の X-Poll-Interval との大きい方 |
| `SELF_AGENT_GITHUB_OWNERS` | 「自分のリポジトリ」とみなす持ち主（GitHub のユーザー名・org 名をカンマ区切り）。既定は gh のログイン 1 つ。黄（新しい Issue / PR）はここにあるリポジトリだけ |
| `SELF_AGENT_JOBS` | `1` で作業ジョブを有効にする（`docs/plan/coding-jobs.md`。/setup が #jobs を作り、/job と #jobs のボタンを足す）。`SELF_AGENT_SHELL=1` が無ければ設定エラー。**ジョブの runner（PR-J4）は畳んだ（保留。docs/plan/unify.md §8 の 5）ので、`1` にすると「作業ジョブはまだ使えません」の設定エラーのまま**。未設定か `0` なら何もしない。それ以外の値は設定エラー |
| `SELF_AGENT_JOBS_REPOS` | 作業ジョブの対象にできるリポジトリ（`owner/*` か `owner/repo` をカンマ区切り）。未設定なら gh のログインの `<login>/*`。設定して中身が無い（`,` だけなど）なら設定エラー |
| `SELF_AGENT_JOB_MAX_TURNS` | 作業ジョブの 1 run の手順の上限（正の整数）。既定 100 |
| `SELF_AGENT_JOB_TIMEOUT_MIN` | 作業ジョブの 1 run の時間の上限（分、1〜1440 の整数）。既定 45 |
| `SELF_AGENT_JOB_MODEL` / `SELF_AGENT_JOB_EFFORT` | 作業ジョブのモデル・effort（effort の値は `SELF_AGENT_EFFORT` と同じ）。未設定なら既定の人格と同じ |
| `SELF_AGENT_JOBS_REPO_MAX_MB` | 作業ジョブで clone するリポジトリの大きさの上限（MB、正の整数。GitHub の size）。既定 200 |
| `SELF_AGENT_GUEST_DISCORD_TOKEN` / `SELF_AGENT_GUEST_API_KEY` | ゲスト利用の簡易モード（`docs/plan/guest-mode.md`）。2 つ揃えば有効（2 つとも無ければ無効で、下の任意の変数も読まない。1 つだけは設定エラー）。トークンはゲスト専用の Bot のもの（`DISCORD_TOKEN`・人格のトークンと同じ値は設定エラー）、API キーは Claude Platform のもの（ゲストの子プロセスにだけ `ANTHROPIC_API_KEY` として渡す。config は有無だけ）。トークンと API キーは `~/.config/self-agent/env` に置く。コミット禁止。サーバーの許可は DB（guest_guilds）で持ち、メインサーバーの `/guests invite` で発行した認証コードを、ゲストのサーバーの管理者が定型文への返信で貼ると許可される。今は GU4b まで（許可済みのサーバーの、コードを貼ったチャンネルと /guest で有効にしたチャンネルで、ゲスト Bot へのメンション・返信にツールなしで答える）。`npm run guest-setup` で対話式に書ける（2 項目） |
| ~~`SELF_AGENT_GUEST_GUILD_IDS`~~ | 廃止（v3）。残っていれば（空・空白だけは無いものとして通す）「~/.config/self-agent/env から消してください」の設定エラーで起動しない。`npm run guest-setup` でも消せる。v23 までに有効なチャンネルのあったサーバーは DB の移行（v24）で許可済みとして引き継ぐ |
| `SELF_AGENT_GUEST_MODEL` / `SELF_AGENT_GUEST_EFFORT` | ゲストのモデル（既定 `claude-opus-5-5`）・effort（既定 `low`。値は `SELF_AGENT_EFFORT` と同じ） |
| `SELF_AGENT_GUEST_TURNS_PER_DAY` / `SELF_AGENT_GUEST_USER_TURNS_PER_DAY` | ゲストのターン数の上限（正の整数）。サーバーごとの 1 日（`SELF_AGENT_TZ`）で既定 300、ユーザーごと（サーバーごと）の 1 日で既定 50。/guest status の残り回数はサーバーの方 |
| `SELF_AGENT_GUEST_MAX_CONCURRENT` / `SELF_AGENT_GUEST_TURN_TIMEOUT_SEC` | ゲストのターンの同時実行（既定 1）・1 ターンの打ち切りまでの秒数（既定 120）。正の整数 |
| `SELF_AGENT_GUEST_SESSION_MAX_TURNS` / `SELF_AGENT_GUEST_SESSION_MAX_INPUT_TOKENS` | ゲストのチャンネルの SDK セッションを捨てるターン数（既定 30）・直近の成功したターンの最後の入力（既定 60000）。正の整数。作ってから 24 時間でも捨てる |
| `SELF_AGENT_WEB_PORT` / `SELF_AGENT_WEB_ALLOWED_LOGIN` | 任意。Web UI（`docs/plan/web-ui.md`。今は W7 までと Claude Code の画面（CC14 まで））のポート（1〜65535。`127.0.0.1` で待ち受ける。tailnet には `tailscale serve --bg --https=9444 http://127.0.0.1:<port>` で出す）と、通す `Tailscale-User-Login`（完全一致）。2 つ揃えば有効、片方だけなら無効（設定エラーではなく log 1 行）。範囲外のポート・空白だけのログインは設定エラー |
| `SELF_AGENT_WEB_TOKEN` | 任意。Web UI の `/login` に貼ると 30 日の Cookie（HMAC）を渡すトークン（空白を含まない 32 字以上。それ以外は設定エラー）。無ければ `/login` は 404 で、Tailscale のログインだけで通す。config は有無だけ持つ。`~/.config/self-agent/env` に置く。コミット禁止。差し替えると前の Cookie は通らない |
| `SELF_AGENT_WEB_HISTORY_DAYS` | Web UI の会話の履歴を残す日数（正の整数）。既定 90（scheduler の tick の pruneHistory がこれより前の history の行を消す） |
| `SELF_AGENT_CC` | `1` でこの機械の Claude Code のセッションの状態の収集を有効にする（`docs/plan/claude-code-sessions.md`。今は CC14 まで（Web の会話の群「Claude Code」とチャンネルの会話のタブ（CC9・CC14）。Discord から頼んだセッションの返事を頼んだチャンネルに戻す追いかけと、セッションごとの Discord のチャンネル（手動・関わったら自動で作る・発言を届ける・返事はチャンネル優先・許可の要求と判断待ちもチャンネルへ・端末・RC の指示の写し・終了と戻り・終わったチャンネルの [起動して続ける]・`/cc close`・削除の確認）を含む）: `claude agents --json` を周期で読んで cc_sessions に書き、hook の受け口で事象を受け、Web UI の会話のサイドバーの群「Claude Code」に一覧と画面の写しを出し、tmux の中のセッションに Web から送る（入力待ちのときだけ貼って Enter。作業中なら積んで待つ）、Web から `SELF_AGENT_WORKSPACE_DIR` の直下に tmux の新しいセッションで claude を起動する（tmux のサーバーが無ければ断る。trust のダイアログにはキーを送らず、端末か RC で答えてもらう）。PermissionRequest の応答を保留し、Web の [許可]・[このセッションでは常に許可]（Claude Code が規則を提案し、線引きを通ったときだけ）・[拒否] で答える（保留の間も端末・RC のダイアログは出ていて、そこで答えてもよい。一覧に無いセッションの要求は保留しないので、claude agents --json を読めない間は保留しない）。許可の要求・質問と 60 秒続いた判断待ちを、そのセッションの Claude Code のチャンネル（無ければ作る。`SELF_AGENT_CC_NOTIFY`）にボタン付きで出す（Discord でも [許可]・[常に許可]・[拒否] で答えられる。#system には出さない））。起動時に claude と tmux の絶対パスを解決し（`~/.local/bin` か `/usr/local/bin`・`/usr/bin`（ほかは PATH））、無ければ起動しない。`SELF_AGENT_CC_HOOK_PORT` と `SELF_AGENT_CC_HOOK_TOKEN` が要る（無ければ設定エラー）。未設定か `0` なら何もしない。それ以外の値は設定エラー。`SELF_AGENT_GITHUB=1` も有効なら #github・Web の GitHub のタブに [対応] を付ける（CC6） |
| `SELF_AGENT_CC_HOOK_PORT` | Claude Code の hook の受け口のポート（1〜65535。`127.0.0.1` で待ち受ける。tailscale serve には出さない）。`SELF_AGENT_CC=1` で必須 |
| `SELF_AGENT_CC_HOOK_TOKEN` | hook の共有トークン（空白を含まない 32 字以上。それ以外は設定エラー）。`SELF_AGENT_CC=1` で必須。同じ値を `~/.claude/settings.json` の `env` に置く（`npm run cc-setup -- --print`）。config は有無だけ持つ。`~/.config/self-agent/env` に置く。コミット禁止 |
| `SELF_AGENT_CC_POLL_SEC` | `claude agents --json` を読む周期（秒、5 以上の整数）。既定 10。誰も見ていない（Web UI の /api/cc/* を 30 秒読んでいない）ときは、保留中の事象がある間と送信の待ち行列が空でない間を除いて 60 秒。許可の要求を保留している間は 5 秒 |
| `SELF_AGENT_CC_PERMISSION_HOLD_SEC` | `PermissionRequest` の応答を保留する秒数（1〜600 の整数）。既定 300。この間に Web か Discord（そのセッションの Claude Code のチャンネル）で [許可]・[常に許可]・[拒否] が押されなければ空の本文を返す（端末・RC のダイアログはそのまま残る）。`npm run cc-setup` の PermissionRequest の timeout はこれと `SELF_AGENT_CC_QUESTION_HOLD_SEC` の大きい方 + 5 |
| `SELF_AGENT_CC_QUESTION_HOLD_SEC` | 質問（AskUserQuestion。`PermissionRequest` の hook で届く）の応答を保留する秒数（1〜1,800 の整数）。既定 900。この間に Discord・Web で答えなければ空の本文を返す（端末・RC のダイアログはそのまま残る。`docs/plan/claude-code-questions.md`）。`npm run cc-setup` の PermissionRequest の timeout は許可と質問の大きい方 + 5 |
| `SELF_AGENT_WORKSPACE_DIR` | Claude Code の新しいセッションを起動できる場所（`#` を含まない絶対パス。それ以外は設定エラー。既定 `~/workspace`）。直下の実際のディレクトリだけが候補（symlink・入れ子・self-agent の場所と重なるものは不可。作らない）。GitHub の通知の [対応] の地図（直下と 1 つ下の git の remote）と、[起動して送る] の起動の場所（1 つ下も可）にも使う |
| `SELF_AGENT_CC_MAX_SESSIONS` | 生きている `claude`（`claude agents --json` の数と、起動してまだ一覧に出ていないもの）の上限（正の整数）。既定 30。これ以上なら Web からの起動を断る（409 `limit`） |
| `SELF_AGENT_CC_SEND_WAIT_MIN` | Web から Claude Code のセッションに送ったものが入力待ちにならないとき、諦める（gave_up）までの分（正の整数）。既定 120 |
| `SELF_AGENT_CC_NOTIFY` | `0` で、許可の要求・質問・判断待ちの知らせのために Claude Code のチャンネルを作るのをやめる（`docs/plan/claude-code-questions.md` §5。Q4）。既定 `1`（チャンネルが無ければ作ってそこに出す）。`0` でも既にあるチャンネルには許可の要求・質問・判断待ち・終了・写しを出し、ボタンも効く。チャンネルの無いセッションの要求は Web と端末・RC で答える（保留の長さは同じ）。どちらでも #system には出さない。「関わった」ときに作るのは変わらない。それ以外の値は設定エラー |
