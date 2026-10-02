import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomeComponent, NEW_SESSION_MODAL } from "../src/app/commands/home.ts";
import { EMPTY_TITLE_REPLY, NOT_SET_UP_REPLY, welcomeText } from "../src/app/commands/new.ts";
import { ensureGuildLayout } from "../src/app/commands/setup.ts";
import { taskListMessage } from "../src/app/commands/tasks.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import type {
  Gateway,
  Interaction,
  InteractionResponder,
  ModalDef,
  OutgoingMessage,
  TextChannelOptions,
} from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";

const NOW = new Date("2026-10-02T00:12:00Z");

type GatewayCall =
  | { method: "createCategory"; name: string }
  | { method: "createTextChannel"; options: TextChannelOptions }
  | { method: "send"; channelId: string; text: string };

/** 作ったチャンネルを覚えておき、channelExists・countChannelsIn はそれで答える（存在の確認・数えるのは記録しない） */
class FakeGateway
  implements Pick<Gateway, "createCategory" | "createTextChannel" | "channelExists" | "countChannelsIn" | "moveChannel" | "send">
{
  calls: GatewayCall[] = [];
  private readonly alive = new Set<string>();
  private readonly parents = new Map<string, string>();
  private nextId = 1;

  async createCategory(_guildId: string, name: string): Promise<string> {
    this.calls.push({ method: "createCategory", name });
    return this.newId();
  }
  async createTextChannel(_guildId: string, options: TextChannelOptions): Promise<string> {
    this.calls.push({ method: "createTextChannel", options });
    const id = this.newId();
    this.parents.set(id, options.parentId);
    return id;
  }
  async channelExists(channelId: string): Promise<boolean> {
    return this.alive.has(channelId);
  }
  async countChannelsIn(categoryId: string): Promise<number> {
    return [...this.parents.values()].filter((parentId) => parentId === categoryId).length;
  }
  async moveChannel(): Promise<void> {
    throw new Error("想定外の呼び出し");
  }
  async send(channelId: string, text: string): Promise<void> {
    this.calls.push({ method: "send", channelId, text });
  }

  private newId(): string {
    const id = `ch-${this.nextId++}`;
    this.alive.add(id);
    return id;
  }
}

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

type ComponentInteraction = Exclude<Interaction, { kind: "command" }>;

/** ホームパネルは #inbox（ch-2）にある */
const BASE = { guildId: "guild-1", channelId: "ch-2", userId: "owner-1", createdAt: NOW };

function press(action: string): ComponentInteraction {
  return { ...BASE, kind: "button", customId: `home:${action}` };
}

function submitTitle(title: string): ComponentInteraction {
  return { ...BASE, kind: "modal", customId: "home:new-modal", fields: { title } };
}

/** /setup で作られる進行中カテゴリの ID（作る順に ch-1 から振られる） */
const ACTIVE = "ch-5";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: NOW };
  const gateway = new FakeGateway();
  const guildSettings = new GuildSettingsStore(db, () => NOW);
  const topicSessions = new TopicSessionStore(db, () => clock.now);
  const tasks = new TaskStore(db, () => NOW);
  const logs: string[] = [];
  const component = createHomeComponent({
    gateway,
    guildSettings,
    topicSessions,
    tasks,
    queue: new KeyedSerialQueue(1),
    log: (line) => logs.push(line),
  });
  const handle = async (interaction: ComponentInteraction): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await component.handle(interaction, responder);
    return responder.calls;
  };
  /** /setup 済みにする。呼び出し記録は消す */
  const setUp = async (): Promise<void> => {
    const result = await ensureGuildLayout("guild-1", { gateway, guildSettings });
    assert.equal(result.failure, null);
    gateway.calls = [];
  };
  return { clock, gateway, topicSessions, tasks, logs, handle, setUp };
}

test("[新しいセッション]（home:new）: 題名 1 項目（必須・100 字まで）のモーダル home:new-modal を開く", async (t) => {
  const { gateway, handle } = setup(t);

  const calls = await handle(press("new"));

  assert.deepEqual(calls, [{ method: "showModal", modal: NEW_SESSION_MODAL }]);
  assert.deepEqual(NEW_SESSION_MODAL, {
    customId: "home:new-modal",
    title: "新しいセッション",
    fields: [{ customId: "title", label: "題名", required: true, maxLength: 100 }],
  });
  assert.deepEqual(gateway.calls, []);
});

test("モーダル送信（home:new-modal）: /new と同じ処理でセッションを作り、ephemeral でリンクを返す", async (t) => {
  const { gateway, topicSessions, logs, handle, setUp } = setup(t);
  await setUp();

  const calls = await handle(submitTitle("  旅行の計画  "));

  assert.deepEqual(gateway.calls, [
    { method: "createTextChannel", options: { name: "旅行の計画", parentId: ACTIVE, topic: "旅行の計画" } },
    { method: "send", channelId: "ch-8", text: welcomeText("旅行の計画") },
  ]);
  assert.deepEqual(calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: "<#ch-8> を作りました", ephemeral: true } },
  ]);
  assert.equal(topicSessions.get("ch-8")?.state, "active");
  assert.equal(topicSessions.get("ch-8")?.title, "旅行の計画");
  assert.deepEqual(logs, ["ホームパネルからセッションを作りました（guild=guild-1）"]);
});

test("モーダル送信: 空白だけの題名は作らずに案内し、/setup 前なら /setup を案内する", async (t) => {
  const { gateway, handle } = setup(t);

  assert.deepEqual(await handle(submitTitle(" 　 ")), [
    { method: "reply", message: { text: EMPTY_TITLE_REPLY, ephemeral: true } },
  ]);
  assert.deepEqual(await handle(submitTitle("x")), [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: NOT_SET_UP_REPLY, ephemeral: true } },
  ]);
  assert.deepEqual(gateway.calls, []);
});

test("[タスク一覧]（home:tasks）: /tasks と同じ一覧とセレクトを ephemeral で返す", async (t) => {
  const { tasks, handle } = setup(t);
  tasks.add({ title: "買い物", due: "2026-10-03" });
  tasks.add({ title: "電話" });

  const calls = await handle(press("tasks"));

  assert.deepEqual(calls, [{ method: "reply", message: { ...taskListMessage(tasks), ephemeral: true } }]);
  assert.ok(calls[0]?.method === "reply");
  assert.equal(calls[0].message.text, "#1 買い物（期限 2026-10-03）\n#2 電話");
});

test("[待ちのセッション]（home:waiting）: 待ちのセッションだけを ephemeral で返す。0 件なら「なし」", async (t) => {
  const { clock, topicSessions, handle } = setup(t);

  assert.deepEqual(await handle(press("waiting")), [
    { method: "reply", message: { text: "**待ち**\nなし", ephemeral: true } },
  ]);

  clock.now = new Date(NOW.getTime() - 5 * 60 * 60 * 1000);
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "返事待ち", categoryId: "waiting-1" });
  topicSessions.create({ channelId: "topic-2", guildId: "guild-1", title: "進行中", categoryId: "active-1" });
  topicSessions.setWaiting("topic-1");
  clock.now = NOW;

  assert.deepEqual(await handle(press("waiting")), [
    { method: "reply", message: { text: "**待ち**\n<#topic-1> 返事待ち（最終 5 時間前）", ephemeral: true } },
  ]);
});

test("home の不明な操作は例外にする", async (t) => {
  const { handle } = setup(t);
  await assert.rejects(handle(press("other")), /home の不明な操作です/);
  await assert.rejects(handle({ ...BASE, kind: "select", customId: "home:tasks", values: [] }), /home の不明な操作です/);
  await assert.rejects(handle({ ...BASE, kind: "modal", customId: "home:other", fields: {} }), /home の不明な操作です/);
});
