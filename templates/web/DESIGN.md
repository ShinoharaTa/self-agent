# 見た目の決まり

ページは site/base.css の変数と部品で作る。値はすべて base.css の変数で、ここはその使い方。

## 原則
- スマホで 1 列。1 画面に 1 つの目的。装飾より余白。
- 色は意味のためだけに使う。
- CSS に px と色の値を直接書かず var() を使う。
- base.css は編集しない。足りないものは site/app.css に var() で書く。
- index.html の head で base.css、次に app.css を link する（無ければ足す）。

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
- --radius-sm 6（小物）/ --radius-md 8（ボタン・入力・カード）/ --radius-lg 12（ダイアログ）/ --radius-full（チップとバッジだけ）。

## 色
- 意味の名前の変数だけを使う: --bg 背景 / --surface カード・ダイアログ / --muted 控えめな面 / --border 線 / --text 文字 / --text-muted 補足の文字。
- --primary 主な操作（黒。ダークでは白）/ --primary-text primary の上の文字色。
- --accent 青 1 色。リンク・選択中・フォーカスの輪だけ。
- --danger 削除・エラー / --success 完了 / --warning 注意。danger / success / warning は文字・アイコン・線に使える。
- ダークモードは prefers-color-scheme: dark でこの変数だけが差し替わる（color-scheme: light dark）。
- 影は --shadow-sm の 1 種だけ。グラデーションと飾りの色は使わない。

## 部品（base.css のクラス）
- .container: 最大 640px・左右 16px・safe-area の余白。.stack: 縦に並べる（gap）。.row: 横に並べる。
- .card: 囲み。
- .btn に .btn-primary / .btn-secondary / .btn-ghost / .btn-danger。高さ 44px 以上。
- primary は主な操作（1 画面に 1 つ）、secondary は補助の操作、ghost は行の中の小さな操作、danger は削除の確認の中だけ。
- アイコンだけのボタンは .btn .btn-ghost .btn-icon にし、aria-label を付ける。
- .input / .select / .textarea: 高さ 44px 以上・文字 16px。名前は <label> か aria-label で付ける。
- .check: `<label class="check"><input type="checkbox"> 文字</label>`（箱は 24px、行で 44px）。
- .chip: `<button class="chip">` で使う。絞り込みなど（選択中は aria-pressed="true"）。.badge: 状態の小さな表示。
- .list（ul）と .list-item（li）。
- .segmented: button を並べ、選択中は aria-pressed="true"。
- .empty: 空の表示。
- .toast: 短い知らせ（画面の上に出す）。`<div class="toast" role="status" hidden>` を置き、hidden 属性の付け外しで出し入れする（inline style を使わない）。
- `<dialog>`: 確認と入力（showModal() で開く）。
- .bottom-bar: 画面下に固定する操作（safe-area の余白）。.bottom-bar のある画面に入力欄を置かない（iOS でキーボードと重なる）。
- .icon: アイコン（20px）。

## 状態
- :focus-visible の輪と disabled の見た目は base.css にある。消さない。
- 空・エラーの表示は必ず作る（.empty に文とアイコン。エラーは role="alert"）。
- 読み込みに時間がかかる処理があるときだけ、読み込み中の表示を作る。
- 押せるものは 44×44px 以上。

## 使い勝手
- 取り消し優先: 消す・置き換えるは確認ダイアログを出さず、やってから .toast に [取り消す] を出す（全消去と読み込みの置き換えだけ確認する）。[取り消す] のあるトーストは自動で消さず、× で閉じる。
- 入力の摩擦: いちばん入れたい欄（金額・名前など）を先頭にして autofocus。前回の選択（カテゴリなど）を覚えて初期値にする。日付は今日を既定にし、変えるときだけ開く。
- 空状態: 空の表示は 1 画面に 1 つにし、次の行動（「下の［追加］から入れられます」）を書く。
- 位置の把握: 一覧や期間を切り替えたら、結果が見える位置へスクロールする。初期の状態（今月・全件）に 1 タップで戻る手段を置く。
- 色の役割: 赤は「超過・失敗」だけ。マイナスや未達には色を付けない。大きい数字は 1 画面に 1 つ。
- 失敗の表示: 保存に失敗したら成功の表示で上書きせず、ダイアログを閉じずに role="alert" で出す。
- ダイアログ: 1 つのダイアログに 1 つの目的。長いときは閉じる・保存のボタンを下に固定する（position: sticky）。
- 一覧の行: メモは 2 行まで折り返す（1 行に切らない）。支出に「-」は付けず、収入だけ「+」を付ける。

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
