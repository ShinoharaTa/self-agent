# 作って URL で渡す（build & serve）

> 2026-10-07。オーナーの要望「Claude みたいにプロジェクトを起動して実装し、そのまま Tailscale 経由で提供してほしい。コードをそのまま貼ってくるのは違う」への実装仕様。
> 検討の経緯と案の比較（A: 静的な成果物だけ / B: + sandbox 付きの Bash / C: + 常駐のアプリサーバー）は本書の §11。

## 0. 目的
- オーナーが「〜を作って」と頼んだら、コードを Discord に貼らず、作って動く状態にし、スマホで開ける URL（tailnet 内の HTTPS）を返す。
- 守るもの: Bot のトークンと DB（記憶・ナレッジ）、同じユーザーで動く他のプロジェクトと常駐サービス、利用枠、プロンプトキャッシュ。

## 1. 決定事項（オーナー確認済み）
| 項目 | 決定 |
|---|---|
| 範囲 | 段 1（ファイル操作 + 静的な配信。シェル無し）→ 段 2（sandbox 付きの Bash で npm・ビルド）。常駐のアプリサーバー（C）はやらない |
| 配るもの | プロジェクトの `site/` だけ（静的）。1 ポートにパスでプロジェクトを分ける |
| 公開範囲 | tailnet の中だけ（`tailscale serve`、HTTPS、ポート 9443）。Funnel と operator は使わない |
| プロジェクトの寿命 | チャンネルとは別に残す。チャンネルを消してもプロジェクトと URL は残る。消すのは `/projects` の [削除する] を押したときだけ |
| ページからの外部通信 | 制限しない（CSP で外への通信を止めない）。外の API を呼ぶページも作れる |
| 1 ターンの上限 | セッションのチャンネルは 40 手順・900 秒。#inbox は今の 8 手順・300 秒。同時実行の枠のうち 1 つを #inbox 用に空けておく |

## 2. 配り方
- 静的サーバーを self-agent に内蔵する（`node:http`。依存は足さない）。`127.0.0.1:SELF_AGENT_SERVE_PORT` で待ち受ける。Bot の一部として Bot と一緒に動く。
- `SELF_AGENT_SERVE_PORT` と `SELF_AGENT_PUBLIC_BASE_URL` のどちらかが無ければ、機能ごと無効（サーバーを起動しない。project_open は `not_configured`）。
- ルーティング:
  - GET / HEAD だけ受ける（それ以外は 405）。
  - `/p/<slug>/<path>` → `<workDir>/projects/<slug>/site/<path>`。ディレクトリなら `index.html`。`/p/<slug>` は `/p/<slug>/` へ 301。
  - 404: DB に無い・削除済みの slug、パスの要素が `.` で始まる、`..` を含む（デコード後）、realpath が `site/` の外（symlink）、ファイルが無い。
  - `/` はプロジェクトの一覧（題名・更新日時・リンク。削除済みは出さない）。ほかの endpoint は置かない。
- ヘッダ: `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-cache`。Content-Type は拡張子から（html, css, js, mjs, json, svg, png, jpg, jpeg, gif, webp, ico, txt, map, wasm, woff, woff2。それ以外は application/octet-stream）。CSP は付けない（§1 の決定）。
- tailscale serve（オーナーが 1 回だけ打つ）: `sudo tailscale serve --bg --https=9443 http://127.0.0.1:8790`。確認 `tailscale serve status`、解除 `sudo tailscale serve --https=9443 off`。
  - 9443 は Funnel が使えないポート（Funnel は 443・8443・10000 だけ）なので、誤ってもインターネットに出ない。
  - URL は `<SELF_AGENT_PUBLIC_BASE_URL>/p/<slug>/`（例 `https://<host>.<tailnet>.ts.net:9443/p/kakeibo/`）。ホスト名は env に置き、リポジトリには書かない。
- 任意: `SELF_AGENT_SERVE_ALLOWED_LOGIN` を設定すると、`Tailscale-User-Login` ヘッダが一致しない要求を 403 にする（tailnet を他人と共有しているときだけ使う）。

## 3. 作業場所とプロジェクト
- ソースは `<workDir>/projects/<slug>/`、配るのは `<workDir>/projects/<slug>/site/` だけ。cwd は全チャンネルで workDir のまま。
- DB（user_version 13）: `projects(id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)` と、`channel_id` の部分 UNIQUE インデックス（`WHERE deleted_at IS NULL`）。
  - `title` は前後の空白を除いて 100 字まで。空なら slug。
  - セッションのチャンネル 1 つに、削除されていないプロジェクトは 0〜1 個（`/projects` で消した後は、同じチャンネルで新しく作れる）。#inbox には作らない。
  - 削除済みの slug も UNIQUE のまま残す（同じ URL が別のものを指さないように）。
- slug: project_open の `name` から作る。英小文字・数字・`-` だけにし（他の文字は `-`、連続する `-` は 1 つ、前後の `-` は除く）、3〜30 字に切る。3 字未満なら `app`。重複したら `-2`、`-3`…を付ける。
- チャンネルが削除されても（[削除する]・手で消したのを再同期で検出）プロジェクトは消さない。そのプロジェクトは編集できるチャンネルが無くなり、配信だけ続く。
- `/projects`: プロジェクトの一覧（題名・URL・元のチャンネル）を本人にだけ表示。各行に [削除する]（`proj:del:<id>`）→ 確認「<題名> を削除しますか？ URL は開けなくなります」[削除する]（`proj:confirm:<id>`）[やめる]。削除はディレクトリを消し、`deleted_at` を入れる。既に無いものは「古くなっています」。
- ディスクの上限（段 2 で入れる）: 1 プロジェクト 1 GB、合計 8 GB。

## 4. ツールとガード（段 1）
- 組み込み: `[WebSearch, WebFetch, Read, Write, Edit, Glob, Grep]`（この順で固定）。段 2 で末尾に `Bash` を足す。
- MCP: 既存の 11 個の末尾に `project_open` を足す。
- allowedTools に足す: `Read`・`Glob`・`Grep`・`Write`・`Edit`。可否は PreToolUse の hook で決める（下）。permissionMode は dontAsk のまま。
- PreToolUse の hook（`Read|Write|Edit|Glob|Grep`）:
  - パス（Read/Write/Edit は `file_path`、Glob/Grep は `path`。無ければ cwd）を絶対パスにし、存在する一番深い親の realpath で判定する。
  - Write / Edit: 対象がこのチャンネルのプロジェクトのディレクトリの中でなければ拒否。#inbox・プロジェクトの無いチャンネルでは拒否（「先に project_open を使う」）。
  - Read / Glob / Grep: 対象が `<workDir>/projects/` の中でなければ拒否。
  - 拒否の理由はモデルに返す。log には「ファイル操作を拒否しました（<ツール名>）」だけを出す（パスは出さない）。
- project_open（入力 `name`: 英語の短い名前、`title`: 表示名）:
  - #inbox・context の無いターン → `not_available`（「セッションのチャンネルで使う」）。サーバーの機能が無効 → `not_configured`。
  - このチャンネルにプロジェクトがあれば、それを返す（`existing`）。無ければ作り、`<slug>/site/` まで mkdir して返す（`created`）。
  - 返す内容: `dir`、`site_dir`、`url` と、作るときの注意:
    - 「ファイルは dir の中に書く。配られるのは site_dir の中だけで、入口は site_dir/index.html」
    - 「パスは相対で書く（`/` で始めない）。ページは `<url>` で開かれる」
    - 「localStorage のキーは slug で始める（全プロジェクトが同じオリジン）」
    - 「API キーや秘密をページに書かない。オーナーのタスク・記憶・ナレッジ・会話の中身は、頼まれない限りページに入れない」
    - 「ビルドやコマンドの実行はできない（段 1）。ライブラリは CDN から読む」
- システムプロンプトに足す行:
  - 「何かを作ってと頼まれたら、コードを返事に貼らない。セッションのチャンネルで project_open を使い、ファイルを書いて動く状態にしてから、URL と使い方を 3〜5 行で伝える。#inbox で頼まれたら session_open で専用のチャンネルを作る。コードは聞かれたときだけ短く見せる。」

## 5. ターンの上限と途中経過
- セッションのチャンネル: maxTurns `SELF_AGENT_SESSION_MAX_TURNS`（既定 40）、打ち切り `SELF_AGENT_SESSION_TURN_TIMEOUT_SEC`（既定 900）。#inbox と、#inbox の要約のターンは今のまま（8 手順・`SELF_AGENT_TURN_TIMEOUT_SEC`）。
- 同時実行: セッションのチャンネルのターンが同時に使えるのは `SELF_AGENT_MAX_CONCURRENT - 1` まで（最低 1）。#inbox は全枠を使える。
- 途中経過:
  - ターンが 20 秒を超えたら、チャンネルに「作業中…」のメッセージを 1 つ出し、5 秒以上の間隔で編集する（経過時間・ツール呼び出しの回数・直近の手順。手順は「書いています: <dir からの相対パス>」「読んでいます: …」「Web を検索しています」の形で、ファイルの中身やコマンドの本文は出さない）。
  - [中断]（`turn:abort:<channelId>`）を付ける。押されたらそのターンを abort し、「中断しました」に書き換える。
  - 終わったら「完了（4 分 10 秒・ツール 23 回）」に書き換えてボタンを外し、返答は別のメッセージで投稿する。
  - 手順の上限（error_max_turns）で止まったら「手順の上限で止まりました」に [続ける]（`turn:continue:<channelId>`）を付ける。押すと「続けてください」をオーナーの発言として送る。

## 6. 段 2: sandbox 付きの Bash
（段 1 が動いてから。オーナーの sudo が前提）
- オーナーが 1 回だけ打つもの:
  ```
  sudo apt-get install -y bubblewrap socat
  sudo tee /etc/apparmor.d/bwrap > /dev/null <<'EOT'
  abi <abi/4.0>,
  include <tunables/global>

  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,
    include if exists <local/bwrap>
  }
  EOT
  sudo systemctl reload apparmor
  ```
  このホストは `kernel.apparmor_restrict_unprivileged_userns = 1` で、bwrap 用の profile が無い（確認済み）。代償: shino3 のどのプロセスも bwrap 経由で userns を作れるようになる。
- Options の sandbox: `enabled: true`、`failIfUnavailable: true`、`autoAllowBashIfSandboxed: true`、`allowUnsandboxedCommands: false`。
  - network: `allowedDomains: ["registry.npmjs.org"]`。
  - filesystem: `denyRead: ["~/", "/run/user", "/tmp/tmux-<uid>", "/run/postgresql", "/run/tailscale", "/run/dbus"]`、`allowRead: [<workDir>, "~/.nvm"]`。書き込みは cwd（workDir）だけ。
  - credentials: `CLAUDE_CODE_OAUTH_TOKEN` を deny。
- childEnv に足す: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`、`CLAUDE_CODE_TMPDIR=<workDir>/.tmp`、`npm_config_cache=<workDir>/.npm-cache`、`BASH_DEFAULT_TIMEOUT_MS=180000`。
- Unix ソケットの遮断: seccomp フィルタ（`@anthropic-ai/sandbox-runtime` をユーザー領域に）。
- hook: #inbox では Bash を拒否。`run_in_background: true` を拒否。ディスクの上限を超えていたら Bash・Write・Edit を拒否。
- 起動時の自己診断: bwrap で userns を作れなければ sandbox を外して Bash を hook で全部拒否し、#system に知らせる。
- /close でそのプロジェクトの `node_modules` を消す。
- 受け入れ: `cat ~/.config/self-agent/env` が失敗、`echo ${CLAUDE_CODE_OAUTH_TOKEN:-none}` が none、`curl https://example.com` が拒否、`npm view react version` が成功、tmux・postgres・user bus のソケットに繋がらない、`npm create vite` → build（出力先 site）→ URL で開ける。
- 未確認（受け入れで確かめる）: Bash の説明文に sandbox の設定が入るか、seccomp フィルタを CLI が見つけられるか、read-only の bind mount でソケットに connect できるか。

## 7. PR 分解（段 1）
1. 本書 + config（`SELF_AGENT_SERVE_PORT`・`SELF_AGENT_PUBLIC_BASE_URL`・`SELF_AGENT_SERVE_ALLOWED_LOGIN`・`SELF_AGENT_SESSION_MAX_TURNS`・`SELF_AGENT_SESSION_TURN_TIMEOUT_SEC`）+ store の `projects`（v13）と slug の生成。
2. 静的サーバー（`src/serve/`）。main で配線し、shutdown で閉じる。
3. ツール（組み込み 5 個・project_open）、PreToolUse の guard、チャンネルの種類ごとの上限と #inbox 用の枠、システムプロンプトの行。**キャッシュに影響するのはこの PR だけ。**
4. `/projects`（一覧と削除の確認）。
5. 途中経過のメッセージ、[中断]、[続ける]。
段 2 は段 1 の後に 1 PR。

## 8. 受け入れ条件（段 1）
- project_open: セッションのチャンネルでは url を返し、2 回目は existing、#inbox では not_available、env が無ければ not_configured（単体）。
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/p/<slug>/` が 200。`..`・`%2e%2e`・ドットファイル・site の外を指す symlink・削除済みの slug は 404、POST は 405（単体・一時ディレクトリ）。
- Write/Edit: 別のチャンネルのプロジェクト・projects の外・#inbox からは hook が拒否（単体）。Read は projects の外を拒否。
- チャンネルを消してもプロジェクトの URL は 200 のまま。`/projects` の [削除する] で 404 になり、ディレクトリが消える。
- オーナーがスマホで URL を開ける。返答にコードブロックが無い（手動）。

## 9. ツール集合とキャッシュ
- ツール集合を変えるのは段 1（PR 3）と段 2 の 2 回。そのたびに全セッションでキャッシュが 1 回外れる。
- 組み込みツールの説明文の分だけ毎ターンの入力が増える。段ごとに `npm run measure` で増えた量を実測して PR に書く。
- システムプロンプトの行は新しいセッションと #inbox の日次切り替えから効く。ツールの説明文と project_open の結果の注意は既存のセッションにも届く。

## 10. 実装者が決めてよいこと
静的サーバーの既定ポート（8790 を推奨。衝突が無ければよい）、途中経過の文言、一覧ページの見た目。

## 11. 案の比較（記録）
| 観点 | A 静的のみ | B + Bash（sandbox） | C + 常駐サーバー |
|---|---|---|---|
| 作れるものの幅 | ○ | ◎ | ◎ |
| 持ち出し・他プロセスへの強さ | ◎ | ○ | △ |
| N100 の資源 | ◎ | ○ | △ |
| 実装量 | ◎ | ○ | ✗ |
- C は sandbox 内のサーバーにホストから届かない（Linux の sandbox では localhost がコマンド専用）ため、自前の起動と中継が要る。サーバー側の処理が要る依頼が実際に出てから決める。
