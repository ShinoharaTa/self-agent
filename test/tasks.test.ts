import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskToolHandlers, type TextToolResult } from "../src/agent/tools.ts";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { TaskStore } from "../src/store/tasks.ts";

const TZ = "Asia/Tokyo";

function tempStore(t: TestContext, now: () => Date = () => new Date("2026-10-02T00:12:00Z")): TaskStore {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "nested", "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return new TaskStore(db, now);
}

/** set で進められる時計 */
function clock(start: string): { now: () => Date; set: (iso: string) => void } {
  let current = new Date(start);
  return { now: () => current, set: (iso) => (current = new Date(iso)) };
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
  const handlers = createTaskToolHandlers(tempStore(t), TZ);

  assert.deepEqual(parse(handlers.taskAdd({ title: "牛乳を買う" })), { id: 1, title: "牛乳を買う", due: null });
  assert.deepEqual(parse(handlers.taskAdd({ title: "買い物に行く", due: "2026-10-03" })), {
    id: 2,
    title: "買い物に行く",
    due: "2026-10-03",
  });

  // 既定は open、期限順
  assert.deepEqual(parse(handlers.taskList({})), [
    { id: 2, title: "買い物に行く", due: "2026-10-03", status: "open" },
    { id: 1, title: "牛乳を買う", due: null, status: "open" },
  ]);
  assert.deepEqual(parse(handlers.taskList({ limit: 1 })), [
    { id: 2, title: "買い物に行く", due: "2026-10-03", status: "open" },
  ]);

  assert.deepEqual(parse(handlers.taskComplete({ id: 2 })), {
    result: "completed",
    id: 2,
    title: "買い物に行く",
    due: "2026-10-03",
  });
  assert.deepEqual(parse(handlers.taskList({ status: "done" })), [
    { id: 2, title: "買い物に行く", due: "2026-10-03", status: "done", closed: "2026-10-02" },
  ]);
  assert.deepEqual(parse(handlers.taskList({})), [{ id: 1, title: "牛乳を買う", due: null, status: "open" }]);
});

test("task_complete: 存在しない id・完了済みはエラーにせずその旨を返す", (t) => {
  const handlers = createTaskToolHandlers(tempStore(t), TZ);
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

test("TaskStore.update: 題名・期限を変え、変更前と変更後を返す。null で期限を外す", (t) => {
  const store = tempStore(t);
  const task = store.add({ title: "歯医者を予約", due: "2026-10-05" });

  const renamed = store.update(1, { title: "歯医者に電話する", due: "2026-10-07" });
  assert.equal(renamed.result, "updated");
  assert.deepEqual(renamed.result === "updated" && renamed.before, task);
  assert.deepEqual(renamed.result === "updated" && renamed.after, {
    ...task,
    title: "歯医者に電話する",
    due: "2026-10-07",
  });

  const cleared = store.update(1, { due: null });
  assert.equal(cleared.result === "updated" && cleared.after.due, null);
  assert.equal(store.get(1)?.due, null);
  assert.equal(store.get(1)?.title, "歯医者に電話する");
  assert.equal(store.get(1)?.status, "open");
  assert.equal(store.get(1)?.completedAt, null);
});

test("TaskStore.update: 無い id は not_found、変わる項目が無ければ no_change で何も変えない", (t) => {
  const store = tempStore(t);
  const task = store.add({ title: "牛乳を買う", due: "2026-10-03" });

  assert.deepEqual(store.update(99, { title: "x" }), { result: "not_found" });
  assert.deepEqual(store.update(1, {}), { result: "no_change", task });
  assert.deepEqual(store.update(1, { title: "牛乳を買う", due: "2026-10-03", status: "open" }), {
    result: "no_change",
    task,
  });
  assert.deepEqual(store.get(1), task);
});

test("TaskStore.update: done・dropped で completed_at を今に、open に戻すと null。dropped は未完了の一覧に出ない", (t) => {
  const time = clock("2026-10-02T00:12:00Z");
  const store = tempStore(t, time.now);
  store.add({ title: "やめる" });
  store.add({ title: "残す" });

  time.set("2026-10-03T01:00:00Z");
  const dropped = store.update(1, { status: "dropped" });
  assert.equal(dropped.result, "updated");
  assert.equal(store.get(1)?.status, "dropped");
  assert.equal(store.get(1)?.completedAt, "2026-10-03T01:00:00.000Z");
  assert.deepEqual(
    store.list({ status: "open", limit: 20 }).map((task) => task.id),
    [2],
  );
  assert.deepEqual(
    store.list({ status: "dropped", limit: 20 }).map((task) => task.id),
    [1],
  );

  time.set("2026-10-04T02:00:00Z");
  store.update(1, { status: "open" });
  assert.equal(store.get(1)?.status, "open");
  assert.equal(store.get(1)?.completedAt, null);

  store.update(1, { status: "done" });
  assert.equal(store.get(1)?.status, "done");
  assert.equal(store.get(1)?.completedAt, "2026-10-04T02:00:00.000Z");
});

test("TaskStore.list: dueBy は期限がその日以前（期限切れと当日）だけ。期限なし・後の日・閉じたものは含まない", (t) => {
  const store = tempStore(t);
  store.add({ title: "期限なし" });
  store.add({ title: "当日", due: "2026-10-08" });
  store.add({ title: "期限切れ", due: "2026-10-01" });
  store.add({ title: "明日", due: "2026-10-09" });
  store.add({ title: "完了済み", due: "2026-10-02" });
  store.add({ title: "やめた", due: "2026-10-02" });
  store.complete(5);
  store.update(6, { status: "dropped" });

  assert.deepEqual(
    store.list({ status: "open", limit: 20, dueBy: "2026-10-08" }).map((task) => task.title),
    ["期限切れ", "当日"],
  );
  assert.deepEqual(
    store.list({ status: "open", limit: 1, dueBy: "2026-10-08" }).map((task) => task.title),
    ["期限切れ"],
  );
});

test("TaskStore.list: done・dropped は閉じた時刻の新しい順", (t) => {
  const time = clock("2026-10-02T00:00:00Z");
  const store = tempStore(t, time.now);
  for (const title of ["a", "b", "c"]) store.add({ title, due: "2026-10-01" });
  store.complete(2);
  time.set("2026-10-03T00:00:00Z");
  store.complete(1);
  time.set("2026-10-04T00:00:00Z");
  store.complete(3);
  store.add({ title: "x" });
  store.add({ title: "y" });
  store.update(5, { status: "dropped" });
  time.set("2026-10-05T00:00:00Z");
  store.update(4, { status: "dropped" });

  assert.deepEqual(
    store.list({ status: "done", limit: 20 }).map((task) => task.title),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    store.list({ status: "dropped", limit: 20 }).map((task) => task.title),
    ["x", "y"],
  );
});

test("task_update ハンドラ: before と after を返す。due を none にすると期限を外す。無い id は not_found、項目なしは no_change", (t) => {
  const handlers = createTaskToolHandlers(tempStore(t), TZ);
  handlers.taskAdd({ title: "歯医者を予約", due: "2026-10-05" });

  assert.deepEqual(parse(handlers.taskUpdate({ id: 1, title: "歯医者に電話する", due: "2026-10-07" })), {
    result: "updated",
    before: { id: 1, title: "歯医者を予約", due: "2026-10-05", status: "open" },
    after: { id: 1, title: "歯医者に電話する", due: "2026-10-07", status: "open" },
  });
  assert.deepEqual(parse(handlers.taskUpdate({ id: 1, due: "none" })), {
    result: "updated",
    before: { id: 1, title: "歯医者に電話する", due: "2026-10-07", status: "open" },
    after: { id: 1, title: "歯医者に電話する", due: null, status: "open" },
  });
  assert.deepEqual(parse(handlers.taskUpdate({ id: 1, status: "dropped" })), {
    result: "updated",
    before: { id: 1, title: "歯医者に電話する", due: null, status: "open" },
    after: { id: 1, title: "歯医者に電話する", due: null, status: "dropped" },
  });
  assert.deepEqual(parse(handlers.taskUpdate({ id: 42, title: "x" })), { result: "not_found", id: 42 });
  assert.deepEqual(parse(handlers.taskUpdate({ id: 1 })), {
    result: "no_change",
    id: 1,
    title: "歯医者に電話する",
    due: null,
    status: "dropped",
  });
});

test("task_list ハンドラ: dropped は既定（open）に出ず、status dropped で closed（タイムゾーンの日付）付きで返る。due_by で期限切れと当日の未完了だけ", (t) => {
  // UTC では 10/02、Asia/Tokyo では 10/03
  const handlers = createTaskToolHandlers(tempStore(t, () => new Date("2026-10-02T15:30:00Z")), TZ);
  handlers.taskAdd({ title: "期限なし" });
  handlers.taskAdd({ title: "当日", due: "2026-10-03" });
  handlers.taskAdd({ title: "期限切れ", due: "2026-10-01" });
  handlers.taskAdd({ title: "来週", due: "2026-10-10" });
  handlers.taskAdd({ title: "やめた", due: "2026-10-02" });
  handlers.taskUpdate({ id: 5, status: "dropped" });

  assert.deepEqual(parse(handlers.taskList({})), [
    { id: 3, title: "期限切れ", due: "2026-10-01", status: "open" },
    { id: 2, title: "当日", due: "2026-10-03", status: "open" },
    { id: 4, title: "来週", due: "2026-10-10", status: "open" },
    { id: 1, title: "期限なし", due: null, status: "open" },
  ]);
  assert.deepEqual(parse(handlers.taskList({ status: "dropped" })), [
    { id: 5, title: "やめた", due: "2026-10-02", status: "dropped", closed: "2026-10-03" },
  ]);
  assert.deepEqual(parse(handlers.taskList({ due_by: "2026-10-03" })), [
    { id: 3, title: "期限切れ", due: "2026-10-01", status: "open" },
    { id: 2, title: "当日", due: "2026-10-03", status: "open" },
  ]);
});

test("task_update・task_list ハンドラ: 日付の形式でない due・due_by は invalid_due・invalid_due_by で、何も変えない", (t) => {
  const store = tempStore(t);
  const handlers = createTaskToolHandlers(store, TZ);
  const task = store.add({ title: "歯医者を予約", due: "2026-10-05" });

  for (const due of ["tomorrow", "2026-10-5", "2026-02-30", ""]) {
    assert.deepEqual(parse(handlers.taskUpdate({ id: 1, title: "変えない", due })), { result: "invalid_due" }, due);
    assert.deepEqual(parse(handlers.taskList({ due_by: due })), { result: "invalid_due_by" }, due);
  }
  assert.deepEqual(store.get(1), task);
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
