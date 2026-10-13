import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { STALE_TEXT } from "../src/app/commands/delete.ts";
import {
  createRemindersCommand,
  createRemindersComponent,
  NO_REMINDERS_TEXT,
  reminderDetailMessage,
  type RemindersDeps,
} from "../src/app/commands/reminders.ts";
import { STALE_TURN_REPLY } from "../src/app/commands/turn-controls.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import type { NewReminder } from "../src/store/reminders.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";

/** 2026-10-13(火) 9:25 JST */
const NOW = new Date("2026-10-13T00:25:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const BASE = { guildId: "guild-1", channelId: "ch-1", userId: "owner-1", createdAt: NOW };
const STALE_REPLY: ResponderCall[] = [{ method: "reply", message: { text: STALE_TURN_REPLY, ephemeral: true } }];

function press(customId: string): Extract<Interaction, { kind: "button" }> {
  return { ...BASE, kind: "button", customId, messageId: "message-1" };
}

function setup(t: TestContext) {
  const { reminders, tasks } = createStores(tempDb(t), () => NOW);
  const logs: string[] = [];
  const deps: RemindersDeps = { reminders, tasks, cfg: { timeZone: "Asia/Tokyo" }, log: (line) => logs.push(line) };
  const component = createRemindersComponent(deps);
  const run = async (interaction: Exclude<Interaction, { kind: "command" }>): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await component.handle(interaction, responder);
    return responder.calls;
  };
  const add = (overrides: Partial<NewReminder> = {}) =>
    reminders.add({
      guildId: "guild-1",
      channelId: "ch-1",
      kind: "notify",
      text: "薬を飲む",
      nextAt: new Date(NOW.getTime() - HOUR_MS),
      ...overrides,
    });
  /** 知らせた後（fire_seq 1）の状態にする。1 回だけは fired、繰り返しは次の回を nextAt に */
  const fired = (overrides: Partial<NewReminder> = {}, nextAt: Date | null = null) => {
    const reminder = add(overrides);
    reminders.markFired(reminder.id, 0, {
      nextAt,
      status: nextAt === null ? "fired" : "active",
      firedAt: NOW,
      messageId: "message-1",
    });
    return reminders.get(reminder.id)!;
  };
  return { reminders, tasks, deps, logs, run, add, fired };
}

test("発火のボタン: 押すと状態を変え、本文を DB から作り直してボタンを外す", async (t) => {
  const tomorrow = new Date("2026-10-14T00:00:00.000Z");
  const cases: Array<{
    label: string;
    repeat: boolean;
    customId: (id: number) => string;
    text: string;
    expected: { status: string; snoozeAt: string | null };
  }> = [
    {
      label: "1 回だけの [完了]",
      repeat: false,
      customId: (id) => `rem:done:${id}:1`,
      text: "リマインド: 薬を飲む\n→ 完了にしました",
      expected: { status: "done", snoozeAt: null },
    },
    {
      label: "[10 分後]",
      repeat: false,
      customId: (id) => `rem:snooze:10:${id}:1`,
      text: "リマインド: 薬を飲む\n→ 10 分後（9:35）にもう一度知らせます",
      expected: { status: "active", snoozeAt: "2026-10-13T00:35:00.000Z" },
    },
    {
      label: "繰り返しの [1 時間後]",
      repeat: true,
      customId: (id) => `rem:snooze:60:${id}:1`,
      text: "リマインド: 薬を飲む\n（毎日 9:00）\n→ 1 時間後（10:25）にもう一度知らせます",
      expected: { status: "active", snoozeAt: "2026-10-13T01:25:00.000Z" },
    },
    {
      label: "繰り返しの [止める]",
      repeat: true,
      customId: (id) => `rem:stop:${id}:1`,
      text: "リマインド: 薬を飲む\n（毎日 9:00）\n→ 止めました",
      expected: { status: "cancelled", snoozeAt: null },
    },
  ];
  for (const { label, repeat, customId, text, expected } of cases) {
    const env = setup(t);
    const reminder = repeat ? env.fired({ rule: "daily@09:00" }, tomorrow) : env.fired();
    assert.deepEqual(await env.run(press(customId(reminder.id))), [
      { method: "update", message: { text, components: [] } },
    ], label);
    const after = env.reminders.get(reminder.id)!;
    assert.deepEqual({ status: after.status, snoozeAt: after.snoozeAt }, expected, label);
    assert.equal(env.logs.length, 1, label);
  }
});

test("[完了] は紐づけたタスクも完了にする。繰り返しの [済んだ] はスヌーズを消すだけ", async (t) => {
  const env = setup(t);
  const task = env.tasks.add({ title: "洗濯物" });
  const once = env.fired({ taskId: task.id });
  assert.deepEqual(await env.run(press(`rem:done:${once.id}:1`)), [
    {
      method: "update",
      message: { text: `リマインド: 薬を飲む\n（#${task.id} 洗濯物）\n→ 完了にしました（#${task.id} も完了にしました）`, components: [] },
    },
  ]);
  assert.equal(env.tasks.get(task.id)?.status, "done");

  const daily = env.fired({ rule: "daily@09:00" }, new Date("2026-10-14T00:00:00.000Z"));
  env.reminders.snooze(daily.id, new Date(NOW.getTime() + HOUR_MS));
  await env.run(press(`rem:done:${daily.id}:1`));
  const after = env.reminders.get(daily.id)!;
  assert.deepEqual([after.status, after.snoozeAt, after.nextAt], ["active", null, "2026-10-14T00:00:00.000Z"]);
});

test("発火のボタンが古ければ（seq が違う・止めた・行が無い・状態が合わない）本人にだけ返し、何も変えない", async (t) => {
  const env = setup(t);
  const once = env.fired();
  const cancelled = env.fired({ rule: "daily@09:00" }, new Date("2026-10-14T00:00:00.000Z"));
  env.reminders.cancel(cancelled.id);
  const done = env.fired();
  env.reminders.complete(done.id);
  for (const customId of [
    `rem:done:${once.id}:0`,
    `rem:snooze:10:${once.id}:2`,
    `rem:done:${cancelled.id}:1`,
    `rem:snooze:60:${cancelled.id}:1`,
    `rem:stop:${cancelled.id}:1`,
    `rem:done:${done.id}:1`,
    // 1 回だけのもの（fired）に [止める] は無い
    `rem:stop:${once.id}:1`,
    "rem:done:99:1",
  ]) {
    assert.deepEqual(await env.run(press(customId)), STALE_REPLY, customId);
  }
  assert.deepEqual(env.reminders.get(once.id)?.status, "fired");
  assert.deepEqual(env.logs, []);
});

test("/reminders: active を次の時刻の順に本人にだけ出し、選ぶセレクトを付ける。0 件なら「リマインドはありません」", async (t) => {
  const env = setup(t);
  const command = createRemindersCommand(env.deps);
  const runCommand = async (): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await command.handle({ ...BASE, kind: "command", name: "reminders", options: {} }, responder);
    return responder.calls;
  };
  assert.deepEqual(await runCommand(), [{ method: "reply", message: { text: NO_REMINDERS_TEXT, components: [], ephemeral: true } }]);

  const daily = env.add({ kind: "prompt", text: "今日のタスクを出す", rule: "daily@08:00", nextAt: new Date("2026-10-13T23:00:00.000Z") });
  const once = env.add({ nextAt: new Date("2026-10-13T02:00:00.000Z") });
  env.fired({ text: "知らせたもの" });

  assert.deepEqual(await runCommand(), [
    {
      method: "reply",
      message: {
        text: [`#${once.id} 10/13(火) 11:00 薬を飲む（<#ch-1>）`, `#${daily.id} 毎日 8:00 今日のタスクを出す（依頼・<#ch-1>）次 10/14(水) 8:00`].join("\n"),
        components: [
          {
            kind: "select",
            select: {
              customId: "rem:pick",
              placeholder: "止める・飛ばすものを選ぶ",
              minValues: 1,
              maxValues: 1,
              options: [
                { label: `#${once.id} 薬を飲む`, value: String(once.id) },
                { label: `#${daily.id} 今日のタスクを出す`, value: String(daily.id) },
              ],
            },
          },
        ],
        ephemeral: true,
      },
    },
  ]);
});

test("/reminders の詳細: 選ぶと [次の回を飛ばす]（繰り返しだけ）[止める] を出し、押すと書き換える。active でなければ「古くなっています」", async (t) => {
  const env = setup(t);
  // 毎週 水・金 8:00。次は 10/14(水)
  const weekly = env.add({ text: "ゴミ出し", rule: "weekly:wed,fri@08:00", nextAt: new Date("2026-10-13T23:00:00.000Z") });
  const once = env.add({ nextAt: new Date("2026-10-13T02:00:00.000Z") });
  const pick = (id: number): Extract<Interaction, { kind: "select" }> => ({ ...BASE, kind: "select", customId: "rem:pick", values: [String(id)] });

  assert.deepEqual(await env.run(pick(weekly.id)), [
    { method: "reply", message: { ...reminderDetailMessage(weekly, "Asia/Tokyo"), ephemeral: true } },
  ]);
  assert.deepEqual(
    reminderDetailMessage(weekly, "Asia/Tokyo").components?.flatMap((row) => (row.kind === "buttons" ? row.buttons.map((b) => b.customId) : [])),
    [`rem:skip:${weekly.id}`, `rem:cancel:${weekly.id}`],
  );
  assert.deepEqual(
    reminderDetailMessage(once, "Asia/Tokyo").components?.flatMap((row) => (row.kind === "buttons" ? row.buttons.map((b) => b.customId) : [])),
    [`rem:cancel:${once.id}`],
  );

  assert.deepEqual(await env.run(press(`rem:skip:${weekly.id}`)), [
    { method: "update", message: { text: "次の回（10/14(水)）を飛ばしました。次は 10/16(金) 8:00", components: [] } },
  ]);
  assert.equal(env.reminders.get(weekly.id)?.nextAt, "2026-10-15T23:00:00.000Z");

  assert.deepEqual(await env.run(press(`rem:cancel:${once.id}`)), [
    { method: "update", message: { text: "止めました: 薬を飲む", components: [] } },
  ]);
  assert.equal(env.reminders.get(once.id)?.status, "cancelled");

  // 止めた後・1 回だけのものの skip・無い id
  const staleUpdate: ResponderCall[] = [{ method: "update", message: { text: STALE_TEXT, components: [] } }];
  assert.deepEqual(await env.run(press(`rem:cancel:${once.id}`)), staleUpdate);
  assert.deepEqual(await env.run(press(`rem:skip:${once.id}`)), staleUpdate);
  assert.deepEqual(await env.run(press("rem:skip:99")), staleUpdate);
  assert.deepEqual(await env.run(pick(once.id)), [{ method: "reply", message: { text: STALE_TEXT, ephemeral: true } }]);
});
