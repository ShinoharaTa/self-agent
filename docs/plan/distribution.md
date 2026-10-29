# 配布（npm 公開）と macOS 対応 — 設計案 v1（#157）

> 2026-10-29。spec-writer。素案（配布・Web UI・Mac の 3 本柱）に対するオーナーの決定（§0）と、PR #158 のレビュー（lock の比べ方・env の優先順位・P1 の分割・D3 の実機確認ほか）を反映した版。Web UI は `docs/plan/web-ui.md`。リポジトリのソースは変更していない。
> 「確認」= 2026-10-29 に main（d6cdb85）のコード・node_modules（typescript 7.0.2 / SDK 0.3.286）・Node 24.20.0 / npm 11.19.0 の実測・公式ドキュメントで確かめた事実。「未確認」= 手元に Mac が無い・実装で確かめるまで前提にしない。

## 0. 目的・オーナーの決定・結論

目的: self-agent を (A) パッケージマネージャーで入れられるようにし、(C) 自宅 Mac でも常駐できるようにする。Discord が主の入口で、Web UI（B）は補助。

オーナーが決めたこと（2026-10-29。動かせない）:
1. 配布は **npm 公開**（`npm i -g`）。tsc のビルドを導入して `dist/` を配る。
2. Web UI は別ポート + `Tailscale-User-Login` 必須。Tailscale 以外の VPN 用に env の固定トークン + Cookie（web-ui.md）。
3. Web UI は最初から操作も入れる。env（秘密）の編集は載せない（web-ui.md）。
4. 順番は Web UI（W1）→ Mac（M1）。Mac のシェル（M2）は W8（J4 の後）を除いて最後で、I1 が成り立たなければ入れない。
5. npm の名前は **`@shinoharata/self-agent`**（`self-agent` も空きだったが scoped にする。2026-10-29 に `npm view` で E404 を確認）。アカウントはオーナーが用意する（scope と同じユーザー名 `shinoharata`）。
6. LICENSE は **MIT**（公開の PR（P1-b）で追加）。
7. Web UI からの投稿先は受け付けるチャンネル全部（#inbox・#tasks・#<NAME>・セッション。web-ui.md v2 §5。2026-10-29 にモック v2 の採用で v1 の「既定の人格の #inbox だけ」から変更）。

結論:
- **開発と本番（Ubuntu の checkout）は今までどおり `node src/main.ts`（ビルド無し）。** ビルドは公開物（`dist/`）を作るときだけ。
- 入口を `src/cli.ts`（サブコマンド）に統一し、checkout では `node src/cli.ts <sub>`、公開物では `self-agent <sub>`（`bin` → `dist/cli.js`）。`npm run *` は残す。
- Mac は「シェル無しで Bot が動く」（M1）を先に。シェル（M2）は I1 の確認が通ったときだけ。
- 費用: 増える外部サービスは無い（npm の公開は 0 円。GitHub Releases・Tailscale も 0 円）。運用コストは版を上げるたびに `npm version` → tag → `npm publish` を手元から打つ手間（§4.7）。

## 1. 全体の順（distribution.md と web-ui.md の共通の表）

| 順 | 段 | 内容 | 文書 | 依存 |
|---|---|---|---|---|
| 1 | 0 | 本計画を 2 つの設計書に置く | — | — |
| 2 | D1 | 入口の統一（`src/cli.ts`・`bin/`・env の読み方・パスの基準） | §4.2〜§4.5 | 0 |
| 3 | W1 | Web UI の土台（認証・CSRF・状態・使用量）と SPA の殻（W1-a・W1-b） | web-ui.md §8 | 無し（Web は main.ts の中で動き、env は `npm start` のフラグで読める。D1 と並行可） |
| 4 | W2 | 会話を見る（`history` 表・会話の API と画面・devlog） | web-ui.md §8 | W1 |
| 5 | W3 | Web から送る・実行中の途中経過・中断・続ける | web-ui.md §8 | W2 |
| 6 | D2 | `self-agent setup`（必須 4 変数を対話で） | §4.8 | D1 |
| 7 | D3 | `self-agent service install\|uninstall\|status`（launchd / systemd --user） | §4.9 | D1 |
| 8 | P1-a | ビルド・`files`・`npm pack`・tarball での `npm i -g` と `service install` の確認（`private: true` のまま） | §4.1・§4.7・§5 | D1〜D3・W3 |
| 9 | M1 | Mac で Bot が動く（シェル無し。Mac には P1-a の tarball で入れる） | §4.10 | P1-a |
| 10 | P1-b | `private` を外し、LICENSE と README の位置づけを足して 0.1.0 を publish | §4.6・§4.7 | M1 |
| 11 | W4〜W7 | タスク・リマインド・記憶（W4）、セッションの操作（W5）、知らせ・GitHub・ナレッジ（W6）、プロジェクト（W7）。0.2.0 | web-ui.md §8 | P1-b |
| 12 | M2 | Mac のシェル（seatbelt）。I1 が成り立たなければ入れない | §4.11 | M1 |
| 13 | W8 | ジョブのビュー | web-ui.md §8 | PR-J4 |

W1〜W3 を D2 の前に置く理由: Web UI は今の本番（checkout）でそのまま使え、公開物に最初から入る。W1〜W3 で「見る・送る・止める」が揃うので 0.1.0 はそこまでにし、W4〜W7（Discord のコマンドの抜き出しを含む）は公開の後（0.2.0）に回す（web-ui.md §8.2）。D2・D3・P1-a は「入れる人」向けで、Mac（M1）はその tarball で入れ、Mac で動くと分かってから公開する（P1-b）。

## 2. 確認した事実

### 2.1 ビルドと配り方
- 確認（実測・公式）: Node 24.20.0 は `node_modules/` の下の `.ts` を実行しない（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。nodejs.org/api/typescript.html）。回避のフラグは無い。→ `npm i -g` で入る形には tsc の emit が要る。
- 確認（実測。scratchpad の小さなプロジェクトで typescript 7.0.2 の `tsc`）: `rewriteRelativeImportExtensions: true` + `module: nodenext` + `verbatimModuleSyntax` + `erasableSyntaxOnly` で、`import { b } from "./b.ts"` が `"./b.js"` に書き換わった ESM が出る。`import.meta.dirname` もそのまま残り、Node 24 で動く。動的な `await import("./b.ts")` も `"./b.js"` に書き換わる（`src/cli.ts` の `start` が使う形）。ただし TS 7 では **`rootDir` を明示しないと TS5011 で止まる**、**`noEmit: false` を明示する**（今の tsconfig.json は `noEmit: true`）、**コンパイル時に `"type": "module"` の package.json が無いと CommonJS として扱われ TS1295 で止まる**（リポジトリには既にある）。
- 確認（`package.json`）: `private: true`、**`version` が無い**（`npm pack --dry-run` は「must have name and version」で失敗する）、`files`・`bin`・`main` も無い。`engines.node >=24.20.0` はある。`.npmignore` は無く、`.gitignore` は node_modules・data/・.env・*.db など。
- 確認（リポジトリ）: **LICENSE が無い**。git の tag も無い。README の Development は「runs without a build step」と書いている。
- 確認（docs.npmjs.com package.json）: `files` を書いても `package.json`・`README`・`LICENSE`・`main`・`bin` のファイルは常に入り、`node_modules`・`package-lock.json`・`.npmrc`・`.git` は常に入らない。`private: true` は publish を拒む。`bin` のファイルは `#!/usr/bin/env node` で始める。
- 確認（docs.npmjs.com scripts）: `prepack` は `npm pack`・`npm publish`・git 依存の install の前に走る。`prepublishOnly` は `npm publish` だけ。`npm version` は `preversion`・`version`・`postversion`。
- 確認（docs.npmjs.com provenance）: `--provenance` は GitHub Actions / GitLab CI の cloud-hosted runner だけ。手元からは付けられない。
- 確認（実測）: `process.loadEnvFile(path)` は Node 24.20.0 にあり、既にある環境変数は上書きしない（`--env-file` と同じ）。ファイルが無ければ `ENOENT` を投げる。
- 確認（package-lock.json）: SDK の CLI 本体は platform 別の optionalDependencies（darwin-arm64・darwin-x64・linux-x64 …）で、`npm i -g` でも 1 つだけ入る（素案 §1.2 のまま）。

### 2.2 実行時に読む「リポジトリ相対のパス」（grep の結果）
| 箇所 | 今 | 公開物（`dist/`）で | 直し |
|---|---|---|---|
| `src/agent/scaffold.ts` `WEB_TEMPLATE_DIR` | `new URL("../../templates/web/", import.meta.url)` | `dist/agent/scaffold.js` から `../../` = パッケージの直下 → `templates/web/` が隣にあれば**そのまま動く** | 無し（`dist` が `src` と同じ深さである前提。§4.1 の `rootDir: src`） |
| `src/agent/query-options.ts` `defaultSandboxHost().cwd` → `sandbox-check.ts` の `repoDir`（秘密の場所） | `process.cwd()`（checkout で起動する前提） | `self-agent start` の cwd はどこでもよいので「リポジトリ」を指さない | **パッケージの直下（`import.meta.dirname` の親）に変える**（§4.4） |
| `src/store/data-lock.ts` `BOT_COMMAND = "src/main.ts"` | lock の PID のコマンドラインに `src/main.ts` が無ければ古い lock とみなして取り直す | 確認（レビュアーの実測）: `npm i -g` は `<prefix>/bin/self-agent` → `dist/cli.js` の symlink で、shebang 経由の `/proc/self/cmdline` は `node /…/bin/self-agent start`（`dist/cli.js` を含まない）。2 つ目の `self-agent start` が 1 つ目の lock を古いと判定して**二重起動**になる | 自分の `/proc/self/cmdline`（argv[0] より後ろ）を lock に書いて比べる（§4.5。argv[1] は node が絶対パスに解決し、相対パスの起動では cmdline と一致しないため） |
| `src/config.ts` 人格の `_PROMPT_FILE` の既定 | `~/.config/self-agent/personas/<id>.md` | ホームなので変わらない | 無し |
| `scripts/*.ts` | `../src/...` を import し、top-level await で動く。`parseArgs`。テストは scripts を import しない | `rootDir: src` の外なので dist に入らない | 本体を `src/cli/<name>.ts`（`main(argv)` を export）に移し、`scripts/*.ts` は呼ぶだけの薄い入口にする（§4.2） |
| `npm run *` | `node --env-file-if-exists=$HOME/.config/self-agent/env …` | グローバルの `self-agent` では node のフラグを付けられない | `src/cli.ts` が `process.loadEnvFile` で読む（§4.3） |

### 2.3 macOS（素案 §1.3 から引き継ぎ。未確認のものは M1 で確かめる）
- 壊れる（確認・コード）: `remove-tree.ts` の `/usr/bin/rm --one-file-system`（BSD rm は `/bin/rm -x`。`/usr/bin/rm` の有無は未確認）、`serve/static-server.ts` と `jobs/git.ts` の `/proc/self/fd`。`sandbox-check.ts` は bwrap・socat で必ず落ちる（Bash 無効のまま Bot は動く。fail-closed）。
- 壊れない（確認・コード）: `disk.ts` の find の引数、`data-lock.ts`（/proc が無ければ確認を飛ばす）、`statfsSync`、既定のパス。
- 未確認: `npm i -g` が darwin の CLI に Gatekeeper の隔離属性を付けるか、gh が Keychain のログインで動くか、`tailscale serve` の localhost への proxy が GUI 版で使えるか・sudo が要るか、スリープの扱い。

## 3. 決定事項

| 項目 | 決定 | 根拠 |
|---|---|---|
| 配り方 | **npm 公開**（`npm i -g`）。Homebrew tap・Docker・`npx github:` はやらない | オーナーの決定 1 |
| npm の名前 | **`@shinoharata/self-agent`**（scoped。オーナーの決定 5）。コマンド名（`bin`）は `self-agent` | 個人用のツールで、素の `self-agent` は一般名詞に近く、scoped なら名前の衝突も乗っ取りの紛れも無い。scope はオーナーの npm のユーザー名と同じでなければ publish できないので、ユーザー名は `shinoharata` |
| 開発・本番の動かし方 | **変えない**（checkout で `node src/main.ts`・`npm run *`・transient unit） | ビルドは公開物だけ。CLAUDE.md の「ビルドせず node で直接実行」は「開発と checkout の本番では」と限定して残す |
| 公開物 | `dist/`（tsc の emit。`src` の鏡）+ `bin/` + `templates/` + README + LICENSE | §4.1 |
| ビルドの設定 | `tsconfig.build.json`（`extends: ./tsconfig.json`、`noEmit: false`、`rootDir: src`、`outDir: dist`、`rewriteRelativeImportExtensions: true`、`include: ["src"]`、`declaration: false`） | §2.1 の実測 |
| 入口 | `src/cli.ts`（サブコマンド）。公開物は `dist/cli.js`、checkout は `node src/cli.ts` | §4.2 |
| 環境変数 | `self-agent` は `~/.config/self-agent/env` を `process.loadEnvFile` で読む（無ければ読まない。`SELF_AGENT_ENV_FILE` で場所を変えられる） | §4.3 |
| `files` | `["dist", "bin", "templates"]`（README・LICENSE・package.json は自動で入る）。`.npmignore` は使わない | §2.1 |
| `engines` | `node >=24.20.0`（今のまま） | — |
| `private: true` を外す | **P1-b（公開の PR）で**。P1-a と M1 の間は `npm publish` が拒まれる（安全側） | — |
| 版 | `0.1.0` から。`npm version <minor|patch>` で package.json と tag `v<version>` を同時に。`gh release create v<version>`。publish は手元から（provenance 無し）。**publish・tag はオーナーの指示のときだけ** | §4.7 |
| LICENSE | **MIT**（オーナーの決定 6）。今は無い（§2.1）ので P1-b で `LICENSE` を足す。自分のコードだけに効く（確認（node_modules）: discord.js は Apache-2.0、zod は MIT、`@anthropic-ai/claude-agent-sdk` は「© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements …」の独自の条件で、tarball には入らず `npm i -g` が別に入れる） | npm は LICENSE を常に同梱する |
| README の位置づけ | 「自分の Discord サーバーと自分の Claude の契約で動かす self-host のツール」。claude.ai のログインや利用枠を第三者に提供するものではない旨を 1 段落（素案 §1.2 の Anthropic の方針） | §4.6 |
| 常駐 | Ubuntu の本番は transient unit のまま。`npm i -g` で入れた人向けに `self-agent service install`（launchd / systemd --user） | §4.9 |
| データの置き場 | Mac でも `~/.local/share/self-agent`・`~/.config/self-agent`（env で変えられるのは今のまま） | 素案 §4.1 |
| 作業ジョブ | darwin では `SELF_AGENT_JOBS=1` を設定エラー（「作業ジョブは Linux だけ」） | `/proc` 依存（§2.3） |

## 4. 設計

### 4.1 パッケージ（P1-a）
- `package.json`: `name`・`version: 0.1.0`・`description`・`license`・`repository`・`files`・`bin: { "self-agent": "dist/cli.js" }`・`engines`。`main` は置かない（ライブラリとして import させない）。`scripts` に `build: tsc -p tsconfig.build.json`、`prepack: npm run check && npm test && npm run build`、`clean: rm -rf dist`（`rm -rf` は `files` の外なので scripts に書いてよい）。`dist/` は `.gitignore` に足す（公開物をリポジトリに入れない）。
- `tsconfig.build.json` は §3 の設定。`tsconfig.json`（型チェック）は変えない（`scripts`・`test` を含むまま）。`npm run check` は今までどおり `tsc --noEmit`。
- `dist/cli.js` の先頭に `#!/usr/bin/env node` が要る（`src/cli.ts` の 1 行目に書く。確認（実測）: typescript 7.0.2 の emit は 1 行目の shebang をそのまま残す）。実行ビットは npm が `bin` に付ける。
- Web UI の画面（`src/web/static/` の HTML・CSS・JS。tsc は複製しない）は `build` で `dist/web/static/` に複製する（`files` の `dist` で入る）。`src/web/static.ts` は自分の場所からの相対で読むので checkout と公開物で同じ（web-ui.md §3）。
- `templates/web/` は今の場所のまま同梱（§2.2）。`docs/`・`test/`・`scripts/`・`src/`・`tsconfig*.json`・`.github/` は `files` に無いので入らない。
- 依存は 3 つのまま。`npm i -g` では `dependencies` だけが入り、platform の CLI は optionalDependencies で 1 つ落ちる（§2.1）。
- scoped の公開は `npm publish --access public` が要るか（未確認。P1-b で `npm publish --dry-run` と公式ドキュメントで確かめて手順に書く）。

### 4.2 入口の統一（D1）
- `src/cli.ts`（shebang 付き）: `self-agent <sub> [options]`。サブコマンド: `start`（= 今の `src/main.ts`）/ `setup`（D2）/ `service`（D3）/ `devlog` / `usage` / `guest-setup` / `github-dry-run` / `shell-check` / `job-dry-run` / `measure`。無い・無しは使い方を出して exit 2。`--help`・`--version`（package.json から。`import.meta.dirname` の親の `package.json` を読む）。
- 各サブコマンドの本体は `src/cli/<name>.ts` の `main(argv: readonly string[]): Promise<number>`（exit コード）。`scripts/<name>.ts` は `process.exit(await main(process.argv.slice(2)))` だけの薄い入口に変える（`npm run *` の互換のため。`measure-turn.ts` も同じ）。`start` は `await import("./main.ts")`（`src/cli.ts` から。`src/cli/start.ts` に置くなら `../main.ts`）で今の `main.ts` をそのまま動かす（main.ts は top-level の script のまま。**env を読んでから import する**。§4.3）。
- `bin/self-agent`（checkout 用。POSIX sh。`exec "${SELF_AGENT_NODE:-node}" "$(dirname "$0")/../src/cli.ts" "$@"`）。公開物では使わない（`bin` フィールドは `dist/cli.js`）。`files` には `bin` を入れるが、中身は README の補助なので無くてもよい（実装者が決める。入れないなら `files` から外す）。
- `npm start` は `node --env-file-if-exists=… src/cli.ts start` に変える（今の `src/main.ts` 直接でも動くが、入口を 1 つにする）。transient unit の起動行（README §4）も `src/cli.ts start` に揃える。

### 4.3 環境変数の読み方（D1）
- `src/cli.ts` は `--help`・`--version`・振り分けの後、サブコマンドを import する前に `loadEnvFile(path)`: `SELF_AGENT_ENV_FILE` があればそれ、無ければ `~/.config/self-agent/env`。`process.loadEnvFile` を try し、`ENOENT` なら何もしない（それ以外の例外は変数名を出さずに「env ファイルを読めませんでした」で exit 1）。既にある環境変数は上書きされない（§2.1。systemd の `--env-file` と二重に読んでも同じ結果）。
- 優先順位: **`SELF_AGENT_ENV_FILE` が効くのは `self-agent` コマンド（`src/cli.ts` / `dist/cli.js` の `loadEnvFile`）のときだけ。** `npm run *`・`npm start` は今までどおり node の `--env-file-if-exists` で既定の `~/.config/self-agent/env` を先に読み、その後の cli.ts の `loadEnvFile` は既存の変数を上書きしないので、二重に読んでも結果は同じ（`SELF_AGENT_ENV_FILE` を env ファイルの中に書いても、`npm run` では既に読んだ後なので効かない。README にその旨を 1 行）。
- `main.ts`・`config.ts` は `process.env` を読むだけで変えない。

### 4.4 パスの基準（D1）
- `src/agent/query-options.ts` の `defaultSandboxHost().cwd`（秘密の場所の「リポジトリ」）を **パッケージの直下**（`fileURLToPath(new URL("../..", import.meta.url))`。checkout では今の cwd と同じ、公開物では `<prefix>/lib/node_modules/@shinoharata/self-agent/`）にする。名前も `repoDir` → `packageDir` に。自己診断の「秘密の場所と重ならない」はそのまま効く。`sandbox-check.ts` の doc コメントと CLAUDE.md の説明を合わせる。
- `scaffold.ts` の `WEB_TEMPLATE_DIR` は変えない（§2.2）。D1 のテストで `WEB_TEMPLATE_DIR` が実在するディレクトリであることを確かめる（dist でも同じテストを P1-a の受け入れで走らせる）。

### 4.5 二重起動の lock（D1）
- 固定の印（`BOT_COMMAND`）では公開物を見分けられない（§2.2）。**lock の 3 行目に自分の `/proc/self/cmdline` の argv[0] より後ろ（NUL・改行を空白に。読めなければ `process.argv.slice(1).join(" ")`）を書き、holder の `/proc/<pid>/cmdline` を同じ規則で正規化したものがそれを含むかで「同じ Bot か」を比べる**（PID が生きていて boot id が同じでも、cmdline が含まなければ PID の再利用とみなして取り直す）。`process.argv` を使わない理由: `argv[1]` は node が絶対パスに解決する（`bin/self-agent` の `bin/../src/cli.ts` の `..` も正規化する）が、cmdline は起動したときの文字列のままなので、`npm start`・transient unit（`node … src/cli.ts start`）のような相対パスの起動では一致せず、2 つ目の Bot が 1 つ目の lock を古いと判定して二重起動になる（実測）。`node src/cli.ts devlog` のような Bot でない cli のプロセスは引数が違うので Bot と誤判定されない。
- 運用の注意: 新しい Bot（3 行の lock）が動いている間に、D1 より前のコード（main の data-lock.ts。3 行の lock を形が違うとみなし、`src/main.ts` の印も cmdline に無い）を同じ dataDir で起動すると、lock を奪って二重起動になる。ロールバックは新しい Bot を止めてから行う。
- 移行: 3 行目が無い古い lock（今の本番が持っている）は今までどおり `src/main.ts` の印で比べる。新しい Bot が書く lock は常に 3 行。`/proc` が読めなければ今までどおりこの確認は飛ばす。

### 4.6 README（P1-a・P1-b）
- 「Installing from npm」の節（`npm i -g @shinoharata/self-agent` → `self-agent setup` → `self-agent service install` → Discord で `/setup`）と、「Running from a checkout」（今の内容）を分ける。
- 位置づけの 1 段落（P1-b）: self-host・自分の契約・第三者への提供はしない。SDK と CLI は Anthropic の条件のもとで各自が入れる旨を 1 行。Claude Max の OAuth トークンの扱い（`claude setup-token`）は今のまま。
- Mac の節（M1）。README_ja も同じ構成。

### 4.7 版と公開の手順（P1-a・P1-b。docs に置き、実行はオーナーの指示のときだけ）
1. `main` で `npm run check && npm test`。
2. `npm version minor|patch`（package.json と tag `v<version>`。`preversion` で check・test を走らせてもよい）。
3. `npm run build && npm pack` で中身と tarball での `npm i -g` を確かめる（受け入れ §5 の P1-a。初回は M1 の Mac にもこの tarball で入れる）。
4. P1-b で `private` を外してから `npm publish`（初回は 2FA。scoped なら `--access public` が要るかを §4.1 の確認に従う）。provenance は付けない（手元から。GitHub Actions を足すときに `--provenance` に切り替える。費用 0 円だが、公開の権限を CI に渡すので別の論点）。
5. `git push --follow-tags` と `gh release create v<version> --generate-notes`。
6. 本番（Ubuntu）は `git pull` + 再起動（公開物は使わない）。

### 4.8 `self-agent setup`（D2）
- 必須 4 変数（`CLAUDE_CODE_OAUTH_TOKEN`・`DISCORD_TOKEN`・`SELF_AGENT_ALLOWED_GUILD_IDS`・`SELF_AGENT_OWNER_ID`）を端末で対話式に訊き、`~/.config/self-agent/env`（600）に書く。`scripts/guest-setup.ts` と `src/guest/setup-env.ts`（伏せ字の入力・`upsertEnvLines`・一時ファイル → rename・`env.bak`）を一般化して共有する。
- 疎通: Discord は `/users/@me`（guest-setup と同じ）。Claude の OAuth の疎通は利用枠を使わない経路が無ければ確かめず、「`self-agent start` で確かめる」と案内する（`--skip-check` も残す）。
- 既存の env は差分だけ置き換え（置き換える前に確認）。端末でなければ exit 1。値・ID は画面と log に出さない。

### 4.9 `self-agent service`（D3）
- `install`: darwin なら `~/Library/LaunchAgents/com.shinoharata.self-agent.plist`（600。`ProgramArguments` は `process.execPath` と `dist/cli.js start` の絶対パス、`EnvironmentVariables` は `HOME` と固定の `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` だけ、`KeepAlive`・`RunAtLoad`、`StandardOutPath`/`StandardErrorPath` は `~/Library/Logs/self-agent/`）を書いて `launchctl bootstrap gui/$(id -u)`。linux なら `~/.config/systemd/user/self-agent.service`（`ExecStart` は同じ絶対パス、`MemoryMax=4G`・`MemoryHigh=3G`・`CPUQuota=300%`・`TasksMax=1024`、`Restart=on-failure`）を書いて `systemctl --user daemon-reload && enable --now`（linger は案内だけ。sudo は使わない）。秘密は unit・plist に書かない（env は §4.3 で読む）。
- `uninstall`・`status`。既にあれば上書きの確認。Ubuntu の本番は使わない（transient unit のまま）。
- 注意（README の項目に）: `ProgramArguments`/`ExecStart` の node は `process.execPath` の絶対パスで、nvm だと版入り（`~/.nvm/versions/node/v24.20.0/bin/node`）なので Node を上げると unit が壊れる。上げたら `self-agent service install` をもう一度。

### 4.10 Mac で Bot が動く（M1。素案 §4.2 から）
1. `remove-tree.ts`: darwin なら `/bin/rm -rf -x --`（platform で定数を選ぶ関数。テストは両方の引数）。
2. `static-server.ts` の `openInside`: darwin は「開く直前の `lstat` と開いた fd の `fstat` が同じ (dev, ino) で通常のファイル」で確かめる（保証は Linux より弱い。M2 で再評価）。
3. `jobs`: darwin では設定エラー（§3）。`jobs/git.ts` は触らない。
4. `npm test` を Mac で通す（`/usr/bin/rm` を実際に呼ぶテストは `process.platform` で分岐）。`measure` は Linux 限定のまま。
5. README の Mac の節（Node は Homebrew の `node@24` か nvm、Xcode CLT、スリープの注意、Tailscale の CLI の場所）。

### 4.11 Mac のシェル（M2。素案 §4.3 から。I1 が通らなければ入れない）
- 自己診断の darwin 版（`sandbox-exec` の有無・seatbelt の probe・秘密の場所・別ボリュームは「推奨」に落とす）、denyRead の darwin の並び（`/private/tmp`・`/var/folders` など）、shell-check の Mac 版（`pgrep` で残存プロセス）。最初の受け入れ項目は **I1（コマンドより長く生きない）**。seatbelt に PID 名前空間は無いので成り立たない可能性が高い。成り立たなければ README に「Mac はシェル無し」。

## 5. 受け入れ条件

単体（`npm test`。偽物・一時ディレクトリ・ネット無し）:
- D1: `src/cli.ts` のサブコマンドの振り分け（無い名前は exit 2・`--help`・`--version`）。`loadEnvFile` が無いファイルで何もしない・既存の変数を上書きしない・`SELF_AGENT_ENV_FILE` で場所が変わる。`data-lock`: 新しい lock は 3 行で自分の cmdline（argv[0] より後ろ。読めなければ argv）を含む、holder の cmdline にそれが含まれれば生きている・含まなければ取り直す（`node /…/bin/self-agent start` の形と `node src/cli.ts start` の形の両方。相対パスで起動した（cmdline が `node src/cli.ts start`、argv[1] が絶対パス）2 つ目の Bot を拒む）、`node src/cli.ts devlog` の cmdline の PID は Bot でないとみなす、3 行目の無い古い lock は `src/main.ts` の印で比べる。`packageDir` が `package.json` のあるディレクトリ。`WEB_TEMPLATE_DIR` が実在する。
- D2: 入力の形の検証（4 変数）。既存の env の差分の置き換えと `env.bak`。値を含む文字列が出力・log に無い。
- D3: plist / unit の生成が純関数で、秘密の変数名・値を含まない（grep）。`ProgramArguments`/`ExecStart` が絶対パス。
- P1-a: `npm run build` の後、`dist/**/*.js` を `\.ts["')]` で grep して 0 件。`dist/cli.js` の 1 行目が shebang。`npm pack --dry-run --json` の一覧に `src/`・`test/`・`scripts/`・`docs/`・`.env`・`*.db`・`tsconfig*.json` が無く、`dist/cli.js`・`templates/web/site/base.css`・`README.md` がある（`LICENSE` は P1-b で足してから同じ確認）。
- M1: `remove-tree` の darwin の引数。`openInside` の darwin 版（同じ (dev, ino) で通る・違えば 404）。darwin で `SELF_AGENT_JOBS=1` が設定エラー。

実機（Ubuntu は実装者、Mac はオーナー。結果は #157 に貼る）:
- D1: `./bin/self-agent --help`・`node src/cli.ts start` が `npm start` と同じ結果（env の読み方・必須変数が無いときの exit 1 と変数名）。`npm run devlog -- --last 1` などの `npm run *` が前と同じ出力。
- P1-a（Ubuntu の本番とは別のディレクトリ・別の prefix。本番の checkout・unit は触らない）: `npm pack` の tarball を `npm i -g ./<tarball>` で入れ、`self-agent --help`・`self-agent --version` が動き、`SELF_AGENT_DATA_DIR`・`SELF_AGENT_WORKDIR`・`SELF_AGENT_ENV_FILE` を一時の場所にして `self-agent start` が必須変数の無い exit 1 を出す。`self-agent devlog --last 1` が動く。**D3 の確認もここで**: 別の unit 名（`SELF_AGENT_SERVICE_NAME` か固定の `self-agent-test`。実装者が決める）で `self-agent service install` → `status` が enabled/running → `uninstall` で unit が消える（本番の `self-agent` unit には触らない）。`npm uninstall -g` で消える。
- M1（Mac。P1-a の tarball で `npm i -g ./<tarball>`）: `self-agent setup` → `self-agent service install`（launchd 版の D3 の確認はここ）で起動し、#inbox の 1 ターンが返る（OAuth トークンは Ubuntu と別に発行）。`SELF_AGENT_SHELL=1` なら #system に「使えない状態です」が出て Bot は動く。静的サーバーが `/p/<slug>/index.html` を 200 で返し、site の外への symlink は 404。`.tmp` の掃除（find）が動く。`npm test` が通る。`launchctl print gui/$(id -u)/com.shinoharata.self-agent` が running、plist が 600 で秘密を含まない。
- M2: Mac 版 shell-check の必須項目（秘密が読めない・env にトークンが無い・ネットの許可リスト・I1）が通る。

## 6. PR の分け方

| PR | 内容 | 変えるファイル（目安） |
|---|---|---|
| 0 | 本文書と web-ui.md（この PR） | docs/plan のみ |
| D1 | `src/cli.ts`・`src/cli/*.ts`・`scripts/*` の薄い入口・`bin/self-agent`・`loadEnvFile`・`packageDir`・`data-lock`・`npm start`・CLAUDE.md のコマンド表 | src・scripts・test・package.json・CLAUDE.md・README |
| D2 | `self-agent setup`（guest-setup との共有） | src/cli/setup.ts・src/guest/setup-env.ts → src/cli/env-file.ts・test |
| D3 | `self-agent service` | src/cli/service.ts・test・README |
| P1-a | `tsconfig.build.json`・`build`・`prepack`・`files`・`bin`・`version`・`.gitignore` に dist・README の「Installing from npm」の節・CLAUDE.md の「ビルド」の文（`private: true` のまま） | package.json・tsconfig.build.json・.gitignore・README・CLAUDE.md |
| P1-b | `private: true` を外す・`LICENSE`（MIT）・README の位置づけの段落（§4.6）。マージと publish はオーナーの指示で | package.json・LICENSE・README |
| M1 | §4.10 | src/agent/remove-tree.ts・src/serve/static-server.ts・src/config.ts・test・README |
| M2 | §4.11（I1 の確認の結果で入れない判断もある） | src/agent/sandbox-check.ts・query-options.ts・scripts/shell-check.ts |

実装者が決めてよいこと: サブコマンドのオプション名の細部、`src/cli/` のファイル分け、`bin/self-agent` を同梱するか、plist の `Label`・log の場所、`preversion` に check・test を入れるか、`scripts/*.ts` を残す期間。

## 7. 決めてもらうこと（推し付き）

決まったこと（2026-10-29。PR #158 のレビューの後）: npm の名前は `@shinoharata/self-agent`、LICENSE は MIT（P1-b で追加）、Web UI の投稿先は受け付けるチャンネル全部（§0 の 5〜7。モック v2 の採用で変更）。

1. **GitHub Actions**: 最初は使わない（推し。手元から publish）。provenance を付けたくなったら別の issue。
