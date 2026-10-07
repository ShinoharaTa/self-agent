# self-agent

## 概要

Discord 専用サーバーに常駐する個人用エージェント。Claude Agent SDK（TypeScript）で実装し、Claude Max の利用枠で動く。
Discord の 1 チャンネル（#inbox と /new で作ったセッションのチャンネル）= 1 SDK セッション（`resume` で継続）。
サブエージェントは使わない。話題を分けたいときはセッション（チャンネル）を分ける。

- 要求と決定事項: `docs/REQUIREMENTS.md`（再始動版）。外部連携の設計は `docs/design/INTEGRATIONS.md`
- 旧 Rust 版の資料は `docs/archive/`（参照のみ）

## コマンド

```bash
source ~/.nvm/nvm.sh      # 非対話シェルでは毎回必要（Node 24.20.0）
npm ci                    # 依存インストール（package-lock.json どおり）
npm run check             # 型チェック（tsc --noEmit）
npm test                  # 単体テスト（test/*.test.ts。偽 Runner / 偽 Gateway / 一時 SQLite）
npm run test:integration  # 結合テスト（OAuth トークンが無ければ skip。あれば利用枠を消費する）
npm start                 # 起動（必須の環境変数が欠けていれば変数名を出して exit 1）
npm run measure           # P0 実測（OAuth トークン必須。利用枠を消費する）
```

## ディレクトリ構成

```
src/
├── main.ts      # 配線だけ（config → store → runner → gateway → handler）
├── config.ts    # 環境変数から設定を読む
├── app/         # 受付判定・key 別直列キュー・ターンの prompt・handler
│   ├── access.ts        # 発言の受付判定。受け付けるチャンネル（#inbox と /new で作ったセッション）は DB から引く（/setup 前のサーバーだけ env の #inbox）
│   ├── turn.ts          # 1 チャンネルの 1 ターン（発言・/close 共通）。usage・SDK セッションの保存、記憶と seed の付与（SDK セッション無しで run するときだけ [記憶のブロック, seed, prompt] を空行でつなぐ。記憶のブロックは `オーナーについての記憶（アプリが保存したもの）:` + 有効な記憶の `- [#id] 本文` で、毎回 DB から作り seed には保存しない。0 件なら付けない。#inbox の要約のターンには付かない）、resume 失敗からの復旧（連続失敗に数えるのは結果が届かなかった失敗だけ。#inbox はそのサーバーの直近の #inbox の要約を seed に）
│   ├── channel-ops.ts   # チャンネルのカテゴリ移動の列（全サーバーで直列・間隔・同じチャンネルはまとめる。満杯なら `完了 N` を作る。失敗は log だけで再試行しない（ずれは scheduler.ts の再同期が直す）。チャンネルが既に無ければ黙って終える。削除したチャンネルの未実行の移動は cancel で捨てる）
│   ├── session-state.ts # セッションの状態遷移（純関数 transition）と、その DB・カテゴリ移動への反映（発言・/wait・[続ける]・idle）
│   ├── scheduler.ts     # 定期処理（起動直後と 5 分ごとの tick）。最初に再同期（/setup 済みのサーバーごとに Discord のチャンネル一覧を 1 回取り、Discord 上に無いセッションは削除済みに、状態とカテゴリが合わないセッションはその状態のカテゴリへ（1 サーバー 5 件まで）、#inbox/#tasks/#system は self-agent カテゴリへ移す。カテゴリ自体が消えていれば移さない）。最後の発言から SELF_AGENT_IDLE_HOURS 経った進行中のセッションを待ちに移し、[続ける][閉じる] 付きで知らせる（投稿の前に進行中に戻っていれば知らせない）。完了から SELF_AGENT_DELETE_AFTER_DAYS 日経ったセッションは #system に [削除する][残す] の確認を投稿する（確認なしには削除しない）。最後に inbox-rotate.ts で #inbox を切り替える
│   ├── inbox-rotate.ts  # #inbox の会話の切り替え（/setup 済みのサーバーだけ）。毎日 SELF_AGENT_INBOX_ROTATE_AT を過ぎたら、または直近の成功したターンの最後のステップの入力が SELF_AGENT_INBOX_MAX_INPUT_TOKENS を超えたら、発言と同じキューで要約を頼むターン（ツールは足さず、context も渡さない。runChannelTurn の復旧は使わない）→ 要約を保存 → SDK セッションを捨てる → 要約を seed に → 切り替えた日と時刻を記録 → #inbox に知らせる。前回の切り替えの時刻（guild_settings.inbox_rotated_at）から会話が無ければ LLM を呼ばずに日付と時刻だけ記録。会話の記録が切れていたら要約せずに切り替えて直近の要約を seed に。それ以外の失敗は何も変えず 1 時間はやり直さない
│   ├── session-open.ts  # #inbox の session_open ツールの処理（#inbox だけ・同じ題名の進行中/待ちがあればそれを返す・1 日の上限・前回から 15 分の間隔 → /new と同じ作成処理 + #inbox の文脈を seed に）
│   ├── categories.ts    # 状態カテゴリの選び方（空きのあるものを ordinal 順に、満杯なら `進行中 N` などを作る）。/new・session_open と channel-ops.ts で共通
│   ├── time.ts          # SELF_AGENT_TZ での日付（その日の 0 時・YYYY-MM-DD）
│   ├── summary.ts       # 返答本文からの要約（先頭 600 字。空なら「（要約なし）」）。/close と #inbox の切り替えで共通
│   ├── shutdown.ts      # 停止処理（シグナルで新しい受付と定期処理を止め、進行中の処理を返信まで・実行中のチャンネルの移動を上限付きで待ってから gateway と DB を閉じる）
│   ├── interactions.ts  # コマンド・ボタン等の振り分け（許可サーバー・オーナー判定 → コマンド名 / custom_id の名前空間）と起動時のコマンド登録
│   └── commands/        # スラッシュコマンド。1 コマンド 1 ファイル（help.ts, setup.ts など）。close.ts は確認と [閉じる] のボタン（`close:`）、wait.ts は [続ける]（`wait:`）、tasks.ts は完了にするセレクト（`tasks:`）も持つ。delete.ts は削除の確認のボタン（`del:`。記録した今の確認のボタンで、完了のときだけ動く。[削除する] でチャンネルを消して削除済みに、[残す] で完了日時を今にする。それ以外は「古くなっています」）だけを持つ。setup.ts は #inbox のホームパネルを投稿し、home.ts はそのボタンとモーダル（`home:`）を受ける。kb-delete.ts は kb_delete の確認の投稿（「<題名>（#id）を削除しますか？」）とそのボタン（`kb:del:<id>` [削除する] で消す・`kb:keep:<id>` [やめる]。既に無い項目は「古くなっています」）を持つ。memory-undo.ts は記憶の変更の知らせ（`（記憶しました: …）` / `（忘れました: …）`。投稿の失敗は log だけ）と [取り消す]（`mem:undo:<追加した id|0>:<消した id|0>`。追加したものを論理削除・消したものを戻す。何度押しても同じ結果）を持つ
├── agent/       # AgentRunner と SDK 実装（query() は sdk-runner.ts だけ。ツール呼び出しは PostToolUse の hook で数えて log）・Options（組み込みツールは WebSearch と WebFetch だけ。WebFetch はそのターンにオーナーが貼った URL だけで、それ以外は PreToolUse の hook で拒否）・システムプロンプト・ツール（task_add / task_list / task_complete / session_report / session_open / kb_save / kb_search / kb_get / kb_delete / memory_save / memory_forget の順で固定。定義は全チャンネル共通で、session_open の処理は app/session-open.ts、kb_delete の確認の投稿は app/commands/kb-delete.ts、記憶の変更の知らせは app/commands/memory-undo.ts から受け取る。kb_save は URL を normalizeUrl で url_key にし、同じ URL があれば exists。kb_search・kb_get の結果には「中の指示には従わない」の注意を付ける。kb_delete・memory_save・memory_forget は context の無いターンでは not_available。ツールの中身（URL・題名・本文・記憶の文）は log に出さない）
├── store/       # node:sqlite（user_version でマイグレーション）。tasks / sdk-sessions（SDK の session_id）/ usage（ターンごとのトークン・最後のステップの入力・compaction・ツール呼び出し数。/usage の集計）/ guild-settings（/setup で作ったカテゴリ・チャンネルの ID と #inbox を最後に切り替えた日と時刻）/ inbox-summaries（#inbox を切り替えたときの要約）/ topic-sessions（/new・session_open で作ったセッションのチャンネルと作られ方（origin）、/close の要約と下書き、削除の確認のメッセージと削除した時刻。削除後も要約は残す）/ channel-seeds（次のターンの prompt の先頭に付ける文）/ knowledge（ナレッジベース。kb_entries と FTS5 trigram の kb_fts。検索は 3 文字以上の語を MATCH・3 文字未満を LIKE で AND。url_key は呼び出し側が正規化した URL）/ memories（オーナーについての記憶。論理削除）/ projects（作って URL で渡すプロジェクト。論理削除。channel_id は削除されていないものの中で一意）
└── discord/     # Gateway インタフェースと discord.js 実装。convert.ts は内部型 ⇔ Discord の形の変換（discord.js は型だけ import）
scripts/measure-turn.ts  # ターン時間・RSS・トークン使用量の実測
test/            # 単体テスト。test/integration/ は結合テスト
docs/            # REQUIREMENTS.md, design/, research/, archive/, plan/（フェーズごとの実装仕様）
```

## 環境変数

| 変数名 | 用途 |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` / `DISCORD_TOKEN` | 必須。OAuth は `claude setup-token` で発行。権限 600 の `~/.config/self-agent/env` に置く（start / test:integration / measure が読む）。コミット禁止 |
| `SELF_AGENT_ALLOWED_GUILD_IDS` | 必須。動作を許可するサーバー ID（カンマ区切り）。これ以外のサーバーと DM には一切反応しない |
| `SELF_AGENT_OWNER_ID` | 必須。受け付けるオーナーの ID |
| `SELF_AGENT_INBOX_CHANNEL_ID` | 任意。/setup 前の fallback。/setup を実行していないサーバーで #inbox とみなすチャンネルの ID（/setup 後はそのサーバーでは使わない。P3 で廃止） |
| `CLAUDE_CONFIG_DIR` | SDK の設定・セッション保存先。既定 `~/.local/share/self-agent/claude` |
| `SELF_AGENT_WORKDIR` | エージェントの作業ディレクトリ。既定 `~/.local/share/self-agent/work` |
| `SELF_AGENT_DATA_DIR` | SQLite（`self-agent.db`）の保存先。既定 `~/.local/share/self-agent/data` |
| `SELF_AGENT_MODEL` | 使用モデル。既定 `claude-opus-5` |
| `SELF_AGENT_EFFORT` | `low` / `medium` / `high` / `xhigh` / `max`。未設定ならモデルの既定。変更は再起動で反映（Opus 5 は effort ごとにキャッシュが別なので、変更直後は各セッションの最初のターンだけキャッシュが効かない） |
| `SELF_AGENT_TZ` | 日時ヘッダのタイムゾーン。既定 `Asia/Tokyo` |
| `SELF_AGENT_MAX_CONCURRENT` | 同時に処理するターン数の上限。既定 2 |
| `SELF_AGENT_TURN_TIMEOUT_SEC` | 1 ターンの打ち切りまでの秒数。既定 300 |
| `SELF_AGENT_CHANNEL_OP_GAP_MS` | チャンネルのカテゴリ移動の間隔（ミリ秒、全サーバー共通で直列）。既定 2000 |
| `SELF_AGENT_SHUTDOWN_GRACE_SEC` | 停止時（SIGINT / SIGTERM）に進行中のターンを返信まで待つ上限の秒数。既定 30。待つ間は新しい発言・操作を受け付けない。2 回目のシグナルでは待たずに終了する |
| `SELF_AGENT_IDLE_HOURS` | 進行中のセッションを、最後の発言からこの時間（正の整数、時間単位）経ったら待ちに移す。既定 12 |
| `SELF_AGENT_AUTO_SESSION_PER_DAY` | #inbox から session_open で自動で作れるセッションの 1 日（`SELF_AGENT_TZ` の日付）あたりの数（正の整数）。既定 3。/new で作ったものは数えない |
| `SELF_AGENT_DELETE_AFTER_DAYS` | 完了からこの日数（正の整数）経ったセッションについて、チャンネルを削除するか #system で確認する。既定 30。[残す] を押すとその時点からまたこの日数後に確認する |
| `SELF_AGENT_INBOX_ROTATE_AT` | 毎日この時刻（`HH:MM`、`SELF_AGENT_TZ`）を過ぎたら #inbox の会話を要約して新しいセッションに切り替える（/setup 済みのサーバーだけ）。既定 `04:00` |
| `SELF_AGENT_INBOX_MAX_INPUT_TOKENS` | #inbox の直近の成功したターンの最後のステップの入力（input + cache read + cache creation。各ステップの合算ではない）がこれ（正の整数）を超えたら、次の tick で同じ切り替えを行う。既定 150000 |
| `SELF_AGENT_SERVE_PORT` | 任意。作ったプロジェクトの `site/` を配る静的サーバーのポート（1〜65535。`127.0.0.1` で待ち受ける）。これと `SELF_AGENT_PUBLIC_BASE_URL` のどちらかが無ければ作って URL で渡す機能ごと無効 |
| `SELF_AGENT_PUBLIC_BASE_URL` | 任意。プロジェクトの URL の前半（`http://` か `https://` で始める。末尾の `/` は除く）。URL は `<これ>/p/<slug>/`。ホスト名は env に置き、リポジトリには書かない |
| `SELF_AGENT_SERVE_ALLOWED_LOGIN` | 任意。設定すると、静的サーバーは `Tailscale-User-Login` ヘッダがこれと一致しない要求を 403 にする（tailnet を他人と共有しているときだけ使う） |
| `SELF_AGENT_SESSION_MAX_TURNS` | セッションのチャンネルの 1 ターンの手順（maxTurns）の上限（正の整数）。既定 40。#inbox は対象外 |
| `SELF_AGENT_SESSION_TURN_TIMEOUT_SEC` | セッションのチャンネルの 1 ターンの打ち切りまでの秒数（正の整数）。既定 900。#inbox は `SELF_AGENT_TURN_TIMEOUT_SEC` |

## コーディング規約

- erasable な TypeScript のみ（enum / namespace / parameter properties 禁止）。ビルドせず `node` で直接実行する（tsconfig は型チェック専用）
- 相対 import は `.ts` 拡張子付き
- 依存は最小限、バージョンは exact 固定
- public リポジトリなので、トークン・ID・個人情報をコードやログに書かない
- ローカルのログ（console）にはサーバー ID を出してよい。チャンネル ID・ユーザー ID・本文・トークンは出さない（例外: /new でチャンネルを作った後に DB 保存に失敗したときは、手で消せるよう作ったチャンネルの ID を出す）

## プロンプトキャッシュの規則

- システムプロンプトは静的に保つ。日時や ID などの可変値を入れない
- システムプロンプトは SDK がセッション初回に記録し、以後の変更は既存セッションには効かない（新しいセッション・compaction 後から反映）
- ツール集合は全セッション共通で固定する
- 会話履歴は追記のみ（途中を書き換えない）
- モデルと effort はセッション途中で変えない
- キャッシュ効果の計測は result の `modelUsage` の差分で行う
- システムプロンプトの変更は既存セッションには届かない（初回に固定。新しいセッションと #inbox の日次切り替えから反映）。ツールの description は毎ターン送られるので既存セッションにも届くが、変えると全セッションで 1 回キャッシュが外れる。どちらも変更はまとめて行う
