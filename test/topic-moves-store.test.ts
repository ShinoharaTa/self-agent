import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { TopicMoveStore } from "../src/store/topic-moves.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const NOW = new Date("2026-11-14T01:00:00Z");
const LATER = new Date("2026-11-14T01:05:00Z");

function setup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: NOW };
  const now = (): Date => clock.now;
  return { db, clock, moves: new TopicMoveStore(db, now), topicSessions: new TopicSessionStore(db, now) };
}

const MOVE = { channelId: "topic-1", fromDir: null, toDir: "alpha", by: "web" } as const;

function count(db: DatabaseSync): number {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM topic_moves").get()!.n);
}

test("openDb: 新しい DB に topic_moves があり、user_version は MIGRATIONS.length", (t) => {
  const { db } = setup(t);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.equal(count(db), 0);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'topic_moves'").all().map((row) => row.name);
  assert.ok(indexes.includes("topic_moves_running"));
  assert.ok(indexes.includes("topic_moves_channel"));
});

test("openDb: topic_moves の移行の手前までの DB を上げても sessions の行は残り、topic_moves は空で使える", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const before = MIGRATIONS.findIndex((migration) => migration.includes("CREATE TABLE topic_moves"));
  assert.ok(before > 0);
  const old = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
  old.exec(`PRAGMA user_version = ${before}`);
  old.exec(
    "INSERT INTO sessions (channel_id, guild_id, title, state, category_id, created_at, last_activity_at) " +
      "VALUES ('topic-1', 'guild-1', '旅行の計画', 'active', 'active-1', 'a', 'a')",
  );
  old.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.equal(new TopicSessionStore(db).get("topic-1")?.title, "旅行の計画");
  assert.equal(count(db), 0);
  const moves = new TopicMoveStore(db, () => NOW);
  const id = moves.start(MOVE);
  assert.equal(moves.get(id!)?.state, "running");
});

test("topic_moves: state・by が決めた値でなければ入らない", (t) => {
  const { db } = setup(t);
  const insert = (state: string, by: string) =>
    db
      .prepare("INSERT INTO topic_moves (channel_id, to_dir, state, by, created_at) VALUES ('topic-1', 'alpha', ?, ?, 'a')")
      .run(state, by);
  assert.throws(() => insert("moving", "web"), /CHECK constraint failed/);
  assert.throws(() => insert("done", "owner"), /CHECK constraint failed/);
  for (const state of ["proposed", "done", "cancelled", "failed"]) insert(state, "right_hand");
  insert("running", "discord");
  assert.equal(count(db), 5);
});

test("TopicMoveStore.start: running の行を足して id を返す。同じチャンネルに running があれば undefined で、行は増えない。別のチャンネルは足せる", (t) => {
  const { db, moves } = setup(t);
  const id = moves.start(MOVE);
  assert.ok(id !== undefined);
  assert.deepEqual(moves.get(id), {
    id,
    channelId: "topic-1",
    fromDir: null,
    toDir: "alpha",
    state: "running",
    by: "web",
    note: null,
    createdAt: NOW.toISOString(),
    doneAt: null,
  });
  assert.equal(moves.start({ ...MOVE, toDir: "beta", by: "discord" }), undefined);
  assert.equal(count(db), 1);
  const other = moves.start({ ...MOVE, channelId: "topic-2", fromDir: "alpha", toDir: "beta" });
  assert.ok(other !== undefined && other !== id);
  assert.equal(moves.get(other)?.fromDir, "alpha");
  assert.equal(count(db), 2);
});

test("TopicMoveStore.start: done・failed の行があるチャンネルには足せる", (t) => {
  const { moves } = setup(t);
  const first = moves.start(MOVE)!;
  moves.finish(first, null, () => {});
  const second = moves.start(MOVE)!;
  moves.fail(second);
  const third = moves.start(MOVE);
  assert.ok(third !== undefined);
  assert.equal(moves.get(third)?.state, "running");
});

test("TopicMoveStore.finish: apply の書き込みと done・note・done_at が一緒に入る", (t) => {
  const { clock, moves, topicSessions } = setup(t);
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" });
  const id = moves.start(MOVE)!;
  clock.now = LATER;
  moves.finish(id, "- 要点", () => {
    topicSessions.setProject("topic-1", "alpha", "default");
  });
  assert.equal(topicSessions.projectDirOf("topic-1")?.projectDir, "alpha");
  const row = moves.get(id)!;
  assert.equal(row.state, "done");
  assert.equal(row.note, "- 要点");
  assert.equal(row.doneAt, LATER.toISOString());
  assert.equal(row.createdAt, NOW.toISOString());
});

test("TopicMoveStore.finish: apply が投げたら apply の途中までの書き込みも戻り、行は running のまま。例外は呼び出し側に出る", (t) => {
  const { moves, topicSessions } = setup(t);
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" });
  const id = moves.start(MOVE)!;
  assert.throws(
    () =>
      moves.finish(id, "- 要点", () => {
        topicSessions.setProject("topic-1", "alpha", "default");
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(topicSessions.projectDirOf("topic-1"), undefined);
  assert.equal(moves.get(id)?.state, "running");
  assert.equal(moves.get(id)?.note, null);
});

test("TopicMoveStore.finish: running でない行なら投げ、apply の書き込みは戻る", (t) => {
  const { moves, topicSessions } = setup(t);
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" });
  const id = moves.start(MOVE)!;
  moves.fail(id);
  assert.throws(() => moves.finish(id, null, () => topicSessions.setProject("topic-1", "alpha", "default")));
  assert.equal(topicSessions.projectDirOf("topic-1"), undefined);
  assert.equal(moves.get(id)?.state, "failed");
  assert.throws(() => moves.finish(999, null, () => {}));
});

test("TopicMoveStore.fail: running を failed に。done の行は変えない", (t) => {
  const { clock, moves } = setup(t);
  const id = moves.start(MOVE)!;
  clock.now = LATER;
  moves.fail(id);
  assert.equal(moves.get(id)?.state, "failed");
  assert.equal(moves.get(id)?.doneAt, LATER.toISOString());
  const done = moves.start(MOVE)!;
  moves.finish(done, "- 要点", () => {});
  moves.fail(done);
  assert.equal(moves.get(done)?.state, "done");
  assert.equal(moves.get(done)?.note, "- 要点");
});

test("TopicMoveStore.runningChannels・running: running の行だけ", (t) => {
  const { moves } = setup(t);
  const a = moves.start(MOVE)!;
  const b = moves.start({ ...MOVE, channelId: "topic-2" })!;
  const c = moves.start({ ...MOVE, channelId: "topic-3" })!;
  moves.finish(b, null, () => {});
  moves.fail(c);
  assert.deepEqual(moves.runningChannels(), new Set(["topic-1"]));
  assert.equal(moves.running("topic-1")?.id, a);
  assert.equal(moves.running("topic-2"), undefined);
  assert.equal(moves.running("topic-3"), undefined);
});

test("TopicMoveStore.failInterrupted: running をすべて failed にして返す。done・failed は触らない。2 回目は空", (t) => {
  const { clock, moves } = setup(t);
  const a = moves.start(MOVE)!;
  const done = moves.start({ ...MOVE, channelId: "topic-2" })!;
  moves.finish(done, null, () => {});
  const failed = moves.start({ ...MOVE, channelId: "topic-3" })!;
  moves.fail(failed);
  const b = moves.start({ ...MOVE, channelId: "topic-4" })!;
  clock.now = LATER;
  const rows = moves.failInterrupted();
  assert.deepEqual(
    rows.map((row) => [row.id, row.state, row.doneAt]),
    [
      [a, "failed", LATER.toISOString()],
      [b, "failed", LATER.toISOString()],
    ],
  );
  assert.equal(moves.get(done)?.state, "done");
  assert.equal(moves.get(failed)?.doneAt, NOW.toISOString());
  assert.deepEqual(moves.failInterrupted(), []);
});
