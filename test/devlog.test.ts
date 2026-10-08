import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDevLogRecord, parseDevLog, selectDevLogRecords } from "../src/devlog/format.ts";
import {
  createDevLogSink,
  devLogResult,
  devLogToolInput,
  pruneDevLogs,
  truncateText,
  type DevLogRecord,
} from "../src/devlog/log.ts";

test("truncateText: 2,000 字までは切らず、超えたら先頭 2,000 字 + …（N 字を省略）。サロゲートペアの途中では切らない", () => {
  assert.equal(truncateText("あ".repeat(2000)), "あ".repeat(2000));
  assert.equal(truncateText("あ".repeat(2001)), `${"あ".repeat(2000)}…（1 字を省略）`);
  assert.equal(truncateText("abcdef", 3), "abc…（3 字を省略）");
  // 3 字目が 😀 の前半なら 2 字で切り、省略した字数（UTF-16 の単位）に含める
  assert.equal(truncateText("ab😀cd", 3), "ab…（4 字を省略）");
});

test("devLogToolInput: 文字列化して 2,000 字までならそのままの値、超えたら文字列化したものを切った文字列", () => {
  const small = { title: "牛乳を買う", due: null };
  assert.equal(devLogToolInput(small), small);
  assert.equal(devLogToolInput(undefined), null);
  const large = { content: "x".repeat(2000) };
  const text = JSON.stringify(large);
  assert.equal(devLogToolInput(large), `${text.slice(0, 2000)}…（${text.length - 2000} 字を省略）`);
});

test("devLogResult: 成功は durationMs を除き、compacted は起きたときだけ。失敗の sessionId は無ければ入れない", () => {
  const usage = { inputTokens: 1, cacheReadInputTokens: 2, cacheCreationInputTokens: 3 };
  assert.deepEqual(
    devLogResult({ ok: true, text: "はい", sessionId: "s", usage, durationMs: 10, toolCalls: 1, contextTokens: 6 }),
    { ok: true, text: "はい", sessionId: "s", usage, toolCalls: 1, contextTokens: 6 },
  );
  assert.deepEqual(
    devLogResult({
      ok: true,
      text: "はい",
      sessionId: "s",
      usage,
      durationMs: 10,
      compacted: { trigger: "auto" },
      toolCalls: 0,
      contextTokens: 6,
    }),
    { ok: true, text: "はい", sessionId: "s", usage, toolCalls: 0, contextTokens: 6, compacted: { trigger: "auto" } },
  );
  assert.deepEqual(
    devLogResult({ ok: false, errorMessage: "timeout", sessionId: undefined, sessionRecorded: false, toolCalls: 2 }),
    { ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 2 },
  );
});

test("pruneDevLogs: ディレクトリが無ければ何もしない（作らない）", (t) => {
  const root = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "devlog");

  pruneDevLogs(dir, new Date("2026-10-08T00:00:00.000Z"), "Asia/Tokyo", 30);

  assert.equal(existsSync(dir), false);
  // dev モードでなければ受け口も作らない
  assert.equal(createDevLogSink({ devMode: false, dataDir: root, timeZone: "Asia/Tokyo" }), undefined);
  assert.equal(existsSync(dir), false);
});

/** 表示のテスト用の記録 */
function record(fields: Partial<DevLogRecord> = {}): DevLogRecord {
  return {
    at: "2026-10-07T15:30:05.000Z",
    durationMs: 75_900,
    guildId: "guild-1",
    channelId: "topic-1",
    kind: "session",
    model: "claude-opus-5",
    effort: null,
    maxTurns: 40,
    resume: "session-0",
    prompt: "[2026-10-08 00:30 家計簿]\n家計簿を作って",
    steps: [],
    result: {
      ok: true,
      text: "作りました",
      sessionId: "session-1",
      usage: { inputTokens: 12, cacheReadInputTokens: 34000, cacheCreationInputTokens: 560 },
      toolCalls: 2,
      contextTokens: 17000,
    },
    ...fields,
  };
}

test("formatDevLogRecord: 見出し（時刻・種類・チャンネル・所要時間・トークン・ツール回数・成否）→ prompt → steps → 返答の全文", () => {
  const longInput = { file_path: "site/index.html", content: "x".repeat(400) };
  const longInputText = JSON.stringify(longInput);
  const text = formatDevLogRecord(
    record({
      steps: [
        { t: "text", text: `作ります\n${"説明".repeat(400)}` },
        { t: "tool_use", id: "toolu-1", name: "Write", input: longInput },
        { t: "tool_use", id: "toolu-2", name: "mcp__selfagent__project_open", input: { name: "kakeibo" } },
        { t: "tool_result", id: "toolu-2", isError: false, content: "作成しました" },
        { t: "tool_result", id: "toolu-1", isError: true, content: "e".repeat(350) },
        { t: "tool_result", id: "toolu-9", isError: false, content: "対応する呼び出しなし" },
        // 記録の時点で切った input（文字列）はそのまま出す
        { t: "tool_use", id: "toolu-3", name: "Edit", input: "{\"file_path\":\"a\"…（10 字を省略）" },
        { t: "compact", trigger: "auto", preTokens: 150000 },
        { t: "compact", trigger: "manual", preTokens: null },
      ],
    }),
    "Asia/Tokyo",
  );

  assert.equal(
    text,
    [
      "=== 00:30:05 session channel=topic-1 ===",
      "1 分 15 秒 | input 12 / cache read 34000 / cache creation 560 | ツール 2 回 | 成功",
      "--- prompt ---",
      "[2026-10-08 00:30 家計簿]",
      "家計簿を作って",
      "--- steps ---",
      `[text] 作ります\n${"説明".repeat(400)}`,
      `[tool_use] Write ${longInputText.slice(0, 300)}…（${longInputText.length - 300} 字を省略）`,
      '[tool_use] mcp__selfagent__project_open {"name":"kakeibo"}',
      "[tool_result mcp__selfagent__project_open] 作成しました",
      `[tool_result Write isError] ${"e".repeat(300)}…（50 字を省略）`,
      "[tool_result] 対応する呼び出しなし",
      '[tool_use] Edit {"file_path":"a"…（10 字を省略）',
      "[compact] auto（要約前 150000）",
      "[compact] manual",
      "--- 返答 ---",
      "作りました",
    ].join("\n"),
  );
});

test("formatDevLogRecord: 失敗は理由を出し、トークンは -。context の無い run の種類・チャンネルは -、steps が無ければ（なし）", () => {
  const text = formatDevLogRecord(
    record({
      at: "2026-10-08T03:04:05.000Z",
      durationMs: 300_400,
      guildId: null,
      channelId: null,
      kind: null,
      resume: null,
      prompt: "要約して",
      result: { ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 0 },
    }),
    "UTC",
  );

  assert.equal(
    text,
    [
      "=== 03:04:05 - channel=- ===",
      "5 分 0 秒 | input - / cache read - / cache creation - | ツール 0 回 | 失敗",
      "--- prompt ---",
      "要約して",
      "--- steps ---",
      "（なし）",
      "--- 失敗 ---",
      "timeout",
    ].join("\n"),
  );
});

test("parseDevLog: 1 行 1 記録。空行は無視し、JSON として読めない行は飛ばして数える", () => {
  const first = record();
  const second = record({ kind: "inbox", channelId: "inbox-1" });
  const parsed = parseDevLog(`${JSON.stringify(first)}\n\n{"at":\n${JSON.stringify(second)}\n`);
  assert.deepEqual(parsed, { records: [first, second], skipped: 1 });
});

test("selectDevLogRecords: kind・チャンネルで絞り、last は絞った後の最後の N 件", () => {
  const records = [
    record({ kind: "inbox", channelId: "inbox-1", prompt: "1" }),
    record({ kind: "session", channelId: "topic-1", prompt: "2" }),
    record({ kind: "session", channelId: "topic-2", prompt: "3" }),
    record({ kind: null, channelId: null, prompt: "4" }),
    record({ kind: "session", channelId: "topic-1", prompt: "5" }),
  ];
  const prompts = (selected: DevLogRecord[]): string[] => selected.map((entry) => entry.prompt);

  assert.deepEqual(prompts(selectDevLogRecords(records, {})), ["1", "2", "3", "4", "5"]);
  assert.deepEqual(prompts(selectDevLogRecords(records, { kind: "session" })), ["2", "3", "5"]);
  assert.deepEqual(prompts(selectDevLogRecords(records, { channelId: "topic-1" })), ["2", "5"]);
  assert.deepEqual(prompts(selectDevLogRecords(records, { kind: "session", last: 2 })), ["3", "5"]);
  assert.deepEqual(prompts(selectDevLogRecords(records, { last: 10 })), ["1", "2", "3", "4", "5"]);
  assert.deepEqual(prompts(selectDevLogRecords(records, { kind: "tasks" })), []);
});
