import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AttachmentStore, NewAttachment } from "../src/store/attachments.ts";
import { createStores, tempDb } from "./helpers/db.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 14, 0, 0);

/** setDays で進める時計（START からの日数。小数も可）を持つストア */
function tempStore(t: TestContext): { store: AttachmentStore; setDays: (days: number) => void } {
  let days = 0;
  const { attachments: store } = createStores(tempDb(t), () => new Date(START + days * DAY_MS));
  return {
    store,
    setDays: (value) => {
      days = value;
    },
  };
}

function attachment(overrides: Partial<NewAttachment> = {}): NewAttachment {
  return {
    guildId: "g",
    channelId: "rt-1",
    messageId: "msg-1",
    path: "g/rt-1/msg-1-1.jpg",
    contentType: "image/jpeg",
    size: 2048,
    width: 1200,
    height: 1600,
    sha256: "ab".repeat(32),
    ...overrides,
  };
}

test("AttachmentStore: 追加・取得。幅・高さは省略できる", (t) => {
  const { store } = tempStore(t);
  const added = store.add(attachment());
  assert.deepEqual(added, {
    id: 1,
    guildId: "g",
    channelId: "rt-1",
    messageId: "msg-1",
    path: "g/rt-1/msg-1-1.jpg",
    contentType: "image/jpeg",
    size: 2048,
    width: 1200,
    height: 1600,
    sha256: "ab".repeat(32),
    recordId: null,
    createdAt: new Date(START).toISOString(),
    deletedAt: null,
  });
  assert.deepEqual(store.get(1), added);
  assert.equal(store.get(2), undefined);
  const noSize = store.add(attachment({ width: undefined, height: null }));
  assert.deepEqual([noSize.width, noSize.height], [null, null]);
});

test("AttachmentStore: linkToRecord はまだ結びついていないものだけを結びつけ、その数を返す（チャンネルは問わない）", (t) => {
  const { store } = tempStore(t);
  const a = store.add(attachment()).id;
  const b = store.add(attachment({ channelId: "inbox-1" })).id;
  const c = store.add(attachment()).id;
  const cases: Array<[label: string, ids: number[], recordId: number, expected: number]> = [
    ["空", [], 1, 0],
    ["2 つ（別のチャンネルの添付も）", [a, b], 1, 2],
    ["結びついたものは移さない", [a, c], 2, 1],
    ["無い id", [999], 3, 0],
  ];
  for (const [label, ids, recordId, expected] of cases) {
    assert.equal(store.linkToRecord(ids, recordId), expected, label);
  }
  assert.deepEqual(store.listByRecord(1).map((x) => x.id), [a, b]);
  assert.deepEqual(store.listByRecord(2).map((x) => x.id), [c]);
  assert.deepEqual(store.listByRecord(3), []);
});

test("AttachmentStore: listUnlinkedOlderThan は結びついていない、days 日より前のものを古い順に返し、delete で行が消える", (t) => {
  const { store, setDays } = tempStore(t);
  const old = store.add(attachment()).id;
  setDays(1);
  const linkedOld = store.add(attachment()).id;
  store.linkToRecord([linkedOld], 1);
  setDays(5);
  const recent = store.add(attachment()).id;

  const cases: Array<[label: string, now: number, days: number, expected: number[]]> = [
    ["まだ 30 日経っていない", 29, 30, []],
    ["ちょうど 30 日は含めない", 30, 30, []],
    ["30 日を過ぎた", 30.5, 30, [old]],
    ["どれも過ぎた（結びついたものは除く）", 40, 30, [old, recent]],
    ["0 日なら今より前のすべて", 5.001, 0, [old, recent]],
  ];
  for (const [label, now, days, expected] of cases) {
    setDays(now);
    assert.deepEqual(store.listUnlinkedOlderThan(days).map((x) => x.id), expected, label);
  }

  assert.equal(store.delete(old), true);
  assert.equal(store.delete(old), false);
  assert.equal(store.get(old), undefined);
  setDays(40);
  assert.deepEqual(store.listUnlinkedOlderThan(30).map((x) => x.id), [recent]);
});

test("AttachmentStore: path は <dataDir>/attachments からの相対パスだけで、絶対パス・.. を含むものは例外にして行を作らない", (t) => {
  const { store } = tempStore(t);
  const cases: Array<[label: string, path: string, ok: boolean]> = [
    ["相対パス", "g/rt-1/msg-1-1.jpg", true],
    ["名前に .. を含むだけ", "g/rt-1/a..b.jpg", true],
    ["絶対パス", "/home/user/.local/share/self-agent/data/attachments/g/x.jpg", false],
    [".. の要素", "g/../../secret.jpg", false],
    ["先頭の ..", "../x.jpg", false],
  ];
  for (const [label, path, ok] of cases) {
    if (ok) assert.equal(store.add(attachment({ path })).path, path, label);
    else assert.throws(() => store.add(attachment({ path })), /相対パス/, label);
  }
  assert.equal(store.get(3), undefined);
});
