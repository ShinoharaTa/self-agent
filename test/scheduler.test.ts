import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import type { MoveTarget } from "../src/app/channel-ops.ts";
import { deletePrompt } from "../src/app/commands/delete.ts";
import {
  DELETE_PROMPT_BATCH_LIMIT,
  IDLE_BATCH_LIMIT,
  idleNotice,
  Scheduler,
  type SchedulerTimers,
  TICK_INTERVAL_MS,
} from "../src/app/scheduler.ts";
import type { Gateway, OutgoingMessage } from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

class FakeTimers implements SchedulerTimers {
  intervals: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];

  every(fn: () => void, ms: number): () => void {
    const entry = { fn, ms, cancelled: false };
    this.intervals.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  /** 止められていない定期実行を 1 回ずつ呼ぶ */
  fire(): void {
    for (const entry of this.intervals) if (!entry.cancelled) entry.fn();
  }
}

class FakeGateway implements Pick<Gateway, "sendMessage"> {
  sent: Array<{ channelId: string; message: OutgoingMessage }> = [];
  /** sendMessage の直前に待つ。投げればその送信は失敗する */
  beforeSend: (channelId: string) => Promise<void> = async () => {};

  async sendMessage(channelId: string, message: OutgoingMessage): Promise<string> {
    await this.beforeSend(channelId);
    this.sent.push({ channelId, message });
    return `message-${this.sent.length}`;
  }
}

class RecordingChannelOps {
  moves: Array<{ channelId: string; target: MoveTarget }> = [];

  enqueueMove(channelId: string, target: MoveTarget): void {
    this.moves.push({ channelId, target });
  }
}

function setup(t: TestContext, idleHours: number = 12, deleteAfterDays: number = 30) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: NOW };
  const topicSessions = new TopicSessionStore(db, () => clock.now);
  const guildSettings = new GuildSettingsStore(db, () => clock.now);
  const gateway = new FakeGateway();
  const channelOps = new RecordingChannelOps();
  const timers = new FakeTimers();
  const logs: string[] = [];
  const scheduler = new Scheduler({
    cfg: { idleHours, deleteAfterDays },
    topicSessions,
    guildSettings,
    channelOps,
    gateway,
    now: () => clock.now,
    timers,
    log: (line) => logs.push(line),
  });
  /** 最終発言が lastActivityAt のセッションを作る */
  const createAt = (channelId: string, lastActivityAt: Date): void => {
    const saved = clock.now;
    clock.now = lastActivityAt;
    topicSessions.create({ channelId, guildId: "guild-1", title: channelId, categoryId: "active-1" });
    clock.now = saved;
  };
  /** closedAt に閉じた（完了の）セッションを作る */
  const closeAt = (channelId: string, closedAt: Date, guildId: string = "guild-1"): void => {
    const saved = clock.now;
    clock.now = closedAt;
    topicSessions.create({ channelId, guildId, title: `題名 ${channelId}`, categoryId: "done-1" });
    topicSessions.close(channelId, "要約");
    clock.now = saved;
  };
  // guild-1 は /setup 済み（#system あり）
  guildSettings.setChannel("guild-1", "systemChannelId", "system-1");
  return { db, clock, topicSessions, guildSettings, gateway, channelOps, timers, logs, scheduler, createAt, closeAt };
}

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function toWaiting(channelId: string): { channelId: string; target: MoveTarget } {
  return { channelId, target: { kind: "state", guildId: "guild-1", state: "waiting" } };
}

test("待ちに移した知らせ: 時間は設定値で文言を作り、[続ける]（wait:continue）と [閉じる]（close:start）を付ける", () => {
  assert.deepEqual(idleNotice(12, "topic-1"), {
    text: "12 時間発言がないので待ちに移しました。",
    components: [
      {
        kind: "buttons",
        buttons: [
          { customId: "wait:continue:topic-1", label: "続ける" },
          { customId: "close:start:topic-1", label: "閉じる" },
        ],
      },
    ],
  });
  assert.equal(idleNotice(3, "topic-1").text, "3 時間発言がないので待ちに移しました。");
});

test("tick: 最終発言がちょうど 12 時間前のセッションは待ちにし、その直前（12 時間に 1 ms 足りない）は残す", async (t) => {
  const env = setup(t);
  env.createAt("topic-just", ago(12 * HOUR_MS));
  env.createAt("topic-before", ago(12 * HOUR_MS - 1));

  await env.scheduler.tick();

  const moved = env.topicSessions.get("topic-just");
  assert.equal(moved?.state, "waiting");
  assert.equal(moved?.waitingSince, NOW.toISOString());
  assert.equal(env.topicSessions.get("topic-before")?.state, "active");
  assert.deepEqual(env.channelOps.moves, [toWaiting("topic-just")]);
  assert.deepEqual(env.gateway.sent, [{ channelId: "topic-just", message: idleNotice(12, "topic-just") }]);
  assert.deepEqual(env.logs, ["12 時間発言が無いセッションを待ちに移しました（guild=guild-1）"]);

  // 1 ms 進めば残りも待ちになる
  env.clock.now = new Date(NOW.getTime() + 1);
  await env.scheduler.tick();
  assert.equal(env.topicSessions.get("topic-before")?.state, "waiting");
  assert.equal(env.gateway.sent.length, 2);
});

test("tick: 1 回で動かすのは最終発言の古い順に最大 5 件。残りは次の tick で動かす", async (t) => {
  const env = setup(t);
  assert.equal(IDLE_BATCH_LIMIT, 5);
  // 作る順と古さの順を変えておく
  const hoursAgo = [13, 20, 15, 30, 14, 25, 18];
  hoursAgo.forEach((hours, index) => env.createAt(`topic-${index}`, ago(hours * HOUR_MS)));
  const oldestFirst = hoursAgo
    .map((hours, index) => ({ hours, channelId: `topic-${index}` }))
    .sort((a, b) => b.hours - a.hours)
    .map((entry) => entry.channelId);

  await env.scheduler.tick();

  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.channelId),
    oldestFirst.slice(0, 5),
  );
  assert.deepEqual(env.channelOps.moves, oldestFirst.slice(0, 5).map(toWaiting));
  for (const channelId of oldestFirst.slice(5)) assert.equal(env.topicSessions.get(channelId)?.state, "active");

  await env.scheduler.tick();

  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.channelId),
    oldestFirst,
  );
  for (const channelId of oldestFirst) assert.equal(env.topicSessions.get(channelId)?.state, "waiting");
});

test("tick: 待ち・完了・削除済みのセッションは対象にしない", async (t) => {
  const env = setup(t);
  for (const channelId of ["topic-waiting", "topic-done", "topic-deleted"]) env.createAt(channelId, ago(48 * HOUR_MS));
  env.topicSessions.setWaiting("topic-waiting");
  env.topicSessions.close("topic-done", "要約");
  env.db.prepare("UPDATE sessions SET state = 'deleted' WHERE channel_id = 'topic-deleted'").run();

  await env.scheduler.tick();

  assert.deepEqual(env.gateway.sent, []);
  assert.deepEqual(env.channelOps.moves, []);
  assert.equal(env.topicSessions.get("topic-done")?.state, "done");
  assert.equal(env.topicSessions.get("topic-deleted")?.state, "deleted");
});

test("tick: SELF_AGENT_IDLE_HOURS の値で判定し、知らせの時間もその値にする", async (t) => {
  const env = setup(t, 3);
  env.createAt("topic-1", ago(3 * HOUR_MS));
  env.createAt("topic-2", ago(3 * HOUR_MS - 1));

  await env.scheduler.tick();

  assert.deepEqual(env.gateway.sent, [{ channelId: "topic-1", message: idleNotice(3, "topic-1") }]);
  assert.equal(env.topicSessions.get("topic-2")?.state, "active");
});

test("tick: 知らせの投稿に失敗しても待ちのままにし、log に出して残りを続ける", async (t) => {
  const env = setup(t);
  env.createAt("topic-1", ago(14 * HOUR_MS));
  env.createAt("topic-2", ago(13 * HOUR_MS));
  env.gateway.beforeSend = async (channelId) => {
    if (channelId === "topic-1") throw new Error("Missing Access");
  };

  await env.scheduler.tick();

  assert.equal(env.topicSessions.get("topic-1")?.state, "waiting");
  assert.equal(env.topicSessions.get("topic-2")?.state, "waiting");
  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.channelId),
    ["topic-2"],
  );
  assert.ok(env.logs.includes("待ちに移した知らせの投稿に失敗しました（guild=guild-1）: Missing Access"), env.logs.join("\n"));
});

test("tick: 知らせの投稿より先に、対象をすべて DB で待ちにして移動を入れる", async (t) => {
  const env = setup(t);
  env.createAt("topic-1", ago(14 * HOUR_MS));
  env.createAt("topic-2", ago(13 * HOUR_MS));
  const statesAtSend: string[] = [];
  env.gateway.beforeSend = async () => {
    statesAtSend.push(
      `${env.topicSessions.get("topic-1")?.state}/${env.topicSessions.get("topic-2")?.state}/${env.channelOps.moves.length}`,
    );
  };

  await env.scheduler.tick();

  assert.deepEqual(statesAtSend, ["waiting/waiting/2", "waiting/waiting/2"]);
});

test("tick: 実行中に呼ばれたら重ねずに同じ tick を返し、idle はその完了を待つ", async (t) => {
  const env = setup(t);
  env.createAt("topic-1", ago(14 * HOUR_MS));
  let release = (): void => {};
  env.gateway.beforeSend = () => new Promise<void>((resolve) => (release = resolve));

  const first = env.scheduler.tick();
  await flush();
  const second = env.scheduler.tick();
  assert.equal(second, first);
  let idle = false;
  const waiting = env.scheduler.idle().then(() => {
    idle = true;
  });
  await flush();
  assert.equal(idle, false);

  release();
  await Promise.all([first, waiting]);
  assert.equal(idle, true);
  assert.equal(env.gateway.sent.length, 1);
  // 終わった後の idle はすぐ resolve する
  await env.scheduler.idle();
});

test("start: 起動直後に 1 回 tick して止まっていた間に過ぎた分を拾い、以後は指定の間隔で tick する", async (t) => {
  const env = setup(t);
  // 再起動前から放置されていたセッション
  env.createAt("topic-old", ago(72 * HOUR_MS));

  env.scheduler.start(TICK_INTERVAL_MS);
  await env.scheduler.idle();

  assert.equal(TICK_INTERVAL_MS, 5 * 60 * 1000);
  assert.deepEqual(
    env.timers.intervals.map((entry) => entry.ms),
    [TICK_INTERVAL_MS],
  );
  assert.equal(env.topicSessions.get("topic-old")?.state, "waiting");
  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.channelId),
    ["topic-old"],
  );

  // 間隔ごとの tick
  env.createAt("topic-new", NOW);
  env.clock.now = new Date(NOW.getTime() + 12 * HOUR_MS);
  env.timers.fire();
  await env.scheduler.idle();
  assert.equal(env.topicSessions.get("topic-new")?.state, "waiting");

  // 2 回目の start では増やさない
  env.scheduler.start(TICK_INTERVAL_MS);
  await env.scheduler.idle();
  assert.equal(env.timers.intervals.length, 1);
});

test("stop: 以後の定期実行を止め、stop の後の start では何もしない", async (t) => {
  const env = setup(t);
  env.scheduler.start(TICK_INTERVAL_MS);
  await env.scheduler.idle();

  env.scheduler.stop();
  env.createAt("topic-1", ago(14 * HOUR_MS));
  env.timers.fire();
  env.scheduler.start(TICK_INTERVAL_MS);
  await env.scheduler.idle();

  assert.equal(env.timers.intervals[0]?.cancelled, true);
  assert.equal(env.timers.intervals.length, 1);
  assert.equal(env.topicSessions.get("topic-1")?.state, "active");
  assert.deepEqual(env.gateway.sent, []);
});

test("tick: DB の失敗は reject せず log に出す", async () => {
  const logs: string[] = [];
  const scheduler = new Scheduler({
    cfg: { idleHours: 12, deleteAfterDays: 30 },
    topicSessions: {
      listIdle: () => {
        throw new Error("database is locked");
      },
      setActive: () => assert.fail("想定外の呼び出し"),
      setWaiting: () => assert.fail("想定外の呼び出し"),
      listDeleteDue: () => [],
      setDeletePrompt: () => assert.fail("想定外の呼び出し"),
    },
    guildSettings: { get: () => assert.fail("想定外の呼び出し") },
    channelOps: new RecordingChannelOps(),
    gateway: new FakeGateway(),
    now: () => NOW,
    timers: new FakeTimers(),
    log: (line) => logs.push(line),
  });

  await scheduler.tick();

  assert.deepEqual(logs, ["定期処理に失敗しました: database is locked"]);
});

test("削除の確認: 閉じてからちょうど 30 日のセッションは #system に [削除する][残す] を投稿してメッセージを記録し、その直前（1 ms 足りない）は残す", async (t) => {
  const env = setup(t);
  env.closeAt("topic-just", ago(30 * DAY_MS));
  env.closeAt("topic-before", ago(30 * DAY_MS - 1));

  await env.scheduler.tick();

  const prompted = env.topicSessions.get("topic-just");
  assert.deepEqual(env.gateway.sent, [{ channelId: "system-1", message: deletePrompt(prompted!, 30) }]);
  assert.equal(prompted?.deletePromptMessageId, "message-1");
  // 確認を投稿するだけで、状態・閉じた時刻は変えない
  assert.equal(prompted?.state, "done");
  assert.equal(prompted?.closedAt, ago(30 * DAY_MS).toISOString());
  assert.equal(env.topicSessions.get("topic-before")?.deletePromptMessageId, null);
  assert.deepEqual(env.channelOps.moves, []);
  assert.deepEqual(env.logs, ["完了から 30 日経ったセッションの削除の確認を投稿しました（guild=guild-1）"]);

  // 1 ms 進めば残りも確認する
  env.clock.now = new Date(NOW.getTime() + 1);
  await env.scheduler.tick();
  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.message.text),
    [
      "<#topic-just>（題名 topic-just）は完了から 30 日経ちました。チャンネルを削除しますか？要約は残ります。",
      "<#topic-before>（題名 topic-before）は完了から 30 日経ちました。チャンネルを削除しますか？要約は残ります。",
    ],
  );
  assert.equal(env.topicSessions.get("topic-before")?.deletePromptMessageId, "message-2");
});

test("削除の確認: SELF_AGENT_DELETE_AFTER_DAYS の値で判定し、文面の日数もその値にする", async (t) => {
  const env = setup(t, 12, 7);
  env.closeAt("topic-1", ago(7 * DAY_MS));
  env.closeAt("topic-2", ago(7 * DAY_MS - 1));

  await env.scheduler.tick();

  assert.deepEqual(env.gateway.sent, [
    { channelId: "system-1", message: deletePrompt({ channelId: "topic-1", title: "題名 topic-1" }, 7) },
  ]);
  assert.match(env.gateway.sent[0]!.message.text, /完了から 7 日経ちました/);
});

test("削除の確認: 1 回で投稿するのは閉じた時刻の古い順に最大 5 件。残りは次の tick で投稿する", async (t) => {
  const env = setup(t);
  assert.equal(DELETE_PROMPT_BATCH_LIMIT, 5);
  // 作る順と古さの順を変えておく
  const daysAgo = [31, 40, 33, 50, 32, 45, 36];
  daysAgo.forEach((days, index) => env.closeAt(`topic-${index}`, ago(days * DAY_MS)));
  const oldestFirst = daysAgo
    .map((days, index) => ({ days, channelId: `topic-${index}` }))
    .sort((a, b) => b.days - a.days)
    .map((entry) => entry.channelId);
  const promptedChannels = (): string[] =>
    env.gateway.sent.map((sent) => /^<#([^>]+)>/.exec(sent.message.text)?.[1] ?? "");

  await env.scheduler.tick();

  assert.deepEqual(promptedChannels(), oldestFirst.slice(0, 5));
  for (const channelId of oldestFirst.slice(5)) {
    assert.equal(env.topicSessions.get(channelId)?.deletePromptMessageId, null);
  }

  await env.scheduler.tick();

  assert.deepEqual(promptedChannels(), oldestFirst);
  for (const channelId of oldestFirst) assert.notEqual(env.topicSessions.get(channelId)?.deletePromptMessageId, null);
});

test("削除の確認: 投稿済みのセッションには投稿し直さない", async (t) => {
  const env = setup(t);
  env.closeAt("topic-1", ago(40 * DAY_MS));

  await env.scheduler.tick();
  env.clock.now = new Date(NOW.getTime() + 10 * DAY_MS);
  await env.scheduler.tick();
  await env.scheduler.tick();

  assert.equal(env.gateway.sent.length, 1);
  assert.equal(env.topicSessions.get("topic-1")?.deletePromptMessageId, "message-1");
});

test("削除の確認: 進行中・待ち・削除済みのセッションは対象にしない", async (t) => {
  const env = setup(t);
  for (const channelId of ["topic-active", "topic-waiting", "topic-deleted"]) env.closeAt(channelId, ago(40 * DAY_MS));
  env.db.prepare("UPDATE sessions SET state = 'active' WHERE channel_id = 'topic-active'").run();
  env.db.prepare("UPDATE sessions SET state = 'waiting' WHERE channel_id = 'topic-waiting'").run();
  env.db.prepare("UPDATE sessions SET state = 'deleted' WHERE channel_id = 'topic-deleted'").run();
  // 最終発言も古いので、進行中のものは待ちに移る（その知らせだけが投稿される）
  await env.scheduler.tick();

  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.channelId),
    ["topic-active"],
  );
  for (const channelId of ["topic-active", "topic-waiting", "topic-deleted"]) {
    assert.equal(env.topicSessions.get(channelId)?.deletePromptMessageId, null, channelId);
  }
});

test("削除の確認: #system が無いサーバーは飛ばし、log はサーバーごとに 1 回の tick で 1 回だけ出す", async (t) => {
  const env = setup(t);
  // guild-2 は /setup 未実行、guild-3 は #system を作る前に止まった
  env.guildSettings.setChannel("guild-3", "inboxChannelId", "inbox-3");
  env.closeAt("topic-2a", ago(50 * DAY_MS), "guild-2");
  env.closeAt("topic-2b", ago(49 * DAY_MS), "guild-2");
  env.closeAt("topic-3", ago(48 * DAY_MS), "guild-3");
  env.closeAt("topic-1", ago(47 * DAY_MS));

  await env.scheduler.tick();

  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.channelId),
    ["system-1"],
  );
  assert.equal(env.topicSessions.get("topic-1")?.deletePromptMessageId, "message-1");
  for (const channelId of ["topic-2a", "topic-2b", "topic-3"]) {
    assert.equal(env.topicSessions.get(channelId)?.deletePromptMessageId, null, channelId);
  }
  assert.deepEqual(env.logs, [
    "#system が無いため、削除の確認を投稿できません（guild=guild-2）。/setup を実行してください",
    "#system が無いため、削除の確認を投稿できません（guild=guild-3）。/setup を実行してください",
    "完了から 30 日経ったセッションの削除の確認を投稿しました（guild=guild-1）",
  ]);

  // #system ができれば次の tick で投稿する
  env.guildSettings.setChannel("guild-2", "systemChannelId", "system-2");
  await env.scheduler.tick();
  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.channelId),
    ["system-1", "system-2", "system-2"],
  );
  assert.equal(env.topicSessions.get("topic-2a")?.deletePromptMessageId, "message-2");
  assert.equal(env.topicSessions.get("topic-2b")?.deletePromptMessageId, "message-3");
});

test("削除の確認: 投稿に失敗したら記録せずに log に出して残りを続け、次の tick でやり直す", async (t) => {
  const env = setup(t);
  env.closeAt("topic-1", ago(40 * DAY_MS));
  env.closeAt("topic-2", ago(35 * DAY_MS));
  let failures = 1;
  env.gateway.beforeSend = async () => {
    if (failures-- > 0) throw new Error("Missing Access");
  };

  await env.scheduler.tick();

  assert.equal(env.topicSessions.get("topic-1")?.deletePromptMessageId, null);
  assert.equal(env.topicSessions.get("topic-2")?.deletePromptMessageId, "message-1");
  assert.ok(env.logs.includes("削除の確認の投稿に失敗しました（guild=guild-1）: Missing Access"), env.logs.join("\n"));

  await env.scheduler.tick();

  assert.equal(env.topicSessions.get("topic-1")?.deletePromptMessageId, "message-2");
  assert.equal(env.gateway.sent.length, 2);
});

test("tick: 待ちへの移動で DB が失敗しても、削除の確認は行う", async (t) => {
  const env = setup(t);
  env.closeAt("topic-1", ago(40 * DAY_MS));
  env.topicSessions.listIdle = () => {
    throw new Error("database is locked");
  };

  await env.scheduler.tick();

  assert.equal(env.topicSessions.get("topic-1")?.deletePromptMessageId, "message-1");
  assert.deepEqual(env.logs, [
    "定期処理に失敗しました: database is locked",
    "完了から 30 日経ったセッションの削除の確認を投稿しました（guild=guild-1）",
  ]);
});

test("削除の確認: 確認の後に進行中に戻って閉じ直したら、閉じ直してから 30 日後にもう一度確認する", async (t) => {
  const env = setup(t);
  env.closeAt("topic-1", ago(40 * DAY_MS));
  await env.scheduler.tick();
  assert.equal(env.topicSessions.get("topic-1")?.deletePromptMessageId, "message-1");

  // 発言で進行中に戻り（確認の記録は消える）、今閉じ直す
  env.topicSessions.setActive("topic-1");
  env.topicSessions.close("topic-1", "要約");
  env.clock.now = new Date(NOW.getTime() + 30 * DAY_MS - 1);
  await env.scheduler.tick();
  assert.equal(env.gateway.sent.length, 1);

  env.clock.now = new Date(NOW.getTime() + 30 * DAY_MS);
  await env.scheduler.tick();
  assert.equal(env.gateway.sent.length, 2);
  assert.equal(env.gateway.sent[1]?.channelId, "system-1");
  assert.equal(env.topicSessions.get("topic-1")?.deletePromptMessageId, "message-2");
});
