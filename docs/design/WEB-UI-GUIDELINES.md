# Web UI の見た目と振る舞いの決まり

> 対象: `src/web/static/`（VS Code 風の SPA）。`templates/web/`（LLM が作るページの土台）は対象外で、その決まりは `templates/web/DESIGN.md`。
> 根拠: Anthropic frontend-design、Vercel Web Interface Guidelines、Emil Kowalski の design-eng / mobile-native、heydamir/unslop、pbakaus/impeccable、ibelick/ui-skills、Nutlope/hallmark の各 skill を、この UI（tailnet の中・1 人用・日本語・iPhone と PC）に合う形に絞ったもの。出典は項目の末尾に `[unslop]` `[impeccable]` `[ui-skills]` `[hallmark]` `[emil]` `[vercel]` `[anthropic]` の印で書く。印の無いものは既存の決まり（DESIGN.md・web-ui.md）か、この文書で決めたもの。
> 「事実」= 2026-11-04 の main のコードで確かめたこと。「決まり」= これから守ること。決定は §11。

## 0. 何のために

- オーナーが 1 日に何十回も開く道具。見た目で驚かせない。**押した瞬間に応える・読みやすい・迷わない**が目的。
- 「AI が作った画面」の既定の見た目（紫のグラデーション、同じカードの連打、過剰な角丸と影、絵文字）を避ける。
- PC（キーボード中心）と iPhone（指）の両方で、同じ構造・同じ言葉で使える。

## 1. 方針と性格

決定（オーナー）: **方針 A（VS Code 風の密度を保つ）、性格 A「夜勤の計器盤」。**

| | A: VS Code 風の密度を保つ（採用） | B: スマホ優先に寄せる |
|---|---|---|
| PC での一覧の密度 | ◎ 28px 行。多くの項目を一望できる | △ 行が太り、スクロールが増える |
| iPhone での操作 | ○ `pointer: coarse` で 44px・下タブ・ドロワー | ◎ 最初から指のための構成 |
| 実装コスト | ◎ 今の app.css に直しを足すだけ | ✗ 骨組みの作り直し |
| 「AI っぽさ」の回避 | ○ 道具の見た目は定番だが、それ自体は tell でない | △ カード積みのスマホ UI になりやすい |

性格 A「夜勤の計器盤」（unslop の Direction の 5 行）:
- **製品**: 自分の Discord Bot の計器盤と会話の窓。tailnet の中で 1 人が、iPhone と PC から使う。
- **性格**: 正確・静か・生きている。
- **世界**: 監視室の夜、計器の光。中立の灰色は ink（わずかに青に寄せた黒〜白）。
- **見せ場**: (1) 実行中のターンの行（経過時間とツール回数が刻む。唯一「動いている」場所）。(2) 使用量の数字（キャッシュ率を 1 つだけ大きく）。
- **署名の仕草**: **「生きている点」と 1 秒の刻み**。接続・実行中・未読を `.dot` と tabular の数字で表し、動いているものは 1 秒ごとに進む（§6.1）。これ以外に飾りを足さない。 [unslop]

決まり:
- 道具（Operate）の画面では**見慣れていることが価値**。構造・ナビ・部品は標準のもの（タブ・サイドバー・パレット・`<dialog>`）を使い、個性は型・色・密度・署名の仕草でだけ出す。レイアウトや部品を「らしさ」のために作り変えない [impeccable]
- 枠（バー・ボタン・線）は静かに。色と手の込みは見せ場の 2 か所に置く [unslop]
- 「製品名を別の道具に差し替えても成り立つか」を問うのは、構造でなく**言葉・色・署名の仕草**について。構造が標準なのは正しい [impeccable][hallmark]
- 「きれい・モダン・ミニマル」は方針の言葉として使わない（どの画面にも当てはまる） [unslop]
- 画像・イラスト・生成した絵は使わない（計器盤に要らない） [unslop]

## 2. 色

決定（オーナー）: ink 寄りの中立 + 自前のコバルト。Tailwind の既定色から離れる。文字の役割は **本文・二次・薄い** の 3 つ。

### 2.1 トークン（app.css の `:root[data-theme="dark"]` / `:root[data-theme="light"]` と、「OS に合わせる」の `:root:not([data-theme])` / `@media (prefers-color-scheme: dark)` の 4 ブロックで上書きする。base.css は触らない）

| トークン | 役割 | ダーク | ライト | base.css の対応 |
|---|---|---|---|---|
| `--bg` | 画面の地 | `#0b0d14` | `#f5f7fa` | 同名を上書き |
| `--surface` | バー・入力欄・カード・ダイアログ | `#11141c` | `#ffffff` | 同名を上書き |
| `--muted` | 選択中の行・控えめな面・kbd | `#1a1e28` | `#eceff4` | 同名を上書き |
| `--border` | 線（飾りの線。1px） | `#2a3040` | `#d7dce6` | 同名を上書き |
| `--text` | 本文 | `#eef0f5` | `#111827` | 同名を上書き |
| `--text-secondary` | 二次（時刻・ラベル・表の見出し・補足） | `#aab1c1` | `#4b5565` | **app.css だけ**（base.css に無い。新しい変数） |
| `--text-muted` | 薄い（placeholder・ヒント・空の表示・無効） | `#8a93a6` | `#5f6b80` | 同名を上書き |
| `--primary` / `--primary-text` | 主な操作のボタンとその上の文字 | `#eef0f5` / `#11141c` | `#111827` / `#f5f7fa` | 同名を上書き |
| `--accent` | 選択中・フォーカス・リンク・未読・生きている点 | `#6b9aff` | `#2a5bd7` | 同名を上書き |
| `--danger` | 失敗・期限切れ・削除 | `#f0616a` | `#c92a2a` | 同名を上書き |
| `--success` | 接続・完了・進行中のセッション | `#4cc38a` | `#1b7a3e` | 同名を上書き |
| `--warning` | 注意・待ち | `#f2b544` | `#a05a07` | 同名を上書き |
| `--backdrop` / `--shadow-sm` | ダイアログの後ろ / 浮いているものの影 | `rgb(0 0 0 / 0.7)` / `0 1px 2px 0 rgb(0 0 0 / 0.4)` | `rgb(17 24 39 / 0.5)` / `0 1px 2px 0 rgb(17 24 39 / 0.06)` | 同名を上書き |

- 「OS に合わせる」で `data-theme` を外すと base.css の既定（Tailwind の zinc）に落ちる（事実: app.css の仕組み）。これを避けるため、app.css に `:root:not([data-theme])` + `@media (prefers-color-scheme: dark)` の 2 ブロックも書き、どの状態でもこの表の値になるようにする。
- `--text-secondary` は base.css に無いので、base.css の部品（`.meta` の `small` など）には効かない。app.css 側で役割を振る（§3）。

### 2.2 コントラスト（WCAG の比。計算値。文字は 4.5:1 以上、アイコン・輪は 3:1 以上）

ダーク:

| 文字 ＼ 地 | `--bg` | `--surface` | `--muted` |
|---|---|---|---|
| `--text` | 17.0 | 16.2 | 14.6 |
| `--text-secondary` | 9.0 | 8.6 | 7.8 |
| `--text-muted` | 6.3 | 6.0 | 5.4 |
| `--accent` | 7.1 | 6.7 | 6.1 |
| `--danger` | 6.1 | 5.8 | 5.3 |
| `--success` | 8.8 | 8.3 | 7.5 |
| `--warning` | 10.6 | 10.1 | 9.1 |

ライト:

| 文字 ＼ 地 | `--bg` | `--surface` | `--muted` |
|---|---|---|---|
| `--text` | 16.5 | 17.7 | 15.4 |
| `--text-secondary` | 7.0 | 7.5 | 6.5 |
| `--text-muted` | 5.0 | 5.4 | **4.7** |
| `--accent` | 5.5 | 5.9 | 5.1 |
| `--danger` | 5.1 | 5.5 | 4.7 |
| `--success` | 5.0 | 5.4 | 4.7 |
| `--warning` | 4.9 | 5.3 | 4.6 |

- `--primary-text` on `--primary` 16.2 / 16.5、on `--accent` 6.7 / 5.5、on `--danger` 5.8 / 5.1（ボタンの文字）。
- `--border` は飾りの線（1.2〜1.5）で、入力欄の枠にも使う。枠だけで欄を識別させない（ラベルと地の色の差で分かる）。フォーカスの輪（`--accent`）は地に対して 5.1 以上（3:1 を満たす） [hallmark]
- ライトの `--muted` はこれより暗くしない（`--warning` on `--muted` の 4.6 が 4.5 を割る）。
- 値を変えるときは同じ表を計算し直して載せる。「薄い on muted」が 4.5 を割らないことが基準（事実: 旧の `#71717a` on `#f4f4f5` は 4.4 で割っていた）。

### 2.3 決まり

- 文字の役割は 3 つだけ。本文 = `--text`、二次 = `--text-secondary`（時刻・ラベル・表の見出し・一覧の補足・`.meta`）、薄い = `--text-muted`（placeholder・入力欄のヒント・空の表示・無効・区切りのアイコン）。似た灰色を増やさない [unslop]
- アイコンの色の線引き: 押せるもの（一覧の行・アクティビティ・ボタンの中）のアイコンは二次、押せない飾り・区切りのアイコンは薄い
- 意味の色は **accent / danger / success / warning の 4 つ**だけ。新しい状態に新しい色を足さない。意味の色は意味のためにだけ使い、飾りに使わない [unslop][ui-skills]
- accent が画面に占めるのは数 %（主な操作・選択中・フォーカス・未読の点・生きている点）。1 画面に accent は 1 役 [unslop][hallmark][ui-skills]
- 意味の色は **文字・アイコン・点（`.dot`）・2px の線**に使う。面に塗るのは `.btn-danger` と `.alert` の枠だけ。色だけで状態を伝えない（文かアイコンを添える） [ui-skills]
- ダークの主な操作のボタンは白地に黒文字。色付きのボタンより落ち着く [unslop]
- グラデーション・半透明の面・ぼかし（backdrop-filter）・光彩（glow）は使わない [unslop][ui-skills][hallmark]
- 影は `--shadow-sm` 1 種だけ。使うのは**浮いているもの**（ドロワー・パレット・トースト・ダイアログ）だけで、レイアウトの中のカードには付けない。ダークの奥行きは面の段差（`--bg` → `--surface` → `--muted`）と 1px の線。浮いた面は地より明るく（暗くすると穴に見える） [unslop][hallmark]
- 色の付いた面の上に灰色の文字を置かない（`--primary` の上は `--primary-text`） [impeccable]
- ブラウザが描く面も palette に揃える: `::selection { background: var(--accent); color: var(--primary-text) }`、`caret-color: var(--accent)`、`scrollbar-color`（事実: scrollbar だけある） [impeccable][hallmark]
- 既定はダーク。ライトは設定で選べる。両方で全部の画面を確かめる。反転でなく、トークンごとに決めた値を使う [hallmark]

## 3. タイポグラフィ

- フォントは `--font-family`（`system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif`）の **1 家族**。道具の画面に見出し用の別の書体は要らない [impeccable]。Web フォント・CDN は使わない（CSP でも読めない）
- 段階は **12 / 14 / 16** の 3 つで組む（固定の px。画面幅で伸び縮みさせない）。18 以上は使わない [impeccable]。例外は 1 つだけ: 端末の写し（`.cc-screen`）の指の端末の 13px（下の端末の写しの項）。ほかに 13 を使わない
- 骨組み（バー・一覧・表・補足）は 14。**本文（会話の返事・ナレッジの中身・入力欄）は 16**。指の端末では会話の本文も 16（事実: 今は `.wb` の 14 を継いでいる） [impeccable][hallmark]
- 太さは 400 / 500 だけで、600 は名前・見出し・選択中の強調に限る。700 以上は使わない。階層は太さでなく大きさと色（3 つの役割）で作る [unslop]
- 行間: 本文 1.5、1 行の部品（行・ボタン・タブ）1.25。日本語の本文に `letter-spacing` や `font-feature-settings: "palt"` は付けない。小さい文字に負の字間は絶対に付けない [unslop][ui-skills]
- 折り返し: 本文は `white-space: pre-wrap` + `overflow-wrap: anywhere`。1 行の行は `text-overflow: ellipsis` + flex の子に `min-width: 0`。**トースト・知らせの本文の `span` にも `min-width: 0; overflow-wrap: anywhere`**（長い題名や URL で溢れる）。`text-wrap: balance / pretty` は日本語の 1 行見出しと `pre-wrap` の本文には効かないので使わない [hallmark]
- 和文と英数字・数字の間は半角空白 1 つ。数字と単位・`Ctrl+K` のような組は途中で折り返させない（`white-space: nowrap`） [hallmark]
- 数字は画面の中で 1 つの形（桁区切りあり・小数の桁を揃える）。縦に並ぶ所と刻む数字は `font-variant-numeric: tabular-nums` [unslop][ui-skills]
- 等幅（`--font-mono`）を使うのは **kbd・ログと記録の `<pre>`・端末の写し（`.cc-screen`）・ID / ハッシュ / パス・ルール文字列**だけ。ラベル・補足・表の見出し・数字には使わない [unslop][impeccable][hallmark]
- 端末の写し（`.cc-screen`）は 14px（指の端末 13px。12 / 14 / 16 の段階の唯一の例外）・行間 1.35・地は `--bg`・`tab-size: 4`。この製品でいちばん本物の材料をいちばん小さい文字にしない（事実: 今は 12px）
- 大文字だけのラベル・字間を広げた小さな見出し・見出しの上の「アイブロウ」は使わない。ラベルは本文の書体の 1 段小さいもの [unslop][hallmark][anthropic]
- 斜体で強調しない。見出しの一語だけ色や太さを変えない [unslop][hallmark]

## 4. 間隔・レイアウト

- 余白は `--space-1〜8`（4 / 8 / 12 / 16 / 20 / 24 / 32 / 48）だけ。一回限りの値を書かない。部品の内側 8〜12、部品の間 8、まとまりの間 16〜24 [unslop][hallmark]
- 同じものは同じ大きさ。一覧の行は 1 つの高さと 1 つの間隔 [unslop]
- 間隔がまとまりを表す。中の間隔 < 間の間隔。見出しは自分の項目に近く、上の節から遠く（上 24・下 8）。区切り線より先に余白で分ける [unslop][ui-skills][impeccable]
- 揃える。アイコンは 1 本の列、ラベルは 1 本の線、数字は右揃えの 1 列。**アイコンの無い行にも 16px の空の箱**を置いてラベルの開始位置を揃える [unslop]
- 行の高さは `--row`（PC 28px、`pointer: coarse` で 44px）。押せるものの当たりは **指の端末で 44×44 以上**。見た目を変えずに当たりだけ広げるときは `::before { inset: -8px }`（タブの × など） [hallmark]
- 隣り合う枠付きの部品の間は 12 以上。戻せない操作（[止める]）は隣の操作から離す [ui-skills]
- 幅の段: 639 以下（スマホ）/ 1023 以下（下タブ + ドロワー）/ 1024 以上（3 列）。これ以外の段を足さない。入力の種類は幅でなく `(hover)` `(pointer)` で見分ける [hallmark][impeccable]
- スマホ（639 以下）でも**状態の要点は見える**: タイトルバーの右に接続の点（押すと状態）と鈴（押すと知らせ）、実行中は下タブ「会話」の数の位置にスピナー。ステータスバーごと隠して終わりにしない [hallmark]
- 角丸は階層で分ける: `--radius-sm` 6（行・kbd・小さなボタン・カードの中の `<pre>`）/ `--radius-md` 8（入力欄・ボタン・カード・トースト）/ `--radius-lg` 12（ダイアログだけ）/ `--radius-full`（点・アバター・バッジ）。入れ子は「内 = 外 − 内側の余白」（最低 4）。**カードの中に同じ枠・同じ角丸のものを入れない**（カードの中のカード） [unslop][ui-skills][hallmark]
- 線は 1px の `--border`。区切りは線で表し、影や背景の段差で表さない。カードは枠か影のどちらか [hallmark][impeccable]
- 重なりの段は変数で持ち、数字を直接書かない: `--z-sash` 10 / `--z-drawer-backdrop` 40 / `--z-drawer` 41 / `--z-palette` 50 / `--z-dialog`（native の `<dialog>` は top layer なので不要）/ `--z-toast` 60 [ui-skills][hallmark]
- 幅は `100%`（`100vw` を書かない）。flex の縮む子に `min-width: 0`、アイコンと画像に `flex: none` [hallmark]
- 表は 639 以下で 5 列まで（時刻・種類・結果・主な数 2 つ）。残りは行の `details` に。行の名前の列と操作の列は常に見える [hallmark]
- mobile-native の要点（`index.html` と `app.css` で守る）:
  - `viewport-fit=cover`（事実: ある）+ **`env(safe-area-inset-*)`** をタイトルバーの上・下タブの下・ドロワー・トーストに（事実: app.css に `env()` は無い）。端の余白は `max(var(--space-4), env(safe-area-inset-left))` の形で変数に折り込む [emil][hallmark][ui-skills]
  - 高さは `100dvh`（事実: ある）。`100vh` は書かない [emil][ui-skills]
  - 入力欄の文字は **16px 以上**（iOS の拡大を防ぐ。`maximum-scale` で止めない） [emil]
  - `html { -webkit-tap-highlight-color: transparent }`（事実: base.css にある）の代わりに **全部の押せるものに `:active` を付ける**（§6） [emil]
  - 押せるものに `touch-action: manipulation` と `user-select: none`（本文には付けない） [emil][vercel]
  - `html, body { overscroll-behavior: none }`、中のスクロールに `overscroll-behavior: contain` [emil][vercel]
  - `:hover` は **`@media (hover: hover) and (pointer: fine)`** の中だけ（事実: 今は `(hover: hover)` だけ） [emil][hallmark]
  - `theme-color` はライト・ダークで 1 つずつ、`--surface` の値（`docs/plan/web-ui.md` §11.2） [emil][vercel]
  - 直したら iPhone の実機で確かめ、「実機 / エミュレータ」のどちらで見たかを書く [emil][impeccable]

## 5. 部品

| 部品 | 決まり |
|---|---|
| ボタン | `.btn` に primary / secondary / ghost / danger の 4 種。**primary は 1 画面（ダイアログ・カード）に 1 つ、secondary は 2 つまで、残りは ghost か `…`（ellipsis）の 1 つにまとめる**。danger は確認ダイアログの中だけ。**危険な側・戻せない側を primary にしない**（許可 / 拒否なら許可は secondary）。アイコンだけのボタンは `aria-label` 必須。文字は動詞で 2〜6 字。**文字を折り返させない**（長い補足はボタンの外へ）。無効は `disabled` 属性 + 見た目 + 理由（`title`）（`disabled` のボタンは焦点を受けないので、理由はキーボードには届かない。`aria-disabled` に変えるのは後の段）。押している間 `scale(0.97)` [hallmark][emil][impeccable] |
| 部品の状態 | 押せるものは **既定・hover・focus・active・disabled・読み込み中・エラー・成功**の 8 つを持つ（要らない状態は「無い」と決めて書く）。読み込み中はラベルを読めるまま、幅を変えない [hallmark][impeccable] |
| バッジ・点 | 状態は `.dot`（8px の丸）か文字色だけ。塗りつぶしのピルは**未読の数だけ**（群の見出しの件数は文字）。一覧の行のバッジは**最重要の 1 つ**まで（残りは `title` と中身の画面に）。`PRO`・`Beta` のような飾りのバッジは作らない [unslop][hallmark] |
| カード | 使うのは「確認のカード」（/close の下書き・許可）だけ。数字は表か `dl`。**同じ形のカードが 3 つ以上並ぶなら表**。枠は 1px、影なし。カードの中の `<pre>` は枠なし・`--radius-sm`・地は `--bg` [unslop][impeccable][hallmark] |
| 許可のカード | ボタンは **[許可][拒否] の 2 つ**（許可 secondary・拒否 ghost）。「このセッションでは常に許可」は `label.check` のチェックボックスで、ルールの文字列は次の行の `<code>`（チェックで [許可] の送り先が変わる）。残り時間は 1 秒で刻む（§6.1）。説明の段落は `title` に [hallmark][impeccable] |
| 一覧の行 | 高さ `--row`。左に 16px のアイコン（無ければ空の箱）、中央に名前（1 行で省略）、右に補足（`--text-secondary`・tabular）。選択中は `--muted` の地 + 左 2px の accent（`aria-current`）。**行に置く操作は 1 つまで**（完了はチェックボックス、戻せない操作は行の外）。押せない行は hover しない [hallmark][unslop] |
| 表 | 見出し行は 14・`--text-secondary`・折り返さない。先頭の列は名前（id は名前の下の補足）。数字の列は右寄せ + tabular。空のセルは空のまま（`—` を置かない）。横の線だけ。50 行を超えるなら API 側で絞る [hallmark] |
| 使用量の数字 | 人格ごとの行の表。**キャッシュ率を 1 つだけ大きく**（この製品でいちばん意味のある数）、入力・出力は同じ行の補足。日ごとのグラフは 1 色で今日だけ強調、目盛りは `--text-secondary` [unslop][impeccable] |
| トースト | 右下（スマホは下タブの上）。多くて 2 つ。文 + 任意の [取り消す] + ×。**画面に結果が見えるなら成功のトーストを出さない**（失敗と見えない結果だけ）。失敗は `role="alert"` の別の容れ物（左 2px の `--danger`）で、[もう一度] を持ち、自動で消えない。hover と focus の間は自動で消えない。本文は折り返す [hallmark] |
| ダイアログ | `<dialog>` の `showModal()`。最大 512px、角丸 12、1 つの目的。見出し 16・本文は `.meta`。ボタンは右寄せで [やめる][実行する]。危険な操作は [実行する] を danger にし、本文に対象の名前を入れ、**最初のフォーカスは [やめる]**。元に戻せる操作は確認せず、やってから [取り消す]。まずモーダルにしない [hallmark][impeccable][ui-skills] |
| 入力欄 | `<label>` を必ず付ける。**placeholder は例か動詞句（「探す」「<題名> に送る」）で、操作の説明を書かない**。操作の説明（Enter で送る など）は設定のキー一覧と `title` に。枠の太さは状態で変えない。隣のボタンと同じ高さ。非認証の欄は `autocomplete="off"`。送る欄は `enterkeyhint="send"`、探す欄は `"search"`。必須は `required` + `aria-required`。エラーは欄のすぐ下に `role="alert"` + `aria-describedby` + `aria-invalid` で、**高さを `min-height: 1lh` で予約**して跳ばない [hallmark][ui-skills][vercel][unslop] |
| チェック・選択 | native のまま。チェックは `accent-color: var(--accent)`、select は背景と文字色を明示。権限モードのような選択肢は識別子に説明を添える（「acceptEdits（編集は確認なし）」） [hallmark][vercel] |
| 空の表示 | `.empty`（アイコン 1 つ + 文）。**何が無いか・次にすること**を書く。初めて・検索で 0 件・絞り込みで 0 件・失敗の 4 つを言い分け、失敗には [読み直す] [impeccable][ui-skills][hallmark] |
| 読み込み中 | `.loading`（**枠も余白も無し**。文「読み込んでいます…」だけ、`min-height: var(--space-8)`、`aria-busy`）。`.empty` を流用しない（読めた瞬間に枠が消えて跳ぶ）。スケルトンは作らない（一覧は小さく 2 秒以内に来る。skill は形のあるスケルトンを勧めるが文で足りると決めた）。スピナーはボタンの中と実行中のターンだけ [hallmark] |
| コマンドパレット | 開閉に動きを付けない。入力欄は指の端末で 16px（PC は 14。iOS の拡大を防ぐのが目的）で placeholder は「探す」（mode の表示と二重にしない）。候補は「動詞句」+ 右に `/new` の kbd 風（接頭辞 + 名詞 + 説明の二重にしない）。アイコンの無い候補は空の 16px の箱（一律の chevron を置かない）。絞り込みで動かさない。検索は 250〜300ms の debounce [hallmark][emil][unslop] |
| ポップオーバー・メニュー | 作るなら `popover` 属性か `position: fixed`。`overflow: hidden` の親の中に絶対配置しない [impeccable][hallmark] |
| コピーのボタン（作るなら） | ラベルを 2.5 秒「コピーしました」に変える。トーストは出さない [hallmark] |

使わないもの: ツールチップの部品（`title` で足りる）、スケルトン、重ねたモーダル、カルーセル、フローティングのアクションボタン、画像のアバター、タブの中のタブ、ヒーロー、装飾の番号、`→` を付けたリンク文、ブラウザや端末の枠を描いた飾り、見出しに常設の「n 秒ごとに更新」（`title` に） [hallmark]。

## 6. 動き

**動かす前に「1 日に何回見るか」「止めたら何が失われるか」を考える。失われるものが無ければ動かさない** [emil][hallmark]。

| 対象 | 動き | 長さ | イージング |
|---|---|---|---|
| ボタン・行・タブ・アクティビティの押下 | `transform: scale(0.97)`（行は `--muted` の地だけ） | `--dur-micro` 120ms | `--ease-out` |
| hover の色（PC だけ） | 色・枠だけ。1 要素に 1 つの合図 | `--dur-micro` | `ease` |
| ドロワー（サイドバー） | `translateX(-100%)` → 0 | 開く `--dur-long` 300ms / 閉じる 200ms | `--ease-out` |
| ダイアログ | `opacity 0 → 1` + `scale(0.98 → 1)`。閉じるは 65% | `--dur-short` 200ms / 130ms | `--ease-out` |
| トースト | `translateY(8px)` + opacity（`@starting-style`）。同じ方向に消える | `--dur-short` 200ms / 130ms | `--ease-out` |
| パレット・タブの切り替え・Alt+数字・Ctrl+B / J | **動かさない** | 0 | — |
| 一覧の増減・並び替え・絞り込み | 動かさない | 0 | — |
| スピナー（実行中・ボタンの中） | 回転 | 800ms 周期 | `linear` |

- 変数は 3 つの長さ（`--dur-micro` 120 / `--dur-short` 200 / `--dur-long` 300）と 1 つの曲線（`--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`）。300ms を超えない。`ease-in`・バウンス・スプリングは使わない [emil][unslop][impeccable][hallmark]
- 出るときより消えるときを短く（60〜75%）。方向は同じ [hallmark][ui-skills]
- 動かすのは `transform` と `opacity`（色の変化は hover だけ）。`height`・`padding`・`margin`・`width`・`transition: all`・`will-change` は書かない [unslop][ui-skills][hallmark]
- 出入りは CSS transition（割り込める）。`@keyframes` はスピナーだけ。`scale(0)` から始めない [emil][ui-skills]
- hover は押せるものにだけ。押せないものはポインタに反応しない。フォーカスの輪は即座に出す [hallmark][unslop]
- 読み込み時の演出（節ごとのふわっと表示）は作らない [impeccable][anthropic]
- `prefers-reduced-motion: reduce` では base.css が全部の transition を止める（事実）。それで足りる。位置の動きが消えても意味が通るように作る [emil][impeccable]

### 6.1 署名の仕草: 生きている点と 1 秒の刻み

- **何を**: 「今この瞬間に生きている」ものだけを `.dot`（8px・`--accent` か `--success`）と tabular の数字で表し、数字は **1 秒ごと**に進める（経過時間「m 分 s 秒」、許可の残り時間、実行中のツール回数）。点は静止、数字が動く。脈動・明滅・回転で「生きている」を表さない（スピナーは「待っている」の意味に限る）
- **出す所**: ステータスバー（PC）とタイトルバーの右（スマホ）の接続の点、会話の実行中の行、許可のカードの残り時間、下タブ「会話」の実行中、サイドバーの未読の点（静止・`--accent`）
- **出さない所**: 一覧の行・表・カード・見出し。見出しの「n 秒ごとに更新」のような注記は `title` に
- **刻み方**: `setInterval` 1 秒で**文字だけ**を書き換える（描き直さない）。描き直しの周期（3 秒・10 秒）に数字の更新を乗せない（数字が飛ぶ）。隠れたタブ（`visibilityState`）では止める
- **reduced-motion**: 数字の更新は動きではないので続ける。スピナーは止めて静止した点 + 文（「作業中…」）にする
- **色**: 接続 = `--success`、切断 = `--danger`、実行中・未読 = `--accent`。点は意味の色の 4 つから外れない

## 7. 言葉

- 文体は「です・ます」の短い文。1 文 1 内容。「！」「？」「〜」を使わない。絵文字・記号の飾りを使わない。「おっと」のような前置き・謝罪を書かない [unslop][hallmark]
- 句点: ボタン・ラベル・見出し・バッジ・一覧の行・トーストの 1 文には付けない。説明・エラー・空の表示の文には付ける [unslop][hallmark]
- 名前はユーザーの側から。**実装の名前（ツール名 `task_add`・`kb_delete`・`project_open`、コマンド `claude agents --json`、環境変数名、ファイル名 `settings.json`、HTTP の番号）を画面に出さない**（決定）。例外は設定の「環境変数の有無」の表だけ。権限モードの識別子は値として残し、説明を添える [impeccable]
- 操作の名前は**流れの中で同じ語**（「閉じる」→「閉じますか」→「閉じました」）。**違うものに同じ語を使わない**（Discord のセッションは「新しいセッション」、tmux の起動は「Claude Code を起動」。トーストの [取り消す] は undo、送信待ちの取り消しは「やめる」）。語彙は下の表で固定する [impeccable][anthropic]
- ボタンは動詞 2〜6 字、タブと見出しは名詞 2〜8 字。「OK」は使わず、何をするかを書く（`confirm` の既定も「実行する」）。挨拶の見出しは書かない [unslop]
- 常設の説明文を置かない。入力欄の下の 1 文・一覧の末尾の段落・120 字のダイアログの説明は、2 文までに削るか `title`・設定のキー一覧に寄せる [hallmark][unslop]
- 数は半角数字、単位との間に空白。省略は「…」の 1 文字。変化は何と比べたかを添える [unslop]
- エラー: **何が起きたか + （分かれば）なぜ + 次にすること**を 1〜2 文で。既定の「操作に失敗しました」で終えない（種類ごとの文を持つ）。例: 「送れませんでした。Discord に投稿できません」 [impeccable][hallmark]
- 空: 何が無いかと、どうすれば増えるか。例: 「動いているリマインドはありません。会話で「明日 9 時に知らせて」と頼むと増えます」 [ui-skills][hallmark]
- 読み込み: 「読み込んでいます…」の 1 つ。長い処理は実際の操作の名前で（「要約しています…」） [impeccable]
- 成功: 画面に結果が見えるなら何も言わない。見えないときだけ 1 文、括弧の補足を付けない [hallmark]
- 無効にした操作には理由を添える（`title` か隣の補足） [hallmark]
- 補足を「・」でつなぐのは 2 要素まで。3 つ目以降は改行か別の `span` [hallmark]
- 時刻は `10/27(火) 4:12` の形で統一（事実: ui.js の `dateTime`）。今日なら `HH:MM`。相対時間は使わない
- 煽る語・確かめられない数・`[X]` の仮の値を書かない [unslop][hallmark]

語彙の表（この語で統一する。別の語を足すときはここに足す）:

| 語 | 意味 | 使わない言い換え |
|---|---|---|
| 会話 | #inbox・#tasks・#<NAME>・セッションのチャンネルでの Bot とのやり取り | チャット・履歴 |
| 入口 | #inbox・#tasks・#<NAME> | 常設チャンネル |
| セッション / 新しいセッション | /new・session_open で作ったチャンネル / それを作る | トピック・スレッド |
| Claude Code を起動 | この機械の tmux で claude を始める | 新しいセッション（上と混ぜない） |
| 進行中 / 待ち / 完了 | セッションの状態 | アクティブ・保留・クローズ |
| ターン | 発言 1 つに対する Bot の 1 回の処理 | リクエスト・実行 |
| 手順 | ターンの中の 1 つの道具の使用 | ステップ・ツール呼び出し |
| 中断する / 続ける | 実行中のターンを止める / 手順の上限の後に再開する | キャンセル・再開 |
| やめる | 確認ダイアログを閉じる・送信待ちを取り下げる | キャンセル |
| 取り消す | 直前の操作を元に戻す（トースト） | undo・やめる |
| 閉じる / 会話を新しくする / 待ちにする | /close・/renew・/wait | クローズ・リセット・保留 |
| 知らせ | #system に出るもの | 通知・アラート |
| 記憶 / ナレッジ | memory_* / kb_* で保存したもの | メモリ・KB |
| 送る | 会話に本文を投稿する | 送信・投稿 |
| 許可 / 拒否 | Claude Code の許可の要求への答え | 承認・却下 |
| Claude Code のチャンネル | Claude Code のセッションに結びつけた Discord のチャンネル | 専用チャンネル・連携チャンネル |
| Discord のチャンネルを作る | そのセッションに Claude Code のチャンネルを結びつける（手動の口） | チャンネルを開く・紐づける |
| 起動して続ける | 終わったセッションのチャンネルで、同じディレクトリに新しいセッションを起動して結びつけ直す | 続ける（手順の上限の後）・再開 |
| 写し | Web・ツール・GitHub から送った本文や、端末・RC から打った指示をチャンネルに出したもの | エコー・ミラー・転送 |

## 8. アクセシビリティ

- フォーカスの輪は base.css の `:focus-visible`（2px の accent）。消すなら別の見える表示を付ける。輪は要素と地の両方に対して 3:1 以上 [hallmark][ui-skills]
- 押せるものは `<button>`（`type` を明示）、移動は `<a>`。`div` に click を付けない。`tabindex` は 0 か -1 だけ [ui-skills]
- アイコンは `aria-hidden="true"`（事実: `SA.ui.icon`）。アイコンだけのボタンに `aria-label` [hallmark][ui-skills]
- 状態は属性で: 選択 `aria-pressed` / `aria-current`、開閉 `aria-expanded` + `aria-controls`、実行中 `aria-busy`、知らせ `role="status"`、**失敗は `role="alert"`**（トーストも）。入力のエラーは `aria-describedby` + `aria-invalid="true"`、必須は `required` + `aria-required` [ui-skills][hallmark]
- ダイアログは `showModal()`（焦点を閉じ込め、Esc で閉じ、後ろは `inert`）。閉じたら開いたボタンに焦点を戻す。danger の最初の焦点は [やめる] [ui-skills][hallmark]
- タブの中身の見出しは `h1` を 1 つ（タブごと）。その下は `h2`、その下は `h3`。**段を飛ばさない**（h1 → h3 を書かない。カードの見出しは `h2`、ラベルと値は `dl`） [vercel][hallmark]
- 本文の先頭に「本文へ」のスキップリンクを 1 つ（フォーカス時だけ見える） [vercel]
- 重要な情報をトーストだけで伝えない（会話の行・画面の状態にも残す） [ui-skills]
- hover で出るもの（タブの ×）は focus でも出す。hover だけの操作を作らない [hallmark][ui-skills]
- `color-scheme` を `html` に付ける（事実: ある）。無効は色だけで表さない [ui-skills]
- 色だけで状態を伝えない（点 + 文、色 + アイコン） [ui-skills]
- 長い題名（100 字）・長い返事（4,000 字）・ナレッジの本文・英数字だけの行で崩れないことを、狭い幅と 200% のズームで確かめる [impeccable]

## 9. Vercel Web Interface Guidelines のうち、この UI に当てはまるもの

| 項目 | 今 | 備考 |
|---|---|---|
| アイコンだけのボタンに accessible name | ○ | |
| 入力欄に label / accessible name | ○ | |
| `<button>` / `<a>` を使い、clickable div を作らない | ○ | |
| 飾りのアイコンを支援技術から隠す | ○ | |
| トースト・検証は `polite` に知らせる | △ | 失敗が `status` のまま。`alert` に分ける |
| focus-visible の輪を消さない | ○ | 消した所は代替あり |
| 固定の UI がフォーカス中の要素を隠さない | △ | 下タブ・トーストの重なりを safe-area と一緒に確かめる |
| 入力の type / inputmode / enterkeyhint | △ | `enterkeyhint` が無い |
| 貼り付けを止めない | ○ | |
| 送信は要求を始めるまで押せる | ○ | |
| エラーは欄の近くに・`aria-describedby` | △ | `role="alert"` はあるが結び付けが無い |
| placeholder は例を書く | △ | 操作の説明になっている所がある |
| reduced-motion を尊重 | ○ | |
| transform / opacity だけ・`transition: all` なし | ○ | |
| 省略は「…」・数字は tabular | ○ | |
| 長い文の折り返し・`min-width: 0` | △ | トースト・知らせの本文に無い |
| 空の状態を作る | △ | 次の行動の文が無い |
| 一覧は 50 件以上を仮想化 | — | API の上限で絞る |
| URL が状態を映す | ○ | hash |
| 危険な操作は確認か取り消し | ○ | |
| `touch-action: manipulation`・tap highlight | △ | manipulation が無い |
| overscroll を閉じ込める | ✗ | |
| safe-area を守る | ✗ | |
| `color-scheme`・theme-color | △ | theme-color が無い |
| 日付・数は Intl | ○ | |
| hover / active / focus は rest より目立つ | △ | `:active` が無い |
| 能動態・具体的なボタン名・次の一手のあるエラー | △ | 既定の「操作に失敗しました」が残る |

除いたもの: 画像の寸法・lazy、フォントの preload、hydration、i18n の言語判定、Title Case、動画、OG / canonical / JSON-LD（tailnet の中で共有しない）。

## 10. 「AI っぽさ」の禁止事項

色・面:
1. 紫・青紫・紫→ピンクのグラデーション、グラデーションの文字、色付きの光彩、色付きの影、ネオンの枠 [anthropic][unslop][hallmark][ui-skills]
2. ガラス風（ぼかし + 半透明）のバー、文字の後ろの色のにじみ・ぼかした球 [unslop][impeccable]
3. 全部に同じ角丸・同じ薄い影。全部ピル [anthropic][unslop]
4. 同じ形の角丸カードを格子に並べる。カードの中のカード。3 つ以上なら表 [anthropic][impeccable][hallmark]
5. 似た灰色の文字色を 4 つ以上。全部を強調して何も目立たない。枠組みの既定の見本色をそのまま使う [unslop][hallmark]

文字・ラベル:
6. 見出しの上の小さな大文字のラベル、字間を広げた大文字、`WORD — fragment` 形、文末の `→` [anthropic][unslop][hallmark]
7. 見出しの一語だけ色・斜体・太字。700 以上の見出し [anthropic][unslop][hallmark]
8. 「技術っぽさ」のための等幅 [anthropic][impeccable][hallmark]

アイコン・飾り:
9. 絵文字をアイコン・見出し・トーストに。✨ の「AI」アイコン。アイコンに別々の色。意味の無い一律のアイコン（全行の chevron） [anthropic][unslop][hallmark]
10. 装飾の番号、意味の無い区切り線、`A · B · C` の 3 つ以上の中黒つなぎ、ラベルの前の飾りの点（`.dot` は生きた状態を表すときだけ） [anthropic][hallmark]
11. ブラウザの枠や端末の枠を描いた飾り、空の枠だけのプレースホルダ [hallmark]
12. 大きな数字 1 つ + 小さなラベル + スパークライン・ミニバー・進捗の輪。3 つの数字を同じ重さで横に並べる [anthropic][unslop][impeccable]

動き:
13. 読み込み時に節がふわっと上がる、カードの hover の浮き上がり、バウンス、`transition: all` [anthropic][unslop][hallmark]
14. 生きていないものの脈動、見出しのシマー、パララックス [unslop][hallmark]
15. フェードで現れるフォーカスの輪。見えている結果に対する祝いのトースト [hallmark]

言葉:
16. 「成功しました！🎉」「少々お待ちください」「おっと」 [anthropic][unslop][hallmark]
17. 挨拶の見出し、煽る語、確かめられない数、`[X]` の仮の値 [unslop][hallmark]
18. ヒーロー、キャッチコピー、「Powered by」、`Beta` のピル、常設の説明文 [anthropic][hallmark]
19. 送っていないのに「送りました」と出す偽の成功 [hallmark]

部品:
20. スケルトンのシマー、無限スクロールの演出、ツールチップの部品、重ねたモーダル、画像やグラデーションのアバター [anthropic][emil]
21. 「まずモーダル」。行の中で済む操作をダイアログにする [impeccable][hallmark]
22. 行ごとのボタンの連打、全行に露出した戻せない操作、ボタンの中で折り返す長い文 [hallmark][impeccable]

## 11. 決定と未決

決定（オーナー。2026-11-04）:
1. 方針 A（VS Code 風の密度を保つ）。
2. アイコンは幾何学の印を Node で PNG に（`docs/plan/web-ui.md` §11.5 の a）。
3. ライト・ダークを残す（theme-color は JS で切り替え）。
4. PWA は https（tailscale serve）だけを対象にする。http の中継は対象外。
5. 性格 A「夜勤の計器盤」: ink 寄りの中立 + 自前のコバルト（§2.1 の値）。署名の仕草は「生きている点」と 1 秒の刻み（§6.1）。
6. 文字の役割は本文・二次・薄い の 3 つ（`--text-secondary` を足す）。
7. 実装名（ツール名・コマンド・環境変数名・ファイル名・HTTP の番号）は画面から消す（§7）。

この文書で決めたもの: 意味の色 4 つ、文字の 3 段階、角丸の階層、z-index の表、§6 の表と 3 つの長さ・1 つの曲線、§7 の文体と語彙の表、スケルトンを作らない、`text-wrap` を使わない、端末の写しは 14px、入力欄の枠は飾りの線のまま（3:1 を求めない）。

未決: 無し。
