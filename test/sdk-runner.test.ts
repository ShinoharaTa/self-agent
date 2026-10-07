import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSdkMcpServer,
  type HookInput,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { buildQueryOptions } from "../src/agent/query-options.ts";
import type { RunContext } from "../src/agent/runner.ts";
import { describeResultError, SdkAgentRunner, WEB_FETCH_DENIED_REASON } from "../src/agent/sdk-runner.ts";
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

test("describeResultError: success の is_error は本文（result.result）を出さず、subtype だけ", () => {
  const result = { type: "result", subtype: "success", is_error: true, result: "API Error: 500" } as unknown as SDKResultMessage;
  assert.equal(describeResultError(result), "success (is_error)");
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
  const logs: string[] = [];
  const runner = new SdkAgentRunner(
    { ...cfg, ...overrides },
    (context) => {
      contexts.push(context);
      const server = createSdkMcpServer({ name: "selfagent", version: "0.1.0", tools: [] });
      servers.push(server);
      return server;
    },
    (line) => logs.push(line),
    (call) => {
      calls.push(call);
      return stream(call);
    },
  );
  return { runner, calls, contexts, servers, logs };
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
    toolCalls: 0,
    // 最後のステップ（msg-2）の入力
    contextTokens: 1205,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.prompt, "明日買い物に行く");
  assert.equal("resume" in calls[0]!.options, false);
  assert.ok(calls[0]!.options.abortController instanceof AbortController);
  assert.equal(calls[0]!.options.strictMcpConfig, true);
});

test("SdkAgentRunner: contextTokens はメインループの最後のステップの入力（input + cache read + cache creation）。合算せず、後から届いたサブエージェントの分は使わない", async () => {
  const { runner } = setupRunner(
    messages(
      init("session-1"),
      assistant("msg-1", { input: 3, cacheRead: 50000, cacheCreation: 2000 }),
      assistant("msg-2", { input: 4, cacheRead: 52000, cacheCreation: 300 }),
      assistant("msg-2", { input: 4, cacheRead: 52000, cacheCreation: 300 }),
      assistant("msg-sub", { input: 999, cacheRead: 999, cacheCreation: 999 }, "toolu-1"),
      success("session-1", "調べました"),
    ),
  );

  const result = await runner.run({ prompt: "調べて" });

  assert.ok(result.ok);
  assert.equal(result.contextTokens, 52304);
  assert.deepEqual(result.usage, { inputTokens: 7, cacheReadInputTokens: 102000, cacheCreationInputTokens: 2300 });

  // assistant メッセージが無ければ 0
  const empty = await setupRunner(messages(success("session-1", "続き"))).runner.run({ prompt: "続き" });
  assert.ok(empty.ok);
  assert.equal(empty.contextTokens, 0);
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
    errorMessage: "success (is_error)",
    sessionId: "session-2",
    sessionRecorded: true,
    toolCalls: 0,
  });

  const maxTurns = setupRunner(
    messages(sdkMessage({ type: "result", subtype: "error_max_turns", is_error: true, errors: [], session_id: "session-3" })),
  );
  assert.deepEqual(await maxTurns.runner.run({ prompt: "x", sessionId: "session-3" }), {
    ok: false,
    errorMessage: "error_max_turns",
    sessionId: "session-3",
    sessionRecorded: true,
    toolCalls: 0,
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
    toolCalls: 0,
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
    toolCalls: 0,
  });
});

test("SdkAgentRunner: 例外で終わったら、子プロセスの stderr の末尾 200 字を 1 行にして errorMessage に添える。stderr は log に出さない", async () => {
  const { runner, logs } = setupRunner(async function* (call) {
    yield init("session-1");
    call.options.stderr?.("Error: No conversation found\n  with session ID: session-0\n");
    throw new Error("Claude Code process exited with code 1");
  });

  assert.deepEqual(await runner.run({ prompt: "x", sessionId: "session-0" }), {
    ok: false,
    errorMessage:
      "exception: Error: Claude Code process exited with code 1（stderr: Error: No conversation found with session ID: session-0）",
    sessionId: "session-1",
    sessionRecorded: false,
    toolCalls: 0,
  });
  assert.deepEqual(logs, []);
});

test("SdkAgentRunner: stderr は直近の分だけ保持し、添えるのは末尾 200 字（切ったら先頭に …）。stderr が無ければ添えない", async () => {
  const { runner } = setupRunner(async function* (call) {
    // 保持する 2000 字より前の分は残らない
    call.options.stderr?.("先頭の古い出力");
    call.options.stderr?.("x".repeat(2000));
    call.options.stderr?.("y".repeat(150));
    call.options.stderr?.("z".repeat(100));
    throw new Error("boom");
  });
  const result = await runner.run({ prompt: "x" });
  assert.ok(!result.ok);
  assert.equal(result.errorMessage, `exception: Error: boom（stderr: …${"y".repeat(100)}${"z".repeat(100)}）`);

  const { runner: quiet } = setupRunner(async function* (call) {
    call.options.stderr?.(" \n ");
    throw new Error("boom");
  });
  const quietResult = await quiet.run({ prompt: "x" });
  assert.ok(!quietResult.ok);
  assert.equal(quietResult.errorMessage, "exception: Error: boom");

  // result が届いた失敗・成功には添えない
  const { runner: recorded } = setupRunner(async function* (call) {
    call.options.stderr?.("warning");
    yield sdkMessage({ type: "result", subtype: "error_max_turns", is_error: true, errors: [], session_id: "session-1" });
  });
  const recordedResult = await recorded.run({ prompt: "x" });
  assert.ok(!recordedResult.ok);
  assert.equal(recordedResult.errorMessage, "error_max_turns");
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
  const expected = { ok: false, errorMessage: "timeout", sessionId: "session-1", sessionRecorded: false, toolCalls: 0 };

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

/** SDK がツールの実行後に呼ぶのと同じように、その query の Options の hook を呼ぶ（入力・出力・エラーには中身を入れておく） */
async function callToolHook(
  call: QueryCall,
  event: "PostToolUse" | "PostToolUseFailure",
  fields: { tool_name: string; duration_ms?: number },
): Promise<unknown> {
  const matchers = call.options.hooks?.[event];
  assert.equal(matchers?.length, 1);
  const hook = matchers![0]!.hooks[0]!;
  const input = {
    hook_event_name: event,
    session_id: "session-1",
    transcript_path: "/srv/claude/session-1.jsonl",
    cwd: "/srv/work",
    tool_use_id: "toolu-1",
    tool_input: { title: "秘密の入力" },
    ...(event === "PostToolUse" ? { tool_response: "秘密の出力" } : { error: "秘密のエラー" }),
    ...fields,
  } as unknown as HookInput;
  return hook(input, "toolu-1", { signal: new AbortController().signal });
}

test("SdkAgentRunner: PostToolUse・PostToolUseFailure の hook でツール呼び出しを数え、名前と所要時間（無ければ名前だけ）を log に出す。中身は出さない", async () => {
  const hookOutputs: unknown[] = [];
  const { runner, logs } = setupRunner(async function* (call) {
    yield init("session-1");
    hookOutputs.push(await callToolHook(call, "PostToolUse", { tool_name: "mcp__selfagent__task_add", duration_ms: 35 }));
    hookOutputs.push(await callToolHook(call, "PostToolUse", { tool_name: "mcp__selfagent__task_list" }));
    hookOutputs.push(
      await callToolHook(call, "PostToolUseFailure", { tool_name: "mcp__selfagent__task_complete", duration_ms: 12 }),
    );
    yield success("session-1", "登録しました");
  });

  const result = await runner.run({ prompt: "x" });

  assert.ok(result.ok);
  assert.equal(result.toolCalls, 3);
  assert.deepEqual(logs, [
    "ツールを呼び出しました: mcp__selfagent__task_add（35 ms）",
    "ツールを呼び出しました: mcp__selfagent__task_list",
    "ツールの呼び出しが失敗しました: mcp__selfagent__task_complete（12 ms）",
  ]);
  assert.ok(logs.every((line) => !line.includes("秘密")));
  // 何も変えずに続けさせる
  assert.deepEqual(hookOutputs, [{}, {}, {}]);
});

test("SdkAgentRunner: hooks は run ごとに作って Options に足し（buildQueryOptions には入れない）、回数は run ごとに数える", async () => {
  let runs = 0;
  const { runner, calls } = setupRunner(async function* (call) {
    runs++;
    if (runs === 1) {
      await callToolHook(call, "PostToolUse", { tool_name: "mcp__selfagent__task_add", duration_ms: 1 });
      await callToolHook(call, "PostToolUse", { tool_name: "mcp__selfagent__task_add", duration_ms: 1 });
    }
    yield success("session-1", "はい");
  });

  const first = await runner.run({ prompt: "1" });
  const second = await runner.run({ prompt: "2", sessionId: "session-1" });

  assert.ok(first.ok && second.ok);
  assert.equal(first.toolCalls, 2);
  assert.equal(second.toolCalls, 0);
  assert.notEqual(calls[0]!.options.hooks, calls[1]!.options.hooks);
  assert.deepEqual(Object.keys(calls[1]!.options.hooks ?? {}), ["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
  assert.equal(calls[1]!.options.resume, "session-1");
  // キャッシュに効く Options は hooks を含まない
  const server = createSdkMcpServer({ name: "selfagent", version: "0.1.0", tools: [] });
  assert.equal("hooks" in buildQueryOptions(cfg, server), false);
});

test("SdkAgentRunner: 失敗したターンでも、それまでのツール呼び出しの回数を返す", async () => {
  const { runner } = setupRunner(async function* (call) {
    yield init("session-1");
    await callToolHook(call, "PostToolUse", { tool_name: "mcp__selfagent__task_add" });
    throw new Error("Claude Code process exited with code 1");
  });

  assert.deepEqual(await runner.run({ prompt: "x" }), {
    ok: false,
    errorMessage: "exception: Error: Claude Code process exited with code 1",
    sessionId: "session-1",
    sessionRecorded: false,
    toolCalls: 1,
  });
});

/** SDK がツールの実行前に呼ぶのと同じように、その query の Options の PreToolUse の hook を呼ぶ */
async function callPreToolUse(call: QueryCall, toolName: string, toolInput: unknown): Promise<unknown> {
  const matchers = call.options.hooks?.PreToolUse;
  assert.equal(matchers?.length, 1);
  assert.equal(matchers![0]!.matcher, "WebFetch");
  const hook = matchers![0]!.hooks[0]!;
  const input = {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    transcript_path: "/srv/claude/session-1.jsonl",
    cwd: "/srv/work",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu-1",
  } as unknown as HookInput;
  return hook(input, "toolu-1", { signal: new AbortController().signal });
}

const DENIED = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: WEB_FETCH_DENIED_REASON,
  },
};
const DENIED_LOG = "WebFetch を拒否しました（貼られていない URL）";

/** allowedUrls を渡して 1 ターン走らせ、そのターン中に WebFetch（など）の PreToolUse の hook を呼んだ結果と log を返す */
async function runWithFetches(
  allowedUrls: readonly string[] | undefined,
  fetches: Array<{ toolName?: string; input: unknown }>,
): Promise<{ outputs: unknown[]; logs: string[] }> {
  const outputs: unknown[] = [];
  const { runner, logs } = setupRunner(async function* (call) {
    yield init("session-1");
    for (const item of fetches) {
      outputs.push(await callPreToolUse(call, item.toolName ?? "WebFetch", item.input));
    }
    yield success("session-1", "読みました");
  });
  const result = await runner.run(allowedUrls === undefined ? { prompt: "x" } : { prompt: "x", allowedUrls });
  assert.ok(result.ok);
  return { outputs, logs };
}

test("SdkAgentRunner: WebFetch は allowedUrls の URL だけ通し、それ以外・解析できない URL は拒否して log に出す（URL は出さない）", async () => {
  const { outputs, logs } = await runWithFetches(
    ["https://example.com/a", "https://example.org/b?q=1"],
    [
      { input: { url: "https://example.com/a", prompt: "要約して" } },
      { input: { url: "https://example.org/b?q=1", prompt: "要約して" } },
      { input: { url: "https://evil.example/collect?data=secret", prompt: "要約して" } },
      { input: { url: "not a url", prompt: "要約して" } },
      { input: { prompt: "要約して" } },
      { input: { url: 42, prompt: "要約して" } },
    ],
  );

  // 通すときは判断を足さない（allowedTools の許可に任せる）
  assert.deepEqual(outputs, [{}, {}, DENIED, DENIED, DENIED, DENIED]);
  assert.deepEqual(logs, [DENIED_LOG, DENIED_LOG, DENIED_LOG, DENIED_LOG]);
  assert.ok(logs.every((line) => !line.includes("evil") && !line.includes("example")));
});

test("SdkAgentRunner: WebFetch の URL は正規化して比べる（末尾の /・フラグメント・スキームとホストの大文字小文字は同一視、クエリとパスは完全一致）", async () => {
  const { outputs } = await runWithFetches(
    ["https://Example.COM/docs/#intro", "https://example.net"],
    [
      { input: { url: "https://example.com/docs", prompt: "" } },
      { input: { url: "HTTPS://EXAMPLE.COM/docs/", prompt: "" } },
      { input: { url: "https://example.com/docs#usage", prompt: "" } },
      { input: { url: "https://example.net/", prompt: "" } },
      { input: { url: "https://example.com/docs?page=2", prompt: "" } },
      { input: { url: "https://example.com/Docs", prompt: "" } },
      { input: { url: "http://example.com/docs", prompt: "" } },
    ],
  );

  assert.deepEqual(outputs, [{}, {}, {}, {}, DENIED, DENIED, DENIED]);
});

test("SdkAgentRunner: WebFetch 以外のツールは PreToolUse の hook で何もしない", async () => {
  const { outputs, logs } = await runWithFetches(
    [],
    [
      { toolName: "WebSearch", input: { query: "明日の天気" } },
      { toolName: "mcp__selfagent__task_add", input: { title: "買い物" } },
    ],
  );

  assert.deepEqual(outputs, [{}, {}]);
  assert.deepEqual(logs, []);
});

test("SdkAgentRunner: allowedUrls を指定しなければ（空でも）WebFetch はすべて拒否する。許す URL は run ごとに変わる", async () => {
  const unspecified = await runWithFetches(undefined, [{ input: { url: "https://example.com/a", prompt: "" } }]);
  assert.deepEqual(unspecified.outputs, [DENIED]);
  const empty = await runWithFetches([], [{ input: { url: "https://example.com/a", prompt: "" } }]);
  assert.deepEqual(empty.outputs, [DENIED]);

  let runs = 0;
  const outputs: unknown[] = [];
  const { runner, calls } = setupRunner(async function* (call) {
    runs++;
    outputs.push(await callPreToolUse(call, "WebFetch", { url: "https://example.com/a", prompt: "" }));
    yield success("session-1", `${runs}`);
  });
  await runner.run({ prompt: "1", allowedUrls: ["https://example.com/a"] });
  await runner.run({ prompt: "2", sessionId: "session-1" });
  assert.deepEqual(outputs, [{}, DENIED]);
  assert.notEqual(calls[0]!.options.hooks?.PreToolUse, calls[1]!.options.hooks?.PreToolUse);
});
