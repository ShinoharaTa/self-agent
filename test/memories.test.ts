import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.ts";
import { MemoryStore } from "../src/store/memories.ts";

/** 呼ぶたびに 1 分進む時計 */
function clock(): () => Date {
  let minutes = 0;
  return () => new Date(Date.UTC(2026, 9, 7, 0, minutes++));
}

function tempStore(t: TestContext): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return new MemoryStore(db, clock());
}

test("MemoryStore: 追加すると有効な記憶として id 順に並ぶ", (t) => {
  const store = tempStore(t);
  assert.deepEqual(store.list(), []);
  assert.equal(store.countActive(), 0);

  const first = store.add("住んでいる地域: 東京都練馬区", "inbox-1");
  assert.deepEqual(first, {
    id: 1,
    text: "住んでいる地域: 東京都練馬区",
    channelId: "inbox-1",
    createdAt: "2026-10-07T00:00:00.000Z",
    deletedAt: null,
  });
  const second = store.add("仕事: Web エンジニア");
  assert.equal(second.channelId, null);
  assert.deepEqual(store.list(), [first, second]);
  assert.equal(store.countActive(), 2);
});

test("MemoryStore: 論理削除した記憶は一覧と有効件数から外れ、復元すると元の位置に戻る。既にその状態なら何もしない", (t) => {
  const store = tempStore(t);
  store.add("A");
  store.add("B");
  store.add("C");

  const deleted = store.softDelete(2);
  assert.equal(deleted?.text, "B");
  assert.equal(deleted?.deletedAt, "2026-10-07T00:03:00.000Z");
  assert.deepEqual(
    store.list().map((memory) => memory.text),
    ["A", "C"],
  );
  assert.equal(store.countActive(), 2);
  // 消した記憶をもう一度消す・有効な記憶を復元する・無い id は undefined
  assert.equal(store.softDelete(2), undefined);
  assert.equal(store.restore(1), undefined);
  assert.equal(store.softDelete(99), undefined);
  assert.equal(store.restore(99), undefined);
  assert.equal(store.countActive(), 2);

  const restored = store.restore(2);
  assert.deepEqual(restored, {
    id: 2,
    text: "B",
    channelId: null,
    createdAt: "2026-10-07T00:01:00.000Z",
    deletedAt: null,
  });
  assert.equal(store.restore(2), undefined);
  assert.deepEqual(
    store.list().map((memory) => memory.text),
    ["A", "B", "C"],
  );
  assert.equal(store.countActive(), 3);
});
