import { test } from "node:test";
import assert from "node:assert/strict";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describeResultError } from "../src/agent/sdk-runner.ts";
import { RESUME_FAILURE_PATTERN } from "../src/app/turn.ts";

/** describeResultError が見るフィールドだけの result */
function errorResult(subtype: "error_during_execution" | "error_max_turns", errors: string[]): SDKResultMessage {
  return { type: "result", subtype, is_error: true, errors } as unknown as SDKResultMessage;
}

test("describeResultError: errors があれば subtype に添え、resume 失敗の文言が残る", () => {
  const text = describeResultError(
    errorResult("error_during_execution", ["No conversation found with session ID: 00000000-0000-0000-0000-000000000000"]),
  );
  assert.equal(text, "error_during_execution: No conversation found with session ID: 00000000-0000-0000-0000-000000000000");
  assert.match(text, RESUME_FAILURE_PATTERN);
});

test("describeResultError: errors が空なら subtype だけ。複数あれば 1 行にまとめて短くする", () => {
  assert.equal(describeResultError(errorResult("error_max_turns", [])), "error_max_turns");
  assert.equal(describeResultError(errorResult("error_max_turns", ["", "  "])), "error_max_turns");
  assert.equal(describeResultError(errorResult("error_during_execution", ["a\nb", "c"])), "error_during_execution: a b / c");
  const long = describeResultError(errorResult("error_during_execution", ["x".repeat(500)]));
  assert.equal(long, `error_during_execution: ${"x".repeat(200)}…`);
});

test("describeResultError: success の is_error は本文を出す", () => {
  const result = { type: "result", subtype: "success", is_error: true, result: "API Error: 500" } as unknown as SDKResultMessage;
  assert.equal(describeResultError(result), "success (is_error): API Error: 500");
});
