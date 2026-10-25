// 定型文（案内。docs/plan/guest-mode.md §3.2.4・§6・§7）の本文・投稿・/guests invite の再投稿の条件
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Interaction } from "../src/discord/gateway.ts";
import { createGuestsCommand, GUESTS_NOT_JOINED_NOTE, type GuestAdmin } from "../src/guest/commands/admin.ts";
import { buildGuestNoticeText, createGuestOnboarding } from "../src/guest/notice.ts";
import { createGuestNotifier } from "../src/guest/notify.ts";
import { GuestStore } from "../src/store/guest.ts";
import { GuestGuildStore } from "../src/store/guest-guilds.ts";
import { GuestInviteStore } from "../src/store/guest-invites.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { FakeGuestGateway } from "./helpers/guest-gateway.ts";
import { FakeResponder } from "./helpers/responder.ts";

const OWNER_GUILD = "g-owner";
/** メインのサーバーでないゲストのサーバー（/guests invite の server_id は数字） */
const GUILD = "123456789012345678";
const NOW = new Date("2026-10-25T00:00:00.000Z");

const CFG = { allowedGuildIds: [OWNER_GUILD], ownerUserId: "owner-1", timeZone: "Asia/Tokyo", guestTurnsPerDay: 300, guestUserTurnsPerDay: 50 };

test("buildGuestNoticeText: 呼び名・AI・記録・返信・サーバー管理を含み、@everyone・@here・ロールのメンションが無く、2,000 字以内。上限の数字は cfg から", () => {
  const text = buildGuestNoticeText(CFG);
  for (const word of ["しのえもん", "AI", "記録", "返信", "サーバー管理", "/guest on", "/guest status"]) assert.ok(text.includes(word), word);
  assert.ok(!text.includes("@everyone"));
  assert.ok(!text.includes("@here"));
  assert.ok(!/<@&?\d/.test(text));
  assert.ok(text.length <= 2000);
  assert.ok(text.includes("サーバー全体で 1 日 300 回、1 人 1 日 50 回まで。1 回 2,000 字まで"));
  const custom = buildGuestNoticeText({ guestTurnsPerDay: 1200, guestUserTurnsPerDay: 7 });
  assert.ok(custom.includes("サーバー全体で 1 日 1,200 回、1 人 1 日 7 回まで"));
});

function setup(t: TestContext) {
  const db = tempDb(t);
  const now = () => NOW;
  const guilds = new GuestGuildStore(db);
  const guest = new GuestStore(db, now);
  const invites = new GuestInviteStore(db, { guilds, channels: guest });
  const guildSettings = new GuildSettingsStore(db, now);
  guildSettings.setChannel(OWNER_GUILD, "systemChannelId", "system-1");
  const admin = new FakeGateway({ allow: ["sendMessage"] });
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const notify = createGuestNotifier({ cfg: CFG, guildSettings, gateway: admin, log });
  const gateway = new FakeGuestGateway();
  const noticeText = buildGuestNoticeText(CFG);
  const onboard = createGuestOnboarding({ guilds, gateway, noticeText, notify, now, log });
  return { db, guilds, guest, invites, admin, gateway, logs, notify, noticeText, onboard };
}

function systemTexts(admin: FakeGateway): string[] {
  return admin.posts.map((post) => post.message.text);
}

function assertNoChannelIds(logs: readonly string[]): void {
  for (const line of logs) {
    for (const secret of ["c-sys", "c-a", "c-b", "c-c", "c-d", "m-notice", "system-1", "guest-"]) {
      assert.ok(!line.includes(secret), `${secret} が log に出ています: ${line}`);
    }
  }
}

test("onboardGuild: 先頭の候補に 1 回送って記録し、#system に「参加し、案内を投稿しました」。行が無ければ作る。/guest は登録しない", async (t) => {
  const env = setup(t);
  env.gateway.noticeChannels.set(GUILD, ["c-sys", "c-a", "c-b"]);
  assert.equal(await env.onboard(GUILD), "posted");
  assert.deepEqual(env.gateway.calls, [`findNoticeChannels:${GUILD}`, "sendMessage:c-sys"]);
  assert.deepEqual(env.gateway.posts.map((post) => post.message), [{ text: env.noticeText }]);
  const row = env.guilds.get(GUILD)!;
  assert.equal(row.joinedAt, NOW.toISOString());
  assert.equal(row.allowedAt, null);
  assert.deepEqual([row.noticeChannelId, row.noticeMessageId, row.noticePostedAt], ["c-sys", "m-notice-1", NOW.toISOString()]);
  assert.deepEqual(env.gateway.registered, []);
  assert.deepEqual(systemTexts(env.admin), [`ゲスト: サーバー ${GUILD} に参加し、案内を投稿しました`]);
  assertNoChannelIds(env.logs);
});

test("onboardGuild: 先頭の候補で送信が投げたら次の候補へ送り、記録はそのチャンネル", async (t) => {
  const env = setup(t);
  env.gateway.noticeChannels.set(GUILD, ["c-sys", "c-a", "c-b"]);
  env.gateway.failingChannels.add("c-sys");
  assert.equal(await env.onboard(GUILD), "posted");
  assert.deepEqual(env.gateway.calls, [`findNoticeChannels:${GUILD}`, "sendMessage:c-sys", "sendMessage:c-a"]);
  assert.equal(env.guilds.get(GUILD)?.noticeChannelId, "c-a");
  assert.deepEqual(systemTexts(env.admin), [`ゲスト: サーバー ${GUILD} に参加し、案内を投稿しました`]);
  assertNoChannelIds(env.logs);
});

test("onboardGuild: 候補が全部失敗なら「送信に失敗しました」、候補が 2 つなら 2 つで止まる。記録は NULL のまま", async (t) => {
  const env = setup(t);
  env.gateway.noticeChannels.set(GUILD, ["c-sys", "c-a", "c-b", "c-c"]);
  for (const channel of ["c-sys", "c-a", "c-b", "c-c"]) env.gateway.failingChannels.add(channel);
  assert.equal(await env.onboard(GUILD), "send_failed");
  // 4 つ目は試さない（最大 3 つ）
  assert.deepEqual(env.gateway.calls, [`findNoticeChannels:${GUILD}`, "sendMessage:c-sys", "sendMessage:c-a", "sendMessage:c-b"]);
  assert.equal(env.guilds.get(GUILD)?.noticeMessageId, null);
  assert.deepEqual(systemTexts(env.admin), [`ゲスト: サーバー ${GUILD} に参加しましたが、案内を投稿できませんでした（送信に失敗しました）`]);

  const two = setup(t);
  two.gateway.noticeChannels.set(GUILD, ["c-a", "c-b"]);
  two.gateway.failingChannels.add("c-a");
  two.gateway.failingChannels.add("c-b");
  assert.equal(await two.onboard(GUILD), "send_failed");
  assert.deepEqual(two.gateway.calls, [`findNoticeChannels:${GUILD}`, "sendMessage:c-a", "sendMessage:c-b"]);
  assert.equal(two.guilds.get(GUILD)?.noticeMessageId, null);
  assertNoChannelIds([...env.logs, ...two.logs]);
});

test("onboardGuild: 候補が無ければ投稿せず、#system に「投稿できるチャンネルがありません」", async (t) => {
  const env = setup(t);
  assert.equal(await env.onboard(GUILD), "no_channel");
  assert.deepEqual(env.gateway.posts, []);
  assert.equal(env.guilds.get(GUILD)?.noticeMessageId, null);
  assert.deepEqual(systemTexts(env.admin), [`ゲスト: サーバー ${GUILD} に参加しましたが、案内を投稿できませんでした（投稿できるチャンネルがありません）`]);
});

test("onboardGuild: notice_message_id があれば revoked_reason が何であれ投稿しない。clearNotice の後は投稿する。重なった呼び出しは 1 回だけ投稿する", async (t) => {
  const env = setup(t);
  env.gateway.noticeChannels.set(GUILD, ["c-a"]);
  env.guilds.allow(GUILD, NOW);
  env.guilds.setNotice(GUILD, "c-old", "m-old", NOW);
  for (const reason of ["revoke", "left"] as const) {
    env.guilds.allow(GUILD, NOW);
    env.guilds.revoke(GUILD, reason, NOW);
    assert.equal(await env.onboard(GUILD), "already");
  }
  assert.deepEqual(env.gateway.calls, []);
  env.guilds.clearNotice(GUILD);
  const [first, second] = await Promise.all([env.onboard(GUILD), env.onboard(GUILD)]);
  assert.deepEqual([first, second], ["posted", "posted"]);
  assert.equal(env.gateway.posts.length, 1);
  // 許可は取り消しのまま
  assert.equal(env.guilds.isAllowed(GUILD), false);
  assert.equal(await env.onboard(GUILD), "already");
  assert.equal(env.gateway.posts.length, 1);
});

/** /guests invite（createGuestsCommand を直接呼ぶ。サーバー・オーナーの判定は guest-admin-command.test.ts） */
async function invite(env: ReturnType<typeof setup>): Promise<FakeResponder> {
  const admin: GuestAdmin = {
    cfg: CFG,
    invites: env.invites,
    guilds: env.guilds,
    guest: env.guest,
    gateway: env.gateway,
    onboardGuild: env.onboard,
    notify: env.notify,
    now: () => NOW,
  };
  const command = createGuestsCommand({ guests: admin, log: (line) => env.logs.push(line) });
  const interaction = {
    kind: "command",
    name: "guests",
    subcommand: "invite",
    options: { server_id: GUILD },
    guildId: OWNER_GUILD,
    channelId: "c-main",
    userId: "owner-1",
    createdAt: NOW,
  } as Extract<Interaction, { kind: "command" }>;
  const responder = new FakeResponder();
  await command.handle(interaction, responder);
  return responder;
}

test("/guests invite: 参加していて notice_message_id が無ければ投稿して記録が入る。/guest は登録しない", async (t) => {
  const env = setup(t);
  env.gateway.joined.add(GUILD);
  env.gateway.noticeChannels.set(GUILD, ["c-a"]);
  const responder = await invite(env);
  assert.deepEqual(env.gateway.calls, [`findNoticeChannels:${GUILD}`, "sendMessage:c-a"]);
  assert.equal(env.guilds.get(GUILD)?.noticeMessageId, "m-notice-1");
  assert.deepEqual(env.gateway.registered, []);
  assert.equal(responder.replies.length, 1);
  assert.ok(!responder.replies[0]!.text.includes("案内を投稿できませんでした"));
});

test("/guests invite: notice_message_id があるがメッセージが無ければ、記録を消してから投稿し直し、記録が新しい ID になる", async (t) => {
  const env = setup(t);
  env.gateway.joined.add(GUILD);
  env.gateway.noticeChannels.set(GUILD, ["c-b"]);
  env.guilds.upsertJoined(GUILD, NOW);
  env.guilds.setNotice(GUILD, "c-a", "m-gone", NOW);
  await invite(env);
  assert.deepEqual(env.gateway.calls, ["messageExists", `findNoticeChannels:${GUILD}`, "sendMessage:c-b"]);
  const row = env.guilds.get(GUILD)!;
  assert.deepEqual([row.noticeChannelId, row.noticeMessageId], ["c-b", "m-notice-1"]);
  assert.deepEqual(env.gateway.registered, []);
});

test("/guests invite: メッセージがまだあれば投稿しない。取り消したサーバーでも案内が消えていれば投稿し直す", async (t) => {
  const env = setup(t);
  env.gateway.joined.add(GUILD);
  env.gateway.noticeChannels.set(GUILD, ["c-b"]);
  env.guilds.allow(GUILD, NOW);
  env.guilds.setNotice(GUILD, "c-a", "m-alive", NOW);
  env.gateway.messages.add("c-a:m-alive");
  await invite(env);
  assert.deepEqual(env.gateway.calls, ["messageExists"]);
  assert.equal(env.guilds.get(GUILD)?.noticeMessageId, "m-alive");

  env.guilds.revoke(GUILD, "revoke", NOW);
  env.gateway.messages.clear();
  env.gateway.calls.length = 0;
  await invite(env);
  assert.deepEqual(env.gateway.calls, ["messageExists", `findNoticeChannels:${GUILD}`, "sendMessage:c-b"]);
  assert.equal(env.guilds.get(GUILD)?.noticeMessageId, "m-notice-1");
  assert.equal(env.guilds.isAllowed(GUILD), false);
});

test("/guests invite: 参加していなければ投稿せず応答に注記。確認・投稿の失敗は応答に 1 行添えるだけで発行は成立する", async (t) => {
  const env = setup(t);
  const responder = await invite(env);
  assert.deepEqual(env.gateway.calls, []);
  assert.ok(responder.replies[0]!.text.includes(GUESTS_NOT_JOINED_NOTE));
  assert.notEqual(env.invites.activeFor(GUILD, NOW), undefined);

  const failing = setup(t);
  failing.gateway.joined.add(GUILD);
  failing.guilds.upsertJoined(GUILD, NOW);
  failing.guilds.setNotice(GUILD, "c-a", "m-x", NOW);
  failing.gateway.messageExistsError = new Error("Missing Access");
  const failed = await invite(failing);
  assert.ok(failed.replies[0]!.text.includes("案内の確認・投稿に失敗しました"));
  assert.notEqual(failing.invites.activeFor(GUILD, NOW), undefined);
  // 投げたときは記録を消さない
  assert.equal(failing.guilds.get(GUILD)?.noticeMessageId, "m-x");

  const noChannel = setup(t);
  noChannel.gateway.joined.add(GUILD);
  const none = await invite(noChannel);
  assert.ok(none.replies[0]!.text.includes("案内を投稿できませんでした（投稿できるチャンネルがありません）"));
  assertNoChannelIds([...env.logs, ...failing.logs, ...noChannel.logs]);
});
