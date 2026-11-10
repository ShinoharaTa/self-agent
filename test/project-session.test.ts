// プロジェクトのセッション（docs/plan/unify.md §6.1 の 1〜5・§6.2。U1a）: profile の Options、許可の橋（canUseTool → cc_permissions → カード → PermissionResult）、
// 秘密の場所の拒否、ツールの not_available、ターンの runner の選び方、DB の v40
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
  PROJECT_DOTDOT_DENIED_REASON,
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
  const options = profile.buildOptions({ prompt: "x", context: context() }, { sessionId: () => undefined, signal: new AbortController().signal });
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
    { sessionId: () => undefined, signal: new AbortController().signal },
  );
  assert.equal(bypass.permissionMode, "default");
  assert.ok(logs.some((line) => line.includes("default にしました")));
  // 検証を通らないプロジェクト（無い・symlink・形の違う名前）は投げる
  symlinkSync(join(workspaceDir, "alpha"), join(workspaceDir, "link"));
  for (const projectDir of ["missing", "link", "../alpha", "a/b"]) {
    assert.throws(() => profile.buildOptions({ prompt: "x", context: context({ projectDir }) }, { sessionId: () => undefined, signal: new AbortController().signal }), projectDir);
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

test("createProjectProfile: 要約のターン（purpose close・renew）は書く・動かすツールを外し、モードを default に固定する", (t) => {
  const { home, cfg } = places(t);
  const profile = createProjectProfile({
    cfg,
    createMcpServer: () => mcpServer(),
    canUseTool: () => async () => ({ behavior: "deny", message: "x" }),
    home,
    env: {},
    log: () => undefined,
  });
  for (const purpose of ["close", "renew"] as const) {
    const options = profile.buildOptions(
      { prompt: "x", context: context({ purpose, permissionMode: "acceptEdits" }) },
      { sessionId: () => undefined, signal: new AbortController().signal },
    );
    assert.deepEqual(
      options.disallowedTools,
      ["AskUserQuestion", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "mcp__selfagent__*", "WebSearch", "WebFetch"],
      purpose,
    );
    assert.equal(options.permissionMode, "default", purpose);
    // 自前の MCP・Web のツールは canUseTool を通らずに動くので、要約のターンは allowedTools に入れない（#298）
    assert.deepEqual(options.allowedTools, [], purpose);
  }
  const normal = profile.buildOptions(
    { prompt: "x", context: context({ permissionMode: "acceptEdits" }) },
    { sessionId: () => undefined, signal: new AbortController().signal },
  );
  assert.deepEqual(normal.disallowedTools, ["AskUserQuestion"]);
  assert.deepEqual(normal.allowedTools, ["mcp__selfagent__*", "WebSearch", "WebFetch"]);
  assert.equal(normal.permissionMode, "acceptEdits");
});

test("秘密の場所: ~/.claude（オーナーの認証）と /proc、MultiEdit も拒否する", async (t) => {
  const { projectSecretPlaces } = await import("../src/agent/project-profile.ts");
  const { workspaceDir, home, cfg } = places(t);
  const secrets = projectSecretPlaces(cfg, home);
  const cwd = join(workspaceDir, "alpha");
  assert.equal(touchesSecretPlace("Read", { file_path: "~/.claude/.credentials.json" }, cwd, secrets, home), true);
  assert.equal(touchesSecretPlace("Read", { file_path: "/proc/self/environ" }, cwd, secrets, home), true);
  assert.equal(touchesSecretPlace("MultiEdit", { file_path: join(cfg.dataDir, "x") }, cwd, secrets, home), true);
});

test("秘密の場所: ~/.claude.json と、~ の直下で名前が .claude.json で始まるもの（控え）を拒否する", async (t) => {
  const { projectSecretPlaces } = await import("../src/agent/project-profile.ts");
  const { workspaceDir, home, cfg } = places(t);
  writeFileSync(join(home, ".claude.json"), "{}");
  writeFileSync(join(home, ".claude.json.backup"), "{}");
  const secrets = projectSecretPlaces(cfg, home);
  const cwd = join(workspaceDir, "alpha");
  assert.ok(secrets.includes(join(home, ".claude.json")));
  assert.equal(touchesSecretPlace("Read", { file_path: "~/.claude.json" }, cwd, secrets, home), true);
  assert.equal(touchesSecretPlace("Edit", { file_path: join(home, ".claude.json") }, cwd, secrets, home), true);
  // ホームを探す Grep・Glob は秘密の場所を含むので拒否
  assert.equal(touchesSecretPlace("Grep", { pattern: "x", path: home }, cwd, secrets, home), true);
  // 控え（~/.claude.json.backup など）も秘密の場所。まだ無いものも
  assert.equal(touchesSecretPlace("Read", { file_path: "~/.claude.json.backup" }, cwd, secrets, home), true);
  assert.equal(touchesSecretPlace("Write", { file_path: join(home, ".claude.json.1730000000") }, cwd, secrets, home), true);
  // ~ の直下でないもの・名前が違うものは通す
  writeFileSync(join(cwd, ".claude.json"), "{}");
  assert.equal(touchesSecretPlace("Read", { file_path: ".claude.json" }, cwd, secrets, home), false);
  writeFileSync(join(home, ".claude-json"), "{}");
  assert.equal(touchesSecretPlace("Read", { file_path: "~/.claude-json" }, cwd, secrets, home), false);
});

test("秘密の場所: パスの要素に `..` があれば畳む前に拒否する（プロジェクトの中に戻るものも）", async (t) => {
  const { projectSecretPlaces } = await import("../src/agent/project-profile.ts");
  const { workspaceDir, home, cfg } = places(t);
  const cwd = join(workspaceDir, "alpha");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "a.ts"), "");
  const secrets = projectSecretPlaces(cfg, home);
  for (const [tool, input] of [
    ["Read", { file_path: "src/../a.ts" }],
    ["Read", { file_path: `${cwd}/src/../a.ts` }],
    ["Edit", { file_path: "../alpha/a.ts" }],
    ["Grep", { pattern: "x", path: ".." }],
    ["Glob", { pattern: "*.ts", path: "src/.." }],
    ["NotebookEdit", { notebook_path: "x/../n.ipynb" }],
    // Glob の pattern と Grep の glob は部分文字列 `..` で（file-access.ts と同じ）
    ["Glob", { pattern: "lnk/../gh/*" }],
    ["Glob", { pattern: "{..,x}/*" }],
    ["Grep", { pattern: "x", glob: "../*.json" }],
  ] as const) {
    assert.equal(touchesSecretPlace(tool, input, cwd, secrets, home), true, `${tool} ${JSON.stringify(input)}`);
  }
  // `..` を含むだけの名前（要素そのものではない）は通す
  writeFileSync(join(cwd, "a..b"), "");
  assert.equal(touchesSecretPlace("Read", { file_path: "a..b" }, cwd, secrets, home), false);
  assert.equal(touchesSecretPlace("Read", { file_path: "src/a.ts" }, cwd, secrets, home), false);
  // Grep の pattern（正規表現）の `..` は対象の場所ではないので見ない
  assert.equal(touchesSecretPlace("Grep", { pattern: "a..b", path: "src" }, cwd, secrets, home), false);
  // hook は専用の理由で拒否する
  const logs: string[] = [];
  const guard = createSecretPlaceGuard(secrets, home, (line) => logs.push(line));
  for (const [tool, input] of [
    ["Read", { file_path: "src/../a.ts" }],
    ["Glob", { pattern: "lnk/../gh/*" }],
  ] as const) {
    const output = await guard.hooks[0]!(
      { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd } as unknown as HookInput,
      undefined,
      { signal: new AbortController().signal },
    );
    assert.deepEqual(output, {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PROJECT_DOTDOT_DENIED_REASON },
    });
  }
  assert.ok(logs.every((line) => !line.includes(cwd)));
});

test("projectSecretPlaces: ~/.claude と /proc を含み、hook は MultiEdit も見る", async (t) => {
  const { projectSecretPlaces } = await import("../src/agent/project-profile.ts");
  const { home, cfg } = places(t);
  const secrets = projectSecretPlaces(cfg, home);
  assert.ok(secrets.includes(join(home, ".claude")) && secrets.includes("/proc"));
  const guard = createSecretPlaceGuard(secrets, home, () => undefined);
  assert.ok(guard.matcher?.split("|").includes("MultiEdit"));
});

test("秘密の場所: 共有の link の skills・agents（CONFIG_DIR と ~/.claude）は読め、その中の symlink が秘密を指せば拒否（#291）", async (t) => {
  const { projectSecretPlaces, projectSharedPlaces } = await import("../src/agent/project-profile.ts");
  const { workspaceDir, home, cfg } = places(t);
  const cwd = join(workspaceDir, "alpha");
  // ~/.claude/skills/x/REFERENCE.md と、CONFIG_DIR/skills → ~/.claude/skills の symlink（unify-setup の形）
  mkdirSync(join(home, ".claude/skills/x"), { recursive: true });
  writeFileSync(join(home, ".claude/skills/x/REFERENCE.md"), "ref");
  writeFileSync(join(home, ".claude/.credentials.json"), "{}");
  mkdirSync(cfg.claudeConfigDir, { recursive: true });
  symlinkSync(join(home, ".claude/skills"), join(cfg.claudeConfigDir, "skills"));
  const secrets = projectSecretPlaces(cfg, home);
  const shared = projectSharedPlaces(cfg, home);
  assert.deepEqual(shared, [
    join(cfg.claudeConfigDir, "skills"),
    join(cfg.claudeConfigDir, "agents"),
    join(home, ".claude/skills"),
    join(home, ".claude/agents"),
  ]);
  for (const input of [{ file_path: join(cfg.claudeConfigDir, "skills/x/REFERENCE.md") }, { file_path: "~/.claude/skills/x/REFERENCE.md" }]) {
    assert.equal(touchesSecretPlace("Read", input, cwd, secrets, home), true, "shared を渡さなければ今までどおり拒否");
    assert.equal(touchesSecretPlace("Read", input, cwd, secrets, home, shared), false, JSON.stringify(input));
  }
  assert.equal(touchesSecretPlace("Grep", { pattern: "x", path: join(cfg.claudeConfigDir, "skills") }, cwd, secrets, home, shared), false);
  assert.equal(touchesSecretPlace("Glob", { pattern: "~/.claude/skills/**/*.md" }, cwd, secrets, home, shared), false);
  // skills の中の symlink が秘密を指せば拒否（realpath も共有の場所の中でなければ飛ばさない）
  symlinkSync(join(home, ".claude/.credentials.json"), join(home, ".claude/skills/x/leak"));
  assert.equal(touchesSecretPlace("Read", { file_path: join(cfg.claudeConfigDir, "skills/x/leak") }, cwd, secrets, home, shared), true);
  // 共有の場所の外は今までどおり（`..` で外へ・接頭辞が同じだけ・Glob の pattern で外へ、も）
  assert.equal(touchesSecretPlace("Read", { file_path: "~/.claude/.credentials.json" }, cwd, secrets, home, shared), true);
  assert.equal(touchesSecretPlace("Read", { file_path: join(cfg.claudeConfigDir, "settings.json") }, cwd, secrets, home, shared), true);
  assert.equal(touchesSecretPlace("Grep", { pattern: "x", path: join(home, ".claude") }, cwd, secrets, home, shared), true);
  assert.equal(touchesSecretPlace("Read", { file_path: "~/.claude/skills/../.credentials.json" }, cwd, secrets, home, shared), true);
  mkdirSync(join(home, ".claude/skills-x"), { recursive: true });
  writeFileSync(join(home, ".claude/skills-x/a"), "a");
  assert.equal(touchesSecretPlace("Read", { file_path: "~/.claude/skills-x/a" }, cwd, secrets, home, shared), true);
  assert.equal(touchesSecretPlace("Glob", { path: "~/.claude/skills", pattern: "../*.json" }, cwd, secrets, home, shared), true);
  // ワイルドカードの後ろの `..` も外に出うるので、共有の場所の例外にしない
  assert.equal(touchesSecretPlace("Glob", { path: "~/.claude/skills", pattern: "*/../../.credentials.json" }, cwd, secrets, home, shared), true);
  // 書く側（Write・Edit・MultiEdit・NotebookEdit）は共有の場所でも秘密のまま（skills は全部の Claude Code のセッションが読む指示の置き場）
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    const key = tool === "NotebookEdit" ? "notebook_path" : "file_path";
    assert.equal(touchesSecretPlace(tool, { [key]: join(cfg.claudeConfigDir, "skills/x/REFERENCE.md") }, cwd, secrets, home, shared), true, tool);
  }
  // profile の hook も共有の場所を通す
  const profile = createProjectProfile({
    cfg,
    createMcpServer: () => mcpServer(),
    canUseTool: () => async () => ({ behavior: "deny", message: "x" }),
    home,
    env: {},
    log: () => undefined,
  });
  const guard = profile.toolHooks(() => undefined, { prompt: "x", context: context() }).preToolUse[1]!.hooks[0]!;
  const call = (file_path: string) =>
    guard({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path }, cwd } as unknown as HookInput, undefined, {
      signal: new AbortController().signal,
    });
  assert.deepEqual(await call(join(cfg.claudeConfigDir, "skills/x/REFERENCE.md")), {});
  assert.deepEqual(await call(join(cfg.claudeConfigDir, "skills/x/leak")), {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PROJECT_SECRET_DENIED_REASON },
  });
});

test("秘密の場所: 共有の場所そのものが symlink でもその先には広げない。~/.claude 自体が symlink なら skills は読める（#291）", async (t) => {
  const { projectSecretPlaces, projectSharedPlaces } = await import("../src/agent/project-profile.ts");
  const { root, workspaceDir, home, cfg } = places(t);
  const cwd = join(workspaceDir, "alpha");
  const secrets = projectSecretPlaces(cfg, home);
  const shared = projectSharedPlaces(cfg, home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/.credentials.json"), "{}");
  writeFileSync(join(home, ".ssh/id_ed25519"), "key");
  // ~/.claude/agents → ~/.ssh、CONFIG_DIR/skills → ~/.claude（誤設定）のどちらも、その先は読めない
  symlinkSync(join(home, ".ssh"), join(home, ".claude/agents"));
  mkdirSync(cfg.claudeConfigDir, { recursive: true });
  symlinkSync(join(home, ".claude"), join(cfg.claudeConfigDir, "skills"));
  assert.equal(touchesSecretPlace("Read", { file_path: "~/.ssh/id_ed25519" }, cwd, secrets, home, shared), true);
  assert.equal(touchesSecretPlace("Read", { file_path: "~/.claude/agents/id_ed25519" }, cwd, secrets, home, shared), true);
  assert.equal(touchesSecretPlace("Grep", { pattern: "x", path: "~/.claude/agents" }, cwd, secrets, home, shared), true);
  assert.equal(touchesSecretPlace("Read", { file_path: join(cfg.claudeConfigDir, "skills/.credentials.json") }, cwd, secrets, home, shared), true);
  assert.equal(touchesSecretPlace("Read", { file_path: "~/.claude/.credentials.json" }, cwd, secrets, home, shared), true);
  // ~/.claude 自体が別の場所への symlink（ホームを別のディスクに置いた形）でも、その中の skills は読める
  const realHome = join(root, "disk/claude");
  mkdirSync(join(realHome, "skills/y"), { recursive: true });
  writeFileSync(join(realHome, "skills/y/REFERENCE.md"), "ref");
  const home2 = join(root, "home2");
  mkdirSync(home2, { recursive: true });
  symlinkSync(realHome, join(home2, ".claude"));
  const secrets2 = projectSecretPlaces(cfg, home2);
  const shared2 = projectSharedPlaces(cfg, home2);
  assert.equal(touchesSecretPlace("Read", { file_path: join(home2, ".claude/skills/y/REFERENCE.md") }, cwd, secrets2, home2, shared2), false);
  assert.equal(touchesSecretPlace("Read", { file_path: join(realHome, "skills/y/REFERENCE.md") }, cwd, secrets2, home2, shared2), false);
});

test("bridgeSummary: 要約は tool_input から作ったものを常に出し、title は前の 1 行に添える", async () => {
  const { bridgeSummary } = await import("../src/agent/permission-bridge.ts");
  assert.equal(bridgeSummary("npm test", undefined), "npm test");
  assert.equal(bridgeSummary("npm test", "Claude wants to\nrun npm test"), "Claude wants to run npm test\nnpm test");
  assert.equal(bridgeSummary("npm test", "x".repeat(300)), `${"x".repeat(200)}\nnpm test`);
});

test("許可の橋: run の signal が鳴れば保留をやめて拒否し、待っている間に鳴っていれば行を作らない", async (t) => {
  const { workspaceDir, home } = places(t);
  const db = tempDb(t);
  const now = () => new Date(BASE);
  const permissions = new CcPermissionStore(db, now);
  const { timers } = fakeTimers();
  const hold = new CcPermissionHold({ cfg: { ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 }, store: permissions, known: () => false, now, timers, log: () => undefined });
  const poster = { post: async () => undefined, resolved: async () => undefined };
  const bridge = createPermissionBridge({ permissions, hold, poster, holdSec: 300, workspaceDir, home, log: () => undefined });
  const run = new AbortController();
  const canUse = bridge(context(), () => SESSION, { signal: run.signal });
  // canUseTool の signal は鳴らない（SDK が鳴らさない場合）
  const asking = canUse("Bash", { command: "ls" }, { signal: new AbortController().signal } as never);
  await until(() => permissions.countPending() === 1, "保留");
  run.abort();
  const result = await asking;
  assert.equal(result?.behavior, "deny");
  assert.equal(permissions.countPending(), 0);
  const rows = Number(db.prepare("SELECT COUNT(*) AS n FROM cc_permissions").get()?.n);
  // 既に止まった run の要求は行を作らない
  const after = await canUse("Bash", { command: "ls" }, { signal: new AbortController().signal } as never);
  assert.equal(after?.behavior, "deny");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM cc_permissions").get()?.n), rows);
});

test("許可の橋: 同じセッションの要求は順に（前が終わるまで次の行を作らない）、別のセッションは待たない", async (t) => {
  const { workspaceDir, home } = places(t);
  const db = tempDb(t);
  const now = () => new Date(BASE);
  const permissions = new CcPermissionStore(db, now);
  const { timers } = fakeTimers();
  const hold = new CcPermissionHold({ cfg: { ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 }, store: permissions, known: () => false, now, timers, log: () => undefined });
  const poster = { post: async () => undefined, resolved: async () => undefined };
  const bridge = createPermissionBridge({ permissions, hold, poster, holdSec: 300, workspaceDir, home, log: () => undefined });
  const run = new AbortController();
  t.after(() => run.abort());
  const OTHER = "44444444-4444-4444-8444-444444444444";
  const canUse = bridge(context(), () => SESSION, { signal: run.signal });
  const canUseOther = bridge(context({ channelId: "channel-2" }), () => OTHER, { signal: run.signal });
  const signal = () => ({ signal: new AbortController().signal }) as never;
  const rows = () => db.prepare("SELECT id, session_id AS sessionId, tool_name AS toolName, state FROM cc_permissions ORDER BY id").all() as Array<{
    id: number;
    sessionId: string;
    toolName: string;
    state: string;
  }>;
  const first = canUse("Bash", { command: "ls" }, signal());
  const second = canUse("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, signal());
  await until(() => permissions.countPending() === 1, "1 件目の保留");
  // 少し待っても 2 件目の行はできない
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(rows().map((row) => row.toolName), ["Bash"]);
  // 別のセッションは前の要求を待たずに保留する
  const other = canUseOther("Bash", { command: "pwd" }, signal());
  await until(() => rows().length === 2, "別のセッションの保留");
  assert.equal(rows()[1]!.sessionId, OTHER);
  const firstRow = permissions.get(rows()[0]!.id)!;
  assert.deepEqual(hold.answer(firstRow.id, "allow", "web", firstRow.requestHash), { ok: true, state: "allowed" });
  assert.deepEqual(await first, { behavior: "allow" });
  // 前が終わってから 2 件目の行ができる
  await until(() => rows().length === 3, "2 件目の保留");
  const secondRow = permissions.get(rows()[2]!.id)!;
  assert.equal(secondRow.sessionId, SESSION);
  assert.equal(secondRow.toolName, "Edit");
  assert.deepEqual(hold.answer(secondRow.id, "deny", "web", secondRow.requestHash), { ok: true, state: "denied" });
  assert.deepEqual(await second, { behavior: "deny", message: PROJECT_PERMISSION_DENY_MESSAGE });
  const otherRow = permissions.get(rows()[1]!.id)!;
  assert.deepEqual(hold.answer(otherRow.id, "allow", "web", otherRow.requestHash), { ok: true, state: "allowed" });
  assert.deepEqual(await other, { behavior: "allow" });
});

test("resolvedMessageByOrigin: cc:perm の書き換えは origin sdk ならプロジェクトのセッションの文、それ以外は Claude Code のチャンネルの文", async () => {
  const { resolvedMessageByOrigin } = await import("../src/agent/permission-bridge.ts");
  const message = (text: string) => ({ message: { text }, channelId: "c", messageId: "m" });
  const pick = resolvedMessageByOrigin({
    permissions: { get: (id) => (id === 3 ? undefined : ({ origin: id === 1 ? "sdk" : "hook" } as never)) },
    sdk: () => message("sdk"),
    hook: () => message("hook"),
  });
  assert.equal(pick(1)?.message.text, "sdk");
  assert.equal(pick(2)?.message.text, "hook");
  assert.equal(pick(3)?.message.text, "hook");
});

test("/api/cc/permissions/<id>/allow で sdk の行に答えると canUseTool は allow。/api/cc/permissions と pendingPermissions は hook の行だけ", async (t) => {
  const { ccRoutes, ccStatus } = await import("../src/web/routes/cc.ts");
  const s = setupBridge(t);
  await until(() => s.gateway.posts.length === 1, "カード");
  const row = s.permissions.listPending()[0]!;
  const routes = ccRoutes({
    registry: { snapshot: () => ({ sessions: [], stale: false, unreadable: false, fetchedAt: undefined }) as never, touch: () => undefined },
    panes: undefined,
    tmux: undefined,
    workspaceDir: s.workspaceDir,
    home: "/h",
    permissions: { hold: s.hold, store: s.permissions, holdSec: 300, questionHoldSec: 900 },
  });
  const list = routes.find((route) => route.method === "GET" && route.pattern.source === "^\\/api\\/cc\\/permissions$")!;
  assert.deepEqual((await list.handle({ params: [], query: new URLSearchParams() } as never)).json, { permissions: [] });
  const status = ccStatus({
    panes: { lastTmux: () => undefined },
    hookListening: () => true,
    store: { multilineOk: () => true },
    permissions: s.permissions,
  } as never);
  assert.equal(status.pendingPermissions, 0);
  assert.equal(s.permissions.countPending(), 1);
  const answer = routes.find((route) => route.method === "POST" && route.pattern.source.includes("allow|always|deny"))!;
  const reply = await answer.handle({ params: [String(row.id), "allow"], body: { requestHash: row.requestHash } } as never);
  assert.deepEqual(reply, { status: 200, json: { state: "allowed" } });
  const result = await s.run;
  assert.ok(result.ok);
  assert.deepEqual(s.results, [{ behavior: "allow" }]);
});
