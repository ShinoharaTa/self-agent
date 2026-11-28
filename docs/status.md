# 段の進み具合（今の状態）

各設計の段がどこまで main に入ったかの記録。**段を進めた PR でここを直す。`CLAUDE.md` には足さない**（`CLAUDE.md` は毎回すべて読み込まれる）。

- 何の設計がどの文書かの一覧は `CLAUDE.md` の「設計書」の表
- 段の中身と理由は各設計書（`docs/plan/*.md`）。ファイルごとの役割は `docs/directory-structure.md`
- 必要な節だけ grep して読む（例: `grep -n "^## " docs/status.md`）

## 人格（#114）

- 人格（1 プロセスに複数の Bot・共有 DB・codex）の設計: `docs/plan/personas.md`（#114）。今は 2 体目以降も Claude で動く（入口 #<NAME>・/new の persona・#<NAME> の session_open まで）。codex のエンジンはまだ無い

## 定型チャンネル（#119）

- 定型チャンネル（領収書・予定など）・#inbox からの引き渡し・画像の受け取り・スキルの設計: `docs/plan/routines.md`（#119。今は DB の表とストア（PR-R1）と画像の受け取り（PR-R2）まで。定型チャンネルの振る舞いはまだ無い）

## GitHub の通知（#122）

- GitHub の通知を #github に流し、Claude Code のセッションに渡す設計: `docs/plan/github-notifications.md`（#122。段 1（ポーリングと #github。PR-G2）まで。［対応］は PR・Issue ごとの話題（プロジェクトのセッション）を作る（H5。SELF_AGENT_CC=1 と unify-setup が要る）。端末のセッションへ送る古い経路はコードに残るが、配線していない）

## シェル（Bash）

- シェル（Bash）を使えるようにする設計: `docs/plan/shell.md`。`SELF_AGENT_SHELL=1` のときだけ、セッションのチャンネルのプロジェクトの中で SDK の sandbox（bwrap）付きの Bash を使える（自己診断が通らなければ止める）。受け入れの実機確認は `npm run shell-check`

## 作業ジョブ（#129。保留）

- サーバー上で動く作業ジョブ（Discord から頼むとリポジトリを実装して draft PR を返す）の設計: `docs/plan/coding-jobs.md`（#129。保留（2026-11-01）。PR-J4 は畳む（docs/plan/unify.md §8 の 5）。今あるのは設定・DB の表・状態の遷移と #jobs の文面（PR-J1）、host 側の git と gh の包み（PR-J2）、ジョブの進行・#jobs・`/job`・ボタンと偽 Runner の dry-run（PR-J3）まで。ジョブ用の runner（PR-J4）は作らないので `SELF_AGENT_JOBS=1` は設定エラーのまま）

## ゲスト利用の簡易モード（#147）

- 他の Discord サーバーで、オーナー以外の人にツールなし・Opus 5.5 low で答える「ゲスト利用の簡易モード」の設計: `docs/plan/guest-mode.md`（#147。v3。ゲスト専用の Bot・API キー認証・サーバーの許可（メインサーバーの `/guests invite` で発行する認証コードを、ゲストのサーバーの管理者が定型文への返信で貼る。DB `guest_guilds`）と `/guest on` の二段構え。今は GU4b まで（運用の手順と接続の知らせは GU3）。`SELF_AGENT_GUEST_GUILD_IDS` は廃止で、残っていれば設定エラー）

## 配布と Web UI（#157）

- 配布（npm）・入口の統一・Mac 対応の設計: `docs/plan/distribution.md`（#157）。Web UI（tailnet の中のブラウザから使う VS Code 風の Web アプリ。別ポート・`Tailscale-User-Login` 必須）の設計: `docs/plan/web-ui.md`（#157。v2。段 W1〜W8 は #162〜#173。今は W7 まで実装済み（ジョブの画面 W8 は、作業ジョブを保留して PR-J4 を畳んだので作らない）。右腕のツール（M6）: #inbox から場所を選んで話題を始める・一覧・場所を変える確認）。入口は入れ替え済み（M8。`/` が新しい殻（`docs/plan/web-ui-v3.md`）。古い殻は `/static/classic.html` で M8b で消す。設定の「画面」から行き来）

## 端末の Claude Code のセッション（#191・#265・#236）

- この機械の Claude Code（CLI）の対話セッションを一覧・送信・起動し、許可の要求に Web・Discord から答える設計: `docs/plan/claude-code-sessions.md`（#191。設計は確定。Claude Code の質問（AskUserQuestion）を Discord・Web の選択肢で答え、セッションの知らせを #system に出さず要ったときにチャンネルを作る設計: `docs/plan/claude-code-questions.md`（#265。段 Q5・Q1〜Q4。
Q5 と Q1〜Q4 はすべて済み。Q4 は許可の要求・質問・判断待ちを #system に出さず、そのセッションの Claude Code のチャンネルに出す。無ければ ensureFor で作る（tmux の外も）。作れなければ log だけ。DB の cc_channels.origin に question・waiting（v39））まで。Q3・Q5 は別 PR）

CC9〜CC14 すべて済み（CC9〜CC14 は docs/plan/claude-code-channels.md。CC1 の状態の収集: claude agents --json の周期の読み取り・DB の cc_sessions・hook の受け口・`npm run cc-dry-run`・`npm run cc-setup -- --print`。CC2 の Web UI の一覧と画面の写し: `/api/cc/sessions`・`/api/cc/sessions/<id>`・一覧（CC9 から会話のサイドバーの群「Claude Code」）。CC3 の Web からの送信（複数行）: DB の cc_sends と待ち行列・`/api/cc/sessions/<id>/send`・`/api/cc/sends/<id>/cancel`・セッションのタブの入力欄。CC4 の起動: `SELF_AGENT_WORKSPACE_DIR` の直下に tmux の新しいセッションで claude を起動する `/api/cc/projects`・`POST /api/cc/sessions` と起動のダイアログ、最初の指示（cc_sends のペイン宛て）、DB の cc_sessions の started_by など（v29）。CC5a の許可の要求の保留と Web からの [許可]・[拒否]: DB の cc_permissions（v30）・cc/permission-hold.ts・`/api/cc/permissions`・セッションのタブの許可のカード。CC5b の「このセッションでは常に許可」: cc/permissions.ts の線引き・cc_permissions.always_rules（v31）・`/always`・カードのボタン。CC5c の Discord: #system の許可の要求の 1 通とボタン `cc:perm:allow|always|deny:<id>`（app/commands/cc.ts）・判断待ちの知らせ・self-agent が起動したセッションの終了（Q4 で #system をやめ、文面は cc/notice-text.ts）・DB の cc_permissions.message_id・cc_sessions.notified_at（v32）・`SELF_AGENT_CC_NOTIFY`）。CC6 の GitHub の通知の [対応]: app/github-handoff.ts・`gh:` のボタン・`/api/github/<id>/act`・`/start`、DB の cc_sends.notification_id（v33）。CC7 の SDK のツール: cc_list・cc_send・cc_start と、頼んだチャンネルへの確認の投稿と [送る]・[起動する]・[やめる]（`cc:`。振り分けは app/commands/cc.ts。10 分で失効）・DB の cc_starts と cc_sends・cc_sessions の channel_id など（v34）。CC8 の返事を Discord に戻す（追いかけ）: cc/replies.ts・Stop の last_assistant_message・[追いかけをやめる]（`cc:unfollow:`）・`POST /api/cc/sessions/<id>/unfollow`・DB の cc_replies と cc_sessions の follow の列・cc_sends の reply_state（v35）。段 CC1〜CC8（CC5 は a〜c に分ける）。作業ジョブの PR-J4 は畳んだ（保留））。会話欄への統合とセッションごとの Discord のチャンネルの設計: `docs/plan/claude-code-channels.md`（#236。段 CC9〜CC14。設計は確定。
CC9 は済（Web の会話のサイドバーの群「Claude Code」。アクティビティ「Claude Code」は消した）。CC10 も済（DB の cc_channels と guild_settings.cc_category_id（v36）・/setup のカテゴリ「Claude Code」・cc/channels.ts・手動の口（Web のセッションのタブの [Discord のチャンネルを作る] と `POST /api/cc/sessions/<id>/channel`・`/cc open`）・再同期・一覧から消えたら完了へ移し、同じ session_id が戻れば開き直す。CC11 も済（DB の cc_sends の origin に discord（v37。表の作り直し）・関わったら自動で作る（Web からの送信・起動の結びつけ・許可の応答・cc_send の [送る]・cc_start の [起動する]・[対応]。作れなくても元の処理は止めない）・チャンネルの発言を確認なしで cc_sends（origin discord。同じセッションに 5 件まで・1 pass で同じセッションに 1 件）に積んで届ける・外からの送信の写し・リアクションの印・返事はチャンネル優先（[追いかけをやめる] 無し・1 日 200 通）・`/cc cancel`）。CC12 も済（許可の要求・判断待ちはチャンネルがあればそこへ（#system には出さない。cc/channel-posts.ts と permission-hold.ts の複数の受け手）・端末・RC から打った指示の写し「（端末か RC から HH:MM）」（先頭 1,000 字。self-agent が届けたものは写さない）・SELF_AGENT_CC_NOTIFY=0 でもチャンネルには出す）。CC13 も済（終わったチャンネルの発言は、セッションが一覧にあれば（/cc close で閉じただけ）開き直して積み、無ければ積まずに [起動して続ける][やめる]（`cc:resume:`。ended → resuming の compare-and-set・そのセッションの cwd（直下だけ）で starter.launch・結びついたら session_id を付け替えて open・topic の書き換え（Gateway の setChannelTopic）・起動の失敗・結びつけられなければ ended に戻す・再起動で resuming は ended に）・`/cc close`（届け待ちも取り消す）・終わってから SELF_AGENT_DELETE_AFTER_DAYS 日の削除の確認（open に戻すと確認を外す）（#system の `cc:del:`・`cc:del:keep:`）・終了の文を §3.6 の文に）。CC14 も済（Web の会話のタブ: history にチャンネルの行（オーナーの発言・写しは owner、返事は agent、許可の要求とその結果・判断待ち・届かなかった・終わった・戻った・閉じたは notice、[起動して続ける] は divider）・`/api/channels` の kind cc・`/turns`・`POST /messages` は /send と同じ経路で積む（cc/channels.ts の submitWeb）・`POST /api/cc/channels/<id>/close`・群「Claude Code」のチャンネルのある行は会話のタブ（ch:<id>）・未読の点）。会話のサイドバーの群「Claude Code」（アクティビティは消す）、オーナーが関わった（Web から送った・起動した・許可に答えた・[送る]/[起動する]・[対応]）ときに自動で作るカテゴリ「Claude Code」の `cc-<名前>` のチャンネル、そこへの発言を確認なしで cc_sends（origin discord。5 件まで）に積みリアクションで印、返事・許可・判断待ち・終了はそのチャンネルへ、外からの送信と端末・RC の指示の写し、終わったら完了カテゴリへ移して削除の確認、戻れば開き直し、終わったチャンネルの発言は [起動して続ける]、`/cc open|cancel|close`、Web の会話のタブ（history）。DB は v36〜v37）

## Web UI の見た目の決まりと磨き（#225・#248）

- Web UI の見た目の決まり（色・型・間隔・部品・動き・言葉・a11y・AI っぽさの禁止。性格は A「夜勤の計器盤」）: `docs/design/WEB-UI-GUIDELINES.md`（#225）。今の画面との差と段 UI-1〜UI-6（順は UI-6 → UI-1 → UI-2 → UI-3 → UI-4 → UI-5）: `docs/plan/web-ui-polish.md`。PWA は `docs/plan/web-ui.md` §11（#224。https の tailscale serve だけが対象）。UI-1〜UI-6 はすべて済み。スマホの第 2 回（#248。fix・UI-7〜UI-12）は同じファイルの §5 で、すべて済み（実機での確認は polish.md §5 の「実機で確かめること」）

## 流れの列（Deck 風。#463）

- Web UI を流れの列（あなたの番・タスク・通知）と横のスレッドに差し替える設計（Deck 風）: `docs/plan/web-ui-deck.md`（#463。段 D0〜D10。今は D4 まで: 640px 以上が 上の帯 + 流れの 3 列 + 席（`c-deck`・`flows.js`）、一覧は「探す」の板、列の中の操作（タスクの完了 +［取り消す］・GitHub の［対応］・リマインドの［次を飛ばす］［止める］（#472 の PR-1））。スマホは 3 列の横送りと下のバー（D2。入口の下のバーの口が無ければ今の形）。D3 = 線をやめて面で区切る（台 = 地 `--bg`（2026-11-23 に地の色ごと変えた。`--bench` は消した）・席は板・カードは番の面 + 左 3px・板は枠なしで幕で区切る・一覧の群と行の間は余白・入力の欄の地は `--muted`）。D4 = 会話の行を吹き出しでなくす（返事は地なしの文・自分の発言は `--muted` の面で左寄せ・コードは `--muted` の面。右腕も同じ。`c-talk.css` だけ）。D5 は PR-1（席が開く動き）まで。D6 の丸・枠・［広げる］は #514 で消した）

## ピン留めの列（#507）

- 話題をピン留めして、会話ごとの列として流れの列の右に並べる設計（帯ごと横に送る。スマホは あなたの番 の節「ピン留め」だけ）: `docs/plan/web-ui-pins.md`（#507。段 P0〜P5。今は P5 まで（段は全部済み。サーバー: DB の `topic_pins`（v48）と口。画面: 「…」の板の行と節「ピン留め」。スマホの形はここまで。部品と幅の算数（`stripFit`・`stripSeen`・見出しのピンのボタン・口 `SA.pin`）。640px 以上で留めた話題が帯（`#v3-deck`）の中の会話の列になる（`pins.js`・`#v3-pins`・`#v3` の `data-pins`。帯ごと横に送る・見えている列だけ既読・留めた話題は席に開かずその列へ送る・席と列の見出しのピンのボタン）。番の列を送って隠すと上の帯に「あなたの番 n」、上限の時は席のピンのボタンが押せず理由を出し、新しく留めた列だけ右から出る（P5）））

## 右腕の行（#514）

- 右腕を あなたの番 の列の一番上の固定の行にする設計: `docs/plan/web-ui-hand-row.md`（#514。段 R0〜R7 は全部済み。入口は あなたの番 の列と「探す」の板の一番上の行で、ほかの話題と同じに席（スマホは全画面）に開く。丸・枠・［広げる］は無い。右腕は上限の外で留められ、会話の列の先頭に出る）

## 部品での作り直し（#349）

- 新しい殻を部品（Preact + htm をビルドなしで同梱）で作り直す設計: `docs/plan/web-ui-components.md`（#349。段 K0〜K9。今は K6 まで: 画面写し `npm run ui-shots`（K0）と、同梱 `npm run vendor-web`・見本のページ `/static/gallery.html`（K1）、寸法のトークン `--c-*`（tokens.css の末尾）・小さい部品 `c-atoms`・板と確認と知らせ `c-sheet`・見張りのテスト `test/web-components.test.ts`（K2）、一覧と下のバーの部品 `c-list`・`c-shell`（K3a）。新しい殻の一覧の列（あなたの番・群・行・下のバー）は部品が描く（入口 `c-app.js`）。会話の見出しの部品 `c-shell` の TopBar（広い幅の compact も）と見本の節（K4）。本番の列 2 の見出しも TopBar（入口の `SA.top`。#398）。会話の部品 `c-talk` と見本の節（K4）。本番の新しい殻の会話の行も部品が描く（入口の `SA.talk`。#399）。入力欄は部品（`c-composer`。口 `SA.composer`。#406）。［続ける］は会話の行の一番下（K5b）。話題・プロジェクトのセッション・Claude Code のチャンネルのカード・待ちの行・状態の行・文は部品（`c-cards`。口 `SA.cards`。#406。Claude Code のチャンネルの送った本文の帯は入力欄の部品）。知らせ・確認は部品（`c-sheet` の Toast・Confirm。口 `SA.notice`・`SA.ask`。橋は `ui.js`）。右腕の中も部品（会話・入力欄・カードは列 2 と同じ口、札 `Refs`。#422。見出し `c-hand`・口 `SA.hand` は #514 で消し、見出しは TopBar）。端末のセッションの札は部品（`c-term`。口 `SA.term`。つなぎ `takeover.js`）。`cc:` のタブと一覧の上の見出しは古い描き方）

## 入口の統一（#277）

- 入口によらず同じエージェントにする（self-agent と Claude Code の統合）設計: `docs/plan/unify.md`（#277）。今は U1 と U2 の質問まで（プロジェクトのセッション: `/new project:<名前>` か Web の「新しいセッション」のプロジェクトで、`SELF_AGENT_WORKSPACE_DIR` の直下のプロジェクトを cwd に Claude Code と同じ装備（preset のシステムプロンプト・CLAUDE.md・skills・Bash）で動くセッションを作る。許可は canUseTool → そのチャンネルと Web の許可のカードで答え、待つ間はターンの打ち切りを止める。`SELF_AGENT_CC=1` と `npm run unify-setup -- --print` の link が要る。質問（AskUserQuestion）は Discord の選択肢のボタンと Web の質問のカードで答える。/mode まで（default・acceptEdits・plan。次の発言から））

## リモコンからの移行（#428）

- 端末の Claude Code のセッションの管理（リモコン。CC1〜CC14・Q1〜Q5）をやめ、取り込み（#341）とプロジェクトのセッションを本線にする移行の設計: `docs/plan/terminal-handover.md`（#428。段 H0〜H5 と使う期間、消す段 X1〜X5。今は H3 まで（Discord の `/cc take` と、新しい殻の端末の行の札の［取り込む］で取り込める）と H4a（プロジェクトのセッションの質問）と H4b のモード（取り込みでの許可のモードの引き継ぎも）。H5 も済（GitHub の［対応］の宛先を話題に。DB の github_topics（v46））。リモコンには手をかけない（［端末］のタブは部品にしない）。消すのは使う期間の後）

## 取り込み（#341）

- 取り込み（端末の Claude Code の会話を、プロジェクトのセッションが新しいチャンネルで引き継ぐ）の設計: `docs/plan/takeover.md`（#341。v3。段 H1a〜H1c・H2・H3。今は H3 まで（Discord の `/cc take` と、新しい殻の端末の行の札の［取り込む］で取り込める）: DB の cc_takeovers（v45）・ストア・判定の純関数・記録の写し・本体（cc/takeover.ts）・送信の守り）

## 話題のモデル（#451）

- 話題を始めるときにモデルを選ぶ設計: `docs/plan/models.md`（#451。段 PR-0〜PR-5。今は PR-2 まで: 一覧 `src/agent/models.ts`・DB v47（sessions.model・place_settings・usage_log.model）・配線と入口（`/new` の `model`・右腕 `session_open` の `model`・`POST /api/topics` の `model`。［対応］・取り込み・ホームパネルは場所の既定だけ）。場所の既定を書く口は PR-4 まで無い）

## 右腕の統括（#457）

- 右腕が統括として働く設計: `docs/plan/lead.md`（#457。段 L0〜L7。今は L2 まで: 話題の一覧のデータに順番待ち・止まった・終わり方・かかった時間、新しい殻の一覧の行の語、話題のターンの終わりの #inbox のまとめ（`app/lead.ts`・`SELF_AGENT_LEAD_*`）と Web の右腕の未読（`last.lead`）・右腕の会話でまとめの `<#ID>` を話題の名前で出す。上限・失敗で止まった話題は あなたの番 に数える（L1c の PR-3））

## Web UI の作り直しの準備（#528）

- 2026-11-27: オーナーが、今の Web UI の組み立て・見た目の質・操作感を考え直すと決めた（「情報が多い」は不満に入らない）。フロントエンドは大きく作り直す前提。サーバー側は対象外
- 2026-11-28: オーナーが方向（案 D）・進め方（B = 別の入口に作り、揃ったら入れ替える）・スマホを先・「ほか」は古い画面へ送る・いちばん古い殻（`classic.html`）を先に消す、などを決めた（`docs/plan/web-ui-rebuild.md` §7）。明暗に加えて色の組を切り替えられるようにする（#539）。統括が `docs/plan/web-ui-home.md` §6.2 の 19 個を決めた。オーナーに訊く事は同じ文書の §6.1 の 8 つ
- 今は P0（文書: `web-ui-rebuild.md` の直しと `web-ui-home.md`）まで。画面・コードは変えていない。段は P0〜P3・N0〜N6・S・Z と、サーバー側の V1〜V3（`web-ui-home.md` §4）。次は P1（古い殻を消す）
- 今の画面には段を足さない。止めていた段の扱い（解ける・吸う・閉じる・止めたまま）は `web-ui-rebuild.md` §8。上の各節に残る段の予定より、この節が勝つ

## Bot を持たない人格と Antigravity のエンジン（#530）

- Discord の Bot を持たない人格（Web だけ）と、話題を始めるときのモデルの一覧から選ぶ Antigravity（`agy`）のモデルの設計: `docs/plan/personas-web-antigravity.md`（#530。場所の線 WP0〜WP7・エンジンの線 AG0〜AG8）。Antigravity の人格は立てない（エンジンは話題ごと）。今は WP4 まで。WP5〜WP7・AG0〜AG8 はまだ
- WP1 は main に入った（コードの DB は v49: `sessions.place`・`persona_channels.place`（`discord` / `local`。今ある行は `discord`）・連番の表 `local_ids`。store `src/store/local-places.ts` の `LocalIdStore` がローカルの番号（先頭が `1` の数字 21 桁）を作る。再同期はローカルの話題を飛ばす）。ローカルの行を作る道はまだ無い（WP3 から）。効くのは再起動の後
- WP1 は v49 で起動した後は戻さない（DB が v49。`migrate` はコードより新しい版の DB を開かない）。戻すなら、起動のときに取った移行の前の控え（`self-agent.db.v48.bak`）から戻すか、v49 の移行を残してほかを戻す
- WP2 は main に入った（ローカルの Gateway `src/discord/local-gateway.ts` の `LocalGateway`。`sendMessage` は番号を返し、`send`・編集・ピン・リアクション・入力中は何もしない。`messageExists`・`channelExists` は true。管理の操作は投げる。`PersonaRouter` は `localGateway` を渡されたときだけ、`place = 'local'` の場所の `gatewayFor` にそれを返す）。`main.ts` はまだ渡さないので、誰も通らない道。再起動は要らない
- WP3 の 1 つ目（今在る操作の関所）: 移す（`ChannelOpsQueue.enqueueMove` は `place = 'local'` の話題を列に積まない）・消す（［削除する］はローカルの話題で `deleteChannel` を呼ばず、DB の片付けだけ）・削除の確認（`listDeleteDue` がローカルの話題を外す。§3.3 の 2 を WP4 から前倒し）。ローカルの行を作る道はまだ無いので動きは変わらない（本体の変更なので、効くのは再起動の後）。作る道と `/setup` は WP3 の 2 つ目
- WP3 の 2 つ目（作る道と `/setup`）: deps の `localPlaces`（型 `LocalPersonaPlaces`。述語 `isLocalPersona` と番号）の述語が true の足した人格の話題は、`createTopicSession` が Discord を呼ばずにローカルの番号で `place = 'local'`・`category_id = 'local'` の行を作り、最初の投稿をしない。既定の人格の話題はローカルにしない。`/setup` は述語が true か入口の行が `place = 'local'` の人格の `#<NAME>` を飛ばす。`main.ts` の述語は常に false なので動きは変わらない（本体の変更なので、効くのは再起動の後）。config の `_SURFACE` につなぐのは WP5
- WP4 の 1 つ目（まとめと一覧の場所の書き方）: `src/app/place-refs.ts`（`channelPlaceOf`・`createPlaceRefs` の `isLocal`・`refOf`。`PersonaRouter` の場所の引き方もこれを呼ぶ）。統括のまとめは Discord に投げる文だけローカルの話題を `「題名」（Web）` と書き、履歴の行は `<#ID>` のまま。`/sessions`・ホームパネルのローカルの話題の行は `題名（人格・Web・最終 …）`、`/reminders`・`/projects` の行のローカルの場所は `refOf` の字。ローカルの行を作る道はまだ通らないので、Discord に出る文は変わらない（本体の変更なので、効くのは再起動の後）。記憶の知らせ・`kb_delete`・`cc_send`／`cc_start` は WP4 の 2 つ目、リマインドは 3 つ目
- WP4 の 2 つ目（道具の側）: ローカルの場所では、記憶の変更の知らせを送らずにその場所の履歴に notice の行で書き（［取り消す］無し）、`kb_delete` は確認を送らずに固定の文で投げ（項目は消えない）、`cc_send`・`cc_start` は確認を出さず行も作らずに `not_available` を返す。`main.ts` は 3 つに PR-1 の `placeRefs` を渡す（任意の deps）。ツールの定義・システムプロンプトは変えない（変わるのはローカルの場所でのツールの結果だけなので、キャッシュは外れない）。1 ターンの間にローカルの Gateway に来て履歴に対応の行が無い送信（入力中・途中経過・途中経過の書き換え）と、待ち・Web から閉じる・入口の切り替えの今の動きをテストで固定した。ローカルの行を作る道はまだ通らないので動きは変わらない（本体の変更なので、効くのは再起動の後）
- WP4 の 3 つ目（リマインド）: ローカルの場所で頼んだ知らせのリマインドは、頼んだ場所に出さず既定の人格の Bot で #tasks（無ければ #inbox）に注記 `頼んだ場所: 「題名」（Web）` を付けて出し（`channel_id` は変えない。`ownerConnected` に頼らない）、頼んだ場所の履歴に notice を 1 行（諦めた回も 1 行）書く。場所を引けなかった回は投稿の失敗と同じく次の tick でやり直す。`reminder_set` の結果に、ローカルの場所の知らせの型だけ `note` を足す。`main.ts` は ReminderScheduler と reminder_set に PR-1 の `placeRefs` を渡す（任意の deps）。ツールの定義・システムプロンプトは変えない（キャッシュは外れない）。依頼の型はその入口で今のまま動く。今在るリマインド（全部 Discord の場所）の文と動きは変わらない。ローカルの行を作る道はまだ通らないので動きは変わらない（本体の変更なので、効くのは再起動の後）。これで WP4 は終わり
- WP6b（どの会話でも `<#番号>` を題名に替える）・WP7（画面で人格を選ぶ）と AG8（画面のモデルの一覧に Antigravity を出す）は #528 の向きが決まるまで止める（`docs/plan/web-ui-rebuild.md` §8）
- AG0（この機械での実測。サブスクの枠を使う）は、オーナーが `agy` を入れてサインインした後に、回して良いかを訊いてから

## プロンプトキャッシュが外れた変更の記録

規則は `CLAUDE.md` の「プロンプトキャッシュの規則」。ここは、どの変更でどのセッションのキャッシュが 1 回外れたか（外れる見込みか）の記録。

- CC7（cc_list・cc_send・cc_start のツールとシステムプロンプトの 1 行）を入れた再起動の後は、全セッションの次のターンで 1 回キャッシュが外れる（SELF_AGENT_CC が無効でも同じ。ツールは無効でも定義するため）
- M6（session_open の project・text、topic_list・topic_move のツールと、システムプロンプトの数行。docs/plan/web-ui-v3.md §4）を入れた再起動の後は、全セッションの次のターンで 1 回キャッシュが外れる（Web UI・SELF_AGENT_CC が無効でも同じ。ツールは無効でも定義するため）。プロジェクトのセッションの PROJECT_APPEND の変更は、新しい会話から効く
- #451 の PR-0（session_open の引数 model）を入れた再起動の後は、全セッションの次のターンで 1 回キャッシュが外れる（軽いモードもプロジェクトのセッションも。自前のツールは両方に付くため）。引数の describe の文は後で変えない
- H4a（プロジェクトのセッションの通常のターンで AskUserQuestion を使えるようにした）を入れた再起動の後は、今あるプロジェクトのセッションの次のターンで 1 回キャッシュが外れる見込み（ツールの集合が変わるため。軽いモードは変わらない）
- H4b（/mode）は軽いモードにもプロジェクトのセッションのツール・システムプロンプトにも触らない。許可のモードを変えたセッションの次のターンの外れ方は実機で確かめる
- #448（右腕の口調・但し書き・訊き返しの文）を入れた再起動の後は、軽いモードの全セッションの次のターンで 1 回キャッシュが外れる（プロジェクトのセッションは外れない。`PROJECT_APPEND` は変えていない）
