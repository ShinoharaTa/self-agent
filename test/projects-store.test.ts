import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/store/db.ts";
import { ProjectStore, toSlug } from "../src/store/projects.ts";

const T0 = Date.UTC(2026, 9, 7, 0, 0);
const MINUTE = 60_000;

function tempStore(t: TestContext): ProjectStore {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return new ProjectStore(db);
}

test("toSlug: 小文字にし、英小文字・数字以外を - に、連続する - を 1 つに、前後の - を除く", () => {
  assert.equal(toSlug("Kakeibo"), "kakeibo");
  assert.equal(toSlug("My Todo App!"), "my-todo-app");
  assert.equal(toSlug("a  --  b__c"), "a-b-c");
  assert.equal(toSlug("--hello--"), "hello");
  assert.equal(toSlug("  2048 Game  "), "2048-game");
  assert.equal(toSlug("家計簿 tracker"), "tracker");
  assert.equal(toSlug("Café Menu"), "caf-menu");
});

test("toSlug: 30 字に切り、切った末尾の - も除く", () => {
  assert.equal(toSlug("a".repeat(40)), "a".repeat(30));
  // 31 字の "aaa…a-b" を 30 字に切ると末尾が - になる
  assert.equal(toSlug(`${"a".repeat(29)} b`), "a".repeat(29));
  assert.equal(toSlug("a".repeat(30)), "a".repeat(30));
});

test("toSlug: 3 字未満なら app", () => {
  for (const name of ["", "ab", "!!", "日本語", "-a-", "  x  "]) {
    assert.equal(toSlug(name), "app", name);
  }
  assert.equal(toSlug("abc"), "abc");
  assert.equal(toSlug("a-b-c"), "a-b-c");
});

test("ProjectStore: 作ったプロジェクトを返し、チャンネル・slug・id で引ける", (t) => {
  const store = tempStore(t);
  assert.deepEqual(store.list(), []);

  const project = store.create({ guildId: "guild-1", channelId: "ch-1", name: "Kakeibo", title: "  家計簿  ", now: T0 });
  assert.deepEqual(project, {
    id: 1,
    guildId: "guild-1",
    channelId: "ch-1",
    slug: "kakeibo",
    title: "家計簿",
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
  });
  assert.deepEqual(store.getByChannel("ch-1"), project);
  assert.deepEqual(store.getBySlug("kakeibo"), project);
  assert.deepEqual(store.get(1), project);
  assert.equal(store.getByChannel("ch-2"), undefined);
  assert.equal(store.getBySlug("other"), undefined);
  assert.equal(store.get(2), undefined);
});

test("ProjectStore: 題名は前後の空白を除いて 100 字まで、空なら slug", (t) => {
  const store = tempStore(t);
  const long = store.create({ guildId: "g", channelId: "ch-1", name: "long", title: ` ${"あ".repeat(120)} `, now: T0 });
  assert.equal(long.title, "あ".repeat(100));
  const empty = store.create({ guildId: "g", channelId: "ch-2", name: "Empty Title", title: "   ", now: T0 });
  assert.equal(empty.title, "empty-title");
});

test("ProjectStore: slug が重なれば -2、-3… を付ける", (t) => {
  const store = tempStore(t);
  const slugs = [1, 2, 3].map(
    (n) => store.create({ guildId: "g", channelId: `ch-${n}`, name: "Kakeibo", title: "家計簿", now: T0 }).slug,
  );
  assert.deepEqual(slugs, ["kakeibo", "kakeibo-2", "kakeibo-3"]);

  // 3 字未満の名前はすべて app になり、連番で分ける
  const apps = Array.from(
    { length: 10 },
    (_, i) => store.create({ guildId: "g", channelId: `app-${i}`, name: "x", title: "", now: T0 }).slug,
  );
  assert.deepEqual(apps, ["app", ...Array.from({ length: 9 }, (_, i) => `app-${i + 2}`)]);
});

test("ProjectStore: 連番を付けても 30 字以内に収まるよう本体を切り詰め、切った末尾の - は除く", (t) => {
  const store = tempStore(t);
  const long = "a".repeat(30);
  const slugs = Array.from(
    { length: 10 },
    (_, i) => store.create({ guildId: "g", channelId: `long-${i}`, name: long, title: "", now: T0 }).slug,
  );
  assert.equal(slugs[0], long);
  assert.equal(slugs[1], `${"a".repeat(28)}-2`);
  assert.equal(slugs[9], `${"a".repeat(27)}-10`);
  for (const slug of slugs) assert.ok(slug.length <= 30, slug);

  // 本体を 28 字に切ると末尾が - になる名前
  const dashed = `${"b".repeat(27)}-cd`;
  assert.equal(store.create({ guildId: "g", channelId: "dash-1", name: dashed, title: "", now: T0 }).slug, dashed);
  assert.equal(
    store.create({ guildId: "g", channelId: "dash-2", name: dashed, title: "", now: T0 }).slug,
    `${"b".repeat(27)}-2`,
  );
});

test("ProjectStore: 削除済みの slug とも重ならず、削除済みは slug・チャンネルでは引けないが id では引ける", (t) => {
  const store = tempStore(t);
  const first = store.create({ guildId: "g", channelId: "ch-1", name: "kakeibo", title: "家計簿", now: T0 });
  assert.equal(store.markDeleted(first.id, T0 + MINUTE), true);

  const second = store.create({ guildId: "g", channelId: "ch-2", name: "kakeibo", title: "家計簿", now: T0 + 2 * MINUTE });
  assert.equal(second.slug, "kakeibo-2");
  assert.equal(store.getBySlug("kakeibo"), undefined);
  assert.equal(store.getByChannel("ch-1"), undefined);
  assert.deepEqual(store.get(first.id), { ...first, deletedAt: T0 + MINUTE });
});

test("ProjectStore: 削除されていないプロジェクトは同じチャンネルに 2 つ作れないが、削除した後は作れる", (t) => {
  const store = tempStore(t);
  const first = store.create({ guildId: "g", channelId: "ch-1", name: "first", title: "", now: T0 });
  assert.throws(
    () => store.create({ guildId: "g", channelId: "ch-1", name: "second", title: "", now: T0 }),
    /UNIQUE/,
  );
  assert.deepEqual(store.getByChannel("ch-1"), first);

  assert.equal(store.markDeleted(first.id, T0 + MINUTE), true);
  const second = store.create({ guildId: "g", channelId: "ch-1", name: "second", title: "", now: T0 + 2 * MINUTE });
  assert.equal(second.slug, "second");
  assert.deepEqual(store.getByChannel("ch-1"), second);
});

test("ProjectStore: list は削除されていないものを updated_at の新しい順（同じなら id の大きい順）に返す", (t) => {
  const store = tempStore(t);
  const a = store.create({ guildId: "g", channelId: "ch-a", name: "aaa", title: "", now: T0 });
  store.create({ guildId: "g", channelId: "ch-b", name: "bbb", title: "", now: T0 + MINUTE });
  const c = store.create({ guildId: "g", channelId: "ch-c", name: "ccc", title: "", now: T0 + 2 * MINUTE });
  store.create({ guildId: "g", channelId: "ch-d", name: "ddd", title: "", now: T0 + 2 * MINUTE });
  assert.deepEqual(
    store.list().map((project) => project.slug),
    ["ddd", "ccc", "bbb", "aaa"],
  );

  store.touch(a.id, T0 + 3 * MINUTE);
  assert.equal(store.get(a.id)?.updatedAt, T0 + 3 * MINUTE);
  assert.equal(store.get(a.id)?.createdAt, T0);
  store.markDeleted(c.id, T0 + 4 * MINUTE);
  assert.deepEqual(
    store.list().map((project) => project.slug),
    ["aaa", "ddd", "bbb"],
  );

  // 削除済みは touch しても変わらない
  store.touch(c.id, T0 + 5 * MINUTE);
  assert.equal(store.get(c.id)?.updatedAt, T0 + 2 * MINUTE);
});

test("ProjectStore: markDeleted は削除したときだけ true。既に削除済み・無い id なら false で、削除した時刻は変えない", (t) => {
  const store = tempStore(t);
  const project = store.create({ guildId: "g", channelId: "ch-1", name: "kakeibo", title: "", now: T0 });
  assert.equal(store.markDeleted(project.id, T0 + MINUTE), true);
  assert.equal(store.markDeleted(project.id, T0 + 2 * MINUTE), false);
  assert.equal(store.get(project.id)?.deletedAt, T0 + MINUTE);
  assert.equal(store.markDeleted(999, T0), false);
});
