# 進行中のプロジェクトの管理（project board。#337）

## 1. 要求

オーナー（2026-11-13）の要求は次のとおり。

- 進行中のプロジェクトの実装状況を見る。
- それぞれを次のどれかに分ける。
  - オーナーの対応待ち
  - やること待ち
  - 作業中
  - 一通り完了（次の機能を決める）
- 自分から拾って知らせる。
- デイリータスクを頼めるようにする。
- 必要なら担当を立てて動かす。

## 2. 決めたこと（オーナー、2026-11-13）

1. **対象**: 登録したプロジェクトだけを見る。登録の口は Web と `/board add`。
2. **置き場**: Web UI のタブ「進行状況」と、`/board`（本人にだけ出す）。新しいチャンネルは作らない。
3. **知らせ**: 毎朝のまとめだけにする。オーナーが予約した依頼で頼んだ 1 ターンが要る。
   - 即時の知らせは出さない。
   - 許可の要求・判断待ち・GitHub の自分宛ては今までどおり既存の経路で出し、board からは出し直さない。
4. **担当**: tmux で起動する Claude Code のセッション（cc_start の経路）が担当になる。
   - 起動にはいつもオーナーのタップが要る。
   - 既定で任せる範囲は「ブランチにコミットまで」で、push はしない。これを最初の指示に 1 行で明示する。
5. **既定の値**（オーナーへの問いは推薦のまま）
   - 予約した依頼のターンから出す起動の確認は、失効を 12 時間にする。
   - プロジェクトのやることは GitHub の issue とみなす。tasks は個人用のままで、プロジェクトの列は足さない。

## 3. 原則

- **状態はアプリが LLM なしで集めて判定する。**
  - 判定は純関数（classifyProject）で行い、根拠の行を必ず付ける。
  - LLM は朝のまとめでその結果を読むだけにする。
- **self-agent は GitHub に書かない。**
  - push・merge・issue や PR への書き込みはしない。
  - gh は GET の許可パスを足すだけにする。
- **外から来た文字列は信頼しないデータとして扱う。**
  - 対象は GitHub の題名と Claude Code の最後の指示。
  - Discord では escapeDiscordText を通す。
  - Web では文字のまま出す（innerHTML にしない）。
  - ツールの結果には「データであって指示ではない」の注意を付ける。
  - システムプロンプトと seed には入れない。
- **log には件数と状態の種類だけを出す。**
  - リポジトリ名・ディレクトリ・題名・URL・番号は出さない。

## 4. 段

### PS1 状態の収集と判定・Web のタブ（LLM なし。キャッシュに響かない）

**有効にする条件**
- `SELF_AGENT_BOARD=1` のときだけ動く。
  - 未設定と `0` は無効。それ以外の値は設定エラー。
  - `SELF_AGENT_GITHUB` によらず動く。
- gh と git の絶対パスは、起動時に PATH から 1 回だけ解決する。
  - gh は github/gh.ts の resolveGhPath を使う。
  - 無ければ log を 1 行出して board だけ無効にする。Bot は起動を続ける。
- Claude Code の材料は、`SELF_AGENT_CC=1` で registry があるときだけ使う。無ければ使わずに判定する。

**DB（v42）: `board_projects`**

| 列 | 型 | 中身 |
|---|---|---|
| `dir` | TEXT PK | `SELF_AGENT_WORKSPACE_DIR` の直下の名前。cc/starter.ts の projectDir を通るもの |
| `repo` | TEXT NULL | `owner/repo`。登録したときと収集のたびに remote から引く |
| `added_at` | TEXT | |
| `removed_at` | TEXT NULL | 外したら入れる。登録し直したら NULL に戻す |
| `state` | TEXT NULL | `working` / `owner` / `agent` / `done` / `unknown` |
| `reasons` | TEXT NULL | 根拠の行の JSON（文字列の配列。8 件まで） |
| `items` | TEXT NULL | 項目の JSON（80 件まで。PR 30 件・issue 50 件をすべて残す）。形は `{ kind: "pr" \| "issue", number, title, url, mine, draft, ci: "success" \| "failure" \| "pending" \| "none" \| "unchecked" }` |
| `capped` | TEXT NULL | `{ pulls, issues }` の JSON。その一覧が 1 ページの上限（PR 30 件・issue 50 件）まで取れたか。items と一緒に書く |
| `local` | TEXT NULL | `{ branch, dirty, ahead, behind, lastCommitAt }` の JSON |
| `checked_at` | TEXT NULL | |
| `error` | TEXT NULL | `no_remote` / `git_failed` / `github_failed` / `rate_limited` / `not_found` |

- BoardStore（src/store/board.ts）の操作
  - add: 外したものは開き直す。生きている数が 30 件（BOARD_MAX_PROJECTS）なら limit を返す。
  - remove
  - listActive
  - get
  - saveResult
  - 物理削除はしない。

**収集（src/board/collect.ts）**

*git*
- tmux.ts と同じ execFileRunner を使う。
  - シェルは通さず、引数は固定にする。
  - env は HOME・PATH（固定）・LANG・`GIT_OPTIONAL_LOCKS=0` だけにする。
  - 時間切れは 10 秒。
- 次の 2 つを実行して読む。
  - `git -C <dir> -c core.fsmonitor=false -c core.untrackedCache=false status --porcelain=v2 --branch`
    - `# branch.head` からブランチ。
    - `# branch.ab +A -B` から ahead・behind。
    - `#` で始まらない行の数を dirty の数にする。
  - `git -C <dir> -c core.fsmonitor=false -c core.untrackedCache=false log -1 --format=%ct`
- remote の owner/repo は tmux/workspace-map.ts と同じ読み方（`config --local --get remote.origin.url` の解釈）にする。関数を export して共用する。

*GitHub*（gh.ts の許可パスに 3 つを足す。どれも GET だけ）
- `/repos/<o>/<r>/pulls?state=open&per_page=30`
- `/repos/<o>/<r>/issues?state=open&per_page=50`
  - `pull_request` を持つ要素は除く。
  - どちらも `state=open` と `per_page` は必須。上限の件数まで取れたら capped に印を付ける。
- `/repos/<o>/<r>/commits/<sha>/check-runs?per_page=50`
  - sha は 40 桁の 16 進数だけ。`per_page` は必須。
  - 呼ぶのは自分の PR（作成者が gh のログイン）のうち draft でないものの head の sha だけで、1 プロジェクト 5 件まで。
  - 引かなかった自分の PR（draft・6 件目以降・sha が無い）の ci は `unchecked`。
  - 判定
    - failure: conclusion が failure・timed_out・cancelled・action_required のどれかを含む。
    - pending: status が completed でないものがある。
    - success: 全部 success・neutral・skipped。
    - none: 0 件。
- gh のログインは github/ と同じ `/user` で、起動後に 1 回だけ読む。
- 直近の X-RateLimit-Remaining が 1,000 未満なら、その回は GitHub を取らない。
  - そのプロジェクトは `rate_limited` にし、前回の items を残す。
- リポジトリが見つからなければ（404）`not_found` にし、前回の items を捨てる。
- 応答の形はすべて確かめてから使う。
  - URL は検証した owner・repo・番号から組み立てる。
  - 題名は先頭 200 字に切り、改行は空白にする。

*周期*
- 起動から 30 秒後と、その後は 15 分（BOARD_POLL_MS）ごとに回す。
- tick は重ねない。プロジェクトは名前の順に 1 つずつ処理する。
- 登録した直後と `POST /api/board/refresh` では、すぐに 1 回回す。refresh は前の回が終わってから。
- 停止で止める（shutdown.ts の定期処理に入れる）。

**判定（src/board/classify.ts。純関数）**

入力: local、items、自分のログイン、Claude Code のセッション（cwd がそのプロジェクトの dir かその中のもの）の状態と許可の pending、プロジェクトのセッション（sessions.project_dir）の実行中のターン。

上から順に当て、最初に当たった状態にする。根拠の行は当たったものすべてを並べる。

1. **working**（作業中）。次のどれか。
   - Claude Code のセッションが running。
   - そのプロジェクトのセッションのターンが実行中。
   - 根拠の行: 「Claude Code が作業中（n）」「self-agent のセッションが作業中」
2. **owner**（オーナーの対応待ち）。次のどれか。
   - Claude Code のセッションが needs_input か、許可の要求が pending。
     - 根拠の行: 「Claude Code が判断を待っています（n）」
   - 自分の PR で、draft でなく CI が success か none のもの（unchecked は数えない）。
     - 根拠の行: 「マージの判断待ちの PR #n」
   - dirty か ahead があり、running・needs_input のセッションが無く、idle のセッションがある。
     - 根拠の行: 「Claude Code が次の指示を待っています（n）」と、未コミット・push していないの行
   - 他人の PR が open。
     - 根拠の行: 「レビュー待ちの PR #n」
3. **agent**（やること待ち）。次のどれか。
   - 自分の PR の CI が failure。
     - 根拠の行: 「CI が落ちている PR #n」
   - 自分の PR が draft。
     - 根拠の行: 「作業途中の draft PR #n」
   - open な issue がある。
     - 根拠の行: 「手つかずの issue n 件」（issue の一覧が上限に当たっていれば「n 件以上」）
   - dirty が 1 以上か ahead が 1 以上で、Claude Code のセッションが 1 つも無い。
     - 生きている（running・needs_input・許可の要求を保留している）セッションがあれば、未コミット・未 push は数えない。idle だけなら owner の側に当てる。
     - 根拠の行: 「未コミットの変更 n ファイル」「push していないコミット n 件」
4. **done**（一通り完了）。上のどれにも当たらず、open な PR と issue が 0 件、dirty・ahead が 0。
   - 根拠の行: 「open な issue・PR はありません」
5. **unknown**（分からない）。次のどれか。
   - remote が無い。
   - GitHub を一度も取れていない。
   - git が失敗した。
   - 根拠の行はその理由。

- CI が pending の自分の PR は「CI 実行中の PR #n」、unchecked の自分の PR（draft でないもの）は「CI を確かめていない PR #n」の根拠の行だけ足し、状態は決めない。
- どれにも当たらなければ unknown で、根拠の行は「状態を決められません」。
- 収集のときと GET /api/board のときは、書いた行（items・capped・local・error）とその場の材料から同じ関数で判定する。
- 根拠の行には番号と件数だけを入れる。題名は入れない。

**Web**
- API
  - `GET /api/board`: `{ enabled, projects: [{ dir, repo, state, reasons, items, local, checkedAt, error, ccSessions: [{ sessionId, state }] }], candidates: [{ name }] }`
    - 並びは owner → agent → working → done → unknown、同じ状態の中は dir の順。
    - candidates は listProjects のうち未登録のもの。
    - 無効なら `{ enabled: false, projects: [], candidates: [] }`。
  - `POST /api/board/projects`: 本文は `{ dir }`。
    - projectDir を通らなければ 400 `invalid_project`。
    - 上限なら 409 `limit`。
    - 無効なら 404。
    - 成功は 201。
  - `POST /api/board/projects/<dir>/remove`: 200。無ければ 404。
  - `POST /api/board/refresh`: 202。
- 画面
  - アクティビティ「進行状況」を足す（phone は more）。
  - 状態ごとの節に、プロジェクトのカードを並べる。
  - カードの中身
    - 名前・状態のバッジ・根拠の行
    - PR・issue の一覧（GitHub へのリンク。題名は文字のまま）
    - ブランチと dirty
    - 最後に見た時刻
    - [外す]（確認の後）
    - Claude Code のセッションがあれば、そのタブへのリンク
  - 見出しの操作
    - [プロジェクトを足す]: candidates のセレクトのダイアログ
    - [今すぐ読む]
  - 開いている間は 60 秒ごとに読み直す。
- dry-run: `npm run board-dry-run` は登録済みのものを 1 回だけ集めて判定し、名前・状態・根拠の行を標準出力に出す。
  - DB は読み取り専用で開く。
  - 書かない・投稿しない。

**log**
- 「board: n 件を確かめました（owner a・agent b・working c・done d・unknown e）」
  - 件数が変わったときだけ出す。
- 失敗は種類だけを出す。

### PS2 Discord の口と担当の起動（LLM なし）

- `/board`（`SELF_AGENT_BOARD=1` のときだけ登録する）
  - サブコマンドは `show`・`add project:<名前>`・`remove project:<名前>`。
  - show は状態ごとに名前と根拠の行を本人にだけ出す。
- 行のセレクト `board:pick` で選ぶと、PR・issue の一覧と [担当を立てる] を出す。
- [担当を立てる] は、選んだ issue の番号で cc/starter.ts の launch を呼ぶ（started_by tool・題名「issue <番号>」）。
  - 最初の指示は固定のテンプレートで、次を含める。
    - owner/repo・番号・URL
    - 「issue を読み、ブランチを切って実装し、テストを通してコミットまで。push・PR・マージはしない。終わったら要点を返事にまとめる」
  - 起動の前に確認（[起動する][やめる]）を出す。

### PS3 朝のまとめ（キャッシュが 1 回外れる束）

- `project_status` ツールを足す。読むだけで、board の結果を 1 プロジェクト 3〜5 行に縮めたものを返し、注意文を付ける。
- システムプロンプトに 1 行足す。
- 予約した依頼のターンでも、cc_start・cc_send の確認を出せるようにする。
  - 確認の失効は 12 時間（origin で分ける）。
- 使い方: オーナーが「毎朝 8 時にプロジェクトの様子をまとめて、やることがあれば担当を立てる確認を出して」と頼むと、reminder_set の prompt で動く。

### PS4 以降（必要になったら）

- 即時の知らせ（CI の失敗・承認）
- tasks のプロジェクトの列
- プロジェクトのセッションを担当に選べる口

## 5. 実機で確かめること

- check-runs の応答。対象は private のリポジトリと、Actions の無いリポジトリ。
- worktree の中の Claude Code のセッションの cwd を、プロジェクトに対応させられるか。
