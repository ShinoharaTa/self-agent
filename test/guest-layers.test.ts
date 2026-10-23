// 既存の層（定期処理・リマインドの発火）は、ゲストのサーバーには触らない（docs/plan/guest-mode.md §3.7・§7）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChannelResolver } from "../src/app/access.ts";
import { ReminderScheduler } from "../src/app/reminders.ts";
import { Scheduler } from "../src/app/scheduler.ts";
import { GuestStore } from "../src/store/guest.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
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
  // ゲストを有効にした設定（Scheduler・ReminderScheduler が読むのは allowedGuildIds などだけ）
  const cfg = {
    allowedGuildIds: [OWNER_GUILD],
    idleHours: 12,
    deleteAfterDays: 30,
    ownerUserId: "owner-1",
    timeZone: "Asia/Tokyo",
    guest: true,
    guestGuildIds: [GUEST_GUILD],
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
  assert.ok(logs.every((line) => !line.includes(GUEST_GUILD)));
});
