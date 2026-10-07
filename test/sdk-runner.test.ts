import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSdkMcpServer,
  type HookInput,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { FILE_NO_CONTEXT_REASON, FILE_READ_DENIED_REASON, FILE_WRITE_DENIED_REASON } from "../src/agent/file-access.ts";
import { buildQueryOptions } from "../src/agent/query-options.ts";
import type { ProgressStep, RunContext, RunInput, RunResult } from "../src/agent/runner.ts";
import {
  describeResultError,
  FILE_GUARD_FAILED_REASON,
  INBOX_MAX_TURNS,
  progressLabel,
  SdkAgentRunner,
  WEB_FETCH_DENIED_REASON,
} from "../src/agent/sdk-runner.ts";
import { RESUME_FAILURE_PATTERN } from "../src/app/turn.ts";
import type { Project, ProjectStore } from "../src/store/projects.ts";

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
  sessionMaxTurns: 40,
  sessionTurnTimeoutSec: 900,
};

/** ファイル操作の hook のストア。既定ではどのチャンネルにもプロジェクトが無い */
type FakeProjects = Pick<ProjectStore, "getByChannel" | "touch"> & { touched: number[] };

function fakeProjects(byChannel: Record<string, Pick<Project, "id" | "slug">> = {}): FakeProjects {
  const touched: number[] = [];
  return {
    touched,
    getByChannel: (channelId) => {
      const project = byChannel[channelId];
      return project === undefined ? undefined : ({ ...project, channelId } as Project);
    },
    touch: (id) => {
      touched.push(id);
    },
  };
}

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
  files: { projects: FakeProjects; projectsDir: string } = { projects: fakeProjects(), projectsDir: "/srv/work/projects" },
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
    files,
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

test("SdkAgentRunner: 中断・打ち切りで終わったら、そのターンで受け取った session_id を返す（sessionRecorded は false）。受け取る前なら返さない", async () => {
  /** sessionId を受け取ってから（無ければ受け取らずに）abort されるまで待つ */
  const untilAbort = (sessionId: string | undefined) =>
    async function* (call: QueryCall): AsyncIterable<SDKMessage> {
      if (sessionId !== undefined) yield init(sessionId);
      const signal = call.options.abortController!.signal;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      throw new Error("Claude Code process aborted by user");
    };
  const abortSoon = async (runner: SdkAgentRunner, input: RunInput): Promise<RunResult> => {
    const controller = new AbortController();
    const running = runner.run({ ...input, signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    return running;
  };

  // resume したターンでも、受け取ったもの（init の session_id）を返す
  const resumed = setupRunner(untilAbort("session-1"));
  assert.deepEqual(await abortSoon(resumed.runner, { prompt: "x", sessionId: "session-0" }), {
    ok: false,
    errorMessage: "aborted",
    sessionId: "session-1",
    sessionRecorded: false,
    toolCalls: 0,
  });

  const before = setupRunner(untilAbort(undefined));
  assert.deepEqual(await abortSoon(before.runner, { prompt: "x" }), {
    ok: false,
    errorMessage: "aborted",
    sessionId: undefined,
    sessionRecorded: false,
    toolCalls: 0,
  });

  const timeout = setupRunner(untilAbort("session-2"), { turnTimeoutSec: 0.01 });
  assert.deepEqual(await timeout.runner.run({ prompt: "x" }), {
    ok: false,
    errorMessage: "timeout",
    sessionId: "session-2",
    sessionRecorded: false,
    toolCalls: 0,
  });
});

test("SdkAgentRunner: run ごとに context を渡して MCP サーバーを作り、その query の Options に入れる", async () => {
  const { runner, calls, contexts, servers } = setupRunner(messages(success("session-1", "はい")));
  const first: RunContext = { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" };
  const second: RunContext = { guildId: "guild-1", channelId: "topic-1", kind: "session" };

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

/**
 * SDK がツールの実行前に呼ぶのと同じように、その query の Options の PreToolUse の hook を呼ぶ。
 * matcher は WebFetch（既定）かファイル操作（Read|Write|Edit|Glob|Grep）。cwd は workDir
 */
async function callPreToolUse(
  call: QueryCall,
  toolName: string,
  toolInput: unknown,
  matcher: string = "WebFetch",
  cwd: string = "/srv/work",
): Promise<unknown> {
  const matchers = call.options.hooks?.PreToolUse;
  assert.deepEqual(
    matchers?.map((entry) => entry.matcher),
    ["WebFetch", "Read|Write|Edit|Glob|Grep"],
  );
  const hook = matchers!.find((entry) => entry.matcher === matcher)!.hooks[0]!;
  const input = {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    transcript_path: "/srv/claude/session-1.jsonl",
    cwd,
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

test("SdkAgentRunner: maxTurns はセッションのチャンネルなら sessionMaxTurns、#inbox・context なしは 8。run ごとに Options に入れる", async () => {
  const { runner, calls } = setupRunner(messages(success("session-1", "はい")), { sessionMaxTurns: 40 });

  await runner.run({ prompt: "1", context: { guildId: "guild-1", channelId: "topic-1", kind: "session" } });
  await runner.run({ prompt: "2", context: { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" } });
  await runner.run({ prompt: "3" });
  await runner.run({
    prompt: "4",
    sessionId: "session-1",
    context: { guildId: "guild-1", channelId: "topic-1", kind: "session" },
  });

  assert.equal(INBOX_MAX_TURNS, 8);
  assert.deepEqual(
    calls.map((call) => call.options.maxTurns),
    [40, 8, 8, 40],
  );
  // キャッシュに効く Options（buildQueryOptions）には入れない
  const server = createSdkMcpServer({ name: "selfagent", version: "0.1.0", tools: [] });
  assert.equal("maxTurns" in buildQueryOptions(cfg, server), false);
});

test("SdkAgentRunner: 打ち切りはセッションのチャンネルなら sessionTurnTimeoutSec、#inbox・context なしは turnTimeoutSec", async () => {
  /** abort されるまで待つ */
  const untilAbort = async function* (call: QueryCall): AsyncIterable<SDKMessage> {
    yield init("session-1");
    const signal = call.options.abortController!.signal;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
  };
  const timeout = { ok: false, errorMessage: "timeout", sessionId: "session-1", sessionRecorded: false, toolCalls: 0 };
  const session = { guildId: "guild-1", channelId: "topic-1", kind: "session" } as const;
  const inbox = { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" } as const;

  // セッションだけ 10ms で打ち切る（#inbox は 300 秒なので、打ち切られれば sessionTurnTimeoutSec を使っている）
  const short = setupRunner(untilAbort, { turnTimeoutSec: 300, sessionTurnTimeoutSec: 0.01 });
  assert.deepEqual(await short.runner.run({ prompt: "x", context: session }), timeout);

  // #inbox と context なしは 10ms で打ち切る（セッションの 900 秒は使わない）
  const inboxShort = setupRunner(untilAbort, { turnTimeoutSec: 0.01, sessionTurnTimeoutSec: 900 });
  assert.deepEqual(await inboxShort.runner.run({ prompt: "x", context: inbox }), timeout);
  assert.deepEqual(await inboxShort.runner.run({ prompt: "x" }), timeout);
});

test("SdkAgentRunner: ファイル操作の hook はどの run にも入る（context が無い run にも）。context はその run のもの", async () => {
  const outputs: unknown[] = [];
  const { runner, calls, logs } = setupRunner(async function* (call) {
    outputs.push(await callPreToolUse(call, "Read", { file_path: "/srv/work/notes.txt" }, "Read|Write|Edit|Glob|Grep"));
    yield success("session-1", "はい");
  });

  await runner.run({ prompt: "1" });
  await runner.run({ prompt: "2", context: { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" } });
  await runner.run({ prompt: "3", context: { guildId: "guild-1", channelId: "topic-1", kind: "session" } });

  assert.equal(calls.length, 3);
  assert.notEqual(calls[1]!.options.hooks?.PreToolUse, calls[2]!.options.hooks?.PreToolUse);
  const reasons = outputs.map(
    (output) => (output as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput,
  );
  assert.deepEqual(
    reasons.map((output) => output.permissionDecisionReason),
    [FILE_NO_CONTEXT_REASON, FILE_READ_DENIED_REASON, FILE_READ_DENIED_REASON],
  );
  assert.deepEqual(logs, Array(3).fill("ファイル操作を拒否しました（Read）"));
});

test("SdkAgentRunner: ファイル操作の hook は拒否したら理由をモデルに返し、log にはツール名だけを出す。Write・Edit を許したらプロジェクトの更新日時を今にする", async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const projectsDir = join(workDir, "projects");
  mkdirSync(join(projectsDir, "kakeibo", "site"), { recursive: true });
  mkdirSync(join(projectsDir, "other", "site"), { recursive: true });
  const projects = fakeProjects({ "topic-1": { id: 7, slug: "kakeibo" }, "topic-2": { id: 8, slug: "other" } });
  const topic = { guildId: "guild-1", channelId: "topic-1", kind: "session" } as const;
  const outputs: unknown[] = [];
  const { runner, logs } = setupRunner(
    async function* (call) {
      const pre = (toolName: string, input: unknown) =>
        callPreToolUse(call, toolName, input, "Read|Write|Edit|Glob|Grep", workDir);
      outputs.push(await pre("Write", { file_path: join(projectsDir, "kakeibo", "site", "index.html"), content: "<p>" }));
      outputs.push(await pre("Edit", { file_path: "projects/kakeibo/site/index.html", old_string: "a", new_string: "b" }));
      outputs.push(await pre("Read", { file_path: join(projectsDir, "other", "site", "index.html") }));
      outputs.push(await pre("Glob", { pattern: "**/*", path: join(projectsDir, "kakeibo") }));
      outputs.push(await pre("Write", { file_path: join(projectsDir, "other", "site", "secret-path.html"), content: "" }));
      outputs.push(await pre("Grep", { pattern: "TOKEN" }));
      // ファイル操作以外は何もしない
      outputs.push(await pre("mcp__selfagent__task_add", { title: "買い物" }));
      yield success("session-1", "作りました");
    },
    {},
    { projects, projectsDir },
  );

  const result = await runner.run({ prompt: "家計簿を作って", context: topic });

  assert.ok(result.ok);
  const deny = (reason: string) => ({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  });
  assert.deepEqual(outputs, [{}, {}, {}, {}, deny(FILE_WRITE_DENIED_REASON), deny(FILE_READ_DENIED_REASON), {}]);
  // 許した Write・Edit の分だけ（Read・Glob では変えない）
  assert.deepEqual(projects.touched, [7, 7]);
  assert.deepEqual(logs, ["ファイル操作を拒否しました（Write）", "ファイル操作を拒否しました（Grep）"]);
  assert.ok(logs.every((line) => !line.includes("secret-path") && !line.includes(workDir)));
});

test("SdkAgentRunner: ファイル操作の hook は判定が例外で終わったら（ストアの読み書きの失敗）拒否する。log にはツール名だけを出し、パス・例外の中身は出さない", async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const projectsDir = join(workDir, "projects");
  mkdirSync(join(projectsDir, "kakeibo", "site"), { recursive: true });
  const file = join(projectsDir, "kakeibo", "site", "index.html");
  const topic = { guildId: "guild-1", channelId: "topic-1", kind: "session" } as const;
  const deny = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: FILE_GUARD_FAILED_REASON,
    },
  };

  /** getByChannel か touch が投げるストアで 1 ターン走らせ、Read と Write の hook の結果と log を返す */
  const runWith = async (projects: FakeProjects) => {
    const outputs: unknown[] = [];
    const { runner, logs } = setupRunner(
      async function* (call) {
        const pre = (toolName: string, input: unknown) =>
          callPreToolUse(call, toolName, input, "Read|Write|Edit|Glob|Grep", workDir);
        outputs.push(await pre("Read", { file_path: file }));
        outputs.push(await pre("Write", { file_path: file, content: "<p>" }));
        yield success("session-1", "はい");
      },
      {},
      { projects, projectsDir },
    );
    assert.ok((await runner.run({ prompt: "x", context: topic })).ok);
    return { outputs, logs };
  };

  const brokenRead = await runWith({
    ...fakeProjects(),
    getByChannel: () => {
      throw new Error(`database is locked: ${file}`);
    },
  });
  assert.deepEqual(brokenRead.outputs, [deny, deny]);
  assert.deepEqual(brokenRead.logs, [
    "ファイル操作の判定に失敗したため拒否しました（Read）",
    "ファイル操作の判定に失敗したため拒否しました（Write）",
  ]);

  // 書き込みを許した後の更新日時の記録が失敗しても、通さずに拒否する（Read は記録しないので通す）
  const brokenTouch = await runWith({
    ...fakeProjects({ "topic-1": { id: 7, slug: "kakeibo" } }),
    touch: () => {
      throw new Error(`database is locked: ${file}`);
    },
  });
  assert.deepEqual(brokenTouch.outputs, [{}, deny]);
  assert.deepEqual(brokenTouch.logs, ["ファイル操作の判定に失敗したため拒否しました（Write）"]);
  assert.equal(FILE_GUARD_FAILED_REASON, "判定に失敗したため拒否しました");
  for (const line of [...brokenRead.logs, ...brokenTouch.logs]) {
    assert.ok(!line.includes(workDir) && !line.includes("database"), line);
  }
});

test("progressLabel: Write・Edit・Read はこのチャンネルのプロジェクトの中ならそこからの相対パスを添え、外・プロジェクト無し・パス無しなら添えない", (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const projectsDir = join(workDir, "projects");
  const projectDir = join(projectsDir, "kakeibo");
  mkdirSync(join(projectDir, "site"), { recursive: true });
  mkdirSync(join(projectsDir, "other"), { recursive: true });
  // プロジェクトの中から外を指す symlink
  symlinkSync(join(projectsDir, "other"), join(projectDir, "outside"));
  const label = (toolName: string, input: unknown) => progressLabel(toolName, input, workDir, projectDir);

  assert.equal(label("Write", { file_path: join(projectDir, "site", "index.html"), content: "<p>秘密</p>" }), "書いています: site/index.html");
  // 相対パスは cwd（workDir）を基準にする
  assert.equal(label("Edit", { file_path: "projects/kakeibo/site/app.js", old_string: "a", new_string: "b" }), "書いています: site/app.js");
  assert.equal(label("Read", { file_path: join(projectDir, "README.md") }), "読んでいます: README.md");
  // 外（別のプロジェクト・projects の外・`..` で出る・symlink の先が外・ディレクトリそのもの）
  assert.equal(label("Write", { file_path: join(projectsDir, "other", "index.html") }), "書いています");
  assert.equal(label("Read", { file_path: "/srv/elsewhere/notes.txt" }), "読んでいます");
  assert.equal(label("Read", { file_path: join(projectDir, "..", "other", "a.txt") }), "読んでいます");
  assert.equal(label("Read", { file_path: join(projectDir, "outside", "a.txt") }), "読んでいます");
  assert.equal(label("Read", { file_path: projectDir }), "読んでいます");
  // プロジェクトが無い（#inbox・まだ作っていない）・file_path が無い
  assert.equal(progressLabel("Write", { file_path: join(projectDir, "site", "index.html") }, workDir, undefined), "書いています");
  assert.equal(label("Edit", {}), "書いています");
  assert.equal(label("Read", null), "読んでいます");
});

test("progressLabel: ファイルを探す・Web・自前の MCP ツール・それ以外のツール。パターン・検索語・URL は出さない", () => {
  const label = (toolName: string, input: unknown) => progressLabel(toolName, input, "/srv/work", "/srv/work/projects/kakeibo");

  assert.equal(label("Glob", { pattern: "**/secret*", path: "/srv/work/projects/kakeibo" }), "ファイルを探しています");
  assert.equal(label("Grep", { pattern: "TOKEN" }), "ファイルを探しています");
  assert.equal(label("WebSearch", { query: "秘密の検索語" }), "Web を検索しています");
  assert.equal(label("WebFetch", { url: "https://example.com/private", prompt: "要約" }), "ページを読んでいます");
  assert.equal(label("mcp__selfagent__task_add", { title: "買い物" }), "ツールを使っています: task_add");
  assert.equal(label("mcp__selfagent__project_open", { name: "kakeibo" }), "ツールを使っています: project_open");
  assert.equal(label("mcp__other__run", {}), "mcp__other__run を使っています");
  assert.equal(label("Bash", { command: "cat ~/.config/self-agent/env" }), "Bash を使っています");
});

/** tool_use のブロックを 1 つ持つ assistant メッセージ（並列ツール呼び出しも 1 ブロックずつ届く） */
function toolUse(
  messageId: string,
  toolUseId: string,
  name: string,
  input: unknown,
  parentToolUseId: string | null = null,
): SDKMessage {
  return sdkMessage({
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    session_id: "session-1",
    message: {
      id: messageId,
      content: [{ type: "tool_use", id: toolUseId, name, input }],
      usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}

test("SdkAgentRunner: メインループの tool_use ごとに onProgress を 1 回呼ぶ（同じ id は 1 回、サブエージェントと tool_use 以外のブロックは呼ばない）。プロジェクトはそのたびに引く", async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const projectsDir = join(workDir, "projects");
  mkdirSync(join(projectsDir, "kakeibo", "site"), { recursive: true });
  // ターンの途中で project_open がプロジェクトを作る
  const byChannel: Record<string, Pick<Project, "id" | "slug">> = {};
  const projects = fakeProjects(byChannel);
  const indexHtml = join(projectsDir, "kakeibo", "site", "index.html");
  const { runner } = setupRunner(
    async function* () {
      yield init("session-1");
      yield sdkMessage({
        type: "assistant",
        parent_tool_use_id: null,
        session_id: "session-1",
        message: { id: "msg-0", content: [{ type: "text", text: "作ります" }], usage: { input_tokens: 1 } },
      });
      yield toolUse("msg-1", "toolu-1", "Write", { file_path: indexHtml, content: "<p>" });
      yield toolUse("msg-2", "toolu-2", "mcp__selfagent__project_open", { name: "kakeibo", title: "家計簿" });
      byChannel["topic-1"] = { id: 7, slug: "kakeibo" };
      // 並列ツール呼び出し（同じ message.id で 1 ブロックずつ）と、同じ tool_use の重複
      yield toolUse("msg-3", "toolu-3", "Write", { file_path: indexHtml, content: "<p>" });
      yield toolUse("msg-3", "toolu-4", "WebSearch", { query: "家計簿 アプリ" });
      yield toolUse("msg-3", "toolu-4", "WebSearch", { query: "家計簿 アプリ" });
      yield toolUse("msg-sub", "toolu-5", "Read", { file_path: indexHtml }, "toolu-9");
      yield success("session-1", "作りました");
    },
    { workDir },
    { projects, projectsDir },
  );
  const steps: ProgressStep[] = [];

  const result = await runner.run({
    prompt: "家計簿を作って",
    context: { guildId: "guild-1", channelId: "topic-1", kind: "session" },
    onProgress: (step) => steps.push(step),
  });

  assert.ok(result.ok);
  assert.deepEqual(steps, [
    { label: "書いています" },
    { label: "ツールを使っています: project_open" },
    { label: "書いています: site/index.html" },
    { label: "Web を検索しています" },
  ]);
});

test("SdkAgentRunner: signal が abort されたら止めて aborted を返す（打ち切りの timeout とは別）。始める前に abort 済みならすぐ止める", async () => {
  /** abort されるまで待ち、throws なら例外で、そうでなければそのまま終える */
  const untilAbort = (throws: boolean) =>
    async function* (call: QueryCall): AsyncIterable<SDKMessage> {
      yield init("session-1");
      const signal = call.options.abortController!.signal;
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      if (throws) throw new Error("Claude Code process aborted by user");
    };
  const aborted = { ok: false, errorMessage: "aborted", sessionId: "session-1", sessionRecorded: false, toolCalls: 0 };

  for (const throws of [true, false]) {
    const { runner, calls } = setupRunner(untilAbort(throws));
    const controller = new AbortController();
    const running = runner.run({ prompt: "x", signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    assert.deepEqual(await running, aborted);
    assert.equal(calls[0]!.options.abortController!.signal.aborted, true);
  }

  const already = new AbortController();
  already.abort();
  const { runner } = setupRunner(untilAbort(true));
  assert.deepEqual(await runner.run({ prompt: "x", signal: already.signal }), aborted);

  // signal を渡しても abort しなければ、打ち切りは timeout のまま
  const timeout = setupRunner(untilAbort(true), { turnTimeoutSec: 0.01 });
  assert.deepEqual(await timeout.runner.run({ prompt: "x", signal: new AbortController().signal }), {
    ...aborted,
    errorMessage: "timeout",
  });
});
