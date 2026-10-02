import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskToolHandlers, type TextToolResult } from "../src/agent/tools.ts";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { TaskStore } from "../src/store/tasks.ts";

function tempStore(t: TestContext): TaskStore {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "nested", "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return new TaskStore(db, () => new Date("2026-10-02T00:12:00Z"));
}

function parse(result: TextToolResult): unknown {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("TaskStore: 追加・取得・完了", (t) => {
  const store = tempStore(t);
  const task = store.add({ title: "買い物に行く", due: "2026-10-03" });
  assert.deepEqual(task, {
    id: 1,
    title: "買い物に行く",
    due: "2026-10-03",
    status: "open",
    createdAt: "2026-10-02T00:12:00.000Z",
    completedAt: null,
    sourceMessageId: null,
  });
  assert.deepEqual(store.get(1), task);

  const completed = store.complete(1);
  assert.equal(completed.result, "completed");
  assert.equal(store.get(1)?.status, "done");
  assert.equal(store.get(1)?.completedAt, "2026-10-02T00:12:00.000Z");
  assert.equal(store.complete(1).result, "already_done");
  assert.deepEqual(store.complete(99), { result: "not_found" });
});

test("TaskStore: 一覧は期限の昇順、期限なしは後ろ、件数上限あり", (t) => {
  const store = tempStore(t);
  store.add({ title: "期限なし A" });
  store.add({ title: "10/05", due: "2026-10-05" });
  store.add({ title: "10/03", due: "2026-10-03" });
  store.add({ title: "期限なし B" });
  store.add({ title: "完了済み", due: "2026-10-01" });
  store.complete(5);

  const titles = store.list({ status: "open", limit: 20 }).map((task) => task.title);
  assert.deepEqual(titles, ["10/03", "10/05", "期限なし A", "期限なし B"]);
  assert.deepEqual(
    store.list({ status: "open", limit: 2 }).map((task) => task.title),
    ["10/03", "10/05"],
  );
  assert.deepEqual(
    store.list({ status: "done", limit: 20 }).map((task) => task.title),
    ["完了済み"],
  );
});

test("task_add / task_list / task_complete ハンドラ", (t) => {
  const handlers = createTaskToolHandlers(tempStore(t));

  assert.deepEqual(parse(handlers.taskAdd({ title: "牛乳を買う" })), { id: 1, title: "牛乳を買う", due: null });
  assert.deepEqual(parse(handlers.taskAdd({ title: "買い物に行く", due: "2026-10-03" })), {
    id: 2,
    title: "買い物に行く",
    due: "2026-10-03",
  });

  // 既定は open、期限順
  assert.deepEqual(parse(handlers.taskList({})), [
    { id: 2, title: "買い物に行く", due: "2026-10-03" },
    { id: 1, title: "牛乳を買う", due: null },
  ]);
  assert.deepEqual(parse(handlers.taskList({ limit: 1 })), [{ id: 2, title: "買い物に行く", due: "2026-10-03" }]);

  assert.deepEqual(parse(handlers.taskComplete({ id: 2 })), {
    result: "completed",
    id: 2,
    title: "買い物に行く",
    due: "2026-10-03",
  });
  assert.deepEqual(parse(handlers.taskList({ status: "done" })), [{ id: 2, title: "買い物に行く", due: "2026-10-03" }]);
  assert.deepEqual(parse(handlers.taskList({})), [{ id: 1, title: "牛乳を買う", due: null }]);
});

test("task_complete: 存在しない id・完了済みはエラーにせずその旨を返す", (t) => {
  const handlers = createTaskToolHandlers(tempStore(t));
  handlers.taskAdd({ title: "牛乳を買う" });
  handlers.taskComplete({ id: 1 });

  assert.deepEqual(parse(handlers.taskComplete({ id: 1 })), {
    result: "already_done",
    id: 1,
    title: "牛乳を買う",
    due: null,
  });
  assert.deepEqual(parse(handlers.taskComplete({ id: 42 })), { result: "not_found", id: 42 });
});

test("openDb: 開き直してもマイグレーションを繰り返さない", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "self-agent.db");

  const first = openDb(path);
  new TaskStore(first).add({ title: "残る" });
  first.close();

  const second = openDb(path);
  assert.equal(second.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.equal(second.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.deepEqual(new TaskStore(second).list({ status: "open", limit: 20 }).map((task) => task.title), ["残る"]);
  second.close();
});
