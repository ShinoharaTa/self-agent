import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MoveTarget } from "../src/app/channel-ops.ts";
import { ALREADY_CLOSED_REPLY, NOT_SESSION_REPLY } from "../src/app/commands/close.ts";
import { HELP_TEXT } from "../src/app/commands/help.ts";
import {
  CONTINUED_TEXT,
  continueButton,
  createWaitCommand,
  createWaitComponent,
  WAITED_REPLY,
} from "../src/app/commands/wait.ts";
import type { Interaction, InteractionResponder, ModalDef, OutgoingMessage } from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";

const NOW = new Date("2026-10-02T00:12:00Z");
const LATER = new Date("2026-10-02T15:00:00Z");

type ResponderCall =
  | { method: "defer"; ephemeral: boolean }
  | { method: "deferUpdate" }
  | { method: "reply" | "update"; message: OutgoingMessage }
  | { method: "showModal"; modal: ModalDef };

class FakeResponder implements InteractionResponder {
  calls: ResponderCall[] = [];

  async defer(ephemeral: boolean): Promise<void> {
    this.calls.push({ method: "defer", ephemeral });
  }
  async deferUpdate(): Promise<void> {
    this.calls.push({ method: "deferUpdate" });
  }
  async reply(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "reply", message });
  }
  async update(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "update", message });
  }
  async showModal(modal: ModalDef): Promise<void> {
    this.calls.push({ method: "showModal", modal });
  }
}

class RecordingChannelOps {
  moves: Array<{ channelId: string; target: MoveTarget }> = [];

  enqueueMove(channelId: string, target: MoveTarget): void {
    this.moves.push({ channelId, target });
  }
}

const BASE = { guildId: "guild-1", channelId: "topic-1", userId: "owner-1", createdAt: NOW };
const WAIT: Extract<Interaction, { kind: "command" }> = { ...BASE, kind: "command", name: "wait", options: {} };
const TOPIC = { channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" };

function continuePress(channelId: string = "topic-1"): Extract<Interaction, { kind: "button" }> {
  return { ...BASE, kind: "button", customId: `wait:continue:${channelId}` };
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: NOW };
  const topicSessions = new TopicSessionStore(db, () => clock.now);
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
  assert.equal(WAITED_REPLY, "待ちに移しました");
  const session = env.topicSessions.get("topic-1");
  assert.equal(session?.state, "waiting");
  assert.equal(session?.waitingSince, LATER.toISOString());
  // 最終発言の時刻は変えない
  assert.equal(session?.lastActivityAt, NOW.toISOString());
  assert.deepEqual(env.channelOps.moves, [TO_WAITING]);
  assert.deepEqual(env.logs, ["/wait でセッションを待ちに移しました（guild=guild-1）"]);
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

test("/wait: 閉じたセッション（done・deleted）では ephemeral で「このセッションは閉じています」と返し、何も変えない", async (t) => {
  const env = setup(t);

  for (const state of ["done", "deleted"]) {
    env.db.prepare("UPDATE sessions SET state = ? WHERE channel_id = 'topic-1'").run(state);
    const calls = await env.runWait();
    assert.deepEqual(calls, [{ method: "reply", message: { text: ALREADY_CLOSED_REPLY, ephemeral: true } }], state);
    assert.equal(env.topicSessions.get("topic-1")?.state, state);
  }
  assert.deepEqual(env.channelOps.moves, []);
});

test("/wait: セッション以外（#inbox・知らないチャンネル・別サーバーのセッション）では ephemeral で断る", async (t) => {
  const env = setup(t);
  env.topicSessions.create({ ...TOPIC, channelId: "topic-9", guildId: "guild-9" });

  for (const channelId of ["inbox-1", "unknown-1", "topic-9", null]) {
    const calls = await env.runWait({ ...WAIT, channelId });
    assert.deepEqual(calls, [{ method: "reply", message: { text: NOT_SESSION_REPLY, ephemeral: true } }], String(channelId));
  }
  assert.equal(env.topicSessions.get("topic-9")?.state, "active");
  assert.deepEqual(env.channelOps.moves, []);
});

test("[続ける]: 待ちなら進行中に戻して進行中カテゴリへの移動を入れ、知らせのボタンを外して「進行中に戻しました」にする", async (t) => {
  const env = setup(t);
  env.topicSessions.setWaiting("topic-1");

  const calls = await env.press();

  assert.deepEqual(calls, [{ method: "update", message: { text: CONTINUED_TEXT, components: [] } }]);
  assert.equal(CONTINUED_TEXT, "進行中に戻しました");
  const session = env.topicSessions.get("topic-1");
  assert.equal(session?.state, "active");
  assert.equal(session?.waitingSince, null);
  assert.deepEqual(env.channelOps.moves, [TO_ACTIVE]);
  assert.deepEqual(env.logs, ["[続ける] でセッションを進行中に戻しました（guild=guild-1）"]);
});

test("[続ける]: 完了なら進行中に戻して closed_at を消す（要約は残す）", async (t) => {
  const env = setup(t);
  env.topicSessions.close("topic-1", "要約");

  const calls = await env.press();

  assert.deepEqual(calls, [{ method: "update", message: { text: CONTINUED_TEXT, components: [] } }]);
  const session = env.topicSessions.get("topic-1");
  assert.equal(session?.state, "active");
  assert.equal(session?.closedAt, null);
  assert.equal(session?.summary, "要約");
  assert.deepEqual(env.channelOps.moves, [TO_ACTIVE]);
});

test("[続ける]: 既に進行中なら同じ表示でボタンだけ外し、移動は入れない", async (t) => {
  const env = setup(t);

  const calls = await env.press();

  assert.deepEqual(calls, [{ method: "update", message: { text: CONTINUED_TEXT, components: [] } }]);
  assert.equal(env.topicSessions.get("topic-1")?.state, "active");
  assert.deepEqual(env.channelOps.moves, []);
  assert.deepEqual(env.logs, []);
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

test("[続ける] ボタンの custom_id は wait:continue:<channelId>", () => {
  assert.deepEqual(continueButton("topic-1"), { customId: "wait:continue:topic-1", label: "続ける" });
});

test("/help に /wait の説明がある", () => {
  assert.match(HELP_TEXT, /^`\/wait` /m);
});
