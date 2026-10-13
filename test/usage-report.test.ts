import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { RunContext, RunResult, StepUsage } from "../src/agent/runner.ts";
import { recordTurnUsage, runChannelTurn, type TurnDeps } from "../src/app/turn.ts";
import {
  cacheRate,
  formatTurnUsageLog,
  formatUsageEntry,
  formatUsageSteps,
  formatUsageTotals,
} from "../src/app/usage-report.ts";
import type { UsageEntry } from "../src/store/usage.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeRunner } from "./helpers/runner.ts";

const NOW = new Date("2026-10-01T15:04:05.000Z");

function step(input: number, read: number, creation: number, creation1h = 0): StepUsage {
  return {
    inputTokens: input,
    cacheReadInputTokens: read,
    cacheCreationInputTokens: creation,
    cacheCreation1hInputTokens: creation1h,
  };
}

/** 2 ステップ（1 ステップ目は 1 時間のキャッシュを書く）の成功したターンの usage（出力は result の合計） */
const TWO_STEPS = {
  inputTokens: 5,
  cacheReadInputTokens: 5000,
  cacheCreationInputTokens: 5100,
  cacheCreation1hInputTokens: 5000,
  outputTokens: 65,
  steps: [step(3, 0, 5000, 5000), step(2, 5000, 100)],
};

const OK: RunResult = {
  ok: true,
  text: "はい",
  sessionId: "session-1",
  usage: TWO_STEPS,
  durationMs: 4200,
  toolCalls: 2,
  contextTokens: 5102,
};

const OK_LOG =
  "トークン（session・成功）: ステップ 2、入力 10,105（読み 5,000・書き 5,100（1 時間 5,000）・なし 5）、出力 65、" +
  "キャッシュ率 49%、1 ステップ目 読み 0・書き 5,000";

function setup(t: TestContext) {
  const db = tempDb(t);
  const { usage } = createStores(db, () => NOW);
  const logs: string[] = [];
  return { usage, logs, deps: { usage, log: (line: string) => void logs.push(line) } };
}

test("recordTurnUsage: 成功はトークンの合計・種類・出力・1 時間の分・steps を記録し、トークンを 1 行 log に出す（チャンネル ID は出さない）", (t) => {
  const { usage, logs, deps } = setup(t);

  recordTurnUsage(deps, "topic-1", "session", { ...OK, compacted: { trigger: "auto", preTokens: 150000 } });

  const [entry] = usage.recent(1);
  assert.deepEqual(entry, {
    id: 1,
    at: NOW.toISOString(),
    key: "topic-1",
    sessionId: "session-1",
    ok: true,
    durationMs: 4200,
    inputTokens: 5,
    cacheReadInputTokens: 5000,
    cacheCreationInputTokens: 5100,
    compacted: true,
    toolCalls: 2,
    contextTokens: 5102,
    kind: "session",
    outputTokens: 65,
    cacheCreation1hInputTokens: 5000,
    steps: TWO_STEPS.steps,
  });
  // compaction の行はそのまま残す
  assert.deepEqual(logs, [OK_LOG, "会話が長くなったため SDK が古い部分を要約しました（trigger=auto、要約前 150000 トークン）"]);
  for (const line of logs) assert.ok(!line.includes("topic-1") && !line.includes("session-1"), line);
});

test("recordTurnUsage: 失敗はトークンの合計・出力を記録せず（/usage の合計は変わらない）、種類と届いたステップだけ残す。ステップが無ければ「記録なし」", (t) => {
  const { usage, logs, deps } = setup(t);
  const failed = { ok: false as const, errorMessage: "timeout", sessionId: "session-1", sessionRecorded: false, toolCalls: 1 };

  recordTurnUsage(deps, "topic-1", "session", {
    ...failed,
    usage: {
      inputTokens: 4,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 50,
      cacheCreation1hInputTokens: 50,
      steps: [step(4, 900, 50, 50)],
    },
  });
  recordTurnUsage(deps, "inbox-1", "inbox-rotate", failed);

  const pick = (entry: UsageEntry) => [
    entry.key,
    entry.ok,
    entry.kind,
    entry.inputTokens,
    entry.cacheReadInputTokens,
    entry.cacheCreationInputTokens,
    entry.outputTokens,
    entry.cacheCreation1hInputTokens,
    entry.contextTokens,
    entry.steps,
  ];
  assert.deepEqual(usage.recent(10).map(pick), [
    ["inbox-1", false, "inbox-rotate", null, null, null, null, null, 0, null],
    ["topic-1", false, "session", null, null, null, null, null, 0, [step(4, 900, 50, 50)]],
  ]);
  assert.equal(usage.summarize(new Date(0)).inputTokens, 0);
  assert.deepEqual(logs, [
    "トークン（session・失敗）: ステップ 1、入力 954（読み 900・書き 50（1 時間 50）・なし 4）、出力 -、キャッシュ率 94%、1 ステップ目 読み 900・書き 50",
    "トークン（inbox-rotate・失敗）: 記録なし",
  ]);
});

test("formatTurnUsageLog: ステップが無ければキャッシュ率と 1 ステップ目は -。出力が無ければ（result に usage が無い）出力は -", () => {
  const empty = {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    outputTokens: 0,
    steps: [],
  };
  assert.equal(
    formatTurnUsageLog("inbox", { ...OK, usage: empty }),
    "トークン（inbox・成功）: ステップ 0、入力 0（読み 0・書き 0（1 時間 0）・なし 0）、出力 0、キャッシュ率 -、1 ステップ目 読み -・書き -",
  );
  const { outputTokens: _outputTokens, ...withoutOutput } = TWO_STEPS;
  assert.equal(formatTurnUsageLog("session", { ...OK, usage: withoutOutput }), OK_LOG.replace("出力 65", "出力 -"));
});

test("runChannelTurn: 記録とログの種類はチャンネルの種類。予約した依頼のターンは -scheduled を付ける", async (t) => {
  const cases: Array<{ kind: RunContext["kind"]; scheduled?: true; expected: string }> = [
    { kind: "inbox", expected: "inbox" },
    { kind: "tasks", expected: "tasks" },
    { kind: "session", expected: "session" },
    { kind: "inbox", scheduled: true, expected: "inbox-scheduled" },
    { kind: "session", scheduled: true, expected: "session-scheduled" },
  ];
  for (const { kind, scheduled, expected } of cases) {
    const db = tempDb(t);
    const { sessions, seeds, topicSessions, inboxSummaries, memories, usage } = createStores(db, () => NOW);
    const logs: string[] = [];
    const deps: TurnDeps = {
      runner: new FakeRunner([OK]),
      sessions,
      seeds,
      topicSessions,
      inboxSummaries,
      memories,
      usage,
      log: (line) => void logs.push(line),
    };

    await runChannelTurn(deps, {
      guildId: "guild-1",
      channelId: "channel-1",
      kind,
      prompt: "x",
      allowedUrls: [],
      ...(scheduled === undefined ? {} : { scheduled }),
    });

    assert.equal(usage.recent(1)[0]?.kind, expected, expected);
    assert.equal(logs.length, 1, expected);
    assert.ok(logs[0]!.startsWith(`トークン（${expected}・成功）: `), logs[0]);
    assert.ok(!logs[0]!.includes("channel-1"), logs[0]);
  }
});

/** npm run usage の表示のテスト用の記録 */
function entry(fields: Partial<UsageEntry>): UsageEntry {
  return {
    id: 1,
    at: NOW.toISOString(),
    key: "topic-1",
    sessionId: "session-1",
    ok: true,
    durationMs: 4200,
    inputTokens: 5,
    cacheReadInputTokens: 5000,
    cacheCreationInputTokens: 5100,
    compacted: false,
    toolCalls: 2,
    contextTokens: 5102,
    kind: "session",
    outputTokens: 65,
    cacheCreation1hInputTokens: 5000,
    steps: TWO_STEPS.steps,
    ...fields,
  };
}

const NEW_OK = entry({});
/** v17 より前の成功（種類・出力・1 時間の分・steps が無い） */
const OLD_OK = entry({
  kind: null,
  durationMs: 3000,
  inputTokens: 10,
  cacheReadInputTokens: 2000,
  cacheCreationInputTokens: 300,
  contextTokens: 2310,
  outputTokens: null,
  cacheCreation1hInputTokens: null,
  steps: null,
});
/** 失敗（合計の列は NULL、ステップはある） */
const FAILED_WITH_STEPS = entry({
  kind: "inbox",
  ok: false,
  durationMs: null,
  inputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
  contextTokens: 0,
  outputTokens: null,
  cacheCreation1hInputTokens: null,
  steps: [step(4, 900, 50, 50)],
});
/** 失敗（ステップも無い） */
const FAILED_EMPTY = entry({ ...FAILED_WITH_STEPS, kind: "inbox-rotate", steps: null });

test("formatUsageEntry: 1 ターン 1 行（key・session_id は出さない）。古い行・失敗の無い値は -、失敗の入力側のトークンは steps から足す（出力は -）", () => {
  const cases: Array<[label: string, entry: UsageEntry, expected: string]> = [
    [
      "成功",
      NEW_OK,
      "00:04:05 session           ok steps 2 入力 10,105 読み 5,000 書き 5,100(1h 5,000) なし 5 出力 65 率 49% ctx 5,102 4.2s",
    ],
    [
      "v17 より前の行",
      OLD_OK,
      "00:04:05 -                 ok steps - 入力 2,310 読み 2,000 書き 300(1h -) なし 10 出力 - 率 87% ctx 2,310 3.0s",
    ],
    [
      "失敗（ステップあり）",
      FAILED_WITH_STEPS,
      "00:04:05 inbox             NG steps 1 入力 954 読み 900 書き 50(1h 50) なし 4 出力 - 率 94% ctx - -",
    ],
    [
      "失敗（ステップなし）",
      FAILED_EMPTY,
      "00:04:05 inbox-rotate      NG steps - 入力 - 読み - 書き -(1h -) なし - 出力 - 率 - ctx - -",
    ],
    [
      "入力が 0",
      entry({
        inputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        outputTokens: 0,
        contextTokens: 0,
        steps: [],
      }),
      "00:04:05 session           ok steps 0 入力 0 読み 0 書き 0(1h 0) なし 0 出力 0 率 - ctx 0 4.2s",
    ],
  ];
  for (const [label, value, expected] of cases) {
    const line = formatUsageEntry(value, "Asia/Tokyo");
    assert.equal(line, expected, label);
    assert.ok(!line.includes("topic-1") && !line.includes("session-1"), label);
  }
});

test("formatUsageSteps・formatUsageTotals: ステップごとの行と、出した行の合計（無い値は 0 として足す）", () => {
  assert.deepEqual(formatUsageSteps(TWO_STEPS.steps), [
    "  1: 読み 0 書き 5,000(1h 5,000) なし 3",
    "  2: 読み 5,000 書き 100(1h 0) なし 2",
  ]);
  assert.equal(
    formatUsageTotals([NEW_OK, OLD_OK, FAILED_WITH_STEPS, FAILED_EMPTY]),
    "合計: ターン 4 読み 7,900 書き 5,450 なし 19 出力 65 率 59%",
  );
  assert.equal(formatUsageTotals([]), "合計: ターン 0 読み 0 書き 0 なし 0 出力 0 率 -");
});

test("cacheRate: read / total を四捨五入した %。total が 0 なら -", () => {
  const cases: Array<[read: number, total: number, expected: string]> = [
    [0, 0, "-"],
    [0, 10, "0%"],
    [5000, 10105, "49%"],
    [2000, 2310, "87%"],
    [10, 10, "100%"],
  ];
  for (const [read, total, expected] of cases) assert.equal(cacheRate(read, total), expected, `${read}/${total}`);
});
