import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupBeforeMigration, backupPath, MIGRATIONS, openDb } from "../src/store/db.ts";
import { HISTORY_LIST_MAX, HISTORY_STEPS_MAX, HISTORY_TEXT_MAX_LENGTH, HistoryStore, recordHistory } from "../src/store/history.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const BASE = Date.parse("2026-10-01T00:00:00.000Z");

/** BASE から minutes 分後 */
function at(minutes: number): Date {
  return new Date(BASE + minutes * 60_000);
}

function setup(t: Parameters<typeof tempDb>[0]) {
  const db = tempDb(t);
  const clock = { now: at(0) };
  const store = new HistoryStore(db, () => clock.now);
  return { db, clock, store };
}

test("openDb: v24 の DB を v25 に上げても既存のデータは残り、history は空で使える。移行の前に v24 の控えを取る", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const v24 = new DatabaseSync(path);
  v24.exec("PRAGMA journal_mode=WAL");
  for (const migration of MIGRATIONS.slice(0, 24)) v24.exec(migration);
  v24.exec("PRAGMA user_version = 24");
  v24.prepare("INSERT INTO tasks (title, status, created_at) VALUES ('残る', 'open', ?)").run(at(0).toISOString());
  v24.close();

  const logs: string[] = [];
  await backupBeforeMigration(path, (message) => logs.push(message));
  assert.ok(existsSync(backupPath(path, 24)));
  assert.deepEqual(logs, ["DB を移行する前に控えを取りました（v24）"]);

  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 25);
  assert.deepEqual(new TaskStore(db).list({ status: "open", limit: 20 }).map((task) => task.title), ["残る"]);
  const store = new HistoryStore(db, () => at(0));
  assert.deepEqual(store.list("c", { limit: 10 }), []);
  const id = store.add({ guildId: "g", channelId: "c", kind: "owner", source: "discord", text: "こんにちは" });
  assert.equal(store.list("c", { limit: 10 })[0]?.id, id);
});

test("HistoryStore.add: 省略した項目は既定の人格と null。書いた時刻は now。id を返す", (t) => {
  const { store } = setup(t);
  const id = store.add({ guildId: "g", channelId: "c", kind: "owner", source: "discord", text: "発言", messageId: "m-1" });
  const agent = store.add({
    guildId: "g",
    channelId: "c",
    kind: "agent",
    source: "web",
    persona: "aoi",
    text: "返事",
    outcome: "max_turns",
    steps: ["読んでいます", "書いています"],
    toolCalls: 2,
    durationMs: 4200,
  });
  assert.ok(agent > id);
  assert.deepEqual(store.list("c", { limit: 10 }), [
    {
      id,
      guildId: "g",
      channelId: "c",
      at: at(0).toISOString(),
      kind: "owner",
      source: "discord",
      persona: "default",
      text: "発言",
      outcome: null,
      steps: null,
      toolCalls: null,
      durationMs: null,
      messageId: "m-1",
    },
    {
      id: agent,
      guildId: "g",
      channelId: "c",
      at: at(0).toISOString(),
      kind: "agent",
      source: "web",
      persona: "aoi",
      text: "返事",
      outcome: "max_turns",
      steps: ["読んでいます", "書いています"],
      toolCalls: 2,
      durationMs: 4200,
      messageId: null,
    },
  ]);
});

test("HistoryStore.add: text は 4,000 字で切り、steps は先頭 50 件と 51 件目に「（ほか n 手順）」", (t) => {
  const { store } = setup(t);
  const long = "あ".repeat(HISTORY_TEXT_MAX_LENGTH + 1);
  const steps = Array.from({ length: 53 }, (_v, index) => `手順 ${index + 1}`);
  store.add({ guildId: "g", channelId: "c", kind: "agent", source: "discord", text: long, steps });
  const exact = Array.from({ length: HISTORY_STEPS_MAX }, (_v, index) => `手順 ${index + 1}`);
  store.add({ guildId: "g", channelId: "c", kind: "agent", source: "discord", text: "あ".repeat(4000), steps: exact });

  const [clipped, kept] = store.list("c", { limit: 10 });
  assert.equal(clipped!.text.length, HISTORY_TEXT_MAX_LENGTH);
  assert.equal(clipped!.steps!.length, HISTORY_STEPS_MAX + 1);
  assert.equal(clipped!.steps![HISTORY_STEPS_MAX - 1], "手順 50");
  assert.equal(clipped!.steps![HISTORY_STEPS_MAX], "（ほか 3 手順）");
  // ちょうど 4,000 字・50 件なら切らない・足さない
  assert.equal(kept!.text.length, 4000);
  assert.deepEqual(kept!.steps, exact);
});

test("HistoryStore.list: before・after・最新の limit 件をどれも古い順に。チャンネルで分ける", (t) => {
  const { store } = setup(t);
  const ids: number[] = [];
  for (let i = 1; i <= 6; i++) {
    ids.push(store.add({ guildId: "g", channelId: "c", kind: "owner", source: "discord", text: `${i}` }));
    store.add({ guildId: "g", channelId: "other", kind: "owner", source: "discord", text: `other ${i}` });
  }
  const texts = (rows: Array<{ text: string }>) => rows.map((row) => row.text);
  assert.deepEqual(texts(store.list("c", { limit: 3 })), ["4", "5", "6"]);
  assert.deepEqual(texts(store.list("c", { limit: 200 })), ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(texts(store.list("c", { before: ids[4]!, limit: 2 })), ["3", "4"]);
  assert.deepEqual(texts(store.list("c", { before: ids[1]!, limit: 5 })), ["1"]);
  assert.deepEqual(texts(store.list("c", { before: ids[0]!, limit: 5 })), []);
  assert.deepEqual(texts(store.list("c", { after: ids[1]!, limit: 2 })), ["3", "4"]);
  assert.deepEqual(texts(store.list("c", { after: ids[4]!, limit: 5 })), ["6"]);
  assert.deepEqual(texts(store.list("c", { after: ids[5]!, limit: 5 })), []);
  assert.deepEqual(store.list("none", { limit: 5 }), []);
});

test("HistoryStore.list: limit が 1〜200 の整数でない・before と after の両方なら RangeError", (t) => {
  const { store } = setup(t);
  for (const limit of [0, -1, HISTORY_LIST_MAX + 1, 1.5, Number.NaN]) {
    assert.throws(() => store.list("c", { limit }), RangeError, String(limit));
  }
  assert.throws(() => store.list("c", { before: 5, after: 1, limit: 10 }), RangeError);
  assert.deepEqual(store.list("c", { limit: 1 }), []);
  assert.deepEqual(store.list("c", { limit: HISTORY_LIST_MAX }), []);
});

test("HistoryStore.latestByChannel: そのサーバーのチャンネルごとの最後の行", (t) => {
  const { clock, store } = setup(t);
  store.add({ guildId: "g", channelId: "a", kind: "owner", source: "discord", text: "1" });
  clock.now = at(1);
  const lastA = store.add({ guildId: "g", channelId: "a", kind: "agent", source: "discord", text: "2" });
  clock.now = at(2);
  const lastB = store.add({ guildId: "g", channelId: "b", kind: "divider", source: "system", text: "3" });
  store.add({ guildId: "other", channelId: "x", kind: "owner", source: "discord", text: "4" });

  assert.deepEqual(
    store.latestByChannel("g"),
    new Map([
      ["a", { id: lastA, at: at(1).toISOString(), kind: "agent" }],
      ["b", { id: lastB, at: at(2).toISOString(), kind: "divider" }],
    ]),
  );
  assert.deepEqual(store.latestByChannel("none"), new Map());
});

test("HistoryStore.prune: cutoff より前に書いた行だけを消し、消した数を返す", (t) => {
  const { clock, store } = setup(t);
  store.add({ guildId: "g", channelId: "c", kind: "owner", source: "discord", text: "古い" });
  clock.now = at(10);
  store.add({ guildId: "g", channelId: "c", kind: "owner", source: "discord", text: "ちょうど" });
  clock.now = at(20);
  store.add({ guildId: "g", channelId: "c", kind: "owner", source: "discord", text: "新しい" });

  assert.equal(store.prune(at(10)), 1);
  assert.deepEqual(store.list("c", { limit: 10 }).map((row) => row.text), ["ちょうど", "新しい"]);
  assert.equal(store.prune(at(10)), 0);
});

test("recordHistory: history が無ければ何もせず、書けなければ log だけ（本文は出さない）", () => {
  const logs: string[] = [];
  const row = { guildId: "g", channelId: "c", kind: "owner", source: "discord", text: "秘密の本文" } as const;
  assert.equal(recordHistory(undefined, row, (line) => logs.push(line)), undefined);
  assert.equal(recordHistory({ add: () => 7 }, row, (line) => logs.push(line)), 7);
  assert.equal(logs.length, 0);
  const failing = {
    add: (): number => {
      throw new Error("disk I/O error");
    },
  };
  assert.equal(recordHistory(failing, row, (line) => logs.push(line)), undefined);
  assert.deepEqual(logs, ["履歴の書き込みに失敗しました（owner）: disk I/O error"]);
});
