import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupBeforeMigration, backupPath, MIGRATIONS, openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { ReminderStore } from "../src/store/reminders.ts";
import { ROUTINE_MAX_ACTIVE_PER_GUILD, type NewRoutine, type RoutineStore } from "../src/store/routines.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";

/** 2026-10-14T00:<minute>:00.000Z */
function at(minute: number): Date {
  return new Date(Date.UTC(2026, 9, 14, 0, minute));
}

/** setMinute で進める時計を持つストア（初めは 00:00） */
function tempStore(t: TestContext): { store: RoutineStore; db: DatabaseSync; setMinute: (minute: number) => void } {
  let minute = 0;
  const db = tempDb(t);
  const { routines: store } = createStores(db, () => at(minute));
  return {
    store,
    db,
    setMinute: (value) => {
      minute = value;
    },
  };
}

function routine(overrides: Partial<NewRoutine> = {}): NewRoutine {
  return { channelId: "rt-1", guildId: "g", name: "領収書", purpose: "経費の記録", instructions: "金額を記録する", ...overrides };
}

test("openDb: v19 の DB を v20 に上げても既存のデータは残り、定型の表は空で使え、guild_settings の定型のカテゴリは null。移行の前に v19 の控えを取る", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const v19 = new DatabaseSync(path);
  v19.exec("PRAGMA journal_mode=WAL");
  for (const migration of MIGRATIONS.slice(0, 19)) v19.exec(migration);
  v19.exec("PRAGMA user_version = 19");
  const created = "2026-10-01T00:00:00.000Z";
  v19
    .prepare("INSERT INTO guild_settings (guild_id, home_category_id, system_channel_id, created_at, updated_at) VALUES ('g', 'home-1', 'system-1', ?, ?)")
    .run(created, created);
  v19
    .prepare("INSERT INTO persona_channels (guild_id, persona, kind, channel_id, created_at, updated_at) VALUES ('g', 'default', 'inbox', 'inbox-1', ?, ?)")
    .run(created, created);
  v19.prepare("INSERT INTO tasks (title, status, created_at) VALUES ('残る', 'open', ?)").run(created);
  v19
    .prepare(
      "INSERT INTO sessions (channel_id, guild_id, title, state, category_id, created_at, last_activity_at) VALUES ('topic-1', 'g', '題名', 'active', 'active-1', ?, ?)",
    )
    .run(created, created);
  v19
    .prepare(
      "INSERT INTO reminders (guild_id, channel_id, kind, text, next_at, last_message_channel_id, created_at, updated_at) " +
        "VALUES ('g', 'inbox-1', 'notify', '薬', ?, 'tasks-1', ?, ?)",
    )
    .run(created, created, created);
  v19.close();

  const logs: string[] = [];
  await backupBeforeMigration(path, (message) => logs.push(message));
  assert.ok(existsSync(backupPath(path, 19)));
  assert.deepEqual(logs, ["DB を移行する前に控えを取りました（v19）"]);

  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 20);

  const guildSettings = new GuildSettingsStore(db);
  assert.equal(guildSettings.get("g")?.inboxChannelId, "inbox-1");
  assert.equal(guildSettings.get("g")?.systemChannelId, "system-1");
  assert.equal(guildSettings.routineCategoryId("g"), null);
  assert.deepEqual(new TaskStore(db).list({ status: "open", limit: 20 }).map((task) => task.title), ["残る"]);
  assert.equal(new TopicSessionStore(db).get("topic-1")?.title, "題名");
  assert.equal(new ReminderStore(db).get(1)?.lastMessageChannelId, "tasks-1");

  const stores = createStores(db, () => at(0));
  assert.deepEqual(stores.routines.listActive("g"), []);
  assert.equal(stores.routineRecords.list("rt-1").count, 0);
  assert.deepEqual(stores.attachments.listUnlinkedOlderThan(0), []);
  // セッションだったチャンネルも定型にできる
  assert.equal(stores.routines.create(routine({ channelId: "topic-1" })).persona, "default");
});

test("GuildSettingsStore: 定型のカテゴリは保存・置き換えができ、ほかの列を変えない。/setup 前のサーバーは null", (t) => {
  let minute = 0;
  const { guildSettings: store } = createStores(tempDb(t), () => at(minute++));
  assert.equal(store.routineCategoryId("g"), null);

  store.setChannel("g", "homeCategoryId", "home-1");
  store.setRoutineCategory("g", "routine-1");
  assert.equal(store.routineCategoryId("g"), "routine-1");
  store.setRoutineCategory("g", "routine-2");
  assert.equal(store.routineCategoryId("g"), "routine-2");
  assert.equal(store.get("g")?.homeCategoryId, "home-1");
  assert.equal(store.get("g")?.updatedAt, at(2).toISOString());
  assert.equal(store.routineCategoryId("other"), null);
});

test("RoutineStore: 作ると active・手順の版 1・渡した版 0 で、既定の人格。同じチャンネルは archived でも作れない", (t) => {
  const { store } = tempStore(t);
  const created = store.create(routine());
  assert.deepEqual(created, {
    channelId: "rt-1",
    guildId: "g",
    persona: "default",
    name: "領収書",
    purpose: "経費の記録",
    instructions: "金額を記録する",
    instructionsRev: 1,
    seenRev: 0,
    summary: null,
    rotatedDate: null,
    rotatedAt: null,
    state: "active",
    createdAt: at(0).toISOString(),
    updatedAt: at(0).toISOString(),
    archivedAt: null,
  });
  assert.deepEqual(store.get("rt-1"), created);
  assert.equal(store.get("rt-2"), undefined);

  const minimal = store.create({ channelId: "rt-2", guildId: "g", name: "予定", persona: "aoi" });
  assert.equal(minimal.persona, "aoi");
  assert.equal(minimal.purpose, "");
  assert.equal(minimal.instructions, "");

  assert.throws(() => store.create(routine()), /UNIQUE/);
  store.archive("rt-1");
  assert.throws(() => store.create(routine()), /UNIQUE/);
});

test("RoutineStore: listActive・countActive はそのサーバーの active だけを作った順に数え、上限の 20 と比べられる", (t) => {
  const { store, setMinute } = tempStore(t);
  assert.equal(ROUTINE_MAX_ACTIVE_PER_GUILD, 20);
  for (let i = 0; i < ROUTINE_MAX_ACTIVE_PER_GUILD; i++) {
    setMinute(ROUTINE_MAX_ACTIVE_PER_GUILD - i);
    store.create(routine({ channelId: `rt-${i}`, name: `定型${i}` }));
  }
  store.create(routine({ channelId: "other-1", guildId: "other" }));
  assert.equal(store.countActive("g"), ROUTINE_MAX_ACTIVE_PER_GUILD);
  assert.equal(store.countActive("other"), 1);
  assert.equal(store.countActive("none"), 0);
  // 作った時刻の順（後から作ったものほど時計が早いので、channel_id の逆順）
  assert.deepEqual(
    store.listActive("g").map((r) => r.channelId),
    Array.from({ length: ROUTINE_MAX_ACTIVE_PER_GUILD }, (_, i) => `rt-${ROUTINE_MAX_ACTIVE_PER_GUILD - 1 - i}`),
  );

  store.archive("rt-3");
  assert.equal(store.countActive("g"), ROUTINE_MAX_ACTIVE_PER_GUILD - 1);
  assert.ok(!store.listActive("g").some((r) => r.channelId === "rt-3"));
});

test("RoutineStore: archive・restore は状態が変わるときだけ true で、archived_at を付け外しする", (t) => {
  const { store, setMinute } = tempStore(t);
  store.create(routine());
  const cases: Array<[label: string, run: () => boolean, expected: boolean, state: string | undefined, archivedAt: string | null | undefined]> = [
    ["active を archive", () => store.archive("rt-1"), true, "archived", at(5).toISOString()],
    ["archived を archive", () => store.archive("rt-1"), false, "archived", at(5).toISOString()],
    ["archived を restore", () => store.restore("rt-1"), true, "active", null],
    ["active を restore", () => store.restore("rt-1"), false, "active", null],
    ["無いチャンネルを archive", () => store.archive("none"), false, "active", null],
    ["無いチャンネルを restore", () => store.restore("none"), false, "active", null],
  ];
  setMinute(5);
  for (const [label, run, expected, state, archivedAt] of cases) {
    assert.equal(run(), expected, label);
    assert.equal(store.get("rt-1")?.state, state, label);
    assert.equal(store.get("rt-1")?.archivedAt, archivedAt, label);
  }
  // 記録・手順は残る
  assert.equal(store.get("rt-1")?.instructions, "金額を記録する");
});

test("RoutineStore: setInstructions は変えたら版を 1 増やし、同じ文は no_change、古い版の指定は stale、無いチャンネルは not_found", (t) => {
  const { store, setMinute } = tempStore(t);
  store.create(routine());
  setMinute(3);
  const cases: Array<[label: string, text: string, expectedRev: number | undefined, result: string, rev: number | undefined]> = [
    ["変える", "金額と日付を記録する", undefined, "updated", 2],
    ["同じ文", "金額と日付を記録する", undefined, "no_change", 2],
    ["今の版を指定して変える", "金額・日付・店を記録する", 2, "updated", 3],
    ["古い版の指定", "別の手順", 2, "stale", 3],
    ["古い版の指定（同じ文でも）", "金額・日付・店を記録する", 1, "stale", 3],
  ];
  for (const [label, text, expectedRev, result, rev] of cases) {
    const outcome = store.setInstructions("rt-1", text, expectedRev);
    assert.equal(outcome.result, result, label);
    if (outcome.result !== "not_found") assert.equal(outcome.routine.instructionsRev, rev, label);
  }
  assert.equal(store.get("rt-1")?.instructions, "金額・日付・店を記録する");
  assert.equal(store.get("rt-1")?.seenRev, 0);
  assert.equal(store.get("rt-1")?.updatedAt, at(3).toISOString());
  assert.deepEqual(store.setInstructions("none", "x"), { result: "not_found" });
});

test("RoutineStore: markInstructionsSeen は渡した版を進めるだけで、戻さず、手順の版を超えない", (t) => {
  const { store } = tempStore(t);
  store.create(routine());
  store.setInstructions("rt-1", "二版");
  store.setInstructions("rt-1", "三版");
  const cases: Array<[label: string, rev: number, expected: boolean, seen: number]> = [
    ["今より前の版", 1, true, 1],
    ["同じ版", 1, false, 1],
    ["手順の版まで", 3, true, 3],
    ["戻さない", 2, false, 3],
    ["手順の版を超えない", 4, false, 3],
  ];
  for (const [label, rev, expected, seen] of cases) {
    assert.equal(store.markInstructionsSeen("rt-1", rev), expected, label);
    assert.equal(store.get("rt-1")?.seenRev, seen, label);
  }
  assert.equal(store.markInstructionsSeen("none", 1), false);
  // 次に手順を変えると、渡した版より新しくなる
  store.setInstructions("rt-1", "四版");
  const current = store.get("rt-1")!;
  assert.deepEqual([current.instructionsRev, current.seenRev], [4, 3]);
});

test("RoutineStore: 要約・切り替えの日と時刻・名前を保存する。無いチャンネルは false で、rename は同じ名前なら false", (t) => {
  const { store, setMinute } = tempStore(t);
  store.create(routine());
  setMinute(10);
  assert.equal(store.setSummary("rt-1", "- 確認待ち 1 件"), true);
  assert.equal(store.setRotated("rt-1", "2026-10-14", at(9)), true);
  assert.equal(store.rename("rt-1", "経費"), true);
  assert.equal(store.rename("rt-1", "経費"), false);
  const current = store.get("rt-1")!;
  assert.deepEqual(
    [current.summary, current.rotatedDate, current.rotatedAt, current.name, current.updatedAt],
    ["- 確認待ち 1 件", "2026-10-14", at(9).toISOString(), "経費", at(10).toISOString()],
  );
  // 要約は直近の 1 つだけ
  store.setSummary("rt-1", "- 次の要約");
  assert.equal(store.get("rt-1")?.summary, "- 次の要約");
  assert.equal(store.setSummary("none", "x"), false);
  assert.equal(store.setRotated("none", "2026-10-14", at(9)), false);
  assert.equal(store.rename("none", "x"), false);
});
