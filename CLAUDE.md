# self-agent

## 概要

Discord 専用サーバーに常駐する個人用エージェント。Claude Agent SDK（TypeScript）で実装し、Claude Max の利用枠で動く。
Discord の 1 チャンネル（#inbox・#tasks と /new で作ったセッションのチャンネル）= 1 SDK セッション（`resume` で継続）。
サブエージェントは使わない。話題を分けたいときはセッション（チャンネル）を分ける。

- 要求と決定事項: `docs/REQUIREMENTS.md`（再始動版）
- 各設計の段がどこまで main に入ったか: `docs/status.md`。**段を進めたらそちらを直す。ここには足さない**（ここを直すのは、下の表の行・「今」の語・作業のしかたが変わるときだけ）
- 旧 Rust 版の資料は `docs/archive/`（参照のみ）

### 動き方は 2 つ

- 軽いモード: #inbox・#tasks・今までのセッション。自前のシステムプロンプトと固定のツール
- プロジェクトのセッション（`docs/plan/unify.md`）: `/new project:<名前>` か Web の「話題を始める」で場所を選ぶと、`SELF_AGENT_WORKSPACE_DIR` の直下のプロジェクトを cwd に、Claude Code と同じ装備（preset のシステムプロンプト・CLAUDE.md・skills・Bash）で動く。`SELF_AGENT_CC=1` と `npm run unify-setup -- --print` の link が要る（GitHub の［対応］も同じ）

### 設計書

文書は `docs/plan/` の下（見た目の決まりだけ `docs/design/`）。「今」は 済み・途中・保留 だけを書く。どの段までかは `docs/status.md`。

| 何の設計か | 文書 | issue | 今 |
|---|---|---|---|
| 人格（1 プロセスに複数の Bot・共有 DB・codex） | `personas.md` | #114 | 途中（codex のエンジンは無い） |
| Bot を持たない人格（Web だけ）と、話題ごとに選ぶ Antigravity のモデル（`agy` をサブスクのサインインで回す） | `personas-web-antigravity.md` | #530 | 途中 |
| 定型チャンネル（領収書・予定など）・#inbox からの引き渡し・画像の受け取り・スキル | `routines.md` | #119 | 途中（定型チャンネルの振る舞いは無い） |
| GitHub の通知を #github に流し、［対応］で PR・Issue ごとの話題を作る | `github-notifications.md` | #122 | 済み（PR-G4・PR-G5 は作らない） |
| シェル（sandbox 付きの Bash。`SELF_AGENT_SHELL=1` のときだけ） | `shell.md` | | 済み |
| 作業ジョブ（Discord から頼むと draft PR を返す） | `coding-jobs.md` | #129 | 保留 |
| ゲスト利用の簡易モード（他のサーバーで、ツールなしで答える） | `guest-mode.md` | #147 | 途中 |
| 配布（npm）・入口の統一・Mac 対応 | `distribution.md` | #157 | 途中 |
| Web UI（tailnet の中のブラウザから使う。別ポート・`Tailscale-User-Login` 必須。PWA は §11） | `web-ui.md` | #157・#224 | 途中（W7 まで。W8 は作らない） |
| 新しい殻（入口 `/`） | `web-ui-v3.md` | #349 | 入れ替え済み |
| Web UI の見た目の決まり（色・型・間隔・部品・動き・言葉・a11y） | `docs/design/WEB-UI-GUIDELINES.md` | #225 | 守る決まり |
| Web UI の作り直しの準備（持ち越す物と白紙に戻す物・進め方の案・止める段） | `web-ui-rebuild.md` | #528 | 途中（方向 = 案 D・別の入口に作る。段は `web-ui-home.md`） |
| 新しい入口（会話が家。スマホ 5 タブ・PC 3 本柱・色の組） | `web-ui-home.md` | #528・#539 | 途中（設計だけ） |
| 見た目の磨き（UI-1〜UI-12） | `web-ui-polish.md` | #225・#248 | 済み |
| 部品での作り直し（Preact + htm をビルドなしで同梱） | `web-ui-components.md` | #349 | 途中 |
| 流れの列（あなたの番・タスク・通知）と席（Deck 風） | `web-ui-deck.md` | #463 | 途中 |
| 話題のピン留め（会話ごとの列） | `web-ui-pins.md` | #507 | 済み |
| 右腕を あなたの番 の列の一番上の行にする | `web-ui-hand-row.md` | #514 | 済み |
| 入口によらず同じエージェントにする（プロジェクトのセッション） | `unify.md` | #277 | 途中 |
| 端末の Claude Code のセッションの管理（リモコン。CC1〜CC14・Q1〜Q5） | `claude-code-sessions.md`・`claude-code-channels.md`・`claude-code-questions.md` | #191・#236・#265 | 済み（手をかけない） |
| リモコンをやめ、取り込みとプロジェクトのセッションを本線にする移行 | `terminal-handover.md` | #428 | 途中 |
| 取り込み（端末の Claude Code の会話を、プロジェクトのセッションが引き継ぐ） | `takeover.md` | #341 | 済み（実機の確かめはまだ） |
| 話題を始めるときにモデルを選ぶ | `models.md` | #451 | 途中 |
| 右腕が統括として働く | `lead.md` | #457 | 途中 |

### 作業の前に知っておくこと

- 作業ジョブは保留。ジョブ用の runner（PR-J4）は作らないので、`SELF_AGENT_JOBS=1` は設定エラーのまま。Web のジョブの画面（W8）も作らない
- ゲストの `SELF_AGENT_GUEST_GUILD_IDS` は廃止。残っていれば設定エラー
- 端末の Claude Code のリモコンには手をかけない（`cc:` のタブは部品にしない）。消す段（X1〜X5）は使う期間の後
- Web UI は別の入口に作り直している（#528）。今の画面には段を足さない。新しい画面のファイルは `n-*`（止める段は `docs/plan/web-ui-rebuild.md` §8。サーバー側は進めてよい）
- 右腕の丸・重ねる枠・［広げる］は無い（#514 で消した）。古い設計書に残る記述は、頭の注記を先に読む

## コマンド

```bash
source ~/.nvm/nvm.sh      # 非対話シェルでは毎回必要（Node 24.20.0）
npm ci                    # 依存インストール（package-lock.json どおり）
npm run check             # 型チェック（tsc --noEmit）
npm test                  # 単体テスト（test/*.test.ts。偽 Runner / 偽 Gateway / 一時 SQLite）
npm run test:integration  # 結合テスト（OAuth トークンが無ければ skip。あれば利用枠を消費する）
npm start                 # 起動（node src/cli.ts start。必須の環境変数が欠けていれば変数名を出して exit 1）
node src/cli.ts <sub>     # self-agent コマンドの入口（./bin/self-agent <sub> も同じ。env ファイルを読んでから動かす。npm run <sub> は scripts/ の入口から同じ本体を呼ぶ）
```

ほかのコマンド。引数・読む物・書く物・exit code は `docs/commands.md`。

| コマンド | 何をするか | 気を付ける点 |
|---|---|---|
| `npm run measure` | P0 実測（本体と同じ Options・ツールで 2 ターン） | **利用枠を消費する** |
| `npm run shell-check` | シェル（Bash）の受け入れの実機確認 | **利用枠を消費する** |
| `npm run devlog` | dev モードの会話ログを 1 ターンずつ表示 | 読むだけ |
| `npm run usage` | ターンごとのトークンを 1 ターン 1 行で表示 | DB は読み取り専用で開く |
| `npm run github-dry-run` | GitHub の通知を 1 回取得して件数だけ表示 | 投稿しない・DB も既読も変えない |
| `npm run cc-dry-run` | この機械の Claude Code のセッションを 1 回読んで表示 | 読むだけ（`-- --reset-multiline` だけ DB を変える） |
| `npm run job-dry-run -- --repo <owner/repo>` | 作業ジョブを偽 Runner で 1 回 | **ネットに出て、実際に push と draft PR まで行う** |
| `npm run guest-setup` | ゲストの 2 つの変数を訊いて env ファイルに書く | 端末での対話が要る。ネットに出る |
| `npm run cc-setup -- --print` | `~/.claude/settings.json` に足す hooks の設定を出す | 標準出力だけ |
| `npm run unify-setup -- --print` | プロジェクトのセッションのための `ln -s` の行を出す | 標準出力だけ |
| `npm run make-icons` | ホーム画面のアイコンを `src/web/static/` に書き直す | 図形を変えたら走らせて commit する（`npm test` が一致を確かめる） |
| `npm run vendor-web` | Preact と htm を `src/web/static/vendor-*.js` に書き直す | 手で直さない。版を上げたら走らせて commit する（同上） |
| `npm run ui-shots -- --out <dir>` | 決まった画面を作り物のデータで撮る（`--only <名前の一部>`） | `<dir>` はリポジトリの外だけ。機械が混むと時間を測る検査が落ちる（#489）ので、`npm test` と同時に回さない |

## ディレクトリ構成

各ファイルの役割は [docs/directory-structure.md](docs/directory-structure.md) にある。1 行が長いので、必要な名前だけ grep して読む。

- `src/` 本体（`main.ts` は配線だけ。`cli.ts` がコマンドの入口）、`test/` テスト、`scripts/` 補助スクリプト、`docs/` 仕様（REQUIREMENTS.md, status.md, commands.md, design/, research/, archive/, plan/）
- Web UI は `src/web/static/`（ビルドなし。部品は `c-*.js`・`c-*.css`、見本は `/static/gallery.html`）
- CLAUDE.md は毎回すべて読み込まれるので、ファイルの説明はここに足さず docs/directory-structure.md に、段の進み具合は docs/status.md に書く

## 環境変数

一覧は [docs/environment.md](docs/environment.md) にある。変数を足したらそちらに書く。

## コーディング規約

- erasable な TypeScript のみ（enum / namespace / parameter properties 禁止）。ビルドせず `node` で直接実行する（tsconfig は型チェック専用）
- 相対 import は `.ts` 拡張子付き
- 依存は最小限、バージョンは exact 固定
- public リポジトリなので、トークン・ID・個人情報をコードやログに書かない
- ローカルのログ（console）にはサーバー ID を出してよい。チャンネル ID・ユーザー ID・本文・トークンは出さない（例外: /new でチャンネルを作った後に DB 保存に失敗したときは、手で消せるよう作ったチャンネルの ID を出す）
- dev モードの会話ログ（`<SELF_AGENT_DATA_DIR>/devlog/`）は例外として本文・チャンネル ID を含む（ローカルのファイル。リポジトリには入れない）。console のログには、その中身・パスを出さない

## Web UI を触るとき

- 部品の CSS（`c-*.css`）と `shell.css` に色の値を直に書かない（トークンだけ。`npm test` が見張る）。`shell.css` はコメントごと見るので、コメントの中の `#514` のような issue の番号も当たる（`c-*.css` はコメントを剥がして見るので当たらない）
- 見た目を変える PR は、`npm run ui-shots` の前後の絵を開いて確かめてから通す
- `ui-shots` は日付（JST）が変わった直後に回すと落ちる段があった（#467。直ったかは確かめていない）

## プロンプトキャッシュの規則

- システムプロンプトは静的に保つ。日時や ID などの可変値を入れない
- システムプロンプトは `{ type: "custom", prompt, snapshot: false }` で渡し、SDK に記録させない（毎回今の SYSTEM_PROMPT を送る）。既定（記録する）に戻すと各セッションの最初の記録に戻るので戻さない
- ツール集合は全セッション共通で固定する
- 会話履歴は追記のみ（途中を書き換えない）
- モデルと effort はセッション途中で変えない
- キャッシュ効果の計測は result の `modelUsage` の差分で行う
- システムプロンプトの変更は全セッションの次のターンから効き、そのターンだけ全セッションで 1 回キャッシュが外れる（#69 で実測）。ツールの description も毎ターン送られるので同じ。どちらも変更はまとめて行う。会話の中の古い返事の癖まで消したいときは /renew
- プロジェクトのセッション（docs/plan/unify.md。agent/project-profile.ts）は例外: Claude Code の preset のシステムプロンプト（cwd・git の状態などの動的な節を含む）に PROJECT_APPEND を足して snapshot: true で会話ごとに固定し、settingSources（user・project・local）と CLI の既定のツールを使う。軽いモード（#inbox・#tasks・今までのセッション）の Options は変えない
- 自前のツールは無効のときも定義し、軽いモードにもプロジェクトのセッションにも付く。ツールの定義を変えた再起動の後は、機能が無効でも全セッションの次のターンで 1 回キャッシュが外れる
- `session_open` の引数 `model` の describe の文は後で変えない（#451）
- プロジェクトのセッションの `PROJECT_APPEND` の変更は、新しい会話から効く。軽いモードのシステムプロンプトだけの変更では、プロジェクトのセッションは外れない
- どの変更でキャッシュが外れたかの記録は `docs/status.md` の末尾
