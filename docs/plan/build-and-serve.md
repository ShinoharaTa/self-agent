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
| プロジェクトの中のファイルの削除（#70） | project_files で `.trash` に移す。確認ボタンは無く、restore で戻せる。30 日で消す |

## 2. 配り方
- 静的サーバーを self-agent に内蔵する（`node:http`。依存は足さない）。`127.0.0.1:SELF_AGENT_SERVE_PORT` で待ち受ける。Bot の一部として Bot と一緒に動く。
- `SELF_AGENT_SERVE_PORT` と `SELF_AGENT_PUBLIC_BASE_URL` のどちらかが無ければ、機能ごと無効（サーバーを起動しない。project_open は `not_configured`）。
- ルーティング:
  - GET / HEAD だけ受ける（それ以外は 405）。
  - `/p/<slug>/<path>` → `<workDir>/projects/<slug>/site/<path>`。ディレクトリなら `index.html`。`/p/<slug>` は `/p/<slug>/` へ 301。末尾 `/` なしのディレクトリも `<そのパス>/` へ 301（どちらもクエリは保つ）。
  - 404: DB に無い・削除済みの slug、パスの要素（デコード後に `/` で分けたもの）が `.` で始まる（`.`・`..` を含む。`a..b.js` のような名前は通す）、realpath が `site/` の外（symlink）、ファイルが無い。
  - `/` はプロジェクトの一覧（題名・更新日時・リンク。削除済みは出さない）。ほかの endpoint は置かない。
- ヘッダ: `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-cache`。Content-Type は拡張子から（html, css, js, mjs, json, svg, png, jpg, jpeg, gif, webp, ico, txt, map, wasm, woff, woff2。それ以外は application/octet-stream）。CSP は付けない（§1 の決定）。
- tailscale serve（オーナーが 1 回だけ打つ）: `sudo tailscale serve --bg --https=9443 http://127.0.0.1:8790`。確認 `tailscale serve status`、解除 `sudo tailscale serve --https=9443 off`。
  - 9443 は Funnel が使えないポート（Funnel は 443・8443・10000 だけ）なので、誤ってもインターネットに出ない。
  - URL は `<SELF_AGENT_PUBLIC_BASE_URL>/p/<slug>/`（例 `https://<host>.<tailnet>.ts.net:9443/p/kakeibo/`）。ホスト名は env に置き、リポジトリには書かない。
- 任意: `SELF_AGENT_SERVE_ALLOWED_LOGIN` を設定すると、`Tailscale-User-Login` ヘッダが一致しない要求を 403 にする（tailnet を他人と共有しているときだけ使う）。

## 3. 作業場所とプロジェクト
- ソースは `<workDir>/projects/<slug>/`、配るのは `<workDir>/projects/<slug>/site/` だけ。cwd は全チャンネルで workDir のまま。
- DB（user_version 13）: `projects(id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`（時刻は既存のテーブルと同じ ISO 文字列）と、`channel_id` の部分 UNIQUE インデックス（`WHERE deleted_at IS NULL`）。
  - `title` は前後の空白を除いて 100 字まで。空なら slug。
  - セッションのチャンネル 1 つに、削除されていないプロジェクトは 0〜1 個（`/projects` で消した後は、同じチャンネルで新しく作れる）。#inbox には作らない。
  - 削除済みの slug も UNIQUE のまま残す（同じ URL が別のものを指さないように）。
- slug: project_open の `name` から作る。英小文字・数字・`-` だけにし（他の文字は `-`、連続する `-` は 1 つ、前後の `-` は除く）、3〜30 字に切る。3 字未満なら `app`。重複したら `-2`、`-3`…を付ける。
- チャンネルが削除されても（[削除する]・手で消したのを再同期で検出）プロジェクトは消さない。そのプロジェクトは編集できるチャンネルが無くなり、配信だけ続く。
- `/projects`: 削除されていないプロジェクトの一覧を新しく更新した順に本人にだけ表示する。1 行 `**<題名>** <url>（<#元のチャンネル>・更新 YYYY-MM-DD）`（url が無ければ「（配信は未設定）」）。2000 字を超えたら末尾から削って「ほか n 件」、0 件なら「プロジェクトはまだありません」。配信は全サーバー共通なので、一覧はサーバーで絞らず全サーバーの分を出す。
  - 新しい順に最大 25 件のセレクト（`proj:pick`）で選ぶと、本人にだけ確認「<題名>（<url>）を削除しますか？ ページは開けなくなり、ファイルも消えます」と [削除する]（`proj:del:<id>`）[やめる]（`proj:keep:<id>`）を出す。
  - [削除する] は `deleted_at` を入れてから `<workDir>/projects/<slug>` を消し（realpath がその直下のディレクトリのときだけ。消せなくても削除済みのまま）、「削除しました: <題名>」にする。既に無い・削除済みのものは「古くなっています」。[やめる] は「やめました」。
- ディスクの上限（段 2 で入れる）: 1 プロジェクト 1 GB、合計 8 GB。

## 4. ツールとガード（段 1）
- 組み込み: `[WebSearch, WebFetch, Read, Write, Edit, Glob]`（この順で固定）。段 2 で末尾に `Bash` を足す。
  - Grep は #70 で外した（数ファイルの静的サイトでは Read で足りる。ツールの説明文の分、毎ターンの入力が減る）。
- MCP: 既存の 11 個の末尾に `project_open` を足す。#70 でその後ろに `project_files` を足した。
- allowedTools に足す: パスを絞ったルール `Read(//<realpath(workDir)>/projects/**)` と `Edit(//<realpath(workDir)>/projects/**)`（Edit のルールは Write にも、Read のルールは Glob にも効く。許可ルールは symlink の先も一致しないと効かないので実際の場所で書く）。それより細かい可否は PreToolUse の hook で決める（下）。permissionMode は dontAsk のまま（ルールに無いものは拒否）。
- PreToolUse の hook（`Read|Write|Edit|Glob`）。全 run に入れる（#inbox・context の無いターンも）。context の無いターン（#inbox の要約）ではすべて拒否:
  - パス（Read/Write/Edit は `file_path`、Glob は `path`。無ければ cwd）の文字列に、`/` で分けた要素として `..` があれば、resolve・realpath の前に拒否する（symlink の後ろの `..` を字面で畳んで中と誤判定しないため）。
  - それ以外は絶対パスにし、存在する一番深い親の realpath で判定する。
  - Write / Edit: 対象がこのチャンネルのプロジェクトのディレクトリの中でなければ拒否。#inbox・プロジェクトの無いチャンネルでは拒否（「先に project_open を使う」）。
    - #70: 中でも `<slug>/.trash` そのものとその中は拒否（「.trash の中には書けません。戻すときは project_files の restore を使ってください」）。
  - Read / Glob: 対象が `<workDir>/projects/` の中でなければ拒否（.trash の中も読める）。
  - Glob の `pattern`: 絶対パス（`/` か `~` で始まる）か、部分文字列 `..` を含めば拒否（`{..,x}` のような書き方も含める）。
  - 拒否の理由はモデルに返す。log には「ファイル操作を拒否しました（<ツール名>）」だけを出す（パスは出さない）。
  - 判定（ストアの読み書きを含む）が例外で終わったら拒否する（fail-closed。CLI は hook の例外を「判断なし」として通すため）。理由は「判定に失敗したため拒否しました」、log は「ファイル操作の判定に失敗したため拒否しました（<ツール名>）」（パス・例外の中身は出さない）。
- project_open（入力 `name`: 英語の短い名前、`title`: 表示名）:
  - #inbox・context の無いターン → `not_available`（「セッションのチャンネルで使う」）。サーバーの機能が無効 → `not_configured`。
  - このチャンネルにプロジェクトがあれば、それを返す（`existing`）。無ければ作り、`<slug>/site/` まで mkdir して返す（`created`）。
  - 返す内容: `dir`、`site_dir`、`url` と、作るときの注意:
    - 「ファイルは dir の中に書く。配られるのは site_dir の中だけで、入口は site_dir/index.html」
    - 「パスは相対で書く（`/` で始めない）。ページは `<url>` で開かれる」
    - 「localStorage のキーは slug で始める（全プロジェクトが同じオリジン）」
    - 「API キーや秘密をページに書かない。オーナーのタスク・記憶・ナレッジ・会話の中身は、頼まれない限りページに入れない」
    - 「ビルドやコマンドの実行はできない（段 1）。ライブラリは CDN から読む」
    - 「Glob は path に dir を指定する」
    - 「消す・移す・作り直すは project_files を使う（消したものは .trash に移り、配信されず、restore で戻せる。.trash の中のファイルは今のページに使わない）」（#70）
    - 「決めた仕様・やり残したことは dir/SPEC.md に短く書いておく。続きを頼まれたら最初に SPEC.md を読む」
    - 「作り終えたら、返事は URL と使い方を 3〜5 行にする。機能の一覧や仕様の詳細は返事に書かず、SPEC.md にあると伝える」
  - UI の土台（#67）: created・existing のどちらでも、リポジトリの `templates/web/` を複製する。created は DESIGN.md と site/ の base.css・app.css・icons.svg・index.html の 5 つ、existing は `site/base.css` が無いときだけ DESIGN.md・base.css・icons.svg の 3 つ。既にあるファイル（symlink を含む）は上書きせず、site が dir の外への symlink なら何も複製しない。複製できたものは結果の `scaffold` で返し、失敗したものがあっても log だけで結果はそのまま返す。
    - 使い勝手の節（#81）: 取り消し優先（確認ダイアログより [取り消す] 付きトースト）・入力の摩擦（主の欄を先頭に autofocus・前回の選択を記憶）・空状態は 1 つで次の行動を書く・切り替え後は結果へスクロールし初期状態へ 1 タップで戻る・赤は超過と失敗だけ・保存失敗は alert で・ダイアログは 1 目的でボタンを下に固定・メモは 2 行まで。DESIGN.md は 100 行以内。
    - 見た目の基準は shadcn/ui の既定風（中立色・黒のボタン・角丸 8px）。値はすべて base.css の変数（余白は 4 の倍数、文字 12〜24、角丸 6/8/12/9999、意味の名前の色とダークモードでの差し替え、影 1 種）と部品のクラスで、DESIGN.md（80 行以内）はその使い方。アイコンは Lucide（lucide-static 1.55.0、ISC）の sprite。
    - 注意の 2 番目に「作る前に dir/DESIGN.md を読む。見た目は site_dir/base.css の変数と部品で作り、px と色の値を直接書かない。base.css は編集せず、足すものは site_dir/app.css に書く。アイコンは site_dir/icons.svg を使う。既にあるページを直すときは頼まれた範囲だけ直し、見た目の作り直しは頼まれたときだけ行う」を足す。複製の後に DESIGN.md と site/base.css のどちらかが無ければ入れない。ツールの定義は変えないので、キャッシュには影響しない。
- project_files（#70。入力 `action`: trash / move / clear / restore、`paths`: 1〜50 件、`to`、`trash_id`）: オーナーはスマホしか使えず手で消せないので、プロジェクトの中のファイルを消す・移す・作り直す・戻す。
  - セッションのチャンネルで、そのチャンネルの削除されていないプロジェクトがあるときだけ使える（それ以外は `not_available`）。パスは dir からの相対。空・絶対・`..` を含む・dir そのもの・`.trash` で始まる・realpath が dir の外か `.trash` の中なら `invalid_path`（何もしない）。symlink はたどらない。
  - trash・move はプロジェクトの dir が無い・解決できなければ `not_available`。trash・clear・restore（一覧を含む）は `.trash` が実際のディレクトリでない（symlink・ファイル）なら何もせず `trash_unavailable`（無いのはよい）。
  - trash: paths を `<dir>/.trash/<trash_id>/<同じ相対パス>` に移す（trash_id は UTC の `YYYYMMDDTHHmmssZ`。同じ秒なら `-2`…）。site/ の外なので配信されない。無いものは missing に入れて続ける。同じパスの重複は 1 つにまとめ、paths の中に祖先があるもの（子 → 親の順でも）は祖先と一緒に移ったものとして moved に入れる（祖先が無ければ missing）。並びは入力の順。
  - move: paths の 1 つを to に移す（改名を含む）。to は移動先の名前まで書く（末尾が `/` なら `invalid_path`）。to が既にあれば上書きせず `exists`。
  - clear: `.trash` 以外を全部 `.trash/<trash_id>/` に移し、UI の土台を置き直す（URL は変わらない）。
  - restore: trash_id の中身を元の場所に戻す。同じパスが既にあれば何も戻さず `conflict`（そのパスを trash してから restore し直す）。trash_id を省くと一覧（新しい順・ファイルの数）。
  - ファイルを変えたらプロジェクトの更新日時を今にする。log は「project_files: <action>（N 件）」だけ。
  - scheduler の tick で、名前の時刻から 30 日を過ぎた `.trash/<trash_id>` を消す。
- システムプロンプトに足す行:
  - 「何かを作ってと頼まれたら、コードを返事に貼らない。セッションのチャンネルで project_open を使い、ファイルを書いて動く状態にしてから、URL と使い方を 3〜5 行で伝える。#inbox で頼まれたら session_open で専用のチャンネルを作る。コードは聞かれたときだけ短く見せる。」
  - その直後に「仕様の検討や見直しを頼まれたら、作り始めずに案を短く出し、確認してから作る。頼まれていない機能は足さず、候補として 1 行で挙げる。」
  - #70: 「何かを作って…」の行と仕様の検討の行の間に「ファイルを消す・移す・作り直すときは project_files を使う。オーナーに手で操作するよう頼まない。」
  - #71: 仕様の検討の行の直後に「計画（PLAN）モードで、と頼まれたら、ファイルを書かずに計画（目的・作るもの・手順・決めてほしいこと）を箇条書きで短く出し、オーナーが承認するまで project_open・Write・Edit・project_files を使わない。モードを切り替えられないとは言わない。」（SDK の permissionMode "plan" は ExitPlanMode でツール集合が変わり、承認の経路も要るので使わない。書き込みの強制が要るときは、/plan で DB に印を付けて PreToolUse の hook で拒否する形を後で検討する）
  - 「書き方:」のスマートフォンの行（表と長い見出しを使わない）を置き換える:「オーナーはスマートフォンの Discord から使い、PC は使えない。表と見出し（# で始まる行）は使わない。箇条書きは可。ファイルを保存して開く・コマンドを打つといった手順は案内せず、動くものは project_open で作って URL で渡す。」
  - 「やること:」の後に「このアプリについて（使い方を聞かれたら、この範囲で答える）:」の節を足す。#inbox・セッション（カテゴリと待ち・削除の確認）・#tasks と #system・コマンド（/new /close /wait /sessions /tasks /projects /usage /help /setup とホームパネルのボタン）を 1 行ずつ書き、「ここに無いことは、分からないと答える。」で終える。コマンドの説明は /help（help.ts の HELP_TEXT）と揃える。

## 5. ターンの上限と途中経過
- セッションのチャンネル: maxTurns `SELF_AGENT_SESSION_MAX_TURNS`（既定 40）、打ち切り `SELF_AGENT_SESSION_TURN_TIMEOUT_SEC`（既定 900）。#inbox と、#inbox の要約のターンは今のまま（8 手順・`SELF_AGENT_TURN_TIMEOUT_SEC`）。
- 同時実行: セッションのチャンネルのターンが同時に使えるのは `SELF_AGENT_MAX_CONCURRENT - 1` まで（最低 1）。#inbox は全枠を使える。
- 途中経過（セッションのチャンネルの発言と [続ける] のターンだけ。#inbox と /close のターンには付けない）:
  - ターンが開始から 20 秒経っても終わっていなければ、チャンネルに「作業中…（<m> 分 <s> 秒・ツール <n> 回）」+ 改行 + 直近の手順のメッセージを 1 つ出し、以後 10 秒ごとに、表示が変わっていれば編集する（ボタンは残す）。ツールの回数はメインループの assistant メッセージの tool_use の数。
  - 手順は tool_use ごとに「書いています: <dir からの相対パス>」（Write・Edit）「読んでいます: …」（Read）「ファイルを探しています」（Glob）「Web を検索しています」「ページを読んでいます」（WebFetch）「ファイルを整理しています」（project_files）「ツールを使っています: <mcp__selfagent__ を除いた名前>」「<ツール名> を使っています」の形。ファイルの中身・コマンド・URL・検索語は出さない。対象がこのチャンネルのプロジェクトの外ならパスを付けない。
  - 送信・編集の失敗は log だけで、ターンは止めない。
  - [中断]（`turn:abort:<channelId>:<turnSeq>`、danger）を付ける。turnSeq は handler がセッションのチャンネルのターンごとに振る単調増加の番号（開始値は handler を作った時刻のミリ秒。再起動しても前の番号と重ならない）で、実行中のターンごとに記録する（[中断] はターン単位）。押されたらそのターンを abort して（errorMessage は `aborted`。打ち切りの `timeout` と同じく連続失敗に数えない）「中断しました（<m> 分 <s> 秒・ツール <n> 回）」に書き換えてボタンを外し、返答は「中断しました。続けるときは発言してください」。実行中のターンが無い・実行中のターンの番号と一致しない（前のターンのボタン）なら本人にだけ「この操作は古くなっています」。
  - 中断・打ち切り（`aborted`・`timeout`）で終わったターンでも、SDK の session_id を受け取っていれば、そのチャンネルにまだ SDK セッションの保存が無いときだけ保存する（既にあるものは上書きしない）。次の発言はその会話を resume して続ける。保存したときは、成功したときと同じく seed も消す（その prompt は SDK の会話に記録済みのため）。
  - 終わったら終わり方に合わせて書き換えてボタンを外し、返答は別のメッセージで投稿する: 成功は「完了（4 分 10 秒・ツール 23 回）」、手順の上限は「手順の上限で止まりました（…）」、中断は「中断しました（…）」、timeout・例外などそれ以外の失敗は「止まりました（…）」。
  - 手順の上限（error_max_turns）で止まったら、セッションのチャンネルだけ今の返信（「途中までで止めました（手順が多すぎました）。…」）に [続ける]（`turn:continue:<channelId>`）を付ける。押すとボタンを外し、「続けてください」をオーナーの発言と同じ経路で 1 ターン送る（日時ヘッダは押した時刻・返信先なし・URL なし）。そのチャンネルが受け付けるセッションでなくなっていたら本人にだけ「この操作は古くなっています」。

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
  このホストは `kernel.apparmor_restrict_unprivileged_userns = 1` で、bwrap 用の profile が無い（確認済み）。代償: Bot を動かすユーザーのどのプロセスも bwrap 経由で userns を作れるようになる。
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
  - #70 で組み込みから Grep を外し、MCP の末尾に project_files を足した（これも全セッションで 1 回外れる）。
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
