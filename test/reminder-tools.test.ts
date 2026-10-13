import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { RunContext } from "../src/agent/runner.ts";
import {
  createReminderToolHandlers,
  REMINDER_LIMIT_MESSAGE,
  REMINDER_NO_CONTEXT_MESSAGE,
  REMINDER_PROMPT_IN_SESSION_MESSAGE,
  REMINDER_PROMPT_LIMIT_MESSAGE,
  REMINDER_SCHEDULED_MESSAGE,
  type ReminderSetArgs,
  type TextToolResult,
} from "../src/agent/tools.ts";
import { REMINDER_MAX_ACTIVE, REMINDER_PROMPT_MAX_ACTIVE } from "../src/store/reminders.ts";
import { createStores, tempDb } from "./helpers/db.ts";

const TZ = "Asia/Tokyo";
/** 2026-10-13(火) 09:00 JST */
const NOW = new Date("2026-10-13T00:00:00.000Z");
const INBOX: RunContext = { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" };
const SESSION: RunContext = { guildId: "guild-1", channelId: "topic-1", kind: "session" };

function setup(t: TestContext) {
  const { tasks, reminders } = createStores(tempDb(t), () => NOW);
  const logs: string[] = [];
  const deps = { reminders, log: (line: string) => logs.push(line), now: () => NOW };
  /** null は context の無いターン */
  const handlers = (context: RunContext | null = INBOX) =>
    createReminderToolHandlers(deps, tasks, TZ, context ?? undefined);
  return { tasks, reminders, logs, handlers };
}

function parse(result: TextToolResult): unknown {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

/** 入力の形ごとの結果（created は result・next・repeat だけ比べる） */
test("reminder_set: at・repeat・time・on の組み合わせごとの結果。next は曜日付き、repeat は日本語の表示", (t) => {
  const cases: Array<[label: string, args: Partial<ReminderSetArgs>, expected: object]> = [
    ["1 回だけ", { at: "2026-10-14 09:00" }, { result: "created", next: "2026-10-14(水) 09:00", repeat: null }],
    ["毎日", { repeat: "daily", time: "08:00" }, { result: "created", next: "2026-10-14(水) 08:00", repeat: "毎日 8:00" }],
    ["平日", { repeat: "weekdays", time: "09:30" }, { result: "created", next: "2026-10-13(火) 09:30", repeat: "平日 9:30" }],
    [
      "曜日（並べ直す）",
      { repeat: "weekly", time: "08:00", on: "wed,mon" },
      { result: "created", next: "2026-10-14(水) 08:00", repeat: "毎週 月・水 8:00" },
    ],
    [
      "末日",
      { repeat: "monthly", time: "09:00", on: "last" },
      { result: "created", next: "2026-10-31(土) 09:00", repeat: "毎月 末日 9:00" },
    ],
    ["at と repeat の両方", { at: "2026-10-14 09:00", repeat: "daily", time: "08:00" }, { result: "invalid_args" }],
    ["どちらも無い", {}, { result: "invalid_args" }],
    ["repeat に time が無い", { repeat: "daily" }, { result: "invalid_args" }],
    ["weekly に on が無い", { repeat: "weekly", time: "08:00" }, { result: "invalid_args" }],
    ["monthly の on の形が違う", { repeat: "monthly", time: "08:00", on: "32" }, { result: "invalid_args" }],
    ["repeat に task_id", { repeat: "daily", time: "08:00", task_id: 1 }, { result: "invalid_args" }],
    ["at と time", { at: "2026-10-14 09:00", time: "10:00" }, { result: "invalid_args" }],
    ["at と on", { at: "2026-10-14 09:00", on: "mon" }, { result: "invalid_args" }],
    ["text が空白だけ", { text: "   ", at: "2026-10-14 09:00" }, { result: "invalid_args" }],
    ["at の形が違う", { at: "2026/10/14 9:00" }, { result: "invalid_time" }],
    ["存在しない日付", { at: "2026-02-30 09:00" }, { result: "invalid_time" }],
    ["time の形が違う", { repeat: "daily", time: "25:00" }, { result: "invalid_time" }],
  ];
  for (const [label, args, expected] of cases) {
    const { handlers } = setup(t);
    const result = parse(handlers().reminderSet({ text: label, ...args })) as Record<string, unknown>;
    const picked = Object.fromEntries(Object.keys(expected).map((key) => [key, result[key]]));
    assert.deepEqual(picked, expected, label);
    if (result.result !== "created") assert.equal(typeof result.message, "string", label);
  }
});

test("reminder_set: created はこの run のサーバー・チャンネルに作り、id・kind・text・task を返す。log は id と種類だけ", (t) => {
  const { reminders, logs, handlers } = setup(t);

  assert.deepEqual(parse(handlers().reminderSet({ text: "毎朝のタスク", kind: "prompt", repeat: "daily", time: "08:00" })), {
    result: "created",
    id: 1,
    kind: "prompt",
    text: "毎朝のタスク",
    next: "2026-10-14(水) 08:00",
    repeat: "毎日 8:00",
    task: null,
  });
  const row = reminders.get(1);
  assert.deepEqual(
    row && { guildId: row.guildId, channelId: row.channelId, kind: row.kind, rule: row.rule, nextAt: row.nextAt, taskId: row.taskId },
    {
      guildId: "guild-1",
      channelId: "inbox-1",
      kind: "prompt",
      rule: "daily@08:00",
      nextAt: "2026-10-13T23:00:00.000Z",
      taskId: null,
    },
  );
  assert.deepEqual(logs, ["reminder_set: created（#1、prompt）"]);
});

test("reminder_set: at が今より 5 分以上前なら in_past（今の日時を返す）。5 分未満の過去なら作る", (t) => {
  const { reminders, handlers } = setup(t);

  assert.deepEqual(parse(handlers().reminderSet({ text: "a", at: "2026-10-13 08:55" })), {
    result: "in_past",
    now: "2026-10-13(火) 09:00",
    message: "その時刻は過ぎています。now を基準に時刻を確かめ、at を直してください",
  });
  assert.equal(reminders.countActive(), 0);
  const created = parse(handlers().reminderSet({ text: "a", at: "2026-10-13 08:56" })) as Record<string, unknown>;
  assert.deepEqual([created.result, created.next], ["created", "2026-10-13(火) 08:56"]);
});

test("reminder_set: 同じチャンネル・text・rule（1 回だけなら同じ時刻）の active があれば作らずに exists。別の時刻・別のチャンネルなら作る", (t) => {
  const { reminders, handlers } = setup(t);
  handlers().reminderSet({ text: "薬", at: "2026-10-14 09:00" });
  handlers().reminderSet({ text: "ゴミ出し", repeat: "weekly", time: "07:30", on: "mon" });

  assert.deepEqual(parse(handlers().reminderSet({ text: "薬", at: "2026-10-14 09:00" })), {
    result: "exists",
    id: 1,
    next: "2026-10-14(水) 09:00",
    repeat: null,
  });
  assert.deepEqual(parse(handlers().reminderSet({ text: "ゴミ出し", repeat: "weekly", time: "07:30", on: "mon" })), {
    result: "exists",
    id: 2,
    next: "2026-10-19(月) 07:30",
    repeat: "毎週 月 7:30",
  });
  assert.equal(reminders.countActive(), 2);

  assert.equal((parse(handlers().reminderSet({ text: "薬", at: "2026-10-14 21:00" })) as { result: string }).result, "created");
  // 同じ text・時刻でも、予約した依頼（prompt）は別のもの
  assert.equal(
    (parse(handlers().reminderSet({ text: "薬", at: "2026-10-14 09:00", kind: "prompt" })) as { result: string }).result,
    "created",
  );
  assert.equal(
    (parse(handlers({ ...INBOX, channelId: "tasks-1", kind: "tasks" }).reminderSet({ text: "薬", at: "2026-10-14 09:00" })) as {
      result: string;
    }).result,
    "created",
  );
});

test("reminder_set: task_id は open のタスクだけ。無ければ task_not_found、done・dropped なら task_closed で作らない", (t) => {
  const { tasks, reminders, handlers } = setup(t);
  tasks.add({ title: "電話する" });
  tasks.add({ title: "済んだ" });
  tasks.add({ title: "やめた" });
  tasks.complete(2);
  tasks.update(3, { status: "dropped" });
  const at = "2026-10-14 09:00";

  assert.deepEqual(parse(handlers().reminderSet({ text: "a", at, task_id: 99 })), { result: "task_not_found" });
  assert.deepEqual(parse(handlers().reminderSet({ text: "a", at, task_id: 2 })), { result: "task_closed" });
  assert.deepEqual(parse(handlers().reminderSet({ text: "a", at, task_id: 3 })), { result: "task_closed" });
  assert.equal(reminders.countActive(), 0);

  const created = parse(handlers().reminderSet({ text: "a", at, task_id: 1 })) as Record<string, unknown>;
  assert.deepEqual(created.task, { id: 1, title: "電話する" });
  assert.equal(reminders.get(1)?.taskId, 1);
});

test("reminder_set: active が 50 件なら limit。prompt は active の prompt が 5 件なら limit で、notify は作れる", (t) => {
  const cases: Array<[label: string, fill: { notify: number; prompt: number }, kind: "notify" | "prompt", expected: object]> = [
    ["全体の上限", { notify: REMINDER_MAX_ACTIVE, prompt: 0 }, "notify", { result: "limit", message: REMINDER_LIMIT_MESSAGE }],
    [
      "prompt の上限",
      { notify: 0, prompt: REMINDER_PROMPT_MAX_ACTIVE },
      "prompt",
      { result: "limit", message: REMINDER_PROMPT_LIMIT_MESSAGE },
    ],
    ["prompt が上限でも notify は作れる", { notify: 0, prompt: REMINDER_PROMPT_MAX_ACTIVE }, "notify", { result: "created" }],
  ];
  for (const [label, fill, kind, expected] of cases) {
    const { reminders, handlers } = setup(t);
    for (const [fillKind, count] of [["notify", fill.notify], ["prompt", fill.prompt]] as const) {
      for (let i = 0; i < count; i++) {
        reminders.add({ guildId: "guild-1", channelId: "inbox-1", kind: fillKind, text: `${fillKind}${i}`, nextAt: NOW });
      }
    }
    const result = parse(handlers().reminderSet({ text: "new", kind, at: "2026-10-14 09:00" })) as Record<string, unknown>;
    assert.deepEqual(
      Object.fromEntries(Object.keys(expected).map((key) => [key, result[key]])),
      expected,
      label,
    );
  }
});

test("reminder_set: context が無い・予約した依頼のターン・セッションのチャンネルでの prompt は not_available。セッションでも notify は作れる", (t) => {
  const { reminders, logs, handlers } = setup(t);
  const args = { text: "a", at: "2026-10-14 09:00" };
  const cases: Array<[label: string, context: RunContext | null, kind: "notify" | "prompt", message: string]> = [
    ["context なし", null, "notify", REMINDER_NO_CONTEXT_MESSAGE],
    ["予約した依頼のターン", { ...INBOX, scheduled: true }, "notify", REMINDER_SCHEDULED_MESSAGE],
    ["セッションで prompt", SESSION, "prompt", REMINDER_PROMPT_IN_SESSION_MESSAGE],
  ];
  for (const [label, context, kind, message] of cases) {
    assert.deepEqual(parse(handlers(context).reminderSet({ ...args, kind })), { result: "not_available", message }, label);
  }
  assert.equal(reminders.countActive(), 0);
  assert.deepEqual(logs, []);

  assert.equal((parse(handlers(SESSION).reminderSet(args)) as { result: string }).result, "created");
  assert.equal(reminders.get(1)?.channelId, "topic-1");

  // 止めるのも、オーナーが見ていないターンではできない
  for (const [label, context, message] of [
    ["context なし", null, REMINDER_NO_CONTEXT_MESSAGE],
    ["予約した依頼のターン", { ...INBOX, scheduled: true }, REMINDER_SCHEDULED_MESSAGE],
  ] as const) {
    assert.deepEqual(parse(handlers(context).reminderCancel({ id: 1 })), { result: "not_available", message }, label);
  }
  assert.equal(reminders.get(1)?.status, "active");
});

test("reminder_list: active を次に知らせる順（スヌーズが早ければその時刻）に、id・kind・text・next・repeat・task_id・channel で返す", (t) => {
  const { reminders, handlers } = setup(t);
  const base = { guildId: "guild-1", channelId: "inbox-1", kind: "notify" as const };
  reminders.add({ ...base, text: "あとの 1 回", nextAt: new Date("2026-10-15T00:00:00Z") });
  reminders.add({ ...base, kind: "prompt", text: "毎朝", rule: "daily@08:00", nextAt: new Date("2026-10-13T23:00:00Z") });
  reminders.add({ ...base, channelId: "topic-1", text: "スヌーズ", taskId: 4, nextAt: new Date("2026-10-16T00:00:00Z") });
  reminders.snooze(3, new Date("2026-10-13T00:10:00Z"));
  reminders.cancel(reminders.add({ ...base, text: "止めた", nextAt: NOW }).id);

  assert.deepEqual(parse(handlers(null).reminderList()), {
    reminders: [
      { id: 3, kind: "notify", text: "スヌーズ", next: "2026-10-13(火) 09:10", repeat: null, task_id: 4, channel: "<#topic-1>" },
      { id: 2, kind: "prompt", text: "毎朝", next: "2026-10-14(水) 08:00", repeat: "毎日 8:00", task_id: null, channel: "<#inbox-1>" },
      { id: 1, kind: "notify", text: "あとの 1 回", next: "2026-10-15(木) 09:00", repeat: null, task_id: null, channel: "<#inbox-1>" },
    ],
  });
});

test("reminder_cancel: 止める・繰り返しの次の 1 回を飛ばす。無い id・active でない・1 回だけに skip_next はその旨を返して何も変えない", (t) => {
  const { reminders, logs, handlers } = setup(t);
  const base = { guildId: "guild-1", channelId: "inbox-1", kind: "notify" as const };
  reminders.add({ ...base, text: "薬", nextAt: new Date("2026-10-14T00:00:00Z") });
  // 毎週 月・水 8:00。次は 10/14(水)
  reminders.add({ ...base, text: "ゴミ出し", rule: "weekly:mon,wed@08:00", nextAt: new Date("2026-10-13T23:00:00Z") });
  const h = handlers();

  assert.deepEqual(parse(h.reminderCancel({ id: 2, skip_next: true })), { result: "skipped", id: 2, next: "2026-10-19(月) 08:00" });
  assert.equal(reminders.get(2)?.nextAt, "2026-10-18T23:00:00.000Z");
  assert.deepEqual(parse(h.reminderCancel({ id: 1, skip_next: true })), { result: "not_repeating" });
  assert.deepEqual(parse(h.reminderCancel({ id: 1 })), { result: "cancelled", id: 1, text: "薬" });
  assert.equal(reminders.get(1)?.status, "cancelled");
  assert.deepEqual(parse(h.reminderCancel({ id: 1 })), { result: "not_active" });
  assert.deepEqual(parse(h.reminderCancel({ id: 1, skip_next: true })), { result: "not_active" });
  assert.deepEqual(parse(h.reminderCancel({ id: 99 })), { result: "not_found" });
  assert.equal(reminders.get(2)?.status, "active");
  assert.deepEqual(logs, ["reminder_cancel: skipped（#2）", "reminder_cancel: cancelled（#1）"]);
});
