import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelResolver, isAccepted, logUnconfiguredGuilds, type ResolveChannel } from "../src/app/access.ts";
import type { IncomingMessage } from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";

const cfg = { allowedGuildIds: ["guild-1", "guild-9"], ownerUserId: "owner-1" };

/** inbox-1 だけを #inbox とみなす */
const resolveInbox: ResolveChannel = (_guildId, channelId) => (channelId === "inbox-1" ? "inbox" : null);

const accepted: IncomingMessage = {
  id: "message-1",
  channelId: "inbox-1",
  guildId: "guild-1",
  authorId: "owner-1",
  authorIsBot: false,
  isWebhook: false,
  content: "明日買い物に行く",
  createdAt: new Date("2026-10-02T00:12:00Z"),
};

function tempGuildSettings(t: TestContext): GuildSettingsStore {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return new GuildSettingsStore(db, () => new Date("2026-10-02T00:12:00Z"));
}

test("すべての条件を満たす発言は受け付ける", () => {
  assert.equal(isAccepted(accepted, cfg, resolveInbox), true);
});

test("条件を 1 つでも外れる発言は弾く", () => {
  const cases: Array<[string, Partial<IncomingMessage>]> = [
    ["許可していないサーバー", { guildId: "guild-2" }],
    ["DM", { guildId: null }],
    ["受け付け対象でないチャンネル", { channelId: "other-1" }],
    ["オーナー以外", { authorId: "someone-else" }],
    ["bot", { authorIsBot: true }],
    ["Webhook", { isWebhook: true }],
    ["空の本文", { content: "" }],
    ["空白だけの本文", { content: " \n\t " }],
  ];
  for (const [name, override] of cases) {
    assert.equal(isAccepted({ ...accepted, ...override }, cfg, resolveInbox), false, name);
  }
});

test("設定が欠けていれば何も受け付けない", () => {
  assert.equal(isAccepted(accepted, { ...cfg, allowedGuildIds: [] }, resolveInbox), false);
  assert.equal(isAccepted(accepted, { ...cfg, ownerUserId: undefined }, resolveInbox), false);
  assert.equal(isAccepted(accepted, cfg, () => null), false);
});

test("許可リストにある別のサーバーでも受け付ける", () => {
  assert.equal(isAccepted({ ...accepted, guildId: "guild-9" }, cfg, resolveInbox), true);
});

test("チャンネルの判定には発言のサーバーとチャンネルを渡し、他の条件で弾く発言では呼ばない", () => {
  const calls: Array<[string, string]> = [];
  const resolve: ResolveChannel = (guildId, channelId) => {
    calls.push([guildId, channelId]);
    return "inbox";
  };

  assert.equal(isAccepted({ ...accepted, guildId: "guild-9", channelId: "inbox-9" }, cfg, resolve), true);
  assert.equal(isAccepted({ ...accepted, authorId: "someone-else" }, cfg, resolve), false);
  assert.equal(isAccepted({ ...accepted, guildId: "guild-2" }, cfg, resolve), false);
  assert.equal(isAccepted({ ...accepted, content: " " }, cfg, resolve), false);

  assert.deepEqual(calls, [["guild-9", "inbox-9"]]);
});

test("createChannelResolver: /setup 済みのサーバーは DB の #inbox だけを受け付け、env の #inbox は使わない", (t) => {
  const guildSettings = tempGuildSettings(t);
  guildSettings.setChannel("guild-1", "inboxChannelId", "db-inbox-1");

  for (const inboxChannelId of ["env-inbox", undefined]) {
    const resolve = createChannelResolver({ inboxChannelId }, guildSettings);
    assert.equal(resolve("guild-1", "db-inbox-1"), "inbox", String(inboxChannelId));
    assert.equal(resolve("guild-1", "env-inbox"), null, String(inboxChannelId));
    assert.equal(resolve("guild-1", "other-1"), null, String(inboxChannelId));
  }
});

test("createChannelResolver: /setup 前のサーバーは env の #inbox があればそれを受け付け、無ければ何も受け付けない", (t) => {
  const guildSettings = tempGuildSettings(t);
  // 別のサーバーの設定は関係しない
  guildSettings.setChannel("guild-9", "inboxChannelId", "db-inbox-9");

  const withEnv = createChannelResolver({ inboxChannelId: "env-inbox" }, guildSettings);
  assert.equal(withEnv("guild-1", "env-inbox"), "inbox");
  assert.equal(withEnv("guild-1", "db-inbox-9"), null);
  assert.equal(withEnv("guild-1", "other-1"), null);

  const withoutEnv = createChannelResolver({ inboxChannelId: undefined }, guildSettings);
  assert.equal(withoutEnv("guild-1", "env-inbox"), null);
  assert.equal(withoutEnv("guild-1", "other-1"), null);
});

test("createChannelResolver: /setup が途中で止まり #inbox が未作成なら、行があるので env にも戻らず受け付けない", (t) => {
  const guildSettings = tempGuildSettings(t);
  guildSettings.setChannel("guild-1", "homeCategoryId", "home-1");

  const resolve = createChannelResolver({ inboxChannelId: "env-inbox" }, guildSettings);
  assert.equal(resolve("guild-1", "env-inbox"), null);
});

test("logUnconfiguredGuilds: guild_settings の無い許可サーバーだけを log に出し、env の #inbox を使っているかを添える", (t) => {
  const guildSettings = tempGuildSettings(t);
  guildSettings.setChannel("guild-1", "inboxChannelId", "db-inbox-1");

  const withEnv: string[] = [];
  logUnconfiguredGuilds({
    cfg: { ...cfg, inboxChannelId: "env-inbox" },
    guildSettings,
    log: (line) => withEnv.push(line),
  });
  assert.equal(withEnv.length, 1);
  assert.match(withEnv[0]!, /\/setup が未実行です（guild=guild-9）/);
  assert.match(withEnv[0]!, /SELF_AGENT_INBOX_CHANNEL_ID を #inbox として使用中/);

  const withoutEnv: string[] = [];
  logUnconfiguredGuilds({
    cfg: { ...cfg, inboxChannelId: undefined },
    guildSettings,
    log: (line) => withoutEnv.push(line),
  });
  assert.equal(withoutEnv.length, 1);
  assert.match(withoutEnv[0]!, /\/setup が未実行です（guild=guild-9）/);
  assert.match(withoutEnv[0]!, /受け付けません/);
});

test("logUnconfiguredGuilds: すべて /setup 済みなら何も出さない", (t) => {
  const guildSettings = tempGuildSettings(t);
  guildSettings.setChannel("guild-1", "inboxChannelId", "db-inbox-1");
  guildSettings.setChannel("guild-9", "inboxChannelId", "db-inbox-9");
  const logs: string[] = [];

  logUnconfiguredGuilds({ cfg: { ...cfg, inboxChannelId: "env-inbox" }, guildSettings, log: (line) => logs.push(line) });

  assert.deepEqual(logs, []);
});
