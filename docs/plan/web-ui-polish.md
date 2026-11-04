# Web UI の磨き（UI-1〜UI-6）: 今の画面と決まりの差と PR の段

関連 issue: #225（決まりと画面）・#224（PWA）。決まりは `docs/design/WEB-UI-GUIDELINES.md`、PWA の節は `docs/plan/web-ui.md` §11。


> 2026-11-04。main のコードで確かめたもの（行番号つき。推測は「推測」と書く）。v3: 設計レビュー（unslop / impeccable / hallmark / ui-skills の観点）の指摘を取り込み、オーナーの 7 つの決定（WEB-UI-GUIDELINES.md §11）で段を UI-1〜UI-6 に確定した。段の順と理由は §2。

## 1. 差の一覧（段ごと）

### UI-6 性格と色（CSS のトークンだけ）（済）

| # | 事実（今） | 決まり | 直し |
|---|---|---|---|
| 1 | 色が Tailwind の既定そのまま（zinc + blue-500 / red-500 / green-500 / amber-500。base.css:3 のコメント、app.css:44-78） | §1 性格 A・§2.1 | app.css の `:root[data-theme]` 2 ブロックを §2.1 の値に差し替え。`:root:not([data-theme])` + `prefers-color-scheme` の 2 ブロックを足す |
| 2 | **ライトの `--text-muted #71717a` on `--muted #f4f4f5` = 4.4:1**（kbd 127-138・`.sb-count` 520-530・選択中の行の `.sb-meta` 575-597・segmented の非選択） | §2.2（薄い on muted ≥ 4.5） | #1 で解消（新しい値は 4.7） |
| 3 | 文字の役割が `--text` / `--text-muted` の 2 つ。時刻・ラベル・ヒント・補足が同じ灰色 12px（app.css:116-119・592-597・937-942・1106-1112） | §2.3 3 役 | `--text-secondary` を足し、`.meta`・`.sb-meta`・`.tl-time`・`th`・`.card-head .meta` を secondary、`.composer-hint`・placeholder・`.sb-empty`・無効を muted に |
| 4 | `::selection`・`caret-color` 未指定（grep 0 件） | §2.3 ブラウザの面 | `::selection`・`caret-color` を app.css に |

### UI-1 スマホの基礎（CSS + meta + JS 数行）（済）

| # | 事実（今） | 決まり | 直し |
|---|---|---|---|
| 5 | `index.html` に `theme-color`・`manifest`・`apple-*` の meta が無い（1〜16 行） | §4・PWA §2 | theme-color 2 行（manifest・apple は UI-3） |
| 6 | `app.css` に `env(safe-area-inset-*)` が 1 つも無い。下タブ（1865〜）・タイトルバー・ドロワー・トーストが notch / ホームインジケータを考えていない | §4 | §3 の分解 |
| 7 | `:hover` が `@media (hover: hover)` だけ（app.css 350・402・564・771・1159・1641・1851、base.css 288） | §4 | `and (pointer: fine)`。base.css の分は app.css で打ち消す |
| 8 | `touch-action: manipulation`・`overscroll-behavior` が無い（635 の `none` はつまみ） | §4 | §3 の分解 |
| 9 | 会話の本文 `.msg-text`（944〜）が `.wb` の 14px（102 行）を継ぐ。指の端末でも 14 | §3 | `pointer: coarse` で 16 |
| 10 | 押せるもの（タブ・行・アクティビティ）に `user-select: none` が無い（501 行だけ） | §4 | §3 の分解 |
| 11 | ダイアログの入力・送る欄に `enterkeyhint` が無い（index.html 76・104・108、chat.js の composer） | §5 入力欄 | `enterkeyhint` |
| 12 | 28px 未満の当たりがありうる（`.tab-close`。推測: 実寸は要確認） | §4 | `pointer: coarse` で `::before { inset: -8px }` |
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
| 21 | `static.ts` の名前の形が `html|css|js|svg` だけ（21 行）。favicon・manifest・apple の meta・アイコンが無い | PWA §1・§2・§5 | PWA.md のとおり。アイコンは `scripts/make-icons.ts`（決定 a） |

### UI-4 言葉（文字列だけ）

| # | 事実（今） | 決まり | 直し |
|---|---|---|---|
| 22 | 実装名が画面に出る: `task_add・task_update`（views.js:346）、`project_open`（sidebar.js:295）、`kb_delete`（views.js:1096）、`claude agents --json`（sidebar.js:266）、`SELF_AGENT_CC`（views.js:528）、`settings.json`（index.html:113）、権限モードの識別子だけ（index.html:112-118）、失敗の fallback `"<status>: <error>"`（views.js:685） | §7 実装名を出さない（決定） | 言い換え。権限モードは「acceptEdits（編集は確認なし）」の形。fallback は「操作に失敗しました。もう一度試してください」 |
| 23 | 空の表示が「〜はありません」で止まり、次の行動が無い（views.js 342・397・431・642 など）。失敗に [読み直す] が無い（views.js 128・219・1083） | §7 空・§5 空の表示 | 次の行動の文 + 失敗は [読み直す] |
| 24 | placeholder が操作の説明（chat.js:446「Enter で送信…」、index.html:55「名前で探す。> か / でコマンド」）。入力欄の下の常設の 1 文（chat.js:495、views.js:836）。見出しの「n 秒ごとに更新」（views.js:998・1166）。起動ダイアログの 120 字の段落（index.html:121）。一覧の末尾の `.meta` 段落（views.js 346・401・430・558・638・645） | §5 入力欄・§7 常設の説明文 | placeholder は「<題名> に送る」「探す」。説明は `title`・設定のキー一覧へ。段落は 2 文まで |
| 25 | 「新しいセッション」が会話と Claude Code で同じ文言（sidebar.js:93・260）。「取り消す」が undo（トースト）と cancel（送信待ち views.js:755）の両方。「閉じる」がタブ・セッション・トーストで 3 つの意味 | §7 語彙の表 | Claude Code 側は「Claude Code を起動」、送信待ちは「やめる」。タブとトーストの「閉じる」はアイコンだけ（`aria-label` は残す） |
| 26 | 成功の文に括弧の補足（workbench.js:717「（Discord にもチャンネルができました）」）。`confirm` の既定「OK」（ui.js:202） | §7 | 1 文に。既定は「実行する」 |
| 27 | パレットの label が「/new 新しいセッション」で detail と二重（workbench.js:548-561） | §5 パレット | label は動詞句、`/new` は右の kbd 風 |
| 28 | 補足を「・」で 3〜4 要素つなぐ（views.js:514・1095・461-465） | §7 2 要素まで | 改行か別の `span` |

### UI-5 部品の整理（CSS + JS）

| # | 事実（今） | 決まり | 直し |
|---|---|---|---|
| 29 | 使用量の人格ごとの `.card.card-sm` の並び + `dd` 16px × 3 の hero-metric（views.js:131-146、app.css:1204〜） | §5 使用量の数字 | 人格ごとの行の表。キャッシュ率だけ大きく |
| 30 | base.css の `.card` に `--shadow-sm` | §2.3 影 | app.css で `.card { box-shadow: none }` |
| 31 | 読み込み中に `.empty`（破線枠 + 48px 余白）を流用（views.js:40-42 の 10 箇所）。読めた瞬間に跳ぶ | §5 読み込み中 | `.loading` を足し、`empty(null, "読み込んでいます…")` を置き換え |
| 32 | 会話の見出しの操作が 6 個で、後ろ 3 つが同じ `.btn-secondary`（chat.js:410-437） | §5 ボタン（secondary 2 つまで） | [閉じる] だけ secondary、他は ghost。≤639px は `…` にまとめパレットのコマンドへ |
| 33 | 許可のカード: 3 ボタン、ルール込みで折り返すボタン（app.css:1366-1372）、許可が primary（views.js:926-941）。`.card` の中の `.code-pre` が同じ枠・角丸（views.js:905、app.css:1316-1327）。`h3` が h1 直下（views.js:900） | §5 許可のカード・§4 角丸・§8 見出し | [許可]（secondary）[拒否]（ghost）+ `label.check`「このセッションでは常に許可」+ `<code>` のルール。`.card .code-pre { border: 0; border-radius: var(--radius-sm); background: var(--bg) }`。`h2` |
| 34 | `confirm` が danger でも `ok.focus()`（ui.js:223） | §5 ダイアログ | `opts.danger ? cancel.focus() : ok.focus()` |
| 35 | ダイアログの入力に `aria-describedby` / `aria-invalid` / `required` が無い（workbench.js:704-708・793-803、index.html:76・104）。`p.alert` が hidden から出ると跳ぶ（index.html:86・120） | §5 入力欄・§8 | 属性 3 つ。`.alert` の場所に `min-height: 1lh` |
| 36 | 見出しの段が飛ぶ（h1 → h3。views.js:138・900、chat.js:265）。閉じる前の確認の「要約」「候補」が `p.meta`（chat.js:265-268） | §8 見出し | `h2`・`dl` |
| 37 | Claude Code の行のバッジが最大 7 個（sidebar.js:208-220） | §5 バッジ（行は 1 つ） | 最重要 1 つ（許可待ち > 送信待ち > trust > tmux の外）。残りは `title` とタブ |
| 38 | 群の見出しの数のピル `.sb-count`（sidebar.js:58、app.css:520-530） | §5 バッジ（ピルは未読だけ） | 文字に |
| 39 | タスクの表: id 先頭・`—` 2 列・行ごとに secondary の [完了]（views.js:322-343）。リマインド: 行ごとに [次を飛ばす][止める]（views.js:363-386） | §5 表・一覧の行（行の操作は 1 つ） | 先頭を `label.check`（チェック = 完了）、id は題名の下。リマインドの行は [次を飛ばす] だけ、[止める] は右端に離すか `…` |
| 40 | `.cc-screen` が 12px の `pre`（app.css:1392-1397） | §3 端末の写し | 14px（coarse 13）・行間 1.35・地 `--bg`・`tab-size: 4` |
| 41 | z-index が 44 / 45 / 50 / 60 の生の数（app.css:1652・1798・1860・1886） | §4 `--z-*` | 変数の表 |
| 42 | パレットの候補に一律 `chevron-right`（workbench.js:609）。アイコン無しの行（セッション）で label の開始位置が違う（sidebar.js:78、app.css:550） | §4 揃える・§5 パレット | 空の 16px の箱 |
| 43 | `.steps > summary` に chevron + 終わり方のアイコン + 文（chat.js:323-328） | §5 1 要素 1 アイコン | 終わり方のアイコンを消し、色は文に |
| 44 | リマインドの種類がサイドバーはアイコン、タブは文（views.js:389-390、sidebar.js:147） | §7 同じものに同じ表現 | タブにも同じアイコン |
| 45 | `:disabled` が `opacity: 0.5; pointer-events: none` だけ（base.css:300〜）。理由（`title`）が無い | §5 ボタン | app.css で `cursor: not-allowed`（`pointer-events` を戻す）+ 無効の理由 |
| 46 | 確認のカードのチェックボックスに `accent-color` が無い（推測） | §5 チェック | `accent-color: var(--accent)` |
| 47 | スキップリンクが無い | §8 | 1 つ足す |

問題なし（記録だけ）: 絵文字・大文字ラベル・グラデーション・`→`・`transition: all`・`will-change`・感嘆符は 0 件。「…」・tabular-nums・`aria-label`・`aria-pressed`・`aria-current`・`role="combobox"`・`Intl`・`scrollbar-color`・`minmax(0, 1fr)`・`dvh` は使っている。`.dot` は生きた状態を表すので可。オーナーの吹き出しと人格の裸の文の非対称は性格なので変えない。`<select>` の色は base.css で明示済み。

## 2. 段の順と理由

**UI-6 → UI-1 → UI-2 → UI-3 → UI-4 → UI-5。**

- **UI-6 を最初に**: app.css の `:root` だけの CSS で、振る舞いを変えない。後の段が書く色の値（UI-1 の theme-color、UI-2 の `::selection`、UI-3 の manifest の `theme_color` / `background_color`・アイコンの地）が全部これに依存する。先にやると値を 1 回書くだけで済み、後にやると UI-1・UI-3 を書き直すことになる。ライトのコントラスト（#2）もここで解消する。提案されていた「UI-3 の後」にしない理由はこれ。
- **UI-1 → UI-2**: どちらも CSS 中心で独立だが、同じ app.css を触るので merge は順に。UI-1 が iPhone で使えるようにする最小で、0.1.0 に要る。
- **UI-3**: UI-1（safe-area・theme-color の JS）の後。アイコンの題材は決定済みなのですぐ始められる。
- **UI-4**: 文字列だけ。いつでもよいが、UI-5 が部品を組み替えるときに文字列も動くので、先に語彙を固めておくと UI-5 の diff が小さい。
- **UI-5**: いちばん大きく、JS の組み替え（表・許可のカード・サイドバー）を含む。最後。

0.1.0 の公開に入れるなら UI-6 → UI-1 → UI-2 → UI-3 まで。`base.css`・`templates/web/DESIGN.md` は**どの段でも変えない**（base.css の hover・`:disabled`・`.card` の影は app.css で打ち消す）。

## 3. implementer に渡す分解

### UI-6 性格と色（#1〜#4）（済）
触る: `app.css` だけ。
1. `:root[data-theme="dark"]`・`:root[data-theme="light"]` の値を GUIDELINES §2.1 の表に差し替える（`--backdrop`・`--shadow-sm` を含む）。
2. 同じ 2 組の値で `:root:not([data-theme])`（ライト）と `@media (prefers-color-scheme: dark) { :root:not([data-theme]) }`（ダーク）を足す（「OS に合わせる」で base.css の zinc に落ちないため）。
3. `--text-secondary` を 4 ブロック全部に足す。
4. 役割の振り直し: `.meta`・`.sb-meta`・`.tl-time`・`.table th`・`.card-head .meta`・`.metrics dt`・`.counter`・`.out-time`・`.panel-note` → `var(--text-secondary)`。`.composer-hint`・`.sb-empty`・`.empty`・`::placeholder`（base.css が `--text-muted` なので変更なし）・`.btn:disabled` → `var(--text-muted)` のまま。アイコンの色（`.sb-row .icon`・`.ed-title > .icon`・`.act-btn`）は `--text-secondary`。
5. `::selection { background: var(--accent); color: var(--primary-text) }`、`input, textarea { caret-color: var(--accent) }`。
6. 受け入れ: app.css の `#` の色がトークンの定義の中にだけある（grep）。GUIDELINES §2.2 の表の値を再計算して一致する（スクリプトは scratchpad でよい）。ダーク・ライト・OS に合わせる の 3 つで状態・使用量・会話のタブを目視。

### UI-1 スマホの基礎（#5〜#15）（済。#15 の使用量の表は UI-5 に回した）
触る: `index.html`、`app.css`、`workbench.js`（theme-color の 5 行 + タイトルバー右の点と鈴）、`chat.js`（`enterkeyhint`）、`sidebar.js`（下タブの実行中）。
1. `index.html`: `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">` と dark `#11141c` を `color-scheme` の次に。`#new-title`・`#cc-start-title` に `enterkeyhint="done"`、`#palette-input` に `enterkeyhint="search"`。
2. `app.css`: `html, body { overscroll-behavior: none }`。`.tl`・`.wb-sidebar`・`.wb-panel`・`.palette-list`・`.master` に `overscroll-behavior: contain`。`.act-btn`・`.tab`・`.sb-row`・`.panel-tab`・`.sbar-item`・`.btn` に `touch-action: manipulation; user-select: none; -webkit-user-select: none`。
3. `app.css` の 1023 以下: `.wb` の最後の行を `calc(var(--bottomnav-h) + env(safe-area-inset-bottom, 0px))`、`.wb-activity` に `padding-bottom: env(safe-area-inset-bottom, 0px)`、`.wb-titlebar` に `padding-top: env(safe-area-inset-top, 0px)` と行の高さの加算、`.toast-stack`・`.wb-sidebar` の `bottom` に同じ加算。
4. `app.css`: 7 箇所の `@media (hover: hover)` を `and (pointer: fine)` に。base.css の `.btn-*:hover` は `@media (hover: hover) and (pointer: coarse) { .btn-primary:hover, .btn-secondary:hover, .btn-danger:hover { opacity: 1 } .btn-ghost:hover { background: transparent } }` で打ち消す。
5. `app.css`: `@media (pointer: coarse) { .msg-text, .kb-body（ナレッジの本文のクラス）, .composer-input { font-size: var(--font-base) } }`。
6. `app.css`: `@media (pointer: coarse) { .tab-close { position: relative } .tab-close::before { content: ""; position: absolute; inset: -8px } }`。
7. `app.css`: `.toast > span, .notice-item > span:not(.out-time) { min-width: 0; overflow-wrap: anywhere }`。
8. `workbench.js` の `applyTheme`: `meta[name="theme-color"]` 2 つの `content` を `dark` なら `#11141c`、`light` なら `#ffffff`、`system` なら media ごとの元の値に。
9. `workbench.js`: `.wb-title-actions` の先頭に、接続の `.dot`（既定の人格の Bot。押すと状態のタブ）と鈴（押すとパネルの知らせ。`recent24h` の数）を足し、`app.css` で ≥640px は `display: none`。`sidebar.js`: 実行中が 1 以上なら下タブ「会話」の `.act-count` の位置に `.spinner-sm`。
10. `chat.js`: composer の `textarea` に `enterkeyhint`（タッチが主なら `"enter"`、それ以外 `"send"`）。
11. 使用量の表（#15）: ≤639px で `hide-sm` を 4 列に付け、残りを行末の `details` に（表の組み替えを UI-5 でやるなら、ここは `hide-sm` だけでよい）。
12. 受け入れ: iPhone 実機で、下タブがインジケータに隠れない・ステータスバーの色が合う（3 テーマ）・会話の本文 16px・入力で拡大しない・タップの点滅と hover の残りが無い・タブの × が押せる・タイトルバーに接続の点と鈴が出る・実行中に下タブにスピナー。PC は見た目が変わらない。`npm test`・inline なしの grep。

### UI-2 押した感と動き（#16〜#20）（済）
触る: `app.css`、`ui.js`、`index.html`（失敗のトーストの容れ物）、`views.js`（許可の残り時間・失敗のトーストの呼び出し）、`chat.js`（要約のトーストを消す）。
1. `app.css` の `:root` に `--dur-micro: 120ms; --dur-short: 200ms; --dur-long: 300ms; --ease-out: cubic-bezier(0.23, 1, 0.32, 1)`。
2. `.btn:active, .act-btn:active, .tab:active, .sbar-item:active, .welcome-link:active { transform: scale(0.97) }`（`transition: transform var(--dur-micro) var(--ease-out)`）。`.sb-row:active { background: var(--muted) }`。
3. ドロワー: 開く `transform var(--dur-long) var(--ease-out)`、`.wb:not(.is-drawer-open) .wb-sidebar` は 200ms。`dialog[open]` と `.toast` に `@starting-style`（opacity 0・scale(0.98) / translateY(8px)）、閉じる側は `transition` を 130ms。パレットには付けない。
4. `index.html`: `<div class="toast-stack toast-stack-alert" id="toast-alert" role="alert" hidden>` を `#toast` の次に。`ui.js` の `toast(text, action, opts)` に `opts.level === "error"` で `#toast-alert` に入れ、`action` が無くても `opts.retry` があれば [もう一度] を付け、自動で消さない。`.toast-alert` は左 2px の `--danger`。
5. `ui.js`: `mouseenter` / `focusin` で `clearTimeout`、`mouseleave` / `focusout` で残りを再開（残り時間は `TOAST_MS` でよい）。
6. `views.js`: 失敗の `toast(...)` 呼び出し（`act` の失敗・読み直しの失敗）を `level: "error"` に。許可のカードの「残り m 分 s 秒」を `setInterval` 1 秒で文字だけ更新（`data-permission-left` の `textContent`。カードが消えたら `clearInterval`）。
7. `chat.js`: 187・209 の「要約しています…」のトーストを消す（spinner の行が既にある）。
8. 受け入れ: 全部の押せるものが押下で縮む。ドロワー 300 / 200。ダイアログ・トーストが出入りし、閉じる方が速い。パレットは動かない。失敗のトーストが `#toast-alert` に出て消えず [もう一度] が効く。許可の残り時間が 1 秒ずつ減る。reduced-motion で崩れない。

### UI-3 PWA（#21）（済。favicon の名前は icons.svg と紛れないよう `app-icon.svg` にした）
触る: `src/web/static.ts`、`index.html`、`src/web/static/`（manifest・SVG・PNG）、`scripts/make-icons.ts`、`package.json`（`make-icons`）、`test/`。
1. `static.ts`: `STATIC_NAME` に `png|webmanifest`、`CONTENT_TYPES` に `png: "image/png"`・`webmanifest: "application/manifest+json; charset=utf-8"`。
2. `scripts/make-icons.ts`: 図形の定義（角丸の正方形の地 `#11141c`、2 本の横線 `#eef0f5`、右下の点 `#6b9aff`）から `app-icon.svg`・`apple-touch-icon.png`（180）・`icon-192.png`・`icon-512.png`・`icon-512-maskable.png`（印は中央 80% の円の中）を `node:zlib` だけで書く（PWA §5）。
3. `manifest.webmanifest`（PWA §1。`background_color` `#0b0d14`・`theme_color` `#11141c`）。
4. `index.html`: `rel="manifest"`・`rel="icon"`（SVG）・`apple-touch-icon`・`apple-mobile-web-app-capable`・`apple-mobile-web-app-status-bar-style`・`apple-mobile-web-app-title`。
5. テスト: `/static/manifest.webmanifest`・`/static/icon-192.png` が認証なしで 200 と正しい Content-Type。`/static/x.json`・`/static/a/b.png`・`/static/.png` は 404。index.html の grep（manifest・theme-color 2 つ・apple-touch-icon・inline なし）。PNG の先頭 8 バイトと IHDR の幅・高さ。maskable の中央 80% の外側が地の色だけ。`make-icons` の出力が commit と一致。
6. 受け入れ: PWA §6。

### UI-4 言葉（#22〜#28）
触る: `views.js`・`sidebar.js`・`chat.js`・`workbench.js`・`ui.js`・`index.html` の文字列だけ。テストで文字列を見るものがあれば合わせる。
1. 実装名の言い換え（#22）: 「Bot が task_add・task_update を使います」→「会話で頼むと増えます・変わります」。`project_open` → 「会話でページを作ると増えます」。`kb_delete` → 「削除は Discord の確認から」。`claude agents --json` → 「一覧を読めませんでした」。`SELF_AGENT_CC` → 「Claude Code の連携が無効です（設定で有効にできます）」。`settings.json に従う` → 「既定（この機械の設定に従う）」。権限モードの選択肢に説明を添える。失敗の fallback は「操作に失敗しました。もう一度試してください」。
2. 空の表示（#23）: 各 `empty(...)` に次の行動の文。失敗の `empty` には [読み直す]（`btn-ghost btn-sm`。押すと同じ読み直し）。
3. placeholder と説明（#24）: composer は `"<題名> に送る"`（入口は「#inbox に送る」）、パレットは「探す」。`composer-hint`・views.js:836 の 1 文・「n 秒ごとに更新」は消して `title` に。起動ダイアログの段落は「この機械の tmux に新しいセッションを作り、claude を起動します。題名は 40 字までです。」。一覧の末尾の `.meta` は 1 文に。
4. 語彙（#25・#26・#27）: sidebar.js:260 を「Claude Code を起動」、views.js:755 を「やめる」、workbench.js:717 の括弧を削除、ui.js:202 の既定を「実行する」、パレットの label を動詞句（「新しいセッションを作る」「閉じる」…）にして `/new` は右の kbd 風の `span`（検索は label + detail + keys）。
5. 「・」（#28）: 3 要素以上の meta を改行か 2 つ目の `span.meta` に。
6. 受け入れ: grep で `_add`・`_update`・`_open`・`_delete`・`--json`・`SELF_AGENT_`・`settings.json`・「送信」・「キャンセル」・「クローズ」・「OK」が画面の文字列に 0 件（設定の環境変数の表を除く）。語彙の表の語だけが使われている。

### UI-5 部品の整理（#29〜#47）
触る: `views.js`・`sidebar.js`・`chat.js`・`ui.js`・`workbench.js`・`app.css`・`index.html`。論点ごとに commit を分ける（1 PR 1 論点が重ければ UI-5a 表と一覧 / UI-5b 許可のカードとダイアログ / UI-5c 細部 の 3 PR に割ってよい）。
1. 使用量（#29）: `.metric-grid` のカードを `table`（人格 / ターン / 失敗 / 入力 / 出力 / キャッシュ率）に。キャッシュ率のセルだけ `--font-base`・500。`app.css` の `.metric-grid`・`.card-sm`・`.metrics` を消す。
2. 読み込み中（#31）: `app.css` に `.loading { min-height: var(--space-8); color: var(--text-muted); font-size: var(--font-sm); padding: var(--space-3) 0 }`。views.js の `empty(null, "読み込んでいます…")` を `loading()`（`aria-busy="true"`）に。
3. 会話の見出し（#32）: [閉じる] secondary、[待ちにする][会話を新しくする] ghost。≤639px は `…`（`aria-label="ほかの操作"`）で、押すとパレットをそのチャンネルのコマンドで開く。
4. 許可のカード（#33）: `h2`。ボタンは [許可]（secondary）[拒否]（ghost）。`label.check` + `input[type=checkbox]`「このセッションでは常に許可」+ 次の行に `<code>` のルール。チェックで [許可] の送り先が `always`。末尾の段落は `title`。`.card .code-pre` の枠を外し `--radius-sm`・地 `--bg`。
5. ダイアログ（#34・#35）: `opts.danger ? cancel.focus() : ok.focus()`。`#new-title`・`#cc-start-title` に `required aria-required="true" aria-describedby="new-error"`、エラー時に `aria-invalid="true"`（消すとき外す）。`.alert` の場所に `min-height: 1lh` の容れ物。
6. 見出し（#36）: h1 直下の `h3` を `h2` に。閉じる前の確認の「要約 / 候補」を `dl`。
7. サイドバー（#37・#38・#42）: Claude Code の行のバッジを 1 つに（優先順は表のとおり。残りは `title`）。`.sb-count` を `.sb-note` の文字に。アイコン無しの行に空の `span.icon`。パレットの一律 chevron を空の箱に。
8. 表と行（#39・#44）: タスクの先頭列を `label.check`（チェック = complete。トーストの [取り消す] はそのまま）、id は題名の下の `span.meta`、`—` を空に。リマインドの行は [次を飛ばす] だけ、[止める] は `…` のメニュー（`popover`）か右端に `gap: var(--space-4)` で離す。タブの種類の列に同じアイコン。
9. 細部（#30・#40・#41・#43・#45・#46・#47）: `.card { box-shadow: none }`。`.cc-screen { font-size: var(--font-sm); line-height: 1.35; background: var(--bg); tab-size: 4 }` + coarse で 13px。`:root` に `--z-sash: 10; --z-drawer-backdrop: 40; --z-drawer: 41; --z-palette: 50; --z-toast: 60` と置き換え。`.steps > summary` の終わり方のアイコンを消し色は文に。`.btn:disabled { pointer-events: auto; cursor: not-allowed }` + 無効の理由の `title`。`.check input { accent-color: var(--accent) }`。`<a class="skip-link" href="#editors">本文へ</a>` を `body` の先頭に（フォーカス時だけ表示）。
10. 受け入れ: 人格 3 体のダミーで使用量が表。読み込み中に枠が出ず跳ばない。会話の見出しの secondary が 1 つ。許可のカードが 2 ボタン + チェック。危険な確認で Enter を押しても実行されない。`h1` の次が `h2`（grep `el("h3"` の親を目視）。z-index の直書き 0 件。Tab の 1 回目でスキップリンク。

## 4. 決定事項（オーナー。2026-11-04）

WEB-UI-GUIDELINES.md §11 の 7 つ。オーナーに聞くことは無し。
