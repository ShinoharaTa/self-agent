// /mode（app/commands/mode.ts）。一時 SQLite の本物のストアと偽の responder で見る
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createModeCommand } from "../src/app/commands/mode.ts";
import { type CommandDeps, createCommands } from "../src/app/interactions.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import {
  MODE_BUSY_REPLY,
  MODE_CLOSED_REPLY,
  MODE_INVALID_REPLY,
  MODE_LABELS,
  MODE_NOT_PROJECT_REPLY,
  MODE_NOT_SESSION_REPLY,
  MODE_PLAN_NOTE,
  modeChangedText,
  modeNowText,
  modeSameText,
  type SessionModeDeps,
} from "../src/app/session-mode.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import { TopicMoveStore } from "../src/store/topic-moves.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeResponder } from "./helpers/responder.ts";

const NOW = new Date("2026-11-20T01:00:00Z");

function command(mode: string | undefined, channelId: string | null = "project-1", guildId: string | null = "guild-1"): Extract<Interaction, { kind: "command" }> {
  return {
    kind: "command",
    name: "mode",
    guildId,
    channelId,
    userId: "owner-1",
    createdAt: NOW,
    options: mode === undefined ? {} : { mode },
  };
}

/** プロジェクトのセッション project-1（default）、軽いセッション light-1、閉じたプロジェクトのセッション done-1 */
function setup(t: TestContext) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { topicSessions } = stores;
  const running: Array<{ channelId: string }> = [];
  const deps: SessionModeDeps = {
    topicSessions,
    runningTurns: () => running,
    turnQueue: new KeyedSerialQueue(2),
    moves: new TopicMoveStore(db, () => NOW),
    history: stores.history,
    log: () => {},
  };
  topicSessions.create({ channelId: "project-1", guildId: "guild-1", title: "作業", categoryId: "active-1", projectDir: "alpha" });
  topicSessions.create({ channelId: "light-1", guildId: "guild-1", title: "軽い話", categoryId: "active-1" });
  topicSessions.create({ channelId: "done-1", guildId: "guild-1", title: "終わった話", categoryId: "active-1", projectDir: "alpha" });
  topicSessions.close("done-1", "要約");
  const handler = createModeCommand(deps);
  const run = async (interaction: Extract<Interaction, { kind: "command" }>): Promise<FakeResponder> => {
    const responder = new FakeResponder();
    await handler.handle(interaction, responder);
    return responder;
  };
  const modeOf = () => topicSessions.projectDirOf("project-1")?.permissionMode;
  return { deps, handler, run, running, modeOf };
}

test("★ choices は default・acceptEdits・plan の 3 つだけ", (t) => {
  const { handler } = setup(t);
  assert.equal(handler.def.name, "mode");
  assert.equal(handler.def.description, "プロジェクトのセッションの許可のモードを見る・変える");
  assert.equal(handler.def.options?.length, 1);
  const option = handler.def.options![0]!;
  assert.equal(option.type, "string");
  assert.equal(option.name, "mode");
  assert.equal(option.description, "新しいモード（省くと今のモードを表示）");
  assert.equal(option.required, false);
  assert.deepEqual(option.choices, [
    { name: MODE_LABELS.default, value: "default" },
    { name: MODE_LABELS.acceptEdits, value: "acceptEdits" },
    { name: MODE_LABELS.plan, value: "plan" },
  ]);
});

test("引数なしは今のモードを本人にだけ返す", async (t) => {
  const env = setup(t);
  const responder = await env.run(command(undefined));
  assert.deepEqual(responder.calls, [{ method: "reply", message: { text: modeNowText("default"), ephemeral: true } }]);
  assert.equal(env.modeOf(), "default");
});

test("変えた返信は全員に見え、plan は 2 行目に MODE_PLAN_NOTE", async (t) => {
  const env = setup(t);
  const accept = await env.run(command("acceptEdits"));
  assert.deepEqual(accept.calls, [{ method: "reply", message: { text: modeChangedText("acceptEdits"), ephemeral: false } }]);
  assert.equal(env.modeOf(), "acceptEdits");
  const plan = await env.run(command("plan"));
  assert.deepEqual(plan.calls, [{ method: "reply", message: { text: `${modeChangedText("plan")}\n${MODE_PLAN_NOTE}`, ephemeral: false } }]);
  assert.equal(env.modeOf(), "plan");
  // 同じモードは本人にだけ
  const same = await env.run(command("plan"));
  assert.deepEqual(same.calls, [{ method: "reply", message: { text: modeSameText("plan"), ephemeral: true } }]);
});

test("busy・not_project・closed・not_session はそれぞれの文を本人にだけ", async (t) => {
  const env = setup(t);
  const replyOf = async (interaction: Extract<Interaction, { kind: "command" }>) => (await env.run(interaction)).calls;
  assert.deepEqual(await replyOf(command("plan", "light-1")), [{ method: "reply", message: { text: MODE_NOT_PROJECT_REPLY, ephemeral: true } }]);
  assert.deepEqual(await replyOf(command("plan", "done-1")), [{ method: "reply", message: { text: MODE_CLOSED_REPLY, ephemeral: true } }]);
  assert.deepEqual(await replyOf(command("plan", "inbox-1")), [{ method: "reply", message: { text: MODE_NOT_SESSION_REPLY, ephemeral: true } }]);
  assert.deepEqual(await replyOf(command(undefined, null)), [{ method: "reply", message: { text: MODE_NOT_SESSION_REPLY, ephemeral: true } }]);
  assert.deepEqual(await replyOf(command(undefined, "project-1", null)), [{ method: "reply", message: { text: MODE_NOT_SESSION_REPLY, ephemeral: true } }]);
  // 引数なしでも同じ断り
  assert.deepEqual(await replyOf(command(undefined, "light-1")), [{ method: "reply", message: { text: MODE_NOT_PROJECT_REPLY, ephemeral: true } }]);
  env.running.push({ channelId: "project-1" });
  assert.deepEqual(await replyOf(command("plan")), [{ method: "reply", message: { text: MODE_BUSY_REPLY, ephemeral: true } }]);
  assert.equal(env.modeOf(), "default");
});

test("★ 3 つ以外の値は MODE_INVALID_REPLY で、DB は変わらない", async (t) => {
  const env = setup(t);
  for (const value of ["bypassPermissions", "dontAsk", "auto", "", "PLAN"]) {
    const responder = await env.run(command(value));
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: MODE_INVALID_REPLY, ephemeral: true } }], value);
    assert.equal(env.modeOf(), "default", value);
  }
});

test("createCommands: mode を渡したときだけ /mode がある", (t) => {
  const env = setup(t);
  assert.ok(!createCommands({} as CommandDeps).some((handler) => handler.def.name === "mode"));
  assert.ok(createCommands({ mode: env.deps } as unknown as CommandDeps).some((handler) => handler.def.name === "mode"));
});
