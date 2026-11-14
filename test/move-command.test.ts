// /move（app/commands/move.ts。#364 の M5b）。一時 SQLite と偽の runner・responder で、定義・保留・断りを確かめる
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "../src/agent/runner.ts";
import { createMoveCommand, MOVE_NOT_SESSION_REPLY, type MoveCommandDeps } from "../src/app/commands/move.ts";
import { type CommandDeps, createCommands } from "../src/app/interactions.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import type { ProjectSessionGate } from "../src/app/session-ops.ts";
import { MOVE_FAILED_TEXT, moveRefusalText, movedPostText } from "../src/app/topic-move.ts";
import type { CommandOptionDef, Interaction } from "../src/discord/gateway.ts";
import { TopicMoveStore } from "../src/store/topic-moves.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeResponder } from "./helpers/responder.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

const NOW = new Date("2026-11-14T01:00:00Z");
const GENERAL = "General";
const NOTE = "- 目的: 旅行の計画\n- 触ったファイル: notes.md";

function ok(text: string): RunResult {
  return { ok: true, text, sessionId: "session-1", usage: turnUsage(10, 0, 0), durationMs: 1000, toolCalls: 0, contextTokens: 10 };
}

const FAILED: RunResult = { ok: false, errorMessage: "error_during_execution: boom", sessionId: "session-1", sessionRecorded: true, toolCalls: 0 };

function command(place: string | undefined, channelId: string | null = "topic-1"): Extract<Interaction, { kind: "command" }> {
  return {
    kind: "command",
    name: "move",
    guildId: "guild-1",
    channelId,
    userId: "owner-1",
    createdAt: NOW,
    options: place === undefined ? {} : { place },
  };
}

/**
 * 話題 topic-1（軽い・会話あり）と完了した topic-done。ワークスペースは projects の名前のディレクトリと General。
 * cc を false にすると連携（projectSessions）を渡さない。running に足すとそのチャンネルは実行中。
 * チャンネルへの投稿（ownerPosts）は posts に入る。postFails を true にすると投稿は投げる
 */
function setup(t: TestContext, options: { steps?: RunResult[]; projects?: string[]; cc?: boolean; conversation?: boolean } = {}) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { topicSessions, sessions } = stores;
  const ws = tempDir(t);
  for (const name of [...(options.projects ?? ["alpha", "beta"]), GENERAL]) mkdirSync(join(ws, name));
  const gate: ProjectSessionGate = { places: { workspaceDir: ws, protectedDirs: [], generalDir: GENERAL }, ready: () => true };
  const runner = new FakeRunner(options.steps ?? []);
  const running: Array<{ channelId: string }> = [];
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const posts: Array<{ channelId: string; text: string }> = [];
  const postFails = { value: false };
  const deps: MoveCommandDeps = {
    topicSessions,
    moves: new TopicMoveStore(db, () => NOW),
    turnQueue: new KeyedSerialQueue(2),
    turn: { runner, projectRunner: runner, sessions, seeds: stores.seeds, usage: stores.usage, log },
    runningTurns: () => running,
    ...(options.cc === false ? {} : { projectSessions: gate }),
    history: stores.history,
    ownerPosts: {
      send: async (channelId: string, text: string) => {
        if (postFails.value) throw new TypeError("post failed");
        posts.push({ channelId, text });
      },
    },
    log,
  };
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" });
  if (options.conversation !== false) sessions.set("topic-1", "session-1");
  topicSessions.create({ channelId: "topic-done", guildId: "guild-1", title: "終わった話", categoryId: "active-1" });
  topicSessions.close("topic-done", "要約");
  const handler = createMoveCommand(deps);
  const run = async (interaction: Extract<Interaction, { kind: "command" }>): Promise<FakeResponder> => {
    const responder = new FakeResponder();
    await handler.handle(interaction, responder);
    return responder;
  };
  return { deps, handler, run, runner, running, logs, posts, postFails, topicSessions, sessions, history: stores.history };
}

/** defer が投げる responder（応答の期限が切れた形）。onDefer は保留の前に呼ぶ（キューの中の検査より先に走る） */
class DeferResponder extends FakeResponder {
  private readonly onDefer: () => void;
  private readonly fails: boolean;
  constructor(onDefer: () => void, fails: boolean) {
    super();
    this.onDefer = onDefer;
    this.fails = fails;
  }
  override async defer(ephemeral: boolean): Promise<void> {
    this.onDefer();
    if (this.fails) throw new Error("Unknown interaction");
    await super.defer(ephemeral);
  }
}

const placeOption = (env: { handler: { def: { options?: CommandOptionDef[] } } }): CommandOptionDef => env.handler.def.options![0]!;

test("/move の定義: place は必須。候補は General が先頭でプロジェクトが続き、値は general と p:<名前>", (t) => {
  const env = setup(t);
  assert.equal(env.handler.def.name, "move");
  assert.equal(env.handler.def.description, "この話題の場所（プロジェクト）を変えます");
  const option = placeOption(env);
  assert.deepEqual(option, {
    type: "string",
    name: "place",
    description: "新しい場所",
    required: true,
    choices: [
      { name: "General", value: "general" },
      { name: "alpha", value: "p:alpha" },
      { name: "beta", value: "p:beta" },
    ],
  });
});

test("/move の定義: 候補が 25 を超える・連携が無いときは候補なしの文字列", (t) => {
  // General + 24 は 25 で選択肢、General + 25 は 26 で文字列
  const exact = setup(t, { projects: Array.from({ length: 24 }, (_, i) => `p${String(i).padStart(2, "0")}`) });
  assert.equal(placeOption(exact).choices?.length, 25);
  const over = setup(t, { projects: Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(2, "0")}`) });
  assert.deepEqual(placeOption(over), { type: "string", name: "place", description: "新しい場所", required: true, maxLength: 66 });
  const noCc = setup(t, { cc: false });
  assert.deepEqual(placeOption(noCc), { type: "string", name: "place", description: "新しい場所", required: true, maxLength: 66 });
});

test("/move: 受け付けたら公開で保留し、終わったら場所と要点を出す", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const responder = await env.run(command("p:alpha"));
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: movedPostText({ from: null, to: "alpha", note: NOTE }, GENERAL) } },
  ]);
  assert.deepEqual(env.topicSessions.projectDirOf("topic-1"), { projectDir: "alpha", permissionMode: "default" });
  assert.equal(env.runner.inputs.length, 1);
});

test("/move: 断りは ephemeral で保留しない（closed・busy・same_place・cc_disabled）", async (t) => {
  const env = setup(t);
  const closed = await env.run(command("p:alpha", "topic-done"));
  assert.deepEqual(closed.calls, [{ method: "reply", message: { text: moveRefusalText("closed"), ephemeral: true } }]);

  env.running.push({ channelId: "topic-1" });
  const busy = await env.run(command("p:alpha"));
  assert.deepEqual(busy.calls, [{ method: "reply", message: { text: moveRefusalText("busy"), ephemeral: true } }]);
  env.running.length = 0;

  // 会話の無い話題はターンを使わずに変わる。同じ場所をもう一度選べば same_place
  const fresh = setup(t, { conversation: false });
  const first = await fresh.run(command("p:alpha"));
  assert.deepEqual(first.calls[0], { method: "defer", ephemeral: false });
  const same = await fresh.run(command("p:alpha"));
  assert.deepEqual(same.calls, [{ method: "reply", message: { text: moveRefusalText("same_place"), ephemeral: true } }]);

  const noCc = setup(t, { cc: false });
  const disabled = await noCc.run(command("general"));
  assert.deepEqual(disabled.calls, [{ method: "reply", message: { text: moveRefusalText("cc_disabled"), ephemeral: true } }]);
  assert.equal(env.runner.inputs.length + fresh.runner.inputs.length + noCc.runner.inputs.length, 0);
});

test("/move: 話題でないチャンネルでは ephemeral で「/move は話題のチャンネルで使ってください」", async (t) => {
  const env = setup(t);
  for (const channelId of ["unknown-1", null]) {
    const responder = await env.run(command("p:alpha", channelId));
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: MOVE_NOT_SESSION_REPLY, ephemeral: true } }], String(channelId));
  }
  assert.equal(MOVE_NOT_SESSION_REPLY, "/move は話題のチャンネルで使ってください");
});

test("/move: 候補なしの文字列は、名前だけ（General・プロジェクトの名前）でも読む。読めなければ ephemeral で断る", async (t) => {
  const env = setup(t, { conversation: false });
  const byName = await env.run(command("  beta "));
  assert.deepEqual(byName.calls[0], { method: "defer", ephemeral: false });
  assert.deepEqual(env.topicSessions.projectDirOf("topic-1"), { projectDir: "beta", permissionMode: "default" });
  const general = await env.run(command("General"));
  assert.deepEqual(general.calls[0], { method: "defer", ephemeral: false });
  assert.deepEqual(env.topicSessions.projectDirOf("topic-1"), { projectDir: GENERAL, permissionMode: "default" });
  for (const value of ["../x", "a/b", "", "other"]) {
    const responder = await env.run(command(value));
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: moveRefusalText("invalid_project"), ephemeral: true } }], value);
  }
  // 形は合うが無いプロジェクトは moveTopic が断る
  const missing = await env.run(command("nope"));
  assert.deepEqual(missing.calls, [{ method: "reply", message: { text: moveRefusalText("invalid_project"), ephemeral: true } }]);
  assert.deepEqual(env.topicSessions.projectDirOf("topic-1"), { projectDir: GENERAL, permissionMode: "default" });
});

test("/move: 要点のターンが失敗したら、保留した応答に失敗の文", async (t) => {
  const env = setup(t, { steps: [FAILED] });
  const responder = await env.run(command("p:alpha"));
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: MOVE_FAILED_TEXT } },
  ]);
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
  assert.equal(env.sessions.get("topic-1"), "session-1");
});

test("/move: 保留（defer）が投げても付け替えは済み、応答にも出せなければ結果をチャンネルに投稿する。handler は投げない", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const responder = new DeferResponder(() => {}, true);
  responder.beforeReply = () => {
    throw new Error("Unknown interaction");
  };
  await env.handler.handle(command("p:alpha"), responder);
  assert.deepEqual(env.topicSessions.projectDirOf("topic-1"), { projectDir: "alpha", permissionMode: "default" });
  assert.deepEqual(env.posts, [{ channelId: "topic-1", text: movedPostText({ from: null, to: "alpha", note: NOTE }, GENERAL) }]);
  assert.ok(env.logs.some((line) => line.includes("受け付けの知らせに失敗しました（Error）")), env.logs.join("\n"));
});

test("/move: 結果の応答だけ投げたら、場所は変わり、チャンネルに成功の文が 1 通。handler は投げない", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  const responder = new FakeResponder();
  responder.beforeReply = () => {
    throw new Error("Invalid Webhook Token");
  };
  await env.handler.handle(command("p:alpha"), responder);
  assert.deepEqual(responder.calls, [{ method: "defer", ephemeral: false }]);
  assert.deepEqual(env.topicSessions.projectDirOf("topic-1"), { projectDir: "alpha", permissionMode: "default" });
  assert.deepEqual(env.posts, [{ channelId: "topic-1", text: movedPostText({ from: null, to: "alpha", note: NOTE }, GENERAL) }]);
});

test("/move: 受け付けた後（キューの中）で断ったら、保留した応答に「場所を変えられませんでした: …」", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  // 保留の前に閉じる（キューの中の検査は onAccepted の後に走る）
  const responder = new DeferResponder(() => env.topicSessions.close("topic-1", "要約"), false);
  await env.handler.handle(command("p:alpha"), responder);
  const refused = `場所を変えられませんでした: ${moveRefusalText("closed")}`;
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: refused } },
  ]);
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(env.posts, []);
  assert.ok(env.history.list("topic-1", { limit: 10 }).some((row) => row.kind === "notice" && row.text === refused));
});

test("/move: 受け付けた後に moveTopic が投げたら、保留した応答に失敗の文。handler は投げない", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  env.sessions.get = () => {
    throw new TypeError("boom");
  };
  const responder = await env.run(command("p:alpha"));
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: false },
    { method: "reply", message: { text: MOVE_FAILED_TEXT } },
  ]);
  assert.equal(env.topicSessions.projectDirOf("topic-1"), undefined);
  assert.equal((env.deps.moves as TopicMoveStore).runningChannels().size, 0);
  assert.ok(env.logs.some((line) => line.includes("/move の場所の付け替えに失敗しました（TypeError）")), env.logs.join("\n"));
});

test("/move: 応答もチャンネルへの投稿も投げたら log だけ（種類だけ）。handler は投げない", async (t) => {
  const env = setup(t, { steps: [ok(NOTE)] });
  env.postFails.value = true;
  const responder = new FakeResponder();
  responder.beforeReply = () => {
    throw new Error("Invalid Webhook Token");
  };
  await env.handler.handle(command("p:alpha"), responder);
  assert.deepEqual(env.topicSessions.projectDirOf("topic-1"), { projectDir: "alpha", permissionMode: "default" });
  assert.deepEqual(env.posts, []);
  assert.ok(env.logs.includes("/move の結果をチャンネルに投稿できませんでした（TypeError）"), env.logs.join("\n"));
  for (const line of env.logs) {
    for (const secret of ["topic-1", "alpha", "旅行", "目的", "notes.md"]) assert.ok(!line.includes(secret), `${secret}: ${line}`);
  }
});

test("createCommands: move を渡したときだけ /move がある", (t) => {
  const env = setup(t);
  assert.ok(!createCommands({} as CommandDeps).some((handler) => handler.def.name === "move"));
  assert.ok(createCommands({ move: env.deps } as unknown as CommandDeps).some((handler) => handler.def.name === "move"));
});
