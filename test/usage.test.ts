import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cacheReadRate, createUsageCommand, usageText } from "../src/app/commands/usage.ts";
import { startOfLocalDay } from "../src/app/time.ts";
import type { Interaction, InteractionResponder, ModalDef, OutgoingMessage } from "../src/discord/gateway.ts";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { type UsageRecord, UsageStore } from "../src/store/usage.ts";

/** 2026-10-02(金) 09:12 JST */
const NOW = new Date("2026-10-02T00:12:00Z");

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t: TestContext) {
  const db = openDb(join(tempDir(t), "self-agent.db"));
  t.after(() => db.close());
  const clock = { now: NOW };
  const usage = new UsageStore(db, () => clock.now);
  /** at の時刻に 1 ターン記録する */
  const recordAt = (at: string, record: Omit<UsageRecord, "key">): void => {
    clock.now = new Date(at);
    usage.record({ key: "inbox-1", ...record });
    clock.now = NOW;
  };
  return { usage, recordAt };
}

class FakeResponder implements InteractionResponder {
  replies: OutgoingMessage[] = [];

  async defer(): Promise<void> {}
  async deferUpdate(): Promise<void> {}
  async reply(message: OutgoingMessage): Promise<void> {
    this.replies.push(message);
  }
  async update(): Promise<void> {}
  async showModal(_modal: ModalDef): Promise<void> {}
}

const ok = (input: number, read: number, creation: number, toolCalls: number, compacted = false): Omit<UsageRecord, "key"> => ({
  ok: true,
  inputTokens: input,
  cacheReadInputTokens: read,
  cacheCreationInputTokens: creation,
  toolCalls,
  compacted,
});

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

test("startOfLocalDay: タイムゾーンの日付の 0 時（n 日前にずらせる。月・年をまたぐ）", () => {
  assert.equal(startOfLocalDay(NOW, "Asia/Tokyo").toISOString(), "2026-10-01T15:00:00.000Z");
  assert.equal(startOfLocalDay(NOW, "Asia/Tokyo", 6).toISOString(), "2026-09-25T15:00:00.000Z");
  assert.equal(startOfLocalDay(NOW, "UTC").toISOString(), "2026-10-02T00:00:00.000Z");
  // JST 0 時ちょうどはその日、1 ms 前は前の日
  assert.equal(startOfLocalDay(new Date("2026-10-01T15:00:00.000Z"), "Asia/Tokyo").toISOString(), "2026-10-01T15:00:00.000Z");
  assert.equal(startOfLocalDay(new Date("2026-10-01T14:59:59.999Z"), "Asia/Tokyo").toISOString(), "2026-09-30T15:00:00.000Z");
  assert.equal(
    startOfLocalDay(new Date("2026-01-03T00:00:00Z"), "Asia/Tokyo", 6).toISOString(),
    "2025-12-27T15:00:00.000Z",
  );
});

test("startOfLocalDay: 夏時間の切り替わりをまたいでも、その日の 0 時のずれで求める", () => {
  // America/New_York は 2026-03-08 02:00 に EST(-5) → EDT(-4)
  const afternoon = new Date("2026-03-08T18:00:00Z");
  assert.equal(startOfLocalDay(afternoon, "America/New_York").toISOString(), "2026-03-08T05:00:00.000Z");
  const nextMorning = new Date("2026-03-09T12:00:00Z");
  assert.equal(startOfLocalDay(nextMorning, "America/New_York").toISOString(), "2026-03-09T04:00:00.000Z");
  assert.equal(startOfLocalDay(nextMorning, "America/New_York", 6).toISOString(), "2026-03-03T05:00:00.000Z");
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

test("/usage: 今日と直近 7 日（SELF_AGENT_TZ の日付で区切る）を ephemeral で返す", async (t) => {
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

  assert.deepEqual(responder.replies, [
    {
      text: [
        "**今日**（2026-10-02）",
        "ターン 2（成功 1 / 失敗 1）",
        "入力トークン 10",
        "キャッシュ 読み取り 900 / 作成 90（読み取り率 90.0%）",
        "compaction 1 回",
        "ツール呼び出し 3 回",
        "",
        "**直近 7 日**（2026-09-26〜2026-10-02）",
        "ターン 4（成功 3 / 失敗 1）",
        "入力トークン 16",
        "キャッシュ 読み取り 1,000 / 作成 99（読み取り率 89.7%）",
        "compaction 1 回",
        "ツール呼び出し 4 回",
      ].join("\n"),
      ephemeral: true,
    },
  ]);
});

test("/usage: タイムゾーンが違えば日付の境界も変わる（UTC なら今日は 10/02 00:00Z から）", (t) => {
  const { usage, recordAt } = setup(t);
  recordSamples(recordAt);

  const text = usageText(usage, NOW, "UTC");

  assert.match(text, /^\*\*今日\*\*（2026-10-02）\nターン 1（成功 0 \/ 失敗 1）\n入力トークン 0\n/);
  assert.match(text, /読み取り率 -）\ncompaction 0 回\nツール呼び出し 1 回\n\n/);
  // UTC の 7 日は 9/26 00:00Z から（9/25 15:00Z の行は入らない）
  assert.match(text, /\*\*直近 7 日\*\*（2026-09-26〜2026-10-02）\nターン 3（成功 2 \/ 失敗 1）/);
});
