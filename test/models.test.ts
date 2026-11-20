// 話題のモデル（docs/plan/models.md の PR-1。#451）: 一覧・v47・ストア・実行の配線。入口はまだ無い
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSdkMcpServer, type CanUseTool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { labelOf, MODEL_CHOICES, modelKeys, resolveModelKey } from "../src/agent/models.ts";
import { createProjectProfile } from "../src/agent/project-profile.ts";
import { buildQueryOptions } from "../src/agent/query-options.ts";
import type { RunContext, RunResult } from "../src/agent/runner.ts";
import { type QueryFn, SdkAgentRunner } from "../src/agent/sdk-runner.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { renewSession } from "../src/app/session-renew.ts";
import { runChannelTurn } from "../src/app/turn.ts";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { PlaceSettingStore } from "../src/store/place-settings.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeRunner } from "./helpers/runner.ts";

const NOW = new Date("2026-11-20T00:00:00.000Z");
const GUILD = "guild-1";
const CHANNEL = "channel-1";

test("models: 一覧は opus・sonnet・haiku の順で、完全な ID を持つ", () => {
  assert.deepEqual(MODEL_CHOICES, [
    { key: "opus", label: "Opus 5.5", model: "claude-opus-5-5" },
    { key: "sonnet", label: "Sonnet 5.5", model: "claude-sonnet-5-5" },
    { key: "haiku", label: "Haiku 4.5", model: "claude-haiku-4-5" },
  ]);
  assert.deepEqual(modelKeys(), ["opus", "sonnet", "haiku"]);
});

test("resolveModelKey: 前後の空白を除き大文字小文字を区別せずに key で引く。完全な ID・知らない名前・空は undefined", () => {
  assert.equal(resolveModelKey("sonnet")?.model, "claude-sonnet-5-5");
  assert.equal(resolveModelKey("  Haiku ")?.model, "claude-haiku-4-5");
  assert.equal(resolveModelKey("OPUS")?.model, "claude-opus-5-5");
  for (const name of ["claude-sonnet-5-5", "fable", "", "  ", "son net"]) assert.equal(resolveModelKey(name), undefined, name);
});

test("labelOf: 完全な ID は一覧の字、一覧に無ければ ID のまま", () => {
  assert.equal(labelOf("claude-opus-5-5"), "Opus 5.5");
  assert.equal(labelOf("claude-haiku-4-5"), "Haiku 4.5");
  assert.equal(labelOf("claude-opus-5"), "claude-opus-5");
  // key では引かない
  assert.equal(labelOf("sonnet"), "sonnet");
});

test("openDb: v46 の DB を v47 に上げると sessions・usage_log に model（今ある行は NULL）と place_settings ができる。ほかの表の定義は変えない", (t) => {
  assert.ok(MIGRATIONS.length >= 47);
  const path = join(tempDir(t), "self-agent.db");
  // v47（モデル）の 1 つ前の版。後の移行を足しても変えない
  const before = 46;
  const old = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
  old.exec(`PRAGMA user_version = ${before}`);
  old
    .prepare(
      "INSERT INTO sessions (channel_id, guild_id, title, state, category_id, created_at, last_activity_at) VALUES ('s-1', 'g', 't', 'active', 'c', 'a', 'a')",
    )
    .run();
  old.prepare("INSERT INTO usage_log (at, key, ok) VALUES ('a', 'k', 1)").run();
  const others = "SELECT name, sql FROM sqlite_master WHERE tbl_name NOT IN ('sessions', 'usage_log', 'place_settings') ORDER BY name";
  const defsBefore = old.prepare(others).all().map((row) => ({ ...row }));
  old.close();

  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.equal(db.prepare("SELECT model FROM sessions WHERE channel_id = 's-1'").get()?.model, null);
  assert.equal(db.prepare("SELECT model FROM usage_log").get()?.model, null);
  const columns = db.prepare("PRAGMA table_info(place_settings)").all().map((column) => String(column.name));
  assert.deepEqual(columns, ["place", "label", "model", "updated_at"]);
  assert.deepEqual(db.prepare(others).all().map((row) => ({ ...row })), defsBefore);
  const stores = createStores(db, () => NOW);
  assert.equal(stores.topicSessions.modelOf("s-1"), undefined);
  assert.equal(stores.usage.recent(1)[0]?.model, null);
});

test("TopicSessionStore: create の model（省略は NULL）・modelOf・setModel（null で戻す。行が無ければ false）", (t) => {
  const { topicSessions } = createStores(tempDb(t), () => NOW);
  topicSessions.create({ channelId: "a", guildId: GUILD, title: "a", categoryId: "c" });
  topicSessions.create({ channelId: "b", guildId: GUILD, title: "b", categoryId: "c", model: "claude-sonnet-5-5" });
  assert.equal(topicSessions.modelOf("a"), undefined);
  assert.equal(topicSessions.modelOf("b"), "claude-sonnet-5-5");
  assert.equal(topicSessions.modelOf("missing"), undefined);
  assert.equal(topicSessions.setModel("a", "claude-haiku-4-5"), true);
  assert.equal(topicSessions.modelOf("a"), "claude-haiku-4-5");
  assert.equal(topicSessions.setModel("b", null), true);
  assert.equal(topicSessions.modelOf("b"), undefined);
  assert.equal(topicSessions.setModel("missing", "claude-haiku-4-5"), false);
  // 削除済みの行も返す
  topicSessions.markDeleted("a");
  assert.equal(topicSessions.modelOf("a"), "claude-haiku-4-5");
});

test("PlaceSettingStore: get（無ければ undefined）・set（足す・置き換える・null は無し・時刻は今）・list（place の順）", (t) => {
  let now = NOW;
  const store = new PlaceSettingStore(tempDb(t), () => now);
  assert.equal(store.get("general"), undefined);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.set("p:alpha", { label: "設計", model: "opus" }), {
    place: "p:alpha",
    label: "設計",
    model: "opus",
    updatedAt: NOW.toISOString(),
  });
  store.set("general", { label: null, model: "sonnet" });
  now = new Date("2026-11-21T00:00:00.000Z");
  assert.deepEqual(store.set("p:alpha", { label: null, model: null }), {
    place: "p:alpha",
    label: null,
    model: null,
    updatedAt: now.toISOString(),
  });
  assert.deepEqual(store.get("general"), { place: "general", label: null, model: "sonnet", updatedAt: NOW.toISOString() });
  assert.deepEqual(
    store.list().map((setting) => setting.place),
    ["general", "p:alpha"],
  );
});

function ok(sessionId: string): RunResult {
  return {
    ok: true,
    text: "x",
    sessionId,
    usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0, steps: [] },
    durationMs: 1,
    toolCalls: 0,
    contextTokens: 0,
  };
}

test("runChannelTurn: セッションのチャンネルは話題のモデルを context に入れる（軽いモードもプロジェクトのセッションも）。#inbox・#tasks・予約した依頼・NULL は入れない", async (t) => {
  const stores = createStores(tempDb(t), () => NOW);
  stores.topicSessions.create({ channelId: CHANNEL, guildId: GUILD, title: "軽い", categoryId: "c", model: "claude-sonnet-5-5" });
  stores.topicSessions.create({ channelId: "plain", guildId: GUILD, title: "既定", categoryId: "c" });
  stores.topicSessions.create({ channelId: "proj", guildId: GUILD, title: "作業", categoryId: "c", model: "claude-haiku-4-5" });
  stores.topicSessions.setProject("proj", "alpha", "default");
  const runner = new FakeRunner([ok("a"), ok("b"), ok("c"), ok("d"), ok("e")]);
  const projectRunner = new FakeRunner([ok("p")]);
  const deps = { ...stores, runner, projectRunner, log: () => undefined };
  const turn = { guildId: GUILD, kind: "session" as const, prompt: "やって", allowedUrls: [] };

  await runChannelTurn(deps, { ...turn, channelId: CHANNEL });
  assert.equal(runner.inputs[0]!.context?.model, "claude-sonnet-5-5");
  await runChannelTurn(deps, { ...turn, channelId: "proj" });
  assert.equal(projectRunner.inputs[0]!.context?.model, "claude-haiku-4-5");
  assert.equal(projectRunner.inputs[0]!.context?.projectDir, "alpha");
  // NULL の話題はキーごと入れない（context の形は今までどおり）
  await runChannelTurn(deps, { ...turn, channelId: "plain" });
  assert.deepEqual(runner.inputs[1]!.context, { guildId: GUILD, channelId: "plain", kind: "session" });
  // 予約した依頼は入れない
  await runChannelTurn(deps, { ...turn, channelId: CHANNEL, scheduled: true });
  assert.equal("model" in runner.inputs[2]!.context!, false);
  // #inbox・#tasks は入れない（同じ channelId に話題の行があっても）
  await runChannelTurn(deps, { ...turn, channelId: CHANNEL, kind: "inbox" });
  await runChannelTurn(deps, { ...turn, channelId: CHANNEL, kind: "tasks" });
  assert.equal("model" in runner.inputs[3]!.context!, false);
  assert.equal("model" in runner.inputs[4]!.context!, false);
});

test("/renew: プロジェクトのセッションの要約のターンは context に話題のモデル。軽いモードは今までどおり context なし", async (t) => {
  const stores = createStores(tempDb(t), () => NOW);
  stores.topicSessions.create({ channelId: CHANNEL, guildId: GUILD, title: "作業", categoryId: "c", model: "claude-haiku-4-5" });
  stores.topicSessions.setProject(CHANNEL, "alpha", "default");
  stores.topicSessions.create({ channelId: "light", guildId: GUILD, title: "軽い", categoryId: "c", model: "claude-haiku-4-5" });
  stores.sessions.set(CHANNEL, "project-session");
  stores.sessions.set("light", "light-session");
  const runner = new FakeRunner([ok("x")]);
  const projectRunner = new FakeRunner([ok("y")]);
  const deps = {
    topicSessions: stores.topicSessions,
    turnQueue: new KeyedSerialQueue(2),
    turn: { runner, projectRunner, sessions: stores.sessions, seeds: stores.seeds, usage: stores.usage, log: () => undefined },
    log: () => undefined,
  };
  assert.equal((await renewSession(deps, GUILD, CHANNEL)).result, "renewed");
  assert.equal(projectRunner.inputs[0]!.context?.model, "claude-haiku-4-5");
  assert.equal((await renewSession(deps, GUILD, "light")).result, "renewed");
  assert.equal(runner.inputs[0]!.context, undefined);
});

const RUNNER_CFG = {
  model: "claude-opus-5",
  workDir: "/srv/work",
  claudeConfigDir: "/srv/claude",
  turnTimeoutSec: 300,
  effort: undefined,
  sessionMaxTurns: 40,
  sessionTurnTimeoutSec: 900,
};

function mcpServer() {
  return createSdkMcpServer({ name: "selfagent", version: "0.1.0", tools: [] });
}

/** 成功を 1 つ返す query で runner を作り、渡した Options を記録する */
function lightRunner(model = RUNNER_CFG.model) {
  const calls: Array<Parameters<QueryFn>[0]> = [];
  const runner = new SdkAgentRunner(
    { ...RUNNER_CFG, model },
    () => mcpServer(),
    { projects: { getByChannel: () => undefined, touch: () => {} }, projectsDir: "/srv/work/projects", disk: { check: () => ({ allowed: true }) } },
    () => {},
    (call) => {
      calls.push(call);
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "はい", session_id: "s-1", duration_ms: 1 } as unknown as SDKMessage;
      })();
    },
  );
  return { runner, calls };
}

const sessionContext = (extra: Partial<RunContext> = {}): RunContext => ({ guildId: GUILD, channelId: CHANNEL, kind: "session", ...extra });

test("SdkAgentRunner: context に model が無ければ Options は buildQueryOptions(cfg) と同じ（キーの順も）。あれば model だけがその値。結果に渡したモデル", async () => {
  const none = lightRunner();
  const plain = await none.runner.run({ prompt: "x", context: sessionContext() });
  const { mcpServers: _a, maxTurns: _b, abortController: _c, hooks: _d, stderr: _e, ...rest } = none.calls[0]!.options;
  const { mcpServers: _f, ...expected } = buildQueryOptions(RUNNER_CFG, mcpServer());
  assert.deepEqual(rest, expected);
  assert.deepEqual(Object.keys(rest), Object.keys(expected));
  assert.equal(JSON.stringify(rest.env), JSON.stringify(expected.env));
  assert.equal(plain.model, "claude-opus-5");

  const chosen = lightRunner();
  const picked = await chosen.runner.run({ prompt: "x", context: sessionContext({ model: "claude-sonnet-5-5" }) });
  const { mcpServers: _g, maxTurns: _h, abortController: _i, hooks: _j, stderr: _k, ...withModel } = chosen.calls[0]!.options;
  assert.equal(withModel.model, "claude-sonnet-5-5");
  assert.deepEqual(Object.keys(withModel), Object.keys(expected));
  assert.deepEqual({ ...withModel, model: expected.model }, expected);
  assert.equal(picked.model, "claude-sonnet-5-5");
});

test("SdkAgentRunner: 人格の runner（設定のモデルが人格のもの）は context に model が無ければ人格のモデル、あればその値", async () => {
  const persona = lightRunner("claude-sonnet-5");
  await persona.runner.run({ prompt: "x", context: sessionContext() });
  await persona.runner.run({ prompt: "x", context: sessionContext({ model: "claude-haiku-4-5" }) });
  await persona.runner.run({ prompt: "x" });
  assert.deepEqual(
    persona.calls.map((call) => call.options.model),
    ["claude-sonnet-5", "claude-haiku-4-5", "claude-sonnet-5"],
  );
});

function projectPlaces(t: TestContext) {
  const root = realpathSync(tempDir(t));
  const workspaceDir = join(root, "workspace");
  mkdirSync(join(workspaceDir, "alpha"), { recursive: true });
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const cfg = {
    model: "claude-opus-5",
    effort: "high" as const,
    workDir: join(root, "work"),
    dataDir: join(root, "data"),
    claudeConfigDir: join(root, "claude"),
    workspaceDir,
    sessionMaxTurns: 40,
  };
  return { home, cfg };
}

test("createProjectProfile: context に model が無ければ Options は今までどおり cfg.model（キーの順も同じ）。あれば model だけがその値", (t) => {
  const { home, cfg } = projectPlaces(t);
  const server = mcpServer();
  const canUse: CanUseTool = async () => ({ behavior: "allow" });
  const profile = createProjectProfile({
    cfg,
    createMcpServer: () => server,
    canUseTool: () => canUse,
    home,
    env: { PATH: "/usr/bin", HOME: home },
    log: () => {},
  });
  const run = { sessionId: () => undefined, signal: new AbortController().signal };
  const context = sessionContext({ projectDir: "alpha", permissionMode: "default" });
  const plain = profile.buildOptions({ prompt: "x", context }, run);
  const picked = profile.buildOptions({ prompt: "x", context: { ...context, model: "claude-sonnet-5-5" } }, run);
  assert.equal(plain.model, "claude-opus-5");
  assert.equal(Object.keys(plain)[0], "model");
  assert.equal(picked.model, "claude-sonnet-5-5");
  assert.deepEqual(Object.keys(picked), Object.keys(plain));
  assert.deepEqual({ ...picked, model: plain.model }, plain);
});
