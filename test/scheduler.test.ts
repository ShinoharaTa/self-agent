import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import type { MoveTarget } from "../src/app/channel-ops.ts";
import { deletePrompt } from "../src/app/commands/delete.ts";
import {
  DELETE_PROMPT_BATCH_LIMIT,
  IDLE_BATCH_LIMIT,
  idleNotice,
  RECONCILE_BATCH_LIMIT,
  Scheduler,
  type SchedulerTimers,
  TICK_INTERVAL_MS,
} from "../src/app/scheduler.ts";
import { pruneDevLogs } from "../src/devlog/log.ts";
import type { Gateway, OutgoingMessage } from "../src/discord/gateway.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
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

class FakeGateway implements Pick<Gateway, "sendMessage" | "listChannelParents" | "isInGuild"> {
  sent: Array<{ channelId: string; message: OutgoingMessage }> = [];
  /** Bot が参加しているサーバー。undefined なら全部に参加している扱い */
  joined: Set<string> | undefined;
  isInGuild(guildId: string): boolean {
    return this.joined === undefined || this.joined.has(guildId);
  }
  /** sendMessage の直前に待つ。投げればその送信は失敗する */
  beforeSend: (channelId: string) => Promise<void> = async () => {};
  /** listChannelParents で問い合わせたサーバー */
  listed: string[] = [];
  /** サーバーのチャンネル → 親カテゴリ。undefined なら defaultParents（ずれなし）を返す */
  parents: Map<string, string | null> | undefined;
  defaultParents: () => Map<string, string | null> = () => new Map();
  /** listChannelParents の中（結果を返す前）に呼ばれる。投げればその問い合わせは失敗する */
  beforeList: () => void = () => {};

  async sendMessage(channelId: string, message: OutgoingMessage): Promise<string> {
    await this.beforeSend(channelId);
    this.sent.push({ channelId, message });
    return `message-${this.sent.length}`;
  }
  async listChannelParents(guildId: string): Promise<Map<string, string | null>> {
    this.listed.push(guildId);
    const parents = new Map(this.parents ?? this.defaultParents());
    this.beforeList();
    return parents;
  }
}

class RecordingChannelOps {
  moves: Array<{ channelId: string; target: MoveTarget }> = [];

  enqueueMove(channelId: string, target: MoveTarget): void {
    this.moves.push({ channelId, target });
  }
}

/** #inbox の切り替え（rotateDue）の呼び出しを記録する。中身は inbox-rotate.test.ts で確かめる */
class RecordingRotator {
  /** 呼ばれたときに渡された stopping */
  calls: Array<() => boolean> = [];
  /** 呼ばれたときの他の処理の状態など */
  onCall: () => Promise<void> = async () => {};

  async rotateDue(stopping: () => boolean): Promise<void> {
    this.calls.push(stopping);
    await this.onCall();
  }
}

function setup(
  t: TestContext,
  idleHours: number = 12,
  deleteAfterDays: number = 30,
  allowedGuildIds: string[] = ["guild-1"],
) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: NOW };
  const topicSessions = new TopicSessionStore(db, () => clock.now);
  const guildSettings = new GuildSettingsStore(db, () => clock.now);
  const sessions = new SdkSessionStore(db, () => clock.now);
  const seeds = new ChannelSeedStore(db, () => clock.now);
  const gateway = new FakeGateway();
  // 既定では、削除済みでないセッションのチャンネルはどれも DB の category_id に置かれている（ずれなし）
  gateway.defaultParents = () =>
    new Map(
      db
        .prepare("SELECT channel_id, category_id FROM sessions WHERE state != 'deleted'")
        .all()
        .map((row) => [String(row.channel_id), String(row.category_id)]),
    );
  const channelOps = new RecordingChannelOps();
  const inboxRotator = new RecordingRotator();
  // 古い dev ログを消す処理。既定では何もしない（中身は devlog.test.ts で確かめる）
  const devLogs = { prune: (): void => {} };
  const timers = new FakeTimers();
  const logs: string[] = [];
  const scheduler = new Scheduler({
    cfg: { allowedGuildIds, idleHours, deleteAfterDays },
    topicSessions,
    guildSettings,
    sessions,
    seeds,
    channelOps,
    gateway,
    inboxRotator,
    pruneDevLogs: () => devLogs.prune(),
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
  return {
    db,
    clock,
    topicSessions,
    guildSettings,
    sessions,
    seeds,
    gateway,
    channelOps,
    inboxRotator,
    devLogs,
    timers,
    logs,
    scheduler,
    createAt,
    closeAt,
  };
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
    cfg: { allowedGuildIds: [], idleHours: 12, deleteAfterDays: 30 },
    topicSessions: {
      get: () => assert.fail("想定外の呼び出し"),
      listIdle: () => {
        throw new Error("database is locked");
      },
      setActive: () => assert.fail("想定外の呼び出し"),
      setWaiting: () => assert.fail("想定外の呼び出し"),
      listDeleteDue: () => [],
      setDeletePrompt: () => assert.fail("想定外の呼び出し"),
      listUndeleted: () => assert.fail("想定外の呼び出し"),
      markDeleted: () => assert.fail("想定外の呼び出し"),
    },
    guildSettings: {
      get: () => assert.fail("想定外の呼び出し"),
      listStateCategories: () => assert.fail("想定外の呼び出し"),
    },
    sessions: { delete: () => assert.fail("想定外の呼び出し") },
    seeds: { delete: () => assert.fail("想定外の呼び出し") },
    channelOps: new RecordingChannelOps(),
    gateway: new FakeGateway(),
    inboxRotator: new RecordingRotator(),
    pruneDevLogs: () => {},
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

test("tick: 待ちへの移動と削除の確認の後に #inbox の切り替えを行い、idle はその終わりまで待つ", async (t) => {
  const env = setup(t);
  env.createAt("topic-1", ago(14 * HOUR_MS));
  env.closeAt("topic-2", ago(40 * DAY_MS));
  const seen: string[] = [];
  let release = (): void => {};
  env.inboxRotator.onCall = () => {
    seen.push(`moves=${env.channelOps.moves.length} sent=${env.gateway.sent.length}`);
    return new Promise<void>((resolve) => (release = resolve));
  };

  const running = env.scheduler.tick();
  await flush();
  assert.deepEqual(seen, ["moves=1 sent=2"]);
  let idle = false;
  const waiting = env.scheduler.idle().then(() => {
    idle = true;
  });
  await flush();
  assert.equal(idle, false);

  release();
  await Promise.all([running, waiting]);
  assert.equal(idle, true);
  assert.equal(env.inboxRotator.calls.length, 1);
});

test("stop: 実行中の #inbox の切り替えには、停止を始めたことが stopping で伝わる", async (t) => {
  const env = setup(t);
  let release = (): void => {};
  env.inboxRotator.onCall = () => new Promise<void>((resolve) => (release = resolve));

  env.scheduler.start(TICK_INTERVAL_MS);
  await flush();
  const stopping = env.inboxRotator.calls[0];
  assert.ok(stopping !== undefined);
  assert.equal(stopping(), false);

  env.scheduler.stop();
  assert.equal(stopping(), true);
  release();
  await env.scheduler.idle();
});

/** /setup 済みの配置（self-agent カテゴリ・#inbox/#tasks/#system・各状態カテゴリ 1 つ目）を DB に入れる */
function layout(env: ReturnType<typeof setup>): void {
  env.guildSettings.setChannel("guild-1", "homeCategoryId", "home-1");
  env.guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  env.guildSettings.setChannel("guild-1", "tasksChannelId", "tasks-1");
  env.guildSettings.setStateCategory("guild-1", "active", 1, "active-1");
  env.guildSettings.setStateCategory("guild-1", "waiting", 1, "waiting-1");
  env.guildSettings.setStateCategory("guild-1", "done", 1, "done-1");
}

/** Discord 上のチャンネルの親。カテゴリ（親は null）と、ずれの無い #inbox/#tasks/#system に entries を足す */
function discord(entries: Array<[string, string | null]>, categories: string[] = ["home-1", "active-1", "waiting-1", "done-1"]) {
  return new Map<string, string | null>([
    ...categories.map((id): [string, null] => [id, null]),
    ["inbox-1", "home-1"],
    ["tasks-1", "home-1"],
    ["system-1", "home-1"],
    ...entries,
  ]);
}

function toState(channelId: string, state: "active" | "waiting" | "done"): { channelId: string; target: MoveTarget } {
  return { channelId, target: { kind: "state", guildId: "guild-1", state } };
}

test("再同期: 親がその状態のカテゴリのどれでもないセッションだけ、その状態のカテゴリへの移動を入れる", async (t) => {
  const env = setup(t);
  layout(env);
  env.guildSettings.setStateCategory("guild-1", "active", 2, "active-2");
  for (const channelId of ["topic-a", "topic-b", "topic-c", "topic-d", "topic-e"]) env.createAt(channelId, NOW);
  env.topicSessions.setWaiting("topic-b");
  env.topicSessions.setWaiting("topic-c");
  env.topicSessions.close("topic-d", "要約");
  env.topicSessions.close("topic-e", "要約");
  env.gateway.parents = discord(
    [
      // 2 つ目の進行中カテゴリにある（どれかに入っていればよい）
      ["topic-a", "active-2"],
      // 待ちなのに進行中カテゴリにある（移動に失敗した・手で動かされた）
      ["topic-b", "active-1"],
      ["topic-c", "waiting-1"],
      ["topic-d", "done-1"],
      // 完了なのにカテゴリの外にある
      ["topic-e", null],
    ],
    ["home-1", "active-1", "active-2", "waiting-1", "done-1"],
  );

  await env.scheduler.tick();

  assert.deepEqual(env.gateway.listed, ["guild-1"]);
  assert.deepEqual(env.channelOps.moves, [toState("topic-b", "waiting"), toState("topic-e", "done")]);
  assert.deepEqual(env.gateway.sent, []);
  assert.deepEqual(env.logs, ["状態とカテゴリが合わないセッション 2 件を移します（guild=guild-1）"]);

  // ずれが無ければ何もしない
  env.gateway.parents.set("topic-b", "waiting-1");
  env.gateway.parents.set("topic-e", "done-1");
  env.logs.length = 0;
  await env.scheduler.tick();
  assert.equal(env.channelOps.moves.length, 2);
  assert.deepEqual(env.logs, []);
});

test("再同期: Discord 上に無いセッションのチャンネルは削除済みにし（要約は残す）、SDK セッションと seed を消す", async (t) => {
  const env = setup(t);
  layout(env);
  env.createAt("topic-a", NOW);
  env.createAt("topic-gone", NOW);
  env.createAt("topic-gone-done", NOW);
  env.createAt("topic-deleted", NOW);
  env.topicSessions.close("topic-gone-done", "閉じたときの要約");
  env.topicSessions.markDeleted("topic-deleted");
  env.sessions.set("topic-gone", "session-x");
  env.seeds.set("topic-gone", "seed");
  env.sessions.set("topic-a", "session-a");
  env.gateway.parents = discord([["topic-a", "active-1"]]);
  env.clock.now = new Date(NOW.getTime() + 60_000);

  await env.scheduler.tick();

  for (const channelId of ["topic-gone", "topic-gone-done"]) {
    const session = env.topicSessions.get(channelId);
    assert.equal(session?.state, "deleted", channelId);
    assert.equal(session?.deletedAt, env.clock.now.toISOString(), channelId);
  }
  assert.equal(env.topicSessions.get("topic-gone-done")?.summary, "閉じたときの要約");
  assert.equal(env.sessions.get("topic-gone"), undefined);
  assert.equal(env.seeds.get("topic-gone"), undefined);
  // 残っているもの・既に削除済みのものはそのまま
  assert.equal(env.topicSessions.get("topic-a")?.state, "active");
  assert.equal(env.sessions.get("topic-a"), "session-a");
  assert.equal(env.topicSessions.get("topic-deleted")?.deletedAt, NOW.toISOString());
  assert.deepEqual(env.channelOps.moves, []);
  assert.deepEqual(env.logs, [
    "セッションのチャンネルが Discord 上に無いため、削除済みにしました（guild=guild-1）",
    "セッションのチャンネルが Discord 上に無いため、削除済みにしました（guild=guild-1）",
  ]);
});

test("再同期: Discord 上で消えた進行中のセッションは、待ちへの移動より先に削除済みにする（知らせも出さない）", async (t) => {
  const env = setup(t);
  layout(env);
  env.createAt("topic-gone", ago(14 * HOUR_MS));
  env.gateway.parents = discord([]);

  await env.scheduler.tick();

  assert.equal(env.topicSessions.get("topic-gone")?.state, "deleted");
  assert.deepEqual(env.gateway.sent, []);
  assert.deepEqual(env.channelOps.moves, []);
});

test("再同期: #inbox / #tasks / #system の親が self-agent カテゴリでなければ戻す移動を入れる（チャンネル自体が無ければ何もしない）", async (t) => {
  const env = setup(t);
  layout(env);
  env.gateway.parents = discord([
    ["inbox-1", "done-1"],
    ["system-1", null],
  ]);
  // #tasks は消えている（作り直すのは /setup）
  env.gateway.parents.delete("tasks-1");

  await env.scheduler.tick();

  assert.deepEqual(env.channelOps.moves, [
    { channelId: "inbox-1", target: { kind: "category", categoryId: "home-1" } },
    { channelId: "system-1", target: { kind: "category", categoryId: "home-1" } },
  ]);
  assert.deepEqual(env.logs, ["self-agent カテゴリの外にあるチャンネル 2 件を戻します（guild=guild-1）"]);
});

test("再同期: 移動を入れるのは 1 サーバーで最大 5 件（最終発言の新しい順）。残りは次の tick。消えたチャンネルの削除済みは数えない", async (t) => {
  const env = setup(t);
  assert.equal(RECONCILE_BATCH_LIMIT, 5);
  layout(env);
  const ids = ["topic-0", "topic-1", "topic-2", "topic-3", "topic-4", "topic-5", "topic-6"];
  // 新しい順は topic-6, topic-5, ...
  ids.forEach((channelId, index) => env.createAt(channelId, new Date(NOW.getTime() - (10 - index) * 60_000)));
  env.createAt("topic-gone", new Date(NOW.getTime() - 60 * 60_000));
  for (const channelId of ids) env.topicSessions.setWaiting(channelId);
  env.gateway.parents = discord(ids.map((channelId): [string, string] => [channelId, "active-1"]));

  await env.scheduler.tick();

  const newestFirst = [...ids].reverse();
  assert.deepEqual(env.channelOps.moves, newestFirst.slice(0, 5).map((channelId) => toState(channelId, "waiting")));
  assert.equal(env.topicSessions.get("topic-gone")?.state, "deleted");

  // 移動が済んだ分は次の tick では合っている
  for (const move of env.channelOps.moves) env.gateway.parents.set(move.channelId, "waiting-1");
  await env.scheduler.tick();
  assert.deepEqual(
    env.channelOps.moves.map((move) => move.channelId),
    newestFirst,
  );
});

test("再同期: その状態のカテゴリ・self-agent カテゴリが Discord 上に 1 つも無ければ、そこへは移さない（作り直すのは /setup）", async (t) => {
  const env = setup(t);
  layout(env);
  env.createAt("topic-waiting", NOW);
  env.createAt("topic-done", NOW);
  env.topicSessions.setWaiting("topic-waiting");
  env.topicSessions.close("topic-done", "要約");
  // 待ちカテゴリと self-agent カテゴリが消え、中のチャンネルはカテゴリの外に出た
  env.gateway.parents = discord(
    [
      ["topic-waiting", null],
      ["topic-done", null],
      ["inbox-1", null],
    ],
    ["active-1", "done-1"],
  );

  await env.scheduler.tick();

  assert.deepEqual(env.channelOps.moves, [toState("topic-done", "done")]);
  assert.equal(env.topicSessions.get("topic-waiting")?.state, "waiting");
});

test("再同期: 対象は許可サーバーのうち /setup 済みのサーバーだけ。問い合わせに失敗したら log に出し、残りの処理は行う", async (t) => {
  const env = setup(t, 12, 30, ["guild-1", "guild-2"]);
  // guild-2 は /setup 前、guild-9 は /setup 済みだが許可サーバーではない
  env.guildSettings.setChannel("guild-9", "inboxChannelId", "inbox-9");
  env.createAt("topic-1", ago(14 * HOUR_MS));
  env.gateway.beforeList = () => {
    throw new Error("Missing Access");
  };

  await env.scheduler.tick();

  assert.deepEqual(env.gateway.listed, ["guild-1"]);
  assert.equal(env.topicSessions.get("topic-1")?.state, "waiting");
  assert.deepEqual(env.logs, [
    "チャンネルのカテゴリの確認に失敗しました（guild=guild-1）: Missing Access",
    "12 時間発言が無いセッションを待ちに移しました（guild=guild-1）",
  ]);
});

test("再同期: 一覧を取っている間に作られたセッションは削除済みにせず、状態が変わったセッションは今の状態で判断する", async (t) => {
  const env = setup(t);
  layout(env);
  env.createAt("topic-b", NOW);
  env.topicSessions.setWaiting("topic-b");
  env.gateway.parents = discord([["topic-b", "waiting-1"]]);
  env.gateway.beforeList = () => {
    // 一覧を取った後に /new でチャンネルと行が作られ、待ちのセッションは発言で進行中に戻った
    env.topicSessions.create({ channelId: "topic-new", guildId: "guild-1", title: "新しい", categoryId: "active-1" });
    env.topicSessions.setActive("topic-b");
  };

  await env.scheduler.tick();

  assert.equal(env.topicSessions.get("topic-new")?.state, "active");
  assert.deepEqual(env.channelOps.moves, [toState("topic-b", "active")]);
});

test("tick: 待ちに移した知らせは、投稿する前に読み直して進行中に戻っていれば投稿しない", async (t) => {
  const env = setup(t);
  env.createAt("topic-1", ago(14 * HOUR_MS));
  env.createAt("topic-2", ago(13 * HOUR_MS));
  env.gateway.beforeSend = async (channelId) => {
    // topic-1 の知らせを投稿している間に、topic-2 で発言があった
    if (channelId === "topic-1") env.topicSessions.setActive("topic-2");
  };

  await env.scheduler.tick();

  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.channelId),
    ["topic-1"],
  );
  assert.equal(env.topicSessions.get("topic-1")?.state, "waiting");
  assert.equal(env.topicSessions.get("topic-2")?.state, "active");
});

test("再同期: Bot が参加していない（抜けた）サーバーは一覧を取らず、log も出さない", async (t) => {
  const env = setup(t);
  layout(env);
  env.createAt("topic-a", NOW);
  env.gateway.joined = new Set();

  await env.scheduler.tick();

  assert.deepEqual(env.gateway.listed, []);
  assert.deepEqual(env.channelOps.moves, []);
  assert.deepEqual(env.logs, []);
});

test("dev ログ: tick ごとに、今日（TZ）から残す日数より前の日付のファイルだけを消し、名前の違うファイルは残す", async (t) => {
  const env = setup(t);
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const names = [
    "2026-08-01.jsonl",
    "2026-09-01.jsonl",
    "2026-09-02.jsonl",
    "2026-10-02.jsonl",
    "notes.txt",
    "2026-08-01.jsonl.bak",
    "2026-8-1.jsonl",
  ];
  for (const name of names) writeFileSync(join(dir, name), "{}\n");
  mkdirSync(join(dir, "old"));
  env.devLogs.prune = () => pruneDevLogs(dir, env.clock.now, "Asia/Tokyo", 30);

  // 東京の 2026-10-01 23:59:59 → 2026-09-01 までを残す
  env.clock.now = new Date("2026-10-01T14:59:59.000Z");
  await env.scheduler.tick();
  assert.deepEqual(readdirSync(dir).sort(), names.filter((name) => name !== "2026-08-01.jsonl").concat("old").sort());

  // 東京の 2026-10-02 00:00 → 2026-09-02 より前を消す
  env.clock.now = new Date("2026-10-01T15:00:00.000Z");
  await env.scheduler.tick();
  assert.deepEqual(
    readdirSync(dir).sort(),
    ["2026-09-02.jsonl", "2026-10-02.jsonl", "notes.txt", "2026-08-01.jsonl.bak", "2026-8-1.jsonl", "old"].sort(),
  );
  assert.deepEqual(env.logs, []);
});

test("dev ログ: 消すのに失敗しても log に出すだけ（中身・パスは出さない）で、#inbox の切り替えは行う", async (t) => {
  const env = setup(t);
  env.devLogs.prune = () => {
    throw new Error("EACCES: permission denied, unlink '/srv/data/devlog/2026-08-01.jsonl'");
  };

  await env.scheduler.tick();

  assert.deepEqual(env.logs, ["古い dev ログを消せませんでした"]);
  assert.equal(env.inboxRotator.calls.length, 1);
});
