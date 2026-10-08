import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptedChannel, createChannelResolver, logUnconfiguredGuilds, type ResolveChannel } from "../src/app/access.ts";
import type { IncomingMessage } from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";

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

function tempStores(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const now = () => new Date("2026-10-02T00:12:00Z");
  return { db, guildSettings: new GuildSettingsStore(db, now), topicSessions: new TopicSessionStore(db, now) };
}

function tempGuildSettings(t: TestContext): GuildSettingsStore {
  return tempStores(t).guildSettings;
}

/** sessions の行が無い DB（#inbox の判定だけを見る） */
const NO_SESSIONS = { get: () => undefined };

test("すべての条件を満たす発言は受け付け、チャンネルの種類を返す", () => {
  assert.equal(acceptedChannel(accepted, cfg, resolveInbox), "inbox");
  assert.equal(acceptedChannel(accepted, cfg, () => "session"), "session");
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
    assert.equal(acceptedChannel({ ...accepted, ...override }, cfg, resolveInbox), null, name);
  }
});

test("設定が欠けていれば何も受け付けない", () => {
  assert.equal(acceptedChannel(accepted, { ...cfg, allowedGuildIds: [] }, resolveInbox), null);
  assert.equal(acceptedChannel(accepted, { ...cfg, ownerUserId: undefined }, resolveInbox), null);
  assert.equal(acceptedChannel(accepted, cfg, () => null), null);
});

test("許可リストにある別のサーバーでも受け付ける", () => {
  assert.equal(acceptedChannel({ ...accepted, guildId: "guild-9" }, cfg, resolveInbox), "inbox");
});

test("チャンネルの判定には発言のサーバーとチャンネルを渡し、他の条件で弾く発言では呼ばない", () => {
  const calls: Array<[string, string]> = [];
  const resolve: ResolveChannel = (guildId, channelId) => {
    calls.push([guildId, channelId]);
    return "inbox";
  };

  assert.equal(acceptedChannel({ ...accepted, guildId: "guild-9", channelId: "inbox-9" }, cfg, resolve), "inbox");
  assert.equal(acceptedChannel({ ...accepted, authorId: "someone-else" }, cfg, resolve), null);
  assert.equal(acceptedChannel({ ...accepted, guildId: "guild-2" }, cfg, resolve), null);
  assert.equal(acceptedChannel({ ...accepted, content: " " }, cfg, resolve), null);

  assert.deepEqual(calls, [["guild-9", "inbox-9"]]);
});

test("createChannelResolver: /setup 済みのサーバーは DB の #inbox だけを受け付け、env の #inbox は使わない", (t) => {
  const guildSettings = tempGuildSettings(t);
  guildSettings.setChannel("guild-1", "inboxChannelId", "db-inbox-1");

  for (const inboxChannelId of ["env-inbox", undefined]) {
    const resolve = createChannelResolver({ inboxChannelId }, guildSettings, NO_SESSIONS);
    assert.equal(resolve("guild-1", "db-inbox-1"), "inbox", String(inboxChannelId));
    assert.equal(resolve("guild-1", "env-inbox"), null, String(inboxChannelId));
    assert.equal(resolve("guild-1", "other-1"), null, String(inboxChannelId));
  }
});

test("createChannelResolver: /setup 前のサーバーは env の #inbox があればそれを受け付け、無ければ何も受け付けない", (t) => {
  const guildSettings = tempGuildSettings(t);
  // 別のサーバーの設定は関係しない
  guildSettings.setChannel("guild-9", "inboxChannelId", "db-inbox-9");

  const withEnv = createChannelResolver({ inboxChannelId: "env-inbox" }, guildSettings, NO_SESSIONS);
  assert.equal(withEnv("guild-1", "env-inbox"), "inbox");
  assert.equal(withEnv("guild-1", "db-inbox-9"), null);
  assert.equal(withEnv("guild-1", "other-1"), null);

  const withoutEnv = createChannelResolver({ inboxChannelId: undefined }, guildSettings, NO_SESSIONS);
  assert.equal(withoutEnv("guild-1", "env-inbox"), null);
  assert.equal(withoutEnv("guild-1", "other-1"), null);
});

test("createChannelResolver: /setup が途中で止まり #inbox が未作成なら、行があるので env にも戻らず受け付けない", (t) => {
  const guildSettings = tempGuildSettings(t);
  guildSettings.setChannel("guild-1", "homeCategoryId", "home-1");

  const resolve = createChannelResolver({ inboxChannelId: "env-inbox" }, guildSettings, NO_SESSIONS);
  assert.equal(resolve("guild-1", "env-inbox"), null);
});

test("createChannelResolver: sessions に行があり削除済みでなければ、そのサーバーのセッションとして受け付ける", (t) => {
  const { db, guildSettings, topicSessions } = tempStores(t);
  guildSettings.setChannel("guild-1", "inboxChannelId", "db-inbox-1");
  for (const [channelId, state] of [
    ["session-active", "active"],
    ["session-waiting", "waiting"],
    ["session-done", "done"],
    ["session-deleted", "deleted"],
  ] as const) {
    topicSessions.create({ channelId, guildId: "guild-1", title: "題名", categoryId: "active-1" });
    db.prepare("UPDATE sessions SET state = ? WHERE channel_id = ?").run(state, channelId);
  }

  const resolve = createChannelResolver({ inboxChannelId: undefined }, guildSettings, topicSessions);
  assert.equal(resolve("guild-1", "db-inbox-1"), "inbox");
  assert.equal(resolve("guild-1", "session-active"), "session");
  assert.equal(resolve("guild-1", "session-waiting"), "session");
  assert.equal(resolve("guild-1", "session-done"), "session");
  assert.equal(resolve("guild-1", "session-deleted"), null);
  assert.equal(resolve("guild-1", "other-1"), null);
});

test("createChannelResolver: 別のサーバーの sessions の行では受け付けない", (t) => {
  const { guildSettings, topicSessions } = tempStores(t);
  topicSessions.create({ channelId: "session-1", guildId: "guild-1", title: "題名", categoryId: "active-1" });

  const resolve = createChannelResolver({ inboxChannelId: undefined }, guildSettings, topicSessions);
  assert.equal(resolve("guild-1", "session-1"), "session");
  assert.equal(resolve("guild-9", "session-1"), null);
  // 許可サーバー間でも、発言のサーバーと行のサーバーが違えば弾く
  assert.equal(acceptedChannel({ ...accepted, guildId: "guild-9", channelId: "session-1" }, cfg, resolve), null);
  assert.equal(acceptedChannel({ ...accepted, channelId: "session-1" }, cfg, resolve), "session");
});

test("createChannelResolver: /setup 済みのサーバーの DB の #tasks は tasks として受け付ける。別のサーバーの同じ ID・/setup 前のサーバー（env の fallback）では受け付けない", (t) => {
  const { guildSettings, topicSessions } = tempStores(t);
  guildSettings.setChannel("guild-1", "inboxChannelId", "db-inbox-1");
  guildSettings.setChannel("guild-1", "tasksChannelId", "db-tasks-1");

  const resolve = createChannelResolver({ inboxChannelId: "env-inbox" }, guildSettings, topicSessions);
  assert.equal(resolve("guild-1", "db-tasks-1"), "tasks");
  assert.equal(resolve("guild-1", "db-inbox-1"), "inbox");
  // guild-9 は /setup 前。env の fallback は #inbox だけで、#tasks は無い（別のサーバーの #tasks の ID でも受け付けない）
  assert.equal(resolve("guild-9", "env-inbox"), "inbox");
  assert.equal(resolve("guild-9", "db-tasks-1"), null);
  assert.equal(acceptedChannel({ ...accepted, channelId: "db-tasks-1" }, cfg, resolve), "tasks");
  assert.equal(acceptedChannel({ ...accepted, guildId: "guild-9", channelId: "db-tasks-1" }, cfg, resolve), null);

  // guild-9 も /setup 済みになっても、#tasks はそのサーバーのものだけ
  guildSettings.setChannel("guild-9", "inboxChannelId", "db-inbox-9");
  guildSettings.setChannel("guild-9", "tasksChannelId", "db-tasks-9");
  assert.equal(resolve("guild-9", "db-tasks-9"), "tasks");
  assert.equal(resolve("guild-9", "db-tasks-1"), null);
  assert.equal(resolve("guild-1", "db-tasks-9"), null);
});

test("createChannelResolver: #tasks がまだ無い（/setup が途中で止まった）サーバーでは #tasks を受け付けない", (t) => {
  const guildSettings = tempGuildSettings(t);
  guildSettings.setChannel("guild-1", "inboxChannelId", "db-inbox-1");
  guildSettings.setChannel("guild-9", "tasksChannelId", "db-tasks-9");

  const resolve = createChannelResolver({ inboxChannelId: undefined }, guildSettings, NO_SESSIONS);
  assert.equal(resolve("guild-1", "db-tasks-9"), null);
  assert.equal(resolve("guild-1", "db-inbox-1"), "inbox");
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
