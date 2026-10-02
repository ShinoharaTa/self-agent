import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { RunContext } from "../src/agent/runner.ts";
import { describeResultError, SdkAgentRunner } from "../src/agent/sdk-runner.ts";
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

const cfg = {
  model: "claude-opus-5",
  workDir: "/srv/work",
  claudeConfigDir: "/srv/claude",
  turnTimeoutSec: 300,
  effort: undefined,
};

/** テストで使うフィールドだけのメッセージ */
function sdkMessage(fields: Record<string, unknown>): SDKMessage {
  return fields as unknown as SDKMessage;
}

function init(sessionId: string): SDKMessage {
  return sdkMessage({ type: "system", subtype: "init", session_id: sessionId });
}

function assistant(
  id: string,
  usage: { input: number; cacheRead: number | null; cacheCreation: number | null },
  parentToolUseId: string | null = null,
): SDKMessage {
  return sdkMessage({
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    session_id: "session-1",
    message: {
      id,
      usage: {
        input_tokens: usage.input,
        cache_read_input_tokens: usage.cacheRead,
        cache_creation_input_tokens: usage.cacheCreation,
      },
    },
  });
}

function success(sessionId: string, text: string): SDKMessage {
  return sdkMessage({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: sessionId,
    duration_ms: 4200,
  });
}

function compactBoundary(metadata: Record<string, unknown>): SDKMessage {
  return sdkMessage({ type: "system", subtype: "compact_boundary", session_id: "session-1", compact_metadata: metadata });
}

type QueryCall = { prompt: string; options: Options };

/** queryFn に渡したストリームと、run ごとに作った MCP サーバーを記録する */
function setupRunner(
  stream: (call: QueryCall) => AsyncIterable<SDKMessage>,
  overrides: Partial<typeof cfg> = {},
) {
  const calls: QueryCall[] = [];
  const contexts: Array<RunContext | undefined> = [];
  const servers: McpSdkServerConfigWithInstance[] = [];
  const runner = new SdkAgentRunner(
    { ...cfg, ...overrides },
    (context) => {
      contexts.push(context);
      const server = createSdkMcpServer({ name: "selfagent", version: "0.1.0", tools: [] });
      servers.push(server);
      return server;
    },
    (call) => {
      calls.push(call);
      return stream(call);
    },
  );
  return { runner, calls, contexts, servers };
}

/** 決まったメッセージを順に流すストリーム */
function messages(...list: SDKMessage[]): () => AsyncIterable<SDKMessage> {
  return async function* () {
    yield* list;
  };
}

test("SdkAgentRunner: 成功ならメインループの usage を合算し、並列ツール呼び出しの同じ message.id とサブエージェントは数えない", async () => {
  const { runner, calls } = setupRunner(
    messages(
      init("session-1"),
      assistant("msg-1", { input: 10, cacheRead: 1000, cacheCreation: 200 }),
      // 並列ツール呼び出しは同じ id で複数届く
      assistant("msg-1", { input: 10, cacheRead: 1000, cacheCreation: 200 }),
      assistant("msg-sub", { input: 999, cacheRead: 999, cacheCreation: 999 }, "toolu-1"),
      assistant("msg-2", { input: 5, cacheRead: 1200, cacheCreation: null }),
      success("session-1", "登録しました"),
    ),
  );

  const result = await runner.run({ prompt: "明日買い物に行く" });

  assert.deepEqual(result, {
    ok: true,
    text: "登録しました",
    sessionId: "session-1",
    usage: { inputTokens: 15, cacheReadInputTokens: 2200, cacheCreationInputTokens: 200 },
    durationMs: 4200,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.prompt, "明日買い物に行く");
  assert.equal("resume" in calls[0]!.options, false);
  assert.ok(calls[0]!.options.abortController instanceof AbortController);
  assert.equal(calls[0]!.options.strictMcpConfig, true);
});

test("SdkAgentRunner: sessionId を渡せば resume する", async () => {
  const { runner, calls } = setupRunner(messages(success("session-1", "続き")));

  const result = await runner.run({ prompt: "続けて", sessionId: "session-1" });

  assert.equal(result.ok, true);
  assert.equal(calls[0]!.options.resume, "session-1");
});

test("SdkAgentRunner: compact_boundary を受け取ったら compacted に trigger と要約前のトークン数を入れる", async () => {
  const { runner } = setupRunner(
    messages(
      init("session-1"),
      compactBoundary({ trigger: "auto", pre_tokens: 150000 }),
      assistant("msg-1", { input: 10, cacheRead: 0, cacheCreation: 3000 }),
      success("session-1", "はい"),
    ),
  );

  const result = await runner.run({ prompt: "x", sessionId: "session-1" });

  assert.ok(result.ok);
  assert.deepEqual(result.compacted, { trigger: "auto", preTokens: 150000 });

  // pre_tokens が無ければ trigger だけ
  const { runner: second } = setupRunner(messages(compactBoundary({ trigger: "manual" }), success("session-1", "はい")));
  const secondResult = await second.run({ prompt: "x" });
  assert.ok(secondResult.ok);
  assert.deepEqual(secondResult.compacted, { trigger: "manual" });
});

test("SdkAgentRunner: is_error・error_max_turns は result の session_id を返し、sessionRecorded は true", async () => {
  const isError = setupRunner(
    messages(
      init("session-1"),
      sdkMessage({ type: "result", subtype: "success", is_error: true, result: "API Error: 500", session_id: "session-2" }),
    ),
  );
  assert.deepEqual(await isError.runner.run({ prompt: "x" }), {
    ok: false,
    errorMessage: "success (is_error): API Error: 500",
    sessionId: "session-2",
    sessionRecorded: true,
  });

  const maxTurns = setupRunner(
    messages(sdkMessage({ type: "result", subtype: "error_max_turns", is_error: true, errors: [], session_id: "session-3" })),
  );
  assert.deepEqual(await maxTurns.runner.run({ prompt: "x", sessionId: "session-3" }), {
    ok: false,
    errorMessage: "error_max_turns",
    sessionId: "session-3",
    sessionRecorded: true,
  });
});

test("SdkAgentRunner: result が届かずに終われば失敗。途中の session_id は返すが sessionRecorded は false", async () => {
  const { runner } = setupRunner(
    messages(init("session-1"), assistant("msg-1", { input: 10, cacheRead: 0, cacheCreation: 0 })),
  );

  assert.deepEqual(await runner.run({ prompt: "x" }), {
    ok: false,
    errorMessage: "result メッセージを受け取れませんでした",
    sessionId: "session-1",
    sessionRecorded: false,
  });
});

test("SdkAgentRunner: ストリームの例外は exception として返し、sessionRecorded は false", async () => {
  const { runner } = setupRunner(async function* () {
    yield init("session-1");
    throw new Error("Claude Code process exited with code 1");
  });

  assert.deepEqual(await runner.run({ prompt: "x", sessionId: "session-0" }), {
    ok: false,
    errorMessage: "exception: Error: Claude Code process exited with code 1",
    sessionId: "session-1",
    sessionRecorded: false,
  });
});

test("SdkAgentRunner: turnTimeoutSec を過ぎたら abort して timeout を返す（例外で終わっても、そのまま終わっても）", async () => {
  /** abort されるまで待ち、throws なら例外で、そうでなければそのまま終える */
  const untilAbort = (throws: boolean) =>
    async function* (call: QueryCall): AsyncIterable<SDKMessage> {
      yield init("session-1");
      const signal = call.options.abortController!.signal;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      if (throws) throw new Error("Claude Code process aborted by user");
    };
  const expected = { ok: false, errorMessage: "timeout", sessionId: "session-1", sessionRecorded: false };

  for (const throws of [true, false]) {
    // 10ms で打ち切る
    const { runner, calls } = setupRunner(untilAbort(throws), { turnTimeoutSec: 0.01 });
    assert.deepEqual(await runner.run({ prompt: "x" }), expected);
    assert.equal(calls[0]!.options.abortController!.signal.aborted, true);
  }
});

test("SdkAgentRunner: run ごとに context を渡して MCP サーバーを作り、その query の Options に入れる", async () => {
  const { runner, calls, contexts, servers } = setupRunner(messages(success("session-1", "はい")));
  const first = { guildId: "guild-1", channelId: "inbox-1" };
  const second = { guildId: "guild-1", channelId: "topic-1" };

  await runner.run({ prompt: "1", context: first });
  await runner.run({ prompt: "2", context: second });
  await runner.run({ prompt: "3" });

  assert.deepEqual(contexts, [first, second, undefined]);
  assert.equal(servers.length, 3);
  assert.notEqual(servers[0], servers[1]);
  assert.equal(calls.length, 3);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.options.mcpServers?.selfagent, servers[index]);
  }
});
