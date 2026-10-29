import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { SHELL_RESUMED_NOTICE, ShellState, shellDisabledNotice } from "../src/app/shell-state.ts";
import { createSystemNotifier } from "../src/app/system-notice.ts";
import { createGuestNotifier, guestEnabledNotice, guestLeftNotice } from "../src/guest/notify.ts";
import { NoticeStore } from "../src/store/notices.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";

const NOW = new Date("2026-10-13T00:00:00.000Z");

/** guild-1 は /setup 済み（#system あり）、guild-2 は #system なし */
function setup(t: TestContext, options: { notices?: boolean } = {}) {
  const db = tempDb(t);
  const clock = { now: NOW };
  const { guildSettings } = createStores(db, () => clock.now);
  guildSettings.setChannel("guild-1", "systemChannelId", "system-1");
  guildSettings.setChannel("guild-2", "inboxChannelId", "inbox-2");
  const gateway = new FakeGateway({ allow: ["sendMessage"] });
  const notices = new NoticeStore(db, () => clock.now);
  const logs: string[] = [];
  const notify = createSystemNotifier({
    guildSettings,
    gateway,
    ...(options.notices === false ? {} : { notices }),
    log: (line) => logs.push(line),
  });
  return { db, clock, guildSettings, gateway, notices, logs, notify };
}

test("createSystemNotifier: level 付きの行を書いてから #system に投稿し、message_id と posted_at を入れて ID を返す", async (t) => {
  const env = setup(t);
  const message = { text: "削除しますか？", components: [] };
  const messageId = await env.notify("guild-1", message, { level: "info" });
  assert.equal(messageId, "message-1");
  assert.deepEqual(env.gateway.posts, [{ channelId: "system-1", messageId: "message-1", message }]);
  assert.deepEqual(env.notices.listRecent(10), [
    {
      id: env.notices.listRecent(1)[0]!.id,
      at: NOW.toISOString(),
      guildId: "guild-1",
      level: "info",
      text: "削除しますか？",
      messageId: "message-1",
      postedAt: NOW.toISOString(),
    },
  ]);
  assert.deepEqual(env.logs, []);
});

test("createSystemNotifier: #system が無ければ行だけ書いて undefined。やり直しても行は増えない", async (t) => {
  const env = setup(t);
  assert.equal(await env.notify("guild-2", { text: "接続できません" }, { level: "warning" }), undefined);
  assert.equal(await env.notify("guild-2", { text: "接続できません" }, { level: "warning" }), undefined);
  assert.deepEqual(env.gateway.posts, []);
  const rows = env.notices.listRecent(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.guildId, "guild-2");
  assert.equal(rows[0]?.level, "warning");
  assert.equal(rows[0]?.messageId, null);
  assert.equal(rows[0]?.postedAt, null);
});

test("createSystemNotifier: 投稿の失敗は投げ、行は未投稿のまま。同じ本文のやり直しで成功すれば同じ行に message_id と posted_at が入る", async (t) => {
  const env = setup(t);
  let failures = 1;
  env.gateway.beforeSendMessage = () => {
    if (failures-- > 0) throw new Error("Missing Access");
  };
  await assert.rejects(env.notify("guild-1", { text: "取得できません" }, { level: "danger" }), /Missing Access/);
  let rows = env.notices.listRecent(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.messageId, null);
  assert.equal(rows[0]?.postedAt, null);

  env.clock.now = new Date(NOW.getTime() + 5 * 60_000);
  assert.equal(await env.notify("guild-1", { text: "取得できません" }, { level: "danger" }), "message-1");
  rows = env.notices.listRecent(10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.at, NOW.toISOString());
  assert.equal(rows[0]?.messageId, "message-1");
  assert.equal(rows[0]?.postedAt, env.clock.now.toISOString());
});

test("createSystemNotifier: 別の本文は別の行。投稿済みの行があっても同じ本文の新しい知らせは新しい行", async (t) => {
  const env = setup(t);
  await env.notify("guild-1", { text: "A" }, { level: "warning" });
  await env.notify("guild-1", { text: "B" }, { level: "success" });
  await env.notify("guild-1", { text: "A" }, { level: "warning" });
  assert.deepEqual(
    env.notices.listRecent(10).map((row) => [row.text, row.level, row.messageId]),
    [
      ["A", "warning", "message-3"],
      ["B", "success", "message-2"],
      ["A", "warning", "message-1"],
    ],
  );
});

test("createSystemNotifier: 時間切れ（既定 10 秒・timeoutMs）は投げて行は未投稿のまま", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = setup(t);
  env.gateway.beforeSendMessage = () => new Promise<void>(() => {});
  const pending = env.notify("guild-1", { text: "止まる" }, { level: "info" });
  t.mock.timers.tick(10_000);
  await assert.rejects(pending, /10000 ms で終わりませんでした/);
  const short = env.notify("guild-1", { text: "止まる" }, { level: "info", timeoutMs: 50 });
  t.mock.timers.tick(50);
  await assert.rejects(short, /50 ms で終わりませんでした/);
  assert.deepEqual(
    env.notices.listRecent(10).map((row) => row.postedAt),
    [null],
  );
});

test("createSystemNotifier: notices が無ければ記録せずに投稿だけ", async (t) => {
  const env = setup(t, { notices: false });
  assert.equal(await env.notify("guild-1", { text: "A" }, { level: "info" }), "message-1");
  assert.equal(await env.notify("guild-2", { text: "A" }, { level: "info" }), undefined);
  assert.deepEqual(env.notices.listRecent(10), []);
  assert.equal(env.gateway.posts.length, 1);
});

test("createSystemNotifier: 記録に失敗しても投稿は止めない（log はサーバー ID だけ）", async (t) => {
  const env = setup(t);
  const notify = createSystemNotifier({
    guildSettings: env.guildSettings,
    gateway: env.gateway,
    notices: {
      findUnposted: () => undefined,
      add: () => {
        throw new Error("disk I/O error");
      },
      markPosted: () => assert.fail("想定外の呼び出し"),
    },
    log: (line) => env.logs.push(line),
  });
  assert.equal(await notify("guild-1", { text: "本文" }, { level: "info" }), "message-1");
  assert.deepEqual(env.logs, ["#system への知らせの記録に失敗しました（guild=guild-1）: disk I/O error"]);
});

test("ShellState: 通らない知らせは warning、通った知らせは success の行になる", async (t) => {
  const env = setup(t);
  const results = [
    { ok: false as const, failed: ["bwrap が見つからない"] },
    { ok: true as const },
  ];
  const state = new ShellState({
    cfg: { allowedGuildIds: ["guild-1", "guild-2"] },
    check: async () => results.shift()!,
    notify: env.notify,
    log: () => {},
  });
  await state.refresh();
  await state.refresh();
  assert.deepEqual(
    env.notices.listRecent(10).map((row) => [row.guildId, row.level, row.text, row.messageId !== null]),
    [
      ["guild-2", "success", SHELL_RESUMED_NOTICE, false],
      ["guild-1", "success", SHELL_RESUMED_NOTICE, true],
      ["guild-2", "warning", shellDisabledNotice(["bwrap が見つからない"]), false],
      ["guild-1", "warning", shellDisabledNotice(["bwrap が見つからない"]), true],
    ],
  );
});

test("createGuestNotifier: level の省略は info、外されたなどは渡した level の行になる", async (t) => {
  const env = setup(t);
  const notify = createGuestNotifier({ cfg: { allowedGuildIds: ["guild-1"] }, notify: env.notify, log: () => {} });
  await notify(guestEnabledNotice("g-guest", 1));
  await notify(guestLeftNotice("g-guest", 1), "warning");
  assert.deepEqual(
    env.notices.listRecent(10).map((row) => row.level),
    ["warning", "info"],
  );
  assert.equal(env.gateway.posts.length, 2);
});
