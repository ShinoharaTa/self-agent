import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import { ChannelOpsQueue, type ChannelOpsTimers } from "../src/app/channel-ops.ts";
import { type Gateway, UnknownChannelError } from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";

const NOW = new Date("2026-10-02T00:12:00Z");
const GAP_MS = 2000;

type GatewayCall =
  | { method: "getParentId"; channelId: string }
  | { method: "moveChannel"; channelId: string; parentId: string }
  | { method: "channelExists"; channelId: string }
  | { method: "countChannelsIn"; categoryId: string }
  | { method: "createCategory"; guildId: string; name: string };

/** チャンネルの親と、カテゴリの中の数を覚えておく */
class FakeGateway
  implements Pick<Gateway, "getParentId" | "moveChannel" | "channelExists" | "countChannelsIn" | "createCategory">
{
  calls: GatewayCall[] = [];
  readonly parents = new Map<string, string | null>();
  /** カテゴリに手動で置かれたチャンネルの数（countChannelsIn に足す） */
  readonly manual = new Map<string, number>();
  /** moveChannel の直前に呼ばれる。投げればその移動は失敗する */
  beforeMove: (channelId: string) => Promise<void> | void = () => {};
  private nextId = 1;

  async getParentId(channelId: string): Promise<string | null> {
    this.calls.push({ method: "getParentId", channelId });
    return this.parents.get(channelId) ?? null;
  }
  async moveChannel(channelId: string, parentId: string): Promise<void> {
    this.calls.push({ method: "moveChannel", channelId, parentId });
    await this.beforeMove(channelId);
    this.parents.set(channelId, parentId);
  }
  async channelExists(channelId: string): Promise<boolean> {
    this.calls.push({ method: "channelExists", channelId });
    return true;
  }
  async countChannelsIn(categoryId: string): Promise<number> {
    this.calls.push({ method: "countChannelsIn", categoryId });
    let count = this.manual.get(categoryId) ?? 0;
    for (const parentId of this.parents.values()) if (parentId === categoryId) count++;
    return count;
  }
  async createCategory(guildId: string, name: string): Promise<string> {
    this.calls.push({ method: "createCategory", guildId, name });
    return `new-category-${this.nextId++}`;
  }

  moves(): Array<[string, string]> {
    return this.calls.flatMap((call) => (call.method === "moveChannel" ? [[call.channelId, call.parentId]] : []));
  }
}

/** 偽の時計。sleep は advance で時刻が来たら進む */
class FakeClock implements ChannelOpsTimers {
  now = 0;
  sleeps: number[] = [];
  private timers: Array<{ at: number; fn: () => void }> = [];

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    return new Promise((resolve) => this.timers.push({ at: this.now + ms, fn: resolve }));
  }

  /** 待っている sleep の数 */
  get pending(): number {
    return this.timers.length;
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      await settle();
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = target;
    await settle();
  }
}

/** 実行中の非同期処理を進める */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await flush();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const gateway = new FakeGateway();
  const clock = new FakeClock();
  const guildSettings = new GuildSettingsStore(db, () => NOW);
  const topicSessions = new TopicSessionStore(db, () => NOW);
  const logs: string[] = [];
  const queue = new ChannelOpsQueue({
    gateway,
    guildSettings,
    topicSessions,
    gapMs: GAP_MS,
    timers: clock,
    log: (line) => logs.push(line),
  });
  // 完了カテゴリ 1 つ（/setup 済み）
  guildSettings.setStateCategory("guild-1", "done", 1, "done-1");
  return { gateway, clock, guildSettings, topicSessions, logs, queue };
}

const DONE = { kind: "state", guildId: "guild-1", state: "done" } as const;

test("指定のカテゴリへ移し、sessions の category_id を更新する", async (t) => {
  const { gateway, topicSessions, queue } = setup(t);
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "x", categoryId: "active-1" });
  gateway.parents.set("topic-1", "active-1");

  queue.enqueueMove("topic-1", { kind: "category", categoryId: "home-1" });
  await settle();

  assert.deepEqual(gateway.calls, [
    { method: "getParentId", channelId: "topic-1" },
    { method: "moveChannel", channelId: "topic-1", parentId: "home-1" },
  ]);
  assert.equal(topicSessions.get("topic-1")?.categoryId, "home-1");
});

test("実行時に今の親が目的のカテゴリなら動かさない", async (t) => {
  const { gateway, queue } = setup(t);
  gateway.parents.set("inbox-1", "home-1");

  queue.enqueueMove("inbox-1", { kind: "category", categoryId: "home-1" });
  await settle();

  assert.deepEqual(gateway.calls, [{ method: "getParentId", channelId: "inbox-1" }]);
});

test("状態の移動先: その状態のカテゴリのどれかに既にあれば、満杯でも動かさない", async (t) => {
  const { gateway, guildSettings, topicSessions, queue } = setup(t);
  guildSettings.setStateCategory("guild-1", "done", 2, "done-2");
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "x", categoryId: "active-1" });
  gateway.parents.set("topic-1", "done-2");
  gateway.manual.set("done-1", 50);
  gateway.manual.set("done-2", 49);

  queue.enqueueMove("topic-1", DONE);
  await settle();

  assert.deepEqual(gateway.calls, [{ method: "getParentId", channelId: "topic-1" }]);
  assert.equal(topicSessions.get("topic-1")?.categoryId, "done-2");
});

test("状態の移動先: ordinal の昇順で 50 未満の最初のカテゴリへ移す", async (t) => {
  const { gateway, guildSettings, queue } = setup(t);
  guildSettings.setStateCategory("guild-1", "done", 3, "done-3");
  guildSettings.setStateCategory("guild-1", "done", 2, "done-2");
  gateway.parents.set("topic-1", "active-1");
  gateway.manual.set("done-1", 50);

  queue.enqueueMove("topic-1", DONE);
  await settle();

  assert.deepEqual(gateway.calls, [
    { method: "getParentId", channelId: "topic-1" },
    { method: "channelExists", channelId: "done-1" },
    { method: "countChannelsIn", categoryId: "done-1" },
    { method: "channelExists", channelId: "done-2" },
    { method: "countChannelsIn", categoryId: "done-2" },
    { method: "moveChannel", channelId: "topic-1", parentId: "done-2" },
  ]);
});

test("状態の移動先: 完了がすべて満杯なら「完了 2」を作って保存し、そこへ移す", async (t) => {
  const { gateway, guildSettings, topicSessions, logs, queue } = setup(t);
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "x", categoryId: "active-1" });
  gateway.parents.set("topic-1", "active-1");
  gateway.manual.set("done-1", 50);

  queue.enqueueMove("topic-1", DONE);
  await settle();

  assert.deepEqual(gateway.calls.slice(3), [
    { method: "createCategory", guildId: "guild-1", name: "完了 2" },
    { method: "moveChannel", channelId: "topic-1", parentId: "new-category-1" },
  ]);
  assert.deepEqual(guildSettings.listStateCategories("guild-1", "done"), [
    { ordinal: 1, categoryId: "done-1" },
    { ordinal: 2, categoryId: "new-category-1" },
  ]);
  assert.equal(topicSessions.get("topic-1")?.categoryId, "new-category-1");
  assert.deepEqual(logs, ["完了カテゴリに空きが無いため「完了 2」を作りました（guild=guild-1）"]);
});

test("全サーバー共通で 1 つずつ実行し、操作の間を SELF_AGENT_CHANNEL_OP_GAP_MS 空ける", async (t) => {
  const { gateway, clock, queue } = setup(t);

  queue.enqueueMove("a", { kind: "category", categoryId: "x" });
  queue.enqueueMove("b", { kind: "category", categoryId: "y" });
  await settle();
  assert.deepEqual(gateway.moves(), [["a", "x"]]);

  await clock.advance(GAP_MS - 1);
  assert.deepEqual(gateway.moves(), [["a", "x"]]);

  await clock.advance(1);
  assert.deepEqual(gateway.moves(), [
    ["a", "x"],
    ["b", "y"],
  ]);

  // 列が空になった直後に来た移動も、前の操作から間を空けてから実行する
  queue.enqueueMove("c", { kind: "category", categoryId: "z" });
  await settle();
  assert.equal(gateway.moves().length, 2);
  await clock.advance(GAP_MS);
  assert.deepEqual(gateway.moves()[2], ["c", "z"]);
  assert.deepEqual(clock.sleeps, [GAP_MS, GAP_MS, GAP_MS]);
});

test("同じチャンネルの未実行の移動は最新の目的地にまとめる（列の位置は最初のまま）", async (t) => {
  const { gateway, clock, queue } = setup(t);
  const gate = deferred();
  gateway.beforeMove = (channelId) => (channelId === "first" ? gate.promise : undefined);

  queue.enqueueMove("first", { kind: "category", categoryId: "x" });
  await settle();
  queue.enqueueMove("b", { kind: "category", categoryId: "x" });
  queue.enqueueMove("c", { kind: "category", categoryId: "x" });
  queue.enqueueMove("b", { kind: "category", categoryId: "y" });
  queue.enqueueMove("b", { kind: "category", categoryId: "z" });
  gate.resolve();
  await clock.advance(GAP_MS * 10);

  assert.deepEqual(gateway.moves(), [
    ["first", "x"],
    ["b", "z"],
    ["c", "x"],
  ]);
});

test("実行中の移動と同じチャンネルの移動は、終わった後に改めて実行する（今の親を見て判断する）", async (t) => {
  const { gateway, clock, queue } = setup(t);
  const gate = deferred();
  gateway.beforeMove = () => gate.promise;

  queue.enqueueMove("a", { kind: "category", categoryId: "x" });
  await settle();
  queue.enqueueMove("a", { kind: "category", categoryId: "x" });
  gateway.beforeMove = () => {};
  gate.resolve();
  await clock.advance(GAP_MS * 2);

  // 2 回目は親が x になっているので動かさない
  assert.deepEqual(gateway.moves(), [["a", "x"]]);
  assert.equal(gateway.calls.filter((call) => call.method === "getParentId").length, 2);
});

test("失敗したら log に出して終え、再試行しない。他の移動は続ける", async (t) => {
  const { gateway, clock, logs, queue } = setup(t);
  gateway.beforeMove = (channelId) => {
    if (channelId === "a") throw new Error("Missing Permissions");
  };

  queue.enqueueMove("a", { kind: "category", categoryId: "x" });
  queue.enqueueMove("b", { kind: "category", categoryId: "y" });
  await clock.advance(GAP_MS);
  assert.deepEqual(gateway.moves(), [
    ["a", "x"],
    ["b", "y"],
  ]);

  // これ以上はやり直さない（ずれは定期処理の再同期が直す）
  await clock.advance(3_600_000);
  assert.equal(gateway.moves().length, 2);
  assert.equal(clock.pending, 0);
  assert.deepEqual(logs, ["チャンネルの移動に失敗しました（次の定期処理で直します）: Missing Permissions"]);
});

test("Discord への問い合わせの失敗も log に出して終える", async (t) => {
  const { gateway, clock, logs, queue } = setup(t);
  gateway.getParentId = async () => {
    throw new Error("Service Unavailable");
  };

  queue.enqueueMove("a", { kind: "category", categoryId: "x" });
  await clock.advance(3_600_000);

  assert.deepEqual(gateway.moves(), []);
  assert.deepEqual(logs, ["チャンネルの移動に失敗しました（次の定期処理で直します）: Service Unavailable"]);
});

test("チャンネルが既に無い（Unknown Channel）なら、問い合わせ・移動のどちらで分かっても log に出さずに終える", async (t) => {
  const { gateway, clock, logs, queue } = setup(t);
  const getParentId = gateway.getParentId.bind(gateway);
  gateway.getParentId = async (channelId) => {
    if (channelId === "deleted-1") throw new UnknownChannelError();
    return getParentId(channelId);
  };
  gateway.beforeMove = (channelId) => {
    if (channelId === "deleted-2") throw new UnknownChannelError();
  };

  queue.enqueueMove("deleted-1", { kind: "category", categoryId: "x" });
  queue.enqueueMove("deleted-2", { kind: "category", categoryId: "x" });
  queue.enqueueMove("c", { kind: "category", categoryId: "x" });
  await clock.advance(3_600_000);

  assert.deepEqual(gateway.moves(), [
    ["deleted-2", "x"],
    ["c", "x"],
  ]);
  assert.deepEqual(logs, []);
});

test("idle: 実行中の移動が終わったら resolve する。間隔を空けている間・未実行の移動は待たない", async (t) => {
  const { gateway, clock, queue } = setup(t);
  // 何も実行していなければすぐ
  await queue.idle();

  const gate = deferred();
  gateway.beforeMove = (channelId) => (channelId === "a" ? gate.promise : undefined);
  queue.enqueueMove("a", { kind: "category", categoryId: "x" });
  queue.enqueueMove("b", { kind: "category", categoryId: "y" });
  await settle();

  let idle = false;
  const waiting = queue.idle().then(() => {
    idle = true;
  });
  await settle();
  assert.equal(idle, false);

  gate.resolve();
  await waiting;
  assert.equal(idle, true);
  // b はまだ始めていない（間隔を空けている）
  assert.deepEqual(gateway.moves(), [["a", "x"]]);
  await queue.idle();

  await clock.advance(GAP_MS);
  assert.deepEqual(gateway.moves()[1], ["b", "y"]);
});

test("cancel: そのチャンネルの未実行の移動を捨て、他のチャンネルの移動は残す", async (t) => {
  const { gateway, clock, queue } = setup(t);
  const gate = deferred();
  gateway.beforeMove = (channelId) => (channelId === "first" ? gate.promise : undefined);

  queue.enqueueMove("first", { kind: "category", categoryId: "x" });
  await settle();
  queue.enqueueMove("a", { kind: "category", categoryId: "x" });
  queue.enqueueMove("b", { kind: "category", categoryId: "y" });
  queue.cancel("a");
  // 列に無いチャンネルは何もしない
  queue.cancel("unknown");
  gate.resolve();
  await clock.advance(GAP_MS * 10);

  assert.deepEqual(gateway.moves(), [
    ["first", "x"],
    ["b", "y"],
  ]);
  assert.equal(
    gateway.calls.some((call) => call.method === "getParentId" && call.channelId === "a"),
    false,
  );
});

test("cancel の後に同じチャンネルの移動を入れれば、改めて実行する", async (t) => {
  const { gateway, clock, queue } = setup(t);
  const gate = deferred();
  gateway.beforeMove = (channelId) => (channelId === "first" ? gate.promise : undefined);

  queue.enqueueMove("first", { kind: "category", categoryId: "x" });
  await settle();
  queue.enqueueMove("a", { kind: "category", categoryId: "x" });
  queue.cancel("a");
  queue.enqueueMove("a", { kind: "category", categoryId: "y" });
  gate.resolve();
  await clock.advance(GAP_MS * 10);

  assert.deepEqual(gateway.moves(), [
    ["first", "x"],
    ["a", "y"],
  ]);
});
