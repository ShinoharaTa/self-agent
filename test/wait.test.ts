import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ALREADY_CLOSED_REPLY, NOT_SESSION_REPLY } from "../src/app/commands/close.ts";
import {
  CONTINUED_TEXT,
  continueButton,
  createWaitCommand,
  createWaitComponent,
  WAITED_REPLY,
} from "../src/app/commands/wait.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";

const NOW = new Date("2026-10-02T00:12:00Z");
const LATER = new Date("2026-10-02T15:00:00Z");

const BASE = { guildId: "guild-1", channelId: "topic-1", userId: "owner-1", createdAt: NOW };
const WAIT: Extract<Interaction, { kind: "command" }> = { ...BASE, kind: "command", name: "wait", options: {} };
const TOPIC = { channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" };

function continuePress(channelId: string = "topic-1"): Extract<Interaction, { kind: "button" }> {
  return { ...BASE, kind: "button", customId: continueButton(channelId).customId };
}

function setup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: NOW };
  const { topicSessions } = createStores(db, () => clock.now);
  const channelOps = new RecordingChannelOps();
  const logs: string[] = [];
  const deps = { topicSessions, channelOps, log: (line: string) => logs.push(line) };
  const command = createWaitCommand(deps);
  const component = createWaitComponent(deps);
  topicSessions.create(TOPIC);

  const runWait = async (interaction: Extract<Interaction, { kind: "command" }> = WAIT): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await command.handle(interaction, responder);
    return responder.calls;
  };
  const press = async (interaction: Exclude<Interaction, { kind: "command" }> = continuePress()): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await component.handle(interaction, responder);
    return responder.calls;
  };
  return { db, clock, topicSessions, channelOps, logs, runWait, press };
}

const TO_WAITING = { channelId: "topic-1", target: { kind: "state", guildId: "guild-1", state: "waiting" } };
const TO_ACTIVE = { channelId: "topic-1", target: { kind: "state", guildId: "guild-1", state: "active" } };

test("/wait: 進行中なら待ちにして waiting_since を記録し、待ちカテゴリへの移動を入れて ephemeral で「待ちに移しました」と返す", async (t) => {
  const env = setup(t);
  env.clock.now = LATER;

  const calls = await env.runWait();

  assert.deepEqual(calls, [{ method: "reply", message: { text: WAITED_REPLY, ephemeral: true } }]);
  const session = env.topicSessions.get("topic-1");
  assert.equal(session?.state, "waiting");
  assert.equal(session?.waitingSince, LATER.toISOString());
  // 最終発言の時刻は変えない
  assert.equal(session?.lastActivityAt, NOW.toISOString());
  assert.deepEqual(env.channelOps.moves, [TO_WAITING]);
  assert.equal(env.logs.length, 1);
  assert.ok(!env.logs[0]!.includes("topic-1"));
});

test("/wait: 既に待ちなら何も変えずに「待ちに移しました」と返す", async (t) => {
  const env = setup(t);
  env.topicSessions.setWaiting("topic-1");
  env.clock.now = LATER;

  const calls = await env.runWait();

  assert.deepEqual(calls, [{ method: "reply", message: { text: WAITED_REPLY, ephemeral: true } }]);
  assert.equal(env.topicSessions.get("topic-1")?.waitingSince, NOW.toISOString());
  assert.deepEqual(env.channelOps.moves, []);
  assert.deepEqual(env.logs, []);
});

test("/wait: セッション以外（#inbox・知らないチャンネル・別サーバーのセッション）と閉じたセッション（done・deleted）では ephemeral で断り、何も変えない", async (t) => {
  const env = setup(t);
  env.topicSessions.create({ ...TOPIC, channelId: "topic-9", guildId: "guild-9" });

  for (const channelId of ["inbox-1", "unknown-1", "topic-9", null]) {
    const calls = await env.runWait({ ...WAIT, channelId });
    assert.deepEqual(calls, [{ method: "reply", message: { text: NOT_SESSION_REPLY, ephemeral: true } }], String(channelId));
  }
  assert.equal(env.topicSessions.get("topic-9")?.state, "active");
  for (const state of ["done", "deleted"]) {
    env.db.prepare("UPDATE sessions SET state = ? WHERE channel_id = 'topic-1'").run(state);
    const calls = await env.runWait();
    assert.deepEqual(calls, [{ method: "reply", message: { text: ALREADY_CLOSED_REPLY, ephemeral: true } }], state);
    assert.equal(env.topicSessions.get("topic-1")?.state, state);
  }
  assert.deepEqual(env.channelOps.moves, []);
  assert.deepEqual(env.logs, []);
});

test("[続ける]: 待ち・完了なら進行中に戻して進行中カテゴリへの移動を入れ、既に進行中なら移動は入れない。どれも知らせのボタンを外して「進行中に戻しました」にする", async (t) => {
  const cases: Array<{ label: string; arrange: (env: ReturnType<typeof setup>) => void; moved: boolean }> = [
    { label: "待ち", arrange: (env) => env.topicSessions.setWaiting("topic-1"), moved: true },
    { label: "完了", arrange: (env) => env.topicSessions.close("topic-1", "要約"), moved: true },
    { label: "進行中", arrange: () => {}, moved: false },
  ];

  for (const { label, arrange, moved } of cases) {
    const env = setup(t);
    arrange(env);

    const calls = await env.press();

    assert.deepEqual(calls, [{ method: "update", message: { text: CONTINUED_TEXT, components: [] } }], label);
    const session = env.topicSessions.get("topic-1");
    assert.equal(session?.state, "active", label);
    assert.equal(session?.waitingSince, null, label);
    assert.equal(session?.closedAt, null, label);
    // 完了から戻しても要約は残す
    if (label === "完了") assert.equal(session?.summary, "要約", label);
    assert.deepEqual(env.channelOps.moves, moved ? [TO_ACTIVE] : [], label);
    assert.equal(env.logs.length, moved ? 1 : 0, label);
  }
});

test("[続ける]: 削除済みは「このセッションは閉じています」、知らないチャンネル・別サーバーは「セッションのチャンネルで…」を ephemeral で返す", async (t) => {
  const env = setup(t);
  env.topicSessions.create({ ...TOPIC, channelId: "topic-9", guildId: "guild-9" });
  env.db.prepare("UPDATE sessions SET state = 'deleted' WHERE channel_id = 'topic-1'").run();

  assert.deepEqual(await env.press(), [{ method: "reply", message: { text: ALREADY_CLOSED_REPLY, ephemeral: true } }]);
  for (const channelId of ["unknown-1", "topic-9"]) {
    assert.deepEqual(
      await env.press(continuePress(channelId)),
      [{ method: "reply", message: { text: NOT_SESSION_REPLY, ephemeral: true } }],
      channelId,
    );
  }
  assert.equal(env.topicSessions.get("topic-1")?.state, "deleted");
  assert.deepEqual(env.channelOps.moves, []);
});

test("wait の不明な操作（custom_id のチャンネル無し・知らない action・セレクト）は例外にする", async (t) => {
  const env = setup(t);

  await assert.rejects(env.press({ ...continuePress(), customId: "wait:continue" }), /チャンネルがありません/);
  await assert.rejects(env.press({ ...continuePress(), customId: "wait:stop:topic-1" }), /不明な操作です（button stop）/);
  await assert.rejects(
    env.press({ ...BASE, kind: "select", customId: "wait:continue:topic-1", values: [] }),
    /不明な操作です（select continue）/,
  );
  assert.deepEqual(env.channelOps.moves, []);
});
