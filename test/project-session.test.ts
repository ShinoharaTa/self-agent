// プロジェクトのセッション（docs/plan/unify.md §6.1 の 1〜5・§6.2。U1a）: profile の Options、許可の橋（canUseTool → cc_permissions → カード → PermissionResult）、
// 秘密の場所の拒否、ツールの not_available、ターンの runner の選び方、DB の v40
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createSdkMcpServer,
  type CanUseTool,
  type HookInput,
  type PermissionResult,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createPermissionBridge,
  createPermissionPoster,
  PROJECT_PERMISSION_DENY_MESSAGE,
  PROJECT_PERMISSION_SUMMARY_TURN_MESSAGE,
  projectPermissionTimeoutMessage,
} from "../src/agent/permission-bridge.ts";
import {
  createProjectProfile,
  createSecretPlaceGuard,
  PROJECT_SECRET_DENIED_REASON,
  touchesSecretPlace,
} from "../src/agent/project-profile.ts";
import { buildQueryOptions } from "../src/agent/query-options.ts";
import type { RunContext } from "../src/agent/runner.ts";
import { type QueryFn, SdkAgentRunner } from "../src/agent/sdk-runner.ts";
import { PROJECT_APPEND, SHELL_SYSTEM_PROMPT, SYSTEM_PROMPT } from "../src/agent/system-prompt.ts";
import {
  createProjectToolHandlers,
  createReminderToolHandlers,
  PROJECT_TOOLS_IN_PROJECT_SESSION_MESSAGE,
} from "../src/agent/tools.ts";
import { PROJECT_NEEDS_CC_ERROR, runChannelTurn } from "../src/app/turn.ts";
import { CcPermissionHold } from "../src/cc/permission-hold.ts";
import type { CcTimers } from "../src/cc/registry.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { FakeRunner } from "./helpers/runner.ts";

const BASE = Date.parse("2026-11-06T00:00:00.000Z");
const GUILD = "guild-1";
const CHANNEL = "channel-1";
const SESSION = "33333333-3333-4333-8333-333333333333";

/** 一時のワークスペース（プロジェクト alpha）と self-agent の場所 */
function places(t: TestContext) {
  const root = realpathSync(tempDir(t));
  const workspaceDir = join(root, "workspace");
  mkdirSync(join(workspaceDir, "alpha"), { recursive: true });
  const home = join(root, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  const cfg = {
    model: "claude-opus-5",
    effort: "high" as const,
    workDir: join(root, "work"),
    dataDir: join(root, "data"),
    claudeConfigDir: join(root, "claude"),
    workspaceDir,
    sessionMaxTurns: 40,
  };
  return { root, workspaceDir, home, cfg };
}

function mcpServer() {
  return createSdkMcpServer({ name: "selfagent", version: "0.1.0", tools: [] });
}

const context = (extra: Partial<RunContext> = {}): RunContext => ({
  guildId: GUILD,
  channelId: CHANNEL,
  kind: "session",
  projectDir: "alpha",
  permissionMode: "acceptEdits",
  ...extra,
});

test("軽いモード: buildQueryOptions の systemPrompt・settingSources・cwd・tools は今までどおり", () => {
  const options = buildQueryOptions({ model: "m", workDir: "/srv/work", claudeConfigDir: "/srv/claude", effort: undefined }, mcpServer());
  assert.deepEqual(options.systemPrompt, { type: "custom", prompt: SYSTEM_PROMPT, snapshot: false });
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.cwd, "/srv/work/cwd");
  assert.deepEqual(options.tools, ["WebSearch", "WebFetch", "Read", "Write", "Edit", "Glob"]);
  assert.equal(options.permissionMode, "dontAsk");
  // 既定の SYSTEM_PROMPT には PROJECT_APPEND を混ぜていない
  assert.ok(!SYSTEM_PROMPT.includes(PROJECT_APPEND) && !SHELL_SYSTEM_PROMPT.includes(PROJECT_APPEND));
  const lines = PROJECT_APPEND.split("\n").length;
  assert.ok(lines >= 10 && lines <= 15, String(lines));
});

test("createProjectProfile: preset・settingSources・cwd（プロジェクトの実際の場所）・tools なし・許可のモード・env・disallowedTools", (t) => {
  const { workspaceDir, home, cfg } = places(t);
  const contexts: Array<RunContext | undefined> = [];
  const canUse: CanUseTool = async () => ({ behavior: "allow" });
  const logs: string[] = [];
  const profile = createProjectProfile({
    cfg,
    createMcpServer: (ctx) => {
      contexts.push(ctx);
      return mcpServer();
    },
    canUseTool: () => canUse,
    home,
    env: { PATH: "/usr/bin", HOME: home, CLAUDE_CODE_OAUTH_TOKEN: "oauth", DISCORD_TOKEN: "discord" },
    log: (line) => logs.push(line),
  });
  const options = profile.buildOptions({ prompt: "x", context: context() }, { sessionId: () => undefined });
  assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code", append: PROJECT_APPEND, snapshot: true });
  assert.deepEqual(options.settingSources, ["user", "project", "local"]);
  assert.equal(options.cwd, join(workspaceDir, "alpha"));
  assert.equal("tools" in options, false);
  assert.equal(options.permissionMode, "acceptEdits");
  assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
  assert.deepEqual(options.allowedTools, ["mcp__selfagent__*", "WebSearch", "WebFetch"]);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.model, "claude-opus-5");
  assert.equal(options.effort, "high");
  assert.equal(options.maxTurns, 40);
  assert.equal(options.canUseTool, canUse);
  assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["selfagent"]);
  assert.equal(contexts[0]?.projectDir, "alpha");
  const env = options.env ?? {};
  assert.equal("CLAUDE_CODE_PROJECT_DIR_NAME" in env, false);
  assert.equal("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS" in env, false);
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(env.CLAUDE_CONFIG_DIR, cfg.claudeConfigDir);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth");
  assert.equal("DISCORD_TOKEN" in env, false);
  // 選べないモードは default にして log
  const bypass = profile.buildOptions(
    { prompt: "x", context: context({ permissionMode: "bypassPermissions" as never }) },
    { sessionId: () => undefined },
  );
  assert.equal(bypass.permissionMode, "default");
  assert.ok(logs.some((line) => line.includes("default にしました")));
  // 検証を通らないプロジェクト（無い・symlink・形の違う名前）は投げる
  symlinkSync(join(workspaceDir, "alpha"), join(workspaceDir, "link"));
  for (const projectDir of ["missing", "link", "../alpha", "a/b"]) {
    assert.throws(() => profile.buildOptions({ prompt: "x", context: context({ projectDir }) }, { sessionId: () => undefined }), projectDir);
  }
});

test("秘密の場所: Read・Glob・Grep・Edit で dataDir・CLAUDE_CONFIG_DIR・~/.ssh などを拒否し、プロジェクトの中は通す", async (t) => {
  const { workspaceDir, home, cfg } = places(t);
  const secrets = [cfg.dataDir, cfg.claudeConfigDir, join(home, ".config/self-agent"), join(home, ".ssh"), join(home, ".config/gh")];
  const cwd = join(workspaceDir, "alpha");
  const denied: Array<[string, Record<string, unknown>]> = [
    ["Read", { file_path: join(cfg.dataDir, "self-agent.db") }],
    ["Read", { file_path: "~/.ssh/id_ed25519" }],
    ["Read", { file_path: "../../home/.ssh/id_ed25519" }],
    ["Edit", { file_path: join(cfg.claudeConfigDir, "settings.json") }],
    ["Grep", { pattern: "x", path: home }],
    ["Glob", { pattern: "/**/id_*" }],
    ["Glob", { pattern: "~/.config/gh/*" }],
    ["NotebookEdit", { notebook_path: join(home, ".config/self-agent/env") }],
  ];
  for (const [tool, input] of denied) assert.equal(touchesSecretPlace(tool, input, cwd, secrets, home), true, `${tool} ${JSON.stringify(input)}`);
  // symlink で秘密の場所を指しても拒否
  symlinkSync(join(home, ".ssh"), join(cwd, "keys"));
  assert.equal(touchesSecretPlace("Read", { file_path: "keys/id" }, cwd, secrets, home), true);
  for (const [tool, input] of [
    ["Read", { file_path: "src/index.ts" }],
    ["Glob", { pattern: "**/*.ts" }],
    ["Grep", { pattern: "x" }],
  ] as Array<[string, Record<string, unknown>]>) {
    assert.equal(touchesSecretPlace(tool, input, cwd, secrets, home), false, `${tool} ${JSON.stringify(input)}`);
  }
  // hook として: 拒否の理由を返し、log はツール名だけ
  const logs: string[] = [];
  const guard = createSecretPlaceGuard(secrets, home, (line) => logs.push(line));
  const hook = guard.hooks[0]!;
  const output = await hook(
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(home, ".ssh/id") }, cwd } as unknown as HookInput,
    undefined,
    { signal: new AbortController().signal },
  );
  assert.deepEqual(output, {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PROJECT_SECRET_DENIED_REASON },
  });
  assert.ok(logs.every((line) => !line.includes(home)));
  // Bash の字面は見ない
  assert.deepEqual(
    await hook(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `cat ${home}/.ssh/id` }, cwd } as unknown as HookInput,
      undefined,
      { signal: new AbortController().signal },
    ),
    {},
  );
});

/** 呼ぶと pending の関数を全部呼ぶ偽のタイマー */
function fakeTimers() {
  const pending: Array<() => void> = [];
  const timers: CcTimers = {
    after: (fn) => {
      let cancelled = false;
      pending.push(() => {
        if (!cancelled) fn();
      });
      return () => {
        cancelled = true;
      };
    },
  };
  return { timers, fire: () => pending.splice(0).forEach((fn) => fn()) };
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`待ちきれませんでした: ${label}`);
}

/** profile 付きの runner と、canUseTool を 1 回呼んで結果を残す偽の query */
function setupBridge(t: TestContext, suggestions: unknown[] = []) {
  const { workspaceDir, home, cfg } = places(t);
  const db = tempDb(t);
  const now = () => new Date(BASE);
  const stores = createStores(db, now);
  stores.topicSessions.create({ channelId: CHANNEL, guildId: GUILD, title: "self-agent の作業", categoryId: "cat-1" });
  stores.topicSessions.setProject(CHANNEL, "alpha", "default");
  const permissions = new CcPermissionStore(db, now);
  const { timers, fire } = fakeTimers();
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const hold = new CcPermissionHold({
    cfg: { ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 },
    store: permissions,
    known: () => false,
    now,
    timers,
    log,
  });
  const gateway = new FakeGateway({ allow: ["sendMessage", "editMessage"] });
  const poster = createPermissionPoster({
    gateway,
    permissions,
    topicSessions: stores.topicSessions,
    cfg: { ownerUserId: "owner-1", workspaceDir },
    home,
    holdSec: 300,
    history: stores.history,
    log,
  });
  const bridge = createPermissionBridge({ permissions, hold, poster, holdSec: 300, workspaceDir, home, log });
  const results: PermissionResult[] = [];
  const signal = new AbortController();
  // 失敗したテストで保留が残らないよう、終わりに中断する
  t.after(() => signal.abort());
  const queryFn: QueryFn = (call) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: SESSION } as unknown as SDKMessage;
      const result = await call.options.canUseTool!("Bash", { command: "npm run check", description: "check" }, {
        signal: signal.signal,
        suggestions: suggestions as never,
      } as never);
      if (result !== null) results.push(result);
      yield { type: "result", subtype: "success", is_error: false, result: "済み", session_id: SESSION, duration_ms: 1 } as unknown as SDKMessage;
    })();
  const runner = new SdkAgentRunner(
    { ...cfg, turnTimeoutSec: 300, sessionTurnTimeoutSec: 900 },
    undefined,
    undefined,
    log,
    queryFn,
    undefined,
    createProjectProfile({ cfg, createMcpServer: () => mcpServer(), canUseTool: bridge, home, env: {}, log }),
  );
  const run = runner.run({ prompt: "npm run check を実行して", context: context({ permissionMode: "default" }) });
  return { db, permissions, hold, gateway, results, run, fire, logs, signal, stores, workspaceDir };
}

test("許可の橋: canUseTool で origin sdk・pending の行とカードの 1 通ができ、[許可] で allow になり 1 通を書き換える", async (t) => {
  const s = setupBridge(t);
  await until(() => s.gateway.posts.length === 1, "カード");
  const row = s.permissions.listPending()[0]!;
  assert.equal(row.origin, "sdk");
  assert.equal(row.sessionId, SESSION);
  assert.equal(row.toolName, "Bash");
  assert.equal(row.summary, "npm run check");
  assert.equal(row.messageChannelId, CHANNEL);
  const post = s.gateway.posts[0]!;
  assert.equal(post.channelId, CHANNEL);
  assert.ok(post.message.text.includes("の作業（alpha・default）"), post.message.text);
  const buttons = post.message.components?.[0];
  assert.ok(buttons?.kind === "buttons" && buttons.buttons.some((button) => button.customId === `cc:perm:allow:${row.id}`));
  // registry 側には数えない
  assert.equal(s.hold.holding(), false);
  assert.deepEqual([...s.hold.pendingSessions()], []);
  assert.deepEqual(s.hold.answer(row.id, "allow", "web", row.requestHash), { ok: true, state: "allowed" });
  const result = await s.run;
  assert.ok(result.ok);
  assert.deepEqual(s.results, [{ behavior: "allow" }]);
  assert.equal(s.permissions.get(row.id)?.state, "allowed");
  await until(() => s.gateway.edits.length === 1, "書き換え");
  assert.ok(s.gateway.edits[0]!.message.text.includes("許可（Web）"));
  assert.ok(s.logs.includes(`プロジェクトのセッション: 許可の要求（#${row.id}）→ allowed（web）`));
  assert.ok(s.logs.every((line) => !line.includes("npm run check") && !line.includes(SESSION)));
  // Web の会話に要求と結果
  const notices = s.stores.history.list(CHANNEL, { limit: 10 }).map((h) => h.text);
  assert.ok(notices.some((text) => text.startsWith("許可を待っています: Bash")));
  assert.ok(notices.some((text) => text.startsWith("許可の要求（Bash）: 許可（Web）")));
});

test("許可の橋: [拒否] は deny、時間切れは deny と expired、ターンの中断は deny と released", async (t) => {
  {
    const s = setupBridge(t);
    await until(() => s.gateway.posts.length === 1, "カード");
    const row = s.permissions.listPending()[0]!;
    assert.deepEqual(s.hold.answer(row.id, "deny", "discord"), { ok: true, state: "denied" });
    await s.run;
    assert.deepEqual(s.results, [{ behavior: "deny", message: PROJECT_PERMISSION_DENY_MESSAGE }]);
    // Discord で押したものは応答で書き換える（ここでは書き換えない）
    assert.equal(s.gateway.edits.length, 0);
  }
  {
    const s = setupBridge(t);
    await until(() => s.gateway.posts.length === 1, "カード");
    const row = s.permissions.listPending()[0]!;
    s.fire();
    await s.run;
    assert.deepEqual(s.results, [{ behavior: "deny", message: projectPermissionTimeoutMessage(300) }]);
    assert.equal(s.permissions.get(row.id)?.state, "expired");
  }
  {
    const s = setupBridge(t);
    await until(() => s.gateway.posts.length === 1, "カード");
    const row = s.permissions.listPending()[0]!;
    s.signal.abort();
    await s.run;
    assert.equal(s.results[0]?.behavior, "deny");
    assert.equal(s.permissions.get(row.id)?.state, "released");
    assert.equal(s.permissions.get(row.id)?.via, "abort");
  }
});

test("許可の橋: [常に許可] は行のルールを destination session で返す（提案の localSettings は使わない）", async (t) => {
  const s = setupBridge(t, [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run check:*" }], behavior: "allow", destination: "localSettings" },
  ]);
  await until(() => s.gateway.posts.length === 1, "カード");
  const row = s.permissions.listPending()[0]!;
  assert.deepEqual(row.alwaysRules, [{ toolName: "Bash", ruleContent: "npm run check:*" }]);
  assert.deepEqual(s.hold.answer(row.id, "always", "web", row.requestHash), { ok: true, state: "allowed_always" });
  await s.run;
  assert.deepEqual(s.results, [
    {
      behavior: "allow",
      updatedPermissions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run check:*" }], behavior: "allow", destination: "session" },
      ],
    },
  ]);
});

test("ツール: プロジェクトのセッションでは project_open・project_files・reminder_set の prompt は not_available", async () => {
  const projectDeps = {
    projects: {
      getByChannel: () => assert.fail("引かない"),
      create: () => assert.fail("作らない"),
      touch: () => assert.fail("触らない"),
    },
    projectsDir: "/srv/work/projects",
    publicBaseUrl: "https://example.test",
    serving: () => true,
    log: () => undefined,
  };
  const handlers = createProjectToolHandlers(projectDeps, context());
  const open = JSON.parse((await handlers.projectOpen({ name: "x", title: "x" })).content[0].text);
  assert.deepEqual(open, { status: "not_available", message: PROJECT_TOOLS_IN_PROJECT_SESSION_MESSAGE });
  const files = JSON.parse((await handlers.projectFiles({ action: "restore" } as never)).content[0].text);
  assert.deepEqual(files, { result: "not_available", message: PROJECT_TOOLS_IN_PROJECT_SESSION_MESSAGE });
  const reminders = createReminderToolHandlers(
    { reminders: { create: () => assert.fail("作らない") } as never, log: () => undefined },
    { get: () => undefined },
    "Asia/Tokyo",
    context(),
  );
  const prompt = JSON.parse(reminders.reminderSet({ text: "x", kind: "prompt", at: "2026-11-07 09:00" }).content[0].text);
  assert.equal(prompt.result, "not_available");
});

test("runChannelTurn: プロジェクトのセッションは発言も /close も projectRunner で context に projectDir・permissionMode。予約した依頼は軽いモード", async (t) => {
  const db = tempDb(t);
  const now = () => new Date(BASE);
  const stores = createStores(db, now);
  stores.topicSessions.create({ channelId: CHANNEL, guildId: GUILD, title: "作業", categoryId: "cat-1" });
  stores.topicSessions.setProject(CHANNEL, "alpha", "plan");
  const ok = (sessionId: string) => ({
    ok: true as const,
    text: "x",
    sessionId,
    usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0, steps: [] },
    durationMs: 1,
    toolCalls: 0,
    contextTokens: 0,
  });
  const runner = new FakeRunner([ok("light-1")]);
  const projectRunner = new FakeRunner([ok("project-1"), ok("project-1")]);
  const deps = { ...stores, runner, projectRunner, log: () => undefined };
  const turn = { guildId: GUILD, channelId: CHANNEL, kind: "session" as const, prompt: "やって", allowedUrls: [] };
  await runChannelTurn(deps, turn);
  assert.equal(projectRunner.inputs.length, 1);
  assert.equal(projectRunner.inputs[0]!.context?.projectDir, "alpha");
  assert.equal(projectRunner.inputs[0]!.context?.permissionMode, "plan");
  await runChannelTurn(deps, { ...turn, purpose: "close" });
  assert.equal(projectRunner.inputs.length, 2);
  assert.equal(projectRunner.inputs[1]!.context?.purpose, "close");
  assert.equal(projectRunner.inputs[1]!.context?.projectDir, "alpha");
  // /close も会話の記録の場所を合わせるため同じ SDK セッションを resume する
  assert.equal(projectRunner.inputs[1]!.sessionId, "project-1");
  await runChannelTurn(deps, { ...turn, scheduled: true });
  assert.equal(runner.inputs.length, 1);
  assert.ok(runner.inputs.every((input) => input.context?.projectDir === undefined));
  // projectRunner が無ければ（SELF_AGENT_CC が無効）始めない
  const none = await runChannelTurn({ ...stores, runner: new FakeRunner([]), log: () => undefined }, turn);
  assert.deepEqual(none, { ok: false, errorMessage: PROJECT_NEEDS_CC_ERROR, toolCalls: 0, sessionRecorded: false });
  // 軽いモードのセッション（project_dir なし）は今までどおり
  assert.equal(stores.topicSessions.projectDirOf("other"), undefined);
});

test("openDb: v39 の DB を v40 に上げると cc_permissions の行と番号が残り origin は hook、sessions に project_dir・permission_mode ができる", (t) => {
  const path = join(tempDir(t), "self-agent.db");
  const v39 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 39)) v39.exec(migration);
  v39.exec("PRAGMA user_version = 39");
  v39
    .prepare(
      `INSERT INTO cc_permissions (id, session_id, request_hash, tool_name, summary, permission_mode, state, via, created_at, resolved_at,
         always_rules, message_id, message_channel_id, question_input, answers)
       VALUES (7, ?, 'h', 'Bash', 's', 'default', 'allowed', 'web', 'c', 'r', NULL, 'm', 'ch', NULL, NULL)`,
    )
    .run(SESSION);
  v39
    .prepare(
      "INSERT INTO sessions (channel_id, guild_id, title, state, category_id, created_at, last_activity_at) VALUES ('s-1', 'g', 't', 'active', 'c', 'a', 'a')",
    )
    .run();
  v39.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  const store = new CcPermissionStore(db, () => new Date(BASE));
  const row = store.get(7);
  assert.equal(row?.origin, "hook");
  assert.equal(row?.state, "allowed");
  assert.equal(row?.messageId, "m");
  // AUTOINCREMENT の番号は続く
  const added = store.add({ sessionId: SESSION, requestHash: "h2", toolName: "Bash", summary: "s", permissionMode: null, state: "pending", origin: "sdk" });
  assert.ok(added.id > 7);
  assert.equal(added.origin, "sdk");
  // 索引 3 つと一意の部分索引
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cc_permissions' AND sql IS NOT NULL ORDER BY name").all();
  assert.deepEqual(indexes.map((index) => index.name), ["cc_permissions_created", "cc_permissions_pending", "cc_permissions_session"]);
  assert.throws(() => store.add({ sessionId: SESSION, requestHash: "h3", toolName: "Bash", summary: "s", permissionMode: null, state: "pending" }), /UNIQUE/);
  assert.throws(() => db.prepare("UPDATE cc_permissions SET origin = 'x' WHERE id = 7").run());
  // via の abort
  assert.ok(store.resolve(added.id, "released", "abort"));
  const sessions = createStores(db, () => new Date(BASE)).topicSessions;
  assert.equal(sessions.projectDirOf("s-1"), undefined);
  assert.ok(sessions.setProject("s-1", "alpha", "acceptEdits"));
  assert.deepEqual(sessions.projectDirOf("s-1"), { projectDir: "alpha", permissionMode: "acceptEdits" });
  assert.equal(sessions.setProject("missing", "alpha", "default"), false);
});

test("/api/channels: プロジェクトのセッションの行に projectDir と最新の origin sdk の許可の要求（/api/cc/sessions と同じ形）", async (t) => {
  const { channelRoutes } = await import("../src/web/routes/channels.ts");
  const { createChannelResolver } = await import("../src/app/access.ts");
  const db = tempDb(t);
  const now = () => new Date(BASE);
  const stores = createStores(db, now);
  stores.guildSettings.setChannel(GUILD, "inboxChannelId", "100");
  stores.topicSessions.create({ channelId: CHANNEL, guildId: GUILD, title: "作業", categoryId: "c" });
  stores.topicSessions.setProject(CHANNEL, "alpha", "acceptEdits");
  stores.topicSessions.create({ channelId: "light", guildId: GUILD, title: "軽い", categoryId: "c" });
  stores.sessions.set(CHANNEL, SESSION);
  const permissions = new CcPermissionStore(db, now);
  // hook の行は出さない
  permissions.add({ sessionId: SESSION, requestHash: "h0", toolName: "Bash", summary: "hook", permissionMode: null, state: "released", via: "limit" });
  const row = permissions.add({ sessionId: SESSION, requestHash: "h1", toolName: "Bash", summary: "npm test", permissionMode: "default", state: "pending", origin: "sdk" });
  const cfg = { allowedGuildIds: [GUILD], personas: [], publicBaseUrl: undefined, inboxChannelId: undefined };
  const routes = channelRoutes({
    cfg,
    guildSettings: stores.guildSettings,
    topicSessions: stores.topicSessions,
    projects: stores.projects,
    history: stores.history,
    personas: { ownerOf: () => "default", all: [] },
    resolveChannel: createChannelResolver(cfg, stores.guildSettings, stores.topicSessions),
    projectPermissions: { store: permissions, sessions: stores.sessions, now, holdSec: 300, questionHoldSec: 900 },
  });
  const list = routes.find((route) => route.pattern.source === "^\\/api\\/channels$")!;
  const result = await list.handle({ params: [], query: new URLSearchParams() } as never);
  const channels = (result.json as { channels: Array<Record<string, unknown>> }).channels;
  const project = channels.find((c) => c.id === CHANNEL)!;
  assert.deepEqual(project.projectDir, { dir: "alpha", permissionMode: "acceptEdits" });
  const permission = project.permission as Record<string, unknown>;
  assert.equal(permission.id, row.id);
  assert.equal(permission.state, "pending");
  assert.equal(permission.requestHash, "h1");
  assert.equal(permission.expiresAt, new Date(BASE + 300_000).toISOString());
  const light = channels.find((c) => c.id === "light")!;
  assert.equal(light.projectDir, null);
  assert.equal(light.permission, null);
});

test("Claude Code のチャンネルを作る口は origin sdk の要求に答えても呼ばない", async () => {
  const { ccPermissionAnsweredHandler } = await import("../src/cc/channels.ts");
  const ensured: string[] = [];
  const handler = ccPermissionAnsweredHandler({
    permissions: { get: (id) => ({ id, sessionId: SESSION, origin: id === 1 ? "sdk" : "hook", questionInput: null }) as never },
    channels: () => ({ ensureFor: async (sessionId: string) => void ensured.push(sessionId) }) as never,
    log: () => undefined,
  });
  handler(1, GUILD);
  handler(2, GUILD);
  assert.deepEqual(ensured, [SESSION]);
});

test("/renew: プロジェクトのセッションは projectRunner で context に purpose renew。軽いモードのセッションは今までどおり context なし", async (t) => {
  const { renewSession } = await import("../src/app/session-renew.ts");
  const { KeyedSerialQueue } = await import("../src/app/queue.ts");
  const db = tempDb(t);
  const now = () => new Date(BASE);
  const stores = createStores(db, now);
  stores.topicSessions.create({ channelId: CHANNEL, guildId: GUILD, title: "作業", categoryId: "c" });
  stores.topicSessions.setProject(CHANNEL, "alpha", "default");
  stores.topicSessions.create({ channelId: "light", guildId: GUILD, title: "軽い", categoryId: "c" });
  stores.sessions.set(CHANNEL, "project-session");
  stores.sessions.set("light", "light-session");
  const done = {
    ok: true as const,
    text: "- 要約",
    sessionId: "x",
    usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0, steps: [] },
    durationMs: 1,
    toolCalls: 0,
    contextTokens: 0,
  };
  const runner = new FakeRunner([done]);
  const projectRunner = new FakeRunner([done]);
  const deps = {
    topicSessions: stores.topicSessions,
    turnQueue: new KeyedSerialQueue(2),
    turn: { runner, projectRunner, sessions: stores.sessions, seeds: stores.seeds, usage: stores.usage, log: () => undefined },
    log: () => undefined,
  };
  assert.equal((await renewSession(deps, GUILD, CHANNEL)).result, "renewed");
  assert.equal(projectRunner.inputs.length, 1);
  assert.equal(projectRunner.inputs[0]!.sessionId, "project-session");
  assert.deepEqual(projectRunner.inputs[0]!.context, {
    guildId: GUILD,
    channelId: CHANNEL,
    kind: "session",
    purpose: "renew",
    projectDir: "alpha",
    permissionMode: "default",
  });
  assert.equal((await renewSession(deps, GUILD, "light")).result, "renewed");
  assert.equal(runner.inputs.length, 1);
  assert.equal(runner.inputs[0]!.context, undefined);
});

test("許可の橋: 要約のターン（purpose close・renew）はカードを出さず行も作らずに拒否する", async (t) => {
  const { workspaceDir, home } = places(t);
  const db = tempDb(t);
  const now = () => new Date(BASE);
  const permissions = new CcPermissionStore(db, now);
  const logs: string[] = [];
  const bridge = createPermissionBridge({
    permissions,
    hold: { holdExternal: () => assert.fail("保留しない") },
    poster: { post: () => assert.fail("出さない"), resolved: () => assert.fail("出さない") },
    holdSec: 300,
    workspaceDir,
    home,
    log: (line) => logs.push(line),
  });
  for (const purpose of ["close", "renew"] as const) {
    const canUse = bridge(context({ purpose }), () => SESSION);
    const result = await canUse("Bash", { command: "ls" }, { signal: new AbortController().signal } as never);
    assert.deepEqual(result, { behavior: "deny", message: PROJECT_PERMISSION_SUMMARY_TURN_MESSAGE });
  }
  assert.equal(permissions.countPending(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cc_permissions").get()?.n, 0);
  assert.equal(logs.length, 2);
});

test("文面: プロジェクトのセッション（terminal false）は端末・RC の文を出さず、時間切れは拒否。hook の文は変えない", async () => {
  const { permissionNotice, permissionResolvedMessage, permissionResultLine } = await import("../src/cc/notice-text.ts");
  const { permissionResultHistoryText } = await import("../src/cc/channel-posts.ts");
  const row = {
    id: 9,
    sessionId: SESSION,
    requestHash: "h",
    toolName: "Bash",
    summary: "npm test",
    permissionMode: "default",
    alwaysRules: null,
    state: "pending" as const,
    via: null,
    createdAt: new Date(BASE).toISOString(),
    resolvedAt: null,
    messageId: null,
    messageChannelId: null,
    questionInput: null,
    answers: null,
    origin: "sdk" as const,
  };
  // RC の id があっても terminal false なら [RC で開く] は付けない
  const session = { name: "作業", cwd: "/w/alpha", bridgeSessionId: "session_abc" };
  const places = { workspaceDir: "/w", home: "/h" };
  const notice = permissionNotice(row, session, { ...places, holdSec: 300, terminal: false });
  assert.ok(notice.text.includes("ボタンは 5 分効きます。過ぎたら拒否になります"), notice.text);
  assert.ok(!notice.text.includes("端末") && !notice.text.includes("RC"), notice.text);
  assert.ok(notice.components?.every((c) => c.kind !== "links"));
  const hookNotice = permissionNotice({ ...row, origin: "hook" }, session, { ...places, holdSec: 300 });
  assert.ok(hookNotice.text.includes("端末や RC のダイアログでも答えられます（ボタンは 5 分効きます）"));
  assert.ok(hookNotice.components?.some((c) => c.kind === "links"));
  const expired = { ...row, state: "expired" as const };
  assert.equal(permissionResultLine(expired, undefined, false), "時間切れ（拒否しました）");
  assert.equal(permissionResultLine(expired, undefined), "時間切れ。端末か RC で答えてください");
  const resolved = permissionResolvedMessage(expired, session, places, false);
  assert.ok(resolved.text.endsWith("時間切れ（拒否しました）"), resolved.text);
  assert.deepEqual(resolved.components, []);
  assert.equal(permissionResultHistoryText(expired, false), "許可の要求（Bash）: 時間切れ（拒否しました）");
  assert.equal(permissionResultHistoryText(expired), "許可の要求（Bash）: 時間切れ。端末か RC で答えてください");
});
