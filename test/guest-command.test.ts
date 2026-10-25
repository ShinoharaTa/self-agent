import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { INTERACTION_FAILURE_REPLY } from "../src/app/interactions.ts";
import { RESTARTING_REPLY } from "../src/app/shutdown.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import {
  createGuestCommand,
  GUEST_ALREADY_ENABLED_REPLY,
  GUEST_LIMIT_REPLY,
  GUEST_NEED_MANAGE_REPLY,
  GUEST_NO_CHANNEL_REPLY,
  GUEST_NOT_ALLOWED_REPLY,
  GUEST_NOT_ENABLED_REPLY,
  GUEST_OFF_REPLY,
  GUEST_ON_REPLY,
} from "../src/guest/commands/guest.ts";
import { createGuestLayer } from "../src/guest/index.ts";
import { createGuestInteractionHandler } from "../src/guest/interactions.ts";
import { createGuestNotifier } from "../src/guest/notify.ts";
import { GuestStore } from "../src/store/guest.ts";
import { GuestGuildStore } from "../src/store/guest-guilds.ts";
import { GuestInviteStore } from "../src/store/guest-invites.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";
import { tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { FakeGuestGateway } from "./helpers/guest-gateway.ts";
import { FakeResponder } from "./helpers/responder.ts";
import { FakeRunner } from "./helpers/runner.ts";

const OWNER = "owner-1";
const OWNER_GUILD = "g-owner";
const GUEST_GUILD = "g-guest";
/** 2026-10-23 09:00 JST */
const NOW = new Date("2026-10-23T00:00:00.000Z");

const CFG = {
  allowedGuildIds: [OWNER_GUILD],
  ownerUserId: OWNER,
  timeZone: "Asia/Tokyo",
  guestTokenEnv: "SELF_AGENT_GUEST_DISCORD_TOKEN",
  guestTurnsPerDay: 300,
  guestUserTurnsPerDay: 50,
  guestMaxConcurrent: 1,
  guestSessionMaxTurns: 30,
  guestSessionMaxInputTokens: 60000,
};

function setup(t: TestContext, cfg: Omit<typeof CFG, "ownerUserId"> & { ownerUserId: string | undefined } = CFG) {
  const db = tempDb(t);
  const now = () => NOW;
  const guest = new GuestStore(db, now);
  // ゲストのサーバーは許可済み（認証コードで許可した後）
  const guilds = new GuestGuildStore(db);
  guilds.allow(GUEST_GUILD, NOW);
  // 定型文は投稿済み（起動時の sweep は投稿しない。投稿の経路は guest-layers.test.ts・guest-notice.test.ts）
  guilds.setNotice(GUEST_GUILD, "c-notice-0", "m-notice-0", NOW);
  const sessions = new SdkSessionStore(db, now);
  const guildSettings = new GuildSettingsStore(db, now);
  guildSettings.setChannel(OWNER_GUILD, "systemChannelId", "system-1");
  const admin = new FakeGateway({ allow: ["sendMessage"] });
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  const notify = createGuestNotifier({ cfg, guildSettings, gateway: admin, log });
  const command = createGuestCommand({ cfg, guest, guilds, sessions, notify, now, log });
  const handle = createGuestInteractionHandler({ guilds, command, log });
  const run = async (interaction: Interaction): Promise<FakeResponder> => {
    const responder = new FakeResponder();
    await handle(interaction, responder);
    return responder;
  };
  const usage = new UsageStore(db, now);
  const invites = new GuestInviteStore(db, { guilds, channels: guest });
  return { db, guest, guilds, invites, sessions, usage, guildSettings, admin, logs, run, handle };
}

function guestCommand(subcommand: string, overrides: Partial<Interaction> = {}): Interaction {
  return {
    kind: "command",
    name: "guest",
    subcommand,
    options: {},
    guildId: GUEST_GUILD,
    channelId: "c1",
    userId: OWNER,
    createdAt: NOW,
    ...overrides,
  } as Interaction;
}

/** ログに ID・本文が出ていない（サーバー ID は出してよい） */
function assertNoIds(logs: readonly string[]): void {
  for (const line of logs) {
    for (const secret of ["c1", "c2", "c6", OWNER, "user-2", "system-1"]) {
      assert.ok(!line.includes(secret), `${secret} が log に出ています: ${line}`);
    }
  }
}

test("/guest: 許可済みのサーバーで、オーナーでも Manage Server の権限も無い人には本人にだけ「サーバーの管理権限（サーバー管理）が必要です」で、何も変えない", async (t) => {
  const { guest, admin, run } = setup(t);
  for (const subcommand of ["on", "off", "status"]) {
    for (const overrides of [{ userId: "user-2" }, { userId: "user-2", memberCanManageGuild: false }]) {
      const responder = await run(guestCommand(subcommand, overrides));
      assert.deepEqual(responder.calls, [{ method: "reply", message: { text: GUEST_NEED_MANAGE_REPLY, ephemeral: true } }]);
    }
  }
  assert.equal(GUEST_NEED_MANAGE_REPLY, "サーバーの管理権限（サーバー管理）が必要です");
  assert.equal(guest.get("c1"), undefined);
  assert.deepEqual(admin.posts, []);
});

test("/guest: 許可していない（行はあるが未許可・取り消し済み）サーバーでは、オーナーにも管理者にも本人にだけ「まだ有効になっていません」", async (t) => {
  const { guest, guilds, admin, run } = setup(t);
  // 起動時の sweep が作った行（参加の記録だけ）
  guilds.upsertJoined("g-joined", NOW);
  guilds.allow("g-revoked", NOW);
  guilds.revoke("g-revoked", "revoke", NOW);
  for (const guildId of ["g-joined", "g-revoked"]) {
    for (const overrides of [{}, { userId: "user-2", memberCanManageGuild: true }]) {
      const responder = await run(guestCommand("on", { guildId, ...overrides }));
      assert.deepEqual(responder.calls, [{ method: "reply", message: { text: GUEST_NOT_ALLOWED_REPLY, ephemeral: true } }]);
    }
  }
  assert.equal(GUEST_NOT_ALLOWED_REPLY, "このサーバーはまだ有効になっていません");
  assert.equal(guest.get("c1"), undefined);
  assert.deepEqual(admin.posts, []);
});

test("/guest: Manage Server の権限を持つメンバー（memberCanManageGuild: true）はオーナーと同じ結果で、#system の知らせに「（管理者）」が付く", async (t) => {
  const { guest, admin, logs, run } = setup(t);
  const asAdmin = { userId: "user-2", memberCanManageGuild: true };
  const on = await run(guestCommand("on", asAdmin));
  assert.deepEqual(on.calls, [{ method: "reply", message: { text: GUEST_ON_REPLY } }]);
  assert.equal(guest.get("c1")?.disabledAt, null);
  const status = await run(guestCommand("status", asAdmin));
  assert.deepEqual(status.calls, [
    { method: "reply", message: { text: "有効なチャンネル（1/5）:\n<#c1>\n今日の残り回数: 300/300", ephemeral: true } },
  ]);
  const off = await run(guestCommand("off", asAdmin));
  assert.deepEqual(off.calls, [{ method: "reply", message: { text: GUEST_OFF_REPLY } }]);
  // オーナー（権限なし）は「（管理者）」なし
  await run(guestCommand("on", { memberCanManageGuild: false }));
  assert.deepEqual(admin.posts.map((post) => post.message.text), [
    "ゲスト: サーバー g-guest でチャンネルを有効化しました（1/5）（管理者）",
    "ゲスト: サーバー g-guest でチャンネルを無効化しました（0/5）（管理者）",
    "ゲスト: サーバー g-guest でチャンネルを有効化しました（1/5）",
  ]);
  assertNoIds(logs);
});

test("/guest: SELF_AGENT_OWNER_ID が無ければ、権限の無い人は誰も通らない（権限のある人は通る）", async (t) => {
  const { guest, run } = setup(t, { ...CFG, ownerUserId: undefined });
  const owner = await run(guestCommand("on"));
  assert.deepEqual(owner.calls, [{ method: "reply", message: { text: GUEST_NEED_MANAGE_REPLY, ephemeral: true } }]);
  assert.equal(guest.get("c1"), undefined);
  const admin = await run(guestCommand("on", { memberCanManageGuild: true }));
  assert.deepEqual(admin.calls, [{ method: "reply", message: { text: GUEST_ON_REPLY } }]);
});

test("/guest: ゲストのサーバーでない（guest_guilds に行の無いサーバー・DM）なら応答せず、サーバー ID だけを log に 1 行", async (t) => {
  const { guest, logs, run } = setup(t);
  for (const guildId of [OWNER_GUILD, "g-unknown", null]) {
    const responder = await run(guestCommand("on", { guildId, memberCanManageGuild: true }));
    assert.deepEqual(responder.calls, []);
  }
  assert.equal(guest.get("c1"), undefined);
  assert.equal(logs.length, 3);
  assert.match(logs[0]!, /guild=g-owner/);
  assert.match(logs[1]!, /guild=g-unknown/);
  assertNoIds(logs);
});

test("/guest: ボタン・ほかのコマンドは応答しない", async (t) => {
  const { run } = setup(t);
  const button = await run({
    kind: "button",
    customId: "close:start:c1",
    guildId: GUEST_GUILD,
    channelId: "c1",
    userId: OWNER,
    createdAt: NOW,
  });
  assert.deepEqual(button.calls, []);
  const other = await run(guestCommand("on", { name: "setup" } as Partial<Interaction>));
  assert.deepEqual(other.calls, []);
});

test("/guest on: 公開で AI の明示付きの知らせを返し、#system に知らせ、SDK セッションを捨てる。既に有効・上限は本人にだけ", async (t) => {
  const { guest, sessions, admin, logs, run } = setup(t);
  sessions.set("guest:c1", "old-session");
  const on = await run(guestCommand("on"));
  assert.deepEqual(on.calls, [{ method: "reply", message: { text: GUEST_ON_REPLY } }]);
  assert.match(GUEST_ON_REPLY, /しのえもん/);
  assert.match(GUEST_ON_REPLY, /この Bot は AI です/);
  assert.equal(guest.get("c1")?.disabledAt, null);
  assert.equal(sessions.get("guest:c1"), undefined);
  assert.deepEqual(
    admin.posts.map((post) => [post.channelId, post.message.text]),
    [["system-1", "ゲスト: サーバー g-guest でチャンネルを有効化しました（1/5）"]],
  );

  const again = await run(guestCommand("on"));
  assert.deepEqual(again.calls, [{ method: "reply", message: { text: GUEST_ALREADY_ENABLED_REPLY, ephemeral: true } }]);

  for (const channelId of ["c2", "c3", "c4", "c5"]) await run(guestCommand("on", { channelId }));
  assert.equal(guest.countActive(GUEST_GUILD), 5);
  const sixth = await run(guestCommand("on", { channelId: "c6" }));
  assert.deepEqual(sixth.calls, [{ method: "reply", message: { text: GUEST_LIMIT_REPLY, ephemeral: true } }]);
  assert.equal(GUEST_LIMIT_REPLY, "このサーバーで有効にできるチャンネルは 5 つまでです");
  assert.equal(guest.get("c6"), undefined);
  assert.equal(admin.posts.length, 5);
  assertNoIds(logs);
});

test("/guest off: 公開で返し #system に知らせる。有効でなければ本人にだけ。on → off → on で SDK セッションが捨てられる", async (t) => {
  const { guest, sessions, admin, logs, run } = setup(t);
  const notEnabled = await run(guestCommand("off"));
  assert.deepEqual(notEnabled.calls, [{ method: "reply", message: { text: GUEST_NOT_ENABLED_REPLY, ephemeral: true } }]);

  await run(guestCommand("on"));
  await run(guestCommand("on", { channelId: "c2" }));
  sessions.set("guest:c1", "session-1");
  const off = await run(guestCommand("off"));
  assert.deepEqual(off.calls, [{ method: "reply", message: { text: GUEST_OFF_REPLY } }]);
  assert.equal(guest.get("c1")?.disabledReason, "command");
  assert.equal(admin.posts.at(-1)?.message.text, "ゲスト: サーバー g-guest でチャンネルを無効化しました（1/5）");

  const offAgain = await run(guestCommand("off"));
  assert.deepEqual(offAgain.calls, [{ method: "reply", message: { text: GUEST_NOT_ENABLED_REPLY, ephemeral: true } }]);

  await run(guestCommand("on"));
  assert.equal(guest.get("c1")?.disabledAt, null);
  assert.equal(sessions.get("guest:c1"), undefined);
  assertNoIds(logs);
});

test("/guest status: 有効なチャンネルと今日（SELF_AGENT_TZ）のサーバーの残り回数を本人にだけ", async (t) => {
  const { guest, run } = setup(t);
  const empty = await run(guestCommand("status"));
  assert.deepEqual(empty.calls, [
    { method: "reply", message: { text: "有効なチャンネルはありません\n今日の残り回数: 300/300", ephemeral: true } },
  ]);

  await run(guestCommand("on"));
  await run(guestCommand("on", { channelId: "c2" }));
  // 今日（JST の 2026-10-23）の分だけ数える
  guest.recordTurn(GUEST_GUILD, "user-2", "2026-10-23");
  guest.recordTurn(GUEST_GUILD, "user-3", "2026-10-23");
  guest.recordTurn(GUEST_GUILD, "user-2", "2026-10-22");
  guest.recordTurn("g-other", "user-2", "2026-10-23");
  const status = await run(guestCommand("status"));
  assert.deepEqual(status.calls, [
    {
      method: "reply",
      message: { text: "有効なチャンネル（2/5）:\n<#c1>\n<#c2>\n今日の残り回数: 298/300", ephemeral: true },
    },
  ]);
});

test("/guest: #system への知らせに失敗しても応答は変わらず、log だけ。処理の失敗は本人にだけ「処理に失敗しました」", async (t) => {
  const { guest, admin, logs, run } = setup(t);
  admin.beforeSendMessage = () => {
    throw new Error("Missing Access");
  };
  const on = await run(guestCommand("on"));
  assert.deepEqual(on.calls, [{ method: "reply", message: { text: GUEST_ON_REPLY } }]);
  assert.ok(logs.some((line) => line.includes("#system への知らせの投稿に失敗しました（guild=g-owner）")));

  const unknown = await run(guestCommand("other"));
  assert.deepEqual(unknown.calls, [{ method: "reply", message: { text: INTERACTION_FAILURE_REPLY, ephemeral: true } }]);
  assert.equal(guest.countActive(GUEST_GUILD), 1);
  assertNoIds(logs);
});

test("/guest: チャンネルの無い操作には本人にだけ「チャンネルで実行してください」で、何も変えない", async (t) => {
  const { guest, admin, run } = setup(t);
  const responder = await run(guestCommand("on", { channelId: null }));
  assert.deepEqual(responder.calls, [{ method: "reply", message: { text: GUEST_NO_CHANNEL_REPLY, ephemeral: true } }]);
  assert.equal(guest.countActive(GUEST_GUILD), 0);
  assert.deepEqual(admin.posts, []);
});

test("/guest on・off: 応答が投げても、DB の変更と SDK セッションの破棄は残り、#system の知らせは出る", async (t) => {
  const { guest, sessions, admin, logs, handle } = setup(t);
  const failing = (): FakeResponder => {
    const responder = new FakeResponder();
    responder.beforeReply = () => {
      throw new Error("Unknown interaction");
    };
    return responder;
  };

  sessions.set("guest:c1", "old-session");
  await handle(guestCommand("on"), failing());
  assert.equal(guest.get("c1")?.disabledAt, null);
  assert.equal(sessions.get("guest:c1"), undefined);
  assert.deepEqual(admin.posts.map((post) => post.message.text), ["ゲスト: サーバー g-guest でチャンネルを有効化しました（1/5）"]);

  await handle(guestCommand("off"), failing());
  assert.equal(guest.get("c1")?.disabledReason, "command");
  assert.deepEqual(admin.posts.map((post) => post.message.text), [
    "ゲスト: サーバー g-guest でチャンネルを有効化しました（1/5）",
    "ゲスト: サーバー g-guest でチャンネルを無効化しました（0/5）",
  ]);
  assert.ok(logs.some((line) => line.includes("/guest の処理中にエラーが発生しました")));
  assertNoIds(logs);
});

test("createGuestNotifier: #system への投稿が 10 秒で終わらなければ打ち切って log だけ（reject しない）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const db = tempDb(t);
  const guildSettings = new GuildSettingsStore(db, () => NOW);
  guildSettings.setChannel(OWNER_GUILD, "systemChannelId", "system-1");
  const admin = new FakeGateway({ allow: ["sendMessage"] });
  admin.beforeSendMessage = () => new Promise<void>(() => {});
  const logs: string[] = [];
  const notify = createGuestNotifier({ cfg: CFG, guildSettings, gateway: admin, log: (message) => logs.push(message) });
  let done = false;
  const pending = notify("ゲスト: テスト").then(() => {
    done = true;
  });
  t.mock.timers.tick(9_999);
  await Promise.resolve();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(done, true);
  assert.deepEqual(logs, ["guest: #system への知らせの投稿に失敗しました（guild=g-owner）: 10000 ms で終わりませんでした"]);
});

function startWith(t: TestContext, loginTimeoutMs?: number) {
  const { db, guest, guilds, invites, sessions, usage, guildSettings, admin, logs } = setup(t);
  const gateway = new FakeGuestGateway();
  // 受付判定を通らない発言では run を呼ばない（呼べば「想定外の呼び出し」で失敗する）
  const runner = new FakeRunner([]);
  let onGuildLeave: ((guildId: string) => void) | undefined;
  let onGuildJoin: ((guildId: string) => void) | undefined;
  let stopping = false;
  const layer = (start: (fake: FakeGuestGateway) => void = () => {}) => {
    start(gateway);
    const created = createGuestLayer({
      cfg: CFG,
      guest,
      guilds,
      invites,
      sessions,
      runner,
      usage,
      guildSettings,
      adminGateway: admin,
      now: () => NOW,
      log: (message) => logs.push(message),
      ...(loginTimeoutMs === undefined ? {} : { loginTimeoutMs }),
      createGateway: (leave, join) => {
        onGuildLeave = leave;
        onGuildJoin = join;
        return gateway;
      },
    });
    return { ...created, ready: created.start(() => stopping) };
  };
  return {
    db,
    guest,
    guilds,
    invites,
    admin,
    logs,
    gateway,
    layer,
    leave: (guildId: string) => onGuildLeave?.(guildId),
    join: (guildId: string) => onGuildJoin?.(guildId),
    setStopping: () => {
      stopping = true;
    },
  };
}

test("createGuestLayer: 起動時に参加していない許可済みのサーバーは取り消し・チャンネルを startup で無効・案内の記録を消して #system。未許可の行は案内の記録を消すだけ", async (t) => {
  const { guest, guilds, admin, logs, gateway, layer } = startWith(t);
  guilds.allow("g-left", NOW);
  guilds.setNotice("g-left", "c-notice", "m-notice", NOW);
  guest.enable("g-left", "c-left");
  guilds.upsertJoined("g-unallowed", NOW);
  guilds.setNotice("g-unallowed", "c-notice-2", "m-notice-2", NOW);
  guest.enable(GUEST_GUILD, "c1");
  const started = layer((fake) => fake.joined.add(GUEST_GUILD));
  await started.ready;

  assert.deepEqual(gateway.registered.map((entry) => entry.guildId), [GUEST_GUILD]);
  const left = guilds.get("g-left")!;
  assert.equal(left.revokedReason, "left");
  assert.equal(left.revokedAt, NOW.toISOString());
  assert.equal(left.allowedAt, NOW.toISOString());
  assert.deepEqual([left.noticeChannelId, left.noticeMessageId, left.noticePostedAt], [null, null, null]);
  assert.equal(guilds.isAllowed("g-left"), false);
  assert.equal(guest.get("c-left")?.disabledReason, "startup");
  assert.equal(guest.get("c1")?.disabledAt, null);
  const unallowed = guilds.get("g-unallowed")!;
  assert.equal(unallowed.revokedAt, null);
  assert.equal(unallowed.revokedReason, null);
  assert.deepEqual([unallowed.noticeChannelId, unallowed.noticeMessageId, unallowed.noticePostedAt], [null, null, null]);
  assert.deepEqual(admin.posts.map((post) => post.message.text), [
    "ゲスト: サーバー g-left に参加していないため、許可を取り消しました（有効なチャンネル 1 件を無効にしました）",
  ]);
  assert.deepEqual(gateway.calls, []);
  assertNoIds(logs);
  assert.ok(logs.every((line) => !line.includes("c-left") && !line.includes("c-notice") && !line.includes("m-notice")));
});

test("createGuestLayer: 受付判定を通らない発言（メンションでも返信でもない）は黙って捨てる（run も返信も log も無い）", async (t) => {
  const { guest, admin, logs, gateway, layer } = startWith(t);
  guest.enable(GUEST_GUILD, "c1");
  const started = layer((fake) => fake.joined.add(GUEST_GUILD));
  await started.ready;
  const before = logs.length;
  gateway.handlers!.onMessage({
    id: "m1",
    channelId: "c1",
    guildId: GUEST_GUILD,
    authorId: "user-2",
    authorIsBot: false,
    isWebhook: false,
    content: "こんにちは",
    createdAt: NOW,
    persona: "guest",
    mentionsMe: false,
  });
  await started.idle();
  assert.equal(logs.length, before);
  assert.deepEqual(admin.posts, []);
  assert.deepEqual(gateway.sent, []);
});

test("createGuestLayer: 許可済みのサーバーから外されたら、取り消し・有効なチャンネルを left で無効・案内の記録を消して #system に知らせる", async (t) => {
  const { guest, guilds, admin, logs, layer, leave } = startWith(t);
  guilds.setNotice(GUEST_GUILD, "c-notice", "m-notice", NOW);
  guest.enable(GUEST_GUILD, "c1");
  guest.enable(GUEST_GUILD, "c2");
  const started = layer((fake) => fake.joined.add(GUEST_GUILD));
  await started.ready;

  leave(GUEST_GUILD);
  await started.idle();
  assert.equal(guest.get("c1")?.disabledReason, "left");
  assert.equal(guest.get("c2")?.disabledReason, "left");
  assert.equal(guest.countActive(GUEST_GUILD), 0);
  const row = guilds.get(GUEST_GUILD)!;
  assert.equal(row.revokedReason, "left");
  assert.equal(guilds.isAllowed(GUEST_GUILD), false);
  assert.deepEqual([row.noticeChannelId, row.noticeMessageId, row.noticePostedAt], [null, null, null]);
  assert.deepEqual(admin.posts.map((post) => post.message.text), [
    "ゲスト: サーバー g-guest から外されたため、許可を取り消しました（有効なチャンネル 2 件を無効にしました）",
  ]);
  assertNoIds(logs);
});

test("createGuestLayer: 未許可のサーバーから外されたら案内の記録を消すだけ（取り消しの列・#system なし）。行の無いサーバーは log だけで何も変えない", async (t) => {
  const { guilds, admin, logs, layer, leave } = startWith(t);
  guilds.upsertJoined("g-unallowed", NOW);
  guilds.setNotice("g-unallowed", "c-notice", "m-notice", NOW);
  const started = layer((fake) => {
    fake.joined.add(GUEST_GUILD);
    fake.joined.add("g-unallowed");
  });
  await started.ready;

  leave("g-unallowed");
  leave("g-unknown");
  await started.idle();
  const row = guilds.get("g-unallowed")!;
  assert.equal(row.revokedAt, null);
  assert.equal(row.revokedReason, null);
  assert.equal(row.joinedAt, NOW.toISOString());
  assert.deepEqual([row.noticeChannelId, row.noticeMessageId, row.noticePostedAt], [null, null, null]);
  assert.equal(guilds.get("g-unknown"), undefined);
  assert.equal(guilds.isAllowed(GUEST_GUILD), true);
  assert.deepEqual(admin.posts, []);
  assert.ok(logs.some((line) => line.includes("guild=g-unallowed")));
  assert.ok(logs.some((line) => line.includes("guild=g-unknown")));
  assertNoIds(logs);
});

test("createGuestLayer: /guest はゲストの Gateway から受けて処理し、停止を始めた後はゲストのサーバー（行のあるサーバー）にだけ「再起動中です」", async (t) => {
  const { guest, gateway, layer, setStopping } = startWith(t);
  const started = layer((fake) => fake.joined.add(GUEST_GUILD));
  await started.ready;

  const on = new FakeResponder();
  gateway.handlers!.onInteraction(guestCommand("on"), on);
  await started.idle();
  assert.deepEqual(on.calls, [{ method: "reply", message: { text: GUEST_ON_REPLY } }]);
  assert.equal(guest.countActive(GUEST_GUILD), 1);

  setStopping();
  const off = new FakeResponder();
  gateway.handlers!.onInteraction(guestCommand("off"), off);
  const outside = new FakeResponder();
  gateway.handlers!.onInteraction(guestCommand("off", { guildId: "g-unknown" }), outside);
  await started.idle();
  assert.deepEqual(off.calls, [{ method: "reply", message: { text: RESTARTING_REPLY, ephemeral: true } }]);
  assert.deepEqual(outside.calls, []);
  assert.equal(guest.countActive(GUEST_GUILD), 1);

  await started.stop();
  assert.equal(gateway.stopped, 1);
});

test("createGuestLayer: start する前の stop は Gateway に触らない。start は 2 回目以降も同じ Promise を返し、ログインは 1 回。admin は /guests の操作を持つ", async (t) => {
  const { guest, guilds, invites, sessions, usage, guildSettings, admin, logs } = setup(t);
  const gateway = new FakeGuestGateway();
  let logins = 0;
  const originalStart = gateway.start.bind(gateway);
  gateway.start = async (handlers) => {
    logins++;
    await originalStart(handlers);
  };
  const layer = createGuestLayer({
    cfg: CFG,
    guest,
    guilds,
    invites,
    sessions,
    runner: new FakeRunner([]),
    usage,
    guildSettings,
    adminGateway: admin,
    now: () => NOW,
    log: (message) => logs.push(message),
    createGateway: () => gateway,
  });
  assert.equal(layer.admin.invites, invites);
  assert.equal(layer.admin.guilds, guilds);
  assert.equal(layer.admin.gateway, gateway);
  assert.equal(typeof layer.admin.onboardGuild, "function");
  await layer.stop();
  assert.equal(gateway.stopped, 0);
  const first = layer.start(() => false);
  assert.equal(layer.start(() => false), first);
  await first;
  assert.equal(logins, 1);
  await layer.stop();
  assert.equal(gateway.stopped, 1);
});

test("createGuestLayer: ログインに失敗しても reject せず log だけで、コマンドの登録も行の取り消しもしない", async (t) => {
  const { guest, guilds, logs, gateway, layer } = startWith(t);
  guest.enable(GUEST_GUILD, "c1");
  const started = layer((fake) => {
    fake.startError = new Error("An invalid token was provided.");
  });
  await started.ready;
  assert.ok(logs.some((line) => line.startsWith("guest: ゲスト Bot に接続できませんでした")));
  assert.ok(!logs.some((line) => line.includes("時間切れ")));
  assert.deepEqual(gateway.registered, []);
  assert.equal(guest.get("c1")?.disabledAt, null);
  assert.equal(guilds.isAllowed(GUEST_GUILD), true);
});

test("createGuestLayer: ログインが時間切れなら reject せず、参加の確かめと /guest の登録を行っていない旨を log に出す", async (t) => {
  const { guest, guilds, logs, gateway, layer } = startWith(t, 10);
  guest.enable(GUEST_GUILD, "c1");
  const started = layer((fake) => {
    fake.hang = true;
  });
  await started.ready;
  assert.ok(logs.some((line) => line.startsWith("guest: ゲスト Bot に接続できませんでした")));
  assert.ok(logs.includes("guest: ログインが時間切れになったため、参加の確かめと /guest の登録を行っていません"));
  assert.deepEqual(gateway.registered, []);
  assert.equal(guest.get("c1")?.disabledAt, null);
  assert.equal(guilds.isAllowed(GUEST_GUILD), true);
});
