import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cacheReadRate, createUsageCommand, usageText } from "../src/app/commands/usage.ts";
import { startOfLocalDay } from "../src/app/time.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import type { StepUsage } from "../src/agent/runner.ts";
import { type UsageEntry, type UsageListOptions, type UsageRecord, UsageStore } from "../src/store/usage.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeResponder } from "./helpers/responder.ts";

/** 2026-10-02(金) 09:12 JST */
const NOW = new Date("2026-10-02T00:12:00Z");

function setup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: NOW };
  const { usage } = createStores(db, () => clock.now);
  /** at の時刻に 1 ターン記録する */
  const recordAt = (at: string, record: Omit<UsageRecord, "key">): void => {
    clock.now = new Date(at);
    usage.record({ key: "inbox-1", ...record });
    clock.now = NOW;
  };
  return { usage, recordAt };
}

const ok = (input: number, read: number, creation: number, toolCalls: number, compacted = false): Omit<UsageRecord, "key"> => ({
  ok: true,
  inputTokens: input,
  cacheReadInputTokens: read,
  cacheCreationInputTokens: creation,
  toolCalls,
  compacted,
});

/** ステップ 1 つ分の usage */
function step(input: number, read: number, creation: number, creation1h: number): StepUsage {
  return {
    inputTokens: input,
    cacheReadInputTokens: read,
    cacheCreationInputTokens: creation,
    cacheCreation1hInputTokens: creation1h,
  };
}

/** 今日（JST）の 0 時ちょうど・その直前、7 日前（JST 9/26）の 0 時ちょうど・その直前に記録する */
function recordSamples(recordAt: (at: string, record: Omit<UsageRecord, "key">) => void): void {
  recordAt("2026-10-01T15:00:00.000Z", ok(10, 900, 90, 2, true));
  recordAt("2026-10-01T14:59:59.999Z", ok(5, 100, 0, 1));
  recordAt("2026-10-02T00:00:00.000Z", { ok: false, toolCalls: 1 });
  recordAt("2026-09-25T15:00:00.000Z", ok(1, 0, 9, 0));
  recordAt("2026-09-25T14:59:59.999Z", ok(1000, 1000, 1000, 9, true));
}

test("openDb: v6 の DB を v7 に上げても usage_log の行は残り、tool_calls は 0。以後はツール呼び出しの回数を記録できる", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // ツール呼び出しの記録より前（v6）の DB を作る
  const v6 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 6)) v6.exec(migration);
  v6.exec("PRAGMA user_version = 6");
  v6.prepare(
    "INSERT INTO usage_log (at, key, session_id, ok, compacted) VALUES ('2026-10-01T00:00:00.000Z', 'inbox-1', 'session-1', 1, 1)",
  ).run();
  v6.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 7);
  const usage = new UsageStore(db, () => NOW);
  usage.record({ key: "topic-1", ok: true, toolCalls: 4 });
  usage.record({ key: "topic-1", ok: false });
  assert.deepEqual(
    usage.recent(10).map((entry) => [entry.key, entry.ok, entry.compacted, entry.toolCalls]),
    [
      ["topic-1", false, false, 0],
      ["topic-1", true, false, 4],
      ["inbox-1", true, true, 0],
    ],
  );
});

test("openDb: v9 の DB を v10 に上げても usage_log の行は残り、context_tokens は 0。以後は最後のステップの入力を記録できる", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // 最後のステップの入力の記録より前（v9）の DB を作る
  const v9 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 9)) v9.exec(migration);
  v9.exec("PRAGMA user_version = 9");
  v9.prepare(
    "INSERT INTO usage_log (at, key, session_id, ok, input_tokens, cache_read_input_tokens, cache_creation_input_tokens) " +
      "VALUES ('2026-10-01T00:00:00.000Z', 'inbox-1', 'session-1', 1, 10, 200000, 300)",
  ).run();
  v9.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 10);
  const usage = new UsageStore(db, () => NOW);
  usage.record({ key: "inbox-1", ok: true, cacheReadInputTokens: 90000, contextTokens: 45000 });
  usage.record({ key: "inbox-1", ok: false });
  assert.deepEqual(
    usage.recent(10).map((entry) => [entry.ok, entry.cacheReadInputTokens, entry.contextTokens]),
    [
      [false, null, 0],
      [true, 90000, 45000],
      [true, 200000, 0],
    ],
  );
});

test("openDb: v16 の DB を v17 に上げても usage_log の行は残り、種類・出力・1 時間の分・steps は null。以後は記録できる", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // ステップごとの記録より前（v16）の DB を作る
  const v16 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 16)) v16.exec(migration);
  v16.exec("PRAGMA user_version = 16");
  v16.prepare(
    "INSERT INTO usage_log (at, key, session_id, ok, input_tokens, cache_read_input_tokens, cache_creation_input_tokens, context_tokens) " +
      "VALUES ('2026-10-01T00:00:00.000Z', 'inbox-1', 'session-1', 1, 10, 2000, 300, 2310)",
  ).run();
  v16.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 17);
  const usage = new UsageStore(db, () => NOW);
  usage.record({ key: "inbox-1", ok: true, kind: "inbox", outputTokens: 5, cacheCreation1hInputTokens: 100, steps: [step(1, 2, 3, 4)] });
  const pick = (entry: UsageEntry) => [
    entry.key,
    entry.inputTokens,
    entry.contextTokens,
    entry.kind,
    entry.outputTokens,
    entry.cacheCreation1hInputTokens,
    entry.steps,
  ];
  assert.deepEqual(usage.recent(10).map(pick), [
    ["inbox-1", null, 0, "inbox", 5, 100, [step(1, 2, 3, 4)]],
    ["inbox-1", 10, 2310, null, null, null, null],
  ]);
});

test("UsageStore: steps は短い JSON（入力側だけ）で保存して読み戻す。NULL・読めない JSON・形が違えば null、余計な項目（以前の o）は無視する", (t) => {
  const db = tempDb(t);
  const usage = new UsageStore(db, () => NOW);
  usage.record({ key: "topic-1", ok: false, kind: "session", steps: [step(3, 0, 5000, 5000), step(2, 5000, 100, 0)] });
  assert.equal(
    db.prepare("SELECT steps FROM usage_log").get()?.steps,
    '[{"i":3,"r":0,"w":5000,"w1h":5000},{"i":2,"r":5000,"w":100,"w1h":0}]',
  );
  assert.deepEqual(usage.recent(1)[0]?.steps, [step(3, 0, 5000, 5000), step(2, 5000, 100, 0)]);

  const cases: Array<[label: string, stored: string | null, expected: StepUsage[] | null]> = [
    ["NULL", null, null],
    ["空の配列", "[]", []],
    ["JSON でない", "{", null],
    ["配列でない", '{"i":1}', null],
    ["要素が足りない", '[{"i":1,"r":2,"w":3}]', null],
    ["数でない値", '[{"i":"1","r":2,"w":3,"w1h":4}]', null],
    ["以前の o は無視する", '[{"i":1,"r":2,"w":3,"w1h":4,"o":5}]', [step(1, 2, 3, 4)]],
  ];
  for (const [label, stored, expected] of cases) {
    db.prepare("UPDATE usage_log SET steps = ?").run(stored);
    assert.deepEqual(usage.recent(1)[0]?.steps, expected, label);
  }
});

test("UsageStore.listRecent: since（含む）〜until（含まない）・種類で絞り、新しい limit 件を古い順に返す", (t) => {
  const { usage, recordAt } = setup(t);
  recordAt("2026-10-01T14:59:59.999Z", { ok: true, kind: "inbox" });
  recordAt("2026-10-01T15:00:00.000Z", { ok: true, kind: "inbox" });
  recordAt("2026-10-01T16:00:00.000Z", { ok: false, kind: "session" });
  recordAt("2026-10-01T17:00:00.000Z", { ok: true, kind: "inbox-rotate" });
  recordAt("2026-10-01T17:00:00.000Z", { ok: true, kind: "inbox" });
  recordAt("2026-10-02T15:00:00.000Z", { ok: true, kind: "inbox" });
  const ids = (entries: UsageEntry[]): number[] => entries.map((entry) => entry.id);
  const since = new Date("2026-10-01T15:00:00.000Z");
  const until = new Date("2026-10-02T15:00:00.000Z");

  const cases: Array<[label: string, options: UsageListOptions, expected: number[]]> = [
    ["範囲", { since, until, limit: 10 }, [2, 3, 4, 5]],
    ["新しい 2 件を古い順に（同じ時刻は id 順）", { since, until, limit: 2 }, [4, 5]],
    ["種類は完全一致", { since, until, kind: "inbox", limit: 10 }, [2, 5]],
    ["範囲なし", { limit: 3 }, [4, 5, 6]],
    ["since だけ", { since: until, limit: 10 }, [6]],
    ["until だけ", { until: since, limit: 10 }, [1]],
    ["該当なし", { kind: "tasks", limit: 10 }, []],
  ];
  for (const [label, options, expected] of cases) assert.deepEqual(ids(usage.listRecent(options)), expected, label);
});

test("UsageStore.summarize: since ちょうどを含み、その前は含めない。成功・失敗・トークン・compaction・ツール呼び出しを合計する", (t) => {
  const { usage, recordAt } = setup(t);
  recordSamples(recordAt);

  assert.deepEqual(usage.summarize(new Date("2026-10-01T15:00:00.000Z")), {
    turns: 2,
    okTurns: 1,
    failedTurns: 1,
    inputTokens: 10,
    cacheReadInputTokens: 900,
    cacheCreationInputTokens: 90,
    compactions: 1,
    toolCalls: 3,
  });
  assert.deepEqual(usage.summarize(new Date("2026-09-25T15:00:00.000Z")), {
    turns: 4,
    okTurns: 3,
    failedTurns: 1,
    inputTokens: 16,
    cacheReadInputTokens: 1000,
    cacheCreationInputTokens: 99,
    compactions: 1,
    toolCalls: 4,
  });
  // 1 行も無ければすべて 0
  assert.deepEqual(usage.summarize(new Date("2026-10-03T00:00:00.000Z")), {
    turns: 0,
    okTurns: 0,
    failedTurns: 0,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    compactions: 0,
    toolCalls: 0,
  });
});

test("UsageStore.summarize・sumOutputTokens: until を渡せばその前（ちょうどは含まない）まで", (t) => {
  const { usage, recordAt } = setup(t);
  recordAt("2026-10-01T00:00:00.000Z", { ...ok(1, 10, 100, 1), outputTokens: 5 });
  recordAt("2026-10-01T12:00:00.000Z", { ...ok(2, 20, 200, 2), outputTokens: 7 });
  recordAt("2026-10-02T00:00:00.000Z", { ...ok(4, 40, 400, 4), outputTokens: 11 });

  const since = new Date("2026-10-01T00:00:00.000Z");
  const until = new Date("2026-10-02T00:00:00.000Z");
  const summary = usage.summarize(since, "default", until);
  assert.equal(summary.turns, 2);
  assert.equal(summary.inputTokens, 3);
  assert.equal(summary.toolCalls, 3);
  assert.equal(usage.summarize(since, undefined, until).turns, 2);
  assert.equal(usage.summarize(since).turns, 3);
  assert.equal(usage.sumOutputTokens(since, "default", until), 12);
  assert.equal(usage.sumOutputTokens(since, "default"), 23);
  assert.equal(usage.sumOutputTokens(since, "guest", until), 0);
});

test("UsageStore.listDays: since 以降を timeZone の日付ごとにターン数と入力（input + read + creation。失敗は 0）で数え、古い順に返す", (t) => {
  const { usage, recordAt } = setup(t);
  // 2026-09-30 23:59 JST（since より前）
  recordAt("2026-09-30T14:59:00.000Z", ok(1000, 0, 0, 0));
  // 2026-10-01 00:00 JST と 23:59 JST
  recordAt("2026-09-30T15:00:00.000Z", ok(1, 10, 100, 0));
  recordAt("2026-10-01T14:59:00.000Z", ok(2, 20, 200, 0));
  // 2026-10-02 JST（失敗は入力 0 で 1 ターン）
  recordAt("2026-10-01T15:00:00.000Z", { ok: false, toolCalls: 0 });
  recordAt("2026-10-02T00:00:00.000Z", ok(3, 30, 300, 0));

  assert.deepEqual(usage.listDays(new Date("2026-09-30T15:00:00.000Z"), "Asia/Tokyo"), [
    { date: "2026-10-01", turns: 2, inputTokens: 333 },
    { date: "2026-10-02", turns: 2, inputTokens: 333 },
  ]);
  // UTC の日付で分ければ境界が変わる
  assert.deepEqual(usage.listDays(new Date("2026-09-30T15:00:00.000Z"), "UTC"), [
    { date: "2026-09-30", turns: 1, inputTokens: 111 },
    { date: "2026-10-01", turns: 2, inputTokens: 222 },
    { date: "2026-10-02", turns: 1, inputTokens: 333 },
  ]);
  assert.deepEqual(usage.listDays(new Date("2026-10-03T00:00:00.000Z"), "Asia/Tokyo"), []);
});

test("UsageStore.countAfter / latestOkAfter: その key で after より後（ちょうどは含まない）のターン。after が無ければすべて", (t) => {
  const { usage, recordAt } = setup(t);
  recordAt("2026-10-02T00:00:00.000Z", ok(1, 10, 100, 0));
  recordAt("2026-10-02T00:01:00.000Z", ok(2, 20, 200, 0));
  recordAt("2026-10-02T00:02:00.000Z", { ok: false, toolCalls: 0 });
  // 別の key は数えない
  usage.record({ key: "topic-1", ...ok(9, 9, 9, 0) });

  assert.equal(usage.countAfter("inbox-1", undefined), 3);
  assert.equal(usage.countAfter("inbox-1", new Date("2026-10-02T00:00:00.000Z")), 2);
  assert.equal(usage.countAfter("inbox-1", new Date("2026-10-02T00:02:00.000Z")), 0);
  assert.equal(usage.countAfter("inbox-2", undefined), 0);

  // 失敗したターンは飛ばして、最新の成功したターンを返す
  assert.equal(usage.latestOkAfter("inbox-1", undefined)?.cacheCreationInputTokens, 200);
  assert.equal(usage.latestOkAfter("inbox-1", new Date("2026-10-02T00:00:59.999Z"))?.inputTokens, 2);
  assert.equal(usage.latestOkAfter("inbox-1", new Date("2026-10-02T00:01:00.000Z")), undefined);
  assert.equal(usage.latestOkAfter("inbox-2", undefined), undefined);
});

test("startOfLocalDay: タイムゾーンの日付の 0 時（n 日前にずらせる。月・年・夏時間の切り替わりをまたぐ）", () => {
  const cases: Array<[label: string, at: string, timeZone: string, daysBack: number | undefined, expected: string]> = [
    ["JST", NOW.toISOString(), "Asia/Tokyo", undefined, "2026-10-01T15:00:00.000Z"],
    ["JST の 6 日前", NOW.toISOString(), "Asia/Tokyo", 6, "2026-09-25T15:00:00.000Z"],
    ["UTC", NOW.toISOString(), "UTC", undefined, "2026-10-02T00:00:00.000Z"],
    ["JST 0 時ちょうどはその日", "2026-10-01T15:00:00.000Z", "Asia/Tokyo", undefined, "2026-10-01T15:00:00.000Z"],
    ["JST 0 時の 1 ms 前は前の日", "2026-10-01T14:59:59.999Z", "Asia/Tokyo", undefined, "2026-09-30T15:00:00.000Z"],
    ["年をまたぐ", "2026-01-03T00:00:00Z", "Asia/Tokyo", 6, "2025-12-27T15:00:00.000Z"],
    // America/New_York は 2026-03-08 02:00 に EST(-5) → EDT(-4)。その日の 0 時のずれで求める
    ["夏時間に入る日", "2026-03-08T18:00:00Z", "America/New_York", undefined, "2026-03-08T05:00:00.000Z"],
    ["夏時間に入った翌日", "2026-03-09T12:00:00Z", "America/New_York", undefined, "2026-03-09T04:00:00.000Z"],
    ["夏時間をまたいで 6 日前", "2026-03-09T12:00:00Z", "America/New_York", 6, "2026-03-03T05:00:00.000Z"],
  ];
  for (const [label, at, timeZone, daysBack, expected] of cases) {
    assert.equal(startOfLocalDay(new Date(at), timeZone, daysBack).toISOString(), expected, label);
  }
});

test("cacheReadRate: read / (input + read + creation) を % で。分母が 0 なら「-」", () => {
  const summary = {
    turns: 1,
    okTurns: 1,
    failedTurns: 0,
    inputTokens: 16,
    cacheReadInputTokens: 1000,
    cacheCreationInputTokens: 99,
    compactions: 0,
    toolCalls: 0,
  };
  assert.equal(cacheReadRate(summary), "89.7%");
  assert.equal(cacheReadRate({ ...summary, inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }), "-");
});

test("/usage: 今日と直近 7 日（SELF_AGENT_TZ の日付で区切る）を ephemeral で返す。タイムゾーンが違えば日付の境界も変わる", async (t) => {
  const { usage, recordAt } = setup(t);
  recordSamples(recordAt);
  const command = createUsageCommand({ usage, cfg: { timeZone: "Asia/Tokyo" } });
  const interaction: Extract<Interaction, { kind: "command" }> = {
    kind: "command",
    name: "usage",
    options: {},
    guildId: "guild-1",
    channelId: "inbox-1",
    userId: "owner-1",
    createdAt: NOW,
  };
  const responder = new FakeResponder();

  await command.handle(interaction, responder);

  assert.deepEqual(responder.replies, [{ text: usageText(usage, NOW, "Asia/Tokyo"), ephemeral: true }]);

  const cases: Array<{ timeZone: string; today: string[]; week: string[] }> = [
    {
      timeZone: "Asia/Tokyo",
      today: ["2026-10-02", "ターン 2（成功 1 / 失敗 1）", "入力トークン 10", "読み取り 900 / 作成 90（読み取り率 90.0%）", "compaction 1 回", "ツール呼び出し 3 回"],
      week: ["2026-09-26〜2026-10-02", "ターン 4（成功 3 / 失敗 1）", "入力トークン 16", "読み取り 1,000 / 作成 99（読み取り率 89.7%）", "compaction 1 回", "ツール呼び出し 4 回"],
    },
    {
      // UTC なら今日は 10/02 00:00Z から、7 日は 9/26 00:00Z から（9/25 15:00Z の行は入らない）
      timeZone: "UTC",
      today: ["2026-10-02", "ターン 1（成功 0 / 失敗 1）", "入力トークン 0", "読み取り率 -", "compaction 0 回", "ツール呼び出し 1 回"],
      week: ["2026-09-26〜2026-10-02", "ターン 3（成功 2 / 失敗 1）"],
    },
  ];
  for (const { timeZone, today, week } of cases) {
    const [todayText, weekText] = usageText(usage, NOW, timeZone).split("\n\n");
    for (const part of today) assert.ok(todayText!.includes(part), `${timeZone} 今日 ${part}`);
    for (const part of week) assert.ok(weekText!.includes(part), `${timeZone} 7 日 ${part}`);
  }
});

test("/usage: ゲストのときだけ人格の後に「ゲスト（API キー・今日）」の 1 行を出し、既存のブロックにはゲストの行を含めない（人格なしは既定の人格で絞る）", async (t) => {
  const { usage, recordAt } = setup(t);
  // 今日（JST 10/02）: 既定の人格 1、ゲスト 成功 2・失敗 1。昨日のゲストは数えない
  recordAt("2026-10-01T15:00:00.000Z", ok(10, 900, 90, 0));
  recordAt("2026-10-01T16:00:00.000Z", { ...ok(5, 1000, 2000, 0), outputTokens: 30, persona: "guest", kind: "guest" });
  recordAt("2026-10-01T17:00:00.000Z", { ...ok(1, 0, 100, 0), outputTokens: 12, persona: "guest", kind: "guest" });
  recordAt("2026-10-01T18:00:00.000Z", { ok: false, persona: "guest", kind: "guest" });
  recordAt("2026-10-01T14:59:59.999Z", { ...ok(7, 7, 7, 0), outputTokens: 99, persona: "guest", kind: "guest" });

  const withoutGuest = usageText(usage, NOW, "Asia/Tokyo");
  assert.doesNotMatch(withoutGuest, /ゲスト/);
  const [today] = withoutGuest.split("\n\n");
  assert.match(today!, /ターン 1（成功 1 \/ 失敗 0）\n入力トークン 10\n/);

  const line = "ゲスト（API キー・今日）: ターン 3（失敗 1）・入力 3,106・出力 42";
  const withGuest = usageText(usage, NOW, "Asia/Tokyo", [], true);
  assert.equal(withGuest, `${withoutGuest}\n\n${line}`);
  const withPersonas = usageText(usage, NOW, "Asia/Tokyo", [{ id: "mika", name: "Mika" }], true);
  assert.ok(withPersonas.endsWith(`\n\n${line}`));
  assert.doesNotMatch(withPersonas.slice(0, -line.length), /ゲスト/);

  const command = createUsageCommand({
    usage,
    cfg: { timeZone: "Asia/Tokyo", guest: true },
    attachments: { totals: () => ({ count: 0, bytes: 0 }) },
  });
  const responder = new FakeResponder();
  await command.handle(
    { kind: "command", name: "usage", options: {}, guildId: "guild-1", channelId: "inbox-1", userId: "owner-1", createdAt: NOW },
    responder,
  );
  assert.equal(responder.replies[0]?.text, `${withGuest}\n\n保存している添付 0 件（0.0 MB）`);
});
