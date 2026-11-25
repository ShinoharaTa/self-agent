# 右腕を一覧の一番上の行にして、ほかの話題と同じに使う 設計（#514）

状態: 設計は確定（2026-11-26。オーナーの決定は §1 と §12）。今は R6 まで（行を本番に出し、右腕を席に開く。スマホの下のバーは 3 つで、会話の見出しに［右腕］は無い。広い幅の丸・枠・［広げる］・帯の［右腕］・落ち先の右腕の列も消した。帯の右の通り道 80px と番の列の末尾の丸の分の余白も外した。サーバーは右腕を上限 4 つの外で留められ、応答に `handPins` を足した（R5。§6.1）。画面でも右腕を留められ、留めた右腕は会話の列の先頭に出る（R6。§6.2）。実際の形は §5.3・§5.4・§6.2・§7・§10）。前提の #507（P0〜P5）は main に入った（2026-11-26）。
行番号は #507 の P4 を作っている途中に読んだ物で、目安（P4 のレビューの直しと P5 でずれている）。段を始める時に読み直す。

## 0. 何のために

右腕の置き場所が決まらない。D6 で「右下に浮く丸 → 重なる枠 → ［広げる］で席」にしたが、
丸は列に重なるので #507 で帯の右に 80px の通り道を空け、スマホでは下のバーの 4 つ目になり、
「右腕だけ別の開き方・別の幅・別の履歴」を抱え続けている。

オーナーの言葉:「決まらないので右腕はチャット一覧の一番上に固定して置いて他と同列で使えるようにしたい」。

この設計の狙いは 3 つ。

1. **右腕の入口を 1 つにする**（あなたの番 の列の一番上の行）。丸・枠・［広げる］・帯の［右腕］・下のバーの［右腕］をやめる。
2. **右腕の会話をほかの話題と同じ場所で開く**（席。留めれば会話の列。スマホは全画面）。右腕だけの開き方を消す。
3. **丸のために空けた物を返す**（帯の右の 80px・番の列の末尾の余白）。

変えない物: 右腕そのもの（既定の人格の #inbox・軽いモード）、システムプロンプト・ツール・`src/agent/`・`src/app/topics.ts` の `Topic` と `RightHand` の型、DB の表。

## 1. 決まっている事（オーナー。蒸し返さない）

| # | 決定 |
|---|---|
| 1 | 置き場所は あなたの番 の列の一番上。いつも出ている「右腕」の行（番の項目より上。未読・作業中の印は行に出す）。「探す」の板の一番上にも同じ行 |
| 2 | 右下の丸（`HandOrb`）・重なる枠（`c-hand`・`#v3-hand`）・［広げる］をやめる。右腕は行から席に開く。帯の右の通り道 80px は要らなくなる |
| 3 | 右腕も会話の列として留められる。上限 4 には数えない |
| 4 | スマホは下のバーから［右腕］を外す（あなたの番・タスク・通知）。右腕は あなたの番 の列の一番上の行から全画面の会話 |
| 5 | スマホで話題を開いている間の、見出しの右端の［右腕］は外す（見出しは 戻る・題・「…」だけ） |
| 6 | 右腕に送る文の先頭に自動で付く「（いま見ている話題: <題名>）」の 1 行はやめる |

置き換わる前の決定: D6 の丸、G8（スマホの accent のピル）、#507 の「右腕は留められない」。
残る決まり: 線で囲まず面で区切る・新しい色を足さない・浮いたボタンを増やさない・ホイールを取らない・並べ替えは作らない・
未読の話題は通知の列に混ぜる・席は右端に 1 つ・「見えていれば既読」。

進め方（issue の本文）: #507 の P4・P5 は今の形（通り道 80px）のまま先に入れ、この issue で丸と通り道を外す。

## 2. 今の右腕の棚卸し（コードで確かめた事実）

### 2.1 入口と開き方

| 物 | 場所 | 今の動き | この設計で |
|---|---|---|---|
| 右腕のタブの決め方 `handTab()` | `src/web/static/shell.js:662` | `/api/topics` の `rightHands[0].id` | **残す**（§3） |
| `open()` の振り替え | `shell.js:544–549` | 右腕のタブを席に開かず枠へ回す | **消す**（R2） |
| `syncHand` | `shell.js:1148–1172` | 列 2 に右腕が居たら追い出す | **消す**（R2） |
| 重なる枠 `#v3-hand`・`#v3-hand-ed`・`#v3-hand-backdrop`・`#v3-hand-show` | `src/web/static/index.html:63–68` | 帯の下から幅 420（落ち先は 360）で重なる | **消す**（R3b） |
| 枠の開閉・履歴（`openHand`・`closeHand`・`applyHand`・`history.state.v3Hand`・保存の鍵 `v3-hand`） | `shell.js:647–1100` のあたり | スマホは履歴に 1 段積む。広い幅は積まない | **消す**（R3b。古い entry の `v3Hand` は読んでも何もしないで済む形にする。§13 の危ない所 1） |
| 枠の見出し `HandHead`（`c-hand.js`・`c-hand.css`・口 `SA.hand`） | `src/web/static/c-hand.js:10`、`c-app.js:764` | ［広げる］・「…」・［畳む］ | **消す**（R3b。ファイルごと） |
| ［広げる］と席の右腕（`S.handSeat`・`seatHand`・`leaveHandSeat`・`HAND_SEAT_FRAME`） | `shell.js:201–206, 678, 952–963, 804, 1022` | 枠を畳んで席に開く。覚えるのはメモリだけ | **形を変えて引き継ぐ**（席の右腕は普通の `open`。`S.handSeat` は消す。R2） |
| 右下の丸 `HandOrb`（口 `SA.deck.drawOrb`・`focusOrb`、`#v3-orb`・`#c-orb-root`） | `c-shell.js:256`、`c-app.js:638–667`、`index.html:47`、`shell.js:2215` | 640px 以上の右下。席が閉じていれば accent | **消す**（R3b） |
| 上の帯の［右腕］（`DeckBand` の `hand`・`.c-band-hand`） | `c-deck.js:617–651`、`shell.js:2236–2250` | 丸を描けない間だけ（席だけの幅） | **消す**（R3b。§8） |
| 下のバーの［右腕］（`bottomModel` の deck・phone の `hand`、`.c-bottom-hand`） | `c-shell.js:39–62` | スマホの 4 つ目（accent のピル） | **消す**（R3a） |
| 会話の見出しの［右腕］（`topModel` の phone の `hd`） | `c-shell.js:139–148` | スマホの会話の上に枠を重ねる | **消す**（R3a。決定 5） |
| 落ち先の形の右腕の列（`data-hand-mode="column"`・`--v3-hand-w`） | `shell.css:8, 211–270, 623–631`、`shell.js:44` | `SA.deck` が無いときの 一覧 + 列 2 + 右腕の列 | **消す**（R3b。落ち先でも右腕は一覧の一番上の行から列 2 に開く。§9） |

### 2.2 枠の指定（`HAND_FRAME`。`shell.js:800`）の中身ごと

| 鍵 | 中身 | この設計で |
|---|---|---|
| `title: "右腕"` | 題 | **引き継ぐ**（席・列の見出しの題） |
| `placeholder: "右腕に頼む・訊く"` | 入力欄の薄い字 | **引き継ぐ** |
| `ops: handOps` | 古い見出しの［畳む］（`shell.js:888`） | **消す** |
| `outgoing: withViewing` | 送る本文の先頭に「（いま見ている話題: <題名>）」を 1 行（`shell.js:1253–1267`） | **消す**（R3b。決定 6）。今も席の右腕では添えていない（`HAND_SEAT_FRAME`。`shell.js:804–805`） |
| `replyText: namedText`・`noticeText: handNoticeText` | 返事・まとめの `<#ID>` を話題の名前にする | **引き継ぐ** |
| `replyRefs`・`noticeRefs: handRefs`、`onRef` | 返事・まとめの下の話題の札（`Refs`）。押すと `SA.app.open` | **引き継ぐ**（札の行き先は今と同じ `SA.app.open(id)`。右腕が列なら、札の話題は席に開いて右腕は列に残る） |
| `replyExtras: handCards` | 古い描き方（部品が無いとき）の札 | **引き継ぐ**（触らない） |
| `head: false`（`HAND_FRAME_BARE`） | 見出しを chat.js に作らせない | **引き継ぐ**（見出しは席の TopBar・列の見出し） |

札の描き直し（`handCardIds`・`handCardSig`。一覧を読んで札の中身が変わったら右腕を描き直す。`shell.js:1176–1250`）は**引き継ぐ**。
描き直す先が「枠」から「右腕が出ている所（席か列）」に変わるだけで、`refresh(handTab())` の 1 本にする。
`session_open` で開いた話題の札・確認のカードは chat.js の会話の行の物で、枠にも席にも同じに出る（引き継ぎの作業は無い）。

### 2.3 印・既読・音

| 物 | 場所 | 今 | この設計で |
|---|---|---|---|
| 印 `handMark()` | `shell.js:1108–1116` | あなたの番 > 未読 > 作業中。見えている右腕（枠か席）には未読・作業中を出さない | **引き継ぐ**（行の印。「見えている」= 席に開いている・列が端まで見えている） |
| 既読を付ける会話 `readingChannelIds()` | `shell.js:488–497` | 枠が見えていれば右腕を足す | 枠の枝を**消す**。右腕は席なら `shownTabId()`、列なら `pinsSeen()` に入る |
| polling・音の `shownChannelIds()` | `shell.js:470–477`、`api.js:173, 945–954`、`sound.js:487, 786–816` | 同上 | 同上 |
| 未読の判定 | `api.js:575`（`last.kind` が agent か `last.lead === true`） | サーバーの `handLast` が統括のまとめに `lead: true`（`src/web/routes/topics.ts:212–217`） | **変えない** |
| 番の数 | `src/app/topics.ts:337–357` | 右腕の番も `turns`・`turnIds` に数える | **変えない** |
| 通知の列 | `c-deck.js:358–427` | 未読の話題だけ。**右腕の未読は入っていない** | **変えない**（§7.4） |

## 3. 人格が 2 体以上・`rightHands` が配列の話

事実:

- `rightHands` は**設定の済んだサーバー 1 つにつき 1 件**（そのサーバーの #inbox）。人格の数ではない（`src/web/routes/topics.ts:429–439`）。
- 2 体目以降の人格の入口 `#<NAME>` と #tasks は、右腕ではなく `pinned: true` の普通の話題として一覧に入る（同 `398–427`）。
- 画面のコードは `rightHands[0]` しか使っていない（`shell.js:662–666`。コメント「サーバーが複数でも選ぶ口は作らない」）。
- `docs/plan/personas.md` に右腕・`rightHands` の話は無い。

既定: **行は 1 つ（`rightHands[0]`）。選ぶ口は作らない。** 今と同じで、足す物が無い。
2 体目以降の人格の入口は今のまま話題の行（留めることもできる）。サーバーが 2 つ以上になったときの 2 行目は、要るようになってから別の issue。

右腕がまだ無い（`rightHands` が空）とき: 行は出すが押せない。題「右腕」の下に今の文
「右腕はまだありません。Discord で /setup を実行すると、ここで頼めます。」（`shell.js:647`）を出す。

## 4. 行の形

### 4.1 絵

広い幅（あなたの番 の列）:

```
+--------------------------------+
| あなたの番                   2 |   <- 列の見出し（今のまま）
+--------------------------------+
| o 未読                          |   <- 右腕の行（送られない。いつも見える）
|   右腕                          |
+--------------------------------+
| ! 許可・self-agent        3 分 |   <- ここから下が今の列の中身（送れる）
|   fix-login                     |
|   Bash を実行してよいか         |
| ...                             |
```

右腕が番のとき（行そのものが番の見た目になる。下の番の項目には右腕を重ねて出さない）:

```
| ! 質問                    1 分 |
|   右腕                          |
|   どのプロジェクトで始めますか  |
```

### 4.2 モデル（`c-deck.js`）

- 純関数 `handItem(state)` を足す。返すのは今の `flowItem` と同じ形の項目 1 つ（`c-deck.js:115–134`）か `null`（話題のデータをまだ読めていない）。
  - `key`: `"hand:" + id`（右腕が無いときは `"hand:none"`）。`kind`: `"hand"`。`target`: 右腕のタブの id（無ければ `null` = 押せない）。`title`: 「右腕」。`place`: 空。
  - `turn`: `rightHands[0].turn` が在れば true。そのとき `word` は番の種類の語（今の `turnItems` が右腕に付けている語。`c-deck.js:151–180`）、`time` は待ち始めからの時間、`summary` は番の要約。
  - 番でないとき: `word` は 作業中 → 未読 → 「待機」の順で 1 つ（節「ピン留め」の行と同じ決め方。`itemWord`。`c-deck.js:81–112`）。`summary` は無し（`RightHand` に最後の本文は無い。足すには `src/app/topics.ts` に触るのでやらない）。
  - `mark`: turn > unread > running > 無し。**右腕が見えている間（席に開いている・列が端まで見えている）は unread・running を出さない**（今の `handMark` と同じ）。「見えている」は state の `current`・`seen` から決める（下）。
  - `current`: `state.current === id` か `state.seen` に id が在る（`flowItem` と同じ）。
  - 右腕が無いとき: `summary` に §3 の文、`target: null`。
- `deckModel`（`c-deck.js:455–504`）: 番の列（`id: "turn"`）のモデルに `top: handItem(state)` を足す。ほかの列には足さない。
- `turnItems`（`c-deck.js:151–180`）: **右腕の番は項目にしない**（行が番の見た目を持つので二重に出さない）。
  列の数 `count` は今と同じ数（= 番の項目の数 + 右腕が番なら 1）。上の帯の題・下のバーの数・P5 の「あなたの番 n」は `count` を読むので変わらない。
- 節「ピン留め」（`pinItems`。`c-deck.js:210–231`）には右腕を入れない（右腕を留めても、行は一番上の 1 つだけ）。

### 4.3 部品（`c-deck.js` の `Column`。`c-deck.js:522–544`）

- 列の見出し（`header.c-col-head`）と中身（`div.c-col-body[role=list]`）の間に、`top` が在るときだけ
  `div.c-col-top[role=list]` を置き、その中に今の `Item`（`c-deck.js:566–598`）を 1 つ描く。新しい部品は作らない。
- **「固定」= 送られない**。`.c-col-top` は列の中身のスクロールの外の兄弟なので、番の項目が何件あっても右腕の行は見えたまま。
  `position: sticky`・`fixed` は使わない（面で区切る決まり・浮いた物を増やさない決まりのまま。区切りは余白と地）。
- 列が空のとき（`col.sections.length === 0`）の `Empty` の文は、今のまま `.c-col-body` の中に出す（行の下）。右腕の行が番の時は出さない（数と食い違うため。`.c-col-body` は空のまま置く）。
- 見た目は今の項目の決まりのまま: 番なら `data-turn="true"` の面と左 3px、開いていれば `data-current="true"`（`c-deck.css:142–153`）。新しい色・新しいトークンは足さない。
- 読み上げ: ボタンの名前は今の `Item` と同じ作り（印の語・語・題・要約）。`.c-col-top` に `aria-label="右腕"` は付けない（中のボタンが「右腕」を読む。二重にしない）。
- キー: Tab の順は 列の見出しの次が右腕の行（DOM の順のまま）。矢印キーの決まりは流れの列に無い（今も無い）ので足さない。
- 焦点の戻り先: 行を押すと `SA.flows` が key（`hand:<id>`）を覚える（`flows.js:29–34` の今の道）。席を閉じると `SA.deck.focusItem(key)` で行へ戻る（`c-app.js:438`。`[data-key]` を `#c-deck-root` の中から探すので、`.c-col-top` の中でも拾える）。

### 4.4 スマホと「探す」の板

- スマホの あなたの番 の列は同じ `Column` なので、同じ行が同じ場所に出る（1 列ずつの横送りでも、番の列の中では送られない）。
- 「探す」の板と落ち先の一覧は `c-list.js` の `TopicList`（`c-list.js:239–260`）。`listModel` に `hand`（上と同じ中身を一覧の行の形にした物）を足し、
  `YourTurn` の前に `div.c-list-hand` > `button.c-row[data-topic=<右腕の id>]` を 1 つ描く。
  - 一覧の行の印と語は、隣の話題の行と同じ決め方（`rowModel`）。列の行（§4.2）とは 未読 と 作業中 が重なった時の印が違う。
  - `button[data-topic]` なので、板の ↑↓・Home・End（`c-app.js:48, 390`）に何も足さずに入る。
  - `turnItem`（`c-list.js:89–99`）の右腕の枝は消す（板でも二重に出さない）。`turns.count` は今のまま。
  - 絞り込みの言葉が在る間は、題「右腕」に当たるときだけ出す（話題の行と同じ当たり方）。既定。
- 板の行を押すと板が閉じて右腕が開く（話題の行と同じ道）。

## 5. 席に開く

### 5.1 動き

- `SA.app.open(<右腕のタブ>)` は、ほかの `ch:` のタブと同じ道を通る（`shell.js:519–552` から右腕の振り替え `544–549` と `S.handSeat` を消す）。
  - hash は `#/ch/<右腕のチャンネル>`（`hashOf`。`shell.js:1270`）。履歴は話題と同じ `v3Body` の 1 段。再読み込みすると席に右腕が開く（今は枠に回していた）。
  - 留めていて帯が出ている間は、席に開かず右腕の列へ送る（留めた話題と同じ。`shell.js:524–532`。§6）。
- 席の中身（`renderEd`。`shell.js:172–215`）: タブが右腕なら `SA.chat.render(ed, id, HAND_TALK)`。
  `HAND_TALK` は §2.2 の「引き継ぐ」だけの枠（`title`・`placeholder`・`replyText`・`noticeText`・`replyExtras`・`replyRefs`・`noticeRefs`・`onRef`・`head: false`）。今の `HAND_SEAT_FRAME` と同じ中身で、名前を 1 つにする。
- 見出し（`topState`。`shell.js:299–337`）: `SA.topics.find` は話題しか引かないので、右腕のタブは今の `handSeatTop`（`shell.js:992–1016`）の形を使う。
  - 題「右腕」。状態は あなたの番 > 作業中。場所・許可のモード・［会話］［端末］は出さない。
  - 「…」は chat.js の head の menu（#inbox では 会話を新しくする・Discord で開く。`shell.js:812–816`）+ ピンの行（§6）。
  - ピンのボタン（`seatPin`。§6）。［閉じる］は広い幅の流れの列（今と同じ）。スマホは「戻る」。
  - `hand`・`controls: "v3-hand"` は渡さない（R3 で消す）。
- 入力欄の薄い字は「右腕に頼む・訊く」。
- 一覧の今の行（`SA.topics.setCurrent`）: 右腕も current になる。`topics.js:22, 187` の「右腕は current にならないので別に持つ」は要らなくなるが、R2 では触らない（R7 で片付ける）。

### 5.2 丸・枠と並ぶ間（R2 から R3 まで）

R2 の後、R3 までは行と丸の両方が在る。同じ会話を 2 か所に描かないために今の守りをそのまま使う。R3b で丸・枠・［広げる］を消したので、この間は終わった（下の守りは枠ごと消した）。

- 右腕が席に開いている間に丸・帯の［右腕］・下のバーの［右腕］を押したら、枠を開かず席の入力欄に焦点（今の `openHand` の頭。`shell.js:895–899`）。
  判定 `handSeated()` は `S.active === handTab()` だけにする。
- 枠が開いている間に行を押したら、`open` が今の決まりで枠を畳んでから席に開く（今の［広げる］と同じ順）。
- ［広げる］は R2 では残す（中身は `open(handTab())` になる）。消すのは R3b。

### 5.3 R2 で入れた形（実装）

- 席の右腕は `S.handSeat` を消し、`handSeated()` は「席の住人が右腕のタブ」だけ。席が隠れる形（スマホ・流れの列）で席を閉じる（［閉じる］・Esc・戻る）と今までどおり住人を空にする（閉じた席に右腕を残すと、丸で開いた枠と 2 か所に描くため）。R3b で枠が無くなったので、ほかの話題と同じ（住人を残す）にした（§5.4）。落ち先の広い幅は列 2 が見えたままなので、話題と同じに住人を残す。右腕のチャンネルが替わった・無くなった時は、最後に見た右腕のタブ（`lastHandTab`）が席の住人なら空にする。
- 枠・落ち先の右腕の列が開いていれば、席に開く時（`open`・一覧を読んだ後の `syncHand`・`renderHand` の守り）に `foldHand` で畳む（列の形は［畳む］と同じに保存、重ねる形は `fitHand` と同じに entry の印 `v3Hand` を外す。畳んだ枠の中の焦点は席の入力欄へ）。一覧より先に hash で開いた右腕は、一覧が読めたら `HAND_TALK` と右腕の見出しで描き直す。スマホの幅をまたいでも席の右腕は全画面の会話のまま。
- 入口の焦点: 上の帯の「あなたの番 n」は右腕の行が番の時だけ行へ、ほかは本体の最初の押せる項目へ。列を描き直した後の落ち先は右腕の行を候補に数えず、焦点が行に在れば同じ key の行に残す。
- 席の右腕の見出し（`handSeatTop`）は、R2 では `hand`・`controls` を渡したままだった。§5.1 の「渡さない」に R3a で揃えた（見出しの state はどれも `hand`・`controls` を持たない）。

### 5.4 R3b で入れた形（実装）

- 席の右腕を閉じても（［閉じる］・Esc・戻る）住人は右腕のまま（ほかの話題と同じ）。「進む」で席の entry に入れば右腕がまた出る。住人を空にするのは右腕のチャンネルが替わった・無くなった時（`syncHand` の中の `leaveHandSeat` 1 か所）だけ。
- 右腕が見えているか（`handSeen`）は「席の住人が右腕で、席が隠れていない」（`handSeated() && !mainHidden()`）。席が隠れている間は行と下のバーに未読・作業中を出す（席が隠れた・出た時に `setView` が印を描き直す）。既読（`readingChannelIds`）・polling と音（`shownChannelIds`）も右腕を列 2 の会話として、ほかの話題と同じ決まりで入れる。
- 席の右腕の枠の指定 `HAND_TALK` は 1 つの定数（題・placeholder・`replyText`・`noticeText`・`replyExtras`・`replyRefs`・`noticeRefs`・`onRef`・`head: false`。`outgoing` と `ops` は無い）。送る文は入力のまま（決定 6）。
- 古い履歴の `v3Hand` は読まない・書かない（`{ v3Hand: true }` の entry に戻る・進むで入っても、`v3Body` だけを見て列か席の今の形のまま）。落ち先（`SA.deck` が無い）の広い幅は 一覧 + 列 2 の 2 列で、右腕は一覧の一番上の行から列 2 に開く。
- 「探す」の板（一覧）の右腕の行も、席が隠れている間は未読・作業中を出す（`handRowModel` は `seen` だけを見る。shell.js が席に右腕が見えている間だけ `SA.topics.setSeen([右腕のタブ])` で渡し、変われば一覧を描き直す。いま開いている印は `current` のまま）。

## 6. 留める（上限の外）

### 6.1 サーバー（最小。DB の移行なし。Bot の再起動が 1 回要る）

事実:

- 表 `topic_pins` は `channel_id`・`position`・`created_at` だけで、チャンネルの種類も上限も知らない（`src/store/db.ts:898–902`、`src/store/topic-pins.ts`）。
- 上限は route が数える。数えるのは `pinsOfResult`（応答の**話題**に在って完了でない物だけ。`src/web/routes/topics.ts:525–531`）。
  右腕は `result.topics` に居ないので、表に入っていても**数えられないし `pins` にも出ない**。
- `POST /api/topics/ch:<id>/pin` は、右腕なら 400 を返している（同 `586`）。`pins.lookup` は #inbox も引ける（`src/web/routes/channels.ts:121–147`）。

変える所は `src/web/routes/topics.ts` だけ。

1. POST の `on: true` で、id が `result.rightHands` に在るとき: 400 をやめ、上限を見ずに `pins.store.add(channelId)` して 200。
2. GET `/api/topics` と POST の 200 の応答に **`handPins: string[]`** を足す（表の channelId のうち `result.rightHands` に在る物。表の順。`ch:` は付けない。`pins` と同じ書き方）。
   `pins`・`pinMax` の中身は変えない（右腕は入らない・上限 4 は話題だけ）。pins の配線が無いときは `handPins: []`。
3. `on: false` は今のまま（何でも外せる）。

触らない: `src/app/topics.ts`（`RightHand`・`Topic`・`buildTopics`）・`src/agent/`・システムプロンプト・ツール・`src/store/`・DB の版（v48 のまま）。プロンプトキャッシュには関わらない。

R5 で入れた（`src/web/routes/topics.ts` の `handPinsOfResult` と POST `/pin` の右腕の枝。`pinsOfResult` は変えていない。テストは `test/web-topics.test.ts`）。

画面は `Array.isArray(data.handPins)` で口が在るかを見る。新しい静的ファイル + 再起動前のサーバーの間は、右腕のピンのボタンとピンの行を出さない（押して 400 になる物を出さない）。

### 6.2 画面

- `topics.js`: `hand()`（`rightHands[0]` か null）・`handPinned()`（`handPins` に右腕のチャンネルが在る）・`handPinnable()`（`handPins` が配列）・
  `pinColumns()`（右腕が留めてあれば先頭に右腕、続けて `pins()`）を足す。`pins()`・`pinMax()` は変えない。`setPins` は `handPins` も取り込む（`topics.js:261–272`）。
- 上限: `DECK.PIN_MAX`（`c-deck.js:11`）と `pinRow` の数え方（`SA.topics.pins().length >= max`。`shell.js:407–414`）は**話題だけのまま**。右腕は数に入らない。
- `pinRow`・`seatPin`（`shell.js:407–424`）: 右腕のタブのとき、`handPinnable()` なら「ピン留めする / ピン留めを外す」を返す（上限の理由の行は出さない）。今の `t.id === handTab()` で落とす枝は消す。
- 列の並び: **右腕の列は会話の列の先頭（流れの 3 列のすぐ右）**。「上にある物が左」（行は一番上 → 列は一番左）。留めた順には入れない。既定。
  - `pins.js` の `sync`（`pins.js:123–150`）と `pinFit`・`pinnedSeat`（`shell.js:2105–2114`）は `SA.topics.pins()` の代わりに `pinColumns()` を使う。
- 列の中身と見出し: `pins.js` は右腕を知らないままにする。`sync` の `on` に 2 つ足して shell.js が答える。
  - `frame(channelId)`: 右腕なら `HAND_TALK`、ほかは今の `{ head: false }`（`pins.js:11, 74`）。
  - `top(channelId)`: 右腕なら `{ title: "右腕", status: <§5.1 の状態> }`、ほかは null（今の `headState`。`pins.js:50–67`）。
  - 列の「…」（`openPinMenu`。`shell.js:2068–2076`）は題が「右腕」になるだけで、行は今のまま（ピン留めを外す + head の menu）。
- 同じ会話を 2 か所に描かない守り: 留めた話題の決まり（`pinnedSeat`・`leavePinnedSeat`。`shell.js:2111–2135`）に右腕がそのまま乗る（`pinColumns()` に入るので）。
  帯が出ない幅（席だけの幅・スマホ）では、留めていても席・全画面に開く（留めた話題と同じ）。
- 行の線: 右腕の列が端まで見えていれば、一番上の行に `data-current`（§4.2 の `seen`）。行を押すと列へ送って入力欄に焦点（`SA.pins.jump(id, "composer")`）。
- あなたの番 の節「ピン留め」には出さない（§4.2）。スマホには会話の列が無いので、留めても見た目は変わらない（「…」の行の字が「外す」になるだけ）。

R6 で入れた（`topics.js` の `hand`・`handPinnable`・`handPinned`・`pinColumns`、`shell.js` の `pinRow`・`seatPin`・`handSeatTop`・`openHandMenu`・`PINS_ON` の `frame`・`top`、`pins.js` の `sync`）。設計と違う・足した所:
`handPinnable()` は `handPins` が配列で `pinMax() >= 1` の時だけ（pins の配線が無いサーバーは `handPins: []`・`pinMax: 0`）。`top(channelId)` は列を描くたびに訊く（状態の あなたの番・作業中が変わるため。`frame` は列を作る時だけ）。
札の中身か見出しの状態（あなたの番・作業中）が変わったら列の右腕も描き直す（`syncHand` が一覧を読むたびに見直す。§2.2）。
「探す」の板の右腕の行の `seen` は席だけを見る（列が見えていても板の行には未読・作業中の印が出る。板の間は列が幕の下で、既読も付けないため）。席の右腕を列へ移した時（`leavePinnedSeat`）は右腕の印も描き直す。`open` の列へ送る枝は足していない（留めた話題の分かれ道にそのまま乗る）。

### 6.3 `HAND_FRAME` のどれが列に当てはまるか

§2.2 の「引き継ぐ」は全部（列でも席でも同じ `HAND_TALK`）。当てはまらないのは `ops`（畳む）と `outgoing`（決定 6 でやめる）。

## 7. スマホ

1. **下のバーは 3 つ**（あなたの番・タスク・通知）。`bottomModel` の deck の形から `{ act: "hand" }` を外す（`c-shell.js:39–62`）。phone・wide の形の `hand` も一緒に外す（落ち先。§9）。
2. **右腕を開く**: あなたの番 の列の一番上の行 → 全画面の会話（話題と同じ `open`。見出しは 戻る・題「右腕」・「…」）。
3. **戻る**: 見出しの「戻る」・端末の戻る操作で、開く前の列（あなたの番）へ。履歴は話題と同じ 1 段。枠だけの履歴の段（`v3Hand`）は無くなる。
4. **番の合図**: 右腕の番は今も あなたの番 の数に入っている（`src/app/topics.ts:337–357`）。バーの数・帯の題の数は変わらない。
5. **未読の気づき**（既定）: 右腕が未読で番でないとき、下のバーの［あなたの番］に未読の点を 1 つ出す（今の `Mark` の unread。新しい色は足さない）。
   - 理由: タスク・通知の列を見ている間は一番上の行が見えない。今は下のバーの［右腕］の印がこの役だった。
   - 右腕の未読は通知の列に混ぜない。統括のまとめ（L2）は話題のターンが終わるたびに右腕を未読にし、同じ時にその話題も通知の列に出る。混ぜると同じ出来事が 2 行になる。
   - 会話を全画面で見ている間は下のバーが無いので、気づけない（今も会話の見出しの［右腕］の印だけ。決定 5 で外すので無くなる）。
6. **会話の見出しの［右腕］**（`topModel` の phone の `hd`。`c-shell.js:145–148`）: 外す（決定 5。§12）。

R3a で入れた形（実装）:
- 未読の点は［あなたの番］のボタンの見える地（`.c-bottom-page-in`）の中で数の Badge の後ろに K2 の `Mark`（unread。読み上げない）。読み上げの名前は「あなたの番（3 件・未読）」、数が無ければ「あなたの番（未読）」。`shell.js` は `handMark() === "unread"` を下のバーの `unread` に渡す（描けなければ `unread: false` で 1 回だけ描き直す）。作業中・番は点にしない。
- 広い幅（丸）で開いた枠を開いたままスマホの幅に変えると、枠はそのまま（［畳む］で閉じる。［広げる］は出さない）。スマホに枠を開く口は無い（`openHand` に届く口は丸・帯の［右腕］・`#v3-hand-show` だけで、どれもスマホの幅では出ない）。R3a より前にスマホで積んだ履歴の entry（`v3Hand`）へ「進む」で入ると枠が開く道は残る（R3b で枠ごと消す）。
- この 2 つの道（幅をまたいで持ち越した枠・R3a より前の `v3Hand` の entry へ「進む」）で開いた枠をスマホの幅で閉じた後は、焦点を戻す先が無く body に落ちる（戻す先は足さない。R3b で枠ごと消える）。

## 8. 640〜739px（席だけの幅）と、帯を右へ送った間

今: 席を開くと列が隠れる幅では丸を消し、上の帯に［右腕］を出している（`shell.js:2215–2250`）。

既定: **帯の［右腕］も消す。代わりの口は足さない。**

- 右腕へ行く道: ［閉じる］で列に戻って一番上の行（2 押し）か、Ctrl+K・帯の［探す］→ 板の一番上の行（板の最初の行なので Ctrl+K → ↓ → Enter）。
- よく使うなら右腕を留める（会話の列としていつも出る。席だけの幅では帯ごと隠れるのは留めた話題と同じ）。
- 分かっている弱み: 席だけの幅で席を開いている間と、帯を右へ送って番の列が見えない間は、右腕の未読・作業中が見えない。
  番は P5 の上の帯の「あなたの番 n」で見える（右腕の番も数に入る）。未読だけが見えない。
- 帯に何かを足す案（［右腕］を残す）は採らない。「入口を 1 つにする」が今回の狙いで、帯の［右腕］は丸の代わりだった。

## 9. 古い殻・見本・落ち先

事実:

- 古い殻 `src/web/static/classic.html` が読むのは `base.css`・`tokens.css`・`app.css` と `ui.js`・`api.js`・`sound.js`・`chat.js`・`views.js`・`sidebar.js`・`workbench.js`。
  `shell.js`・`c-*.js`・`shell.css`・`c-hand.css` は読まない。右腕の枠・丸を消しても古い殻は変わらない。
  共有しているのは `chat.js`（枠の指定を受ける側）・`api.js`・`sound.js`・`tokens.css`。`SA.app.shownChannelIds` は古い殻では `workbench.js:477` が答える。
- 見本 `gallery.html`: `c-hand.css` を読み（`gallery.html:16`）、`c-gallery.js` が `HandOrb`・`HandHead` を import している（`c-gallery.js:7, 11`）。
  節: 下のバーの見本（`509–516`。`hand=` 付き）・丸の節（`520–540`）・右腕の見出しの節（`831–841`）。`c-gallery.css:152` が `--c-hand-w` を使う。
- 落ち先の形（`SA.deck` が無いとき。`shell.js:44–47`）: 一覧 + 列 2 + 右腕の列。`SA.list`・`SA.deck` はどちらも `c-app.js` が作る。

範囲:

| 物 | この issue で |
|---|---|
| 古い殻 | 触らない。`chat.js` の枠の鍵（`ops`・`outgoing` を読む側）は残す（消すのは古い殻を消す M8b と一緒） |
| `tokens.css` | `--c-deck-lane`・`--c-orb` を消す（R4・R3b）。`--c-hand-w` は見本の入れ物の幅だけが使うので、`c-gallery.css` の中の変数に移して消す（R3b） |
| 見本 | 丸の節・右腕の見出しの節を消す。下のバーの見本から `hand=` を外す。流れの列の見本に「右腕の行」（待機・未読・作業中・番・右腕が無い）を足す。一覧の見本に一番上の行を足す（R1・R3） |
| 落ち先の形 | 右腕の列（`data-hand-mode`・`--v3-hand-w`・`#v3-hand-show`）を消し、右腕は一覧（`TopicList`）の一番上の行から列 2 に開く（R3b）。落ち先そのものを消すのは今までどおり D10 |

## 10. 通り道 80px を外す（#507 の P5 が入った後）

事実: `stripFit` の `room` が `− DECK.LANE` を引き（`c-deck.js:37–44`）、`shell.css:365` が `.v3-deck` に `margin-right: var(--c-deck-lane)` を付け、
`shell.css:421–425` が番の列の末尾に丸の高さ分の余白（`--c-deck-tail` の上書き）を足している。値は `tokens.css:201–203`。

変える:

```
DECK から LANE を消す
stripFit: room = width − f.seat − (f.seat > 0 ? GAP : 0)
shell.css: .v3-deck の margin-right を消す。--c-deck-tail の上書きを消す（tokens.css の既定 var(--space-2) に戻る）
tokens.css: --c-deck-lane を消す
```

テストで固定する値（`docs/plan/web-ui-pins.md` §4.2 の表を書き直す。`test/web-components.test.ts:4488` の段）:

| width | 席 | show | seat | room | colW | convW |
|---|---|---|---|---|---|---|
| 1440 | 閉 | true | 0 | 1440 | 300 | 420 |
| 1440 | 開 | true | 540 | 892 | 300 | 420 |
| 1920 | 閉 | true | 0 | 1920 | 300 | 420 |
| 1920 | 開 | true | 720 | 1192 | 300 | 420 |
| 820 | 閉 | true | 0 | 820 | 300 | 420 |
| 820 | 開 | true | 440 | 372 | 300 | 372 |
| 640 | 閉 | true | 0 | 640 | 300 | 420 |
| 640 | 開 | false | 440 | 0 | 0 | 0 |

見える列の例（1440・留めた 2 本。列の位置 0・308・616・924・1352、幅 300×3・420×2、見える幅 1440）: `left` 0 → 番・タスク・通知・A。右端まで送った `left` 332 → 通知・A・B。
1440 で席を閉じていれば、流れの 3 列と会話の列 1 本（右腕だけを留めた形）が送らずに全部見える（924 + 420 = 1344 ≤ 1440）。

順番: **P5 が main に入ってから**。丸を消す PR（R3b）の後で、R3b と続けて merge する（間は帯の右に何も無い 80px が空くだけで壊れない。逆の順は丸が列に重なるので不可）。
本番の checkout を進めるのは R4 の後（静的ファイルは pull した時から効く）。

R4 で入れた: 上の「変える」のとおり（`DECK.LANE`・`--c-deck-lane`・`--c-orb`・`.v3-deck` の右の `margin`・`--c-deck-tail` の上書きを消し、`stripFit` は上の表の値。画面写しは帯の右端（席の左端 − 8 か `#v3` の右端）と番の列の末尾の余白（`--space-2`）を確かめる）。

書き直す文書: `docs/plan/web-ui-pins.md` の §4.2（式・表・「右腕の丸」の行・`margin` 80px）・§4.8（「右腕（#inbox）| 留められない」）・§4.9・§4.10（右腕の丸・［広げる］）・
§5.1 の受け入れ条件（P1 の「右腕は 400」・P2 の「右腕には出ない」・P4 の「帯の右に 80px が空き、丸はどの列にも重ならない」「右腕は留められない」）・§6.2・§6.3（通り道の残りの問いは閉じる）。

## 11. 消す物と、絵の増減

### 11.1 消す物（R3a・R3b・R4・R7 に分ける）

- ファイル: `src/web/static/c-hand.js`・`c-hand.css`（`index.html:28`・`gallery.html:16` の link も）。
- 部品・口: `HandOrb`（`c-shell.js:256`）・`HandHead`・`handLabel` の使われなくなる所・`DeckBand` の `hand`・`controls`・`on.hand`（`c-deck.js:600–651`）・`bottomModel`/`BottomBar` の `hand`・
  `topModel`/`TopBar` の `hand`・`SA.hand`・`SA.deck.drawOrb`・`focusOrb`・`SA.list.focusHand`（`c-app.js:406, 638–667, 764`）。
- DOM: `#v3-orb`・`#c-orb-root`・`#v3-hand`・`#v3-hand-show`・`#c-hand-root`・`#v3-hand-ed`・`#v3-hand-backdrop`、`#v3` の `data-hand`・`data-hand-mode`（`index.html:45–68`）。
- CSS: `shell.css` の `.v3-hand` の塊（`211–270`・`438`・`514–566`・`623–631`）・`.v3-orb`（`306–313`・`399–419`・`477`）・通り道（`365`）・`--c-deck-tail` の上書き（`421–425`）・`--v3-hand-w`（`8`）、
  `c-shell.css` の `.c-orb*`（`392–465`）・`.c-bottom-hand`・`.c-top-hand`、`c-deck.css` の `.c-band-hand`、`tokens.css` の `--c-hand-w`・`--c-deck-lane`・`--c-orb`。
- shell.js: `S.handMode`・`S.handWant`・`S.handOver`・`S.handSeat`、`HAND_MAIN_MIN`・`HAND_FRAME`（`HAND_TALK` に置き換え）・`HAND_FRAME_BARE`・`HAND_SEAT_FRAME`・`HAND_ON`・`ORB_ON`、
  `handVisible`・`handSeated`・`handSeen`・`handSeatable`・`handOps`・`openHand`・`closeHand`・`applyHand`・`seatHand`・`leaveHandSeat`・`clearHandEd`・`drawHandHead`・`renderHand`・`renderHandEntries`・`syncHand`・`renderOrb`、
  `viewingTitle`・`withViewing`、Ctrl+K・Escape の「重ねた右腕」の枝（`shell.js:2422, 2439–2442`）、`readingChannelIds`・`shownChannelIds` の枠の枝。
- 残す: `handTab`・`handChannelId`・`handMark`（行の印の元）・`handMenu`・`handSeatTop`（名前は `handTop` に）・`cardIds`〜`handNoticeText`（札と名前）。右腕が無いときの文は `c-list.js` の `HAND_NONE` に在る（shell.js の `HAND_NONE_TEXT` は R3b で消した）。

### 11.2 テスト（当たりを付けた所。行は今の枝）

- `test/web-components.test.ts`: 消す = `2008`（HandOrb）・`2489` の HandHead の半分・`5251/5299`（帯の hand）・`5335`（`--c-deck-tail`）・`5412`（丸の CSS）・`5446`（`.c-hand-head`）。
  書き直す = `1552/1580/1629`・`5733/5759/5807`（下のバー 4 → 3）・`1707/1789/1807`（見出しの hand）・`4488`（stripFit の表）・`4558`（turnItems の右腕 → 行）・`5398`（accent の塗りの一覧から丸・下のバーの右腕）・`363/401`（動きの一覧から枠）。
- `test/web-static.test.ts`: 消す = `7928–8526`（枠の動きの塊）・`11909–12287` のうち丸・帯の［右腕］・［広げる］。
  書き直す = `2613`（読み込みの順から c-hand）・`7891`（「右腕は列 2 に開かない」→ 開く）・`10252–10330`（既読を付ける会話）・`10712/10756`（右腕にピンの行が出ない → 出る）・席の右腕の段（［広げる］経由 → 行経由）。
- `test/web-topics.test.ts`: 足す（§6.1）。`test/topic-pins-store.test.ts`: 変えない。
- どの PR も `npm run check` と `npm test`。一覧・入口・見出し・会話に触る PR（R2・R3a・R3b・R4・R6）は merge の前に `npm run ui-shots` を全部。

### 11.3 絵（`scripts/ui-shots.ts`。撮りすぎないための増減）

行は あなたの番 の列にいつも出るので、**今ある `a-deck*` の絵に勝手に写る。行のための新しい絵は撮らない。**

| 絵 | 今 | この設計で |
|---|---|---|
| `c-hand-over`（スマホの明暗と PC・ダークの 3 枚。枠を重ねた所） | `ui-shots.ts:200, 6557` | **消す**（スマホの明暗の 2 枚は R3a で消した。PC・ダークの 1 枚は R3b） |
| `c-hand-with-chat`（PC・ダークの 1 枚） | `ui-shots.ts:200, 6605` | **消す**（R3b） |
| `g-hand`（見本の右腕の見出しの節。スマホ・PC × 明暗の 4 枚） | `ui-shots.ts:220, 7362` | **消す**（R3b） |
| `a-deck-solo`（PC・ダーク。席だけの幅で帯に［右腕］） | `ui-shots.ts:183, 6632` | **消す**（R3b。帯に［右腕］が無いことは検査だけ残す） |
| `c-hand-seat`（PC・ダーク。席の右腕） | `ui-shots.ts:185, 6703` | **残す**（開き方を［広げる］から行に替える。R2。名前は `a-deck-hand` に。R3b） |
| `g-bottom`・`g-deck`・`g-list`（見本） | 在る | **残す**（中身が変わるだけ） |
| スマホ・ダークの右腕の全画面 `a-deck-hand` | 無い | **足す**（1 枚。R2） |
| PC・ダークの右腕の列 `a-deck-pins-hand` | 無い | **足す**（1 枚。R6） |

差し引き: 種類で 4 つ減って 2 つ増える。枚数は 9 枚減って 2 枚増える（`c-hand-over` 3・`c-hand-with-chat` 1・`g-hand` 4・`a-deck-solo` 1。`ui-shots.ts:150–156, 213–218` の組から数えた）。
検査だけ（絵なし）で足す物: 丸が DOM に無い・帯の右に空きが無い（帯の右端 = 席の左端 − 8 か画面の右端）・右腕の行が列の中身のスクロールの外に在る。
今の丸・枠の検査（`ORB`・`handFrameLines`・`orbListLines`・通り道と丸の当たり。`ui-shots.ts:1461, 2328–2346, 2646–2700, 2887–2906, 5150–5323, 5651–5669`）は R3b・R4 で消す。

## 12. オーナーに訊いた事（2 つ。どちらも決定）

### 問い 1: スマホで話題を開いている間の、見出しの［右腕］ → **a. 外す**（決定 5）

今、スマホで話題の会話を開くと、見出しの右端に［右腕］のボタンがあります（押すと会話の上に右腕の枠が重なる）。
枠をやめるので、このボタンをどうするかを決めてください。下のバーの［右腕］は外すと決まっています。

```
今                                  a 外す
+------------------------------+    +------------------------------+
| < fix-login       [...] [右腕]|    | < fix-login             [...] |
+------------------------------+    +------------------------------+
```

- **a. 外す（決定）**。右腕へは 戻る → あなたの番 の一番上の行（2 押し）。入口が本当に 1 つになる。
  困る所: 話題を読んでいる間は、右腕の未読・番に気づく印が画面に無い（会話を閉じれば下のバーの数と点で分かる）。
- b. 残して、押すと右腕の会話に移る（今の話題は閉じる。戻ると列）。1 押しで行けて印も残る。
  困る所: 「右腕だけの入口」が 1 つ残る。重ならないので、話題を見ながら右腕に訊くことはどちらでもできない。
- c. 残して印だけにする（押せない点）。気づけるが、押せない物が見出しに増える。

### 問い 2: 右腕に送る文に「いま見ている話題」を添えるのをやめるか → **a. やめる**（決定 6）

今、話題を開いたまま枠の右腕に送ると、本文の先頭に「（いま見ている話題: <題名>）」が自動で 1 行付きます
（右腕が「これ」「この話題」を取り違えないため）。枠が無くなると「話題を見ながら右腕に送る」形は、右腕を会話の列に留めて、席に別の話題を開いているときだけになります。

- **a. やめる（決定）**。右腕もほかの話題と同じで、送った文がそのまま届く。「この話題」と言いたいときは話題の名前を書く。
  困る所: 右腕に「これどうなってる？」とだけ送ると通じない。
- b. 右腕を列に留めていて、席に話題が開いているときだけ添える。今に近い使い方が残る。
  困る所: 見えない 1 行が場面によって付いたり付かなかったりする（席の右腕・スマホでは付かない）。実装は小さい（今の関数を残すだけ）。

### 訊かずに既定にした事（違えば言ってもらう）

| # | 既定 | 理由 |
|---|---|---|
| 既定 1 | 行は送られない（列の中身の外。番が何件あっても見える） | 「一番上に固定」の言葉どおり |
| 既定 2 | 右腕が番のときは、行が番の見た目になる（下の番の項目には重ねて出さない） | 同じ物を 2 行にしない。数は今のまま |
| 既定 3 | 右腕の列は会話の列の先頭（流れの 3 列のすぐ右） | 行が一番上 → 列は一番左。並べ替えは作らない決まり |
| 既定 4 | 席だけの幅（640〜739px で席を開いた間）の帯の［右腕］も消す | §8 |
| 既定 5 | スマホは、右腕が未読のとき下のバーの［あなたの番］に未読の点 | §7 の 5 |
| 既定 6 | 右腕の行は 1 つ（サーバーが 2 つ以上でも先頭だけ） | §3。今と同じ |
| 既定 7 | 「探す」の板では、絞り込みの言葉が在る間は「右腕」に当たるときだけ行を出す | 探している話題の上に居座らない |

## 13. 危ない所

1. **同じ会話を 2 か所に描く・古い履歴**。右腕が普通の `open` を通るようになると、R2〜R3 の間は「席の右腕」と「枠の右腕」が両方在り得る（§5.2 の守りに頼る）。
   R6 からは「席」と「列」（留めた話題の守りに乗せる）。`chat.js` は枠の指定をチャンネルごとに 1 つ覚える（`frames`。`chat.js:1608`）ので、2 か所に描くと後の指定が勝つ。
   また、R3b を入れた時にブラウザの履歴に残っている `v3Hand: true` の entry へ戻っても何も起きない形（読まない）にする。
2. **入れる順**。静的ファイルは本番の checkout を進めた時から効き、サーバーは再起動まで古い。
   (a) R3b（丸を消す）と R4（通り道を消す）は続けて入れて一緒に進める。逆の順は丸が列に重なる。
   (b) R6（右腕を留める画面）は R5 の再起動より先に出ても壊れないよう `handPins` の有無で口を隠す。
   (c) #507 の P5 より先に R4 を入れると P5 の算数とテストがぶつかる。
3. **テストと画面写しの面が広い**。右腕・丸・通り道に触れている行は `test/web-components.test.ts` で約 130 行、`test/web-static.test.ts` で約 90 行、`scripts/ui-shots.ts` で約 330 行。
   消すテストに「枠が在るから成り立っていた守り」（重ねた右腕の間は Ctrl+K を取らない・inert の範囲・焦点の戻り）が混ざっている。
   消す前に、同じ守りが席・列の側に在るか（在る物は既にテストが在るか）を PR ごとに書き出してから消す。

## 14. 段（1 PR = 1 論点。どの段の後も画面は壊れない）

前提: #507 の P4・P5 が main に入っている。

| 段 | 中身 | 効き方 |
|---|---|---|
| R0 | 文書: この設計を `docs/plan/web-ui-hand-row.md` に置き、`web-ui-deck.md` の D6・`web-ui-pins.md` の右腕と通り道の所に「#514 で変える」と書く | 文書だけ |
| R1 | 部品と見本: 行のモデル `handItem`・列の `.c-col-top`・一覧の一番上の行。本番の画面には出さない | 静的ファイル（見た目は変わらない） |
| R2 | 行を本番に出し、右腕を席に開く（丸・枠・下のバーの［右腕］は残る） | 静的ファイル |
| R3a | スマホ: 下のバーを 3 つに・［あなたの番］の未読の点・見出しの［右腕］を外す | 静的ファイル |
| R3b | 広い幅: 丸・枠・［広げる］・帯の［右腕］・落ち先の右腕の列を消す | 静的ファイル（R4 と一緒に進める） |
| R4 | 通り道 80px と番の列の末尾の余白を消す | 静的ファイル |
| R5 | サーバー: 右腕を上限の外で留める・`handPins` | **Bot の再起動が要る**（オーナーに訊いてから） |
| R6 | 画面: 右腕のピンのボタン・「…」の行・会話の列（先頭） | 静的ファイル（R5 の再起動の後に効く） |
| R7 | 片付け: 文書の書き直し（deck・pins・GUIDELINES・components・directory-structure・CLAUDE.md）と残りの名前 | 文書と小さい片付け |

R5 は R2 の後ならいつ入れてもよい（R3・R4 と並べて進められる）。R6 は R4 の後（列の幅の算数が落ち着いてから）。

### R0 文書

- 触る: `docs/plan/web-ui-hand-row.md`（新規。この文）、`docs/plan/web-ui-deck.md`（状態の行・§6.4 の頭・§7 の表に「#514 で置き換える」）、`docs/plan/web-ui-pins.md`（§4.8・§4.10・§6.2・§6.3 に同じ注記）、`CLAUDE.md`（1 行）。
- 受け入れ: 文書に絶対パス・ID・ホスト名が無い。`npm test`（文書を見張るテストが在れば通る）。
- 絵: 無し。

### R1 部品と見本

- 触る: `src/web/static/c-deck.js`（`handItem`・`deckModel` の `top`・`Column` の `.c-col-top`・`turnItems` から右腕を外す条件）、`c-deck.css`（`.c-col-top` の余白だけ）、
  `c-list.js`（`listModel` の `hand`・一番上の行・`turnItem` の右腕の枝）、`c-list.css`、`c-gallery.js`（見本）、`test/web-components.test.ts`。
- 本番に出さないための切り替え: `deckModel`・`listModel` は state に `handRow: true` が在るときだけ行を作り、右腕を番の項目から外す。R1 では `flows.js`・`topics.js` は渡さない。
- 受け入れ（テストで）:
  - `handItem`: 待機・未読・作業中・番・右腕なし・データなし（null）の 6 つの形。見えている間（`current` か `seen`）は unread・running の印が無い。key は `hand:<id>`。
  - `deckModel({ handRow: true })`: 番の列だけに `top`。右腕が番でも `sections` の番の項目に右腕が無く、`count` は右腕を含む数。`handRow` が無ければ今と同じ出力（今のテストがそのまま通る）。
  - `Column`: `.c-col-head` → `.c-col-top` → `.c-col-body` の順。`.c-col-top` の中に `.c-item[data-kind="hand"]` が 1 つ。列が空でも `.c-col-body` に `Empty` が出る（右腕の行が番の時は出さない。§4.3）。
  - `TopicList`: `hand` が在れば最初の `button[data-topic]` が右腕。絞り込み中は「右腕」に当たるときだけ。
  - CSS: `.c-col-top` に `position`・`border`・新しい色が無い。
- 絵: 見本の `g-deck`・`g-list` に写る（新しい種類は足さない）。

### R2 行から席に開く

- 触る: `shell.js`（`open` の振り替えを消す・`renderEd`・`topState`・`openTopMenu`・`handSeated` の判定・`HAND_TALK`・`syncHand` は消さずに書き直す（右腕が替わった時に席を空にする・枠を畳む・席の描き直し。§5.3）・札の描き直しの先）、
  `flows.js`（state に `handRow: true`）、`topics.js`（`listState` に `handRow: true`・`hand()`）、`c-app.js`（要れば焦点）、`scripts/ui-shots.ts`、`test/web-static.test.ts`。
- 受け入れ:
  - 640px 以上: `#c-deck-root [data-col="turn"] .c-col-top [data-kind="hand"]` が 1 つ。押すと `#v3` が `data-view="body"`、`location.hash` が `#/ch/<右腕>`、席の見出しの題が「右腕」、入力欄の placeholder が「右腕に頼む・訊く」、行に `data-current="true"`。
  - 席を閉じると焦点が行のボタンに戻る。再読み込みで席に右腕が開く（`#v3-hand` は `data-hand="closed"` のまま）。
  - 右腕が席に在る間に丸を押しても `#v3-hand` は開かず、席の入力欄に焦点。枠が開いている間に行を押すと枠が閉じて席に開く。`#v3-hand-ed` と `#ed` の両方に会話が在る状態にならない。
  - スマホ: あなたの番 の列の一番上に同じ行。押すと全画面の会話、見出しは「戻る」と題「右腕」。戻ると あなたの番 の列。
  - 「探す」の板の最初の行が右腕。押すと板が閉じて右腕が開く。
  - 右腕が番のとき、番の項目に右腕が重ねて出ない。上の帯・下のバーの あなたの番 の数は前と同じ。
  - 席の右腕に送った文に「（いま見ている話題:」が付かない。返事の `<#ID>` は話題の名前で出て、札を押すとその話題が席に開く。
  - 右腕が席に見えている間、行に未読・作業中の印が出ない。既読が付く（`readingChannelIds` に右腕）。
- 絵: `c-hand-seat` の開き方を行に替える。スマホ・ダークの `a-deck-hand` を 1 枚足す。前後の絵（PC・スマホの `a-deck`）を PR に付ける。

### R3a スマホの下のバーと見出し

- 触る: `c-shell.js`（`bottomModel`・`BottomBar` の `hand`、`topModel`・`TopBar` の phone の `hd`）、`c-shell.css`、`c-app.js`（`barPages` に あなたの番 の未読の印）、`shell.js`（`renderBottom`・`topState`）、`c-gallery.js`、テスト 2 つ、`ui-shots.ts`。
- 受け入れ:
  - スマホの `#v3-foot` のボタンは 3 つ（`data-act="page"` だけ。`data-act="hand"` が無い）。
  - 右腕が未読で番でなく、右腕が見えていないとき、［あなたの番］のボタンに未読の印が 1 つ。右腕を開くと消える。読み上げの名前に「未読」が入る。
  - スマホの会話の見出しに `data-act="hand"` が無い。
  - スマホで枠（`#v3-hand`）を開く口が無い（§7 の但し書きの 2 つの道、幅をまたいで持ち越した枠と R3a より前の `v3Hand` の entry へ「進む」は残る）。
- 絵: 今の `phone-*-a-deck*`・`g-bottom` が変わるだけ。`c-hand-over` はスマホの明暗の 2 枚を R3a で消した（PC・ダークの 1 枚は R3b）。前後を PR に付ける。

### R3b 丸・枠・［広げる］・帯の［右腕］を消す

- 触る: §11.1 の一覧（`index.html`・`shell.js`・`shell.css`・`c-shell.js/.css`・`c-deck.js/.css`・`c-app.js`・`c-hand.js/.css` を消す・`gallery.html`・`c-gallery.js/.css`・`tokens.css` の `--c-hand-w`・`--c-orb`）、テスト 2 つ、`ui-shots.ts`。
- 受け入れ:
  - `index.html` に `v3-orb`・`c-orb-root`・`v3-hand`・`c-hand-root`・`v3-hand-backdrop` の id が無い。`#v3` に `data-hand`・`data-hand-mode` が無い。
  - `src/web/static/` に `c-hand.js`・`c-hand.css` が無く、どのファイルも import・link しない。`HandOrb`・`HandHead`・`drawOrb`・`v3Hand` の字が `src/web/static/`（`classic.html` の側を除く）に無い。
  - 640px 以上のどの幅でも、上の帯に `data-act="hand"` が無い。席だけの幅で席を開いても無い。
  - `history.state` が `{ v3Hand: true }` の entry に戻っても例外が出ず、列か席の今の形のまま。
  - 落ち先（`SA.deck` を外して試す）: 一覧の一番上の行から右腕が列 2 に開く。
  - 古い殻 `/static/classic.html` の console に error が無い（今の古い殻の絵が変わらない）。
  - Ctrl+K・Escape が席に右腕を開いた状態で話題のときと同じに動く。
- 絵: §11.3 の 4 種類を消す。`c-hand-seat` を `a-deck-hand` に改名。前後を PR に付ける。

### R4 通り道を外す

- 触る: `c-deck.js`（`DECK.LANE`・`stripFit`）、`shell.css`（`365`・`421–425`）、`tokens.css`、`test/web-components.test.ts`（`4488`・`5335`）、`ui-shots.ts`（通り道の検査）、`docs/plan/web-ui-pins.md` §4.2。
- 受け入れ: §10 の表の値。帯が出ているとき、`#v3-deck` の右端が 席が開いていれば席の左端 − 8、閉じていれば `#v3` の右端。番の列の中身の末尾の余白が `--space-2`。`--c-deck-lane`・`DECK.LANE` の字が無い。
- 絵: `a-deck-pins-wide`・`a-deck-pins-wide-end` が変わる（前後を付ける）。

### R5 サーバー（再起動が要る）

- 触る: `src/web/routes/topics.ts`（§6.1 の 3 点）、`test/web-topics.test.ts`、`docs/plan/web-ui-pins.md`（口の節）。
- 受け入れ（テストで）:
  - 右腕の id に `on: true` → 200。応答の `handPins` にその channelId、`pins` には無い。話題を 4 つ留めた後でも 200（409 にならない）。
  - 右腕を留めた後に話題を 4 つ留められる（5 つ目が 409）。`pinMax` は 4 のまま。
  - `on: false` で `handPins` から消える。GET `/api/topics` に `handPins` が在る。pins の配線が無ければ `[]`。
  - 右腕でも話題でもない id は今と同じ 404。`src/app/`・`src/agent/`・`src/store/` に差分が無い。
- 再起動: merge の後、オーナーに訊いてから。DB の版は変わらない（戻せる）。

### R6 右腕を留める画面

- 触る: `topics.js`（`hand`・`handPinned`・`handPinnable`・`pinColumns`・`setPins`）、`shell.js`（`pinRow`・`seatPin`・`pinFit`・`pinnedSeat`・`handSeatTop`・`openHandMenu`・`syncHand`・`PINS_ON` に `frame`・`top`）、`pins.js`（`sync` が `pinColumns()` を使う・`frame`・`top` を訊く）、
  `test/web-static.test.ts`、`ui-shots.ts`。`open` と `flows.js` は変えていない（留めた話題の分かれ道と `seen` にそのまま乗る）。`test/web-components.test.ts` も変えていない（部品に触れていない）。
- 受け入れ:
  - `handPins` が応答に無いとき、右腕の席の見出しに `data-act="pin"` が無く、「…」にピンの行が無い。
  - 在るとき: 席の右腕のピンのボタンを押すと席が閉じ、`#v3-pins` の最初の子が右腕の列（`[data-pin="<右腕>"]`）。見出しの題が「右腕」、入力欄の placeholder が「右腕に頼む・訊く」。
  - 話題を 4 つ留めていても右腕を留められ、右腕を留めていても話題を 4 つ留められる（上限の理由の行は話題 4 つで出る）。
  - 列が端まで見えている間、一番上の行に `data-current="true"`、行を押すと列の入力欄に焦点。節「ピン留め」に右腕の行が無い。
  - 右腕の列と席の両方に右腕の会話が在る状態にならない（幅を変えても）。席だけの幅・スマホでは席・全画面に開く。
  - 列の「ピン留めを外す」で列が消え、行は残る。
- 絵: PC・ダークの `a-deck-pins-hand` を 1 枚足す。

### R7 片付け

- 触る: `docs/plan/web-ui-deck.md`（§6.4 を「#514 で置き換えた」に・絵・段の表）、`docs/plan/web-ui-pins.md`（§4.8〜§4.10・§5.1・§6.2・§6.3）、`docs/design/WEB-UI-GUIDELINES.md`（accent の塗りの一覧・帯・下のバー・右腕の枠と丸の行・浮いたボタンの例外）、
  `docs/plan/web-ui-components.md`（HandHead・HandOrb・BottomBar・TopBar の行）、`docs/directory-structure.md`、`CLAUDE.md`、`topics.js` の `turnFrom` まわりのコメント。
- 受け入れ: 文書に「右腕の丸」「［広げる］」「通り道」が今の形として残っていない（経緯として残す所は「#514 で消した」と書く）。

## 15. 決まった事・決まっていない事

| 事 | 状態 | 決める人 |
|---|---|---|
| §1 の 6 つ | 決定 | オーナー（済） |
| §12 の既定 1〜7 | 既定（違えば直す） | オーナー（黙っていれば既定） |
| スマホの見出しの［右腕］（問い 1） | 決定: 外す（2026-11-26） | オーナー（済） |
| 「いま見ている話題」の 1 行（問い 2） | 決定: やめる（2026-11-26） | オーナー（済） |
| R5 の後の再起動の時 | 未決 | オーナー（merge の後に訊く） |
| サーバーが 2 つ以上のときの 2 行目 | 範囲外 | 要るようになってから |

## 16. 確かめていない事（推測と分けて）

- 何も走らせていない（`npm test`・`npm run ui-shots`・dev サーバ）。上の受け入れ条件は読んだコードからの組み立て。
- #507 の P5 が入った後の行番号と、P5 が帯の題に足す物の正確な形。
- 落ち先の形（`SA.deck` が無い）が本番で実際に通るか。推測: `c-app.js` が途中で失敗したときだけ。
- 部品の見出し（`SA.top`）が描けないときの席の右腕の見出し（chat.js の古い見出しに落ちるはずだが、読んで追い切っていない）。
- `.c-col-top` を足したときの列の高さの取り方（列の中身のスクロールが今の CSS のまま縮むか）。R1 の見本で確かめる。
- スマホの実機での見え方・指の届き方、読み上げでの行の読まれ方。
- 消すテストの正確な本数（§11.2 は当たりを付けた行で、全部ではない）。
