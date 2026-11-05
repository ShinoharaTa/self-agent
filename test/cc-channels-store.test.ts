import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { MIGRATIONS } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { tempDb } from "./helpers/db.ts";

const BASE = Date.parse("2026-11-05T00:00:00.000Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

function setup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const store = new CcChannelStore(db, now);
  const create = (channelId: string, sessionId: string, guildId = "guild-1") =>
    store.create({ channelId, guildId, sessionId, name: `cc-${channelId}`, cwd: "/w/alpha", origin: "web" });
  return { db, clock, store, create, guildSettings: new GuildSettingsStore(db, now) };
}

test("cc_channels: 最新の版で表と一意の部分索引があり、guild_settings に cc_category_id がある", (t) => {
  const { db } = setup(t);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 36);
  const index = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cc_channels_session'").get();
  assert.match(String(index?.sql), /UNIQUE INDEX cc_channels_session ON cc_channels\(session_id\) WHERE state <> 'deleted'/);
  // CHECK: 知らない状態・きっかけは入らない
  assert.throws(() =>
    db
      .prepare("INSERT INTO cc_channels (channel_id, guild_id, session_id, name, state, origin, created_at, updated_at) VALUES ('x', 'g', 's', 'n', 'closed', 'web', 'a', 'a')")
      .run(),
  );
  assert.throws(() =>
    db
      .prepare("INSERT INTO cc_channels (channel_id, guild_id, session_id, name, state, origin, created_at, updated_at) VALUES ('x', 'g', 's', 'n', 'open', 'hook', 'a', 'a')")
      .run(),
  );
});

test("CcChannelStore: 1 セッションに削除されていないチャンネルは 1 つ（サーバーをまたいでも）。削除済みなら同じセッションにまた作れる", (t) => {
  const { store, create } = setup(t);
  const row = create("ch-1", S1);
  assert.equal(row.state, "open");
  assert.equal(row.origin, "web");
  assert.equal(row.endedAt, null);
  assert.throws(() => create("ch-2", S1, "guild-2"), /UNIQUE/);
  // ended でも削除されていないので 2 つ目は作れない
  assert.equal(store.setState("ch-1", "ended"), true);
  assert.throws(() => create("ch-2", S1), /UNIQUE/);
  assert.equal(store.markDeleted("ch-1"), true);
  assert.equal(store.markDeleted("ch-1"), false);
  assert.equal(create("ch-2", S1).channelId, "ch-2");
  assert.equal(store.anyFor(S1)?.channelId, "ch-2");
  assert.equal(store.openFor(S1)?.channelId, "ch-2");
  assert.equal(store.anyFor(S2), undefined);
});

test("CcChannelStore.setState: ended で ended_at が今、open に戻すと NULL。resuming は from の compare-and-set（2 回目は false）で ended_at を残す", (t) => {
  const { clock, store, create } = setup(t);
  create("ch-1", S1);
  clock.now = BASE + 60_000;
  assert.equal(store.setState("ch-1", "ended", ["open"]), true);
  assert.equal(store.get("ch-1")?.endedAt, new Date(BASE + 60_000).toISOString());
  assert.equal(store.openFor(S1), undefined);
  // open から resuming へは移せない（ended のときだけ）
  assert.equal(store.setState("ch-1", "ended", ["open"]), false);
  assert.equal(store.setState("ch-1", "resuming", ["ended"]), true);
  assert.equal(store.setState("ch-1", "resuming", ["ended"]), false);
  assert.equal(store.get("ch-1")?.state, "resuming");
  assert.equal(store.get("ch-1")?.endedAt, new Date(BASE + 60_000).toISOString());
  assert.equal(store.setState("ch-1", "open", ["resuming"]), true);
  assert.equal(store.get("ch-1")?.endedAt, null);
  // 削除済みは移さない
  store.markDeleted("ch-1");
  assert.equal(store.setState("ch-1", "open"), false);
  assert.equal(store.get("ch-1")?.state, "deleted");
  assert.equal(store.setState("missing", "open"), false);
});

test("CcChannelStore.rebind: session_id を付け替えて前の id を previous_session_id に残す。前の id では引けない", (t) => {
  const { store, create } = setup(t);
  create("ch-1", S1);
  store.setState("ch-1", "ended");
  assert.equal(store.rebind("ch-1", S2), true);
  const row = store.get("ch-1");
  assert.equal(row?.sessionId, S2);
  assert.equal(row?.previousSessionId, S1);
  assert.equal(store.anyFor(S1), undefined);
  assert.equal(store.anyFor(S2)?.channelId, "ch-1");
  store.markDeleted("ch-1");
  assert.equal(store.rebind("ch-1", S1), false);
});

test("CcChannelStore.listDeleteDue・setDeletePrompt・touchEnded: 終わってから cutoff までの ended で確認を出していないものを古い順に。[残す] で ended_at を今に", (t) => {
  const { clock, store, create } = setup(t);
  create("ch-1", S1);
  create("ch-2", S2);
  create("ch-3", "33333333-3333-4333-8333-333333333333", "guild-2");
  store.setState("ch-2", "ended");
  clock.now = BASE + 1000;
  store.setState("ch-1", "ended");
  store.setState("ch-3", "ended");
  const cutoff = new Date(BASE + 1000);
  assert.deepEqual(store.listDeleteDue("guild-1", cutoff, 10).map((row) => row.channelId), ["ch-2", "ch-1"]);
  assert.deepEqual(store.listDeleteDue("guild-1", cutoff, 1).map((row) => row.channelId), ["ch-2"]);
  assert.deepEqual(store.listDeleteDue("guild-1", new Date(BASE), 10).map((row) => row.channelId), ["ch-2"]);
  assert.equal(store.setDeletePrompt("ch-2", "msg-1"), true);
  assert.deepEqual(store.listDeleteDue("guild-1", cutoff, 10).map((row) => row.channelId), ["ch-1"]);
  clock.now = BASE + 5000;
  assert.equal(store.touchEnded("ch-2"), true);
  assert.equal(store.get("ch-2")?.endedAt, new Date(BASE + 5000).toISOString());
  assert.equal(store.get("ch-2")?.deletePromptMessageId, null);
  // open は [残す] の対象でない
  store.setState("ch-1", "open");
  assert.equal(store.touchEnded("ch-1"), false);
});

test("CcChannelStore.listUndeleted・prune: 削除済みは一覧に出ず、deleted_at が cutoff より前の行だけ消す", (t) => {
  const { clock, store, create } = setup(t);
  create("ch-1", S1);
  create("ch-2", S2);
  create("ch-9", "99999999-9999-4999-8999-999999999999", "guild-2");
  store.markDeleted("ch-1");
  assert.deepEqual(store.listUndeleted("guild-1").map((row) => row.channelId), ["ch-2"]);
  clock.now = BASE + 10_000;
  store.markDeleted("ch-2");
  assert.equal(store.prune(new Date(BASE + 5000)), 1);
  assert.equal(store.get("ch-1"), undefined);
  assert.equal(store.get("ch-2")?.state, "deleted");
  // 削除されていない行は消さない
  assert.equal(store.prune(new Date(BASE + 1_000_000)), 1);
  assert.equal(store.get("ch-9")?.state, "open");
});

test("GuildSettingsStore.ccCategoryId・setCcCategory: /setup 前（行が無い）なら作らずに false", (t) => {
  const { guildSettings } = setup(t);
  assert.equal(guildSettings.ccCategoryId("guild-1"), null);
  assert.equal(guildSettings.setCcCategory("guild-1", "cat-1"), false);
  assert.equal(guildSettings.get("guild-1"), undefined);
  guildSettings.setChannel("guild-1", "homeCategoryId", "home-1");
  assert.equal(guildSettings.setCcCategory("guild-1", "cat-1"), true);
  assert.equal(guildSettings.ccCategoryId("guild-1"), "cat-1");
  assert.equal(guildSettings.setCcCategory("guild-1", "cat-2"), true);
  assert.equal(guildSettings.ccCategoryId("guild-1"), "cat-2");
});
