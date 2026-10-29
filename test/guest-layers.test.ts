// 既存の層（定期処理・リマインドの発火）は、ゲストのサーバーには触らない（docs/plan/guest-mode.md §3.7・§7）。
// ゲストの層の参加の経路（onGuildJoin）と起動時の sweep の定型文（§3.2.4・§3.2.7）
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createChannelResolver } from "../src/app/access.ts";
import { ReminderScheduler } from "../src/app/reminders.ts";
import { Scheduler } from "../src/app/scheduler.ts";
import { createSystemNotifier } from "../src/app/system-notice.ts";
import { createGuestLayer } from "../src/guest/index.ts";
import { GuestStore } from "../src/store/guest.ts";
import { GuestGuildStore } from "../src/store/guest-guilds.ts";
import { GuestInviteStore } from "../src/store/guest-invites.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { FakeGuestGateway } from "./helpers/guest-gateway.ts";
import { RecordingChannelOps, RecordingQueue } from "./helpers/recording.ts";
import { FakeRunner } from "./helpers/runner.ts";

const NOW = new Date("2026-10-23T00:00:00.000Z");
const OWNER_GUILD = "guild-1";
const GUEST_GUILD = "g-guest";

test("ゲストが有効で、ゲストのサーバーに有効なチャンネル・ターン数があっても、定期処理とリマインドの tick はゲストのサーバーに何も投稿しない", async (t) => {
  const db = tempDb(t);
  const now = () => NOW;
  const stores = createStores(db, now);
  stores.guildSettings.setChannel(OWNER_GUILD, "systemChannelId", "system-1");
  stores.guildSettings.setChannel(OWNER_GUILD, "inboxChannelId", "inbox-1");
  const guest = new GuestStore(db, now);
  guest.enable(GUEST_GUILD, "guest-ch-1");
  guest.recordTurn(GUEST_GUILD, "guest-user-1", "2026-10-23");
  // ゲストのサーバーは DB（guest_guilds）で許可済み
  const guilds = new GuestGuildStore(db);
  guilds.allow(GUEST_GUILD, NOW);
  // ゲストを有効にした設定（Scheduler・ReminderScheduler が読むのは allowedGuildIds などだけ）
  const cfg = {
    allowedGuildIds: [OWNER_GUILD],
    idleHours: 12,
    deleteAfterDays: 30,
    ownerUserId: "owner-1",
    timeZone: "Asia/Tokyo",
    guest: true,
  };
  const gateway = new FakeGateway({
    allow: ["sendMessage", "editMessage", "send", "startTyping", "listChannelParents", "isInGuild"],
    record: ["channelExists"],
  });
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  let pruned = 0;
  const scheduler = new Scheduler({
    cfg,
    ...stores,
    channelOps: new RecordingChannelOps(),
    gateway,
    notify: createSystemNotifier({ guildSettings: stores.guildSettings, gateway, log }),
    inboxRotator: { rotateDue: async () => {} },
    pruneDevLogs: () => {},
    pruneProjectTrash: async () => {},
    pruneWorkDir: async () => {},
    pruneGuestTurns: () => {
      pruned++;
      return guest.pruneTurns("2026-10-15");
    },
    turnQueue: new RecordingQueue(2),
    now,
    log,
  });
  const runner = new FakeRunner([]);
  const reminders = new ReminderScheduler({
    cfg,
    ...stores,
    gateway,
    resolveChannel: createChannelResolver({ inboxChannelId: undefined }, stores.guildSettings, stores.topicSessions),
    turnQueue: new RecordingQueue(2),
    turn: { ...stores, runner, log },
    now,
    log,
  });

  await scheduler.tick();
  await reminders.tick();

  assert.equal(pruned, 1);
  assert.deepEqual(gateway.posts, []);
  assert.deepEqual(gateway.sent, []);
  assert.deepEqual(gateway.edits, []);
  assert.deepEqual(gateway.calls, []);
  assert.ok(!gateway.listed.includes(GUEST_GUILD));
  assert.equal(runner.inputs.length, 0);
  // ゲストの行はそのまま（古い日でないので消えない）
  assert.equal(guest.countActive(GUEST_GUILD), 1);
  assert.equal(guest.countTurns(GUEST_GUILD, "2026-10-23"), 1);
  assert.equal(guilds.isAllowed(GUEST_GUILD), true);
  assert.ok(logs.every((line) => !line.includes(GUEST_GUILD)));
});

const LATER = new Date("2026-10-24T00:00:00.000Z");
const LAYER_CFG = {
  allowedGuildIds: [OWNER_GUILD],
  ownerUserId: "owner-1",
  timeZone: "Asia/Tokyo",
  guestTokenEnv: "SELF_AGENT_GUEST_DISCORD_TOKEN",
  guestTurnsPerDay: 300,
  guestUserTurnsPerDay: 50,
  guestMaxConcurrent: 1,
  guestSessionMaxTurns: 30,
  guestSessionMaxInputTokens: 60000,
};

/** ゲストの層を偽の Gateway で作る（start は呼び出し側） */
function guestLayer(t: TestContext) {
  const db = tempDb(t);
  const now = () => NOW;
  const guest = new GuestStore(db, now);
  const guilds = new GuestGuildStore(db);
  const guildSettings = new GuildSettingsStore(db, now);
  guildSettings.setChannel(OWNER_GUILD, "systemChannelId", "system-1");
  const admin = new FakeGateway({ allow: ["sendMessage"] });
  const gateway = new FakeGuestGateway();
  const logs: string[] = [];
  let onGuildJoin: ((guildId: string) => void) | undefined;
  let stopping = false;
  /** /guest を登録した時点の定型文の記録（参加の経路は投稿の後に登録する） */
  const noticeAtRegister: Array<string | null | undefined> = [];
  const register = gateway.registerGuildCommands.bind(gateway);
  gateway.registerGuildCommands = async (guildId, defs) => {
    noticeAtRegister.push(guilds.get(guildId)?.noticeMessageId);
    await register(guildId, defs);
  };
  const layer = createGuestLayer({
    cfg: LAYER_CFG,
    guest,
    guilds,
    invites: new GuestInviteStore(db, { guilds, channels: guest }),
    sessions: new SdkSessionStore(db, now),
    runner: new FakeRunner([]),
    usage: new UsageStore(db, now),
    notify: createSystemNotifier({ guildSettings, gateway: admin, log: (line) => logs.push(line) }),
    now,
    log: (line) => logs.push(line),
    createGateway: (_leave, join) => {
      onGuildJoin = join;
      return gateway;
    },
  });
  return {
    guest,
    guilds,
    admin,
    gateway,
    logs,
    layer,
    noticeAtRegister,
    start: () => layer.start(() => stopping),
    join: async (guildId: string) => {
      onGuildJoin?.(guildId);
      await layer.idle();
    },
    setStopping: () => {
      stopping = true;
    },
  };
}

function systemTexts(admin: FakeGateway): string[] {
  return admin.posts.map((post) => post.message.text);
}

function assertNoChannelIds(logs: readonly string[]): void {
  for (const line of logs) {
    for (const secret of ["c-a", "c-b", "c-old", "m-notice", "m-old", "system-1", "owner-1"]) {
      assert.ok(!line.includes(secret), `${secret} が log に出ています: ${line}`);
    }
  }
}

test("onGuildJoin: 新しく入ったサーバーに定型文を 1 通投稿して記録し、その後に /guest を 1 回登録して #system。もう一度鳴っても投稿しない", async (t) => {
  const env = guestLayer(t);
  await env.start();
  env.gateway.joined.add("g-new");
  env.gateway.noticeChannels.set("g-new", ["c-a", "c-b"]);
  await env.join("g-new");

  assert.deepEqual(env.gateway.calls, ["findNoticeChannels:g-new", "sendMessage:c-a"]);
  assert.deepEqual(env.gateway.posts.map((post) => post.channelId), ["c-a"]);
  assert.ok(env.gateway.posts[0]!.message.text.includes("しのえもん"));
  const row = env.guilds.get("g-new")!;
  assert.deepEqual([row.noticeChannelId, row.noticeMessageId], ["c-a", "m-notice-1"]);
  assert.equal(row.allowedAt, null);
  assert.deepEqual(env.gateway.registered.map((entry) => [entry.guildId, entry.defs.map((def) => def.name)]), [["g-new", ["guest"]]]);
  // 登録は投稿の後
  assert.deepEqual(env.noticeAtRegister, ["m-notice-1"]);
  assert.deepEqual(systemTexts(env.admin), ["ゲスト: サーバー g-new に参加し、案内を投稿しました"]);

  // 再接続などでもう一度鳴っても投稿しない（登録はもう一度行う）
  await env.join("g-new");
  assert.equal(env.gateway.posts.length, 1);
  assert.equal(env.admin.posts.length, 1);
  assertNoChannelIds(env.logs);
});

test("onGuildJoin: 投稿できなくても /guest は登録し、#system に理由。メインのサーバー・停止を始めた後は何もしない", async (t) => {
  const env = guestLayer(t);
  await env.start();
  await env.join("g-empty");
  assert.deepEqual(env.gateway.registered.map((entry) => entry.guildId), ["g-empty"]);
  assert.equal(env.guilds.get("g-empty")?.noticeMessageId, null);
  assert.deepEqual(systemTexts(env.admin), ["ゲスト: サーバー g-empty に参加しましたが、案内を投稿できませんでした（投稿できるチャンネルがありません）"]);

  await env.join(OWNER_GUILD);
  env.setStopping();
  await env.join("g-late");
  assert.equal(env.guilds.get(OWNER_GUILD), undefined);
  assert.equal(env.guilds.get("g-late"), undefined);
  assert.deepEqual(env.gateway.registered.map((entry) => entry.guildId), ["g-empty"]);
  assert.ok(env.logs.includes(`guest: メインのサーバーに参加しています（guild=${OWNER_GUILD}）`));
});

test("起動時の sweep: 参加している全サーバー（メインを除く）に onboardGuild。行が無い・未投稿・外されて戻ったサーバーだけ投稿し、案内済みは投稿しない。/guest は全部に登録", async (t) => {
  const env = guestLayer(t);
  // 案内済み（許可済み）
  env.guilds.allow("g-done", NOW);
  env.guilds.setNotice("g-done", "c-old", "m-old", NOW);
  // 外されて戻った（許可は取り消しのまま。notice_* は外されたときに消えている）
  env.guilds.allow("g-back", NOW);
  env.guilds.revoke("g-back", "left", NOW);
  // 前の参加で投稿できなかった（joined_at は変えない）
  env.guilds.upsertJoined("g-failed", LATER);
  for (const guildId of ["g-done", "g-back", "g-failed", "g-new", OWNER_GUILD]) {
    env.gateway.joined.add(guildId);
    env.gateway.noticeChannels.set(guildId, [`c-a-${guildId}`]);
  }
  await env.start();

  assert.deepEqual(env.gateway.posts.map((post) => post.channelId), ["c-a-g-back", "c-a-g-failed", "c-a-g-new"]);
  assert.equal(env.guilds.get("g-done")?.noticeMessageId, "m-old");
  assert.equal(env.guilds.get("g-back")?.noticeChannelId, "c-a-g-back");
  assert.equal(env.guilds.isAllowed("g-back"), false);
  assert.equal(env.guilds.get("g-back")?.revokedReason, "left");
  assert.equal(env.guilds.get("g-failed")?.joinedAt, LATER.toISOString());
  assert.equal(env.guilds.get("g-new")?.joinedAt, NOW.toISOString());
  assert.equal(env.guilds.isAllowed("g-new"), false);
  assert.equal(env.guilds.get(OWNER_GUILD), undefined);
  assert.deepEqual(
    env.gateway.registered.map((entry) => entry.guildId),
    ["g-done", "g-back", "g-failed", "g-new"],
  );
  // sweep の登録は投稿の後（全サーバーの案内を済ませてから）
  assert.deepEqual(env.noticeAtRegister, ["m-old", "m-notice-1", "m-notice-2", "m-notice-3"]);
  assert.deepEqual(systemTexts(env.admin), [
    "ゲスト: サーバー g-back に参加し、案内を投稿しました",
    "ゲスト: サーバー g-failed に参加し、案内を投稿しました",
    "ゲスト: サーバー g-new に参加し、案内を投稿しました",
  ]);
  assert.ok(env.logs.includes(`guest: メインのサーバーに参加しています（guild=${OWNER_GUILD}）`));
  assertNoChannelIds(env.logs);
});

test("起動時の sweep: 1 つのサーバーで案内の確かめが投げても、残りのサーバーの投稿と /guest の登録は続ける", async (t) => {
  const env = guestLayer(t);
  for (const guildId of ["g-a", "g-b"]) {
    env.gateway.joined.add(guildId);
    env.gateway.noticeChannels.set(guildId, [`c-a-${guildId}`]);
  }
  const find = env.gateway.findNoticeChannels.bind(env.gateway);
  env.gateway.findNoticeChannels = async (guildId) => {
    if (guildId === "g-a") throw new Error("Missing Access");
    return find(guildId);
  };
  await env.start();
  assert.deepEqual(env.gateway.posts.map((post) => post.channelId), ["c-a-g-b"]);
  assert.deepEqual(env.gateway.registered.map((entry) => entry.guildId), ["g-a", "g-b"]);
  assert.ok(env.logs.some((line) => line.startsWith("guest: 参加の記録・案内の投稿に失敗しました（guild=g-a）")));
});
