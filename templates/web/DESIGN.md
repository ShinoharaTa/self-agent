# 見た目の決まり

ページは site/base.css の変数と部品で作る。値はすべて base.css の変数で、ここはその使い方。

## 原則
- スマホで 1 列。1 画面に 1 つの目的。装飾より余白。
- 色は意味のためだけに使う。
- CSS に px と色の値を直接書かず var() を使う。
- base.css は編集しない。足りないものは site/app.css に var() で書く。

## 余白
- 4 の倍数だけ。--space-1〜8 = 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48。
- 部品の内側は 12〜16、部品の間は 8〜12、まとまりの間は 24。
- main.container.stack の子（まとまり）の間は 24、その中の .stack は 12。

## 文字
- --font-family（system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif）。Web フォントは読まない。
- サイズ: --font-xs 12（補足だけ）/ --font-sm 14 / --font-base 16 / --font-lg 18 / --font-xl 20 / --font-2xl 24。
- 本文と入力欄は 16（16 未満だと iOS が拡大する）。
- 行間: 本文 --leading-normal 1.5、見出し --leading-tight 1.25。
- 太さ: --weight-normal 400 / --weight-medium 500 / --weight-semibold 600。

## 角丸
- --radius-sm 6（小物）/ --radius-md 8（ボタン・入力・カード）/ --radius-lg 12（ダイアログ・シート）/ --radius-full（チップとバッジだけ）。

## 色
- 意味の名前の変数だけを使う: --bg 背景 / --surface カード・ダイアログ / --muted 控えめな面 / --border 線 / --text 文字 / --text-muted 補足の文字。
- --primary 主な操作（黒。ダークでは白）/ --primary-text primary の上の文字色。
- --accent 青 1 色。リンクと選択中だけ。
- --danger 削除・エラー / --success 完了 / --warning 注意。
- ダークモードは prefers-color-scheme: dark でこの変数だけが差し替わる（color-scheme: light dark）。
- 影は --shadow-sm の 1 種だけ。グラデーションと飾りの色は使わない。

## 部品（base.css のクラス）
- .container: 最大 640px・左右 16px・safe-area の余白。.stack: 縦に並べる（gap）。.row: 横に並べる。
- .card: 囲み。
- .btn に .btn-primary（主な操作。1 画面に 1 つ）/ .btn-secondary / .btn-ghost / .btn-danger。高さ 44px 以上。
- アイコンだけのボタンは .btn .btn-ghost .btn-icon にし、aria-label を付ける。
- .input / .select / .textarea: 高さ 44px 以上・文字 16px。名前は <label> で付ける。
- .check: `<label class="check"><input type="checkbox"> 文字</label>`（箱は 24px、行で 44px）。
- .chip: 絞り込みなど（選択中は aria-pressed="true"）。.badge: 状態の小さな表示。
- .list（ul）と .list-item（li）。
- .segmented: button を並べ、選択中は aria-pressed="true"。
- .empty: 空の表示。.toast: 短い知らせ（画面の上に出す）。
- `<dialog>`: 確認と入力（showModal() で開く）。
- .bottom-bar: 画面下に固定する操作（safe-area の余白）。
- .icon: アイコン（20px）。

## 状態
- :focus-visible の輪と disabled の見た目は base.css にある。消さない。
- 読み込み中・空・エラーの表示を必ず作る（.empty に文とアイコン。エラーは role="alert"）。
- 押せるものは 44×44px 以上。

## アイコン
- UI に絵文字を使わない。site/icons.svg の sprite を次の形で使う:
  `<svg class="icon" aria-hidden="true"><use href="icons.svg#plus"></use></svg>`
- 入っている名前: plus, x, check, trash-2, pencil, search, settings, chevron-left, chevron-right, chevron-down, ellipsis, calendar, clock, info, triangle-alert, rotate-ccw, grip-vertical, list, square-check, circle
- sprite に無いアイコンが要るときは文字のボタンにする。

## 書き方の例
```html
<main class="container stack">
  <form class="row">
    <input class="input" name="item" placeholder="買うもの" aria-label="買うもの">
    <button class="btn btn-primary"><svg class="icon" aria-hidden="true"><use href="icons.svg#plus"></use></svg>追加</button>
  </form>
  <ul class="list">
    <li class="list-item">
      <label class="check"><input type="checkbox"> 牛乳</label>
      <button class="btn btn-ghost btn-icon" aria-label="削除"><svg class="icon" aria-hidden="true"><use href="icons.svg#trash-2"></use></svg></button>
    </li>
  </ul>
</main>
```
