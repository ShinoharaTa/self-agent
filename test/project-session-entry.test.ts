// プロジェクトのセッション（docs/plan/unify.md §6.1 の 6〜8・§6.2。U1b）: 許可を待つ間の打ち切りの一時停止と途中経過、作る口（/new project:・
// POST /api/sessions の projectDir・GET /api/projects/workspace）、unify-setup と共有の link の確認
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createPermissionBridge, createPermissionPoster } from "../src/agent/permission-bridge.ts";
import { createProjectProfile } from "../src/agent/project-profile.ts";
import type { PermissionWaiting, RunContext } from "../src/agent/runner.ts";
import { type QueryFn, SdkAgentRunner, startTurnTimeout } from "../src/agent/sdk-runner.ts";
import { progressText } from "../src/app/progress.ts";
import { CcPermissionHold } from "../src/cc/permission-hold.ts";
import type { CcTimers } from "../src/cc/registry.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";

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
