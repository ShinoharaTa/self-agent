# Web UI の音（#335）: エージェントの状態の変化を短い音で知らせる — v1

> 対象: `src/web/static/`（素の JS・依存なし・CSP `default-src 'self'`）。Discord には出さない。
> 「事実」= 2026-11-12 の main のコードで確かめたこと。「推測」= 実機で確かめていないこと。

## 0. 何のために

- オーナーが Web の画面を開いているとき、エージェントが**受け付けた・手順を進めている・判断を待っている・返事をした**を、画面を見ていなくても分かるようにする。目的は「生きている感じ」で、通知の代わりではない。
- 性格 A「夜勤の計器盤」（GUIDELINES §1）の音の側: 計器の接点音（リレーのカチッという短い刻み）と、小さな指示灯のような柔らかい単音。メロディ・ジングル・残響・ステレオの動き・声は使わない。

## 1. 確かめた事実（コード）

| # | 事実 | 場所 |
|---|---|---|
| F1 | `/api/running` は実行中のターンの配列（`channelId・turnSeq・startedAt・toolCalls・label・steps・source・abortable・waitingPermission?・elapsedMs`）。画面は実行中があれば 2 秒・無ければ 10 秒ごとに読み、`applyRunning` で前回との差を計算している | handler.ts の RunningTurn、web/routes/turns.ts、static/api.js |
| F2 | polling は `document.visibilityState === "visible"` のときだけ。戻ったら `schedule()` で全部を 1 回読む | api.js の `active()`・`schedule()` |
| F3 | history の agent の行の `outcome` は `done / max_turns / aborted / failed`。前に出ている会話の `/turns` は 5 秒（許可の保留中は 3 秒）ごと。`channel.permission`・`channel.closeDraft` もここで届く | store/history.ts、api.js の load.turns |
| F4 | `/api/cc/sessions` は見ている間だけ 10 秒（許可の保留中は 3 秒）ごと。`state（needs_input / running / idle）・since・permission・pending` を持つ。`sameCcList` で差を見ている | api.js の load.cc、web/routes/cc.ts |
| F5 | Web から送ると 202 `{ turnId, link }`。turnId は history の owner の行の id で turnSeq ではない | handler.ts の submitText |
| F6 | 手順の label は固定の語（「コマンドを実行しています」など） | agent/sdk-runner.ts |
| F7 | `/api/status` に effort・model は無い | web/routes/status.ts |
| F8 | 設定の画面は views.js の renderSettings。ブラウザだけの保存は workbench.js の load/save（localStorage の `self-agent-web:<key>`） | views.js・workbench.js |
| F9 | ブラウザの JS の純関数は `vm.runInNewContext` で読んで node:test で試している | test/web-render-text.test.ts |

## 2. ブラウザの事実（Web の資料。実機は未確認）

- **自動再生**: `AudioContext` はユーザーの操作が無ければ `suspended` で始まり、操作（click / keydown / touchend）の中で `resume()` を呼ぶと動く（Chrome・iOS Safari）。
- **iOS のサイレントスイッチ**: Web Audio は既定で ambient 扱いで、スイッチがオンだと鳴らない。iOS 17 以降は `navigator.audioSession.type = "playback"` で無視できるが、**v1 は触らない（スイッチに従う）**。
- **iOS の背景**: ホームに戻ると `AudioContext.state` が `interrupted` になり、`resume()` が返らない報告がある（WebKit Bug 273511・291892）。戻ったときは `resume()` が 1 秒で settle しなければ作り直す。
- **隠れたタブ**: Chrome は隠れたタブのタイマーを絞る（5 分後には 1 分に 1 回まで）。
- **Vibration API**: iOS Safari に無いので使わない。

## 3. 拾う事象と検知のしかた（サーバーは変えない）

| 事象 | 意味 | 擬音 | self-agent のチャンネル（入口・セッション） | Claude Code（cc の行・チャンネル） |
|---|---|---|---|---|
| `start` | 受け付けて考え始めた | ぽ | `/api/running` に新しい turnSeq が現れた。Web から送ったときは 202 の時点で鳴らし、そのチャンネルの次の `start` は 10 秒抑える | 一覧の `state` が `idle/needs_input → running`、または `pending.state` が `delivered` になった |
| `tick` | 手順（ツール）を始めた | こっ / ここっ | 同じ turnSeq で `toolCalls` が増えた。増分 1 → こっ、2 以上 → ここっ。label が「コマンドを実行しています」なら低いこっ | 拾わない（手順の数が無い） |
| `ask` | オーナーの判断を待っている | ぽぴぽぴん（低い・高いを 2 回。最後だけ上がって残る） | (a) `waitingPermission` が無 → 有。(b) `/turns` の `channel.permission.state` が `pending`（id で 1 回）。(c) 最後の agent の行が `max_turns`。(d) `channel.closeDraft` が現れた | 一覧の `state` が `needs_input` になった（`sessionId + since` で 1 回）。`permission.state === "pending"`（id で 1 回。質問も同じ） |
| `reply` | 返事を返した | ピポパッ（上がる 3 音。最後は短く切る） | running から turnSeq が消えた（outcome は待たない）。後から `failed` と分かれば `fail` を 1 回 | 一覧の `state` が `running → idle`、または前に出ている cc のチャンネルの `/turns` に新しい agent の行（同じセッションで 15 秒は 1 回） |
| `fail` | 止まった | ぼ（低く短く） | agent の行の `outcome === "failed"`。`aborted` は鳴らさない | 一覧の `pending.state` が `failed / gave_up` |

- 検知の置き場所: `ui.js` に `SA.events = { on, emit }`（例外は握って log）。`api.js` が `running(prev, next, meta)`（applyRunning の先頭）・`turns(channelId, rows, before, after)`（load.turns の増分）・`cc(prev, next, meta)`（load.cc で sameCcList が false のとき）を、`chat.js` が `sent(channelId)`（202 の後）を emit する。音の判定と再生は `sound.js` に閉じる。
- **catch-up**: `meta.catchUp`（最初の読み取りか、visible に戻ってから最初の結果）では `start/tick/reply/fail` を鳴らさない。`ask` だけは、その時点で pending のものを 1 回ずつ鳴らす。
- **隠れたタブ（決定: 鳴らす）**: 音がオンで隠れている間も、`/api/running` と `/api/cc/sessions`（Claude Code が有効なときだけ）を 10 秒ごとに読み続け、同じ判定で鳴らす。ただし `tick` は鳴らさない（前に出ている会話だけなので）。音がオフなら今までどおり止める。隠れている間の結果は catch-up ではない（読み続けているので差は小さい）。visible に戻った直後の 1 回だけ catch-up。

## 4. うるさくしない規則（純関数で持つ）

1. **優先と合流**: 同じ結果から複数の事象が出たら 1 つにまとめる。優先は `ask > fail > reply > start > tick`。`start` と `reply` が 1 秒以内に続くなら `reply` だけ。
2. **tick の間引き**: チャンネルごとに 1 回の結果で 1 回まで。増分 2 以上はまとめて「ここっ」。tick は前に出ている会話だけ（設定によらず）。
3. **全体の上限**: 音と音の間は 250 ms 以上。10 秒に 6 回を超えたら tick から落とす。待ち行列は持たない（捨てる）。
4. **同じ ask は 1 回**: 許可は id、cc の判断待ちは `sessionId + since`、max_turns は行の id、closeDraft はチャンネル + 出た時刻で覚える（このタブのメモリ）。
5. **音量の天井**: マスターの gain は 0.3 × 音量の段（小 0.35・中 0.6・大 1.0）。同時に鳴るのは 1 つ。
6. **長さ**: 1 音は 250 ms 以内、`ask` だけ 400 ms 以内。ConvolverNode・ディレイ・パン・ビブラートは使わない。（§6.3 の試聴ページの音に合わせたので、実装は 1 音（立ち上がり + 減衰）400 ms 以内で確かめている。硝子の 1 音 0.28 秒・判断待ちの最後の 0.3 秒が 250 ms を超える）
7. **自分の操作に音を付けない**: ボタンの押下・送信の UI 音は作らない。

## 5. 考えの深さ（今の API で取れるもの）

| 指標 | 取り方 | 音への反映 |
|---|---|---|
| 手順の数 `toolCalls` | `/api/running`（tick の時点の値。reply は消える直前の値） | 音域: 0〜1 → 基準、2〜5 → −2 半音、6〜15 → −5、16 以上 → −7（移調だけ。reply の音は深さによらず 3 音） |
| コマンドか | label が「コマンドを実行しています」 | tick の基音 1800 Hz → 1200 Hz |

- cc のセッションは手順の数が無いので、cc の reply は移調しない（同じ 3 音）。
- 経過時間は音に出さない（2026-11-12 のオーナーの指示で、返事の音数と長いターンの余韻をやめた）。
- effort（人格ごとの基準の音域）は後の段（§9 の S4）。`/api/status` に足す必要がある。

## 6. 音の作り方（Web Audio API で合成。音源ファイルは置かない）

### 6.1 パラメータの形（純関数 `pattern(event, depth)` が返すデータ）

```
Pattern = { name: string, voices: Voice[] }
Voice   = { t: 秒（開始）, kind: "tone", f0: Hz, f1?: Hz（t+a までに滑る先）, a: 秒（立ち上がり）, d: 秒（減衰）, g: 0〜1, wave?: "sine"|"triangle" }
        | { t, kind: "tick", f: Hz, d: 秒, g, noise?: { fc: Hz, q: number, d: 秒, g } }
```

再生（`play(pattern, level)`）は Voice ごとに `OscillatorNode`（tick は 0.1 秒の白色雑音の `AudioBuffer` を `BiquadFilter(bandpass)` に通したものを足す）→ `GainNode`（`setValueAtTime` → `exponentialRampToValueAtTime` の包絡）→ マスター `GainNode` → `destination`。`ctx.currentTime + 0.02` を起点に予約する。

### 6.2 擬音の初期値（実機で耳で合わせてよい）

| 擬音 | 事象 | 構成 |
|---|---|---|
| ぽ | start | tone: 740 → 880 Hz（a 0.008）、d 0.12、g 0.8 |
| ぴん | （部品） | tone: 1175 → 1109 Hz、a 0.005、d 0.22、g 0.7 |
| ぽぴぽぴん | ask | 基準・+7・基準・+7 半音を 0.09 秒おき。最初の 3 音は長さ 0.07、最後の音は 0.3 で +9 へ滑る（水滴は滑らない）。強さ 0.75 / 0.7 / 0.75 / 0.75。1 回だけ |
| こっ | tick | tick: f 1800、d 0.018、g 0.9 + noise { fc 2500, q 4, d 0.012, g 0.4 }。コマンドなら f 1200 |
| ここっ | tick（増分 2 以上） | こっ（t 0）+ こっ（t 0.07） |
| ピポパッ | reply | 基準・+4・+7 半音の上がる 3 音を 0.085 秒おき。長さ 0.07 / 0.07 / 0.06、強さは最後だけ 0.8（ほか 0.65）。深さは移調だけ |
| ぼ | fail | tone: triangle 220 Hz、a 0.01、d 0.2、g 0.6 |

音域の移調（§5）は基準の高さに `2^(semitone/12)` を掛ける（§6.3 の組み立てで。純関数 `transpose` は作らず `pattern` の中で行う）。

### 6.3 音の種類（5 つ。試聴ページと同じ音）

- オーナーに渡した試聴ページ（sound-audition.html）の音を sound.js の `THEMES` にそのまま移した。ページと Web 画面で同じ音になることを優先し、§6.1・§6.2 の表はこの組み立てに置き換わる。
- 種類: `relay`（接点。正弦波とカチッという短い雑音）・`wood`（木。倍音が先に消える丸い打音）・`drop`（水滴。半音上から落ちて止まる）・`glass`（硝子。小さく澄んだ鈴）・`felt`（フェルト。低い三角波を low-pass に通す。手順は雑音だけ）。
- テーマは `base`（基準の高さ）・`gain`・`tone`（wave・a・d・partials・drop・lp）・`tick`（f・d・g・partials・drop・noise・noiseOnly）。組み立て（`pattern`）: start は基準の 1 音（3 半音上へ滑る。drop は滑らない）、ask は §6.2 の「ぽぴぽぴん」、reply は §6.2 の「ピポパッ」（どちらも 1 音はテーマの tone で鳴らす）、fail は基準の 14 半音下の三角波（移調しない）、tick のコマンドは 0.67 倍。移調は §5 のとおり基準に掛ける。
- 再生の単位は `{ kind: "osc", f, wave, a, d, g, drop?, glideTo?, lp? }` と `{ kind: "noise", fc, q, d, g }`。包絡は t から a で g、t + a + d で消える。マスターは 0.3 × 音量。
- テーマは表に足せば増やせる。

## 7. 設定

| 項目 | 値 | 既定 |
|---|---|---|
| 音を鳴らす | オン / オフ | オフ（自動再生の制限があるので、オンにする操作を最初の解除にする。オンにした瞬間に AudioContext を作って resume し、ぽぴぽぴんを 1 回鳴らす） |
| 音の種類（事象ごと） | 受け付け・手順・判断待ち・返事・失敗のそれぞれに §6.3 の 5 つから（組み合わせ） | 全部 接点（オーナーの選んだ組み合わせが来たら差し替える） |
| 音量 | 小 / 中 / 大 | 中 |
| 手順の音（こっ） | オン / オフ | オン |
| 鳴らす会話 | 前に出ている会話 / すべての会話 | すべての会話 |
| 判断待ちはいつも鳴らす | オン / オフ | オン（「前に出ている会話」のときも ask は全部） |

- 置き場所: 設定のタブの「この画面の表示」の次に節「音」（kv-list と [試す]）。[試す] は事象ごと（受け付け・手順・判断待ち・返事（浅い）・返事（深い）・失敗）に今の組み合わせで鳴らし、音を鳴らすがオフでも鳴る（押す操作で AudioContext を作る）。保存は localStorage の `self-agent-web:sound`（このブラウザだけ。形は `{ enabled, volume, combo: { start, tick, ask, reply, fail }, ticks, scope, askAlways }`。形の違う JSON・値・無い id は既定に戻す。combo は事象ごと）。meta の文は「表示と音の設定はこのブラウザにだけ残ります。」に。パレットに「音を切り替える」。
- 画面の操作の前（AudioContext が無い・suspended）: 事象は捨てる。節の下に「次に画面を操作したときから鳴ります。」をその状態のときだけ出す。解除は `pointerdown`・`keydown` を document で 1 回だけ捕まえて resume。
- visible に戻ったとき `ctx.state` が interrupted / suspended なら次の操作で resume、1 秒で settle しなければ作り直す。
- iOS のサイレントスイッチ: 従う（`audioSession.type` は触らない）。節に 1 文「iPhone ではサイレントスイッチがオンのときは鳴りません。」。
- `prefers-reduced-motion` とは連動しない。
- 複数のタブ・窓: それぞれ鳴る（既知の制約。対策は作らない）。
- 音が鳴ったことを画面に出さない。音だけで伝える情報を作らない（同じ事象は画面にも出ている）。

## 8. GUIDELINES に足す（§6.2 音・§7 の語彙）

- 音は「生きている点」の聴覚の側で、事象の合図に限る。装飾・BGM・操作音・成功のファンファーレを作らない。
- 1 つの音色の家族（正弦波の単音 + 短い接点音）だけ。メロディ・和音・残響・パン・声・既製のチャイムは使わない。1 音は 250 ms 以内（問いかけは 400 ms）。
- 深さは音域で表し、音量や速さで表さない。急かす音を作らない。
- 既定はオフ。設定のタブ以外に音の UI を置かない。音だけで伝える情報を作らない。
- `prefers-reduced-motion` と連動しない。iOS のサイレントスイッチに従う。
- 語彙: 「音 / 音を鳴らす」（通知音・サウンド・効果音と言わない）、「試す」（テスト・プレビューと言わない）、「判断待ち」（許可・質問・[続ける]・/close の確認を合わせた呼び方）。

## 9. 段とテスト

| 段 | 中身 |
|---|---|
| S1 | `SA.events`、api.js・chat.js の emit、`sound.js`（純関数・再生・解除）、設定の節「音」、self-agent のチャンネルの start・tick・ask・reply・fail、§4 の規則、§5 の深さ、隠れたタブの読み続け、GUIDELINES と CLAUDE.md |
| S2 | Claude Code（`cc` の emit・`decideCc`・cc のチャンネルの agent の行・15 秒の重複の抑え） |
| S4（任意） | `/api/status` の effort → 人格ごとの音域 |

- テスト: `test/web-sound.test.ts` で `sound.js` を `vm.runInNewContext` で読み（AudioContext は置かない）、純関数（`window.SA.sound.pure`）を確かめる: decideRunning・decideTurns・decideCc・coalesce（時計は引数）・pattern（音の並び・周波数・長さの上限・gain ≤ 1。全テーマが全事象を持つ）・設定の読み書き（組み合わせを含む）。
- 再生は自動テストしない。受け入れは実機（iPhone の Safari と PWA・PC の Chrome / Firefox）:
  - [ ] 既定で鳴らない。オンにした瞬間に 1 回鳴る
  - [ ] 再読み込み後、最初の操作まで鳴らず、操作の後に鳴る
  - [ ] Discord から発言 → ぽ、手順でこっ、終わってピポパッ。失敗はぼ。中断は無音
  - [ ] 許可の要求・質問・[続ける]・/close の確認でぽぴぽぴんが 1 回だけ。描き直しで鳴り直さない
  - [ ] PC で別のタブを見ている間も、ターンの始まり・返事・判断待ちで鳴る（手順の音は鳴らない）
  - [ ] 手順が続いても 2 秒に 1 回、10 秒に 6 回まで
  - [ ] iPhone でサイレントスイッチがオンなら鳴らない。ホームから戻った後も次の操作で鳴る

## 10. 決定（2026-11-12 オーナー）

- 対象は self-agent のチャンネルと Claude Code の両方。サーバーは変えない（effort は S4）。
- 合成（Web Audio）。事象は 5 つ（start / tick / ask / reply / fail）。深さは手順の数で、音域に出す（2026-11-12 に音数と長いターンの余韻をやめた）。
- 既定オフ・音量 3 段・手順の音は既定オン・すべての会話・判断待ちはいつも。
- **隠れたタブでも鳴らす**（音がオンのときだけ 10 秒ごとに読み続ける。tick は除く）。
- **iPhone のサイレントスイッチに従う**。
- （2026-11-12 追加）音の種類は試聴ページの 5 つ（接点・木・水滴・硝子・フェルト）で、ページと同じ音にする。事象ごとに選べる組み合わせにする（既定は今は全部 接点）。
- （2026-11-12 追加）音がオンなら、見えている間も会話の一覧や cc のタブを出していなくても `/api/cc/sessions` を 10 秒ごと（許可の保留中は 3 秒）に読む（隠れたタブと同じ）。オフなら今までどおり見ている間だけ。cc のタブの入力欄から送った 202 も `sent`（key は `cc:<sessionId>`）にし、そのセッションの次の start を 10 秒抑える。
