import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { LocalIdStore } from "../src/store/local-places.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const NOW = new Date("2026-11-28T01:00:00.000Z");

test("openDb: v48 の DB を開くと最新（v49 以上）に上がり、今ある話題と入口の行の place はすべて discord。local_ids は空で使える", (t) => {
  const path = join(tempDir(t), "self-agent.db");
  const before = MIGRATIONS.findIndex((migration) => migration.includes("CREATE TABLE local_ids"));
  assert.equal(before, 48);
  const old = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
  old.exec(`PRAGMA user_version = ${before}`);
  old.exec(
    "INSERT INTO sessions (channel_id, guild_id, title, state, category_id, created_at, last_activity_at) VALUES " +
      "('topic-1', 'guild-1', '旅行の計画', 'active', 'active-1', 'a', 'a'), " +
      "('topic-2', 'guild-1', '片付け', 'deleted', 'done-1', 'a', 'a')",
  );
  old.exec(
    "INSERT INTO persona_channels (guild_id, persona, kind, channel_id, created_at, updated_at) VALUES " +
      "('guild-1', 'default', 'inbox', 'inbox-1', 'a', 'a'), ('guild-1', 'default', 'tasks', 'tasks-1', 'a', 'a'), " +
      "('guild-1', 'mika', 'inbox', 'mika-in', 'a', 'a')",
  );
  // 変える 2 つの表と足す表のほかの表・索引の定義
  const others = "SELECT name, sql FROM sqlite_master WHERE tbl_name NOT IN ('sessions', 'persona_channels', 'local_ids') ORDER BY name";
  const defsBefore = old.prepare(others).all().map((row) => ({ ...row }));
  const columnsOf = (target: DatabaseSync, table: string) =>
    target
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => [String(column.name), String(column.type), Number(column.notnull), column.dflt_value, Number(column.pk)]);
  const sessionColumnsBefore = columnsOf(old, "sessions");
  const entryColumnsBefore = columnsOf(old, "persona_channels");
  old.close();

  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.deepEqual(db.prepare(others).all().map((row) => ({ ...row })), defsBefore);
  // 2 つの表は末尾に place（TEXT・NOT NULL・既定 'discord'）が足されただけ。local_ids は連番の 1 列
  const place = ["place", "TEXT", 1, "'discord'", 0];
  assert.deepEqual(columnsOf(db, "sessions"), [...sessionColumnsBefore, place]);
  assert.deepEqual(columnsOf(db, "persona_channels"), [...entryColumnsBefore, place]);
  assert.deepEqual(columnsOf(db, "local_ids"), [["id", "INTEGER", 0, null, 1]]);
  const places = (table: string): string[] =>
    db
      .prepare(`SELECT place FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => String(row.place));
  assert.deepEqual(places("sessions"), ["discord", "discord"]);
  assert.deepEqual(places("persona_channels"), ["discord", "discord", "discord"]);
  const topics = new TopicSessionStore(db, () => NOW);
  assert.equal(topics.get("topic-1")?.place, "discord");
  assert.equal(topics.get("topic-2")?.place, "discord");
  const guildSettings = new GuildSettingsStore(db, () => NOW);
  assert.equal(guildSettings.entryChannel("tasks-1")?.place, "discord");
  assert.equal(guildSettings.personaInbox("guild-1", "mika")?.place, "discord");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM local_ids").get()!.n), 0);
  assert.match(new LocalIdStore(db).next(), /^1\d{20}$/);
});

test("place: 新しい行の既定は discord。discord と local のほかは DB が拒む", (t) => {
  const db = tempDb(t);
  const topics = new TopicSessionStore(db, () => NOW);
  topics.create({ channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" });
  const guildSettings = new GuildSettingsStore(db, () => NOW);
  guildSettings.setPersonaInbox("guild-1", "mika", "mika-in");
  assert.equal(topics.get("topic-1")?.place, "discord");
  assert.equal(guildSettings.personaInbox("guild-1", "mika")?.place, "discord");

  assert.throws(() => db.prepare("UPDATE sessions SET place = 'web' WHERE channel_id = 'topic-1'").run(), /CHECK/);
  assert.throws(() => db.prepare("UPDATE persona_channels SET place = 'web' WHERE channel_id = 'mika-in'").run(), /CHECK/);
});

test("TopicSessionStore: place を local で保存すると読める（ほかの列は今と同じ）", (t) => {
  const db = tempDb(t);
  const topics = new TopicSessionStore(db, () => NOW);
  const id = new LocalIdStore(db).next();

  const created = topics.create({ channelId: id, guildId: "guild-1", title: "調べ物", categoryId: "local", place: "local" });

  assert.equal(created.place, "local");
  assert.equal(created.categoryId, "local");
  assert.equal(created.state, "active");
  assert.deepEqual(topics.get(id), created);
});

test("GuildSettingsStore.setPersonaInbox: place を渡したときだけ場所を書き、省略すれば今の場所のまま", (t) => {
  const db = tempDb(t);
  const guildSettings = new GuildSettingsStore(db, () => NOW);
  const id = new LocalIdStore(db).next();

  guildSettings.setPersonaInbox("guild-1", "sora", id, "local");
  assert.deepEqual(guildSettings.entryChannel(id), { guildId: "guild-1", persona: "sora", kind: "inbox", place: "local" });
  assert.deepEqual(guildSettings.personaInbox("guild-1", "sora"), { channelId: id, rotatedDate: null, rotatedAt: null, place: "local" });

  // 切り替えの日・時刻を書いても、place を省いて番号を書き直しても、場所は変わらない
  guildSettings.setInboxRotated("guild-1", "2026-11-28", NOW, "sora");
  guildSettings.setPersonaInbox("guild-1", "sora", id);
  assert.equal(guildSettings.personaInbox("guild-1", "sora")?.place, "local");
  guildSettings.setPersonaInbox("guild-1", "sora", id, "discord");
  assert.equal(guildSettings.personaInbox("guild-1", "sora")?.place, "discord");
});

test("LocalIdStore.next: 先頭が 1 の数字 21 桁で、続けて取ると違う値（連番。取った行は残さず、DB を開き直しても使い直さない）", (t) => {
  const path = join(tempDir(t), "self-agent.db");
  const first = openDb(path);
  const ids = new LocalIdStore(first);
  const taken = [ids.next(), ids.next(), ids.next()];
  for (const id of taken) assert.match(id, /^1\d{20}$/);
  assert.equal(new Set(taken).size, 3);
  assert.deepEqual(taken, ["100000000000000000001", "100000000000000000002", "100000000000000000003"]);
  // Discord の ID（64 ビット。20 桁まで）より長い
  for (const id of taken) assert.ok(BigInt(id) > 2n ** 64n - 1n, id);
  assert.equal(Number(first.prepare("SELECT COUNT(*) AS n FROM local_ids").get()!.n), 0);
  first.close();

  const reopened = openDb(path);
  t.after(() => reopened.close());
  assert.equal(new LocalIdStore(reopened).next(), "100000000000000000004");
});
