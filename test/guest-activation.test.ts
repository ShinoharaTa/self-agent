// 定型文への返信による有効化（docs/plan/guest-mode.md §3.2.5・§7）。createGuestLayer に偽の発言を渡して確かめる
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "../src/discord/gateway.ts";
import { createGuestActivation, GUEST_ACTIVATED_LIMIT_REPLY, GUEST_ACTIVATED_REPLY } from "../src/guest/activation.ts";
import { guestSessionKey } from "../src/guest/constants.ts";
import { createGuestLayer } from "../src/guest/index.ts";
import { GuestStore } from "../src/store/guest.ts";
import { GuestGuildStore } from "../src/store/guest-guilds.ts";
import { GuestInviteStore } from "../src/store/guest-invites.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";
import { tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { FakeGuestGateway } from "./helpers/guest-gateway.ts";
import { FakeRunner } from "./helpers/runner.ts";

const OWNER = "owner-1";
const OWNER_GUILD = "g-owner";
const GUILD = "g-guest";
const OTHER_GUILD = "g-other";
const BOT = "bot-1";
const NOTICE_CHANNEL = "c-notice";
const NOTICE_MESSAGE = "m-notice";
const ADMIN_USER = "user-admin";
const USER = "user-2";
const NOW = new Date("2026-10-25T00:00:00.000Z");
const MINUTE = 60_000;

const CFG = {
  allowedGuildIds: [OWNER_GUILD],
  ownerUserId: OWNER as string | undefined,
  timeZone: "Asia/Tokyo",
  guestTokenEnv: "SELF_AGENT_GUEST_DISCORD_TOKEN",
  guestTurnsPerDay: 300,
  guestUserTurnsPerDay: 50,
  guestMaxConcurrent: 1,
  guestSessionMaxTurns: 30,
  guestSessionMaxInputTokens: 60000,
};

async function setup(t: TestContext, cfg: typeof CFG = CFG) {
  const db = tempDb(t);
  let current = NOW;
  const now = () => current;
  const guest = new GuestStore(db, now);
  const guilds = new GuestGuildStore(db);
  // 参加して定型文を投稿済み（未許可）
  guilds.upsertJoined(GUILD, NOW);
  guilds.setNotice(GUILD, NOTICE_CHANNEL, NOTICE_MESSAGE, NOW);
  const store = new GuestInviteStore(db, { guilds, channels: guest });
  let redeemCalls = 0;
  const invites = {
    issue: store.issue.bind(store),
    supersedeAll: store.supersedeAll.bind(store),
    activeFor: store.activeFor.bind(store),
    listActive: store.listActive.bind(store),
    redeem: (...args: Parameters<GuestInviteStore["redeem"]>) => {
      redeemCalls++;
      return store.redeem(...args);
    },
  };
  const sessions = new SdkSessionStore(db, now);
  const guildSettings = new GuildSettingsStore(db, now);
  guildSettings.setChannel(OWNER_GUILD, "systemChannelId", "system-1");
  const admin = new FakeGateway({ allow: ["sendMessage"] });
  const gateway = new FakeGuestGateway();
  gateway.joined.add(GUILD);
  gateway.selfUserId = () => BOT;
  const logs: string[] = [];
  const layer = createGuestLayer({
    cfg,
    guest,
    guilds,
    invites,
    sessions,
    // 定型文への返信はターンにしない（run を呼べば「想定外の呼び出し」で失敗する）
    runner: new FakeRunner([]),
    usage: new UsageStore(db, now),
    guildSettings,
    adminGateway: admin,
    now,
    log: (line) => logs.push(line),
    createGateway: () => gateway,
  });
  await layer.start(() => false);
  // 起動時の sweep の分（/guest の登録・案内済みの確かめ）は数えない
  const registeredAtStart = gateway.registered.length;
  logs.length = 0;
  /** 発言を 1 つ渡して、処理が終わるまで待つ */
  const send = async (message: IncomingMessage): Promise<void> => {
    gateway.handlers!.onMessage(message);
    await layer.idle();
  };
  return {
    db,
    guest,
    guilds,
    store,
    sessions,
    admin,
    gateway,
    logs,
    send,
    registeredAtStart,
    redeemCalls: () => redeemCalls,
    setNow: (date: Date) => {
      current = date;
    },
    /** 有効なコードを発行する（平文を返す） */
    issue: (guildId: string = GUILD) => store.issue(guildId, current).code,
  };
}

/** 定型文への返信（既定は管理者で、発言に member が付いていた） */
function reply(content: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: "m-reply",
    channelId: NOTICE_CHANNEL,
    guildId: GUILD,
    authorId: ADMIN_USER,
    authorIsBot: false,
    isWebhook: false,
    content,
    createdAt: NOW,
    persona: "guest",
    replyToMessageId: NOTICE_MESSAGE,
    replyToAuthorId: BOT,
    authorCanManageGuild: true,
    ...overrides,
  };
}

function systemTexts(admin: FakeGateway): string[] {
  return admin.posts.map((post) => post.message.text);
}

/** log にチャンネル ID・ユーザー ID・コード（平文もハッシュも）が出ていない（サーバー ID は出してよい） */
function assertNoSecrets(logs: readonly string[], codes: readonly string[] = []): void {
  const secrets = [NOTICE_CHANNEL, NOTICE_MESSAGE, "m-reply", ADMIN_USER, USER, OWNER, "system-1", "c-other", ...codes];
  for (const line of logs) {
    for (const secret of secrets) assert.ok(!line.includes(secret), `${secret} が log に出ています: ${line}`);
    assert.ok(!/guest-[0-9a-z]{4}-/.test(line), `コードが log に出ています: ${line}`);
    assert.ok(!/[0-9a-f]{64}/.test(line), `ハッシュが log に出ています: ${line}`);
  }
}

test("有効化: 管理者が定型文に正しいコードを返信すると、公開の返信・許可・チャンネルの有効化・#system・SDK セッションの破棄。/guest の登録は呼ばれない", async (t) => {
  const env = await setup(t);
  env.sessions.set(guestSessionKey(NOTICE_CHANNEL), "old-session");
  const code = env.issue();
  await env.send(reply(code));

  assert.deepEqual(env.gateway.sent, [{ channelId: NOTICE_CHANNEL, text: GUEST_ACTIVATED_REPLY, replyToId: "m-reply" }]);
  assert.ok(GUEST_ACTIVATED_REPLY.startsWith("有効にしました。"));
  assert.ok(GUEST_ACTIVATED_REPLY.includes("AI"));
  assert.equal(env.guilds.isAllowed(GUILD), true);
  assert.equal(env.guest.get(NOTICE_CHANNEL)?.disabledAt, null);
  assert.equal(env.sessions.get(guestSessionKey(NOTICE_CHANNEL)), undefined);
  assert.deepEqual(systemTexts(env.admin), ["ゲスト: サーバー g-guest を認証コードで有効にしました（チャンネル 1/5。管理者）"]);
  assert.equal(env.gateway.registered.length, env.registeredAtStart);
  // 発言に member があったので権限は取りに行かない
  assert.deepEqual(env.gateway.calls.filter((call) => call.startsWith("memberCanManageGuild")), []);
  assertNoSecrets(env.logs, [code]);
});

test("有効化: オーナーなら権限が false でも通り、#system は「オーナー」。type が undefined の返信（replyToMessageId あり）も同じ", async (t) => {
  const env = await setup(t);
  await env.send(reply(env.issue(), { authorId: OWNER, authorCanManageGuild: false }));
  assert.equal(env.gateway.sent.length, 1);
  assert.equal(env.guilds.isAllowed(GUILD), true);
  assert.deepEqual(systemTexts(env.admin), ["ゲスト: サーバー g-guest を認証コードで有効にしました（チャンネル 1/5。オーナー）"]);
  assert.deepEqual(env.gateway.calls.filter((call) => call.startsWith("memberCanManageGuild")), []);
  assertNoSecrets(env.logs);
});

test("有効化: 返信のメンション（<@BotID>・<@!BotID>）は除いて読む。大文字・バッククォートも通る。前後に別の文があれば無反応", async (t) => {
  for (const wrap of [
    (code: string) => `<@${BOT}> ${code}`,
    (code: string) => `<@!${BOT}> ${code}`,
    (code: string) => code.toUpperCase(),
    (code: string) => `\`${code}\``,
  ]) {
    const env = await setup(t);
    await env.send(reply(wrap(env.issue())));
    assert.equal(env.guilds.isAllowed(GUILD), true);
    assert.equal(env.gateway.sent.length, 1);
  }
  const env = await setup(t);
  const code = env.issue();
  await env.send(reply(`コードです ${code}`));
  await env.send(reply(`${code} お願いします`));
  assert.equal(env.guilds.isAllowed(GUILD), false);
  assert.equal(env.redeemCalls(), 0);
  assert.deepEqual(env.gateway.sent, []);
  assert.deepEqual(env.admin.posts, []);
  assert.deepEqual(env.logs, []);
});

test("無反応: 定型文でないメッセージへの返信・返信でない発言・別のチャンネルの同じ ID・転送（replyToMessageId なし）は有効化に回らない", async (t) => {
  const env = await setup(t);
  const code = env.issue();
  await env.send(reply(code, { replyToMessageId: "m-other" }));
  await env.send(reply(code, { replyToMessageId: undefined, replyToAuthorId: undefined }));
  await env.send(reply(code, { channelId: "c-other" }));
  await env.send(reply(code, { guildId: OTHER_GUILD }));
  assert.equal(env.redeemCalls(), 0);
  assert.equal(env.guilds.isAllowed(GUILD), false);
  assert.deepEqual(env.gateway.sent, []);
  assert.deepEqual(env.admin.posts, []);
  // コードはまだ使える
  assert.notEqual(env.store.activeFor(GUILD, NOW), undefined);
  assertNoSecrets(env.logs, [code]);
});

test("無反応: Bot・Webhook の返信は捨て（log は種類だけ）、権限も DB も引かない", async (t) => {
  const env = await setup(t);
  const code = env.issue();
  await env.send(reply(code, { authorIsBot: true, authorCanManageGuild: undefined }));
  await env.send(reply(code, { isWebhook: true, authorCanManageGuild: undefined }));
  assert.equal(env.redeemCalls(), 0);
  assert.deepEqual(env.gateway.calls, []);
  assert.deepEqual(env.gateway.sent, []);
  assert.deepEqual(env.logs, [
    "guest: 案内への返信を受け付けませんでした（guild=g-guest、bot）",
    "guest: 案内への返信を受け付けませんでした（guild=g-guest、bot）",
  ]);
});

test("権限: authorCanManageGuild が true / false なら取りに行かず、undefined のときだけ memberCanManageGuild を 1 回。false なら無反応で失敗に数えない", async (t) => {
  const env = await setup(t);
  const code = env.issue();
  // 権限なし（member あり）: 取りに行かない・DB を引かない
  await env.send(reply(code, { authorId: USER, authorCanManageGuild: false }));
  assert.deepEqual(env.gateway.calls, []);
  assert.equal(env.redeemCalls(), 0);
  // member なし: 1 回取りに行き、false なら無反応
  env.gateway.canManage = false;
  await env.send(reply(code, { authorId: USER, authorCanManageGuild: undefined }));
  assert.deepEqual(env.gateway.calls, ["memberCanManageGuild:g-guest"]);
  assert.equal(env.redeemCalls(), 0);
  assert.equal(env.guilds.isAllowed(GUILD), false);
  assert.deepEqual(env.gateway.sent, []);
  assert.deepEqual(env.admin.posts, []);
  // 権限なしを何回重ねてもロックしない
  for (let index = 0; index < 6; index++) await env.send(reply(code, { authorId: USER, authorCanManageGuild: false }));
  // member なしで取れれば通る
  env.gateway.canManage = true;
  await env.send(reply(code, { authorCanManageGuild: undefined }));
  assert.deepEqual(env.gateway.calls, ["memberCanManageGuild:g-guest", "memberCanManageGuild:g-guest"]);
  assert.equal(env.guilds.isAllowed(GUILD), true);
  assert.deepEqual(systemTexts(env.admin), ["ゲスト: サーバー g-guest を認証コードで有効にしました（チャンネル 1/5。管理者）"]);
  assert.ok(env.logs.includes("guest: 返信者の権限を Discord から取ります（guild=g-guest）"));
  assert.ok(env.logs.includes("guest: 案内への返信を受け付けませんでした（guild=g-guest、forbidden）"));
  assertNoSecrets(env.logs, [code]);
});

test("権限: オーナー・形の合わない発言では memberCanManageGuild を呼ばない。SELF_AGENT_OWNER_ID が無ければ権限 false の人は通らない", async (t) => {
  const env = await setup(t);
  await env.send(reply(env.issue(), { authorId: OWNER, authorCanManageGuild: undefined }));
  await env.send(reply("こんにちは", { authorCanManageGuild: undefined }));
  assert.deepEqual(env.gateway.calls, []);
  assert.equal(env.guilds.isAllowed(GUILD), true);

  const noOwner = await setup(t, { ...CFG, ownerUserId: undefined });
  await noOwner.send(reply(noOwner.issue(), { authorId: OWNER, authorCanManageGuild: false }));
  assert.equal(noOwner.guilds.isAllowed(GUILD), false);
  assert.equal(noOwner.redeemCalls(), 0);
});

test("DB の失敗: 期限切れ・使用済み・置き換え済み・別のサーバー向けは無反応で、管理者なら #system に 1 行。not_found は #system に出さない", async (t) => {
  const env = await setup(t);
  // 別のサーバー向け
  const other = env.issue(OTHER_GUILD);
  await env.send(reply(other));
  // 置き換え済み
  const old = env.issue();
  const fresh = env.issue();
  await env.send(reply(old));
  // 知らないコード
  await env.send(reply("guest-0000-0000-0000-0000-0000-0000"));
  // 期限切れ（24 時間を 1 秒過ぎた）
  env.setNow(new Date(NOW.getTime() + 24 * 3_600_000 + 1_000));
  await env.send(reply(fresh));
  assert.equal(env.guilds.isAllowed(GUILD), false);
  assert.deepEqual(env.gateway.sent, []);
  assert.deepEqual(systemTexts(env.admin), [
    "ゲスト: サーバー g-guest で認証コードが受け付けられませんでした（別のサーバー向け）",
    "ゲスト: サーバー g-guest で認証コードが受け付けられませんでした（無効）",
    "ゲスト: サーバー g-guest で認証コードが受け付けられませんでした（期限切れ）",
  ]);
  for (const kind of ["wrong_guild", "superseded", "not_found", "expired"]) {
    assert.ok(env.logs.includes(`guest: 案内への返信を受け付けませんでした（guild=g-guest、${kind}）`), kind);
  }
  assertNoSecrets(env.logs, [other, old, fresh]);
});

test("DB の失敗: 使用済みのコードを管理者が貼ると #system に「使用済み」。権限の無い人の同じ失敗では出ない", async (t) => {
  const env = await setup(t);
  const code = env.issue();
  await env.send(reply(code));
  assert.equal(env.guilds.isAllowed(GUILD), true);
  env.admin.posts.length = 0;
  await env.send(reply(code, { channelId: NOTICE_CHANNEL }));
  assert.deepEqual(systemTexts(env.admin), ["ゲスト: サーバー g-guest で認証コードが受け付けられませんでした（使用済み）"]);
  env.admin.posts.length = 0;
  await env.send(reply(code, { authorId: USER, authorCanManageGuild: false }));
  assert.deepEqual(env.admin.posts, []);
});

test("間隔: DB を引く失敗が 10 分以内に 5 回で、6 回目は DB を引かず #system に 1 行。10 分後に戻り、戻った後の回数は 0", async (t) => {
  const env = await setup(t);
  const bad = "guest-0000-0000-0000-0000-0000-0000";
  for (let index = 0; index < 5; index++) {
    env.setNow(new Date(NOW.getTime() + index * MINUTE));
    await env.send(reply(bad));
  }
  assert.equal(env.redeemCalls(), 5);
  const lockText = "ゲスト: サーバー g-guest で認証コードの失敗が 10 分以内に 5 回に達したため、10 分間は受け付けません";
  assert.deepEqual(systemTexts(env.admin), [lockText]);
  // ロック中は正しいコードでも DB も権限も引かず、log も #system も無し
  const code = env.issue();
  const logsBefore = env.logs.length;
  env.setNow(new Date(NOW.getTime() + 13 * MINUTE));
  await env.send(reply(code, { authorCanManageGuild: undefined }));
  await env.send(reply(bad));
  assert.equal(env.redeemCalls(), 5);
  assert.deepEqual(env.gateway.calls, []);
  assert.equal(env.logs.length, logsBefore);
  assert.deepEqual(systemTexts(env.admin), [lockText]);
  // 5 回目（4 分）から 10 分後に戻る。戻った後の回数は 0（4 回失敗してもロックしない）
  for (let index = 0; index < 4; index++) {
    env.setNow(new Date(NOW.getTime() + (14 + index) * MINUTE));
    await env.send(reply(bad));
  }
  assert.equal(env.redeemCalls(), 9);
  assert.deepEqual(systemTexts(env.admin), [lockText]);
  // 窓の中で 5 回目になるとまたロック
  env.setNow(new Date(NOW.getTime() + 18 * MINUTE));
  await env.send(reply(bad));
  assert.deepEqual(systemTexts(env.admin), [lockText, lockText]);
  assert.equal(env.logs.filter((line) => line.includes("回に達したため")).length, 2);
  assertNoSecrets(env.logs, [code]);
});

test("間隔: 1 回目から 10 分より後の 5 回目は数に入らない（窓の外）。成功で 0 に戻る。サーバーごとに数える", async (t) => {
  const env = await setup(t);
  const bad = "guest-0000-0000-0000-0000-0000-0000";
  for (const minute of [0, 3, 6, 9, 11]) {
    env.setNow(new Date(NOW.getTime() + minute * MINUTE));
    await env.send(reply(bad));
  }
  assert.deepEqual(env.admin.posts, []);
  // 4 回（3・6・9・11 分）数えた後に成功すると 0 に戻る
  await env.send(reply(env.issue()));
  assert.equal(env.guilds.isAllowed(GUILD), true);
  env.admin.posts.length = 0;
  for (const minute of [12, 13, 14, 15]) {
    env.setNow(new Date(NOW.getTime() + minute * MINUTE));
    await env.send(reply(bad));
  }
  assert.deepEqual(env.admin.posts, []);
  assert.equal(env.redeemCalls(), 10);
});

test("間隔: 窓（10 分）を過ぎた失敗だけのサーバーの項目は、次に失敗を数える・引くときに消える（失敗の Map は有界）", async () => {
  let current = NOW;
  const activation = createGuestActivation({
    cfg: { ownerUserId: OWNER },
    invites: { redeem: () => ({ result: "not_found" }) },
    guest: { countActive: () => 0 },
    sessions: { delete: () => {} },
    gateway: {
      send: async () => {
        throw new Error("想定外の呼び出し");
      },
      selfUserId: () => BOT,
      memberCanManageGuild: async () => false,
    },
    notify: async () => {},
    now: () => current,
    log: () => {},
  });
  const bad = "guest-0000-0000-0000-0000-0000-0000";
  await activation.handleReply(reply(bad));
  await activation.handleReply(reply(bad, { guildId: OTHER_GUILD }));
  assert.equal(activation.size(), 2);
  // 11 分後にほかのサーバーの失敗を数えると、窓を過ぎた失敗だけの 2 つの項目は消える
  current = new Date(NOW.getTime() + 11 * MINUTE);
  await activation.handleReply(reply(bad, { guildId: "g-third" }));
  assert.equal(activation.size(), 1);
  // 失敗を数えない（権限の無い人の貼り付け）ときも、引いた項目の失敗が窓を過ぎていれば消える
  current = new Date(NOW.getTime() + 22 * MINUTE);
  await activation.handleReply(reply(bad, { guildId: "g-third", authorCanManageGuild: false }));
  assert.equal(activation.size(), 0);
});

test("上限: チャンネルが 5 つ有効なら許可だけ成立して「このサーバーを有効にしました」と上限の文。既に有効なチャンネルなら「有効にしました」", async (t) => {
  const env = await setup(t);
  for (const channel of ["c1", "c2", "c3", "c4", "c5"]) env.guest.enable(GUILD, channel);
  await env.send(reply(env.issue()));
  assert.deepEqual(env.gateway.sent, [{ channelId: NOTICE_CHANNEL, text: GUEST_ACTIVATED_LIMIT_REPLY, replyToId: "m-reply" }]);
  assert.ok(GUEST_ACTIVATED_LIMIT_REPLY.startsWith("このサーバーを有効にしました。"));
  assert.equal(env.guilds.isAllowed(GUILD), true);
  assert.equal(env.guest.get(NOTICE_CHANNEL), undefined);
  assert.deepEqual(systemTexts(env.admin), ["ゲスト: サーバー g-guest を認証コードで有効にしました（チャンネル 5/5。管理者）"]);

  const enabled = await setup(t);
  enabled.guest.enable(GUILD, NOTICE_CHANNEL);
  enabled.sessions.set(guestSessionKey(NOTICE_CHANNEL), "keep");
  await enabled.send(reply(enabled.issue()));
  assert.deepEqual(enabled.gateway.sent.map((sent) => sent.text), [GUEST_ACTIVATED_REPLY]);
  assert.deepEqual(systemTexts(enabled.admin), ["ゲスト: サーバー g-guest を認証コードで有効にしました（チャンネル 1/5。管理者）"]);
  assert.equal(enabled.sessions.get(guestSessionKey(NOTICE_CHANNEL)), "keep");
});

test("返信の失敗: send が投げても DB は許可済みのままで、#system に「有効化の返信を投稿できませんでした」", async (t) => {
  const env = await setup(t);
  env.gateway.sendError = new Error("Missing Permissions");
  await env.send(reply(env.issue()));
  assert.equal(env.guilds.isAllowed(GUILD), true);
  assert.equal(env.guest.get(NOTICE_CHANNEL)?.disabledAt, null);
  assert.deepEqual(systemTexts(env.admin), [
    "ゲスト: サーバー g-guest を認証コードで有効にしました（チャンネル 1/5。管理者）",
    "ゲスト: サーバー g-guest で有効化の返信を投稿できませんでした（有効化は済んでいます）",
  ]);
  assertNoSecrets(env.logs);
});

test("有効化の後も、定型文への返信（コードでない・メンション付き）はターンに回らない", async (t) => {
  const env = await setup(t);
  await env.send(reply(env.issue()));
  // 定型文への返信（コードでない）は、有効なチャンネルでも会話として扱わない（run が呼ばれれば失敗する）
  await env.send(reply("ありがとう", { mentionsMe: true }));
  assert.equal(env.gateway.sent.length, 1);
});
