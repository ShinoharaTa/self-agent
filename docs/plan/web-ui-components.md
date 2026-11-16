# Web UI の新しい殻を部品で作り直す（K0〜K9）

2026-11-16。親 issue は #349。方式は B（Preact + htm をビルドなしで同梱）に決まった（§10）。K0（画面写し。`npm run ui-shots`）は #386 で済み、K1 は #388。

方式を比べた記録（§2〜§5）は、決めた理由としてそのまま残す。調べたときの main は 4384d24。

## 0. 何のために

オーナーが実機で新しい殻を見て言ったこと（2026-11-16）:

> なんか前のCSSとかのイメージ引き継いでて結局破綻してない？コンポーネント化した設計も上手いこと使って実装して。必要なライブラリとか用意してる？

元の方針（メッセンジャー型・「あなたの番」が一目で分かる・右腕はどの画面からも届く・セッションの種類を考えさせない）を、**選んだ絵（モック D）どおりの見た目**でスマホの PWA に出す。そのために (1) 古い CSS を切る、(2) 部品として作る、(3) 要る道具を揃える、の 3 つを決める。

## 1. 結論（先に）

- **推薦は B: Preact 11.2.0 + htm 3.1.1 を、ビルドなしで `src/web/static/` に同梱する（light DOM。Shadow DOM・Lit は使わない）。**
- ただし「古い CSS を切る」のは A でも B でも同じ仕事で、**ライブラリでは切れない**。切るのは「新しい部品は `c-` で始まるクラスだけを使い、`app.css` を読まない」という決まりと、それを見張るテスト。
- B が足すのは 2 つ: 手書きの差し替え（`replaceChildren`・手書きの reconcile）が要らなくなること、部品が「入力 → 見た目」の関数になり、**fake DOM も正規表現も無しで `import` して試せる**こと。
- 見た目は**部品の見本のページ + headless Chromium の画面写し**で確かめる。これが今まで無かったのが、破綻に気づけなかった一番の理由（推測ではなく事実: 151 個のテストは構造と文字列だけを見ていて、絵は 1 枚も見ていない）。
- **PR #383（flip）は止める。** スマホの主経路（一覧 → 会話 → 入力欄 → 右腕）を部品で作り直し、実機で見てから flip する。
- オーナーの決定は §10。

## 2. 確かめたこと・推測・未確認

### 2.1 コードで確かめた事実

| # | 事実 | 場所 |
|---|---|---|
| F1 | 新しい殻は `base.css` → `tokens.css` → **`app.css`** → `shell.css` を読む。`shell.css` の先頭に「配置だけ。部品（.btn・.dot・.ed* など）は app.css のものをそのまま使う」とある | `src/web/static/v3.html`・`shell.css` |
| F2 | `app.css` は 3,250 行・280 クラス。新しい殻の自前の部分（`shell.js`・`topics.js`・`v3.html`）だけで 46 クラスを直に使う。中身（`chat.js` 62・`views.js` 129）は全部 `app.css` | 数えた |
| F3 | `shell.css` は古い殻の寸法のトークンを使う（`--row` 28px/44px が 6 か所、`--titlebar-h` 40px、`--font-xs` 6 か所）。自前の変数は幅 2 つだけ | `shell.css`・`tokens.css` |
| F4 | モック D の数値は今の殻と違う。吹き出しの角 14/4px、入力欄は高さ 44px・角 22px の 1 行、送るは accent、「あなたの番」はスマホが warning の見出しと枠なしの 2 行の行・PC が warning の件数のボタン 1 つ（枠のカードではない。K3 で読み直した）、下のバーは 64px で中央に右腕の accent のボタン、PC の行は 36px | モック D（リポジトリの外） |
| F5 | 描画は手書き。DOM を書き換える所は `chat.js` 39・`views.js` 36・`shell.js` 17・`topics.js` 9。`topics.js` は key 付きの reconcile を自前で持つ | 数えた |
| F6 | `test/web-static.test.ts` は 213 個。うち新しい殻の節（1908 行〜）が 151 個。`fnSource()` の切り出し 30・ソース文字列への正規表現 約 149。絵を見るテストは無い。CI も無い（`.github/workflows` なし） | 数えた |
| F7 | 静的ファイルは 1 要素の名前だけ配る（`^[A-Za-z0-9_-]+\.(html\|css\|js\|svg\|png\|webmanifest)$`）。**`vendor/` の下・`preact.module.js` のような名前は今は配れない** | `src/web/static.ts` |
| F8 | CSP は `default-src 'self'`。inline の script・style・importmap は書けない。静的ファイルは `no-cache` + ETag（毎回 304 の確認） | `src/web/server.ts` 17・178 行 |
| F9 | 実行時の依存は 3 つ（SDK・discord.js・zod）、dev は 2 つ（@types/node・typescript）（K1 の後は dev 5: typescript・@types/node・playwright-core・preact・htm）。`docs/plan/web-ui.md` は「依存は足さない」「素の HTML + fetch」と決めている | `package.json`・`web-ui.md` §0 |
| F10 | npm 配布は `src/web/static/` を `dist/web/static/` へそのまま写す。checkout の運用はビルドなし | `docs/plan/distribution.md` |
| F11 | `shell.js` は `document.readyState` が loading でなければ読まれた時点で `init` する（defer なので実際は読まれた時点） | `shell.js` 1577 行 |
| F12 | `c-` で始まるクラスは `app.css`・`base.css`・`shell.css` に 1 つも無い | grep |

### 2.2 実際に動かして確かめた事実（リポジトリの外の試し）

| # | 事実 |
|---|---|
| P1 | Preact 11.2.0 + hooks + htm 3.1.1 を 1 要素の名前（`vendor-preact.js` など）で置き、**本体と同じ CSP** を付けた 127.0.0.1 のサーバーから `<script type="module">` で読めた。headless Chromium 145・390×844。CSP 違反 0・エラー 0・表示まで 129 ms |
| P2 | key 付きの一覧で「先頭に 1 行足す + 60 行を書き換える」をしても、同じ key の行は**同じ DOM ノードのまま**。スクロールも飛ばない |
| P3 | htm の `style=` は文字列でもオブジェクトでも CSP の下で効く（Preact が CSSOM で入れる） |
| P4 | DOM の無い Node 24 で 3 つとも `import` でき、hook を使わない部品は関数として呼ぶと vnode が返る → `npm test` で fake DOM なしに試せる |
| P5 | hooks は `from"preact"` という裸の指定を持つので、同梱するときに `./vendor-preact.js` へ書き換えが要る。`sourceMappingURL` のコメントも付いている（消す） |
| P6 | `tailscale serve` の https は HTTP/2 で返る（curl で `ver=2 code=200`）。小さいファイルが増えても 1 本の接続で 304 を確かめられる |
| P7 | この機械の日本語の字は IPA ゴシックだけ。画面写しは実機と字形が違う（配置・余白・重なりは見られる。字の印象は見られない）。幅の収まりは、等幅の字を当てて測る（`npm run ui-shots` の幅の検査） |

大きさ（npm の配布物を量った）: preact 11,970 B（gzip 4,997）+ hooks 3,628 B（gzip 1,589）+ htm 1,207 B（gzip 660）= **16,817 B（gzip 約 7.2 KB）**。今の `shell.js` 1 本（68,968 B）の 1/4。

### 2.3 推測

- 部品へ移すと新しい殻の 151 個のテストの 6〜8 割は書き直しになる（構造・文字列を見ているため）。
- headless Chromium を 1 回走らせる間のメモリは 200〜400 MB（量っていない）。常駐させず、頼んだときだけ動かす。
- 実機で崩れて見える主因は §3 の 1〜4（二段の見出し・入力欄・吹き出しの中の「完了」・目立たない「あなたの番」）。

### 2.4 未確認

- **iOS Safari・ホーム画面の PWA** で ES modules + Preact が同じに動くか（Chromium でしか試していない）。
- iOS Safari は 12.2 以上の見立て（同梱の本体が無条件に `queueMicrotask` を使う。構文は ES5 + import/export。推測・実機は未確認）。
- 11 系: `render` は 2 引数だけ・関数の部品では `ref` はただの prop・`defaultProps` は無い・`createPortal` は本体にある。
- 板（Sheet）は `<dialog>` の `showModal()` に頼る（iOS Safari 15.4 以上の見立て。未確認）。`open` 属性の代わりは書かない（K2 で決めた）。
- Preact 11 系の枯れ具合。npm では 11.0.0 が 2026-09-30、11.2.0（latest）が 2026-11-06。10 系の最新は 10.29.8（2026-08-01）。既知の不具合は調べていない。だめなら 10.29.8 へ下げる（10 系では試していない）。
- オーナーが実機のどこを「破綻」と感じたか（§3 は偽データの画面写しから私が拾ったもの）。
- ライトの絵・古い殻の 4 枚・残りの 40 枚は開いていない（§3.1）。

## 3. 見た目の診断

### 3.1 元にしたもの

撮影の試作（今の `npm run ui-shots` の元）で撮った画面写し 49 枚（本物の createWebServer + 作り物のデータ・headless Chromium。スマホ 390×844・DPR 2、PC 1440×900、タブレット 820×1180。**オーナーの実機ではない**）。撮り直しは `npm run ui-shots -- --out <dir>`（約 3 分半）。

私が開いて見たのは 9 枚: スマホ・ダークの a-list・b-chat-bottom・b-chat-permission・c-hand-over・d-composer-3lines・f-settings・f-knowledge-list、PC・ダークの c-hand-with-chat、タブレット・ダークの b-chat-top。**ライト・古い殻の 4 枚・残りは見ていない。** 親の見立て（重なり・色の欠け・横スクロール・console の error は無い。「壊れている」より「古い部品を新しい配置に置いた」見え方）は、見た 9 枚と合う。

### 3.2 スマホで見えたこと（事実。寸法は絵から読んだ概数）

| # | 画面 | 見えたこと | モック D との差 | 原因（コード） |
|---|---|---|---|---|
| D1 | 会話 | **見出しが二段**。上に殻のバー（場所・右腕）約 52px、下に古い会話の見出し（戻る・アイコン・題・状態・…）約 60px。合わせて約 113px。設定では上の段が「右腕」だけの空のバーになる | 見出しは 1 段 56px | 殻が `chat.js`・`views.js` の見出しをそのまま中に載せている |
| D2 | 会話 | **入力欄が箱の中の箱**。空でも約 3 行ぶん（下の飾り全体で約 135px）。「0 / 1,900」が常に出る。送るは灰色の板（押せないときは無効に見えるだけ） | 高さ 44px・角 22px の 1 行 + accent の送る | `app.css` の入力欄（VS Code 風の欄）のまま |
| D3 | 会話 | 題が長いと placeholder「<題> に送る」が 3 行になり、**上の行が切れる** | 短い決まった文 | placeholder に題を入れている |
| D4 | 会話・右腕 | 返事の吹き出しの中に毎回「> 完了」の行。1 文の返事が 3 行ぶんの高さになる | 吹き出しは本文だけ。手順は外 | 手順の折りたたみを吹き出しの中に置いている |
| D5 | 一覧 | **「あなたの番」が目立たない**。ほかの行と同じ形・件数は薄い字。同じ行が下の群にもう一度出る。副次行「許可・0 分前 …」が右の「許可 08:57」と重複 | warning の枠のカード + その場で答えるボタン | 行の部品を使い回している |
| D6 | 一覧 | 左端が揃わない。見出し 4px・ブランド 12px・点 16px・題 36px | 16px で揃う | 古い行の余白 + 殻の余白の足し算 |
| D7 | 一覧 | 下が二段。「右腕に頼む・訊く」が**入力欄に見える枠**、その下のタスク・リマインド・ほかが左に寄っている。最後の行が枠の上で切れる | 64px の 1 本のバー。中央に accent の右腕 | `.v3-hand-entry` + `.v3-list-foot` の 2 つ |
| D8 | 一覧 | 見出しの右の検索・緑の点・鐘が等間隔で、点がボタンに見える | — | — |
| D9 | 会話 | 表が `|` のまま、引用が `>` のまま出る | — | **CSS ではなく機能の不足**（`ui.js` の parseBlocks）。この設計の外（§10 の 6） |
| D10 | 設定 | 古い画面のまま。プリセットの切り替えが 2 段に折れる | — | `views.js`（§7 の島） |

読み取り: 破綻の中心は**一覧ではなく、会話の画面の中身（`chat.js` の見た目）を古いまま載せたこと**（D1〜D4）。`shell.css` をいくら直しても直らない。だから `chat.js` の見た目は作り直す側に入れる（§7）。

### 3.3 PC・タブレットで見えたこと

| # | 画面 | 見えたこと | モック D との差 | 原因（コード）・直す部品 |
|---|---|---|---|---|
| D11 | PC の会話 | 見出しが二段（場所の帯 + 古い ed-toolbar）。古いボタン（kakeibo-app・Discord・待ちにする・閉じる・会話を新しくする）が横に並び、[閉じる] だけ枠付きで押してあるように見える | 1 段 52px。会話/変更/端末の切り替え + 場所 + 「…」 | `chat.js` の `header`。→ TopBar（操作は「…」の板へ） |
| D12 | PC の会話 | 入力欄の 3 行目が切れる。最後の吹き出しの時刻が入力欄の下に隠れる | 伸びる入力欄 | → Composer・TalkTimeline の下の余白 |
| D13 | PC の一覧 | 行 28px・字 14px 未満の VS Code の密度。見出しは x≒4px、行の題は x≒36px。「あなたの番」の副次行は途中で切れる | 行 36px・「あなたの番」は warning の件数のボタン | `--row`（F3）。→ TopicRow・YourTurn |
| D14 | PC の右腕の列 | 返事ごとに「完了」の行。入力欄は空でも 3 行ぶんで「0 / 1,900」 | 札 + 本文だけの吹き出し + 1 行の入力欄 | D2・D4 と同じ。→ HandPanel は TalkTimeline と Composer の使い回し |
| D15 | PC の会話 | コードの長い行が吹き出しの右端で切れる（横に送れるかは**未確認**） | — | → Bubble の中のコードは横に送れること |
| D16 | タブレット 820 幅 | 会話の見出しが 3 段に折れる（題 / 場所・Discord / ボタン）。場所の帯と合わせて約 135px。右に機械の印だけの細い列（約 60px）が常に立つ | — | D11 と同じ。→ TopBar は折り返さない。右腕の入口は TopBar の 1 つに。右の細い列は右腕の列の物なので K4・K6 で直す（K3 では触らない） |
| D17 | スマホのナレッジ | 一覧と中身が縦に二分され、間に約 110px の空き。上の帯は「右腕」だけ。探す欄が見出しの中 | — | `views.js` の master-detail を殻が上書き（`.v3 .master-detail-phone`）。→ K9（それまでは島） |

親・撮った担当から聞いたが私は絵で見ていないこと: 起動のダイアログの select の字が大きい、ナレッジの本文が markdown を描かない。

### 3.4 部品ごとのまとめ（どの部品がどの差を直すか）

| 部品 | 直す差 | 段 |
|---|---|---|
| TopBar | D1・D8・D11・D16 | K4（D16 の右の細い列は K6 と一緒に） |
| BottomBar | D7 | K3 |
| YourTurn | D5 | K3 |
| TopicList・GroupHead・TopicRow | D6・D13 | K3 |
| Bubble・Steps | D4・D14・D15 | K4 |
| Composer | D2・D3・D12・D14 | K5 |
| PermissionCard・QuestionCard | （崩れは無い。枠の言葉を YourTurn と揃える） | K5 |
| HandPanel | D14 | K6 |
| LegacyPane + K9 | D10・D17 | K4（見出しだけ）・K9 |
| 部品の外（機能） | D9・ナレッジの本文 | §10 の 6 |

### 3.5 オーナーの実機で見えたこと（オーナーが言ったら足す）

（空欄）

## 4. 方式の比較

| 見るところ | A. ライブラリなし（部品ごとの CSS + JS の関数） | B. ビルドなしで小さいライブラリを同梱（Preact + htm） | C. ビルドを入れる（Vite + Preact など） |
|---|---|---|---|
| 古い CSS を切る | ○ 決まりとテストで切る | ○ 同じ（ライブラリでは切れない） | ◎ CSS Modules で名前がぶつからない |
| 手書きの描き直しの不具合 | △ 減らない。部品ごとに差し替えを手で書く | ◎ key 付きの差分に任せる（P2） | ◎ 同じ |
| 今のテスト | △ fake DOM と正規表現のまま増える | ○ 純粋な関数を `import` して試す（P4）。新しい殻の節は書き直し | △ ビルド後の物を試す仕掛けが別に要る |
| 見た目の確認 | ○ 見本のページ + 画面写し | ○ 同じ。見本が部品の関数の呼び出しで書ける | ○ 同じ |
| 配り方（pull して再起動・npm） | ◎ 変わらない | ◎ 変わらない（ファイルが 3 つ増えるだけ。F10） | ✗ 起動のたびのビルドか、成果物の commit が要る |
| N100 への負荷 | ◎ なし | ◎ なし（写すだけ） | △ ビルド・node_modules が増える |
| 移行の大きさ・途中で止められるか | ○ 島ごとに替えられる | ○ 島ごとに替えられる（`render(vnode, 入れ物)`） | ✗ 入口ごと替える。途中で止めにくい |
| 「部品化した設計」への答え | △ 守るのは人の規律。同じ規律が M2 で一度破れた（F1） | ◎ 部品 = 入力を受けて見た目を返す関数、が形として残る | ◎ 同じ |
| 総合 | △ | **◎** | ✗ |

### A. ライブラリなし

- メリット: 依存が増えない。`web-ui.md` の決定を変えない。iOS の未確認が増えない。
- デメリット: 描き直しは手書きのまま（F5）。「部品」が約束事でしかなく、M2 の「shell.css は配置だけ」が 46 クラスの借用になったのと同じ崩れ方をしうる。テストが文字列頼みのまま。
- 実装コスト: 中（B とほぼ同じ量の作り直し + 部品ごとの差し替えの手書き）。
- 運用コスト: 0 円。保守は今と同じ（不具合の型は減らない）。

### B. Preact + htm を同梱（推薦）

- メリット: 上の表。16.8 KB。ビルドなし・CSP そのまま（P1）。島ごとに入れられる。
- デメリット: 前の決定「依存は足さない」を変える（オーナーの OK が要る）。iOS は未確認。古い描き方（`views.js`）と新しい描き方が、移し終えるまで並ぶ。静的 JS に型チェックが無いのは今と同じ。htm は実行時にテンプレートを読む（呼び出し箇所ごとに 1 回。体感に出るとは考えていない: 推測）。
- 実装コスト: 中〜大（§9 の K0〜K8。A との差は同梱のスクリプト 1 本）。
- 運用コスト: 0 円。版を上げるときは `package.json` の版を変えて `npm run vendor-web`、差分を commit（年に数回の想定）。

### C. ビルドを入れる

- メリット: CSS Modules・型・JSX。部品の道具が一番揃う。
- デメリット: 「ビルドせず node で直接実行する」「pull して再起動」の運用と合わない。成果物を commit すれば差分が読めない物がリポジトリに入り、起動時にビルドすれば N100 の起動が遅くなり失敗の種が増える。依存が数百に増える。
- 実装コスト: 大（入口・テスト・配布・起動の手順を全部変える）。
- 運用コスト: 0 円だが、ビルドの面倒を見る手間が続く。

検討して外した物: **Lit / Shadow DOM**（`aria-labelledby` などの id の参照が影の根をまたげない、`base.css` のリセットと reduced-motion が中に届かない、`<dialog>` とフォーカスの扱いが増える）。**@preact/signals**（今の `SA.store` → `refresh` の橋で足りる。足さない）。**htm の standalone 版**（中の Preact が古い 10 系で、版を自分で固定できない）。

## 5. 推薦

**B。** 理由は 3 つ。

1. オーナーの 2 つ目の言葉（部品化した設計で）に、約束事ではなく形で答えられる。A は同じ約束事がすでに一度破れている（F1・F2）。
2. 作り直しの量は A とほぼ同じで、B だけが手書きの差し替えとその不具合を無くす（F5・P2）。
3. 運用を何も変えない（F10・P1・P6）。C の利点（CSS の名前の隔離）は、`c-` の接頭辞とテストで足りる（F12）。

正直な迷い:

- **見た目が良くなるかはライブラリでは決まらない。** 決めるのは §6 の部品の仕様・§7 の CSS の決まり・§8 の画面写し。B を選んでも、ここを飛ばせば同じ結果になる。
- iOS の PWA で未確認（§2.4）。だから K1 で「実機で見本のページを開く」を受け入れ条件に入れ、**だめならそこで A に切り替える**。K0・K2 の成果（画面写し・トークン・部品の CSS・見本）は A でもそのまま使える。
- M0〜M8 を 2 日で作った直後の作り直しになる。同じ速さで進めると同じことが起きるので、各段の受け入れに「画面写しを見た」を入れる。

オーナーがライブラリを断ったら: A。部品の一覧（§6）・CSS（§7）・段（§9）は同じで、K1 の同梱が無くなり、各部品に「差し替えの関数」を手で書く。

## 6. 部品の一覧（推薦案）

決まり:

- 部品は**入力（props）を受けて見た目を返す関数**。`document`・`location`・`SA`・`fetch` に触らない。触るのは入口（`c-app.js`）だけ。
- クラスは `c-<部品>`、中の部位は `c-<部品>-<部位>`、状態は `data-*` か `aria-*` の属性（`is-*` のクラスは使わない）。
- 各モジュールは「見た目の元になる値を作る純粋な関数（モデル）」も export する。テストはまずそれを試す。
- 数値は全部トークン（§7.2）。モック D の値。

| 部品 | ファイル | 入力（props） | 持つ状態 | CSS の要点 |
|---|---|---|---|---|
| Button | `c-atoms.js` / `.css` | kind（primary・accent・secondary・ghost・danger）、size（md 44・sm 36）、icon、label、disabled、busy、reason、onPress(event)（`event.currentTarget` が押した要素） | なし | 高さ `--c-tap`。押せないときは色を薄くするだけでなく `aria-disabled` |
| IconButton | 同 | icon、label（必須。`aria-label`）、badge（札は 9+、名前は 99 まで）、disabled、reason、onPress(event) | なし | 44×44 の当たり |
| Badge | 同 | count、tone（warning・accent・muted） | なし | 0 は出さない。99+ |
| Mark（行頭の印） | 同 | state（turn・running・unread・none） | なし | 8px。turn = warning の塗り、running = accent の輪、unread = accent の塗り。none でも幅は取る |
| Segmented | 同 | items（value は文字列か数。String() で揃えて比べ、onChange には元の値）、value、onChange、label | なし | 折り返さない。入りきらなければ横に送る（D10 の再発を防ぐ） |
| Field | 同 | label、hint、error、children | なし | — |
| Empty / Loading | 同 | text、action | なし | — |
| Sheet（下から出る板） | `c-sheet.js` / `.css` | open、title、onClose、children | 開閉の反映だけ（フォーカスの戻りはブラウザ） | `<dialog>`。スマホは下、PC は中央。safe-area の下 |
| Confirm | 同 | title、target、body、okLabel、danger、onOk、onCancel | なし | 危ない側を primary にしない |
| Toast | 同 | items | なし | `aria-live`。今の `SA.ui.toast` はここへ渡す橋にする |
| TopBar | `c-shell.js` / `.css` | variant（phone・wide。入口が幅で決める）、view（talk・other。none は描かない）、title、status（text と tone: warning・accent・muted）、note（人格の名前）、place（text・movable・reason。text が空でない文字列のときだけ場所として扱う）、views（value: talk・pane。［会話］［端末］を出すときだけ）、hand（turn・unread・null）、menu、compact、controls（右腕のボタンの aria-controls）、on（back・place(opener)・view(value)・menu(opener)・hand(opener)）。モデルは `topModel` | なし | **1 段**。スマホ 56・PC 52（上の safe-area は殻の側）。スマホは 戻る・題（下に状態・場所・人格の 1 行）・「…」・右腕で、場所と［会話］［端末］は「…」の板から。広い幅は 題・状態・人格・場所・［会話］［端末］・「…」で、右腕は出さない（右の列の物。K6）。場所のボタンは名前だけを見せ（読み上げは「場所: 名前」）、動かせないときは `aria-disabled` と理由の title（native の disabled にしない）。狭いときは 人格 → 場所（下限 `--c-top-place-min`）→ 題 の順に縮み、題に下限は持たせない（縮む割合の差で順を作る）。広い幅の見出しは、根の幅が `--c-top-full-min` を切ると compact（場所・［会話］［端末］は帯に出さず「…」の板から。スマホと同じ）。幅を測るのは入口（K4） |
| BottomBar | 同 | variant（phone・wide。入口が幅で決める）、turns、hand（turn・unread・null）、tabs（広い幅の文字のボタン）、on（list・hand(opener)・tab(id)・more(opener)） | なし | スマホは 64px + safe-area の下、広い幅は 44px + safe-area で「タスク」「リマインド」「ほか」。中央の右腕は accent（D7）。スマホは「一覧」「ほか」が中身の幅（下限 `--c-bottom-h`）で、右腕が残りを全部取る（K3a） |
| TopicList | `c-list.js` / `.css` | turns、groups、currentId、filter、onOpen、onNew（その場で答える onAnswer は持たない。許可・拒否は K5） | 群の開閉（localStorage は入口が持つ） | 左端 16px で揃える（D6） |
| YourTurn（あなたの番） | 同 | items（題・種類・何を訊かれているか・時刻） | なし | モック D のとおり、スマホは warning の見出し「あなたの番 n」と枠なしの 2 行の行、PC は件数のボタン 1 つ（押すと次の待ちの話題）。0 件のときは出さない。その場の許可・拒否は持たない（項目を押して会話で答える。K5）（D5） |
| GroupHead | 同 | name、turnCount、running、onNew（群の開閉は作らない） | なし | 36px。[+] は 44 の当たり |
| TopicRow | 同 | id（key）、title、mark、meta（状態の語 1 つ）、time、current | なし | スマホ 44・PC 36。題は 1 行で省く。副次行は持たない。付記（場所の名前など）は 640px 以上では出さない |
| TalkTimeline | `c-talk.js` / `.css` | turns、running、cards、onLoadOlder | 下に付いているか（スクロール） | 新着で下にいるときだけ下へ送る |
| Bubble | 同 | who（owner・agent）、blocks、time、state（sending・failed） | なし | 角 `--c-bubble-r` と話者側の下だけ `--c-bubble-tail`。最大幅 スマホ 80/86%・PC 72/78%。**本文だけ**（D4） |
| Steps（手順） | 同 | steps、open、onToggle | 開閉 | 吹き出しの**外**の下に小さく 1 行。0 件なら出さない |
| RunLine（作業中の 1 行） | 同 | text、elapsed、onStop | なし | — |
| Divider / Notice | 同 | text、tone | なし | — |
| PermissionCard | `c-cards.js` / `.css` | tool、mode、detail、remainSec、canAlways、state、onAllow、onAlways、onDeny | なし（残り時間は入口から） | warning の枠（YourTurn と同じ見た目の言葉）。許可は secondary・拒否は ghost |
| QuestionCard | 同 | question、options、multi、state、onAnswer | 選んだ物 | 同じ枠 |
| CloseCard / MoveCard / ResumeCard | 同 | それぞれの文と 2 つのボタン | なし | 同じ枠（tone だけ違う） |
| Composer | `c-composer.js` / `.css` | placeholder（決まった短い文）、max、busy、disabledReason、onSend | 下書き・行数・IME 中か | 1 行 44px・角 full・伸びて最大 6 行。字数は残りが少ないときだけ。送るは accent（D2・D3） |
| HandPanel（右腕） | `c-hand.js` / `.css` | open、mode（over・side）、turns、running、cards（札）、onClose、onSend | なし | スマホは全面の板、PC は右の列。中身は TalkTimeline + Composer の使い回し |
| HandCard（札） | 同 | title、sub、mark、onOpen | なし | モック D の札 |
| Shell | `c-shell.js` | view、hand、子 | なし | 3 列（PC）/ 1 列（スマホ）の配置だけ |
| LegacyPane（古い画面の入れ物） | `c-shell.js` | 描く関数、tabId | なし | `views.js` が描く場所。中は `legacy-views.css`（§7.4） |

入口 `c-app.js`: `SA.store`（`api.js`。そのまま）を読み、`SA.app.refresh()` が呼ばれたら次の描画の機会に 1 回だけ根を描き直す。経路（hash・履歴）・viewport・キーは K7 までは `shell.js` のまま。

## 7. CSS の方針

### 7.1 層

1. `base.css`（リセットと寸法の目盛り。**触らない**。生成ページと共有）
2. `tokens.css`（色・動き・重なり。**残す**。色は今のままでモック D と一致している）
3. `c-*.css`（部品。8 ファイル: atoms・shell・list・talk・cards・composer・hand・sheet）
4. `legacy-views.css`（「ほか」の画面のための古い見た目。§7.4。移し終えたら消す）

新しい殻は **`app.css` を読まない**（K8 から）。`shell.css` は K8 で消える。

### 7.2 トークン

- 色・動き・重なり: 今の `tokens.css` をそのまま使う。
- 寸法: 新しい殻は古い殻の寸法（`--row`・`--titlebar-h`・`--tabbar-h` など）を**使わない**。`tokens.css` の末尾に `--c-` で始まる寸法を足した（K2）。既定はスマホ・指の端末で、PC の値は `@media (min-width: 640px) and (hover: hover) and (pointer: fine)` で上書きする（幅だけだと指のタブレットで行が 36px・入力欄の字が 14px になる）。

| 名前 | 既定 | PC | 使う所 |
|---|---|---|---|
| `--c-tap` | 44 | — | 当たりの下限・md の高さ |
| `--c-bar-h` | 56 | 52 | 見出し（K4）・板の見出し |
| `--c-bottom-h` | 64 | — | 下のバー（K3） |
| `--c-row-h` | 44 | 36 | 一覧の行（K3） |
| `--c-gutter` | 16 | — | 左右の余白 |
| `--c-list-w` | 280 | — | PC の一覧の幅（K3） |
| `--c-hand-w` | 360 | — | PC の右腕の幅（K6） |
| `--c-bubble-r` | 14 | — | 吹き出しの角（K4。決定） |
| `--c-bubble-tail` | 4 | — | 吹き出しのしっぽ側の角（K4） |
| `--c-card-r` | 10 | — | カードの角（K5。決定） |
| `--c-btn-sm-h` | 36 | — | Button・IconButton の sm |
| `--c-round-r` | 22 | 8 | accent のボタンの角（スマホは丸） |
| `--c-icon` / `--c-icon-sm` | 20 / 16 | — | アイコン |
| `--c-mark` / `--c-mark-ring` | 8 / 2 | — | 印・作業中の輪の太さ |
| `--c-badge-h` / `--c-badge-pad` | 20 / 6 | — | 件数の高さ・最小の幅 / 左右 |
| `--c-seg-h` / `--c-seg-pad` | 44 / 3 | 36 / — | 切り替えの入れ物の高さ / 内側の余白 |
| `--c-toast-w` | 360 | — | 知らせの最大の幅（PC） |
| `--c-spin` | 800ms | — | スピナーの 1 周 |
| `--c-font-body` | `--font-base`（16） | `--font-sm`（14） | 本文・md のボタン・入力欄の字（新しい字の大きさではなく別名） |
| `--c-row-indent` | 28 | — | 群の中の行・完了の見出しの左（K3） |
| `--c-list-gap` | 10 | — | 行の印と題の間・「あなたの番」の項目の上下・PC の件数のボタンの外の余白（K3） |
| `--c-top-full-min` | 520 | — | 広い幅の見出しが場所と［会話］［端末］を帯に出せる根の幅の下限。切ると compact（K4） |
| `--c-top-place-min` | 96 | — | 見出しの場所のボタンの幅の下限（K4） |

- 板が下か中央かは寸法ではなく置き方なので、今の殻と同じ幅だけ（`@media (max-width: 639px)`）で `c-sheet.css` に書く。
- 古い寸法のトークンは M8b で古い殻と一緒に消す。
- 字の大きさは今の目盛り（12・14・16）のまま。モック D の 13・15・17 は最寄りへ丸める（スマホの本文 16、PC の本文 14、副次 12）。新しい字のトークンは足さない（§10 の 3）。

### 7.3 見張るテスト（決まりを人の規律にしない）

- `c-*.css` のセレクタは必ず `.c-` で始まる（例外は `:root` と `@media`）。色の値（`#`・`rgb(`・`hsl(`）を書かない。`--c-` 以外の寸法のトークンと古い寸法のトークンを使わない。
- `c-*.js` が書くクラス名は `c-` で始まる物だけ。`c-app.js` 以外は `document`・`window`・`SA`・`fetch` を書かない。
- `c-*.css` にあって `c-*.js` に出てこないクラス、その逆、が無い。
- K8 以降: `v3.html` の `<link>` に `app.css`・`shell.css` が無い。
- 部品は `style` の prop と `dangerouslySetInnerHTML` を使わない（Preact は style を `style.cssText` で入れるので CSP では止まらない。11 系は数値に px を付けない）。動く値は `data-*` と CSS、どうしても要るときは入口が `style.setProperty` で CSS の変数を入れる。
- `document`・`window` に触ってよいのは入口（`c-app.js` と見本の `c-gallery.js`）だけ。
- `c-*.css` の `var()` は `--c-*` か許可リスト（`test/web-components.test.ts` の `ALLOWED_VARS`）だけ。許可リストは base.css の目盛り（`--space-*`・`--font-xs`〜`--font-base`・`--leading-*`・`--weight-*`・`--radius-*`・`--border-width`・`--ring-width`・`--dialog-max`・`--container-max`）、tokens.css の色（`--text-secondary` を含む）、動き・重なり・字（`--dur-*`・`--ease-out`・`--z-toast`・`--font-mono`）。ここに無い物（`--tap`・`--row`・`--icon-size`・`--font-lg` 以上・古い殻の寸法・`--kb`・`--vvh`）は落ちる。足すときはテストの許可リストとこの行を一緒に直す。

### 7.4 `chat.js`・`views.js` の中の見た目

| 物 | 扱い | 理由 |
|---|---|---|
| `chat.js` の描画（見出し・吹き出し・手順・カード・入力欄） | **作り直す**（K4・K5）。`chat.js` には送信・状態などの処理だけを残す | 破綻の中心（D1〜D4）。一番よく見る所 |
| `views.js`（タスク・リマインド・知識・メモリ・GitHub・使用量・設定） | **当面は古いままの島**。LegacyPane の中に描かせ、見出しだけ TopBar に替える。flip の後に 1 画面 1 PR で移す（K9） | 129 クラス・1,988 行。見る回数が少ない。先に移すと主経路が遅れる |
| `legacy-views.css` | `app.css` から、`views.js`・`ui.js` が使う規則だけを**写して**作る（K8）。`app.css` は触らず、古い殻だけが読み、M8b で消す | 古い殻を壊さない。写しの二重管理は M8b までの間だけ（古い殻は凍結中） |
| `ui.js` の toast・confirm | 中身を新しい Toast・Confirm に渡す橋にする（K6） | 見た目を 1 つにする |

古い殻（`/`・`index.html`・`sidebar.js`・`workbench.js`・`app.css`）は**どの段でも 1 文字も変えない**。`chat.js` に足すのは先頭の 1 つの分岐だけ（新しい部品が登録されていればそちらへ渡す。古い殻は部品を読まないので通らない）。

## 8. ライブラリ・道具

| 名前 | 版 | 大きさ | ライセンス | 置き場所 | 何のため |
|---|---|---|---|---|---|
| preact | 11.2.0（exact） | 11,970 B（gzip 4,997） | MIT | devDependencies + `src/web/static/vendor-preact.js`（commit する） | 部品の描画・key 付きの差分 |
| preact/hooks | 同じ包み | 3,628 B（gzip 1,589） | MIT | `src/web/static/vendor-preact-hooks.js`（`from"preact"` を書き換え） | 入力欄の下書き・行数、板のフォーカス |
| htm | 3.1.1（exact） | 1,207 B（gzip 660） | Apache-2.0 | devDependencies + `src/web/static/vendor-htm.js` | ビルドなしで HTML に近い形で書く（eval を使わない。CSP のまま） |
| playwright-core | 1.58.2（exact） | 9.3 MB（node_modules の中だけ。配布物には入らない） | Apache-2.0 | devDependencies | 画面写し。**この機械に入っている Chromium（rev 1208）に合う版**。ブラウザは落とさない |
| （入れない）pixelmatch 8.0.0 + pngjs 7.0.0 | — | 37 KB + α | ISC・MIT | — | 画像の差分。まずは 2 枚をブラウザの canvas に描いて違う画素を数える方法を試す（依存なし。**未確認**）。だめなら足す |
| （入れない）vite・esbuild・lit・@preact/signals・tailwind | — | — | — | — | §4 の理由 |

- 実行時の依存（`dependencies`）は **3 つのまま**。増えるのは dev の 3 つと、commit する 3 ファイル。
- 置き方は 1 要素の名前（`vendor-*.js`）。**サーバーは変えない**（F7。`vendor/` の下に置くなら `static.ts` の変更と再起動が要るのでやらない）。
- 同梱は `make-icons` と同じ型: `scripts/vendor-web.ts` と `npm run vendor-web` が `node_modules` から写し、裸の指定を書き換え、`sourceMappingURL` を消し、先頭に名前・版・ライセンスのコメントを付ける。`npm test` が「commit した物 = 作り直した物」を確かめる。
- ライセンスの文は `THIRD_PARTY_LICENSES.md`（リポジトリの根。npm の `files` にも入れる）。`static/` には置かない（配れる名前だけ、のテストがある）。
- 外部サービスは増えない。**運用コストは 0 円。**
- 今すでに用意されている物（オーナーの 3 つ目の問いへの答え）: **ライブラリは何も用意していない**（依存は 3 + 2 のまま）（K1 の後は実行時 3 のまま・dev 5）。Chromium だけは `~/.cache/ms-playwright/` にある。

## 9. 段取り（1 PR = 1 論点。どの段でも `/` の古い殻は動く）

段の名前は仮に K0〜K9。大きさは推測（小 = 半日、中 = 1 日、大 = 2 日）。

**見た目の確かめは毎段の受け入れに入れる**: K0 で撮影を `scripts/ui-shots.ts` として repo に入れ（`playwright-core` は devDependency）、K1 以降の各 PR は (a) 変えた画面の「前と後」の絵をスマホ・PC（K4 からはタブレットも）で付け、(b) 親か pr-reviewer が絵を開いて、その段の受け入れ条件と §3 の該当する D 番号が消えたことを確かめる。絵を見ていない PR は通さない。

| 段 | 論点 | オーナーに見える物 | 大きさ |
|---|---|---|---|
| K0 | 画面写しの仕掛け | なし（PR に今の絵が付く） | 小 |
| K1 | 同梱の仕掛け + 見本のページの骨 | `/static/gallery.html` が開く | 小 |
| K2 | 寸法のトークン + 小さい部品 + 板 | 見本にボタン・印・切り替え・板が並ぶ | 中 |
| K3 | 一覧（あなたの番・群・行・下のバー） | v3 の一覧がモック D の形に | 中 |
| K4 | 会話の見出しを 1 段に + 吹き出し・手順・作業中 | v3 の会話の上と本文 | 大 |
| K5 | 入力欄 + 許可・質問などのカード | v3 の会話の下とカード | 大 |
| K6 | 右腕（板・札）+ toast・confirm の橋 | v3 の右腕 | 中 |
| — | **ここで実機で見る → PR #383（flip）を main に合わせ直して出す** | `/` が新しい殻に | — |
| K7 | 殻の根を 1 つに（経路・viewport・キーを `shell.js` から移す） | 変わらない | 大 |
| K8 | 新しい殻から `app.css`・`shell.css` を外す（`legacy-views.css`） | 変わらない | 中 |
| M8b | 古い殻を消す（`index.html`→classic・`sidebar.js`・`workbench.js`・`app.css`・古い寸法のトークン） | `/static/classic.html` が無くなる | 中 |
| K9 | 「ほか」の画面を 1 画面 1 PR で部品へ（設定 → タスク → リマインド → 知識 → メモリ → GitHub → 使用量） | 各画面 | 中 ×7 |
| M9 | 「変更」の見え方。最初から部品で作る | 新しい画面 | 既存の計画どおり |

順の理由: K3 を先にするのは、一覧が一番小さく、仕組み（島・橋・テストの型）を試せるから。破綻の中心は K4・K5 なので、K3 が 1 日を超えそうなら K4 を先にしてよい（implementer ではなく親が決める）。

### 各段の中身と受け入れ条件（implementer に渡す粒度）

**K0 画面写し**
- **済（#386）。** やること: `scripts/ui-shots.ts` と `npm run ui-shots -- --out <dir> [--only <名前>]` を作る。偽データの DB を一時ディレクトリに作り、本体の Web サーバーを 127.0.0.1 の空きポートで立て、スマホ 390×844・PC 1440×900・タブレット 820×1180、ダーク・ライトで決まった画面を撮り、**必ずサーバーとブラウザを閉じる**。`playwright-core` 1.58.2 を devDependencies に。
- 受け入れ: (1) 走らせると PNG が `--out` に出て、終わった後 `ss -ltnp` に掴んだポートが残らない。(2) リポジトリの中に画像・DB を書かない。(3) 偽データに実在の名前・ID・トークンが無い。(4) `npm test` は Chromium を起動しない。(5) Chromium が無い機械では理由を出して exit 1。(6) Discord・Claude・GitHub に出ない。

**K1 同梱 + 見本の骨**
- やること: `scripts/vendor-web.ts`・`npm run vendor-web`、`vendor-preact.js`・`vendor-preact-hooks.js`・`vendor-htm.js`、まとめの `c-lib.js`（`h`・`render`・`html`・使う hook だけを出す）、`gallery.html` + `c-gallery.js`（見出し・説明・押すと数が増えるボタンだけ）、`THIRD_PARTY_LICENSES.md`、`docs/plan/web-ui.md` の「依存は足さない」の書き換え。
- 受け入れ: (1) `npm test` が「commit した vendor = 作り直した物」を確かめる。(2) vendor の 3 つに裸の指定（`from"preact"`）・`sourceMappingURL`・`eval`・`new Function` が無い。(3) `gallery.html` に inline の script・style が無い。(4) `ui-shots --only gallery` の絵に見出しが出て、ページのエラーと CSP 違反が 0。(5) `package.json` の `dependencies` は 3 つのまま。(6) **オーナーが実機の Safari で `/static/gallery.html` を開いて見出しが出る**（出なければここで A へ切り替える）。ホーム画面の PWA は start_url が `/` で `gallery.html` への入口が無いので、K1 では実機の Safari で開く。PWA（standalone）での確かめは、新しい殻が部品を読む段（K3）から。(7) `/` と `/static/v3.html` は 1 バイトも変わらない。

**K2 トークン + 小さい部品 + 板**（済。#391）
- やること: `tokens.css` に `--c-*`、`c-atoms.js/.css`、`c-sheet.js/.css`、§7.3 の見張りのテスト、見本に全状態。
- 受け入れ: (1) §7.3 のテストが通る。(2) 各部品のモデルの関数を `import` して試すテストがある（fake DOM・`fnSource` を使わない）。(3) 見本の絵（スマホ・PC × ダーク・ライト）で、指の端末で 44px・PC（hover と fine）で 36px に満たない押せる物が無い。(4) Segmented は 6 項目でも折り返さない。(5) `v3.html` は変わらない。

**K3 一覧**（K3 済。#393: 一覧と下のバーの部品 `c-list`・`c-shell` とモデルのテスト・見本の節。#395: 本番の `v3.html` への載せ替え。K3b は「入口と一覧」（K3b-1）と「下のバーと試し用の manifest」（K3b-2）の 2 本に割った。PR ごとに差と前後の絵が 1 つになり、危ない所（一覧はテストの書き直しと使い回し・フォーカス、バーは右腕のフォーカスの戻り・末尾と safe-area・幅）が別だから）
- やること: `c-list.js/.css`・BottomBar。`topics.js` の `rowParts`・`turnParts`・`reconcile`・`fillRow`・`createRow`・`updateRow` を消し、描画を部品へ渡す（`load`・`schedule`・`find`・`counts`・`setFilter`・`setCurrent` は残す）。`v3.html` の `.v3-hand-entry`・`.v3-list-foot` を BottomBar に替える。`c-app.js` は `shell.js` より前に読む（F11）。
  - 形（K3b-1。K4〜K6 も同じ形を使う: 古い JS が状態を持ち、入口へ押し込む）:
    ```
    topics.js（読む・polling・状態）──▶ SA.list.draw(state) ─▶ c-app.js（入口）─▶ listModel(state) ─▶ render(TopicList)
    shell.js（画面の切り替え・右腕）──▶ SA.list.drawBar(bar) ─▶ c-app.js ─▶ bottomModel(bar) ─▶ render(BottomBar)
    ```
    状態（`data`・`failed`・`filter`・`current`・`doneGroup`・`dataDone`・「ほかのプロジェクト」の開閉）は `topics.js` に残し、部品と入口は状態を持たない（hook を使わない。`render()` の直後に DOM が出来ている前提を保つ）。見た目の判断は `c-list.js` の `listModel`。`document`・`window`・`SA` に触る `c-*.js` は入口 `c-app.js` だけ（見本の `c-gallery.js` は別）。
  - `SA.list`（`c-app.js`。K3b-1 の分。`#c-list-root` が無いページでは作らない）:

    | 名前 | 動き |
    |---|---|
    | `draw(state)` → boolean | `listModel(state)` を作り `TopicList`（`compact` は PC の式）を `#c-list-root` へ描く。前後で一覧の位置と、一覧の中のフォーカスを保つ（フォーカスのあった物が消えたら同じ話題の群の中の行、無ければ一覧の根）。例外は握って `console.error` し false |
    | `focusRow(id)` → boolean | その話題の行のうち `data-mark` の付いた物（群の中の行）を先に、無ければ「あなたの番」の行にフォーカス |
    | `focusList()` | 一覧の根（`tabindex="-1"` の `.c-list`）にフォーカス |
    | `scrollTop()`・`setScrollTop(n)` | 一覧の根の位置を読む・書く |
    | `drawBar(bar)` → boolean | `bar` は `{ turns, hand, tabs, on }`。形（スマホか広い幅か）は入口が決める。`#c-bottom-root` が無ければ覚えるだけで true。例外は握って false |
    | `focusHand()` → boolean | スマホのバーの右腕のボタンにフォーカス。無ければ false |

    `shell.js` は起動のときに 1 回と右腕の印を描くたびに `drawBar` を呼び、false なら件数・印・タブの無い形で 1 回だけ描き直す。

    鍵: `#c-list-root` の `keydown` で、行（`button[data-topic]`）の上の ↑↓・Home・End を `listKey` で動かす。修飾キー（Alt・Ctrl・Meta・Shift）付きは素通し。
- 受け入れ（K3b で確かめられる形に書き直した。その場の許可・拒否は K5 へ移した）:
  - 一覧（K3b-1）: (1) `npm run check`・`npm test`・`npm run ui-shots` が通り、`console.log` が空。(2) 「あなたの番」は 1 件以上のときだけ出る。同じ話題は下の群にも 1 行で出て、その行は副次の行を持たない。(3) 「あなたの番」の項目を押すとその話題の会話が開く（PC の件数のボタンは次の待ちの話題）。(4) 見出し・「プロジェクト」・群の名前・「あなたの番」の印の左端が 16px、群の中の行の印が全部 28px（2 段）。(5) 行・完了の見出し・[+] の当たりが指で 44px・PC で 36px 以上。(6) 一覧が更新されても、開いている完了・スクロールの位置・フォーカスが残り、行の要素は使い回される。(7) ↑↓・Home・End、Esc、検索、[+]、完了、「ほかのプロジェクト」が今と同じに動く（違うのは、絞り込み中は「ほかのプロジェクト」を閉じられない・修飾キー付きは奪わない、の 2 つ）。(8) 仮名が全角の等幅の字でも、行の右の語・時刻・「あなたの番」の種類の語が省かれず、題が全角 5 字以上残る（390・375・タブレット・PC）。(9) 古い CSS が一覧に漏れていない。(10) `/` の絵が前後で同じ。
  - 下のバー（K3b-2）: (1) 同じく 3 つが通る。(2) スマホの下は 1 段のバー（一覧・右腕・ほか）で 64px + safe-area。最後の行がバーに隠れない。広い幅は文字の 3 つ（タスク・リマインド・ほか）で 44px。(3) バーの当たりが指で 44px・PC で 36px 以上。(4) 等幅の字・件数「99+」・右腕に印の形でも、バーの文が省かれない。(5) 最初の応答の前から、件数・印の無い形のバーが出る。(6) 描き直しても右腕のボタンと「ほか」は同じ要素で、右腕・「ほか」の板を閉じた後のフォーカスがそこへ戻る。(7) スマホの「ほか」の板の先頭にタスク・リマインド（広い幅には無い）。スマホの「一覧」で一覧が先頭へ戻る。(8) バーが描けなければ件数・印・タブの無い形で 1 回だけ描き直す。(9) 入口が読めないときは 1 文と [ページを読み直す] が出て、下のバーは出ない。(10) 古い CSS がバーに漏れていない。(11) `/` の絵が前後で同じ。(12) 試し用の manifest が配られ、`v3.html` がそれを指す。

- K3b への申し送り（K3a のレビュー）:
  - 入口は `/api/topics` の応答のうち `turnIds` が配列だと確かめた物だけを `data` に渡す（部品の側も配列でなければ空とみなす）。→ 受けた: `topics.js` の `load` の 4 つの確かめをそのまま残し、テスト（`turnIds` が配列でない応答は失敗の表示で前の `data` が残る）を足した。
  - `isUnread` は `(channelId, last)` の形（`ch:` を外した ID）に入口で合わせる（今の `store.isUnread({ id, last })` とは形が違う）。→ 受けた: `topics.js` の `IS_UNREAD`（1 回だけ作る）。
  - 同じ `data-topic` が「あなたの番」（`c-turn`）と群の行（`c-row[data-mark]`）の両方に出るので、描き直しの後にフォーカスを戻すときは `data-mark` の付いた行を先に探す。→ 受けた: `SA.list.focusRow` と `draw` の描き直しの前後（`npm run ui-shots` の「フォーカスと位置」で見る）。
  - ↑↓・Home・End でフォーカスを動かすのは入口（部品は `listKey` で行き先の番号を返すだけ）。→ 受けた: `c-app.js` の `keydown`。
  - 群の `section[aria-label]` が読み上げのランドマーク（region）になる事を実機の VoiceOver で確かめる。→ 実機の手順に入れた: 実機の VoiceOver のローターの「ランドマーク」に群の名前（プロジェクト名・General）が並ぶ事を見て、多すぎて邪魔なら `section` の `aria-label` を外すかを決める。未確認のまま。
  - `turnFrom`（K3b-1 のレビュー）: PC の「あなたの番 N」のボタンの次の話題は、`topics.js` の `turnFrom`（一覧から最後に開いた話題。`setCurrent` で開いた話題にも追従する）が `turnIds` に在ればその次、無ければ `current` の次。右腕は列 2 に開かず `current` にならないので、`current` だけでは右腕が先頭のとき先へ進まない。
  - `npm run ui-shots` の一覧の検査（当たり・左端・使い回し・フォーカスと位置・鍵・古い CSS の漏れ・幅）は `npm test` では走らない。一覧・入口に触る PR は、マージの前に `npm run ui-shots` を回す。→ 受けた: K3b-2 の PR でも回し、本文に結果を書いた。
  - 入口（`c-app.js`）が読めないときに `#c-list-root` に出す 1 文は、余白の無い裸の `p`。K3b-2 で下のバーも入口が描くようになるので、そのときの出し方と一緒に直す。→ 受けた: 1 文と [ページを読み直す]（`.v3-empty`）。下のバーの代わりは作らない（一覧が無いので口だけ残しても行ける先が少なく、二重の描き方を入れ替えまで持たない）。
- K4 への申し送り: 下のバーの右腕のボタンに `aria-controls` が無い（古い口には在った）。TopBar の右腕の口を作るときに、付けるかを一緒に決める。→ 受けた: BottomBar と TopBar の `controls`（空でない文字列のときだけ `aria-controls`。`aria-expanded` は付けない）。値を渡すのは入口で、本番に載せる PR で。→ 済（K4 の本番）: 入口が下のバーと見出しの両方に `controls`（右腕の入れ物 `v3-hand`）を渡す
- K4 への申し送り: 絞り込み欄の左端を一覧の見出しの段と揃える。→ 済（K4 の本番）: `.v3-search` の左右の余白を `--c-gutter`（16px）に
- K4 以降への申し送り: 広い幅のバーは高さ 44 に sm のボタンの当たり 44 がちょうど入る作りなので、バーに枠・上下の余白を足さない（足すと列がずれる。上の線も枠でなく内側の影にしてある。`npm run ui-shots` のバーの検査が捕まえる）。
- 下のバーが `position: fixed`・`absolute` で一覧に重ならない事は、`c-shell.css` の見張り（`test/web-components.test.ts`）と、`npm run ui-shots` の「最後の行がバーに隠れない」（ダークのスマホ・タブレット）で見ている。

**K4 会話の見出し + 吹き出し**
- やること: TopBar（1 段）、`c-talk.js/.css`。`chat.js` の `render` の先頭に、部品が登録されていればそちらへ渡す分岐を 1 つ足す。`chat.js` の `header`・`frameHeader`・`bubbleRow`・`renderTurn`・`renderRunning`・`stepsList` に当たる物を部品で作る（古い関数は古い殻のために残す）。
- 受け入れ: (1) スマホの会話で、画面の上から本文の始まりまでが 56px + safe-area（今は約 113px）。(2) 戻る・題・状態・場所・「…」・右腕が 1 段に入り、題は 1 行で省かれる。(3) 吹き出しの中に「完了」の行が無い。手順は吹き出しの外の 1 行で、0 件なら出ない。(4) 1 文の返事の吹き出しの高さが 1 行ぶん + 余白。(5) 400 字の URL が吹き出しからはみ出さない。(6) 下に付いているときだけ新着で下へ送り、上を読んでいるときは動かさない。(7) 820 幅と PC で見出しが 1 段のまま折り返さない。待ちにする・閉じる・会話を新しくする・Discord は「…」の板の中。(8) コードの長い行は吹き出しの中で横に送れる。(9) 入力欄・カードはこの段では古いまま（混ざって見えることを PR に書く）。(10) `/` は変わらない。
- 進み: 見出しの部品（`c-shell.js` の TopBar・`topModel`、BottomBar の `controls`）と見本の節「見出し（TopBar）」（スマホ 3・広い幅 5・compact 2。`npm run ui-shots` が見本の名前・高さ・1 段・はみ出し・省き・縮む順・題と状態の間・場所のボタンの幅・入れ物の幅を見る）は済み。本番の見出しも済（#398）。吹き出し（`c-talk`）はまだ（#399）。
- 本番の見出しの形（#398）:
  - `v3.html` の列 2 の上は `#c-top-root` だけ（古い帯 `#v3-bar`・場所のボタン・［会話］［端末］・上の［右腕］は消した）。入口 `c-app.js` の口 `SA.top` は 3 つ: `draw(state)`（描けたか。描く前に見出しの中に在った焦点のボタンが消えたら「…」→「一覧へ」→ 最初のボタンへ）、`focus(act)`（back・place・menu・hand）、`compact()`（今の列の幅なら compact か。測るだけで覚えない・描かない。スマホは false、測れなければ null）
  - state の欄は view（none・talk・other）・title・status・note・place・views・hand・compact・menu・controls・on。作るのは `shell.js` の `topState()`。会話のチャンネルの題・状態・人格の札・「…」の行は `chat.js` の `SA.chat.head(channelId)`（DOM を作らない。古い見出しの […] と同じ行の関数を使う）
  - ほかの画面（設定・ナレッジなど）は `views.js` の `toolbar()` が、入口が在るときは題と戻るを作らず、添え物と操作の段だけを返す（どちらも空なら隠す）。`chat.js` の `render` は入口が在るとき列 2 の見出しを作らない。右腕の列（`frame`）は今の見出しのまま
  - 「…」の板は今の `#v3-sheet`（古い見た目のまま）。閉じてすぐ同じ板を開き直したとき、後から届いた `close` が新しい開き手を消さないよう、板が開いていれば受け手は何もしない
  - `.c-top` は自分で字の大きさと行の高さを持つ（`.c-bottom`・`.c-list` と同じく、親の `.v3` の字に頼らない）
- 設計との違い（#398）:
  1. 一覧の見出し（銘・検索・点・鐘）は K4 に入れず、別の issue にする
  2. 上の safe-area は殻（`.v3` の上の余白）が持つ。TopBar は持たない
  3. スマホの場所を変える・［会話］［端末］は「…」の板の中
  4. 広い幅の右腕の口は右の列のまま（K6 で作り直す）
  5. 見出しに出さなくなった札: プロジェクトのセッションの札（許可のモード）・ページの名前の札・Claude Code の回る印。ページ・Discord・RC は「…」の板に残る
  6. 広い幅でも会話の列が `--c-top-full-min` を切るときは compact（場所と切り替えを「…」の板へ）。決めるのは `shell.js` の `fitTop()`（値は `S.topCompact`）で、入口は列の幅を測るだけ。測り直すのは窓の大きさ・右腕の開閉（`applyHand` の最後）・スマホの境・板を閉じた時。重ねた右腕・板が開いている間は測らない
  7. 測れるまでは compact（`S.topCompact` の初めが true。`compact()` が null のときも compact）
  8. 新しい殻のページの h1 は TopBar の題の 1 つ。右腕の列の見出しは h2。何も開いていない所には h1 が無い（一覧の見出しの issue で決める）
  9. 「状態」の見出しの title（更新の間隔）は新しい殻では出ない
- 確かめ: `npm run ui-shots` の段 t（ダークのスマホ・タブレット・PC。絵は `b-top-*`）が、本番の見出しの 1 段・高さ・当たり・h1・長い題・「…」と場所の板のフォーカスの戻り・右腕の `aria-controls`・compact の決まり（PC は幅 1100・800 に変えて戻す）・focus の輪・古い CSS の漏れを見る。`--only b-top` で見出しの検査だけを回せる

**K5 入力欄 + カード**
- やること: `c-composer.js/.css`、`c-cards.js/.css`。`chat.js` の `composer`・`closeCard`・`moveCard`・`continueButton` と、`views.js` の許可・質問のカードに当たる物を部品で作る。送信・許可の処理は今の関数を呼ぶ。
- 受け入れ: (0) 一覧の中で許可・拒否に答えられる（K3 から移した。`/api/topics` に許可の要求の id が無いので、サーバーの変更は別 issue）。(1) 空の入力欄は高さ 44px の 1 行で、6 行まで伸び、それ以上は中で送る。(2) placeholder は題を含まない決まった短い文で、1 行に収まる。(3) 字数は残り 200 字を切るまで出ない。(4) 送るは 44px の当たりで、空のとき `aria-disabled`、IME の確定の Enter で送らない（今の `bindSendKeys` と同じ振る舞いをモデルのテストで）。(5) 許可・質問・閉じる・移すのカードが同じ枠で、許可は secondary・拒否は ghost。(6) キーボードが出ても入力欄が見える（今の `fitViewport` をそのまま使う。実機はオーナー）。(7) 最後の吹き出しの時刻が入力欄に隠れない（スマホ・PC の絵で）。(8) `/` は変わらない。

**K6 右腕**
- やること: `c-hand.js/.css`。中身は TalkTimeline + Composer の使い回し。`ui.js` の `toast`・`confirm` を新しい部品へ渡す橋に。
- 受け入れ: (1) 下のバーの右腕を押すと、どの画面からも板が開く。(2) 開いて閉じるとフォーカスが押した所へ戻る。(3) 札の [開く] でその話題へ行く。(4) PC（1024px 以上）では右の列。(5) toast・confirm の見た目が 1 種類。
- K2 からの申し送り: 板の中に入力欄を置く画面で、iOS のキーボードが出たときに板が持ち上がるか（`.c-sheet` は `app.css` の `dialog` の `--vvh`・`--kb` を使っていない）。
- K2 からの申し送り: 知らせの入れ物（`role="status"`・`role="alert"`）は暗黙に atomic なので、足すたびに全部を読み直す見立て。読み上げで確かめて決める。

**flip（#383）**: K6 の後、オーナーが実機で一覧 → 会話 → 送る → 許可に答える → 右腕、を通して見てから。#383 は main に合わせ直す（中身は変えない）。

**K7 根を 1 つに**・**K8 `app.css` を外す**・**K9**: 受け入れは「画面写しが前と同じ（差が決めた割合より小さい）」を主にする。K8 は `v3.html` の `<link>` に `app.css`・`shell.css` が無いこと、「ほか」の 7 画面の絵が前と同じこと。

### 積んでいる issue / PR との関係

| 物 | 今 | この設計での扱い |
|---|---|---|
| PR #383（M8 flip） | open | **止める**。K6 の後に合わせ直す |
| #381（M8）・#349（Web UI の作り直し） | open | #349 の下に K0〜K9 の issue を足す。#381 は flip まで開けたまま |
| M8b | 未着手 | K8 の後。消す物がはっきりするので楽になる |
| M9（変更の見え方） | 未着手 | flip の後。最初から部品で |
| #342〜#348（引き継ぎの束） | open | 関係なし。DB を触らないのでぶつからない |
| `docs/design/WEB-UI-GUIDELINES.md` | 方針 A（VS Code 風の密度）のまま | K2 で改訂（§10 の 3 の答えを反映） |

## 10. 決定事項と未決事項

### 設計として決めたこと（変えたければ言ってください）

- 入口は増やさない。`v3.html` の中を島ごとに替える（3 つ目の殻は作らない）。
- light DOM。クラスの接頭辞は `c-`。ファイルは 1 要素の名前。サーバーは変えない。
- `api.js`（`SA.store`・ポーリング）はそのまま。signals は入れない。
- 画面写しの元の絵は commit しない（機械で字が違う。P7）。PR ごとに前と後を撮って比べる。
- `npm test` は Chromium を起動しない。画面写しは頼んだときだけ。
- 古い殻は凍結。`app.css` は触らない。

### オーナーが決めたこと（2026-11-16）

| # | 決めること | 決定 |
|---|---|---|
| 1 | ライブラリを足すか（「依存は足さない」を変える。実行時の依存は 3 つのまま、commit するファイルが 3 つ・16.8 KB 増える） | **足す。Preact 11.2.0 + htm 3.1.1**。K1 の実機（iOS の PWA）でだめなら A（ライブラリなし）で同じ段 |
| 2 | flip（PR #383）を止めて、主経路を作り直してから出す | **止める**。K6 の後、実機で見てから |
| 3 | モック D と GUIDELINES が食い違う所 | **形と色（吹き出しの角・丸い入力欄・accent の送る・高さ 56/64/44/36）はモック D を正にして GUIDELINES を直す。字の大きさは今の 12・14・16 のまま丸める** |
| 4 | `playwright-core` を devDependencies に足す | **足した**（#386） |
| 5 | 「ほか」の画面（設定・知識など）は古い見た目のまま flip してよいか | **よい**。K9 で順に移す |
| 6 | 表・引用が記号のまま出る（D9） | **この作り直しに入れない。別の issue（#389）** |

### 未決で、オーナー以外が決めること

| 物 | 誰が |
|---|---|
| K3 と K4 の順（一覧が先か会話が先か） | 親（K2 の後の進み具合で） |
| 画像の差分を canvas でやるか pixelmatch を足すか | K0 の implementer が試して、親が決める |
| Preact を 11 のままにするか 10 へ下げるか | K1 の実機の結果で親が決める |
| §3.5（オーナーの実機で見えたこと）を受けた段の足し引き | spec-writer（オーナーが言ったら） |
