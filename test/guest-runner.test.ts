import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ensureGuestConfigDir,
  guestChildEnv,
  guestClaudeConfigDir,
  projectDirName,
} from "../src/agent/query-options.ts";
import { AUTH_SOURCE_MISMATCH_ERROR, type QueryFn } from "../src/agent/sdk-runner.ts";
import {
  buildGuestQueryOptions,
  createGuestRunner,
  GUEST_TOOL_DENIED_REASON,
} from "../src/guest/query-options.ts";
import { GUEST_SYSTEM_PROMPT } from "../src/guest/system-prompt.ts";

const API_KEY = "dummy-guest-api-key";

/** オーナー・ゲストのどちらの秘密も入った親の env */
const SOURCE = {
  PATH: "/usr/bin",
  HOME: "/home/tester",
  LANG: "ja_JP.UTF-8",
  HTTPS_PROXY: "http://proxy:8080",
  CLAUDE_CODE_OAUTH_TOKEN: "dummy-oauth-token",
  DISCORD_TOKEN: "dummy-discord-token",
  SELF_AGENT_GUEST_DISCORD_TOKEN: "dummy-guest-discord-token",
  SELF_AGENT_GUEST_API_KEY: API_KEY,
  CLAUDE_CONFIG_DIR: "/elsewhere",
  SELF_AGENT_SHELL: "1",
};

const CFG = {
  guestModel: "claude-opus-5-5",
  guestEffort: "low" as const,
  guestTurnTimeoutSec: 120,
  workDir: "/srv/work",
  claudeConfigDir: "/srv/claude",
};

test("guestChildEnv: ANTHROPIC_API_KEY にゲストの API キーを入れ、OAuth・Discord のトークン・API キーの元の変数は入れない。設定ディレクトリは <claudeConfigDir>-guest、記録の名前は既定と同じ", () => {
  const env = guestChildEnv(guestClaudeConfigDir("/srv/claude"), "/srv/work", SOURCE);
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    LANG: "ja_JP.UTF-8",
    HTTPS_PROXY: "http://proxy:8080",
    CLAUDE_CONFIG_DIR: "/srv/claude-guest",
    CLAUDE_CODE_PROJECT_DIR_NAME: projectDirName("/srv/work"),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ANTHROPIC_API_KEY: API_KEY,
  });
  for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "DISCORD_TOKEN", "SELF_AGENT_GUEST_DISCORD_TOKEN", "SELF_AGENT_GUEST_API_KEY"]) {
    assert.equal(key in env, false, key);
  }
  const text = JSON.stringify(env);
  for (const secret of ["dummy-oauth-token", "dummy-discord-token", "dummy-guest-discord-token"]) assert.ok(!text.includes(secret), secret);
  // API キーが無ければ ANTHROPIC_API_KEY も入れない
  assert.equal("ANTHROPIC_API_KEY" in guestChildEnv("/srv/claude-guest", "/srv/work", { PATH: "/usr/bin" }), false);
});

test("guestClaudeConfigDir: 末尾の / を除いて -guest を付ける（オーナーの設定ディレクトリの中にしない）", () => {
  assert.equal(guestClaudeConfigDir("/srv/claude"), "/srv/claude-guest");
  assert.equal(guestClaudeConfigDir("/srv/claude/"), "/srv/claude-guest");
});

test("ensureGuestConfigDir: <claudeConfigDir>-guest が無ければ 700 で作り、あれば何もしない。symlink・ファイルなら投げる（文にパスを入れない）", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "guest-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const claude = join(dir, "claude");
  mkdirSync(claude);
  const path = ensureGuestConfigDir(claude);
  assert.equal(path, `${claude}-guest`);
  assert.ok(lstatSync(path).isDirectory());
  assert.equal(statSync(path).mode & 0o777, 0o700);
  assert.equal(ensureGuestConfigDir(claude), path);

  const linked = join(dir, "linked");
  mkdirSync(join(dir, "target"));
  symlinkSync(join(dir, "target"), `${linked}-guest`);
  const file = join(dir, "file");
  writeFileSync(`${file}-guest`, "");
  for (const base of [linked, file]) {
    assert.throws(
      () => ensureGuestConfigDir(base),
      (error: Error) => error.message.includes("CLAUDE_CONFIG_DIR") && !error.message.includes(dir),
    );
  }
});

test("buildGuestQueryOptions: ツールなし（tools・allowedTools は []、MCP サーバーなし）・sandbox なし・maxTurns 1・model と effort は設定値・ゲスト用のシステムプロンプト（snapshot: false）。毎回同じ値", () => {
  const env = guestChildEnv("/srv/claude-guest", "/srv/work", SOURCE);
  const options = buildGuestQueryOptions({ model: "claude-opus-5-5", effort: "low", workDir: "/srv/work", env });
  assert.deepEqual(options, {
    model: "claude-opus-5-5",
    effort: "low",
    systemPrompt: { type: "custom", prompt: GUEST_SYSTEM_PROMPT, snapshot: false },
    tools: [],
    allowedTools: [],
    strictMcpConfig: true,
    settingSources: [],
    permissionMode: "dontAsk",
    cwd: "/srv/work/cwd",
    env,
    maxTurns: 1,
  });
  assert.equal("mcpServers" in options, false);
  assert.equal("sandbox" in options, false);
  assert.equal("hooks" in options, false);
  assert.deepEqual(options, buildGuestQueryOptions({ model: "claude-opus-5-5", effort: "low", workDir: "/srv/work", env }));
});

test("GUEST_SYSTEM_PROMPT: 呼び名と AI であることを含み、日付・年などの可変値を含まない", () => {
  assert.ok(GUEST_SYSTEM_PROMPT.includes("しのえもん"));
  assert.ok(GUEST_SYSTEM_PROMPT.includes("AI"));
  assert.ok(GUEST_SYSTEM_PROMPT.includes("[日時 #guest 発言者: <表示名>]"));
  assert.doesNotMatch(GUEST_SYSTEM_PROMPT, /\d{4}|\d{1,2}\s*[/\-月]\s*\d{1,2}/);
});

function sdkMessage(fields: Record<string, unknown>): SDKMessage {
  return fields as unknown as SDKMessage;
}

function init(apiKeySource?: string): SDKMessage {
  return sdkMessage({
    type: "system",
    subtype: "init",
    session_id: "session-1",
    ...(apiKeySource === undefined ? {} : { apiKeySource }),
  });
}

function success(text: string): SDKMessage {
  return sdkMessage({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: "session-1",
    duration_ms: 1000,
    usage: { output_tokens: 7 },
  });
}

type QueryCall = Parameters<QueryFn>[0];

/** createGuestRunner に偽の query を渡す。consumed は stream から取り出したメッセージの数 */
function guestRunner(stream: (call: QueryCall) => AsyncIterable<SDKMessage>) {
  const calls: QueryCall[] = [];
  const logs: string[] = [];
  const runner = createGuestRunner({
    cfg: CFG,
    log: (line) => logs.push(line),
    source: SOURCE,
    queryFn: (call) => {
      calls.push(call);
      return stream(call);
    },
  });
  return { runner, calls, logs };
}

test("ゲストの runner: Options はゲスト用（MCP サーバーなし・maxTurns 1・API キーの env）で、hooks は PreToolUse の全拒否とツール呼び出しの記録だけ", async () => {
  const { runner, calls } = guestRunner(async function* () {
    yield init("ANTHROPIC_API_KEY");
    yield success("こんにちは");
  });

  const result = await runner.run({ prompt: "[2026-10-23(金) 09:00 JST #guest 発言者: A]\nこんにちは" });

  assert.ok(result.ok);
  assert.equal(result.text, "こんにちは");
  const options: Options = calls[0]!.options;
  assert.equal("mcpServers" in options, false);
  assert.equal("sandbox" in options, false);
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.maxTurns, 1);
  assert.equal(options.model, "claude-opus-5-5");
  assert.equal(options.effort, "low");
  assert.equal(options.env?.ANTHROPIC_API_KEY, API_KEY);
  assert.equal(options.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(options.env?.CLAUDE_CONFIG_DIR, "/srv/claude-guest");
  // PreToolUse は matcher なしの 1 つだけ（WebFetch・ファイル・Bash の hook は無い）
  assert.deepEqual(options.hooks?.PreToolUse?.map((entry) => entry.matcher), [undefined]);
  assert.deepEqual(Object.keys(options.hooks ?? {}).sort(), ["PostToolUse", "PostToolUseFailure", "PreToolUse"]);
  assert.equal(options.hooks?.PostToolUse?.length, 1);
});

test("ゲストの runner: PreToolUse の hook はどのツールも拒否し、log にはツール名だけを出す", async () => {
  const outputs: unknown[] = [];
  const { runner, logs } = guestRunner(async function* (call) {
    yield init("ANTHROPIC_API_KEY");
    const hook = call.options.hooks!.PreToolUse![0]!.hooks[0]!;
    for (const [toolName, toolInput] of [
      ["Bash", { command: "cat /etc/passwd" }],
      ["WebFetch", { url: "https://evil.example/secret" }],
      ["mcp__selfagent__task_add", { title: "秘密の題名" }],
    ] as const) {
      const input = {
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        transcript_path: "/srv/claude-guest/session-1.jsonl",
        cwd: "/srv/work/cwd",
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: "toolu-1",
      } as unknown as HookInput;
      outputs.push(await hook(input, "toolu-1", { signal: new AbortController().signal }));
    }
    yield success("できません");
  });

  const result = await runner.run({ prompt: "x" });

  assert.ok(result.ok);
  const denied = {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: GUEST_TOOL_DENIED_REASON },
  };
  assert.deepEqual(outputs, [denied, denied, denied]);
  assert.deepEqual(logs, [
    "guest: ツールの呼び出しを拒否しました（Bash）",
    "guest: ツールの呼び出しを拒否しました（WebFetch）",
    "guest: ツールの呼び出しを拒否しました（mcp__selfagent__task_add）",
  ]);
  assert.ok(logs.every((line) => !line.includes("passwd") && !line.includes("evil") && !line.includes("秘密")));
});

test("ゲストの runner: init の apiKeySource が ANTHROPIC_API_KEY でなければ（none・apiKeySource なし）その run を失敗にして query を止める。log に値は出さない", async () => {
  for (const source of ["none", "/login managed key", undefined]) {
    let consumedAfterInit = false;
    let signal: AbortSignal | undefined;
    const { runner, logs } = guestRunner(async function* (call) {
      signal = call.options.abortController?.signal;
      yield init(source);
      consumedAfterInit = true;
      yield success("答えてしまった");
    });

    const result = await runner.run({ prompt: "x" });

    assert.deepEqual(result, {
      ok: false,
      errorMessage: AUTH_SOURCE_MISMATCH_ERROR,
      sessionId: "session-1",
      sessionRecorded: false,
      toolCalls: 0,
    }, String(source));
    assert.equal(consumedAfterInit, false, String(source));
    assert.equal(signal?.aborted, true, String(source));
    assert.deepEqual(logs, ["guest: 認証の種類が想定と違います"], String(source));
  }
});

test("ゲストの runner: init が来ない run（偽の query）は今までどおり動く", async () => {
  const { runner } = guestRunner(async function* () {
    yield success("はい");
  });
  const result = await runner.run({ prompt: "x" });
  assert.ok(result.ok);
});

test("ゲストの runner: dev ログの受け口を持たない（ゲストの本文を残さない）", () => {
  const { runner } = guestRunner(async function* () {});
  // createGuestRunner は dev ログを受け取らない。runner の中にも無いことを確かめる
  assert.equal((runner as unknown as { devLog: unknown }).devLog, undefined);
});
