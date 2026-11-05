# Web UI の磨き（UI-1〜UI-6・NAV・UI-7〜UI-12）: 今の画面と決まりの差と PR の段

関連 issue: #225（決まりと画面）・#224（PWA）・#235（スマホの下タブ）・#248（スマホの第 2 回。fix #249・UI-7 #250・UI-8 #251）。決まりは `docs/design/WEB-UI-GUIDELINES.md`、PWA の節は `docs/plan/web-ui.md` §11。


> 2026-11-04。main のコードで確かめたもの（行番号つき。推測は「推測」と書く）。v3: 設計レビュー（unslop / impeccable / hallmark / ui-skills の観点）の指摘を取り込み、オーナーの 7 つの決定（WEB-UI-GUIDELINES.md §11）で段を UI-1〜UI-6 に確定した。段の順と理由は §2。

## 1. 差の一覧（段ごと）

### UI-6 性格と色（CSS のトークンだけ）（済）

| # | 事実（今） | 決まり | 直し |
|---|---|---|---|
| 1 | 色が Tailwind の既定そのまま（zinc + blue-500 / red-500 / green-500 / amber-500。base.css:3 のコメント、app.css:44-78） | §1 性格 A・§2.1 | app.css の `:root[data-theme]` 2 ブロックを §2.1 の値に差し替え。`:root:not([data-theme])` + `prefers-color-scheme` の 2 ブロックを足す |
| 2 | **ライトの `--text-muted #71717a` on `--muted #f4f4f5` = 4.4:1**（kbd 127-138・`.sb-count` 520-530・選択中の行の `.sb-meta` 575-597・segmented の非選択） | §2.2（薄い on muted ≥ 4.5） | #1 で解消（新しい値は 4.7） |
| 3 | 文字の役割が `--text` / `--text-muted` の 2 つ。時刻・ラベル・ヒント・補足が同じ灰色 12px（app.css:116-119・592-597・937-942・1106-1112） | §2.3 3 役 | `--text-secondary` を足し、`.meta`（カードの見出しの中のものを含む）・`.sb-meta`・`.tl-time`・`th` を secondary、`.composer-hint`・placeholder・`.sb-empty`・無効を muted に |
| 4 | `::selection`・`caret-color` 未指定（grep 0 件） | §2.3 ブラウザの面 | `::selection`・`caret-color` を app.css に |

### UI-1 スマホの基礎（CSS + meta + JS 数行）（済）

| # | 事実（今） | 決まり | 直し |
|---|---|---|---|
| 5 | `index.html` に `theme-color`・`manifest`・`apple-*` の meta が無い（1〜16 行） | §4・web-ui.md §11.2 | theme-color 2 行（manifest・apple は UI-3） |
| 6 | `app.css` に `env(safe-area-inset-*)` が 1 つも無い。下タブ（1865〜）・タイトルバー・ドロワー・トーストが notch / ホームインジケータを考えていない | §4 | §3 の分解 |
| 7 | `:hover` が `@media (hover: hover)` だけ（app.css 350・402・564・771・1159・1641・1851、base.css 288） | §4 | `and (pointer: fine)`。base.css の分は app.css で打ち消す |
| 8 | `touch-action: manipulation`・`overscroll-behavior` が無い（635 の `none` はつまみ） | §4 | §3 の分解 |
| 9 | 会話の本文 `.msg-text`（944〜）が `.wb` の 14px（102 行）を継ぐ。指の端末でも 14 | §3 | `pointer: coarse` で 16 |
| 10 | 押せるもの（タブ・行・アクティビティ）に `user-select: none` が無い（501 行だけ） | §4 | §3 の分解 |
| 11 | ダイアログの入力・送る欄に `enterkeyhint` が無い（index.html 76・104・108、chat.js の composer） | §5 入力欄 | `enterkeyhint` |
| 12 | `.tab-close` が `--space-6` = 24×24（app.css:745-751）で、指の端末の 44 に足りない | §4 | `pointer: coarse` で `::before { inset: -8px }` |
| 13 | ≤639px でステータスバーごと `display: none`（app.css:2001-2005）。Bot の切断・実行中・知らせが**どこにも出ない** | §4 スマホでも状態の要点 | タイトルバー右に接続の点 + 鈴（≤639px だけ表示）、下タブ「会話」の数の位置に実行中のスピナー |
| 14 | トースト（ui.js:168）と知らせ（workbench.js:407、app.css:1575-1582）の本文 `span` に `min-width: 0` / `overflow-wrap` が無い（推測: 長い題名・URL で溢れる） | §3 折り返し | CSS 2 行 |
| 15 | 使用量のターンの表が 9 列（views.js:165）。推測: スマホで横スクロール | §4 表 | ≤639px は 5 列、残りは行の `details`（表の組み替えは UI-5 と同じ PR でもよい） |

### UI-2 押した感と動き（CSS + ui.js の小さな JS）（済）

| # | 事実（今） | 決まり | 直し |
|---|---|---|---|
| 16 | `:active` が app.css にも base.css にも無い | §6 | 全部の押せるものに |
| 17 | 動きは `ease` 150ms だけ。ドロワー（1892〜）は開閉同じ長さ。ダイアログ・トーストに出入りが無い。`--ease-out`・`--dur-*` の変数が無い | §6 | 変数 4 つ・表のとおり |
| 18 | トーストの自動消去（ui.js:148 `TOAST_MS`）が hover / focus で止まらない。失敗のトーストに [もう一度] が無く `role="status"` のまま（index.html:129） | §5 トースト・§8 | 失敗用の `role="alert"` の容れ物 + [もう一度] の口 + hover / focus で timer を止める |
| 19 | 許可の残り時間が描き直し（3 秒）のときだけ進む（views.js:869-874・901） | §6.1 1 秒の刻み | chat.js:653-659 と同じ 1 秒の interval で文字だけ更新 |
| 20 | 「要約しています…」のトースト（chat.js:187・209）とタイムラインの spinner 行（594-599）が同時 | §5 トースト（見える結果にはトーストを出さない） | トーストを消す。失敗だけ |

### UI-3 PWA（済）

| # | 事実（今） | 決まり | 直し |
|---|---|---|---|
| 21 | `static.ts` の名前の形が `html|css|js|svg` だけ（21 行）。favicon・manifest・apple の meta・アイコンが無い | web-ui.md §11.1・§11.2・§11.5 | `docs/plan/web-ui.md` §11 のとおり。アイコンは `scripts/make-icons.ts`（決定 a） |

### UI-4 言葉（文字列だけ）（済）

| # | 事実（今） | 決まり | 直し |
|---|---|---|---|
| 22 | 実装名が画面に出る: `task_add・task_update`（views.js:346）、`project_open`（sidebar.js:295）、`kb_delete`（views.js:1096）、`claude agents --json`（sidebar.js:266）、`SELF_AGENT_CC`（views.js:528）、`settings.json`（index.html:113）、権限モードの識別子だけ（index.html:112-118）、失敗の fallback `"<status>: <error>"`（views.js:685） | §7 実装名を出さない（決定） | 言い換え。権限モードは「acceptEdits（編集は確認なし）」の形。fallback は「操作に失敗しました。もう一度試してください」 |
| 23 | 空の表示が「〜はありません」で止まり、次の行動が無い（views.js 342・397・431・642 など）。失敗に [読み直す] が無い（views.js 128・219・1083） | §7 空・§5 空の表示 | 次の行動の文 + 失敗は [読み直す] |
| 24 | placeholder が操作の説明（chat.js:446「Enter で送信…」、index.html:55「名前で探す。> か / でコマンド」）。入力欄の下の常設の 1 文（chat.js:495、views.js:836）。見出しの「n 秒ごとに更新」（views.js:998・1166）。起動ダイアログの 120 字の段落（index.html:121）。一覧の末尾の `.meta` 段落（views.js 346・401・430・558・638・645） | §5 入力欄・§7 常設の説明文 | placeholder は「<題名> に送る」「探す」。説明は `title`・設定のキー一覧へ。段落は 2 文まで |
| 25 | 「新しいセッション」が会話と Claude Code で同じ文言（sidebar.js:93・260）。「取り消す」が undo（トースト）と cancel（送信待ち views.js:755）の両方。「閉じる」がタブ・セッション・トーストで 3 つの意味 | §7 語彙の表 | Claude Code 側は「Claude Code を起動」、送信待ちは「やめる」。タブとトーストの「閉じる」はアイコンだけ（`aria-label` は残す） |
| 26 | 成功の文に括弧の補足（workbench.js:717「（Discord にもチャンネルができました）」）。`confirm` の既定「OK」（ui.js:202） | §7 | 1 文に。既定は「実行する」 |
| 27 | パレットの label が「/new 新しいセッション」で detail と二重（workbench.js:548-561） | §5 パレット | label は動詞句、`/new` は右の kbd 風 |
| 28 | 補足を「・」で 3〜4 要素つなぐ（views.js:514・1095・461-465） | §7 2 要素まで | 改行か別の `span` |

### UI-5 部品の整理（CSS + JS）（済）

| # | 事実（今） | 決まり | 直し |
|---|---|---|---|
| 29 | 使用量の人格ごとの `.card.card-sm` の並び + `dd` 16px × 3 の hero-metric（views.js:131-146、app.css:1204〜） | §5 使用量の数字 | 人格ごとの行の表。キャッシュ率だけ大きく |
| 30 | base.css の `.card` に `--shadow-sm` | §2.3 影 | app.css で `.card { box-shadow: none }` |
| 31 | 読み込み中に `.empty`（破線枠 + 48px 余白）を流用（views.js:40-42 の `empty` を 12 箇所）。読めた瞬間に跳ぶ | §5 読み込み中 | `.loading` を足し、`empty(null, "読み込んでいます…")` を置き換え |
| 32 | 会話の見出しの操作が 6 個で、後ろ 3 つが同じ `.btn-secondary`（chat.js:410-437） | §5 ボタン（secondary 2 つまで） | [閉じる] だけ secondary、他は ghost。≤639px は `…` にまとめパレットのコマンドへ |
| 33 | 許可のカード: 3 ボタン、ルール込みで折り返すボタン（app.css:1366-1372）、許可が primary（views.js:926-941）。`.card` の中の `.code-pre` が同じ枠・角丸（views.js:905、app.css:1316-1327）。`h3` が h1 直下（views.js:900） | §5 許可のカード・§4 角丸・§8 見出し | [許可]（secondary）[拒否]（ghost）+ `label.check`「このセッションでは常に許可」+ `<code>` のルール。`.card .code-pre { border: 0; border-radius: var(--radius-sm); background: var(--bg) }`。`h2` |
| 34 | `confirm` が danger でも `ok.focus()`（ui.js:223） | §5 ダイアログ | `opts.danger ? cancel.focus() : ok.focus()` |
| 35 | ダイアログの入力に `aria-describedby` / `aria-invalid` / `required` が無い（workbench.js:704-708・793-803、index.html:76・104）。`p.alert` が hidden から出ると跳ぶ（index.html:86・120） | §5 入力欄・§8 | 属性 3 つ。`.alert` の場所に `min-height: 1lh` |
| 36 | 見出しの段が飛ぶ（h1 → h3。views.js:138・900、chat.js:265）。閉じる前の確認の「要約」「候補」が `p.meta`（chat.js:265-268） | §8 見出し | `h2`・`dl` |
| 37 | Claude Code の行のバッジが最大 7 個（sidebar.js:208-220） | §5 バッジ（行は 1 つ） | 最重要 1 つ（許可待ち > 届け待ち > trust > tmux の外）。残りは `title` とタブ |
| 38 | 群の見出しの数のピル `.sb-count`（sidebar.js:58、app.css:520-530） | §5 バッジ（ピルは未読だけ） | 文字に |
| 39 | タスクの表: id 先頭・`—` 2 列・行ごとに secondary の [完了]（views.js:322-343）。リマインド: 行ごとに [次を飛ばす][止める]（views.js:363-386） | §5 表・一覧の行（行の操作は 1 つ） | 先頭を `label.check`（チェック = 完了）、id は題名の下。リマインドの行は [次を飛ばす] だけ、[止める] は右端に離すか `…` |
| 40 | `.cc-screen` が 12px の `pre`（app.css:1392-1397） | §3 端末の写し | 14px（coarse 13。段階の唯一の例外）・行間 1.35・地 `--bg`・`tab-size: 4` |
| 41 | z-index が 44 / 45 / 50 / 60 の生の数（app.css:1652・1798・1860・1886） | §4 `--z-*` | 変数の表 |
| 42 | パレットの候補に一律 `chevron-right`（workbench.js:609）。アイコン無しの行（セッション）で label の開始位置が違う（sidebar.js:78、app.css:550） | §4 揃える・§5 パレット | 空の 16px の箱 |
| 43 | `.steps > summary` に chevron + 終わり方のアイコン + 文（chat.js:323-328） | §5 1 要素 1 アイコン | 終わり方のアイコンを消し、色は文に |
| 44 | リマインドの種類がサイドバーはアイコン、タブは文（views.js:389-390、sidebar.js:147） | §7 同じものに同じ表現 | タブにも同じアイコン |
| 45 | `:disabled` が `opacity: 0.5; pointer-events: none` だけ（base.css:300〜）。理由（`title`）が無い | §5 ボタン | app.css で `cursor: not-allowed`（`pointer-events` を戻す）+ 無効の理由 |
| 46 | チェックボックスの `accent-color` が `--primary`（base.css:361 の `.check > input { accent-color: var(--primary) }`） | §5 チェック | app.css で `.check > input { accent-color: var(--accent) }` に上書き（base.css は変えない） |
| 47 | スキップリンクが無い | §8 | 1 つ足す |

問題なし（記録だけ）: 絵文字・大文字ラベル・グラデーション・`→`・`transition: all`・`will-change`・感嘆符は 0 件。「…」・tabular-nums・`aria-label`・`aria-pressed`・`aria-current`・`role="combobox"`・`Intl`・`scrollbar-color`・`minmax(0, 1fr)`・`dvh` は使っている。`.dot` は生きた状態を表すので可。オーナーの吹き出しと人格の裸の文の非対称は性格なので変えない。`<select>` の色は base.css で明示済み。

### NAV スマホの下タブ（CSS + JS。NAV-1 タブとシート / NAV-2 全幅の一覧）（済）

| # | 事実（今） | 決まり | 直し |
|---|---|---|---|
| 48 | ≤1023px の下のバーが `overflow-x: auto` で、8〜11 個 × 64px が iPhone の幅に入らず横スクロール（app.css:2359-2378） | §4 スマホの下タブは固定 4 + その他 | ≤639px で `ACTIVITIES` を主要（会話・タスク・リマインド）と「その他」に分け、4 個を等幅に。`overflow-x: hidden` |
| 49 | 残りのアクティビティ（ナレッジ・記憶・プロジェクト・GitHub・使用量・会話ログ・状態・設定）の置き場が無い | §5 ポップオーバー・メニュー（`position: fixed`）・§6 シート | 「その他」で下タブの上に下からのシート（`#more-sheet`。`role="dialog"`）。行は `.sb-row` と同じ形。有効でないものは行ごと出さない |
| 50 | 一覧が左からの 85vw のドロワー + backdrop（app.css:2337-2357）。1 行が狭く、後ろに本文が透ける | 決定 2（全幅） | ≤639px で `.wb-sidebar { width: 100% }`、右の線と影を外し、backdrop を出さない。開閉の JS は今のまま |
| 51 | 起動時にタブが無いとようこそ（views.js:1392-1412）。文が「左の一覧から」でスマホに合わない | 決定 3・§7 言葉 | ≤639px かつタブ無し・hash 無しなら会話の一覧を開いて起動。ようこその文を `hide-sm` / `show-sm` の 2 つの `span` に |
| 52 | 「会話」の数が未読のチャンネル数だけ（sidebar.js:15） | 決定 5 | 未読 + Claude Code の判断待ちの数。`aria-label`「会話（未読・判断待ち n）」。「その他」は中に数のあるものがあれば `.dot` 1 つ |
| 53 | Esc がパレット → ドロワーの順（workbench.js:970-973）。幅を跨いだときの後始末が `mqNarrow` だけ（1071-1075） | §8 | Esc はパレット → シート → ドロワー。`mqPhone` の change でもシートを閉じて描き直す |

注記（Claude Code の統合との順）: 統合の PR が `ACTIVITIES` の `cc` を消す。NAV が先に merge されるなら `cc` に `phone: "more"` の印を付けて「その他」の末尾に置き、統合の PR で項目ごと消す。統合が先なら印は要らない。判断待ちの数は統合の設計が store に持つ関数（判断待ちのセッション数）を使い、まだ無ければ未読だけ。

返事の本文（UI-11。#254）: 会話のタブの返事は最小限の Markdown（見出し `#`〜`###` は太字の行・太字・箇条書きと番号（入れ子は 1 段）・フェンスは横スクロールの `pre.code-pre`・インラインコード・http(s) の URL のリンク。表・引用・画像・HTML・閉じない `**` は文字のまま、閉じないフェンスは末尾までコード）を ui.js の `renderText` で要素に組んで描き、オーナーの発言は文字のまま。

## 2. 段の順と理由

**UI-6 → UI-1 → UI-2 → UI-3 → UI-4 → UI-5。**

- **UI-6 を最初に**: app.css の `:root` だけの CSS で、振る舞いを変えない。後の段が書く色の値（UI-1 の theme-color、UI-2 の `::selection`、UI-3 の manifest の `theme_color` / `background_color`・アイコンの地）が全部これに依存する。先にやると値を 1 回書くだけで済み、後にやると UI-1・UI-3 を書き直すことになる。ライトのコントラスト（#2）もここで解消する。提案されていた「UI-3 の後」にしない理由はこれ。
- **UI-1 → UI-2**: どちらも CSS 中心で独立だが、同じ app.css を触るので merge は順に。UI-1 が iPhone で使えるようにする最小で、0.1.0 に要る。
- **UI-3**: UI-1（safe-area・theme-color の JS）の後。アイコンの題材は決定済みなのですぐ始められる。
- **UI-4**: 文字列だけ。いつでもよいが、UI-5 が部品を組み替えるときに文字列も動くので、先に語彙を固めておくと UI-5 の diff が小さい。
- **UI-5**: いちばん大きく、JS の組み替え（表・許可のカード・サイドバー）を含む。最後。

0.1.0 の公開に入れるなら UI-6 → UI-1 → UI-2 → UI-3 まで。`base.css`・`templates/web/DESIGN.md` は**どの段でも変えない**（base.css の hover・`:disabled`・`.card` の影は app.css で打ち消す）。

- **NAV は UI-5 の後**。Claude Code の統合（会話の一覧の群）とは独立で、どちらが先でもよい（§1 の NAV の注記）。

### NAV の段の順

NAV-1（タブとシート。#48・#49・#52・#53）→ NAV-2（全幅の一覧と起動時の会話。#50・#51）。同じ PR の 2 コミットでよい。NAV-2 は NAV-1 の CSS の隣に足すだけで独立している。

## 3. implementer に渡す分解

### UI-6 性格と色（#1〜#4）（済）
触る: `app.css` だけ。
1. `:root[data-theme="dark"]`・`:root[data-theme="light"]` の値を GUIDELINES §2.1 の表に差し替える（`--backdrop`・`--shadow-sm` を含む）。
2. 同じ 2 組の値で `:root:not([data-theme])`（ライト）と `@media (prefers-color-scheme: dark) { :root:not([data-theme]) }`（ダーク）を足す（「OS に合わせる」で base.css の zinc に落ちないため）。
3. `--text-secondary` を 4 ブロック全部に足す。
4. 役割の振り直し: `.meta`（`.card-head` の中のものも `.meta` で揃う）・`.sb-meta`・`.tl-time`・`.table th`・`.metrics dt`・`.counter`・`.out-time`・`.panel-note`・`.kv-label`・`.sbar-item`・`.panel-tab`（選択中は `--text`）・`.sb-title`・`.tl-divider`・`.tl-notice`・`.steps-list` → `var(--text-secondary)`。`.kv-value` は値なので `var(--text)`。`.composer-hint`・`.sb-empty`・`.empty`・`::placeholder`（base.css が `--text-muted` なので変更なし）・`.btn:disabled` → `var(--text-muted)` のまま。アイコンの色（`.sb-row .icon`・`.ed-title > .icon`・`.act-btn`・`.table .td-main .icon`・`.notice-item .icon`・`.palette-item .icon`）は `--text-secondary`、区切りのアイコン（`.tab-close`・`.steps-chevron`）は `--text-muted` のまま（GUIDELINES §2.3: 押せるもののアイコンは二次、押せない飾り・区切りのアイコンは薄い）。`.dot` の既定の色は `--accent`（§6.1）。
5. `::selection { background: var(--accent); color: var(--primary-text) }`、`input, textarea { caret-color: var(--accent) }`。
6. 受け入れ: app.css の `#` の色がトークンの定義の中にだけある（grep）。GUIDELINES §2.2 の表の値を再計算して一致する（スクリプトは scratchpad でよい）。ダーク・ライト・OS に合わせる の 3 つで状態・使用量・会話のタブを目視。

### UI-1 スマホの基礎（#5〜#15）（済。#15 の使用量の表は UI-5 に回した）
触る: `index.html`、`app.css`、`workbench.js`（theme-color の 5 行 + タイトルバー右の点と鈴）、`chat.js`（`enterkeyhint`）、`sidebar.js`（下タブの実行中）。
1. `index.html`: `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">` と dark `#11141c` を `color-scheme` の次に。`#new-title`・`#cc-start-title` に `enterkeyhint="done"`、`#palette-input` に `enterkeyhint="search"`。
2. `app.css`: `html, body { overscroll-behavior: none }`。`.tl`・`.wb-sidebar`・`.wb-panel`・`.palette-list`・`.master` に `overscroll-behavior: contain`。`.act-btn`・`.tab`・`.sb-row`・`.panel-tab`・`.sbar-item`・`.btn` に `touch-action: manipulation; user-select: none; -webkit-user-select: none`。
3. `app.css` の 1023 以下: `.wb` の最後の行を `calc(var(--bottomnav-h) + env(safe-area-inset-bottom, 0px))`、`.wb-activity` に `padding-bottom: env(safe-area-inset-bottom, 0px)`、`.wb-titlebar` に `padding-top: env(safe-area-inset-top, 0px)` と行の高さの加算、`.toast-stack`・`.wb-sidebar` の `bottom` に同じ加算。
4. `app.css`: 7 箇所の `@media (hover: hover)` を `and (pointer: fine)` に。base.css の `.btn-*:hover` は `@media (hover: hover) and (pointer: coarse) { .btn-primary:hover, .btn-secondary:hover, .btn-danger:hover { opacity: 1 } .btn-ghost:hover { background: transparent } }` で打ち消す。
5. `app.css`: `@media (pointer: coarse) { .msg-text, .palette-input { font-size: var(--font-base) } }`。`.palette-input` は app.css:1679 で 14（`--font-sm`）を明示していて、coarse の 16 は app.css:1696-1700 に別の規則で既にあるので、この規則にまとめてその規則を消す（GUIDELINES §5 のパレット: 指の端末で 16・PC は 14）。`.composer-input` は既に 16 なので入れない。
6. `app.css`: `@media (pointer: coarse) { .tab-close { position: relative } .tab-close::before { content: ""; position: absolute; inset: -8px } }`。
7. `app.css`: `.toast > span, .notice-item > span:not(.out-time) { min-width: 0; overflow-wrap: anywhere }`。
8. `workbench.js` の `applyTheme`: `meta[name="theme-color"]` 2 つの `content` を `dark` なら `#11141c`、`light` なら `#ffffff`、`system` なら media ごとの元の値に。
9. `workbench.js`: `.wb-title-actions` の先頭に、接続の `.dot`（既定の人格の Bot。押すと状態のタブ）と鈴（押すとパネルの知らせ。`recent24h` の数）を足し、`app.css` で ≥640px は `display: none`。`sidebar.js`: 実行中が 1 以上なら下タブ「会話」の `.act-count` の位置に `.spinner-sm`。
10. `chat.js`: composer の `textarea` に `enterkeyhint`（タッチが主なら `"enter"`、それ以外 `"send"`）。
11. 使用量の表（#15）: ≤639px で `hide-sm` を 4 列に付け、残りを行末の `details` に（表の組み替えを UI-5 でやるなら、ここは `hide-sm` だけでよい）。
12. 受け入れ: iPhone 実機で、下タブがインジケータに隠れない・ステータスバーの色が合う（3 テーマ）・会話の本文 16px・入力で拡大しない・タップの点滅と hover の残りが無い・タブの × が押せる・タイトルバーに接続の点と鈴が出る・実行中に下タブにスピナー。PC は見た目が変わらない。`npm test`・inline なしの grep。

### UI-2 押した感と動き（#16〜#20）（済）
触る: `app.css`、`ui.js`、`index.html`（失敗のトーストの容れ物）、`views.js`（許可の残り時間・失敗のトーストの呼び出し）、`chat.js`（要約のトーストを消す・失敗のトーストの呼び出し）、`workbench.js`（失敗のトーストの呼び出し）。
1. `app.css` の `:root` に `--dur-micro: 120ms; --dur-short: 200ms; --dur-long: 300ms; --ease-out: cubic-bezier(0.23, 1, 0.32, 1)`。
2. `.btn:active, .act-btn:active, .tab:has(.tab-label:active), .panel-tab:active, .sbar-item:active, .welcome-link:active, .cmd-center:active { transform: scale(0.97) }`（`transition: transform var(--dur-micro) var(--ease-out)`。タブはラベルを押したときだけで、× では縮めない）。`.sb-row:active, .master-item:active, .is-clickable:active { background: var(--muted) }`。
3. ドロワー: 開く `transform var(--dur-long) var(--ease-out)`、`.wb:not(.is-drawer-open) .wb-sidebar` は 200ms。`dialog[open]` と `.toast` に `@starting-style`（opacity 0・scale(0.98) / translateY(8px)）、閉じる側は `transition` を 130ms。パレットには付けない。
4. `index.html`: `<div class="toast-stack" id="toast-alert" role="alert" hidden>` を `#toast` の次に（2 つを `.toast-region` で囲み、置き場所は囲みが持つ。重ならないため）。`ui.js` の `toast(text, action, opts)` に `opts.level === "error"` で `#toast-alert` に入れ、`action` が無くても `opts.retry` があれば [もう一度] を付け、自動で消さない。`.toast-alert` は左 2px の `--danger`。消えるときは `.is-leaving` を付け、トーストそのものの `transitionend`（動きが無いときは保険の 400ms）で外す（長さは CSS だけが持つ）。
5. `ui.js`: `pointerenter`（`pointerType === "mouse"` のときだけ。指のタップでは止めない）/ `focusin` で `clearTimeout`、`pointerleave` / `focusout`（焦点がトーストの外へ出たとき）で `TOAST_MS` から数え直す。
6. 操作の失敗のトーストを `{ level: "error", retry }` に（retry は押したボタンを掴まずに同じ操作をもう一度。自然に作れないものは retry なし）:
   - `views.js`: タスク・リマインド・記憶の操作（`act`。retry は `act(null, …)`）・GitHub の [対応]・[起動して送る]・CC の許可への回答・送信待ちの取り消し・[追いかけをやめる]・CC への送信（retry は入力欄の今の本文を送り直す）。
   - `chat.js`: `opFailed`（/wait・/close・/renew・/close の確定。/close・/renew の retry は確認を挟まずに始め直す）・[中断]・[続ける]・送信（retry は入力欄の今の本文）。
   - `workbench.js`: /new と CC の起動の失敗（ダイアログが開いたままで、押し直せるので retry なし）、CC の起動の前のプロジェクトの読み込みの失敗（retry は開き直し）。
   - **知らせのまま残すもの**: 404・409 の「古くなっています」（失敗ではなく、読み直しで画面が正しくなる）・入力の検査（「1,900 字までです」など。直すのは入力欄）・`api.js` の読み直しの失敗（ポーリングは間隔を延ばして自動で戻り、続く失敗の最初の 1 回だけ出す。消えないトーストにすると戻った後も残る）・画面側に失敗の表示がある単発の読み込み（ナレッジの本文・プロジェクトのファイルなど。画面の空の表示が失敗を示す）。
   - 許可のカードの「残り m 分 s 秒」は `setInterval` 1 秒で文字だけ更新（`data-permission-left` の `textContent`）。interval は chat.js の経過時間と同じく常に 1 つで、カードが無い・隠れたタブでは何もしない（カードごとの `clearInterval` は持たない）。
7. `chat.js`: 187・209 の「要約しています…」のトーストを消す（spinner の行が既にある）。
8. 受け入れ: 全部の押せるものが押下で縮む。ドロワー 300 / 200。ダイアログ・トーストが出入りし、閉じる方が速い。パレットは動かない。失敗のトーストが `#toast-alert` に出て消えず [もう一度] が効く。許可の残り時間が 1 秒ずつ減る。reduced-motion で崩れない。

### UI-3 PWA（#21）（済。favicon の名前は icons.svg と紛れないよう `app-icon.svg` にした）
触る: `src/web/static.ts`、`index.html`、`src/web/static/`（manifest・SVG・PNG）、`scripts/make-icons.ts`、`package.json`（`make-icons`）、`test/`。
1. `static.ts`: `STATIC_NAME` に `png|webmanifest`、`CONTENT_TYPES` に `png: "image/png"`・`webmanifest: "application/manifest+json; charset=utf-8"`。先頭のコメント・`staticFileFor` の JSDoc・`server.ts` の `/static/*` のコメントの拡張子の並びも合わせる。
2. `scripts/make-icons.ts`: 図形の定義（角丸の正方形の地 `#11141c`、2 本の横線 `#eef0f5`、右下の点 `#6b9aff`）から `app-icon.svg`・`apple-touch-icon.png`（180）・`icon-192.png`・`icon-512.png`・`icon-512-maskable.png`（印は中央 80% の円の中）を `node:zlib` だけで書く（web-ui.md §11.5）。
3. `manifest.webmanifest`（web-ui.md §11.1。`background_color` `#0b0d14`・`theme_color` `#11141c`）。
4. `index.html`: `rel="manifest"`・`rel="icon"`（`app-icon.svg`）・`apple-touch-icon`・`apple-mobile-web-app-capable`・`apple-mobile-web-app-status-bar-style`・`apple-mobile-web-app-title`。
5. テスト: `/static/manifest.webmanifest`・`/static/icon-192.png` が認証なしで 200 と正しい Content-Type。`/static/x.json`・`/static/a/b.png`・`/static/.png` は 404。index.html の grep（manifest・theme-color 2 つ・apple-touch-icon・inline なし）。PNG の先頭 8 バイトと IHDR の幅・高さ。maskable の中央 80% の外側が地の色だけ。`make-icons` の出力が commit と一致。
6. 受け入れ: web-ui.md §11.6。

### UI-4 言葉（#22〜#28）（済）
触る: `views.js`・`sidebar.js`・`chat.js`・`workbench.js`・`ui.js`・`index.html` の文字列だけ。テストで文字列を見るものがあれば合わせる。
1. 実装名の言い換え（#22）: 「Bot が task_add・task_update を使います」→「会話で頼むと増えます・変わります」。`project_open` → 「会話でページを作ると増えます」。`kb_delete` → 「削除は Discord の確認から」。`claude agents --json` → 「一覧を読めませんでした」。`SELF_AGENT_CC` → 「Claude Code の連携が無効です（設定で有効にできます）」。`settings.json に従う` → 「既定（この機械の設定に従う）」。権限モードの選択肢に説明を添える。失敗の fallback は「操作に失敗しました。もう一度試してください」。
2. 空の表示（#23）: 各 `empty(...)` に次の行動の文。失敗の `empty` には [読み直す]（`btn-ghost btn-sm`。押すと同じ読み直し）。
3. placeholder と説明（#24）: composer は `"<題名> に送る"`（入口は「#inbox に送る」）、パレットは「探す」。`composer-hint`・views.js:836 の 1 文・「n 秒ごとに更新」は消して `title` に。起動ダイアログの段落は「この機械の tmux に新しいセッションを作り、claude を起動します。題名は 40 字までです。」。一覧の末尾の `.meta` は 1 文に。
4. 語彙（#25・#26・#27）: sidebar.js:260 を「Claude Code を起動」、views.js:755 を「やめる」、workbench.js:717 の括弧を削除、ui.js:202 の既定を「実行する」、パレットの label を動詞句（「新しいセッションを作る」「閉じる」…）にして `/new` は右の kbd 風の `span`（検索は label + detail + keys）。
5. 「・」（#28）: 3 要素以上の meta を改行か 2 つ目の `span.meta` に。
6. 受け入れ: grep で `_add`・`_update`・`_open`・`_delete`・`--json`・`SELF_AGENT_`・`settings.json`・「送信」・「キャンセル」・「クローズ」・「OK」が画面の文字列に 0 件（設定の環境変数の表を除く）。語彙の表の語だけが使われている。

変えた語（前 → 後。主なもの）:

| 場所 | 前 | 後 |
|---|---|---|
| api.js（失敗の既定の文） | `<status>: <error>` | 操作に失敗しました。もう一度試してください（Error の message には番号を残す） |
| タスクの末尾 | 追加・編集は #inbox か #tasks に書いてください（Bot が task_add・task_update を使います）。 | タスクは #inbox か #tasks の会話で頼むと増え、変わります。 |
| サイドバーのプロジェクト | プロジェクトはセッションの中で project_open を使うと作られます。 | プロジェクトは会話でページを作ると増えます。 |
| ナレッジの中身 | 削除は Discord の確認（kb_delete）から行います。 | 削除は Discord の確認から行います。 |
| Claude Code の一覧 | claude agents --json を続けて読めないため、一覧を空にしています。 | 一覧を読めませんでした。 |
| GitHub の [対応]（無効の title） | SELF_AGENT_CC が無効です／このリポジトリには送れません（または…） | Claude Code の連携が無効です（設定で有効にできます）／この通知は送れません。この機械に無いリポジトリか、[対応] を足す前の通知です |
| GitHub の失敗 | GitHub が拒否しました（403）／gh の認証 | GitHub に拒否されました／gh の認証が通りません |
| 起動のダイアログ | 既定（settings.json に従う）・default・acceptEdits・plan・auto | 既定（この機械の設定に従う）・default（使うたびに確認）・acceptEdits（編集は確認なし）・plan（計画だけ）・auto（自動で判断）。許可のカード・セッションのタブの権限モードも同じ説明を添える |
| 起動のダイアログの見出し・段落 | 新しい Claude Code のセッション／（5 文の段落） | Claude Code を起動／この機械の tmux に新しいセッションを作り、claude を起動します。題名は 40 字までです。 |
| サイドバーの Claude Code のボタン | 新しいセッション | Claude Code を起動 |
| 送った本文の届け待ち | 送信待ち／送信 #n／[取り消す]／取り消しました | 届け待ち／本文 #n／[やめる]／送るのをやめました（GitHub の [対応] のトーストの操作も [やめる]） |
| 確認ダイアログの既定 | OK | 実行する |
| placeholder | <題名> に送る（Enter で送信・Shift+Enter で改行）／名前で探す。> か / でコマンド／検索（3 文字以上） | <題名> に送る／探す／探す（説明は title と設定のキー一覧へ） |
| 入力欄の下の常設の文 | Discord で発言したのと同じ経路で…／入力待ちのときに tmux で貼って… | 入力欄の title へ（composer-hint の span は余白として残す） |
| 見出しの更新間隔 | 10 秒ごとに更新／3 秒ごとに更新（常設の文） | 見出しの title へ |
| パレット | /new 新しいセッション・/close 今のセッションを閉じる…・表示: サイドバーの切り替え… | 新しいセッションを作る（右に `/new`）・今のセッションを閉じる（`/close`）…・サイドバーを切り替える。検索は label + detail + keys。使えないときは理由（セッションの会話のタブで使えます など） |
| 成功の文の括弧 | セッション「x」を作りました（Discord にもチャンネルができました）／閉じました（登録 n 件） | セッション「x」を作りました／閉じました。タスクを n 件登録しました |
| 空の表示 | このタスクはありません／動いているリマインドはありません／記憶はありません／ナレッジはありません／見つかりませんでした／ファイルはありません ほか | 状態ごとの文 + 次の行動（例: 動いているリマインドはありません。会話で「明日 9 時に知らせて」と頼むと増えます。）。検索 0 件は「「q」に合うナレッジはありません。別の語で探してください。」 |
| 読めなかったとき | 読み込めませんでした（使用量・会話ログ・ナレッジの項目） | 「〜を読み込めませんでした。」+ [読み直す]（同じ読み直し） |
| 「・」の 3 要素以上 | GitHub の行の補足・取得の状態・ナレッジの #id・保存・更新・会話ログの「・失敗」・状態の「有効・…」 | 2 つの span／括弧に分ける |
| 送れなかった | Bot が接続していません／送れませんでした（Discord に投稿できません）／/setup を実行してください | 送れませんでした。Bot が Discord につながっていません／送れませんでした。Discord に投稿できません／作れませんでした。Discord で /setup を実行してください |

テスト: `test/web-static.test.ts` の「画面の言葉」が JS の文字列（コメントを除く）と index.html に「！」・ツール名（`<小文字>_(add|list|…)`）・HTTP の番号が主役の文（`403:`・`（403）`・HTTP）・語彙の表で使わない語（送信・キャンセル・クローズ・OK・`--json`・`SELF_AGENT_`・`settings.json`）が無いことと、トーストの文に応答の status をつながないことを確かめる。

### UI-5 部品の整理（#29〜#47）（済。3 コミット（UI-5a 表と一覧・UI-5b 許可のカードとダイアログ・UI-5c 細部）。`.card-sm` は確認のカードが使うので残した。日ごとのグラフはまだ無いので 1 色の決まりは作るときに守る。`--z-sash` は今は使う所が無い（定義だけ））
触る: `views.js`・`sidebar.js`・`chat.js`・`ui.js`・`workbench.js`・`app.css`・`index.html`。論点ごとに commit を分ける（1 PR 1 論点が重ければ UI-5a 表と一覧 / UI-5b 許可のカードとダイアログ / UI-5c 細部 の 3 PR に割ってよい）。
1. 使用量（#29）: `.metric-grid` のカードを `table`（人格 / ターン / 失敗 / 入力 / 出力 / キャッシュ率）に。キャッシュ率のセルだけ `--font-base`・500。`app.css` の `.metric-grid`・`.card-sm`・`.metrics` を消す。
2. 読み込み中（#31）: `app.css` に `.loading { min-height: var(--space-8); color: var(--text-muted); font-size: var(--font-sm); padding: var(--space-3) 0 }`。views.js の `empty(null, "読み込んでいます…")` を `loading()`（`aria-busy="true"`）に。
3. 会話の見出し（#32）: [閉じる] secondary、[待ちにする][会話を新しくする] ghost。≤639px は `…`（`aria-label="ほかの操作"`）で、押すとパレットをそのチャンネルのコマンドで開く。
4. 許可のカード（#33）: `h2`。ボタンは [許可]（secondary）[拒否]（ghost）。`label.check` + `input[type=checkbox]`「このセッションでは常に許可」+ 次の行に `<code>` のルール。チェックで [許可] の送り先が `always`。末尾の段落は `title`。`.card .code-pre` の枠を外し `--radius-sm`・地 `--bg`。
5. ダイアログ（#34・#35）: `opts.danger ? cancel.focus() : ok.focus()`。`#new-title`・`#cc-start-title` に `required aria-required="true" aria-describedby="new-error"`、エラー時に `aria-invalid="true"`（消すとき外す）。`.alert` の場所に `min-height: 1lh` の容れ物。
6. 見出し（#36）: h1 直下の `h3` を `h2` に。閉じる前の確認の「要約 / 候補」を `dl`。
7. サイドバー（#37・#38・#42）: Claude Code の行のバッジを 1 つに（優先順は表のとおり。残りは `title`）。`.sb-count` を `.sb-note` の文字に。アイコン無しの行に空の `span.icon`。パレットの一律 chevron を空の箱に。
8. 表と行（#39・#44）: タスクの先頭列を `label.check`（チェック = complete。トーストの [取り消す] はそのまま）、id は題名の下の `span.meta`、`—` を空に。リマインドの行は [次を飛ばす] だけ、[止める] は `…` のメニュー（`popover`）か右端に `gap: var(--space-4)` で離す。タブの種類の列に同じアイコン。
9. 細部（#30・#40・#41・#43・#45・#46・#47）: `.card { box-shadow: none }`。`.cc-screen { font-size: var(--font-sm); line-height: 1.35; background: var(--bg); tab-size: 4 }` + coarse で 13px（GUIDELINES §3 の段階の唯一の例外。ほかに 13 を使わない）。`:root` に `--z-sash: 10; --z-drawer-backdrop: 40; --z-drawer: 41; --z-palette: 50; --z-toast: 60` と置き換え。`.steps > summary` の終わり方のアイコンを消し色は文に。`.btn:disabled { pointer-events: auto; cursor: not-allowed }` + 無効の理由の `title`。app.css で `.check > input { accent-color: var(--accent) }`（base.css の `--primary` を上書き）。`<a class="skip-link" href="#editors">本文へ</a>` を `body` の先頭に（フォーカス時だけ表示）。
10. 受け入れ: 人格 3 体のダミーで使用量が表。読み込み中に枠が出ず跳ばない。会話の見出しの secondary が 1 つ。許可のカードが 2 ボタン + チェック。危険な確認で Enter を押しても実行されない。`h1` の次が `h2`（grep `el("h3"` の親を目視）。z-index の直書き 0 件。Tab の 1 回目でスキップリンク。

### NAV の分解（implementer に渡す）（済。判断待ちの数を返す store の関数がまだ無いので「会話」の数は未読だけ。GitHub には数が無いので「その他」の点はまだ出ない。シートは `.wb` の外に置いたので開いた形は `.wb.is-more-open ~ .more-sheet`、`#more-backdrop` は全幅の一覧の上に重ねるため ≤639 で `--z-drawer`）

触る: `src/web/static/sidebar.js`、`src/web/static/workbench.js`、`src/web/static/index.html`、`src/web/static/views.js`、`src/web/static/app.css`、`docs/design/WEB-UI-GUIDELINES.md`（§3 の文をそのまま）、`docs/plan/web-ui.md` §3.2 の注記、`test/web-static.test.ts`。

#### NAV-1 タブとシート

1. `sidebar.js` の `ACTIVITIES`（14-27）: 各項目に `phone: "primary" | "more"` を足す。`chat`・`tasks`・`reminders` が primary、それ以外（`knowledge`・`projects`・`github`・`usage`・`devlog`・`status`・`settings`。`cc` が残っていれば more）が more。`jobs` は `stage` があるので今までどおり出ない。
2. `sidebar.js`: `visibleActivities()` の隣に `phoneActivities()` を足す: `visibleActivities()` を `phone` で分けて `{ primary, more }`（順は `ACTIVITIES` のまま）。`SA.sidebar` に export。
3. `workbench.js:39` の隣: `const mqPhone = window.matchMedia ? window.matchMedia("(max-width: 639px)") : { matches: false, addEventListener() {} }`、`function phone() { return mqPhone.matches }`。`mqNarrow` はそのまま（ドロワーの判定は 1023 のまま）。
4. `workbench.js` の `S`（51-64）に `moreOpen: false`。
5. `workbench.js` の `renderActivity`（119-148）: `phone()` なら `phoneActivities().primary` のボタン（今の作り方のまま。`act-group` は 1 つ）+ 「その他」のボタン: `class="act-btn act-more"`、`icon("ellipsis")`、`span.act-label`「その他」、`aria-expanded: String(S.moreOpen)`、`aria-controls: "more-sheet"`、`aria-pressed` は「more の中の一覧が見えている（`sidebarShows(id)` が true の more の id がある）か、more の `tab`（状態・設定）か `memories` が前に出ている」とき。more の中に `count()` が 1 以上のものがあれば `span.dot.dot-unread`（`role="img"`・`aria-label="未読あり"`）。`bottom: true` の 2 群分けはスマホでは使わない。
6. 「会話」の数（決定 5）: `sidebar.js:15` の `count` を `store.unreadCount() + <判断待ちの数>` に。判断待ちの数は統合の設計の store の関数（無ければ 0）。`countLabel` を「未読・判断待ち 」に（判断待ちが 0 のときは「未読 」のまま。「・」は 2 要素まで）。PC のアクティビティバーの数も同じ値になる（PC でも判断待ちは見るべきものなので揃える）。
7. `workbench.js` 新規 `renderMore()` / `openMore()` / `closeMore()`:
   - `renderMore`: `#more-sheet` に `ul` と行（`li > button.more-row`: `icon(a.icon)`・`span.sb-label`（`a.label`）・数があれば `span.sb-meta`（数字。tabular））。行の click は `closeMore()` → `selectActivity(a)`（`a.tab` のものは `open`、一覧のものは `openDrawer`。既存の関数のまま）。
   - `openMore`: `S.moreOpen = true`、`renderMore()`、`refs.wb.classList.add("is-more-open")`、`$("more-backdrop").hidden = false`、`renderActivity()`、最初の `.more-row` に `focus()`。ドロワーが開いていても閉じない（一覧の上にシートが重なる。`z-index` は同じ `--z-drawer` で、DOM で後の要素が上）。
   - `closeMore`: 逆。`S.moreOpen` が false なら何もしない。焦点を `.act-more` に戻す。
8. `workbench.js` の `onKey`（970-973）: Esc の順をパレット → シート → ドロワーに。
9. `workbench.js` の `init`（1024-1087）: `$("more-backdrop")` の click で `closeMore`。`mqPhone.addEventListener("change", () => { closeMore(); renderActivity(); })`。`mqNarrow` の change でも `closeMore()`。
10. `index.html`: `#drawer-backdrop`（60）の次に `<div class="drawer-backdrop" id="more-backdrop" hidden></div>` と `<div class="more-sheet" id="more-sheet" role="dialog" aria-label="その他の画面" tabindex="-1"></div>`。inline の script・style・style 属性は書かない。
11. `app.css` の `@media (max-width: 639px)`（2449-2511）に:

| 対象 | 宣言 | 理由 |
|---|---|---|
| `.wb-activity` | `overflow-x: hidden` | 横スクロールを止める |
| `.act-group` | `flex: 1 1 0; min-width: 0` | 1 群を全幅に |
| `.act-btn` | `flex: 1 1 0; min-width: 0; padding: 0 var(--space-1)` | 4 個で等分（1023 のブロックの `min-width` を打ち消す）。320px で 80px、44 以上 |
| `.act-label` | `max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap` | 「リマインド」（5 字 × 12px = 60px）が折り返さない保険。ブラウザで未確認 |
| `.act-more .dot` | `position: absolute; top: var(--space-1); right: var(--space-1)` | 数のピルと同じ位置 |
| `.more-sheet` | `position: fixed; left: 0; right: 0; bottom: calc(var(--bottomnav-h) + env(safe-area-inset-bottom, 0px)); z-index: var(--z-drawer); max-height: 60dvh; overflow-y: auto; overscroll-behavior: contain; padding: var(--space-2) 0; background: var(--surface); border-top: var(--border-width) solid var(--border); box-shadow: var(--shadow-sm); transform: translateY(100%); visibility: hidden; transition: transform 130ms var(--ease-out), visibility 130ms var(--ease-out)` | §5 メニューは `position: fixed`。浮いているものの影は可（§2.3）。`dvh`・safe-area。消 130ms（ダイアログと同じ比） |
| `.wb.is-more-open .more-sheet` | `transform: none; visibility: visible; transition-duration: var(--dur-short)` | 出 200ms |
| `.more-row` | `display: flex; align-items: center; gap: var(--space-2); width: 100%; min-height: var(--row); padding: 0 var(--space-4); background: transparent; color: var(--text); border: 0; font-size: var(--font-sm); touch-action: manipulation; user-select: none; -webkit-user-select: none` と `.more-row:active { background: var(--muted) }`、`.more-row .icon { color: var(--text-secondary) }` | §5 一覧の行・§6 押下。44px は `--row` が coarse で持つ |
| `.more-row .sb-meta` | `margin-left: auto; font-variant-numeric: tabular-nums` | 数は右に |

    ブロックの外（既定の規則）に `.more-sheet, #more-backdrop { display: none }` を書き、≤639 のブロックの `.more-sheet` で `display: block`、`#more-backdrop` は `hidden` 属性で制御（`[hidden]` は base.css の既定のまま。≤639 で `#more-backdrop:not([hidden]) { display: block }`）。
12. `docs/design/WEB-UI-GUIDELINES.md`: §3 の文をそのまま。`docs/plan/web-ui.md` §3.2（71 行目「1023px 以下は下の横」）に「639 以下は固定 4 + その他（`docs/plan/web-ui-polish.md` の NAV）」の注記。
13. `test/web-static.test.ts`: index.html に `#more-sheet`（`role="dialog"`・`aria-label`）と `#more-backdrop` がある。`app.css` に `.more-sheet` の `transition` が `transform`・`visibility` だけ（`height`・`all` を含まない）。画面の言葉のテストは新しい文字列（「その他」「その他の画面」「未読あり」「未読・判断待ち」）を自動で見る。

#### NAV-2 全幅の一覧と起動時の会話

1. `app.css` の ≤639 ブロックに `.wb-sidebar { width: 100%; border-right: 0; box-shadow: none }` と `#drawer-backdrop { display: none }`（JS の `hidden` の切り替えはそのまま）。`transform: translateX(-100%)` と 300 / 200 の transition は 1023 のブロックのまま（一覧が根・本文が先なので、左から戻る向きで通る）。
2. `workbench.js` の `init`（1050 の `restoreTabs()` の後）: `if (phone() && S.tabs.length === 0 && !tabFromHash(location.hash)) { S.activity = "chat"; S.drawerOpen = true; }`（`renderAll()` の前）。`deferred` のタブがあるときは開かない。
3. `views.js` の `renderWelcome`（1401）: `p.meta` の中を `span.hide-sm`「左の一覧から開くか、コマンドで移動します。」と `span.show-sm`「下の「会話」から開くか、検索で移動します。」に。`welcome-links` の「サイドバー」「パネル」の行に `hide-sm`（スマホでは意味が薄い）。
4. ようこそはタブを全部閉じたときだけ出る（`closeTab` の後は今のまま。会話の一覧は開かない）。

#### 受け入れ（iPhone 実機 + PC。「実機 / エミュレータ」のどちらで見たかを書く）

| # | 確認 |
|---|---|
| 1 | ≤639px の下タブが 4 個（会話・タスク・リマインド・その他）で等幅。`nav.scrollWidth === nav.clientWidth`。320px（iPhone SE）でも文字が折り返さない・「…」にならない |
| 2 | 起動（タブ無し・hash 無し）で会話の一覧が全幅で出る。前回のタブがあればそのタブが本文。`#/status` の hash なら状態のタブ |
| 3 | 会話の行を押すと一覧が閉じて会話のタブ。もう一度「会話」か ≡（`#sidebar-toggle`）で一覧に戻る。タスク・リマインドも同じ。一覧の後ろに backdrop が無い |
| 4 | 「その他」でシートが下タブの上に出る（ホームインジケータに重ならない）。行は有効なものだけ（dev モード無しで会話ログが無い、GitHub 無効で GitHub が無い）。Claude Code の行が無い。Esc・backdrop・行で閉じ、焦点が「その他」に戻る。開いたとき最初の行に焦点 |
| 5 | シートの「状態」「設定」はタブを直接開く。「ナレッジ・記憶」「プロジェクト」「使用量」はその一覧を全幅で出す。その間「その他」が `aria-pressed="true"`、ほかの 3 つは false |
| 6 | 「会話」に未読 + 判断待ちの数のピル、実行中にスピナー。判断待ちが 1 つ増えると数が 1 増え、`aria-label` に「判断待ち」が入る。GitHub に自分宛てがあると「その他」に点、シートの GitHub の行に数 |
| 7 | 鈴と接続の点はタイトルバーのまま。鈴でパネルの知らせが開く |
| 8 | 640〜1023px（iPad・PC の窓を狭めたもの）: 今の横 1 列のまま。≥1024px: 見た目も振る舞いも変わらない（`app.css` の diff が ≤639 のブロックと `.more-sheet` の既定の 1 行だけ。PC の「会話」の数は決定 5 で判断待ちを足す分だけ変わる） |
| 9 | 幅を跨いで変えても（PC の窓を広げる・縮める、iPhone の回転）シートとドロワーが開きっぱなしにならない |
| 10 | hash（`#/ch/<id>`・`#/status`）で開く・戻すは今のまま。タブの保存（localStorage）も同じ |
| 11 | reduced-motion でシートが動かずに出る。シートの transition が `transform`・`visibility` だけ。出 200 / 消 130 |
| 12 | 入力欄に焦点を当ててキーボードが出たとき、下タブとシートが崩れない（iOS Safari。実機でだけ分かる） |
| 13 | ライト・ダーク・OS に合わせる の 3 つでシートの地・線・行の色がトークンどおり |
| 14 | `npm test`・`npm run check` が通る。`web-static.test.ts` の inline 無し・言葉のテストが通る。grep で `100vw`・`transition: all`・`z-index: <数字>` が増えていない |

## 4. 決定事項（オーナー。2026-11-04）

WEB-UI-GUIDELINES.md §11 の 7 つ。オーナーに聞くことは無し。

2026-11-05 の決定（`docs/plan/claude-code-channels.md` §9）: 会話のサイドバーに群「Claude Code」が入り、アクティビティ「Claude Code」は消える（CC9）。スマホの下のバーは別の設計（固定 4 タブ + その他、一覧は全幅）で決めるが、会話の一覧に Claude Code の群が入る前提は変わらない。

## 5. スマホの第 2 回（UX レビュー第 2 回。#248）

> 2026-11-05。iPhone（Safari standalone・375〜390px・指）を前提にしたレビュー（UI-1〜NAV の後の main）。骨組みは指で押せるまで来たが、画面の構造が PC の VS Code のまま（タブの帯・一覧と本文のトグル・パネル・検索のタイトルバー）で、スマホでは「戻る」が無く、上 3 段・下 2 段のバーで本文が 4 割しか残らない。オーナーの判断: ≤639px はタブの帯を隠し、見出しの [‹ 一覧] と下タブで行き来する。構造は「小さく直す」（`phone()` の分岐の延長。スマホ専用の殻・描画の 2 系統は作らない）。PC（≥640px）の見た目と動きは変えない。

### 5.1 指摘（#54〜）

段の「—」は今の段に入れていないもの（次の回で見直す）。

| # | 何が | 直し | 段 |
|---|---|---|---|
| 54 | 実行中の行の「作業中…（経過・ツール n 回）」が `--text-muted` で `tabular-nums` も無い | 実行中の数字を `--text` + `tabular-nums` | UI-9 |
| 55 | 上にタイトルバー + タブの帯 + 2 行の見出し、下に入力欄 + 下タブで、本文が 812px の 4 割 | タブの帯を隠し、見出しを 1 行（h1 + […]） | UI-7 |
| 56 | 見出しに既定の人格でも人格のピルが出る | 人格が 2 体以上のときだけ。≤639px は状態も文字に | UI-9 |
| 57 | 返事の Markdown が記号のまま。長いコードの行が 1 字ずつ砕ける | 最小限の描画（見出し・太字・箇条書き・フェンス） | UI-11 |
| 58 | 入力欄が `rows="2"` のまま伸びない | 最大 6 行まで自動で伸ばす | — |
| 59 | `.msg` のアバターの列で本文が 1 行 19 字 | ≤639px は返事のアバターを隠して 1 列 | UI-9 |
| 60 | 手順のラベル（深いパス）が溢れる | `.steps-list { overflow-wrap: anywhere }` | UI-11 |
| 61 | `overscroll-behavior: contain` が実際のスクロール容器（`.ed-scroll`）に無い | `.ed-scroll` などに付ける | — |
| 62 | ダークの入力欄が地と見分けにくい（線 1.5:1） | ダークだけ `.composer` を `--muted` に | UI-9 |
| 63 | 画面に結果が見える成功のトースト（待ちにした・閉じた・作った）が残る | 消す。残すのは失敗と見えない結果だけ | — |
| 64 | 「戻る」が無い。下タブ「会話」がトグルで、一覧を開いた状態で押すと裏のタブが出る | 見出しの左端に [‹]。「会話」は押すたびに一覧を開く。≡ は隠す | UI-7 |
| 65 | 下タブ「タスク」「リマインド」がサイドバー（同じものの一覧）を開き、表まで 2 段 | ≤639px は表のタブを直接開く | UI-7 |
| 66 | 一覧の題・群の見出しが 12px で、行（14px）より小さい | 題 16・群 14 | UI-9 |
| 67 | 一覧の行の左余白が PC のインデントのまま。Claude Code の行は題名が 80px | 左 16px。Claude Code のバッジは点の色だけ | UI-9 |
| 68 | Claude Code の行の情報（cwd・許可の要約など）が `title` だけでタッチでは出ない | 行の 2 行目に cwdLabel。決まりに「`title` はスマホでは無い」を足す | UI-9（決まりは UI-7） |
| 69 | ナレッジ・会話ログが 一覧 → タブの上下分割 で 3 段 | ≤639px はタブを中身だけにし、[‹] で一覧へ | UI-10 |
| 70 | タイトルバーの右にパネル・テーマが並び、検索の文が「…」になる | パネル・テーマを隠し、名前 + 接続の点 / 今の画面の名前 / 検索のアイコン・鈴 | UI-7 |
| 71 | hash が `replaceState` だけで履歴が無い。Android の戻るでアプリが閉じる | 一覧 → 本文を `pushState`、`popstate` で一覧へ | UI-7 |
| 72 | 「会話」の数のピルがアイコンから離れた隅に出る | アイコンの右上に | — |
| 73 | 「新しいセッション」「Claude Code を起動」が一覧の真ん中 | 一覧の見出しの右に [+] | — |
| 74 | **≤639px で Claude Code のチャンネルの [閉じる] が消え、代わりの口も無い** | 見出しに […]、パレットに「このチャンネルを閉じる」 | fix |
| 75 | 会話のタブと `cc:<id>` のタブの違いが見た目で分からない | `cc:<id>` の見出しに「チャンネル無し」か [Discord のチャンネルを作る] | — |
| 76 | `cc:<id>` のタブが kv 7 行 + 最後の指示 + 画面の写しの縦積み | kv は 3 行、残りと画面の写しは `details` | — |
| 77 | Claude Code の見出しのボタンが 4 つで 2 行に折れる | ≤639px は [画面] だけ残し、他は […] へ | fix |
| 78 | 画面の写しが横スクロール | 既定は末尾 20 行・`pre-wrap` | — |
| 79 | 許可のカードの見出しが 14px で本文と差が無い | 16px。保留中は左 2px の `--warning` | UI-9 |
| 80 | [許可][拒否] が小さく左寄せ | ≤639px は 2 つを全幅で等分 | UI-9 |
| 81 | 要約の `pre` が 160px の入れ子スクロール | ≤639px は `max-height: none` | — |
| 82 | 常に許可のルールの `<code>` が途中で砕ける | 1 行で横スクロール | — |
| 83 | 許可の残り時間が二次色 | `--text` + `tabular-nums`、残り 60 秒で `--warning` | UI-9 |
| 84 | カードの説明「端末や RC のダイアログでも答えられます」が `title` だけ | 常設の 12px か、消す | — |
| 85 | タスクの表が 4 列で期限・知らせが 2〜3 行に折れる | ≤639px は行の積み（題名の下に期限・知らせ） | UI-10 |
| 86 | 状態の切り替え（segmented）が 12px・36px・薄い色 | 14px・`--row`・secondary | UI-9 |
| 87 | 完了のチェックの当たりが 24×44 | `label` を 48px に広げる | UI-10 |
| 88 | タスクの末尾の常設の説明文 | 空のときの文に移す | UI-10 |
| 89 | **リマインドの表が 5 列で、操作の列が画面の外** | ≤639px は行の積み（内容 / 時刻・繰り返し / 操作） | UI-10 |
| 90 | 止めたときのトーストが `oneLine` を通っていない | `oneLine(r.text)` | UI-10 |
| 91 | リマインドの末尾の常設の説明文 | 消すか空のときの文へ | UI-10 |
| 92 | 使用量の人格の表が 5 列 | ≤639px は人格ごとのブロック（キャッシュ率 20px） | UI-10 |
| 93 | ターンの表の行ごとの `details` | 行の積みにして `details` を消す | UI-10 |
| 94 | 使用量の日付の選択がサイドバーと二重 | ≤639px は select だけ | UI-10 |
| 95 | 環境変数の名前（41 字）が砕ける | ≤639px は縦に積み、名前は 12px mono | UI-10 |
| 96 | 設定の「キーボード」の節がスマホでも出る | `hide-sm`。代わりにスマホの操作を 2 行 | UI-10 |
| 97 | ダイアログが画面の中央で、ボタンは右寄せの小さな 2 つ | ≤639px は下からのシート + 2 等分のボタン | UI-8 |
| 98 | 起動のダイアログ（≈560px）がキーボードと重なると上下が切れる | シート化で下に貼り付け、中でスクロール | UI-8 |
| 99 | 確認の見出しに題名（100 字）が入り 5 行になる | 見出しは動詞だけ、対象は本文の 1 行目（80 字まで） | UI-8 |
| 100 | ダイアログの閉じ方が [やめる] と Esc だけ | backdrop を押しても閉じる（danger の確認も「何もしない」側） | UI-8 |
| 101 | ダイアログの出入りが `scale` | シートは `translateY` | UI-8 |
| 102 | 「新しいセッション」の常設の 2 文 | 1 文か削除 | UI-8 |
| 103 | **トーストが入力欄の真上に重なり、失敗のトーストは送るボタンを隠したまま残る** | ≤639px は上に出す | UI-8 |
| 104 | キーボードが出ている間、下のトーストがキーボードの裏 | 上に出せば解決 | UI-8 |
| 105 | [取り消す] 付きのトーストが 2 つまで積む | スマホは 1 つまで | UI-8 |
| 106 | 見出しの […] が PC のコマンドの一覧（サイドバー・パネル・テーマ）を開く | そのチャンネルの操作だけのシート。パレットは移動用で、スマホでは PC の部品のコマンドを出さない | UI-7 |
| 107 | パレットの候補に `<kbd>` | ≤639px は隠す | UI-7 |
| 108 | タイトルバー全幅の検索の箱が常設の最上段で「今どこか」が無い | 検索はアイコン 1 つ、中央は今の画面の名前 | UI-7 |
| 109 | 鈴が半画面のパネルを開く | ≤639px は知らせのタブ。パネルは出さない | UI-7 |
| 110 | 「その他」のシートに題・閉じるが無く、アイコンが 20px | 見出し + ×、アイコン 16px | UI-8 |
| 111 | 下タブの選択の印が上の 2px の線だけ | アイコンと文字を `--accent` | UI-9 |
| 112 | ステータスバーの `default` で、ダークのアプリの上に白い帯（推測） | §4 の判断で決める | UI-12 |
| 113 | `visualViewport`・`interactive-widget` を見ていない。キーボードで画面ごとずれる（推測） | `--vvh` と `.is-keyboard`（下タブを隠す）、viewport に `interactive-widget=resizes-content` | UI-8 |
| 114 | リンク・行の長押しでプレビューが出る | `-webkit-touch-callout: none` | UI-9 |
| 115 | 12px が主な文字（一覧の題・群・segmented など）にも使われている | 補足だけ 12、他は 14 | UI-9 |
| 116 | ライトの `--text-muted` on `--muted` が 4.7:1 で下限 | 主な文字は secondary に | UI-9 |
| 117 | 会話の行が「名前 時刻 / 本文」の同じ形で縦に並び、ログ・コンソールの出力に見える（オーナーの指摘） | 吹き出し（オーナーは右・accent の薄い地、Bot は左・`--bubble-agent`。アバターなし。GUIDELINES §5 会話の行） | 済（#263） |
| 118 | 実行中の行が枠と地のカードに手順が全部並び、コードの UI に見える（オーナーの指摘） | 枠を外し、「作業中…（経過・ツール n 回）」の 1 行 + 直近 3 つの手順を薄い文字で、全部の手順は「すべての手順（n）」を押して開く（既定は閉じる）。終わった返事の手順も枠の無い 1 行（GUIDELINES §5 会話の行） | 済（Q5） |

### 5.2 段の順と中身

**fix → UI-7 → UI-8 → UI-9 → UI-10 → UI-11 → UI-12。** UI-9 以降は独立で並行できる（同じ app.css を触るので merge は順に）。

#### fix: Claude Code のチャンネルの [閉じる]（#74・#77）（済。#249）

`chat.js` の `ccHeader` に `.ed-ops-more`（[…]）を足し、パレットの commands に `kind === "cc"` のとき「このチャンネルを閉じる」（`/cc close`。run は `SA.chat.closeCcChannel`）と、リンクの「RC で開く」「Discord で開く」を足す。≤639px の Claude Code の見出しは [画面] だけ残し、他は […] へ。受け入れ: ≤639px の `.ed-ops` の中に cc でも `.ed-ops-more` がある。

#### UI-7 スマホの殻（#55・#64・#65・#70・#71・#106〜#109。#68 の決まり）（済。#250）

1. `app.css` ≤639: `.tabbar, #panel-toggle, #theme-toggle, #sidebar-toggle, .wb-panel, .wb-sash-panel { display: none }`。`.cmd-center` をアイコン 1 つに（文字は `aria-label`）。`.wb-brand` を出し、右に接続の点（`.wb-brand-status`）。中央に `#title-current`（省略付き）。
2. `workbench.js` `renderTitle()`（≤639 だけ見える。一覧を開いていればアクティビティの名前、それ以外は前に出ているタブの題名）。`renderActivity`・`renderEditors` から呼ぶ。
3. `selectActivity`: スマホで `phoneTab`（`ACTIVITIES` のタスク・リマインド）はタブを直接開いて一覧を閉じ、一覧のあるもの（会話）は押すたびに一覧を開く（トグルしない）。
4. 会話の見出し（`chat.js` の `header`・`ccHeader`）と `views.js` の `toolbar` の先頭に [‹]（`ui.js` の `backButton`。`chevron-left`・`aria-label="一覧へ"`。押すと `SA.app.openDrawer()`）。≥640 では出さない。会話の見出しは ≤639 で 1 行（題名は省略、プロジェクト・リンクは […] へ）。
5. 見出しの […] は `SA.app.sheet(label, items, opener)`（`#more-sheet` の部品を一般化。items は `{ icon, label, run?, href?, why? }`）で、そのチャンネルの操作だけ（待ちにする・閉じる・会話を新しくする・ページを開く・Discord で開く。Claude Code は RC で開く・Discord で開く・閉じる）。パレットは移動用。
6. 鈴: スマホは知らせのタブ（`views.js` の `STATIC.notices`。行は `workbench.js` の `noticeLine` を共用）。
7. 履歴: スマホで一覧を閉じて本文が見えたら、今の entry に `replaceState({ saList: true })` の印を付けてから `history.pushState({ saBody: true })`。`popstate` は印のある entry だけを扱い（スキップリンクなどの hash の移動では一覧を開かない）、`saList` なら一覧を開き、「進む」で `saBody` に来たら積まずに一覧を閉じるだけ。一覧を開く操作（[‹]・下タブ「会話」）は、本文が積んだ履歴の上なら `history.back()` で同じ 1 段に戻す（300ms で開かなければその場で開く保険）。hash は `replaceState(history.state, …)` で印を残す。指の端末では一覧を開いても絞り込みの欄に焦点を当てない（キーボードを出さない）。
8. パレットの commands: スマホでは サイドバー・パネル・タブを閉じる・テーマ を出さない（`pcOnly`）。≤639 `.palette-item kbd { display: none }`。
9. 受け入れ: 375px で上 = タイトルバー 1 段 + 見出し 1 段。一覧 ⇄ 本文が [‹] と「会話」と戻る（端のスワイプ）で往復。タスクを押すと表が直接。鈴で知らせのタブ。PC は変わらない。

#### UI-8 モーダル・シート・トースト・キーボード（#97〜#105・#110・#113）（済。#251。iOS はキーボードで layout viewport を縮めないので、シートのダイアログがキーボードの裏に入らないよう `--kb`（キーボードの高さ）を `margin-bottom` に足した。スマホのトーストは 1 つなので、[取り消す] 付きも 4 秒で消す（会話の見出しには重なるが、覆い続けない）。キーボードの判定（`.is-keyboard`）は幅ごとの最大の見えている高さとの差で見る（Android は `interactive-widget=resizes-content` で innerHeight ごと縮むため）。一覧の絞り込み欄でキーボードが出たときは一覧の下端を `--kb` に。backdrop で閉じるのは押し始めも箱の外のときだけ。#98 は textarea を rows 3、権限モードを「詳しい設定」の `details` に。#102 の文は「Discord にチャンネルができます。」に）

1. `app.css` ≤639 の `dialog` を下からのシート（全幅・上だけ角丸・safe-area の下余白）に。出入りは `translateY(100%)`。`.dialog-actions` を 2 等分。
2. `ui.js` `openDialog`: backdrop の click で閉じる（1 回だけ登録）。`confirm` の `title` は動詞だけ、`body` の先頭に対象（`oneLine` + 80 字）。呼び出し側（chat.js・views.js）も直す。
3. `app.css` ≤639 `.toast-region` を上に（出入りは `translateY(-8px)`）。`ui.js` でスマホは 1 つまで。
4. `workbench.js` `init`: `visualViewport` の `resize`・`scroll` で `--vvh` を書き、キーボードが出ている間は `.wb.is-keyboard`（≤639 で下タブを隠す）。`index.html` の viewport に `interactive-widget=resizes-content`。
5. `#more-sheet` に見出し + ×。`.more-row .icon` 16px。
6. 受け入れ（実機）: 確認・新しいセッション・起動の 3 つが下から出て、キーボードを出しても欄とボタンが見える。トーストが入力欄に重ならない。backdrop で閉じる。`prefers-reduced-motion` で崩れない。
7. 実機で確かめること: iOS でキーボードを閉じた後に `visualViewport.offsetTop` が 0 に戻らないとき、`--vvt`（`.wb` の `top`）で画面がずれずに追従するか。Android（`interactive-widget=resizes-content`）で下タブが隠れ、キーボードを閉じると戻るか。

#### UI-9 視認性（#54・#56・#59・#62・#66〜#68・#79・#80・#83・#86・#111・#114〜#116・ピル）（済。#252。≤639px で主な文字の 12px（群の見出し・一覧の空と案内・chip-sm）を 14 に。パネルのタブ・ステータスバーは ≤639px で出さないので変えていない。Claude Code の行の点は 許可待ち・trust の確認待ちが warning、届け待ちが accent、tmux の外は点なし（タブの中身に出る）。下タブの数・スピナーはアイコンの右上、選んでいる下タブは accent）

1. 実行中の行の数字と許可の残り時間を `--text` + `tabular-nums`。
2. ≤639: 一覧の題 16、群の見出し 14、行の左余白 16、segmented 14 / `--row` / secondary、許可のカードの見出し 16、[許可][拒否] を 2 等分。
3. `.badge` を無地の色付き文字に。人格のバッジは人格が 2 体以上のときだけ。Claude Code の行のバッジは ≤639 で点だけ、2 行目に cwdLabel。
4. ≤639 で返事のアバターを隠す。ダークの `.composer` を `--muted`。`-webkit-touch-callout: none`。
5. GUIDELINES: §3 に ≤639px の一覧の題 16・群 14、§5 バッジを「`.badge` は無地」に。
6. 受け入れ: ダーク・ライトの会話・一覧・許可のカードを 375px で目視。

#### UI-10 表の積み替え（#69・#85・#87〜#96）（済。#253。`table()` の `stack`。タスク・リマインド・使用量の人格とターンの 4 つを ≤639px で `tr { display: grid }` の積みに（各 td は `grid-area`）。ナレッジは `.master` と見出しの検索欄を隠し、会話ログはサイドバーが日付だけなので `.master` を残した。設定の環境変数は縦、「キーボード」の節の代わりに「スマホの操作」の 1 文。常設の `.meta` は空のときの文へ。実機で確かめること: 375px で横スクロールが無いか、キャッシュ率 20px と人格名が 1 行に収まるか）

1. `table()` に `stack: true` を足し、≤639 で行を積みに（タスク・リマインド・使用量のターン）。
2. 使用量の人格の表は ≤639 でブロック（キャッシュ率 20px。GUIDELINES §3 の例外に記す）。
3. ナレッジ・会話ログの `master-detail` は ≤639 で一覧を隠し、[‹] で一覧へ。
4. 末尾の常設の説明文を消す（タスク・リマインド・GitHub・プロジェクト）。
5. 受け入れ: 375px で横スクロールが無く、操作の列が見える。

#### UI-11 返事の Markdown の最小描画（#57・#60）（済。#254。`ui.js` の `parseBlocks`（純関数）と `renderText`。見出し `#`〜`###`・太字・インラインコード・箇条書きと番号（入れ子 1 段）・フェンス（閉じなければ末尾までコード）・リンク。表・引用・画像・HTML・閉じない `**` は文字のまま。`test/web-render-text.test.ts`）

見出し・太字・箇条書き・番号・フェンス（`pre.code-pre` + 横スクロール）・インラインコード・リンク（今の linkify）。それ以外は文字のまま。`innerHTML` を使わない。受け入れ: inline なし・innerHTML なしの grep が通り、4,000 字のフェンス付きの返事が 375px で砕けない。

#### UI-12 標準 PWA の細部（#112）（済。#255。`black-translucent` にし、ライトのときはホーム画面から開いたときだけステータスバーの裏の帯を `--primary` の暗い色に。docs/plan/web-ui.md §11.2）

`index.html` の `apple-mobile-web-app-status-bar-style` を判断に合わせて変える（1 行）。
