import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import type { RunResult } from "../src/agent/runner.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { MAX_TURNS_REPLY } from "../src/app/commands/turn-controls.ts";
import { buildTurnPrompt } from "../src/app/prompt.ts";
import {
  MOVED_NOTE,
  REMINDER_BATCH_LIMIT,
  REMINDER_MAX_ATTEMPTS,
  REMINDER_TICK_OFFSET_MS,
  reminderFireButtons,
  ReminderScheduler,
  type ReminderTimers,
  scheduledFailureText,
} from "../src/app/reminders.ts";
import type { OutgoingMessage } from "../src/discord/gateway.ts";
import type { NewReminder } from "../src/store/reminders.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingQueue } from "./helpers/recording.ts";
import { FakeRunner, type FakeRunStep, turnUsage } from "./helpers/runner.ts";

/** 2026-10-13(火) 9:00 JST */
const NOW = new Date("2026-10-13T00:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

class FakeTimers implements ReminderTimers {
  entries: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];

  after(fn: () => void, ms: number): () => void {
    const entry = { fn, ms, cancelled: false };
    this.entries.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  /** 最後に張られたタイマー */
  last(): { fn: () => void; ms: number; cancelled: boolean } | undefined {
    return this.entries.at(-1);
  }
}

function okResult(text: string): RunResult {
  return {
    ok: true,
    text,
    sessionId: "session-1",
    usage: turnUsage(10, 2000, 300),
    durationMs: 4200,
    toolCalls: 1,
    contextTokens: 900,
  };
}

/**
 * ch-1 が頼んだチャンネル。guild-1 は /setup 済み（#tasks は tasks-1、#inbox は inbox-1）。どれも Discord 上にある。
 * steps は予約した依頼のターンの偽 Runner の結果
 */
function setup(t: TestContext, steps: FakeRunStep[] = []) {
  const db = tempDb(t);
  const clock = { now: NOW };
  const stores = createStores(db, () => clock.now);
  const { reminders, tasks, guildSettings, topicSessions } = stores;
  guildSettings.setChannel("guild-1", "tasksChannelId", "tasks-1");
  guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  const gateway = new FakeGateway({
    allow: ["sendMessage", "editMessage", "send", "startTyping"],
    record: ["channelExists"],
  });
  for (const channelId of ["ch-1", "tasks-1", "inbox-1"]) gateway.alive.add(channelId);
  const timers = new FakeTimers();
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const runner = new FakeRunner(steps);
  const turnQueue = new RecordingQueue(2);
  const scheduler = new ReminderScheduler({
    cfg: { ownerUserId: "owner-1", timeZone: "Asia/Tokyo" },
    reminders,
    tasks,
    guildSettings,
    topicSessions,
    gateway,
    resolveChannel: createChannelResolver({ inboxChannelId: undefined }, guildSettings, topicSessions),
    turnQueue,
    turn: { ...stores, runner, log },
    now: () => clock.now,
    timers,
    log,
  });
  const add = (overrides: Partial<NewReminder> = {}) =>
    reminders.add({ guildId: "guild-1", channelId: "ch-1", kind: "notify", text: "薬を飲む", nextAt: NOW, ...overrides });
  /** 送れた投稿の [チャンネル, 本文] */
  const posted = (): Array<[string, string]> => gateway.posts.map(({ channelId, message }) => [channelId, message.text]);
  return { ...stores, db, clock, gateway, timers, logs, runner, turnQueue, scheduler, add, posted };
}

test("start: 直後に 1 回 tick し、以後は次の分の境目 + 200ms に張り直す。stop で取り消し、その後の start・tick は何もしない", async (t) => {
  const env = setup(t);
  env.clock.now = new Date(NOW.getTime() + 30_500);
  env.add();

  env.scheduler.start();
  await env.scheduler.idle();
  assert.equal(env.posted().length, 1);
  assert.equal(env.timers.last()?.ms, 29_500 + REMINDER_TICK_OFFSET_MS);

  // 境目 + 200ms に呼ばれたら、次も 1 分後の境目 + 200ms
  env.clock.now = new Date(NOW.getTime() + MINUTE_MS + REMINDER_TICK_OFFSET_MS);
  env.add({ nextAt: new Date(NOW.getTime() + MINUTE_MS) });
  env.timers.last()!.fn();
  await env.scheduler.idle();
  assert.equal(env.posted().length, 2);
  assert.equal(env.timers.entries.length, 2);
  assert.equal(env.timers.last()?.ms, MINUTE_MS);

  env.scheduler.stop();
  assert.equal(env.timers.last()?.cancelled, true);
  env.add();
  env.scheduler.start();
  await env.scheduler.tick();
  assert.equal(env.posted().length, 2);
  assert.equal(env.timers.entries.length, 2);
});

test("notify: オーナーだけをメンションしてボタン付きで 1 回出し、fire_seq を 1 増やす。同じ tick をもう一度呼んでも出ない", async (t) => {
  const env = setup(t);
  const once = env.add();
  const daily = env.add({ text: "ゴミ出し", rule: "weekly:mon,tue@09:00" });

  await env.scheduler.tick();
  await env.scheduler.tick();

  assert.deepEqual(
    env.gateway.posts.map((post) => post.message),
    [
      {
        text: "リマインド: 薬を飲む",
        components: [{ kind: "buttons", buttons: reminderFireButtons(once, 1) }],
        mentionUserId: "owner-1",
      },
      {
        text: "リマインド: ゴミ出し\n（毎週 月・火 9:00）",
        components: [{ kind: "buttons", buttons: reminderFireButtons(daily, 1) }],
        mentionUserId: "owner-1",
      },
    ] satisfies OutgoingMessage[],
  );
  assert.deepEqual(
    reminderFireButtons(daily, 1).map((button) => [button.customId, button.label, button.style]),
    [
      [`rem:done:${daily.id}:1`, "済んだ", "success"],
      [`rem:snooze:10:${daily.id}:1`, "10 分後", undefined],
      [`rem:snooze:60:${daily.id}:1`, "1 時間後", undefined],
      [`rem:stop:${daily.id}:1`, "止める", "danger"],
    ],
  );
  assert.deepEqual(
    reminderFireButtons(once, 1).map((button) => button.label),
    ["完了", "10 分後", "1 時間後"],
  );
  const fired = env.reminders.get(once.id)!;
  assert.deepEqual([fired.status, fired.fireSeq, fired.nextAt, fired.lastMessageId], ["fired", 1, null, "message-1"]);
  const repeated = env.reminders.get(daily.id)!;
  // 次は 10/19(月) 9:00
  assert.deepEqual([repeated.status, repeated.fireSeq, repeated.nextAt], ["active", 1, "2026-10-19T00:00:00.000Z"]);
  assert.equal(env.logs.length, 2);
  for (const line of env.logs) assert.ok(!line.includes("ch-1") && !line.includes("薬") && !line.includes("owner-1"), line);
});

test("止まっていた間に過ぎた回: 1 回だけは遅れの注記付きで 1 回、繰り返しは最後の 1 回と「ほか n 回分」、12 時間より古ければ出さずに次の回へ", async (t) => {
  const cases: Array<{ label: string; reminder: Partial<NewReminder>; text: string | null; nextAt: string | null }> = [
    { label: "4 分遅れ", reminder: { nextAt: ago(4 * MINUTE_MS) }, text: "リマインド: 薬を飲む", nextAt: null },
    {
      label: "25 分遅れ",
      reminder: { nextAt: ago(25 * MINUTE_MS) },
      text: "リマインド: 薬を飲む\n（8:35 の予定・25 分遅れ）",
      nextAt: null,
    },
    {
      label: "1 日以上",
      reminder: { nextAt: ago(26 * HOUR_MS) },
      text: "リマインド: 薬を飲む\n（10/12(月) 7:00 の予定でした）",
      nextAt: null,
    },
    {
      label: "繰り返しで 3 回過ぎた",
      reminder: { rule: "daily@09:00", nextAt: ago(2 * DAY_MS) },
      text: "リマインド: 薬を飲む\n（毎日 9:00）\n（ほか 2 回分は止まっていた間に過ぎました）",
      nextAt: "2026-10-14T00:00:00.000Z",
    },
    {
      label: "繰り返しの最後の回が 13 時間前",
      reminder: { rule: "daily@20:00", nextAt: ago(13 * HOUR_MS) },
      text: null,
      nextAt: "2026-10-13T11:00:00.000Z",
    },
  ];
  for (const { label, reminder, text, nextAt } of cases) {
    const env = setup(t);
    const added = env.add(reminder);
    await env.scheduler.tick();
    assert.deepEqual(env.posted(), text === null ? [] : [["ch-1", text]], label);
    const after = env.reminders.get(added.id)!;
    assert.equal(after.nextAt, nextAt, label);
    assert.equal(after.fireSeq, text === null ? 0 : 1, label);
    if (text === null) assert.ok(env.logs.some((line) => line.includes("飛ばしました")), label);
  }
});

test("スヌーズの回は「（もう一度）」を付けて出し直し、前の回のメッセージのボタンを外す（本文は DB から作り直し、メンションなし）", async (t) => {
  const env = setup(t);
  const task = env.tasks.add({ title: "洗濯物を取り込む" });
  const added = env.add({ nextAt: ago(HOUR_MS), taskId: task.id });
  env.reminders.markFired(added.id, 0, { nextAt: null, status: "fired", firedAt: ago(HOUR_MS), messageId: "old-1" });
  env.reminders.snooze(added.id, ago(MINUTE_MS));

  await env.scheduler.tick();

  const base = `リマインド: 薬を飲む\n（#${task.id} 洗濯物を取り込む）`;
  assert.deepEqual(env.posted(), [["ch-1", `${base}\n（もう一度）`]]);
  assert.deepEqual(env.gateway.posts[0]?.message.components, [
    { kind: "buttons", buttons: reminderFireButtons(added, 2) },
  ]);
  assert.deepEqual(env.gateway.edits, [{ channelId: "ch-1", messageId: "old-1", message: { text: base, components: [] } }]);
  const after = env.reminders.get(added.id)!;
  assert.deepEqual([after.status, after.fireSeq, after.snoozeAt, after.lastMessageId], ["fired", 2, null, "message-1"]);
});

test("紐づけたタスクが open でなければ投稿せずに done にする", async (t) => {
  const env = setup(t);
  const task = env.tasks.add({ title: "買い物" });
  env.tasks.complete(task.id);
  const linked = env.add({ taskId: task.id });

  await env.scheduler.tick();

  assert.deepEqual(env.posted(), []);
  assert.equal(env.reminders.get(linked.id)?.status, "done");
  assert.ok(env.logs.some((line) => line.includes("タスクが閉じている")), env.logs.join("\n"));
});

test("投稿に失敗したら DB を変えずに次の tick でやり直し、同じ回で 30 回失敗したら諦めて進める", async (t) => {
  const env = setup(t);
  const added = env.add();
  let failing = true;
  env.gateway.beforeSendMessage = () => {
    if (failing) throw new Error("Service Unavailable");
  };

  await env.scheduler.tick();
  assert.deepEqual(env.reminders.get(added.id), added);
  failing = false;
  await env.scheduler.tick();
  assert.equal(env.posted().length, 1);
  assert.equal(env.reminders.get(added.id)?.status, "fired");

  failing = true;
  const other = env.add({ text: "電話する" });
  for (let i = 1; i < REMINDER_MAX_ATTEMPTS; i++) await env.scheduler.tick();
  assert.equal(env.reminders.get(other.id)?.status, "active");
  await env.scheduler.tick();
  assert.equal(env.reminders.get(other.id)?.status, "done");
  assert.ok(env.logs.some((line) => line.includes(`${REMINDER_MAX_ATTEMPTS} 回失敗`)), env.logs.join("\n"));
});

test("投稿先: 頼んだチャンネルが無ければ #tasks、それも無ければ #inbox に注記付きで出して以後もそこへ。どれも無ければ log だけで進める", async (t) => {
  const cases: Array<{ label: string; missing: string[]; deletedSession?: boolean; channel: string | null; checked: string[] }> = [
    { label: "#tasks へ", missing: ["ch-1"], channel: "tasks-1", checked: ["ch-1"] },
    { label: "#inbox へ", missing: ["ch-1", "tasks-1"], channel: "inbox-1", checked: ["ch-1", "tasks-1"] },
    // 削除済みのセッションには投稿しようとしない
    { label: "削除済みのセッション", missing: [], deletedSession: true, channel: "tasks-1", checked: [] },
    { label: "どれも無い", missing: ["ch-1", "tasks-1", "inbox-1"], channel: null, checked: ["ch-1", "tasks-1", "inbox-1"] },
  ];
  for (const { label, missing, deletedSession, channel, checked } of cases) {
    const env = setup(t);
    if (deletedSession === true) {
      env.topicSessions.create({ channelId: "ch-1", guildId: "guild-1", title: "旅行", categoryId: "done-1" });
      env.topicSessions.markDeleted("ch-1");
    }
    for (const channelId of missing) env.gateway.alive.delete(channelId);
    env.gateway.beforeSendMessage = (channelId) => {
      if (!env.gateway.alive.has(channelId) || (deletedSession === true && channelId === "ch-1")) {
        throw new Error("Unknown Channel");
      }
    };
    const added = env.add();

    await env.scheduler.tick();

    assert.deepEqual(env.gateway.callsOf("channelExists").map((call) => (call.method === "channelExists" ? call.channelId : "")), checked, label);
    const after = env.reminders.get(added.id)!;
    if (channel === null) {
      assert.deepEqual(env.posted(), [], label);
      assert.equal(after.status, "done", label);
      assert.ok(env.logs.some((line) => line.includes("投稿先が無い") && line.includes("guild-1")), label);
    } else {
      assert.deepEqual(env.posted(), [[channel, `リマインド: 薬を飲む\n${MOVED_NOTE}`]], label);
      assert.deepEqual([after.channelId, after.status], [channel, "fired"], label);
    }
  }
});

test("あるチャンネルへの投稿に失敗したら（権限など）次の候補へ移らず、次の tick でやり直す", async (t) => {
  const env = setup(t);
  env.gateway.beforeSendMessage = (channelId) => {
    if (channelId === "ch-1") throw new Error("Missing Access");
  };
  const added = env.add();

  await env.scheduler.tick();

  assert.deepEqual(env.posted(), []);
  assert.deepEqual(env.reminders.get(added.id), added);
  assert.ok(env.logs.some((line) => line.includes("Missing Access")), env.logs.join("\n"));
});

test("繰り返しの新しい回を出したら、前の回のメッセージのボタンを外す。外すのに失敗しても log だけ", async (t) => {
  const env = setup(t);
  env.add({ text: "ゴミ出し", rule: "daily@09:00" });
  await env.scheduler.tick();
  env.clock.now = new Date(NOW.getTime() + DAY_MS);
  env.gateway.beforeEdit = () => {
    throw new Error("Unknown Message");
  };
  await env.scheduler.tick();
  assert.equal(env.posted().length, 2);
  assert.ok(env.logs.some((line) => line.includes("Unknown Message")), env.logs.join("\n"));

  env.gateway.beforeEdit = () => {};
  env.clock.now = new Date(NOW.getTime() + 2 * DAY_MS);
  await env.scheduler.tick();
  assert.deepEqual(env.gateway.edits, [
    { channelId: "ch-1", messageId: "message-2", message: { text: "リマインド: ゴミ出し\n（毎日 9:00）", components: [] } },
  ]);
});

test("投稿している間に止められたら記録せず、いま投稿したメッセージのボタンを外す", async (t) => {
  const env = setup(t);
  const added = env.add();
  env.gateway.beforeSendMessage = () => {
    env.reminders.cancel(added.id);
  };

  await env.scheduler.tick();

  const after = env.reminders.get(added.id)!;
  assert.deepEqual([after.status, after.fireSeq, after.lastMessageId], ["cancelled", 0, null]);
  assert.deepEqual(env.gateway.edits, [
    { channelId: "ch-1", messageId: "message-1", message: { text: "リマインド: 薬を飲む", components: [] } },
  ]);
});

test("1 tick で 20 件まで。idle は実行中の投稿を待ち、stop の後はまだ始めていない発火を行わない", async (t) => {
  const env = setup(t);
  for (let i = 0; i < REMINDER_BATCH_LIMIT + 1; i++) env.add({ text: `件 ${i}` });
  await env.scheduler.tick();
  assert.equal(env.posted().length, REMINDER_BATCH_LIMIT);
  await env.scheduler.tick();
  assert.equal(env.posted().length, REMINDER_BATCH_LIMIT + 1);

  const gated = setup(t);
  gated.add({ text: "1 件目" });
  gated.add({ text: "2 件目" });
  let release = (): void => {};
  gated.gateway.beforeSendMessage = () => new Promise<void>((resolve) => (release = resolve));
  const running = gated.scheduler.tick();
  await flush();
  assert.equal(gated.scheduler.tick(), running);
  let idle = false;
  const waiting = gated.scheduler.idle().then(() => {
    idle = true;
  });
  gated.scheduler.stop();
  await flush();
  assert.equal(idle, false);

  release();
  await Promise.all([running, waiting]);
  assert.deepEqual(gated.posted(), [["ch-1", "リマインド: 1 件目"]]);
});

test("前の件を投稿している間に止められた後ろの件は、同じ tick で出さない", async (t) => {
  const env = setup(t);
  env.add({ text: "先" });
  const later = env.add({ text: "後" });
  env.gateway.beforeSendMessage = () => {
    env.reminders.cancel(later.id);
  };

  await env.scheduler.tick();

  assert.deepEqual(env.posted(), [["ch-1", "リマインド: 先"]]);
  assert.equal(env.reminders.get(later.id)?.status, "cancelled");
});

test("古いスヌーズ: 12 時間で飛ばした繰り返しは前のスヌーズも消え、繰り返しのスヌーズだけが古くても出さない。1 回だけのスヌーズは遅れの注記付きで出す", async (t) => {
  const cases: Array<{ label: string; reminder: Partial<NewReminder>; snoozeAt: Date; text: string | null }> = [
    { label: "規則の回を飛ばした", reminder: { rule: "daily@20:00", nextAt: ago(13 * HOUR_MS) }, snoozeAt: ago(36 * HOUR_MS), text: null },
    { label: "繰り返しのスヌーズだけが古い", reminder: { rule: "daily@20:00", nextAt: new Date(NOW.getTime() + 2 * HOUR_MS) }, snoozeAt: ago(13 * HOUR_MS), text: null },
    {
      label: "1 回だけのスヌーズが 2 日前",
      reminder: { nextAt: ago(3 * DAY_MS) },
      snoozeAt: ago(2 * DAY_MS),
      text: "リマインド: 薬を飲む\n（もう一度）\n（10/11(日) 9:00 の予定でした）",
    },
  ];
  for (const { label, reminder, snoozeAt, text } of cases) {
    const env = setup(t);
    const added = env.add(reminder);
    if (reminder.rule === undefined) {
      env.reminders.markFired(added.id, 0, { nextAt: null, status: "fired", firedAt: ago(3 * DAY_MS), messageId: "old-1" });
    }
    env.reminders.snooze(added.id, snoozeAt);
    await env.scheduler.tick();
    await env.scheduler.tick();
    assert.deepEqual(env.posted(), text === null ? [] : [["ch-1", text]], label);
    if (text === null) assert.equal(env.reminders.get(added.id)?.snoozeAt, null, label);
  }
});

test("prompt: 先に claim で進めてから、実行先の key で turnQueue に入れ、その会話で 1 回動かして返答をメンションと注記付きで送る", async (t) => {
  const cases: Array<{
    label: string;
    reminder: Partial<NewReminder>;
    channel: string;
    kind: "inbox" | "tasks";
    repeat: string;
    after: { status: string; nextAt: string | null };
  }> = [
    {
      label: "#inbox の 1 回だけ",
      reminder: { channelId: "inbox-1" },
      channel: "inbox-1",
      kind: "inbox",
      repeat: "1 回だけ",
      after: { status: "done", nextAt: null },
    },
    {
      label: "#tasks の繰り返し",
      reminder: { channelId: "tasks-1", rule: "daily@09:00" },
      channel: "tasks-1",
      kind: "tasks",
      repeat: "毎日 9:00",
      after: { status: "active", nextAt: "2026-10-14T00:00:00.000Z" },
    },
    // 頼んだチャンネルが #inbox・#tasks でなくなっていたら #tasks で動かす
    {
      label: "#inbox・#tasks でない",
      reminder: {},
      channel: "tasks-1",
      kind: "tasks",
      repeat: "1 回だけ",
      after: { status: "done", nextAt: null },
    },
  ];
  for (const { label, reminder, channel, kind, repeat, after } of cases) {
    const env = setup(t, [
      (input) => {
        // ターンを動かす時点で DB は進めてある
        assert.equal(env.reminders.get(added.id)?.fireSeq, 1, label);
        assert.equal(input.context?.channelId, channel, label);
        return okResult("今日のタスクは 3 件です");
      },
    ]);
    const added = env.add({ kind: "prompt", text: "今日のタスクを出して", ...reminder });

    await env.scheduler.tick();
    await env.scheduler.idle();

    assert.deepEqual(env.turnQueue.keys, [channel], label);
    assert.deepEqual(env.turnQueue.options, [undefined], label);
    assert.deepEqual(
      env.runner.inputs,
      [
        {
          prompt: buildTurnPrompt(`予約した依頼（#${added.id}・${repeat}）:\n今日のタスクを出して`, NOW, "Asia/Tokyo", kind),
          sessionId: undefined,
          context: { guildId: "guild-1", channelId: channel, kind, scheduled: true },
          allowedUrls: [],
        },
      ],
      label,
    );
    assert.deepEqual(
      env.gateway.sent,
      [
        {
          channelId: channel,
          text: `今日のタスクは 3 件です\n（予約した依頼 #${added.id}）`,
          replyToId: undefined,
          mentionUserId: "owner-1",
        },
      ],
      label,
    );
    assert.deepEqual([env.gateway.typingStarted, env.gateway.typingStopped], [1, 1], label);
    assert.equal(env.usage.recent(10).length, 1, label);
    // 予約した依頼のターンの種類のラベルには -scheduled を付ける
    assert.equal(env.usage.recent(10)[0]?.kind, `${kind}-scheduled`, label);
    assert.deepEqual(env.posted(), [], label);
    const stored = env.reminders.get(added.id)!;
    assert.deepEqual({ status: stored.status, nextAt: stored.nextAt }, after, label);
  }
});

test("prompt: 失敗してもやり直さず、失敗の知らせ（手順の上限なら MAX_TURNS_REPLY）をメンション付きで送る", async (t) => {
  const failure = (errorMessage: string): RunResult => ({ ok: false, errorMessage, toolCalls: 0, sessionRecorded: false });
  const cases: Array<{ label: string; step: FakeRunStep; text: (id: number) => string }> = [
    { label: "失敗", step: failure("timeout"), text: scheduledFailureText },
    { label: "手順の上限", step: failure("error_max_turns: 8"), text: () => MAX_TURNS_REPLY },
    { label: "例外", step: new Error("spawn failed"), text: scheduledFailureText },
  ];
  for (const { label, step, text } of cases) {
    const env = setup(t, [step]);
    const added = env.add({ kind: "prompt", channelId: "inbox-1", text: "今日のタスクを出して" });

    await env.scheduler.tick();
    await env.scheduler.idle();
    await env.scheduler.tick();
    await env.scheduler.idle();

    assert.equal(env.runner.inputs.length, 1, label);
    assert.deepEqual(
      env.gateway.sent,
      [{ channelId: "inbox-1", text: text(added.id), replyToId: undefined, mentionUserId: "owner-1" }],
      label,
    );
    assert.equal(env.reminders.get(added.id)?.status, "done", label);
    assert.ok(env.logs.some((line) => line.includes("失敗しました")), label);
  }
});

test("prompt: tick はターンを待たない。同じ id のターンが走っている間は重ねず、idle は返信まで待ち、停止の後は新しく始めない", async (t) => {
  const env = setup(t, [okResult("おはようございます"), okResult("次の日")]);
  const added = env.add({ kind: "prompt", channelId: "inbox-1", text: "今日のタスクを出して", rule: "daily@09:00" });
  let release = (): void => {};
  env.runner.gates[0] = new Promise<void>((resolve) => (release = resolve));

  await env.scheduler.tick();
  await flush();
  assert.equal(env.runner.inputs.length, 1);
  assert.deepEqual(env.gateway.sent, []);

  // 次の回が来ても、走っている間は claim も実行もしない
  env.clock.now = new Date(NOW.getTime() + DAY_MS);
  await env.scheduler.tick();
  assert.equal(env.reminders.get(added.id)?.fireSeq, 1);
  assert.deepEqual(env.turnQueue.keys, ["inbox-1"]);

  let idle = false;
  const waiting = env.scheduler.idle().then(() => {
    idle = true;
  });
  await flush();
  assert.equal(idle, false);
  release();
  await waiting;
  assert.equal(env.gateway.sent.length, 1);

  env.scheduler.stop();
  await env.scheduler.tick();
  await env.scheduler.idle();
  assert.equal(env.runner.inputs.length, 1);
  assert.equal(env.reminders.get(added.id)?.fireSeq, 1);
});

test("prompt: キューで待っている間に停止・cancel されたら claim せずに動かさず、実行先が無ければこの回を進めるだけ。遅れたら prompt に遅れを書く", async (t) => {
  const waitCases: Array<{ label: string; act: (env: ReturnType<typeof setup>, id: number) => void; fireSeq: number }> = [
    { label: "停止", act: (env) => env.scheduler.stop(), fireSeq: 0 },
    { label: "cancel", act: (env, id) => env.reminders.cancel(id), fireSeq: 0 },
  ];
  for (const { label, act, fireSeq } of waitCases) {
    const env = setup(t, [okResult("動いた")]);
    const added = env.add({ kind: "prompt", channelId: "inbox-1", text: "今日のタスクを出して" });
    // 同じ key の発言のターンが走っている間は、予約した依頼はキューで待つ
    let release = (): void => {};
    const busy = env.turnQueue.run("inbox-1", () => new Promise<void>((resolve) => (release = resolve)));
    await env.scheduler.tick();
    act(env, added.id);
    release();
    await busy;
    await env.scheduler.idle();
    assert.equal(env.runner.inputs.length, 0, label);
    assert.equal(env.reminders.get(added.id)?.fireSeq, fireSeq, label);
    assert.deepEqual(env.gateway.sent, [], label);
  }

  // /setup していないサーバー（#tasks も #inbox も無い）
  const nowhere = setup(t);
  const once = nowhere.add({ kind: "prompt", guildId: "guild-2", text: "今日のタスクを出して" });
  await nowhere.scheduler.tick();
  await nowhere.scheduler.idle();
  assert.deepEqual([nowhere.runner.inputs.length, nowhere.turnQueue.keys.length], [0, 0]);
  assert.equal(nowhere.reminders.get(once.id)?.status, "done");

  const late = setup(t, [okResult("おはようございます")]);
  const daily = late.add({ kind: "prompt", channelId: "inbox-1", text: "今日のタスクを出して", rule: "daily@08:00", nextAt: ago(HOUR_MS) });
  await late.scheduler.tick();
  await late.scheduler.idle();
  assert.equal(
    late.runner.inputs[0]?.prompt,
    buildTurnPrompt(`予約した依頼（#${daily.id}・毎日 8:00・8:00 の予定から 60 分遅れ）:\n今日のタスクを出して`, NOW, "Asia/Tokyo", "inbox"),
  );
});
