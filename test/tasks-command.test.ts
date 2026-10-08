import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGE_MAX_LENGTH } from "../src/app/commands/sessions.ts";
import {
  createTasksCommand,
  createTasksComponent,
  NO_OPEN_TASKS_TEXT,
  taskListMessage,
} from "../src/app/commands/tasks.ts";
import type {
  ComponentRow,
  Interaction,
  InteractionResponder,
  ModalDef,
  OutgoingMessage,
} from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { TaskStore } from "../src/store/tasks.ts";

const NOW = new Date("2026-10-02T00:12:00Z");

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

const BASE = { guildId: "guild-1", channelId: "inbox-1", userId: "owner-1", createdAt: NOW };
const TASKS: Extract<Interaction, { kind: "command" }> = { ...BASE, kind: "command", name: "tasks", options: {} };

function select(values: string[], customId: string = "tasks:done"): Extract<Interaction, { kind: "select" }> {
  return { ...BASE, kind: "select", customId, values };
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const tasks = new TaskStore(db, () => NOW);
  const logs: string[] = [];
  const deps = { tasks, log: (line: string) => logs.push(line) };
  const runTasks = async (): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await createTasksCommand(deps).handle(TASKS, responder);
    return responder.calls;
  };
  const choose = async (interaction: Exclude<Interaction, { kind: "command" }>): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await createTasksComponent(deps).handle(interaction, responder);
    return responder.calls;
  };
  return { tasks, logs, runTasks, choose };
}

function selectRow(options: Array<{ label: string; value: string; description?: string }>): ComponentRow {
  return {
    kind: "select",
    select: {
      customId: "tasks:done",
      placeholder: "完了にするタスクを選んでください",
      minValues: 1,
      maxValues: options.length,
      options,
    },
  };
}

test("/tasks: 未完了のタスクを期限順（期限なしは後ろ）に #id 題名（期限 YYYY-MM-DD）で並べ、表示した分のセレクトを付けて ephemeral で返す", async (t) => {
  const { tasks, runTasks } = setup(t);
  tasks.add({ title: "期限なし" });
  tasks.add({ title: "来週", due: "2026-10-09" });
  tasks.add({ title: "明日", due: "2026-10-03" });
  tasks.add({ title: "済んだ", due: "2026-10-01" });
  tasks.complete(4);

  const calls = await runTasks();

  assert.deepEqual(calls, [
    {
      method: "reply",
      message: {
        text: ["#3 明日（期限 2026-10-03）", "#2 来週（期限 2026-10-09）", "#1 期限なし"].join("\n"),
        components: [
          selectRow([
            { label: "#3 明日", value: "3", description: "期限 2026-10-03" },
            { label: "#2 来週", value: "2", description: "期限 2026-10-09" },
            { label: "#1 期限なし", value: "1" },
          ]),
        ],
        ephemeral: true,
      },
    },
  ]);
});

test("/tasks: 未完了が 0 件なら「未完了のタスクはありません」だけ", async (t) => {
  const { runTasks } = setup(t);

  const calls = await runTasks();

  assert.deepEqual(calls, [{ method: "reply", message: { text: NO_OPEN_TASKS_TEXT, components: [], ephemeral: true } }]);
  assert.equal(NO_OPEN_TASKS_TEXT, "未完了のタスクはありません");
});

test("/tasks: やめた（dropped）タスクは一覧とセレクトに出ない", async (t) => {
  const { tasks, runTasks } = setup(t);
  tasks.add({ title: "やめた", due: "2026-10-03" });
  tasks.add({ title: "残す" });
  tasks.update(1, { status: "dropped" });

  const calls = await runTasks();

  assert.deepEqual(calls, [
    {
      method: "reply",
      message: { text: "#2 残す", components: [selectRow([{ label: "#2 残す", value: "2" }])], ephemeral: true },
    },
  ]);
});

test("/tasks: 20 件まで。セレクトの選択肢も表示した 20 件", (t) => {
  const { tasks } = setup(t);
  for (let i = 1; i <= 23; i++) tasks.add({ title: `t${i}`, due: `2026-10-${String(i).padStart(2, "0")}` });

  const message = taskListMessage(tasks);

  const lines = message.text.split("\n");
  assert.equal(lines.length, 20);
  assert.equal(lines[0], "#1 t1（期限 2026-10-01）");
  assert.equal(lines[19], "#20 t20（期限 2026-10-20）");
  const row = message.components?.[0];
  assert.ok(row?.kind === "select");
  assert.equal(row.select.options.length, 20);
  assert.equal(row.select.maxValues, 20);
});

test("/tasks: 2000 字を超えるなら末尾から削って「ほか n 件」を足し、セレクトの選択肢は表示した分だけ。ラベルは 100 字で切る", (t) => {
  const { tasks } = setup(t);
  const long = "あ".repeat(200);
  for (let i = 0; i < 20; i++) tasks.add({ title: long });

  const message = taskListMessage(tasks);

  assert.ok(message.text.length <= MESSAGE_MAX_LENGTH, `length=${message.text.length}`);
  const lines = message.text.split("\n");
  const shown = lines.filter((line) => line.startsWith("#"));
  assert.equal(lines.at(-1), `ほか ${20 - shown.length} 件`);
  const row = message.components?.[0];
  assert.ok(row?.kind === "select");
  assert.deepEqual(
    row.select.options.map((option) => option.value),
    shown.map((line) => line.slice(1, line.indexOf(" "))),
  );
  assert.equal(row.select.maxValues, shown.length);
  assert.equal(row.select.options[0]?.label, `#1 ${"あ".repeat(96)}…`);
  assert.equal(row.select.options[0]?.label.length, 100);
});

test("tasks:done: 選んだタスクを完了にし、一覧を update で書き換える（完了したものは消える）", async (t) => {
  const { tasks, logs, choose } = setup(t);
  tasks.add({ title: "a", due: "2026-10-03" });
  tasks.add({ title: "b", due: "2026-10-04" });
  tasks.add({ title: "c" });

  const calls = await choose(select(["1", "3"]));

  assert.equal(tasks.get(1)?.status, "done");
  assert.equal(tasks.get(2)?.status, "open");
  assert.equal(tasks.get(3)?.status, "done");
  assert.deepEqual(calls, [
    {
      method: "update",
      message: {
        text: "#2 b（期限 2026-10-04）",
        components: [selectRow([{ label: "#2 b", value: "2", description: "期限 2026-10-04" }])],
      },
    },
  ]);
  assert.deepEqual(logs, ["/tasks でタスクを 2 件完了にしました（guild=guild-1）"]);
});

test("tasks:done: 全部完了にしたら「未完了のタスクはありません」にしてセレクトを外す。既に完了・無い id は数えない", async (t) => {
  const { tasks, logs, choose } = setup(t);
  tasks.add({ title: "a" });
  tasks.add({ title: "b" });
  tasks.complete(2);

  const calls = await choose(select(["1", "2", "99", "x"]));

  assert.deepEqual(calls, [{ method: "update", message: { text: NO_OPEN_TASKS_TEXT, components: [] } }]);
  assert.deepEqual(logs, ["/tasks でタスクを 1 件完了にしました（guild=guild-1）"]);
});

test("tasks の不明な操作（ボタン・別の custom_id）は例外にする", async (t) => {
  const { choose } = setup(t);
  await assert.rejects(choose({ ...BASE, kind: "button", customId: "tasks:done" }), /tasks の不明な操作です/);
  await assert.rejects(choose(select(["1"], "tasks:other")), /tasks の不明な操作です/);
});
