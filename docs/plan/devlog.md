# dev モードの会話ログ

> 2026-10-08。オーナーの要望「会話ログを残して評価できるようにして。ただし dev モードを設定したときだけ」への実装仕様。
> 決定（オーナー）: 中身は全部（ツールの入力と結果も。長いものは切る）／保存は 30 日／評価の印（リアクション）は付けない。

## 目的
- Bot の応答を後から読み返して評価できるようにする（何を頼まれ、どのツールを使い、何が返り、どう答えたか）。
- SDK の会話の記録（CLAUDE_CONFIG_DIR）は Discord 側の情報（チャンネルの種類・所要時間・失敗の理由）を持たず、CLI の設定で古いものが消えるので、別に残す。

## 環境変数
| 変数名 | 用途 |
|---|---|
| `SELF_AGENT_DEV_MODE` | `1` で dev モード（会話ログを残す）。未設定か `0` なら無効。それ以外の値は設定エラー（変数名を出して exit 1） |
| `SELF_AGENT_DEV_LOG_DAYS` | 会話ログを残す日数（正の整数）。既定 30 |

## 記録
- 置き場所: `<SELF_AGENT_DATA_DIR>/devlog/<YYYY-MM-DD>.jsonl`（日付はターンの開始時刻の `SELF_AGENT_TZ` の日付）。ディレクトリは 700、ファイルは 600 で作る。
- 1 run（SdkAgentRunner.run の 1 回。発言・/close・#inbox と #tasks の要約のターン・[続ける] すべて）につき 1 行の JSON を、run の終わり（成功・失敗・中断・打ち切りのどれでも）に追記する。
- 項目:
  - `at`（開始時刻 ISO）、`durationMs`
  - `guildId`・`channelId`・`kind`（"inbox" / "tasks" / "session"。context が無い run は null）
  - `model`・`effort`（未設定は null）・`maxTurns`、`resume`（resume した SDK の session_id。無ければ null）
  - `prompt`（SDK に渡した文字列そのまま。ヘッダ・記憶のブロック・seed を含む）
  - `steps`: 起きた順の配列
    - `{ "t": "text", "text" }`（assistant のテキスト）
    - `{ "t": "tool_use", "id", "name", "input" }`（input は JSON の値。文字列化して 2,000 字を超えるなら、文字列化したものを切って文字列で入れる）
    - `{ "t": "tool_result", "id", "isError", "content" }`（テキストにして 2,000 字まで）
    - `{ "t": "compact", "trigger", "preTokens" }`
    - thinking の中身は残さない
  - `result`: 成功なら `{ ok: true, text, sessionId, usage, toolCalls, contextTokens, compacted? }`、失敗なら `{ ok: false, errorMessage, sessionId?, sessionRecorded, toolCalls }`
- 切り詰め: 2,000 字を超える文字列は先頭 2,000 字 + `…（N 字を省略）`。`prompt` と `result.text` は切らない（評価の本体なので）。
- 書き込みの失敗は console に「dev ログを書けませんでした」とだけ出し、ターンは止めない。中身・パスは console に出さない。
- console のログ方針（本文・チャンネル ID を出さない）は変えない。dev ログのファイルは例外として本文・チャンネル ID を含む（ローカルのファイル。リポジトリには入れない）。
- 起動時、dev モードなら console に「dev モード: 会話を記録します（<N> 日で消します）」。

## 消す
- scheduler の tick ごとに、`devlog/` のファイル名の日付が「今日（TZ）から `SELF_AGENT_DEV_LOG_DAYS` 日より前」のものを消す。dev モードでなくても、ディレクトリがあれば消す（残す期間の約束を守るため）。名前が `YYYY-MM-DD.jsonl` でないファイルは触らない。

## 読む
- `npm run devlog -- [--date YYYY-MM-DD] [--kind inbox|tasks|session] [--channel <id>] [--last N]`（既定は今日・全部）。トークンが無くても動く（設定の読み込みは SELF_AGENT_DATA_DIR と SELF_AGENT_TZ だけ。既定値は config.ts と同じ）。
- 1 ターンずつ読みやすく出す: 見出し（時刻・種類・チャンネル ID・所要時間・トークン（input / cache read / cache creation）・ツール回数・成否）→ prompt → steps（tool_use は名前と input の先頭 300 字、tool_result は先頭 300 字と isError、text は全文）→ 結果（返答の全文か失敗の理由）。

## 受け入れ条件
- dev モードでないとき、ファイルもディレクトリも作られない。
- dev モードで、偽の queryFn の run（text・tool_use・tool_result・compact を含む）が 1 行に記録され、順序・切り詰め・`prompt` と `result.text` を切らないことが確かめられる。失敗・中断・打ち切りの run も記録される。
- ファイルとディレクトリの権限が 600 / 700。
- 書き込みの失敗でターンが失敗しない。
- tick で古い日のファイルだけが消え、名前の違うファイルは残る。
- 表示の整形（純関数）のテスト。
- `SELF_AGENT_DEV_MODE` の不正値で設定エラー。
