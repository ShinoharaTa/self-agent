// /guests（メインサーバー。docs/plan/guest-mode.md §3.2.3・§7）。既存の createInteractionHandler（サーバー → オーナー）を通して確かめる
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createInteractionHandler, OWNER_ONLY_REPLY } from "../src/app/interactions.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import {
  createGuestsCommand,
  GUESTS_BAD_ID_REPLY,
  GUESTS_EMPTY_LIST_REPLY,
  GUESTS_MAIN_GUILD_REPLY,
  type GuestAdmin,
  listText,
} from "../src/guest/commands/admin.ts";
import { hashInviteCode } from "../src/guest/invite-code.ts";
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

const OWNER = "owner-1";
const MAIN = "111111111111111111";
const GUILD = "222222222222222222";
const OTHER = "333333333333333333";
/** 2026-10-25 09:00 JST */
const NOW = new Date("2026-10-25T00:00:00.000Z");
const CODE_PATTERN = /guest(-[0-9a-hjkmnp-tv-z]{4}){6}/g;

const CFG = { allowedGuildIds: [MAIN], ownerUserId: OWNER, timeZone: "Asia/Tokyo", guestTurnsPerDay: 300, guestUserTurnsPerDay: 50 };

function setup(t: TestContext) {
  const db = tempDb(t);
  let current = NOW;
  const now = () => current;
  const guilds = new GuestGuildStore(db);
  const guest = new GuestStore(db, now);
  const invites = new GuestInviteStore(db, { guilds, channels: guest });
  const guildSettings = new GuildSettingsStore(db, now);
  guildSettings.setChannel(MAIN, "systemChannelId", "system-1");
  const adminGateway = new FakeGateway({ allow: ["sendMessage"] });
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const notify = createGuestNotifier({ cfg: CFG, guildSettings, gateway: adminGateway, log });
  const gateway = new FakeGuestGateway();
  const onboardGuild = createGuestOnboarding({ guilds, gateway, noticeText: buildGuestNoticeText(CFG), notify, now, log });
  const admin: GuestAdmin = { cfg: CFG, invites, guilds, guest, gateway, onboardGuild, notify, now };
  const handle = createInteractionHandler({ cfg: CFG, commands: [createGuestsCommand({ guests: admin, log })], components: [], log });
  const run = async (subcommand: string, options: Record<string, string> = {}, overrides: Partial<Interaction> = {}) => {
    const responder = new FakeResponder();
    await handle(
      {
        kind: "command",
        name: "guests",
        subcommand,
        options,
        guildId: MAIN,
        channelId: "c-main",
        userId: OWNER,
        createdAt: current,
        ...overrides,
      } as Interaction,
      responder,
    );
    return responder;
  };
  return {
    db,
    guilds,
    guest,
    invites,
    adminGateway,
    gateway,
    logs,
    run,
    setNow: (date: Date) => {
      current = date;
    },
  };
}

function systemTexts(admin: FakeGateway): string[] {
  return admin.posts.map((post) => post.message.text);
}

function assertNoSecrets(logs: readonly string[]): void {
  for (const line of logs) {
    for (const secret of ["c-main", OWNER, "system-1", "c-notice", "m-notice"]) {
      assert.ok(!line.includes(secret), `${secret} が log に出ています: ${line}`);
    }
    assert.ok(!line.match(CODE_PATTERN), `コードが log に出ています: ${line}`);
    assert.ok(!/[0-9a-f]{64}/.test(line), `ハッシュが log に出ています: ${line}`);
  }
}

test("/guests: オーナー以外には「オーナー専用です」で何もしない。メインのサーバー以外・DM には応答しない", async (t) => {
  const env = setup(t);
  const other = await env.run("invite", { server_id: GUILD }, { userId: "user-2" });
  assert.deepEqual(other.calls, [{ method: "reply", message: { text: OWNER_ONLY_REPLY, ephemeral: true } }]);
  const outside = await env.run("invite", { server_id: GUILD }, { guildId: GUILD });
  const dm = await env.run("list", {}, { guildId: null });
  assert.deepEqual(outside.calls, []);
  assert.deepEqual(dm.calls, []);
  assert.equal(env.invites.activeFor(GUILD, NOW), undefined);
  assert.deepEqual(env.adminGateway.posts, []);
});

test("/guests invite: 数字でない ID・メインのサーバーの ID は本人にだけ断り、発行しない", async (t) => {
  const env = setup(t);
  for (const serverId of ["abc", "12345", "1234567890123456789012", "g-guest"]) {
    const responder = await env.run("invite", { server_id: serverId });
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: GUESTS_BAD_ID_REPLY, ephemeral: true } }], serverId);
  }
  const main = await env.run("invite", { server_id: MAIN });
  assert.deepEqual(main.calls, [{ method: "reply", message: { text: GUESTS_MAIN_GUILD_REPLY, ephemeral: true } }]);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM guest_invites").get()?.n, 0);
  assert.deepEqual(env.adminGateway.posts, []);
});

test("/guests invite: 保留してから本人にだけコードを 1 回だけ返し、DB にはハッシュだけ。log・#system にコードは出ない。2 回目で前のコードを無効に", async (t) => {
  const env = setup(t);
  env.gateway.joined.add(GUILD);
  env.guilds.upsertJoined(GUILD, NOW);
  env.guilds.setNotice(GUILD, "c-notice", "m-notice", NOW);
  env.gateway.messages.add("c-notice:m-notice");
  const first = await env.run("invite", { server_id: ` ${GUILD} ` });
  assert.deepEqual(first.calls[0], { method: "defer", ephemeral: true });
  assert.equal(first.replies.length, 1);
  const text = first.replies[0]!.text;
  const codes = text.match(CODE_PATTERN) ?? [];
  assert.equal(codes.length, 1);
  const code = codes[0]!;
  assert.ok(text.startsWith(`サーバー ${GUILD} の認証コード（24 時間有効・1 回だけ）:\n\`${code}\`\n`));
  assert.ok(text.includes("案内への**返信**として貼ってもらってください"));
  assert.ok(!text.includes("前のコードは無効にしました"));
  assert.equal(env.invites.activeFor(GUILD, NOW)?.guildId, GUILD);
  const row = env.db.prepare("SELECT code_hash FROM guest_invites").get();
  assert.equal(row?.code_hash, hashInviteCode(code));
  assert.deepEqual(systemTexts(env.adminGateway), [`ゲスト: サーバー ${GUILD} の認証コードを発行しました（24 時間有効）`]);

  const second = await env.run("invite", { server_id: GUILD });
  const secondText = second.replies[0]!.text;
  assert.ok(secondText.includes("前のコードは無効にしました"));
  const secondCode = secondText.match(CODE_PATTERN)![0]!;
  assert.notEqual(secondCode, code);
  const live = env.db.prepare("SELECT COUNT(*) AS n FROM guest_invites WHERE superseded_at IS NULL").get();
  assert.equal(live?.n, 1);
  assert.ok(systemTexts(env.adminGateway).every((line) => !line.match(CODE_PATTERN)));
  assertNoSecrets(env.logs);
});

test("/guests revoke: 許可済みなら取り消し・有効なチャンネルを全部無効・生きているコードを無効・#system。定型文の記録は残る。未許可は「許可していません」", async (t) => {
  const env = setup(t);
  env.guilds.allow(GUILD, NOW);
  env.guilds.setNotice(GUILD, "c-notice", "m-notice", NOW);
  env.guest.enable(GUILD, "c1");
  env.guest.enable(GUILD, "c2");
  env.invites.issue(GUILD, NOW);
  const responder = await env.run("revoke", { server_id: GUILD });
  assert.deepEqual(responder.calls, [
    { method: "reply", message: { text: `サーバー ${GUILD} の許可を取り消しました（有効なチャンネル 2 件を無効にしました）`, ephemeral: true } },
  ]);
  const row = env.guilds.get(GUILD)!;
  assert.equal(env.guilds.isAllowed(GUILD), false);
  assert.equal(row.revokedReason, "revoke");
  assert.deepEqual([row.noticeChannelId, row.noticeMessageId], ["c-notice", "m-notice"]);
  assert.equal(env.guest.countActive(GUILD), 0);
  assert.equal(env.guest.get("c1")?.disabledReason, "command");
  assert.equal(env.invites.activeFor(GUILD, NOW), undefined);
  assert.deepEqual(systemTexts(env.adminGateway), [`ゲスト: サーバー ${GUILD} の許可を取り消しました（有効なチャンネル 2 件を無効にしました）`]);
  // Discord には何も送らない（定型文は投稿し直さない）
  assert.deepEqual(env.gateway.calls, []);

  // もう一度（取り消し済み）・行の無いサーバー・未許可のサーバー
  env.guilds.upsertJoined(OTHER, NOW);
  for (const serverId of [GUILD, OTHER, "444444444444444444"]) {
    const again = await env.run("revoke", { server_id: serverId });
    assert.deepEqual(again.calls, [{ method: "reply", message: { text: `サーバー ${serverId} は許可していません`, ephemeral: true } }]);
  }
  const bad = await env.run("revoke", { server_id: "abc" });
  assert.deepEqual(bad.replies, [{ text: GUESTS_BAD_ID_REPLY, ephemeral: true }]);
  assert.equal(env.adminGateway.posts.length, 1);
  assertNoSecrets(env.logs);
});

test("/guests list: 許可済み（チャンネル数）・未許可（コードの期限 / コードなし）・取り消し済み（revoke / left）・不参加を本人にだけ", async (t) => {
  const env = setup(t);
  const empty = await env.run("list");
  assert.deepEqual(empty.calls, [{ method: "reply", message: { text: GUESTS_EMPTY_LIST_REPLY, ephemeral: true } }]);

  env.guilds.allow(GUILD, NOW);
  env.guest.enable(GUILD, "c1");
  env.gateway.joined.add(GUILD);
  env.setNow(new Date(NOW.getTime() + 60_000));
  env.guilds.upsertJoined(OTHER, new Date(NOW.getTime() + 60_000));
  env.invites.issue(OTHER, NOW);
  env.gateway.joined.add(OTHER);
  env.guilds.upsertJoined("444444444444444444", new Date(NOW.getTime() + 120_000));
  env.guilds.allow("555555555555555555", new Date(NOW.getTime() + 180_000));
  env.guilds.revoke("555555555555555555", "revoke", NOW);
  env.guilds.allow("666666666666666666", new Date(NOW.getTime() + 240_000));
  env.guilds.revoke("666666666666666666", "left", NOW);
  const list = await env.run("list");
  assert.deepEqual(list.calls, [
    {
      method: "reply",
      message: {
        text: [
          `${GUILD}: 許可済み（チャンネル 1/5）・コードなし`,
          `${OTHER}: 未許可・コード有効 2026-10-26 09:00 まで`,
          "444444444444444444: 未許可・コードなし（不参加）",
          "555555555555555555: 取り消し済み（/guests revoke）・コードなし（不参加）",
          "666666666666666666: 取り消し済み（外された）・コードなし（不参加）",
        ].join("\n"),
        ephemeral: true,
      },
    },
  ]);
  // 期限を過ぎたコードは「コードなし」
  env.setNow(new Date(NOW.getTime() + 24 * 3_600_000));
  const later = await env.run("list");
  assert.ok(later.replies[0]!.text.includes(`${OTHER}: 未許可・コードなし`));
});

test("/guests list: guest_guilds に行が無くても、参加前に発行した生きているコードのサーバーを未許可で出す（行のあるサーバーの後）", async (t) => {
  const env = setup(t);
  env.guilds.allow(GUILD, NOW);
  env.gateway.joined.add(GUILD);
  env.invites.issue(GUILD, NOW);
  env.invites.issue(OTHER, NOW);
  const list = await env.run("list");
  assert.deepEqual(list.replies.map((reply) => reply.text), [
    [`${GUILD}: 許可済み（チャンネル 0/5）・コード有効 2026-10-26 09:00 まで`, `${OTHER}: 未許可・コード有効 2026-10-26 09:00 まで（不参加）`].join("\n"),
  ]);
  // 期限を過ぎたら出さない
  env.setNow(new Date(NOW.getTime() + 24 * 3_600_000));
  const later = await env.run("list");
  assert.ok(!later.replies[0]!.text.includes(OTHER));
});

test("listText: 2,000 字に収まらなければ「ほか n 件」にまとめる", () => {
  const lines = Array.from({ length: 60 }, (_, index) => `${String(index).padStart(18, "1")}: 許可済み（チャンネル 1/5）・コードなし`);
  const text = listText(lines);
  assert.ok(text.length <= 2000);
  const shown = text.split("\n").filter((line) => line.includes("許可済み")).length;
  assert.ok(shown < 60);
  assert.ok(text.endsWith(`ほか ${60 - shown} 件`));
  assert.equal(listText(lines.slice(0, 3)), lines.slice(0, 3).join("\n"));
});
