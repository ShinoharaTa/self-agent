# ゲスト利用の簡易モード（他の Discord サーバーで、ツールなし・Opus 5.5 low で答える）— 設計案 v3（#147）

> 2026-10-25。spec-writer。v2（2026-10-23）に GU1・GU2・`npm run guest-setup`（#151）の実装と、有効化の仕組みの作り直し（オーナーの決定。§9 の「2026-10-25」）を反映した版。同日の PR #154 のレビュー（返信の `type`・再投稿の規則・権限の fetch・投稿先の候補・間隔の数え方ほか）を反映済み。リポジトリのソースは変更していない。
> 「確認」= 2026-10-25 に main（401e792）のコードと discord.js 14.27.0（typings と src）で確かめた事実。「未確認」= 実装・受け入れで確かめるまで前提にしない。

## v3 の変更点（v2 からの差分）

| 項目 | v2（GU2 まで。今の main） | v3 |
|---|---|---|
| サーバーの許可 | env `SELF_AGENT_GUEST_GUILD_IDS`（許可リスト） | **DB `guest_guilds`**。オーナーがメインサーバーで発行した**認証コード**を、ゲストのサーバーの管理者が定型文への返信で貼ると許可される |
| ゲストが有効になる条件 | トークン・サーバー ID・API キーの 3 つ揃い | **トークン・API キーの 2 つ揃い**。`SELF_AGENT_GUEST_GUILD_IDS` が残っていれば設定エラー（§3.2.1） |
| Bot が新しいサーバーに入ったとき | log だけ | **既定のチャンネルに定型文を 1 通**（AI であること・できること・ログに残ること・有効化の手順・上限）。#system に 1 行 |
| `/guest on\|off\|status` を使える人 | オーナーだけ | **オーナーまたは Manage Server 権限のメンバー**（許可済みのサーバーだけ） |
| 許可の取り消し | env から消して再起動 | **`/guests revoke`**（メインサーバー。既定の人格の Bot）。Bot が外されたときも取り消し |
| 発言の fail-closed の判定 | env ∧ guest_channels ∧ … | **guest_guilds ∧ guest_channels ∧ …**（条件 (1) の出どころが変わるだけ） |
| `npm run guest-setup` | 3 項目 | **2 項目**（サーバー ID を訊かない。古い `SELF_AGENT_GUEST_GUILD_IDS` の行があれば消すか確認） |
| DB | v23 | **v24**（`guest_guilds`・`guest_invites` を足す。既存の有効な `guest_channels` のサーバーは許可済みとして引き継ぐ） |
| Gateway | `onGuildLeave`・`mentionsMe`・`replyToAuthorId`・`authorDisplayName`・`selfUserId()` | **+ `onGuildJoin`・`replyToMessageId`（Forward でない返信）・`authorCanManageGuild`（true / false / undefined）・`Interaction.memberCanManageGuild`（操作）・`memberCanManageGuild(guildId, userId)`（REST 1 回。GU4b）・`listGuildIds()`・`findNoticeChannels()`（候補を順に最大 3 つ）** |
| 段階 | GU1 → GU2 → GU2b → GU3 | GU1 → GU2 → GU2b → **GU4a → GU4b** → GU3 |

§3.0・§3.1・§3.3〜§3.6 は v2 のまま（実装済み）。変わるのは §3.2（許可と有効化）、§3.7 の一部、§4〜§9。

---

## 0. 目的・要望・結論

目的（オーナー）: オーナー以外の人（ゲスト）が、**他の Discord サーバーの許可したチャンネルの中だけ**で self-agent と話せるようにする。ツール実行・通知・リマインド・整理（タスク・記憶・ナレッジ・セッションのチャンネル管理）は持たせない「簡易モード」。モデルは Opus 5.5（`claude-opus-5-5`）・effort low。**サーバーの許可（認証コード）とサーバーの中での有効化（チャンネル）の二段構え**で、どちらか一方だけでは動かない。

**認証（オーナーが調べて決めたこと。v2 のまま）**: Claude Max の OAuth トークンで第三者に応答するのは不可。→ **ゲストの層は Claude Platform の API キー（従量課金）で動かす。オーナー側は OAuth のまま。** 同じプロセスの中で、子プロセス（CLI）ごとに渡す認証を分ける（§3.0）。

結論（v3）:
1. ゲスト専用の Bot（`SELF_AGENT_GUEST_DISCORD_TOKEN`）を同じプロセスで動かし、既存の人格の層には入れない（v2 のまま。実装済み）。
2. **二段構え: DB `guest_guilds`（サーバー。認証コードで許可）∧ DB `guest_channels`（チャンネル。`/guest on` か、認証コードを貼ったチャンネル）。** env の許可リストは廃止する。
3. **認証コードはオーナーがメインサーバーの `/guests invite server_id:<id>` で発行する。** そのサーバー ID に紐づき、使い捨て、24 時間で期限切れ。DB には sha256 のハッシュだけ。同じサーバーの未使用のコードは置き換える。
4. **ゲスト Bot が新しいサーバーに入ったら既定のチャンネルに定型文を 1 通投稿する。** 有効化は、その定型文への返信で本文が認証コードだけ、返信した人がオーナーか Manage Server 権限のメンバーのとき。対象外には一切反応しない。
5. ツールは Options で無くす + 全拒否の hook、1 チャンネル = 1 SDK セッション、メンション・返信のときだけ答える、上限、本文を残さない、は v2 のまま（実装済み）。
6. 段階: GU1・GU2・GU2b（済）→ **GU4a（許可の置き場を env から DB へ。Gateway・DB・config・管理者の /guest）→ GU4b（認証コードの発行・定型文・返信による有効化・取り消し）** → GU3（運用・README）。

費用: v2 のまま（Discord の Bot は 0 円。ゲストのターンは API の従量課金）。v3 で増える外部サービスは無い。運用コストの増分は、ゲストのサーバーを足すたびにオーナーがコードを 1 回発行して相手の管理者に渡す手間だけ。

---

## 1. コードで確認した事実 / 推測

確認（main 401e792）:
- `src/config.ts` の `loadGuestConfig(env, allowedGuildIds, personas)`: トークン・`SELF_AGENT_GUEST_GUILD_IDS`・API キーの 3 つが揃えば `guest: true`、3 つとも無ければ `guest: false`（任意の変数は読まない）、1〜2 つなら「ゲストを使うには … も設定してください」で設定エラー。サーバー ID は `idList` で読み、`SELF_AGENT_ALLOWED_GUILD_IDS` との重なり・トークンの重複を確かめる。`GuestConfig` に `guestGuildIds: string[]` がある。
- `guestGuildIds` を読むのは `src/guest/index.ts`（DiscordGateway の第 1 引数・`onGuildLeave` の判定・起動時の不参加の確認・`registerCommands` の `cfg`・停止後の応答の判定）、`src/guest/access.ts`（条件 (1)）、`src/guest/interactions.ts`（ゲストのサーバーの外の無視）と、テスト 6 本（config・guest-config・guest-access・guest-command・guest-handler・guest-layers）。それ以外の src・scripts には出てこない。
- `src/guest/access.ts` の `acceptsGuestMessage` は 5 条件の純関数。(1) は `guestGuildIds.includes(guildId)`。
- `src/guest/commands/guest.ts` の `/guest` は `interaction.userId !== cfg.ownerUserId` なら `OWNER_ONLY_REPLY`。`GUEST_ON_REPLY` は「このチャンネルで しのえもん をメンションすると答えます。**この Bot は AI です。** ファイル・Web・コマンドは使えません（会話だけ）。」
- `src/guest/index.ts` の `startGuest` は、ログイン（60 秒で時間切れ）→ `guestGuildIds` のうち `isInGuild` でないサーバーの行を `startup` で無効化 → `registerCommands`（`guestGuildIds` のうち参加しているサーバーに `/guest`）。`GuestGateway` 型は `Gateway` の一部 + `selfUserId()`。`createGateway` を注入できる（テスト）。
- `src/guest/notify.ts` は /setup 済みのオーナーのサーバーの #system に既定の人格の Bot で 1 行（10 秒の時間切れ。失敗は log）。
- `src/store/guest.ts` の `GuestStore`: `enable`（無効な行を開き直す・上限 5・トランザクション）・`disable`・`disableGuild`・`get`・`listActive`・`countActive`・`bumpSession`・`resetSession`・`countTurns`・`countUserTurns`・`recordTurn`・`pruneTurns`。`guest_channels.channel_id` が主キー、`disabled_reason` は `command / left / startup` の CHECK。DB は v23。
- `src/app/interactions.ts`: `createInteractionHandler` は許可サーバー（`cfg.allowedGuildIds`）→ オーナー判定 → コマンド名 / custom_id の名前空間で振り分ける。`createCommands(deps)` は `deps.jobs` があるときだけ `/job` を足す（任意の依存で登録するコマンドが増える形の前例）。`registerCommands` は `cfg.allowedGuildIds` のうち参加しているサーバーに bulk overwrite。main.ts は `createCommands`（317 行目）→ `createInteractionHandler` → … → `createShutdown`（485 行目）→ `registerCommands`（537 行目）→ `startGuest`（550 行目。`stopping: lifecycle.stopping`）の順。
- `src/discord/gateway.ts` の `IncomingMessage` は `mentionsMe?`・`replyToAuthorId?`・`authorDisplayName?` を持ち、**返信先のメッセージ ID・発言者の権限は無い**。`Interaction` の共通部分は guildId・channelId・userId・createdAt だけで、**操作者の権限は無い**。`Gateway` には `isInGuild` はあるが参加しているサーバーの列挙は無い。
- `src/discord/discord-gateway.ts`: `Events.GuildCreate` には `warnIfNotAllowed` だけが付いている（第 1 引数の `allowedGuildIds` に無ければ log）。`onGuildLeave` は `Events.GuildDelete`。`selfUserId()`・`connected()` は `Gateway` インタフェースではなく `DiscordGateway` クラスにだけある。`toIncoming` は `toMentionInfo(message, selfUserId)`（`MentionSource.reference: unknown`）と `toDisplayName(message)` を使う。
- `src/discord/convert.ts` は discord.js を型だけ import し、数値は自前の定数（enum を実行時に読まない方針）。
- `scripts/guest-setup.ts` は `GUEST_ENV_KEYS`（`src/guest/setup-env.ts`。3 つ）を訊き、`validateGuildIds` で `SELF_AGENT_ALLOWED_GUILD_IDS` との重なりを見て、`/users/@me/guilds` で未参加のサーバーの数を警告し、`upsertEnvLines` で 3 行を書く。`upsertEnvLines` は置き換え・追加だけで**行の削除は無い**。
- README・README_ja・REQUIREMENTS にゲストの記述はまだ無い（grep で 0 件）。CLAUDE.md には概要 1 行と `store/`・`guest/` の説明がある。

確認（discord.js 14.27.0）:
- **`guildCreate` は、Bot が新しいサーバーに入ったときだけ鳴る。再起動のたびに既存のサーバーでは鳴らない。** `src/client/websocket/handlers/GUILD_CREATE.js`: キャッシュに無いサーバーで、かつ `client.ws.status === Status.Ready` のときだけ `GuildCreate` を emit する。起動時の READY は参加しているサーバーをまず（unavailable の形で）キャッシュに入れ（`READY.js`）、続く各サーバーの GUILD_CREATE はキャッシュにあるので `GuildAvailable` 側に流れる。→ **プロセスが止まっている間に入ったサーバーでは `guildCreate` が鳴らない**（起動時には既にキャッシュにある）。起動時の sweep（§3.2.5）が要る根拠。
- `Guild.systemChannelId: Snowflake | null`、`get systemChannel(): TextChannel | null`（`client.channels.resolve(systemChannelId)`）。`GuildChannel.rawPosition`・`parentId`・`permissionsFor(member)`（member をキャッシュから解決できなければ `null`）、`get viewable()`。`Guild.members.me` はキャッシュに無ければ `null`（partials 無し）。`GuildMemberManager.fetchMe()` がある。
- `Message.reference: MessageReference | null` で `messageId: Snowflake | undefined`・`type: MessageReferenceType`（discord-api-types v10: `Default = 0` が返信、`Forward = 1` が転送）。`Message._patch` は `message_reference` からそのまま写す。**ただし元の discord-api-types v10 の `APIMessageReference.type?` は optional**（`payloads/v10/message.d.ts`。discord.js の typings は必須に見えるが実行時は写すだけ）で、`type` の無い返信では `undefined` になりうる。discord.js 自身も `Message.editable`・`crosspostable` を `this.reference?.type !== MessageReferenceType.Forward`（「Forward でない」）で判定している（`src/structures/Message.js`）。→ **返信の判定は `type !== 1`（Forward でない。`undefined` も返信として通す）で行い、`type === 0` に絞らない。**
- `GuildMemberManager.fetch(user: UserResolvable): Promise<GuildMember>` は 1 人のメンバーを REST で取る（いなければ reject。GuildMembers intent は要らない）。§10 の決定 3(b) の `memberCanManageGuild(guildId, userId)` はこれを 1 回呼ぶ。
- `Message.member` は `guild.members.resolve(author)`。MESSAGE_CREATE に `member` が付いていれば `_patch` が `guild.members._add(Object.assign(data.member, { user: author }))` でキャッシュに入れる。`GuildMember.permissions` は所有者なら All、それ以外は役職の権限の和（`roles.cache.map(role => role.permissions)`）で、**ゲートウェイの MESSAGE_CREATE の `member` に `permissions` は無くても役職から計算できる**（Guilds intent で役職は届く。確認は typings と src。実機は §7）。`PermissionsBitField.has(ManageGuild)` は既定で Administrator も通す（`checkAdmin = true`）。
- `BaseInteraction.memberPermissions` は `data.member.permissions` があれば `PermissionsBitField`、無ければ `null`（DM）。**操作の権限は Discord が計算して付けてくる**ので、コマンドの操作者の Manage Server はこれで分かる。
- `PermissionFlagsBits.ManageGuild`・`ViewChannel`・`SendMessages` は discord-api-types の bigint 定数。convert.ts の方針（型だけ import）に合わせるなら、判定は discord.js のクラスを持つ `discord-gateway.ts` 側で行い、convert.ts には boolean を渡す。

推測・未確認（§7 の「実機」に落とす）:
- ゲスト Bot の MESSAGE_CREATE に `member`（と `roles`）が付くか（v2 でも未確認のまま。表示名の fallback と同じ）。付かなければ `authorCanManageGuild` は `undefined` になり、返信の検証（§3.2.5 の 4）が `memberCanManageGuild(guildId, userId)` で 1 回取りに行く（§10 の決定 3(b)）。それでも取れなければ false のまま（fail-closed。オーナーだけが有効化できる）。実機で `member` が付いていれば fetch は動かない。
- `guildCreate` で渡る `Guild` の時点で `systemChannelId`・チャンネル一覧・Bot 自身の member がキャッシュにあるか（GUILD_CREATE の payload には channels と、Bot 自身の member が入るはず。無ければ `fetchMe()` で取る）。
- GU2 の未確認（`apiKeySource` の取り違え・`tools: []` のときのシステムプロンプト・`claude-opus-5-5` が API キーで通るか）は GU3 の実機の記録で閉じる。

---

## 2. 用語

| 用語 | 意味 |
|---|---|
| ゲスト | オーナー以外の人。ゲストのサーバーの誰でも（オーナーがそこにいればオーナーの発言も同じ扱い） |
| メインサーバー | `SELF_AGENT_ALLOWED_GUILD_IDS` のサーバーのうち /setup 済みのもの。既定の人格の Bot がいて、#system がある |
| ゲストのサーバー | ゲスト Bot が参加しているサーバー（`guest_guilds` に行がある）。**許可済み**（allowed）はそのうち認証コードで許可され、取り消されていないもの。メインサーバーの ID はゲストのサーバーにできない |
| ゲスト Bot | `SELF_AGENT_GUEST_DISCORD_TOKEN` で動く専用の Discord アプリ。呼び名は「しのえもん」 |
| 認証コード | オーナーがメインサーバーの `/guests invite` で発行する、サーバー ID に紐づく使い捨て・24 時間の文字列。DB には sha256 だけ |
| 定型文（案内） | ゲスト Bot がサーバーに入ったときに既定のチャンネルに投稿する 1 通。有効化の返信先になる |
| 管理者 | ゲストのサーバーで Manage Server（サーバー管理）権限を持つメンバー。オーナーも同じ操作ができる |
| 有効化（Activation） | 許可済みのサーバーの中で、答えるチャンネルを `guest_channels` に登録すること（`/guest on`、または認証コードを貼ったチャンネル） |
| ゲストのターン | 有効化したチャンネルでゲスト Bot がメンションされた（か返信された）発言への 1 回の応答。ツールなし・1 ステップ・API キーの認証 |

---

## 3. 設計

### 3.0 論点 0: 認証（ゲストは API キー、オーナーは OAuth）

v2 のまま（決定・実装済み。GU2）。ゲストの runner の子の env だけに `ANTHROPIC_API_KEY`、`CLAUDE_CONFIG_DIR` は `<claudeConfigDir>-guest`、`init` の `apiKeySource` を run ごとに確かめる。

### 3.1 論点 1: Bot の分け方

v2 のまま（決定・実装済み。1-b: 専用 Bot・同じプロセス・別の層）。v3 で変わる点:
- 「ゲスト Bot が許可外のサーバーに招かれたら log だけで無視」→ **許可していないサーバーに入ったときも定型文を投稿する**（§3.2.4）。Public Bot をオフにしているので、招けるのはオーナーだけ。
- `DiscordGateway` の第 1 引数（`allowedGuildIds`。`warnIfNotAllowed` の log にだけ使う）にゲストは何を渡すか: 許可済みのサーバーは DB で動くので、固定の配列は渡せない。**`DiscordGatewayOptions.warnOnUnlistedGuild?: boolean`（既定 true）を足し、ゲストは false で作る**（既定の Bot・人格の Bot は今のまま）。

### 3.2 論点 2: サーバーの許可と有効化の二段構え（v3 で作り直し）

**第 1 段（DB `guest_guilds`）**: サーバーの許可。オーナーがメインサーバーで発行した認証コードを、そのサーバーの管理者（かオーナー）が定型文への返信で貼ると許可される。取り消しはメインサーバーの `/guests revoke` か、Bot が外されたとき。

**第 2 段（DB `guest_channels`）**: 許可済みのサーバーの中で、チャンネルごとに有効化。認証コードを貼ったチャンネルは同時に有効になる。以後の増減は `/guest on|off`。

**fail-closed の規則（必ず全部。v2 の (1) の出どころだけ変わる）**: ゲストのターンが動くのは、(1) 発言の guildId が `guest_guilds` で**許可済み**（`allowed_at` があり `revoked_at` が無い）で、(2) `guest_channels` にその (guild_id, channel_id) の有効な行があり、(3) ゲスト Bot の Gateway から届いた発言で、(4) 発言者が Bot・Webhook でない、(5) ゲスト Bot へのメンション（`mentionsMe`）か、ゲスト Bot の発言への返信（`replyToAuthorId` がゲスト Bot の ID）、のすべてを満たすときだけ。取り消したサーバーの行は（残っていても）使わない。`acceptsGuestMessage` の引数は `guestGuildIds: readonly string[]` を **`guildAllowed: boolean`**（呼び出し側が `GuestGuildStore.isAllowed(guildId)` で引く）に替える。判定の純関数の形は変えない。

#### 3.2.1 env の `SELF_AGENT_GUEST_GUILD_IDS` が残っていたら

| 案 | 内容 | メリット | デメリット | 最適度 |
|---|---|---|---|---|
| A | **設定エラー（変数名を出して exit 1）** | 古い env に必ず気づく。「env の許可リストがまだ効いている」という誤解を残さない（安全に関わる）。このリポジトリの流儀（設定の誤りは変数名を出して起動しない）と同じ | 更新して再起動した直後に 1 回止まる。env を直すまで既定の人格も動かない | ◎ |
| B | 無視して起動時に 1 行 log | 止まらない | log を読まないと気づかない。オーナーの頭の中の許可リストと実際が食い違ったまま動く | △ |

- **推し: A。** 文面は「SELF_AGENT_GUEST_GUILD_IDS は v3 で廃止しました。~/.config/self-agent/env から消してください（サーバーの許可は /guests invite の認証コードで行います）」。A の弱点（更新直後の停止）は、`npm run guest-setup` が古い行を見つけたら消すか確認すること（§5）と、PR の説明に「デプロイの前に env から消す」を書くことで埋める。
- ゲストが有効になる条件は **トークン・API キーの 2 つ揃い**。1 つだけなら今までと同じ文面で設定エラー、2 つとも無ければ `guest: false`（任意の変数は読まない）。トークンの重複・`SELF_AGENT_PERSONAS` の `guest` の予約は今のまま。`GuestConfig` から `guestGuildIds` を消す。
- 変数が「ある」= `nonEmpty(env.X?.trim())` が `undefined` でない（`config.ts` の既存の helper。今の `loadGuestConfig` と同じ）。空・空白だけの値は「無い」と同じ。`SELF_AGENT_GUEST_GUILD_IDS` の廃止の判定も同じ規則（`SELF_AGENT_GUEST_GUILD_IDS=` と空で残っていればエラーにしない）。

#### 3.2.2 認証コード

**形**: `guest-` + 24 文字を 4 文字ずつ `-` で区切ったもの（例の形: `guest-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`。全体 35 字）。文字は **小文字の Crockford base32**（`0-9 a-h j k m n p-t v-z`。`i l o u` を使わない）。

- 生成: `crypto.randomBytes(15)`（120 bit）を base32 に符号化すると丁度 24 文字（余りなし）。候補の空間は 2^120 で、総当たりは現実的でない（1 秒に 10 億回試しても 10^19 年の桁）。
- 貼り間違いにくさ: 紛らわしい字を除き、4 字ずつ区切る。照合は**大文字小文字を区別しない**（スマホのキーボードが先頭を大文字にする）。
- URL・メンションと誤認されない: `<`・`@`・`#`・`:`・`/`・`.` を含まない。Discord は `guest-…` をリンクにしない。`-` 区切りは Discord の Markdown に当たらない。
- 読み取りの正規化: **先に、ゲスト Bot へのメンション（`<@BotID>`・`<@!BotID>`。Discord の返信で「メンション ON」のときに本文の先頭に付く）を `handler.ts` の `stripBotMention(content, selfUserId)` と同じ規則（本文中のその 2 つの形をすべて除いて trim）で除く**（呼び出し側の `handleReply` が行う）。次に `parseInviteCode(text)`（純関数）: 前後の空白を除く → 両端が 1 組のバッククォート（コード用の記号 U+0060）ならそれも除く（Discord でコードを貼る人がよく付ける。実装者の裁量で外してよい） → 小文字にする → `^guest(-[0-9a-hjkmnp-tv-z]{4}){6}$` に合えばその文字列、合わなければ `undefined`。**合わないものは無視**（決定 5）。メンション以外の余計な文字（「コードです」などの前置き・後置き）があれば合わないので無反応のまま。
- 保存: 平文は発行の応答に 1 回出すだけ。DB には `sha256(正規化したコード)` の hex。120 bit のランダム値のハッシュなので salt は要らない。照合は `code_hash` で引く（1 行）。

**有効期限: 24 時間**（定数 `GUEST_INVITE_TTL_HOURS = 24`）。根拠: 総当たりへの備えは 2^120 で足りているので、期限の役目は「渡したが使われなかったコードを放置しない」こと。オーナーがスマホで発行 → 相手の管理者に DM で渡す → 相手が都合のよいときに貼る、という非同期のやり取りで、時差・就寝をまたいでも 1 回の往復に収まるのが 24 時間。1 時間では相手を待たせられず、7 日ではコードが DM に長く残る。

**置き換え**: 同じサーバーに未使用・期限内のコードがあれば、新しく発行したときに古いものを `superseded_at` で無効にする（1 サーバーに生きているコードは 1 つ）。

**保存する項目**（§4 の `guest_invites`）: ハッシュ・サーバー ID・作った時刻・期限・置き換えた時刻・使った時刻・**使った人のユーザー ID と使ったチャンネル ID は保存する**。理由: 他人のサーバーの許可を誰が受け入れたかは、取り消すとき・相手に連絡するときにオーナーが知る必要がある唯一の記録で、Discord 側の返信は消されうる。DB はローカル（600）で public でなく、log には出さない（console には出さないという既存の規則のまま。DB に置くのは `guest_turns.user_id` の前例がある）。保存しない案（最小限の原則）は、取り消しのときに相手が分からなくなる方が運用で困るので採らない。

**物理削除**: しない（既存の表と同じ。1 回の発行で 1 行なので量は問題にならない。期限切れ・使用済みも履歴として残す）。tick の削除は足さない。

#### 3.2.3 発行と取り消し（メインサーバー。既定の人格の Bot）

コマンド名の比較:

| 案 | 形 | 最適度 |
|---|---|---|
| a | `/guest-invite server_id:<id>` と `/guest-revoke server_id:<id>`（2 コマンド） | ○ |
| b | **`/guests` にサブコマンド `invite` / `revoke` / `list`** | ◎ |

- **推し: b。** 1 コマンドにまとまり、`list`（許可済みのサーバー・有効なチャンネル数・生きているコードの有無を本人にだけ）が自然に置ける。ゲストのサーバー側の `/guest` とは別の Bot・別のサーバーに登録されるので名前は衝突しない（`guest` と `guests` の紛らわしさは「メインサーバーでは複数形」で覚える。気になれば `guest-admin` でもよい。実装者が決めてよい）。
- 登録: `createCommands(deps)` に任意の依存 `guests?: GuestAdmin`（`jobs` と同じ形）を足し、あるときだけ `/guests` を登録する。コマンドの本体は **`src/guest/commands/admin.ts`**（ゲストの層にまとめる。`app/interactions.ts` は import を 1 つ足すだけ）。振り分け・許可サーバー・オーナー判定は既存の `createInteractionHandler` がそのまま行う（確認: サーバー → オーナー → コマンド名の順。オーナー判定は `cfg.ownerUserId !== undefined && interaction.userId === cfg.ownerUserId`。`ownerUserId` が無ければ誰も通らない）。応答はすべて本人にだけ（ephemeral）。
- `/guests invite server_id:<id>`:
  1. `server_id` は string のオプション（Discord 側で `minLength 17`・`maxLength 20`）。`^\d{17,20}$` に合わなければ「サーバー ID は数字です」。`cfg.allowedGuildIds` に含まれれば「メインのサーバーには発行できません」。
  2. `defer(ephemeral)` してから（定型文の確認で Discord を呼ぶため）、`GuestInviteStore.issue(guildId, now)`: 生成 → 同じサーバーの生きているコードを `superseded_at` → 行を 1 つ作る（1 トランザクション）。平文はこの関数の戻り値だけに乗せ、DB・log には残さない。
  3. 定型文の確認: ゲスト Bot がそのサーバーに参加していて（`isInGuild`）、**`guest_guilds` の `notice_message_id` が無いか、あってもそのメッセージが無ければ（`messageExists` が false）**、投稿し直す（消されていると返信先が無く、有効化できないため）。手順は、`messageExists` が false なら先に `clearNotice(guildId)` で `notice_*` を NULL にし、どちらの場合も `onboardGuild(guildId)`（§3.2.4。条件は「`notice_message_id` が無ければ投稿」の 1 つなので、そのまま呼べば投稿される）。`revoke` で取り消したサーバーでも、案内が消えていれば同じ（決定 7 の「再投稿しない」は取り消しの時点のことで、新しいコードを発行するときは返信先が要る）。参加していなければ投稿せず、応答に「ゲスト Bot はまだこのサーバーに参加していません。招待すると案内を投稿します」を添える。確認・再投稿の失敗は応答に 1 行添えるだけで、発行は成立させる。
  4. 応答（本人にだけ）: 「サーバー <id> の認証コード（24 時間有効・1 回だけ）:」の次の行にコード（コード用の記号で囲む）、その次に「そのサーバーの管理者に渡し、しのえもん の案内への**返信**として貼ってもらってください。」（前のコードがあれば「前のコードは無効にしました」を足す）
  5. #system に 1 行（§6）。
- `/guests revoke server_id:<id>`: 許可済みなら `revoke(guildId, "revoke")` → `guest_channels` をそのサーバー分すべて `disableGuild(guildId, "command")`（n 件） → 生きているコードも `superseded_at` → 応答「サーバー <id> の許可を取り消しました（有効なチャンネル n 件を無効にしました）」→ #system に 1 行。許可済みでなければ「サーバー <id> は許可していません」。**定型文の記録は残す（再投稿しない）**。Bot はそのサーバーに残り、何にも答えない（`/guest` は「このサーバーはまだ有効になっていません」）。もう一度許可するには新しいコード。
- `/guests list`: `guest_guilds` の行をサーバー ID ごとに 1 行（「<id>: 許可済み（チャンネル n/5）」「<id>: 未許可（コード有効 HH:MM まで / コードなし）」「<id>: 取り消し済み（revoke / left）」）。参加前に発行したサーバー（`guest_guilds` に行が無く、生きているコードがある）も、その後に「<id>: 未許可（コード有効 HH:MM まで）」で出す。参加していないサーバーには「（不参加）」。本人にだけ。

#### 3.2.4 定型文（Bot がサーバーに入ったとき）

- きっかけ: `onGuildJoin`（`Events.GuildCreate`。確認: 新しく入ったときだけ鳴る）と、起動時の sweep（§3.2.7 の 2。止まっている間に入ったサーバーを拾う）と、`/guests invite` の再投稿（§3.2.3 の 3）。どれも同じ `onboardGuild(guildId)` を呼ぶ。
- `onboardGuild(guildId)`: `guest_guilds` の行を upsert（`joined_at`。無ければ作る。あれば変えない）→ **`notice_message_id` があれば何もしない**（投稿の条件はこの 1 つ。`revoked_reason` は見ない。再起動・再接続で重ねて投稿しない）→ 投稿先の候補を `findNoticeChannels(guildId)`（下。順に最大 3 つ）で取る → 候補の先頭から `sendMessage(channelId, { text })`（`text` は `buildGuestNoticeText(cfg)` で起動時に 1 回作ったもの）を試し、**失敗したら次の候補へ**（3 つまで）→ 送れたら返った ID を `notice_channel_id`・`notice_message_id`・`notice_posted_at` に書く → #system に「参加し、案内を投稿しました」。候補が 1 つも無ければ「投稿できるチャンネルがありません」、候補が全部失敗したら「送信に失敗しました」を理由に #system に「参加しましたが、案内を投稿できませんでした（<理由>）」（記録は `joined_at` だけ。案内は未投稿のまま）。**`/guest` の登録は `onboardGuild` の中では行わない**（§3.2.6。登録は参加の経路と起動の sweep がそれぞれ 1 回行う）。未投稿のサーバーは、次の起動の sweep と `/guests invite` の再投稿（§3.2.3 の 3）でやり直す。
- 外された（GuildDelete・起動時の不参加）ときに **`notice_channel_id`・`notice_message_id`・`notice_posted_at` を NULL に戻す**（`clearNotice`。§3.2.7 の 3・5）。これで、また入ったときは `notice_message_id` が無いので新しく入ったものとして案内が投稿される（古い案内は消えていることが多く、返信先として当てにできない。許可は取り消されたままで、新しいコードが要る）。再参加の印に `revoked_reason` は使わない。`revoke` で取り消したサーバー（Bot は残っていて案内も残っている）には再投稿しない（決定 7）。
- `findNoticeChannels(guildId): Promise<string[]>`（`DiscordGateway` に足す。Discord の知識をここに閉じる。候補のチャンネル ID を順に最大 3 つ返す）: `me` は `guild.members.me`、無ければ `fetchMe()` を 1 回（それでも取れなければ空の配列）。(a) `guild.systemChannel` があり、**`permissionsFor(me)` が `ViewChannel` と `SendMessages` を両方持てば**先頭の候補にする（権限が無ければ候補にしない）。(b) 続けて、`guild.channels.cache` のうち `ChannelType.GuildText` を「親カテゴリの `rawPosition`（カテゴリなしが先）→ 自身の `rawPosition` → id」の順に並べ、`permissionsFor(me)` が両方を持つものを (a) と重ならないように足し、全体で 3 つになったら止める。(c) 1 つも無ければ空の配列（投稿しない）。権限を見ても送信が失敗することはある（スローモード・AutoMod・その間の権限の変更など）ので、送信そのものの失敗は `onboardGuild` が次の候補で吸収する。
- 文面は §6。`buildGuestNoticeText(cfg)` で起動時に 1 回組み立てる（上限の数字だけ cfg から。サーバー名・日付などの可変値は入れない）。`@everyone`・`@here` を含まない（送信は `ALLOWED_MENTIONS` の `parse: []` なので、含んでいても鳴らないが、含めない）。

#### 3.2.5 返信による有効化（ゲスト Bot。発言の経路）

`index.ts` の `onMessage` は、今の受付判定の前に **「定型文への返信か」を 1 回だけ安く見る**: `message.replyToMessageId`（`reference.type !== 1`。Forward でない返信。`type` が `undefined` の返信も含む）があり、それがそのサーバーの `guest_guilds.notice_message_id` と一致する（チャンネルも `notice_channel_id` と一致する）ときだけ `activation.handleReply(message)` に渡して終わる（ゲストのターンには流さない。定型文への返信は会話として扱わない）。それ以外は今までどおり `acceptsGuestMessage` へ。見るのは MESSAGE_CREATE だけ（発言の編集では有効化しない。§7）。

`handleReply`（`src/guest/activation.ts`。判定の順。上から順に落ち、**落ちたら何も返さない・リアクションもしない**。log はサーバー ID と種類だけ）:
1. 返信先が定型文（上。ここまでは呼び出し側）。`authorIsBot`・`isWebhook` なら捨てる（種類 `bot`）。
2. 形: `stripBotMention(content, selfUserId)` で先頭のメンションを除いた本文を `parseInviteCode` に渡し（§3.2.2）、`undefined` なら捨てる（log も出さない。定型文への普通の返信はありうる）。
3. 総当たりの間隔（規則は 1 つ）: **サーバーごとに「DB を引く失敗」（5 の `not_found` / `wrong_guild` / `used` / `expired` / `superseded`）の時刻をプロセス内で 10 分ぶん持ち、10 分以内に 5 回に達したら、その時点から 10 分は（形が合っていても）それ以上見ずに捨てる（権限も DB も引かない。種類 `locked`）。10 分経ったら回数を 0 に戻す。** 定数は `GUEST_INVITE_FAIL_LIMIT = 5`・`GUEST_INVITE_LOCK_MIN = 10`。log は上限に達したときに 1 回と、#system に 1 行（ロック中の個々の返信は log も #system も無し）。
4. 権限: オーナー（`cfg.ownerUserId !== undefined && authorId === cfg.ownerUserId`）なら通す。それ以外は `authorCanManageGuild` が `true` / `false` ならその値を使い、**`undefined`（MESSAGE_CREATE に `member` が無かった）のときだけ `memberCanManageGuild(guildId, authorId)`（`GuestGateway` に足す。`guild.members.fetch(userId)` を 1 回。失敗・いない・権限なしは false）で取る**。1〜3 を通った後にだけ呼ぶので、形の合わない発言や連投で REST を叩かされない。false なら捨てる（種類 `forbidden`）。**`forbidden` は失敗に数えない（log だけ）。** 理由: 数えると、権限の無いメンバーがコードの形の文字列を 5 回貼るだけで、管理者が本物のコードを貼る前にそのサーバーを 10 分締め出せる。コードの照合は起きていないので総当たりの材料にもならない。
5. DB: `GuestInviteStore.redeem(hash, guildId, now, userId, channelId)` を 1 トランザクションで: `code_hash` の行があり、`guild_id` が一致し、`used_at`・`superseded_at` が無く、`expires_at > now` なら `used_*` を書いて `ok`。それ以外は `not_found` / `wrong_guild` / `used` / `expired` / `superseded` のどれか（**どれも同じ無反応**。log に種類は出す。**3 の失敗に数えるのはこの 5 つだけ**）。同じトランザクションで `GuestGuildStore.allow(guildId, now)`（取り消しの列を NULL に戻し `allowed_at` を今に）と `GuestStore.enable(guildId, channelId)`（上限なら `limit` のまま許可だけ成立）。**返信者がオーナーか管理者（4 を通った人）で、結果が `expired` / `used` / `superseded` / `wrong_guild` なら、#system に「ゲスト: サーバー <id> で認証コードが受け付けられませんでした（期限切れ / 使用済み / 無効 / 別のサーバー向け）」を 1 行**（コード・ユーザー ID は出さない。`not_found`（貼り間違い）は出さない。ロック中は 3 で止まるのでここに来ない）。オーナーが新しいコードを発行し直す判断の材料にする。
6. 成功: 公開の返信（`send(channelId, text, message.id)`）で「有効にしました。」+ `GUEST_ON_REPLY`（`limit` なら `GUEST_LIMIT_REPLY` を代わりに）。返信に失敗しても DB は戻さず、#system に「有効化の返信を投稿できませんでした（有効化は済んでいます）」。成功の #system は「サーバー <id> を認証コードで有効にしました（チャンネル n/5。<オーナー|管理者>）」。SDK セッション（`guest:<channelId>`）は `/guest on` と同じく捨てる。`/guest` の登録はここでは行わない（参加の経路と起動の sweep の 2 つだけ。§3.2.6。参加時に登録に失敗していれば次の起動で直る）。
7. 失敗の回数は成功で 0 に戻す。回数はサーバーごとにプロセス内（再起動で消える。2^120 の空間に対しては十分）。

既に許可済みのサーバーで有効なコードを貼ったとき（別のチャンネルを足す目的）も同じ流れで通る（コードは消費され、そのチャンネルが有効になる）。

#### 3.2.6 `/guest` の登録のタイミングと権限

| 案 | 内容 | メリット | デメリット | 最適度 |
|---|---|---|---|---|
| i | **参加した時点で登録（起動時は参加している全サーバー）** | 経路が 1 つ（参加・起動の sweep）。許可の瞬間に Discord を余計に呼ばない。Public Bot がオフなので参加はオーナーの意図 | 未許可のサーバーでもコマンドが見える（使うと「まだ有効になっていません」） | ◎ |
| ii | 許可したときに登録 | 未許可のサーバーに見せない | 有効化の返信の処理の中で Discord を呼ぶ（失敗すると管理者が `/guest off` を使えない）。起動時にも許可済みのサーバーに登録し直す経路が要る。登録の遅れ（通常は即時だが失敗の再試行は次の起動） | ○ |

- **推し: i。** 見えることの害は無い（未許可では何もできない）。
- 登録の経路は 2 つだけで、それぞれ 1 回: (1) 参加（`onGuildJoin`）→ `onboardGuild` の後に `registerGuildCommands(guildId, [/guest])`、(2) 起動の sweep（§3.2.7 の 4）。`onboardGuild`・有効化の成功・`/guests invite` の中では登録しない。GU4a では (2) だけ（参加の経路は GU4b）。
- 権限（`src/guest/commands/guest.ts`）: 許可済みでないサーバーからの `/guest` は本人にだけ「このサーバーはまだ有効になっていません」。許可済みなら、オーナー（`cfg.ownerUserId !== undefined && interaction.userId === cfg.ownerUserId`。今の `guest.ts` と同じ形）か `interaction.memberCanManageGuild === true`（interaction の `memberPermissions` から。fetch は要らない）のときだけ on / off / status を行い、それ以外は本人にだけ「サーバーの管理権限（サーバー管理）が必要です」（`OWNER_ONLY_REPLY` は使わない）。上限 5・既に有効・有効でない・status の文面は今のまま。#system の有効化・無効化の知らせには操作した人が管理者なら「（管理者）」を添える（ユーザー ID は入れない）。
- `src/guest/interactions.ts` の「ゲストのサーバーの外の操作を無視」は「`guest_guilds` に行の無いサーバー（＝参加した記録が無い）・DM は無視」に替える。停止を始めた後の「再起動中です」も同じ判定。

#### 3.2.7 起動時の sweep（`index.ts`。ログインの後、`/guest` の登録の前）

1. `listGuildIds()`（`DiscordGateway` に足す。`guilds.cache` の鍵）で参加しているサーバーを取る。
2. 参加している全サーバー（メインサーバーの ID（`cfg.allowedGuildIds`）を除く。入っていれば log「メインのサーバーに参加しています」だけ。同じサーバーに両方の Bot を置かない前提）について、**GU4a では `guest_guilds` の行を `upsertJoined(guildId, now)` するだけ**（投稿しない。これで GU4a の間も未許可のサーバーの `/guest` が「まだ有効になっていません」を返せる）。**GU4b では同じ対象に `onboardGuild`**（§3.2.4。upsert を含み、`notice_message_id` が無いサーバー（行が無い・未投稿・外されて戻った）だけ投稿する）。
3. 参加していないサーバーの行: 許可済みなら `revoke(guildId, "left")` と `disableGuild(guildId, "startup")` と `clearNotice(guildId)`、#system に「参加していないため許可を取り消しました（有効なチャンネル n 件を無効にしました）」（今の `guestNotJoinedNotice` を置き換える）。**参加の記録だけで未許可の行（`allowed_at` が無い・既に取り消し済み）なら `clearNotice` だけ**（`revoke()` は呼ばず `revoked_*` は書かない。log だけ）。
4. 参加している全サーバー（メインサーバーを除く）に `/guest` を登録（`registerGuildCommands`。失敗は log）。sweep の経路の登録はここの 1 回。
5. `onGuildLeave`（GuildDelete）: 許可済みなら `revoke(guildId, "left")` + `disableGuild(guildId, "left")` + `clearNotice(guildId)` + #system（今の `guestLeftNotice` に「許可を取り消しました」を足す）。**参加の記録だけで未許可の行なら `clearNotice` だけ**（`revoke()` は呼ばない。log だけ）。行が無いサーバーなら log だけ。

ログインが時間切れ・失敗なら sweep も登録も行わない（今と同じ）。

### 3.3〜3.6

v2 のまま（実装済み。GU2）。§3.6 の「ゲストの層から DB に書くのは …」に `guest_guilds`・`guest_invites` を足す。

### 3.7 論点 7: 既存機能との境界（v3 で足す行）

| 既存 | ゲストのサーバーで | 根拠 |
|---|---|---|
| `app/interactions.ts` の `/guests` | メインサーバーだけ。オーナーだけ | 既定の人格の Bot にだけ登録し、既存の振り分け（許可サーバー → オーナー）を通る |
| `discord-gateway.ts` に足す項目（`onGuildJoin`・`warnOnUnlistedGuild`・`listGuildIds`・`findNoticeChannels`・`memberCanManageGuild(guildId, userId)`・`replyToMessageId`・`authorCanManageGuild`・`Interaction.memberCanManageGuild`） | 既定の Bot・人格の Bot は配線しない・読まない | オプションは省略時に今と同じ。`IncomingMessage`・`Interaction` の新しい項目は省略可で、app 側は読まない（`toIncoming`・`toCommandInteraction` の結果に増えるだけ。既存のテストは `deepEqual` で比べているものがあれば期待値に足す） |
| scheduler・reminders・inbox-rotate・persona-status・github | 触らない | 変更なし |

---

## 4. DB（v24。1 回の移行）

```sql
-- ゲスト Bot が参加した（ことのある）サーバーと、その許可の状態。物理削除しない
CREATE TABLE guest_guilds (
  guild_id TEXT PRIMARY KEY,
  joined_at TEXT NOT NULL,          -- 初めて見た時刻（参加の記録。再参加では変えない）
  allowed_at TEXT,                  -- 認証コードで許可した時刻。NULL なら未許可
  revoked_at TEXT,                  -- 取り消した時刻。NULL なら（allowed_at があれば）許可済み
  revoked_reason TEXT CHECK (revoked_reason IN ('revoke', 'left')),
  notice_channel_id TEXT,           -- 定型文を投稿したチャンネル（返信先の照合）。外されたら NULL に戻す
  notice_message_id TEXT,           -- 定型文のメッセージ ID（返信先の照合）。NULL なら未投稿 = 次に投稿する
  notice_posted_at TEXT             -- 同上。外されたら NULL に戻す
);

-- 認証コード。平文は持たない。物理削除しない
CREATE TABLE guest_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,   -- sha256(正規化したコード) の hex
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,         -- created_at + 24 時間
  superseded_at TEXT,               -- 同じサーバーに新しいコードを発行した・取り消したときに無効にした時刻
  used_at TEXT,
  used_by_user_id TEXT,             -- 使った人（オーナーが取り消し・連絡のために見る。log には出さない）
  used_channel_id TEXT              -- 使ったチャンネル（同時に有効化したチャンネル）
);
CREATE INDEX guest_invites_guild ON guest_invites(guild_id, used_at, superseded_at);

-- 引き継ぎ: v23 までに /guest on で有効にしたチャンネルのあるサーバー（env の許可リストで許可されていたもの）は許可済みとして残す
INSERT INTO guest_guilds (guild_id, joined_at, allowed_at)
  SELECT guild_id, MIN(enabled_at), MIN(enabled_at) FROM guest_channels WHERE disabled_at IS NULL GROUP BY guild_id;
```

- 許可済み := `allowed_at IS NOT NULL AND revoked_at IS NULL`。再許可は `allowed_at = 今, revoked_at = NULL, revoked_reason = NULL`。
- 定型文を投稿する条件は **`notice_message_id IS NULL` の 1 つ**（§3.2.4）。外された（GuildDelete・起動時の不参加）ときに `notice_*` の 3 列を NULL に戻す（`clearNotice`）ので、再参加の印に `revoked_reason` は使わない。`revoked_*` を書くのは許可済みのサーバーを取り消すときだけで、参加の記録だけの行には書かない。
- 引き継いだサーバーには案内の記録が無いので、起動時の sweep が定型文を投稿する（既に有効なチャンネルがあっても。AI であること・ログに残ることの開示を、そのサーバーの参加者にも 1 度出す意味がある）。引き継ぎたくないサーバーは `/guests revoke`。
- `guest_channels` は変えない（`disabled_reason` の `command` は `/guest off` と `/guests revoke` の両方で使う。区別が要れば `revoke` を CHECK に足すが、サーバーの取り消しは `guest_guilds` を見れば分かるので足さない）。
- ストア: `src/store/guest.ts` に足すか、`src/store/guest-guilds.ts`（`GuestGuildStore`: `upsertJoined`・`get`・`isAllowed`・`allow`・`revoke(guildId, reason)`（許可済みの行だけ。未許可なら何もせず false）・`setNotice`・`clearNotice`・`list`）と `src/store/guest-invites.ts`（`GuestInviteStore`: `issue(guildId, now) → { code, expiresAt, replaced }`（生成とハッシュはこの中。平文は戻り値だけ）・`redeem(hash, guildId, now, userId, channelId)`・`supersedeAll(guildId)`・`activeFor(guildId)`）に分ける。**推し: 分ける**（`guest.ts` は既に 180 行で、表ごとに 1 ファイルの流儀）。許可・有効化・コードの消費を 1 トランザクションにする `activate` は `activation.ts` 側で `db.exec("BEGIN")` を持つより、ストアの 1 つ（`GuestInviteStore.redeemAndActivate`）に他の 2 つのストアを渡して閉じる方が既存（`GuestStore.enable`）の形に近い。実装者が決めてよい。
- 既存の表は変えない。移行の前の控え（`backupBeforeMigration`）は今の仕組みのまま。

---

## 5. 設定（環境変数）

| 変数 | 必須 | 既定 | 意味 |
|---|---|---|---|
| `SELF_AGENT_GUEST_DISCORD_TOKEN` | ゲストを使うなら | — | ゲスト Bot のトークン（v2 のまま） |
| `SELF_AGENT_GUEST_API_KEY` | ゲストを使うなら | — | Claude Platform の API キー（v2 のまま） |
| ~~`SELF_AGENT_GUEST_GUILD_IDS`~~ | — | — | **廃止。残っていれば設定エラー**（§3.2.1） |
| `SELF_AGENT_GUEST_MODEL` ほか任意の 8 つ | | | v2 のまま |

- 2 つ揃えば `guest: true`、2 つとも無ければ `guest: false`、1 つだけは設定エラー。
- 定数（`src/guest/constants.ts` に足す）: `GUEST_INVITE_TTL_HOURS = 24`、`GUEST_INVITE_FAIL_LIMIT = 5`、`GUEST_INVITE_LOCK_MIN = 10`、`GUEST_INVITE_PREFIX = "guest"`。
- `npm run guest-setup`（#151）: 訊くのは **トークンと API キーの 2 項目**。`GUEST_ENV_KEYS` から `SELF_AGENT_GUEST_GUILD_IDS` を外し、`validateGuildIds` は消す。接続の確認の `/users/@me/guilds` は「参加しているサーバー n 件」の表示に変える（未参加の警告は無くなる）。env に `SELF_AGENT_GUEST_GUILD_IDS` の行があれば「v3 で廃止された行があります。消しますか？」と確認して消す（`setup-env.ts` に `removeEnvLines(text, keys)` を足す。確認で断れば残し、起動時に設定エラーになることを 1 行出す）。

---

## 6. 文面（実装者が整えてよい。可変値は入れない）

**定型文（`buildGuestNoticeText(cfg)` の結果。ゲスト Bot がサーバーに入ったとき。Discord の Markdown）**:

```
こんにちは、**しのえもん** です。この Bot は **AI** です（人ではありません）。

**できること**
- このサーバーで有効にしたチャンネルで、しのえもん を **@メンション** するか、しのえもん の発言に**返信**すると答えます

**できないこと**
- ファイル・Web・コマンドの実行、通知・リマインド、長期の記憶（チャンネルの会話は一定の長さ・時間で新しくなります。前の会話は引き継ぎません）

**記録について**
- しのえもん とのやり取り（発言の本文・返事）は、この Bot の持ち主の手元に**会話の記録と利用量の記録として残り、持ち主が読めます**。見られて困ることは書かないでください

**使い始めるには**
- このサーバーの管理者（「サーバー管理」権限を持つ人）が、Bot の持ち主から受け取った認証コードを **このメッセージへの返信** として貼ってください（コード以外は書かないでください）。返信したチャンネルで答えるようになります
- 以後のチャンネルの追加・削除は管理者の `/guest on`・`/guest off`、確認は `/guest status`

**上限**
- サーバー全体で 1 日 300 回、1 人 1 日 50 回まで。1 回 2,000 字まで
```

- 上限の数字（1 日の回数・1 人の回数・字数）は `buildGuestNoticeText(cfg)` が `cfg`（`SELF_AGENT_GUEST_TURNS_PER_DAY` など）から**起動時に 1 回**組み立てる（数字のずれを残さない。可変値がキャッシュに関係するのはシステムプロンプトだけで、Discord の投稿は関係ない）。上の例は既定値。サーバー名・日付などは入れない。
- `@everyone`・`@here`・ロールのメンションを含まない。2,000 字以内（上の案は約 600 字）。

**有効化の返信（公開。その返信への返信として）**: 「有効にしました。」+ 改行 + `GUEST_ON_REPLY`（「このチャンネルで しのえもん をメンションすると答えます。**この Bot は AI です。** ファイル・Web・コマンドは使えません（会話だけ）。」）。上限なら「このサーバーを有効にしました。」+ `GUEST_LIMIT_REPLY`。

**`/guest`（ゲストのサーバー。ゲスト Bot）**: v2 の文面のまま。足すのは「このサーバーはまだ有効になっていません」（未許可。本人にだけ）と「サーバーの管理権限（サーバー管理）が必要です」（権限なし。本人にだけ）。

**`/guests`（メインサーバー。既定の人格の Bot。すべて本人にだけ）**: §3.2.3。

**オーナーの #system（既定の人格の Bot。/setup 済みのサーバーだけ。サーバー ID と数だけ。チャンネル ID・ユーザー ID・コードは入れない）**:

| きっかけ | 文 |
|---|---|
| 参加（案内を投稿できた） | 「ゲスト: サーバー <id> に参加し、案内を投稿しました」 |
| 参加（案内を投稿できない） | 「ゲスト: サーバー <id> に参加しましたが、案内を投稿できませんでした（投稿できるチャンネルがありません / 送信に失敗しました）」 |
| 発行 | 「ゲスト: サーバー <id> の認証コードを発行しました（24 時間有効）」 |
| 有効化（返信） | 「ゲスト: サーバー <id> を認証コードで有効にしました（チャンネル n/5。オーナー / 管理者）」 |
| 有効化の返信の失敗 | 「ゲスト: サーバー <id> で有効化の返信を投稿できませんでした（有効化は済んでいます）」 |
| 受け付けられなかったコード（返信者がオーナーか管理者のときだけ） | 「ゲスト: サーバー <id> で認証コードが受け付けられませんでした（期限切れ / 使用済み / 無効 / 別のサーバー向け）」（`not_found`・権限なし・ロック中は出さない） |
| 総当たりの間隔 | 「ゲスト: サーバー <id> で認証コードの失敗が 10 分以内に 5 回に達したため、10 分間は受け付けません」 |
| `/guest on` / `off` | 「ゲスト: サーバー <id> でチャンネルを有効化しました（n/5）」「…無効化しました（n/5）」（管理者なら末尾に「（管理者）」）。今のまま |
| 取り消し（`/guests revoke`） | 「ゲスト: サーバー <id> の許可を取り消しました（有効なチャンネル n 件を無効にしました）」 |
| 外された（GuildDelete。許可済みのサーバーだけ。未許可は log だけ） | 「ゲスト: サーバー <id> から外されたため、許可を取り消しました（有効なチャンネル n 件を無効にしました）」 |
| 起動時に参加していない（許可済みのサーバーだけ。未許可は log だけ） | 「ゲスト: サーバー <id> に参加していないため、許可を取り消しました（有効なチャンネル n 件を無効にしました）」 |
| 接続できない / 認証・請求の失敗 | GU3（v2 のまま） |

ターンの文面・/usage は v2 のまま。

---

## 7. 受け入れ条件（テストできる形）

単体（偽 Gateway・偽 Runner・一時 SQLite。`npm test`）。v2 の条件のうち env の許可リストに関わるものは次に置き換え、それ以外（認証・Options・hook・prompt・寿命・上限・usage・log・既存の層・停止）はそのまま通る:

config:
- トークン・API キーの 2 つ揃いで `guest: true`、2 つとも無ければ `guest: false` で既存のテストがそのまま通る、1 つだけは変数名を出す設定エラー。`SELF_AGENT_GUEST_GUILD_IDS` が（2 つ揃いでも、無くても）あれば「廃止」の文で設定エラー。空・空白だけ（`SELF_AGENT_GUEST_GUILD_IDS=`）なら無いものとして通る。`GuestConfig` に `guestGuildIds` が無い（型）。

DB・ストア:
- v23 の DB に有効な `guest_channels`（2 サーバー・うち 1 つは無効な行だけ）を入れて v24 に上げると、有効な行のあるサーバーだけ `guest_guilds` に許可済みで入り、`allowed_at` が最初の `enabled_at`。
- `issue` は 2 回目で前の行に `superseded_at` が付き、生きている行は常に 1 つ。戻り値のコードは `^guest(-[0-9a-hjkmnp-tv-z]{4}){6}$` に合い、DB にはその sha256 だけがある（平文の部分文字列が DB に無い）。
- `redeem`: 正しいコード → `ok` で `used_*` が入り、同じコードをもう一度 → `used`。期限（24 時間）を 1 秒過ぎたら `expired`。別のサーバー ID → `wrong_guild`。置き換えられた → `superseded`。知らないハッシュ → `not_found`。`ok` のときだけ `guest_guilds` が許可済みになり、`guest_channels` にそのチャンネルの有効な行ができる（1 トランザクション: `enable` が投げたら許可も使用も戻る）。
- `revoke` 後の `isAllowed` が false、再許可で true に戻り `revoked_*` が NULL。未許可の行に `revoke` を呼んでも `revoked_*` は書かれない（false）。`clearNotice` で `notice_*` の 3 列が NULL になり、`joined_at`・`allowed_at` は変わらない。

受付判定（access.ts）:
- fail-closed の (a) を「許可済みでない（行なし / 未許可 / 取り消し）」に置き換えて、(a)〜(g) のどれも run が呼ばれない。全部満たすときだけ動く。

有効化の返信（activation.ts。偽の IncomingMessage）:
- 定型文への返信 + 正しいコード + `authorCanManageGuild: true` → 公開の返信（「有効にしました」と「AI」を含む）、許可済み、チャンネル有効、#system に 1 行、SDK セッションが捨てられる。`/guest` の登録（`registerGuildCommands`）は呼ばれない。オーナー（権限 false）でも同じ。`type` が `undefined` の返信（偽の IncomingMessage で `replyToMessageId` あり）も同じ。
- 先頭に `<@BotID> ` が付いたコード（返信のメンション ON）は**通る**。`<@!BotID>` も同じ。「コードです <code>」のように別の文が付けば無反応。
- 権限の fetch: `authorCanManageGuild: undefined` のときだけ `memberCanManageGuild(guildId, authorId)` が 1 回呼ばれ、true なら通る・false（権限なし・いない・失敗）なら無反応。`true` / `false` のときは呼ばれない。形の合わない発言・ロック中・Bot の発言では呼ばれない。オーナーでは呼ばれない。
- 無反応（`send` も `sendMessage` も呼ばれない・log はサーバー ID と種類だけ）: 定型文でないメッセージへの返信 / 返信でないコードだけの発言 / 前後に別の文がある / 大文字小文字だけ違うコードは**通る**（正規化） / 権限なし / 期限切れ / 使用済み / 別のサーバーのコード / Bot・Webhook / 転送（`reference.type` が 1）。
- 間隔: DB を引く失敗（`not_found` など）が 10 分以内に 5 回で、6 回目は DB を引かず（ストアの `redeem` が呼ばれない）#system に 1 行。そこから 10 分後に戻り、戻った後の回数は 0。1 回目から 10 分より後の 5 回目は数に入らない（窓の外）。成功で 0 に戻る。**権限なし（`forbidden`）を何回重ねてもロックしない**（`redeem` は呼ばれ続ける）。
- 管理者（かオーナー）の返信で `expired` / `used` / `superseded` / `wrong_guild` → #system に「認証コードが受け付けられませんでした（…）」が 1 行（コード・ユーザー ID を含まない）。`not_found` では出ない。権限の無い人の同じ失敗では出ない。ロック中は出ない。
- 返信の `send` が投げても DB は許可済みのままで、#system に「有効化の返信を投稿できませんでした」。
- 発言の編集（MESSAGE_UPDATE）では有効化しない（Gateway に経路が無い。コードを後から編集で貼っても無反応。テストというより設計の前提）。

定型文（index.ts / onboarding）:
- `onGuildJoin` → `findNoticeChannels` の返した先頭の候補に `sendMessage` 1 回 → `guest_guilds` に `notice_*` が入る → `/guest` が登録される（参加の経路で 1 回。`onboardGuild` 単体のテストでは呼ばれない）→ #system に「参加し、案内を投稿しました」。同じサーバーでもう一度 `onGuildJoin`（再接続の想定）→ 何も投稿しない。
- `findNoticeChannels` が空 → 投稿せず、#system に「投稿できるチャンネルがありません」。先頭の候補で `sendMessage` が投げる → 2 つ目の候補に送って記録はそのチャンネル。3 つとも投げる → 「送信に失敗しました」。候補が 2 つなら 2 つで止まる。失敗のときは `notice_message_id` は NULL のまま。
- 行があり `notice_message_id` がある → `revoked_reason` が何であれ投稿しない。`clearNotice` の後 → 投稿する。
- 起動時（GU4b）: 参加しているが行の無いサーバー → 投稿。行があり案内済み → 投稿しない。外されて（`notice_*` が NULL）戻ったサーバー → 投稿し直し、許可は取り消しのまま。許可済みだが不参加 → 取り消し + チャンネル無効 + `notice_*` NULL + #system。**未許可で不参加 → `notice_*` NULL だけで `revoked_*` は書かれず #system も無し。** メインサーバーの ID は対象外。
- 起動時（GU4a）: 参加している全サーバー（メインを除く）に `guest_guilds` の行ができ（`joined_at` だけ）、`sendMessage` は呼ばれない。既にある行の `joined_at` は変わらない。
- `onGuildLeave`: 許可済み → 取り消し + チャンネル無効 + `notice_*` NULL + #system。未許可の行 → `notice_*` NULL だけ（`revoked_*` なし・#system なし）。行なし → 何も変えない。
- `/guests invite` で、参加していて `notice_message_id` が無い → 投稿して記録が入る。あるが `messageExists` が false → `notice_*` を消してから投稿し直し、記録が新しい ID になる。あって `messageExists` が true → 投稿しない。参加していなければ投稿せず応答に注記。どの場合も `registerGuildCommands` は呼ばれない。
- 定型文に `@everyone`・`@here` が無く、「しのえもん」「AI」「記録」「返信」「サーバー管理」を含み、2,000 字以内。

`/guest`（ゲストのサーバー）:
- 未許可のサーバー（行があり `allowed_at` が無い。GU4a の sweep が作った行を含む）→ 「まだ有効になっていません」（本人にだけ）。許可済みで権限なし → 「サーバーの管理権限（サーバー管理）が必要です」。`memberCanManageGuild: true` → on / off / status が今までのオーナーと同じ結果。オーナー（権限 false）も同じ。`ownerUserId` が `undefined` なら権限 false の人は誰も通らない。#system の文に「（管理者）」が付く / 付かない。`memberCanManageGuild(guildId, userId)`（fetch）は `/guest` では呼ばれない。

`/guests`（メインサーバー。既存の `createInteractionHandler` を通して）:
- オーナー以外 → `OWNER_ONLY_REPLY`。メインサーバー以外 → 無視（既存）。`guests` の依存が無ければ `/guests` が登録されない（`createCommands` の結果に無い）。
- `invite`: 数字でない / メインサーバーの ID → 断る。正しい ID → 応答（ephemeral）にコードが 1 回だけ出て、log・#system にコードが出ない。2 回目で「前のコードは無効にしました」。
- `revoke`: 許可済み → 取り消し + そのサーバーの有効なチャンネルが全部無効 + 生きているコードが無効 + #system。未許可 → 「許可していません」。定型文の記録は残る。
- `list`: 許可済み / 未許可（コードの期限） / 取り消し済み / 不参加 の行。

convert.ts（純関数）:
- `toMentionInfo` 相当に `replyToMessageId` が入る（`reference` があり `messageId` があり **`type !== 1`** のとき。`type` が 0 でも `undefined` でも入る。1（転送）・reference なし・`messageId` なし → 無い）。`authorCanManageGuild` は渡された値をそのまま（`true` / `false` / member なしの `undefined` の 3 通り）。`toCommandInteraction` に `memberCanManageGuild`（null → false）。既定の Bot の経路のテストは期待値に項目が増える以外は変わらない。

guest-setup:
- `GUEST_ENV_KEYS` が 2 つ。`removeEnvLines` が `SELF_AGENT_GUEST_GUILD_IDS` の行（`export` 付き・`=` の前の空白を含む）を消し、ほかの行を変えない。`upsertEnvLines` の既存のテストはそのまま通る。

log:
- ゲストの経路のどの log にもチャンネル ID・ユーザー ID・本文・表示名・API キー・**認証コード（平文もハッシュも）**が無い。

実機（API キーの従量課金。`npm run shell-check` のような専用のスクリプトは作らない。手順を GU3 の記録に残す）:
- **GuildCreate**: 動いているプロセスのゲスト Bot をテスト用のサーバーに招く → 定型文が 1 通 → #system に 1 行。そのまま再起動 → **同じサーバーに 2 通目が出ない**（確認済みの discord.js の挙動の追試）。プロセスを止めている間に別のサーバーに招いて起動 → 起動時の sweep で定型文が出る。
- **systemChannel**: システムメッセージのチャンネルを設定したサーバー / 未設定のサーバー / Bot が送れるテキストチャンネルが無いサーバー（全チャンネルで Send Messages を拒否）の 3 つで、投稿先と #system の文が §3.2.4 のとおり。
- **返信先**: 定型文に返信したときだけ `replyToMessageId` が入る（`reference.type` が 0 でも `undefined` でも。実機で届いた `type` の値を記録に残す）。転送（Forward。`type` 1）では入らない。
- **`member.permissions`（最重要の未確認）**: 管理者（サーバー管理あり・所有者でない）が定型文に返信 → 有効化される。log で `memberCanManageGuild` の fetch が動いたか（MESSAGE_CREATE に `member` が付いていたか）を記録に残す（付いていれば fetch は動かない。付いていなくても fetch で有効化できる。§10 の決定 3(b)）。権限の無いメンバーの返信 → 無反応。fetch も通らなければ（有効化できなければ）#system・log の種類を見て原因を切り分ける。
- `/guest on` を管理者が実行 → 通る（`memberPermissions`）。権限の無い人 → 断る文。
- `/guests invite` → `list` → 相手が貼る → `list` が許可済みに変わる → `/guests revoke` → そのサーバーでメンションしても答えない → 新しいコードで再許可できる。
- Bot をサーバーから外す → #system に「外されたため、許可を取り消しました」。もう一度招く → 定型文が出る（`notice_*` が消えているため再投稿）・許可は無いまま。許可していないサーバーから外して戻す → 定型文は出るが #system の「取り消し」は出ない。
- 定型文の返信に「メンション ON」のままコードを貼る（スマホの既定）→ 有効化される。
- v23 の本番 DB からの移行: 既存のゲストのサーバーが許可済みのまま答え続け、起動時に定型文が 1 通出る。

---

## 8. 段階（PR の分割。implementer に渡す粒度）

GU1・GU2・GU2b は main に入っている。残りを次の順で。

**分け方の比較**:

| 案 | 内容 | 最適度 |
|---|---|---|
| 1 PR | GU4 を 1 つの PR に | △: config・DB・store 2 つ・Gateway 3 ファイル・guest 5 ファイル・app/interactions・scripts・テスト 10 本超。1,500 行を超え、レビューで漏れる。失敗したときに戻す範囲も大きい |
| **2 PR** | **GU4a「許可の置き場を env から DB へ」→ GU4b「認証コードで許可を足す・取り消す」** | ◎: GU4a は土台（配線と型）で、単独でも main を壊さない（引き継ぎで既存のサーバーは動き続ける）。GU4b は機能。それぞれ 1 論点 |
| 3 PR | 2 PR の GU4b を「定型文」と「コード」に分ける | ○: 定型文だけ先に出ても有効化の手段が無いので、分ける意味が薄い |

- **推し: 2 PR。** GU4a → GU4b の順でマージ。GU4a がマージされてから GU4b がマージされるまでの間は、新しいゲストのサーバーを足せない（既存は動く）。その間に足す予定が無いことをオーナーに確認する（§10）。

### PR-GU4a 許可の置き場を env から DB へ（土台。キャッシュ影響なし）

1. `src/config.ts`: `loadGuestConfig` を 2 つ揃いに。`SELF_AGENT_GUEST_GUILD_IDS` があれば廃止の設定エラー。`GuestConfig.guestGuildIds` を消す。`test/config.test.ts`・`test/guest-config.test.ts` を直す。
2. `src/store/db.ts` v24（§4 の DDL + 引き継ぎの INSERT）。`src/store/guest-guilds.ts`（`GuestGuildStore`）と `src/store/guest-invites.ts`（`GuestInviteStore`。GU4a では表とストアまで。`issue`・`redeem` の単体テストも GU4a に入れる）。CLAUDE.md の `store/` の説明に 1 文。
3. `src/discord/gateway.ts`: `IncomingMessage.replyToMessageId?: string`・`authorCanManageGuild?: boolean`（`undefined` = `member` が無い）、`Interaction` の共通部分に `memberCanManageGuild?: boolean`。`src/discord/convert.ts`: `toMentionInfo` に `replyToMessageId`（`reference` があり `messageId` があり **`type !== 1`** のとき。`type` が `undefined` の返信も通す）、`toCommandInteraction` に `memberCanManageGuild`（引数で boolean を受ける）。`src/discord/discord-gateway.ts`: `DiscordGatewayOptions.onGuildJoin?`・`warnOnUnlistedGuild?`、`toIncoming` で `message.member ? message.member.permissions.has(PermissionFlagsBits.ManageGuild) : undefined`、`DiscordGateway.listGuildIds()`・`findNoticeChannels(guildId)`（§3.2.4 の順・最大 3 つ）。`memberCanManageGuild(guildId, userId)`（fetch）は GU4b。既定の Bot は配線しない。`test/convert.test.ts` に純関数の分を足す。
4. `src/guest/access.ts`: `guestGuildIds` → `guildAllowed: boolean`。`src/guest/index.ts`: `GuestGateway` 型（`Gateway` の Pick）に `listGuildIds`・`findNoticeChannels`・`registerGuildCommands`・`messageExists`・**`sendMessage`** を足し、DiscordGateway を `warnOnUnlistedGuild: false` で作り、起動時の sweep を §3.2.7 の 2（**参加している全サーバーに `upsertJoined` だけ。投稿しない**）・3（取り消し。未許可の行は `clearNotice` だけ）・4（全サーバーへの `/guest` の登録）に。`onGuildLeave` で許可も取り消す（未許可の行は `clearNotice` だけ）。**定型文の投稿（`onboardGuild`）と参加の経路（`onGuildJoin`）は GU4b**。`src/guest/interactions.ts`: 「ゲストのサーバーの外」の判定を `guest_guilds` の行の有無に。`src/guest/commands/guest.ts`: 未許可の断り・権限の判定（オーナーまたは `memberCanManageGuild`）・#system の「（管理者）」。`src/guest/notify.ts` の文を §6 に合わせる。
5. `startGuest` を `createGuestLayer(deps) → { admin, start(stopping), idle, stop }` に分ける（GU4b の `/guests` が `createCommands` の前に `admin` を必要とするため。GU4a では `admin` は空のオブジェクトでよいが、形だけ作る）。main.ts は `createCommands` の前に `createGuestLayer`、今の `startGuest` の位置で `start()`。
6. `scripts/guest-setup.ts`・`src/guest/setup-env.ts`: 2 項目化、`removeEnvLines`、廃止の行の確認。`test/guest-setup-env.test.ts`。
7. テスト: `guest-access`・`guest-command`・`guest-handler`・`guest-layers`・`guest-store`（新しいストア）・`convert`・`config`。
8. PR の説明に「デプロイの前に env から `SELF_AGENT_GUEST_GUILD_IDS` を消す（`npm run guest-setup` でも消せる）。既存のゲストのサーバーは移行で許可済みとして引き継ぐ」を書く。

### PR-GU4b 認証コードで許可を足す・取り消す（定型文・発行・返信の検証・取り消し）

1. `src/guest/constants.ts`: `GUEST_INVITE_*`。`src/guest/invite-code.ts`（純関数: `generateInviteCode(randomBytes)`・`parseInviteCode(text)`・`hashInviteCode(code)`）。
2. `src/guest/notice.ts`: `buildGuestNoticeText(cfg)`（§6。起動時に 1 回）と `onboardGuild`（§3.2.4: upsert → `notice_message_id` があれば終わり → 候補（最大 3）→ 順に投稿 → 記録 → #system。**`/guest` の登録は含めない**）。`index.ts` の `onGuildJoin`（その後に `registerGuildCommands` を 1 回）と sweep の 2（GU4a の `upsertJoined` だけを置き換える）と `/guests invite` の再投稿から呼ぶ。`src/discord/discord-gateway.ts`・`GuestGateway` に `memberCanManageGuild(guildId, userId): Promise<boolean>`（`guild.members.fetch(userId)` を 1 回。失敗・いない・権限なしは false）。`GuestGuildStore.clearNotice` を sweep の 3・`onGuildLeave`・`/guests invite` から使う。
3. `src/guest/activation.ts`: `handleReply`（§3.2.5 の順。`stripBotMention` → `parseInviteCode` → 間隔（DB を引く失敗だけ。10 分の窓で 5 回 → 10 分）→ 権限（オーナー → `authorCanManageGuild` → `undefined` のときだけ fetch。`forbidden` は数えない）→ `redeem` → 返信。管理者の `expired` などの #system）。`index.ts` の `onMessage` の先頭で「定型文への返信か」を見て振り分ける。
4. `src/guest/commands/admin.ts`: `/guests invite|revoke|list`（§3.2.3）。`src/app/interactions.ts` の `createCommands` に任意の `guests` を足す（`jobs` と同じ形）。main.ts で `createGuestLayer(...).admin` を渡す。
5. `src/guest/notify.ts`: §6 の文（発行・有効化・返信の失敗・受け付けられなかったコード・間隔・取り消し）。
6. テスト: `guest-invite-code`（純関数）・`guest-activation`・`guest-notice`・`guest-admin-command`・`guest-command`（追加分）・`interactions`（`/guests` の登録の有無）。
7. CLAUDE.md の概要の 1 行と `guest/` の説明。

### PR-GU3 運用（最後。v2 のまま + v3 の分）

README・README_ja・REQUIREMENTS・CLAUDE.md の更新。v3 で直すもの: `SELF_AGENT_GUEST_GUILD_IDS` の記述を消す（CLAUDE.md の環境変数の表・`config.ts` の説明・`guest/` の説明・`store/` の説明）、`npm run guest-setup` の説明（2 項目）、ゲストのサーバーの足し方（招待 → `/guests invite` → 管理者が返信）と外し方（`/guests revoke`）、定型文の上限の数字の注記、Developer Portal の手順（Public Bot オフ・権限 View Channels / Send Messages / Read Message History・MessageContent intent・scope `bot` + `applications.commands`）、Console の API キーと Max の月次クレジット、どちらの `CLAUDE_CONFIG_DIR` にも `claude login` しない、実機の受け入れの記録（§7）。接続の知らせ・認証/請求の失敗の #system は v2 のまま GU3。

順序: GU4a → GU4b → GU3。GU4a と GU4b は並行して作れるが、GU4b は GU4a のブランチの上に積む。

---

## 9. 決定事項

この案で決めたこと（v2 から引き継ぎ）: 別のアプリ・同じプロセス・別の層（§3.1）、Options で無くす + 全拒否の hook（§3.3）、チャンネル単位の resume と要約なしの捨て方（§3.4）、専用キュー（§3.5）、本文を残さない・usage の印（§3.6）、既存の層に触れない（§3.7）。

この案（v3）で決めたこと: 古い env は設定エラー（§3.2.1 の A）、コードの形・24 時間・ハッシュ・使った人を保存・物理削除しない（§3.2.2）、`/guests invite|revoke|list`・本体は `src/guest/commands/admin.ts`・発行時に消えた定型文を投稿し直す（§3.2.3）、定型文の投稿先の候補（systemChannel も権限を見る。最大 3 つを順に試す）と再投稿の条件（`notice_message_id IS NULL` の 1 つ。外されたら `notice_*` を消す。§3.2.4）、返信の検証の順・無反応・間隔（DB を引く失敗だけを数え、10 分以内に 5 回で 10 分。権限なしは数えない。§3.2.5）、返信の判定は `type !== 1`（§1・§3.2.5）、権限は `member` が無いときだけ fetch で 1 回（§10 の 3(b)。GU4b）、`/guest` は参加した時点で登録し、経路は参加と起動の sweep の 2 つだけ（§3.2.6 の i）、起動時の sweep（GU4a は upsert だけ。§3.2.7）、DB の形と引き継ぎ（§4）、定型文は `buildGuestNoticeText(cfg)` で起動時に 1 回（§6）、2 PR（§8）。

オーナーが決めたこと（2026-10-23。v2）:
1. **認証**: ゲストの層は Claude Platform の API キー、オーナー側は OAuth（§3.0）。AI である旨をシステムプロンプトと有効化の知らせに入れる。
2. **Bot**: 専用 Bot・同じプロセス（1-b）。
3. ~~**有効化**: オーナーだけ（2-b）~~ → 2026-10-25 の 5・6 で置き換え。
4. **応答**: メンション・Bot への返信のときだけ（5-b）。
5. **上限の既定**: サーバー 300 回/日・ユーザー 50 回/日。連投 5 秒・2,000 字・同時 1・5 チャンネル/サーバー。
6. **記録のファイル**: 捨てた SDK セッションの jsonl は消さない。
7. **devlog**: ゲストの run は記録しない。
8. **表示名**: モデルに渡す。
9. **呼び名**: 「しのえもん」（コードに書く）。
10. **#inbox からゲストの状況を聞くツール**: 作らない。

オーナーが決めたこと（2026-10-25。v3。動かせない）:
1. **トークンと API キーは env のまま**（`SELF_AGENT_GUEST_DISCORD_TOKEN`・`SELF_AGENT_GUEST_API_KEY`。`npm run guest-setup` も残す）。Discord に貼らない。
2. **`SELF_AGENT_GUEST_GUILD_IDS` は廃止**し、サーバーの許可は認証コードで行う。ゲストが有効になる条件はトークンと API キーの 2 つ揃い（1 つだけは設定エラーのまま）。残っていたときの扱いは §3.2.1（この案は設定エラーを推す）。
3. **認証コードの発行**: オーナーがメインサーバーで、ゲストのサーバー ID を入れて発行する（既定の人格の Bot が登録するオーナー専用のコマンド。応答は本人にだけ）。コードはそのサーバー ID に紐づき、使い捨て、有効期限あり（24 時間）。DB にはハッシュだけ（平文は応答に 1 回）。同じサーバーに未使用のコードがあれば置き換える。
4. **ゲスト Bot が新しいサーバーに入ったら**既定のチャンネルに定型文を 1 通（呼び名・AI であること・できること / できないこと・会話がログに残ること・管理者が返信で認証コードを貼ると有効になること・1 日の上限）。既定のチャンネルは systemChannel → Bot が送れる最初のテキストチャンネル → 無ければ投稿しない。投稿できなかったときは #system に理由付きで、できたときも 1 行。再起動時に既に参加しているサーバーには投稿し直さない（投稿済みの印を DB に）。
5. **有効化**: 定型文への返信で、本文が認証コードだけ（前後の空白は除く。形が合わないものは無視）、返信した人がオーナーまたは Manage Server 権限のメンバーのとき、コードがそのサーバー向け・未使用・期限内なら、サーバーを許可（DB）し、返信があったチャンネルを有効にして、公開で「有効にしました」（AI の明示付き）。使ったら無効。対象外には反応しない（log はサーバー ID と種類だけ。総当たりへの備えは §3.2.5）。有効化の返信を投稿できなければ #system に知らせる（有効化は DB に残す）。
6. **チャンネルの増減**: 許可済みのサーバーでは `/guest on|off|status` をオーナーまたは Manage Server 権限のメンバーが使える（上限 5 のまま）。それ以外の人には本人にだけ断る。登録のタイミングは §3.2.6（この案は参加した時点を推す）。
7. **Bot が外された・許可の取り消し**: GuildDelete で今までどおり無効化。オーナーがメインサーバーから特定のサーバーの許可を取り消す手段を 1 つ用意する。取り消したサーバーの `guest_channels` は全部無効にし、定型文の投稿済みの印は残す（再投稿しない）。もう一度許可するには新しいコード。
8. **既存のゲートは残す**: 発言の fail-closed の判定は「許可済みのサーバー（DB）∧ 有効なチャンネル ∧ ゲスト Bot の Gateway ∧ Bot/Webhook でない ∧ メンションか返信」のまま。env の許可リストが DB に変わるだけ。
9. `npm run guest-setup` はサーバー ID を訊かなくする（2 項目）。CLAUDE.md・README は GU3 でまとめる（§8 の GU3）。

実装者が決めてよいこと: 文言の細部、`/guests` の名前（`guest-admin` でも）、ストアのファイル分けとメソッド名、`activate` のトランザクションの置き場、`findNoticeChannels` の (b) の並べ方の細部、バッククォートの除去、間隔の時刻の持ち方（配列か ring）、テストのファイル分け。

---

## 10. 残っていた論点と決定（2026-10-25）

前提の事実: この時点で env にゲストの変数は無く、ゲストのサーバーも `guest_channels` の行も無い（GU1・GU2 は本番で一度も有効にしていない）。

- 1 は**引き継ぐ**（§4 の INSERT はそのまま。今は行が無いので実際には何も引き継がれない）。
- 2 は**2 PR のまま**（GU4a と GU4b の間に足すゲストのサーバーは無い）。
- 3 は **(b)**: 返信に `member` が無ければ `guild.members.fetch(authorId)` を 1 回。取れなければ false のまま fail-closed。実機で `member` が付いていれば fetch は動かない。

元の論点:


1. **引き継ぎ**（§4）: v24 の移行で、今 `/guest on` で有効なチャンネルのあるサーバーを許可済みとして引き継ぐ（この案の推し。起動時にそのサーバーに定型文が 1 通出る）か、引き継がずに全部を新しいコードで許可し直す（データは「コードで許可したものだけ」に揃うが、更新直後にゲストのサーバーが答えなくなる）か。
2. **GU4a と GU4b の間**（§8）: GU4a だけがマージされている間は新しいゲストのサーバーを足せない。その期間に足す予定が無いか。あるなら 1 PR にまとめる。
3. **`member.permissions` が MESSAGE_CREATE で取れなかったとき**（§1 の未確認・§7 の実機）の代替: (a) 有効化の返信はオーナーだけが行える（管理者は `/guest on` だけ。`memberPermissions` は interaction に必ず付くので `/guest` 側は影響しない）、(b) 返信を受けたときに `guild.members.fetch(authorId)` で 1 回取りに行く（REST 1 回。GuildMembers intent は要らない）。この案は **(b) を推す**（決定 5 の「管理者が返信で有効化」を保てる。取れなければ false のまま fail-closed）。実機で取れていれば決めなくてよい。
