// プロジェクトのセッション（docs/plan/unify.md §6.1 の 6〜8・§6.2。U1b）: 許可を待つ間の打ち切りの一時停止と途中経過、作る口（/new project:・
// POST /api/sessions の projectDir・GET /api/projects/workspace）、unify-setup と共有の link の確認
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createPermissionBridge, createPermissionPoster } from "../src/agent/permission-bridge.ts";
import { createProjectProfile } from "../src/agent/project-profile.ts";
import type { PermissionWaiting, RunContext } from "../src/agent/runner.ts";
import { type QueryFn, SdkAgentRunner, startTurnTimeout } from "../src/agent/sdk-runner.ts";
import {
  createNewSessionCommand,
  newCommandDef,
  PROJECT_INVALID_REPLY,
  PROJECT_NOT_SET_UP_REPLY,
  PROJECT_OPTION,
  PROJECT_PERSONA_REPLY,
} from "../src/app/commands/new.ts";
import { sessionLine, sessionListText } from "../src/app/commands/sessions.ts";
import { welcomeText } from "../src/app/session-ops.ts";
import { ensureGuildLayout } from "../src/app/commands/setup.ts";
import { progressText } from "../src/app/progress.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { checkSharedLinks, unifySetupLines } from "../src/agent/unify-setup-check.ts";
import { main as unifySetupMain } from "../src/cli/unify-setup.ts";
import { CcPermissionHold } from "../src/cc/permission-hold.ts";
import type { CcTimers } from "../src/cc/registry.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";

const BASE = Date.parse("2026-11-06T00:00:00.000Z");
const GUILD = "guild-1";
const CHANNEL = "channel-1";
const SESSION = "33333333-3333-4333-8333-333333333333";

/** mock.timers は setImmediate を止めないので、それで microtask と I/O を流す */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}

function places(t: TestContext) {
  const root = realpathSync(tempDir(t));
  const workspaceDir = join(root, "workspace");
  mkdirSync(join(workspaceDir, "alpha"), { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const cfg = {
    model: "claude-opus-5",
    effort: undefined,
    workDir: join(root, "work"),
    dataDir: join(root, "data"),
    claudeConfigDir: join(root, "claude"),
    workspaceDir,
    sessionMaxTurns: 40,
  };
  return { workspaceDir, home, cfg };
}

/** 保留の時間切れは手で起こす（ここでは起こさない） */
const NEVER: CcTimers = { after: () => () => undefined };

const CONTEXT: RunContext = { guildId: GUILD, channelId: CHANNEL, kind: "session", projectDir: "alpha", permissionMode: "default" };

/**
 * 許可の橋つきの runner と、gate を開けると canUseTool を呼び、答えの後は打ち切り（abortController）まで待つ偽の query
 */
function setupTimeout(t: TestContext) {
  const { workspaceDir, home, cfg } = places(t);
  const db = tempDb(t);
  const now = () => new Date();
  const stores = createStores(db, now);
  stores.topicSessions.create({ channelId: CHANNEL, guildId: GUILD, title: "作業", categoryId: "cat-1" });
  stores.topicSessions.setProject(CHANNEL, "alpha", "default");
  const permissions = new CcPermissionStore(db, now);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const hold = new CcPermissionHold({
    cfg: { ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 },
    store: permissions,
    known: () => false,
    now,
    timers: NEVER,
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
    log,
  });
  const bridge = createPermissionBridge({ permissions, hold, poster, holdSec: 300, workspaceDir, home, log });
  const results: PermissionResult[] = [];
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const sdkSignal = new AbortController();
  const queryFn: QueryFn = (call) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: SESSION } as unknown as SDKMessage;
      await gate;
      const result = await call.options.canUseTool!("Bash", { command: "npm run check", description: "check" }, {
        signal: sdkSignal.signal,
        displayName: "Run command",
      } as never);
      if (result !== null) results.push(result);
      // 答えの後は打ち切り・中断まで返さない
      const aborted = call.options.abortController!.signal;
      if (!aborted.aborted) await new Promise((resolve) => aborted.addEventListener("abort", resolve, { once: true }));
    })();
  const runner = new SdkAgentRunner(
    { ...cfg, turnTimeoutSec: 300, sessionTurnTimeoutSec: 900 },
    undefined,
    undefined,
    log,
    queryFn,
    undefined,
    createProjectProfile({
      cfg,
      createMcpServer: () => createSdkMcpServer({ name: "selfagent", version: "0.1.0", tools: [] }),
      canUseTool: bridge,
      home,
      env: {},
      log,
    }),
  );
  return { runner, permissions, hold, results, openGate, gateway };
}

test("打ち切りの一時停止: 許可を待つ間は 900 秒を超えても止めず、答えた後に残りの時間を数える。待っている間は onPermissionWaiting に出す", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE });
  const s = setupTimeout(t);
  const waits: Array<PermissionWaiting | undefined> = [];
  let settled = false;
  const run = s.runner
    .run({ prompt: "npm run check を実行して", context: CONTEXT, onPermissionWaiting: (waiting) => waits.push(waiting) })
    .then((result) => {
      settled = true;
      return result;
    });
  await flush();
  // 100 秒動いてから許可を求める
  t.mock.timers.tick(100_000);
  s.openGate();
  await flush();
  const row = s.permissions.listPending()[0]!;
  assert.equal(row.origin, "sdk");
  assert.deepEqual(waits, [{ toolName: "Bash", displayName: "Run command", since: new Date(BASE + 100_000) }]);
  // 待っている間は 900 秒を超えても打ち切らない
  t.mock.timers.tick(2_000_000);
  await flush();
  assert.equal(settled, false);
  assert.equal(s.permissions.get(row.id)?.state, "pending");
  assert.deepEqual(s.hold.answer(row.id, "allow", "web", row.requestHash), { ok: true, state: "allowed" });
  await flush();
  assert.deepEqual(s.results, [{ behavior: "allow" }]);
  assert.equal(waits.at(-1), undefined);
  // 残りは 800 秒
  t.mock.timers.tick(799_000);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(settled, true);
  const result = await run;
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.errorMessage : "", "timeout");
});

test("打ち切りの一時停止: [中断]（input.signal）は保留中の要求を先に released（abort）にして拒否し、ターンは aborted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE });
  const s = setupTimeout(t);
  const controller = new AbortController();
  const run = s.runner.run({ prompt: "x", context: CONTEXT, signal: controller.signal });
  await flush();
  s.openGate();
  await flush();
  const row = s.permissions.listPending()[0]!;
  // 中断の時点で行は先に閉じている（query を止めるより前）
  controller.abort();
  assert.equal(s.permissions.get(row.id)?.state, "released");
  assert.equal(s.permissions.get(row.id)?.via, "abort");
  await flush();
  const result = await run;
  assert.equal(result.ok === false ? result.errorMessage : "", "aborted");
  assert.equal(s.results[0]?.behavior, "deny");
  // チャンネルの許可の 1 通は「ターンが止まったため拒否しました」に書き換わる
  assert.ok(s.gateway.edits.some((edit) => edit.message.text.includes("ターンが止まったため拒否しました")), JSON.stringify(s.gateway.edits));
});

test("startTurnTimeout: pause を重ねたら数え、すべて resume してから残りを数える。clear の後は呼ばない", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE });
  let fired = 0;
  const timer = startTurnTimeout(1_000, () => fired++);
  t.mock.timers.tick(400);
  timer.pause();
  timer.pause();
  t.mock.timers.tick(5_000);
  timer.resume();
  t.mock.timers.tick(5_000);
  assert.equal(fired, 0);
  timer.resume();
  t.mock.timers.tick(599);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
  const cleared = startTurnTimeout(1_000, () => fired++);
  cleared.clear();
  cleared.resume();
  t.mock.timers.tick(2_000);
  assert.equal(fired, 1);
});

test("途中経過: 許可を待っている間は「許可を待っています: <displayName か toolName>」を最後の行に足す（引数・パスは出さない）", () => {
  assert.equal(
    progressText(65_000, 2, "コマンドを実行しています", { toolName: "Bash", displayName: "Run command" }),
    "作業中…（1 分 5 秒・ツール 2 回）\nコマンドを実行しています\n許可を待っています: Run command",
  );
  assert.equal(progressText(0, 0, undefined, { toolName: "Bash" }), "作業中…（0 分 0 秒・ツール 0 回）\n許可を待っています: Bash");
  assert.equal(progressText(0, 0, undefined), "作業中…（0 分 0 秒・ツール 0 回）");
});

// ---- 作る口（/new project:）----

/** /setup 済みのサーバーと /new。ワークスペースに alpha（使える）と、使えない symlink を置く */
async function setupNew(t: TestContext, options: { ready?: boolean; gate?: boolean; personas?: boolean; extraProjects?: number } = {}) {
  const { workspaceDir } = places(t);
  symlinkSync(join(workspaceDir, "alpha"), join(workspaceDir, "linked"));
  for (let i = 0; i < (options.extraProjects ?? 0); i++) mkdirSync(join(workspaceDir, `p${String(i).padStart(2, "0")}`));
  const db = tempDb(t);
  const gateway = new FakeGateway({
    allow: ["getParentId", "sendMessage", "pinMessage", "messageExists"],
    record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn", "moveChannel", "send"],
  });
  const { guildSettings, topicSessions } = createStores(db, () => new Date(BASE));
  const logs: string[] = [];
  const ready = { value: options.ready ?? true };
  const deps = {
    gateway,
    guildSettings,
    topicSessions,
    queue: new KeyedSerialQueue(1),
    channelOps: { enqueueMove: () => assert.fail("想定外の移動") },
    ...(options.personas === true
      ? {
          cfg: {
            personas: [
              {
                id: "mika",
                name: "ミカ",
                discordTokenEnv: "SELF_AGENT_PERSONA_MIKA_DISCORD_TOKEN",
                promptFile: "/dev/null",
                model: undefined,
                engine: "claude" as const,
                effort: undefined,
              },
            ],
          },
        }
      : {}),
    ...(options.gate === false ? {} : { projectSessions: { places: { workspaceDir, protectedDirs: [] }, ready: () => ready.value } }),
    log: (line: string) => logs.push(line),
  };
  const result = await ensureGuildLayout(GUILD, deps);
  assert.equal(result.failure, null);
  gateway.reset();
  const command = createNewSessionCommand(deps);
  const runNew = async (options: Record<string, string>): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await command.handle({ guildId: GUILD, channelId: "c", userId: "owner-1", createdAt: new Date(BASE), kind: "command", name: "new", options }, responder);
    return responder.calls;
  };
  return { gateway, topicSessions, logs, command, runNew, ready, db };
}

test("/new project:alpha: project_dir と permission_mode default を書き、topic に（alpha）、最初の投稿にプロジェクトの 1 行", async (t) => {
  const s = await setupNew(t);
  const calls = await s.runNew({ title: "作業", project: "alpha" });
  const created = s.gateway.calls.find((call) => call.method === "createTextChannel") as { options: { topic: string; name: string } } | undefined;
  assert.equal(created?.options.topic, "作業（alpha）");
  assert.equal(created?.options.name, "作業");
  const channelId = (calls.at(-1) as { message: { text: string } }).message.text.match(/<#(.+)>/)?.[1] ?? "";
  assert.deepEqual(s.topicSessions.projectDirOf(channelId), { projectDir: "alpha", permissionMode: "default" });
  const sent = s.gateway.calls.find((call) => call.method === "send") as { text: string } | undefined;
  assert.equal(
    sent?.text,
    "セッション「作業」を始めました。ここで話しかけてください。\nプロジェクト: alpha。このチャンネルの発言は Claude Code と同じ装備（CLAUDE.md・skills・Bash）で動き、許可はここのボタンか Web で答えます",
  );
  assert.deepEqual(calls[0], { method: "defer", ephemeral: true });
  assert.ok(s.logs.every((line) => !line.includes("alpha")));
  // project が無ければ今までどおり（軽いモード）
  const light = await s.runNew({ title: "雑談" });
  const lightId = (light.at(-1) as { message: { text: string } }).message.text.match(/<#(.+)>/)?.[1] ?? "";
  assert.equal(s.topicSessions.projectDirOf(lightId), undefined);
});

test("/new project: 使えない名前・人格と同時・共有の link が済んでいない・連携が無効は本人にだけ断り、作らない", async (t) => {
  const s = await setupNew(t, { personas: true });
  const refused = async (options: Record<string, string>, text: string) => {
    assert.deepEqual(await s.runNew(options), [{ method: "reply", message: { text, ephemeral: true } }], JSON.stringify(options));
  };
  await refused({ title: "a", project: "linked" }, PROJECT_INVALID_REPLY);
  await refused({ title: "a", project: "nothing" }, PROJECT_INVALID_REPLY);
  await refused({ title: "a", project: "../alpha" }, PROJECT_INVALID_REPLY);
  await refused({ title: "a", project: "alpha", persona: "mika" }, PROJECT_PERSONA_REPLY);
  s.ready.value = false;
  await refused({ title: "a", project: "alpha" }, PROJECT_NOT_SET_UP_REPLY);
  assert.equal(s.gateway.calls.filter((call) => call.method === "createTextChannel").length, 0);
  // 連携が無効（gate なし）は引数が無いので、古い選択肢で来ても使えないとして断る
  const off = await setupNew(t, { gate: false });
  assert.deepEqual(await off.runNew({ title: "a", project: "alpha" }), [{ method: "reply", message: { text: PROJECT_INVALID_REPLY, ephemeral: true } }]);
});

test("/new のコマンド定義: project は SELF_AGENT_CC=1 で直下に使えるものがあるときだけ。25 件までは選択肢、超えれば文字列", async (t) => {
  const withGate = await setupNew(t);
  const option = withGate.command.def.options?.find((o) => o.name === PROJECT_OPTION);
  assert.deepEqual(option?.choices, [{ name: "alpha", value: "alpha" }]);
  assert.equal(option?.required, undefined);
  const off = await setupNew(t, { gate: false });
  assert.equal(off.command.def.options?.some((o) => o.name === PROJECT_OPTION), false);
  assert.equal(newCommandDef([], []).options?.some((o) => o.name === PROJECT_OPTION), false);
  const many = await setupNew(t, { extraProjects: 25 });
  const manyOption = many.command.def.options?.find((o) => o.name === PROJECT_OPTION);
  assert.equal(manyOption?.choices, undefined);
  assert.equal(manyOption?.type, "string");
  // 文字列で受けても検証する
  assert.deepEqual(await many.runNew({ title: "a", project: "linked" }), [
    { method: "reply", message: { text: PROJECT_INVALID_REPLY, ephemeral: true } },
  ]);
});

test("/sessions の一覧: プロジェクトのセッションの行にプロジェクトの名前を添える", async (t) => {
  const s = await setupNew(t);
  await s.runNew({ title: "作業", project: "alpha" });
  const text = sessionListText(s.topicSessions, GUILD, ["active"], new Date(BASE));
  assert.match(text, /作業（プロジェクト alpha・最終 1 時間以内）/);
  // 名前の `_` は斜体にならないよう無効にする
  assert.ok(welcomeText("作業", "my_app").includes("プロジェクト: my\\_app。"));
  assert.match(sessionLine({ ...s.topicSessions.listByState(GUILD, "active", 1)[0]! }, new Date(BASE), undefined, "my_app"), /プロジェクト my\\_app・/);
});

// ---- unify-setup ----

test("checkSharedLinks・unify-setup --print: 無い（ln -s の行）・済・symlink でない・向きが違う・~/.claude に無い", async (t) => {
  const root = realpathSync(tempDir(t));
  const home = join(root, "home");
  const configDir = join(root, "claude-config");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  // CONFIG_DIR が無い → mkdir -p と ln -s 2 行
  assert.deepEqual(checkSharedLinks(configDir, home).links.map((link) => link.state), ["missing", "missing"]);
  assert.deepEqual(unifySetupLines(configDir, home), [
    `mkdir -p '${configDir}'`,
    `ln -s '${join(home, ".claude", "skills")}' '${join(configDir, "skills")}'`,
    `ln -s '${join(home, ".claude", "agents")}' '${join(configDir, "agents")}'`,
  ]);
  mkdirSync(configDir);
  symlinkSync(join(home, ".claude", "skills"), join(configDir, "skills"));
  mkdirSync(join(configDir, "agents"));
  let check = checkSharedLinks(configDir, home);
  assert.equal(check.ok, false);
  assert.deepEqual(check.links.map((link) => link.state), ["ok", "not_symlink"]);
  assert.deepEqual(unifySetupLines(configDir, home), ["# skills: 済", "# agents が symlink ではありません。退けてから作ってください"]);
  rmSync(join(configDir, "agents"), { recursive: true });
  symlinkSync(join(home, ".claude", "skills"), join(configDir, "agents"));
  assert.deepEqual(checkSharedLinks(configDir, home).links.map((link) => link.state), ["ok", "wrong_target"]);
  rmSync(join(configDir, "agents"));
  symlinkSync(join(home, ".claude", "agents"), join(configDir, "agents"));
  check = checkSharedLinks(configDir, home);
  assert.equal(check.ok, true);
  assert.deepEqual(unifySetupLines(configDir, home), ["# skills: 済", "# agents: 済"]);
  // ~/.claude の側が無い（起動時の確認は未了のまま）。link が symlink で残っていれば、mkdir の後にもう一度実行する案内
  rmSync(join(home, ".claude", "agents"), { recursive: true });
  check = checkSharedLinks(configDir, home);
  assert.equal(check.ok, false);
  assert.deepEqual(check.links.map((link) => link.state), ["ok", "no_source"]);
  assert.deepEqual(unifySetupLines(configDir, home), [
    "# skills: 済",
    `mkdir -p '${join(home, ".claude", "agents")}'`,
    "# agents: ~/.claude/agents を作った後に、もう一度実行してください",
  ]);
  // link も無ければ、~/.claude/<名前> の mkdir -p の後に ln -s を続ける
  rmSync(join(configDir, "agents"));
  assert.deepEqual(unifySetupLines(configDir, home), [
    "# skills: 済",
    `mkdir -p '${join(home, ".claude", "agents")}'`,
    `ln -s '${join(home, ".claude", "agents")}' '${join(configDir, "agents")}'`,
  ]);
  // CONFIG_DIR も無ければ、それも先に作る
  const fresh = join(root, "fresh-config");
  assert.deepEqual(unifySetupLines(fresh, home), [
    `mkdir -p '${fresh}'`,
    `ln -s '${join(home, ".claude", "skills")}' '${join(fresh, "skills")}'`,
    `mkdir -p '${join(home, ".claude", "agents")}'`,
    `ln -s '${join(home, ".claude", "agents")}' '${join(fresh, "agents")}'`,
  ]);
});

test("unify-setup: --print が無ければ使い方で 2、あれば行を標準出力に出して 0（ファイルは書かない）", async (t) => {
  const root = realpathSync(tempDir(t));
  const home = join(root, "home");
  const configDir = join(root, "cfg");
  const out: string[] = [];
  const err: string[] = [];
  t.mock.method(console, "log", (text: string) => out.push(text));
  t.mock.method(console, "error", (text: string) => err.push(text));
  assert.equal(await unifySetupMain([], { HOME: home, CLAUDE_CONFIG_DIR: configDir }), 2);
  assert.equal(await unifySetupMain(["--print", "x"], { HOME: home, CLAUDE_CONFIG_DIR: configDir }), 2);
  assert.equal(out.length, 0);
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(home, ".claude", "agents"), { recursive: true });
  assert.equal(await unifySetupMain(["--print"], { HOME: home, CLAUDE_CONFIG_DIR: configDir }), 0);
  assert.deepEqual(out, [unifySetupLines(configDir, home).join("\n")]);
  assert.match(out[0]!, /^mkdir -p /);
  assert.equal(existsSync(configDir), false);
});
