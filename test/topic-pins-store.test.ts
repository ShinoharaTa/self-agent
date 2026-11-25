import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { HistoryStore } from "../src/store/history.ts";
import { TopicPinStore } from "../src/store/topic-pins.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const NOW = new Date("2026-11-25T01:00:00Z");
const LATER = new Date("2026-11-25T01:05:00Z");

function setup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: NOW };
  const now = (): Date => clock.now;
  return { db, clock, pins: new TopicPinStore(db, now) };
}

function row(db: DatabaseSync, channelId: string): { position: number; createdAt: string } | undefined {
  const found = db.prepare("SELECT position, created_at FROM topic_pins WHERE channel_id = ?").get(channelId);
  return found === undefined ? undefined : { position: Number(found.position), createdAt: String(found.created_at) };
}

function count(db: DatabaseSync): number {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM topic_pins").get()!.n);
}

test("openDb: 新しい DB は v48 以上で topic_pins があり、user_version は MIGRATIONS.length", (t) => {
  const { db } = setup(t);
  assert.ok(MIGRATIONS.length >= 48);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.equal(count(db), 0);
});

test("openDb: v47 の DB を開くと最新（v48 以上）に上がり、今ある history の行は残り、topic_pins は空で使える", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const before = MIGRATIONS.findIndex((migration) => migration.includes("CREATE TABLE topic_pins"));
  assert.equal(before, 47);
  const old = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
  old.exec(`PRAGMA user_version = ${before}`);
  old.exec(
    "INSERT INTO history (guild_id, channel_id, kind, source, text, at) VALUES ('guild-1', 'topic-1', 'owner', 'web', 'こんにちは', 'a')",
  );
  old.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.equal(new HistoryStore(db).list("topic-1", { limit: 10 })[0]?.text, "こんにちは");
  assert.equal(count(db), 0);
  // 3 列の名前・型・NOT NULL・主キー（channel_id が主キー、position と created_at は NOT NULL）
  assert.deepEqual(
    db
      .prepare("PRAGMA table_info(topic_pins)")
      .all()
      .map((column) => [String(column.name), String(column.type), Number(column.notnull), Number(column.pk)]),
    [
      ["channel_id", "TEXT", 0, 1],
      ["position", "INTEGER", 1, 0],
      ["created_at", "TEXT", 1, 0],
    ],
  );
  const pins = new TopicPinStore(db, () => NOW);
  pins.add("topic-1");
  assert.deepEqual(pins.all(), ["topic-1"]);
});

test("TopicPinStore.add: 足した順に並び、position は 1 から順に振られ、created_at は今の時刻", (t) => {
  const { db, clock, pins } = setup(t);
  assert.deepEqual(pins.all(), []);
  pins.add("topic-3");
  clock.now = LATER;
  pins.add("topic-1");
  pins.add("topic-2");
  assert.deepEqual(pins.all(), ["topic-3", "topic-1", "topic-2"]);
  assert.deepEqual(row(db, "topic-3"), { position: 1, createdAt: NOW.toISOString() });
  assert.deepEqual(row(db, "topic-2"), { position: 3, createdAt: LATER.toISOString() });
});

test("TopicPinStore.add: 同じ物を 2 回足しても 1 つで、順も position も created_at も変わらない", (t) => {
  const { db, clock, pins } = setup(t);
  pins.add("topic-1");
  pins.add("topic-2");
  clock.now = LATER;
  pins.add("topic-1");
  assert.deepEqual(pins.all(), ["topic-1", "topic-2"]);
  assert.deepEqual(row(db, "topic-1"), { position: 1, createdAt: NOW.toISOString() });
  assert.equal(count(db), 2);
});

test("TopicPinStore.remove: 外して足し直すと末尾。無い物を外しても投げない", (t) => {
  const { pins } = setup(t);
  pins.add("topic-1");
  pins.add("topic-2");
  pins.add("topic-3");
  pins.remove("topic-1");
  assert.deepEqual(pins.all(), ["topic-2", "topic-3"]);
  pins.add("topic-1");
  assert.deepEqual(pins.all(), ["topic-2", "topic-3", "topic-1"]);
  assert.doesNotThrow(() => pins.remove("topic-9"));
  assert.deepEqual(pins.all(), ["topic-2", "topic-3", "topic-1"]);
});

test("TopicPinStore.all: position が同じなら created_at・channel_id の順", (t) => {
  const { db, pins } = setup(t);
  const insert = db.prepare("INSERT INTO topic_pins (channel_id, position, created_at) VALUES (?, ?, ?)");
  insert.run("topic-b", 1, LATER.toISOString());
  insert.run("topic-c", 1, NOW.toISOString());
  insert.run("topic-a", 1, LATER.toISOString());
  insert.run("topic-0", 2, NOW.toISOString());
  assert.deepEqual(pins.all(), ["topic-c", "topic-a", "topic-b", "topic-0"]);
});

test("TopicPinStore.has: 留めている物だけ true", (t) => {
  const { pins } = setup(t);
  assert.equal(pins.has("topic-1"), false);
  pins.add("topic-1");
  assert.equal(pins.has("topic-1"), true);
  assert.equal(pins.has("topic-2"), false);
  pins.remove("topic-1");
  assert.equal(pins.has("topic-1"), false);
});
