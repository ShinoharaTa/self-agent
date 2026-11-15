import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { HistoryStore } from "../src/store/history.ts";
import { TopicReadStore } from "../src/store/topic-reads.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const NOW = new Date("2026-11-15T01:00:00Z");
const LATER = new Date("2026-11-15T01:05:00Z");

function setup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: NOW };
  const now = (): Date => clock.now;
  return { db, clock, reads: new TopicReadStore(db, now) };
}

function row(db: DatabaseSync, channelId: string): { lastReadId: number; updatedAt: string } | undefined {
  const found = db.prepare("SELECT last_read_id, updated_at FROM topic_reads WHERE channel_id = ?").get(channelId);
  return found === undefined ? undefined : { lastReadId: Number(found.last_read_id), updatedAt: String(found.updated_at) };
}

function count(db: DatabaseSync): number {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM topic_reads").get()!.n);
}

test("openDb: 新しい DB に topic_reads があり、user_version は MIGRATIONS.length", (t) => {
  const { db } = setup(t);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.equal(count(db), 0);
});

test("openDb: topic_reads の移行の手前までの DB を上げても history の行は残り、topic_reads は空で使える", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const before = MIGRATIONS.findIndex((migration) => migration.includes("CREATE TABLE topic_reads"));
  assert.ok(before > 0);
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
  const reads = new TopicReadStore(db, () => NOW);
  assert.equal(reads.advance("topic-1", 3), 3);
  assert.equal(reads.get("topic-1"), 3);
});

test("TopicReadStore.get: 行が無ければ 0", (t) => {
  const { reads } = setup(t);
  assert.equal(reads.get("topic-1"), 0);
});

test("TopicReadStore.advance: 初めは足し、大きい値で進んで updated_at が変わり、同じ・小さい値では値も updated_at も変わらない", (t) => {
  const { db, clock, reads } = setup(t);
  assert.equal(reads.advance("topic-1", 5), 5);
  assert.deepEqual(row(db, "topic-1"), { lastReadId: 5, updatedAt: NOW.toISOString() });

  clock.now = LATER;
  assert.equal(reads.advance("topic-1", 8), 8);
  assert.deepEqual(row(db, "topic-1"), { lastReadId: 8, updatedAt: LATER.toISOString() });

  clock.now = new Date("2026-11-15T01:10:00Z");
  assert.equal(reads.advance("topic-1", 8), 8);
  assert.equal(reads.advance("topic-1", 2), 8);
  assert.deepEqual(row(db, "topic-1"), { lastReadId: 8, updatedAt: LATER.toISOString() });
  assert.equal(count(db), 1);
});

test("TopicReadStore.advance: 0・負・小数・NaN・安全な整数を超える値は RangeError で、行を作らない", (t) => {
  const { db, reads } = setup(t);
  for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => reads.advance("topic-1", value), RangeError);
  }
  assert.equal(count(db), 0);
});

test("TopicReadStore.all: 全部の行の Map", (t) => {
  const { reads } = setup(t);
  assert.deepEqual(reads.all(), new Map());
  reads.advance("topic-1", 3);
  reads.advance("topic-2", 7);
  assert.deepEqual(reads.all(), new Map([["topic-1", 3], ["topic-2", 7]]));
});
